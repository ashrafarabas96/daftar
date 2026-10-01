/**
 * GUARD P4-G-RLS — EVERY PHASE 4 RELATION ENABLES *AND* FORCES ROW LEVEL
 * SECURITY, OVER A SURFACE NOBODY WROTE DOWN.
 *
 * Tech Lead ruling `TL-P4-S1-R2` (docs/PHASE_4_ARCHITECTURE_LOCK.md §25) and
 * the carried-forward gap it closes: before this module, every RLS assertion
 * in the estate was over a NAMED table list or was a two-build catalogue
 * comparison, so a Phase 4 relation that forgot `ENABLE` or `FORCE` would have
 * been caught by nothing. `0075-E` covers P4-S1's own five relations by naming
 * them; a law that names its subjects protects the names.
 *
 * ── THE SURFACE IS DISCOVERED, NEVER LISTED ──────────────────────────────
 *
 * The relation set is the UNION of two independent discoveries, and the law
 * reports what each one knows that the other does not, because each catches
 * what the other structurally cannot:
 *
 *   (i)  THE MIGRATION TREE. `phase4MigrationsOnDisk` names the files numbered
 *        past the DERIVED `PHASE4_FIRST_NUMBER` (never a literal), and
 *        `discoverStoredRelations` reads the relations each one makes. This
 *        half sees a relation whose migration exists but has not been applied
 *        to the database being judged — reported as DECLARED AND NOT APPLIED,
 *        never silently dropped, because an unjudged subject is not a pass.
 *
 *   (ii) THE LIVE CATALOGUE. `pg_class` rows in `public` with
 *        `relkind IN ('r','p')`. This half sees a relation that reached a
 *        database by a route the text parser cannot read — a hand-run
 *        statement on a deployment, a restored dump, DDL generated inside a
 *        `DO` block — and so it is the proof of the other half's completeness.
 *
 * Both halves are filtered by the estate's ONE Phase 4 predicate,
 * `isPhase4Relation` (`scripts/guards/no-authoritative-balance.ts`): the
 * complement of the digest-verified inherited prefix. No second definition of
 * "Phase 4" is introduced here, and no name of a Phase 4 relation is written
 * in this file — a property the guard's own suite asserts mechanically against
 * this source text.
 *
 * ── THE PREDICATE IS FAIL-EMPTY, SO IT NEEDS A CANARY ────────────────────
 *
 * `isPhase4Relation` is the complement of a set read from digest-verified
 * files, and a missing or altered prefix file yields an EMPTY set — which makes
 * every relation in the catalogue read as "Phase 4". That direction is
 * stricter, not weaker, but it means the discovery can be made to say something
 * enormous by tampering rather than something true. `inheritedPrefixSize` is
 * therefore reported and asserted as a floor, and an empty reading is itself a
 * problem, not a surface.
 *
 * ── WHY THIS LAW IS SCOPED TO PHASE 4 AND NOT TO THE TREE ────────────────
 *
 * The lock's carried-forward note proposed the unscoped `phase3Tables()` form.
 * On this tree that law is RED ON ARRIVAL and it is a false red. Measured from
 * `pg_class` on a database built from `0000`–`0076` (2026-10-01): of the 109
 * relations the accepted inherited prefix creates, 30 carry no FORCE and 29
 * carry no ENABLE — platform and global reference and registry relations with
 * no tenant dimension at all, plus `onboarding_operations`, which is the single
 * relation that ENABLEs and never FORCEs. `phase3Tables()` is "at the head and
 * not at `0052`", so it is not even a Phase 3 set: it has 54 members here, 9 of
 * which carry neither flag — and one of those 9 is the APPLIER'S OWN relation,
 * which that helper does not subtract. A protection that must be born failing
 * is not a protection, and the suite re-measures the premise rather than
 * trusting this paragraph. §25's note is corrected in place with this evidence.
 *
 * Scoping to Phase 4 is not a weakening, because `P4-AL-08` makes the scope
 * exact: every Phase 4 relation carries `tenant_id` AND `business_id`. The law
 * therefore PARTITIONS its surface structurally, so that a future Phase 4
 * global registry raises a decision instead of a false red or a silent hole:
 *
 *   — both columns  → it has a tenant dimension, so `ENABLE` + `FORCE` is owed;
 *   — exactly one   → a `P4-AL-08` violation, named as one, and `ENABLE` +
 *                     `FORCE` is still owed, because one dimension still leaks;
 *   — neither       → a declared Phase 4 global registry. `P4-AL-08` forbids
 *                     it and §17.3 refuses an allowlist, so it is RED until the
 *                     Architecture Lock records a decision for it.
 *
 * ── THE ONE RELATION SUBTRACTED, AND WHERE THAT NAME COMES FROM ──────────
 *
 * The applier creates its own bookkeeping relation before any migration runs,
 * so it is in the live catalogue, it is not in the inherited prefix, and
 * `isPhase4Relation` therefore calls it Phase 4. It is not: it belongs to the
 * runner, it carries no tenant data, and no migration declares it. It is
 * excluded by reading the APPLIER'S OWN SOURCE with the same
 * `discoverStoredRelations`, so the exclusion is whatever the applier actually
 * creates and never a name literal in this file. An empty reading of that
 * source is a problem too — an exclusion with no subject would mean the text
 * stopped declaring what it creates.
 *
 * ── `0076`'s FORCE WINDOW CANNOT BE OBSERVED BY THIS LAW ─────────────────
 *
 * A future reader will find `0076` lifting `FORCE` on four relations
 * (`:99-101`, `:109`) and restoring it (`:357-360`) behind its own `pg_class`
 * assertion (`0076-E`, `:362-371`), and may be tempted to "fix" this law for
 * that window. Do not. Three independent reasons, each verified:
 * the applier runs ONE TRANSACTION PER FILE (`apps/api/src/infra/migrate.ts`
 * `:104-116`: `BEGIN`, the whole file, `COMMIT`), PostgreSQL's DDL is
 * transactional and `ALTER TABLE` takes ACCESS EXCLUSIVE, so no other session
 * ever observes the lifted state; the lift and the restore are in the same
 * file, so no committed state carries it; and all four relations are INHERITED
 * relations, which `isPhase4Relation` excludes from this law's surface
 * altogether. This law could not see that window even if it were committed.
 *
 * ── P4-AL-88 ─────────────────────────────────────────────────────────────
 *
 * Every condition below is universally quantified over whatever the discovery
 * returns. There is no equality against an enumeration, no count compared with
 * a literal, and no sentence of the form "nothing after N": P4-S3…P4-S8 adding
 * relations makes this law judge more subjects, never makes it red.
 *
 * `phase4RlsForceProblems` returns `string[]` — the estate's universal guard
 * contract — and every input is a parameter, so a fixture can be handed to it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHASE4_FIRST_NUMBER, phase4MigrationsOnDisk } from '../phase4-prefix';
import { isPhase4Relation, phase4InheritedPrefixRelations } from './no-authoritative-balance';
import { discoverStoredRelations } from './sql-schema';

/** The two column names `P4-AL-08` requires on every Phase 4 relation. Dimensions, not relation names. */
export const TENANT_COLUMN = 'tenant_id';
export const BUSINESS_COLUMN = 'business_id';

