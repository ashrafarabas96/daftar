/**
 * P3-S2 — THE VALUATION VECTORS THROUGH THE REAL PRIMITIVE, THE JOURNAL AND
 * THE GL (docs/PHASE_3_S2_CONTRACT.md §6: T-05, T-09, T-10, T-11; §5 H-4, H-5).
 *
 * One specification, two implementations (H-4): every expected string in
 * `packages/inventory/vectors/valuation-vectors.json` is compared, byte for
 * byte, with what R1 / R3 STORED and with what the TypeScript twin computes.
 * The SQL side is always R1, R2 or R3 itself.
 *
 * The A-10 composite (H-5): per scenario, in ONE transaction that is rolled
 * back, the fixture writes the movements as `daftar_app`; every non-zero,
 * non-transfer stored value is then posted through the real accounting
 * command (`accounting_post_manual_adjustment`, as `daftar_app`, with a real
 * accounting assertion) against the Inventory system account; the journal
 * lines and the GL are read back by system key.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EMPTY_STOCK_STATE,
  MOVEMENT_KIND_QTY_SIGN,
  applyMovement,
  averageUnitCost,
  catchUpValue,
  formatMinor,
  formatQuantity,
  formatUnitCost,
  parseDecimal,
  parseMinor,
  parseQuantity,
  parseUnitCost,
  roundHalfEven,
  roundHalfEvenDecimal,
  simulateMovement,
  type MovementKind,
  type StockState,
} from '../../packages/inventory/src';
import vectors from '../../packages/inventory/vectors/valuation-vectors.json';
import { assertionFor, postAs, todayIn, type PostCommand, type PostLine } from '../helpers/accounting-posting';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  applyOne,
  atCommit,
  expectAccepted,
  expectRefused,
  levelOf,
  must,
  ownerClient,
  removeCommittedFixture,
  req,
  scratch,
  seedOwnerMovement,
  seedStockBusiness,
  setScope,
  tryApply,
  verify,
  settle,
  withRolledBackFixture,
  type Key,
  type Outcome,
  type Queryable,
  type StockBusiness,
} from '../helpers/stock-ledger';

// ── the vector file, read through a local wide schema (no casts) ─────────

interface StepExpect {
  value: string;
  unitCostSnapshot: string | null;
  onHand: string;
  valuation: string;
  avg: string | null;
  stockSeq: number;
}
interface Step {
  key: string;
  kind: string;
  qty: string;
  unitCost: string | null;
  value: string | null;
  reason?: string;
  pairOf?: number;
  seededByOwner?: boolean;
  catchUp?: { qtyCovered: string; actual: string; provisional: string };
  expect: StepExpect;
}
interface Journal {
  inventoryLineAmounts: string[];
  postedLineCount: number;
  rounding6100Lines: number;
  glInventory: string;
}
interface Scenario {
  id: string;
  group: string;
  keys: string[];
  steps: Step[];
  journal: Journal | { none: string };
  reconciliation: { sumMovementValues: string; sumCacheValuation: string };
  withdrawnAggregate?: { exact: string; roundedHalfEven: string };
  cycle?: { totalInbound: string; totalOutbound: string };
  cogs?: string;
}
interface RoundingRow {
  id: string;
  numerator: string;
  denominator: string;
  scale: number;
  halfEven: string;
  halfUp: string | null;
}

const SCENARIOS: readonly Scenario[] = vectors.scenarios;
const CONTROLS: readonly Scenario[] = vectors.controls;
const ROUNDING: readonly RoundingRow[] = vectors.rounding;

function isKind(k: string): k is MovementKind {
  return Object.prototype.hasOwnProperty.call(MOVEMENT_KIND_QTY_SIGN, k);
}
function kindOf(k: string): MovementKind {
  if (!isKind(k)) throw new Error(`the vector names an unknown movement kind: ${k}`);
  return k;
}
function scaleOf(s: number): 0 | 10 {
  if (s !== 0 && s !== 10) throw new Error(`the vector names an unsupported scale: ${s}`);
  return s;
}
function isJournal(j: Scenario['journal']): j is Journal {
  return 'inventoryLineAmounts' in j;
}
/** An ExactDecimal as the text R1 returns: an integer at scale 0, 10 fraction digits at scale 10. */
function exactText(units: bigint, scale: 0 | 10): string {
  return scale === 0 ? formatMinor(units) : formatUnitCost(units);
}

