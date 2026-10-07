#!/usr/bin/env tsx
/**
 * PHASE 4 SLICE GATE — P4-S5 — the RECORD for this slice's test suites.
 *
 * P4-S5 is the returns slice: the customer return, the credit note, the
 * credit-note application and the customer refund. This file exists for ONE
 * reason, and it is a reason with a date on it: between `6613b98` and
 * `5e18b56`, `tests/guards/p4s5-refund-plan-red-proofs.test.ts` DID NOT
 * COMPILE — an unterminated string literal at 1534:56 — and nothing in this
 * repository said so. The suite was referenced in a contract pack, cited in a
 * review and counted as evidence while the runner had never once opened it.
 *
 * ── WHY THIS IS A NEW FILE AND NOT A ROW IN THE P4-S4 GATE ───────────────
 *
 * `TL-P4-COORD-R16` states the arithmetic: `scripts/phase4-s4-gate.ts` derives
 * its roster from a rule (`/^(?:p4s4-|customer-s4-|phase4-customer-)/` over
 * `tests/`, plus its golden directory) and its floor is
 * `new Set(ROSTER_RECORDED.map(r => r.suite)).size`, compared against the
 * DERIVED `rosterFiles(root).length`. Recording a suite the derivation cannot
 * discover therefore raises RECORDED while DERIVED stays flat, and reds that
 * gate on the commit that adds the row. Hand-lowering a derived floor to
 * absorb the record is the law working and the author silencing it.
 *
 * MEASURED, on this tree: no gate's derivation can see a `p4s5-` file.
 *   - P4-S4: `/^(?:p4s4-|customer-s4-|phase4-customer-)/` — no match.
 *   - P4-S3: `/^(?:pos-s3-|phase4-pos-)/` — no match.
 *   - P4-S1: runs `tests/guards` as a DIRECTORY, so the three suites under it
 *     do execute there — but S1 holds no per-file or per-block record, so it
 *     can say "the directory passed", never "this block still holds 14 cases".
 *   - P4-S2: no basename rule at all.
 *   - `grep -rn p4s5 scripts/*.ts` matched nothing before this file.
 * So the answer to "which gate's derivation can see these files" is NONE, and
 * the record belongs in this slice's own gate, which the contract pack already
 * owes at level F.
 *
 * ── THE CORRECTION THIS FILE CARRIES, AND WHY THE PARSE ARM EXISTS ───────
 *
 * The case-count floor was proposed as "the mechanism that would have caught
 * the syntax error on the commit that introduced it". IT WOULD NOT HAVE. The
 * P4-S4 roster mechanism is a TEXTUAL extractor — `describeBlocks` matches
 * `^describe(` with a regex and `testTitles` matches `it(`/`test(` with a
 * regex — and neither parses. Run both over the real broken text recovered
 * from `6613b98` and they report TWENTY-ONE top-level blocks and NINETY-TWO
 * runnable cases — every block and every case this file recorded for it before
 * H1 was added below. A floor at
 * those numbers is SATISFIED BY THE FILE THAT DOES NOT COMPILE. A non-
 * compiling file does not report zero cases; it reports all of them.
 *
 * What would have caught it is a PARSER. `npm run typecheck` reports TS1002 at
 * 1534:56 on that text, and `npm run format` is what actually did catch it.
 * So this gate carries FOUR arms and they close four different holes:
 *
 *   1. `roster`       — the derivation is coherent and non-empty.
 *   2. `roster-parse` — EVERY rostered file PARSES. This is the arm that reds
 *                       on `6613b98`, and the only one that does.
 *   3. `roster-ratchet`   — a rostered suite cannot leave the derived set, by
 *                       count AND by membership, because a count cannot see a
 *                       swap.
 *   4. `roster-bijection` — every recorded row's own file still carries its
 *                       own title, titles are pairwise distinct, and each
 *                       block holds at least the cases it held. This is the
 *                       arm that reds on a HOLLOWED block, which is a real
 *                       and different defect from a broken one.
 *
 * The floor is recorded because a block that quietly sheds a case is exactly
 * what a floor is for — not because it can see a compile error.
 *
 * ── WHAT THIS GATE DOES NOT DO ───────────────────────────────────────────
 *
 * It does not EXECUTE the suites. `check:roster-execution` in the P4-S4 gate
 * is the estate's pattern for that and it needs a cluster; wiring this gate
 * into the required `backend` job of `.github/workflows/ci.yml` is not mine to
 * do and has NOT been done, so until a step runs it this file is a RECORD that
 * a reviewer and a local run can read, and not yet a required check. That
 * limitation is stated here rather than left to be discovered.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { testTitles } from './phase3-s8-gate';

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');
const has = (root: string, rel: string): boolean => existsSync(join(root, rel));

/** The root Vitest config's `include` is `tests/**\/*.test.ts`: a file that does not match it is a suite nothing executes. */
const RUNNABLE = /\.test\.ts$/;
/** Anything the runner could plausibly be meant to pick up, so a near-miss (`.spec.ts`, `.test.tsx`) is a finding rather than a silent drop. */
const SUITE_LIKE = /\.(?:test|spec)\.[tj]sx?$/;

