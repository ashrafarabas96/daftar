/**
 * DAFTAR Phase 12 — the retention purge seam.
 *
 * PART 77 of the 2026-10-12 directive:
 *
 *   audio retention off by default; transcript retention explicit config/policy seam; no accidental
 *   indefinite retention; AUDIT METADATA SEPARATE LIFECYCLE; PURGE JOB TENANT-SAFE; keep required
 *   audit identities without unnecessary content.
 *
 * Two laws live here, and they pull in opposite directions, which is why they are one module:
 *
 *   a purge must DELETE content   — an unconfigured or indefinite retention is the defect §72 names;
 *   a purge must KEEP identity    — the audit trail's "who, when, which draft, which tool" survives
 *                                   the content it described, on its own lifecycle.
 *
 * So a purge is not "delete rows older than N days". It is: redact the content columns of rows in
 * exactly one tenant and business whose retention period has elapsed, leaving the identity columns
 * and the row itself in place.
 *
 * Why the scope check is code and not a WHERE clause a reviewer reads: a purge is the only
 * assistant-adjacent operation that destroys data, and the failure mode is silent and total — a
 * missing or empty tenant predicate purges every tenant, and succeeds while doing it. A WHERE clause
 * cannot refuse; this can.
 *
 * STATUS: PREPARED / NOT PROMOTED. No table is named here and no statement is emitted: the relations
 * and columns are the Migration Owner's, requested in P12-MIGRATION-PATCH-REQUEST.md.
 */

import { allow, deny, refuse, type Decision } from './refusals';
import { retentionReadiness, type RetentionPolicy } from './provider-boundary';

/**
 * Columns an audit row keeps forever (or on the audit trail's own lifecycle, which is not this one).
 *
 * These are identities, not content: they say that something happened and who did it. PART 77's
 * "keep required audit identities without unnecessary content" is this list against the next one.
 */
export const AUDIT_IDENTITY_FIELDS: readonly string[] = [
  'tenantId',
  'businessId',
  'actorUserId',
  'occurredAt',
  'draftId',
  'toolName',
  'intent',
  'refusalCode',
  'providerIdentifier',
];

/**
 * Financial facts, which the purge must also keep.
 *
 * Master Continuous Mission §19 adds this to PART 77 in so many words: *"لا يمحو الاحتفاظ أو التطهير
 * هويات التدقيق أو الوقائع المالية"* — neither retention nor purge erases audit identities **or
 * financial facts**.
 *
 * They are listed separately from the identities above because they are a different kind of thing and
 * the reason they survive is different. An identity survives so an auditor can see who acted. A
 * financial fact survives because **posted history is immutable** (PART 12, the program's oldest law):
 * the link from a confirmation to the transaction it executed is part of that history, and a retention
 * policy is not a route around immutability. A policy that could quietly shorten the life of a
 * financial record would be a second authority over financial truth, which Phase 12 is not.
 */
export const FINANCIAL_FACT_FIELDS: readonly string[] = [
  'businessTransactionId',
  'submittedDigest',
  'draftVersion',
  'decision',
  'currencyCode',
  'totalMinor',
  'paidMinor',
  'outstandingMinor',
];

/** Columns a purge redacts once the retention period has elapsed. Content, not identity. */
export const PURGEABLE_CONTENT_FIELDS: readonly string[] = ['transcriptText', 'audioObjectKey', 'promptText', 'modelOutputText', 'argumentsJson'];

/**
 * A purge scope. Both ids are required and neither may be empty: PART 77's "tenant-safe" is exactly
 * the absence of a purge that can span tenants.
 *
 * There is deliberately no "all tenants" or "all businesses" variant. A platform-wide purge would be
 * a different operation with a different authority, and leaving it unrepresentable here means it
 * cannot be reached by passing an empty value to this one.
 */
export interface PurgeScope {
  readonly tenantId: string;
  readonly businessId: string;
}

export interface PurgePlan {
  readonly scope: PurgeScope;
  /** The fields the plan will redact. Checked against both lists below. */
  readonly redactFields: readonly string[];
  /** The retention policy the cutoff was derived from. */
  readonly policy: RetentionPolicy;
}

export interface PurgeExecution {
  readonly scope: PurgeScope;
  readonly redactFields: readonly string[];
  /** Rows older than this are in scope. Derived from the configured period, never from a default. */
  readonly transcriptCutoffDays: number;
}

function scopeIsSafe(scope: PurgeScope): boolean {
  return scope.tenantId.trim().length > 0 && scope.businessId.trim().length > 0;
}

/**
 * Validate a purge before it runs.
 *
 * Order matters and is asserted by tests: scope first, because an unscoped purge with an otherwise
 * perfect field list is the catastrophic case; then retention configuration, because a purge with no
 * configured period has no cutoff to apply and would be choosing one; then the field list, because a
 * purge that redacts an identity column destroys the audit trail it was supposed to preserve.
 */
export function planPurge(plan: PurgePlan): Decision<PurgeExecution> {
  if (!scopeIsSafe(plan.scope)) {
    return deny(refuse('ai.purge_scope_unsafe', { field: 'scope', detail: 'a purge must name exactly one tenant and one business' }));
  }
  const readiness = retentionReadiness(plan.policy);
  if (!readiness.ready) {
    return deny(refuse('ai.retention_unconfigured', { detail: readiness.unconfigured.join(',') }));
  }
  const cutoff = plan.policy.transcriptDays;
  if (cutoff === undefined) {
    // Unreachable while `retentionReadiness` requires it; kept because the narrowing is what makes
    // "no invented period" a property of the type rather than of this function's reasoning.
    return deny(refuse('ai.retention_unconfigured', { field: 'transcriptDays' }));
  }
  if (plan.redactFields.length === 0) {
    return deny(refuse('ai.purge_scope_unsafe', { field: 'redactFields', detail: 'a purge that redacts nothing is not a purge' }));
  }
  const identities = new Set(AUDIT_IDENTITY_FIELDS);
  const financial = new Set(FINANCIAL_FACT_FIELDS);
  const purgeable = new Set(PURGEABLE_CONTENT_FIELDS);
  for (const field of plan.redactFields) {
    if (identities.has(field)) {
      return deny(refuse('ai.purge_scope_unsafe', { field, detail: 'audit identity field — kept on its own lifecycle, never purged with content' }));
    }
    if (financial.has(field)) {
      return deny(refuse('ai.purge_scope_unsafe', { field, detail: 'financial fact — posted history is immutable; retention is not a route around it' }));
    }
    if (!purgeable.has(field)) {
      return deny(refuse('ai.purge_scope_unsafe', { field, detail: 'not a declared purgeable content field' }));
    }
  }
  return allow({ scope: plan.scope, redactFields: plan.redactFields, transcriptCutoffDays: cutoff });
}

/** The identity and content lists share no member. Asserted by a test as well as returned here. */
export function lifecyclesAreSeparate(): boolean {
  const purgeable = new Set(PURGEABLE_CONTENT_FIELDS);
  return ![...AUDIT_IDENTITY_FIELDS, ...FINANCIAL_FACT_FIELDS].some((f) => purgeable.has(f));
}

/** Every field the purge must never touch, from both protected classes. */
export const NEVER_PURGEABLE_FIELDS: readonly string[] = [...AUDIT_IDENTITY_FIELDS, ...FINANCIAL_FACT_FIELDS];
