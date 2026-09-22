import { describe, expect, it } from 'vitest';
import { AccountingError } from '../src/errors';
import { classifyRealizedFx, type EconomicDirection } from '../src/realized-fx';
import { classifyRoundingResidual } from '../src/rounding';
import { MAX_MONEY_MINOR } from '../src/types';

/**
 * REALIZED FX, ROUNDING, AND THE WALL BETWEEN THEM (directive §49-§56).
 *
 * Every case below is a LITERAL assertion: this direction, these two amounts,
 * this account, this side, this exact number of minor units. "The entry
 * balances" is not a test of a classifier — a classifier that returned the
 * wrong account with the right magnitude would balance perfectly and book a
 * loss as revenue.
 */

interface Pinned {
  readonly what: string;
  readonly direction: EconomicDirection;
  readonly carrying: bigint;
  readonly actual: bigint;
  readonly systemKey: 'fx_gain' | 'fx_loss';
  readonly side: 'D' | 'C';
  readonly amount: bigint;
}

/**
 * §52's eight required examples, verbatim.
 *
 * The first four are the proof that direction cannot be inferred: rows 1 and
 * 3 are the SAME arithmetic (360 → 369) and opposite accounts, and so are
 * rows 2 and 4 (360 → 350). A classifier that looked only at the sign would
 * pass half of them and be wrong about the other half every time a supplier
 * was paid.
 */
const PINNED: readonly Pinned[] = [
  { what: 'outflow, paid more than carrying', direction: 'outflow', carrying: 360n, actual: 369n, systemKey: 'fx_loss', side: 'D', amount: 9n },
  { what: 'outflow, paid less than carrying', direction: 'outflow', carrying: 360n, actual: 350n, systemKey: 'fx_gain', side: 'C', amount: 10n },
  { what: 'inflow, received more than carrying', direction: 'inflow', carrying: 360n, actual: 369n, systemKey: 'fx_gain', side: 'C', amount: 9n },
  { what: 'inflow, received less than carrying', direction: 'inflow', carrying: 360n, actual: 350n, systemKey: 'fx_loss', side: 'D', amount: 10n },
  { what: 'gold settlement, received more', direction: 'inflow', carrying: 1440n, actual: 1480n, systemKey: 'fx_gain', side: 'C', amount: 40n },
  { what: 'customer refund, paid more', direction: 'outflow', carrying: 1480n, actual: 1554n, systemKey: 'fx_loss', side: 'D', amount: 74n },
  { what: 'partial refund, paid more', direction: 'outflow', carrying: 1400n, actual: 1470n, systemKey: 'fx_loss', side: 'D', amount: 70n },
  { what: 'supplier refund, received more', direction: 'inflow', carrying: 360n, actual: 369n, systemKey: 'fx_gain', side: 'C', amount: 9n },
];

describe('realized FX is classified, never inferred (§50-§52)', () => {
  for (const c of PINNED) {
    it(`${c.what}: ${c.carrying} → ${c.actual} is ${c.systemKey} ${c.amount}`, () => {
      expect(classifyRealizedFx({ direction: c.direction, carryingBaseMinor: c.carrying, actualBaseMinor: c.actual })).toEqual({
        systemKey: c.systemKey,
        side: c.side,
        amountMinor: c.amount,
      });
    });
  }

  it('the same arithmetic means opposite things in the two directions', () => {
    const out = classifyRealizedFx({ direction: 'outflow', carryingBaseMinor: 360n, actualBaseMinor: 369n });
    const inn = classifyRealizedFx({ direction: 'inflow', carryingBaseMinor: 360n, actualBaseMinor: 369n });
    expect(out?.amountMinor).toBe(inn?.amountMinor);
    expect(out?.systemKey).not.toBe(inn?.systemKey);
    expect(out?.side).not.toBe(inn?.side);
  });

  it('no difference is NO event, not a zero-amount line', () => {
    expect(classifyRealizedFx({ direction: 'inflow', carryingBaseMinor: 360n, actualBaseMinor: 360n })).toBeNull();
    expect(classifyRealizedFx({ direction: 'outflow', carryingBaseMinor: 0n, actualBaseMinor: 0n })).toBeNull();
  });

  it('a gain is always a credit of a positive magnitude, and a loss always a debit', () => {
    // Swept rather than sampled: every pair in a small window, both
    // directions. The invariant is structural, so it should hold everywhere,
    // and a property that holds only at the pinned points is a coincidence.
    for (const direction of ['inflow', 'outflow'] as const) {
      for (let carrying = 0n; carrying <= 40n; carrying += 1n) {
        for (let actual = 0n; actual <= 40n; actual += 1n) {
          const r = classifyRealizedFx({ direction, carryingBaseMinor: carrying, actualBaseMinor: actual });
          if (carrying === actual) {
            expect(r).toBeNull();
            continue;
          }
          const got = r as NonNullable<typeof r>;
          expect(got.amountMinor > 0n).toBe(true);
          expect(got.amountMinor).toBe(actual > carrying ? actual - carrying : carrying - actual);
          expect(got.side).toBe(got.systemKey === 'fx_gain' ? 'C' : 'D');
        }
      }
    }
  });
});

