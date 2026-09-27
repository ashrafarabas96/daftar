/**
 * Stock (P3-S7 A-11, A-07): what is on the shelf in one warehouse, live.
 *
 * Quantities only — no cost or value (TL-7), no stock sequence, no reserved
 * quantity. A product with options shows one row per option; stock recorded
 * before the item had options shows under the item's name alone. Below zero
 * reads "Short by {qty}".
 */
import { Button, EmptyState, List, SearchField, Select, Spinner } from '@daftar/design-system';
import type { InventoryStockRowDto, InventoryWarehouseDto } from '@/lib/phase3-api';
import type { ViewBaseProps } from '@/lib/phase3-format';
import { ActionRow, AUTO_GRID, ItemName, Notice, OnHand, STACK, ScreenTitle, WarehouseSelect, unitLabel } from './parts';

export type StockStatusFilter = '' | 'in_stock' | 'out_of_stock' | 'negative';
export type StockAction = 'move' | 'count' | 'adjust';

export interface StockLevelsViewProps {
  warehouses: readonly InventoryWarehouseDto[];
  warehouseId: string;
  search: string;
  status: StockStatusFilter;
  /** Null while the first page loads. */
  rows: readonly InventoryStockRowDto[] | null;
  unitNames: Readonly<Record<string, string>>;
  hasMore: boolean;
  loadingMore: boolean;
  errorKey: string | null;
  /** The actions this member may take (advisory, from `GET /v1/inventory/access`; each command still decides). */
  actions: Readonly<Record<StockAction, boolean>>;
  onWarehouse: (warehouseId: string) => void;
  onSearch: (text: string) => void;
  onStatus: (status: StockStatusFilter) => void;
  onLoadMore: () => void;
  onAction: (action: StockAction) => void;
  /** Opens the catalog, where stock tracking is turned on for a product (SIM-12: an empty state leads somewhere). */
  onTrackProduct: () => void;
}

const STATUS_VALUES: readonly StockStatusFilter[] = ['', 'in_stock', 'out_of_stock', 'negative'];
const isStatus = (value: string): value is StockStatusFilter => (STATUS_VALUES as readonly string[]).includes(value);

export function StockLevelsView(props: StockLevelsViewProps & ViewBaseProps) {
  const { t, locale } = props;
  const statusLabel: Record<StockStatusFilter, string> = {
    '': t('stock.levels.filterAll'),
    in_stock: t('stock.levels.inStock'),
    out_of_stock: t('stock.levels.outOfStock'),
    negative: t('stock.levels.filterShort'),
  };
  return (
    <div style={STACK}>
      <ScreenTitle>{t('stock.levels.title')}</ScreenTitle>
      <ActionRow>
        {props.actions.move ? (
          <Button variant="secondary" onClick={() => props.onAction('move')}>
            {t('stock.move.title')}
          </Button>
        ) : null}
        {props.actions.count ? (
          <Button variant="secondary" onClick={() => props.onAction('count')}>
            {t('stock.count.title')}
          </Button>
        ) : null}
        {props.actions.adjust ? (
          <Button variant="secondary" onClick={() => props.onAction('adjust')}>
            {t('stock.adjust.title')}
          </Button>
        ) : null}
      </ActionRow>
      <div style={AUTO_GRID}>
        <WarehouseSelect t={t} label={t('common.warehouse')} warehouses={props.warehouses} value={props.warehouseId} onChange={props.onWarehouse} />
        <SearchField label={t('common.search')} placeholder={t('stock.picker.placeholder')} value={props.search} onChange={props.onSearch} />
        <Select
          label={t('stock.levels.show')}
          value={props.status}
          options={STATUS_VALUES.map((s) => ({ value: s, label: statusLabel[s] }))}
          onChange={(value) => {
            if (isStatus(value)) props.onStatus(value);
          }}
        />
      </div>
      {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
      {props.warehouseId === '' ? (
        <EmptyState title={t('stock.levels.pickWarehouse')} />
      ) : props.rows === null ? (
        <Spinner label={t('common.loading')} />
      ) : props.rows.length === 0 ? (
        props.search.length > 0 || props.status !== '' ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          <EmptyState title={t('stock.levels.empty')} actionLabel={t('stock.levels.trackProduct')} onAction={props.onTrackProduct} />
        )
      ) : (
        <List
          items={props.rows.map((r) => ({
            key: `${r.productId}:${r.variantId ?? ''}`,
            primary: <ItemName name={r.name} variantName={r.variantName} />,
            secondary: unitLabel(r.unitCode, props.unitNames),
            trailing: <OnHand t={t} locale={locale} value={r.onHand} decimals={r.unitDecimals} />,
          }))}
        />
      )}
      {props.hasMore ? (
        <Button variant="secondary" fullWidth loading={props.loadingMore} onClick={props.onLoadMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
