/**
 * PHASE 15 — EXIT-CODE SWEEP OVER THE PHASE 15 INSTRUMENT PACK
 * (PREPARED / NOT PROMOTED)
 *
 * WHY THIS EXISTS
 *   The coordinator's round-6 review found a class of defect rather than a
 *   line: a tool runs a command, ignores its exit code, and reads the empty
 *   output as an answer. "git status printed nothing" then becomes "the tree is
 *   clean"; "grep printed nothing" becomes "the pattern occurs nowhere". Every
 *   one of those is a check that fails OPEN, and no single-line fix closes the
 *   class — a later edit reintroduces it.
 *
 *   So the remedy is an instrument, not a patch. This sweep reads every
 *   `spawnSync` in the pack and reports each one whose exit code is never read.
 *
 * WHAT COUNTS AS READ
 *   1. The call's own result is bound to a name, and the `.status` of THAT
 *      DECLARATION is COMPARED somewhere inside the function it lives in —
 *      resolved through the scope chain on the TypeScript AST, so a
 *      comparison made on a different variable of the same name, in another
 *      function or after a re-binding, credits nothing (round-8 N1); or
 *   2. `.status` is compared on the spot, on the call expression itself; or
 *   3. the call sits in ARGUMENT position inside a wrapper that decides on the
 *      code itself; or
 *   4. the call sits inside a FORWARDER — a function that hands the result, or
 *      its status, outward — and EVERY call site of that forwarder decides, by
 *      1, 2, 3, or by forwarding again to a forwarder that does.
 *
 *   Cases 3 and 4 are exemptions, and an unmeasured exemption is how a sweep
 *   comes to certify the thing it was built to catch. So neither is taken on
 *   trust. A wrapper qualifies only when its own signature takes a spawn result
 *   AND its own body COMPARES that parameter's `.status`: an `.error` test
 *   answers "did the process start", not "did it succeed", and a mention of
 *   `.status` inside a failure message is not a reading of it. The matched
 *   comparison is PRINTED for every wrapper, so the report says what was
 *   measured rather than asserting it — the coordinator's round-7 B3(i), where
 *   the old report printed "reads r.status" for a wrapper qualifying on
 *   `.error` alone. A wrapper is resolved in the calling file first; a
 *   same-named helper in another file says nothing about this call.
 *
 *   Case 4 replaces a blanket exemption for any spawn line containing `return`
 *   or `=>` — B3(ii). That exemption was never declared in this header, and
 *   `pg-cluster.ts`'s `run()` is exactly its shape: two of its callers
 *   discarded the code, so the sweep was certifying the class it exists to
 *   catch. Forwarding is legitimate, but it only MOVES the decision; so every
 *   forwarder is named with all of its call sites, and when one discards the
 *   code BOTH the spawn site and that call site are reported.
 *
 * WHAT IT DOES NOT DECIDE
 *   That a tool reads an exit code does not make the tool correct; it only
 *   removes one way for it to be silently wrong. And this sweep is a text
 *   reading of the pack, not of the program's behaviour: `npm run
 *   verify:exit-codes:phase15 -- --prove` is what shows it can go red. It reads
 *   the pack's SYNTAX, not its types: no program is executed and no symbol is
 *   resolved through a type checker.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const PACK = process.env.P15_SWEEP_DIR ?? join(ROOT, 'scripts/phase15');

/**
 * THE EXEMPTION IS GONE (round 19, F-R19-03). THIS FILE IS SWEPT LIKE THE REST.
 *
 * This file is in the pack it reads, and its red proofs carry the SOURCE TEXT
 * of the defects they plant, so the original worry was that a sweep would
 * report its own plant literals. That worry was answered years of rounds ago
 * by reading the AST instead of the text: a plant inside a string is not a
 * call expression, whatever column it starts in. What remained was an
 * exemption that deleted one file from the scan — and it then failed open four
 * times, each time on the one file whose discarded exit codes nothing else can
 * see:
 *
 *   F-R16-01  the check named one spelling of `child_process` and read the text
 *   F-R17-02  the producer lived in a sibling, and the check resolved per file
 *   F-R18-04  the producer was DEFAULT-exported, which the pack map did not carry
 *   F-R19-03  the sibling was reached by a DYNAMIC import, which the leaf test
 *             did not walk — while the output said «Any pack import withdraws
 *             the exemption»
 *
 * Each fix enumerated one more form; the next form nobody enumerated reopened
 * it. The coordinator's ruling on this pack's other four-time fail-open (the
 * Phase 5 `f-50-quote` exemption) applies here unchanged: DELETE THE
 * EXEMPTION. The law now scans every file in the pack, this one included.
 *
 * MEASURED before deciding, on the real pack: with the exemption removed the
 * sweep reads `EXIT 0 — every spawnSync in <pack> has its exit code read: 81
 * site(s)` — three more sites than the 78 it reported while skipping itself,
 * and all three read. So the exemption was buying nothing and hiding a file.
 */

interface Wrapper {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  /** The DECLARATION this wrapper is, so a callee can be resolved to it rather
   *  than merely spelled like it (round 13, F-R13-03). */
  readonly decl: ts.Node;
  readonly param: string;
  /** The comparison actually matched in its body — printed, not asserted. */
  readonly matched: string;
}
interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly bound: string | null;
  readonly via: Wrapper | null;
  /** How the code is read, when it is: printed so the reader can check it. */
  readonly how: string | null;
}

const sources = (dir: string): ReadonlyMap<string, readonly string[]> => {
  const out = new Map<string, readonly string[]>();
  for (const name of readdirSync(dir).sort()) if (name.endsWith('.ts')) out.set(name, readFileSync(join(dir, name), 'utf8').split('\n'));
  return out;
};

/* ── scope-correct reading, through the TypeScript AST ────────────────────── */

/**
 * WHY THIS IS AN AST AND NOT A WINDOW OF TEXT
 *   The coordinator's round-8 N1 measured the cost of deciding by text
 *   proximity. The old rule accepted any `<name>.status <op>` within the next
 *   28 lines, matching on the NAME alone: function boundaries and re-bindings
 *   were invisible to it. So `secret-scan-proof.ts`'s `sh()` — which binds
 *   `const r = spawnSync(…)` and forwards it — was credited with a comparison
 *   made on a completely different `r`, eighteen lines later, inside another
 *   function's arrow body. Renaming that unrelated `r` turned the sweep red,
 *   which is the proof that the green verdict was resting on it. Two
 *   neighbouring shapes passed for the same reason: a same-named binding in
 *   the next function, and an unrelated spawn sitting within three lines of a
 *   `must(` call it was never an argument to.
 *
 *   A name is not a variable. So every decision below is bound to a
 *   DECLARATION: an identifier is resolved by walking its own scope chain, and
 *   only a `.status` read whose subject resolves to the SAME declaration as the
 *   spawn's result counts. Argument position is settled the same way — the
 *   spawn call must be a syntactic descendant of the wrapper call's arguments,
 *   not merely near it in the text.
 *
 *   The one approximation left, and it is named rather than hidden: `var`
 *   hoisting is not modelled, because the pack contains no `var`. A `var`
 *   declared in a nested block and read in its enclosing function would not
 *   resolve. That is a direction this sweep under-credits, never over-credits.
 */
const COMPARISONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanEqualsToken,
]);

const parsed = new Map<string, ts.SourceFile>();
function ast(key: string, text: string): ts.SourceFile {
  const have = parsed.get(key);
  if (have !== undefined) return have;
  const sf = ts.createSourceFile(key, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  parsed.set(key, sf);
  return sf;
}

const lineOf = (sf: ts.SourceFile, n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
const textOf = (sf: ts.SourceFile, n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 60);

const isScope = (n: ts.Node): boolean =>
  ts.isSourceFile(n) ||
  ts.isBlock(n) ||
  ts.isModuleBlock(n) ||
  ts.isCaseBlock(n) ||
  ts.isForStatement(n) ||
  ts.isForOfStatement(n) ||
  ts.isForInStatement(n) ||
  ts.isFunctionLike(n);

function bindingHas(name: ts.BindingName, want: string): boolean {
  if (ts.isIdentifier(name)) return name.text === want;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && bindingHas(el.name, want));
}

/** A function-like node's block body, when it has one. */
function bodyBlockOf(n: ts.Node): ts.Block | null {
  if (!ts.isFunctionLike(n)) return null;
  const body = (n as ts.FunctionLikeDeclarationBase).body;
  return body !== undefined && ts.isBlock(body) ? body : null;
}

/** The declarations this scope introduces ITSELF — not those of nested scopes. */
function declaredDirectly(scope: ts.Node, want: string): ts.Node | null {
  if (ts.isFunctionLike(scope)) for (const p of scope.parameters) if (bindingHas(p.name, want)) return p;
  if (
    (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer)
  )
    for (const d of scope.initializer.declarations) if (bindingHas(d.name, want)) return d;
  const statements: readonly ts.Statement[] =
    ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
      ? scope.statements
      : ts.isCaseBlock(scope)
        ? scope.clauses.flatMap((c) => [...c.statements])
        : (bodyBlockOf(scope)?.statements ?? []);
  for (const st of statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (bindingHas(d.name, want)) return d;
    } else if (ts.isFunctionDeclaration(st) && st.name !== undefined && st.name.text === want) return st;
  }
  return null;
}

/** The declaration an identifier refers to, by its own scope chain. */
function resolve(id: ts.Identifier): ts.Node | null {
  for (let n: ts.Node | undefined = id.parent; n !== undefined; n = n.parent) {
    if (!isScope(n)) continue;
    const hit = declaredDirectly(n, id.text);
    if (hit !== null) return hit;
  }
  return null;
}

/** The function a node sits in, or the source file when it sits at top level. */
function enclosingFunction(n: ts.Node): ts.Node {
  for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return p;
  return n.getSourceFile();
}

/** Every identifier in `scope` that resolves to `decl`, excluding its own name. */
function usesOf(decl: ts.Node, want: string, scope: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === want && n.parent !== decl && resolve(n) === decl) out.push(n);
    n.forEachChild(walk);
  };
  walk(scope);
  return out;
}

/** Is this expression used as a DECISION — compared, negated, or a condition? */
function decidedHere(e: ts.Expression, sf: ts.SourceFile): string | null {
  const p = e.parent;
  if (ts.isBinaryExpression(p) && COMPARISONS.has(p.operatorToken.kind)) return textOf(sf, p);
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return textOf(sf, p);
  if (ts.isIfStatement(p) && p.expression === e) return `if (${textOf(sf, e)})`;
  if (ts.isConditionalExpression(p) && p.condition === e) return `${textOf(sf, e)} ? … : …`;
  if (ts.isWhileStatement(p) && p.expression === e) return `while (${textOf(sf, e)})`;
  if (ts.isDoStatement(p) && p.expression === e) return `do … while (${textOf(sf, e)})`;
  if (ts.isSwitchStatement(p) && p.expression === e) return `switch (${textOf(sf, e)})`;
  if (ts.isCaseClause(p) && p.expression === e) return `case ${textOf(sf, e)}`;
  if (ts.isParenthesizedExpression(p)) return decidedHere(p, sf);
  return null;
}

/**
 * A decision on the exit code of the value `decl` holds, or null.
 *
 * Only `<id>.status` where `<id>` resolves to `decl` counts, searched inside
 * the function `decl` lives in. One alias hop is allowed and measured: `const
 * code = r.status;` followed by a decision on `code` IS a decision on the exit
 * code, and refusing it would push the pack toward shapes chosen to satisfy
 * this sweep rather than to be read. A mention inside a template literal or a
 * message string is not a decision: it reaches none of the positions above.
 */
function statusDecisionOf(decl: ts.Node, want: string, sf: ts.SourceFile): string | null {
  const scope = enclosingFunction(decl);
  for (const id of usesOf(decl, want, scope)) {
    const p = id.parent;
    if (!ts.isPropertyAccessExpression(p) || p.expression !== id || p.name.text !== 'status') continue;
    const direct = decidedHere(p, sf);
    if (direct !== null) return direct;
    // the one alias hop, both halves measured
    if (ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) {
      const alias = p.parent;
      const aliasName = alias.name.getText(sf);
      for (const use of usesOf(alias, aliasName, enclosingFunction(alias))) {
        const viaAlias = decidedHere(use, sf);
        if (viaAlias !== null) return `${want}.status → ${aliasName}: ${viaAlias}`;
      }
    }
  }
  return null;
}

/** Wrappers whose own body DECIDES on the exit code of the result handed to them. */
function wrappersIn(src: ReadonlyMap<string, readonly string[]>): readonly Wrapper[] {
  const found: Wrapper[] = [];
  for (const [file, lines] of src) {
    const sf = ast(file, lines.join('\n'));
    const walk = (n: ts.Node): void => {
      if (ts.isFunctionLike(n)) {
        const takes = n.parameters.find(
          (p) => p.type !== undefined && /\bSpawnSyncReturns\b|ReturnType<typeof spawnSync>/.test(p.type.getText(sf)) && ts.isIdentifier(p.name),
        );
        const name = functionNameOf(n, sf);
        if (takes !== undefined && name !== null) {
          const param = takes.name.getText(sf);
          const matched = statusDecisionOf(takes, param, sf);
          const decl = n.parent !== undefined && ts.isVariableDeclaration(n.parent) ? n.parent : n;
          if (matched !== null) found.push({ name, file, line: lineOf(sf, n) + 1, decl, param, matched });
        }
      }
      n.forEachChild(walk);
    };
    walk(sf);
  }
  return found;
}

