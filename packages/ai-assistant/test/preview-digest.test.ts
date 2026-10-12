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
  lineComparisonCoversLine,
  recomputationCoversDigest,
  previewDigest,
  verifyDigest,
  type Preview,
} from '../src/preview-digest';

function preview(overrides: Partial<Preview> = {}): Preview {
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
    lines: [
      { lineNo: 1, productId: 'p1', variantId: 'v1', quantity: '3', unitPriceMinor: 12000n, lineTotalMinor: 36000n },
      { lineNo: 2, productId: 'p2', variantId: null, quantity: '1', unitPriceMinor: 5000n, lineTotalMinor: 5000n },
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
  tenantId: { tenantId: 't2' },
  businessId: { businessId: 'b2' },
  documentDate: { documentDate: '2026-10-13' },
  dueDate: { dueDate: '2026-11-13' },
  requestedDiscountMinor: { requestedDiscountMinor: 1n },
  intent: { intent: 'return.create' },
  draftId: { draftId: 'd2' },
  draftVersion: { draftVersion: 2 },
  currencyCode: { currencyCode: 'USD' },
  customerId: { customerId: 'c2' },
  branchId: { branchId: 'br2' },
  warehouseId: { warehouseId: 'w2' },
  lines: { lines: [{ lineNo: 1, productId: 'p1', variantId: 'v1', quantity: '4', unitPriceMinor: 12000n, lineTotalMinor: 48000n }] },
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
        { lineNo: 1, productId: 'p1', variantId: 'v1', quantity: '3', unitPriceMinor: 13000n, lineTotalMinor: 39000n },
        { lineNo: 2, productId: 'p2', variantId: null, quantity: '1', unitPriceMinor: 5000n, lineTotalMinor: 5000n },
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
    const fewer = preview({
      lines: [preview().lines[0] ?? { lineNo: 1, productId: 'p1', variantId: 'v1', quantity: '3', unitPriceMinor: 12000n, lineTotalMinor: 36000n }],
    });
    const decision = checkRecomputation(preview(), fewer);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.field).toBe('lines.length');
  });

  it('refuses a substituted product on an otherwise identical line', () => {
    const swapped = preview({
      lines: [
        { lineNo: 1, productId: 'p9', variantId: 'v1', quantity: '3', unitPriceMinor: 12000n, lineTotalMinor: 36000n },
        { lineNo: 2, productId: 'p2', variantId: null, quantity: '1', unitPriceMinor: 5000n, lineTotalMinor: 5000n },
      ],
    });
    const decision = checkRecomputation(preview(), swapped);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.field).toBe('lines[0].productId');
  });

  it('refuses a substituted VARIANT on an otherwise identical line (PART 76)', () => {
    const swapped = preview({
      lines: [
        { lineNo: 1, productId: 'p1', variantId: 'v9', quantity: '3', unitPriceMinor: 12000n, lineTotalMinor: 36000n },
        { lineNo: 2, productId: 'p2', variantId: null, quantity: '1', unitPriceMinor: 5000n, lineTotalMinor: 5000n },
      ],
    });
    const decision = checkRecomputation(preview(), swapped);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.field).toBe('lines[0].variantId');
  });

  it.each([
    ['tenantId', { tenantId: 't2' }],
    ['businessId', { businessId: 'b2' }],
    ['documentDate', { documentDate: '2026-10-13' }],
    ['dueDate', { dueDate: null }],
    ['requestedDiscountMinor', { requestedDiscountMinor: 500n }],
  ] as const)('refuses on %s and names it (PART 76 fields)', (field, overrides) => {
    const decision = checkRecomputation(preview(), preview(overrides));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.field).toBe(field);
  });

  it('does NOT return the recomputed figure for execution — divergence is a refusal, not a correction', () => {
    const decision = checkRecomputation(preview(), preview({ totalMinor: 40000n }));
    expect(decision.ok).toBe(false);
    // A Decision<true> carries no value on the deny branch, so there is no route by which a caller
    // can execute the recomputed total. The type is the enforcement.
    if (!decision.ok) expect(Object.keys(decision)).toEqual(['ok', 'refusal']);
  });
});

// ---------------------------------------------------------------------------
// CHALLENGE F-01 — the recomputation comparison has the same 18 subjects as the digest
// ---------------------------------------------------------------------------

