/**
 * P12 — draft state machine and the confirm decision.
 *
 * SCOPE LIMIT: nothing here asserts a platform visibility mechanism. The law under test is that an
 * unfetched draft REFUSES rather than proceeding — which holds whatever can hide a row, and is the
 * defect class Phase 4 met three times.
 */

import { describe, expect, it } from 'vitest';
import {
  canTransition,
  checkNotExpired,
  decideConfirm,
  DRAFT_STATES,
  isTerminal,
  transition,
  type ConfirmRequest,
  type FetchedDraft,
} from '../src/draft-state';

const NOW = new Date('2026-10-07T12:00:00Z');
const LATER = new Date('2026-10-07T13:00:00Z');

function draft(overrides: Partial<FetchedDraft> = {}): FetchedDraft {
  return {
    draftId: 'd1',
    tenantId: 't1',
    businessId: 'b1',
    actorUserId: 'u1',
    state: 'awaiting_confirmation',
    version: 1,
    previewDigest: 'digest-1',
    expiresAt: LATER,
    ...overrides,
  };
}

function request(overrides: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return { draftId: 'd1', tenantId: 't1', businessId: 'b1', actorUserId: 'u1', submittedDigest: 'digest-1', submittedVersion: 1, ...overrides };
}

describe('state machine', () => {
  it('reaches executed only from confirmed', () => {
    for (const from of DRAFT_STATES) {
      if (from === 'confirmed') expect(canTransition(from, 'executed')).toBe(true);
      else expect(canTransition(from, 'executed')).toBe(false);
    }
  });

  it('leaves every terminal state closed', () => {
    for (const from of DRAFT_STATES) {
      if (!isTerminal(from)) continue;
      for (const to of DRAFT_STATES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('routes an edit back through awaiting_confirmation', () => {
    expect(canTransition('awaiting_confirmation', 'edited')).toBe(true);
    expect(canTransition('edited', 'awaiting_confirmation')).toBe(true);
    // An edit may never go straight to confirmed: that would confirm what nobody re-read.
    expect(canTransition('edited', 'confirmed')).toBe(false);
  });

  it('refuses a forbidden transition by name, naming the edge', () => {
    const decision = transition('created', 'executed');
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.wrong_state');
      expect(decision.refusal.detail).toBe('created->executed');
    }
  });
});

describe('expiry uses the supplied transaction clock', () => {
  it('refuses when the transaction clock is at or past the expiry', () => {
    expect(checkNotExpired(NOW, NOW).ok).toBe(false);
    const past = checkNotExpired(NOW, LATER);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.refusal.code).toBe('ai_draft.expired');
  });

  it('allows while the transaction clock is before the expiry', () => {
    expect(checkNotExpired(LATER, NOW).ok).toBe(true);
  });
});

describe('decideConfirm — an unfetched draft refuses, never proceeds (Law P12-L4)', () => {
  it('refuses ai_draft.not_visible when the row was not fetched — never proceeds as if absent', () => {
    const decision = decideConfirm(undefined, request(), NOW, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.not_visible');
      expect(decision.refusal.detail).toBe('d1');
    }
  });

  it('refuses a draft belonging to another tenant without revealing more', () => {
    const decision = decideConfirm(draft({ tenantId: 't2' }), request(), NOW, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_draft.not_visible');
  });

  it('refuses a draft belonging to another business', () => {
    const decision = decideConfirm(draft({ businessId: 'b2' }), request(), NOW, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_draft.not_visible');
  });

  it('TOCTOU: authority held at draft time and revoked by confirm time refuses', () => {
    const decision = decideConfirm(draft(), request(), NOW, false);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_draft.authority_revoked');
  });

  it('replay returns the ORIGINAL transaction id rather than re-executing', () => {
    const decision = decideConfirm(draft(), request(), NOW, true, 'txn-original');
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.already_executed');
      expect(decision.refusal.detail).toBe('txn-original');
    }
  });

  it('refuses a second confirm of an executed draft', () => {
    const decision = decideConfirm(draft({ state: 'executed' }), request(), NOW, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_draft.already_executed');
  });

  it('refuses a stale version, naming the version field', () => {
    const decision = decideConfirm(draft({ version: 2 }), request({ submittedVersion: 1 }), NOW, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.preview_digest_mismatch');
      expect(decision.refusal.field).toBe('version');
    }
  });

  it('refuses a mismatched digest, naming the digest field', () => {
    const decision = decideConfirm(draft(), request({ submittedDigest: 'tampered' }), NOW, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.preview_digest_mismatch');
      expect(decision.refusal.field).toBe('digest');
    }
  });

  it('refuses an expired draft before looking at the digest', () => {
    const decision = decideConfirm(draft({ expiresAt: NOW }), request(), LATER, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_draft.expired');
  });

  it('refuses a draft in a state that cannot be confirmed', () => {
    const decision = decideConfirm(draft({ state: 'created' }), request(), NOW, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('ai_draft.wrong_state');
  });

  it('allows exactly the sound case', () => {
    const decision = decideConfirm(draft(), request(), NOW, true);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.nextState).toBe('confirmed');
      expect(decision.value.draft.draftId).toBe('d1');
    }
  });

  it('NON-VACUITY: the sound case passes, so every refusal above is caused by its own defect', () => {
    // Without this, each refusal case could be passing because the sound path refuses too.
    expect(decideConfirm(draft(), request(), NOW, true).ok).toBe(true);
  });
});
