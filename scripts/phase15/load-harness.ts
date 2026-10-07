#!/usr/bin/env tsx
/**
 * P15 LOAD HARNESS — THE MEASURING INSTRUMENT (Phase 15, performance-evidence lane).
 *
 * STATUS: PREPARED / NOT PROMOTED. This file is tooling. It does not promote
 * anything, it is not wired into any correctness gate, and it has no opinion
 * about whether DAFTAR is ready to launch. Its only job is to measure a
 * declared load profile against a real PostgreSQL cluster and say, honestly,
 * one of five things: PASS, FAIL, INVALID MEASUREMENT, UNMEASURED-OBJECTIVE,
 * or a REFUSAL to produce any verdict at all.
 *
 * ── THE LAWS THIS FILE IMPLEMENTS, AND WHERE ──────────────────────────────
 *
 * L1  Never weaken a measurement to get green. The thresholds, sample counts,
 *     warmup counts and invalid-measurement bounds all live in
 *     `scripts/phase15/load-profiles.json`, declared, not computed here; this
 *     file reads them and never adjusts them. There is no retry loop, no
 *     outlier trimming, no "best of N" and no median-for-p95 substitution:
 *     `summarise()` reports p50, p95, p99, min and max from the full sample
 *     set, and `samplesMs` carries every sample in the order it was taken.
 *
 * L2  A noisy measurement under contention is an INVALID MEASUREMENT —
 *     neither PASS nor FAIL. `classify()` is that third verdict, and the four
 *     rules that can produce it (host load, warmup-vs-steady drift, sample
 *     dispersion, a foreign postmaster on the box) are declared with explicit
 *     bounds in the profile file. The harness prints WHICH rule fired.
 *
 * L3  sleep() is never proof. There is no sleep in the measured region of any
 *     profile. The settlement race (P15-LOAD-007) contends over real rows on
 *     real concurrent connections, with a deterministic lock order — a single
 *     `SELECT ... ORDER BY id FOR UPDATE` taking both rows, lower id first —
 *     so the race is PostgreSQL's row locks rather than a timer.
 *
 * L4  Host-sensitive absolute performance lives in a DEDICATED PERFORMANCE
 *     EVIDENCE LANE. Every profile carries `lane: "performance-evidence"`, and
 *     the harness REFUSES to run a profile that does not. Nothing here is
 *     callable from a correctness gate, and this file imports nothing from the
 *     gates so that nothing can start recursively re-running it.
 *
 * L5  The authoritative performance box is EXCLUSIVE, and every run records a
 *     run-identity: SHA, tree cleanliness, the exact command, host load
 *     average, the process list, start and end timestamps, the sample count
 *     and the result. `RESULT SHA != TARGET SHA` means the result does not
 *     prove the target SHA, so `--target-sha` is compared against HEAD and the
 *     mismatch is recorded on the record's face.
 *
 * L6  A result may be named only in the exact form the command was run. The
 *     record carries `command` verbatim, and the one-line summary names the
 *     profile id, the concurrency and the sample count beside the verdict, so
 *     a narrow result cannot be quoted under a broad name.
 *
 * L7  An empty subject set is a REFUSAL, never a pass: no such profile, zero
 *     rows seeded, or zero samples measured each exit non-zero with a named
 *     refusal and no verdict.
 *
 * L8  `$?` is captured as the IMMEDIATELY next statement after a command.
 *     Every `spawnSync` here reads `.status` off the returned object directly.
 *
 * ── THE CLUSTER ────────────────────────────────────────────────────────────
 *
 * The harness brings up its OWN throw-away cluster and applies
 * `infrastructure/database/bootstrap.sql` and then the migrations through
 * `runMigrations`, which is exactly what `scripts/db-from-zero.ts` does
 * (db-from-zero.ts:58-71). It deliberately does NOT import
 * `tests/helpers/global-setup.ts` or `tests/helpers/test-app.ts`: that module
 * calls `ensurePostgres()` unconditionally at import time's behest
 * (global-setup.ts:11-13) and would create the SHARED cluster as a side
 * effect. Nothing in this file can reach it.
 *
 * Usage:
 *   tsx scripts/phase15/load-harness.ts --profile P15-LOAD-001
 *     [--profiles <path>]      the profile file (default scripts/phase15/load-profiles.json)
 *     [--port <n>]             cluster port       (default $P15_LOAD_PG_PORT, else 55481)
 *     [--data-dir <path>]      cluster data dir   (default $P15_LOAD_PG_DIR, else a temp dir)
 *     [--out <path>]           run-identity record (default <data-dir parent>/<profile>.json)
 *     [--samples-per-worker n] FEWER samples than declared. Honest, loud and
 *                              NEVER a pass: it forces the verdict to
 *                              UNMEASURED-OBJECTIVE and stamps
 *                              `reducedSamples` on the record, because
 *                              reducing samples is the exact weakening L1
 *                              forbids. It exists so a smoke run can prove the
 *                              instrument works without being able to claim a
 *                              result.
 *     [--target-sha <sha>]     the commit this run is meant to prove
 *     [--list]                 print the profile ids and exit 0
 *
 * Exit codes: 0 PASS · 2 FAIL · 3 INVALID MEASUREMENT · 4 UNMEASURED-OBJECTIVE
 *             · 1 REFUSAL or an unexpected error (never a verdict)
 */
