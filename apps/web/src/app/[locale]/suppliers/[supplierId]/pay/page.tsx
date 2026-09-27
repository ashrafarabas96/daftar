'use client';
/**
 * Pay Supplier (P3-S7 contract A-11, A-13, A-14, A-09(b), A-09(e); Annex R
 * #19, #20).
 *
 * The split of a payment over the open purchases is the SERVER's proposal
 * (`open-purchases?currency=&amount=`): oldest first, at most fifty
 * purchases, never leaving less than the smallest coin owed. The page does no
 * arithmetic: it sends the typed amount and the proposed (or merchant-typed)
 * per-purchase amounts, and the server judges them. The payment id and one
 * allocation id per purchase are minted once per form, so a retry is a
 * replay; a retryable 409 is retried once with the same ids (§3(c)).
 *
 * The first way to pay is created by kind; the system picks its account from
 * the kind (TL-3): the merchant never sees or chooses an account.
 */
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PaymentMethodDto, SupplierDto, SupplierPaymentAllocationRequestDto, SupplierPaymentResultDto } from '@daftar/shared-contracts';
import { makeT, translate, type Locale } from '@/lib/i18n';
import {
  allocateBalanceInYourFavour,
  createPaymentMethod,
  enterExchangeRate,
  getSupplier,
  listOpenPurchases,
  listPaymentMethodDefaults,
  listPaymentMethods,
  listSettlementAccounts,
  listSupplierCreditNotes,
  paySupplier,
  type PaymentMethodDefaultDto,
} from '@/lib/phase3-api';
import { isMissingExchangeRate, refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { amountInputToMinor, localDateIso, normaliseDigits } from '@/lib/phase3-format';
import { isNonZeroMinor, minorToMajorText } from '@/views/common/amount-text';
import { PageStateView, type ExchangeRatePromptProps, type PageStatus } from '@/views/common/feedback';
import { activeMethodChoices } from '@/views/common/payment-methods';
import { PaySupplierView, type PayFormField } from '@/views/suppliers/PaySupplierView';
import type { FavourNoteModel, FavourUseModel, MethodSetupModel, PayFormModel, PayRowModel } from '@/views/suppliers/types';
import { PageShell } from '../../../AppHeader';
import { statusOfFailure, useMerchantContext } from '../../../purchases/_shared/merchant-context';

/** Which system account a new method of each kind posts to (A-09(e) table; TL-3). The merchant never sees it. */
const SETTLEMENT_ACCOUNT_KEY: Readonly<Record<PaymentMethodDefaultDto['systemType'], string>> = {
  cash: 'cash',
  card: 'card_clearing',
  bank_transfer: 'bank',
  wallet: 'wallet_clearing',
  cheque: 'cheque_clearing',
};

/** At most fifty purchases per payment (S6 A-07), and the open-purchases read pages at fifty. */
const MAX_ROWS = 50;

const emptyForm = (currency: string, currencyOptions: string[]): PayFormModel => ({
  methodId: '',
  currency,
  currencyOptions,
  amount: '',
  date: localDateIso(),
  reference: '',
  manual: false,
  errors: {},
});

export default function PaySupplierPage({ params }: { params: Promise<{ locale: Locale; supplierId: string }> }) {
  const { locale, supplierId } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const { status, context, retry } = useMerchantContext(locale);
  const [loadStatus, setLoadStatus] = useState<PageStatus | 'ready'>('loading');
  const [supplier, setSupplier] = useState<SupplierDto | null>(null);
  const [methods, setMethods] = useState<PaymentMethodDto[]>([]);
  const [setup, setSetup] = useState<MethodSetupModel | null>(null);
  const [form, setForm] = useState<PayFormModel>(() => emptyForm('', []));
  const [rows, setRows] = useState<PayRowModel[]>([]);
  const [proposed, setProposed] = useState(false);
  const [unallocatedMinor, setUnallocatedMinor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [fx, setFx] = useState<{ currency: string; rateText: string; rateInvalid: boolean; busy: boolean } | null>(null);
  const [result, setResult] = useState<SupplierPaymentResultDto | null>(null);
  const [notes, setNotes] = useState<FavourNoteModel[] | null>(null);
  const [favourUse, setFavourUse] = useState<FavourUseModel | null>(null);
  // Ids minted once per form and kept across retries (A-12(4)).
  const ids = useRef({ paymentId: crypto.randomUUID(), fxKey: crypto.randomUUID(), methodId: crypto.randomUUID() });
  const allocationIds = useRef(new Map<string, string>());
  const allocationIdFor = (key: string): string => {
    const known = allocationIds.current.get(key);
    if (known) return known;
    const minted = crypto.randomUUID();
    allocationIds.current.set(key, minted);
    return minted;
  };

  const baseCurrency = context?.business.baseCurrency ?? '';
  const mayUseFavour = (context?.access.businessWide ?? false) && (context?.can('suppliers.pay') ?? false);

  const loadOpen = useCallback(async (): Promise<PayRowModel[]> => {
    const open = await listOpenPurchases(supplierId, { limit: MAX_ROWS });
    return open.items.map((p) => ({ ...p, proposedMinor: null, amount: '', applied: '', invalid: false }));
  }, [supplierId]);

  const loadNotes = useCallback(async (): Promise<FavourNoteModel[] | null> => {
    if (!mayUseFavour) return null;
    const page = await listSupplierCreditNotes(supplierId, { limit: 50 });
    return page.items
      .filter((n) => isNonZeroMinor(n.remainingTxnMinor))
      .map((n) => ({ creditNoteId: n.creditNoteId, issuedOn: n.issuedOn, currency: n.currency, remainingTxnMinor: n.remainingTxnMinor }));
  }, [supplierId, mayUseFavour]);

  const setupFor = useCallback(
    async (active: number): Promise<MethodSetupModel | null> => {
      if (active > 0 || !context) return null;
      if (!(context.can('accounting.chart.manage') && context.can('accounting.view'))) return { mode: 'ask_owner', options: [], chosen: null, busy: false };
      const defaults = await listPaymentMethodDefaults();
      return { mode: 'choose', options: defaults.items, chosen: null, busy: false };
    },
    [context],
  );

  useEffect(() => {
    if (status !== 'ready' || !context) return;
    if (!context.can('suppliers.pay')) {
      setLoadStatus('denied');
      return;
    }
    let live = true;
    void (async () => {
      try {
        const [s, pm, open, favour] = await Promise.all([getSupplier(supplierId), listPaymentMethods(), loadOpen(), loadNotes()]);
        const active = activeMethodChoices(pm.items, locale, makeT(locale));
        const firstSetup = await setupFor(active.length);
        if (!live) return;
        const currencies = [...new Set([...open.map((r) => r.currency), context.business.baseCurrency])];
        setSupplier(s);
        setMethods(pm.items);
        setSetup(firstSetup);
        setRows(open);
        setNotes(favour);
        setForm({ ...emptyForm(open[0]?.currency ?? context.business.baseCurrency, currencies), methodId: active[0]?.paymentMethodId ?? '' });
        setLoadStatus('ready');
      } catch (error) {
        if (live) setLoadStatus(statusOfFailure(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [status, context, supplierId, locale, loadOpen, loadNotes, setupFor]);

  // ── The server's proposal ───────────────────────────────────────────────
  async function propose() {
    const amountMinor = amountInputToMinor(form.amount, form.currency);
    if (amountMinor === null || !isNonZeroMinor(amountMinor)) {
      setForm((f) => ({ ...f, errors: { ...f.errors, amount: true } }));
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      const answer = await listOpenPurchases(supplierId, { currency: form.currency, amount: amountMinor, limit: MAX_ROWS });
      setRows(
        answer.items.map((p) => ({
          ...p,
          amount: p.proposedMinor !== null && isNonZeroMinor(p.proposedMinor) ? minorToMajorText(p.proposedMinor, form.currency) : '',
          applied: '',
          invalid: false,
        })),
      );
      setUnallocatedMinor(answer.unallocatedMinor);
      setProposed(true);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }

  // ── Pay ────────────────────────────────────────────────────────────────
  async function submit() {
    const method = activeMethodChoices(methods, locale, t).find((m) => m.paymentMethodId === form.methodId);
    const amountMinor = amountInputToMinor(form.amount, form.currency);
    let rowsOk = true;
    const checkedRows = rows.map((r) => {
      if (!form.manual || r.amount.trim().length === 0) return { ...r, invalid: false };
      const pay = amountInputToMinor(r.amount, form.currency);
      const applied = r.currency === form.currency ? pay : amountInputToMinor(r.applied, r.currency);
      const invalid = pay === null || !isNonZeroMinor(pay) || applied === null || !isNonZeroMinor(applied);
      if (invalid) rowsOk = false;
      return { ...r, invalid };
    });
    const allocations: SupplierPaymentAllocationRequestDto[] = form.manual
      ? checkedRows.flatMap((r) => {
          const pay = amountInputToMinor(r.amount, form.currency);
          const applied = r.currency === form.currency ? pay : amountInputToMinor(r.applied, r.currency);
          return pay !== null && applied !== null && isNonZeroMinor(pay) && isNonZeroMinor(applied)
            ? [{ allocationId: allocationIdFor(r.purchaseId), purchaseId: r.purchaseId, paymentAmountMinor: pay, purchaseAmountAppliedMinor: applied }]
            : [];
        })
      : rows.flatMap((r) =>
          r.proposedMinor !== null && isNonZeroMinor(r.proposedMinor)
            ? [
                {
                  allocationId: allocationIdFor(r.purchaseId),
                  purchaseId: r.purchaseId,
                  paymentAmountMinor: r.proposedMinor,
                  purchaseAmountAppliedMinor: r.proposedMinor,
                },
              ]
            : [],
        );
    const errors = {
      method: method === undefined,
      amount: amountMinor === null || !isNonZeroMinor(amountMinor),
      date: form.date === '',
      reference: method?.requiresReference === true && form.reference.trim().length === 0,
      rows: !rowsOk || allocations.length === 0,
    };
    setRows(checkedRows);
    setForm((f) => ({ ...f, errors }));
    if (Object.values(errors).some(Boolean) || !method || amountMinor === null) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const answer = await withConflictRetry(() =>
        paySupplier({
          paymentId: ids.current.paymentId,
          supplierId,
          paymentMethodId: method.paymentMethodId,
          currencyCode: form.currency,
          amountMinor,
          paymentDate: form.date,
          reference: form.reference.trim() || null,
          allocations,
        }),
      );
      setFx(null);
      setResult(answer);
    } catch (error) {
      setErrorKey(refusalKey(error));
      if (isMissingExchangeRate(error)) {
        const foreignRow = rows.find((r) => r.currency !== baseCurrency);
        setFx({
          currency: form.currency !== baseCurrency ? form.currency : (foreignRow?.currency ?? form.currency),
          rateText: '',
          rateInvalid: false,
          busy: false,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveRateAndRetry() {
    if (!fx || !context) return;
    const rate = normaliseDigits(fx.rateText);
    if (!/^\d+(\.\d{1,10})?$/.test(rate) || !/[1-9]/.test(rate)) {
      setFx({ ...fx, rateInvalid: true });
      return;
    }
    setFx({ ...fx, rateInvalid: false, busy: true });
    setErrorKey(null);
    try {
      await enterExchangeRate(
        context.business.businessId,
        { fromCurrency: fx.currency, toCurrency: baseCurrency, rate, effectiveAt: `${form.date}T00:00:00Z` },
        ids.current.fxKey,
      );
      setFx(null);
      await submit();
    } catch (error) {
      setErrorKey(refusalKey(error));
      setFx((f) => (f ? { ...f, busy: false } : f));
    }
  }

  // ── The first way to pay (A-09(e), TL-3) ────────────────────────────────
  async function createFirstMethod() {
    if (!setup || setup.chosen === null || !context) return;
    const systemType = setup.chosen;
    setSetup({ ...setup, busy: true });
    setErrorKey(null);
    try {
      const accounts = await listSettlementAccounts(context.business.businessId);
      const account = accounts.items.find((a) => a.systemKey === SETTLEMENT_ACCOUNT_KEY[systemType] && a.isActive);
      if (!account) {
        setErrorKey('error.accounting.account_not_found');
        setSetup((s) => (s ? { ...s, busy: false } : s));
        return;
      }
      await createPaymentMethod({
        paymentMethodId: ids.current.methodId,
        systemType,
        postingAccountId: account.accountId,
        requiresReference: false,
        sortOrder: 1,
        names: {
          ar: translate('ar', `payments.kind.${systemType}`),
          en: translate('en', `payments.kind.${systemType}`),
          tr: translate('tr', `payments.kind.${systemType}`),
        },
      });
      const pm = await listPaymentMethods();
      const active = activeMethodChoices(pm.items, locale, t);
      setMethods(pm.items);
      setSetup(null);
      setForm((f) => ({ ...f, methodId: active[0]?.paymentMethodId ?? '' }));
    } catch (error) {
      setErrorKey(refusalKey(error));
      setSetup((s) => (s ? { ...s, busy: false } : s));
    }
  }

  // ── Balance in your favour ─────────────────────────────────────────────
  async function proposeFavour(creditNoteId: string) {
    const note = notes?.find((n) => n.creditNoteId === creditNoteId);
    if (!note) return;
    setErrorKey(null);
    setFavourUse({ creditNoteId, currency: note.currency, rows: [], unallocatedMinor: null, busy: true, done: false });
    try {
      const answer = await listOpenPurchases(supplierId, { currency: note.currency, amount: note.remainingTxnMinor, limit: MAX_ROWS });
      setFavourUse({
        creditNoteId,
        currency: note.currency,
        rows: answer.items.flatMap((p) =>
          p.proposedMinor !== null && isNonZeroMinor(p.proposedMinor)
            ? [{ purchaseId: p.purchaseId, documentDate: p.documentDate, proposedMinor: p.proposedMinor }]
            : [],
        ),
        unallocatedMinor: answer.unallocatedMinor,
        busy: false,
        done: false,
      });
    } catch (error) {
      setErrorKey(refusalKey(error));
      setFavourUse(null);
    }
  }

  async function applyFavour() {
    if (!favourUse) return;
    const pending = favourUse;
    setFavourUse({ ...pending, busy: true });
    setErrorKey(null);
    const allocationDate = localDateIso();
    try {
      // One allocation per purchase, in the proposal's order; each id is kept, so a retry replays what already went through.
      for (const row of pending.rows) {
        await withConflictRetry(() =>
          allocateBalanceInYourFavour({
            allocationId: allocationIdFor(`${pending.creditNoteId}:${row.purchaseId}`),
            creditNoteId: pending.creditNoteId,
            purchaseId: row.purchaseId,
            allocationDate,
            creditAmountMinor: row.proposedMinor,
            purchaseAmountAppliedMinor: row.proposedMinor,
          }),
        );
      }
      const [open, favour] = await Promise.all([loadOpen(), loadNotes()]);
      setRows(open);
      setProposed(false);
      setNotes(favour);
      setFavourUse({ ...pending, busy: false, done: true });
    } catch (error) {
      setErrorKey(refusalKey(error));
      setFavourUse({ ...pending, busy: false });
    }
  }

  const onField = (field: PayFormField, value: string) => {
    const errorOf: Readonly<Record<PayFormField, keyof PayFormModel['errors']>> = {
      methodId: 'method',
      currency: 'amount',
      amount: 'amount',
      date: 'date',
      reference: 'reference',
    };
    setForm((f) => ({ ...f, [field]: value, errors: { ...f.errors, [errorOf[field]]: false } }));
    // A new amount or currency needs a new proposal from the server.
    if (field === 'amount' || field === 'currency') {
      setProposed(false);
      setUnallocatedMinor(null);
      setRows((rs) => rs.map((r) => ({ ...r, proposedMinor: null })));
    }
  };

  const pageStatus = status !== 'ready' ? status : loadStatus;
  if (pageStatus !== 'ready' || !context || !supplier) {
    return (
      <PageShell locale={locale} active="suppliers">
        <PageStateView t={t} locale={locale} status={pageStatus === 'ready' ? 'loading' : pageStatus} onRetry={retry} />
      </PageShell>
    );
  }

  const exchangeRate: ExchangeRatePromptProps | null = fx
    ? {
        date: form.date,
        currency: fx.currency,
        baseCurrency,
        canEnter: context.can('accounting.fx.manage') && context.access.businessWide,
        rateText: fx.rateText,
        rateInvalid: fx.rateInvalid,
        busy: fx.busy,
        onRateChange: (rateText) => setFx((f) => (f ? { ...f, rateText, rateInvalid: false } : f)),
        onSubmit: () => void saveRateAndRetry(),
      }
    : null;

  return (
    <PageShell locale={locale} active="suppliers">
      <PaySupplierView
        t={t}
        locale={locale}
        supplier={{ name: supplier.name, status: supplier.status }}
        methods={methods}
        setup={setup}
        form={form}
        rows={rows}
        proposed={proposed}
        unallocatedMinor={unallocatedMinor}
        busy={busy}
        errorKey={errorKey}
        exchangeRate={exchangeRate}
        result={result}
        favour={mayUseFavour && notes !== null && notes.length > 0 ? { notes, use: favourUse } : null}
        on={{
          onField,
          onPropose: () => void propose(),
          onToggleManual: () => setForm((f) => ({ ...f, manual: !f.manual, errors: { ...f.errors, rows: false } })),
          onRowAmount: (purchaseId, value) => setRows((rs) => rs.map((r) => (r.purchaseId === purchaseId ? { ...r, amount: value, invalid: false } : r))),
          onRowApplied: (purchaseId, value) => setRows((rs) => rs.map((r) => (r.purchaseId === purchaseId ? { ...r, applied: value, invalid: false } : r))),
          onSubmit: () => void submit(),
          onChooseSetup: (systemType) => setSetup((s) => (s ? { ...s, chosen: s.options.find((o) => o.systemType === systemType)?.systemType ?? null } : s)),
          onCreateMethod: () => void createFirstMethod(),
          onUseFavour: (creditNoteId) => void proposeFavour(creditNoteId),
          onApplyFavour: () => void applyFavour(),
          onCancelFavour: () => setFavourUse(null),
          onDone: () => router.push(`/${locale}/suppliers/${supplierId}`),
        }}
      />
    </PageShell>
  );
}
