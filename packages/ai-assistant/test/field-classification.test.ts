/**
 * P12 — PART 76 of the 2026-10-12 directive.
 *
 *   every execution-affecting draft field is either A. digest-covered or B. server-recomputed.
 *   No third category. A newly added execution field without classification: gate red.
 *
 * Four properties are asserted separately, because a single "the gate passes" case would be green
 * while any one of them was false:
 *   exhaustiveness  — every field of the live `Preview` type is classified;
 *   disjointness    — no field is in both halves;
 *   redness         — an unclassified field turns the gate red and the refusal NAMES it;
 *   non-vacuity     — the gate is not satisfied by an empty subject.
 */

import { describe, expect, it } from 'vitest';
import {
  auditClassification,
  classificationGate,
  DIGEST_COVERED,
  EXECUTION_AFFECTING_FIELDS,
  halvesAreDisjoint,
  SERVER_RECOMPUTED,
  type Halves,
} from '../src/field-classification';
import { DIGEST_COVERED_FIELDS, type Preview } from '../src/preview-digest';

/** The live object, so the subject of the audit is the real type and not a second list of names. */
function preview(): Preview {
  return {
    tenantId: 't1',
    businessId: 'b1',
    intent: 'sale.create',
    draftId: 'd1',
    draftVersion: 1,
    currencyCode: 'ILS',
    customerId: 'c1',
    branchId: 'br1',
    warehouseId: 'w1',
    documentDate: '2026-10-12',
    dueDate: '2026-11-12',
    requestedDiscountMinor: 0n,
    lines: [{ lineNo: 1, productId: 'p1', variantId: 'v1', quantity: '3', unitPriceMinor: 12000n, lineTotalMinor: 36000n }],
    subtotalMinor: 36000n,
    taxMinor: 0n,
    totalMinor: 36000n,
    paidMinor: 0n,
    outstandingMinor: 36000n,
  };
}

describe('the partition has exactly two halves and they are disjoint', () => {
  it('no field is classified both ways', () => {
    expect(halvesAreDisjoint()).toBe(true);
    expect(auditClassification(EXECUTION_AFFECTING_FIELDS).doublyClassified).toEqual([]);
  });

  it('neither half is empty — a partition over an empty half proves nothing', () => {
    expect(DIGEST_COVERED.length).toBeGreaterThan(0);
    expect(SERVER_RECOMPUTED.length).toBeGreaterThan(0);
  });

  it('names no duplicate within a half', () => {
    expect(new Set(DIGEST_COVERED).size).toBe(DIGEST_COVERED.length);
    expect(new Set(SERVER_RECOMPUTED).size).toBe(SERVER_RECOMPUTED.length);
  });

  it('the declared execution surface is exactly the two halves together', () => {
    expect([...EXECUTION_AFFECTING_FIELDS].sort()).toEqual([...DIGEST_COVERED, ...SERVER_RECOMPUTED].sort());
  });
});

describe('the A half is the digest, asserted against the digest module itself', () => {
  it('DIGEST_COVERED is exactly DIGEST_COVERED_FIELDS', () => {
    // Two modules, one truth. If the digest gains a field and the classification does not — or the
    // reverse — this reds, which is the only way the "A. digest-covered" half can mean anything.
    expect([...DIGEST_COVERED].sort()).toEqual([...DIGEST_COVERED_FIELDS].sort());
  });

  it('every key of a live Preview is classified', () => {
    const decision = classificationGate(Object.keys(preview()));
    expect(decision.ok).toBe(true);
  });

  it('no server-recomputed name appears in the Preview — B fields are deliberately NOT presented', () => {
    const keys = new Set(Object.keys(preview()));
    for (const field of SERVER_RECOMPUTED) expect(keys.has(field)).toBe(false);
  });
});

describe('an unclassified execution field reds the gate and is NAMED (PART 76 "gate red")', () => {
  it('refuses a newly added field nobody classified', () => {
    const decision = classificationGate([...Object.keys(preview()), 'appliedPromotionId']);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.field_unclassified');
      expect(decision.refusal.field).toBe('appliedPromotionId');
      expect(decision.refusal.detail).toContain('neither');
    }
  });

  it('refuses a field classified BOTH ways, and says so rather than preferring a half', () => {
    // The real halves are disjoint (asserted above), so this condition is unreachable with them and
    // is constructed deliberately: `unitCostMinor` claimed by A as well as B.
    const contrived: Halves = { digestCovered: ['totalMinor', 'unitCostMinor'], serverRecomputed: ['unitCostMinor'] };
    expect(halvesAreDisjoint(contrived)).toBe(false);
    const audit = auditClassification(['totalMinor', 'unitCostMinor'], contrived);
    expect(audit.doublyClassified).toEqual(['unitCostMinor']);
    expect(audit.unclassified).toEqual([]);
    const decision = classificationGate(['totalMinor', 'unitCostMinor'], contrived);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.field_unclassified');
      expect(decision.refusal.field).toBe('unitCostMinor');
      expect(decision.refusal.detail).toContain('both');
    }
  });

  it('reports a doubly-classified field BEFORE an unclassified one — the ambiguity is the worse defect', () => {
    const contrived: Halves = { digestCovered: ['a', 'b'], serverRecomputed: ['b'] };
    const decision = classificationGate(['zzz', 'b'], contrived);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.field).toBe('b');
  });

  it('reports EVERY unclassified field, not just the first, so one fix does not hide the next', () => {
    const audit = auditClassification(['totalMinor', 'alpha', 'beta']);
    expect(audit.unclassified).toEqual(['alpha', 'beta']);
  });

  it('the gate names the FIRST unclassified field, and it is one of the reported ones', () => {
    const decision = classificationGate(['totalMinor', 'alpha', 'beta']);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.field).toBe('alpha');
  });
});

describe('NON-VACUITY: the gate is not satisfied by having nothing to check (PART 17)', () => {
  it('refuses an empty subject rather than passing it', () => {
    const decision = classificationGate([]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.field_unclassified');
      expect(decision.refusal.detail).toContain('empty');
    }
  });

  it('an empty audit reports no defect — which is exactly why the gate checks emptiness itself', () => {
    // `auditClassification([])` is honestly empty: nothing was unclassified because nothing was
    // presented. A gate that only read this result would be green over an empty surface.
    expect(auditClassification([])).toEqual({ unclassified: [], doublyClassified: [] });
  });
});
