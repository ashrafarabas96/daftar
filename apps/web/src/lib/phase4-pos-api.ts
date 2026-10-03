'use client';
/**
 * Typed POS client (P4-S3) — the two POS screens call these functions and
 * never build a URL by hand. Written in the idiom of `phase3-api.ts`, and a
 * separate file for the same reason: it has its own audit.
 *
 * ── WHY THIS FILE WAS REWRITTEN, AND WHAT WAS MEASURED ───────────────────
 * The first version of this module was written against a PLANNED basket
 * surface — `GET /pos/basket`, `POST /pos/basket/lines`,
 * `PUT /pos/basket/lines/:lineId`, `DELETE /pos/basket/lines/:lineId?revision=`,
 * `POST /pos/basket/discount`, `POST /pos/sales` — and none of those six
 * endpoints was ever built. The browser gate reported 36 failures, three
 * locales x three viewports, every one of them `404 GET
 * /api/proxy/pos/basket`. The surface the server actually mounts is
 * `pos-cart.controller.ts` (`/v1/pos/till-sessions/:sessionId/cart-lines`,
 * one route per LINE), `till-sessions.controller.ts` and P4-S2's
 * `POST /v1/sales`. Every function below names a route read out of one of
 * those three controllers.
 *
 * Three invented mechanisms are GONE rather than defaulted:
 *
 *   - **`revision`.** `pos_cart_lines` has no optimistic-concurrency counter
 *     and no `CartDto` field carries one. The basket is append-only and each
 *     line is addressed by its server-minted `cartLineId`, with a `line_no`
 *     ordinal the server assigns (`0079`). A `revision` parameter the server
 *     ignores is a lie in a signature, so it is deleted and not defaulted.
 *   - **`documentId` on a basket command.** `CartAddLineSchema` and
 *     `CartChangeQuantitySchema` are `.strict()` and accept three fields and
 *     one field respectively; a client-minted id is refused as an unknown
 *     key. The cart has no idempotency contract an id could be the key of —
 *     `pos-cart.service.ts` says so and mints the line id itself. The sale
 *     commit DOES have one, and there the key is `saleId` (P4-AL-30).
 *   - **the basket-level discount.** See `POS_DISCOUNT_GRAIN` below.
 *
 * ── LAW (as in `merchant-api.ts` and `phase3-api.ts`) ────────────────────
 *   - one path convention: `${BFF}/<resource>`, NO `/v1` (the proxy adds it);
 *   - money is an integer minor-unit STRING and a quantity a decimal STRING,
 *     end to end; this file does NO arithmetic on either;
 *   - every GET is `cache: 'no-store'`: the POS reads are live.
 *
 * ── THE TRUST BOUNDARY (OD-P4-02, RULED: discount only) ──────────────────
 * The client sends IDENTITIES, QUANTITIES and a DISCOUNT REQUEST, and nothing
 * else is believed. There is no request type below that carries a unit price,
 * a line total, a basket subtotal or a sale total, and no function below
 * computes one. Every amount a POS screen shows is a field of a server answer,
 * re-spelled by `formatMoney` and never combined with another.
 *
 * `POS_REQUEST_FIELDS` names, in one place, every field the client is allowed
 * to put in a POS request body, with the KIND of thing it is.
 * `FORBIDDEN_REQUEST_FIELDS` names the ones that would make the browser
 * authoritative about price — the client's mirror of the server's own
 * `POS_CART_FORGED_FIELDS` (`apps/api/src/modules/pos/pos-price-authority.ts`)
 * and of `SALE_FORBIDDEN_REQUEST_FIELDS` (`packages/domain-core/src/sale.ts`).
 * `SESSION_DERIVED_FIELDS` is the third list and it is new: a fact of the till
 * SESSION, which may be named only where the session is being created or
 * echoed back, and never in a read's query string (RULING 2, `P4-AL-18`).
 * `tests/guards/phase4-pos-client-trust-boundary.test.ts` reads this module
 * and the POS screens and refuses every kind of drift, with a red proof for
 * each way of breaking it.
 */
import type { PosMatchKindDto, PosProductHitDto, PosProductSearchDto, SaleDto, SaleLineDto } from '@daftar/shared-contracts';
import { apiFetch } from './client';

const BFF = '/api/proxy';

