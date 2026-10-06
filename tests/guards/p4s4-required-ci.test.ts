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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_JOB,
  S3_SCRIPT,
  S4_COMMAND,
  S4_EVIDENCE_STEPS,
  S4_SCRIPT,
  S4_STEP_NAME,
  WORKFLOW,
  evidenceIntegrityProblems,
  evidenceScriptBodyProblems,
  readWorkflow,
  rosterRunnerProblems,
  requiredCiProblems,
} from '../../scripts/phase4-s4-gate';

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

// ─────────────────────────────────────────────────────────────────────────
// RP-CI-J .. RP-CI-N — THE SAME LAW OVER THE MEASURED EVIDENCE STEPS.
//
// The gate step was pinned by `requiredCiProblems` and the two steps that
// MEASURE this slice were pinned by nothing at all: an exhaustive search of
// the tree for `perf:phase4:s4` found the workflow line, the npm script and
// three comments, and no law. That is the TL-P4-S2-R1 defect one level down —
// the gate's own place was proved and the evidence feeding the verdict was
// not. A budget nothing measured is indistinguishable from a budget that
// passed, so each plant below is one way to stop the measurement happening
// while every tick stays green.
//
// Each plant is applied to a mutated COPY of the workflow text, like every
// proof above, and is required to have really changed it.

describe('the measured evidence steps are pinned too, and the pin can go red', () => {
  it('the law is silent over the checkout, about real steps ahead of the gate', () => {
    expect(requiredCiProblems(WORKFLOW_TEXT)).toEqual([]);
    const doc = readWorkflow(WORKFLOW_TEXT);
    const steps = doc.steps.filter((s) => s.job === REQUIRED_JOB);
    const gate = steps.filter((s) => (s.run ?? '').includes(S4_SCRIPT))[0];
    expect(gate, 'the required job does not run the P4-S4 gate').toBeDefined();
    expect(S4_EVIDENCE_STEPS.length, 'no evidence step is pinned, so this suite would prove nothing').toBeGreaterThan(1);
    for (const ev of S4_EVIDENCE_STEPS) {
      const found = steps.filter((s) => (s.run ?? '').includes(ev.script));
      expect(found.length, `the required job does not run ${ev.label} exactly once`).toBe(1);
      const step = found[0];
      expect(step?.run?.trim()).toBe(ev.command);
      expect(step?.name).toBe(ev.name);
      expect(step?.continueOnError).toBe(false);
      expect(step?.conditional).toBe(false);
      // Relative to the gate, never a step number written down (P4-AL-88).
      expect((step?.index ?? -1) < (gate?.index ?? -1), `${ev.label} does not come before the gate step`).toBe(true);
    }
  });
});

describe('RP-CI-J — a measured step removed: planted red', () => {
  for (const ev of S4_EVIDENCE_STEPS)
    it(`red: ${ev.label} deleted from the required job is named`, () => {
      const mutated = workflowWith(`${ev.label} removed`, (lines) => {
        const [start, end] = stepBlock(lines, ev.command);
        return [...lines.slice(0, start), ...lines.slice(end)];
      });
      const problems = requiredCiProblems(mutated);
      expect(about(problems, 'no step')).not.toEqual([]);
      expect(problems.join('\n')).toContain('indistinguishable from a budget that passed');
    });
});

describe('RP-CI-K — continue-on-error on a measured step: planted red', () => {
  for (const ev of S4_EVIDENCE_STEPS)
    it(`red: continue-on-error on ${ev.label} is named, so a missed budget could not leave the job green`, () => {
      const mutated = workflowWith(`continue-on-error added to ${ev.label}`, (lines) => {
        const [start] = stepBlock(lines, ev.command);
        return [...lines.slice(0, start + 1), '        continue-on-error: true', ...lines.slice(start + 1)];
      });
      expect(about(requiredCiProblems(mutated), 'continue-on-error')).not.toEqual([]);
    });
});

