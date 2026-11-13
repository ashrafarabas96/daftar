/**
 * The customer account view and its fixtures (MVP-02). Kept apart from
 * `registry.ts` so the customers area's one registry file only lists entries,
 * and the customers LIST screen (another PR) can add its own beside this one.
 *
 * Every fixture is a state the page can reach — the page renders this view only
 * once all five reads have landed AND passed `unreadableAccount`, so a refused
 * or unreadable answer is `ScreenState`, never a fixture here:
 *  - owing in one currency, oldest invoice first, a further page, one exhausted
 *    held amount (`"0"`, which the view leaves out);
 *  - a NEGATIVE balance with nothing held: the ledger reader has no zero floor
 *    (L3 contract note §6), so the screen must not assume one, and the held-money
 *    section must not appear just because the sign is negative;
 *  - two currencies, with held amounts in two currencies;
 *  - nothing owed and nothing open;
 *  - an amount beyond 2^53, which a JS number would round;
 *  - "show more" refused with the rows still on screen (the key is one
 *    `refusalKey` really returns for a 403);
 *  - the held-amounts read returning its full 200 rows.
 *
 * The figures inside one fixture are made to agree with each other (the bands
 * add up to the balance), but that is a courtesy to the reader and nothing
 * the view relies on: it shows each figure as given and adds none.
 */
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import type { CustomerAgingDto } from '@/lib/phase4-customer-account-api';
import { CustomerAccountView, type CustomerAccountViewProps } from './CustomerAccountView';

const noop = (): void => undefined;
const AS_OF = '2026-11-13';

type Bucket = CustomerAgingDto['buckets'][number];
type Invoice = CustomerAccountViewProps['openInvoices'][number];
type Credit = CustomerAccountViewProps['credits'][number];

/** The five bands of the 0,30,60,90 set, as `foldCustomerAging` shapes them. */
function bands(base: Readonly<Record<string, string>>, lines: Readonly<Record<string, Bucket['byCurrency']>> = {}): Bucket[] {
  const shape: [string, number | null, number | null][] = [
    ['not-due', null, 0],
    ['1-30', 1, 30],
    ['31-60', 31, 60],
    ['61-90', 61, 90],
    ['over-90', 91, null],
  ];
  return shape.map(([label, fromDays, toDays]) => ({
    label,
    fromDays,
    toDays,
    baseMinor: base[label] ?? '0',
    byCurrency: lines[label] ?? [],
    invoiceCount: base[label] !== undefined && base[label] !== '0' ? 1 : 0,
  }));
}

const invoice = (
  over: Partial<Invoice> & Pick<Invoice, 'invoiceId' | 'documentNumber' | 'issueDate' | 'outstandingTxnMinor' | 'totalTxnMinor' | 'daysPastDue' | 'ageDays'>,
): Invoice => ({
  documentKind: 'invoice',
  dueDate: null,
  currency: 'ILS',
  outstandingBaseMinor: over.outstandingTxnMinor,
  settlementState: 'unpaid',
  hasExplicitDueDate: over.dueDate !== undefined && over.dueDate !== null,
  isCredit: false,
  ...over,
});

const credit = (creditId: string, currencyCode: string, remainingAmountMinor: string, creditDate: string): Credit => ({
  creditId,
  currencyCode,
  originalAmountMinor: remainingAmountMinor === '0' ? '20000' : remainingAmountMinor,
  remainingAmountMinor,
  remainingCarryingBaseAmountMinor: remainingAmountMinor,
  creditDate,
});

/** Oldest first, as the server orders them: one each side of every day-count boundary, and one with no due date. */
const OWING_INVOICES: Invoice[] = [
  invoice({
    invoiceId: '7a1c0e10-0001-4000-8000-00000000a001',
    documentNumber: 'INV-0007',
    issueDate: '2026-09-14',
    dueDate: '2026-09-29',
    totalTxnMinor: '450000',
    outstandingTxnMinor: '300000',
    settlementState: 'partial',
    daysPastDue: 45,
    ageDays: 60,
  }),
  invoice({
    invoiceId: '7a1c0e10-0001-4000-8000-00000000a002',
    documentNumber: 'INV-0011',
    issueDate: '2026-10-13',
    totalTxnMinor: '12500',
    outstandingTxnMinor: '12500',
    daysPastDue: 31,
    ageDays: 31,
  }),
  invoice({
    invoiceId: '7a1c0e10-0001-4000-8000-00000000a003',
    documentNumber: 'INV-0015',
    issueDate: '2026-10-28',
    dueDate: '2026-11-12',
    totalTxnMinor: '50000',
    outstandingTxnMinor: '50000',
    daysPastDue: 1,
    ageDays: 16,
  }),
  invoice({
    invoiceId: '7a1c0e10-0001-4000-8000-00000000a004',
    documentNumber: 'INV-0018',
    issueDate: '2026-11-05',
    dueDate: '2026-11-13',
    totalTxnMinor: '70000',
    outstandingTxnMinor: '70000',
    daysPastDue: 0,
    ageDays: 8,
  }),
  invoice({
    invoiceId: '7a1c0e10-0001-4000-8000-00000000a005',
    documentNumber: 'INV-0020',
    issueDate: '2026-11-10',
    dueDate: '2026-11-14',
    totalTxnMinor: '50000',
    outstandingTxnMinor: '50000',
    daysPastDue: -1,
    ageDays: 3,
  }),
];