// ═════════════════════════════════════════════════════════════════════════
// SWITCH POINT — the P4-S3 POS DTOs. PARTLY SWITCHED, and the line is exact.
//
// IMPORTED from `@daftar/shared-contracts` and re-exported, so a field renamed
// in the contract is a type error here rather than a screen rendering
// `undefined`:
//
//   - the product type-ahead (`PosProductSearchDto`, `PosProductHitDto`,
//     `PosMatchKindDto`) — `packages/shared-contracts/src/pos.ts`;
//   - the committed sale (`SaleDto`, `SaleLineDto`) — P4-S2's own contract in
//     `packages/shared-contracts/src/sales.ts`. The POS receipt is a `SaleDto`
//     and not a POS type at all: the register finishes a sale through
//     `POST /v1/sales`, so what comes back is the selling slice's answer.
//
// STILL DECLARED HERE, because no contract type exists for them yet:
//
//   - `PosTillSessionDto` — the WIRE shape of `TillSession`
//     (`till-session.service.ts:277`). It is the stored ROW, column names and
//     all: `id`, `branch_id`, `warehouse_id`, `terminal_code`,
//     `currency_code`, `opened_by`, `status`, `opened_at`, `closed_at`,
//     `opening_float_minor`, `closing_count_minor`. The controller returns
//     the row with no mapping layer (`RETURNING` is the column list) and
//     `tests/helpers/pos-till-sessions.ts:87` reads `res.body.id`, so the
//     camelCase `tillSessionId`/`openedAt` this file used to declare never
//     existed on the wire. Declared as it IS, not as it should be;
//   - `PosCartDto` — `CartDto` (`pos-cart.service.ts:131`), the answer of
//     every cart command.
//
// Neither has been promoted to the shared contract, and inventing a contract
// type for them is a decision for whoever owns the package — so they stay,
// named as what they mirror, and this comment says which is which.
// ═════════════════════════════════════════════════════════════════════════

export type { PosMatchKindDto, PosProductHitDto, PosProductSearchDto, SaleDto, SaleLineDto };

/**
 * The POS routes name `sales.view` and `sales.create` — the cashier's own
 * registered keys — and the discount request additionally needs the SENSITIVE
 * `sales.discount`, checked in the service because it depends on the body.
 * There is no `pos.*` permission and no POS access read: the twelve-key
 * Phase 4 registry is closed, so a POS screen asks the server and renders what
 * it answers. A 403 on load is the permission state; a 403 on a command is the
 * mapped refusal text.
 */

// ═════════════════════════════════════════════════════════════════════════
// THE DISCOUNT GRAIN — ONE PLACE, NAMED.
//
// `OD-P4-02` is RULED OPTION A (a discount and no price override) but it does
// not settle the GRAIN, and the grain is a real fork:
//
//   - the SERVER's discount is PER LINE. `pos_cart_lines` carries
//     `requested_discount_minor`, `POST .../cart-lines/:cartLineId/discount`
//     addresses one line, and `CartRequestDiscountSchema` is
//     `{ discountMinor }` for that line. P4-S2's sealed `sale_items_discount_ck`
//     (`0077:255`-ish, per line) and `SaleCommitLineDto.discountMinor` are per
//     line too, so the sale the basket commits to is per line all the way down;
//   - the first browser flow asked for ONE discount for the WHOLE basket.
//
// A basket-level discount is NOT a client-side division of one figure across
// the lines: that would be the browser computing the per-line amounts the
// server owns, which is the exact thing `P4-AL-18` forbids. It needs a SERVER
// command that allocates, plus an allocation rule (by gross? by quantity?
// largest-remainder?) and a rounding-residue decision. Neither exists, and the
// project owner has been asked and has not answered.
//
// SO: PER LINE, by default and on purpose. The cashier asks for a discount on
// a line; the basket's own `discountMinor` — the SERVER's exact integer sum of
// the line requests (`pos-cart-pricing.ts:211`) — stays visible as the basket
// figure, so the merchant still sees one "discount given" number.
//
// THE ALTERNATIVE, for whoever gets the ruling: a basket-level server command
// (`POST .../cart-discount`, say) that allocates across the lines and answers
// the same `CartDto`. Switching to it is ONE edit here — this constant and
// `requestDiscount` below — plus the screen reading the constant's new value.
// Do not build the allocation in the browser.
// ═════════════════════════════════════════════════════════════════════════

/** The grain a discount is asked for at. `'line'` while no basket-level server command exists. */
export const POS_DISCOUNT_GRAIN = 'line' as const;

/** `GET /v1/pos/till-sessions/current` and `/:sessionId` — the stored row, column names and all. */
export interface PosTillSessionDto {
  /** The session's id. Named `id`, not `tillSessionId`: this is the row. */
  id: string;
  branch_id: string;
  /** The warehouse this till sells from. `NOT NULL` and immutable after the open (RULING 2). */
  warehouse_id: string;
  terminal_code: string;
  /** The session's currency, upper-cased by the routine. The basket and the sale are counted in it. */
  currency_code: string;
  /** The user the till belongs to (`OD-P4-09`). Carried, never rendered. */
  opened_by: string;
  status: string;
  /** An ISO moment the server stamped; shown as a calendar day, never parsed for arithmetic. */
  opened_at: string;
  closed_at: string | null;
  /** The cash the cashier stated was in the drawer, in integer minor units. Display only. */
  opening_float_minor: string;
  /** The cash the cashier counted at the close, or null while the till is open. */
  closing_count_minor: string | null;
}

