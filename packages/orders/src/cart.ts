/**
 * The storefront basket — Phase 6 (`PREPARED / NOT PROMOTED`).
 *
 * The basket holds IDENTITIES and QUANTITIES and nothing else. There is no
 * price, no line total, no subtotal, no discount amount and no currency in any
 * type below, because every one of those is recomputed by the sales authority
 * inside the sale commit's own transaction (P4-AL-18, CART SNAPSHOT LAW). A
 * basket that carried a total would be a second number for the same money with
 * a second writer and nothing tying them together.
 *
 * The basket is APPEND-ONLY, exactly as the POS basket is: two scans of one
 * product are two rows, and they are merged into one position per stock key
 * when the order is placed. That merge is here rather than at each client, so
 * the storefront and the till agree on what "two of the same thing" means —
 * `consumedCartLineIds` in `PosCheckoutDto` is longer than the sale's line
 * list for exactly this reason, and the first row of a position is its
 * representative.
 *
 * Quantity precision is NOT re-implemented here. `@daftar/inventory` owns the
 * Q4 fixed-point parse and the representability law, and this module calls it:
 * one inventory truth, so a quantity the ledger would refuse is refused in the
 * basket too, in the same vocabulary.
 */
import { assertQuantityRepresentable, formatQuantity, parseQuantity } from '@daftar/inventory';
import { OrderError, assertCanonicalId, isCanonicalId } from './errors';
import { isCanonicalInstant } from './instant';
import { type UnitPrecisionDeclaration, requireUnitPrecision } from './unit-precision';

/** One basket row as the client appended it. */
export interface CartLine {
  /** Canonical lowercase UUID, the CLIENT's — it becomes the sale line's `lineId`, so the server never mints it. */
  lineId: string;
  productId: string;
  /** The merchant variant, or `null` for a product that has none. Never the hidden base variant (P3-AL-52). */
  variantId: string | null;
  /** A positive decimal string, exact at the product's unit precision. */
  quantity: string;
  /**
   * When the shopper removed this line, as a canonical RFC3339 UTC instant, or
   * `null` for a live line.
   *
   * REQUIRED, not optional, and that is the whole point of it. A basket line is
   * append-only in the database — `I2.4` refuses UPDATE of the quantity, DELETE
   * and TRUNCATE — so a removal is a TOMBSTONE and never a deletion, and this
   * field is how the merge knows. An OPTIONAL field here would leave the law
   * unclaimed by default: a caller that omitted it would get every retracted
   * line counted, silently, and the shopper would be charged for what they took
   * out of the basket. The migration request states the merge is "over the
   * non-retracted rows" (`I2.6`), and the round-7 Challenger was right that the
   * sentence had no implementation: a law stated in a migration request and
   * absent from the code that reads the relation is a law nobody enforces.
   */
  retractedAt: string | null;
}

/**
 * The stock key a basket position is grouped by: a product, plus the merchant
 * variant when there is one. It is the same identity the sale line states and
 * the same one `stock_levels` is keyed on, so the three cannot drift.
 */
export function stockKeyOf(line: { productId: string; variantId: string | null }): string {
  return `${line.productId}:${line.variantId ?? ''}`;
}

/** One merged position: everything the basket asks for of one stock key. */
export interface BasketPosition {
  stockKey: string;
  productId: string;
  variantId: string | null;
  /** The SUM of the position's rows, as a decimal string at Q4. */
  totalQuantity: string;
  /** The same sum as exact Q4 fixed point, for callers that must compare without re-parsing. */
  totalQuantityQ4: bigint;
  /** Every row that contributed, in the order they were appended. */
  lineIds: readonly string[];
  /** The FIRST contributing row — the id the merged sale line will carry. */
  representativeLineId: string;
  /**
   * The product's frozen unit precision, as the caller declared it for this
   * stock key and as this function CHECKED the quantity against, or `null`
   * where the catalogue declares none. It is carried on the position rather
   * than left to be supplied a second time downstream: a precision the
   * hand-off has to be given again is a precision it can be given differently,
   * and then a law is claimed against the wrong figure or silently not claimed
   * at all.
   *
   * `null` is NOT "unknown" and not "4". It is the catalogue's own statement
   * that this product has no unit precision, which the frozen schema permits
   * exactly for a product that does not track inventory — see
   * `unit-precision.ts`. A reader must not read it as an absence to fill in.
   */
  unitDecimals: number | null;
  /**
   * `products.track_inventory` for this stock key, as declared. It travels with
   * the precision because it is the other half of the law that admitted it: a
   * `null` precision is lawful only here, and a downstream reader that saw the
   * `null` without this flag could not tell a precision-free service from a
   * tracked product whose precision went missing.
   */
  tracksInventory: boolean;
}

/**
 * Merge a basket into one position per stock key, over the LIVE lines only.
 *
 * `precisionByStockKey` is REQUIRED and must cover every stock key the basket
 * names: a caller that does not know what the catalogue declares for a product
 * cannot validate a quantity against it, and accepting the line anyway would
 * push an unrepresentable quantity to a layer that can only refuse it later.
 *
 * A DECLARATION is asked for, not a number, because the frozen catalogue's law
 * is a relationship between `track_inventory` and `unit_decimals` rather than a
 * number on its own: a precision-free product is lawful and sellable, and
 * `unit-precision.ts` holds the whole of that law.
 *
 * Positions come back in order of FIRST APPEARANCE, which is deterministic
 * from the input and does not depend on how a UUID happens to sort.
 */