// FIRST. `embedded-postgres` registers a graceful-shutdown hook at import
// time, and `async-exit-hook` implements that hook by calling
// `process.exit(0)` with an EXPLICIT zero on `beforeExit` — which overwrites
// any `process.exitCode` already recorded. This harness hit exactly that: a
// PROFILE-NOT-FOUND refusal printed its message and then exited 0, which would
// have made every refusal readable as a pass. The project already diagnosed
// and solved this defect once; `tests/helpers/exit-code.ts` is that solution,
// and it is REUSED here rather than reimplemented, so there is one place the
// rule lives. It can only ever turn a 0 into a failure already recorded, never
// the reverse.
import { protectFailingExitCode } from '../../tests/helpers/exit-code';

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem, arch, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool, type PoolClient } from 'pg';
import { runMigrations } from '../../apps/api/src/infra/migrate';
import { ensureEmbeddedPgBinariesExecutable } from '../ensure-embedded-pg-binaries';

protectFailingExitCode();

const ROOT = join(__dirname, '../..');

/** The one port this harness may use. Another Phase 15 worker owns 55471, and 55432 is the shared cluster. */
export const DEFAULT_PORT = 55481;
export const PROFILE_FILE = 'scripts/phase15/load-profiles.json';
export const REQUIRED_LANE = 'performance-evidence';

// ── the refusals, named ────────────────────────────────────────────────────
//
// Each refusal is a distinct named law, not a generic error, because a test
// that asserts "it threw something" asserts nothing. `tests/performance/
// p15-load-harness.test.ts` asserts these exact strings.

export const REFUSAL_PREFIX = 'P15_LOAD_REFUSAL';

export const refusals = {
  profileNotFound: (id: string, known: readonly string[]): string =>
    `${REFUSAL_PREFIX}: PROFILE-NOT-FOUND — no profile with id "${id}" in ${PROFILE_FILE}; a verdict about a profile that does not exist would name nothing. Known ids: ${known.join(', ') || '(none)'}`,
  emptySampleSet: (id: string, distinctErrors: readonly string[] = []): string =>
    `${REFUSAL_PREFIX}: EMPTY-SAMPLE-SET — profile ${id} produced 0 measured samples; zero samples is not a fast measurement, it is no measurement, and no verdict may be derived from it${
      // Why there were none. A refusal that does not say what went wrong sends
      // the reader back to the harness instead of to the cause.
      distinctErrors.length === 0 ? '' : `. Every attempt failed; distinct errors: ${distinctErrors.join(' || ')}`
    }`,
  emptySubjectSet: (id: string, sql: string): string =>
    `${REFUSAL_PREFIX}: EMPTY-SUBJECT-SET — profile ${id} seeded 0 rows (\`${sql}\` returned 0); a load profile over an empty dataset measures nothing and cannot pass`,
  wrongLane: (id: string, lane: string): string =>
    `${REFUSAL_PREFIX}: WRONG-LANE — profile ${id} declares lane "${lane}", not "${REQUIRED_LANE}"; host-sensitive absolute performance may only be measured in the dedicated performance-evidence lane`,
  noOperations: (id: string): string =>
    `${REFUSAL_PREFIX}: EMPTY-WORKLOAD — profile ${id} declares no operation with any statement; there is nothing to measure`,
  nonPositiveSamples: (id: string, n: number): string =>
    `${REFUSAL_PREFIX}: NON-POSITIVE-SAMPLE-COUNT — profile ${id} asks for ${n} samples per worker; a measurement needs at least one`,
  nonPositiveConcurrency: (id: string, n: number): string =>
    `${REFUSAL_PREFIX}: NON-POSITIVE-CONCURRENCY — profile ${id} declares concurrency ${n}; a measurement needs at least one connection`,
  noKeys: (id: string): string =>
    `${REFUSAL_PREFIX}: EMPTY-KEY-SET — profile ${id} seeded rows but \`keys_sql\` returned no key; the workload has nothing to address`,
} as const;

export class LoadHarnessRefusal extends Error {}

const refuse = (message: string): never => {
  throw new LoadHarnessRefusal(message);
};

// ── the declared profile shape ─────────────────────────────────────────────

export interface Objective {
  readonly state: 'DECLARED' | 'UNDECLARED';
  readonly reason?: string;
  /** Only meaningful when state is DECLARED. */
  readonly max_ms?: number;
  readonly min_throughput_per_s?: number;
  readonly max_error_rate?: number;
  readonly source?: string;
  readonly inheritable_from?: { readonly source: string; readonly constant: string; readonly number_copied_here: boolean };
  readonly nearest_declared_number?: Record<string, unknown>;
}

export interface Invariant {
  readonly name: string;
  readonly sql: string;
  readonly expect: number;
}

export interface Profile {
  readonly id: string;
  readonly title: string;
  readonly surface: string;
  readonly lane: string;
  readonly metric: 'p50' | 'p95' | 'p99' | 'throughput' | 'error-rate';
  readonly concurrency: number;
  readonly duration_or_samples: { readonly kind: string; readonly samples_per_worker: number; readonly total_samples: number };
  readonly warmup: { readonly kind: string; readonly samples_per_worker: number };
  readonly objective: Objective;
  readonly dataset: { readonly seed_sql: readonly string[]; readonly rows_seeded_sql: string; readonly keys_sql: string };
  readonly workload: { readonly operation_mix: readonly { readonly op: string; readonly share: number; readonly statements: readonly string[] }[] };
  readonly invariants?: readonly Invariant[];
}

