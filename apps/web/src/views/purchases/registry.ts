/**
 * The purchasing views and the fixtures the SSR suites render them with
 * (P3-S7 contract §4.3, §6: T-08, T-15, T-16).
 *
 * The fixtures carry, deliberately, what a real answer carries and the
 * merchant must never read: trace ids (`businessTransactionId`), entry ids
 * (`purchaseEntryId`, `catchUpEntryId`, `entryId`, `originalEntryId`,
 * `reversalEntryId`), movement ids and a method's `postingAccountId`. T-08
 * proves no render emits one.
 */
import type {
  PaymentMethodDto,
  PurchaseReceiptDto,
  PurchaseReversalResultDto,
  PurchaseSettlementsDto,
  SupplierPaymentDto,
  SupplierReturnResultDto,
} from '@daftar/shared-contracts';
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import type { ExchangeRatePromptProps } from '../common/feedback';
import { PurchaseDetailView, type PurchaseDetailViewProps } from './PurchaseDetailView';
import { PurchaseListView, type PurchaseListViewProps } from './PurchaseListView';
import { ReceivePurchaseView, type ReceiveHandlers, type ReceivePurchaseViewProps } from './ReceivePurchaseView';
import { ReturnToSupplierView, type ReturnToSupplierViewProps } from './ReturnToSupplierView';
import type { PurchaseDetailModel, PurchaseRowModel, ReceiveForm, ReceiveLineForm, ReceiveReviewModel, ReturnLineForm } from './types';

const noop = (): void => undefined;

// ── Shared fixture data ──────────────────────────────────────────────────

const SUPPLIER = { supplierId: '5b0c1a2e-0001-4a7b-8c9d-00000000s001', name: 'Al-Noor Trading' };
const WAREHOUSES = [
  { warehouseId: '6c0d2b3f-0002-4a7b-8c9d-00000000w001', name: 'Main store' },
  { warehouseId: '6c0d2b3f-0002-4a7b-8c9d-00000000w002', name: 'Back room' },
];
const PURCHASE_ID = '7d1e3c40-0003-4a7b-8c9d-00000000p001';
const OIL = { productId: '8e2f4d51-0004-4a7b-8c9d-00000000i001', name: 'Olive oil', unitDecimals: 2, variants: [] };
const SHIRT = {
  productId: '8e2f4d51-0004-4a7b-8c9d-00000000i002',
  name: 'Cotton shirt',
  unitDecimals: 0,
  variants: [
    { variantId: '9f305e62-0005-4a7b-8c9d-00000000v001', name: 'Large' },
    { variantId: '9f305e62-0005-4a7b-8c9d-00000000v002', name: 'Small' },
  ],
};

