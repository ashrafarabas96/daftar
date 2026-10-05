#!/usr/bin/env tsx
/**
 * THE PHASE 4 BUDGET RATCHET — `npm run check:budget-ratchet`
 *
 * `docs/PHASE_4_ARCHITECTURE_LOCK.md` P4-AL-76 says, in the present tense,
 * that «`scripts/phase4-budget-ratchet.ts` holds an independent accepted copy
 * of every constant and refuses any increase». It did not exist. A lock that
 * describes a mechanism the tree does not carry is worse than one that asks
 * for it, because a reviewer reads the sentence and stops looking — and the
 * one thing this sentence promises is the structural expression of "no
 * threshold relaxed to obtain PASS", which is the whole of `OD-P4-14`'s
 * tighten-only ruling.
 *
 * ── WHAT A RATCHET CAN AND CANNOT DO ──────────────────────────────────────
 *
 * It cannot stop a commit that edits every copy of a number at once. The lock
 * records that weakness honestly in §20 and this file does not claim it away.
 * What it CAN do, and does, is make a loosening impossible to perform
 * *quietly*:
 *
 *   1. ONE SOURCE FOR THE SUITES. `tests/performance/receivables-s4-budgets.test.ts`
 *      imports its ceilings from `ACCEPTED` here rather than typing them, so a
 *      suite cannot be made to pass by editing a literal beside the assertion
 *      that reads it.
 *   2. THE CODE IS CHECKED AGAINST THE LOCK'S OWN TABLE. `lockProblems`
 *      PARSES the P4-AL-71 table out of `docs/PHASE_4_ARCHITECTURE_LOCK.md`
 *      and requires every ceiling here to equal the ceiling there. Raising a
 *      ceiling therefore takes an edit to a Tech-Lead document in the same
 *      diff; it is never a one-line change in a test.
 *   3. TIGHTEN-ONLY IS A FUNCTION, AND IT IS RED-PROVED.
 *      `tightenOnlyProblems(accepted, proposed)` refuses any proposal whose
 *      ceiling exceeds the accepted one, and
 *      `tests/guards/p4s4-budget-ratchet-law.test.ts` plants a loosening of
 *      every single constant and requires a finding for each.
 *
 * ── THE CALIBRATION-DERIVED CONSTANTS (`OD-P4-14`, TECH LEAD 2026-09-30) ──
 *
 * «The allocation scaling constant and the RLS cost thresholds are
 *  calibration-derived and tighten-only. The `3×` figure stays provisional
 *  until a real Tier-2 measurement replaces it.»
 *
 * So the two ratio constants carry `provisional: true` and the measurement
 * that will replace them is NAMED. A provisional constant is still a LAW —
 * `3×` is asserted, and a measured ratio above it is a FAIL to be diagnosed
 * (P4-AL-75) — it is simply a law whose number is owed a better anchor. What
 * `provisional` must never come to mean is "may be raised when it is
 * inconvenient": `tightenOnlyProblems` makes no exception for it.
 *
 * ── WHY THE HARD CAPS AND THE CALIBRATED CEILINGS ARE SEPARATE FIELDS ─────
 *
 * TL ruling 2026-09-30 (A + C) on `OD-P4-13`: the effective ceiling is
 * `min(hard product cap, accepted calibrated ceiling)`. Collapsing them into
 * one number loses the distinction that makes a calibration result readable —
 * a calibration landing ABOVE the cap is a fail to be diagnosed, not a
 * ceiling to be written — so `effectiveCeilingMs` computes the minimum and
 * `calibrationProblems` refuses a calibrated value above its own cap.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** This file, relative to a repository root. */
export const SELF = 'scripts/phase4-budget-ratchet.ts';

export const LOCK_REL = 'docs/PHASE_4_ARCHITECTURE_LOCK.md';

/**
 * ONE BUDGET'S ACCEPTED CEILING.
 *
 * `hardCapMs` is the product statement: the number the lock's P4-AL-71 table
 * carries, which no measurement may exceed and no calibration may raise.
 * `calibratedCeilingMs` is the tighter, calibration-derived ceiling when one
 * has been accepted, and `null` while it has not — `null` means "the hard cap
 * is the operative ceiling today", never "unbounded".
 */
export interface Budget {
  readonly id: string;
  /** The lock's own wording of what is measured, so a reader need not hold two documents open. */
  readonly measure: string;
  readonly hardCapMs: number;
  readonly calibratedCeilingMs: number | null;
  /** True for the rows the lock marks **calibration-locked**. */
  readonly calibrationLocked: boolean;
}

/**
 * THE ACCEPTED COPY, transcribed from the P4-AL-71 table and checked against
 * it by `lockProblems` on every run.
 *
 * P4-F is two ceilings on one operation, so it is two rows: a budget is a
 * (measure, ceiling) pair and a row holding two numbers could not be
 * ratcheted without deciding which of them `>` meant.
 */
