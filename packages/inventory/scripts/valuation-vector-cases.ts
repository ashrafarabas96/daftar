/**
 * The shared `invval/1` valuation vectors, as LITERAL cases
 * (PHASE_3_S2_CONTRACT §4; P3-AL-05, P3-AL-08, P3-AL-49 §D).
 *
 * Every expected number below is copied from the architecture lock and the
 * contract, written by hand — none is computed by the package's functions.
 * `scripts/generate-valuation-vectors.ts` writes the rendering to
 * `vectors/valuation-vectors.json`; `test/valuation-vectors.test.ts`
 * regenerates it byte-for-byte AND replays every case through the TypeScript
 * functions, so the literals and the implementation check each other. The
 * SQL primitive is tested against the same file; nobody may hand-copy a
 * vector into a second place.
 *
 * Formatting: quantities are 4-dp strings, costs and averages 10-dp strings,
 * values integer strings (the PostgreSQL text of NUMERIC(18,4),
 * NUMERIC(28,10) and BIGINT).
 *
 * Conventions not fixed by §4, stated once:
 * - `pairOf` is the 1-based index, within `steps`, of the `transfer_out` leg.
 * - `journal.inventoryLineAmounts` lists, in step order, the stored value of
 *   every movement that is not a transfer leg (a transfer posts no entry,
 *   P3-AL-14), zeros included; `postedLineCount` counts the non-zero ones
 *   (a journal line must be > 0); `glInventory` is their sum. Owner seeds
 *   stand in for a Phase 4 oversell, which posts, so they are included.
 * - `cycle.totalOutbound` is the magnitude of the outbound values.
 * - `cogs` is the magnitude of the seeds' plus the catch-ups' values: the
 *   provisional COGS plus every catch-up (IR §5أ).
 * - Every step whose kind requires a reason carries `vector`; seeds carry `seed`.
 */
import type { MovementKind } from '../src/valuation';

export interface PrecisionVector {
  readonly id: string;
  readonly unitDecimals: 0 | 2 | 4;
  readonly qty: string;
  readonly valid: boolean;
}

export interface RoundingVector {
  readonly id: string;
  readonly numerator: string;
  readonly denominator: string;
  readonly scale: 0 | 10;
  readonly halfEven: string;
  readonly halfUp: string | null;
}

export interface StepExpectation {
  readonly value: string;
  readonly unitCostSnapshot: string | null;
  readonly onHand: string;
  readonly valuation: string;
  readonly avg: string | null;
  readonly stockSeq: number;
}

export interface ScenarioStep {
  readonly key: string;
  readonly kind: MovementKind;
  readonly qty: string;
  readonly unitCost: string | null;
  readonly value: string | null;
  readonly reason?: string;
  readonly pairOf?: number;
  readonly seededByOwner?: true;
  readonly catchUp?: { readonly qtyCovered: string; readonly actual: string; readonly provisional: string };
  readonly expect: StepExpectation;
}

export type ScenarioJournal =
  | { readonly inventoryLineAmounts: readonly string[]; readonly postedLineCount: number; readonly rounding6100Lines: 0; readonly glInventory: string }
  | { readonly none: 'transfer' };

export interface Scenario {
  readonly id: string;
  readonly group: 'P3-AL-49-D' | 'P3-AL-08';
  readonly keys: readonly string[];
  readonly steps: readonly ScenarioStep[];
  readonly journal: ScenarioJournal;
  readonly reconciliation: { readonly sumMovementValues: string; readonly sumCacheValuation: string };
  readonly withdrawnAggregate?: { readonly exact: string; readonly roundedHalfEven: string };
  readonly cycle?: { readonly totalInbound: string; readonly totalOutbound: string };
  readonly cogs?: string;
}

export interface ValuationVectors {
  readonly version: 'invval/1';
  readonly precision: readonly PrecisionVector[];
  readonly rounding: readonly RoundingVector[];
  readonly scenarios: readonly Scenario[];
  readonly controls: readonly Scenario[];
}

