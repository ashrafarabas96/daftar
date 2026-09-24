/**
 * Exact FX conversion — the TypeScript half of AL-09.
 *
 * `0043` already refuses, at COMMIT, any line whose `base_amount_minor` is not
 * the exact conversion of its transaction amount. This module computes the
 * value the database will demand, using the SAME algorithm so that the engine
 * never proposes a line the ledger is about to reject:
 *
 *   base_minor = HALF_EVEN( txn_minor × rate_scaled × 10^max(0, eb−et)
 *                           ÷ (10^10 × 10^max(0, et−eb)) )
 *
 * where `rate_scaled = fx_rate × 10^10` is an exact integer because rates are
 * `NUMERIC(20,10)`, and `et`/`eb` are the transaction and base currencies'
 * minor-unit exponents.
 *
 * Everything is `bigint`. There is no division until the final quotient and
 * remainder, and the tie is broken toward even explicitly — `Math.round`,
 * `toFixed` and IEEE-754 all round half away from zero, which is exactly where
 * they would disagree with the database and produce a line that commits in a
 * test and fails in production.
 */
import { minorUnitsOf } from '@daftar/domain-core';
import { AccountingError } from './errors';
import { canonicalRate } from './fingerprint';

/** `fx_rate × 10^10` as an exact integer, from a canonical decimal string. */
export function rateScaled(fxRate: string): bigint {
  const canonical = canonicalRate(fxRate);
  const [whole, frac] = canonical.split('.');
  return BigInt(`${whole}${frac}`);
}

const pow10 = (exp: number): bigint => 10n ** BigInt(Math.max(exp, 0));

/**
 * The exact base-currency minor units for a transaction amount, rounded
 * HALF_EVEN. Mirrors `accounting_assert_entry_valid`'s arithmetic in `0043`
 * statement for statement.
 */
export function convertToBaseMinor(params: {
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  readonly baseCurrency: string;
  readonly fxRate: string;
}): bigint {
  const { txnAmountMinor, txnCurrency, baseCurrency, fxRate } = params;
  if (txnAmountMinor <= 0n) {
    throw new AccountingError('accounting.payload_invalid', 'transaction amount must be positive');
  }
  const et = minorUnitsOf(txnCurrency);
  const eb = minorUnitsOf(baseCurrency);
  const scaled = rateScaled(fxRate);
  if (scaled <= 0n) {
    throw new AccountingError('accounting.payload_invalid', 'fx rate must be positive');
  }

  const num = txnAmountMinor * scaled * pow10(eb - et);
  const den = 10_000_000_000n * pow10(et - eb);

  // Both operands are positive, so bigint division truncates toward zero,
  // which is floor — the same value PostgreSQL's div() returns here.
  const q = num / den;
  const r = num - q * den;
  const twice = 2n * r;
  if (twice > den) return q + 1n;
  if (twice < den) return q;
  return q % 2n === 0n ? q : q + 1n;
}

/**
 * Whether a proposed base amount is the exact conversion. The engine checks
 * this before it ever reaches the database, so a bad line is refused with a
 * typed error instead of a deferred trigger failure at COMMIT.
 */
export function isExactConversion(params: {
  readonly baseAmountMinor: bigint;
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  readonly baseCurrency: string;
  readonly fxRate: string;
}): boolean {
  return convertToBaseMinor(params) === params.baseAmountMinor;
}
