'use client';
/**
 * Return to Supplier (P3-S7 contract A-11, A-13, A-09(c)).
 *
 * The return options say, before anything is filled in, whether anything can
 * go back and how much of each line. The return id and one line id per
 * purchase line are minted once, when the form opens, so a retry is a replay
 * (A-12(4)). The page checks only the shape of each quantity; the bounds and
 * every amount are the server's.
 */
import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SupplierReturnResultDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { getPurchase, getReturnOptions, getSupplier, returnToSupplier } from '@/lib/phase3-api';
import { refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { isQuantityText, isZeroQuantityText, localDateIso, normaliseDigits, useFormDocumentId } from '@/lib/phase3-format';
import { trimFractionZeros } from '@/views/common/amount-text';
import { PageStateView, type PageStatus } from '@/views/common/feedback';
import { ReturnToSupplierView } from '@/views/purchases/ReturnToSupplierView';
import type { ReturnBlock, ReturnLineForm } from '@/views/purchases/types';
import { PageShell } from '../../../AppHeader';
import { statusOfFailure, useMerchantContext } from '../../_shared/merchant-context';

interface Loaded {
  supplierName: string;
  documentDate: string;
  warehouseId: string;
  blocked: ReturnBlock | null;
}

export default function ReturnToSupplierPage({ params }: { params: Promise<{ locale: Locale; purchaseId: string }> }) {
  const { locale, purchaseId } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const { status, context, retry } = useMerchantContext(locale);
  const [returnId] = useFormDocumentId();
  const [lineIds, setLineIds] = useState<Readonly<Record<string, string>>>({});
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [lines, setLines] = useState<ReturnLineForm[]>([]);
  const [loadStatus, setLoadStatus] = useState<PageStatus | 'ready'>('loading');
  const [documentDate, setDocumentDate] = useState(localDateIso());
  const [reason, setReason] = useState('');
  const [nothingChosen, setNothingChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [result, setResult] = useState<SupplierReturnResultDto | null>(null);

  const load = useCallback(async () => {
    const [purchase, options] = await Promise.all([getPurchase(purchaseId), getReturnOptions(purchaseId)]);
    const supplierName = purchase.supplierSnapshot?.name ?? (await getSupplier(purchase.supplierId)).name;
    return { purchase, options, supplierName };
  }, [purchaseId]);

  useEffect(() => {
    if (status !== 'ready' || !context) return;
    if (!context.can('purchases.return')) {
      setLoadStatus('denied');
      return;
    }
    let live = true;
    load()
      .then(({ purchase, options, supplierName }) => {
        if (!live) return;
        setLoaded({
          supplierName,
          documentDate: purchase.documentDate,
          warehouseId: purchase.warehouseId,
          blocked: options.returnable ? null : (options.reason ?? 'nothing_left'),
        });
        setLines(
          options.lines.map((l) => ({
            purchaseLineId: l.lineId,
            name: l.name,
            variantName: l.variantName,
            unitDecimals: l.unitDecimals,
            purchasedQty: l.purchasedQty,
            returnedQty: l.returnedQty,
            returnableQty: l.returnableQty,
            quantity: '',
            invalid: false,
          })),
        );
        // One return-line id per purchase line, minted once for this form.
        setLineIds(Object.fromEntries(options.lines.map((l) => [l.lineId, crypto.randomUUID()])));
        setLoadStatus('ready');
      })
      .catch((error: unknown) => {
        if (live) setLoadStatus(statusOfFailure(error));
      });
    return () => {
      live = false;
    };
  }, [status, context, load]);

  async function submit() {
    if (!loaded) return;
    const checked = lines.map((l) => {
      const q = normaliseDigits(l.quantity);
      return { ...l, invalid: q.length > 0 && (!isQuantityText(q, l.unitDecimals) || isZeroQuantityText(q)) };
    });
    setLines(checked);
    const chosen = checked.filter((l) => normaliseDigits(l.quantity).length > 0);
    setNothingChosen(chosen.length === 0);
    if (chosen.length === 0 || checked.some((l) => l.invalid)) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const answer = await withConflictRetry(() =>
        returnToSupplier(purchaseId, {
          returnId,
          warehouseId: loaded.warehouseId,
          documentDate,
          reason: reason.trim() || null,
          lines: chosen.map((l) => ({ lineId: lineIds[l.purchaseLineId] ?? '', purchaseLineId: l.purchaseLineId, quantity: normaliseDigits(l.quantity) })),
        }),
      );
      setResult(answer);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }

  const pageStatus = status !== 'ready' ? status : loadStatus;
  return (
    <PageShell locale={locale} active="purchases">
      {pageStatus !== 'ready' || !loaded ? (
        <PageStateView t={t} locale={locale} status={pageStatus === 'ready' ? 'loading' : pageStatus} onRetry={retry} />
      ) : (
        <ReturnToSupplierView
          t={t}
          locale={locale}
          supplierName={loaded.supplierName}
          documentDateOfPurchase={loaded.documentDate}
          blocked={loaded.blocked}
          lines={lines}
          documentDate={documentDate}
          reason={reason}
          nothingChosen={nothingChosen}
          busy={busy}
          errorKey={errorKey}
          result={result}
          on={{
            onQuantity: (id, value) => setLines((ls) => ls.map((l) => (l.purchaseLineId === id ? { ...l, quantity: value, invalid: false } : l))),
            onReturnAll: (id) =>
              setLines((ls) => ls.map((l) => (l.purchaseLineId === id ? { ...l, quantity: trimFractionZeros(l.returnableQty), invalid: false } : l))),
            onDate: setDocumentDate,
            onReason: setReason,
            onSubmit: () => void submit(),
            onBack: () => router.push(`/${locale}/purchases/${purchaseId}`),
          }}
        />
      )}
    </PageShell>
  );
}
