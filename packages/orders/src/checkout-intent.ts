/**
 * The order → canonical sale hand-off — Phase 6 (`PREPARED / NOT PROMOTED`).
 *
 * ## What this module is
 *
 * An ecommerce order becomes real money and real stock at exactly one moment:
 * the atomic sale commit (`POST /v1/sales`, Phase 4 S2). This module builds the
 * REQUEST for that commit out of an order, and it is the only place in Phase 6
 * that is allowed to know the sale command's shape.
 *
 * It computes no money. The intent carries identities, quantities, a discount
 * REQUEST and dates, which is precisely the field list the sales authority
 * accepts, and `SALE_FORBIDDEN_INTENT_FIELDS` below is the enumerated list of
 * what it must never carry. The sales request schema is `.strict()`, so a
 * forbidden key is an unknown-key refusal on arrival — but a refusal at the
 * boundary is a late place to learn that Phase 6 grew a total, so the same law
 * is executed HERE, over the object actually built, by
 * `assertNoForbiddenIntentFields`. That check is not a comment about a rule: it
 * reads the keys of the value it is handed.
 *
 * ## The shape is a SNAPSHOT, not an import
 *
 * `SaleCommitIntent` mirrors `SaleCommitDto` as it stood on
 * `phase/4-sales-pos-customers-receivables` at `93084f8`, read as a snapshot
 * (master directive PART 55, `SHADOW INTEGRATION ONLY`). It is declared here
 * rather than imported because Phase 4 is NOT SEALED: importing an unsealed
 * contract would make this package's green depend on a tree that is still
 * moving, and would quietly claim an integration nobody has accepted. At
 * promotion the declaration is DELETED and `SaleCommitDto` is imported — and
 * `P6-CONTRACT-BINDING.md` records that as the first integration step, so the
 * duplicate cannot survive as a second contract.
 *
 * ## One saleId per order, stated once
 *
 * `saleId` is an INPUT, and it must be the id stored on the order rather than
 * one minted per attempt. The sale commit is idempotent on `saleId` plus the
 * stored intent fingerprint (P4-AL-30); an order that minted a fresh id on
 * every retry would turn one network timeout into two sales, two sets of stock
 * movements and two receivables. So the id is supplied, it is validated, and
 * nothing in this module can generate one.
 */
import type { BasketPosition } from './cart';
import { requireSettlementTruth, type OrderSettlementEvidence, type OrderSettlementMode } from './settlement';
import { OrderError, assertCanonicalId } from './errors';
import { isCanonicalCivilDate } from './instant';
import { MAX_UNIT_DECIMALS, assertCommitWithinConfirmedQuote, assertQuoteApproved, type ConfirmedQuoteApproval } from './quote';
import { SALE_BOUND_ORDER_STATES, type OrderSnapshot } from './state';

/** One line of the sale commit intent. Mirrors `SaleCommitLineDto` at `93084f8`. */
export interface SaleCommitIntentLine {
  lineId: string;
  productId: string;
  variantId: string | null;
  quantity: string;
  /** Integer minor units of the sale's currency, `>= 0`. A REQUEST, granted only under `sales.discount`. */
  discountMinor: string;
}

/** The sale commit intent. Mirrors `SaleCommitDto` at `93084f8`. */
export interface SaleCommitIntent {
  saleId: string;
  settlementMode: OrderSettlementMode;
  customerId: string | null;
  warehouseId: string;
  documentDate: string;
  dueDate: string | null;
  /** `"0"` while sales tax is a structural zero (master directive PART 14). */
  taxMinor: string;
  notes: string | null;
  lines: SaleCommitIntentLine[];
}

/**
 * The fields the sales authority forbids a caller to state, on the header or on
 * a line. Every one of them is a figure the server computes: adopting a
 * client's version of it is what "validation implies the client's number could
 * be adopted" means.
 *
 * `taxMinor` is deliberately absent — it IS part of the command, with `"0"` as
 * its only admitted value — and so is a line's `discountMinor`, which is a
 * request rather than a computed amount.
 */