/** The name a function is known by: its own, or the const it is assigned to. */
function functionNameOf(fn: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) return fn.name.text;
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p !== undefined && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p !== undefined && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  void sf;
  return null;
}

/**
 * A FORWARDER IS A BINDING, NOT A SPELLING (F-R12-01).
 *
 * Round 12 renamed one import and the sweep went silent: the site enumeration
 * matched the callee's bare TOKEN, and the file filter matched the LOCAL name
 * of a named import, so `import { run as gitRun }` both skipped the file and
 * failed to recognise `gitRun(…)` inside it. A discarding call site hid behind
 * a two-word edit. So the names a file calls a binding by are now RESOLVED —
 * from the import that introduces it — rather than assumed to be its spelling
 * at the declaration.
 *
 * `home` is the file that declares the binding, or a bare module id such as
 * `node:child_process` for the producer itself. Only relative specifiers are
 * resolved against the pack, which is one flat directory.
 */
interface Aliases {
  readonly ids: ReadonlySet<string>;
  readonly ns: ReadonlySet<string>;
}

/** A module specifier as a pack key: the pack is one flat directory. */
const specKey = (spec: string): string => (spec.startsWith('.') ? `${basename(spec).replace(/\.(?:m|c)?[jt]s$/, '')}.ts` : spec);

/**
 * The pack's sources, so a re-export can be followed — set once per sweep.
 *
 * Round 13's F-R13-02: resolving an import only against the module it names
 * left three routes open, each of which hid the X16 discarding caller —
 * `export { raw } from './home'`, `export * from './home'`, and a default
 * export. A barrel file is the ordinary way a pack grows, so a rule that stops
 * at the first specifier is a rule one file re-organisation disables.
 */
let PACK_SRC: ReadonlyMap<string, readonly string[]> | null = null;

