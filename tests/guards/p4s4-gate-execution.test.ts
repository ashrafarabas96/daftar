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
import { CI_COMPOSITION_SUITE, discoverS4Suites, rosterFiles, rosterProblems, rosterRedProofProblems, rosterRows } from '../../scripts/phase4-s4-gate';

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
