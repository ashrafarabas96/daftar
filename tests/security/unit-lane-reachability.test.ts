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
 * it runs under `npm run test:integration` (`ci.yml:532`), in the job whose YAML
 * KEY is `backend` and whose declared CHECK NAME is `backend-work` — a required
 * check, and not `backend-static`, which is where the unit lane runs
 * (`ci.yml:2103`) — so it keeps running precisely when the chain it describes
 * is cut.
 *
 * THE KEY AND THE CHECK NAME ARE SPELLED OUT SEPARATELY, because saying «the
 * `backend` job» names two different things here: the required check called
 * `backend` is produced by the key `backend-required`, which runs no tests at
 * all. Conflating them is this cart's confirmation-round finding, and it was in
 * this header too.
 *
 * WHERE THE REGRESS STOPS, with the number rather than a gesture at it. Measured
 * on 2026-11-24 from `repos/ashrafarabas96/daftar/branches/main/protection`:
 * the required checks are TEN, by name — `workspaces`, `backend`, `web-admin`,
 * `android`, `browser`, `hygiene`, `backend-work`, `backend-gates-p2`,
 * `backend-golden`, `backend-static` — with `strict: true` and
 * `enforce_admins: true`. So `backend` really is required in the SETTINGS and
 * not merely defined in the workflow, and the roster written below matches the
 * live one with zero drift on that date.
 *
 * AND ABOVE THAT ROSTER NO TEST GUARDS ANYTHING, which is the honest end of the
 * chain: changing a repository setting reddens nothing, because a setting is not
 * a file any suite reads. What holds there is `enforce_admins: true` and the
 * owner's own discipline. ONE foot outside the lane is where a test's custody
 * ends; pretending otherwise would be the same «presence is not a seal» mistake
 * this cart has now made twice.
 *
 * ITS READER IS A PURE FUNCTION over text, and it carries its own copy rather
 * than importing the one in `tests-unit/` — the reason is written at the
 * function itself, where a reviewer tempted to «simplify» the copy away will
 * actually read it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const CI = join(ROOT, '.github', 'workflows', 'ci.yml');
const UNIT_CONFIG = 'vitest.unit.config.ts';

/**
 * The ten required CHECKS, NAMED and not counted — the roster this project
 * judges a head by, measured from `branches/main/protection`. A step in a job
 * nobody requires composes nothing.
 *
 * AND A CHECK NAME IS NOT A JOB KEY, which is the blocking finding of this
 * cart's confirmation round and the reason `checkNameOf` exists below. This
 * roster was being compared against the YAML KEY of the job holding a step, and
 * the two spaces are not the same: measured on this file's own head, the key
 * `backend` carries `name: backend-work`, while the required check named
 * `backend` is produced by the key `backend-required` — which runs no tests at
 * all. So `backend` matched as a COINCIDENCE (another job's check name),
 * `backend-work` could never match any key, and `backend-required` was absent.
 * The arm's conclusion was true and its mechanism could not reach it.
 *
 * Adjusting this list alone would have left that defect with better data, so
 * the key→name map is resolved explicitly instead.
 */
const REQUIRED_CHECKS = [
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

/**
 * The CHECK NAME of the job containing line `index`: the job's own `name:` when
 * it declares one, else its YAML key — which is exactly how GitHub names a
 * check. This is the map the confirmation round demanded be made explicit; a
 * membership test against one list cannot express it, because the key space and
 * the check-name space overlap without being equal.
 */
function checkNameOf(lines: readonly string[], index: number): string {
  let keyLine = -1;
  let key = '';
  for (let i = index; i >= 0; i -= 1) {
    const m = /^ {2}([a-z][a-z0-9-]*):$/.exec(lines[i] ?? '');
    if (m?.[1] !== undefined) {
      keyLine = i;
      key = m[1];
      break;
    }
  }
  if (keyLine === -1) return '';
  // forward to the next job key, looking for this job's own `name:`
  for (let i = keyLine + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z][a-z0-9-]*:$/.test(lines[i] ?? '')) break;
    const n = /^ {4}name: (\S.*)$/.exec(lines[i] ?? '');
    if (n?.[1] !== undefined) return n[1].trim();
  }
  return key;
}

