/**
 * `TL-P5-R5` — PLATFORM CREDIT APPLICATION (directive #11, PART 25).
 *
 * The ruling, clause by clause, and every clause is a property of this file:
 *
 *   APPLY AVAILABLE PLATFORM CREDIT AUTOMATICALLY WHEN A FUTURE PLATFORM
 *   SUBSCRIPTION INVOICE IS FINALIZED. Allocation: oldest eligible credit
 *   grant first, ordered deterministically by `created_at`, then stable id.
 *   Application: atomic with platform invoice finalization; up to invoice
 *   amount only; invoice payable cannot become negative; credit remainder
 *   carries forward; no zero-value noise rows; exact conservation proof
 *   required. Platform only — no merchant AR/journal implication.
 *
 * ── Why this is a separate module from `credit.ts` ──────────────────────
 *
 * `credit.ts` answers "what is owed to this business", which is solvency.
 * This file answers "which grants fund this invoice, and what is left to
 * pay", which is allocation. Keeping them apart is what lets the balance
 * authority be read on its own, and it is why the allocator cannot adjust a
 * balance: it has no way to, and it re-folds the ledger afterwards to check
 * that it did not.
 *
 * ── "Exact conservation proof required" — what is actually proven ───────
 *
 * Three independent equalities, each computed from different numbers:
 *
 *   1. `applied + payable === invoiceTotal`           (the invoice side)
 *   2. `sum(consumption amounts) === applied`         (the ledger side)
 *   3. re-folding the ledger WITH the new consumptions appended gives
 *      `balanceBefore − applied`                      (the authority side)
 *
 * (3) is the one that matters, and it is why this module ends by calling
 * `foldCreditBalance` on its own output. The allocator could satisfy (1) and
 * (2) while writing rows the balance authority would reject — drawing a grant
 * past its own remainder, naming a grant that does not exist, breaking ledger
 * order. Checking its work with the authority that will later read it is the
 * difference between arithmetic that balances and rows that are valid.
 *
 * ── Atomicity is NOT provided here, and saying so is the point ──────────
 *
 * "Atomic with platform invoice finalization" is a database property. This
 * module is pure: it computes the rows a finalization must write, and it
 * cannot stop two concurrent finalizations from each reading the same balance
 * and each spending it. That is a genuine double-spend, it is exactly what
 * PART 115's pre-mortem asks about, and the only place it can be closed is
 * the schema plus the transaction that writes these rows — which is why the
 * MIGRATION PATCH REQUEST demands a per-business lock and a per-grant
 * conservation constraint, and why this seam is classified
 * `WAITING_FOR_INTEGRATED_SURFACE` and not `PROVEN BY TEST` for atomicity.
 * A pure function that claimed atomicity would be the worst kind of green.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────
 *
 * No cash refund, no payout, no provider disbursement, no expiry, no
 * write-off, no reversal — all six are forbidden by PART 25 ("reversal only
 * through explicit append-only correction if a later accepted financial rule
 * supplies it", and no such rule exists yet), and
 * `test/credit-application.test.ts` asserts their absence over this module's
 * own blanked source, because every one of those words appears in the prose
 * above.
 */
import { foldCreditBalance, type CreditAdjustment, type CreditBalance, type CreditLedgerScope } from './credit';
import { refuse } from './errors';
import { MAX_BILLING_MINOR } from './types';

export interface CreditApplicationInput {
  readonly scope: CreditLedgerScope;
  /** The ledger as the database returns it: `ORDER BY created_at, id`. */
  readonly ledger: readonly CreditAdjustment[];
  /** The finalized invoice's total. Positive; `invoice.ts` refuses the rest. */
  readonly invoiceTotalMinor: bigint;
  /**
   * The finalized invoice's currency. MANDATORY, and not defaulted from the
   * ledger.
   *
   * B1: until this field existed the invoice side carried no currency at all,
   * so `payableMinor = invoiceTotalMinor - appliedMinor` subtracted a balance
   * in the LEDGER's currency from a total in no declared currency, and the
   * result was stamped with the ledger's. Measured before the fix: an ILS
   * balance of 5000 against a total of 10000 was accepted as
   * `currency=ILS applied=5000 payable=5000`. A conservation proof stated in
   * one unit cannot see that, because every figure in it came from the ledger.
   *
   * Optional-with-a-default would not have closed it: a caller that omits the
   * currency is a caller that does not know it, and the quantity it is
   * subtracting from is then unknown too.
   */
  readonly invoiceCurrency: string;
  /** The invoice being finalized. An identifier; it becomes each row's `ref`. */
  readonly invoiceRef: string;
  /** The finalization instant. Supplied by the command; never a clock. */
  readonly appliedAt: string;
  /**
   * Identities for the consumption rows, minted by the command, used in
   * order. At most one per grant drawn down.
   *
   * They are not generated here for the same reason `plan-change.ts` does not
   * generate its adjustment id: a row whose identity this function invented
   * could not be recognised as a replay by `foldCreditBalance`, and replay is
   * the one way an append-only ledger still produces a wrong balance. If the
   * caller supplies too few, the application is REFUSED rather than partially
   * applied — a partial application is a lost credit that balances.
   */
  readonly consumptionIds: readonly string[];
  readonly reason: string;
}