/** THE RULE: a file under `tests/` whose BASENAME begins `p4s5-`. Anchored at the basename, so the directory an author chooses does not matter and no other slice is swept in. */
export const S5_BASENAME = /^p4s5-/;

/**
 * Plus the rows no naming rule can find — `TL-P4-COORD-R16` condition 3, which
 * is why each one is NAMED with its reason rather than left to a rule that
 * would have to be widened until it swept in other slices.
 *
 * `packages/shared-contracts/test/phase4-s5-returns-contracts.test.ts` lives in
 * the PACKAGE's own test directory, not under the repository's `tests/`, because
 * its subject is the shipped declaration of `@daftar/shared-contracts` and it
 * must import the package the way a consumer does. The basename rule walks
 * `tests/`, so it cannot see it; widening the walk to the whole tree would
 * sweep every package's tests into one slice's roster.
 */
export const S5_NAMED_SUITES: readonly string[] = ['packages/shared-contracts/test/phase4-s5-returns-contracts.test.ts'];

/** Every file under `dir`, recursively, as repo-relative paths. */
function walk(root: string, dir: string): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(absolute).sort()) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

export interface Discovery {
  /** The files the rule matched and the runner would execute. */
  readonly suites: readonly string[];
  /** Suite-like files the rule matched that the ROOT runner would never pick up — a finding, never an omission. */
  readonly unrunnable: readonly string[];
}

/** The rule, applied. Nothing here is written down: the set is whatever the tree holds today. */
export function discoverS5Suites(root: string): Discovery {
  const matched = new Set<string>();
  const unrunnable: string[] = [];
  for (const file of walk(root, 'tests')) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    if (!S5_BASENAME.test(base)) continue;
    if (RUNNABLE.test(base)) matched.add(file);
    else if (SUITE_LIKE.test(base)) unrunnable.push(file);
  }
  return { suites: [...matched].sort(), unrunnable: unrunnable.sort() };
}

/** The roster: the derived set, plus the named rows. */
export function rosterFiles(root: string): string[] {
  return [...new Set([...discoverS5Suites(root).suites, ...S5_NAMED_SUITES])].sort();
}

/** One recorded roster row: the file, a title that file must still carry, and — when the title names a `describe(` BLOCK — the cases that block must still hold. */
export interface RosterRow {
  readonly suite: string;
  readonly title: string;
  readonly cases?: number;
}

/**
 * THE RECORD: every top-level `describe(` block of all four P4-S5 suites, with
 * the case count the EXTRACTOR SEES TODAY, recorded by hand.
 *
 * 36 blocks, 14 + 99 + 19 + 11 + 17 = 160 cases, and the extractor's view and the
 * runner's view agree exactly on every one of the five files — measured, not
 * assumed: a brace-walking counter that read RAW source reported 85 for the
 * 92-case file, because braces inside string literals fooled it, which is the
 * same defect class as the quote-parity inversion the blanker self-test at
 * §14.0 of the mutation suite exists for.
 *
 * It is a FLOOR, so adding cases is free; a block that loses one goes red
 * naming what it held, and a block that is DELETED goes red rather than
 * vanishing. If a case is retired deliberately, lower its number in the same
 * commit, which is the one place a reviewer then sees it.
 */
