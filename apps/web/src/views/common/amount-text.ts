/**
 * Text helpers for the amounts the merchant edits (P3-S7 contract A-17).
 * Pure string work: an amount the server returned in minor units is re-spelled
 * as the major-unit text an amount field holds, so a proposal can pre-fill a
 * field. No arithmetic, no float: digits are moved, never computed.
 */
import { minorUnitsOf } from '@daftar/shared-contracts';

/** `"12500"` in a 2-decimal currency → `"125.00"`; `"7"` in a 3-decimal currency → `"0.007"`. Non-integer text comes back as it was. */
export function minorToMajorText(amountMinor: string, currency: string): string {
  const m = /^(-?)(\d+)$/.exec(amountMinor.trim());
  if (!m) return amountMinor;
  const [, sign = '', digits = '0'] = m;
  const units = minorUnitsOf(currency);
  if (units === 0) return `${sign}${digits}`;
  const padded = digits.padStart(units + 1, '0');
  return `${sign}${padded.slice(0, padded.length - units)}.${padded.slice(padded.length - units)}`;
}

/** A decimal quantity without its trailing fraction zeros (`"10.5000"` → `"10.5"`, `"3.000"` → `"3"`), by text. */
export function trimFractionZeros(quantity: string): string {
  return /^\d+\.\d+$/.test(quantity) ? quantity.replace(/0+$/, '').replace(/\.$/, '') : quantity;
}

/** True when a minor-unit integer string holds a non-zero digit — the "is there anything" question, answered by text. */
export function isNonZeroMinor(amountMinor: string | null | undefined): boolean {
  return typeof amountMinor === 'string' && /^-?\d+$/.test(amountMinor) && /[1-9]/.test(amountMinor);
}

/**
 * TD-16: the purchase's remaining amount is a leftover smaller than the
 * smallest coin of the business's currency — something is still owed in the
 * purchase's currency (`outstandingTxnMinor` > 0) and nothing in the
 * business's (`outstandingBaseMinor` = 0). It can be neither paid nor
 * returned against; the server offers only its write-off. Answered by text.
 */
export function isLeftoverOnly(payable: { outstandingTxnMinor: string; outstandingBaseMinor: string } | null): boolean {
  if (payable === null) return false;
  return /^\d+$/.test(payable.outstandingTxnMinor) && isNonZeroMinor(payable.outstandingTxnMinor) && /^0+$/.test(payable.outstandingBaseMinor);
}
