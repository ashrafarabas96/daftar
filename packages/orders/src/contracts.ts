/**
 * The Phase 6 ORDER API contracts — `PREPARED / NOT PROMOTED`.
 *
 * ## Why these live here and not in `@daftar/shared-contracts`
 *
 * `packages/shared-contracts` has one writer, and it is not this thread
 * (standing law PART E §4: never modify a file outside your phase prefix; hand
 * the change to the owner). So the DTOs are authored inside the Phase 6
 * package, and `P6-INTEGRATION-PATCH-REQUEST.md` asks the contract owner to
 * move this file to `packages/shared-contracts/src/orders.ts` and add its
 * re-export at promotion. The move is mechanical: nothing below imports
 * anything the contract package cannot see.
 *
 * ## The conventions, each with the reason the repository already states
 *
 * - **Money is an integer count of minor units carried as a STRING**, and this
 *   file carries almost none, because an order holds almost no money. Where an
 *   amount appears it is one the SALES authority computed and the order is
 *   REPORTING, never one Phase 6 derived;
 * - **quantities are decimal strings** at the product's unit precision, never
 *   JSON numbers;
 * - **every list is an object with `items`**, never a bare array: a top-level
 *   array can never gain a field without breaking every client;
 * - **`variantId` is `null` for a simple product** — the hidden base variant
 *   never leaves the server (P3-AL-52);
 * - **every date and instant is an explicit input.** No field here has a
 *   server-clock default, so one retry is one command forever;
 * - **no response carries** a journal entry id, an account code, a routine
 *   name, a constraint name or a database message (P4-AL-54).
 */

/** The channels an order can originate from. */
export type OrderChannelDto = 'storefront' | 'pos' | 'admin' | 'marketplace';

/** Mirrors `OrderState`. A client renders this; it never computes it. */
export type OrderStateDto = 'placed' | 'accepted' | 'rejected' | 'cancelled' | 'fulfilling' | 'fulfilled' | 'completed';

/** Mirrors `OrderSettlementMode`. */
export type OrderSettlementModeDto = 'cash' | 'credit';

/**
 * Mirrors the evidence kinds of `OrderSettlementEvidence`.
 *
 * **There is no `pending` and no `cash_on_delivery_uncollected`, and that is the
 * law rather than an omission** (§25). Placing an order is not proof that money
 * changed hands, so when settlement is not yet true the answer is that the sale
 * is not committed — not that it is committed under a mode that describes
 * nothing.
 *
 * `payment_verified` is declared and REFUSED: no merchant payment provider is
 * integrated, Phase 5's SaaS-platform provider is not the merchant's payment
 * authority (§31), and online payment is `WAITING_FOR_INTEGRATED_SURFACE` with
 * no simulated cash substitute.
 */
export type OrderSettlementEvidenceKindDto = 'cash_collected_on_handover' | 'payment_verified' | 'authorized_customer_credit';

// ── The basket ────────────────────────────────────────────────────────────

/**
 * `POST /v1/orders/baskets/:basketId/lines` — append one row.
 *
 * There is no `PATCH` and no `PUT` on a row: the basket is append-only, exactly
 * as the POS basket is, and a quantity change is a new row. `lineId` is the
 * CLIENT's, because it becomes the sale line's `lineId` and a server-minted one
 * would make two identical requests two different commands.
 *
 * The body states an identity and a quantity. It states no price, so there is
 * nothing for a client to disagree with the server about.
 */
export interface OrderBasketLineAppendDto {
  lineId: string;
  productId: string;
  variantId: string | null;
  quantity: string;
}

/** One merged basket position as the read reports it. */
export interface OrderBasketPositionDto {
  productId: string;
  variantId: string | null;
  /** The product's name in the requested locale, then `ar`, then any (the Phase 1 fallback). */
  nameSnapshot: string;
  /** The SUM of the rows of this stock key. */
  totalQuantity: string;
  /** Every row that contributed, in the order they were appended. */
  lineIds: string[];
  /**
   * The CATALOGUE price of one unit, minor units as a string — shown so a
   * shopper can see a figure, and NOT authoritative. What the line costs is the
   * server's own recomputation at sale time (P4-AL-18).
   */
  unitPriceMinor: string;
  currency: string;
  /**
   * ADVISORY availability. `not_tracked` for a product with no stock row — `0`
   * would read as "out of stock" and refuse a sale that is fine.
   */
  availability: 'sufficient' | 'insufficient' | 'not_tracked';
  /** Positive decimal string when `insufficient`, else `null`. */
  shortfallQuantity: string | null;
}

