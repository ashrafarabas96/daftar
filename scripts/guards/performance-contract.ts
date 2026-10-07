/**
 * CONTRACT SHAPE IS COMPOSABLE; THE RUNTIME LATENCY VERDICT IS NOT
 * (TL-P4-GATE-COMP-01 §4).
 *
 * Composition mode stops EXECUTING the accounting budget benchmark. That is
 * only safe if a composed gate can still refuse a tree in which the budget
 * was WEAKENED — otherwise "we no longer run it" becomes "we no longer check
 * it", which is the forbidden reading of the ruling. So this module answers,
 * from the suite's SOURCE and nothing else:
 *
 *   — are the six accepted ceilings still the six accepted ceilings (15 ms
 *     has not become 20)?
 *   — is the sample count still 200 for the two short percentile budgets
 *     (200 has not become 20)?
 *   — is the verdict still `p95` (p95 has not become p50)?
 *   — is COMMIT still inside A's TIMED REGION (not moved out of the closure
 *     the clock is around)?
 *   — does the suite still exist, and is it still WIRED to a dedicated
 *     performance evidence step?
 *
 * It executes no benchmark, starts no database and takes no timing. Its answer
 * is the same on a fast machine and a loaded one, which is what makes it
 * Lane A.
 *
 * ── WHY SOURCE AND NOT `import` ────────────────────────────────────────────
 * An `import` of the contract would be a stronger check in the abstract — a
 * real value instead of a parsed one. It is the WRONG check here, and for a
 * structural reason, not a stylistic one: every permanent gate in this tree
 * takes `--root <dir>` so that `tests/security/phase2-s8-gate-tamper.test.ts`
 * and `tests/security/phase4-forward-evolution.test.ts` can point it at a
 * hard-linked COPY of the tree with exactly one file replaced, and prove each
 * refusal fires without ever writing to the real repository. An `import`
 * resolves against THIS checkout, so it would read the real suite no matter
 * which root the gate was given, and every red proof below would be
 * unprovable. Reading the file under `root` is therefore not the weaker
 * option; it is the only option that keeps the proofs honest.
 *
 * ── THE FOUR TRAPS THIS FILE IS BUILT AROUND ───────────────────────────────
 * The brief names traps this project has already been bitten by, and each one
 * is answered by a specific decision below rather than by care:
 *
 *   (1) A TEXTUAL LAW SATISFIED BY PROSE. `COMMENT ON FUNCTION … IS '…'` is
 *       real DDL, and a doc comment is real text. So every check here runs
 *       over `stripProse()` output: block comments, line comments AND string
 *       bodies are blanked before anything is matched. A law that `// 15 ms`
 *       satisfies is not a law, and the red proofs include that exact plant.
 *
 *   (2) A DEAD CONSTANT OR A DUPLICATE UNUSED THRESHOLD. Finding `15`
 *       somewhere proves nothing. So the ceiling is read out of ONE object
 *       literal whose declaration must be UNIQUE in the file, and the verdict
 *       assertion must reference that object BY MEMBER PATH. A second
 *       `const BUDGET` is a refusal, not a fallback.
 *
 *   (3) AN UNREACHABLE BRANCH. The region each case is read from is found by
 *       brace-matching the actual `describe(...)` → `it(...)` nesting, so a
 *       threshold in a function nothing calls is outside every region this
 *       module looks at, and cannot satisfy anything.
 *
 *   (4) DELEGATION THAT IS NOT THE WHOLE OF THE SUBJECT. A law that excuses a
 *       subject because it delegates must assert the delegation is ALL the
 *       subject does, or a wrapper that delegates and then adjusts the figure
 *       is excused twice over. Here: it is not enough that the A assertion
 *       names `BUDGET.A_POST_P95`. NO assertion anywhere in the suite may
 *       compare a measurement against a NUMERIC LITERAL, so a second
 *       assertion with a looser hand-written ceiling cannot hide beside the
 *       delegating one.
 *
 * ── NON-VACUITY ────────────────────────────────────────────────────────────
 * Every extraction reports a problem when it finds NOTHING, and the problem
 * says so in those words. A law that silently passes over an empty region is
 * the defect the red proofs (J) exist to catch, so "the region is empty" and
 * "the region is wrong" are two different, separately-named refusals.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The suite the accounting performance contract lives in. */
export const ACCOUNTING_BUDGETS_SUITE = 'tests/performance/accounting-budgets.test.ts';

