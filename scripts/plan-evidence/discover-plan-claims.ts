/**
 * DISCOVER EVERY PLAN-SHAPE CLAIM IN THE TREE.
 *
 * The P4-S3 defect stood for months because the set of plan-shape claims was
 * carried in somebody's head. A remembered list cannot be audited, and it was
 * exactly the arm nobody remembered that went red the first time CI ran it.
 * So the set is DERIVED, here, from the working tree, by a published rule —
 * and the rule, not the result, is the thing under review.
 *
 * THE DISCOVERY RULE (verbatim, and the only input):
 *   1. Consider every file git tracks under the roots in ROOTS whose
 *      extension is in EXTENSIONS. Nothing is excluded by name: an exclusion
 *      list is how a claim hides.
 *   2. Scan every line against SIGNALS. A line matching any signal is a HIT.
 *   3. A hit is an ASSERTION when its line, or the two lines above it, carry
 *      an assertion verb. Otherwise it is a MENTION (a helper, a type, a
 *      comment, a doc). MENTIONS are reported so a reviewer can check the
 *      rule's reach.
 *   4. A line-local rule is NOT enough, and assuming it was is how the P4-S3
 *      arm hid: the real gates read `expect(rangesOn(nodes, idx)).toBe(true)`,
 *      where every plan word lives in a helper several lines away. So the
 *      rule also TAINTS: a declaration whose body matches a signal is
 *      plan-derived; a declaration whose body names a plan-derived
 *      identifier is plan-derived; iterate to a fixed point. Any assertion
 *      line naming a plan-derived identifier is a PLAN GATE. Plan gates are
 *      the claims that must hold on the target; they are the audit's subject.
 *   5. The phase is read from the path and the filename, never from memory.
 *
 * Output: JSON on stdout, or to --out=<file>. `--check` re-derives the
 * inventory and fails if the committed artifact is stale.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['tests', 'scripts', 'apps', 'packages', 'infrastructure', 'docs', '.github'];
const EXTENSIONS = new Set(['.ts', '.mts', '.tsx', '.sql', '.yml', '.yaml', '.md', '.json']);

/**
 * THE ONE EXCLUSION, AND WHY IT IS NOT A HIDING PLACE.
 *
 * Rule 1 says no file is excluded by name, because an exclusion list is how a
 * claim hides. There is exactly one exception and it is self-reference: this
 * generator's OWN OUTPUT lives in `docs/plan-evidence/`, and the inventory
 * quotes the text of every line it reports. Scanning it means the inventory
 * reports its own quotations, which the next run then quotes again — measured:
 * 196 hits became 416 on the second run, and it has no fixpoint.
 *
 * The audit report in the same directory is prose ABOUT claims, not a claim.
 *
 * This cannot become somewhere to hide an assertion, because
 * `tests/performance/plan-evidence-contract.test.ts` asserts that the
 * directory holds no executable file at all.
 */
const SELF = 'docs/plan-evidence/';

