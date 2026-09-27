/**
 * The shapes the stock screens hold between the page and the pure views
 * (P3-S7 contract A-11, A-13), and the text-only helpers they share.
 *
 * Nothing here computes a quantity or an amount (§0, A-17): a quantity is a
 * decimal string the merchant typed or the server returned, and it is only
 * checked by shape, re-spelled, or its sign read from its text. The server
 * decides every outcome; the views show its answer.
 */
import type { InventoryItemDto, InventoryStockRowDto } from '@/lib/phase3-api';
import type { Locale } from '@/lib/i18n';
import { isQuantityText, isZeroQuantityText, normaliseDigits } from '@/lib/phase3-format';

/** One pickable stock identity: a product, and its merchant variant when it has them (never the base variant). */
export interface PickOption {
  /** `productId:variantId` — the identity, used as a React key and to find a line again. */
  readonly key: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly name: string;
  readonly variantName: string | null;
  readonly unitCode: string | null;
  readonly unitDecimals: number;
  /** The on-hand quantity in the chosen warehouse, or null where the screen must not show it (a blind count, TL-8). */
  readonly onHand: string | null;
}

/** A line of a Move Stock / Adjust Stock / Count Stock form, as the merchant is filling it in. */
export interface DraftLine extends PickOption {
  /** Minted once per added line (A-12(4)); a React key only. */
  readonly lineKey: string;
  /** The typed quantity, as typed. */
  readonly quantity: string;
  /** The typed cost per unit, in major units of the business currency, as typed. */
  readonly unitCost: string;
  /** True once the server asked for a cost on this line (`inventory.unit_cost_required`, A-13). */
  readonly needsCost: boolean;
}

/** The identity key of a line: product plus merchant variant. */
export const identityKey = (productId: string, variantId: string | null): string => `${productId}:${variantId ?? ''}`;

/** Stock rows as pick options: each row already names one stock identity and its on-hand quantity (A-07). */
export function stockRowOptions(rows: readonly InventoryStockRowDto[]): PickOption[] {
  return rows.map((r) => ({
    key: identityKey(r.productId, r.variantId),
    productId: r.productId,
    variantId: r.variantId,
    name: r.name,
    variantName: r.variantName,
    unitCode: r.unitCode,
    unitDecimals: r.unitDecimals,
    onHand: r.onHand,
  }));
}

/**
 * Items as pick options, with no quantity (the Count Stock picker, TL-8): a
 * simple product is one option, a product with merchant variants one option
 * per active variant. An item without a unit is not tracked and cannot be
 * picked; archived items and variants are not offered (A-18).
 */
export function itemOptions(items: readonly InventoryItemDto[]): PickOption[] {
  const out: PickOption[] = [];
  for (const item of items) {
    if (item.status !== 'active' || !item.trackInventory || item.unitDecimals === null) continue;
    const base = { productId: item.productId, name: item.name, unitCode: item.unitCode, unitDecimals: item.unitDecimals, onHand: null };
    if (item.variants.length === 0) {
      out.push({ ...base, key: identityKey(item.productId, null), variantId: null, variantName: null });
      continue;
    }
    for (const v of item.variants) {
      if (v.status !== 'active') continue;
      out.push({ ...base, key: identityKey(item.productId, v.variantId), variantId: v.variantId, variantName: v.name });
    }
  }
  return out;
}

/** A new form line from a picked option. */
export function draftLineOf(option: PickOption, lineKey: string): DraftLine {
  return { ...option, lineKey, quantity: '', unitCost: '', needsCost: false };
}

/** True when the decimal text is negative (its sign, read from the text). */
export const isNegativeText = (value: string): boolean => value.trim().startsWith('-');

/**
 * A server quantity re-spelled at the unit's precision: fraction zeros beyond
 * `decimals` are dropped ("5.0000" at 0 decimals is "5"). Only zeros are
 * removed, so no value is ever rounded.
 */
export function trimQtyText(value: string, decimals: number): string {
  const m = /^(-?\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!m) return value;
  const whole = m[1] ?? '0';
  let fraction = m[2] ?? '';
  while (fraction.length > decimals && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

/** A calendar date of an ISO timestamp in the locale's numeric form, Western digits (A-16(5)). */
export function formatDateText(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(`${locale}-u-nu-latn`, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at).replace(/[‎‏؜]/g, '');
}

/** The reason the merchant picks on Adjust Stock (A-13; "Starting stock" is TL-4). */
export type AdjustReason = 'found' | 'missing' | 'damaged' | 'starting';

/** A typed quantity as the command receives it: Western digits, `.` as the separator (A-17). */
export const quantityText = (typed: string): string => normaliseDigits(typed);

/**
 * The lines whose typed quantity is not a quantity of their unit, by line key,
 * with the catalog key that says so. A shape check only (A-17): the server
 * still judges every quantity. `allowZero` is for a count, where an empty
 * shelf is a count.
 */
export function lineQuantityErrors(lines: readonly DraftLine[], allowZero: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const text = quantityText(line.quantity);
    if (!isQuantityText(text, line.unitDecimals)) out[line.lineKey] = 'stock.line.quantityInvalid';
    else if (!allowZero && isZeroQuantityText(text)) out[line.lineKey] = 'stock.line.quantityZero';
  }
  return out;
}
