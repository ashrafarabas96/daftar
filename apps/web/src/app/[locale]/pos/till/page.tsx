'use client';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeT, type Locale } from '@/lib/i18n';
import { amountInputToMinor, useFormDocumentId } from '@/lib/phase3-format';
import { refusalKey } from '@/lib/phase3-errors';
import { closeTill, openTill } from '@/lib/phase4-pos-api';
import { ScreenState } from '@/views/stock/parts';
import { TillView } from '@/views/pos/TillView';
import { PageShell } from '../../AppHeader';
import { POS_WEB_TERMINAL_CODE, usePosScreen } from '../pos-page-kit';

/**
 * The till (P4-S3): open the one till this cashier sells from, and close it.
 * `OD-P4-09` is RULED — one session, one authenticated user — so the page
 * reads `GET /v1/pos/till-sessions/current` and never a list.
 *
 * ── WHAT THIS PAGE SENDS ─────────────────────────────────────────────────
 *   open  → `{ sessionId, branchId, warehouseId, terminalCode, openingFloatMinor }`
 *   close → `{ closingCountMinor }`
 *
 * All five open fields, because `TillSessionOpenSchema` is `.strict()` and
 * requires all five: this page used to send three and was refused for the two
 * missing keys. `branchId` and `warehouseId` both come from the ONE warehouse
 * the cashier picked (`PosSellingPlace` carries its own home branch), so the
 * page never pairs a branch with a warehouse of its own choosing.
 *
 * `sessionId` is the id the screen minted ONCE, so a retry is a replay and the
 * stored open-intent digest is what makes it a proof (`P4-AL-30`).
 * `terminalCode` is `POS_WEB_TERMINAL_CODE`, a constant with its reasoning
 * beside it. The two amounts are the cash the cashier COUNTED, typed in major
 * units and turned into integer minor units by `amountInputToMinor`, which is
 * `parseMajorToMinor` (BigInt) underneath: no Float touches money here. The
 * page sends no expected cash and no variance — both are the server's to
 * derive — and it cannot name the till's owner in any spelling.
 */
export default function PosTillPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const screen = usePosScreen(locale);
  const [sessionId, resetSessionId] = useFormDocumentId();
  const [placeId, setPlaceId] = useState('');
  const [openingFloatText, setOpeningFloatText] = useState('');
  const [closingCountText, setClosingCountText] = useState('');
  const [openingFloatInvalid, setOpeningFloatInvalid] = useState(false);
  const [closingCountInvalid, setClosingCountInvalid] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [justClosed, setJustClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  /** The typed cash as integer minor units, or null when it is not an amount in this currency. Empty means none. */
  function countedCash(text: string): string | null {
    const typed = text.trim();
    if (typed === '') return '0';
    return amountInputToMinor(typed, screen.currency ?? '');
  }

  async function open() {
    // The chosen warehouse carries its own branch; a place nobody chose is not
    // openable, and the button is disabled until one is.
    const place = screen.places.find((p) => p.id === placeId);
    if (place === undefined) return;
    const openingFloatMinor = countedCash(openingFloatText);
    if (openingFloatMinor === null) {
      setOpeningFloatInvalid(true);
      return;
    }
    setOpeningFloatInvalid(false);
    setBusy(true);
    setErrorKey(null);
    try {
      const session = await openTill({
        sessionId,
        branchId: place.branchId,
        warehouseId: place.id,
        terminalCode: POS_WEB_TERMINAL_CODE,
        openingFloatMinor,
      });
      screen.setTill(session);
      setJustClosed(false);
      router.push(`/${locale}/pos`);
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    const openTillSession = screen.till;
    if (openTillSession === null) return;
    const closingCountMinor = countedCash(closingCountText);
    if (closingCountMinor === null) {
      setClosingCountInvalid(true);
      setConfirmingClose(false);
      return;
    }
    setClosingCountInvalid(false);
    setBusy(true);
    setErrorKey(null);
    try {
      await closeTill(openTillSession.id, { closingCountMinor });
      screen.setTill(null);
      setJustClosed(true);
      setConfirmingClose(false);
      setClosingCountText('');
      setOpeningFloatText('');
      // The next till is a NEW session, never a reopening: a fresh replay key.
      resetSessionId();
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell locale={locale} active="pos">
      {screen.phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={screen.phase} onRetry={screen.reload} />
      ) : (
        <TillView
          t={t}
          locale={locale}
          places={screen.places}
          placeId={placeId}
          session={screen.till}
          currency={screen.currency}
          openingFloatText={openingFloatText}
          closingCountText={closingCountText}
          openingFloatInvalid={openingFloatInvalid}
          closingCountInvalid={closingCountInvalid}
          justClosed={justClosed}
          confirmingClose={confirmingClose}
          busy={busy}
          errorKey={errorKey}
          onPlace={setPlaceId}
          onOpeningFloat={(value) => {
            setOpeningFloatText(value);
            setOpeningFloatInvalid(false);
          }}
          onClosingCount={(value) => {
            setClosingCountText(value);
            setClosingCountInvalid(false);
          }}
          onOpen={() => void open()}
          onAskClose={() => setConfirmingClose(true)}
          onCancelClose={() => setConfirmingClose(false)}
          onClose={() => void close()}
          onBackToSelling={() => router.push(`/${locale}/pos`)}
        />
      )}
    </PageShell>
  );
}
