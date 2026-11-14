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
 * `global-not-found`, `forbidden`, `unauthorized`, `loading`, `template`,
 * `default`) and the metadata files (`opengraph-image`, `twitter-image`,
 * `icon`, `apple-icon`, `sitemap`, `robots`, `manifest`; the image ones may be
 * numbered), in ANY source extension: `tsconfig` has `allowJs`, so a `.js`,
 * `.jsx`, `.mjs` or `.cjs` entry is as much an entry as a `.tsx` one.
 */
const SOURCE_EXT = '[cm]?[jt]sx?';
/** A source file of any kind the build compiles. */
export const SOURCE_FILE = new RegExp(String.raw`\.${SOURCE_EXT}$`);
const ENTRY_FILE = new RegExp(
  String.raw`(?:^|/)(?:page|layout|template|loading|error|global-error|not-found|global-not-found|forbidden|unauthorized|default|route|(?:opengraph-image|twitter-image|icon|apple-icon)\d*|sitemap|robots|manifest)\.${SOURCE_EXT}$`,
);
/** The files outside `app/` Next.js runs on its own: the middleware and the instrumentation hooks. */
const ROOT_ENTRY = new RegExp(String.raw`^${WEB_SRC}/(?:middleware|instrumentation|instrumentation-client)\.${SOURCE_EXT}$`);

/**
 * A file under the `customers` route segment: anchored at `[locale]`, with one
 * optional route group in front. `pos/customers/…` and `reports/customers/…`
 * are NOT the customers route; `customers/pos/…` is.
 */
const CUSTOMERS_ROUTE = new RegExp(String.raw`^${WEB_SRC}/app/\[locale\]/(?:\([^/]+\)/)?customers/`);

if (!MERCHANT_ROUTE_SEGMENTS.includes('customers')) throw new Error('the S7 route segments no longer name `customers`');

const isEntry = (path: string): boolean => (path.startsWith(`${WEB_SRC}/app/`) && ENTRY_FILE.test(path)) || ROOT_ENTRY.test(path);

/** Every file the framework itself enters: the route and special files under `app/`, and the middleware. */
export function entryPoints(paths: readonly string[]): string[] {
  return paths.filter(isEntry).sort();
}

/** The entries of the customers route subtree, and EVERY other entry of the app (S7 segment or not, middleware included). */
export function splitEntryPoints(paths: readonly string[]): { customers: string[]; other: string[] } {
  const all = entryPoints(paths);
  return { customers: all.filter((path) => CUSTOMERS_ROUTE.test(path)), other: all.filter((path) => !CUSTOMERS_ROUTE.test(path)) };
}

