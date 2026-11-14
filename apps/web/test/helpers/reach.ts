import { posix } from 'node:path';
import ts from 'typescript';
import { MERCHANT_ROUTE_SEGMENTS } from '../../../../scripts/guards/merchant-jargon';

/**
 * The import graph of `apps/web/src`, for laws that are about REACH rather
 * than about where a word happens to live (T-12 / OD-03, customer rules).
 *
 * Pure: it takes a map of repository-relative `/`-separated path -> source, so
 * the same functions run over the real tree and over a synthetic one that
 * contains a route the repository does not have yet.
 *
 * Sources are PARSED, not pattern-matched: an import is an import declaration,
 * an `export … from`, a dynamic `import()` or a `require()` call — never text
 * that merely looks like one inside a string or a comment.
 *
 * This is a STATIC module-graph law. What it cannot see, stated: `require.context`,
 * middleware redirects and rewrites, `next.config` rewrites, and anything a
 * server answers at run time.
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
/**
 * The files outside `app/` Next.js runs on its own: the middleware, the
 * instrumentation hooks and `mdx-components`; and EVERY file of the Pages
 * Router (`src/pages/**`, `_app` and `_document` included), where each file is
 * a route or the frame of one.
 */
const ROOT_ENTRY = new RegExp(
  String.raw`^${WEB_SRC}/(?:(?:middleware|instrumentation|instrumentation-client|mdx-components)\.${SOURCE_EXT}|pages/.+\.${SOURCE_EXT})$`,
);

/**
 * A file under the `customers` route segment: anchored at `[locale]`, with one
 * optional route group in front. `pos/customers/…` and `reports/customers/…`
 * are NOT the customers route; `customers/pos/…` is.
 */
const CUSTOMERS_ROUTE = new RegExp(String.raw`^${WEB_SRC}/app/\[locale\]/(?:\([^/]+\)/)?customers/`);
/**
 * A Next.js INTERCEPTING route segment: `(.)x`, `(..)x`, `(..)(..)x`, `(...)x`.
 * `customers/(..)pos/x/page.tsx` renders at `/pos/x`, not under `/customers`, so
 * it is not the customers route whatever folder it lives in.
 */
const INTERCEPTING_SEGMENT = /\/\(\.{1,3}\)/;

if (!MERCHANT_ROUTE_SEGMENTS.includes('customers')) throw new Error('the S7 route segments no longer name `customers`');

const isEntry = (path: string): boolean => (path.startsWith(`${WEB_SRC}/app/`) && ENTRY_FILE.test(path)) || ROOT_ENTRY.test(path);

/** Every file the framework itself enters: the route and special files under `app/`, every Pages Router file, the middleware and its siblings. */
export function entryPoints(paths: readonly string[]): string[] {
  return paths.filter(isEntry).sort();
}

/** True for an entry that renders under `/customers`: in the customers folder and not intercepting a route elsewhere. */
export function isCustomersEntry(path: string): boolean {
  return CUSTOMERS_ROUTE.test(path) && !INTERCEPTING_SEGMENT.test(path);
}

/** The entries of the customers route subtree, and EVERY other entry of the app (S7 segment or not, middleware and Pages Router included). */
export function splitEntryPoints(paths: readonly string[]): { customers: string[]; other: string[] } {
  const all = entryPoints(paths);
  return { customers: all.filter(isCustomersEntry), other: all.filter((path) => !isCustomersEntry(path)) };
}

/** A package: a name or an `@scope/name`. Anything else that is not relative is an alias this walk does not know. */
const PACKAGE = /^(?:[A-Za-z][\w.-]*|@[A-Za-z0-9][\w.-]*\/)/;
const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];

interface Imports {
  /** Module specifiers of real imports (declarations, `export … from`, `import()`/`require()` of a literal). */
  readonly specifiers: string[];
  /** `import(expr)` / `require(expr)` whose argument is not a plain string: the target cannot be known. */
  readonly computed: string[];
}

const cache = new Map<string, Imports>();

const isStringLike = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

function parseImports(path: string, source: string): Imports {
  const cached = cache.get(`${path}\0${source}`);
  if (cached !== undefined) return cached;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
  const out: { specifiers: string[]; computed: string[] } = { specifiers: [], computed: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) out.specifiers.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier))
      out.specifiers.push(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      out.specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        const first = node.arguments[0];
        if (first !== undefined && isStringLike(first)) out.specifiers.push(first.text);
        else out.computed.push(node.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  cache.set(`${path}\0${source}`, out);
  return out;
}

/**
 * What `source` imports. `resolved` are files in `files`, found the way the
 * build finds them for `./`, `../` and `@/`; `unresolved` are specifiers the
 * walk could not follow — a path that names no file (`./x.js`), an alias it
 * does not know (`~/x`), a computed `import(…)` — which the caller must treat
 * as a failure, never as "nothing there". `.json` is data, not code.
 */
export function importsOf(path: string, source: string, files: Readonly<Record<string, string>>): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const parsed = parseImports(path, source);
  const unresolved: string[] = [...parsed.computed];
  for (const spec of parsed.specifiers) {
    if (spec.endsWith('.json')) continue;
    const find = (base: string): string | undefined =>
      [base, ...EXTENSIONS.map((ext) => `${base}.${ext}`), ...EXTENSIONS.map((ext) => `${base}/index.${ext}`)].find(
        (candidate) => Object.hasOwn(files, candidate) && SOURCE_FILE.test(candidate),
      );
    let hit: string | undefined;
    if (spec.startsWith('@/')) hit = find(`${WEB_SRC}/${spec.slice(2)}`);
    else if (spec.startsWith('./') || spec.startsWith('../')) hit = find(posix.normalize(posix.join(posix.dirname(path), spec)));
    else {
      // A bare specifier is a package — unless a file of `src/` answers to it, which is what a `baseUrl` or an alias would make
      // it: then it is a LOCAL import and is followed. (`tsconfig` has no `baseUrl` and `next.config` no alias; both are asserted.)
      const local = find(`${WEB_SRC}/${spec}`);
      if (local !== undefined) resolved.push(local);
      else if (!PACKAGE.test(spec)) unresolved.push(spec);
      continue;
    }
    if (hit === undefined) unresolved.push(spec);
    else resolved.push(hit);
  }
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
 * special file anywhere under `app/`, an intercepting route in the customers
 * folder, a Pages Router file, and the middleware). This is the one place a
 * customer may be named, derived from the import graph and not from any list.
 *
 * CONSUMERS. A file no entry reaches at all (a view registry, which
 * `loadViewRegistries` requires in every `views/<area>/` and no page imports; a
 * test fixture) belongs to the slice whose views it imports. So an unreached
 * file that REALLY imports (an import declaration, `export … from`, `import()`
 * or `require()` — not text in a string or a comment) at least one customers-only
 * file joins the set, repeatedly (a file importing such a consumer is a
 * consumer too). It does NOT matter what else it imports: a registry imports
 * the shared `defineView` as well. An unreached file that imports NO
 * customers-only file stays out, however it names a customer: dead code is not
 * an exemption. RESIDUAL, stated: an otherwise-dead file (a library included)
 * that really imports a customers-only file is excused with the slice.
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
