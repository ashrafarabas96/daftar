/**
 * TL-P4-PERF-A-02 — DIAGNOSTIC INSTRUMENTATION. NOT A GATE, NOT EVIDENCE.
 *
 * ── WHAT THIS FILE IS ──────────────────────────────────────────────────
 *
 * The instrument side of a diagnostic campaign ordered to IDENTIFY THE CAUSE
 * of a tail, and nothing else. It asserts nothing, it has no budget, no
 * ceiling, no percentile and no verdict. Per the ruling: "This diagnostic
 * campaign has NO PASS/FAIL VERDICT. It exists only to identify the tail. It
 * must not be used as acceptance evidence regardless of its number."
 *
 * Nothing here is imported by the product, by any accepted suite, or by any
 * gate. It is a leaf: `tests/performance/p4perf-diagnostic-campaign.test.ts`
 * is its only consumer. Deleting both files removes the campaign entirely and
 * changes no accepted behaviour.
 *
 * ── THE ONE RULE THAT SHAPES EVERY DECISION BELOW ──────────────────────
 *
 * NO HEAVY TELEMETRY INSIDE THE TIMED SECTION. The timed region must stay
 * semantically identical to the accepted benchmark's, or the campaign measures
 * its own instrumentation instead of the product. So:
 *
 *   - every counter here is sampled BETWEEN operations — once before sample n
 *     and once after sample n — and the delta is attributed to sample n;
 *   - the PostgreSQL counters are read on a SEPARATE OBSERVER CONNECTION, as
 *     the cluster superuser, never on the connection being measured, so the
 *     measured session's plan cache, snapshot and transaction state are
 *     untouched;
 *   - anything that genuinely requires telemetry inside the timed region
 *     (`track_io_timing`, a concurrent wait-event sampler) runs as a SEPARATE,
 *     LABELLED pass, and its series is never mixed with the clean one.
 *
 * ── THE ATTRIBUTION AMBIGUITY, DECLARED RATHER THAN HIDDEN ─────────────
 *
 * A between-samples delta covers the operation AND the gap around it. If a
 * checkpoint writes during the gap between sample 47 and sample 48, the delta
 * attributed to sample 48 contains work that did not slow sample 48 down. This
 * is unavoidable for any counter not sampled inside the timed region, and it
 * is the reason every snapshot records its own monotonic timestamp: `gapMs`
 * (the time spent outside the timed region) is reported beside `durationMs`,
 * so a reader can bound how much of a delta could have landed outside the
 * operation. A correlation over 20 or 200 samples is not invalidated by this;
 * a claim about one single sample is, and must say so.
 *
 * ── WHAT WAS CHECKED RATHER THAN ASSUMED ───────────────────────────────
 *
 * The server's catalogue is PROBED at run time (`probeServer`), not assumed
 * from a version number, because this estate runs two different PostgreSQL
 * majors and they do not agree about where WAL timing lives:
 *
 *   - the container's own PostgreSQL is 16.13;
 *   - the suites do not use it. `embedded-postgres` bundles its own binaries
 *     and those are PostgreSQL 18.4, which is what every measurement here is
 *     actually taken against;
 *   - in PostgreSQL 18 `pg_stat_wal` NO LONGER HAS `wal_write`, `wal_sync`,
 *     `wal_write_time` or `wal_sync_time`. They were removed and superseded by
 *     `pg_stat_io` rows with `object = 'wal'`. A harness written from a
 *     PostgreSQL 16 memory would either error out or silently lose all WAL
 *     fsync coverage — which is exactly the Class C instrument.
 *
 * So every field is capability-gated: `probeServer` asks the catalogue what
 * exists, `pgCounterSql` builds a statement out of only what does, and the
 * campaign records which instruments were available. A missing instrument is
 * reported as missing, never quietly conflated with a zero.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { loadavg } from 'node:os';
import { monitorEventLoopDelay, PerformanceObserver, performance, type IntervalHistogram } from 'node:perf_hooks';
import type { Pool } from 'pg';

/* ══════════════════════════════════════════════════════════════════════
 * 0 — CHEAP /proc READING
 * ════════════════════════════════════════════════════════════════════ */

/**
 * A procfs file held open and re-read from offset 0 into one reused buffer.
 *
 * `readFileSync` would open, stat, allocate and close on every sample. These
 * reads happen 2× per sample across six or seven files, so the allocation
 * alone would show up as GC pressure in the very Class F signal this harness
 * is trying to measure. Holding the descriptor and reusing one buffer makes a
 * snapshot a handful of `pread` syscalls and no heap traffic.
 *
 * Procfs regenerates its contents on each read from offset 0, so re-reading
 * one descriptor is the documented way to poll it.
 */
class ProcFile {
  private fd: number | null;
  private readonly buf: Buffer;

  constructor(
    readonly path: string,
    size = 8192,
  ) {
    this.buf = Buffer.allocUnsafe(size);
    try {
      this.fd = openSync(path, 'r');
    } catch {
      this.fd = null; // absent on this kernel/container: reported as unavailable
    }
  }

  get available(): boolean {
    return this.fd !== null;
  }

  read(): string | null {
    if (this.fd === null) return null;
    try {
      const n = readSync(this.fd, this.buf, 0, this.buf.length, 0);
      return this.buf.toString('utf8', 0, n);
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* closing a procfs fd cannot fail in a way that matters here */
      }
      this.fd = null;
    }
  }
}

/** `some total=N` / `full total=N` out of a PSI file, in microseconds. */
function psiTotals(text: string | null): { some: number; full: number } {
  if (text === null) return { some: -1, full: -1 };
  const grab = (kind: string): number => {
    const m = new RegExp(`^${kind} .*total=(\\d+)`, 'm').exec(text);
    return m?.[1] === undefined ? -1 : Number(m[1]);
  };
  return { some: grab('some'), full: grab('full') };
}

/** The `utime + stime` of a pid, in clock ticks, from `/proc/<pid>/stat`. */
function cpuTicksOf(text: string | null): number {
  if (text === null) return -1;
  // The comm field may contain spaces and parentheses, so fields are counted
  // from after the LAST ')': utime is field 14 and stime field 15 overall,
  // which is index 11 and 12 of the remainder.
  const close = text.lastIndexOf(')');
  if (close < 0) return -1;
  const f = text.slice(close + 2).split(' ');
  const u = f[11];
  const s = f[12];
  if (u === undefined || s === undefined) return -1;
  return Number(u) + Number(s);
}

