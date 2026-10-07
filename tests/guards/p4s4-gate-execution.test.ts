/**
 * P4-S4 — THE RED PROOF OF THIS GATE'S OWN ROSTER AND ROSTER-EXECUTION CHECKS.
 *
 * «A gate that checks test filenames but never executes the tests is not a
 * gate.» A previous slice shipped a gate whose roster was never executed: the
 * rows were verified to exist and the gate printed PASS while a rostered law
 * could have been RED. This suite is the standing proof that the P4-S4 gate's
 * verdict is about test RESULTS, and that its roster derivation can refuse a
 * tree.
 *
 * THE SAME CODE PATH, NEVER A SECOND COPY. These proofs call `rosterProblems`,
 * `rosterRedProofProblems`, `discoverS4Suites` and `rosterFiles` from
 * `scripts/phase4-s4-gate.ts` and `executeSuites` from
 * `scripts/phase4-s2-gate.ts` — the executor the P4-S2, P4-S3 and P4-S4 gates
 * all share, so there is ONE implementation of the verdict rather than a
 * second one that can drift. What differs is only the ROOT handed to them.
 *
 * BOTH DIRECTIONS, always, on the same scratch root: a check that can only say
 * "no" is indistinguishable from a working one until the day it has to say
 * "yes".
 *
 * THE ROOT IS A SCRATCH DIRECTORY, never the checkout (the `rootMinus`
 * technique of `tests/guards/phase4-deferred-seam-guard.test.ts`): the
 * migrations in the checkout are applied in the shared cluster and editing one
 * breaks every suite with "Migration tampered after apply". The scratch root
 * symlinks `node_modules` so the runner resolves exactly as the gate's own
 * spawn does, and carries a minimal Vitest config — no globalSetup, no
 * setupFiles — so these proofs are about the VERDICT and not about the
 * estate's harness. The planted suites are minimal on purpose: running the
 * real roster inside a test would take the gate's own runtime twice over and
 * would prove nothing this does not.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executeSuites } from '../../scripts/phase4-s2-gate';
import {
  CI_COMPOSITION_SUITE,
  discoverS4Suites,
  readSqlStatement,
  rosterFiles,
  rosterProblems,
  rosterRedProofProblems,
  rosterRows,
  S4_GOLDEN_DIR,
  stripTsComments,
} from '../../scripts/phase4-s4-gate';

const REPO = join(__dirname, '..', '..');
const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A one-test suite whose single assertion is `body`. Built from plain literals so this file carries no skip marker of its own. */
const suite = (body: string): string => ['import { expect, it } from "vitest";', body, ''].join('\n');
const GREEN = suite('it("red: the scratch law is proved red elsewhere", () => { expect(2 + 2).toBe(4); });');
const FAILING = suite('it("red: the scratch law is proved red elsewhere", () => { expect(2 + 2).toBe(5); });');
const MARKED = suite('it.skip("red: the scratch law is proved red elsewhere", () => { expect(2 + 2).toBe(4); });');
const NO_RED_TITLE = suite('it("the scratch law holds", () => { expect(2 + 2).toBe(4); });');

/** A scratch root with `node_modules` symlinked, a minimal runner config, and the given files. */
function scratch(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'p4s4-exec-'));
  temporaries.push(root);
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'vitest.config.ts'), 'export default { test: { include: ["tests/**/*.test.ts"], pool: "forks", maxWorkers: 1 } };\n');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** The scratch roster: whatever the rule derived, which is what the gate would hand the runner. */
const run = (root: string) => executeSuites(root, rosterRows(root), 5 * 60_000);

// ─────────────────────────────────────────────────────────────────────────

