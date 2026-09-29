#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 3 REVIEW INDEX — `npm run index:phase3:review` / `npm run check:phase3:review-index`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * PR #4 carries every Phase 3 change. The Tech Lead's directive §17 asks for a
 * reviewer's map of it, not a smaller history: for every file Phase 3 changed,
 * its owning slice, purpose, first accepted checkpoint, security relevance and
 * the tests that protect it, grouped by layer, with tests and documentation
 * listed separately. This script writes that map to
 * `docs/PHASE_3_REVIEW_INDEX.md` and checks it.
 *
 * THE INDEX IS A REVIEW AID, NOT A SOURCE OF TRUTH
 *
 * Every cell is derived by a rule stated in the generated page (and below).
 * The only hand-written text is the curated purpose of a file whose header
 * and commit subject say too little; it lives in
 * `scripts/phase3-review-index.curated.json`, never in the generated page.
 *
 * WHAT `--check` REFUSES
 *
 *   - the page is missing;
 *   - a row names a path that no longer exists;
 *   - a path Phase 3 changed has no row, or a row names a path Phase 3 did not change;
 *   - a row, or any other line, differs from what the generator writes now (stale);
 *   - a curated purpose names a path that has no row.
 *
 * WHERE THERE IS NO HISTORY
 *
 * Slice, checkpoint and the set of changed paths come from git history back
 * to the Phase 2 merge. The release archive has no `.git`, and a shallow CI
 * checkout does not reach the base. There the check says so and checks what
 * the tree alone decides: every row's path exists, and each row's group,
 * security relevance and protecting tests are what the tree gives now. It
 * never reports a full check it did not make.
 *
 * Usage:
 *   npm run index:phase3:review               # regenerate the page (needs full history)
 *   npm run check:phase3:review-index         # fail on a stale page
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, posix, relative, sep } from 'node:path';

const ROOT = join(__dirname, '..');

/** The Phase 2 merge into main: Phase 3 is everything after it. */
export const PHASE3_BASE = '0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f';
/**
 * The sealed Phase 3 head that PR #4 merged into main, the same commit as
 * `PHASE3_HEAD` in scripts/phase3-secret-scan.ts. Once HEAD contains it, the
 * Phase 3 history ends there (see `mainlineHead`).
 */
export const PHASE3_HEAD = 'dd59962c2e53119d5cd5dea0d44df5d2f207a512';
export const INDEX_PATH = 'docs/PHASE_3_REVIEW_INDEX.md';
export const CURATED_PATH = 'scripts/phase3-review-index.curated.json';
export const REGENERATE_COMMAND = 'npm run index:phase3:review';
export const CHECK_COMMAND = 'npm run check:phase3:review-index';

/** The slice freeze/acceptance commits, in order (directive §17). */
export const CHECKPOINTS: readonly { readonly sha: string; readonly slice: string; readonly label: string }[] = [
  { sha: '61b89d6511ff06164b511e4f0598806306acd5f4', slice: 'P3-S1', label: 'S1 closure' },
  { sha: '57a5a7fabccd678943d108da3a881e5e5d7fc3cd', slice: 'P3-S2', label: 'S2 freeze' },
  { sha: 'fecbecb9013c145cd0fa77cc1c3e3a752684205d', slice: 'P3-S3', label: 'S3 freeze' },
  { sha: '43b83707e333965e1b39f0b67ee29cc74702ec5e', slice: 'P3-S4', label: 'S4 freeze' },
  { sha: '5ff7b8b50491254af8aa6cf13ae9f164244f02f2', slice: 'P3-S5', label: 'S5 freeze' },
  { sha: '01dae043ed3a327b2f9d2126e2d27f855229cac8', slice: 'P3-S6', label: 'S6 freeze' },
  { sha: 'a0aee732ceddb12f765563a7f405308fc9b83c1a', slice: 'P3-S7', label: 'S7 freeze' },
  { sha: '5fcab766cc94a75b7e158913c942cea58dc94b33', slice: 'P3-S8', label: 'S8 freeze' },
  { sha: 'd6f1bc6ecff08694351949d637090139e1ccc8f2', slice: 'P3-S9', label: 'S9 candidate' },
];
export const CORRECTIVE = 'corrective';
const NOT_ACCEPTED = 'not yet (corrective candidate)';

// ─────────────────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────────────────

export type Group = 'db' | 'packages' | 'api' | 'web' | 'security' | 'ci' | 'other' | 'tests' | 'docs';

export const GROUP_TITLES: Record<Group, string> = {
  db: 'DB / migrations',
  packages: 'Domain / packages',
  api: 'API',
  web: 'Web',
  security: 'Security / gates',
  ci: 'CI / release',
  other: 'Other production files',
  tests: 'Tests (listed separately)',
  docs: 'Documentation (listed separately)',
};
const GROUP_ORDER: readonly Group[] = ['db', 'packages', 'api', 'web', 'security', 'ci', 'other', 'tests', 'docs'];
const PRODUCTION_GROUPS: ReadonlySet<Group> = new Set<Group>(['db', 'packages', 'api', 'web', 'security', 'ci', 'other']);

