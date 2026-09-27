'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeT, type Locale } from '@/lib/i18n';
import { listStock, type InventoryStockRowDto } from '@/lib/phase3-api';
import { refusalKey } from '@/lib/phase3-errors';
import { StockLevelsView, type StockAction, type StockStatusFilter } from '@/views/stock/StockLevelsView';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../AppHeader';
import { SEARCH_DELAY_MS, firstActiveWarehouse, useInventoryScreen } from './stock-page-kit';

/**
 * Stock (P3-S7 A-11, A-07): the live quantities of one warehouse, from
 * `GET /v1/inventory/stock`. Nothing is cached: every change of warehouse,
 * search or filter reads again (A-03).
 */
export default function StockPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const screen = useInventoryScreen(locale, ['inventory.view']);
  const [warehouseId, setWarehouseId] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StockStatusFilter>('');
  const [rows, setRows] = useState<InventoryStockRowDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    if (screen.phase === 'ready' && warehouseId === '') setWarehouseId(firstActiveWarehouse(screen.warehouses));
  }, [screen.phase, screen.warehouses, warehouseId]);

  useEffect(() => {
    if (screen.phase !== 'ready' || warehouseId === '') return;
    let live = true;
    setRows(null);
    setErrorKey(null);
    const text = search.trim();
    const timer = setTimeout(
      () => {
        listStock({ warehouseId, search: text.length > 0 ? text : undefined, status: status === '' ? undefined : status })
          .then((page) => {
            if (!live) return;
            setRows(page.items);
            setCursor(page.nextCursor);
          })
          .catch((error: unknown) => {
            if (!live) return;
            setRows([]);
            setCursor(null);
            setErrorKey(refusalKey(error));
          });
      },
      text.length > 0 ? SEARCH_DELAY_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [screen.phase, warehouseId, search, status]);

  async function loadMore() {
    if (cursor === null) return;
    setLoadingMore(true);
    const text = search.trim();
    try {
      const page = await listStock({ warehouseId, search: text.length > 0 ? text : undefined, status: status === '' ? undefined : status, cursor });
      setRows((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setLoadingMore(false);
    }
  }

  const go = (action: StockAction) => router.push(`/${locale}/stock/${action}`);

  return (
    <PageShell locale={locale} active="stock">
      {screen.phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={screen.phase} errorKey={screen.errorKey} onRetry={screen.reload} />
      ) : (
        <StockLevelsView
          t={t}
          locale={locale}
          warehouses={screen.warehouses}
          warehouseId={warehouseId}
          search={search}
          status={status}
          rows={rows}
          unitNames={screen.unitNames}
          hasMore={cursor !== null}
          loadingMore={loadingMore}
          errorKey={errorKey}
          actions={{ move: screen.can('inventory.transfer'), count: screen.can('inventory.stocktake'), adjust: screen.can('inventory.adjust') }}
          onWarehouse={setWarehouseId}
          onSearch={setSearch}
          onStatus={setStatus}
          onLoadMore={() => void loadMore()}
          onAction={go}
        />
      )}
    </PageShell>
  );
}
