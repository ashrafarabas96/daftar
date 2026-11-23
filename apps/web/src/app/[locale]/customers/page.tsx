'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { makeT, type Locale } from '@/lib/i18n';
import { refusalKey } from '@/lib/phase3-errors';
import { listCustomers, type CustomerListItemDto } from '@/lib/phase4-customers-api';
import { CustomerListView } from '@/views/customers/CustomerListView';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../AppHeader';
import { CUSTOMER_PAGE_SIZE, phaseOfFailure, useCustomerSession, type CustomerPhase } from './customers-page-kit';

/**
 * Customers (MVP-02), read-only: from `GET /v1/customers`. Nothing is cached:
 * every visit reads again, and "show more" passes the server's cursor. The rows
 * are shown in the order the server sends them.
 */
export default function CustomersPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const signedIn = useCustomerSession(locale);
  const [phase, setPhase] = useState<CustomerPhase>('loading');
  const [customers, setCustomers] = useState<CustomerListItemDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setPhase('loading');
    listCustomers({ limit: CUSTOMER_PAGE_SIZE })
      .then((page) => {
        if (!live) return;
        setCustomers(page.items);
        setCursor(page.nextCursor);
        setPhase('ready');
      })
      .catch((error: unknown) => {
        if (live) setPhase(phaseOfFailure(error));
      });
    return () => {
      live = false;
    };
  }, [signedIn, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  async function loadMore() {
    if (cursor === null) return;
    setLoadingMore(true);
    setErrorKey(null);
    try {
      const page = await listCustomers({ limit: CUSTOMER_PAGE_SIZE, cursor });
      setCustomers((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PageShell locale={locale} active="customers">
      {phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={phase} onRetry={reload} />
      ) : (
        <CustomerListView
          t={t}
          locale={locale}
          customers={customers}
          hasMore={cursor !== null}
          loadingMore={loadingMore}
          errorKey={errorKey}
          onLoadMore={() => void loadMore()}
        />
      )}
    </PageShell>
  );
}
