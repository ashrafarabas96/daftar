/**
 * Suppliers, purchases, receiving and landed cost — P3-S4 (PHASE_3_S4_CONTRACT
 * A-19, A-20); supplier returns, supplier credit notes and the purchase
 * reversal — P3-S5 (PHASE_3_S5_CONTRACT A-19).
 *
 * The conventions of the P3-S3 inventory contracts hold unchanged:
 *
 * - every quantity, price, rate and money value travels as a decimal STRING,
 *   never a JSON number. A `*Minor` value is an integer count of minor units:
 *   `…TxnMinor` in the purchase currency, `…BaseMinor` in the business's base
 *   currency. A request states money in MAJOR units of the purchase currency
 *   (`"12.50"`); it must be exact at that currency's minor units, else
 *   `purchase.amount_precision_invalid`;
 * - a revision is a small integer counter and travels as a JSON number;
 * - every document id (supplier, purchase, line, landed cost) is chosen by the
 *   client as a canonical LOWERCASE uuid. The supplier and purchase ids are the
 *   idempotency keys: resending the same command answers the stored result
 *   with `replayed: true`;
 * - a line names its stock identity as `productId` plus, only for a product
 *   with merchant variants, `variantId`. The hidden base variant never appears
 *   in a request or a response (P3-AL-52): a simple product's line carries
 *   `variantId: null`;
 * - refusals carry their stable `purchase.*` / `supplier.*` / `inventory.*`
 *   code in `error.details`, and never an amount.
 *
 * Tax is BLOCKED BY OD-03 (A-12): `taxAmount` exists only so that the day a
 * tax policy is decided it is already a signed input. Any non-zero value is
 * refused with `purchase.tax_policy_absent` before anything is minted. No S5
 * request has a tax field at all (S5 A-14).
 */

// ── Suppliers: requests ──────────────────────────────────────────────────

/**
 * The editable supplier fields (A-11). Text is trimmed; `name` is 1..200
 * characters, `phone` 1..40, `email` 3..254 and address-shaped,
 * `taxIdentifier` 1..64, `notes` 1..1000. An omitted or null optional field is
 * stored as NULL: an update states the whole supplier, it never merges.
 */
export interface SupplierFieldsDto {
  name: string;
  phone?: string | null;
  email?: string | null;
  taxIdentifier?: string | null;
  notes?: string | null;
}

/** `POST /v1/suppliers` — requires `suppliers.manage`. 201 on create, 200 on replay. */
export interface SupplierCreateRequestDto extends SupplierFieldsDto {
  supplierId: string;
}

/** `PUT /v1/suppliers/:supplierId` — requires `suppliers.manage`. */
export interface SupplierUpdateRequestDto extends SupplierFieldsDto {
  /** The revision the client read (>= 1); a moved revision is `supplier.revision_changed` (409). */
  expectedRevision: number;
}

/** `POST /v1/suppliers/:supplierId/archive` and `/reactivate` — require `suppliers.manage`. */
export interface SupplierLifecycleRequestDto {
  expectedRevision: number;
}

// ── Suppliers: responses ─────────────────────────────────────────────────

export type SupplierStatusDto = 'active' | 'inactive';

/** A supplier as stored. The live row: documents keep their own snapshot (A-11). */
export interface SupplierDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  taxIdentifier: string | null;
  notes: string | null;
  status: SupplierStatusDto;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** The answer of every supplier command — always read from the stored row. */
export interface SupplierCommandResultDto extends SupplierDto {
  /** True when this is the stored result of an earlier identical command. */
  replayed: boolean;
  /** The trace id of the operation that last changed the supplier. */
  businessTransactionId: string;
}

/**
 * `GET /v1/suppliers/:supplierId/payable` — requires `suppliers.view` AND
 * business-wide branch scope (TL-4). Derived on read from the ledger's
 * `accounts_payable` lines; there is no stored balance (A-20).
 */
export interface SupplierPayableDto {
  supplierId: string;
  /** Outstanding AP in base-currency minor units, integer string (credit − debit). */
  baseMinor: string;
  /** The same outstanding amount per purchase currency, in that currency's minor units. */
  byCurrency: { currency: string; txnMinor: string }[];
}

