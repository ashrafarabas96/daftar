/**
 * Phase 10 — whole-bill discount distribution. PREPARED / NOT PROMOTED.
 *
 * The live sale contract has NO order-level discount: `sales.discount_txn_minor`
 * is recomputed as the SUM of the line discounts, and a mismatch is refused
 * `sale.state_changed` (0078). A restaurant's "10% off the bill", however, is a
 * whole-bill gesture a manager makes.
 *
 * So a bill-level discount is not a new column — it is a DISTRIBUTION over the
 * existing line discounts, computed before commit, that must sum to the intended
 * amount exactly. This module is that distribution and nothing else.
 *
 * Method: largest remainder, mirroring the SQL authority's own
 * `inventory_largest_remainder` so one bill cannot be apportioned two ways.
 * Ties break on the lower line index, which makes the result deterministic and
 * explainable on a receipt.
 */

export type BillDiscountRefusalCode =
  | 'restaurant.bill_discount.exceeds_subtotal'
  | 'restaurant.bill_discount.negative'
  | 'restaurant.bill_discount.no_lines'
  | 'restaurant.bill_discount.line_gross_negative';

export class BillDiscountRefusal extends Error {
  constructor(
    readonly code: BillDiscountRefusalCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BillDiscountRefusal';
  }
}

export interface DiscountableLine {
  readonly lineId: string;
  /** Line gross in minor units: quantity x unit price, as the sale authority computes it. */
  readonly grossTxnMinor: bigint;
}

export interface LineDiscount {
  readonly lineId: string;
  readonly discountTxnMinor: bigint;
}

/**
 * Apportion `discountTxnMinor` across the lines in proportion to their gross.
 *
 * Guarantees, each one asserted by a test:
 *  - the parts sum to `discountTxnMinor` exactly;
 *  - no part exceeds its own line's gross, so `sale_items_discount_ck` holds;
 *  - a zero-gross line receives zero;
 *  - the same input always yields the same output.
 *
 * A discount larger than the subtotal is REFUSED, not clamped: a bill cannot be
 * discounted below zero, and silently clamping would charge a different amount
 * from the one the manager approved.
 */
export function distributeBillDiscount(lines: readonly DiscountableLine[], discountTxnMinor: bigint): readonly LineDiscount[] {
  if (discountTxnMinor < 0n) {
    throw new BillDiscountRefusal('restaurant.bill_discount.negative', `A bill discount is never negative: ${discountTxnMinor}`, {
      discountTxnMinor: discountTxnMinor.toString(),
    });
  }
  if (lines.length === 0) {
    throw new BillDiscountRefusal('restaurant.bill_discount.no_lines', 'A bill with no line cannot carry a discount', {});
  }
  let subtotal = 0n;
  for (const line of lines) {
    if (line.grossTxnMinor < 0n) {
      throw new BillDiscountRefusal('restaurant.bill_discount.line_gross_negative', `Line ${line.lineId} has a negative gross: ${line.grossTxnMinor}`, {
        lineId: line.lineId,
      });
    }
    subtotal += line.grossTxnMinor;
  }
  if (discountTxnMinor > subtotal) {
    throw new BillDiscountRefusal('restaurant.bill_discount.exceeds_subtotal', `A discount of ${discountTxnMinor} exceeds the bill subtotal ${subtotal}`, {
      discountTxnMinor: discountTxnMinor.toString(),
      subtotalTxnMinor: subtotal.toString(),
    });
  }
  if (discountTxnMinor === 0n) {
    return Object.freeze(lines.map((l) => Object.freeze({ lineId: l.lineId, discountTxnMinor: 0n })));
  }
  // subtotal > 0 here: discountTxnMinor > 0 and discountTxnMinor <= subtotal.
  interface Share {
    readonly lineId: string;
    readonly capMinor: bigint;
    readonly remainder: bigint;
    readonly index: number;
    amountMinor: bigint;
  }
  const shares: Share[] = [];
  let distributed = 0n;
  for (const [index, line] of lines.entries()) {
    const numerator = line.grossTxnMinor * discountTxnMinor;
    const floor = numerator / subtotal;
    shares.push({ lineId: line.lineId, capMinor: line.grossTxnMinor, remainder: numerator - floor * subtotal, index, amountMinor: floor });
    distributed += floor;
  }
  let leftover = discountTxnMinor - distributed;
  // Largest remainder first; ties go to the lower index, so the answer is
  // deterministic and a receipt can explain which line carries the extra unit.
  const byRemainder = [...shares].sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });
  for (const share of byRemainder) {
    if (leftover === 0n) break;
    if (share.amountMinor < share.capMinor) {
      share.amountMinor += 1n;
      leftover -= 1n;
    }
  }
  if (leftover !== 0n) {
    // Unreachable while discountTxnMinor <= subtotal; stated as a loud failure
    // rather than a silent shortfall, because a shortfall here is lost money.
    throw new BillDiscountRefusal(
      'restaurant.bill_discount.exceeds_subtotal',
      `Could not place ${leftover} minor unit(s) of the discount within the lines' gross`,
      { leftoverMinor: leftover.toString() },
    );
  }
  return Object.freeze(shares.map((share) => Object.freeze({ lineId: share.lineId, discountTxnMinor: share.amountMinor })));
}
