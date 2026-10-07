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

/** One basket row as the client appended it. */
export interface CartLine {
  /** Canonical lowercase UUID, the CLIENT's — it becomes the sale line's `lineId`, so the server never mints it. */
  lineId: string;
  productId: string;
  /** The merchant variant, or `null` for a product that has none. Never the hidden base variant (P3-AL-52). */
  variantId: string | null;
  /** A positive decimal string, exact at the product's unit precision. */
  quantity: string;
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
}

/**
 * Merge a basket into one position per stock key.
 *
 * `unitDecimalsByStockKey` is REQUIRED and must cover every stock key the
 * basket names: a caller that does not know a product's unit precision cannot
 * validate a quantity against it, and accepting the line anyway would push an
 * unrepresentable quantity to a layer that can only refuse it later.
 *
 * Positions come back in order of FIRST APPEARANCE, which is deterministic
 * from the input and does not depend on how a UUID happens to sort.
 */
export function summariseBasket(lines: readonly CartLine[], unitDecimalsByStockKey: ReadonlyMap<string, number>): readonly BasketPosition[] {
  if (lines.length === 0) {
    throw new OrderError('order.cart_empty', 'a basket must carry at least one line');
  }

  const seenLineIds = new Set<string>();
  const byKey = new Map<string, { productId: string; variantId: string | null; total: bigint; lineIds: string[] }>();

  for (const line of lines) {
    assertCanonicalId(line.lineId, 'lineId');
    if (seenLineIds.has(line.lineId)) {
      throw new OrderError('order.cart_line_duplicate', 'two basket lines share a lineId', { lineId: line.lineId });
    }
    seenLineIds.add(line.lineId);

    assertCanonicalId(line.productId, 'productId');
    if (line.variantId !== null && !isCanonicalId(line.variantId)) {
      throw new OrderError('order.cart_line_invalid', 'variantId must be a canonical lowercase UUID or null', { lineId: line.lineId });
    }

    const key = stockKeyOf(line);
    const unitDecimals = unitDecimalsByStockKey.get(key);
    if (unitDecimals === undefined) {
      throw new OrderError('order.cart_line_invalid', 'no unit precision was supplied for the line stock key', { lineId: line.lineId, stockKey: key });
    }

    let q4: bigint;
    try {
      q4 = parseQuantity(line.quantity);
    } catch {
      throw new OrderError('order.cart_quantity_invalid', 'quantity is not an exact decimal at the supported scale', { lineId: line.lineId });
    }
    if (q4 <= 0n) {
      throw new OrderError('order.cart_quantity_invalid', 'a basket line quantity is strictly positive', { lineId: line.lineId });
    }
    try {
      assertQuantityRepresentable(q4, unitDecimals);
    } catch {
      throw new OrderError('order.cart_quantity_invalid', 'quantity is not representable at the product unit precision', { lineId: line.lineId });
    }

    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { productId: line.productId, variantId: line.variantId, total: q4, lineIds: [line.lineId] });
    } else {
      existing.total += q4;
      existing.lineIds.push(line.lineId);
    }
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
    });
  }
  return Object.freeze(positions);
}
