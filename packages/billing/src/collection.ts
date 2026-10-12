/**
 * The identity of a collection attempt.
 *
 * ── The rule this module exists for ────────────────────────────────────
 *
 * Master Continuous Mission V3 §12: bind a collection attempt to a stable
 * logical identity at the provider, and «إذا قُبل الطلب وضاع الرد فلا تُنشئ
 * محاولة بمفتاح جديد قبل المصالحة» — if the request was accepted and the
 * response was lost, do NOT create an attempt under a new key before
 * reconciliation, «لأن تفرد صف النجاح في DB لا يمنع خصمًا خارجيًا ثانيًا»:
 * because the uniqueness of the success row in OUR database does not prevent
 * a second debit at the provider.
 *
 * That last clause is the whole point, and it is worth stating plainly
 * because the previous rounds' instinct was the opposite one. Every other
 * double-spend in this phase is closed by a constraint: the ledger's
 * conservation row, the one-consumption-per-grant-per-invoice index, the
 * at-most-one-success-per-invoice index. None of them can close this one. By
 * the time a second charge request leaves this process the money has moved at
 * somebody else's institution; a unique index can then only refuse to RECORD
 * the second debit, which is worse than useless — the merchant is out the
 * money and our books say it never happened.
 *
 * So the defence has to be upstream of the request, in what the request is
 * NAMED. A provider can collapse two identical requests into one charge if
 * and only if they carry the same idempotency key. Therefore the key is
 * DERIVED from the thing being collected, never generated:
 * `collectionAttemptKey` is a total function of (invoice, attempt ordinal),
 * so the same attempt names itself the same way on every retry, in every
 * process, after every restart, forever.
 *
 * ── Why the business is not in the key ─────────────────────────────────
 *
 * An invoice determines its business. Putting the business in the key would
 * mean a caller that passed the wrong one produced a DIFFERENT key for the
 * same attempt — which is precisely the failure this module prevents. A key
 * must have exactly one way to be spelled.
 *
 * ── No clock, no randomness, no counter of its own ─────────────────────
 *
 * There is nothing in here a second process could disagree with. A key that
 * contained an instant, a UUID or a process-local sequence would be unique
 * per CALL instead of per ATTEMPT, and unique-per-call is the defect wearing
 * the costume of the fix.
 */
import { refuse } from './errors';
import type { DunningDecision } from './dunning';
import type { ChargeRequest } from './ports';
import type { Price } from './types';

/**
 * The namespace every key this slice issues carries.
 *
 * Named, and asserted by `test/collection.test.ts`, because a key is sent to
 * a third party and lives in their records: a bare UUID in a provider's
 * dashboard says nothing about what it was for, and a key that could collide
 * with another Daftar subsystem's key would make two different facts share an
 * idempotency scope.
 */
export const COLLECTION_KEY_NAMESPACE = 'daftar.p5.collect';

/** The highest attempt ordinal that can be named. */
export const MAX_COLLECTION_ATTEMPT_NO = 999;

export interface CollectionAttemptIdentity {
  /** The subscription invoice being collected. */
  readonly invoiceId: string;
  /** Which attempt at collecting it, 1-based, as the attempt history orders them. */
  readonly attemptNo: number;
}

/**
 * The provider-facing name of one attempt. Total, deterministic, and the only
 * place a key is ever formed.
 *
 * The invoice id is required to be at least eight characters, not because
 * eight is meaningful, but because the resulting key must clear the port's
 * own minimum without that happening by accident.
 */
