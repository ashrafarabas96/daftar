'use client';
/**
 * Typed Phase 3 client (P3-S7 contract A-12(3), §4.3) — the stock, purchasing
 * and supplier screens call these functions and never build a URL by hand.
 *
 * It is a SEPARATE file from `merchant-api.ts` on purpose: P1-GOLD-38's
 * mechanical sync reads `merchant-api.ts` only, and this file has its own
 * audit, the Android-callability audit (A-10, T-14:
 * `tests/integration/web-s7-client-contract.test.ts`), which pins every
 * `export const` below to an audited route, permission, scope and retry kind.
 *
 * LAW (as in `merchant-api.ts`):
 *   - one path convention: `${BFF}/<resource>`, NO `/v1` (the proxy adds it);
 *   - every list is `{ items }` (`ListDto` / `Page`), never a bare array;
 *   - money is an integer minor-unit STRING and a quantity a decimal STRING,
 *     end to end; this file does no arithmetic (A-17);
 *   - every GET is `cache: 'no-store'`: the reads are live (A-03, T-02);
 *   - a command's retry is made safe by the id the FORM minted once
 *     (`useFormDocumentId`, A-12(4)), by a revision, or — for the one
 *     header-keyed command here, the exchange-rate entry — by the caller's
 *     own `Idempotency-Key` (A-14);
 *   - nothing here carries a purchase-tax element (BLOCKED BY OD-03, A-19).
 */
import type {
  AccountingAccountListDto,
  AccountingFxRateCreateDto,
  AccountingFxRateRefDto,
  InventoryAdjustmentRequestDto,
  InventoryDamageRequestDto,
  InventoryMovementDocumentDto,
  InventoryOpeningDto,
  InventoryOpeningRequestDto,
  InventoryStocktakeCloseDto,
  InventoryStocktakeCountDto,
  InventoryStocktakeCountRequestDto,
  InventoryStocktakeDto,
  InventoryStocktakeFinalizeRequestDto,
  InventoryStocktakeOpenRequestDto,
  InventoryTransferRequestDto,
  ListDto,
  Page,
  PaymentMethodCommandResultDto,
  PaymentMethodCreateRequestDto,
  PaymentMethodDto,
  PurchaseCommandResultDto,
  PurchaseDraftRequestDto,
  PurchaseDto,
  PurchasePayableDto,
  PurchaseReceiptDto,
  PurchaseReversalRequestDto,
  PurchaseReversalResultDto,
  PurchaseSettlementsDto,
  PurchaseStatusDto,
  PurchaseSummaryDto,
  PurchaseTransitionRequestDto,
  ReceiveAndPayRequestDto,
  ReceiveAndPayResultDto,
  SupplierCommandResultDto,
  SupplierCreateRequestDto,
  SupplierCreditAllocationRequestDto,
  SupplierCreditAllocationResultDto,
  SupplierCreditNoteDto,
  SupplierDto,
  SupplierPayableDto,
  SupplierPaymentDto,
  SupplierPaymentRequestDto,
  SupplierPaymentResultDto,
  SupplierRefundRequestDto,
  SupplierRefundResultDto,
  SupplierReturnDto,
  SupplierReturnRequestDto,
  SupplierReturnResultDto,
  SupplierStatusDto,
} from '@daftar/shared-contracts';
import { apiFetch } from './client';

const BFF = '/api/proxy';

// ═════════════════════════════════════════════════════════════════════════
// SWITCH POINT — the P3-S7 read DTOs (contract §4.1, A-05 … A-09).
//
// Agent R owns `packages/shared-contracts/src/merchant-reads.ts`, which
// exports these types. Until it lands, they are declared here from the
// contract's shapes. When it lands, this whole block is replaced by ONE
// `import type { … } from '@daftar/shared-contracts'` plus the matching
// `export type { … }` line, and nothing else in the web changes: every screen
// imports these names from THIS file, never from the contract package.
// ═════════════════════════════════════════════════════════════════════════

/** The closed list `GET /v1/inventory/access` answers from (A-05). */
export type Phase3Permission =
  | 'inventory.view'
  | 'inventory.adjust'
  | 'inventory.transfer'
  | 'inventory.stocktake'
  | 'purchases.view'
  | 'purchases.manage'
  | 'purchases.receive'
  | 'purchases.return'
  | 'suppliers.view'
  | 'suppliers.manage'
  | 'suppliers.pay'
  | 'warehouse.view'
  | 'warehouse.manage'
  | 'accounting.view'
  | 'accounting.fx.manage'
  | 'accounting.chart.manage';

