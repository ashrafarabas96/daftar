/**
 * Count Stock, one count (P3-S7 A-11, A-13, A-08; blind counting is TL-8).
 *
 * Open (or resume), enter counted quantities, finish. The expected quantity
 * is shown only when the server returned it: while a count is open the server
 * hides it from a member who cannot adjust stock, so the counter counts what
 * is on the shelf, not towards a number. After finishing, each line says how
 * the count compared: "{n} more than expected" / "{n} fewer than expected".
 * "Cost per unit" appears only on the lines the server asked about
 * (`inventory.unit_cost_required`).
 */
import { Badge, Button, Card, ConfirmationDialog, List, TextField, spacing } from '@daftar/design-system';
import type { InventoryStocktakeDetailDto, InventoryStocktakeDetailLineDto } from '@/lib/phase3-api';
import { Ltr, isZeroQuantityText, rich, unsignedQty, type ViewBaseProps } from '@/lib/phase3-format';
import { formatDateText, identityKey, isNegativeText, trimQtyText, type DraftLine, type PickOption } from './model';
import { stocktakeStatusBadge } from './CountListView';
import { ActionRow, Hint, ItemName, ItemPicker, LineCard, Notice, Qty, STACK, ScreenTitle, SectionTitle, unitLabel } from './parts';

export interface CountSheetViewProps {
  stocktake: InventoryStocktakeDetailDto;
  warehouseName: string;
  /** `inventory.stocktake`: may enter counts, finish and cancel (advisory; the server decides). */
  canCount: boolean;
  /** Counts typed over the saved ones, by line identity. */
  counts: Readonly<Record<string, string>>;
  /** Items added in this sitting and not saved yet. */
  newLines: readonly DraftLine[];
  search: string;
  /** Items to add — never with a quantity (TL-8). */
  options: readonly PickOption[] | null;
  /** The lines the server asked a cost for, by line identity, and the typed costs. */
  costLines: readonly string[];
  costs: Readonly<Record<string, string>>;
  occurredOn: string;
  currency: string | null;
  unitNames: Readonly<Record<string, string>>;
  /** A catalog key per line (identity or new-line key) whose typed quantity is not valid. */
  lineErrors: Readonly<Record<string, string>>;
  errorKey: string | null;
  noticeKey: string | null;
  busy: boolean;
  confirmCancel: boolean;
  onCount: (key: string, value: string) => void;
  onSearch: (text: string) => void;
  onPick: (option: PickOption) => void;
  onNewQuantity: (lineKey: string, value: string) => void;
  onRemoveNew: (lineKey: string) => void;
  onCost: (key: string, value: string) => void;
  onDate: (value: string) => void;
  onSave: () => void;
  onFinish: () => void;
  onAskCancel: () => void;
  onConfirmCancel: () => void;
  onDismissCancel: () => void;
  onBack: () => void;
}

/** How a finished line compared with what was expected, from the server's variance. */
function Comparison(props: ViewBaseProps & { line: InventoryStocktakeDetailLineDto }) {
  const { t, locale, line } = props;
  if (line.varianceQty === null) return null;
  if (isZeroQuantityText(line.varianceQty.trim())) return <Badge tone="success">{t('stock.count.matches')}</Badge>;
  const qty = <Qty value={unsignedQty(line.varianceQty)} decimals={line.unitDecimals} locale={locale} />;
  return isNegativeText(line.varianceQty) ? (
    <Badge tone="danger">
      <span>{rich(t('stock.count.fewer'), { qty })}</span>
    </Badge>
  ) : (
    <Badge tone="info">
      <span>{rich(t('stock.count.more'), { qty })}</span>
    </Badge>
  );
}

