/**
 * P4-S4 — THE CUSTOMER-SETTLEMENT PATH ADAPTER, AND THE ONE PLACE ITS
 * CONTRACT IS WRITTEN.
 *
 * The suites of this slice were written BEFORE the settlement primitive
 * existed, because the laws they assert — the money closure, one entry per
 * allocation, the oldest-first chain with no gap and no overlap, the customer
 * identity pin, the walk-in law — are the slice's acceptance criteria and had
 * to be stated before an implementation could be measured against them. That
 * creates exactly one coupling problem, and this file is where it is paid for:
 * a suite that hard-codes a request body, a routine name or a column name is a
 * suite that has to be rewritten line by line when the real migration lands,
 * and the rewrite is where a law quietly becomes a weaker law.
 *
 * So every suite reaches the settlement through `collectPayment` /
 * `applyCredit` and names every relation, routine, column, source type,
 * operation kind and refusal code through a constant declared HERE. When
 * `0081` lands, the ONE file that changes is this one, and no assertion in any
 * suite moves.
 *
 * ── WHAT IS CONTRACT AND WHAT IS ASSUMPTION ───────────────────────────────
 *
 * Fixed by the P4-S4 BUILD CONTRACT and by the implementation map's §8, not by
 * this file, and therefore NOT negotiable in a later edit:
 *
 *   — the source types are `customer_payment_allocation` and
 *     `customer_credit_application` (contract OQ-6);
 *   — the operation codes are `customer.collect_payment` and
 *     `customer.apply_credit`, because the op-code regex forbids an underscore
 *     in the first segment (contract OQ-6, `0054:229`, P4-AL-28);
 *   — the permission is `payments.collect` for both commands, and there is no
 *     thirteenth permission key (contract OQ-5);
 *   — the closure is `Σ invoice_amount_applied + credit created = amount_minor`
 *     with `allocation_count >= 0` (contract OQ-4);
 *   — the surplus posts to the EXISTING system account
 *     `customer_credit_liability` and the allocation dust to
 *     `accounts_receivable` (contract OQ-9);
 *   — the two refusals the deferred verifier owes are
 *     `invoice_settlement.customer_mismatch` and
 *     `invoice_settlement.walkin_not_settleable`. Since `0082` gave each
 *     reducer a three-column edge onto `invoices_customer_uq` — added BESIDE
 *     `0081`'s two-column edge, never in place of it, because a composite seam
 *     is never dropped — the row is refused with `23503` before either arm is
 *     reached, so the verifier still OWES them as defence in depth and is no
 *     longer the mechanism;
 *   — the command is idempotent on a CALLER-SUPPLIED document UUID plus a
 *     stored `intent_sha256` read before any write (P4-AL-30), so the body
 *     carries the payment's own id;
 *   — the caller computes the release, the dust and the FX and the database
 *     RE-VERIFIES every figure and refuses on disagreement — the supplier
 *     shape, not the recompute-everything shape (contract OQ-3).
 *
 * ASSUMED by this file, and the only thing a later edit may touch — the
 * coordinator reconciles these with the migration owner:
 *
 *   — the routine names (`ROUTINES` below);
 *   — the HTTP route paths and the request field NAMES (`PAYMENT_BODY_SHAPE`,
 *     `CREDIT_APPLICATION_BODY_SHAPE`);
 *   — the column names of the four relations, which are taken verbatim from
 *     implementation map §8.1–§8.4 and are each cleared against guard G-3's
 *     vocabulary there.
 *
 * ── WHY THE ARITHMETIC IS NOT RE-IMPLEMENTED HERE ─────────────────────────
 *
 * The settlement arithmetic is REUSED, never re-implemented: `convertToBase`,
 * `apRelease`, `creditRemainingCarrying` and `creditRelease` are imported from
 * `@daftar/inventory` (the names are historical — the arithmetic is general
 * and carries nothing supplier-specific but the name; contract, hard
 * prohibitions). A second body of it in a test file would be a second copy of
 * the financial truth, and the suites would then be measuring this file rather
 * than the estate.
 */
import { apRelease, convertToBase, creditRelease } from '@daftar/inventory';
import type { Response } from 'supertest';
import type { TestApp } from '../../helpers/test-app';

// ── 1. the names ──────────────────────────────────────────────────────────

/** The four relations `0081` declares (implementation map §8.1–§8.4). */
export const S4_RELATIONS = ['payments', 'payment_allocations', 'customer_credits', 'customer_credit_applications'] as const;

/**
 * The routines `0081` declares. The two commands, the two chain verifiers and
 * the one writer of a credit's remaining pair.
 *
 * Named as ONE constant each rather than as a list of candidates. A guessing
 * canary is the wrong shape even when one of its guesses is right: it says
 * "the subject is absent" both when the routine is missing AND when it was
 * renamed outside the guess list, so a rename leaves every suite of the slice
 * permanently red for a reason that is not a defect, and the fix becomes
 * "widen the guess" rather than "follow the name".
 */
