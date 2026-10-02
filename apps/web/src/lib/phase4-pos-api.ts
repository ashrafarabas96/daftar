'use client';
/**
 * Typed POS client (P4-S3) — the two POS screens call these functions and
 * never build a URL by hand. Written in the idiom of `phase3-api.ts`, and a
 * separate file for the same reason: it has its own audit.
 *
 * LAW (as in `merchant-api.ts` and `phase3-api.ts`):
 *   - one path convention: `${BFF}/<resource>`, NO `/v1` (the proxy adds it);
 *   - every list is `{ items }` (`ListDto` / `Page`), never a bare array;
 *   - money is an integer minor-unit STRING and a quantity a decimal STRING,
 *     end to end; this file does NO arithmetic on either;
 *   - every GET is `cache: 'no-store'`: the POS reads are live;
 *   - a command's retry is made safe by the id the SCREEN minted once
 *     (`useFormDocumentId`) or by the basket's `revision`.
 *
 * ── THE TRUST BOUNDARY (OD-P4-02, RULED: discount only) ──────────────────
 * The client sends IDENTITIES, QUANTITIES and a DISCOUNT REQUEST, and nothing
 * else is believed. There is no request type below that carries a unit price,
 * a line total, a basket subtotal or a sale total, and no function below
 * computes one. Every amount a POS screen shows is a field of a server answer,
 * re-spelled by `formatMoney` and never combined with another.
 *
 * `POS_REQUEST_FIELDS` names, in one place, every field the client is allowed
 * to put in a POS request body, and `FORBIDDEN_REQUEST_FIELDS` names the ones
 * that would make the browser authoritative about price.
 * `tests/guards/phase4-pos-client-trust-boundary.test.ts` reads this module
 * and the POS screens and refuses either kind of drift, with a red proof for
 * each way of breaking it.
 */
import type { Page } from '@daftar/shared-contracts';
import { apiFetch } from './client';

const BFF = '/api/proxy';

// ═════════════════════════════════════════════════════════════════════════
// SWITCH POINT — the P4-S3 POS DTOs.
//
// The POS endpoints are built by the till-session, cart and search streams of
// this slice. Until their contract types land in
// `@daftar/shared-contracts`, the shapes the screens read are declared here.
// When they land, this block becomes ONE `import type { … }` plus the matching
// `export type { … }` line, and no screen changes: every screen imports these
// names from THIS file.
//
// WHERE EACH SHAPE COMES FROM, so a reader can tell fact from proposal:
//
//   - the TILL paths and REQUEST bodies below are the ones the till-session
//     stream shipped — `POS_ROUTE_AUTHORITY` in
//     `apps/api/src/modules/pos/pos-permissions.ts` and the two `.strict()`
//     schemas in `pos.schemas.ts`. They are read from that module, not
//     guessed, and both schemas are strict, so a field this client invented
//     would be REFUSED as an unknown key rather than quietly accepted;
//   - the till RESPONSE shape is this file's PROPOSAL: the service returns its
//     stored row and no controller is mounted yet, so the wire DTO is still
//     the coordinator's to settle. It is camelCase, as every other DTO in the
//     estate is, and it deliberately carries NEITHER the owning user nor the
//     replay digest: `current` is already scoped to the caller, and
//     `open_intent_sha256` is an engine identity a merchant never sees (A-13);
//   - the BASKET, SEARCH and SALE shapes are this file's proposal too, for the
//     cart and POS-reads streams to confirm or correct. Nothing but this file
//     changes when they do.
// ═════════════════════════════════════════════════════════════════════════

/**
 * The POS routes name `sales.view` and `sales.create` — the cashier's own
 * registered keys. There is no `pos.*` permission and no POS access read:
 * the twelve-key Phase 4 registry is closed, so a POS screen asks the server
 * and renders what it answers. A 403 on load is the permission state; a 403 on
 * a command is the mapped refusal text.
 */

/** `GET /v1/pos/till-sessions/current` — the one open till of this user, or none (OD-P4-09). */
export interface PosTillSessionDto {
  tillSessionId: string;
  branchId: string;
  status: 'open' | 'closed';
  /** ISO moments the server stamped; shown as calendar days, never parsed for arithmetic. */
  openedAt: string;
  closedAt: string | null;
  /** The cash the cashier stated was in the drawer, in integer minor units. Display only. */
  openingFloatMinor: string;
  /** The cash the cashier counted at the close, or null while the till is open. */
  closingCountMinor: string | null;
}

/** `GET /v1/pos/till-sessions/current` answer. `session` is null when this user has no till open. */
export interface PosCurrentTillDto {
  session: PosTillSessionDto | null;
}

