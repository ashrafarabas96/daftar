/**
 * One invoice (MVP-02), from `GET /v1/invoices/:invoiceId`, with the collection
 * figures of `GET …/settlement` when that read was allowed.
 *
 * Every amount is a FIELD of a server answer, re-spelled by `Money` and never
 * combined: each item shows its own unit price and net, and the footer shows the
 * invoice's own subtotal, discount and total — which the server states, so
 * nothing here adds the items up. The two figures that happen to be equal in a
 * simple invoice (the items' nets and the subtotal) are two separate fields, and
 * this view reads each from its own place rather than deriving one.
 *
 * **Collection comes from the settlement read ALONE** (P4-AL-24: `status` is
 * lifecycle, never collection). A caller that could not make that read passes
 * `settlement: null`, and then the screen says NOTHING about collection — it does
 * not fall back to a zero, because a zero is a figure no answer supports and
 * "nothing collected" and "not allowed to know" are different facts.
 *
 * ── WHAT THIS SCREEN DOES NOT SHOW, AND WHY ──────────────────────────────
 *
 * **No buyer.** T-12 (`test/od03.test.ts:216`) refuses the customer vocabulary on
 * every merchant screen until the customers slice ships. It costs nothing today:
 * no customer can be created through the product at all (a measured 404 on
 * `POST /v1/customers`), so every invoice that exists is a walk-in with no buyer
 * to name. The buyer block arrives with that slice, and the card tracking it is
 * `.local-context/cards/L8_INVOICE_DETAIL_BLOCKED_BY_T12_AR.md`.
 *
 * **No due date.** Legal only on a credit sale with a named customer
 * (`selling.schemas.ts:361`, `invoices_walkin_terms_ck` at `0075:316`), so no
 * live invoice carries one — and voiding does not clear `due_date`
 * (`0075:301-311`), so a cancelled document showing one reads as a live
 * obligation. The field is not read at all.
 *
 * **No exchange rate.** `InvoiceRateDto` is on the DTO and is the accountant's
 * fact, not the shopkeeper's: the invoice is already shown in its own currency.
 */
import { Badge, Button, Card, List } from '@daftar/design-system';
import type { InvoiceDto, InvoiceSettlementDto } from '@/lib/phase4-invoices-api';
import { Ltr, formatDecimalText, formatMomentDate, rich, type ViewBaseProps } from '@/lib/phase3-format';
import { CivilDate, Code, Fact, Money } from '@/views/common/primitives';
import { ActionRow, ItemName, Notice, STACK, ScreenTitle, SectionTitle } from '@/views/stock/parts';

export interface InvoiceDetailViewProps {
  invoice: InvoiceDto;
  /** Null when the settlement read did not answer; `settlementErrorKey` says why. */
  settlement: InvoiceSettlementDto | null;
  /**
   * A catalogue key when the collection read failed or was refused, so the
   * screen can SAY the figures are missing instead of just omitting them.
   *
   * Omitting them silently was a measured defect: read right-to-left the page
   * then ends at the total as its last and largest fact, and a merchant who has
   * seen the collection card on other invoices reads its absence as "no
   * collection record" — i.e. the whole amount still stands. The error runs
   * toward asking a customer for money already received, which is the unsafe
   * direction, so the reason travels and is rendered.
   */
  settlementErrorKey: string | null;
  onBack: () => void;
}

/** `success` is reserved for a document fully collected, and only the settlement read may say so. */
const STATUS_TONE = { draft: 'warning', open: 'info', void: 'neutral' } as const;
const SETTLEMENT_TONE = { unpaid: 'warning', partial: 'info', paid: 'success' } as const;