export const ROUTINES = {
  collectPayment: 'customer_collect_payment',
  applyCredit: 'customer_apply_credit',
  invoiceSettlementVerify: 'invoice_settlement_verify',
  customerCreditVerify: 'customer_credit_verify',
  customerCreditConsume: 'customer_credit_consume',
} as const;

/**
 * The accounting source types `0081` registers (contract OQ-6, plus the
 * coordinator's third-source ruling).
 *
 * `customer_credit` is the third and it is FORCED, not a convenience: with
 * zero allocations there is no allocation entry for the surplus leg to ride
 * on, and the completeness validator pins an allocation entry's line multiset
 * EXACTLY (map §3.4, `0067:1998-2027`), so the surplus cannot be smuggled into
 * one as an extra line either. The credit therefore carries its own entry,
 * bound by the credit's own id, whose only lines are the method's posting
 * account and `customer_credit_liability`.
 */
export const S4_SOURCE_TYPES = ['customer_credit', 'customer_credit_application', 'customer_payment_allocation'] as const;

/** The source type of the surplus leg, named once so no suite types it twice. */
export const CREDIT_SOURCE_TYPE = 'customer_credit';

/**
 * The source types that SETTLE AN INVOICE, which is a narrower set than the
 * three above and the one every invoice-side law is quantified over.
 *
 * `customer_credit` is an accounting source but not a settler: a credit coming
 * into existence moves money between the till and a liability and touches no
 * receivable at all. A law that quantified "every settlement entry carries an
 * accounts_receivable line" over all three would be false of the third, and
 * the fix would be to weaken the law rather than to name the set properly.
 */
export const INVOICE_SETTLING_SOURCE_TYPES = ['customer_credit_application', 'customer_payment_allocation'] as const;

/** The inventory operation kinds `0081` registers (contract OQ-6). */
export const S4_OPERATION_KINDS = ['customer.collect_payment', 'customer.apply_credit'] as const;

/**
 * The system keys the settlement moves value on, as IDENTITIES. Every figure
 * this slice reads out of the ledger is read by joining `accounts` on
 * `system_key`, never by a typed account code: a code typed into a test is a
 * second copy of the chart, and the day the chart moves the test agrees with
 * the copy instead of with the estate.
 */
export const SYSTEM_KEYS = {
  accountsReceivable: 'accounts_receivable',
  customerCreditLiability: 'customer_credit_liability',
  rounding: 'rounding',
  fxGain: 'fx_gain',
  fxLoss: 'fx_loss',
} as const;

/** The two refusals the deferred verifier owes; since `0082` they sit behind the three-column edge each reducer gained beside its narrow one. */
/**
 * THE TWO VOCABULARIES OF ONE LAW, AND WHY BOTH ARE ASSERTED.
 *
 * The same prohibition is answered twice, in two different domains, and that
 * is the architecture rather than an inconsistency:
 *
 *   — at the ROUTE, the API answers in the DOCUMENT's domain. `settledInvoice`
 *     (`apps/api/src/modules/receivables/customer-payment.service.ts`)
 *     pre-checks the invoice and refuses before the command ever reaches the
 *     database, so what a merchant sees is `customer_payment.*` on the payment
 *     path and `customer_credit_application.*` on the credit path;
 *   — at COMMIT, `invoice_settlement_verify` answers in the INVARIANT's
 *     domain — `invoice_settlement.*` — because there it is the verifier and
 *     not the service that speaks.
 *
 * A route case that expected the verifier's code would be asserting a code no
 * caller of that route can ever see, and a planted-row proof that expected the
 * service's code would be asserting a code the database cannot raise. So the
 * sets are separate, and no test may reach for the wrong one.
 *
 * These codes are an ASSUMPTION of this file and nowhere else, taken from the
 * coordinator's reading of `RECEIVABLES_STATUS` and the three locale
 * catalogues. If any of the five is renamed, this is the one edit.
 */
export const VERIFIER_REFUSALS = {
  customerMismatch: 'invoice_settlement.customer_mismatch',
  walkinNotSettleable: 'invoice_settlement.walkin_not_settleable',
} as const;

/** What `POST /v1/customer-payments` answers: the payment document's domain. */
export const PAYMENT_ROUTE_REFUSALS = {
  customerMismatch: 'customer_payment.customer_mismatch',
  invoiceWalkin: 'customer_payment.invoice_walkin',
} as const;

