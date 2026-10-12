/**
 * DAFTAR Phase 12 — preview canonicalization, digest, and recomputation divergence.
 *
 * P12-S0-ARCHITECTURE-CONTRACT §5. A confirmation is not "yes, proceed" — it is "yes, execute THIS
 * exact thing, which I read". The digest is what makes that sentence checkable.
 *
 * The digest covers resolved entity IDS, not display names: ids are what execute, so ids are what
 * the digest binds. An injection that rewrites a NAME must not be able to make a human approve
 * customer A while the server executes against customer B (proof plan D2).
 *
 * STATUS: PREPARED / NOT PROMOTED.
 */

import { createHash } from 'node:crypto';
import { allow, deny, refuse, type Decision } from './refusals';

/** Money is integer minor units. There is no float authority anywhere in this file (PART 12). */
export interface PreviewLine {
  readonly lineNo: number;
  readonly productId: string;
  /** PART 76 names variant ids explicitly; `null` where the product has no variant dimension. */
  readonly variantId: string | null;
  readonly quantity: string;
  readonly unitPriceMinor: bigint;
  readonly lineTotalMinor: bigint;
}

/**
 * Every field here is digest-covered, and `field-classification.ts` proves that set is exactly the A
 * half of the PART 76 partition. Fields the server recomputes (cost, FX, document number, …) are
 * deliberately absent: a digest over a cost would be the assistant asserting a number that belongs to
 * another authority.
 *
 * The first draft of this type was missing the tenant/business context, variant ids, stated dates and
 * requested discounts that PART 76 enumerates.
 */
export interface Preview {
  /** PART 76 lists tenant/business context first. Omitting it left the digest silent about scope. */
  readonly tenantId: string;
  readonly businessId: string;
  readonly intent: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly currencyCode: string;
  readonly customerId: string | null;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
  /** Stated dates: supplied values, never read from a machine clock. ISO `YYYY-MM-DD`. */
  readonly documentDate: string;
  readonly dueDate: string | null;
  /** A discount the member asked for — selectable, therefore digest-covered, in minor units. */
  readonly requestedDiscountMinor: bigint;
  readonly lines: readonly PreviewLine[];
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
  readonly paidMinor: bigint;
  readonly outstandingMinor: bigint;
}

/**
 * The exact list of digest-covered fields, named once so the test can enumerate them.
 *
 * Proof plan D1 tampers with each field IN TURN. One "tamper with the object" case would stay green
 * while a field sat outside the digest — a narrow result carried under a broad name.
 */
export const DIGEST_COVERED_FIELDS: readonly string[] = [
  'tenantId',
  'businessId',
  'intent',
  'draftId',
  'draftVersion',
  'currencyCode',
  'customerId',
  'branchId',
  'warehouseId',
  'documentDate',
  'dueDate',
  'requestedDiscountMinor',
  'lines',
  'subtotalMinor',
  'taxMinor',
  'totalMinor',
  'paidMinor',
  'outstandingMinor',
];

/**
 * Escape every character the canonical form uses as a delimiter — CHALLENGE F-02.
 *
 * The independent challenge measured that the previous encoding was **not injective**: a two-line
 * preview and a one-line preview whose `productId` carried `;` and `|` produced an identical
 * canonical string, and `null` collided with `''` on every optional field. A digest over a
 * non-injective encoding does not say "this exact thing" — two different things share an answer —
 * which is the whole property §5 exists for. Whether any relation can actually hold such an id is
 * the Migration Owner's to say and is NOT relied on here: an encoding that is injective only because
 * of a validation somewhere else is an encoding whose correctness lives in another file.
 *
 * The escape is applied to the backslash FIRST, so `\\n`, `\\s`, `\\p`, `\\e`, `\\b`, `\\k` and `\\0`
 * cannot be produced by any input string — which is what makes the mapping reversible, and therefore
 * injective.
 */
function esc(value: string): string {
  return value
    .replace(/\\/g, '\\b')
    .replace(/;/g, '\\s')
    .replace(/\|/g, '\\p')
    .replace(/=/g, '\\e')
    .replace(/\n/g, '\\n')
    .replace(/\[/g, '\\k')
    .replace(/]/g, '\\K');
}

