#!/usr/bin/env tsx
/**
 * PHASE 4 SLICE GATE — P4-S3 — `npm run gate:phase4:s3`
 *
 * P4-S3 is the POS till-session slice: one till session = one authenticated
 * user, and the server-side cart that session owns. This gate is the slice's
 * evidence, and it is written against the Tech Lead's standing ruling:
 *
 *   «A green workflow is not evidence for a gate the workflow never ran. A
 *    gate that checks test filenames but never executes the tests is not a
 *    gate. Do not weaken the product to obtain green. Fix the evidence so
 *    green means what it claims.»
 *
 * Four defects in the P4-S2 gate produced that ruling. The two this file is
 * answerable for are designed against here, explicitly:
 *
 *   1. THE ROSTER IS EXECUTED. `roster` answers "does the suite exist and can
 *      it go red"; it cannot answer "does it PASS". `roster-execution` hands
 *      every rostered file to one bounded Vitest run and reads the verdict off
 *      the spawn result — never through a pipe, because a pipeline's exit
 *      status is its LAST stage's and DAFTAR's runner has already exited 0
 *      over four failing tests. The executor is the one the P4-S2 gate already
 *      uses (`executeSuites`), so there is a single implementation of that
 *      verdict rather than a second one that can drift.
 *   2. THE GATE IS IN REQUIRED CI, STRUCTURALLY. Step 35 of the required
 *      `backend` job runs this gate, and
 *      `tests/guards/required-ci-chain-composition.test.ts` asserts that by
 *      PARSING `.github/workflows/ci.yml` — the step's presence, its position
 *      after P4-S1 and P4-S2, its exact command, and the absence of
 *      `continue-on-error` and of any `if:`. That suite is on this gate's
 *      roster (`CI_COMPOSITION_SUITE`), so the claim "this gate is in required
 *      CI" is executed by this gate itself.
 *
 * ── HOW THE CHAIN COMPOSES (TL-P4-S2-R3) ─────────────────────────────────
 *
 * This gate does NOT spawn `gate:phase4:s2`, and that is the accepted
 * arrangement rather than an omission. TL-P4-S2-R3 authorized CHAIN
 * COMPOSITION INSIDE THE ONE REQUIRED JOB: `P4-S1 → P4-S2 → P4-S3` run
 * sequentially and visibly as separate steps of `backend`, so a delta gate
 * need not re-execute a ~50-minute predecessor inside itself. The P4-S2 gate
 * is built on that ruling (it does not compose P4-S1 either), the ordering is
 * what `required-ci-chain-composition.test.ts` asserts, and that suite is on
 * this roster.
 *
 * What IS composed here is the predecessors' ASSERTIONS, by import, at no
 * execution cost: `prefixProblems` and both predecessors' `boundaryProblems`
 * and `closureRuleProblems` are called directly, so the accepted tense of the
 * slices behind this one is re-asserted by this gate on every run.
 *
 * ── THE FROZEN PREFIX IS AN INVARIANT, NOT A CLOSURE RULE ────────────────
 *
 * `[[daftar-a-closure-rule-is-not-an-invariant]]`. The Phase 2 release gate
 * once asserted "no migration may exist after 0052"; the first authorized
 * successor made every later tree fail. So nothing in this file says "nothing
 * after N":
 *
 *   — the frozen prefix (`0000`–`0078`, 79 files, `frozenThrough`
 *     `0078_phase4_sale_commit.sql`) is asserted by DELEGATION to the accepted
 *     prefix modules, which compare each accepted file against its accepted
 *     digest and treat `frozenThrough` as a FLOOR;
 *   — `0079_phase4_pos_till_sessions_cart.sql` is a CANDIDATE. Only Tech Lead
 *     acceptance freezes it. This gate therefore digest-pins NOTHING in this
 *     slice, counts no `.sql` files against a literal, and asserts nothing
 *     whatever about a file numbered past the last ACCEPTED name;
 *   — `selfClosureProblems` turns those two forbidden shapes on THIS file, so
 *     the rule is enforced against the gate that states it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { testTitles } from './phase3-s8-gate';
import { PHASE4_S3_PREFIX, phase4PrefixEnd } from './phase4-prefix';
import { S1_ACCEPTED, boundaryProblems as s1BoundaryProblems, prefixProblems } from './phase4-s1-gate';
import {
  S2_ACCEPTED,
  boundaryProblems as s2BoundaryProblems,
  closureRuleProblems as predecessorClosureRuleProblems,
  executeSuites,
  type SuiteExecution,
  type SuiteRow,
} from './phase4-s2-gate';

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');
const has = (root: string, rel: string): boolean => existsSync(join(root, rel));

/**
 * P4-S3's accepted migrations and their digests — EMPTY while the slice is a
 * candidate. The acceptance commit fills this and `PHASE4_S3_PREFIX` together,
 * which is what flips the tense; until then this gate pins nothing, and
 * `candidateTenseProblems` refuses a tree in which only one of the two was
 * filled.
 */