/** `GET /v1/inventory/access` — the caller's own grants; advisory only (A-05). */
export interface InventoryAccessDto {
  businessWide: boolean;
  permissions: Phase3Permission[];
}

/** `GET /v1/inventory/warehouses` — the warehouses the caller can reach (A-05). */
export interface InventoryWarehouseDto {
  warehouseId: string;
  name: string;
  status: 'active' | 'archived';
  homeBranchId: string;
  branchIds: string[];
}

/** One merchant variant of an item. The base variant is never listed (P3-AL-52). */
export interface InventoryItemVariantDto {
  variantId: string;
  name: string;
  status: 'active' | 'archived';
}

/** `GET /v1/inventory/items` (A-06). */
export interface InventoryItemDto {
  productId: string;
  name: string;
  status: 'active' | 'archived';
  trackInventory: boolean;
  unitCode: string | null;
  unitDecimals: number | null;
  holdsStock: boolean;
  variants: InventoryItemVariantDto[];
}

/** `GET /v1/inventory/units` (A-06). */
export interface InventoryUnitDto {
  unitCode: string;
  name: string;
  defaultDecimals: number;
}

/** `GET /v1/inventory/stock` row (A-07). No cost, no stock sequence. */
export interface InventoryStockRowDto {
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitCode: string;
  unitDecimals: number;
  onHand: string;
}

/** `GET /v1/inventory/stocktakes` item (A-08). */
export interface InventoryStocktakeSummaryDto {
  stocktakeId: string;
  warehouseId: string;
  status: 'draft' | 'finalized' | 'cancelled';
  createdAt: string;
  closedAt: string | null;
  lineCount: number;
}

