/**
 * Receive Purchase (P3-S7 contract A-11, A-13).
 *
 * Progressive disclosure: the default form is supplier, warehouse, date and
 * lines (item, quantity, unit price), with an optional supplier reference and
 * note. "Different currency", "Add discount" (per line) and "Add extra cost"
 * (by value; "Split manually" is a second level) are one tap away. "Review"
 * saves the draft and shows the SERVER's totals; "Receive" then posts — one
 * confirmation step (SIM-10). "Paid now" switches the last call to
 * receive-and-pay, for a holder of `suppliers.pay` only.
 *
 * No tax or duty field, option or preset exists here: BLOCKED BY OD-03.
 */
import { Button, Checkbox, List, Select, Switch, TextField, Textarea } from '@daftar/design-system';
import { minorUnitsOf } from '@daftar/shared-contracts';
import { Ltr, formatDecimalText, rich, type ViewBaseProps } from '@/lib/phase3-format';
import { isNonZeroMinor } from '../common/amount-text';
import { activeMethodChoices } from '../common/payment-methods';
import { ExchangeRatePrompt, RefusalNotice, type ExchangeRatePromptProps } from '../common/feedback';
import { Fact, Heading, Inline, Money, Muted, Notice, Panel, Quantity, Stack, Text, Title } from '../common/primitives';
import {
  EXTRA_COST_KINDS,
  type ExtraCostForm,
  type ExtraCostKind,
  type ItemOption,
  type PayNowForm,
  type ReceiveForm,
  type ReceiveLineForm,
  type ReceiveResultModel,
  type ReceiveReviewModel,
  type ReceiveStep,
  type SupplierOption,
} from './types';

export type LineField = 'quantity' | 'unitPrice' | 'discount';
export type PayField = 'methodId' | 'payCurrency' | 'amount' | 'applied' | 'reference';

export interface ReceiveHandlers {
  onSupplierSearch: (text: string) => void;
  onPickSupplier: (supplier: SupplierOption) => void;
  onClearSupplier: () => void;
  onStartNewSupplier: () => void;
  onNewSupplierName: (name: string) => void;
  onCreateSupplier: () => void;
  onCancelNewSupplier: () => void;
  onWarehouse: (warehouseId: string) => void;
  onDate: (date: string) => void;
  onToggleCurrency: () => void;
  onCurrency: (currency: string) => void;
  onReference: (value: string) => void;
  onNotes: (value: string) => void;
  onAddLine: () => void;
  onRemoveLine: (lineId: string) => void;
  onLineItemSearch: (lineId: string, text: string) => void;
  onPickItem: (lineId: string, item: ItemOption) => void;
  onClearItem: (lineId: string) => void;
  onLineVariant: (lineId: string, variantId: string) => void;
  onLineField: (lineId: string, field: LineField, value: string) => void;
  onToggleDiscount: (lineId: string) => void;
  onAddExtraCost: () => void;
  onRemoveExtraCost: (landedCostId: string) => void;
  onExtraCostKind: (landedCostId: string, kind: ExtraCostKind) => void;
  onExtraCostAmount: (landedCostId: string, value: string) => void;
  onToggleManualSplit: (landedCostId: string) => void;
  onExtraCostShare: (landedCostId: string, lineId: string, value: string) => void;
  onReview: () => void;
  onBackToEdit: () => void;
  onTogglePayNow: () => void;
  onPayField: (field: PayField, value: string) => void;
  onReceive: () => void;
  onCancelDraft: () => void;
  onNewPurchase: () => void;
}

export interface ReceivePurchaseViewProps {
  step: ReceiveStep;
  form: ReceiveForm;
  warehouses: { warehouseId: string; name: string }[];
  currencies: { code: string; name: string }[];
  baseCurrency: string;
  /** False without `suppliers.manage`: the merchant picks an existing supplier only. */
  canCreateSupplier: boolean;
  /** False without `purchases.receive`: the draft can be saved and reviewed, not received. */
  canReceive: boolean;
  /** True once the draft exists on the server (revision ≥ 1), so it can be cancelled. */
  savedDraft: boolean;
  review: ReceiveReviewModel | null;
  /** Null without `suppliers.pay` (Annex R #6). */
  payNow: PayNowForm | null;
  result: ReceiveResultModel | null;
  busy: boolean;
  errorKey: string | null;
  exchangeRate: ExchangeRatePromptProps | null;
  on: ReceiveHandlers;
}