export const ROSTER_RECORDED: readonly RosterRow[] = [
  // ── tests/guards/p4s5-account-authority-mutation.test.ts — 3 blocks, 14 ──
  {
    suite: 'tests/guards/p4s5-account-authority-mutation.test.ts',
    title: 'P4-S5 §13 — every planner in the LIVE SET follows the canonical account-id source, under mutation',
    cases: 5,
  },
  {
    suite: 'tests/guards/p4s5-account-authority-mutation.test.ts',
    title: 'P4-S5 §14 — no duplicate authority, no second mapping table, no dead member of the table',
    cases: 5,
  },
  {
    suite: 'tests/guards/p4s5-account-authority-mutation.test.ts',
    title: 'P4-S5 §15 — the refusal vocabulary has NO DEAD MEMBER either',
    cases: 4,
  },
  // ── tests/guards/p4s5-refund-plan-red-proofs.test.ts — 22 blocks, 99 ─────
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'TL-P4-S5-R1 — a refund is not an invoice-outstanding reducer', cases: 3 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'a refund draws on EXACTLY ONE source', cases: 2 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the refund cap', cases: 3 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the FX behaviour of a refund', cases: 4 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the credit note entry raises a liability and touches NO receivable', cases: 2 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'an application reduces AR through the ONE canonical algorithm', cases: 11 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'TL-P4-S5-R2 — the seven red proofs', cases: 9 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the COGS reversal takes the stored movement deltas and nothing else', cases: 4 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'OD-03 — sales tax is structurally zero and S5 does not reopen it', cases: 2 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'law 8 — a key replays the SAME economic command or conflicts', cases: 3 },
  {
    suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts',
    title: 'law 8 binds the CREDIT NOTE as well, which is what makes its conflict code reachable',
    cases: 7,
  },
  {
    suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts',
    title: 'the operation codes S5 needs are representable under the frozen digest CHECK',
    cases: 3,
  },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the lock order is one order and a trace that inverts it is a defect', cases: 2 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the date laws name their comparison instant and take it as an argument', cases: 3 },
  // The eleven required boundary cases of TL-P4-S5-R3 plus the premise, the
  // caps-nothing case and the 409-remedy case. The floor is the obligation.
  {
    suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts',
    title: 'TL-P4-S5-R3 — the symmetric 2× refund-FX sanity bound, at every boundary',
    cases: 14,
  },
  {
    suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts',
    title: 'TL-P4-S5-R3 §16 — realized FX is ONE signed difference, and the sign is symmetric',
    cases: 3,
  },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the realized exchange movement is BOUNDED and not merely posted', cases: 3 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the lock order’s shared rank has a checked premise', cases: 3 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'H3 — the credit-note lifecycle is deleted, everywhere', cases: 5 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the source consumption chain', cases: 3 },
  { suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts', title: 'the refusal vocabulary and the route authority', cases: 3 },
  // H1, the last open challenger finding: the pair law over the DDL
  // specification — a validator and the trigger that fires it.
  {
    suite: 'tests/guards/p4s5-refund-plan-red-proofs.test.ts',
    title: 'H1 \u2014 every registered S5 source type has a validator AND the trigger that FIRES it',
    cases: 7,
  },
  // ── tests/guards/p4s5-refund-cap-concurrency-models.test.ts — 6, 19 ──────
  { suite: 'tests/guards/p4s5-refund-cap-concurrency-models.test.ts', title: 'P4-S5 concurrency model — race 1: refund vs refund on one source', cases: 3 },
  {
    suite: 'tests/guards/p4s5-refund-cap-concurrency-models.test.ts',
    title: 'P4-S5 concurrency model — race 2: a refund and an APPLICATION consuming one source',
    cases: 3,
  },
  { suite: 'tests/guards/p4s5-refund-cap-concurrency-models.test.ts', title: 'P4-S5 concurrency model — race 3: a FULL refund racing a PARTIAL one', cases: 2 },
  {
    suite: 'tests/guards/p4s5-refund-cap-concurrency-models.test.ts',
    title: 'P4-S5 — property 4: the cap is invariant under the disbursement rate (NOT an interleaving)',
    cases: 2,
  },
  {
    suite: 'tests/guards/p4s5-refund-cap-concurrency-models.test.ts',
    title: 'P4-S5 concurrency model — race 5: direct-SQL writers that never take the lock',
    cases: 6,
  },
  {
    suite: 'tests/guards/p4s5-refund-cap-concurrency-models.test.ts',
    title: 'the model implements the isolation level it names, and both halves matter',
    cases: 3,
  },
  // ── tests/guards/p4s5-gate-execution.test.ts — 4 blocks, 17 ─────────────
  // The record's OWN red proofs: a record whose falsifiability is unrecorded
  // is the next thing to be deleted quietly.
  {
    suite: 'tests/guards/p4s5-gate-execution.test.ts',
    title: 'P4-S5 \u00a7A \u2014 the PARSE arm reds on a file that does not compile, and the COUNT arms do not',
    cases: 5,
  },
  {
    suite: 'tests/guards/p4s5-gate-execution.test.ts',
    title: 'P4-S5 \u00a7B \u2014 the CASE FLOOR reds on a HOLLOWED block, which compiles perfectly',
    cases: 5,
  },
  { suite: 'tests/guards/p4s5-gate-execution.test.ts', title: 'P4-S5 \u00a7C \u2014 the ratchet, and the derivation it rides on', cases: 4 },
  { suite: 'tests/guards/p4s5-gate-execution.test.ts', title: 'P4-S5 \u00a7D \u2014 the record is COMPLETE over the tree it describes', cases: 3 },
  // ── packages/shared-contracts/test/phase4-s5-returns-contracts.test.ts ───
  {
    suite: 'packages/shared-contracts/test/phase4-s5-returns-contracts.test.ts',
    title: 'P4-S5 contract — the refund shape, read from the shipped declaration',
    cases: 11,
  },
];

