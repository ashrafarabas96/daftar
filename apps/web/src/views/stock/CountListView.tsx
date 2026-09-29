/**
 * Count Stock, the list (P3-S7 A-11, A-08): the counts of one warehouse,
 * newest first. A warehouse holds at most one open count; the merchant
 * continues it, or starts one when none is open (the server refuses a second
 * with `inventory.stocktake_already_open`).
 */
import { Badge, Button, EmptyState, List, Spinner } from '@daftar/design-system';
import type { InventoryStocktakeSummaryDto, InventoryWarehouseDto } from '@/lib/phase3-api';
import { Ltr, rich, type Translate, type ViewBaseProps } from '@/lib/phase3-format';
import { formatDateText } from './model';
import { AUTO_GRID, Hint, Notice, STACK, ScreenTitle, WarehouseSelect } from './parts';

export interface CountListViewProps {
  warehouses: readonly InventoryWarehouseDto[];
  warehouseId: string;
  /** Null while loading. */
  stocktakes: readonly InventoryStocktakeSummaryDto[] | null;
  /** The warehouse's open count, read with `status=draft` (at most one per warehouse); null when none. */
  openStocktakeId: string | null;
  /** Whether this member may start or continue a count (`inventory.stocktake`). */
  canCount: boolean;
  hasMore: boolean;
  busy: boolean;
  errorKey: string | null;
  onWarehouse: (warehouseId: string) => void;
  onStart: () => void;
  onOpen: (stocktakeId: string) => void;
  onLoadMore: () => void;
}

export function stocktakeStatusBadge(t: Translate, status: InventoryStocktakeSummaryDto['status']) {
  if (status === 'draft') return <Badge tone="warning">{t('stock.count.statusOpen')}</Badge>;
  if (status === 'finalized') return <Badge tone="success">{t('stock.count.statusFinished')}</Badge>;
  return <Badge tone="neutral">{t('stock.count.statusCancelled')}</Badge>;
}

export function CountListView(props: CountListViewProps & ViewBaseProps) {
  const { t, locale } = props;
  const openId = props.openStocktakeId;
  return (
    <div style={STACK}>
      <ScreenTitle>{t('stock.count.title')}</ScreenTitle>
      <Hint>{t('stock.count.intro')}</Hint>
      <div style={AUTO_GRID}>
        <WarehouseSelect
          t={t}
          label={t('common.warehouse')}
          warehouses={props.warehouses}
          value={props.warehouseId}
          disabled={props.busy}
          onChange={props.onWarehouse}
        />
      </div>
      {props.errorKey !== null ? <Notice tone="error">{t(props.errorKey)}</Notice> : null}
      {props.warehouseId !== '' && props.canCount && props.stocktakes !== null ? (
        openId !== null ? (
          <Button fullWidth onClick={() => props.onOpen(openId)}>
            {t('stock.count.continue')}
          </Button>
        ) : (
          <Button fullWidth loading={props.busy} onClick={props.onStart}>
            {t('stock.count.start')}
          </Button>
        )
      ) : null}
      {props.warehouseId === '' ? (
        <EmptyState title={t('stock.levels.pickWarehouse')} />
      ) : props.stocktakes === null ? (
        <Spinner label={t('common.loading')} />
      ) : props.stocktakes.length === 0 ? (
        <EmptyState title={t('stock.count.empty')} />
      ) : (
        <List
          items={props.stocktakes.map((s) => ({
            key: s.stocktakeId,
            primary: <span>{rich(t('stock.count.startedOn'), { date: <Ltr>{formatDateText(s.createdAt, locale)}</Ltr> })}</span>,
            secondary: rich(t('stock.count.lineCount'), { count: <Ltr>{String(s.lineCount)}</Ltr> }),
            trailing: stocktakeStatusBadge(t, s.status),
            onClick: () => props.onOpen(s.stocktakeId),
          }))}
        />
      )}
      {props.hasMore ? (
        <Button variant="secondary" fullWidth onClick={props.onLoadMore}>
          {t('common.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
