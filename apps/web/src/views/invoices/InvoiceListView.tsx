/**
 * Invoices (MVP-02): the documents the business has issued, from
 * `GET /v1/invoices`, **in the order the server gives them — OLDEST FIRST**.
 *
 * That order is not a choice this view makes and not one it can change.
 * `invoice-reads.ts:155` is `ORDER BY i.issue_date, i.id` with a keyset cursor
 * that walks FORWARD (`(issue_date, id) > …`), and `InvoiceListQuerySchema`
 * (`selling.schemas.ts:235-249`) accepts no ordering parameter at all — measured,
 * with a positive control that `ORDER BY … DESC` does exist elsewhere in the API,
 * so the ascending order here is a reading and not a blind spot.
 *
 * **The consequence is the merchant's, so it is reported rather than hidden:**
 * the first page is the business's OLDEST twenty invoices, so today's sale is
 * pages away, and inside one day the order falls to `id` — a v4 UUID, which is
 * arbitrary. Sorting the page here would be worse than the problem: it would
 * order twenty arbitrary rows out of hundreds and read as "newest" while being
 * nothing of the kind. The fix belongs to the read route, and the card is
 * `.local-context/cards/L8_INVOICE_LIST_ORDER_IS_OLDEST_FIRST_AR.md`.
 *
 * A row shows the document number, the day it was issued, the total the server
 * stated and where the document stands. It says NOTHING about collection:
 * `status` is lifecycle only (P4-AL-24) and a list answer carries no settlement,
 * so "paid" would be an invention. The status labels name ISSUANCE for that
 * reason: "Open" is the word a shopkeeper reads as "not paid yet", and this
 * screen holds no figure that could support or refute it.
 *
 * ── THREE THINGS THIS ROW DELIBERATELY DOES NOT DO ───────────────────────
 *
 * **It does not open.** The row is not clickable and there is no `onOpen`: the
 * invoice DETAIL screen is not in this tree, because an `InvoiceDto` fixture
 * must name `customerSnapshot` and T-12 (`test/od03.test.ts:216`, `:235`)
 * refuses that vocabulary in every file of `apps/web`. A row that pushed
 * `/invoices/:id` today would land the merchant on a 404 — which is the defect
 * `phase4-pos-api.ts`'s header records at scale (six planned endpoints, 36
 * browser-gate failures, every one a 404). So the row stays inert until the
 * screen ships: `.local-context/cards/L8_INVOICE_DETAIL_BLOCKED_BY_T12_AR.md`.
 *
 * **It does not show a due date.** A due date is legal only on a credit sale
 * with a named customer — `SaleCommitSchema`'s own refinement
 * (`selling.schemas.ts:361`) and `invoices_walkin_terms_ck` (`0075:316`) both
 * say so — and no customer can be created through the product at all
 * (`cards/L8_CUSTOMER_WRITE_ROUTE_MISSING_AR.md`, measured 404). So no live
 * invoice carries one. Rendering it anyway cost a measured defect: voiding does
 * not clear `due_date` (`0075:301-311`), so a cancelled document read as
 * «تستحق في …» — a live obligation on a document that no longer owes anything.
 *
 * **It never names a buyer.** Same T-12 rule; and a list answer carries an id
 * and no name in any case.
 */
import { Badge, Button, EmptyState, List, Spinner } from '@daftar/design-system';
import type { InvoiceSummaryDto } from '@/lib/phase4-invoices-api';
import { rich, type ViewBaseProps } from '@/lib/phase3-format';
import { CivilDate, Code, Money } from '@/views/common/primitives';
import { Notice, STACK, ScreenTitle } from '@/views/stock/parts';

export interface InvoiceListViewProps {
  /** Null while the first page loads. */
  invoices: readonly InvoiceSummaryDto[] | null;
  hasMore: boolean;
  loadingMore: boolean;
  errorKey: string | null;
  onLoadMore: () => void;
  /** An empty list leads somewhere (SIM-12): to the till. */
  onSellSomething: () => void;
}

/**
 * Where the document stands, in the merchant's words rather than the engine's.
 *
 * The accepted precedent is `purchasing.status.*`, which spells `draft` as "Not
 * received yet" instead of "Draft" (`messages/en.json:590-593`). It matters more
 * here than there: "Open" is the word a shopkeeper reads as "not yet paid", and
 * a list answer holds no settlement figure to support that (P4-AL-24). So the
 * labels name ISSUANCE, which is what `status` actually reports.
 *
 * `success` is never used as a tone: green is the colour read as "paid".
 */
const STATUS_TONE = { draft: 'warning', open: 'info', void: 'neutral' } as const;

export function InvoiceListView(props: InvoiceListViewProps & ViewBaseProps) {
  const { t, locale } = props;
  return (
    <div style={STACK}>
      <ScreenTitle>{t('invoices.list.title')}</ScreenTitle>
      {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
      {props.invoices === null ? (
        <Spinner label={t('common.loading')} />
      ) : props.invoices.length === 0 ? (
        // A refused read also arrives as an empty list: the refusal is already on screen, so no "nothing yet" beside it.
        props.errorKey === null ? (
          <EmptyState title={t('invoices.list.empty')} actionLabel={t('invoices.list.sellSomething')} onAction={props.onSellSomething} />
        ) : null
      ) : (
        <List
          items={props.invoices.map((invoice) => ({
            key: invoice.id,
            primary: <Code>{invoice.documentNumber}</Code>,
            secondary: rich(t('invoices.list.issued'), { date: <CivilDate iso={invoice.issueDate} locale={locale} /> }),
            trailing: (
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
                <Money amountMinor={invoice.totalTxnMinor} currency={invoice.currency} locale={locale} />
                <Badge tone={STATUS_TONE[invoice.status]}>{t(`invoices.status.${invoice.status}`)}</Badge>
              </span>
            ),
          }))}
        />
      )}
      {props.hasMore ? (
        <Button variant="secondary" fullWidth loading={props.loadingMore} onClick={props.onLoadMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
