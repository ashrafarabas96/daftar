/**
 * Purchase (P3-S7 contract A-11): the purchase as the server holds it, what is
 * still to pay on it, its returns and — for a holder of `suppliers.view`
 * (Annex R #4) — its payments and the balance in your favour used on it.
 *
 * "Undo receipt" (TL-4(b)) is present only when the S7 read says the server
 * would accept it (`reversible`, Annex R #21); otherwise it is absent, not
 * disabled. The merchant never reads a trace, entry or movement id here.
 */
import { Button, List, Textarea } from '@daftar/design-system';
import { Ltr, formatDecimalText, formatUnitPrice, rich, type ViewBaseProps } from '@/lib/phase3-format';
import { isNonZeroMinor } from '../common/amount-text';
import { RefusalNotice } from '../common/feedback';
import { CivilDate, Fact, Heading, Inline, Money, Muted, Notice, Panel, Quantity, Stack, Text, Title } from '../common/primitives';
import { PurchaseStatusBadge } from './PurchaseListView';
import type { PurchaseResidueWriteOffResultDto, PurchaseReversalResultDto, PurchaseSettlementsDto } from '@daftar/shared-contracts';
import type { PurchaseActions, PurchaseDetailModel, PurchaseReturnRow, UndoReceiptForm } from './types';

export interface PurchaseDetailViewProps {
  purchase: PurchaseDetailModel;
  /** What is still to pay, in the purchase currency; null when the purchase is not received. */
  outstandingTxnMinor: string | null;
  returns: PurchaseReturnRow[];
  /** As the server answered it (entry ids included, never rendered); null without `suppliers.view` (Annex R #4). */
  settlements: PurchaseSettlementsDto | null;
  actions: PurchaseActions;
  undo: UndoReceiptForm;
  /** The server's answer once "Undo receipt" succeeded (its entry and movement ids are never rendered). */
  undone: PurchaseReversalResultDto | null;
  /** TD-16: the "close the leftover" confirmation, the same shape as Undo receipt's. */
  leftover: UndoReceiptForm;
  /** The server's answer once the leftover was closed (its entry and trace ids are never rendered). */
  leftoverClosed: PurchaseResidueWriteOffResultDto | null;
  errorKey: string | null;
  on: {
    onContinueDraft: () => void;
    onReturn: () => void;
    onPay: () => void;
    onStartUndo: () => void;
    onUndoReason: (value: string) => void;
    onConfirmUndo: () => void;
    onCancelUndo: () => void;
    onStartLeftover: () => void;
    onLeftoverReason: (value: string) => void;
    onConfirmLeftover: () => void;
    onCancelLeftover: () => void;
    onBack: () => void;
  };
}

