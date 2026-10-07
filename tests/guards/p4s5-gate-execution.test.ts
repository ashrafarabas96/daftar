/**
 * P4-S5 — THE RECORD'S OWN RED PROOFS.
 *
 * `scripts/phase4-s5-gate.ts` records every top-level `describe(` block of this
 * slice's four suites with the cases it holds. This file is the proof that the
 * record can go RED, and that each arm reds on a DIFFERENT defect — because the
 * reason the record exists is that a suite of this slice did not compile for
 * three commits while every reader counted it as evidence.
 *
 * Each proof below names its subject, mutates it, shows the result is non-empty
 * and names the exact intended defect. The two that matter most are:
 *
 *   §A  the PARSE arm reds on an unterminated string literal, AND the textual
 *       count arms stay fully satisfied by the same mutated text. That is the
 *       correction this record carries: a case-count floor would NOT have
 *       caught the `6613b98` defect, because a non-compiling file does not
 *       report zero cases — it reports all of them.
 *   §B  the CASE FLOOR reds on a HOLLOWED block, which the parse arm cannot
 *       see, because a hollowed block compiles perfectly.
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CHECKS,
  ROSTER_FLOOR,
  ROSTER_RECORDED,
  RECORDED_CASE_FLOOR,
  S5_BASENAME,
  S5_NAMED_SUITES,
  describeBlocks,
  discoverS5Suites,
  parseDiagnostics,
  parseProblems,
  rosterBijectionProblems,
  rosterFiles,
  rosterProblems,
  rosterRatchetProblems,
  type RosterRow,
} from '../../scripts/phase4-s5-gate';
import { testTitles } from '../../scripts/phase3-s8-gate';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** The suite whose text did not compile from `6613b98` to `5e18b56`. */
const BROKEN_SUBJECT = 'tests/guards/p4s5-refund-plan-red-proofs.test.ts';

/**
 * A runnable case, SPELLED SO THE EXTRACTOR DOES NOT COUNT IT.
 *
 * `testTitles` matches the word `it` followed by `(` at any byte position, strings and comments
 * included, so a fixture body written as a plain string literal would be
 * counted as a case OF THIS FILE and the recorded floor would then be larger
 * than anything the runner ever reports. That divergence is the same defect
 * class as the brace-walking counter that read 85 for a 92-case file. So every
 * fixture here composes the word, and §D asserts the two views agree.
 */
const fixtureCase = (title: string): string => `${'i'}t(${JSON.stringify(title)}, () => undefined);`;

const temporary: string[] = [];
/** A scratch root holding exactly the files given, so a mutation is applied to a TREE and not to a string the law never reads from disk. */
function scratchRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'p4s5-gate-'));
  temporary.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
afterAll(() => {
  for (const root of temporary) rmSync(root, { recursive: true, force: true });
});

describe('P4-S5 §A — the PARSE arm reds on a file that does not compile, and the COUNT arms do not', () => {
  it('the subject exists, is rostered, and is lawful as it stands — so a red below is the mutation and not the tree', () => {
    expect(rosterFiles(ROOT)).toContain(BROKEN_SUBJECT);
    expect(parseDiagnostics(read(BROKEN_SUBJECT))).toEqual([]);
    expect(parseProblems(ROOT)).toEqual([]);
    expect(rosterProblems(ROOT)).toEqual([]);
    expect(rosterRatchetProblems(ROOT)).toEqual([]);
    expect(rosterBijectionProblems(ROOT)).toEqual([]);
  });

  it('THE HISTORICAL DEFECT, verbatim: a quoted argument carrying a raw line break is TS1002, and the parser names it', () => {
    // The real shape from `6613b98`, line 1534: a `toContain(` argument the
    // author flowed across two lines so the quoted text would read as the
    // comment it was matching. Written here with an explicit `\n` so THIS file
    // compiles while the text under test does not.
    const historical = ["expect(SETTLEMENT_LAW_SOURCE).toContain('creates no", "  // gain or loss amount');"].join('\n');
    const diagnostics = parseDiagnostics(historical);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.join(' | ')).toMatch(/TS1002 Unterminated string literal/);
  });

  it('the live subject, MUTATED the same way, reds the parse arm by name', () => {
    const source = read(BROKEN_SUBJECT);
    // The mutation: take the first single-quoted `toContain(` argument of the
    // real file and break the line inside it, which is exactly what happened.
    const mutated = source.replace(/toContain\('([^'\n]{8})/, "toContain('$1\n");
    expect(mutated).not.toBe(source);
    expect(parseDiagnostics(mutated).join(' | ')).toMatch(/TS1002/);
    const root = scratchRoot({ [BROKEN_SUBJECT]: mutated, [S5_NAMED_SUITES[0] as string]: read(S5_NAMED_SUITES[0] as string) });
    const problems = parseProblems(root, [BROKEN_SUBJECT]);
    expect(problems).not.toEqual([]);
    expect(problems.join(' | ')).toContain(BROKEN_SUBJECT);
    expect(problems.join(' | ')).toContain('DOES NOT PARSE');
  });

  it('AND THE CORRECTION: the same mutated text still reports every block and every case, so a case-count floor is SATISFIED by it', () => {
    const source = read(BROKEN_SUBJECT);
    const mutated = source.replace(/toContain\('([^'\n]{8})/, "toContain('$1\n");
    // The textual extractors the recorded floor is built on, over text that
    // does not compile. This is the claim a reader must not have to re-derive.
    expect(describeBlocks(mutated)).toHaveLength(describeBlocks(source).length);
    expect(describeBlocks(source)).toHaveLength(21);
    expect(testTitles(mutated)).toHaveLength(92);
    const root = scratchRoot({ [BROKEN_SUBJECT]: mutated, [S5_NAMED_SUITES[0] as string]: read(S5_NAMED_SUITES[0] as string) });
    const rows = ROSTER_RECORDED.filter((r) => r.suite === BROKEN_SUBJECT);
    expect(rows.length).toBeGreaterThan(0);
    // EVERY count arm silent, over a file the runner cannot open.
    expect(rosterBijectionProblems(root, rows)).toEqual([]);
    // And only the parse arm refuses it.
    expect(parseProblems(root, [BROKEN_SUBJECT])).not.toEqual([]);
  });

  it('the parse arm cannot be satisfied by judging nothing, and says so', () => {
    const root = scratchRoot({ 'tests/guards/p4s5-nothing.test.ts': "import { it } from 'vitest';\n" });
    expect(parseProblems(root, []).join(' | ')).toContain('judged no file');
    expect(parseProblems(root, ['tests/guards/p4s5-absent.test.ts']).join(' | ')).toContain('not on disk');
  });
});

