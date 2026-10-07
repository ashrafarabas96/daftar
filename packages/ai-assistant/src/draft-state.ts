/**
 * DAFTAR Phase 12 — the draft state machine.
 *
 * P12-S0-ARCHITECTURE-CONTRACT §4.2. A draft is NOT a financial record: nothing in accounting,
 * inventory or settlement reads it, and it contributes zero to every authoritative total.
 *
 * Every transition is an APPEND. No status is mutated in place and no row is deleted (PART 12:
 * corrections are append/reversal).
 *
 * STATUS: PREPARED / NOT PROMOTED.
 */

import { allow, deny, refuse, type Decision } from './refusals';

export const DRAFT_STATES = ['created', 'awaiting_confirmation', 'confirmed', 'executed', 'edited', 'rejected', 'expired'] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

export const TERMINAL_STATES: readonly DraftState[] = ['executed', 'rejected', 'expired'];

/**
 * The complete transition table. A pair absent from this map is forbidden — the machine is closed,
 * so a new edge is a visible change to this table and not an emergent behaviour of a condition
 * somewhere.
 */
const ALLOWED: Readonly<Record<DraftState, readonly DraftState[]>> = {
  created: ['awaiting_confirmation', 'rejected', 'expired'],
  awaiting_confirmation: ['confirmed', 'edited', 'rejected', 'expired'],
  // An edit re-enters awaiting_confirmation and bumps the version, which invalidates the previous
  // preview digest. That is the mechanism by which "the human approved THIS" stays true (§4.2).
  edited: ['awaiting_confirmation', 'rejected', 'expired'],
  confirmed: ['executed', 'rejected'],
  executed: [],
  rejected: [],
  expired: [],
};

export function isTerminal(state: DraftState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: DraftState, to: DraftState): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function transition(from: DraftState, to: DraftState): Decision<DraftState> {
  if (!canTransition(from, to)) return deny(refuse('ai_draft.wrong_state', { detail: `${from}->${to}` }));
  return allow(to);
}

/**
 * Expiry is decided by the clock authority passed in, which production wires to the DATABASE
 * transaction clock inside the confirming transaction.
 *
 * Never a client-supplied time, and never an application-server clock read earlier in the request:
 * one clock authority, read at the moment of the decision. A Phase 4 S7 finding was a routine
 * reading a machine clock where the caller was required to supply the instant.
 */
export function checkNotExpired(expiresAt: Date, txNow: Date): Decision<true> {
  if (txNow.getTime() >= expiresAt.getTime()) return deny(refuse('ai_draft.expired'));
  return allow(true);
}

/**
 * A draft as the confirm path must POSITIVELY fetch it — contract §5.5 / Law P12-L4.
 *
 * REQUIREMENT, not a claim about any platform mechanism: wherever a visibility rule can hide a row,
 * a count or an existence test cannot tell "no such row" from "a row I may not see", so reading that
 * one answer as absence makes the guard fail open. Phase 4 met this defect class three times. This
 * type exists so that the confirm decision below cannot be called without a fetched row: there is no
 * overload that takes a count, and a caller holding `undefined` must refuse. Which mechanism can
 * hide the row, and under what conditions, is the security authority's to state — the obligation
 * here holds whatever the answer is.
 */
export interface FetchedDraft {
  readonly draftId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly actorUserId: string;
  readonly state: DraftState;
  readonly version: number;
  readonly previewDigest: string;
  readonly expiresAt: Date;
}

export interface ConfirmRequest {
  readonly draftId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly actorUserId: string;
  readonly submittedDigest: string;
  readonly submittedVersion: number;
}

/**
 * The confirm decision, in the order the contract requires.
 *
 * `fetched === undefined` is `ai_draft.not_visible` and NEVER "nothing to do": absent and invisible
 * can arrive as one answer, and the safe reading of that one answer is refusal. The proof plan
 * measures exactly this, including a red proof that replaces the positive fetch with an existence
 * test.
 */
export function decideConfirm(
  fetched: FetchedDraft | undefined,
  request: ConfirmRequest,
  txNow: Date,
  stillAuthorized: boolean,
  alreadyExecutedTransactionId?: string,
): Decision<{ readonly nextState: DraftState; readonly draft: FetchedDraft }> {
  if (fetched === undefined) return deny(refuse('ai_draft.not_visible', { detail: request.draftId }));
  if (fetched.tenantId !== request.tenantId || fetched.businessId !== request.businessId) {
    return deny(refuse('ai_draft.not_visible', { detail: request.draftId }));
  }
  // The replay answer carries the ORIGINAL transaction id: a retry is answered, not re-executed.
  if (alreadyExecutedTransactionId !== undefined) {
    return deny(refuse('ai_draft.already_executed', { detail: alreadyExecutedTransactionId }));
  }
  if (fetched.state === 'executed') return deny(refuse('ai_draft.already_executed', { detail: fetched.draftId }));
  // Authority is re-evaluated at confirmation time against freshly loaded rows: a permission held at
  // draft time and revoked since must refuse (contract §3.3, proof plan T1).
  if (!stillAuthorized) return deny(refuse('ai_draft.authority_revoked'));
  const notExpired = checkNotExpired(fetched.expiresAt, txNow);
  if (!notExpired.ok) return notExpired;
  if (fetched.version !== request.submittedVersion) {
    return deny(refuse('ai_draft.preview_digest_mismatch', { field: 'version' }));
  }
  if (fetched.previewDigest !== request.submittedDigest) {
    return deny(refuse('ai_draft.preview_digest_mismatch', { field: 'digest' }));
  }
  const next = transition(fetched.state, 'confirmed');
  if (!next.ok) return deny(next.refusal);
  return allow({ nextState: next.value, draft: fetched });
}