/** The ratchet's recorded file count, DERIVED from the record so it cannot drift from it. */
export const ROSTER_FLOOR = new Set(ROSTER_RECORDED.map((r) => r.suite)).size;

/** The cases the record accounts for, as one number a reader can check against a run's own tally. */
export const RECORDED_CASE_FLOOR = ROSTER_RECORDED.reduce((sum, row) => sum + (row.cases ?? 1), 0);

/** The derivation, and the ways it can be wrong: it found nothing, it found a suite nothing runs, or a named row is gone. */
export function rosterProblems(root: string): string[] {
  const problems: string[] = [];
  const { suites, unrunnable } = discoverS5Suites(root);
  for (const file of unrunnable)
    problems.push(`${file} matches the P4-S5 roster rule but not the root runner's include (tests/**/*.test.ts) — it would be committed and never executed`);
  if (suites.length === 0)
    problems.push(
      'the P4-S5 roster rule matched no suite — a derived roster with no subject is not a pass (the rule is: a file under tests/ whose basename begins `p4s5-`)',
    );
  for (const named of S5_NAMED_SUITES)
    if (!has(root, named))
      problems.push(`${named} is a NAMED roster row — no naming rule finds it — and it is not on disk, so nothing executes the contract it asserts`);
  return problems;
}

/** What the derivation found, printed on a PASS as well as on a FAIL. */
export function rosterReport(root: string): string {
  const { suites, unrunnable } = discoverS5Suites(root);
  return `${suites.length} derived + ${S5_NAMED_SUITES.length} named = ${rosterFiles(root).length} file(s): ${rosterFiles(root).join(', ') || 'none'}${
    unrunnable.length === 0 ? '' : `; ${unrunnable.length} matched file(s) the runner would NOT execute: ${unrunnable.join(', ')}`
  }`;
}

