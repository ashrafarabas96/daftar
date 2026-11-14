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

/**
 * The files Next.js loads on its own for a route segment: `page`, `layout`,
 * `route` and the special files (`error`, `global-error`, `not-found`,
 * `forbidden`, `unauthorized`, `loading`, `template`, `default`) and the
 * metadata files (`opengraph-image`, `twitter-image`, `icon`, `apple-icon`,
 * `sitemap`, `robots`, `manifest`; the image ones may be numbered).
 */
const ENTRY_FILE =
  /(?:^|\/)(?:page|layout|template|loading|error|global-error|not-found|forbidden|unauthorized|default|route|(?:opengraph-image|twitter-image|icon|apple-icon)\d*|sitemap|robots|manifest)\.tsx?$/;
/** The one file outside `app/` Next.js runs on every request. */
const MIDDLEWARE = `${WEB_SRC}/middleware.ts`;

const SEGMENT_FILE = (segments: readonly string[]): RegExp => new RegExp(String.raw`^${WEB_SRC}/app/\[locale\]/(?:\([^/]+\)/)?(?:${segments.join('|')})/`);

/** The merchant route segments (the guard's own list, `customers` included). Anchored at `[locale]`: `pos/customers/…` is `pos`. */
const MERCHANT_ROUTE = SEGMENT_FILE(MERCHANT_ROUTE_SEGMENTS);
/** The till / cash-sale flow's route segments: the two the S7 guard names for selling. */
const SALE_FLOW_ROUTE = SEGMENT_FILE(['pos', 'sales']);

for (const segment of ['pos', 'sales']) if (!MERCHANT_ROUTE_SEGMENTS.includes(segment)) throw new Error(`the S7 route segments no longer name \`${segment}\``);

const isEntry = (path: string): boolean => (path.startsWith(`${WEB_SRC}/app/`) && ENTRY_FILE.test(path)) || path === MIDDLEWARE;

/** Every file the framework itself enters: the route and special files under `app/`, and the middleware. */
export function entryPoints(paths: readonly string[]): string[] {
  return paths.filter(isEntry).sort();
}

