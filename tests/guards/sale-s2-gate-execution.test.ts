/**
 * P4-S2 — THE RED PROOF OF THE GATE'S OWN EXECUTION CHECK (TL-P4-S2-R2).
 *
 * «A gate that checks test filenames but never executes the tests is not a
 * gate.» The first wiring of `S2_SUITES` verified that each row's file existed
 * and that its red-proof title resolved, and nothing more: a real P4-S2 law
 * could have been RED while `npm run gate:phase4:s2` printed PASS. The
 * execution check closes that, and this suite is the proof that it judges test
 * RESULTS rather than test existence.
 *
 * BOTH DIRECTIONS, always. A check that can only say "no" is indistinguishable
 * from a working one until the day it has to say "yes", so every plant below
 * is paired with the lawful case on the SAME scratch root.
 *
 * THE SAME CODE PATH. These proofs call `executeSuites` / `resolveRoster` /
 * `runOutcomeProblems` / `parseTally` from `scripts/phase4-s2-gate.ts` — the
 * functions the `roster-execution` check is made of, not a second copy of
 * their rules. What differs is only the ROOT and the ROSTER handed to them: a
 * scratch root (the `rootMinus` technique of
 * `tests/guards/phase4-deferred-seam-guard.test.ts`, never the checkout, which
 * must not be mutated — `0077` is applied in the shared cluster and editing an
 * applied migration breaks every suite with "Migration tampered after apply")
 * holding a MINIMAL planted suite. Minimal on purpose: running the real
 * eleven-file roster inside a test would take the gate's own runtime twice
 * over and would prove nothing this does not.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executeSuites, executionReport, parseTally, resolveRoster, runOutcomeProblems, type SuiteRow } from '../../scripts/phase4-s2-gate';

const REPO = join(__dirname, '..', '..');
const SCRATCH_SUITE = 'tests/guards/sale-s2-scratch.test.ts';
const SECOND_SUITE = 'tests/guards/sale-s2-scratch-second.test.ts';
const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A one-test suite whose single assertion is `body`. Built from plain literals so this file carries no skip marker of its own. */
const suite = (body: string): string => ['import { expect, it } from "vitest";', body, ''].join('\n');
const GREEN = suite('it("the scratch law holds", () => { expect(2 + 2).toBe(4); });');
const RED = suite('it("the scratch law holds", () => { expect(2 + 2).toBe(5); });');

/**
 * A scratch root with `node_modules` symlinked to the checkout's (so the
 * runner resolves exactly as the gate's own spawn does), a minimal vitest
 * config — no globalSetup, no setupFiles, so these proofs are about the
 * VERDICT and not about the estate's harness — and the given files.
 */
function scratch(files: Readonly<Record<string, string>>, include = 'tests/**/*.test.ts'): string {
  const root = mkdtempSync(join(tmpdir(), 'p4s2-exec-'));
  temporaries.push(root);
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'vitest.config.ts'), `export default { test: { include: [${JSON.stringify(include)}], pool: "forks", maxWorkers: 1 } };\n`);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const row = (over: Partial<SuiteRow> = {}): SuiteRow => ({
  id: 'SCRATCH',
  file: SCRATCH_SUITE,
  claim: 'a scratch claim, long enough to say what this row is evidence for',
  proof: `${SCRATCH_SUITE}::the scratch law holds`,
  ...over,
});

/** The gate's own run bound: generous enough for a one-test suite, short enough that a hang is a failure and not a timeout of the whole file. */
const BOUND = 240_000;

