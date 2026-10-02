/**
 * TL-P4-S2-R3 — REQUIRED-CI CHAIN COMPOSITION, AND THE PROOF THAT THE RULING'S
 * PRECONDITION CAN GO RED
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-57, P4-AL-58.)
 *
 * The Architecture Lock's original form of composition was INTERNAL: a
 * successor slice gate ran its predecessor as its first stream, so one command
 * carried the whole chain. The Tech Lead has authorized the cheaper equivalent
 * for Phase 4's slice gates — CHAIN COMPOSITION INSIDE THE ONE REQUIRED JOB:
 * `P4-S1 → P4-S2 → later slice gates` run sequentially and visibly as separate
 * steps of the required `backend` job, so a delta gate need not re-execute a
 * ~50-minute predecessor inside itself.
 *
 * That trade is only sound while the JOB really is the composition. The
 * blocker it was ruled on existed because it was not: the required `backend`
 * job ran `gate:phase4:s1` and never ran `gate:phase4:s2`, so every green tick
 * reported for the slice was green for a workflow that never ran the slice's
 * gate — `A green workflow is not evidence for a gate the workflow never ran.`
 *
 * So the ruling's precondition is asserted here, permanently, as eight claims
 * about `.github/workflows/ci.yml`, over every slice gate in `CHAIN` —
 * P4-S1, P4-S2 and P4-S3 today, and whichever slice is added to that table
 * next:
 *
 *   C-1  a step of the required job runs the P4-S1 gate;
 *   C-2  a step of the required job runs each later slice gate;
 *   C-3  all of them are inside the REQUIRED `backend` job and nowhere else;
 *   C-4  each slice's step PRECEDES its successor's, pairwise along the chain;
 *   C-5  no step (and not the job) carries `continue-on-error`;
 *   C-6  no step (and not the job) carries an `if:`, and the workflow really
 *        does trigger on an ordinary `push` and `pull_request` — a step that
 *        can be skipped on a normal push is not a required gate;
 *   C-7  each step's command is EXACTLY `npm run gate:phase4:<slice>`;
 *   C-8  each step's `name` is EXACTLY the ruled one — a gate step that has
 *        been renamed is a gate a reader of the required job's log can no
 *        longer identify as that slice's.
 *
 * ── WHY THIS PARSES AND DOES NOT GREP ────────────────────────────────────
 *
 * A check that greps the workflow for a line is a check about that line's
 * text. It cannot see the two steps swapped, a step moved into another job, a
 * step re-indented into some other mapping, or `continue-on-error` landing on
 * the job instead of the step — and it CAN be satisfied by a COMMENT. This
 * repository has already had a rule convict a routine because the word
 * "execute" appeared in a comment, so the lesson is taken in the other
 * direction here: the workflow is PARSED into mappings and sequences, comments
 * are discarded by the parser before any claim is asked, and every claim is a
 * claim about a key's value at a position in the document tree.
 *
 * The parser is written here rather than imported. The repository declares no
 * YAML dependency: `js-yaml` exists in `node_modules` only as a transitive
 * dev-dependency of ESLint, it ships no type declarations and `@types/js-yaml`
 * is not installed, so `npm run typecheck` could not compile an import of it —
 * and a permanent law may not rest on a package nothing declares. The subset
 * parsed is the subset GitHub Actions workflows are written in (block
 * mappings, block sequences, block scalars, flow sequences, quoted and plain
 * scalars) and it is STRICT: an indentation it cannot account for is an error,
 * never a silently dropped key, because a dropped key is how a structural
 * check turns into a vacuous one.
 *
 * ── THE RED PROOFS ───────────────────────────────────────────────────────
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. Every way of breaking
 * the ruling's precondition is planted on a MUTATED COPY of the workflow TEXT
 * — the checkout is never touched, following the `rootMinus` discipline of
 * `tests/guards/phase4-deferred-seam-guard.test.ts`: the mutation is required
 * to have actually changed the text before the claim is asked, so a proof
 * cannot pass vacuously on the day the workflow is written differently.
 *
 * Both directions are proved: the workflow as it stands passes, and each of
 * the step removed, the two steps reordered, `continue-on-error` added, an
 * `if:` added, the command changed, and the step moved into another job
 * fails.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..');
const WORKFLOW = '.github/workflows/ci.yml';
const WORKFLOW_PATH = join(REPO, WORKFLOW);

/** The job the repository's required-checks configuration matches on. */
const REQUIRED_JOB = 'backend';
/** The exact command the ruling fixes for the P4-S2 step. */
const S2_COMMAND = 'npm run gate:phase4:s2';
/** The exact command for the P4-S3 step, on the same terms. */
const S3_COMMAND = 'npm run gate:phase4:s3';
/** The npm script names, as they appear inside a `run:`, used to FIND each gate step. */
const S1_SCRIPT = 'gate:phase4:s1';
const S2_SCRIPT = 'gate:phase4:s2';
const S3_SCRIPT = 'gate:phase4:s3';