/** What `POST /v1/customer-credits/:creditId/applications` answers: the application document's domain. */
export const CREDIT_ROUTE_REFUSALS = {
  customerMismatch: 'customer_credit_application.customer_mismatch',
  invoiceWalkin: 'customer_credit_application.invoice_walkin',
} as const;

/**
 * The columns each law below is written over, so the canary can refuse at
 * COLUMN grain. A law written against a column that is not there does not
 * fail: it raises `42703` from inside a helper, which reads as an
 * infrastructure error rather than as "this claim has no subject".
 */
export const COLUMNS = {
  payments: [
    'customer_id',
    'payment_method_id',
    'posting_account_id',
    'currency_code',
    'amount_minor',
    'base_amount_minor',
    'allocation_count',
    // The payment's OWN rate snapshot, and the registry row it was taken
    // from. `payments_rate_ck` ties the three together, and the
    // cross-currency golden reads all three back.
    'payment_to_base_rate',
    'rate_source',
    'fx_rate_id',
  ],
  payment_allocations: [
    'payment_id',
    'customer_id',
    'invoice_id',
    'line_no',
    'payment_currency',
    'payment_amount_minor',
    'payment_base_amount_minor',
    'invoice_amount_applied_minor',
    'ar_released_before_txn_minor',
    'invoice_carrying_base_released_minor',
    'ar_dust_base_minor',
    'realized_fx_gain_loss_minor',
    'binding_source_id',
    'accounting_source_type',
  ],
  customer_credits: [
    'customer_id',
    'origin_payment_id',
    'currency_code',
    'original_amount_minor',
    'original_carrying_base_amount_minor',
    'credit_to_base_rate',
    'remaining_amount_minor',
    'remaining_carrying_base_amount_minor',
    // The credit is an accounting source in its own right (the third-source
    // ruling), so it carries the same two columns every other source in this
    // estate carries: a GENERATED source type and a `binding_source_id`
    // CHECKed equal to `id`. The accepted precedent on an earlier slice's
    // document is `invoices` itself (`0075:279-280`).
    'accounting_source_type',
    'binding_source_id',
  ],
  customer_credit_applications: [
    'credit_id',
    'customer_id',
    'invoice_id',
    'credit_amount_consumed_minor',
    'credit_remaining_before_minor',
    'credit_carrying_base_released_minor',
    'credit_dust_base_minor',
    'ar_dust_base_minor',
    'invoice_amount_applied_minor',
    'ar_released_before_txn_minor',
    'invoice_carrying_base_released_minor',
    'credit_to_base_rate',
    'realized_fx_gain_loss_minor',
    'binding_source_id',
    'accounting_source_type',
  ],
} as const satisfies Readonly<Record<(typeof S4_RELATIONS)[number], readonly string[]>>;

/**
 * The two columns the chain is read through, named once. `ar_released_before_txn_minor`
 * is `X` — the chain position — and `invoice_amount_applied_minor` is `a`, the
 * one amount a row applies. Neither is a running total; the aggregate is
 * `invoice_outstanding`'s live `SUM` over them (map §4.2).
 */
export const CHAIN = { position: 'ar_released_before_txn_minor', applied: 'invoice_amount_applied_minor' } as const;

// ── 2. the routes ─────────────────────────────────────────────────────────

export const COLLECT_PAYMENT_PATH = '/v1/customer-payments';
export const applyCreditPath = (creditId: string): string => `/v1/customer-credits/${creditId}/applications`;

/**
 * ASSUMPTION, recorded in one string so the diff that corrects it is one line
 * and is visible in review. Modelled on `supplier_pay`'s request shape
 * (`0068:481-505`) with `invoice` for `purchase` and `ar` for `ap`: the caller
 * states the money it received and, per leg, the figures the database then
 * re-verifies.
 */
export const PAYMENT_BODY_SHAPE =
  'POST /v1/customer-payments { paymentId, customerId, paymentMethodId, paymentDate, currencyCode|null, amountMinor, reference|null, ' +
  'creditId|null, allocations[{ allocationId, invoiceId, paymentAmountMinor, invoiceAmountAppliedMinor }] }';

export const CREDIT_APPLICATION_BODY_SHAPE =
  'POST /v1/customer-credits/:creditId/applications { applicationId, customerId, invoiceId, applicationDate, ' +
  'creditAmountConsumedMinor, invoiceAmountAppliedMinor }';

