/**
 * P12 proof plan §3.3 (digest binding) and §3.4 (recomputation divergence).
 *
 * D1 is enumerated PER FIELD. One "tamper with the object" case would stay green while a field sat
 * outside the digest — a narrow result carried under a broad name.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalizePreview,
  checkRecomputation,
  checkStructuralZeroTax,
  DIGEST_COVERED_FIELDS,
  previewDigest,
  verifyDigest,
  type Preview,
} from '../src/preview-digest';

function preview(overrides: Partial<Preview> = {}): Preview {
  return {
    intent: 'sale.create',
    draftId: 'd1',
    draftVersion: 1,
    currencyCode: 'ILS',
    customerId: 'c1',
    branchId: 'br1',
    warehouseId: 'w1',
    lines: [
      { lineNo: 1, productId: 'p1', quantity: '3', unitPriceMinor: 12000n, lineTotalMinor: 36000n },
      { lineNo: 2, productId: 'p2', quantity: '1', unitPriceMinor: 5000n, lineTotalMinor: 5000n },
    ],
    subtotalMinor: 41000n,
    taxMinor: 0n,
    totalMinor: 41000n,
    paidMinor: 30000n,
    outstandingMinor: 11000n,
    ...overrides,
  };
}

/** One tampering per digest-covered field. Keyed so a new field without a tamper case reds below. */
const TAMPERINGS: Readonly<Record<string, Partial<Preview>>> = {
  intent: { intent: 'return.create' },
  draftId: { draftId: 'd2' },
  draftVersion: { draftVersion: 2 },
  currencyCode: { currencyCode: 'USD' },
  customerId: { customerId: 'c2' },
  branchId: { branchId: 'br2' },
  warehouseId: { warehouseId: 'w2' },
  lines: { lines: [{ lineNo: 1, productId: 'p1', quantity: '4', unitPriceMinor: 12000n, lineTotalMinor: 48000n }] },
  subtotalMinor: { subtotalMinor: 41001n },
  taxMinor: { taxMinor: 1n },
  totalMinor: { totalMinor: 41001n },
  paidMinor: { paidMinor: 30001n },
  outstandingMinor: { outstandingMinor: 11001n },
};

describe('digest coverage is exhaustive and asserted both ways', () => {
  it('DIGEST_COVERED_FIELDS names exactly the fields of Preview', () => {
    // Adding a field to Preview without listing it reds here, which is the point: an unlisted field
    // would be a figure a human approved that the digest does not bind.
    expect(Object.keys(preview()).sort()).toEqual([...DIGEST_COVERED_FIELDS].sort());
  });

  it('every covered field has a tampering case', () => {
    expect(Object.keys(TAMPERINGS).sort()).toEqual([...DIGEST_COVERED_FIELDS].sort());
  });

  it.each(DIGEST_COVERED_FIELDS)('tampering with %s changes the digest', (field) => {
    const tamper = TAMPERINGS[field];
    expect(tamper).toBeDefined();
    const base = previewDigest(preview());
    const tampered = previewDigest(preview(tamper));
    expect(tampered).not.toBe(base);
  });
});

describe('digest determinism', () => {
  it('is stable across identical previews', () => {
    expect(previewDigest(preview())).toBe(previewDigest(preview()));
  });

  it('does not depend on line order in the input', () => {
    const forward = preview();
    const reversed = preview({ lines: [...forward.lines].reverse() });
    expect(previewDigest(reversed)).toBe(previewDigest(forward));
  });

  it('renders money as exact decimal strings, never as a float', () => {
    const canonical = canonicalizePreview(preview({ totalMinor: 9007199254740993n }));
    expect(canonical).toContain('totalMinor=9007199254740993');
    // The value above exceeds Number.MAX_SAFE_INTEGER: a float path would lose it.
    expect(canonical).not.toContain('9007199254740992');
  });

  it('verifyDigest accepts the matching digest and refuses any other', () => {
    const p = preview();
    expect(verifyDigest(p, previewDigest(p)).ok).toBe(true);
    const bad = verifyDigest(p, 'x'.repeat(64));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.refusal.code).toBe('ai_draft.preview_digest_mismatch');
  });
});

describe('OD-03 structural zero tax', () => {
  it('accepts zero tax', () => {
    expect(checkStructuralZeroTax(preview()).ok).toBe(true);
  });

  it('REFUSES non-zero tax rather than normalizing it', () => {
    const decision = checkStructuralZeroTax(preview({ taxMinor: 1n }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.tax_non_zero_refused');
      expect(decision.refusal.field).toBe('taxMinor');
    }
  });

  it('refuses negative tax too — a sign flip is not a zero', () => {
    expect(checkStructuralZeroTax(preview({ taxMinor: -1n })).ok).toBe(false);
  });
});

describe('recomputation divergence names the diverging field (§5.3)', () => {
  it('accepts an identical recomputation', () => {
    expect(checkRecomputation(preview(), preview()).ok).toBe(true);
  });

  it.each([
    ['subtotalMinor', { subtotalMinor: 41001n }],
    ['taxMinor', { taxMinor: 1n }],
    ['totalMinor', { totalMinor: 41001n }],
    ['paidMinor', { paidMinor: 1n }],
    ['outstandingMinor', { outstandingMinor: 1n }],
    ['currencyCode', { currencyCode: 'USD' }],
    ['customerId', { customerId: 'c2' }],
  ] as const)('refuses on %s and names it', (field, overrides) => {
    const decision = checkRecomputation(preview(), preview(overrides));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.recomputation_diverged');
      expect(decision.refusal.field).toBe(field);
    }
  });

  it('refuses a changed unit price and names the line and field', () => {
    const moved = preview({
      lines: [
        { lineNo: 1, productId: 'p1', quantity: '3', unitPriceMinor: 13000n, lineTotalMinor: 39000n },
        { lineNo: 2, productId: 'p2', quantity: '1', unitPriceMinor: 5000n, lineTotalMinor: 5000n },
      ],
    });
    const decision = checkRecomputation(preview(), moved);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.recomputation_diverged');
      expect(decision.refusal.field).toBe('lines[0].unitPriceMinor');
    }
  });

  it('refuses a dropped line', () => {
    const fewer = preview({ lines: [preview().lines[0] ?? { lineNo: 1, productId: 'p1', quantity: '3', unitPriceMinor: 12000n, lineTotalMinor: 36000n }] });
    const decision = checkRecomputation(preview(), fewer);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.field).toBe('lines.length');
  });

  it('refuses a substituted product on an otherwise identical line', () => {
    const swapped = preview({
      lines: [
        { lineNo: 1, productId: 'p9', quantity: '3', unitPriceMinor: 12000n, lineTotalMinor: 36000n },
        { lineNo: 2, productId: 'p2', quantity: '1', unitPriceMinor: 5000n, lineTotalMinor: 5000n },
      ],
    });
    const decision = checkRecomputation(preview(), swapped);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.field).toBe('lines[0].productId');
  });

  it('does NOT return the recomputed figure for execution — divergence is a refusal, not a correction', () => {
    const decision = checkRecomputation(preview(), preview({ totalMinor: 40000n }));
    expect(decision.ok).toBe(false);
    // A Decision<true> carries no value on the deny branch, so there is no route by which a caller
    // can execute the recomputed total. The type is the enforcement.
    if (!decision.ok) expect(Object.keys(decision)).toEqual(['ok', 'refusal']);
  });
});
