/**
 * P4-S4 — THE GATE IS IN REQUIRED CI, AND THE PROOF THAT THAT CLAIM CAN GO RED.
 *
 * A previous slice of this phase shipped a gate that was in NO required job at
 * all. Every green tick reported for that slice was green for a workflow that
 * never ran the slice's gate: `A green workflow is not evidence for a gate the
 * workflow never ran.` This suite is the standing answer for P4-S4.
 *
 * The law is `requiredCiProblems` in `scripts/phase4-s4-gate.ts`, and the gate
 * runs it as its own `required-ci` check — so the claim "this gate gates every
 * push and pull request" is executed BY the gate, over the workflow file, on
 * every run, rather than being a sentence in a report.
 *
 * ── WHY THE LAW PARSES AND DOES NOT GREP ─────────────────────────────────
 *
 * A check that greps the workflow for `npm run gate:phase4:s4` is a check
 * about that string. It cannot see the step moved into a job nobody requires,
 * the step reordered before its predecessor, `continue-on-error` landing on
 * the job instead of the step, or an `if:` that skips the step on an ordinary
 * push — and it CAN be satisfied by a COMMENT. `RP-CI-H` plants exactly that
 * comment and requires the law to stay red, which is the one proof a grep
 * could never pass.
 *
 * ── HOW THE PLANTS ARE MADE AND UNDONE ───────────────────────────────────
 *
 * `[[daftar-a-green-gate-must-prove-it-can-be-red]]`. Every plant below is
 * applied to a MUTATED COPY of the workflow TEXT — the checkout is never
 * touched, following the `rootMinus` discipline of
 * `tests/guards/required-ci-chain-composition.test.ts` and
 * `tests/guards/phase4-deferred-seam-guard.test.ts`. Each mutation is required
 * to have ACTUALLY CHANGED the text before its claim is asked, so no proof can
 * pass vacuously on the day the workflow is written differently.
 *
 * Nothing here pins the NUMBER of steps in the required job to a literal: a
 * later slice adds steps, and an equality against today's count is the
 * P4-AL-88 defect. The non-vacuity assertions are FLOORS and positions
 * RELATIVE to the predecessor's step.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_JOB, S3_SCRIPT, S4_COMMAND, S4_SCRIPT, S4_STEP_NAME, WORKFLOW, readWorkflow, requiredCiProblems } from '../../scripts/phase4-s4-gate';

const REPO = join(__dirname, '..', '..');
const WORKFLOW_TEXT = readFileSync(join(REPO, WORKFLOW), 'utf8');

/** A floor on the required job's size, never an equality (P4-AL-88): it only grows. */
const STEP_FLOOR = 20;

/** The problems naming `fragment`, so a plant's own finding is read rather than the whole list. */
const about = (problems: readonly string[], fragment: string): string[] => problems.filter((p) => p.includes(fragment));

/** A copy of the workflow text with one mutation applied; the mutation must really change it. */
function workflowWith(what: string, mutate: (lines: string[]) => string[]): string {
  const mutated = mutate(WORKFLOW_TEXT.split('\n')).join('\n');
  expect(mutated === WORKFLOW_TEXT, `the mutation "${what}" changed nothing, so the proof would prove nothing`).toBe(false);
  return mutated;
}

