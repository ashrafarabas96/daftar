import { posix } from 'node:path';
import { MERCHANT_ROUTE_SEGMENTS, stripTsComments } from '../../../../scripts/guards/merchant-jargon';

/**
 * The import graph of `apps/web/src`, for laws that are about REACH rather
 * than about where a word happens to live (T-12 / OD-03, customer rules).
 *
 * Pure: it takes a map of repository-relative `/`-separated path -> source, so
 * the same functions run over the real tree and over a synthetic one that
 * contains a route the repository does not have yet.
 */

const WEB_SRC = 'apps/web/src';

/** `page`, `layout`, `route` and the other files Next.js loads on its own for a route segment. */
const ENTRY_FILE = /(?:^|\/)(?:page|layout|template|loading|error|not-found|default|route)\.tsx?$/;

/** A file under the `customers` merchant route segment (with an optional route group in front). */
const CUSTOMERS_ROUTE = new RegExp(String.raw`^${WEB_SRC}/app/\[locale\]/(?:\([^/]+\)/)?customers/`);

if (!MERCHANT_ROUTE_SEGMENTS.includes('customers')) throw new Error('the S7 route segments no longer name `customers`');

/** Every Next route file of the app, split into the customers subtree's and everyone else's. */
export function appEntryPoints(paths: readonly string[]): { customers: string[]; other: string[] } {
  const entries = paths.filter((path) => path.startsWith(`${WEB_SRC}/app/`) && ENTRY_FILE.test(path)).sort();
  return { customers: entries.filter((path) => CUSTOMERS_ROUTE.test(path)), other: entries.filter((path) => !CUSTOMERS_ROUTE.test(path)) };
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

/** The files `source` imports that exist in `files`, resolved the way the build resolves `./`, `../` and `@/`. */
export function importsOf(path: string, source: string, files: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const m of stripTsComments(source).matchAll(IMPORT_SPECIFIER)) {
    const spec = m[2] ?? '';
    let base: string;
    if (spec.startsWith('@/')) base = `${WEB_SRC}/${spec.slice(2)}`;
    else if (spec.startsWith('./') || spec.startsWith('../')) base = posix.normalize(posix.join(posix.dirname(path), spec));
    else continue;
    const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => Object.hasOwn(files, candidate));
    if (hit !== undefined) out.push(hit);
  }
  return out;
}

/** Every file reachable from `entries` through imports, entries included. Traverses non-S7 files too. */
export function reachedFrom(files: Readonly<Record<string, string>>, entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.filter((entry) => Object.hasOwn(files, entry));
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const dep of importsOf(next, files[next] ?? '', files)) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

/**
 * The files only the customers route subtree uses: reached from a customers
 * entry and from NO other app entry. This is the one place a customer may be
 * named, derived from the import graph and not from any list.
 */
export function customersOnly(files: Readonly<Record<string, string>>): Set<string> {
  const { customers, other } = appEntryPoints(Object.keys(files));
  const shared = reachedFrom(files, other);
  return new Set([...reachedFrom(files, customers)].filter((path) => !shared.has(path)));
}

const KEY_LITERAL = /(['"`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g;
/** `` `error.${code}` `` and `'error.' + code`: a namespace prefix that completes at run time. */
const KEY_PREFIX = /(?:`([A-Za-z][\w-]*(?:\.[\w-]+)*\.)\$\{|(['"])([A-Za-z][\w-]*(?:\.[\w-]+)*\.)\2\s*\+)/g;

/**
 * The catalogue keys a set of sources refers to: every `a.b` string literal
 * that is a key, and — for a key built at run time — EVERY key under the
 * prefix a template or concatenation names. A dynamic reference is a
 * reference to the whole prefix, because the code cannot be shown to avoid any
 * member of it.
 */
export function referencedKeys(sources: readonly string[], catalogKeys: readonly string[]): Set<string> {
  const known = new Set(catalogKeys);
  const out = new Set<string>();
  for (const source of sources) {
    const text = stripTsComments(source);
    for (const m of text.matchAll(KEY_LITERAL)) if (known.has(m[2] ?? '')) out.add(m[2] ?? '');
    for (const m of text.matchAll(KEY_PREFIX)) {
      const prefix = m[1] ?? m[3] ?? '';
      for (const key of catalogKeys) if (key.startsWith(prefix)) out.add(key);
    }
  }
  return out;
}