const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];
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
    const hit = [base, ...EXTENSIONS.map((ext) => `${base}.${ext}`), ...EXTENSIONS.map((ext) => `${base}/index.${ext}`)].find(
      (candidate) => Object.hasOwn(files, candidate) && SOURCE_FILE.test(candidate),
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

/**
 * The files only the customers route subtree uses: reached from a customers
 * entry and from NO other entry of the app (any page, layout, route handler or
 * special file anywhere under `app/`, and the middleware). This is the one
 * place a customer may be named, derived from the import graph and not from
 * any list.
 *
 * CONSUMERS. A file no entry reaches at all (a view registry, which
 * `loadViewRegistries` requires in every `views/<area>/` and no page imports; a
 * test fixture) belongs to the slice whose views it imports. So an unreached
 * file that imports at least one customers-only file joins the set, repeatedly
 * (a file importing such a consumer is a consumer too). It does NOT matter what
 * else it imports: a registry imports the shared `defineView` as well. An
 * unreached file that imports NO customers-only file stays out, however it
 * names a customer: dead code is not an exemption, and a file that imports only
 * scanned files is a scanned file's neighbour, not the customers slice's.
 *
 * Monotone by construction: an entry that is not under `customers` can only
 * add to what "every other entry" reaches, so it can only shrink this set (the
 * consumers can only shrink with it: a file that gets reached is no longer
 * unreached, and a file that loses a customers-only import loses its claim).
 */
export function customersOnly(files: Readonly<Record<string, string>>): Set<string> {
  const { customers, other } = splitEntryPoints(Object.keys(files));
  const shared = reachedFrom(files, other);
  const fromCustomers = reachedFrom(files, customers);
  const only = new Set([...fromCustomers].filter((path) => !shared.has(path)));
  const unreached = Object.keys(files).filter((path) => !shared.has(path) && !fromCustomers.has(path));
  for (let grew = true; grew; ) {
    grew = false;
    for (const path of unreached) {
      if (only.has(path)) continue;
      if (importsOf(path, files[path] ?? '', files).resolved.some((dep) => only.has(dep))) {
        only.add(path);
        grew = true;
      }
    }
  }
  return only;
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
 *
 * FAIL CLOSED (`closed: true`, for the files that decide whether a key is
 * excused): a key built at run time in a way this extractor cannot resolve to
 * a literal or to a leading prefix is assumed to cover every key it COULD
 * cover — `` `${ns}.buyer` ``, `ns + '.buyer'`, `.concat('.buyer')` cover every
 * key ending in that tail; `` `${a}.${b}` `` and `.join('.')` cover every key.
 * A key the rest of the tree might build is therefore never excused.
 */
const TEMPLATE = /`((?:\\.|\$\{[^}]*\}|[^`\\$]|\$(?!\{))*)`/g;
const TEMPLATE_EXPR = /\$\{[^}]*\}/g;
const KEY_PREFIX_ONLY = /^[A-Za-z][\w-]*(?:\.[\w-]+)*\.$/;
const CONCAT_TAIL = /[\w$)\]]\s*\+\s*(['"])(\.[\w-]+(?:\.[\w-]+)*)\1/g;
const CONCAT_METHOD_TAIL = /\.concat\(\s*(['"])(\.[\w-]+(?:\.[\w-]+)*)\1/g;
const JOIN_DOT = /\.join\(\s*(['"])\.\1\s*\)/;

export interface DynamicKeys {
  readonly tails: string[];
  readonly wildcard: boolean;
}

/** The text of every call `t( … )` in `text`, parentheses balanced: the places a catalogue key is read. */
function translationCallArguments(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w$.])t\(/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    out.push(text.slice(start, i - 1));
  }
  return out;
}

/** A tail that could end a catalogue key: dotted words only, so CSS, paths and numbers are not read as keys. */
const KEY_TAIL = /^\.[\w-]+(?:\.[\w-]+)*$/;

/**
 * The key constructions in `source` that a leading-prefix reading cannot
 * resolve. A TAIL (`ns + '.buyer'`, `` `${ns}.buyer` ``, `.concat('.buyer')`) is
 * read anywhere in the file, so a key built in a variable and passed on is
 * still seen. A WILDCARD (`.join('.')` anywhere; `` `${a}.${b}` `` inside a
 * `t(…)` call) could be any key. A template of two variables outside a `t(…)`
 * call is not read as a key: `${whole}.${fraction}` formats an amount.
 */
export function unresolvedKeyConstructions(source: string): DynamicKeys {
  const text = stripTsComments(source);
  const tails = new Set<string>();
  let wildcard = JOIN_DOT.test(text);
  const readTemplates = (scope: string, inCall: boolean): void => {
    for (const m of scope.matchAll(TEMPLATE)) {
      const body = m[1] ?? '';
      if (!body.includes('${')) continue;
      const statics = body.split(TEMPLATE_EXPR);
      if (KEY_PREFIX_ONLY.test(statics[0] ?? '')) continue;
      const tail = statics[statics.length - 1] ?? '';
      if (KEY_TAIL.test(tail)) tails.add(tail);
      else if (inCall && statics.every((s) => s === '' || s === '.') && statics.includes('.')) wildcard = true;
    }
  };
  readTemplates(text, false);
  for (const argument of translationCallArguments(text)) readTemplates(argument, true);
  for (const m of text.matchAll(CONCAT_TAIL)) tails.add(m[2] ?? '');
  for (const m of text.matchAll(CONCAT_METHOD_TAIL)) tails.add(m[2] ?? '');
  return { tails: [...tails].sort(), wildcard };
}

export function referencedKeys(sources: readonly string[], catalogKeys: readonly string[], options: { closed?: boolean } = {}): Set<string> {
  const known = new Set(catalogKeys);
  const out = new Set<string>();
  for (const source of sources) {
    const text = stripTsComments(source);
    for (const m of text.matchAll(KEY_LITERAL)) if (known.has(m[2] ?? '')) out.add(m[2] ?? '');
    for (const m of text.matchAll(KEY_PREFIX)) {
      const prefix = m[1] ?? m[3] ?? '';
      for (const key of catalogKeys) if (key.startsWith(prefix)) out.add(key);
    }
    if (options.closed === true) {
      const dynamic = unresolvedKeyConstructions(text);
      for (const key of catalogKeys) if (dynamic.wildcard || dynamic.tails.some((tail) => key.endsWith(tail))) out.add(key);
    }
  }
  return out;
}