export const SALE_FORBIDDEN_INTENT_FIELDS: readonly string[] = Object.freeze([
  'unitPriceMinor',
  'unitPriceTxnMinor',
  'unitPriceBaseMinor',
  'lineTotalMinor',
  'grossMinor',
  'grossTxnMinor',
  'netMinor',
  'netTxnMinor',
  'subtotalMinor',
  'subtotalTxnMinor',
  'totalMinor',
  'totalTxnMinor',
  'totalBaseMinor',
  'discountTotalMinor',
  'taxRate',
  'taxPercent',
  'taxBaseMinor',
  'cogsMinor',
  'unitCostMinor',
  'currency',
  'txnCurrency',
  'baseCurrency',
  'fxRate',
  'fxRateSource',
  'fxRateAt',
  'branchId',
  'onHand',
  'stockLevel',
  'settlementState',
  'paidMinor',
  'outstandingMinor',
  'invoiceNumber',
  'journalEntryId',
]);

/**
 * Refuse any forbidden key present on the intent or any of its lines.
 *
 * It walks the VALUE's own keys, so it detects a field a future author adds to
 * the builder — which a type-level check cannot, because the author would add
 * the field to the type in the same commit.
 */
export function assertNoForbiddenIntentFields(intent: object): void {
  const forbidden = new Set(SALE_FORBIDDEN_INTENT_FIELDS);
  const walk = (value: object, where: string): void => {
    for (const key of Object.keys(value)) {
      if (forbidden.has(key)) {
        throw new OrderError('order.checkout_field_forbidden', 'the checkout intent states a figure the sales authority computes', { field: key, where });
      }
    }
  };
  walk(intent, 'header');
  const lines = (intent as { lines?: unknown }).lines;
  if (Array.isArray(lines)) {
    lines.forEach((line, index) => {
      if (line !== null && typeof line === 'object') walk(line as object, `lines[${index}]`);
    });
  }
}

/** Non-negative integer minor units as a decimal string. No arithmetic — a shape check, so a float or a sign cannot pass. */
const NON_NEGATIVE_MINOR = /^(0|[1-9]\d*)$/;

/**
 * The sales authority's own LINE LIMIT, mirrored from
 * `packages/domain-core/src/sale.ts:150` (`MAX_SALE_LINES = 200`) at `93084f8`.
 *
 * It is here because the mirror had copied the command's SHAPE and not its
 * CONSTRAINTS, so Phase 6 built requests the authority would refuse — a 5000
 * character note and an unbounded line count were both measured. A refusal at
 * the boundary is a late place to learn that, and an order that reaches the
 * commit and is rejected there has already consumed an idempotency attempt.
 *
 * Like the shape, the constant is DELETED at promotion and imported from the
 * sealed contract; `P6-CONTRACT-BINDING.md` carries that as a step, and the
 * manifest carries the blocker that `main` at `6fc505d` holds no sales contract
 * at all, so nothing on this branch can compare the mirror to its source.
 */
export const SALE_MIRROR_MAX_LINES = 200;

/** The authority's `notes` bounds, mirrored the same way: 1..1000 characters AFTER trimming, or null. */
export const SALE_MIRROR_NOTES_MAX_LENGTH = 1000;

