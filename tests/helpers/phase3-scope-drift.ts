/**
 * THE DISJOINTNESS HALF OF THE PHASE 3 UPGRADE MATRICES (P4-AL-88,
 * `[[daftar-a-closure-rule-is-not-an-invariant]]`).
 *
 * The accepted P3-S4/S5/S6 upgrade matrices each assert an EXACT EQUALITY over
 * a digest of every protected row and over the whole of the registries, taken
 * after "the upgrade" — which, written as `runMigrations(url)` with no bound,
 * means the whole tree. That made them claims about the phase that follows
 * them: the first Phase 4 migration's own rows appear in those digests and an
 * accepted Phase 3 gate goes red for a reason that has nothing to do with the
 * slice it judges.
 *
 * The re-expression stops each upgrade at the ACCEPTED PHASE 3 HEAD
 * (`PHASE4_INHERITED_PREFIX_END`, frozen byte for byte by P4-AL-85, so no later
 * phase can enter it), keeps every original assertion there word for word, and
 * then applies the migrations BEYOND that head in a step of their own. This
 * module is what that second step asserts: not "whatever a successor did is
 * fine", but that a successor did not reach back into the scope Phase 3 owns.
 *
 * Both functions take the row digests the suite already computes — the tagged
 * `concat_ws(':', '<tag>', …)` strings — and return the VIOLATIONS, so the
 * calling suite asserts an empty array and reads the offending rows when it is
 * not empty. They are pure, so each suite proves them red without a database.
 */

/**
 * The tags of the DECLARATIVE REGISTRIES. A migration of any phase may add a
 * row to these: that is what registering an operation kind or a source type
 * is, and the four registries' `registered_by` CHECK is what judges the row
 * (`0074_phase4_registry_widening.sql`). Every other tag names a table that
 * holds BUSINESS data, which no migration may write.
 */
export const REGISTRATION_TAGS: readonly string[] = ['src', 'kind'];

/**
 * A migration's own audited structure record. `0076`'s permission backfill is
 * REQUIRED by R-P4-12 to leave one, so the digest of `audit_events` legitimately
 * grows past the accepted head — but only with a `structure.*` action. An audit
 * row that is not a structure record is a business event, and a migration
 * writing one is a violation.
 */
const AUDITED_STRUCTURE_RECORD = /^audit:[^:]*:structure\./;

/**
 * Every way the migrations beyond the accepted Phase 3 head could have reached
 * into the Phase 3 scope: a row of that scope removed or rewritten, or a row
 * added to it that is neither a registration nor an audited structure record.
 */
export function phase3ScopeViolations(atPhase3Head: readonly string[], afterBeyond: readonly string[]): string[] {
  const after = new Set(afterBeyond);
  const head = new Set(atPhase3Head);
  return [
    ...atPhase3Head.filter((r) => !after.has(r)).map((r) => `removed-or-rewritten:${r}`),
    ...afterBeyond
      .filter((r) => !head.has(r))
      .filter((r) => !REGISTRATION_TAGS.includes(r.split(':')[0] ?? '') && !AUDITED_STRUCTURE_RECORD.test(r))
      .map((r) => `added:${r}`),
  ].sort();
}

/** The rows whose provenance column records a Phase 3 registrant. */
export function phase3Registrants(rows: readonly string[]): string[] {
  return rows.filter((r) => /:(P3-S[0-9]+|P3-C)$/.test(r)).sort();
}

/**
 * The registry half: no row that stood at the accepted head was removed or
 * rewritten, and the rows a Phase 3 registrant owns are EXACTLY the ones that
 * stood there — the `registered_by ~ '^P3-'` idiom the estate already uses.
 */
export function phase3RegistryViolations(atPhase3Head: readonly string[], afterBeyond: readonly string[]): string[] {
  const after = new Set(afterBeyond);
  const removed = atPhase3Head.filter((r) => !after.has(r)).map((r) => `removed-or-rewritten:${r}`);
  const headRegistrants = phase3Registrants(atPhase3Head);
  const afterRegistrants = phase3Registrants(afterBeyond);
  const appeared = afterRegistrants.filter((r) => !headRegistrants.includes(r)).map((r) => `phase3-registrant-appeared:${r}`);
  return [...removed, ...appeared].sort();
}

/**
 * R-P4-12, THE AUDITED BACKFILL, IN BOTH DIRECTIONS.
 *
 * The digest of `audit_events` legitimately grows past the accepted Phase 3
 * head, because a migration that backfills permissions and leaves no audit row
 * raises. That row is therefore admitted by what it RECORDS, never by its name
 * being on a list: every role whose permission set grew carries its
 * `structure.permission_backfilled` row, every such row belongs to a role whose
 * set grew, no role lost a permission, and no role appeared or vanished.
 *
 * `atPhase3Head` and `afterBeyond` are role id → THE KEYS of its permission
 * set, not their count. The count is what this function first took and it was
 * not enough: a successor that REMOVED one key from an inherited role and
 * added another leaves the count equal, so neither `permission-lost` nor
 * `grew` fires, no audit row is required and the swap passes silently — and a
 * permission swapped on a Phase 3 role is exactly the reach-back this clause
 * exists to refuse. Judged by set difference, any key that disappears is red
 * whatever arrived in its place.
 */
export function backfillAuditViolations(
  atPhase3Head: Readonly<Record<string, readonly string[]>>,
  afterBeyond: Readonly<Record<string, readonly string[]>>,
  auditedRoles: readonly string[],
): string[] {
  const head = Object.keys(atPhase3Head).sort();
  const after = Object.keys(afterBeyond).sort();
  const roster = [
    ...head.filter((r) => !(r in afterBeyond)).map((r) => `role-vanished:${r}`),
    ...after.filter((r) => !(r in atPhase3Head)).map((r) => `role-appeared:${r}`),
  ];
  const shared = after.filter((r) => r in atPhase3Head);
  // A key that stood at the accepted head and is gone, NAMED — a swap is two
  // facts and this is the one a count could not see.
  const lost = shared.flatMap((r) => {
    const now = new Set(afterBeyond[r] ?? []);
    return (atPhase3Head[r] ?? []).filter((k) => !now.has(k)).map((k) => `permission-lost:${r}:${k}`);
  });
  const gained = (r: string): string[] => {
    const was = new Set(atPhase3Head[r] ?? []);
    return (afterBeyond[r] ?? []).filter((k) => !was.has(k));
  };
  const grew = shared.filter((r) => gained(r).length > 0);
  const unaudited = grew.filter((r) => !auditedRoles.includes(r)).map((r) => `unaudited-backfill:${r}`);
  const unbacked = auditedRoles.filter((r) => !grew.includes(r)).map((r) => `audit-without-backfill:${r}`);
  return [...roster, ...lost, ...unaudited, ...unbacked].sort();
}