/** The workflow that takes the dedicated, acceptance-scale measurement on GitHub. */
export const ACCOUNTING_EVIDENCE_WORKFLOW = '.github/workflows/phase2-s8-evidence.yml';

export interface ContractProblem {
  /** A stable code, so a red proof can name the EXACT intended defect rather than "something failed". */
  readonly code: string;
  readonly detail: string;
}

/**
 * THE ACCEPTED CONTRACT, carried here as a second source.
 *
 * PHASE_2_ACCOUNTING_EXECUTION_PLAN §34 is the first source and the suite is
 * the third. Two sources that must agree is how every other accepted figure in
 * this tree is pinned (a migration's digest is written in its gate as well as
 * in the manifest), and it is why "edit the suite" cannot move a ceiling: the
 * edit has to be made twice, in two files, one of which is a gate.
 *
 * F is `5 * 60 * 1000` in the suite — a product, not a literal — so the
 * extractor evaluates products of integers and nothing else. An expression it
 * cannot read is a refusal, never an assumption.
 */
export const ACCEPTED_ACCOUNTING_CEILINGS: Readonly<Record<string, number>> = {
  A_POST_P95: 15,
  B_ADJUSTMENT_ENDPOINT_P95: 60,
  C_TRIAL_BALANCE_P95: 500,
  D_LEDGER_PAGE_P95: 150,
  E_BALANCE_AS_OF_P95: 100,
  F_RECONCILIATION_TOTAL: 300_000,
};

/** The sample count the two short percentile budgets are measured at (TL-P4-S3 §4). */
export const ACCEPTED_SHORT_PERCENTILE_ITERATIONS = 200;

/** The sample count C, D and E are measured at, per tier. */
export const ACCEPTED_ITERATIONS = { tier1: 30, tier2: 60 } as const;

/**
 * The five percentile cases and the ceiling each one's verdict must name.
 * F is excluded: it is one timed pass against a wall-clock total, not a
 * percentile, so demanding `p95` of it would be a false law.
 */
const PERCENTILE_CASES: readonly { readonly letter: string; readonly ceiling: string }[] = [
  { letter: 'A', ceiling: 'A_POST_P95' },
  { letter: 'B', ceiling: 'B_ADJUSTMENT_ENDPOINT_P95' },
  { letter: 'C', ceiling: 'C_TRIAL_BALANCE_P95' },
  { letter: 'D', ceiling: 'D_LEDGER_PAGE_P95' },
  { letter: 'E', ceiling: 'E_BALANCE_AS_OF_P95' },
];

/** The cases measured at the raised sample count, and nothing else (TL-P4-S3 §4). */
const SHORT_PERCENTILE_CASES: readonly string[] = ['A', 'B'];

/**
 * BLANKS COMMENTS AND STRING BODIES, PRESERVING LENGTH AND LINE STRUCTURE.
 *
 * Length is preserved so every index this module computes still points at the
 * same character of the original file, which is what lets a problem quote a
 * line number a reader can open. Blanking rather than deleting is also what
 * makes trap (1) impossible: a doc comment that reads `A_POST_P95: 15` becomes
 * spaces, so no amount of prose can satisfy a check.
 *
 * Template literals keep their `${` … `}` substitutions, because an
 * interpolated `${BUDGET.A_POST_P95}` inside an `it()` title IS code and is
 * worth seeing; only the literal text around it is blanked.
 */
export function stripProse(source: string): string {
  return blankOut(source, true);
}

/**
 * THE SECOND VIEW, AND WHY TWO ARE NEEDED.
 *
 * Comments blanked, STRING BODIES KEPT. It exists because a SQL statement in
 * this suite is a string literal — `await c.query('COMMIT')` — so the view
 * that answers "are the ceilings and identifiers right" is the wrong view for
 * "does this region execute a COMMIT". Using `stripProse()` for the second
 * question blanks the statement's own text and makes the clean tree fail.
 *
 * The prose trap stays closed, which is the whole reason this is a second view
 * rather than simply reading the raw source: Budget A's timed closure carries
 * the comment «Measured through COMMIT on purpose», and raw source would let
 * that comment satisfy the clause. Here the comment is blanked and the string
 * survives, so the only thing that can satisfy the clause is a statement.
 *
 * Both views preserve length, so an index computed in one addresses the same
 * character in the other.
 */