/**
 * Every broken link between a required CI job and the unit lane; empty means
 * whole.
 *
 * DO NOT REPLACE THIS WITH AN IMPORT FROM `tests-unit/`. It is a near-copy of
 * the reader in `tests-unit/pre-push-hook-law.test.ts` and the duplication is
 * the mechanism, not an oversight: this file exists to keep running when the
 * unit lane is unplugged, and importing from that lane would couple the guard
 * to the very thing it is watching — delete or move that file and this one
 * stops running too, exactly when it is needed. The line is here, at the site,
 * because a reviewer who found only a note in the header would reasonably
 * «simplify» the copy away and restore the coupling.
 */
function reachabilityProblems(ci: string, scripts: Readonly<Record<string, string>>, unitConfig: string): string[] {
  const problems: string[] = [];
  const lines = ci.split('\n');
  const composing = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.trim() === 'run: npm test');
  if (!composing.some(({ i }) => REQUIRED_CHECKS.includes(checkNameOf(lines, i) as (typeof REQUIRED_CHECKS)[number]))) {
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

    // AND THE KEY/NAME DISTINCTION ITSELF, which is what the confirmation round
    // found missing. Two doctored inputs, each differing from a whole one in
    // that ONE respect, because a roster compared against the wrong space
    // cannot be tested by data that happens to agree:
    //
    //   a REQUIRED key whose `name:` is NOT a required check → refused
    const renamed = 'jobs:\n  backend-static:\n    name: some-optional-check\n    steps:\n      - name: the unit lane\n        run: npm test\n';
    expect(
      reachabilityProblems(renamed, goodScripts, goodConfig),
      'a job keyed like a required one but NAMED otherwise was accepted — the key is being read as the check',
    ).toEqual(['no required job runs `npm test`: the unit lane is composed by nothing in ci.yml']);
    //   a key that is NOT a required check whose `name:` IS one → accepted.
    //   This is the real shape in this repository: the key `backend` carries
    //   `name: backend-work`.
    const aliased = 'jobs:\n  not-a-required-key:\n    name: backend-work\n    steps:\n      - name: the unit lane\n        run: npm test\n';
    expect(
      reachabilityProblems(aliased, goodScripts, goodConfig),
      'a job whose declared NAME is a required check was refused — the name is not being read',
    ).toEqual([]);
  });

  it('and THIS file is itself reached by a job that is NOT the one it vouches for', () => {
    // The claim above is «a required job runs the unit lane». This arm is the
    // reason to believe the claim is being CHECKED: this file must be composed
    // by a required job OTHER than `backend-static`, or it would die with the
    // chain it describes and prove nothing.
    // AND IT READS THE CHECK NAME, NOT THE KEY. The first form of this arm
    // compared keys against the roster of check names and PASSED on a
    // coincidence: the key running this suite is `backend`, and `backend` is in
    // the roster as the check name of a DIFFERENT job (`backend-required`,
    // which runs no tests). Measured on this head, the only two jobs declaring
    // their own name are `backend` → `backend-work` and `backend-required` →
    // `backend`, so the two spaces overlap without being equal — and that
    // overlap was the whole of the old arm's evidence.
    if (!existsSync(CI)) return;
    const ci = readFileSync(CI, 'utf8');
    const lines = ci.split('\n');
    const runners = lines
      .map((l, i) => ({ l: l.trim(), i }))
      .filter(({ l }) => l === 'run: npm run test:integration')
      .map(({ i }) => checkNameOf(lines, i));
    expect(runners, '`npm run test:integration` is run by no job in ci.yml, so this file runs nowhere').not.toEqual([]);
    // THE MAP, ASSERTED AS A MAP: this suite's job declares the check name
    // `backend-work`, and that name is in the required roster.
    expect(runners, 'the job composing this suite no longer declares the check name this arm was written against').toContain('backend-work');
    const outside = runners.filter((j) => REQUIRED_CHECKS.includes(j as (typeof REQUIRED_CHECKS)[number]) && j !== 'backend-static');
    expect(outside, 'this file is composed by no required CHECK other than `backend-static`, so it has no foot outside the lane it vouches for').not.toEqual(
      [],
    );
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(
      pkg.scripts?.['test:integration'] ?? '',
      '`test:integration` does not name tests/security, so this file is not in the suite that job runs',
    ).toContain('tests/security');
  });
});