export function ReceivePurchaseView(props: ReceivePurchaseViewProps & ViewBaseProps) {
  const { t, locale } = props;
  if (props.step === 'done' && props.result) return <ReceiptResult {...props} result={props.result} />;
  return (
    <Stack>
      <Title>{t('purchasing.receive.title')}</Title>
      {props.step === 'review' && props.review ? <ReviewStep {...props} review={props.review} /> : <EditStep {...props} />}
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
      {props.exchangeRate ? <ExchangeRatePrompt t={t} locale={locale} {...props.exchangeRate} /> : null}
    </Stack>
  );
}

// ── Edit ─────────────────────────────────────────────────────────────────

function EditStep(props: ReceivePurchaseViewProps & ViewBaseProps) {
  const { t, form, on } = props;
  return (
    <Stack>
      <SupplierPicker {...props} />
      <Select
        label={t('common.warehouse')}
        value={form.warehouseId}
        error={form.errors.warehouse ? t('purchasing.receive.warehouseRequired') : undefined}
        options={[{ value: '', label: t('purchasing.receive.chooseWarehouse') }, ...props.warehouses.map((w) => ({ value: w.warehouseId, label: w.name }))]}
        onChange={on.onWarehouse}
      />
      <TextField
        label={t('common.date')}
        type="date"
        value={form.documentDate}
        error={form.errors.date ? t('purchasing.receive.dateRequired') : undefined}
        onChange={on.onDate}
      />
      {form.showCurrency ? (
        <Select
          label={t('common.currency')}
          value={form.currency}
          options={props.currencies.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))}
          onChange={on.onCurrency}
        />
      ) : (
        <Button variant="ghost" fullWidth onClick={on.onToggleCurrency}>
          {t('purchasing.receive.differentCurrency')}
        </Button>
      )}
      <Heading>{t('purchasing.receive.lines')}</Heading>
      {form.errors.lines ? <Notice tone="danger">{t('purchasing.receive.linesRequired')}</Notice> : null}
      {form.lines.map((line, index) => (
        <LineEditor key={line.lineId} {...props} line={line} position={index + 1} removable={form.lines.length > 1} />
      ))}
      <Button variant="secondary" fullWidth onClick={on.onAddLine}>
        {t('purchasing.receive.addLine')}
      </Button>
      {form.extraCosts.map((cost) => (
        <ExtraCostEditor key={cost.landedCostId} {...props} cost={cost} />
      ))}
      <Button variant="ghost" fullWidth onClick={on.onAddExtraCost}>
        {t('purchasing.receive.addExtraCost')}
      </Button>
      <TextField label={`${t('purchasing.receive.supplierReference')} (${t('common.optional')})`} value={form.supplierReference} onChange={on.onReference} />
      <Textarea label={`${t('common.note')} (${t('common.optional')})`} value={form.notes} onChange={on.onNotes} />
      <Button fullWidth loading={props.busy} onClick={on.onReview}>
        {t('common.review')}
      </Button>
      {props.savedDraft ? (
        <Button variant="danger" fullWidth disabled={props.busy} onClick={on.onCancelDraft}>
          {t('purchasing.receive.cancelDraft')}
        </Button>
      ) : null}
    </Stack>
  );
}

