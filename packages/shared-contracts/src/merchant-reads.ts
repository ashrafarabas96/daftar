/**
 * The merchant reads — P3-S7 (PHASE_3_S7_CONTRACT A-05 … A-09, §4.1).
 *
 * Eleven live GET routes the S7 screens (and a later Android client) call.
 * Nothing here is cached or stored: every figure is derived from the rows at
 * request time (A-03).
 *
 * - Every money value is a STRING of integer minor units and its name ends in
 *   `Minor`; every quantity is a decimal STRING at the product's
 *   `unitDecimals`. Neither is ever a JSON number.
 * - The hidden base variant never appears: a line of a simple product, or
 *   pre-variant stock of a product that later gained merchant variants,
 *   carries `variantId: null` (P3-AL-52).
 * - The stock sequence, source bindings, entry ids and posting accounts are
 *   never returned (L:1311).
 * - Lists are keyset-paged: `nextCursor` is opaque and is passed back as
 *   `cursor`. The S7 routes accept `limit` 1..50 (default 20).
 * - Refusals carry their stable domain code in `error.details`
 *   (`inventoryCode` / `purchasingCode`); a bad query is `VALIDATION_FAILED`.
 */
import type { Permission } from '@daftar/domain-core';
import type { Page } from './index';
import type { InventoryStocktakeStatusDto } from './inventory';
import type { PaymentMethodSystemTypeDto } from './payment-methods';
import type { PurchaseStatusDto } from './purchasing';

// ── Access (A-05) ─────────────────────────────────────────────────────────

/**
 * The closed list `GET /v1/inventory/access` answers from: the eleven
 * P3-AL-38 permissions, the two warehouse keys and the three accounting keys
 * the S6 settlement screens depend on.
 */
export const PHASE3_PERMISSIONS = [
  'inventory.view',
  'inventory.adjust',
  'inventory.transfer',
  'inventory.stocktake',
  'purchases.view',
  'purchases.manage',
  'purchases.receive',
  'purchases.return',
  'suppliers.view',
  'suppliers.manage',
  'suppliers.pay',
  'warehouse.view',
  'warehouse.manage',
  'accounting.view',
  'accounting.fx.manage',
  'accounting.chart.manage',
] as const satisfies readonly Permission[];

export type Phase3Permission = (typeof PHASE3_PERMISSIONS)[number];

/**
 * `GET /v1/inventory/access` — any member of the current business. It
 * discloses only the caller's own grants and is advisory: every command still
 * enforces its own authority.
 */
export interface InventoryAccessDto {
  /** True when the caller's branch scope is the whole business. */
  businessWide: boolean;
  /** The caller's effective subset of `PHASE3_PERMISSIONS`, in that list's order. */
  permissions: Phase3Permission[];
}

// ── Warehouses (A-05) ─────────────────────────────────────────────────────

/**
 * `GET /v1/inventory/warehouses` — `warehouse.view`, `inventory.view` or
 * `purchases.view`; only the warehouses the caller reaches (P3-AL-15). Archived
 * warehouses are returned with their status; pickers offer `active` ones.
 */
export interface InventoryWarehouseDto {
  warehouseId: string;
  name: string;
  status: 'active' | 'archived';
  /** The immutable home branch. */
  homeBranchId: string;
  /** Every branch the warehouse serves (`branch_warehouses`), the home branch included, ascending. */
  branchIds: string[];
}

export interface InventoryWarehousesDto {
  items: InventoryWarehouseDto[];
}

// ── Items and units (A-06) ────────────────────────────────────────────────

/**
 * `GET /v1/inventory/items` query — `inventory.view`, `purchases.view`,
 * `purchases.manage` or `inventory.adjust`.
 *
 * - `search`: 1..100 characters after trimming; a case-insensitive substring
 *   of the resolved name, or an exact SKU / barcode of the product or of a
 *   merchant variant. Never the base variant.
 * - `ids`: 1..200 canonical product ids, comma-separated. Mutually exclusive
 *   with `search`; resolves display names (archived and untracked products
 *   included), unpaged. An id that is not a product of the business is
 *   `inventory.product_not_found` (404).
 * - `trackedOnly`: `'true'` | `'false'`; defaults to `'true'`, and to
 *   `'false'` when `ids` is given.
 * - Without `ids`, archived products are not listed.
 */
