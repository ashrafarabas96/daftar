/**
 * P13-S6 — tests for the redemption allocation.
 *
 * The law under test, re-read at `93084f8` by this session:
 * `packages/inventory/src/sale-payloads.ts:317` —
 * *"the line nets must add up to the discounted subtotal exactly"*, i.e.
 * `sum(line nets) === subtotal − header discount`.
 *
 * Nothing here asserts that the header discount equals the sum of the line
 * discounts: nothing in the validator pins the subtotal to the sum of the line
 * grosses, so that identity does not follow from the code. The allocation
 * function is not even given a gross to be tempted by.
 *
 * Several cases below are NAMED RED PROOFS. Each one runs a deliberately
 * broken implementation beside the real one and asserts that the broken one
 * fails the law — `P13-S0 §5`'s requirement that a conservation test come with
 * *a canary case that must FAIL*, so that a test which cannot tell the two
 * apart is caught instead of trusted.
 */
import { describe, expect, it } from 'vitest';
import {
  absorptionCapacityMinor,
  allocateRedemption,
  redemptionHeaderEffect,
  type AllocatableLine,
  type AllocationPolicy,
  type RemainderDestination,
} from '../src/loyalty/allocation';
import { LoyaltyRefusal } from '../src/loyalty/points';

/** Indexed access that narrows instead of asserting: the repository forbids the
 *  non-null assertion, and a test that indexes a result should fail loudly on a
 *  missing entry rather than compare `undefined`. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be present`);
  return value;
}


const line = (lineId: string, netTxnMinor: bigint, qtyQ4: bigint): AllocatableLine => ({ lineId, netTxnMinor, qtyQ4 });

const REMAINDER_DESTINATIONS: readonly RemainderDestination[] = ['largest_basis_first', 'first_line_first', 'last_line_first'];

/** Every policy this module admits, so no case is accidentally single-policy. */
const ALL_POLICIES: readonly AllocationPolicy[] = [
  ...REMAINDER_DESTINATIONS.map((remainderTo) => ({ basis: 'pro_rata_by_net', remainderTo }) as const),
  ...REMAINDER_DESTINATIONS.map((remainderTo) => ({ basis: 'by_quantity', remainderTo }) as const),
  { basis: 'first_line_first' } as const,
];

/**
 * The awkward baskets. Primes, 1-minor-unit values, a line of net 0, a basket
 * whose nets are coprime with the value, and a basket above
 * `Number.MAX_SAFE_INTEGER` so that a float implementation cannot pass by luck.
 */
const BASKETS: readonly { readonly name: string; readonly lines: readonly AllocatableLine[] }[] = [
  { name: 'three primes', lines: [line('a', 97n, 10000n), line('b', 101n, 20000n), line('c', 103n, 30000n)] },
  { name: 'a line of net 0', lines: [line('a', 0n, 50000n), line('b', 7n, 10000n), line('c', 11n, 10000n)] },
  { name: 'every line net 1', lines: [line('a', 1n, 10000n), line('b', 1n, 10000n), line('c', 1n, 10000n), line('d', 1n, 10000n)] },
  { name: 'one line only', lines: [line('a', 7919n, 10000n)] },
  { name: 'wildly uneven', lines: [line('a', 1n, 990000n), line('b', 999983n, 10000n)] },
  { name: 'seven lines, prime nets', lines: [2n, 3n, 5n, 7n, 11n, 13n, 17n].map((n, i) => line(`l${i}`, n, BigInt(i + 1) * 10000n)) },
  {
    name: 'above Number.MAX_SAFE_INTEGER',
    lines: [line('a', 9007199254740993n, 10000n), line('b', 9007199254740993n, 30000n), line('c', 3n, 10000n)],
  },
  { name: 'all nets zero', lines: [line('a', 0n, 10000n), line('b', 0n, 10000n)] },
];

/** The values tried against every basket: 1 minor unit, primes, and the extremes. */
function valuesFor(lines: readonly AllocatableLine[]): bigint[] {
  const capacity = absorptionCapacityMinor(lines);
  const candidates = [0n, 1n, 2n, 3n, 7n, 13n, 97n, 101n, 7919n, 104729n, capacity - 1n, capacity];
  return [...new Set(candidates.filter((v) => v >= 0n && v <= capacity).map((v) => v.toString()))].map((v) => BigInt(v));
}

