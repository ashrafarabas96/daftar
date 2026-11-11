/**
 * CG-2 — THE BILLING DB GATE MUST BE ABLE TO FAIL THE RUN.
 *
 * `packages/billing/test/db/run-db-proof.sh` prints its own floor
 * (`DB_PROOF_CASES … floor=131`) and exits non-zero below it, so the gate
 * protects against a SHRINKING suite. It does not protect against the gate
 * being switched off. The floor guards the count, not the gate's standing,
 * and an external review of the P5 seal file asked for the second half (the
 * owner's relay of 2026-11-10).
 *
 * THREE ways turn a red database proof into a green run, and the law reports
 * all three, each with its own negative control below:
 *   - `continue-on-error` (not `false`) on the step or on its job;
 *   - a condition (`if:`) on the step or on its job — `if: false` never runs
 *     the gate at all;
 *   - the command swallowing its own exit code (`|| true`, `|| :`,
 *     `|| exit 0`, `set +e`, a trailing `; true`) — no YAML key to find.
 * The first version of this law read `continue-on-error` ALONE while its own
 * prose claimed the whole class. A narrow review of 2026-11-11 said so, and
 * the two missing limbs were MEASURED red before they were closed, so this
 * list is what the checker does, not what it intends.
 *
 * This law reads `.github/workflows/ci.yml` as TEXT and does not edit it:
 * `ci.yml` is shared property across lanes, so a law that only reads it
 * cannot collide with another lane's writer.
 *
 * It asserts an absence, so it carries both controls (RULE-3):
 *   - POSITIVE: the step must be FOUND, with its `run:` naming the script.
 *     A broken locator reading a clean file is the failure mode that makes an
 *     absence law worthless (RULE-11/RULE-18).
 *   - NEGATIVE: the same checker, run over an in-memory copy of the same file
 *     with `continue-on-error: true` planted on that step, must report it.
 *     The plant is in memory and never on disk, so nothing restores it and
 *     DR-09 is untouched.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..');
const CI_PATH = join(REPO, '.github', 'workflows', 'ci.yml');
const CI = readFileSync(CI_PATH, 'utf8');

/**
 * Replace the `steps:` key OF THE JOB THAT HOLDS THE GATE. A plain
 * first-match replacement hits whichever job comes first in the file, and a
 * plant that lands somewhere else is a control that proves nothing
 * (RULE-27): the first version of the two controls below did exactly that,
 * and passed while the defect was live.
 */
