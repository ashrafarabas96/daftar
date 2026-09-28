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
import type { PurchaseResidueWriteOffResultDto, PurchaseReversalResultDto, PurchaseSettlementsDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { isUuid } from '@/lib/route-ids';
import {
  closePurchaseLeftover,
  getPurchase,
  getPurchasePayable,
  getPurchaseSettlements,
  getReturnOptions,
  getSupplier,
  listPurchaseReturns,
  undoPurchaseReceipt,
  type PurchaseReturnOptionsDto,
} from '@/lib/phase3-api';
import { SAVED_REFRESH_KEY, refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { localDateIso } from '@/lib/phase3-format';
import { PageStateView, type PageStatus } from '@/views/common/feedback';
import { PurchaseDetailView } from '@/views/purchases/PurchaseDetailView';
import { purchaseDetailActions } from '@/views/purchases/detail-actions';
import type { PurchaseDetailModel, PurchaseReturnRow, UndoReceiptForm } from '@/views/purchases/types';
import { PageShell } from '../../AppHeader';
import { itemsById, lineNames, warehouseNames } from '../_shared/lookups';
import { statusOfFailure, useMerchantContext } from '../_shared/merchant-context';

interface Loaded {
  purchase: PurchaseDetailModel;
  supplierId: string;
  outstandingTxnMinor: string | null;
  /** The purchase's payable as the server read it; null when it is not received. */
  payable: { outstandingTxnMinor: string; outstandingBaseMinor: string } | null;
  returns: PurchaseReturnRow[];
  settlements: PurchaseSettlementsDto | null;
  options: PurchaseReturnOptionsDto;
}

const CLOSED_FORM: UndoReceiptForm = { open: false, reason: '', reasonMissing: false, busy: false };

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
  const [leftover, setLeftover] = useState<UndoReceiptForm>(CLOSED_FORM);
  const [leftoverClosed, setLeftoverClosed] = useState<PurchaseResidueWriteOffResultDto | null>(null);
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
      payable: payable ? { outstandingTxnMinor: payable.outstandingTxnMinor, outstandingBaseMinor: payable.outstandingBaseMinor } : null,
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
    setLoadStatus('loading');
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
      setUndone(await withConflictRetry(() => undoPurchaseReceipt(purchaseId, { reversalDate: localDateIso(), reason })));
    } catch (error) {
      setErrorKey(refusalKey(error));
      setUndo((u) => ({ ...u, busy: false }));
      return;
    }
    setUndo({ open: false, reason: '', reasonMissing: false, busy: false });
    // The receipt is undone; a failed re-read must not say otherwise (m-3).
    try {
      const fresh = await load();
      if (fresh) setLoaded(fresh);
    } catch {
      setErrorKey(SAVED_REFRESH_KEY);
    }
  }

  /**
   * TD-16: close the leftover the server reported, exactly as read — the
   * server refuses it if the amount changed (`purchase_residue.amount_mismatch`)
   * or can still be paid (`purchase_residue.not_below_base_unit`).
   */
  async function confirmLeftover() {
    const reason = leftover.reason.trim();
    if (reason.length === 0) {
      setLeftover({ ...leftover, reasonMissing: true });
      return;
    }
    const residue = loaded?.payable?.outstandingTxnMinor;
    if (residue === undefined) return;
    setLeftover({ ...leftover, busy: true });
    setErrorKey(null);
    try {
      setLeftoverClosed(await closePurchaseLeftover(purchaseId, { writeOffDate: localDateIso(), residueAmountMinor: residue, reason }));
    } catch (error) {
      setErrorKey(refusalKey(error));
      setLeftover((f) => ({ ...f, busy: false }));
      return;
    }
    setLeftover(CLOSED_FORM);
    // The leftover is closed; a failed re-read must not say otherwise (m-3).
    try {
      const fresh = await load();
      if (fresh) setLoaded(fresh);
    } catch {
      setErrorKey(SAVED_REFRESH_KEY);
    }
  }

  // "Try again" shows the spinner at once, not the failed state again until the data arrives (N-9).
  const retryLoad = () => {
    setLoadStatus('loading');
    retry();
  };

  const pageStatus = status !== 'ready' ? status : loadStatus;
  if (pageStatus !== 'ready' || !context || !loaded) {
    return (
      <PageShell locale={locale} active="purchases">
        <PageStateView t={t} locale={locale} status={pageStatus === 'ready' ? 'loading' : pageStatus} onRetry={retryLoad} />
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
        actions={purchaseDetailActions({
          status: purchase.status,
          returnable: options.returnable,
          reversible: options.reversible,
          payable: loaded.payable,
          businessWide: context.access.businessWide,
          can: context.can,
        })}
        undo={undo}
        undone={undone}
        leftover={leftover}
        leftoverClosed={leftoverClosed}
        errorKey={errorKey}
        on={{
          onContinueDraft: () => router.push(`/${locale}/purchases/receive?draft=${purchaseId}`),
          onReturn: () => router.push(`/${locale}/purchases/${purchaseId}/return`),
          onPay: () => router.push(`/${locale}/suppliers/${loaded.supplierId}/pay`),
          onStartUndo: () => setUndo({ open: true, reason: t('purchasing.detail.undoReasonDefault'), reasonMissing: false, busy: false }),
          onUndoReason: (reason) => setUndo((u) => ({ ...u, reason, reasonMissing: false })),
          onConfirmUndo: () => void confirmUndo(),
          onCancelUndo: () => setUndo({ open: false, reason: '', reasonMissing: false, busy: false }),
          onStartLeftover: () => setLeftover({ open: true, reason: t('purchasing.detail.leftoverReasonDefault'), reasonMissing: false, busy: false }),
          onLeftoverReason: (reason) => setLeftover((f) => ({ ...f, reason, reasonMissing: false })),
          onConfirmLeftover: () => void confirmLeftover(),
          onCancelLeftover: () => setLeftover(CLOSED_FORM),
          onBack: () => router.push(`/${locale}/purchases`),
        }}
      />
    </PageShell>
  );
}