export interface InvalidRuleBounds {
  readonly R1_HOST_LOAD: { readonly max_loadavg_per_cpu: number };
  readonly R2_WARMUP_DRIFT: { readonly max_relative_drift: number };
  readonly R3_DISPERSION: { readonly max_p99_over_p50: number };
  readonly R4_FOREIGN_CLUSTER: { readonly max_foreign_postmasters: number };
}

export interface ProfileFile {
  readonly schema: string;
  readonly lane: string;
  readonly invalid_measurement_rules: InvalidRuleBounds;
  readonly profiles: readonly Profile[];
}

export function loadProfileFile(path: string): ProfileFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ProfileFile;
}

/**
 * Find a profile, or REFUSE. The refusal is the point: a harness that fell
 * back to "the first profile" or to a default would attribute a measurement
 * to a name nobody asked for.
 */
export function findProfile(file: ProfileFile, id: string): Profile {
  const found = file.profiles.find((p) => p.id === id);
  if (found === undefined)
    return refuse(
      refusals.profileNotFound(
        id,
        file.profiles.map((p) => p.id),
      ),
    );
  if (found.lane !== REQUIRED_LANE) return refuse(refusals.wrongLane(found.id, found.lane));
  const statements = found.workload.operation_mix.flatMap((o) => o.statements);
  if (statements.length === 0) return refuse(refusals.noOperations(found.id));
  if (!Number.isInteger(found.concurrency) || found.concurrency < 1) return refuse(refusals.nonPositiveConcurrency(found.id, found.concurrency));
  if (!Number.isInteger(found.duration_or_samples.samples_per_worker) || found.duration_or_samples.samples_per_worker < 1)
    return refuse(refusals.nonPositiveSamples(found.id, found.duration_or_samples.samples_per_worker));
  return found;
}

// ── statistics ─────────────────────────────────────────────────────────────

/**
 * NEAREST-RANK PERCENTILE, the SAME definition the accepted accounting budgets
 * use (`tests/performance/accounting-budgets.test.ts:112`): sort ascending,
 * then take the element at index `min(n - 1, floor(q * n))`.
 *
 * It is deliberately the same arithmetic and not a "better" one. The project
 * already has a p95 that means something specific, and a harness whose p95
 * meant a slightly different thing would make two numbers in two evidence
 * files silently incomparable. Nothing is trimmed and nothing is interpolated.
 */
export function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0)
    throw new LoadHarnessRefusal(`${REFUSAL_PREFIX}: EMPTY-SAMPLE-SET — percentile(${q}) of an empty sample set is undefined, not zero`);
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  const value = sorted[index];
  if (value === undefined) throw new LoadHarnessRefusal(`${REFUSAL_PREFIX}: PERCENTILE-INDEX — index ${index} is outside a ${sorted.length}-sample set`);
  return value;
}

export interface Stats {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly samplesMs: readonly number[];
}

export function summarise(samples: readonly number[]): Stats {
  if (samples.length === 0) throw new LoadHarnessRefusal(refusals.emptySampleSet('(unnamed)'));
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    min: percentile(samples, 0),
    max: sorted[sorted.length - 1] as number,
    // Every sample, in the order it was taken. Six summary statistics cannot
    // tell a slow operation from one stalled iteration, and that distinction
    // decides what to do about a missed objective.
    samplesMs: samples.map((v) => Number(v.toFixed(3))),
  };
}

// ── rule 2 / rule 3 inputs, and the INVALID MEASUREMENT verdict ────────────

export interface ClassifyInput {
  readonly bounds: InvalidRuleBounds;
  readonly cpuCount: number;
  readonly loadavg1AtStart: number;
  readonly loadavg1AtEnd: number;
  readonly warmupSamples: readonly number[];
  readonly steadySamples: readonly number[];
  readonly foreignPostmasters: readonly string[];
}

export interface RuleFiring {
  readonly rule: 'R1_HOST_LOAD' | 'R2_WARMUP_DRIFT' | 'R3_DISPERSION' | 'R4_FOREIGN_CLUSTER';
  readonly observed: string;
  readonly bound: string;
}

/**
 * WHICH RULE FIRED, named. An INVALID MEASUREMENT whose reason is not printed
 * is indistinguishable from a harness that could not make up its mind, and the
 * first thing anyone asks of one is "invalid because of what".
 *
 * These bounds may be TIGHTENED. Loosening one to turn an INVALID run green is
 * precisely the weakening this lane exists to prevent.
 */
