/**
 * P4-S2 — THE PHASE 4 RLS `ENABLE`/`FORCE` DISCOVERY LAW, AND THE PROOF THAT
 * ITS DISCOVERY IS COMPLETE (`TL-P4-S1-R2`, lock §25).
 *
 * The law is `scripts/guards/phase4-rls-force.ts`. Its subject set is
 * discovered twice — from the migration tree and from the live catalogue — and
 * never written down, so this suite has to prove THREE things and not one:
 *
 *   RP-RLS-A  a Phase 4 relation with ROW LEVEL SECURITY disabled is caught;
 *   RP-RLS-B  a Phase 4 relation with FORCE lifted is caught;
 *   RP-RLS-C  a Phase 4 relation the discovery OMITS is caught — in BOTH
 *             directions, because each half of the discovery is the other's
 *             completeness proof: a relation in the catalogue that no migration
 *             declares, and a relation a migration declares that the catalogue
 *             does not have.
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`, and its counterpart: a
 * rule with no NOT-A-FINDING case is a rule about a string. Every plant below
 * is therefore undone and the law is required to fall silent.
 *
 * ── WHY THE CANARY'S NAME IS GENERATED AT RUN TIME ───────────────────────
 *
 * RP-RLS-C's whole point is that no literal anywhere in the tree can be the
 * reason the relation was found. A planted name that appeared in any source
 * file would let a law carrying a handwritten list pass A and B and still pass
 * C falsely. The name is therefore built from this process's pid and the clock,
 * so it exists nowhere until the moment it is created. `assertedLiteralFree`
 * checks that claim against the law's own source rather than assuming it, and
 * `handwrittenListProblems` makes the general rule mechanical.
 *
 * ── HOW THE PLANTS ARE MADE AND UNDONE ───────────────────────────────────
 *
 * The catalogue plants happen inside a transaction that is ALWAYS rolled back
 * (`rolledBack`, the house pattern of
 * `tests/guards/phase4-composite-seam-guard.test.ts:59-69`): PostgreSQL's DDL
 * is transactional, so `DISABLE ROW LEVEL SECURITY`, `NO FORCE ROW LEVEL
 * SECURITY` and `CREATE TABLE` are all undone by the `ROLLBACK`, no other
 * session ever observes them, and nothing is left behind for the next suite.
 * The real migration directory is NEVER touched — editing an applied migration
 * breaks every suite with "Migration tampered after apply" — so the declared
 * half is planted into a COPY of it in a temporary directory, the house pattern
 * of `tests/guards/phase4-deferred-seam-guard.test.ts:38-52`. The planted
 * file's number is derived from the head on disk, so this suite names no
 * migration that does not exist.
 *
 * No assertion here pins the SIZE of the surface or of the prefix to a literal:
 * P4-S3…P4-S8 add Phase 4 relations, and an equality against today's count is
 * precisely the P4-AL-88 defect. The non-vacuity canaries are FLOORS, which can
 * only be crossed in the direction that is already a failure.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPLIER_SOURCE,
  BUSINESS_COLUMN,
  LAW_MODULE,
  LIVE_RELATION_SQL,
  MIGRATIONS_SUBDIR,
  TENANT_COLUMN,
  type LiveRelation,
  type LiveRelationRow,
  declaredPhase4Relations,
  handwrittenListProblems,
  liveRelationsFromRows,
  relkindStorage,
  rowStoringRelations,
  phase4RlsForceProblems,
  phase4RlsForceReport,
  phase4RlsForceStructuralProblems,
} from '../../scripts/guards/phase4-rls-force';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

const REPO = join(__dirname, '..', '..');
const MIGRATIONS = join(REPO, MIGRATIONS_SUBDIR);
const APPLIER = readFileSync(join(REPO, APPLIER_SOURCE), 'utf8');
const LAW_SOURCE = readFileSync(join(REPO, LAW_MODULE), 'utf8');

/** A floor on the inherited prefix, never an equality: it is 109 today and it only grows. */
const PREFIX_FLOOR = 50;

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  await ensurePostgres();
}, 120_000);

/** `body` against a transaction that is always rolled back, so every plant is undone. */
async function rolledBack(body: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    await body(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** The live catalogue as the law takes it, read through `c` so a plant inside its transaction is visible. */
async function catalogue(c: PoolClient): Promise<LiveRelation[]> {
  return liveRelationsFromRows((await c.query<LiveRelationRow>(LIVE_RELATION_SQL)).rows);
}

/** The law over the real tree and a given catalogue. */
const law = (live: readonly LiveRelation[] | null, migrationsDir = MIGRATIONS): string[] =>
  phase4RlsForceProblems({ migrationsDir, applierSource: APPLIER, live });

const report = (live: readonly LiveRelation[] | null, migrationsDir = MIGRATIONS) => phase4RlsForceReport({ migrationsDir, applierSource: APPLIER, live });

/** The problems naming `name`, so a plant's own finding is read rather than the whole list. */
const about = (problems: readonly string[], name: string): string[] => problems.filter((p) => p.includes(name));

/** A name that exists in no file in this tree: pid plus the clock, base 36. */
const canaryName = (): string => `p4_rls_discovery_canary_${process.pid}_${Date.now().toString(36)}`;

/** The migration number one past the head on disk, as a file name. Derived, so no future file is named here. */
function plantedMigrationName(): string {
  const head = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .slice(-1)[0];
  if (head === undefined) throw new Error('no migration on disk');
  return `${String(Number(head.slice(0, 4)) + 1).padStart(4, '0')}_planted.sql`;
}

/** A migrations directory that is the real one plus one further Phase 4 file. The real one is never touched. */
function migrationsPlus(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'p4-rls-'));
  temporaries.push(dir);
  const migrations = join(dir, MIGRATIONS_SUBDIR);
  mkdirSync(migrations, { recursive: true });
  cpSync(MIGRATIONS, migrations, { recursive: true });
  writeFileSync(join(migrations, plantedMigrationName()), sql);
  return migrations;
}

