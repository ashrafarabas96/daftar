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
 *   - It counts `from '…'` / `require('…')` specifiers, not bare mentions of
 *     the package name: `scripts/check-supply-chain.ts` names the package in
 *     prose and is not an edge. The extractor is a REGULAR EXPRESSION over
 *     the file's text, so a specifier spelled inside a comment or a string is
 *     matched like a real one — which is why this file, whose prose contains
 *     the shape, excludes itself below. A narrow review of 2026-11-11 named
 *     the earlier wording ("not words") as wider than what is measured. The
 *     error it can produce is a FALSE RED on a file that documents the edge,
 *     never a false green on a file that crosses it.
 *   - It matches the package by specifier AND by resolved path: a relative
 *     import is resolved against the importing file's own directory first, so
 *     a sibling package's `../../billing/src/*` and an outside caller's
 *     `../../packages/billing/src/*` both reach `packages/billing/` and both
 *     are reported. A confirmation review of 2026-11-11 measured the
 *     unresolved form missing the sibling spelling, which is the likeliest
 *     one. Measured zero today; the check is here so it stays zero.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { deliveredFiles } from '../helpers/delivered-files';

const REPO = join(__dirname, '..', '..');

/**
 * The files the tree claims to consist of, through the repository's own
 * helper: `git ls-files --cached --others --exclude-standard` in a checkout,
 * and `DELIVERY_MANIFEST.json` in an extracted release candidate, which has
 * no git by design (the archive-portability law in
 * `tests/security/archive-portability.test.ts` refuses a test that calls
 * `git` with no manifest branch, and it refused this file's first version).
 *
 * It is the delivered set rather than a directory walk, so an ignored build
 * output cannot make this law look dirty, and an untracked file that carries
 * the edge still reds it.
 */
const DELIVERED = deliveredFiles(REPO);

function trackedTsFiles(): string[] {
  return DELIVERED.filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'));
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
    while ((m = re.exec(source)) !== null) {
      // `noUncheckedIndexedAccess` is on: the group is typed optional even
      // though every pattern above has exactly one capturing group.
      const spec = m[1];
      if (spec !== undefined) specs.push(spec);
    }
  }
  return specs;
}

const SELF = 'tests/guards/p5-billing-dependency-direction.test.ts';

/**
 * Resolve each specifier that is relative against the importing file's own
 * directory, and leave every bare one alone. Without this, `packages/billing/`
 * matches a specifier written from outside `packages/`
 * (`../../packages/billing/src/*`) and misses the likeliest spelling of all —
 * a sibling package writing `../../billing/src/*`, which carries no
 * `packages/` segment (measured 2026-11-11).
 */
function resolveSpecs(file: string, specs: readonly string[]): string[] {
  const dir = posix.dirname(file.split('\\').join('/'));
  return specs.map((s) => (s.startsWith('.') ? posix.normalize(posix.join(dir, s)) : s));
}

/** Every tracked file outside the billing package, with its specifiers. */
const OUTSIDE: ReadonlyArray<readonly [string, readonly string[]]> = trackedTsFiles()
  .filter((p) => !p.startsWith('packages/billing/'))
  .filter((p) => p !== SELF)
  .map((p) => [p, resolveSpecs(p, importSpecifiers(readFileSync(join(REPO, p), 'utf8')))] as const);

type Corpus = ReadonlyArray<readonly [string, readonly string[]]>;

/**
 * The importers of `pkg` in ANY corpus. The corpus is a parameter so the
 * negative controls below can run THIS checker over a planted entry: a law
 * that asserts an absence and has no planted violation to point at is a law
 * nobody has seen say no (the charter's §5, restated by the coordinator on
 * 2026-11-12). Until this round the file carried four positive controls and
 * no negative one.
 */
function importersIn(corpus: Corpus, pkg: string): string[] {
  // `@daftar/billing` and any path that reaches `packages/billing/` are the
  // same source read two ways, so both spellings count as the same edge.
  const dir = `packages/${pkg.replace('@daftar/', '')}/`;
  return corpus.filter(([, specs]) => specs.some((s) => s === pkg || s.startsWith(`${pkg}/`) || s.includes(dir))).map(([p]) => p);
}

function importersOf(pkg: string): string[] {
  return importersIn(OUTSIDE, pkg);
}

/** One corpus entry built the way the real one is: text in, specifiers out. */
function entry(file: string, source: string): readonly [string, readonly string[]] {
  return [file, resolveSpecs(file, importSpecifiers(source))] as const;
}

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** Every manifest in `manifests` that declares `pkg`, named with its field. */
function declarersIn(manifests: ReadonlyArray<readonly [string, Manifest]>, pkg: string): string[] {
  const declaring: string[] = [];
  for (const [name, pkgJson] of manifests) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const section = pkgJson[field];
      if (section && Object.prototype.hasOwnProperty.call(section, pkg)) declaring.push(`${name} (${field})`);
    }
  }
  return declaring;
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

