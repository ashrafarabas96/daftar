/**
 * DAFTAR Phase 12 — the execution-field classification and its structural proof.
 *
 * PART 76 of the 2026-10-12 directive. The ruling, in its own terms:
 *
 *   every execution-affecting draft field is either
 *     A. digest-covered, or
 *     B. server-recomputed.
 *   No third category.
 *   A newly added execution field without classification: gate red.
 *
 * Why this needs to be a structure rather than a review habit: the dangerous field is not one
 * classified wrongly — that gets argued about and fixed. It is the field nobody classified, which
 * silently becomes a value the human never approved and the server never re-derived. A reviewer
 * cannot notice an absence; a partition check can.
 *
 * So the two halves below are the whole classification, and `auditClassification()` refuses on any
 * field that is in neither, in both, or in the type but in no half.
 *
 * STATUS: PREPARED / NOT PROMOTED.
 */

import { allow, deny, refuse, type Decision } from './refusals';

export type FieldClass = 'digest_covered' | 'server_recomputed';

/**
 * A — covered by the confirmation digest.
 *
 * These are the client-visible or client-selectable values whose identity can affect execution. PART
 * 76 enumerates the kinds; this is that enumeration resolved to the actual `Preview` fields.
 *
 * Note that being digest-covered does NOT exempt a field from recomputation: a displayed total is
 * both bound by the digest and re-derived at execution, and a divergence refuses (contract §5.3).
 * The partition is about which fields the human's confirmation is *responsible* for, not about which
 * are checked.
 */
export const DIGEST_COVERED: readonly string[] = [
  // tenant/business context — PART 76 names it first, and it was missing from the first draft
  'tenantId',
  'businessId',
  // draft id/version, command/intent kind, preview version
  'draftId',
  'draftVersion',
  'intent',
  // entity ids
  'customerId',
  'branchId',
  'warehouseId',
  // line/product/variant ids and quantities travel inside `lines`
  'lines',
  // stated dates — supplied, never a machine clock
  'documentDate',
  'dueDate',
  // requested discounts
  'requestedDiscountMinor',
  // displayed money
  'currencyCode',
  'subtotalMinor',
  'taxMinor',
  'totalMinor',
  'paidMinor',
  'outstandingMinor',
];

/**
 * B — recomputed server-side from authoritative state, and therefore deliberately NOT in the digest.
 *
 * A value here is never shown as something the member selected, and never accepted from a client or
 * a model. Each belongs to an authority that already owns it (accounting, inventory, FX), which is
 * exactly why Phase 12 must not bind it: a digest over a cost or an FX rate would be the assistant
 * asserting a number that is not its to assert.
 */
export const SERVER_RECOMPUTED: readonly string[] = [
  'fxRateUsed',
  'unitCostMinor',
  'cogsMinor',
  'carryingValueMinor',
  'settlementState',
  'journalLines',
  'documentNumber',
  'agingBucket',
  'createdAt',
];

/**
 * Every field that can affect execution, from both halves. This is the subject the audit runs over,
 * and it is declared once so the audit cannot be satisfied by an empty set.
 */
export const EXECUTION_AFFECTING_FIELDS: readonly string[] = [...DIGEST_COVERED, ...SERVER_RECOMPUTED];

export interface ClassificationAudit {
  /** In neither half — the defect PART 76 exists to make impossible. */
  readonly unclassified: readonly string[];
  /** In both halves — an ambiguous field is as bad as an unclassified one. */
  readonly doublyClassified: readonly string[];
}

/**
 * Audit a set of field names against the classification.
 *
 * `fields` is what the caller believes the execution-affecting surface to be — in the gate it is the
 * key set of an actual preview object, so the check is against the live type rather than against a
 * list that could drift from it.
 *
 * `halves` exists for one reason and it is not configurability: the real halves are disjoint (and a
 * test asserts it), so the doubly-classified branch is UNREACHABLE with them. Without a seam that
 * branch would be code no case ever runs — and an untested refusal path is a refusal nobody has
 * shown refuses. Production callers pass nothing.
 */
export interface Halves {
  readonly digestCovered: readonly string[];
  readonly serverRecomputed: readonly string[];
}

export const LIVE_HALVES: Halves = { digestCovered: DIGEST_COVERED, serverRecomputed: SERVER_RECOMPUTED };

export function auditClassification(fields: readonly string[], halves: Halves = LIVE_HALVES): ClassificationAudit {
  const digest = new Set(halves.digestCovered);
  const recomputed = new Set(halves.serverRecomputed);
  const unclassified: string[] = [];
  const doubly: string[] = [];
  for (const field of fields) {
    const inDigest = digest.has(field);
    const inRecomputed = recomputed.has(field);
    if (inDigest && inRecomputed) doubly.push(field);
    else if (!inDigest && !inRecomputed) unclassified.push(field);
  }
  return { unclassified, doublyClassified: doubly };
}

/**
 * The gate. Refuses, naming the offending field, so a new execution field without a classification
 * turns it red — PART 76's "gate red" as an exit code rather than a sentence.
 */
export function classificationGate(fields: readonly string[], halves: Halves = LIVE_HALVES): Decision<true> {
  if (fields.length === 0) {
    // A gate satisfied by an empty subject is a vacuous gate. The subject must exist and be
    // non-empty before its emptiness can mean anything (PART 17).
    return deny(refuse('ai_draft.field_unclassified', { detail: 'no execution-affecting fields presented; subject is empty' }));
  }
  const audit = auditClassification(fields, halves);
  const firstDoubly = audit.doublyClassified[0];
  if (firstDoubly !== undefined) {
    return deny(refuse('ai_draft.field_unclassified', { field: firstDoubly, detail: 'classified both digest-covered and server-recomputed' }));
  }
  const firstUnclassified = audit.unclassified[0];
  if (firstUnclassified !== undefined) {
    return deny(refuse('ai_draft.field_unclassified', { field: firstUnclassified, detail: 'neither digest-covered nor server-recomputed' }));
  }
  return allow(true);
}

/** The two halves share no member. Asserted by a test as well, since disjointness is half the law. */
export function halvesAreDisjoint(halves: Halves = LIVE_HALVES): boolean {
  const recomputed = new Set(halves.serverRecomputed);
  return !halves.digestCovered.some((f) => recomputed.has(f));
}