export interface CreditApplication {
  readonly currency: string;
  readonly invoiceTotalMinor: bigint;
  /** What the credit covered. `0n` when there is no credit, with no rows. */
  readonly appliedMinor: bigint;
  /** What is left for the provider to charge. Never negative. */
  readonly payableMinor: bigint;
  /** The rows a finalization must append, in allocation order. Never zero-valued. */
  readonly consumptions: readonly CreditAdjustment[];
  readonly balanceBeforeMinor: bigint;
  /** The remainder that carries forward. */
  readonly balanceAfterMinor: bigint;
  /** The balance the ledger WITH these rows appended folds to. The witness. */
  readonly balanceAfter: CreditBalance;
}

/**
 * Apply available platform credit to a finalizing platform subscription
 * invoice.
 *
 * Automatic by default, per the ruling: there is no "whether" argument. A
 * caller who wanted to skip application would have to not call this, which is
 * a visible choice at the finalization site rather than a flag nobody reads.
 */
export function applyCreditToInvoice(input: CreditApplicationInput): CreditApplication {
  if (typeof input?.invoiceRef !== 'string' || input.invoiceRef.trim().length === 0) {
    refuse('billing.payload_invalid', 'a credit application must name the invoice being finalized');
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    refuse('billing.credit_reason_required', 'a credit application must state why it exists');
  }
  if (typeof input.appliedAt !== 'string' || !Number.isFinite(Date.parse(input.appliedAt))) {
    refuse('billing.as_of_required', 'a credit application must carry a parseable instant');
  }
  if (typeof input.invoiceTotalMinor !== 'bigint') {
    refuse('billing.payload_invalid', 'an invoice total must be an exact integer of minor units');
  }
  if (input.invoiceTotalMinor <= 0n || input.invoiceTotalMinor > MAX_BILLING_MINOR) {
    // Zero and negative are both refused rather than short-circuited: a
    // finalization of a non-positive invoice is a defect upstream, and
    // returning "nothing applied" would hide it.
    refuse('billing.payload_invalid', 'a credit application needs a positive invoice total within the money cap');
  }
  if (!Array.isArray(input.consumptionIds as unknown)) {
    refuse('billing.payload_invalid', 'a credit application needs the identities its rows will carry');
  }
  if (typeof input.invoiceCurrency !== 'string' || !/^[A-Z]{3}$/.test(input.invoiceCurrency)) {
    // The shape is checked before the comparison so that `ils` refuses as a
    // malformed payload and not as a mismatch: a lower-case code is a caller
    // defect, and normalizing it here would decide a currency on the caller's
    // behalf.
    refuse('billing.payload_invalid', 'a credit application must name the invoice currency as a three-letter code');
  }
  if (typeof input.scope?.currency !== 'string' || !/^[A-Z]{3}$/.test(input.scope.currency)) {
    // The SCOPE's shape is checked here too, and as a payload defect. Without
    // this, an absent or malformed scope currency fell through to the
    // comparison below and left as `billing.credit_currency_mismatch` — a
    // business outcome — where `foldCreditBalance` had refused it as
    // `billing.payload_invalid` before this field existed. `errors.ts` draws
    // that line explicitly: a malformed command is not a business outcome and
    // the two never share a code. Measured on both sides of the change.
    refuse('billing.payload_invalid', 'a credit application must name the ledger currency as a three-letter code');
  }
  if (input.invoiceCurrency !== input.scope.currency) {
    // B1. The subtraction below is only a quantity when both sides are the
    // same unit. Refused by name, never converted: this slice holds no rate
    // and a platform subscription credit is not an FX operation.
    //
    // DECLARED LIMIT, in the same voice as `refold_equals_rebuild`: this
    // comparison is NOT independently pinned by the suite. Deleting it alone
    // leaves every case green, because the post-fold comparison below then
    // catches the same inputs — with an empty ledger the fold returns the
    // scope's own currency, so the two checks mask each other. They are a
    // layered defence and the tests pin the BEHAVIOUR, not either check, and
    // no input this module accepts can separate them.
    refuse('billing.credit_currency_mismatch', 'a credit application may not apply a balance to an invoice in another currency', {
      currency: input.invoiceCurrency,
    });
  }

  // The balance authority is consulted, never re-implemented. Every ledger
  // rule — one business, one currency, append-only order, per-grant
  // remainders — is enforced by this call and not restated here.
  const before = foldCreditBalance(input.ledger, input.scope);

  if (before.currency !== input.invoiceCurrency) {
    // The fold already refuses a row whose currency is not the scope's, so
    // with the check above this is unreachable through any input this module
    // accepts. It is asserted anyway because `before.currency` is the value
    // that LEAVES this function, stamped on every consumption row and on the
    // application itself: a third currency arriving here would be published
    // rather than refused, and an unreachable refusal costs one comparison.
    refuse('billing.credit_currency_mismatch', 'the folded balance and the invoice do not state one currency', {
      currency: before.currency,
    });
  }

  if (before.balanceMinor === 0n) {
    // "No zero-value noise rows." A business with no credit produces no rows
    // at all, not a row of zero.
    return {
      currency: before.currency,
      invoiceTotalMinor: input.invoiceTotalMinor,
      appliedMinor: 0n,
      payableMinor: input.invoiceTotalMinor,
      consumptions: [],
      balanceBeforeMinor: 0n,
      balanceAfterMinor: 0n,
      balanceAfter: before,
    };
  }

  // "Up to invoice amount only."
  const appliedMinor = before.balanceMinor < input.invoiceTotalMinor ? before.balanceMinor : input.invoiceTotalMinor;

  // "Oldest eligible credit grant first." `before.grants` is in ledger order,
  // which the database supplies as `ORDER BY created_at, id` and which
  // `foldCreditBalance` has already verified is oldest-first — so the
  // allocator does not sort, and could not: a sort here would silently repair
  // an order the authority would have refused.
  const consumptions: CreditAdjustment[] = [];
  let remaining = appliedMinor;
  let idAt = 0;
  for (const grant of before.grants) {
    if (remaining === 0n) break;
    if (grant.remainingMinor === 0n) continue; // exhausted; no noise row
    const take = grant.remainingMinor < remaining ? grant.remainingMinor : remaining;
    const id = input.consumptionIds[idAt];
    if (typeof id !== 'string' || id.trim().length === 0) {
      refuse('billing.credit_application_ids_exhausted', 'the caller supplied too few identities for the rows this application needs', {
        businessId: before.businessId,
        currency: before.currency,
      });
    }
    idAt++;
    consumptions.push({
      id,
      businessId: before.businessId,
      kind: 'consumption',
      amountMinor: take,
      currency: before.currency,
      occurredAt: input.appliedAt,
      ref: input.invoiceRef,
      reason: input.reason,
      appliesToGrantId: grant.grantId,
    });
    remaining -= take;
  }

  if (remaining !== 0n) {
    refuse('billing.invariant_violated', 'the allocation did not place the whole applied amount', {
      invariant: 'allocation_places_applied_amount',
      currency: before.currency,
    });
  }

  const payableMinor = input.invoiceTotalMinor - appliedMinor;

  // Conservation (1): the invoice side.
  if (payableMinor < 0n) {
    refuse('billing.invariant_violated', 'an invoice payable may not become negative', {
      invariant: 'payable_non_negative',
      currency: before.currency,
    });
  }
  if (appliedMinor + payableMinor !== input.invoiceTotalMinor) {
    refuse('billing.invariant_violated', 'applied plus payable is not the invoice total', {
      invariant: 'applied_plus_payable_is_total',
      currency: before.currency,
    });
  }

  // Conservation (2): the ledger side, summed from the rows themselves.
  let rowSum = 0n;
  for (const c of consumptions) {
    if (c.amountMinor <= 0n) {
      refuse('billing.invariant_violated', 'a credit application may not write a zero-value row', {
        invariant: 'no_zero_value_rows',
        currency: before.currency,
      });
    }
    rowSum += c.amountMinor;
  }
  if (rowSum !== appliedMinor) {
    refuse('billing.invariant_violated', 'the consumption rows do not sum to the applied amount', {
      invariant: 'rows_sum_to_applied',
      currency: before.currency,
    });
  }

  // Conservation (3): the authority side. The rows are handed back to the
  // balance authority that will later read them, appended to the ledger they
  // were derived from. This is the check that catches rows which balance but
  // are not valid.
  const after = foldCreditBalance([...input.ledger, ...consumptions], input.scope);
  // The RE-FOLD above is load-bearing and proved so: replacing it with
  // arithmetic reddens this module's suite, and it is also what catches an
  // allocator that sorted the ledger into an order the authority refuses.
  //
  // The COMPARISON below is a different matter — it is unreachable given
  // conservation (2), because rows that sum to `applied` and that the fold
  // accepted cannot fold to anything but `balance − applied`. It is kept as a
  // second witness and labelled, rather than deleted, for the same reason as
  // `balance_never_negative` in `credit.ts`: a later allocator that stops
  // satisfying (2) would arrive here first. Removing it alone is undetectable
  // by any test, which is a fact about dead code and not a gap in the suite.
  if (after.balanceMinor !== before.balanceMinor - appliedMinor) {
    refuse('billing.invariant_violated', 'the ledger with these rows appended does not fold to the carried-forward remainder', {
      invariant: 'refold_equals_balance_minus_applied',
      currency: before.currency,
    });
  }

  return {
    currency: before.currency,
    invoiceTotalMinor: input.invoiceTotalMinor,
    appliedMinor,
    payableMinor,
    consumptions,
    balanceBeforeMinor: before.balanceMinor,
    balanceAfterMinor: after.balanceMinor,
    balanceAfter: after,
  };
}
