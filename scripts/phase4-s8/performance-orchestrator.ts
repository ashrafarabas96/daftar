#!/usr/bin/env tsx
/**
 * PHASE 4 — P4-S8 FRAMEWORK — THE PERFORMANCE ORCHESTRATOR
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ THIS MODULE DOES NOT RUN A BENCHMARK, AND REFUSES TO.                ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * An authoritative performance measurement requires EXCLUSIVE USE of the box:
 * no install, no build, no lint, no typecheck, no other tests, no other
 * agents, no database cleanup, no filesystem-heavy work. A figure taken while
 * five other agents are compiling TypeScript is not a slow figure — it is
 * NOT A MEASUREMENT. It is neither a pass nor a fail, and recording it as
 * either is worse than recording nothing, because the next reader cannot tell
 * which it was.
 *
 * So: this module BUILDS the orchestration. The coordinator runs it under an
 * exclusive box, by passing an explicit attestation. Without that attestation
 * `orchestrate` returns `INVALID — RESOURCE CONTENTION` and takes no timing
 * at all.
 *
 * ── THE RULES IT ENCODES ─────────────────────────────────────────────────
 *
 * `P4-AL-74` `[[daftar-a-benchmark-measures-what-the-planner-saw]]`: budget C
 * cost 2.9 s on a runner and 122 ms after one `ANALYZE`, with no query and no
 * migration change. A budget measured against a relation with no statistics is
 * a number about the missing statistics. So `planningStatistics` is recorded
 * per measurement and a NULL FAILS the suite — it is not defaulted, not
 * inferred, and not "probably fine".
 *
 * `P4-AL-75`: every budget is measured as `daftar_app` with the scope GUCs a
 * request sets, through the product's own query function. The `daftar_app`
 * figure IS the budget; the owner figure on the same database with the same
 * rows is recorded only as the RLS cost.
 *
 * `P4-AL-76`: a missed budget is a FAIL until diagnosed; the diagnosis
 * decides, never the number. Budgets run ALONE, on their own `PG_DIR`.
 *
 * `P4-AL-72`: every budget also carries a HOST-INDEPENDENT RATIO assertion,
 * because a millisecond encodes this host's speed while a ratio measured in
 * the same run on the same host encodes the QUERY'S SHAPE. The two
 * calibration-locked budgets are RED-CAPABLE FROM THE FIRST COMMIT precisely
 * because their ratio assertions are.
 *
 * ── THE IMMUTABLE THRESHOLDS ─────────────────────────────────────────────
 *
 * No threshold increase. No p95 → p90. No sample reduction. No outlier
 * deletion. No host multiplier. No cherry-picking runs. No hiding noisy
 * results. All seven are refused by `mutationProblems`, which compares a
 * proposed configuration against the constants below and names which rule it
 * breaks. `scripts/phase4-budget-ratchet.ts` holds the independent accepted
 * copy and refuses any increase; this module does not duplicate its
 * constants, it DELEGATES to it, because two copies of a ceiling is how a
 * ceiling comes to disagree with itself.
 */

/** The eight budgets plus the reconciliation total (`P4-AL-71`). */
export interface Budget {
  readonly id: string;
  readonly measure: string;
  /** The ceiling in milliseconds, or null when the budget is calibration-locked. */
  readonly ceilingMs: number | null;
  /** A calibration-locked budget's hard PRODUCT cap, which is never a ceiling obtained by measurement. */
  readonly hardCapMs: number | null;
  readonly percentile: 95;
  readonly anchor: string;
  /** The host-independent ratio assertion. Every budget has one (`P4-AL-72`). */
  readonly ratio: string;
  /** The narrow plan assertions. Properties of the query, never "the planner must choose X forever". */
  readonly planAssertions: readonly string[];
  readonly owedBy: string;
}

