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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_SUBDIR } from '../../scripts/guards/phase4-rls-force';
import {
  CI_COMPOSITION_SUITE,
  REQUIRED_JOB,
  S3_SCRIPT,
  S4_COMMAND,
  S4_EVIDENCE_STEPS,
  S4_GOLDEN_DIR,
  S4_SCRIPT,
  S4_STEP_NAME,
  WORKFLOW,
  candidateMigrations,
  evidenceCoverageProblems,
  evidenceIntegrityProblems,
  evidenceScriptBodyProblems,
  measuredCandidateSuites,
  readWorkflow,
  requiredJobReach,
  workflowNamedSuites,
  rosterFiles,
  rosterProblems,
  rosterRatchetProblems,
  describeBlocks,
  rosterRedProofProblems,
  rosterRunnerProblems,
  rosterSuiteKind,
  requiredCiProblems,
  ROSTER_FLOOR,
  ROSTER_RECORDED,
  EVIDENCE_FLOOR,
  rosterBijectionProblems,
  rosterRowTitles,
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
/** The gate's own prose-stripping, mirrored here so a proof can assert its plant survived it. */
const stripProseForProof = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

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

  // The plant must land on a block the RUNNER EXECUTES, not on prose. A plain
  // `text.replace('describe(', 'describe.skip(')` replaced the FIRST occurrence
  // in the file, and in `receivables-s4-budgets.test.ts` that is the literal
  // `describe('P4-D …')` inside its own doc comment at line 98 — a thousand
  // lines above the first executed block at 1120. The law fired on the comment
  // and the proof proved nothing. So the plant is anchored at a LINE START and
  // the canary below asserts the mutation really changed the executed shape.

  /** The measured suite's text with its FIRST column-0 `describe(` turned into `marker`, and the plant verified to have moved executed code. */
  function skipTheFirstExecutedBlock(text: string, suite: string, marker: string): string {
    const lines = text.split('\n');
    const at = lines.findIndex((l) => /^describe\s*\(/.test(l));
    expect(at, `${suite} holds no top-level describe( at a line start, so this plant has nothing to mutate`).toBeGreaterThan(-1);
    // THE CANARY: the line being mutated must be executed code, not prose. It
    // is a line start, and it is not inside a block comment — which is checked
    // by counting unterminated `/*` openers above it.
    const above = lines.slice(0, at).join('\n');
    const opens = (above.match(/\/\*/g) ?? []).length;
    const closes = (above.match(/\*\//g) ?? []).length;
    expect(opens, `${suite}: the line chosen for the plant sits inside an unterminated block comment, so the plant would mutate PROSE`).toBe(closes);
    expect(lines[at]?.startsWith(' '), `${suite}: the chosen line is indented, so it is not a top-level block`).toBe(false);
    const mutated = [...lines.slice(0, at), (lines[at] ?? '').replace(/^describe\s*\(/, marker), ...lines.slice(at + 1)].join('\n');
    expect(mutated, `${suite}: the plant "${marker}" changed nothing, so the proof would prove nothing`).not.toBe(text);
    // And the canary that distinguishes this from the vacuous version: the
    // mutation must survive comment-stripping, which is what the law reads.
    expect(
      stripProseForProof(mutated),
      `${suite}: the plant vanishes when comments are stripped, so it landed in PROSE and the law would be firing on a comment`,
    ).not.toBe(stripProseForProof(text));
    return mutated;
  }

  it('RP-EI-A: `describe.skip(` on an EXECUTED block of a measured suite is caught, and the plant is shown not to be prose', () => {
    for (const ev of S4_EVIDENCE_STEPS) {
      const found = evidenceIntegrityProblems(
        rootWithTree((dir) => {
          const text = readFileSync(join(dir, ev.suite), 'utf8');
          writeFileSync(join(dir, ev.suite), skipTheFirstExecutedBlock(text, ev.suite, 'describe.skip('), 'utf8');
        }),
      );
      expect(
        found.some((m) => m.includes(ev.suite) && m.includes('indistinguishable')),
        `a skipped EXECUTED block in ${ev.suite} left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-EI-A2: the same marker written in a COMMENT is NOT a finding — the law reads code, not prose', () => {
    // The other half of the same correction. Before it, a doc comment that
    // merely MENTIONED `describe.skip(` reddened an honest tree; and that is
    // why the old RP-EI-A passed over a mutation to line 98.
    for (const ev of S4_EVIDENCE_STEPS) {
      const found = evidenceIntegrityProblems(
        rootWithTree((dir) => {
          const text = readFileSync(join(dir, ev.suite), 'utf8');
          const prose = `/**\n * A comment that names describe.skip( and it.only( and nothing else.\n */\n${text}`;
          expect(prose).not.toBe(text);
          writeFileSync(join(dir, ev.suite), prose, 'utf8');
        }),
      );
      expect(
        found.some((m) => m.includes(ev.suite) && m.includes('indistinguishable')),
        `a comment that only NAMES a skip marker was reported as a skipped block in ${ev.suite}: ${found.join(' | ')}`,
      ).toBe(false);
    }
  });

  it('RP-EI-A3: the four skip spellings that walked through the old regexes are each caught', () => {
    // Each of these really skips the block and matched none of the three
    // regexes this law used to carry: the subject is now the MEMBER ACCESS,
    // however it is spelled and whatever is done with it afterwards.
    const spellings: readonly (readonly [string, string])[] = [
      ["describe['skip'](", 'a bracketed member access'],
      ['describe.skipIf(true)(', 'a conditional skip whose `skip` is not followed by `(`'],
      ['describe.runIf(false)(', 'a conditional run the old regexes never mentioned'],
      ['describe.concurrent.skip(', 'a skip behind an intermediate modifier'],
    ];
    const ev = S4_EVIDENCE_STEPS[0];
    if (ev === undefined) throw new Error('no evidence step, so this plant is vacuous');
    for (const [marker, why] of spellings) {
      const found = evidenceIntegrityProblems(
        rootWithTree((dir) => {
          const text = readFileSync(join(dir, ev.suite), 'utf8');
          writeFileSync(join(dir, ev.suite), plantOnTheFirstExecutedBlock(text, ev.suite, marker), 'utf8');
        }),
      );
      expect(
        found.some((m) => m.includes(ev.suite) && m.includes('indistinguishable')),
        `${marker} (${why}) left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-EI-A4: a skip marker BOUND TO A NAME before it is called is caught — the call site is not the member access', () => {
    const ev = S4_EVIDENCE_STEPS[0];
    if (ev === undefined) throw new Error('no evidence step, so this plant is vacuous');
    const found = evidenceIntegrityProblems(
      rootWithTree((dir) => {
        const text = readFileSync(join(dir, ev.suite), 'utf8');
        const lines = text.split('\n');
        const at = lines.findIndex((l) => /^describe\s*\(/.test(l));
        expect(at, 'no top-level describe( to defer').toBeGreaterThan(-1);
        const mutated = [
          ...lines.slice(0, at),
          'const deferred = describe.skip;',
          (lines[at] ?? '').replace(/^describe\s*\(/, 'deferred('),
          ...lines.slice(at + 1),
        ].join('\n');
        expect(mutated).not.toBe(text);
        writeFileSync(join(dir, ev.suite), mutated, 'utf8');
      }),
    );
    expect(
      found.some((m) => m.includes(ev.suite) && m.includes('indistinguishable')),
      `\`const deferred = describe.skip;\` then \`deferred(…)\` left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-EI-A5: a runner config that COMPUTES its options is a finding, because `exclude` is judged as text', () => {
    // `const S = JSON.parse('{"exclude":[…],"passWithNoTests":true}')` then
    // `{ ...S }` carries neither `exclude:` nor `passWithNoTests: true`
    // anywhere in the file, so every text regex above is silent while
    // `vitest run tests/performance/…` collects nothing and exits 0.
    const hidden =
      "import { defineConfig } from 'vitest/config';\n" +
      'const S = JSON.parse(\'{"exclude":["tests/performance/**"],"passWithNoTests":true}\');\n' +
      "export default defineConfig({ test: { ...S, include: ['tests/**/*.test.ts'] } });\n";
    expect(/\bexclude\s*:/.test(hidden), 'the plant still states `exclude:` in text, so it would prove nothing').toBe(false);
    expect(/passWithNoTests\s*:\s*true/.test(hidden), 'the plant still states `passWithNoTests: true` in text').toBe(false);
    const found = evidenceIntegrityProblems(rootWithTree((dir) => writeFileSync(join(dir, 'vitest.config.ts'), hidden, 'utf8')));
    expect(
      found.some((m) => m.includes('vitest.config.ts') && m.includes('a computed option satisfies neither regex')),
      `a config that hides its options from the two text regexes left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-EI-F red: deleting a measured suite’s MEASUREMENT cases for one budget is named', () => {
    // The hole: the step runs, the file is present, the body is pinned and
    // nothing is skipped — and the budget is simply no longer measured.
    const ev = S4_EVIDENCE_STEPS[0];
    if (ev === undefined) throw new Error('no evidence step, so this plant is vacuous');
    const ids = [...new Set([...`${ev.label} ${ev.name}`.matchAll(/\bP4-[A-Z](?:-[A-Z]+)?\b/g)].map((m) => m[0]))];
    expect(ids.length, `${ev.label} cites no budget id, so this plant has no subject`).toBeGreaterThan(0);
    for (const id of ids) {
      const found = evidenceIntegrityProblems(
        rootWithTree((dir) => {
          const text = readFileSync(join(dir, ev.suite), 'utf8');
          // Every RUNNABLE title naming this budget is turned into a title that
          // does not name it. Nothing else about the file changes: it is still
          // present, still unskipped, still named by the pinned body.
          const stripped = text.replace(new RegExp(id.replace(/[-]/g, '[-]'), 'g'), 'THE-BUDGET-FORMERLY-NAMED');
          expect(stripped, `${ev.suite} does not name ${id}, so this plant would prove nothing`).not.toBe(text);
          writeFileSync(join(dir, ev.suite), stripped, 'utf8');
        }),
      );
      expect(
        found.some((m) => m.includes(ev.suite) && m.includes(`no RUNNABLE it( title naming ${id}`)),
        `deleting every ${id} measurement case left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
  });

  it('RP-EI-G red: a measurement case that is merely SKIPPED does not satisfy the measurement law either', () => {
    // `testTitles` reads only runnable titles, so this composes with the skip
    // law rather than duplicating it: a `.skip`-ed MEASUREMENT is both a skip
    // marker and an absent measurement, and both halves must name it.
    const ev = S4_EVIDENCE_STEPS[0];
    if (ev === undefined) throw new Error('no evidence step, so this plant is vacuous');
    const found = evidenceIntegrityProblems(
      rootWithTree((dir) => {
        const text = readFileSync(join(dir, ev.suite), 'utf8');
        const mutated = text.replace(/\bit\(/g, 'it.skip(');
        expect(mutated, `${ev.suite} holds no it( to skip`).not.toBe(text);
        writeFileSync(join(dir, ev.suite), mutated, 'utf8');
      }),
    );
    expect(
      found.some((m) => m.includes(ev.suite) && m.includes('no RUNNABLE it( title naming')),
      `a suite whose every measurement case is skipped was still judged to hold its measurements: ${found.join(' | ')}`,
    ).toBe(true);
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

// ─────────────────────────────────────────────────────────────────────────
// GAP V2 — EVERY ROSTERED FILE CARRIES THE PROOF ITS KIND OWES.
//
// `rosterRedProofProblems` applied its real half only where `isLaw(file)` was
// true, and that predicate was `file.startsWith('tests/guards/')`. Measured on
// this roster: 9 of 26 files held to a planted-defect proof, the other 17 held
// to nothing but "holds at least one runnable `it(` title" — the security
// suite this slice's own corrective commit was about among them. And for the 9,
// a single title carrying the word `red` satisfied the whole file.
//
// The plants below are the proof that the three obligations the law now states
// each go red on their own violation, and that the SCOPE is derived: a law
// moved out of `tests/guards/` is still held to the law half.
//
// Every plant writes a MUTATED ROSTER into a temporary root. The checkout is
// never touched. Each root carries the CI-composition suite the roster rule
// names unconditionally, so no plant's finding can be that row's absence.

/** A root whose roster is exactly `files`, plus the named CI-composition row. */
function rootWithRoster(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'p4s4-red-proof-'));
  const all: Record<string, string> = {
    // The one named row, written as a law that satisfies every obligation, so
    // it is never what a plant below is reported for.
    [CI_COMPOSITION_SUITE]:
      "import { readFileSync } from 'node:fs';\n" +
      "import { expect, it } from 'vitest';\n" +
      "it('red: the planted defect is refused', () => {\n" +
      "  expect(readFileSync('/dev/null', 'utf8')).not.toEqual([]);\n" +
      '});\n',
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(join(dir, rel.slice(0, rel.lastIndexOf('/'))), { recursive: true });
    writeFileSync(join(dir, rel), text, 'utf8');
  }
  return dir;
}

const A_TREE_READ = "import { readFileSync } from 'node:fs';\n";
const AN_IMPORT_OF_THE_GATE = "import { requiredCiProblems } from '../../scripts/phase4-s4-gate';\n";

describe('P4-S4 — every rostered file carries the falsifiability proof its KIND owes', () => {
  it('the checkout passes, and the pass is about a roster of all three kinds and not an empty read', () => {
    expect(rosterRedProofProblems(REPO)).toEqual([]);
    const kinds = rosterFiles(REPO).map((f) => rosterSuiteKind(readFileSync(join(REPO, f), 'utf8'), f));
    // FLOORS, never equalities: a later slice adds suites of every kind.
    expect(kinds.filter((k) => k === 'law').length, 'the roster holds no law, so the law half judged nothing').toBeGreaterThan(0);
    expect(kinds.filter((k) => k === 'golden').length, 'the roster holds no golden suite, so the golden half judged nothing').toBeGreaterThan(0);
    expect(kinds.filter((k) => k === 'behaviour').length, 'the roster holds no behaviour suite, so the universal floor judged only laws').toBeGreaterThan(0);
  });

  it('the derived scope is WIDER than the directory rule it replaced: the tree-reading security suite is a law', () => {
    const file = 'tests/security/p4s4-rls-quals-once-per-query.test.ts';
    expect(rosterFiles(REPO), 'the security suite is not on the roster, so this claim has no subject').toContain(file);
    // The predicate it replaced was `file.startsWith('tests/guards/')`, which
    // this file does not satisfy. The derived one judges what it READS.
    expect(file.startsWith('tests/guards/')).toBe(false);
    expect(rosterSuiteKind(readFileSync(join(REPO, file), 'utf8'), file)).toBe('law');
  });

  it('RP-RP-A red: a block with the WORD "red" in a title and no executed refusal is refused (the exact hole closed)', () => {
    const planted =
      AN_IMPORT_OF_THE_GATE +
      "import { describe, expect, it } from 'vitest';\n" +
      // Prose announcing a plant, and an assertion of SILENCE only. Under the
      // old law the title alone satisfied the whole file.
      "describe('PLANTED: the law refuses the plant', () => {\n" +
      "  it('red: the planted defect is refused', () => {\n" +
      "    expect(requiredCiProblems('')).toEqual([]);\n" +
      '  });\n' +
      '});\n';
    const dir = rootWithRoster({ 'tests/guards/p4s4-prose-only-law.test.ts': planted });
    const found = rosterRedProofProblems(dir);
    expect(
      found.some((m) => m.includes('p4s4-prose-only-law.test.ts') && m.includes('never once executed its refusal')),
      `a block that announces a red in prose and only ever asserts silence left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-RP-A2 red: ONE block that executes a red does NOT satisfy a second block that announces one — the subject is the BLOCK', () => {
    // The hole the challenger measured on `p4s4-command-refusal-audit-law.test.ts`:
    // 15 titles of which one matched, passing exactly as 15 of 15 would. The
    // first block below is a real planted-defect proof; the second announces a
    // plant and asserts only silence. A file-level law sees one red and stops.
    const planted =
      AN_IMPORT_OF_THE_GATE +
      "import { describe, expect, it } from 'vitest';\n" +
      "describe('PLANTED: the first plant really is refused', () => {\n" +
      "  it('red: the empty workflow is refused', () => {\n" +
      "    expect(requiredCiProblems('')).not.toEqual([]);\n" +
      '  });\n' +
      '});\n' +
      "describe('PLANTED: the second plant is announced and never executed', () => {\n" +
      "  it('red: the second planted defect is refused', () => {\n" +
      "    expect(requiredCiProblems('')).toEqual([]);\n" +
      '  });\n' +
      '});\n';
    const rel = 'tests/guards/p4s4-two-blocks-one-red.test.ts';
    const dir = rootWithRoster({ [rel]: planted });
    const blocks = describeBlocks(planted);
    expect(blocks.length, 'the plant does not hold two top-level blocks, so it would prove nothing').toBe(2);
    const found = rosterRedProofProblems(dir);
    // The FIRST block is not named; only the second is. That is the whole
    // difference between a file-level and a block-level subject.
    expect(found.filter((m) => m.includes(rel)).length, `expected exactly the second block to be named: ${found.join(' | ')}`).toBe(1);
    expect(
      found.some((m) => m.includes('the second plant is announced and never executed') && m.includes('never once executed its refusal')),
      `the unexecuted second block was not named: ${found.join(' | ')}`,
    ).toBe(true);
    expect(
      found.some((m) => m.includes('the first plant really is refused')),
      'the block that DOES execute its red was named, so the law is refusing something correct',
    ).toBe(false);
  });

  it('RP-RP-B red: a law OUTSIDE the guard directory with no planted-defect title is refused, which the directory rule alone could not do', () => {
    const planted =
      A_TREE_READ +
      "import { expect, it } from 'vitest';\n" +
      "it('the reader returns rows', () => {\n" +
      "  expect(readFileSync('/dev/null', 'utf8')).not.toEqual([]);\n" +
      '});\n';
    const rel = 'tests/integration/p4s4-tree-reading-law.test.ts';
    const dir = rootWithRoster({ [rel]: planted });
    // The predicate that was there before was ONLY the directory, and this
    // file does not satisfy it, so the whole law half was skipped for it.
    expect(rel.startsWith('tests/guards/')).toBe(false);
    expect(rosterSuiteKind(planted, rel)).toBe('law');
    const found = rosterRedProofProblems(dir);
    expect(
      found.some((m) => m.includes(rel) && m.includes('no it( title announces a planted defect')),
      `a tree-reading law outside the guard directory was held to nothing: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-RP-C: the guard directory is kept as a FLOOR, so a guard that reads nothing is still a law', () => {
    // The union matters in BOTH directions. A file an author put in the guard
    // directory declares itself a guard even before it reads a byte, and the
    // derived property must not narrow the old scope while widening it.
    const planted = "import { expect, it } from 'vitest';\nit('the scratch law holds', () => expect(2 + 2).toBe(4));\n";
    const rel = 'tests/guards/p4s4-reads-nothing.test.ts';
    expect(rosterSuiteKind(planted, rel), 'a file in the guard directory stopped being a law, which NARROWS the old scope').toBe('law');
    const found = rosterRedProofProblems(rootWithRoster({ [rel]: planted }));
    expect(
      found.some((m) => m.includes(rel) && m.includes('no it( title announces a planted defect')),
      `a guard that reads nothing was held to nothing: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-RP-D red: a golden suite that asserts no floor on its own recorded world is refused', () => {
    const planted =
      "import { expect, it } from 'vitest';\n" +
      // A golden comparison and a negation, so the universal floor is met and
      // the finding can only be the golden one: nothing shows the recorded
      // world is there, so this compares nothing to nothing.
      "it('the recorded world still holds', () => {\n" +
      '  const rows: unknown[] = [];\n' +
      '  expect(rows).toEqual([...rows]);\n' +
      '  expect(rows).not.toBe(null);\n' +
      '});\n';
    const rel = `${S4_GOLDEN_DIR}/99-vacuous.golden.test.ts`;
    const dir = rootWithRoster({ [rel]: planted });
    expect(rosterSuiteKind(planted, rel)).toBe('golden');
    const found = rosterRedProofProblems(dir);
    expect(
      found.some((m) => m.includes(rel) && m.includes('compares nothing to nothing')),
      `a golden suite with no floor on its subject left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-RP-E red: a rostered file the runner opens and finds nothing in is still refused', () => {
    const rel = 'tests/integration/p4s4-no-titles.test.ts';
    const dir = rootWithRoster({ [rel]: "import { expect } from 'vitest';\nexport const nothing = expect;\n" });
    expect(rosterRedProofProblems(dir).join(' | ')).toContain('holds no runnable it( title');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GAP V3 — THE EVIDENCE TABLE'S MEMBERSHIP IS CROSS-CHECKED AGAINST THE TREE.
//
// `S4_EVIDENCE_STEPS` is the whole subject of `required-ci`,
// `evidence-script-bodies` and `evidence-integrity`, and the only floor on it
// was that it holds at least one row. A slice that adds a third measured suite
// and forgets the row got three green checks over two steps.
//
// The pins themselves cannot be derived — deriving the step name from the
// workflow would make `required-ci` judge the workflow against itself. The
// MEMBERSHIP can be, and is: a runnable test file in the table's own
// directories whose text names a CANDIDATE MIGRATION. These plants prove that
// derivation goes red in both directions and refuses to be vacuous.

/** A root carrying the real manifest, workflow and migration NAMES, with `mutate` applied. */
function rootWithEvidence(mutate: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'p4s4-evidence-coverage-'));
  writeFileSync(join(dir, 'package.json'), readFileSync(join(REPO, 'package.json'), 'utf8'), 'utf8');
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, WORKFLOW), WORKFLOW_TEXT, 'utf8');
  // Only the NAMES of the migrations matter to `candidateMigrations`, so the
  // bodies are not copied: the derivation reads the file names off disk and the
  // accepted head off the permanent prefix module.
  mkdirSync(join(dir, MIGRATIONS_SUBDIR), { recursive: true });
  for (const name of readdirSync(join(REPO, MIGRATIONS_SUBDIR))) if (name.endsWith('.sql')) writeFileSync(join(dir, MIGRATIONS_SUBDIR, name), '', 'utf8');
  mkdirSync(join(dir, 'tests', 'performance'), { recursive: true });
  for (const ev of S4_EVIDENCE_STEPS) writeFileSync(join(dir, ev.suite), readFileSync(join(REPO, ev.suite), 'utf8'), 'utf8');
  mutate(dir);
  return dir;
}

/** A candidate migration's number, so a plant can name one without this file writing one down. */
function aCandidateNumber(root: string): string {
  const candidates = candidateMigrations(root);
  expect(candidates.length, 'no candidate migration is on disk, so every plant below would be vacuous').toBeGreaterThan(0);
  const number = /^(\d+)/.exec(candidates[0] ?? '')?.[1];
  expect(number, `the candidate ${String(candidates[0])} does not begin with a number`).toBeDefined();
  return number ?? '';
}

describe("P4-S4 — the evidence table's MEMBERSHIP is derived from the tree, not taken on trust", () => {
  it('the derivation and the table are now EQUAL — the gap this law was written for is closed, and the law that closed it stands', () => {
    const derived = measuredCandidateSuites(REPO);
    // FLOORS: the derivation only grows as the slice adds measurements.
    expect(derived.length, 'the derivation found no measured suite, so the cross-check would be vacuous').toBeGreaterThan(0);
    for (const ev of S4_EVIDENCE_STEPS) expect(derived, `${ev.suite} is a table row the derivation does not find`).toContain(ev.suite);
    // THE FINDING, AND ITS CLOSURE. When this law was written the derivation
    // was a strict SUPERSET of the table: `receivables-open-page-equivalence`
    // — `0084`'s own correctness evidence, 40 KB of it — was in no row of the
    // table, in no step of the required job, and in no `test*` script CI runs,
    // so it had never been executed anywhere. The law found it; reading the
    // workflow had not. It is now a table row AND a step of the required job,
    // and what this case asserts is therefore the EQUALITY rather than the
    // gap. The gap's falsifiability lives on in `RP-EC-A` and `RP-EC-B`, which
    // plant a measured suite the table does not name and a table row the
    // workflow does not run, and require the cross-check to name each.
    const unnamed = derived.filter((f) => !S4_EVIDENCE_STEPS.some((e) => e.suite === f));
    expect(unnamed, 'the derivation finds a measured suite of this slice that the table does not name').toEqual([]);
    expect(evidenceCoverageProblems(REPO), 'the cross-check refuses this tree').toEqual([]);
  });

  it('RP-EC-A red: a measured suite added to the tree and NOT added to the table is named', () => {
    const dir = rootWithEvidence((d) => {
      const number = aCandidateNumber(d);
      writeFileSync(
        join(d, 'tests', 'performance', 'receivables-s4-third-budget.test.ts'),
        `// the ${number} budget\nimport { expect, it } from 'vitest';\nit('red: the third budget is measured', () => expect([1]).not.toEqual([]));\n`,
        'utf8',
      );
    });
    const found = evidenceCoverageProblems(dir);
    expect(
      found.some((m) => m.includes('receivables-s4-third-budget.test.ts') && m.includes('does not name it')),
      `a third measured suite the table does not name left the cross-check silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-EC-B red: a measured suite no step of the required job reaches is named, even when the table DOES name it', () => {
    // The table's own first row, with every step that could reach it removed
    // from the required job. The table is unchanged, so the only finding
    // available is the reachability one.
    const row = S4_EVIDENCE_STEPS[0];
    expect(row, 'the table is empty, so this plant has no subject').toBeDefined();
    const dir = rootWithEvidence((d) => {
      const stripped = workflowWith(`every step reaching ${row?.suite ?? ''} removed`, (lines) => {
        const [start, end] = stepBlock(lines, row?.command ?? '');
        return [...lines.slice(0, start), ...lines.slice(end)];
      });
      writeFileSync(join(d, WORKFLOW), stripped, 'utf8');
    });
    const found = evidenceCoverageProblems(dir);
    expect(
      found.some((m) => m.includes(row?.suite ?? '') && m.includes(`NO step of the required \`${REQUIRED_JOB}\` job reaches it`)),
      `a measured suite the required job no longer reaches left the cross-check silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-EC-C red: a table row whose suite the derivation cannot find takes the derivation below its FLOOR and is named', () => {
    // This asserted the arm that compared the table with the derivation by
    // EQUALITY — "a row the derivation does not find" — and that arm is gone:
    // an accepted gate holding an equality refuses every later tree, and the
    // acceptance commit moves the derivation's own subject. The defect is
    // still refused, by the floor the equality was replaced with: a
    // measurement that stops being attributed to this slice takes the derived
    // count below EVIDENCE_FLOOR, which an EXTRA row never does.
    const row = S4_EVIDENCE_STEPS[0];
    const dir = rootWithEvidence((d) => {
      // The suite is still there and still runnable; it just no longer names
      // any candidate migration, so the derivation does not attribute it to
      // this slice and the row's pins guard nothing.
      writeFileSync(join(d, row?.suite ?? ''), "import { expect, it } from 'vitest';\nit('nothing of this slice', () => expect(1).toBe(1));\n", 'utf8');
    });
    expect(measuredCandidateSuites(dir), 'the suite is still derived, so the plant did not reproduce the loss').not.toContain(row?.suite ?? '');
    const found = evidenceCoverageProblems(dir);
    expect(
      found.some((m) => m.includes('the accepted floor is')),
      `a measurement that stopped being attributed to this slice left the cross-check silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-EC-D red: a tree with no candidate migration makes the cross-check SAY it is vacuous rather than pass', () => {
    const dir = rootWithEvidence((d) => {
      for (const name of readdirSync(join(d, MIGRATIONS_SUBDIR))) rmSync(join(d, MIGRATIONS_SUBDIR, name));
    });
    expect(candidateMigrations(dir), 'the migrations were not really removed, so this plant would prove nothing').toEqual([]);
    expect(evidenceCoverageProblems(dir).join(' | ')).toContain('would be vacuous');
  });

  it('RP-EC-E red: a measured suite in a directory the required job reaches only through a `test*` script is NOT a finding', () => {
    // The reachability half reads npm script BODIES, not only `run:` lines. A
    // suite under a directory a `test*` script covers is reached, and must not
    // be reported as unrun — otherwise the law would refuse every integration
    // suite the moment one named a candidate migration.
    const dir = rootWithEvidence((d) => {
      const number = aCandidateNumber(d);
      mkdirSync(join(d, 'tests', 'guards'), { recursive: true });
      writeFileSync(
        join(d, 'tests', 'guards', 'p4s4-reached-by-script.test.ts'),
        `// the ${number} relations\nimport { expect, it } from 'vitest';\nit('red: reached', () => expect([1]).not.toEqual([]));\n`,
        'utf8',
      );
    });
    const reach = requiredJobReach(dir);
    expect(reach.dirs, 'the required job reaches no `tests/` directory through any npm script body').toContain('tests/guards');
    expect(
      evidenceCoverageProblems(dir).some((m) => m.includes('p4s4-reached-by-script.test.ts') && m.includes('NO step of the required')),
      'a suite the required job reaches through a `test*` script body was reported as unrun',
    ).toBe(false);
  });
  it('RP-EC-F red: a table row NO step of the required job names takes the derivation below its FLOOR and is refused', () => {
    // The workflow side of the same correction. The suite is present and
    // still attributed to this slice; only the step that named it is gone. The
    // directory that covers it (`perf:phase2:s8` names the whole of
    // `tests/performance`) is run by no step of any job, which is exactly why
    // directory reachability is not enough for a MEASURED row — and the floor
    // is counted over the suites BOTH derivations agree on, so losing the step
    // is losing a measurement.
    const row = S4_EVIDENCE_STEPS[0];
    expect(row, 'the table is empty, so this plant has no subject').toBeDefined();
    const dir = rootWithEvidence((d) => {
      const stripped = workflowWith(`the step naming ${row?.suite ?? ''} removed`, (lines) => {
        const [start, end] = stepBlock(lines, row?.command ?? '');
        return [...lines.slice(0, start), ...lines.slice(end)];
      });
      writeFileSync(join(d, WORKFLOW), stripped, 'utf8');
    });
    expect(workflowNamedSuites(dir), 'the required job still names the suite, so the plant did not reproduce the loss').not.toContain(row?.suite ?? '');
    const found = evidenceCoverageProblems(dir);
    expect(
      found.some((m) => m.includes('the accepted floor is')),
      `a table row the required job no longer names left the floor silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-EC-G: the set equality does NOT claim the predecessor slices’ measured steps as this slice’s evidence', () => {
    // The required job also names `pos-s3-budgets` (P4-A/P4-B's budget) and
    // `plan-evidence-contract` (TL-P4-S3-R4's). Neither names a candidate
    // migration, so the attribution leaves them out — an UNRESTRICTED set
    // equality would pin a predecessor's step as this gate's own evidence and
    // would red the moment P4-S5 added one of its own.
    const named = workflowNamedSuites(REPO);
    const derived = measuredCandidateSuites(REPO);
    const others = named.filter((f) => !derived.includes(f));
    expect(others.length, 'the required job names no measured suite outside this slice, so this claim has no subject').toBeGreaterThan(0);
    const problems = evidenceCoverageProblems(REPO);
    for (const f of others)
      expect(
        problems.some((m) => m.includes(f)),
        `${f} belongs to a slice behind this one and the cross-check claimed it: ${problems.join(' | ')}`,
      ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE ROSTER RATCHET — a suite cannot leave the derived set unnoticed.
//
// `roster-runner` iterates `rosterFiles(root)`, so it constrains only files
// ALREADY on the roster and cannot see one leave. A rostered suite moved AND
// renamed out of the basename rule drops off the roster, drops out of this
// gate's execution, and no other check names the loss.

describe('P4-S4 — the roster is a RATCHET: the derived set may grow and may not silently shrink', () => {
  it('the checkout passes, and the floor is a floor rather than an equality', () => {
    expect(rosterProblems(REPO)).toEqual([]);
    expect(rosterRatchetProblems(REPO)).toEqual([]);
    // The roster is at or above the floor, and MAY be above it: this slice is
    // being written in several worktrees at once and an equality here would be
    // the P4-AL-88 defect.
    expect(rosterFiles(REPO).length).toBeGreaterThanOrEqual(26);
  });

  it('the recorded floor EQUALS the derived roster, so a roster that grew cannot leave the ratchet slack', () => {
    // A floor left behind a grown roster still passes — and stops reporting a
    // loss, because the loss then lands above it. Both of this law's own red
    // proofs went silent exactly that way when the roster grew from 26 to 32
    // and the floor stayed at 26. So the floor is required to BE the count,
    // which makes forgetting to move it a failure instead of a relaxation.
    expect(ROSTER_FLOOR, 'the roster moved and ROSTER_FLOOR did not — move it in the same commit, in whichever direction the roster went').toBe(
      rosterFiles(REPO).length,
    );
  });

  it('RP-RT-A red: a rostered suite moved AND renamed out of the rule takes the roster below the floor and is named', () => {
    // The exact attack, on a copy of the real tests tree. The security suite
    // is renamed so the basename rule no longer matches it — which is how a
    // suite leaves the roster while every per-file check stays green.
    const victim = 'tests/security/p4s4-rls-quals-once-per-query.test.ts';
    expect(rosterFiles(REPO), 'the victim is not on the roster, so this plant has no subject').toContain(victim);
    const dir = mkdtempSync(join(tmpdir(), 'p4s4-ratchet-'));
    for (const file of rosterFiles(REPO)) {
      if (file === victim) continue;
      mkdirSync(join(dir, file.slice(0, file.lastIndexOf('/'))), { recursive: true });
      writeFileSync(join(dir, file), readFileSync(join(REPO, file), 'utf8'), 'utf8');
    }
    // The victim is still IN THE TREE — it is only renamed, which is the point:
    // nothing was deleted, and the per-file laws have nothing to say.
    mkdirSync(join(dir, 'tests', 'security'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'security', 'rls-quals-once-per-query.test.ts'), readFileSync(join(REPO, victim), 'utf8'), 'utf8');
    const after = rosterFiles(dir);
    expect(after, 'the renamed suite is still being rostered, so the plant did not reproduce the attack').not.toContain(victim);
    expect(after.length, 'the roster did not actually shrink, so this proof would prove nothing').toBeLessThan(rosterFiles(REPO).length);
    const found = rosterRatchetProblems(dir);
    expect(
      found.some((m) => m.includes('a rostered suite has left the derived set')),
      `a suite renamed out of the rule left the roster silently: ${found.join(' | ')}`,
    ).toBe(true);
    // The DIRECTORY arm is not this case's subject and must stay silent here:
    // one of `tests/security`'s two rostered suites left, so the directory is
    // not emptied, and claiming it was named would be claiming the arm fires
    // when it should not. RP-RT-B below empties it and asserts that arm.
    expect(
      found.some((m) => m.includes('no longer holds a single suite')),
      `the per-directory arm fired over a directory that still holds a suite: ${found.join(' | ')}`,
    ).toBe(false);
  });

  it('RP-RT-B red: the LAST suite of a directory leaving is named even when the total is held up by a new sibling file', () => {
    // The half a total floor cannot see. The security suite is renamed out of
    // the rule AND a new integration suite is added, so the count is unchanged
    // and only the per-directory floor can report the loss.
    // EVERY suite of the directory leaves, not just one: the arm under test is
    // "this directory no longer holds a single suite", and a directory holding
    // two is not emptied by renaming one of them.
    const victims = rosterFiles(REPO).filter((f) => f.startsWith('tests/security/'));
    expect(victims.length, 'no rostered suite lives in tests/security, so this plant has no subject').toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'p4s4-ratchet-held-'));
    for (const file of rosterFiles(REPO)) {
      if (victims.includes(file)) continue;
      mkdirSync(join(dir, file.slice(0, file.lastIndexOf('/'))), { recursive: true });
      writeFileSync(join(dir, file), readFileSync(join(REPO, file), 'utf8'), 'utf8');
    }
    // One new sibling per departed suite, so the TOTAL is unchanged and only
    // the per-directory floor can report the loss.
    mkdirSync(join(dir, 'tests', 'integration'), { recursive: true });
    for (let i = 0; i < victims.length; i += 1) {
      writeFileSync(
        join(dir, 'tests', 'integration', `p4s4-a-siblings-new-suite-${i}.test.ts`),
        "import { expect, it } from 'vitest';\nit('red: a new sibling suite', () => expect([1]).not.toEqual([]));\n",
        'utf8',
      );
    }
    const after = rosterFiles(dir);
    expect(
      after.length,
      'the total did not stay at or above the floor, so the total floor would catch this and the plant proves nothing',
    ).toBeGreaterThanOrEqual(rosterFiles(REPO).length);
    const found = rosterRatchetProblems(dir);
    expect(
      found.some((m) => m.includes('a rostered suite has left the derived set')),
      'the TOTAL floor fired, so this plant is not isolating the per-directory floor',
    ).toBe(false);
    expect(
      found.some((m) => m.includes('tests/security') && m.includes('no longer holds a single suite')),
      `the last suite of tests/security left and only the total was checked: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-RT-C red: a SWAP inside one directory — one suite out, one suite in — is named by membership, which a count cannot see', () => {
    // The challenge round's measured hole. Move AND rename one rostered suite
    // out of the basename rule and add one new suite IN THE SAME DIRECTORY, in
    // the same commit: the total is unchanged, the floor equality still holds,
    // and the per-directory arm sees a directory that still holds suites. Both
    // of the arms above are therefore silent, by assertion below, and only the
    // recorded membership can report the loss. The victim is the suite the
    // round itself used: it is referenced by name nowhere else in the repo.
    const victim = 'tests/guards/p4s4-migration-self-capture-law.test.ts';
    expect(rosterFiles(REPO), 'the victim is not on the roster, so this plant has no subject').toContain(victim);
    expect(
      ROSTER_RECORDED.map((r) => r.suite),
      'the victim is not recorded, so the membership arm has nothing to miss',
    ).toContain(victim);
    const dir = mkdtempSync(join(tmpdir(), 'p4s4-ratchet-swap-'));
    for (const file of rosterFiles(REPO)) {
      if (file === victim) continue;
      mkdirSync(join(dir, file.slice(0, file.lastIndexOf('/'))), { recursive: true });
      writeFileSync(join(dir, file), readFileSync(join(REPO, file), 'utf8'), 'utf8');
    }
    // Renamed out of the rule, still in the tree — nothing deleted.
    mkdirSync(join(dir, 'tests', 'guards'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'guards', 'migration-self-capture-law.test.ts'), readFileSync(join(REPO, victim), 'utf8'), 'utf8');
    // And one new suite in the SAME directory, so the count is restored.
    writeFileSync(
      join(dir, 'tests', 'guards', 'p4s4-a-swap-replacement.test.ts'),
      "import { expect, it } from 'vitest';\nit('red: a replacement suite', () => expect([1]).not.toEqual([]));\n",
      'utf8',
    );
    const after = rosterFiles(dir);
    expect(after, 'the renamed suite is still rostered, so the plant did not reproduce the swap').not.toContain(victim);
    expect(after.length, 'the total moved, so the total floor would catch this and the plant proves nothing').toBe(rosterFiles(REPO).length);
    const found = rosterRatchetProblems(dir);
    expect(
      found.some((m) => m.includes('a rostered suite has left the derived set')),
      'the TOTAL floor fired, so the swap is not isolated',
    ).toBe(false);
    expect(
      found.some((m) => m.includes('no longer holds a single suite')),
      'the per-directory arm fired over a directory that still holds suites',
    ).toBe(false);
    expect(
      found.some((m) => m.includes('no longer derived by the roster rule') && m.includes(victim)),
      `the swap was silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('ROSTER_RECORDED is exactly what the tree derives today, and an ADDITION is never a finding', () => {
    // Both directions, so the record cannot drift from the tree: every derived
    // file is recorded and every recorded file is derived.
    expect(
      ROSTER_RECORDED.map((r) => r.suite).sort(),
      'the record and the derived roster have drifted apart — a row is recorded that the rule no longer derives, or a derived suite is unrecorded',
    ).toEqual(rosterFiles(REPO));
    // And a file the record does not name joins freely: a new suite must never
    // red the ratchet, which is what made the earlier count-only floor go
    // slack rather than loud.
    const dir = mkdtempSync(join(tmpdir(), 'p4s4-ratchet-add-'));
    for (const file of rosterFiles(REPO)) {
      mkdirSync(join(dir, file.slice(0, file.lastIndexOf('/'))), { recursive: true });
      writeFileSync(join(dir, file), readFileSync(join(REPO, file), 'utf8'), 'utf8');
    }
    writeFileSync(
      join(dir, 'tests', 'guards', 'p4s4-a-brand-new-suite.test.ts'),
      "import { expect, it } from 'vitest';\nit('red: a brand new suite', () => expect([1]).not.toEqual([]));\n",
      'utf8',
    );
    expect(rosterFiles(dir).length).toBe(rosterFiles(REPO).length + 1);
    expect(rosterRatchetProblems(dir)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE ROSTER AS A BIJECTION — the inverse of every roster law above.
//
// Every roster law in the gate runs from the TREE towards the ROSTER:
// `discoverS4Suites` walks `tests/` and matches a basename, and the ratchet
// asserts `recorded ⊆ derived`. Nothing ran the other way, and two holes sat
// in that direction: `rosterFiles` injects `CI_COMPOSITION_SUITE`
// unconditionally, so that one row is on the roster however absent it is; and
// a recorded row was a PATH, satisfied by any file at that path that held a
// title. The plants below are both.

/** A root holding a verbatim copy of every rostered file, with `mutate` applied. */
function rootWithTheWholeRoster(mutate: (dir: string) => void, skip: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'p4s4-bijection-'));
  for (const file of rosterFiles(REPO)) {
    if (skip.includes(file)) continue;
    mkdirSync(join(dir, file.slice(0, file.lastIndexOf('/'))), { recursive: true });
    writeFileSync(join(dir, file), readFileSync(join(REPO, file), 'utf8'), 'utf8');
  }
  mutate(dir);
  return dir;
}

describe('P4-S4 — the roster is a BIJECTION with what exists, not a one-way floor', () => {
  it('the checkout passes, and every recorded row names a distinct title', () => {
    expect(rosterBijectionProblems(REPO)).toEqual([]);
    expect(new Set(ROSTER_RECORDED.map((r) => r.title)).size).toBe(ROSTER_RECORDED.length);
    // Each recorded title is really carried by the file that records it, and
    // by no other rostered file — so no row is satisfiable by a sibling.
    for (const row of ROSTER_RECORDED) {
      expect(rosterRowTitles(readFileSync(join(REPO, row.suite), 'utf8')), `${row.suite} does not carry its own recorded title`).toContain(row.title);
      for (const other of rosterFiles(REPO).filter((f) => f !== row.suite))
        expect(rosterRowTitles(readFileSync(join(REPO, other), 'utf8')), `${other} also carries ${row.suite}'s recorded title`).not.toContain(row.title);
    }
  });

  it('RP-RB-A red: a roster row that is LISTED and not on disk is named — and the ratchet cannot see it, by construction', () => {
    // The injected row. `rosterFiles` adds it whatever the tree holds, so it is
    // in the ratchet's own `derived` set and its membership arm is satisfied by
    // the injection rather than by the file.
    const dir = rootWithTheWholeRoster(() => undefined, [CI_COMPOSITION_SUITE]);
    expect(rosterFiles(dir), 'the injected row left the roster, so this plant is not the attack it claims').toContain(CI_COMPOSITION_SUITE);
    expect(
      rosterRatchetProblems(dir).some((m) => m.includes(CI_COMPOSITION_SUITE)),
      'the ratchet named the absent row, so this proof is not isolating the inverse direction',
    ).toBe(false);
    const found = rosterBijectionProblems(dir);
    expect(
      found.some((m) => m.includes(CI_COMPOSITION_SUITE) && m.includes('the tree does not hold it')),
      `a roster row that is not on disk left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-RB-B red: a recorded row whose FILE IS REPLACED by an unrelated passing suite is named, and every other roster law stays green', () => {
    // The row was a filename, and a filename is not evidence: the path is
    // rostered, the basename still matches the rule, the file still holds a
    // runnable title, and the law it recorded is gone.
    const row = ROSTER_RECORDED.find((r) => r.suite === 'tests/integration/p4s4-payment-closure.test.ts');
    if (row === undefined) throw new Error('the victim is not recorded, so this plant has no subject');
    const unrelated = "import { expect, it } from 'vitest';\n\nit('an unrelated case that measures nothing of this slice', () => expect(1).toBe(1));\n";
    const dir = rootWithTheWholeRoster((at) => writeFileSync(join(at, row.suite), unrelated, 'utf8'));
    // The three laws that could have seen it, each shown silent on the plant.
    expect(rosterProblems(dir), 'rosterProblems saw the substitution, so the hole was not where this proof says').toEqual([]);
    expect(rosterRatchetProblems(dir), 'the ratchet saw the substitution, so the hole was not where this proof says').toEqual([]);
    expect(
      rosterRedProofProblems(dir).some((m) => m.includes(row.suite)),
      'roster-red-proofs saw the substitution, so the hole was not where this proof says',
    ).toBe(false);
    const found = rosterBijectionProblems(dir);
    expect(
      found.some((m) => m.includes(row.suite) && m.includes('no longer carries the recorded title')),
      `a rostered file whose whole content was replaced left every roster law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-RB-C red: a recorded title that survives only in a SKIPPED block does not satisfy its row', () => {
    // `testTitles` over a whole file reports the cases inside a
    // `describe.skip(` too, so the row has to be judged inside its own block.
    // The victim holds three top-level blocks, so the file still carries
    // runnable cases after the plant and the finding has to be about the ROW.
    const row = ROSTER_RECORDED.find((r) => r.suite === 'tests/integration/p4s4-customer-identity-pin.test.ts');
    if (row === undefined) throw new Error('the victim is not recorded, so this plant has no subject');
    const dir = rootWithTheWholeRoster((at) => {
      const text = readFileSync(join(at, row.suite), 'utf8');
      const mutated = text.replace(/^describe\s*\(/m, 'describe.skip(');
      expect(mutated, `${row.suite} holds no top-level describe( to skip, so this plant would prove nothing`).not.toBe(text);
      // The title is STILL IN THE FILE, which is the whole point of the plant.
      expect(mutated).toContain(row.title);
      writeFileSync(join(at, row.suite), mutated, 'utf8');
    });
    const found = rosterBijectionProblems(dir);
    expect(
      found.some((m) => m.includes(row.suite) && m.includes('no longer carries the recorded title')),
      `a recorded law skipped in place still satisfied its row: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-RB-D red: two rows sharing one title are named, because a shared title is one either file can satisfy', () => {
    const [first, second] = ROSTER_RECORDED;
    if (first === undefined || second === undefined) throw new Error('fewer than two rows, so this plant has no subject');
    const planted = [first, { suite: second.suite, title: first.title }];
    const found = rosterBijectionProblems(REPO, planted);
    expect(
      found.some((m) => m.includes(second.suite) && m.includes('both record the title')),
      `two rows recording one title left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('an ADDITION is never a finding here either: a new suite joins the roster with no row of its own', () => {
    const dir = rootWithTheWholeRoster((at) => {
      mkdirSync(join(at, 'tests', 'guards'), { recursive: true });
      writeFileSync(
        join(at, 'tests', 'guards', 'p4s4-a-brand-new-suite.test.ts'),
        "import { expect, it } from 'vitest';\nit('red: a brand new suite', () => expect([1]).not.toEqual([]));\n",
        'utf8',
      );
    });
    expect(rosterFiles(dir).length).toBe(rosterFiles(REPO).length + 1);
    expect(rosterBijectionProblems(dir)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE MEASURED TABLE AS A FLOOR, AND A MEASUREMENT THAT MUST EXIST AT ALL.

/** A root with the manifest, the workflow, this slice's migrations and the measured suites, with `mutate` applied. */
function rootWithMeasurements(mutate: (dir: string) => void, skip: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'p4s4-coverage-'));
  writeFileSync(join(dir, 'package.json'), readFileSync(join(REPO, 'package.json'), 'utf8'), 'utf8');
  writeFileSync(join(dir, 'vitest.config.ts'), readFileSync(join(REPO, 'vitest.config.ts'), 'utf8'), 'utf8');
  mkdirSync(join(dir, WORKFLOW.slice(0, WORKFLOW.lastIndexOf('/'))), { recursive: true });
  writeFileSync(join(dir, WORKFLOW), WORKFLOW_TEXT, 'utf8');
  mkdirSync(join(dir, MIGRATIONS_SUBDIR), { recursive: true });
  for (const file of candidateMigrations(REPO))
    writeFileSync(join(dir, MIGRATIONS_SUBDIR, file), readFileSync(join(REPO, MIGRATIONS_SUBDIR, file), 'utf8'), 'utf8');
  mkdirSync(join(dir, 'tests', 'performance'), { recursive: true });
  for (const ev of S4_EVIDENCE_STEPS) {
    if (skip.includes(ev.suite)) continue;
    writeFileSync(join(dir, ev.suite), readFileSync(join(REPO, ev.suite), 'utf8'), 'utf8');
  }
  mutate(dir);
  return dir;
}

describe('P4-S4 — the measured table is a FLOOR, derived from the tree, and never an equality', () => {
  it('the checkout passes, and the derivation is at or above the floor rather than equal to the table', () => {
    expect(evidenceCoverageProblems(REPO)).toEqual([]);
    expect(measuredCandidateSuites(REPO).length).toBeGreaterThanOrEqual(EVIDENCE_FLOOR);
    // An unmutated copy passes, so every plant below is about the plant.
    expect(evidenceCoverageProblems(rootWithMeasurements(() => undefined))).toEqual([]);
  });

  it('RP-EC-A red: a measurement that LEAVES the tree takes the derivation below the floor and is named', () => {
    const victim = S4_EVIDENCE_STEPS[S4_EVIDENCE_STEPS.length - 1];
    if (victim === undefined) throw new Error('no evidence step, so this plant is vacuous');
    const dir = rootWithMeasurements(() => undefined, [victim.suite]);
    const derived = measuredCandidateSuites(dir);
    expect(derived, 'the suite is still derived, so the plant did not reproduce the loss').not.toContain(victim.suite);
    expect(derived.length, 'the derivation did not fall below the floor, so this proof would prove nothing').toBeLessThan(EVIDENCE_FLOOR);
    const found = evidenceCoverageProblems(dir);
    expect(
      found.some((m) => m.includes('the accepted floor is')),
      `a measurement that left the tree did not take the derivation below its floor: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-EC-B red: a table that loses a row falls below the row floor and is named', () => {
    const found = evidenceCoverageProblems(REPO, S4_EVIDENCE_STEPS.slice(0, EVIDENCE_FLOOR - 1));
    expect(
      found.some((m) => m.includes('S4_EVIDENCE_STEPS holds') && m.includes('row(s) and the accepted floor is')),
      `deleting a row from the table left the floor silent: ${found.join(' | ')}`,
    ).toBe(true);
  });

  it('RP-EC-C: an EXTRA table row the derivation does not find is NOT a finding — that equality is what reds every later tree', () => {
    // The removed arm. `S4_EVIDENCE_STEPS` was compared with the derivation by
    // set equality in both directions, and the moment this slice is accepted —
    // or a later slice adds a measurement of its own — a row the derivation no
    // longer finds would red an ACCEPTED gate over a tree nobody touched.
    const extra = {
      label: 'a measurement of a slice ahead of this one',
      script: 'tests/performance/a-later-slices-budgets.test.ts',
      command: 'npx vitest run tests/performance/a-later-slices-budgets.test.ts',
      name: 'A later slice’s budgets',
      suite: 'tests/performance/a-later-slices-budgets.test.ts',
    };
    expect(measuredCandidateSuites(REPO), 'the extra row IS derived, so this claim has no subject').not.toContain(extra.suite);
    const found = evidenceCoverageProblems(REPO, [...S4_EVIDENCE_STEPS, extra]);
    expect(
      found.some((m) => m.includes(extra.suite)),
      `a table row the derivation does not find was refused, which is the equality this fix removed: ${found.join(' | ')}`,
    ).toBe(false);
    // And an extra row is not unpinned: `evidence-integrity` refuses a row
    // whose suite is not in the tree, so a row can be extra and still cannot
    // be fictional.
    const pinned = evidenceIntegrityProblems(REPO, [...S4_EVIDENCE_STEPS, extra]);
    expect(
      pinned.some((m) => m.includes(extra.suite) && m.includes('would run nothing')),
      `an extra row naming a suite that is not in the tree was not refused by evidence-integrity: ${pinned.join(' | ')}`,
    ).toBe(true);
  });

  it('the derivation is TENSE-CORRECT: it reads this slice’s migrations, not whatever is past the accepted head', () => {
    // `measuredCandidateSuites` read `candidateMigrations`, which the
    // acceptance commit moves to the NEXT slice's files. Reading
    // `sliceMigrations` is what keeps the derivation pointed at this slice in
    // either tense, and it is the one place the tense decides a subject.
    const gate = readFileSync(join(REPO, 'scripts', 'phase4-s4-gate.ts'), 'utf8');
    const body = /export function measuredCandidateSuites\([\s\S]*?\n}/.exec(gate)?.[0] ?? '';
    expect(body, 'measuredCandidateSuites is gone, so this claim has no subject').toContain('sliceMigrations(root)');
    expect(body, 'the derivation reads candidateMigrations again, which the acceptance commit points at the NEXT slice').not.toContain(
      'candidateMigrations(root)',
    );
  });
});

/**
 * The measured suite's text with its FIRST column-0 `describe(` turned into
 * `marker`, with the same canaries as the plant inside the block above: the
 * mutated line must be executed code and must survive comment-stripping, or
 * the plant is about PROSE and proves nothing.
 */
function plantOnTheFirstExecutedBlock(text: string, suite: string, marker: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^describe\s*\(/.test(l));
  expect(at, `${suite} holds no top-level describe( at a line start, so this plant has nothing to mutate`).toBeGreaterThan(-1);
  const above = lines.slice(0, at).join('\n');
  expect((above.match(/\/\*/g) ?? []).length, `${suite}: the chosen line sits inside an unterminated block comment`).toBe((above.match(/\*\//g) ?? []).length);
  const mutated = [...lines.slice(0, at), (lines[at] ?? '').replace(/^describe\s*\(/, marker), ...lines.slice(at + 1)].join('\n');
  expect(mutated, `${suite}: the plant "${marker}" changed nothing, so the proof would prove nothing`).not.toBe(text);
  expect(stripProseForProof(mutated), `${suite}: the plant vanishes when comments are stripped, so it landed in PROSE`).not.toBe(stripProseForProof(text));
  return mutated;
}

describe('P4-S4 — a measured suite must hold a measurement AT ALL, and the skip surface is wider than three dotted regexes', () => {
  it('RP-EI-H red: a measured suite with no runnable case is named — the row that cites NO budget id is where that hole was', () => {
    // The per-id arm is conditional on the row citing a budget id the accepted
    // table knows, and the two equivalence rows cite none: `known` was empty
    // and nothing required their suites to hold a single case.
    const victim = S4_EVIDENCE_STEPS.find((e) => [...`${e.label} ${e.name}`.matchAll(/\bP4-[A-Z](?:-[A-Z]+)?\b/g)].length === 0);
    if (victim === undefined) throw new Error('every row cites a budget id, so this plant has no subject');
    const found = evidenceIntegrityProblems(rootWithTree((dir) => writeFileSync(join(dir, victim.suite), 'export {};\n', 'utf8')));
    expect(
      found.some((m) => m.includes(victim.suite) && m.includes('holds no RUNNABLE it( title at all')),
      `a measured suite emptied of every case left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
    // And the arms that existed before are each silent on this plant, which is
    // what makes it the hole and not a duplicate: no skip marker, no missing
    // id, the file present and the body still naming it.
    expect(
      found.some((m) => m.includes(victim.suite) && (m.includes('indistinguishable') || m.includes('would run nothing'))),
      `an older arm fired on this plant, so it is not isolating the missing-measurement law: ${found.join(' | ')}`,
    ).toBe(false);
  });

  it('RP-EI-A6: the four skip spellings that walk through the member-access regexes are each caught, and four lawful shapes are not', () => {
    // Found by driving candidates against the law, not by reading it. Each of
    // these really stops the measurement and matched NONE of the regexes the
    // law carried.
    const ev = S4_EVIDENCE_STEPS[0];
    if (ev === undefined) throw new Error('no evidence step, so this plant is vacuous');
    const evasions: readonly (readonly [string, string])[] = [
      ['x' + "describe('a jest-compatible skip alias', () => {", 'the x-prefixed alias, which \\b cannot see inside'],
      ["describe.each([])('a parameterised block over an EMPTY case list %s', () => {", 'zero cases, and no skip token anywhere'],
      ["describe('an options-object skip', { skip: true }, () => {", 'the options-object form, which leaves the title runnable'],
      ["describe('a runtime skip off the test context', () => { ctx.skip(); (() => {", 'the runtime context skip'],
    ];
    for (const [marker, why] of evasions) {
      const found = evidenceIntegrityProblems(
        rootWithTree((dir) => {
          const text = readFileSync(join(dir, ev.suite), 'utf8');
          writeFileSync(join(dir, ev.suite), plantOnTheFirstExecutedBlock(text, ev.suite, marker), 'utf8');
        }),
      );
      expect(
        found.some((m) => m.includes(ev.suite) && m.includes('indistinguishable')),
        `${marker} (${why}) left the law silent: ${found.join(' | ')}`,
      ).toBe(true);
    }
    // And the lawful shapes this estate's own suites are written in stay
    // silent: a law that refused them would be a false refusal of an honest
    // tree, which is the other half of every widening here.
    for (const lawful of [
      "it.each([[1], [2]])('MEASUREMENT: a parameterised case %s', async (n) => {",
      "it('MEASUREMENT: a case with a longer timeout', { timeout: 60_000 }, async () => {",
      "it('MEASUREMENT: a case that states it is not skipped', { skip: false }, async () => {",
      "it('MEASUREMENT: a case that may be retried', { retry: 2 }, async () => {",
    ]) {
      const found = evidenceIntegrityProblems(
        rootWithTree((dir) => {
          const text = readFileSync(join(dir, ev.suite), 'utf8');
          writeFileSync(join(dir, ev.suite), `${text}\n${lawful}\n  return undefined;\n});\n`, 'utf8');
        }),
      );
      expect(
        found.some((m) => m.includes(ev.suite) && m.includes('indistinguishable')),
        `the lawful shape \`${lawful}\` was reported as a skipped block: ${found.join(' | ')}`,
      ).toBe(false);
    }
  });

  it('RP-EI-A7 red: the config smuggle through a BRACKETED member access is caught — JSON["parse"] is JSON.parse', () => {
    // RP-EI-A5 plants the dotted spelling. The bracketed one did exactly the
    // same thing and matched none of the four shapes, because they were all
    // written about a dot.
    const hidden =
      "import { defineConfig } from 'vitest/config';\n" +
      'const S = JSON[\'parse\'](\'{"exclude":["tests/performance/**"],"passWithNoTests":true}\');\n' +
      "export default defineConfig({ test: Object['assign']({ include: ['tests/**/*.test.ts'] }, S) });\n";
    for (const [shape, what] of [
      [/\bexclude\s*:/, 'an `exclude:` in text'],
      [/passWithNoTests\s*:\s*true/, 'a `passWithNoTests: true` in text'],
      [/\.\.\./, 'a spread'],
      [/\bJSON\s*\.\s*parse\s*\(/, 'a dotted JSON.parse'],
      [/\bObject\s*\.\s*assign\s*\(/, 'a dotted Object.assign'],
    ] as const)
      expect(shape.test(hidden), `the plant still carries ${what}, so it would prove nothing`).toBe(false);
    const found = evidenceIntegrityProblems(rootWithTree((dir) => writeFileSync(join(dir, 'vitest.config.ts'), hidden, 'utf8')));
    expect(
      found.some((m) => m.includes('vitest.config.ts') && m.includes('however it is spelled')),
      `a config that smuggles its options in through a bracketed JSON['parse'] left the law silent: ${found.join(' | ')}`,
    ).toBe(true);
  });
});
