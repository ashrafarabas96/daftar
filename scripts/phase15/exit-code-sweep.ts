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
 *   1. The call's own result is bound to a name and that name's `.status` is
 *      COMPARED within the following 28 lines; or
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
 *   verify:exit-codes:phase15 -- --prove` is what shows it can go red.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const ROOT = process.cwd();
const PACK = process.env.P15_SWEEP_DIR ?? join(ROOT, 'scripts/phase15');
const WINDOW = 28;

/**
 * THE ONE EXEMPTION, AND WHY IT IS NOT A HOLE
 *   This file is itself in the pack it reads, and its red proofs contain the
 *   SOURCE TEXT of the defects they plant. A text sweep cannot tell a planted
 *   literal from a call, so without an exemption this instrument reports its
 *   own plants and is permanently red — the same way a red proof can redden its
 *   own harness.
 *
 *   An exemption taken on trust is how a sweep comes to certify the thing it
 *   was built to catch, so this one is MEASURED, not asserted: the file does not
 *   import `spawnSync` as a value, therefore
 *   it cannot call it, therefore it has no exit code to discard. That is checked
 *   below against this file's own bytes at every run, and the exemption is
 *   printed with the verdict. If a later edit makes this file actually run a
 *   command, the check fails and the exemption is withdrawn.
 */
const APPARATUS = 'exit-code-sweep.ts';

function apparatusIsInert(dir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, APPARATUS), 'utf8');
  } catch {
    return null; // not in this copy of the pack: nothing to exempt
  }
  // Anchored to column 0 on its own line: a value import is a top-level
  // statement, while the same text INSIDE a plant literal is always indented
  // as an argument. The unanchored form matched this file's own X1 plant and
  // withdrew the exemption on the strength of a string — a check fooled by the
  // very text it exists to tell apart from code.
  const valueImport = /^import\s*\{[^}]*\bspawnSync\b[^}]*\}\s*from\s*'node:child_process'/m.test(text);
  return valueImport
    ? `${APPARATUS} imports spawnSync as a VALUE, so it can run commands and its exemption is withdrawn`
    : null;
}

interface Wrapper {
  readonly name: string;
  readonly file: string;
  readonly line: number;
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
  for (const name of readdirSync(dir).sort())
    if (name.endsWith('.ts')) out.set(name, readFileSync(join(dir, name), 'utf8').split('\n'));
  return out;
};

/**
 * A `.status` COMPARISON on `name` within `text`, or null — and the matched
 * text, so the verdict prints what was actually matched.
 *
 * The coordinator's round-7 B3(i): the old qualification accepted `.error`
 * alone while the report printed "reads r.status" unconditionally, so a
 * wrapper that could not tell exit 1 from exit 0 went on excusing every call
 * it covered, under a sentence that said otherwise. An `.error` test answers
 * "did the process start"; only a `.status` comparison answers "did it
 * succeed". B3(iii): a MENTION is not a reading either — `${name}.status`
 * inside a message string is how X3 got through — so the code must appear in
 * a comparison or a condition.
 */
function statusDecision(name: string, text: string): string | null {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${n}\\.status\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*[^;)\\n]{0,24}|if\\s*\\(\\s*!?\\s*${n}\\.status\\s*\\)`);
  const m = re.exec(text);
  return m === null ? null : m[0].replace(/\s+/g, ' ').trim();
}

/** `<expr>.status` compared on the spot, where the expr is the call itself. */
function inlineDecision(text: string): string | null {
  const m = /\)\s*\.status\s*(?:===|!==|==|!=|>=|<=|>|<)\s*[^;)\n]{0,24}/.exec(text);
  return m === null ? null : m[0].replace(/\s+/g, ' ').trim();
}

/**
 * The line with its STRINGS, TEMPLATES and trailing comment removed.
 *
 * A text sweep that reads prose as code reports the word "run (" in a comment
 * as a call site, and then names a defect that does not exist. Dropping the
 * quoted spans is not a softening: nothing inside them executes.
 */
