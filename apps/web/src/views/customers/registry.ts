/**
 * The customer views and the fixtures the SSR suites render them with, in the
 * shape of `suppliers/registry.ts`.
 *
 * Every fixture is a state the page can reach:
 *
 * - each `errorKey` is one `refusalKey` produces for an answer this page can
 *   receive (a receivables refusal carries `details.receivablesCode`; a 403 is
 *   `error.FORBIDDEN`; no answer at all is `error.fallback`) — asserted in
 *   `test/collect-payment-screens.test.tsx`;
 * - `surplus` is not written by hand: it is `surplusOf` of the fixture's own
 *   form and rows, exactly as the page derives it;
 * - a refused fixture keeps the figures typed, because the page's catch sets
 *   the refusal and touches nothing else;
 * - a 403 on LOAD renders `PageStateView` and never reaches this view, so it
 *   has no fixture here.
 */
import type { CustomerPaymentResultDto, PaymentMethodDto } from '@daftar/shared-contracts';
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import { CollectPaymentView, type CollectPaymentViewProps } from './CollectPaymentView';
import { surplusOf, type CollectFormModel, type CollectRowModel } from './collect-payment';

const noop = (): void => undefined;

/** The one customer every fixture is about; named so the od03 slice rule can admit it by name. */
const FIXTURE_CUSTOMER_ID = '7c1f0a52-3b7e-4d0a-9a53-0f2b6f1c7a01';