describe('allocateRedemption — the conservation law of sale-payloads.ts:317', () => {
  it('places every minor unit, over every basket, value and policy, with a remainder of exactly zero', () => {
    let cases = 0;
    for (const basket of BASKETS) {
      for (const value of valuesFor(basket.lines)) {
        for (const policy of ALL_POLICIES) {
          const result = allocateRedemption(value, basket.lines, policy);
          const sum = result.lines.reduce((acc, l) => acc + l.allocatedMinor, 0n);
          expect(sum, `${basket.name} / ${value} / ${policy.basis}`).toBe(value);
          expect(result.totalAllocatedMinor).toBe(value);
          expect(result.remainderMinor).toBe(0n);
          cases += 1;
        }
      }
    }
    // The battery is wide on purpose; a single happy path would not have found
    // the by_quantity saturation case at all.
    expect(cases).toBeGreaterThan(200);
  });

  it('never drives a line net negative and never exceeds a line capacity', () => {
    for (const basket of BASKETS) {
      for (const value of valuesFor(basket.lines)) {
        for (const policy of ALL_POLICIES) {
          const result = allocateRedemption(value, basket.lines, policy);
          for (const [index, allocated] of result.lines.entries()) {
            const source = must(basket.lines[index], 'basket.lines entry');
            expect(allocated.allocatedMinor >= 0n).toBe(true);
            expect(allocated.allocatedMinor <= source.netTxnMinor).toBe(true);
            expect(allocated.netAfterMinor).toBe(source.netTxnMinor - allocated.allocatedMinor);
            expect(allocated.netAfterMinor >= 0n).toBe(true);
          }
        }
      }
    }
  });

  it('keeps the measured header identity: the nets still add up to the discounted subtotal', () => {
    // A basket whose nets sum to `subtotal − discount` with a header discount
    // already in place. Note the subtotal here is deliberately NOT the sum of
    // any line gross — the validator does not pin it to one, so neither does
    // this case.
    const lines = [line('a', 1234n, 10000n), line('b', 5n, 70000n), line('c', 761n, 10000n)];
    const subtotal = 9000n;
    const discountBefore = 7000n;
    expect(absorptionCapacityMinor(lines)).toBe(subtotal - discountBefore);

    for (const policy of ALL_POLICIES) {
      for (const value of [1n, 2n, 97n, 1999n, 2000n]) {
        const allocation = allocateRedemption(value, lines, policy);
        const effect = redemptionHeaderEffect(subtotal, discountBefore, allocation);
        expect(effect.identityHolds, `${policy.basis} / ${value}`).toBe(true);
        expect(effect.lineNetsAfterMinor).toBe(subtotal - discountBefore - value);
      }
    }
  });

  it('is deterministic: the same inputs give byte-identical output', () => {
    const lines = must(BASKETS[0], 'BASKETS entry').lines;
    for (const policy of ALL_POLICIES) {
      const render = (): string =>
        JSON.stringify(allocateRedemption(199n, lines, policy).lines.map((l) => [l.lineId, l.allocatedMinor.toString()]));
      expect(render()).toBe(render());
      expect(render()).toBe(render());
    }
  });

  it('honours the remainder destination, because the remainder is money', () => {
    // 10 minor units over three equal lines: 3 each proportionally, 1 left.
    const lines = [line('a', 100n, 10000n), line('b', 100n, 20000n), line('c', 100n, 30000n)];
    const at = (destination: RemainderDestination): string[] =>
      allocateRedemption(10n, lines, { basis: 'pro_rata_by_net', remainderTo: destination }).lines
        .filter((l) => l.allocatedMinor === 4n)
        .map((l) => l.lineId);

    expect(at('first_line_first')).toEqual(['a']);
    expect(at('last_line_first')).toEqual(['c']);
    // Equal net weights, so `largest_basis_first` ties to the earliest line —
    // a total order, not an executor's whim.
    expect(at('largest_basis_first')).toEqual(['a']);

    // By quantity the weights differ, so the largest basis is line `c`.
    const byQty = allocateRedemption(10n, lines, { basis: 'by_quantity', remainderTo: 'largest_basis_first' });
    expect(byQty.lines.map((l) => l.allocatedMinor)).toEqual([1n, 3n, 6n]);
  });

  it('first_line_first fills in order and cannot produce a remainder at all', () => {
    const lines = [line('a', 5n, 10000n), line('b', 5n, 10000n), line('c', 5n, 10000n)];
    const result = allocateRedemption(7n, lines, { basis: 'first_line_first' });
    expect(result.lines.map((l) => l.allocatedMinor)).toEqual([5n, 2n, 0n]);
    expect(result.remainderMinor).toBe(0n);
  });

  it('by_quantity saturates a cheap high-quantity line and redistributes the excess', () => {
    // Line `a` would take 9/10 of the value by quantity but can absorb only 2.
    const lines = [line('a', 2n, 900000n), line('b', 1000n, 100000n)];
    const result = allocateRedemption(100n, lines, { basis: 'by_quantity', remainderTo: 'largest_basis_first' });
    expect(result.lines.map((l) => l.allocatedMinor)).toEqual([2n, 98n]);
    expect(result.totalAllocatedMinor).toBe(100n);
  });
});

