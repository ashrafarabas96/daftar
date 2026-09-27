/**
 * Pay Supplier (P3-S7 contract A-11, A-13, A-09(b), A-09(e)).
 *
 * Method, amount, date, and a reference when the method requires one. The
 * list of purchases the payment settles is the SERVER's oldest-first
 * proposal (at most fifty purchases, never leaving less than the smallest
 * coin owed); the merchant may change the split per purchase, and the server
 * judges the result. An amount no open purchase can take blocks the payment:
 * there are no advances. "Different currency" reveals, per purchase, the
 * amount it settles in the purchase's currency.
 *
 * No account picker exists anywhere: the first way to pay is set up by kind
 * (cash, card, …) and the system chooses the account (TL-3). The balance in
 * your favour can be used on open purchases from here (business-wide).
 */
import { Button, Checkbox, List, RadioCard, Select, TextField } from '@daftar/design-system';
import { Ltr, rich, type ViewBaseProps } from '@/lib/phase3-format';
import { isNonZeroMinor } from '../common/amount-text';
import { ExchangeRatePrompt, RefusalNotice, type ExchangeRatePromptProps } from '../common/feedback';
import { CivilDate, Heading, Inline, Money, Muted, Notice, Panel, Stack, Text, Title } from '../common/primitives';
import { SupplierStatusBadge } from './SupplierListView';
import type { PaymentMethodDto, SupplierPaymentResultDto } from '@daftar/shared-contracts';
import { activeMethodChoices } from '../common/payment-methods';
import type { FavourNoteModel, FavourUseModel, MethodSetupModel, PayFormModel, PayRowModel } from './types';

export type PayFormField = 'methodId' | 'currency' | 'amount' | 'date' | 'reference';

export interface PaySupplierViewProps {
  supplier: { name: string; status: 'active' | 'inactive' };
  /** As the server answered them, inactive included: the view offers the active ones in the viewer's language (Annex R #20). */
  methods: PaymentMethodDto[];
  /** Non-null when the business has no active way to pay yet. */
  setup: MethodSetupModel | null;
  form: PayFormModel;
  rows: PayRowModel[];
  /** True once the server answered a proposal for the current amount and currency. */
  proposed: boolean;
  unallocatedMinor: string | null;
  busy: boolean;
  errorKey: string | null;
  exchangeRate: ExchangeRatePromptProps | null;
  /** The server's answer (trace and entry ids included — never rendered). */
  result: SupplierPaymentResultDto | null;
  /** Null unless business-wide with `suppliers.pay` and a balance in your favour exists. */
  favour: { notes: FavourNoteModel[]; use: FavourUseModel | null } | null;
  on: {
    onField: (field: PayFormField, value: string) => void;
    onPropose: () => void;
    onToggleManual: () => void;
    onRowAmount: (purchaseId: string, value: string) => void;
    onRowApplied: (purchaseId: string, value: string) => void;
    onSubmit: () => void;
    onChooseSetup: (systemType: string) => void;
    onCreateMethod: () => void;
    onUseFavour: (creditNoteId: string) => void;
    onApplyFavour: () => void;
    onCancelFavour: () => void;
    onDone: () => void;
  };
}

export function PaySupplierView(props: PaySupplierViewProps & ViewBaseProps) {
  const { t, locale } = props;
  if (props.result) {
    return (
      <Stack>
        <Title>{t('payments.title')}</Title>
        <Notice tone="success">
          <Stack gap={2}>
            <Text strong>{t('payments.done')}</Text>
            <Text>
              {rich(t('payments.doneDetail'), {
                amount: <Money amountMinor={props.result.amountMinor} currency={props.result.currency} locale={locale} />,
                name: props.supplier.name,
                n: <Ltr>{props.result.allocations.length}</Ltr>,
              })}
            </Text>
          </Stack>
        </Notice>
        <Button fullWidth onClick={props.on.onDone}>
          {t('payments.backToSupplier')}
        </Button>
      </Stack>
    );
  }
  return (
    <Stack>
      <Title>{t('payments.title')}</Title>
      <Inline gap={2}>
        <Text strong>{props.supplier.name}</Text>
        <SupplierStatusBadge t={t} status={props.supplier.status} />
      </Inline>
      {props.supplier.status === 'inactive' ? <Notice tone="warning">{t('payments.supplierInactive')}</Notice> : null}
      {props.setup ? <MethodSetup {...props} setup={props.setup} /> : <PaymentForm {...props} />}
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
      {props.exchangeRate ? <ExchangeRatePrompt t={t} locale={locale} {...props.exchangeRate} /> : null}
      {props.favour ? <Favour {...props} favour={props.favour} /> : null}
    </Stack>
  );
}

