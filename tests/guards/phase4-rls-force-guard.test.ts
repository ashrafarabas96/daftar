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