/**
 * THE REQUEST CARRIES NO DERIVED FIGURE, AND THAT IS A LAW OF THIS BOUNDARY.
 *
 * "The caller computes the release, the dust and the FX and the database
 * re-verifies them" (contract OQ-3) is a law of the SERVICE -> ROUTINE
 * boundary, not of the CLIENT -> API one. The accepted shape is
 * `POST /v1/supplier-payments`, whose allocation object is exactly four fields
 * — `allocationId, purchaseId, paymentAmountMinor, purchaseAmountAppliedMinor`
 * (`apps/api/src/modules/purchasing/purchasing.schemas.ts:356-363`) — with the
 * service deriving every snapshot, release, dust and FX figure from the stored
 * documents.
 *
 * There is a correctness reason underneath the precedent, and it is the reason
 * these suites must not state a derived figure even where it would be
 * convenient: the IDEMPOTENCY INTENT DIGEST is computed over the request
 * (P4-AL-30). A derived figure inside the request puts the FX rate inside the
 * digest, so the same collection retried after a rate movement hashes
 * differently and comes back as a false `payment.idempotency_conflict` instead
 * of the recomputation it should be. The API schemas are also `.strict()`, so
 * an unknown key is refused outright.
 *
 * The suites still compute the expected release, dust and FX — with
 * `apRelease`, `convertToBase` and `creditRelease` — but they use those figures
 * to ASSERT AGAINST THE STORED ROWS, never to tell the server what to write.
 * `allocationFigures` is therefore an expectation builder and not a request
 * builder.
 */
export const BODY_CARRIES_NO_DERIVED_FIGURE = true;

// ── 3. what a suite states, and what the adapter computes ─────────────────

/**
 * THE REQUEST HALF of a leg: the four fields, and only the four fields, that
 * `collectPayment` is allowed to put in the body.
 *
 * It is a type of its own rather than a comment, because the boundary has to
 * be unwriteable and not merely documented. `allocationRequestBody` returns
 * exactly this shape, so a derived figure added back to `AllocationInput`
 * tomorrow cannot reach the wire without someone editing the body builder and
 * this type together.
 *
 * The shape is the accepted supplier one with the nouns changed:
 * `{ allocationId, purchaseId, paymentAmountMinor, purchaseAmountAppliedMinor }`
 * (`apps/api/src/modules/purchasing/purchasing.schemas.ts:356-363`). `invoiceId`
 * is NOT a derived figure and stays: it is the SUBJECT the caller names, the
 * counterpart of `purchaseId`, and nothing on the server can infer which
 * invoice a caller meant.
 */
export interface AllocationRequest {
  readonly allocationId?: string;
  readonly invoiceId: string;
  /** `a`, in the invoice's currency, integer minor units as a decimal string. */
  readonly appliedMinor: string;
  /**
   * `p`, in the PAYMENT's currency — a different unit from `appliedMinor` the
   * moment the two currencies differ. Absent means the single-currency case,
   * where `payment_allocations_same_currency_ck` requires the two to be equal
   * anyway (map §8.2), so absence is not a default that hides a choice.
   */
  readonly paymentAmountMinor?: string;
}

/** The body object the payment route actually receives, per leg. Four keys, closed. */
export interface AllocationRequestBody {
  readonly allocationId: string;
  readonly invoiceId: string;
  readonly paymentAmountMinor: string;
  readonly invoiceAmountAppliedMinor: string;
}

/**
 * THE EXPECTATION HALF: the figures a suite reasons WITH and asserts AGAINST
 * the stored row and the journal, and never states to the server.
 *
 * `releasedBeforeMinor` and the invoice's stored `(B, T)` keep every bit of
 * their role — `allocationFigures` and the chain arithmetic go on computing
 * `rel = R(X + a) − R(X)` from them, and the goldens go on comparing that with
 * `payment_allocations.invoice_carrying_base_released_minor` and with the AR
 * line of the entry. They moved from the request to the expectation side; they
 * were not deleted. A golden that derives an expectation from a figure it does
 * NOT send is strictly stronger than one that sends it and reads it back,
 * because only the first can catch a server that computed the figure wrongly.
 */
export interface AllocationExpectation {
  /** `X`, the chain position this leg sits at — the server derives it; the suite predicts it. */
  readonly releasedBeforeMinor: string;
  /** The invoice's own stored totals, which fix `rel = R(X + a) − R(X)`. */
  readonly invoiceTotalTxnMinor: string;
  readonly invoiceTotalBaseMinor: string;
  /**
   * THE THREE SNAPSHOTS, each as R10 (`10^10`), each the stored snapshot of
   * its own document and never a rate looked up again at settlement time:
   *
   *   — `invoiceToBaseRateR10`: the invoice's stored `source_to_base_rate`,
   *     which is what `conv_R(a)` — and therefore the AR dust — is computed at;
   *   — `paymentToBaseRateR10`: the payment's own `payment_to_base_rate`,
   *     which `conv_Rp(p)` and therefore the realized FX is computed at.
   *
   * The third, the credit's `Rn`, lives on `CreditApplicationInput` because
   * only a credit application has one.
   */
  readonly invoiceToBaseRateR10?: bigint;
  readonly paymentToBaseRateR10?: bigint;
  /** Minor-unit exponents, so `convertToBase` scales between unlike currencies (JOD is 3, ILS/USD are 2). */
  readonly invoiceExponent?: number;
  readonly paymentExponent?: number;
  readonly baseExponent?: number;
}

