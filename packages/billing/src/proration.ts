/**
 * Proration — what a plan change inside a billing period costs.
 *
 * ── Integer arithmetic, one rounding, HALF_EVEN ──────────────────────────
 *
 * `divHalfEven` below is the same arithmetic `convertToBaseMinor`
 * (`packages/accounting/src/fx.ts`) performs, statement for statement, and
 * the same arithmetic `0043` performs in SQL: truncating division, then the
 * doubled remainder compared against the divisor, with an exact tie resolved
 * to the even quotient. Two roundings of the same money by two different
 * rules is how a ledger acquires an unexplained minor unit, so this slice
 * reuses the project's rule rather than choosing its own.
 *
 * Rounding happens ONCE per amount, on `price × remaining / total`. It is
 * deliberately not `price × (remaining / total)`: the inner division would
 * have to produce a fraction, and the only way to hold a fraction here is a
 * float.
 *
 * ── Why the credit and the charge are computed separately ────────────────
 *
 * It is tempting to prorate the DIFFERENCE: `(new − old) × remaining`. That
 * is one rounding instead of two and it is wrong for the merchant, because
 * the invoice has to show what was credited and what was charged. A single
 * net figure cannot be reconciled against either plan's price, and a refund
 * of the change later has no credit to reverse. So this module returns both
 * sides and the net, and the net is their exact difference.
 *
 * ── What this module does not do ─────────────────────────────────────────
 *
 * It does not post anything, does not touch AR, and does not know what a
 * journal is. Platform subscription revenue is the platform's own accounting,
 * which belongs to whichever authority the owner nominates at promotion; a
 * prepared slice that posted would be a second financial truth.
 */
import { periodContains, periodLengthMs } from './period';
import { refuse } from './errors';
import { MAX_BILLING_MINOR, type BillingPeriod, type Price } from './types';

/**
 * `floor`/`HALF_EVEN` division of two non-negative exact integers.
 *
 * Exported because the proration laws are stated in terms of it and a test
 * that cannot call the rounding rule can only compare the implementation to
 * itself.
 */
export function divHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) refuse('billing.payload_invalid', 'a proration divisor must be positive');
  if (numerator < 0n) refuse('billing.payload_invalid', 'this rounding rule is stated for non-negative numerators only');
  const q = numerator / denominator;
  const r = numerator - q * denominator;
  const twice = 2n * r;
  if (twice > denominator) return q + 1n;
  if (twice < denominator) return q;
  return q % 2n === 0n ? q : q + 1n;
}

function assertPrice(price: Price | undefined, what: string): Price {
  if (!price || typeof price.amountMinor !== 'bigint') {
    refuse('billing.price_invalid', `${what} must be an exact integer amount of minor units`);
  }
  if (typeof price.currency !== 'string' || !/^[A-Z]{3}$/.test(price.currency)) {
    refuse('billing.price_invalid', `${what} must carry a three-letter currency code`);
  }
  if (price.amountMinor < 0n) refuse('billing.price_invalid', `${what} may not be negative`, { currency: price.currency });
  if (price.amountMinor > MAX_BILLING_MINOR) refuse('billing.price_invalid', `${what} exceeds the money cap`, { currency: price.currency });
  return price;
}

/**
 * The part of `price` that covers `[at, period.endsAt)`.
 *
 * Used for the credit side (the old plan's unused remainder) and the charge
 * side (the new plan's remainder) alike, and for an add-on that appears
 * mid-period. `at` must lie INSIDE the half-open period: `period.endsAt` is
 * the next period's first instant, and prorating a zero-length remainder
 * against it would quietly bill a period the change does not belong to.
 */
export function proratedAmountMinor(price: Price, period: BillingPeriod, at: string): bigint {
  const p = assertPrice(price, 'a prorated price');
  const totalMs = periodLengthMs(period);
  if (!periodContains(period, at)) {
    refuse('billing.proration_outside_period', 'a proration instant must lie inside the half-open billing period', { at });
  }
  const remainingMs = Date.parse(period.endsAt) - Date.parse(at);
  if (!(remainingMs > 0) || remainingMs > totalMs) {
    refuse('billing.invariant_violated', 'the remaining span must be positive and no longer than the period', {
      invariant: 'remaining_within_period',
      at,
    });
  }
  const amount = divHalfEven(p.amountMinor * BigInt(remainingMs), BigInt(totalMs));
  if (amount < 0n || amount > p.amountMinor) {
    refuse('billing.invariant_violated', 'a prorated part may not be negative nor exceed the whole price', {
      invariant: 'prorated_part_bounded',
      currency: p.currency,
      at,
    });
  }
  return amount;
}

export interface ProrationInput {
  readonly period: BillingPeriod;
  /** The instant the plan change takes effect. Supplied; never a machine clock. */
  readonly changeAt: string;
  /** The price of the plan being left, for the WHOLE period. */
  readonly from: Price;
  /** The price of the plan being joined, for the WHOLE period. */
  readonly to: Price;
}

export interface ProrationResult {
  readonly currency: string;
  readonly periodMs: number;
  readonly remainingMs: number;
  /** The unused remainder of the OLD plan. Non-negative, at most `from`. */
  readonly creditMinor: bigint;
  /** The remainder of the NEW plan. Non-negative, at most `to`. */
  readonly chargeMinor: bigint;
  /** `chargeMinor − creditMinor`, exactly. Negative on a downgrade. */
  readonly netMinor: bigint;
}

/**
 * Price a plan change that takes effect at `changeAt` inside `period`.
 *
 * A downgrade produces a negative `netMinor`. That is a correct arithmetic
 * answer and this module returns it; what to DO with it — carry it as a
 * credit balance, or refund it — is a commercial policy, and the policy is
 * not settled, so nothing here decides it. `composeSubscriptionInvoice`
 * refuses an invoice whose total is negative for exactly that reason.
 */
export function proratePlanChange(input: ProrationInput): ProrationResult {
  const from = assertPrice(input?.from, "the outgoing plan's price");
  const to = assertPrice(input?.to, "the incoming plan's price");
  if (from.currency !== to.currency) {
    refuse('billing.proration_currency_mismatch', 'a plan change may not cross currencies inside one period', { currency: from.currency });
  }
  const periodMs = periodLengthMs(input.period);
  const creditMinor = proratedAmountMinor(from, input.period, input.changeAt);
  const chargeMinor = proratedAmountMinor(to, input.period, input.changeAt);
  const remainingMs = Date.parse(input.period.endsAt) - Date.parse(input.changeAt);
  return {
    currency: from.currency,
    periodMs,
    remainingMs,
    creditMinor,
    chargeMinor,
    netMinor: chargeMinor - creditMinor,
  };
}