/** First matching rule wins. Stated verbatim in the generated page. */
export const GROUP_RULES: readonly { readonly group: Group; readonly rule: string; readonly test: (path: string) => boolean }[] = [
  { group: 'docs', rule: 'any `*.md`', test: (p) => p.endsWith('.md') },
  {
    group: 'tests',
    rule: '`tests/**`, `**/test/**`, `*.test.ts(x)`, a `vitest.config.*`, and the inventory vectors with their generators (`packages/inventory/{vectors,scripts}/**`)',
    test: (p) =>
      p.startsWith('tests/') ||
      /(^|\/)test\//.test(p) ||
      /\.test\.[cm]?tsx?$/.test(p) ||
      /(^|\/)vitest\.config\.[cm]?[jt]s$/.test(p) ||
      /^packages\/[^/]+\/(vectors|scripts)\//.test(p),
  },
  { group: 'db', rule: '`infrastructure/database/**`', test: (p) => p.startsWith('infrastructure/database/') },
  { group: 'packages', rule: '`packages/**`', test: (p) => p.startsWith('packages/') },
  { group: 'api', rule: '`apps/api/**`', test: (p) => p.startsWith('apps/api/') },
  { group: 'web', rule: '`apps/web/**`, `apps/admin/**`', test: (p) => p.startsWith('apps/web/') || p.startsWith('apps/admin/') },
  {
    group: 'ci',
    rule: '`.github/**`, root `package*.json`, and the release, evidence, rehearsal, export, canary and census scripts',
    test: (p) =>
      p.startsWith('.github/') ||
      p === 'package.json' ||
      p === 'package-lock.json' ||
      /^scripts\/(.*release.*|.*evidence.*|.*rehearsal.*|export-release|runner-canary|test-census|phase3-review-index.*)\.[a-z]+$/.test(p),
  },
  { group: 'security', rule: 'every other `scripts/**` (guards, slice gates, prefixes, checks, key installers)', test: (p) => p.startsWith('scripts/') },
];

export function groupOf(path: string): Group {
  return GROUP_RULES.find((r) => r.test(path))?.group ?? 'other';
}

// ─────────────────────────────────────────────────────────────────────────
// Security relevance (production files only)
// ─────────────────────────────────────────────────────────────────────────

/** Every matching rule is named; any match makes the file high. Stated verbatim in the generated page. */
export const SECURITY_RULES: readonly { readonly reason: string; readonly rule: string; readonly test: (path: string, text: string) => boolean }[] = [
  { reason: 'migration', rule: 'path under `infrastructure/database/`', test: (p) => p.startsWith('infrastructure/database/') },
  { reason: 'definer', rule: 'text contains `SECURITY DEFINER`', test: (_p, t) => /SECURITY\s+DEFINER/i.test(t) },
  {
    reason: 'grants',
    rule: 'text contains `GRANT … ON`/`REVOKE … ON` or `ALTER DEFAULT PRIVILEGES`',
    test: (_p, t) => /\b(GRANT|REVOKE)\b[^;\n]*\bON\b|ALTER DEFAULT PRIVILEGES/.test(t),
  },
  { reason: 'RLS', rule: 'text contains `ROW LEVEL SECURITY` or `CREATE POLICY`', test: (_p, t) => /ROW LEVEL SECURITY|CREATE POLICY/i.test(t) },
  { reason: 'workflow', rule: 'path under `.github/workflows/`', test: (p) => p.startsWith('.github/workflows/') },
  {
    reason: 'auth',
    rule: 'path names auth, session, token, csrf, csp, middleware or the BFF proxy',
    test: (p) => /(^|[/.-])(auth|session|token|tokens|csrf|csp|middleware|proxy)([/.-]|$)/i.test(p),
  },
  {
    reason: 'assertion',
    rule: 'path names an assertion, minter, signer or key; or text uses `createHmac`/`timingSafeEqual`',
    test: (p, t) => /(assertion|minter|signer|(^|[/-])keys?([/.-]|$))/i.test(p) || /createHmac|timingSafeEqual/.test(t),
  },
  {
    reason: 'authorization',
    rule: 'path names permissions, authorization, read scope or tenancy',
    test: (p) => /(permission|authori[sz]ation|read-scope|tenancy)/i.test(p),
  },
  {
    reason: 'gate',
    rule: 'a static guard, gate, migration prefix or check under `scripts/`',
    test: (p) => /^scripts\/(guards\/|static-guards|.*-gate\.|.*-prefix\.|check-|verify-|.*deployment-authority)/.test(p),
  },
];

/** This tool's own files state every rule's words; they are rated by their path alone. */
export const SELF: readonly string[] = ['scripts/phase3-review-index.ts', 'scripts/test-census.ts', 'tests/security/p3c-review-index.test.ts'];

export function securityOf(path: string, text: string): string {
  const reasons = SECURITY_RULES.filter((r) => r.test(path, SELF.includes(path) ? '' : text)).map((r) => r.reason);
  return reasons.length === 0 ? 'standard' : `high: ${reasons.join(', ')}`;
}

// ─────────────────────────────────────────────────────────────────────────
// The tree: files, imports and references (no git)
// ─────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'release', 'out', 'var', '.gradle']);
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.test\.[cm]?tsx?$/;

export interface Tree {
  readonly root: string;
  /** Every file, relative and `/`-separated. */
  readonly files: ReadonlySet<string>;
  readonly text: (path: string) => string;
}

/**
 * The files a tree consists of: the delivery manifest's inventory in an
 * extracted archive; `git ls-files --cached --others --exclude-standard` in a
 * checkout (so build output, logs and local artefacts never change a cell);
 * otherwise a walk of the directory.
 */
export function readTree(root: string): Tree {
  const files = new Set<string>();
  const manifest = join(root, 'DELIVERY_MANIFEST.json');
  const listed: string[] | null = existsSync(manifest)
    ? ((JSON.parse(readFileSync(manifest, 'utf8')) as { inventory?: { path?: unknown }[] }).inventory
        ?.map((entry) => entry.path)
        .filter((p): p is string => typeof p === 'string' && p !== '') ?? null)
    : null;
  const tracked = listed === null ? git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']) : null;
  const inventory = listed ?? (tracked?.ok === true ? tracked.out.split('\0').filter((p) => p !== '') : null);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.add(relative(root, path).split(sep).join('/'));
    }
  };
  if (inventory === null) walk(root);
  else for (const path of inventory) if (existsSync(join(root, path))) files.add(path);
  const cache = new Map<string, string>();
  const text = (path: string): string => {
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    const value = files.has(path) ? readFileSync(join(root, path), 'utf8') : '';
    cache.set(path, value);
    return value;
  };
  return { root, files, text };
}

