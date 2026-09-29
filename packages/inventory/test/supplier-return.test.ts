import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSupplierReturnVectors, type SupplierReturnVectors } from '../scripts/s5-vector-cases';
import { InventoryError } from '../src/errors';
import { formatMinor, formatQuantity, formatUnitCost, parseMinor } from '../src/fixed-point';
import { toC10, toQ4 } from '../src/movement-payloads';
import { roundHalfEven } from '../src/rounding';
import {
  apBaseRelease,
  apSplit,
  carryingTxn,
  planSupplierReturn,
  ppv,
  supplierReturnEntryLines,
  type SupplierReturnLineInput,
  type SupplierReturnPlanInput,
} from '../src/supplier-return';
import { EMPTY_STOCK_STATE, type StockState } from '../src/valuation';

const FILE = join(__dirname, '..', 'vectors', 'supplier-return-vectors.json');
const committed = readFileSync(FILE, 'utf8');
const vectors = JSON.parse(committed) as SupplierReturnVectors;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

/** The 0043 law, independently of the generator: HALF_EVEN(x · rate · 10^max(0,eb−et) / 10^max(0,et−eb)). */
const convertAt =
  (rate: string, et: number, eb: number) =>
  (x: bigint): bigint =>
    roundHalfEven(x * toC10(rate) * 10n ** BigInt(Math.max(0, eb - et)), 10n ** 10n * 10n ** BigInt(Math.max(0, et - eb)));

const stateOf = (s: { onHand: string; valuation: string; avg: string | null }): StockState => ({
  onHand: toQ4(s.onHand),
  valuation: parseMinor(s.valuation),
  avg: s.avg === null ? null : toC10(s.avg),
  lastStockSeq: 0n,
});