// ── fixtures ───────────────────────────────────────────────────────────────

let biz: StockBusiness;
let today: string;
let keys: Record<string, Key>;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  biz = await seedStockBusiness(ownerPool(), 'vectors');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
  keys = {
    K1: { warehouseId: biz.warehouse1, variantId: biz.piece.variantId },
    K2: { warehouseId: biz.warehouse2, variantId: biz.piece.variantId },
  };
});

function keyOf(name: string): Key {
  return must(keys[name], `vector key ${name}`);
}

interface StepResult {
  step: Step;
  value: string;
}

/** Q4 quantity × C10 cost carries 14 fraction digits; dividing by this lands on minor units. */
const Q4_TIMES_C10 = 10n ** 14n;

/**
 * The valuation rule without the 10^10 quantity bound, for a control vector
 * only (the package, like R3, refuses CTRL-FLUSH's 3·10^10). Priced inbound
 * and covered outbound only; anything else is not a control this suite knows.
 * The same shape as `unboundedStep` in packages/inventory/test/valuation-vectors.test.ts.
 */
function unboundedControlStep(
  state: StockState,
  qtyQ4: bigint,
  costC10: bigint | null,
  supplied: bigint | null,
): { value: bigint; snapshot: bigint; next: StockState } {
  let value: bigint;
  let snapshot: bigint;
  if (qtyQ4 > 0n && costC10 !== null) {
    value = supplied ?? roundHalfEven(qtyQ4 * costC10, Q4_TIMES_C10);
    snapshot = costC10;
  } else if (qtyQ4 < 0n && costC10 === null && supplied === null && state.avg !== null && -qtyQ4 <= state.onHand) {
    const taken = -qtyQ4;
    value = taken === state.onHand ? -state.valuation : -roundHalfEven(taken * state.avg, Q4_TIMES_C10);
    snapshot = state.avg;
  } else {
    throw new Error('a control uses only priced inbound and covered outbound steps');
  }
  const onHand = state.onHand + qtyQ4;
  const valuation = state.valuation + value;
  return { value, snapshot, next: { onHand, valuation, avg: averageUnitCost(valuation, onHand, state.avg), lastStockSeq: state.lastStockSeq + 1n } };
}

/**
 * Run one scenario's steps in the caller's transaction: seeds owner-raw
 * (H-1), everything else through the fixture as daftar_app (H-2). Every
 * stored answer is compared with the vector AND with the TypeScript twin.
 *
 * `seedAll` writes EVERY step raw with the vector's stored values (H-1) —
 * only for a control vector that R3 can no longer produce (CTRL-FLUSH is
 * outside the 10^10 quantity bound); each non-seed step is still predicted
 * from the state before it by the unbounded copy of the rule, so the flush
 * is still checked.
 */