/**
 * THE CHAIN, in order, as it must appear in the required job: the slice label,
 * the script that FINDS the step, the exact command it must run, and the
 * step's exact `name`.
 *
 * The `name` is part of the claim because a step found only by its command
 * can be RENAMED into something a reader of the job's log would not recognise
 * as the slice's gate — and the log is where a green tick is read. Adding a
 * slice to this table is the whole edit: C-1/C-2, C-3, C-5, C-6, C-7, the
 * name claim and the pairwise ordering are all driven from it, so a successor
 * gate cannot be wired into the job without being asserted here.
 */
const CHAIN: readonly { readonly slice: string; readonly script: string; readonly command: string; readonly name: string }[] = [
  { slice: 'P4-S1', script: S1_SCRIPT, command: 'npm run gate:phase4:s1', name: 'Phase 4 slice gate — P4-S1 (composes the Phase 3 corrective gate)' },
  { slice: 'P4-S2', script: S2_SCRIPT, command: S2_COMMAND, name: 'Phase 4 slice gate — P4-S2' },
  { slice: 'P4-S3', script: S3_SCRIPT, command: S3_COMMAND, name: 'Phase 4 slice gate — P4-S3' },
];

// ───────────────────────────────────────────────────────────────────────────
// A strict block-YAML reader for the workflow subset.
// ───────────────────────────────────────────────────────────────────────────

type YamlNode = string | null | YamlNode[] | { readonly [key: string]: YamlNode };

const at = (lines: readonly string[], i: number): string => lines[i] ?? '';
const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => {
  const t = line.trim();
  return t === '' || t.startsWith('#');
};
const skipBlank = (lines: readonly string[], from: number): number => {
  let i = from;
  while (i < lines.length && isBlank(at(lines, i))) i += 1;
  return i;
};

/**
 * Drop a trailing `#` comment. A `#` only opens a comment outside quotes and
 * when it is preceded by whitespace or starts the line, which is the YAML
 * rule — so `run: foo --tag=a#b` keeps its value.
 */
function stripComment(line: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === '#' && !single && !double && (i === 0 || /\s/.test(line.charAt(i - 1)))) return line.slice(0, i);
  }
  return line;
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return t;
}

/** `[a, 'b c']` → ['a', 'b c']. Only one level, which is all the workflow uses. */
function flowSequence(raw: string): YamlNode[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  const parts: string[] = [];
  let current = '';
  let single = false;
  let double = false;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner.charAt(i);
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    if (c === ',' && !single && !double) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map(unquote);
}

function inlineValue(raw: string): YamlNode {
  const t = raw.trim();
  if (t.startsWith('[') && t.endsWith(']')) return flowSequence(t);
  if (t === '~' || t === 'null') return null;
  return unquote(t);
}

const BLOCK_INDICATOR = /^[|>][+-]?\d*$/;

/**
 * A `|` / `>` block scalar: every following line indented further than the
 * key. Literal keeps the newlines, folded joins them with a space; a `-`
 * chomps the trailing newline. The lines are returned RAW apart from the
 * common indentation, so a `#` inside a shell script stays part of the
 * script.
 */
function blockScalar(lines: readonly string[], from: number, keyIndent: number, indicator: string): [string, number] {
  const body: string[] = [];
  let i = from;
  while (i < lines.length) {
    const line = at(lines, i);
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break;
    body.push(line);
    i += 1;
  }
  while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
  const indents = body.filter((l) => l.trim() !== '').map(indentOf);
  const common = indents.length === 0 ? keyIndent + 2 : Math.min(...indents);
  const dedented = body.map((l) => (l.trim() === '' ? '' : l.slice(common)));
  const folded = indicator.startsWith('>');
  let text = '';
  if (folded) {
    for (const line of dedented) {
      if (line === '') text += '\n';
      else text += (text === '' || text.endsWith('\n') ? '' : ' ') + line;
    }
  } else {
    text = dedented.join('\n');
  }
  if (!indicator.includes('-')) text += '\n';
  return [text, i];
}

const ENTRY = /^("[^"]*"|'[^']*'|[^:]+):(.*)$/;
const DASH = /^-(\s|$)/;

function parseNode(lines: string[], from: number, minIndent: number): [YamlNode, number] {
  const i = skipBlank(lines, from);
  if (i >= lines.length) return [null, i];
  const indent = indentOf(at(lines, i));
  if (indent < minIndent) return [null, i];
  if (DASH.test(at(lines, i).trimStart())) return parseSequence(lines, i, indent);
  return parseMapping(lines, i, indent);
}

