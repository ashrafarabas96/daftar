'use client';
/**
 * Receive a payment (القبض, P4-S4): `POST /v1/customer-payments`.
 *
 * The page reads the customer, the payment methods and the customer's open
 * invoices (oldest first, as the server orders them), and sends what the
 * merchant typed. It does no money arithmetic of its own: the body is built by
 * `planCollectPayment`, and every figure after the send is the server's.
 *
 * - The payment, credit and allocation ids are minted ONCE per form
 *   (`mintCollectIds`) and re-sent unchanged on a retry, a retryable 409
 *   (`withConflictRetry`) and a double click (`createSubmitGuard`, plus the
 *   button disabled while in flight). A new form — after a saved payment, or
 *   "start a new payment" — re-reads everything and mints new ids.
 * - A refusal sets the refusal text and nothing else: the form keeps every
 *   figure typed.
 * - A replayed answer (200, `replayed: true`) is a success and is shown as one.
 * - A 403 on load renders the permission state; on send, the refusal text.
 */
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { notFound } from 'next/navigation';
import type { CustomerDto, CustomerPaymentResultDto, PaymentMethodDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { isUuid } from '@/lib/route-ids';
import { listPaymentMethods } from '@/lib/phase3-api';
import { refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { localDateIso } from '@/lib/phase3-format';
import { collectPayment, getCustomer, listOpenInvoices, type CustomerOpenInvoiceDto } from '@/lib/phase4-collect-payment-api';
import { PageStateView, type PageStatus } from '@/views/common/feedback';
import { activeMethodChoices } from '@/views/common/payment-methods';
import { CollectPaymentView, type CollectFormField } from '@/views/customers/CollectPaymentView';
import {
  createSubmitGuard,
  mintCollectIds,
  planCollectPayment,
  surplusOf,
  type CollectFormErrors,
  type CollectFormModel,
  type CollectRowModel,
} from '@/views/customers/collect-payment';
import { PageShell } from '../../../AppHeader';
import { OPEN_INVOICES_PAGE, loadFailureStatus, useCollectSession } from './collect-page-kit';

const toRow = (invoice: CustomerOpenInvoiceDto): CollectRowModel => ({ ...invoice, amount: '', invalid: false });

/** The payment currencies on offer: those of the invoices that can take money, then the business's own. */
function currencyOptions(rows: readonly CollectRowModel[], baseCurrency: string): string[] {
  return [...new Set([...rows.filter((r) => !r.isCredit).map((r) => r.currency), baseCurrency])];
}

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
  const [rows, setRows] = useState<CollectRowModel[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [asOf, setAsOf] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [form, setForm] = useState<CollectFormModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [result, setResult] = useState<CustomerPaymentResultDto | null>(null);
  // One set of ids per form, kept across every retry (A-12(4)); one send at a time.
  const ids = useRef(mintCollectIds());
  const guard = useRef(createSubmitGuard());

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
        ids.current = mintCollectIds();
        setCustomer(c);
        setMethods(pm.items);
        setRows(loaded);
        setCursor(open.nextCursor);
        setAsOf(today);
        setForm({
          methodId: active[0]?.paymentMethodId ?? '',
          currency: options[0] ?? baseCurrency,
          currencyOptions: options,
          amount: '',
          date: today,
          reference: '',
          errors: {},
        });
        setResult(null);
        setErrorKey(null);
        setLoadStatus('ready');
      } catch (error) {
        if (live) setLoadStatus(loadFailureStatus(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [session.status, session.baseCurrency, customerId, locale]);

  /** A fresh form: everything re-read, new ids. */
  const startOver = useCallback(() => setAttempt((n) => n + 1), []);

  async function loadMore() {
    if (cursor === null || !form) return;
    setLoadingMore(true);
    setErrorKey(null);
    try {
      const page = await listOpenInvoices(customerId, { asOf, cursor, limit: OPEN_INVOICES_PAGE });
      // The button is disabled while this read is in flight, so `rows` is the list on screen.
      const next = [...rows, ...page.items.map(toRow)];
      setRows(next);
      setForm((f) => (f ? { ...f, currencyOptions: currencyOptions(next, session.baseCurrency ?? f.currency) } : f));
      setCursor(page.nextCursor);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setLoadingMore(false);
    }
  }

  function submit() {
    if (!form) return;
    const method = activeMethodChoices(methods, locale, t).find((m) => m.paymentMethodId === form.methodId);
    const planned = planCollectPayment({ customerId, form, rows, method, ids: ids.current });
    if (!planned.ok) {
      const invalid = new Set(planned.invalidRows);
      setForm({ ...form, errors: planned.errors });
      setRows((current) => current.map((r) => ({ ...r, invalid: invalid.has(r.invoiceId) })));
      return;
    }
    const sent = guard.current.run(() => withConflictRetry(() => collectPayment(planned.body)));
    if (sent === null) return;
    setForm({ ...form, errors: {} });
    setBusy(true);
    setErrorKey(null);
    sent
      .then((answer) => setResult(answer))
      // The form is left exactly as typed: only the refusal is set.
      .catch((error: unknown) => setErrorKey(refusalKey(error)))
      .finally(() => setBusy(false));
  }

  const onField = (field: CollectFormField, value: string) => {
    const errorOf: Readonly<Record<CollectFormField, keyof CollectFormErrors>> = {
      methodId: 'method',
      currency: 'amount',
      amount: 'amount',
      date: 'date',
      reference: 'reference',
    };
    setForm((f) => (f ? { ...f, [field]: value, errors: { ...f.errors, [errorOf[field]]: false } } : f));
  };

  const onRowAmount = (invoiceId: string, value: string) => {
    setRows((current) => current.map((r) => (r.invoiceId === invoiceId ? { ...r, amount: value, invalid: false } : r)));
    setForm((f) => (f ? { ...f, errors: { ...f.errors, rows: false, tooMany: false } } : f));
  };

  const status = session.status !== 'ready' ? session.status : loadStatus;
  if (status !== 'ready' || !customer || !form) {
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
        form={form}
        rows={rows}
        hasMore={cursor !== null}
        loadingMore={loadingMore}
        surplus={surplusOf(form, rows)}
        busy={busy}
        errorKey={errorKey}
        result={result}
        on={{ onField, onRowAmount, onLoadMore: () => void loadMore(), onSubmit: submit, onStartOver: startOver }}
      />
    </PageShell>
  );
}