export function summariseBasket(lines: readonly CartLine[], precisionByStockKey: ReadonlyMap<string, UnitPrecisionDeclaration>): readonly BasketPosition[] {
  if (lines.length === 0) {
    throw new OrderError('order.cart_empty', 'a basket must carry at least one line');
  }

  const seenLineIds = new Set<string>();
  let retractedLines = 0;
  const byKey = new Map<
    string,
    { productId: string; variantId: string | null; total: bigint; lineIds: string[]; unitDecimals: number | null; tracksInventory: boolean }
  >();

  for (const line of lines) {
    assertCanonicalId(line.lineId, 'lineId');
    if (seenLineIds.has(line.lineId)) {
      throw new OrderError('order.cart_line_duplicate', 'two basket lines share a lineId', { lineId: line.lineId });
    }
    seenLineIds.add(line.lineId);

    // The retraction is read BEFORE anything else about the line is judged, and a
    // retracted line is then skipped. It contributes no quantity, so nothing
    // about its quantity or its product's precision can make a basket
    // unorderable: a shopper who removed a line must be able to check out even
    // if that line could no longer be priced — the catalogue may have changed
    // its unit precision since, and refusing the whole basket over a line the
    // shopper already took out would be a defect, not strictness. Its ID is
    // still claimed above, so a retracted line cannot be reused to smuggle a
    // duplicate.
    // An ABSENT field is caught here too, and deliberately by the same branch:
    // `undefined !== null`, so it enters and fails the shape check with
    // `stated: "undefined"`. A type-only requirement has no runtime existence.
    if (line.retractedAt !== null) {
      if (typeof line.retractedAt !== 'string' || !isCanonicalInstant(line.retractedAt)) {
        throw new OrderError(
          'order.cart_line_invalid',
          'a retracted basket line states its retraction as a canonical RFC3339 UTC instant at second precision',
          {
            lineId: line.lineId,
            stated: String(line.retractedAt),
          },
        );
      }
      retractedLines += 1;
      continue;
    }
    assertCanonicalId(line.productId, 'productId');
    if (line.variantId !== null && !isCanonicalId(line.variantId)) {
      throw new OrderError('order.cart_line_invalid', 'variantId must be a canonical lowercase UUID or null', { lineId: line.lineId });
    }

    const key = stockKeyOf(line);
    const declaration = precisionByStockKey.get(key);
    if (declaration === undefined) {
      throw new OrderError('order.cart_line_invalid', 'no unit precision declaration was supplied for the line stock key', {
        lineId: line.lineId,
        stockKey: key,
      });
    }
    const unitDecimals = requireUnitPrecision(declaration, { lineId: line.lineId, stockKey: key });

    let q4: bigint;
    try {
      q4 = parseQuantity(line.quantity);
    } catch {
      throw new OrderError('order.cart_quantity_invalid', 'quantity is not an exact decimal at the supported scale', { lineId: line.lineId });
    }
    if (q4 <= 0n) {
      throw new OrderError('order.cart_quantity_invalid', 'a basket line quantity is strictly positive', { lineId: line.lineId });
    }
    if (unitDecimals !== null) {
      try {
        assertQuantityRepresentable(q4, unitDecimals);
      } catch {
        throw new OrderError('order.cart_quantity_invalid', 'quantity is not representable at the product unit precision', { lineId: line.lineId });
      }
    }
    // When the catalogue declares NO precision, the only bound is the one
    // `parseQuantity` has already applied: the storage scale of
    // `NUMERIC(18,4)`. That is a fact of the frozen schema, not a default
    // chosen here, and OD-P6-08 is where a narrower merchant rule would come
    // from.

    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        productId: line.productId,
        variantId: line.variantId,
        total: q4,
        lineIds: [line.lineId],
        unitDecimals,
        tracksInventory: declaration.tracksInventory,
      });
    } else {
      existing.total += q4;
      existing.lineIds.push(line.lineId);
    }
  }

  if (byKey.size === 0) {
    // Every line was retracted. The basket is not empty as a document, but it
    // asks for nothing, and a checkout over zero positions would be an order for
    // nothing. Same code as a basket with no lines at all, because the caller's
    // next action is the same.
    throw new OrderError('order.cart_empty', 'every line of this basket has been retracted, so it asks for nothing', {
      retractedLines: String(retractedLines),
    });
  }

  const positions: BasketPosition[] = [];
  for (const [stockKey, acc] of byKey) {
    const representativeLineId = acc.lineIds[0];
    if (representativeLineId === undefined) {
      // Unreachable: a key exists only because a line created it. Stated as a
      // refusal rather than a non-null assertion, so an impossible state fails
      // loudly instead of being asserted away.
      throw new OrderError('order.cart_line_invalid', 'a basket position carries no contributing line', { stockKey });
    }
    positions.push({
      stockKey,
      productId: acc.productId,
      variantId: acc.variantId,
      totalQuantity: formatQuantity(acc.total),
      totalQuantityQ4: acc.total,
      lineIds: Object.freeze([...acc.lineIds]),
      representativeLineId,
      unitDecimals: acc.unitDecimals,
      tracksInventory: acc.tracksInventory,
    });
  }
  return Object.freeze(positions);
}
