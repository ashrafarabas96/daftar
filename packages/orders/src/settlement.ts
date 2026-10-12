/**
 * Settlement truth at the order → sale boundary — `TL-P6-R2`, `TL-P6-R3`,
 * `TL-P6-R4`, and the CRITICAL P6 CORRECTION of the audited master directive
 * (§25, §26, §28, §29, §31).
 *
 * ## The correction this file exists to enforce
 *
 * An earlier draft of this package said Phase 6 "sells at checkout". That
 * wording was ruled **too dangerous**, and the ruling is right:
 *
 * > **A public ecommerce order being placed is NOT proof that cash was
 * > received.** `place order` ≠ `cash-settled sale`.
 *
 * A shopper clicking Place Order produces an order. It does not produce money.
 * Cash on delivery that has not been collected, an unpaid order, a payment
 * still pending and a payment authorization still pending are all **unpaid**,
 * and committing any of them as a `cash` sale would post cash the business
 * never received and report an invoice as settled that nobody paid. That is a
 * false financial fact, written by the most ordinary click in ecommerce.
 *
 * So the settlement mode is no longer something a caller may simply assert. It
 * must be **earned** by a stated fact about the world, and this module is the
 * gate: `requireSettlementTruth` maps evidence to the only settlement mode that
 * evidence can honestly support, and refuses everything else.
 *
 * ## The three admissible facts, and why there is no fourth
 *
 * `TL-P6-R2` names the operational triggers exactly: verified payment; merchant
 * fulfilment or handover **with cash actually collected**; authorized
 * named-customer credit. There is no `pending`, no `cod_awaiting_collection`
 * and no `assume_paid` — not because they never happen, but because when they
 * happen the answer is **do not commit the sale yet**. An enumeration that
 * offered them would be an enumeration a caller could use to post a lie, and
 * the absence is the law.
 *
 * ## Why `payment_verified` is declared and then refused
 *
 * §31 is explicit: the Phase 5 SaaS-platform payment provider is NOT the
 * merchant's ecommerce payment authority — they are different commercial
 * domains — and until a dedicated merchant provider adapter exists, online
 * payment is `WAITING_FOR_INTEGRATED_SURFACE` with **no simulated "cash"
 * substitute**.
 *
 * So the variant is declared, so the law is visible in the type, and
 * `requireSettlementTruth` **refuses it** with
 * `order.payment_surface_not_integrated`. Phase 6 cannot verify a payment it
 * has no provider for, and a package that accepted the claim on the caller's
 * word would be exactly the simulated substitute the ruling forbids. When the
 * adapter arrives, the refusal is replaced by the adapter's own verification —
 * and `test/settlement.test.ts` names that as the change.
 */
import { OrderError, assertCanonicalId } from './errors';

/** The settlement mode a canonical sale may be committed under. Mirrors `SaleSettlementMode`. */
export type OrderSettlementMode = 'cash' | 'credit';

/**
 * A stated fact about the world that makes a settlement mode TRUE.
 *
 * Each variant carries WHO or WHAT establishes it, because an evidence kind
 * with no bearer is an assertion with nobody behind it.
 */
export type OrderSettlementEvidence =
  /**
   * Cash was physically collected at handover, by a named member of staff.
   * This is the honest cash-on-delivery path: the evidence is created when the
   * money changes hands, not when the order is placed.
   */
  | { kind: 'cash_collected_on_handover'; collectedByUserId: string }
  /**
   * A merchant payment provider verified the payment.
   * **Refused today** — see the module note and §31. There is no merchant
   * provider adapter, so nothing in Phase 6 can verify this claim.
   */
  | { kind: 'payment_verified'; providerRef: string }
  /**
   * A merchant user authorized canonical credit for a NAMED customer under an
   * explicit credit policy. `TL-P6-R3`: public storefront credit is OFF BY
   * DEFAULT, and this variant is the only thing that turns it on — per order,
   * with an authorizing human recorded.
   */
  | { kind: 'authorized_customer_credit'; authorizedByUserId: string };

/** Every evidence kind, as data, so a test can enumerate the subject set. */
export const ORDER_SETTLEMENT_EVIDENCE_KINDS: readonly string[] = Object.freeze([
  'cash_collected_on_handover',
  'payment_verified',
  'authorized_customer_credit',
]);

/**
 * The evidence kinds that are REACHABLE in Phase 6 as prepared. `payment_verified`
 * is deliberately absent: `WAITING_FOR_INTEGRATED_SURFACE`.
 */
export const ORDER_REACHABLE_EVIDENCE_KINDS: readonly string[] = Object.freeze(['cash_collected_on_handover', 'authorized_customer_credit']);

/**
 * The settlement mode each evidence kind can honestly support — the whole
 * mapping, as data. Nothing maps to two modes, and no mode is reachable without
 * evidence.
 */
export const SETTLEMENT_MODE_BY_EVIDENCE: Readonly<Record<string, OrderSettlementMode | null>> = Object.freeze({
  cash_collected_on_handover: 'cash' as OrderSettlementMode,
  // Directive #11 PART 31: "if Phase 4 `cash` semantics mean literal cash/till,
  // a card/provider payment must NOT masquerade as cash." An earlier revision of
  // this table mapped `payment_verified` to `cash`, which is that masquerade
  // written down — harmless only because the kind is refused below. It is `null`
  // now, because the mode a verified card payment settles into is the answer the
  // Sales + Accounting authorities owe when they define the merchant
  // payment/tender seam, and Phase 6 answering it here would be a second
  // settlement authority (PART 7). The entry exists so the KIND is enumerated;
  // its mode stays unanswered until the seam names one.
  payment_verified: null,
  authorized_customer_credit: 'credit' as OrderSettlementMode,
});

