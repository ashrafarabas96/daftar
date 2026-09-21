/**
 * Money contract helpers (Stabilization Part F §38–39, Part S §97; Completion
 * Directive §34–36).
 *
 * ONE SOURCE OF TRUTH (§35): currency facts (supported codes, minor units)
 * live in @daftar/domain-core's ISO 4217 registry, which the database
 * `currencies` table mirrors. This module holds NO registry of its own.
 *
 * NO BigInt → Number (§34): formatting delegates to domain-core's
 * BigInt-safe Intl formatter, so values above Number.MAX_SAFE_INTEGER
 * (e.g. 900719925474099399 minor) keep every digit. Minor units are ALWAYS
 * a decimal string on the wire; parsing user input is exact decimal
 * arithmetic — no JS float ever touches money.
 */
import { Money, formatMoney, minorUnitsOf as registryMinorUnitsOf } from '@daftar/domain-core';

/** Exact decimal-string → minor-units-string parser. Throws on invalid input or excess precision. */
export function parseMajorToMinor(input: string, minorUnits: number): string {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 3) {
    throw new Error(`unsupported minorUnits: ${minorUnits}`);
  }
  const trimmed = input.trim().replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error(`invalid decimal: ${input}`);
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  if (fracPart.length > minorUnits) {
    throw new Error(`too many decimal places: ${fracPart.length} > ${minorUnits}`);
  }
  // Length is guaranteed ≤ minorUnits by the check above; pad to exactly
  // minorUnits digits (empty for 0-decimal currencies).
  const fracScaled = fracPart.padEnd(minorUnits, '0');
  const scaled = BigInt(intPart) * 10n ** BigInt(minorUnits) + BigInt(fracScaled === '' ? '0' : fracScaled);
  return (negative ? -scaled : scaled).toString();
}

/**
 * Minor-units-string → formatted major amount for display (Intl/CLDR).
 * Never shows the raw minor value; never converts the amount to a JS number.
 */
export function formatMinor(minor: string | bigint, currency: string, locale: string): string {
  return formatMoney(Money.ofMinor(minor, currency, { allowNegative: true }), locale);
}

/** ISO 4217 minor units — the domain-core registry (throws CurrencyError for an unsupported code). */
export function minorUnitsOf(currency: string): number {
  return registryMinorUnitsOf(currency);
}