export function PurchaseDetailView(props: PurchaseDetailViewProps & ViewBaseProps) {
  const { t, locale, purchase, on } = props;
  const money = (amountMinor: string) => <Money amountMinor={amountMinor} currency={purchase.currency} locale={locale} />;
  return (
    <Stack>
      <Title>
        <bdi>{purchase.supplierName}</bdi>
      </Title>
      <Inline gap={2}>
        <CivilDate iso={purchase.documentDate} locale={locale} />
        <span>{purchase.warehouseName}</span>
        <PurchaseStatusBadge t={t} status={purchase.status} />
      </Inline>
      {purchase.supplierReference ? (
        <Fact label={t('purchasing.receive.supplierReference')}>
          <bdi>{purchase.supplierReference}</bdi>
        </Fact>
      ) : null}
      {props.undone !== null ? <Notice tone="success">{t('purchasing.detail.undone')}</Notice> : null}
      {props.leftoverClosed !== null ? <Notice tone="success">{t('purchasing.detail.leftoverClosed')}</Notice> : null}
      <RefusalNotice t={t} locale={locale} errorKey={props.errorKey} />

      <List
        items={purchase.lines.map((line) => ({
          key: line.lineId,
          primary: line.variantName ? `${line.name} · ${line.variantName}` : line.name,
          secondary: (
            <Inline gap={2}>
              <Quantity value={line.qty} decimals={line.unitDecimals} locale={locale} />
              <span>×</span>
              <Ltr>{formatUnitPrice(line.unitPrice, purchase.currency, locale)}</Ltr>
              {isNonZeroMinor(line.discountTxnMinor) ? (
                <span>{rich(t('purchasing.receive.discountApplied'), { amount: money(line.discountTxnMinor) })}</span>
              ) : null}
            </Inline>
          ),
          trailing: money(line.netTxnMinor),
        }))}
      />
      <Fact label={t('purchasing.receive.subtotal')}>{money(purchase.subtotalTxnMinor)}</Fact>
      {isNonZeroMinor(purchase.landedCostTxnMinor) ? <Fact label={t('purchasing.receive.extraCosts')}>{money(purchase.landedCostTxnMinor)}</Fact> : null}
      <Fact label={t('purchasing.receive.total')}>{money(purchase.totalTxnMinor)}</Fact>
      {purchase.rate !== null ? (
        <Muted>
          {rich(t('purchasing.receive.rateUsed'), {
            from: <Ltr>{`1 ${purchase.currency}`}</Ltr>,
            to: <Ltr>{`${formatDecimalText(purchase.rate, locale)} ${purchase.baseCurrency}`}</Ltr>,
          })}
        </Muted>
      ) : null}
      {props.outstandingTxnMinor !== null ? <Fact label={t('purchasing.detail.stillToPay')}>{money(props.outstandingTxnMinor)}</Fact> : null}
      {purchase.notes ? <Muted>{purchase.notes}</Muted> : null}

      {props.actions.continueDraft ? (
        <Button fullWidth onClick={on.onContinueDraft}>
          {t('purchasing.detail.continueDraft')}
        </Button>
      ) : null}
      {props.actions.paySupplier ? (
        <Button fullWidth onClick={on.onPay}>
          {t('payments.title')}
        </Button>
      ) : null}
      {props.actions.closeLeftover ? <CloseLeftover {...props} /> : null}
      {props.actions.returnToSupplier ? (
        <Button variant="secondary" fullWidth onClick={on.onReturn}>
          {t('purchasing.return.title')}
        </Button>
      ) : null}
      {props.actions.undoReceipt ? <UndoReceipt {...props} /> : null}

      <Heading>{t('purchasing.detail.returns')}</Heading>
      {props.returns.length === 0 ? (
        <Muted>{t('purchasing.detail.noReturns')}</Muted>
      ) : (
        <List
          items={props.returns.map((r) => ({
            key: r.returnId,
            primary: t('purchasing.detail.returnRow'),
            secondary: <CivilDate iso={r.documentDate} locale={locale} />,
            trailing: <Money amountMinor={r.carryingTxnMinor} currency={r.currency} locale={locale} />,
          }))}
        />
      )}

      {props.settlements ? (
        <>
          <Heading>{t('purchasing.detail.payments')}</Heading>
          {props.settlements.payments.length === 0 && props.settlements.creditAllocations.length === 0 ? (
            <Muted>{t('purchasing.detail.noPayments')}</Muted>
          ) : (
            <List
              items={[
                ...props.settlements.payments.map((p) => ({
                  key: p.allocationId,
                  primary: t('purchasing.detail.paymentRow'),
                  secondary: <CivilDate iso={p.paymentDate} locale={locale} />,
                  trailing: money(p.purchaseAmountAppliedMinor),
                })),
                ...props.settlements.creditAllocations.map((c) => ({
                  key: c.allocationId,
                  primary: t('purchasing.detail.favourUsedRow'),
                  secondary: <CivilDate iso={c.allocationDate} locale={locale} />,
                  trailing: money(c.purchaseAmountAppliedMinor),
                })),
              ]}
            />
          )}
        </>
      ) : null}
      <Button variant="ghost" fullWidth onClick={on.onBack}>
        {t('common.back')}
      </Button>
    </Stack>
  );
}

function UndoReceipt(props: PurchaseDetailViewProps & ViewBaseProps) {
  const { t, undo, on } = props;
  if (!undo.open) {
    return (
      <Button variant="danger" fullWidth onClick={on.onStartUndo}>
        {t('purchasing.detail.undoReceipt')}
      </Button>
    );
  }
  return (
    <Panel>
      <Text strong>{t('purchasing.detail.undoTitle')}</Text>
      <Muted>{t('purchasing.detail.undoExplain')}</Muted>
      <Textarea
        label={t('purchasing.detail.undoReason')}
        value={undo.reason}
        error={undo.reasonMissing ? t('purchasing.detail.undoReasonRequired') : undefined}
        onChange={on.onUndoReason}
      />
      <Button variant="danger" fullWidth loading={undo.busy} onClick={on.onConfirmUndo}>
        {t('purchasing.detail.undoConfirm')}
      </Button>
      <Button variant="ghost" fullWidth disabled={undo.busy} onClick={on.onCancelUndo}>
        {t('common.cancel')}
      </Button>
    </Panel>
  );
}

/**
 * TD-16: a leftover smaller than the smallest coin, which no payment can
 * carry, closed with a reason behind a confirmation (0072). One action; the
 * hint says why "Pay" is not offered.
 */
function CloseLeftover(props: PurchaseDetailViewProps & ViewBaseProps) {
  const { t, leftover, on } = props;
  if (!leftover.open) {
    return (
      <>
        <Muted>{t('purchasing.detail.leftoverHint')}</Muted>
        <Button fullWidth onClick={on.onStartLeftover}>
          {t('purchasing.detail.leftoverClose')}
        </Button>
      </>
    );
  }
  return (
    <Panel>
      <Text strong>{t('purchasing.detail.leftoverTitle')}</Text>
      <Muted>{t('purchasing.detail.leftoverExplain')}</Muted>
      <Textarea
        label={t('purchasing.detail.leftoverReason')}
        value={leftover.reason}
        error={leftover.reasonMissing ? t('purchasing.detail.leftoverReasonRequired') : undefined}
        onChange={on.onLeftoverReason}
      />
      <Button fullWidth loading={leftover.busy} onClick={on.onConfirmLeftover}>
        {t('purchasing.detail.leftoverConfirm')}
      </Button>
      <Button variant="ghost" fullWidth disabled={leftover.busy} onClick={on.onCancelLeftover}>
        {t('common.cancel')}
      </Button>
    </Panel>
  );
}
