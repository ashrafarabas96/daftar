/**
 * P4-S4 / F-09 — G-3's VOCABULARY OVER THE LIVE CATALOGUE, AND THE PROOF THAT
 * THE TEXT HALF ALONE IS BLIND.
 *
 * The law is `liveVocabularyProblems` in `scripts/phase4-s4-gate.ts`. It exists
 * because the text half of the same vocabulary (`vocabularyProblems`, over
 * `discoverSalesTables` → `discoverStoredRelations` → `stripNonSchema`) reads
 * SCHEMA TEXT, and `stripNonSchema` discards dollar-quoted bodies and quoted
 * literals by design — that is what keeps a comment or a PL/pgSQL body from
 * being mistaken for a column declaration. The cost is exact: a relation
 * created by `DO $$ BEGIN EXECUTE 'CREATE TABLE …'; END $$` is invisible to it.
 *
 * This suite proves FOUR things, and the first of them is the premise rather
 * than an assumption:
 *
 *   VL-A  THE HOLE ITSELF. Over hostile text, `stripNonSchema` keeps nothing of
 *         the declaration, `discoverSalesTables` returns the empty set and
 *         `vocabularyProblems` is SILENT — while `isForbiddenSalesTable` on the
 *         very same name returns `true`. Asserted, not quoted from a report.
 *   VL-B  red: the SAME relation, created on a REAL cluster by that route and
 *         read back from `pg_class`/`pg_attribute`, turns the live half RED on
 *         its NAME.
 *   VL-C  red: a relation whose name is innocent and which carries an
 *         authoritative derived-truth COLUMN is caught on the column — the two
 *         arms are independent, and the column arm is the one the text half is
 *         blind to twice over (even handed the name, the column text is inside
 *         the body the reader dropped).
 *   VL-D  THE NOT-A-FINDING CASE, which is the harder claim: over the real
 *         live catalogue of this tree the live half is SILENT, and that silence
 *         is about real subjects — it says how many relations it judged.
 *
 * Plus the two canaries the RLS law's suite established and this one owes for
 * the same reasons: a law handed NO catalogue reports that it judged nothing
 * (`NOT A PASS`), and the fail-empty inherited prefix is asserted as a FLOOR.
 *
 * ── WHY THE PLANTED NAME IS GENERATED AT RUN TIME ────────────────────────
 *
 * The whole point is that no literal anywhere in the tree can be the reason the
 * relation was found: a law carrying a handwritten list of forbidden names would
 * otherwise pass. The name is built from this process's pid and the clock, so it
 * exists nowhere until the moment it is created, and the assertion that it
 * appears in no source is made rather than assumed. The forbidden WORD inside
 * it (`_balances_cache_`) is what G-3's pattern matches; the generated halves
 * are what make the name unique.
 *
 * ── HOW THE PLANTS ARE MADE AND UNDONE ───────────────────────────────────
 *
 * Inside a transaction that is ALWAYS rolled back (`rolledBack`, the house
 * pattern of `tests/guards/phase4-rls-force-guard.test.ts:92-102`): PostgreSQL's
 * DDL is transactional, so every `CREATE TABLE` here is undone by the
 * `ROLLBACK`, no other session observes it, and nothing is left for the next
 * suite. No migration is created or edited, and no migration number is
 * allocated — the hostile DDL is a string in this file and never reaches
 * `infrastructure/database/migrations`.
 *
 * ── WHY THIS HALF IS NOT IN `CHECKS` ─────────────────────────────────────
 *
 * The gate judges text and must not come to need a cluster where it did not
 * before, exactly as the RLS live half stays with its own suite. This suite is
 * on the P4-S4 roster by the basename rule, so `roster-execution` runs it — and
 * `ensurePostgres()` STARTS the embedded PostgreSQL and THROWS when it cannot,
 * so there is no path on which this half silently skips.
 *
 * No assertion here pins the SIZE of any surface to a literal (P4-AL-88): the
 * non-vacuity canaries are FLOORS, which can only be crossed in the direction
 * that is already a failure.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { APPLIER_SOURCE, LIVE_RELATION_SQL, type LiveRelation, type LiveRelationRow, liveRelationsFromRows } from '../../scripts/guards/phase4-rls-force';
import { discoverSalesTables, isForbiddenSalesTable } from '../../scripts/guards/no-authoritative-balance';
import { stripNonSchema } from '../../scripts/guards/sql-schema';
import { liveVocabularyProblems, liveVocabularyReport, vocabularyProblems } from '../../scripts/phase4-s4-gate';
import { ensurePostgres, ownerPool } from '../helpers/test-app';

const REPO = join(__dirname, '..', '..');
const APPLIER = readFileSync(join(REPO, APPLIER_SOURCE), 'utf8');

/** A floor on the inherited prefix, never an equality: it only grows. */
const PREFIX_FLOOR = 50;

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

/** The law over a given catalogue. */
const law = (live: readonly LiveRelation[] | null): string[] => liveVocabularyProblems({ applierSource: APPLIER, live });