export const ACCEPTED = {
  'P4-A': {
    id: 'P4-A',
    measure: 'POS search: one 50-row page by name/SKU/barcode prefix, over HTTP',
    hardCapMs: 150,
    calibratedCeilingMs: null,
    calibrationLocked: false,
  },
  'P4-B': {
    id: 'P4-B',
    measure: 'server-side cart recomputation, 20 lines with discounts and tax',
    hardCapMs: 60,
    calibratedCeilingMs: null,
    calibrationLocked: false,
  },
  'P4-C': {
    id: 'P4-C',
    measure: 'sale commit: 10-line cash sale, invoice + lines + 10 movements + the journal',
    hardCapMs: 1_000,
    calibratedCeilingMs: null,
    calibrationLocked: true,
  },
  'P4-D': { id: 'P4-D', measure: 'customer balance as of a date, the fat-tail customer', hardCapMs: 100, calibratedCeilingMs: null, calibrationLocked: false },
  'P4-E': {
    id: 'P4-E',
    measure: 'statement: one 50-row keyset page over a date range, with opening balance',
    hardCapMs: 150,
    calibratedCeilingMs: null,
    calibrationLocked: false,
  },
  /** P4-F, the in-transaction half: the allocation command inside one open transaction. */
  'P4-F-TXN': {
    id: 'P4-F-TXN',
    measure: 'payment allocation over 5 invoices, in-transaction',
    hardCapMs: 40,
    calibratedCeilingMs: null,
    calibrationLocked: false,
  },
  /** P4-F, the HTTP half: the same allocation end to end through the route. */
  'P4-F-HTTP': {
    id: 'P4-F-HTTP',
    measure: 'payment allocation over 5 invoices, over HTTP',
    hardCapMs: 100,
    calibratedCeilingMs: null,
    calibrationLocked: false,
  },
  'P4-G': {
    id: 'P4-G',
    measure: 'return + refund: a 4-line return, its credit note, its inventory entry and the refund',
    hardCapMs: 1_000,
    calibratedCeilingMs: null,
    calibrationLocked: true,
  },
  'P4-H': {
    id: 'P4-H',
    measure: 'installment schedule read: a 24-instalment plan with derived status as of a date',
    hardCapMs: 50,
    calibratedCeilingMs: null,
    calibrationLocked: false,
  },
  'P4-R': {
    id: 'P4-R',
    measure: 'one full R-SAL-* + R-INV-* pass over the ≈1 000 000-line business',
    hardCapMs: 300_000,
    calibratedCeilingMs: null,
    calibrationLocked: true,
  },
} as const satisfies Readonly<Record<string, Budget>>;

/**
 * THE HOST-INDEPENDENT RATIOS (P4-AL-72), AND THE RLS COST RATIO (P4-AL-75).
 *
 * A millisecond encodes the host's speed; a ratio measured in the same run on
 * the same host encodes the query's shape. These are the constants `OD-P4-14`
 * makes calibration-derived and tighten-only, and the two the Tech Lead's
 * ruling marks provisional carry `provisional: true` with the measurement that
 * is owed to replace them.
 */
export interface Ratio {
  readonly id: string;
  readonly measure: string;
  readonly max: number;
  readonly provisional: boolean;
  /** What must be measured before the number stops being provisional. Empty when it is not. */
  readonly anchorOwed: string;
}

export const RATIOS = {
  /** P4-AL-72: `p95(5 invoices) ≤ 3 × p95(1)` — the allocation scaling constant of `OD-P4-14`. */
  ALLOCATION_5_OVER_1: {
    id: 'ALLOCATION_5_OVER_1',
    measure: 'p95(5 invoices) <= 3 x p95(1) for the payment allocation',
    max: 3,
    provisional: true,
    anchorOwed: 'the first Tier-2 run of P4-F at the D-SALES acceptance volume (OD-P4-14, TL 2026-09-30 OPTION A)',
  },
  /** P4-AL-72: `p95(fat-tail) ≤ 3 × p95(median)` for the balance read. */
  BALANCE_FATTAIL_OVER_MEDIAN: {
    id: 'BALANCE_FATTAIL_OVER_MEDIAN',
    measure: 'p95(fat-tail customer) <= 3 x p95(median customer) for the balance read',
    max: 3,
    provisional: false,
    anchorOwed: '',
  },
  /** P4-AL-75: a cost ratio above 3x is FAIL-until-diagnosed; the 3x has no measured anchor in the tree. */
  RLS_COST: {
    id: 'RLS_COST',
    measure: 'p95(daftar_app, row security applied) <= 3 x p95(schema owner, row security bypassed)',
    max: 3,
    provisional: true,
    anchorOwed: "the first Tier-2 run's measured RLS ratios (OD-P4-14, TL 2026-09-30 OPTION A; P4-AL-75 records 3x as provisional)",
  },
} as const satisfies Readonly<Record<string, Ratio>>;