/** Does `mod` provide `name`, directly or through re-exports, from `home`'s `token`? */
function provides(mod: string, name: string, home: string, token: string, seen: Set<string>): boolean {
  if (mod === home) return name === token;
  const key = `${mod}::${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const lines = PACK_SRC?.get(mod);
  if (lines === undefined) return false;
  const sf = ast(mod, lines.join('\n'));
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier === undefined || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = specKey(st.moduleSpecifier.text);
    if (st.exportClause === undefined) {
      // `export * from './x'` — the name keeps its spelling through the star.
      if (provides(target, name, home, token, seen)) return true;
      continue;
    }
    if (!ts.isNamedExports(st.exportClause)) continue;
    for (const el of st.exportClause.elements) if (el.name.text === name && provides(target, (el.propertyName ?? el.name).text, home, token, seen)) return true;
  }
  return false;
}

/** Is `home`'s DEFAULT export the declaration named `token`? */
function defaultIsToken(home: string, token: string): boolean {
  const lines = PACK_SRC?.get(home);
  if (lines === undefined) return false;
  const sf = ast(home, lines.join('\n'));
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression) && st.expression.text === token) return true;
    if (
      ts.isFunctionDeclaration(st) &&
      st.name !== undefined &&
      st.name.text === token &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true
    )
      return true;
  }
  return false;
}

function aliasesOf(sf: ts.SourceFile, token: string, home: string, file: string): Aliases {
  const ids = new Set<string>();
  const ns = new Set<string>();
  if (file === home) ids.add(token);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = specKey(st.moduleSpecifier.text);
    const clause = st.importClause;
    if (clause === undefined) continue;
    // `import raw from './barrel'` — a default export, possibly re-exported.
    if (clause.name !== undefined && (target === home ? defaultIsToken(home, token) : provides(target, 'default', home, token, new Set<string>())))
      ids.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb === undefined) continue;
    if (ts.isNamedImports(nb)) {
      for (const el of nb.elements) if (provides(target, (el.propertyName ?? el.name).text, home, token, new Set<string>())) ids.add(el.name.text);
    } else if (ts.isNamespaceImport(nb) && target === home) {
      ns.add(nb.name.text);
    }
  }
  return { ids, ns };
}

/** Is this file able to see `token` from `home` at all? */
const sees = (a: Aliases): boolean => a.ids.size > 0 || a.ns.size > 0;

/**
 * Calls to a resolved binding: any local name it was imported under, or a
 * namespace import of its home read as `ns.token(…)`.
 *
 * `net` widens the match to a property access of that name on ANY expression,
 * which is how `spawnSync` reached through `cp.spawnSync` / a require before
 * this change. It over-reports rather than under-reports, so it stays for the
 * producer: a site named twice is noise, a site never named is the defect.
 */
function callsTo(sf: ts.SourceFile, a: Aliases, token: string, net: boolean): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isIdentifier(c) && a.ids.has(c.text)) out.push(n);
      else if (ts.isPropertyAccessExpression(c) && c.name.text === token && (net || (ts.isIdentifier(c.expression) && a.ns.has(c.expression.text))))
        out.push(n);
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return out;
}

/**
 * Calls to the producer itself, under whatever name this file imported it.
 *
 * ROUND 13's F-R13-01, AND THE WORST KIND OF FINDING: narrowing this to the
 * resolved binding made the sweep BLIND to a shape the previous head reported.
 * `import { spawnSync } from 'child_process'` — the same module without the
 * `node:` prefix — resolved to no alias at all, so a discarding call in such a
 * file was not enumerated and the sweep printed EXIT 0 over it. A fix for a
 * hiding rule that hides more than it found is a regression, not a fix.
 *
 * So the producer keeps its OLD behaviour as a FLOOR — every identifier and
 * every property access spelled `spawnSync`, from wherever — and the alias
 * resolution is added ON TOP of it, for the renamed-import case. For the
 * producer, over-reporting is noise and under-reporting is a fail-open, so the
 * two are not symmetric and the union is the only safe shape.
 */
/**
 * EVERY WAY A NAME COMES TO MEAN `spawnSync` (round 16, F-R16-01/02).
 *
 * This started as "follow the import", grew "follow `require(…)` destructured
 * from a string naming child_process", and round 16 measured what that still
 * could not see: seven of ten shapes, including the plainest of them all —
 * `import { spawnSync } from 'node:child_process'; const run = spawnSync;` —
 * each discarding a real exit code under `EXIT 0 … 0 site(s)`. Keying on the
 * module specifier was the mistake: a specifier can be a template literal, a
 * variable, a default export, or absent entirely when the module object is
 * already in hand.
 *
 * So the specifier is not read at all. What was read instead, from round 16
 * to round 19, was a LIST OF SHAPES the value could come from — a destructure
 * key, a property-access initializer, a known name — and that list is what
 * round 20 replaced: every round added the shapes the previous round's
 * challenger had walked through, and round 20 walked through five more in one
 * pass. The rule below asks one question instead of listing shapes, and this
 * paragraph is kept only because it names the mistake the next reader will be
 * tempted to repeat: a specifier is not an identity, and a shape list is not
 * a rule.
 */
const TOKEN = 'spawnSync';

/**
 * THE DEFAULT IS INVERTED (round 20, F-R20-01 and F-R20-02).
 *
 * Rounds 13 to 19 each added the shapes the previous round's challenger had
 * walked through: a module spelling, a destructure, a property access, an
 * element access, a parameter, an object field, four export forms, a dynamic
 * import, a NamespaceExport, a class field, a returned producer. Round 20
 * walked through five more in one pass — a parameter DEFAULT, an
 * `ArrayBindingPattern`, `this.go = spawnSync` in a constructor, an object
 * GETTER, and the round-19 returned-producer rule itself, which was written
 * per file and published nothing across the boundary. Measured here with the
 * challenger's own plants before anything changed: four of them read
 * `EXIT 0 … 81 site(s)`, the same number as the untouched pack, while the
 * plain control read `EXIT 1`.
 *
 * A list of shapes is a list of the shapes somebody thought of. So the
 * resolution no longer asks WHICH SHAPE a binding has. It asks one question
 * about the VALUE REGION of any binding at all:
 *
 *   does this region MENTION the producer anywhere outside callee position?
 *
 * If it does, every name the binding declares is a producer name. The target
 * side is read by collecting the names a pattern binds and the property names
 * a region declares, whatever syntax binds them — so an array pattern, a
 * nested pattern, a parameter default, a getter, a class member and
 * `this.x = …` are all one rule, and so is the next form nobody has named.
 *
 * TWO DISTINCTIONS KEEP THIS FROM FLAGGING THE WHOLE PACK, and both are
 * measured rather than argued (the untouched pack must still read EXIT 0):
 *
 *   · CALLEE POSITION IS A USE, NOT A FLOW. `const r = spawnSync(…)` binds a
 *     RESULT, and `const out = api.run('git')` binds a result too. So a call's
 *     callee subtree is not read as a mention; only its arguments are, and the
 *     OBJECT of a method call, because a call on a container that holds the
 *     producer can hand it back. This is also what keeps the wrapper and
 *     forwarder rules separate from this one: a helper that CALLS the producer
 *     is a wrapper, measured by its own rules below, not a producer.
 *   · A FUNCTION THAT RETURNS THE PRODUCER IS NOT THE PRODUCER. Calling it
 *     yields one; calling the producer runs a command. They are two sets —
 *     `ids`/`members` and `returners` — and `returners` crosses the module
 *     boundary, which is what F-R20-01's fifth shape was missing.
 *
 * TYPE POSITIONS ARE NOT VALUE FLOW. `go: typeof spawnSync` declares nothing
 * about what `go` holds, so type nodes are skipped; the plant that writes that
 * annotation is caught by its constructor ASSIGNMENT instead, which is the
 * reason it is a producer.
 *
 * Over-reporting stays the declared behaviour (F-R13-01): a name this
 * resolution adds that never holds the producer costs a reader one line, and a
 * name it misses hides a command nobody checked. The control X9 and the
 * untouched-pack baseline X0 are what keep the noise honest.
 */

/** What a file's producer resolution yields: names, member names, namespaces. */
interface Producers {
  /** Local identifiers that MEAN the producer. */
  readonly ids: ReadonlySet<string>;
  /** Property names a producer was stored under: `{ run: spawnSync }` → `run`. */
  readonly members: ReadonlySet<string>;
  /** A namespace local name → the pack file it names. */
  readonly ns: ReadonlyMap<string, string>;
  /** Names whose CALL yields the producer: `const run = makeRunner()`. */
  readonly returners: ReadonlySet<string>;
}

/** Is `e` an expression that MEANS the producer, under `p`? */
function isProducerExpr(e: ts.Expression, p: Producers): boolean {
  const x = unwrap(e);
  // A CONDITIONAL IS TWO BINDINGS IN ONE (round 18, F-R18-05). `unwrap()`
  // peels wrappers that have exactly one operand; a `?:`, a `||`, a `??` and
  // an `&&` each have two, and the producer may be in either.
  if (ts.isConditionalExpression(x)) return isProducerExpr(x.whenTrue, p) || isProducerExpr(x.whenFalse, p);
  if (
    ts.isBinaryExpression(x) &&
    (x.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  )
    return isProducerExpr(x.left, p) || isProducerExpr(x.right, p);
  if (ts.isPropertyAccessExpression(x) && (x.name.text === TOKEN || p.members.has(x.name.text) || namespaceProducer(x, p))) return true;
  if (
    ts.isElementAccessExpression(x) &&
    ts.isStringLiteral(x.argumentExpression) &&
    (x.argumentExpression.text === TOKEN || p.members.has(x.argumentExpression.text))
  )
    return true;
  // The CALL of a function that returns the producer IS the producer. Round 19
  // read this inside one file only, so `const runF = makeRunnerF()` with
  // `makeRunnerF` exported from a sibling was invisible while the identical
  // bytes in one file went red (round 20, F-R20-01).
  if (ts.isCallExpression(x)) {
    const c = unwrap(x.expression);
    if (ts.isIdentifier(c) && p.returners.has(c.text)) return true;
    if (ts.isPropertyAccessExpression(c) && (p.returners.has(c.name.text) || namespaceReturner(c, p))) return true;
    if (ts.isElementAccessExpression(c) && ts.isStringLiteral(c.argumentExpression) && p.returners.has(c.argumentExpression.text)) return true;
  }
  return ts.isIdentifier(x) && p.ids.has(x.text);
}

/**
 * Does `n` MENTION the producer outside callee position?
 *
 * This is the whole of the new rule's left-hand side. A call's callee subtree
 * is skipped — it is a use, and what the call binds is a RESULT — while its
 * arguments and the OBJECT of a method call are read. Type nodes are skipped:
 * an annotation is not a value.
 */
function mentionsProducer(n: ts.Node, p: Producers): boolean {
  let found = false;
  const visit = (x: ts.Node): void => {
    if (found || ts.isTypeNode(x)) return;
    if (ts.isCallExpression(x) || ts.isNewExpression(x)) {
      if (ts.isCallExpression(x) && isProducerExpr(x, p)) {
        found = true;
        return;
      }
      // ONE EXCEPTION, and it is the price of the callee rule: a call on an
      // OBJECT that holds a producer may hand it back — `map.get('go')`,
      // `list.find(…)`, `box.unwrap()`. The object is read, the method's own
      // name is not, so `const out = api.run('git')` still binds a result.
      const callee = unwrap(x.expression);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) visit(callee.expression);
      for (const a of x.arguments ?? []) visit(a);
      return;
    }
    if (ts.isExpression(x) && isProducerExpr(x, p)) {
      found = true;
      return;
    }
    x.forEachChild(visit);
  };
  visit(n);
  return found;
}

/** Every name a binding pattern binds, at any depth and in any pattern form. */
function boundNames(name: ts.BindingName): string[] {
  const out: string[] = [];
  const walk = (b: ts.Node): void => {
    if (ts.isIdentifier(b)) out.push(b.text);
    else if (ts.isObjectBindingPattern(b) || ts.isArrayBindingPattern(b)) for (const el of b.elements) walk(el);
    else if (ts.isBindingElement(b)) walk(b.name);
  };
  walk(name);
  return out;
}

/** The property name a property-like declaration declares, when it is static. */
function declaredMemberName(n: ts.Node): string | null {
  if (
    !ts.isPropertyAssignment(n) &&
    !ts.isShorthandPropertyAssignment(n) &&
    !ts.isGetAccessorDeclaration(n) &&
    !ts.isSetAccessorDeclaration(n) &&
    !ts.isMethodDeclaration(n) &&
    !ts.isPropertyDeclaration(n)
  )
    return null;
  const nm = n.name;
  return ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm) ? nm.text : null;
}

/** The VALUE region of a property-like declaration: its initializer or body. */
function memberValueRegion(n: ts.Node): ts.Node | undefined {
  if (ts.isPropertyAssignment(n)) return n.initializer;
  if (ts.isShorthandPropertyAssignment(n)) return n.name;
  if (ts.isPropertyDeclaration(n)) return n.initializer;
  if (ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isMethodDeclaration(n)) return n.body;
  return undefined;
}

/** The module a dynamic `import('./x')` names, or null. */
function dynamicTarget(e: ts.Expression): string | null {
  const x = unwrap(e);
  if (!ts.isCallExpression(x) || x.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const a = x.arguments[0];
  return a !== undefined && ts.isStringLiteral(a) ? specKey(a.text) : null;
}

function derivedProducers(
  sf: ts.SourceFile,
  seed: ReadonlySet<string>,
  seedMembers: ReadonlySet<string>,
  seedNs: ReadonlyMap<string, string>,
  seedReturners: ReadonlySet<string>,
): Producers {
  const ids = new Set<string>(seed);
  const members = new Set<string>(seedMembers);
  const ns = new Map<string, string>(seedNs);
  const returners = new Set<string>(seedReturners);
  /** Functions declared in this file, so a producer passed INTO one can be
   *  followed to the parameter it arrives as (round 17, F-R17-01). */
  const fns = new Map<string, ts.FunctionLikeDeclarationBase>();
  const collectFns = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) fns.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      const init = unwrap(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fns.set(n.name.text, init);
    }
    n.forEachChild(collectFns);
  };
  collectFns(sf);
  const self = (): Producers => ({ ids, members, ns, returners });
  const mentions = (n: ts.Node | undefined): boolean => n !== undefined && mentionsProducer(n, self());
  /** Does EVERY return of `fn` yield the producer? A function with no return
   *  at all, or one return that is not the producer, does not. */
  const returnsTheProducer = (fn: ts.FunctionLikeDeclarationBase): boolean => {
    if (fn.body === undefined) return false;
    const rets: ts.Expression[] = [];
    const scan = (x: ts.Node): void => {
      if (x !== fn && (ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || ts.isArrowFunction(x))) return;
      if (ts.isReturnStatement(x) && x.expression !== undefined) rets.push(x.expression);
      x.forEachChild(scan);
    };
    if (ts.isBlock(fn.body)) scan(fn.body);
    else rets.push(fn.body);
    return rets.length > 0 && rets.every((e) => isProducerExpr(e, self()));
  };
  /** `{ spawnSync: x }` / `{ spawnSync }`, as a binding pattern or a target —
   *  the KEY side, which the mention rule cannot see: here the producer is
   *  named by the property it is read FROM, not by a value in the region. */
  const fromKey = (n: ts.Node, from: string | null): void => {
    if (ts.isObjectBindingPattern(n))
      for (const el of n.elements) {
        const key = el.propertyName ?? el.name;
        if (!ts.isIdentifier(key) || !ts.isIdentifier(el.name)) continue;
        if (key.text === TOKEN) ids.add(el.name.text);
        // `const { sh } = await import('./lib')` — the same binding the static
        // import form already resolved (round 18, F-R18-06).
        if (from !== null) {
          const target = PACK_PRODUCER_EXPORTS.get(from);
          if (target?.ids.has(key.text) ?? false) ids.add(el.name.text);
          if (target?.returners.has(key.text) ?? false) returners.add(el.name.text);
        }
      }
    if (ts.isObjectLiteralExpression(n))
      for (const pr of n.properties) {
        if (ts.isShorthandPropertyAssignment(pr) && pr.name.text === TOKEN) ids.add(pr.name.text);
        if (ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name) && pr.name.text === TOKEN && ts.isIdentifier(pr.initializer)) ids.add(pr.initializer.text);
      }
  };
  // A fixpoint, because `const a = cp.spawnSync; const b = a;` is two steps and
  // the file may declare them in either order. It terminates because names are
  // only ever added.
  for (let before = -1; before !== ids.size + members.size + ns.size + returners.size; ) {
    before = ids.size + members.size + ns.size + returners.size;
    const walk = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n)) {
        const init = n.initializer === undefined ? undefined : unwrap(n.initializer);
        const dyn = n.initializer === undefined ? null : dynamicTarget(n.initializer);
        fromKey(n.name, dyn);
        // A dynamic import is a namespace under another syntax.
        if (dyn !== null && ts.isIdentifier(n.name)) ns.set(n.name.text, dyn);
        if (init !== undefined) {
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            if (returnsTheProducer(init)) for (const nm of boundNames(n.name)) returners.add(nm);
          } else if (mentions(init)) for (const nm of boundNames(n.name)) ids.add(nm);
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrap(n.left);
        fromKey(left, null);
        const right = unwrap(n.right);
        const isFn = ts.isArrowFunction(right) || ts.isFunctionExpression(right);
        const hit = isFn ? returnsTheProducer(right) : mentions(right);
        if (hit) {
          // `run = spawnSync`, `this.go = spawnSync`, `api['go'] = spawnSync`:
          // the TARGET side is read by what it NAMES, not by its shape.
          if (ts.isIdentifier(left)) (isFn ? returners : ids).add(left.text);
          else if (ts.isPropertyAccessExpression(left)) (isFn ? returners : members).add(left.name.text);
          else if (ts.isElementAccessExpression(left) && ts.isStringLiteral(left.argumentExpression))
            (isFn ? returners : members).add(left.argumentExpression.text);
          else if (ts.isObjectBindingPattern(left) || ts.isArrayBindingPattern(left)) for (const nm of boundNames(left)) ids.add(nm);
        }
      }
      // Every property-like declaration, in an object literal or a class body:
      // a field, a getter, a method, a shorthand. Its VALUE region decides,
      // and a getter's region is its RETURN, so `get go() { return spawnSync }`
      // makes `go` HOLD the producer while `go() { return spawnSync }` makes
      // `obj.go()` YIELD one.
      {
        const member = declaredMemberName(n);
        if (member !== null) {
          const region = memberValueRegion(n);
          if (ts.isMethodDeclaration(n)) {
            if (returnsTheProducer(n)) returners.add(member);
          } else if (ts.isGetAccessorDeclaration(n)) {
            if (returnsTheProducer(n)) members.add(member);
          } else if (region !== undefined) {
            const r = ts.isExpression(region) ? unwrap(region) : region;
            if (ts.isArrowFunction(r) || ts.isFunctionExpression(r)) {
              if (returnsTheProducer(r)) returners.add(member);
            } else if (mentions(r)) members.add(member);
          }
        }
      }
      // A PARAMETER DEFAULT is a binding like any other (round 20, F-R20-01):
      // `function head(run = spawnSync)` hands the producer to `run` with no
      // call site anywhere in the file.
      if (ts.isParameter(n) && n.initializer !== undefined && mentions(n.initializer)) for (const nm of boundNames(n.name)) ids.add(nm);
      // A named function whose every return is the producer.
      if (ts.isFunctionDeclaration(n) && n.name !== undefined && returnsTheProducer(n)) returners.add(n.name.text);
      // A producer handed to a local function ARRIVES as that parameter.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const fn = fns.get(n.expression.text);
        if (fn !== undefined)
          n.arguments.forEach((arg, k) => {
            const pm = fn.parameters[k];
            if (pm !== undefined && isProducerExpr(arg, self())) for (const nm of boundNames(pm.name)) ids.add(nm);
          });
      }
      n.forEachChild(walk);
    };
    walk(sf);
  }
  return { ids, members, ns, returners };
}

/**
 * A BINDING CROSSES FILES, AND THE FIXPOINT MUST CROSS WITH IT (round 17,
 * F-R17-01; widened in round 18 after F-R18-01, -02 and -03).
 *
 * The resolution above runs over ONE file. A pack that factors its helper out —
 * `export const sh = spawnSync` in one file, `import { sh }` in the next — put
 * the producer behind a value binding no `ExportDeclaration` carries, so
 * `provides()` found nothing and a discarding `sh(…)` was never enumerated:
 * the identical bytes in one file read `EXIT 1`, split across two read
 * `EXIT 0`, over the same discarded exit code. The forwarder half of this
 * sweep has crossed modules since F-R13-02; only the producer did not.
 *
 * Round 17 published one thing across the boundary — a set of exported NAMES —
 * and round 18 then found three more routes over the same wall, each with its
 * own one-file control going red: a DEFAULT export (`export default run`,
 * which is an `ExportAssignment` and not an `ExportDeclaration`), an exported
 * object whose FIELD holds the producer (`members` was computed and never
 * published), and an exported higher-order function handed the producer from
 * another file (the parameter route read a per-file map of local functions).
 * The lesson is not "add three more forms": it is that what crosses the
 * boundary must be the whole producer SURFACE of a module — its names, its
 * member names, and which of its parameters the pack hands a producer to —
 * because a surface published in part is a fixpoint that terminates early.
 *
 * So each file publishes that surface, a file importing from it seeds its own
 * resolution with the whole of it, and the pack iterates to a fixpoint. It
 * terminates because names are only ever added.
 */
interface Surface {
  /** Exported names that MEAN the producer. `default` is a name here. */
  readonly ids: ReadonlySet<string>;
  /** Field names this module stores a producer under, published to importers. */
  readonly members: ReadonlySet<string>;
  /** Names whose CALL yields the producer. Round 19 computed this per file and
   *  published none of it, so `const r = makeRunner()` with `makeRunner`
   *  exported from a sibling was invisible (round 20, F-R20-01). */
  readonly returners: ReadonlySet<string>;
}
const EMPTY_SURFACE: Surface = { ids: new Set<string>(), members: new Set<string>(), returners: new Set<string>() };
let PACK_PRODUCER_EXPORTS: ReadonlyMap<string, Surface> = new Map<string, Surface>();
/** `file` → `name#index` of each exported function parameter the pack hands a producer to. */
let PACK_PRODUCER_PARAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>();

/** `local name` → `{ file, exported name }` for every pack import in `sf`. */
function importSources(sf: ts.SourceFile): Map<string, { file: string; orig: string }> {
  const out = new Map<string, { file: string; orig: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause === undefined) continue;
    const file = specKey(st.moduleSpecifier.text);
    if (!(PACK_SRC?.has(file) ?? false)) continue;
    if (st.importClause.name !== undefined) out.set(st.importClause.name.text, { file, orig: 'default' });
    const nb = st.importClause.namedBindings;
    if (nb !== undefined && ts.isNamedImports(nb)) for (const el of nb.elements) out.set(el.name.text, { file, orig: (el.propertyName ?? el.name).text });
  }
  return out;
}

/** The producer surface `sf` hands to the rest of the pack under its own exports. */
function exportedProducers(sf: ts.SourceFile, p: Producers): Surface {
  const ids = new Set<string>();
  const members = new Set<string>(p.members);
  // `members` and `returners` are published WHOLESALE, as member names have
  // been since F-R13-01: a name is not a binding, so an importer that calls
  // `x.<name>()` cannot be resolved to a declaration from here, and
  // over-reporting a name is the declared cost of never losing one.
  const returners = new Set<string>(p.returners);
  const isExported = (st: ts.Statement): boolean =>
    ts.canHaveModifiers(st) && (ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && isExported(st))
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && p.ids.has(d.name.text)) ids.add(d.name.text);
    // `export default run` and `export = run` are ExportAssignments, which no
    // walk over ExportDeclarations can see (round 18, F-R18-01).
    if (ts.isExportAssignment(st) && isProducerExpr(st.expression, p)) ids.add('default');
    if (ts.isFunctionDeclaration(st) && st.name !== undefined && isExported(st) && p.returners.has(st.name.text)) returners.add(st.name.text);
    if (!ts.isExportDeclaration(st)) continue;
    if (st.moduleSpecifier === undefined) {
      if (st.exportClause !== undefined && ts.isNamedExports(st.exportClause))
        for (const el of st.exportClause.elements) if (p.ids.has((el.propertyName ?? el.name).text)) ids.add(el.name.text);
      continue;
    }
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = PACK_PRODUCER_EXPORTS.get(specKey(st.moduleSpecifier.text));
    if (from === undefined) continue;
    for (const m of from.members) members.add(m);
    for (const r of from.returners) returners.add(r);
    if (st.exportClause === undefined) {
      for (const n of from.ids) ids.add(n);
    } else if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (from.ids.has((el.propertyName ?? el.name).text)) ids.add(el.name.text);
      }
      for (const el of st.exportClause.elements) if (from.returners.has((el.propertyName ?? el.name).text)) returners.add(el.name.text);
    } else if (ts.isNamespaceExport(st.exportClause)) {
      // `export * as tools from './prod'` publishes the target's WHOLE surface
      // under one name: every exported producer of it is then a MEMBER of
      // `tools`, so `tools.sh(…)` is a call to one (round 19, F-R19-04).
      // `export *` was carried and this was not, because one has no clause and
      // the other has a NamespaceExport — a difference in syntax, not in reach.
      for (const n of from.ids) members.add(n);
      ids.add(st.exportClause.name.text);
    }
  }
  return { ids, members, returners };
}