function SupplierPicker(props: ReceivePurchaseViewProps & ViewBaseProps) {
  const { t, form, on } = props;
  if (form.supplier) {
    return (
      <Panel>
        <Muted>{t('purchasing.receive.supplier')}</Muted>
        <Text strong>
          <bdi>{form.supplier.name}</bdi>
        </Text>
        <Button variant="secondary" fullWidth onClick={on.onClearSupplier}>
          {t('purchasing.receive.changeSupplier')}
        </Button>
      </Panel>
    );
  }
  if (form.newSupplierName !== null) {
    return (
      <Panel>
        <TextField label={t('purchasing.receive.newSupplierName')} value={form.newSupplierName} onChange={on.onNewSupplierName} />
        {form.duplicateOf ? <Notice tone="info">{t('suppliers.duplicateName', { name: form.duplicateOf })}</Notice> : null}
        <Button fullWidth loading={props.busy} onClick={on.onCreateSupplier}>
          {t('purchasing.receive.addSupplier')}
        </Button>
        <Button variant="ghost" fullWidth onClick={on.onCancelNewSupplier}>
          {t('common.cancel')}
        </Button>
      </Panel>
    );
  }
  return (
    <Panel>
      <TextField
        label={t('purchasing.receive.supplier')}
        type="search"
        value={form.supplierSearch}
        placeholder={t('purchasing.receive.searchSupplier')}
        error={form.errors.supplier ? t('purchasing.receive.supplierRequired') : undefined}
        onChange={on.onSupplierSearch}
      />
      {form.supplierResults.length > 0 ? (
        <List items={form.supplierResults.map((s) => ({ key: s.supplierId, primary: s.name, onClick: () => on.onPickSupplier(s) }))} />
      ) : null}
      {props.canCreateSupplier ? (
        <Button variant="ghost" fullWidth onClick={on.onStartNewSupplier}>
          {t('purchasing.receive.newSupplier')}
        </Button>
      ) : null}
    </Panel>
  );
}

function LineEditor(props: ReceivePurchaseViewProps & ViewBaseProps & { line: ReceiveLineForm; position: number; removable: boolean }) {
  const { t, line, on } = props;
  const currency = props.form.currency;
  return (
    <Panel>
      <Muted>{rich(t('purchasing.receive.lineNumber'), { n: <Ltr>{props.position}</Ltr> })}</Muted>
      {line.item ? (
        <Stack gap={2}>
          <Text strong>{line.item.name}</Text>
          <Button variant="secondary" fullWidth onClick={() => on.onClearItem(line.lineId)}>
            {t('purchasing.receive.changeItem')}
          </Button>
        </Stack>
      ) : (
        <Stack gap={2}>
          <TextField
            label={t('common.item')}
            type="search"
            value={line.itemSearch}
            placeholder={t('purchasing.receive.searchItem')}
            error={line.errors.item ? t('purchasing.receive.itemRequired') : undefined}
            onChange={(v) => on.onLineItemSearch(line.lineId, v)}
          />
          {line.itemResults.length > 0 ? (
            <List items={line.itemResults.map((item) => ({ key: item.productId, primary: item.name, onClick: () => on.onPickItem(line.lineId, item) }))} />
          ) : null}
        </Stack>
      )}
      {line.item && line.item.variants.length > 0 ? (
        <Select
          label={t('purchasing.receive.variant')}
          value={line.variantId ?? ''}
          error={line.errors.variant ? t('purchasing.receive.variantRequired') : undefined}
          options={[{ value: '', label: t('purchasing.receive.chooseVariant') }, ...line.item.variants.map((v) => ({ value: v.variantId, label: v.name }))]}
          onChange={(v) => on.onLineVariant(line.lineId, v)}
        />
      ) : null}
      <TextField
        label={t('common.quantity')}
        inputMode="decimal"
        value={line.quantity}
        error={line.errors.quantity ? t('purchasing.receive.quantityInvalid') : undefined}
        onChange={(v) => on.onLineField(line.lineId, 'quantity', v)}
      />
      <TextField
        label={t('purchasing.receive.unitPrice', { currency })}
        inputMode="decimal"
        value={line.unitPrice}
        error={line.errors.unitPrice ? t('purchasing.receive.amountInvalid') : undefined}
        onChange={(v) => on.onLineField(line.lineId, 'unitPrice', v)}
      />
      {line.showDiscount ? (
        <TextField
          label={t('purchasing.receive.discount', { currency })}
          inputMode="decimal"
          value={line.discount}
          error={line.errors.discount ? t('purchasing.receive.amountInvalid') : undefined}
          onChange={(v) => on.onLineField(line.lineId, 'discount', v)}
        />
      ) : (
        <Button variant="ghost" fullWidth onClick={() => on.onToggleDiscount(line.lineId)}>
          {t('purchasing.receive.addDiscount')}
        </Button>
      )}
      {props.removable ? (
        <Button variant="ghost" fullWidth onClick={() => on.onRemoveLine(line.lineId)}>
          {t('common.remove')}
        </Button>
      ) : null}
    </Panel>
  );
}

