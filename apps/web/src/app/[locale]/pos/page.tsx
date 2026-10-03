'use client';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeT, type Locale } from '@/lib/i18n';
import { localDateIso, useFormDocumentId } from '@/lib/phase3-format';
import { refusalKey } from '@/lib/phase3-errors';
import {
  addCartLine,
  commitSale,
  getCart,
  removeCartLine,
  requestDiscount,
  saleCommitFromCart,
  searchPosProducts,
  setCartLineQuantity,
  type PosCartDto,
  type PosProductHitDto,
  type SaleDto,
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
 *   add a line        → `POST   .../cart-lines`                      `{ productId, variantId, quantity }`
 *   change how many   → `PATCH  .../cart-lines/:cartLineId`          `{ quantity }`
 *   remove a line     → `DELETE .../cart-lines/:cartLineId`          no body at all
 *   ask for a discount→ `POST   .../cart-lines/:cartLineId/discount` `{ discountMinor }`
 *   finish the sale   → `POST   /v1/sales`                           `saleCommitFromCart(…)`
 *
 * No total of any kind is sent, and NONE is computed here: `cart` is the
 * server's answer to the last accepted command and the view reads its amounts
 * straight out of it. The sale commit's body is built by
 * `saleCommitFromCart` in the client module, from the till session and the
 * cart the server answered, so this page never spells a field of it.
 *
 * ── WHERE THE BASKET COMES FROM ──────────────────────────────────────────
 * Two sources, and the SERVER is both of them. Every cart command answers
 * with the whole recomputed cart, so the register that is already open takes
 * each answer as the truth and never needs a second read — which is the
 * reason `pos-cart.controller.ts` gives for having no `GET` of its own.
 *
 * And on MOUNT, once, the basket is read: `GET .../cart-lines`
 * (`getCart`). The basket is server-side state in `pos_cart_lines`, so
 * without that read a page RELOAD showed an empty register while the server
 * still held the lines — the one case the "never asks twice" property does
 * not cover, and the reason the read exists at all. Neither
 * `GET /pos/till-sessions/current` nor `GET /pos/till-sessions/:id` carries a
 * line; both answer a `TillSession`.
 *
 * The read is attempted once per till session, tracked by
 * `basketReadFor`, so a refusal is not retried in a loop and a command's
 * answer is never overwritten by a late mount read.
 *
 * The type-ahead is paced (`POS_SEARCH_DELAY_MS`, `POS_SEARCH_MIN_CHARS`) so a
 * sale costs a handful of reads, not one per keystroke.
 */
export default function PosPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = use(params);
  const t = makeT(locale);
  const router = useRouter();
  const screen = usePosScreen(locale);
  // The sale's identity AND its idempotency key (P4-AL-30), minted once per
  // sale so a retry is a replay, and re-minted for the next sale.
  const [saleId, resetSaleId] = useFormDocumentId();
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<readonly PosProductHitDto[] | null>(null);
  // The server dropped further matches: the prefix is too broad, and the
  // cashier narrows it by typing. There is no page two to ask for.
  const [moreMatches, setMoreMatches] = useState(false);
  const [cart, setCart] = useState<PosCartDto | null>(null);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});
  const [discountDrafts, setDiscountDrafts] = useState<Record<string, string>>({});
  const [quantityErrors, setQuantityErrors] = useState<Record<string, string>>({});
  const [discountErrors, setDiscountErrors] = useState<Record<string, string>>({});
  const [confirmingFinish, setConfirmingFinish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [sale, setSale] = useState<SaleDto | null>(null);
  /**
   * The till session the mount read has already been attempted for. A ref and
   * not state, because changing it must not itself cause a render, and `''`
   * means "no session yet" rather than "not read".
   */
  const basketReadFor = useRef<string>('');
  const quantityTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /**
   * The products the type-ahead has reported as having NO merchant variants
   * (`PosProductHitDto.variantId === null`).
   *
   * It is kept because `CartDto` reports the stored BASE variant id for such a
   * product and `SaleCommitSchema` refuses one — `merchantVariantOf` carries
   * the whole measurement. A ref and not state: nothing on screen depends on
   * it, so growing it must not re-render the register mid-sale.
   */
  const simpleProducts = useRef<Set<string>>(new Set());

  const till = screen.till;
  const tillOpen = till !== null;
  // The till SESSION is the only place identity a POS read carries: the
  // warehouse the prices and the on-hand figures come from is derived from it
  // by the server (RULING 2). This screen cannot name a warehouse in a read,
  // and it cannot name the branch either — a browser that chose either would
  // be deciding the scope of its own read.
  const tillSessionId = till?.id ?? '';

  /**
   * THE MOUNT READ: the basket the server already holds.
   *
   * Once per till session. It runs only while nothing else has set the cart,
   * so a command's answer — which is the whole recomputed cart — is never
   * clobbered by a read that resolves after it. A refusal sets the error key
   * and is not retried, because the two refusals this route can give
   * (`pos.session_not_found`, `pos.session_not_owned`) do not become true by
   * asking again.
   */
  useEffect(() => {
    if (screen.phase !== 'ready' || !tillOpen || tillSessionId === '') return;
    if (basketReadFor.current === tillSessionId) return;
    basketReadFor.current = tillSessionId;
    let live = true;
    getCart(tillSessionId)
      .then((answer) => {
        // `cart === null` is the guard: if a command has already answered,
        // its cart is newer than this read and wins.
        if (live) setCart((current) => current ?? answer);
      })
      .catch((error: unknown) => {
        if (live) setErrorKey(refusalKey(error));
      });
    return () => {
      live = false;
    };
  }, [screen.phase, tillOpen, tillSessionId]);

  // The paced type-ahead: nothing before `POS_SEARCH_MIN_CHARS`, and one read per pause.
  useEffect(() => {
    if (screen.phase !== 'ready' || !tillOpen) return;
    const text = search.trim();
    if (text.length < POS_SEARCH_MIN_CHARS) {
      setHits(null);
      setMoreMatches(false);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      searchPosProducts({ sessionId: tillSessionId, q: text })
        .then((answer) => {
          if (!live) return;
          // Every hit states, for its product, whether the product has
          // merchant variants at all. Recorded from the hits themselves, so
          // the register reports the server's answer rather than guessing.
          for (const hit of answer.items) if (hit.variantId === null) simpleProducts.current.add(hit.productId);
          setHits(answer.items);
          setMoreMatches(answer.moreMatches);
          setErrorKey(null);
        })
        .catch((error: unknown) => {
          if (!live) return;
          setHits([]);
          setMoreMatches(false);
          setErrorKey(refusalKey(error));
        });
    }, POS_SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [screen.phase, tillOpen, search, tillSessionId]);

  useEffect(
    () => () => {
      for (const timer of Object.values(quantityTimers.current)) clearTimeout(timer);
    },
    [],
  );

  /**
   * Run one cart command and take the SERVER's cart as the truth: the answer
   * replaces the whole cart, amounts included, and no local figure survives
   * it. Every one of the four routes answers a `CartDto`, which is why the
   * screen never needs a second read.
   */
  const command = useCallback(async (run: () => Promise<PosCartDto>) => {
    setBusy(true);
    setErrorKey(null);
    try {
      setCart(await run());
      setQuantityDrafts({});
    } catch (error) {
      setErrorKey(refusalKey(error));
    } finally {
      setBusy(false);
    }
  }, []);

  async function add(hit: PosProductHitDto) {
    await command(() => addCartLine(tillSessionId, { productId: hit.productId, variantId: hit.variantId, quantity: '1' }));
  }

  function onQuantity(cartLineId: string, value: string) {
    setQuantityDrafts((drafts) => ({ ...drafts, [cartLineId]: value }));
    // The SHAPE the cart admits; the unit's own precision is the server's to
    // judge, because a cart line carries no `unitDecimals` (see `model.ts`).
    const quantity = basketQuantity(value);
    setQuantityErrors((errors) => {
      const next = { ...errors };
      if (quantity === null) next[cartLineId] = 'pos.basket.quantityInvalid';
      else delete next[cartLineId];
      return next;
    });
    const timers = quantityTimers.current;
    const pending = timers[cartLineId];
    if (pending !== undefined) clearTimeout(pending);
    if (quantity === null) return;
    timers[cartLineId] = setTimeout(() => {
      void command(() => setCartLineQuantity(tillSessionId, cartLineId, { quantity }));
    }, POS_SEARCH_DELAY_MS);
  }

  async function remove(cartLineId: string) {
    setQuantityErrors((errors) => {
      const next = { ...errors };
      delete next[cartLineId];
      return next;
    });
    await command(() => removeCartLine(tillSessionId, cartLineId));
  }

  /**
   * Ask for a discount ON ONE LINE (`POS_DISCOUNT_GRAIN`). An amount that is
   * not an amount in this currency is refused on the line and NEVER SENT.
   */
  async function askDiscount(cartLineId: string, text: string) {
    const discountMinor = discountRequestMinor(text, cart?.currency ?? '');
    if (discountMinor === null) {
      setDiscountErrors((errors) => ({ ...errors, [cartLineId]: 'pos.discount.invalid' }));
      return;
    }
    setDiscountErrors((errors) => {
      const next = { ...errors };
      delete next[cartLineId];
      return next;
    });
    await command(() => requestDiscount(tillSessionId, cartLineId, { discountMinor }));
  }

  /**
   * Finish the sale, then empty the basket the sale was made from.
   *
   * THE EMPTYING IS NOT HOUSEKEEPING AND IT IS NOT ATOMIC. `POST /v1/sales` is
   * P4-S2's command and it knows nothing about `pos_cart_lines`: there is no
   * server command that commits a cart AS a sale, and no command that empties
   * a cart in one call. So the register removes each committed line through
   * the real `DELETE .../cart-lines/:cartLineId`, one call per line, and the
   * cart it shows afterwards is whichever answer came back last.
   *
   * If a removal is refused, the sale is STILL COMMITTED and the receipt is
   * still shown — hiding a committed sale would be far worse — and the
   * refusal is reported, with the lines the server still holds left on screen
   * rather than cleared locally. A locally emptied basket beside a server that
   * still holds the lines is how the same goods get sold twice.
   */
  async function finish() {
    if (till === null || cart === null) return;
    const body = saleCommitFromCart({ saleId, session: till, cart, documentDate: localDateIso(), simpleProducts: simpleProducts.current });
    if (body === null) return;
    setBusy(true);
    setErrorKey(null);
    try {
      const committed = await commitSale(body);
      setConfirmingFinish(false);
      setHits(null);
      setSearch('');
      setDiscountDrafts({});
      setDiscountErrors({});
      // The committed lines, by the ids the sale was built from.
      let remaining = cart;
      try {
        for (const line of cart.lines) remaining = await removeCartLine(tillSessionId, line.cartLineId);
      } catch (error) {
        setErrorKey(refusalKey(error));
      }
      setCart(remaining);
      setSale(committed);
    } catch (error) {
      setErrorKey(refusalKey(error));
      setConfirmingFinish(false);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Start another sale: a new `saleId`, no receipt on screen, and the CART AS
   * THE SERVER LAST ANSWERED IT — normally empty, because `finish` removed the
   * committed lines. It is not reset locally: the screen shows what the server
   * holds, or nothing it has not been told about.
   */
  function another() {
    resetSaleId();
    setSale(null);
    setErrorKey(null);
    setQuantityErrors({});
    setDiscountErrors({});
    setQuantityDrafts({});
    setDiscountDrafts({});
  }

  const toTill = () => router.push(`/${locale}/pos/till`);

  return (
    <PageShell locale={locale} active="pos">
      {screen.phase !== 'ready' ? (
        <ScreenState t={t} locale={locale} state={screen.phase} onRetry={screen.reload} />
      ) : sale !== null ? (
        <SaleDoneView t={t} locale={locale} sale={sale} onAnother={another} onGoToTill={toTill} />
      ) : (
        <RegisterView
          t={t}
          locale={locale}
          tillOpen={tillOpen}
          search={search}
          hits={hits}
          moreMatches={moreMatches}
          cart={cart}
          quantityDrafts={quantityDrafts}
          discountDrafts={discountDrafts}
          quantityErrors={quantityErrors}
          discountErrors={discountErrors}
          confirmingFinish={confirmingFinish}
          busy={busy}
          errorKey={errorKey}
          unitNames={screen.unitNames}
          onSearch={setSearch}
          onAdd={(hit) => void add(hit)}
          onQuantity={onQuantity}
          onRemove={(cartLineId) => void remove(cartLineId)}
          onDiscountText={(cartLineId, value) => {
            setDiscountDrafts((drafts) => ({ ...drafts, [cartLineId]: value }));
            setDiscountErrors((errors) => {
              const next = { ...errors };
              delete next[cartLineId];
              return next;
            });
          }}
          onApplyDiscount={(cartLineId) => void askDiscount(cartLineId, discountDrafts[cartLineId] ?? '')}
          onClearDiscount={(cartLineId) => {
            setDiscountDrafts((drafts) => ({ ...drafts, [cartLineId]: '' }));
            void askDiscount(cartLineId, '');
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