export const S3_ACCEPTED: Readonly<Record<string, string>> = {};

// ───── THE ROSTER, DERIVED FROM THE TREE ──────────────────────────────────
// A hand-written list silently misses the suite a sibling adds — and four
// agents are writing P4-S3's suites in four worktrees while this gate is
// written. So the roster is DERIVED, by one stated rule, and the derived set
// is required to be non-empty and is printed on every run.

/** The root Vitest config's `include` is `tests/**\/*.test.ts`: a file that does not match it is a suite nothing executes. */
const RUNNABLE = /\.test\.ts$/;
/** Anything the runner could plausibly be meant to pick up, used to catch a near-miss (`.spec.ts`, `.test.tsx`) rather than silently dropping it. */
const SUITE_LIKE = /\.(?:test|spec)\.[tj]sx?$/;

/**
 * THE RULE: a file under `tests/` whose BASENAME begins `pos-s3-` or
 * `phase4-pos-`. Anchored at the basename, so Phase 3's `inventory-s3-*`
 * suites — which are not this slice's — are not swept in, and the directory a
 * sibling chooses does not matter.
 */
const S3_BASENAME = /^(?:pos-s3-|phase4-pos-)/;

/**
 * Plus this slice's golden directory, whatever its files are called: goldens
 * are named by position (`01-…golden.test.ts`), not by slice prefix, which is
 * how `tests/golden-regression/phase4-s2` is named.
 */
export const S3_GOLDEN_DIR = 'tests/golden-regression/phase4-s3';

/**
 * Plus ONE named row that no naming rule would find: the suite that asserts —
 * by parsing the workflow — that the required `backend` job really runs P4-S1,
 * then P4-S2, then this gate. It is listed explicitly because it is the
 * evidence for *this file's* place in required CI, and a gate that leaves that
 * claim to be executed somewhere else is the second P4-S2 defect.
 */
export const CI_COMPOSITION_SUITE = 'tests/guards/required-ci-chain-composition.test.ts';

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
  /** Files the rule matched that the ROOT runner would never pick up — a finding, never an omission. */
  readonly unrunnable: readonly string[];
}

/** The rule, applied. Nothing here is written down: the set is whatever the tree holds today. */
export function discoverS3Suites(root: string): Discovery {
  const matched = new Set<string>();
  const unrunnable: string[] = [];
  for (const file of walk(root, 'tests')) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    const inGoldenDir = file.startsWith(`${S3_GOLDEN_DIR}/`);
    if (!S3_BASENAME.test(base) && !inGoldenDir) continue;
    if (RUNNABLE.test(base)) matched.add(file);
    else if (SUITE_LIKE.test(base) || inGoldenDir) unrunnable.push(file);
  }
  return { suites: [...matched].sort(), unrunnable: unrunnable.sort() };
}

/** The roster the runner is handed: the derived set, plus the one named CI-composition row. */
export function rosterFiles(root: string): string[] {
  return [...new Set([...discoverS3Suites(root).suites, CI_COMPOSITION_SUITE])].sort();
}

/**
 * The derived roster as rows for the P4-S2 executor. `claim` and `proof` are
 * the shape that executor takes; this gate's own evidence for "the claim can
 * go red" is `rosterRedProofProblems` below, which reads the titles out of the
 * file rather than taking a written-down one on trust.
 */