/** One line of `GET /v1/inventory/stocktakes/:stocktakeId` (A-08). Expected and variance are null in a blind draft. */
export interface InventoryStocktakeDetailLineDto {
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

/** `GET /v1/inventory/stocktakes/:stocktakeId` (A-08). */
export interface InventoryStocktakeDetailDto extends InventoryStocktakeSummaryDto {
  lines: InventoryStocktakeDetailLineDto[];
}

/** A per-currency amount, integer minor units. */
export interface CurrencyAmountDto {
  currency: string;
  amountMinor: string;
}

/** `GET /v1/supplier-balances` row (A-09(a)). */
export interface SupplierBalanceRowDto {
  supplierId: string;
  name: string;
  status: SupplierStatusDto;
  owed: CurrencyAmountDto[];
  inYourFavour: CurrencyAmountDto[];
}

/** One open purchase of `GET /v1/suppliers/:supplierId/open-purchases` (A-09(b)). */
export interface SupplierOpenPurchaseDto {
  purchaseId: string;
  documentDate: string;
  supplierReference: string | null;
  warehouseId: string;
  currency: string;
  totalTxnMinor: string;
  outstandingTxnMinor: string;
  /** The advisory allocation of the asked amount; null when no proposal was asked or the purchase is in another currency. */
  proposedMinor: string | null;
}

/** `GET /v1/suppliers/:supplierId/open-purchases` (A-09(b)). */
export interface SupplierOpenPurchasesDto extends Page<SupplierOpenPurchaseDto> {
  /** The part of the asked amount no open purchase can take (R-77, 50 allocations); null when no proposal was asked. */
  unallocatedMinor: string | null;
}

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

/** One line of `GET /v1/purchases/:purchaseId/return-options` (A-09(c)). */
export interface PurchaseReturnOptionLineDto {
  lineId: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitCode: string | null;
  unitDecimals: number;
  purchasedQty: string;
  returnedQty: string;
  returnableQty: string;
  onHandQty: string;
}

/** `GET /v1/purchases/:purchaseId/return-options` (A-09(c); "Undo receipt" visibility, Annex R #21). */
export interface PurchaseReturnOptionsDto {
  purchaseId: string;
  status: PurchaseStatusDto;
  reversed: boolean;
  supplierActive: boolean;
  returnable: boolean;
  reason: PurchaseReturnBlockDto | null;
  /** Whether "Undo receipt" would be accepted now, from `purchase_settlement_state()` (Annex R #21). */
  reversible: boolean;
  reversalReason: PurchaseReversalBlockDto | null;
  lines: PurchaseReturnOptionLineDto[];
}

/** `GET /v1/payment-method-defaults` item (A-09(e)). No account id travels. */
export interface PaymentMethodDefaultDto {
  systemType: 'cash' | 'card' | 'bank_transfer' | 'wallet' | 'cheque';
  available: boolean;
}

/** `GET /v1/inventory/items` query (A-06). `search` and `ids` are mutually exclusive. */
export interface InventoryItemsQuery {
  search?: string;
  ids?: readonly string[];
  trackedOnly?: boolean;
  cursor?: string;
  limit?: number;
}

/** `GET /v1/inventory/stock` query (A-07). */
export interface InventoryStockQuery {
  warehouseId: string;
  search?: string;
  status?: 'in_stock' | 'out_of_stock' | 'negative';
  cursor?: string;
  limit?: number;
}

/** `GET /v1/inventory/stocktakes` query (A-08). */
export interface InventoryStocktakesQuery {
  warehouseId?: string;
  status?: 'draft' | 'finalized' | 'cancelled';
  cursor?: string;
  limit?: number;
}

/** `GET /v1/supplier-balances` query (A-09(a)). */
export interface SupplierBalancesQuery {
  status?: SupplierStatusDto;
  search?: string;
  owedOnly?: boolean;
  cursor?: string;
  limit?: number;
}

/** `GET /v1/suppliers/:supplierId/open-purchases` query (A-09(b)). `amount` is an integer minor-unit string. */
export interface SupplierOpenPurchasesQuery {
  currency?: string;
  amount?: string;
  cursor?: string;
  limit?: number;
}

// ═════════════════════════════════════════════════════════════════════════
// END OF SWITCH POINT
// ═════════════════════════════════════════════════════════════════════════

/** `POST`/`DELETE …/warehouses/:warehouseId/branches` answer (`state` retry kind: `changed: false` on a repeat). */
export interface WarehouseBranchAssociationDto {
  warehouseId: string;
  branchId: string;
  associated: boolean;
  changed: boolean;
}

/** `PUT /v1/inventory/products/:productId/configuration` body. */
export interface InventoryConfigurationRequestDto {
  trackInventory: boolean;
  unitCode?: string;
  unitDecimals?: number;
}

/** `PUT /v1/inventory/products/:productId/configuration` answer (`state` retry kind). */
export interface InventoryConfigurationResultDto {
  productId: string;
  trackInventory: boolean;
  unitCode: string | null;
  unitDecimals: number | null;
  changed: boolean;
}

/** List queries of the S4–S6 reads. */
export interface PurchasesQuery {
  status?: 'draft' | 'received' | 'cancelled';
  supplierId?: string;
  warehouseId?: string;
  cursor?: string;
  limit?: number;
}
export interface SuppliersQuery {
  status?: SupplierStatusDto;
  search?: string;
  cursor?: string;
  limit?: number;
}
export interface PageQuery {
  cursor?: string;
  limit?: number;
}

type QueryValue = string | number | boolean | readonly string[] | undefined;

/** `?a=1&b=2`, or '' — absent values are omitted, a list is comma-joined. */
function qs(params: Readonly<Record<string, QueryValue>>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    q.set(key, typeof value === 'object' ? value.join(',') : String(value));
  }
  const text = q.toString();
  return text.length > 0 ? `?${text}` : '';
}

const seg = (id: string): string => encodeURIComponent(id);

/** Every read: live, never cached by the browser (A-03(5)). */
function read<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { cache: 'no-store' });
}

/** Every command. `idempotencyKey` is set only by a caller that owns one (A-14); otherwise the client mints one per call. */
function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  return apiFetch<T>(path, {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
  });
}

// ── P3-S7 reads (A-05 … A-09) ────────────────────────────────────────────
export const getInventoryAccess = () => read<InventoryAccessDto>(`${BFF}/inventory/access`);
export const listInventoryWarehouses = () => read<ListDto<InventoryWarehouseDto>>(`${BFF}/inventory/warehouses`);
export const listInventoryItems = (q: InventoryItemsQuery = {}) => read<Page<InventoryItemDto>>(`${BFF}/inventory/items${qs({ ...q })}`);
export const listInventoryUnits = () => read<ListDto<InventoryUnitDto>>(`${BFF}/inventory/units`);
export const listStock = (q: InventoryStockQuery) => read<Page<InventoryStockRowDto>>(`${BFF}/inventory/stock${qs({ ...q })}`);
export const listStocktakes = (q: InventoryStocktakesQuery = {}) => read<Page<InventoryStocktakeSummaryDto>>(`${BFF}/inventory/stocktakes${qs({ ...q })}`);
export const getStocktake = (stocktakeId: string) => read<InventoryStocktakeDetailDto>(`${BFF}/inventory/stocktakes/${seg(stocktakeId)}`);
export const listSupplierBalances = (q: SupplierBalancesQuery = {}) => read<Page<SupplierBalanceRowDto>>(`${BFF}/supplier-balances${qs({ ...q })}`);
export const listOpenPurchases = (supplierId: string, q: SupplierOpenPurchasesQuery = {}) =>
  read<SupplierOpenPurchasesDto>(`${BFF}/suppliers/${seg(supplierId)}/open-purchases${qs({ ...q })}`);