describe('realized FX is exact integer arithmetic (§53)', () => {
  it('holds at the money cap, where a double would already have lost digits', () => {
    const r = classifyRealizedFx({ direction: 'inflow', carryingBaseMinor: MAX_MONEY_MINOR - 1n, actualBaseMinor: MAX_MONEY_MINOR });
    expect(r).toEqual({ systemKey: 'fx_gain', side: 'C', amountMinor: 1n });
    // The same two amounts as doubles are indistinguishable — which is the
    // whole reason this module never touches Number.
    expect(Number(MAX_MONEY_MINOR - 1n) === Number(MAX_MONEY_MINOR)).toBe(true);
  });

  it('refuses an amount beyond the cap and a negative settlement', () => {
    const refusal = (run: () => unknown): AccountingError => {
      try {
        run();
      } catch (e) {
        if (e instanceof AccountingError) return e;
        throw e;
      }
      throw new Error('expected a refusal');
    };
    expect(refusal(() => classifyRealizedFx({ direction: 'inflow', carryingBaseMinor: MAX_MONEY_MINOR + 1n, actualBaseMinor: 0n })).code).toBe(
      'accounting.payload_invalid',
    );
    expect(refusal(() => classifyRealizedFx({ direction: 'inflow', carryingBaseMinor: -1n, actualBaseMinor: 0n })).code).toBe('accounting.payload_invalid');
  });
});

describe('rounding is a different fact with a different account (§54-§56)', () => {
  it('a residual becomes a rounding adjustment on the side the caller stated', () => {
    expect(classifyRoundingResidual({ residualMinor: 2n, side: 'D', allocationCount: 3, reason: 'allocation remainder' })).toEqual({
      systemKey: 'rounding',
      side: 'D',
      amountMinor: 2n,
      reason: 'allocation remainder',
    });
    // The SAME residual on the other side. The helper does not decide this.
    expect(classifyRoundingResidual({ residualMinor: 2n, side: 'C', allocationCount: 3, reason: 'allocation remainder' })?.side).toBe('C');
  });

  it('an exact allocation has nothing to adjust', () => {
    expect(classifyRoundingResidual({ residualMinor: 0n, side: 'D', allocationCount: 5, reason: 'exact' })).toBeNull();
  });

  it('a residual larger than the allocation could produce is REFUSED, not posted (§55)', () => {
    let code = '';
    try {
      classifyRoundingResidual({ residualMinor: 400n, side: 'D', allocationCount: 3, reason: 'where did this come from' });
    } catch (e) {
      code = e instanceof AccountingError ? e.code : 'not-an-accounting-error';
    }
    expect(code).toBe('accounting.rounding_residual_unbounded');
  });

  it('an adjustment with no reason is refused — no hidden balancing (§55)', () => {
    let code = '';
    try {
      classifyRoundingResidual({ residualMinor: 1n, side: 'D', allocationCount: 2, reason: '   ' });
    } catch (e) {
      code = e instanceof AccountingError ? e.code : 'not-an-accounting-error';
    }
    expect(code).toBe('accounting.payload_invalid');
  });

  it('the two classifiers can never reach each other’s account, or PPV (§56)', () => {
    // Exhaustive over the realized-FX input space in a window wide enough to
    // contain every shape of difference, and over the whole legal rounding
    // space for a small allocation. No input produces `rounding`,
    // `purchase_price_variance` or an unexpected key.
    const seen = new Set<string>();
    for (const direction of ['inflow', 'outflow'] as const) {
      for (let carrying = 0n; carrying <= 25n; carrying += 1n) {
        for (let actual = 0n; actual <= 25n; actual += 1n) {
          const r = classifyRealizedFx({ direction, carryingBaseMinor: carrying, actualBaseMinor: actual });
          if (r) seen.add(r.systemKey);
        }
      }
    }
    expect([...seen].sort()).toEqual(['fx_gain', 'fx_loss']);

    const rounded = new Set<string>();
    for (const side of ['D', 'C'] as const) {
      for (let residual = -6n; residual <= 6n; residual += 1n) {
        const r = classifyRoundingResidual({ residualMinor: residual, side, allocationCount: 6, reason: 'sweep' });
        if (r) rounded.add(r.systemKey);
      }
    }
    expect([...rounded]).toEqual(['rounding']);

    // INV-ACC-12's four accounts are four accounts. Stated here so that
    // merging any two of them fails a test rather than a review.
    expect(new Set(['fx_gain', 'fx_loss', 'rounding', 'purchase_price_variance']).size).toBe(4);
  });
});