/** The producer surface this file imports from elsewhere in the pack. */
function importedProducers(sf: ts.SourceFile): { ids: Set<string>; members: Set<string>; ns: Map<string, string>; returners: Set<string> } {
  const ids = new Set<string>();
  const members = new Set<string>();
  const ns = new Map<string, string>();
  const returners = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = specKey(st.moduleSpecifier.text);
    const from = PACK_PRODUCER_EXPORTS.get(target);
    if (from === undefined || st.importClause === undefined) continue;
    // Whatever this module stores a producer under, an importer can call
    // through (round 18, F-R18-02). Over-reporting a field name is the pack's
    // own F-R13-01 rule; losing one across a boundary is a fail-open.
    for (const m of from.members) members.add(m);
    for (const r of from.returners) returners.add(r);
    if (st.importClause.name !== undefined && from.ids.has('default')) ids.add(st.importClause.name.text);
    if (st.importClause.name !== undefined && from.returners.has('default')) returners.add(st.importClause.name.text);
    const nb = st.importClause.namedBindings;
    if (nb !== undefined && ts.isNamedImports(nb))
      for (const el of nb.elements) {
        const orig = (el.propertyName ?? el.name).text;
        if (from.ids.has(orig)) ids.add(el.name.text);
        if (from.returners.has(orig)) returners.add(el.name.text);
      }
    if (nb !== undefined && ts.isNamespaceImport(nb) && from.ids.size + from.members.size + from.returners.size > 0) ns.set(nb.name.text, target);
  }
  return { ids, members, ns, returners };
}

/** Parameters of this file's exported functions that the PACK hands a producer to. */
function packParameterSeed(sf: ts.SourceFile, file: string): Set<string> {
  const out = new Set<string>();
  const marks = PACK_PRODUCER_PARAMS.get(file);
  if (marks === undefined || marks.size === 0) return out;
  const consider = (name: string, fn: ts.FunctionLikeDeclarationBase): void => {
    fn.parameters.forEach((pm, k) => {
      if (ts.isIdentifier(pm.name) && marks.has(`${name}#${String(k)}`)) out.add(pm.name.text);
    });
  };
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && (ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name !== undefined) consider(st.name.text, st);
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
        const init = unwrap(d.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) consider(d.name.text, init);
      }
  }
  return out;
}

/** Every name this file calls the producer by, pack resolution included. */
function producersIn(sf: ts.SourceFile, file: string): Producers {
  const seed = new Set<string>([TOKEN]);
  for (const m of ['node:child_process', 'child_process']) for (const id of aliasesOf(sf, TOKEN, m, file).ids) seed.add(id);
  const imported = importedProducers(sf);
  for (const id of imported.ids) seed.add(id);
  for (const id of packParameterSeed(sf, file)) seed.add(id);
  return derivedProducers(sf, seed, imported.members, imported.ns, imported.returners);
}

/** Which exported parameters of OTHER pack files this file hands a producer to. */
function parameterHandoffs(sf: ts.SourceFile, p: Producers): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const src = importSources(sf);
  const mark = (file: string, key: string): void => {
    const s = out.get(file) ?? new Set<string>();
    s.add(key);
    out.set(file, s);
  };
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      let target: { file: string; orig: string } | null = null;
      if (ts.isIdentifier(c)) target = src.get(c.text) ?? null;
      else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) {
        const f = p.ns.get(c.expression.text);
        if (f !== undefined) target = { file: f, orig: c.name.text };
      }
      if (target !== null)
        n.arguments.forEach((arg, k) => {
          if (isProducerExpr(arg, p)) mark(target.file, `${target.orig}#${String(k)}`);
        });
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return out;
}

/** The pack-level fixpoint: run before any file is scanned. */
function resolvePackProducers(src: ReadonlyMap<string, readonly string[]>): void {
  PACK_PRODUCER_EXPORTS = new Map<string, Surface>();
  PACK_PRODUCER_PARAMS = new Map<string, ReadonlySet<string>>();
  for (let before = -1, total = 0; before !== total; ) {
    before = total;
    total = 0;
    const next = new Map<string, Surface>();
    const params = new Map<string, Set<string>>();
    for (const [file, lines] of src) {
      const sf = ast(file, lines.join('\n'));
      const p = producersIn(sf, file);
      const ex = exportedProducers(sf, p);
      next.set(file, ex);
      total += ex.ids.size + ex.members.size;
      for (const [target, keys] of parameterHandoffs(sf, p)) {
        const s = params.get(target) ?? new Set<string>();
        for (const k of keys) s.add(k);
        params.set(target, s);
      }
    }
    for (const s of params.values()) total += s.size;
    PACK_PRODUCER_EXPORTS = next;
    PACK_PRODUCER_PARAMS = params;
  }
}

function producerCalls(sf: ts.SourceFile, file: string): ts.CallExpression[] {
  const p = producersIn(sf, file);
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      if (ts.isIdentifier(c) && p.ids.has(c.text)) out.push(n);
      // The FLOOR: any `<expr>.spawnSync(…)`, plus a field the producer was
      // stored under, plus `ns.<exported producer>` for a namespace import.
      else if (ts.isPropertyAccessExpression(c) && (c.name.text === TOKEN || p.members.has(c.name.text) || namespaceProducer(c, p))) out.push(n);
      // `cp['spawnSync'](…)` — element access AT THE CALL SITE, which the
      // initializer rule covered and the callee match did not (round 17).
      else if (
        ts.isElementAccessExpression(c) &&
        ts.isStringLiteral(c.argumentExpression) &&
        (c.argumentExpression.text === TOKEN || p.members.has(c.argumentExpression.text))
      )
        out.push(n);
      // `makeRunner()(…)` and `map.get('go')(…)` — the callee is itself an
      // expression that YIELDS the producer, with no binding in between.
      else if (ts.isCallExpression(c) && isProducerExpr(c, p)) out.push(n);
      // Anything else whose callee expression MENTIONS a producer outside
      // callee position — `(cond ? run : other)(…)`, `fns[i](…)`. Conservative
      // by default: a call this sweep cannot show is NOT the producer is
      // reported, which is the inversion round 20 turns on.
      else if (mentionsProducer(c, p)) out.push(n);
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return out;
}

/**
 * `proc.sh(…)` where `proc` is a namespace of a file exporting `sh`.
 *
 * The chain is followed to its ROOT, because a namespace access need not be
 * one step: `ns.Runner.go(…)` reaches a class field through the module object
 * (round 19, F-R19-03), and a rule reading only `ns.<name>` saw an expression
 * whose own `expression` is another access and returned false. Over-reporting
 * a member name that the namespaced file publishes is this pack's declared
 * F-R13-01 behaviour; losing the route is a fail-open.
 */
function namespaceRoot(c: ts.PropertyAccessExpression, p: Producers): Surface | null {
  let root: ts.Expression = c.expression;
  for (;;) {
    const x = unwrap(root);
    if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) root = x.expression;
    else {
      root = x;
      break;
    }
  }
  if (!ts.isIdentifier(root)) return null;
  const file = p.ns.get(root.text);
  return file === undefined ? null : (PACK_PRODUCER_EXPORTS.get(file) ?? EMPTY_SURFACE);
}

/** `ns.makeRunner()` where the namespaced file's `makeRunner` returns one. */
function namespaceReturner(c: ts.PropertyAccessExpression, p: Producers): boolean {
  return namespaceRoot(c, p)?.returners.has(c.name.text) ?? false;
}

function namespaceProducer(c: ts.PropertyAccessExpression, p: Producers): boolean {
  let root: ts.Expression = c.expression;
  for (;;) {
    const x = unwrap(root);
    if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) root = x.expression;
    else {
      root = x;
      break;
    }
  }
  if (!ts.isIdentifier(root)) return false;
  const file = p.ns.get(root.text);
  if (file === undefined) return false;
  const s = PACK_PRODUCER_EXPORTS.get(file) ?? EMPTY_SURFACE;
  return s.ids.has(c.name.text) || s.members.has(c.name.text);
}

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  for (;;) {
    if (ts.isParenthesizedExpression(x)) x = x.expression;
    else if (ts.isAwaitExpression(x)) x = x.expression;
    else if (ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
    else return x;
  }
};

/**
 * Does the function this call sits in hand the result OUTWARD instead of
 * deciding on it?
 *
 * B3(ii): forwarding is legitimate, but it only MOVES the decision — so the
 * forwarder is named, its call sites are measured, and it is excused only when
 * every one of them decides. The shapes are measured on the AST: a `return` of
 * the call itself, a concise arrow body that IS the call, a `return` of the
 * bound name, or a returned object literal carrying that result or its status.
 */
function forwarderFor(call: ts.CallExpression, bound: ts.VariableDeclaration | null, sf: ts.SourceFile): string | null {
  const fn = enclosingFunction(call);
  if (ts.isSourceFile(fn)) return null;
  const name = functionNameOf(fn, sf);
  if (name === null) return null;
  const body = ts.isFunctionLike(fn) ? ((fn as ts.FunctionLikeDeclarationBase).body ?? null) : null;
  if (body === null) return null;
  if (!ts.isBlock(body)) return unwrap(body) === call || mentions(body, call, bound, sf) ? name : null;
  let forwards = false;
  const walk = (n: ts.Node): void => {
    if (forwards) return;
    if (ts.isFunctionLike(n) && n !== fn) return; // a nested function returns to ITS caller
    if (ts.isReturnStatement(n) && n.expression !== undefined && mentions(n.expression, call, bound, sf)) forwards = true;
    n.forEachChild(walk);
  };
  walk(body);
  return forwards ? name : null;
}

/**
 * Does this expression carry the SPAWN RESULT, by provenance?
 *
 * True only when it contains the call itself, or an identifier that resolves to
 * a declaration initialised by that call — the identifier binding, or the
 * destructuring one. A name that merely spells `status` proves nothing about
 * where its value came from.
 */
function yieldsCall(e: ts.Expression, call: ts.CallExpression): boolean {
  const x = unwrap(e);
  if (x === call) return true;
  // `const r = cond ? spawnSync(a) : spawnSync(b)` — the pack's own
  // `pg-version-matrix.ts` shape. The call's value flows into the binding, so
  // the binding carries its provenance; both branches are measured, so one
  // comparison on `r.status` decides both commands and neither is excused.
  if (ts.isConditionalExpression(x)) return yieldsCall(x.whenTrue, call) || yieldsCall(x.whenFalse, call);
  if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken))
    return yieldsCall(x.left, call) || yieldsCall(x.right, call);
  return false;
}

function fromSpawn(e: ts.Expression, call: ts.CallExpression, bound: ts.VariableDeclaration | null): boolean {
  let hit = false;
  const walk = (n: ts.Node): void => {
    if (hit) return;
    if (n === call) {
      hit = true;
      return;
    }
    if (ts.isIdentifier(n)) {
      const d = resolve(n);
      if (d !== null && (d === bound || (ts.isVariableDeclaration(d) && d.initializer !== undefined && yieldsCall(d.initializer, call)))) hit = true;
    }
    n.forEachChild(walk);
  };
  walk(e);
  return hit;
}

/**
 * Does this returned expression hand out the call's result, or its exit code?
 *
 * THE ROUND-9B FAIL-OPEN (F-R9B-01). This used to credit ANY returned object
 * literal carrying a property named `status`, whatever its value: a function
 * that ran a command, discarded its code and returned `{ status: 0, out }` was
 * read as a forwarder, and every call it covered was reported as measured. An
 * invented zero is the exact shape of the `sh()` defect this pack found in its
 * own code two rounds earlier, so the sweep was blind to its own lesson.
 *
 * The property's VALUE must now come from the spawn result. A spread of the
 * result counts, `{ status }` destructured from it counts, and `{ status: 0 }`
 * does not — nor does a result mentioned in some OTHER property while `status`
 * is invented, which is the same defect one key to the left.
 */
function mentions(e: ts.Expression, call: ts.CallExpression, bound: ts.VariableDeclaration | null, sf: ts.SourceFile): boolean {
  const x = unwrap(e);
  if (x === call) return true;
  if (ts.isObjectLiteralExpression(x)) {
    for (const prop of x.properties) {
      if (ts.isSpreadAssignment(prop) && fromSpawn(prop.expression, call, bound)) return true;
      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'status' && fromSpawn(prop.initializer, call, bound)) return true;
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'status' && fromSpawn(prop.name, call, bound)) return true;
    }
    return false;
  }
  return fromSpawn(x, call, bound);
}

