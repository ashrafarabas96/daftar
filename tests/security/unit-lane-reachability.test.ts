/**
 * DR-180/7 · THE UNIT LANE IS REACHED BY A REQUIRED JOB — ASSERTED FROM OUTSIDE
 * THAT LANE.
 *
 * WHY THIS FILE IS NOT IN `tests-unit/`, which is where every other law of this
 * cart lives. `ci.yml` has exactly ONE path to the unit lane: the `backend-
 * static` job runs `npm test`, and the LAST link of that `&&` chain is
 * `npm run test:unit`. Measured: `test:unit` and `vitest.unit` appear nowhere
 * else in that workflow but inside a comment. So removing that one link unplugs
 * the whole lane — every law in it, including the one that guards the shipped
 * pre-push hook's execute bit — silently, with `backend-static` still green.
 *
 * AND AN ARM INSIDE A LANE CANNOT WITNESS ITS OWN LANE BEING UNPLUGGED: it does
 * not run either. `tests-unit/pre-push-hook-law.test.ts` reads every link of
 * that path and says so at its site; `tests-unit/test-lane-roster.test.ts:250`
 * asserts the composition and has the same hole. This file is the foot OUTSIDE:
 * it runs under `npm run test:integration` (`ci.yml:532`) inside the `backend`
 * job, which is a required job and is NOT `backend-static` — so it keeps
 * running precisely when the chain it describes is cut.
 *
 * WHERE THE REGRESS STOPS, named so that nobody asks for a guard for the guard:
 * cutting THIS arm's own path means editing `ci.yml` (another lane's file, and
 * serialized), and the roster of required jobs is a repository SETTING that only
 * the owner changes. ONE foot outside the lane is enough; beyond it the
 * protection is the owner's, not a test's.
 *
 * ITS READER IS A PURE FUNCTION over text, and it carries its own copy rather
 * than importing the one in `tests-unit/`: a guard that imported from the lane
 * it guards would be coupled to the thing it is watching. The duplication is
 * deliberate and is the point.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const CI = join(ROOT, '.github', 'workflows', 'ci.yml');
const UNIT_CONFIG = 'vitest.unit.config.ts';

/**
 * The ten required jobs, NAMED and not counted — the roster this project judges
 * a head by. A step in a job nobody requires composes nothing.
 */
const REQUIRED_JOBS = [
  'workspaces',
  'web-admin',
  'android',
  'browser',
  'hygiene',
  'backend-work',
  'backend-static',
  'backend-gates-p2',
  'backend-golden',
  'backend',
] as const;

/** Every broken link between a required CI job and the unit lane; empty means whole. */
function reachabilityProblems(ci: string, scripts: Readonly<Record<string, string>>, unitConfig: string): string[] {
  const problems: string[] = [];
  const lines = ci.split('\n');
  const jobAt = (index: number): string => {
    for (let i = index; i >= 0; i -= 1) {
      const m = /^ {2}([a-z][a-z0-9-]*):$/.exec(lines[i] ?? '');
      if (m?.[1] !== undefined) return m[1];
    }
    return '';
  };
  const composing = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.trim() === 'run: npm test');
  if (!composing.some(({ i }) => REQUIRED_JOBS.includes(jobAt(i) as (typeof REQUIRED_JOBS)[number]))) {
    problems.push('no required job runs `npm test`: the unit lane is composed by nothing in ci.yml');
  }
  if (!(scripts['test'] ?? '').includes('test:unit')) {
    problems.push('the root `test` script does not compose `test:unit`, so the unit lane runs nowhere in CI');
  }
  if (!(scripts['test:unit'] ?? '').includes(UNIT_CONFIG)) {
    problems.push(`\`test:unit\` does not name ${UNIT_CONFIG}`);
  }
  if (!unitConfig.includes("include: ['tests-unit/**/*.test.ts']")) {
    problems.push(`${UNIT_CONFIG} does not include tests-unit/`);
  }
  return problems;
}

