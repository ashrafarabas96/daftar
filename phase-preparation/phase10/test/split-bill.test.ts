import { describe, expect, it } from 'vitest';
import { at } from './at';
import { SplitRefusal, assertAmountsConserve, splitByLines, splitEvenly, type SplittableLine } from '../src/split-bill';

/**
 * LAW 4 proofs. Each refusal case asserts the EXACT code, never a bare
 * "it throws" — a test that only proves something threw cannot tell the right
 * refusal from the wrong one.
 */
describe('splitEvenly — LAW 4, exact conservation', () => {
  it('conserves the total for every total x parts in a wide grid, and the grid is not empty', () => {
    const totals = [0n, 1n, 2n, 7n, 99n, 100n, 1000n, 123_457n, 9_007_199_254_740_993n, 10n ** 18n];
    const partCounts = [1, 2, 3, 4, 5, 7, 11, 16, 97];
    let cases = 0;
    for (const total of totals) {
      for (const parts of partCounts) {
        const shares = splitEvenly(total, parts);
        expect(shares).toHaveLength(parts);
        expect(shares.reduce((a, b) => a + b, 0n)).toBe(total);
        for (const share of shares) expect(share >= 0n).toBe(true);
        const max = shares.reduce((a, b) => (a > b ? a : b));
        const min = shares.reduce((a, b) => (a < b ? a : b));
        expect(max - min <= 1n).toBe(true);
        cases += 1;
      }
    }
    // Non-vacuity: a green run above means nothing if the grid were empty.
    expect(cases).toBe(totals.length * partCounts.length);
    expect(cases).toBeGreaterThan(0);
  });

  it('places the remainder on the first shares, in order, so the answer is explainable', () => {
    expect(splitEvenly(1000n, 3)).toEqual([334n, 333n, 333n]);
    expect(splitEvenly(10n, 4)).toEqual([3n, 3n, 2n, 2n]);
    expect(splitEvenly(7n, 7)).toEqual([1n, 1n, 1n, 1n, 1n, 1n, 1n]);
  });

  it('is deterministic: the same bill split twice gives the identical answer', () => {
    expect(splitEvenly(99_991n, 13)).toEqual(splitEvenly(99_991n, 13));
  });

  it('refuses zero parts by code', () => {
    expect(() => splitEvenly(100n, 0)).toThrowError(expect.objectContaining({ code: 'restaurant.split.parts_not_positive' }));
  });

  it('refuses a fractional part count by code', () => {
    expect(() => splitEvenly(100n, 2.5)).toThrowError(expect.objectContaining({ code: 'restaurant.split.parts_not_positive' }));
  });

  it('refuses a negative total by code', () => {
    expect(() => splitEvenly(-1n, 2)).toThrowError(expect.objectContaining({ code: 'restaurant.split.total_negative' }));
  });
});

describe('assertAmountsConserve — a settlement split that does not add up is refused, not adjusted', () => {
  it('accepts an exact set', () => {
    expect(() => assertAmountsConserve(1000n, [400n, 350n, 250n])).not.toThrow();
  });

  it('accepts zero amounts inside an exact set (a guest who pays nothing)', () => {
    expect(() => assertAmountsConserve(1000n, [1000n, 0n])).not.toThrow();
  });

  it('refuses a one-minor-unit shortfall by code, and reports the difference', () => {
    try {
      assertAmountsConserve(1000n, [400n, 350n, 249n]);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SplitRefusal);
      const refusal = error as SplitRefusal;
      expect(refusal.code).toBe('restaurant.split.amounts_do_not_conserve');
      expect(refusal.details?.differenceMinor).toBe('1');
    }
  });

  it('refuses an overshoot by the same code', () => {
    expect(() => assertAmountsConserve(1000n, [600n, 500n])).toThrowError(expect.objectContaining({ code: 'restaurant.split.amounts_do_not_conserve' }));
  });

  it('refuses a negative amount by its own code, not by the conservation code', () => {
    expect(() => assertAmountsConserve(1000n, [1100n, -100n])).toThrowError(expect.objectContaining({ code: 'restaurant.split.amount_negative' }));
  });

  it('refuses an empty amount set', () => {
    expect(() => assertAmountsConserve(0n, [])).toThrowError(expect.objectContaining({ code: 'restaurant.split.parts_not_positive' }));
  });
});

describe('splitByLines — the assignment must be a partition', () => {
  const lines: readonly SplittableLine[] = [
    { lineId: 'l1', lineTotalMinor: 1200n },
    { lineId: 'l2', lineTotalMinor: 800n },
    { lineId: 'l3', lineTotalMinor: 500n },
  ];

  it('splits into bills whose subtotals sum back to the whole', () => {
    const bills = splitByLines(
      lines,
      new Map([
        ['l1', 0],
        ['l2', 1],
        ['l3', 1],
      ]),
    );
    expect(bills.map((b) => b.billIndex)).toEqual([0, 1]);
    expect(at(bills, Number(0)).subtotalMinor).toBe(1200n);
    expect(at(bills, Number(1)).subtotalMinor).toBe(1300n);
    expect(bills.reduce((a, b) => a + b.subtotalMinor, 0n)).toBe(2500n);
  });

  it('returns bills in ascending index order whatever order the assignment was built in', () => {
    const bills = splitByLines(
      lines,
      new Map([
        ['l3', 5],
        ['l1', 2],
        ['l2', 0],
      ]),
    );
    expect(bills.map((b) => b.billIndex)).toEqual([0, 2, 5]);
  });

  it('refuses an unassigned line — nobody paying for a line is how money is lost quietly', () => {
    try {
      splitByLines(
        lines,
        new Map([
          ['l1', 0],
          ['l2', 0],
        ]),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as SplitRefusal;
      expect(refusal.code).toBe('restaurant.split.line_assignment_not_a_partition');
      expect(refusal.details?.lineId).toBe('l3');
      expect(refusal.details?.reason).toBe('unassigned');
    }
  });

  it('refuses an assignment naming a line that is not on this bill', () => {
    try {
      splitByLines(
        lines,
        new Map([
          ['l1', 0],
          ['l2', 0],
          ['l3', 0],
          ['ghost', 1],
        ]),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as SplitRefusal;
      expect(refusal.code).toBe('restaurant.split.line_assignment_not_a_partition');
      expect(refusal.details?.reason).toBe('unknown_line');
    }
  });

  it('refuses a negative bill index', () => {
    expect(() =>
      splitByLines(
        lines,
        new Map([
          ['l1', -1],
          ['l2', 0],
          ['l3', 0],
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'restaurant.split.line_assignment_not_a_partition' }));
  });

  it('refuses a split of no lines at all', () => {
    expect(() => splitByLines([], new Map())).toThrowError(expect.objectContaining({ code: 'restaurant.split.empty_bill' }));
  });
});