export const BUDGETS: readonly Budget[] = [
  {
    id: 'P4-A',
    measure: 'POS search: one 50-row page by name/SKU/barcode prefix, over HTTP',
    ceilingMs: 150,
    hardCapMs: null,
    percentile: 95,
    anchor: 'the accepted P3-S7 stock page, identical shape, volume and principal (phase3-s7-read-budgets.test.ts:56)',
    ratio: 'p95(page 20) <= 1.2 x p95(page 1)',
    planAssertions: [
      'index reach on the prefix predicate',
      'no sequential scan on the large relations',
      'no OFFSET',
      'no per-row correlated subplan from a policy',
    ],
    owedBy: 'P4-S3',
  },
  {
    id: 'P4-B',
    measure: 'server-side cart recomputation, 20 lines with discounts and tax',
    ceilingMs: 60,
    hardCapMs: null,
    percentile: 95,
    anchor: 'Budget B, the small-work endpoint end to end (accounting-budgets.test.ts:57)',
    ratio: 'p95(40 lines) <= 2.2 x p95(20 lines)',
    planAssertions: ['a statement count independent of the row count'],
    owedBy: 'P4-S3',
  },
  {
    id: 'P4-C',
    measure: 'sale commit: 10-line cash sale, invoice + lines + 10 movements + the journal',
    ceilingMs: null,
    hardCapMs: 1000,
    percentile: 95,
    anchor: 'composed from Budget B + Budget A + the measured per-movement cost; the cap is a PRODUCT statement (OD-P4-13)',
    ratio: 'p95(20 lines) <= 2.0 x p95(10 lines)',
    planAssertions: ['exactly ONE transaction for the sale', 'no per-row correlated subplan from a policy'],
    owedBy: 'P4-S2',
  },
  {
    id: 'P4-D',
    measure: 'customer balance as of a date, the fat-tail customer',
    ceilingMs: 100,
    hardCapMs: null,
    percentile: 95,
    anchor: 'Budget E, account balance as-of, 100 000-line class (accounting-budgets.test.ts:63)',
    ratio: 'p95(fat-tail) <= 3 x p95(median)',
    planAssertions: ['index reach', 'no sequential scan on the large relations'],
    owedBy: 'P4-S4',
  },
  {
    id: 'P4-E',
    measure: 'statement: one 50-row keyset page over a date range, with opening balance',
    ceilingMs: 150,
    hardCapMs: null,
    percentile: 95,
    anchor: 'Budget D, the general-ledger keyset page (accounting-budgets.test.ts:61)',
    ratio: 'p95(page 20) <= 1.2 x p95(page 1)',
    planAssertions: ['no OFFSET', 'index reach on the keyset predicate'],
    owedBy: 'P4-S7',
  },
  {
    id: 'P4-F',
    measure: 'payment allocation over 5 invoices, in-transaction and over HTTP',
    ceilingMs: 100,
    hardCapMs: null,
    percentile: 95,
    anchor: 'Budget A for the journal half; the per-invoice constant is calibration-derived (OD-P4-14)',
    ratio: 'p95(5 invoices) <= 3 x p95(1 invoice)',
    planAssertions: ['ONE journal entry for a whole allocation', 'a statement count independent of the invoice count'],
    owedBy: 'P4-S4',
  },
  {
    id: 'P4-G',
    measure: 'return + refund: a 4-line return, its credit note, its inventory entry and the refund',
    ceilingMs: null,
    hardCapMs: 1000,
    percentile: 95,
    anchor: 'composed: Budget A x 3 + 4 movements + the HTTP envelope',
    ratio: 'p95(8 lines) <= 2.0 x p95(4 lines)',
    planAssertions: ['exactly ONE transaction for the return', 'the cap check inside the source FOR UPDATE'],
    owedBy: 'P4-S5',
  },
  {
    id: 'P4-H',
    measure: 'installment schedule read: a 24-instalment plan with derived status as of a date',
    ceilingMs: 50,
    hardCapMs: null,
    percentile: 95,
    anchor: 'the accepted P3-S7 return-options read (phase3-s7-read-budgets.test.ts:58)',
    ratio: 'p95(24 instalments) <= 2 x p95(12 instalments)',
    planAssertions: ['no reference to the machine clock in the derivation', 'index reach'],
    owedBy: 'P4-S7',
  },
  {
    id: 'P4-R',
    measure: 'one full R-SAL-* + R-INV-* pass over the ~1 000 000-line business',
    ceilingMs: null,
    hardCapMs: 300_000,
    percentile: 95,
    anchor: "Budget F's 300 s covers the PHASE 2 checks only; Phase 4 adds seven R-SAL and five R-INV over a second million-row relation (OD-P4-13)",
    ratio: 'p95(two businesses) <= 2.2 x p95(one business)',
    planAssertions: ['one pass per relation, never per row', 'no sequential scan on the large relations'],
    owedBy: 'P4-S8',
  },
];

/** `P4-AL-73`: Tier 1 runs at 0.1 scale with the SAME ceilings. A weaker claim, never a weaker ceiling. */
export const TIERS: readonly { readonly id: 1 | 2; readonly scale: number; readonly where: string }[] = [
  { id: 1, scale: 0.1, where: 'inside gate:phase4:s8, a separate step AFTER the functional suites, on its own PG_DIR, with nothing else on the box' },
  { id: 2, scale: 1.0, where: 'the dispatched evidence workflow, at an exact SHA' },
];