export function rosterRows(root: string): readonly SuiteRow[] {
  return rosterFiles(root).map((file) => ({
    id: file,
    file,
    claim: `a P4-S3 suite discovered by the roster rule: ${file}`,
    proof: file,
  }));
}

/** The derivation, and the two ways it can be wrong: it found nothing, or it found a suite nothing runs. */
export function rosterProblems(root: string): string[] {
  const problems: string[] = [];
  const { suites, unrunnable } = discoverS3Suites(root);
  for (const file of unrunnable)
    problems.push(`${file} matches the P4-S3 roster rule but not the root runner's include (tests/**/*.test.ts) — it would be committed and never executed`);
  // The derived set must have a subject. An empty derivation that reported a
  // pass would be a gate over nothing, which is the defect this slice is
  // correcting.
  if (suites.length === 0)
    problems.push(
      'the P4-S3 roster rule matched no suite — a derived roster with no subject is not a pass (the rule is: a file under tests/ whose basename begins `pos-s3-` or `phase4-pos-`, plus every test file in tests/golden-regression/phase4-s3)',
    );
  if (!has(root, CI_COMPOSITION_SUITE))
    problems.push(`${CI_COMPOSITION_SUITE} is missing — nothing would then assert that this gate is in the required job at all`);
  return problems;
}

/** What the derivation found, printed on a PASS as well as on a FAIL: a roster nobody can read is a roster nobody can audit. */
export function rosterReport(root: string): string {
  const { suites, unrunnable } = discoverS3Suites(root);
  return `${suites.length} derived + 1 named (${CI_COMPOSITION_SUITE}) = ${rosterFiles(root).length} file(s): ${rosterFiles(root).join(', ') || 'none'}${
    unrunnable.length === 0 ? '' : `; ${unrunnable.length} matched file(s) the runner would NOT execute: ${unrunnable.join(', ')}`
  }`;
}

/**
 * Every rostered suite carries a planted-defect proof.
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. A suite with no planted
 * defect asserts something nobody has shown is falsifiable, and the P4-S2
 * roster required a resolvable `RED`/`PLANTED` proof per row for exactly that
 * reason. A DERIVED roster cannot carry a written-down title, so the title is
 * read out of the file: a rostered suite must hold at least one `it(` and at
 * least one whose title announces the planted defect.
 */
export function rosterRedProofProblems(root: string): string[] {
  const problems: string[] = [];
  for (const file of rosterFiles(root)) {
    if (!has(root, file)) {
      problems.push(`${file} is on the roster and does not exist`);
      continue;
    }
    const titles = testTitles(read(root, file));
    if (titles.length === 0) {
      problems.push(`${file} holds no runnable it( title — a file the runner opens and finds nothing in is not evidence`);
      continue;
    }
    if (!titles.some((t) => /\b(?:RED|PLANTED)\b/.test(t)))
      problems.push(
        `${file} has no it( title announcing a planted defect (RED/PLANTED) — a law with no demonstrated red is a law nobody has shown can refuse anything`,
      );
  }
  return problems;
}

// ───── EXECUTION ──────────────────────────────────────────────────────────

/** One execution per root per process: the check reads the verdict, the report line reads the numbers. */
const executions = new Map<string, SuiteExecution>();
export function s3Execution(root: string): SuiteExecution {
  const cached = executions.get(root);
  if (cached !== undefined) return cached;
  // `executeSuites` spawns ONE bounded Vitest run with `stdio: 'pipe'` and
  // reads `status`, `signal` and `error` off the result object. No shell, no
  // pipeline, no `tee`: the verdict cannot come from the last stage of
  // anything. It also refuses a skipped, todo or only-marked test, a run that
  // found no files, and a tally it could not read.
  const fresh = executeSuites(root, rosterRows(root));
  executions.set(root, fresh);
  return fresh;
}

const n = (v: number | null): string => (v === null ? 'unavailable' : String(v));

