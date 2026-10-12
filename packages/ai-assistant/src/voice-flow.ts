/**
 * DAFTAR Phase 12 — the voice interaction flow.
 *
 * Master Continuous Mission §19:
 *
 *   والصوت بثلاث خطوات: listen → review → result. عند الغموض اسأل، ولا تخمّن؛ لا تعرض التزامًا
 *   غير مؤكد.
 *
 *   (voice is three steps: listen → review → result. On ambiguity, ASK — do not guess; never
 *   present an unconfirmed commitment.)
 *
 * Three laws, and each is a structure rather than a UI convention:
 *
 *   1. `result` is unreachable except from a `review` the member actually completed. There is no
 *      listen → result edge, so "it was obvious, we skipped the review" is not expressible.
 *   2. Ambiguity ASKS. It does not pick the best candidate, and it does not pick a candidate because
 *      it scored far above the others. A margin is not a resolution.
 *   3. A `result` may be presented as a committed fact ONLY once the server has committed it. Before
 *      that it is a proposal, and the two are different types rather than the same object with a
 *      different label.
 *
 * Why law 3 is here and not left to the UI: voice makes the gap between "I heard you" and "it is
 * done" invisible to the member — there is nothing on screen between the two. The one consequence a
 * merchant cannot absorb is believing a sale was recorded when it was not, so the honest answer has
 * to be unrepresentable as the dishonest one.
 *
 * STATUS: PREPARED / NOT PROMOTED. Nothing here renders anything; it decides what MAY be rendered.
 */

import { allow, deny, refuse, type Decision } from './refusals';

export const VOICE_STEPS = ['listen', 'review', 'result'] as const;
export type VoiceStep = (typeof VOICE_STEPS)[number];

/**
 * The only legal progression. Note the absences, which carry the law:
 *   - `listen → result` does not exist;
 *   - `result` has no outgoing edge: a result is terminal, and a correction is a new interaction, so
 *     a presented result can never be quietly rewritten into a different one.
 */
const ALLOWED_STEPS: Readonly<Record<VoiceStep, readonly VoiceStep[]>> = {
  listen: ['review'],
  review: ['result'],
  result: [],
};

export function stepTransitionAllowed(from: VoiceStep, to: VoiceStep): boolean {
  return (ALLOWED_STEPS[from] as readonly string[]).includes(to);
}

/**
 * What the `listen` step produced.
 *
 * `candidates` is every reading the resolution produced — not the best one. A single-candidate list is
 * the only unambiguous case, and `confidence` cannot substitute for it.
 */
export interface Heard {
  readonly transcriptPresent: boolean;
  readonly intent: string | undefined;
  readonly candidates: readonly string[];
  readonly confidence: number;
}

/**
 * The mint mark — CHALLENGE round 2, F-10.
 *
 * `ReviewPresentation` was a structural type, so a hand-rolled `{ step: 'review', intent,
 * resolvedEntityId }` was accepted and reached a committed result. The comment above `afterReview`
 * claimed "only `afterListen` mints one" and **nothing enforced that sentence** — a claim in a code
 * file that the code does not keep, which is the same defect class as a false coverage claim in a
 * document.
 *
 * This symbol is module-private and deliberately not exported: outside this file the property
 * cannot be named, so the type cannot be satisfied, so the sentence is now true rather than
 * asserted. The alternative was to soften the comment; the stronger closure is cheap here and the
 * claim is worth keeping.
 */
const MINTED_BY_AFTER_LISTEN: unique symbol = Symbol('voice-flow.mintedByAfterListen');

export interface ReviewPresentation {
  readonly step: 'review';
  readonly intent: string;
  readonly resolvedEntityId: string;
  readonly [MINTED_BY_AFTER_LISTEN]: true;
}

/** A question put back to the member. It carries the candidates, so the member picks — not the model. */
export interface Question {
  readonly step: 'review';
  readonly ask: true;
  readonly field: string;
  readonly candidates: readonly string[];
}

export type ListenOutcome = { readonly kind: 'review'; readonly review: ReviewPresentation } | { readonly kind: 'ask'; readonly question: Question };

/**
 * `listen` → either a review to read, or a question. Never a result, and never a guess.
 *
 * The confidence floor is a REQUIRED argument with no default: a floor that can be omitted becomes a
 * floor someone forgot, and the one it would default to is whatever read well in review.
 */
