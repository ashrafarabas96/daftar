/**
 * "Receive a payment" (القبض, P4-S4): money a customer handed over, put
 * against the customer's open invoices as the merchant types it, with any
 * rest held for the customer.
 *
 * A pure view. It computes nothing: every figure on it is either one the
 * server sent (an invoice's total and what is still due, the saved payment
 * and what it holds for the customer) or one the merchant is typing. Whether
 * a rest is held is `surplus`, which the page asks of
 * `collect-payment.ts` — the same comparison that decides what is sent.
 *
 * A refusal is shown beside the form, which keeps every figure typed (the
 * page sets the refusal and touches nothing else). A replay of a payment
 * already saved is a success, said as such.
 *
 * The wording "held for the customer" is the provisional owner wording
 * (`L8_CUSTOMER_ACCOUNT_OWNER_WORDING_AR.md`): the merchant-jargon guard
 * forbids the accounting words for it.
 */
import { Button, Select, TextField } from '@daftar/design-system';
import type { CustomerPaymentDto, CustomerPaymentResultDto, CustomerStatusDto, PaymentMethodDto } from '@daftar/shared-contracts';
import { Ltr, rich, type ViewBaseProps } from '@/lib/phase3-format';
import { RefusalNotice } from '../common/feedback';
import { activeMethodChoices } from '../common/payment-methods';
import { CivilDate, Heading, Inline, Money, Muted, Notice, Panel, Stack, Text, Title } from '../common/primitives';
import { heldOnRow, isAllocatable, type CollectFormModel, type CollectRowModel, type Surplus } from './collect-payment';

export type CollectFormField = 'methodId' | 'currency' | 'amount' | 'date' | 'reference';

export interface CollectPaymentViewProps {
  customer: { name: string; status: CustomerStatusDto };
  methods: readonly PaymentMethodDto[];
  form: CollectFormModel;
  rows: readonly CollectRowModel[];
  hasMore: boolean;
  loadingMore: boolean;
  /** From `surplusOf`; null while a typed figure does not parse. */
  surplus: Surplus | null;
  busy: boolean;
  errorKey: string | null;
  result: CustomerPaymentResultDto | null;
  /** A payment already stored under this form's id, as the server read it back (`collect-flow.ts`). */
  stored: CustomerPaymentDto | null;
  /** This form's payment may be stored but could not be read: no form and no new form, only "read again". */
  storedUnread: boolean;
  on: {
    onField: (field: CollectFormField, value: string) => void;
    onRowAmount: (invoiceId: string, value: string) => void;
    onLoadMore: () => void;
    onSubmit: () => void;
    onRereadStored: () => void;
    /** A new form with new ids. Offered only beside a saved or an already-stored payment. */
    onStartOver: () => void;
  };
}

function invoicesKey(count: number): 'customers.collect.doneInvoicesNone' | 'customers.collect.doneInvoicesOne' | 'customers.collect.doneInvoices' {
  if (count === 0) return 'customers.collect.doneInvoicesNone';
  return count === 1 ? 'customers.collect.doneInvoicesOne' : 'customers.collect.doneInvoices';
}

export function CollectPaymentView(props: CollectPaymentViewProps & ViewBaseProps) {
  const { t, locale } = props;
  if (props.result) return <Saved {...props} payment={props.result} replayed={props.result.replayed} />;
  if (props.stored) return <Saved {...props} payment={props.stored} replayed={false} alreadyRecorded />;
  return (
    <Stack>
      <Title>{t('customers.collect.title')}</Title>
      <Text strong>
        <bdi>{props.customer.name}</bdi>
      </Text>
      {props.customer.status === 'inactive' ? <Notice tone="warning">{t('customers.collect.customerInactive')}</Notice> : null}
      {props.storedUnread ? null : <PaymentForm {...props} />}
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
      {props.storedUnread ? (
        <Button fullWidth loading={props.busy} disabled={props.busy} onClick={props.on.onRereadStored}>
          {t('customers.collect.readAgain')}
        </Button>
      ) : null}
    </Stack>
  );
}