/** The applier module, relative to a repository root: the text the subtracted set is read from. */
export const APPLIER_SOURCE = 'apps/api/src/infra/migrate.ts';
/** This module, relative to a repository root: the subject of the "never a handwritten list" meta-assertion. */
export const LAW_MODULE = 'scripts/guards/phase4-rls-force.ts';
/** The migrations directory, relative to a repository root. */
export const MIGRATIONS_SUBDIR = 'infrastructure/database/migrations';

/**
 * One row of the live catalogue, as `LIVE_RELATION_SQL` returns it. The caller
 * supplies these, so the law never opens a connection and a fixture can stand
 * in for a database.
 */
export interface LiveRelation {
  readonly name: string;
  /** `pg_class.relkind`. Only `r` and `p` store rows and can carry row level security. */
  readonly kind: string;
  /** `pg_class.relrowsecurity`. */
  readonly rowSecurity: boolean;
  /** `pg_class.relforcerowsecurity`. */
  readonly forceRowSecurity: boolean;
  /** The relation's own column names, lower-case. */
  readonly columns: readonly string[];
}

/**
 * The one query that reads the live half. It enumerates `public` and asks
 * nothing about names, so it cannot omit a relation it has not heard of; the
 * Phase 4 filter is applied afterwards, by the shared predicate.
 */
export const LIVE_RELATION_SQL = `
  SELECT c.relname                                    AS name,
         c.relkind::text                              AS kind,
         c.relrowsecurity                              AS row_security,
         c.relforcerowsecurity                         AS force_row_security,
         COALESCE(
           (SELECT array_agg(lower(a.attname) ORDER BY a.attnum)
              FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
           '{}'::text[]
         )                                             AS columns
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   ORDER BY c.relname`;