async function runSteps(c: Client, s: Scenario, opts: { seedAll?: boolean } = {}): Promise<StepResult[]> {
  const state = new Map<string, StockState>();
  const identities: { sourceId: string; sourceLineId: string }[] = [];
  const results: StepResult[] = [];
  for (const [i, step] of s.steps.entries()) {
    const at = `${s.id} step ${i + 1} (${step.kind})`;
    const key = keyOf(step.key);
    const before = state.get(step.key) ?? EMPTY_STOCK_STATE;
    const qtyQ4 = parseQuantity(step.qty);
    const kind = kindOf(step.kind);
    let stored: { value: string; snapshot: string | null; onHand: string; valuation: string; avg: string | null; seq: string };
    let next: StockState;
    let tsValue: bigint;
    let tsSnapshot: bigint | null;

    if (step.seededByOwner === true || opts.seedAll === true) {
      // H-1: a Phase 4 oversell stand-in (or, under seedAll, a control step), written raw with the vector's stored values.
      const isSeed = step.seededByOwner === true;
      const value = isSeed ? must(step.value, 'seed value') : step.expect.value;
      const unitCost = isSeed ? step.unitCost : step.expect.unitCostSnapshot;
      const seeded = await seedOwnerMovement(c, {
        scope: biz,
        key,
        kind: step.kind,
        qty: step.qty,
        unitCost,
        value,
        reason: step.reason ?? null,
        stockSeq: step.expect.stockSeq,
        cache: { onHand: step.expect.onHand, valuation: step.expect.valuation, avg: step.expect.avg },
      });
      identities.push({ sourceId: seeded.sourceId, sourceLineId: seeded.sourceLineId });
      if (isSeed) {
        tsValue = parseMinor(value);
        tsSnapshot = step.unitCost === null ? null : parseUnitCost(step.unitCost);
        next = applyMovement(before, qtyQ4, tsValue);
      } else {
        const sim = unboundedControlStep(
          before,
          qtyQ4,
          step.unitCost === null ? null : parseUnitCost(step.unitCost),
          step.value === null ? null : parseMinor(step.value),
        );
        tsValue = sim.value;
        tsSnapshot = sim.snapshot;
        next = sim.next;
      }
      const m = must(
        (
          await c.query<{ v: string; s: string | null }>(
            `SELECT value_delta_base_minor::text AS v, unit_cost_base_minor::text AS s FROM stock_movements WHERE business_id = $1 AND id = $2`,
            [biz.businessId, seeded.movementId],
          )
        ).rows[0],
      );
      const l = must(await levelOf(c, biz.businessId, key));
      stored = { value: m.v, snapshot: m.s, onHand: l.on_hand, valuation: l.valuation_base_minor, avg: l.avg_unit_cost_base_minor, seq: l.last_stock_seq };
    } else {
      const pair = step.pairOf === undefined ? undefined : must(identities[step.pairOf - 1], `${at} pair`);
      const ids = pair ?? { sourceId: randomUUID(), sourceLineId: randomUUID() };
      identities.push(ids);
      if (step.catchUp !== undefined) {
        // The catch-up amount is the package's formula; the vector carries it as the request value.
        expect(
          formatMinor(catchUpValue(parseQuantity(step.catchUp.qtyCovered), parseUnitCost(step.catchUp.actual), parseUnitCost(step.catchUp.provisional))),
          `${at} catch-up`,
        ).toBe(step.value);
      }
      const row = await applyOne(
        c,
        biz,
        req(key, step.kind, step.qty, {
          unitCost: step.unitCost,
          value: step.value,
          reason: step.reason ?? null,
          sourceId: ids.sourceId,
          sourceLineId: ids.sourceLineId,
        }),
      );
      const l = must(await levelOf(c, biz.businessId, key));
      // The primitive's answer is what it stored, and what it stored is what the cache holds.
      expect(
        { onHand: row.on_hand, valuation: row.valuation_base_minor, avg: row.avg_unit_cost_base_minor, seq: row.stock_seq },
        `${at} answer vs cache`,
      ).toEqual({ onHand: l.on_hand, valuation: l.valuation_base_minor, avg: l.avg_unit_cost_base_minor, seq: l.last_stock_seq });
      stored = {
        value: row.value_delta_base_minor,
        snapshot: row.unit_cost_base_minor,
        onHand: l.on_hand,
        valuation: l.valuation_base_minor,
        avg: l.avg_unit_cost_base_minor,
        seq: l.last_stock_seq,
      };

      const pairedOut =
        step.pairOf === undefined
          ? undefined
          : (() => {
              const out = must(results[step.pairOf - 1], `${at} paired step`);
              return {
                value: parseMinor(out.value),
                costC10: parseUnitCost(must(out.step.expect.unitCostSnapshot, 'paired snapshot')),
                qtyQ4: parseQuantity(out.step.qty),
              };
            })();
      const sim = simulateMovement(before, {
        kind,
        qtyQ4,
        costC10: step.unitCost === null ? null : parseUnitCost(step.unitCost),
        value: step.value === null ? null : parseMinor(step.value),
        ...(pairedOut === undefined ? {} : { pairedOut }),
      });
      tsValue = sim.value;
      tsSnapshot = sim.unitCostSnapshot;
      next = sim.next;
    }

    const e = step.expect;
    const vector = { value: e.value, snapshot: e.unitCostSnapshot, onHand: e.onHand, valuation: e.valuation, avg: e.avg, seq: String(e.stockSeq) };
    expect(stored, `${at}: SQL stored vs vector`).toEqual(vector);
    expect(
      {
        value: formatMinor(tsValue),
        snapshot: tsSnapshot === null ? null : formatUnitCost(tsSnapshot),
        onHand: formatQuantity(next.onHand),
        valuation: formatMinor(next.valuation),
        avg: next.avg === null ? null : formatUnitCost(next.avg),
        seq: next.lastStockSeq.toString(),
      },
      `${at}: TypeScript vs vector`,
    ).toEqual(vector);
    state.set(step.key, next);
    results.push({ step, value: stored.value });
  }
  return results;
}

