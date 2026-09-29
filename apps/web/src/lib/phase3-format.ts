'use client';
/**
 * Display and input helpers of the P3-S7 screens (contract §4.3, A-16(5),
 * A-17), and the view contract the SSR tests rely on (§5(3), T-08, T-15).
 *
 * The web does no arithmetic on money or quantities (§0). Everything here is
 * text: a quantity is re-spelled, never computed; a money figure goes through
 * `formatMinor`, the BigInt-exact formatter; input is normalised and checked
 * by shape, and turned into minor units only by `parseMajorToMinor`.
 * Numbers render with Western digits (DAFTAR_LOCALIZATION §4) inside
 * `<bdi dir="ltr">`, so an RTL sentence never reorders them.
 */
import { createElement, Fragment, useCallback, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { formatMinor, minorUnitsOf, parseMajorToMinor } from '@daftar/shared-contracts';
import type { Locale } from './i18n';

// ── Digits ───────────────────────────────────────────────────────────────

const ARABIC_INDIC = /[٠-٩]/g;
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g;

/**
 * Normalise typed or formatted digits to Western form: Arabic-Indic and
 * Extended Arabic-Indic digits become 0-9, the Arabic decimal separator `٫`
 * becomes `.`, and the Arabic thousands separator `٬`, spaces and the bidi
 * marks CLDR inserts are dropped.
 */
export function normaliseDigits(input: string): string {
  return input
    .replace(ARABIC_INDIC, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String.fromCharCode(d.charCodeAt(0) - 0x06f0 + 48))
    .replace(/٫/g, '.')
    .replace(/[٬\s]/g, '');
}

/** Western digits in formatted output, keeping the locale's separators and bidi marks. */
function westernDigits(text: string): string {
  return text
    .replace(ARABIC_INDIC, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String.fromCharCode(d.charCodeAt(0) - 0x06f0 + 48));
}

// ── Quantities ───────────────────────────────────────────────────────────

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * A decimal quantity string, re-spelled at `decimals` fraction digits with the
 * locale's separators. Pure text: the integer part is grouped by Intl from a
 * BigInt; the fraction is padded to `decimals`, and zeros beyond `decimals`
 * are dropped — insignificant, so a piece item the server sends as "8.0000"
 * reads "8" (D-5) — never rounded: a non-zero digit beyond `decimals` stays.
 * Anything that is not a decimal string is returned as it came, so a malformed
 * value is visible rather than silently "fixed".
 */
export function formatQty(value: string, decimals: number, locale: Locale = 'en'): string {
  const m = DECIMAL_TEXT.exec(value.trim());
  if (!m) return value;
  const [, sign = '', whole = '0', fraction = ''] = m;
  const nf = new Intl.NumberFormat(`${locale}-u-nu-latn`, { minimumFractionDigits: 1 });
  const decimalSep = nf.formatToParts(0.5).find((p) => p.type === 'decimal')?.value ?? '.';
  const grouped = westernDigits(new Intl.NumberFormat(`${locale}-u-nu-latn`).format(BigInt(whole)));
  let digits = fraction;
  while (digits.length > decimals && digits.endsWith('0')) digits = digits.slice(0, -1);
  digits = digits.padEnd(decimals, '0');
  return `${sign}${grouped}${digits.length > 0 ? `${decimalSep}${digits}` : ''}`;
}

/**
 * A decimal the server returned as text — a unit price, an exchange rate — in
 * the locale's separators (M-4: Turkish "3.200" reads as three thousand two
 * hundred, so "3.200 USD" must be spelled "3,200"). Pure text: trailing
 * fraction zeros beyond `minDecimals` are dropped, never rounded, and the rest
 * is re-spelled by `formatQty`.
 */
export function formatDecimalText(value: string, locale: Locale, minDecimals = 0): string {
  const m = DECIMAL_TEXT.exec(value.trim());
  if (!m) return value;
  const [, sign = '', whole = '0', fraction = ''] = m;
  let digits = fraction;
  while (digits.length > minDecimals && digits.endsWith('0')) digits = digits.slice(0, -1);
  return formatQty(`${sign}${whole}${digits.length > 0 ? `.${digits}` : ''}`, Math.max(digits.length, minDecimals), locale);
}

/** Magnitude of a signed decimal string, by text (the "Short by {qty}" label of a negative on-hand). */
export function unsignedQty(value: string): string {
  return value.trim().replace(/^-/, '');
}

/** True for a non-negative quantity string with at most `decimals` fraction digits (input already normalised). */
export function isQuantityText(input: string, decimals: number): boolean {
  const pattern = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  return pattern.test(input);
}

/** True when a normalised quantity string has no non-zero digit. */
export function isZeroQuantityText(input: string): boolean {
  return /^-?[0.]*$/.test(input) && /\d/.test(input);
}

// ── Money ────────────────────────────────────────────────────────────────

/** A minor-unit integer string as the locale shows money, in Western digits. */
export function formatMoney(amountMinor: string, currency: string, locale: Locale): string {
  return westernDigits(formatMinor(amountMinor, currency, locale));
}

/**
 * A unit price the server returned as decimal text, spelled the way `formatMoney`
 * spells the line totals beside it — the same symbol, position and separators
 * (D-5: never "31.50 ILS" next to "₪252.00"). Pure text: the fraction keeps
 * every significant digit (a unit price may be finer than the currency's minor
 * unit), drops the zeros beyond it, and is padded to it; the whole part is
 * laid out by Intl from a BigInt. Text that is not a decimal comes back with
 * its currency code, as it was.
 */
export function formatUnitPrice(value: string, currency: string, locale: Locale): string {
  const m = DECIMAL_TEXT.exec(value.trim());
  if (!m) return `${value} ${currency}`;
  const [, sign = '', whole = '0', fraction = ''] = m;
  const units = minorUnitsOf(currency);
  let digits = fraction;
  while (digits.length > units && digits.endsWith('0')) digits = digits.slice(0, -1);
  digits = digits.padEnd(units, '0');
  const format = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: digits.length,
    maximumFractionDigits: digits.length,
  });
  const text = format
    .formatToParts(BigInt(whole))
    .map((part) => (part.type === 'fraction' ? digits : part.value))
    .join('');
  return westernDigits(`${sign}${text}`);
}

