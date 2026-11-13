/**
 * The customer account (MVP-02), read-only: what ONE customer owes, from five
 * merged reads (`phase4-customer-account-api.ts`). It creates, edits and
 * collects nothing — the customer writes are another lane's unmerged PR, and
 * collecting a payment is the next screen.
 *
 * ── EVERY FIGURE IS THE SERVER'S, VERBATIM ──────────────────────────────
 * Each amount is a minor-unit string spelled by `formatMoney` (BigInt-exact).
 * This view adds nothing up, subtracts nothing and converts nothing: the
 * server splits the balance by currency, so each currency is its own line, and
 * the one total shown is the server's `baseMinor` in its `baseCurrency`. A
 * currency line is left out only when it is a word-for-word repeat of the
 * figure above it (one line, same currency, same text) — never by a sum.
 * The aging answer's own `totalBaseMinor` is not shown: the balance above is
 * the total the merchant reads, and two totals that differ by the money not
 * yet on an open invoice would be a puzzle this screen cannot explain.
 *
 * ── A NEGATIVE AMOUNT IS MONEY HELD FOR THE CUSTOMER ────────────────────
 * The balance MAY come back below zero (L3 contract note §6: the ledger reader
 * has no zero floor). It is then worded as money held for the customer, with
 * its magnitude taken off the TEXT by `splitMinorSign` — never "we owe the
 * customer", and never a minus sign in front of a figure.
 *
 * ── THE HELD-MONEY SECTION COMES FROM THE HELD AMOUNTS, NOT THE SIGN ─────
 * A surplus payment does not push the balance below zero: it is kept as a held
 * amount (`GET /v1/customers/:id/credits`, `remainingAmountMinor`). So the
 * section is shown when such an amount has something left, whatever the
 * balance says, and each one is its own line in its own currency. An exhausted
 * one (`"0"`) holds nothing and is not listed. That read returns at most 200
 * rows with no cursor, so when it returns 200 the view says older ones may be
 * missing rather than implying the list is complete.
 *
 * There is no credit limit (`OD-P4-03` OPTION A): nothing here mentions one.
 */
import type { ReactNode } from 'react';
import { Badge, Button, EmptyState, List } from '@daftar/design-system';
import { splitMinorSign } from '@/lib/minor-sign';
import { Ltr, rich, type Translate, type ViewBaseProps } from '@/lib/phase3-format';
import {
  AGE_BAND_KEYS,
  CREDITS_READ_CAP,
  type CustomerAgingDto,
  type CustomerCreditDto,
  type CustomerDto,
  type CustomerOpenInvoiceDto,
  type CustomerReceivableDto,
} from '@/lib/phase4-customer-account-api';
import type { Locale } from '@/lib/i18n';
import { CivilDate, Code, Money } from '@/views/common/primitives';
import { Hint, Notice, STACK, ScreenTitle, SectionTitle } from '@/views/stock/parts';

type CurrencyLine = { currency: string; txnMinor: string };

export interface CustomerAccountViewProps {
  customer: Pick<CustomerDto, 'name' | 'status'>;
  /** The balance, as `GET …/receivable` answered it (the id is the page's, not the view's). */
  receivable: Omit<CustomerReceivableDto, 'customerId'>;
  aging: Pick<CustomerAgingDto, 'asOf' | 'baseCurrency' | 'buckets'>;
  /** In the server's order — oldest first. */
  openInvoices: readonly CustomerOpenInvoiceDto[];
  /** In the server's order — newest first. */
  credits: readonly Omit<CustomerCreditDto, 'customerId'>[];
  /** True when the credits read returned as many rows as it ever returns. */
  creditsCapped: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  errorKey: string | null;
  onLoadMore: () => void;
}

const SETTLEMENT_TONE = { unpaid: 'warning', partial: 'info', paid: 'neutral' } as const;

