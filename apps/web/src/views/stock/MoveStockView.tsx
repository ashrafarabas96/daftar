/**
 * Move Stock (P3-S7 A-11, A-13): from, to, lines — `POST /v1/inventory/transfers`.
 *
 * The form keeps its document id across retries (A-12(4)); the page owns it.
 * The result shows what the server says arrived, never a value (TL-7).
 */
import { Button, Card, List } from '@daftar/design-system';
import type { InventoryMovementDocumentDto } from '@daftar/shared-contracts';
import type { InventoryWarehouseDto } from '@/lib/phase3-api';
import type { ViewBaseProps } from '@/lib/phase3-format';
import { identityKey, type DraftLine, type PickOption } from './model';
import { AUTO_GRID, Hint, ItemName, ItemPicker, LineCard, Notice, Qty, STACK, ScreenTitle, SectionTitle, WarehouseSelect, unitLabel } from './parts';

export interface MoveStockViewProps {
  warehouses: readonly InventoryWarehouseDto[];
  fromId: string;
  toId: string;
  search: string;
  /** Items in the source warehouse matching the search, with their on-hand quantity; null before a search. */
  options: readonly PickOption[] | null;
  lines: readonly DraftLine[];
  /** A catalog key per line whose typed quantity is not a quantity of its unit. */
  lineErrors: Readonly<Record<string, string>>;
  unitNames: Readonly<Record<string, string>>;
  errorKey: string | null;
  busy: boolean;
  /** The server's answer once the move is recorded. */
  result: InventoryMovementDocumentDto | null;
  onFrom: (warehouseId: string) => void;
  onTo: (warehouseId: string) => void;
  onSearch: (text: string) => void;
  onPick: (option: PickOption) => void;
  onQuantity: (lineKey: string, value: string) => void;
  onRemove: (lineKey: string) => void;
  onSubmit: () => void;
  onNew: () => void;
  onBack: () => void;
}

export function MoveStockView(props: MoveStockViewProps & ViewBaseProps) {
  const { t, locale } = props;
  const nameOf = (id: string): string => props.warehouses.find((w) => w.warehouseId === id)?.name ?? '';
  if (props.result !== null) {
    const byKey = new Map(props.lines.map((l) => [identityKey(l.productId, l.variantId), l]));
    const arrived = props.result.lines.filter((l) => l.warehouseId === props.toId);
    return (
      <div style={STACK}>
        <ScreenTitle>{t('stock.move.title')}</ScreenTitle>
        <Notice tone="success">{t('stock.move.done', { from: nameOf(props.fromId), to: nameOf(props.toId) })}</Notice>
        <Card>
          <List
            items={arrived.map((l) => {
              const line = byKey.get(identityKey(l.productId, l.variantId));
              return {
                key: l.lineId,
                primary: <ItemName name={line?.name ?? ''} variantName={line?.variantName ?? null} />,
                secondary: line ? unitLabel(line.unitCode, props.unitNames) : undefined,
                trailing: <Qty value={l.qtyDelta} decimals={line?.unitDecimals ?? 4} locale={locale} />,
              };
            })}
          />
        </Card>
        <Button fullWidth onClick={props.onNew}>
          {t('stock.move.another')}
        </Button>
        <Button variant="ghost" fullWidth onClick={props.onBack}>
          {t('stock.common.backToStock')}
        </Button>
      </div>
    );
  }
  const added = new Set(props.lines.map((l) => l.key));
  const ready = props.fromId !== '' && props.toId !== '' && props.lines.length > 0;
  return (
    <div style={STACK}>
      <ScreenTitle>{t('stock.move.title')}</ScreenTitle>
      <Hint>{t('stock.move.intro')}</Hint>
      <div style={AUTO_GRID}>
        <WarehouseSelect t={t} label={t('stock.move.from')} warehouses={props.warehouses} value={props.fromId} disabled={props.busy} onChange={props.onFrom} />
        <WarehouseSelect
          t={t}
          label={t('stock.move.to')}
          warehouses={props.warehouses}
          value={props.toId}
          exclude={props.fromId}
          disabled={props.busy}
          onChange={props.onTo}
        />
      </div>
      <SectionTitle>{t('stock.common.items')}</SectionTitle>
      {props.fromId === '' ? (
        <Hint>{t('stock.move.pickFromFirst')}</Hint>
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
          quantityLabel={t('stock.move.quantity')}
          showCost={false}
          currency={null}
          errorKey={props.lineErrors[line.lineKey] ?? null}
          disabled={props.busy}
          onQuantity={(v) => props.onQuantity(line.lineKey, v)}
          onCost={() => undefined}
          onRemove={() => props.onRemove(line.lineKey)}
        />
      ))}
      {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
      <Button fullWidth loading={props.busy} disabled={!ready} onClick={props.onSubmit}>
        {t('stock.move.submit')}
      </Button>
    </div>
  );
}
