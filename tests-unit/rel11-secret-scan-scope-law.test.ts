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
 *            real workflow, and really does read steps that open with
 *            `- uses:`/`- run:`. Asserted FIRST, because every claim below is
 *            vacuously true against a file in which nothing was found.
 *   REL11-B  THE CLAIM. The snapshot scan carries no event condition => the
 *            push path to `main` is secret-scanned at all.
 *   REL11-B2 AND NOTHING ABOVE IT switches that step off: no job in the WHOLE
 *            `needs:` chain of `hygiene`, at any depth, carries an event
 *            condition, and each job's own `needs:` text is pinned so an
 *            unread form at any level fails closed. Without this, B is a claim
 *            about one line and not about coverage.
 *   REL11-C  NEGATIVE CONTROL. On a fixture in which that same step IS gated
 *            on `pull_request`, the reader reports the condition => B can fail,
 *            and this is the red proof of a guard that reads a file it must not
 *            edit. No byte of `ci.yml` is touched to obtain it.
 *   REL11-D  THE RECORDED GAP. The range scan IS gated on `pull_request`. This
 *            case PINS the gap so it cannot change unnoticed in either
 *            direction. When L2 closes REL-11, this case must be updated in
 *            the SAME commit — exactly as `dr71-schema-floor-guard` tells
 *            whoever adds a migration to move the constant with it.
 *   REL11-E  SCOPE. The workflow's push trigger really does include `main`, so
 *            the gap is in the step's condition and not in the trigger.
 *   REL11-F  NEGATIVE CONTROL. A missing job and a renamed step are reported;
 *            `undefined` (no such step) is kept apart from `null` (a step with
 *            no condition).
 *   REL11-G  NEGATIVE CONTROL. Removing the range gate is reported, so D is
 *            not true by construction.
 *   REL11-H  MECHANISM. Adjacent steps keep their own conditions, and the
 *            neighbour is taken by POSITION, not by action prefix.
 *   REL11-I  MECHANISM. A job-level condition is found wherever YAML allows it
 *            to be written — above `steps:` and below it.
 *   REL11-K  NEGATIVE CONTROL. A `needs:` written as a multi-element list —
 *            block, flow, or with a comment between items — is read WHOLE, so
 *            B2's loop checks every job it names; and a form the reader does
 *            NOT take whole does not quietly equal B2's pinned text, so the
 *            pin reddens instead of the list arriving short.
 *   REL11-L  NEGATIVE CONTROL. A gate two jobs deep in the chain is found and
 *            not stepped over, so B2 cannot be satisfied by depth one alone.
 *   REL11-J  NEGATIVE CONTROL. A key that is not `branches:` does not feed the
 *            scope claim, so E cannot go green on an excluded branch.
 *
 * This index is part of the file's claim, not decoration: a case added without
 * a line here is a claim nobody can find. (Second review, finding 5.)
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
    // `?? ''` only narrows the type: `i < lines.length`, so the element is
    // there. `noUncheckedIndexedAccess` is on, and a non-null assertion would
    // hide exactly the class of mistake this file exists to catch.
    const line = lines[i] ?? '';
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
      const [, key = '', value = ''] = opener;
      current = { name: key === 'name' ? value.trim() : `${key}:${value.trim()}`, condition: null };
      continue;
    }
    if (current === null) continue;
    const named = /^ {8}name: (.*)$/.exec(line);
    if (named !== null && current.name.startsWith('uses:')) current.name = (named[1] ?? '').trim();
    const cond = /^ {8}if: (.*)$/.exec(line);
    if (cond !== null) current.condition = (cond[1] ?? '').trim();
  }
  if (current !== null) steps.push(current);
  return steps;
}

export function conditionOf(steps: readonly WorkflowStep[], stepName: string): string | null | undefined {
  const hit = steps.find((s) => s.name === stepName);
  return hit === undefined ? undefined : hit.condition;
}

/**
 * One of a job's OWN keys, at four spaces inside that job's block.
 * `undefined` means no such job, `null` means the job has no such key.
 *
 * It deliberately does NOT stop at `steps:`. An earlier version did, and that
 * made a job whose `if:` is written AFTER `steps:` — a form YAML permits, since
 * mapping key order carries no meaning — read as `null`, that is, as "not
 * gated": green in the wrong direction. Step conditions live at eight spaces,
 * so scanning the whole block costs nothing. (Second review, finding 2.)
 */
