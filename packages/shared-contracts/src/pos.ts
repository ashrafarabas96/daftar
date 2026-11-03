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

import type { SaleSettlementMode } from '@daftar/domain-core';
import type { SaleDto } from './sales';

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

// ── THE POS CHECKOUT (P4-S3, TL-P4-S3-R1) ────────────────────────────────

/**
 * `POST /v1/pos/till-sessions/:sessionId/checkout` — the request body.
 *
 * Read the field list as the law. There is **no `lines` array**, **no
 * `warehouseId`**, **no currency**, **no total, subtotal or discount**, and
 * **no price of any kind**. The basket is server-side state keyed by the till
 * session in the path, so the only thing a till can say about WHAT is being
 * sold is "the session I am at"; everything else — product, stock variant,
 * quantity, price, discount authority, tax, subtotal, total, currency — is
 * read from `pos_cart_lines` and the catalogue inside the checkout's own
 * transaction (P4-AL-18, CART SNAPSHOT LAW).
 *
 * `saleId` is the caller-supplied document identity the replay is keyed on,
 * exactly as `POST /v1/sales` keys it (P4-AL-30). There is no
 * `Idempotency-Key` header and no generic key subsystem: the stored
 * `sales.commit_intent_sha256` is the intent fingerprint, and the proof is
 * consulted BEFORE any current state is read.
 */
export interface PosCheckoutRequestDto {
  /** The sale this checkout commits, and the replay key. */
  saleId: string;
  settlementMode: SaleSettlementMode;
  /** Null for a walk-in. A credit checkout names the customer who owes it. */
  customerId: string | null;
  documentDate: string;
  dueDate: string | null;
  /** Always `"0"` while P4-AL-44 holds and OD-03 is open. */
  taxMinor: '0';
  notes: string | null;
}

/**
 * What the checkout answers with: the accepted sale exactly as
 * `POST /v1/sales` reports it, plus what this call did to the BASKET.
 *
 * `consumedCartLineIds` is the whole of the consumption claim, stated rather
 * than implied: these are the `pos_cart_lines` rows this sale was derived
 * from and the rows that carry a tombstone as of its COMMIT.
 *
 * Every sale line's `lineId` IS one of them — a POS sale line is the cart line
 * it came from, which is what ties the consumed row identity to the accepted
 * cart snapshot rather than to "whatever is active now". The list can be
 * LONGER than the sale's lines, because the basket is append-only and the
 * accepted sale has one line per stock key: two scans of one product are two
 * cart rows, both consumed, merged into one sale line that carries their
 * total and the id of the first of them.
 *
 * On a replay the sale is the stored one, `sale.replayed` is `true`, and this
 * list is the stored sale's own line ids — the original snapshot's
 * representatives. A replay clears NOTHING: lines added after the first
 * successful checkout are not in that list and are still in the basket, and a
 * till that wants the exact basket re-reads it rather than deducing it.
 */
export interface PosCheckoutDto {
  tillSessionId: string;
  sale: SaleDto;
  consumedCartLineIds: string[];
}
