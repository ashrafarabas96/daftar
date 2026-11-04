import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY END-STATE SIGNATURE ASSERTION IN `0084` MUST AGREE WITH THE SIGNATURE
 * THE SAME FILE CREATES.
 *
 * ── THE DEFECT THIS FILE WAS WRITTEN FOR ─────────────────────────────────
 *
 * `0084` creates the set-based reader with EIGHT result columns:
 *
 *   CREATE FUNCTION invoice_outstanding(p_business_id UUID, p_invoice_ids UUID[])
 *   RETURNS TABLE (invoice_id UUID, paid_txn_minor BIGINT, paid_base_minor BIGINT,
 *                  outstanding_txn_minor BIGINT, outstanding_base_minor BIGINT,
 *                  currency_code TEXT, due_date DATE, issue_date DATE)
 *
 * and its own end-state block `0084-E(1)` compared the live catalogue against
 * a literal carrying SEVEN — `issue_date date` missing from the end. The
 * `DO $post$` block is unconditional, so the comparison was true and the
 * migration raised `selling.migration_end_state_invalid` ON ITSELF. MEASURED
 * live, from zero, against PostgreSQL 16.15 before the fix:
 *
 *   selling.migration_end_state_invalid: the set-based invoice_outstanding
 *   does not carry the two appended columns in the fixed order (found
 *   TABLE(invoice_id uuid, …, currency_code text, due_date date, issue_date date))
 *
 * `0000 → latest` therefore could not complete: `schema_migrations` held 84
 * rows, the newest `0083_phase4_ar_outstanding_set_based.sql`, and `0085` and
 * `0086` had never been applied by anybody.
 *
 * PROVENANCE, MEASURED, AND IT CORRECTS THE ACCOUNT THIS CARD WAS GIVEN. The
 * eighth column was appended by `f8a9ed46` — the DR-13/DR-14/C-1 Q-1 commit —
 * which changed `0084` by +20/−3 and touched ZERO `IS DISTINCT FROM 'TABLE('
 * literals, here or anywhere. The card's corroboration was that the sibling
 * assertion for `customer_open_invoices_page` «was updated» and does carry
 * `issue_date date`; `git log -S` says otherwise. That literal has carried
 * `issue_date date` since the original authoring commit `168675b3`, because
 * that routine's second result column always was `issue_date`. It was never
 * updated — it was BORN right.
 *
 * The conclusion survives on a different and stronger footing: the commit that
 * moved a signature updated NEITHER of the two literals that pin it. The
 * second is in `0085`, whose PRE-condition still demanded «0084's seven-column
 * form» and was last touched by its own authoring commit `f2b7d7ae`. So this
 * is a HALF-FINISHED EDIT, it is OLDER THAN THE CARD that fixes it, and it had
 * two instances rather than one.
 *
 * ── WHY A LAW AND NOT JUST THE CORRECTED STRING ──────────────────────────
 *
 * One corrected literal leaves the next half-finished edit free to do this
 * again. What let this one live a whole card's lifetime is that NOTHING
 * COMPARED THE TWO HALVES OF THE FILE TO EACH OTHER. This file does exactly
 * that, for every such assertion, positionally.
 *
 * ── WHAT THIS LAW DOES NOT GUARANTEE ─────────────────────────────────────
 *
 * It compares the FILE TO ITSELF. It says NOTHING about the live catalogue —
 * not whether the routine exists, not what shape it really has, not whether
 * an earlier migration left something else behind. And it says nothing about
 * whether `0084` APPLIES: a file can be self-consistent and still fail on a
 * real database for a reason no text can see. The live claim is a live run's
 * to make.
 *
 * AND IT GUARDS ONE FILE. It does not read `0085`, `0086` or any other
 * migration, so THE SECOND INSTANCE OF THIS VERY CLASS IS NOT GUARDED BY IT:
 * `0085`'s PRE-condition carried the same stale seven-column literal, was
 * found by migrating from zero after `0084` was repaired, and was corrected in
 * a commit of its own. Nothing here would have caught it, and nothing here
 * would catch a third. A law over every candidate migration's signature
 * literals — end-state AND pre-condition — is a separate card, and it is named
 * so it is not mistaken for covered.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const MIGRATION = '0084_phase4_ar_fixed_cost_and_open_invoice_page.sql';
const MIGRATION_PATH = join(REPO_ROOT, 'infrastructure', 'database', 'migrations', MIGRATION);

/**
 * THE INVENTORY, PINNED EXACTLY RATHER THAN AS A FLOOR.
 *
 * A floor catches deletion and lets a silent ADDITION through. These numbers
 * are a contract: adding an end-state signature assertion to `0084` means
 * editing this line, which is the moment a human looks at whether the new
 * assertion agrees with what the file creates. MEASURED on the base commit:
 * one in `DO $pre$`, three in `DO $post$`, none anywhere else, none with a
 * routine name the law cannot read.
 */
const PINNED_COUNTS = { pre: 1, post: 3, outside: 0, unreadable: 0 } as const;

/**
 * END-STATE ASSERTIONS ABOUT A ROUTINE THIS FILE DOES NOT CREATE.
 *
 * EXACTLY EMPTY, and pinned empty on purpose. All three of `0084`'s end-state
 * assertions name a routine `0084` itself creates. If a later edit asserts the
 * signature of a routine that comes from an EARLIER migration, that is a
 * FINDING and not a row to skip: this law fails, names it, and whoever adds it
 * must put it here WITH A REASON. A skip-list that grows by itself is how a
 * signature contract stops meaning anything.
 */
const ASSERTED_BUT_NOT_CREATED_HERE: readonly { routine: string; reason: string }[] = [];

/**
 * TYPE SPELLINGS WHOSE LOWERCASE FORM IS EXACTLY WHAT THE CATALOGUE PRINTS.
 *
 * `pg_get_function_result` renders canonicalised, lowercase type names; the
 * `CREATE` is written in upper case. So the two sides must be normalised — and
 * the normalisation is the dangerous part of this law, because a loose one
 * stops distinguishing the things that matter.
 *
 * THIS NORMALISATION PERFORMS NO TYPE MAPPING AT ALL. It lowercases, collapses
 * runs of whitespace to one space, and removes space around commas. It
 * therefore PRESERVES EVERY TYPE DISTINCTION — `date` is not `timestamptz`,
 * `bigint` is not `integer`, `uuid[]` is not `uuid` — because it never rewrites
 * one spelling into another.
 *
 * The price is that it cannot read a spelling that is not already canonical:
 * `timestamptz` prints as `timestamp with time zone`, `int8` as `bigint`,
 * `varchar` as `character varying`. A law that guessed those would be wrong in
 * both directions, so this one FAILS CLOSED and names the token instead. Any
 * future column of such a type needs this set extended deliberately, with the
 * catalogue's rendering on the `CREATE` side.
 */
const SELF_CANONICAL_TYPES: readonly string[] = [
  'uuid',
  'bigint',
  'integer',
  'smallint',
  'text',
  'date',
  'boolean',
  'numeric',
  'uuid[]',
  'bigint[]',
  'integer[]',
  'text[]',
];

/** A result column as either half of the file writes it. */
interface Column {
  readonly name: string;
  readonly type: string;
}

/**
 * Blank out `--` line comments, preserving every byte offset and newline, so
 * reported line numbers stay true to the file on disk.
 *
 * Lexed uniformly over the whole file: single-quoted strings (with `''`
 * escapes) are tracked so that an apostrophe inside prose — `0083's
 * five-column form` — cannot open one, because the comment is consumed first.
 * Dollar quotes need no special handling for this purpose: inside a `$fn$` or
 * `DO $post$` body the content is SQL, with the same strings and the same
 * comments. The lexer must END in the normal state; if it does not, the file
 * is not what this law thinks it is reading, and that is a failure.
 */
function maskLineComments(raw: string): { masked: string; endedClean: boolean } {
  const out: string[] = [];
  let i = 0;
  let inString = false;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (inString) {
      out.push(ch);
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          out.push("'");
          i += 2;
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '-' && raw[i + 1] === '-') {
      while (i < raw.length && raw[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out.push(ch);
      i += 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return { masked: out.join(''), endedClean: !inString };
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** Lowercase, collapse whitespace, drop space around commas. No type mapping. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

/** `name(type, type)` — argument NAMES dropped, argument TYPES kept in order. */
function routineKeyFromAssertion(literal: string): string {
  const m = /^\s*(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)\s*$/i.exec(literal);
  if (!m) return `UNREADABLE(${literal})`;
  const types = (m[2] as string)
    .split(',')
    .map((t) => normalise(t))
    .filter((t) => t.length > 0);
  return `${(m[1] as string).toLowerCase()}(${types.join(', ')})`;
}

/** The same key, derived from a `CREATE … FUNCTION name(p_x TYPE, …)` list. */
function routineKeyFromCreate(name: string, params: string): string | null {
  const types: string[] = [];
  for (const raw of params.split(',')) {
    const p = normalise(raw);
    if (p.length === 0) continue;
    // A default or a mode would make "the type is the rest" wrong: fail closed.
    if (/(^|\s)(default|out|inout|variadic)(\s|$)/.test(p) || p.includes('=')) return null;
    const space = p.indexOf(' ');
    if (space < 0) return null;
    types.push(p.slice(space + 1).trim());
  }
  return `${name.toLowerCase()}(${types.join(', ')})`;
}

/** `invoice_id uuid, paid_txn_minor bigint` → columns, in order. */
function parseColumnList(list: string): Column[] | null {
  const out: Column[] = [];
  for (const raw of list.split(',')) {
    const c = normalise(raw);
    if (c.length === 0) continue;
    const space = c.indexOf(' ');
    if (space < 0) return null;
    out.push({ name: c.slice(0, space), type: c.slice(space + 1).trim() });
  }
  return out.length > 0 ? out : null;
}

/**
 * THE COMPARATOR, POSITIONAL. Exported shape so a case below can prove it is
 * not blind: a comparator that returns no problems because it looks at nothing
 * would make every other case here vacuous.
 */
export function compareColumns(expected: Column[], created: Column[]): string[] {
  const problems: string[] = [];
  if (expected.length !== created.length) {
    problems.push(`column COUNT differs: the assertion expects ${expected.length}, the CREATE declares ${created.length}`);
  }
  const n = Math.max(expected.length, created.length);
  for (let i = 0; i < n; i += 1) {
    const e = expected[i];
    const c = created[i];
    if (!e) {
      problems.push(`position ${i + 1}: the CREATE declares \`${(c as Column).name} ${(c as Column).type}\` and the assertion expects nothing`);
      continue;
    }
    if (!c) {
      problems.push(`position ${i + 1}: the assertion expects \`${e.name} ${e.type}\` and the CREATE declares nothing`);
      continue;
    }
    if (e.name !== c.name) problems.push(`position ${i + 1}: NAME — assertion \`${e.name}\`, CREATE \`${c.name}\``);
    if (e.type !== c.type) problems.push(`position ${i + 1}: TYPE — assertion \`${e.type}\`, CREATE \`${c.type}\``);
  }
  return problems;
}

