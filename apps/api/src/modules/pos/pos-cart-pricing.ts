import { parseMinor, parseQuantity } from '@daftar/inventory';
import { posRefusal } from './pos-errors';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * THE CART'S ARITHMETIC. Server-derived, integer minor units, ONE rounding.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Inputs: the CATALOGUE's price (resolved by the server) and the stored line's
 * quantity and discount request (the only two things a client may state,
 * P4-AL-18). Nothing here reads a figure that arrived in a request body —
 * `pos-price-authority.ts` has already refused the request that carried one.
 *
 * ## No stored derived truth (P4-AL-06)
 *
 * There is no `pos_cart_lines.line_total_minor` and no
 * `pos_till_sessions.cart_total_minor`, and this module is why there does not
 * need to be: every figure a till shows is computed from the stored quantity,
 * the stored discount and the live catalogue price on the way out. A stored
 * total is a second authority for one fact, and the moment the catalogue price
 * changes under an open basket the two authorities disagree — with the stale
 * one on the cashier's screen.
 *
 * ## ONE ROUNDING, and the reason it cannot be two
 *
 * `[[daftar-rounding-is-not-additive]]`. The accepted statement of the trap is
 * `packages/accounting/src/sale-posting.ts:39-56`: two layers obeying "the
 * same HALF_EVEN contract" at different aggregation grains disagree by
 * construction, and the disagreement is one minor unit on an otherwise
 * perfectly correct basket.
 *
 * So the roundings are COUNTED and there is exactly one GRAIN:
 *
 * - **the LINE grain rounds.** `gross = HALF_EVEN(quantity x unit price)`,
 *   once, from the exact fixed-point operands. `quantity` is Q4
 *   (`NUMERIC(18,4)`, the ledger's quantity type) and `base_price_minor` is
 *   already an integer count of minor units (`0005:21`), so the product is
 *   scaled by 10^4 and the quotient is taken at scale 0 with no intermediate
 *   rounding;
 * - **the CART grain does not round at all.** The subtotal, the discount total
 *   and the cart total are EXACT INTEGER SUMS of integers. There is no
 *   `HALF_EVEN(Σ ...)` anywhere in this file, and `roundingGrains` below
 *   reports the fact rather than asserting it in a comment.
 *
 * The count is not folklore: every rounding in this module goes through
 * `halfEvenAtLineGrain`, which records its grain in a `RoundingLedger` the
 * caller gets back. `tests/guards/pos-s3-cart-law.test.ts` asserts that a
 * fifty-line cart's ledger holds the grain set `{'line'}` and nothing else,
 * and `tests/integration/pos-s3-cart.test.ts` asserts the same ledger through
 * the service. A second rounding layer added later cannot be silent: it
 * either goes through this function and appears in the ledger, or it does not
 * and `pos.cart_rounding_grain_invalid` fires.
 *
 * ## No float, anywhere
 *
 * Every figure is a `bigint`. `Number`, `parseFloat`, `Math.round` and `/`
 * on numbers do not appear in this file, and the guard suite asserts their
 * absence from its source text as well as asserting the behaviour — because
 * «no Float/Double money anywhere» is a property of the code and not only of
 * the outputs the tests happened to choose.
 */

/** The ledger's only legal grain. A second entry here is a design change, not a refactor. */
export type RoundingGrain = 'line';

/** Every rounding one pricing pass performed, with the grain it happened at. */
export interface RoundingLedger {
  readonly entries: readonly { readonly grain: RoundingGrain; readonly label: string }[];
}

/** The distinct grains a pass rounded at. Exactly one, for every cart of every size. */
export function roundingGrains(ledger: RoundingLedger): readonly string[] {
  return [...new Set(ledger.entries.map((e) => e.grain))].sort();
}

/**
 * The ONE rounding of the cart: exact `HALF_EVEN` of `n / d` at scale 0, by
 * integer division and remainder, sign-symmetric, with no float.
 *
 * The same arithmetic as `inventory_half_even` (`0060:85-111`),
 * `packages/inventory`'s `roundHalfEven` and the sale commit's own
 * `halfEvenDiv`, because a second rounding RULE would disagree only on the
 * numbers nobody tested. It is written here rather than imported for one
 * reason: the ledger. A rounding that is not recorded is a rounding nobody
 * can count, and counting them is the law.
 */
function halfEvenAtLineGrain(n: bigint, d: bigint, label: string, into: { grain: RoundingGrain; label: string }[]): bigint {
  if (d <= 0n) throw posRefusal('pos.cart_minor_units_invalid');
  into.push({ grain: 'line', label });
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  const r = a - q * d;
  if (2n * r > d || (2n * r === d && q % 2n !== 0n)) q += 1n;
  return neg ? -q : q;
}

/** Q4: the scale `NUMERIC(18,4)` quantities are exact at. */
const QUANTITY_SCALE = 10n ** 4n;

/**
 * One stored cart line, as the server reads it back — the stored facts and
 * the CATALOGUE's price, joined by the projection statement.
 *
 * `quantity` and `discountMinor` are the client's two statements, as stored.
 * `unitPriceMinor`, `priceCurrency` and `nameSnapshot` are the server's, read
 * from the catalogue on every recomputation and never copied into the cart
 * row — see "No stored derived truth" above.
 */
export interface StoredCartLine {
  readonly cartLineId: string;
  readonly productId: string;
  readonly variantId: string | null;
  /** A decimal string, exact at the product's unit precision. Never a JSON number. */
  readonly quantity: string;
  /** A non-negative integer count of minor units, as a decimal string. The discount REQUEST. */
  readonly discountMinor: string;
  /** The catalogue's integer price in minor units, or null for an unpriced product. */
  readonly unitPriceMinor: string | null;
  readonly priceCurrency: string | null;
  readonly nameSnapshot: string;
}

/** One priced line. Every money figure is an exact integer count of minor units. */
export interface PricedCartLine {
  readonly cartLineId: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly nameSnapshot: string;
  readonly quantityQ4: bigint;
  readonly unitPriceMinor: bigint;
  /** `HALF_EVEN(quantity x unit price)` — the ONE rounding, at the line grain. */
  readonly grossMinor: bigint;
  readonly discountMinor: bigint;
  /** `gross - discount`. Exact integer subtraction; no rounding. */
  readonly netMinor: bigint;
}

/** The whole priced cart. Nothing in it is stored; all of it is derived. */
export interface PricedCart {
  readonly currency: string;
  /** Exact integer sum of the line grosses. No rounding at this grain. */
  readonly subtotalMinor: bigint;
  /** Exact integer sum of the requested discounts. No rounding at this grain. */
  readonly discountMinor: bigint;
  /** Exact integer sum of the line nets. No rounding at this grain. */
  readonly totalMinor: bigint;
  /** Structurally zero (P4-AL-44, `OD-03` OPEN). Derived, never stated, never a rate. */
  readonly taxMinor: bigint;
  readonly lines: readonly PricedCartLine[];
  /** Every rounding this pass performed. Exactly one grain, whatever the line count. */
  readonly rounding: RoundingLedger;
}

/** A cart may hold at most this many lines. A till basket is not a bulk import. */
export const MAX_CART_LINES = 200;

/**
 * Price a whole cart from the stored lines and the catalogue.
 *
 * An EMPTY cart is a legitimate state and prices to zero: a cashier who has
 * just opened a till has an empty basket, and refusing to describe it would
 * make the first `GET` an error. `sale.total_zero` is the sale's refusal of a
 * zero-valued DOCUMENT and belongs where a document is created — not here,
 * one layer before the merchant has decided to sell anything.
 */
export function priceCart(lines: readonly StoredCartLine[], fallbackCurrency: string): PricedCart {
  if (lines.length > MAX_CART_LINES) throw posRefusal('pos.cart_lines_too_many');
  const entries: { grain: RoundingGrain; label: string }[] = [];
  const priced: PricedCartLine[] = [];
  let currency: string | null = null;
  let subtotal = 0n;
  let discountTotal = 0n;

  for (const line of lines) {
    if (line.unitPriceMinor === null || line.priceCurrency === null) throw posRefusal('pos.cart_product_not_priced');
    if (currency === null) currency = line.priceCurrency;
    // A basket mixing two price currencies has no single total to show, and
    // converting would invent a cross-rate nobody stated.
    else if (currency !== line.priceCurrency) throw posRefusal('pos.cart_currency_mixed');

    const quantityQ4 = parseQuantity(line.quantity);
    if (quantityQ4 <= 0n) throw posRefusal('pos.cart_quantity_invalid');
    const unitPriceMinor = parseMinor(line.unitPriceMinor);
    // THE ONE ROUNDING. Recorded, at the line grain, once per line.
    const grossMinor = halfEvenAtLineGrain(quantityQ4 * unitPriceMinor, QUANTITY_SCALE, `line:${line.cartLineId}`, entries);
    const discountMinor = parseMinor(line.discountMinor);
    // A line discounted below zero is not a discount: it is the till paying
    // the customer, which P4-S3 cannot represent and must not approximate.
    if (discountMinor > grossMinor) throw posRefusal('pos.cart_discount_invalid');

    priced.push({
      cartLineId: line.cartLineId,
      productId: line.productId,
      variantId: line.variantId,
      nameSnapshot: line.nameSnapshot,
      quantityQ4,
      unitPriceMinor,
      grossMinor,
      discountMinor,
      netMinor: grossMinor - discountMinor,
    });
    // Exact integer accumulation at the CART grain. No HALF_EVEN here, ever.
    subtotal += grossMinor;
    discountTotal += discountMinor;
  }

  const cart: PricedCart = {
    currency: currency ?? fallbackCurrency,
    subtotalMinor: subtotal,
    discountMinor: discountTotal,
    totalMinor: subtotal - discountTotal,
    taxMinor: 0n,
    lines: priced,
    rounding: { entries },
  };
  assertPricedCartCoheres(cart);
  return cart;
}

/**
 * The module's own structural law, checked on the way out rather than trusted.
 *
 * Each clause is a 500 and not a merchant refusal, because each one means the
 * CART'S ARITHMETIC is broken and the merchant can do nothing about it. The
 * log gets the invariant's name; the response gets the generic envelope and no
 * details at all.
 */
export function assertPricedCartCoheres(cart: PricedCart): void {
  const grains = roundingGrains(cart.rounding);
  if (grains.length > 1 || (grains.length === 1 && grains[0] !== 'line')) {
    throw posRefusal('pos.cart_rounding_grain_invalid');
  }
  // The additive identities. If either fails, a second rounding layer has
  // appeared somewhere a grain label did not reach it.
  const subtotal = cart.lines.reduce((a, l) => a + l.grossMinor, 0n);
  const discount = cart.lines.reduce((a, l) => a + l.discountMinor, 0n);
  if (cart.subtotalMinor !== subtotal || cart.discountMinor !== discount || cart.totalMinor !== subtotal - discount) {
    throw posRefusal('pos.cart_rounding_grain_invalid');
  }
  if (cart.taxMinor !== 0n) throw posRefusal('pos.cart_minor_units_invalid');
}

/** Minor units as the wire carries them: a decimal STRING, never a JSON number, which is an IEEE double. */
export function minorToString(value: bigint): string {
  return value.toString(10);
}