describe('vectors/supplier-return-vectors.json — cannot drift', () => {
  it('is byte-identical to a fresh regeneration (run scripts/generate-s5-vectors.ts after a SPEC change only)', async () => {
    expect(await renderSupplierReturnVectors()).toBe(committed);
  });

  it('carries every case §4.1 names, each once', () => {
    const ids = vectors.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'CUMULATIVE-THIRDS',
      'FULL-RETURN-EXACT',
      'LANDED-INCLUDED',
      'FOREIGN-DUST',
      'AP-FIRST-EXCESS',
      'AP-EXHAUSTED',
      'PPV-POSITIVE',
      'PPV-NEGATIVE',
      'VALUE-ZERO',
      'BELOW-BASE-UNIT',
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe('A-10 — every vector replayed from the JSON alone', () => {
  for (const c of vectors.cases) {
    it(`${c.id}: each return, from the state the previous one stored`, () => {
      const p = c.purchase;
      const convert = convertAt(p.rate, p.txnMinorUnits, p.baseMinorUnits);
      const T = parseMinor(p.totalTxnMinor);
      const B = parseMinor(p.totalBaseMinor);
      expect(convert(T)).toBe(B);
      const states = p.lines.map((l) => stateOf(l.stockAfterReceipt));
      const returned = p.lines.map(() => 0n);
      let released = 0n;
      for (const r of c.returns) {
        const O = parseMinor(r.outstanding.txnMinor);
        if (r.outstanding.source === 'derived') expect(O).toBe(T - released);
        const input: SupplierReturnPlanInput = {
          totalTxnMinor: T,
          totalBaseMinor: B,
          outstandingTxnMinor: O,
          convert,
          lines: r.lines.map((l): SupplierReturnLineInput => {
            const pl = p.lines[l.lineNo - 1];
            if (pl === undefined) throw new Error('no such line');
            return {
              lineTotalTxnMinor: parseMinor(pl.lineTotalTxnMinor),
              purchasedQ4: toQ4(pl.qty),
              returnedBeforeQ4: returned[l.lineNo - 1] ?? 0n,
              returnQ4: toQ4(l.qty),
              stock: states[l.lineNo - 1] ?? EMPTY_STOCK_STATE,
            };
          }),
        };
        expect(codeOf(() => planSupplierReturn(input))).toBe(r.outcome);
        if (r.expect === null) continue;
        const plan = planSupplierReturn(input);
        const e = r.expect;
        expect(
          [
            plan.carryingTxnMinor,
            plan.apTxnMinor,
            plan.apBaseMinor,
            plan.apConvertedMinor,
            plan.apDustBaseMinor,
            plan.creditTxnMinor,
            plan.creditBaseMinor,
            plan.inventoryValueMinor,
            plan.ppvMinor,
          ].map(formatMinor),
        ).toEqual([
          e.carryingTxnMinor,
          e.apTxnMinor,
          e.apBaseMinor,
          e.apConvertedMinor,
          e.apDustBaseMinor,
          e.creditTxnMinor,
          e.creditBaseMinor,
          e.inventoryValueMinor,
          e.ppvMinor,
        ]);
        expect(plan.creditNote).toBe(e.creditNote);
        plan.lines.forEach((l, k) => {
          const ev = e.lines[k];
          expect(formatMinor(l.carryingTxnMinor)).toBe(ev?.carryingTxnMinor);
          expect(formatMinor(l.valueOutMinor)).toBe(ev?.valueOutMinor);
          expect(formatUnitCost(l.unitCostSnapshotC10)).toBe(ev?.unitCostBaseMinor);
          expect(formatQuantity(l.stockAfter.onHand)).toBe(ev?.stockAfter.onHand);
          expect(formatMinor(l.stockAfter.valuation)).toBe(ev?.stockAfter.valuation);
          const i = (r.lines[k]?.lineNo ?? 0) - 1;
          states[i] = l.stockAfter;
          returned[i] = (returned[i] ?? 0n) + toQ4(r.lines[k]?.qty ?? '0');
        });
        expect(
          plan.entryLines.map((l) => [
            l.systemKey,
            l.side,
            l.currency === 'purchase' ? p.txnCurrency : p.baseCurrency,
            formatMinor(l.txnAmountMinor),
            formatMinor(l.baseAmountMinor),
            l.dimension,
          ]),
        ).toEqual(e.entry.map((l) => [l.systemKey, l.side, l.currency, l.txnAmountMinor, l.baseAmountMinor, l.dimension]));
        released += plan.apTxnMinor;
      }
    });
  }

  it('every accepted return: the header CHECKs of §2.2, a balanced entry, no 6100/revenue/tax line, each purchase-currency line satisfying 0043', () => {
    for (const c of vectors.cases) {
      const convert = convertAt(c.purchase.rate, c.purchase.txnMinorUnits, c.purchase.baseMinorUnits);
      for (const r of c.returns) {
        const e = r.expect;
        if (e === null) continue;
        const n = (s: string): bigint => parseMinor(s);
        expect(n(e.apTxnMinor) + n(e.creditTxnMinor)).toBe(n(e.carryingTxnMinor));
        expect(n(e.creditTxnMinor) === 0n).toBe(n(e.creditBaseMinor) === 0n);
        expect(n(e.ppvMinor)).toBe(n(e.apBaseMinor) + n(e.creditBaseMinor) - n(e.inventoryValueMinor));
        expect(n(e.carryingTxnMinor) === 0n && n(e.inventoryValueMinor) === 0n).toBe(false);
        let balance = 0n;
        for (const l of e.entry) {
          expect(['accounts_payable', 'supplier_receivable', 'inventory', 'purchase_price_variance']).toContain(l.systemKey);
          expect(n(l.baseAmountMinor) > 0n).toBe(true);
          if (l.currency === c.purchase.txnCurrency && l.rate !== '1.0000000000') expect(convert(n(l.txnAmountMinor))).toBe(n(l.baseAmountMinor));
          if (l.rate === '1.0000000000') expect(l.txnAmountMinor).toBe(l.baseAmountMinor);
          balance += l.side === 'D' ? n(l.baseAmountMinor) : -n(l.baseAmountMinor);
        }
        expect(balance).toBe(0n);
        expect(e.entry.some((l) => l.side === 'D')).toBe(true);
      }
    }
  });

  it('a domestic purchase never produces a dust line (TL-3)', () => {
    for (const c of vectors.cases.filter((x) => x.purchase.txnCurrency === x.purchase.baseCurrency)) {
      for (const r of c.returns) if (r.expect !== null) expect(r.expect.apDustBaseMinor).toBe('0');
    }
  });
});

describe('carryingTxn — A-10(a), cumulative', () => {
  it('CUMULATIVE-THIRDS: 33, 34, 33, while the naive proportional-plus-flush form gives 33, 33, 34', () => {
    const q = toQ4('1');
    const qty = toQ4('3');
    expect([carryingTxn(100n, qty, 0n, q), carryingTxn(100n, qty, q, q), carryingTxn(100n, qty, 2n * q, q)]).toEqual([33n, 34n, 33n]);
    expect(vectors.cases.find((c) => c.id === 'CUMULATIVE-THIRDS')?.naiveProportionalPlusFlush).toEqual(['33', '33', '34']);
  });

  it('never negative where the naive form goes negative: t = 3 over 5, five returns of 1 → naive 1,1,1,1,−1; cumulative 1,0,1,0,1', () => {
    const q = toQ4('1');
    const qty = toQ4('5');
    const naive = [0, 1, 2, 3].map(() => roundHalfEven(3n * q, qty));
    naive.push(3n - naive.reduce((a, b) => a + b, 0n));
    expect(naive).toEqual([1n, 1n, 1n, 1n, -1n]);
    expect([0n, 1n, 2n, 3n, 4n].map((k) => carryingTxn(3n, qty, k * q, q))).toEqual([1n, 0n, 1n, 0n, 1n]);
  });

  it('for every partition of a line into returns, each part is ≥ 0 and the parts add up to exactly t', () => {
    const partitions = [
      ['0.0007', '0.0001'],
      ['7.5', '0.5'],
      ['7.5', '1'],
      ['7.5', '2.3'],
      ['7.5', '7.5'],
      ['3', '0.7'],
    ].map(([q, s]) => [toQ4(q ?? '0'), toQ4(s ?? '0')] as const);
    for (const t of [0n, 1n, 2n, 99n, 100n, 101n, 12345n, 999_999_999_999n]) {
      for (const [qty, step] of partitions) {
        let before = 0n;
        let sum = 0n;
        while (before < qty) {
          const q = before + step > qty ? qty - before : step;
          const part = carryingTxn(t, qty, before, q);
          expect(part >= 0n).toBe(true);
          sum += part;
          before += q;
        }
        expect(sum).toBe(t);
      }
    }
  });

  it('refuses a cumulative quantity above the purchased one (Must-prove 1), and a non-positive quantity', () => {
    const qty = toQ4('3');
    expect(codeOf(() => carryingTxn(100n, qty, toQ4('2'), toQ4('1.0001')))).toBe('supplier_return.quantity_exceeds_purchased');
    expect(codeOf(() => carryingTxn(100n, qty, toQ4('3'), toQ4('0.0001')))).toBe('supplier_return.quantity_exceeds_purchased');
    expect(codeOf(() => carryingTxn(100n, qty, toQ4('2'), toQ4('1')))).toBe('accepted');
    expect(codeOf(() => carryingTxn(100n, qty, 0n, 0n))).toBe('inventory.quantity_invalid');
    expect(codeOf(() => carryingTxn(100n, qty, -1n, 1n))).toBe('inventory.quantity_invalid');
    expect(codeOf(() => carryingTxn(-1n, qty, 0n, 1n))).toBe('inventory.arithmetic_invalid');
    expect(codeOf(() => carryingTxn(100n, 0n, 0n, 1n))).toBe('inventory.quantity_invalid');
  });
});

describe('apSplit, apBaseRelease, ppv — A-10(c), (d), (f)', () => {
  it('AP first: min(C, O), the rest a credit', () => {
    expect(apSplit(4000n, 2500n)).toEqual({ apTxnMinor: 2500n, creditTxnMinor: 1500n });
    expect(apSplit(4000n, 9000n)).toEqual({ apTxnMinor: 4000n, creditTxnMinor: 0n });
    expect(apSplit(4000n, 0n)).toEqual({ apTxnMinor: 0n, creditTxnMinor: 4000n });
    expect(apSplit(0n, 10n)).toEqual({ apTxnMinor: 0n, creditTxnMinor: 0n });
    expect(codeOf(() => apSplit(-1n, 10n))).toBe('inventory.arithmetic_invalid');
    expect(codeOf(() => apSplit(1n, -1n))).toBe('inventory.arithmetic_invalid');
  });

  it('releases B cumulatively and proportionally, exactly B at clearing, for any sequence of releases', () => {
    for (const [T, B] of [
      [1001n, 511n],
      [10000n, 36725n],
      [3n, 1n],
      [7n, 1_000_000_007n],
    ] as const) {
      for (const step of [1n, 2n, 3n, 333n, 1000n]) {
        let O = T;
        let base = 0n;
        while (O > 0n) {
          const ap = step < O ? step : O;
          const r = apBaseRelease(B, T, O, ap);
          expect(r >= 0n).toBe(true);
          expect(r).toBe(roundHalfEven(B * (T - O + ap), T) - roundHalfEven(B * (T - O), T));
          base += r;
          O -= ap;
        }
        expect(base).toBe(B);
      }
    }
    expect(apBaseRelease(511n, 1001n, 1001n, 0n)).toBe(0n);
  });

  it('refuses an outstanding AP above T, a release above O, and a non-positive total', () => {
    expect(codeOf(() => apBaseRelease(511n, 1001n, 1002n, 1n))).toBe('inventory.arithmetic_invalid');
    expect(codeOf(() => apBaseRelease(511n, 1001n, 10n, 11n))).toBe('inventory.arithmetic_invalid');
    expect(codeOf(() => apBaseRelease(0n, 1001n, 10n, 1n))).toBe('inventory.arithmetic_invalid');
    expect(codeOf(() => apBaseRelease(511n, 0n, 0n, 0n))).toBe('inventory.arithmetic_invalid');
  });

  it('ppv = ap_base + credit_base − I, signed', () => {
    expect(ppv(600n, 0n, 550n)).toBe(50n);
    expect(ppv(600n, 0n, 650n)).toBe(-50n);
    expect(ppv(9181n, 5509n, 14690n)).toBe(0n);
    expect(codeOf(() => ppv(-1n, 0n, 0n))).toBe('inventory.arithmetic_invalid');
  });
});

describe('planSupplierReturn — refusals in the routine order', () => {
  const key = (onHand: string, valuation: bigint): StockState => ({
    onHand: toQ4(onHand),
    valuation,
    avg: roundHalfEven(valuation * 10n ** 14n, toQ4(onHand)),
    lastStockSeq: 1n,
  });
  const base = (over: Partial<SupplierReturnLineInput> = {}): SupplierReturnPlanInput => ({
    totalTxnMinor: 1000n,
    totalBaseMinor: 1000n,
    outstandingTxnMinor: 1000n,
    convert: (x) => x,
    lines: [{ lineTotalTxnMinor: 1000n, purchasedQ4: toQ4('10'), returnedBeforeQ4: 0n, returnQ4: toQ4('1'), stock: key('10', 1000n), ...over }],
  });

  it('a quantity above the purchased one wins over an insufficient key', () => {
    expect(codeOf(() => planSupplierReturn(base({ returnQ4: toQ4('11'), stock: key('1', 100n) })))).toBe('supplier_return.quantity_exceeds_purchased');
  });

  it('a key holding less than q is inventory.insufficient_stock (Must-prove 2); exactly on hand flushes the whole valuation', () => {
    expect(codeOf(() => planSupplierReturn(base({ returnQ4: toQ4('2'), stock: key('1', 100n) })))).toBe('inventory.insufficient_stock');
    expect(codeOf(() => planSupplierReturn(base({ stock: EMPTY_STOCK_STATE })))).toBe('inventory.insufficient_stock');
    const flushed = planSupplierReturn(base({ returnQ4: toQ4('3'), stock: key('3', 301n) }));
    expect(flushed.inventoryValueMinor).toBe(301n);
    expect(flushed.lines[0]?.stockAfter.valuation).toBe(0n);
  });

  it('refuses no line and more than 200 lines, and a conversion that is not a function or returns a negative', () => {
    expect(codeOf(() => planSupplierReturn({ ...base(), lines: [] }))).toBe('inventory.lines_required');
    const line = base().lines[0] as SupplierReturnLineInput;
    expect(codeOf(() => planSupplierReturn({ ...base(), lines: Array.from({ length: 201 }, () => line) }))).toBe('inventory.payload_invalid');
    expect(codeOf(() => planSupplierReturn({ ...base(), convert: () => -1n }))).toBe('inventory.arithmetic_invalid');
  });

  it('the credit path: a credit_txn converting to 0 is amount_below_base_unit (TL-3), like an AP amount', () => {
    const tiny = (x: bigint): bigint => roundHalfEven(x * 49n, 1000n);
    expect(
      codeOf(() =>
        planSupplierReturn({ ...base({ lineTotalTxnMinor: 100n, returnQ4: toQ4('0.1') }), totalTxnMinor: 100n, outstandingTxnMinor: 0n, convert: tiny }),
      ),
    ).toBe('supplier_return.amount_below_base_unit');
  });

  it('in S5 production (O derived), C never exceeds O, so no credit note is ever issued', () => {
    for (const c of vectors.cases) {
      for (const r of c.returns) if (r.outstanding.source === 'derived' && r.expect !== null) expect(r.expect.creditTxnMinor).toBe('0');
    }
  });
});

describe('supplierReturnEntryLines — A-10(g)', () => {
  const zero = {
    apTxnMinor: 0n,
    apConvertedMinor: 0n,
    apDustBaseMinor: 0n,
    creditTxnMinor: 0n,
    creditBaseMinor: 0n,
    inventoryValueMinor: 0n,
    ppvMinor: 0n,
  };

  it('orders AP, dust, 1150, inventory, PPV and omits zero lines', () => {
    const lines = supplierReturnEntryLines({
      apTxnMinor: 10n,
      apConvertedMinor: 50n,
      apDustBaseMinor: 1n,
      creditTxnMinor: 5n,
      creditBaseMinor: 25n,
      inventoryValueMinor: 70n,
      ppvMinor: 6n,
    });
    expect(lines.map((l) => `${l.systemKey}:${l.side}:${l.currency}:${l.baseAmountMinor}:${l.dimension}`)).toEqual([
      'accounts_payable:D:purchase:50:purchase',
      'accounts_payable:D:base:1:purchase',
      'supplier_receivable:D:purchase:25:purchase',
      'inventory:C:base:70:return',
      'purchase_price_variance:C:base:6:return',
    ]);
    expect(supplierReturnEntryLines({ ...zero, inventoryValueMinor: 5n, ppvMinor: -5n }).map((l) => `${l.systemKey}:${l.side}`)).toEqual([
      'inventory:C',
      'purchase_price_variance:D',
    ]);
  });

  it('refuses an unbalanced set and an entry with no debit', () => {
    expect(codeOf(() => supplierReturnEntryLines({ ...zero, apTxnMinor: 1n, apConvertedMinor: 1n, inventoryValueMinor: 2n, ppvMinor: 0n }))).toBe(
      'inventory.arithmetic_invalid',
    );
    expect(codeOf(() => supplierReturnEntryLines(zero))).toBe('inventory.arithmetic_invalid');
  });
});