function MethodSetup(props: PaySupplierViewProps & ViewBaseProps & { setup: MethodSetupModel }) {
  const { t, setup, on } = props;
  if (setup.mode === 'ask_owner') return <Notice tone="info">{t('payments.setup.askOwner')}</Notice>;
  const available = setup.options.filter((o) => o.available);
  return (
    <Panel>
      <Text strong>{t('payments.setup.title')}</Text>
      <Muted>{t('payments.setup.explain')}</Muted>
      {available.length === 0 ? <Notice tone="info">{t('payments.setup.noneAvailable')}</Notice> : null}
      {available.map((o) => (
        <RadioCard
          key={o.systemType}
          name="payment-method-kind"
          value={o.systemType}
          title={t(`payments.kind.${o.systemType}`)}
          checked={setup.chosen === o.systemType}
          onChange={on.onChooseSetup}
        />
      ))}
      {available.length > 0 ? (
        <Button fullWidth loading={setup.busy} disabled={setup.chosen === null} onClick={on.onCreateMethod}>
          {t('payments.setup.create')}
        </Button>
      ) : null}
    </Panel>
  );
}

function PaymentForm(props: PaySupplierViewProps & ViewBaseProps) {
  const { t, locale, form, on } = props;
  const methods = activeMethodChoices(props.methods, locale, t);
  const method = methods.find((m) => m.paymentMethodId === form.methodId);
  // An amount no open purchase can take blocks the payment (no advances); a split the merchant typed is judged by the server.
  const blocked = props.proposed && !form.manual && isNonZeroMinor(props.unallocatedMinor);
  return (
    <Stack>
      <Select
        label={t('payments.method')}
        value={form.methodId}
        error={form.errors.method ? t('payments.methodRequired') : undefined}
        options={[{ value: '', label: t('payments.chooseMethod') }, ...methods.map((m) => ({ value: m.paymentMethodId, label: m.name }))]}
        onChange={(v) => on.onField('methodId', v)}
      />
      {form.currencyOptions.length > 1 ? (
        <Select
          label={t('payments.payIn')}
          value={form.currency}
          options={form.currencyOptions.map((c) => ({ value: c, label: c }))}
          onChange={(v) => on.onField('currency', v)}
        />
      ) : null}
      <TextField
        label={t('payments.amountPaid', { currency: form.currency })}
        inputMode="decimal"
        value={form.amount}
        error={form.errors.amount ? t('purchasing.receive.amountInvalid') : undefined}
        onChange={(v) => on.onField('amount', v)}
      />
      <TextField
        label={t('common.date')}
        type="date"
        value={form.date}
        error={form.errors.date ? t('purchasing.receive.dateRequired') : undefined}
        onChange={(v) => on.onField('date', v)}
      />
      <TextField
        label={method?.requiresReference ? t('payments.reference') : `${t('payments.reference')} (${t('common.optional')})`}
        value={form.reference}
        error={form.errors.reference ? t('payments.referenceRequired') : undefined}
        onChange={(v) => on.onField('reference', v)}
      />
      {!props.proposed ? (
        <Button variant="secondary" fullWidth loading={props.busy} onClick={on.onPropose}>
          {t('payments.showSplit')}
        </Button>
      ) : null}

      <Heading>{t('payments.settles')}</Heading>
      {props.rows.length === 0 ? <Muted>{t('suppliers.detail.noOpenPurchases')}</Muted> : null}
      {props.proposed && props.rows.length > 0 ? <Checkbox label={t('payments.changeSplit')} checked={form.manual} onChange={on.onToggleManual} /> : null}
      {form.errors.rows ? <Notice tone="danger">{t('payments.rowsInvalid')}</Notice> : null}
      {props.rows.map((row) => (
        <PayRow key={row.purchaseId} {...props} row={row} />
      ))}
      {blocked && props.unallocatedMinor !== null ? (
        <Notice tone="warning">
          {rich(t('payments.unallocated'), { amount: <Money amountMinor={props.unallocatedMinor} currency={form.currency} locale={locale} /> })}
        </Notice>
      ) : null}
      {props.proposed ? (
        <Button fullWidth loading={props.busy} disabled={blocked} onClick={on.onSubmit}>
          {t('payments.submit')}
        </Button>
      ) : null}
    </Stack>
  );
}

