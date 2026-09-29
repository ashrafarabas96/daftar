'use client';
/**
 * Suppliers (P3-S7 contract A-11, A-09(a)). A business-wide caller reads the
 * live supplier balances; an assigned-scope caller reads the plain supplier
 * list (the balances are business-wide, S4 TL-4).
 */
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeT, type Locale } from '@/lib/i18n';
import { listSupplierBalances, listSuppliers } from '@/lib/phase3-api';
import { refusalKey } from '@/lib/phase3-errors';
import { PageStateView } from '@/views/common/feedback';
import { SupplierListView } from '@/views/suppliers/SupplierListView';
import type { SupplierRowModel } from '@/views/suppliers/types';
import { PageShell } from '../AppHeader';
import { useMerchantContext } from '../purchases/_shared/merchant-context';

const PAGE_SIZE = 25;

export default function SuppliersPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const { status, context, retry } = useMerchantContext(locale);
  const [search, setSearch] = useState('');
  const [owedOnly, setOwedOnly] = useState(false);
  const [rows, setRows] = useState<SupplierRowModel[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const ticket = useRef(0);
  const withBalances = context?.access.businessWide ?? false;

  const load = useCallback(
    async (after: string | null): Promise<{ rows: SupplierRowModel[]; next: string | null }> => {
      const term = search.trim();
      const common = { limit: PAGE_SIZE, ...(term ? { search: term } : {}), ...(after ? { cursor: after } : {}) };
      if (withBalances) {
        const page = await listSupplierBalances({ ...common, ...(owedOnly ? { owedOnly: true } : {}) });
        return {
          rows: page.items.map((r) => ({ supplierId: r.supplierId, name: r.name, status: r.status, owed: r.owed, inYourFavour: r.inYourFavour })),
          next: page.nextCursor,
        };
      }
      const page = await listSuppliers(common);
      return { rows: page.items.map((s) => ({ supplierId: s.id, name: s.name, status: s.status, owed: null, inYourFavour: null })), next: page.nextCursor };
    },
    [search, owedOnly, withBalances],
  );

  useEffect(() => {
    if (status !== 'ready') return;
    const mine = ++ticket.current;
    setErrorKey(null);
    load(null)
      .then((page) => {
        if (mine !== ticket.current) return;
        setRows(page.rows);
        setCursor(page.next);
      })
      .catch((error: unknown) => {
        if (mine !== ticket.current) return;
        setRows([]);
        setCursor(null);
        setErrorKey(refusalKey(error));
      });
  }, [status, load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await load(cursor);
      setRows((prev) => [...prev, ...page.rows]);
      setCursor(page.next);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PageShell locale={locale} active="suppliers">
      {status !== 'ready' || !context ? (
        <PageStateView t={t} locale={locale} status={status === 'ready' ? 'loading' : status} onRetry={retry} />
      ) : (
        <SupplierListView
          t={t}
          locale={locale}
          withBalances={withBalances}
          rows={rows}
          search={search}
          owedOnly={owedOnly}
          canReceive={context.can('purchases.manage')}
          hasMore={cursor !== null}
          loadingMore={loadingMore}
          errorKey={errorKey}
          on={{
            onSearch: setSearch,
            onOwedOnly: setOwedOnly,
            onOpen: (supplierId) => router.push(`/${locale}/suppliers/${supplierId}`),
            onLoadMore: () => void loadMore(),
            onReceive: () => router.push(`/${locale}/purchases/receive`),
          }}
        />
      )}
    </PageShell>
  );
}