/** H-5 step 3: one balanced manual adjustment per non-zero value, Inventory against Opening Equity, as daftar_app. */
async function postInventoryValue(c: Client, v: bigint, system = 'inventory'): Promise<void> {
  const at = new Date('2026-03-14T09:15:00Z');
  const amount = v < 0n ? -v : v;
  const line = (systemKey: string, side: 'D' | 'C'): PostLine => ({
    account: { kind: 'system', systemKey },
    side,
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: at,
    branchId: null,
    warehouseId: null,
  });
  const cmd: PostCommand = {
    tenantId: biz.tenantId,
    businessId: biz.businessId,
    sourceType: 'manual_adjustment',
    sourceId: randomUUID(),
    entryDate: today,
    description: 'stock movement value',
    requestId: 'stock-vectors',
    lines: [line(system, v > 0n ? 'D' : 'C'), line('opening_equity', v > 0n ? 'C' : 'D')],
  };
  await setScope(c, biz);
  await c.query('SET LOCAL ROLE daftar_app');
  await postAs(assertionFor(cmd, biz.userId), cmd, {}, c);
  await c.query('RESET ROLE');
}

interface Ledger {
  lines: string[];
  gl: string;
  rounding: number;
}

const byAmount = (a: string, b: string): number => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * H-5 step 4: the Inventory lines (signed amounts, as a multiset: entries of
 * one transaction share created_at, so no posting order is observable), the
 * GL, and the 6100 count — queried from the journal by system key.
 */