/** What the order states about its own checkout. Every field is the merchant's or the shopper's, none is a clock's. */
export interface OrderCheckoutFacts {
  /** The order being checked out. It is what the confirmed quote must belong to. */
  orderId: string;
  /** The id stored ON THE ORDER, not minted per attempt. */
  saleId: string;
  /**
   * The quote the shopper confirmed, the confirmation itself, and the instant of
   * the attempt — REQUIRED (`TL-P6-R?`, audited §27).
   *
   * It is required rather than optional because an optional defence is not one:
   * the independent challenger measured that the whole quote module was called
   * by nothing on the path to a sale, so §27's purpose (the catalogue edit
   * between placement and commit), PART 33's zero tolerance and PART 34's
   * half-open boundary were implemented, tested, and guarding nothing. Every
   * line of the intent below is now checked against what the shopper agreed to:
   * the positions, their quantities and — the case the challenger built — the
   * discount, which was previously free for any caller to state.
   */
  quoteApproval: ConfirmedQuoteApproval;
  /**
   * What the merchant CLAIMS the settlement is. It is a claim, not a fact: the
   * evidence below decides whether it may be committed under, and a mismatch is
   * refused rather than silently corrected.
   */
  settlementMode: OrderSettlementMode;
  /**
   * The fact that makes `settlementMode` TRUE (`TL-P6-R2`, §25).
   *
   * REQUIRED, and there is no variant meaning "pending". A shopper clicking
   * Place Order produces an order, not money: cash on delivery not yet
   * collected, an unpaid order and a payment still pending are all unpaid, and
   * committing any of them as a `cash` sale would post cash the business never
   * received. When settlement is not yet true the answer is to not build a
   * checkout at all, which is why the absence of a `pending` value is the law
   * rather than an omission.
   */
  settlementEvidence: OrderSettlementEvidence;
  customerId: string | null;
  /** The warehouse the stock leaves. Its home branch is the sale's branch, resolved by the server. */
  warehouseId: string;
  /** `YYYY-MM-DD` civil date in the business's timezone. */
  documentDate: string;
  /** `YYYY-MM-DD`, on or after `documentDate`, or `null` for no credit term. */
  dueDate: string | null;
  /**
   * Integer minor units of sales tax, STATED by the caller. The only admitted
   * value is `"0"` while sales tax is a structural zero (master directive
   * PART 14, P4-AL-44), and a non-zero value is REFUSED rather than normalized
   * to zero: normalizing it would charge the customer a figure nobody agreed.
   *
   * It is an input rather than a constant this module writes, because a
   * constant it wrote would make the check below compare the module to itself
   * and pass for every caller — a guard with no subject.
   */
  taxMinor: string;
  notes: string | null;
  /** Stock key → merchant-granted discount request, integer minor units. Absent means `"0"`. */
  discountMinorByStockKey?: ReadonlyMap<string, string>;
}

/**
 * Build the sale commit intent for an order.
 *
 * The order must be `accepted` or `fulfilling`: before acceptance there is
 * nothing to commit, after the sale there already is one, and a terminal order
 * has none coming. `order.checkout_state_invalid` says which.
 *
 * And the settlement must be TRUE, not merely claimed: `requireSettlementTruth`
 * runs before any figure is assembled, so an unpaid order cannot reach the point
 * of producing a `cash` sale request at all (§25, `TL-P6-R2`).
 */