/**
 * The wrapper a callee name in THIS file denotes — F-R12-02.
 *
 * This read `w.find((x) => x.file === file) ?? w[0]`, and that fallback did
 * exactly what this file's own header forbids: «a same-named helper in another
 * file says nothing about this call». A `check()` declared in `pg-cluster.ts`
 * excused a `check()` in a file that never imports it, and deleting the
 * fallback alone turns round 12's plant red while the real pack stays green —
 * so the fallback bought nothing and hid a class of calls.
 *
 * A wrapper is credited only when the callee name is BOUND to it: declared in
 * this file, or imported from the file that declares it, under whatever local
 * name the import gave it.
 */
function wrapperFor(callee: ts.Expression | undefined, wrappers: readonly Wrapper[], sf: ts.SourceFile, file: string): Wrapper | undefined {
  if (callee === undefined) return undefined;
  if (ts.isIdentifier(callee)) {
    // ROUND 13's F-R13-03: matching `w.file === file && w.name === callee` is
    // still a SPELLING test, one module in. A `gate(out: string)` declared at
    // the top of a file was credited with the laws of an unrelated
    // `gate(r: SpawnSyncReturns<string>)` nested inside another function of the
    // same file — renaming that nested helper turned the same call red, which
    // means the collision WAS the guard. A callee is resolved to the
    // declaration actually in scope at the call, and credited only if that
    // declaration IS a wrapper.
    const decl = resolve(callee);
    if (decl !== null) return wrappers.find((w) => w.file === file && w.decl === decl);
    for (const w of wrappers) if (w.file !== file && aliasesOf(sf, w.name, w.file, file).ids.has(callee.text)) return w;
    // Declared nowhere this resolver can see and imported from nowhere: an
    // ambient or top-level binding it cannot place. Crediting it would be the
    // `?? w[0]` fallback under another name.
    return undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const want = callee.name.text;
    for (const w of wrappers) if (w.name === want && aliasesOf(sf, w.name, w.file, file).ns.has(callee.expression.text)) return w;
  }
  return undefined;
}

type Decision = { readonly kind: 'read'; readonly how: string } | { readonly kind: 'defer'; readonly to: string } | null;

/**
 * Is the value this call yields decided upon? A reason when it is, a forwarder
 * name when the decision is deferred to one, null when the code is discarded.
 */
function decideCall(call: ts.CallExpression, sf: ts.SourceFile, wrappers: readonly Wrapper[], file: string): Decision {
  // 1. bound to a name, and that DECLARATION's own .status decided upon
  const parent = call.parent;
  const bound =
    parent !== undefined &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.initializer !== undefined &&
    unwrap(parent.initializer) === call
      ? parent
      : null;
  if (bound !== null && ts.isIdentifier(bound.name)) {
    const want = bound.name.text;
    const own = statusDecisionOf(bound, want, sf);
    if (own !== null) return { kind: 'read', how: `${want}: ${own}` };
    // handed to a wrapper that decides
    for (const id of usesOf(bound, want, enclosingFunction(bound))) {
      const p = id.parent;
      if (!ts.isCallExpression(p) || !p.arguments.includes(id)) continue;
      const via = wrapperFor(p.expression, wrappers, sf, file);
      if (via !== undefined) return { kind: 'read', how: `${want} → ${via.name}() at ${via.file}:${via.line}` };
    }
  }
  // 1b. DESTRUCTURED — `const { status } = run(…)` then a decision on `status`.
  //
  // The round-9 challenger named this as its next attack and could not run it:
  // the binding is neither a re-binding of an identifier nor a syntactic
  // descent into an argument, so neither rule above sees it. It is a real shape
  // — `{ status, out }` is what this pack's own helpers return — and the
  // decision is measured, not assumed: the element must be `status` (directly
  // or renamed) and that binding must itself be compared in its own scope.
  if (
    parent !== undefined &&
    ts.isVariableDeclaration(parent) &&
    ts.isObjectBindingPattern(parent.name) &&
    parent.initializer !== undefined &&
    unwrap(parent.initializer) === call
  ) {
    for (const el of parent.name.elements) {
      const prop = el.propertyName ?? el.name;
      if (!ts.isIdentifier(prop) || prop.text !== 'status' || !ts.isIdentifier(el.name)) continue;
      const bound2 = el.name.text;
      // the scope chain resolves a destructured name to its VariableDeclaration,
      // not to the element, so the element's own name is excluded here instead.
      for (const use of usesOf(parent, bound2, enclosingFunction(parent))) {
        if (use.parent === el) continue;
        const viaBinding = decidedHere(use, sf);
        if (viaBinding !== null) return { kind: 'read', how: `{ status } → ${bound2}: ${viaBinding}` };
      }
    }
  }
  // 2. decided on the spot, on the call expression itself
  const spot = (() => {
    const p = call.parent;
    if (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === call && p.name.text === 'status') return decidedHere(p, sf);
    return null;
  })();
  if (spot !== null) return { kind: 'read', how: `on the spot: ${spot}` };
  // 3. ARGUMENT POSITION — the call must be a descendant of the wrapper call's
  //    own arguments. N1's p2 passed on text proximity alone: a `must(` three
  //    lines up excused a spawn that was never inside its parentheses.
  for (let n: ts.Node | undefined = call.parent; n !== undefined; n = n.parent) {
    if (!ts.isCallExpression(n)) continue;
    if (!n.arguments.some((a) => a.pos <= call.pos && call.end <= a.end)) continue;
    const via = wrapperFor(n.expression, wrappers, sf, file);
    if (via !== undefined) return { kind: 'read', how: `argument to ${via.name}() at ${via.file}:${via.line}` };
  }
  // 4. forwarded outward
  const to = forwarderFor(call, bound, sf);
  return to === null ? null : { kind: 'defer', to };
}

interface Forwarder {
  readonly token: string;
  readonly safe: boolean;
  readonly sites: readonly { readonly file: string; readonly line: number; readonly text: string; readonly how: string | null }[];
}

interface SweepResult {
  readonly unchecked: readonly Site[];
  readonly read: readonly Site[];
  readonly wrappers: readonly Wrapper[];
  readonly forwarders: readonly Forwarder[];
}

function sweep(dir: string): SweepResult {
  parsed.clear(); // each pack copy is parsed on its own bytes
  const src = new Map(sources(dir));
  PACK_SRC = src;
  resolvePackProducers(src);
  const emptyPack: Site[] = [];
  if (src.size === 0)
    emptyPack.push({
      file: basename(dir),
      line: 0,
      text: 'the pack directory holds no TypeScript source at all: a sweep over nothing is not a clean sweep (residual R5)',
      bound: null,
      via: null,
      how: null,
    });
  const wrappers = wrappersIn(src);
  const sfOf = (file: string): ts.SourceFile => ast(file, (src.get(file) ?? []).join('\n'));

  type Raw = { file: string; line: number; text: string; d: Decision };
  const raws: Raw[] = [];
  for (const [file] of src) {
    const sf = sfOf(file);
    for (const call of producerCalls(sf, file))
      raws.push({ file, line: lineOf(sf, call), text: (src.get(file)?.[lineOf(sf, call)] ?? '').trim().slice(0, 78), d: decideCall(call, sf, wrappers, file) });
  }

  // Call sites of every forwarder a spawn site defers to, measured the same way.
  //
  // A forwarder is identified by FILE and name, not by name alone. `run()` is
  // declared in `pg-cluster.ts` and a different `run()` is a local in
  // `run-evidence-log.ts`; a name-only search attributes one's call sites to
  // the other and then names a defect in the wrong file. Call sites are looked
  // for where the name is actually visible: the declaring file, and any file
  // that imports that name.
  const tokens = new Set<string>();
  const keyOf = (file: string, token: string): string => `${file}::${token}`;
  for (const r of raws) if (r.d?.kind === 'defer') tokens.add(keyOf(r.file, r.d.to));
  const sitesOf = new Map<string, { file: string; line: number; text: string; d: Decision }[]>();
  const addToken = (key: string): void => {
    if (sitesOf.has(key)) return;
    const [home, token] = key.split('::') as [string, string];
    const sites: { file: string; line: number; text: string; d: Decision }[] = [];
    for (const [file] of src) {
      const sf = sfOf(file);
      // The binding, not the spelling (F-R12-01): a file is in scope when it
      // imports `token` from `home` under ANY local name, and the call sites
      // searched for are that local name — not the token's spelling at the
      // declaration, which an `as` clause silently replaces.
      const a = aliasesOf(sf, token, home, file);
      if (!sees(a)) continue;
      for (const call of callsTo(sf, a, token, false)) {
        const d = decideCall(call, sf, wrappers, file);
        const line = lineOf(sf, call);
        sites.push({ file, line, text: (src.get(file)?.[line] ?? '').trim().slice(0, 78), d });
        if (d?.kind === 'defer') tokens.add(keyOf(file, d.to));
      }
    }
    sitesOf.set(key, sites);
  };
  for (let pass = 0; pass < 6; pass += 1) for (const k of [...tokens]) addToken(k);

  const safe = new Set<string>();
  for (let pass = 0; pass < 6; pass += 1)
    for (const [key, sites] of sitesOf) {
      if (safe.has(key) || sites.length === 0) continue;
      const [, token] = key.split('::') as [string, string];
      if (
        sites.every(
          (s) => s.d?.kind === 'read' || (s.d?.kind === 'defer' && (s.d.to !== token || s.file !== key.split('::')[0]) && safe.has(keyOf(s.file, s.d.to))),
        )
      )
        safe.add(key);
    }

  const unchecked: Site[] = [...emptyPack];
  const read: Site[] = [];
  for (const r of raws) {
    const site = (how: string | null, note?: string): Site => ({
      file: r.file,
      line: r.line + 1,
      text: note === undefined ? r.text : `${r.text}   — ${note}`,
      bound: null,
      via: null,
      how,
    });
    if (r.d === null) unchecked.push(site(null));
    else if (r.d.kind === 'read') read.push(site(r.d.how));
    else if (safe.has(keyOf(r.file, r.d.to))) read.push(site(`forwarded by ${r.d.to}(), every call site measured`));
    else {
      const bad = (sitesOf.get(keyOf(r.file, r.d.to)) ?? []).filter((s) => s.d === null);
      unchecked.push(
        site(
          null,
          `forwarded by ${r.d.to}(), and ${bad.length === 0 ? 'nothing in the pack reads what it returns' : `${bad.length} call site(s) discard the code: ${bad.map((s) => `${s.file}:${s.line + 1}`).join(', ')}`}`,
        ),
      );
      for (const s of bad)
        unchecked.push({ file: s.file, line: s.line + 1, text: `${s.text}   — discards the code ${r.d.to}() returns`, bound: null, via: null, how: null });
    }
  }
  const forwarders: Forwarder[] = [...sitesOf].map(([key, sites]) => ({
    token: `${key.split('::')[1]} (${key.split('::')[0]})`,
    safe: safe.has(key),
    sites: sites.map((s) => ({
      file: s.file,
      line: s.line + 1,
      text: s.text,
      how: s.d === null ? null : s.d.kind === 'read' ? s.d.how : `deferred to ${s.d.to}()`,
    })),
  }));
  return { unchecked, read, wrappers, forwarders };
}

function report(dir: string, r: SweepResult): void {
  console.log(`  pack ${dir}`);
  // NOTHING IS EXEMPT (round 19, F-R19-03). The paragraph that used to stand
  // here described an exemption of one file from this scan, and said «Any pack
  // import withdraws the exemption» while a dynamic import walked past it. The
  // exemption is deleted, so there is no claim to print: the pack line above
  // covers every file, this instrument's own source included.
  console.log('');
  console.log('  WRAPPERS THAT DECIDE ON THE EXIT CODE THEMSELVES');
  console.log('    (the matched comparison is printed: a wrapper that only mentions the code, or');
  console.log('     tests .error alone, does not qualify and excuses nothing)');
  if (r.wrappers.length === 0) console.log('    none — so no call is excused by argument position');
  for (const w of r.wrappers) console.log(`    ${w.name} — ${w.file}:${w.line}, matched \`${w.matched}\``);
  console.log('');
  console.log('  FORWARDERS — functions that hand the result OUTWARD instead of deciding');
  console.log('    (declared, not exempt: each one is excused only when EVERY call site decides)');
  if (r.forwarders.length === 0) console.log('    none');
  for (const f of r.forwarders) {
    console.log(`    ${f.token}() — ${f.sites.length} call site(s), ${f.safe ? 'all measured' : 'NOT all measured'}`);
    for (const s of f.sites) console.log(`      ${s.file}:${s.line}  ${s.how ?? 'DISCARDS THE CODE'}`);
  }
  console.log('');
  console.log('  CALLS WHOSE EXIT CODE IS READ');
  if (r.read.length === 0) console.log('    none');
  for (const s of r.read) console.log(`    ${s.file}:${s.line}  ${s.how ?? ''}`);
  console.log('');
  console.log('  CALLS WHOSE EXIT CODE IS NEVER READ');
  if (r.unchecked.length === 0) console.log('    none');
  for (const s of r.unchecked) console.log(`    ${s.file}:${s.line}  ${s.text}`);
}

/* ── red proofs: can this sweep go red? ───────────────────────────────────── */