async function inventoryLedger(q: Queryable): Promise<Ledger> {
  const r = await q.query<{ amount: string }>(
    `SELECT (l.debit_minor - l.credit_minor)::text AS amount
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND a.system_key = 'inventory'
`,
    [biz.businessId],
  );
  const gl = must(
    (
      await q.query<{ gl: string }>(
        `SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0)::text AS gl
           FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
          WHERE l.business_id = $1 AND a.system_key = 'inventory'`,
        [biz.businessId],
      )
    ).rows[0],
  ).gl;
  const rounding = must(
    (
      await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
          WHERE l.business_id = $1 AND (a.system_key = 'rounding' OR a.code = '6100')`,
        [biz.businessId],
      )
    ).rows[0],
  ).n;
  return { lines: r.rows.map((x) => x.amount).sort(byAmount), gl, rounding };
}

async function sums(q: Queryable): Promise<{ movements: string; cache: string }> {
  return must(
    (
      await q.query<{ movements: string; cache: string }>(
        `SELECT (SELECT coalesce(sum(value_delta_base_minor), 0) FROM stock_movements WHERE business_id = $1)::text AS movements,
                (SELECT coalesce(sum(valuation_base_minor), 0) FROM stock_levels WHERE business_id = $1)::text AS cache`,
        [biz.businessId],
      )
    ).rows[0],
  );
}

const isTransfer = (k: string): boolean => k === 'transfer_in' || k === 'transfer_out';

/** The full H-5 composite for one scenario, in the caller's rolled-back transaction. */
async function composite(c: Client, s: Scenario, opts: { seedAll?: boolean } = {}): Promise<{ results: StepResult[]; ledger: Ledger }> {
  const results = await runSteps(c, s, opts);
  const nonTransfer = results.filter((r) => !isTransfer(r.step.kind));
  for (const r of nonTransfer) {
    const v = parseMinor(r.value);
    if (v !== 0n) await postInventoryValue(c, v);
  }
  const ledger = await inventoryLedger(c);
  // The rows really are deferred-complete: the whole transaction would COMMIT.
  expectAccepted(await atCommit(c), `${s.id}: COMMIT-time checks`);
  return { results, ledger };
}

describe('T-05 — HALF_EVEN parity: R1, the JSON and the TypeScript twin (P:157)', () => {
  it('T-05.1: every rounding row through inventory_half_even(...)::text is byte-equal to the JSON and to roundHalfEvenDecimal', async () => {
    expect(ROUNDING.length).toBeGreaterThanOrEqual(19);
    for (const r of ROUNDING) {
      const scale = scaleOf(r.scale);
      const sql = must(
        (await ownerPool().query<{ t: string }>(`SELECT inventory_half_even($1::numeric, $2::numeric, $3)::text AS t`, [r.numerator, r.denominator, scale]))
          .rows[0],
      ).t;
      const ts = roundHalfEvenDecimal(parseDecimal(r.numerator), parseDecimal(r.denominator), scale);
      expect({ id: r.id, sql, ts: exactText(ts.units, scale) }).toEqual({ id: r.id, sql: r.halfEven, ts: r.halfEven });
    }
  });

  it('T-05.2: the ties R-01 … R-06 and R-14 go to even, and at the ties that differ HALF_UP would disagree', async () => {
    const ties = ROUNDING.filter((r) => ['R-01', 'R-02', 'R-03', 'R-04', 'R-05', 'R-06', 'R-14'].includes(r.id));
    expect(ties.map((r) => [r.id, r.halfEven])).toEqual([
      ['R-01', '0'],
      ['R-02', '2'],
      ['R-03', '2'],
      ['R-04', '0'],
      ['R-05', '-2'],
      ['R-06', '-2'],
      ['R-14', '0.0000000000'],
    ]);
    expect(ties.filter((r) => r.halfUp !== null && r.halfUp !== r.halfEven).map((r) => r.id)).toEqual(['R-01', 'R-03', 'R-04', 'R-06', 'R-14']);
  });

  it('T-05.N: PostgreSQL round() — half away from zero — disagrees with the halfEven column at every differing tie, and agrees with halfUp', async () => {
    const differing = ROUNDING.filter((r) => r.halfUp !== null && r.halfUp !== r.halfEven);
    expect(differing.length).toBeGreaterThanOrEqual(5);
    for (const r of differing) {
      const t = must(
        (await ownerPool().query<{ t: string }>(`SELECT round($1::numeric / $2::numeric, $3)::text AS t`, [r.numerator, r.denominator, scaleOf(r.scale)]))
          .rows[0],
      ).t;
      expect({ id: r.id, round: t }).toEqual({ id: r.id, round: r.halfUp });
      expect(t, r.id).not.toBe(r.halfEven);
    }
    // Vector D: round() would store 1 where HALF_EVEN stores 0.
    const d = must((await ownerPool().query<{ r: string; he: string }>(`SELECT round(0.5)::text AS r, inventory_half_even(1, 2, 0)::text AS he`)).rows[0]);
    expect(d).toEqual({ r: '1', he: '0' });
  });
});

describe('T-09 / T-11 — the vectors through R3, the journal and the GL (P:161, P:163)', () => {
  it('the vector file carries the nine §D scenarios, the seven P3-AL-08 scenarios and the CTRL-FLUSH control', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      'I',
      'AL08-RECEIPT',
      'AL08-TRANSFER-GOLD44',
      'AL08-ADJ-POS',
      'AL08-ADJ-NEG',
      'AL08-CATCHUP-GOLD54',
      'AL08-CATCHUP-GOLD55',
      'AL08-CATCHUP-GOLD72',
    ]);
    expect(CONTROLS.map((s) => s.id)).toEqual(['CTRL-FLUSH']);
  });

  for (const s of SCENARIOS) {
    it(`${s.id}: stored values, snapshots, cache, Inventory journal lines, zero 6100 lines, GL and reconciliation`, async () => {
      await withRolledBackFixture(async (c) => {
        const { results, ledger } = await composite(c, s);
        const reconciliation = await sums(c);
        expect(reconciliation, `${s.id} reconciliation`).toEqual({ movements: s.reconciliation.sumMovementValues, cache: s.reconciliation.sumCacheValuation });
        const nonTransferValues = results.filter((r) => !isTransfer(r.step.kind)).map((r) => r.value);
        if (isJournal(s.journal)) {
          const j = s.journal;
          expect(nonTransferValues, `${s.id} inventory line amounts`).toEqual(j.inventoryLineAmounts);
          expect(ledger.lines, `${s.id} posted Inventory lines`).toEqual(j.inventoryLineAmounts.filter((a) => a !== '0').sort(byAmount));
          expect(ledger.lines).toHaveLength(j.postedLineCount);
          // T-11.1: no rounding line anywhere; T-11.2: the Inventory total IS the sum of stored values.
          expect(ledger.rounding, `${s.id} 6100 lines`).toBe(j.rounding6100Lines);
          expect(ledger.gl, `${s.id} GL`).toBe(j.glInventory);
          expect(ledger.gl, `${s.id} GL = Σ stored values`).toBe(reconciliation.movements);
        } else {
          expect(ledger.lines).toEqual([]);
        }
        if (s.withdrawnAggregate !== undefined) {
          const w = s.withdrawnAggregate;
          // The withdrawn P3-AL-49 aggregate: Σ exact q×c, rounded ONCE. Recomputed from the steps, rounded by R1.
          const exact = s.steps.filter((x) => x.unitCost !== null && x.value === null).map((x) => `${x.qty}::numeric * ${x.unitCost ?? '0'}::numeric`);
          const agg = must(
            (
              await c.query<{ same: boolean; r: string }>(
                `SELECT (${exact.join(' + ')}) = $1::numeric AS same, inventory_half_even(${exact.join(' + ')}, 1, 0)::text AS r`,
                [w.exact],
              )
            ).rows[0],
          );
          expect(agg, `${s.id} withdrawn aggregate`).toEqual({ same: true, r: w.roundedHalfEven });
          if (s.id === 'B' || s.id === 'C') {
            // The negative controls of P:161: the aggregate rule would disagree with the ledger (1 ≠ 2, 1 ≠ 0).
            expect(w.roundedHalfEven, `${s.id}: aggregate vs GL`).not.toBe(ledger.gl);
          } else {
            expect(w.roundedHalfEven, `${s.id}: aggregate coincides`).toBe(ledger.gl);
          }
        }
        if (s.cycle !== undefined) {
          const inbound = results.map((r) => parseMinor(r.value)).filter((v) => v > 0n);
          const outbound = results.map((r) => parseMinor(r.value)).filter((v) => v < 0n);
          expect(
            { inbound: formatMinor(inbound.reduce((a, b) => a + b, 0n)), outbound: formatMinor(-outbound.reduce((a, b) => a + b, 0n)) },
            `${s.id} cycle`,
          ).toEqual({
            inbound: s.cycle.totalInbound,
            outbound: s.cycle.totalOutbound,
          });
        }
        if (s.cogs !== undefined) {
          const cogs = -results.filter((r) => r.step.kind !== 'purchase').reduce((a, r) => a + parseMinor(r.value), 0n);
          expect(formatMinor(cogs), `${s.id} COGS`).toBe(s.cogs);
        }
      });
    });
  }

  it('T-11.N: a 6100 rounding line planted in-transaction is found by the same query (goes red)', async () => {
    await withRolledBackFixture(async (c) => {
      const scenario = must(SCENARIOS.find((s) => s.id === 'F'));
      await composite(c, scenario);
      expect((await inventoryLedger(c)).rounding).toBe(0);
      await scratch(c, async () => {
        await postInventoryValue(c, 1n, 'rounding');
        expect((await inventoryLedger(c)).rounding).toBe(1);
      });
    });
  });
});

describe('T-10 — full depletion and on_hand = 0 ⇒ valuation = 0 (P:162)', () => {
  it('T-10.1: vector G empties the key with the flush: cache 0 / 0, the average carried, inbound = outbound', async () => {
    await withRolledBackFixture(async (c) => {
      const g = must(SCENARIOS.find((s) => s.id === 'G'));
      await runSteps(c, g);
      const l = must(await levelOf(c, biz.businessId, keyOf('K1')));
      expect(l).toEqual({ on_hand: '0.0000', valuation_base_minor: '0', avg_unit_cost_base_minor: '3.0000000000', last_stock_seq: '4' });
    });
  });

  it('T-10.2: an owner UPDATE of a cache row to on_hand 0 / valuation 5 does not survive a REAL COMMIT (inventory.zero_stock_residual_value)', async () => {
    const c = await ownerClient();
    let o: Outcome<null> | undefined;
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4)`, [
        biz.tenantId,
        biz.businessId,
        biz.warehouse1,
        biz.dec4.variantId,
      ]);
      await c.query(`UPDATE stock_levels SET on_hand = 0, valuation_base_minor = 5 WHERE business_id = $1 AND variant_id = $2`, [
        biz.businessId,
        biz.dec4.variantId,
      ]);
      o = await settle(async () => {
        await c.query('COMMIT');
        return null;
      });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    const outcome = must(o, 'COMMIT outcome');
    if (outcome.ok) await removeCommittedFixture();
    expectRefused(outcome, 'P0001', 'inventory.zero_stock_residual_value');
    expect(
      must((await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM stock_levels WHERE business_id = $1`, [biz.businessId])).rows[0]).n,
    ).toBe(0);
  });

  it('T-10.2 (statement vs COMMIT): the same UPDATE is accepted at the statement; the deferred trigger refuses it at COMMIT; with the trigger dropped in-transaction COMMIT would accept it', async () => {
    await withRolledBackFixture(async (c) => {
      await c.query(`INSERT INTO stock_levels (tenant_id, business_id, warehouse_id, variant_id) VALUES ($1, $2, $3, $4)`, [
        biz.tenantId,
        biz.businessId,
        biz.warehouse1,
        biz.dec4.variantId,
      ]);
      await c.query(`UPDATE stock_levels SET on_hand = 0, valuation_base_minor = 5 WHERE business_id = $1 AND variant_id = $2`, [
        biz.businessId,
        biz.dec4.variantId,
      ]);
      expectRefused(await atCommit(c), 'P0001', 'inventory.zero_stock_residual_value');
      await scratch(c, async () => {
        // Settle the queued checks on a consistent row first: DROP TRIGGER refuses while events are pending.
        await c.query(`UPDATE stock_levels SET valuation_base_minor = 0 WHERE business_id = $1 AND variant_id = $2`, [biz.businessId, biz.dec4.variantId]);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await c.query('SET CONSTRAINTS ALL DEFERRED');
        await c.query(`DROP TRIGGER stock_levels_zero_on_hand_zero_value ON stock_levels`);
        await c.query(`UPDATE stock_levels SET valuation_base_minor = 5 WHERE business_id = $1 AND variant_id = $2`, [biz.businessId, biz.dec4.variantId]);
        expectAccepted(await atCommit(c), 'trigger dropped');
      });
    });
  });

  it('T-10.N: CTRL-FLUSH — seeded raw (H-1): the flush stores −1 and empties the key; the withdrawn rule HALF_EVEN(q × avg) would take 0 and leave a residual of 1', async () => {
    await withRolledBackFixture(async (c) => {
      const ctrl = must(CONTROLS.find((s) => s.id === 'CTRL-FLUSH'));
      // The vector's quantities (3·10^10) are outside R3's bound, so the control is seeded raw; the
      // TypeScript twin still derives −1 for the damage from the state the purchase left.
      const { results, ledger } = await composite(c, ctrl, { seedAll: true });
      expect(results.map((r) => r.value)).toEqual(['1', '-1']);
      expect(ledger.gl).toBe('0');
      const purchase = must(ctrl.steps[0]);
      const damage = must(ctrl.steps[1]);
      const withdrawn = must(
        (
          await c.query<{ taken: string }>(`SELECT inventory_half_even(abs($1::numeric) * $2::numeric, 1, 0)::text AS taken`, [
            damage.qty,
            must(purchase.expect.avg, 'avg after the purchase'),
          ])
        ).rows[0],
      ).taken;
      expect(withdrawn).toBe('0');
      const residual = parseMinor(purchase.expect.valuation) - parseMinor(withdrawn);
      expect(residual).toBe(1n);
      expect(must(await levelOf(c, biz.businessId, keyOf('K1'))).valuation_base_minor).toBe('0');
      // The seeded ledger is internally consistent: the fold of the two rows is the cache.
      expect((await verify(c, biz, keyOf('K1'))).matches).toBe(true);
    });
  });

  it('T-10.N (domain): R3 refuses both CTRL-FLUSH steps with inventory.quantity_out_of_range, so the vector is not producible through the primitive', async () => {
    await withRolledBackFixture(async (c) => {
      const ctrl = must(CONTROLS.find((s) => s.id === 'CTRL-FLUSH'));
      const purchase = must(ctrl.steps[0]);
      const damage = must(ctrl.steps[1]);
      const k = keyOf('K1');
      expectRefused(
        await tryApply(c, biz, [req(k, purchase.kind, purchase.qty, { unitCost: purchase.unitCost, value: purchase.value })]),
        'P0001',
        'inventory.quantity_out_of_range',
        'CTRL-FLUSH purchase',
      );
      expect(await levelOf(c, biz.businessId, k)).toBeNull();
      // Seed the purchase raw; the full-depletion damage is refused at the request bound as well.
      await runSteps(c, { ...ctrl, steps: [purchase] }, { seedAll: true });
      expectRefused(
        await tryApply(c, biz, [req(k, damage.kind, damage.qty, { reason: damage.reason ?? 'vector' })]),
        'P0001',
        'inventory.quantity_out_of_range',
        'CTRL-FLUSH damage',
      );
      expect(must(await levelOf(c, biz.businessId, k)).on_hand).toBe('30000000000.0000');
    });
  });

  it('T-10.N (bound): inside |on_hand| < 10^10 the withdrawn rule cannot leave a residual on full depletion — HALF_EVEN(q × HALF_EVEN(V / q)) = V at the edge q = 9999999999', async () => {
    // |q·avg − V| ≤ q · ½·10^-10 < ½, so the rounding always lands on V: the flush is only observable on seeded data.
    const r = await ownerPool().query<{ v: string; taken: string }>(
      `SELECT v::text, inventory_half_even(9999999999::numeric * inventory_half_even(v::numeric, 9999999999::numeric, 10), 1, 0)::text AS taken
         FROM (VALUES (1), (2), (3), (7), (4999999999), (5000000000), (9999999998), (123456789012), (999999999999999)) t(v)`,
    );
    expect(r.rows.filter((x) => x.v !== x.taken)).toEqual([]);
    expect(r.rows).toHaveLength(9);
  });
});
