import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVOICE_REDUCER_VOCABULARY, phase4Sql, readTables, stripSql } from '../../scripts/phase4-s1-gate';

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

/**
 * EVERY `AS $$ … $$;` body in the text, not the first one.
 *
 * `bodyOf` above returns the FIRST body, which is right for the laws that
 * speak about the one window. L8 is an ABSENCE claim over a set of
 * definitions -- "no definition omits a reducer" -- and the tree states in its
 * own words why that distinction matters: `scripts/phase4-s1-gate.ts:1480-1488`
 * warns that a reader taking the LAST definition of a routine is
 * signature-blind, that it is "NEVER a subject for an absence claim", and that
 * the hole TL-P4-S5-R1 closed was measured on `invoice_outstanding`'s two live
 * forms. So L8 reads them ALL. If `0092` ever carries a second definition of
 * the statement, the law judges it too instead of silently judging one.
 */
const allBodies = (text: string): string[] => {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf('AS $$', at);
    if (open < 0) break;
    const close = text.indexOf('\n$$;', open);
    if (close < 0) break;
    out.push(text.slice(open + 'AS $$'.length, close));
    at = close + 1;
  }
  return out;
};

/**
 * The reducer relations THE TREE HAS, discovered exactly as seam S-P4-03
 * discovers them: `readTables` over the Phase 4 DDL, filtered by
 * `INVOICE_REDUCER_VOCABULARY`. Never a list written here -- a list written
 * here would be a second place to forget, which is the defect this law exists
 * to prevent rather than to re-create.
 *
 * Read from DISK on purpose, so a mutation of the statement's own text cannot
 * shrink the law's subject: the mutant must fail by omitting a reducer, not by
 * making the law forget that the reducer exists.
 */
const reducersInTree = (): string[] =>
  readTables(phase4Sql(REPO_ROOT))
    .tables.map((t) => t.name)
    .filter((n) => INVOICE_REDUCER_VOCABULARY.test(n))
    .sort();