export function classify(input: ClassifyInput): readonly RuleFiring[] {
  const fired: RuleFiring[] = [];
  const perCpuStart = input.loadavg1AtStart / Math.max(1, input.cpuCount);
  const perCpuEnd = input.loadavg1AtEnd / Math.max(1, input.cpuCount);
  const loadBound = input.bounds.R1_HOST_LOAD.max_loadavg_per_cpu;
  if (perCpuStart > loadBound || perCpuEnd > loadBound) {
    fired.push({
      rule: 'R1_HOST_LOAD',
      observed: `1-minute load average per CPU was ${perCpuStart.toFixed(2)} at the start and ${perCpuEnd.toFixed(2)} at the end (${input.cpuCount} CPUs)`,
      bound: `max_loadavg_per_cpu ${loadBound}`,
    });
  }

  if (input.warmupSamples.length > 0 && input.steadySamples.length > 0) {
    const warm = percentile(input.warmupSamples, 0.5);
    const steady = percentile(input.steadySamples, 0.5);
    const drift = warm === 0 ? 0 : Math.abs(steady - warm) / warm;
    const driftBound = input.bounds.R2_WARMUP_DRIFT.max_relative_drift;
    if (drift > driftBound) {
      fired.push({
        rule: 'R2_WARMUP_DRIFT',
        observed: `warmup median ${warm.toFixed(3)} ms, steady median ${steady.toFixed(3)} ms — relative drift ${(drift * 100).toFixed(1)}%, so the system never settled and the samples describe a transient`,
        bound: `max_relative_drift ${(driftBound * 100).toFixed(0)}%`,
      });
    }
  }

  if (input.steadySamples.length > 0) {
    const p50 = percentile(input.steadySamples, 0.5);
    const p99 = percentile(input.steadySamples, 0.99);
    const ratio = p50 === 0 ? Number.POSITIVE_INFINITY : p99 / p50;
    const dispersionBound = input.bounds.R3_DISPERSION.max_p99_over_p50;
    if (ratio > dispersionBound) {
      fired.push({
        rule: 'R3_DISPERSION',
        observed: `p99/p50 is ${Number.isFinite(ratio) ? ratio.toFixed(1) : 'infinite'} (p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms) — the sample set is dominated by stalls rather than by the operation`,
        bound: `max_p99_over_p50 ${dispersionBound}`,
      });
    }
  }

  const foreignBound = input.bounds.R4_FOREIGN_CLUSTER.max_foreign_postmasters;
  if (input.foreignPostmasters.length > foreignBound) {
    fired.push({
      rule: 'R4_FOREIGN_CLUSTER',
      observed: `${input.foreignPostmasters.length} PostgreSQL postmaster(s) other than this harness's own were live on the host: ${input.foreignPostmasters.join(' | ')} — the box is not exclusive`,
      bound: `max_foreign_postmasters ${foreignBound}`,
    });
  }

  return fired;
}

// ── the verdict ────────────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'INVALID MEASUREMENT' | 'UNMEASURED-OBJECTIVE';

export const EXIT_CODE: Readonly<Record<Verdict, number>> = {
  PASS: 0,
  FAIL: 2,
  'INVALID MEASUREMENT': 3,
  'UNMEASURED-OBJECTIVE': 4,
};

export interface VerdictInput {
  readonly profile: Profile;
  readonly stats: Stats;
  readonly throughputPerS: number;
  readonly errorCount: number;
  readonly attempted: number;
  readonly fired: readonly RuleFiring[];
  readonly invariantViolations: readonly string[];
  /** True when --samples-per-worker asked for fewer samples than the profile declares. */
  readonly reducedSamples: boolean;
}

export interface VerdictResult {
  readonly verdict: Verdict;
  readonly because: string;
}

/**
 * THE ORDER MATTERS, and it is this.
 *
 * 1. An invariant violation is a FAIL, ahead of everything else. A run that
 *    corrupted its own data is not "too noisy to tell"; it answered.
 * 2. Then INVALID MEASUREMENT. A noisy run's numbers do not support PASS and
 *    do not support FAIL, so they may not be compared against an objective at
 *    all — not even an UNDECLARED one.
 * 3. Then UNMEASURED-OBJECTIVE: measured and reported, but there is nothing to
 *    compare against. This is NEVER a PASS, and a reduced sample count lands
 *    here too, because fewer samples than declared is a weaker claim and a
 *    weaker claim may not be promoted to a result.
 * 4. Only then PASS or FAIL against the declared objective.
 */
export function decideVerdict(input: VerdictInput): VerdictResult {
  if (input.invariantViolations.length > 0) {
    return { verdict: 'FAIL', because: `invariant violated: ${input.invariantViolations.join('; ')}` };
  }
  if (input.fired.length > 0) {
    return {
      verdict: 'INVALID MEASUREMENT',
      because: `rule(s) fired: ${input.fired.map((f) => `${f.rule} — ${f.observed} (bound: ${f.bound})`).join(' || ')}`,
    };
  }
  if (input.reducedSamples) {
    return {
      verdict: 'UNMEASURED-OBJECTIVE',
      because: `the run took fewer samples than profile ${input.profile.id} declares (${input.stats.samples} of ${input.profile.duration_or_samples.total_samples}); a reduced sample count is a weaker claim and may not be promoted to a result`,
    };
  }
  if (input.profile.objective.state !== 'DECLARED') {
    return {
      verdict: 'UNMEASURED-OBJECTIVE',
      because: `profile ${input.profile.id} has objective.state = ${input.profile.objective.state} — measured and reported, but there is no declared number to compare against. ${input.profile.objective.reason ?? 'UNDECLARED — owner input required'}`,
    };
  }

  const o = input.profile.objective;
  const errorRate = input.attempted === 0 ? 1 : input.errorCount / input.attempted;
  const checks: { readonly ok: boolean; readonly said: string }[] = [];
  if (typeof o.max_ms === 'number') {
    const measured = input.profile.metric === 'p99' ? input.stats.p99 : input.profile.metric === 'p50' ? input.stats.p50 : input.stats.p95;
    checks.push({ ok: measured <= o.max_ms, said: `${input.profile.metric} ${measured.toFixed(3)} ms against ${o.max_ms} ms` });
  }
  if (typeof o.min_throughput_per_s === 'number') {
    checks.push({
      ok: input.throughputPerS >= o.min_throughput_per_s,
      said: `throughput ${input.throughputPerS.toFixed(2)}/s against ${o.min_throughput_per_s}/s`,
    });
  }
  if (typeof o.max_error_rate === 'number') {
    checks.push({ ok: errorRate <= o.max_error_rate, said: `error rate ${(errorRate * 100).toFixed(2)}% against ${(o.max_error_rate * 100).toFixed(2)}%` });
  }
  if (checks.length === 0) {
    return {
      verdict: 'UNMEASURED-OBJECTIVE',
      because: `profile ${input.profile.id} says objective.state = DECLARED but states no number (no max_ms, min_throughput_per_s or max_error_rate); a declaration with nothing in it is not an objective`,
    };
  }
  const missed = checks.filter((c) => !c.ok);
  return missed.length === 0
    ? { verdict: 'PASS', because: checks.map((c) => c.said).join('; ') }
    : { verdict: 'FAIL', because: `outside the declared objective: ${missed.map((c) => c.said).join('; ')}` };
}

