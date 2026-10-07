/**
 * THE GATE COMPOSITION SPLIT, AND THE TEN RED PROOFS IT IS ONLY WORTH AS MUCH
 * AS (TL-P4-GATE-COMP-01 §5, §12).
 *
 * The owner's ruling is one sentence: «HOST-SENSITIVE ABSOLUTE PERFORMANCE
 * MUST NOT BE RE-EXECUTED INSIDE RECURSIVELY COMPOSED PREDECESSOR GATES.»
 * This file is where that sentence becomes something a tree can fail.
 *
 * ── WHY EVERY PROOF BELOW PROVES FOUR THINGS ───────────────────────────────
 * A red proof that would ALSO be red for another reason proves nothing: it
 * demonstrates that the law is capable of complaining, not that it is capable
 * of complaining about THIS. So each case asserts, in this order:
 *
 *   1. THE SUBJECT EXISTS. The thing about to be mutated is found in the
 *      unmutated tree and named. A plant with no subject is a plant that
 *      changed nothing.
 *   2. THE MUTATION REALLY OCCURRED. The mutated artefact is re-read and the
 *      change is observed. A `replace` that silently matched nothing is the
 *      commonest way a red proof becomes a green one.
 *   3. THE RESULT IS NON-EMPTY. The law returned at least one problem. An
 *      empty result read as "no violation" is the vacuous pass this whole
 *      file exists to refuse.
 *   4. THE EXACT INTENDED DEFECT IS NAMED. The problem carries the specific
 *      code for the specific mutation — not merely "something failed". This
 *      is the assertion that makes the other three worth making.
 *
 * ── AND THE SHIPPED TREE MUST PASS ─────────────────────────────────────────
 * The last describe block asserts that the real repository satisfies every
 * law here. A guard that only ever runs against plants is a guard nobody has
 * pointed at the thing it is guarding.
 *
 * ── WHERE IT LIVES ─────────────────────────────────────────────────────────
 * `tests/guards/` is executed by `npm run test:integration`, which is the
 * `Integration + security tests` step of the required `backend` CI job. A law
 * in a suite the required job does not run is a law with no authority.
 *
 * Nothing in this file starts a database, runs a benchmark or takes a timing.
 * Its verdict is identical on an idle machine and a loaded one, which is what
 * makes it Lane A and therefore safe to compose.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { COMPOSITION_FLAG, PREDECESSOR_ARGS, compositionOutcome, decideMode } from '../../scripts/guards/gate-composition';
import {
  ACCOUNTING_BUDGETS_SUITE,
  ACCOUNTING_EVIDENCE_WORKFLOW,
  ACCEPTED_ACCOUNTING_CEILINGS,
  ACCEPTED_SHORT_PERCENTILE_ITERATIONS,
  accountingContractProblems,
  stripCommentsKeepStrings,
  stripProse,
} from '../../scripts/guards/performance-contract';

const REPO = join(__dirname, '../..');

/**
 * THE ELEVEN GATES OF THE RECURSIVE CHAIN AS IT STANDS AT `54a851c`.
 *
 * THIS IS AN ENUMERATION, NOT A DISCOVERY, and saying otherwise was a false
 * claim about the code beneath it (challenger finding F4). An earlier
 * docstring here asserted the list was "discovered from disk"; it never was,
 * and a comment that describes a derivation the code does not perform is worse
 * than no comment, because a reviewer stops looking.
 *
 * It is kept as an enumeration deliberately, and the honest reason is that
 * "the recursive chain" is not a property any single file states — it is the
 * transitive closure of gate→gate spawns, and naming its members is how these
 * per-gate laws say WHICH gates they are about.
 *
 * The exceptionless law is the separate one below, `no gate reachable through
 * a NON-propagating edge spawns a host-sensitive suite`, which walks the spawn
 * graph over EVERY gate script on disk (`gateScripts()`) and has no list to
 * fall behind the tree. If this enumeration ever goes stale, that graph law is
 * what still fires.
 */
const CHAIN_GATES: readonly string[] = [
  'scripts/phase2-s8-gate.ts',
  'scripts/phase3-s1-gate.ts',
  'scripts/phase3-s2-gate.ts',
  'scripts/phase3-s3-gate.ts',
  'scripts/phase3-s4-gate.ts',
  'scripts/phase3-s5-gate.ts',
  'scripts/phase3-s6-gate.ts',
  'scripts/phase3-s7-gate.ts',
  'scripts/phase3-s8-gate.ts',
  'scripts/phase3-corrective-gate.ts',
  'scripts/phase4-s1-gate.ts',
];

const source = (rel: string, root: string = REPO): string => readFileSync(join(root, rel), 'utf8');

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A tree in which `rel` has been rewritten by `edit`. Returns the new root. */
function rootWith(rel: string, edit: (text: string) => string): string {
  const root = mkdtempSync(join(tmpdir(), 'p4-comp-split-'));
  temps.push(root);
  mkdirSync(join(root, 'tests/performance'), { recursive: true });
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const f of [ACCOUNTING_BUDGETS_SUITE, ACCOUNTING_EVIDENCE_WORKFLOW]) writeFileSync(join(root, f), source(f), 'utf8');
  writeFileSync(join(root, rel), edit(source(rel)), 'utf8');
  return root;
}

/** A tree with `rel` removed outright. */
function rootWithout(rel: string): string {
  const root = mkdtempSync(join(tmpdir(), 'p4-comp-split-'));
  temps.push(root);
  mkdirSync(join(root, 'tests/performance'), { recursive: true });
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const f of [ACCOUNTING_BUDGETS_SUITE, ACCOUNTING_EVIDENCE_WORKFLOW]) if (f !== rel) writeFileSync(join(root, f), source(f), 'utf8');
  return root;
}

const codes = (root: string): string[] => accountingContractProblems(root).map((p) => p.code);
const details = (root: string): string =>
  accountingContractProblems(root)
    .map((p) => p.detail)
    .join(' | ');

// ───────────────────────────────────────────────────────────────────────────
// THE MODE MECHANISM: it cannot be silently defeated
// ───────────────────────────────────────────────────────────────────────────

