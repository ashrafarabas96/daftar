/**
 * The supplier views and the fixtures the SSR suites render them with (P3-S7
 * contract §4.3, §6: T-08, T-15, T-16).
 *
 * The fixtures carry, deliberately, what a real answer carries and the
 * merchant must never read: a method's `postingAccountId` (returned to
 * accounting roles, S6 A-18), trace ids and entry ids. T-08 proves no render
 * emits one.
 */
import type { PaymentMethodDto, SupplierPaymentDto, SupplierPaymentResultDto, SupplierRefundResultDto } from '@daftar/shared-contracts';
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import type { PurchaseRowModel } from '../purchases/types';
import { PaySupplierView, type PaySupplierViewProps } from './PaySupplierView';
import { SupplierDetailView, type SupplierDetailViewProps } from './SupplierDetailView';
import { SupplierListView, type SupplierListViewProps } from './SupplierListView';
import type { FavourNoteModel, MoneyBackForm, OpenPurchaseRowModel, PayRowModel } from './types';

const noop = (): void => undefined;

const SUPPLIER_ID = '5b0c1a2e-0001-4a7b-8c9d-00000000s001';

const METHODS: PaymentMethodDto[] = [
  {
    paymentMethodId: 'a0416f73-0006-4a7b-8c9d-00000000m011',
    systemType: 'bank_transfer',
    postingAccountId: 'acc0acc0-0007-4a7b-8c9d-0000000pa011',
    isActive: true,
    requiresReference: true,
    sortOrder: 2,
    names: { ar: 'تحويل بنكي', en: 'Bank transfer', tr: 'Havale' },
    revision: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
  {
    paymentMethodId: 'a0416f73-0006-4a7b-8c9d-00000000m012',
    systemType: 'cash',
    postingAccountId: 'acc0acc0-0007-4a7b-8c9d-0000000pa012',
    isActive: true,
    requiresReference: false,
    sortOrder: 1,
    names: { ar: null, en: null, tr: null },
    revision: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
  {
    paymentMethodId: 'a0416f73-0006-4a7b-8c9d-00000000m013',
    systemType: 'card',
    postingAccountId: 'acc0acc0-0007-4a7b-8c9d-0000000pa013',
    isActive: false,
    requiresReference: false,
    sortOrder: 3,
    names: { ar: 'بطاقة قديمة', en: 'Old card', tr: 'Eski kart' },
    revision: 3,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-03T08:00:00Z',
  },
];

// ── Supplier list ────────────────────────────────────────────────────────

const listProps = (over: Partial<SupplierListViewProps>): SupplierListViewProps => ({
  withBalances: true,
  rows: [
    {
      supplierId: SUPPLIER_ID,
      name: 'Al-Noor Trading',
      status: 'active',
      owed: [
        { currency: 'JOD', amountMinor: '152500' },
        { currency: 'USD', amountMinor: '4800' },
      ],
      inYourFavour: [{ currency: 'USD', amountMinor: '500' }],
    },
    { supplierId: '5b0c1a2e-0001-4a7b-8c9d-00000000s002', name: 'Bosphorus Textiles', status: 'inactive', owed: [], inYourFavour: [] },
    {
      supplierId: '5b0c1a2e-0001-4a7b-8c9d-00000000s003',
      name: 'Alpha Foods',
      status: 'active',
      owed: [{ currency: 'JOD', amountMinor: '7' }],
      inYourFavour: [],
    },
  ],
  search: '',
  owedOnly: false,
  hasMore: true,
  loadingMore: false,
  errorKey: null,
  on: { onSearch: noop, onOwedOnly: noop, onOpen: noop, onLoadMore: noop },
  ...over,
});

// ── Supplier detail ──────────────────────────────────────────────────────

const OPEN_OLD: OpenPurchaseRowModel = {
  purchaseId: '7d1e3c40-0003-4a7b-8c9d-00000000p001',
  documentDate: '2026-08-14',
  supplierReference: 'INV-2102',
  currency: 'JOD',
  totalTxnMinor: '100000',
  outstandingTxnMinor: '40000',
};
const OPEN_NEW: OpenPurchaseRowModel = {
  purchaseId: '7d1e3c40-0003-4a7b-8c9d-00000000p002',
  documentDate: '2026-09-20',
  supplierReference: null,
  currency: 'JOD',
  totalTxnMinor: '112500',
  outstandingTxnMinor: '112500',
};
const OPEN_USD: OpenPurchaseRowModel = {
  purchaseId: '7d1e3c40-0003-4a7b-8c9d-00000000p003',
  documentDate: '2026-09-21',
  supplierReference: null,
  currency: 'USD',
  totalTxnMinor: '5300',
  outstandingTxnMinor: '4800',
};
const OPEN: OpenPurchaseRowModel[] = [OPEN_OLD, OPEN_NEW, OPEN_USD];

const NOTES: FavourNoteModel[] = [
  { creditNoteId: '2829f7fb-000f-4a7b-8c9d-0000000cn001', issuedOn: '2026-09-22', currency: 'USD', remainingTxnMinor: '500' },
  { creditNoteId: '2829f7fb-000f-4a7b-8c9d-0000000cn002', issuedOn: '2026-09-24', currency: 'JOD', remainingTxnMinor: '2500' },
];

const PAYMENT: SupplierPaymentDto = {
  paymentId: '1718e6ea-000e-4a7b-8c9d-0000000py001',
  supplierId: SUPPLIER_ID,
  paymentMethodId: 'a0416f73-0006-4a7b-8c9d-00000000m011',
  currency: 'JOD',
  amountMinor: '60000',
  baseAmountMinor: '60000',
  rate: { rateId: null, rate: '1', source: 'base', at: '2026-09-01T00:00:00Z' },
  paymentDate: '2026-09-01',
  reference: 'TRX-5561',
  allocations: [
    {
      allocationId: '1718e6ea-000e-4a7b-8c9d-0000000al001',
      lineNo: 1,
      purchaseId: '7d1e3c40-0003-4a7b-8c9d-00000000p001',
      paymentCurrency: 'JOD',
      paymentAmountMinor: '60000',
      paymentBaseMinor: '60000',
      purchaseCurrency: 'JOD',
      purchaseAmountAppliedMinor: '60000',
      apReleasedBeforeTxnMinor: '100000',
      carryingBaseReleasedMinor: '60000',
      apDustBaseMinor: '0',
      realizedFxMinor: '0',
      entryId: '0607d5d9-000d-4a7b-8c9d-0000000je011',
    },
  ],
  createdAt: '2026-09-01T09:00:00Z',
};
const PAYMENTS: SupplierPaymentDto[] = [PAYMENT];

const PURCHASES: PurchaseRowModel[] = [
  {
    purchaseId: '7d1e3c40-0003-4a7b-8c9d-00000000p002',
    supplierName: 'Al-Noor Trading',
    warehouseName: 'Main store',
    documentDate: '2026-09-20',
    supplierReference: null,
    status: 'received',
    currency: 'JOD',
    totalTxnMinor: '112500',
  },
];

const REFUND: SupplierRefundResultDto = {
  refundId: '4a41b91d-0011-4a7b-8c9d-0000000rf001',
  supplierId: SUPPLIER_ID,
  creditNoteId: NOTES[0]?.creditNoteId ?? '',
  paymentMethodId: 'a0416f73-0006-4a7b-8c9d-00000000m012',
  refundDate: '2026-09-27',
  reference: null,
  sourceCurrency: 'USD',
  sourceAmountConsumedMinor: '500',
  creditRemainingBeforeMinor: '500',
  sourceCarryingBaseReleasedMinor: '354',
  sourceDustBaseMinor: '0',
  receiptCurrency: 'JOD',
  receiptAmountMinor: '355',
  receiptBaseMinor: '355',
  rate: { rateId: null, rate: '0.709', source: 'manual', at: '2026-09-27T00:00:00Z' },
  realizedFxMinor: '1',
  entryId: '0607d5d9-000d-4a7b-8c9d-0000000je012',
  createdAt: '2026-09-27T13:00:00Z',
  replayed: false,
  businessTransactionId: 'd374a2a6-000a-4a7b-8c9d-0000000bt011',
};

const MONEY_BACK: MoneyBackForm = {
  open: true,
  notes: NOTES,
  creditNoteId: NOTES[0]?.creditNoteId ?? '',
  methods: METHODS,
  methodId: METHODS[0]?.paymentMethodId ?? '',
  amount: '5.00',
  date: '2026-09-27',
  differentCurrency: true,
  currencies: ['USD', 'JOD'],
  receiptCurrency: 'JOD',
  receiptAmount: '',
  reference: '',
  errors: { receiptAmount: true, reference: true },
  busy: false,
  done: null,
};

const detailProps = (over: Partial<SupplierDetailViewProps>): SupplierDetailViewProps => ({
  supplier: { supplierId: SUPPLIER_ID, name: 'Al-Noor Trading', status: 'active', phone: '+962 7 9555 0101', email: 'sales@alnoor.example' },
  owed: [
    { currency: 'JOD', amountMinor: '152500' },
    { currency: 'USD', amountMinor: '4800' },
  ],
  favourNotes: NOTES,
  payments: PAYMENTS,
  openPurchases: OPEN,
  purchases: PURCHASES,
  canPay: true,
  moneyBack: { ...MONEY_BACK, open: false },
  errorKey: null,
  on: {
    onPay: noop,
    onOpenPurchase: noop,
    onStartMoneyBack: noop,
    onMoneyBackField: noop,
    onToggleDifferentCurrency: noop,
    onSubmitMoneyBack: noop,
    onCancelMoneyBack: noop,
    onBack: noop,
  },
  ...over,
});

// ── Pay Supplier ─────────────────────────────────────────────────────────

const PROPOSED_ROWS: PayRowModel[] = [
  { ...OPEN_OLD, proposedMinor: '40000', amount: '400.000', applied: '', invalid: false },
  { ...OPEN_NEW, proposedMinor: '10000', amount: '100.000', applied: '', invalid: false },
  { ...OPEN_USD, proposedMinor: null, amount: '', applied: '', invalid: false },
];

const PAY_RESULT: SupplierPaymentResultDto = { ...PAYMENT, replayed: false, businessTransactionId: 'd374a2a6-000a-4a7b-8c9d-0000000bt012' };

const payProps = (over: Partial<PaySupplierViewProps>): PaySupplierViewProps => ({
  supplier: { name: 'Al-Noor Trading', status: 'active' },
  methods: METHODS,
  setup: null,
  form: {
    methodId: METHODS[0]?.paymentMethodId ?? '',
    currency: 'JOD',
    currencyOptions: ['JOD', 'USD'],
    amount: '500',
    date: '2026-09-27',
    reference: 'TRX-5570',
    manual: false,
    errors: {},
  },
  rows: PROPOSED_ROWS,
  proposed: true,
  unallocatedMinor: '0',
  busy: false,
  errorKey: null,
  exchangeRate: null,
  result: null,
  favour: { notes: NOTES, use: null },
  on: {
    onField: noop,
    onPropose: noop,
    onToggleManual: noop,
    onRowAmount: noop,
    onRowApplied: noop,
    onSubmit: noop,
    onChooseSetup: noop,
    onCreateMethod: noop,
    onUseFavour: noop,
    onApplyFavour: noop,
    onCancelFavour: noop,
    onDone: noop,
  },
  ...over,
});

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('SupplierListView', SupplierListView, {
    'business-wide, with balances': listProps({}),
    'assigned scope, plain list': listProps({
      withBalances: false,
      hasMore: false,
      rows: [{ supplierId: SUPPLIER_ID, name: 'Al-Noor Trading', status: 'active', owed: null, inYourFavour: null }],
    }),
    'search finds nothing': listProps({ rows: [], search: 'zz', hasMore: false, owedOnly: true }),
    'no suppliers yet, load refused': listProps({ rows: [], hasMore: false, errorKey: 'error.inventory.business_wide_scope_required' }),
  }),
  defineView('SupplierDetailView', SupplierDetailView, {
    'business-wide, owes and in your favour': detailProps({}),
    'get money back, received in another currency': detailProps({ moneyBack: MONEY_BACK }),
    'got money back': detailProps({ moneyBack: { ...MONEY_BACK, done: REFUND } }),
    'assigned scope': detailProps({ owed: null, favourNotes: null, payments: null, moneyBack: null, canPay: false }),
    'inactive, nothing open': detailProps({
      supplier: { supplierId: SUPPLIER_ID, name: 'Bosphorus Textiles', status: 'inactive', phone: null, email: null },
      owed: [],
      favourNotes: [],
      payments: [],
      openPurchases: [],
      purchases: [],
      canPay: false,
      moneyBack: null,
    }),
  }),
  defineView('PaySupplierView', PaySupplierView, {
    'proposal, other-currency purchase not paid': payProps({}),
    'before the proposal': payProps({ proposed: false, unallocatedMinor: null, rows: PROPOSED_ROWS.map((r) => ({ ...r, proposedMinor: null })) }),
    'amount larger than what is owed': payProps({ unallocatedMinor: '2500' }),
    'split changed, another currency': payProps({
      form: {
        methodId: METHODS[0]?.paymentMethodId ?? '',
        currency: 'JOD',
        currencyOptions: ['JOD', 'USD'],
        amount: '500',
        date: '2026-09-27',
        reference: '',
        manual: true,
        errors: { reference: true, rows: true },
      },
      rows: PROPOSED_ROWS.map((r, i) => (i === 2 ? { ...r, amount: '34.030', applied: '', invalid: true } : r)),
      errorKey: 'error.supplier_payment.residue_below_base_unit',
    }),
    'missing exchange rate': payProps({
      exchangeRate: {
        date: '2026-09-27',
        currency: 'USD',
        baseCurrency: 'JOD',
        canEnter: false,
        rateText: '',
        rateInvalid: false,
        busy: false,
        onRateChange: noop,
        onSubmit: noop,
      },
    }),
    'first way to pay, owner chooses the kind': payProps({
      methods: [],
      setup: {
        mode: 'choose',
        options: [
          { systemType: 'cash', available: true },
          { systemType: 'card', available: false },
          { systemType: 'bank_transfer', available: true },
          { systemType: 'wallet', available: true },
          { systemType: 'cheque', available: true },
        ],
        chosen: 'cash',
        busy: false,
      },
      favour: null,
    }),
    'no way to pay, ask the owner': payProps({ methods: [], setup: { mode: 'ask_owner', options: [], chosen: null, busy: false }, favour: null }),
    'balance in your favour, proposal to use it': payProps({
      favour: {
        notes: NOTES,
        use: {
          creditNoteId: NOTES[1]?.creditNoteId ?? '',
          currency: 'JOD',
          rows: [{ purchaseId: '7d1e3c40-0003-4a7b-8c9d-00000000p001', documentDate: '2026-08-14', proposedMinor: '2500' }],
          unallocatedMinor: '0',
          busy: false,
          done: false,
        },
      },
    }),
    'balance in your favour used': payProps({
      favour: { notes: NOTES, use: { creditNoteId: NOTES[1]?.creditNoteId ?? '', currency: 'JOD', rows: [], unallocatedMinor: '0', busy: false, done: true } },
    }),
    'inactive supplier, paid': payProps({ supplier: { name: 'Al-Noor Trading', status: 'inactive' }, result: PAY_RESULT }),
  }),
];