// ── Purchases: requests ──────────────────────────────────────────────────

/** One purchase line (A-19, A-23). One line per variant (`purchase.duplicate_variant`). */
export interface PurchaseLineRequestDto {
  /** Client-chosen; a line keeps its id across draft replaces. */
  lineId: string;
  productId: string;
  /** Required exactly when the product has active merchant variants (`inventory.variant_required`). */
  variantId?: string | null;
  /** > 0, at most 4 fraction digits. */
  quantity: string;
  /** >= 0, major units of the purchase currency, at most 10 fraction digits. */
  unitPrice: string;
  /** >= 0 and at most the line gross, major units exact at the currency's minor units. Default `"0"`. */
  discount?: string | null;
}

/** A manual landed-cost allocation to one line of the same request. */
export interface PurchaseLandedCostAllocationRequestDto {
  lineId: string;
  /** >= 0, major units exact at the currency's minor units. */
  amount: string;
}

/**
 * A landed cost of the purchase (A-13 step 3). `by_value` spreads `amount`
 * over the lines by their net value and takes no allocations; `manual` names
 * every line's share, and the shares must add up to `amount` exactly
 * (`purchase.landed_cost_allocation_mismatch`). There is no tax or duty kind
 * (BLOCKED BY OD-03).
 */
export type PurchaseLandedCostRequestDto =
  | { landedCostId: string; mode: 'by_value'; amount: string; description?: string | null }
  | { landedCostId: string; mode: 'manual'; amount: string; description?: string | null; allocations: PurchaseLandedCostAllocationRequestDto[] };

/**
 * `PUT /v1/purchases/:purchaseId` — requires `purchases.manage`. Creates the
 * draft (`expectedRevision: 0`, 201) or replaces all of it (200). A draft
 * moves no stock and posts nothing.
 */
export interface PurchaseDraftRequestDto {
  /** 0 creates; otherwise the draft revision the client read (`purchase.draft_changed`, 409). */
  expectedRevision: number;
  supplierId: string;
  warehouseId: string;
  /** ISO 4217, upper case, registered (`purchase.currency_unknown`). */
  currency: string;
  /** `YYYY-MM-DD`: the journal entry date and the FX snapshot date. */
  documentDate: string;
  /** 1..200 characters after trimming. */
  supplierReference?: string | null;
  /** 1..1000 characters after trimming. */
  notes?: string | null;
  /** BLOCKED BY OD-03: only zero is accepted (`purchase.tax_policy_absent`, 422). Default `"0"`. */
  taxAmount?: string;
  /** 1..200 lines. */
  lines: PurchaseLineRequestDto[];
  /** 0..10 landed costs. */
  landedCosts?: PurchaseLandedCostRequestDto[];
}

/** `POST /v1/purchases/:purchaseId/receive` (`purchases.receive`) and `/cancel` (`purchases.manage`). */
export interface PurchaseTransitionRequestDto {
  /** The draft revision the client read; a moved draft is `purchase.draft_changed` (409). */
  draftRevision: number;
}

// ── Purchases: responses ─────────────────────────────────────────────────

/**
 * `reversed` is DERIVED (PHASE_3_S5_CONTRACT A-04, TL-2): the stored status of
 * a reversed purchase stays `received`, and a purchase reads as `reversed`
 * exactly when its purchase reversal exists.
 */
export type PurchaseStatusDto = 'draft' | 'received' | 'cancelled' | 'reversed';

/** The FX snapshot a receipt took (A-17). Domestic purchases carry `source: 'base'`, rate `"1"` and no rate id. */
export interface PurchaseRateDto {
  rateId: string | null;
  /** Units of base currency per unit of the purchase currency, decimal string (at most 10 fraction digits). */
  rate: string;
  source: 'base' | 'manual';
  /** The rate instant, ISO-8601. */
  at: string;
}

/** The supplier as it was at receipt (A-11); immutable thereafter. */
export interface PurchaseSupplierSnapshotDto {
  name: string;
  taxIdentifier: string | null;
  phone: string | null;
}

