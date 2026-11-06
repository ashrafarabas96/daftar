/**
 * The subscription invoice's lifecycle — the settled side of the round-6
 * Contract Diff.
 *
 * ── Why this file exists ───────────────────────────────────────────────
 *
 * Master Continuous Mission V3 §12 requires the Contract Diff between the
 * `subscription_invoices` STATES and fixed fields in the earlier spec, the
 * `draft → finalized` path that applies credit and payable, and the scratch
 * DDL, to be settled before promotion. It had to be: the two documents had
 * grown two different vocabularies for one relation.
 *
 * - The earlier spec (`P5-MIGRATION-PATCH-REQUEST.md` §5, rounds 1–3) gave
 *   the states as `open | paid | uncollectible | voided`, the money as
 *   `charge_minor`, `credit_minor`, `tax_minor`, `total_minor`, and the
 *   total as `charge − credit + tax`.
 * - Round 5's executed DDL gave the states as `draft | finalized` and the
 *   money as `total_minor`, `credit_applied_minor`, `payable_minor`, with
 *   `payable = total − credit`.
 *
 * Both call a column `total_minor` and they mean DIFFERENT amounts: the
 * earlier spec's `total_minor` is what the merchant owes AFTER credit, and
 * round 5's is the invoice before credit. A migration written from one
 * document and a command written from the other would both compile, both
 * pass their own tests, and disagree by exactly the credit applied. That is
 * the worst shape a contract conflict can take, and it was mine — one
 * relation, two truths, which is the law this phase breaks on every other
 * page.
 *
 * ── What was settled, and on what grounds ─────────────────────────────
 *
 * The earlier spec's vocabulary wins, because it is the one the invoice LINES
 * sum into, the one `composeSubscriptionInvoice` already computes, and the
 * one the sealed Phase 4 sales relations mirror; round 5's names were a
 * fixture's convenience. So `charge_minor` is the composed invoice,
 * `credit_minor` is the platform credit applied, `tax_minor` is the
 * structural zero, and `total_minor` is what is left to collect. Round 5's
 * `payable_minor` IS that `total_minor`, and `payable never negative` is
 * `total_minor >= 0`.
 *
 * `finalized` is NOT kept as a state. A finalized, uncollected invoice is
 * exactly what the earlier spec calls `open`, and two names for one state is
 * how a sign gets lost. What round 5 proved is not a state but a
 * TRANSITION — `draft → open` — and that transition is the one moment the
 * credit is applied. `draft` is a genuine addition: the earlier spec had no
 * way to compose an invoice before deciding its credit, and the executed
 * proofs need one, because an invoice that is born with its credit already
 * applied cannot be attacked in two steps.
 *
 * ── The consequence for the immutability trigger ──────────────────────
 *
 * The earlier spec's trigger allowed only `state` to change. That would
 * REFUSE the finalization this phase is built on, because finalization also
 * writes the credit and the total. So the settled contract names exactly
 * which columns the one transition may write, and freezes everything else —
 * recorded in the patch request, pinned to this file by
 * `test/db/credit-ledger-contract.test.ts`, which reads the CHECK and the
 * trigger out of the live catalogue rather than trusting either document.
 */
import { refuse } from './errors';

/**
 * Every state a platform subscription invoice can be in. A closed set, in
 * lifecycle order.
 */
export const SUBSCRIPTION_INVOICE_STATES = ['draft', 'open', 'paid', 'uncollectible', 'voided'] as const;
export type SubscriptionInvoiceState = (typeof SUBSCRIPTION_INVOICE_STATES)[number];

/**
 * States from which nothing moves. A settled invoice is immutable, as the
 * project's financial constitution requires; a correction is a new document.
 */
export const TERMINAL_INVOICE_STATES: readonly SubscriptionInvoiceState[] = ['paid', 'uncollectible', 'voided'];

/**
 * The columns the finalization transition may write, and the only ones.
 *
 * `credit_minor` and `total_minor` because applying credit is what
 * finalization IS; `issued_at` because a draft has no issue instant and an
 * open invoice must have one. The period, the business, the currency and the
 * charge are fixed at composition: an invoice whose period could be edited
 * after the fact is an invoice whose uniqueness per period means nothing.
 */
export const FINALIZATION_WRITABLE_COLUMNS: readonly string[] = ['state', 'credit_minor', 'total_minor', 'issued_at'];

const ALLOWED: Readonly<Record<SubscriptionInvoiceState, readonly SubscriptionInvoiceState[]>> = {
  // A draft becomes open by finalization, or is abandoned. `voided` is
  // reachable from `draft` on purpose: DELETE is refused forever, so without
  // it an abandoned draft would be immortal and would keep the period's one
  // invoice slot occupied.
  draft: ['open', 'voided'],
  open: ['paid', 'uncollectible', 'voided'],
  paid: [],
  uncollectible: [],
  voided: [],
};

/** Is this a state the contract knows? Total, and it narrows. */
export function isSubscriptionInvoiceState(value: unknown): value is SubscriptionInvoiceState {
  return typeof value === 'string' && (SUBSCRIPTION_INVOICE_STATES as readonly string[]).includes(value);
}

/**
 * May an invoice move from `from` to `to`?
 *
 * A predicate rather than a thrower, so a caller can ASK; `assertInvoice
 * Transition` is the thrower for the path that is about to write. Staying put
 * is not a transition and answers false: a command that "transitions" an
 * invoice to the state it is already in has lost track of what it is doing,
 * and silently allowing it would make a replayed finalization invisible.
 */
export function canTransitionInvoice(from: SubscriptionInvoiceState, to: SubscriptionInvoiceState): boolean {
  if (!isSubscriptionInvoiceState(from) || !isSubscriptionInvoiceState(to)) return false;
  return (ALLOWED[from] ?? []).includes(to);
}

/** The same question, for the caller that is about to write the row. */
export function assertInvoiceTransition(from: SubscriptionInvoiceState, to: SubscriptionInvoiceState): void {
  if (!isSubscriptionInvoiceState(from) || !isSubscriptionInvoiceState(to)) {
    refuse('billing.invoice_state_transition_invalid', 'a subscription invoice transition must name two states the contract knows');
  }
  if (!canTransitionInvoice(from, to)) {
    refuse('billing.invoice_state_transition_invalid', 'the subscription invoice contract does not allow this transition');
  }
}