function PaymentForm(props: CollectPaymentViewProps & ViewBaseProps) {
  const { t, locale, form, on } = props;
  const methods = activeMethodChoices(props.methods, locale, t);
  const method = methods.find((m) => m.paymentMethodId === form.methodId);
  return (
    <Stack>
      {methods.length === 0 ? <Notice tone="info">{t('customers.collect.noMethods')}</Notice> : null}
      <Select
        label={t('customers.collect.method')}
        value={form.methodId}
        error={form.errors.method ? t('customers.collect.methodRequired') : undefined}
        options={[{ value: '', label: t('customers.collect.chooseMethod') }, ...methods.map((m) => ({ value: m.paymentMethodId, label: m.name }))]}
        onChange={(v) => on.onField('methodId', v)}
      />
      {form.currencyOptions.length > 1 ? (
        <Select
          label={t('customers.collect.receivedIn')}
          value={form.currency}
          options={form.currencyOptions.map((c) => ({ value: c, label: c }))}
          onChange={(v) => on.onField('currency', v)}
        />
      ) : null}
      <TextField
        label={t('customers.collect.amount', { currency: form.currency })}
        inputMode="decimal"
        value={form.amount}
        error={form.errors.amount ? t('customers.collect.amountInvalid') : undefined}
        onChange={(v) => on.onField('amount', v)}
      />
      <TextField
        label={t('common.date')}
        type="date"
        value={form.date}
        error={form.errors.date ? t('customers.collect.dateRequired') : undefined}
        onChange={(v) => on.onField('date', v)}
      />
      <TextField
        label={method?.requiresReference ? t('customers.collect.reference') : `${t('customers.collect.reference')} (${t('common.optional')})`}
        value={form.reference}
        error={form.errors.reference ? t('customers.collect.referenceRequired') : undefined}
        onChange={(v) => on.onField('reference', v)}
      />

      <Heading>{t('customers.collect.invoices')}</Heading>
      {props.rows.length === 0 ? <Muted>{t('customers.collect.noOpenInvoices')}</Muted> : <Muted>{t('customers.collect.invoicesHint')}</Muted>}
      {form.errors.rows ? <Notice tone="danger">{t('customers.collect.rowsInvalid')}</Notice> : null}
      {form.errors.tooMany ? <Notice tone="danger">{t('customers.collect.tooMany')}</Notice> : null}
      {props.rows.map((row) => (
        <InvoiceRow key={row.invoiceId} {...props} row={row} />
      ))}
      {props.hasMore ? (
        <Button variant="secondary" fullWidth loading={props.loadingMore} onClick={on.onLoadMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}

      {props.surplus === 'kept' && props.rows.length > 0 ? <Notice tone="info">{t('customers.collect.restHeld')}</Notice> : null}
      {props.surplus === 'over' ? <Notice tone="warning">{t('customers.collect.over')}</Notice> : null}
      <Button fullWidth loading={props.busy} disabled={props.busy} onClick={on.onSubmit}>
        {t('customers.collect.submit')}
      </Button>
    </Stack>
  );
}

function InvoiceRow(props: CollectPaymentViewProps & ViewBaseProps & { row: CollectRowModel }) {
  const { t, locale, row, form, on } = props;
  const held = heldOnRow(row);
  return (
    <Panel>
      <Inline gap={2}>
        <Text strong>{rich(t('customers.collect.invoiceNumber'), { number: <Ltr>{row.documentNumber}</Ltr> })}</Text>
        <Muted>{rich(t('customers.collect.issued'), { date: <CivilDate iso={row.issueDate} locale={locale} /> })}</Muted>
      </Inline>
      {row.isCredit ? (
        // A balance row takes no amount. Its figure is the server's, without the minus sign (`heldOnRow`).
        <Stack gap={1}>
          <Muted>{t('customers.collect.balanceRow')}</Muted>
          {held !== null ? (
            <Muted>{rich(t('customers.collect.balanceHeld'), { amount: <Money amountMinor={held} currency={row.currency} locale={locale} /> })}</Muted>
          ) : null}
        </Stack>
      ) : (
        <Muted>
          {rich(t('customers.collect.stillDue'), {
            amount: <Money amountMinor={row.outstandingTxnMinor} currency={row.currency} locale={locale} />,
            total: <Money amountMinor={row.totalTxnMinor} currency={row.currency} locale={locale} />,
          })}
        </Muted>
      )}
      {isAllocatable(row, form.currency) ? (
        <TextField
          label={t('customers.collect.rowAmount', { currency: form.currency })}
          inputMode="decimal"
          value={row.amount}
          error={row.invalid ? t('customers.collect.rowInvalid') : undefined}
          onChange={(v) => on.onRowAmount(row.invoiceId, v)}
        />
      ) : !row.isCredit ? (
        <Muted>{t('customers.collect.otherCurrency', { currency: row.currency })}</Muted>
      ) : null}
    </Panel>
  );
}

/**
 * A payment the server has: just saved (or replayed), or already stored under this form's id. Every figure
 * is the server's. An already-stored payment says so first, so it is not entered a second time.
 */
function Saved(props: CollectPaymentViewProps & ViewBaseProps & { payment: CustomerPaymentDto; replayed: boolean; alreadyRecorded?: boolean }) {
  const { t, locale, payment: result } = props;
  return (
    <Stack>
      <Title>{t('customers.collect.title')}</Title>
      <Notice tone="success">
        <Stack gap={2}>
          <Text strong>{props.alreadyRecorded ? t('customers.collect.alreadyRecorded') : t('customers.collect.done')}</Text>
          {props.replayed ? <Text>{t('customers.collect.alreadySaved')}</Text> : null}
          <Text>
            {rich(t('customers.collect.doneAmount'), {
              amount: <Money amountMinor={result.amountMinor} currency={result.currencyCode} locale={locale} />,
              name: <bdi>{props.customer.name}</bdi>,
            })}
          </Text>
          <Text>{rich(t(invoicesKey(result.allocations.length)), { n: <Ltr>{result.allocations.length}</Ltr> })}</Text>
          {result.credit !== null ? (
            <Text>
              {rich(t('customers.collect.doneHeld'), {
                amount: <Money amountMinor={result.credit.originalAmountMinor} currency={result.credit.currencyCode} locale={locale} />,
              })}
            </Text>
          ) : null}
        </Stack>
      </Notice>
      <Button fullWidth onClick={props.on.onStartOver}>
        {t('customers.collect.another')}
      </Button>
    </Stack>
  );
}
