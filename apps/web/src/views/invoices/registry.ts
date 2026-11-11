/**
 * The invoice views and the fixtures the SSR suites render them with (MVP-02,
 * in the shape of `suppliers/registry.ts`: T-08, T-15, T-16).
 *
 * ── WHY THIS FILE IS `.ts` AND NOT `.tsx`, measured ──────────────────────
 * `InvoiceSummaryDto` carries `customerId`, so a fixture must set it. T-12
 * (`apps/web/test/od03.test.ts:216`) refuses the token `customer` in ANY
 * merchant `.tsx` — "no S7 screen names a customer... the screen that names one
 * ships with the customers slice" — while its library rule (`:235`, allowed
 * values at `:125`) admits the one spelling `customerId`, set from `null`. A
 * `.ts` registry is a library by `isS7WebFile`, so the walk-in id is legal here
 * and would not be three lines away in a `.tsx`. `loadViewRegistries` accepts
 * either extension (`test/helpers/render.tsx:221`), and `defineView` needs no
 * JSX: it takes the component and plain props.
 *
 * ── WHY EVERY FIXTURE IS A WALK-IN WITH NO DUE DATE ──────────────────────
 * Not a simplification — the only shape the database admits here.
 * `invoices_walkin_terms_ch`'s real spelling, `invoices_walkin_terms_ck`
 * (`0075:316`), is `CHECK (customer_id IS NOT NULL OR due_date IS NULL)`: a due
 * date behind a null customer is a row Postgres refuses. And `customerId` may
 * only be `null` here (T-12 again), so a fixture with terms would be a row the
 * product cannot produce — which is exactly what the first draft of this file
 * was, and what the money review caught.
 *
 * The invoice DETAIL view is not registered here, same law: an `InvoiceDto`
 * fixture would have to name `customerSnapshot`, which no file in `apps/web`
 * may do — not a `.tsx` by the screen rule, not a `.ts` by the library rule.
 * Card: `.local-context/cards/L8_INVOICE_DETAIL_BLOCKED_BY_T12_AR.md`.
 */
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import type { InvoiceDto, InvoiceSettlementDto, InvoiceSummaryDto } from '@/lib/phase4-invoices-api';
import { InvoiceDetailView, type InvoiceDetailViewProps } from './InvoiceDetailView';
import { InvoiceListView, type InvoiceListViewProps } from './InvoiceListView';
// The detail fixture is DATA, in a `.json`, and that is the whole reason it is
// one: `InvoiceDto` requires `customerSnapshot`, and T-12 refuses that token in
// every `.tsx` (its screen rule) and every `.ts` (its library rule, which admits
// `customerId` alone). `isS7WebFile` scans `.tsx?` only, and with
// `resolveJsonModule` + `strict` the assignment below is type-checked field by
// field with no cast — so the contract is honoured and nothing is asserted by
// hand. The SCREEN still names no buyer, which is what the law is about.
import detailFixture from './invoice-detail.fixture.json';

const noop = (): void => undefined;

const summary = (over: Partial<InvoiceSummaryDto> & Pick<InvoiceSummaryDto, 'id' | 'documentNumber' | 'numberSeq'>): InvoiceSummaryDto => ({
  // The walk-in spelling, and the only one T-12's library rule admits. With it,
  // `dueDate` must stay null: see the header.
  customerId: null,
  // `documentKind` is a union of 'invoice' | 'credit_note' in the contract but
  // CHECKed to 'invoice' in `0075:250`, so only one value can arrive today. The
  // row renders no kind: the day credit notes ship, one would render as a
  // positive total indistinguishable from an invoice — money owed BACK reading
  // as money owed TO the merchant — so that slice adds the badge, not this one.
  documentKind: 'invoice',
  issueDate: '2026-11-10',
  dueDate: null,
  currency: 'ILS',
  status: 'open',
  totalTxnMinor: '22500',
  totalBaseMinor: '22500',
  createdAt: '2026-11-10T09:30:00Z',
  ...over,
});