/** The measured numbers, on a pass as well as on a failure. */
export function executionReport(root: string): string {
  const e = s3Execution(root);
  const exit = e.error !== null ? `did not start (${e.error})` : e.signal !== null ? `killed by ${e.signal}` : e.ran ? `exited ${n(e.status)}` : 'was not run';
  return `${e.claimed} suite(s) claimed → ${e.resolved.length} file(s) resolved; the test process ${exit}; tests: ${n(e.tally.passed)} passed, ${n(e.tally.failed)} failed, ${n(e.tally.skipped)} skipped, ${n(e.tally.todo)} todo of ${n(e.tally.total)} across ${n(e.tally.files)} file(s) reported`;
}

/**
 * `executeSuites` labels its run-level findings `the P4-S2 roster (n file(s))`
 * — the label is a literal inside the predecessor gate (see the finding filed
 * with the coordinator), and that file is not this agent's to change. Relabel
 * here rather than print a P4-S2 verdict out of the P4-S3 gate: a reader who
 * cannot tell which roster refused the tree cannot act on the refusal. The
 * substitution is anchored on the whole label, so it changes nothing else.
 */
const relabel = (problem: string): string => problem.replace(/^the P4-S2 roster \((\d+) file\(s\)\)/, 'the P4-S3 roster ($1 file(s))');

function executionProblems(root: string): string[] {
  const e = s3Execution(root);
  // The roster must not shrink between the derivation and the run: a row that
  // resolved to nothing would otherwise leave the verdict standing on fewer
  // files than the report names.
  const expected = rosterFiles(root);
  const missing = expected.filter((f) => !e.resolved.includes(f));
  return [...e.problems.map(relabel), ...missing.map((f) => `${f} was on the roster and was not handed to the runner`)];
}

// ───── TENSE ──────────────────────────────────────────────────────────────

/**
 * The slices BEHIND this one are accepted, and are asserted in that tense.
 *
 * Both predecessors' `boundaryProblems` are floors, by construction: they
 * require each accepted migration to hash to its accepted digest, the manifest
 * to record that digest, the permanent prefix module to hold the same pairs,
 * and `frozenThrough` to have REACHED the slice head. A manifest frozen
 * further ahead is a later slice doing its job, never a finding here.
 */
export function acceptedTenseProblems(root: string): string[] {
  const problems: string[] = [];
  if (Object.keys(S1_ACCEPTED).length === 0) problems.push('P4-S1 is accepted but S1_ACCEPTED is empty — the predecessor tense cannot be read');
  if (Object.keys(S2_ACCEPTED).length === 0) problems.push('P4-S2 is accepted but S2_ACCEPTED is empty — the predecessor tense cannot be read');
  problems.push(...s1BoundaryProblems(root).map((p) => `P4-S1 boundary: ${p}`));
  problems.push(...s2BoundaryProblems(root).map((p) => `P4-S2 boundary: ${p}`));
  return problems;
}

// ─────────────── CANDIDATE-TENSE (P4-AL-61) ───────────────────────────────
// P4-S3 is OPEN. `0079_phase4_pos_till_sessions_cart.sql` is a CANDIDATE and
// is NOT frozen: only Tech Lead acceptance freezes it. Everything between
// these two markers is the candidate half, and the acceptance commit DELETES
// it — which is why it is fenced, and why `closureRuleProblems` below refuses
// a tree in which `S3_ACCEPTED` is filled and a marker survived.

/**
 * While the slice is open: `S3_ACCEPTED` and `PHASE4_S3_PREFIX` are BOTH
 * empty, because the acceptance commit fills both in one commit and a tree in
 * which only one is filled is a half-done acceptance. No digest of this
 * slice's candidate migration is written down anywhere here, and no name of it
 * either — this function names no migration at all.
 */
