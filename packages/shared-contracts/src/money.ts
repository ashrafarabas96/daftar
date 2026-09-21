/**
 * Money contract helpers (Stabilization Part F §38–39, Part S §97).
 * Minor units are ALWAYS a decimal string (bigint-safe). Parsing user input
 * is EXACT decimal arithmetic — no JS float ever touches money. Supports
 * 0-, 2- and 3-decimal currencies (e.g. JOD=3, ILS/USD/TRY=2, KWD=3, JPY=0).
 */

/** Exact decimal-string → minor-units-string parser. Throws on invalid input. */
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

/** Minor-units-string → formatted major amount for display (Intl/CLDR). Never shows the raw minor value. */
export function formatMinor(minor: string | bigint, currency: string, locale: string): string {
  const minorUnits = minorUnitsOf(currency);
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(minorUnits);
  const intPart = abs / scale;
  const fracPart = (abs % scale).toString().padStart(minorUnits, '0');
  const decimal = Number(`${intPart}.${fracPart}`) * (negative ? -1 : 1);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(decimal);
}

/** ISO 4217 minor units for the currencies DAFTAR supports in Phase 1. */
const MINOR_UNITS: Record<string, number> = {
  JOD: 3, KWD: 3, BHD: 3, OMR: 3, IQD: 3, LYD: 3, TND: 3,
  USD: 2, EUR: 2, TRY: 2, ILS: 2, SAR: 2, AED: 2, EGP: 2, GBP: 2, MAD: 2, QAR: 2,
  JPY: 0, KRW: 0,
};

export function minorUnitsOf(currency: string): number {
  return MINOR_UNITS[currency.toUpperCase()] ?? 2;
}
