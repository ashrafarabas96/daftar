import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GHSA-g3hv-75wg-m249 (minimatch globparts amplification, affected
 * `>=7.0.0 <11.0.1`) was closed by ONE `overrides` key in `package.json`, and
 * nothing then held the result.
 *
 * The review of #72 named that precisely (finding 4): the CI audit gate is
 * `npm audit --audit-level=high` and this advisory is MODERATE, so the gate was
 * EXIT 0 while all seven rows were open and would be EXIT 0 again if they came
 * back. The measurement that mattered — "one minimatch, outside the advisory's
 * range" — was taken once, by hand, on one machine. A fact nothing re-measures
 * is a fact about the past.
 *
 * So the lockfile itself is the subject here. This is deliberately a claim
 * about the RANGE, not about the string `11.0.1`: a future 11.1.0, or a 12.x,
 * satisfies the advisory and must not turn this red, while any dependency that
 * reintroduces a 7.x–11.0.0 copy must.
 *
 * It reads `package-lock.json` and not the installed tree, because the lockfile
 * is what CI installs from and what review can see.
 */

const ROOT = join(import.meta.dirname, '..');

interface Lock {
  readonly lockfileVersion: number;
  readonly packages: Record<string, { readonly version?: string; readonly dev?: boolean }>;
}

const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as Lock;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  readonly overrides?: Record<string, string>;
};

/** `1.2.3-rc.1` → `[1, 2, 3]`. A prerelease sorts as its own release here: close enough for a range this wide, and it never under-reports. */
function release(version: string): readonly [number, number, number] {
  const [core = ''] = version.split('-');
  const [major = '0', minor = '0', patch = '0'] = core.split('.');
  return [Number(major), Number(minor), Number(patch)];
}

/** Is `version` inside `>=7.0.0 <11.0.1` — the advisory's own range? */
function isVulnerable(version: string): boolean {
  const [major, minor, patch] = release(version);
  if (major < 7) return false;
  if (major > 11) return false;
  if (major < 11) return true;
  // 11.x: only 11.0.0 and below are affected.
  return minor === 0 && patch < 1;
}

function minimatchEntries(): { readonly path: string; readonly version: string }[] {
  return Object.entries(lock.packages)
    .filter(([path]) => path === 'node_modules/minimatch' || path.endsWith('/node_modules/minimatch'))
    .map(([path, entry]) => ({ path, version: entry.version ?? '' }));
}

describe('npm audit: the minimatch override is held by the lockfile, not by one measurement', () => {
  it('POSITIVE CONTROL: the lockfile is readable and does contain minimatch', () => {
    // Without this, a renamed key, a lockfile format change or a typo in the
    // filter would make every assertion below pass over an empty list and
    // prove nothing at all.
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);
    expect(minimatchEntries().length).toBeGreaterThan(0);
  });

  it('the range check itself is right', () => {
    // The law is only as good as this function; it is asserted, not assumed.
    expect(isVulnerable('7.0.0')).toBe(true);
    expect(isVulnerable('9.0.9')).toBe(true);
    expect(isVulnerable('10.2.6')).toBe(true);
    expect(isVulnerable('11.0.0')).toBe(true);
    expect(isVulnerable('6.2.0')).toBe(false);
    expect(isVulnerable('3.1.5')).toBe(false);
    expect(isVulnerable('11.0.1')).toBe(false);
    expect(isVulnerable('11.1.0')).toBe(false);
    expect(isVulnerable('12.0.0')).toBe(false);
  });

  it('no installed minimatch is inside GHSA-g3hv-75wg-m249 (>=7.0.0 <11.0.1)', () => {
    const inside = minimatchEntries().filter((e) => isVulnerable(e.version));
    // The message carries the paths, because "a dependency brought one back" is
    // only actionable if the reader learns WHICH one without re-deriving it.
    expect(inside.map((e) => `${e.version} at ${e.path}`)).toEqual([]);
  });

  it('the override key is still pinned to an exact version', () => {
    // `scripts/check-supply-chain.ts` enforces this for every override; it is
    // repeated here so this file explains the whole mechanism it protects.
    const key = Object.keys(pkg.overrides ?? {}).find((k) => k.startsWith('minimatch@'));
    expect(key).toBeDefined();
    expect(pkg.overrides?.[key ?? '']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
