/**
 * Typed inventory errors raised by this package — stable machine codes, never
 * a key, an assertion, a secret or the canonical byte stream.
 *
 * This package only MINTS and CANONICALIZES. Every refusal here means the
 * application tried to sign something the database would refuse, so it is a
 * defect caught before a connection is taken, never a verification verdict:
 * verification is the database's, and only the database's (P3-AL-55 §G).
 *
 * - `inventory.assertion_malformed` is the database's own code for a
 *   structurally impossible `invctl/1` assertion (§G step 2). The minter uses
 *   it for the same shape errors, so one vocabulary spans both layers.
 * - `inventory.payload_invalid` is package-local: the `invpl/1` canonicalizer
 *   refuses non-canonical input BEFORE hashing (§F) rather than normalizing
 *   it. The database never sees such a payload, because the application's
 *   payload validation runs before the minter (§I).
 *
 * P3-S2 adds the fixed-point and valuation codes (PHASE_3_S2_CONTRACT §4).
 * Where the database primitive raises a code for the same condition (for
 * example `inventory.insufficient_stock`), the package uses that code, so a
 * simulation and the stored ledger refuse in one vocabulary. These refusals
 * are pure arithmetic verdicts and never carry a quantity, cost or value.
 *
 * P3-S3 adds the document and allocation codes (PHASE_3_S3_CONTRACT §3):
 * `duplicate_line`, `lines_required`, `unit_cost_required`,
 * `opening_valuation_mismatch` and `allocation_invalid`, plus
 * `reason_required` (the database's own code for a missing reason). A message
 * never carries an amount, and `opening_valuation_mismatch` carries none in
 * its details either: it is the code alone (review F4).
 *
 * P3-S4 adds the codes the purchase arithmetic and the coverage plan can
 * raise (PHASE_3_S4_CONTRACT §3), in the `purchase.*` domain where the
 * database raises the same condition under that prefix:
 * `purchase.landed_cost_denominator_zero`,
 * `purchase.landed_cost_allocation_mismatch`, `purchase.landed_cost_invalid`
 * (a landed amount that is not positive, or a manual allocation that is
 * negative or not one per line), `purchase.discount_invalid`,
 * `purchase.total_zero` and `inventory.deficit_state_invalid`.
 *
 * P3-S5 adds the three codes the supplier-return arithmetic can raise
 * (PHASE_3_S5_CONTRACT §3), in the `supplier_return.*` domain the routine
 * raises them under: `supplier_return.quantity_exceeds_purchased` (Must-prove
 * 1), `supplier_return.value_zero` (TL-12) and
 * `supplier_return.amount_below_base_unit` (TL-3).
 *
 * P3-S6 adds the codes the settlement arithmetic (`supplier-settlement.ts`)
 * and the payment-method builders can raise (PHASE_3_S6_CONTRACT §3), each in
 * the domain its routine raises it under: the over-allocation and
 * over-consumption bounds (MP-3, MP-6), the same-currency amount rule, the
 * base-unit rule (A-08, TL-9), the chain verdicts of the two verify helpers
 * (R-62, R-63) and the method name rules (A-06).
 */
export type InventoryErrorCode =
  | 'inventory.assertion_malformed'
  | 'inventory.payload_invalid'
  | 'inventory.quantity_invalid'
  | 'inventory.cost_invalid'
  | 'inventory.unit_decimals_invalid'
  | 'inventory.quantity_precision_invalid'
  | 'inventory.insufficient_stock'
  | 'inventory.arithmetic_invalid'
  | 'inventory.value_out_of_range'
  | 'inventory.quantity_out_of_range'
  | 'inventory.movement_shape_invalid'
  | 'inventory.transfer_pair_mismatch'
  | 'inventory.rebuild_sequence_invalid'
  | 'inventory.duplicate_line'
  | 'inventory.lines_required'
  | 'inventory.unit_cost_required'
  | 'inventory.opening_valuation_mismatch'
  | 'inventory.allocation_invalid'
  | 'inventory.reason_required'
  | 'inventory.deficit_state_invalid'
  | 'purchase.landed_cost_denominator_zero'
  | 'purchase.landed_cost_allocation_mismatch'
  | 'purchase.landed_cost_invalid'
  | 'purchase.discount_invalid'
  | 'purchase.total_zero'
  | 'supplier_return.quantity_exceeds_purchased'
  | 'supplier_return.value_zero'
  | 'supplier_return.amount_below_base_unit'
  | 'payment_method.name_required'
  | 'payment_method.name_invalid'
  | 'supplier_payment.allocations_invalid'
  | 'supplier_payment.amount_exceeds_outstanding'
  | 'supplier_payment.amount_mismatch'
  | 'supplier_payment.amount_below_base_unit'
  | 'supplier_payment.settlement_inconsistent'
  | 'supplier_credit_allocation.amount_exceeds_outstanding'
  | 'supplier_credit_allocation.amount_exceeds_credit'
  | 'supplier_credit_allocation.credit_exhausted'
  | 'supplier_credit_allocation.amount_mismatch'
  | 'supplier_credit_allocation.amount_below_base_unit'
  | 'supplier_refund.amount_exceeds_credit'
  | 'supplier_refund.credit_exhausted'
  | 'supplier_refund.amount_mismatch'
  | 'supplier_refund.amount_below_base_unit'
  | 'supplier_credit_note.consumption_inconsistent';

/** Typed, string-valued facts a refusal may carry beside its code (money as integer text). Never part of the message. */
export type InventoryErrorDetails = Readonly<Record<string, string | readonly string[]>>;

export class InventoryError extends Error {
  readonly code: InventoryErrorCode;
  readonly details: InventoryErrorDetails | undefined;

  constructor(code: InventoryErrorCode, message: string, details?: InventoryErrorDetails) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }

  /** The only representation that should ever be logged or returned. */
  toSafeJSON(): { code: InventoryErrorCode } {
    return { code: this.code };
  }
}