function plantOnGateJobStepsKey(source: string, replacement: string): string | null {
  const lines = source.split('\n');
  const at = locate(source);
  if (!at) return null;
  const jobLine = lines.findIndex((l) => new RegExp(`^ {2}${at.job}:\\s*$`).test(l));
  if (jobLine < 0) return null;
  const stepsIdx = lines.findIndex((l, i) => i > jobLine && /^ {4}steps:\s*(?:#.*)?$/.test(l));
  if (stepsIdx < 0 || stepsIdx > at.stepStart) return null;
  const copy = [...lines];
  copy[stepsIdx] = replacement;
  return copy.join('\n');
}

/** The script the gate runs, as `ci.yml` must spell it. */
const GATE_RUN = 'npm run test:db:billing';

/** Keys that stop a failure from failing the run, on a step or on a job. */
const NEUTRALISING = /^\s*continue-on-error\s*:\s*(.+?)\s*$/;

/**
 * A condition on the step or on its job. `if: false` never runs the gate at
 * all and the run still reads green, so a condition is as neutralising as
 * `continue-on-error` and is reported the same way. The repository's own
 * `required-ci-chain-composition` law rejects both keys together, and this
 * one was measured as the cheaper hole before it was closed: with `if: false`
 * planted the checker reported nothing.
 */
const GUARDING_IF = /^\s*if\s*:\s*(.+?)\s*$/;

/**
 * Ways the command swallows its own exit code, with no YAML key to find:
 * `|| true`, `|| :`, `|| exit 0`, `set +e`, or a trailing `; true`. It is
 * read over the WHOLE `run:` block, because a `run: |` body puts `set +e` on
 * one line and the command on another (measured 2026-11-11: reading the
 * command's line alone reported nothing on exactly that shape).
 */
const SWALLOWED_EXIT = /\|\|\s*(?:true|:|exit\s+0)|set\s+\+e|;\s*true\s*$/m;

/** The `run:` key of a step, whatever follows it on the line. */
const RUN_KEY = /^\s*run\s*:/;

/**
 * The `run:` value starting at `start`: its own line plus every following
 * line indented deeper than the key, which is the block form's body. It stops
 * at the step's next key, so an `env:` value is never read as a command.
 */
function runBlock(step: readonly string[], start: number): string {
  const first = step[start] as string;
  const keyIndent = first.length - first.trimStart().length;
  const body: string[] = [first];
  for (let i = start + 1; i < step.length; i++) {
    const line = step[i] as string;
    if (line.trim().length === 0) {
      body.push(line);
      continue;
    }
    if (line.length - line.trimStart().length <= keyIndent) break;
    body.push(line);
  }
  return body.join('\n');
}

interface Located {
  /** 0-based index of the `- name:` line that opens the step. */
  readonly stepStart: number;
  /** Lines of the step block, the opening line included. */
  readonly step: readonly string[];
  /** The job key that holds the step, e.g. `backend`. */
  readonly job: string;
  /** Lines of the job block above the first step, where job-level keys live. */
  readonly jobHeader: readonly string[];
  /**
   * Whether the job's own `steps:` key was found, which is what BOUNDS
   * `jobHeader`. False means the header could not be delimited, and the
   * checker then refuses to read rather than scanning the rest of the file
   * and reporting another job's lines as this job's.
   */
  readonly headerBounded: boolean;
}

/**
 * Locate the gate step and its job by indentation. No YAML parser is
 * installed in this repository and one is not added for a guard: the law
 * reads the file the way a reviewer does, and every structural assumption it
 * makes is asserted in the positive control below.
 */
function locate(source: string): Located | null {
  const lines = source.split('\n');
  const runLine = lines.findIndex((l) => l.includes(GATE_RUN));
  if (runLine < 0) return null;

  const indentOf = (l: string): number => l.length - l.trimStart().length;

  // Walk back to the `- name:` (or bare `- `) that opens this step.
  let stepStart = -1;
  for (let i = runLine; i >= 0; i--) {
    if (/^\s*-\s/.test(lines[i] as string)) {
      stepStart = i;
      break;
    }
  }
  if (stepStart < 0) return null;
  const stepIndent = indentOf(lines[stepStart] as string);

  // The step block runs to the next list item at the same indentation, or to
  // the next line indented less than the step's own marker.
  let stepEnd = lines.length;
  for (let i = stepStart + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim().length === 0) continue;
    const ind = indentOf(line);
    if (ind < stepIndent || (ind === stepIndent && /^\s*-\s/.test(line))) {
      stepEnd = i;
      break;
    }
  }

  // Walk back to the job key: the last line above the step indented by two
  // spaces that opens a mapping (`  backend:`).
  let jobLine = -1;
  for (let i = stepStart; i >= 0; i--) {
    const line = lines[i] as string;
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) {
      jobLine = i;
      break;
    }
  }
  if (jobLine < 0) return null;
  const job = (lines[jobLine] as string).trim().replace(/:$/, '');

  // The job's own keys: from the job line down to its `steps:` key. The
  // trailing-comment form `steps: # …` is the same key, and reading it as a
  // different one let the header run to the end of the file (measured
  // 2026-11-11).
  let stepsKey = -1;
  for (let i = jobLine + 1; i < lines.length; i++) {
    if (/^ {4}steps:\s*(?:#.*)?$/.test(lines[i] as string)) {
      stepsKey = i;
      break;
    }
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i] as string)) break;
  }

  return {
    stepStart,
    step: lines.slice(stepStart, stepEnd),
    job,
    jobHeader: stepsKey < 0 ? [] : lines.slice(jobLine, stepsKey),
    headerBounded: stepsKey >= 0,
  };
}