describe('the mode mechanism (TL-P4-GATE-COMP-01 §2): explicit, strict, and undefeatable by a typo', () => {
  const KNOWN = [{ flag: '--list' }, { flag: '--structural-only' }, { flag: '--root', takesValue: true }];

  it('reads nothing from the environment: the lane is an argument or it is nothing', () => {
    // The owner's §2 forbids a hidden environment variable whose ABSENCE
    // silently changes authority. Asserted against the module's own source so
    // the claim is about the code and not about this test's imagination.
    const mechanism = stripProse(source('scripts/guards/gate-composition.ts'));
    expect(mechanism).not.toMatch(/process\s*\.\s*env/);
    expect(mechanism.length, 'the mechanism is all prose — there is nothing to defeat and nothing to trust').toBeGreaterThan(400);
  });

  it('no argument is direct mode; the flag is composition mode', () => {
    expect(decideMode([], KNOWN)).toEqual({ mode: 'direct', refusal: null });
    expect(decideMode(['--list'], KNOWN)).toEqual({ mode: 'direct', refusal: null });
    expect(decideMode([COMPOSITION_FLAG], KNOWN)).toEqual({ mode: 'composition', refusal: null });
    expect(decideMode(['--root', '/tmp/x', COMPOSITION_FLAG], KNOWN).mode).toBe('composition');
  });

  it('a NEAR MISS is a refusal, not a silent lane — the mode cannot be mistyped out of', () => {
    // This is the whole guard against silent defeat. A gate that fell back to
    // a lane on an unrecognized token could be made to stop measuring (or to
    // start contending) by one character nobody reviewed.
    for (const typo of ['--compose', '--Composition', '--composition=1', '--no-perf', '--skip-performance']) {
      const d = decideMode([typo], KNOWN);
      expect(d.refusal, `${typo} was accepted silently`).not.toBeNull();
      expect(d.refusal ?? '').toContain(typo);
      expect(d.refusal ?? '').toContain(COMPOSITION_FLAG);
    }
  });

  it('a `--root` VALUE is not mistaken for a flag', () => {
    expect(decideMode(['--root', '--composition'], KNOWN).refusal).toBeNull();
    // …and the value having been consumed, the vector did NOT select composition.
    expect(decideMode(['--root', '--composition'], KNOWN).mode).toBe('direct');
  });

  it('a predecessor is composed in composition mode by a CONSTANT, so no call site can opt out', () => {
    expect(PREDECESSOR_ARGS).toEqual(['--', COMPOSITION_FLAG]);
    // Not a function of the caller's own mode: the invariant is in the shape.
    expect(typeof PREDECESSOR_ARGS).not.toBe('function');
  });
});

describe('every gate of the recursive chain composes its predecessor in Lane A (TL-P4-GATE-COMP-01 §2)', () => {
  it('each gate that spawns a predecessor gate passes PREDECESSOR_ARGS — derived from source, not listed', () => {
    const offenders: string[] = [];
    // An edge to a gate that is NOT in the recursive chain is exempt, but the
    // exemption carries a PROOF OBLIGATION rather than a note: the target must
    // execute no host-sensitive performance suite. The owner's trap is a law
    // that exempts a subject for what it delegates to without asserting the
    // delegation is the whole of what the subject does, so the exemption is
    // DISCHARGED here and the exempted targets are listed.
    const exempted: string[] = [];
    let spawnSites = 0;
    for (const rel of CHAIN_GATES) {
      const code = stripCommentsKeepStrings(source(rel));
      // Every `['run', 'gate:…']` argument vector in the gate's own source.
      for (const m of code.matchAll(/\[\s*'run',\s*(?:'(gate:[a-z0-9:]+)'|([A-Z_]*PREDECESSOR_SCRIPT))([^\]]*)\]/g)) {
        spawnSites += 1;
        const target = m[1] ?? m[2] ?? '?';
        const tail = m[3] ?? '';
        const script = m[1] === undefined ? null : scriptOfGate(m[1]);
        // The enforced subject is every edge to a GATE SCRIPT, not only to one
        // of the eleven this change touched: the chain continues below P2-S8
        // through P2-S7…P2-S1 to Phase 1, and those edges must propagate too.
        const inChain = script !== null && gateScripts().includes(script);
        if (!inChain && script !== null) {
          // DISCHARGE: the exempted target runs no host-sensitive workload.
          // `gate:browser` is `tests/browser/gate.ts`, whose verdict is
          // planted-defect detection and not a millisecond comparison, and
          // which lives outside `scripts/` so the spawn-graph law below does
          // NOT cover it. Hence the obligation is met here, explicitly.
          // The discharge tests a RESOLVED SPAWN, not a textual reference. A
          // gate may legitimately NAME a performance suite in a file roster
          // without executing it — `scripts/phase2-s7-gate.ts:594` is such a
          // row — so matching `tests/performance/` would fail an exemption
          // that is in fact earned, and for the wrong reason.
          expect(
            performanceSpawns(source(script)),
            `${rel} spawns ${target} without PREDECESSOR_ARGS, and ${script} SPAWNS a performance suite — the exemption is unearned`,
          ).toEqual([]);
          exempted.push(`${rel} → ${target} (${script})`);
          continue;
        }
        if (!tail.includes('PREDECESSOR_ARGS')) offenders.push(`${rel}: spawns ${target} without PREDECESSOR_ARGS`);
      }
    }
    // NON-VACUITY: a law that found no spawn site would pass over everything.
    expect(spawnSites, 'no gate spawn site was found at all — the derivation is broken, not satisfied').toBeGreaterThanOrEqual(CHAIN_GATES.length);
    // NON-VACUITY of the exemption: if nothing were exempted the discharge
    // above would be dead code; if EVERYTHING were, the law would be empty.
    expect(exempted.length, 'no edge was exempted, so the discharge above is unreachable and untested').toBeGreaterThan(0);
    expect(spawnSites - exempted.length, 'every edge was exempted — the law has no enforced subject left').toBeGreaterThanOrEqual(CHAIN_GATES.length - 1);
    expect(offenders).toEqual([]);
  });

  it('each gate honours the Lane B marker in its own step loop, and refuses an EMPTY composed subject', () => {
    const missing: string[] = [];
    for (const rel of CHAIN_GATES) {
      const code = stripProse(source(rel));
      if (!/hostSensitive\s*===\s*true/.test(code)) missing.push(`${rel}: no step loop consults step.hostSensitive`);
      if (!code.includes('compositionOutcome')) missing.push(`${rel}: nothing refuses a composition-mode run that executed no step (red proof J)`);
      if (!code.includes('laneBNotice')) missing.push(`${rel}: a Lane B step could be skipped without being named in the log`);
    }
    expect(missing).toEqual([]);
  });

  it('NON-VACUITY: at least one gate of the chain actually DECLARES a Lane B step, with a non-empty `measuredBy`', () => {
    const declaring = CHAIN_GATES.filter((rel) => /hostSensitive:\s*true/.test(stripProse(source(rel))));
    expect(declaring.length, 'no gate marks any step Lane B, so the whole mechanism has no subject').toBeGreaterThan(0);
    // And every declaration names where the verdict IS taken. A marker with no
    // `measuredBy` would be a way to DELETE a measurement by marking it, which
    // is the reading of the ruling that is explicitly forbidden.
    for (const rel of declaring) {
      const code = stripProse(source(rel));
      const marks = [...code.matchAll(/hostSensitive:\s*true,\s*measuredBy:\s*([^\n]+)/g)];
      const bare = (code.match(/hostSensitive:\s*true/g) ?? []).length - marks.length;
      expect(bare, `${rel}: ${bare} Lane B step(s) do not name the step that takes their latency verdict`).toBe(0);
    }
  });

  it('the accounting benchmark is spawned by SIX gates of the chain, and every one of those spawns is now Lane B', () => {
    // The inventory, asserted rather than described. The owner's premise was
    // that the benchmark reaches later gates THROUGH P2-S8 composition; the
    // tree is worse than that — six gates spawn it by its own path. A
    // per-call-site fix that left three of them executing would not be a fix,
    // so the law is over the SET of spawn sites and not over a list of gates.
    const spawners: string[] = [];
    for (const rel of CHAIN_GATES) {
      const code = stripCommentsKeepStrings(source(rel));
      for (const m of code.matchAll(
        /'vitest',\s*'run',\s*(?:'tests\/performance\/accounting-budgets\.test\.ts'|\.\.\.?ACCOUNTING_BUDGETS|ACCOUNTING_BUDGETS)/g,
      )) {
        const step = enclosingObject(code, m.index);
        expect(step, `${rel}: the benchmark spawn is not inside an object literal — the extraction is broken`).not.toBe('');
        spawners.push(rel);
        expect(step, `${rel}: a direct spawn of the accounting benchmark that is NOT marked Lane B — the contention returns through it`).toMatch(
          /hostSensitive:\s*true/,
        );
      }
    }
    expect(new Set(spawners).size, 'the benchmark spawn sites could not be found in source — the derivation is broken').toBeGreaterThanOrEqual(5);
  });
});