// ---------------------------------------------------------------------------
// Precision: P3-AL-05 bound vectors (L:280-291), contract §4 P-01 … P-10.
// ---------------------------------------------------------------------------
export const precisionCases: readonly PrecisionVector[] = [
  { id: 'P-01', unitDecimals: 0, qty: '1', valid: true },
  { id: 'P-02', unitDecimals: 0, qty: '1.0000', valid: true },
  { id: 'P-03', unitDecimals: 0, qty: '-3.0000', valid: true },
  { id: 'P-04', unitDecimals: 0, qty: '0.5', valid: false },
  { id: 'P-05', unitDecimals: 0, qty: '1.0001', valid: false },
  { id: 'P-06', unitDecimals: 2, qty: '1.23', valid: true },
  { id: 'P-07', unitDecimals: 2, qty: '1.2300', valid: true },
  { id: 'P-08', unitDecimals: 2, qty: '1.234', valid: false },
  { id: 'P-09', unitDecimals: 2, qty: '0.0001', valid: false },
  { id: 'P-10', unitDecimals: 4, qty: '1.2345', valid: true },
];

// ---------------------------------------------------------------------------
// Rounding: contract §4 R-01 … R-19. HALF_UP is given where it differs or
// the case is a tie, and is null ("—") otherwise.
// ---------------------------------------------------------------------------
export const roundingCases: readonly RoundingVector[] = [
  { id: 'R-01', numerator: '1', denominator: '2', scale: 0, halfEven: '0', halfUp: '1' },
  { id: 'R-02', numerator: '3', denominator: '2', scale: 0, halfEven: '2', halfUp: '2' },
  { id: 'R-03', numerator: '5', denominator: '2', scale: 0, halfEven: '2', halfUp: '3' },
  { id: 'R-04', numerator: '-1', denominator: '2', scale: 0, halfEven: '0', halfUp: '-1' },
  { id: 'R-05', numerator: '-3', denominator: '2', scale: 0, halfEven: '-2', halfUp: '-2' },
  { id: 'R-06', numerator: '-5', denominator: '2', scale: 0, halfEven: '-2', halfUp: '-3' },
  { id: 'R-07', numerator: '6', denominator: '10', scale: 0, halfEven: '1', halfUp: null },
  { id: 'R-08', numerator: '4', denominator: '10', scale: 0, halfEven: '0', halfUp: null },
  { id: 'R-09', numerator: '-6', denominator: '10', scale: 0, halfEven: '-1', halfUp: null },
  { id: 'R-10', numerator: '10', denominator: '3', scale: 10, halfEven: '3.3333333333', halfUp: null },
  { id: 'R-11', numerator: '20', denominator: '3', scale: 10, halfEven: '6.6666666667', halfUp: null },
  { id: 'R-12', numerator: '2500', denominator: '15', scale: 10, halfEven: '166.6666666667', halfUp: null },
  { id: 'R-13', numerator: '-520', denominator: '-6', scale: 10, halfEven: '86.6666666667', halfUp: null },
  { id: 'R-14', numerator: '1', denominator: '20000000000', scale: 10, halfEven: '0.0000000000', halfUp: '0.0000000001' },
  { id: 'R-15', numerator: '3', denominator: '20000000000', scale: 10, halfEven: '0.0000000002', halfUp: '0.0000000002' },
  { id: 'R-16', numerator: '3315', denominator: '10', scale: 0, halfEven: '332', halfUp: '332' },
  { id: 'R-17', numerator: '-3315', denominator: '10', scale: 0, halfEven: '-332', halfUp: '-332' },
  { id: 'R-18', numerator: '7', denominator: '2', scale: 0, halfEven: '4', halfUp: '4' },
  { id: 'R-19', numerator: '1', denominator: '30000000000', scale: 10, halfEven: '0.0000000000', halfUp: null },
];

// ---------------------------------------------------------------------------
// Scenarios. `x(value, snapshot, onHand, valuation, avg, stockSeq)` is only
// shorthand for the expectation object; every argument is a literal.
// ---------------------------------------------------------------------------
function x(value: string, unitCostSnapshot: string | null, onHand: string, valuation: string, avg: string | null, stockSeq: number): StepExpectation {
  return { value, unitCostSnapshot, onHand, valuation, avg, stockSeq };
}

