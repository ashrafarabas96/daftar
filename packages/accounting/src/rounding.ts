/**
 * Rounding — the other difference, and deliberately not the same one
 * (directive §54-§56).
 *
 * When one amount is allocated across several lines, exact integer arithmetic
 * leaves a residual of a few minor units that belongs to no single line. That
 * residual is a ROUNDING adjustment and it goes to `rounding`.
 *
 * It is NOT an FX difference and NOT a purchase price variance, and this
 * module can express neither: its result type names exactly one system key.
 * `classifyRealizedFx` likewise cannot name `rounding`. Two classifiers, two
 * closed result types, no overlap — which is how INV-ACC-12's separation
 * survives a refactor by somebody who has not read this comment (§56).
 *
 * ── Why the caller states the side (§54) ─────────────────────────────────
 *
 * A residual's sign in an allocation depends on how the caller accumulated
 * it, and guessing the financial direction from that sign would make the
 * adjustment's meaning a property of the caller's loop rather than of the
 * business fact. So the balancing side is required, exactly as the economic
 * direction is required for realized FX.
 *
 * ── Why the residual is bounded, and why a reason is mandatory (§55) ─────
 *
 * Allocating one amount across N lines with the accepted HALF_EVEN policy
 * leaves at most one minor unit unassigned per line, so |residual| ≤ N. A
 * larger residual is not a rounding difference — it is an arithmetic bug, a
 * mismatched total or a currency error — and posting it to `rounding` would
 * make 6100 the place wrong numbers go to become balanced. It is refused.
 *
 * The mandatory reason is the same rule from the other side: an adjustment
 * nobody explained is an adjustment nobody can review, and a helper that
 * would emit one without a reason is a hidden balancing mechanism.
 */
import { AccountingError } from './errors';
import { MAX_MONEY_MINOR, type PostingSide } from './types';

/** The only account a rounding adjustment can reach. */
export type RoundingSystemKey = 'rounding';

export interface RoundingIntent {
  readonly systemKey: RoundingSystemKey;
  readonly side: PostingSide;
  /** A POSITIVE exact integer of base-currency minor units. Never zero. */
  readonly amountMinor: bigint;
  /** The caller's own words. Carried through to the line's memo (§55). */
  readonly reason: string;
}

export interface RoundingInput {
  /** The unassigned remainder, in base-currency minor units. May be negative. */
  readonly residualMinor: bigint;
  /** Which side balances it. Required; never derived from the sign (§54). */
  readonly side: PostingSide;
  /** How many lines the amount was allocated across. Bounds the residual (§55). */
  readonly allocationCount: number;
  /** Mandatory. No hidden balancing (§55). */
  readonly reason: string;
}

const invalid = (code: 'accounting.payload_invalid' | 'accounting.rounding_residual_unbounded', what: string): never => {
  throw new AccountingError(code, what);
};

/**
 * Classify an allocation residual as a rounding adjustment.
 *
 * Returns `null` when the residual is zero: an allocation that came out exact
 * has nothing to adjust, and a zero-amount line is not writable anyway.
 */
export function classifyRoundingResidual(input: RoundingInput): RoundingIntent | null {
  const { residualMinor, side, allocationCount, reason } = input;
  if (side !== 'D' && side !== 'C') invalid('accounting.payload_invalid', 'a rounding adjustment must state the balancing side');
  if (typeof residualMinor !== 'bigint') invalid('accounting.payload_invalid', 'a rounding residual must be an exact integer');
  if (!Number.isInteger(allocationCount) || allocationCount < 1) {
    invalid('accounting.payload_invalid', 'a rounding residual is bounded by a real allocation count');
  }
  if (reason.trim().length === 0 || reason.trim().length > 500) {
    invalid('accounting.payload_invalid', 'a rounding adjustment must state why it exists');
  }

  if (residualMinor === 0n) return null;

  const magnitude = residualMinor < 0n ? -residualMinor : residualMinor;
  if (magnitude > BigInt(allocationCount)) {
    // Deliberately a code of its own: this is not a malformed payload, it is
    // a residual too large to be rounding, and a caller should be able to
    // tell those apart without reading a message.
    invalid(
      'accounting.rounding_residual_unbounded',
      'the residual is larger than the allocation could have produced — rounding is not where an unexplained difference goes',
    );
  }
  if (magnitude > MAX_MONEY_MINOR) invalid('accounting.payload_invalid', 'a rounding adjustment exceeds the money cap');

  return { systemKey: 'rounding', side, amountMinor: magnitude, reason: reason.trim() };
}
