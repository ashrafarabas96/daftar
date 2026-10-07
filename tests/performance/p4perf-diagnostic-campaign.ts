/**
 * TL-P4-PERF-A-02 — CAMPAIGN ORCHESTRATION. Shared by the two campaign files.
 *
 * ── THE PASSES, AND WHY THERE IS MORE THAN ONE ─────────────────────────
 *
 * The ruling forbids heavy telemetry inside the timed region and requires that
 * anything needing it run "as a SEPARATE diagnostic measurement ... labelled
 * as such; never mix the two series". So the campaign is a LADDER of passes
 * over the same operation, each adding one instrument, each keeping its own
 * series:
 *
 *   `clean`     Host and Node counters only, sampled between operations. No
 *               database round trip anywhere near a sample. This is the series
 *               closest to the accepted suite's semantics and it is the one any
 *               claim about the tail must rest on.
 *   `db`        Adds the PostgreSQL counter snapshot, on the observer
 *               connection, between samples. One extra round trip per sample
 *               boundary.
 *   `io-timed`  Adds `track_io_timing` and `track_wal_io_timing` on the
 *               measured session. THIS PUTS A CLOCK AROUND EVERY I/O INSIDE
 *               THE TIMED REGION. It is the only way to get fsync latency, and
 *               it is contaminating by construction, which is why it is its own
 *               pass and never pooled with `clean`.
 *   `wait`      Adds the concurrent wait-event sampler: a second connection
 *               polling `pg_stat_activity` every 2 ms while the operation runs.
 *               Also contaminating, also separate.
 *
 * THE LADDER IS ITSELF A MEASUREMENT. `clean` versus `db` is the cost of this
 * harness's own instrumentation; `db` versus `io-timed` is the cost of in-region
 * I/O timing. A diagnostic campaign that could not state its own overhead would
 * be unable to tell the product's tail from its own, so the overhead is
 * measured rather than asserted to be negligible.
 */