function parseMapping(lines: string[], from: number, indent: number): [YamlNode, number] {
  const out: Record<string, YamlNode> = {};
  let i = from;
  for (;;) {
    i = skipBlank(lines, i);
    if (i >= lines.length) break;
    const line = at(lines, i);
    const here = indentOf(line);
    if (here < indent) break;
    if (here > indent) throw new Error(`${WORKFLOW}:${i + 1}: indentation ${here} inside a mapping at ${indent} — unreadable structure: ${line}`);
    const body = stripComment(line).trimEnd().slice(indent);
    if (DASH.test(body)) throw new Error(`${WORKFLOW}:${i + 1}: a sequence item where a mapping key was expected: ${line}`);
    const entry = ENTRY.exec(body);
    if (entry === null) throw new Error(`${WORKFLOW}:${i + 1}: neither a mapping key nor a sequence item: ${line}`);
    const key = unquote(entry[1] ?? '');
    const rest = (entry[2] ?? '').trim();
    if (key in out) throw new Error(`${WORKFLOW}:${i + 1}: duplicate key ${key}`);
    i += 1;
    if (rest === '') {
      const [child, next] = parseNode(lines, i, indent + 1);
      out[key] = child;
      i = next;
    } else if (BLOCK_INDICATOR.test(rest)) {
      const [text, next] = blockScalar(lines, i, indent, rest);
      out[key] = text;
      i = next;
    } else {
      out[key] = inlineValue(rest);
    }
  }
  return [out, i];
}

function parseSequence(lines: string[], from: number, indent: number): [YamlNode, number] {
  const out: YamlNode[] = [];
  let i = from;
  for (;;) {
    i = skipBlank(lines, i);
    if (i >= lines.length) break;
    const line = at(lines, i);
    const here = indentOf(line);
    if (here < indent) break;
    if (here > indent) throw new Error(`${WORKFLOW}:${i + 1}: indentation ${here} inside a sequence at ${indent} — unreadable structure: ${line}`);
    const body = line.slice(indent);
    if (!DASH.test(body)) throw new Error(`${WORKFLOW}:${i + 1}: a mapping key where a sequence item was expected: ${line}`);
    const rest = body.slice(1);
    if (stripComment(rest).trim() === '') {
      const [child, next] = parseNode(lines, i + 1, indent + 1);
      out.push(child);
      i = next;
    } else {
      // The dash becomes a space, so the item parses as an ordinary node
      // whose own indentation is the column just after it.
      lines[i] = ' '.repeat(indent + 1) + rest;
      const [child, next] = parseNode(lines, i, indent + 2);
      out.push(child);
      i = next;
    }
  }
  return [out, i];
}

/** The workflow document, as mappings, sequences and scalars. Comments are gone. */
export function parseWorkflow(text: string): YamlNode {
  const lines = text.split('\n');
  const [node, next] = parseNode(lines, 0, 0);
  const trailing = skipBlank(lines, next);
  if (trailing < lines.length) throw new Error(`${WORKFLOW}:${trailing + 1}: content left unparsed: ${at(lines, trailing)}`);
  return node;
}

// ───────────────────────────────────────────────────────────────────────────
// The seven claims.
// ───────────────────────────────────────────────────────────────────────────

const isMap = (n: YamlNode | undefined): n is { readonly [key: string]: YamlNode } => typeof n === 'object' && n !== null && !Array.isArray(n);
const isSeq = (n: YamlNode | undefined): n is YamlNode[] => Array.isArray(n);

interface GateStep {
  readonly job: string;
  readonly index: number;
  readonly step: { readonly [key: string]: YamlNode };
}

/** Every step of every job whose `run` command mentions `script`. Structure, never a line of text. */
function gateSteps(doc: YamlNode, script: string): GateStep[] {
  const found: GateStep[] = [];
  const jobs = isMap(doc) ? doc['jobs'] : undefined;
  if (!isMap(jobs)) return found;
  for (const job of Object.keys(jobs)) {
    const steps = isMap(jobs[job]) ? (jobs[job] as { readonly [key: string]: YamlNode })['steps'] : undefined;
    if (!isSeq(steps)) continue;
    steps.forEach((step, index) => {
      if (!isMap(step)) return;
      const run = step['run'];
      if (typeof run === 'string' && run.includes(script)) found.push({ job, index, step });
    });
  }
  return found;
}

/**
 * The ruling's precondition, as a list of findings. Empty means
 * REQUIRED-CI CHAIN COMPOSITION is legally in force for this workflow.
 */