/** The problems naming `fragment`, so a plant's own finding is read rather than the whole list. */
const about = (problems: readonly string[], fragment: string): string[] => problems.filter((p) => p.includes(fragment));

/** A derived-truth name that exists in no file in this tree: the forbidden word, plus pid and the clock, base 36. */
const forbiddenCanary = (): string => `p4s4_customer_balances_cache_${process.pid}_${Date.now().toString(36)}`;

/** An INNOCENT Phase 4 name that exists in no file in this tree: the column arm's subject. */
const innocentCanary = (): string => `p4s4_vocab_live_probe_${process.pid}_${Date.now().toString(36)}`;

/**
 * The hostile route, as a string in this file and never as a migration: DDL
 * generated inside a `DO` block, which is one of the routes
 * `scripts/guards/phase4-rls-force.ts`'s header already names for its own live
 * half ("DDL generated inside a `DO` block").
 */
const hostileDo = (name: string, columns: string): string => `DO $$\nBEGIN\n  EXECUTE 'CREATE TABLE ${name} (${columns})';\nEND $$;`;

// ─────────────────────────────────────────────────────────────────────────

describe('VL-A — the hole itself: the TEXT half is silent about a relation the vocabulary forbids by name', () => {
  it('red: stripNonSchema keeps nothing of a DO $$ EXECUTE ... $$ declaration, so the text half discovers no relation at all', () => {
    const name = forbiddenCanary();
    const sql = hostileDo(name, 'tenant_id UUID NOT NULL, business_id UUID NOT NULL, balance_minor BIGINT NOT NULL, outstanding_minor BIGINT NOT NULL');

    // The reader's output, stated rather than described: the body is gone.
    expect(stripNonSchema(sql)).not.toContain(name);
    expect(stripNonSchema(sql)).not.toContain('CREATE TABLE');
    expect(stripNonSchema(sql).replace(/\s+/g, ' ').trim()).toBe('DO ;');

    // So the text-level discovery has no subject, and the text-level vocabulary
    // law is SILENT — about a relation whose own name it forbids.
    expect(discoverSalesTables(sql)).toEqual([]);
    expect(vocabularyProblems(sql)).toEqual([]);
    expect(isForbiddenSalesTable(name), 'the name is not one the vocabulary forbids, so this proof has no subject').toBe(true);
  });

  it('red: handed the name anyway, the text half still finds no column — the declaration is inside the body it dropped', () => {
    const name = forbiddenCanary();
    const sql = hostileDo(name, 'balance_minor BIGINT NOT NULL, outstanding_minor BIGINT NOT NULL');
    // `vocabularyProblems` quantifies over its own discovery, so the only way
    // to show the COLUMN arm's blindness is to give it the name for free.
    expect(vocabularyProblems(sql)).toEqual([]);
    expect(stripNonSchema(sql)).not.toContain('balance_minor');
  });

  it('the same table written PLAINLY is caught by the text half — the blindness is the reader, not the vocabulary', () => {
    const name = forbiddenCanary();
    const sql = `CREATE TABLE ${name} (\n  tenant_id UUID NOT NULL,\n  business_id UUID NOT NULL,\n  balance_minor BIGINT NOT NULL,\n  outstanding_minor BIGINT NOT NULL\n);`;
    expect(discoverSalesTables(sql)).toEqual([name]);
    const problems = vocabularyProblems(sql);
    expect(problems.join('\n')).toContain('derived-truth relation name under G-3');
    expect(problems.join('\n')).toContain(`${name}.balance_minor`);
    expect(problems.join('\n')).toContain(`${name}.outstanding_minor`);
  });
});

describe('the canary names are in no source file, so no handwritten list can be the reason they are found', () => {
  it('the generated halves appear in neither the law module nor this suite', () => {
    for (const name of [forbiddenCanary(), innocentCanary()]) {
      expect(name).toMatch(/^p4s4_[a-z_]+_\d+_[0-9a-z]+$/);
      expect(readFileSync(join(REPO, 'scripts/phase4-s4-gate.ts'), 'utf8')).not.toContain(name);
      expect(readFileSync(__filename, 'utf8')).not.toContain(name);
    }
  });
});