const METHODS: PaymentMethodDto[] = [
  {
    paymentMethodId: 'c0416f73-0006-4a7b-8c9d-000000000c01',
    systemType: 'cash',
    postingAccountId: 'acc0acc0-0007-4a7b-8c9d-0000000pc001',
    isActive: true,
    requiresReference: false,
    sortOrder: 1,
    names: { ar: null, en: null, tr: null },
    revision: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
  {
    paymentMethodId: 'c0416f73-0006-4a7b-8c9d-000000000c02',
    systemType: 'bank_transfer',
    postingAccountId: 'acc0acc0-0007-4a7b-8c9d-0000000pc002',
    isActive: true,
    requiresReference: true,
    sortOrder: 2,
    names: { ar: 'تحويل بنكي', en: 'Bank transfer', tr: 'Havale' },
    revision: 1,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-01T08:00:00Z',
  },
];

const row = (over: Partial<CollectRowModel> & Pick<CollectRowModel, 'invoiceId' | 'documentNumber'>): CollectRowModel => ({
  documentKind: 'invoice',
  issueDate: '2026-09-14',
  dueDate: '2026-10-14',
  currency: 'ILS',
  totalTxnMinor: '20000',
  outstandingTxnMinor: '15000',
  outstandingBaseMinor: '15000',
  settlementState: 'partial',
  daysPastDue: 30,
  hasExplicitDueDate: true,
  ageDays: 60,
  isCredit: false,
  amount: '',
  invalid: false,
  ...over,
});

const OLDEST = row({ invoiceId: '9f0e1d2c-0001-4b3a-8c9d-000000000001', documentNumber: 'INV-0007' });
const DOLLARS = row({
  invoiceId: '9f0e1d2c-0002-4b3a-8c9d-000000000002',
  documentNumber: 'INV-0009',
  issueDate: '2026-10-02',
  currency: 'USD',
  totalTxnMinor: '4000',
  outstandingTxnMinor: '4000',
  outstandingBaseMinor: '14800',
  settlementState: 'unpaid',
});
const BALANCE = row({
  invoiceId: '9f0e1d2c-0003-4b3a-8c9d-000000000003',
  documentKind: 'credit_note',
  documentNumber: 'CN-0002',
  issueDate: '2026-10-20',
  dueDate: null,
  totalTxnMinor: '-2500',
  outstandingTxnMinor: '-2500',
  outstandingBaseMinor: '-2500',
  settlementState: 'unpaid',
  daysPastDue: 0,
  hasExplicitDueDate: false,
  ageDays: 24,
  isCredit: true,
});
const NEWER = row({
  invoiceId: '9f0e1d2c-0004-4b3a-8c9d-000000000004',
  documentNumber: 'INV-0012',
  issueDate: '2026-10-28',
  totalTxnMinor: '5000',
  outstandingTxnMinor: '5000',
  outstandingBaseMinor: '5000',
  settlementState: 'unpaid',
});

const form = (over: Partial<CollectFormModel> = {}): CollectFormModel => ({
  methodId: METHODS[0]?.paymentMethodId ?? '',
  currency: 'ILS',
  currencyOptions: ['ILS', 'USD'],
  amount: '',
  date: '2026-11-13',
  reference: '',
  errors: {},
  ...over,
});

const view = (over: Partial<Omit<CollectPaymentViewProps, 'surplus'>> = {}): CollectPaymentViewProps => {
  const f = over.form ?? form();
  const rows = over.rows ?? [OLDEST, DOLLARS, BALANCE];
  return {
    customer: { name: 'Zaytoun Grocery', status: 'active' },
    methods: METHODS,
    hasMore: false,
    loadingMore: false,
    busy: false,
    errorKey: null,
    result: null,
    on: { onField: noop, onRowAmount: noop, onLoadMore: noop, onSubmit: noop, onStartOver: noop },
    ...over,
    form: f,
    rows,
    surplus: surplusOf(f, rows),
  };
};

const TYPED_OVER_DUE = { form: form({ amount: '150.00' }), rows: [{ ...OLDEST, amount: '150.00' }, NEWER, DOLLARS] };

const SAVED: CustomerPaymentResultDto = {
  paymentId: '5e1d0c9b-0001-4a7b-8c9d-0000000000p1',
  customerId: FIXTURE_CUSTOMER_ID,
  paymentMethodId: METHODS[0]?.paymentMethodId ?? '',
  paymentDate: '2026-11-13',
  currencyCode: 'ILS',
  amountMinor: '125000',
  reference: null,
  allocations: [
    {
      allocationId: '5e1d0c9b-0002-4a7b-8c9d-0000000000a1',
      lineNo: 1,
      invoiceId: OLDEST.invoiceId,
      invoiceCurrencyCode: 'ILS',
      paymentAmountMinor: '100000',
      invoiceAmountAppliedMinor: '100000',
    },
  ],
  credit: {
    creditId: '5e1d0c9b-0003-4a7b-8c9d-0000000000c1',
    customerId: FIXTURE_CUSTOMER_ID,
    currencyCode: 'ILS',
    originalAmountMinor: '25000',
    remainingAmountMinor: '25000',
    remainingCarryingBaseAmountMinor: '25000',
    creditDate: '2026-11-13',
  },
  replayed: false,
};

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('CollectPaymentView', CollectPaymentView, {
    'fresh form, three open invoices': view(),
    'inactive customer': view({ customer: { name: 'Al-Amal Pharmacy', status: 'inactive' } }),
    'no way to receive money is set up': view({ methods: [], form: form({ methodId: '' }) }),
    'partial: the rest is held for the customer': view({ form: form({ amount: '200.00' }), rows: [{ ...OLDEST, amount: '150' }, NEWER] }),
    'exact: the invoices take it all': view({
      form: form({ amount: '200.00' }),
      rows: [
        { ...OLDEST, amount: '150' },
        { ...NEWER, amount: '50' },
      ],
    }),
    'over: the invoices take more than was received': view({ form: form({ amount: '100.00' }), rows: [{ ...OLDEST, amount: '150' }, NEWER] }),
    'no open invoices': view({ form: form({ amount: '80.00', currencyOptions: ['ILS'] }), rows: [] }),
    'an invoice amount is not valid': view({
      form: form({ amount: '200.00', errors: { rows: true } }),
      rows: [{ ...OLDEST, amount: '1.2.5', invalid: true }, NEWER],
    }),
    'more invoices to show': view({ hasMore: true }),
    sending: view({ ...TYPED_OVER_DUE, busy: true }),
    'refused: more than is still due, figures kept': view({ ...TYPED_OVER_DUE, errorKey: 'error.customer_payment.amount_exceeds_outstanding' }),
    'refused twice: another payment was recorded first': view({ ...TYPED_OVER_DUE, errorKey: 'error.customer_payment.settlement_changed' }),
    'refused: the invoices and amounts are not valid': view({ ...TYPED_OVER_DUE, errorKey: 'error.customer_payment.allocations_invalid' }),
    'refused: no permission to receive payments': view({ ...TYPED_OVER_DUE, errorKey: 'error.FORBIDDEN' }),
    'refused: already sent with other figures': view({ ...TYPED_OVER_DUE, errorKey: 'error.customer_payment.idempotency_conflict' }),
    'no answer: the figures are kept for a retry': view({ ...TYPED_OVER_DUE, errorKey: 'error.fallback' }),
    'server failure: the figures are kept for a retry': view({ ...TYPED_OVER_DUE, errorKey: 'error.INTERNAL_ERROR' }),
    'saved, with the rest held for the customer': view({ result: SAVED }),
    'saved earlier: the same payment sent again': view({ result: { ...SAVED, credit: null, amountMinor: '100000', replayed: true } }),
    'saved, held for the customer in full': view({ result: { ...SAVED, allocations: [], amountMinor: '25000' } }),
  }),
];