interface Plant {
  readonly id: string;
  readonly what: string;
  /** A control: correct code that must NOT redden. Counted apart from the reds. */
  readonly control?: boolean;
  readonly plant: (dir: string) => void;
  readonly expect: (r: ReturnType<typeof sweep>) => string | null; // null = as expected
}

const PLANTS: readonly Plant[] = [
  {
    id: 'X1',
    what: 'a bound spawn whose status is never read',
    plant: (dir) => {
      const f = join(dir, 'planted-x1.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          "const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });",
          'export const clean = (r.stdout ?? "").trim().length === 0;',
          '',
        ].join('\n'),
      );
    },
    expect: (r) => (r.unchecked.some((s) => s.file === 'planted-x1.ts') ? null : 'the sweep did not report a bound spawn whose exit code is never read'),
  },
  {
    id: 'X2',
    what: 'argument position inside a wrapper that does NOT read the code',
    plant: (dir) => {
      const f = join(dir, 'planted-x2.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          'function textOf(r: ReturnType<typeof spawnSync>): string {',
          '  return (r.stdout ?? "").toString();',
          '}',
          'export const dirty = textOf(',
          "  spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),",
          ').trim().length > 0;',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.wrappers.some((w) => w.name === 'textOf')
        ? 'textOf never reads .status and must not qualify as a wrapper'
        : r.unchecked.some((s) => s.file === 'planted-x2.ts')
          ? null
          : 'the sweep excused a call passed to a wrapper that ignores the exit code',
  },
  {
    id: 'X3',
    what: 'a real wrapper stops reading the code — every call it covers must fall back to unchecked',
    plant: (dir) => {
      const f = join(dir, 'verify-alert-signals.ts');
      const s = readFileSync(f, 'utf8');
      const broken = s.replace('if (r.error !== undefined || (r.status !== 0 && r.status !== 1))', 'if (false)');
      if (broken === s) throw new Error('X3 could not plant: searched() no longer reads r.status in the shape this proof edits');
      writeFileSync(f, broken);
    },
    expect: (r) =>
      r.wrappers.some((w) => w.name === 'searched')
        ? 'searched() no longer reads the exit code yet still qualified as a wrapper'
        : r.unchecked.some((s) => s.file === 'verify-alert-signals.ts')
          ? null
          : 'the calls searched() used to cover were not reported once it stopped reading the code',
  },
  {
    id: 'X4',
    what: 'the provenance read in the DR proof, with its exit code discarded again',
    plant: (dir) => {
      const f = join(dir, 'backup-restore-proof.ts');
      const s = readFileSync(f, 'utf8');
      const broken = s.replace(
        "  const shaOut = gitRead(['rev-parse', 'HEAD']);",
        "  const shaOut = (spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();",
      );
      if (broken === s) throw new Error('X4 could not plant: the DR proof no longer reads provenance through gitRead()');
      writeFileSync(f, broken);
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'backup-restore-proof.ts') ? null : 'the reintroduced discarded-status provenance read was not reported',
  },
  {
    id: 'X5',
    what: 'a wrapper reduced to its .error test — it answers "did it start", not "did it succeed"',
    plant: (dir) => {
      const f = join(dir, 'pg-version-matrix.ts');
      const s = readFileSync(f, 'utf8');
      const broken = s
        .replace("  if (r.status === 0) return (r.stdout ?? '').toString();", "  if (false) return (r.stdout ?? '').toString();")
        .replace("  if (allowNoMatch && r.status === 1) return (r.stdout ?? '').toString();", "  if (allowNoMatch) return (r.stdout ?? '').toString();");
      if (broken === s) throw new Error('X5 could not plant: outOf() no longer tests r.status in the shape this proof edits');
      writeFileSync(f, broken);
    },
    expect: (r) =>
      r.wrappers.some((w) => w.name === 'outOf')
        ? 'outOf() tests only .error yet still qualified as a wrapper, and the report would print a comparison it does not make'
        : r.unchecked.some((s) => s.file === 'pg-version-matrix.ts')
          ? null
          : 'the calls outOf() used to cover were not reported once it stopped comparing the status',
  },
  {
    id: 'X6',
    what: 'the cluster helper stops throwing on a non-zero exit — every call it forwards must fall back',
    plant: (dir) => {
      const f = join(dir, 'pg-cluster.ts');
      const s = readFileSync(f, 'utf8');
      const broken = s.replace(
        '  if (r.status !== 0) throw new ClusterError(`${what}: exit ${r.status}`',
        '  if (false) throw new ClusterError(`${what}: exit ${r.status}`',
      );
      if (broken === s) throw new Error('X6 could not plant: must() no longer compares r.status in the shape this proof edits');
      writeFileSync(f, broken);
    },
    expect: (r) =>
      r.wrappers.some((w) => w.name === 'must')
        ? 'must() no longer compares the status yet still qualified — the exit code is named only in its message'
        : r.unchecked.some((s) => s.file === 'pg-cluster.ts')
          ? null
          : "nothing was reported after the only wrapper deciding pg-cluster's exit codes stopped deciding",
  },
  {
    id: 'X7',
    what: 'the arrow form — a command run inside an arrow body, its code discarded',
    plant: (dir) => {
      const f = join(dir, 'planted-x7.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          "export const head = (): string => (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();",
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x7.ts')
        ? null
        : 'an arrow-bodied call whose exit code is discarded was exempted, which is the blanket `=>` exemption returning',
  },
  {
    id: 'X8',
    what: 'the return form — a forwarder whose caller discards what it hands back',
    plant: (dir) => {
      const f = join(dir, 'planted-x8.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          'function raw(args: readonly string[]): ReturnType<typeof spawnSync> {',
          "  return spawnSync('git', [...args], { encoding: 'utf8' });",
          '}',
          "export const dirty = (raw(['status', '--porcelain']).stdout ?? '').trim().length > 0;",
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x8.ts' && /forwarded by raw\(\)/.test(s.text))
        ? r.unchecked.some((s) => s.file === 'planted-x8.ts' && /discards the code/.test(s.text))
          ? null
          : 'the forwarder was reported but the call site that discards its code was not named'
        : 'a forwarder with a discarding caller was exempted — the decision was moved, not made',
  },
  {
    id: 'X10',
    what: "N1's p1 — a discarded spawn in one function, and a same-named variable compared in the NEXT one",
    plant: (dir) => {
      const f = join(dir, 'planted-x10.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          'export function dirty(): boolean {',
          "  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim().length > 0;",
          '}',
          'export function head(): string {',
          "  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  if (r.status !== 0) throw new Error('git rev-parse failed');",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x10.ts' && s.line === 3)
        ? null
        : "the discarded spawn in dirty() was credited with head()'s comparison on a different `r` of the same name",
  },
  {
    id: 'X11',
    what: "N1's p2 — a spawn three lines below a `must(` call it is not an argument to",
    plant: (dir) => {
      const f = join(dir, 'planted-x11.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync, type SpawnSyncReturns } from 'node:child_process';",
          'function insist(r: SpawnSyncReturns<string>, what: string): string {',
          '  if (r.status !== 0) throw new Error(`${what}: exit ${String(r.status)}`);',
          "  return r.stdout ?? '';",
          '}',
          "export const ok = insist(spawnSync('true', [], { encoding: 'utf8' }), 'true');",
          "export const listed = (spawnSync('git', ['ls-files'], { encoding: 'utf8' }).stdout ?? '').trim();",
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x11.ts' && s.line === 7)
        ? null
        : 'a spawn that is not inside the wrapper call’s parentheses was excused by its nearness to one',
  },
  {
    id: 'X12',
    what: "N1's third shape — the name is RE-BOUND in a nested scope, and the comparison belongs to the new binding",
    plant: (dir) => {
      const f = join(dir, 'planted-x12.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          'export function probe(paths: readonly string[]): readonly string[] {',
          "  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });",
          "  const lines = (r.stdout ?? '').split('\\n');",
          '  return paths.filter((p) => {',
          "    const r = spawnSync('git', ['ls-files', '--error-unmatch', p], { encoding: 'utf8' });",
          '    return r.status === 0 && lines.length >= 0;',
          '  });',
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x12.ts' && s.line === 3)
        ? null
        : "the outer spawn was credited with the inner binding's comparison: a re-bound name is a different variable",
  },
  {
    id: 'X13',
    what: "the round-9 challenger's own next attack: a spawn result taken through `const { status } = …` and never compared",
    plant: (dir) => {
      const f = join(dir, 'planted-x13.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          'export function listed(): readonly string[] {',
          "  const { status, stdout } = spawnSync('git', ['ls-files'], { encoding: 'utf8' });",
          '  void status;',
          "  return (stdout ?? '').split('\\n');",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x13.ts')
        ? null
        : 'a destructured spawn whose status is bound and never compared was excused — the binding is not the decision',
  },
  {
    id: 'X14',
    control: true,
    what: 'THE SECOND CONTROL — the same destructuring, with the status actually compared, must stay green',
    plant: (dir) => {
      const f = join(dir, 'planted-x14.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          'export function listed2(): readonly string[] {',
          "  const { status, stdout } = spawnSync('git', ['ls-files'], { encoding: 'utf8' });",
          "  if (status !== 0) throw new Error('git ls-files failed');",
          "  return (stdout ?? '').split('\\n');",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x14.ts')
        ? 'a destructured status that IS compared was reported anyway: a sweep that reds on correct code gets switched off'
        : null,
  },
  {
    id: 'X15',
    what: "round-9B's F-R9B-01 — a forwarder that INVENTS its status: the command's own code is discarded and `{ status: 0 }` handed on",
    plant: (dir) => {
      const f = join(dir, 'planted-x15.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          '// The shape the challenger planted: the function looks like every other',
          '// run-a-command helper in this pack, and the one thing it does not do is',
          "// read the exit code. Its caller's `if (r.status !== 0)` then decides on a",
          '// zero this function wrote itself.',
          'export function run(cmd: string, args: readonly string[]): { status: number; out: string } {',
          "  const r = spawnSync(cmd, [...args], { encoding: 'utf8' });",
          "  return { status: 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };",
          '}',
          'export function listed(): readonly string[] {',
          "  const r = run('git', ['ls-files']);",
          "  if (r.status !== 0) throw new Error('git ls-files failed');",
          "  return r.out.split('\\n');",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x15.ts')
        ? null
        : 'a helper that discarded the exit code and returned a hand-written `status: 0` was credited as a forwarder, so every command it runs reads as measured. An invented zero is the `sh()` defect this pack found in its own code two rounds earlier. The half this case cannot carry — that it is PROVENANCE catching it — is `npm run verify:exit-codes:phase15:guard`, which runs a copy of this sweep with that requirement removed; it lives in its own instrument because that half has to run a modified COPY of this sweep as a child process, and this file stays a reader of source — not because it is exempt from its own scan, which it no longer is (round 19, F-R19-03)',
  },
  {
    id: 'X16',
    what: "round 12's F-R12-01 — the SAME discarding caller as X8, hidden behind `import { raw as gitRaw }`",
    plant: (dir) => {
      // Two files, because the defect only exists across a module boundary: the
      // forwarder is declared in one and discarded in another, and the import
      // that joins them renames it. Before the fix the file filter matched the
      // LOCAL name of a named import, so `raw` found nothing and the file was
      // skipped entirely; the call `gitRaw(…)` would not have matched the token
      // anyway. X8 and this plant differ by two words on one import line, and
      // that difference used to be the difference between EXIT 1 and EXIT 0.
      writeFileSync(
        join(dir, 'planted-x16-home.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          'export function raw(args: readonly string[]): ReturnType<typeof spawnSync> {',
          "  return spawnSync('git', [...args], { encoding: 'utf8' });",
          '}',
          "export const clean = raw(['status', '--porcelain']).status === 0;",
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'planted-x16.ts'),
        [
          "import { raw as gitRaw } from './planted-x16-home.js';",
          "export const dirty = (gitRaw(['status', '--porcelain']).stdout ?? '').trim().length > 0;",
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x16.ts' && /discards the code/.test(s.text))
        ? null
        : 'a discarding call site was hidden by renaming the import it comes in under. A forwarder is a BINDING, not a spelling: if the sweep matches the token at the declaration rather than the local name the import introduced, one `as` clause silences it',
  },
  {
    id: 'X17',
    what: "round 12's F-R12-02 — a same-named wrapper in ANOTHER file, which this file never imports, must not excuse the call",
    plant: (dir) => {
      // The fallback this closes read `w.find((x) => x.file === file) ?? w[0]`:
      // with no wrapper of that name in this file, it credited the first one
      // found ANYWHERE. The file below declares its own `must` that reads
      // nothing, and the pack's real same-named helper is in another file it
      // does not import. The header always said «a same-named helper in another
      // file says nothing about this call»; the code said otherwise.
      writeFileSync(
        join(dir, 'planted-x17-home.ts'),
        [
          "import type { SpawnSyncReturns } from 'node:child_process';",
          'export function gate(r: SpawnSyncReturns<string>): void {',
          "  if (r.status !== 0) throw new Error('command failed');",
          '}',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'planted-x17.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          '// NOT imported from planted-x17-home.ts. A different function, same name,',
          '// and this one reads nothing at all.',
          'function gate(out: string): string {',
          '  return out.trim();',
          '}',
          "export const head = gate(spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '');",
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x17.ts')
        ? null
        : 'a call was excused by a wrapper of the same name in a file it does not import. Deleting the `?? w[0]` fallback alone turns this plant red and leaves the real pack green, so the fallback only ever bought false credit',
  },
  {
    id: 'X18',
    what: "round 13's F-R13-01 — the producer imported WITHOUT the `node:` prefix, which a binding-only rule stopped seeing",
    plant: (dir) => {
      const f = join(dir, 'planted-x18.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'child_process';",
          '// The same module, the same function, one prefix shorter. Round 12’s fix',
          '// resolved the producer through its import and nothing else, so this',
          '// file resolved to no binding and its call was never enumerated: the',
          '// sweep printed EXIT 0 over a shape the PREVIOUS head reported as',
          '// unchecked. The floor below the alias resolution is what this measures.',
          "spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });",
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x18.ts')
        ? null
        : 'a plain discarded spawnSync is invisible because its import spelled the module without `node:`. A rule that resolves bindings must ADD to the name floor, never replace it: for the producer, over-reporting is noise and under-reporting is a fail-open',
  },
  {
    id: 'X19',
    what: "round 13's F-R13-02 — the X16 discarding caller again, this time behind a re-export barrel",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x19-home.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          'export function raw(args: readonly string[]): ReturnType<typeof spawnSync> {',
          "  return spawnSync('git', [...args], { encoding: 'utf8' });",
          '}',
          "export const clean = raw(['status', '--porcelain']).status === 0;",
          '',
        ].join('\n'),
      );
      // Three routes in one plant: a named re-export, a star re-export of that
      // barrel, and the default. A rule that stops at the first module
      // specifier sees none of them.
      writeFileSync(join(dir, 'planted-x19-barrel.ts'), ["export { raw } from './planted-x19-home.js';", ''].join('\n'));
      writeFileSync(join(dir, 'planted-x19-star.ts'), ["export * from './planted-x19-barrel.js';", ''].join('\n'));
      writeFileSync(
        join(dir, 'planted-x19.ts'),
        [
          "import { raw as gitRaw } from './planted-x19-star.js';",
          "export const dirty = (gitRaw(['status', '--porcelain']).stdout ?? '').trim().length > 0;",
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x19.ts' && /discards the code/.test(s.text))
        ? null
        : 'a discarding call site was hidden by re-exporting the forwarder through a barrel. Following the import to the module it names is not enough: `export {…} from`, `export *` and a default export each move a declaration without moving its name, and a pack grows barrels as a matter of course',
  },
  {
    id: 'X20',
    what: "round 13's F-R13-03 — a same-named helper in the SAME file, which is not the wrapper in scope at the call",
    plant: (dir) => {
      const f = join(dir, 'planted-x20.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          "import type { SpawnSyncReturns } from 'node:child_process';",
          '// The wrapper that reads an exit code is NESTED inside another function,',
          '// so it is not in scope at the call below. The `gate` that IS in scope',
          '// trims a string. Matching the callee by name inside the file credited',
          "// the call with the nested helper's laws; renaming the nested one made",
          '// the same call red, which is how the collision was measured.',
          'export function outer(): void {',
          '  function gate(r: SpawnSyncReturns<string>): void {',
          "    if (r.status !== 0) throw new Error('command failed');",
          '  }',
          "  gate(spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }));",
          '}',
          'function gate(out: string): string {',
          '  return out.trim();',
          '}',
          "export const head = gate(spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '');",
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x20.ts')
        ? null
        : 'a call was credited with the laws of a same-named helper that is not in scope where the call is. A callee must be RESOLVED to the declaration the language would bind it to; a name match inside one file is the cross-file fallback again, one module in',
  },
  {
    id: 'X21',
    what: "round 15's F-R15-02 — the producer bound through `createRequire` and renamed, with no import declaration to follow",
    plant: (dir) => {
      const f = join(dir, 'planted-x21.ts');
      writeFileSync(
        f,
        [
          "import { createRequire } from 'node:module';",
          'const req = createRequire(__filename);',
          '// No import declaration binds spawnSync here, and the call is a bare',
          '// identifier, so the net over `<expr>.spawnSync(…)` does not see it',
          '// either. The exit code is thrown away.',
          "const { spawnSync: run } = req('child_process') as typeof import('node:child_process');",
          'export function head(): string {',
          "  const r = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x21.ts')
        ? null
        : 'a discarding call was hidden by binding the producer through a call instead of an import. Following import declarations is not enough: `require`, `createRequire` and a local alias of either bind the same function under any name the file likes',
  },
  {
    id: 'X22',
    what: "round 16's F-R16-02 — the producer taken as a PROPERTY of a module object, with no destructuring and no specifier to read",
    plant: (dir) => {
      const f = join(dir, 'planted-x22.ts');
      writeFileSync(
        f,
        [
          "import { createRequire } from 'node:module';",
          'const req = createRequire(__filename);',
          '// Neither an import clause nor a destructure: the value is reached by',
          '// property access on whatever the loader returned, and the specifier',
          '// here is not even a literal. Keying on the module name cannot see it.',
          "const where = 'child_' + 'process';",
          "const run = req(where).spawnSync as typeof import('node:child_process').spawnSync;",
          'export function head(): string {',
          "  const r = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x22.ts')
        ? null
        : 'a discarding call was hidden by taking the producer as a property of a module object. A rule keyed on the module SPECIFIER cannot see a template literal, a variable, or a module object already in hand; what identifies the producer is the NAME the value comes from',
  },
  {
    id: 'X23',
    what: "round 16's F-R16-02, the plainest shape of all — an imported binding assigned to another name",
    plant: (dir) => {
      const f = join(dir, 'planted-x23.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          '// One line, no indirection, invisible since before round 13: the import',
          '// is resolved, and then the call is made through a name the resolution',
          '// never produced.',
          'const run = spawnSync;',
          'export function head(): string {',
          "  const r = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x23.ts')
        ? null
        : 'a discarding call was hidden behind a plain re-binding of the imported name. Resolving the import and stopping there measures the name the import introduced, not the names the file calls the function by',
  },
  {
    id: 'X24',
    what: "round 17's F-R17-01 — the producer EXPORTED from one pack file and called, discarded, in another",
    plant: (dir) => {
      writeFileSync(join(dir, 'planted-x24-lib.ts'), ["import { spawnSync } from 'node:child_process';", 'export const x24run = spawnSync;', ''].join('\n'));
      writeFileSync(
        join(dir, 'planted-x24.ts'),
        [
          "import { x24run } from './planted-x24-lib';",
          '// The ordinary way a pack factors a helper out. No ExportDeclaration',
          '// carries the producer, so following re-export declarations finds',
          '// nothing, and the resolution that works inside one file stops at the',
          '// module boundary. The same bytes in ONE file were reported.',
          'export function head(): string {',
          "  const r = x24run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x24.ts')
        ? null
        : 'a discarding call was hidden by a MODULE BOUNDARY: the producer was exported from a sibling pack file under a value binding, and a fixpoint that runs per file cannot cross one. The forwarder half of this sweep has crossed modules since round 13',
  },
  {
    id: 'X25',
    what: "round 17's F-R17-01 — element access AT THE CALL SITE, `cp['spawnSync'](…)`",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x25.ts'),
        [
          "import * as cp from 'node:child_process';",
          '// Element access was added to the rule that reads an INITIALIZER and',
          '// not to the one that matches a CALLEE, so a binding taken this way',
          '// was followed while a call made this way was not.',
          'export function head(): string {',
          "  const r = cp['spawnSync']('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x25.ts')
        ? null
        : 'a discarding call was hidden by calling the producer through element access. A property access and an element access name the same member; a rule that reads one and not the other is a spelling rule again',
  },
  {
    id: 'X26',
    what: "round 17's F-R17-01 — the producer handed to a function and called through its PARAMETER",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x26.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          '// The producer arrives as an argument, so no binding in this file is',
          '// ever assigned it; the name that calls it is a parameter.',
          'function withRunner(run: typeof spawnSync): string {',
          "  const r = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return r.stdout ?? '';",
          '}',
          'export const head = withRunner(spawnSync);',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x26.ts')
        ? null
        : 'a discarding call was hidden by passing the producer INTO a function: the call is made through a parameter, which no assignment in the file ever names',
  },
  {
    id: 'X27',
    what: "round 17's F-R17-01 — the producer stored in an object FIELD under another name",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x27.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          '// `{ spawnSync: x }` was followed because the KEY is the token. Here',
          '// the key is anything at all and the VALUE is the producer.',
          'const x27api = { go: spawnSync };',
          'export function head(): string {',
          "  const r = x27api.go('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x27.ts')
        ? null
        : 'a discarding call was hidden by storing the producer in an object field under a different name, so neither the identifier set nor the `.spawnSync` floor could see the callee',
  },
  {
    id: 'X28',
    what: "round 18's F-R18-01 — the producer DEFAULT-exported from one pack file and called, discarded, in another",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x28-lib.ts'),
        ["import { spawnSync } from 'node:child_process';", 'const x28run = spawnSync;', 'export default x28run;', ''].join('\n'),
      );
      writeFileSync(
        join(dir, 'planted-x28.ts'),
        [
          "import x28run from './planted-x28-lib';",
          '// `export default` is an ExportAssignment, not an ExportDeclaration,',
          '// so round 17 published every exported producer NAME across the',
          '// boundary and still could not see this one. The forwarder half has',
          '// followed default exports since round 13; the producer half had not.',
          'export function head(): string {',
          "  const r = x28run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x28.ts')
        ? null
        : 'a discarding call was hidden by DEFAULT-exporting the producer: the pack fixpoint published named exports only, so the identical bytes read EXIT 1 in one file and EXIT 0 across two',
  },
  {
    id: 'X29',
    what: "round 18's F-R18-02 — the producer in an exported object FIELD, called from another pack file",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x29-lib.ts'),
        ["import { spawnSync } from 'node:child_process';", 'export const x29api = { go: spawnSync };', ''].join('\n'),
      );
      writeFileSync(
        join(dir, 'planted-x29.ts'),
        [
          "import { x29api } from './planted-x29-lib';",
          '// This is X27 with one module boundary in it. The field name was',
          '// computed by the per-file resolution and never published, so the',
          '// importing file had no way to know that `.go` means the producer.',
          'export function head(): string {',
          "  const r = x29api.go('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x29.ts')
        ? null
        : 'a discarding call was hidden by storing the producer in a field of an EXPORTED object: a surface published in part is a fixpoint that terminates early',
  },
  {
    id: 'X30',
    what: "round 18's F-R18-03 — the producer handed from one pack file to an exported function's PARAMETER in another",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x30-lib.ts'),
        [
          "import type { spawnSync as SS } from 'node:child_process';",
          'export function x30with(run: typeof SS): string {',
          "  const r = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return r.stdout ?? '';",
          '}',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(dir, 'planted-x30.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          "import { x30with } from './planted-x30-lib';",
          '// X26 with one module boundary. The declaring file never sees an',
          '// argument, so its parameter was never a producer; which parameters',
          '// the PACK hands a producer to is part of a module surface too.',
          'export const head = x30with(spawnSync);',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x30-lib.ts')
        ? null
        : "a discarding call was hidden by handing the producer ACROSS a boundary into a parameter: the declaring file's own fixpoint can never see the argument",
  },
  {
    id: 'X31',
    what: "round 18's F-R18-05 — a CONDITIONAL initializer, where the producer is in a branch",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x31.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          "const pick = process.env.P15_PICK === '1';",
          '// `unwrap()` peels wrappers with ONE operand. A `?:` has two, and a',
          '// value is a producer if either branch is.',
          'const x31run = pick ? spawnSync : spawnSync;',
          'export function head(): string {',
          "  const r = x31run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x31.ts')
        ? null
        : 'a discarding call was hidden behind a conditional initializer: a rule that reads only the whole expression misses a producer sitting in one of its branches',
  },
  {
    id: 'X32',
    what: "round 18's F-R18-06 — the pack file reached by a DYNAMIC import",
    plant: (dir) => {
      writeFileSync(join(dir, 'planted-x32-lib.ts'), ["import { spawnSync } from 'node:child_process';", 'export const x32run = spawnSync;', ''].join('\n'));
      writeFileSync(
        join(dir, 'planted-x32.ts'),
        [
          '// A dynamic import names a pack module as plainly as a static one; it',
          '// was simply not an ImportDeclaration, so nothing read it.',
          'export async function head(): Promise<string> {',
          "  const m = await import('./planted-x32-lib');",
          "  const r = m.x32run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x32.ts')
        ? null
        : 'a discarding call was hidden behind a dynamic import() of a pack file: the module graph a fixpoint walks must be the one the program walks',
  },
  {
    id: 'X33',
    what: "round 19's F-R19-03 — THIS INSTRUMENT'S OWN SOURCE, handed a producer by a sibling it imports DYNAMICALLY",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x33-lib.ts'),
        ["import { spawnSync } from 'node:child_process';", 'export class X33Runner {', '  static go = spawnSync;', '}', ''].join('\n'),
      );
      // The file that used to be deleted from this scan. The exemption failed
      // open four times — the last time on exactly these bytes, where the leaf
      // test walked `ImportDeclaration` and this import is a CALL. The
      // exemption is gone, so the only thing holding this file inside the scan
      // is that nothing takes it out, and that is what this arm measures.
      const f = join(dir, 'exit-code-sweep.ts');
      const text = readFileSync(f, 'utf8');
      const at = text.lastIndexOf('\nimport ');
      const end = text.indexOf('\n', text.indexOf(';', at)) + 1;
      writeFileSync(
        f,
        text.slice(0, end) +
          [
            'export async function x33head(): Promise<string> {',
            "  const x33sib = await import('./planted-x33-lib');",
            "  const r = x33sib.X33Runner.go('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
            "  return (r.stdout ?? '').trim();",
            '}',
            '',
          ].join('\n') +
          text.slice(end),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'exit-code-sweep.ts')
        ? null
        : "this instrument's own source ran a command and discarded the code without being reported — which is what an exemption over it bought every time it failed open, and what deleting the exemption is supposed to make impossible",
  },
  {
    id: 'X34',
    what: "round 19's F-R19-04 — `export * as ns from` , a NamespaceExport, which publishes nothing on a module surface",
    plant: (dir) => {
      writeFileSync(join(dir, 'planted-x34-prod.ts'), ["import { spawnSync } from 'node:child_process';", 'export const sh = spawnSync;', ''].join('\n'));
      writeFileSync(join(dir, 'planted-x34-barrel.ts'), ["export * as tools from './planted-x34-prod';", ''].join('\n'));
      writeFileSync(
        join(dir, 'planted-x34.ts'),
        [
          "import { tools } from './planted-x34-barrel';",
          '// The fifth route over the same wall. `export *` was carried and',
          '// `export * as ns` was not, because one is an ExportDeclaration with',
          '// no clause and the other has a NamespaceExport clause.',
          'export function head(): string {',
          "  const r = tools.sh('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x34.ts')
        ? null
        : 'a discarding call was hidden behind `export * as ns from`: the same bytes in one file are reported, so the boundary is what hid it',
  },
  {
    id: 'X35',
    what: "round 19's F-R19-06 — the producer as a CLASS FIELD, which was invisible across files and in one file alike",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x35.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          '// Not a boundary defect: the object-literal rule read `{ go: x }` and',
          '// a class body is not an object literal, so this was unseen even in',
          '// one file. The sweep claimed every spawnSync had its code read.',
          'class X35Runner {',
          '  static go = spawnSync;',
          '}',
          'export function head(): string {',
          "  const r = X35Runner.go('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x35.ts')
        ? null
        : 'a discarding call through a class field went unreported, and the sweep still said every spawnSync in the pack has its exit code read',
  },
  {
    id: 'X36',
    what: "round 19's F-R19-06 — the producer RETURNED from a function, so no binding is ever assigned it",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x36.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          '// Every `return` in this function is the producer, so its result is',
          '// the producer; a rule that only reads initializers sees a call.',
          'function makeRunner(): typeof spawnSync {',
          '  return spawnSync;',
          '}',
          'const x36run = makeRunner();',
          'export function head(): string {',
          "  const r = x36run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x36.ts')
        ? null
        : 'a discarding call was hidden behind a function that RETURNS the producer, which no initializer rule reaches',
  },
  {
    id: 'X37',
    what: "round 20's F-R20-01 \u2014 a PARAMETER DEFAULT: the producer reaches a name with no call site anywhere",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x37.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          '// `run` holds the producer by DEFAULT. Nothing is initialized, no argument',
          '// is passed and nothing is destructured: the whole flow is one parameter',
          '// initializer, which every shape-by-shape rule walked past.',
          'export function head(run = spawnSync): string {',
          "  const r = run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x37.ts')
        ? null
        : 'a producer handed in by a PARAMETER DEFAULT discarded its exit code unseen: the resolution read initializers and patterns, and a default is neither',
  },
  {
    id: 'X38',
    what: "round 20's F-R20-01 \u2014 an ARRAY binding pattern, where the object-pattern rule read nothing",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x38.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          'const [x38run] = [spawnSync];',
          'export function head(): string {',
          "  const r = x38run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x38.ts')
        ? null
        : 'the producer was bound by an ARRAY pattern and the discarded code went unreported: a pattern is a pattern, whichever bracket it uses',
  },
  {
    id: 'X39',
    what: "round 20's F-R20-01 \u2014 `this.go = spawnSync` in a constructor: neither a field initializer nor an object literal",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x39.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          'class RunnerX39 {',
          '  go: typeof spawnSync;',
          '  constructor() {',
          '    this.go = spawnSync;',
          '  }',
          '  head(): string {',
          "    const r = this.go('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "    return (r.stdout ?? '').trim();",
          '  }',
          '}',
          'export const x39 = new RunnerX39();',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x39.ts')
        ? null
        : 'the producer was stored on `this` in a constructor and the discarded code went unreported: an assignment whose target is a property access, which the class-field rule did not read',
  },
  {
    id: 'X40',
    what: "round 20's F-R20-01 \u2014 an object GETTER handing out the producer",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x40.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          'const apiX40 = {',
          '  get go() {',
          '    return spawnSync;',
          '  },',
          '};',
          'export function head(): string {',
          "  const r = apiX40.go('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x40.ts')
        ? null
        : 'a GETTER handed out the producer and the discarded code went unreported: the field rule read a PropertyAssignment and a getter is an accessor',
  },
  {
    id: 'X41',
    what: "round 20's F-R20-01 \u2014 ROUND 19'S OWN RULE across a module boundary: an exported function that returns the producer",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x41-lib.ts'),
        ["import { spawnSync } from 'node:child_process';", 'export function makeRunnerX41(): typeof spawnSync {', '  return spawnSync;', '}', ''].join('\n'),
      );
      writeFileSync(
        join(dir, 'planted-x41.ts'),
        [
          "import { makeRunnerX41 } from './planted-x41-lib';",
          '// Round 19 added "a function whose every return is the producer" INSIDE',
          '// one file and published nothing on the module surface, so the fix that',
          "// closed F-R19-06 reopened F-R17-01's class for its own shape.",
          'export function head(): string {',
          '  const runF = makeRunnerX41();',
          "  const r = runF('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x41.ts')
        ? null
        : "a RETURNER exported from one pack file and called in another hid a discarded exit code: the returner set did not cross the boundary, which is F-R17-01's class reopened by round 19's own fix",
  },
  {
    id: 'X42',
    what: "round 20's F-R20-01 \u2014 the SAME bytes as X41 in ONE file, so the boundary there is attributable",
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x42.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          'function makeRunnerX42(): typeof spawnSync {',
          '  return spawnSync;',
          '}',
          'export function head(): string {',
          '  const runF = makeRunnerX42();',
          "  const r = runF('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x42.ts')
        ? null
        : 'the one-file form of X41 went unreported too, so X41 measures the rule and not the boundary',
  },
  {
    id: 'X43',
    what: 'round 20, found HERE while enumerating what the new callee rule costs \u2014 a CONTAINER read through a method call',
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x43.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          "const mapX43 = new Map([['go', spawnSync]]);",
          '// A callee subtree is not read as a mention, because `const out =',
          '// api.run("git")` binds a RESULT. But a call ON AN OBJECT that holds the',
          '// producer can hand it back, so the OBJECT is read while the method name',
          '// is not. Not reported by the challenger: found by asking what the one',
          '// exception to the callee rule leaves open.',
          'export function head(): string {',
          "  const runH = mapX43.get('go');",
          "  const r = runH?.('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r?.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x43.ts')
        ? null
        : 'the producer came back out of a Map through `get` and the discarded code went unreported: a call on an object that holds a producer can return it',
  },
  {
    id: 'X44',
    what: 'round 20, found HERE \u2014 the callee is a CONDITIONAL, so it resolves to no binding at all',
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x44.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          "const otherX44 = (): { stdout: string } => ({ stdout: '' });",
          'const pickX44 = process.env.X44 === "1";',
          '// The callee is neither an identifier, nor a property access, nor an',
          '// element access with a literal key: it is an expression. The three',
          '// callee rules below each name a SHAPE, and this is the case that makes',
          '// the conservative fallback load-bearing rather than decorative.',
          'export function head(): string {',
          "  const r = (pickX44 ? spawnSync : otherX44)('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x44.ts')
        ? null
        : 'a call whose CALLEE is a conditional carrying the producer discarded its exit code unreported: the callee rules each name a shape, and an expression is not one of them',
  },
  {
    id: 'X45',
    what: 'round 20, found HERE \u2014 a COMPUTED index into a container of producers',
    plant: (dir) => {
      writeFileSync(
        join(dir, 'planted-x45.ts'),
        [
          "import { spawnSync } from 'node:child_process';",
          'const fnsX45 = [spawnSync];',
          'const iX45 = Number(process.env.X45 ?? "0");',
          'export function head(): string {',
          "  const r = fnsX45[iX45]?.('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
          "  return (r?.stdout ?? '').trim();",
          '}',
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((site) => site.file === 'planted-x45.ts')
        ? null
        : 'a call through a COMPUTED index into a container holding the producer went unreported: an element access with a non-literal key resolves to no name, and the fallback is what reads it',
  },
  {
    id: 'X9',
    control: true,
    what: 'THE CONTROL — a forwarder whose caller DOES decide must stay green, or rule 4 is a blanket red',
    plant: (dir) => {
      const f = join(dir, 'planted-x9.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          'function raw2(args: readonly string[]): ReturnType<typeof spawnSync> {',
          "  return spawnSync('git', [...args], { encoding: 'utf8' });",
          '}',
          "const r = raw2(['status', '--porcelain']);",
          "export const dirty2 = r.status === 0 ? (r.stdout ?? '').trim().length > 0 : null;",
          '',
        ].join('\n'),
      );
    },
    expect: (r) =>
      r.unchecked.some((s) => s.file === 'planted-x9.ts')
        ? 'a forwarder whose only caller compares the status was reported anyway: a sweep that reds on correct code gets switched off'
        : null,
  },
];

function prove(): number {
  console.log('RED PROOFS — CAN THIS SWEEP GO RED?');
  console.log('  Each plant is made in its OWN fresh copy of the pack. The pack in this');
  console.log('  working tree is READ and never written.');
  console.log('');
  const base = sweep(PACK);
  if (base.unchecked.length > 0) {
    console.log(`  X0 BASELINE  the untouched pack is clean: FAIL — ${base.unchecked.length} site(s) already unchecked.`);
    console.log('  Everything below is INVALID: a baseline that is already red cannot attribute');
    console.log('  a later red to a planted defect.');
    return 1;
  }
  console.log(
    `  X0 BASELINE  the untouched pack is clean: OK (0 unchecked, ${base.read.length} read, ${base.wrappers.length} measured wrapper(s), ${base.forwarders.filter((f) => f.safe).length} of ${base.forwarders.length} forwarder(s) fully measured)`,
  );
  let failures = 0;
  for (const p of PLANTS) {
    const dir = mkdtempSync(join(tmpdir(), 'p15-sweep-'));
    try {
      cpSync(PACK, join(dir, 'phase15'), { recursive: true });
      const copy = join(dir, 'phase15');
      p.plant(copy);
      const r = sweep(copy);
      const problem = p.expect(r);
      if (problem === null) console.log(`  ${p.id} ${p.control === true ? 'GREEN   ' : 'RED     '} ${p.what}`);
      else {
        failures += 1;
        console.log(`  ${p.id} ${p.control === true ? 'FAILED ' : 'NOT RED'}  ${p.what}`);
        console.log(`       ${problem}`);
      }
    } catch (e) {
      failures += 1;
      console.log(`  ${p.id} ${p.control === true ? 'FAILED ' : 'NOT RED'}  ${p.what}`);
      console.log(`       the plant itself failed: ${(e as Error).message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('');
  if (failures > 0) {
    console.log(`EXIT 1 — ${failures} of ${PLANTS.length} case(s) did not behave as required. An instrument that cannot`);
    console.log('  go red is not evidence, and the green verdict it prints elsewhere is worth nothing.');
    return 1;
  }
  const controls = PLANTS.filter((p) => p.control === true).length;
  console.log(`All ${PLANTS.length - controls} planted defects are detected, ${controls} control(s) stayed green, and the untouched pack is clean.`);
  console.log('  What this does NOT show: that the tools are correct. Only that the exit code of');
  console.log('  every command they run is read, and that this sweep notices when one is not.');
  return 0;
}

/* ── entry ────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
console.log('━'.repeat(78));
console.log('PHASE 15 — EXIT-CODE SWEEP   (PREPARED / NOT PROMOTED)');
console.log('━'.repeat(78));

if (argv.includes('--prove')) {
  process.exitCode = prove();
} else {
  const r = sweep(PACK);
  report(PACK, r);
  console.log('');
  if (r.unchecked.length > 0) {
    console.log(`EXIT 1 — ${r.unchecked.length} command(s) in the pack run without their exit code being read.`);
    console.log('  Each one can turn a command that did not run into an answer: an empty stdout read');
    console.log('  as "nothing found" is a statement of absence from a search that never happened.');
    console.log('  Read the code and report UNMEASURED, or pass the result to a wrapper that does.');
    process.exitCode = 1;
  } else {
    console.log(`EXIT 0 — every spawnSync in ${basename(PACK)} has its exit code read: ${r.read.length} site(s),`);
    console.log(`  through ${r.wrappers.length} wrapper(s) and ${r.forwarders.length} forwarder(s) measured above, or on their own result.`);
    console.log('  This is a reading of the source, not of behaviour. `-- --prove` shows it can go red.');
    process.exitCode = 0;
  }
}