describe('DR-180/7: the unit lane is reachable from a required job, measured from another job', () => {
  it('every link from a required job to `tests-unit/**` is whole', () => {
    // THE ARCHIVE CASE, the same early return this cart's setup script carries:
    // the release gate runs a second time inside the extracted archive, which
    // has no `.github/`. There is no workflow to read there and nothing to
    // claim, so the arm says which state it is in rather than failing on an
    // ENOENT that would read like a broken chain.
    if (!existsSync(CI)) {
      expect(existsSync(join(ROOT, 'DELIVERY_MANIFEST.json')), 'ci.yml is missing and this is not a delivered archive either').toBe(true);
      return;
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(
      reachabilityProblems(readFileSync(CI, 'utf8'), pkg.scripts ?? {}, readFileSync(join(ROOT, UNIT_CONFIG), 'utf8')),
      'the unit lane is not reached by any required job',
    ).toEqual([]);
  });

  it('and the reader distinguishes each link — one doctored input per link, differing in ONE respect', () => {
    // WITHOUT THESE the arm above could be a function that answers «whole»
    // about anything. The inputs are TEXT, not seeds: `package.json` and
    // `ci.yml` are read as data here and written by nobody in this lane.
    const goodCi = 'jobs:\n  backend-static:\n    steps:\n      - name: the unit lane\n        run: npm test\n';
    const goodScripts = { test: 'npm run test -w @daftar/web && npm run test:unit', 'test:unit': `vitest run --config ${UNIT_CONFIG}` };
    const goodConfig = "include: ['tests-unit/**/*.test.ts'],";
    expect(reachabilityProblems(goodCi, goodScripts, goodConfig), 'the control inputs are themselves broken, so the arms below measure nothing').toEqual([]);

    // the job is not in the roster — and NOTHING ELSE differs, which is the
    // trap a first version of this control fell into: it named a job that IS
    // required and passed only because its step line was malformed, so it was
    // green for a reason other than the one it claimed.
    expect(reachabilityProblems(goodCi.replace('backend-static:', 'some-optional-job:'), goodScripts, goodConfig)).toEqual([
      'no required job runs `npm test`: the unit lane is composed by nothing in ci.yml',
    ]);
    // THE LINK THIS FILE EXISTS FOR: the chain's last `&&` removed.
    expect(reachabilityProblems(goodCi, { ...goodScripts, test: 'npm run test -w @daftar/web' }, goodConfig)).toEqual([
      'the root `test` script does not compose `test:unit`, so the unit lane runs nowhere in CI',
    ]);
    expect(reachabilityProblems(goodCi, { ...goodScripts, 'test:unit': 'vitest run --config vitest.other.config.ts' }, goodConfig)).toEqual([
      `\`test:unit\` does not name ${UNIT_CONFIG}`,
    ]);
    expect(reachabilityProblems(goodCi, goodScripts, "include: ['tests/**/*.test.ts'],")).toEqual([`${UNIT_CONFIG} does not include tests-unit/`]);
  });

  it('and THIS file is itself reached by a job that is NOT the one it vouches for', () => {
    // The claim above is «a required job runs the unit lane». This arm is the
    // reason to believe the claim is being CHECKED: this file must be composed
    // by a required job OTHER than `backend-static`, or it would die with the
    // chain it describes and prove nothing.
    if (!existsSync(CI)) return;
    const ci = readFileSync(CI, 'utf8');
    const lines = ci.split('\n');
    const jobAt = (index: number): string => {
      for (let i = index; i >= 0; i -= 1) {
        const m = /^ {2}([a-z][a-z0-9-]*):$/.exec(lines[i] ?? '');
        if (m?.[1] !== undefined) return m[1];
      }
      return '';
    };
    const runners = lines
      .map((l, i) => ({ l: l.trim(), i }))
      .filter(({ l }) => l === 'run: npm run test:integration')
      .map(({ i }) => jobAt(i));
    expect(runners, '`npm run test:integration` is run by no job in ci.yml, so this file runs nowhere').not.toEqual([]);
    const outside = runners.filter((j) => REQUIRED_JOBS.includes(j as (typeof REQUIRED_JOBS)[number]) && j !== 'backend-static');
    expect(outside, 'this file is composed by no required job other than `backend-static`, so it has no foot outside the lane it vouches for').not.toEqual([]);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(
      pkg.scripts?.['test:integration'] ?? '',
      '`test:integration` does not name tests/security, so this file is not in the suite that job runs',
    ).toContain('tests/security');
  });
});