export function chainCompositionProblems(text: string): string[] {
  const problems: string[] = [];
  let doc: YamlNode;
  try {
    doc = parseWorkflow(text);
  } catch (error) {
    return [`${WORKFLOW} cannot be read as a document: ${error instanceof Error ? error.message : String(error)}`];
  }

  // C-6, the trigger half: the workflow must run on an ordinary push and on a
  // pull request, or no step of it is a gate on either.
  const on = isMap(doc) ? doc['on'] : undefined;
  const triggers = isMap(on) ? Object.keys(on) : isSeq(on) ? on.filter((t): t is string => typeof t === 'string') : [];
  for (const event of ['push', 'pull_request'])
    if (!triggers.includes(event)) problems.push(`${WORKFLOW} does not trigger on ${event} — a gate inside it could not run on an ordinary ${event}`);

  const jobs = isMap(doc) ? doc['jobs'] : undefined;
  const job = isMap(jobs) ? jobs[REQUIRED_JOB] : undefined;
  if (!isMap(job)) return [...problems, `${WORKFLOW} has no \`${REQUIRED_JOB}\` job — the required job is where the chain is composed`];
  if (job['continue-on-error'] !== undefined)
    problems.push(`the \`${REQUIRED_JOB}\` job carries continue-on-error, so every gate inside it can fail without failing the job`);
  if (job['if'] !== undefined) problems.push(`the \`${REQUIRED_JOB}\` job is conditional (if: ${String(job['if'])}), so the whole chain can be skipped`);
  if (!isSeq(job['steps'])) return [...problems, `the \`${REQUIRED_JOB}\` job has no steps sequence`];

  for (const { slice, script, command: expected, name } of CHAIN) {
    const all = gateSteps(doc, script);
    // C-1 / C-2: it exists at all.
    if (all.length === 0) {
      problems.push(`no step of ${WORKFLOW} runs the ${slice} gate (${script}) — a green workflow is not evidence for a gate the workflow never ran`);
      continue;
    }
    // C-3: in the required job, and nowhere else.
    const here = all.filter((s) => s.job === REQUIRED_JOB);
    for (const stray of all.filter((s) => s.job !== REQUIRED_JOB))
      problems.push(`the ${slice} gate runs in the \`${stray.job}\` job, which is not the required \`${REQUIRED_JOB}\` job`);
    if (here.length === 0) {
      problems.push(`the ${slice} gate is in ${WORKFLOW} but not in the required \`${REQUIRED_JOB}\` job, so it gates nothing`);
      continue;
    }
    if (here.length > 1)
      problems.push(`the \`${REQUIRED_JOB}\` job runs the ${slice} gate ${here.length} times — which of them the chain rests on is undecidable`);
    for (const { step, index } of here) {
      // C-5: no allow-failure, at the step.
      if (step['continue-on-error'] !== undefined)
        problems.push(`the ${slice} gate step (#${index + 1}) carries continue-on-error, so a red gate leaves the required job green`);
      // C-6, the step half: no condition at all. A gate whose execution
      // depends on the event is not a gate on every push and pull request.
      if (step['if'] !== undefined)
        problems.push(`the ${slice} gate step (#${index + 1}) is conditional (if: ${String(step['if'])}), so an ordinary push or pull_request can skip it`);
      // C-7: the command, exactly. A weakened invocation is not the gate.
      const run = step['run'];
      const command = typeof run === 'string' ? run.trim() : '';
      if (command !== expected) problems.push(`the ${slice} gate step runs \`${command}\`, not exactly \`${expected}\``);
      // C-8: the step's NAME, exactly. A step renamed is a step a reader of
      // the required job's log can no longer identify as this slice's gate.
      if (step['name'] !== name)
        problems.push(
          `the ${slice} gate step (#${index + 1}) is named \`${String(step['name'])}\`, not \`${name}\` — a renamed gate step is not the ruled one`,
        );
    }
  }

  // C-4: each slice's gate runs after its predecessor's. Chain composition IS
  // the order, and it is asserted pairwise along CHAIN so a slice added to the
  // table is ordered against its neighbour without another claim being written.
  const inJob = (script: string): GateStep | undefined => gateSteps(doc, script).filter((s) => s.job === REQUIRED_JOB)[0];
  for (let i = 1; i < CHAIN.length; i += 1) {
    const before = CHAIN[i - 1];
    const after = CHAIN[i];
    if (before === undefined || after === undefined) continue;
    const first = inJob(before.script);
    const second = inJob(after.script);
    if (first === undefined || second === undefined) continue;
    if (first.index >= second.index)
      problems.push(
        `the ${after.slice} gate step (#${second.index + 1}) does not come after the ${before.slice} gate step (#${first.index + 1}) — chain composition requires the predecessor to run first`,
      );
  }
  return problems;
}

