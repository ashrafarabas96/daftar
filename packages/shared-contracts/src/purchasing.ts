/**
 * Suppliers, purchases, receiving and landed cost — P3-S4 (PHASE_3_S4_CONTRACT A-19, A-20).
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
 * refused with `purchase.tax_policy_absent` before anything is minted.
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

export type PurchaseStatusDto = 'draft' | 'received' | 'cancelled';

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
  /** Integer strings; credit − debit over the purchase's `accounts_payable` lines. */
  outstandingBaseMinor: string;
  outstandingTxnMinor: string;
}
