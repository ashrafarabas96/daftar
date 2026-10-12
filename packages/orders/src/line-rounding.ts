/**
 * The per-line rounding law — Phase 6, and the OWNER'S DECISION of
 * 2026-10-12T20:38:50Z ("أعتمد الخيار A — التقريب لكل سطر").
 *
 * The question this answers was open for three challenge rounds: when a line's
 * exact value (quantity × unit price, less the approved discounts) falls
 * between two minor units, is each LINE rounded and the lines summed, or are
 * the exact values summed and the TOTAL rounded once? The owner chose per line,
 * with seven conditions. This module is the law; the migration patch request's
 * `I6.2` (which the decision overturned, and which now states the owner's
 * ruling and cites his message) and the tests named below are the rest of the
 * answer.
 *
 * The earlier revision of this header cited the request's `I6.5`. That was the
 * wrong cross-reference — `I6.5` is about `issued_at` having no column default
 * — and the coordinator's review of `7834bfb` named it `R-17`.
 *
 * **Condition 1 — one rounding, after the quantity and the discounts.** The
 * exact line value is `quantity × unitPrice − discount`, and it is rounded
 * ONCE, here. Rounding the product and then subtracting the discount would be
 * two roundings of one figure, so the discount is folded into the numerator
 * before the single rounding — see `roundedLineTotalMinor`.
 *
 * **Condition 2 — the document total is the sum of the ROUNDED lines.** That
 * is not enforced here but in `buildCommercialQuote`, which already refuses a
 * displayed total that is not the exact integer sum of the carried line totals
 * (`order.quote_total_mismatch`). Per-line rounding is what makes that sum the
 * printed arithmetic: with total-only rounding the printed lines would not add
 * up and a receipt would need a rounding-difference line, which is exactly
 * what the owner chose against.
 *
 * **Condition 3 — the official mode, and no new one.** HALF_EVEN, via
 * `roundHalfEven` from `@daftar/inventory` — `packages/inventory/src/rounding.ts:29`,
 * whose SQL twin is `inventory_half_even`. This module does NOT implement a
 * rounding mode: it imports the one the project already accepted, and it never
 * touches a float. Every operand below is `bigint`.
 *
 * ## What this module deliberately does not do
 *
 * It does not PRICE anything. The unit price, the discount and the line total
 * remain the pricing authority's figures, carried verbatim into the quote, and
 * the sale command still recomputes the canonical amount in its own
 * transaction. What this adds is a GATE: a carried line total that is not the
 * one the owner's rule produces is refused rather than displayed. A quote that
 * disagrees with the project's own rounding rule is a price surprise waiting
 * for the recomputation to find it, which is the thing `§27` exists to prevent.
 *
 * Nor does it carry the rule into the postings, the collected amount, or a
 * return or reversal. Those belong to the accounting and sales authorities, and
 * conditions 4 and 5 are carried to them as named requests rather than built
 * here. A phase that implemented a refund's rounding on its own would be the
 * second money truth this package exists to avoid.
 *
 * `ACC-REQ-P6-01` (condition 4: displayed = stored = collected = postings),
 * `ACC-REQ-P6-02` (condition 5: returns, reversals and allocations) and
 * `ACC-REQ-P6-03` (a document-level fee) are stated in
 * `P6-MIGRATION-PATCH-REQUEST.md` §ACC-REQ, where the Accounting Authority and
 * the Migration Owner read them, and are repeated in
 * `P6-OWNER-DECISION-LINE-ROUNDING.md` §4. Until this commit this header said
 * they were in the request and they were not — the coordinator's `R-17`. Each
 * one is fail-closed in code by ABSENCE: this package computes no posting, no
 * collected amount and no refund, and since this commit a fee sent as a FIELD
 * is refused by name as `order.quote_field_undeclared` rather than silently
 * dropped (`quote.ts`, `assertCanonicalInput`; the coordinator's `R-16`).
 */
import { roundHalfEven } from '@daftar/inventory';
import { OrderError } from './errors';

/**
 * The quantity scale `@daftar/inventory` fixes for every quantity in this
 * system (Q4, `NUMERIC(18,4)` in the frozen schema). A quantity is an exact
 * integer count of ten-thousandths, so a line's exact value in minor units is
 * `(quantityQ4 × unitPriceMinor − discountMinor × 10^4) / 10^4`, and that
 * division is the one rounding.
 */
export const QUANTITY_SCALE = 10_000n;

/**
 * The exact numerator of a line's value, in ten-thousandths of a minor unit.
 * Exported so a test can state the exact figure independently of the rounding,
 * and so a reader can see that nothing is rounded before this is complete.
 */
export function exactLineValueScaled(quantityQ4: bigint, unitPriceMinor: bigint, discountMinor: bigint): bigint {
  return quantityQ4 * unitPriceMinor - discountMinor * QUANTITY_SCALE;
}

/**
 * The owner's rule, as one function: the exact line value rounded ONCE to a
 * minor unit, HALF_EVEN.
 *
 * A negative result is refused rather than returned. A discount larger than the
 * line's gross value is not a negative line total — money in this package is a
 * non-negative integer count of minor units — it is a discount that was never
 * admissible, and returning a negative figure here would push it to whichever
 * layer first failed to check for it.
 */
export function roundedLineTotalMinor(
  quantityQ4: bigint,
  unitPriceMinor: bigint,
  discountMinor: bigint,
  detail: Readonly<Record<string, string>> = {},
): bigint {
  const scaled = exactLineValueScaled(quantityQ4, unitPriceMinor, discountMinor);
  if (scaled < 0n) {
    throw new OrderError('order.quote_discount_exceeds_line', 'a line discount is larger than the line value it discounts', {
      ...detail,
      quantityQ4: quantityQ4.toString(),
      unitPriceMinor: unitPriceMinor.toString(),
      discountMinor: discountMinor.toString(),
    });
  }
  return roundHalfEven(scaled, QUANTITY_SCALE);
}

/**
 * Refuse a carried line total that is not the one the owner's rule produces.
 *
 * The refusal carries both figures, because the useful question for whoever
 * priced the line is which direction they are out by, and by how much.
 */
export function assertLineTotalRounded(
  carriedLineTotalMinor: bigint,
  quantityQ4: bigint,
  unitPriceMinor: bigint,
  discountMinor: bigint,
  detail: Readonly<Record<string, string>> = {},
): void {
  const expected = roundedLineTotalMinor(quantityQ4, unitPriceMinor, discountMinor, detail);
  if (carriedLineTotalMinor !== expected) {
    throw new OrderError('order.quote_line_total_mismatch', 'a quote line total is not its exact value rounded once to a minor unit, half to even', {
      ...detail,
      statedLineTotalMinor: carriedLineTotalMinor.toString(),
      expectedLineTotalMinor: expected.toString(),
      exactValueScaled: exactLineValueScaled(quantityQ4, unitPriceMinor, discountMinor).toString(),
      scale: QUANTITY_SCALE.toString(),
    });
  }
}