export function buildSaleCommitIntent(snapshot: OrderSnapshot, positions: readonly BasketPosition[], facts: OrderCheckoutFacts): SaleCommitIntent {
  if (snapshot.saleId !== null || SALE_BOUND_ORDER_STATES.includes(snapshot.state)) {
    throw new OrderError('order.checkout_state_invalid', 'the order is already bound to a canonical sale', { state: snapshot.state });
  }
  if (snapshot.state !== 'accepted' && snapshot.state !== 'fulfilling') {
    throw new OrderError('order.checkout_state_invalid', 'a checkout is built from an accepted or fulfilling order', { state: snapshot.state });
  }
  // Cash collected AT HANDOVER is a fact about a handover, so it is admitted
  // only while the order is being fulfilled. Nothing in this package can verify
  // that cash was collected — that is accepted, and stated — but the structural
  // narrowing that IS available was previously not taken: an order in
  // `accepted`, where no handover has begun, produced `settlementMode: 'cash'`.
  // The §25 law was carried by the evidence variant's NAME and by the caller's
  // honesty; now the topology carries as much of it as the topology can.
  if (facts.settlementEvidence.kind === 'cash_collected_on_handover' && snapshot.state !== 'fulfilling') {
    throw new OrderError('order.checkout_state_invalid', 'cash collected at handover is admissible only while the order is fulfilling', {
      state: snapshot.state,
      evidenceKind: facts.settlementEvidence.kind,
    });
  }
  if (positions.length === 0) {
    throw new OrderError('order.cart_empty', 'a checkout carries at least one position');
  }
  if (positions.length > SALE_MIRROR_MAX_LINES) {
    throw new OrderError('order.checkout_line_limit', 'the checkout carries more lines than the sales authority accepts', {
      lines: String(positions.length),
      maxLines: String(SALE_MIRROR_MAX_LINES),
    });
  }

  assertCanonicalId(facts.orderId, 'orderId');
  assertCanonicalId(facts.saleId, 'saleId');
  assertCanonicalId(facts.warehouseId, 'warehouseId');
  if (facts.customerId !== null) assertCanonicalId(facts.customerId, 'customerId');

  if (!isCanonicalCivilDate(facts.documentDate)) {
    throw new OrderError('order.checkout_date_invalid', 'documentDate must be a YYYY-MM-DD civil date that names a real day');
  }
  if (facts.dueDate !== null) {
    if (!isCanonicalCivilDate(facts.dueDate)) {
      throw new OrderError('order.checkout_date_invalid', 'dueDate must be a YYYY-MM-DD civil date that names a real day');
    }
    if (facts.dueDate < facts.documentDate) {
      throw new OrderError('order.checkout_date_invalid', 'dueDate falls on or after documentDate');
    }
  }

  // The settlement-truth gate, BEFORE any figure is assembled. It establishes
  // the mode from the evidence rather than taking the claim on trust, and it
  // carries the credit laws: canonical credit needs a NAMED customer and an
  // authorizing merchant user, a guest is never AR, and no customer row is
  // invented to satisfy the mechanics (`TL-P6-R3`, `TL-P6-R4`).
  //
  // Phase 4's `invoices_walkin_no_ar` trigger and `invoices_walkin_terms_ck`
  // refuse an anonymous receivable physically; refusing it here means the order
  // never builds a request the database would have to reject.
  const settlement = requireSettlementTruth(facts.settlementMode, facts.settlementEvidence, facts.customerId);

  if (facts.dueDate !== null && (facts.customerId === null || settlement.mode !== 'credit')) {
    throw new OrderError('order.checkout_customer_required', 'a due date requires a credit checkout with a named customer');
  }

  if (facts.notes !== null) {
    // The authority's bound, checked on the TRIMMED text, because that is the
    // text it checks: a note of 1000 spaces is not a note.
    const trimmed = facts.notes.trim();
    if (trimmed.length === 0 || trimmed.length > SALE_MIRROR_NOTES_MAX_LENGTH) {
      throw new OrderError('order.checkout_notes_invalid', 'notes must be 1 to 1000 characters after trimming, or null', {
        trimmedLength: String(trimmed.length),
        maxLength: String(SALE_MIRROR_NOTES_MAX_LENGTH),
      });
    }
  }

  if (facts.taxMinor !== '0') {
    throw new OrderError('order.checkout_tax_policy_absent', 'sales tax is a structural zero; a non-zero tax is refused, never normalized', {
      stated: facts.taxMinor,
    });
  }

  // THE QUOTE GATE. Before any line is assembled: the quote is intact, it is
  // this order's, the confirmation agrees with it field for field, and the
  // window is still open at `asOf` (half-open, so `asOf === expiresAt` is
  // expired). A second attempt that carries the authority's previously
  // recomputed total is refused HERE under PART 33's zero tolerance, rather
  // than rebuilding an intent for a total the shopper never agreed to.
  const approval = facts.quoteApproval;
  // The precision map is BUILT FROM THE POSITIONS, not accepted beside them.
  // It used to be an optional field on the facts, which left two holes that
  // documentation cannot close: a caller could omit it, and the gate's
  // representability law would then be silently not claimed; or a caller could
  // supply a DIFFERENT map from the one `summariseBasket` checked, and the law
  // would be claimed against a precision no product declared. Reading it off
  // `positions` removes both — `summariseBasket` demands a precision per stock
  // key and records the one it used, so the gate's map IS the basket's map by
  // construction, and there is no second place for it to come from.
  //
  // Read off the POSITIONS and the FACTS only, never off `approval`, which may
  // be absent: the runtime presence guard lives inside `assertQuoteApproved`,
  // and reading a property of the thing being checked before it is checked is
  // how a refusal becomes a TypeError.
  const unitDecimalsByStockKey = new Map<string, number>();
  for (const position of positions) {
    // A type-only requirement has no runtime existence, and this one decides
    // whether a law is claimed at all: a hand-built position whose precision is
    // missing would produce a map that answers `undefined` for its key, and the
    // representability check would then skip that line in silence.
    if (typeof position.unitDecimals !== 'number') {
      throw new OrderError('order.checkout_field_forbidden', 'a checkout position carries no unit precision', { stockKey: position.stockKey });
    }
    // And it is a precision, not merely a number. `NaN`, `-1`, `2.5` and `10`
    // are all refused HERE, under a code that names the caller's figure. The
    // inventory authority does refuse every one of them one layer in — the
    // round-5 Challenger measured that and published five cases proving it
    // fails closed — but it refuses them while the client is being told the
    // SHOPPER's quantity is wrong. The subject of the refusal matters.
    if (!Number.isInteger(position.unitDecimals) || position.unitDecimals < 0 || position.unitDecimals > MAX_UNIT_DECIMALS) {
      throw new OrderError('order.unit_precision_invalid', 'a checkout position states a unit precision that is not an integer from 0 to 4', {
        stockKey: position.stockKey,
        stated: String(position.unitDecimals),
      });
    }
    unitDecimalsByStockKey.set(position.stockKey, position.unitDecimals);
  }
  assertQuoteApproved(approval, facts.orderId, { unitDecimalsByStockKey });
  if (approval.priorRecomputedTotalMinor !== undefined) {
    assertCommitWithinConfirmedQuote(approval, facts.orderId, approval.priorRecomputedTotalMinor);
  }

  // The confirmed quote prices exactly the positions being committed. Set
  // equality in both directions: a position the quote never priced is a line
  // the shopper never saw, and a quoted line that is not being committed means
  // the basket changed after confirmation.
  const quotedByStockKey = new Map(approval.quote.lines.map((line) => [line.stockKey, line] as const));
  if (quotedByStockKey.size !== positions.length) {
    throw new OrderError('order.quote_not_approved', 'the confirmed quote prices a different set of positions than the checkout carries', {
      quotedLines: String(quotedByStockKey.size),
      positions: String(positions.length),
    });
  }

  const discounts = facts.discountMinorByStockKey;
  if (discounts !== undefined) {
    const known = new Set(positions.map((p) => p.stockKey));
    for (const stockKey of discounts.keys()) {
      if (!known.has(stockKey)) {
        throw new OrderError('order.availability_subject_unknown', 'a discount was stated for a stock key the checkout does not carry', { stockKey });
      }
    }
  }

  const lines: SaleCommitIntentLine[] = positions.map((position) => {
    const requested = discounts?.get(position.stockKey) ?? '0';
    if (!NON_NEGATIVE_MINOR.test(requested)) {
      throw new OrderError('order.checkout_field_forbidden', 'a discount request must be non-negative integer minor units as a string', {
        stockKey: position.stockKey,
      });
    }

    const quoted = quotedByStockKey.get(position.stockKey);
    if (quoted === undefined) {
      throw new OrderError('order.quote_not_approved', 'the checkout carries a position the confirmed quote does not price', {
        stockKey: position.stockKey,
      });
    }
    // String equality, not re-parsing: both sides are written by
    // `formatQuantity`, and the quote relation now refuses any other spelling.
    if (quoted.quantity !== position.totalQuantity) {
      throw new OrderError('order.quote_not_approved', 'the checkout quantity is not the quantity the shopper confirmed', {
        stockKey: position.stockKey,
        confirmed: quoted.quantity,
        checkout: position.totalQuantity,
      });
    }
    // The discount must be the one the quote GRANTED. This is the case the
    // independent challenger built: a discount of 999999999 minor units on a
    // position no quote ever authorised used to build without complaint,
    // because the request was the caller's to state and nothing compared it to
    // what the shopper was shown.
    if (requested !== quoted.discountMinor) {
      throw new OrderError('order.quote_discount_unapproved', 'the discount request is not the discount the confirmed quote granted', {
        stockKey: position.stockKey,
        granted: quoted.discountMinor,
        requested,
      });
    }

    return {
      lineId: position.representativeLineId,
      productId: position.productId,
      variantId: position.variantId,
      quantity: position.totalQuantity,
      discountMinor: requested,
    };
  });

  const intent: SaleCommitIntent = {
    saleId: facts.saleId,
    // The ESTABLISHED mode, not the claimed one. They are equal by now — the
    // gate refuses them otherwise — and carrying the established value is what
    // makes that structural instead of a convention.
    settlementMode: settlement.mode,
    customerId: facts.customerId,
    warehouseId: facts.warehouseId,
    documentDate: facts.documentDate,
    dueDate: facts.dueDate,
    // The caller's own value, which the refusal above has already proven to be
    // `"0"`. Carried through rather than rewritten, so the intent reports what
    // was stated and no layer can disagree about what was agreed.
    taxMinor: facts.taxMinor,
    notes: facts.notes,
    lines,
  };

  assertNoForbiddenIntentFields(intent);
  return intent;
}