describe('DR-95 boundary 1 — a relative spelling is the same edge', () => {
  /**
   * MEASURED on 2026-11-11, in a confirmation review: matching the literal
   * `packages/billing/` catches a specifier written from outside `packages/`
   * (`../../packages/billing/src/*`) and MISSES the likeliest spelling of
   * all — a sibling package writing `../../billing/src/*`, which carries no
   * `packages/` segment. The specifiers are therefore resolved against the
   * importing file's own directory before they are matched.
   */
  it('resolves a sibling-package relative import to the package it reaches', () => {
    const resolved = resolveSpecs('packages/accounting/src/platform-credit.ts', [
      '../../billing/src/credit',
      '../../packages/billing/src/credit',
      './local-helper',
      '@daftar/billing',
      'vitest',
    ]);
    expect(resolved.filter((s) => s.includes('packages/billing/')).length, 'a relative edge went unresolved').toBe(2);
    expect(resolved, 'a bare package specifier must survive untouched').toContain('@daftar/billing');
    expect(resolved, 'a bare dependency must survive untouched').toContain('vitest');
    expect(resolved, 'a same-directory import must stay inside its own package').toContain('packages/accounting/src/local-helper');
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
    const manifests = DELIVERED.filter(
      (p) => (p === 'package.json' || p.endsWith('/package.json')) && !p.startsWith('packages/billing/') && !p.includes('node_modules/'),
    );
    expect(manifests.length, 'no manifest was read, so this case would pass on nothing').toBeGreaterThan(3);

    const read = manifests.map((m) => [m, JSON.parse(readFileSync(join(REPO, m), 'utf8')) as Manifest] as const);
    const declaring = declarersIn(read, '@daftar/billing');
    expect(declaring, `these manifests declare @daftar/billing: ${declaring.join(', ')}`).toEqual([]);
  });
});

describe('DR-95 boundary 1 — the law says no to a planted edge (the negative controls)', () => {
  /**
   * The audit that created this law planted exactly this import into exactly
   * this file and every suite stayed green. The plant is a STRING here and
   * never on disk, so nothing restores it and DR-09 is untouched.
   */
  it('NEGATIVE CONTROL: a bare `@daftar/billing` import from a merchant module is reported', () => {
    const planted = entry(
      'apps/api/src/modules/accounting/accounting-posting.adapter.ts',
      ["import { Injectable } from '@nestjs/common';", "import { subscriptionLedger } from '@daftar/billing';", 'export const x = subscriptionLedger;'].join(
        '\n',
      ),
    );
    expect(planted[1], 'the extractor read no specifier out of the plant, so this control proves nothing').toContain('@daftar/billing');
    const reported = importersIn([planted], '@daftar/billing');
    expect(reported, 'the checker missed a bare @daftar/billing import').toEqual([planted[0]]);
  });

  it('NEGATIVE CONTROL: the sibling relative spelling is reported through the same checker', () => {
    const planted = entry(
      'packages/accounting/src/platform-credit.ts',
      ["import { credit } from '../../billing/src/credit';", 'export const y = credit;'].join('\n'),
    );
    expect(
      planted[1].some((spec) => spec.includes('packages/billing/')),
      'the plant did not resolve into the package, so this control proves nothing',
    ).toBe(true);
    const reported = importersIn([planted], '@daftar/billing');
    expect(reported, 'the checker missed a resolved sibling import').toEqual([planted[0]]);
  });

  it('NEGATIVE CONTROL: a manifest declaring the package is reported, with its field', () => {
    const reported = declarersIn([['apps/api/package.json', { dependencies: { '@daftar/billing': 'workspace:*' } }]], '@daftar/billing');
    expect(reported, 'the checker missed a declared dependency').toEqual(['apps/api/package.json (dependencies)']);
  });

  it('NO FALSE RED: a package whose name merely STARTS with the name is not the edge', () => {
    // `@daftar/billingx` is a different package, and a law that reports it
    // turns a clean tree red on shared property. The matcher's own shape is
    // what makes this hold (`===` or `pkg + '/'`), so it is asserted rather
    // than assumed.
    const planted = entry('apps/web/src/pages/plans.ts', ["import { ui } from '@daftar/billingx';", 'export const z = ui;'].join('\n'));
    expect(planted[1], 'the plant carries no specifier at all').toContain('@daftar/billingx');
    expect(importersIn([planted], '@daftar/billing'), 'a different package was reported as the edge').toEqual([]);
    expect(
      declarersIn([['apps/web/package.json', { dependencies: { '@daftar/billingx': '1.0.0' } }]], '@daftar/billing'),
      'a different package was reported as declared',
    ).toEqual([]);
  });
});
