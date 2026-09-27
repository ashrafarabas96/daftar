/**
 * Supplier (P3-S7 contract A-11, TL-5): what is still owed per currency, the
 * balance in your favour, the open purchases, the payments and the purchases
 * of one supplier. The owed figures, the balance in your favour and the
 * payments are business-wide reads (S4 TL-4, Annex R #5): an assigned-scope
 * caller sees the open purchases and purchases of the warehouses they reach.
 *
 * "Get money back" sits under the balance in your favour (business-wide +
 * `suppliers.pay`). No statement or ageing is built here (TL-5).
 */
import { Button, Checkbox, List, Select, TextField } from '@daftar/design-system';
import { formatCivilDate, formatMoney, rich, type ViewBaseProps } from '@/lib/phase3-format';
import { RefusalNotice } from '../common/feedback';
import { activeMethodChoices } from '../common/payment-methods';
import { Amounts, CivilDate, Heading, Inline, Money, Muted, Notice, Panel, Stack, Text, Title } from '../common/primitives';
import { PurchaseStatusBadge } from '../purchases/PurchaseListView';
import type { PurchaseRowModel } from '../purchases/types';
import { SupplierStatusBadge } from './SupplierListView';
import type { SupplierPaymentDto } from '@daftar/shared-contracts';
import type { FavourNoteModel, MoneyBackForm, OpenPurchaseRowModel } from './types';

export type MoneyBackField = 'creditNoteId' | 'methodId' | 'amount' | 'date' | 'receiptCurrency' | 'receiptAmount' | 'reference';

export interface SupplierDetailViewProps {
  supplier: { supplierId: string; name: string; status: 'active' | 'inactive'; phone: string | null; email: string | null };
  /** Null for an assigned-scope caller (business-wide reads). */
  owed: { currency: string; amountMinor: string }[] | null;
  favourNotes: FavourNoteModel[] | null;
  /** As the server answered them (entry ids included — never rendered); null for an assigned-scope caller. */
  payments: SupplierPaymentDto[] | null;
  openPurchases: OpenPurchaseRowModel[];
  purchases: PurchaseRowModel[];
  canPay: boolean;
  /** Null unless the caller may get money back (business-wide + `suppliers.pay`) and there is a balance in their favour. */
  moneyBack: MoneyBackForm | null;
  errorKey: string | null;
  on: {
    onPay: () => void;
    onOpenPurchase: (purchaseId: string) => void;
    onStartMoneyBack: () => void;
    onMoneyBackField: (field: MoneyBackField, value: string) => void;
    onToggleDifferentCurrency: () => void;
    onSubmitMoneyBack: () => void;
    onCancelMoneyBack: () => void;
    onBack: () => void;
  };
}

export function SupplierDetailView(props: SupplierDetailViewProps & ViewBaseProps) {
  const { t, locale, supplier, on } = props;
  return (
    <Stack>
      <Inline gap={2}>
        <Title>
          <bdi>{supplier.name}</bdi>
        </Title>
        <SupplierStatusBadge t={t} status={supplier.status} />
      </Inline>
      {supplier.phone ? (
        <Muted>
          <bdi>{supplier.phone}</bdi>
        </Muted>
      ) : null}
      {supplier.email ? (
        <Muted>
          <bdi>{supplier.email}</bdi>
        </Muted>
      ) : null}
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />

      {props.owed !== null ? (
        <Panel>
          <Text strong>{t('suppliers.balance.youOwe')}</Text>
          {props.owed.length === 0 ? <Muted>{t('suppliers.balance.nothingOwed')}</Muted> : <Amounts amounts={props.owed} locale={locale} />}
        </Panel>
      ) : null}
      {props.canPay ? (
        <Button fullWidth onClick={on.onPay}>
          {t('payments.title')}
        </Button>
      ) : null}

      {props.favourNotes !== null && props.favourNotes.length > 0 ? (
        <Panel>
          <Text strong>{t('suppliers.balance.inYourFavour')}</Text>
          <List
            items={props.favourNotes.map((n) => ({
              key: n.creditNoteId,
              primary: <Money amountMinor={n.remainingTxnMinor} currency={n.currency} locale={locale} />,
              secondary: rich(t('suppliers.detail.favourSince'), { date: <CivilDate iso={n.issuedOn} locale={locale} /> }),
            }))}
          />
          {props.moneyBack ? <MoneyBack {...props} form={props.moneyBack} /> : null}
        </Panel>
      ) : null}

      <Heading>{t('suppliers.detail.openPurchases')}</Heading>
      {props.openPurchases.length === 0 ? (
        <Muted>{t('suppliers.detail.noOpenPurchases')}</Muted>
      ) : (
        <List
          items={props.openPurchases.map((p) => ({
            key: p.purchaseId,
            onClick: () => on.onOpenPurchase(p.purchaseId),
            primary: <CivilDate iso={p.documentDate} locale={locale} />,
            secondary: p.supplierReference ? <bdi>{p.supplierReference}</bdi> : undefined,
            trailing: (
              <Stack gap={1}>
                <Money amountMinor={p.outstandingTxnMinor} currency={p.currency} locale={locale} />
                <Muted>{rich(t('suppliers.detail.ofTotal'), { total: <Money amountMinor={p.totalTxnMinor} currency={p.currency} locale={locale} /> })}</Muted>
              </Stack>
            ),
          }))}
        />
      )}

      {props.payments !== null ? (
        <>
          <Heading>{t('suppliers.detail.payments')}</Heading>
          {props.payments.length === 0 ? (
            <Muted>{t('suppliers.detail.noPayments')}</Muted>
          ) : (
            <List
              items={props.payments.map((p) => ({
                key: p.paymentId,
                primary: <CivilDate iso={p.paymentDate} locale={locale} />,
                secondary: p.reference ? <bdi>{p.reference}</bdi> : undefined,
                trailing: <Money amountMinor={p.amountMinor} currency={p.currency} locale={locale} />,
              }))}
            />
          )}
        </>
      ) : null}

      <Heading>{t('suppliers.detail.purchases')}</Heading>
      {props.purchases.length === 0 ? (
        <Muted>{t('purchasing.list.empty')}</Muted>
      ) : (
        <List
          items={props.purchases.map((p) => ({
            key: p.purchaseId,
            onClick: () => on.onOpenPurchase(p.purchaseId),
            primary: <CivilDate iso={p.documentDate} locale={locale} />,
            secondary: (
              <Inline gap={2}>
                <span>{p.warehouseName}</span>
                <PurchaseStatusBadge t={t} status={p.status} />
              </Inline>
            ),
            trailing: <Money amountMinor={p.totalTxnMinor} currency={p.currency} locale={locale} />,
          }))}
        />
      )}
      <Button variant="ghost" fullWidth onClick={on.onBack}>
        {t('common.back')}
      </Button>
    </Stack>
  );
}

