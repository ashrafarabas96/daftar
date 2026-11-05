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

  it('keeps its own runner pin, which is why registration must not align its vitest', () => {
    // Measured on 2026-11-05: aligning `packages/billing` to the repository's
    // vitest (4.1.12) made 25 of its 312 cases refuse by name —
    // `tools/runner-bytes.json` pins 118 rows of the installed runner tree and
    // compares `version` against the lockfile, and `tools/law-bytes.json` pins
    // the sha256 of `packages/billing/package.json` itself. So the package
    // keeps 4.1.11, the lockfile carries a nested runner for it, and the
    // repository carries two vitest versions ON PURPOSE. Re-pinning 118 rows
    // is a change to a sealed byte law, not part of registering a workspace.
    const billing = JSON.parse(read('packages/billing/package.json')) as { devDependencies: Record<string, string> };
    const runnerPin = JSON.parse(read('packages/billing/tools/runner-bytes.json')) as { package: string; version: string };
    expect(runnerPin.package).toBe('vitest');
    expect(billing.devDependencies['vitest']).toBe(runnerPin.version);
    // and the lockfile installs exactly that version for this package
    const lock = read('package-lock.json');
    expect(lock).toContain('"packages/billing/node_modules/vitest"');
    // NEGATIVE CONTROL: the probe is not matching on any version string.
    expect(runnerPin.version).not.toBe('0.0.0-not-a-version');
  });
});