export const getReturnOptions = (purchaseId: string) => read<PurchaseReturnOptionsDto>(`${BFF}/purchases/${seg(purchaseId)}/return-options`);
export const listPaymentMethodDefaults = () => read<ListDto<PaymentMethodDefaultDto>>(`${BFF}/payment-method-defaults`);

// ── Stock commands (P3-S3; document-id retry kind) ───────────────────────
export const postTransfer = (body: InventoryTransferRequestDto) => send<InventoryMovementDocumentDto>('POST', `${BFF}/inventory/transfers`, body);
export const postAdjustment = (body: InventoryAdjustmentRequestDto) => send<InventoryMovementDocumentDto>('POST', `${BFF}/inventory/adjustments`, body);
export const postDamage = (body: InventoryDamageRequestDto) => send<InventoryMovementDocumentDto>('POST', `${BFF}/inventory/damages`, body);
export const postOpening = (body: InventoryOpeningRequestDto) => send<InventoryOpeningDto>('POST', `${BFF}/inventory/openings`, body);
export const openStocktake = (body: InventoryStocktakeOpenRequestDto) => send<InventoryStocktakeDto>('POST', `${BFF}/inventory/stocktakes`, body);
export const putStocktakeCounts = (stocktakeId: string, body: InventoryStocktakeCountRequestDto) =>
  send<InventoryStocktakeCountDto>('PUT', `${BFF}/inventory/stocktakes/${seg(stocktakeId)}/counts`, body);
export const finalizeStocktake = (stocktakeId: string, body: InventoryStocktakeFinalizeRequestDto) =>
  send<InventoryStocktakeCloseDto>('POST', `${BFF}/inventory/stocktakes/${seg(stocktakeId)}/finalize`, body);
export const cancelStocktake = (stocktakeId: string) => send<InventoryStocktakeCloseDto>('POST', `${BFF}/inventory/stocktakes/${seg(stocktakeId)}/cancel`, {});

// ── Product tracking and warehouse reach (state retry kind) ──────────────
export const putProductConfiguration = (productId: string, body: InventoryConfigurationRequestDto) =>
  send<InventoryConfigurationResultDto>('PUT', `${BFF}/inventory/products/${seg(productId)}/configuration`, body);
export const addWarehouseBranch = (warehouseId: string, branchId: string) =>
  send<WarehouseBranchAssociationDto>('POST', `${BFF}/businesses/current/warehouses/${seg(warehouseId)}/branches`, { branchId });
export const removeWarehouseBranch = (warehouseId: string, branchId: string) =>
  send<WarehouseBranchAssociationDto>('DELETE', `${BFF}/businesses/current/warehouses/${seg(warehouseId)}/branches/${seg(branchId)}`);

// ── Suppliers (P3-S4 reads; `search` from P3-S7 A-09(d)) ─────────────────
export const listSuppliers = (q: SuppliersQuery = {}) => read<Page<SupplierDto>>(`${BFF}/suppliers${qs({ ...q })}`);
export const getSupplier = (supplierId: string) => read<SupplierDto>(`${BFF}/suppliers/${seg(supplierId)}`);
export const createSupplier = (body: SupplierCreateRequestDto) => send<SupplierCommandResultDto>('POST', `${BFF}/suppliers`, body);
export const getSupplierPayable = (supplierId: string) => read<SupplierPayableDto>(`${BFF}/suppliers/${seg(supplierId)}/payable`);
export const listSupplierCreditNotes = (supplierId: string, q: PageQuery = {}) =>
  read<Page<SupplierCreditNoteDto>>(`${BFF}/suppliers/${seg(supplierId)}/credit-notes${qs({ ...q })}`);
