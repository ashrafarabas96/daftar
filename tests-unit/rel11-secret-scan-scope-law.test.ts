import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * REL-11: which secret scan covers a PUSH to `main`, and which one does not.
 *
 * The workflow fires on `push: branches: [main, 'phase/**']` AND on
 * `pull_request`. Inside the `hygiene` job two different secret scans run:
 *
 *   - "Secret scan (gitleaks)" — the SNAPSHOT scan. It carries no event
 *     condition, so it runs in a push run too: a push to `main` is scanned.
 *   - "Secret history range scan (every commit of the pull request)" — the
 *     RANGE scan, which is the one that reads every commit of a branch. It is
 *     gated on `github.event_name == 'pull_request'`, so it does NOT run in a
 *     push run.
 *
 * That difference is REL-11, recorded in
 * `.local-context/cards/REL11_PUSH_RANGE_SCAN_L4_REQUEST_AR.md` as a request to
 * L2, the owner of `.github/workflows/ci.yml`. This file does not change that
 * workflow and must not: L4 may READ another lane's file, never write in it.
 *
 * So what is asserted here is the SCOPE of the two gates, not a fix:
 *
 *   REL11-A  POSITIVE CONTROL. The reader finds both steps, by name, in the
 *            real workflow. Asserted FIRST, because every claim below is
 *            vacuously true against a file in which nothing was found.
 *   REL11-B  THE CLAIM. The snapshot scan carries no event condition => the
 *            push path to `main` is secret-scanned at all.
 *   REL11-C  NEGATIVE CONTROL. On a fixture in which that same step IS gated
 *            on `pull_request`, the reader reports the condition => B can fail,
 *            and this is the red proof of a guard that reads a file it must not
 *            edit. No byte of `ci.yml` is touched to obtain it.
 *   REL11-D  THE RECORDED GAP. The range scan IS gated on `pull_request`. This
 *            case PINS the gap so it cannot change unnoticed in either
 *            direction. When L2 closes REL-11, this case must be updated in
 *            the SAME commit — exactly as the schema floor and REL-09's policy
 *            text are moved by whoever changes their subject.
 *   REL11-E  SCOPE. The workflow's push trigger really does include `main`, so
 *            the gap is in the step's condition and not in the trigger.
 */

const REPO_ROOT = resolve(__dirname, '..');
export const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/ci.yml');

const SNAPSHOT_STEP = 'Secret scan (gitleaks)';
const RANGE_STEP = 'Secret history range scan (every commit of the pull request)';
const PULL_REQUEST_ONLY = "github.event_name == 'pull_request'";

/** A step of one job: its `name:` and its `if:`, or null when it has none. */
export type WorkflowStep = { readonly name: string; readonly condition: string | null };

/**
 * The steps of one job, read without a YAML dependency on purpose: `js-yaml`
 * is present only transitively here, so a hoisting change in an unrelated
 * dependency would decide whether this law can run. The reader is
 * indentation-anchored and REL11-A proves it found what it was looking for.
 */
export function stepsOfJob(yamlText: string, jobName: string): readonly WorkflowStep[] {
  const lines = yamlText.replace(/\r\n?/g, '\n').split('\n');
  const jobAt = lines.findIndex((l) => l === `  ${jobName}:`);
  if (jobAt === -1) return [];

  const steps: { name: string; condition: string | null }[] = [];
  let current: { name: string; condition: string | null } | null = null;
  for (let i = jobAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // A new top-level job begins: two spaces, a name, a colon, nothing else.
    if (/^ {2}\S/.test(line) && line !== `  ${jobName}:`) break;

    // EVERY list item at this indent opens a step, not only `- name:`. A
    // reader that opened one only on `- name:` attributed the `if:` of the
    // following `- uses:` step to the previous one -- which is how this law's
    // own positive control first failed, on the real file: the range scan
    // appeared to carry `always() && ...`, the condition of the
    // `actions/upload-artifact` step below it.
    const opener = /^ {6}- (name|uses|run): ?(.*)$/.exec(line);
    if (opener !== null) {
      if (current !== null) steps.push(current);
      const [, key, value] = opener;
      current = { name: key === 'name' ? value.trim() : `${key}:${value.trim()}`, condition: null };
      continue;
    }
    if (current === null) continue;
    const named = /^ {8}name: (.*)$/.exec(line);
    if (named !== null && current.name.startsWith('uses:')) current.name = named[1].trim();
    const cond = /^ {8}if: (.*)$/.exec(line);
    if (cond !== null) current.condition = cond[1].trim();
  }
  if (current !== null) steps.push(current);
  return steps;
}

