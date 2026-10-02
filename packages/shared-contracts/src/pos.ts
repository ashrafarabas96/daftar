/**
 * The POS read contract — P4-S3.
 *
 * ONE read lives here: the product type-ahead a cashier drives from the
 * keyboard or a barcode scanner. Money is an integer count of minor units in a
 * STRING, never a JSON number (§41); a quantity is a decimal STRING with the
 * unit's own number of fraction digits.
 *
 * `variantId` is `null` for a simple product: the hidden base variant never
 * leaves the server (P3-AL-52), exactly as the inventory contract has it.
 *
 * **There is no `nextCursor` and no page number**, and that is deliberate
 * rather than unfinished. A type-ahead is narrowed by typing one more
 * character, not by walking pages: `OFFSET` is forbidden to every read module
 * (G-6), and a keyset cursor over a UNION of five independent index ranges
 * would need one cursor per arm and would still reorder under a catalogue
 * edit. So the read answers the best `limit` matches and says, in
 * `moreMatches`, that the prefix was too broad — which is the answer a cashier
 * can act on.
 *
 * **No price arithmetic happens here and no tax is computed at all.** The read
 * reports the catalogue's unit price so the screen can show it; what a line
 * costs is the server's own recomputation at cart and sale time (P4-AL-18),
 * and `OD-03` is OPEN, so a non-zero tax is refused rather than guessed.
 */

/** Which index arm matched the typed prefix. A scanned barcode ranks first, then SKU, then name. */
export type PosMatchKindDto = 'barcode' | 'sku' | 'name';

/** One sellable unit the cashier may add to the basket. */
export interface PosProductHitDto {
  productId: string;
  /** `null` for a simple product — the base variant is never named outside the server (P3-AL-52). */
  variantId: string | null;
  /** The product's name in the requested locale, then `ar`, then any (the Phase 1 fallback). */
  name: string;
  /** A merchant variant's display name, or `null` for a simple product. */
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  unitCode: string | null;
  /** How many fraction digits the unit allows; `null` for an unconfigured product. */
  unitDecimals: number | null;
  /** The CATALOGUE price of one unit, minor units as a string. The sale's own figure is recomputed server-side. */
  unitPriceMinor: string;
  currency: string;
  /**
   * On hand at the till's warehouse, as a decimal string with `unitDecimals`
   * fraction digits — derived from `stock_levels` at request time, never
   * stored or cached as an availability figure.
   *
   * `null` for a product that does not track inventory: a gift card has no
   * stock, and `0` would read as "out of stock" and stop a sale that is fine.
   */
  onHand: string | null;
  trackInventory: boolean;
  matchedOn: PosMatchKindDto;
}

/** `GET /v1/pos/products` — the type-ahead's answer. */
export interface PosProductSearchDto {
  /** The prefix the server actually searched on, lower-cased and trimmed. */
  query: string;
  /**
   * The warehouse the figures are from — DERIVED by the server from the
   * session the request named, never supplied by the client (RULING 2). It is
   * echoed because a till that renders an availability figure should be able
   * to say which warehouse it is the availability of, and because a client
   * that silently assumed the wrong one would mis-state stock.
   */
  warehouseId: string;
  items: PosProductHitDto[];
  /**
   * `true` when at least one further match was found and dropped: the prefix
   * is too broad, and the cashier narrows it by typing. There is no page two.
   */
  moreMatches: boolean;
}