describe('F-01: recomputation divergence is enumerated from the law, not hand-written', () => {
  it('the comparison covers exactly DIGEST_COVERED_FIELDS', () => {
    // The hand-written list compared 13 of 18. warehouseId, branchId, intent, draftId and
    // draftVersion diverged silently — warehouseId being the stock location a draw-down hits.
    expect(recomputationCoversDigest()).toBe(true);
  });

  it.each(DIGEST_COVERED_FIELDS)('refuses a divergence in %s and names it', (field) => {
    const tamper = TAMPERINGS[field];
    expect(tamper).toBeDefined();
    const decision = checkRecomputation(preview(), preview(tamper));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('ai_draft.recomputation_diverged');
      // `lines` is compared element by element, so it names `lines.length` or `lines[i].x`.
      if (field === 'lines') expect(decision.refusal.field?.startsWith('lines')).toBe(true);
      else expect(decision.refusal.field).toBe(field);
    }
  });

  it('C-7: the LINE comparison covers exactly the fields of a line', () => {
    // The compile-time guarantee used to stop at the preview level while the line comparison was a
    // hand-written sequence — the same shape as F-01, one level down.
    const line = preview().lines[0];
    expect(line).toBeDefined();
    if (line !== undefined) expect(lineComparisonCoversLine(line)).toBe(true);
  });

  it('NON-VACUITY: two identical previews still pass, so the cases above are caused by their own divergence', () => {
    expect(checkRecomputation(preview(), preview()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CHALLENGE F-02 — the canonical encoding is injective
// ---------------------------------------------------------------------------

describe('F-02: two different previews cannot canonicalize to the same string', () => {
  it('a delimiter inside a productId cannot forge an extra line', () => {
    // Measured by the challenger on the previous encoding: these two canonicalized IDENTICALLY, so
    // one digest stood for two different sets of goods. The forged id below is written against the
    // CURRENT rendering of every neighbouring field, so the case stays a real collision attempt and
    // does not pass for an incidental reason.
    const twoLines = preview({
      lines: [
        { lineNo: 1, productId: 'p1', variantId: null, quantity: '1', unitPriceMinor: 100n, lineTotalMinor: 100n },
        { lineNo: 2, productId: 'p2', variantId: null, quantity: '1', unitPriceMinor: 100n, lineTotalMinor: 100n },
      ],
    });
    const forgedId = 'p1;variantId=\\0;quantity=1;unitPriceMinor=100;lineTotalMinor=100|lineNo=2;productId=p2';
    const oneForgedLine = preview({
      lines: [{ lineNo: 1, productId: forgedId, variantId: null, quantity: '1', unitPriceMinor: 100n, lineTotalMinor: 100n }],
    });
    expect(canonicalizePreview(oneForgedLine)).not.toBe(canonicalizePreview(twoLines));
    expect(previewDigest(oneForgedLine)).not.toBe(previewDigest(twoLines));
  });

  it('every delimiter is escaped where it appears inside a value, not merely rendered', () => {
    // Pinned to the escape itself. Without it the assertions above could pass because of how some
    // neighbouring field happens to render, which is how an encoding defect survives a test.
    const canon = canonicalizePreview(preview({ customerId: 'a;b|c=d[e]f' }));
    expect(canon).not.toContain('a;b');
    expect(canon).toContain('customerId=a\\sb\\pc\\ed\\ke\\Kf');
  });

  it('null and the empty string are different values on every optional field', () => {
    for (const field of ['customerId', 'branchId', 'warehouseId', 'dueDate'] as const) {
      const asNull = preview({ [field]: null } as Partial<Preview>);
      const asEmpty = preview({ [field]: '' } as Partial<Preview>);
      expect(previewDigest(asNull)).not.toBe(previewDigest(asEmpty));
    }
  });

  it('a value carrying the field separator cannot impersonate the next field', () => {
    const forged = preview({ customerId: 'c1\nbranchId=br9' });
    expect(previewDigest(forged)).not.toBe(previewDigest(preview({ branchId: 'br9' })));
    expect(previewDigest(forged)).not.toBe(previewDigest(preview()));
  });

  it('the escape itself is unambiguous — a literal backslash does not collide with an escaped delimiter', () => {
    // `esc` replaces the backslash FIRST, which is what makes the mapping reversible. Were it last,
    // a productId of `\s` and one of `;` would both render as `\s`.
    const literal = preview({ customerId: '\\s' });
    const delimiter = preview({ customerId: ';' });
    expect(previewDigest(literal)).not.toBe(previewDigest(delimiter));
  });

  it('NON-VACUITY: identical previews still share a digest, so the cases above are not simply all-different', () => {
    expect(previewDigest(preview())).toBe(previewDigest(preview()));
  });
});
