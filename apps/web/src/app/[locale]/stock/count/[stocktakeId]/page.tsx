'use client';
import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { InventoryStocktakeCountRequestDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { cancelStocktake, finalizeStocktake, getStocktake, putStocktakeCounts, type InventoryStocktakeDetailDto } from '@/lib/phase3-api';
import { isPermissionRefusal, refusalCode, refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { amountInputToMinor, isQuantityText, localDateIso } from '@/lib/phase3-format';
import { CountSheetView } from '@/views/stock/CountSheetView';
import { draftLineOf, identityKey, lineQuantityErrors, quantityText, type DraftLine, type PickOption } from '@/views/stock/model';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../../../AppHeader';
import { refusedLines, usePickOptions, useInventoryScreen } from '../../stock-page-kit';

/** The counts command takes at most this many lines at once (`MAX_DOCUMENT_LINES`). */
const COUNT_BATCH = 200;

/**
 * Count Stock, one count (P3-S7 A-11, A-08, A-13; blind counting TL-8).
 *
 * The sheet always shows the count as the SERVER reads it back
 * (`GET …/stocktakes/:id`): the answer of `PUT …/counts` carries the expected
 * quantity, and a counter who may not see it must not, so it is never shown —
 * the page reads the count again instead. Items to add come from the items
 * read, which carries no quantity. Finishing and cancelling are idempotent on
 * the stocktake id, so a retry is a replay.
 */
export default function CountSheetPage({ params }: { params: Promise<{ locale: Locale; stocktakeId: string }> }) {
  const { locale, stocktakeId } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const screen = useInventoryScreen(locale, ['inventory.view', 'inventory.stocktake']);
  const [stocktake, setStocktake] = useState<InventoryStocktakeDetailDto | null>(null);
  const [loadError, setLoadError] = useState<{ denied: boolean; key: string } | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [newLines, setNewLines] = useState<DraftLine[]>([]);
  const [search, setSearch] = useState('');
  const [costLines, setCostLines] = useState<string[]>([]);
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [occurredOn, setOccurredOn] = useState(() => localDateIso());
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [noticeKey, setNoticeKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const editable = stocktake?.status === 'draft' && screen.can('inventory.stocktake');
  const picker = usePickOptions('items', '', search, screen.phase === 'ready' && editable);

  const reread = useCallback(async () => {
    const detail = await getStocktake(stocktakeId);
    setStocktake(detail);
  }, [stocktakeId]);

  const load = useCallback(() => {
    setLoadError(null);
    reread().catch((error: unknown) => setLoadError({ denied: isPermissionRefusal(error), key: refusalKey(error) }));
  }, [reread]);

  useEffect(() => {
    if (screen.phase === 'ready') load();
  }, [screen.phase, load]);

  /** Every typed count, existing lines and new ones, as the counts command takes them; null with errors set when one is not a quantity. */
  function pendingCounts(detail: InventoryStocktakeDetailDto): InventoryStocktakeCountRequestDto['lines'] | null {
    const errors: Record<string, string> = lineQuantityErrors(newLines, true);
    const lines: InventoryStocktakeCountRequestDto['lines'] = [];
    for (const line of detail.lines) {
      const key = identityKey(line.productId, line.variantId);
      const typed = counts[key];
      if (typed === undefined) continue;
      const text = quantityText(typed);
      if (!isQuantityText(text, line.unitDecimals)) errors[key] = 'stock.line.quantityInvalid';
      else lines.push({ productId: line.productId, variantId: line.variantId, quantity: text });
    }
    for (const line of newLines) lines.push({ productId: line.productId, variantId: line.variantId, quantity: quantityText(line.quantity) });
    setLineErrors(errors);
    return Object.keys(errors).length > 0 ? null : lines;
  }

  /** Save what was typed; false when a typed count is not a quantity (the lines say which). */
  async function savePending(detail: InventoryStocktakeDetailDto): Promise<boolean> {
    const lines = pendingCounts(detail);
    if (lines === null) return false;
    for (let start = 0; start < lines.length; start += COUNT_BATCH) {
      // The answer carries expected quantities; it is deliberately not shown (TL-8).
      await putStocktakeCounts(stocktakeId, { lines: lines.slice(start, start + COUNT_BATCH) });
    }
    return true;
  }

  /**
   * Run one act on the count. On success the typed values are dropped and the
   * count is read again, so the sheet shows what the server holds; on a
   * refusal the typed values stay, and a retry sends them again (the counts
   * command is an idempotent upsert; finish and cancel replay on the id).
   */
  async function run(action: (detail: InventoryStocktakeDetailDto) => Promise<string | 'invalid'>) {
    if (stocktake === null) return;
    setBusy(true);
    setErrorKey(null);
    setNoticeKey(null);
    try {
      const outcome = await action(stocktake);
      if (outcome === 'invalid') return;
      setCounts({});
      setNewLines([]);
      setLineErrors({});
      await reread();
      setNoticeKey(outcome);
    } catch (error) {
      if (refusalCode(error) === 'inventory.unit_cost_required') {
        const named = refusedLines(error);
        if (named !== null) setCostLines(named.map((l) => identityKey(l.productId, l.variantId)));
      }
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(async (detail) => ((await savePending(detail)) ? 'stock.count.saved' : 'invalid'));

  const finish = () =>
    run(async (detail) => {
      const unitCosts: { productId: string; variantId: string | null; unitCost: string }[] = [];
      const costErrors: Record<string, string> = {};
      for (const key of costLines) {
        const line = detail.lines.find((l) => identityKey(l.productId, l.variantId) === key);
        if (line === undefined) continue;
        const minor = screen.currency === null ? null : amountInputToMinor(costs[key] ?? '', screen.currency);
        if (minor === null) costErrors[key] = 'stock.line.costInvalid';
        else unitCosts.push({ productId: line.productId, variantId: line.variantId, unitCost: minor });
      }
      if (Object.keys(costErrors).length > 0) {
        setLineErrors(costErrors);
        return 'invalid';
      }
      if (!(await savePending(detail))) return 'invalid';
      await withConflictRetry(() => finalizeStocktake(stocktakeId, { occurredOn, unitCosts: unitCosts.length > 0 ? unitCosts : null }));
      setCostLines([]);
      setCosts({});
      return 'stock.count.finished';
    });

  const cancel = () =>
    run(async () => {
      await cancelStocktake(stocktakeId);
      setConfirmCancel(false);
      return 'stock.count.cancelled';
    });

  function pick(option: PickOption) {
    if (newLines.some((l) => l.key === option.key)) return;
    setNewLines((current) => [...current, draftLineOf(option, crypto.randomUUID())]);
  }

  const back = () => router.push(`/${locale}/stock/count`);
  const warehouseName = screen.warehouses.find((w) => w.warehouseId === stocktake?.warehouseId)?.name ?? '';

  return (
    <PageShell locale={locale} active="stock">
      {screen.phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={screen.phase} errorKey={screen.errorKey} onRetry={screen.reload} />
      ) : loadError !== null ? (
        <ScreenState t={t} locale={locale} state={loadError.denied ? 'denied' : 'failed'} errorKey={loadError.key} onRetry={load} />
      ) : stocktake === null ? (
        <ScreenState t={t} locale={locale} state="loading" />
      ) : (
        <CountSheetView
          t={t}
          locale={locale}
          stocktake={stocktake}
          warehouseName={warehouseName}
          canCount={screen.can('inventory.stocktake')}
          counts={counts}
          newLines={newLines}
          search={search}
          options={picker.options}
          costLines={costLines}
          costs={costs}
          occurredOn={occurredOn}
          currency={screen.currency}
          unitNames={screen.unitNames}
          lineErrors={lineErrors}
          errorKey={errorKey ?? picker.errorKey}
          noticeKey={noticeKey}
          busy={busy}
          confirmCancel={confirmCancel}
          onCount={(key, value) => setCounts((current) => ({ ...current, [key]: value }))}
          onSearch={setSearch}
          onPick={pick}
          onNewQuantity={(lineKey, value) => setNewLines((current) => current.map((l) => (l.lineKey === lineKey ? { ...l, quantity: value } : l)))}
          onRemoveNew={(lineKey) => setNewLines((current) => current.filter((l) => l.lineKey !== lineKey))}
          onCost={(key, value) => setCosts((current) => ({ ...current, [key]: value }))}
          onDate={setOccurredOn}
          onSave={() => void save()}
          onFinish={() => void finish()}
          onAskCancel={() => setConfirmCancel(true)}
          onConfirmCancel={() => void cancel()}
          onDismissCancel={() => setConfirmCancel(false)}
          onBack={back}
        />
      )}
    </PageShell>
  );
}
