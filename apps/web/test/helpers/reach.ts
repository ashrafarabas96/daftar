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
/**
 * A Next.js INTERCEPTING route segment: `(.)x`, `(..)x`, `(..)(..)x`, `(...)x`.
 * `customers/(..)pos/x/page.tsx` renders at `/pos/x`, not under `/customers`, so
 * it is not the customers route whatever folder it lives in.
 */
const INTERCEPTING_SEGMENT = /\/\(\.{1,3}\)/;

if (!MERCHANT_ROUTE_SEGMENTS.includes('customers')) throw new Error('the S7 route segments no longer name `customers`');

const isEntry = (path: string): boolean => (path.startsWith(`${WEB_SRC}/app/`) && ENTRY_FILE.test(path)) || ROOT_ENTRY.test(path);

/** Every file the framework itself enters: the route and special files under `app/`, and the middleware. */
export function entryPoints(paths: readonly string[]): string[] {
  return paths.filter(isEntry).sort();
}

/** True for an entry that renders under `/customers`: in the customers folder and not intercepting a route elsewhere. */
export function isCustomersEntry(path: string): boolean {
  return CUSTOMERS_ROUTE.test(path) && !INTERCEPTING_SEGMENT.test(path);
}

/** The entries of the customers route subtree, and EVERY other entry of the app (S7 segment or not, middleware included). */
export function splitEntryPoints(paths: readonly string[]): { customers: string[]; other: string[] } {
  const all = entryPoints(paths);
  return { customers: all.filter(isCustomersEntry), other: all.filter((path) => !isCustomersEntry(path)) };
}

/** A package: a name or an `@scope/name`. Anything else that is not relative is an alias this walk does not know. */
const PACKAGE = /^(?:[A-Za-z][\w.-]*|@[A-Za-z0-9][\w.-]*\/)/;
const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];

/** Everything one parse of one file tells the laws. */
interface Parsed {
  /** Module specifiers of real imports (declarations, `export … from`, `import()`/`require()` of a literal). */
  readonly specifiers: string[];
  /** `import(expr)` / `require(expr)` whose argument is not a plain string: the target cannot be known. */
  readonly computed: string[];
  /** Every string literal that could be a catalogue key (the text of each string / no-substitution template). */
  readonly literals: string[];
  /** Key prefixes a template (`` `error.${code}` ``) or concatenation (`'error.' + code`) builds at run time. */
  readonly prefixes: string[];
  /** Key-position arguments (`t(arg)`, `translate(locale, arg)`) and key constructions this file makes that no literal or prefix reads. */
  readonly opaque: string[];
}

const KEY_PREFIX_ONLY = /^[A-Za-z][\w-]*(?:\.[\w-]+)*\.$/;
const KEY_TAIL = /^\.[\w-]+(?:\.[\w-]+)*$/;
const cache = new Map<string, Parsed>();

const isStringLike = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** The leftmost operand of a `+` chain. */
function leftmost(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) current = current.left;
  return current;
}

/**
 * Is a key-position argument something a literal or a leading prefix explains? A plain string; a template whose static head is a
 * key prefix (`` `error.${code}` ``); a concatenation that starts with one (`'error.' + code`); a conditional of such. Anything
 * else — an identifier, a call, a member, `'pos' + '.buyer'`, `` `${ns}.${leaf}` `` — is opaque.
 */
function explained(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))
    return explained(node.expression);
  if (isStringLike(node)) return true;
  if (ts.isTemplateExpression(node)) return KEY_PREFIX_ONLY.test(node.head.text);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const head = leftmost(node);
    return isStringLike(head) && KEY_PREFIX_ONLY.test(head.text);
  }
  if (ts.isConditionalExpression(node)) return explained(node.whenTrue) && explained(node.whenFalse);
  return false;
}

function parse(path: string, source: string): Parsed {
  const cached = cache.get(`${path}\0${source}`);
  if (cached !== undefined) return cached;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
  const out = { specifiers: [], computed: [], literals: [], prefixes: [], opaque: [] } as { -readonly [K in keyof Parsed]: Parsed[K] };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) out.specifiers.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier))
      out.specifiers.push(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      out.specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
      if (loads) {
        if (first !== undefined && isStringLike(first)) out.specifiers.push(first.text);
        else out.computed.push(node.getText(file));
      }
      if (ts.isIdentifier(callee) && (callee.text === 't' || callee.text === 'translate')) {
        const key = callee.text === 't' ? first : node.arguments[1];
        if (key !== undefined && !explained(key)) out.opaque.push(`${callee.text}(${key.getText(file)})`);
      }
      // `[a, 'buyer'].join('.')` and `a.concat('.buyer')` build a key whatever calls them.
      if (ts.isPropertyAccessExpression(callee) && first !== undefined && isStringLike(first)) {
        if (callee.name.text === 'join' && first.text === '.') out.opaque.push(node.getText(file));
        if (callee.name.text === 'concat' && KEY_TAIL.test(first.text)) out.opaque.push(node.getText(file));
      }
    } else if (isStringLike(node)) {
      out.literals.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      if (KEY_PREFIX_ONLY.test(node.head.text)) out.prefixes.push(node.head.text);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const head = leftmost(node);
      if (isStringLike(head) && KEY_PREFIX_ONLY.test(head.text)) out.prefixes.push(head.text);
      // `x + '.buyer'`: a key tail on a non-literal head.
      if (isStringLike(node.right) && KEY_TAIL.test(node.right.text) && !isStringLike(node.left) && !(isStringLike(head) && KEY_PREFIX_ONLY.test(head.text))) {
        out.opaque.push(node.getText(file));
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
  const parsed = parse(path, source);
  const unresolved: string[] = [...parsed.computed];
  for (const spec of parsed.specifiers) {
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
 * folder, and the middleware). This is the one place a customer may be named,
 * derived from the import graph and not from any list.
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
 * an exemption. RESIDUAL, stated: an otherwise-dead file that really imports a
 * customers-only file is excused with the slice.
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

/**
 * The catalogue keys a set of sources refers to: every string that is a key,
 * and — unless `literalsOnly` — EVERY key under the prefix a template or
 * concatenation names (`` `error.${code}` ``, `'error.' + code`): the code
 * cannot be shown to avoid any member of it.
 *
 * `literalsOnly` is for the files that ask to be EXCUSED (the customers-only
 * ones): an excuse needs the specific key spelled out, never a whole prefix.
 */
export function referencedKeys(sources: readonly string[], catalogKeys: readonly string[], options: { literalsOnly?: boolean } = {}): Set<string> {
  const known = new Set(catalogKeys);
  const out = new Set<string>();
  sources.forEach((source, index) => {
    const parsed = parse(`#${index}.tsx`, source);
    for (const literal of parsed.literals) if (known.has(literal)) out.add(literal);
    if (options.literalsOnly !== true) {
      for (const prefix of parsed.prefixes) for (const key of catalogKeys) if (key.startsWith(prefix)) out.add(key);
    }
  });
  return out;
}

/**
 * The key-position arguments and key constructions in `sources` that no literal
 * or leading prefix explains: `t(k)`, `t(a + b)`, `t('pos' + '.buyer')`,
 * `` t(`${ns}.${leaf}`) ``, `t(copy.key)`, `x + '.buyer'`, `.join('.')`. Any one
 * of them means the file could read ANY key, so no key may be excused.
 */
export function opaqueKeyUses(sources: readonly string[]): string[] {
  return sources.flatMap((source, index) => parse(`#${index}.tsx`, source).opaque);
}
