/**
 * The credit sale (البيع بالدين): goods handed to a named customer now, to be
 * paid for later. One `POST /v1/sales` with `settlementMode: 'credit'`.
 *
 * A pure view. It computes nothing: before the sale is saved it shows only
 * what the merchant is typing (where it is sold from, the dates, the items and
 * their quantities) — no price and no total, because every price is the
 * server's catalogue figure and every total the server's sum. After the sale
 * is saved every figure on it is the server's answer, re-spelled by `Money`
 * and never combined with another.
 *
 * A refusal is shown beside the form, which keeps everything typed (the page
 * sets the refusal and touches nothing else). A replay of a sale already saved
 * is a success, said as such. A sale already stored under this form's id is
 * shown as it was saved, not as the form now reads.
 *
 * Not rendered, from a `SaleDto`: the cost of the goods, the exchange rate and
 * its source, the base-currency figures, and every engine identity.
 */
import { Button, Card, List, TextField } from '@daftar/design-system';
import type { CustomerStatusDto, InventoryWarehouseDto, SaleDto } from '@daftar/shared-contracts';
import { Ltr, rich, type ViewBaseProps } from '@/lib/phase3-format';
import { RefusalNotice } from '../common/feedback';
import { CivilDate, Heading, Money, Muted, Notice, Quantity, Stack, Text, Title } from '../common/primitives';
import type { DraftLine, PickOption } from '../stock/model';
import { ItemName, ItemPicker, LineCard, WarehouseSelect } from '../stock/parts';
import type { CreditSaleFormModel } from './credit-sale';

export type CreditSaleFormField = 'warehouseId' | 'documentDate' | 'dueDate';

export interface CreditSaleViewProps {
  customer: { name: string; status: CustomerStatusDto };
  warehouses: readonly InventoryWarehouseDto[];
  form: CreditSaleFormModel;
  search: string;
  /** The item search's answer; null before the first one. */
  options: readonly PickOption[] | null;
  lines: readonly DraftLine[];
  lineErrors: Readonly<Record<string, string>>;
  unitNames: Readonly<Record<string, string>>;
  busy: boolean;
  errorKey: string | null;
  result: SaleDto | null;
  /** A sale already stored under this form's id, as the server read it back (`credit-sale-flow.ts`). */
  stored: SaleDto | null;
  /** This form's sale may be stored but could not be read: no form and no new form, only "read again". */
  storedUnread: boolean;
  on: {
    onField: (field: CreditSaleFormField, value: string) => void;
    onSearch: (text: string) => void;
    onPick: (option: PickOption) => void;
    onQuantity: (lineKey: string, value: string) => void;
    onRemove: (lineKey: string) => void;
    onSubmit: () => void;
    onRereadStored: () => void;
    /** A new form with new ids. Offered only beside a saved or an already-stored sale. */
    onStartOver: () => void;
  };
}

export function CreditSaleView(props: CreditSaleViewProps & ViewBaseProps) {
  const { t, locale } = props;
  if (props.result) return <Saved {...props} sale={props.result} replayed={props.result.replayed} />;
  if (props.stored) return <Saved {...props} sale={props.stored} replayed={false} alreadyRecorded />;
  return (
    <Stack>
      <Title>{t('sales.credit.title')}</Title>
      <Text strong>
        <bdi>{props.customer.name}</bdi>
      </Text>
      {props.customer.status === 'inactive' ? <Notice tone="warning">{t('sales.credit.customerInactive')}</Notice> : null}
      {props.storedUnread ? null : <SaleForm {...props} />}
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
      {props.storedUnread ? (
        <Button fullWidth loading={props.busy} disabled={props.busy} onClick={props.on.onRereadStored}>
          {t('sales.credit.readAgain')}
        </Button>
      ) : null}
    </Stack>
  );
}

