/**
 * Locale foundation (LOCALIZATION): direction, fallback, ICU/Intl formatting.
 * Money VO never formats — this module owns all visual formatting.
 *
 * formatMoney is BigInt-safe (Recovery Directive §15–16): there is NO
 * Number(amountMinor) conversion anywhere. The integer part is formatted as a
 * native bigint via Intl; fraction digits are inserted as exact decimal text
 * using the locale's decimal separator. Amounts far above
 * Number.MAX_SAFE_INTEGER (LBP/SYP realities) render exactly.
 *
 * Currency display names come from CLDR via Intl.DisplayNames (§22) — no
 * hand-maintained transliteration tables.
 */

import type { Money } from './money';
import { minorUnitsOf } from './currencies';

export type Locale = 'ar' | 'en' | 'tr';

export const RTL_LOCALES: ReadonlySet<string> = new Set(['ar']);

export function isRtl(locale: string): boolean {
  return RTL_LOCALES.has(locale);
}

export function direction(locale: string): 'rtl' | 'ltr' {
  return isRtl(locale) ? 'rtl' : 'ltr';
}

/** Platform fallback chain: requested → en. */
export function resolveLocale(requested: string | undefined | null): Locale {
  if (requested === 'ar' || requested === 'en' || requested === 'tr') return requested;
  if (requested) {
    const first = requested.split('-')[0];
    const base = (first ?? '').toLowerCase();
    if (base === 'ar' || base === 'en' || base === 'tr') return base;
  }
  return 'en';
}

/** CLDR currency display name for a UI locale — ar/en/tr first-class. */
export function getCurrencyDisplayName(code: string, locale: string): string {
  const dn = new Intl.DisplayNames([resolveLocale(locale)], { type: 'currency' });
  return dn.of(code.toUpperCase()) ?? code.toUpperCase();
}

/** CLDR country display name for a UI locale. */
export function getCountryDisplayName(code: string, locale: string): string {
  const dn = new Intl.DisplayNames([resolveLocale(locale)], { type: 'region' });
  return dn.of(code.toUpperCase()) ?? code.toUpperCase();
}

/**
 * Format a Money value visually via Intl (ICU/CLDR) — the only sanctioned
 * formatting path. Exact for arbitrarily large minor-unit values.
 */
export function formatMoney(money: Money, locale: string): string {
  const loc = resolveLocale(locale);
  const units = minorUnitsOf(money.currency);
  const scale = 10n ** BigInt(units);
  const negative = money.amountMinor < 0n;
  const abs = negative ? -money.amountMinor : money.amountMinor;
  const whole = abs / scale;
  const frac = abs % scale;

  const fmt = new Intl.NumberFormat(loc, {
    style: 'currency',
    currency: money.currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: units,
    maximumFractionDigits: units,
  });

  // Learn the locale's layout (symbol position, separators) from a bigint
  // skeleton — formatting a bigint with Intl never passes through Number.
  const skeletonParts = fmt.formatToParts(0n);
  const decimalSep = skeletonParts.find((p) => p.type === 'decimal')?.value ?? '.';
  const hasFractionSkeleton = skeletonParts.some((p) => p.type === 'fraction');

  // Format the whole part as a bigint with currency style, then splice the
  // exact fraction digits in place of the skeleton's zero fraction.
  const wholeParts = fmt.formatToParts(whole);
  const fracText = frac.toString().padStart(units, '0');

  let out = '';
  for (const part of wholeParts) {
    if (part.type === 'fraction') {
      out += fracText;
    } else if (part.type === 'decimal') {
      out += units > 0 ? (skeletonParts.find((p) => p.type === 'decimal')?.value ?? decimalSep) : '';
      if (units > 0 && !wholeParts.some((p) => p.type === 'fraction')) out += fracText;
    } else {
      out += part.value;
    }
  }
  if (units > 0 && !wholeParts.some((p) => p.type === 'decimal') && !wholeParts.some((p) => p.type === 'fraction')) {
    out += (hasFractionSkeleton ? decimalSep : '.') + fracText;
  }
  return negative ? prependSign(out, loc) : out;
}

function prependSign(formatted: string, locale: string): string {
  const minus = new Intl.NumberFormat(locale).format(-1).replace(/\d/g, '').trim();
  return minus.length > 0 ? `${minus}${formatted}` : `-${formatted}`;
}

/** Format exact minor-unit bigint as a plain grouped decimal string (no currency). */
export function formatMinorAmount(amountMinor: bigint, currency: string, locale: string): string {
  const units = minorUnitsOf(currency);
  const scale = 10n ** BigInt(units);
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const whole = abs / scale;
  const frac = abs % scale;
  const nf = new Intl.NumberFormat(resolveLocale(locale), { useGrouping: true });
  const dec = nf.formatToParts(1.1).find((p) => p.type === 'decimal')?.value ?? '.';
  const base = nf.format(whole);
  const body = units > 0 ? `${base}${dec}${frac.toString().padStart(units, '0')}` : base;
  return negative ? prependSign(body, locale) : body;
}

export function formatNumber(value: number | bigint, locale: string): string {
  return new Intl.NumberFormat(resolveLocale(locale)).format(value);
}

export function formatDate(date: Date, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    dateStyle: 'medium',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function formatDateTime(date: Date, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** ICU pluralization helper — picks the form for `count` in `locale`. */
export function plural(locale: string, count: number, forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }): string {
  const rule = new Intl.PluralRules(resolveLocale(locale)).select(count);
  return (forms[rule] ?? forms.other).replace('{count}', formatNumber(count, locale));
}
