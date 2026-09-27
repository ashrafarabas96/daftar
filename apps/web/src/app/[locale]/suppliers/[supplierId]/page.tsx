'use client';
/**
 * Supplier (P3-S7 contract A-11, TL-5; Annex R #5): what is still owed, the
 * balance in your favour, the open purchases, the payments and the purchases.
 * The owed figures, the credit notes and the payments are business-wide
 * reads, requested only for a business-wide caller. "Get money back" (S6's
 * supplier refund) needs business-wide scope and `suppliers.pay`; its refund
 * id is minted once per form, so a retry is a replay.
 */
import { use, useCallback, useEffect, useState } from 'react';
import { notFound, useRouter } from 'next/navigation';
import type { PaymentMethodDto, SupplierDto, SupplierPaymentDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { isUuid } from '@/lib/route-ids';
import {
  getMoneyBack,
  getSupplier,
  getSupplierPayable,
  listOpenPurchases,
  listPaymentMethods,
  listPurchases,
  listSupplierCreditNotes,
  listSupplierPayments,
} from '@/lib/phase3-api';
import { refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { amountInputToMinor, localDateIso } from '@/lib/phase3-format';
import { isNonZeroMinor } from '@/views/common/amount-text';
import { PageStateView, type PageStatus } from '@/views/common/feedback';
import { activeMethodChoices } from '@/views/common/payment-methods';
import type { PurchaseRowModel } from '@/views/purchases/types';
import { SupplierDetailView, type MoneyBackField } from '@/views/suppliers/SupplierDetailView';
import type { FavourNoteModel, MoneyBackForm, OpenPurchaseRowModel } from '@/views/suppliers/types';
import { PageShell } from '../../AppHeader';
import { warehouseNames } from '../../purchases/_shared/lookups';
import { statusOfFailure, useMerchantContext } from '../../purchases/_shared/merchant-context';

interface Loaded {
  supplier: SupplierDto;
  owed: { currency: string; amountMinor: string }[] | null;
  notes: FavourNoteModel[] | null;
  payments: SupplierPaymentDto[] | null;
  openPurchases: OpenPurchaseRowModel[];
  purchases: PurchaseRowModel[];
  methods: PaymentMethodDto[];
}

const closedMoneyBack = (date: string): Omit<MoneyBackForm, 'notes' | 'methods' | 'currencies'> => ({
  open: false,
  creditNoteId: '',
  methodId: '',
  amount: '',
  date,
  differentCurrency: false,
  receiptCurrency: '',
  receiptAmount: '',
  reference: '',
  errors: {},
  busy: false,
  done: null,
});

export default function SupplierDetailPage({ params }: { params: Promise<{ locale: Locale; supplierId: string }> }) {
  const { locale, supplierId } = use(params);
  // An id from the URL reaches no API path unless it is a UUID (L-1).
  if (!isUuid(supplierId)) notFound();
  const t = makeT(locale);
  const router = useRouter();
  const { status, context, retry } = useMerchantContext(locale);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadStatus, setLoadStatus] = useState<PageStatus | 'ready'>('loading');
  const [money, setMoney] = useState(() => closedMoneyBack(localDateIso()));
  const [refundId, setRefundId] = useState(() => crypto.randomUUID());
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const businessWide = context?.access.businessWide ?? false;
  const mayGetMoneyBack = businessWide && (context?.can('suppliers.pay') ?? false);

  const load = useCallback(async (): Promise<Loaded> => {
    const [supplier, open, purchases, warehouses, payable, notes, payments, methods] = await Promise.all([
      getSupplier(supplierId),
      listOpenPurchases(supplierId, { limit: 50 }),
      listPurchases({ supplierId, limit: 25 }),
      warehouseNames(),
      businessWide ? getSupplierPayable(supplierId) : Promise.resolve(null),
      businessWide ? listSupplierCreditNotes(supplierId, { limit: 50 }) : Promise.resolve(null),
      businessWide ? listSupplierPayments(supplierId, { limit: 25 }) : Promise.resolve(null),
      mayGetMoneyBack ? listPaymentMethods() : Promise.resolve({ items: [] }),
    ]);
    return {
      supplier,
      owed: payable ? payable.byCurrency.filter((c) => isNonZeroMinor(c.txnMinor)).map((c) => ({ currency: c.currency, amountMinor: c.txnMinor })) : null,
      notes: notes
        ? notes.items
            .filter((n) => isNonZeroMinor(n.remainingTxnMinor))
            .map((n) => ({ creditNoteId: n.creditNoteId, issuedOn: n.issuedOn, currency: n.currency, remainingTxnMinor: n.remainingTxnMinor }))
        : null,
      payments: payments ? payments.items : null,
      openPurchases: open.items.map((p) => ({
        purchaseId: p.purchaseId,
        documentDate: p.documentDate,
        supplierReference: p.supplierReference,
        currency: p.currency,
        totalTxnMinor: p.totalTxnMinor,
        outstandingTxnMinor: p.outstandingTxnMinor,
      })),
      purchases: purchases.items.map((p) => ({
        purchaseId: p.id,
        supplierName: supplier.name,
        warehouseName: warehouses.get(p.warehouseId) ?? '',
        documentDate: p.documentDate,
        supplierReference: p.supplierReference,
        status: p.status,
        currency: p.currency,
        totalTxnMinor: p.totalTxnMinor,
      })),
      methods: methods.items,
    };
  }, [supplierId, businessWide, mayGetMoneyBack]);

  useEffect(() => {
    if (status !== 'ready') return;
    let live = true;
    load()
      .then((data) => {
        if (!live) return;
        setLoaded(data);
        setLoadStatus('ready');
      })
      .catch((error: unknown) => {
        if (live) setLoadStatus(statusOfFailure(error));
      });
    return () => {
      live = false;
    };
  }, [status, load]);

  const notes = loaded?.notes ?? [];
  const note = notes.length === 1 ? notes[0] : notes.find((n) => n.creditNoteId === money.creditNoteId);
  const baseCurrency = context?.business.baseCurrency ?? '';

  async function submitMoneyBack() {
    if (!loaded) return;
    const method = activeMethodChoices(loaded.methods, locale, t).find((m) => m.paymentMethodId === money.methodId);
    const creditAmountMinor = note ? amountInputToMinor(money.amount, note.currency) : null;
    const receiptCurrency = money.differentCurrency ? money.receiptCurrency : (note?.currency ?? '');
    const receiptAmountMinor = money.differentCurrency ? amountInputToMinor(money.receiptAmount, receiptCurrency) : creditAmountMinor;
    const errors = {
      note: note === undefined,
      method: method === undefined,
      amount: creditAmountMinor === null || !isNonZeroMinor(creditAmountMinor),
      receiptAmount: money.differentCurrency && (receiptAmountMinor === null || !isNonZeroMinor(receiptAmountMinor)),
      reference: method?.requiresReference === true && money.reference.trim().length === 0,
    };
    setMoney((m) => ({ ...m, errors }));
    if (Object.values(errors).some(Boolean) || !note || !method || creditAmountMinor === null || receiptAmountMinor === null) return;
    setMoney((m) => ({ ...m, busy: true }));
    setErrorKey(null);
    try {
      const done = await withConflictRetry(() =>
        getMoneyBack({
          refundId,
          creditNoteId: note.creditNoteId,
          paymentMethodId: method.paymentMethodId,
          refundDate: money.date,
          creditAmountMinor,
          receiptCurrencyCode: receiptCurrency,
          receiptAmountMinor,
          reference: money.reference.trim() || null,
        }),
      );
      setRefundId(crypto.randomUUID());
      setMoney({ ...closedMoneyBack(localDateIso()), done });
      setLoaded(await load());
    } catch (error) {
      setErrorKey(refusalKey(error));
      setMoney((m) => ({ ...m, busy: false }));
    }
  }

  const pageStatus = status !== 'ready' ? status : loadStatus;
  if (pageStatus !== 'ready' || !context || !loaded) {
    return (
      <PageShell locale={locale} active="suppliers">
        <PageStateView t={t} locale={locale} status={pageStatus === 'ready' ? 'loading' : pageStatus} onRetry={retry} />
      </PageShell>
    );
  }

  const moneyBack: MoneyBackForm | null =
    mayGetMoneyBack && notes.length > 0
      ? {
          ...money,
          notes,
          creditNoteId: note?.creditNoteId ?? money.creditNoteId,
          methods: loaded.methods,
          currencies: [...new Set([note?.currency ?? '', baseCurrency].filter((c) => c.length > 0))],
          receiptCurrency: money.receiptCurrency || baseCurrency,
        }
      : null;
  const field = (name: MoneyBackField, value: string) => {
    const errorOf: Readonly<Record<MoneyBackField, keyof MoneyBackForm['errors'] | null>> = {
      creditNoteId: 'note',
      methodId: 'method',
      amount: 'amount',
      date: null,
      receiptCurrency: null,
      receiptAmount: 'receiptAmount',
      reference: 'reference',
    };
    const cleared = errorOf[name];
    setMoney((m) => ({ ...m, [name]: value, errors: cleared ? { ...m.errors, [cleared]: false } : m.errors }));
  };

  return (
    <PageShell locale={locale} active="suppliers">
      <SupplierDetailView
        t={t}
        locale={locale}
        supplier={{
          supplierId: loaded.supplier.id,
          name: loaded.supplier.name,
          status: loaded.supplier.status,
          phone: loaded.supplier.phone,
          email: loaded.supplier.email,
        }}
        owed={loaded.owed}
        favourNotes={loaded.notes}
        payments={loaded.payments}
        openPurchases={loaded.openPurchases}
        purchases={loaded.purchases}
        canPay={context.can('suppliers.pay') && loaded.supplier.status === 'active' && loaded.openPurchases.length > 0}
        moneyBack={moneyBack}
        errorKey={errorKey}
        on={{
          onPay: () => router.push(`/${locale}/suppliers/${supplierId}/pay`),
          onOpenPurchase: (purchaseId) => router.push(`/${locale}/purchases/${purchaseId}`),
          onStartMoneyBack: () => setMoney((m) => ({ ...m, open: true, done: null })),
          onMoneyBackField: field,
          onToggleDifferentCurrency: () => setMoney((m) => ({ ...m, differentCurrency: !m.differentCurrency })),
          onSubmitMoneyBack: () => void submitMoneyBack(),
          onCancelMoneyBack: () => setMoney(closedMoneyBack(localDateIso())),
          onBack: () => router.push(`/${locale}/suppliers`),
        }}
      />
    </PageShell>
  );
}