export function jobKey(yamlText: string, jobName: string, key: string): string | null | undefined {
  const lines = yamlText.replace(/\r\n?/g, '\n').split('\n');
  const jobAt = lines.findIndex((l) => l === `  ${jobName}:`);
  if (jobAt === -1) return undefined;
  const want = new RegExp(`^ {4}${key}:(.*)$`);
  let value: string | null = null;
  // Set when the key was seen with an EMPTY inline value, so the six-space
  // items that follow are ITS block list. A previous version tested the
  // accumulated value instead, which stopped being empty after the first item
  // and so dropped every element after it — silently, and in the direction
  // that keeps an assertion green while it checks less than it names.
  // (Third review, finding 1.)
  let collecting = false;
  for (let i = jobAt + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^ {2}\S/.test(line)) break; // the next job
    const hit = want.exec(line);
    if (hit !== null) {
      if (value !== null) continue; // a duplicate key: the first one wins
      value = (hit[1] ?? '').trim();
      collecting = value === '';
      continue;
    }
    if (!collecting) continue;
    const item = /^ {6}- (.*)$/.exec(line);
    if (item !== null) {
      const got = (item[1] ?? '').trim();
      value = value === '' ? got : `${value},${got}`;
      continue;
    }
    // Only a real KEY ends the list. A comment is free to sit at any indent in
    // YAML, and treating one at four spaces as the end of the list truncated
    // it — silently, since a short list still equals a short expectation.
    // (Fourth review, finding 1.)
    if (/^ {4}[A-Za-z_-]+:/.test(line)) collecting = false;
  }
  return value;
}

export function jobCondition(yamlText: string, jobName: string): string | null | undefined {
  const v = jobKey(yamlText, jobName, 'if');
  return v === undefined ? undefined : v === null || v === '' ? null : v;
}

/**
 * The jobs a job hangs from, read from ITS OWN `needs:` key.
 *
 * The first version asserted `toContain('    needs: workspaces')` against the
 * whole file. That text appears FIVE times in this workflow, so the assertion
 * passed on four other jobs and could not fail however `hygiene`'s own `needs:`
 * changed — the same vacuity this file guards against, one layer further up.
 * (Second review, finding 1.)
 */