/* ══════════════════════════════════════════════════════════════════════
 * 1 — HOST SNAPSHOT (classes G, H, I)
 * ════════════════════════════════════════════════════════════════════ */

export interface HostSnap {
  /** `process.hrtime.bigint()` at the moment of the snapshot, in ms. */
  readonly tMono: number;
  /** `/proc/stat` aggregate: user nice system idle iowait irq softirq steal guest guest_nice, in jiffies. */
  readonly cpu: readonly number[];
  readonly psiCpu: { readonly some: number; readonly full: number };
  readonly psiIo: { readonly some: number; readonly full: number };
  readonly psiMem: { readonly some: number; readonly full: number };
  readonly loadavg: readonly number[];
  /** `/proc/loadavg` field 4, `runnable/total`. */
  readonly runnable: number;
  readonly procsTotal: number;
  readonly vm: { readonly pgfault: number; readonly pgmajfault: number; readonly pswpin: number; readonly pswpout: number };
  /** cgroup v1 CPU throttling. `null` when the controller is absent. */
  readonly cgroup: { readonly nrPeriods: number; readonly nrThrottled: number; readonly throttledTimeNs: number } | null;
  /** This Node process's own CPU, in jiffies, from `/proc/self/stat`. */
  readonly selfCpuTicks: number;
  /** The measured PostgreSQL backend's CPU, in jiffies. `-1` when not watched. */
  readonly pgBackendCpuTicks: number;
}

/**
 * HOW THIS SEPARATES G FROM H FROM I — the declaration the ruling asks for.
 *
 * G (host CPU scheduling) and H (host I/O contention) are the pair most often
 * conflated, so they get two independent instruments each:
 *
 *   G: `psiCpu.some` — nanoseconds in which at least one task was runnable but
 *      waiting for a CPU. This is the kernel's own definition of "something
 *      wanted CPU and did not get it" and it is the cleanest G signal
 *      available. Corroborated by `cpu[7]` (steal, the hypervisor taking the
 *      vCPU away), `runnable` (run-queue depth) and
 *      `involuntaryContextSwitches` from the Node snapshot.
 *   H: `psiIo.some` / `psiIo.full` — time stalled on I/O, plus `cpu[4]`
 *      (iowait) and the disk queue from `/proc/diskstats`.
 *   I (unrelated container activity): `othersCpuTicks`, computed in
 *      `attributeCpu` as the system-wide busy delta MINUS this Node process
 *      MINUS the measured PostgreSQL backend. A positive residue during a slow
 *      sample means a THIRD party burned CPU while the operation ran, which is
 *      what distinguishes I from G: G says "I waited for a CPU", I says "and
 *      here is who took it".
 *
 * WHAT THIS CANNOT DO, STATED PLAINLY. `/proc/self/schedstat` field 2 is the
 * run-queue wait time of this process specifically, which would attribute G
 * directly to the measuring process rather than to the host as a whole. It is
 * UNUSABLE here: `/proc/sys/kernel/sched_schedstats` does not exist on this
 * kernel, so the counter is never accumulated and reads a constant 0. PSI is
 * host-wide, not per-process, so G is established for the BOX during a sample
 * and not for the measuring thread. See the campaign's `gaps` report.
 */
export class HostSampler {
  private readonly stat = new ProcFile('/proc/stat', 65536);
  private readonly loadavgF = new ProcFile('/proc/loadavg', 256);
  private readonly vmstat = new ProcFile('/proc/vmstat', 32768);
  private readonly psiCpuF = new ProcFile('/proc/pressure/cpu', 512);
  private readonly psiIoF = new ProcFile('/proc/pressure/io', 512);
  private readonly psiMemF = new ProcFile('/proc/pressure/memory', 512);
  private readonly cgStat = new ProcFile('/sys/fs/cgroup/cpu/cpu.stat', 1024);
  private readonly selfStat = new ProcFile('/proc/self/stat', 4096);
  private pgStat: ProcFile | null = null;

  /** Watch a PostgreSQL backend's own CPU, so class I can subtract it. */
  watchBackend(pid: number): void {
    this.pgStat?.close();
    this.pgStat = new ProcFile(`/proc/${pid}/stat`, 4096);
  }

  availability(): Record<string, boolean> {
    return {
      '/proc/stat': this.stat.available,
      '/proc/loadavg': this.loadavgF.available,
      '/proc/vmstat': this.vmstat.available,
      '/proc/pressure/cpu': this.psiCpuF.available,
      '/proc/pressure/io': this.psiIoF.available,
      '/proc/pressure/memory': this.psiMemF.available,
      '/sys/fs/cgroup/cpu/cpu.stat': this.cgStat.available,
      '/proc/self/stat': this.selfStat.available,
      '/proc/<pg-backend>/stat': this.pgStat?.available ?? false,
    };
  }

  snap(): HostSnap {
    const tMono = Number(process.hrtime.bigint()) / 1e6;

    const statText = this.stat.read();
    const cpu: number[] = [];
    if (statText !== null) {
      const line = statText.slice(0, statText.indexOf('\n'));
      for (const part of line.split(/\s+/).slice(1)) if (part !== '') cpu.push(Number(part));
    }

    const la = this.loadavgF.read();
    let runnable = -1;
    let procsTotal = -1;
    if (la !== null) {
      const f = la.trim().split(/\s+/);
      const rt = (f[3] ?? '').split('/');
      runnable = Number(rt[0] ?? -1);
      procsTotal = Number(rt[1] ?? -1);
    }

    const vmText = this.vmstat.read();
    const vmGet = (key: string): number => {
      if (vmText === null) return -1;
      const m = new RegExp(`^${key} (\\d+)`, 'm').exec(vmText);
      return m?.[1] === undefined ? -1 : Number(m[1]);
    };

    const cgText = this.cgStat.read();
    const cgGet = (key: string): number => {
      if (cgText === null) return -1;
      const m = new RegExp(`^${key} (\\d+)`, 'm').exec(cgText);
      return m?.[1] === undefined ? -1 : Number(m[1]);
    };

    return {
      tMono,
      cpu,
      psiCpu: psiTotals(this.psiCpuF.read()),
      psiIo: psiTotals(this.psiIoF.read()),
      psiMem: psiTotals(this.psiMemF.read()),
      loadavg: loadavg(),
      runnable,
      procsTotal,
      vm: { pgfault: vmGet('pgfault'), pgmajfault: vmGet('pgmajfault'), pswpin: vmGet('pswpin'), pswpout: vmGet('pswpout') },
      cgroup:
        cgText === null
          ? null
          : { nrPeriods: cgGet('nr_periods'), nrThrottled: cgGet('nr_throttled'), throttledTimeNs: cgGet('throttled_time') },
      selfCpuTicks: cpuTicksOf(this.selfStat.read()),
      pgBackendCpuTicks: this.pgStat === null ? -1 : cpuTicksOf(this.pgStat.read()),
    };
  }