/**
 * `min(hard product cap, accepted calibrated ceiling)` — TL ruling 2026-09-30
 * (A + C) on `OD-P4-13`, applied to every row rather than only to the two it
 * was issued about, because the rule it states is general: a calibration may
 * tighten a ceiling and may never raise one.
 */
export function effectiveCeilingMs(b: Budget): number {
  return b.calibratedCeilingMs === null ? b.hardCapMs : Math.min(b.hardCapMs, b.calibratedCeilingMs);
}

/**
 * THE RATCHET. Every finding is a LOOSENING of something already accepted.
 *
 * Pure, and over two records rather than over the module's own state, so the
 * planted-defect proof can hand it a loosened copy without touching the tree.
 * A proposal that omits an accepted id is also a finding: deleting a budget is
 * the cheapest possible way to stop failing it.
 */
export function tightenOnlyProblems(
  accepted: Readonly<Record<string, Budget>>,
  proposed: Readonly<Record<string, Budget>>,
  acceptedRatios: Readonly<Record<string, Ratio>> = RATIOS,
  proposedRatios: Readonly<Record<string, Ratio>> = RATIOS,
): string[] {
  const problems: string[] = [];
  for (const [id, was] of Object.entries(accepted)) {
    const now = proposed[id];
    if (now === undefined) {
      problems.push(`${id} was accepted and is no longer in the ratchet — a deleted budget is a budget nothing can fail`);
      continue;
    }
    if (now.hardCapMs > was.hardCapMs)
      problems.push(`${id}: the hard cap rose from ${was.hardCapMs} ms to ${now.hardCapMs} ms — the ratchet is tighten-only (OD-P4-14, P4-AL-76)`);
    const wasEffective = effectiveCeilingMs(was);
    const nowEffective = effectiveCeilingMs(now);
    if (nowEffective > wasEffective)
      problems.push(
        `${id}: the effective ceiling rose from ${wasEffective} ms to ${nowEffective} ms — min(hard cap, calibrated) may only ever fall (OD-P4-13 A+C, OD-P4-14); the ratchet is tighten-only`,
      );
    if (now.calibratedCeilingMs !== null && now.calibratedCeilingMs > now.hardCapMs)
      problems.push(
        `${id}: the calibrated ceiling ${now.calibratedCeilingMs} ms is above the hard product cap ${now.hardCapMs} ms — a calibration landing above the cap is a FAIL to be diagnosed, not a ceiling to be written (OD-P4-13); tighten-only`,
      );
  }
  for (const [id, was] of Object.entries(acceptedRatios)) {
    const now = proposedRatios[id];
    if (now === undefined) {
      problems.push(`${id} was an accepted ratio and is no longer in the ratchet — a deleted ratio is a ratio nothing can fail`);
      continue;
    }
    if (now.max > was.max)
      problems.push(
        `${id}: the ratio ceiling rose from ${was.max}x to ${now.max}x — the calibration-derived constants are tighten-only (OD-P4-14, TL 2026-09-30 OPTION A)` +
          `${was.provisional ? '. Provisional is NOT a licence to raise: the ruling makes it calibration-derived AND tighten-only' : ''}`,
      );
    if (now.provisional && now.anchorOwed.trim() === '')
      problems.push(`${id} is marked provisional and names no owed anchor — a provisional number with no measurement owed is a guess with a label`);
  }
  return problems;
}

/**
 * The characters a thousands separator can be, named as ESCAPES rather than
 * typed.
 *
 * The lock writes `1 000 ms` with an ordinary space today. A separator is
 * exactly the character an editor silently swaps for a non-breaking or a
 * narrow one, so all four spellings are accepted — and spelling them as
 * escapes is what lets `no-irregular-whitespace` read this file at all.
 */
const SEPARATORS = '\\u0020\\u00a0\\u202f\\u2009';

/**
 * THE LOCK'S OWN TABLE, PARSED.
 *
 * The ceilings in this file are an INDEPENDENT copy, and a copy nobody
 * compares is a second truth. The P4-AL-71 table is the accepted one, so it is
 * read and the two are required to agree — which is what makes raising a
 * ceiling a visible edit to a Tech-Lead document rather than a literal in a
 * test.
 *
 * The parse is deliberately narrow and LOUD. `p95 ≤ 150 ms`,
 * `≤ 40 ms / ≤ 100 ms` and `total ≤ 300 s` are the three shapes the table
 * uses; a row whose ceiling cell matches none of them yields an EMPTY list,
 * which `lockProblems` reports as a finding rather than skipping the row.
 */