describe('P4-S5 §B — the CASE FLOOR reds on a HOLLOWED block, which compiles perfectly', () => {
  it('a block reduced to one trivial case reds, names the block, and names both counts', () => {
    const row = ROSTER_RECORDED.find((r) => r.title.startsWith('TL-P4-S5-R3 —')) as RosterRow;
    expect(row.cases).toBe(14);
    const source = read(row.suite);
    const block = describeBlocks(source).find((b) => b.title === row.title);
    expect(block).toBeDefined();
    const hollow = `describe(${JSON.stringify(row.title)}, () => {\n  ${fixtureCase('x')}\n});\n`;
    const mutated = source.replace((block as { body: string }).body, hollow);
    expect(mutated).not.toBe(source);
    // It COMPILES: the parse arm is silent and only the floor refuses.
    expect(parseDiagnostics(mutated)).toEqual([]);
    const root = scratchRoot({ [row.suite]: mutated });
    const problems = rosterBijectionProblems(root, [row]);
    expect(problems).not.toEqual([]);
    expect(problems.join(' | ')).toContain(row.title);
    expect(problems.join(' | ')).toContain('holds 1 runnable case(s)');
    expect(problems.join(' | ')).toContain('recorded floor is 14');
    expect(parseProblems(root, [row.suite])).toEqual([]);
  });

  it('a DELETED block reds rather than vanishing, and the message names a law rather than a filename', () => {
    const row = ROSTER_RECORDED.find((r) => r.title === 'the source consumption chain') as RosterRow;
    const source = read(row.suite);
    const block = describeBlocks(source).find((b) => b.title === row.title) as { body: string };
    const root = scratchRoot({ [row.suite]: source.replace(block.body, '') });
    const problems = rosterBijectionProblems(root, [row]);
    expect(problems).not.toEqual([]);
    expect(problems.join(' | ')).toContain('no longer carries the recorded title');
    expect(problems.join(' | ')).toContain('A row names a LAW, not a filename');
  });

  it('a block kept but SKIPPED reds, because a skipped block satisfies no row', () => {
    const row = ROSTER_RECORDED.find((r) => r.title === 'the refund cap') as RosterRow;
    const source = read(row.suite);
    // Matched on the file's OWN quoting, not on `JSON.stringify`, which spells
    // the title with double quotes while the source uses single ones — a
    // mutation that silently applies to nothing is a red proof that proves
    // nothing, so the assertion below that the text CHANGED is load-bearing.
    const mutated = source.replace(new RegExp(`^describe\\((['"\`])${row.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'm'), (m) =>
      m.replace('describe(', 'describe.skip('),
    );
    expect(mutated).not.toBe(source);
    const root = scratchRoot({ [row.suite]: mutated });
    expect(rosterBijectionProblems(root, [row])).not.toEqual([]);
  });

  it('a row whose recorded title is an it( case rather than a describe( block is refused, so a floor is never a floor over nothing', () => {
    const row: RosterRow = { suite: 'tests/guards/p4s5-synthetic.test.ts', title: 'a case, not a block', cases: 3 };
    const root = scratchRoot({ [row.suite]: `import { it } from 'vitest';\n${fixtureCase('a case, not a block')}\n` });
    expect(rosterBijectionProblems(root, [row]).join(' | ')).toContain('is not a describe( BLOCK');
  });

  it('two rows cannot share a title, so no file can satisfy another file’s row', () => {
    const rows: readonly RosterRow[] = [
      { suite: 'tests/guards/p4s5-a.test.ts', title: 'shared' },
      { suite: 'tests/guards/p4s5-b.test.ts', title: 'shared' },
    ];
    const body = `import { describe, it } from 'vitest';\ndescribe('shared', () => {\n  ${fixtureCase('c')}\n});\n`;
    const root = scratchRoot({ 'tests/guards/p4s5-a.test.ts': body, 'tests/guards/p4s5-b.test.ts': body });
    expect(rosterBijectionProblems(root, rows).join(' | ')).toContain('both record the title');
  });
});

describe('P4-S5 §C — the ratchet, and the derivation it rides on', () => {
  it('a recorded suite moved AND renamed out of the basename rule reds by MEMBERSHIP even when a sibling holds the count up', () => {
    const files = rosterFiles(ROOT);
    const leaving = BROKEN_SUBJECT;
    const kept: Record<string, string> = {};
    for (const f of files) if (f !== leaving) kept[f] = read(f);
    // Renamed out of `/^p4s5-/` AND a brand-new suite added, so the TOTAL is unchanged.
    kept['tests/guards/renamed-refund-plan-red-proofs.test.ts'] = read(leaving);
    kept['tests/guards/p4s5-brand-new.test.ts'] = `import { describe, it } from 'vitest';\ndescribe('new', () => {\n  ${fixtureCase('c')}\n});\n`;
    const root = scratchRoot(kept);
    expect(rosterFiles(root)).toHaveLength(files.length);
    const problems = rosterRatchetProblems(root);
    expect(problems).not.toEqual([]);
    expect(problems.join(' | ')).toContain(leaving);
    expect(problems.join(' | ')).toContain('no longer on the roster');
  });

  it('the derivation is the subject: an empty tree reds, and a near-miss filename is a finding rather than a silent drop', () => {
    expect(rosterProblems(scratchRoot({ 'tests/guards/unrelated.test.ts': '' })).join(' | ')).toContain('matched no suite');
    const near = scratchRoot({ 'tests/guards/p4s5-near.spec.ts': '', 'tests/guards/p4s5-real.test.ts': '' });
    expect(discoverS5Suites(near).unrunnable).toEqual(['tests/guards/p4s5-near.spec.ts']);
    expect(rosterProblems(near).join(' | ')).toContain('never executed');
  });

  it('the NAMED row is named because no rule finds it, and its absence reds in both directions', () => {
    for (const named of S5_NAMED_SUITES) expect(S5_BASENAME.test(named.slice(named.lastIndexOf('/') + 1))).toBe(false);
    const root = scratchRoot({
      'tests/guards/p4s5-real.test.ts': `import { describe, it } from 'vitest';\ndescribe('d', () => {\n  ${fixtureCase('c')}\n});\n`,
    });
    expect(rosterProblems(root).join(' | ')).toContain('NAMED roster row');
    expect(rosterBijectionProblems(root, []).join(' | ')).toContain('the tree does not hold it');
  });

  it('the floor is DERIVED from the record, so the two cannot drift, and neither is empty', () => {
    expect(ROSTER_RECORDED.length).toBeGreaterThan(0);
    expect(ROSTER_FLOOR).toBe(new Set(ROSTER_RECORDED.map((r) => r.suite)).size);
    expect(ROSTER_FLOOR).toBe(5);
    expect(rosterFiles(ROOT).length).toBeGreaterThanOrEqual(ROSTER_FLOOR);
  });
});

describe('P4-S5 §D — the record is COMPLETE over the tree it describes', () => {
  it('every top-level describe( block of every rostered file is recorded, so a block cannot be added outside the floor', () => {
    const missing: string[] = [];
    for (const file of rosterFiles(ROOT))
      for (const block of describeBlocks(read(file)))
        if (!ROSTER_RECORDED.some((r) => r.suite === file && r.title === block.title)) missing.push(`${file} :: ${block.title}`);
    expect(missing).toEqual([]);
  });

  it('every recorded count is a FLOOR the tree meets exactly today, and the totals are the ones the runner reported', () => {
    const measured = ROSTER_RECORDED.map((row) => {
      const block = describeBlocks(read(row.suite)).find((b) => b.title === row.title);
      return { title: row.title, recorded: row.cases, held: block === undefined ? undefined : testTitles(block.body).length };
    });
    expect(measured.filter((m) => m.held === undefined)).toEqual([]);
    expect(measured.filter((m) => (m.held as number) < (m.recorded as number))).toEqual([]);
    expect(measured.reduce((sum, m) => sum + (m.held as number), 0)).toBe(RECORDED_CASE_FLOOR);
  });

  it('the four arms are registered and each one is reachable from the CLI, so none of them is a function nothing calls', () => {
    expect(CHECKS.map((c) => c.id)).toEqual(['roster', 'roster-parse', 'roster-ratchet', 'roster-bijection']);
    for (const check of CHECKS) {
      expect(check.run(ROOT)).toEqual([]);
      expect(check.note).toBeDefined();
      expect((check.note as (r: string) => string)(ROOT).length).toBeGreaterThan(0);
    }
  });
});