export function stripCommentsKeepStrings(source: string): string {
  return blankOut(source, false);
}

/**
 * REGEX LITERALS, AND WHY THE LEXER MUST KNOW ABOUT THEM.
 *
 * A quote inside a regex literal is not a string delimiter. Six gates in the
 * composed chain contain `/\bfrom\s+'([^']+)'/g` — THREE apostrophes — and a
 * scanner that does not recognise the construct reads the first of them as a
 * string opener. Quote parity then inverts for the REST OF THE FILE: code is
 * blanked and string bodies survive, which is the exact inverse of what either
 * view promises. Measured on `scripts/phase3-s2-gate.ts`, the flip at `:339`
 * silently erased `compositionOutcome(` at `:415` from the identifier view.
 *
 * The failure mode is what makes it dangerous: the views still return a string
 * of the right length, so every law built on them keeps answering, and answers
 * about a file that has been turned inside out. Nine laws in the proof suite
 * reported "no subject found" rather than "defect found" — non-vacuity caught
 * it, which is the whole reason those assertions exist.
 *
 * A regex body is blanked in BOTH views. It is neither an identifier
 * declaration nor an executable statement, so nothing either view is for lives
 * inside one, and blanking it also closes the trap where a law is satisfied by
 * a PATTERN that merely mentions the thing — `/COMMIT/` is not a COMMIT.
 */
function regexStartsHere(source: string, slash: number): boolean {
  // A `/` opens a regex only where a VALUE may begin. Walk back over
  // whitespace to the last significant character; it decides.
  let k = slash - 1;
  while (k >= 0 && /\s/.test(source[k] as string)) k -= 1;
  if (k < 0) return true;
  const prev = source[k] as string;
  // After a value — identifier, number, `)`, `]` — a `/` is division.
  // After an operator, a separator, or `{`/`}`, a value may begin.
  if (/[=(,:;[!&|?+\-*%~^<>{}]/.test(prev)) return true;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    // …unless the "value" is really a keyword that a regex may follow.
    let w = k;
    while (w >= 0 && /[A-Za-z0-9_$]/.test(source[w] as string)) w -= 1;
    const word = source.slice(w + 1, k + 1);
    return ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'instanceof', 'new', 'do', 'else', 'yield', 'await'].includes(word);
  }
  return false;
}

function blankOut(source: string, blankStrings: boolean): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '//') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      blank(i, end);
      i = end;
      continue;
    }
    const ch = source[i];
    if (ch === '/' && regexStartsHere(source, i)) {
      // Scan the pattern: `\` escapes anything, and an unescaped `/` inside a
      // `[…]` character class does NOT close the literal.
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j] as string;
        if (c === '\n') break;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (inClass) {
          if (c === ']') inClass = false;
          j += 1;
          continue;
        }
        if (c === '[') {
          inClass = true;
          j += 1;
          continue;
        }
        if (c === '/') break;
        j += 1;
      }
      if (j < source.length && source[j] === '/') {
        blank(i + 1, j);
        let f = j + 1;
        while (f < source.length && /[gimsuyvd]/.test(source[f] as string)) f += 1;
        i = f;
        continue;
      }
      // Unterminated on this line: it was division after all.
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\n') break;
        j += source[j] === '\\' ? 2 : 1;
      }
      if (blankStrings) blank(i + 1, Math.min(j, source.length));
      i = Math.min(j + 1, source.length);
      continue;
    }
    if (ch === '`') {
      // Walk the template, blanking text and leaving `${ … }` alone.
      let j = i + 1;
      let textFrom = j;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '`') break;
        if (source.slice(j, j + 2) === '${') {
          if (blankStrings) blank(textFrom, j);
          let depth = 1;
          j += 2;
          while (j < source.length && depth > 0) {
            if (source[j] === '{') depth += 1;
            else if (source[j] === '}') depth -= 1;
            j += 1;
          }
          textFrom = j;
          continue;
        }
        j += 1;
      }
      if (blankStrings) blank(textFrom, Math.min(j, source.length));
      i = Math.min(j + 1, source.length);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * The region of a balanced bracket pair, found by depth counting from `open`.
 * `null` when the pair never closes — an unbalanced file is a refusal, never a
 * region that happens to reach the end.
 */