/**
 * `GET /v1/orders/baskets/:basketId`
 *
 * **There is no total on this response.** Not a subtotal, not a grand total, not
 * a tax figure and not a discount total. A basket total would be a second
 * stored-or-computed number for the same money with a second writer and nothing
 * tying it to the sale's, and the shopper's authoritative figure arrives with
 * the committed sale. `availabilityAdvisory` is a literal `true` so a client
 * that renders a stock figure carries the caveat into its own code.
 */
export interface OrderBasketDto {
  basketId: string;
  channel: OrderChannelDto;
  items: OrderBasketPositionDto[];
  readonly availabilityAdvisory: true;
  /** `true` when at least one position is `insufficient`. Advice; the sale commit is the authority. */
  anyInsufficient: boolean;
}

// ── Placing an order ──────────────────────────────────────────────────────

/**
 * `POST /v1/orders` — turn a basket into an order.
 *
 * `orderId` is the caller's, and it is the replay key. `saleId` is ALSO the
 * caller's and is stored on the order at placement rather than minted at
 * checkout: the sale commit is idempotent on `saleId` plus its stored intent
 * fingerprint (P4-AL-30), so an order that minted a fresh id per attempt would
 * turn one network timeout into two sales, two sets of stock movements and two
 * receivables.
 *
 * `placedAt` is the client's stated instant, and `documentDate` the civil date
 * the sale and the invoice will carry. Neither is defaulted from a clock, at
 * any layer.
 */
export interface OrderPlaceDto {
  orderId: string;
  basketId: string;
  /** The sale this order will commit as, stated ONCE, here. */
  saleId: string;
  channel: OrderChannelDto;
  /**
   * How the merchant or shopper INTENDS to settle. It binds nothing and settles
   * nothing (§25): a canonical sale is committed under the mode its evidence
   * establishes at the `record_sale` moment, and an order placed with an
   * intention of `cash` whose cash is never collected never becomes a cash sale.
   */
  intendedSettlementMode: OrderSettlementModeDto;
  /** `null` is a guest order. A guest order is never a receivable (`TL-P6-R4`). */
  customerId: string | null;
  /** The warehouse the stock will leave. */
  warehouseId: string;
  /** `YYYY-MM-DD` civil date in the business's timezone. Never in the future. */
  documentDate: string;
  /** `YYYY-MM-DD` on or after `documentDate`, or `null`. Non-null requires a credit order with a customer. */
  dueDate: string | null;
  /** RFC3339 UTC at second precision — the `occurredAt` of the `place` transition. */
  placedAt: string;
  /** Integer minor units. `"0"` is the only admitted value; a non-zero value is refused, never normalized. */
  taxMinor: string;
  notes: string | null;
}

/**
 * `POST /v1/orders/:orderId/transitions` — record one lifecycle transition.
 *
 * One route for every transition, because they are one kind of fact. There is
 * no `POST /orders/:id/cancel` beside a `POST /orders/:id/accept`: a per-verb
 * route set invites a verb whose guard was written separately from the others,
 * and the guard is the state machine.
 *
 * `saleId` is REQUIRED for `record_sale` and FORBIDDEN for every other kind.
 * Note what `record_sale` is: the order REPORTING that the canonical sale
 * committed. It does not perform the sale, and recording it on an order whose
 * sale did not commit is the one lie this contract cannot detect — which is why
 * channel reconciliation exists.
 */