/** A row of `LIVE_RELATION_SQL` as `pg` hands it back. */
export interface LiveRelationRow {
  readonly name: string;
  readonly kind: string;
  readonly row_security: boolean;
  readonly force_row_security: boolean;
  readonly columns: readonly string[] | null;
}

/** `LIVE_RELATION_SQL`'s rows in this module's shape. */
export const liveRelationsFromRows = (rows: readonly LiveRelationRow[]): LiveRelation[] =>
  rows.map((r) => ({
    name: r.name.toLowerCase(),
    kind: r.kind,
    rowSecurity: r.row_security === true,
    forceRowSecurity: r.force_row_security === true,
    columns: (r.columns ?? []).map((c) => c.toLowerCase()),
  }));

export interface Phase4RlsInput {
  /** The migrations directory the declared half is discovered from. */
  readonly migrationsDir: string;
  /** The applier's source text, from which the subtracted relations are discovered. */
  readonly applierSource: string;
  /**
   * The live catalogue, or `null` when none was read. `null` is NOT a pass: a
   * law that judged no subject is reported as having judged no subject.
   */
  readonly live: readonly LiveRelation[] | null;
}

export interface Phase4RlsPartition {
  /** Carries both dimensions: `ENABLE` + `FORCE` owed. */
  readonly tenantAndBusiness: readonly string[];
  /** Carries exactly one: a `P4-AL-08` violation, and `ENABLE` + `FORCE` still owed. */
  readonly oneDimension: readonly string[];
  /** Carries neither: a declared global registry, red until the lock decides. */
  readonly noDimension: readonly string[];
}

export interface Phase4RlsReport {
  /** The size of the digest-verified inherited prefix's relation set. Zero means the predicate is fail-empty. */
  readonly inheritedPrefixSize: number;
  /** The relations the applier's own source creates, subtracted from both halves. */
  readonly applierRelations: readonly string[];
  /** Half (i): Phase 4 relations declared by the migrations on disk. */
  readonly declared: readonly string[];
  /** Half (ii): Phase 4 relations present in the live catalogue, or `null` when none was read. */
  readonly liveSurface: readonly string[] | null;
  /** The union of the two halves: the surface this law is about. */
  readonly surface: readonly string[];
  /** The surface members present in the catalogue: exactly the relations whose RLS was judged. */
  readonly judged: readonly string[];
  /** Declared by a migration and absent from the catalogue read. */
  readonly declaredNotApplied: readonly string[];
  /** Present in the catalogue and declared by no migration on disk: the omissions of half (i). */
  readonly liveNotDeclared: readonly string[];
  readonly partition: Phase4RlsPartition;
  readonly problems: readonly string[];
}

const sorted = (s: Iterable<string>): string[] => [...new Set(s)].sort();

/**
 * The relations the applier's own source creates — read from that text with the
 * same reader the migrations are read with, so the subtraction is whatever the
 * applier declares and never a name written here.
 */
export function applierRelations(applierSource: string): string[] {
  return discoverStoredRelations(applierSource);
}

/**
 * Half (i): every Phase 4 relation the migrations on disk declare, minus the
 * applier's own. The upper bound of the file scan is the DERIVED
 * `PHASE4_FIRST_NUMBER`; no migration number is written here.
 */
export function declaredPhase4Relations(migrationsDir: string, applierSource: string): string[] {
  const excluded = new Set(applierRelations(applierSource));
  const found = new Set<string>();
  for (const file of phase4MigrationsOnDisk(migrationsDir)) {
    const path = join(migrationsDir, file);
    if (!existsSync(path)) continue;
    for (const relation of discoverStoredRelations(readFileSync(path, 'utf8'))) {
      const name = relation.toLowerCase();
      if (isPhase4Relation(name) && !excluded.has(name)) found.add(name);
    }
  }
  return sorted(found);
}

/** Half (ii): every Phase 4 relation in the live catalogue, minus the applier's own. */
export function livePhase4Relations(live: readonly LiveRelation[], applierSource: string): string[] {
  const excluded = new Set(applierRelations(applierSource));
  return sorted(live.filter((r) => isPhase4Relation(r.name) && !excluded.has(r.name)).map((r) => r.name));
}

/**
 * THE LAW. Universally quantified over the discovered surface; the full
 * reasoning is in the module header.
 */