describe('allocateRedemption — refusals, never a rounded-into-existence value', () => {
  const lines = [line('a', 10n, 10000n), line('b', 5n, 10000n)];

  it('refuses a value above what the lines can absorb, and does not clamp it', () => {
    // F-06 — asserted by code, not by class: `toThrow(LoyaltyRefusal)` would
    // also pass if the call refused for a reason this case rules out.
    let firstLineRefusal: unknown;
    try {
      allocateRedemption(16n, lines, { basis: 'first_line_first' });
    } catch (error) {
      firstLineRefusal = error;
    }
    expect(firstLineRefusal).toBeInstanceOf(LoyaltyRefusal);
    expect((firstLineRefusal as LoyaltyRefusal).code).toBe('loyalty.allocation_exceeds_capacity');
    try {
      allocateRedemption(16n, lines, { basis: 'pro_rata_by_net', remainderTo: 'first_line_first' });
      expect.unreachable('a redemption above capacity must refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(LoyaltyRefusal);
      expect((error as LoyaltyRefusal).code).toBe('loyalty.allocation_exceeds_capacity');
      expect((error as LoyaltyRefusal).httpStatus).toBe(422);
    }
  });

  it('refuses a zero-capacity basket asked to absorb anything', () => {
    const zeroes = [line('a', 0n, 10000n), line('b', 0n, 10000n)];
    expect(() => allocateRedemption(1n, zeroes, { basis: 'pro_rata_by_net', remainderTo: 'largest_basis_first' })).toThrow(
      LoyaltyRefusal,
    );
    // Zero over a zero-capacity basket is lawful and allocates nothing.
    const nothing = allocateRedemption(0n, zeroes, { basis: 'by_quantity', remainderTo: 'largest_basis_first' });
    expect(nothing.totalAllocatedMinor).toBe(0n);
    expect(nothing.remainderMinor).toBe(0n);
  });

  it('refuses an empty line set, a negative value and a negative net', () => {
    expect(() => allocateRedemption(1n, [], { basis: 'first_line_first' })).toThrow(/no lines/);
    expect(() => allocateRedemption(-1n, lines, { basis: 'first_line_first' })).toThrow(/must not be negative/);
    expect(() => allocateRedemption(1n, [line('a', -1n, 10000n)], { basis: 'first_line_first' })).toThrow(/net must not be negative/);
    expect(() => allocateRedemption(1n, [line('a', 10n, -1n)], { basis: 'by_quantity', remainderTo: 'first_line_first' })).toThrow(
      /quantity must not be negative/,
    );
  });
});

describe('RED PROOFS — implementations that violate the law, proved to violate it', () => {
  const lines = [line('a', 97n, 10000n), line('b', 101n, 20000n), line('c', 103n, 30000n)];
  const value = 199n;

  it('RED PROOF 1 — a floored pro-rata pass with no remainder phase leaves a remainder; the real one does not', () => {
    // The naive allocator: exactly the proportional pass and nothing after it.
    const totalWeight = lines.reduce((acc, l) => acc + l.netTxnMinor, 0n);
    const naive = lines.map((l) => (value * l.netTxnMinor) / totalWeight);
    const naiveTotal = naive.reduce((acc, v) => acc + v, 0n);

    // The canary: if this ever stopped being short, the case below would be
    // proving nothing and this assertion is what says so.
    expect(naive).toEqual([64n, 66n, 68n]);
    expect(naiveTotal).toBe(198n);
    expect(value - naiveTotal).toBe(1n);

    const real = allocateRedemption(value, lines, { basis: 'pro_rata_by_net', remainderTo: 'largest_basis_first' });
    expect(real.totalAllocatedMinor).toBe(value);
    expect(real.remainderMinor).toBe(0n);
  });

  it('RED PROOF 2 — a float allocator loses a minor unit above Number.MAX_SAFE_INTEGER; the bigint one does not', () => {
    const big = [line('a', 9007199254740993n, 10000n), line('b', 9007199254740993n, 10000n), line('c', 3n, 10000n)];
    const v = 9007199254740999n;

    // The moment the value enters a float it is ALREADY wrong, before any
    // division: 9007199254740999 is odd and above 2^53, so it is not a
    // representable double. `money.ts:9-13` at 93084f8: no JS float ever
    // touches money, and this is the whole of the reason.
    expect(Number.isSafeInteger(Number(v))).toBe(false);
    expect(BigInt(Number(v)) === v).toBe(false);
    expect(BigInt(Number(v))).toBe(9007199254741000n);

    // And the float allocator's total is off by one minor unit — PART 8's
    // "one unexplained minor unit = DEFECT", reproduced on demand.
    const floatCapacity = big.reduce((acc, l) => acc + Number(l.netTxnMinor), 0);
    const floatAllocated = big.map((l) => Math.floor((Number(v) * Number(l.netTxnMinor)) / floatCapacity));
    const floatTotal = floatAllocated.reduce((acc, n) => acc + n, 0);
    expect(BigInt(floatTotal) === v).toBe(false);
    expect(BigInt(floatTotal) - v).toBe(1n);

    const real = allocateRedemption(v, big, { basis: 'pro_rata_by_net', remainderTo: 'largest_basis_first' });
    expect(real.totalAllocatedMinor).toBe(v);
    // And every digit survives, which `Number` cannot promise at this size.
    expect(real.lines.reduce((acc, l) => acc + l.allocatedMinor, 0n).toString()).toBe('9007199254740999');
  });

  it('RED PROOF 3 — an uncapped quantity split drives a line net negative; the real one caps and redistributes', () => {
    const uneven = [line('a', 2n, 900000n), line('b', 1000n, 100000n)];
    const v = 100n;
    const weight = uneven.reduce((acc, l) => acc + l.qtyQ4, 0n);
    const uncapped = uneven.map((l) => (v * l.qtyQ4) / weight);
    // The canary: the naive share really does exceed line `a`'s own net.
    expect(must(uncapped[0], 'uncapped entry')).toBe(90n);
    expect(must(uncapped[0], 'uncapped entry') > must(uneven[0], 'uneven entry').netTxnMinor).toBe(true);
    expect(must(uneven[0], 'uneven entry').netTxnMinor - must(uncapped[0], 'uncapped entry') < 0n).toBe(true);

    const real = allocateRedemption(v, uneven, { basis: 'by_quantity', remainderTo: 'largest_basis_first' });
    for (const [index, allocated] of real.lines.entries()) {
      expect(allocated.netAfterMinor >= 0n).toBe(true);
      expect(allocated.allocatedMinor <= must(uneven[index], 'uneven entry').netTxnMinor).toBe(true);
    }
    expect(real.totalAllocatedMinor).toBe(v);
  });

  it('RED PROOF 4 — a header-only redemption breaks sale-payloads.ts:317; the split does not', () => {
    // Taking the redemption at the header alone: the discount grows by V and
    // the line nets are untouched, which is precisely the refusal
    // `the line nets must add up to the discounted subtotal exactly`.
    const subtotal = 9000n;
    const discountBefore = 8699n;
    const basket = [line('a', 97n, 10000n), line('b', 101n, 10000n), line('c', 103n, 10000n)];
    expect(absorptionCapacityMinor(basket)).toBe(subtotal - discountBefore);

    const v = 199n;
    const headerOnlyNets = basket.reduce((acc, l) => acc + l.netTxnMinor, 0n);
    const headerOnlyDiscounted = subtotal - (discountBefore + v);
    expect(headerOnlyNets === headerOnlyDiscounted).toBe(false);

    const allocation = allocateRedemption(v, basket, { basis: 'pro_rata_by_net', remainderTo: 'largest_basis_first' });
    expect(redemptionHeaderEffect(subtotal, discountBefore, allocation).identityHolds).toBe(true);
  });
});
