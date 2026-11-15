import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ق-1 (DR-19): `packages/billing` exists on this branch with 31 test files and
 * its own `vitest.config.ts`, and until this guard was written NOTHING ran
 * them in CI — the package was not a declared workspace, so `npm test` could
 * not reach it, `npm ci` did not link it, and every gate that pins the
 * workspace set listed it nowhere.
 *
 * Reaching CI is not one fact but five, and each is pinned here by file and by
 * line so that removing any one of them is a NAMED failure rather than a
 * silently smaller test estate:
 *
 *   1. `package.json#workspaces` declares the directory  — npm links it.
 *   2. the root `test` script runs `-w @daftar/billing`   — `npm test` at
 *      `.github/workflows/ci.yml` (job `backend`) is what executes it.
 *   3. `package-lock.json` carries the workspace link      — `npm ci` installs it.
 *   4. `ci.yml`'s three "Verify exact workspace set" lists  — the `workspaces`
 *      job fails the build when the declared set and the pinned set disagree.
 *   5. `scripts/phase1-gate.ts`'s `expected` array          — the same law,
 *      measured by the gate rather than by the workflow.
 *
 * Every assertion below reads the file from disk and is paired with a positive
 * control on the same read, because an empty read makes every `toContain`
 * trivially false and every `not.toContain` trivially true (RULE-18).
 */

const ROOT = join(__dirname, '..');
const read = (rel: string): string => {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  // positive control: the probe read something, so a negative result below is
  // a fact about the content and not about an empty buffer.
  expect(text.length).toBeGreaterThan(0);
  return text;
};

interface RootManifest {
  readonly workspaces: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
}

describe('ق-1 — @daftar/billing reaches CI', () => {
  it('is a declared workspace', () => {
    const pkg = JSON.parse(read('package.json')) as RootManifest;
    expect(pkg.workspaces).toContain('packages/billing');
    // NEGATIVE CONTROL: the same probe over a directory that is not a
    // workspace must say so, otherwise `toContain` is passing on anything.
    expect(pkg.workspaces).not.toContain('packages/not-a-workspace');
  });

  it('is run by the root test script, which is what CI invokes', () => {
    const pkg = JSON.parse(read('package.json')) as RootManifest;
    expect(pkg.scripts['test']).toContain('npm run test -w @daftar/billing');
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('run: npm test');
  });

  it('is linked by the lockfile, so npm ci installs it', () => {
    const lock = read('package-lock.json');
    expect(lock).toContain('"node_modules/@daftar/billing"');
    expect(lock).toContain('"packages/billing"');
  });

  it('is in all three workspace-set lists the ci.yml workspaces job pins', () => {
    const ci = read('.github/workflows/ci.yml');
    const lines = ci.split('\n').filter((l) => l.includes('packages/shared-contracts') && l.includes('packages/design-system'));
    // The two shell loops and the node comparison — three enumerations of the
    // set, and a build is only green when the declared set matches all three.
    const pinning = lines.filter((l) => l.includes('packages/domain-core') && l.includes('packages/accounting'));
    expect(pinning.length).toBeGreaterThanOrEqual(3);
    for (const line of pinning) expect(line).toContain('packages/billing');
  });

  it('is in the phase-1 gate expected set', () => {
    const gate = read('scripts/phase1-gate.ts');
    expect(gate).toContain("'packages/billing'");
    // NEGATIVE CONTROL on the same read: the gate does not list a ghost.
    expect(gate).not.toContain("'packages/not-a-workspace'");
  });

  it('keeps its runner pin and the security floor together, with ONE vitest in the tree', () => {
    // THE HISTORY, because this case said the opposite yesterday and the
    // reason it changed is the point. Registration deliberately did NOT align
    // this package's vitest: aligning it to 4.1.12 made 25 of its 312 cases
    // refuse, since `tools/runner-bytes.json` pins the installed runner tree
    // and compares `version` against the lockfile. So the package kept 4.1.11
    // and the lockfile carried a NESTED runner for it.
    //
    // T-10 on main then refused that install by name: `vitest` carries a
    // security-batch floor of 4.1.12 — "the runner these assertions themselves
    // run on" — and T-10's nested-copy rule exists because a nested copy below
    // a floor is how a closed advisory stays live. A sealed byte law does not
    // outrank a security floor; it is re-pinned, which DR-99 built the
    // machinery to do. Measured at the move: the devDependency to 4.1.12
    // removes all EIGHT nested lockfile rows, the tree holds ONE vitest, and
    // the pin is the hoisted runner again at 118 rows.
    const billing = JSON.parse(read('packages/billing/package.json')) as { devDependencies: Record<string, string> };
    const runnerPin = JSON.parse(read('packages/billing/tools/runner-bytes.json')) as { package: string; version: string; lockfile_key: string };
    expect(runnerPin.package).toBe('vitest');
    expect(billing.devDependencies['vitest']).toBe(runnerPin.version);
    // The pin names the hoisted runner, and the lockfile resolves that row to
    // the pinned version — so pin, manifest and lockfile are one fact.
    expect(runnerPin.lockfile_key).toBe('node_modules/vitest');
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> };
    expect(lock.packages[runnerPin.lockfile_key]?.version).toBe(runnerPin.version);
    // THE FLOOR ITSELF, not a version literal: this package may never sit below
    // what `tests/security/t10-upgrade-lock-contract.test.ts` requires, and a
    // nested copy of the runner under this package is the shape T-10 refuses.
    const floors = read('tests/security/t10-upgrade-lock-contract.test.ts');
    const floor = /\['vitest', '([^']+)'/.exec(floors)?.[1];
    expect(floor, 'T-10 no longer declares a vitest floor, so this case is reading nothing').toMatch(/^\d+\.\d+\.\d+$/);
    expect(billing.devDependencies['vitest']).toBe(floor);
    expect(Object.keys(lock.packages).filter((key) => key.startsWith('packages/billing/node_modules/'))).toStrictEqual([]);
    // NEGATIVE CONTROL: the probe is not matching on any version string.
    expect(runnerPin.version).not.toBe('0.0.0-not-a-version');
  });
});
