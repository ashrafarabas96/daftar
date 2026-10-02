'use client';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeT, type Locale } from '@/lib/i18n';
import { useFormDocumentId } from '@/lib/phase3-format';
import { refusalKey } from '@/lib/phase3-errors';
import {
  addBasketLine,
  finishSale,
  getPosBasket,
  removeBasketLine,
  requestBasketDiscount,
  searchPosItems,
  setBasketLineQuantity,
  type PosBasketDto,
  type PosSaleReceiptDto,
  type PosSearchHitDto,
} from '@/lib/phase4-pos-api';
import { RegisterView } from '@/views/pos/RegisterView';
import { SaleDoneView } from '@/views/pos/SaleDoneView';
import { basketQuantity, discountRequestMinor } from '@/views/pos/model';
import { ScreenState } from '@/views/stock/parts';
import { PageShell } from '../AppHeader';
import { POS_SEARCH_DELAY_MS, POS_SEARCH_MIN_CHARS, usePosScreen } from './pos-page-kit';

/**
 * The register (P4-S3).
 *
 * ── THE TRUST BOUNDARY ───────────────────────────────────────────────────
 * Every request this page sends carries identities, a quantity or a discount
 * request, and nothing else:
 *
 *   add a line        → `{ documentId, productId, variantId, quantity, revision }`
 *   change how many   → `{ quantity, revision }`
 *   remove a line     → the line id and the revision
 *   ask for a discount→ `{ amountMinor, revision }`   (`OD-P4-02`, OPTION A)
 *   finish the sale   → `{ documentId, revision }`
 *
 * No total of any kind is sent, and NONE is computed here: `basket` is the
 * server's answer to the last accepted command and the view reads its amounts
 * straight out of it.
 *
 * The type-ahead is paced (`POS_SEARCH_DELAY_MS`, `POS_SEARCH_MIN_CHARS`) so a
 * sale costs a handful of reads, not one per keystroke.
 */