/**
 * THE EXCLUSIVE BOX ATTESTATION.
 *
 * Every field is something the ATTESTER asserts about the machine, not
 * something this module can measure. That asymmetry is deliberate: a process
 * cannot prove it is alone on a box, and a check that pretended to would be
 * the fake PASS in a new costume. What the module CAN do is refuse to measure
 * without the attestation, and record the attestation beside every figure so a
 * reader knows exactly whose word the number rests on.
 */
export interface ExclusiveBoxAttestation {
  /** Who attests. A figure with no attester is an anonymous number. */
  readonly attestedBy: string;
  /** ISO instant of the attestation. */
  readonly attestedAt: string;
  readonly noOtherAgentsRunning: boolean;
  readonly noInstallBuildLintOrTypecheck: boolean;
  readonly noOtherTestsRunning: boolean;
  readonly noDatabaseCleanupOrFilesystemWork: boolean;
  /** The budgets' own `PG_DIR`, which must not be a shared one. */
  readonly dedicatedPgDir: string;
  /** Every measured relation `ANALYZE`d before the first timing (`P4-AL-74`). */
  readonly analyzePerformed: boolean;
}

export type OrchestrationVerdict = 'READY' | 'INVALID_RESOURCE_CONTENTION' | 'REFUSED_PLAN';

export interface OrchestrationPlan {
  readonly verdict: OrchestrationVerdict;
  /** Present only on `READY`. The ordered steps the coordinator runs. */
  readonly steps: readonly string[];
  /** Why not, when the verdict is not `READY`. */
  readonly reasons: readonly string[];
  /** Repeated on every verdict, so a reader always knows what was claimed. */
  readonly attestation: ExclusiveBoxAttestation | null;
}

const SHARED_PG_DIRS: readonly string[] = ['/tmp/daftar-pg-shared'];

/**
 * BUILD the measurement plan. Never measure.
 *
 * Returns `INVALID_RESOURCE_CONTENTION` — the exact words — when the box is
 * not attested exclusive. A caller that measured anyway would be producing a
 * figure that is neither a pass nor a fail, and this verdict is the name for
 * that state so it can be recorded rather than rounded to one of the two.
 */
export function orchestrate(attestation: ExclusiveBoxAttestation | null, tier: 1 | 2, budgets: readonly Budget[] = BUDGETS): OrchestrationPlan {
  const planProblems = budgetPlanProblems(budgets);
  if (planProblems.length > 0) return { verdict: 'REFUSED_PLAN', steps: [], reasons: planProblems, attestation };

  const reasons: string[] = [];
  if (attestation === null)
    reasons.push('INVALID — RESOURCE CONTENTION: no exclusive-box attestation was supplied, so no figure taken here is a measurement of anything');
  else {
    if (attestation.attestedBy.trim() === '') reasons.push('INVALID — RESOURCE CONTENTION: the attestation names no attester');
    if (!attestation.noOtherAgentsRunning) reasons.push('INVALID — RESOURCE CONTENTION: other agents are running on this box');
    if (!attestation.noInstallBuildLintOrTypecheck) reasons.push('INVALID — RESOURCE CONTENTION: an install, build, lint or typecheck is running');
    if (!attestation.noOtherTestsRunning) reasons.push('INVALID — RESOURCE CONTENTION: another test run is in progress');
    if (!attestation.noDatabaseCleanupOrFilesystemWork) reasons.push('INVALID — RESOURCE CONTENTION: database cleanup or filesystem-heavy work is in progress');
    if (SHARED_PG_DIRS.includes(attestation.dedicatedPgDir))
      reasons.push(
        `INVALID — RESOURCE CONTENTION: ${attestation.dedicatedPgDir} is the SHARED data directory, so the budgets would share a cluster with the functional suites (P4-AL-76)`,
      );
    if (attestation.dedicatedPgDir.trim() === '') reasons.push('INVALID — RESOURCE CONTENTION: no dedicated PG_DIR was named');
    if (!attestation.analyzePerformed)
      reasons.push(
        'INVALID — RESOURCE CONTENTION: no ANALYZE was performed, so every figure would be a number about the MISSING STATISTICS ' +
          '(budget C: 2.9 s on a runner, 122 ms after one ANALYZE, same query) — P4-AL-74',
      );
  }
  if (reasons.length > 0) return { verdict: 'INVALID_RESOURCE_CONTENTION', steps: [], reasons, attestation };

  const scale = TIERS.find((t) => t.id === tier)?.scale ?? 1;
  return {
    verdict: 'READY',
    steps: [
      'run the runner canary FIRST and refuse the matrix if the runner cannot report failure',
      `build D-SALES at P4_PERF_SCALE = ${scale.toString()} through the REAL commands, and ASSERT THE REALIZED VOLUME before taking any timing (P4-AL-73)`,
      'ANALYZE every measured relation, and record planningStatistics per measurement; a NULL fails the suite (P4-AL-74)',
      'measure as daftar_app with the scope GUCs a request sets, through the product own query function (P4-AL-75)',
      'measure the SAME queries as the owner on the SAME database with the SAME rows, and record the difference as the RLS COST only (P4-AL-75)',
      'keep EVERY sample, in order; fail if a sample count is below the declared iterations (P4-AL-76)',
      'assert the host-independent RATIO for every budget, in the same run on the same host (P4-AL-72)',
      'assert the narrow plan properties; never assert that the planner chooses a named algorithm',
      'run scripts/phase4-budget-ratchet.ts and require it to refuse every increase',
      'emit the evidence with the attestation attached to every figure',
    ],
    reasons: [],
    attestation,
  };
}

