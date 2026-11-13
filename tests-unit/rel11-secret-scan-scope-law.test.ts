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

const WORKFLOW = readFileSync(CI_WORKFLOW_PATH, 'utf8');
const HYGIENE_STEPS = stepsOfJob(WORKFLOW, 'hygiene');

describe('REL-11: the scope of each secret scan on a push to main', () => {
  it('REL11-A (positive control): the reader finds both secret-scan steps, by name, in the real workflow', () => {
    expect(HYGIENE_STEPS.length).toBeGreaterThan(0);
    const names = HYGIENE_STEPS.map((s) => s.name);
    // Named floor: `hygiene` carries many steps, and a reader that returned a
    // handful would be reading the wrong block while still "finding" two names.
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toContain(SNAPSHOT_STEP);
    expect(names).toContain(RANGE_STEP);
  });

  it('REL11-B: the snapshot scan has no event condition, so a push to main is secret-scanned', () => {
    expect(conditionOf(HYGIENE_STEPS, SNAPSHOT_STEP)).toBeNull();
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
    expect(WORKFLOW).toContain("    branches: [main, 'phase/**']");
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
    expect(conditionOf(HYGIENE_STEPS, 'uses:actions/upload-artifact@v4')).toBe(
      `always() && ${PULL_REQUEST_ONLY}`,
    );
  });
});