describe('VL-B — red: the hostile relation IS in the live catalogue, and the live half names it', () => {
  it('red: a derived-truth relation created from inside a DO block turns the live vocabulary law red on its name', async () => {
    await rolledBack(async (c) => {
      const name = forbiddenCanary();

      // The baseline FIRST: the law is silent before the plant, so the finding
      // below cannot be background noise.
      expect(law(await catalogue(c))).toEqual([]);

      await c.query(hostileDo(name, 'tenant_id UUID NOT NULL, business_id UUID NOT NULL, customer_id UUID NOT NULL'));

      const live = await catalogue(c);
      const report = liveVocabularyReport({ applierSource: APPLIER, live });

      // THE DISCOVERY'S OWN COMPLETENESS, not just the verdict: the catalogue
      // half has the relation although no text this gate can read declares it.
      expect(report.liveSurface, 'the catalogue half did not discover the planted relation').toContain(name);
      expect(report.judged, 'the planted relation was discovered and not judged').toContain(name);

      // And the text half, over the very same statement, is still silent.
      expect(vocabularyProblems(hostileDo(name, 'tenant_id UUID NOT NULL, business_id UUID NOT NULL, customer_id UUID NOT NULL'))).toEqual([]);

      const found = about(report.problems, name);
      expect(found.join('\n')).toContain('PRESENT IN THE LIVE CATALOGUE');
      expect(found.join('\n')).toContain('derived-truth relation name under G-3');
      expect(found).toHaveLength(1);

      // Undoing the plant restores the silence: the finding is about the
      // relation and not about the shape of the catalogue read.
      await c.query(`DROP TABLE ${name}`);
      expect(law(await catalogue(c))).toEqual([]);
    });
  });
});

describe('VL-C — red: the COLUMN arm, on a relation whose name is innocent', () => {
  it('red: a live pg_attribute column claiming a derived balance is named, on a relation no vocabulary word matches', async () => {
    await rolledBack(async (c) => {
      const name = innocentCanary();
      expect(isForbiddenSalesTable(name), 'the probe name is itself forbidden, so this would not be the COLUMN arm').toBe(false);

      await c.query(hostileDo(name, 'tenant_id UUID NOT NULL, business_id UUID NOT NULL, balance_minor BIGINT NOT NULL, outstanding_minor BIGINT NOT NULL'));

      const problems = about(law(await catalogue(c)), name);
      // Both authoritative columns, each named, and nothing about the name.
      expect(problems.join('\n')).toContain(`${name}.balance_minor`);
      expect(problems.join('\n')).toContain(`${name}.outstanding_minor`);
      expect(problems.join('\n')).toContain('LIVE pg_attribute column');
      expect(problems.join('\n')).not.toContain('derived-truth relation name under G-3');
      expect(problems).toHaveLength(2);

      await c.query(`DROP TABLE ${name}`);
      expect(law(await catalogue(c))).toEqual([]);
    });
  });

  it('the accepted vocabulary is NOT a finding: a relation of the same shape with accepted column words is silent', async () => {
    await rolledBack(async (c) => {
      const name = innocentCanary();
      // `*_applied_*`, `*_released_*`, `*_dust_*`, `remaining_*` — the words the
      // settlement surface actually uses. A rule with no not-a-finding case is
      // a rule about a string.
      await c.query(
        hostileDo(
          name,
          'tenant_id UUID NOT NULL, business_id UUID NOT NULL, invoice_amount_applied_minor BIGINT NOT NULL, ar_released_minor BIGINT NOT NULL, ar_dust_minor BIGINT NOT NULL, remaining_amount_minor BIGINT NOT NULL',
        ),
      );
      expect(about(law(await catalogue(c)), name)).toEqual([]);
    });
  });
});

describe('VL-D — the tree as it stands is safe, and that silence is about real subjects', () => {
  it('the live half is silent over the real catalogue, and it says how many relations it judged', async () => {
    await rolledBack(async (c) => {
      const live = await catalogue(c);
      const report = liveVocabularyReport({ applierSource: APPLIER, live });

      expect(report.problems).toEqual([]);

      // A claim with no subject must fail, never pass: the surface is non-empty,
      // every member of it was judged, and the catalogue really was read.
      expect(live.length).toBeGreaterThan(0);
      expect(report.liveSurface).not.toBeNull();
      expect((report.liveSurface ?? []).length).toBeGreaterThan(0);
      expect(report.judged).toEqual([...(report.liveSurface ?? [])]);
      expect(report.applierRelations.length).toBeGreaterThan(0);
    });
  });

  it('the fail-empty inherited prefix is a FLOOR, so the Phase 4 predicate is not the complement of nothing', () => {
    expect(liveVocabularyReport({ applierSource: APPLIER, live: null }).inheritedPrefixSize).toBeGreaterThan(PREFIX_FLOOR);
  });
});

describe('a law handed no catalogue reports that it judged nothing — NOT A PASS', () => {
  it('red: live === null is a finding, and it says the text half cannot stand in for it', () => {
    const report = liveVocabularyReport({ applierSource: APPLIER, live: null });
    expect(report.judged).toEqual([]);
    expect(report.liveSurface).toBeNull();
    expect(report.problems.join('\n')).toContain('no live catalogue was read');
    expect(report.problems.join('\n')).toContain('NOT A PASS');
  });

  it('red: an EMPTY catalogue is a finding too — a law with no subject is not a silent law', () => {
    const problems = law([]);
    expect(problems.join('\n')).toContain('holds no Phase 4 relation at all');
  });

  it('red: an applier source that declares nothing leaves the subtraction with no subject, and the law says so', () => {
    const problems = liveVocabularyProblems({ applierSource: '// nothing is created here\n', live: [] });
    expect(problems.join('\n')).toContain('the subtraction that keeps the runner');
  });
});