const account = (over: Partial<CustomerAccountViewProps>): CustomerAccountViewProps => ({
  customer: { name: 'Zaytoun Grocery', status: 'active' },
  receivable: { baseMinor: '482500', baseCurrency: 'ILS', byCurrency: [{ currency: 'ILS', txnMinor: '482500' }] },
  aging: { asOf: AS_OF, baseCurrency: 'ILS', buckets: bands({ 'not-due': '120000', '1-30': '50000', '31-60': '312500' }) },
  openInvoices: OWING_INVOICES,
  credits: [credit('c4ed1700-0001-4000-8000-00000000c001', 'ILS', '0', '2026-10-01')],
  creditsCapped: false,
  hasMore: true,
  loadingMore: false,
  errorKey: null,
  onLoadMore: noop,
  ...over,
});

const HELD = account({
  customer: { name: 'مخبز النور', status: 'active' },
  receivable: { baseMinor: '-25000', baseCurrency: 'ILS', byCurrency: [{ currency: 'ILS', txnMinor: '-25000' }] },
  aging: { asOf: AS_OF, baseCurrency: 'ILS', buckets: bands({ 'not-due': '-25000' }, { 'not-due': [{ currency: 'ILS', txnMinor: '-25000' }] }) },
  openInvoices: [
    invoice({
      invoiceId: '7a1c0e10-0002-4000-8000-00000000b001',
      documentNumber: 'INV-0021',
      issueDate: '2026-11-01',
      totalTxnMinor: '100000',
      outstandingTxnMinor: '-25000',
      settlementState: 'paid',
      daysPastDue: 0,
      ageDays: 12,
      isCredit: true,
    }),
  ],
  credits: [],
  hasMore: false,
});

const MULTI = account({
  customer: { name: 'Al-Amal Pharmacy', status: 'inactive' },
  receivable: {
    baseMinor: '1234500',
    baseCurrency: 'ILS',
    byCurrency: [
      { currency: 'ILS', txnMinor: '500000' },
      { currency: 'USD', txnMinor: '200000' },
    ],
  },
  aging: {
    asOf: AS_OF,
    baseCurrency: 'ILS',
    buckets: bands(
      { 'not-due': '500000', '1-30': '734500' },
      { 'not-due': [{ currency: 'ILS', txnMinor: '500000' }], '1-30': [{ currency: 'USD', txnMinor: '200000' }] },
    ),
  },
  openInvoices: [
    invoice({
      invoiceId: '7a1c0e10-0003-4000-8000-00000000c101',
      documentNumber: 'INV-0031',
      issueDate: '2026-10-20',
      dueDate: '2026-11-03',
      currency: 'USD',
      totalTxnMinor: '200000',
      outstandingTxnMinor: '200000',
      outstandingBaseMinor: '734500',
      daysPastDue: 10,
      ageDays: 24,
    }),
    invoice({
      invoiceId: '7a1c0e10-0003-4000-8000-00000000c102',
      documentNumber: 'INV-0034',
      issueDate: '2026-11-08',
      dueDate: '2026-11-18',
      totalTxnMinor: '500000',
      outstandingTxnMinor: '500000',
      daysPastDue: -5,
      ageDays: 5,
    }),
  ],
  credits: [
    credit('c4ed1700-0003-4000-8000-00000000c301', 'USD', '2500', '2026-11-09'),
    credit('c4ed1700-0003-4000-8000-00000000c302', 'ILS', '15000', '2026-11-02'),
  ],
  hasMore: false,
});

const ZERO = account({
  customer: { name: 'Bayt Hanan', status: 'active' },
  receivable: { baseMinor: '0', baseCurrency: 'ILS', byCurrency: [] },
  aging: { asOf: AS_OF, baseCurrency: 'ILS', buckets: bands({}) },
  openInvoices: [],
  credits: [],
  hasMore: false,
});

const HUGE = account({
  receivable: { baseMinor: '9007199254740993', baseCurrency: 'ILS', byCurrency: [{ currency: 'ILS', txnMinor: '9007199254740993' }] },
  aging: { asOf: AS_OF, baseCurrency: 'ILS', buckets: bands({ 'over-90': '9007199254740993' }) },
  openInvoices: [
    invoice({
      invoiceId: '7a1c0e10-0005-4000-8000-00000000e001',
      documentNumber: 'INV-0001',
      issueDate: '2025-10-01',
      dueDate: '2025-10-04',
      totalTxnMinor: '18014398509481985',
      outstandingTxnMinor: '9007199254740993',
      settlementState: 'partial',
      daysPastDue: 405,
      ageDays: 408,
    }),
  ],
  credits: [],
  hasMore: false,
});

/** 200 held amounts, newest first — what `LIMIT 200` returns when there may be more. */
const CAPPED_CREDITS: Credit[] = Array.from({ length: 200 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  return credit(`c4ed1700-0007-4000-8000-000000000${n}`, 'ILS', `${n}00`, '2026-11-01');
});

export const CUSTOMER_ACCOUNT_VIEW: ViewEntry = defineView('CustomerAccountView', CustomerAccountView, {
  'owes in one currency, with open invoices and a further page': account({}),
  'money held for the customer: the balance is below zero': HELD,
  'owes in two currencies': MULTI,
  'nothing owed and nothing open': ZERO,
  'an amount beyond 2^53': HUGE,
  'show more was refused, with the rows still on screen': account({ errorKey: 'error.FORBIDDEN' }),
  'more held amounts than one read returns': account({ credits: CAPPED_CREDITS, creditsCapped: true, hasMore: false }),
});