  close(): void {
    for (const f of [this.stat, this.loadavgF, this.vmstat, this.psiCpuF, this.psiIoF, this.psiMemF, this.cgStat, this.selfStat]) f.close();
    this.pgStat?.close();
  }
}

/** Jiffies the host spent busy, split into "mine", "postgres's" and "someone else's" (class I). */
export function attributeCpu(a: HostSnap, b: HostSnap): { busy: number; idle: number; iowait: number; steal: number; mine: number; pg: number; others: number } {
  const d = (i: number): number => {
    const x = a.cpu[i];
    const y = b.cpu[i];
    return x === undefined || y === undefined ? 0 : y - x;
  };
  const idle = d(3);
  const iowait = d(4);
  const total = a.cpu.reduce((s, _v, i) => s + d(i), 0);
  const busy = total - idle - iowait;
  const mine = a.selfCpuTicks < 0 || b.selfCpuTicks < 0 ? -1 : b.selfCpuTicks - a.selfCpuTicks;
  const pg = a.pgBackendCpuTicks < 0 || b.pgBackendCpuTicks < 0 ? -1 : b.pgBackendCpuTicks - a.pgBackendCpuTicks;
  return { busy, idle, iowait, steal: d(7), mine, pg, others: mine < 0 || pg < 0 ? -1 : busy - mine - pg };
}

/* ══════════════════════════════════════════════════════════════════════
 * 2 — NODE / V8 SNAPSHOT (class F)
 * ════════════════════════════════════════════════════════════════════ */

export interface GcEvent {
  /** `performance.now()` of the pause's start. */
  readonly startTime: number;
  readonly duration: number;
  readonly kind: number;
  readonly flags: number;
}

export interface NodeSnap {
  readonly tMono: number;
  /** `performance.now()`, so GC entries can be placed in a sample's window. */
  readonly tPerf: number;
  readonly cpuUserUs: number;
  readonly cpuSystemUs: number;
  readonly majorPageFault: number;
  readonly minorPageFault: number;
  readonly involuntaryContextSwitches: number;
  readonly voluntaryContextSwitches: number;
  readonly fsRead: number;
  readonly fsWrite: number;
  readonly heapUsed: number;
  readonly rss: number;
  readonly external: number;
}

/**
 * Class F — Node/V8 pauses, with the three distinct mechanisms kept apart.
 *
 * A "Node pause" is three different things and collapsing them loses the
 * diagnosis, so each gets its own instrument:
 *
 *   GC: a `PerformanceObserver` on the `gc` entry type. Entries carry a
 *       `startTime` and a `duration`, so a pause is ATTRIBUTED BY TIME WINDOW
 *       to the sample it overlapped rather than guessed at from a counter
 *       delta. `takeRecords()` is drained between samples — synchronously, so
 *       no observer callback can run as a microtask inside a timed region.
 *   EVENT LOOP: `monitorEventLoopDelay`, a libuv-side histogram that costs
 *       nothing on the JS side. Reset between samples, so `max` is the worst
 *       loop delay DURING that one sample and not a running maximum.
 *   OFF-CPU: `cpuUserUs + cpuSystemUs` against the wall duration. A sample
 *       whose wall time greatly exceeds its own CPU time was NOT RUNNING — the
 *       process was descheduled or blocked, which points away from F and
 *       toward G, H or I. This is the single most useful cross-class
 *       discriminator in the harness and it costs one `getrusage`.
 *
 * `involuntaryContextSwitches` is listed under F's snapshot but is a G signal:
 * it counts preemptions of this process, which is the per-process complement
 * to host-wide PSI.
 */
export class NodeSampler {
  private readonly elu: IntervalHistogram;
  private readonly gcObserver: PerformanceObserver;
  private started = false;

  constructor() {
    this.elu = monitorEventLoopDelay({ resolution: 1 });
    // No callback work: entries are drained synchronously with takeRecords(),
    // so nothing of this observer's runs as a microtask during a timed region.
    this.gcObserver = new PerformanceObserver(() => undefined);
  }

  start(): void {
    if (this.started) return;
    this.elu.enable();
    this.gcObserver.observe({ entryTypes: ['gc'], buffered: false });
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.elu.disable();
    this.gcObserver.disconnect();
    this.started = false;
  }

  /** Drop everything accumulated so far: called immediately before a timed region. */
  resetWindow(): void {
    this.elu.reset();
    this.gcObserver.takeRecords();
  }

  /** The event-loop delay histogram for the window since `resetWindow`, in ms. */
  loopDelay(): { max: number; mean: number; p99: number } {
    return {
      max: this.elu.max / 1e6,
      mean: Number.isFinite(this.elu.mean) ? this.elu.mean / 1e6 : -1,
      p99: this.elu.percentile(99) / 1e6,
    };
  }

  /** GC pauses recorded since `resetWindow`. */
  gc(): GcEvent[] {
    return this.gcObserver.takeRecords().map((e) => {
      const detail = (e as unknown as { detail?: { kind?: number; flags?: number } }).detail;
      return { startTime: e.startTime, duration: e.duration, kind: detail?.kind ?? -1, flags: detail?.flags ?? -1 };
    });
  }