export function candidateTenseProblems(root: string): string[] {
  const problems: string[] = [];
  const acceptedHere = Object.keys(S3_ACCEPTED).length;
  if (acceptedHere !== PHASE4_S3_PREFIX.length)
    problems.push(
      `S3_ACCEPTED holds ${acceptedHere} migration(s) and PHASE4_S3_PREFIX holds ${PHASE4_S3_PREFIX.length} — the acceptance commit fills both, so a tree with one of them filled is a half-done acceptance`,
    );
  // The accepted head is READ from the accepted prefix modules, never written
  // down.
  const head = phase4PrefixEnd();
  if (head === null) return [...problems, 'the accepted Phase 4 prefix is empty, so this gate cannot say which migrations are accepted'];
  /**
   * ONLY ACCEPTANCE FREEZES. This says NOTHING about whether a migration past
   * the accepted head exists — that is the closure rule this repository has
   * already had to correct, and a candidate appearing on disk is the slice
   * doing its work. What it says is that while `S3_ACCEPTED` is empty, such a
   * file must not be FROZEN: a manifest entry for it would be an acceptance
   * nobody granted, and `check:migrations` would then treat an unaccepted file
   * as immutable.
   */
  if (acceptedHere === 0) {
    const manifestRel = 'infrastructure/database/MIGRATION_MANIFEST.json';
    if (!has(root, manifestRel)) return [...problems, `${manifestRel} is missing`];
    const manifest = JSON.parse(read(root, manifestRel)) as { migrations?: readonly { readonly name: string }[] };
    for (const entry of manifest.migrations ?? [])
      if (entry.name > head)
        problems.push(
          `${entry.name} is frozen in the manifest and sorts past the last ACCEPTED migration (${head}) while P4-S3 is still a candidate — only Tech Lead acceptance freezes a migration (P4-AL-61)`,
        );
  }
  return problems;
}

// ─────────────── end CANDIDATE-TENSE (P4-AL-61) ───────────────────────────

/** The two shapes a permanent Phase 4 module may never contain, turned on THIS file. */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/\.sql['"`]\s*\)\s*\)?\s*\.length\s*[=!<>]==?\s*\d+/, 'a count of .sql files compared with a literal'],
  [/frozenThrough\s*[=!]==/, 'a frozenThrough equality (it is a floor)'],
];
const stripProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/**
 * The closure rules, composed, plus this gate's own tense.
 *
 * The permanent-module sweep is DELEGATED to the P4-S2 gate, which delegates
 * the P4-S1 half in turn — so the whole accepted chain's closure rules are
 * asserted here without a second copy of any of them. What is added is this
 * file's own two obligations: it contains neither forbidden shape, names no
 * migration numbered past the last ACCEPTED one, and carries its candidate
 * fence while `S3_ACCEPTED` is empty.
 */
