/**
 * PHASE 15 — GUARD-DELETION PROOF: THE SWEEP'S PROVENANCE RULE AND ITS OWN MEMBERSHIP
 * (PREPARED / NOT PROMOTED)
 *
 * WHY THIS IS ITS OWN INSTRUMENT
 *   A guard-deletion test has to run a MODIFIED COPY of the sweep as a child
 *   process, which means importing `spawnSync` here and running commands. The
 *   sweep itself must stay a reader of source and nothing else, so the
 *   child-process half lives in this file. That separation used to also earn
 *   the sweep an exemption from its own scan; the exemption is DELETED (round
 *   19, F-R19-03), and this file now measures the opposite claim \u2014 that the
 *   apparatus is in the swept set, on every shape that once walked past it.
 *
 * WHAT IT MEASURES (round-9B's F-R9B-01)
 *   The sweep used to credit ANY returned object literal carrying a property
 *   named `status` as forwarding a command's exit code — `{ status: 0, out }`
 *   included, with the real code thrown away. The fix requires the value's
 *   PROVENANCE: the status must come from the spawn result. `X15` in the sweep's
 *   own `--prove` shows the planted defect reddens. That alone cannot say WHICH
 *   rule caught it, so this instrument runs the same plant twice:
 *     1. against the real sweep           → it must be REPORTED
 *     2. against a copy of the sweep with the provenance requirement replaced by
 *        the old blanket test             → it must NOT be reported
 *   If the stripped copy still reports it, provenance is not what catches it and
 *   X15's red belongs to another rule; this instrument then fails rather than
 *   letting the pack keep a credit it has not earned.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const SWEEP = join(ROOT, 'scripts/phase15/exit-code-sweep.ts');
const PLANT = 'planted-invented-status.ts';

/** The provenance requirement, as one line of this repository's source. */
const GUARD = "      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'status' && fromSpawn(prop.initializer, call, bound)) return true;";
/** What it replaced, which is the fail-open the challenger measured. */
const BLANKET = "      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'status') return true;";

/**
 * THE SECOND GUARD: THE APPARATUS IS IN THE SUBJECT SET (round 19, F-R19-03).
 *
 * The sweep used to skip exactly one file — itself — and earn that skip by
 * measuring its own inertness. That exemption failed open FOUR times, each
 * time on the one file whose discarded exit codes nothing else can see
 * (F-R16-01 a spelling, F-R17-02 a sibling, F-R18-04 a default export,
 * F-R19-03 a dynamic import), and each fix enumerated one more form. It is
 * now DELETED: the apparatus is swept like every other file.
 *
 * So the rule this section removes is no longer an inertness check. It is the
 * membership of the apparatus in the swept set, and the deletion REINSTATES
 * the exemption in its minimal form — one `delete` of the file name. Every
 * shape that walked through the old exemption is planted into a copy of the
 * apparatus and swept twice: by the real sweep, which must read the file, and
 * by the exempt copy, which must go blind to all of them. An ordinary-file
 * plant in the same pack copy is the control: the exempt copy must still name
 * it, or the deletion moves more than the apparatus and attributes nothing.
 */
const SELF_BOUND = '  const src = new Map(sources(dir));';
const SELF_EXEMPT = "  const src = new Map(sources(dir));\n  src.delete('exit-code-sweep.ts');";

/**
 * THE THIRD GUARD: A PRODUCER BOUND THROUGH A CALL (round 15, F-R15-02).
 *
 * `const { spawnSync: run } = createRequire(…)('child_process')` binds the
 * producer with no import declaration anywhere, so the import scan found
 * nothing and a bare `run(…)` that discarded its code was invisible — in any
 * pack file, not only in the apparatus.
 */
const REQUIRE_BOUND = '  return derivedProducers(sf, seed, members, imported.ns, imported.returners);';
const REQUIRE_BLIND = '  return { ids: seed, members, ns: imported.ns, returners: imported.returners };';
const REQUIRE_PLANT = 'planted-require-bound.ts';

/**
 * The producer reached by PROPERTY ACCESS on a module object — round 16's
 * F-R16-01, which kept the apparatus exemption while the apparatus could run
 * a command, and F-R16-02, which hid the same shape in an ordinary file.
 */
const DERIVED_SOURCE: readonly string[] = [
  "import { createRequire } from 'node:module';",
  'const __req = createRequire(__filename);',
  "const __run = __req('child_process').spawnSync as typeof import('node:child_process').spawnSync;",
  'export function __plantedHead(): string {',
  "  const r = __run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
  "  return (r.stdout ?? '').trim();",
  '}',
  '',
];

/** The two sibling shapes: a STATIC import, and the DYNAMIC one of F-R19-03. */
const LEAF_LIB = 'planted-leaf-lib.ts';
const DYN_LIB = 'planted-dyn-lib.ts';

/** A class field on purpose: the shape the producer resolution did not model
 *  when the leaf rule was written, which is why the exemption fell to it. */
const RUNNER = (name: string): string =>
  ["import { spawnSync } from 'node:child_process';", `export class ${name} {`, '  static go = spawnSync;', '}', ''].join('\n');