function PayRow(props: PaySupplierViewProps & ViewBaseProps & { row: PayRowModel }) {
  const { t, locale, row, form, on } = props;
  const sameCurrency = row.currency === form.currency;
  return (
    <Panel>
      <Inline gap={2}>
        <CivilDate iso={row.documentDate} locale={locale} />
        {row.supplierReference ? <bdi>{row.supplierReference}</bdi> : null}
      </Inline>
      <Muted>
        {rich(t('payments.stillOwed'), {
          amount: <Money amountMinor={row.outstandingTxnMinor} currency={row.currency} locale={locale} />,
          total: <Money amountMinor={row.totalTxnMinor} currency={row.currency} locale={locale} />,
        })}
      </Muted>
      {form.manual ? (
        <Stack gap={2}>
          <TextField
            label={t('payments.rowAmount', { currency: form.currency })}
            inputMode="decimal"
            value={row.amount}
            error={row.invalid ? t('purchasing.receive.amountInvalid') : undefined}
            onChange={(v) => on.onRowAmount(row.purchaseId, v)}
          />
          {!sameCurrency ? (
            <TextField
              label={t('payments.amountSettles', { currency: row.currency })}
              inputMode="decimal"
              value={row.applied}
              error={row.invalid ? t('purchasing.receive.amountInvalid') : undefined}
              onChange={(v) => on.onRowApplied(row.purchaseId, v)}
            />
          ) : null}
        </Stack>
      ) : props.proposed ? (
        <Text strong>
          {row.proposedMinor !== null && isNonZeroMinor(row.proposedMinor)
            ? rich(t('payments.pays'), { amount: <Money amountMinor={row.proposedMinor} currency={row.currency} locale={locale} /> })
            : t('payments.notPaid')}
        </Text>
      ) : null}
    </Panel>
  );
}

function Favour(props: PaySupplierViewProps & ViewBaseProps & { favour: NonNullable<PaySupplierViewProps['favour']> }) {
  const { t, locale, favour, on } = props;
  const use = favour.use;
  return (
    <Panel>
      <Text strong>{t('suppliers.balance.inYourFavour')}</Text>
      <Muted>{t('payments.favour.explain')}</Muted>
      <List
        items={favour.notes.map((n) => ({
          key: n.creditNoteId,
          primary: <Money amountMinor={n.remainingTxnMinor} currency={n.currency} locale={locale} />,
          secondary: rich(t('suppliers.detail.favourSince'), { date: <CivilDate iso={n.issuedOn} locale={locale} /> }),
          trailing:
            use === null ? (
              <Button variant="secondary" onClick={() => on.onUseFavour(n.creditNoteId)}>
                {t('payments.favour.use')}
              </Button>
            ) : undefined,
        }))}
      />
      {use ? (
        <Stack gap={3}>
          {use.done ? <Notice tone="success">{t('payments.favour.done')}</Notice> : null}
          {!use.done && use.rows.length === 0 ? <Muted>{t('suppliers.detail.noOpenPurchases')}</Muted> : null}
          {!use.done && use.rows.length > 0 ? (
            <List
              items={use.rows.map((r) => ({
                key: r.purchaseId,
                primary: <CivilDate iso={r.documentDate} locale={locale} />,
                trailing: <Money amountMinor={r.proposedMinor} currency={use.currency} locale={locale} />,
              }))}
            />
          ) : null}
          {!use.done && isNonZeroMinor(use.unallocatedMinor) && use.unallocatedMinor !== null ? (
            <Muted>{rich(t('payments.favour.left'), { amount: <Money amountMinor={use.unallocatedMinor} currency={use.currency} locale={locale} /> })}</Muted>
          ) : null}
          {!use.done && use.rows.length > 0 ? (
            <Button fullWidth loading={use.busy} onClick={on.onApplyFavour}>
              {t('payments.favour.apply')}
            </Button>
          ) : null}
          <Button variant="ghost" fullWidth disabled={use.busy} onClick={on.onCancelFavour}>
            {use.done ? t('common.close') : t('common.cancel')}
          </Button>
        </Stack>
      ) : null}
    </Panel>
  );
}