const METHODS: PaymentMethodDto[] = [
  {
    paymentMethodId: 'a0416f73-0006-4a7b-8c9d-00000000m001',
    systemType: 'cash',
    postingAccountId: 'acc0acc0-0007-4a7b-8c9d-0000000pa001',
    isActive: true,
    requiresReference: false,
    sortOrder: 1,
    names: { ar: 'نقدًا', en: 'Cash', tr: 'Nakit' },
    revision: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
  {
    paymentMethodId: 'a0416f73-0006-4a7b-8c9d-00000000m002',
    systemType: 'cheque',
    postingAccountId: 'acc0acc0-0007-4a7b-8c9d-0000000pa002',
    isActive: true,
    requiresReference: true,
    sortOrder: 2,
    names: { ar: 'شيك', en: null, tr: null },
    revision: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
  {
    paymentMethodId: 'a0416f73-0006-4a7b-8c9d-00000000m003',
    systemType: 'wallet',
    postingAccountId: 'acc0acc0-0007-4a7b-8c9d-0000000pa003',
    isActive: false,
    requiresReference: false,
    sortOrder: 3,
    names: { ar: null, en: 'Old wallet', tr: null },
    revision: 2,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-02T08:00:00Z',
  },
];

// ── Purchase list ────────────────────────────────────────────────────────

const ROWS: PurchaseRowModel[] = [
  {
    purchaseId: PURCHASE_ID,
    supplierName: SUPPLIER.name,
    warehouseName: 'Main store',
    documentDate: '2026-09-20',
    supplierReference: 'INV-2291',
    status: 'received',
    currency: 'JOD',
    totalTxnMinor: '152500',
  },
  {
    purchaseId: '7d1e3c40-0003-4a7b-8c9d-00000000p002',
    supplierName: 'Bosphorus Textiles',
    warehouseName: 'Back room',
    documentDate: '2026-09-18',
    supplierReference: null,
    status: 'draft',
    currency: 'USD',
    totalTxnMinor: '98000',
  },
  {
    purchaseId: '7d1e3c40-0003-4a7b-8c9d-00000000p003',
    supplierName: SUPPLIER.name,
    warehouseName: 'Main store',
    documentDate: '2026-08-02',
    supplierReference: null,
    status: 'reversed',
    currency: 'JOD',
    totalTxnMinor: '12000',
  },
];

const listProps = (over: Partial<PurchaseListViewProps>): PurchaseListViewProps => ({
  rows: ROWS,
  filter: 'all',
  canReceive: true,
  hasMore: true,
  loadingMore: false,
  errorKey: null,
  onFilter: noop,
  onOpen: noop,
  onReceive: noop,
  onLoadMore: noop,
  ...over,
});

// ── Receive Purchase ─────────────────────────────────────────────────────

const RECEIVE_HANDLERS: ReceiveHandlers = {
  onSupplierSearch: noop,
  onPickSupplier: noop,
  onClearSupplier: noop,
  onStartNewSupplier: noop,
  onNewSupplierName: noop,
  onCreateSupplier: noop,
  onCancelNewSupplier: noop,
  onWarehouse: noop,
  onDate: noop,
  onToggleCurrency: noop,
  onCurrency: noop,
  onReference: noop,
  onNotes: noop,
  onAddLine: noop,
  onRemoveLine: noop,
  onLineItemSearch: noop,
  onPickItem: noop,
  onClearItem: noop,
  onLineVariant: noop,
  onLineField: noop,
  onToggleDiscount: noop,
  onAddExtraCost: noop,
  onRemoveExtraCost: noop,
  onExtraCostKind: noop,
  onExtraCostAmount: noop,
  onToggleManualSplit: noop,
  onExtraCostShare: noop,
  onReview: noop,
  onBackToEdit: noop,
  onTogglePayNow: noop,
  onPayField: noop,
  onReceive: noop,
  onCancelDraft: noop,
  onNewPurchase: noop,
};

const LINE_ID_1 = 'b1527084-0008-4a7b-8c9d-00000000l001';
const LINE_ID_2 = 'b1527084-0008-4a7b-8c9d-00000000l002';

const emptyLine = (lineId: string): ReceiveLineForm => ({
  lineId,
  item: null,
  itemSearch: '',
  itemResults: [],
  variantId: null,
  quantity: '',
  unitPrice: '',
  showDiscount: false,
  discount: '',
  errors: {},
});

const NEW_FORM: ReceiveForm = {
  supplier: null,
  supplierSearch: 'Al',
  supplierResults: [SUPPLIER, { supplierId: '5b0c1a2e-0001-4a7b-8c9d-00000000s002', name: 'Alpha Foods' }],
  newSupplierName: null,
  duplicateOf: null,
  warehouseId: WAREHOUSES[0]?.warehouseId ?? '',
  documentDate: '2026-09-27',
  showCurrency: false,
  currency: 'JOD',
  supplierReference: '',
  notes: '',
  lines: [{ ...emptyLine(LINE_ID_1), itemSearch: 'oil', itemResults: [OIL] }],
  extraCosts: [],
  errors: {},
};

const FILLED_FORM: ReceiveForm = {
  ...NEW_FORM,
  supplier: SUPPLIER,
  supplierSearch: '',
  supplierResults: [],
  showCurrency: true,
  currency: 'USD',
  supplierReference: 'INV-2291',
  notes: 'Delivered by the supplier van',
  lines: [
    { ...emptyLine(LINE_ID_1), item: OIL, quantity: '12.5', unitPrice: '3.200', showDiscount: true, discount: '2.00' },
    { ...emptyLine(LINE_ID_2), item: SHIRT, variantId: null, quantity: 'x', unitPrice: '', errors: { variant: true, quantity: true, unitPrice: true } },
  ],
  extraCosts: [
    {
      landedCostId: 'c2638195-0009-4a7b-8c9d-00000000c001',
      kind: 'shipping',
      amount: '15.00',
      manual: true,
      shares: { [LINE_ID_1]: '10.00', [LINE_ID_2]: '5.00' },
      errors: {},
    },
    { landedCostId: 'c2638195-0009-4a7b-8c9d-00000000c002', kind: 'customs', amount: '', manual: false, shares: {}, errors: { amount: true } },
  ],
  errors: {},
};

const REVIEW: ReceiveReviewModel = {
  currency: 'USD',
  subtotalTxnMinor: '3800',
  landedCostTxnMinor: '1500',
  totalTxnMinor: '5300',
  lines: [
    { lineId: LINE_ID_1, name: 'Olive oil', variantName: null, qty: '12.5', unitDecimals: 2, unitPrice: '3.200', discountTxnMinor: '200', netTxnMinor: '3800' },
    { lineId: LINE_ID_2, name: 'Cotton shirt', variantName: 'Large', qty: '4', unitDecimals: 0, unitPrice: '0', discountTxnMinor: '0', netTxnMinor: '0' },
  ],
};

const RECEIPT: PurchaseReceiptDto = {
  purchaseId: PURCHASE_ID,
  replayed: false,
  businessTransactionId: 'd374a2a6-000a-4a7b-8c9d-0000000bt001',
  currency: 'USD',
  totalTxnMinor: '5300',
  totalBaseMinor: '3757',
  rate: { rateId: 'e485b3b7-000b-4a7b-8c9d-0000000fx001', rate: '0.709', source: 'manual', at: '2026-09-27T00:00:00Z' },
  lines: [
    {
      lineId: LINE_ID_1,
      productId: OIL.productId,
      variantId: null,
      qty: '12.5',
      baseShareMinor: '3757',
      unitCostBaseMinor: '300',
      movementId: 'f596c4c8-000c-4a7b-8c9d-0000000mv001',
    },
  ],
  coverage: {
    adjustmentId: 'f596c4c8-000c-4a7b-8c9d-0000000ad001',
    totalValueBaseMinor: '600',
    coverages: [
      {
        coverageId: 'f596c4c8-000c-4a7b-8c9d-0000000cv001',
        deficitId: 'f596c4c8-000c-4a7b-8c9d-0000000df001',
        qtyCovered: '2.5',
        provisional: '0',
        actual: '600',
        valueDeltaBaseMinor: '600',
      },
    ],
  },
  purchaseEntryId: '0607d5d9-000d-4a7b-8c9d-0000000je001',
  catchUpEntryId: '0607d5d9-000d-4a7b-8c9d-0000000je002',
};

const PAYMENT: SupplierPaymentDto = {
  paymentId: '1718e6ea-000e-4a7b-8c9d-0000000py001',
  supplierId: SUPPLIER.supplierId,
  paymentMethodId: METHODS[0]?.paymentMethodId ?? '',
  currency: 'USD',
  amountMinor: '5300',
  baseAmountMinor: '3757',
  rate: { rateId: null, rate: '0.709', source: 'manual', at: '2026-09-27T00:00:00Z' },
  paymentDate: '2026-09-27',
  reference: null,
  allocations: [
    {
      allocationId: '1718e6ea-000e-4a7b-8c9d-0000000al001',
      lineNo: 1,
      purchaseId: PURCHASE_ID,
      paymentCurrency: 'USD',
      paymentAmountMinor: '5300',
      paymentBaseMinor: '3757',
      purchaseCurrency: 'USD',
      purchaseAmountAppliedMinor: '5300',
      apReleasedBeforeTxnMinor: '5300',
      carryingBaseReleasedMinor: '3757',
      apDustBaseMinor: '0',
      realizedFxMinor: '0',
      entryId: '0607d5d9-000d-4a7b-8c9d-0000000je003',
    },
  ],
  createdAt: '2026-09-27T09:00:00Z',
};

const receiveProps = (over: Partial<ReceivePurchaseViewProps>): ReceivePurchaseViewProps => ({
  step: 'edit',
  form: NEW_FORM,
  warehouses: WAREHOUSES,
  currencies: [
    { code: 'JOD', name: 'Jordanian Dinar' },
    { code: 'USD', name: 'US Dollar' },
  ],
  baseCurrency: 'JOD',
  canCreateSupplier: true,
  canReceive: true,
  savedDraft: false,
  review: null,
  payNow: null,
  result: null,
  busy: false,
  errorKey: null,
  exchangeRate: null,
  on: RECEIVE_HANDLERS,
  ...over,
});

const FX_PROMPT: ExchangeRatePromptProps = {
  date: '2026-09-27',
  currency: 'USD',
  baseCurrency: 'JOD',
  canEnter: true,
  rateText: '0.709',
  rateInvalid: false,
  busy: false,
  onRateChange: noop,
  onSubmit: noop,
};

// ── Purchase detail ──────────────────────────────────────────────────────

const DETAIL: PurchaseDetailModel = {
  purchaseId: PURCHASE_ID,
  status: 'received',
  supplierName: SUPPLIER.name,
  warehouseName: 'Main store',
  documentDate: '2026-09-20',
  supplierReference: 'INV-2291',
  notes: 'Two cartons were dented',
  currency: 'USD',
  baseCurrency: 'JOD',
  subtotalTxnMinor: '3800',
  landedCostTxnMinor: '1500',
  totalTxnMinor: '5300',
  rate: '0.709',
  lines: REVIEW.lines,
};

const SETTLEMENTS: PurchaseSettlementsDto = {
  purchaseId: PURCHASE_ID,
  currency: 'USD',
  payments: PAYMENT.allocations.map((a) => ({ ...a, paymentId: PAYMENT.paymentId, paymentDate: PAYMENT.paymentDate })),
  creditAllocations: [
    {
      allocationId: '2829f7fb-000f-4a7b-8c9d-0000000ca001',
      supplierId: SUPPLIER.supplierId,
      creditNoteId: '2829f7fb-000f-4a7b-8c9d-0000000cn001',
      purchaseId: PURCHASE_ID,
      allocationDate: '2026-09-25',
      creditCurrency: 'USD',
      creditAmountConsumedMinor: '500',
      creditRemainingBeforeMinor: '900',
      creditCarryingBaseReleasedMinor: '354',
      creditDustBaseMinor: '0',
      purchaseCurrency: 'USD',
      purchaseAmountAppliedMinor: '500',
      apReleasedBeforeTxnMinor: '5300',
      carryingBaseReleasedMinor: '354',
      apDustBaseMinor: '0',
      realizedFxMinor: '0',
      entryId: '0607d5d9-000d-4a7b-8c9d-0000000je004',
      createdAt: '2026-09-25T10:00:00Z',
    },
  ],
};

const REVERSAL: PurchaseReversalResultDto = {
  purchaseId: PURCHASE_ID,
  warehouseId: WAREHOUSES[0]?.warehouseId ?? '',
  reversalDate: '2026-09-27',
  reason: 'Wrong supplier',
  totalValueBaseMinor: '3757',
  lines: [
    { lineId: LINE_ID_1, productId: OIL.productId, variantId: null, qty: '12.5', valueBaseMinor: '3757', movementId: 'f596c4c8-000c-4a7b-8c9d-0000000mv002' },
  ],
  originalEntryId: '0607d5d9-000d-4a7b-8c9d-0000000je001',
  reversalEntryId: '0607d5d9-000d-4a7b-8c9d-0000000je005',
  createdAt: '2026-09-27T11:00:00Z',
  replayed: false,
  businessTransactionId: 'd374a2a6-000a-4a7b-8c9d-0000000bt002',
};

const detailProps = (over: Partial<PurchaseDetailViewProps>): PurchaseDetailViewProps => ({
  purchase: DETAIL,
  outstandingTxnMinor: '4800',
  returns: [{ returnId: '3930a80c-0010-4a7b-8c9d-0000000rt001', documentDate: '2026-09-22', currency: 'USD', carryingTxnMinor: '640' }],
  settlements: SETTLEMENTS,
  actions: { continueDraft: false, returnToSupplier: true, undoReceipt: false, paySupplier: true },
  undo: { open: false, reason: '', reasonMissing: false, busy: false },
  undone: null,
  errorKey: null,
  on: {
    onContinueDraft: noop,
    onReturn: noop,
    onPay: noop,
    onStartUndo: noop,
    onUndoReason: noop,
    onConfirmUndo: noop,
    onCancelUndo: noop,
    onBack: noop,
  },
  ...over,
});

// ── Return to Supplier ───────────────────────────────────────────────────

const RETURN_LINES: ReturnLineForm[] = [
  {
    purchaseLineId: LINE_ID_1,
    name: 'Olive oil',
    variantName: null,
    unitDecimals: 2,
    purchasedQty: '12.5',
    returnedQty: '2',
    returnableQty: '10.5',
    quantity: '3',
    invalid: false,
  },
  {
    purchaseLineId: LINE_ID_2,
    name: 'Cotton shirt',
    variantName: 'Large',
    unitDecimals: 0,
    purchasedQty: '4',
    returnedQty: '0',
    returnableQty: '1',
    quantity: '1.5',
    invalid: true,
  },
];

const RETURN_RESULT: SupplierReturnResultDto = {
  returnId: '3930a80c-0010-4a7b-8c9d-0000000rt002',
  purchaseId: PURCHASE_ID,
  supplierId: SUPPLIER.supplierId,
  warehouseId: WAREHOUSES[0]?.warehouseId ?? '',
  documentDate: '2026-09-27',
  reason: null,
  currency: 'USD',
  carryingTxnMinor: '960',
  apTxnMinor: '460',
  apBaseMinor: '326',
  creditTxnMinor: '500',
  creditBaseMinor: '354',
  inventoryValueBaseMinor: '680',
  purchasePriceVarianceBaseMinor: '0',
  lines: [
    {
      lineId: '3930a80c-0010-4a7b-8c9d-0000000rl001',
      lineNo: 1,
      purchaseLineId: LINE_ID_1,
      productId: OIL.productId,
      variantId: null,
      qty: '3',
      carryingTxnMinor: '960',
      valueOutBaseMinor: '680',
      movementId: 'f596c4c8-000c-4a7b-8c9d-0000000mv003',
    },
  ],
  creditNote: {
    creditNoteId: '2829f7fb-000f-4a7b-8c9d-0000000cn002',
    supplierId: SUPPLIER.supplierId,
    returnId: '3930a80c-0010-4a7b-8c9d-0000000rt002',
    purchaseId: PURCHASE_ID,
    currency: 'USD',
    originalTxnMinor: '500',
    remainingTxnMinor: '500',
    originalCarryingBaseMinor: '354',
    remainingCarryingBaseMinor: '354',
    rate: { rateId: null, rate: '0.709', source: 'manual', at: '2026-09-20T00:00:00Z' },
    issuedOn: '2026-09-27',
    createdAt: '2026-09-27T12:00:00Z',
  },
  entryId: '0607d5d9-000d-4a7b-8c9d-0000000je006',
  createdAt: '2026-09-27T12:00:00Z',
  replayed: false,
  businessTransactionId: 'd374a2a6-000a-4a7b-8c9d-0000000bt003',
};

const returnProps = (over: Partial<ReturnToSupplierViewProps>): ReturnToSupplierViewProps => ({
  supplierName: SUPPLIER.name,
  documentDateOfPurchase: '2026-09-20',
  blocked: null,
  lines: RETURN_LINES,
  documentDate: '2026-09-27',
  reason: '',
  nothingChosen: false,
  busy: false,
  errorKey: null,
  result: null,
  on: { onQuantity: noop, onReturnAll: noop, onDate: noop, onReason: noop, onSubmit: noop, onBack: noop },
  ...over,
});

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('PurchaseListView', PurchaseListView, {
    'mixed statuses, more to load': listProps({}),
    'empty, no permission to receive': listProps({ rows: [], canReceive: false, hasMore: false, filter: 'draft' }),
    'load refused': listProps({ errorKey: 'error.FORBIDDEN', hasMore: false }),
  }),
  defineView('ReceivePurchaseView', ReceivePurchaseView, {
    'new form, supplier and item search': receiveProps({}),
    'new supplier with a duplicate-name hint': receiveProps({
      form: { ...NEW_FORM, newSupplierName: 'Al-Noor Trading', duplicateOf: 'Al-Noor Trading', errors: { lines: true } },
    }),
    'foreign currency, discount, extra costs split manually, field errors': receiveProps({ form: FILLED_FORM, savedDraft: true }),
    'review, paid now in the purchase currency': receiveProps({
      step: 'review',
      form: FILLED_FORM,
      savedDraft: true,
      review: REVIEW,
      payNow: {
        on: true,
        methods: METHODS,
        methodId: METHODS[1]?.paymentMethodId ?? '',
        currencyOptions: ['USD', 'JOD'],
        payCurrency: 'USD',
        amount: '53.00',
        applied: '',
        reference: '',
        errors: { reference: true },
      },
    }),
    'review, paid now in the business currency': receiveProps({
      step: 'review',
      form: FILLED_FORM,
      savedDraft: true,
      review: REVIEW,
      payNow: {
        on: true,
        methods: METHODS,
        methodId: METHODS[0]?.paymentMethodId ?? '',
        currencyOptions: ['USD', 'JOD'],
        payCurrency: 'JOD',
        amount: '37.570',
        applied: '53.00',
        reference: '',
        errors: {},
      },
    }),
    'review without permission to receive, no method yet': receiveProps({
      step: 'review',
      form: FILLED_FORM,
      review: REVIEW,
      canReceive: false,
      payNow: { on: true, methods: [], methodId: '', currencyOptions: ['USD'], payCurrency: 'USD', amount: '', applied: '', reference: '', errors: {} },
    }),
    'missing exchange rate, owner can enter it': receiveProps({
      step: 'review',
      form: FILLED_FORM,
      review: REVIEW,
      errorKey: 'error.purchase.fx_rate_missing',
      exchangeRate: FX_PROMPT,
    }),
    'missing exchange rate, ask the owner': receiveProps({
      step: 'review',
      form: FILLED_FORM,
      review: REVIEW,
      exchangeRate: { ...FX_PROMPT, canEnter: false, rateText: '' },
    }),
    'received and paid, foreign, covered short stock': receiveProps({
      step: 'done',
      form: FILLED_FORM,
      result: { receipt: RECEIPT, payment: PAYMENT, baseCurrency: 'JOD' },
    }),
    'received in the business currency': receiveProps({
      step: 'done',
      form: NEW_FORM,
      result: { receipt: { ...RECEIPT, currency: 'JOD', coverage: null }, payment: null, baseCurrency: 'JOD' },
    }),
  }),
  defineView('PurchaseDetailView', PurchaseDetailView, {
    'received, part paid, returns and settlements': detailProps({}),
    'received, undo receipt offered and open': detailProps({
      actions: { continueDraft: false, returnToSupplier: true, undoReceipt: true, paySupplier: false },
      undo: { open: true, reason: '', reasonMissing: true, busy: false },
      settlements: null,
      returns: [],
    }),
    'draft, no settlements permission': detailProps({
      purchase: { ...DETAIL, status: 'draft', rate: null, currency: 'JOD', landedCostTxnMinor: '0', notes: null, supplierReference: null },
      outstandingTxnMinor: null,
      returns: [],
      settlements: null,
      actions: { continueDraft: true, returnToSupplier: false, undoReceipt: false, paySupplier: false },
    }),
    'receipt undone': detailProps({
      purchase: { ...DETAIL, status: 'reversed' },
      outstandingTxnMinor: null,
      undone: REVERSAL,
      actions: { continueDraft: false, returnToSupplier: false, undoReceipt: false, paySupplier: false },
    }),
  }),
  defineView('ReturnToSupplierView', ReturnToSupplierView, {
    'quantities, one invalid': returnProps({ nothingChosen: true, errorKey: 'error.supplier_return.quantity_exceeds_purchased' }),
    'blocked: supplier inactive': returnProps({ blocked: 'supplier_inactive' }),
    'blocked: nothing left': returnProps({ blocked: 'nothing_left' }),
    'blocked: not received': returnProps({ blocked: 'not_received' }),
    'blocked: reversed': returnProps({ blocked: 'reversed' }),
    'returned: credit and balance down': returnProps({ result: RETURN_RESULT }),
    'returned: balance down only': returnProps({ result: { ...RETURN_RESULT, creditNote: null, creditTxnMinor: '0', creditBaseMinor: '0' } }),
  }),
];