/**
 * One leg as a SUITE states it: the request half and the expectation half
 * together. Only the request half is ever serialised.
 */
export type AllocationInput = AllocationRequest & AllocationExpectation;

export interface PaymentInput {
  /** The caller-supplied document UUID the idempotency of P4-AL-30 is keyed on. */
  readonly paymentId: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly paymentDate: string;
  /** The money received. NOT the paid amount of any invoice (contract OQ-4). */
  readonly amountMinor: string;
  /** `[]` is lawful and is a payment on account (contract OQ-4). */
  readonly allocations: readonly AllocationInput[];
  readonly currencyCode?: string;
  readonly reference?: string | null;
  /** The credit the surplus is to be created as, when there is a surplus. */
  readonly creditId?: string;
}

/**
 * The per-leg figures, computed with the estate's OWN primitives.
 *
 * `rel` is `apRelease(B, T, X, a)` = `HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T)`
 * — a difference of two cumulative roundings of the invoice's STORED originals,
 * never a function of a previous leg's already-rounded release
 * (`[[daftar-a-rounded-quotient-is-never-an-input]]`, P4-AL-25). `conv` is
 * `convertToBase`. The dust is `rel − conv(a)` and the realized FX is
 * `conv(payment) − rel`, exactly as the accepted supplier path computes them
 * (`packages/inventory/src/supplier-settlement.ts:185, 326`).
 *
 * The name `apRelease` is historical: the arithmetic is general and the only
 * supplier-specific thing about it is the name (contract, hard prohibitions).
 */
export interface AllocationFigures {
  readonly paymentAmountMinor: string;
  readonly paymentBaseAmountMinor: string;
  readonly invoiceAmountAppliedMinor: string;
  readonly releasedBeforeMinor: string;
  readonly carryingReleasedMinor: string;
  readonly arDustBaseMinor: string;
  readonly realizedFxMinor: string;
}

/** R10: a rate is `NUMERIC(20,10)` in SQL and `10^10` here. Never a float. */
export const R10 = 10n ** 10n;

/** A `NUMERIC(20,10)` rate as the database stores it (`"3.6700000000"`) converted to R10, with no float in between. */
export function rateToR10(rate: string): bigint {
  const [whole = '0', frac = ''] = rate.trim().split('.');
  if (frac.length > 10) throw new Error(`a rate carries at most ten decimal places: ${rate}`);
  return BigInt(whole) * R10 + BigInt((frac + '0'.repeat(10)).slice(0, 10));
}

/**
 * The figures for one leg, computed with the estate's OWN primitives and with
 * each of the three snapshots applied to the figure it actually governs.
 *
 * When the payment, the invoice and the base are all one currency — which is
 * the case in every suite except the cross-currency golden — every rate is 1,
 * `rel` collapses to `a`, the dust to zero and the realized FX to zero, and
 * that is stated rather than hidden. `rel` is nevertheless always computed by
 * `apRelease` from the invoice's stored `(B, T)` and never asserted to be `a`:
 * when `B ≠ T` they differ, and the caller must carry whatever the primitive
 * says.
 *
 * The AR dust is `rel − conv_R(a)` at the INVOICE's rate and the realized FX
 * is `conv_Rp(p) − rel` at the PAYMENT's — two different snapshots, and using
 * one for both is the defect this signature exists to make unwriteable
 * (`packages/inventory/src/supplier-settlement.ts:185, 326`).
 */
export function allocationFigures(leg: AllocationInput): AllocationFigures {
  const a = BigInt(leg.appliedMinor);
  const x = BigInt(leg.releasedBeforeMinor);
  const p = BigInt(leg.paymentAmountMinor ?? leg.appliedMinor);
  const base = leg.baseExponent ?? 2;
  const rel = apRelease(BigInt(leg.invoiceTotalBaseMinor), BigInt(leg.invoiceTotalTxnMinor), x, a);
  const convInvoice = convertToBase(a, leg.invoiceToBaseRateR10 ?? R10, leg.invoiceExponent ?? 2, base);
  const convPayment = convertToBase(p, leg.paymentToBaseRateR10 ?? R10, leg.paymentExponent ?? 2, base);
  return {
    paymentAmountMinor: p.toString(),
    paymentBaseAmountMinor: convPayment.toString(),
    invoiceAmountAppliedMinor: a.toString(),
    releasedBeforeMinor: x.toString(),
    carryingReleasedMinor: rel.toString(),
    arDustBaseMinor: (rel - convInvoice).toString(),
    realizedFxMinor: (convPayment - rel).toString(),
  };
}