function matched(code: string, open: number, pair: '{}' | '()'): { readonly start: number; readonly end: number } | null {
  const [o, c] = pair.split('') as [string, string];
  if (code[open] !== o) return null;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === o) depth += 1;
    else if (code[i] === c) {
      depth -= 1;
      if (depth === 0) return { start: open, end: i };
    }
  }
  return null;
}

/** Splits the inside of an argument list on commas at depth zero. */
function topLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  args.push(inner.slice(from));
  return args;
}

/**
 * The same split, but returning ABSOLUTE [start, end) offsets into `code`
 * instead of substrings — so a span found in one source view can be read out
 * of the other. Both views preserve length, which is what makes that legal.
 */
function topLevelSpans(code: string, from: number, to: number): { readonly start: number; readonly end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let begin = from;
  for (let i = from; i < to; i += 1) {
    const ch = code[i];
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      spans.push({ start: begin, end: i });
      begin = i + 1;
    }
  }
  spans.push({ start: begin, end: to });
  return spans;
}

/** Every index at which `needle` occurs in `code`. */
function indices(code: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = code.indexOf(needle); at !== -1; at = code.indexOf(needle, at + 1)) out.push(at);
  return out;
}

const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length;

/** Integers and products of integers (`5 * 60 * 1000`), and nothing else. */
function literalNumber(text: string): number | null {
  const trimmed = text.trim().replace(/_/g, '');
  if (!/^\d+(\s*\*\s*\d+)*$/.test(trimmed)) return null;
  return trimmed.split('*').reduce((a, b) => a * Number(b.trim()), 1);
}

/**
 * THE ACCOUNTING PERFORMANCE CONTRACT, VERIFIED WITHOUT MEASURING ANYTHING.
 *
 * Returns one problem per violated clause. An empty array means every clause
 * below held; it never means a clause was not reached, because every
 * extraction that finds nothing reports that it found nothing.
 */