function journal(inventoryLineAmounts: readonly string[], postedLineCount: number, glInventory: string): ScenarioJournal {
  return { inventoryLineAmounts, postedLineCount, rounding6100Lines: 0, glInventory };
}

function reconciliation(sumMovementValues: string, sumCacheValuation: string): Scenario['reconciliation'] {
  return { sumMovementValues, sumCacheValuation };
}

/** P3-AL-49 §D vector F's two steps, which G and H continue (L:1402). */
const vectorFSteps: readonly ScenarioStep[] = [
  { key: 'K1', kind: 'purchase', qty: '3.0000', unitCost: '3.3333333333', value: '10', expect: x('10', '3.3333333333', '3.0000', '10', '3.3333333333', 1) },
  {
    key: 'K1',
    kind: 'damage',
    qty: '-1.0000',
    unitCost: null,
    value: null,
    reason: 'vector',
    expect: x('-3', '3.3333333333', '2.0000', '7', '3.5000000000', 2),
  },
];

/** P3-AL-49 §D, vectors A–I (L:1393-1405). */
const alD: readonly Scenario[] = [
  {
    id: 'A',
    group: 'P3-AL-49-D',
    keys: ['K1'],
    steps: [
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.6000000000', value: null, expect: x('1', '0.6000000000', '1.0000', '1', '1.0000000000', 1) },
    ],
    journal: journal(['1'], 1, '1'),
    reconciliation: reconciliation('1', '1'),
  },
  {
    id: 'B',
    group: 'P3-AL-49-D',
    keys: ['K1'],
    steps: [
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.6000000000', value: null, expect: x('1', '0.6000000000', '1.0000', '1', '1.0000000000', 1) },
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.6000000000', value: null, expect: x('1', '0.6000000000', '2.0000', '2', '1.0000000000', 2) },
    ],
    journal: journal(['1', '1'], 2, '2'),
    reconciliation: reconciliation('2', '2'),
    withdrawnAggregate: { exact: '1.2', roundedHalfEven: '1' },
  },
  {
    id: 'C',
    group: 'P3-AL-49-D',
    keys: ['K1'],
    steps: [
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.4000000000', value: null, expect: x('0', '0.4000000000', '1.0000', '0', '0.0000000000', 1) },
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.4000000000', value: null, expect: x('0', '0.4000000000', '2.0000', '0', '0.0000000000', 2) },
    ],
    journal: journal(['0', '0'], 0, '0'),
    reconciliation: reconciliation('0', '0'),
    withdrawnAggregate: { exact: '0.8', roundedHalfEven: '1' },
  },
  {
    id: 'D',
    group: 'P3-AL-49-D',
    keys: ['K1'],
    steps: [
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.5000000000', value: null, expect: x('0', '0.5000000000', '1.0000', '0', '0.0000000000', 1) },
    ],
    journal: journal(['0'], 0, '0'),
    reconciliation: reconciliation('0', '0'),
  },
  {
    id: 'E',
    group: 'P3-AL-49-D',
    keys: ['K1'],
    steps: [
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '1.5000000000', value: null, expect: x('2', '1.5000000000', '1.0000', '2', '2.0000000000', 1) },
    ],
    journal: journal(['2'], 1, '2'),
    reconciliation: reconciliation('2', '2'),
  },
  {
    id: 'F',
    group: 'P3-AL-49-D',
    keys: ['K1'],
    steps: vectorFSteps,
    journal: journal(['10', '-3'], 2, '7'),
    reconciliation: reconciliation('7', '7'),
  },
  {
    id: 'G',
    group: 'P3-AL-49-D',
    keys: ['K1'],
    steps: [
      ...vectorFSteps,
      {
        key: 'K1',
        kind: 'damage',
        qty: '-1.0000',
        unitCost: null,
        value: null,
        reason: 'vector',
        expect: x('-4', '3.5000000000', '1.0000', '3', '3.0000000000', 3),
      },
      {
        key: 'K1',
        kind: 'damage',
        qty: '-1.0000',
        unitCost: null,
        value: null,
        reason: 'vector',
        expect: x('-3', '3.0000000000', '0.0000', '0', '3.0000000000', 4),
      },
    ],
    journal: journal(['10', '-3', '-4', '-3'], 4, '0'),
    reconciliation: reconciliation('0', '0'),
    cycle: { totalInbound: '10', totalOutbound: '10' },
  },
  {
    id: 'H',
    group: 'P3-AL-49-D',
    keys: ['K1', 'K2'],
    steps: [
      ...vectorFSteps,
      { key: 'K1', kind: 'transfer_out', qty: '-2.0000', unitCost: null, value: null, expect: x('-7', '3.5000000000', '0.0000', '0', '3.5000000000', 3) },
      {
        key: 'K2',
        kind: 'transfer_in',
        qty: '2.0000',
        unitCost: null,
        value: null,
        pairOf: 3,
        expect: x('7', '3.5000000000', '2.0000', '7', '3.5000000000', 1),
      },
    ],
    journal: journal(['10', '-3'], 2, '7'),
    reconciliation: reconciliation('7', '7'),
  },
  {
    id: 'I',
    group: 'P3-AL-49-D',
    keys: ['K1'],
    steps: [
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.6000000000', value: null, expect: x('1', '0.6000000000', '1.0000', '1', '1.0000000000', 1) },
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.6000000000', value: null, expect: x('1', '0.6000000000', '2.0000', '2', '1.0000000000', 2) },
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.4000000000', value: null, expect: x('0', '0.4000000000', '3.0000', '2', '0.6666666667', 3) },
      { key: 'K1', kind: 'purchase', qty: '1.0000', unitCost: '0.4000000000', value: null, expect: x('0', '0.4000000000', '4.0000', '2', '0.5000000000', 4) },
    ],
    journal: journal(['1', '1', '0', '0'], 2, '2'),
    reconciliation: reconciliation('2', '2'),
    withdrawnAggregate: { exact: '2.0', roundedHalfEven: '2' },
  },
];