export function phase4RlsForceReport(input: Phase4RlsInput): Phase4RlsReport {
  const problems: string[] = [];

  // ── Canary: the predicate's anchor is fail-empty, so an empty reading is a
  // tampered prefix and not a surface.
  const inheritedPrefixSize = phase4InheritedPrefixRelations().size;
  if (inheritedPrefixSize === 0)
    problems.push(
      'VACUOUS: the inherited-prefix reader returned no relation, so the Phase 4 predicate is the complement of the empty set and EVERY relation in the catalogue reads as Phase 4 — a missing or altered digest-verified prefix file, not a surface',
    );

  // ── Canary: the subtracted set is read from text, so an empty reading means
  // that text stopped declaring what it creates.
  const applier = applierRelations(input.applierSource);
  if (applier.length === 0)
    problems.push(
      `VACUOUS: no relation was discovered in the applier source handed to this law (${input.applierSource.length} characters), so the subtraction that keeps the runner's own bookkeeping out of this surface has no subject`,
    );

  const declared = declaredPhase4Relations(input.migrationsDir, input.applierSource);
  const liveSurface = input.live === null ? null : livePhase4Relations(input.live, input.applierSource);
  const surface = sorted([...declared, ...(liveSurface ?? [])]);

  if (surface.length === 0)
    problems.push(
      `VACUOUS: the discovery returned no Phase 4 relation at all, from ${phase4MigrationsOnDisk(input.migrationsDir).length} migration file(s) numbered past ${String(PHASE4_FIRST_NUMBER).padStart(4, '0')} and ${input.live === null ? 'no' : String(input.live.length)} catalogue row(s) — this law has no subject and must not be read as a pass`,
    );

  if (input.live === null) {
    problems.push(
      `VACUOUS: no live catalogue was read, so none of the ${surface.length} discovered Phase 4 relation(s) had its pg_class.relrowsecurity or pg_class.relforcerowsecurity judged — NOT A PASS`,
    );
  }

  const byName = new Map((input.live ?? []).map((r) => [r.name, r] as const));
  const judged = surface.filter((name) => byName.has(name));
  const declaredNotApplied = declared.filter((name) => input.live !== null && !byName.has(name));
  const liveNotDeclared = (liveSurface ?? []).filter((name) => !declared.includes(name));

  for (const name of declaredNotApplied)
    problems.push(
      `${name} is DECLARED AND NOT APPLIED: a Phase 4 migration on disk creates it and the catalogue this law read does not have it, so its row level security could not be judged`,
    );

  for (const name of liveNotDeclared)
    problems.push(
      `${name} is in the live catalogue as a Phase 4 relation and NO Phase 4 migration on disk declares it — the migration-tree half of this discovery OMITS it, and a relation that reached a database by a route the discovery cannot read is exactly the hole this law's second half exists to close`,
    );

  for (const name of judged) {
    const row = byName.get(name);
    if (row === undefined) continue;
    const columns = new Set(row.columns);
    const hasTenant = columns.has(TENANT_COLUMN);
    const hasBusiness = columns.has(BUSINESS_COLUMN);

    if (!hasTenant && !hasBusiness) {
      problems.push(
        `${name} carries neither ${TENANT_COLUMN} nor ${BUSINESS_COLUMN}: a declared Phase 4 GLOBAL REGISTRY. P4-AL-08 requires both on every Phase 4 relation and lock §17.3 refuses an allowlist, so this is RED until docs/PHASE_4_ARCHITECTURE_LOCK.md records a decision for a Phase 4 relation with no tenant dimension`,
      );
    } else if (!hasTenant || !hasBusiness) {
      problems.push(
        `${name} carries ${hasTenant ? TENANT_COLUMN : BUSINESS_COLUMN} and not ${hasTenant ? BUSINESS_COLUMN : TENANT_COLUMN}: a P4-AL-08 violation — every Phase 4 relation carries both as real columns`,
      );
    }

    // Owed by anything carrying a tenant dimension at all. The no-dimension
    // case is already red above and its RLS is not the question.
    if (hasTenant || hasBusiness) {
      if (!row.rowSecurity)
        problems.push(
          `${name}: pg_class.relrowsecurity is false — ROW LEVEL SECURITY is not ENABLED on a Phase 4 relation that carries a tenant dimension, so every policy written for it is inert and a cross-tenant read is served by the table itself (TL-P4-S1-R2)`,
        );
      if (!row.forceRowSecurity)
        problems.push(
          `${name}: pg_class.relforcerowsecurity is false — ROW LEVEL SECURITY is not FORCEd, so the relation's OWNER bypasses every policy on it and the migrator, the applier and any BYPASSRLS-free owner session read and write across every tenant (TL-P4-S1-R2)`,
        );
    }
  }

  return {
    inheritedPrefixSize,
    applierRelations: applier,
    declared,
    liveSurface,
    surface,
    judged,
    declaredNotApplied,
    liveNotDeclared,
    partition: {
      tenantAndBusiness: judged.filter((n) => {
        const c = new Set(byName.get(n)?.columns ?? []);
        return c.has(TENANT_COLUMN) && c.has(BUSINESS_COLUMN);
      }),
      oneDimension: judged.filter((n) => {
        const c = new Set(byName.get(n)?.columns ?? []);
        return c.has(TENANT_COLUMN) !== c.has(BUSINESS_COLUMN);
      }),
      noDimension: judged.filter((n) => {
        const c = new Set(byName.get(n)?.columns ?? []);
        return !c.has(TENANT_COLUMN) && !c.has(BUSINESS_COLUMN);
      }),
    },
    problems,
  };
}