// ─────────────────────────────────────────────────────────────────────────

describe('the discovery has a subject, and the claim is not vacuous', () => {
  it('the inherited-prefix reader is not empty, so the Phase 4 predicate is not the complement of nothing', () => {
    // The predicate is FAIL-EMPTY by design: a tampered prefix file yields an
    // empty set and every relation then reads as Phase 4. That direction is
    // stricter, but it is a tampered tree and not a surface, so the law names
    // it. A floor, never an equality (P4-AL-88).
    expect(report(null).inheritedPrefixSize, 'the digest-verified inherited prefix read no relation').toBeGreaterThan(PREFIX_FLOOR);
  });

  it('the applier subtraction has a subject, discovered from the applier source and from no literal', () => {
    const applier = report(null).applierRelations;
    expect(applier.length, 'the applier source declares no relation, so the subtraction has no subject').toBeGreaterThan(0);
    for (const name of applier) expect(name).not.toBe('');
  });

  it('the declared half has a subject: the migration tree really does make Phase 4 relations', () => {
    expect(report(null).declared.length, 'no Phase 4 relation was discovered from the migration tree').toBeGreaterThan(0);
  });

  it('a law handed no catalogue reports that it judged nothing — NOT A PASS', () => {
    const r = report(null);
    expect(r.judged).toEqual([]);
    expect(r.problems.join('\n')).toContain('no live catalogue was read');
    expect(r.problems.join('\n')).toContain('NOT A PASS');
  });
});

describe('the tree as it stands is safe, and that silence is about real subjects', () => {
  it('the structural half finds nothing to report', () => {
    expect(phase4RlsForceStructuralProblems(REPO)).toEqual([]);
  });

  it('the law is silent over the live catalogue, and it judged every relation it discovered', async () => {
    await rolledBack(async (c) => {
      const live = await catalogue(c);
      const r = report(live);
      expect(r.problems).toEqual([]);

      // The two halves AGREE: nothing is declared and not applied, and nothing
      // is in the catalogue that no migration declares.
      expect(r.declaredNotApplied).toEqual([]);
      expect(r.liveNotDeclared).toEqual([]);
      expect(r.liveSurface).toEqual([...r.declared]);

      // The count actually judged is exactly |surface ∩ live|, and it is not
      // zero. A claim with no subject must fail, never pass.
      const intersection = r.surface.filter((n) => live.some((row) => row.name === n));
      expect(r.judged).toEqual(intersection);
      expect(r.judged.length).toBeGreaterThan(0);
      expect(r.judged).toEqual([...r.surface]);

      // The structural partition: today every judged relation carries both
      // dimensions, so the P4-AL-08 arm and the global-registry arm have no
      // subject — stated positively rather than left unmentioned.
      expect(r.partition.tenantAndBusiness).toEqual([...r.judged]);
      expect(r.partition.oneDimension).toEqual([]);
      expect(r.partition.noDimension).toEqual([]);

      // And the silence is about pg_class, not about an empty query: every
      // judged relation really does report both flags true.
      for (const name of r.judged) {
        const row = live.find((x) => x.name === name);
        expect(row, `${name} was judged but is not in the catalogue rows`).toBeDefined();
        expect(row?.rowSecurity, `${name}.relrowsecurity`).toBe(true);
        expect(row?.forceRowSecurity, `${name}.relforcerowsecurity`).toBe(true);
        expect(row?.columns).toContain(TENANT_COLUMN);
        expect(row?.columns).toContain(BUSINESS_COLUMN);
      }
    });
  });

  it('the surface is DISCOVERED: no relation it returns is a string literal in the law’s own module', () => {
    const discovered = declaredPhase4Relations(MIGRATIONS, APPLIER);
    expect(discovered.length).toBeGreaterThan(0);
    expect(handwrittenListProblems(LAW_SOURCE, discovered)).toEqual([]);
  });
});

