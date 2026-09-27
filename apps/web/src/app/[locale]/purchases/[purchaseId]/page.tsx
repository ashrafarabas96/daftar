'use client';
/**
 * Purchase (P3-S7 contract A-11; Annex R #4, #21; TL-4(b)).
 *
 * The purchase, what is still to pay on it, its returns, and — for a holder
 * of `suppliers.view` — its settlements. "Return to Supplier" and "Undo
 * receipt" are offered from the S7 return-options read: "Undo receipt" only
 * when that read says the server would accept it (`reversible`), never from
 * the settlements route.
 */
import { use, useCallback, useEffect, useState } from 'react';
import { notFound, useRouter } from 'next/navigation';
import type { PurchaseReversalResultDto, PurchaseSettlementsDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { isUuid } from '@/lib/route-ids';
import {
  getPurchase,
  getPurchasePayable,
  getPurchaseSettlements,
  getReturnOptions,
  getSupplier,
  listPurchaseReturns,
  undoPurchaseReceipt,
  type PurchaseReturnOptionsDto,
} from '@/lib/phase3-api';
import { refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { localDateIso } from '@/lib/phase3-format';
import { isNonZeroMinor } from '@/views/common/amount-text';
import { PageStateView, type PageStatus } from '@/views/common/feedback';
import { PurchaseDetailView } from '@/views/purchases/PurchaseDetailView';
import type { PurchaseDetailModel, PurchaseReturnRow, UndoReceiptForm } from '@/views/purchases/types';
import { PageShell } from '../../AppHeader';
import { itemsById, lineNames, warehouseNames } from '../_shared/lookups';
import { statusOfFailure, useMerchantContext } from '../_shared/merchant-context';

interface Loaded {
  purchase: PurchaseDetailModel;
  supplierId: string;
  outstandingTxnMinor: string | null;
  returns: PurchaseReturnRow[];
  settlements: PurchaseSettlementsDto | null;
  options: PurchaseReturnOptionsDto;
}

export default function PurchaseDetailPage({ params }: { params: Promise<{ locale: Locale; purchaseId: string }> }) {
  const { locale, purchaseId } = use(params);
  // An id from the URL reaches no API path unless it is a UUID (L-1).
  if (!isUuid(purchaseId)) notFound();
  const t = makeT(locale);
  const router = useRouter();
  const { status, context, retry } = useMerchantContext(locale);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadStatus, setLoadStatus] = useState<PageStatus | 'ready'>('loading');
  const [undo, setUndo] = useState<UndoReceiptForm>({ open: false, reason: '', reasonMissing: false, busy: false });
  const [undone, setUndone] = useState<PurchaseReversalResultDto | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const load = useCallback(async (): Promise<Loaded | null> => {
    if (!context) return null;
    const purchase = await getPurchase(purchaseId);
    const received = purchase.status === 'received';
    const [options, items, warehouses, supplierName, payable, returns, settlements] = await Promise.all([
      getReturnOptions(purchaseId),
      itemsById(purchase.lines.map((l) => l.productId)),
      warehouseNames(),
      purchase.supplierSnapshot ? Promise.resolve(purchase.supplierSnapshot.name) : getSupplier(purchase.supplierId).then((s) => s.name),
      received ? getPurchasePayable(purchaseId) : Promise.resolve(null),
      purchase.status === 'draft' || purchase.status === 'cancelled'
        ? Promise.resolve({ items: [], nextCursor: null })
        : listPurchaseReturns(purchaseId, { limit: 50 }),
      context.can('suppliers.view') && purchase.status !== 'draft' && purchase.status !== 'cancelled'
        ? getPurchaseSettlements(purchaseId)
        : Promise.resolve(null),
    ]);
    const baseCurrency = context.business.baseCurrency;
    return {
      supplierId: purchase.supplierId,
      options,
      outstandingTxnMinor: payable ? payable.outstandingTxnMinor : null,
      settlements,
      returns: returns.items.map((r) => ({ returnId: r.returnId, documentDate: r.documentDate, currency: r.currency, carryingTxnMinor: r.carryingTxnMinor })),
      purchase: {
        purchaseId: purchase.id,
        status: purchase.status,
        supplierName,
        warehouseName: warehouses.get(purchase.warehouseId) ?? '',
        documentDate: purchase.documentDate,
        supplierReference: purchase.supplierReference,
        notes: purchase.notes,
        currency: purchase.currency,
        baseCurrency,
        subtotalTxnMinor: purchase.subtotalTxnMinor,
        landedCostTxnMinor: purchase.landedCostTxnMinor,
        totalTxnMinor: purchase.totalTxnMinor,
        rate: purchase.currency !== baseCurrency && purchase.rate ? purchase.rate.rate : null,
        lines: purchase.lines.map((l) => ({
          lineId: l.lineId,
          ...lineNames(items, l.productId, l.variantId),
          qty: l.qty,
          unitPrice: l.unitPrice,
          discountTxnMinor: l.discountTxnMinor,
          netTxnMinor: l.netTxnMinor,
        })),
      },
    };
  }, [context, purchaseId]);

  useEffect(() => {
    if (status !== 'ready') return;
    let live = true;
    load()
      .then((data) => {
        if (!live || !data) return;
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

  async function confirmUndo() {
    const reason = undo.reason.trim();
    if (reason.length === 0) {
      setUndo({ ...undo, reasonMissing: true });
      return;
    }
    setUndo({ ...undo, busy: true });
    setErrorKey(null);
    try {
      const answer = await withConflictRetry(() => undoPurchaseReceipt(purchaseId, { reversalDate: localDateIso(), reason }));
      setUndone(answer);
      setUndo({ open: false, reason: '', reasonMissing: false, busy: false });
      const fresh = await load();
      if (fresh) setLoaded(fresh);
    } catch (error) {
      setErrorKey(refusalKey(error));
      setUndo((u) => ({ ...u, busy: false }));
    }
  }

  const pageStatus = status !== 'ready' ? status : loadStatus;
  if (pageStatus !== 'ready' || !context || !loaded) {
    return (
      <PageShell locale={locale} active="purchases">
        <PageStateView t={t} locale={locale} status={pageStatus === 'ready' ? 'loading' : pageStatus} onRetry={retry} />
      </PageShell>
    );
  }
  const { purchase, options } = loaded;
  return (
    <PageShell locale={locale} active="purchases">
      <PurchaseDetailView
        t={t}
        locale={locale}
        purchase={purchase}
        outstandingTxnMinor={loaded.outstandingTxnMinor}
        returns={loaded.returns}
        settlements={loaded.settlements}
        actions={{
          continueDraft: purchase.status === 'draft' && context.can('purchases.manage'),
          returnToSupplier: options.returnable && context.can('purchases.return'),
          undoReceipt: options.reversible && context.can('purchases.receive'),
          paySupplier: purchase.status === 'received' && isNonZeroMinor(loaded.outstandingTxnMinor) && context.can('suppliers.pay'),
        }}
        undo={undo}
        undone={undone}
        errorKey={errorKey}
        on={{
          onContinueDraft: () => router.push(`/${locale}/purchases/receive?draft=${purchaseId}`),
          onReturn: () => router.push(`/${locale}/purchases/${purchaseId}/return`),
          onPay: () => router.push(`/${locale}/suppliers/${loaded.supplierId}/pay`),
          onStartUndo: () => setUndo({ open: true, reason: t('purchasing.detail.undoReasonDefault'), reasonMissing: false, busy: false }),
          onUndoReason: (reason) => setUndo((u) => ({ ...u, reason, reasonMissing: false })),
          onConfirmUndo: () => void confirmUndo(),
          onCancelUndo: () => setUndo({ open: false, reason: '', reasonMissing: false, busy: false }),
          onBack: () => router.push(`/${locale}/purchases`),
        }}
      />
    </PageShell>
  );
}
