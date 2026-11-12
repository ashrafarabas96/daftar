import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 0092 — THE STATEMENT READER'S OWN LAWS, AND EACH ONE'S RED.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ────────────────────────────────
 *
 * `0092` creates ONE reader, `customer_account_statement(UUID, UUID)`, under
 * owner permit DR-146. Four of its properties are the whole reason the permit
 * was given, and all four are properties OF THE TEXT the runner will install:
 *
 *   L1  the summation is a CUMULATIVE WINDOW INSIDE the reader, partitioned by
 *       currency over the total order — not arithmetic in the read's SQL and
 *       not in TypeScript (`P4-AL-07`);
 *   L2  the `search_path` is PINNED as a literal, identical to the literal
 *       `0091` pins at `:135` and `:238`, and nothing is inherited or read
 *       from `current_setting`;
 *   L3  PUBLIC is REVOKED and `daftar_app` ALONE is granted EXECUTE;
 *   L4  the file carries ZERO DML.
 *
 * and two more that the permit's conditions impose on the FILE rather than on
 * the function:
 *
 *   L5  every leaf branch restricts on `business_id = p_business_id` — the
 *       structural merchant check, five branches, counted exactly;
 *   L6  nothing at or below `frozenThrough` is touched, and the number is
 *       `0092` — above every number this base carries;
 *   L7  the database suite still carries the FOREIGN `business_id` case, and
 *       that case still asserts a COUNT of zero rows. L7 reads the SUITE, not
 *       the SQL, because what the owner's condition adds is the existence of a
 *       case: «`INVOKER` keeps row security in force» means a foreign id must
 *       yield THE EMPTY SET — not a refusal, not one partial row — and only an
 *       assertion on the count can tell those three apart. A case folded into
 *       the reachability case, or weakened to `toEqual([])`, or deleted, is a
 *       law that stopped being measured, and L7 goes red on each.
 *
 * THIS SUITE IS NOT A SUBSTITUTE FOR THE DATABASE. It reads text. Whether the
 * INSTALLED function really behaves is `tests/integration/
 * l3-customer-statement-running-balance.test.ts`, which needs PostgreSQL and
 * is NOT_RUN on a machine without it. A text law that passes while the
 * installed function is wrong is exactly the failure mode `0092-E` exists for:
 * that block reads the LIVE catalogues. These six laws guard the text so the
 * text that reaches the runner is the text the permit allowed — no more.
 *
 * ── DR-145: A GUARD THAT CANNOT GO RED IS FORBIDDEN ──────────────────────
 *
 * Every law below ships with its OWN KILL: the mutation that deletes the one
 * line the law guards. §B runs each law against its own mutant and requires
 * the law to FAIL there. A kill that leaves the law green is itself reported
 * as a defect, by name, because that law is then guarding nothing. The mutants
 * are built in memory from the file's text, so nothing on disk is written,
 * and §B prints the sha256 of the text before and after each mutation so the
 * mutation is proved to have happened rather than assumed (RULE-27).
 */

const REPO_ROOT = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'infrastructure', 'database', 'migrations');
const MIGRATION = '0092_p4s1_customer_account_statement_reader.sql';
const DB_SUITE_PATH = join(REPO_ROOT, 'tests', 'integration', 'l3-customer-statement-running-balance.test.ts');

/**
 * THE TWO TEXTS THE LAWS ARE READ OFF. Six of them read the migration; the
 * seventh reads the database suite, because what it guards is the existence of
 * a CASE and not a property of the SQL. They travel together so one mutation
 * function can return a whole world and the digest can cover both.
 */
interface Texts {
  readonly migration: string;
  readonly dbSuite: string;
}

const WORLD: Texts = {
  migration: readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8'),
  dbSuite: readFileSync(DB_SUITE_PATH, 'utf8'),
};

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
/** One digest over the whole world, so a mutation to either text is visible. */
const worldSha = (w: Texts): string => sha(`${sha(w.migration)}:${sha(w.dbSuite)}`);

/** The literal `0091` pins at `:135` and `:238`. Byte for byte, or it is a different path. */
const PINNED_PATH = 'SET search_path = pg_catalog, public, pg_temp';

/** `frozenThrough` as `MIGRATION_MANIFEST.json` states it, read and not assumed. */
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, 'infrastructure', 'database', 'MIGRATION_MANIFEST.json'), 'utf8')) as {
  frozenThrough: string;
  migrations: readonly { readonly name: string; readonly sha256: string }[];
};

/**
 * One law: what it claims, how it is read off the text, and the mutation that
 * must break it. `holds` returns `null` when the law holds and the reason when
 * it does not, so the same function serves the green case and the red one.
 */