interface Assertion {
  readonly routineLiteral: string;
  readonly key: string;
  readonly expectedLiteral: string;
  readonly line: number;
  readonly block: 'pre' | 'post' | 'outside';
}

interface Creation {
  readonly key: string;
  readonly columns: Column[] | null;
  readonly rawColumns: string;
  readonly line: number;
}

const RAW = readFileSync(MIGRATION_PATH, 'utf8');
const { masked, endedClean } = maskLineComments(RAW);

function blockSpan(tag: string): { start: number; end: number } | null {
  const open = masked.indexOf(`DO $${tag}$`);
  if (open < 0) return null;
  const close = masked.indexOf(`\n$${tag}$;`, open);
  if (close < 0) return null;
  return { start: open, end: close };
}

const PRE = blockSpan('pre');
const POST = blockSpan('post');

/**
 * Every `pg_get_function_result(to_regprocedure(<arg>)) IS DISTINCT FROM
 * '<literal>'`. The `<arg>` is captured WHETHER OR NOT it is a quoted literal:
 * a dynamic routine name — `to_regprocedure(v_cmd)`, which `0085` does use —
 * is unreadable to a static law, and that is a FINDING, not a row to skip.
 */
const ASSERTION_RE =
  /pg_get_function_result\(\s*to_regprocedure\(\s*(?:'((?:[^']|'')*)'|([a-z_][a-z0-9_]*))\s*\)\s*\)\s*IS\s+DISTINCT\s+FROM\s*'((?:[^']|'')*)'/gi;

const ASSERTIONS: Assertion[] = [];
for (const m of masked.matchAll(ASSERTION_RE)) {
  const idx = m.index;
  const quoted = m[1];
  const identifier = m[2];
  const routineLiteral = quoted ?? `«dynamic: ${identifier as string}»`;
  const block: 'pre' | 'post' | 'outside' = PRE && idx >= PRE.start && idx < PRE.end ? 'pre' : POST && idx >= POST.start && idx < POST.end ? 'post' : 'outside';
  ASSERTIONS.push({
    routineLiteral,
    key: quoted === undefined ? `UNREADABLE(${routineLiteral})` : routineKeyFromAssertion(quoted),
    expectedLiteral: (m[3] as string).replace(/''/g, "'"),
    line: lineOf(masked, idx),
    block,
  });
}

const CREATE_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*)\)\s*RETURNS\s+TABLE\s*\(([^)]*)\)/gi;

