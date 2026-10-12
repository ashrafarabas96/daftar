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
 *   1. The call's own result is bound to a name and that name's `.status` or
 *      `.error` is read within the following 28 lines; or
 *   2. the call sits in ARGUMENT position inside a wrapper that reads the code
 *      itself.
 *
 *   Case 2 is an exemption, and an unmeasured exemption is how a sweep comes to
 *   certify the thing it was built to catch. So a wrapper is never taken on
 *   trust: it qualifies only when its own signature takes a spawn result AND
 *   its own body reads that parameter's `.status`/`.error`. The qualifying
 *   wrappers, and where each one reads the code, are PRINTED with the verdict,
 *   and a wrapper is resolved in the calling file first — a same-named helper in
 *   another file says nothing about this call.
 *
 * WHAT IT DOES NOT DECIDE
 *   That a tool reads an exit code does not make the tool correct; it only
 *   removes one way for it to be silently wrong. And this sweep is a text
 *   reading of the pack, not of the program's behaviour: `npm run
 *   verify:exit-codes:phase15 -- --prove` is what shows it can go red.
 */
import type { SpawnSyncReturns } from 'node:child_process';
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
 *   import `spawnSync` as a value (only the `SpawnSyncReturns` type), therefore
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
}
interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly bound: string | null;
  readonly via: Wrapper | null;
}

const sources = (dir: string): ReadonlyMap<string, readonly string[]> => {
  const out = new Map<string, readonly string[]>();
  for (const name of readdirSync(dir).sort())
    if (name.endsWith('.ts')) out.set(name, readFileSync(join(dir, name), 'utf8').split('\n'));
  return out;
};

/** Wrappers whose own body reads the exit code of the spawn result handed to them. */
function wrappersIn(src: ReadonlyMap<string, readonly string[]>): readonly Wrapper[] {
  const found: Wrapper[] = [];
  for (const [file, lines] of src)
    for (let i = 0; i < lines.length; i += 1) {
      const decl = /(?:function\s+(\w+)|const\s+(\w+)\s*=)/.exec(lines[i] ?? '');
      const name = decl?.[1] ?? decl?.[2];
      if (name === undefined) continue;
      const sig = lines.slice(i, i + 4).join('\n');
      const param = /(\w+)\s*:\s*(?:SpawnSyncReturns|ReturnType<typeof spawnSync>)/.exec(sig)?.[1];
      if (param === undefined) continue;
      const body = lines.slice(i, i + 30).join('\n');
      // A MENTION IS NOT A READING. The first version of this test accepted any
      // occurrence of `param.status` in the body, and proof X3 showed why that is
      // not enough: neutering the condition to `if (false)` left the exit code
      // named only inside the failure MESSAGE, and the wrapper still qualified —
      // so a wrapper that had stopped deciding anything went on excusing every
      // call it covered. The code must appear in a COMPARISON or a condition:
      // that is the difference between printing it and acting on it.
      const decided = new RegExp(
        `\\b${param}\\.(status|error)\\s*(?:===|!==|==|!=|>=|<=|>|<)|if\\s*\\([^)]*\\b${param}\\.(status|error)\\b\\s*(?:\\)|&&|\\|\\|)`,
      ).test(body);
      if (decided) found.push({ name, file, line: i + 1, param });
    }
  return found;
}

function sweep(dir: string): { readonly unchecked: readonly Site[]; readonly viaWrapper: readonly Site[]; readonly wrappers: readonly Wrapper[] } {
  const src = new Map(sources(dir));
  const apparatusProblem = apparatusIsInert(dir);
  if (apparatusProblem === null) src.delete(APPARATUS);
  const wrappers = wrappersIn(src);
  const unchecked: Site[] = [];
  const viaWrapper: Site[] = [];
  for (const [file, lines] of src)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!line.includes('spawnSync(')) continue;
      const text = line.trim().slice(0, 78);
      const bound = /const\s+(\w+)\s*=\s*spawnSync\(/.exec(line)?.[1] ?? null;
      if (bound !== null) {
        const window = lines.slice(i, i + WINDOW).join('\n');
        if (!new RegExp(`\\b${bound}\\.(status|error)\\b`).test(window)) unchecked.push({ file, line: i + 1, text, bound, via: null });
        continue;
      }
      // the definition of a wrapper, or a call whose code is read on the spot
      if (/\breturn\b|=>/.test(line) || /\.\s*status/.test(lines.slice(i, i + 3).join('\n'))) continue;
      const back = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      const matches = wrappers.filter((w) => new RegExp(`\\b${w.name}\\(`).test(back));
      const via = matches.find((w) => w.file === file) ?? matches[0] ?? null;
      if (via === null) unchecked.push({ file, line: i + 1, text, bound: null, via: null });
      else viaWrapper.push({ file, line: i + 1, text, bound: null, via });
    }
  if (apparatusProblem !== null) unchecked.push({ file: APPARATUS, line: 0, text: apparatusProblem, bound: null, via: null });
  return { unchecked, viaWrapper, wrappers };
}

function report(dir: string, r: ReturnType<typeof sweep>): void {
  console.log(`  pack ${dir}`);
  console.log(`  exempt ${APPARATUS} — this instrument's own source, which carries the TEXT of the`);
  console.log("         defects its red proofs plant. Measured inert: it imports only the");
  console.log('         SpawnSyncReturns type, never spawnSync as a value, so it runs no command.');
  console.log('');
  console.log('  WRAPPERS THAT READ THE EXIT CODE THEMSELVES (measured in their own body, not assumed)');
  if (r.wrappers.length === 0) console.log('    none — so no call is excused by argument position');
  for (const w of r.wrappers) console.log(`    ${w.name} — ${w.file}:${w.line}, reads ${w.param}.status`);
  console.log('');
  console.log('  CALLS WHOSE CODE IS READ BY ONE OF THOSE WRAPPERS');
  if (r.viaWrapper.length === 0) console.log('    none');
  for (const s of r.viaWrapper) console.log(`    ${s.file}:${s.line} → ${s.via?.name}() at ${s.via?.file}:${s.via?.line}`);
  console.log('');
  console.log('  CALLS WHOSE EXIT CODE IS NEVER READ');
  if (r.unchecked.length === 0) console.log('    none');
  for (const s of r.unchecked) console.log(`    ${s.file}:${s.line}  ${s.bound === null ? '(not bound to a name)' : `var=${s.bound}`}  ${s.text}`);
}

