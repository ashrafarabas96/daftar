/**
 * P4-S2 — THE TWO BASE-SPLIT IMPLEMENTATIONS ARE ONE ALGORITHM, CHECKED
 * ACROSS THE PACKAGE BOUNDARY.
 * (docs/PHASE_4_S2_ACCOUNTING_CONTRACT.md §5.1; P4-AL-25; GOLD-33 / G-18.)
 *
 * A purchase and a sale land in ONE ledger, and `G-18` compares them there:
 * `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor` exactly
 * after purchase-at-two-costs → sale → return → void → transfer → adjustment.
 * So the split that distributes a converted base total over a document's lines
 * must be the SAME algorithm on both sides, or the two documents disagree by a
 * minor unit in the one place the identity is checked.
 *
 * There are two implementations, deliberately:
 *
 *   `largestRemainder`              `packages/inventory/src/allocation.ts:40`
 *   `splitBaseByLargestRemainder`   `packages/accounting/src/sale-posting.ts`
 *
 * `@daftar/accounting` depends on `@daftar/domain-core` ONLY. A money package
 * importing an inventory valuation package to add up money would be a
 * dependency edge in the wrong direction, so the accounting side restates the
 * algorithm. A restatement is only safe while something compares it to the
 * original, and that comparison cannot live in either package: the accounting
 * suite cannot import `@daftar/inventory`, and the inventory suite imports
 * nothing but itself by its own rule (`purchase-shares.ts:22`). It lives here,
 * at the root, which is the only place both are visible.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────
 *
 * The accounting suite carried a test titled "agrees with the purchase receipt
 * split (`packages/inventory/src/allocation.ts`) on every pinned vector" that
 * NEVER IMPORTED IT. It asserted this implementation against six literals that
 * live in the same module, so the duplication's whole justification — a
 * cross-package pin — had a pin with one side missing, and a divergence in the
 * inventory implementation would have been invisible to it. The vectors were
 * good; they were applied to one side. A good vector applied to one side
 * proves only that the side agrees with itself.
 *
 * Nothing here touches a database, so the file is pure and fast.
 */
import { describe, expect, it } from 'vitest';
import { SALE_BASE_SPLIT_AGREEMENT_VECTORS, SALE_BASE_SPLIT_DRIFT_VECTOR, splitBaseByLargestRemainder } from '@daftar/accounting';
import { largestRemainder } from '@daftar/inventory';

/** The inventory side, at scale 0, which is the grain a money split is taken at. */
const inventorySplit = (total: bigint, weights: readonly bigint[]): bigint[] =>
  largestRemainder(
    weights.map((units) => ({ units, scale: 0 })),
    total,
  );

/**
 * Largest remainder with ties resolved to the HIGHER index — the one plausible
 * variant of the same algorithm. Used only to prove the vectors discriminate;
 * it is never the answer either implementation gives.
 */
const tieToHigherIndex = (total: bigint, weights: readonly bigint[]): bigint[] => {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const shares = weights.map((w) => (total * w) / sum);
  const remainders = weights.map((w) => (total * w) % sum);
  let residue = total - shares.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = remainders[a] ?? 0n;
      const rb = remainders[b] ?? 0n;
      if (ra !== rb) return ra > rb ? -1 : 1;
      return b - a; // the flip
    });
  for (const i of order) {
    if (residue === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    residue -= 1n;
  }
  return shares;
};

