/**
 * Return to Supplier (P3-S7 contract A-11, A-13, A-09(c)).
 *
 * The merchant picks quantities up to what the server says can go back
 * (`returnableQty` = the smaller of what is left of the purchase and what is
 * on hand, computed in SQL). There is no amount field: the server computes
 * every amount. When nothing can go back, the screen says why before the
 * merchant fills anything in. The result says either that the supplier now
 * owes the merchant, or that the merchant's balance with the supplier went
 * down — both figures are the server's.
 */
import { Button, List, TextField, Textarea } from '@daftar/design-system';
import { rich, type ViewBaseProps } from '@/lib/phase3-format';
import { RefusalNotice } from '../common/feedback';
import { CivilDate, Inline, Money, Muted, Notice, Panel, Quantity, Stack, Text, Title } from '../common/primitives';
import type { SupplierReturnResultDto } from '@daftar/shared-contracts';
import { isNonZeroMinor } from '../common/amount-text';
import type { ReturnBlock, ReturnLineForm } from './types';

export interface ReturnToSupplierViewProps {
  supplierName: string;
  documentDateOfPurchase: string;
  /** Null when something can be returned; otherwise why not (the S5 refusals, said first). */
  blocked: ReturnBlock | null;
  lines: ReturnLineForm[];
  documentDate: string;
  reason: string;
  nothingChosen: boolean;
  busy: boolean;
  errorKey: string | null;
  /** The server's answer (entry, movement and trace ids included — never rendered). */
  result: SupplierReturnResultDto | null;
  on: {
    onQuantity: (purchaseLineId: string, value: string) => void;
    onReturnAll: (purchaseLineId: string) => void;
    onDate: (value: string) => void;
    onReason: (value: string) => void;
    onSubmit: () => void;
    onBack: () => void;
  };
}

export function ReturnToSupplierView(props: ReturnToSupplierViewProps & ViewBaseProps) {
  const { t, locale, on } = props;
  const header = (
    <>
      <Title>{t('purchasing.return.title')}</Title>
      <Inline gap={2}>
        <Text strong>{props.supplierName}</Text>
        <CivilDate iso={props.documentDateOfPurchase} locale={locale} />
      </Inline>
    </>
  );
  if (props.result) {
    const r = props.result;
    return (
      <Stack>
        {header}
        <Notice tone="success">
          <Stack gap={2}>
            <Text strong>{t('purchasing.return.done')}</Text>
            {r.creditNote !== null && isNonZeroMinor(r.creditTxnMinor) ? (
              <Text>
                {rich(t('purchasing.return.supplierOwesYou'), { amount: <Money amountMinor={r.creditTxnMinor} currency={r.currency} locale={locale} /> })}
              </Text>
            ) : null}
            {isNonZeroMinor(r.apTxnMinor) ? (
              <Text>{rich(t('purchasing.return.balanceDown'), { amount: <Money amountMinor={r.apTxnMinor} currency={r.currency} locale={locale} /> })}</Text>
            ) : null}
          </Stack>
        </Notice>
        <Button fullWidth onClick={on.onBack}>
          {t('purchasing.return.backToPurchase')}
        </Button>
      </Stack>
    );
  }
  if (props.blocked !== null) {
    return (
      <Stack>
        {header}
        <Notice tone="info">{t(`purchasing.return.blocked.${props.blocked}`)}</Notice>
        <Button variant="secondary" fullWidth onClick={on.onBack}>
          {t('common.back')}
        </Button>
      </Stack>
    );
  }
  return (
    <Stack>
      {header}
      <Muted>{t('purchasing.return.explain')}</Muted>
      {props.lines.map((line) => (
        <Panel key={line.purchaseLineId}>
          <Text strong>{line.variantName ? `${line.name} · ${line.variantName}` : line.name}</Text>
          <List
            items={[
              {
                key: 'bought',
                primary: t('purchasing.return.bought'),
                trailing: <Quantity value={line.purchasedQty} decimals={line.unitDecimals} locale={locale} />,
              },
              {
                key: 'returned',
                primary: t('purchasing.return.alreadyReturned'),
                trailing: <Quantity value={line.returnedQty} decimals={line.unitDecimals} locale={locale} />,
              },
              {
                key: 'returnable',
                primary: t('purchasing.return.canReturn'),
                trailing: <Quantity value={line.returnableQty} decimals={line.unitDecimals} locale={locale} />,
              },
            ]}
          />
          <TextField
            label={t('purchasing.return.quantityToReturn')}
            inputMode="decimal"
            value={line.quantity}
            error={line.invalid ? t('purchasing.receive.quantityInvalid') : undefined}
            onChange={(v) => on.onQuantity(line.purchaseLineId, v)}
          />
          <Button variant="ghost" fullWidth onClick={() => on.onReturnAll(line.purchaseLineId)}>
            {t('purchasing.return.returnAll')}
          </Button>
        </Panel>
      ))}
      {props.nothingChosen ? <Notice tone="danger">{t('purchasing.return.nothingChosen')}</Notice> : null}
      <TextField label={t('common.date')} type="date" value={props.documentDate} onChange={on.onDate} />
      <Textarea label={`${t('purchasing.return.reason')} (${t('common.optional')})`} value={props.reason} onChange={on.onReason} />
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />
      <Button fullWidth loading={props.busy} onClick={on.onSubmit}>
        {t('purchasing.return.submit')}
      </Button>
      <Button variant="ghost" fullWidth disabled={props.busy} onClick={on.onBack}>
        {t('common.cancel')}
      </Button>
    </Stack>
  );
}
