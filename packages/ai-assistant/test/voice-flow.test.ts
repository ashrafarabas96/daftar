/**
 * P12 — Mission §19: voice is listen → review → result; on ambiguity ASK; never present an
 * unconfirmed commitment.
 *
 * The three laws are tested separately because each fails on its own, and the third one fails
 * silently: a member told "done" when nothing committed has no way to find out from the screen.
 */

import { describe, expect, it } from 'vitest';
import { afterListen, afterReview, mayPresentAsCommitted, stepTransitionAllowed, VOICE_STEPS, type Heard } from '../src/voice-flow';

const FLOOR = 0.8;

function heard(overrides: Partial<Heard> = {}): Heard {
  return { transcriptPresent: true, intent: 'sale.create', candidates: ['c1'], confidence: 0.95, ...overrides };
}

describe('the three steps, and the edges that do not exist', () => {
  it('names exactly three steps in order', () => {
    expect([...VOICE_STEPS]).toEqual(['listen', 'review', 'result']);
  });

  it('allows only listen → review and review → result', () => {
    expect(stepTransitionAllowed('listen', 'review')).toBe(true);
    expect(stepTransitionAllowed('review', 'result')).toBe(true);
  });

  it('has NO listen → result edge — "it was obvious, we skipped the review" is unexpressible', () => {
    expect(stepTransitionAllowed('listen', 'result')).toBe(false);
  });

  it('makes a result terminal, so a shown result cannot be quietly rewritten', () => {
    for (const to of VOICE_STEPS) expect(stepTransitionAllowed('result', to)).toBe(false);
  });

  it('allows no step to repeat or run backwards', () => {
    expect(stepTransitionAllowed('listen', 'listen')).toBe(false);
    expect(stepTransitionAllowed('review', 'review')).toBe(false);
    expect(stepTransitionAllowed('review', 'listen')).toBe(false);
  });
});

describe('listen never produces a result, and ambiguity ASKS rather than guessing', () => {
  it('produces a review for a single confident candidate', () => {
    const decision = afterListen(heard(), FLOOR);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.kind).toBe('review');
      if (decision.value.kind === 'review') expect(decision.value.review.resolvedEntityId).toBe('c1');
    }
  });

  it('ASKS when more than one candidate matched, and hands the member the candidates', () => {
    const decision = afterListen(heard({ candidates: ['c1', 'c2', 'c3'] }), FLOOR);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.kind).toBe('ask');
      if (decision.value.kind === 'ask') {
        expect(decision.value.question.candidates).toEqual(['c1', 'c2', 'c3']);
        expect(decision.value.question.field).toBe('entity');
      }
    }
  });

  it('ASKS EVEN WHEN confidence is maximal — a high score is not a resolution of ambiguity', () => {
    // The hazard: "confidence 0.99, so take the top candidate". Confidence is about the transcription
    // and the intent, not about which of two real customers the member meant.
    const decision = afterListen(heard({ candidates: ['c1', 'c2'], confidence: 1 }), FLOOR);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.value.kind).toBe('ask');
  });

  it('never returns a result from the listen step, whatever it was given', () => {
    for (const h of [heard(), heard({ candidates: ['a', 'b'] }), heard({ confidence: 1 })]) {
      const decision = afterListen(h, FLOOR);
      if (decision.ok) expect(decision.value.kind).not.toBe('result');
    }
  });

  it.each([
    ['an unintelligible capture', { transcriptPresent: false }, 'ai_stt.unintelligible'],
    ['no recognized intent', { intent: undefined }, 'ai_intent.unknown_intent'],
    ['confidence below the floor', { confidence: 0.79 }, 'ai_intent.low_confidence'],
    ['no candidate at all', { candidates: [] }, 'ai_intent.entity_not_found'],
  ] as const)('refuses %s by name', (_label, overrides, code) => {
    const decision = afterListen(heard(overrides), FLOOR);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe(code);
  });

  it('takes the confidence floor as an argument — there is no default to forget', () => {
    // The same input is accepted under one floor and refused under a stricter one, which is only
    // observable because the floor is passed rather than baked in.
    expect(afterListen(heard({ confidence: 0.85 }), 0.8).ok).toBe(true);
    expect(afterListen(heard({ confidence: 0.85 }), 0.9).ok).toBe(false);
  });
});

describe('a result is never presented as committed before the server committed', () => {
  it('refuses to reach a result without a completed review', () => {
    const decision = afterReview(false, { committed: true, businessTransactionId: 'tx1' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.wrong_state');
      expect(decision.refusal.field).toBe('review');
    }
  });

  it('presents a committed result only with a transaction identity in hand', () => {
    const decision = afterReview(true, { committed: true, businessTransactionId: 'tx1' });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.presentation).toBe('committed');
      expect(mayPresentAsCommitted(decision.value)).toBe(true);
    }
  });

  it('reports PENDING when the server said committed but returned NO transaction id', () => {
    // "The server said ok" is not "the server committed", and to a merchant they are the same
    // sentence. The missing identity decides it, not the flag.
    const decision = afterReview(true, { committed: true, businessTransactionId: undefined });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.presentation).toBe('pending');
      expect(mayPresentAsCommitted(decision.value)).toBe(false);
    }
  });

  it('reports PENDING when nothing committed', () => {
    const decision = afterReview(true, { committed: false, businessTransactionId: undefined });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(mayPresentAsCommitted(decision.value)).toBe(false);
  });

  it('refuses to treat a transaction id without a commit as success', () => {
    const decision = afterReview(true, { committed: false, businessTransactionId: 'tx1' });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(mayPresentAsCommitted(decision.value)).toBe(false);
  });

  it('NON-VACUITY: mayPresentAsCommitted is true for exactly one of the shapes above', () => {
    const shapes = [
      afterReview(true, { committed: true, businessTransactionId: 'tx1' }),
      afterReview(true, { committed: true, businessTransactionId: undefined }),
      afterReview(true, { committed: false, businessTransactionId: undefined }),
      afterReview(true, { committed: false, businessTransactionId: 'tx1' }),
    ];
    const committed = shapes.filter((d) => d.ok && mayPresentAsCommitted(d.value));
    expect(committed).toHaveLength(1);
  });
});
