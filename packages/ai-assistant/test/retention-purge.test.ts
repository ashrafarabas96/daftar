/**
 * P12 — PART 77: tenant-safe purge and a separate audit-metadata lifecycle.
 *
 * The cases are ordered by what they would cost if the law were absent: a cross-tenant purge first,
 * then a purge with no configured cutoff, then one that destroys the audit identity it exists to
 * preserve.
 */

import { describe, expect, it } from 'vitest';
import { AUDIT_IDENTITY_FIELDS, lifecyclesAreSeparate, planPurge, PURGEABLE_CONTENT_FIELDS, type PurgePlan } from '../src/retention-purge';

const CONFIGURED = { keepAudio: false, transcriptDays: 90 } as const;

function plan(overrides: Partial<PurgePlan> = {}): PurgePlan {
  return {
    scope: { tenantId: 't1', businessId: 'b1' },
    redactFields: ['transcriptText', 'audioObjectKey'],
    policy: CONFIGURED,
    ...overrides,
  };
}

describe('a purge is tenant-safe or it does not run', () => {
  it('accepts a purge naming exactly one tenant and one business', () => {
    const decision = planPurge(plan());
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.value.scope).toEqual({ tenantId: 't1', businessId: 'b1' });
      expect(decision.value.transcriptCutoffDays).toBe(90);
    }
  });

  it.each([
    ['an empty tenant', { tenantId: '', businessId: 'b1' }],
    ['an empty business', { tenantId: 't1', businessId: '' }],
    ['both empty', { tenantId: '', businessId: '' }],
    ['whitespace standing in for a tenant', { tenantId: '   ', businessId: 'b1' }],
    ['whitespace standing in for a business', { tenantId: 't1', businessId: '\t' }],
  ])('REFUSES %s — the unscoped purge is the catastrophic case', (_label, scope) => {
    const decision = planPurge(plan({ scope }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai.purge_scope_unsafe');
      expect(decision.refusal.field).toBe('scope');
    }
  });

  it('checks the scope BEFORE anything else — an unscoped purge with a perfect field list still refuses', () => {
    const decision = planPurge(plan({ scope: { tenantId: '', businessId: '' }, policy: { keepAudio: false } }));
    expect(decision.ok).toBe(false);
    // Both laws are violated; the refusal names the scope, because that is the one that would have
    // destroyed other tenants' data.
    if (!decision.ok) expect(decision.refusal.field).toBe('scope');
  });

  it('has no representable "all tenants" scope', () => {
    // There is no variant to test for, which is the point: the dangerous operation is unrepresentable
    // rather than guarded. The nearest reachable thing is an empty id, refused above.
    const decision = planPurge(plan({ scope: { tenantId: '*', businessId: '*' } }));
    // A literal '*' is just an id that matches no tenant — it is accepted as a scope and will purge
    // nothing, which is the safe direction. It is NOT interpreted as a wildcard.
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.value.scope.tenantId).toBe('*');
  });
});

describe('no accidental indefinite retention, and no invented period (§72 / PART 77)', () => {
  it('refuses a purge whose retention period is unconfigured', () => {
    const decision = planPurge(plan({ policy: { keepAudio: false } }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai.retention_unconfigured');
      expect(decision.refusal.detail).toContain('transcriptDays');
    }
  });

  it('refuses when audio is kept with no audio period', () => {
    const decision = planPurge(plan({ policy: { keepAudio: true, transcriptDays: 90 } }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.detail).toContain('audioDays');
  });

  it('takes the cutoff from the configured policy and nowhere else', () => {
    const decision = planPurge(plan({ policy: { keepAudio: false, transcriptDays: 7 } }));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.value.transcriptCutoffDays).toBe(7);
  });
});

describe('audit metadata has a SEPARATE lifecycle (PART 77)', () => {
  it('the identity and content lists are disjoint', () => {
    expect(lifecyclesAreSeparate()).toBe(true);
  });

  it('neither list is empty', () => {
    expect(AUDIT_IDENTITY_FIELDS.length).toBeGreaterThan(0);
    expect(PURGEABLE_CONTENT_FIELDS.length).toBeGreaterThan(0);
  });

  it.each(AUDIT_IDENTITY_FIELDS)('REFUSES a purge that would redact the audit identity %s', (field) => {
    const decision = planPurge(plan({ redactFields: [field] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai.purge_scope_unsafe');
      expect(decision.refusal.field).toBe(field);
      expect(decision.refusal.detail).toContain('audit identity');
    }
  });

  it('refuses an identity field hidden among legitimate content fields', () => {
    const decision = planPurge(plan({ redactFields: ['transcriptText', 'actorUserId', 'promptText'] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.field).toBe('actorUserId');
  });

  it.each(PURGEABLE_CONTENT_FIELDS)('accepts the declared content field %s', (field) => {
    expect(planPurge(plan({ redactFields: [field] })).ok).toBe(true);
  });

  it('refuses a field that is on neither list — an unknown column is not purgeable by default', () => {
    const decision = planPurge(plan({ redactFields: ['transcriptText', 'someNewColumn'] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.field).toBe('someNewColumn');
      expect(decision.refusal.detail).toContain('not a declared purgeable');
    }
  });
});

describe('NON-VACUITY', () => {
  it('a purge that redacts nothing is refused, not reported as a successful purge', () => {
    const decision = planPurge(plan({ redactFields: [] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai.purge_scope_unsafe');
      expect(decision.refusal.field).toBe('redactFields');
    }
  });

  it('the accepted plan returns a plan, not a result — nothing here deletes anything', () => {
    const decision = planPurge(plan());
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(Object.keys(decision.value).sort()).toEqual(['redactFields', 'scope', 'transcriptCutoffDays']);
  });
});