  snap(): NodeSnap {
    const cpu = process.cpuUsage();
    const ru = process.resourceUsage();
    const mem = process.memoryUsage();
    return {
      tMono: Number(process.hrtime.bigint()) / 1e6,
      tPerf: performance.now(),
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
      majorPageFault: ru.majorPageFault,
      minorPageFault: ru.minorPageFault,
      involuntaryContextSwitches: ru.involuntaryContextSwitches,
      voluntaryContextSwitches: ru.voluntaryContextSwitches,
      fsRead: ru.fsRead,
      fsWrite: ru.fsWrite,
      heapUsed: mem.heapUsed,
      rss: mem.rss,
      external: mem.external,
    };
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 3 — THE SERVER PROBE (what instruments actually exist)
 * ════════════════════════════════════════════════════════════════════ */

export interface ServerCapabilities {
  readonly version: string;
  readonly versionNum: number;
  /** Which `pg_stat_*` relations the catalogue actually holds. */
  readonly views: Readonly<Record<string, boolean>>;
  /** Which per-backend stat functions exist (PostgreSQL 18 only). */
  readonly functions: Readonly<Record<string, boolean>>;
  /** `pg_stat_wal` lost its write/sync columns in PostgreSQL 18. */
  readonly walViewColumns: readonly string[];
  readonly ioViewColumns: readonly string[];
}

export interface ServerEnvironment {
  readonly capabilities: ServerCapabilities;
  /** Every setting the ruling names, plus the ones that govern the instruments. */
  readonly settings: Readonly<Record<string, string>>;
  readonly collation: {
    readonly datcollate: string;
    readonly datctype: string;
    readonly datlocprovider: string;
    readonly serverEncoding: string;
    readonly lcCollateGuc: string;
  };
  readonly dataDirectory: string | null;
}

const WANTED_VIEWS = [
  'pg_stat_checkpointer',
  'pg_stat_bgwriter',
  'pg_stat_wal',
  'pg_stat_io',
  'pg_stat_database',
  'pg_stat_all_tables',
  'pg_stat_activity',
  'pg_stat_progress_vacuum',
  'pg_stat_progress_analyze',
  'pg_statio_all_tables',
  'pg_stat_slru',
  'pg_locks',
] as const;

const WANTED_FUNCTIONS = ['pg_stat_get_backend_io', 'pg_stat_get_backend_wal', 'pg_stat_clear_snapshot', 'pg_current_wal_lsn'] as const;

/**
 * THE SETTINGS THE RULING NAMES, plus the ones that decide what is measurable.
 *
 * The first block is the ruling's own list. The second exists because the
 * embedded cluster is started with NO custom `postgresql.conf` — every value
 * is a PostgreSQL default — and two of those defaults silently disable
 * instruments: `track_io_timing` and `track_wal_io_timing` are `off`, so every
 * `*_time` column in `pg_stat_io` reads a constant zero. That is why the
 * campaign has a separate, labelled `io-timed` pass rather than a single
 * series: turning those on puts a clock around each I/O INSIDE the timed
 * region, which is precisely the contamination the ruling forbids mixing with
 * the clean series.
 */
const WANTED_SETTINGS = [
  // The ruling's list.
  'shared_buffers',
  'wal_buffers',
  'checkpoint_timeout',
  'max_wal_size',
  'fsync',
  'synchronous_commit',
  'full_page_writes',
  'wal_compression',
  // What governs the instruments and the tail.
  'track_io_timing',
  'track_wal_io_timing',
  'track_counts',
  'track_activities',
  'stats_fetch_consistency',
  'checkpoint_completion_target',
  'min_wal_size',
  'bgwriter_delay',
  'bgwriter_lru_maxpages',
  'wal_writer_delay',
  'wal_level',
  'wal_sync_method',
  'commit_delay',
  'commit_siblings',
  'autovacuum',
  'autovacuum_naptime',
  'autovacuum_vacuum_scale_factor',
  'autovacuum_analyze_scale_factor',
  'autovacuum_vacuum_cost_delay',
  'work_mem',
  'maintenance_work_mem',
  'effective_cache_size',
  'random_page_cost',
  'seq_page_cost',
  'jit',
  'jit_above_cost',
  'plan_cache_mode',
  'max_parallel_workers_per_gather',
  'effective_io_concurrency',
  'huge_pages',
  'data_checksums',
  'lc_collate',
  'server_version_num',
] as const;

export async function probeServer(pool: Pool): Promise<ServerEnvironment> {
  const { rows: v } = await pool.query<{ version: string; num: string }>(
    `SELECT version() AS version, current_setting('server_version_num') AS num`,
  );
  const version = v[0]?.version ?? 'unknown';
  const versionNum = Number(v[0]?.num ?? 0);

  const { rows: relRows } = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'pg_catalog' AND c.relname = ANY($1::text[])`,
    [[...WANTED_VIEWS]],
  );
  const present = new Set(relRows.map((r) => r.relname));
  const views: Record<string, boolean> = {};
  for (const name of WANTED_VIEWS) views[name] = present.has(name);

  const { rows: fnRows } = await pool.query<{ proname: string }>(`SELECT DISTINCT proname FROM pg_proc WHERE proname = ANY($1::text[])`, [
    [...WANTED_FUNCTIONS],
  ]);
  const fnPresent = new Set(fnRows.map((r) => r.proname));
  const functions: Record<string, boolean> = {};
  for (const name of WANTED_FUNCTIONS) functions[name] = fnPresent.has(name);

  const columnsOf = async (rel: string): Promise<string[]> => {
    if (views[rel] !== true) return [];
    const { rows } = await pool.query<{ attname: string }>(
      `SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pg_catalog' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [rel],
    );
    return rows.map((r) => r.attname);
  };

  const { rows: setRows } = await pool.query<{ name: string; setting: string; unit: string | null }>(
    `SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1::text[]) ORDER BY name`,
    [[...WANTED_SETTINGS]],
  );
  const settings: Record<string, string> = {};
  for (const r of setRows) settings[r.name] = r.unit === null ? r.setting : `${r.setting} ${r.unit}`;

  // `pg_database` IS THE AUTHORITATIVE SOURCE, AND THE ONLY PORTABLE ONE.
  //
  // `current_setting('lc_collate')` was the obvious way to read this and it is
  // WRONG on the server actually under test: PostgreSQL 18 removed `lc_collate`
  // and `lc_ctype` as GUCs, so the call raises
  // `unrecognized configuration parameter "lc_collate"` and takes the whole
  // campaign down with it. The database row carries the same facts on every
  // version, plus `datlocprovider`, which the GUC never exposed.
  //
  // This matters beyond a crash: the local cluster is locale `C` while CI's is
  // `en_US.utf8`, and a plan claim measured under one collation can be about a
  // collation the other lacks. The campaign therefore records the collation it
  // measured under rather than leaving a reader to assume.
  const { rows: col } = await pool.query<{
    datcollate: string;
    datctype: string;
    datlocprovider: string;
    enc: string;
  }>(
    `SELECT d.datcollate, d.datctype, d.datlocprovider::text AS datlocprovider,
            pg_encoding_to_char(d.encoding) AS enc
       FROM pg_database d WHERE d.datname = current_database()`,
  );