/** The apparatus handed a producer by a sibling it imports STATICALLY. */
function plantIntoApparatusFromSibling(pack: string): void {
  writeFileSync(join(pack, LEAF_LIB), RUNNER('LeafRunner'));
  const file = join(pack, 'exit-code-sweep.ts');
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')}
import { LeafRunner } from './${LEAF_LIB.replace('.ts', '')}';
export function plantedLeafHead(): string {
  const r = LeafRunner.go('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}
`,
  );
}

/**
 * The apparatus handed the producer by a PARAMETER DEFAULT — the challenger's
 * own round-20 plant (F-R20-02). It needs no sibling and no import from inside
 * the pack: the producer arrives in the file's own parameter list, which is why
 * it walked past five rounds of shape rules while the file was being scanned.
 */
function plantIntoApparatusParamDefault(pack: string): void {
  const file = join(pack, 'exit-code-sweep.ts');
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')}
import { spawnSync as plantedDefaultSpawn } from 'node:child_process';
export function plantedDefaultParam(runner = plantedDefaultSpawn): string {
  const r = runner('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return r.stdout ?? '';
}
`,
  );
}

/** The same, through a DYNAMIC import — the shape the leaf rule walked past,
 *  because it enumerated `ImportDeclaration` and this import is a CALL. */
function plantIntoApparatusDynamic(pack: string): void {
  writeFileSync(join(pack, DYN_LIB), RUNNER('DynRunner'));
  const file = join(pack, 'exit-code-sweep.ts');
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')}
export async function plantedDynHead(): Promise<string> {
  const sib = await import('./${DYN_LIB.replace('.ts', '')}');
  const r = sib.DynRunner.go('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}
`,
  );
}

/**
 * THE FOURTH GUARD: THE BINDING CROSSES FILES (round 17, F-R17-01).
 *
 * `derivedProducers` resolved names inside ONE file, so a pack that factored
 * its helper out — `export const sh = spawnSync` in one file, `import { sh }`
 * in the next — hid a discarded exit code behind a module boundary: the
 * identical bytes read EXIT 1 in one file and EXIT 0 in two. The pack-level
 * fixpoint is the line removed here, and the ONE-FILE sibling below is the
 * control that shows the boundary is what the rule crosses.
 */
const PACK_BOUND = '  for (const id of imported.ids) seed.add(id);';

/**
 * THE SIXTH GUARD: THE CONSERVATIVE FALLBACK (round 20).
 *
 * The three callee rules each name a SHAPE — an identifier, a property
 * access, an element access with a literal key. A callee that is an
 * expression (`(cond ? run : other)(…)`, `fns[i](…)`) is none of them, and
 * what reports it is the line that asks whether the callee MENTIONS a
 * producer at all. Measured when it was added: with it removed the whole plant
 * set still behaved, which is how a rule becomes decorative — so two plants
 * exist for it, and this section is what says the line does the work. Round 23
 * measured a THIRD arm on it: X60, a conditional of returners in callee
 * position, written for a rule one frame in and caught here instead.
 */
const FALLBACK_BOUND = '      else if (mentionsProducer(c, p)) out.push(n);';
const FALLBACK_BLIND = '      else if (false) out.push(n);';

/**
 * THE SEVENTH GUARD: THE ONE EXCEPTION TO THE CALLEE RULE (round 20).
 *
 * A call's callee subtree is not read as a mention, or `const out =
 * api.run('git')` would bind a producer. The exception is the OBJECT of a
 * method call, because `map.get('go')` can hand the producer back. Removing
 * the exception must blind the container plant and nothing else — and the
 * untouched pack must stay clean WITH it, which is the baseline X0 measures.
 */
const OBJECT_BOUND = '      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) visit(callee.expression);';
const OBJECT_BLIND = '      if (false) visit(callee.expression);';
const PACK_BLIND = '  // pack resolution removed';
const CROSS_LIB = 'planted-cross-lib.ts';
const CROSS_USER = 'planted-cross-user.ts';
const SAME_FILE = 'planted-same-file.ts';

/** The producer exported from one pack file and called, discarded, in another. */
function plantCrossFile(dir: string): void {
  writeFileSync(join(dir, CROSS_LIB), ["import { spawnSync } from 'node:child_process';", 'export const shared = spawnSync;', ''].join('\n'));
  writeFileSync(
    join(dir, CROSS_USER),
    [
      `import { shared } from './${CROSS_LIB.replace('.ts', '')}';`,
      'export function crossHead(): string {',
      "  const r = shared('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
      "  return (r.stdout ?? '').trim();",
      '}',
      '',
    ].join('\n'),
  );
}

/** The SAME bytes in one file: the control for the module boundary. */
function plantSameFile(dir: string): void {
  writeFileSync(
    join(dir, SAME_FILE),
    [
      "import { spawnSync } from 'node:child_process';",
      'const shared2 = spawnSync;',
      'export function sameHead(): string {',
      "  const r = shared2('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
      "  return (r.stdout ?? '').trim();",
      '}',
      '',
    ].join('\n'),
  );
}

function plantRequireBound(dir: string): void {
  writeFileSync(join(dir, REQUIRE_PLANT), DERIVED_SOURCE.join('\n'));
}

/** The same shape, appended to a COPY of the apparatus itself. */
function plantIntoApparatusDerived(pack: string): void {
  const file = join(pack, 'exit-code-sweep.ts');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n${DERIVED_SOURCE.join('\n')}`);
}

/** Give a copy of the apparatus a real import and a real discarded exit code. */
function plantIntoApparatus(pack: string, specifier: string): void {
  const file = join(pack, 'exit-code-sweep.ts');
  const src = readFileSync(file, 'utf8');
  writeFileSync(
    file,
    `${src}
import { spawnSync } from '${specifier}';
export function plantedRunner(): string {
  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return r.stdout ?? '';
}
`,
  );
}

function plant(dir: string): void {
  writeFileSync(
    join(dir, PLANT),
    [
      "import { spawnSync } from 'node:child_process';",
      '// A helper shaped like every other run-a-command helper in this pack. The',
      '// one thing it does not do is read the exit code: the `0` it hands on is',
      "// its own, and its caller's `if (r.status !== 0)` decides on that zero.",
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
}

/** Run one sweep over one pack copy. The exit code is read HERE, at the spawn. */
function sweepOver(script: string, pack: string): { readonly ran: boolean; readonly reported: boolean; readonly code: number | null; readonly out: string } {
  const r = spawnSync('npx', ['tsx', script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, P15_SWEEP_DIR: pack } });
  const code = r.status;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // The sweep's own codes are 0 and 1. Anything else is this runner failing to
  // start it, which must never read as "nothing was reported".
  const ran = r.error === undefined && (code === 0 || code === 1);
  // ONLY the unchecked block counts. The sweep names every call it measured
  // too, so a bare `out.includes(PLANT)` is true in both arms — the plant's
  // file appears in the GREEN list when the sweep believes the invented status.
  // This proof read exactly that way at first and reported the stripped copy as
  // still catching the defect, which is the fail-open it exists to refuse.
  const header = 'CALLS WHOSE EXIT CODE IS NEVER READ';
  const block = out.includes(header) ? out.slice(out.indexOf(header)) : '';
  return { ran, reported: block.includes(PLANT), code: code, out };
}

/** The same reading, for any file name the unchecked block may carry. */
function sweepFile(script: string, pack: string, file: string): { readonly ran: boolean; readonly reported: boolean; readonly code: number | null } {
  const r = spawnSync('npx', ['tsx', script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, P15_SWEEP_DIR: pack } });
  const code = r.status;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const ran = r.error === undefined && (code === 0 || code === 1);
  const header = 'CALLS WHOSE EXIT CODE IS NEVER READ';
  const block = out.includes(header) ? out.slice(out.indexOf(header)) : '';
  return { ran, reported: block.includes(file), code };
}

/**
 * ONE DELETION PER RULE, EACH WITH THE ARMS IT MUST BLIND AND NO OTHERS.
 *
 * Round 21 added three rules and round 22 added four, and until round 22 none
 * of them had a deletion of its own: the plants went red, and nothing said
 * WHICH rule turned them red. A rule no plant depends on is decorative, and a
 * plant no deletion attributes is a smoke test. Each row below replaces exactly
 * one line of the sweep and pins, by name, the arms that must go blind.
 *
 * THE ARM LISTS ARE MEASURED, NOT EXPECTED. Every one was read off the stripped
 * copy and then written down, and this instrument has now twice rejected lists
 * its author wrote from expectation — two in round 22 and ten in round 23,
 * three of them rules whose deletion blinded no arm at all. A list equal to
 * what the deletion moves is the attribution; a list written from what the
 * author believes it moves is a claim about a run nobody made. A later change
 * that moves the blast radius fails here, by design.
 */
const RULE_DELETIONS: readonly { readonly label: string; readonly bound: string; readonly blind: string; readonly arms: readonly string[] }[] = [
  { label: 'the conservative callee fallback', bound: FALLBACK_BOUND, blind: FALLBACK_BLIND, arms: ['X44', 'X45', 'X60'] },
  {
    label: "round 23's cut flag TRAVELLING with the value, on the IMPORT edge",
    bound: '      if (read.degraded) cut = true;\n      const from = read.surface;\n      for (const m of from.members) members.add(m);',
    blind: '      const from = read.surface;\n      for (const m of from.members) members.add(m);',
    // MEASURED, and it corrected the arm this section was written with: X56
    // carries its producer outward by RE-EXPORT, so the floor it depends on is
    // the one on the re-export walk and this deletion left X56 red. X67 is the
    // same cycle with import edges only, which is the copy this line owns.
    arms: ['X67', 'X77'],
  },
  {
    label: "round 23's namespace import in an outside module",
    bound: '      if (nb !== undefined && ts.isNamespaceImport(nb)) {',
    blind: '      if (false && nb !== undefined && ts.isNamespaceImport(nb)) {',
    arms: ['X57'],
  },
  {
    label: "round 23's local alias of a free object",
    bound: '    return ts.isIdentifier(root) && (!declared.has(root.text) || aliasesFree.has(root.text));',
    blind: '    return ts.isIdentifier(root) && !declared.has(root.text);',
    arms: ['X58', 'X63', 'X73'],
  },
  {
    label: "round 23's scope-walking key resolver",
    bound:
      '  const constAt = (node: ts.Node, name: string): string | null => {\n    for (let cur: ts.Node | undefined = node; cur !== undefined; cur = cur.parent) {',
    blind:
      '  const constAt = (node: ts.Node, name: string): string | null => {\n    void node;\n    let flat: string | null = null;\n    const scanFlat = (q: ts.Node): void => {\n      if (ts.isVariableDeclaration(q) && ts.isIdentifier(q.name) && q.name.text === name && q.initializer !== undefined) {\n        const i = unwrap(q.initializer);\n        flat = ts.isStringLiteral(i) || ts.isNoSubstitutionTemplateLiteral(i) ? i.text : null;\n      }\n      q.forEachChild(scanFlat);\n    };\n    scanFlat(sf);\n    return flat;\n    for (let cur: ts.Node | undefined = node; cur !== undefined; cur = cur.parent) {',
    arms: ['X59', 'X74', 'X75', 'X76'],
  },
  {
    label: "round 23's conditional of returners in callee position",
    bound: '  if (ts.isConditionalExpression(c)) return isReturnerExpr(c.whenTrue, p) || isReturnerExpr(c.whenFalse, p);',
    blind: '  if (ts.isConditionalExpression(c)) return false;',
    // MEASURED: X60 puts the conditional in CALLEE position, where the
    // conservative fallback reports the call anyway, so X60 attributed this
    // rule to nothing. X66 hands the same conditional over as an ARGUMENT to a
    // callee that mentions no producer, which only this split can reach.
    arms: ['X66'],
  },
  {
    label: "round 23's reflective write forms",
    // Re-anchored in round 24: the line gained `Reflect.defineProperty`
    // (F-R24-05), so the round-23 text stopped matching and the uniqueness
    // preflight reported it at 0 occurrences rather than letting the section
    // pass on a replacement that changed nothing. Removing the whole branch
    // blinds BOTH reflective plants, which is what the arm list now says.
    bound:
      "      if ((callee === 'Reflect.set' || callee === 'Reflect.defineProperty' || callee === 'Object.defineProperty') && destFree && n.arguments.length > 2) {",
    blind:
      "      if (false && (callee === 'Reflect.set' || callee === 'Reflect.defineProperty' || callee === 'Object.defineProperty') && destFree && n.arguments.length > 2) {",
    arms: ['X61', 'X79'],
  },
  {
    label: "round 23's refusal of an unresolved relative import",
    bound: "    if (resolved === null && spec.startsWith('.') && !PACK_PRODUCER_EXPORTS.has(specKey(spec))) {",
    blind: "    if (false && resolved === null && spec.startsWith('.') && !PACK_PRODUCER_EXPORTS.has(specKey(spec))) {",
    arms: ['X62'],
  },
  {
    label: "round 22's conditional assignment operators, given a plant in round 23",
    bound: '    ts.SyntaxKind.QuestionQuestionEqualsToken,',
    blind: '    ts.SyntaxKind.EqualsToken,',
    arms: ['X63'],
  },
  {
    label: "round 22's Object.assign branch, given a plant in round 23",
    bound: "      if (callee === 'Object.assign' && n.arguments.length > 1 && destFree) {",
    blind: "      if (false && callee === 'Object.assign' && n.arguments.length > 1 && destFree) {",
    arms: ['X64'],
  },
  {
    label: "round 22's extra resolver candidates, given a plant in round 23",
    bound: "    join(base, 'index.tsx'),",
    blind: "    join(base, 'index-not-tried.tsx'),",
    // X65 stayed RED with the candidate removed, because the specifier then
    // resolves to nothing and F-R23-13 refuses it BY NAME. The arm now reads
    // the SITE rather than the file, so what it measures is this candidate.
    arms: ['X65'],
  },
  // Round 22 measured BOTH of these here, by running them and reading which
  // arms moved. The first list was written from what I expected -- X49 for the
  // hand-over rule -- and this proof reported X36, X41 and X42 instead, because
  // the line I had anchored is the one in `isProducerExpr`, not the one in
  // `handsProducerOver`. Two rules, two deletions, each with the arms it owns.
  {
    label: "round 24's refusal of a degraded outside surface at the pack boundary",
    bound: '      const read = outsideRead(outside, 0);\n      if (read.degraded)',
    blind: '      const read = outsideRead(outside, 0);\n      if (false)',
    arms: ['X77'],
  },
  {
    label: "round 24's parameter binding in the key resolver",
    bound: '      if (params !== undefined) for (const prm of params) if (boundNames(prm.name).includes(name)) return null;',
    blind: '      if (false) for (const prm of params ?? []) if (boundNames(prm.name).includes(name)) return null;',
    arms: ['X76'],
  },
  {
    label: "round 24's stop at the first binding, readable or not",
    bound: '          if (!ts.isIdentifier(d.name)) return null;',
    blind: '          if (!ts.isIdentifier(d.name)) continue;',
    arms: ['X75'],
  },
  {
    label: "round 24's refusal of a REASSIGNABLE key binding",
    bound: '          if ((st.declarationList.flags & ts.NodeFlags.Const) === 0) return null;',
    blind: '          if (false) return null;',
    arms: ['X74'],
  },
  {
    label: "round 24's parameters as roots this file cannot bound",
    bound: '      if (params !== undefined) for (const prm of params) for (const nm of boundNames(prm.name)) unboundableRoots.add(nm);',
    blind: '      if (false) for (const prm of params ?? []) for (const nm of boundNames(prm.name)) unboundableRoots.add(nm);',
    arms: ['X72'],
  },
  {
    label: "round 24's free root followed through a CALL",
    bound: '        const roots = [rootName(init), ...callRoots(init)].filter((x): x is string => x !== null && x !== name);',
    blind: '        const roots = [rootName(init)].filter((x): x is string => x !== null && x !== name);',
    arms: ['X73'],
  },
  {
    label: "round 24's returner-ness through a const alias",
    bound: '          } else if (ts.isIdentifier(init) && returners.has(init.text)) {',
    blind: '          } else if (false && ts.isIdentifier(init) && returners.has(init.text)) {',
    arms: ['X70'],
  },
  {
    label: "round 24's returner-ness through an ASSIGNMENT",
    bound: '        const isFn = ts.isArrowFunction(right) || ts.isFunctionExpression(right) || (ts.isIdentifier(right) && returners.has(right.text));',
    blind: '        const isFn = ts.isArrowFunction(right) || ts.isFunctionExpression(right);',
    arms: ['X71'],
  },
  {
    label: "round 24's Object.defineProperties branch",
    bound: "      if (callee === 'Object.defineProperties' && n.arguments.length > 1) {",
    blind: "      if (false && callee === 'Object.defineProperties' && n.arguments.length > 1) {",
    arms: ['X78'],
  },
  {
    label: "round 24's Reflect.defineProperty spelling",
    bound:
      "      if ((callee === 'Reflect.set' || callee === 'Reflect.defineProperty' || callee === 'Object.defineProperty') && destFree && n.arguments.length > 2) {",
    blind: "      if ((callee === 'Reflect.set' || callee === 'Object.defineProperty') && destFree && n.arguments.length > 2) {",
    arms: ['X79'],
  },
  {
    label: "the returner call read as a VALUE in a binding's region",
    bound: '  if (ts.isCallExpression(x) && isReturnerCall(x, p)) return true;',
    blind: '  if (ts.isCallExpression(x) && isReturnerCall(x, p) && false) return true;',
    arms: ['X36', 'X41', 'X42', 'X60', 'X70', 'X71'],
  },
  {
    label: "round 22's returner-call HAND-OVER",
    bound: '      if (ts.isCallExpression(x) && isReturnerCall(x, p)) {\n        found = true;\n        return;\n      }',
    blind: '      if (ts.isCallExpression(x) && isReturnerCall(x, p) && false) {\n        found = true;\n        return;\n      }',
    // X66 hands a returner call over as an argument, so it needs BOTH this
    // rule and the conditional split one frame in; measured, not expected.
    arms: ['X49', 'X66'],
  },
  {
    label: "round 21's pack-wide escaped keys",
    bound: '  for (const k of PACK_ESCAPED_KEYS) members.add(k);',
    blind: '  for (const k of PACK_ESCAPED_KEYS) void k;',
    // Seven arms, all measured: every plant whose producer is published under
    // a pack-wide escaped key depends on this line, and round 23 added four.
    arms: ['X47', 'X50', 'X58', 'X59', 'X61', 'X63', 'X64', 'X73', 'X78', 'X79'],
  },
  {
    label: "round 22's refusal of a key nobody can name",
    bound: '    else unbounded.push({ line: lineOf(sf, n) + 1, text: textOf(sf, n) });',
    blind: '    else void n;',
    arms: ['X51', 'X72', 'X74', 'X75', 'X76'],
  },
  {
    label: "round 22's absolute-path parse key for an outside module",
    bound: "    const sf = ast(abs, readFileSync(abs, 'utf8'));",
    blind: "    const sf = ast(name, readFileSync(abs, 'utf8'));",
    arms: ['X53'],
  },
  {
    label: "round 22's re-export walk in an outside module",
    // Re-anchored in round 23 after `outsideSurface` was rewritten to return
    // `{surface, degraded}`; the old anchor stopped matching, and the new
    // uniqueness preflight reported it as 0 occurrences rather than letting
    // the section pass on a replacement that changed nothing.
    bound: '      if (read.degraded) cut = true;\n      const from = read.surface;\n      const ids = new Set<string>(surface0.ids);',
    blind: '      if (read.degraded) cut = true;\n      const from = EMPTY_SURFACE;\n      const ids = new Set<string>(surface0.ids);',
    arms: ['X52', 'X54', 'X56'],
  },
  {
    label: "round 22's refusal to memoise a surface computed while a cycle was cut",
    bound: '  if (!cut) OUTSIDE_SURFACE.set(abs, surface);',
    blind: '  OUTSIDE_SURFACE.set(abs, surface);',
    arms: ['X54', 'X56', 'X67'],
  },
];

function main(): number {
  console.log('━'.repeat(78));
  console.log('PHASE 15 — GUARD-DELETION PROOF: PROVENANCE, MEMBERSHIP, AND THE ROUND-20 RULES   (PREPARED / NOT PROMOTED)');
  console.log('━'.repeat(78));
  const me = readFileSync(SWEEP, 'utf8');
  if (!me.includes(GUARD)) {
    console.log('  the provenance requirement is not written in the shape this proof removes, so nothing here was measured.');
    console.log('  Expected this line in scripts/phase15/exit-code-sweep.ts:');
    console.log(`    ${GUARD.trim()}`);
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A guard-deletion proof that cannot find the guard proves nothing.');
    return 2;
  }
  /**
   * EVERY ANCHOR MUST OCCUR EXACTLY ONCE (round 23, F-R23-10).
   *
   * Every deletion here is a `String.replace`, which replaces the FIRST
   * occurrence and says nothing about the rest. `OBJECT_BOUND` was
   * byte-identical to a line in `mentionsProducer`, so the copy that was
   * blinded was not the copy the section is about, and the attribution was to
   * the wrong rule. An anchor that matches twice is a measurement of something
   * nobody chose, and an anchor that matches zero times measures nothing, so
   * both are UNMEASURED rather than a pass.
   */
  const anchors: readonly { readonly label: string; readonly text: string }[] = [
    { label: 'the provenance requirement', text: GUARD },
    { label: 'the swept-set construction', text: SELF_BOUND },
    { label: 'the require-bound producer rule', text: REQUIRE_BOUND },
    { label: 'the pack-level producer rule', text: PACK_BOUND },
    { label: 'the callee-object exception', text: OBJECT_BOUND },
    ...RULE_DELETIONS.map((r) => ({ label: r.label, text: r.bound })),
  ];
  const ambiguous = anchors.map((a) => ({ ...a, n: me.split(a.text).length - 1 })).filter((a) => a.n !== 1);
  if (ambiguous.length > 0) {
    for (const a of ambiguous) console.log(`  ${a.label}: its anchor occurs ${String(a.n)} time(s) in the sweep, and a deletion needs exactly one.`);
    console.log('');
    console.log('EXIT 2 — UNMEASURED. A deletion that cannot say WHICH line it removed attributes nothing.');
    return 2;
  }
  console.log(`  ${String(anchors.length)} deletion anchor(s), each matching exactly one line of the sweep — checked before anything was removed.`);

  const tmp = mkdtempSync(join(tmpdir(), 'p15-guard-'));
  try {
    const pack = join(tmp, 'phase15');
    cpSync(join(ROOT, 'scripts/phase15'), pack, { recursive: true });
    plant(pack);
    const stripped = join(tmp, 'sweep-without-provenance.ts');
    writeFileSync(stripped, me.replace(GUARD, BLANKET));

    const real = sweepOver(SWEEP, pack);
    const without = sweepOver(stripped, pack);
    const problems: string[] = [];
    if (!real.ran) problems.push(`the real sweep did not run (exit ${String(real.code)}), so its silence says nothing`);
    else if (!real.reported) problems.push(`the real sweep did not report ${PLANT}: a helper that invents its status is being credited as a forwarder`);
    if (!without.ran) problems.push(`the sweep with the guard removed did not run (exit ${String(without.code)}), so the deletion arm is UNMEASURED`);
    else if (without.reported)
      problems.push(
        `the sweep with the provenance requirement REMOVED still reported ${PLANT}: provenance is not the rule that catches this, and the red proof credits it to the wrong guard`,
      );

    console.log(`  with provenance required   exit ${String(real.code)}  ${real.reported ? 'REPORTED the invented status' : 'said nothing'}`);
    console.log(
      `  with that one line removed exit ${String(without.code)}  ${without.reported ? 'REPORTED it anyway' : 'said nothing — so that line is what catches it'}`,
    );
    console.log('');
    // ── THE APPARATUS IS IN THE SWEPT SET, ON EVERY SHAPE THAT BROKE THE OLD EXEMPTION ─
    if (!me.includes(SELF_BOUND)) {
      console.log('  the swept set is not built in the shape this proof removes, so the second section');
      console.log('  measures nothing. Re-anchor it before reading it again.');
      console.log(`    expected: ${SELF_BOUND.trim()}`);
      console.log('');
      console.log('EXIT 2 — UNMEASURED.');
      return 2;
    }
    // The deletion REINSTATES the exemption, in the smallest form it can take:
    // the apparatus is removed from the set the sweep reads. Nothing else in
    // the sweep changes, so whatever goes blind is attributable to membership.
    const exempt = join(tmp, 'sweep-with-the-exemption-reinstated.ts');
    writeFileSync(exempt, me.replace(SELF_BOUND, SELF_EXEMPT));
    const apparatusRows: string[] = [];
    const shapes: readonly { readonly label: string; readonly plant: (dir: string) => void }[] = [
      { label: "import from 'child_process'", plant: (d) => plantIntoApparatus(d, 'child_process') },
      { label: "import from 'node:child_process'", plant: (d) => plantIntoApparatus(d, 'node:child_process') },
      { label: 'property access on a module', plant: plantIntoApparatusDerived },
      { label: 'a sibling, STATIC import', plant: plantIntoApparatusFromSibling },
      { label: 'a sibling, DYNAMIC import', plant: plantIntoApparatusDynamic },
      { label: 'its own parameter DEFAULT', plant: plantIntoApparatusParamDefault },
    ];
    for (const shape of shapes) {
      const copy = join(tmp, `pack-self-${shape.label.replace(/[^a-z]+/gi, '-')}`);
      cpSync(join(ROOT, 'scripts/phase15'), copy, { recursive: true });
      shape.plant(copy);
      // The ordinary-file control rides in the SAME copy: it must stay visible
      // to both arms, or the deletion moves more than the apparatus.
      plantSameFile(copy);
      const seen = sweepFile(SWEEP, copy, 'exit-code-sweep.ts');
      const exempted = sweepFile(exempt, copy, 'exit-code-sweep.ts');
      const control = sweepFile(exempt, copy, SAME_FILE);
      const pad = ' '.repeat(Math.max(0, 30 - shape.label.length));
      apparatusRows.push(
        `  ${shape.label}${pad} real sweep ${seen.ran ? (seen.reported ? 'READ the apparatus and reported it' : 'did NOT report it') : `did not run (exit ${String(seen.code)})`}`,
      );
      apparatusRows.push(
        `  ${' '.repeat(shape.label.length)}${pad} exempt     ${exempted.ran ? (exempted.reported ? 'reported it ANYWAY' : 'blind — so membership is what reads it') : `did not run (exit ${String(exempted.code)})`}`,
      );
      if (!seen.ran) problems.push(`the real sweep did not run over the ${shape.label} plant (exit ${String(seen.code)}), so its silence says nothing`);
      else if (!seen.reported)
        problems.push(
          `an apparatus that binds a producer by ${shape.label} and discards an exit code was not reported: the file this sweep is written in is the one file nobody else can see`,
        );
      if (!exempted.ran)
        problems.push(`the exempt copy did not run over the ${shape.label} plant (exit ${String(exempted.code)}), so that deletion is UNMEASURED`);
      else if (exempted.reported)
        problems.push(
          `the copy with the apparatus REMOVED from the swept set still reported it on the ${shape.label} plant, so membership is not what reads it`,
        );
      if (!control.ran)
        problems.push(`the exempt copy did not run over the ordinary-file control for ${shape.label} (exit ${String(control.code)}): UNMEASURED`);
      else if (!control.reported)
        problems.push(
          `removing the apparatus from the swept set also blinded the sweep to an ORDINARY file (${shape.label} copy), so the deletion attributes nothing`,
        );
    }

    console.log('');
    // ROUND 18's F-R18-07: this heading used to say «MEASURED ON EVERY SHAPE
    // THAT CAN BIND THE PRODUCER» over three shapes, and a cross-file shape
    // then walked through the exemption. With the exemption deleted the
    // heading no longer has to quantify over shapes at all: the five rows are
    // the shapes that each reopened it, and they are now evidence that the
    // file is read, not that a check withdrew a skip.
    console.log('  THE APPARATUS, NOW SWEPT LIKE THE REST (five shapes that broke the old exemption, and one that broke the new rule)');
    for (const row of apparatusRows) console.log(row);
    // ── A PRODUCER BOUND THROUGH A CALL, IN AN ORDINARY PACK FILE ─────────
    if (!me.includes(REQUIRE_BOUND)) {
      console.log('  the require-bound producer rule is not written in the shape this proof removes, so');
      console.log('  the third section measures nothing. Re-anchor it before reading it again.');
      console.log('');
      console.log('EXIT 2 — UNMEASURED.');
      return 2;
    }
    const strippedRequire = join(tmp, 'sweep-without-require-bound.ts');
    writeFileSync(strippedRequire, me.replace(REQUIRE_BOUND, REQUIRE_BLIND));
    const reqPack = join(tmp, 'pack-require-bound');
    cpSync(join(ROOT, 'scripts/phase15'), reqPack, { recursive: true });
    plantRequireBound(reqPack);
    const reqReal = sweepFile(SWEEP, reqPack, REQUIRE_PLANT);
    const reqWithout = sweepFile(strippedRequire, reqPack, REQUIRE_PLANT);
    console.log('');
    console.log('  A PRODUCER BOUND THROUGH `createRequire` AND RENAMED, IN AN ORDINARY PACK FILE');
    console.log(
      `  real sweep      exit ${String(reqReal.code)}  ${reqReal.ran ? (reqReal.reported ? 'REPORTED the discarded code' : 'said nothing') : 'did not run'}`,
    );
    console.log(
      `  rule removed    exit ${String(reqWithout.code)}  ${reqWithout.ran ? (reqWithout.reported ? 'REPORTED it anyway' : 'said nothing — so that rule is what catches it') : 'did not run'}`,
    );
    if (!reqReal.ran) problems.push(`the real sweep did not run over the require-bound plant (exit ${String(reqReal.code)}), so its silence says nothing`);
    else if (!reqReal.reported)
      problems.push(
        'a bare call to a producer bound through `createRequire` discarded its exit code and the sweep said nothing: a fail-open in the rule that enumerates producers',
      );
    if (!reqWithout.ran)
      problems.push(`the sweep with the require-bound rule removed did not run (exit ${String(reqWithout.code)}), so that deletion is UNMEASURED`);
    else if (reqWithout.reported) problems.push('the sweep with the require-bound rule REMOVED still reported the plant, so that rule is not what catches it');

    // ── THE BINDING ACROSS A MODULE BOUNDARY ─────────────────────────────
    if (!me.includes(PACK_BOUND)) {
      console.log('  the pack-level producer rule is not written in the shape this proof removes, so');
      console.log('  the fourth section measures nothing. Re-anchor it before reading it again.');
      console.log('');
      console.log('EXIT 2 — UNMEASURED.');
      return 2;
    }
    const strippedPack = join(tmp, 'sweep-without-pack-resolution.ts');
    writeFileSync(strippedPack, me.replace(PACK_BOUND, PACK_BLIND));
    const crossPack = join(tmp, 'pack-cross-file');
    cpSync(join(ROOT, 'scripts/phase15'), crossPack, { recursive: true });
    plantCrossFile(crossPack);
    plantSameFile(crossPack);
    const crossReal = sweepFile(SWEEP, crossPack, CROSS_USER);
    const crossWithout = sweepFile(strippedPack, crossPack, CROSS_USER);
    const sameReal = sweepFile(SWEEP, crossPack, SAME_FILE);
    const sameWithout = sweepFile(strippedPack, crossPack, SAME_FILE);
    console.log('');
    console.log('  THE PRODUCER EXPORTED FROM ONE PACK FILE AND DISCARDED IN ANOTHER');
    console.log("  (both plants sit in ONE pack copy, so the exit code is the pack's; what is attributed");
    console.log('  here is whether each PLANTED FILE was named in the report)');
    console.log(
      `  across files    real sweep exit ${String(crossReal.code)}  ${crossReal.ran ? (crossReal.reported ? 'NAMED the discarded code' : 'did NOT name it') : 'did not run'}`,
    );
    console.log(
      `                  rule removed exit ${String(crossWithout.code)}  ${crossWithout.ran ? (crossWithout.reported ? 'NAMED it anyway' : 'did NOT name it — so that rule is what crosses the boundary') : 'did not run'}`,
    );
    console.log(
      `  same bytes,     real sweep exit ${String(sameReal.code)}  ${sameReal.ran ? (sameReal.reported ? 'NAMED it' : 'did NOT name it') : 'did not run'}`,
    );
    console.log(
      `  one file        rule removed exit ${String(sameWithout.code)}  ${sameWithout.ran ? (sameWithout.reported ? 'NAMED it too — the control: the per-file fixpoint still works' : 'did NOT name it') : 'did not run'}`,
    );
    if (!crossReal.ran) problems.push(`the real sweep did not run over the cross-file plant (exit ${String(crossReal.code)}), so its silence says nothing`);
    else if (!crossReal.reported)
      problems.push(
        'a producer exported from one pack file and called, with its code discarded, in another was not enumerated: the fixpoint stops at the module boundary',
      );
    if (!crossWithout.ran)
      problems.push(`the sweep with the pack rule removed did not run (exit ${String(crossWithout.code)}), so that deletion is UNMEASURED`);
    else if (crossWithout.reported)
      problems.push('the sweep with the pack-level rule REMOVED still reported the cross-file plant, so that rule is not what catches it');
    if (!sameWithout.ran)
      problems.push(
        `the sweep with the pack rule removed did not run over the one-file control (exit ${String(sameWithout.code)}), so the control is UNMEASURED`,
      );
    else if (!sameWithout.reported)
      problems.push('removing the PACK rule also blinded the sweep inside ONE file, so the deletion moves more than the boundary and attributes nothing');

    // ── THE ROUND-20 RULES, EACH WITH ITS OWN PLANT SET ────────────────
    //
    // These two are measured by running the sweep's OWN `--prove` suite twice:
    // once as it is, once with the one line replaced. What makes this an
    // attribution rather than a smoke test is the NAMED arm set: the stripped
    // copy must redden exactly the arms written for that rule and no others.
    for (const r of RULE_DELETIONS) {
      if (!me.includes(r.bound)) {
        console.log(`  ${r.label} is not written in the shape this proof removes, so that section`);
        console.log('  measures nothing. Re-anchor it before reading it again.');
        console.log(`    expected: ${r.bound.trim()}`);
        console.log('');
        console.log('EXIT 2 — UNMEASURED.');
        return 2;
      }
      const copy = join(tmp, `sweep-without-${r.label.replace(/[^a-z]+/gi, '-')}.ts`);
      writeFileSync(copy, me.replace(r.bound, r.blind));
      const run = spawnSync('npx', ['tsx', copy, '--prove'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      const ran = run.error === undefined && (run.status === 0 || run.status === 1);
      const moved = [...out.matchAll(/^ {2}(X\d+) NOT RED/gm)].map((m) => m[1] as string).sort();
      const want = [...r.arms].sort();
      console.log('');
      console.log(`  ${r.label.toUpperCase()}`);
      console.log(`  rule removed    exit ${String(run.status)}  arms that went blind: ${moved.length > 0 ? moved.join(', ') : 'none'}`);
      console.log(`  required        exactly ${want.join(', ')} — no more, because a deletion that moves other arms attributes nothing`);
      if (!ran) problems.push(`the copy without ${r.label} did not run (exit ${String(run.status)}), so that deletion is UNMEASURED`);
      else if (moved.join(',') !== want.join(','))
        problems.push(
          `removing ${r.label} blinded ${moved.length > 0 ? moved.join(', ') : 'NO arm at all'} where ${want.join(', ')} was required: a rule no plant depends on is decorative, and a deletion that moves other arms does not attribute`,
        );
    }

    // ── THE CALLEE-OBJECT EXCEPTION, ATTRIBUTED AT THE SITE AND NOT AT THE FILE ─
    //
    // Measured, and it corrected my first version of this section: with the
    // exception removed the planted FILE is still named — the conservative
    // fallback reports `map.get('go')` itself, because that callee's object
    // holds a producer. So a file-level arm attributes nothing here. What the
    // exception uniquely buys is the SITE: the call through the binding the
    // container handed out. This section reads the line.
    if (!me.includes(OBJECT_BOUND)) {
      console.log('  the callee-object exception is not written in the shape this proof removes, so');
      console.log('  this section measures nothing. Re-anchor it before reading it again.');
      console.log('');
      console.log('EXIT 2 — UNMEASURED.');
      return 2;
    }
    const objCopy = join(tmp, 'sweep-without-the-callee-object-exception.ts');
    writeFileSync(objCopy, me.replace(OBJECT_BOUND, OBJECT_BLIND));
    const objPack = join(tmp, 'pack-container-handoff');
    cpSync(join(ROOT, 'scripts/phase15'), objPack, { recursive: true });
    const CONTAINER = 'planted-container.ts';
    writeFileSync(
      join(objPack, CONTAINER),
      [
        "import { spawnSync } from 'node:child_process';",
        "const bag = new Map([['go', spawnSync]]);",
        'export function head(): string {',
        "  const got = bag.get('go');",
        "  const r = got?.('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });",
        "  return (r?.stdout ?? '').trim();",
        '}',
        '',
      ].join('\n'),
    );
    const sitesOf = (script: string): { readonly ran: boolean; readonly through: boolean; readonly code: number | null } => {
      const run = spawnSync('npx', ['tsx', script], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, P15_SWEEP_DIR: objPack },
      });
      const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      const header = 'CALLS WHOSE EXIT CODE IS NEVER READ';
      const block = out.includes(header) ? out.slice(out.indexOf(header)) : '';
      return { ran: run.error === undefined && (run.status === 0 || run.status === 1), through: block.includes('got?.('), code: run.status };
    };
    const objReal = sitesOf(SWEEP);
    const objWithout = sitesOf(objCopy);
    console.log('');
    console.log('  THE CALLEE-OBJECT EXCEPTION (read at the SITE: the call through what the container handed out)');
    console.log(
      `  real sweep      exit ${String(objReal.code)}  ${objReal.ran ? (objReal.through ? 'NAMED the call through the handed-out binding' : 'did NOT name it') : 'did not run'}`,
    );
    console.log(
      `  rule removed    exit ${String(objWithout.code)}  ${objWithout.ran ? (objWithout.through ? 'NAMED it anyway' : 'did NOT name it — so the exception is what reads it') : 'did not run'}`,
    );
    console.log('  (the planted FILE is named in both arms, by the fallback reading `bag.get` itself — which is');
    console.log('   why this is attributed at the site)');
    if (!objReal.ran) problems.push(`the real sweep did not run over the container plant (exit ${String(objReal.code)}), so its silence says nothing`);
    else if (!objReal.through)
      problems.push('a producer handed out of a container through a method call was not followed to the call that discarded its exit code');
    if (!objWithout.ran) problems.push(`the copy without the callee-object exception did not run (exit ${String(objWithout.code)}): UNMEASURED`);
    else if (objWithout.through) problems.push('the copy WITHOUT the callee-object exception still named that site, so the exception is not what reads it');

    console.log('');
    if (problems.length > 0) {
      for (const p of problems) console.log(`  FINDING: ${p}`);
      console.log('');
      console.log(`EXIT 1 — ${String(problems.length)} finding(s). A rule that can be deleted without the proof noticing was never doing the work.`);
      return 1;
    }
    console.log('The provenance requirement is load-bearing: deleting that one line makes the planted');
    console.log('  defect invisible, and restoring it makes it visible again. The apparatus is READ like');
    console.log('  every other file in the pack, on all five shapes that each reopened the exemption it');
    console.log('  used to have \u2014 both spellings of child_process, a property access on a module object,');
    console.log('  and a sibling handing it a producer by a STATIC and by a DYNAMIC import \u2014 and a copy');
    console.log('  with the file deleted from the swept set goes blind to all five while still naming an');
    console.log('  ordinary planted file, which is what attributes those reads to membership and not to');
    console.log('  some other rule. A producer bound through `createRequire` and renamed is enumerated,');
    console.log('  and is invisible without the one line that enumerates it. The binding is followed');
    console.log('  ACROSS a module boundary, and removing that one line blinds the cross-file plant while');
    console.log('  the SAME bytes in one file stay visible.');
    console.log(`  ${String(RULE_DELETIONS.length)} rules carry a deletion of their own, each pinned to the arms it owns and no others:`);
    for (const r of RULE_DELETIONS) console.log(`    ${r.label} \u2014 ${r.arms.join(', ')}`);
    console.log('  NINETEEN of those arm lists were WRONG when first written, and this instrument');
    console.log('  said so every time. In round 22: the hand-over rule was anchored to the wrong one');
    console.log('  of two lines calling the same helper, and the cycle-cut rule blinded NO arm,');
    console.log('  because the plant written for it did not depend on it. In round 23: three rules');
    console.log('  blinded no arm at all \u2014 one because the conservative fallback already caught the');
    console.log('  plant, one because the plant used the OTHER copy of a two-copy line, and one');
    console.log('  because a removed resolver candidate turns into a NAMED REFUSAL rather than a');
    console.log('  miss \u2014 and six blinded MORE arms than claimed. In round 24: one more rule blinded');
    console.log('  no arm, because its plant carried an initializer and the DECLARATION rule caught');
    console.log('  it first; and the new boundary refusal made three older arms red FOR ANOTHER');
    console.log('  REASON, which this instrument reports as a deletion that no longer attributes');
    console.log('  \u2014 those three now read the CALL and not the file. Five plants were built or');
    console.log('  rebuilt and four arms tightened across those rounds, and every list here is the');
    console.log('  MEASURED set.');
    console.log('  The two rules round 20 added carry their own deletions: the conservative callee');
    console.log('  fallback, removed, blinds X44, X45 and X60 \u2014 X60 was written for another rule and');
    console.log('  this is the rule that actually catches it; and the one exception');
    console.log('  to the callee rule \u2014 reading the OBJECT of a method call \u2014 removed, stops the sweep');
    console.log('  following a producer a container handed out, attributed at the SITE because the');
    console.log('  planted FILE is named in both arms. The apparatus is read on a sixth shape too: its');
    console.log('  own parameter DEFAULT, which is the plant round 20 walked into the file with.');
    console.log('  One attribution is stated narrowly on purpose: removing the require-bound line reddens');
    console.log('  six plants, not one, because every producer in this pack is derived through that call.');
    console.log('  Every plant and every run happens in a throwaway copy; neither this repository nor');
    console.log('  the pack is written to.');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exitCode = main();