const LAWS: readonly Law[] = [
  {
    id: 'L1',
    claim: 'the running balance is a cumulative window INSIDE the reader, partitioned by currency over the total order',
    holds: ({ migration: t }) => {
      const body = bodyOf(t);
      if (body.length === 0) return 'the reader body could not be delimited';
      if (!body.includes('OVER (PARTITION BY s.currency_code')) return 'no window partitioned by currency_code in the body';
      if (!body.includes('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')) return 'the window frame is not cumulative';
      // ANCHORED INSIDE THE WINDOW, not anywhere in the body. Measured: that
      // ORDER BY appears TWICE in `0092` -- at `:202` inside `OVER (...)`,
      // which is the accumulation order and the only one that decides a
      // figure, and at `:282` as the function's final output order. An earlier
      // form of this arm searched the whole body, so weakening the WINDOW's
      // order left it green on the strength of the output's -- the arm could
      // not tell the two apart. Its own per-arm mutant in section C caught
      // that, which is what per-arm mutants are for.
      if (
        !/OVER \(PARTITION BY s\.currency_code[\s\S]*?ORDER BY s\.entry_date, s\.kind_rank, s\.entry_id[\s\S]*?ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW/.test(
          body,
        )
      )
        return 'the window is not ordered by the total order';
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
    // FOUR CLAIMS, AND ONE MUTANT USED TO KILL ONLY THE FIRST. Every arm here
    // `return`ed, so the single killer for this law -- which renames the
    // file's first line -- short-circuited at the top and the three arms
    // below it NEVER EXECUTED in any red state: that 0092 is on the tree,
    // that `frozenThrough` is on it, and that all 80 frozen files still hash
    // to their pinned shas. That last one is the arm that carries the whole
    // "nothing at or below 0079 was touched" claim, and it was the least
    // exercised of the four.
    //
    // So the arms are COLLECTED rather than returned from: each one runs on
    // every call, the answer names everything wrong at once, and the mutant
    // that renames the first line is now seen to leave the other three
    // standing. The contract is unchanged -- a string when something is
    // wrong, `null` when nothing is -- so every caller and every killer in
    // this file reads it exactly as before.
    holds: ({ migration: t }) => {
      const problems: string[] = [];
      if (!t.startsWith(`-- ${MIGRATION}\n`)) problems.push('the file does not name itself on its first line');
      const onDisk = readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{4}_.*\.sql$/.test(f))
        .sort();
      if (onDisk.length === 0) {
        // The listing is the subject of the two arms that follow, so its
        // emptiness is reported INSTEAD of them rather than alongside two
        // findings derived from nothing (RULE-18).
        problems.push('the migration directory probe is blind: it listed no file');
      } else {
        // AND NOT `the highest file on disk is 0092`, which this law used to
        // demand. That is a claim about the WHOLE migrations directory
        // enforced from inside one card's guard: the moment any number above
        // 0092 lands in `main` -- and #120 of this same lane carries `0093`
        // -- it goes red permanently, and the next lane has to edit THIS
        // lane's guard file to green its own branch. A false red is how a law
        // gets disabled, and this one would have arrived with a motive.
        //
        // What the guard is for survives without it: 0092 is present,
        // `frozenThrough` is present, and every frozen file still hashes to
        // its pinned sha -- which needs no statement about the newest file.
        if (!onDisk.includes(MIGRATION)) problems.push(`${MIGRATION} is not on this tree; the directory holds ${String(onDisk.length)} migrations`);
        if (!onDisk.includes(MANIFEST.frozenThrough)) problems.push(`frozenThrough ${MANIFEST.frozenThrough} is not on this tree`);
      }
      // Every frozen file still hashes to the sha the manifest pinned. This is
      // the only arm that can prove "nothing at or below 0079 was touched",
      // and its positive control is the count: 80 files compared, not zero.
      // It reads files BY NAME from the manifest, so it does not depend on the
      // listing above and runs even when that listing is blind.
      let compared = 0;
      for (const entry of MANIFEST.migrations) {
        const actual = createHash('sha256')
          .update(readFileSync(join(MIGRATIONS_DIR, entry.name)))
          .digest('hex');
        if (actual !== entry.sha256) problems.push(`${entry.name} no longer hashes to its frozen sha256`);
        compared += 1;
      }
      if (compared !== MANIFEST.migrations.length || compared === 0) problems.push('the frozen-set probe compared nothing');
      return problems.length === 0 ? null : problems.join(' ; ');
    },
    kill: (w) => ({ ...w, migration: w.migration.replace(`-- ${MIGRATION}\n`, '-- 0087_p4s1_customer_account_statement_reader.sql\n') }),
  },
  {
    id: 'L8',
    claim:
      "the credit side names EVERY reducer relation the tree has, so the statement cannot keep subtracting one reduction while the reader of record subtracts two. `invoice_outstanding` has a GUARDED extension point -- seam S-P4-03 makes its last definition name every relation that settles an invoice, and `0084:661` says in its own words that the slice adding a reducer appends one UNION ALL branch. This reader copies that set by hand, and nothing in `scripts/` names it (measured: zero hits for `customer_account_statement`, against four for the probe's own positive control), so neither half of TL-P4-S5-R1 reaches it: not the name half, because `customer_account_statement` carries none of `outstanding|receivable|aging|settlement_state`, and not the dependency half, because its executable body calls no member of the family. The day a third reducer is appended to `invoice_outstanding`, `customer_ar_outstanding` subtracts it and this statement does not -- and the statement's balance is then HIGHER than the debt, on the document a merchant collects with. That direction is the whole reason this law is blocking rather than cosmetic.",
    holds: (w) => {
      const reducers = reducersInTree();
      // NO SUBJECT IS NOT A PASS. If the tree has no reducer relation at all,
      // every assertion below is vacuous, and a vacuous law reads green
      // forever. Seam S-P4-03's own family check does the same thing.
      if (reducers.length === 0)
        return 'L8 has no subject: the Phase 4 DDL declares no relation matching INVOICE_REDUCER_VOCABULARY, so "the statement names every reducer" is a claim about an empty set';
      // COMMENTS STRIPPED FIRST, and this is not tidiness: the money review of
      // 24d5add9 planted ONE `--` line saying a reducer "is not handled here"
      // and L8 went GREEN with that reducer genuinely unsubtracted. A law that
      // a developer silences by writing a comment about the thing it guards is
      // worse than no law, because it reads as coverage. `stripSql` is the
      // gate's own function (phase4-s1-gate.ts:694): it deletes `--` lines,
      // blanks `/* */` blocks, and KEEPS string literals -- so a relation name
      // inside a quoted literal would still satisfy this law, which is a limit
      // worth stating and not one SQL reaches, since relation names in these
      // bodies are identifiers and never quoted strings. Section D below plants
      // exactly that comment and requires the law to stay RED.
      const bodies = allBodies(w.migration).map(stripSql);
      if (bodies.length === 0) return 'L8 has no subject: no `AS $$ … $$;` body in the migration, so there is no reader to judge';
      const missing: string[] = [];
      for (const [i, body] of bodies.entries())
        for (const name of reducers) if (!new RegExp(`\\b${name}\\b`).test(body)) missing.push(`definition #${i + 1} does not name ${name}`);
      return missing.length === 0
        ? null
        : `the statement omits a reducer the reader of record subtracts, so its balance would be HIGHER than the debt: ${missing.join('; ')}`;
    },
    // The mutation is the real failure mode, not a typo: a reducer relation
    // that exists in the tree and that the statement stops naming. Dropping
    // the lines that name the FIRST discovered reducer is exactly what the
    // next slice would do by forgetting to add the next one.
    kill: (w) => {
      const reducers = reducersInTree();
      if (reducers.length === 0) throw new Error('kill is blind: no reducer relation in the tree to drop');
      return { ...w, migration: dropLines(w.migration, reducers[0] as string) };
    },
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

// ─────────────────────────────────────────────────────────────────────────────
// C — `L1` HAS THREE ARMS AND HAD ONE KILLER.
//
// Section B kills each law with one mutant, which proves the LAW guards
// something. It does not prove each ARM does. `L1` claims three things — a
// window partitioned by currency, a cumulative frame, and the total order —
// and its killer drops the FRAME line only. So the partition arm and the order
// arm had never been observed to refuse anything, and the partition is the
// whole reason the window exists: with every fixture in a single currency,
// deleting `PARTITION BY` changes no figure any executed case reads, and the
// independent review on `55e6c134` named that gap.
//
// Each arm below gets its own mutant, with section B's discipline kept: the
// world digest must MOVE before the verdict is read, so a mutation that
// changed nothing cannot be mistaken for a law that fired.
// ─────────────────────────────────────────────────────────────────────────────
describe('0092 — C: every arm of L1 refuses on its own, not merely the law as a whole', () => {
  const l1 = LAWS.find((l) => l.id === 'L1');

  it('L1 is present, or this section has no subject', () => {
    expect(l1, 'L1 must exist for its arms to be judged').toBeDefined();
  });

  const arms: readonly { readonly arm: string; readonly mutate: (t: string) => string; readonly says: string }[] = [
    {
      arm: 'the partition by currency',
      mutate: (t) => t.replace('OVER (PARTITION BY s.currency_code', 'OVER ('),
      says: 'partitioned by currency_code',
    },
    {
      arm: 'the cumulative frame',
      mutate: (t) => t.replace('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', ''),
      says: 'frame is not cumulative',
    },
    {
      arm: 'the total order',
      mutate: (t) => t.replace('ORDER BY s.entry_date, s.kind_rank, s.entry_id', 'ORDER BY s.entry_date'),
      says: 'not ordered by the total order',
    },
  ];

  it.each(arms.map((a) => [a.arm, a] as const))('L1 refuses when %s is removed', (arm, spec) => {
    const law = l1;
    expect(law, 'L1 must exist').toBeDefined();
    if (law === undefined) return;
    const before = worldSha(WORLD);
    const mutant: Texts = { ...WORLD, migration: spec.mutate(WORLD.migration) };
    const after = worldSha(mutant);
    // THE MUTATION HAPPENED. Without this the red below could be the law
    // passing on an unchanged text, which is how a control proves nothing.
    expect(after, `${arm}: the mutation changed nothing (sha ${before}) — the replacement did not match`).not.toBe(before);
    const verdict = law.holds(mutant);
    expect(verdict, `L1 stayed GREEN with ${arm} removed, so that arm guards nothing`).not.toBeNull();
    // AND IT REFUSES FOR THE RIGHT REASON: a law that went red on some other
    // arm would hide the fact that this one is unguarded.
    expect(verdict ?? '', `L1 refused, but not for ${arm}: ${verdict ?? ''}`).toContain(spec.says);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION D — a COMMENT does not satisfy L8.
//
// The money review of `24d5add9` found L8 satisfiable by prose: it read the raw
// body, so one `--` line naming a reducer made the law green while the reducer
// was genuinely unsubtracted. That is the defect this very file names for L1 --
// "a comment that mentions a window is not a window" -- reappearing in the law
// written to close a money blocker.
//
// Two plants, and the first is the control for the second: without it, a green
// on the comment plant could mean the DROP failed rather than that the comment
// was ignored. Section B's discipline is kept: the world digest must MOVE
// before any verdict is read.
// ─────────────────────────────────────────────────────────────────────────────
describe('0092 — D: L8 reads SQL, not prose', () => {
  const l8 = LAWS.find((l) => l.id === 'L8');

  it('L8 is present, or this section has no subject', () => {
    expect(l8, 'L8 must exist for its prose-immunity to be judged').toBeDefined();
  });

  it('a reducer the tree has is discovered, or both plants below are vacuous', () => {
    expect(reducersInTree().length, 'no reducer relation in the tree, so nothing can be dropped').toBeGreaterThan(0);
  });

  /** Every line naming `name` removed; throws if there was none, so a blind plant cannot pass. */
  const withoutLinesNaming = (text: string, name: string): string => {
    const lines = text.split('\n');
    const kept = lines.filter((l) => !l.includes(name));
    if (kept.length === lines.length) throw new Error(`plant is blind: no line names ${name}`);
    return kept.join('\n');
  };

  it('CONTROL — dropping the relation reddens L8, so the plant below is testing the comment and not the drop', () => {
    const law = l8 as Law;
    const name = reducersInTree()[0] as string;
    const before = worldSha(WORLD);
    const mutant: Texts = { ...WORLD, migration: withoutLinesNaming(WORLD.migration, name) };
    expect(worldSha(mutant), 'the drop changed nothing, so this control proves nothing').not.toBe(before);
    const verdict = law.holds(mutant);
    expect(verdict, `L8 stayed green with ${name} dropped`).not.toBeNull();
    expect(verdict ?? '', `L8 refused, but did not name ${name}`).toContain(name);
  });

  it('a `--` comment naming the dropped relation does NOT bring L8 back to green', () => {
    const law = l8 as Law;
    const name = reducersInTree()[0] as string;
    const dropped = withoutLinesNaming(WORLD.migration, name);
    // The comment goes INSIDE the body, which is the only place that could
    // satisfy the law -- a comment outside it was never a candidate.
    const opener = 'AS $$';
    expect(dropped.split(opener).length - 1, 'the body opener is not unique, so the comment lands nowhere definite').toBe(1);
    // A REPLACEMENT FUNCTION, NOT A STRING, and this is measured rather than
    // stylistic: in a replacement STRING `$$` inserts a single `$`, so
    // `.replace('AS $$', `AS $$...`)` writes `AS $` and DESTROYS the body
    // opener. The first form of this plant did exactly that; L8 then answered
    // 'no body', which is non-null -- so the case PASSED for entirely the wrong
    // reason while proving nothing about comments at all. Measured directly:
    // with a replacement string, 'x AS $$...'.replace('AS $$', 'AS $$\n-- note')
    // gives 'x AS $\n-- note'; with a function it keeps 'AS $$'.
    const planted = dropped.replace(opener, () => `${opener}\n  -- ${name} is not handled here`);
    // AND THE BODY SURVIVED THE PLANT. Without this the class above returns
    // silently: a verdict of 'no body' is a refusal, and a refusal reads as a
    // law that fired.
    expect(allBodies(planted).length, 'the plant destroyed the body, so this case would pass without testing a comment').toBe(1);
    const mutant: Texts = { ...WORLD, migration: planted };
    expect(worldSha(mutant), 'the comment plant changed nothing').not.toBe(worldSha({ ...WORLD, migration: dropped }));
    expect(planted.includes(`-- ${name} is not handled here`), 'the comment did not land in the text').toBe(true);
    const verdict = law.holds(mutant);
    expect(verdict, `a comment naming ${name} silenced L8 — the law reads prose as code`).not.toBeNull();
    expect(verdict ?? '', `L8 refused, but did not name ${name}`).toContain(name);
  });
});
