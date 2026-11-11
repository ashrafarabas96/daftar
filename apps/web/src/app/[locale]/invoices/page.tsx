'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeT, type Locale } from '@/lib/i18n';
import { refusalKey } from '@/lib/phase3-errors';
import { listInvoices, type InvoiceSummaryDto } from '@/lib/phase4-invoices-api';
import { InvoiceListView } from '@/views/invoices/InvoiceListView';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../AppHeader';
import { INVOICE_PAGE_SIZE, phaseOfFailure, useInvoiceSession, type InvoicePhase } from './invoices-page-kit';

/**
 * Invoices (MVP-02): the issued documents, from `GET /v1/invoices`. Nothing is
 * cached: every visit reads again, and "show more" passes the server's cursor.
 */
export default function InvoicesPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const signedIn = useInvoiceSession(locale);
  const [phase, setPhase] = useState<InvoicePhase>('loading');
  const [invoices, setInvoices] = useState<InvoiceSummaryDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setPhase('loading');
    listInvoices({ limit: INVOICE_PAGE_SIZE })
      .then((page) => {
        if (!live) return;
        setInvoices(page.items);
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
      const page = await listInvoices({ limit: INVOICE_PAGE_SIZE, cursor });
      setInvoices((current) => [...(current ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PageShell locale={locale} active="invoices">
      {phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={phase} onRetry={reload} />
      ) : (
        <InvoiceListView
          t={t}
          locale={locale}
          invoices={invoices}
          hasMore={cursor !== null}
          loadingMore={loadingMore}
          errorKey={errorKey}
          onOpen={(invoiceId) => router.push(`/${locale}/invoices/${encodeURIComponent(invoiceId)}`)}
          onLoadMore={() => void loadMore()}
          onSellSomething={() => router.push(`/${locale}/pos`)}
        />
      )}
    </PageShell>
  );
}
