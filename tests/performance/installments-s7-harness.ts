/**
 * P4-S7 — THE PERFORMANCE HARNESS FOR THE DEBT, STATEMENT AND SCHEDULE READS.
 *
 * **THIS MODULE TAKES NO MEASUREMENT AND PRODUCES NO VERDICT WHEN IT IS NOT
 * ALONE ON THE MACHINE.** An authoritative performance measurement needs
 * exclusive use of the container, and while other agents are running a figure
 * taken here is INVALID — `RESOURCE_CONTENTION`, neither a pass nor a fail.
 * `exclusivity()` below is what decides that, from an explicit environment
 * declaration and never from a guess, and `tests/performance/installments-s7-budgets.test.ts`
 * refuses to assert a budget unless it says `exclusive`.
 *
 * The slice BUILDS the harness. The coordinator RUNS it under an exclusive box.
 * That split is in the code and not only in a report, because a harness that
 * can quietly produce a number under contention will eventually have one of
 * its numbers believed.
 *
 * ── THE RECORDED LESSON THIS HARNESS IS SHAPED BY ───────────────────────
 *
 * «A benchmark measures what the planner saw. A budget measured against a
 * table with no statistics is a number about the missing statistics — one
 * accepted budget cost 2.9 s on a runner and 122 ms after a single `ANALYZE`,
 * with no query or migration change.»
 *
 * So this harness is required to SAY, in its own output:
 *
 *  1. WHICH relations it `ANALYZE`d, by name, and when — read back from
 *     `pg_stat_user_tables.last_analyze`, never from the fact that an
 *     `ANALYZE` statement was issued. A statement that ran against a relation
 *     that did not exist is a statement, not statistics;
 *  2. AT WHAT SCALE — the row count of every measured relation, the dataset's
 *     size on disk, and the tier multiplier the run used;
 *  3. THE SAME READ BEFORE THE `ANALYZE`, printed as a DIAGNOSTIC and never
 *     asserted (P4-AL-74's shape), so a reader can see how much of the figure
 *     was the statistics;
 *  4. WHETHER `planningStatistics()` CAME BACK NON-NULL for every measured
 *     relation. A budget met with a null `last_analyze` is the 2.9-second
 *     number wearing the 122-millisecond number's clothes, and
 *     `analyzeEvidence` refuses to call such a run authoritative.
 *
 * ── WHAT IT MEASURES, AND WHY THOSE FOUR ────────────────────────────────
 *
 * The four reads whose cost is a function of HISTORY rather than of the page:
 *
 *  - `P4-S7-A` the instalment page of ONE plan. Bounded at 120 rows by
 *    construction, so it is the CONTROL: if this moves, the machine moved;
 *  - `P4-S7-B` the customer statement page. The one read whose candidate set
 *    grows with the customer's whole history, which is why it is a keyset page
 *    and why its budget is the one that matters;
 *  - `P4-S7-C` the customer debts page, whose fat tail is the `0080` shape
 *    `0084` already paid for once: a shop selling mostly for cash accumulates
 *    permanently failing candidates;
 *  - `P4-S7-D` the plan projection, which makes ONE call to
 *    `invoice_outstanding` and must therefore cost what that call costs and
 *    not n times it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 *  - it does not SEED anything. The relations it measures do not exist yet
 *    (maturity level E), so `seedPlan` is a DECLARATION of the dataset shape
 *    the run needs and the module refuses to invent a schema to make itself
 *    runnable;
 *  - it does not choose its own ceilings. `BUDGETS` carries the ones the
 *    contract pack states, and the contract pack is where the owner changes
 *    them;
 *  - it takes no `p95` over fewer samples than it claims. `assertSamples`
 *    refuses a short series rather than quietly reporting a `p90`.
 */
import * as nodeOs from 'node:os';
import { readPlanEvidenceEnvironment } from '../helpers/plan-evidence-env';
import { ownerPool } from '../helpers/test-app';
import { distribution, type Distribution } from './percentile';

// ─────────────────────────────────────────────────────────────────────────
// 1. EXCLUSIVITY — the gate in front of every verdict
// ─────────────────────────────────────────────────────────────────────────

/** Why a run may not produce a verdict, or `null` when it may. */
export type ContentionReason = 'not_declared_exclusive' | 'load_average_above_one_core' | null;

