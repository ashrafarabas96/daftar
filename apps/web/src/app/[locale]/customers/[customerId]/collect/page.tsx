'use client';
/**
 * Receive a payment (القبض, P4-S4): `POST /v1/customer-payments`.
 *
 * The page reads the customer, the payment methods and the customer's open
 * invoices (oldest first, as the server orders them), and sends what the
 * merchant typed. It holds no send logic of its own: one `CollectFlow` per
 * form (`views/customers/collect-flow.ts`) owns the ids, the double-click
 * guard, the retry and the reading of an already-stored payment, and every
 * outcome is folded into the screen by `afterOutcome`. Both are tested
 * without React.
 *
 * - The ids are minted when the flow is created, i.e. once per form. A new
 *   flow — a new form, new ids — is created only by a fresh load, which the
 *   view offers only beside a saved or an already-stored payment.
 * - A refusal sets the refusal text and nothing else.
 * - A 403 on load renders the permission state; on send, the refusal text.
 */
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { notFound } from 'next/navigation';
import type { CustomerDto, PaymentMethodDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { isUuid } from '@/lib/route-ids';
import { listPaymentMethods } from '@/lib/phase3-api';
import { refusalKey } from '@/lib/phase3-errors';
import { localDateIso } from '@/lib/phase3-format';
import { collectPayment, getCustomer, getStoredPayment, listOpenInvoices, type CustomerOpenInvoiceDto } from '@/lib/phase4-collect-payment-api';
import { PageStateView, type PageStatus } from '@/views/common/feedback';
import { activeMethodChoices } from '@/views/common/payment-methods';
import { CollectPaymentView, type CollectFormField } from '@/views/customers/CollectPaymentView';
import { afterOutcome, beforeSend, createCollectFlow, type CollectFlow, type CollectOutcome, type CollectScreenState } from '@/views/customers/collect-flow';
import { planCollectPayment, surplusOf, type CollectFormErrors, type CollectRowModel } from '@/views/customers/collect-payment';
import { PageShell } from '../../../AppHeader';
import { OPEN_INVOICES_PAGE, loadFailureStatus, useCollectSession } from './collect-page-kit';

const toRow = (invoice: CustomerOpenInvoiceDto): CollectRowModel => ({ ...invoice, amount: '', invalid: false });

/** The payment currencies on offer: those of the invoices that can take money, then the business's own. */
function currencyOptions(rows: readonly CollectRowModel[], baseCurrency: string): string[] {
  return [...new Set([...rows.filter((r) => !r.isCredit).map((r) => r.currency), baseCurrency])];
}

const newFlow = (): CollectFlow => createCollectFlow({ send: collectPayment, readStored: getStoredPayment });

export default function CollectPaymentPage({ params }: { params: Promise<{ locale: Locale; customerId: string }> }) {
  const { locale, customerId } = use(params);
  // An id from the URL reaches no API path unless it is a UUID (L-1).
  if (!isUuid(customerId)) notFound();
  const t = makeT(locale);
  const [attempt, setAttempt] = useState(0);
  const session = useCollectSession(locale, attempt);
  const [loadStatus, setLoadStatus] = useState<PageStatus | 'ready'>('loading');
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [methods, setMethods] = useState<PaymentMethodDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [asOf, setAsOf] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [screen, setScreen] = useState<CollectScreenState | null>(null);
  // One flow — one set of ids — per form, created by a fresh load and by nothing else.
  const flow = useRef<CollectFlow | null>(null);

  useEffect(() => {
    if (session.status !== 'ready' || session.baseCurrency === null) return;
    const baseCurrency = session.baseCurrency;
    let live = true;
    setLoadStatus('loading');
    void (async () => {
      try {
        const today = localDateIso();
        const [c, pm, open] = await Promise.all([
          getCustomer(customerId),
          listPaymentMethods(),
          listOpenInvoices(customerId, { asOf: today, limit: OPEN_INVOICES_PAGE }),
        ]);
        if (!live) return;
        const loaded = open.items.map(toRow);
        const options = currencyOptions(loaded, baseCurrency);
        const active = activeMethodChoices(pm.items, locale, makeT(locale));
        flow.current = newFlow();
        setCustomer(c);
        setMethods(pm.items);
        setCursor(open.nextCursor);
        setAsOf(today);
        setScreen({
          form: {
            methodId: active[0]?.paymentMethodId ?? '',
            currency: options[0] ?? baseCurrency,
            currencyOptions: options,
            amount: '',
            date: today,
            reference: '',
            errors: {},
          },
          rows: loaded,
          busy: false,
          errorKey: null,
          result: null,
          stored: null,
          storedUnread: false,
        });
        setLoadStatus('ready');
      } catch (error) {
        if (live) setLoadStatus(loadFailureStatus(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [session.status, session.baseCurrency, customerId, locale]);

  /** A fresh form: everything re-read, a new flow, new ids. */
  const startOver = useCallback(() => setAttempt((n) => n + 1), []);

  async function loadMore() {
    if (cursor === null || !screen) return;
    setLoadingMore(true);
    setScreen((s) => (s ? { ...s, errorKey: null } : s));
    try {
      const page = await listOpenInvoices(customerId, { asOf, cursor, limit: OPEN_INVOICES_PAGE });
      setScreen((s) => {
        if (!s) return s;
        const rows = [...s.rows, ...page.items.map(toRow)];
        return { ...s, rows, form: { ...s.form, currencyOptions: currencyOptions(rows, session.baseCurrency ?? s.form.currency) } };
      });
      setCursor(page.nextCursor);
    } catch (error) {
      setScreen((s) => (s ? { ...s, errorKey: refusalKey(error) } : s));
    } finally {
      setLoadingMore(false);
    }
  }

  function settle(pending: Promise<CollectOutcome> | null | undefined) {
    if (!pending) return;
    setScreen((s) => (s ? beforeSend(s) : s));
    void pending.then((outcome) => setScreen((s) => (s ? afterOutcome(s, outcome) : s)));
  }

  function submit() {
    if (!screen) return;
    const { form, rows } = screen;
    const method = activeMethodChoices(methods, locale, t).find((m) => m.paymentMethodId === form.methodId);
    settle(flow.current?.submit((ids) => planCollectPayment({ customerId, form, rows, method, ids })));
  }

  const onField = (field: CollectFormField, value: string) => {
    const errorOf: Readonly<Record<CollectFormField, keyof CollectFormErrors>> = {
      methodId: 'method',
      currency: 'amount',
      amount: 'amount',
      date: 'date',
      reference: 'reference',
    };
    setScreen((s) => (s ? { ...s, form: { ...s.form, [field]: value, errors: { ...s.form.errors, [errorOf[field]]: false } } } : s));
  };

  const onRowAmount = (invoiceId: string, value: string) => {
    setScreen((s) =>
      s
        ? {
            ...s,
            rows: s.rows.map((r) => (r.invoiceId === invoiceId ? { ...r, amount: value, invalid: false } : r)),
            form: { ...s.form, errors: { ...s.form.errors, rows: false, tooMany: false } },
          }
        : s,
    );
  };

  const status = session.status !== 'ready' ? session.status : loadStatus;
  if (status !== 'ready' || !customer || !screen) {
    return (
      <PageShell locale={locale} active="customers">
        <PageStateView t={t} locale={locale} status={status === 'ready' ? 'loading' : status} onRetry={startOver} />
      </PageShell>
    );
  }

  return (
    <PageShell locale={locale} active="customers">
      <CollectPaymentView
        t={t}
        locale={locale}
        customer={{ name: customer.name, status: customer.status }}
        methods={methods}
        form={screen.form}
        rows={screen.rows}
        hasMore={cursor !== null}
        loadingMore={loadingMore}
        surplus={surplusOf(screen.form, screen.rows)}
        busy={screen.busy}
        errorKey={screen.errorKey}
        result={screen.result}
        stored={screen.stored}
        storedUnread={screen.storedUnread}
        on={{
          onField,
          onRowAmount,
          onLoadMore: () => void loadMore(),
          onSubmit: submit,
          onRereadStored: () => settle(flow.current?.rereadStored()),
          onStartOver: startOver,
        }}
      />
    </PageShell>
  );
}