/**
 * A typed major-unit amount → its minor-unit string, or null when the text is
 * not an amount in that currency's precision. The only money parser the
 * screens use (A-17).
 */
export function amountInputToMinor(input: string, currency: string): string | null {
  const text = normaliseDigits(input);
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  try {
    return parseMajorToMinor(text, minorUnitsOf(currency));
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

// ── Dates and names ──────────────────────────────────────────────────────

/**
 * The bidi marks CLDR puts inside a formatted date (Arabic "14‏/08‏/2026"
 * carries U+200F after each part). Inside `<bdi dir="ltr">` they reorder the
 * runs, so "14/08/2026" would render as "142026/08/": they are dropped.
 */
const DATE_BIDI_MARKS = /[‎‏؜]/g;

function dateText(at: Date, locale: Locale, timeZone: 'UTC' | undefined): string {
  const format = new Intl.DateTimeFormat(`${locale}-u-nu-latn`, { dateStyle: 'medium', ...(timeZone ? { timeZone } : {}) });
  return westernDigits(format.format(at)).replace(DATE_BIDI_MARKS, '');
}

/**
 * A civil date (`YYYY-MM-DD`, or the date part of an ISO text) in the locale's
 * words, Western digits and no bidi marks — the ONE date style of every S7
 * screen (A-16(5)). Text that is not a date comes back as it was.
 */
export function formatCivilDate(iso: string, locale: Locale): string {
  const at = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? iso : dateText(at, locale, 'UTC');
}

/** The calendar day of a moment (an ISO timestamp) in the browser's time zone, in the same style as `formatCivilDate`. */
export function formatMomentDate(iso: string, locale: Locale): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : dateText(at, locale, undefined);
}

/** `YYYY-MM-DD` of the given moment in the browser's calendar day — the default document date. */
export function localDateIso(at: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The locale's name, then Arabic, then any (the Phase 1 rule), or null when none is set. */
export function pickLocalized(names: Readonly<Partial<Record<Locale, string | null>>>, locale: Locale): string | null {
  const direct = names[locale];
  if (direct) return direct;
  if (names.ar) return names.ar;
  for (const value of Object.values(names)) if (value) return value;
  return null;
}

// ── Rendering numbers inside sentences ───────────────────────────────────

/** A number, amount, date or code, isolated left-to-right (A-16(5)). */
export function Ltr(props: { children: ReactNode }): ReactElement {
  return createElement('bdi', { dir: 'ltr' }, props.children);
}

/**
 * A translated template with React nodes for its `{name}` placeholders, so a
 * number inside a sentence can sit in its own `<bdi>`: pass `t(key)` (no
 * vars — the template comes back with its placeholders) and the nodes.
 */
export function rich(template: string, vars: Readonly<Record<string, ReactNode>>): ReactElement {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const index = m.index;
    const name = m[1] ?? '';
    if (!Object.hasOwn(vars, name)) continue;
    if (index > last) parts.push(template.slice(last, index));
    parts.push(createElement(Fragment, { key: `${name}-${index}` }, vars[name]));
    last = index + m[0].length;
  }
  if (last < template.length) parts.push(template.slice(last));
  return createElement(Fragment, null, ...parts);
}

// ── Form document ids (A-12(4)) ──────────────────────────────────────────

/**
 * The document id a form mints ONCE, when it opens, and keeps across every
 * retry — a double submit or a retried request is then a replay (A-10). Reset
 * only when the command succeeded or the merchant starts a new form.
 */
export function useFormDocumentId(): [id: string, reset: () => void] {
  const [id, setId] = useState(() => crypto.randomUUID());
  const reset = useCallback(() => setId(crypto.randomUUID()), []);
  return [id, reset];
}

// ── The view contract (§4.3, §5) ─────────────────────────────────────────

/** The translate function a view receives (`makeT(locale)`). */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** What every pure view receives besides its data: nothing from `next/*`, no client. */
export interface ViewBaseProps {
  t: Translate;
  locale: Locale;
}

/** One rendering of a view with one fixture, as the SSR suites run it. */
export interface ViewFixture {
  readonly name: string;
  /** The data props, kept for T-08, which searches them for values that must never render. */
  readonly props: unknown;
  readonly render: (base: ViewBaseProps) => ReactElement;
}

/** One `VIEW_REGISTRY` entry: a pure view and the fixtures it is rendered with (T-08, T-15, T-16). */
export interface ViewEntry {
  readonly name: string;
  readonly fixtures: readonly ViewFixture[];
}

/**
 * Register a pure view with named fixtures. Each area exports
 * `VIEW_REGISTRY: readonly ViewEntry[]` from `src/views/<area>/registry.ts`.
 * Fixtures should include the hidden values a real DTO carries (trace ids,
 * entry ids, the stock sequence…), deliberately, so T-08 can prove the view
 * never renders them.
 */
export function defineView<P extends object>(name: string, component: ComponentType<P & ViewBaseProps>, fixtures: Readonly<Record<string, P>>): ViewEntry {
  return {
    name,
    fixtures: Object.entries(fixtures).map(([fixtureName, props]) => ({
      name: fixtureName,
      props,
      render: (base: ViewBaseProps) => createElement(component, { ...props, ...base }),
    })),
  };
}