/** Every neutralising key found on the step or on its job, named with where. */
function neutralisers(source: string): string[] {
  const found: string[] = [];
  const at = locate(source);
  if (!at) return ['the gate step was not found at all'];
  if (!at.headerBounded) {
    // Loud, not silent, and not an accusation either: the header is where
    // job-level keys live, and an undelimited one cannot be read.
    return [`the job header could not be bounded at the \`steps:\` key of job ${at.job}`];
  }
  for (const [i, line] of at.step.entries()) {
    const m = NEUTRALISING.exec(line);
    if (m && m[1] !== 'false') found.push(`step: ${line.trim()}`);
    if (GUARDING_IF.test(line)) found.push(`step: ${line.trim()}`);
    if (RUN_KEY.test(line) && SWALLOWED_EXIT.test(runBlock(at.step, i))) found.push(`step: ${line.trim()}`);
  }
  for (const line of at.jobHeader) {
    const m = NEUTRALISING.exec(line);
    if (m && m[1] !== 'false') found.push(`job ${at.job}: ${line.trim()}`);
    if (GUARDING_IF.test(line)) found.push(`job ${at.job}: ${line.trim()}`);
  }
  return found;
}

describe('CG-2 — the billing database gate is blocking', () => {
  it('POSITIVE CONTROL: the step is found, in a named job, running the script by name', () => {
    const at = locate(CI);
    expect(at, `no step in ci.yml runs \`${GATE_RUN}\``).not.toBeNull();
    const found = at as Located;

    // The locator's own assumptions, asserted rather than trusted: without
    // these, a miss would read as a clean file.
    expect(found.step.length, 'the located step block is empty').toBeGreaterThan(1);
    expect(found.step.join('\n')).toContain(GATE_RUN);
    expect(found.step[0], 'the step does not open with a list marker').toMatch(/^\s*-\s*name:/);
    expect(found.job, 'the job holding the gate was not identified').toBe('backend');
    expect(found.headerBounded, 'the job header was not bounded, so job-level keys cannot be read').toBe(true);
    expect(found.jobHeader.length, 'the job header is implausibly long for one job`s keys').toBeLessThan(200);
    expect(found.jobHeader.join('\n'), 'the job header does not carry runs-on').toContain('runs-on:');
  });

  it('the gate can still fail the run: no neutralising key, no condition, no swallowed exit', () => {
    expect(neutralisers(CI), `these keys neutralise the billing DB gate: ${neutralisers(CI).join(' | ')}`).toEqual([]);
  });

  it('NEGATIVE CONTROL: the same checker reports a planted `continue-on-error` on the step', () => {
    const planted = CI.replace(`        run: ${GATE_RUN}`, `        run: ${GATE_RUN}\n        continue-on-error: true`);
    // The plant must have applied, or a no-op replacement would read as a
    // passing control (RULE-27 / DR-55).
    expect(planted, 'the plant did not apply, so this control proves nothing').not.toBe(CI);
    expect(planted).toContain('continue-on-error: true');

    const reported = neutralisers(planted);
    expect(reported.length, 'the checker missed a planted continue-on-error').toBeGreaterThan(0);
    expect(reported[0]).toContain('step:');
  });

  it('NEGATIVE CONTROL: the same checker reports it on the job that holds the step', () => {
    const planted = CI.replace(/^( {2}backend:\n)/m, '$1    continue-on-error: true\n');
    expect(planted, 'the job-level plant did not apply').not.toBe(CI);
    const reported = neutralisers(planted);
    expect(reported.length, 'the checker missed a job-level continue-on-error').toBeGreaterThan(0);
    expect(reported.join(' | ')).toContain('job backend:');
  });

  it('NEGATIVE CONTROL: a guarding `if:` on the step is reported too', () => {
    // `if: false` never runs the step at all, and the job still reads green:
    // the same outcome as `continue-on-error`, by a different key. The law
    // claims the gate CAN FAIL THE RUN, so every way of taking that away is
    // its business (the repository's own `required-ci-chain-composition`
    // rejects `continue-on-error` and `if:` together).
    const planted = CI.replace(`        run: ${GATE_RUN}`, `        if: false\n        run: ${GATE_RUN}`);
    expect(planted, 'the `if:` plant did not apply, so this control proves nothing').not.toBe(CI);
    const reported = neutralisers(planted);
    expect(reported.length, 'the checker missed an `if:` on the gate step').toBeGreaterThan(0);
    expect(reported.join(' | ')).toContain('step:');
  });

  it('NO FALSE RED: a trailing comment on the job`s `steps:` key does not widen the job header', () => {
    // MEASURED on 2026-11-11, in a confirmation review of the widening above:
    // the job header was bounded by /^ {4}steps:\s*$/, which a trailing
    // comment defeats. The header then ran to the end of the file and the
    // law reported FOUR legitimate `if:` lines belonging to OTHER jobs' steps
    // (`if: always()` on artifact upload, `if: github.event_name == …` in
    // `hygiene`) as if they sat on `backend` — a false red on shared
    // property, which is the one thing a law touching `ci.yml` must never do.
    const planted = plantOnGateJobStepsKey(CI, '    steps: # the required chain');
    expect(planted, 'the plant did not land on the gate job`s steps key').not.toBeNull();
    expect(planted, 'the comment plant changed nothing, so this control proves nothing').not.toBe(CI);
    const at = locate(planted as string);
    expect(at, 'the plant broke the locator itself').not.toBeNull();
    expect((at as Located).headerBounded, 'the header was not bounded despite the key being there').toBe(true);
    expect((at as Located).jobHeader.length, 'the job header swallowed the rest of the file').toBeLessThan(200);
    expect(neutralisers(planted as string), 'a correct workflow was reported as neutralised').toEqual([]);
  });

  it('LOUD, NOT SILENT: if the job header cannot be bounded the law says so instead of guessing', () => {
    // The complement of the case above: when the `steps:` key genuinely is
    // not there, the law must refuse to read rather than scan the remainder
    // of the file and accuse another job.
    const planted = plantOnGateJobStepsKey(CI, '    stepz:');
    expect(planted, 'the plant did not land on the gate job`s steps key').not.toBeNull();
    expect(planted, 'the removal plant changed nothing').not.toBe(CI);
    const reported = neutralisers(planted as string);
    expect(reported.length, 'an unbounded job header was read as clean').toBeGreaterThan(0);
    expect(reported.join(' | ')).toContain('the job header could not be bounded');
  });

  it('NEGATIVE CONTROL: a multi-line `run:` block that swallows the code is reported too', () => {
    // `set +e` and a trailing `exit 0` inside a `run: |` block leave the step
    // green with no YAML key to find, and the first version of this check read
    // only the line carrying the command.
    const planted = CI.replace(`        run: ${GATE_RUN}`, ['        run: |', '          set +e', `          ${GATE_RUN}`, '          exit 0'].join('\n'));
    expect(planted, 'the block plant did not apply').not.toBe(CI);
    const reported = neutralisers(planted);
    expect(reported.length, 'the checker missed a swallowed exit code inside a run block').toBeGreaterThan(0);
    expect(reported.join(' | ')).toContain('step:');
  });

  it('NEGATIVE CONTROL: swallowing the exit code inside the command is reported too', () => {
    // `|| true` leaves the step green whatever the proof printed, without a
    // single YAML key to find.
    const planted = CI.replace(`        run: ${GATE_RUN}`, `        run: ${GATE_RUN} || true`);
    expect(planted, 'the `|| true` plant did not apply, so this control proves nothing').not.toBe(CI);
    const reported = neutralisers(planted);
    expect(reported.length, 'the checker missed a swallowed exit code in the gate command').toBeGreaterThan(0);
    expect(reported.join(' | ')).toContain('step:');
  });

  it('the script the gate names still exists and still hands the runner the suite directory', () => {
    const scripts = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    const body = scripts['test:db:billing'];
    expect(body, 'package.json no longer defines test:db:billing, so the gate runs nothing').toBeTruthy();
    expect(body as string).toContain('packages/billing/test/db');
  });
});
