'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeT, type Locale } from '@/lib/i18n';
import { getInvoice, getInvoiceSettlement, type InvoiceDto, type InvoiceSettlementDto } from '@/lib/phase4-invoices-api';
import { InvoiceDetailView } from '@/views/invoices/InvoiceDetailView';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../../AppHeader';
import { phaseOfFailure, useInvoiceSession, type InvoicePhase } from '../invoices-page-kit';

/**
 * One invoice (MVP-02): `GET /v1/invoices/:invoiceId`, then the settlement read
 * on its own.
 *
 * The two reads are deliberately NOT one `Promise.all`. The settlement needs
 * `receivables.view` AND business-wide branch scope, so it can be refused while
 * the invoice itself reads fine — and a single combined failure would turn a
 * partial refusal into a failed screen. So the invoice is shown first, and the
 * settlement is attempted after it; any failure of that second read leaves the
 * screen without collection figures rather than without an invoice.
 *
 * The id comes from the URL, so it is whatever the browser's address bar holds.
 * Nothing here validates it: the server refuses a non-canonical id with its own
 * typed refusal (`strictUuidParam`), and a client-side guess at the rule would
 * be a second, weaker copy of it.
 */
export default function InvoicePage({ params }: { params: Promise<{ locale: Locale; invoiceId: string }> }) {
  const { locale, invoiceId } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const signedIn = useInvoiceSession(locale);
  const [phase, setPhase] = useState<InvoicePhase>('loading');
  const [invoice, setInvoice] = useState<InvoiceDto | null>(null);
  const [settlement, setSettlement] = useState<InvoiceSettlementDto | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!signedIn) return undefined;
    let live = true;
    setPhase('loading');
    setSettlement(null);
    void (async () => {
      try {
        const found = await getInvoice(invoiceId);
        if (!live) return;
        setInvoice(found);
        setPhase('ready');
        // Its own read, its own failure: a refusal here is "no collection
        // figures", and it must not take the invoice down with it.
        const collected = await getInvoiceSettlement(invoiceId).catch(() => null);
        if (live) setSettlement(collected);
      } catch (error) {
        if (live) setPhase(phaseOfFailure(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [signedIn, invoiceId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <PageShell locale={locale} active="invoices">
      {phase !== 'ready' || invoice === null ? (
        <ScreenState t={t} locale={locale} state={phase === 'ready' ? 'loading' : phase} onRetry={reload} />
      ) : (
        <InvoiceDetailView t={t} locale={locale} invoice={invoice} settlement={settlement} onBack={() => router.push(`/${locale}/invoices`)} />
      )}
    </PageShell>
  );
}