export function CustomerAccountView(props: CustomerAccountViewProps & ViewBaseProps) {
  const { t, locale, receivable, aging } = props;
  const held = props.credits.filter((c) => signOf(c.remainingAmountMinor) !== 'zero');
  return (
    <div style={STACK}>
      <ScreenTitle>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <bdi>{props.customer.name}</bdi>
          {props.customer.status === 'inactive' ? <Badge tone="neutral">{t('common.inactive')}</Badge> : null}
        </span>
      </ScreenTitle>
      <Hint>{rich(t('customers.account.asOf'), { date: <CivilDate iso={aging.asOf} locale={locale} /> })}</Hint>

      <section style={STACK}>
        <SectionTitle>{t('customers.account.owes.title')}</SectionTitle>
        <Row label={t('customers.account.owes.total')}>
          <Owed t={t} locale={locale} amountMinor={receivable.baseMinor} currency={receivable.baseCurrency} />
        </Row>
        {signOf(receivable.baseMinor) === 'zero' ? <Hint>{t('customers.account.owes.nothing')}</Hint> : null}
        {showLines(receivable.byCurrency, receivable.baseMinor, receivable.baseCurrency) ? (
          <>
            <Hint>{t('customers.account.owes.byCurrency')}</Hint>
            <CurrencyLines t={t} locale={locale} lines={receivable.byCurrency} />
          </>
        ) : null}
      </section>

      {held.length > 0 ? (
        <section style={STACK}>
          <SectionTitle>{t('customers.account.heldMoney.title')}</SectionTitle>
          <List
            items={held.map((credit) => ({
              key: credit.creditId,
              primary: <Money amountMinor={credit.remainingAmountMinor} currency={credit.currencyCode} locale={locale} />,
              secondary: rich(t('customers.account.heldMoney.since'), { date: <CivilDate iso={credit.creditDate} locale={locale} /> }),
            }))}
          />
          {props.creditsCapped ? (
            <Notice tone="info">{rich(t('customers.account.heldMoney.capped'), { count: <Ltr>{String(CREDITS_READ_CAP)}</Ltr> })}</Notice>
          ) : null}
        </section>
      ) : null}

      <section style={STACK}>
        <SectionTitle>{t('customers.account.age.title')}</SectionTitle>
        <List
          items={aging.buckets.map((bucket) => ({
            key: bucket.label,
            primary: <AgeBand t={t} bucket={bucket} />,
            secondary: showLines(bucket.byCurrency, bucket.baseMinor, aging.baseCurrency) ? (
              <CurrencyLines t={t} locale={locale} lines={bucket.byCurrency} />
            ) : undefined,
            trailing: <Owed t={t} locale={locale} amountMinor={bucket.baseMinor} currency={aging.baseCurrency} />,
          }))}
        />
      </section>

      <section style={STACK}>
        <SectionTitle>{t('customers.account.invoices.title')}</SectionTitle>
        {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
        {props.openInvoices.length === 0 ? (
          // A refused first read renders `ScreenState` and never reaches this view,
          // and "show more" can only be refused while rows are on screen.
          <EmptyState title={t('customers.account.invoices.empty')} />
        ) : (
          <List
            items={props.openInvoices.map((invoice) => ({
              key: invoice.invoiceId,
              primary: (
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <Code>{invoice.documentNumber}</Code>
                  <Badge tone={SETTLEMENT_TONE[invoice.settlementState]}>{t(`customers.account.invoices.state.${invoice.settlementState}`)}</Badge>
                </span>
              ),
              secondary: <InvoiceDates t={t} locale={locale} invoice={invoice} />,
              trailing: (
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem', overflowWrap: 'anywhere' }}>
                  <Owed t={t} locale={locale} amountMinor={invoice.outstandingTxnMinor} currency={invoice.currency} />
                  <span>
                    {rich(t('customers.account.invoices.ofTotal'), {
                      total: <Money amountMinor={invoice.totalTxnMinor} currency={invoice.currency} locale={locale} />,
                    })}
                  </span>
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
      </section>
    </div>
  );
}

/** The sign of a server amount. The page has already refused an answer whose amounts are not minor-unit text. */
function signOf(amountMinor: string): 'negative' | 'zero' | 'positive' {
  const split = splitMinorSign(amountMinor);
  if (split === null) throw new Error('an amount that is not minor-unit text reached the view');
  return split.sign;
}

/**
 * A band in the merchant's words, its day numbers the server's own `fromDays`
 * and `toDays`. The page has already refused a band token outside the
 * 0,30,60,90 set and a band missing the bound its sentence names.
 */
function AgeBand(props: { t: Translate; bucket: CustomerAgingDto['buckets'][number] }) {
  const { t, bucket } = props;
  const key = AGE_BAND_KEYS[bucket.label];
  if (key === undefined) throw new Error('an age band outside the offered set reached the view');
  const day = (n: number | null): ReactNode => <Ltr>{String(n)}</Ltr>;
  return <span>{rich(t(key), { from: day(bucket.fromDays), to: day(bucket.toDays) })}</span>;
}

/** Whether the currency lines say anything the figure above them does not: not when empty, not when a word-for-word repeat. */
function showLines(lines: readonly CurrencyLine[], baseMinor: string, baseCurrency: string): boolean {
  if (lines.length === 0) return false;
  const only = lines[0];
  return !(lines.length === 1 && only !== undefined && only.currency === baseCurrency && only.txnMinor === baseMinor);
}

/** A figure the customer owes, or — below zero — the same magnitude worded as money held for them. */
function Owed(props: { t: Translate; locale: Locale; amountMinor: string; currency: string }) {
  const split = splitMinorSign(props.amountMinor);
  if (split === null) throw new Error('an amount that is not minor-unit text reached the view');
  if (split.sign === 'negative') {
    return (
      <span>
        {rich(props.t('customers.account.held'), { amount: <Money amountMinor={split.magnitude} currency={props.currency} locale={props.locale} /> })}
      </span>
    );
  }
  return <Money amountMinor={props.amountMinor} currency={props.currency} locale={props.locale} />;
}

function CurrencyLines(props: { t: Translate; locale: Locale; lines: readonly CurrencyLine[] }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
      {props.lines.map((line) => (
        <Owed key={line.currency} t={props.t} locale={props.locale} amountMinor={line.txnMinor} currency={line.currency} />
      ))}
    </span>
  );
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
      <strong>{props.label}</strong>
      <strong>{props.children}</strong>
    </div>
  );
}

/**
 * Issued, due, and how late — the day count worded by its SIGN, read verbatim:
 * above zero it is "N days late", exactly zero is "due today" (the as-of date IS
 * the due date), below zero is "not due yet" (no number, so nothing is negated).
 * A credit-bearing row is never late (DR-31): it reads as money held, on an
 * invoice that many days old (DR-35).
 */
function InvoiceDates(props: { t: Translate; locale: Locale; invoice: CustomerOpenInvoiceDto }) {
  const { t, locale, invoice } = props;
  const days = invoice.daysPastDue;
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
      <span>{rich(t('customers.account.invoices.issued'), { date: <CivilDate iso={invoice.issueDate} locale={locale} /> })}</span>
      <span>
        {invoice.dueDate !== null
          ? rich(t('customers.account.invoices.due'), { date: <CivilDate iso={invoice.dueDate} locale={locale} /> })
          : t('customers.account.invoices.noDueDate')}
      </span>
      <span>
        {invoice.isCredit
          ? rich(t('customers.account.invoices.heldOnInvoice'), { days: <Ltr>{String(invoice.ageDays)}</Ltr> })
          : days > 0
            ? rich(t('customers.account.invoices.daysLate'), { days: <Ltr>{String(days)}</Ltr> })
            : days === 0
              ? t('customers.account.invoices.dueToday')
              : t('customers.account.invoices.notDueYet')}
      </span>
    </span>
  );
}