// ───────────────────────────────────────────────────────────────────────────
// The mutations. The checkout is never touched.
// ───────────────────────────────────────────────────────────────────────────

const WORKFLOW_TEXT = readFileSync(WORKFLOW_PATH, 'utf8');

/** The line range `[start, end)` of the step whose `run` is exactly `command`, comments excluded. */
function stepBlock(lines: readonly string[], command: string): [number, number] {
  const run = lines.findIndex((l) => stripComment(l).trim() === `run: ${command}`);
  expect(run, `no step of ${WORKFLOW} has \`run: ${command}\` on a line of its own`).toBeGreaterThan(-1);
  let start = run;
  while (start > 0 && !/^ {6}- /.test(at(lines, start))) start -= 1;
  expect(/^ {6}- /.test(at(lines, start)), `the step carrying \`${command}\` does not begin at a job step`).toBe(true);
  let end = start + 1;
  while (end < lines.length && !/^ {0,6}\S/.test(at(lines, end)) && !/^ {6}[-#]/.test(at(lines, end))) end += 1;
  return [start, end];
}

/** A copy of the workflow text with one mutation applied; the mutation must really change it. */
function workflowWith(what: string, mutate: (lines: string[]) => string[]): string {
  const mutated = mutate(WORKFLOW_TEXT.split('\n')).join('\n');
  expect(mutated === WORKFLOW_TEXT, `the mutation "${what}" changed nothing, so the proof would prove nothing`).toBe(false);
  return mutated;
}

/** A gate step, gone. A comment that still names the command is left behind on purpose. */
const STEP_REMOVED = (command: string): string =>
  workflowWith(`the step running ${command} removed`, (lines) => {
    const [start, end] = stepBlock(lines, command);
    return [...lines.slice(0, start), `      # removed; it used to be: run: ${command}`, ...lines.slice(end)];
  });

/** The P4-S2 step, gone. */
const S2_REMOVED = (): string => STEP_REMOVED(S2_COMMAND);

/** A gate step's `name:` replaced, its command untouched. */
const STEP_RENAMED = (command: string, replacement: string): string =>
  workflowWith(`the step running ${command} renamed to ${replacement}`, (lines) => {
    const [start, end] = stepBlock(lines, command);
    return lines.map((l, i) => (i >= start && i < end && /^ {6}- name: /.test(l) ? `      - name: ${replacement}` : l));
  });

/** Two gate steps swapped, named by their commands, so a successor would run before its predecessor. */
const SWAPPED = (earlier: string, later: string): string =>
  workflowWith(`${earlier} and ${later} reordered`, (lines) => {
    const [aStart, aEnd] = stepBlock(lines, earlier);
    const [bStart, bEnd] = stepBlock(lines, later);
    expect(aEnd, `${earlier} is expected to precede ${later} in the tree as it stands`).toBeLessThanOrEqual(bStart);
    return [...lines.slice(0, aStart), ...lines.slice(bStart, bEnd), ...lines.slice(aEnd, bStart), ...lines.slice(aStart, aEnd), ...lines.slice(bEnd)];
  });

/** A key added to a gate step's own mapping. */
const STEP_PLUS = (command: string, what: string, line: string): string =>
  workflowWith(what, (lines) => {
    const [start] = stepBlock(lines, command);
    return [...lines.slice(0, start + 1), line, ...lines.slice(start + 1)];
  });

/** A gate step's command changed. */
const COMMAND_CHANGED = (command: string, replacement: string): string =>
  workflowWith(`${command} changed to ${replacement}`, (lines) =>
    lines.map((l) => (stripComment(l).trim() === `run: ${command}` ? l.replace(`run: ${command}`, `run: ${replacement}`) : l)),
  );

/** A gate step moved out of the required job and into the `hygiene` job. */
const IN_ANOTHER_JOB = (command: string): string =>
  workflowWith(`the step running ${command} moved into the hygiene job`, (lines) => {
    const [start, end] = stepBlock(lines, command);
    const block = lines.slice(start, end);
    const without = [...lines.slice(0, start), ...lines.slice(end)];
    const hygiene = without.findIndex((l) => l === '  hygiene:');
    expect(hygiene, 'the workflow is expected to have a `hygiene` job to move the step into').toBeGreaterThan(-1);
    const steps = without.findIndex((l, i) => i > hygiene && l === '    steps:');
    expect(steps, 'the hygiene job is expected to have a steps sequence').toBeGreaterThan(-1);
    return [...without.slice(0, steps + 1), ...block, ...without.slice(steps + 1)];
  });

/** The P4-S1 and P4-S2 steps swapped, so the successor would run before its predecessor. */
const REORDERED = (): string => SWAPPED('npm run gate:phase4:s1', S2_COMMAND);

/** A key added to the P4-S2 step's own mapping. */
const S2_PLUS = (what: string, line: string): string => STEP_PLUS(S2_COMMAND, what, line);

/** The P4-S2 step's command changed. */
const S2_COMMAND_CHANGED = (replacement: string): string => COMMAND_CHANGED(S2_COMMAND, replacement);

/** The P4-S2 step moved out of the required job and into the `hygiene` job. */
const S2_IN_ANOTHER_JOB = (): string => IN_ANOTHER_JOB(S2_COMMAND);

// ───────────────────────────────────────────────────────────────────────────

describe('the reader really reads the workflow (a parser that drops a key makes every claim below vacuous)', () => {
  const doc = parseWorkflow(WORKFLOW_TEXT);

  it('the document is a mapping with the workflow’s own top-level keys', () => {
    expect(isMap(doc)).toBe(true);
    expect(Object.keys(isMap(doc) ? doc : {})).toEqual(['name', 'on', 'env', 'jobs']);
  });

  it('every job is reached, and the required job’s steps are a sequence of mappings', () => {
    const jobs = isMap(doc) ? doc['jobs'] : null;
    expect(isMap(jobs)).toBe(true);
    const names = Object.keys(isMap(jobs) ? jobs : {});
    expect(names).toContain(REQUIRED_JOB);
    expect(names.length).toBeGreaterThan(3);
    const job = isMap(jobs) ? jobs[REQUIRED_JOB] : null;
    const steps = isMap(job) ? job['steps'] : null;
    expect(isSeq(steps)).toBe(true);
    const list = isSeq(steps) ? steps : [];
    expect(list.length).toBeGreaterThan(20);
    expect(list.every((s) => isMap(s))).toBe(true);
  });

  it('a block scalar is read as its text and not as structure, and a comment inside it survives', () => {
    const jobs = isMap(doc) ? doc['jobs'] : null;
    const job = isMap(jobs) ? jobs[REQUIRED_JOB] : null;
    const steps = isSeq(isMap(job) ? job['steps'] : null) ? (isMap(job) ? (job['steps'] as YamlNode[]) : []) : [];
    const multi = steps.filter((s) => isMap(s) && typeof s['run'] === 'string' && (s['run'] as string).includes('\n'));
    expect(multi.length).toBeGreaterThan(0);
    const hygiene = isMap(jobs) ? jobs['hygiene'] : null;
    const hSteps = isSeq(isMap(hygiene) ? hygiene['steps'] : null) ? (isMap(hygiene) ? (hygiene['steps'] as YamlNode[]) : []) : [];
    // The forbidden-artifact scan's script contains `-name '.env'` and `#`-free
    // shell; the raw-credential scan's contains a `|` pipeline. Both must come
    // back as one string value, not as parsed keys.
    expect(hSteps.some((s) => isMap(s) && typeof s['run'] === 'string' && (s['run'] as string).includes('FORBIDDEN ARTIFACTS'))).toBe(true);
  });

  it('comments are discarded, so no claim below can be satisfied by prose', () => {
    expect(WORKFLOW_TEXT).toContain('# ');
    expect(JSON.stringify(doc)).not.toContain('A green workflow is not evidence');
  });
});

describe('TL-P4-S2-R3 — the ruling’s precondition holds in the tree as it stands', () => {
  it('GREEN: the required job composes P4-S1 then P4-S2, visibly, unconditionally', () => {
    expect(chainCompositionProblems(WORKFLOW_TEXT)).toEqual([]);
  });

  it('the P4-S2 step is what the ruling names it, with the database environment the other gate steps use', () => {
    const doc = parseWorkflow(WORKFLOW_TEXT);
    const [s2] = gateSteps(doc, S2_SCRIPT).filter((s) => s.job === REQUIRED_JOB);
    const [s1] = gateSteps(doc, S1_SCRIPT).filter((s) => s.job === REQUIRED_JOB);
    expect(s2).toBeDefined();
    expect(s1).toBeDefined();
    const step = s2 === undefined ? {} : s2.step;
    expect(step['name']).toBe('Phase 4 slice gate — P4-S2');
    expect(typeof step['run'] === 'string' ? (step['run'] as string).trim() : '').toBe(S2_COMMAND);
    const env = step['env'];
    const s1env = s1 === undefined ? {} : s1.step['env'];
    expect(isMap(env)).toBe(true);
    // Not a guessed value: the same PG_PORT the P4-S1 step sets, which is what
    // makes the harness reuse the job's `postgres` service.
    expect(isMap(env) ? env['PG_PORT'] : null).toBe(isMap(s1env) ? s1env['PG_PORT'] : 'nothing');
  });
});

describe('TL-P4-S2-R3 — and every way of breaking it is seen (planted on a copy of the text)', () => {
  it('RED: the P4-S2 step is removed — a comment that still names the command does not stand in for it', () => {
    const text = S2_REMOVED();
    expect(text).toContain(`# removed; it used to be: run: ${S2_COMMAND}`);
    const problems = chainCompositionProblems(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no step of');
    expect(problems[0]).toContain(S2_SCRIPT);
    expect(problems[0]).toContain('a gate the workflow never ran');
  });

  it('RED: the two gate steps are reordered so the successor runs before its predecessor', () => {
    const problems = chainCompositionProblems(REORDERED());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not come after');
    expect(problems[0]).toContain('the predecessor to run first');
  });

  it('RED: `continue-on-error: true` is added to the P4-S2 step', () => {
    const problems = chainCompositionProblems(S2_PLUS('continue-on-error on the P4-S2 step', '        continue-on-error: true'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('continue-on-error');
    expect(problems[0]).toContain('leaves the required job green');
  });

  it('RED: `continue-on-error: true` is added to the required job itself, not to the step', () => {
    const problems = chainCompositionProblems(
      workflowWith('continue-on-error on the required job', (lines) => {
        const job = lines.findIndex((l) => l === `  ${REQUIRED_JOB}:`);
        expect(job, 'the required job is expected to be a top-level job').toBeGreaterThan(-1);
        return [...lines.slice(0, job + 1), '    continue-on-error: true', ...lines.slice(job + 1)];
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('job carries continue-on-error');
  });

  it('RED: the P4-S2 step is made conditional, so a normal push skips it', () => {
    const problems = chainCompositionProblems(S2_PLUS('a workflow_dispatch-only condition', "        if: github.event_name == 'workflow_dispatch'"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is conditional');
    expect(problems[0]).toContain('can skip it');
  });

  it('RED: even a condition that reads as harmless is refused — a gate step carries no `if:` at all', () => {
    const problems = chainCompositionProblems(S2_PLUS('a success() condition', '        if: success()'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is conditional');
  });

  it('RED: the P4-S2 command is changed — a weakened invocation is not the gate', () => {
    for (const changed of [`${S2_COMMAND} -- --fast`, `${S2_COMMAND} || true`, `echo ${S2_COMMAND}`]) {
      const problems = chainCompositionProblems(S2_COMMAND_CHANGED(changed));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`not exactly \`${S2_COMMAND}\``);
      expect(problems[0]).toContain(changed);
    }
  });

  it('RED: the command is replaced by one that does not run the gate at all', () => {
    const problems = chainCompositionProblems(S2_COMMAND_CHANGED('npm run gate:phase4:s1'));
    expect(problems.some((p) => p.includes(`no step of`) && p.includes(S2_SCRIPT))).toBe(true);
  });

  it('RED: the P4-S2 step is moved into another job — being somewhere in the workflow is not being in the required job', () => {
    const problems = chainCompositionProblems(S2_IN_ANOTHER_JOB());
    expect(problems.some((p) => p.includes('runs in the `hygiene` job'))).toBe(true);
    expect(problems.some((p) => p.includes(`not in the required \`${REQUIRED_JOB}\` job`))).toBe(true);
  });

  it('RED: the workflow stops triggering on a normal push', () => {
    const problems = chainCompositionProblems(
      workflowWith('the push trigger removed', (lines) => {
        const push = lines.findIndex((l) => l === '  push:');
        expect(push, 'the workflow is expected to trigger on push').toBeGreaterThan(-1);
        return [...lines.slice(0, push), ...lines.slice(push + 2)];
      }),
    );
    expect(problems.some((p) => p.includes('does not trigger on push'))).toBe(true);
  });

  it('RED: the required job is renamed, so the chain is composed in a job no required check matches', () => {
    const problems = chainCompositionProblems(
      workflowWith('the required job renamed', (lines) => lines.map((l) => (l === `  ${REQUIRED_JOB}:` ? '  backend-renamed:' : l))),
    );
    expect(problems.some((p) => p.includes(`has no \`${REQUIRED_JOB}\` job`))).toBe(true);
  });

  it('RED: the two gate steps are re-indented out of the steps sequence — the reader refuses the document rather than passing', () => {
    const problems = chainCompositionProblems(
      workflowWith('the P4-S2 step re-indented one level deeper', (lines) => {
        const [start, end] = stepBlock(lines, S2_COMMAND);
        return [...lines.slice(0, start), ...lines.slice(start, end).map((l) => `  ${l}`), ...lines.slice(end)];
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cannot be read as a document');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P4-S3. The slice gate `npm run gate:phase4:s3` is a DELTA gate: it does not
// re-execute P4-S2 inside itself, so the ONLY thing that makes "P4-S1 → P4-S2
// → P4-S3" a composition is the order of these three steps in the one
// required job. Every way of breaking that is planted below, on a copy of the
// workflow text; the checkout is never touched.
// ───────────────────────────────────────────────────────────────────────────

describe('TL-P4-S2-R3 extended to P4-S3 — the required job composes the whole chain', () => {
  const doc = parseWorkflow(WORKFLOW_TEXT);
  const inJob = (script: string): GateStep | undefined => gateSteps(doc, script).filter((s) => s.job === REQUIRED_JOB)[0];

  it('GREEN: the required job runs P4-S1, then P4-S2, then P4-S3, visibly and unconditionally', () => {
    expect(chainCompositionProblems(WORKFLOW_TEXT)).toEqual([]);
    const indices = CHAIN.map((c) => inJob(c.script)?.index);
    expect(indices.every((i) => i !== undefined)).toBe(true);
    expect(indices).toEqual([...(indices as number[])].sort((a, b) => a - b));
  });

  it('the P4-S3 step is named, commanded and environed exactly as the chain requires', () => {
    const s3 = inJob(S3_SCRIPT);
    const s1 = inJob(S1_SCRIPT);
    expect(s3).toBeDefined();
    expect(s1).toBeDefined();
    const step = s3 === undefined ? {} : s3.step;
    expect(step['name']).toBe('Phase 4 slice gate — P4-S3');
    expect(typeof step['run'] === 'string' ? (step['run'] as string).trim() : '').toBe(S3_COMMAND);
    expect(step['continue-on-error']).toBeUndefined();
    expect(step['if']).toBeUndefined();
    // Not a guessed value: the same PG_PORT the P4-S1 step sets, which is what
    // makes the harness reuse the job's `postgres` service.
    const env = step['env'];
    const s1env = s1 === undefined ? {} : s1.step['env'];
    expect(isMap(env)).toBe(true);
    expect(isMap(env) ? env['PG_PORT'] : null).toBe(isMap(s1env) ? s1env['PG_PORT'] : 'nothing');
  });

  it('RED: the P4-S3 step is removed — a comment that still names the command does not stand in for it', () => {
    const text = STEP_REMOVED(S3_COMMAND);
    expect(text).toContain(`# removed; it used to be: run: ${S3_COMMAND}`);
    const problems = chainCompositionProblems(text);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no step of');
    expect(problems[0]).toContain(S3_SCRIPT);
    expect(problems[0]).toContain('a gate the workflow never ran');
  });

  it('RED: the P4-S3 step is RENAMED, its command untouched — the log would no longer identify the slice’s gate', () => {
    const problems = chainCompositionProblems(STEP_RENAMED(S3_COMMAND, 'Extra checks'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is named `Extra checks`');
    expect(problems[0]).toContain('not `Phase 4 slice gate — P4-S3`');
  });

  it('RED: P4-S3 is moved ahead of P4-S2 — a successor that runs before its predecessor composes nothing', () => {
    const problems = chainCompositionProblems(SWAPPED(S2_COMMAND, S3_COMMAND));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not come after');
    expect(problems[0]).toContain('P4-S2');
    expect(problems[0]).toContain('the predecessor to run first');
  });

  it('RED: `continue-on-error: true` is added to the P4-S3 step', () => {
    const problems = chainCompositionProblems(STEP_PLUS(S3_COMMAND, 'continue-on-error on the P4-S3 step', '        continue-on-error: true'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('continue-on-error');
    expect(problems[0]).toContain('leaves the required job green');
  });

  it('RED: the P4-S3 step is made conditional, so a normal push skips it', () => {
    for (const condition of ["        if: github.event_name == 'workflow_dispatch'", '        if: success()']) {
      const problems = chainCompositionProblems(STEP_PLUS(S3_COMMAND, `a condition on the P4-S3 step: ${condition}`, condition));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('is conditional');
    }
  });

  it('RED: the P4-S3 command is weakened — a weakened invocation is not the gate', () => {
    for (const changed of [`${S3_COMMAND} -- --structural-only`, `${S3_COMMAND} || true`, `echo ${S3_COMMAND}`]) {
      const problems = chainCompositionProblems(COMMAND_CHANGED(S3_COMMAND, changed));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`not exactly \`${S3_COMMAND}\``);
      expect(problems[0]).toContain(changed);
    }
  });

  it('RED: the P4-S3 step is moved into another job — being somewhere in the workflow is not being in the required job', () => {
    const problems = chainCompositionProblems(IN_ANOTHER_JOB(S3_COMMAND));
    expect(problems.some((p) => p.includes('runs in the `hygiene` job'))).toBe(true);
    expect(problems.some((p) => p.includes(`not in the required \`${REQUIRED_JOB}\` job`))).toBe(true);
  });
});
