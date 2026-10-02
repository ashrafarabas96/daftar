/**
 * The POS screens' pure text helpers (P4-S3).
 *
 * NO ARITHMETIC. Money is an integer minor-unit string from the server to the
 * formatter; the only number this module makes is the ONE the trust boundary
 * allows the client to send — a discount request in minor units, produced by
 * `amountInputToMinor`, which is `parseMajorToMinor` (BigInt) underneath.
 * Quantities are checked by shape and passed on as the text they were typed in.
 */
import { amountInputToMinor, isQuantityText, isZeroQuantityText, normaliseDigits } from '@/lib/phase3-format';
import type { PosBasketLineDto } from '@/lib/phase4-pos-api';

/** A basket line's identity on screen, for a React key and a draft map. */
export const basketLineKey = (line: Pick<PosBasketLineDto, 'lineId'>): string => line.lineId;

/**
 * The quantity text to send for a line, or null when what was typed is not a
 * quantity of that unit. Zero is not a quantity: a line is removed, not set to
 * none.
 */
export function basketQuantity(input: string, decimals: number): string | null {
  const text = normaliseDigits(input);
  if (!isQuantityText(text, decimals)) return null;
  if (isZeroQuantityText(text)) return null;
  return text;
}

/**
 * The discount REQUEST, in integer minor units of the basket's currency, or
 * null when what was typed is not an amount in that currency's precision.
 * Empty text asks for no discount at all.
 */
export function discountRequestMinor(input: string, currency: string): string | null {
  const text = normaliseDigits(input);
  if (text === '') return '0';
  return amountInputToMinor(text, currency);
}

/**
 * True when a minor-unit amount the server sent is not zero — read as TEXT
 * (any digit other than zero), so the screen never parses money into a number.
 */
export function hasAmount(amountMinor: string): boolean {
  return /[1-9]/.test(amountMinor);
}
