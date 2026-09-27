/**
 * Adjust Stock (P3-S7 A-11, A-13; "Starting stock" is TL-4).
 *
 * One of four reasons: "Found extra" and "Missing" record an adjustment,
 * "Damaged" a write-off, and "Starting stock" the business's first stock
 * (`POST /v1/inventory/openings`, offered only to a business-wide member).
 * The merchant types a quantity; its direction comes from the reason.
 * "Cost per unit" is asked where the server needs it: always for starting
 * stock, and for extra stock only once the server has said so
 * (`inventory.unit_cost_required`). The result shows the server's quantities,
 * never a value (TL-7).
 */
import { Button, Card, List, RadioCard, TextField, Textarea } from '@daftar/design-system';
import type { InventoryMovementDocumentDto } from '@daftar/shared-contracts';
import type { InventoryWarehouseDto } from '@/lib/phase3-api';
import { rich, unsignedQty, type ViewBaseProps } from '@/lib/phase3-format';
import { identityKey, isNegativeText, type AdjustReason, type DraftLine, type PickOption } from './model';
import { AUTO_GRID, Hint, ItemName, ItemPicker, LineCard, Notice, Qty, STACK, ScreenTitle, SectionTitle, WarehouseSelect } from './parts';

export interface AdjustStockViewProps {
  warehouses: readonly InventoryWarehouseDto[];
  warehouseId: string;
  /** The reasons this member may use, in order ("starting" only when business-wide, TL-4). */
  reasons: readonly AdjustReason[];
  reason: AdjustReason;
  occurredOn: string;
  note: string;
  /** The business currency code, for the cost field. */
  currency: string | null;
  search: string;
  options: readonly PickOption[] | null;
  lines: readonly DraftLine[];
  lineErrors: Readonly<Record<string, string>>;
  /** A catalog key per line key whose typed cost is not an amount, shown under the cost field (m-4). */
  costErrors: Readonly<Record<string, string>>;
  unitNames: Readonly<Record<string, string>>;
  errorKey: string | null;
  busy: boolean;
  result: InventoryMovementDocumentDto | null;
  onWarehouse: (warehouseId: string) => void;
  onReason: (reason: AdjustReason) => void;
  onDate: (value: string) => void;
  onNote: (value: string) => void;
  onSearch: (text: string) => void;
  onPick: (option: PickOption) => void;
  onQuantity: (lineKey: string, value: string) => void;
  onCost: (lineKey: string, value: string) => void;
  onRemove: (lineKey: string) => void;
  onSubmit: () => void;
  onNew: () => void;
  onBack: () => void;
}

const REASON_KEYS: Readonly<Record<AdjustReason, { title: string; description: string }>> = {
  found: { title: 'stock.adjust.reason.found', description: 'stock.adjust.reason.foundHint' },
  missing: { title: 'stock.adjust.reason.missing', description: 'stock.adjust.reason.missingHint' },
  damaged: { title: 'stock.adjust.reason.damaged', description: 'stock.adjust.reason.damagedHint' },
  starting: { title: 'stock.adjust.reason.starting', description: 'stock.adjust.reason.startingHint' },
};

export function AdjustStockView(props: AdjustStockViewProps & ViewBaseProps) {
  const { t, locale } = props;
  if (props.result !== null) {
    const byKey = new Map(props.lines.map((l) => [identityKey(l.productId, l.variantId), l]));
    return (
      <div style={STACK}>
        <ScreenTitle>{t('stock.adjust.title')}</ScreenTitle>
        <Notice tone="success">{t(props.reason === 'starting' ? 'stock.adjust.doneStarting' : 'stock.adjust.done')}</Notice>
        <Card>
          <List
            items={props.result.lines.map((l) => {
              const line = byKey.get(identityKey(l.productId, l.variantId));
              const qty = <Qty value={unsignedQty(l.qtyDelta)} decimals={line?.unitDecimals ?? 4} locale={locale} />;
              return {
                key: l.lineId,
                primary: <ItemName name={line?.name ?? ''} variantName={line?.variantName ?? null} />,
                trailing: <span>{rich(t(isNegativeText(l.qtyDelta) ? 'stock.adjust.resultLess' : 'stock.adjust.resultMore'), { qty })}</span>,
              };
            })}
          />
        </Card>
        <Button fullWidth onClick={props.onNew}>
          {t('stock.adjust.another')}
        </Button>
        <Button variant="ghost" fullWidth onClick={props.onBack}>
          {t('stock.common.backToStock')}
        </Button>
      </div>
    );
  }
  const added = new Set(props.lines.map((l) => l.key));
  const ready = props.warehouseId !== '' && props.lines.length > 0;
  const quantityLabel = t(props.reason === 'missing' || props.reason === 'damaged' ? 'stock.adjust.quantityLess' : 'stock.adjust.quantityMore');
  return (
    <div style={STACK}>
      <ScreenTitle>{t('stock.adjust.title')}</ScreenTitle>
      <SectionTitle>{t('stock.adjust.why')}</SectionTitle>
      <div style={AUTO_GRID} role="radiogroup" aria-label={t('stock.adjust.why')}>
        {props.reasons.map((r) => (
          <RadioCard
            key={r}
            name="adjust-reason"
            value={r}
            title={t(REASON_KEYS[r].title)}
            description={t(REASON_KEYS[r].description)}
            checked={props.reason === r}
            onChange={() => props.onReason(r)}
          />
        ))}
      </div>
      <div style={AUTO_GRID}>
        <WarehouseSelect
          t={t}
          label={t('common.warehouse')}
          warehouses={props.warehouses}
          value={props.warehouseId}
          disabled={props.busy}
          onChange={props.onWarehouse}
        />
        <TextField label={t('common.date')} type="date" value={props.occurredOn} disabled={props.busy} onChange={props.onDate} />
      </div>
      <Textarea label={t('stock.adjust.noteOptional')} hint={t('stock.adjust.noteHint')} value={props.note} disabled={props.busy} onChange={props.onNote} />
      <SectionTitle>{t('stock.common.items')}</SectionTitle>
      {props.warehouseId === '' ? (
        <Hint>{t('stock.adjust.pickWarehouseFirst')}</Hint>
      ) : (
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
      )}
      {props.lines.map((line) => (
        <LineCard
          key={line.lineKey}
          t={t}
          locale={locale}
          line={line}
          unitNames={props.unitNames}
          quantityLabel={quantityLabel}
          showCost={props.reason === 'starting' || (props.reason === 'found' && line.needsCost)}
          currency={props.currency}
          errorKey={props.lineErrors[line.lineKey] ?? null}
          costErrorKey={props.costErrors[line.lineKey] ?? null}
          disabled={props.busy}
          onQuantity={(v) => props.onQuantity(line.lineKey, v)}
          onCost={(v) => props.onCost(line.lineKey, v)}
          onRemove={() => props.onRemove(line.lineKey)}
        />
      ))}
      {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
      <Button fullWidth loading={props.busy} disabled={!ready} onClick={props.onSubmit}>
        {t('stock.adjust.submit')}
      </Button>
    </div>
  );
}