/** The seven forbidden mutations, refused by comparison against the declared plan. */
export interface ProposedChange {
  readonly budgetId: string;
  readonly ceilingMs?: number;
  readonly percentile?: number;
  readonly iterations?: number;
  readonly dropOutliers?: boolean;
  readonly hostMultiplier?: number;
  readonly keepBestRunOnly?: boolean;
  readonly suppressNoisyResults?: boolean;
}

export const DECLARED_ITERATIONS = 30;

export function mutationProblems(change: ProposedChange, budgets: readonly Budget[] = BUDGETS): string[] {
  const problems: string[] = [];
  const budget = budgets.find((b) => b.id === change.budgetId);
  if (budget === undefined) return [`${change.budgetId}: no such budget`];
  if (change.ceilingMs !== undefined && budget.ceilingMs !== null && change.ceilingMs > budget.ceilingMs)
    problems.push(
      `${budget.id}: a ceiling increase from ${budget.ceilingMs.toString()} ms to ${change.ceilingMs.toString()} ms — no threshold is relaxed to obtain a PASS (P4-AL-76)`,
    );
  if (change.percentile !== undefined && change.percentile !== budget.percentile)
    problems.push(
      `${budget.id}: p${budget.percentile.toString()} -> p${change.percentile.toString()} — changing the percentile is a threshold relaxation wearing a statistic's clothes`,
    );
  if (change.iterations !== undefined && change.iterations < DECLARED_ITERATIONS)
    problems.push(
      `${budget.id}: ${change.iterations.toString()} iterations against the declared ${DECLARED_ITERATIONS.toString()} — a reduced sample is a reduced claim, and the gate fails below the declared count`,
    );
  if (change.dropOutliers === true) problems.push(`${budget.id}: deleting outliers — every sample is kept, in order; the slow one is the finding`);
  if (change.hostMultiplier !== undefined)
    problems.push(
      `${budget.id}: a host multiplier of ${change.hostMultiplier.toString()} — a ceiling scaled by the machine is not a ceiling; that is what the RATIO assertion is for`,
    );
  if (change.keepBestRunOnly === true) problems.push(`${budget.id}: cherry-picking the best run — the run is the measurement, not the best of several`);
  if (change.suppressNoisyResults === true)
    problems.push(`${budget.id}: hiding noisy results — a noisy result is a diagnosis to be made, never a figure to be omitted`);
  return problems;
}

/** The plan's own laws: every budget anchored, every budget with a ratio, nothing guessed. */
/**
 * THE THRESHOLDS, WRITTEN DOWN A SECOND TIME, INDEPENDENTLY.
 *
 * `mutationProblems` refuses a PROPOSED change, which only helps when somebody
 * proposes one. A ceiling edited directly in `BUDGETS` would have been
 * accepted by every law in this module — the first version of
 * `budgetPlanProblems` accepted a table whose every ceiling had been DOUBLED,
 * which `tests/guards/p4s89-framework-laws.test.ts` found by asking.
 *
 * So the numbers live here as well, and `budgetPlanProblems` compares the
 * table against them. The honest weakness, recorded rather than claimed away:
 * one commit could change both. `scripts/phase4-budget-ratchet.ts` keeps a
 * third independent copy for the same reason and with the same weakness. Two
 * places to change is not a lock; it is a thing a reviewer can see.
 */
