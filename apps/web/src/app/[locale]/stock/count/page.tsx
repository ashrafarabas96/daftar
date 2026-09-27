'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeT, type Locale } from '@/lib/i18n';
import { listStocktakes, openStocktake, type InventoryStocktakeSummaryDto } from '@/lib/phase3-api';
import { refusalCode, refusalKey } from '@/lib/phase3-errors';
import { useFormDocumentId } from '@/lib/phase3-format';
import { CountListView } from '@/views/stock/CountListView';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../../AppHeader';
import { firstActiveWarehouse, useInventoryScreen } from '../stock-page-kit';

/**
 * Count Stock, the list (P3-S7 A-11, A-08): `GET /v1/inventory/stocktakes`
 * for one warehouse, and "Start a count" — `POST /v1/inventory/stocktakes`
 * with a stocktake id minted once for the form, so a double tap opens one
 * count, not two. A warehouse holds at most one open count; when one is
 * open the screen offers to continue it.
 */
export default function CountStockListPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const screen = useInventoryScreen(locale, ['inventory.view', 'inventory.stocktake']);
  const [stocktakeId] = useFormDocumentId();
  const [warehouseId, setWarehouseId] = useState('');
  const [stocktakes, setStocktakes] = useState<InventoryStocktakeSummaryDto[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (screen.phase === 'ready' && warehouseId === '') setWarehouseId(firstActiveWarehouse(screen.warehouses));
  }, [screen.phase, screen.warehouses, warehouseId]);

  useEffect(() => {
    if (screen.phase !== 'ready' || warehouseId === '') return;
    let live = true;
    setStocktakes(null);
    Promise.all([listStocktakes({ warehouseId }), listStocktakes({ warehouseId, status: 'draft', limit: 1 })])
      .then(([page, open]) => {
        if (!live) return;
        setStocktakes(page.items);
        setCursor(page.nextCursor);
        setOpenId(open.items[0]?.stocktakeId ?? null);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setStocktakes([]);
        setCursor(null);
        setOpenId(null);
        setErrorKey(refusalKey(error));
      });
    return () => {
      live = false;
    };
  }, [screen.phase, warehouseId, attempt]);

  async function start() {
    setBusy(true);
    setErrorKey(null);
    try {
      const opened = await openStocktake({ stocktakeId, warehouseId });
      router.push(`/${locale}/stock/count/${opened.id}`);
    } catch (error) {
      setErrorKey(refusalKey(error));
      // Someone opened one meanwhile: show it, so the merchant can continue it.
      if (refusalCode(error) === 'inventory.stocktake_already_open') setAttempt((n) => n + 1);
      setBusy(false);
    }
  }

  async function loadMore() {
    if (cursor === null) return;
    try {
      const page = await listStocktakes({ warehouseId, cursor });
      setStocktakes((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setErrorKey(refusalKey(error));
    }
  }

  return (
    <PageShell locale={locale} active="stock">
      {screen.phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={screen.phase} errorKey={screen.errorKey} onRetry={screen.reload} />
      ) : (
        <CountListView
          t={t}
          locale={locale}
          warehouses={screen.warehouses}
          warehouseId={warehouseId}
          stocktakes={stocktakes}
          openStocktakeId={openId}
          canCount={screen.can('inventory.stocktake')}
          hasMore={cursor !== null}
          busy={busy}
          errorKey={errorKey}
          onWarehouse={(id) => {
            setErrorKey(null);
            setWarehouseId(id);
          }}
          onStart={() => void start()}
          onOpen={(id) => router.push(`/${locale}/stock/count/${id}`)}
          onLoadMore={() => void loadMore()}
        />
      )}
    </PageShell>
  );
}
