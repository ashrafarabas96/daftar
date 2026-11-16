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
 *   REL11-B2 AND NO EVENT CONDITION ABOVE IT switches that step off: no job in
 *            the WHOLE `needs:` chain of `hygiene`, at any depth, carries an
 *            event condition, and each job's own `needs:` text is pinned so an
 *            unread form at any level fails closed. Without this, B is a claim
 *            about one line and not about coverage.
 *
 *            THE TITLE SAYS "no event condition", NOT "nothing", and the
 *            narrowing is measured rather than cautious. Something above it
 *            DOES switch it off, and nothing in this file measures that: the
 *            scan steps carry no `if: always()`, and three steps run before
 *            them inside `hygiene` — `Dependency audit`
 *            (`npm audit --audit-level=high`), `Forbidden artifact scan` and
 *            `Raw credential scan`. A failure in any of them skips both scans.
 *            That is not a hypothesis: `docs/decisions/
 *            2026-10-27-ci-self-hosted-runner.md` records, as follow-up 1,
 *            that `gitleaks` "has never run on the self-hosted runner" because
 *            in every run so far it was "`skipped` because `hygiene` fails
 *            earlier at `Dependency audit`" — and marks that claim NOT_RUN.
 *            So the step order is a fourth load-bearing condition of D's
 *            argument, named below with the other three. It is a condition on
 *            the SCAN RUNNING AT ALL, which is why it cannot be read off a
 *            law over the file's text: whether a job's earlier step fails is a
 *            property of a run, and this file reads a workflow. Closing it
 *            belongs to whoever owns `ci.yml` (L2), as `if: always()` on the
 *            two scan steps or as a scan job of its own, and it is carded.
 *            (Sixth review, finding 2.)
 *   REL11-C  NEGATIVE CONTROL. On a fixture in which that same step IS gated
 *            on `pull_request`, the reader reports the condition => B can fail,
 *            and this is the red proof of a guard that reads a file it must not
 *            edit. No byte of `ci.yml` is touched to obtain it.
 *   REL11-D  THE RANGE SCAN'S SCOPE. It IS gated on `pull_request`. This case
 *            PINS that scope so it cannot change unnoticed in either
 *            direction. It is a SCOPE and not a gap, and here is the whole of
 *            why, with the probe named so the next reader can refute it.
 *
 *            THE PROBE, because this is the one claim in the file that no
 *            assertion here can make: `gh api repos/ashrafarabas96/daftar/
 *            branches/main/protection`, run by L4 on 2026-11-16, returned
 *            `strict=true`, TEN required contexts, `enforce_admins=true`,
 *            `allow_force_pushes=false`, `allow_deletions=false`, and reviews
 *            required. So no commit reaches `main` except through a pull
 *            request that passed those ten, an administrator's included, and
 *            scanning the range on pull requests covers every commit that can
 *            land. That reading is recorded in `.local-context/
 *            OWNER_QUEUE_AR.md` — which is NOT tracked by git, so a reader who
 *            has only this repository cannot check it and must re-run the
 *            probe. The probe is therefore the falsifier, not the prose: this
 *            paragraph is a dated reading of a mutable setting, and a setting
 *            can be changed by anyone with admin rights without touching a
 *            file. (An earlier version called it "the recorded gap", which was
 *            wider than the measurement; this version was wider than its
 *            evidence, which is the sixth review's finding 1.)
 *
 *            AND ONE RECORD STILL SAYS OTHERWISE, named rather than quietly
 *            left behind: `.local-context/cards/
 *            REL11_SECRET_RANGE_SCAN_PR_ONLY_AR.md` is open, on fingerprint
 *            `a191d9da`, and says the direct-push window is unscanned. It is
 *            updated in the same commit as this comment. Its OTHER measurement
 *            stands untouched and is not covered by anything here: this
 *            repository is PUBLIC (`gh repo view --json visibility` =>
 *            `PUBLIC`), so its whole history is readable by anyone regardless
 *            of what any scan covers. Scan scope and history exposure are two
 *            subjects, and D is only the first.
 *
 *            THAT ARGUMENT RESTS ON FOUR THINGS, so each is named rather than
 *            assumed: the protection as measured; the scan being inside a
 *            REQUIRED job (`hygiene`) rather than a required context of its
 *            own; the step not being `continue-on-error`, which REL11-E2
 *            pins; and no earlier step of `hygiene` failing, since neither
 *            scan step carries `if: always()` (REL11-B2 above, with the run in
 *            which exactly that happened). Lose any one — `enforce_admins`
 *            off, `hygiene` dropped from the required contexts,
 *            `continue-on-error: true`, or a red `Dependency audit` — and the
 *            gap is real again. If L2 later scans the range on pushes too,
 *            this case must be updated in the SAME commit, exactly as
 *            `dr71-schema-floor-guard` tells whoever adds a migration to move
 *            the constant with it.
 *   REL11-E  SCOPE. The workflow's push trigger really does include `main`, so
 *            the step's condition is what decides the scan's reach, not the
 *            trigger.
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
 *   REL11-E2 SCOPE, the two conditions D leans on that are NOT about the
 *            step's own `if:`: `push:` carries no `paths:`/`paths-ignore:`
 *            filter, so no changed-file set silently excludes a push; and the
 *            scan step is not `continue-on-error`, so a finding fails the job
 *            rather than being reported past.
 *   REL11-M  THE FORBIDDEN DIRECTION. A condition written on the NEXT line is
 *            never read as "no condition", at step level and at job level.
 *   REL11-N  THE FORBIDDEN DIRECTION, AT THE BLOCK BOUNDARY. A comment at the
 *            job indent does not end the job: a gate after one is still read,
 *            the step list is not truncated at it, and the boundary still
 *            stops where the job stops.
 *
 * This index is part of the file's claim, not decoration: a case added without
 * a line here is a claim nobody can find. (Second review, finding 5.) Three
 * cases had been added without one — E2, M and N — so the rule had been broken
 * by its own author twice before anyone read it. (Sixth review, finding 3.)
 */

const REPO_ROOT = resolve(__dirname, '..');
export const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/ci.yml');

const SNAPSHOT_STEP = 'Secret scan (gitleaks)';
const RANGE_STEP = 'Secret history range scan (every commit of the pull request)';
const PULL_REQUEST_ONLY = "github.event_name == 'pull_request'";

/** A step of one job: its `name:` and its `if:`, or null when it has none. */
export type WorkflowStep = { readonly name: string; readonly condition: string | null };

/**
 * A condition that IS there and whose text this reader cannot see, because
 * YAML put it on the line(s) after `if:`.
 *
 * It is a value and not `null` on purpose. `null` here means "no condition,
 * the step runs on every event", which is the claim this law makes about the
 * snapshot scan — so reading an unreadable condition as `null` would turn a
 * gated step into a proof that it is ungated. Unknown must cost, not pass.
 */
export const UNREADABLE_CONDITION = '<<a condition whose text is on the following line(s)>>';

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
    // A COMMENT IS NOT A BOUNDARY. `#` is not a space, so a comment at the job
    // indent used to end the block and TRUNCATE this list — and a claim over
    // "the steps of this job" then passes over steps it never saw. This
    // workflow writes such comments between jobs itself. (Sixth review,
    // finding 5; the same fix is in `jobKey`.)
    if (/^ {2}#/.test(line)) continue;
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
    // `if:` with NO space-and-value after it is valid YAML whose condition
    // sits on the following line(s). The first version required `if: ` with a
    // value, so that form left `condition` at `null` and this law swore the
    // step was unconditional while it was gated — a green in the forbidden
    // direction, the exact class the file claims to close. (Fifth review,
    // finding 1.) It is now read as PRESENT BUT UNREADABLE, so every
    // assertion fails closed: one that wants `null` sees a condition, and one
    // that wants a particular condition does not get it.
    const cond = /^ {8}if:(.*)$/.exec(line);
    if (cond !== null) {
      const text = (cond[1] ?? '').trim();
      current.condition = text === '' ? UNREADABLE_CONDITION : text;
    }
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
    // A comment at the job indent is not the next job: ending here read a job
    // whose `if:` follows such a comment as `null`, that is as UNGATED.
    // (Sixth review, finding 5; same fix as in `stepsOfJob`.)
    if (/^ {2}#/.test(line)) continue;
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
  if (v === undefined) return undefined;
  if (v === null) return null;
  // An empty value is `if:` with its text on the following line(s) — present,
  // not absent. Mapping it to `null` said "this job is ungated" about a job
  // that was gated. (Fifth review, finding 1.)
  return v === '' ? UNREADABLE_CONDITION : v;
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

  it("REL11-D (scope): the range scan runs on pull requests only — covered by the branch's protection, not a gap", () => {
    // If L2 later scans the range on pushes too, this expectation must be
    // moved in the same commit. Its failure is not a defect in this law: it is
    // the scope changing. Why this scope is coverage and not a gap, and the
    // three conditions that argument rests on, are in the header above.
    expect(conditionOf(HYGIENE_STEPS, RANGE_STEP)).toBe(PULL_REQUEST_ONLY);
  });

  it('REL11-E (scope): `push:` names `main` among its branches', () => {
    // By MEANING, not by the line's spelling: `branches:` written as a block
    // list is the same trigger, and a security law must not redden because an
    // equivalent YAML form was chosen. (Review of this PR, finding 4.)
    //
    // The name of this case used to say "the workflow really does run on a
    // push to main", which is WIDER than what it measures: `branches:` alone.
    // A `paths:` or `paths-ignore:` under `push:` can stop the run without
    // touching `branches:`, and this assertion would not have noticed. (Fifth
    // review, finding 2.) The name is narrowed, and the rest is measured in
    // REL11-E2 instead of implied here.
    expect(pushBranches(WORKFLOW)).toContain('main');
  });

  it('REL11-E2 (scope): nothing else narrows the push — no path filter, and the scan is not `continue-on-error`', () => {
    // A path filter under `push:` would mean "runs on a push to main only when
    // these files changed", so the scan would miss a push that touched
    // anything else. Read from the `on:` block's own text.
    const onBlock = WORKFLOW.slice(WORKFLOW.indexOf('\non:'), WORKFLOW.indexOf('\njobs:'));
    expect(onBlock, 'the on: block was not found, so this case measured nothing').toContain('push:');
    const pushBlock = onBlock.slice(onBlock.indexOf('  push:'), onBlock.indexOf('  pull_request:'));
    expect(pushBlock.length, 'the push: block was not isolated').toBeGreaterThan(0);
    expect(pushBlock).not.toMatch(/^ {4}paths(-ignore)?:/m);

    // And a step that reports failure without failing the job is a gate that
    // does not gate: "it runs" would stay true while nothing could stop a
    // push. (Fifth review, finding 2.)
    const snapshot = HYGIENE_STEPS.find((s) => s.name === SNAPSHOT_STEP);
    expect(snapshot, 'the snapshot step was not found, so this case measured nothing').toBeDefined();
    const stepText = WORKFLOW.slice(WORKFLOW.indexOf(`      - name: ${SNAPSHOT_STEP}`));
    const upToNextStep = stepText.slice(0, stepText.indexOf('\n      - ', 1) + 1 || undefined);
    expect(upToNextStep).toContain(SNAPSHOT_STEP);
    expect(upToNextStep).not.toMatch(/continue-on-error:\s*true/);
  });

  it('REL11-M (the forbidden direction): a condition written on the NEXT line is never read as "no condition"', () => {
    // The blocking finding of the fifth review, as an arm. `if:` with its text
    // on the following line is valid YAML, and the reader used to leave
    // `condition` at `null` for it — so REL11-B swore the snapshot scan was
    // ungated while it was gated to pull requests only. Fail-closed now: the
    // condition is reported as present-but-unreadable, which is not `null`.
    const multiline = WORKFLOW.replace(`      - name: ${SNAPSHOT_STEP}\n`, `      - name: ${SNAPSHOT_STEP}\n        if:\n          ${PULL_REQUEST_ONLY}\n`);
    expect(multiline).not.toBe(WORKFLOW); // the seed landed
    const seeded = conditionOf(stepsOfJob(multiline, 'hygiene'), SNAPSHOT_STEP);
    expect(seeded, 'an unreadable condition must not read as "no condition"').not.toBeNull();
    expect(seeded).toBe(UNREADABLE_CONDITION);

    // The same form at JOB level, which hid a gate on `hygiene` itself.
    const jobGated = WORKFLOW.replace('  hygiene:\n', '  hygiene:\n    if:\n      ' + PULL_REQUEST_ONLY + '\n');
    expect(jobGated).not.toBe(WORKFLOW);
    expect(jobCondition(jobGated, 'hygiene')).not.toBeNull();
  });

  it('REL11-N (the forbidden direction, at the block boundary): a comment at the job indent does not end the job', () => {
    // The sixth review found the last place the forbidden direction survived,
    // and it was not in a condition but in the BOUNDARY. Both readers ended a
    // job at the first line matching `^ {2}\S` — and `#` is not a space, so a
    // comment written at the JOB indent ended the block. That form is not
    // hypothetical: this very workflow uses it between jobs (`  # ----`,
    // `  # 2a. Backend — the no-database checks.`).
    //
    // Two consequences, both in the direction this file exists to refuse:
    //   - a job whose `if:` sits after such a comment read as `null`, that is
    //     as UNGATED, about a job that is gated;
    //   - and the step list was TRUNCATED at the comment, which is worse than
    //     a wrong list: a claim over "the steps of this job" passes vacuously
    //     over the steps it never saw, and REL11-E2's "the scan step is not
    //     `continue-on-error`" is exactly such a claim.
    const comment = '  # a comment at the job indent, which YAML allows anywhere\n';

    // JOB level: the gate sits after the comment and must still be read.
    const gatedAfterComment = WORKFLOW.replace('  hygiene:\n', `  hygiene:\n${comment}    if: ${PULL_REQUEST_ONLY}\n`);
    expect(gatedAfterComment).not.toBe(WORKFLOW); // the seed landed
    expect(jobCondition(gatedAfterComment, 'hygiene'), 'a gate after a comment must not read as "no gate"').toBe(PULL_REQUEST_ONLY);

    // STEP level: measured by the step that matters rather than by a total, so
    // this arm does not redden the day a step is added elsewhere in the job.
    const commentedSteps = WORKFLOW.replace(`      - name: ${SNAPSHOT_STEP}\n`, `${comment}      - name: ${SNAPSHOT_STEP}\n`);
    expect(commentedSteps).not.toBe(WORKFLOW);
    expect(conditionOf(stepsOfJob(commentedSteps, 'hygiene'), RANGE_STEP), 'the step list was truncated at a comment').toBe(PULL_REQUEST_ONLY);

    // AND THE BOUNDARY STILL WORKS, so the fix does not trade one wrong
    // direction for the other: `hygiene` must still END where it ends, and not
    // run on into the job below it. Its last step is the upload of the scan
    // evidence; a reader that over-ran would carry a later job's steps here.
    const names = stepsOfJob(WORKFLOW, 'hygiene').map((s) => s.name);
    expect(names[names.length - 1], 'hygiene no longer ends where this arm expects').toMatch(/^uses:actions\/upload-artifact(@|$)/);
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
    // ANCHORED on the range step's own name, not on the first `if:` in the
    // file. The unanchored seed deleted whichever gated step came first, so
    // the day another step above this one carries the same condition, G would
    // have reddened by naming this reader rather than by measuring the range
    // scan — a negative control that tests the wrong line is not a control.
    // (Fifth review, finding 3; REL11-K was already anchored for this reason.)
    const anchor = `      - name: ${RANGE_STEP}\n        if: ${PULL_REQUEST_ONLY}\n`;
    expect(WORKFLOW, 'the range step is not written in the form this seed expects').toContain(anchor);
    const ungated = WORKFLOW.replace(anchor, `      - name: ${RANGE_STEP}\n`);
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