export interface PurchaseLineDto {
  lineId: string;
  lineNo: number;
  productId: string;
  /** The merchant variant, or null for a simple product. */
  variantId: string | null;
  qty: string;
  /** Major units of the purchase currency, decimal string. */
  unitPrice: string;
  grossTxnMinor: string;
  discountTxnMinor: string;
  netTxnMinor: string;
  landedCostTxnMinor: string;
  /** Received purchases only: the line's share of the base total. */
  baseShareMinor: string | null;
  /** Received purchases only: the base unit cost snapshot, decimal string (10 fraction digits). */
  unitCostBaseMinor: string | null;
}

export interface PurchaseLandedCostDto {
  landedCostId: string;
  costNo: number;
  mode: 'by_value' | 'manual';
  amountTxnMinor: string;
  description: string | null;
  /** One allocation per line, in line order, whatever the mode. */
  allocations: { lineId: string; amountTxnMinor: string }[];
}

/** A purchase as it appears in a list. */
export interface PurchaseSummaryDto {
  id: string;
  supplierId: string;
  warehouseId: string;
  currency: string;
  documentDate: string;
  supplierReference: string | null;
  status: PurchaseStatusDto;
  revision: number;
  totalTxnMinor: string;
  /** Received purchases only. */
  totalBaseMinor: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /v1/purchases/:purchaseId`, and the document part of the draft and cancel answers. */
export interface PurchaseDto extends PurchaseSummaryDto {
  notes: string | null;
  subtotalTxnMinor: string;
  landedCostTxnMinor: string;
  /** Always `"0"` (OD-03). */
  taxMinor: string;
  /** Received purchases only. */
  rate: PurchaseRateDto | null;
  /** Received purchases only. */
  supplierSnapshot: PurchaseSupplierSnapshotDto | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  lines: PurchaseLineDto[];
  landedCosts: PurchaseLandedCostDto[];
}

/** The answer of `PUT /v1/purchases/:purchaseId` and `POST …/cancel` — always read from stored rows. */
export interface PurchaseCommandResultDto extends PurchaseDto {
  replayed: boolean;
  businessTransactionId: string;
}

/** One stored coverage of a negative-inventory deficit by the receipt (A-16). */
export interface PurchaseDeficitCoverageDto {
  coverageId: string;
  deficitId: string;
  qtyCovered: string;
  /** The provisional unit cost the deficit carried, decimal string. */
  provisional: string;
  /** The actual unit cost the receipt brought, decimal string. */
  actual: string;
  /** The catch-up movement's value, or null when the catch-up was zero and no movement was written (TL-5). */
  valueDeltaBaseMinor: string | null;
}

/** `POST /v1/purchases/:purchaseId/receive` (A-19). */
export interface PurchaseReceiptDto {
  purchaseId: string;
  replayed: boolean;
  businessTransactionId: string;
  currency: string;
  totalTxnMinor: string;
  totalBaseMinor: string;
  rate: PurchaseRateDto;
  lines: {
    lineId: string;
    productId: string;
    variantId: string | null;
    qty: string;
    baseShareMinor: string;
    unitCostBaseMinor: string;
    movementId: string;
  }[];
  /** Null when the receipt covered no deficit. */
  coverage: null | {
    adjustmentId: string;
    /** Signed Σ of the stored catch-up values; the catch-up entry posts only when it is non-zero. */
    totalValueBaseMinor: string;
    coverages: PurchaseDeficitCoverageDto[];
  };
  purchaseEntryId: string;
  catchUpEntryId: string | null;
}

/**
 * `GET /v1/purchases/:purchaseId/payable` — requires `purchases.view` and the
 * purchase's warehouse in scope. Derived on read from the ledger (A-20).
 */
export interface PurchasePayableDto {
  purchaseId: string;
  currency: string;
  /**
   * Integer strings; credit − debit over the purchase's `accounts_payable`
   * lines. The txn amount is net of a residue write-off (0072), whose
   * sub-unit txn residue no journal line can carry.
   */
  outstandingBaseMinor: string;
  outstandingTxnMinor: string;
}

// ── Supplier returns and purchase reversal: requests (P3-S5) ─────────────
//
// PHASE_3_S5_CONTRACT A-19. The P3-S4 conventions above hold unchanged. No S5
// request carries tax: every S5 document descends from a purchase with no tax,
// and a tax element is BLOCKED BY OD-03 (A-14), so a tax field is refused as
// an unknown key. No request carries an amount either: every stored amount is
// computed by the server from the purchase and the stock (A-07, A-10).

/** One line of a supplier return: how much of one purchase line leaves (A-12). */
export interface SupplierReturnLineRequestDto {
  /** Client-chosen canonical lowercase uuid: the return line's id. */
  lineId: string;
  /** The purchase line returned from; at most one return line per purchase line (`supplier_return.lines_invalid`). */
  purchaseLineId: string;
  /**
   * > 0, at most 4 fraction digits. With earlier returns it never exceeds the
   * purchased quantity (`supplier_return.quantity_exceeds_purchased`, 422), and
   * never the stock of the return warehouse (`inventory.insufficient_stock`, 409).
   */
  quantity: string;
}

/**
 * `POST /v1/purchases/:purchaseId/returns` — requires `purchases.return` and
 * the scope of `warehouseId`, the warehouse the goods leave (TL-5). 201 on
 * create, 200 on replay. Insert-only: a return is never edited, cancelled or
 * deleted (A-04).
 */
export interface SupplierReturnRequestDto {
  /** Client-chosen canonical lowercase uuid: the idempotency key. */
  returnId: string;
  /** The warehouse the goods leave; it may differ from the purchase's (A-13). One warehouse per return (TL-6). */
  warehouseId: string;
  /** `YYYY-MM-DD`: the journal entry date. Not before the purchase date, not in the future. */
  documentDate: string;
  /** 1..500 characters after trimming. Optional. */
  reason?: string | null;
  /** 1..200 lines. */
  lines: SupplierReturnLineRequestDto[];
}

/**
 * `POST /v1/purchases/:purchaseId/reversal` — requires `purchases.receive` and
 * the purchase warehouse's scope (TL-4). Refused unless all four
 * preconditions hold, each with its own `purchase_reversal.*` code (A-09).
 */
export interface PurchaseReversalRequestDto {
  /** `YYYY-MM-DD`: the reversal entry date. Not before the purchase date, not in the future. */
  reversalDate: string;
  /** REQUIRED, 1..500 characters after trimming (`purchase_reversal.reason_required`, 422). */
  reason: string;
}

// ── Supplier returns and purchase reversal: responses (P3-S5) ────────────

/**
 * A supplier credit note (A-11): the part of a return's value the purchase's
 * outstanding AP could not absorb. Written only inside its return and
 * insert-only in S5. There is no stored status: a note is settled exactly
 * when its remaining amount is `"0"`. Amounts are integer minor-unit strings.
 *
 * `GET /v1/suppliers/:supplierId/credit-notes` lists them; it requires
 * `suppliers.view` AND business-wide branch scope (the S4 TL-4 precedent).
 */
export interface SupplierCreditNoteDto {
  creditNoteId: string;
  supplierId: string;
  returnId: string;
  purchaseId: string;
  /** The purchase currency. */
  currency: string;
  originalTxnMinor: string;
  remainingTxnMinor: string;
  originalCarryingBaseMinor: string;
  remainingCarryingBaseMinor: string;
  /** The purchase's FX snapshot (A-11(c)). */
  rate: PurchaseRateDto;
  /** `YYYY-MM-DD`: the return's document date. */
  issuedOn: string;
  createdAt: string;
}

/** One stored line of a supplier return. */
export interface SupplierReturnLineDto {
  lineId: string;
  lineNo: number;
  purchaseLineId: string;
  productId: string;
  /** The merchant variant, or null for a simple product. */
  variantId: string | null;
  qty: string;
  /** The line's frozen share of the purchase line's carrying value, in the purchase currency (A-10(a)). */
  carryingTxnMinor: string;
  /** The stock value that left, at the return warehouse's average, in base minor units (A-10(e)). */
  valueOutBaseMinor: string;
  /** The movement that took the goods out. */
  movementId: string;
}

/**
 * A supplier return as stored (A-10): `GET /v1/supplier-returns/:returnId` and
 * each item of `GET /v1/purchases/:purchaseId/returns`, both requiring
 * `purchases.view` and the return (or purchase) warehouse in scope.
 * `carryingTxnMinor` splits into AP first and any excess credit;
 * `purchasePriceVarianceBaseMinor` is signed (positive: a credit to purchase
 * price variance).
 */
export interface SupplierReturnDto {
  returnId: string;
  purchaseId: string;
  supplierId: string;
  warehouseId: string;
  documentDate: string;
  reason: string | null;
  /** The purchase currency. */
  currency: string;
  carryingTxnMinor: string;
  apTxnMinor: string;
  apBaseMinor: string;
  creditTxnMinor: string;
  creditBaseMinor: string;
  inventoryValueBaseMinor: string;
  purchasePriceVarianceBaseMinor: string;
  lines: SupplierReturnLineDto[];
  /** Null unless the return's value exceeded the purchase's outstanding AP. */
  creditNote: SupplierCreditNoteDto | null;
  /** The `supplier_return` journal entry. */
  entryId: string;
  createdAt: string;
}

/** The answer of `POST /v1/purchases/:purchaseId/returns` — always read from stored rows. */
export interface SupplierReturnResultDto extends SupplierReturnDto {
  /** True when this is the stored result of an earlier identical command. */
  replayed: boolean;
  businessTransactionId: string;
}

/** One line of a purchase reversal: the exact negation of that purchase line's receipt (A-09). */
export interface PurchaseReversalLineDto {
  /** The purchase line's id: a reversal line's identity is its purchase line. */
  lineId: string;
  productId: string;
  variantId: string | null;
  qty: string;
  /** The stored value of the line's receipt movement, removed exactly, in base minor units. */
  valueBaseMinor: string;
  /** The `purchase_reversal` movement. */
  movementId: string;
}

/**
 * The answer of `POST /v1/purchases/:purchaseId/reversal` — always read from
 * stored rows. The purchase then reads as `status: 'reversed'`.
 */
export interface PurchaseReversalResultDto {
  purchaseId: string;
  warehouseId: string;
  reversalDate: string;
  reason: string;
  /** Σ of the lines' values: the base total the receipt added. */
  totalValueBaseMinor: string;
  lines: PurchaseReversalLineDto[];
  /** The purchase's journal entry, which this reversal mirrors. */
  originalEntryId: string;
  /** The Phase 2 `reversal` journal entry. */
  reversalEntryId: string;
  createdAt: string;
  replayed: boolean;
  businessTransactionId: string;
}

/**
 * `POST /v1/purchases/:purchaseId/residue-write-off` (Phase 3 corrective,
 * TD-16, migration 0072): the request. `residueAmountMinor` is the purchase's
 * outstanding amount in its own currency, as integer minor units text — the
 * client states exactly what it saw (`purchase_residue.amount_mismatch`
 * otherwise). The reason is required.
 */
export interface PurchaseResidueWriteOffRequestDto {
  /** `YYYY-MM-DD`: on or after the purchase, not after today in the business timezone. */
  writeOffDate: string;
  residueAmountMinor: string;
  reason: string;
}

/**
 * The stored residue write-off (0072 R-96): the purchase's sub-unit AP
 * residue (0 < O whose conversion is 0 base minor units) closed. The
 * purchase is its identity; `journalEntryId` is the `purchase_residue_write_off`
 * entry (Dr Accounts Payable / Cr FX gain, base only) when the ledger still
 * carried a base unit for it, null otherwise.
 */
export interface PurchaseResidueWriteOffResultDto {
  purchaseId: string;
  supplierId: string;
  currency: string;
  writeOffDate: string;
  reason: string;
  /** The residue written off, in the purchase currency's minor units. */
  residueTxnMinor: string;
  /** The purchase's AP released before the write-off (`T − residue`). */
  releasedBeforeTxnMinor: string;
  /** The base the write-off released from Accounts Payable: 0 or 1. */
  residueBaseMinor: string;
  journalEntryId: string | null;
  createdAt: string;
  replayed: boolean;
  businessTransactionId: string;
}
