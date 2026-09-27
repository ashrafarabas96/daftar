'use client';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { InventoryMovementDocumentDto } from '@daftar/shared-contracts';
import { makeT, type Locale } from '@/lib/i18n';
import { postAdjustment, postDamage, postOpening } from '@/lib/phase3-api';
import { refusalCode, refusalKey, withConflictRetry } from '@/lib/phase3-errors';
import { amountInputToMinor, localDateIso, useFormDocumentId } from '@/lib/phase3-format';
import { AdjustStockView } from '@/views/stock/AdjustStockView';
import { draftLineOf, identityKey, lineQuantityErrors, quantityText, type AdjustReason, type DraftLine, type PickOption } from '@/views/stock/model';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../../AppHeader';
import { onlyActiveWarehouse, refusedLines, usePickOptions, useInventoryScreen } from '../stock-page-kit';

const REASON_TEXT: Readonly<Record<AdjustReason, string>> = {
  found: 'stock.adjust.reason.found',
  missing: 'stock.adjust.reason.missing',
  damaged: 'stock.adjust.reason.damaged',
  starting: 'stock.adjust.reason.starting',
};

/**
 * Adjust Stock (P3-S7 A-11, A-13; "Starting stock" TL-4):
 * - "Found extra" / "Missing" → `POST /v1/inventory/adjustments`, the quantity
 *   signed by the reason;
 * - "Damaged" → `POST /v1/inventory/damages`;
 * - "Starting stock" → `POST /v1/inventory/openings` (business-wide only).
 *
 * The document id is minted once per form and kept across retries (A-12(4)).
 * A cost per unit is sent where the command needs one: on every line of
 * starting stock, and on extra stock once the server has asked for it.
 */
export default function AdjustStockPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const screen = useInventoryScreen(locale, ['inventory.adjust']);
  const [documentId, renewDocumentId] = useFormDocumentId();
  const [warehouseId, setWarehouseId] = useState('');
  const [reason, setReason] = useState<AdjustReason>('found');
  const [occurredOn, setOccurredOn] = useState(() => localDateIso());
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InventoryMovementDocumentDto | null>(null);
  const picker = usePickOptions(
    screen.can('inventory.view') ? 'stock' : 'items',
    warehouseId,
    search,
    screen.phase === 'ready' && warehouseId !== '' && result === null,
  );
  // Starting stock is recorded for the whole business, so it needs access to every branch (TL-4).
  const reasons: AdjustReason[] = screen.access?.businessWide ? ['found', 'missing', 'damaged', 'starting'] : ['found', 'missing', 'damaged'];

  useEffect(() => {
    if (screen.phase === 'ready' && warehouseId === '') setWarehouseId(onlyActiveWarehouse(screen.warehouses));
  }, [screen.phase, screen.warehouses, warehouseId]);

  function chooseWarehouse(id: string) {
    setWarehouseId(id);
    setLines((current) => current.map((l) => ({ ...l, onHand: null })));
  }

  function pick(option: PickOption) {
    if (lines.some((l) => l.key === option.key)) return;
    setLines((current) => [...current, draftLineOf(option, crypto.randomUUID())]);
  }

  function update(lineKey: string, change: Partial<DraftLine>) {
    setLines((current) => current.map((l) => (l.lineKey === lineKey ? { ...l, ...change } : l)));
  }

  /** Every line's cost in minor units, or the line keys whose cost is not an amount. */
  function costs(asked: readonly DraftLine[]): { minor: Record<string, string>; invalid: Record<string, string> } {
    const minor: Record<string, string> = {};
    const invalid: Record<string, string> = {};
    for (const line of asked) {
      const value = screen.currency === null ? null : amountInputToMinor(line.unitCost, screen.currency);
      if (value === null) invalid[line.lineKey] = 'stock.line.costInvalid';
      else minor[line.lineKey] = value;
    }
    return { minor, invalid };
  }

  async function submit() {
    setErrorKey(null);
    const invalid = lineQuantityErrors(lines, false);
    const costed = lines.filter((l) => reason === 'starting' || (reason === 'found' && l.needsCost));
    const cost = costs(costed);
    const allInvalid = { ...cost.invalid, ...invalid };
    setLineErrors(allInvalid);
    if (Object.keys(allInvalid).length > 0) return;
    const reasonText = note.trim().length > 0 ? note.trim() : t(REASON_TEXT[reason]);
    const identity = (l: DraftLine) => ({ productId: l.productId, variantId: l.variantId });
    setBusy(true);
    try {
      const answer = await withConflictRetry((): Promise<InventoryMovementDocumentDto> => {
        switch (reason) {
          case 'found':
            return postAdjustment({
              adjustmentId: documentId,
              warehouseId,
              occurredOn,
              reason: reasonText,
              lines: lines.map((l) => ({ ...identity(l), quantity: quantityText(l.quantity), unitCost: cost.minor[l.lineKey] })),
            });
          case 'missing':
            return postAdjustment({
              adjustmentId: documentId,
              warehouseId,
              occurredOn,
              reason: reasonText,
              lines: lines.map((l) => ({ ...identity(l), quantity: `-${quantityText(l.quantity)}` })),
            });
          case 'damaged':
            return postDamage({
              adjustmentId: documentId,
              warehouseId,
              occurredOn,
              reason: reasonText,
              lines: lines.map((l) => ({ ...identity(l), quantity: quantityText(l.quantity) })),
            });
          case 'starting':
            return postOpening({
              openingId: documentId,
              occurredOn,
              lines: lines.map((l) => ({ ...identity(l), warehouseId, quantity: quantityText(l.quantity), unitCost: cost.minor[l.lineKey] ?? '' })),
            });
        }
      });
      setResult(answer);
    } catch (error) {
      if (refusalCode(error) === 'inventory.unit_cost_required') {
        // The server names the lines that need a cost when it can; otherwise every line of extra stock does.
        const named = refusedLines(error);
        const needs = new Set((named ?? lines).map((l) => identityKey(l.productId, l.variantId)));
        setLines((current) => current.map((l) => (needs.has(l.key) ? { ...l, needsCost: true } : l)));
      }
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }

  function startAnother() {
    renewDocumentId();
    setLines([]);
    setLineErrors({});
    setNote('');
    setSearch('');
    setErrorKey(null);
    setResult(null);
  }

  return (
    <PageShell locale={locale} active="stock">
      {screen.phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={screen.phase} errorKey={screen.errorKey} onRetry={screen.reload} />
      ) : (
        <AdjustStockView
          t={t}
          locale={locale}
          warehouses={screen.warehouses}
          warehouseId={warehouseId}
          reasons={reasons}
          reason={reason}
          occurredOn={occurredOn}
          note={note}
          currency={screen.currency}
          search={search}
          options={picker.options}
          lines={lines}
          lineErrors={lineErrors}
          unitNames={screen.unitNames}
          errorKey={errorKey ?? picker.errorKey}
          busy={busy}
          result={result}
          onWarehouse={chooseWarehouse}
          onReason={setReason}
          onDate={setOccurredOn}
          onNote={setNote}
          onSearch={setSearch}
          onPick={pick}
          onQuantity={(lineKey, value) => update(lineKey, { quantity: value })}
          onCost={(lineKey, value) => update(lineKey, { unitCost: value })}
          onRemove={(lineKey) => setLines((current) => current.filter((l) => l.lineKey !== lineKey))}
          onSubmit={() => void submit()}
          onNew={startAnother}
          onBack={() => router.push(`/${locale}/stock`)}
        />
      )}
    </PageShell>
  );
}
