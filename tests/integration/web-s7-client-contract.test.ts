/**
 * T-14 — THE ANDROID AUDIT (P3-S7 contract A-10, §6 T-14; MP-4).
 *
 * Every route an S7 screen calls, through `apps/web/src/lib/phase3-api.ts`,
 * has one audit row: its method and path, the permission and scope it needs,
 * how a retry is made safe (`document-id`, `header`, `revision`, `state` or
 * `read`), and the DTO type the web reads it as. This is the P1-GOLD-38
 * mechanism (`06-web-contract.golden.test.ts`) applied to the Phase 3 client:
 *
 *   - every row is called DIRECTLY on the API with only `Authorization:
 *     Bearer`, `X-Business-Id`, `Accept-Language` and the idempotency
 *     material — no cookie, no BFF — which is what an Android client sends,
 *     and which proves no command leans on server session state (L:1294);
 *   - the status and the DTO shape are asserted;
 *   - every mutation is replayed with the same document id, key or
 *     revision, and answers `replayed: true` (`created: false` for the
 *     header kind; `changed: false` for the state kind);
 *   - one deliberate refusal per command family carries its stable domain
 *     code in `error.details` (§3);
 *   - mechanically: every `export const` of phase3-api.ts has a row, every
 *     `${BFF}/…` template is an audited path, and each row's DTO type is the
 *     one the client function is typed with.
 *
 * The S7 read rows (A-05 … A-09) need agent R's routes; until they are
 * merged those rows answer 404 and this suite is red for exactly them.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  allocateBody,
  httpDraft,
  httpReceived,
  methodBody,
  payBody,
  refundBody,
  returnToCredit,
  seedSettlementAccounts,
  type HttpPurchase,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';
import { historicalReturn, writeOffBody } from '../helpers/p3c-residue';

const CLIENT = readFileSync(join(__dirname, '../../apps/web/src/lib/phase3-api.ts'), 'utf8');

type Kind = 'document-id' | 'header' | 'revision' | 'state' | 'read';
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
/** What a replay of the same command must answer. */
type Replay = 'replayed' | 'created-false' | 'changed-false' | 'lines-unchanged';

/** The state the audit builds as it walks the rows, in order. */
interface World {
  day: string;
  stocktakeId: string;
  cancelStocktakeId: string;
  productId: string;
  supplierId: string;
  purchaseId: string;
  purchaseLineId: string;
  paymentMethodId: string;
  paymentId: string;
  credit: { purchase: HttpPurchase; creditNoteId: string } | null;
  creditTarget: string;
  payLater: string;
  cancelLater: string;
  undoLater: string;
  /** A received TRY purchase in the ILS business holding a historical sub-unit residue. */
  residuePurchaseId: string;
  /** Its outstanding amount as the payable read states it: what the client writes off. */
  residueMinor: string;
  residueKey: string;
  fxKey: string;
  fxBody: Record<string, unknown>;
}

interface AuditRow {
  /** The phase3-api.ts export this row audits. */
  readonly client: string;
  readonly method: Method;
  /** The API path under /v1, with its query. */
  readonly path: (w: World) => string;
  readonly permission: string;
  readonly scope: 'warehouse' | 'business-wide' | 'business';
  readonly kind: Kind;
  /** The type argument of the client's read<…>/send<…> call. */
  readonly dto: string;
  readonly body?: (w: World) => Record<string, unknown>;
  /** The `Idempotency-Key` of the header kind. */
  readonly key?: (w: World) => string;
  readonly status: number;
  /** Top-level keys the DTO must carry. */
  readonly shape: readonly string[];
  readonly replay?: { readonly status: number; readonly answer: Replay };
  /** Setup the row needs, made through the API before it is called. */
  readonly before?: (w: World) => Promise<void>;
  /** What the row's answer contributes to the world. */
  readonly after?: (w: World, body: Record<string, unknown>) => void;
}

const PAGE = ['items', 'nextCursor'] as const;

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;

const world: World = {
  day: '',
  stocktakeId: randomUUID(),
  cancelStocktakeId: randomUUID(),
  productId: '',
  supplierId: randomUUID(),
  purchaseId: randomUUID(),
  purchaseLineId: randomUUID(),
  paymentMethodId: '',
  paymentId: '',
  credit: null,
  creditTarget: '',
  payLater: '',
  cancelLater: '',
  undoLater: '',
  residuePurchaseId: '',
  residueMinor: '',
  residueKey: `s7-audit-residue-${randomUUID()}`,
  fxKey: `s7-audit-fx-${randomUUID()}`,
  fxBody: {},
};

