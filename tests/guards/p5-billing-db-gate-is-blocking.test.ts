/**
 * CG-2 — THE BILLING DB GATE MUST BE ABLE TO FAIL THE RUN.
 *
 * `packages/billing/test/db/run-db-proof.sh` prints its own floor
 * (`DB_PROOF_CASES … floor=131`) and exits non-zero below it, so the gate
 * protects against a SHRINKING suite. It does not protect against the gate
 * being switched off: one line — `continue-on-error: true` on the step, or on
 * the job that holds it — turns a red database proof into a green run with
 * none of its cases enforced. The floor guards the count, not the gate's
 * standing, and an external review of the P5 seal file asked for the second
 * half (the owner's relay of 2026-11-10).
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

/** The script the gate runs, as `ci.yml` must spell it. */
const GATE_RUN = 'npm run test:db:billing';

/** Keys that stop a failure from failing the run, on a step or on a job. */
const NEUTRALISING = /^\s*continue-on-error\s*:\s*(.+?)\s*$/;

interface Located {
  /** 0-based index of the `- name:` line that opens the step. */
  readonly stepStart: number;
  /** Lines of the step block, the opening line included. */
  readonly step: readonly string[];
  /** The job key that holds the step, e.g. `backend`. */
  readonly job: string;
  /** Lines of the job block above the first step, where job-level keys live. */
  readonly jobHeader: readonly string[];
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

  // The job's own keys: from the job line down to its `steps:` key.
  let stepsKey = lines.length;
  for (let i = jobLine + 1; i < lines.length; i++) {
    if (/^ {4}steps:\s*$/.test(lines[i] as string)) {
      stepsKey = i;
      break;
    }
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i] as string)) break;
  }

  return {
    stepStart,
    step: lines.slice(stepStart, stepEnd),
    job,
    jobHeader: lines.slice(jobLine, Math.min(stepsKey, lines.length)),
  };
}

/** Every neutralising key found on the step or on its job, named with where. */
function neutralisers(source: string): string[] {
  const found: string[] = [];
  const at = locate(source);
  if (!at) return ['the gate step was not found at all'];
  for (const line of at.step) {
    const m = NEUTRALISING.exec(line);
    if (m && m[1] !== 'false') found.push(`step: ${line.trim()}`);
  }
  for (const line of at.jobHeader) {
    const m = NEUTRALISING.exec(line);
    if (m && m[1] !== 'false') found.push(`job ${at.job}: ${line.trim()}`);
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
    expect(found.jobHeader.join('\n'), 'the job header does not carry runs-on').toContain('runs-on:');
  });

  it('the step carries no key that stops its failure from failing the run', () => {
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
    const planted = CI.replace(/^(  backend:\n)/m, '$1    continue-on-error: true\n');
    expect(planted, 'the job-level plant did not apply').not.toBe(CI);
    const reported = neutralisers(planted);
    expect(reported.length, 'the checker missed a job-level continue-on-error').toBeGreaterThan(0);
    expect(reported.join(' | ')).toContain('job backend:');
  });

  it('the script the gate names still exists and still hands the runner the suite directory', () => {
    const scripts = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
    const body = scripts['test:db:billing'];
    expect(body, 'package.json no longer defines test:db:billing, so the gate runs nothing').toBeTruthy();
    expect(body as string).toContain('packages/billing/test/db');
  });
});