/**
 * `rel = R(X + a) − R(X)`, named for what it is on this side of the ledger.
 *
 * THE ARITHMETIC IS REUSED AND NEVER RE-IMPLEMENTED: this is `apRelease` from
 * `@daftar/inventory` under a local name. The name over there is historical —
 * nothing about the body is supplier-specific but the word — and the contract
 * requires every caller to go through it rather than grow a second copy of the
 * financial truth. Same for `toBase` and `convertToBase` below.
 */
export function invoiceRelease(totalBaseMinor: bigint, totalTxnMinor: bigint, releasedBeforeMinor: bigint, appliedMinor: bigint): bigint {
  return apRelease(totalBaseMinor, totalTxnMinor, releasedBeforeMinor, appliedMinor);
}

/** `conv(x, R, e_t, e_b)`, through the estate's own primitive. */
export function toBase(amountMinor: bigint, rateR10: bigint, exponent = 2, baseExponent = 2): bigint {
  return convertToBase(amountMinor, rateR10, exponent, baseExponent);
}

/**
 * `rel − conv_R(a)`, the AR dust, as a function of the figures that produce
 * it, so the law can be exercised on synthetic inputs.
 *
 * It exists as its own function because on THIS head no invoice of this estate
 * can produce a non-zero one: a product's `price_currency` is pinned to the
 * business base currency by the catalogue authority
 * (`apps/api/src/modules/catalog/catalog.service.ts:247-252`, §36–37), so
 * every invoice has `source_to_base_rate = 1` and `B = T`, and `rel` and
 * `conv_R(a)` are both `a`. An assertion that the dust line is PRESENT would
 * therefore be an assertion nobody can make true, and a red proof over
 * synthetic `(B, T, R)` is the honest substitute. See the cross-currency
 * golden's disclosure case.
 */
export function arDust(
  totalBaseMinor: bigint,
  totalTxnMinor: bigint,
  releasedBeforeMinor: bigint,
  appliedMinor: bigint,
  rateR10: bigint,
  exponent = 2,
  baseExponent = 2,
): bigint {
  const rel = apRelease(totalBaseMinor, totalTxnMinor, releasedBeforeMinor, appliedMinor);
  return rel - convertToBase(appliedMinor, rateR10, exponent, baseExponent);
}

/** `cr_rel − conv_Rn(c)`, the credit dust, on the same terms. */
export function creditDust(
  originalMinor: bigint,
  originalCarryingMinor: bigint,
  remainingBeforeMinor: bigint,
  consumedMinor: bigint,
  rateR10: bigint,
  exponent = 2,
  baseExponent = 2,
): bigint {
  const crRel = creditRelease(originalMinor, originalCarryingMinor, remainingBeforeMinor, consumedMinor);
  return crRel - convertToBase(consumedMinor, rateR10, exponent, baseExponent);
}

/**
 * `Σ invoice_amount_applied` over the legs a suite stated, in integer minor
 * units — which in these single-currency fixtures is also the payment amount
 * the legs consume, and that is a CONSTRAINT and not a coincidence:
 * `payment_allocations_same_currency_ck` requires
 * `payment_currency <> invoice_currency OR payment_amount_minor = invoice_amount_applied_minor`
 * (map §8.2). The closure law itself is asserted in the payment's currency out
 * of `payment_amount_minor`, never out of this.
 */
export function appliedTotal(allocations: readonly AllocationInput[]): bigint {
  return allocations.reduce((acc, l) => acc + BigInt(l.appliedMinor), 0n);
}

// ── 4. the two calls every P4-S4 suite makes ──────────────────────────────

export function collectPayment(t: TestApp, headers: Record<string, string>, input: PaymentInput): Promise<Response> {
  const body = {
    paymentId: input.paymentId,
    customerId: input.customerId,
    paymentMethodId: input.paymentMethodId,
    paymentDate: input.paymentDate,
    currencyCode: input.currencyCode ?? null,
    amountMinor: input.amountMinor,
    reference: input.reference ?? null,
    // The surplus's document id travels with the request for the same reason
    // the payment's does: the command is idempotent on caller-supplied
    // document UUIDs, so a replay must be byte-identical (P4-AL-30). A
    // server-minted credit id would make two identical requests two different
    // commands.
    creditId: input.creditId ?? null,
    allocations: input.allocations.map((leg, i) => allocationRequestBody(leg, input.paymentId, i)),
  };
  return t.request.post(COLLECT_PAYMENT_PATH).set(headers).send(body);
}