/**
 * The evidence kinds whose settlement mode is not Phase 6's to state.
 *
 * `WAITING_FOR_INTEGRATED_SURFACE` in the directive's own vocabulary (PART 15).
 * A kind listed here is refused by `requireSettlementTruth` whatever the caller
 * claims, and the refusal names the missing surface rather than the mode.
 */
export const ORDER_EVIDENCE_KINDS_AWAITING_SEAM: readonly string[] = Object.freeze(['payment_verified']);

/** What the gate established. Returned rather than assumed, so a caller cannot skip it. */
export interface EstablishedSettlement {
  mode: OrderSettlementMode;
  evidenceKind: string;
  /** The user who collected the cash or authorized the credit. */
  establishedByUserId: string;
  /** The customer the receivable is owed by — non-null exactly when the mode is `credit`. */
  customerId: string | null;
}

/**
 * Prove that the stated settlement mode is true, or refuse.
 *
 * `claimedMode` is what the caller wants to commit under; the evidence decides
 * whether they may. A mismatch is `order.settlement_mode_unsupported` rather
 * than a silent correction to whatever the evidence supports: quietly turning a
 * claimed `cash` into a `credit` would commit a receivable the merchant never
 * asked for, and quietly doing the reverse would post cash nobody collected.
 */
export function requireSettlementTruth(claimedMode: OrderSettlementMode, evidence: OrderSettlementEvidence, customerId: string | null): EstablishedSettlement {
  // Recognition is by KEY, not by value: a kind whose mode is deliberately
  // unanswered (`null`) is recognised and refused, which is a different fact
  // from a kind nobody has heard of.
  if (!Object.prototype.hasOwnProperty.call(SETTLEMENT_MODE_BY_EVIDENCE, evidence.kind)) {
    throw new OrderError('order.settlement_not_established', 'the stated settlement evidence is not one this package recognises', {
      kind: String(evidence.kind),
    });
  }
  const supported = SETTLEMENT_MODE_BY_EVIDENCE[evidence.kind] ?? null;

  // PART 31, before anything else: an unintegrated surface cannot be the thing
  // that makes a sale true, whatever the caller claims about it.
  // The discriminant is compared literally rather than through
  // `ORDER_EVIDENCE_KINDS_AWAITING_SEAM.includes(...)`, because only the literal
  // narrows the union and lets the exhaustiveness check at the end of this
  // function work. The constant and this branch are tied together by a test
  // (`the awaiting-seam list is exactly the kinds with no mode`), not by hope —
  // and any future kind with an unstated mode is caught by the `null` check
  // below even if someone forgets both.
  if (evidence.kind === 'payment_verified') {
    throw new OrderError(
      'order.payment_surface_not_integrated',
      'no merchant payment provider is integrated, so a verified online payment cannot be established here',
      {
        kind: String(evidence.kind),
      },
    );
  }

  // Fail closed on a kind whose mode nobody has stated, even if a future edit
  // forgets to list it above: an unknown mode is never guessed into one.
  if (supported === null) {
    throw new OrderError('order.settlement_not_established', 'no settlement mode has been established for this evidence kind', {
      kind: String(evidence.kind),
    });
  }

  if (supported !== claimedMode) {
    throw new OrderError('order.settlement_mode_unsupported', 'the stated evidence does not support the claimed settlement mode', {
      kind: evidence.kind,
      claimed: claimedMode,
      supported,
    });
  }

  if (evidence.kind === 'authorized_customer_credit') {
    assertCanonicalId(evidence.authorizedByUserId, 'authorizedByUserId');
    // `TL-P6-R3` and `TL-P6-R4` together: a guest is never AR, an anonymous
    // receivable is forbidden, and no customer row is invented to satisfy the
    // mechanics. So the absence of a customer is a refusal, never a prompt to
    // create one.
    if (customerId === null) {
      throw new OrderError('order.checkout_customer_required', 'canonical credit requires a named customer; an anonymous receivable is forbidden');
    }
    assertCanonicalId(customerId, 'customerId');
    return { mode: 'credit', evidenceKind: evidence.kind, establishedByUserId: evidence.authorizedByUserId, customerId };
  }

  if (evidence.kind === 'cash_collected_on_handover') {
    assertCanonicalId(evidence.collectedByUserId, 'collectedByUserId');
    // A collected-cash sale MAY name a customer and MAY be a walk-in. Both are
    // true facts; neither is invented.
    if (customerId !== null) assertCanonicalId(customerId, 'customerId');
    return { mode: 'cash', evidenceKind: evidence.kind, establishedByUserId: evidence.collectedByUserId, customerId };
  }

  // Exhaustive by construction: every kind above either returned or threw, so
  // this line is reachable only once a new kind is added to the union without
  // being handled here. It refuses rather than falling into the nearest branch,
  // and the `never` annotation makes the compiler say so at build time too.
  const unhandled: never = evidence;
  throw new OrderError('order.settlement_not_established', 'no settlement mode has been established for this evidence kind', {
    kind: String((unhandled as { kind?: unknown }).kind),
  });
}
