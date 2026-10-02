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
import { usePosScreen } from '../pos-page-kit';

/**
 * The till (P4-S3): open the one till this cashier sells from, and close it.
 * `OD-P4-09` is RULED — one session, one authenticated user — so the page
 * reads `GET /v1/pos/till-sessions/current` and never a list.
 *
 * ── WHAT THIS PAGE SENDS ─────────────────────────────────────────────────
 *   open  → `{ sessionId, branchId, openingFloatMinor }`
 *   close → `{ closingCountMinor }`
 *
 * `sessionId` is the id the screen minted ONCE, so a retry is a replay. The
 * two amounts are the cash the cashier COUNTED, typed in major units and
 * turned into integer minor units by `amountInputToMinor`, which is
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
  const [branchId, setBranchId] = useState('');
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
    const openingFloatMinor = countedCash(openingFloatText);
    if (openingFloatMinor === null) {
      setOpeningFloatInvalid(true);
      return;
    }
    setOpeningFloatInvalid(false);
    setBusy(true);
    setErrorKey(null);
    try {
      const session = await openTill({ sessionId, branchId, openingFloatMinor });
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
    const open = screen.till;
    if (open === null) return;
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
      await closeTill(open.tillSessionId, { closingCountMinor });
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
          branches={screen.branches}
          branchId={branchId}
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
          onBranch={setBranchId}
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