export interface OrderTransitionRequestDto {
  transitionId: string;
  kind: 'accept' | 'reject' | 'cancel' | 'start_fulfilment' | 'record_sale' | 'complete';
  /** RFC3339 UTC at second precision, stated by the caller. */
  occurredAt: string;
  saleId: string | null;
  /**
   * REQUIRED for `record_sale` and FORBIDDEN for every other kind: the fact that
   * makes the settlement true at the moment the sale is committed
   * (`TL-P6-R2`). `authorizedByUserId` / `collectedByUserId` is the human behind
   * it, and `providerRef` belongs to the kind this surface refuses.
   */
  settlementEvidence: { kind: OrderSettlementEvidenceKindDto; actorUserId: string | null; providerRef: string | null } | null;
  /** The quote version the shopper confirmed — REQUIRED for `record_sale` (§27). */
  confirmedQuoteVersion: number | null;
  /** 1..500 characters after trimming for `reject` and `cancel`; a refusal nobody explained cannot be reviewed. */
  reason: string | null;
}

// ── The commercial quote snapshot (section 27) ────────────────────────────

/** One priced line as the shopper saw it. Carried verbatim from the pricing authority. */
export interface OrderQuoteLineDto {
  productId: string;
  variantId: string | null;
  quantity: string;
  unitPriceMinor: string;
  discountMinor: string;
  lineTotalMinor: string;
}

/**
 * `GET /v1/orders/:orderId/quote` — the immutable snapshot of what the shopper
 * was shown.
 *
 * **This is not a ledger, not AR and not settlement**, and it is served from its
 * own relation for that reason. No posting reads it, no stock movement reads it,
 * and it is never the canonical amount: the sale command recomputes the truth,
 * and where the recomputation diverges beyond the merchant's policy the
 * automatic commit is refused and the shopper is asked again.
 *
 * `digest` makes the immutability checkable rather than promised. A quote edited
 * in place fails its own digest.
 */
export interface OrderQuoteDto {
  quoteId: string;
  orderId: string;
  /** 1-based. A re-quote is a new version with a new id; nothing is edited in place. */
  version: number;
  currency: string;
  items: OrderQuoteLineDto[];
  /** The exact sum of the line totals, checked at issue. */
  displayedTotalMinor: string;
  issuedAt: string;
  expiresAt: string | null;
  /** Lowercase hex sha256 over the canonical serialization. */
  digest: string;
}

/**
 * What a checkout answers when the recomputed commercial amount diverges from
 * the confirmed quote beyond policy: the commit did NOT happen, and these are
 * the two figures the shopper must be shown before they agree again.
 */
export interface OrderQuoteReconfirmationRequiredDto {
  orderId: string;
  quoteId: string;
  quotedTotalMinor: string;
  recomputedTotalMinor: string;
  differenceMinor: string;
  /** Always `false` here — stated, so no client reads this response as a success. */
  readonly committed: false;
}

/** One transition as the read reports it. */
export interface OrderTransitionDto {
  transitionId: string;
  kind: string;
  occurredAt: string;
  /** RFC3339 UTC — when the row was written, which is NOT when the fact happened. */
  recordedAt: string;
  actorKind: 'user' | 'system' | 'customer';
  actorUserId: string | null;
  reason: string | null;
}

/**
 * One order, as `GET /v1/orders/:orderId` returns it.
 *
 * `saleId` is the whole of the financial link. There is no `totalMinor`, no
 * `paidMinor`, no `outstandingMinor` and no `settlementState` on an order: those
 * are the sales and receivables authorities' figures, read from THEIR endpoints
 * against `saleId`. Copying them here would create a second place for each of
 * them to be stale, and the project has one rule about that.
 */
export interface OrderDto {
  orderId: string;
  /** The human-facing document number, allocated by the database at placement. */
  orderNumber: string;
  channel: OrderChannelDto;
  state: OrderStateDto;
  /** The INTENTION stated at placement. Settles nothing — see `OrderPlaceDto`. */
  intendedSettlementMode: OrderSettlementModeDto;
  /**
   * The mode the canonical sale was actually committed under, established from
   * evidence. `null` until the sale exists, and it may legitimately differ from
   * the intention.
   */
  settledMode: OrderSettlementModeDto | null;
  customerId: string | null;
  warehouseId: string;
  documentDate: string;
  dueDate: string | null;
  /** The canonical sale, once one exists. The ONLY financial link an order carries. */
  saleId: string | null;
  /** The current quote. An order always has one; a re-quote replaces it with a new version. */
  quote: OrderQuoteDto | null;
  notes: string | null;
  /** `true` when an identical request returned the existing order. */
  replayed: boolean;
  items: OrderBasketPositionDto[];
  /** Oldest first. The log is the truth; `state` above is its fold. */
  transitions: OrderTransitionDto[];
}

