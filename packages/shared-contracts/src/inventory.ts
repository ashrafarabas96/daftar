/**
 * Inventory movement commands — P3-S3 (PHASE_3_S3_CONTRACT A-21).
 *
 * Every quantity, cost and money value travels as a decimal STRING: a
 * quantity has at most four fraction digits, a unit cost at most ten, and a
 * `*Minor` value is an integer count of base-currency minor units. None of
 * them is ever a JSON number.
 *
 * A line names its stock identity as `productId` plus, only for a product
 * with merchant variants, `variantId`. The hidden base variant never appears
 * in a request or a response (P3-AL-52): a simple product's line carries
 * `variantId: null`.
 *
 * Every document id is chosen by the client as a canonical lowercase UUID. It
 * is the idempotency key: resending the same command answers the stored
 * result with `replayed: true` (HTTP 200 instead of 201); the same id with a
 * different command is refused with `inventory.idempotency_conflict` (409).
 * Refusals carry their stable code in `error.details.inventoryCode` (or, for
 * the posting, `error.details.code` under `ACCOUNTING_REFUSED`).
 */

// ── Requests ──────────────────────────────────────────────────────────────

/** A line's stock identity (A-23). */
export interface InventoryLineIdentityDto {
  productId: string;
  /** Required exactly when the product has active merchant variants (`inventory.variant_required`). */
  variantId?: string | null;
}

/** `POST /v1/inventory/transfers` — requires `inventory.transfer`. */
export interface InventoryTransferRequestDto {
  transferId: string;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  /** 1..200 lines; `quantity` > 0. */
  lines: (InventoryLineIdentityDto & { quantity: string })[];
}

/** `POST /v1/inventory/adjustments` — requires `inventory.adjust`. */
export interface InventoryAdjustmentRequestDto {
  adjustmentId: string;
  warehouseId: string;
  /** `YYYY-MM-DD`: the journal entry date. */
  occurredOn: string;
  /** 1..500 characters after trimming. */
  reason: string;
  /**
   * 1..200 lines. `quantity` is SIGNED and non-zero: positive is a gain,
   * which must state `unitCost`; negative is a loss, valued at the average.
   */
  lines: (InventoryLineIdentityDto & { quantity: string; unitCost?: string | null })[];
}

/** `POST /v1/inventory/damages` — requires `inventory.adjust`. */
export interface InventoryDamageRequestDto {
  adjustmentId: string;
  warehouseId: string;
  occurredOn: string;
  reason: string;
  /** 1..200 lines; `quantity` is the positive magnitude written off. */
  lines: (InventoryLineIdentityDto & { quantity: string })[];
}

/** `POST /v1/inventory/stocktakes` — requires `inventory.stocktake`. */
export interface InventoryStocktakeOpenRequestDto {
  stocktakeId: string;
  warehouseId: string;
}

/** `PUT /v1/inventory/stocktakes/:stocktakeId/counts` — requires `inventory.stocktake`. */
export interface InventoryStocktakeCountRequestDto {
  /** 1..200 lines; `quantity` is the counted quantity, >= 0. */
  lines: (InventoryLineIdentityDto & { quantity: string })[];
}

/** `POST /v1/inventory/stocktakes/:stocktakeId/finalize` — requires `inventory.stocktake`. */
export interface InventoryStocktakeFinalizeRequestDto {
  occurredOn: string;
  /** Only for a positive variance on a key that has never held valued stock (`inventory.unit_cost_required`). */
  unitCosts?: (InventoryLineIdentityDto & { unitCost: string })[] | null;
}

/** `POST /v1/inventory/openings` — requires `inventory.adjust`. */
export interface InventoryOpeningRequestDto {
  openingId: string;
  occurredOn: string;
  /** 1..200 lines; `(warehouseId, product/variant)` unique; `quantity` > 0; `unitCost` >= 0. */
  lines: (InventoryLineIdentityDto & { warehouseId: string; quantity: string; unitCost: string })[];
}

// ── Responses ─────────────────────────────────────────────────────────────

/** One stored stock movement of a document. */
export interface InventoryMovementLineDto {
  lineId: string;
  productId: string;
  /** The merchant variant, or null for a simple product. */
  variantId: string | null;
  warehouseId: string;
  /** Signed quantity delta, decimal string. */
  qtyDelta: string;
  /** Signed value delta in base-currency minor units, integer string. */
  valueDeltaBaseMinor: string;
}

/** The answer of a transfer, adjustment, damage, finalize or cancel — always read from stored rows. */
export interface InventoryMovementDocumentDto {
  id: string;
  /** True when this is the stored result of an earlier identical command. */
  replayed: boolean;
  /** The trace id of the operation that produced the document. */
  businessTransactionId: string;
  lines: readonly InventoryMovementLineDto[];
  /** The journal entry the document posted, or null when it posted none (a transfer, a zero net value). */
  journalEntryId: string | null;
}

/** How an opening met the ledger (A-13). */
export type InventoryOpeningCaseDto = 'ledger_posting' | 'opening_balance_bound';

/** `POST /v1/inventory/openings` */
export interface InventoryOpeningDto extends InventoryMovementDocumentDto {
  case: InventoryOpeningCaseDto;
  /** `opening_balance_bound` only: the posted opening balance the stock decomposes. */
  openingBalanceId: string | null;
  /** `opening_balance_bound` only: the matched position, integer minor-units string. */
  matchedAmountMinor: string | null;
}

export type InventoryStocktakeStatusDto = 'draft' | 'finalized' | 'cancelled';

/** `POST /v1/inventory/stocktakes` */
export interface InventoryStocktakeDto {
  id: string;
  warehouseId: string;
  status: InventoryStocktakeStatusDto;
  replayed: boolean;
  businessTransactionId: string;
}

/** One captured stocktake line. Quantities are decimal strings. */
export interface InventoryStocktakeCountLineDto {
  lineId: string;
  productId: string;
  variantId: string | null;
  expectedQtyAtCapture: string;
  /** The stock sequence the capture measured, integer string. */
  capturedAtStockSeq: string;
  countedQty: string;
  varianceQty: string;
  /** False when the same counted quantity was recorded again and the capture was left untouched. */
  changed: boolean;
}

/** `PUT /v1/inventory/stocktakes/:stocktakeId/counts` */
export interface InventoryStocktakeCountDto {
  id: string;
  businessTransactionId: string;
  lines: readonly InventoryStocktakeCountLineDto[];
}

/** `POST /v1/inventory/stocktakes/:stocktakeId/finalize` and `/cancel` */
export interface InventoryStocktakeCloseDto extends InventoryMovementDocumentDto {
  status: 'finalized' | 'cancelled';
}