export function neededJobs(yamlText: string, jobName: string): readonly string[] {
  const raw = jobKey(yamlText, jobName, 'needs');
  if (raw === undefined || raw === null || raw === '') return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((j) => j.trim().replace(/^['"]|['"]$/g, ''))
    .filter((j) => j !== '');
}

/**
 * Every job a job depends on, TRANSITIVELY, including itself.
 *
 * Checking only what `hygiene`'s own `needs:` names measured the chain at one
 * depth. Nothing would have reddened if `workspaces` later took
 * `needs: prep` with `prep` gated on `pull_request`: the pin holds, the loop
 * finds `workspaces` ungated, and the coverage claim empties with REL11-B2
 * green — the same hole that was closed one layer down. (Fifth review.)
 */
export function jobChain(yamlText: string, start: string): readonly string[] {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const job = queue.shift() as string;
    if (seen.has(job)) continue;
    seen.add(job);
    for (const next of neededJobs(yamlText, job)) queue.push(next);
  }
  return [...seen];
}

/**
 * The branches the `push:` trigger names, in flow or block style — read from
 * the `branches:` key only.
 *
 * The first version collected every six-space list item under `push:`, so a
 * block-style `branches-ignore:` or `paths:` would have fed the result: the
 * case would then have gone GREEN swearing `main` is pushed while the workflow
 * excluded it by name. Treating a brittle red is no excuse for inventing a
 * false green. (Second review, finding 3.)
 */
export function pushBranches(yamlText: string): readonly string[] {
  const lines = yamlText.replace(/\r\n?/g, '\n').split('\n');
  const pushAt = lines.findIndex((l) => /^ {2}push:/.test(l));
  if (pushAt === -1) return [];
  const out: string[] = [];
  let inBranches = false;
  for (let i = pushAt + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^ {0,2}\S/.test(line)) break; // the next trigger
    const key = /^ {4}([A-Za-z_-]+):(.*)$/.exec(line);
    if (key !== null) {
      inBranches = key[1] === 'branches';
      if (!inBranches) continue;
      const flow = /^\s*\[(.*)\]\s*$/.exec(key[2] ?? '');
      if (flow !== null) {
        out.push(...(flow[1] ?? '').split(',').map((b) => b.trim().replace(/^['"]|['"]$/g, '')));
      }
      continue;
    }
    if (!inBranches) continue;
    const item = /^ {6}- (.*)$/.exec(line);
    if (item !== null) out.push((item[1] ?? '').trim().replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

/**
 * The step immediately after the named one. REL11-H is a claim about the
 * NEIGHBOUR of the range scan, and matching that neighbour by action prefix
 * found the FIRST `upload-artifact` step instead — so a second upload step
 * added above would have been measured in its place. Position is what the
 * claim is about. (Second review, finding 4.)
 */
export function stepAfter(steps: readonly WorkflowStep[], stepName: string): WorkflowStep | undefined {
  const at = steps.findIndex((s) => s.name === stepName);
  return at === -1 || at + 1 >= steps.length ? undefined : steps[at + 1];
}

/**
 * Put a line at the END of a job's block — after its last step — so a seeded
 * job key lands in text a workflow could actually have.
 */
export function insertAtEndOfJob(yamlText: string, jobName: string, line: string): string {
  const lines = yamlText.replace(/\r\n?/g, '\n').split('\n');
  const jobAt = lines.findIndex((l) => l === `  ${jobName}:`);
  if (jobAt === -1) return yamlText;
  let end = lines.length;
  for (let i = jobAt + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  // Step back over trailing blank lines so the key stays inside the block.
  while (end > jobAt + 1 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return [...lines.slice(0, end), line, ...lines.slice(end)].join('\n');
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
    // Read from `hygiene`'s OWN `needs:` key, and then every job it names is
    // checked. Asserting the text `    needs: workspaces` against the whole
    // file could not fail: it occurs five times.
    // The RAW text of hygiene's own `needs:` is pinned beside the loop, and
    // that is what closes the whole class of defects this law kept producing:
    // every incomplete read SHORTENS the list, and a shortened list still
    // equals a shortened expectation, so the deficiency arrived as green.
    // Pinned, any rewrite into a form the reader does not take whole fails
    // HERE, by name, instead of shrinking in silence.
    //
    // So this expectation is load-bearing, not decoration: if L2 legitimately
    // changes what `hygiene` needs, this reddens — and it must, because the
    // coverage claim in REL11-B depends on every job in that chain being
    // ungated. Move it in the same commit, after re-reading the chain.
    // (Fourth review, finding 1.)
    // The WHOLE chain, at every depth, and the raw `needs:` of each job in it
    // is pinned -- so an unread form at ANY level fails closed, not only at
    // the first. Today the chain is two jobs deep; the map is the claim about
    // its shape, and it reddens if that shape changes, which is the point.
    expect(jobChain(WORKFLOW, 'hygiene')).toEqual(['hygiene', 'workspaces']);
    const chainShape: Record<string, string | null | undefined> = {
      hygiene: 'workspaces',
      workspaces: null,
    };
    for (const [job, needs] of Object.entries(chainShape)) {
      expect(jobKey(WORKFLOW, job, 'needs'), `${job}'s own needs: text`).toBe(needs);
    }
    for (const job of jobChain(WORKFLOW, 'hygiene')) {
      expect(jobCondition(WORKFLOW, job), `${job} gates the chain hygiene hangs from`).toBeNull();
    }
  });

  it('REL11-C (negative control): the reader reports the condition when that same step is gated', () => {
    const gated = WORKFLOW.replace(`      - name: ${SNAPSHOT_STEP}\n`, `      - name: ${SNAPSHOT_STEP}\n        if: ${PULL_REQUEST_ONLY}\n`);
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
    // The claim is about the step that FOLLOWS the range scan, so it is taken
    // by position. Its action is asserted too, so the case says plainly which
    // step it measured and fails by name if the order changes.
    const neighbour = stepAfter(HYGIENE_STEPS, RANGE_STEP);
    // Named by action PREFIX, not by version: the claim is about which step
    // this is and what condition it carries, and the action's version is no
    // part of it. Pinning `@v4` would make a routine bump redden a security
    // law for a reason unrelated to scope. (Third review, finding 3.)
    expect(neighbour?.name).toMatch(/^uses:actions\/upload-artifact(@|$)/);
    expect(neighbour?.condition).toBe(`always() && ${PULL_REQUEST_ONLY}`);
  });

  it('REL11-I (mechanism): a job-level condition is found wherever YAML allows it to be written', () => {
    expect(jobCondition(WORKFLOW, 'no-such-job')).toBeUndefined();
    expect(jobCondition(WORKFLOW, 'hygiene')).toBeNull();
    // Above `steps:` -- the form that is actually used in this workflow.
    const gatedAbove = WORKFLOW.replace('  hygiene:\n', `  hygiene:\n    if: ${PULL_REQUEST_ONLY}\n`);
    expect(gatedAbove).not.toBe(WORKFLOW);
    expect(jobCondition(gatedAbove, 'hygiene')).toBe(PULL_REQUEST_ONLY);
    // And AFTER the step list, which YAML permits because mapping key order
    // carries no meaning. The first reader broke at `steps:` and reported
    // `null` here -- "not gated" for a job that is gated, the one direction a
    // security law must never be wrong in.
    //
    // The gate goes after the job's LAST step, not immediately after the
    // `steps:` key: inserting it there would orphan the six-space sequence
    // items onto `if:` and produce text YAML cannot parse, so the case would
    // have been proving the reader against an input no workflow could have.
    // (Third review, finding 2.)
    const gatedBelow = insertAtEndOfJob(WORKFLOW, 'hygiene', `    if: ${PULL_REQUEST_ONLY}`);
    expect(gatedBelow).not.toBe(WORKFLOW);
    expect(gatedBelow).toContain(`\n    if: ${PULL_REQUEST_ONLY}\n`);
    expect(jobCondition(gatedBelow, 'hygiene')).toBe(PULL_REQUEST_ONLY);
  });

  it('REL11-K (negative control): a block-style `needs:` is read whole, so B2 checks every job it names', () => {
    // The hole the third review found inside the cure for finding 1: the
    // collector dropped every element after the first, so `toEqual` stayed
    // green while the loop never saw the second job. A multi-element BLOCK
    // list is the form `needs:` is normally written in, and nothing touched
    // this branch until now.
    const twoNeeds = WORKFLOW.replace('  hygiene:\n    needs: workspaces\n', '  hygiene:\n    needs:\n      - workspaces\n      - prep\n');
    expect(twoNeeds).not.toBe(WORKFLOW);
    expect(neededJobs(twoNeeds, 'hygiene')).toEqual(['workspaces', 'prep']);
    // The flow form reads the same way. Anchored on `  hygiene:` because the
    // line `    needs: workspaces` occurs FIVE times in this workflow and a
    // string replace takes the first — which is another job's. This control
    // itself failed that way first: the same vacuity the review named, now
    // inside the seed instead of inside the assertion.
    const flowNeeds = WORKFLOW.replace('  hygiene:\n    needs: workspaces\n', "  hygiene:\n    needs: [workspaces, 'prep']\n");
    expect(flowNeeds).not.toBe(WORKFLOW);
    expect(neededJobs(flowNeeds, 'hygiene')).toEqual(['workspaces', 'prep']);

    // A comment between two block items. YAML lets a comment sit at any
    // indent, so one at four spaces must not be read as the end of the list.
    const commented = WORKFLOW.replace(
      '  hygiene:\n    needs: workspaces\n',
      '  hygiene:\n    needs:\n      - workspaces\n    # the chain this job hangs from\n      - prep\n',
    );
    expect(commented).not.toBe(WORKFLOW);
    expect(neededJobs(commented, 'hygiene')).toEqual(['workspaces', 'prep']);

    // And a form the reader does NOT take whole: a flow list broken over two
    // lines. The point is not that it is parsed — it is that the result does
    // not quietly equal the pinned text, so REL11-B2's pin reddens by name
    // rather than the list arriving short. Fail closed, not short.
    const brokenFlow = WORKFLOW.replace('  hygiene:\n    needs: workspaces\n', '  hygiene:\n    needs: [workspaces,\n      prep]\n');
    expect(brokenFlow).not.toBe(WORKFLOW);
    expect(jobKey(brokenFlow, 'hygiene', 'needs')).not.toBe('workspaces');
  });

  it('REL11-L (negative control): a gate two jobs deep in the chain is found, not stepped over', () => {
    // The hole the fifth review left open: with the chain measured at one
    // depth, a gated job BEHIND `workspaces` emptied the coverage claim while
    // every assertion stayed green. Seeded here at depth two, which is where
    // a real `needs:` edit would put it.
    const deep = WORKFLOW.replace('  workspaces:\n', `  workspaces:\n    needs: prep\n`).replace(
      '  hygiene:\n',
      `  prep:\n    if: ${PULL_REQUEST_ONLY}\n    runs-on: ubuntu-latest\n  hygiene:\n`,
    );
    expect(deep).not.toBe(WORKFLOW);
    // The traversal reaches it...
    expect(jobChain(deep, 'hygiene')).toEqual(['hygiene', 'workspaces', 'prep']);
    // ...and it is the gated one, so B2's loop over the chain would redden.
    expect(jobCondition(deep, 'prep')).toBe(PULL_REQUEST_ONLY);
    // And the depth-one reading, which this case exists to retire, saw nothing.
    expect(neededJobs(deep, 'hygiene')).toEqual(['workspaces']);
  });

  it('REL11-J (negative control): a branch key that is not `branches:` does not feed the scope claim', () => {
    // Treating finding 4's brittleness must not buy a false green: a
    // block-style `branches-ignore:` would otherwise be read as a pushed
    // branch, and REL11-E would swear `main` is pushed while it is excluded.
    const ignored = WORKFLOW.replace("    branches: [main, 'phase/**']\n", '    branches:\n      - phase/x\n    branches-ignore:\n      - main\n');
    expect(ignored).not.toBe(WORKFLOW);
    expect(pushBranches(ignored)).toEqual(['phase/x']);
    expect(pushBranches(ignored)).not.toContain('main');
    // And the block form of `branches:` itself is read, which is finding 4.
    const blockForm = WORKFLOW.replace("    branches: [main, 'phase/**']\n", "    branches:\n      - main\n      - 'phase/**'\n");
    expect(pushBranches(blockForm)).toEqual(['main', 'phase/**']);
  });
});