/** One basket line, as the server holds and prices it. Every amount is the server's. */
export interface PosCartLineDto {
  /** The SERVER-minted line id. The client never mints one and never guesses a `line_no`. */
  cartLineId: string;
  productId: string;
  variantId: string | null;
  /** The product's name as the server snapshotted it. There is no `variantName` on a cart line. */
  name: string;
  /**
   * The exact decimal spelling of the stored Q4 quantity (`formatQ4`). There is
   * no `unitCode` and no `unitDecimals` here, so the screen re-spells this
   * text and never pads it to a precision it cannot know.
   */
  quantity: string;
  unitPriceMinor: string;
  /** `HALF_EVEN(quantity x catalogue price)`, rounded once, by the server. */
  grossMinor: string;
  /** The discount the server granted on this line — the cashier's own request, as stored. */
  discountMinor: string;
  /** `gross - discount`. This is what the old client called `lineTotalMinor`. */
  netMinor: string;
}

/**
 * The answer of EVERY cart command, and of the cart read: the whole basket as
 * the SERVER computed it (`CartDto`, `pos-cart.service.ts:131`).
 *
 * `subtotalMinor`, `discountMinor` and `totalMinor` are the three amounts the
 * register shows beside the lines, and it shows them exactly as they arrive.
 * There is NO `revision`.
 */
export interface PosCartDto {
  tillSessionId: string;
  currency: string;
  subtotalMinor: string;
  /** The exact integer sum of the line discount requests. No rounding at this grain. */
  discountMinor: string;
  /**
   * Structurally zero (`P4-AL-44`, `OD-03` OPEN). REPORTED because the server
   * derives it, never because anyone stated it — and never computed here. A
   * POS screen does not show it: there is no tax line to show, and a row
   * reading "Tax 0.00" would state a tax policy this product does not have.
   */
  taxMinor: string;
  totalMinor: string;
  lines: PosCartLineDto[];
}

// ── Request bodies ───────────────────────────────────────────────────────

/**
 * `POST /v1/pos/till-sessions` — open a till. `TillSessionOpenSchema`
 * (`pos.schemas.ts`), verbatim and complete: FIVE fields, not three.
 *
 * `sessionId` is the caller-minted replay KEY (the stored open-intent digest
 * is what makes it a proof, `P4-AL-30`). `branchId` and `warehouseId` are
 * identities — and the warehouse is named HERE and nowhere else on this
 * surface, because the open is the moment it is CHOSEN; after that it is a
 * fact of the session and a request that named it would be choosing the scope
 * of its own read (RULING 2, `SESSION_DERIVED_FIELDS`). `terminalCode` names
 * the physical till and is held to the `invpl/1` `code` grammar.
 * `openingFloatMinor` is cash a human COUNTED and asserts.
 *
 * The schema is `.strict()`, so the owner, the scope, the status, the currency
 * and any expected or variance figure are refused as unknown keys; this client
 * has no way to spell them.
 */
