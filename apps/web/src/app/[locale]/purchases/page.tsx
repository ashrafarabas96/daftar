'use client';
/**
 * Purchases (P3-S7 contract A-11): the purchase list. A draft opens in
 * Receive Purchase to be continued; any other purchase opens its detail.
 */
import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PurchaseSummaryDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { listPurchases } from '@/lib/phase3-api';
import { refusalKey } from '@/lib/phase3-errors';
import { PageStateView } from '@/views/common/feedback';
import { PurchaseListView } from '@/views/purchases/PurchaseListView';
import type { PurchaseFilter, PurchaseRowModel } from '@/views/purchases/types';
import { PageShell } from '../AppHeader';
import { suppliersById, warehouseNames } from './_shared/lookups';
import { useMerchantContext } from './_shared/merchant-context';

const PAGE_SIZE = 25;

export default function PurchasesPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const { status, context, retry } = useMerchantContext(locale);
  const [filter, setFilter] = useState<PurchaseFilter>('all');
  const [rows, setRows] = useState<PurchaseRowModel[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const load = useCallback(async (which: PurchaseFilter, after: string | null): Promise<void> => {
    const page = await listPurchases({ limit: PAGE_SIZE, ...(which === 'all' ? {} : { status: which }), ...(after ? { cursor: after } : {}) });
    const [suppliers, warehouses] = await Promise.all([suppliersById(page.items.map((p) => p.supplierId)), warehouseNames()]);
    const mapped = page.items.map((p: PurchaseSummaryDto) => ({
      purchaseId: p.id,
      supplierName: suppliers.get(p.supplierId)?.name ?? '',
      warehouseName: warehouses.get(p.warehouseId) ?? '',
      documentDate: p.documentDate,
      supplierReference: p.supplierReference,
      status: p.status,
      currency: p.currency,
      totalTxnMinor: p.totalTxnMinor,
    }));
    setRows((prev) => (after ? [...prev, ...mapped] : mapped));
    setCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    if (status !== 'ready') return;
    setErrorKey(null);
    load(filter, null).catch((error: unknown) => {
      setRows([]);
      setCursor(null);
      setErrorKey(refusalKey(error));
    });
  }, [status, filter, load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setErrorKey(null);
    try {
      await load(filter, cursor);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PageShell locale={locale} active="purchases">
      {status !== 'ready' || !context ? (
        <PageStateView t={t} locale={locale} status={status === 'ready' ? 'loading' : status} onRetry={retry} />
      ) : (
        <PurchaseListView
          t={t}
          locale={locale}
          rows={rows}
          filter={filter}
          canReceive={context.can('purchases.manage')}
          hasMore={cursor !== null}
          loadingMore={loadingMore}
          errorKey={errorKey}
          onFilter={setFilter}
          onOpen={(row) =>
            router.push(row.status === 'draft' ? `/${locale}/purchases/receive?draft=${row.purchaseId}` : `/${locale}/purchases/${row.purchaseId}`)
          }
          onReceive={() => router.push(`/${locale}/purchases/receive`)}
          onLoadMore={() => void loadMore()}
        />
      )}
    </PageShell>
  );
}