export function conditionOf(steps: readonly WorkflowStep[], stepName: string): string | null | undefined {
  const hit = steps.find((s) => s.name === stepName);
  return hit === undefined ? undefined : hit.condition;
}

/**
 * The same, for a step this file can only name through the action it runs.
 * Matched by PREFIX on purpose: pinning `@v4` would make a routine bump of an
 * unrelated action redden a security law, with a message naming an action
 * version instead of a change of scope. (Review of this PR, finding 3.)
 */
export function conditionOfActionStep(
  steps: readonly WorkflowStep[],
  actionPrefix: string,
): string | null | undefined {
  const hit = steps.find((s) => s.name.startsWith(`uses:${actionPrefix}`));
  return hit === undefined ? undefined : hit.condition;
}

/**
 * A job's own `if:`, at four spaces — the condition that decides whether any of
 * its steps run at all. Reading only the step's condition left this law's
 * coverage claim half-measured: a job-level gate would switch the whole scan
 * off while every step-level assertion stayed green. (Review, finding 1.)
 */
export function jobCondition(yamlText: string, jobName: string): string | null | undefined {
  const lines = yamlText.replace(/\r\n?/g, '\n').split('\n');
  const jobAt = lines.findIndex((l) => l === `  ${jobName}:`);
  if (jobAt === -1) return undefined;
  for (let i = jobAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}steps:/.test(line)) break; // past the job's own keys
    const cond = /^ {4}if: (.*)$/.exec(line);
    if (cond !== null) return cond[1].trim();
  }
  return null;
}

