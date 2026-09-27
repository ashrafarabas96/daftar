'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { InventoryMovementDocumentDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { postTransfer } from '@/lib/phase3-api';
import { refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { useFormDocumentId } from '@/lib/phase3-format';
import { MoveStockView } from '@/views/stock/MoveStockView';
import { draftLineOf, lineQuantityErrors, quantityText, type DraftLine, type PickOption } from '@/views/stock/model';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../../AppHeader';
import { onlyActiveWarehouse, usePickOptions, useInventoryScreen } from '../stock-page-kit';

/**
 * Move Stock (P3-S7 A-11, A-13) — `POST /v1/inventory/transfers`.
 *
 * The transfer id is minted once when the form opens and kept across every
 * retry, so a double tap or a retried request is a replay (A-12(4)); it is
 * renewed only after the move is recorded and the merchant starts another.
 */
export default function MoveStockPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const screen = useInventoryScreen(locale, ['inventory.transfer']);
  const [transferId, renewTransferId] = useFormDocumentId();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InventoryMovementDocumentDto | null>(null);
  const picker = usePickOptions(screen.can('inventory.view') ? 'stock' : 'items', fromId, search, screen.phase === 'ready' && fromId !== '' && result === null);

  useEffect(() => {
    if (screen.phase === 'ready' && fromId === '') setFromId(onlyActiveWarehouse(screen.warehouses));
  }, [screen.phase, screen.warehouses, fromId]);

  function chooseFrom(warehouseId: string) {
    setFromId(warehouseId);
    if (warehouseId === toId) setToId('');
    // What is "here now" belonged to the old warehouse.
    setLines((current) => current.map((l) => ({ ...l, onHand: null })));
  }

  function pick(option: PickOption) {
    if (lines.some((l) => l.key === option.key)) return;
    setLines((current) => [...current, draftLineOf(option, crypto.randomUUID())]);
  }

  async function submit() {
    setErrorKey(null);
    const invalid = lineQuantityErrors(lines, false);
    setLineErrors(invalid);
    if (Object.keys(invalid).length > 0) return;
    setBusy(true);
    try {
      const answer = await withConflictRetry(() =>
        postTransfer({
          transferId,
          sourceWarehouseId: fromId,
          destinationWarehouseId: toId,
          lines: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: quantityText(l.quantity) })),
        }),
      );
      setResult(answer);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }

  function startAnother() {
    renewTransferId();
    setLines([]);
    setLineErrors({});
    setSearch('');
    setErrorKey(null);
    setResult(null);
  }

  return (
    <PageShell locale={locale} active="stock">
      {screen.phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={screen.phase} errorKey={screen.errorKey} onRetry={screen.reload} />
      ) : (
        <MoveStockView
          t={t}
          locale={locale}
          warehouses={screen.warehouses}
          fromId={fromId}
          toId={toId}
          search={search}
          options={picker.options}
          lines={lines}
          lineErrors={lineErrors}
          unitNames={screen.unitNames}
          errorKey={errorKey ?? picker.errorKey}
          busy={busy}
          result={result}
          onFrom={chooseFrom}
          onTo={setToId}
          onSearch={setSearch}
          onPick={pick}
          onQuantity={(lineKey, value) => setLines((current) => current.map((l) => (l.lineKey === lineKey ? { ...l, quantity: value } : l)))}
          onRemove={(lineKey) => setLines((current) => current.filter((l) => l.lineKey !== lineKey))}
          onSubmit={() => void submit()}
          onNew={startAnother}
          onBack={() => router.push(`/${locale}/stock`)}
        />
      )}
    </PageShell>
  );
}