describe('P4-S2: the accounting base split and the purchase receipt base split are one algorithm', () => {
  it('both implementations are really imported, from two different packages', () => {
    // NON-VACUITY CANARY, and the whole reason this file is at the root: if
    // either import ever resolves to nothing, every agreement below would
    // throw rather than pass — but a reader deserves the claim stated
    // directly, because the defect this file replaces was precisely an
    // agreement test with one side absent.
    expect(typeof splitBaseByLargestRemainder).toBe('function');
    expect(typeof largestRemainder).toBe('function');
    expect(splitBaseByLargestRemainder).not.toBe(largestRemainder);
  });

  it('THE VECTORS DISCRIMINATE: flipping the tie rule changes the answer on at least three of them', () => {
    // Asserted BEFORE the agreement, because an agreement over vectors that
    // every variant satisfies is an agreement about nothing. The tie rule is
    // the only thing two correct largest-remainder implementations can
    // disagree about, so a vector set that cannot see a flipped tie cannot
    // see the one real divergence.
    const flipped = SALE_BASE_SPLIT_AGREEMENT_VECTORS.filter((v) => {
      const a = splitBaseByLargestRemainder(v.total, v.weights);
      const b = tieToHigherIndex(v.total, v.weights);
      return a.join(',') !== b.join(',');
    });
    expect(flipped.length, 'vectors that a flipped tie rule would fail').toBeGreaterThanOrEqual(3);
    expect(SALE_BASE_SPLIT_AGREEMENT_VECTORS.length).toBeGreaterThanOrEqual(6);
  });

  it('agrees with `largestRemainder` on every pinned vector, and both sum to the total exactly', () => {
    for (const v of SALE_BASE_SPLIT_AGREEMENT_VECTORS) {
      const mine = splitBaseByLargestRemainder(v.total, v.weights);
      const theirs = inventorySplit(v.total, v.weights);
      const where = `total=${v.total} weights=[${v.weights.join(',')}]`;
      // Both against the recorded literal, and against each other. The
      // literal matters too: two implementations that drifted together would
      // agree with each other and not with the pinned answer.
      expect(mine, `accounting: ${where}`).toEqual([...v.shares]);
      expect(theirs, `inventory: ${where}`).toEqual([...v.shares]);
      expect(mine, `cross-package: ${where}`).toEqual(theirs);
      expect(
        mine.reduce((a, b) => a + b, 0n),
        `Σ accounting: ${where}`,
      ).toBe(v.total);
      expect(
        theirs.reduce((a, b) => a + b, 0n),
        `Σ inventory: ${where}`,
      ).toBe(v.total);
    }
  });

  it("agrees on the drift vector's own numbers, which is the case the whole 'round once' law is argued from", () => {
    const v = SALE_BASE_SPLIT_DRIFT_VECTOR;
    expect(splitBaseByLargestRemainder(v.totalBaseMinor, v.lineTxnMinor)).toEqual([...v.split]);
    expect(inventorySplit(v.totalBaseMinor, v.lineTxnMinor)).toEqual([...v.split]);
    // And the deleted second rounding is still worse than both, by one unit.
    expect(v.perRowHalfEven.reduce((a, b) => a + b, 0n)).toBe(v.totalBaseMinor + v.driftBaseMinor);
  });

  it('agrees over a swept range, so agreement is a property and not six coincidences', () => {
    let compared = 0;
    for (let total = 0n; total <= 40n; total += 1n) {
      for (const weights of [
        [1n, 1n],
        [1n, 1n, 1n],
        [3n, 1n],
        [7n, 11n, 13n],
        [0n, 5n],
        [5n, 0n],
        [1n, 2n, 3n, 4n],
      ] as const) {
        const mine = splitBaseByLargestRemainder(total, weights);
        expect(mine, `total=${total} weights=[${weights.join(',')}]`).toEqual(inventorySplit(total, weights));
        expect(mine.reduce((a, b) => a + b, 0n)).toBe(total);
        compared += 1;
      }
    }
    // NON-VACUITY CANARY: the sweep must actually have run.
    expect(compared).toBe(41 * 7);
  });

  it('both refuse the same degenerate input: a non-zero total over weights that sum to zero', () => {
    expect(() => splitBaseByLargestRemainder(100n, [0n, 0n])).toThrow();
    expect(() => inventorySplit(100n, [0n, 0n])).toThrow();
    // And both accept the zero/zero case, returning zeros rather than raising.
    expect(splitBaseByLargestRemainder(0n, [0n, 0n])).toEqual([0n, 0n]);
    expect(inventorySplit(0n, [0n, 0n])).toEqual([0n, 0n]);
  });
});