/** The branches the `push:` trigger names, in flow or block style. */
export function pushBranches(yamlText: string): readonly string[] {
  const lines = yamlText.replace(/\r\n?/g, '\n').split('\n');
  const pushAt = lines.findIndex((l) => /^ {2}push:/.test(l));
  if (pushAt === -1) return [];
  const out: string[] = [];
  for (let i = pushAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {0,2}\S/.test(line)) break;
    const flow = /^ {4}branches: \[(.*)\]$/.exec(line);
    if (flow !== null) {
      out.push(...flow[1].split(',').map((b) => b.trim().replace(/^['"]|['"]$/g, '')));
      continue;
    }
    const item = /^ {6}- (.*)$/.exec(line);
    if (item !== null) out.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

const WORKFLOW = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const HYGIENE_STEPS = stepsOfJob(WORKFLOW, 'hygiene');

describe('REL-11: the scope of each secret scan on a push to main', () => {
  it('REL11-A (positive control): the reader finds both secret-scan steps, by name, in the real workflow', () => {
    expect(HYGIENE_STEPS.length).toBeGreaterThan(0);
    const names = HYGIENE_STEPS.map((s) => s.name);
    // Named floor, deliberately BELOW the current count. `hygiene` carries ten
    // steps today, and a floor of ten would make a legitimate removal by the
    // workflow's owner — the work-folder cleanup, whose stated reason (the
    // self-hosted runner) `ci.yml` says DR-48 undid — fail THIS law with a
    // message accusing L4's reader instead of naming L2's edit. Five is enough
    // for its only purpose: proving the reader found a block of steps rather
    // than one stray list item. The two names below are the real claim.
    // (Review of this PR, finding 2.)
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain(SNAPSHOT_STEP);
    expect(names).toContain(RANGE_STEP);
    // The floor above used to be ten, and that count was quietly doing a
    // second job: it was what reddened when the reader opened a step only on
    // `- name:`. Lowering it to survive a legitimate removal cost that catch,
    // so the mechanism is asserted directly instead of being inferred from a
    // number: `hygiene` really does contain steps that open with `- uses:` or
    // `- run:`, and a reader that skipped them would attribute their `if:` to
    // whichever step came before.
    expect(names.filter((n) => n.startsWith('uses:') || n.startsWith('run:')).length).toBeGreaterThanOrEqual(1);
  });

  it('REL11-B: the snapshot scan has no event condition, so a push to main is secret-scanned', () => {
    expect(conditionOf(HYGIENE_STEPS, SNAPSHOT_STEP)).toBeNull();
  });

  it('REL11-B2: and nothing above the step switches it off — neither `hygiene` nor the job it needs is gated on an event', () => {
    // Without this, B is a claim about one line and not about coverage: a
    // job-level `if: github.event_name == 'pull_request'`, or the same on the
    // job `hygiene` needs, would stop the scan running on a push while every
    // step-level assertion here stayed green. (Review of this PR, finding 1 —
    // the vacuity this file guarded against in the step and forgot in the job.)
    //
    // If L2 ever does gate one of these, this case reddens and the coverage
    // claim in REL11-B must be re-examined in the SAME commit, not silenced.
    expect(jobCondition(WORKFLOW, 'hygiene')).toBeNull();
    expect(WORKFLOW).toContain('    needs: workspaces'); // the chain this job hangs from
    expect(jobCondition(WORKFLOW, 'workspaces')).toBeNull();
  });

  it('REL11-C (negative control): the reader reports the condition when that same step is gated', () => {
    const gated = WORKFLOW.replace(
      `      - name: ${SNAPSHOT_STEP}\n`,
      `      - name: ${SNAPSHOT_STEP}\n        if: ${PULL_REQUEST_ONLY}\n`,
    );
    expect(gated).not.toBe(WORKFLOW); // the seed landed; a no-op would pass vacuously
    const seeded = stepsOfJob(gated, 'hygiene');
    expect(conditionOf(seeded, SNAPSHOT_STEP)).toBe(PULL_REQUEST_ONLY);
    // And the claim of REL11-B, evaluated against the seeded text, is false:
    expect(conditionOf(seeded, SNAPSHOT_STEP)).not.toBeNull();
  });

  it('REL11-D (the recorded gap): the range scan runs on pull requests only — REL-11, open with L2', () => {
    // When L2 closes REL-11, this expectation must be moved in the same commit.
    // Its failure is not a defect in this law: it is the gap being closed.
    expect(conditionOf(HYGIENE_STEPS, RANGE_STEP)).toBe(PULL_REQUEST_ONLY);
  });

  it('REL11-E (scope): the workflow really does run on a push to main, so the gap is the condition and not the trigger', () => {
    // By MEANING, not by the line's spelling: `branches:` written as a block
    // list is the same trigger, and a security law must not redden because an
    // equivalent YAML form was chosen. (Review of this PR, finding 4.)
    expect(pushBranches(WORKFLOW)).toContain('main');
  });

  it('REL11-F (negative control): a missing job and a renamed step are reported, not silently passed', () => {
    expect(stepsOfJob(WORKFLOW, 'no-such-job')).toHaveLength(0);
    const renamed = WORKFLOW.replace(`      - name: ${SNAPSHOT_STEP}\n`, '      - name: Secret scan (renamed)\n');
    expect(renamed).not.toBe(WORKFLOW);
    // `undefined` is "no such step", which is NOT `null` ("a step with no
    // condition"). Keeping them apart is what stops B passing on a file in
    // which the step it talks about no longer exists.
    expect(conditionOf(stepsOfJob(renamed, 'hygiene'), SNAPSHOT_STEP)).toBeUndefined();
  });

  it('REL11-G (negative control): removing the range gate is reported, so D is not true by construction', () => {
    const ungated = WORKFLOW.replace(`        if: ${PULL_REQUEST_ONLY}\n`, '');
    expect(ungated).not.toBe(WORKFLOW);
    expect(conditionOf(stepsOfJob(ungated, 'hygiene'), RANGE_STEP)).toBeNull();
  });

  it('REL11-H (mechanism): adjacent steps keep their own conditions — a `- uses:` step does not lend its `if:` to the step above', () => {
    // The defect this law hit on its first run against the real file: the
    // `actions/upload-artifact` step below the range scan carries
    // `always() && github.event_name == 'pull_request'`, and a reader that
    // opened a step only on `- name:` attributed that condition to the range
    // scan. Both are pinned here, by value, so the misreading cannot return.
    expect(conditionOf(HYGIENE_STEPS, RANGE_STEP)).toBe(PULL_REQUEST_ONLY);
    expect(conditionOfActionStep(HYGIENE_STEPS, 'actions/upload-artifact')).toBe(
      `always() && ${PULL_REQUEST_ONLY}`,
    );
  });

  it('REL11-I (mechanism): the job reader stops at the job it was asked for', () => {
    // `jobCondition` must not wander into the next job and report ITS `if:`,
    // which is the same misreading `stepsOfJob` first made one level down.
    expect(jobCondition(WORKFLOW, 'no-such-job')).toBeUndefined();
    const gatedJob = WORKFLOW.replace('  hygiene:\n', `  hygiene:\n    if: ${PULL_REQUEST_ONLY}\n`);
    expect(gatedJob).not.toBe(WORKFLOW);
    expect(jobCondition(gatedJob, 'hygiene')).toBe(PULL_REQUEST_ONLY);
    // And a condition belonging to a LATER job is not attributed to this one.
    expect(jobCondition(WORKFLOW, 'hygiene')).toBeNull();
  });
});