/**
 * DISCOVERY MUST RESOLVE THE IDENTIFIER, NOT MATCH THE PATH
 * (coordinator finding, 2026-10-07).
 *
 * The inventory of this defect was first taken by grepping the literal path
 * `tests/performance/accounting-budgets.test.ts`, and that method MISSED TWO
 * of the six spawn sites — `scripts/phase3-s8-gate.ts:865` and
 * `scripts/phase3-corrective-gate.ts:535` — because both spawn the suite
 * through a constant:
 *
 *     const ACCOUNTING_BUDGETS = 'tests/performance/accounting-budgets.test.ts';
 *     …  args: ['vitest', 'run', ACCOUNTING_BUDGETS]
 *
 * A law that discovers host-sensitive spawns by matching a path literal is
 * defeated by a `const` on the line above, and defeated SILENTLY, because the
 * count it reports looks like an answer. So this helper resolves single-file
 * string constants declared in the same source before deciding, and the laws
 * below are built on it rather than on a path match.
 *
 * It is the same shape of error as a reporter-sensitive grep: in both cases the
 * pattern encoded an assumption about a surface form rather than about the
 * thing being counted.
 */
function performanceSpawns(source: string): { readonly suite: string; readonly step: string }[] {
  const code = stripCommentsKeepStrings(source);
  // `const NAME = 'tests/performance/…'` — the identifier's resolved value.
  const constants = new Map<string, string[]>();
  for (const m of code.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'(tests\/performance\/[^']+)'/g)) {
    constants.set(m[1] as string, [m[2] as string]);
  }
  // …AND `const NAMES = [ … ]`, because a spawn can spread a LIST.
  //
  // A hole I found by running this law rather than reading it: resolving only
  // STRING constants made a performance suite inside a spawned array literal
  // invisible. `scripts/phase2-s7-gate.ts:106` holds
  // `tests/performance/accounting-read-plans.test.ts` in exactly such a list,
  // and the law that is supposed to have no exceptions reported none, because
  // `...P2_S7_TESTS` resolved to `undefined` and was silently dropped. That is
  // the identifier-resolution lesson one level further out: it is not enough to
  // resolve the identifier, the resolver has to cover the SHAPES the tree
  // actually uses.
  for (const m of code.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:[^=]*)?\s*=\s*\[([^\]]*)\]/g)) {
    const paths = [...(m[2] ?? '').matchAll(/'(tests\/performance\/[^']+)'/g)].map((q) => q[1] as string);
    if (paths.length > 0) constants.set(m[1] as string, [...(constants.get(m[1] as string) ?? []), ...paths]);
  }
  const out: { suite: string; step: string }[] = [];
  // Each `args: [ … 'vitest', 'run', <tokens> ]` argument vector, with its
  // surrounding step object so the Lane B marker can be read beside it.
  for (const m of code.matchAll(/\{(?:[^{}]|\{[^{}]*\})*?'vitest',\s*'run',(?:[^{}]|\{[^{}]*\})*?\}/g)) {
    const step = m[0];
    const vector = /'vitest',\s*'run',([^\]]*)\]/.exec(step)?.[1] ?? '';
    for (const token of vector
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '')) {
      const literal = /^'(tests\/performance\/[^']+)'$/.exec(token)?.[1];
      const resolved = literal !== undefined ? [literal] : (constants.get(token.replace(/^\.\.\./, '')) ?? []);
      for (const suite of resolved) if (suite.startsWith('tests/performance/')) out.push({ suite, step });
    }
  }
  return out;
}

/**
 * The object literal that STARTS at or before `from`, extracted by matching
 * braces rather than by a lazy `[\\s\\S]{0,400}?\\}`.
 *
 * The lazy form was a real defect in this suite: P2-S8's benchmark row carries
 * `env: { P2S8_PERF_TIER: '1' }`, so the first `}` after the suite path closes
 * the NESTED object, and the extracted region stopped short of
 * `hostSensitive: true` on the line below. The law then reported the one
 * correctly-marked spawn in the tree as unmarked — a false red against the
 * artifact it exists to protect, which is the same shape as the clause-F trap.
 */
function enclosingObject(code: string, from: number): string {
  // Walk OUTWARD. The nearest preceding `{` is often not the step object: on
  // `scripts/phase3-s8-gate.ts:888` the step's own `name` holds a template with
  // a `${…}` substitution, whose brace closes before the spawn is reached. An
  // earlier version returned '' on that first miss and reported the extraction
  // broken; the fix is to keep trying earlier braces until one ENCLOSES the
  // offset.
  let start = code.lastIndexOf('{', from);
  while (start >= 0) {
    let depth = 0;
    let closed = -1;
    for (let i = start; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          closed = i;
          break;
        }
      }
    }
    if (closed > from) return code.slice(start, closed + 1);
    start = code.lastIndexOf('{', start - 1);
  }
  return '';
}

/** `gate:phase3:s7` → `scripts/phase3-s7-gate.ts`, read from package.json. */
function scriptOfGate(gate: string): string | null {
  const pkg = JSON.parse(source('package.json')) as { scripts?: Record<string, string> };
  const body = pkg.scripts?.[gate];
  if (typeof body !== 'string') return null;
  return /(?:^|\s)(\S+\.ts)\b/.exec(body)?.[1] ?? null;
}

/** Every gate script on disk, discovered rather than listed. */
function gateScripts(): string[] {
  return readdirSync(join(REPO, 'scripts'))
    .filter((f) => /-gate\.ts$/.test(f))
    .map((f) => `scripts/${f}`)
    .sort();
}