// ── host facts, for the run identity and for rules R1 and R4 ───────────────

/**
 * Other PostgreSQL postmasters on this box, excluding this harness's own data
 * directory. Phase 15 runs several workers in parallel, and a measurement
 * taken beside somebody else's cluster is a measurement of a shared machine.
 */
export function foreignPostmasters(ownDataDir: string): readonly string[] {
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  const status = ps.status;
  if (status !== 0 || typeof ps.stdout !== 'string') return [];
  return ps.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /(^|\/)(postgres|postmaster)(\s|$)/.test(l.replace(/^\d+\s+/, '')))
    .filter((l) => / -D (\S+)/.test(l))
    .filter((l) => !l.includes(ownDataDir))
    .map((l) => l.slice(0, 200));
}

const git = (...args: string[]): string => {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const status = res.status;
  return status === 0 ? res.stdout.trim() : 'unknown';
};

export interface RunIdentity {
  readonly harness: 'P15-LOAD-HARNESS';
  readonly status: 'PREPARED / NOT PROMOTED';
  readonly lane: typeof REQUIRED_LANE;
  readonly profileId: string;
  readonly profileTitle: string;
  readonly surface: string;
  /** L5: the SHA the run actually read. */
  readonly sha: string;
  readonly branch: string;
  /** L5: a dirty tree means the SHA does not describe what ran. */
  readonly treeClean: boolean;
  readonly treeDirtyPaths: readonly string[];
  readonly targetSha: string | null;
  /** L5: RESULT SHA != TARGET SHA ⇒ the result does not prove the target SHA. */
  readonly provesTargetSha: boolean | null;
  /** L6: verbatim, so a narrow result cannot be quoted under a broad name. */
  readonly command: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly loadavgAtStart: readonly number[];
  readonly loadavgAtEnd: readonly number[];
  readonly foreignPostmasters: readonly string[];
  readonly host: Record<string, unknown>;
  readonly postgres: string;
  readonly databaseSettings: readonly Record<string, unknown>[];
  readonly migrationsApplied: number;
  readonly rowsSeeded: number;
  readonly keysSeeded: number;
  readonly concurrency: number;
  readonly warmupSamplesPerWorker: number;
  readonly samplesPerWorker: number;
  readonly declaredTotalSamples: number;
  readonly reducedSamples: boolean;
  readonly sampleCount: number;
  readonly errorCount: number;
  /** Why the failures failed. Counted, reported, never retried until green. */
  readonly distinctErrors: readonly string[];
  readonly attempted: number;
  readonly throughputPerS: number;
  readonly wallMsMeasuredRegion: number;
  readonly objective: Objective;
  readonly metric: string;
  readonly stats: Stats;
  readonly warmupStats: Stats | null;
  readonly invalidRulesFired: readonly RuleFiring[];
  readonly invariantResults: readonly { readonly name: string; readonly observed: number; readonly expected: number; readonly ok: boolean }[];
  readonly verdict: Verdict;
  readonly because: string;
  readonly exitCode: number;
  readonly notProvenByThisRun: readonly string[];
}

// ── the measured region ────────────────────────────────────────────────────