export interface Exclusivity {
  readonly verdict: 'exclusive' | 'resource_contention';
  readonly reason: ContentionReason;
  /** Everything a reader needs to judge the verdict, including the figures that produced it. */
  readonly evidence: {
    readonly declared: string | null;
    readonly loadAverage1m: number;
    readonly cpuCount: number;
  };
}

/**
 * Whether this run may produce a verdict.
 *
 * TWO conditions, and both must hold:
 *
 *  1. `DAFTAR_PERF_EXCLUSIVE=1` is DECLARED. A declaration, because no process
 *     can discover from inside the box that it is the only thing the
 *     coordinator started. It is the coordinator's statement and this module's
 *     precondition;
 *  2. the one-minute load average is below one core. This is the CHECK on the
 *     declaration — a declaration that is simply wrong is the worst of the
 *     three outcomes, because it produces a number that looks authoritative.
 *     The threshold is one core and not zero: the harness itself is a process.
 *
 * Neither alone is enough, and the asymmetry is deliberate: without the
 * declaration a quiet machine still yields no verdict, because "quiet right
 * now" is not "exclusive for the length of the run".
 */
export function exclusivity(env: NodeJS.ProcessEnv = process.env, os: { loadavg: () => number[]; cpus: () => unknown[] } = nodeOs): Exclusivity {
  const declared = env['DAFTAR_PERF_EXCLUSIVE'] ?? null;
  const loadAverage1m = os.loadavg()[0] ?? 0;
  const cpuCount = Math.max(1, os.cpus().length);
  const evidence = { declared, loadAverage1m, cpuCount };
  if (declared !== '1') return { verdict: 'resource_contention', reason: 'not_declared_exclusive', evidence };
  if (loadAverage1m >= 1) return { verdict: 'resource_contention', reason: 'load_average_above_one_core', evidence };
  return { verdict: 'exclusive', reason: null, evidence };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. THE DATASET THE RUN NEEDS — declared, not seeded
// ─────────────────────────────────────────────────────────────────────────

/** The scale multiplier, read from the environment exactly as `receivables-s4-dataset.ts:110` reads it. */
export const SCALE = ((): number => {
  const raw = process.env['DAFTAR_PERF_SCALE'];
  const n = raw === undefined ? 1 : Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

export const scaled = (n: number): number => Math.max(1, Math.round(n * SCALE));

/**
 * THE DATASET SHAPE, declared.
 *
 * `fatTail` is the arm that decides whether the keyset page is a page or a
 * walk, and the figures are chosen from the shape `0084` measured rather than
 * invented: 2 000 invoices of which the overwhelming majority are cash
 * settled, so they keep `status = 'open'`, report outstanding 0 by `0080`'s
 * law, and are permanently failing candidates for the debts page.
 *
 * `plans` is 120 instalments on the fat-tail customer's one credit invoice —
 * the bound, so the instalment page's control arm is measured at its ceiling
 * and not at a typical case.
 */
export const DATASET = {
  fatTail: {
    invoices: scaled(2_000),
    cashSettledShare: 0.95,
    statementEntries: scaled(6_000),
  },
  median: { customers: scaled(60), invoicesEach: 3, installmentsEach: 12 },
  plans: { longest: 120 },
} as const;

/** Every relation whose statistics decide a figure this harness reports. */
export const MEASURED_RELATIONS: readonly string[] = [
  'installment_plans',
  'installments',
  'invoices',
  'payments',
  'payment_allocations',
  'customer_credit_applications',
];

// ─────────────────────────────────────────────────────────────────────────
// 3. THE ANALYZE EVIDENCE — read back, never assumed
// ─────────────────────────────────────────────────────────────────────────

export interface AnalyzeEvidence {
  /** Per relation: the live row count and when it was last analyzed, from `pg_stat_user_tables`. */
  readonly relations: Readonly<Record<string, { rows: number; analyzed: string | null; existed: boolean }>>;
  /** The relations the harness asked `ANALYZE` for and that do not exist. A statement against nothing is not statistics. */
  readonly missing: readonly string[];
  /** The relations that exist and still carry no `last_analyze` / `last_autoanalyze`. */
  readonly unanalyzed: readonly string[];
  /** The dataset's size on disk, so a reader can see whether the figure was taken on something that fits in shared buffers. */
  readonly databaseBytes: number;
  readonly scale: number;
  /**
   * Whether a figure taken in this state may be called authoritative.
   *
   * False while ANY measured relation is missing or unanalyzed. This is the
   * one assertion that makes the recorded lesson operative rather than
   * remembered: a budget met against a relation with no statistics is a
   * number about the missing statistics.
   */
  readonly authoritative: boolean;
}

/** `ANALYZE` every measured relation that exists, then read the statistics BACK from the catalogue. */
export async function analyzeAndRecord(relations: readonly string[] = MEASURED_RELATIONS): Promise<AnalyzeEvidence> {
  const pool = ownerPool();
  const { rows: present } = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
    [[...relations]],
  );
  const existing = new Set(present.map((r) => r.relname));
  const missing = relations.filter((r) => !existing.has(r));
  for (const relation of relations) {
    if (!existing.has(relation)) continue;
    // The identifier is from this module's own frozen list, never from input.
    await pool.query(`ANALYZE public.${relation}`);
  }
  const { rows: stats } = await pool.query<{ relname: string; n_live_tup: string; last_analyze: Date | null; last_autoanalyze: Date | null }>(
    `SELECT relname, n_live_tup::text, last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = ANY($1::text[])`,
    [[...relations]],
  );
  const byName = new Map(stats.map((r) => [r.relname, r]));
  const out: Record<string, { rows: number; analyzed: string | null; existed: boolean }> = {};
  const unanalyzed: string[] = [];
  for (const relation of relations) {
    const row = byName.get(relation);
    const when = row?.last_analyze ?? row?.last_autoanalyze ?? null;
    out[relation] = {
      rows: row === undefined ? 0 : Number.parseInt(row.n_live_tup, 10),
      analyzed: when === null ? null : when.toISOString(),
      existed: existing.has(relation),
    };
    if (existing.has(relation) && when === null) unanalyzed.push(relation);
  }
  const { rows: size } = await pool.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size');
  return {
    relations: out,
    missing,
    unanalyzed,
    databaseBytes: Number.parseInt(size[0]?.size ?? '0', 10),
    scale: SCALE,
    authoritative: missing.length === 0 && unanalyzed.length === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. THE BUDGETS, AND THE MEASUREMENT
// ─────────────────────────────────────────────────────────────────────────

/**
 * The ceilings the contract pack states.
 *
 * Each is a `p95` over `ITERATIONS` warm runs, and each is stated with its
 * BUDGET ID so a report can name what it measured. They are the contract
 * pack's numbers and this module does not choose them: a harness that picks
 * its own ceiling is a harness that always passes.
 */
export const BUDGETS = {
  /** P4-S7-A — the instalment page of one plan, at the 120-instalment bound. The control arm. */
  INSTALLMENT_PAGE_P95_MS: 50,
  /** P4-S7-B — the customer statement keyset page, over the fat tail. The budget that matters. */
  STATEMENT_PAGE_P95_MS: 100,
  /** P4-S7-C — the customer debts keyset page, over the `0080` cash fat tail. */
  DEBTS_PAGE_P95_MS: 100,
  /** P4-S7-D — one plan projected, which is ONE `invoice_outstanding` call and must cost like one. */
  PLAN_PROJECTION_P95_MS: 50,
} as const;

/**
 * Two hundred measured iterations, the `SHORT_PERCENTILE_ITERATIONS` of the
 * accepted S4 harness.
 *
 * The number matters and is not a round guess: at n = 200 the `p95` is index
 * 189, so nineteen slow samples are needed to move it, and a single
 * contended sample cannot decide a verdict. At n = 30 the `p95` is index 28 —
 * two slow samples — which is how a figure comes to be reported as a
 * percentile while behaving like a maximum.
 */
export const ITERATIONS = 200;

/** A keyset continuation budget: the SECOND page must cost what the first cost. The property an OFFSET page does not have. */
export const KEYSET_DRIFT_MAX_RATIO = 1.5;

export interface Measurement {
  readonly budgetId: string;
  readonly name: string;
  readonly samplesMs: readonly number[];
  readonly thresholdMs: number;
}

/** `iterations` warm runs of `body`, after `warmups` discarded ones. Monotonic clock, never the wall clock. */
export async function measure(
  budgetId: string,
  name: string,
  thresholdMs: number,
  body: () => Promise<unknown>,
  iterations = ITERATIONS,
  warmups = 10,
): Promise<Measurement> {
  for (let i = 0; i < warmups; i += 1) await body();
  const samplesMs: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    await body();
    samplesMs.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { budgetId, name, samplesMs, thresholdMs };
}

/**
 * A short series is REFUSED, not reported as a lower percentile.
 *
 * «A percentile over fewer samples than claimed is not the claimed
 * percentile» (P4-AL-76). The accepted S4 harness asserts the same thing for
 * the same reason, and it is here rather than in the suite so a second suite
 * cannot forget it.
 */
export function assertSamples(m: Measurement, declared = ITERATIONS): void {
  if (m.samplesMs.length !== declared) {
    throw new Error(
      `${m.budgetId} — ${m.name}: ${String(m.samplesMs.length)} samples were taken and ${String(declared)} were declared; ` +
        `a percentile over fewer samples than claimed is not the claimed percentile`,
    );
  }
}

export interface Verdict {
  readonly budgetId: string;
  readonly name: string;
  readonly distribution: Distribution;
  /** `pass`, `fail`, or `resource_contention` — which is NEITHER, and is the only honest answer under load. */
  readonly verdict: 'pass' | 'fail' | 'resource_contention';
  readonly contention: ContentionReason;
  readonly analyze: AnalyzeEvidence;
}

/**
 * The verdict, WITH its preconditions.
 *
 * Three outcomes, not two. `resource_contention` is returned when the run was
 * not exclusive OR when the `ANALYZE` evidence does not support an
 * authoritative figure, and it is explicitly neither a pass nor a fail: a
 * figure taken under either condition says nothing about the query.
 *
 * That is the whole design. A two-outcome harness forces a contended run to
 * choose between a false green and a false red, and both are worse than "this
 * measurement is invalid".
 */
export function judge(m: Measurement, analyze: AnalyzeEvidence, ex: Exclusivity = exclusivity()): Verdict {
  const d = distribution(m.samplesMs, m.thresholdMs);
  if (ex.verdict === 'resource_contention')
    return { budgetId: m.budgetId, name: m.name, distribution: d, verdict: 'resource_contention', contention: ex.reason, analyze };
  if (!analyze.authoritative) {
    return { budgetId: m.budgetId, name: m.name, distribution: d, verdict: 'resource_contention', contention: 'not_declared_exclusive', analyze };
  }
  return { budgetId: m.budgetId, name: m.name, distribution: d, verdict: d.p95 <= m.thresholdMs ? 'pass' : 'fail', contention: null, analyze };
}

/**
 * The line a report carries for one budget.
 *
 * It names the `ANALYZE` state and the scale IN THE SAME SENTENCE as the
 * millisecond figure, because that is the only arrangement under which a
 * reader cannot quote the figure without the condition it was taken in.
 */
export function report(v: Verdict): string {
  const analyzed = Object.entries(v.analyze.relations)
    .map(([name, r]) => `${name}=${r.existed ? String(r.rows) : 'ABSENT'}${r.analyzed === null ? '/NOT-ANALYZED' : ''}`)
    .join(' ');
  return (
    `${v.budgetId} — ${v.name}: ${v.verdict.toUpperCase()}` +
    (v.contention === null ? '' : ` (${v.contention})`) +
    ` · p95 ${v.distribution.p95.toFixed(3)} ms against ${String(v.distribution.thresholdMs)} ms over ${String(v.distribution.iterations)} iterations` +
    ` · scale ${String(v.analyze.scale)} · db ${(v.analyze.databaseBytes / 1e6).toFixed(1)} MB` +
    ` · ANALYZEd: ${analyzed}` +
    (v.analyze.missing.length > 0 ? ` · MISSING RELATIONS: ${v.analyze.missing.join(', ')}` : '')
  );
}

/** The run's environment, for the header of any report: server version, collation, locale provider, and the exclusivity verdict. */
export async function runBanner(): Promise<string> {
  // The same adapter shape the estate's own budget suites use
  // (`tests/performance/receivables-s4-budgets.test.ts:845`): the generic is on
  // the CALLBACK, so each query names the row type it expects.
  const env = await readPlanEvidenceEnvironment(async <R>(sql: string) => ({ rows: (await ownerPool().query(sql)).rows as R[] }));
  const ex = exclusivity();
  return (
    `P4-S7 performance harness · ${ex.verdict}` +
    (ex.reason === null ? '' : ` (${ex.reason})`) +
    ` · load1m ${ex.evidence.loadAverage1m.toFixed(2)} on ${String(ex.evidence.cpuCount)} cpu` +
    ` · PostgreSQL ${String(env.serverVersionNum ?? 'unknown')} · collate ${String(env.datcollate ?? 'unknown')} · scale ${String(SCALE)}`
  );
}