function ExtraCostEditor(props: ReceivePurchaseViewProps & ViewBaseProps & { cost: ExtraCostForm }) {
  const { t, cost, on, form } = props;
  return (
    <Panel>
      <Select
        label={t('purchasing.extraCost.kindLabel')}
        value={cost.kind}
        options={EXTRA_COST_KINDS.map((k) => ({ value: k, label: t(`purchasing.extraCost.kind.${k}`) }))}
        onChange={(v) => on.onExtraCostKind(cost.landedCostId, EXTRA_COST_KINDS.find((k) => k === v) ?? 'other')}
      />
      <TextField
        label={t('purchasing.extraCost.amount', { currency: form.currency })}
        inputMode="decimal"
        value={cost.amount}
        error={cost.errors.amount ? t('purchasing.receive.amountInvalid') : undefined}
        onChange={(v) => on.onExtraCostAmount(cost.landedCostId, v)}
      />
      <Muted>{cost.manual ? t('purchasing.extraCost.manualHint') : t('purchasing.extraCost.byValueHint')}</Muted>
      <Checkbox label={t('purchasing.extraCost.splitManually')} checked={cost.manual} onChange={() => on.onToggleManualSplit(cost.landedCostId)} />
      {cost.manual
        ? form.lines.map((line) => (
            <TextField
              key={line.lineId}
              label={line.item ? line.item.name : t('purchasing.receive.lineWithoutItem')}
              inputMode="decimal"
              value={cost.shares[line.lineId] ?? ''}
              error={cost.errors.shares ? t('purchasing.receive.amountInvalid') : undefined}
              onChange={(v) => on.onExtraCostShare(cost.landedCostId, line.lineId, v)}
            />
          ))
        : null}
      <Button variant="ghost" fullWidth onClick={() => on.onRemoveExtraCost(cost.landedCostId)}>
        {t('common.remove')}
      </Button>
    </Panel>
  );
}

// ── Review ───────────────────────────────────────────────────────────────

function ReviewStep(props: ReceivePurchaseViewProps & ViewBaseProps & { review: ReceiveReviewModel }) {
  const { t, locale, review, on } = props;
  return (
    <Stack>
      <Heading>{t('purchasing.receive.reviewTitle')}</Heading>
      {props.form.supplier ? (
        <Text strong>
          <bdi>{props.form.supplier.name}</bdi>
        </Text>
      ) : null}
      <List
        items={review.lines.map((line) => ({
          key: line.lineId,
          primary: line.variantName ? `${line.name} · ${line.variantName}` : line.name,
          secondary: (
            <Inline gap={2}>
              <Quantity value={line.qty} decimals={line.unitDecimals} locale={locale} />
              <span>×</span>
              <Ltr>{`${formatDecimalText(line.unitPrice, locale, minorUnitsOf(review.currency))} ${review.currency}`}</Ltr>
              {isNonZeroMinor(line.discountTxnMinor) ? (
                <span>
                  {rich(t('purchasing.receive.discountApplied'), {
                    amount: <Money amountMinor={line.discountTxnMinor} currency={review.currency} locale={locale} />,
                  })}
                </span>
              ) : null}
            </Inline>
          ),
          trailing: <Money amountMinor={line.netTxnMinor} currency={review.currency} locale={locale} />,
        }))}
      />
      <Fact label={t('purchasing.receive.subtotal')}>
        <Money amountMinor={review.subtotalTxnMinor} currency={review.currency} locale={locale} />
      </Fact>
      {isNonZeroMinor(review.landedCostTxnMinor) ? (
        <Fact label={t('purchasing.receive.extraCosts')}>
          <Money amountMinor={review.landedCostTxnMinor} currency={review.currency} locale={locale} />
        </Fact>
      ) : null}
      <Fact label={t('purchasing.receive.total')}>
        <Money amountMinor={review.totalTxnMinor} currency={review.currency} locale={locale} />
      </Fact>
      {props.payNow ? <PayNowEditor {...props} payNow={props.payNow} /> : null}
      {props.canReceive ? (
        <Button fullWidth loading={props.busy} onClick={on.onReceive}>
          {props.payNow?.on ? t('purchasing.receive.receiveAndPay') : t('purchasing.receive.receive')}
        </Button>
      ) : (
        <Notice tone="info">{t('purchasing.receive.savedNoReceive')}</Notice>
      )}
      <Button variant="secondary" fullWidth disabled={props.busy} onClick={on.onBackToEdit}>
        {t('common.edit')}
      </Button>
    </Stack>
  );
}