export function CountSheetView(props: CountSheetViewProps & ViewBaseProps) {
  const { t, locale, stocktake } = props;
  const editable = stocktake.status === 'draft' && props.canCount;
  const added = new Set([...stocktake.lines.map((l) => identityKey(l.productId, l.variantId)), ...props.newLines.map((l) => l.key)]);
  const costSet = new Set(props.costLines);
  return (
    <div style={STACK}>
      <ScreenTitle>{t('stock.count.title')}</ScreenTitle>
      <div style={{ display: 'flex', gap: spacing[2], alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>
          <bdi>{props.warehouseName}</bdi>
        </strong>
        {stocktakeStatusBadge(t, stocktake.status)}
        <span>{rich(t('stock.count.startedOn'), { date: <Ltr>{formatDateText(stocktake.createdAt, locale)}</Ltr> })}</span>
      </div>
      {editable ? <Hint>{t('stock.count.howTo')}</Hint> : null}
      {props.noticeKey !== null ? <Notice tone="success">{t(props.noticeKey)}</Notice> : null}
      {stocktake.lines.length === 0 && props.newLines.length === 0 ? <Hint>{t('stock.count.noLines')}</Hint> : null}
      {stocktake.lines.length > 0 ? (
        <Card>
          <List
            items={stocktake.lines.map((line) => {
              const key = identityKey(line.productId, line.variantId);
              const unit = unitLabel(line.unitCode, props.unitNames);
              return {
                key: line.lineId,
                primary: <ItemName name={line.name} variantName={line.variantName} />,
                secondary: (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
                    {editable ? (
                      <TextField
                        label={t('stock.count.counted')}
                        hint={unit.length > 0 ? t('stock.line.unit', { unit }) : undefined}
                        inputMode="decimal"
                        value={props.counts[key] ?? trimQtyText(line.countedQty, line.unitDecimals)}
                        disabled={props.busy}
                        error={props.lineErrors[key] ? t(props.lineErrors[key]) : undefined}
                        onChange={(v) => props.onCount(key, v)}
                      />
                    ) : (
                      <span>
                        {rich(t('stock.count.countedQty'), { qty: <Qty value={line.countedQty} decimals={line.unitDecimals} locale={locale} />, unit })}
                      </span>
                    )}
                    {line.expectedQty !== null ? (
                      <span>
                        {rich(t('stock.count.expectedQty'), { qty: <Qty value={line.expectedQty} decimals={line.unitDecimals} locale={locale} />, unit })}
                      </span>
                    ) : null}
                    {editable && costSet.has(key) ? (
                      <TextField
                        label={t('stock.line.costPerUnit', { currency: props.currency ?? '' })}
                        hint={t('stock.line.costHint')}
                        inputMode="decimal"
                        value={props.costs[key] ?? ''}
                        disabled={props.busy}
                        onChange={(v) => props.onCost(key, v)}
                      />
                    ) : null}
                  </span>
                ),
                trailing: stocktake.status === 'finalized' ? <Comparison t={t} locale={locale} line={line} /> : undefined,
              };
            })}
          />
        </Card>
      ) : null}
      {editable ? (
        <>
          {props.newLines.map((line) => (
            <LineCard
              key={line.lineKey}
              t={t}
              locale={locale}
              line={line}
              unitNames={props.unitNames}
              quantityLabel={t('stock.count.counted')}
              showCost={false}
              currency={null}
              errorKey={props.lineErrors[line.lineKey] ?? null}
              disabled={props.busy}
              onQuantity={(v) => props.onNewQuantity(line.lineKey, v)}
              onCost={() => undefined}
              onRemove={() => props.onRemoveNew(line.lineKey)}
            />
          ))}
          <SectionTitle>{t('stock.count.addItems')}</SectionTitle>
          <ItemPicker
            t={t}
            locale={locale}
            search={props.search}
            options={props.options}
            added={added}
            unitNames={props.unitNames}
            disabled={props.busy}
            onSearch={props.onSearch}
            onPick={props.onPick}
          />
          <TextField label={t('stock.count.date')} type="date" value={props.occurredOn} disabled={props.busy} onChange={props.onDate} />
          {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
          <Button variant="secondary" fullWidth loading={props.busy} onClick={props.onSave}>
            {t('stock.count.save')}
          </Button>
          <Button fullWidth loading={props.busy} onClick={props.onFinish}>
            {t('stock.count.finish')}
          </Button>
          <Hint>{t('stock.count.finishHint')}</Hint>
          <ActionRow>
            <Button variant="ghost" disabled={props.busy} onClick={props.onAskCancel}>
              {t('stock.count.cancel')}
            </Button>
            <Button variant="ghost" disabled={props.busy} onClick={props.onBack}>
              {t('stock.count.backToList')}
            </Button>
          </ActionRow>
        </>
      ) : (
        <>
          {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
          <Button variant="secondary" fullWidth onClick={props.onBack}>
            {t('stock.count.backToList')}
          </Button>
        </>
      )}
      <ConfirmationDialog
        open={props.confirmCancel}
        title={t('stock.count.cancelTitle')}
        message={t('stock.count.cancelMessage')}
        confirmLabel={t('stock.count.cancelConfirm')}
        cancelLabel={t('stock.count.cancelKeep')}
        danger
        loading={props.busy}
        onConfirm={props.onConfirmCancel}
        onCancel={props.onDismissCancel}
      />
    </div>
  );
}