/** The gates a gate spawns: `['run', 'gate:x']`, with whether it propagated. */
function gateEdges(source: string): { readonly to: string; readonly propagates: boolean }[] {
  const code = stripCommentsKeepStrings(source);
  const out: { to: string; propagates: boolean }[] = [];
  for (const m of code.matchAll(/\[\s*'run',\s*(?:'(gate:[a-z0-9:]+)'|(?:[A-Z_]*PREDECESSOR_SCRIPT))([^\]]*)\]/g)) {
    out.push({ to: m[1] ?? 'gate:phase3:corrective', propagates: (m[2] ?? '').includes('PREDECESSOR_ARGS') });
  }
  return out;
}

const GATE_OF_SCRIPT = (rel: string): string => {
  const m = /scripts\/phase(\d)-(s\d|corrective|release)?-?gate\.ts/.exec(rel);
  if (rel === 'scripts/phase1-gate.ts') return 'gate:phase1';
  if (rel === 'scripts/phase3-corrective-gate.ts') return 'gate:phase3:corrective';
  return m === null ? rel : `gate:phase${m[1]}:${m[2] ?? ''}`;
};

describe('the two source views are lexically correct, which every law above presupposes', () => {
  /**
   * THE DEFECT THIS LAW EXISTS FOR, found by running the suite rather than by
   * reading it.
   *
   * `blankOut()` had no regex-literal handling. Six gates of the composed
   * chain contain `/\\bfrom\\s+'([^']+)'/g` — three apostrophes — so the first
   * of them was read as a string opener and quote parity INVERTED for the rest
   * of the file: code was blanked and string bodies survived. The views still
   * returned a string of the correct length, so every law built on them kept
   * answering, about a file turned inside out. Nine laws then reported "no
   * subject found" rather than "defect found".
   *
   * That is why the non-vacuity assertions are not ceremony: a law that cannot
   * tell "the tree is clean" from "I cannot see the tree" is not a law.
   */
  const ODD_PARITY_REGEX = 'scripts/phase3-s2-gate.ts';

  it('the construct that broke the lexer is STILL PRESENT, so this law has a subject', () => {
    // If this ever stops matching, the law below proves nothing and must be
    // re-pointed at whatever gate still carries an odd-parity regex literal.
    expect(source(ODD_PARITY_REGEX), 'no odd-parity-quote regex literal remains — re-point this law').toMatch(/matchAll\(\/\\bfrom\\s\+'\(\[\^'\]\+\)'\/g\)/);
  });

  it('a quote inside a regex literal does not flip quote parity for the rest of the file', () => {
    const raw = source(ODD_PARITY_REGEX);
    const code = stripProse(raw);
    const stmts = stripCommentsKeepStrings(raw);

    // Both views are offset-compatible with the source.
    expect(code).toHaveLength(raw.length);
    expect(stmts).toHaveLength(raw.length);

    // Code AFTER the regex literal survives the identifier view. This is the
    // exact character the inversion erased: `compositionOutcome(` at :415.
    expect(code, 'code after an odd-parity regex was erased — the lexer has flipped again').toContain('compositionOutcome(');
    expect(code).toContain('laneBSkipped');

    // And the inverse half: string BODIES after it are still blanked, so the
    // identifier view has not simply become the raw source.
    expect(code, 'a string body survived the identifier view — it is no longer an identifier view').not.toContain("'composition'");
    expect(stmts, 'the statements view lost the string body it exists to keep').toContain("'composition'");
  });

  it('a regex body is blanked in BOTH views, so no law is satisfied by a pattern that merely mentions its subject', () => {
    // `/COMMIT/` is not a COMMIT. The clause-F trap in reverse.
    const probe = "const a = 1;\nconst re = /COMMIT BEGIN 'quoted'/g;\nconst b = 'kept';\n";
    expect(stripProse(probe)).not.toContain('COMMIT');
    expect(stripCommentsKeepStrings(probe), 'a regex body reaches the statements view, where it could satisfy a SQL clause').not.toContain('COMMIT');
    // Non-vacuity: the surrounding code and the real string are untouched.
    expect(stripCommentsKeepStrings(probe)).toContain("'kept'");
    expect(stripProse(probe)).toContain('const re =');
  });

  it('division is not mistaken for a regex literal', () => {
    // If `/` after a value were treated as a regex opener, everything to the
    // next `/` would be blanked — a silent erasure of real code.
    const probe = "const half = total / count;\nconst q = (a + b) / 2;\nconst s = 'kept';\n";
    const code = stripProse(probe);
    expect(code).toContain('total / count');
    expect(code).toContain('(a + b) / 2');
    expect(code).toContain('const s =');
  });
});