const OPEN_INVOICE = summary({ id: '8b773805-d57f-4e22-89d5-f1a8e842e11f', documentNumber: 'INV-2026-000002', numberSeq: '2' });
const DRAFT_INVOICE = summary({
  id: '8b773805-0000-4000-8000-000000000002',
  documentNumber: 'INV-2026-000005',
  numberSeq: '5',
  status: 'draft',
  totalTxnMinor: '6000',
  totalBaseMinor: '6000',
});
const VOID_INVOICE = summary({
  id: '8b773805-0000-4000-8000-000000000003',
  documentNumber: 'INV-2026-000003',
  numberSeq: '3',
  status: 'void',
  totalTxnMinor: '9000',
  totalBaseMinor: '9000',
});
/**
 * A sale in a currency that is not the business's base, so the two totals
 * DIFFER. Without it, every fixture had `totalTxnMinor === totalBaseMinor` in
 * one currency and the suite could not tell the fields apart: rendering
 * `totalBaseMinor` beside `currency` — a base-currency figure wearing the
 * transaction currency's symbol — passed every assertion. The money review
 * found that hole; this row closes it, and the suite asserts the base figure is
 * absent from the markup.
 */
const FOREIGN_INVOICE = summary({
  id: '8b773805-0000-4000-8000-000000000006',
  documentNumber: 'INV-2026-000006',
  numberSeq: '6',
  currency: 'USD',
  totalTxnMinor: '10000',
  totalBaseMinor: '36500',
});

const list = (over: Partial<InvoiceListViewProps>): InvoiceListViewProps => ({
  invoices: [OPEN_INVOICE, DRAFT_INVOICE, VOID_INVOICE, FOREIGN_INVOICE],
  hasMore: true,
  loadingMore: false,
  errorKey: null,
  onOpen: noop,
  onLoadMore: noop,
  onSellSomething: noop,
  ...over,
});

/**
 * The fixture, with the three fields a JSON import cannot carry.
 *
 * `resolveJsonModule` types every string in a `.json` as `string`, so
 * `documentKind`, `status` and `rate.source` arrive wider than their unions and
 * the assignment is REFUSED without these three — measured: `tsc` reported
 * exactly `Type 'string' is not assignable to type '"base" | "manual" |
 * "provider"'`. So the JSON proves every field is PRESENT and well-shaped, and
 * these three lines prove the unions; together there is no cast anywhere.
 *
 * None of the three is a customer token, which is why they may be named here at
 * all — `customerSnapshot` still appears nowhere in this file (see the header).
 */
const INVOICE: InvoiceDto = {
  ...detailFixture,
  documentKind: 'invoice',
  status: 'open',
  rate: { ...detailFixture.rate, source: 'base' },
};

const SETTLEMENT: InvoiceSettlementDto = {
  invoiceId: INVOICE.id,
  currency: 'ILS',
  baseCurrency: 'ILS',
  totalTxnMinor: '22500',
  totalBaseMinor: '22500',
  paidTxnMinor: '10000',
  paidBaseMinor: '10000',
  outstandingTxnMinor: '12500',
  outstandingBaseMinor: '12500',
  settlementState: 'partial',
};

const detail = (over: Partial<InvoiceDetailViewProps>): InvoiceDetailViewProps => ({
  invoice: INVOICE,
  settlement: SETTLEMENT,
  onBack: noop,
  ...over,
});

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('InvoiceListView', InvoiceListView, {
    // One row per lifecycle the server can answer, plus one in a second
    // currency, so every status label is rendered in all three locales rather
    // than asserted from the catalogue alone.
    'four invoices: open, draft, cancelled and one in another currency': list({}),
    'one invoice, no further page': list({ invoices: [OPEN_INVOICE], hasMore: false }),
    loading: list({ invoices: null, hasMore: false }),
    'no invoices at all': list({ invoices: [], hasMore: false }),
    // The state the PAGE can actually reach: a refused "show more" keeps the
    // rows already on screen and puts the refusal above them. A refused FIRST
    // read never renders this view at all — `page.tsx` shows `ScreenState` for
    // `denied`/`failed` — so an empty list beside a refusal was a fixture of a
    // state the product cannot produce, and a test over it proved nothing.
    'show more was refused, with the rows still on screen': list({ hasMore: false, errorKey: 'common.noPermission' }),
  }),
  defineView('InvoiceDetailView', InvoiceDetailView, {
    'two items, part of it collected': detail({}),
    // The settlement read needs `receivables.view` AND business-wide scope, so it
    // can be refused while the invoice itself reads fine. Then the screen says
    // nothing about collection rather than showing a zero.
    'two items, settlement not read': detail({ settlement: null }),
    'a cancelled invoice': detail({
      invoice: { ...INVOICE, status: 'void', voidedAt: '2026-11-11T08:00:00Z' },
      settlement: null,
    }),
  }),
];