export function collectionAttemptKey(identity: CollectionAttemptIdentity): string {
  const invoiceId = identity?.invoiceId;
  if (typeof invoiceId !== 'string' || invoiceId.trim().length < 8 || invoiceId.trim() !== invoiceId) {
    refuse('billing.collection_identity_invalid', 'a collection attempt must name the invoice it collects, by a trimmed identifier');
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(invoiceId)) {
    // A key travels to a third party's API and comes back in their records.
    // Restricting it to identifier characters keeps it one token everywhere
    // rather than something a URL, a log line or a CSV can split.
    refuse('billing.collection_identity_invalid', 'an invoice identifier in a provider key must be a single identifier token');
  }
  const attemptNo = identity.attemptNo;
  if (typeof attemptNo !== 'number' || !Number.isInteger(attemptNo) || attemptNo < 1 || attemptNo > MAX_COLLECTION_ATTEMPT_NO) {
    refuse('billing.collection_identity_invalid', 'a collection attempt must carry a whole ordinal within the attempt cap', {
      attemptNo: typeof attemptNo === 'number' ? attemptNo : undefined,
    });
  }
  return `${COLLECTION_KEY_NAMESPACE}:${invoiceId}:${attemptNo}`;
}

/**
 * ROUND 8, the challenger's F-07. A `nextCollectionAttemptNo(attempts)` used
 * to stand here, and it is DELETED rather than repaired.
 *
 * It was a second implementation of the ordinal rule that nothing called:
 * `collectionRequestFor` takes its ordinal from `decision.attemptNo`, which
 * `decideDunning` produces. The two had already drifted — it inspected only
 * the last element, so on `[unknown, failed]` it returned a FRESH ordinal
 * while attempt 1 was still unanswered, which by this module's own argument
 * is a second debit, and its docstring claimed the opposite. It also derived
 * the ordinal from array position rather than from any recorded ordinal, so
 * a non-contiguous history produced the wrong key.
 *
 * The ordinal has exactly ONE source: `decideDunning`. A dead exported
 * factory was removed in round 4 for the same reason.
 */

export interface CollectionRequestInput {
  /** The merchant being charged. The port carries it; the KEY does not. */
  readonly businessId: string;
  readonly invoiceId: string;
  readonly decision: DunningDecision;
  readonly amount: Price;
  /** The provider-side token for the instrument, as the merchant's setup recorded it. */
  readonly instrumentRef: string;
}

/**
 * Build the one `ChargeRequest` a decision authorizes.
 *
 * The port requires an idempotency key and this is the only function in the
 * slice that can produce one, so a caller cannot reach the provider with a
 * key it invented. A decision that does not say to charge or to reconcile
 * produces no request at all: `wait`, `none` and an exhausted schedule are
 * answers, not permissions.
 *
 * On `reconcile` the returned request is BYTE-IDENTICAL to the one the lost
 * attempt sent, which is what makes the provider answer with its record of
 * that charge instead of making a new one.
 */
export function collectionRequestFor(input: CollectionRequestInput): ChargeRequest {
  const decision = input?.decision;
  if (!decision || (decision.action !== 'charge' && decision.action !== 'reconcile')) {
    refuse('billing.collection_not_due', 'the dunning schedule does not authorize a provider call now', {
      attemptNo: decision?.attemptNo,
    });
  }
  if (typeof input.businessId !== 'string' || input.businessId.trim().length === 0) {
    refuse('billing.collection_identity_invalid', 'a collection attempt must name the business being charged');
  }
  if (typeof input.instrumentRef !== 'string' || input.instrumentRef.trim().length === 0) {
    refuse('billing.collection_identity_invalid', 'a collection attempt must name the payment instrument to charge');
  }
  const amount = input.amount;
  if (!amount || typeof amount.amountMinor !== 'bigint' || amount.amountMinor <= 0n) {
    // The port validates the amount too; this refusal is here so that a
    // caller that composed a zero or negative collection never reaches a
    // provider at all, and is told in this slice's own vocabulary.
    refuse('billing.collection_identity_invalid', 'a collection attempt must carry a positive exact amount');
  }
  return {
    businessId: input.businessId,
    amount,
    idempotencyKey: collectionAttemptKey({ invoiceId: input.invoiceId, attemptNo: decision.attemptNo }),
    instrumentRef: input.instrumentRef,
  };
}