/* ── red proofs: can this sweep go red? ───────────────────────────────────── */

interface Plant {
  readonly id: string;
  readonly what: string;
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
          'function textOf(r: SpawnSyncReturns<string>): string {',
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
  console.log(`  X0 BASELINE  the untouched pack is clean: OK (0 unchecked, ${base.viaWrapper.length} covered by ${base.wrappers.length} measured wrapper(s))`);
  let failures = 0;
  for (const p of PLANTS) {
    const dir = mkdtempSync(join(tmpdir(), 'p15-sweep-'));
    try {
      cpSync(PACK, join(dir, 'phase15'), { recursive: true });
      const copy = join(dir, 'phase15');
      p.plant(copy);
      const r = sweep(copy);
      const problem = p.expect(r);
      if (problem === null) console.log(`  ${p.id} RED      ${p.what}`);
      else {
        failures += 1;
        console.log(`  ${p.id} NOT RED  ${p.what}`);
        console.log(`       ${problem}`);
      }
    } catch (e) {
      failures += 1;
      console.log(`  ${p.id} NOT RED  ${p.what}`);
      console.log(`       the plant itself failed: ${(e as Error).message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('');
  if (failures > 0) {
    console.log(`EXIT 1 — ${failures} of ${PLANTS.length} plant(s) did not redden the sweep. An instrument that cannot`);
    console.log('  go red is not evidence, and the green verdict it prints elsewhere is worth nothing.');
    return 1;
  }
  console.log(`All ${PLANTS.length} planted defects are detected, and the untouched pack is clean.`);
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
    console.log(`EXIT 0 — every spawnSync in ${basename(PACK)} has its exit code read: ${r.viaWrapper.length} through`);
    console.log(`  ${r.wrappers.length} wrapper(s) measured above, the rest on their own result.`);
    console.log('  This is a reading of the source, not of behaviour. `-- --prove` shows it can go red.');
    process.exitCode = 0;
  }
}