export interface PosOpenTillRequestDto {
  sessionId: string;
  branchId: string;
  warehouseId: string;
  terminalCode: string;
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

/** `POST .../cart-lines` — add a line. `CartAddLineSchema`: identities and a quantity. No price. */
export interface PosAddLineRequestDto {
  productId: string;
  variantId: string | null;
  quantity: string;
}

/** `PATCH .../cart-lines/:cartLineId` — change how many. `CartChangeQuantitySchema`: ONE field. */
export interface PosSetLineQuantityRequestDto {
  quantity: string;
}

/**
 * THE ONE PRICE REQUEST THE CLIENT MAY MAKE (`OD-P4-02`, OPTION A), on ONE
 * LINE (`POS_DISCOUNT_GRAIN`).
 *
 * `CartRequestDiscountSchema`: `{ discountMinor }`, integer minor units of the
 * basket's currency, parsed from the cashier's typed major-unit text by
 * `amountInputToMinor` (BigInt, in `phase3-format`). It is a REQUEST: the
 * server decides whether this actor may make it (`sales.discount`, SENSITIVE)
 * and whether it fits inside the line's DERIVED gross, and the screen shows
 * what comes back. `'0'` asks for no discount, which is a REMOVAL and needs
 * the same permission.
 *
 * It was `amountMinor` in the first version of this file, which the server's
 * own authority scan lists as a forged field ("every amount on a cart line is
 * derived", `pos-price-authority.ts:103`) — so that spelling was refused
 * `pos.cart_price_authority_refused` before it ever reached a schema.
 */
export interface PosDiscountRequestDto {
  discountMinor: string;
}

/**
 * One line of the sale commit (`SaleCommitLineDto`): an identity, a quantity,
 * and the discount REQUEST — built from a `PosCartLineDto` by
 * `saleCommitFromCart` and from nothing else.
 *
 * `lineId` is the CLIENT's here — it is the `source_line_id` of the stock
 * movement, the `id` of the `sale_items` row and part of the signed intent, so
 * a server-minted one would make two identical requests two different
 * commands. `saleCommitFromCart` uses the line's own `cartLineId` for it: a
 * canonical lowercase uuid the server minted once for this basket line, unique
 * per line and STABLE across a retry without the screen holding a second map.
 * The two ids live in different relations, so there is no collision; what
 * matters is that the id does not change between a call and its replay, and a
 * freshly minted one per attempt would break exactly that.
 */
export interface PosSaleLineRequestDto {
  lineId: string;
  productId: string;
  variantId: string | null;
  quantity: string;
  discountMinor: string;
}

/**
 * `POST /v1/sales` — the P4-S2 ATOMIC SALE COMMIT, which is what finishing a
 * sale at the till actually is. `SaleCommitSchema` (`selling.schemas.ts:320`),
 * `.strict()`, every field required.
 *
 * It is NOT `POST /pos/sales`: there is no such route, and there is no POS
 * route that sells. `sales.controller.ts` is explicit that one writing route
 * commits the sale, its items, the movements, the COGS entry, the invoice and
 * the revenue entry in ONE transaction, and that no route does half of it.
 *
 * WHAT IS AND IS NOT A FIGURE HERE. Nine fields, and exactly one of them has
 * the shape of money:
 *
 *   - `saleId` is the identity AND the idempotency key (`P4-AL-30`);
 *   - `settlementMode` is `'cash'`: a till takes the money at the counter. The
 *     `'credit'` arm needs a named customer and `receivables.view`, and the
 *     screen that names a customer is a later slice's;
 *   - `customerId` is `null` — a WALK-IN, admissible only for a cash sale;
 *   - `warehouseId` is the till SESSION's own `warehouse_id`, echoed from the
 *     server's answer. The sale commit requires it (the server resolves the
 *     BRANCH from it) and the POS surface does not accept it, which is not a
 *     contradiction: `SESSION_DERIVED_FIELDS` records that echoing a fact the
 *     server stated is not choosing it, and `saleCommitFromCart` is the only
 *     place it is read;
 *   - `documentDate` is the browser's own calendar day (`localDateIso`), as
 *     every other Phase 3 document command states it. It is REQUIRED and has
 *     no default by design — `[[daftar-a-command-must-not-read-the-clock]]`:
 *     a retry sent either side of midnight must be the same command forever.
 *     A clock that is ahead of the server's therefore gets
 *     `sale.document_date_in_future`, which is why that refusal now has
 *     merchant text in all three locales;
 *   - `dueDate` is `null`: no credit term, stated rather than omitted;
 *   - `taxMinor` is the STRUCTURAL ZERO. See `POS_SALE_TAX_MINOR`;
 *   - `notes` is `null`: the till writes none;
 *   - `lines` carry identities, quantities and discount requests only.
 *
 * There is no `branchId`, no `currency`, no rate, no total and no cost in this
 * type, and `SaleCommitSchema` is `.strict()`, so a forged total is not merely
 * refused — it is inexpressible.
 */
export interface PosSaleCommitRequestDto {
  saleId: string;
  settlementMode: 'cash';
  customerId: null;
  warehouseId: string;
  documentDate: string;
  dueDate: null;
  taxMinor: string;
  notes: null;
  lines: PosSaleLineRequestDto[];
}

/**
 * The ONE figure-shaped field the client puts in a sale commit, and it is not
 * a figure the client chose.
 *
 * `SaleCommitSchema` declares `taxMinor: z.literal(SALE_STRUCTURAL_ZERO_TAX_MINOR)`
 * — the literal string `'0'` and nothing else is accepted (`P4-AL-44`,
 * `OD-03` OPEN). It is a signed input rather than a server default so that the
 * day a Country Pack enables tax the fingerprint position already exists.
 *
 * So this is a STRUCTURAL POSITION, not an amount: there is no value the
 * client could put here that the server would adopt, and the only alternative
 * to `'0'` is a refusal. It is spelled as a named constant rather than inline
 * so that the trust-boundary guard can insist the client never computes it,
 * and it mirrors `SALE_STRUCTURAL_ZERO_TAX_MINOR`
 * (`packages/domain-core/src/sale.ts:204`) — copied rather than imported
 * because `@daftar/web` depends on `@daftar/shared-contracts` and not on
 * `@daftar/domain-core`, and adding a dependency is not this slice's to make.
 *
 * `OD-03` IS OPEN AND NOTHING HERE SETTLES IT. No rate, no exemption, no
 * threshold and no jurisdiction appears in this module, and no screen computes
 * a tax of any kind. The server's own `CartDto.taxMinor` is likewise reported
 * and never shown.
 */
export const POS_SALE_TAX_MINOR = '0';

/**
 * Every field the client is allowed to put in a POS request body or query
 * string, with the kind of thing it is. The guard test checks this list
 * against the request interfaces below and against the POS screens, so adding
 * a field is a visible act.
 */
export const POS_REQUEST_FIELDS: Readonly<
  Record<
    string,
    | 'identity'
    | 'quantity'
    | 'counted-cash'
    | 'discount-request'
    | 'structural-zero'
    | 'stated-fact'
    | 'merchant-text'
    | 'line-list'
    | 'concurrency'
    | 'session-derived'
    | 'search-text'
    | 'page-size'
  >
> = {
  /**
   * The caller-minted id that makes a retry a replay. `sessionId` is the till
   * open's replay key (`P4-AL-30`: the stored open-intent digest is the
   * proof); `saleId` is the sale commit's; `lineId` is a sale item's own id,
   * which is inside the signed intent and so cannot be server-minted. On
   * `GET /v1/pos/products` the `sessionId` is instead the identity of the till
   * whose warehouse the server DERIVES the answer from, which is the whole of
   * RULING 2.
   */
  sessionId: 'concurrency',
  saleId: 'concurrency',
  lineId: 'concurrency',
  branchId: 'identity',
  /** The physical till, held to the `invpl/1` `code` grammar by the column's own CHECK. */
  terminalCode: 'identity',
  /** The SERVER-minted cart line, addressed in a path. The client never mints one. */
  cartLineId: 'identity',
  productId: 'identity',
  variantId: 'identity',
  /** `null` on a POS sale: a walk-in. Naming a customer is a later slice's screen. */
  customerId: 'identity',
  quantity: 'quantity',
  /**
   * Cash the cashier COUNTED and states. Not a price and not a derivation: the
   * till's expected cash, and any variance, are reads the server derives — a
   * client-supplied expected total is the forged-total attack with no attacker
   * required, and neither field is spellable here.
   */
  openingFloatMinor: 'counted-cash',
  closingCountMinor: 'counted-cash',
  /** The one price request the ruling allows, at the grain `POS_DISCOUNT_GRAIN` names. */
  discountMinor: 'discount-request',
  /** `z.literal('0')`. A position in the signed intent, not an amount — see `POS_SALE_TAX_MINOR`. */
  taxMinor: 'structural-zero',
  /** Facts the merchant states about the document: how it settled, its day, its term. */
  settlementMode: 'stated-fact',
  documentDate: 'stated-fact',
  dueDate: 'stated-fact',
  /** Free text the merchant may write on a sale. The till writes none and sends `null`. */
  notes: 'merchant-text',
  /** The sale commit's line array. Its members are judged as a request type of their own. */
  lines: 'line-list',
  /** The till session's own warehouse, echoed back — see `SESSION_DERIVED_FIELDS`. */
  warehouseId: 'session-derived',
  /** The typed prefix. Text the cashier is looking for, not a fact about the catalogue. */
  q: 'search-text',
  /** How many matches to show at once. It cannot widen the read's scope, only shorten its answer. */
  limit: 'page-size',
};

/**
 * Field names that would make the browser authoritative about price. None may
 * appear in a POS request interface, in a body a POS screen builds, or in a
 * query string. They are the amounts and the derivations the SERVER owns.
 *
 * This is the client's mirror of the server's two lists —
 * `POS_CART_FORGED_FIELDS` (`pos-price-authority.ts:79`) and
 * `SALE_FORBIDDEN_REQUEST_FIELDS` (`packages/domain-core/src/sale.ts:246`) —
 * and it is a list of names the client CANNOT SPELL, not a list of names the
 * server happens to refuse. Both halves matter: the server's refusal is
 * necessary and not sufficient, because a browser that computes a total and
 * shows it has already lied to the merchant.
 *
 * `discountMinor` is absent on purpose: it is the one price request the ruling
 * makes legal. `taxMinor` is absent on purpose too, and it is the harder case
 * — `SaleCommitSchema` REQUIRES it as `z.literal('0')`, so the position must
 * exist in a request type. It is declared `'structural-zero'` in
 * `POS_REQUEST_FIELDS` and pinned to `POS_SALE_TAX_MINOR`, and the guard
 * refuses any other spelling; the CART commands have no tax field at all and
 * the server's scan lists `taxMinor` as forged there.
 */
export const FORBIDDEN_REQUEST_FIELDS: readonly string[] = [
  // Server-recomputed money: the four figures the brief names, their
  // spellings, and their neighbours.
  'unitPriceMinor',
  'unitPrice',
  'price',
  'priceMinor',
  'priceOverride',
  'overridePriceMinor',
  'grossMinor',
  'netMinor',
  'lineTotal',
  'lineTotalMinor',
  'cartTotal',
  'cartTotalMinor',
  'subtotal',
  'subtotalMinor',
  'grandTotal',
  'grandTotalMinor',
  'totalMinor',
  'totalTxnMinor',
  'totalBaseMinor',
  'baseShareMinor',
  'amountMinor',
  'amountDueMinor',
  // Server-resolved cost and value (P4-AL-25): never an input, never a column.
  'cogsMinor',
  'cogsBaseMinor',
  'unitCostMinor',
  'averageCost',
  // OD-03 is OPEN. A rate, an exemption or a threshold is not a figure with a
  // policy behind it, so none of them is spellable; the one tax POSITION the
  // sale commit has is `taxMinor`, pinned to `POS_SALE_TAX_MINOR`.
  'tax',
  'taxRate',
  'taxExempt',
  'discountPercent',
  'discountRate',
  // Server-resolved FX (P4-AL-19): the snapshot is read from the registry.
  'currency',
  'currencyCode',
  'fxRate',
  'rate',
  'rateSource',
  'rateTimestamp',
  'sourceToBaseRate',
  // The till's own derived figures, refused by `TillSessionOpenSchema` /
  // `TillSessionCloseSchema` as unknown keys and unspellable here.
  'expectedCashMinor',
  'varianceMinor',
  // Server-resolved scope and authority (P4-AL-35, P4-AL-40). The sale's
  // branch is the warehouse's home branch, resolved by the server; scope is
  // RLS and never a payload. `branchId` is NOT here, because the till OPEN
  // names a branch — `SALE_FORBIDDEN_REQUEST_FIELDS` forbids it on the SALE,
  // and the sale commit type below has no such field.
  'tenantId',
  'businessId',
  'actorUserId',
  'permission',
  // Server-resolved stock truth (P4-AL-05) and the oversell flag
  // (`OD-P4-05` OPTION A: unrepresentable, not refused).
  'onHand',
  'availableQuantity',
  'reservedQuantity',
  'allowOversell',
  'allowNegativeStock',
  // The idempotency anti-pattern (P4-AL-30): the document's own UUID is the
  // key, and the invented `documentId`/`revision` plumbing is gone.
  'idempotencyKey',
  'revision',
  'expectedRevision',
];

/**
 * FACTS OF THE TILL SESSION. A field here is not a forged amount — it is a
 * truth the server stated about the session — but a request that NAMES one is
 * choosing something the session already fixed.
 *
 * `warehouseId` is the whole list. The till's warehouse is `NOT NULL`,
 * immutable after the session opens, and behind a composite foreign key. A
 * client that could name it could sell from a warehouse its own open till does
 * not sell from, and would be the source of truth for the scope of its own
 * read (RULING 2, `P4-AL-18`). So:
 *
 *   - NO read may put it in a query string. `PosProductSearchQuerySchema` is
 *     `{ sessionId, q, limit? }` and `.strict()`: the request names the
 *     SESSION and the server derives the warehouse. The answer ECHOES it so
 *     the screen can say which warehouse an on-hand figure belongs to, and
 *     reading it back is not sending it;
 *   - no CART command may carry it, in a body or a path;
 *   - exactly the two requests in `SESSION_DERIVED_ALLOWED_IN` may, each for a
 *     reason recorded there.
 */
export const SESSION_DERIVED_FIELDS: readonly string[] = ['warehouseId'];

/**
 * The only request types that may name a session-derived fact, with the reason
 * each one may. The guard refuses any other type that names one, and refuses
 * an entry here for a type that does not.
 */
export const SESSION_DERIVED_ALLOWED_IN: Readonly<Record<string, string>> = {
  PosOpenTillRequestDto: 'the open is the moment the warehouse is CHOSEN; after it, the warehouse is a fact of the session',
  PosSaleCommitRequestDto: 'echoed from the till session the server answered, by saleCommitFromCart and nowhere else',
};

// ── Plumbing (the `phase3-api.ts` helpers) ───────────────────────────────

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

/**
 * Every command. `PATCH` is in the union because the cart's quantity change is
 * a `PATCH` and not a `PUT` (`pos-cart.controller.ts`) — the first version of
 * this file sent `PUT` to a route that answers only `PATCH`.
 */
function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The cart routes of one session. Four commands and one read hang off it. */
const cartLines = (tillSessionId: string): string => `${BFF}/pos/till-sessions/${seg(tillSessionId)}/cart-lines`;

// ── POS reads ────────────────────────────────────────────────────────────

/**
 * `GET /v1/pos/till-sessions/current` — the one open till of this user, or
 * none (`OD-P4-09`).
 *
 * The answer is the session itself or `null`, NOT an envelope: the controller
 * returns `TillSession | null`. The first version of this file read
 * `answer.session` off an envelope the route has never sent.
 *
 * ── WHY "NO TILL" IS DECIDED HERE AND BY THE `id` ────────────────────────
 * MEASURED on the browser gate, not reasoned about: NestJS sends NO BODY at
 * all for a handler that returns `null`, and `apiFetch` turns a body it cannot
 * parse into `{}` (`client.ts:266`, `res.json().catch(() => ({}))`). So "this
 * user has no till open" arrives in the browser as an EMPTY OBJECT, which is
 * truthy — and the till screen rendered its OPEN branch for it and then threw
 * `Cannot read properties of undefined (reading 'slice')` out of
 * `formatCivilDate(session.opened_at)`, in all three locales at all three
 * viewports.
 *
 * The session is therefore recognised by the one field every answer has: its
 * `id`. An object without one is not a session, so it is `null` here rather
 * than a shape every caller has to re-check.
 */
export async function getCurrentTill(): Promise<PosTillSessionDto | null> {
  const answer = await read<PosTillSessionDto | null>(`${BFF}/pos/till-sessions/current`);
  if (answer === null || typeof answer !== 'object' || typeof answer.id !== 'string' || answer.id === '') return null;
  return answer;
}

export const getTillSession = (tillSessionId: string) => read<PosTillSessionDto>(`${BFF}/pos/till-sessions/${seg(tillSessionId)}`);

/**
 * `GET /v1/pos/products` — what this till may sell, for the typed prefix.
 *
 * FACT, read from `PosProductSearchQuerySchema` (`.strict()`): the query is
 * `{ sessionId, q, limit? }` and `limit` is 1..50. It names the SESSION, and
 * `warehouseId` is REFUSED as a query parameter (RULING 2, above).
 */
export const searchPosProducts = (q: { sessionId: string; q: string; limit?: number }) =>
  read<PosProductSearchDto>(`${BFF}/pos/products${qs({ sessionId: q.sessionId, q: q.q, limit: q.limit })}`);

/**
 * `GET /v1/pos/till-sessions/:sessionId/cart-lines` — the basket this till is
 * holding, as a `CartDto`.
 *
 * ── DECLARED AGAINST A ROUTE THIS TREE DOES NOT MOUNT ────────────────────
 * A sibling agent is adding this read. It is NOT in this worktree: there is no
 * `@Get` in `pos-cart.controller.ts` (the file's own header says "There is no
 * `GET` here"), `pos-reads.controller.ts` mounts only `products`, and
 * `tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:65-82` lists
 * the eight P4-S3 routes without it. So this function is written to the
 * signature the coordinator gave — path, method and `CartDto` answer — and it
 * is NOT CALLED by a screen in this tree, because a mount read against a route
 * that answers 404 is the exact defect this rewrite removes.
 *
 * WHAT THE REGISTER DOES INSTEAD, and why it is not a workaround: every cart
 * command answers with the whole RECOMPUTED cart, which
 * `pos-cart.controller.ts` gives as the reason there is no `GET` ("so a till
 * never asks twice"). A till session is created empty, so the register that
 * opened it knows the basket from the server's own answers.
 *
 * WHAT IS THEREFORE NOT WIRED: a basket does not survive a page RELOAD. The
 * server still holds the lines and the screen shows none. That is one line to
 * fix — call this in the register's mount effect — the moment the route lands,
 * and it is reported rather than hidden.
 */
export const getCart = (tillSessionId: string) => read<PosCartDto>(cartLines(tillSessionId));

// ── Till commands ────────────────────────────────────────────────────────

export const openTill = (body: PosOpenTillRequestDto) => send<PosTillSessionDto>('POST', `${BFF}/pos/till-sessions`, body);

export const closeTill = (tillSessionId: string, body: PosCloseTillRequestDto) =>
  send<PosTillSessionDto>('POST', `${BFF}/pos/till-sessions/${seg(tillSessionId)}/close`, body);

// ── Cart commands — one route per LINE, each answering the whole cart ────

/** `POST .../cart-lines` → `201`, the whole cart. The basket is append-only, so a line really is created. */
export const addCartLine = (tillSessionId: string, body: PosAddLineRequestDto) => send<PosCartDto>('POST', cartLines(tillSessionId), body);

/** `PATCH .../cart-lines/:cartLineId` → `200`, the whole cart. `PATCH`, not `PUT`. */
export const setCartLineQuantity = (tillSessionId: string, cartLineId: string, body: PosSetLineQuantityRequestDto) =>
  send<PosCartDto>('PATCH', `${cartLines(tillSessionId)}/${seg(cartLineId)}`, body);

/**
 * `DELETE .../cart-lines/:cartLineId` → `200`, the whole cart.
 *
 * NO BODY and NO `revision`. The route declares a `@Body()` so the authority
 * scan runs, and `assertRemovalStatesNothing` refuses a removal that states
 * anything — `CartRemoveLineSchema` is `z.object({}).strict()`. The invented
 * `?revision=` query string is gone, not defaulted.
 */
export const removeCartLine = (tillSessionId: string, cartLineId: string) => send<PosCartDto>('DELETE', `${cartLines(tillSessionId)}/${seg(cartLineId)}`);

/**
 * `POST .../cart-lines/:cartLineId/discount` → `200`, the whole cart.
 *
 * THE GRAIN IS THE LINE (`POS_DISCOUNT_GRAIN`). This signature, and the
 * constant above it, are the one place that choice lives.
 */
export const requestDiscount = (tillSessionId: string, cartLineId: string, body: PosDiscountRequestDto) =>
  send<PosCartDto>('POST', `${cartLines(tillSessionId)}/${seg(cartLineId)}/discount`, body);

// ── The sale commit (P4-S2's route, not a POS one) ───────────────────────

/** `POST /v1/sales` → `200`, the committed sale. `saleId` is the key, so a retry is a replay. */
export const commitSale = (body: PosSaleCommitRequestDto) => send<SaleDto>('POST', `${BFF}/sales`, body);

/**
 * THE SALE COMMIT, BUILT FROM THE SERVER'S OWN TWO ANSWERS AND NOTHING ELSE.
 *
 * This function exists so that the register never spells a field of a sale
 * commit. Every value it produces comes from exactly one of four places, and
 * the guard test asserts that list over this function's source:
 *
 *   1. the caller's minted `saleId`, held across a retry by the screen so the
 *      replay is a replay;
 *   2. the till SESSION the server answered — `session.warehouse_id`, read
 *      here and nowhere else (`SESSION_DERIVED_ALLOWED_IN`);
 *   3. the CART the server answered — each line's `cartLineId`, `productId`,
 *      `variantId`, `quantity` and `discountMinor`. Nothing else is read off a
 *      cart line: `unitPriceMinor`, `grossMinor` and `netMinor` are the
 *      server's and are not mentioned. And NO FIELD OF THE CART ITSELF is
 *      read — not `subtotalMinor`, not `discountMinor`, not `totalMinor`, not
 *      `currency`, not `taxMinor`. The sale's totals are the server's to
 *      recompute from the identities and quantities below;
 *   4. four constants that state a fact rather than a figure —
 *      `'cash'`, `null`, `null`, `null` — and `POS_SALE_TAX_MINOR`, which is
 *      a structural position and not an amount.
 *
 * The line `discountMinor` is the exact text the CART carries for that line,
 * which is the cashier's own request as stored (`requested_discount_minor`,
 * `pos-cart-pricing.ts:187`) and not a figure the server derived from it. So
 * the basket's discount requests commit as the sale's discount requests, and
 * the server grants or refuses them again under `sales.discount`.
 *
 * `documentDate` is the caller's: `localDateIso()` in the page, so the day is
 * the cashier's own calendar day and not a clock the command read.
 *
 * `null` for an empty basket rather than a commit with no lines: `.min(1)` on
 * the schema would refuse it, and the register disables finishing anyway.
 */
export function saleCommitFromCart(args: {
  saleId: string;
  session: Pick<PosTillSessionDto, 'warehouse_id'>;
  cart: Pick<PosCartDto, 'lines'>;
  documentDate: string;
  /** See `merchantVariantOf`. The products the type-ahead reported as having no merchant variants. */
  simpleProducts: ReadonlySet<string>;
}): PosSaleCommitRequestDto | null {
  if (args.cart.lines.length === 0) return null;
  return {
    saleId: args.saleId,
    settlementMode: 'cash',
    customerId: null,
    warehouseId: args.session.warehouse_id,
    documentDate: args.documentDate,
    dueDate: null,
    taxMinor: POS_SALE_TAX_MINOR,
    notes: null,
    lines: args.cart.lines.map((line) => ({
      lineId: line.cartLineId,
      productId: line.productId,
      variantId: merchantVariantOf(line, args.simpleProducts),
      quantity: line.quantity,
      discountMinor: line.discountMinor,
    })),
  };
}

/**
 * THE MERCHANT VARIANT OF A CART LINE, OR `null` — the one translation the
 * cart's lines need before they are a sale's lines.
 *
 * ## The defect this exists for, measured on the browser gate
 *
 * `pos_cart_lines.variant_id` is `UUID NOT NULL` (`0079`), so a line that
 * names no variant is stored as the product's HIDDEN BASE variant, which the
 * gate statement resolves server-side (`pos-cart-statements.ts:440-449`). The
 * cart's projection then reports that stored id as `CartDto.lines[].variantId`
 * unchanged — so for a SIMPLE product the base variant id leaves the server,
 * which is what `P3-AL-52` says never happens.
 *
 * `SaleCommitSchema` is written on the assumption that it does not:
 * `resolveVariants` (`inventory-stock-read.ts:98`) accepts a merchant variant
 * (`variant_id === wanted && !is_base`) or `null`, and refuses a BASE id with
 * `inventory.variant_not_found`. Measured: the register committed a cart line
 * for a simple product verbatim and the sale was refused 404 in all three
 * locales at all three viewports, with the cashier told "we couldn't find that
 * option of the product" about a product that has no options.
 *
 * So the cart's lines are NOT directly committable, and the server offers no
 * flag that says which ids are base ones. This is an API defect and the fix
 * belongs there — the cart should report `null` for a product with no merchant
 * variants, exactly as `PosProductHitDto` already does.
 *
 * ## What the client can honestly know, and nothing more
 *
 * Whether a product HAS merchant variants is a fact the type-ahead already
 * states: `PosProductHitDto.variantId` is `null` for a simple product
 * (`packages/shared-contracts/src/pos.ts`, "the base variant is never named
 * outside the server"). The register collects those product ids from the hits
 * it has seen and passes them here. So the client is not GUESSING which id is
 * a base variant: it is reporting, per product, an answer the server gave it.
 *
 * A product the register has seen no hit for is passed through unchanged. That
 * is the honest default: the only way to reach it is a cart line this screen
 * did not add, which today means a cart read that is not wired, and the
 * outcome is the server's own renderable refusal rather than a silent `null`
 * that would sell a variant nobody chose.
 */
export function merchantVariantOf(line: Pick<PosCartLineDto, 'productId' | 'variantId'>, simpleProducts: ReadonlySet<string>): string | null {
  return simpleProducts.has(line.productId) ? null : line.variantId;
}