/** AL08-ADJ-POS's steps, which AL08-ADJ-NEG continues. */
const adjPosSteps: readonly ScenarioStep[] = [
  {
    key: 'K1',
    kind: 'purchase',
    qty: '10.0000',
    unitCost: '100.0000000000',
    value: null,
    expect: x('1000', '100.0000000000', '10.0000', '1000', '100.0000000000', 1),
  },
  {
    key: 'K1',
    kind: 'adjustment',
    qty: '3.0000',
    unitCost: '110.5000000000',
    value: null,
    reason: 'vector',
    expect: x('332', '110.5000000000', '13.0000', '1332', '102.4615384615', 2),
  },
];

/** P3-AL-08 arithmetic families (L:390 minus PPV, A-09), bound to GOLD-44/54/55/72 (IR §5أ). */
const al08: readonly Scenario[] = [
  {
    id: 'AL08-RECEIPT',
    group: 'P3-AL-08',
    keys: ['K1'],
    steps: [
      {
        key: 'K1',
        kind: 'purchase',
        qty: '10.0000',
        unitCost: '200.0000000000',
        value: null,
        expect: x('2000', '200.0000000000', '10.0000', '2000', '200.0000000000', 1),
      },
      {
        key: 'K1',
        kind: 'purchase',
        qty: '5.0000',
        unitCost: '100.0000000000',
        value: null,
        expect: x('500', '100.0000000000', '15.0000', '2500', '166.6666666667', 2),
      },
    ],
    journal: journal(['2000', '500'], 2, '2500'),
    reconciliation: reconciliation('2500', '2500'),
  },
  {
    id: 'AL08-TRANSFER-GOLD44',
    group: 'P3-AL-08',
    keys: ['K1', 'K2'],
    steps: [
      {
        key: 'K1',
        kind: 'purchase',
        qty: '10.0000',
        unitCost: '100.0000000000',
        value: null,
        expect: x('1000', '100.0000000000', '10.0000', '1000', '100.0000000000', 1),
      },
      {
        key: 'K2',
        kind: 'purchase',
        qty: '10.0000',
        unitCost: '200.0000000000',
        value: null,
        expect: x('2000', '200.0000000000', '10.0000', '2000', '200.0000000000', 1),
      },
      {
        key: 'K1',
        kind: 'transfer_out',
        qty: '-5.0000',
        unitCost: null,
        value: null,
        expect: x('-500', '100.0000000000', '5.0000', '500', '100.0000000000', 2),
      },
      {
        key: 'K2',
        kind: 'transfer_in',
        qty: '5.0000',
        unitCost: null,
        value: null,
        pairOf: 3,
        expect: x('500', '100.0000000000', '15.0000', '2500', '166.6666666667', 2),
      },
    ],
    journal: journal(['1000', '2000'], 2, '3000'),
    reconciliation: reconciliation('3000', '3000'),
  },
  {
    id: 'AL08-ADJ-POS',
    group: 'P3-AL-08',
    keys: ['K1'],
    steps: adjPosSteps,
    journal: journal(['1000', '332'], 2, '1332'),
    reconciliation: reconciliation('1332', '1332'),
  },
  {
    id: 'AL08-ADJ-NEG',
    group: 'P3-AL-08',
    keys: ['K1'],
    steps: [
      ...adjPosSteps,
      {
        key: 'K1',
        kind: 'adjustment',
        qty: '-4.0000',
        unitCost: null,
        value: null,
        reason: 'vector',
        expect: x('-410', '102.4615384615', '9.0000', '922', '102.4444444444', 3),
      },
    ],
    journal: journal(['1000', '332', '-410'], 3, '922'),
    reconciliation: reconciliation('922', '922'),
  },
  {
    id: 'AL08-CATCHUP-GOLD54',
    group: 'P3-AL-08',
    keys: ['K1'],
    steps: [
      {
        key: 'K1',
        kind: 'adjustment',
        qty: '-5.0000',
        unitCost: '100.0000000000',
        value: '-500',
        reason: 'seed',
        seededByOwner: true,
        expect: x('-500', '100.0000000000', '-5.0000', '-500', '100.0000000000', 1),
      },
      {
        key: 'K1',
        kind: 'purchase',
        qty: '10.0000',
        unitCost: '120.0000000000',
        value: null,
        expect: x('1200', '120.0000000000', '5.0000', '700', '140.0000000000', 2),
      },
      {
        key: 'K1',
        kind: 'negative_inventory_cost_adjustment',
        qty: '0.0000',
        unitCost: null,
        value: '-100',
        catchUp: { qtyCovered: '5.0000', actual: '120.0000000000', provisional: '100.0000000000' },
        expect: x('-100', null, '5.0000', '600', '120.0000000000', 3),
      },
    ],
    journal: journal(['-500', '1200', '-100'], 3, '600'),
    reconciliation: reconciliation('600', '600'),
    cogs: '600',
  },
  {
    id: 'AL08-CATCHUP-GOLD55',
    group: 'P3-AL-08',
    keys: ['K1'],
    steps: [
      {
        key: 'K1',
        kind: 'adjustment',
        qty: '-5.0000',
        unitCost: '0.0000000000',
        value: '0',
        reason: 'seed',
        seededByOwner: true,
        expect: x('0', '0.0000000000', '-5.0000', '0', '0.0000000000', 1),
      },
      {
        key: 'K1',
        kind: 'purchase',
        qty: '10.0000',
        unitCost: '120.0000000000',
        value: null,
        expect: x('1200', '120.0000000000', '5.0000', '1200', '240.0000000000', 2),
      },
      {
        key: 'K1',
        kind: 'negative_inventory_cost_adjustment',
        qty: '0.0000',
        unitCost: null,
        value: '-600',
        catchUp: { qtyCovered: '5.0000', actual: '120.0000000000', provisional: '0.0000000000' },
        expect: x('-600', null, '5.0000', '600', '120.0000000000', 3),
      },
    ],
    journal: journal(['0', '1200', '-600'], 2, '600'),
    reconciliation: reconciliation('600', '600'),
    cogs: '600',
  },
  {
    id: 'AL08-CATCHUP-GOLD72',
    group: 'P3-AL-08',
    keys: ['K1'],
    steps: [
      {
        key: 'K1',
        kind: 'adjustment',
        qty: '-10.0000',
        unitCost: '100.0000000000',
        value: '-1000',
        reason: 'seed',
        seededByOwner: true,
        expect: x('-1000', '100.0000000000', '-10.0000', '-1000', '100.0000000000', 1),
      },
      {
        key: 'K1',
        kind: 'purchase',
        qty: '4.0000',
        unitCost: '120.0000000000',
        value: null,
        expect: x('480', '120.0000000000', '-6.0000', '-520', '86.6666666667', 2),
      },
      {
        key: 'K1',
        kind: 'negative_inventory_cost_adjustment',
        qty: '0.0000',
        unitCost: null,
        value: '-80',
        catchUp: { qtyCovered: '4.0000', actual: '120.0000000000', provisional: '100.0000000000' },
        expect: x('-80', null, '-6.0000', '-600', '100.0000000000', 3),
      },
      {
        key: 'K1',
        kind: 'purchase',
        qty: '6.0000',
        unitCost: '130.0000000000',
        value: null,
        expect: x('780', '130.0000000000', '0.0000', '180', '100.0000000000', 4),
      },
      {
        key: 'K1',
        kind: 'negative_inventory_cost_adjustment',
        qty: '0.0000',
        unitCost: null,
        value: '-180',
        catchUp: { qtyCovered: '6.0000', actual: '130.0000000000', provisional: '100.0000000000' },
        expect: x('-180', null, '0.0000', '0', '100.0000000000', 5),
      },
    ],
    journal: journal(['-1000', '480', '-80', '780', '-180'], 5, '0'),
    reconciliation: reconciliation('0', '0'),
    cogs: '1260',
  },
];