function PayNowEditor(props: ReceivePurchaseViewProps & ViewBaseProps & { payNow: PayNowForm }) {
  const { t, locale, payNow, on } = props;
  const methods = activeMethodChoices(payNow.methods, locale, t);
  const method = methods.find((m) => m.paymentMethodId === payNow.methodId);
  const purchaseCurrency = props.review?.currency ?? props.form.currency;
  return (
    <Panel>
      <Switch label={t('purchasing.receive.paidNow')} checked={payNow.on} onChange={on.onTogglePayNow} />
      {payNow.on && methods.length === 0 ? <Notice tone="info">{t('payments.noMethodYet')}</Notice> : null}
      {payNow.on && methods.length > 0 ? (
        <Stack gap={3}>
          <Select
            label={t('payments.method')}
            value={payNow.methodId}
            error={payNow.errors.method ? t('payments.methodRequired') : undefined}
            options={[{ value: '', label: t('payments.chooseMethod') }, ...methods.map((m) => ({ value: m.paymentMethodId, label: m.name }))]}
            onChange={(v) => on.onPayField('methodId', v)}
          />
          {payNow.currencyOptions.length > 1 ? (
            <Select
              label={t('payments.payIn')}
              value={payNow.payCurrency}
              options={payNow.currencyOptions.map((c) => ({ value: c, label: c }))}
              onChange={(v) => on.onPayField('payCurrency', v)}
            />
          ) : null}
          <TextField
            label={t('payments.amountPaid', { currency: payNow.payCurrency })}
            inputMode="decimal"
            value={payNow.amount}
            error={payNow.errors.amount ? t('purchasing.receive.amountInvalid') : undefined}
            onChange={(v) => on.onPayField('amount', v)}
          />
          {payNow.payCurrency !== purchaseCurrency ? (
            <TextField
              label={t('payments.amountSettles', { currency: purchaseCurrency })}
              inputMode="decimal"
              value={payNow.applied}
              error={payNow.errors.applied ? t('purchasing.receive.amountInvalid') : undefined}
              onChange={(v) => on.onPayField('applied', v)}
            />
          ) : null}
          <TextField
            label={method?.requiresReference ? t('payments.reference') : `${t('payments.reference')} (${t('common.optional')})`}
            value={payNow.reference}
            error={payNow.errors.reference ? t('payments.referenceRequired') : undefined}
            onChange={(v) => on.onPayField('reference', v)}
          />
          <Muted>{t('purchasing.receive.paidOnPurchaseDate')}</Muted>
        </Stack>
      ) : null}
    </Panel>
  );
}

// ── Done ─────────────────────────────────────────────────────────────────

function ReceiptResult(props: ReceivePurchaseViewProps & ViewBaseProps & { result: ReceiveResultModel }) {
  const { t, locale } = props;
  const { receipt, payment, baseCurrency } = props.result;
  return (
    <Stack>
      <Title>{t('purchasing.receive.title')}</Title>
      <Notice tone="success">
        <Stack gap={2}>
          <Text strong>{t('purchasing.receive.received')}</Text>
          <Fact label={t('purchasing.receive.total')}>
            <Money amountMinor={receipt.totalTxnMinor} currency={receipt.currency} locale={locale} />
          </Fact>
          {receipt.currency !== baseCurrency ? (
            <Muted>
              {rich(t('purchasing.receive.rateUsed'), {
                from: <Ltr>{`1 ${receipt.currency}`}</Ltr>,
                to: <Ltr>{`${formatDecimalText(receipt.rate.rate, locale)} ${baseCurrency}`}</Ltr>,
              })}
            </Muted>
          ) : null}
          {payment ? (
            <Fact label={t('purchasing.receive.paid')}>
              <Money amountMinor={payment.amountMinor} currency={payment.currency} locale={locale} />
            </Fact>
          ) : null}
          {(receipt.coverage?.coverages ?? []).map((c) => (
            <Muted key={c.coverageId}>
              {rich(t('purchasing.receive.coveredShort'), { qty: <Quantity value={c.qtyCovered} decimals={0} locale={locale} /> })}
            </Muted>
          ))}
        </Stack>
      </Notice>
      <Button fullWidth onClick={props.on.onNewPurchase}>
        {t('purchasing.receive.another')}
      </Button>
    </Stack>
  );
}
