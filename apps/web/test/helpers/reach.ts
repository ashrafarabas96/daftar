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

/**
 * The entry points of the non-customers S7 surfaces: Next route files under an
 * S7 merchant segment (`MERCHANT_ROUTE_SEGMENTS`, as the guard defines it,
 * with an optional route group in front) except the `customers` subtree,
 * which is the one place a customer may be named.
 */
export function s7EntryPoints(paths: readonly string[]): string[] {
  const segments = MERCHANT_ROUTE_SEGMENTS.filter((segment) => segment !== 'customers');
  const route = new RegExp(String.raw`^${WEB_SRC}/app/\[locale\]/(?:\([^/]+\)/)?(?:${segments.join('|')})/.+`);
  return paths.filter((path) => route.test(path) && ENTRY_FILE.test(path)).sort();
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