export function accountingContractProblems(root: string): ContractProblem[] {
  const problems: ContractProblem[] = [];
  const add = (code: string, detail: string): void => {
    problems.push({ code, detail });
  };
  const path = join(root, ACCOUNTING_BUDGETS_SUITE);

  // ── (G) The suite exists at all ──────────────────────────────────────────
  if (!existsSync(path)) {
    add(
      'perf-contract-suite-missing',
      `${ACCOUNTING_BUDGETS_SUITE} does not exist. The performance contract of Accounting A…F has no subject in this tree, so no ` +
        'gate and no CI step can measure it. Deleting the suite is not a way to satisfy the budgets (TL-P4-GATE-COMP-01: the ' +
        'redesign detaches the performance VERDICT from recursive composition; it does not delete performance verification).',
    );
    return problems;
  }
  const raw = readFileSync(path, 'utf8');
  /** Identifiers, numbers and structure. Comments AND string bodies blanked. */
  const code = stripProse(raw);
  /** Statements. Comments blanked, string bodies kept — see stripCommentsKeepStrings(). */
  const stmts = stripCommentsKeepStrings(raw);
  if (code.trim().length === 0) {
    add(
      'perf-contract-suite-empty',
      `${ACCOUNTING_BUDGETS_SUITE} contains no code once comments and string bodies are removed. A file of prose is not a ` +
        'performance suite, and a law that passed over it would be vacuous.',
    );
    return problems;
  }

  // ── (C) The six ceilings, read out of ONE unique object literal ──────────
  const budgetDecls = indices(code, 'const BUDGET');
  if (budgetDecls.length === 0) {
    add(
      'perf-contract-budget-absent',
      `${ACCOUNTING_BUDGETS_SUITE} declares no \`const BUDGET\` in code (prose does not count). The six accepted ceilings of ` +
        '§34 have nowhere to live, so nothing in this tree states what A…F are allowed to cost.',
    );
    return problems;
  }
  if (budgetDecls.length > 1) {
    add(
      'perf-contract-budget-shadowed',
      `${ACCOUNTING_BUDGETS_SUITE} declares \`const BUDGET\` ${budgetDecls.length} times (lines ` +
        `${budgetDecls.map((i) => lineOf(code, i)).join(', ')}). A duplicate threshold object is how a weakened ceiling hides ` +
        'behind an accepted one: this law reads ONE object and refuses to choose between two.',
    );
    return problems;
  }
  const braceAt = code.indexOf('{', budgetDecls[0] as number);
  const region = braceAt === -1 ? null : matched(code, braceAt, '{}');
  if (region === null) {
    add('perf-contract-budget-unreadable', `${ACCOUNTING_BUDGETS_SUITE}: the \`const BUDGET\` object literal does not close — the ceilings cannot be read.`);
    return problems;
  }
  const members = new Map<string, string>();
  for (const arg of topLevelArgs(code.slice(region.start + 1, region.end))) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(arg);
    if (m !== null) members.set(m[1] as string, m[2] as string);
  }
  if (members.size === 0) {
    add(
      'perf-contract-budget-empty',
      `${ACCOUNTING_BUDGETS_SUITE}: the \`const BUDGET\` object is EMPTY. Every ceiling check below would have had nothing to ` +
        'compare, which is the vacuous pass this clause exists to refuse.',
    );
    return problems;
  }
  for (const [key, expected] of Object.entries(ACCEPTED_ACCOUNTING_CEILINGS)) {
    const text = members.get(key);
    if (text === undefined) {
      add(
        'perf-contract-ceiling-missing',
        `${ACCOUNTING_BUDGETS_SUITE}: \`BUDGET.${key}\` is gone. An accepted ceiling that no longer exists is a budget that can ` +
          'no longer be missed, which is indistinguishable from a budget that was removed to make a gate green.',
      );
      continue;
    }
    const value = literalNumber(text);
    if (value === null) {
      add(
        'perf-contract-ceiling-unreadable',
        `${ACCOUNTING_BUDGETS_SUITE}: \`BUDGET.${key}\` is \`${text.trim().slice(0, 60)}\`, which this law cannot evaluate. An ` +
          'accepted ceiling must be an integer or a product of integers, so that a reviewer and a gate read the same number; an ' +
          'expression that depends on the environment is a ceiling nobody can pin.',
      );
      continue;
    }
    if (value !== expected) {
      add(
        'perf-contract-ceiling-changed',
        `${ACCOUNTING_BUDGETS_SUITE}: \`BUDGET.${key}\` is ${value} and the accepted ceiling is ${expected} (§34). A ceiling is ` +
          'never raised to make a gate pass. If the product genuinely cannot meet it, that is a finding to report, not a number ' +
          'to edit.',
      );
    }
  }
  for (const key of members.keys()) {
    if (!(key in ACCEPTED_ACCOUNTING_CEILINGS)) {
      add(
        'perf-contract-ceiling-added',
        `${ACCOUNTING_BUDGETS_SUITE}: \`BUDGET.${key}\` is not one of the six accepted ceilings. An extra member is how a looser ` +
          'twin of an accepted ceiling arrives, and the assertion that used to name the strict one quietly names the new one.',
      );
    }
  }

  // ── (D) The sample counts ────────────────────────────────────────────────
  const sampleDecl = /const\s+SHORT_PERCENTILE_ITERATIONS\s*=\s*([^;\n]+)/g;
  const sampleHits = [...code.matchAll(sampleDecl)];
  if (sampleHits.length !== 1) {
    add(
      'perf-contract-samples-absent',
      `${ACCOUNTING_BUDGETS_SUITE} declares \`SHORT_PERCENTILE_ITERATIONS\` ${sampleHits.length} time(s); exactly one is ` +
        'required. The sample count is half of what `p95` MEANS — at n = 30 it is the second-worst sample and one stall is the ' +
        'verdict, at n = 200 ten samples sit above it — so a missing or duplicated declaration is a missing or ambiguous contract.',
    );
  } else {
    const value = literalNumber(sampleHits[0]?.[1] ?? '');
    if (value !== ACCEPTED_SHORT_PERCENTILE_ITERATIONS) {
      add(
        'perf-contract-samples-changed',
        `${ACCOUNTING_BUDGETS_SUITE}: \`SHORT_PERCENTILE_ITERATIONS\` is ${value === null ? (sampleHits[0]?.[1] ?? '').trim() : value} and the accepted ` +
          `count is ${ACCEPTED_SHORT_PERCENTILE_ITERATIONS} (TL-P4-S3 §4). Lowering it does not change the ceiling and does not change the ` +
          'product; it changes what the number compared against the ceiling is an estimate OF, which is a silent weakening of the ' +
          'budget. Proven at tests/guards/accounting-budget-percentile-semantics.test.ts.',
      );
    }
  }
  const tierDecl = /const\s+ITERATIONS\s*=\s*TIER\s*===\s*2\s*\?\s*(\d+)\s*:\s*(\d+)/.exec(code);
  if (tierDecl === null) {
    add(
      'perf-contract-tier-samples-absent',
      `${ACCOUNTING_BUDGETS_SUITE}: the per-tier \`ITERATIONS\` declaration C, D and E are measured at could not be read. The ` +
        'sample count of a percentile budget is part of the budget.',
    );
  } else if (Number(tierDecl[1]) !== ACCEPTED_ITERATIONS.tier2 || Number(tierDecl[2]) !== ACCEPTED_ITERATIONS.tier1) {
    add(
      'perf-contract-tier-samples-changed',
      `${ACCOUNTING_BUDGETS_SUITE}: \`ITERATIONS\` is ${tierDecl[1]} at Tier 2 and ${tierDecl[2]} at Tier 1; the accepted counts are ` +
        `${ACCEPTED_ITERATIONS.tier2} and ${ACCEPTED_ITERATIONS.tier1}.`,
    );
  }

  // ── (E) Each case's verdict reads the accepted percentile and the accepted
  //        ceiling BY NAME, inside the case's own region ─────────────────────
  for (const { letter, ceiling } of PERCENTILE_CASES) {
    const describeAt = findCase(code, raw, letter);
    if (describeAt === -1) {
      add(
        'perf-contract-case-absent',
        `${ACCOUNTING_BUDGETS_SUITE}: no \`describe\` region for budget ${letter} could be found. Accounting ${letter} is part of ` +
          'the performance contract and A…F all remain in it; a case that is not in the file is a case nothing measures.',
      );
      continue;
    }
    const brace = code.indexOf('{', code.indexOf('=>', describeAt));
    const body = brace === -1 ? null : matched(code, brace, '{}');
    if (body === null) {
      add('perf-contract-case-unreadable', `${ACCOUNTING_BUDGETS_SUITE}: budget ${letter}'s describe body does not close.`);
      continue;
    }
    const inner = code.slice(body.start, body.end);
    if (inner.replace(/[\s{}]/g, '').length === 0) {
      add(
        'perf-contract-case-empty',
        `${ACCOUNTING_BUDGETS_SUITE}: budget ${letter}'s region is EMPTY. A present-but-empty case is the exact shape of a ` +
          'measurement that was removed without removing its name, and a law that read it as satisfied would be vacuous.',
      );
      continue;
    }
    const verdicts = indices(inner, 'toBeLessThanOrEqual(');
    if (verdicts.length === 0) {
      add(
        'perf-contract-verdict-absent',
        `${ACCOUNTING_BUDGETS_SUITE}: budget ${letter} makes no \`toBeLessThanOrEqual\` assertion. A measured case with no ` +
          'comparison records a number and decides nothing — it cannot go red however slow the product becomes.',
      );
      continue;
    }
    for (const at of verdicts) {
      const args = matched(inner, at + 'toBeLessThanOrEqual'.length, '()');
      const argText = args === null ? '' : inner.slice(args.start + 1, args.end).trim();
      if (argText !== `BUDGET.${ceiling}`) {
        add(
          'perf-contract-verdict-ceiling',
          `${ACCOUNTING_BUDGETS_SUITE}: budget ${letter} compares against \`${argText.slice(0, 60)}\` and the accepted contract is ` +
            `\`BUDGET.${ceiling}\`. The verdict must name the accepted ceiling BY MEMBER PATH — a literal, a local copy or a ` +
            'second threshold object is how a ceiling is loosened without any accepted number appearing to change.',
        );
      }
      // The SUBJECT of the comparison, read backwards from the assertion to
      // its `expect(`: `m.p95` and nothing else. This is clause (E) — the
      // percentile semantics — and it is why `p95 → p50` cannot pass.
      const expectAt = inner.lastIndexOf('expect(', at);
      const subject = expectAt === -1 ? '' : (topLevelArgs(matchedInner(inner, expectAt + 'expect'.length))[0] ?? '').trim();
      if (!/^m\.p95$/.test(subject)) {
        add(
          'perf-contract-verdict-quantile',
          `${ACCOUNTING_BUDGETS_SUITE}: budget ${letter}'s verdict is taken over \`${subject.slice(0, 40)}\` and the accepted ` +
            'contract judges it on `m.p95`. Substituting a lower quantile (`p50`), a mean, or a filtered series changes what the ' +
            'budget asserts while leaving the ceiling untouched, which is the most deniable way to weaken it.',
        );
      }
    }
  }

  // ── (D, continued) A and B are the cases measured at 200 ─────────────────
  for (const letter of SHORT_PERCENTILE_CASES) {
    const at = findCase(code, raw, letter);
    if (at === -1) continue;
    const brace = code.indexOf('{', code.indexOf('=>', at));
    const body = brace === -1 ? null : matched(code, brace, '{}');
    if (body === null) continue;
    const measureAt = code.indexOf('measure(', body.start);
    if (measureAt === -1 || measureAt > body.end) {
      add(
        'perf-contract-measure-absent',
        `${ACCOUNTING_BUDGETS_SUITE}: budget ${letter} does not call \`measure(\`, so neither its sample count nor its timed ` +
          'region can be read from its own case.',
      );
      continue;
    }
    // ABSOLUTE spans, so argument 3 — the closure the clock is around — can be
    // read out of the STATEMENTS view while the sample count is read out of the
    // identifier view. Reading both from one view is the defect this replaced:
    // `stripProse` blanks `'COMMIT'`, so the clean tree failed its own clause.
    const open = code.indexOf('(', measureAt + 'measure'.length);
    const callRegion = open === -1 ? null : matched(code, open, '()');
    if (callRegion === null) {
      add('perf-contract-measure-absent', `${ACCOUNTING_BUDGETS_SUITE}: budget ${letter}'s \`measure(\` call does not close.`);
      continue;
    }
    const spans = topLevelSpans(code, callRegion.start + 1, callRegion.end);
    const span = (n: number): { readonly start: number; readonly end: number } | undefined => spans[n];
    const declaredSpan = span(3);
    const declared = declaredSpan === undefined ? '' : code.slice(declaredSpan.start, declaredSpan.end).trim();
    if (declared !== 'SHORT_PERCENTILE_ITERATIONS') {
      add(
        'perf-contract-samples-wiring',
        `${ACCOUNTING_BUDGETS_SUITE}: budget ${letter} is measured at \`${declared === '' ? '(the default)' : declared.slice(0, 40)}\` ` +
          'rather than at `SHORT_PERCENTILE_ITERATIONS`. The declaration and the call must be the same thing: a constant that says ' +
          '200 while the call takes the 30-sample default is a contract satisfied on paper and abandoned in the run.',
      );
    }
    // ── (F) COMMIT inside the TIMED REGION ───────────────────────────────
    //
    // The clock is around argument 3 — the closure `measure()` calls — so the
    // question is not "does the file mention COMMIT" but "is COMMIT inside
    // THAT closure". The region is brace-matched, so moving the statement one
    // line past the closing brace moves it out of this string and is refused.
    if (letter === 'A') {
      const timedSpan = span(2);
      // The STATEMENTS view: `await c.query('COMMIT')` is a string literal, so
      // the identifier view would have blanked the very text being looked for.
      const timed = timedSpan === undefined ? '' : stmts.slice(timedSpan.start, timedSpan.end);
      const caseBody = stmts.slice(body.start, body.end);
      if (!/\bCOMMIT\b/.test(timed)) {
        const elsewhere = /\bCOMMIT\b/.test(caseBody);
        add(
          'perf-contract-commit-scope',
          `${ACCOUNTING_BUDGETS_SUITE}: budget A's TIMED closure does not contain COMMIT` +
            (elsewhere ? ' — it appears in the case but OUTSIDE the closure the clock is around' : ' and the case does not mention it at all') +
            '. A is measured through COMMIT on purpose: the deferred entry validators run there, so timing only the call leaves out ' +
            'the part of the cost that scales with the journal. Moving COMMIT out of the timed region lowers the measured figure ' +
            'without making the product faster, which is a weakening of the budget disguised as a refactor.',
        );
      }
      if (!/\bBEGIN\b/.test(timed)) {
        add(
          'perf-contract-commit-scope',
          `${ACCOUNTING_BUDGETS_SUITE}: budget A's timed closure does not open a transaction (no BEGIN). §34 A measures post() ` +
            'INSIDE AN EXISTING TRANSACTION; without the BEGIN/COMMIT pair in the timed region the case is measuring something else.',
        );
      }
    }
  }

  // ── Trap (4): the delegation must be the WHOLE of what the suite does ────
  for (const at of indices(code, 'toBeLessThanOrEqual(')) {
    const args = matched(code, at + 'toBeLessThanOrEqual'.length, '()');
    if (args === null) continue;
    const argText = code.slice(args.start + 1, args.end).trim();
    if (literalNumber(argText) !== null) {
      add(
        'perf-contract-literal-ceiling',
        `${ACCOUNTING_BUDGETS_SUITE}:${lineOf(code, at)} asserts against the numeric literal \`${argText.trim()}\`. Every ceiling in ` +
          'this suite must be named through `BUDGET`, with no exception: it is not enough that the accepted assertions delegate to ' +
          'the accepted object, because a second assertion carrying its own hand-written number would sit beside them unchallenged ' +
          'and decide the case first.',
      );
    }
  }

  // ── (H, I) The dedicated performance evidence step is REAL, not prose ────
  problems.push(...evidenceWiringProblems(root));
  return problems;
}

