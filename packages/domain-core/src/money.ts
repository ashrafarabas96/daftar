/**
 * Money value object — DAFTAR financial constitution, Phase 1.
 *
 * Laws enforced here:
 * - Money is BIGINT minor units. Float/Double never enter this type.
 * - No Number(bigint) conversion anywhere: values above Number.MAX_SAFE_INTEGER
 *   (e.g. LBP/SYP amounts) stay exact. Formatting is BigInt-safe (see locale.ts).
 * - ofMinor/ofMajor accept bigint | string always; a JS number is accepted only
 *   when Number.isSafeInteger — anything else throws (no silent precision loss).
 * - Negative amounts are rejected by default. An operation that legitimately
 *   needs a signed result must say so explicitly (`allowNegative: true`),
 *   and the resulting value carries that explicit policy with it.
 * - Multiplication is integer-only in Phase 1 (quantity × price with integer
 *   quantity). Fractional quantities will use a separate fixed-scale Quantity
 *   model in a later phase — never Money.times(fraction).
 */
import { getCurrency } from './currencies';

export class MoneyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'CURRENCY_MISMATCH'
      | 'NEGATIVE_NOT_ALLOWED'
      | 'INVALID_AMOUNT'
      | 'UNSAFE_NUMBER'
      | 'FRACTIONAL_FACTOR'
      | 'PRECISION_OVERFLOW',
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

export interface MoneyPolicy {
  /** Explicit opt-in to a signed result. Default: negatives are forbidden. */
  readonly allowNegative?: boolean;
}

function toMinorBigInt(value: bigint | string | number): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(
        `Unsafe number cannot represent money exactly: ${value}`,
        'UNSAFE_NUMBER',
      );
    }
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value.trim())) {
    throw new MoneyError(`Invalid minor-unit amount: ${value}`, 'INVALID_AMOUNT');
  }
  return BigInt(value.trim());
}

export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: string,
    private readonly signed: boolean,
  ) {
    getCurrency(currency); // throws on unsupported currency
    if (!signed && amountMinor < 0n) {
      throw new MoneyError(
        `Negative money is not allowed without explicit policy: ${amountMinor} ${currency}`,
        'NEGATIVE_NOT_ALLOWED',
      );
    }
  }

  static ofMinor(amountMinor: bigint | string | number, currency: string, policy: MoneyPolicy = {}): Money {
    return new Money(toMinorBigInt(amountMinor), currency.toUpperCase(), policy.allowNegative === true);
  }

  static zero(currency: string): Money {
    return new Money(0n, currency.toUpperCase(), false);
  }

  /**
   * Parse a major-unit decimal string ("1234.567" for JOD). Excess precision
   * beyond the currency's minor units is rejected — never silently rounded.
   */
  static ofMajor(major: string, currency: string, policy: MoneyPolicy = {}): Money {
    const cur = getCurrency(currency);
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(major.trim());
    if (!m) throw new MoneyError(`Invalid major amount: ${major}`, 'INVALID_AMOUNT');
    const sign = m[1] === '-' ? -1n : 1n;
    const whole = m[2] ?? '0';
    const frac = m[3] ?? '';
    if (frac.length > cur.minorUnits) {
      throw new MoneyError(
        `Too many fraction digits for ${cur.code} (max ${cur.minorUnits}): ${major}`,
        'PRECISION_OVERFLOW',
      );
    }
    const scale = 10n ** BigInt(cur.minorUnits);
    const minor = BigInt(whole) * scale + BigInt(frac.padEnd(cur.minorUnits, '0') || '0');
    return new Money(sign * minor, cur.code, policy.allowNegative === true);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyError(
        `Currency mismatch: ${this.currency} vs ${other.currency}`,
        'CURRENCY_MISMATCH',
      );
    }
  }

  add(other: Money, policy: MoneyPolicy = {}): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency, this.signed || policy.allowNegative === true);
  }

  subtract(other: Money, policy: MoneyPolicy = {}): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency, this.signed || policy.allowNegative === true);
  }

  /** Integer factor only. Fractional factors are rejected (Phase 1 law). */
  times(factor: bigint | string | number): Money {
    const f = toMinorBigInt(factor);
    return new Money(this.amountMinor * f, this.currency, this.signed);
  }

  negate(): Money {
    return new Money(-this.amountMinor, this.currency, true);
  }

  isZero(): boolean { return this.amountMinor === 0n; }
  isNegative(): boolean { return this.amountMinor < 0n; }

  compareTo(other: Money): number {
    this.assertSameCurrency(other);
    return this.amountMinor < other.amountMinor ? -1 : this.amountMinor > other.amountMinor ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  static min(a: Money, b: Money): Money { return a.compareTo(b) <= 0 ? a : b; }
  static max(a: Money, b: Money): Money { return a.compareTo(b) >= 0 ? a : b; }

  /** Serialization keeps the exact minor value as a string — never a JS number. */
  toJSON(): { amountMinor: string; currency: string } {
    return { amountMinor: this.amountMinor.toString(), currency: this.currency };
  }
}