/** One row of the order list. */
export interface OrderListItemDto {
  orderId: string;
  orderNumber: string;
  channel: OrderChannelDto;
  state: OrderStateDto;
  documentDate: string;
  customerId: string | null;
  saleId: string | null;
  lineCount: number;
}

/** `GET /v1/orders` — keyset cursor, never an offset (G-6). */
export interface OrderListDto {
  items: OrderListItemDto[];
  nextCursor: string | null;
}

// ── Channel reconciliation ────────────────────────────────────────────────

/** Mirrors `ReconciliationFindingCode`. */
export type OrderReconciliationFindingCodeDto =
  | 'order_without_sale'
  | 'order_binding_missing'
  | 'binding_without_state'
  | 'sale_without_order'
  | 'order_sale_mismatch'
  | 'sale_shared_by_orders';

export interface OrderReconciliationFindingDto {
  code: OrderReconciliationFindingCodeDto;
  orderId: string | null;
  saleId: string | null;
  counterpartId: string | null;
}

/**
 * `GET /v1/orders/reconciliation?from=&to=`
 *
 * It reports and never repairs: a reconciliation that corrected what it found
 * would destroy the evidence that something was wrong.
 *
 * `comparesAmounts` is a literal `false`, stated rather than left to a reader's
 * assumption. This report answers "did every sold order reach the ledger
 * exactly once" and nothing about whether the amounts are right — that is the
 * sales reconciliation's question, and a client that showed this as a financial
 * all-clear would be overstating it.
 */
export interface OrderReconciliationReportDto {
  from: string;
  to: string;
  checkedOrders: number;
  checkedSales: number;
  /** Direct and POS sales, correctly out of Phase 6's scope. */
  salesWithoutChannelOrigin: number;
  readonly comparesAmounts: false;
  items: OrderReconciliationFindingDto[];
  isReconciled: boolean;
}

// ── Storefront reads ──────────────────────────────────────────────────────

/**
 * `GET /v1/storefront/:storeSlug/products` and `.../products/:handle` (the PDP).
 *
 * A storefront read is PUBLIC and must therefore state exactly what it exposes.
 * It carries no cost, no margin, no supplier, no on-hand figure and no internal
 * id a shopper has no business holding: a public catalogue read that leaked a
 * unit cost would publish the business's buying terms.
 *
 * `inStock` is a BOOLEAN rather than a quantity, and that is deliberate. A
 * public figure tells a competitor the business's stock position, and a shopper
 * does not need it; `null` means the product does not track stock.
 */
export interface StorefrontProductDto {
  productId: string;
  /** The URL segment — stable, lowercase, and not the id. */
  handle: string;
  name: string;
  description: string | null;
  unitPriceMinor: string;
  currency: string;
  /** `true`/`false` for a tracked product, `null` for one that tracks no stock. Never a quantity. */
  inStock: boolean | null;
  media: { url: string; width: number; height: number }[];
  variants: { variantId: string; attributes: Record<string, string>; unitPriceMinor: string | null; inStock: boolean | null }[];
}

/** `GET /v1/storefront/:storeSlug/products` */
export interface StorefrontProductListDto {
  items: StorefrontProductDto[];
  nextCursor: string | null;
}

/**
 * The enumerated order error codes a client may branch on, carried in
 * `details.orderCode` under the HTTP contract — one HTTP shape, with a
 * machine-readable reason underneath it that the server and the client share
 * word for word, exactly as `ACCOUNTING_REFUSED` carries `details.accountingCode`.
 */
export const ORDER_CLIENT_ERROR_CODES: readonly string[] = Object.freeze([
  'order.transition_not_allowed',
  'order.terminal_state',
  'order.cancel_after_sale',
  'order.sale_binding_conflict',
  'order.transition_conflict',
  'order.cart_empty',
  'order.cart_quantity_invalid',
  'order.checkout_customer_required',
  'order.checkout_tax_policy_absent',
  'order.settlement_mode_unsupported',
  'order.payment_surface_not_integrated',
  'order.quote_expired',
  'order.quote_version_stale',
  'order.checkout_date_invalid',
]);