/** The highest positional parameter a statement mentions. */
export function highestParameter(sql: string): number {
  let max = 0;
  for (const m of sql.matchAll(/\$(\d+)/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/**
 * BIND ONLY THE PARAMETERS THE STATEMENT USES, RENUMBERED DENSELY.
 *
 * The profile file gives every statement the same five-slot vocabulary —
 * $1 worker, $2 iteration, $3 uuid, $4 key A, $5 key B — so a reader can see
 * at a glance what a statement addresses. PostgreSQL will not accept that
 * directly: handing it five values for a statement that mentions only `$3`
 * fails with "bind message supplies 5 parameters, but prepared statement
 * requires 1", and slicing to the highest index instead fails with "could not
 * determine data type of parameter $1", because a parameter that appears
 * nowhere has no inferable type. The harness hit the second of those on its
 * first real run against a cluster.
 *
 * So the slots a statement actually mentions are renumbered to a dense
 * 1..k sequence, in ascending order of the original slot, and exactly those k
 * values are passed. `$3` alone becomes `$1` bound to the uuid; `$3, $4, $5`
 * becomes `$1, $2, $3` bound to the uuid, key A and key B. The statement's
 * MEANING is untouched — only the numbering is — and the mapping is a pure
 * function, so `tests/performance/p15-load-harness.test.ts` can assert it
 * without a database.
 */
export function bindStatement(sql: string, params: readonly (string | number)[]): { readonly sql: string; readonly values: readonly (string | number)[] } {
  const mentioned = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const denseOf = new Map(mentioned.map((slot, i) => [slot, i + 1] as const));
  return {
    sql: sql.replace(/\$(\d+)/g, (_whole, digits: string) => `$${String(denseOf.get(Number(digits)) ?? digits)}`),
    values: mentioned.map((slot) => {
      const value = params[slot - 1];
      if (value === undefined) {
        throw new LoadHarnessRefusal(
          `${REFUSAL_PREFIX}: UNBOUND-PARAMETER — a statement mentions $${slot} but the harness binds only ${params.length} slot(s); see parameter_binding in ${PROFILE_FILE}`,
        );
      }
      return value;
    }),
  };
}

/**
 * ONE SAMPLE. The clock is monotonic (`process.hrtime.bigint`), it starts
 * before BEGIN and stops after COMMIT has returned, and COMMIT is inside the
 * measured region on purpose: deferred constraint triggers and the WAL flush
 * run there, so timing only the statements would leave out the part of the
 * cost that scales. There is no sleep anywhere in here.
 */
async function oneSample(client: PoolClient, statements: readonly string[], params: readonly (string | number)[]): Promise<number> {
  const started = process.hrtime.bigint();
  await client.query('BEGIN');
  try {
    for (const statement of statements) {
      const bound = bindStatement(statement, params);
      await client.query(bound.sql, [...bound.values]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
  return Number(process.hrtime.bigint() - started) / 1e6;
}

interface WorkerOutcome {
  readonly warmup: readonly number[];
  readonly steady: readonly number[];
  readonly errors: readonly string[];
  readonly attempted: number;
}

async function runWorker(pool: Pool, profile: Profile, worker: number, samplesPerWorker: number, keys: readonly string[]): Promise<WorkerOutcome> {
  const statements = profile.workload.operation_mix.flatMap((o) => o.statements);
  const warmup: number[] = [];
  const steady: number[] = [];
  const errors: string[] = [];
  let attempted = 0;
  const client = await pool.connect();
  try {
    const total = profile.warmup.samples_per_worker + samplesPerWorker;
    for (let iter = 0; iter < total; iter += 1) {
      // Key A and key B are distinct by construction, and the profiles that
      // lock two rows order them in SQL (`ORDER BY id FOR UPDATE`), which is
      // what makes the lock order deterministic rather than lucky.
      const a = keys[(worker + iter) % keys.length] as string;
      const b = keys[(worker + iter + 1) % keys.length] as string;
      const params: (string | number)[] = [worker, iter, randomUUID(), a, b];
      attempted += 1;
      try {
        const ms = await oneSample(client, statements, params);
        if (iter < profile.warmup.samples_per_worker) warmup.push(ms);
        else steady.push(ms);
      } catch (e) {
        // An error is COUNTED and REPORTED, never retried until green and
        // never dropped from the denominator.
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  } finally {
    client.release();
  }
  return { warmup, steady, errors, attempted };
}

// ── main ───────────────────────────────────────────────────────────────────

function argOf(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1] as string;
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? null : inline.slice(name.length + 3);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = `${process.argv[0] ?? 'node'} ${process.argv.slice(1).join(' ')}`;
  const profilePath = argOf(argv, 'profiles') ?? join(ROOT, PROFILE_FILE);
  const file = loadProfileFile(profilePath);

  if (argv.includes('--list')) {
    for (const p of file.profiles)
      console.log(`${p.id}  ${p.metric.padEnd(10)}  c=${String(p.concurrency).padEnd(2)}  ${p.objective.state.padEnd(10)}  ${p.title}`);
    return 0;
  }

  const id = argOf(argv, 'profile');
  if (id === null) {
    console.error(
      `${REFUSAL_PREFIX}: NO-PROFILE-NAMED — pass --profile <id>, or --list to see the declared ids. A harness that picked a profile for you would attribute a measurement to a name nobody asked for.`,
    );
    return 1;
  }
  const profile = findProfile(file, id);

  const port = Number(argOf(argv, 'port') ?? process.env['P15_LOAD_PG_PORT'] ?? DEFAULT_PORT);
  const dataDir = argOf(argv, 'data-dir') ?? process.env['P15_LOAD_PG_DIR'] ?? join(tmpdir(), `p15-load-pg-${randomUUID()}`);
  const outPath = argOf(argv, 'out') ?? join(dirname(dataDir), `p15-load-${profile.id}.json`);
  const targetSha = argOf(argv, 'target-sha');
  const askedSamples = argOf(argv, 'samples-per-worker');
  const samplesPerWorker = askedSamples === null ? profile.duration_or_samples.samples_per_worker : Number(askedSamples);
  if (!Number.isInteger(samplesPerWorker) || samplesPerWorker < 1) refuse(refusals.nonPositiveSamples(profile.id, samplesPerWorker));
  // L1, stated in the open: asking for FEWER samples than declared is allowed
  // for a smoke run, it is stamped on the record, and it can never be a PASS.
  const reducedSamples = samplesPerWorker < profile.duration_or_samples.samples_per_worker;

  const sha = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  console.log(`P15 LOAD HARNESS — ${profile.id} ${profile.title}`);
  console.log(`  lane      ${profile.lane} (PREPARED / NOT PROMOTED)`);
  console.log(`  surface   ${profile.surface}`);
  console.log(`  objective ${profile.objective.state}${profile.objective.state === 'DECLARED' ? '' : ' — owner input required'}`);
  console.log(`  cluster   port ${port}, data dir ${dataDir}`);
  console.log(
    `  samples   ${profile.concurrency} × ${samplesPerWorker}${reducedSamples ? ` (REDUCED from ${profile.duration_or_samples.samples_per_worker}; this run cannot pass)` : ''}, warmup ${profile.warmup.samples_per_worker}/worker`,
  );

  ensureEmbeddedPgBinariesExecutable();
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false });
  const pools: Pool[] = [];
  const startedAt = new Date().toISOString();
  let migrationsApplied = 0;

  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('daftar');
    const owner = `postgresql://postgres:postgres@localhost:${port}/daftar`;

    // The bootstrap + migration sequence `scripts/db-from-zero.ts:63-71` runs,
    // from the same two sources, so the cluster measured against is the one a
    // deployment administrator would have produced.
    let bootstrap = readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8');
    for (const [placeholder, value] of Object.entries({
      __APP_DB_PASSWORD__: 'p15_app_pw_123456',
      __PLATFORM_DB_PASSWORD__: 'p15_platform_pw_123456',
      __WORKER_DB_PASSWORD__: 'p15_worker_pw_123456',
      __RESOLVER_DB_PASSWORD__: 'p15_resolver_pw_123456',
      __IDENTITY_DB_PASSWORD__: 'p15_identity_pw_123456',
      __PROVISIONER_DB_PASSWORD__: 'p15_provisioner_pw_123456',
      __RECONCILER_DB_PASSWORD__: 'p15_reconciler_pw_123456',
      __MIGRATOR_DB_PASSWORD__: 'p15_migrator_pw_123456',
    })) {
      bootstrap = bootstrap.replaceAll(placeholder, value);
    }
    const admin = new Pool({ connectionString: owner, max: 2 });
    admin.on('error', () => undefined);
    pools.push(admin);
    await admin.query(bootstrap);
    migrationsApplied = (await runMigrations(owner)).length;
    console.log(`  schema    bootstrap.sql applied, ${migrationsApplied} migrations applied`);

    // ── seed, then REFUSE an empty subject set ────────────────────────────
    for (const sql of profile.dataset.seed_sql) await admin.query(sql);
    const seeded = Number((await admin.query<{ n: string }>(profile.dataset.rows_seeded_sql)).rows[0]?.n ?? 0);
    if (!(seeded > 0)) refuse(refusals.emptySubjectSet(profile.id, profile.dataset.rows_seeded_sql));
    const keys = (await admin.query<{ key: string }>(profile.dataset.keys_sql)).rows.map((r) => r.key);
    if (keys.length < 2) refuse(refusals.noKeys(profile.id));
    console.log(`  dataset   ${seeded} rows seeded, ${keys.length} keys`);

    // Flush before the clock starts, so a measured iteration waits on its own
    // work rather than on the seeding's dirty pages — the same correction the
    // accepted budgets carry at accounting-budgets.test.ts:261-274.
    await admin.query('CHECKPOINT');
    await admin.query('ANALYZE');

    const pool = new Pool({ connectionString: owner, max: profile.concurrency + 1 });
    pool.on('error', () => undefined);
    pools.push(pool);

    const loadAtStart = loadavg();
    const regionStart = process.hrtime.bigint();
    const outcomes = await Promise.all(
      Array.from({ length: profile.concurrency }, (_unused, worker) => runWorker(pool, profile, worker, samplesPerWorker, keys)),
    );
    const regionMs = Number(process.hrtime.bigint() - regionStart) / 1e6;
    const loadAtEnd = loadavg();
    const foreign = foreignPostmasters(dataDir);

    const steady = outcomes.flatMap((o) => o.steady);
    const warm = outcomes.flatMap((o) => o.warmup);
    const errors = outcomes.flatMap((o) => o.errors);
    const attempted = outcomes.reduce((n, o) => n + o.attempted, 0);
    const distinctErrors = [...new Set(errors)].slice(0, 5);
    if (errors.length > 0) for (const e of distinctErrors) console.log(`  error     ${e}`);
    if (steady.length === 0) refuse(refusals.emptySampleSet(profile.id, distinctErrors));

    const stats = summarise(steady);
    const warmupStats = warm.length > 0 ? summarise(warm) : null;
    const throughputPerS = regionMs === 0 ? 0 : (steady.length / regionMs) * 1000;

    const invariantResults = [] as { name: string; observed: number; expected: number; ok: boolean }[];
    for (const inv of profile.invariants ?? []) {
      const row = (await admin.query<Record<string, string>>(inv.sql)).rows[0];
      const observed = Number(Object.values(row ?? {})[0] ?? Number.NaN);
      invariantResults.push({ name: inv.name, observed, expected: inv.expect, ok: observed === inv.expect });
    }

    const fired = classify({
      bounds: file.invalid_measurement_rules,
      cpuCount: cpus().length,
      loadavg1AtStart: loadAtStart[0] ?? 0,
      loadavg1AtEnd: loadAtEnd[0] ?? 0,
      warmupSamples: warm,
      steadySamples: steady,
      foreignPostmasters: foreign,
    });

    const { verdict, because } = decideVerdict({
      profile,
      stats,
      throughputPerS,
      errorCount: errors.length,
      attempted,
      fired,
      invariantViolations: invariantResults.filter((r) => !r.ok).map((r) => `${r.name} (observed ${r.observed}, expected ${r.expected})`),
      reducedSamples,
    });

    const { rows: version } = await admin.query<{ v: string }>('SELECT version() AS v');
    const { rows: settings } = await admin.query<Record<string, unknown>>(
      `SELECT name, setting, unit FROM pg_settings
        WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','max_parallel_workers_per_gather','random_page_cost','synchronous_commit','fsync','wal_level','jit')
        ORDER BY name`,
    );

    const identity: RunIdentity = {
      harness: 'P15-LOAD-HARNESS',
      status: 'PREPARED / NOT PROMOTED',
      lane: REQUIRED_LANE,
      profileId: profile.id,
      profileTitle: profile.title,
      surface: profile.surface,
      sha,
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      treeClean: dirty.length === 0,
      treeDirtyPaths: dirty.slice(0, 50),
      targetSha,
      provesTargetSha: targetSha === null ? null : targetSha === sha,
      command,
      startedAt,
      endedAt: new Date().toISOString(),
      loadavgAtStart: loadAtStart,
      loadavgAtEnd: loadAtEnd,
      foreignPostmasters: foreign,
      host: {
        os: `${platform()} ${release()}`,
        arch: arch(),
        cpuCount: cpus().length,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        totalMemoryBytes: totalmem(),
        node: process.version,
        exclusiveBox: foreign.length === 0 ? 'no foreign postmaster observed' : 'NOT EXCLUSIVE — see foreignPostmasters',
      },
      postgres: version[0]?.v ?? 'unknown',
      databaseSettings: settings,
      migrationsApplied,
      rowsSeeded: seeded,
      keysSeeded: keys.length,
      concurrency: profile.concurrency,
      warmupSamplesPerWorker: profile.warmup.samples_per_worker,
      samplesPerWorker,
      declaredTotalSamples: profile.duration_or_samples.total_samples,
      reducedSamples,
      sampleCount: stats.samples,
      errorCount: errors.length,
      distinctErrors,
      attempted,
      throughputPerS: Number(throughputPerS.toFixed(3)),
      wallMsMeasuredRegion: Number(regionMs.toFixed(3)),
      objective: profile.objective,
      metric: profile.metric,
      stats,
      warmupStats,
      invalidRulesFired: fired,
      invariantResults,
      verdict,
      because,
      exitCode: EXIT_CODE[verdict],
      notProvenByThisRun: [
        "This harness drives hand-written SQL against its own tables in a fully migrated DAFTAR database. It does NOT execute the product's command handlers, HTTP layer, authorization or row level security, so it proves nothing about product endpoint latency.",
        'A throw-away embedded cluster on a shared container is not the authoritative performance box. Absolute numbers from it bind to this host and this run only.',
        targetSha === null
          ? 'No --target-sha was given, so this run proves nothing about any commit other than the SHA recorded above.'
          : targetSha === sha
            ? 'The target SHA equals the result SHA.'
            : `RESULT SHA ${sha} != TARGET SHA ${targetSha} — this result DOES NOT prove the target SHA.`,
        dirty.length === 0 ? 'The tree was clean.' : `The tree was DIRTY (${dirty.length} path(s)) — the recorded SHA does not describe what ran.`,
      ],
    };

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(identity, null, 2)}\n`);

    for (const f of fired) console.log(`  INVALID RULE FIRED  ${f.rule} — ${f.observed} (bound: ${f.bound})`);
    for (const r of invariantResults) console.log(`  invariant ${r.ok ? 'held ' : 'BROKE'} ${r.name} (observed ${r.observed}, expected ${r.expected})`);
    console.log(
      `P15_LOAD: ${JSON.stringify({
        profile: profile.id,
        metric: profile.metric,
        objective: profile.objective.state,
        concurrency: profile.concurrency,
        samples: stats.samples,
        declaredSamples: profile.duration_or_samples.total_samples,
        reducedSamples,
        errors: errors.length,
        attempted,
        p50: Number(stats.p50.toFixed(3)),
        p95: Number(stats.p95.toFixed(3)),
        p99: Number(stats.p99.toFixed(3)),
        throughputPerS: Number(throughputPerS.toFixed(3)),
        rulesFired: fired.map((f) => f.rule),
        sha,
        treeClean: dirty.length === 0,
        provesTargetSha: identity.provesTargetSha,
        verdict,
        exitCode: EXIT_CODE[verdict],
        record: outPath,
      })}\n`,
    );
    console.log(`P15 LOAD ${profile.id}: ${verdict} — ${because}`);
    console.log(`  run identity written to ${outPath}`);
    return EXIT_CODE[verdict];
  } finally {
    for (const p of pools) await p.end().catch(() => undefined);
    await pg.stop().catch(() => undefined);
  }
}

/**
 * Only when RUN, never when imported by the harness's own test suite.
 *
 * The guard reads `process.argv[1]` rather than `require.main`, because the
 * test suite imports this module under Vitest's ESM loader where `require` is
 * not defined — and a harness whose `main()` fired on import would start a
 * PostgreSQL cluster inside a unit test.
 */
const invokedDirectly = (process.argv[1] ?? '').endsWith('load-harness.ts');
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      console.error(message.startsWith(REFUSAL_PREFIX) ? message : `${REFUSAL_PREFIX}: HARNESS-ERROR — ${message}`);
      console.error('P15 LOAD: NO VERDICT — a refusal is not a FAIL and is never a PASS.');
      process.exitCode = 1;
    },
  );
}