import { closeSync, fdatasyncSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { arch, cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import type { Client, Pool } from 'pg';
import {
  HostSampler,
  NodeSampler,
  PgCounterSampler,
  WaitEventSampler,
  prepareObserver,
  probeServer,
  runSeries,
  timerStalls,
  type SampleRecord,
  type ServerEnvironment,
} from './p4perf-diagnostic-telemetry';
import {
  assembleEvidence,
  correlateCounters,
  quantileBy,
  sampleFeatures,
  summariseArm,
  tailShape,
  type RankFn,
} from './p4perf-diagnostic-analysis';

/* ══════════════════════════════════════════════════════════════════════
 * OUTPUT LOCATION
 * ════════════════════════════════════════════════════════════════════ */

/**
 * NOT `release/`, AND NOT THE WORKING TREE.
 *
 * `release/` holds accepted performance evidence. This campaign is forbidden
 * from being used as acceptance evidence "regardless of its number", so it must
 * not be able to land in the directory where acceptance evidence is read from.
 * Writing into the tree at all is also unsafe here: a write between two reads
 * of a gate run can make a check pass over a tree that never existed, so the
 * campaign writes outside the repository and prints where.
 */
export const OUT_DIR = process.env['P4PERF_OUT'] ?? join(tmpdir(), 'p4perf-diagnostic');

export type PassId = 'clean' | 'db' | 'io-timed' | 'wait';

export interface PassSpec {
  readonly id: PassId;
  readonly dbCounters: boolean;
  readonly ioTiming: boolean;
  readonly waitSampler: boolean;
  readonly contaminating: boolean;
  readonly why: string;
}

/**
 * THE PRODUCT RATE LIMITER BOUNDS HOW BIG ONE CAMPAIGN RUN MAY BE.
 *
 * `apps/api/src/app/runtime.ts:116` throttles every HTTP surface at 300
 * requests per 60 seconds. A pass over two arms costs
 * `2 x (warmup + iterations)` requests, so the full four-pass ladder in both
 * orders is 400 requests in about 25 seconds and the last quarter of it comes
 * back `429`.
 *
 * That was not a guess: the first campaign run showed a 15x step change — ~30 ms
 * samples collapsing to ~2 ms — and the per-sample status column identified
 * every one of the fast samples as a `429` refusal, beginning at request ~300,
 * exactly where the limiter predicts. A refusal is faster than the operation,
 * so an unchecked harness would have published the refusals as a superb
 * result.
 *
 * THE LIMITER IS NOT DISABLED, RAISED OR BYPASSED. It is product behaviour and
 * the ruling forbids changing the product to observe a benchmark. Instead
 * `P4PERF_PASSES` selects which passes a run performs, and the campaign is run
 * more than once with a fresh application and a fresh limiter window each
 * time. The series are identical in semantics either way; only the number of
 * them per process changes.
 */
export function selectedPasses(): readonly PassSpec[] {
  const raw = process.env['P4PERF_PASSES'];
  if (raw === undefined || raw.trim() === '') return PASSES;
  const want = new Set(raw.split(',').map((s) => s.trim()));
  const chosen = PASSES.filter((p) => want.has(p.id));
  if (chosen.length === 0) throw new Error(`P4PERF_PASSES selected no known pass: ${raw}`);
  return chosen;
}

export const PASSES: readonly PassSpec[] = [
  { id: 'clean', dbCounters: false, ioTiming: false, waitSampler: false, contaminating: false, why: 'Semantics closest to the accepted suite. Any claim about the tail rests here.' },
  { id: 'db', dbCounters: true, ioTiming: false, waitSampler: false, contaminating: false, why: 'Adds PostgreSQL counter deltas between samples. One observer round trip per boundary.' },
  { id: 'io-timed', dbCounters: true, ioTiming: true, waitSampler: false, contaminating: true, why: 'track_io_timing/track_wal_io_timing clock every I/O INSIDE the timed region. The only source of fsync latency.' },
  { id: 'wait', dbCounters: true, ioTiming: false, waitSampler: true, contaminating: true, why: 'A second connection polls pg_stat_activity every 2 ms during the operation.' },
];

/* ══════════════════════════════════════════════════════════════════════
 * ENVIRONMENT
 * ════════════════════════════════════════════════════════════════════ */

export interface CampaignEnvironment {
  readonly campaignId: string;
  readonly ruling: string;
  readonly notAcceptanceEvidence: string;
  readonly startedAt: string;
  readonly gitSha: string;
  readonly gitBranch: string;
  readonly treeClean: boolean | null;
  readonly node: string;
  readonly os: string;
  readonly arch: string;
  readonly cpuCount: number;
  readonly cpuModel: string;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  readonly server: ServerEnvironment;
  readonly pgDir: string;
  readonly pgPort: string;
  readonly observerStatsFetchConsistency: string;
  readonly counterStatement: string;
  readonly hostInstruments: Readonly<Record<string, boolean>>;
  /** Instruments asked for by the ruling that this kernel/server cannot provide. */
  readonly declaredGaps: readonly string[];
}

/**
 * THE GAPS, DECLARED UP FRONT RATHER THAN DISCOVERED IN THE NUMBERS.
 *
 * The ruling asks which instruments cannot separate which classes. These are
 * the ones established by reading the kernel and the server catalogue, not by
 * measuring:
 */
export const DECLARED_GAPS: readonly string[] = [
  'G, per-process: /proc/sys/kernel/sched_schedstats does not exist on this kernel, so /proc/self/schedstat field 2 (run-queue wait of THIS process) is never accumulated and reads a constant 0. Run-queue wait is therefore available only HOST-WIDE via PSI, never attributed to the measuring thread.',
  'G vs I, partial: cgroup v1 is mounted here (no /sys/fs/cgroup/cpu.stat, no cpu.max) and cpu.cfs_quota_us is -1, so there is NO CPU quota and throttling counters are structurally zero. Container CPU throttling is excluded as a cause by configuration rather than by measurement.',
  'C, absolute latency: fsync and write LATENCY requires track_io_timing, which is off by default and is only enabled in the io-timed pass. In the clean and db passes every pg_stat_io *_time column is a structural zero, so class C is visible there as COUNTS (fsyncs, wal_records, wal_bytes) and not as time.',
  'H, device attribution: /proc/diskstats cannot be attributed to the cluster reliably in this container because the data directory sits on an overlay/tmpfs-backed path whose backing device is not the one diskstats names. Class H therefore rests on PSI io pressure and iowait, which are host-wide, plus the standalone fsync probe.',
  'Attribution window: every counter delta spans the operation AND the surrounding gap (gapMs is recorded per sample to bound it). A correlation over the whole series is sound; a claim about one individual sample is not, and must say so.',
  'B, C, D, E at PER-SAMPLE resolution: MEASURED AND REFUTED, not assumed. PostgreSQL 15+ accumulates cumulative statistics in backend-local memory and flushes them to shared memory at most once per second (PGSTAT_MIN_INTERVAL). The campaign samples every ~40 ms, so the deltas arrive in ~1-second lumps: in one measured series 0 of 20 samples showed any movement, and in another 3 of 20 samples carried 158 transactions and 36,391 block hits between them. Every pg_stat_* counter — including pg_stat_get_backend_io — is therefore usable at roughly ONE-SECOND granularity and NOT per sample. A cluster of consecutive slow samples spanning more than a second can still be correlated; a single slow sample cannot. CLOSING THIS GAP would need log_min_duration_statement=0 plus server-log parsing, which reports per statement with no in-region clock, and that is the recommended next instrument.',
  'A vs E, plan identity: a counter delta cannot show WHICH plan ran. Plan identity comes only from the separate EXPLAIN capture, taken outside the timed region, which is therefore a statement about a plan taken at that moment and not necessarily the one a given sample used.',
];

export async function captureEnvironment(opts: {
  readonly campaignId: string;
  readonly observer: Pool;
  readonly measuredPid: number;
  readonly relations: readonly string[];
  readonly gitSha: string;
  readonly gitBranch: string;
  readonly treeClean: boolean | null;
  readonly host: HostSampler;
  readonly counterStatement: string;
  readonly observerConsistency: string;
}): Promise<CampaignEnvironment> {
  return {
    campaignId: opts.campaignId,
    ruling: 'TL-P4-PERF-A-02',
    notAcceptanceEvidence:
      'This diagnostic campaign has NO PASS/FAIL VERDICT. It exists only to identify the tail. It must not be used as acceptance evidence regardless of its number.',
    startedAt: new Date().toISOString(),
    gitSha: opts.gitSha,
    gitBranch: opts.gitBranch,
    treeClean: opts.treeClean,
    node: process.version,
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    server: await probeServer(opts.observer),
    pgDir: process.env['PG_DIR'] ?? '(default)',
    pgPort: process.env['PG_PORT'] ?? '(default)',
    observerStatsFetchConsistency: opts.observerConsistency,
    counterStatement: opts.counterStatement,
    hostInstruments: opts.host.availability(),
    declaredGaps: DECLARED_GAPS,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * HOST BASELINE — the class R / class G+H probes, with no DAFTAR in them
 * ════════════════════════════════════════════════════════════════════ */

export interface HostBaseline {
  readonly label: string;
  readonly timer: { readonly stalls: readonly { readonly atMs: number; readonly gapMs: number }[]; readonly iterations: number; readonly maxGapMs: number; readonly durationMs: number };
  readonly fsync: { readonly samplesMs: readonly number[]; readonly p50: number; readonly p95: number; readonly max: number } | null;
}

/**
 * `fdatasync` latency on the cluster's own filesystem, with no PostgreSQL.
 *
 * Budget A's timed region contains a COMMIT, and a COMMIT with
 * `synchronous_commit = on` contains an fsync of the WAL. If this probe shows
 * the filesystem under `PG_DIR` capable of 40 ms syncs while the box is busy,
 * then the box can produce the tail on its own and the question becomes how
 * often — which is the Class R argument. If it shows a flat sub-millisecond
 * distribution, Class R loses its mechanism for a COMMIT-bound tail and the
 * evidence has to come from somewhere else.
 */
export function fsyncProbe(dir: string, samples: number): HostBaseline['fsync'] {
  let fd: number | null = null;
  const path = join(dir, `p4perf-fsync-probe-${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    fd = openSync(path, 'w');
    const buf = Buffer.alloc(8192, 0x5a);
    const out: number[] = [];
    for (let i = 0; i < samples; i += 1) {
      writeSync(fd, buf, 0, buf.length, 0);
      const t0 = process.hrtime.bigint();
      fdatasyncSync(fd);
      out.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const sorted = [...out].sort((a, b) => a - b);
    const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;
    return { samplesMs: out, p50: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1] ?? Number.NaN };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to recover */
      }
    }
    try {
      rmSync(path, { force: true });
    } catch {
      /* the probe file is scratch; failure to remove it is not a finding */
    }
  }
}

export function hostBaseline(label: string, dir: string, timerMs = 3000, fsyncSamples = 200): HostBaseline {
  const timer = timerStalls(timerMs, 2);
  return { label, timer: { ...timer, durationMs: timerMs }, fsync: fsyncProbe(dir, fsyncSamples) };
}

/* ══════════════════════════════════════════════════════════════════════
 * RUNNING ONE PASS OVER ONE ARM
 * ════════════════════════════════════════════════════════════════════ */

export interface ArmSpec {
  readonly label: string;
  readonly once: () => Promise<unknown>;
  /** Reads the operation's outcome off `once()`'s return value, outside the clock. */
  readonly outcomeOf?: (value: unknown) => string | number | null;
  readonly iterations: number;
  readonly warmup: number;
}

export interface SeriesResult {
  readonly pass: PassId;
  readonly arm: string;
  readonly order: string;
  readonly contaminating: boolean;
  readonly records: readonly SampleRecord[];
  /**
   * THE WALL-CLOCK WINDOW THIS SERIES OCCUPIED, in UTC.
   *
   * Recorded because the contention question has to be answerable FROM THE
   * RECORD rather than from anyone's memory. A contended sample looks
   * identical to the tail under investigation, so a pass whose window
   * intersects a period of known external load is classified
   * `INVALID — RESOURCE CONTENTION` and re-measured, never interpreted. One
   * campaign run of this harness was lost exactly that way: another agent ran
   * a whole-tree lint and typecheck in the main checkout between 15:08 and
   * 15:22 UTC, and every pass overlapping it had to be discarded.
   *
   * `loadavgAtStart` and the PSI deltas inside each sample are the corroborating
   * evidence: they say what the box was doing, not merely when.
   */
  readonly startedAt: string;
  readonly endedAt: string;
  readonly loadavgAtStart: readonly number[];
  readonly loadavgAtEnd: readonly number[];
}

/**
 * Enable or disable the in-region I/O clocks on the MEASURED session only.
 *
 * `SET` without `LOCAL` on the measured client, so it survives the
 * transactions inside the operation. Cluster-wide behaviour, other sessions
 * and durability are untouched: these two settings are pure observability and
 * change no WAL, no fsync and no commit semantics. What they DO change is the
 * cost of each I/O in the timed region, which is why the pass that sets them
 * is labelled contaminating.
 */
export async function setIoTiming(client: Client, on: boolean): Promise<{ ioTiming: string; walIoTiming: string }> {
  const v = on ? 'on' : 'off';
  const result = { ioTiming: 'unavailable', walIoTiming: 'unavailable' };
  try {
    await client.query(`SET track_io_timing = ${v}`);
    result.ioTiming = v;
  } catch {
    /* not permitted for this role: reported as unavailable, never assumed on */
  }
  try {
    await client.query(`SET track_wal_io_timing = ${v}`);
    result.walIoTiming = v;
  } catch {
    /* absent before PostgreSQL 17 */
  }
  return result;
}

export async function runPass(opts: {
  readonly spec: PassSpec;
  readonly arms: readonly ArmSpec[];
  readonly order: string;
  readonly node: NodeSampler;
  readonly host: HostSampler;
  readonly pg: PgCounterSampler | null;
  readonly observer: Pool;
  readonly measuredPid: number;
  readonly measuredClient: Client | null;
}): Promise<SeriesResult[]> {
  const waits = opts.spec.waitSampler ? new WaitEventSampler(opts.observer, opts.measuredPid, 2) : null;
  if (opts.spec.ioTiming && opts.measuredClient !== null) await setIoTiming(opts.measuredClient, true);
  waits?.start();
  try {
    const out: SeriesResult[] = [];
    for (const arm of opts.arms) {
      const startedAt = new Date().toISOString();
      const loadavgAtStart = loadavg();
      const records = await runSeries({
        label: `${opts.spec.id}/${arm.label}`,
        once: arm.once,
        outcomeOf: arm.outcomeOf,
        iterations: arm.iterations,
        warmup: arm.warmup,
        node: opts.node,
        host: opts.host,
        pg: opts.spec.dbCounters ? opts.pg : null,
        waits,
      });
      out.push({
        pass: opts.spec.id,
        arm: arm.label,
        order: opts.order,
        contaminating: opts.spec.contaminating,
        records,
        startedAt,
        endedAt: new Date().toISOString(),
        loadavgAtStart,
        loadavgAtEnd: loadavg(),
      });
    }
    return out;
  } finally {
    waits?.stop();
    if (opts.spec.ioTiming && opts.measuredClient !== null) await setIoTiming(opts.measuredClient, false);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * WRITING THE RAW ORDERED SERIES
 * ════════════════════════════════════════════════════════════════════ */

/**
 * EVERY SAMPLE, IN ORDER, TO A FILE — NOT A SUMMARY.
 *
 * Two files per series, deliberately:
 *
 *   `.durations.txt` — one duration per line, in the order taken and nothing
 *   else. Trivially diffable and plottable, and immune to any mistake in the
 *   rest of this harness: if every other artefact were wrong, this file would
 *   still be the raw series.
 *
 *   `.samples.jsonl` — one JSON record per line, same order, carrying the
 *   counter deltas beside the duration.
 *
 * Nothing is sorted, nothing is trimmed, nothing is excluded. The ruling
 * forbids deleted samples and trimmed tails, and the writer has no code path
 * that could drop one.
 */
export function writeSeries(dir: string, campaignId: string, s: SeriesResult): { durations: string; samples: string } {
  mkdirSync(dir, { recursive: true });
  const base = `${campaignId}.${s.pass}.${s.order}.${s.arm}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const durations = join(dir, `${base}.durations.txt`);
  const samples = join(dir, `${base}.samples.jsonl`);
  writeFileSync(durations, `${s.records.map((r) => r.durationMs.toFixed(6)).join('\n')}\n`);
  writeFileSync(samples, `${s.records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { durations, samples };
}

/* ══════════════════════════════════════════════════════════════════════
 * THE REPORT
 * ════════════════════════════════════════════════════════════════════ */

export interface SeriesReport {
  readonly pass: PassId;
  readonly arm: string;
  readonly order: string;
  readonly contaminating: boolean;
  readonly window: { readonly startedAt: string; readonly endedAt: string; readonly loadavgAtStart: readonly number[]; readonly loadavgAtEnd: readonly number[] };
  readonly summary: ReturnType<typeof summariseArm>;
  readonly tail: ReturnType<typeof tailShape>;
  readonly correlations: ReturnType<typeof correlateCounters>;
  readonly evidence: ReturnType<typeof assembleEvidence>;
  readonly slowestSamples: readonly SampleRecord[];
  readonly files: { readonly durations: string; readonly samples: string };
  /** The instrument's own cost, so the harness can be subtracted from the subject. */
  readonly meanGapMs: number;
}

/**
 * Summarise one series WITHOUT deciding anything.
 *
 * The slow set is defined as "at or above the p95 the suite's own percentile
 * reads", because that is the population whose behaviour decides the suite's
 * verdict. It is used to CONCENTRATE the counter tables, never to exclude a
 * sample from a statistic.
 */
export function reportSeries(s: SeriesResult, rank: RankFn, files: { durations: string; samples: string }): SeriesReport {
  const durations = s.records.map((r) => r.durationMs);
  const threshold = quantileBy(durations, 0.95, rank);
  const trees = s.records.map((r) => sampleFeatures(r) as Readonly<Record<string, unknown>>);
  const correlations = correlateCounters(durations, trees, threshold);
  const unavailable: Record<string, string[]> = {
    C: s.records.some((r) => r.pg !== null) ? [] : ['no PostgreSQL counters in this pass'],
  };
  return {
    pass: s.pass,
    arm: s.arm,
    order: s.order,
    contaminating: s.contaminating,
    window: { startedAt: s.startedAt, endedAt: s.endedAt, loadavgAtStart: s.loadavgAtStart, loadavgAtEnd: s.loadavgAtEnd },
    summary: summariseArm(`${s.pass}/${s.order}/${s.arm}`, durations, rank),
    tail: tailShape(durations, threshold),
    correlations: correlations.slice(0, 40),
    evidence: assembleEvidence(correlations, unavailable),
    slowestSamples: [...s.records].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
    files,
    meanGapMs: s.records.reduce((acc, r) => acc + r.gapMs, 0) / Math.max(1, s.records.length),
  };
}

export function writeReport(dir: string, campaignId: string, report: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${campaignId}.report.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

/* ══════════════════════════════════════════════════════════════════════
 * SETUP HELPERS
 * ════════════════════════════════════════════════════════════════════ */

export async function backendPidOf(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
  return rows[0]?.pid ?? -1;
}

export interface Instruments {
  readonly node: NodeSampler;
  readonly host: HostSampler;
  readonly pg: PgCounterSampler;
  readonly observerConsistency: string;
}

export async function buildInstruments(observer: Pool, measuredPid: number, relations: readonly string[]): Promise<Instruments> {
  const observerConsistency = await prepareObserver(observer);
  const env = await probeServer(observer);
  const node = new NodeSampler();
  node.start();
  const host = new HostSampler();
  host.watchBackend(measuredPid);
  const pg = await PgCounterSampler.create(observer, env.capabilities, measuredPid, relations);
  return { node, host, pg, observerConsistency };
}

/**
 * WHAT THE PLANNER COULD SEE, recorded before anything is attributed to a plan.
 *
 * "A budget measured against a table with no statistics is a number about the
 * missing statistics." One of this project's own budgets cost 2.9 s on a runner
 * and 122 ms after a single `ANALYZE`, with no query and no migration change.
 * So the campaign records, per relation, when it was last analyzed, how many
 * rows have been modified since, and the live/dead tuple counts — BEFORE it
 * reports any number, and whether or not anything looks wrong.
 */
export async function planningStatistics(observer: Pool, relations: readonly string[]): Promise<unknown[]> {
  const { rows } = await observer.query(
    `SELECT c.relname,
            s.last_analyze, s.last_autoanalyze, s.analyze_count, s.autoanalyze_count,
            s.n_live_tup, s.n_dead_tup, s.n_mod_since_analyze,
            c.reltuples::bigint AS reltuples, c.relpages,
            pg_total_relation_size(c.oid) AS total_bytes,
            (SELECT count(*) FROM pg_stats st WHERE st.schemaname = 'public' AND st.tablename = c.relname) AS analyzed_columns
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [[...relations]],
  );
  return rows;
}

/** `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)`, taken outside every timed region. */
export async function explainJson(client: Client | Pool, sql: string, params: readonly unknown[]): Promise<unknown> {
  try {
    const { rows } = await client.query<{ plan: unknown[] }>(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, VERBOSE, FORMAT JSON) ${sql}`, [...params]);
    return (rows[0] as unknown as { 'QUERY PLAN'?: unknown })?.['QUERY PLAN'] ?? rows[0];
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