/** One hit of `GET /v1/pos/search`. The price is the server's; the screen never edits it. */
export interface PosSearchHitDto {
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitCode: string | null;
  unitDecimals: number;
  /** Integer minor units, as text. Display only. */
  unitPriceMinor: string;
  currency: string;
  /** What the warehouse has now, as a decimal string, or null when the item is not tracked. */
  onHand: string | null;
}

/** One basket line, as the server holds it (`pos_cart_lines`). Every amount is the server's. */
export interface PosBasketLineDto {
  lineId: string;
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  unitCode: string | null;
  unitDecimals: number;
  /** Decimal string. The screen sends this value; it never multiplies it. */
  quantity: string;
  unitPriceMinor: string;
  lineTotalMinor: string;
}

/**
 * `GET /v1/pos/basket` and the answer of every basket command: the whole
 * basket as the SERVER computed it. `subtotalMinor`, `discountMinor` and
 * `totalMinor` are the only amounts the POS screens show beside the lines, and
 * the screens show them exactly as they arrive.
 */
export interface PosBasketDto {
  tillSessionId: string;
  /** Bumped by every accepted basket command; sent back with the next one. */
  revision: number;
  currency: string;
  lines: PosBasketLineDto[];
  subtotalMinor: string;
  discountMinor: string;
  totalMinor: string;
}

/**
 * The sale the server recorded, read back for the receipt screen.
 *
 * `businessTransactionId` and `movementIds` are the operator's trace, carried
 * by the answer and NEVER rendered: the merchant reads what was sold and what
 * it came to, not the engine's identities (A-13). `tests/.../invisible.test.ts`
 * plants both on the POS fixture and proves no render emits them.
 */
export interface PosSaleReceiptDto {
  saleId: string;
  /** The human sale number from the server's own sequence. */
  receiptNumber: string;
  currency: string;
  lines: PosBasketLineDto[];
  subtotalMinor: string;
  discountMinor: string;
  totalMinor: string;
  businessTransactionId: string;
  movementIds: string[];
}

// ── Request bodies ───────────────────────────────────────────────────────

/**
 * `POST /v1/pos/till-sessions` — open a till. `TillSessionOpenSchema`,
 * verbatim: the caller-minted `sessionId` IS the replay key, `branchId` is an
 * identity, and `openingFloatMinor` is the cash the cashier STATES is in the
 * drawer — a fact the merchant asserts, in integer minor units, never a
 * derivation and never a Float. The schema is `.strict()`, so the owner, the
 * scope, the status and any expected or variance figure are refused as unknown
 * keys; this client has no way to spell them.
 */
export interface PosOpenTillRequestDto {
  sessionId: string;
  branchId: string;
  openingFloatMinor: string;
}

/**
 * `POST /v1/pos/till-sessions/:sessionId/close` — count the till and close it.
 * `TillSessionCloseSchema`, verbatim: the counted cash and nothing else. No
 * variance, because the difference is a read and not a client's arithmetic.
 */
export interface PosCloseTillRequestDto {
  closingCountMinor: string;
}

/** Add a line: identities and a quantity. No price of any kind. */
export interface PosAddLineRequestDto {
  documentId: string;
  productId: string;
  variantId: string | null;
  quantity: string;
  revision: number;
}

/** Change how many of a line there are. No price of any kind. */
export interface PosSetLineQuantityRequestDto {
  quantity: string;
  revision: number;
}

/**
 * THE ONE PRICE REQUEST THE CLIENT MAY MAKE (OD-P4-02, OPTION A).
 *
 * A request for a discount of `amountMinor` on the basket, as integer minor
 * units of the basket's currency, parsed from the cashier's typed major-unit
 * text by `amountInputToMinor` (BigInt, in `@daftar/shared-contracts`). It is
 * a REQUEST: the server decides what the basket's amounts become, and the
 * screen shows what comes back. `amountMinor: '0'` asks for no discount.
 */
export interface PosDiscountRequestDto {
  amountMinor: string;
  revision: number;
}

/**
 * Finish the sale: the screen's document id and the basket's revision, and
 * nothing else. A POS sale in this slice is a walk-in sale with no buyer named
 * — naming one is a later slice's screen, and P4-S3 owns no customer read.
 */
export interface PosFinishSaleRequestDto {
  documentId: string;
  revision: number;
}

/**
 * Every field the client is allowed to put in a POS request body, with the
 * kind of thing it is. The guard test checks this list against the request
 * interfaces above and against the POS screens.
 */