/**
 * THE PARSE ARM — the one the textual mechanism lacks.
 *
 * Measured on the real broken text of `6613b98`: `describeBlocks` reports 21
 * blocks and `testTitles` reports 92 cases over a file with an unterminated
 * string literal, so every count arm of this gate is satisfied by it and only
 * this one refuses. `transpileModule` with `reportDiagnostics` is the public
 * API for the question; it does no type checking and needs no program, so this
 * arm is about SYNTAX and says so rather than claiming to be a typecheck.
 */
export function parseProblems(root: string, rows?: readonly string[]): string[] {
  const problems: string[] = [];
  // `rows ?? rosterFiles(root)`, and NOT `rows.length > 0 ? rows : …`: with the
  // fallback keyed on emptiness, the non-vacuity guard below could only fire
  // when the DERIVED roster was empty too, and it never is — `S5_NAMED_SUITES`
  // is injected unconditionally. That is a dead branch with a sentence
  // claiming it is a guard, which is the defect this slice already shipped once
  // (`customer_refund.registry_incomplete`). An explicit empty list now means
  // "judged nothing" and reds.
  const files = rows ?? rosterFiles(root);
  if (files.length === 0) return ['the P4-S5 parse arm judged no file, and its silence is not evidence'];
  for (const file of files) {
    if (!has(root, file)) {
      problems.push(`${file} is on the P4-S5 roster and is not on disk, so nothing was parsed`);
      continue;
    }
    for (const d of parseDiagnostics(read(root, file)))
      problems.push(`${file} DOES NOT PARSE: ${d} — the runner never opened it, and every count arm of this gate is satisfied by it`);
  }
  return problems;
}

/** The syntax diagnostics of one source text, as `TS<code> <message> at <line>:<column>` strings. */
export function parseDiagnostics(source: string): string[] {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (result.diagnostics ?? []).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    if (d.file === undefined || d.start === undefined) return `TS${d.code} ${message}`;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `TS${d.code} ${message} at ${line + 1}:${character + 1}`;
  });
}

/** The parse arm's tally, on a PASS as well as on a FAIL. */
export function parseReport(root: string): string {
  const files = rosterFiles(root);
  const bad = files.filter((f) => has(root, f) && parseDiagnostics(read(root, f)).length > 0);
  return `${files.length} rostered file(s) parsed, ${bad.length} with syntax diagnostics (${bad.join(', ') || 'none'})`;
}

/** THE NON-SHRINKING RATCHET: by count, and by MEMBERSHIP, because a count cannot see a swap. */
export function rosterRatchetProblems(root: string): string[] {
  const problems: string[] = [];
  const files = rosterFiles(root);
  if (files.length < ROSTER_FLOOR)
    problems.push(
      `the P4-S5 roster holds ${files.length} file(s) and the ratchet floor is ${ROSTER_FLOOR} — a rostered suite has left the roster, which is what a move AND rename out of the basename rule does. If a suite was retired deliberately, remove its rows from ROSTER_RECORDED in the same commit, which lowers this floor with them`,
    );
  const derived = new Set(files);
  const gone = [...new Set(ROSTER_RECORDED.map((r) => r.suite))].filter((f) => !derived.has(f));
  if (gone.length > 0)
    problems.push(
      `${gone.length} recorded P4-S5 suite(s) are no longer on the roster: ${gone.join(', ')} — a sibling's new file holds a count up, so membership is asserted and not only the total`,
    );
  if (ROSTER_RECORDED.length === 0) problems.push('ROSTER_RECORDED is empty, so every arm that reads it judged nothing and its silence is not evidence');
  return problems;
}