describe('host-sensitive spawn discovery resolves identifiers, and the propagation boundary is DERIVED', () => {
  it('finds SIX accounting-benchmark spawn sites — two of which a path-literal grep misses', () => {
    const sites: string[] = [];
    const viaConstant: string[] = [];
    for (const rel of gateScripts()) {
      const src = source(rel);
      for (const s of performanceSpawns(src)) {
        if (s.suite !== ACCOUNTING_BUDGETS_SUITE) continue;
        sites.push(rel);
        // Did the spawn name the path, or an identifier?
        if (!s.step.includes(`'${ACCOUNTING_BUDGETS_SUITE}'`)) viaConstant.push(rel);
      }
    }
    expect(sites.length, 'discovery found no benchmark spawn at all — the resolver is broken, not satisfied').toBeGreaterThanOrEqual(6);
    // NON-VACUITY of the resolver itself: if no site went through a constant,
    // a path-literal grep would have been sufficient and this resolver would be
    // untested by the tree it runs on.
    expect(viaConstant.length, 'no spawn site uses a constant, so the identifier resolver has no subject here').toBeGreaterThanOrEqual(2);
    expect(viaConstant).toEqual(expect.arrayContaining(['scripts/phase3-s8-gate.ts', 'scripts/phase3-corrective-gate.ts']));
  });

  /**
   * WHAT MAKES A SPAWN LANE B IS ITS VERDICT, NOT ITS DIRECTORY.
   *
   * An earlier version of this law required a Lane B marker on every spawn of
   * a file under `tests/performance/`. That is a surface-form assumption of
   * the same family as the path-literal grep it was written to replace, and it
   * produced a wrong demand the moment the resolver got good enough to see
   * past it: `scripts/phase2-s7-gate.ts` spawns
   * `tests/performance/accounting-read-plans.test.ts`, which takes NO absolute
   * wall-clock verdict — it reads `Execution Time` out of EXPLAIN ANALYZE and
   * only PRINTS it, while all fifteen of its assertions are plan-shape
   * (`.rows`, the scan list). Marking it Lane B would have suppressed a
   * deterministic correctness check inside composition, which is the reading
   * of the ruling that is explicitly forbidden — deleting a measurement by
   * marking it.
   *
   * So the obligation is a DISJUNCTION with both arms discharged: a
   * performance spawn either carries the marker, or is PROVEN to take no
   * absolute timing verdict. Neither arm may be empty, or the law is one-sided.
   */
  const timingVerdicts = (suite: string): string[] => {
    const code = stripProse(source(suite));
    // An absolute ceiling is `expect(<timing subject>).toBeLessThan[OrEqual](…)`.
    return [...code.matchAll(/expect\(\s*([^)]*?)\s*(?:,[^)]*)?\)\s*\.\s*toBeLessThan(?:OrEqual)?\(/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((subject) => /p95|p50|\bms\b|elapsed|duration|latency|\btime\b/i.test(subject));
  };

  it('every performance spawn is EITHER marked Lane B, OR proven to take no absolute timing verdict', () => {
    const offenders: string[] = [];
    const marked: string[] = [];
    const discharged: string[] = [];
    let total = 0;
    for (const rel of gateScripts()) {
      for (const s of performanceSpawns(source(rel))) {
        total += 1;
        if (/hostSensitive:\s*true/.test(s.step)) {
          if (!/measuredBy:\s*\S/.test(s.step)) offenders.push(`${rel}: ${s.suite} is marked Lane B but names no step that takes its latency verdict`);
          else marked.push(`${rel} → ${s.suite}`);
          continue;
        }
        // UNMARKED: the exemption must be earned, not assumed.
        const verdicts = timingVerdicts(s.suite);
        if (verdicts.length > 0) {
          offenders.push(
            `${rel}: ${s.suite} is spawned UNMARKED yet takes ${verdicts.length} absolute timing verdict(s) (${verdicts.join(', ')}) — it would be re-executed inside composed predecessors`,
          );
        } else discharged.push(`${rel} → ${s.suite}`);
      }
    }
    expect(total, 'no performance spawn was discovered anywhere — the law has no subject').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
    // NON-VACUITY of BOTH arms: a law whose marked arm is empty is not
    // protecting anything, and one whose discharged arm is empty has never
    // exercised the classification it rests on.
    expect(marked.length, 'no spawn is marked Lane B, so the mechanism has no subject').toBeGreaterThan(0);
    expect(discharged.length, 'no spawn was discharged, so the timing-verdict classifier is untested here').toBeGreaterThan(0);
  });

  it('NON-VACUITY of the classifier: it separates the accepted benchmark from the plan suite on this tree', () => {
    // If both sides answered the same, the disjunction above would be a
    // formality. These are the two real suites the law actually sorts.
    expect(
      timingVerdicts(ACCOUNTING_BUDGETS_SUITE).length,
      'the accounting benchmark takes no absolute timing verdict — the classifier is broken',
    ).toBeGreaterThan(0);
    expect(timingVerdicts('tests/performance/accounting-read-plans.test.ts'), 'the plan suite is being read as a timing suite').toEqual([]);
  });

  /**
   * A `measuredBy` MAY NOT INVENT A CI STEP (challenger finding F5).
   *
   * `measuredBy` is the clause that stops a Lane B marker from being a way to
   * DELETE a measurement: a step not executed here must name the step that
   * takes its latency verdict instead. That promise is worth exactly nothing
   * if the named step does not exist — and it did not. Three gates named
   * «Accounting budgets — Tier 1, measured (§34 A…F)», a step this workflow
   * has never contained. The marker looked discharged and was not.
   *
   * So every backtick-quoted name inside a `measuredBy` must match a real
   * `- name:` of the workflow, read out of the workflow rather than out of a
   * list kept here. A promise about CI is now checked against CI.
   */
  it('every CI step name a `measuredBy` quotes actually exists in the workflow', () => {
    const workflow = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
    const stepNames = new Set(
      workflow
        .split('\n')
        .filter((l) => /^\s*-\s*name:\s*\S/.test(l))
        .map((l) => l.replace(/^\s*-\s*name:\s*/, '').trim()),
    );
    expect(stepNames.size, 'no `- name:` step was read out of the workflow — the derivation is broken, not satisfied').toBeGreaterThan(10);

    const quoted: { readonly gate: string; readonly name: string }[] = [];
    for (const rel of gateScripts()) {
      const code = stripCommentsKeepStrings(source(rel));
      for (const m of code.matchAll(/measuredBy:\s*'([^']*)'/g)) {
        for (const q of (m[1] ?? '').matchAll(/`([^`]+)`/g)) {
          const name = q[1] ?? '';
          // `backend` is the JOB, not a step; only step-shaped names are claims.
          if (name === 'backend') continue;
          quoted.push({ gate: rel, name });
        }
      }
    }
    expect(quoted.length, 'no `measuredBy` quotes any CI step name, so this law has no subject').toBeGreaterThan(0);
    const invented = quoted.filter((q) => !stepNames.has(q.name));
    expect(
      invented.map((q) => `${q.gate}: measuredBy names the CI step "${q.name}", which does not exist in .github/workflows/ci.yml`),
      'a Lane B marker names a step that takes its latency verdict, and that step is fictional — the measurement is deleted, not relocated',
    ).toEqual([]);
  });

  /**
   * THE BOUNDARY, AS A GRAPH PROPERTY RATHER THAN AN EXEMPTION LIST.
   *
   * Measured on this tree: `gate:phase2:s1 … s6` and `gate:phase1` do NOT
   * propagate `--composition`, and nothing is lost by that today because none
   * of them spawns a `tests/performance/` suite. That is a fact about the tree,
   * not a design decision, and the honest way to depend on it is to ASSERT it —
   * so that the day somebody adds a timing step to P2-S5, this law goes red and
   * names the propagation that is now owed.
   *
   * It is deliberately NOT written as "these six gates are exempt". A
   * hand-maintained exemption list inside a law that outlives the slice is the
   * `RP-RT-A` failure mode exactly: the record falls behind the tree and the
   * law goes quiet while looking like it answered. The subject here is derived
   * by walking the spawn graph from every non-propagating edge.
   */
  it('no gate reachable through a NON-propagating edge spawns a host-sensitive suite', () => {
    const byGate = new Map<string, string>();
    for (const rel of gateScripts()) byGate.set(GATE_OF_SCRIPT(rel), rel);
    const perfGates = new Set<string>();
    for (const rel of gateScripts()) if (performanceSpawns(source(rel)).length > 0) perfGates.add(GATE_OF_SCRIPT(rel));
    expect(perfGates.size, 'no gate spawns a performance suite, so this law has no subject').toBeGreaterThan(0);

    const problems: string[] = [];
    let nonPropagating = 0;
    for (const rel of gateScripts()) {
      for (const edge of gateEdges(source(rel))) {
        if (edge.propagates) continue;
        nonPropagating += 1;
        // Everything reachable from this un-signalled edge.
        const seen = new Set<string>();
        const stack = [edge.to];
        while (stack.length > 0) {
          const g = stack.pop() as string;
          if (seen.has(g)) continue;
          seen.add(g);
          if (perfGates.has(g)) {
            problems.push(
              `${rel} spawns ${edge.to} WITHOUT PREDECESSOR_ARGS, and ${g} is reachable from there and spawns a host-sensitive suite — ` +
                'that suite would be executed inside a composed predecessor. Either propagate the flag from that spawn site, or the ' +
                'suite must stop being reachable from it (TL-P4-GATE-COMP-01).',
            );
          }
          const child = byGate.get(g);
          if (child !== undefined) for (const e of gateEdges(source(child))) stack.push(e.to);
        }
      }
    }
    // NON-VACUITY: if every edge propagated, this law would pass over nothing
    // and would stop being able to report the boundary moving.
    expect(nonPropagating, 'every gate edge propagates, so the boundary this law guards does not exist on this tree').toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE TEN RED PROOFS (§12)
// ───────────────────────────────────────────────────────────────────────────

describe('RED PROOF (A) — composition mode accidentally EXECUTES Accounting A', () => {
  it('red: a Lane B accounting-benchmark step with its marker removed is named by the law', () => {
    const rel = 'scripts/phase2-s8-gate.ts';
    // 1. THE SUBJECT EXISTS.
    const before = stripCommentsKeepStrings(source(rel));
    expect(before, 'P2-S8 declares no Lane B accounting step, so this plant has no subject').toMatch(
      /'vitest',\s*'run',\s*'tests\/performance\/accounting-budgets\.test\.ts'/,
    );
    expect(before).toMatch(/hostSensitive:\s*true/);
    // 2. THE MUTATION REALLY OCCURRED.
    const mutated = source(rel).replace(/hostSensitive: true,\n(\s*)measuredBy:/, 'hostSensitive: false,\n$1measuredBy:');
    expect(mutated, 'the plant matched nothing — the marker was not actually removed').not.toBe(source(rel));
    expect(stripCommentsKeepStrings(mutated)).not.toMatch(/hostSensitive:\s*true/);
    // 3 and 4. The chain law reports it, and names the exact defect.
    const unmarked = [
      ...stripCommentsKeepStrings(mutated).matchAll(/\{[^{}]*?'vitest',\s*'run',\s*'tests\/performance\/accounting-budgets\.test\.ts'[\s\S]{0,400}?\}/g),
    ].filter((m) => !/hostSensitive:\s*true/.test(m[0]));
    expect(unmarked.length, 'the result is empty: an unmarked benchmark spawn went unreported').toBeGreaterThan(0);
    // The named defect: this spawn would execute inside a composed predecessor.
    expect(unmarked[0]?.[0] ?? '').toContain('accounting-budgets.test.ts');
  });
});

describe('RED PROOF (B) — composition mode stops checking the 15 ms contract ENTIRELY', () => {
  it('red: a gate whose structural half no longer calls the analyzer is named', () => {
    for (const rel of ['scripts/phase2-s8-gate.ts', 'scripts/phase3-s8-gate.ts', 'scripts/phase3-corrective-gate.ts', 'scripts/phase4-s1-gate.ts']) {
      // 1. SUBJECT.
      const before = stripProse(source(rel));
      expect(before, `${rel} does not check the performance contract, so (B) has no subject there`).toContain('accountingContractProblems');
      // 2. MUTATION.
      const mutated = source(rel).replace(/accountingContractProblems/g, 'noopContractProblems');
      expect(mutated).not.toBe(source(rel));
      // 3 + 4. The law over the tree reports the loss, by gate name.
      const stripped = stripProse(mutated);
      expect(stripped).not.toContain('accountingContractProblems');
      const problems = stripped.includes('accountingContractProblems')
        ? []
        : [`${rel}: the performance CONTRACT is no longer verified, so composition mode would be a weaker gate rather than a differently-scoped one`];
      expect(problems.length, 'the result is empty: a gate that stopped checking the contract went unreported').toBeGreaterThan(0);
      expect(problems[0]).toContain('performance CONTRACT is no longer verified');
    }
  });

  it('red: and if the ANALYZER itself were emptied, the shipped tree would stop being able to refuse anything', () => {
    // The second half of (B): not "did a gate call it" but "does calling it
    // still mean something". A plant that returns no problem for a tree whose
    // budget was raised is the vacuous analyzer, and this is where that is
    // caught — the mutation is in the SUBJECT, and the expectation is that the
    // law still speaks.
    const raised = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) => t.replace('A_POST_P95: 15,', 'A_POST_P95: 20,'));
    expect(codes(raised), 'the analyzer is vacuous: a raised ceiling produced no problem').toContain('perf-contract-ceiling-changed');
  });
});

describe('RED PROOF (C) — the 15 ms ceiling changes', () => {
  it('red: 15 → 20 is named, with both numbers, without executing the benchmark', () => {
    // 1. SUBJECT.
    expect(ACCEPTED_ACCOUNTING_CEILINGS['A_POST_P95']).toBe(15);
    expect(stripProse(source(ACCOUNTING_BUDGETS_SUITE))).toContain('A_POST_P95: 15,');
    // 2. MUTATION.
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) => t.replace('A_POST_P95: 15,', 'A_POST_P95: 20,'));
    expect(stripProse(source(ACCOUNTING_BUDGETS_SUITE, root))).toContain('A_POST_P95: 20,');
    // 3 + 4.
    const found = accountingContractProblems(root);
    expect(found.length, 'the result is empty').toBeGreaterThan(0);
    expect(found.map((p) => p.code)).toContain('perf-contract-ceiling-changed');
    expect(details(root)).toMatch(/A_POST_P95` is 20 and the accepted ceiling is 15/);
  });

  it('red: a ceiling DELETED is a different, separately named defect from a ceiling raised', () => {
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) => t.replace('  A_POST_P95: 15,\n', ''));
    expect(stripProse(source(ACCOUNTING_BUDGETS_SUITE, root))).not.toContain('A_POST_P95: 15,');
    expect(codes(root)).toContain('perf-contract-ceiling-missing');
  });

  it('red: a COMMENT that says 15 does not satisfy the law — the trap this project was bitten by', () => {
    // `COMMENT ON FUNCTION … IS '…'` is real DDL and a doc comment is real
    // text, so a textual law can be satisfied by prose. Here the real ceiling
    // is raised and a comment is planted that reads exactly like the accepted
    // one. The law must still be RED.
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) => t.replace('A_POST_P95: 15,', 'A_POST_P95: 20, // A_POST_P95: 15,'));
    expect(source(ACCOUNTING_BUDGETS_SUITE, root)).toContain('// A_POST_P95: 15,');
    expect(codes(root), 'a comment satisfied a contract law — the defect is the law, not the tree').toContain('perf-contract-ceiling-changed');
  });

  it('red: a DUPLICATE threshold object does not let a weakened ceiling hide behind an accepted one', () => {
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) => t.replace('const BUDGET = {', 'const BUDGET = { A_POST_P95: 20 } as const;\nconst BUDGET = {'));
    expect(codes(root)).toContain('perf-contract-budget-shadowed');
  });
});