export const POS_REQUEST_FIELDS: Readonly<Record<string, 'identity' | 'quantity' | 'counted-cash' | 'discount-request' | 'concurrency'>> = {
  /** The caller-minted id that makes a retry a replay (`useFormDocumentId`). */
  sessionId: 'concurrency',
  documentId: 'concurrency',
  revision: 'concurrency',
  branchId: 'identity',
  productId: 'identity',
  variantId: 'identity',
  quantity: 'quantity',
  /**
   * Cash the cashier COUNTED and states. Not a price and not a derivation: the
   * till's expected cash, and any variance, are reads the server derives — a
   * client-supplied expected total is the forged-total attack with no attacker
   * required, and neither field is spellable here.
   */
  openingFloatMinor: 'counted-cash',
  closingCountMinor: 'counted-cash',
  amountMinor: 'discount-request',
};

/**
 * Field names that would make the browser authoritative about price. None may
 * appear in a POS request interface or in a body a POS screen builds. They are
 * exactly the amounts the SERVER owns; `amountMinor` is absent on purpose,
 * because the discount request is the one price request that is ruled legal.
 */
export const FORBIDDEN_REQUEST_FIELDS: readonly string[] = [
  'unitPriceMinor',
  'lineTotalMinor',
  'subtotalMinor',
  'totalMinor',
  'discountMinor',
  'grandTotalMinor',
  'amountDueMinor',
  'priceMinor',
  // The till's own derived figures, refused by `TillSessionOpenSchema`/
  // `TillSessionCloseSchema` as unknown keys and unspellable here.
  'expectedCashMinor',
  'varianceMinor',
];

// ── Plumbing (the `phase3-api.ts` helpers, unchanged) ────────────────────

type QueryValue = string | number | boolean | undefined;

/** `?a=1&b=2`, or '' — absent values are omitted. */
function qs(params: Readonly<Record<string, QueryValue>>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    q.set(key, String(value));
  }
  const text = q.toString();
  return text.length > 0 ? `?${text}` : '';
}

const seg = (id: string): string => encodeURIComponent(id);

/** Every read: live, never cached by the browser. */
function read<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { cache: 'no-store' });
}

/** Every command; the client mints the `Idempotency-Key` per call, and the body carries the screen's document id. */
function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ── POS reads ────────────────────────────────────────────────────────────
export const getCurrentTill = () => read<PosCurrentTillDto>(`${BFF}/pos/till-sessions/current`);
export const getTillSession = (tillSessionId: string) => read<PosTillSessionDto>(`${BFF}/pos/till-sessions/${seg(tillSessionId)}`);
/**
 * `GET /v1/pos/search` — what this till may sell, for the typed text.
 *
 * It names the BRANCH, which is the only place identity a till session carries
 * (`TillSessionOpenSchema`). WHICH warehouse the stock and the price come from
 * is the server's answer, not the client's choice: a browser that picked the
 * warehouse would be deciding where the goods leave from.
 */
export const searchPosItems = (q: { search: string; branchId: string; limit?: number }) =>
  read<Page<PosSearchHitDto>>(`${BFF}/pos/search${qs({ search: q.search, branchId: q.branchId, limit: q.limit })}`);
export const getPosBasket = () => read<PosBasketDto>(`${BFF}/pos/basket`);

// ── POS commands (document-id and revision retry kinds) ──────────────────
export const openTill = (body: PosOpenTillRequestDto) => send<PosTillSessionDto>('POST', `${BFF}/pos/till-sessions`, body);
export const closeTill = (tillSessionId: string, body: PosCloseTillRequestDto) =>
  send<PosTillSessionDto>('POST', `${BFF}/pos/till-sessions/${seg(tillSessionId)}/close`, body);
export const addBasketLine = (body: PosAddLineRequestDto) => send<PosBasketDto>('POST', `${BFF}/pos/basket/lines`, body);
export const setBasketLineQuantity = (lineId: string, body: PosSetLineQuantityRequestDto) =>
  send<PosBasketDto>('PUT', `${BFF}/pos/basket/lines/${seg(lineId)}`, body);
export const removeBasketLine = (lineId: string, revision: number) => send<PosBasketDto>('DELETE', `${BFF}/pos/basket/lines/${seg(lineId)}${qs({ revision })}`);
export const requestBasketDiscount = (body: PosDiscountRequestDto) => send<PosBasketDto>('POST', `${BFF}/pos/basket/discount`, body);
export const finishSale = (body: PosFinishSaleRequestDto) => send<PosSaleReceiptDto>('POST', `${BFF}/pos/sales`, body);