  const dataDirectory = await pool
    .query<{ d: string }>(`SELECT current_setting('data_directory') AS d`)
    .then((r) => r.rows[0]?.d ?? null)
    .catch(() => null);

  return {
    capabilities: {
      version,
      versionNum,
      views,
      functions,
      walViewColumns: await columnsOf('pg_stat_wal'),
      ioViewColumns: await columnsOf('pg_stat_io'),
    },
    settings,
    collation: {
      datcollate: col[0]?.datcollate ?? 'unknown',
      datctype: col[0]?.datctype ?? 'unknown',
      datlocprovider: col[0]?.datlocprovider ?? 'unknown',
      serverEncoding: col[0]?.enc ?? 'unknown',
      lcCollateGuc: 'n/a — removed as a GUC in PostgreSQL 18; see datcollate',
    },
    dataDirectory,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 4 — THE POSTGRESQL COUNTER SNAPSHOT (classes B, C, D, E)
 * ════════════════════════════════════════════════════════════════════ */

export type PgSnap = Readonly<Record<string, unknown>> & { readonly tMono: number };

/**
 * ONE STATEMENT, ONE ROUND TRIP, ON THE OBSERVER CONNECTION.
 *
 * Between two samples there is time for exactly one cheap thing. Issuing six
 * queries would cost six round trips and six snapshots of the statistics
 * subsystem, so every counter the campaign wants is composed into a single
 * `jsonb` object built from whichever sub-selects the catalogue supports.
 *
 * WHY THE OBSERVER IS A SEPARATE SUPERUSER CONNECTION. Reading these views on
 * the measured connection would (a) run statements on the session whose plan
 * cache and snapshot are part of the subject, and (b) be refused for other
 * backends' rows, since `pg_stat_get_backend_io` needs `pg_read_all_stats`.
 * The observer is `ownerPool()`, which is the cluster superuser.
 *
 * WHY `stats_fetch_consistency = none` IS SET ON THE OBSERVER. The default,
 * `cache`, builds and memoizes a statistics snapshot for the duration of a
 * transaction, so a polling reader can see stale numbers and pays to
 * materialize a snapshot each time. `none` reads straight from shared memory:
 * freshest and cheapest, which is what a per-sample poll needs. It is set with
 * `SET` on the observer session only and changes nothing about the measured
 * session or the cluster.
 */
export function pgCounterSql(caps: ServerCapabilities): string {
  const parts: string[] = [];
  const has = (v: string): boolean => caps.views[v] === true;
  const hasFn = (f: string): boolean => caps.functions[f] === true;

  if (has('pg_stat_checkpointer')) {
    // Class B and C: the checkpointer's own work and the time it spent in
    // write() and fsync(). PostgreSQL 17 moved these out of pg_stat_bgwriter.
    parts.push(`'checkpointer', (SELECT to_jsonb(c) FROM pg_stat_checkpointer c)`);
  } else if (has('pg_stat_bgwriter')) {
    // PostgreSQL 16 and earlier keep the checkpoint counters here.
    parts.push(`'bgwriter_checkpoints', (SELECT to_jsonb(b) FROM pg_stat_bgwriter b)`);
  }
  if (has('pg_stat_bgwriter')) parts.push(`'bgwriter', (SELECT to_jsonb(b) FROM pg_stat_bgwriter b)`);

  if (has('pg_stat_wal')) {
    // Class C. On 18 this is records/fpi/bytes/buffers_full ONLY — the write
    // and sync counters live in pg_stat_io now, which is why both are read.
    parts.push(`'wal', (SELECT to_jsonb(w) FROM pg_stat_wal w)`);
  }

  if (has('pg_stat_io')) {
    // Class C and H, cluster-wide, grouped by object so WAL fsyncs are
    // separable from relation reads. The *_time columns are zero unless
    // track_io_timing is on, which only the io-timed pass turns on.
    parts.push(`'io', (
      SELECT jsonb_object_agg(k, v) FROM (
        SELECT object || '/' || context AS k,
               jsonb_build_object('reads', sum(reads), 'hits', sum(hits), 'writes', sum(writes), 'writebacks', sum(writebacks),
                                  'extends', sum(extends), 'fsyncs', sum(fsyncs), 'evictions', sum(evictions), 'reuses', sum(reuses),
                                  'read_time', sum(read_time), 'write_time', sum(write_time), 'fsync_time', sum(fsync_time),
                                  'writeback_time', sum(writeback_time), 'extend_time', sum(extend_time)) AS v
          FROM pg_stat_io GROUP BY object, context
      ) q)`);
  }

  if (hasFn('pg_stat_get_backend_io')) {
    // Class A, C and E, ATTRIBUTED TO THE MEASURED BACKEND rather than to the
    // cluster. This is the strongest instrument in the harness: cluster-wide
    // counters cannot tell "my operation did I/O" from "something else did",
    // and that distinction is the whole P-versus-R question.
    parts.push(`'backendIo', (
      SELECT jsonb_object_agg(k, v) FROM (
        SELECT object || '/' || context AS k,
               jsonb_build_object('reads', sum(reads), 'hits', sum(hits), 'writes', sum(writes), 'extends', sum(extends),
                                  'fsyncs', sum(fsyncs), 'evictions', sum(evictions), 'reuses', sum(reuses),
                                  'read_time', sum(read_time), 'write_time', sum(write_time), 'fsync_time', sum(fsync_time)) AS v
          FROM pg_stat_get_backend_io($1::int) GROUP BY object, context
      ) q)`);
  }
  if (hasFn('pg_stat_get_backend_wal')) {
    parts.push(`'backendWal', (SELECT to_jsonb(w) FROM pg_stat_get_backend_wal($1::int) w)`);
  }
  if (hasFn('pg_current_wal_lsn')) {
    // How far WAL advanced: a direct measure of how much the operation wrote,
    // independent of the stats subsystem's reporting delay.
    parts.push(`'walLsn', pg_current_wal_lsn()::text`);
  }

  if (has('pg_stat_database')) {
    parts.push(`'db', (
      SELECT jsonb_build_object('xact_commit', d.xact_commit, 'xact_rollback', d.xact_rollback,
                                'blks_read', d.blks_read, 'blks_hit', d.blks_hit,
                                'blk_read_time', d.blk_read_time, 'blk_write_time', d.blk_write_time,
                                'tup_returned', d.tup_returned, 'tup_fetched', d.tup_fetched,
                                'temp_files', d.temp_files, 'temp_bytes', d.temp_bytes,
                                'deadlocks', d.deadlocks, 'conflicts', d.conflicts)
        FROM pg_stat_database d WHERE d.datname = current_database())`);
  }

  if (has('pg_stat_all_tables')) {
    // Classes D and E, over the relations this campaign reads. Autovacuum and
    // autoanalyze counts, dead tuples and rows modified since the last
    // analyze, so a tail that coincides with a vacuum is visible as such.
    parts.push(`'tables', (
      SELECT jsonb_object_agg(relname, jsonb_build_object(
               'seq_scan', seq_scan, 'seq_tup_read', seq_tup_read, 'idx_scan', coalesce(idx_scan, 0),
               'idx_tup_fetch', coalesce(idx_tup_fetch, 0), 'n_tup_ins', n_tup_ins, 'n_tup_upd', n_tup_upd,
               'n_live_tup', n_live_tup, 'n_dead_tup', n_dead_tup, 'n_mod_since_analyze', n_mod_since_analyze,
               'vacuum_count', vacuum_count, 'autovacuum_count', autovacuum_count,
               'analyze_count', analyze_count, 'autoanalyze_count', autoanalyze_count,
               'last_autovacuum', last_autovacuum, 'last_autoanalyze', last_autoanalyze, 'last_analyze', last_analyze))
        FROM pg_stat_all_tables WHERE relname = ANY($2::text[]))`);
  }

  if (has('pg_stat_activity')) {
    // Class D and G: autovacuum workers actually running, and how many other
    // backends are active at all, which is the in-database half of class I.
    parts.push(`'activity', (
      SELECT jsonb_build_object(
               'autovacuumWorkers', count(*) FILTER (WHERE backend_type = 'autovacuum worker'),
               'activeBackends', count(*) FILTER (WHERE state = 'active' AND pid <> pg_backend_pid()),
               'waitingBackends', count(*) FILTER (WHERE wait_event_type IS NOT NULL AND state = 'active'))
        FROM pg_stat_activity)`);
    // The measured backend's own state as seen from outside. Between samples
    // it should read `idle`; anything else says the previous operation had not
    // finished settling, which would corrupt the attribution.
    parts.push(`'measured', (
      SELECT jsonb_build_object('state', state, 'wait_event_type', wait_event_type, 'wait_event', wait_event,
                                'backend_xid', backend_xid::text, 'query_start', query_start)
        FROM pg_stat_activity WHERE pid = $1::int)`);
  }

  if (has('pg_stat_progress_vacuum')) parts.push(`'vacuumsRunning', (SELECT count(*) FROM pg_stat_progress_vacuum)`);
  if (has('pg_stat_progress_analyze')) parts.push(`'analyzesRunning', (SELECT count(*) FROM pg_stat_progress_analyze)`);
  if (has('pg_locks')) parts.push(`'locksUngranted', (SELECT count(*) FROM pg_locks WHERE NOT granted)`);

  return `SELECT jsonb_build_object(${parts.join(',\n      ')}) AS s`;
}

export class PgCounterSampler {
  private sql: string | null = null;

  private constructor(
    private readonly observer: Pool,
    readonly caps: ServerCapabilities,
    private readonly measuredPid: number,
    private readonly relations: readonly string[],
  ) {}

  /**
   * Build a sampler and PREPARE its statement by running it once.
   *
   * The first execution of any statement pays parse and plan. Paying that
   * before the campaign starts means the per-sample cost is steady from
   * sample 1, so the instrument does not itself produce a ramp that could be
   * mistaken for a cold-plan effect in the subject.
   */
  static async create(observer: Pool, caps: ServerCapabilities, measuredPid: number, relations: readonly string[]): Promise<PgCounterSampler> {
    const s = new PgCounterSampler(observer, caps, measuredPid, relations);
    s.sql = pgCounterSql(caps);
    await s.snap();
    await s.snap();
    return s;
  }

  /** The SQL this sampler runs, recorded in the campaign's environment block. */
  get statement(): string {
    return this.sql ?? '';
  }

  async snap(): Promise<PgSnap> {
    const t0 = Number(process.hrtime.bigint()) / 1e6;
    const { rows } = await this.observer.query<{ s: Record<string, unknown> }>(this.sql ?? '', [this.measuredPid, [...this.relations]]);
    return { ...(rows[0]?.s ?? {}), tMono: t0 };
  }
}

/** Set up an observer session for polling: freshest and cheapest stats reads. */
export async function prepareObserver(observer: Pool): Promise<string> {
  try {
    await observer.query(`SET stats_fetch_consistency = 'none'`);
    return 'none';
  } catch {
    // Older servers do not have it; `cache` is then the behaviour and is
    // recorded as such rather than assumed away.
    return 'unavailable';
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 5 — WAIT-EVENT SAMPLER (class A/B/C/D backend waits) — INSTRUMENTED PASS
 * ════════════════════════════════════════════════════════════════════ */

/**
 * WHY THIS IS A SEPARATE PASS AND NEVER MIXED WITH THE CLEAN SERIES.
 *
 * A backend's wait event is only meaningful WHILE the backend is executing.
 * Between samples the measured session is idle, so a between-samples poll of
 * `pg_stat_activity` says nothing about what the operation waited on. The only
 * way to learn that is to poll DURING the timed region, which means a second
 * connection issuing a query every couple of milliseconds on the same box that
 * is being measured — real CPU, real round trips, and a measurable perturbation
 * of the thing under observation.
 *
 * So this runs in its own labelled pass. The series it produces is a wait-event
 * profile, NOT a latency series, and the campaign never pools its durations
 * with the clean pass's. If the clean pass and this pass disagree about the
 * tail, that disagreement is itself evidence — it bounds how much of the tail
 * the instrument can create.
 */
export interface WaitObservation {
  readonly tPerf: number;
  readonly state: string | null;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
}

export class WaitEventSampler {
  private timer: NodeJS.Timeout | null = null;
  private readonly seen: WaitObservation[] = [];
  private inFlight = false;

  constructor(
    private readonly observer: Pool,
    private readonly measuredPid: number,
    private readonly intervalMs = 2,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      // Never queue a second poll behind a slow one: a backlog would both
      // distort the sampling interval and pile work onto the measured box.
      if (this.inFlight) return;
      this.inFlight = true;
      void this.observer
        .query<{ state: string | null; wait_event_type: string | null; wait_event: string | null }>(
          `SELECT state, wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`,
          [this.measuredPid],
        )
        .then((r) => {
          const row = r.rows[0];
          this.seen.push({
            tPerf: performance.now(),
            state: row?.state ?? null,
            waitEventType: row?.wait_event_type ?? null,
            waitEvent: row?.wait_event ?? null,
          });
        })
        .catch(() => undefined)
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Everything observed inside a `performance.now()` window, for one sample. */
  drainWindow(fromPerf: number, toPerf: number): WaitObservation[] {
    const inside = this.seen.filter((o) => o.tPerf >= fromPerf && o.tPerf <= toPerf);
    this.seen.length = 0;
    return inside;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 6 — HOST BASELINE PROBES (class G, H and R POSITIVE evidence)
 * ════════════════════════════════════════════════════════════════════ */

/**
 * CLASS R NEEDS POSITIVE EVIDENCE, AND THIS IS WHERE IT COMES FROM.
 *
 * The ruling is explicit: "'I could not find a product cause' is NOT Class R."
 * Class R requires showing that host stalls DOMINATE the tail — which means
 * demonstrating that this box produces stalls of the right SIZE and FREQUENCY
 * while doing no database and no product work at all.
 *
 * Two probes, deliberately touching nothing of DAFTAR's:
 *
 *   `timerStalls` — a tight loop that does nothing but read the clock and
 *   record every gap longer than a threshold. A gap in a loop with no I/O, no
 *   allocation and no syscall is the host taking the CPU away: pure class G.
 *   If this probe shows 40 ms gaps while the box is busy and none while it is
 *   quiet, the box is capable of producing the tail on its own.
 *
 *   `fsyncLatency` — `fdatasync` on a scratch file on the SAME filesystem the
 *   cluster's data directory lives on, timed. Pure class H, with no PostgreSQL
 *   involved. It bounds what the storage underneath can do to a COMMIT.
 *
 * Run both while the box is quiet and again while it is loaded, and the pair
 * answers "is this host capable of the observed tail" without any appeal to
 * the product. That comparison is the strongest form of the Class R argument
 * and the reason these exist.
 */
export function timerStalls(durationMs: number, thresholdMs = 2): { stalls: { atMs: number; gapMs: number }[]; iterations: number; maxGapMs: number } {
  const stalls: { atMs: number; gapMs: number }[] = [];
  const t0 = process.hrtime.bigint();
  const limit = BigInt(Math.round(durationMs * 1e6));
  const thresholdNs = BigInt(Math.round(thresholdMs * 1e6));
  let last = t0;
  let iterations = 0;
  let maxGap = 0n;
  for (;;) {
    const now = process.hrtime.bigint();
    const gap = now - last;
    if (gap > thresholdNs) stalls.push({ atMs: Number(now - t0) / 1e6, gapMs: Number(gap) / 1e6 });
    if (gap > maxGap) maxGap = gap;
    last = now;
    iterations += 1;
    if (now - t0 >= limit) break;
  }
  return { stalls, iterations, maxGapMs: Number(maxGap) / 1e6 };
}

/* ══════════════════════════════════════════════════════════════════════
 * 7 — THE PER-SAMPLE RECORD
 * ════════════════════════════════════════════════════════════════════ */

/**
 * ONE SAMPLE, WITH THE ORDER PRESERVED.
 *
 * `index` is the position in the series and it is load-bearing: a tail that
 * clusters at samples 47, 48 and 49 means "one event stalled three
 * consecutive operations" and a tail scattered across the series means
 * "independent noise". A percentile destroys that distinction, so every record
 * carries its index and the campaign writes the series in order, never sorted.
 *
 * `gapMs` is the time between the END of the previous timed region and the
 * START of this one — the window in which this harness did its own sampling.
 * It is recorded so a reader can bound the attribution ambiguity described at
 * the top of this file, and so the instrument's own cost is visible.
 */
export interface SampleRecord {
  readonly index: number;
  readonly durationMs: number;
  readonly gapMs: number;
  readonly startPerf: number;
  readonly endPerf: number;
  readonly cpu: { readonly userUs: number; readonly systemUs: number; readonly offCpuMs: number };
  readonly loop: { readonly max: number; readonly mean: number; readonly p99: number };
  readonly gc: readonly GcEvent[];
  readonly gcTotalMs: number;
  readonly faults: { readonly major: number; readonly minor: number };
  readonly ctxSwitches: { readonly involuntary: number; readonly voluntary: number };
  readonly heapUsedDelta: number;
  readonly host: {
    readonly psiCpuSomeUs: number;
    readonly psiCpuFullUs: number;
    readonly psiIoSomeUs: number;
    readonly psiIoFullUs: number;
    readonly psiMemSomeUs: number;
    readonly cpuBusyTicks: number;
    readonly cpuIowaitTicks: number;
    readonly cpuStealTicks: number;
    readonly myTicks: number;
    readonly pgTicks: number;
    readonly othersTicks: number;
    readonly runnable: number;
    readonly loadavg1: number;
    readonly majorFaults: number;
    readonly throttledTimeNs: number;
    readonly nrThrottled: number;
  };
  /** Deltas of every PostgreSQL counter, or `null` when the pass took none. */
  readonly pg: Readonly<Record<string, unknown>> | null;
  /** Wait events observed inside this sample's window; only the wait-sampled pass. */
  readonly waits: readonly WaitObservation[] | null;
  /**
   * WHAT THE OPERATION ACTUALLY RETURNED, read OUTSIDE the timed region.
   *
   * A sample is only a measurement of the operation if the operation
   * SUCCEEDED. An endpoint that starts refusing — an expired token, a closed
   * till session, a rate limit — answers far FASTER than it does when it
   * works, so an unchecked harness records the refusal as a brilliant sample
   * and the series silently stops being about the product. The accepted suite
   * guards this with `expect(r.status).toBe(200)` after each sample; this
   * records the same fact per sample instead, so the artefact can be audited
   * rather than merely trusted.
   *
   * Read from the value `once()` returned, AFTER the clock has stopped, so it
   * costs the timed region nothing.
   */
  readonly outcome: string | number | null;
}

/** Numeric deltas of two counter trees, recursively. Non-numeric leaves are kept from `b`. */
export function deltaTree(a: unknown, b: unknown): unknown {
  if (typeof a === 'number' && typeof b === 'number') return b - a;
  if (typeof a === 'string' && typeof b === 'string') {
    // Counters that arrive as strings because they are bigint-valued.
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && /^-?\d+(\.\d+)?$/.test(a) && /^-?\d+(\.\d+)?$/.test(b)) return nb - na;
    return b;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = {};
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) out[k] = deltaTree(ao[k], bo[k]);
    return out;
  }
  return b;
}

/**
 * THE MEASURED LOOP.
 *
 * The timed region is `await once()` between two `process.hrtime.bigint()`
 * reads and NOTHING ELSE — identical in shape to both accepted suites'
 * `measure`. Every sampler call sits outside it. `resetWindow()` is the last
 * statement before the clock starts and the samplers are read after it stops,
 * so the event-loop histogram and the GC records describe that one sample's
 * window and no other.
 *
 * The warm-up runs `once()` the accepted number of times and its samples are
 * discarded, never averaged in and never recorded as samples.
 */
export async function runSeries(opts: {
  readonly label: string;
  readonly once: () => Promise<unknown>;
  /** Reads the outcome off `once()`'s return value, OUTSIDE the timed region. */
  readonly outcomeOf?: (value: unknown) => string | number | null;
  readonly iterations: number;
  readonly warmup: number;
  readonly node: NodeSampler;
  readonly host: HostSampler;
  readonly pg: PgCounterSampler | null;
  readonly waits: WaitEventSampler | null;
}): Promise<SampleRecord[]> {
  for (let i = 0; i < opts.warmup; i += 1) await opts.once();

  const records: SampleRecord[] = [];
  let prevEnd = Number(process.hrtime.bigint()) / 1e6;

  for (let i = 0; i < opts.iterations; i += 1) {
    const nodeBefore = opts.node.snap();
    const hostBefore = opts.host.snap();
    const pgBefore = opts.pg === null ? null : await opts.pg.snap();

    const gapMs = Number(process.hrtime.bigint()) / 1e6 - prevEnd;
    opts.node.resetWindow();

    // ── TIMED REGION. Nothing but the operation. ──────────────────────
    const startPerf = performance.now();
    const started = process.hrtime.bigint();
    const returned = await opts.once();
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const endPerf = performance.now();
    // ── END TIMED REGION ─────────────────────────────────────────────

    // Outside the clock: what the operation returned.
    const outcome = opts.outcomeOf === undefined ? null : opts.outcomeOf(returned);

    prevEnd = Number(process.hrtime.bigint()) / 1e6;

    const loop = opts.node.loopDelay();
    const gc = opts.node.gc().filter((e) => e.startTime + e.duration >= startPerf && e.startTime <= endPerf);
    const nodeAfter = opts.node.snap();
    const hostAfter = opts.host.snap();
    const pgAfter = opts.pg === null ? null : await opts.pg.snap();

    const userUs = nodeAfter.cpuUserUs - nodeBefore.cpuUserUs;
    const systemUs = nodeAfter.cpuSystemUs - nodeBefore.cpuSystemUs;
    const cpuAttr = attributeCpu(hostBefore, hostAfter);

    records.push({
      index: i,
      durationMs,
      gapMs,
      startPerf,
      endPerf,
      cpu: {
        userUs,
        systemUs,
        // How much of the sample the process was NOT on a CPU. The primary
        // discriminator between F/A (we were running) and G/H/I (we were not).
        offCpuMs: durationMs - (userUs + systemUs) / 1000,
      },
      loop,
      gc,
      gcTotalMs: gc.reduce((s, e) => s + e.duration, 0),
      faults: { major: nodeAfter.majorPageFault - nodeBefore.majorPageFault, minor: nodeAfter.minorPageFault - nodeBefore.minorPageFault },
      ctxSwitches: {
        involuntary: nodeAfter.involuntaryContextSwitches - nodeBefore.involuntaryContextSwitches,
        voluntary: nodeAfter.voluntaryContextSwitches - nodeBefore.voluntaryContextSwitches,
      },
      heapUsedDelta: nodeAfter.heapUsed - nodeBefore.heapUsed,
      host: {
        psiCpuSomeUs: hostAfter.psiCpu.some - hostBefore.psiCpu.some,
        psiCpuFullUs: hostAfter.psiCpu.full - hostBefore.psiCpu.full,
        psiIoSomeUs: hostAfter.psiIo.some - hostBefore.psiIo.some,
        psiIoFullUs: hostAfter.psiIo.full - hostBefore.psiIo.full,
        psiMemSomeUs: hostAfter.psiMem.some - hostBefore.psiMem.some,
        cpuBusyTicks: cpuAttr.busy,
        cpuIowaitTicks: cpuAttr.iowait,
        cpuStealTicks: cpuAttr.steal,
        myTicks: cpuAttr.mine,
        pgTicks: cpuAttr.pg,
        othersTicks: cpuAttr.others,
        runnable: hostAfter.runnable,
        loadavg1: hostAfter.loadavg[0] ?? -1,
        majorFaults: hostAfter.vm.pgmajfault - hostBefore.vm.pgmajfault,
        throttledTimeNs: (hostAfter.cgroup?.throttledTimeNs ?? 0) - (hostBefore.cgroup?.throttledTimeNs ?? 0),
        nrThrottled: (hostAfter.cgroup?.nrThrottled ?? 0) - (hostBefore.cgroup?.nrThrottled ?? 0),
      },
      pg: pgBefore === null || pgAfter === null ? null : (deltaTree(pgBefore, pgAfter) as Record<string, unknown>),
      waits: opts.waits === null ? null : opts.waits.drainWindow(startPerf, endPerf),
      outcome,
    });
  }

  return records;
}