/**
 * `null` and the empty string are DIFFERENT values and must not share an encoding (F-02). `\0` is
 * unreachable for any string input because `esc` has already replaced every backslash.
 */
function escOptional(value: string | null): string {
  return value === null ? '\\0' : esc(value);
}

function canonicalLine(line: PreviewLine): string {
  return [
    `lineNo=${String(line.lineNo)}`,
    `productId=${esc(line.productId)}`,
    `variantId=${escOptional(line.variantId)}`,
    `quantity=${esc(line.quantity)}`,
    `unitPriceMinor=${line.unitPriceMinor.toString()}`,
    `lineTotalMinor=${line.lineTotalMinor.toString()}`,
  ].join(';');
}

/**
 * Canonical form: field order is fixed by this function, lines are ordered by `lineNo`, and bigints
 * are rendered as exact decimal strings. No JSON.stringify over an object literal, because key order
 * there is an implementation detail and a digest must not depend on one.
 */
export function canonicalizePreview(preview: Preview): string {
  const lines = [...preview.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map(canonicalLine)
    .join('|');
  return [
    `tenantId=${esc(preview.tenantId)}`,
    `businessId=${esc(preview.businessId)}`,
    `intent=${esc(preview.intent)}`,
    `draftId=${esc(preview.draftId)}`,
    `draftVersion=${String(preview.draftVersion)}`,
    `currencyCode=${esc(preview.currencyCode)}`,
    `customerId=${escOptional(preview.customerId)}`,
    `branchId=${escOptional(preview.branchId)}`,
    `warehouseId=${escOptional(preview.warehouseId)}`,
    `documentDate=${esc(preview.documentDate)}`,
    `dueDate=${escOptional(preview.dueDate)}`,
    `requestedDiscountMinor=${preview.requestedDiscountMinor.toString()}`,
    `subtotalMinor=${preview.subtotalMinor.toString()}`,
    `taxMinor=${preview.taxMinor.toString()}`,
    `totalMinor=${preview.totalMinor.toString()}`,
    `paidMinor=${preview.paidMinor.toString()}`,
    `outstandingMinor=${preview.outstandingMinor.toString()}`,
    `lines=[${lines}]`,
  ].join('\n');
}

export function previewDigest(preview: Preview): string {
  return createHash('sha256').update(canonicalizePreview(preview), 'utf8').digest('hex');
}

export function verifyDigest(preview: Preview, submittedDigest: string): Decision<true> {
  if (previewDigest(preview) !== submittedDigest) return deny(refuse('ai_draft.preview_digest_mismatch'));
  return allow(true);
}

/**
 * OD-03: sales tax is a structural zero inside the current phase. A non-zero tax is REFUSED, never
 * normalized to zero — normalizing would silently alter a figure a human is about to approve.
 */
export function checkStructuralZeroTax(preview: Preview): Decision<true> {
  if (preview.taxMinor !== 0n) return deny(refuse('ai_draft.tax_non_zero_refused', { field: 'taxMinor' }));
  return allow(true);
}

/**
 * Recomputation divergence — contract §5.3.
 *
 * The server recomputes every figure at execution. If any recomputed figure differs from the figure
 * inside the CONFIRMED digest, this REFUSES and names the field. It deliberately does not return the
 * recomputed value for execution: the human approved a total, and executing a different total is
 * executing something nobody approved, however arithmetically better it is.
 */
/**
 * Every digest-covered scalar, rendered for comparison — CHALLENGE F-01.
 *
 * The independent challenge measured that `checkRecomputation` compared 13 of the 18 digest-covered
 * fields and returned `ok=true` on a divergence in `warehouseId`, `branchId`, `intent`, `draftId` or
 * `draftVersion`. `warehouseId` is the stock location a draw-down hits and `branchId` is the posting
 * branch: a divergence there is precisely what §5.3 exists to refuse, and it passed silently.
 *
 * The root cause was that the law had 18 subjects and the comparison was a hand-written list, so the
 * two could drift without anything saying so. This map is keyed by `Exclude<keyof Preview, 'lines'>`,
 * which makes the drift a **compile error**: a new digest-covered field cannot be added to `Preview`
 * without a renderer here. `recomputationCoversDigest()` closes the other direction at runtime, and
 * a test asserts it.
 */
const SCALAR_RENDERERS: { readonly [K in Exclude<keyof Preview, 'lines'>]: (p: Preview) => string } = {
  tenantId: (p) => p.tenantId,
  businessId: (p) => p.businessId,
  intent: (p) => p.intent,
  draftId: (p) => p.draftId,
  draftVersion: (p) => String(p.draftVersion),
  currencyCode: (p) => p.currencyCode,
  customerId: (p) => escOptional(p.customerId),
  branchId: (p) => escOptional(p.branchId),
  warehouseId: (p) => escOptional(p.warehouseId),
  documentDate: (p) => p.documentDate,
  dueDate: (p) => escOptional(p.dueDate),
  requestedDiscountMinor: (p) => p.requestedDiscountMinor.toString(),
  subtotalMinor: (p) => p.subtotalMinor.toString(),
  taxMinor: (p) => p.taxMinor.toString(),
  totalMinor: (p) => p.totalMinor.toString(),
  paidMinor: (p) => p.paidMinor.toString(),
  outstandingMinor: (p) => p.outstandingMinor.toString(),
};

/**
 * The comparison's subjects are exactly the digest's subjects: every scalar renderer above, plus
 * `lines`, which is compared element by element below.
 *
 * Returned rather than asserted inline so a test can state the property by name. A guard that
 * enumerates the law it enforces is the one cross-check the recomputation path previously lacked —
 * the tampering cases already had it against `DIGEST_COVERED_FIELDS`.
 */
export function recomputationCoversDigest(): boolean {
  const compared = new Set<string>([...Object.keys(SCALAR_RENDERERS), 'lines']);
  const covered = new Set(DIGEST_COVERED_FIELDS);
  if (compared.size !== covered.size) return false;
  for (const field of covered) if (!compared.has(field)) return false;
  return true;
}

export function checkRecomputation(confirmed: Preview, recomputed: Preview): Decision<true> {
  // Field order follows DIGEST_COVERED_FIELDS so the field a refusal names is stable across runs,
  // and so a reader comparing the two lists reads them in one order.
  for (const field of DIGEST_COVERED_FIELDS) {
    if (field === 'lines') continue;
    const render = SCALAR_RENDERERS[field as Exclude<keyof Preview, 'lines'>] as ((p: Preview) => string) | undefined;
    if (render === undefined) {
      // Unreachable while `recomputationCoversDigest()` holds, which a test asserts. Kept because an
      // unmatched field must refuse rather than be skipped: skipping is the F-01 defect itself.
      return deny(refuse('ai_draft.recomputation_diverged', { field }));
    }
    if (render(confirmed) !== render(recomputed)) return deny(refuse('ai_draft.recomputation_diverged', { field }));
  }
  if (confirmed.lines.length !== recomputed.lines.length) return deny(refuse('ai_draft.recomputation_diverged', { field: 'lines.length' }));
  const sortedConfirmed = [...confirmed.lines].sort((a, b) => a.lineNo - b.lineNo);
  const sortedRecomputed = [...recomputed.lines].sort((a, b) => a.lineNo - b.lineNo);
  for (let i = 0; i < sortedConfirmed.length; i += 1) {
    const c = sortedConfirmed[i];
    const r = sortedRecomputed[i];
    // noUncheckedIndexedAccess: both are in range by the length check above, but an unchecked read
    // is exactly the shape that hides an off-by-one, so it is checked rather than asserted.
    if (c === undefined || r === undefined) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}]` }));
    if (c.lineNo !== r.lineNo) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}].lineNo` }));
    if (c.productId !== r.productId) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}].productId` }));
    if (c.variantId !== r.variantId) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}].variantId` }));
    if (c.quantity !== r.quantity) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}].quantity` }));
    if (c.unitPriceMinor !== r.unitPriceMinor) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}].unitPriceMinor` }));
    if (c.lineTotalMinor !== r.lineTotalMinor) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}].lineTotalMinor` }));
  }
  return allow(true);
}