export const listSupplierPayments = (supplierId: string, q: PageQuery = {}) =>
  read<Page<SupplierPaymentDto>>(`${BFF}/suppliers/${seg(supplierId)}/payments${qs({ ...q })}`);

// ── Purchases (P3-S4 … P3-S6) ────────────────────────────────────────────
export const listPurchases = (q: PurchasesQuery = {}) => read<Page<PurchaseSummaryDto>>(`${BFF}/purchases${qs({ ...q })}`);
export const getPurchase = (purchaseId: string) => read<PurchaseDto>(`${BFF}/purchases/${seg(purchaseId)}`);
export const getPurchasePayable = (purchaseId: string) => read<PurchasePayableDto>(`${BFF}/purchases/${seg(purchaseId)}/payable`);
export const listPurchaseReturns = (purchaseId: string, q: PageQuery = {}) =>
  read<Page<SupplierReturnDto>>(`${BFF}/purchases/${seg(purchaseId)}/returns${qs({ ...q })}`);
export const getPurchaseSettlements = (purchaseId: string) => read<PurchaseSettlementsDto>(`${BFF}/purchases/${seg(purchaseId)}/settlements`);
/** Creates (expectedRevision 0) or replaces the whole draft — revision retry kind. */
export const putPurchaseDraft = (purchaseId: string, body: PurchaseDraftRequestDto) =>
  send<PurchaseCommandResultDto>('PUT', `${BFF}/purchases/${seg(purchaseId)}`, body);
export const receivePurchase = (purchaseId: string, body: PurchaseTransitionRequestDto) =>
  send<PurchaseReceiptDto>('POST', `${BFF}/purchases/${seg(purchaseId)}/receive`, body);
export const receiveAndPayPurchase = (purchaseId: string, body: ReceiveAndPayRequestDto) =>
  send<ReceiveAndPayResultDto>('POST', `${BFF}/purchases/${seg(purchaseId)}/receive-and-pay`, body);
export const cancelPurchase = (purchaseId: string, body: PurchaseTransitionRequestDto) =>
  send<PurchaseCommandResultDto>('POST', `${BFF}/purchases/${seg(purchaseId)}/cancel`, body);
export const returnToSupplier = (purchaseId: string, body: SupplierReturnRequestDto) =>
  send<SupplierReturnResultDto>('POST', `${BFF}/purchases/${seg(purchaseId)}/returns`, body);
export const undoPurchaseReceipt = (purchaseId: string, body: PurchaseReversalRequestDto) =>
  send<PurchaseReversalResultDto>('POST', `${BFF}/purchases/${seg(purchaseId)}/reversal`, body);

// ── Supplier settlement (P3-S6; document-id retry kind) ──────────────────
export const paySupplier = (body: SupplierPaymentRequestDto) => send<SupplierPaymentResultDto>('POST', `${BFF}/supplier-payments`, body);
export const getSupplierPayment = (paymentId: string) => read<SupplierPaymentDto>(`${BFF}/supplier-payments/${seg(paymentId)}`);
export const allocateBalanceInYourFavour = (body: SupplierCreditAllocationRequestDto) =>
  send<SupplierCreditAllocationResultDto>('POST', `${BFF}/supplier-credit-allocations`, body);
export const getMoneyBack = (body: SupplierRefundRequestDto) => send<SupplierRefundResultDto>('POST', `${BFF}/supplier-refunds`, body);

// ── Payment methods (P3-S6) and the first-method setup (A-09(e), TL-3) ───
export const listPaymentMethods = () => read<ListDto<PaymentMethodDto>>(`${BFF}/payment-methods`);
export const createPaymentMethod = (body: PaymentMethodCreateRequestDto) => send<PaymentMethodCommandResultDto>('POST', `${BFF}/payment-methods`, body);
/** Read only to resolve a system account by `systemKey` for the first-method setup; never rendered (A-13). */
export const listSettlementAccounts = (businessId: string) =>
  read<AccountingAccountListDto>(`${BFF}/businesses/${seg(businessId)}/accounting/accounts${qs({ type: 'asset' })}`);

// ── Missing exchange rate (A-14; header retry kind, the key is the form's) ──
export const enterExchangeRate = (businessId: string, body: AccountingFxRateCreateDto, idempotencyKey: string) =>
  send<AccountingFxRateRefDto>('POST', `${BFF}/businesses/${seg(businessId)}/accounting/fx-rates`, body, idempotencyKey);