/** The route and special files of the sale flow: the entries the customer rules are about. */
export function saleFlowEntries(paths: readonly string[]): string[] {
  return paths.filter((path) => isEntry(path) && SALE_FLOW_ROUTE.test(path)).sort();
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
/** `import(expr)` whose argument is not a plain string: its target cannot be known. */
const COMPUTED_IMPORT = /\bimport\s*\(\s*(?!['"\s])[^)]*\)/g;
/** A package: a name or an `@scope/name`. Anything else that is not relative is an alias this walk does not know. */
const PACKAGE = /^(?:[A-Za-z][\w.-]*|@[A-Za-z0-9][\w.-]*\/)/;

/**
 * What `source` imports. `resolved` are files in `files`, found the way the
 * build finds them for `./`, `../` and `@/`; `unresolved` are specifiers the
 * walk could not follow — a path that names no file (`./x.js`), an alias it
 * does not know (`~/x`), a computed `import(…)` — which the caller must treat
 * as a failure, never as "nothing there". `.json` is data, not code.
 */
export function importsOf(path: string, source: string, files: Readonly<Record<string, string>>): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const text = stripTsComments(source);
  for (const m of text.matchAll(IMPORT_SPECIFIER)) {
    const spec = m[2] ?? '';
    if (spec.endsWith('.json')) continue;
    let base: string;
    if (spec.startsWith('@/')) base = `${WEB_SRC}/${spec.slice(2)}`;
    else if (spec.startsWith('./') || spec.startsWith('../')) base = posix.normalize(posix.join(posix.dirname(path), spec));
    else {
      if (!PACKAGE.test(spec)) unresolved.push(spec);
      continue;
    }
    const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(
      (candidate) => Object.hasOwn(files, candidate) && /\.tsx?$/.test(candidate),
    );
    if (hit === undefined) unresolved.push(spec);
    else resolved.push(hit);
  }
  for (const m of text.matchAll(COMPUTED_IMPORT)) unresolved.push(m[0]);
  return { resolved, unresolved };
}

/**
 * Every file reachable from `entries` through imports, entries included.
 * Traverses non-S7 files too. THROWS if any file in the walk imports something
 * the walk cannot resolve: a graph with a silent hole proves nothing about
 * what lies beyond it.
 */
export function reachedFrom(files: Readonly<Record<string, string>>, entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const holes = new Set<string>();
  const queue = entries.filter((entry) => Object.hasOwn(files, entry));
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const { resolved, unresolved } = importsOf(next, files[next] ?? '', files);
    for (const spec of unresolved) holes.add(`${next} -> ${spec}`);
    for (const dep of resolved) if (!seen.has(dep)) queue.push(dep);
  }
  if (holes.size > 0) throw new Error(`the import walk could not resolve:\n  ${[...holes].sort().join('\n  ')}`);
  return seen;
}

const intersection = (sets: readonly Set<string>[]): Set<string> =>
  sets.length === 0 ? new Set() : new Set([...(sets[0] as Set<string>)].filter((path) => sets.every((set) => set.has(path))));

export interface SaleFlow {
  /** Page files of the merchant route segments (the first estimate of "a page that renders the chrome"). */
  readonly merchantPages: string[];
  /** Every page of the whole app that reaches all of the chrome candidates: the pages that render the shared chrome. */
  readonly chromePages: string[];
  /** Files every chrome page reaches (the header, the shell, shared infrastructure): COMPUTED, never named. */
  readonly chrome: Set<string>;
  readonly entries: string[];
  /** reach(sale-flow entries) minus the chrome: the files whose own texts are the sale flow's. */
  readonly subject: Set<string>;
}

/**
 * The SUBJECT of the customer rules: the sale flow's own files.
 *
 * - chrome candidates: files reached from EVERY page of the merchant route
 *   segments (an intersection);
 * - chrome pages: the merchant pages, plus every OTHER page of the app (not
 *   only the S7 segments) that reaches all the candidates some such other page
 *   also reaches, so a pre-auth page that renders no shell (login) is not one,
 *   and a merchant page outside the S7 segments (structure) is — even when the
 *   S7 pages happen to share a file no other page does;
 * - chrome: the intersection over the chrome pages, which is what the shell
 *   and everything it pulls in have in common with every such page;
 * - subject: reach(sale-flow entries) minus the chrome.
 *
 * More chrome pages can only shrink the chrome, never grow it, so adding a
 * page makes the subject larger, not smaller.
 */
export function saleFlow(files: Readonly<Record<string, string>>): SaleFlow {
  const paths = Object.keys(files);
  const pages = paths.filter((path) => isEntry(path) && /(?:^|\/)page\.tsx?$/.test(path)).sort();
  const reach = new Map(pages.map((page) => [page, reachedFrom(files, [page])]));
  const merchantPages = pages.filter((page) => MERCHANT_ROUTE.test(page));
  const reachOf = (page: string): Set<string> => reach.get(page) as Set<string>;
  const candidates = intersection(merchantPages.map(reachOf));
  // The shell is what the merchant pages share AND some page outside the merchant segments shares too. A file only the
  // merchant segments reach (a customers view all of them import) is not evidence of a shell, and must not be allowed to
  // disqualify a page outside the segments that does render it.
  const others = pages.filter((page) => !merchantPages.includes(page));
  const shell = [...candidates].filter((file) => others.some((page) => reachOf(page).has(file)));
  const chromePages = [...merchantPages, ...others.filter((page) => shell.length > 0 && shell.every((file) => reachOf(page).has(file)))].sort();
  const chrome = intersection(chromePages.map((page) => reach.get(page) as Set<string>));
  const entries = saleFlowEntries(paths);
  const subject = new Set([...reachedFrom(files, entries)].filter((path) => !chrome.has(path)));
  return { merchantPages, chromePages, chrome, entries, subject };
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