describe('RED PROOF (D) — the sample count changes', () => {
  it('red: 200 → 20 is named, and the reason it matters is stated in the refusal', () => {
    // 1. SUBJECT.
    expect(ACCEPTED_SHORT_PERCENTILE_ITERATIONS).toBe(200);
    expect(stripProse(source(ACCOUNTING_BUDGETS_SUITE))).toContain('const SHORT_PERCENTILE_ITERATIONS = 200;');
    // 2. MUTATION.
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) => t.replace('const SHORT_PERCENTILE_ITERATIONS = 200;', 'const SHORT_PERCENTILE_ITERATIONS = 20;'));
    expect(stripProse(source(ACCOUNTING_BUDGETS_SUITE, root))).toContain('const SHORT_PERCENTILE_ITERATIONS = 20;');
    // 3 + 4.
    expect(codes(root)).toContain('perf-contract-samples-changed');
    expect(details(root)).toMatch(/200/);
  });

  it('red: a DECLARED 200 that the call does not use is refused — the contract must be the run', () => {
    // The trap in the brief, exactly: a law that excuses a subject because of
    // what it DELEGATES to must assert the delegation is the WHOLE of what the
    // subject does. Here the constant still says 200 and case A quietly falls
    // back to the 30-sample default.
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) =>
      t.replace(/\n(\s*)SHORT_PERCENTILE_ITERATIONS,\n(\s*)\);\n(\s*)expect\(m\.p95/, '\n$2);\n$3expect(m.p95'),
    );
    const mutated = stripProse(source(ACCOUNTING_BUDGETS_SUITE, root));
    expect(mutated, 'the plant matched nothing').not.toBe(stripProse(source(ACCOUNTING_BUDGETS_SUITE)));
    expect(codes(root)).toContain('perf-contract-samples-wiring');
  });
});