/**
 * The four keys of one leg's body object, and nothing else.
 *
 * The return type is the closed `AllocationRequestBody`, so this is the one
 * place where a derived figure could leak onto the wire and the one place a
 * reviewer has to read to know that none does. `CustomerPaymentSchema` is
 * `.strict()`, so an extra key is not ignored: it is a 400 before the service
 * is reached, which is what the request-boundary suite proves on purpose.
 */
export function allocationRequestBody(leg: AllocationRequest, paymentId: string, i: number): AllocationRequestBody {
  return {
    allocationId: leg.allocationId ?? derivedChildId(paymentId, i),
    invoiceId: leg.invoiceId,
    paymentAmountMinor: leg.paymentAmountMinor ?? leg.appliedMinor,
    invoiceAmountAppliedMinor: leg.appliedMinor,
  };
}

export interface CreditApplicationInput {
  readonly applicationId: string;
  readonly creditId: string;
  readonly customerId: string;
  readonly invoiceId: string;
  readonly applicationDate: string;
  /** `c`, consumed from the credit. */
  readonly consumedMinor: string;
  /** `rb`, the credit's remaining BEFORE this application — the credit's own chain position. */
  readonly remainingBeforeMinor: string;
  /** The credit's immutable original pair `(OA, OB)`, which fixes `g`. */
  readonly creditOriginalMinor: string;
  readonly creditOriginalCarryingMinor: string;
  /**
   * THE THIRD SNAPSHOT: the credit's own stored `credit_to_base_rate`, `Rn`.
   *
   * It is the credit's and nobody else's. Every consumer reads it off the
   * credit row and never looks a rate up again at application time
   * (`packages/inventory/src/supplier-settlement.ts:155`) — which is why the
   * cross-currency golden moves the live rate between the credit's birth and
   * its application and requires the stored one to be the one that was used.
   */
  readonly creditToBaseRateR10?: bigint;
  readonly creditExponent?: number;
  readonly baseExponent?: number;
  /** The invoice leg, exactly as a payment allocation states it. */
  readonly leg: AllocationInput;
}

/** The body the credit-application route actually receives. Four keys, closed. */
export interface CreditApplicationRequestBody {
  readonly applicationId: string;
  readonly customerId: string;
  readonly invoiceId: string;
  readonly applicationDate: string;
  readonly creditAmountConsumedMinor: string;
  readonly invoiceAmountAppliedMinor: string;
}

/**
 * The credit-application body: SIX keys, per `CustomerCreditApplicationSchema`
 * (`apps/api/src/modules/receivables/receivables.schemas.ts:185-204`), the
 * mirror of the accepted `SupplierCreditAllocationSchema`
 * (`purchasing.schemas.ts:407-416`, six keys with `purchaseId` and
 * `allocationDate`).
 *
 * `invoiceId` and `applicationDate` are SUBJECTS the caller names, not figures
 * the server derives, and the distinction is the whole content of this
 * boundary: nothing on the server can infer which invoice a caller meant, and
 * a date is stated by the document's author. Removing them would not have
 * tightened the boundary — it would have invented an invoice-selection rule
 * that no directive, lock decision or accepted code authorizes, and shipped it
 * as product behaviour.
 *
 * What IS absent is `creditRemainingBeforeMinor`: the credit's own chain
 * position, which the server reads off the credit row, so a caller that states
 * it is restating a figure it read a moment ago and the intent digest would
 * carry it. The two-settlements-from-one-position law is not weakened by its
 * absence — its command half is the over-consumption cap and its database half
 * is the level `UNIQUE`, reached by the planted direct-SQL row.
 *
 * The return type is closed for the same reason the payment side's is: it is
 * the one place a derived figure could drift back onto the wire, and the one
 * place a reviewer has to read to know that none does.
 */
export function applyCredit(t: TestApp, headers: Record<string, string>, input: CreditApplicationInput): Promise<Response> {
  return t.request.post(applyCreditPath(input.creditId)).set(headers).send(creditApplicationRequestBody(input));
}

/** The six keys of the credit-application body, and nothing else. */
export function creditApplicationRequestBody(input: CreditApplicationInput): CreditApplicationRequestBody {
  return {
    applicationId: input.applicationId,
    customerId: input.customerId,
    invoiceId: input.invoiceId,
    applicationDate: input.applicationDate,
    creditAmountConsumedMinor: input.consumedMinor,
    invoiceAmountAppliedMinor: input.leg.appliedMinor,
  };
}

/**
 * The key the request-boundary suite plants, and the reason it is this one.
 *
 * `releasedBeforeMinor` is the most tempting derived figure of the slice —
 * every suite computes it, and it reads like a token the caller holds — so if
 * any derived figure were going to be let back into a body it would be this
 * one. A boundary proved on the easy case is not proved.
 */
export const DERIVED_FIGURE_PROBE_KEY = 'releasedBeforeMinor';