export interface InventoryItemsQueryDto {
  search?: string;
  ids?: string;
  trackedOnly?: 'true' | 'false';
  cursor?: string;
  limit?: string;
}

/** A merchant variant of an item. Its name is its attribute values joined by " / ", else its SKU, else its barcode. */
export interface InventoryItemVariantDto {
  variantId: string;
  name: string;
  status: 'active' | 'archived';
}

export interface InventoryItemDto {
  productId: string;
  /** Resolved: the requested locale (`Accept-Language`), then `ar`, then any. */
  name: string;
  status: 'active' | 'archived';
  trackInventory: boolean;
  /** Null while the product has never been tracked. */
  unitCode: string | null;
  unitDecimals: number | null;
  /**
   * A non-zero on-hand, or movements that do not sum to zero, in any warehouse.
   * Null unless the caller holds `inventory.adjust` or `inventory.view`.
   */
  holdsStock: boolean | null;
  /** Merchant variants only; `[]` for a simple product. */
  variants: InventoryItemVariantDto[];
}

/** `GET /v1/inventory/units` — any member. Ordered as the unit registry orders them. */
export interface InventoryUnitDto {
  unitCode: string;
  name: string;
  defaultDecimals: number;
}

export interface InventoryUnitsDto {
  items: InventoryUnitDto[];
}

// ── Stock (A-07) ──────────────────────────────────────────────────────────

export type InventoryStockStatusFilterDto = 'in_stock' | 'out_of_stock' | 'negative';

/**
 * `GET /v1/inventory/stock` query — `inventory.view`, and `warehouseId` in
 * the caller's reach (else `inventory.warehouse_out_of_scope`, 403).
 * `negative` is stock short of zero.
 */
export interface InventoryStockQueryDto {
  warehouseId: string;
  search?: string;
  status?: InventoryStockStatusFilterDto;
  cursor?: string;
  limit?: string;
}

/**
 * One stock row of a tracked, active product in one warehouse. A key that
 * never moved reads zero. A product with merchant variants has one row per
 * merchant variant, plus a `variantId: null` row only while its pre-variant
 * stock is non-zero.
 */
export interface InventoryStockRowDto {
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitCode: string;
  unitDecimals: number;
  /** Signed decimal string at `unitDecimals`. */
  onHand: string;
}

export type InventoryStockPageDto = Page<InventoryStockRowDto>;

// ── Stocktakes (A-08) ─────────────────────────────────────────────────────

/** `GET /v1/inventory/stocktakes` query — `inventory.view` or `inventory.stocktake`, newest first. */
export interface InventoryStocktakesQueryDto {
  warehouseId?: string;
  status?: InventoryStocktakeStatusDto;
  cursor?: string;
  limit?: string;
}

export interface InventoryStocktakeSummaryDto {
  stocktakeId: string;
  warehouseId: string;
  status: InventoryStocktakeStatusDto;
  createdAt: string;
  /** When it was finalized or cancelled; null while a draft. */
  closedAt: string | null;
  lineCount: number;
}

/**
 * One counted line. While the stocktake is a draft, `expectedQty` and
 * `varianceQty` are null unless the caller holds `inventory.adjust` (blind
 * count, TL-8); once finalized they are returned to every reader.
 */
export interface InventoryStocktakeLineDto {
  lineId: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitCode: string | null;
  unitDecimals: number;
  countedQty: string;
  expectedQty: string | null;
  varianceQty: string | null;
}

/** `GET /v1/inventory/stocktakes/:stocktakeId`. */
export interface InventoryStocktakeDetailDto extends InventoryStocktakeSummaryDto {
  lines: InventoryStocktakeLineDto[];
}

// ── Suppliers (A-09) ──────────────────────────────────────────────────────

/** An amount in one currency. */
export interface CurrencyAmountDto {
  currency: string;
  amountMinor: string;
}

/**
 * `GET /v1/supplier-balances` query — `suppliers.view` and business-wide
 * scope. Newest supplier first. `owedOnly=true` keeps the suppliers with a
 * received, unreversed purchase that still has something outstanding.
 */