/** The only headers an Android client sends: no cookie, no BFF. */
function android(extra: Record<string, string> = {}): Record<string, string> {
  return { ...asMember(owner, A.businessId), 'Accept-Language': 'ar', ...extra };
}

function call(method: Method, path: string, body?: Record<string, unknown>, key?: string): Promise<Response> {
  const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
  const req = t.request[verb](`/v1/${path}`).set(android(key === undefined ? {} : { 'Idempotency-Key': key }));
  return body === undefined ? req : req.send(body);
}

const piece = (quantity: string): Record<string, unknown> => ({ productId: A.piece.productId, quantity });

const ROWS: readonly AuditRow[] = [
  // ── S7 reads: access, warehouses, items, units (A-05, A-06) ────────────
  {
    client: 'getInventoryAccess',
    method: 'GET',
    path: () => 'inventory/access',
    permission: 'any member',
    scope: 'business',
    kind: 'read',
    dto: 'InventoryAccessDto',
    status: 200,
    shape: ['businessWide', 'permissions', 'openingPosted'],
  },
  {
    client: 'listInventoryWarehouses',
    method: 'GET',
    path: () => 'inventory/warehouses',
    permission:
      'warehouse.view | inventory.view | purchases.view | inventory.transfer | inventory.stocktake | inventory.adjust | purchases.manage | purchases.receive',
    scope: 'warehouse',
    kind: 'read',
    dto: 'ListDto<InventoryWarehouseDto>',
    status: 200,
    shape: ['items'],
  },
  {
    client: 'listInventoryItems',
    method: 'GET',
    path: () => 'inventory/items?trackedOnly=true&limit=20',
    permission: 'inventory.view | purchases.view | purchases.manage | inventory.adjust | inventory.transfer | inventory.stocktake | purchases.receive',
    scope: 'business',
    kind: 'read',
    dto: 'Page<InventoryItemDto>',
    status: 200,
    shape: PAGE,
  },
  {
    client: 'listInventoryUnits',
    method: 'GET',
    path: () => 'inventory/units',
    permission: 'any member',
    scope: 'business',
    kind: 'read',
    dto: 'ListDto<InventoryUnitDto>',
    status: 200,
    shape: ['items'],
  },

  // ── Stock commands (S3; document-id) ───────────────────────────────────
  {
    client: 'postOpening',
    method: 'POST',
    path: () => 'inventory/openings',
    permission: 'inventory.adjust',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'InventoryOpeningDto',
    body: (w) => ({
      openingId: stable('opening'),
      occurredOn: w.day,
      lines: [{ productId: A.piece.productId, warehouseId: A.w1, quantity: '10', unitCost: '10' }],
    }),
    status: 201,
    shape: ['id', 'case', 'lines', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'listStock',
    method: 'GET',
    path: () => `inventory/stock?warehouseId=${A.w1}&limit=20`,
    permission: 'inventory.view',
    scope: 'warehouse',
    kind: 'read',
    dto: 'Page<InventoryStockRowDto>',
    status: 200,
    shape: PAGE,
  },
  {
    client: 'postTransfer',
    method: 'POST',
    path: () => 'inventory/transfers',
    permission: 'inventory.transfer',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'InventoryMovementDocumentDto',
    body: () => ({ transferId: stable('transfer'), sourceWarehouseId: A.w1, destinationWarehouseId: A.w2, lines: [piece('1')] }),
    status: 201,
    shape: ['id', 'lines', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'postAdjustment',
    method: 'POST',
    path: () => 'inventory/adjustments',
    permission: 'inventory.adjust',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'InventoryMovementDocumentDto',
    body: (w) => ({
      adjustmentId: stable('adjustment'),
      warehouseId: A.w1,
      occurredOn: w.day,
      reason: 'a counted correction',
      lines: [{ ...piece('2'), unitCost: '13' }],
    }),
    status: 201,
    shape: ['id', 'lines', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'postDamage',
    method: 'POST',
    path: () => 'inventory/damages',
    permission: 'inventory.adjust',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'InventoryMovementDocumentDto',
    body: (w) => ({ adjustmentId: stable('damage'), warehouseId: A.w1, occurredOn: w.day, reason: 'water damage', lines: [piece('1')] }),
    status: 201,
    shape: ['id', 'lines', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'openStocktake',
    method: 'POST',
    path: () => 'inventory/stocktakes',
    permission: 'inventory.stocktake',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'InventoryStocktakeDto',
    body: (w) => ({ stocktakeId: w.stocktakeId, warehouseId: A.w2 }),
    status: 201,
    shape: ['id', 'warehouseId', 'status', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'putStocktakeCounts',
    method: 'PUT',
    path: (w) => `inventory/stocktakes/${w.stocktakeId}/counts`,
    permission: 'inventory.stocktake',
    scope: 'warehouse',
    kind: 'state',
    dto: 'InventoryStocktakeCountDto',
    body: () => ({ lines: [piece('0')] }),
    status: 200,
    shape: ['id', 'lines'],
    replay: { status: 200, answer: 'lines-unchanged' },
  },
  {
    client: 'listStocktakes',
    method: 'GET',
    path: () => `inventory/stocktakes?warehouseId=${A.w2}&limit=20`,
    permission: 'inventory.view | inventory.stocktake',
    scope: 'warehouse',
    kind: 'read',
    dto: 'Page<InventoryStocktakeSummaryDto>',
    status: 200,
    shape: PAGE,
  },
  {
    client: 'getStocktake',
    method: 'GET',
    path: (w) => `inventory/stocktakes/${w.stocktakeId}`,
    permission: 'inventory.view | inventory.stocktake',
    scope: 'warehouse',
    kind: 'read',
    dto: 'InventoryStocktakeDetailDto',
    status: 200,
    shape: ['stocktakeId', 'warehouseId', 'status', 'lines'],
  },
  {
    client: 'finalizeStocktake',
    method: 'POST',
    path: (w) => `inventory/stocktakes/${w.stocktakeId}/finalize`,
    permission: 'inventory.stocktake',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'InventoryStocktakeCloseDto',
    body: (w) => ({ occurredOn: w.day }),
    status: 200,
    shape: ['id', 'status', 'lines', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'cancelStocktake',
    method: 'POST',
    path: (w) => `inventory/stocktakes/${w.cancelStocktakeId}/cancel`,
    permission: 'inventory.stocktake',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'InventoryStocktakeCloseDto',
    body: () => ({}),
    status: 200,
    shape: ['id', 'status', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
    before: async (w) => {
      const r = await call('POST', 'inventory/stocktakes', { stocktakeId: w.cancelStocktakeId, warehouseId: A.w2 });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    },
  },

  // ── Tracking and reach (state) ─────────────────────────────────────────
  {
    client: 'putProductConfiguration',
    method: 'PUT',
    path: (w) => `inventory/products/${w.productId}/configuration`,
    permission: 'inventory.adjust',
    scope: 'business',
    kind: 'state',
    dto: 'InventoryConfigurationResultDto',
    body: () => ({ trackInventory: true, unitCode: 'piece' }),
    status: 200,
    shape: ['productId', 'trackInventory', 'unitCode', 'unitDecimals', 'changed'],
    replay: { status: 200, answer: 'changed-false' },
    before: async (w) => {
      const r = await call('POST', 'catalog/products', { translations: { ar: 'قهوة', en: 'Coffee' }, basePriceMinor: '1500' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      w.productId = String((r.body as { id: string }).id);
    },
  },
  {
    client: 'addWarehouseBranch',
    method: 'POST',
    path: () => `businesses/current/warehouses/${A.w1}/branches`,
    permission: 'warehouse.manage',
    scope: 'business-wide',
    kind: 'state',
    dto: 'WarehouseBranchAssociationDto',
    body: () => ({ branchId: A.branchY }),
    status: 200,
    shape: ['warehouseId', 'branchId', 'associated', 'changed'],
    replay: { status: 200, answer: 'changed-false' },
  },
  {
    client: 'removeWarehouseBranch',
    method: 'DELETE',
    path: () => `businesses/current/warehouses/${A.w1}/branches/${A.branchY}`,
    permission: 'warehouse.manage',
    scope: 'business-wide',
    kind: 'state',
    dto: 'WarehouseBranchAssociationDto',
    status: 200,
    shape: ['warehouseId', 'branchId', 'associated', 'changed'],
    replay: { status: 200, answer: 'changed-false' },
  },

  // ── Suppliers ─────────────────────────────────────────────────────────
  {
    client: 'createSupplier',
    method: 'POST',
    path: () => 'suppliers',
    permission: 'suppliers.manage',
    scope: 'business',
    kind: 'document-id',
    dto: 'SupplierCommandResultDto',
    body: (w) => ({ supplierId: w.supplierId, name: 'Audit Supplier' }),
    status: 201,
    shape: ['id', 'name', 'status', 'revision', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'listSuppliers',
    method: 'GET',
    path: () => 'suppliers?search=Audit&limit=20',
    permission: 'suppliers.view',
    scope: 'business',
    kind: 'read',
    dto: 'Page<SupplierDto>',
    status: 200,
    shape: PAGE,
  },
  {
    client: 'getSupplier',
    method: 'GET',
    path: (w) => `suppliers/${w.supplierId}`,
    permission: 'suppliers.view | suppliers.pay',
    scope: 'business',
    kind: 'read',
    dto: 'SupplierDto',
    status: 200,
    shape: ['id', 'name', 'status'],
  },
  {
    client: 'listSupplierBalances',
    method: 'GET',
    path: () => 'supplier-balances?owedOnly=false&limit=20',
    permission: 'suppliers.view',
    scope: 'business-wide',
    kind: 'read',
    dto: 'Page<SupplierBalanceRowDto>',
    status: 200,
    shape: PAGE,
  },

  // ── Purchases (S4 … S6) ───────────────────────────────────────────────
  {
    client: 'putPurchaseDraft',
    method: 'PUT',
    path: (w) => `purchases/${w.purchaseId}`,
    permission: 'purchases.manage',
    scope: 'warehouse',
    kind: 'revision',
    dto: 'PurchaseCommandResultDto',
    body: (w) => ({
      expectedRevision: 0,
      supplierId: w.supplierId,
      warehouseId: A.w1,
      currency: 'ILS',
      documentDate: w.day,
      lines: [{ lineId: w.purchaseLineId, productId: A.piece.productId, quantity: '4', unitPrice: '12.50' }],
      landedCosts: [],
    }),
    status: 201,
    shape: ['id', 'status', 'revision', 'lines', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'receivePurchase',
    method: 'POST',
    path: (w) => `purchases/${w.purchaseId}/receive`,
    permission: 'purchases.receive',
    scope: 'warehouse',
    kind: 'revision',
    dto: 'PurchaseReceiptDto',
    body: () => ({ draftRevision: 1 }),
    status: 200,
    shape: ['purchaseId', 'totalTxnMinor', 'lines', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'listPurchases',
    method: 'GET',
    path: (w) => `purchases?supplierId=${w.supplierId}&limit=20`,
    permission: 'purchases.view',
    scope: 'warehouse',
    kind: 'read',
    dto: 'Page<PurchaseSummaryDto>',
    status: 200,
    shape: PAGE,
  },
  {
    client: 'getPurchase',
    method: 'GET',
    path: (w) => `purchases/${w.purchaseId}`,
    permission: 'purchases.view',
    scope: 'warehouse',
    kind: 'read',
    dto: 'PurchaseDto',
    status: 200,
    shape: ['id', 'status', 'lines'],
  },
  {
    client: 'getPurchasePayable',
    method: 'GET',
    path: (w) => `purchases/${w.purchaseId}/payable`,
    permission: 'purchases.view',
    scope: 'warehouse',
    kind: 'read',
    dto: 'PurchasePayableDto',
    status: 200,
    shape: ['purchaseId', 'currency', 'outstandingTxnMinor'],
  },
  {
    client: 'getReturnOptions',
    method: 'GET',
    path: (w) => `purchases/${w.purchaseId}/return-options`,
    permission: 'purchases.view',
    scope: 'warehouse',
    kind: 'read',
    dto: 'PurchaseReturnOptionsDto',
    status: 200,
    shape: ['purchaseId', 'returnable', 'reversible', 'lines'],
  },
  {
    client: 'returnToSupplier',
    method: 'POST',
    path: (w) => `purchases/${w.purchaseId}/returns`,
    permission: 'purchases.return',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'SupplierReturnResultDto',
    body: (w) => ({
      returnId: stable('return'),
      warehouseId: A.w1,
      documentDate: w.day,
      lines: [{ lineId: stable('return-line'), purchaseLineId: w.purchaseLineId, quantity: '1' }],
    }),
    status: 201,
    shape: ['returnId', 'purchaseId', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'listPurchaseReturns',
    method: 'GET',
    path: (w) => `purchases/${w.purchaseId}/returns?limit=20`,
    permission: 'purchases.view',
    scope: 'warehouse',
    kind: 'read',
    dto: 'Page<SupplierReturnDto>',
    status: 200,
    shape: PAGE,
  },

  // ── Payment methods and the first-method setup (S6; A-09(e)) ───────────
  {
    client: 'listSettlementAccounts',
    method: 'GET',
    path: () => `businesses/${A.businessId}/accounting/accounts?type=asset`,
    permission: 'accounting.view',
    scope: 'business',
    kind: 'read',
    dto: 'AccountingAccountListDto',
    status: 200,
    shape: ['items'],
  },
  {
    client: 'listPaymentMethodDefaults',
    method: 'GET',
    path: () => 'payment-method-defaults',
    permission: 'accounting.chart.manage',
    scope: 'business',
    kind: 'read',
    dto: 'ListDto<PaymentMethodDefaultDto>',
    status: 200,
    shape: ['items'],
  },
  {
    client: 'createPaymentMethod',
    method: 'POST',
    path: () => 'payment-methods',
    permission: 'accounting.chart.manage',
    scope: 'business',
    kind: 'document-id',
    dto: 'PaymentMethodCommandResultDto',
    body: () => ({ ...methodBody(acc.settlement.cash), paymentMethodId: stable('method') }),
    status: 201,
    shape: ['paymentMethodId', 'systemType', 'isActive', 'names', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
    after: (w, body) => {
      w.paymentMethodId = String(body['paymentMethodId']);
    },
  },
  {
    client: 'listPaymentMethods',
    method: 'GET',
    path: () => 'payment-methods',
    permission: 'suppliers.pay | accounting.view',
    scope: 'business',
    kind: 'read',
    dto: 'ListDto<PaymentMethodDto>',
    status: 200,
    shape: ['items'],
  },

  // ── Supplier settlement (S6; document-id) ──────────────────────────────
  {
    client: 'listOpenPurchases',
    method: 'GET',
    path: (w) => `suppliers/${w.supplierId}/open-purchases?currency=ILS&amount=1000&limit=20`,
    permission: 'suppliers.view | suppliers.pay',
    scope: 'warehouse',
    kind: 'read',
    dto: 'SupplierOpenPurchasesDto',
    status: 200,
    shape: [...PAGE, 'unallocatedMinor'],
  },
  {
    client: 'paySupplier',
    method: 'POST',
    path: () => 'supplier-payments',
    permission: 'suppliers.pay',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'SupplierPaymentResultDto',
    body: (w) => {
      const body = payBody(w.supplierId, w.paymentMethodId, w.day, [{ purchaseId: w.purchaseId, paymentAmountMinor: '1000' }]);
      return {
        ...body,
        paymentId: stable('payment'),
        allocations: (body['allocations'] as Record<string, unknown>[]).map((a) => ({ ...a, allocationId: stable('payment-allocation') })),
      };
    },
    status: 201,
    shape: ['paymentId', 'supplierId', 'allocations', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
    after: (w, body) => {
      w.paymentId = String(body['paymentId']);
    },
  },
  {
    client: 'getSupplierPayment',
    method: 'GET',
    path: (w) => `supplier-payments/${w.paymentId}`,
    permission: 'suppliers.view',
    scope: 'warehouse',
    kind: 'read',
    dto: 'SupplierPaymentDto',
    status: 200,
    shape: ['paymentId', 'allocations'],
  },
  {
    client: 'listSupplierPayments',
    method: 'GET',
    path: (w) => `suppliers/${w.supplierId}/payments?limit=20`,
    permission: 'suppliers.view',
    scope: 'business-wide',
    kind: 'read',
    dto: 'Page<SupplierPaymentDto>',
    status: 200,
    shape: PAGE,
  },
  {
    client: 'getPurchaseSettlements',
    method: 'GET',
    path: (w) => `purchases/${w.purchaseId}/settlements`,
    permission: 'suppliers.view',
    scope: 'warehouse',
    kind: 'read',
    dto: 'PurchaseSettlementsDto',
    status: 200,
    shape: ['purchaseId', 'payments', 'creditAllocations'],
  },
  {
    client: 'getSupplierPayable',
    method: 'GET',
    path: (w) => `suppliers/${w.supplierId}/payable`,
    permission: 'suppliers.view',
    scope: 'business-wide',
    kind: 'read',
    dto: 'SupplierPayableDto',
    status: 200,
    shape: ['supplierId', 'byCurrency'],
  },
  {
    client: 'listSupplierCreditNotes',
    method: 'GET',
    path: (w) => `suppliers/${must(w.credit).purchase.supplierId}/credit-notes?limit=20`,
    permission: 'suppliers.view',
    scope: 'business-wide',
    kind: 'read',
    dto: 'Page<SupplierCreditNoteDto>',
    status: 200,
    shape: PAGE,
    before: async (w) => {
      w.credit = await returnToCredit(t, owner, A, w.paymentMethodId);
      w.creditTarget = (await httpReceived(t, owner, A, { supplierId: w.credit.purchase.supplierId })).purchaseId;
    },
  },
  {
    client: 'allocateBalanceInYourFavour',
    method: 'POST',
    path: () => 'supplier-credit-allocations',
    permission: 'suppliers.pay',
    scope: 'business-wide',
    kind: 'document-id',
    dto: 'SupplierCreditAllocationResultDto',
    body: (w) => ({ ...allocateBody(must(w.credit).creditNoteId, w.creditTarget, w.day, '100'), allocationId: stable('credit-allocation') }),
    status: 201,
    shape: ['allocationId', 'creditNoteId', 'purchaseId', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'getMoneyBack',
    method: 'POST',
    path: () => 'supplier-refunds',
    permission: 'suppliers.pay',
    scope: 'business-wide',
    kind: 'document-id',
    dto: 'SupplierRefundResultDto',
    body: (w) => ({ ...refundBody(must(w.credit).creditNoteId, w.paymentMethodId, w.day, '100'), refundId: stable('refund') }),
    status: 201,
    shape: ['refundId', 'creditNoteId', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
  },
  {
    client: 'receiveAndPayPurchase',
    method: 'POST',
    path: (w) => `purchases/${w.payLater}/receive-and-pay`,
    permission: 'purchases.receive + suppliers.pay',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'ReceiveAndPayResultDto',
    body: (w) => ({
      draftRevision: 1,
      payment: {
        paymentId: stable('rap-payment'),
        allocationId: stable('rap-allocation'),
        paymentMethodId: w.paymentMethodId,
        currencyCode: 'ILS',
        amountMinor: '500',
      },
    }),
    status: 200,
    shape: ['purchaseId', 'receipt', 'payment', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
    before: async (w) => {
      w.payLater = (await httpDraft(t, owner, A, { supplierId: w.supplierId })).purchaseId;
    },
  },
  {
    client: 'cancelPurchase',
    method: 'POST',
    path: (w) => `purchases/${w.cancelLater}/cancel`,
    permission: 'purchases.manage',
    scope: 'warehouse',
    kind: 'revision',
    dto: 'PurchaseCommandResultDto',
    body: () => ({ draftRevision: 1 }),
    status: 200,
    shape: ['id', 'status', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
    before: async (w) => {
      w.cancelLater = (await httpDraft(t, owner, A, { supplierId: w.supplierId })).purchaseId;
    },
  },
  {
    client: 'undoPurchaseReceipt',
    method: 'POST',
    path: (w) => `purchases/${w.undoLater}/reversal`,
    permission: 'purchases.receive',
    scope: 'warehouse',
    kind: 'document-id',
    dto: 'PurchaseReversalResultDto',
    body: (w) => ({ reversalDate: w.day, reason: 'Received against the wrong supplier' }),
    status: 200,
    shape: ['purchaseId', 'reversalDate', 'lines', 'replayed'],
    replay: { status: 200, answer: 'replayed' },
    before: async (w) => {
      w.undoLater = (await httpReceived(t, owner, A, { supplierId: w.supplierId })).purchaseId;
    },
  },

  // ── The sub-unit leftover (TD-16, 0072 R-96) ───────────────────────────
  // The client sends its per-confirmation key; the write-off's identity is
  // the purchase itself, so the same close sent again answers the stored
  // write-off: 200, replayed: true.
  {
    client: 'closePurchaseLeftover',
    method: 'POST',
    path: (w) => `purchases/${w.residuePurchaseId}/residue-write-off`,
    permission: 'suppliers.pay',
    scope: 'business-wide',
    kind: 'header',
    dto: 'PurchaseResidueWriteOffResultDto',
    key: (w) => w.residueKey,
    body: (w) => writeOffBody({ date: w.day, amount: w.residueMinor }),
    status: 201,
    shape: [
      'purchaseId',
      'supplierId',
      'currency',
      'writeOffDate',
      'reason',
      'residueTxnMinor',
      'releasedBeforeTxnMinor',
      'residueBaseMinor',
      'journalEntryId',
      'createdAt',
      'replayed',
      'businessTransactionId',
    ],
    replay: { status: 200, answer: 'replayed' },
    before: async (w) => {
      // TRY at 0.11 into ILS: one kurus converts to 0 agora. Lines 49.99 +
      // 0.01, the 49.99 returned with the frozen S5 behaviour (the only way
      // a residue exists now that 0072 R-95 refuses new ones) → 0.01 left.
      const rate = await call(
        'POST',
        `businesses/${A.businessId}/accounting/fx-rates`,
        { fromCurrency: 'TRY', toCurrency: 'ILS', rate: '0.1100000000', effectiveAt: `${w.day}T00:00:00Z` },
        `s7-audit-try-${randomUUID()}`,
      );
      expect(rate.status, JSON.stringify(rate.body)).toBe(201);
      const p = await httpReceived(t, owner, A, {
        currency: 'TRY',
        lines: [
          { productId: A.piece.productId, quantity: '1', unitPrice: '49.99' },
          { productId: A.piece2.productId, quantity: '1', unitPrice: '0.01' },
        ],
      });
      await historicalReturn(A, p, 0, '1');
      w.residuePurchaseId = p.purchaseId;
      const payable = await call('GET', `purchases/${p.purchaseId}/payable`);
      expect(payable.status, JSON.stringify(payable.body)).toBe(200);
      const read = payable.body as { outstandingTxnMinor: string; outstandingBaseMinor: string };
      expect(read, 'a sub-unit residue: owed in TRY, nothing in ILS').toMatchObject({ outstandingTxnMinor: '1', outstandingBaseMinor: '0' });
      w.residueMinor = read.outstandingTxnMinor;
    },
  },

  // ── Missing exchange rate (A-14; header) ───────────────────────────────
  {
    client: 'enterExchangeRate',
    method: 'POST',
    path: () => `businesses/${A.businessId}/accounting/fx-rates`,
    permission: 'accounting.fx.manage',
    scope: 'business-wide',
    kind: 'header',
    dto: 'AccountingFxRateRefDto',
    key: (w) => w.fxKey,
    body: (w) => w.fxBody,
    status: 201,
    shape: ['rateId', 'created'],
    replay: { status: 201, answer: 'created-false' },
  },
];

/** A client-chosen document id per role, fixed for the run, so the replay sends the very same one. */
const documentIds: Record<string, string> = {};
function stable(role: string): string {
  const id = documentIds[role] ?? randomUUID();
  documentIds[role] = id;
  return id;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  world.day = await today();
  world.fxBody = { fromCurrency: 'USD', toCurrency: 'ILS', rate: '3.7100000000', effectiveAt: `${world.day}T00:00:00Z` };
  t = await createTestApp();
  owner = await registerActor(t, 'S7 audit owner');
  A = await onboardS3Business(t, owner, 's7audit');
  acc = await seedSettlementAccounts(ownerPool(), A);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

function expectReplay(row: AuditRow, first: Record<string, unknown>, again: Response): void {
  const replay = must(row.replay);
  const body = again.body as Record<string, unknown>;
  expect(again.status, `${row.client} replay → ${JSON.stringify(body)}`).toBe(replay.status);
  switch (replay.answer) {
    case 'replayed':
      expect(body['replayed'], `${row.client}: a replay answers replayed: true`).toBe(true);
      expect(first['replayed'], `${row.client}: the first call is not a replay`).toBe(false);
      break;
    case 'created-false':
      expect(first['created']).toBe(true);
      expect(body['created'], `${row.client}: the same key answers created: false`).toBe(false);
      expect(body['rateId']).toBe(first['rateId']);
      break;
    case 'changed-false':
      expect(first['changed']).toBe(true);
      expect(body['changed'], `${row.client}: the end state already holds`).toBe(false);
      break;
    case 'lines-unchanged': {
      const lines = body['lines'] as { changed: boolean }[];
      expect(lines.length).toBeGreaterThan(0);
      expect(
        lines.every((l) => l.changed === false),
        `${row.client}: every stated line already holds`,
      ).toBe(true);
      break;
    }
  }
}

describe('T-14 — every Phase 3 client route, called directly on the API as Android would', () => {
  for (const row of ROWS) {
    it(`${row.client}: ${row.method} ${row.kind} (${row.permission}; ${row.scope})`, async () => {
      if (row.before !== undefined) await row.before(world);
      const path = row.path(world);
      const body = row.body?.(world);
      const key = row.key?.(world);
      const res = await call(row.method, path, body, key);
      expect(res.status, `${row.client}: ${row.method} /v1/${path} → ${JSON.stringify(res.body)}`).toBe(row.status);
      expect(res.headers['set-cookie'], `${row.client}: no session cookie is issued`).toBeUndefined();
      const answer = res.body as Record<string, unknown>;
      for (const k of row.shape) expect(answer, `${row.client}: DTO carries ${k}`).toHaveProperty(k);
      row.after?.(world, answer);
      if (row.method === 'GET') {
        expect(row.kind).toBe('read');
        return;
      }
      expect(row.kind, `${row.client}: a mutation names how its retry is safe`).not.toBe('read');
      expectReplay(row, answer, await call(row.method, path, body, key));
    });
  }
});

describe('T-14 — a refusal carries its stable domain code in details (§3)', () => {
  const detailsOf = (res: Response): Record<string, unknown> => (res.body as { error: { details?: Record<string, unknown> } }).error.details ?? {};

  it('inventory: closing a finalized stocktake', async () => {
    const res = await call('POST', `inventory/stocktakes/${world.stocktakeId}/cancel`, {});
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(String(detailsOf(res)['inventoryCode'])).toMatch(/^inventory\./);
  });

  it('purchasing: cancelling a received purchase', async () => {
    const res = await call('POST', `purchases/${world.purchaseId}/cancel`, { draftRevision: 1 });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(String(detailsOf(res)['purchasingCode'])).toMatch(/^purchase\./);
  });

  it('settlement: paying more than is outstanding', async () => {
    const res = await call(
      'POST',
      'supplier-payments',
      payBody(world.supplierId, world.paymentMethodId, world.day, [{ purchaseId: world.purchaseId, paymentAmountMinor: '99999999' }]),
    );
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(String(detailsOf(res)['purchasingCode'])).toMatch(/^supplier_payment\./);
  });

  it('payment method: posting through the inventory account', async () => {
    const res = await call('POST', 'payment-methods', methodBody(acc.inventory));
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(String(detailsOf(res)['paymentMethodCode'])).toMatch(/^payment_method\./);
  });

  it('accounting: the same key stating a different rate is ACCOUNTING_REFUSED with details.code', async () => {
    const res = await call('POST', `businesses/${A.businessId}/accounting/fx-rates`, { ...world.fxBody, rate: '3.8000000000' }, world.fxKey);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('ACCOUNTING_REFUSED');
    expect(detailsOf(res)['code']).toBe('accounting.idempotency_conflict');
  });
});

describe('T-14 — the audit and phase3-api.ts are in sync, mechanically', () => {
  it('every export has a row, and every row names a real export', () => {
    const exported = [...CLIENT.matchAll(/^export const (\w+) = /gm)].map((m) => must(m[1]));
    const audited = new Set(ROWS.map((r) => r.client));
    expect(
      exported.filter((name) => !audited.has(name)),
      'client functions without an audit row',
    ).toEqual([]);
    expect(
      ROWS.map((r) => r.client).filter((name) => !exported.includes(name)),
      'rows naming no client function',
    ).toEqual([]);
    expect(new Set(ROWS.map((r) => r.client)).size, 'one row per client function').toBe(ROWS.length);
  });

  it("each row's method and DTO type are the ones the client function is written with", () => {
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const row of ROWS) {
      const helper = row.method === 'GET' ? `read<${escape(row.dto)}>\\(` : `send<${escape(row.dto)}>\\(\\s*'${row.method}'`;
      expect(CLIENT, `${row.client}: ${row.method} typed ${row.dto}`).toMatch(new RegExp(`export const ${row.client} = [^;]*?${helper}`));
    }
  });

  it('every ${BFF}/… path template of the client is an audited path', () => {
    const shape = (p: string): string => p.replace(/\?.*$/, '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id');
    const audited = new Set(ROWS.map((r) => shape(r.path(world))));
    const templates = [...CLIENT.matchAll(/\$\{BFF\}\/((?:[a-zA-Z0-9/-]|\$\{seg\(\w+\)\})+)/g)].map((m) => must(m[1]).replace(/\$\{seg\(\w+\)\}/g, ':id'));
    expect(templates.length).toBeGreaterThanOrEqual(ROWS.length - 1);
    expect(
      templates.filter((tpl) => !audited.has(tpl)),
      'client paths that are not audited',
    ).toEqual([]);
  });

  it('every row records its retry kind, permission and scope, and a GET is exactly a read', () => {
    for (const row of ROWS) {
      expect(row.permission.length, row.client).toBeGreaterThan(0);
      expect(row.method === 'GET', `${row.client}: a GET is the read kind and nothing else is`).toBe(row.kind === 'read');
      expect(row.method === 'GET' || row.replay !== undefined, `${row.client}: a mutation is replayed`).toBe(true);
      expect(row.kind === 'header', `${row.client}: only the header kind carries a key`).toBe(row.key !== undefined);
    }
  });
});