/** Controls (not counted): CTRL-FLUSH — the flush takes the residual value the average cannot see (R-19; T-06.N, T-10.N). */
const controls: readonly Scenario[] = [
  {
    id: 'CTRL-FLUSH',
    group: 'P3-AL-49-D',
    keys: ['K1'],
    steps: [
      {
        key: 'K1',
        kind: 'purchase',
        qty: '30000000000.0000',
        unitCost: '0.0000000000',
        value: '1',
        expect: x('1', '0.0000000000', '30000000000.0000', '1', '0.0000000000', 1),
      },
      {
        key: 'K1',
        kind: 'damage',
        qty: '-30000000000.0000',
        unitCost: null,
        value: null,
        reason: 'vector',
        expect: x('-1', '0.0000000000', '0.0000', '0', '0.0000000000', 2),
      },
    ],
    journal: journal(['1', '-1'], 2, '0'),
    reconciliation: reconciliation('0', '0'),
  },
];

const QTY_RE = /^-?(0|[1-9][0-9]*)\.[0-9]{4}$/;
const COST_RE = /^-?(0|[1-9][0-9]*)\.[0-9]{10}$/;
const MINOR_RE = /^-?(0|[1-9][0-9]*)$/;

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`valuation vector literal is malformed: ${what}`);
}

