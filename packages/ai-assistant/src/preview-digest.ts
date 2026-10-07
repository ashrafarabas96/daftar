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
  readonly quantity: string;
  readonly unitPriceMinor: bigint;
  readonly lineTotalMinor: bigint;
}

export interface Preview {
  readonly intent: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly currencyCode: string;
  readonly customerId: string | null;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
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
  'intent',
  'draftId',
  'draftVersion',
  'currencyCode',
  'customerId',
  'branchId',
  'warehouseId',
  'lines',
  'subtotalMinor',
  'taxMinor',
  'totalMinor',
  'paidMinor',
  'outstandingMinor',
];

function canonicalLine(line: PreviewLine): string {
  return [
    `lineNo=${String(line.lineNo)}`,
    `productId=${line.productId}`,
    `quantity=${line.quantity}`,
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
    `intent=${preview.intent}`,
    `draftId=${preview.draftId}`,
    `draftVersion=${String(preview.draftVersion)}`,
    `currencyCode=${preview.currencyCode}`,
    `customerId=${preview.customerId ?? ''}`,
    `branchId=${preview.branchId ?? ''}`,
    `warehouseId=${preview.warehouseId ?? ''}`,
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
export function checkRecomputation(confirmed: Preview, recomputed: Preview): Decision<true> {
  const scalar: readonly (readonly [string, bigint, bigint])[] = [
    ['subtotalMinor', confirmed.subtotalMinor, recomputed.subtotalMinor],
    ['taxMinor', confirmed.taxMinor, recomputed.taxMinor],
    ['totalMinor', confirmed.totalMinor, recomputed.totalMinor],
    ['paidMinor', confirmed.paidMinor, recomputed.paidMinor],
    ['outstandingMinor', confirmed.outstandingMinor, recomputed.outstandingMinor],
  ];
  for (const [field, a, b] of scalar) {
    if (a !== b) return deny(refuse('ai_draft.recomputation_diverged', { field }));
  }
  if (confirmed.currencyCode !== recomputed.currencyCode) return deny(refuse('ai_draft.recomputation_diverged', { field: 'currencyCode' }));
  if (confirmed.customerId !== recomputed.customerId) return deny(refuse('ai_draft.recomputation_diverged', { field: 'customerId' }));
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
    if (c.quantity !== r.quantity) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}].quantity` }));
    if (c.unitPriceMinor !== r.unitPriceMinor) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}].unitPriceMinor` }));
    if (c.lineTotalMinor !== r.lineTotalMinor) return deny(refuse('ai_draft.recomputation_diverged', { field: `lines[${String(i)}].lineTotalMinor` }));
  }
  return allow(true);
}