function MoneyBack(props: SupplierDetailViewProps & ViewBaseProps & { form: MoneyBackForm }) {
  const { t, locale, form, on } = props;
  if (form.done) {
    return (
      <Notice tone="success">
        {rich(t('suppliers.moneyBack.done'), {
          amount: <Money amountMinor={form.done.receiptAmountMinor} currency={form.done.receiptCurrency} locale={locale} />,
        })}
      </Notice>
    );
  }
  if (!form.open) {
    return (
      <Button variant="secondary" fullWidth onClick={on.onStartMoneyBack}>
        {t('suppliers.moneyBack.title')}
      </Button>
    );
  }
  const note = form.notes.find((n) => n.creditNoteId === form.creditNoteId);
  const methods = activeMethodChoices(form.methods, locale, t);
  const method = methods.find((m) => m.paymentMethodId === form.methodId);
  return (
    <Stack gap={3}>
      <Text strong>{t('suppliers.moneyBack.title')}</Text>
      <Muted>{t('suppliers.moneyBack.explain')}</Muted>
      {form.notes.length > 1 ? (
        <Select
          label={t('suppliers.moneyBack.fromBalance')}
          value={form.creditNoteId}
          error={form.errors.note ? t('suppliers.moneyBack.noteRequired') : undefined}
          options={[
            { value: '', label: t('suppliers.moneyBack.chooseBalance') },
            ...form.notes.map((n) => ({
              value: n.creditNoteId,
              label: `${formatMoney(n.remainingTxnMinor, n.currency, locale)} · ${formatCivilDate(n.issuedOn, locale)}`,
            })),
          ]}
          onChange={(v) => on.onMoneyBackField('creditNoteId', v)}
        />
      ) : null}
      {methods.length === 0 ? (
        <Notice tone="info">{t('payments.noMethodYet')}</Notice>
      ) : (
        <Select
          label={t('suppliers.moneyBack.receivedBy')}
          value={form.methodId}
          error={form.errors.method ? t('payments.methodRequired') : undefined}
          options={[{ value: '', label: t('payments.chooseMethod') }, ...methods.map((m) => ({ value: m.paymentMethodId, label: m.name }))]}
          onChange={(v) => on.onMoneyBackField('methodId', v)}
        />
      )}
      <TextField
        label={t('suppliers.moneyBack.amount', { currency: note?.currency ?? '' })}
        inputMode="decimal"
        value={form.amount}
        error={form.errors.amount ? t('purchasing.receive.amountInvalid') : undefined}
        onChange={(v) => on.onMoneyBackField('amount', v)}
      />
      <TextField label={t('common.date')} type="date" value={form.date} onChange={(v) => on.onMoneyBackField('date', v)} />
      <Checkbox label={t('suppliers.moneyBack.differentCurrency')} checked={form.differentCurrency} onChange={on.onToggleDifferentCurrency} />
      {form.differentCurrency ? (
        <>
          <Select
            label={t('suppliers.moneyBack.receivedIn')}
            value={form.receiptCurrency}
            options={form.currencies.map((c) => ({ value: c, label: c }))}
            onChange={(v) => on.onMoneyBackField('receiptCurrency', v)}
          />
          <TextField
            label={t('suppliers.moneyBack.receivedAmount', { currency: form.receiptCurrency })}
            inputMode="decimal"
            value={form.receiptAmount}
            error={form.errors.receiptAmount ? t('purchasing.receive.amountInvalid') : undefined}
            onChange={(v) => on.onMoneyBackField('receiptAmount', v)}
          />
        </>
      ) : null}
      <TextField
        label={method?.requiresReference ? t('payments.reference') : `${t('payments.reference')} (${t('common.optional')})`}
        value={form.reference}
        error={form.errors.reference ? t('payments.referenceRequired') : undefined}
        onChange={(v) => on.onMoneyBackField('reference', v)}
      />
      <Button fullWidth loading={form.busy} onClick={on.onSubmitMoneyBack}>
        {t('suppliers.moneyBack.submit')}
      </Button>
      <Button variant="ghost" fullWidth disabled={form.busy} onClick={on.onCancelMoneyBack}>
        {t('common.cancel')}
      </Button>
    </Stack>
  );
}