/**
 * The payment body a suite would have sent before this ruling: the lawful one
 * with one derived figure put back on the first leg. Used only to prove the
 * refusal, never to settle anything.
 */
export function paymentBodyWithDerivedFigure(input: PaymentInput, releasedBeforeMinor: string): Record<string, unknown> {
  const legs = input.allocations.map((leg, i) => allocationRequestBody(leg, input.paymentId, i));
  if (legs.length === 0) throw new Error('the derived-figure probe needs a leg to put the figure on, or it proves nothing');
  return {
    paymentId: input.paymentId,
    customerId: input.customerId,
    paymentMethodId: input.paymentMethodId,
    paymentDate: input.paymentDate,
    currencyCode: input.currencyCode ?? null,
    amountMinor: input.amountMinor,
    reference: input.reference ?? null,
    creditId: input.creditId ?? null,
    allocations: legs.map((leg, i) => (i === 0 ? { ...leg, [DERIVED_FIGURE_PROBE_KEY]: releasedBeforeMinor } : leg)),
  };
}

/** The same, for the credit-application body: the lawful six keys with one derived figure added. */
export function creditBodyWithDerivedFigure(input: CreditApplicationInput, releasedBeforeMinor: string): Record<string, unknown> {
  return { ...creditApplicationRequestBody(input), [DERIVED_FIGURE_PROBE_KEY]: releasedBeforeMinor };
}

/** The figures a credit application OUGHT to store, for asserting against the stored row. */
export interface CreditApplicationFigures {
  readonly creditCarryingReleasedMinor: string;
  readonly creditDustBaseMinor: string;
  readonly realizedFxMinor: string;
}

/**
 * What the service should have derived, computed here only so a suite can
 * compare it with what was STORED. Never sent.
 */
export function creditApplicationFigures(input: CreditApplicationInput): CreditApplicationFigures {
  const leg = allocationFigures(input.leg);
  const c = BigInt(input.consumedMinor);
  const conv = convertToBase(c, input.creditToBaseRateR10 ?? R10, input.creditExponent ?? 2, input.baseExponent ?? 2);
  const crRel = creditReleaseOf(input);
  return {
    creditCarryingReleasedMinor: crRel.toString(),
    creditDustBaseMinor: (crRel - conv).toString(),
    realizedFxMinor: (crRel - BigInt(leg.carryingReleasedMinor)).toString(),
  };
}

/** `g(rb) − g(rb − c)`, through the estate's own primitive and no second copy of it. */
export function creditReleaseOf(
  input: Pick<CreditApplicationInput, 'creditOriginalMinor' | 'creditOriginalCarryingMinor' | 'remainingBeforeMinor' | 'consumedMinor'>,
): bigint {
  return creditRelease(
    BigInt(input.creditOriginalMinor),
    BigInt(input.creditOriginalCarryingMinor),
    BigInt(input.remainingBeforeMinor),
    BigInt(input.consumedMinor),
  );
}

/**
 * A child document id for position `i` of a command: UUIDv4-shaped and derived
 * from the parent's own hex, so the SAME input always produces the SAME body.
 * The idempotency law sends one input twice and requires the second call to
 * change nothing; a random child id would defeat that silently.
 */
export function derivedChildId(parentId: string, i: number): string {
  const hex = parentId.replace(/-/g, '');
  const tail = (BigInt(`0x${hex.slice(20)}`) + BigInt(i + 1)).toString(16).padStart(12, '0').slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${tail}`;
}

/**
 * The refusal law, stated so it does not depend on which key of the error
 * envelope the selling module chooses for its machine code.
 *
 * What the identity pin and the walk-in law require of a refusal is that it be
 * a STABLE BUSINESS REFUSAL naming its reason in a machine-readable code, with
 * the merchant sentence RENDERED from that code rather than composed by the
 * server (P4-AL-16). So: the code is looked for anywhere in the typed details,
 * which is a law about the refusal and not a copy of the module's DTO.
 *
 * WHICH KEY carries the code is left open; WHICH CODE it is, is not. The
 * comparison is of the FULL dotted code. It previously also accepted any seen
 * string ending in the expected code's last segment, which made every "the
 * refusal names X" assertion a claim about a SUFFIX: `customer_payment.
 * customer_mismatch` satisfied an expectation of `invoice_settlement.
 * customer_mismatch`, and so would any code at all ending `.customer_mismatch`
 * — the namespace is what distinguishes the verifier's refusal from a route's,
 * so dropping it dropped the thing being asserted.
 */
export function refusalCode(res: Response, expected: string): string | null {
  const seen: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      seen.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
  };
  walk((res.body as { error?: unknown } | undefined)?.error, 0);
  return seen.find((s) => s === expected) ?? null;
}