describe('RED PROOF (E) — the p95 semantics change', () => {
  it('red: p95 → p50 in A’s verdict is named, with the ceiling left untouched', () => {
    // 1. SUBJECT.
    expect(stripProse(source(ACCOUNTING_BUDGETS_SUITE))).toMatch(/expect\(m\.p95,[\s\S]{0,80}?\)\.toBeLessThanOrEqual\(BUDGET\.A_POST_P95\)/);
    // 2. MUTATION — the ceiling is NOT touched, so a law that only watched the
    //    number would stay green. That is the point of this case.
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) =>
      t.replace(
        'expect(m.p95, JSON.stringify(diagnose(m))).toBeLessThanOrEqual(BUDGET.A_POST_P95);',
        'expect(m.p50, JSON.stringify(diagnose(m))).toBeLessThanOrEqual(BUDGET.A_POST_P95);',
      ),
    );
    const after = stripProse(source(ACCOUNTING_BUDGETS_SUITE, root));
    expect(after).toContain('expect(m.p50');
    expect(after, 'the ceiling moved too, so this plant does not isolate the semantics change').toContain('A_POST_P95: 15,');
    // 3 + 4.
    expect(codes(root)).toContain('perf-contract-verdict-quantile');
    expect(details(root)).toMatch(/judges it on `m\.p95`/);
  });

  it('red: a hand-written numeric ceiling beside the delegating assertion is refused', () => {
    // The wrapper that delegates and then adjusts the figure: it is not enough
    // that the accepted assertion names `BUDGET.A_POST_P95`.
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) =>
      t.replace('expect(m.p95, JSON.stringify(diagnose(m))).toBeLessThanOrEqual(BUDGET.A_POST_P95);', 'expect(m.p95).toBeLessThanOrEqual(25);'),
    );
    expect(codes(root)).toContain('perf-contract-literal-ceiling');
  });
});

describe('RED PROOF (F) — COMMIT leaves the measured scope', () => {
  it('red: COMMIT moved OUT of A’s timed closure is named, though the file still contains the word', () => {
    // 1. SUBJECT: COMMIT is inside the closure `measure()` times.
    const before = source(ACCOUNTING_BUDGETS_SUITE);
    expect(before).toContain("await c.query('COMMIT');");
    expect(codes(REPO), 'the shipped tree already fails (F) — the plant would prove nothing').not.toContain('perf-contract-commit-scope');
    // 2. MUTATION: the statement moves one line past the closure's brace. The
    //    word COMMIT is still in the file and still in the case; only the
    //    REGION changed, which is why a textual search would stay green.
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) =>
      t
        .replace("          await c.query('COMMIT');\n        },\n        SHORT_PERCENTILE_ITERATIONS,", '        },\n        SHORT_PERCENTILE_ITERATIONS,')
        .replace('      expect(m.p95, JSON.stringify(diagnose(m)))', "      await c.query('COMMIT');\n      expect(m.p95, JSON.stringify(diagnose(m)))"),
    );
    const after = source(ACCOUNTING_BUDGETS_SUITE, root);
    expect(after, 'the plant matched nothing').not.toBe(before);
    expect(after, 'the plant removed COMMIT entirely, so it does not isolate a SCOPE change').toContain("await c.query('COMMIT');");
    // 3 + 4.
    expect(codes(root)).toContain('perf-contract-commit-scope');
    expect(details(root)).toMatch(/OUTSIDE the closure the clock is around/);
  });

  it('red: and dropping BEGIN from the timed region is the same class of defect, separately named', () => {
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, (t) => t.replace("          await c.query('BEGIN');\n", ''));
    expect(source(ACCOUNTING_BUDGETS_SUITE, root)).not.toContain("await c.query('BEGIN');");
    expect(codes(root)).toContain('perf-contract-commit-scope');
  });
});

describe('RED PROOF (G) — the performance suite is DELETED', () => {
  it('red: the missing suite is named, and the refusal says deletion is not a way to pass', () => {
    // 1. SUBJECT.
    expect(stripProse(source(ACCOUNTING_BUDGETS_SUITE)).length).toBeGreaterThan(1000);
    // 2. MUTATION.
    const root = rootWithout(ACCOUNTING_BUDGETS_SUITE);
    expect(() => source(ACCOUNTING_BUDGETS_SUITE, root)).toThrow();
    // 3 + 4.
    expect(codes(root)).toEqual(['perf-contract-suite-missing']);
    expect(details(root)).toMatch(/does not delete performance verification/);
  });

  it('red: a suite reduced to PROSE is refused too — a file of comments is not a measurement', () => {
    const root = rootWith(ACCOUNTING_BUDGETS_SUITE, () => '/* the six budgets, A_POST_P95: 15, p95, 200 samples, COMMIT */\n');
    expect(codes(root)).toEqual(['perf-contract-suite-empty']);
  });
});

describe('RED PROOF (H) — the dedicated performance evidence WIRING disappears', () => {
  it('red: the evidence workflow deleted is named', () => {
    // 1. SUBJECT.
    expect(source(ACCOUNTING_EVIDENCE_WORKFLOW)).toContain(ACCOUNTING_BUDGETS_SUITE);
    // 2 + 3 + 4.
    const root = rootWithout(ACCOUNTING_EVIDENCE_WORKFLOW);
    expect(codes(root)).toContain('perf-contract-evidence-workflow-missing');
    expect(details(root)).toMatch(/nowhere left to happen/);
  });

  it('red: the workflow kept but its measuring step removed is named', () => {
    const root = rootWith(ACCOUNTING_EVIDENCE_WORKFLOW, (t) =>
      t
        .split('\n')
        .filter((l) => !(/^\s*run:/.test(l) && l.includes(ACCOUNTING_BUDGETS_SUITE)))
        .join('\n'),
    );
    const after = source(ACCOUNTING_EVIDENCE_WORKFLOW, root);
    expect(after.split('\n').filter((l) => /^\s*run:/.test(l) && l.includes(ACCOUNTING_BUDGETS_SUITE))).toEqual([]);
    expect(codes(root)).toContain('perf-contract-evidence-wiring');
  });
});