const isTestSupport = (path: string): boolean => SOURCE.test(path) && !TEST_FILE.test(path) && (path.startsWith('tests/') || /(^|\/)test\//.test(path));
const isTestFile = (path: string): boolean => TEST_FILE.test(path);

/** The shared harness every suite loads: naming a file through it says nothing about which test protects it. */
export const HARNESS: readonly string[] = [
  'tests/helpers/test-app.ts',
  'tests/helpers/setup.ts',
  'tests/helpers/global-setup.ts',
  'apps/web/test/helpers/global-setup.ts',
];

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)['"]([^'"]+)['"]/g;

/** The repository file an import specifier names, or null for an external module. */
export function resolveSpecifier(files: ReadonlySet<string>, from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else if (spec.startsWith('@/')) {
    const app = /^apps\/([^/]+)\//.exec(from);
    if (app !== null) base = `apps/${app[1]}/src/${spec.slice(2)}`;
  } else {
    const pkg = /^@daftar\/([a-z-]+)(?:\/(.+))?$/.exec(spec);
    if (pkg !== null) base = pkg[2] === undefined ? `packages/${pkg[1]}/src/index` : `packages/${pkg[1]}/src/${pkg[2]}`;
  }
  if (base === null) return null;
  const stem = base.replace(/\.[cm]?js$/, '');
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function importsOf(tree: Tree, path: string): Set<string> {
  const out = new Set<string>();
  for (const match of tree.text(path).matchAll(IMPORT)) {
    const spec = match[1];
    if (spec === undefined) continue;
    const target = resolveSpecifier(tree.files, path, spec);
    if (target !== null) out.add(target);
  }
  return out;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways a test can name `path` without importing it. Stated in the generated page. */
function needlesOf(tree: Tree, path: string, basenameCount: ReadonlyMap<string, number>, npmScripts: ReadonlyMap<string, string[]>): RegExp[] {
  const out: RegExp[] = [new RegExp(`${escapeRegExp(path)}(?![\\w.-])`)];
  const name = basename(path);
  if ((basenameCount.get(name) ?? 0) === 1 && name.length >= 10) out.push(new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w.-])`));
  if (path.startsWith('infrastructure/database/migrations/') && path.endsWith('.sql')) {
    out.push(new RegExp(`(?<![\\w.-])${escapeRegExp(basename(path, '.sql'))}(?![\\w-])`));
    const routines = new Set<string>();
    for (const m of tree.text(path).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+((?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)\s*\(/gi)) {
      // An unqualified routine is named by its name alone; a short one is too ambiguous to count.
      if (m[1] !== undefined && m[1].length >= 12) routines.add(m[1].toLowerCase());
    }
    for (const routine of routines) out.push(new RegExp(`(?<![\\w.])${escapeRegExp(routine)}(?![\\w])`, 'i'));
  }
  for (const script of npmScripts.get(path) ?? []) out.push(new RegExp(`(?<![\\w:-])${escapeRegExp(script)}(?![\\w:-])`));
  for (const route of controllerRoutes(tree.text(path))) out.push(route);
  return out;
}

/**
 * The route prefixes a controller serves, as patterns over a test's text. A
 * `:param` segment matches any one segment (a template `${id}` included). A
 * bare `/v1` prefix is too broad to name anything, so such a controller is
 * named by `/v1/<first segment>` of each of its handlers instead.
 */
function controllerRoutes(text: string): RegExp[] {
  const prefix = /@Controller\(\s*['"]\/?([^'"]*)['"]\s*\)/.exec(text)?.[1]?.replace(/\/$/, '');
  if (prefix === undefined) return [];
  const pattern = (route: string): RegExp =>
    new RegExp(
      `/${route
        .split('/')
        .map((segment) => (segment.startsWith(':') ? '[^/\\s\'"`]+' : escapeRegExp(segment)))
        .join('/')}(?![\\w-])`,
    );
  if (prefix.split('/').length >= 2) return [pattern(prefix)];
  const firsts = new Set<string>();
  for (const m of text.matchAll(/@(?:Get|Post|Put|Patch|Delete)\(\s*['"]\/?([^'"/:]+)/g)) if (m[1] !== undefined) firsts.add(m[1]);
  return [...firsts].sort().map((first) => pattern(`${prefix}/${first}`));
}

/** `npm run <name>` scripts of the root package.json, by the script file they run. */
function npmScriptsByFile(tree: Tree): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const parsed = JSON.parse(tree.text('package.json') || '{}') as { scripts?: Record<string, string> };
  for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
    const file = /\btsx\s+(scripts\/\S+\.ts)\b/.exec(command)?.[1];
    if (file !== undefined) out.set(file, [...(out.get(file) ?? []), name]);
  }
  return out;
}

export interface Protection {
  /** Test files that import or name the file, directly or through a test helper that does. */
  readonly tests: readonly string[];
  /** When nothing names the file: the production file whose tests were used instead. */
  readonly via: string | null;
}

/** For each production path: the tests that protect it. Tree only, no git. */
export function protectionOf(tree: Tree, paths: readonly string[]): Map<string, Protection> {
  const all = [...tree.files];
  const testFiles = all.filter(isTestFile).sort();
  const supportFiles = all.filter(isTestSupport).sort();
  const basenameCount = new Map<string, number>();
  for (const f of all) basenameCount.set(basename(f), (basenameCount.get(basename(f)) ?? 0) + 1);
  const npmScripts = npmScriptsByFile(tree);

  const testImports = new Map(testFiles.map((t) => [t, importsOf(tree, t)]));
  const supportImports = new Map(supportFiles.filter((s) => !HARNESS.includes(s)).map((s) => [s, importsOf(tree, s)]));
  // One hop through a helper: a test that imports a helper is protected by what the helper names.
  const testsUsingSupport = new Map<string, string[]>();
  for (const [test, imports] of testImports) {
    for (const target of imports) if (supportImports.has(target)) testsUsingSupport.set(target, [...(testsUsingSupport.get(target) ?? []), test]);
  }

  const direct = (path: string): string[] => {
    const needles = needlesOf(tree, path, basenameCount, npmScripts);
    const names = (file: string): boolean => needles.some((n) => n.test(tree.text(file)));
    const found = new Set<string>();
    // The index's own suite names paths as fixtures, not as coverage: only its imports count.
    for (const test of testFiles) if (testImports.get(test)?.has(path) === true || (!SELF.includes(test) && names(test))) found.add(test);
    for (const support of supportFiles) {
      if (supportImports.get(support)?.has(path) === true || names(support)) for (const test of testsUsingSupport.get(support) ?? []) found.add(test);
    }
    return [...found].sort();
  };

  // Production importers, for the one-hop fallback.
  const productionSources = all.filter(
    (f) => SOURCE.test(f) && !isTestFile(f) && !isTestSupport(f) && /^(apps\/[^/]+\/src|packages\/[^/]+\/src|scripts)\//.test(f),
  );
  const importers = new Map<string, string[]>();
  for (const source of productionSources) {
    for (const target of importsOf(tree, source)) importers.set(target, [...(importers.get(target) ?? []), source]);
  }

  const memo = new Map<string, string[]>();
  const directMemo = (path: string): string[] => {
    const hit = memo.get(path);
    if (hit !== undefined) return hit;
    const value = direct(path);
    memo.set(path, value);
    return value;
  };

  const out = new Map<string, Protection>();
  for (const path of paths) {
    const tests = directMemo(path);
    if (tests.length > 0 || !tree.files.has(path)) {
      out.set(path, { tests, via: null });
      continue;
    }
    let best: Protection = { tests: [], via: null };
    for (const importer of (importers.get(path) ?? []).sort()) {
      const viaTests = directMemo(importer);
      if (viaTests.length > best.tests.length) best = { tests: viaTests, via: importer };
    }
    out.set(path, best);
  }
  return out;
}

/** A short, stable name for a test file. */
export function testLabel(path: string): string {
  return path
    .replace(/^tests\//, '')
    .replace(/^apps\/([^/]+)\/test\//, '$1/')
    .replace(/^packages\/([^/]+)\/test\//, '$1/')
    .replace(TEST_FILE, '');
}

const SHOWN_TESTS = 4;

export function protectionCell(p: Protection | undefined): string {
  if (p === undefined || p.tests.length === 0) return 'none found by reference';
  const shown = p.tests.slice(0, SHOWN_TESTS).map(testLabel).join(', ');
  const more = p.tests.length > SHOWN_TESTS ? ` (+${p.tests.length - SHOWN_TESTS})` : '';
  const via = p.via === null ? '' : ` via \`${basename(p.via)}\``;
  return `${p.tests.length}${via}: ${shown}${more}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Purpose
// ─────────────────────────────────────────────────────────────────────────

const DECORATION = /^[\s─━═=\-*#/|+~_.]*$/;
const MAX_PURPOSE = 180;

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(one)?.[1] ?? one;
  return sentence.length <= MAX_PURPOSE ? sentence : `${sentence.slice(0, MAX_PURPOSE - 1).trimEnd()}…`;
}

/** The first paragraph of a file's leading comment, or null. */
export function headerPurpose(path: string, text: string): string | null {
  const lines = text.split('\n');
  const ext = extname(path);
  let comment: string[] = [];
  if (ext === '.md') {
    const h1 = lines.find((l) => /^#\s+\S/.test(l));
    return h1 === undefined ? null : clip(h1.replace(/^#\s+/, ''));
  }
  if (ext === '.sql') {
    comment = takeWhile(dropLeading(lines), (l) => l.startsWith('--')).map((l) => l.replace(/^--\s?/, ''));
  } else if (ext === '.yml' || ext === '.yaml') {
    comment = takeWhile(dropLeading(lines), (l) => l.startsWith('#')).map((l) => l.replace(/^#\s?/, ''));
  } else if (SOURCE.test(path)) {
    const body = dropLeading(lines.filter((l) => !/^#!/.test(l) && !/^\s*['"]use (client|server)['"];?\s*$/.test(l)));
    const first = body[0]?.trim() ?? '';
    // A leading comment; else the top-level doc comment of the file's exported class or default export.
    const docStart = first.startsWith('/*') ? 0 : first.startsWith('//') ? -1 : mainExportDoc(body);
    if (docStart >= 0) {
      const block = body.slice(docStart);
      const end = block.findIndex((l) => l.includes('*/'));
      comment = block.slice(0, end < 0 ? block.length : end + 1).map((l) =>
        l
          .replace(/^\s*\/\*\*?/, '')
          .replace(/\*\/.*$/, '')
          .replace(/^\s*\*\s?/, ''),
      );
    } else if (first.startsWith('//')) {
      comment = takeWhile(body, (l) => l.trim().startsWith('//')).map((l) => l.replace(/^\s*\/\/\s?/, ''));
    }
  }
  const meaningful = comment
    .map((l) => l.trim())
    .filter((l) => !/eslint-|prettier-ignore|@ts-|^@\w+/.test(l))
    // A migration's header opens with its own file name.
    .filter((l) => l.replace(/[\s—:-]+$/, '') !== basename(path));
  const start = meaningful.findIndex((l) => !DECORATION.test(l));
  if (start < 0) return null;
  const paragraph: string[] = [];
  for (const line of meaningful.slice(start)) {
    if (DECORATION.test(line)) break;
    paragraph.push(line);
  }
  return paragraph.length === 0 ? null : clip(paragraph.join(' '));
}

/** The start of the doc comment right above the first `export class` / `export default` (decorators between are allowed), or -1. */
function mainExportDoc(lines: readonly string[]): number {
  const target = lines.findIndex((l) => /^export (default |abstract )?(class|function|async function)\b|^export default\b/.test(l));
  if (target < 0) return -1;
  let at = target - 1;
  while (at >= 0 && /^@\w/.test(lines[at] ?? '')) at--;
  if (at < 0 || !(lines[at] ?? '').trim().endsWith('*/')) return -1;
  while (at >= 0 && !(lines[at] ?? '').startsWith('/**')) at--;
  return at;
}

function dropLeading(lines: readonly string[]): string[] {
  const start = lines.findIndex((l) => l.trim() !== '');
  return start < 0 ? [] : lines.slice(start);
}

function takeWhile<T>(items: readonly T[], keep: (item: T) => boolean): T[] {
  const end = items.findIndex((item) => !keep(item));
  return end < 0 ? [...items] : items.slice(0, end);
}

/** A commit subject without its `type(scope):` prefix. */
export function subjectPurpose(subject: string): string {
  return clip(subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, ''));
}

// ─────────────────────────────────────────────────────────────────────────
// History (git; absent in the archive and in a shallow checkout)
// ─────────────────────────────────────────────────────────────────────────

export interface MainlineCommit {
  readonly sha: string;
  readonly subject: string;
  readonly files: readonly string[];
}

export interface History {
  /** `git diff --name-only <base> HEAD`, sorted. */
  readonly changed: readonly string[];
  /** First-parent commits after the base, oldest first; a merge lists what it changed against its first parent. */
  readonly mainline: readonly MainlineCommit[];
  /** The subject of the first non-merge commit touching each path. */
  readonly introducedBy: ReadonlyMap<string, string>;
}

export type HistoryResult = { readonly ok: true; readonly history: History } | { readonly ok: false; readonly reason: string };

type GitResult = { readonly ok: true; readonly out: string } | { readonly ok: false; readonly reason: string };

/** One git call. A failure is a value the caller reports, never a silent default. */
function git(root: string, args: readonly string[]): GitResult {
  try {
    return {
      ok: true,
      out: execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { ok: false, reason: `git ${args[0] ?? ''} failed: ${detail ?? ''}` };
  }
}

/**
 * The commit whose first-parent line is the Phase 3 mainline. Normally HEAD.
 * Once HEAD contains the sealed head `sealed` (main after the merge, or a
 * branch cut from it), Phase 3 is closed and its mainline ends at `sealed`.
 * HEAD's own first-parent line then runs through main, past every slice
 * checkpoint. A `pull_request` run checks out GitHub's merge commit instead: its FIRST
 * parent is the base branch and its SECOND parent is the PR head, so HEAD's
 * first-parent line holds none of the slice checkpoints. When HEAD is a merge
 * whose first parent does not contain `checkpoint` and whose second parent
 * does, the second parent is that mainline. Anything else stays HEAD, so a
 * history that truly lost a checkpoint still fails loudly.
 */
export function mainlineHead(root: string, checkpoint: string = CHECKPOINTS[0]?.sha ?? '', sealed: string = PHASE3_HEAD): GitResult {
  const parents = git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']);
  if (!parents.ok) return parents;
  const [head = '', first, second, ...more] = parents.out.trim().split(' ');
  if (head !== sealed && git(root, ['cat-file', '-e', `${sealed}^{commit}`]).ok && git(root, ['merge-base', '--is-ancestor', sealed, head]).ok)
    return { ok: true, out: sealed };
  if (first === undefined || second === undefined || more.length > 0) return { ok: true, out: head };
  const inFirst = git(root, ['merge-base', '--is-ancestor', checkpoint, first]).ok;
  const inSecond = git(root, ['merge-base', '--is-ancestor', checkpoint, second]).ok;
  return { ok: true, out: !inFirst && inSecond ? second : head };
}

export function readHistory(root: string): HistoryResult {
  if (existsSync(join(root, 'DELIVERY_MANIFEST.json')))
    return { ok: false, reason: 'an extracted release archive (DELIVERY_MANIFEST.json present) carries no git history' };
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) return { ok: false, reason: `not a git checkout (${inside.reason})` };
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok) return shallow;
  if (shallow.out.trim() === 'true') return { ok: false, reason: 'a shallow checkout does not reach the Phase 3 base; fetch full history (fetch-depth: 0)' };
  const base = git(root, ['cat-file', '-e', `${PHASE3_BASE}^{commit}`]);
  if (!base.ok) return { ok: false, reason: `the Phase 3 base ${PHASE3_BASE.slice(0, 7)} is not in this repository` };

  const subject = mainlineHead(root);
  if (!subject.ok) return subject;
  const diff = git(root, ['diff', '--name-only', '-z', PHASE3_BASE, subject.out]);
  if (!diff.ok) return diff;
  const changed = diff.out
    .split('\0')
    .filter((p) => p !== '')
    .sort();

  const RS = '\x1e';
  const US = '\x1f';
  const log = git(root, [
    'log',
    '--first-parent',
    '--diff-merges=first-parent',
    '--reverse',
    `--format=${RS}%H${US}%s`,
    '--name-only',
    `${PHASE3_BASE}..${subject.out}`,
  ]);
  if (!log.ok) return log;
  const mainline = log.out
    .split(RS)
    .filter((r) => r.trim() !== '')
    .map((record): MainlineCommit => {
      const [head = '', ...rest] = record.split('\n');
      const [sha = '', subject = ''] = head.split(US);
      return { sha, subject, files: rest.map((l) => l.trim()).filter((l) => l !== '') };
    });

  const all = git(root, ['log', '--no-merges', '--topo-order', '--reverse', `--format=${RS}%s`, '--name-only', `${PHASE3_BASE}..${subject.out}`]);
  if (!all.ok) return all;
  const introducedBy = new Map<string, string>();
  for (const record of all.out.split(RS)) {
    const [subject = '', ...rest] = record.split('\n');
    for (const file of rest.map((l) => l.trim()).filter((l) => l !== '')) if (!introducedBy.has(file)) introducedBy.set(file, subject);
  }
  return { ok: true, history: { changed, mainline, introducedBy } };
}

/** The slice a commit subject names, if any: a `(p3-sN)`/`(sN)` scope, `p3-corrective`, or `P3-SN` in the text. */
export function namedSlice(subject: string): string | null {
  if (/p3-corrective/i.test(subject)) return CORRECTIVE;
  const scope = /^[a-z]+\(([^)]*)\)/i.exec(subject)?.[1];
  const inScope = scope === undefined ? null : /(?:^|[^a-z0-9])(?:p3-)?s(\d)(?![0-9])/i.exec(scope);
  if (inScope?.[1] !== undefined) return `P3-S${inScope[1]}`;
  const inText = /\bP3-S(\d)\b/i.exec(subject);
  return inText?.[1] === undefined ? null : `P3-S${inText[1]}`;
}

export interface HistoryFacts {
  readonly slice: string;
  readonly slices: readonly string[];
  readonly checkpoint: string;
  readonly introducedBy: string | null;
}

/**
 * Per changed path: owning slice (the slice of the first mainline commit that
 * touched it: the slice its subject names, else the checkpoint window it
 * landed in; everything after the S9 candidate is `corrective`), every slice
 * that touched it, and the first checkpoint that contains that first change.
 */
export function historyFacts(history: History): Map<string, HistoryFacts> {
  const position = new Map(history.mainline.map((c, i) => [c.sha, i]));
  const bounds = CHECKPOINTS.map((cp) => ({ ...cp, at: position.get(cp.sha) ?? -1 }));
  const missing = bounds.filter((b) => b.at < 0);
  if (missing.length > 0) throw new Error(`the checkpoints ${missing.map((b) => b.sha.slice(0, 7)).join(', ')} are not on HEAD's first-parent history`);
  const windowOf = (i: number): (typeof bounds)[number] | null => bounds.find((b) => i <= b.at) ?? null;
  const sliceOf = (c: MainlineCommit, i: number): string => {
    const window = windowOf(i);
    if (window === null) return CORRECTIVE;
    return namedSlice(c.subject) ?? window.slice;
  };

  const out = new Map<string, HistoryFacts>();
  const touches = new Map<string, number[]>();
  history.mainline.forEach((c, i) => {
    for (const f of c.files) touches.set(f, [...(touches.get(f) ?? []), i]);
  });
  for (const path of history.changed) {
    const at = touches.get(path) ?? [];
    const first = at[0];
    const commit = first === undefined ? undefined : history.mainline[first];
    if (first === undefined || commit === undefined) {
      out.set(path, { slice: 'unknown', slices: [], checkpoint: 'unknown', introducedBy: history.introducedBy.get(path) ?? null });
      continue;
    }
    const slices: string[] = [];
    for (const i of at) {
      const c = history.mainline[i];
      if (c === undefined) continue;
      const s = sliceOf(c, i);
      if (!slices.includes(s)) slices.push(s);
    }
    const window = windowOf(first);
    const page = /^docs\/PHASE_3_S(\d)_/.exec(path)?.[1];
    out.set(path, {
      slice: page === undefined ? sliceOf(commit, first) : `P3-S${page}`,
      slices,
      checkpoint: window === null ? NOT_ACCEPTED : `${window.sha.slice(0, 7)} (${window.label})`,
      introducedBy: history.introducedBy.get(path) ?? commit.subject,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Rows and the page
// ─────────────────────────────────────────────────────────────────────────

export interface Row {
  readonly path: string;
  readonly group: Group;
  readonly slice: string;
  readonly purpose: string;
  readonly checkpoint: string;
  /** Production rows only. */
  readonly security: string;
  readonly tests: string;
}

export type Curated = Readonly<Record<string, string>>;

export function readCurated(root: string): Curated {
  const path = join(root, CURATED_PATH);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { purposes?: Record<string, unknown> };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.purposes ?? {})) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${CURATED_PATH}: the purpose of ${key} is not a non-empty string`);
    out[key] = value;
  }
  return out;
}

/** The paths the index lists: every path Phase 3 changed, except the index itself. */
export function indexedPaths(changed: readonly string[]): string[] {
  return changed.filter((p) => p !== INDEX_PATH);
}

/** The columns the tree alone decides, for each path. */
export function treeColumns(tree: Tree, paths: readonly string[]): Map<string, { group: Group; security: string; tests: string }> {
  const production = paths.filter((p) => PRODUCTION_GROUPS.has(groupOf(p)));
  const protection = protectionOf(tree, production);
  const out = new Map<string, { group: Group; security: string; tests: string }>();
  for (const path of paths) {
    const group = groupOf(path);
    const isProduction = PRODUCTION_GROUPS.has(group);
    out.set(path, {
      group,
      security: isProduction ? securityOf(path, tree.text(path)) : '',
      tests: isProduction ? protectionCell(protection.get(path)) : '',
    });
  }
  return out;
}

export function buildRows(tree: Tree, history: History, curated: Curated): Row[] {
  const facts = historyFacts(history);
  const paths = indexedPaths(history.changed);
  const columns = treeColumns(tree, paths);
  return paths.map((path): Row => {
    const f = facts.get(path);
    const c = columns.get(path);
    const slices = f?.slices ?? [];
    const also = slices.filter((s) => s !== f?.slice);
    const header = tree.files.has(path) ? headerPurpose(path, tree.text(path)) : null;
    const purpose = curated[path] ?? header ?? (f?.introducedBy === null || f?.introducedBy === undefined ? '' : subjectPurpose(f.introducedBy));
    return {
      path,
      group: c?.group ?? groupOf(path),
      slice: `${f?.slice ?? 'unknown'}${also.length > 0 ? ` (+${also.map((s) => s.replace('P3-', '')).join(', ')})` : ''}`,
      purpose,
      checkpoint: f?.checkpoint ?? 'unknown',
      security: c?.security ?? '',
      tests: c?.tests ?? '',
    };
  });
}

const cell = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const code = (path: string): string => `\`${path}\``;

const PRODUCTION_HEADER = ['Path', 'Slice', 'Purpose', 'First checkpoint', 'Security', 'Protected by'] as const;
const SEPARATE_HEADER = ['Path', 'Slice', 'Purpose', 'First checkpoint'] as const;

function productionLine(r: Row): string {
  return `| ${code(r.path)} | ${cell(r.slice)} | ${cell(r.purpose)} | ${cell(r.checkpoint)} | ${cell(r.security)} | ${cell(r.tests)} |`;
}
function separateLine(r: Row): string {
  return `| ${code(r.path)} | ${cell(r.slice)} | ${cell(r.purpose)} | ${cell(r.checkpoint)} |`;
}

export function renderIndex(rows: readonly Row[]): string {
  const byGroup = new Map<Group, Row[]>();
  for (const r of rows) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
  const production = rows.filter((r) => PRODUCTION_GROUPS.has(r.group));
  const out: string[] = [];
  out.push('# Phase 3 review index (PR #4)');
  out.push('');
  out.push(
    `> **A review aid, not a source of truth.** Generated by \`${REGENERATE_COMMAND}\` (\`scripts/phase3-review-index.ts\`) from git history after the Phase 2 merge \`${PHASE3_BASE.slice(0, 7)}\` and from the tree. Where this page disagrees with the code, the migrations, the tests, the acceptance pages or \`PROJECT_STATUS.md\`, they win and this page is stale. Do not edit it by hand: \`${CHECK_COMMAND}\` fails when a row names a path that no longer exists, when a changed path has no row, or when any line differs from what the generator writes. Hand-curated purposes live in \`${CURATED_PATH}\`.`,
  );
  out.push('');
  out.push(
    `It lists every path in \`git diff --name-only ${PHASE3_BASE.slice(0, 7)} HEAD\` except this page itself: ${production.length} production files and, separately, ${(byGroup.get('tests') ?? []).length} test files and ${(byGroup.get('docs') ?? []).length} documents. Regenerate after committing, then commit the page.`,
  );
  out.push('');
  out.push('## How each column is derived');
  out.push('');
  out.push(
    '- **Slice** — the slice of the first first-parent (mainline) commit that touched the path: the slice its subject names (a `(p3-sN)`/`(sN)` scope, `p3-corrective`, or `P3-SN` in the subject), otherwise the checkpoint window the commit landed in. Every commit after the S9 candidate is `corrective`. A slice page (`docs/PHASE_3_SN_*`) belongs to its slice, whichever commit adopted it. `(+S4, S8)` lists the later slices that also changed the path.',
  );
  out.push(
    `- **First checkpoint** — the first slice freeze/acceptance commit that contains the path's first Phase 3 change: ${CHECKPOINTS.map((c) => `\`${c.sha.slice(0, 7)}\` ${c.label}`).join(', ')}. A corrective change reads "${NOT_ACCEPTED}".`,
  );
  out.push(
    "- **Purpose** — the curated purpose if there is one, else the first paragraph of the file's leading comment (the first `#` heading of a document), else the subject of the first non-merge commit that touched it. One sentence, clipped.",
  );
  out.push(
    `- **Security** — \`high\` when any rule matches, naming each: ${SECURITY_RULES.map((r) => `**${r.reason}** (${r.rule})`).join('; ')}. Otherwise \`standard\`. The index's own generator, the census and their suite, which spell out every rule, are rated by path alone. The rules are coarse by design: \`standard\` is not a finding that a file is harmless.`,
  );
  out.push(
    `- **Protected by** — the test files that import the path or name it (its repository path; its file name when unique; for a migration its name or any routine it creates; for a script the \`npm run\` name that runs it; for a controller its route prefix, or \`/v1/<segment>\` of each handler under a bare \`/v1\`), directly or through a test helper that does — not through the shared harness (${HARNESS.map((h) => `\`${h}\``).join(', ')}), which every suite loads, and not by the fixture strings of this index's own suite (its imports count). When none does, the tests of the production file that imports it and has the most tests, marked \`via\`. The first ${SHOWN_TESTS} are named, sorted by path. "none found by reference" is a prompt to look, not a proof of no coverage.`,
  );
  out.push(
    `- **Group** — first matching rule: ${GROUP_RULES.map((r) => `**${GROUP_TITLES[r.group]}** ${r.rule}`).join('; ')}; anything else is **${GROUP_TITLES.other}**.`,
  );
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| Group | Files | Security high | Protected by none found |');
  out.push('| --- | --- | --- | --- |');
  for (const g of GROUP_ORDER) {
    const rs = byGroup.get(g) ?? [];
    if (rs.length === 0) continue;
    const prod = PRODUCTION_GROUPS.has(g);
    const high = prod ? String(rs.filter((r) => r.security.startsWith('high')).length) : '—';
    const none = prod ? String(rs.filter((r) => r.tests === 'none found by reference').length) : '—';
    out.push(`| ${GROUP_TITLES[g]} | ${rs.length} | ${high} | ${none} |`);
  }
  for (const g of GROUP_ORDER) {
    const rs = byGroup.get(g) ?? [];
    if (rs.length === 0) continue;
    const prod = PRODUCTION_GROUPS.has(g);
    const header = prod ? PRODUCTION_HEADER : SEPARATE_HEADER;
    out.push('');
    out.push(`## ${GROUP_TITLES[g]} (${rs.length})`);
    out.push('');
    out.push(`| ${header.join(' | ')} |`);
    out.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const r of rs) out.push(prod ? productionLine(r) : separateLine(r));
  }
  out.push('');
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// The check
// ─────────────────────────────────────────────────────────────────────────