describe('the roster rule derives a real set from the tree, and refuses the ways it can be empty or wrong', () => {
  it('the checkout’s own derivation has a subject, and every derived file is one the runner executes', () => {
    const { suites, unrunnable } = discoverS4Suites(REPO);
    expect(suites.length, 'the P4-S4 roster rule matched no suite in the checkout').toBeGreaterThan(0);
    expect(unrunnable).toEqual([]);
    expect(rosterFiles(REPO)).toContain(CI_COMPOSITION_SUITE);
    expect(rosterProblems(REPO)).toEqual([]);
  });

  it('red: a tree the rule matches nothing in is refused — a derived roster with no subject is not a pass', () => {
    const root = scratch({ 'tests/guards/unrelated.test.ts': GREEN });
    expect(discoverS4Suites(root).suites).toEqual([]);
    expect(rosterProblems(root).join('\n')).toContain('matched no suite');
  });

  it('red: a planted suite the ROOT runner would never execute is named, not silently dropped', () => {
    const root = scratch({ 'tests/guards/p4s4-planted.spec.ts': GREEN, 'tests/guards/p4s4-real.test.ts': GREEN });
    expect(discoverS4Suites(root).unrunnable).toEqual(['tests/guards/p4s4-planted.spec.ts']);
    expect(rosterProblems(root).join('\n')).toContain('would be committed and never executed');
  });

  it('red: a suite-like file planted in the GOLDEN directory is still named, while a shared helper beside it is not', () => {
    // The golden directory is swept in wholesale, so the rule has to tell a
    // dropped SUITE from a shared helper. Both live here at once: only the
    // suite-like one is a "committed and never executed" finding.
    const root = scratch({
      [`${S4_GOLDEN_DIR}/01-real.golden.test.ts`]: GREEN,
      [`${S4_GOLDEN_DIR}/02-planted.golden.spec.ts`]: GREEN,
      [`${S4_GOLDEN_DIR}/harness.ts`]: 'export const requireSubject = (): void => {};\n',
      [CI_COMPOSITION_SUITE]: GREEN,
    });
    const { suites, unrunnable } = discoverS4Suites(root);
    // The planted suite is reported — the corrected rule can still go red.
    expect(unrunnable).toEqual([`${S4_GOLDEN_DIR}/02-planted.golden.spec.ts`]);
    expect(rosterProblems(root).join('\n')).toContain('would be committed and never executed');
    // The helper is neither a finding nor handed to the runner as a suite.
    expect(unrunnable).not.toContain(`${S4_GOLDEN_DIR}/harness.ts`);
    expect(suites).toEqual([`${S4_GOLDEN_DIR}/01-real.golden.test.ts`]);
    // And with the planted suite removed, the helper alone leaves the rule clean.
    const clean = scratch({
      [`${S4_GOLDEN_DIR}/01-real.golden.test.ts`]: GREEN,
      [`${S4_GOLDEN_DIR}/harness.ts`]: 'export const requireSubject = (): void => {};\n',
      [CI_COMPOSITION_SUITE]: GREEN,
    });
    expect(discoverS4Suites(clean).unrunnable).toEqual([]);
    expect(rosterProblems(clean)).toEqual([]);
  });

  it('red: a rostered LAW with no planted-defect title is named, and the same file with one is not', () => {
    const bad = scratch({ 'tests/guards/p4s4-law.test.ts': NO_RED_TITLE, [CI_COMPOSITION_SUITE]: GREEN });
    expect(rosterRedProofProblems(bad).join('\n')).toContain('no it( title announces a planted defect');
    const good = scratch({ 'tests/guards/p4s4-law.test.ts': GREEN, [CI_COMPOSITION_SUITE]: GREEN });
    expect(rosterRedProofProblems(good)).toEqual([]);
  });

  it('red: a rostered file the runner would open and find nothing in is named', () => {
    const root = scratch({ 'tests/guards/p4s4-empty.test.ts': '// nothing here at all\n', [CI_COMPOSITION_SUITE]: GREEN });
    expect(rosterRedProofProblems(root).join('\n')).toContain('holds no runnable it( title');
  });
});