const CREATIONS: Creation[] = [];
for (const m of masked.matchAll(CREATE_RE)) {
  const key = routineKeyFromCreate(m[1] as string, m[2] as string);
  CREATIONS.push({
    key: key ?? `UNREADABLE(${m[1] as string})`,
    columns: parseColumnList(m[3] as string),
    rawColumns: normalise(m[3] as string),
    line: lineOf(masked, m.index),
  });
}

/** `TABLE(a uuid, b bigint)` → the columns, or null if it is not that shape. */
function parseTableLiteral(literal: string): Column[] | null {
  const m = /^\s*table\s*\(([\s\S]*)\)\s*$/i.exec(literal);
  return m ? parseColumnList(m[1] as string) : null;
}

function render(columns: Column[]): string {
  return columns.map((c) => `${c.name} ${c.type}`).join(', ');
}

describe('0084 end-state signature law (MIG-0084-E1)', () => {
  it('mig84_0: the file lexes cleanly and both of its DO blocks are found — otherwise nothing below means anything', () => {
    expect({ endedClean, pre: PRE !== null, post: POST !== null }).toEqual({ endedClean: true, pre: true, post: true });
    // And the blocks are in the file's order, with the end-state block last.
    expect((PRE as { start: number }).start).toBeLessThan((POST as { start: number }).start);
  });

  it('mig84_1: the comparator is not blind — it reports a count, a name, a type and an order difference', () => {
    const a: Column[] = [
      { name: 'x', type: 'uuid' },
      { name: 'y', type: 'bigint' },
    ];
    expect(compareColumns(a, a)).toEqual([]);
    expect(compareColumns(a, [{ name: 'x', type: 'uuid' }]).join(' | ')).toContain('column COUNT differs');
    expect(
      compareColumns(a, [
        { name: 'z', type: 'uuid' },
        { name: 'y', type: 'bigint' },
      ]).join(' | '),
    ).toContain('NAME');
    expect(
      compareColumns(a, [
        { name: 'x', type: 'date' },
        { name: 'y', type: 'bigint' },
      ]).join(' | '),
    ).toContain('TYPE');
    // ORDER, with the same SET of columns on both sides.
    expect(
      compareColumns(a, [
        { name: 'y', type: 'bigint' },
        { name: 'x', type: 'uuid' },
      ]).length,
    ).toBeGreaterThan(0);
  });

  it('mig84_2: the inventory of signature assertions is exactly what this law was written against', () => {
    const counts = {
      pre: ASSERTIONS.filter((a) => a.block === 'pre').length,
      post: ASSERTIONS.filter((a) => a.block === 'post').length,
      outside: ASSERTIONS.filter((a) => a.block === 'outside').length,
      unreadable: ASSERTIONS.filter((a) => a.key.startsWith('UNREADABLE(')).length,
    };
    expect({ counts, total: ASSERTIONS.length }).toEqual({ counts: PINNED_COUNTS, total: 4 });
    // And the file really does create routines, so the comparison has subjects.
    expect(CREATIONS.length).toBeGreaterThanOrEqual(3);
    expect(CREATIONS.filter((c) => c.key.startsWith('UNREADABLE(') || c.columns === null)).toEqual([]);
  });

  it('mig84_3: every type spelling on either side is one whose lowercase form is what the catalogue prints', () => {
    const unknown: string[] = [];
    for (const a of ASSERTIONS) {
      const cols = parseTableLiteral(a.expectedLiteral);
      if (!cols) {
        unknown.push(`line ${a.line}: the expected literal is not a readable TABLE(...) list: \`${a.expectedLiteral}\``);
        continue;
      }
      for (const c of cols) {
        if (!SELF_CANONICAL_TYPES.includes(c.type)) {
          unknown.push(`line ${a.line}: assertion column \`${c.name}\` has type \`${c.type}\`, which this law refuses to normalise`);
        }
      }
    }
    for (const c of CREATIONS) {
      for (const col of c.columns as Column[]) {
        if (!SELF_CANONICAL_TYPES.includes(col.type)) {
          unknown.push(`line ${c.line}: CREATE column \`${col.name}\` has type \`${col.type}\`, which this law refuses to normalise`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('mig84_4: every END-STATE assertion names a routine this same file creates', () => {
    const created = new Set(CREATIONS.map((c) => c.key));
    const pinned = new Set(ASSERTED_BUT_NOT_CREATED_HERE.map((p) => p.routine));
    const orphans = ASSERTIONS.filter((a) => a.block === 'post' && !created.has(a.key) && !pinned.has(a.key)).map(
      (a) => `line ${a.line}: \`${a.key}\` is asserted in DO $post$ but ${MIGRATION} does not create it — a FINDING, not a row to skip`,
    );
    expect(orphans).toEqual([]);
    // The skip-list is empty and stays empty unless a human writes a reason.
    expect(ASSERTED_BUT_NOT_CREATED_HERE).toEqual([]);
  });

  it('mig84_5: every END-STATE assertion expects EXACTLY the signature this file creates, name by name and type by type, in order', () => {
    const problems: string[] = [];
    for (const a of ASSERTIONS) {
      if (a.block !== 'post') continue;
      const expected = parseTableLiteral(a.expectedLiteral);
      const creation = CREATIONS.find((c) => c.key === a.key);
      if (!expected || !creation || !creation.columns) {
        problems.push(
          `line ${a.line}: \`${a.key}\` could not be compared — expected=${expected ? 'read' : 'unreadable'}, create=${creation ? 'found' : 'missing'}`,
        );
        continue;
      }
      for (const p of compareColumns(expected, creation.columns)) {
        problems.push(
          `${a.key}: ${p}\n` +
            `    assertion at ${MIGRATION}:${a.line} expects: ${render(expected)}\n` +
            `    CREATE     at ${MIGRATION}:${creation.line} declares: ${render(creation.columns)}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('mig84_6: the PRE-condition asserts the PRIOR shape, so it must DIFFER from what this file creates', () => {
    const pre = ASSERTIONS.filter((a) => a.block === 'pre');
    expect(pre.length).toBe(PINNED_COUNTS.pre);
    const vacuous: string[] = [];
    for (const a of pre) {
      const expected = parseTableLiteral(a.expectedLiteral);
      const creation = CREATIONS.find((c) => c.key === a.key);
      if (!expected || !creation || !creation.columns) {
        vacuous.push(`line ${a.line}: \`${a.key}\` could not be compared`);
        continue;
      }
      if (compareColumns(expected, creation.columns).length === 0) {
        vacuous.push(
          `line ${a.line}: the PRE-condition for \`${a.key}\` expects the very shape this file creates, ` +
            `so it can no longer prove the subject was in its PRIOR form before being changed`,
        );
      }
    }
    expect(vacuous).toEqual([]);
  });
});