/** The estate's universal guard contract: the problems, empty when the law holds. */
export function phase4RlsForceProblems(input: Phase4RlsInput): string[] {
  return [...phase4RlsForceReport(input).problems];
}

/**
 * "Never a handwritten list", made mechanical: no relation the discovery
 * returns may appear as a string literal anywhere in the law's own source. A
 * planted literal list would otherwise satisfy the ENABLE and FORCE proofs
 * while being blind to the relation nobody listed.
 */
export function handwrittenListProblems(lawSource: string, discovered: readonly string[]): string[] {
  const problems: string[] = [];
  for (const name of discovered) {
    const literal = new RegExp(String.raw`['"\`](?:public\.)?${name.replace(/[^\w]/g, '\\$&')}['"\`]`);
    if (literal.test(lawSource))
      problems.push(`${LAW_MODULE} contains "${name}" as a string literal — the Phase 4 surface is DISCOVERED, and a name written down is a name protected instead of a surface (TL-P4-S1-R2)`);
  }
  return problems;
}

/**
 * The half of this law that needs no database: the two fail-empty canaries, a
 * non-empty declared surface, and the meta-assertion above. This is what
 * `gate:phase4:s2` runs directly; the catalogue half is owned by
 * `tests/guards/phase4-rls-force-guard.test.ts`, which the same gate executes.
 */
export function phase4RlsForceStructuralProblems(root: string): string[] {
  const migrationsDir = join(root, MIGRATIONS_SUBDIR);
  const applierPath = join(root, APPLIER_SOURCE);
  const lawPath = join(root, LAW_MODULE);
  if (!existsSync(applierPath)) return [`${APPLIER_SOURCE} is missing — the subtracted set is read from its text and cannot be read from anywhere else`];
  if (!existsSync(lawPath)) return [`${LAW_MODULE} is missing`];
  const applierSource = readFileSync(applierPath, 'utf8');
  const problems = phase4RlsForceProblems({ migrationsDir, applierSource, live: null }).filter((p) => !p.includes('no live catalogue was read'));
  problems.push(...handwrittenListProblems(readFileSync(lawPath, 'utf8'), declaredPhase4Relations(migrationsDir, applierSource)));
  return problems;
}

if (require.main === module) {
  const rootArg = process.argv.slice(2).find((a) => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : join(__dirname, '../..');
  const problems = phase4RlsForceStructuralProblems(root);
  if (problems.length > 0) {
    console.error(`FAIL the Phase 4 RLS/FORCE discovery (structural half) at ${root}\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const applierSource = readFileSync(join(root, APPLIER_SOURCE), 'utf8');
  const report = phase4RlsForceReport({ migrationsDir: join(root, MIGRATIONS_SUBDIR), applierSource, live: null });
  console.log(
    `PASS the Phase 4 RLS/FORCE discovery (structural half) at ${root}: ${report.inheritedPrefixSize} inherited relations read from the digest-verified prefix; ` +
      `${report.declared.length} Phase 4 relation(s) declared by ${phase4MigrationsOnDisk(join(root, MIGRATIONS_SUBDIR)).length} migration file(s) numbered past ${String(PHASE4_FIRST_NUMBER - 1).padStart(4, '0')}; ` +
      `${report.applierRelations.length} applier relation(s) subtracted, discovered from ${APPLIER_SOURCE}; no discovered name appears as a literal in ${LAW_MODULE}. The catalogue half runs in tests/guards.`,
  );
}