export function lockCeilings(lockText: string): Map<string, number[]> {
  const ceiling = new RegExp(`≤\\s*([\\d${SEPARATORS}]+?)\\s*(ms|s)\\b`, 'g');
  const separators = new RegExp(`[${SEPARATORS}]`, 'g');
  const out = new Map<string, number[]>();
  for (const line of lockText.split('\n')) {
    const m = /^\|\s*(P4-[A-Z])\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (m === null) continue;
    const cell = (m[3] ?? '').replace(/\*/g, '');
    const ms = [...cell.matchAll(ceiling)].map((n) => {
      const value = Number.parseFloat((n[1] ?? '').replace(separators, ''));
      return n[2] === 's' ? value * 1_000 : value;
    });
    out.set(m[1] ?? '', ms);
  }
  return out;
}

/** The budget ids this file holds that the lock's table carries under one row (P4-F is two). */
const LOCK_ROW_OF: Readonly<Record<string, string>> = {
  'P4-A': 'P4-A',
  'P4-B': 'P4-B',
  'P4-C': 'P4-C',
  'P4-D': 'P4-D',
  'P4-E': 'P4-E',
  'P4-F-TXN': 'P4-F',
  'P4-F-HTTP': 'P4-F',
  'P4-G': 'P4-G',
  'P4-H': 'P4-H',
  'P4-R': 'P4-R',
};

export function lockProblems(root: string, accepted: Readonly<Record<string, Budget>> = ACCEPTED): string[] {
  const path = join(root, LOCK_REL);
  if (!existsSync(path)) return [`${LOCK_REL} is missing — the accepted ceilings cannot be checked against anything`];
  const table = lockCeilings(readFileSync(path, 'utf8'));
  const problems: string[] = [];
  for (const row of new Set(Object.values(LOCK_ROW_OF))) {
    const cell = table.get(row);
    if (cell === undefined)
      problems.push(`${LOCK_REL}: the P4-AL-71 table has no ${row} row — the ratchet holds a ceiling for a budget the lock does not state`);
    else if (cell.length === 0)
      problems.push(
        `${LOCK_REL}: the ${row} ceiling cell matched none of the table's three shapes (\`p95 ≤ N ms\`, \`≤ N ms / ≤ N ms\`, \`total ≤ N s\`) — read it rather than skip it`,
      );
  }
  for (const [id, b] of Object.entries(accepted)) {
    const row = LOCK_ROW_OF[id];
    const cell = row === undefined ? undefined : table.get(row);
    if (cell === undefined || cell.length === 0) continue; // already reported above
    if (!cell.includes(b.hardCapMs))
      problems.push(
        `${id}: the ratchet holds ${b.hardCapMs} ms and the ${LOCK_REL} ${row} row states ${cell.join(' / ')} ms — the independent copies disagree, so one of them is wrong`,
      );
  }
  return problems;
}

/** A calibrated ceiling above its own hard cap, independent of any proposal: the state of the tree today. */
export function calibrationProblems(accepted: Readonly<Record<string, Budget>> = ACCEPTED): string[] {
  return Object.values(accepted)
    .filter((b) => b.calibratedCeilingMs !== null && b.calibratedCeilingMs > b.hardCapMs)
    .map((b) => `${b.id}: calibrated ${String(b.calibratedCeilingMs)} ms is above the hard cap ${b.hardCapMs} ms (OD-P4-13)`);
}

export function ratchetProblems(root: string): string[] {
  return [...lockProblems(root), ...calibrationProblems(), ...tightenOnlyProblems(ACCEPTED, ACCEPTED)];
}

function main(): void {
  const root = process.cwd();
  const problems = ratchetProblems(root);
  for (const p of problems) console.error(`FAIL  ${p}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} finding(s): the Phase 4 budget ratchet refuses this tree.`);
    process.exit(1);
  }
  const rows = Object.values(ACCEPTED)
    .map(
      (b) =>
        `  ${b.id.padEnd(10)} effective ${String(effectiveCeilingMs(b)).padStart(7)} ms  (hard cap ${b.hardCapMs} ms${b.calibrationLocked ? ', calibration-locked' : ''})`,
    )
    .join('\n');
  const ratios = Object.values(RATIOS)
    .map((r) => `  ${r.id.padEnd(28)} <= ${r.max}x${r.provisional ? '  PROVISIONAL' : ''}`)
    .join('\n');
  console.info(`OK  the Phase 4 budget ratchet agrees with ${LOCK_REL}\n${rows}\n${ratios}`);
}

if (process.argv[1]?.endsWith('phase4-budget-ratchet.ts')) main();