export interface SupplierBalancesQueryDto {
  status?: 'active' | 'inactive';
  search?: string;
  owedOnly?: 'true' | 'false';
  cursor?: string;
  limit?: string;
}

export interface SupplierBalanceRowDto {
  supplierId: string;
  name: string;
  status: 'active' | 'inactive';
  /** What the merchant still owes, per purchase currency (the same figure as `GET /v1/suppliers/:id/payable`); zeros omitted. */
  owed: CurrencyAmountDto[];
  /** The balance in the merchant's favour: the credit notes' remaining amounts per note currency; zeros omitted. */
  inYourFavour: CurrencyAmountDto[];
}

export type SupplierBalancesPageDto = Page<SupplierBalanceRowDto>;

/**
 * `GET /v1/suppliers/:supplierId/open-purchases` query — `suppliers.view` or
 * `suppliers.pay`; only purchases of reachable warehouses. `currency` and
 * `amount` (a positive integer of minor units) come together and ask for a
 * payment proposal.
 */
export interface SupplierOpenPurchasesQueryDto {
  currency?: string;
  amount?: string;
  cursor?: string;
  limit?: string;
}

/** A received, unreversed purchase with something still outstanding, oldest first. */
export interface SupplierOpenPurchaseDto {
  purchaseId: string;
  documentDate: string;
  supplierReference: string | null;
  warehouseId: string;
  currency: string;
  totalTxnMinor: string;
  outstandingTxnMinor: string;
  /**
   * The server's advisory oldest-first allocation of the asked amount to this
   * purchase; null when no proposal was asked or the purchase is in another
   * currency. The payment command re-validates every allocation.
   */
  proposedMinor: string | null;
}

export interface SupplierOpenPurchasesDto extends Page<SupplierOpenPurchaseDto> {
  /**
   * The part of the asked amount no open purchase can take (at most 50
   * allocations, and never a split that would leave less than one base unit
   * outstanding); null when no proposal was asked.
   */
  unallocatedMinor: string | null;
}

// ── Return options (A-09(c)) ──────────────────────────────────────────────

/** Why nothing can be returned: mirrors the S5 refusals. */
export type PurchaseReturnBlockDto = 'not_received' | 'reversed' | 'supplier_inactive' | 'nothing_left';

/** Why the receipt cannot be undone: mirrors the S5/S6 reversal refusals. */
export type PurchaseReversalBlockDto =
  | 'not_received'
  | 'reversed'
  | 'payment_allocated'
  | 'credit_allocated'
  | 'returned'
  | 'deficit_coverage_present'
  | 'insufficient_stock';

export interface PurchaseReturnOptionLineDto {
  lineId: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitCode: string | null;
  unitDecimals: number;
  purchasedQty: string;
  /** Σ of the line's supplier returns, derived live. */
  returnedQty: string;
  /** `max(0, min(purchasedQty − returnedQty, onHandQty))`. */
  returnableQty: string;
  /** On hand in the purchase's warehouse. */
  onHandQty: string;
}

/**
 * `GET /v1/purchases/:purchaseId/return-options` — `purchases.view` and the
 * purchase's warehouse in reach. Also says whether the receipt can be undone
 * (TL-4(b)); the reversal command stays the authority.
 */
export interface PurchaseReturnOptionsDto {
  purchaseId: string;
  status: PurchaseStatusDto;
  reversed: boolean;
  supplierActive: boolean;
  returnable: boolean;
  reason: PurchaseReturnBlockDto | null;
  reversible: boolean;
  reversalReason: PurchaseReversalBlockDto | null;
  lines: PurchaseReturnOptionLineDto[];
}

// ── Payment-method defaults (A-09(e)) ─────────────────────────────────────

/**
 * `GET /v1/payment-method-defaults` — `accounting.chart.manage`. Whether the
 * account the system uses for each method type exists and is active. No
 * account id is returned.
 */
export interface PaymentMethodDefaultDto {
  systemType: Exclude<PaymentMethodSystemTypeDto, 'other'>;
  available: boolean;
}

export interface PaymentMethodDefaultsDto {
  items: PaymentMethodDefaultDto[];
}