/** Re-emits a step with the §4 key order and checks the literal formats. */
function normalizeStep(s: ScenarioStep, where: string): ScenarioStep {
  check(QTY_RE.test(s.qty), `${where} qty`);
  check(s.unitCost === null || COST_RE.test(s.unitCost), `${where} unitCost`);
  check(s.value === null || MINOR_RE.test(s.value), `${where} value`);
  const e = s.expect;
  check(MINOR_RE.test(e.value) && QTY_RE.test(e.onHand) && MINOR_RE.test(e.valuation), `${where} expect`);
  check((e.unitCostSnapshot === null || COST_RE.test(e.unitCostSnapshot)) && (e.avg === null || COST_RE.test(e.avg)), `${where} expect cost`);
  check(Number.isSafeInteger(e.stockSeq) && e.stockSeq >= 1, `${where} stockSeq`);
  if (s.catchUp !== undefined) {
    check(QTY_RE.test(s.catchUp.qtyCovered) && COST_RE.test(s.catchUp.actual) && COST_RE.test(s.catchUp.provisional), `${where} catchUp`);
  }
  return {
    key: s.key,
    kind: s.kind,
    qty: s.qty,
    unitCost: s.unitCost,
    value: s.value,
    ...(s.reason !== undefined ? { reason: s.reason } : {}),
    ...(s.pairOf !== undefined ? { pairOf: s.pairOf } : {}),
    ...(s.seededByOwner !== undefined ? { seededByOwner: s.seededByOwner } : {}),
    ...(s.catchUp !== undefined ? { catchUp: { qtyCovered: s.catchUp.qtyCovered, actual: s.catchUp.actual, provisional: s.catchUp.provisional } } : {}),
    expect: { value: e.value, unitCostSnapshot: e.unitCostSnapshot, onHand: e.onHand, valuation: e.valuation, avg: e.avg, stockSeq: e.stockSeq },
  };
}