// `percentile` is `number` and NOT the literal `95` on purpose. With both
// sides literal, `budget.percentile !== declared.percentile` narrows to
// `never` and the comparison is compiled away — a threshold check that the
// type system had quietly deleted. The widened type keeps the comparison real.
export const DECLARED_THRESHOLDS: Readonly<
  Record<string, { readonly ceilingMs: number | null; readonly hardCapMs: number | null; readonly percentile: number }>
> = {
  'P4-A': { ceilingMs: 150, hardCapMs: null, percentile: 95 },
  'P4-B': { ceilingMs: 60, hardCapMs: null, percentile: 95 },
  'P4-C': { ceilingMs: null, hardCapMs: 1000, percentile: 95 },
  'P4-D': { ceilingMs: 100, hardCapMs: null, percentile: 95 },
  'P4-E': { ceilingMs: 150, hardCapMs: null, percentile: 95 },
  'P4-F': { ceilingMs: 100, hardCapMs: null, percentile: 95 },
  'P4-G': { ceilingMs: null, hardCapMs: 1000, percentile: 95 },
  'P4-H': { ceilingMs: 50, hardCapMs: null, percentile: 95 },
  'P4-R': { ceilingMs: null, hardCapMs: 300000, percentile: 95 },
};

export function budgetPlanProblems(budgets: readonly Budget[] = BUDGETS): string[] {
  const problems: string[] = [];
  if (budgets.length === 0) problems.push('no budget is declared — zero budgets met is not every budget met');
  // A budget DELETED from the table is the cheapest way to make it stop
  // failing, so every declared threshold must still be present.
  for (const id of Object.keys(DECLARED_THRESHOLDS))
    if (!budgets.some((b) => b.id === id))
      problems.push(`${id} is a declared budget and is absent from this table — a deleted budget is a threshold removed, never a threshold met`);
  for (const budget of budgets) {
    const declared = DECLARED_THRESHOLDS[budget.id];
    if (declared === undefined) problems.push(`${budget.id}: not one of the declared budgets, so no immutable threshold governs it`);
    else {
      if (budget.ceilingMs !== declared.ceilingMs)
        problems.push(
          `${budget.id}: the ceiling is ${budget.ceilingMs === null ? 'null' : `${budget.ceilingMs.toString()} ms`} and the declared immutable ceiling is ` +
            `${declared.ceilingMs === null ? 'null' : `${declared.ceilingMs.toString()} ms`} — no threshold is relaxed to obtain a PASS (P4-AL-76)`,
        );
      if (budget.hardCapMs !== declared.hardCapMs)
        problems.push(
          `${budget.id}: the hard cap is ${budget.hardCapMs === null ? 'null' : `${budget.hardCapMs.toString()} ms`} and the declared immutable hard cap is ` +
            `${declared.hardCapMs === null ? 'null' : `${declared.hardCapMs.toString()} ms`}`,
        );
      if (budget.percentile !== declared.percentile)
        problems.push(
          `${budget.id}: p${budget.percentile.toString()} against the declared p${declared.percentile.toString()} — changing the percentile is a threshold relaxation wearing a statistic's clothes`,
        );
    }
    if (budget.ceilingMs === null && budget.hardCapMs === null)
      problems.push(`${budget.id}: neither a ceiling nor a calibration hard cap — a budget with no number is not a budget`);
    if (budget.ceilingMs !== null && budget.hardCapMs !== null)
      problems.push(`${budget.id}: carries BOTH a ceiling and a hard cap, so which one decides is ambiguous and the looser one will win an argument`);
    if (budget.anchor.trim() === '') problems.push(`${budget.id}: no anchor — a ceiling with no anchor is a guess (P4-AL-71)`);
    if (budget.ratio.trim() === '')
      problems.push(
        `${budget.id}: no host-independent ratio assertion, so on a slow host it has NO way to be red and on a fast host no way to be meaningful (P4-AL-72)`,
      );
    if (budget.planAssertions.length === 0) problems.push(`${budget.id}: no plan assertion — a millisecond with no plan claim says nothing about the query`);
    for (const assertion of budget.planAssertions)
      if (/must choose|always use|force(?:s)? the planner/i.test(assertion))
        problems.push(`${budget.id}: the plan assertion ${JSON.stringify(assertion)} pins the planner's choice rather than a property of the query (P4-AL-72)`);
  }
  return problems;
}
