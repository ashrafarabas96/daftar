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
import type { InvoiceSummaryDto } from '@/lib/phase4-ar-api';
import { InvoiceListView, type InvoiceListViewProps } from './InvoiceListView';

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
  onLoadMore: noop,
  onSellSomething: noop,
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
    'the server refused the read': list({ invoices: [], hasMore: false, errorKey: 'common.noPermission' }),
  }),
];