describe('RP-CI-L — a condition on a measured step: planted red', () => {
  for (const ev of S4_EVIDENCE_STEPS)
    it(`red: an if: on ${ev.label} is named, because a measurement an ordinary push can skip is no measurement`, () => {
      const mutated = workflowWith(`an if: added to ${ev.label}`, (lines) => {
        const [start] = stepBlock(lines, ev.command);
        return [...lines.slice(0, start + 1), "        if: github.ref == 'refs/heads/main'", ...lines.slice(start + 1)];
      });
      expect(about(requiredCiProblems(mutated), 'conditional')).not.toEqual([]);
    });

  it('red: an `if: always()` is named too — a condition that reads as harmless is still a condition', () => {
    const ev = S4_EVIDENCE_STEPS[0];
    const mutated = workflowWith('an if: always() added to the measured budgets step', (lines) => {
      const [start] = stepBlock(lines, ev?.command ?? '');
      return [...lines.slice(0, start + 1), '        if: always()', ...lines.slice(start + 1)];
    });
    expect(about(requiredCiProblems(mutated), 'conditional')).not.toEqual([]);
  });
});

describe('RP-CI-M — a measured command weakened or renamed: planted red', () => {
  it('red: the budgets command given a filter is named, because a filtered run is not this measurement', () => {
    const ev = S4_EVIDENCE_STEPS[0];
    const mutated = workflowWith('the budgets command given a -t filter', (lines) =>
      lines.map((l) => (l.trim() === `run: ${ev?.command}` ? `${l} -- -t "P4-D"` : l)),
    );
    expect(about(requiredCiProblems(mutated), 'not exactly')).not.toEqual([]);
  });

  it('red: a renamed measured step is named, because the required job’s log is where the evidence is read', () => {
    const ev = S4_EVIDENCE_STEPS[0];
    const mutated = workflowWith('the measured budgets step renamed', (lines) => {
      const [start, end] = stepBlock(lines, ev?.command ?? '');
      return lines.map((l, i) => (i >= start && i < end && /^ {6}- name: /.test(l) ? '      - name: Extra checks' : l));
    });
    expect(about(requiredCiProblems(mutated), 'is named `Extra checks`')).not.toEqual([]);
  });

  it('red: a comment naming the budgets command is still named — the law parses, it does not grep', () => {
    const ev = S4_EVIDENCE_STEPS[0];
    const mutated = workflowWith('the measured budgets step replaced by a comment naming its command', (lines) => {
      const [start, end] = stepBlock(lines, ev?.command ?? '');
      return [...lines.slice(0, start), `      # run: ${ev?.command}  (temporarily disabled)`, ...lines.slice(end)];
    });
    expect(mutated).toContain(ev?.command ?? ''); // the string IS there: a grep would pass
    expect(about(requiredCiProblems(mutated), 'no step')).not.toEqual([]);
  });
});

describe('RP-CI-N — a measured step moved after the gate, or out of the required job: planted red', () => {
  it('red: the budgets step moved after the gate step is named — a failing step skips every step after it', () => {
    const ev = S4_EVIDENCE_STEPS[0];
    const mutated = workflowWith('the measured budgets step moved after the P4-S4 gate step', (lines) => {
      const [start, end] = stepBlock(lines, ev?.command ?? '');
      const block = lines.slice(start, end);
      const without = [...lines.slice(0, start), ...lines.slice(end)];
      const [, gateEnd] = stepBlock(without, S4_COMMAND);
      return [...without.slice(0, gateEnd), ...block, ...without.slice(gateEnd)];
    });
    expect(about(requiredCiProblems(mutated), 'does not come before')).not.toEqual([]);
  });

  it('red: the budgets step moved into a job nobody requires is named', () => {
    const ev = S4_EVIDENCE_STEPS[0];
    const mutated = workflowWith('the measured budgets step moved into another job', (lines) => {
      const [start, end] = stepBlock(lines, ev?.command ?? '');
      const block = lines.slice(start, end);
      const without = [...lines.slice(0, start), ...lines.slice(end)];
      const jobsKey = without.findIndex((l) => /^jobs:/.test(l));
      const steps = without.findIndex((l, i) => i > jobsKey && /^ {4}steps:/.test(l));
      expect(steps, 'no job before the required one has a steps sequence to move the step into').toBeGreaterThan(-1);
      return [...without.slice(0, steps + 1), ...block, ...without.slice(steps + 1)];
    });
    const problems = requiredCiProblems(mutated);
    expect(problems, 'the law did not refuse a workflow whose measured step left the required job').not.toEqual([]);
    expect(problems.join('\n')).toMatch(/not the required/);
  });
});

