/**
 * DR-95 boundary 1, as an executed law: THE DEPENDENCY EDGE HAS ONE
 * DIRECTION. Nothing in the merchant's product may import
 * `@daftar/billing`.
 *
 * `packages/billing/test/no-merchant-posting.test.ts` (§16) already states
 * the inward half — billing imports neither the posting engine nor a
 * database client — and it is enforced from INSIDE the package. The outward
 * half had no guard at all: an independent audit planted
 * `import … from '@daftar/billing'` into
 * `apps/api/src/modules/accounting/accounting-posting.adapter.ts` and every
 * suite stayed green, so the direction was prose. This file is the missing
 * half, and it lives at the repository root because that is the only place
 * that can see the files able to break it.
 *
 * Why the direction matters more than the pair of imports: platform billing
 * is not merchant accounting (the owner's ruling behind §16). A merchant
 * module that can reach a subscription ledger can put platform revenue into
 * a merchant's books through code that reads perfectly well in review. The
 * edge is where that becomes possible, so the edge is what reds.
 *
 * Two rules this file obeys deliberately:
 *   - It asserts an ABSENCE, so it carries a positive control: the same
 *     extractor run against `@daftar/accounting` must come back non-empty.
 *     Otherwise a broken extractor reads as a clean repository.
 *   - It counts specifiers, not words. A comment or a string that names the
 *     package (`scripts/check-supply-chain.ts` names it in prose, and this
 *     file names it throughout) is not an edge, and a text law would red on
 *     the documentation of the rule it enforces.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..');

/** Tracked TypeScript files, from git rather than a directory walk, so an
 *  untracked scratch copy can never make this law look dirty or clean. */
function trackedTsFiles(): string[] {
  const out = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '*.ts', '*.tsx'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p.length > 0);
}

/** Module specifiers of `import`/`export … from`, `require()` and dynamic
 *  `import()`. Nothing else is an edge. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

const SELF = 'tests/guards/p5-billing-dependency-direction.test.ts';

/** Every tracked file outside the billing package, with its specifiers. */
const OUTSIDE: ReadonlyArray<readonly [string, readonly string[]]> = trackedTsFiles()
  .filter((p) => !p.startsWith('packages/billing/'))
  .filter((p) => p !== SELF)
  .map((p) => [p, importSpecifiers(readFileSync(join(REPO, p), 'utf8'))] as const);

function importersOf(pkg: string): string[] {
  return OUTSIDE.filter(([, specs]) => specs.some((s) => s === pkg || s.startsWith(`${pkg}/`))).map(([p]) => p);
}

describe('DR-95 boundary 1 — the probe is awake before it is believed', () => {
  it('reads a repository-sized set of tracked files', () => {
    expect(OUTSIDE.length).toBeGreaterThan(200);
  });

  it('extracts specifiers at all, including ones that must be there', () => {
    const all = OUTSIDE.flatMap(([, specs]) => specs);
    expect(all.length).toBeGreaterThan(500);
    expect(all).toContain('vitest');
  });

  /**
   * THE POSITIVE CONTROL. `@daftar/accounting` is the merchant's financial
   * authority and is imported widely, so an empty answer here means the
   * extractor is broken — not that the repository is clean. Without this
   * case the law below could pass on a blind probe.
   */
  it('finds importers of a package that IS imported, so a zero is a measurement', () => {
    const importers = importersOf('@daftar/accounting');
    expect(importers.length, 'the extractor found no importer of @daftar/accounting').toBeGreaterThan(0);
  });
});

describe('DR-95 boundary 1 — nothing outside the package imports @daftar/billing', () => {
  it('no tracked file outside packages/billing carries the edge', () => {
    const offenders = importersOf('@daftar/billing');
    expect(offenders, `these files import @daftar/billing, which reverses the dependency direction DR-95 fixed: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * The package may be DECLARED by the root workspace tooling (the lockfile
   * and `package.json` are not TypeScript and are not edges), but no
   * merchant-side module may declare it as a dependency either. Checked on
   * the manifests, separately from the specifiers above.
   */
  it('no workspace outside the billing lane declares it as a dependency', () => {
    const manifests = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '*/package.json', 'package.json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\0')
      .filter((p) => p.length > 0 && !p.startsWith('packages/billing/') && !p.includes('node_modules/'));
    expect(manifests.length, 'no manifest was read, so this case would pass on nothing').toBeGreaterThan(3);

    const declaring: string[] = [];
    for (const m of manifests) {
      const pkg = JSON.parse(readFileSync(join(REPO, m), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        if (pkg[field] && Object.prototype.hasOwnProperty.call(pkg[field], '@daftar/billing')) {
          declaring.push(`${m} (${field})`);
        }
      }
    }
    expect(declaring, `these manifests declare @daftar/billing: ${declaring.join(', ')}`).toEqual([]);
  });
});