function codeOnly(line: string): string {
  if (/^\s*(?:\*|\/\/)/.test(line)) return '';
  return line
    .replace(/`[^`]*`/g, '``')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/\/\/.*$/, '');
}

interface Decl {
  readonly name: string;
  readonly line: number; // 0-based
  readonly sig: string;
  readonly body: string;
  /** Whether this declaration is a FUNCTION: only a function can forward. */
  readonly isFunction: boolean;
}

function declarations(lines: readonly string[]): readonly Decl[] {
  const out: Decl[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const code = codeOnly(lines[i] ?? '');
    const decl = /(?:function\s+(\w+)|const\s+(\w+)\s*=)/.exec(code);
    const name = decl?.[1] ?? decl?.[2];
    if (name === undefined) continue;
    const isFunction = /\bfunction\s+\w+|=\s*(?:async\s*)?\(|=\s*(?:async\s*)?\w+\s*=>|=\s*(?:async\s*)?function/.test(code);
    out.push({ name, line: i, sig: lines.slice(i, i + 4).join('\n'), body: lines.slice(i, i + 30).join('\n'), isFunction });
  }
  return out;
}

/** Wrappers whose own body DECIDES on the exit code of the result handed to them. */
function wrappersIn(src: ReadonlyMap<string, readonly string[]>): readonly Wrapper[] {
  const found: Wrapper[] = [];
  for (const [file, lines] of src)
    for (const d of declarations(lines)) {
      const param = /(\w+)\s*:\s*(?:SpawnSyncReturns|ReturnType<typeof spawnSync>)/.exec(d.sig)?.[1];
      if (param === undefined) continue;
      const matched = statusDecision(param, d.body);
      if (matched !== null) found.push({ name: d.name, file, line: d.line + 1, param, matched });
    }
  return found;
}

/** The declaration a line sits inside: the nearest one at or above it. */
function enclosing(decls: readonly Decl[], line: number): Decl | null {
  let best: Decl | null = null;
  for (const d of decls) if (d.isFunction && d.line <= line && (best === null || d.line > best.line)) best = d;
  return best;
}

/**
 * Does this declaration hand the exit code OUTWARD instead of deciding on it?
 *
 * B3(ii): the old sweep exempted any spawn line containing `return` or `=>`
 * outright, an exemption the header never declared. `pg-cluster.ts`'s `run()`
 * is exactly that shape, and two of its callers discarded the code — so the
 * exemption was certifying the defect class the sweep exists to catch.
 * Forwarding is legitimate, but it only MOVES the decision: so the forwarder
 * is named here, its call sites are measured below, and it is excused only
 * when every one of them decides.
 */
function forwards(d: Decl, boundName: string | null, producer: string): string | null {
  const pr = producer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`return\\s+${pr}\\(`).test(d.body)) return `return ${producer}(…)`;
  if (new RegExp(`=>\\s*${pr}\\(`).test(d.body)) return `=> ${producer}(…)`;
  if (boundName !== null) {
    const n = boundName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`return\\s+${n}\\s*;`).test(d.body)) return `return ${boundName};`;
    if (new RegExp(`status\\s*:\\s*${n}\\.status`).test(d.body)) return `return { status: ${boundName}.status, … }`;
  }
  if (/return\s*\{[^}]*status\s*:/.test(d.body)) return 'return { status: … }';
  return null;
}

/**
 * Is the value a producer (`spawnSync` itself, or a forwarder) yields at THIS
 * call site decided? Returns a reason when it is, a forwarder name when the
 * decision is deferred to one, or null when the code is discarded.
 */
function decideAt(
  lines: readonly string[],
  i: number,
  producer: string,
  wrappers: readonly Wrapper[],
  file: string,
  decls: readonly Decl[],
): { readonly kind: 'read'; readonly how: string } | { readonly kind: 'defer'; readonly to: string } | null {
  const line = lines[i] ?? '';
  const window = lines.slice(i, i + WINDOW).join('\n');
  const near = lines.slice(i, i + 3).join('\n');
  const bound = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*(?::[^=]+)?=\\s*(?:await\\s+)?${producer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(`).exec(line)?.[1] ?? null;
  if (bound !== null) {
    const own = statusDecision(bound, window);
    if (own !== null) return { kind: 'read', how: `${bound}: ${own}` };
    // THROUGH ONE ALIAS. `const status = r.status;` followed by `if (status
    // !== 0)` is a decision on the exit code, and refusing it would push the
    // pack toward a shape chosen to satisfy this sweep rather than to be read.
    // The alias is measured, not assumed: the copy and the comparison must
    // both be in the window.
    const alias = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*(?::[^=\\n]+)?=\\s*${bound}\\.status\\b`).exec(window)?.[1];
    if (alias !== undefined) {
      const a = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const viaAlias = new RegExp(`\\b${a}\\s*(?:===|!==|==|!=|>=|<=|>|<)\\s*[^;)\\n]{0,24}|if\\s*\\(\\s*!?\\s*${a}\\s*\\)`).exec(window);
      if (viaAlias !== null) return { kind: 'read', how: `${bound}.status → ${alias}: ${viaAlias[0].replace(/\s+/g, ' ').trim()}` };
    }
    const toWrapper = wrappers.find((w) => new RegExp(`\\b${w.name}\\(\\s*${bound}\\b`).test(window));
    if (toWrapper !== undefined) return { kind: 'read', how: `${bound} → ${toWrapper.name}() at ${toWrapper.file}:${toWrapper.line}` };
    const d = enclosing(decls, i);
    if (d !== null) {
      const f = forwards(d, bound, producer);
      if (f !== null) return { kind: 'defer', to: d.name };
    }
    return null;
  }
  const inline = inlineDecision(near);
  if (inline !== null) return { kind: 'read', how: `on the spot: ${inline}` };
  const back = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
  const matches = wrappers.filter((w) => new RegExp(`\\b${w.name}\\(`).test(back));
  const via = matches.find((w) => w.file === file) ?? matches[0];
  if (via !== undefined) return { kind: 'read', how: `argument to ${via.name}() at ${via.file}:${via.line}` };
  const d = enclosing(decls, i);
  if (d !== null) {
    const f = forwards(d, null, producer);
    if (f !== null) return { kind: 'defer', to: d.name };
  }
  return null;
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
  const src = new Map(sources(dir));
  const apparatusProblem = apparatusIsInert(dir);
  if (apparatusProblem === null) src.delete(APPARATUS);
  const wrappers = wrappersIn(src);
  const decls = new Map<string, readonly Decl[]>([...src].map(([f, l]) => [f, declarations(l)]));
  const declsOf = (f: string): readonly Decl[] => decls.get(f) ?? [];

  type Raw = { file: string; line: number; text: string; d: ReturnType<typeof decideAt> };
  const raws: Raw[] = [];
  for (const [file, lines] of src)
    for (let i = 0; i < lines.length; i += 1) {
      if (!codeOnly(lines[i] ?? '').includes('spawnSync(')) continue;
      raws.push({ file, line: i, text: (lines[i] ?? '').trim().slice(0, 78), d: decideAt(lines, i, 'spawnSync', wrappers, file, declsOf(file)) });
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
  const sitesOf = new Map<string, { file: string; line: number; text: string; d: ReturnType<typeof decideAt> }[]>();
  const addToken = (key: string): void => {
    if (sitesOf.has(key)) return;
    const [home, token] = key.split('::') as [string, string];
    const sites: { file: string; line: number; text: string; d: ReturnType<typeof decideAt> }[] = [];
    const call = new RegExp(`\\b${token}\\s*\\(`);
    const own = new RegExp(`\\b(?:function|const|let|var)\\s+${token}\\b`);
    const imports = new RegExp(`^import\\s*\\{[^}]*\\b${token}\\b[^}]*\\}`, 'm');
    for (const [file, lines] of src) {
      if (file !== home && !imports.test(lines.join('\n'))) continue;
      for (let i = 0; i < lines.length; i += 1) {
        const line = codeOnly(lines[i] ?? '');
        if (!call.test(line) || own.test(line) || /^import\s/.test(line)) continue;
        const d = decideAt(lines, i, token, wrappers, file, declsOf(file));
        sites.push({ file, line: i, text: (lines[i] ?? '').trim().slice(0, 78), d });
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
      if (sites.every((s) => s.d?.kind === 'read' || (s.d?.kind === 'defer' && (s.d.to !== token || s.file !== key.split('::')[0]) && safe.has(keyOf(s.file, s.d.to))))) safe.add(key);
    }

  const unchecked: Site[] = [];
  const read: Site[] = [];
  for (const r of raws) {
    const site = (how: string | null, note?: string): Site => ({ file: r.file, line: r.line + 1, text: note === undefined ? r.text : `${r.text}   — ${note}`, bound: null, via: null, how });
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
      for (const s of bad) unchecked.push({ file: s.file, line: s.line + 1, text: `${s.text}   — discards the code ${r.d.to}() returns`, bound: null, via: null, how: null });
    }
  }
  if (apparatusProblem !== null) unchecked.push({ file: APPARATUS, line: 0, text: apparatusProblem, bound: null, via: null, how: null });
  const forwarders: Forwarder[] = [...sitesOf].map(([key, sites]) => ({
    token: `${key.split('::')[1]} (${key.split('::')[0]})`,
    safe: safe.has(key),
    sites: sites.map((s) => ({ file: s.file, line: s.line + 1, text: s.text, how: s.d === null ? null : s.d.kind === 'read' ? s.d.how : `deferred to ${s.d.to}()` })),
  }));
  return { unchecked, read, wrappers, forwarders };
}

function report(dir: string, r: SweepResult): void {
  console.log(`  pack ${dir}`);
  console.log(`  exempt ${APPARATUS} — this instrument's own source, which carries the TEXT of the`);
  console.log('         defects its red proofs plant. Measured inert at every run: it does not import');
  console.log('         spawnSync as a value, so it cannot run a command and has no code to discard.');
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
      writeFileSync(f, ["import { spawnSync } from 'node:child_process';", "const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });", 'export const clean = (r.stdout ?? "").trim().length === 0;', ''].join('\n'));
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
    what: "a real wrapper stops reading the code — every call it covers must fall back to unchecked",
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
    expect: (r) => (r.unchecked.some((s) => s.file === 'backup-restore-proof.ts') ? null : 'the reintroduced discarded-status provenance read was not reported'),
  },
  {
    id: 'X5',
    what: 'a wrapper reduced to its .error test — it answers "did it start", not "did it succeed"',
    plant: (dir) => {
      const f = join(dir, 'pg-version-matrix.ts');
      const s = readFileSync(f, 'utf8');
      const broken = s
        .replace('  if (r.status === 0) return (r.stdout ?? \'\').toString();', '  if (false) return (r.stdout ?? \'\').toString();')
        .replace('  if (allowNoMatch && r.status === 1) return (r.stdout ?? \'\').toString();', '  if (allowNoMatch) return (r.stdout ?? \'\').toString();');
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
      const broken = s.replace('  if (r.status !== 0) throw new ClusterError(`${what}: exit ${r.status}`', '  if (false) throw new ClusterError(`${what}: exit ${r.status}`');
      if (broken === s) throw new Error('X6 could not plant: must() no longer compares r.status in the shape this proof edits');
      writeFileSync(f, broken);
    },
    expect: (r) =>
      r.wrappers.some((w) => w.name === 'must')
        ? 'must() no longer compares the status yet still qualified — the exit code is named only in its message'
        : r.unchecked.some((s) => s.file === 'pg-cluster.ts')
          ? null
          : 'nothing was reported after the only wrapper deciding pg-cluster\'s exit codes stopped deciding',
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
    expect: (r) => (r.unchecked.some((s) => s.file === 'planted-x7.ts') ? null : 'an arrow-bodied call whose exit code is discarded was exempted, which is the blanket `=>` exemption returning'),
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
          "function raw(args: readonly string[]): ReturnType<typeof spawnSync> {",
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
    id: 'X9',
    control: true,
    what: 'THE CONTROL — a forwarder whose caller DOES decide must stay green, or rule 4 is a blanket red',
    plant: (dir) => {
      const f = join(dir, 'planted-x9.ts');
      writeFileSync(
        f,
        [
          "import { spawnSync } from 'node:child_process';",
          "function raw2(args: readonly string[]): ReturnType<typeof spawnSync> {",
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
  console.log(`  X0 BASELINE  the untouched pack is clean: OK (0 unchecked, ${base.read.length} read, ${base.wrappers.length} measured wrapper(s), ${base.forwarders.filter((f) => f.safe).length} of ${base.forwarders.length} forwarder(s) fully measured)`);
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