// ───── THE OTHER HALF OF A PINNED MEASUREMENT: THE NPM SCRIPT BODY ───────
// Pinning the workflow's `run:` to `npm run perf:phase4:s4` pins the NAME of
// the measurement, not the measurement. `package.json` resolves that name, and
// `.github/workflows/ci.yml` says nothing about it — so the same defect this
// file was written for lives one indirection down, and was reachable at the
// commit that closed the first level: adding `-t "P4-D"` to the script body
// left the workflow byte-identical, every assertion above green, and the P4-F
// budget unmeasured.
//
// Every plant below writes a MUTATED COPY of `package.json` into a temporary
// root. The checkout is never touched, and each mutation is required to have
// actually changed the text before its claim is asked.

/** A root carrying nothing but a `package.json` whose scripts are `scripts`. */
function rootWithScripts(scripts: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'p4s4-script-body-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'daftar', scripts }, null, 2), 'utf8');
  return dir;
}

/** The real manifest's scripts, which every plant below starts from. */
function realScripts(): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
  const scripts = parsed.scripts;
  if (scripts === undefined) throw new Error('package.json declares no scripts, so every plant below would be vacuous');
  return { ...scripts };
}

describe('P4-S4 — the measured steps that go through npm are pinned to a script BODY, not only to a name', () => {
  const PINNED = S4_EVIDENCE_STEPS.filter((e) => e.scriptBody !== undefined);

  it('at least one measured step goes through npm, so this whole section has a subject', () => {
    expect(PINNED.length, 'no measured step runs `npm run <script>`, so these plants would prove nothing').toBeGreaterThan(0);
    for (const ev of PINNED) expect(ev.command, `${ev.label} declares a body but does not run through npm`).toBe(`npm run ${ev.script}`);
  });

  it('the checkout passes the law, and every pinned script resolves to exactly its ruled body', () => {
    expect(evidenceScriptBodyProblems(REPO)).toEqual([]);
    const scripts = realScripts();
    for (const ev of PINNED) expect(String(scripts[ev.script]).trim(), `${ev.script} drifted from its ruled body`).toBe(ev.scriptBody);
  });

  it('RP-SB-A: a pinned script DELETED from package.json is caught — the required step would run nothing', () => {
    for (const ev of PINNED) {
      const scripts = realScripts();
      expect(scripts[ev.script], `${ev.script} is already absent, so this plant changes nothing`).toBeDefined();
      delete scripts[ev.script];
      const found = evidenceScriptBodyProblems(rootWithScripts(scripts));
      expect(
        found.some((m) => m.includes(ev.script) && m.includes('runs nothing')),
        `removing ${ev.script} left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-SB-B: a `-t` FILTER added inside the body is caught — the step is unchanged and one budget stops being measured', () => {
    for (const ev of PINNED) {
      const scripts = realScripts();
      const before = String(scripts[ev.script]);
      scripts[ev.script] = `${before} -t "P4-D"`;
      expect(scripts[ev.script], 'the plant did not change the body').not.toBe(before);
      const found = evidenceScriptBodyProblems(rootWithScripts(scripts));
      expect(
        found.some((m) => m.includes(ev.script)),
        `a -t filter inside ${ev.script} left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-SB-C: the body pointed at ANOTHER suite file is caught', () => {
    for (const ev of PINNED) {
      const scripts = realScripts();
      scripts[ev.script] = 'vitest run tests/performance/plan-evidence-contract.test.ts';
      const found = evidenceScriptBodyProblems(rootWithScripts(scripts));
      expect(
        found.some((m) => m.includes(ev.script)),
        `repointing ${ev.script} left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-SB-D: a body that is not a string at all is caught, rather than crashing the gate', () => {
    for (const ev of PINNED) {
      const scripts = realScripts();
      scripts[ev.script] = ['vitest', 'run'];
      const found = evidenceScriptBodyProblems(rootWithScripts(scripts));
      expect(
        found.some((m) => m.includes(ev.script) && m.includes('undecidable')),
        `a non-string ${ev.script} left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-SB-E: a root with no package.json, and one whose package.json does not parse, are both findings', () => {
    const empty = mkdtempSync(join(tmpdir(), 'p4s4-script-body-none-'));
    expect(evidenceScriptBodyProblems(empty).join(' | ')).toContain('package.json is missing');
    const broken = mkdtempSync(join(tmpdir(), 'p4s4-script-body-broken-'));
    writeFileSync(join(broken, 'package.json'), '{ "scripts": ', 'utf8');
    expect(evidenceScriptBodyProblems(broken).join(' | ')).toContain('does not parse');
  });
});

// ───── WHAT THE MEASURED STEP EXECUTES, AND WHERE A ROSTERED SUITE LIVES ──
// Two laws below the two above, each found by attacking this file rather than
// by reading it. The step is pinned and its npm body is pinned, and a
// `describe.skip(` inside the suite, an `exclude` plus `passWithNoTests` in
// the root config, or a `pre<script>` hook still deletes the measurement with
// every other check silent. And the roster is derived by basename with no
// floor on WHERE the file is, so moving a rostered suite out of every runner
// directory drops it from the roster and from CI at once.

/** A root carrying a copy of the real manifest, config and evidence suites, with `mutate` applied. */
function rootWithTree(mutate: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'p4s4-evidence-'));
  writeFileSync(join(dir, 'package.json'), readFileSync(join(REPO, 'package.json'), 'utf8'), 'utf8');
  writeFileSync(join(dir, 'vitest.config.ts'), readFileSync(join(REPO, 'vitest.config.ts'), 'utf8'), 'utf8');
  mkdirSync(join(dir, 'tests', 'performance'), { recursive: true });
  for (const ev of S4_EVIDENCE_STEPS) writeFileSync(join(dir, ev.suite), readFileSync(join(REPO, ev.suite), 'utf8'), 'utf8');
  mutate(dir);
  return dir;
}

describe('P4-S4 — the measured steps are judged by what they EXECUTE', () => {
  it('the checkout passes, and every evidence step names a suite that is in the tree', () => {
    expect(evidenceIntegrityProblems(REPO)).toEqual([]);
    for (const ev of S4_EVIDENCE_STEPS) expect(readFileSync(join(REPO, ev.suite), 'utf8').length, `${ev.suite} is empty`).toBeGreaterThan(0);
  });

  it('a copied tree with nothing mutated still passes, so every plant below is about the plant', () => {
    expect(evidenceIntegrityProblems(rootWithTree(() => undefined))).toEqual([]);
  });

  it('RP-EI-A: `describe.skip(` inside a measured suite is caught', () => {
    for (const ev of S4_EVIDENCE_STEPS) {
      const found = evidenceIntegrityProblems(
        rootWithTree((dir) => {
          const text = readFileSync(join(dir, ev.suite), 'utf8');
          const mutated = text.replace('describe(', 'describe.skip(');
          expect(mutated, `${ev.suite} holds no describe( to skip`).not.toBe(text);
          writeFileSync(join(dir, ev.suite), mutated, 'utf8');
        }),
      );
      expect(
        found.some((m) => m.includes(ev.suite) && m.includes('indistinguishable')),
        `a skipped block in ${ev.suite} left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-EI-B: `it.only(` and `it.todo(` inside a measured suite are caught too', () => {
    for (const marker of ['it.only(', 'it.todo(']) {
      const ev = S4_EVIDENCE_STEPS[0];
      if (ev === undefined) throw new Error('no evidence step, so this plant is vacuous');
      const found = evidenceIntegrityProblems(
        rootWithTree((dir) => {
          const text = readFileSync(join(dir, ev.suite), 'utf8');
          // At a line start, so the replacement is a real `it(` call and not
          // the tail of a word like `limit(` — where `\b` would correctly
          // refuse to match and the plant would be about nothing.
          const mutated = text.replace(/\n(\s*)it\(/, `\n$1${marker}`);
          expect(mutated, `${ev.suite} holds no it( at a line start to mark`).not.toBe(text);
          writeFileSync(join(dir, ev.suite), mutated, 'utf8');
        }),
      );
      expect(
        found.some((m) => m.includes(ev.suite)),
        `${marker} left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-EI-C: a measured suite DELETED from the tree is caught', () => {
    for (const ev of S4_EVIDENCE_STEPS) {
      const dir = mkdtempSync(join(tmpdir(), 'p4s4-evidence-none-'));
      writeFileSync(join(dir, 'package.json'), readFileSync(join(REPO, 'package.json'), 'utf8'), 'utf8');
      writeFileSync(join(dir, 'vitest.config.ts'), readFileSync(join(REPO, 'vitest.config.ts'), 'utf8'), 'utf8');
      const found = evidenceIntegrityProblems(dir);
      expect(
        found.some((m) => m.includes(ev.suite) && m.includes('would run nothing')),
        `a missing ${ev.suite} left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-EI-D: a `pre<script>` npm hook around a pinned script is caught', () => {
    const ev = S4_EVIDENCE_STEPS.find((e) => e.scriptBody !== undefined);
    if (ev === undefined) throw new Error('no pinned script, so this plant is vacuous');
    const found = evidenceIntegrityProblems(
      rootWithTree((dir) => {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
        manifest.scripts[`pre${ev.script}`] = 'echo rewriting the config the measurement reads';
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
      }),
    );
    expect(
      found.some((m) => m.includes(`pre${ev.script}`)),
      `a pre hook left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-EI-E: `passWithNoTests: true` and an `exclude` in the root config are both caught', () => {
    const withPass = evidenceIntegrityProblems(
      rootWithTree((dir) => {
        const cfg = readFileSync(join(dir, 'vitest.config.ts'), 'utf8').replace('maxWorkers: 1,', 'maxWorkers: 1,\n    passWithNoTests: true,');
        writeFileSync(join(dir, 'vitest.config.ts'), cfg, 'utf8');
      }),
    );
    expect(withPass.join(' | ')).toContain('passWithNoTests');
    const withExclude = evidenceIntegrityProblems(
      rootWithTree((dir) => {
        const cfg = readFileSync(join(dir, 'vitest.config.ts'), 'utf8').replace(
          "include: ['tests/**/*.test.ts'],",
          "include: ['tests/**/*.test.ts'],\n    exclude: ['tests/performance/**'],",
        );
        writeFileSync(join(dir, 'vitest.config.ts'), cfg, 'utf8');
      }),
    );
    expect(withExclude.join(' | ')).toContain('exclude');
  });
});

describe('P4-S4 — every rostered suite is in a directory the runner runs', () => {
  it('the checkout passes', () => {
    expect(rosterRunnerProblems(REPO)).toEqual([]);
  });

  it('RP-RR-A: a rostered suite in a directory no `test*` script runs is caught', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p4s4-roster-runner-'));
    writeFileSync(join(dir, 'package.json'), readFileSync(join(REPO, 'package.json'), 'utf8'), 'utf8');
    mkdirSync(join(dir, 'tests', 'performance'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'performance', 'p4s4-moved-out-of-ci.test.ts'), "import { it } from 'vitest';\nit('x', () => undefined);\n", 'utf8');
    const found = rosterRunnerProblems(dir);
    expect(
      found.some((m) => m.includes('tests/performance/p4s4-moved-out-of-ci.test.ts') && m.includes('out of CI')),
      `a rostered suite outside every runner directory left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-RR-B: a manifest whose `test*` scripts name no `tests/` directory makes the law say so rather than pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p4s4-roster-runner-none-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo nothing' } }, null, 2), 'utf8');
    expect(rosterRunnerProblems(dir).join(' | ')).toContain('would be vacuous');
  });
});