interface Law {
  readonly id: string;
  readonly claim: string;
  readonly holds: (w: Texts) => string | null;
  /** Deletes the ONE line this law guards. Returns the mutated world. */
  readonly kill: (w: Texts) => Texts;
}

/** Deletes every line containing `needle`; throws if there was none to delete. */
const dropLines = (text: string, needle: string): string => {
  const lines = text.split('\n');
  const kept = lines.filter((l) => !l.includes(needle));
  if (kept.length === lines.length) throw new Error(`kill is blind: no line contains ${needle}`);
  return kept.join('\n');
};

/** Counts non-overlapping occurrences. Zero is a real answer; an empty needle is not. */
const countOf = (text: string, needle: string): number => {
  if (needle.length === 0) throw new Error('countOf: empty needle');
  return text.split(needle).length - 1;
};

/**
 * The CREATE FUNCTION body alone — from the `AS $$` that opens it to the `$$;`
 * that closes it. The laws about the body must not be satisfiable by this
 * file's PROSE: a comment that mentions a window is not a window. Reading the
 * body out first is what makes the difference measurable.
 */
const bodyOf = (text: string): string => {
  const open = text.indexOf('AS $$');
  const close = text.indexOf('\n$$;', open);
  if (open < 0 || close < 0) return '';
  return text.slice(open + 'AS $$'.length, close);
};