export default function PosPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const screen = usePosScreen(locale);
  const [documentId, resetDocumentId] = useFormDocumentId();
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<readonly PosSearchHitDto[] | null>(null);
  const [basket, setBasket] = useState<PosBasketDto | null>(null);
  const [basketFailed, setBasketFailed] = useState(false);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [discountText, setDiscountText] = useState('');
  const [discountInvalid, setDiscountInvalid] = useState(false);
  const [confirmingFinish, setConfirmingFinish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [sale, setSale] = useState<PosSaleReceiptDto | null>(null);
  const quantityTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const tillOpen = screen.till !== null;
  const branchId = screen.till?.branchId ?? '';

  // The basket this till is holding, read back from the server on arrival.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (screen.phase !== 'ready' || !tillOpen) return;
    let live = true;
    setBasketFailed(false);
    getPosBasket()
      .then((answer) => {
        if (live) setBasket(answer);
      })
      .catch(() => {
        if (live) {
          setBasket(null);
          setBasketFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [screen.phase, tillOpen, attempt]);

  // The paced type-ahead: nothing before `POS_SEARCH_MIN_CHARS`, and one read per pause.
  useEffect(() => {
    if (screen.phase !== 'ready' || !tillOpen) return;
    const text = search.trim();
    if (text.length < POS_SEARCH_MIN_CHARS) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      searchPosItems({ search: text, branchId })
        .then((page) => {
          if (!live) return;
          setHits(page.items);
          setErrorKey(null);
        })
        .catch((error: unknown) => {
          if (!live) return;
          setHits([]);
          setErrorKey(refusalKey(error));
        });
    }, POS_SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [screen.phase, tillOpen, search, branchId]);

  useEffect(
    () => () => {
      for (const timer of Object.values(quantityTimers.current)) clearTimeout(timer);
    },
    [],
  );

  /**
   * Run one basket command and take the SERVER's basket as the truth: the
   * answer replaces the whole basket, amounts included, and no local figure
   * survives it.
   */
  const command = useCallback(
    async (run: (revision: number) => Promise<PosBasketDto>) => {
      const revision = basket?.revision ?? 0;
      setBusy(true);
      setErrorKey(null);
      try {
        setBasket(await run(revision));
        setQuantityDrafts({});
      } catch (error) {
        setErrorKey(refusalKey(error));
      } finally {
        setBusy(false);
      }
    },
    [basket],
  );

  async function add(hit: PosSearchHitDto) {
    await command((revision) => addBasketLine({ documentId, productId: hit.productId, variantId: hit.variantId, quantity: '1', revision }));
  }

  function onQuantity(lineId: string, value: string) {
    setQuantityDrafts((drafts) => ({ ...drafts, [lineId]: value }));
    const line = basket?.lines.find((l) => l.lineId === lineId);
    const quantity = line === undefined ? null : basketQuantity(value, line.unitDecimals);
    setLineErrors((errors) => {
      const next = { ...errors };
      if (quantity === null) next[lineId] = 'pos.basket.quantityInvalid';
      else delete next[lineId];
      return next;
    });
    const timers = quantityTimers.current;
    const pending = timers[lineId];
    if (pending !== undefined) clearTimeout(pending);
    if (quantity === null) return;
    timers[lineId] = setTimeout(() => {
      void command((revision) => setBasketLineQuantity(lineId, { quantity, revision }));
    }, POS_SEARCH_DELAY_MS);
  }

  async function remove(lineId: string) {
    setLineErrors((errors) => {
      const next = { ...errors };
      delete next[lineId];
      return next;
    });
    await command((revision) => removeBasketLine(lineId, revision));
  }

  async function askDiscount(text: string) {
    const currency = basket?.currency ?? '';
    const amountMinor = discountRequestMinor(text, currency);
    if (amountMinor === null) {
      setDiscountInvalid(true);
      return;
    }
    setDiscountInvalid(false);
    await command((revision) => requestBasketDiscount({ amountMinor, revision }));
  }

  async function finish() {
    if (basket === null) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const recorded = await finishSale({ documentId, revision: basket.revision });
      setSale(recorded);
      setConfirmingFinish(false);
      setBasket(null);
      setHits(null);
      setSearch('');
      setDiscountText('');
    } catch (error) {
      setErrorKey(refusalKey(error));
      setConfirmingFinish(false);
    } finally {
      setBusy(false);
    }
  }

  function another() {
    resetDocumentId();
    setSale(null);
    setErrorKey(null);
    setLineErrors({});
    setQuantityDrafts({});
    setAttempt((n) => n + 1);
  }

  const toTill = () => router.push(`/${locale}/pos/till`);

  return (
    <PageShell locale={locale} active="pos">
      {screen.phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={screen.phase} onRetry={screen.reload} />
      ) : basketFailed ? (
        <ScreenState t={t} locale={locale} state="failed" onRetry={() => setAttempt((n) => n + 1)} />
      ) : sale !== null ? (
        <SaleDoneView t={t} locale={locale} sale={sale} unitNames={screen.unitNames} onAnother={another} onGoToTill={toTill} />
      ) : (
        <RegisterView
          t={t}
          locale={locale}
          tillOpen={tillOpen}
          search={search}
          hits={hits}
          basket={basket}
          quantityDrafts={quantityDrafts}
          lineErrors={lineErrors}
          discountText={discountText}
          discountInvalid={discountInvalid}
          confirmingFinish={confirmingFinish}
          busy={busy}
          errorKey={errorKey}
          unitNames={screen.unitNames}
          onSearch={setSearch}
          onAdd={(hit) => void add(hit)}
          onQuantity={onQuantity}
          onRemove={(lineId) => void remove(lineId)}
          onDiscountText={(value) => {
            setDiscountText(value);
            setDiscountInvalid(false);
          }}
          onApplyDiscount={() => void askDiscount(discountText)}
          onClearDiscount={() => {
            setDiscountText('');
            void askDiscount('');
          }}
          onAskFinish={() => setConfirmingFinish(true)}
          onCancelFinish={() => setConfirmingFinish(false)}
          onFinish={() => void finish()}
          onGoToTill={toTill}
        />
      )}
    </PageShell>
  );
}