/**
 * Finds budget `letter`'s `describe(` in the stripped code.
 *
 * The title lives in a string, and `stripProse` blanks string bodies — which
 * is the point of trap (1) and also why the title cannot be matched in `code`.
 * So the POSITION is found in the raw source and then used in the stripped
 * source, where the two are index-identical because `stripProse` preserves
 * length. Prose still cannot satisfy anything: only the describe's CODE body
 * is read, and that body is read from the stripped text.
 */
function findCase(code: string, raw: string, letter: string): number {
  for (const at of indices(raw, 'describe(')) {
    // A `describe(` whose own opening is inside a comment is not a region.
    if (code.slice(at, at + 'describe('.length) !== 'describe(') continue;
    const head = raw.slice(at, at + 160);
    if (new RegExp(`describe\\(\\s*['"\`]${letter} [—-]`).test(head)) return at;
  }
  return -1;
}

/** The inside of the argument list that starts at the `(` on or after `from`. */
function matchedInner(code: string, from: number): string {
  const open = code.indexOf('(', from);
  if (open === -1) return '';
  const r = matched(code, open, '()');
  return r === null ? '' : code.slice(r.start + 1, r.end);
}

/**
 * (H) THE DEDICATED PERFORMANCE EVIDENCE WIRING, AND (I) WHY A COMMENT IS NOT
 * WIRING.
 *
 * Composition mode's whole justification is that the latency verdict is taken
 * SOMEWHERE ELSE, in a step a reviewer can point at. If that step disappears
 * the justification disappears with it, and the tree would be left with a
 * contract nobody measures — the one outcome the ruling forbids. So the wiring
 * is a Lane A check: it is verified in every mode, by every gate that composes
 * this contract.
 *
 * YAML comments are stripped first. `# run: npx vitest run …` is prose, it
 * executes nothing, and a law it satisfied would be a law that accepts a
 * promise in place of a step.
 */
