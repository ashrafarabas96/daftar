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

/** What the order states about its own checkout. Every field is the merchant's or the shopper's, none is a clock's. */
export interface OrderCheckoutFacts {
  /** The id stored ON THE ORDER, not minted per attempt. */
  saleId: string;
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
  if (positions.length === 0) {
    throw new OrderError('order.cart_empty', 'a checkout carries at least one position');
  }

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

  if (facts.taxMinor !== '0') {
    throw new OrderError('order.checkout_tax_policy_absent', 'sales tax is a structural zero; a non-zero tax is refused, never normalized', {
      stated: facts.taxMinor,
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
