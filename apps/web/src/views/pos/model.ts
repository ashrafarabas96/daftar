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
import type { PosCartLineDto } from '@/lib/phase4-pos-api';

/** A basket line's identity on screen, for a React key and a draft map. */
export const basketLineKey = (line: Pick<PosCartLineDto, 'cartLineId'>): string => line.cartLineId;

/**
 * How many fraction digits a cart quantity may carry.
 *
 * `CartAddLineSchema`/`CartChangeQuantitySchema` hold a quantity to
 * `^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$` — "a decimal with at most four
 * fraction digits", exact at what the `NUMERIC(18,4)` shape admits
 * (`pos-cart.schemas.ts`). The PRODUCT's own `unit_decimals` is a stricter
 * rule and it is checked in the SERVICE, under the product's lock, because it
 * is a read the browser does not have: `CartDto` carries no `unitDecimals` on
 * a line, so the screen cannot know a unit's precision for a line it did not
 * just search for.
 *
 * So the screen checks the SHAPE it can know and lets the server refuse what
 * only the server knows (`pos.cart_quantity_invalid`, which has merchant text
 * in all three locales). A client that guessed the unit's precision would
 * refuse a quantity the till would have accepted.
 */
export const CART_QUANTITY_DECIMALS = 4;

/**
 * The quantity text to send for a line, or null when what was typed is not a
 * quantity of the shape the cart admits. Zero is not a quantity: a line is
 * removed, not set to none.
 */
export function basketQuantity(input: string): string | null {
  const text = normaliseDigits(input);
  if (!isQuantityText(text, CART_QUANTITY_DECIMALS)) return null;
  if (isZeroQuantityText(text)) return null;
  return text;
}

/**
 * The discount REQUEST for one line, in integer minor units of the basket's
 * currency, or null when what was typed is not an amount in that currency's
 * precision. Empty text asks for no discount at all, which is a REMOVAL.
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