export function afterListen(heard: Heard, confidenceFloor: number): Decision<ListenOutcome> {
  if (!heard.transcriptPresent) return deny(refuse('ai_stt.unintelligible'));
  if (heard.intent === undefined) return deny(refuse('ai_intent.unknown_intent'));
  if (heard.confidence < confidenceFloor) return deny(refuse('ai_intent.low_confidence', { detail: String(heard.confidence) }));
  if (heard.candidates.length === 0) return deny(refuse('ai_intent.entity_not_found'));
  if (heard.candidates.length > 1) {
    // ASK. Not "take the top candidate", and not "take it because it leads by a wide margin" — a
    // margin is a property of the scoring, not evidence about what the member meant.
    return allow({ kind: 'ask', question: { step: 'review', ask: true, field: 'entity', candidates: heard.candidates } });
  }
  const only = heard.candidates[0];
  if (only === undefined) return deny(refuse('ai_intent.entity_not_found'));
  return allow({ kind: 'review', review: { step: 'review', intent: heard.intent, resolvedEntityId: only, [MINTED_BY_AFTER_LISTEN]: true } });
}

/**
 * The entity a draft may be built on.
 *
 * Mission V2 §19 asks for proof that *"ambiguity does not lead to executing a guess"*. Returning a
 * question from `afterListen` is necessary but not sufficient on its own: a caller holding the
 * `ListenOutcome` could still read `question.candidates[0]` and carry it forward. So the route into a
 * draft goes through this function, which is the ONLY way to get an entity id out of a listen
 * outcome, and which refuses `ai_intent.ambiguous_entity` on the ask branch.
 *
 * The ask shape carries no `resolvedEntityId` at all — the candidates are there for the member to
 * choose from, not for a caller to index into. The refusal is what makes that a law rather than a
 * convention about how to read the type.
 */
export function entityForDraft(outcome: ListenOutcome): Decision<string> {
  if (outcome.kind === 'ask') {
    return deny(
      refuse('ai_intent.ambiguous_entity', {
        field: outcome.question.field,
        detail: `${String(outcome.question.candidates.length)} candidates await the member`,
      }),
    );
  }
  return allow(outcome.review.resolvedEntityId);
}

/**
 * What the `result` step is allowed to say.
 *
 * `committed` means the server's transaction committed and returned an identity. Nothing else sets
 * it: not a dispatched request, not a hopeful optimistic update, not a 2xx without a transaction id.
 */
export interface ServerCommit {
  readonly committed: boolean;
  readonly businessTransactionId: string | undefined;
}

export type ResultPresentation =
  | { readonly step: 'result'; readonly presentation: 'committed'; readonly businessTransactionId: string }
  | { readonly step: 'result'; readonly presentation: 'pending'; readonly committed: false };

/**
 * `review` → `result`, and only with the member's confirmation in hand.
 *
 * It takes the **ReviewPresentation itself**, not a boolean — CHALLENGE F-03. With a bare boolean,
 * law 1's "the listen → result edge is not expressible" was false: `afterReview(true, …)` expressed
 * it, with no review step in existence anywhere. That is the same defect `entityForDraft` was
 * introduced to fix ("returning a question is necessary but not sufficient"), and the seam reasoning
 * had not been carried here. A caller must now hold the artefact a review produced; `afterListen` is
 * the only thing that mints one.
 *
 * Returns the presentation the surface MAY render. A commit with no transaction identity is reported
 * as **pending**, not as success: "the server said ok" is not "the server committed", and the two are
 * the same sentence to a merchant.
 */
export function afterReview(reviewed: ReviewPresentation | undefined, commit: ServerCommit): Decision<ResultPresentation> {
  // The runtime check as well as the type: a JavaScript caller, or one that casts, reaches this.
  if (reviewed === undefined || reviewed.step !== 'review' || reviewed[MINTED_BY_AFTER_LISTEN] !== true) {
    // The listen → result edge, attempted. It refuses at the type's own boundary.
    return deny(refuse('ai_draft.wrong_state', { field: 'review', detail: 'result requires a completed review step' }));
  }
  if (!commit.committed || commit.businessTransactionId === undefined) {
    return allow({ step: 'result', presentation: 'pending', committed: false });
  }
  return allow({ step: 'result', presentation: 'committed', businessTransactionId: commit.businessTransactionId });
}

/**
 * May this presentation be shown as a financial commitment?
 *
 * One predicate, so every surface asks the same question in the same place. A `pending` presentation
 * answers `false`, and there is no third value a caller could coerce into optimism.
 */
export function mayPresentAsCommitted(presentation: ResultPresentation): boolean {
  return presentation.presentation === 'committed';
}