export function InvoiceDetailView(props: InvoiceDetailViewProps & ViewBaseProps) {
  const { t, locale, invoice, settlement } = props;
  const money = (minor: string) => <Money amountMinor={minor} currency={invoice.currency} locale={locale} />;
  return (
    <div style={STACK}>
      <ActionRow>
        <Button variant="secondary" onClick={props.onBack}>
          {t('common.back')}
        </Button>
      </ActionRow>
      <ScreenTitle>
        {t('invoices.detail.title')} <Code>{invoice.documentNumber}</Code>
      </ScreenTitle>
      <Card>
        <div style={STACK}>
          <Fact label={t('invoices.detail.status')}>
            <Badge tone={STATUS_TONE[invoice.status]}>{t(`invoices.status.${invoice.status}`)}</Badge>
          </Fact>
          <Fact label={t('invoices.detail.issueDate')}>
            <CivilDate iso={invoice.issueDate} locale={locale} />
          </Fact>
          {invoice.voidedAt !== null ? (
            <Fact label={t('invoices.detail.cancelledOn')}>
              {/*
               * A MOMENT, not a civil date. `voided_at` is `TIMESTAMPTZ`
               * (`0075:275`) and arrives as an instant, while `CivilDate` slices
               * the first ten characters and formats them in UTC
               * (`phase3-format.ts:174-176`) — so a void at 22:00Z would read a
               * day EARLY for a merchant at UTC+2/+3, on a cancelled document.
               * `formatMomentDate` resolves the instant in the reader's own zone,
               * which is the question "which day was this cancelled" actually asks.
               */}
              <Ltr>{formatMomentDate(invoice.voidedAt, locale)}</Ltr>
            </Fact>
          ) : null}
          {invoice.notes !== null ? (
            <Fact label={t('invoices.detail.notes')}>
              {/* Merchant-typed text: isolated, because it may mix scripts and digits. */}
              <bdi>{invoice.notes}</bdi>
            </Fact>
          ) : null}
        </div>
      </Card>
      <SectionTitle>{t('invoices.detail.items')}</SectionTitle>
      <List
        items={invoice.items.map((item) => ({
          key: `${item.lineNo}`,
          primary: <ItemName name={item.nameSnapshot} variantName={null} />,
          // The quantity is the server's own decimal text, re-spelled and never
          // multiplied by the price: the line's net is its own field below.
          secondary: rich(t('invoices.detail.itemLine'), {
            qty: <Ltr>{formatDecimalText(item.quantity, locale)}</Ltr>,
            price: money(item.unitPriceTxnMinor),
          }),
          trailing: money(item.netTxnMinor),
        }))}
      />
      <Card>
        <div style={STACK}>
          <Fact label={t('invoices.detail.subtotal')}>{money(invoice.subtotalTxnMinor)}</Fact>
          <Fact label={t('invoices.detail.discount')}>{money(invoice.discountTxnMinor)}</Fact>
          <Fact label={t('invoices.detail.total')}>{money(invoice.totalTxnMinor)}</Fact>
        </div>
      </Card>
      {settlement !== null ? (
        <Card>
          <div style={STACK}>
            <SectionTitle>{t('invoices.settlement.title')}</SectionTitle>
            <Fact label={t('invoices.settlement.state')}>
              <Badge tone={SETTLEMENT_TONE[settlement.settlementState]}>{t(`invoices.settlement.${settlement.settlementState}`)}</Badge>
            </Fact>
            {/*
             * Bound to the SETTLEMENT's own currency, not the invoice's. They are
             * the same currency by construction today — this settlement is of
             * this invoice — but labelling an amount with a currency taken from a
             * different document than the one that stated it is the shape of the
             * error even when it is not an instance of it.
             */}
            <Fact label={t('invoices.settlement.collected')}>
              <Money amountMinor={settlement.paidTxnMinor} currency={settlement.currency} locale={locale} />
            </Fact>
            <Fact label={t('invoices.settlement.remaining')}>
              <Money amountMinor={settlement.outstandingTxnMinor} currency={settlement.currency} locale={locale} />
            </Fact>
          </div>
        </Card>
      ) : props.settlementErrorKey !== null ? (
        <Card>
          <div style={STACK}>
            <SectionTitle>{t('invoices.settlement.title')}</SectionTitle>
            <Notice tone="info">{t(props.settlementErrorKey)}</Notice>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