export function evidenceWiringProblems(root: string): ContractProblem[] {
  const out: ContractProblem[] = [];
  const path = join(root, ACCOUNTING_EVIDENCE_WORKFLOW);
  if (!existsSync(path)) {
    out.push({
      code: 'perf-contract-evidence-workflow-missing',
      detail:
        `${ACCOUNTING_EVIDENCE_WORKFLOW} does not exist. It is the workflow that takes the acceptance-scale measurement of ` +
        'Accounting A…F on GitHub at an exact SHA. With it gone, composition mode would be dropping a measurement that has ' +
        'nowhere left to happen.',
    });
    return out;
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  const executes = lines.filter((l) => !/^\s*#/.test(l)).filter((l) => /^\s*(-\s*)?run:/.test(l) && l.includes(ACCOUNTING_BUDGETS_SUITE));
  if (executes.length === 0) {
    const commented = lines.filter((l) => /^\s*#/.test(l) && l.includes(ACCOUNTING_BUDGETS_SUITE));
    out.push({
      code: 'perf-contract-evidence-wiring',
      detail:
        `${ACCOUNTING_EVIDENCE_WORKFLOW} has no \`run:\` step that executes ${ACCOUNTING_BUDGETS_SUITE}` +
        (commented.length > 0
          ? `, though ${commented.length} COMMENTED line(s) mention it. A commented command is prose: it takes no measurement, ` +
            'produces no artefact and cannot fail. Wiring that exists only as a comment is exactly the defect this clause names.'
          : '. The dedicated performance evidence step is the reason a composed gate may stop executing the benchmark; without it, ' +
            'composition mode would be deleting the measurement rather than relocating it.'),
    });
  }
  return out;
}