function SaleForm(props: CreditSaleViewProps & ViewBaseProps) {
  const { t, locale, form, on } = props;
  const active = props.warehouses.filter((w) => w.status === 'active');
  const added = new Set(props.lines.map((l) => l.key));
  return (
    <Stack>
      {active.length === 0 ? <Notice tone="info">{t('sales.credit.noWarehouse')}</Notice> : null}
      <WarehouseSelect
        t={t}
        label={t('sales.credit.warehouse')}
        warehouses={props.warehouses}
        value={form.warehouseId}
        disabled={props.busy}
        onChange={(v) => on.onField('warehouseId', v)}
      />
      {form.errors.warehouse ? <Notice tone="danger">{t('sales.credit.warehouseRequired')}</Notice> : null}
      <TextField
        label={t('common.date')}
        type="date"
        value={form.documentDate}
        error={form.errors.date ? t('sales.credit.dateRequired') : undefined}
        onChange={(v) => on.onField('documentDate', v)}
      />
      <TextField
        label={`${t('sales.credit.dueDate')} (${t('common.optional')})`}
        type="date"
        value={form.dueDate}
        error={form.errors.dueDate ? t('sales.credit.dueDateInvalid') : undefined}
        onChange={(v) => on.onField('dueDate', v)}
      />

      <Heading>{t('sales.credit.items')}</Heading>
      <Muted>{t('sales.credit.pricesHint')}</Muted>
      <ItemPicker
        t={t}
        locale={locale}
        search={props.search}
        options={props.options}
        added={added}
        unitNames={props.unitNames}
        disabled={props.busy}
        onSearch={on.onSearch}
        onPick={on.onPick}
      />
      {form.errors.lines ? <Notice tone="danger">{t('sales.credit.noLines')}</Notice> : null}
      {form.errors.tooMany ? <Notice tone="danger">{t('sales.credit.tooMany')}</Notice> : null}
      {props.lines.map((line) => (
        <LineCard
          key={line.lineKey}
          t={t}
          locale={locale}
          line={line}
          unitNames={props.unitNames}
          quantityLabel={t('sales.credit.quantity')}
          showCost={false}
          currency={null}
          errorKey={props.lineErrors[line.lineKey] ?? null}
          disabled={props.busy}
          onQuantity={(v) => on.onQuantity(line.lineKey, v)}
          onCost={() => undefined}
          onRemove={() => on.onRemove(line.lineKey)}
        />
      ))}
      <Button fullWidth loading={props.busy} disabled={props.busy} onClick={on.onSubmit}>
        {t('sales.credit.submit')}
      </Button>
    </Stack>
  );
}

/**
 * A sale the server has: just saved (or replayed), or already stored under this form's id. Every figure
 * is the server's. An already-stored sale says so first, so it is not entered a second time.
 */
function Saved(props: CreditSaleViewProps & ViewBaseProps & { sale: SaleDto; replayed: boolean; alreadyRecorded?: boolean }) {
  const { t, locale, sale } = props;
  const due = sale.invoice.dueDate;
  return (
    <Stack>
      <Title>{t('sales.credit.title')}</Title>
      <Notice tone="success">
        <Stack gap={2}>
          <Text strong>{props.alreadyRecorded ? t('sales.credit.alreadyRecorded') : t('sales.credit.done')}</Text>
          {props.replayed ? <Text>{t('sales.credit.alreadySaved')}</Text> : null}
          <Text>
            {rich(t('sales.credit.doneOwed'), {
              amount: <Money amountMinor={sale.totalTxnMinor} currency={sale.currencyCode} locale={locale} />,
              name: <bdi>{props.customer.name}</bdi>,
            })}
          </Text>
          <Text>{due !== null ? rich(t('sales.credit.dueOn'), { date: <CivilDate iso={due} locale={locale} /> }) : t('sales.credit.noDue')}</Text>
        </Stack>
      </Notice>
      <Heading>{rich(t('sales.credit.invoiceNumber'), { number: <Ltr>{sale.invoice.number.documentNumber}</Ltr> })}</Heading>
      <Card>
        <List
          items={sale.lines.map((line) => ({
            key: line.lineId,
            primary: <ItemName name={line.nameSnapshot} variantName={null} />,
            trailing: (
              <Stack gap={1}>
                {/* A `SaleLineDto` carries no unit precision: the server's decimal text is re-spelled, padded to nothing. */}
                <Quantity value={line.quantity} decimals={0} locale={locale} />
                <Money amountMinor={line.netTxnMinor} currency={sale.currencyCode} locale={locale} />
              </Stack>
            ),
          }))}
        />
      </Card>
      <Text strong>{rich(t('sales.credit.total'), { amount: <Money amountMinor={sale.totalTxnMinor} currency={sale.currencyCode} locale={locale} /> })}</Text>
      <Button fullWidth onClick={props.on.onStartOver}>
        {t('sales.credit.another')}
      </Button>
    </Stack>
  );
}