const LAWS: readonly Law[] = [
  {
    id: 'L1',
    claim: 'the running balance is a cumulative window INSIDE the reader, partitioned by currency over the total order',
    holds: ({ migration: t }) => {
      const body = bodyOf(t);
      if (body.length === 0) return 'the reader body could not be delimited';
      if (!body.includes('OVER (PARTITION BY s.currency_code')) return 'no window partitioned by currency_code in the body';
      if (!body.includes('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')) return 'the window frame is not cumulative';
      if (!/ORDER BY s\.entry_date, s\.kind_rank, s\.entry_id/.test(body)) return 'the window is not ordered by the total order';
      return null;
    },
    kill: (w) => ({ ...w, migration: dropLines(w.migration, 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW') }),
  },
  {
    id: 'L2',
    claim: `the search_path is pinned as the literal \`${PINNED_PATH}\`, and no current_setting is read`,
    holds: ({ migration: t }) => {
      if (countOf(t, PINNED_PATH) !== 1) return `the pinned literal appears ${countOf(t, PINNED_PATH)} times, expected exactly 1`;
      if (/current_setting\s*\(/.test(t)) return 'the file reads current_setting';
      if (!new RegExp(`LANGUAGE sql STABLE ${PINNED_PATH} AS \\$\\$`).test(t)) return 'the reader does not carry the pinned path on its own definition';
      return null;
    },
    kill: (w) => ({ ...w, migration: dropLines(w.migration, `LANGUAGE sql STABLE ${PINNED_PATH} AS $$`) }),
  },
  {
    id: 'L3',
    claim: 'PUBLIC is revoked and daftar_app ALONE is granted EXECUTE',
    holds: ({ migration: t }) => {
      if (!t.includes('REVOKE ALL ON FUNCTION customer_account_statement(UUID, UUID) FROM PUBLIC;')) return 'PUBLIC is not revoked';
      const grants = t.split('\n').filter((l) => /^GRANT\s/.test(l));
      if (grants.length !== 1) return `the file carries ${grants.length} GRANT statements, expected exactly 1`;
      if (grants[0] !== 'GRANT EXECUTE ON FUNCTION customer_account_statement(UUID, UUID) TO daftar_app;')
        return `the one GRANT is not EXECUTE to daftar_app alone: ${grants[0]}`;
      return null;
    },
    kill: (w) => ({ ...w, migration: dropLines(w.migration, 'FROM PUBLIC;') }),
  },
  {
    id: 'L4',
    claim: 'the file carries zero DML',
    holds: ({ migration: t }) => {
      const offenders = t
        .split('\n')
        .map((l, i) => [i + 1, l] as const)
        .filter(([, l]) => /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\s/i.test(l));
      if (offenders.length > 0) return `DML at line ${offenders.map(([n]) => n).join(', ')}`;
      // The positive control for the zero above: the same probe, same text,
      // looking for the statement kind this file DOES carry. A reader of
      // statements that found no CREATE would be a blind probe (RULE-11).
      if (!/^CREATE FUNCTION customer_account_statement\(/m.test(t)) return 'the DML probe is blind: it found no CREATE FUNCTION either';
      return null;
    },
    kill: (w) => ({ ...w, migration: `${w.migration}\nINSERT INTO customers (id) VALUES (gen_random_uuid());\n` }),
  },
  {
    id: 'L5',
    claim: 'every one of the five leaf branches restricts on business_id = p_business_id',
    holds: ({ migration: t }) => {
      const body = bodyOf(t);
      const branches = countOf(body, 'UNION ALL') + 1;
      if (branches !== 5) return `the body carries ${branches} branches, expected 5`;
      const checks = countOf(body, 'business_id = p_business_id');
      if (checks !== 5) return `the body carries ${checks} merchant restrictions for ${branches} branches`;
      return null;
    },
    kill: (w) => ({ ...w, migration: dropLines(w.migration, 'WHERE p.business_id = p_business_id AND p.customer_id = p_customer_id') }),
  },
  {
    id: 'L7',
    claim: 'the database suite carries the FOREIGN business_id case, and it asserts a COUNT of zero rows',
    holds: ({ dbSuite: t }) => {
      // This one law reads the SUITE and not the migration: the thing it
      // guards is that the case the owner's text requires has not been
      // deleted, folded into the reachability case, or weakened into a
      // truthiness check. `toBe(0)` on a length, and nothing looser: a
      // `toEqual([])` would pass on a row the suite forgot to select, and a
      // refusal would mean the filter never ran at all.
      if (!t.includes('B2 the foreign business_id answers ZERO ROWS')) return 'the foreign business_id case is gone';
      // FLATTENED FIRST. `prettier` wraps a long `expect(` over three lines,
      // so a raw substring probe for `expect(aAskingForB.length,` reports the
      // case as deleted when only its formatting moved — a false red, which is
      // how a law gets disabled.
      const flat = t.replace(/\s+/g, ' ');
      if (!/expect\( ?aAskingForB\.length ?,/.test(flat)) return 'the case no longer measures the COUNT of returned rows';
      if (!/expect\( ?aAskingForB\.length ?,[\s\S]{0,400}?\)\.toBe\(0\)/.test(flat)) return 'the count is not asserted to be exactly 0';
      if (!/expect\( ?aAskingForBFailure ?,/.test(flat)) return 'the case does not rule out a refusal, so it cannot tell an empty set from an error';
      return null;
    },
    kill: (w) => ({ ...w, dbSuite: dropLines(w.dbSuite, 'aAskingForB.length,') }),
  },
  {
    id: 'L6',
    claim: 'the number is 0092, above every number on this base, and nothing at or below frozenThrough is touched',
    holds: ({ migration: t }) => {
      if (!t.startsWith(`-- ${MIGRATION}\n`)) return 'the file does not name itself on its first line';
      const onDisk = readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{4}_.*\.sql$/.test(f))
        .sort();
      if (onDisk.length === 0) return 'the migration directory probe is blind: it listed no file';
      if (onDisk[onDisk.length - 1] !== MIGRATION) return `the highest migration on this tree is ${onDisk[onDisk.length - 1]}, not ${MIGRATION}`;
      const frozenIndex = onDisk.indexOf(MANIFEST.frozenThrough);
      if (frozenIndex < 0) return `frozenThrough ${MANIFEST.frozenThrough} is not on this tree`;
      // Every frozen file still hashes to the sha the manifest pinned. This is
      // the only arm that can prove "nothing at or below 0079 was touched",
      // and its positive control is the count: 80 files compared, not zero.
      let compared = 0;
      for (const entry of MANIFEST.migrations) {
        const actual = createHash('sha256')
          .update(readFileSync(join(MIGRATIONS_DIR, entry.name)))
          .digest('hex');
        if (actual !== entry.sha256) return `${entry.name} no longer hashes to its frozen sha256`;
        compared += 1;
      }
      if (compared !== MANIFEST.migrations.length || compared === 0) return 'the frozen-set probe compared nothing';
      return null;
    },
    kill: (w) => ({ ...w, migration: w.migration.replace(`-- ${MIGRATION}\n`, '-- 0087_p4s1_customer_account_statement_reader.sql\n') }),
  },
];

describe('0092 — the statement reader, laws over the text (A: they hold)', () => {
  it.each(LAWS.map((l) => [l.id, l.claim, l] as const))('%s — %s', (_id, _claim, law) => {
    expect(law.holds(WORLD)).toBeNull();
  });
});

describe('0092 — DR-145: each law goes RED when the line it guards is deleted (B: the negative controls)', () => {
  it.each(LAWS.map((l) => [l.id, l] as const))('%s fails on its own mutant', (id, law) => {
    const before = worldSha(WORLD);
    const mutant = law.kill(WORLD);
    const after = worldSha(mutant);
    // The mutation really happened. A kill that changed nothing would make the
    // red below unreadable: the law would be passing on the ORIGINAL text.
    expect(after, `${id}: the kill changed nothing (sha ${before})`).not.toBe(before);
    const verdict = law.holds(mutant);
    expect(verdict, `${id} stayed GREEN on its own mutant, so it guards nothing (DR-145). sha before=${before} after=${after}`).not.toBeNull();
  });
});