export function closureRuleProblems(root: string): string[] {
  const problems = [...predecessorClosureRuleProblems(root)];
  const self = 'scripts/phase4-s3-gate.ts';
  if (!has(root, self)) return [...problems, `${self} is missing`];
  const text = read(root, self);
  const code = stripProse(text);
  for (const [shape, why] of FORBIDDEN)
    if (shape.test(code)) problems.push(`${self} contains ${why} — a permanent invariant never bounds the future (P4-AL-60)`);
  // A gate may name a migration that exists; it may not name one that does
  // not, and it may not digest-pin this slice's candidate. The head is read
  // from the ACCEPTED prefix, so a candidate on disk does not license a name.
  const acceptedHead = Number((phase4PrefixEnd() ?? '0000').slice(0, 4));
  for (const m of code.matchAll(/['"`](\d{4})_[a-z0-9_]+\.sql['"`]/g))
    if (Number(m[1]) > acceptedHead)
      problems.push(
        `${self} names the migration ${m[0]}, which is past the last ACCEPTED migration — a gate does not pin a candidate, and only Tech Lead acceptance freezes one (P4-AL-60/61)`,
      );
  // The FENCE COMMENTS, not every mention: the diagnostics below name the
  // marker too, and a function that counted its own error message would report
  // a surviving fence in the accepted tense for ever.
  const fences = text.split('\n').filter((l) => /^\s*\/\/\s*[─-]+\s*(?:end\s+)?CANDIDATE-TENSE \(P4-AL-61\)/.test(l)).length;
  const candidate = Object.keys(S3_ACCEPTED).length === 0;
  if (candidate && fences < 2)
    problems.push(
      `${self}: the candidate-tense block is not fenced between two "CANDIDATE-TENSE (P4-AL-61)" markers, so the acceptance commit cannot find what to delete`,
    );
  if (!candidate && fences > 0)
    problems.push(`${self}: P4-S3 is accepted and the candidate-tense block is still here — the acceptance commit deletes it (P4-AL-61)`);
  return problems;
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
    id: 'frozen-prefix',
    title: 'the frozen migration prefix, by delegation to the accepted prefix modules',
    run: prefixProblems,
    ok: 'every accepted migration is intact byte for byte at its accepted digest, the manifest records the same digests, and frozenThrough is a floor — nothing is asserted about a candidate numbered past the accepted head',
  },
  {
    id: 'accepted-tense',
    title: 'the slices behind this one, in the ACCEPTED tense (P4-AL-61)',
    run: acceptedTenseProblems,
    ok: 'P4-S1 and P4-S2 both hold their accepted digests, each accepted file still hashes to its accepted digest in the manifest and in the permanent prefix module, and frozenThrough has reached both slice heads',
  },
  {
    id: 'roster',
    title: "P4-S3's suite roster, DERIVED from the tree by one stated rule",
    run: rosterProblems,
    note: rosterReport,
    ok: 'the rule matched at least one suite, every matched file is one the root runner executes, and the CI-composition suite is present',
  },
  {
    id: 'roster-red-proofs',
    title: 'every rostered suite carries a planted-defect proof',
    run: rosterRedProofProblems,
    ok: 'every rostered file holds runnable it( titles and at least one announcing the planted defect its law is proved red on',
  },
  {
    id: 'roster-execution',
    title: "P4-S3's suite roster, EXECUTED",
    run: executionProblems,
    note: executionReport,
    ok: 'every rostered file was handed to one bounded Vitest run whose exit status was read off the spawn result and not through a pipe, the process exited 0 without a signal, it found test files, and nothing failed, skipped or was left todo',
  },
  {
    id: 'closure-and-tense',
    title: "the closure rules, composed, and this gate holding the open slice's candidate tense (P4-AL-60 / P4-AL-61)",
    run: closureRuleProblems,
    ok: 'no permanent module bounds the future, this gate names no migration past the last accepted one and pins no candidate digest, and its candidate-tense block is fenced between the two markers the acceptance commit deletes',
  },
  {
    id: 'candidate-tense',
    title: "P4-S3's own slice state, left as the candidate it is",
    run: candidateTenseProblems,
    ok: 'S3_ACCEPTED and PHASE4_S3_PREFIX are consistent, so acceptance fills both or neither, and this slice freezes nothing before the Tech Lead accepts it',
  },
];

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? rootArg.slice('--root='.length) : join(__dirname, '..');
  const structuralOnly = args.includes('--structural-only');
  // The one RUNTIME check needs a cluster. `--structural-only` suppresses it
  // and the verdict below says it did NOT run, which is not a pass.
  const RUNTIME = new Set(['roster-execution']);
  const checks = structuralOnly ? CHECKS.filter((c) => !RUNTIME.has(c.id)) : CHECKS;
  let failed = 0;
  for (const check of checks) {
    const problems = check.run(root);
    if (problems.length === 0) console.log(`ok   ${check.id} — ${check.title}: ${check.ok}`);
    else {
      failed += 1;
      console.error(`FAIL ${check.id} — ${check.title}\n  ${problems.join('\n  ')}`);
    }
    // The measured numbers, on both branches: a check that reports a tally
    // only when it is happy is a check nobody can audit.
    if (check.note !== undefined) console.log(`     ${check.id} measured: ${check.note(root)}`);
  }
  const skipped = CHECKS.length - checks.length;
  console.log(
    failed === 0
      ? `PASS gate:phase4:s3 at ${root}: ${checks.length} check(s) ok${skipped > 0 ? `; ${skipped} runtime check(s) NOT RUN (--structural-only) — not a pass` : ''}`
      : `FAIL gate:phase4:s3 at ${root}: ${failed} of ${checks.length} check(s) refuse this tree`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