/** The ratchet's numbers, on a PASS as well as on a FAIL. */
export function rosterRatchetReport(root: string): string {
  const derived = new Set(rosterFiles(root));
  const recorded = [...new Set(ROSTER_RECORDED.map((r) => r.suite))];
  return `${derived.size} rostered file(s) against a floor of ${ROSTER_FLOOR}; ${recorded.filter((f) => derived.has(f)).length} of ${recorded.length} recorded suite(s) still rostered; ${ROSTER_RECORDED.length} recorded block row(s) accounting for ${RECORDED_CASE_FLOOR} case(s)`;
}

/**
 * The titles of a suite that can SATISFY a recorded row: its runnable `it(`
 * cases, plus the title of every top-level `describe(` block that is not
 * skip-marked and that holds at least one runnable case. A hollowed-out block
 * cannot satisfy a row, and neither can a skipped one.
 */
export function rosterRowTitles(source: string): string[] {
  const blocks = describeBlocks(source);
  const skipped = /^describe\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)*\.\s*(?:skip|only|todo|skipIf|runIf|fails)\b/;
  const out = new Set<string>(testTitles(source.slice(0, blocks[0]?.at ?? source.length)));
  for (const block of blocks) {
    if (skipped.test(block.body)) continue;
    const cases = testTitles(block.body);
    if (cases.length === 0) continue;
    out.add(block.title);
    for (const t of cases) out.add(t);
  }
  return [...out].sort();
}

/** The top-level `describe(` blocks of a suite, as title and body. Anchored at column 0, so a nested block belongs to its parent's body. */
export function describeBlocks(source: string): readonly { readonly at: number; readonly title: string; readonly body: string }[] {
  const marks: { at: number; title: string }[] = [];
  for (const m of source.matchAll(/^describe(?:\.\w+)?\s*\(\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/gm))
    marks.push({ at: m.index ?? 0, title: (m[2] ?? '').replace(/\\([\s\S])/g, '$1') });
  return marks.map((mark, i) => ({
    at: mark.at,
    title: mark.title,
    body: source.slice(mark.at, i + 1 < marks.length ? (marks[i + 1]?.at ?? source.length) : source.length),
  }));
}

/** ROSTER → DISK, ROW → THE FILE IT NAMES, and BLOCK → ITS CASE FLOOR. */
export function rosterBijectionProblems(root: string, rows: readonly RosterRow[] = ROSTER_RECORDED): string[] {
  const problems: string[] = [];
  for (const file of rosterFiles(root))
    if (!has(root, file))
      problems.push(
        `the P4-S5 roster lists ${file} and the tree does not hold it — a NAMED row stays on the roster however absent it is, so this direction is asserted separately`,
      );
  if (rows.length === 0) return [...problems, 'ROSTER_RECORDED is empty, so this law judged no row and its silence is not evidence'];
  const seen = new Map<string, string>();
  for (const row of rows) {
    const owner = seen.get(row.title);
    if (owner !== undefined && owner !== row.suite)
      problems.push(
        `${row.suite} and ${owner} both record the title \`${row.title}\` — a title two FILES share is a title either file can satisfy for the other`,
      );
    if (owner !== undefined && owner === row.suite)
      problems.push(`${row.suite} records the title \`${row.title}\` twice, so one of the two rows is judging the other's block`);
    seen.set(row.title, row.suite);
    if (!has(root, row.suite)) {
      problems.push(`${row.suite} is a recorded roster row and is not on disk, so the row names nothing`);
      continue;
    }
    const source = read(root, row.suite);
    const titles = rosterRowTitles(source);
    if (titles.length === 0) {
      problems.push(
        `${row.suite} holds no runnable block or case at all, so the recorded row \`${row.title}\` is satisfied by a file the runner finds nothing in`,
      );
      continue;
    }
    if (!titles.includes(row.title)) {
      problems.push(
        `${row.suite} no longer carries the recorded title \`${row.title}\` as a runnable describe( block or it( case — the path is still on the roster and the file still holds some title, so every count arm here is green over a file whose content has been replaced. A row names a LAW, not a filename`,
      );
      continue;
    }
    if (row.cases === undefined) continue;
    const block = describeBlocks(source).find((b) => b.title === row.title);
    if (block === undefined)
      problems.push(
        `${row.suite} records a case floor of ${row.cases} for \`${row.title}\`, and that title is not a describe( BLOCK — a floor over a single it( case is a floor over nothing`,
      );
    else {
      const held = testTitles(block.body).length;
      if (held < row.cases)
        problems.push(
          `${row.suite}: the block \`${row.title}\` holds ${held} runnable case(s) and its recorded floor is ${row.cases} — the title is still here and part of the law inside it is not, which is exactly the hollowing a title-presence check cannot see. If a case was retired deliberately, lower the floor in the same commit`,
        );
    }
  }
  return problems;
}

/** The bijection's sides, on a PASS as well as on a FAIL. */
export function rosterBijectionReport(root: string): string {
  const kept = ROSTER_RECORDED.filter((r) => has(root, r.suite) && rosterRowTitles(read(root, r.suite)).includes(r.title)).length;
  const held = ROSTER_RECORDED.reduce((sum, row) => {
    if (!has(root, row.suite)) return sum;
    const block = describeBlocks(read(root, row.suite)).find((b) => b.title === row.title);
    return sum + (block === undefined ? 0 : testTitles(block.body).length);
  }, 0);
  return `${kept} of ${ROSTER_RECORDED.length} recorded row(s) still carry their own title; ${new Set(ROSTER_RECORDED.map((r) => r.title)).size} distinct recorded title(s); ${held} case(s) held against a recorded floor of ${RECORDED_CASE_FLOOR}`;
}

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly run: (root: string) => string[];
  readonly ok: string;
  /** Measured numbers this check must report on a PASS as well as on a FAIL. */
  readonly note?: (root: string) => string;
}