/** The line range `[start, end)` of the step whose `run` is exactly `command`. */
function stepBlock(lines: readonly string[], command: string): [number, number] {
  const run = lines.findIndex((l) => l.trim() === `run: ${command}`);
  expect(run, `no step of ${WORKFLOW} has \`run: ${command}\` on a line of its own`).toBeGreaterThan(-1);
  let start = run;
  while (start > 0 && !/^ {6}- /.test(lines[start] ?? '')) start -= 1;
  expect(/^ {6}- /.test(lines[start] ?? ''), `the step carrying \`${command}\` does not begin at a job step`).toBe(true);
  let end = start + 1;
  while (end < lines.length && !/^ {0,6}\S/.test(lines[end] ?? '') && !/^ {6}[-#]/.test(lines[end] ?? '')) end += 1;
  return [start, end];
}

const S3_COMMAND = `npm run ${S3_SCRIPT}`;

// ─────────────────────────────────────────────────────────────────────────

describe('the workflow as it stands really does require this gate', () => {
  it('the law is silent over the workflow in the checkout', () => {
    expect(requiredCiProblems(WORKFLOW_TEXT)).toEqual([]);
  });

  it('the silence is about a real step at a real position, and not about an empty read', () => {
    const doc = readWorkflow(WORKFLOW_TEXT);
    expect(doc.triggers).toContain('push');
    expect(doc.triggers).toContain('pull_request');
    expect(doc.jobs).toContain(REQUIRED_JOB);
    const steps = doc.steps.filter((s) => s.job === REQUIRED_JOB);
    // A FLOOR: the required job only grows, and an equality here would be the
    // closure-rule defect P4-AL-88 names.
    expect(steps.length).toBeGreaterThan(STEP_FLOOR);
    const mine = steps.filter((s) => (s.run ?? '').includes(S4_SCRIPT));
    expect(mine.length, 'the required job does not run the P4-S4 gate exactly once').toBe(1);
    const step = mine[0];
    expect(step?.run?.trim()).toBe(S4_COMMAND);
    expect(step?.name).toBe(S4_STEP_NAME);
    expect(step?.continueOnError).toBe(false);
    expect(step?.conditional).toBe(false);
    // Chain composition IS the order: the predecessor's step comes first, in
    // the same job. Relative, never a step number written down.
    const predecessor = steps.filter((s) => (s.run ?? '').includes(S3_SCRIPT))[0];
    expect(predecessor, 'the required job does not run the P4-S3 gate').toBeDefined();
    expect((step?.index ?? -1) > (predecessor?.index ?? 0)).toBe(true);
    // And neither the job nor that step can be allowed to fail or be skipped.
    expect(doc.jobConditional).not.toContain(REQUIRED_JOB);
    expect(doc.jobContinueOnError).not.toContain(REQUIRED_JOB);
  });
});

describe('RP-CI-A — the step removed: planted red', () => {
  it('red: the P4-S4 gate step deleted from the required job is named, and the law refuses the workflow', () => {
    const mutated = workflowWith('the P4-S4 gate step removed', (lines) => {
      const [start, end] = stepBlock(lines, S4_COMMAND);
      return [...lines.slice(0, start), ...lines.slice(end)];
    });
    const problems = requiredCiProblems(mutated);
    expect(about(problems, 'no step')).not.toEqual([]);
    expect(problems.join('\n')).toContain('a green workflow is not evidence for a gate the workflow never ran');
  });
});

describe('RP-CI-B — continue-on-error: planted red', () => {
  it('red: continue-on-error on the gate step is named, so a red gate could not leave the job green', () => {
    const mutated = workflowWith('continue-on-error added to the P4-S4 gate step', (lines) => {
      const [start] = stepBlock(lines, S4_COMMAND);
      return [...lines.slice(0, start + 1), '        continue-on-error: true', ...lines.slice(start + 1)];
    });
    expect(about(requiredCiProblems(mutated), 'continue-on-error')).not.toEqual([]);
  });

  it('red: continue-on-error on the required JOB is named too — the key can land one level up', () => {
    const mutated = workflowWith('continue-on-error added to the backend job', (lines) =>
      lines.map((l, i) => (i === lines.findIndex((x) => x.startsWith(`  ${REQUIRED_JOB}:`)) ? `${l}\n    continue-on-error: true` : l)),
    );
    expect(about(requiredCiProblems(mutated), 'continue-on-error')).not.toEqual([]);
  });
});

describe('RP-CI-C — a condition on the step: planted red', () => {
  it('red: an if: on the gate step is named, because a step an ordinary push can skip is not a required gate', () => {
    const mutated = workflowWith('an if: added to the P4-S4 gate step', (lines) => {
      const [start] = stepBlock(lines, S4_COMMAND);
      return [...lines.slice(0, start + 1), "        if: github.ref == 'refs/heads/main'", ...lines.slice(start + 1)];
    });
    expect(about(requiredCiProblems(mutated), 'conditional')).not.toEqual([]);
  });
});

describe('RP-CI-D — the command weakened: planted red', () => {
  it('red: a step that runs the gate with --structural-only is named, because that is not this gate', () => {
    const mutated = workflowWith('the gate command given --structural-only', (lines) =>
      lines.map((l) => (l.trim() === `run: ${S4_COMMAND}` ? `${l} -- --structural-only` : l)),
    );
    expect(about(requiredCiProblems(mutated), 'not exactly')).not.toEqual([]);
  });
});

describe('RP-CI-E — the step renamed: planted red', () => {
  it('red: a renamed gate step is named, because the required job’s log is where a green tick is read', () => {
    const mutated = workflowWith('the P4-S4 gate step renamed', (lines) => {
      const [start, end] = stepBlock(lines, S4_COMMAND);
      return lines.map((l, i) => (i >= start && i < end && /^ {6}- name: /.test(l) ? '      - name: Extra checks' : l));
    });
    expect(about(requiredCiProblems(mutated), 'not `Phase 4 slice gate')).not.toEqual([]);
  });
});

describe('RP-CI-F — the step reordered before its predecessor: planted red', () => {
  it('red: the P4-S4 step moved ahead of the P4-S3 step is named — chain composition IS the order', () => {
    const mutated = workflowWith('the P4-S4 step moved ahead of the P4-S3 step', (lines) => {
      const [s4start, s4end] = stepBlock(lines, S4_COMMAND);
      const block = lines.slice(s4start, s4end);
      const without = [...lines.slice(0, s4start), ...lines.slice(s4end)];
      const [s3start] = stepBlock(without, S3_COMMAND);
      return [...without.slice(0, s3start), ...block, ...without.slice(s3start)];
    });
    expect(about(requiredCiProblems(mutated), 'does not come after')).not.toEqual([]);
  });
});

describe('RP-CI-G — the step moved into a job nobody requires: planted red', () => {
  it('red: the gate step in the hygiene job is named as not being in the required job', () => {
    const mutated = workflowWith('the P4-S4 gate step moved into another job', (lines) => {
      const [start, end] = stepBlock(lines, S4_COMMAND);
      const block = lines.slice(start, end);
      const without = [...lines.slice(0, start), ...lines.slice(end)];
      // The FIRST job's steps sequence, which is not `backend`: the step is
      // still in the workflow, still unconditional, and gates nothing the
      // repository requires.
      const jobsKey = without.findIndex((l) => /^jobs:/.test(l));
      const steps = without.findIndex((l, i) => i > jobsKey && /^ {4}steps:/.test(l));
      expect(steps, 'no job before the required one has a steps sequence to move the step into').toBeGreaterThan(-1);
      return [...without.slice(0, steps + 1), ...block, ...without.slice(steps + 1)];
    });
    const problems = requiredCiProblems(mutated);
    expect(problems, 'the law did not refuse a workflow whose gate step left the required job').not.toEqual([]);
    expect(problems.join('\n')).toMatch(/not (?:in )?the required/);
  });
});

describe('RP-CI-H — a comment that names the command: planted red (the proof a grep could never pass)', () => {
  it('red: the step replaced by a comment naming the same command is still named — the law parses, it does not grep', () => {
    const mutated = workflowWith('the P4-S4 gate step replaced by a comment naming its command', (lines) => {
      const [start, end] = stepBlock(lines, S4_COMMAND);
      return [...lines.slice(0, start), `      # run: ${S4_COMMAND}  (temporarily disabled)`, ...lines.slice(end)];
    });
    expect(mutated).toContain(S4_COMMAND); // the string IS there: a grep would pass
    expect(about(requiredCiProblems(mutated), 'no step')).not.toEqual([]);
  });
});

describe('RP-CI-I — the trigger removed: planted red', () => {
  it('red: a workflow that no longer runs on pull_request is named, because a gate inside it gates no pull request', () => {
    const mutated = workflowWith('the pull_request trigger removed', (lines) => {
      const i = lines.findIndex((l) => /^ {2}pull_request:/.test(l));
      expect(i, 'the workflow has no `pull_request:` trigger key').toBeGreaterThan(-1);
      let end = i + 1;
      while (end < lines.length && /^ {4}\S/.test(lines[end] ?? '')) end += 1;
      return [...lines.slice(0, i), ...lines.slice(end)];
    });
    expect(about(requiredCiProblems(mutated), 'does not trigger on pull_request')).not.toEqual([]);
  });
});