export interface ParsedRow {
  readonly path: string;
  readonly cells: readonly string[];
  readonly line: number;
}

/** The table rows of a page, by path. */
export function parseRows(text: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  text.split('\n').forEach((line, i) => {
    const m = /^\| `([^`]+)` \|/.exec(line);
    if (m?.[1] === undefined) return;
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    out.push({ path: m[1], cells, line: i + 1 });
  });
  return out;
}

/** Full check: the page against what the generator writes now. Pure. */
export function compareIndex(actual: string, expected: string, exists: (path: string) => boolean): string[] {
  if (actual === expected) return [];
  const problems: string[] = [];
  const actualRows = parseRows(actual);
  const expectedRows = new Map(parseRows(expected).map((r) => [r.path, r]));
  const seen = new Set<string>();
  for (const r of actualRows) {
    seen.add(r.path);
    if (!exists(r.path)) problems.push(`line ${r.line}: names a path that no longer exists: ${r.path}`);
    else if (!expectedRows.has(r.path)) problems.push(`line ${r.line}: names a path Phase 3 did not change: ${r.path}`);
    else if (expectedRows.get(r.path)?.cells.join('|') !== r.cells.join('|')) problems.push(`line ${r.line}: stale row: ${r.path}`);
  }
  for (const path of expectedRows.keys()) if (!seen.has(path)) problems.push(`misses a changed path: ${path}`);
  if (problems.length === 0) {
    const a = actual.split('\n');
    const e = expected.split('\n');
    const at = a.findIndex((line, i) => line !== e[i]);
    problems.push(`stale text at line ${(at < 0 ? Math.min(a.length, e.length) : at) + 1}`);
  }
  return problems;
}

/** Tree-only check: every row's path exists and its tree-decided cells are current. Pure given the columns. */
export function compareTreeOnly(
  actual: string,
  columns: ReadonlyMap<string, { group: Group; security: string; tests: string }>,
  exists: (path: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const r of parseRows(actual)) {
    if (!exists(r.path)) {
      problems.push(`line ${r.line}: names a path that no longer exists: ${r.path}`);
      continue;
    }
    const c = columns.get(r.path);
    if (c === undefined || !PRODUCTION_GROUPS.has(c.group) || r.cells.length !== PRODUCTION_HEADER.length) continue;
    if (r.cells[4] !== cell(c.security)) problems.push(`line ${r.line}: stale security cell: ${r.path}`);
    if (r.cells[5] !== cell(c.tests)) problems.push(`line ${r.line}: stale protected-by cell: ${r.path}`);
  }
  return problems;
}

export interface CheckResult {
  readonly mode: 'full' | 'tree-only';
  /** Why the check could not be full; null for a full check. */
  readonly reason: string | null;
  readonly problems: readonly string[];
}

/** Generate the page for `root`, or say why it cannot be generated there. */
export function generate(root: string): { ok: true; text: string; tree: Tree } | { ok: false; reason: string } {
  const history = readHistory(root);
  if (!history.ok) return history;
  const tree = readTree(root);
  return { ok: true, text: renderIndex(buildRows(tree, history.history, readCurated(root))), tree };
}

/** Check `text` (default: the committed page) against `root`. */
export function checkIndex(root: string, text?: string): CheckResult {
  const indexFile = join(root, INDEX_PATH);
  const actual = text ?? (existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null);
  if (actual === null) return { mode: 'full', reason: null, problems: [`${INDEX_PATH} is missing; run ${REGENERATE_COMMAND}`] };
  const exists = (path: string): boolean => existsSync(join(root, path));
  const curatedStale = (paths: ReadonlySet<string>): string[] =>
    Object.keys(readCurated(root))
      .filter((p) => !paths.has(p))
      .map((p) => `${CURATED_PATH} curates ${p}, which has no row`);

  const generated = generate(root);
  if (generated.ok) {
    const rows = new Set(parseRows(generated.text).map((r) => r.path));
    return { mode: 'full', reason: null, problems: [...compareIndex(actual, generated.text, exists), ...curatedStale(rows)] };
  }
  const tree = readTree(root);
  const paths = parseRows(actual).map((r) => r.path);
  const problems = compareTreeOnly(actual, treeColumns(tree, paths.filter(exists)), exists);
  return { mode: 'tree-only', reason: generated.reason, problems: [...problems, ...curatedStale(new Set(paths))] };
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────

function main(argv: readonly string[]): number {
  if (argv.includes('--check')) {
    const result = checkIndex(ROOT);
    if (result.mode === 'tree-only') {
      console.log(`REVIEW INDEX: tree-only check — ${result.reason ?? ''}`);
      console.log('  checked: every row names an existing path; group, security and protected-by cells are current');
      console.log(`  not checked here: the set of changed paths and the history-derived cells; run ${CHECK_COMMAND} on a full clone`);
    }
    if (result.problems.length > 0) {
      console.error(`REVIEW INDEX: FAIL — ${result.problems.length} problem(s); run ${REGENERATE_COMMAND} after committing`);
      for (const p of result.problems.slice(0, 50)) console.error(`  ${p}`);
      if (result.problems.length > 50) console.error(`  … and ${result.problems.length - 50} more`);
      return 1;
    }
    console.log(`REVIEW INDEX: PASS (${result.mode}) — ${INDEX_PATH} is current`);
    return 0;
  }
  const generated = generate(ROOT);
  if (!generated.ok) {
    console.error(`REVIEW INDEX: cannot generate — ${generated.reason}`);
    return 1;
  }
  const target = join(ROOT, INDEX_PATH);
  writeFileSync(target, generated.text);
  console.log(`REVIEW INDEX: wrote ${INDEX_PATH} (${parseRows(generated.text).length} rows) from the history through HEAD and the tree`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