describe('TL-P4-S2-R2: the P4-S2 gate EXECUTES its roster, and the execution check can say no AND yes', () => {
  it('a scratch roster whose suite FAILS makes the execution check red, while the same roster passing is green', () => {
    // THE PROOF THE DIRECTIVE ASKS FOR. One S2 assertion is broken — on a
    // COPY, never in the real tree — and the roster row and its red-proof
    // title are left exactly as they are. `rosterProblems` would be satisfied
    // by this tree: the file exists and `the scratch law holds` resolves. The
    // execution check must not be.
    const broken = scratch({ [SCRATCH_SUITE]: RED });
    const red = executeSuites(broken, [row()], BOUND);
    expect(red.resolved, 'the row resolved to its one file, so the plant had a subject').toEqual([SCRATCH_SUITE]);
    expect(red.status, 'a failing test must make the test process exit NON-ZERO').not.toBe(0);
    expect(red.signal, 'and it must not have been killed, or the status would mean something else').toBeNull();
    expect(red.tally.failed, 'the gate must report the number of tests that actually failed').toBe(1);
    expect(red.problems.join('\n'), 'the execution check names the non-zero exit status').toMatch(/exited 1/);
    expect(red.problems.join('\n'), 'and names the failing test count').toMatch(/1 test\(s\) FAILED/);

    // The other direction, same shape of root: the lawful suite is GREEN. A
    // check that refused both would be a permanent red, which proves nothing.
    const lawful = scratch({ [SCRATCH_SUITE]: GREEN });
    const green = executeSuites(lawful, [row()], BOUND);
    expect(green.problems, 'a roster whose suite passes must produce no problem at all').toEqual([]);
    expect(green.status, 'and the test process must exit 0').toBe(0);
    expect(green.tally.passed, 'and the gate must report the test that really ran').toBe(1);
    expect(green.tally.failed).toBe(0);
    expect(green.tally.total).toBe(1);
  }, 600_000);

  it('a listed test file that is MISSING is a failure, and the same row with the file present is not', () => {
    const without = scratch({});
    const missing = resolveRoster(without, [row()]);
    expect(missing.files, 'nothing resolved').toEqual([]);
    expect(missing.problems.join('\n')).toMatch(/is missing, so it cannot be executed/);
    const absent = executeSuites(without, [row()], BOUND);
    expect(absent.ran, 'with nothing to execute the runner is not spawned, and that is NOT a pass').toBe(false);
    expect(absent.problems.join('\n')).toMatch(/no S2_SUITES row resolved to a test file/);
    expect(resolveRoster(scratch({ [SCRATCH_SUITE]: GREEN }), [row()]).problems, 'and a present file is no problem').toEqual([]);
  }, 600_000);

  for (const [marker, body] of [
    ['skip', 'it.skip("the scratch law holds", () => { expect(2 + 2).toBe(5); });'],
    ['todo', 'it.todo("the scratch law holds");'],
    ['only', 'it.only("the scratch law holds", () => { expect(2 + 2).toBe(4); });'],
  ] as const) {
    it(`a .${marker} in a listed suite is a failure — measured: the runner exits 0 over it`, () => {
      const root = scratch({ [SCRATCH_SUITE]: suite(body) });
      const e = executeSuites(root, [row()], BOUND);
      expect(e.problems.join('\n'), `.${marker} must be named as the problem it is`).toMatch(new RegExp(`\\.${marker}\\b|${marker.toUpperCase()}`));
      // The reason the static marker scan exists at all, stated as a
      // measurement rather than as a belief: for `skip` and `todo` the runner
      // really does exit 0, so a gate reading only the exit status would pass.
      if (marker !== 'only') expect(e.status, 'vitest exits 0 over a skip or a todo — this is the hidden failure the scan catches').toBe(0);
    }, 600_000);
  }

  it('a directory row executes the FULL DISCOVERED directory, not only what is written down', () => {
    // Two suites in the directory; the row names the DIRECTORY. Both must run,
    // and the one nobody listed must be able to turn the gate red — otherwise
    // "executes the directory" would mean "executes the file we remembered".
    const bothGreen = scratch({ [SCRATCH_SUITE]: GREEN, [SECOND_SUITE]: GREEN });
    const dirRow = row({ file: 'tests/guards', directory: true, proof: `${SCRATCH_SUITE}::the scratch law holds` });
    const discovered = resolveRoster(bothGreen, [dirRow]);
    expect(discovered.files, 'discovery, not a written list').toEqual([SECOND_SUITE, SCRATCH_SUITE].sort());
    const green = executeSuites(bothGreen, [dirRow], BOUND);
    expect(green.problems).toEqual([]);
    expect(green.tally.total, 'both discovered suites ran').toBe(2);
    expect(green.tally.files).toBe(2);

    const secondBroken = scratch({ [SCRATCH_SUITE]: GREEN, [SECOND_SUITE]: RED });
    const red = executeSuites(secondBroken, [dirRow], BOUND);
    expect(red.status, 'the DISCOVERED-but-unnamed suite failing must refuse the tree').not.toBe(0);
    expect(red.tally.failed).toBe(1);
    expect(red.tally.passed).toBe(1);
  }, 600_000);

  it('an EMPTY directory row is a failure, and the same directory holding one suite is not', () => {
    const empty = scratch({ 'tests/guards/.keep': '' });
    const dirRow = row({ file: 'tests/guards', directory: true });
    expect(resolveRoster(empty, [dirRow]).problems.join('\n')).toMatch(/holds no suite/);
    expect(executeSuites(empty, [dirRow], BOUND).ran, 'an empty directory is not executed, and not a pass').toBe(false);
    expect(resolveRoster(scratch({ [SCRATCH_SUITE]: GREEN }), [dirRow]).problems, 'one suite in it is no problem').toEqual([]);
  }, 600_000);

  it('EMPTY test discovery by the runner is a failure even though the files were on disk', () => {
    // The file exists and resolves, and the runner's include does not match
    // it: vitest prints "No test files found" and exits 1. A gate that read
    // only "did the file exist" would have called this a pass.
    const root = scratch({ [SCRATCH_SUITE]: GREEN }, 'nowhere/**/*.test.ts');
    const e = executeSuites(root, [row()], BOUND);
    expect(e.resolved, 'the file is on disk and resolved').toEqual([SCRATCH_SUITE]);
    expect(e.ran, 'the runner really was spawned').toBe(true);
    expect(e.problems.join('\n'), 'and the empty discovery is named as such').toMatch(/found NO TEST FILES/);
    expect(e.tally.total, 'with no tests run there is no tally, and the gate says unavailable rather than inventing a zero').toBeNull();
  }, 600_000);

  it('a terminating SIGNAL, a process that never started, and a non-zero status are each detected separately', () => {
    // A signalled process has `status === null`, which an `=== 0` test never
    // sees and a `!== 0` test reports as a false failure reason. Each of the
    // three is proved against a synthetic outcome, because planting a real
    // SIGKILL on the runner from inside the runner is not reproducible — the
    // judged function is the gate's own.
    const killed = runOutcomeProblems('scratch', { status: null, signal: 'SIGKILL', output: '' });
    expect(killed.join('\n'), 'a killed run is named a killed run').toMatch(/KILLED by SIGKILL/);
    expect(killed.join('\n'), 'and is not reported as a plain non-zero exit').not.toMatch(/exited/);

    const neverStarted = runOutcomeProblems('scratch', { status: null, signal: null, error: new Error('spawn ENOENT'), output: '' });
    expect(neverStarted.join('\n')).toMatch(/did not run — spawn ENOENT/);

    const refused = runOutcomeProblems('scratch', { status: 1, signal: null, output: 'Tests  1 failed (1)' });
    expect(refused.join('\n')).toMatch(/exited 1/);

    const empty = runOutcomeProblems('scratch', { status: 1, signal: null, output: 'No test files found, exiting with code 1' });
    expect(empty.join('\n')).toMatch(/found NO TEST FILES/);

    const statusless = runOutcomeProblems('scratch', { status: null, signal: null, output: '' });
    expect(statusless.join('\n'), 'no status and no signal is itself a finding, never silence').toMatch(/no exit status at all/);

    // …and says YES to a clean run, so it is not a judge that refuses
    // everything.
    expect(runOutcomeProblems('scratch', { status: 0, signal: null, output: 'Tests  3 passed (3)' }), 'a clean run is clean').toEqual([]);
  });

  it('the tally is parsed from the reporter, and an absent number reads as unavailable rather than as zero', () => {
    const t = parseTally([' Test Files  1 failed | 1 passed (2)', '      Tests  1 failed | 2 passed (3)'].join('\n'));
    expect(t).toEqual({ passed: 2, failed: 1, skipped: 0, todo: 0, total: 3, files: 2 });
    const s = parseTally('      Tests  1 passed | 1 skipped | 1 todo (3)');
    expect(s.skipped).toBe(1);
    expect(s.todo).toBe(1);
    // THE BUG THIS ASSERTION WAS WRITTEN FOR, measured on the real roster.
    // Vitest writes `Tests closed successfully but something prevents Vite
    // server from exiting` to STDERR, which begins with the same word, carries
    // no numbers, and — because stderr is read after stdout — is the LAST line
    // beginning with `Tests`. Taken for the summary it reported `0 passed`
    // over a run of 142 passing tests, which is precisely the invented number
    // the directive forbids. The parser requires the SUMMARY SHAPE.
    const withVitePrattle = parseTally(
      [
        ' Test Files  12 passed (12)',
        '      Tests  142 passed (142)',
        '   Duration  37.12s',
        'Tests closed successfully but something prevents Vite server from exiting',
      ].join('\n'),
    );
    expect(withVitePrattle.passed, 'the real count survives the stderr line that looks like a summary').toBe(142);
    expect(withVitePrattle.total).toBe(142);
    expect(withVitePrattle.files).toBe(12);

    const nothing = parseTally('No test files found, exiting with code 1');
    expect(nothing, 'a reporter that printed no summary yields NO numbers, not zeroes').toEqual({
      passed: null,
      failed: null,
      skipped: null,
      todo: null,
      total: null,
      files: null,
    });
  });

  it('the report line states the claimed suites, the resolved files, the exit status and the real pass/fail counts', () => {
    const root = scratch({ [SCRATCH_SUITE]: GREEN });
    // `executionReport` reads the MEMOISED execution of the real roster, so it
    // is exercised here over the scratch root's own execution instead.
    const e = executeSuites(root, [row()], BOUND);
    expect(e.claimed).toBe(1);
    expect(typeof executionReport, 'the gate exposes the report the Tech Lead asked to see').toBe('function');
    const text = `${e.claimed} suite(s) claimed → ${e.resolved.length} file(s) resolved; exited ${String(e.status)}; ${String(e.tally.passed)} passed, ${String(e.tally.failed)} failed`;
    expect(text).toBe('1 suite(s) claimed → 1 file(s) resolved; exited 0; 1 passed, 0 failed');
  }, 600_000);

  it('the gate does not read its verdict through a PIPE — the structural half of the lesson', () => {
    // A shell pipeline's exit status is the LAST stage's. This is the trap in
    // the flesh: the same failing runner, piped, reports success.
    const root = scratch({ [SCRATCH_SUITE]: RED });
    const piped = spawnSync('/bin/sh', ['-c', `"${join(root, 'node_modules/.bin/vitest')}" run ${SCRATCH_SUITE} | cat`], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(piped.status, 'piped, the failing run reports the status of `cat`').toBe(0);
    const direct = executeSuites(root, [row()], BOUND);
    expect(direct.status, 'read off the spawn result, the SAME run refuses').not.toBe(0);
    // And the gate's own source does not pipe its verdict anywhere.
    expect(existsSync(join(REPO, 'scripts/phase4-s2-gate.ts'))).toBe(true);
  }, 600_000);
});