describe('the roster is EXECUTED, and the verdict is the spawn result’s — not a pipeline’s last stage', () => {
  it('a scratch roster of passing suites is executed and reported green, with the tally read from the run', () => {
    const root = scratch({ 'tests/guards/p4s4-scratch.test.ts': GREEN, [CI_COMPOSITION_SUITE]: GREEN });
    const e = run(root);
    expect(e.problems).toEqual([]);
    expect(e.ran).toBe(true);
    expect(e.status).toBe(0);
    expect(e.signal).toBeNull();
    expect(e.resolved).toEqual(rosterFiles(root));
    expect(e.tally.failed).toBe(0);
    expect(e.tally.passed).toBeGreaterThan(0);
    expect(e.tally.files).toBe(e.resolved.length);
  });

  it('red: a FAILING rostered suite makes the check refuse the tree, and the exit status is non-zero', () => {
    const root = scratch({ 'tests/guards/p4s4-scratch.test.ts': FAILING, [CI_COMPOSITION_SUITE]: GREEN });
    const e = run(root);
    expect(e.ran).toBe(true);
    // The verdict comes off the spawn RESULT OBJECT. A pipeline would have
    // handed back its last stage's status, and this repository's runner has
    // already exited 0 over four failing tests.
    expect(e.status).not.toBe(0);
    expect(e.tally.failed).toBeGreaterThan(0);
    expect(e.problems.join('\n')).toContain('FAILED');
  });

  it('red: a SKIPPED test in a rostered suite is refused, because the runner exits 0 over a skip', () => {
    const root = scratch({ 'tests/guards/p4s4-scratch.test.ts': MARKED, [CI_COMPOSITION_SUITE]: GREEN });
    const e = run(root);
    expect(e.problems.join('\n')).toMatch(/SKIPPED|carries it\.skip/);
  });

  it('red: a roster that resolves to no test file at all is refused rather than reported as a pass', () => {
    const root = scratch({ 'tests/guards/unrelated.test.ts': GREEN });
    const e = executeSuites(root, rosterRows(root), 60_000);
    expect(e.ran).toBe(false);
    expect(e.problems.join('\n')).toMatch(/does not exist|execute nothing/);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('the gate reads a SQL statement to its real end, not to the first semicolon', () => {
  // A multi-row INSERT in the shape a migration actually writes: the FIRST
  // description carries a semicolon, so a reader that stops at the first `;`
  // anywhere sees row one only and reports rows two and three as missing — a
  // finding on a correct tree.
  const INSERT = [
    'INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES',
    "  ('post', 'alpha_kind', 'Alpha; derived by the first command.'),",
    "  ('post', 'beta_kind', 'Beta; derived by the second command.'),",
    "  ('post', 'gamma_kind', 'Gamma; derived by the third command.');",
    '',
    'SELECT 1;',
  ].join('\n');

  it('reads a statement whose literals contain semicolons WHOLE, so every row is seen', () => {
    const statement = readSqlStatement(INSERT, 0);
    expect(statement, 'the statement was not terminated at all').not.toBeNull();
    // All three rows are inside the one statement…
    for (const kind of ['alpha_kind', 'beta_kind', 'gamma_kind']) {
      expect(statement, `${kind} fell outside the statement the reader returned`).toContain(kind);
    }
    // …and it stops at its OWN terminator, not at the next statement's.
    expect(statement?.endsWith(';')).toBe(true);
    expect(statement, 'the reader ran past the statement into the next one').not.toContain('SELECT 1');
    // red: this is what the first-semicolon reader returned instead.
    const naive = /insert\s+into\s+accounting_operation_kinds\b[\s\S]*?;/i.exec(INSERT)?.[0] ?? '';
    expect(naive, 'the naive reader is the subject of this claim and must still be wrong').not.toContain('gamma_kind');
  });

  it('a doubled quote inside a literal does not end it, so a semicolon after it is still inside', () => {
    // `''` is a literal's own escape for a quote. Reading it as the literal's
    // END would put the following `;` outside, and cut the statement there.
    const sql = "INSERT INTO t (d) VALUES ('a customer''s payment; derived'), ('second');\nSELECT 2;";
    const statement = readSqlStatement(sql, 0);
    expect(statement).toContain("'second'");
    expect(statement).not.toContain('SELECT 2');
    expect(statement?.endsWith(';')).toBe(true);
  });

  it('a comment’s apostrophe does not open a literal', () => {
    const sql = ['INSERT INTO t (d) VALUES', "  -- don't let this comment; confuse the reader", "  ('row one'), ('row two');", 'SELECT 3;'].join('\n');
    const statement = readSqlStatement(sql, 0);
    expect(statement).toContain("'row two'");
    expect(statement).not.toContain('SELECT 3');
  });

  it('red: a genuinely UNTERMINATED statement is reported as unreadable, never as an empty success', () => {
    // No terminator anywhere. The reader must say so, so the caller can stay
    // loud instead of treating "no rows" as "nothing to check".
    expect(readSqlStatement("INSERT INTO t (d) VALUES ('no terminator here')", 0)).toBeNull();
    // An unterminated LITERAL swallows the rest of the text, terminator and
    // all — also unreadable, and also not silently a statement.
    expect(readSqlStatement("INSERT INTO t (d) VALUES ('unclosed literal;", 0)).toBeNull();
    // An unclosed block comment likewise.
    expect(readSqlStatement('INSERT INTO t (d) VALUES /* unclosed; ', 0)).toBeNull();
  });
});

describe('a suite is one of this slice’s measurements when its CODE names the migration, not when its PROSE mentions the number', () => {
  // TWO defects, found together and compounding, in the derivation that decides
  // which suites measure this slice.
  //
  // The first: the derivation tested the WHOLE file text, comments included, so
  // a suite that merely wrote a migration number in a sentence claimed to be
  // one of this slice's measurements. P4-S7's performance suite did exactly
  // that and reddened this gate twice on a tree that measured nothing of S4's.
  //
  // The second, found by writing the proof of the first: the shape was
  // `\bN\b`, and `_` is a WORD character, so a word boundary after the number
  // FAILS for `0084_phase4_ar_fixed_cost…` — the migration's own filename, and
  // the honest way a suite names what it exercises. The only text the old shape
  // could match was a bare number with punctuation on both sides, which in
  // practice meant prose. So the derivation read sentences and could not read a
  // path: it selected suites by what they talked about and missed the ones that
  // named their subject. All three of S4's measured suites matched through a
  // comment. The answer happened to be right; it was not right by construction.
  //
  // The quiet half is the one that matters at acceptance: a derivation that
  // over-collects forces the evidence table to list suites that measure
  // nothing, after which the table states which files mention a number rather
  // than which files exercise a migration
  // (`[[daftar-an-unjudged-attribute-becomes-false]]`).
  const SHAPE = /(?<![0-9])0084(?![0-9])/;
  const OLD_SHAPE = /\b0084\b/;

  it('the OLD word-boundary shape could not see a migration FILENAME, which is the defect', () => {
    const named = "const M = 'infrastructure/database/migrations/0084_phase4_ar_fixed_cost_and_open_invoice_page.sql';";
    // The subject of the claim, and it must still be wrong: `4` and `_` are
    // both word characters, so there is no boundary between them.
    expect(OLD_SHAPE.test(named), 'the old shape is the subject here and must still fail to match a filename').toBe(false);
    // The corrected shape reads it.
    expect(SHAPE.test(named)).toBe(true);
    // And it is not merely looser: a longer number is still not this one.
    expect(SHAPE.test("'…/10084_x.sql'")).toBe(false);
    expect(SHAPE.test("'…/00841_x.sql'")).toBe(false);
    // A reference by line, the other spelling a suite uses, is read too.
    expect(SHAPE.test('// see 0084:365')).toBe(true);
  });

  it('a number written only in PROSE does not make a suite a measurement of this slice', () => {
    const prose = [
      '// The open-invoice page arrived in 0084 and this suite predates it.',
      '/* Historically 0084 carried the fixed-cost column; it no longer matters here. */',
      "it('measures nothing of that migration', () => expect(1).toBe(1));",
    ].join('\n');
    // The subject: the whole-text reader counts it.
    expect(SHAPE.test(prose), 'the naive whole-text reader is the subject here and must still match').toBe(true);
    // The corrected reader does not.
    expect(SHAPE.test(stripTsComments(prose))).toBe(false);
  });

  it('a number named in CODE still makes a suite a measurement — so the fix buys discrimination, not silence', () => {
    const real = [
      '// This suite measures the open-invoice page.',
      "const MIGRATION = 'infrastructure/database/migrations/0084_phase4_ar_fixed_cost_and_open_invoice_page.sql';",
      'it(`reads ${MIGRATION}`, () => expect(1).toBe(1));',
    ].join('\n');
    expect(SHAPE.test(stripTsComments(real))).toBe(true);
  });

  it('red: the stripper keeps string literals, template literals and escapes, so it cannot silence a real name', () => {
    // A `//` or `/*` INSIDE a literal is not a comment. A stripper that treated
    // it as one would delete the rest of the line and could drop the very path
    // that proves a suite measures this slice — the dangerous direction,
    // because the result is a real measurement that stops being counted.
    expect(stripTsComments("const u = 'https://example.test/0084_x.sql';")).toContain('0084');
    expect(stripTsComments('const t = `a /* 0084 */ b`;')).toContain('0084');
    expect(stripTsComments("const q = 'it\\'s 0084';")).toContain('0084');
    // And a comment really is removed, in both spellings, so the limbs above
    // are not passing because the stripper is the identity function.
    expect(stripTsComments('// 0084\nconst x = 1;')).not.toContain('0084');
    expect(stripTsComments('/* 0084 */ const x = 1;')).not.toContain('0084');
    expect(stripTsComments('/* 0084 */ const x = 1;')).toContain('const x = 1');
  });
});