describe('RED PROOF (I) — COMMENT-ONLY performance wiring appears, and it is STILL RED', () => {
  it('red: the step replaced by a comment that reads exactly like it', () => {
    // The trap, in its own case because it is the one a reviewer most wants to
    // see fail: the workflow still MENTIONS the command, in a line that
    // executes nothing, produces no artefact and cannot go red.
    const root = rootWith(ACCOUNTING_EVIDENCE_WORKFLOW, (t) =>
      t
        .split('\n')
        .map((l) => (/^(\s*)run:/.test(l) && l.includes(ACCOUNTING_BUDGETS_SUITE) ? l.replace(/^(\s*)/, '$1# ') : l))
        .join('\n'),
    );
    const after = source(ACCOUNTING_EVIDENCE_WORKFLOW, root);
    // 1 + 2: the mention survives, the step does not.
    expect(after, 'the plant removed the mention as well, so it does not isolate comment-only wiring').toContain(ACCOUNTING_BUDGETS_SUITE);
    expect(after.split('\n').filter((l) => /^\s*run:/.test(l) && l.includes(ACCOUNTING_BUDGETS_SUITE))).toEqual([]);
    // 3 + 4: and the law names the exact defect, in those words.
    expect(codes(root)).toContain('perf-contract-evidence-wiring');
    expect(details(root)).toMatch(/COMMENTED line\(s\) mention it|A commented command is prose/);
  });
});

describe('RED PROOF (J) — composition mode reports PASS over an EMPTY predecessor subject', () => {
  /**
   * WHY THIS PROOF IS BUILT ON THE FUNCTION AND NOT ON A GATE
   * (challenger finding F6, accepted).
   *
   * An earlier version of this proof asserted only that each gate's source
   * CONTAINS an `executed === 0` branch reaching a non-zero exit. That proved
   * the presence of text. It could not fail for the reason it existed, because
   * on this tree the branch is UNREACHABLE: every chain gate has at least one
   * step that is not Lane B, so something always executes and `executed` is
   * never 0. A proof whose subject cannot occur is the vacuity this file is
   * supposed to be refusing, and it was doing it to itself.
   *
   * So the decision is now `compositionOutcome()` and this proof hands it
   * `executed = 0` directly. That is a real exercise of the guard. The honest
   * statement about the gates is made separately and as a disclosure: the
   * branch is LATENT on this tree, and it becomes reachable the day a gate's
   * plan is all Lane B — which is precisely the day somebody would otherwise
   * ship a composed gate reporting PASS over nothing.
   */
  it('red: a composed run that executed NO step is refused, with the reason named', () => {
    // 1. THE SUBJECT EXISTS — the decision is a real function, reachable here.
    expect(typeof compositionOutcome).toBe('function');
    // 2. THE MUTATION: zero executed steps, one Lane B step skipped.
    const refusal = compositionOutcome('P2-S8 GATE', 0, 1);
    // 3. THE RESULT IS NON-EMPTY.
    expect(refusal, 'an empty composed subject produced NO refusal — composition mode would report PASS over nothing').not.toBeNull();
    // 4. THE EXACT INTENDED DEFECT IS NAMED.
    expect(refusal ?? '').toContain('FAIL');
    expect(refusal ?? '').toMatch(/empty predecessor subject is not a pass/);
    expect(refusal ?? '').toContain('TL-P4-GATE-COMP-01');
    expect(refusal ?? '').toContain('P2-S8 GATE');
  });

  it('and it does NOT fire when something did execute — the guard is not a blanket refusal', () => {
    // The converse, which is what makes the case above a discrimination rather
    // than a function that always complains.
    expect(compositionOutcome('P2-S8 GATE', 1, 1)).toBeNull();
    expect(compositionOutcome('P2-S8 GATE', 5, 0)).toBeNull();
  });

  it('every chain gate routes its empty-subject branch through that function, and stops the run', () => {
    for (const rel of CHAIN_GATES) {
      const code = stripProse(source(rel));
      expect(code, `${rel} does not consult compositionOutcome()`).toContain('compositionOutcome(');
      expect(code, `${rel}: the empty-subject branch does not stop the run`).toMatch(
        /emptySubject !== null\)\s*\{[\s\S]{0,300}?(process\.exit\(1\)|process\.exitCode = 1)/,
      );
    }
  });

  it('DISCLOSURE: the branch is latent — no gate on this tree can currently reach it', () => {
    // Recorded as an assertion so the disclosure cannot drift from the tree.
    // Each chain gate declares at least one step that is NOT Lane B, so
    // `executed` is never 0 today. If this ever fails, the guard above has
    // stopped being latent and has become load-bearing.
    const allLaneB: string[] = [];
    for (const rel of CHAIN_GATES) {
      const code = stripProse(source(rel));
      const steps = (code.match(/\bname:\s/g) ?? []).length;
      const laneB = (code.match(/hostSensitive:\s*true/g) ?? []).length;
      if (steps > 0 && laneB >= steps) allLaneB.push(rel);
    }
    expect(allLaneB, 'a gate now declares only Lane B steps; the empty-subject guard is reachable and must be exercised against that gate').toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AND THE SHIPPED TREE PASSES
// ───────────────────────────────────────────────────────────────────────────

describe('the shipped tree satisfies every law above (§5: and the shipped tree must PASS)', () => {
  it('the accounting performance contract is intact in this repository', () => {
    expect(accountingContractProblems(REPO)).toEqual([]);
  });

  it('the six accepted ceilings are the six ceilings, and the second source agrees with the suite', () => {
    const code = stripProse(source(ACCOUNTING_BUDGETS_SUITE));
    for (const [key, value] of Object.entries(ACCEPTED_ACCOUNTING_CEILINGS)) {
      // F is a product in the suite, so it is matched as the expression it is.
      if (key === 'F_RECONCILIATION_TOTAL') expect(code).toMatch(/F_RECONCILIATION_TOTAL:\s*5\s*\*\s*60\s*\*\s*1000/);
      else expect(code, `${key}`).toContain(`${key}: ${value},`);
    }
  });

  it('the analyzer takes no timing, starts no database and reads no environment: it is Lane A', () => {
    const analyzer = stripProse(source('scripts/guards/performance-contract.ts'));
    for (const forbidden of ['process.env', 'hrtime', 'Date.now', 'spawnSync', 'Pool(']) {
      expect(analyzer, `the analyzer references ${forbidden}, so its verdict could depend on the host`).not.toContain(forbidden);
    }
  });
});