/** Every signal the directive names, each as its own labelled rule. */
export const SIGNALS: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: 'explain', re: /\bEXPLAIN\b/ },
  { id: 'explain-analyze', re: /\bEXPLAIN\s*\((?=[^)]*\bANALYZE\b)/i },
  { id: 'node-type', re: /['"`]Node Type['"`]|\bnodeType\b/ },
  { id: 'seq-scan', re: /\bSeq(uential)? Scan\b/ },
  { id: 'index-scan', re: /\bIndex Scan\b/ },
  { id: 'index-only-scan', re: /\bIndex Only Scan\b/ },
  { id: 'index-cond', re: /\bIndex Cond\b/ },
  { id: 'bitmap-plan', re: /\bBitmap (Index|Heap) Scan\b/ },
  { id: 'index-name', re: /['"`]Index Name['"`]/ },
  { id: 'planning-statistics', re: /\bplanningStatistics\b/ },
  { id: 'plan-cost', re: /['"`](Total|Startup) Cost['"`]|\bCOSTS\s+(ON|OFF|true|false)\b/i },
  { id: 'query-plan-json', re: /['"`]QUERY PLAN['"`]|FORMAT\s+JSON/i },
  { id: 'plan-shape-word', re: /\bplan[- ]shape\b|\bplanShape\b/i },
  // Collation-dependent range: the P4-S3 defect's own shape.
  {
    id: 'collation-dependent-range',
    re: /\^@|text_pattern_ops|varchar_pattern_ops|COLLATE\s+"?C"?\b|\bdatcollate\b|\bindcollation\b/,
  },
  // Row-estimate dependent gating.
  { id: 'row-estimate', re: /['"`]Plan Rows['"`]|['"`]Actual Rows['"`]|\breltuples\b|\bn_distinct\b/ },
];

const ASSERTION_VERB = /\bexpect\s*\(|\bassert\b|\bmust\b|\bthrow\b|\bfail\s*\(|\bok\s*\(/i;

/**
 * The files of the tree this inventory is about.
 *
 * In a git checkout: `git ls-files`, which is what a reviewer's checkout
 * contains. In an extracted release candidate there is no `.git` by design —
 * the release gate runs from the archive — and the archive's own
 * `DELIVERY_MANIFEST.json` inventory is the source, exactly as
 * `tests/helpers/delivered-files.ts` and
 * `tests/security/phase2-s8-gate-tamper.test.ts` already read it. A discovery
 * tool that can only run inside a repository would make the plan-claim
 * inventory unreproducible from the artifact the deployment is cut from, which
 * is the one place the inventory's claim about deployment matters most.
 */
function tracked(root: string): string[] {
  const manifest = join(root, 'DELIVERY_MANIFEST.json');
  const paths = existsSync(manifest)
    ? ((JSON.parse(readFileSync(manifest, 'utf8')) as { inventory?: { path?: string }[] }).inventory ?? [])
        .map((entry) => entry.path)
        .filter((path): path is string => typeof path === 'string' && path !== '')
    : execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      })
        .split('\0')
        .filter((rel) => rel.length > 0);
  // The manifest covers the whole archive, so the root filter is applied here
  // rather than being left to git's pathspec: both branches must answer with
  // the same set over the same tree.
  return paths.filter((p) => ROOTS.some((root) => p === root || p.startsWith(`${root}/`)) && EXTENSIONS.has(extname(p)) && !p.startsWith(SELF));
}

/** The phase is derived from the path, never remembered. */
export function phaseOf(path: string): string {
  const p = path.toLowerCase();
  const rules: readonly (readonly [RegExp, string])[] = [
    [/phase[-_]?4|p4s\d|\bp4\b|[/-]pos[/-]|pos-|phase4/, 'phase-4'],
    [/phase[-_]?3|p3s\d|\bp3\b|phase3/, 'phase-3'],
    [/phase[-_]?2|p2s\d|\bp2\b|phase2/, 'phase-2'],
    [/phase[-_]?1|phase1/, 'phase-1'],
  ];
  for (const [re, phase] of rules) if (re.test(p)) return phase;
  return 'cross-phase';
}

const DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const IDENT = /[A-Za-z_$][\w$]*/g;

/**
 * The identifiers of one file whose value is derived from a query plan.
 *
 * Seeded with every declaration whose body matches a signal, then closed
 * under "names a plan-derived identifier". Declaration bodies are delimited
 * by the next declaration at the same-or-shallower indentation, which is
 * coarse — deliberately so: a rule that over-reaches reports an extra claim,
 * and a rule that under-reaches hides one. Only one of those is a defect.
 */
export function planDerivedIdentifiers(lines: readonly string[]): Set<string> {
  const decls: { name: string; from: number; to: number; isFunction: boolean }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = DECL.exec(lines[i] ?? '');
    if (m?.[2] !== undefined)
      decls.push({
        name: m[2],
        from: i,
        to: lines.length,
        isFunction: m[1] === 'function' || m[1] === 'class',
      });
  }
  for (let d = 0; d < decls.length - 1; d += 1) {
    const cur = decls[d];
    const next = decls[d + 1];
    if (cur !== undefined && next !== undefined) cur.to = next.from;
  }
  // A FUNCTION'S SPAN IS ITS BRACES, not "up to the next declaration".
  //
  // `async function capture(…) {` is immediately followed by `const client
  // = …`, so the next-declaration bound made its span ONE LINE — the
  // signature — and the `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` eight
  // lines below it was never seen. That is how
  // `accounting-rls-equivalence.test.ts`'s `subplanRelations` gate escaped a
  // run of this generator and had to be found by hand.
  for (const d of decls) {
    if (!d.isFunction) continue;
    let depth = 0;
    let opened = false;
    for (let i = d.from; i < lines.length; i += 1) {
      for (const ch of lines[i] ?? '') {
        if (ch === '{') {
          depth += 1;
          opened = true;
        } else if (ch === '}') depth -= 1;
      }
      if (opened && depth <= 0) {
        d.to = i + 1;
        break;
      }
    }
  }

  // SEED TIGHTLY. The span between two declarations is a coarse bound, and
  // seeding from the whole span made one `const r = await client.query(
  // 'EXPLAIN …')` taint every later `r` in the file. A seed is the
  // declaration's own line and the three that follow — close enough to read
  // the initialiser, short enough not to swallow the next test. Names under
  // three characters are never seeds: `r`, `c`, `q` are re-bound everywhere
  // and carry no meaning across scopes.
  const tainted = new Set<string>();
  for (const d of decls) {
    if (d.name.length < 3) continue;
    // A function's body IS its declaration, so its seed is the whole span.
    // `async function capture()` runs its EXPLAIN eight lines in, and a
    // four-line window reads the signature and misses it. A value
    // declaration keeps the tight window, where the initialiser lives.
    const seed = (d.isFunction ? lines.slice(d.from, d.to) : lines.slice(d.from, Math.min(d.to, d.from + 4))).join('\n');
    if (SIGNALS.some((s) => s.re.test(seed))) tainted.add(d.name);
  }
  // SEED FROM ASSIGNMENTS TOO, not only declarations.
  //
  // `tests/performance/accounting-rls-equivalence.test.ts` declares
  // `let before: Capture;` on one line and assigns `before = await
  // capture(scope)` two hundred lines later, where `capture` is the function
  // that runs the EXPLAIN. A declaration-only rule reads the type annotation,
  // finds no plan word, and walks past `expect(before.subplanRelations…)` —
  // a genuine plan-shape gate. Found by hand while auditing, which is the
  // whole failure mode this generator exists to end, so the rule is widened
  // rather than the finding written down.
  const ASSIGN = /^\s*([A-Za-z_$][\w$]*)\s*=\s*(.*)$/;
  const assignments: { name: string; rhs: string }[] = [];
  for (const l of lines) {
    const m = ASSIGN.exec(l);
    if (m?.[1] !== undefined && m[1].length >= 3) assignments.push({ name: m[1], rhs: m[2] ?? '' });
  }
  for (const a of assignments) {
    if (SIGNALS.some((s) => s.re.test(a.rhs))) tainted.add(a.name);
  }

  // Propagate through CALLS only — `helper(` — not through every mention.
  // Propagating on any mention tainted whole files (one run measured 225
  // "gates" where there are a few dozen), and an inventory that flags
  // everything says nothing.
  for (let pass = 0; pass < 8; pass += 1) {
    let grew = false;
    for (const d of decls) {
      if (tainted.has(d.name) || d.name.length < 3) continue;
      const body = lines.slice(d.from, d.to).join('\n');
      for (const t of tainted) {
        if (t !== d.name && new RegExp(`\\b${t}\\s*\\(`).test(body)) {
          tainted.add(d.name);
          grew = true;
          break;
        }
      }
    }
    // An assignment whose right-hand side CALLS a plan-derived function makes
    // its target plan-derived too (`before = await capture(scope)`).
    for (const a of assignments) {
      if (tainted.has(a.name)) continue;
      for (const t of tainted) {
        if (t !== a.name && new RegExp(`\\b${t}\\s*\\(`).test(a.rhs)) {
          tainted.add(a.name);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }
  return tainted;
}

/**
 * The whole assertion statement beginning on `start`, by balancing
 * parentheses. Bounded at 40 lines so a malformed file cannot run away.
 */
export function assertionStatement(lines: readonly string[], start: number): string {
  const out: string[] = [];
  let depth = 0;
  let opened = false;
  for (let i = start; i < Math.min(lines.length, start + 40); i += 1) {
    const l = lines[i] ?? '';
    out.push(l);
    for (const ch of l) {
      if (ch === '(') {
        depth += 1;
        opened = true;
      } else if (ch === ')') depth -= 1;
    }
    if (opened && depth <= 0) break;
  }
  return out.join('\n');
}

export interface Hit {
  readonly file: string;
  readonly line: number;
  readonly phase: string;
  readonly signals: string[];
  readonly kind: 'plan-gate' | 'assertion' | 'mention';
  readonly via?: string[];
  readonly text: string;
}

export function discover(root: string): Hit[] {
  const hits: Hit[] = [];
  for (const rel of tracked(root)) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    let lines: string[];
    try {
      lines = readFileSync(abs, 'utf8').split('\n');
    } catch {
      continue;
    }
    // Taint analysis is a CODE analysis: a `const` inside a fenced block in a
    // Markdown document declares nothing.
    const isCode = ['.ts', '.mts', '.tsx'].includes(extname(rel));
    const fileHasSignal = SIGNALS.some((s) => s.re.test(lines.join('\n')));
    const tainted = isCode && fileHasSignal ? planDerivedIdentifiers(lines) : new Set<string>();

    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i] ?? '';
      const signals = SIGNALS.filter((s) => s.re.test(text)).map((s) => s.id);
      const window = [lines[i - 2] ?? '', lines[i - 1] ?? '', text].join('\n');
      const asserts = ASSERTION_VERB.test(window);

      // A plan gate: an assertion STATEMENT naming a plan-derived identifier.
      //
      // Statement, not line. The P4-S3 barcode gate reads
      //
      //     expect(
      //       candidates.some((i) => indexRangeOn(barcodeNodes, i)),
      //       '… must carry a >= / < RANGE …',
      //     ).toBe(true);
      //
      // and a line-local rule sees `expect(` with no plan word on it and
      // walks past the single most important claim in the slice. That is the
      // same under-reach that let the defect stand, reproduced in the tool
      // built to find it — so the statement is reassembled by balancing
      // parentheses from `expect(` before it is matched.
      // A comment is never a gate, however often it says "assert".
      const isComment = /^\s*(\/\/|\/\*|\*)/.test(text);
      const via =
        !isComment && /\bexpect\s*\(|\bassert/i.test(text) ? [...new Set(assertionStatement(lines, i).match(IDENT) ?? [])].filter((id) => tainted.has(id)) : [];

      if (signals.length === 0 && via.length === 0) continue;
      const kind: Hit['kind'] = via.length > 0 ? 'plan-gate' : asserts ? 'assertion' : 'mention';
      hits.push({
        file: rel,
        line: i + 1,
        phase: phaseOf(rel),
        signals,
        kind,
        ...(via.length > 0 ? { via } : {}),
        text: text.trim().slice(0, 300),
      });
    }
  }
  return hits;
}

interface Tally {
  planGates: number;
  assertions: number;
  mentions: number;
}

const emptyTally = (): Tally => ({ planGates: 0, assertions: 0, mentions: 0 });
const key = (k: Hit['kind']): keyof Tally => (k === 'plan-gate' ? 'planGates' : k === 'assertion' ? 'assertions' : 'mentions');

export function buildInventory(root: string): Record<string, unknown> {
  const hits = discover(root);
  const byPhase: Record<string, Tally> = {};
  const byFile: Record<string, Tally & { phase: string }> = {};
  for (const h of hits) {
    const p = (byPhase[h.phase] ??= emptyTally());
    const f = (byFile[h.file] ??= { ...emptyTally(), phase: h.phase });
    p[key(h.kind)] += 1;
    f[key(h.kind)] += 1;
  }
  return {
    $schema: 'daftar/plan-claim-inventory/1',
    generator: 'scripts/plan-evidence/discover-plan-claims.ts',
    discoveryRule: {
      roots: ROOTS,
      extensions: [...EXTENSIONS].sort(),
      signals: SIGNALS.map((s) => ({ id: s.id, pattern: s.re.source, flags: s.re.flags })),
      assertionVerb: { pattern: ASSERTION_VERB.source, flags: ASSERTION_VERB.flags },
      note: 'Derived from git ls-files. No file is excluded by name — an exclusion list is how a claim hides.',
    },
    totals: {
      hits: hits.length,
      planGates: hits.filter((h) => h.kind === 'plan-gate').length,
      assertions: hits.filter((h) => h.kind === 'assertion').length,
      files: Object.keys(byFile).length,
    },
    byPhase,
    byFile,
    hits,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const outArg = args.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const check = args.includes('--check');
  const inventory = buildInventory(process.cwd());
  const totals = inventory['totals'] as { hits: number; planGates: number; assertions: number };
  const json = `${JSON.stringify(inventory, null, 2)}\n`;

  if (check) {
    if (outArg === undefined) throw new Error('--check needs --out=<file>');
    const existing = existsSync(outArg) ? readFileSync(outArg, 'utf8') : '';
    if (existing !== json) {
      console.error(`STALE plan-claim inventory: ${outArg} does not match the tree. Re-run the generator:\n` + `  npm run plan-evidence:inventory`);
      process.exit(1);
    }
    console.info(`plan-claim inventory is current: ${totals.hits} hits, ${totals.planGates} plan gates, ${totals.assertions} assertions.`);
    return;
  }
  if (outArg !== undefined) {
    writeFileSync(outArg, json);
    console.info(`wrote ${outArg}: ${totals.hits} hits, ${totals.planGates} plan gates, ${totals.assertions} assertions`);
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1]?.endsWith('discover-plan-claims.ts')) main();
