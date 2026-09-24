/**
 * Realized FX — the classification, not the posting (directive §49-§53, §56).
 *
 * When a business settles a foreign-currency obligation, the base-currency
 * amount it actually moves is rarely the base-currency amount the ledger was
 * carrying: the rate moved between the two dates. The difference is a REALIZED
 * gain or loss, and it belongs in `fx_gain` or `fx_loss`.
 *
 * This module decides WHICH and HOW MUCH. It posts nothing, touches no
 * database and knows no accounts beyond the two system keys below. A future
 * settlement workflow calls it, gets an intent, and builds a line from it
 * through the same hardened writer everything else goes through.
 *
 * ── Why the caller must state the direction (§50) ────────────────────────
 *
 * `actual − carrying` does not, by itself, say gain or loss. The identical
 * arithmetic means opposite things depending on which way the money moved:
 *
 *   OUTFLOW  carrying 360, paid out 369     → the business gave up 9 more → LOSS 9
 *   INFLOW   carrying 360, received 369     → the business got 9 more     → GAIN 9
 *
 * So `direction` is a required, closed input. Inferring it from the sign
 * afterwards is not a shortcut, it is the bug: it would book every overpaid
 * supplier settlement as a gain.
 *
 * ── Why the caller cannot name the account (§49, §51, §56) ───────────────
 *
 * There is no `systemKey` parameter. The helper CHOOSES between exactly two
 * accounts and can express nothing else — `rounding` and
 * `purchase_price_variance` are not in its result type, so no argument, flag
 * or future edit short of changing this file can make it return one. A
 * rounding difference is not an FX difference and a purchase price variance
 * is neither; INV-ACC-12 keeps those three accounts distinct, and the way to
 * keep them distinct in code is to give each classifier a result type that
 * cannot spell the others.
 */
import { AccountingError } from './errors';
import { MAX_MONEY_MINOR, type PostingSide } from './types';

/**
 * Which way the money actually moved. A closed type, because the whole point
 * of §50 is that this is stated rather than inferred.
 */
export type EconomicDirection = 'inflow' | 'outflow';

/** The only two accounts realized FX can reach. */
export type RealizedFxSystemKey = 'fx_gain' | 'fx_loss';

export interface RealizedFxIntent {
  readonly systemKey: RealizedFxSystemKey;
  /** `C` for a gain (revenue), `D` for a loss (expense). */
  readonly side: PostingSide;
  /** A POSITIVE exact integer of base-currency minor units. Never zero. */
  readonly amountMinor: bigint;
}

export interface RealizedFxInput {
  /** Which way the settlement moved money. Required; never inferred (§50). */
  readonly direction: EconomicDirection;
  /** The base-currency minor units the ledger was carrying. */
  readonly carryingBaseMinor: bigint;
  /** The base-currency minor units actually settled. */
  readonly actualBaseMinor: bigint;
}

const invalid = (what: string): never => {
  throw new AccountingError('accounting.payload_invalid', `realized FX input is invalid: ${what}`);
};

/**
 * Classify a realized FX difference.
 *
 * Returns `null` when there is none — a settlement at the carrying rate is
 * not a zero-amount gain, it is no FX event at all, and `journal_lines`
 * refuses a zero amount anyway.
 *
 * Every value is `bigint`. `Number` cannot hold an LBP amount exactly, and
 * `Math.abs` on a coerced double is exactly the kind of silent corruption
 * that survives every test written with small numbers (§53).
 */
export function classifyRealizedFx(input: RealizedFxInput): RealizedFxIntent | null {
  const { direction, carryingBaseMinor, actualBaseMinor } = input;
  if (direction !== 'inflow' && direction !== 'outflow') invalid('direction must be stated as inflow or outflow');
  if (typeof carryingBaseMinor !== 'bigint' || typeof actualBaseMinor !== 'bigint') invalid('amounts must be exact integers');
  if (carryingBaseMinor < 0n || actualBaseMinor < 0n) invalid('a settlement amount is never negative');
  if (carryingBaseMinor > MAX_MONEY_MINOR || actualBaseMinor > MAX_MONEY_MINOR) invalid('a settlement amount exceeds the money cap');

  const difference = actualBaseMinor - carryingBaseMinor;
  if (difference === 0n) return null;

  const magnitude = difference < 0n ? -difference : difference;
  // Both operands are bounded by the cap, so the magnitude is too; the check
  // is here because an arithmetic change that broke it must fail loudly
  // rather than write an over-cap line the ledger would reject at COMMIT.
  if (magnitude > MAX_MONEY_MINOR) invalid('the realized difference exceeds the money cap');

  // `more than carrying` is a LOSS on the way out and a GAIN on the way in.
  const isGain = direction === 'inflow' ? difference > 0n : difference < 0n;
  return isGain ? { systemKey: 'fx_gain', side: 'C', amountMinor: magnitude } : { systemKey: 'fx_loss', side: 'D', amountMinor: magnitude };
}