/** Re-emits a scenario with the §4 key order. */
function normalizeScenario(sc: Scenario): Scenario {
  check(
    sc.steps.every((s) => sc.keys.includes(s.key)),
    `${sc.id} keys`,
  );
  return {
    id: sc.id,
    group: sc.group,
    keys: [...sc.keys],
    steps: sc.steps.map((s, i) => normalizeStep(s, `${sc.id} step ${i + 1}`)),
    journal:
      'none' in sc.journal
        ? { none: sc.journal.none }
        : {
            inventoryLineAmounts: [...sc.journal.inventoryLineAmounts],
            postedLineCount: sc.journal.postedLineCount,
            rounding6100Lines: sc.journal.rounding6100Lines,
            glInventory: sc.journal.glInventory,
          },
    reconciliation: { sumMovementValues: sc.reconciliation.sumMovementValues, sumCacheValuation: sc.reconciliation.sumCacheValuation },
    ...(sc.withdrawnAggregate !== undefined
      ? { withdrawnAggregate: { exact: sc.withdrawnAggregate.exact, roundedHalfEven: sc.withdrawnAggregate.roundedHalfEven } }
      : {}),
    ...(sc.cycle !== undefined ? { cycle: { totalInbound: sc.cycle.totalInbound, totalOutbound: sc.cycle.totalOutbound } } : {}),
    ...(sc.cogs !== undefined ? { cogs: sc.cogs } : {}),
  };
}

export function buildValuationVectors(): ValuationVectors {
  return {
    version: 'invval/1',
    precision: precisionCases.map((p) => ({ id: p.id, unitDecimals: p.unitDecimals, qty: p.qty, valid: p.valid })),
    rounding: roundingCases.map((r) => ({
      id: r.id,
      numerator: r.numerator,
      denominator: r.denominator,
      scale: r.scale,
      halfEven: r.halfEven,
      halfUp: r.halfUp,
    })),
    scenarios: [...alD, ...al08].map(normalizeScenario),
    controls: controls.map(normalizeScenario),
  };
}

/** A multi-line JSON array whose items are all scalars (strings here never contain a quote or an escape). */
const SCALAR_ARRAY_RE = /\[\n(?:[ ]*(?:"[^"\\\n]*"|-?[0-9]+|true|false|null),?\n)+[ ]*\]/g;
const SCALAR_RE = /"[^"\\\n]*"|-?[0-9]+|true|false|null/g;

/**
 * The exact text of `vectors/valuation-vectors.json`: `JSON.stringify` at
 * two spaces, with arrays of scalars on one line — the layout the repository's
 * Prettier gives a JSON file, so `npm run format` accepts the generated file
 * as it is written. Every such array here is far shorter than the print width.
 */
export function renderValuationVectors(): string {
  const text = JSON.stringify(buildValuationVectors(), null, 2).replace(SCALAR_ARRAY_RE, (block) => `[${(block.match(SCALAR_RE) ?? []).join(', ')}]`);
  return `${text}\n`;
}
