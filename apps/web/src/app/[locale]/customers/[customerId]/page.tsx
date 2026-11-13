'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { notFound } from 'next/navigation';
import { makeT, type Locale } from '@/lib/i18n';
import { refusalKey } from '@/lib/phase3-errors';
import {
  CREDITS_READ_CAP,
  getCustomer,
  getCustomerAging,
  getCustomerReceivable,
  listCustomerCredits,
  listCustomerOpenInvoices,
  type CustomerOpenInvoiceDto,
} from '@/lib/phase4-customer-account-api';
import { isUuid } from '@/lib/route-ids';
import { CustomerAccountView, type CustomerAccountViewProps } from '@/views/customers/CustomerAccountView';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../../AppHeader';
import { OPEN_INVOICE_PAGE_SIZE, accountAsOf, phaseOfFailure, unreadableAccount, useAccountSession, type AccountPhase } from './account-page-kit';

type Account = Pick<CustomerAccountViewProps, 'customer' | 'receivable' | 'aging' | 'credits' | 'creditsCapped'>;

/**
 * The customer account (MVP-02), read-only: what one customer owes, from five
 * merged reads. Nothing is cached — every visit reads again — and nothing here
 * writes: the customer writes are another lane's unmerged PR and collecting a
 * payment is the next screen.
 *
 * The page shows the server's figures as they came. It does no arithmetic on
 * them, and an answer it cannot place (`unreadableAccount`) is a failed load,
 * never a partial screen. A 403 on any read is the permission state, a 404 is
 * not-found, anything else is the data-safe failure.
 */
export default function CustomerAccountPage({ params }: { params: Promise<{ locale: Locale; customerId: string }> }) {
  const { locale, customerId } = use(params);
  // An id from the URL reaches no API path unless it is a UUID (L-1).
  if (!isUuid(customerId)) notFound();
  const t = makeT(locale);
  const signedIn = useAccountSession(locale);
  const [asOf] = useState(accountAsOf);
  const [phase, setPhase] = useState<AccountPhase>('loading');
  const [account, setAccount] = useState<Account | null>(null);
  const [invoices, setInvoices] = useState<CustomerOpenInvoiceDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setPhase('loading');
    Promise.all([
      getCustomer(customerId),
      getCustomerReceivable(customerId),
      getCustomerAging(customerId, asOf),
      listCustomerOpenInvoices(customerId, { asOf, limit: OPEN_INVOICE_PAGE_SIZE }),
      listCustomerCredits(customerId),
    ])
      .then(([customer, receivable, aging, open, credits]) => {
        if (!live) return;
        if (unreadableAccount({ receivable, aging, openInvoices: open.items, openInvoicesAsOf: open.asOf, credits }, asOf).length > 0) {
          setPhase('failed');
          return;
        }
        setAccount({ customer, receivable, aging, credits, creditsCapped: credits.length >= CREDITS_READ_CAP });
        setInvoices(open.items);
        setCursor(open.nextCursor);
        setPhase('ready');
      })
      .catch((error: unknown) => {
        if (live) setPhase(phaseOfFailure(error));
      });
    return () => {
      live = false;
    };
  }, [signedIn, attempt, customerId, asOf]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  async function loadMore() {
    if (cursor === null || account === null) return;
    setLoadingMore(true);
    setErrorKey(null);
    try {
      const page = await listCustomerOpenInvoices(customerId, { asOf, cursor, limit: OPEN_INVOICE_PAGE_SIZE });
      // A page this screen cannot place is refused like any failed read: the rows on screen and the cursor stay.
      if (unreadableAccount({ ...account, openInvoices: page.items, openInvoicesAsOf: page.asOf }, asOf).length > 0)
        throw new Error('unreadable open-invoices page');
      setInvoices((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setLoadingMore(false);
    }
  }

  if (phase === 'missing') notFound();

  return (
    <PageShell locale={locale} active="customers">
      {phase !== 'ready' || account === null ? (
        <ScreenState t={t} locale={locale} state={phase === 'ready' ? 'loading' : phase} onRetry={reload} />
      ) : (
        <CustomerAccountView
          t={t}
          locale={locale}
          customer={account.customer}
          receivable={account.receivable}
          aging={account.aging}
          credits={account.credits}
          creditsCapped={account.creditsCapped}
          openInvoices={invoices}
          hasMore={cursor !== null}
          loadingMore={loadingMore}
          errorKey={errorKey}
          onLoadMore={() => void loadMore()}
        />
      )}
    </PageShell>
  );
}