describe('RP-RLS-A — a Phase 4 relation with ROW LEVEL SECURITY disabled is caught', () => {
  it('DISABLE on a discovered relation is named, and ENABLE restores the silence', async () => {
    await rolledBack(async (c) => {
      // The subject is taken FROM THE DISCOVERY, so this proof carries no
      // relation name of its own either.
      const subject = report(await catalogue(c)).judged[0];
      expect(subject, 'the discovery returned no relation to plant against').toBeDefined();
      const name = subject as string;

      await c.query(`ALTER TABLE ${name} DISABLE ROW LEVEL SECURITY`);
      const planted = await catalogue(c);
      expect(planted.find((r) => r.name === name)?.rowSecurity, 'the plant did not take').toBe(false);
      const found = about(law(planted), name);
      expect(found.join('\n')).toContain('relrowsecurity is false');
      expect(found.join('\n')).toContain('not ENABLED');

      await c.query(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
      expect(law(await catalogue(c))).toEqual([]);
    });
  });
});

describe('RP-RLS-B — a Phase 4 relation with FORCE lifted is caught', () => {
  it('NO FORCE on a discovered relation is named, and FORCE restores the silence', async () => {
    await rolledBack(async (c) => {
      const subject = report(await catalogue(c)).judged[0];
      expect(subject, 'the discovery returned no relation to plant against').toBeDefined();
      const name = subject as string;

      await c.query(`ALTER TABLE ${name} NO FORCE ROW LEVEL SECURITY`);
      const planted = await catalogue(c);
      // The two flags are independent: lifting FORCE leaves ENABLE true, so
      // this proof is genuinely about the second flag and not a re-run of A.
      expect(planted.find((r) => r.name === name)?.rowSecurity, 'the plant also disabled RLS, so this is not the FORCE proof').toBe(true);
      expect(planted.find((r) => r.name === name)?.forceRowSecurity, 'the plant did not take').toBe(false);
      const found = about(law(planted), name);
      expect(found.join('\n')).toContain('relforcerowsecurity is false');
      expect(found.join('\n')).toContain('not FORCEd');

      await c.query(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`);
      expect(law(await catalogue(c))).toEqual([]);
    });
  });
});

describe('RP-RLS-C — a newly created Phase 4 relation the discovery OMITS is caught', () => {
  it('the canary’s name is in no source file, so no handwritten list can be the reason it is found', () => {
    const name = canaryName();
    expect(name).toMatch(/^p4_rls_discovery_canary_\d+_[0-9a-z]+$/);
    // The generated half, which is what makes the name unique, appears in no
    // tracked source: the law's module is the one that matters, and the
    // mechanical rule is asserted over the whole discovery above.
    expect(LAW_SOURCE).not.toContain(name);
    expect(readFileSync(__filename, 'utf8')).not.toContain(name);
  });

  it('the MIGRATION-TREE half omits a relation only the catalogue has, and the law names the omission', async () => {
    await rolledBack(async (c) => {
      const name = canaryName();
      // Created directly on the database — a hand-run statement on a
      // deployment, a restored dump, DDL from inside a DO block: every route
      // by which a relation reaches a database without a migration the text
      // parser can read.
      await c.query(
        `CREATE TABLE ${name} (${TENANT_COLUMN} UUID NOT NULL, ${BUSINESS_COLUMN} UUID NOT NULL, id UUID NOT NULL, PRIMARY KEY (${BUSINESS_COLUMN}, id))`,
      );
      const live = await catalogue(c);
      const r = report(live);

      // THE DISCOVERY'S OWN COMPLETENESS, not just the assertion: the subject
      // set CONTAINS the canary although no migration declares it.
      expect(r.declared, 'the migration tree cannot know about it, which is the point').not.toContain(name);
      expect(r.liveSurface).toContain(name);
      expect(r.surface).toContain(name);
      expect(r.judged).toContain(name);
      expect(r.liveNotDeclared).toEqual([name]);

      // And the LAW names it — twice over: as an omission of half (i), and as
      // a relation with no row level security at all.
      const found = about(r.problems, name);
      expect(found.join('\n')).toContain('OMITS it');
      expect(found.join('\n')).toContain('relrowsecurity is false');
      expect(found.join('\n')).toContain('relforcerowsecurity is false');

      // Enabling and forcing removes the RLS findings and LEAVES the omission,
      // because the relation really is undeclared: the two findings are
      // independent and the law does not absorb one into the other.
      await c.query(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`);
      const after = about(law(await catalogue(c)), name);
      expect(after).toHaveLength(1);
      expect(after.join('\n')).toContain('OMITS it');
    });
  });

  it('the CATALOGUE half omits a relation only a migration declares, and the law reports it as declared and not applied', async () => {
    await rolledBack(async (c) => {
      const name = canaryName();
      const planted = migrationsPlus(
        `CREATE TABLE ${name} (${TENANT_COLUMN} UUID NOT NULL, ${BUSINESS_COLUMN} UUID NOT NULL, id UUID NOT NULL, PRIMARY KEY (${BUSINESS_COLUMN}, id));\n` +
          `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;\nALTER TABLE ${name} FORCE ROW LEVEL SECURITY;\n`,
      );
      const live = await catalogue(c);
      const r = report(live, planted);

      expect(r.declared).toContain(name);
      expect(r.liveSurface, 'the catalogue cannot know about an unapplied migration, which is the point').not.toContain(name);
      expect(r.surface).toContain(name);
      expect(r.judged).not.toContain(name);
      expect(r.declaredNotApplied).toEqual([name]);

      const found = about(r.problems, name);
      expect(found).toHaveLength(1);
      expect(found.join('\n')).toContain('DECLARED AND NOT APPLIED');
      expect(found.join('\n')).toContain('could not be judged');

      // NOT A FINDING: apply it, and the two halves agree — the law is
      // completely silent about the canary, from the same code.
      await c.query(
        `CREATE TABLE ${name} (${TENANT_COLUMN} UUID NOT NULL, ${BUSINESS_COLUMN} UUID NOT NULL, id UUID NOT NULL, PRIMARY KEY (${BUSINESS_COLUMN}, id))`,
      );
      await c.query(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`);
      const applied = report(await catalogue(c), planted);
      expect(about(applied.problems, name)).toEqual([]);
      expect(applied.problems).toEqual([]);
      expect(applied.judged).toContain(name);
      expect(applied.declaredNotApplied).toEqual([]);
      expect(applied.liveNotDeclared).toEqual([]);
    });
  });

  it('a discovery that carried a handwritten list would be CAUGHT by the mechanical rule', () => {
    const name = canaryName();
    // The meta-assertion is not decoration: handed a source that names a
    // discovered relation, it refuses it. Proved on a synthetic source so the
    // law's own module is never edited to prove a point about it.
    expect(handwrittenListProblems(`const SURFACE = ['${name}'];`, [name]).join('\n')).toContain('as a string literal');
    expect(handwrittenListProblems(`const SURFACE: string[] = [];`, [name])).toEqual([]);
  });
});

describe('the structural partition raises a decision instead of a false red or a silent hole', () => {
  it('a Phase 4 relation carrying exactly one dimension is a P4-AL-08 violation, and RLS is still owed', async () => {
    await rolledBack(async (c) => {
      const name = canaryName();
      await c.query(`CREATE TABLE ${name} (${BUSINESS_COLUMN} UUID NOT NULL, id UUID NOT NULL, PRIMARY KEY (${BUSINESS_COLUMN}, id))`);
      const r = report(await catalogue(c));
      expect(r.partition.oneDimension).toContain(name);
      const found = about(r.problems, name).join('\n');
      expect(found).toContain('P4-AL-08 violation');
      expect(found).toContain(`carries ${BUSINESS_COLUMN} and not ${TENANT_COLUMN}`);
      // A single dimension still leaks the other, so the RLS claim is not
      // dropped for it.
      expect(found).toContain('relrowsecurity is false');
      expect(found).toContain('relforcerowsecurity is false');
    });
  });

  it('a Phase 4 relation carrying neither dimension is red until the lock records a decision', async () => {
    await rolledBack(async (c) => {
      const name = canaryName();
      await c.query(`CREATE TABLE ${name} (id UUID NOT NULL PRIMARY KEY, label TEXT NOT NULL)`);
      await c.query(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`);
      const r = report(await catalogue(c));
      expect(r.partition.noDimension).toContain(name);
      const found = about(r.problems, name).join('\n');
      expect(found).toContain('GLOBAL REGISTRY');
      expect(found).toContain('refuses an allowlist');
      // Red EVEN WITH both flags set: the decision is owed, and ENABLE+FORCE
      // is not a substitute for it. That is the difference between raising a
      // decision and leaving a silent hole.
      expect(found).not.toContain('relrowsecurity is false');
    });
  });
});

describe('the law weakens no Phase 3 guard', () => {
  it('every inherited relation is outside this law’s surface, however its row level security stands', async () => {
    await rolledBack(async (c) => {
      const live = await catalogue(c);
      const r = report(live);
      const inherited = live.filter((row) => !r.surface.includes(row.name) && !r.applierRelations.includes(row.name));
      expect(inherited.length, 'no inherited relation was found, so this claim has no subject').toBeGreaterThan(PREFIX_FLOOR);
      // The reason the scope matters, measured rather than asserted from the
      // lock: the inherited history deliberately leaves row level security off
      // relations with no tenant dimension, so a tree-wide form of this law
      // would be RED ON ARRIVAL on a surface Phase 4 does not own.
      const withoutForce = inherited.filter((row) => !row.forceRowSecurity);
      expect(withoutForce.length, 'the inherited surface already forces RLS everywhere, so the Phase 4 scoping needs no defence').toBeGreaterThan(0);
      // None of them is this law's business, and none of them is reported.
      for (const row of withoutForce) expect(about(r.problems, row.name)).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE LIVE HALF'S OWN DISCOVERY, AND THE TWO SUBJECTS IT USED TO MISS.
//
// Half (ii) read `WHERE n.nspname = 'public' AND c.relkind IN ('r','p')` — a
// NAME filter and a KIND ENUMERATION wearing discovery's clothes. Everything
// else was neither passed nor failed: it was never judged and never reported.
// The proofs below are in three layers, because each answers a question the
// others cannot:
//
//   PG-RLS-KIND  what PostgreSQL ACTUALLY allows, executed against the real
//                cluster — because the correct fix turns on a fact (`m` and
//                `f` cannot carry row level security AT ALL) that must be
//                measured and not remembered. Widening the `IN (...)` list
//                would have been the wrong fix, and this is why.
//   RP-RLS-D     the law over FIXTURES, so the judgement is proved on the pure
//                function the law was built to be.
//   RP-RLS-E/F   the same two subjects created on a REAL cluster and read back
//                through `LIVE_RELATION_SQL`, so the SQL itself is proved and
//                not only the TypeScript. Each one also shows, in the same
//                transaction, that the OLD predicate does not return it.
// ─────────────────────────────────────────────────────────────────────────

/** The predicate half (ii) carried before this correction. Quoted here so the defect is executed rather than described. */
const NARROWED_PREDICATE_SQL = `
  SELECT c.relname AS name, c.relkind::text AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
   ORDER BY c.relname`;

/** The names the OLD predicate returns, for the "it could not see this" half of each live proof. */
async function narrowedNames(c: PoolClient): Promise<string[]> {
  return (await c.query<{ name: string }>(NARROWED_PREDICATE_SQL)).rows.map((r) => r.name.toLowerCase());
}

/** A namespace name that exists in no file in this tree. */
const canarySchema = (): string => `p4_rls_schema_canary_${process.pid}_${Date.now().toString(36)}`;

/**
 * A fixture catalogue in which every Phase 4 relation the migration tree
 * declares is present and compliant, so each plant below produces exactly its
 * own finding and not the DECLARED-AND-NOT-APPLIED noise of a short catalogue.
 */
const compliantCatalogue = (): LiveRelation[] =>
  declaredPhase4Relations(MIGRATIONS, APPLIER).map((name) => ({
    name,
    schema: 'public',
    kind: 'r',
    rowSecurity: true,
    forceRowSecurity: true,
    columns: [TENANT_COLUMN, BUSINESS_COLUMN],
  }));

/** `body` against its own always-rolled-back transaction, tolerating the SQLSTATE 42809 aborts the probes provoke. */
async function expectRefusal(c: PoolClient, sql: string): Promise<{ readonly code: string; readonly message: string }> {
  await c.query('SAVEPOINT probe');
  try {
    await c.query(sql);
    await c.query('RELEASE SAVEPOINT probe');
    return { code: 'NONE — THE STATEMENT SUCCEEDED', message: sql };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    return { code: (e as { code?: string }).code ?? 'NO SQLSTATE', message: (e as Error).message };
  }
}

describe('PG-RLS-KIND — what PostgreSQL allows, measured against the cluster and not remembered', () => {
  it('a materialized view is relkind m, its relrowsecurity is false, and ENABLE, FORCE and CREATE POLICY are ALL refused', async () => {
    await rolledBack(async (c) => {
      const base = canaryName();
      const view = canaryName() + '_mv';
      await c.query(`CREATE TABLE ${base} (${TENANT_COLUMN} UUID NOT NULL, ${BUSINESS_COLUMN} UUID NOT NULL, id UUID NOT NULL)`);
      await c.query(`CREATE MATERIALIZED VIEW ${view} AS SELECT ${TENANT_COLUMN}, ${BUSINESS_COLUMN}, id FROM ${base} WITH NO DATA`);

      const row = (
        await c.query<{ kind: string; rls: boolean; force: boolean }>(
          `SELECT c.relkind::text AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c WHERE c.relname = $1`,
          [view],
        )
      ).rows[0];
      expect(row?.kind, 'a materialized view is not relkind m on this cluster, so the premise of this law is wrong').toBe('m');
      expect(row?.rls).toBe(false);
      expect(row?.force).toBe(false);

      // THE REASON WIDENING THE `IN (...)` LIST WOULD HAVE BEEN WRONG: there is
      // no legal way to satisfy an ENABLE or a FORCE demand on this relation.
      for (const sql of [
        `ALTER TABLE ${view} ENABLE ROW LEVEL SECURITY`,
        `ALTER MATERIALIZED VIEW ${view} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${view} FORCE ROW LEVEL SECURITY`,
        `ALTER MATERIALIZED VIEW ${view} FORCE ROW LEVEL SECURITY`,
      ]) {
        const refusal = await expectRefusal(c, sql);
        expect(refusal.code, `${sql} was NOT refused`).toBe('42809');
        expect(refusal.message).toContain('cannot be performed on relation');
      }
      const policy = await expectRefusal(c, `CREATE POLICY ${canaryName()}_p ON ${view} USING (true)`);
      expect(policy.code).toBe('42809');
      expect(policy.message).toContain('is not a table');

      // And the classification this law judges by agrees with the cluster.
      expect(relkindStorage('m')).toBe('rows-without-rls');
    });
  });

  it('a foreign table is relkind f and refuses ENABLE, FORCE and CREATE POLICY the same way', async () => {
    await rolledBack(async (c) => {
      const base = canaryName();
      const ft = canaryName() + '_ft';
      const server = canaryName() + '_srv';
      await c.query(`CREATE TABLE ${base} (${TENANT_COLUMN} UUID NOT NULL, ${BUSINESS_COLUMN} UUID NOT NULL, id UUID NOT NULL)`);
      await c.query(`CREATE EXTENSION IF NOT EXISTS postgres_fdw`);
      await c.query(`CREATE SERVER ${server} FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'localhost', dbname 'daftar')`);
      await c.query(`CREATE FOREIGN TABLE ${ft} (${TENANT_COLUMN} UUID, ${BUSINESS_COLUMN} UUID, id UUID) SERVER ${server} OPTIONS (table_name '${base}')`);

      const row = (
        await c.query<{ kind: string; rls: boolean }>(`SELECT c.relkind::text AS kind, c.relrowsecurity AS rls FROM pg_class c WHERE c.relname = $1`, [ft])
      ).rows[0];
      expect(row?.kind).toBe('f');
      expect(row?.rls).toBe(false);

      for (const sql of [`ALTER TABLE ${ft} ENABLE ROW LEVEL SECURITY`, `ALTER FOREIGN TABLE ${ft} ENABLE ROW LEVEL SECURITY`]) {
        const refusal = await expectRefusal(c, sql);
        expect(refusal.code, `${sql} was NOT refused`).toBe('42809');
        expect(refusal.message).toContain('cannot be performed on relation');
      }
      expect((await expectRefusal(c, `CREATE POLICY ${canaryName()}_p ON ${ft} USING (true)`)).code).toBe('42809');

      expect(relkindStorage('f')).toBe('rows-without-rls');
    });
  });

  it('an ordinary table DOES take both, so the refusals above are about the relkind and not about the cluster', async () => {
    await rolledBack(async (c) => {
      const name = canaryName();
      await c.query(`CREATE TABLE ${name} (${TENANT_COLUMN} UUID NOT NULL, ${BUSINESS_COLUMN} UUID NOT NULL, id UUID NOT NULL)`);
      expect((await expectRefusal(c, `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`)).code).toBe('NONE — THE STATEMENT SUCCEEDED');
      expect((await expectRefusal(c, `ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`)).code).toBe('NONE — THE STATEMENT SUCCEEDED');
      const row = (
        await c.query<{ kind: string; rls: boolean; force: boolean }>(
          `SELECT c.relkind::text AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c WHERE c.relname = $1`,
          [name],
        )
      ).rows[0];
      expect(row?.kind).toBe('r');
      expect(row?.rls).toBe(true);
      expect(row?.force).toBe(true);
      expect(relkindStorage('r')).toBe('rows-with-rls');
    });
  });
});

describe('the new predicate is not vacuous, in BOTH of its directions', () => {
  it('the catalogue read really does reach past r and p, and the row-storing classification really does discriminate', async () => {
    await rolledBack(async (c) => {
      const live = await catalogue(c);
      const kinds = new Set(live.map((r) => r.kind));

      // DIRECTION ONE: the read is wider than the predicate it replaced. More
      // than one relkind comes back, so dropping the `IN (...)` list is
      // observable and not a comment.
      expect(kinds.size, 'the read returned a single relkind, so it is still a kind enumeration in disguise').toBeGreaterThan(1);
      expect(live.length).toBeGreaterThan(0);

      // DIRECTION TWO: the classification SUBTRACTS something real. This tree's
      // `public` holds hundreds of indexes and several composite types, none of
      // which stores a row of its own and every one of which
      // `isPhase4Relation` would otherwise call Phase 4.
      const storing = rowStoringRelations(live);
      expect(storing.length, 'nothing in the catalogue stores rows, so this law has no subject').toBeGreaterThan(0);
      expect(storing.length, 'the row-storing classification excluded nothing, so it has no subject in that direction').toBeLessThan(live.length);

      // Every relkind the read returned IS classified: an unclassified kind on
      // this tree would be a finding, and there is none.
      for (const kind of kinds) expect(relkindStorage(kind), `pg_class.relkind '${kind}' is unclassified`).not.toBe('unclassified');

      // And the classification is TOTAL rather than a whitelist: a relkind
      // PostgreSQL has not got is named, not dropped.
      expect(relkindStorage('not-a-relkind')).toBe('unclassified');
    });
  });

  it('the reserved namespaces are excluded, and that exclusion has a real subject', async () => {
    await rolledBack(async (c) => {
      // `information_schema` holds relkind 'r' relations on this cluster, so
      // excluding it is load-bearing: without it they would enter the surface.
      const reserved = (
        await c.query<{ nspname: string; name: string }>(
          `SELECT n.nspname, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE (n.nspname LIKE 'pg\\_%' OR n.nspname = 'information_schema') AND c.relkind = 'r' ORDER BY 1, 2`,
        )
      ).rows;
      expect(reserved.length, 'no system relation exists, so the reserved-namespace exclusion has no subject').toBeGreaterThan(0);
      expect(new Set(reserved.map((r) => r.nspname)).size).toBeGreaterThan(1);

      const live = await catalogue(c);
      for (const r of reserved)
        expect(
          live.some((row) => row.schema === r.nspname),
          `${r.nspname}.${r.name} leaked into the discovered surface`,
        ).toBe(false);

      // The filter is NEGATIVE: it excludes only namespaces nobody may create
      // in, so a namespace a statement DOES create is discovered with no edit.
      const schema = canarySchema();
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`CREATE TABLE ${schema}.${canaryName()} (id UUID NOT NULL)`);
      expect(
        (await catalogue(c)).some((row) => row.schema === schema),
        'a namespace created in this transaction was not discovered',
      ).toBe(true);
    });
  });

  it('the reserved prefix cannot be used to hide a relation, because PostgreSQL itself refuses the name', async () => {
    await rolledBack(async (c) => {
      // The one way the negative filter could hide a subject would be a
      // namespace someone created inside the excluded prefix. PostgreSQL does
      // not allow it — asserted against the cluster, not assumed — so the
      // exclusion cannot be turned into a hiding place, not even by the
      // superuser this suite connects as.
      const refusal = await expectRefusal(c, `CREATE SCHEMA pg_${canaryName()}`);
      expect(refusal.code, 'a schema inside the reserved prefix WAS created, so the discovery filter can be evaded').toBe('42939');
      expect(refusal.message).toContain('unacceptable schema name');
    });
  });
});

describe('RP-RLS-D — a relkind that CANNOT carry row level security is its own finding, not a FORCE demand', () => {
  it('red: a Phase 4 materialized view carrying both dimensions is named for what it is, over a fixture', () => {
    const name = canaryName();
    const r = report([
      ...compliantCatalogue(),
      { name, schema: 'public', kind: 'm', rowSecurity: false, forceRowSecurity: false, columns: [TENANT_COLUMN, BUSINESS_COLUMN, 'balance_minor'] },
    ]);

    // It is DISCOVERED and JUDGED — the thing the old predicate made impossible.
    expect(r.liveSurface).toContain(name);
    expect(r.judged).toContain(name);
    expect(r.partition.tenantAndBusiness).toContain(name);

    const found = about(r.problems, name);
    const text = found.join('\n');
    expect(text).toContain('STORES TENANT ROWS AND CANNOT CARRY ROW LEVEL SECURITY');
    expect(text).toContain("pg_class.relkind is 'm'");
    expect(text).toContain('42809');
    expect(text).toContain('cache, snapshot or rollup');

    // NOT a FORCE demand: a finding with no legal fix is not a law, it is
    // noise, and this is the trap a widened `IN (...)` list would have set.
    expect(text).not.toContain('is not ENABLED on a Phase 4 relation');
    expect(text).not.toContain('ROW LEVEL SECURITY is not FORCEd');

    // Exactly its own two findings: the half-(i) omission, and this one.
    expect(found).toHaveLength(2);
    expect(text).toContain('OMITS it');
  });

  it('a foreign table on the surface is the same finding, and an index of the same name is no subject at all', () => {
    const name = canaryName();
    const asForeign = about(
      report([
        ...compliantCatalogue(),
        { name, schema: 'public', kind: 'f', rowSecurity: false, forceRowSecurity: false, columns: [TENANT_COLUMN, BUSINESS_COLUMN] },
      ]).problems,
      name,
    ).join('\n');
    expect(asForeign).toContain('CANNOT CARRY ROW LEVEL SECURITY');
    expect(asForeign).toContain("pg_class.relkind is 'f'");

    // NOT-A-FINDING: an index holds no row of its own, so it is not a subject
    // — which is what keeps this tree's hundreds of `public` indexes out.
    const asIndex = report([...compliantCatalogue(), { name, schema: 'public', kind: 'i', rowSecurity: false, forceRowSecurity: false, columns: [] }]);
    expect(asIndex.liveSurface).not.toContain(name);
    expect(asIndex.judged).not.toContain(name);
    expect(about(asIndex.problems, name)).toEqual([]);
    expect(asIndex.problems).toEqual([]);
  });

  it('red: a relkind this law cannot classify is REPORTED and never skipped', () => {
    const name = canaryName();
    const r = report([
      ...compliantCatalogue(),
      { name, schema: 'public', kind: 'Z', rowSecurity: false, forceRowSecurity: false, columns: [TENANT_COLUMN, BUSINESS_COLUMN] },
    ]);
    expect(r.judged, 'an unclassified relkind fell out of the surface instead of being judged').toContain(name);
    const text = about(r.problems, name).join('\n');
    expect(text).toContain("pg_class.relkind is 'Z'");
    expect(text).toContain('does not classify');
    expect(text).toContain('must raise a decision');
  });

  it('NOT A FINDING: the same name as an ordinary table with both flags set is silent but for the omission', () => {
    const name = canaryName();
    const found = about(
      report([
        ...compliantCatalogue(),
        { name, schema: 'public', kind: 'r', rowSecurity: true, forceRowSecurity: true, columns: [TENANT_COLUMN, BUSINESS_COLUMN] },
      ]).problems,
      name,
    );
    expect(found).toHaveLength(1);
    expect(found.join('\n')).toContain('OMITS it');
  });
});

describe('RP-RLS-E — the live arm: a materialized view on a REAL cluster, through LIVE_RELATION_SQL', () => {
  it('red: a matview over a discovered Phase 4 relation is read out of pg_class and named — and the OLD predicate cannot see it', async () => {
    await rolledBack(async (c) => {
      // The baseline first, so the finding below cannot be background noise.
      expect(law(await catalogue(c))).toEqual([]);

      const subject = report(await catalogue(c)).judged[0];
      expect(subject, 'the discovery returned no relation to build a cache over').toBeDefined();
      const name = canaryName() + '_mv';
      await c.query(`CREATE MATERIALIZED VIEW ${name} AS SELECT ${TENANT_COLUMN}, ${BUSINESS_COLUMN} FROM ${subject as string} WITH NO DATA`);

      // THE DEFECT, EXECUTED: the predicate this law used to carry does not
      // return the relation at all, so the law judged it and named it false.
      expect(await narrowedNames(c), 'the narrowed predicate returned the matview, so this proof has no subject').not.toContain(name);

      const live = await catalogue(c);
      expect(live.find((r) => r.name === name)?.kind, 'LIVE_RELATION_SQL did not read the matview').toBe('m');

      const r = report(live);
      expect(r.liveSurface).toContain(name);
      expect(r.judged).toContain(name);
      expect(r.liveNotDeclared).toEqual([name]);

      const text = about(r.problems, name).join('\n');
      expect(text).toContain('STORES TENANT ROWS AND CANNOT CARRY ROW LEVEL SECURITY');
      expect(text).toContain("pg_class.relkind is 'm'");
      expect(text).toContain('OMITS it');
      // No unsatisfiable demand: PG-RLS-KIND proved there is no way to meet one.
      expect(text).not.toContain('is not ENABLED on a Phase 4 relation');
      expect(text).not.toContain('ROW LEVEL SECURITY is not FORCEd');

      // Dropping it restores the silence: the finding is about the relation.
      await c.query(`DROP MATERIALIZED VIEW ${name}`);
      expect(law(await catalogue(c))).toEqual([]);
    });
  });

  it('red: a matview a MIGRATION declares and the database HAS is no longer reported as DECLARED AND NOT APPLIED', async () => {
    await rolledBack(async (c) => {
      // `discoverStoredRelations` already reads CREATE MATERIALIZED VIEW, so
      // half (i) always saw such a relation. Half (ii) could not, so the two
      // halves disagreed and the law said the one thing that was NOT true
      // about it — that the database did not have it and its row level
      // security "could not be judged". It is judged now, and for what it is.
      const subject = report(await catalogue(c)).judged[0] as string;
      const name = canaryName() + '_mv';
      const planted = migrationsPlus(`CREATE MATERIALIZED VIEW ${name} AS SELECT ${TENANT_COLUMN}, ${BUSINESS_COLUMN} FROM ${subject};\n`);
      await c.query(`CREATE MATERIALIZED VIEW ${name} AS SELECT ${TENANT_COLUMN}, ${BUSINESS_COLUMN} FROM ${subject} WITH NO DATA`);

      const r = report(await catalogue(c), planted);
      expect(r.declared).toContain(name);
      expect(r.declaredNotApplied, 'the applied matview is still reported as not applied').toEqual([]);
      expect(r.liveNotDeclared).toEqual([]);
      expect(r.judged).toContain(name);

      const found = about(r.problems, name);
      expect(found).toHaveLength(1);
      expect(found.join('\n')).toContain('STORES TENANT ROWS AND CANNOT CARRY ROW LEVEL SECURITY');
      expect(found.join('\n')).not.toContain('DECLARED AND NOT APPLIED');
    });
  });
});

describe('RP-RLS-F — the live arm: a Phase 4 table in a namespace other than public', () => {
  it('red: a tenanted table in a created schema is discovered, judged and named — and the OLD predicate cannot see it', async () => {
    await rolledBack(async (c) => {
      expect(law(await catalogue(c))).toEqual([]);

      const schema = canarySchema();
      const name = canaryName();
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(
        `CREATE TABLE ${schema}.${name} (${TENANT_COLUMN} UUID NOT NULL, ${BUSINESS_COLUMN} UUID NOT NULL, id UUID NOT NULL, PRIMARY KEY (${BUSINESS_COLUMN}, id))`,
      );

      // THE DEFECT, EXECUTED.
      expect(await narrowedNames(c), 'the narrowed predicate returned the non-public table, so this proof has no subject').not.toContain(name);

      const live = await catalogue(c);
      expect(live.find((r) => r.name === name)?.schema, 'LIVE_RELATION_SQL did not read the non-public table').toBe(schema);

      const r = report(live);
      expect(r.liveSurface).toContain(name);
      expect(r.judged).toContain(name);

      const text = about(r.problems, name).join('\n');
      // It is an ordinary table, so ENABLE and FORCE ARE owed and ARE demanded.
      expect(text).toContain('relrowsecurity is false');
      expect(text).toContain('relforcerowsecurity is false');
      expect(text).toContain('OMITS it');

      // ENABLE and FORCE are legal here, and they silence the RLS findings.
      await c.query(`ALTER TABLE ${schema}.${name} ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE ${schema}.${name} FORCE ROW LEVEL SECURITY`);
      const after = about(law(await catalogue(c)), name);
      expect(after).toHaveLength(1);
      expect(after.join('\n')).toContain('OMITS it');
    });
  });

  it('red: one compliant namespace does not answer for another that leaks — both rows of a shared name are judged', async () => {
    await rolledBack(async (c) => {
      const schema = canarySchema();
      const name = canaryName();
      const columns = `${TENANT_COLUMN} UUID NOT NULL, ${BUSINESS_COLUMN} UUID NOT NULL, id UUID NOT NULL`;
      await c.query(`CREATE TABLE ${name} (${columns})`);
      await c.query(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
      await c.query(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`);
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`CREATE TABLE ${schema}.${name} (${columns})`);

      const live = await catalogue(c);
      expect(
        live.filter((r) => r.name === name),
        'the read did not return both namespaces’ rows',
      ).toHaveLength(2);

      const text = about(law(live), name).join('\n');
      expect(text, 'the compliant row answered for the leaking one').toContain('relrowsecurity is false');
      expect(text).toContain('relforcerowsecurity is false');

      // And the leak really is the other namespace's: dropping it restores the
      // silence while the compliant relation of the same name stays.
      await c.query(`DROP TABLE ${schema}.${name}`);
      const after = about(law(await catalogue(c)), name);
      expect(after).toHaveLength(1);
      expect(after.join('\n')).toContain('OMITS it');
    });
  });
});