export const CHECKS: readonly Check[] = [
  {
    id: 'roster',
    title: 'the P4-S5 roster is DERIVED from the tree by one stated rule, plus named rows that carry their reason',
    run: rosterProblems,
    note: rosterReport,
    ok: 'the basename rule matched at least one suite, every matched file is one the root runner executes, and every named row is on disk',
  },
  {
    id: 'roster-parse',
    title: 'every rostered file PARSES — the arm a textual case count cannot be',
    run: (root) => parseProblems(root),
    note: parseReport,
    ok: 'every rostered file was handed to the TypeScript parser and reported no syntax diagnostic, so no rostered suite is a file the runner has never been able to open',
  },
  {
    id: 'roster-ratchet',
    title: 'no rostered suite leaves the roster, by count AND by membership',
    run: rosterRatchetProblems,
    note: rosterRatchetReport,
    ok: 'the derived roster is at or above its recorded floor and every recorded suite is still on it, so a move-and-rename out of the basename rule is named rather than absorbed by a sibling addition',
  },
  {
    id: 'roster-bijection',
    title: 'every recorded row still names a live law in its OWN file, down to the cases its block holds',
    run: (root) => rosterBijectionProblems(root),
    note: rosterBijectionReport,
    ok: 'every rostered path is on disk, every recorded title is still carried by the file that records it as a runnable block or case, titles are pairwise distinct, and every recorded block still holds at least the cases it held',
  },
];

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : join(__dirname, '..');
  let failed = 0;
  for (const check of CHECKS) {
    const problems = check.run(root);
    if (problems.length === 0) console.log(`ok   ${check.id} — ${check.title}: ${check.ok}`);
    else {
      failed += 1;
      console.error(`FAIL ${check.id} — ${check.title}\n  ${problems.join('\n  ')}`);
    }
    if (check.note !== undefined) console.log(`     ${check.id} measured: ${check.note(root)}`);
  }
  console.log(
    failed === 0
      ? `PASS gate:phase4:s5 at ${root}: ${CHECKS.length} check(s) ok — a RECORD, not yet a required CI step: no step of the backend job runs this file`
      : `FAIL gate:phase4:s5 at ${root}: ${failed} of ${CHECKS.length} check(s) refuse this tree`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
