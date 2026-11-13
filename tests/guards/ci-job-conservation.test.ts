/**
 * THE JOB-CONSERVATION LAW (owner decision DR-105, CI-SPEED phase 1).
 *
 * `backend` used to run everything. It now runs only what the three SEALED
 * laws pin to a job literally named `backend`, and the rest runs in three
 * sibling jobs that have NO `needs` on it. That is a speed change, and a
 * speed change is exactly the shape in which work silently disappears: a
 * step moved out of a job and into no job at all still leaves a green tick,
 * and a step left in two jobs still leaves a green tick. Neither is visible
 * from a run's result.
 *
 * `A green workflow is not evidence for a gate the workflow never ran.`
 *
 * So the split is not a convention anybody has to remember. It is written
 * down, in `docs/ci-speed/ci-job-conservation.json`, as a register of WHERE
 * each step of the pre-split `backend` job now runs, and this suite PARSES
 * `.github/workflows/ci.yml` and requires the file and the register to agree
 * in BOTH directions:
 *
 *   C-1  The register's arithmetic closes: every step of the pre-split job is
 *        either shared infrastructure or assigned to exactly one job, and
 *        `shared + assigned` equals the pre-split step count. 61 = 11 + 50,
 *        MEASURED on the baseline revision the register names.
 *   C-2  Every step the workflow runs in a job of the family is in the
 *        register — assigned to THAT job, or declared shared.
 *   C-3  Every assigned step appears in EXACTLY ONE job of the family, and it
 *        is the job the register names. Not zero (the work vanished) and not
 *        two (the work is paid for twice and the register is lying about it).
 *   C-4  Every step the register calls SHARED really does appear in two or
 *        more jobs. A register allowed to call a unique step "shared" would
 *        let any assignment be erased by moving its name into that list.
 *   C-5  The four jobs exist and each has steps — the positive control,
 *        because every count below is a count over them and a typo in a job
 *        name would otherwise make all of C-1..C-4 pass over nothing.
 *
 * And the negative controls, which are the whole point: each is planted on a
 * MUTATED COPY of the workflow text — never on disk, because `ci.yml` belongs
 * to another owner — and the check must come back red on every one.
 *
 * WHAT THIS LAW DOES NOT CLAIM. It is about step ASSIGNMENT, not about test
 * executions. The pre-split job deliberately ran many test files more than
 * once (the slice gates compose their predecessors, which is the composition
 * the phase gates are built on), so "each file runs once" was never true and
 * is not asserted here. The per-run test totals are the other half of the
 * conservation evidence and are read from the jobs' own Vitest summaries.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const CI_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');
const REGISTER_PATH = join(ROOT, 'docs', 'ci-speed', 'ci-job-conservation.json');

const ci = readFileSync(CI_PATH, 'utf8');

interface Register {
  baseline: { rev: string; job: string; steps: number; namesSha256: string };
  p2TestFileOverlaps: Record<string, string[]>;
  jobs: string[];
  totals: { shared: number; assigned: number };
  shared: string[];
  assignment: Record<string, string>;
}

const register = JSON.parse(readFileSync(REGISTER_PATH, 'utf8')) as Register;

/**
 * The steps of one top-level job, by the identity the register uses: the
 * step's `name:` when it has one, else its `uses:`, else the first line of
 * its `run:`.
 *
 * Read with a line scanner rather than a YAML parser on purpose. The planted
 * defects below mutate TEXT, and a parser would reformat what it re-emitted,
 * so the thing proved red would not be the thing a reviewer reads. The
 * workflow's indentation is fixed and this file is in the repository that
 * owns it: two spaces for a job, four for its keys, six for a step dash.
 */
function stepsOf(ciText: string, job: string): string[] {
  const lines = ciText.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const out: string[] = [];
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('      - ')) continue;
    const first = line.slice('      - '.length);
    const name = /^name:\s*(.+?)\s*$/.exec(first);
    if (name?.[1] !== undefined) {
      out.push(name[1]);
      continue;
    }
    const uses = /^uses:\s*(.+?)\s*$/.exec(first);
    if (uses?.[1] !== undefined) {
      out.push(uses[1]);
      continue;
    }
    // A bare `- run: ...` step, or a step whose `name:` is not its first key.
    // Both exist in this workflow; the register stores the same shape.
    const run = /^run:\s*(.+?)\s*$/.exec(first);
    if (run?.[1] !== undefined) {
      out.push(`run:${run[1]}`);
      continue;
    }
    // A step that opens with some other key (`shell:`, `with:`): find its
    // `name:` among the following lines of the same step.
    for (let k = i + 1; k < end; k += 1) {
      const l = lines[k] ?? '';
      if (l.startsWith('      - ')) break;
      const n = /^ {8}name:\s*(.+?)\s*$/.exec(l);
      if (n?.[1] !== undefined) {
        out.push(n[1]);
        break;
      }
    }
  }
  return out;
}

/**
 * The text of each step of one job, keyed by the step identity `stepsOf`
 * uses, in order. A step runs from its `      - ` dash to the next one.
 */
function stepBlocks(ciText: string, job: string): Array<{ name: string; text: string }> {
  const names = stepsOf(ciText, job);
  const lines = ciText.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const blocks: string[] = [];
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('      - ')) blocks.push(line);
    else if (blocks.length > 0) blocks[blocks.length - 1] += `\n${line}`;
  }
  return blocks.map((text, i) => ({ name: names[i] ?? `#${i}`, text }));
}

/**
 * A step that keeps its NAME but loses its work still passes C-1..C-4, so the
 * law also requires every step to do something: a non-empty `run:` or a
 * `uses:`, and no `if:` that is the literal `false`.
 */
function hollowProblems(ciText: string, reg: Register): string[] {
  const problems: string[] = [];
  for (const job of reg.jobs) {
    for (const { name, text } of stepBlocks(ciText, job)) {
      const hasWork = /(^|\n|- )\s*(run:\s*\S|uses:\s*\S)/.test(text);
      if (!hasWork) problems.push(`C-8: \`${name}\` in \`${job}\` has no \`run:\` and no \`uses:\` — a step with a name and no work`);
      if (/\n\s*if:\s*(false|'false'|"false"|\$\{\{\s*false\s*\}\})\s*(\n|$)/.test(text)) {
        problems.push(`C-8: \`${name}\` in \`${job}\` carries \`if: false\` — it can never run`);
      }
    }
  }
  return problems;
}

/**
 * The baseline fingerprint: the register may not be edited to forget a
 * step. C-1 compares two numbers the register itself states; this compares
 * the NAMES with a digest pinned in the same file, so removing a step from
 * the workflow AND from the register AND lowering both counts still fails.
 */
function fingerprintProblems(reg: Register): string[] {
  const names = [...reg.shared, ...Object.keys(reg.assignment)].sort();
  const digest = createHash('sha256').update(names.join('\n'), 'utf8').digest('hex');
  return digest === reg.baseline.namesSha256
    ? []
    : [
        `C-7: the ${names.length} step names of the register hash to ${digest}, not the pinned baseline ${reg.baseline.namesSha256} — a step was added to or dropped from the register`,
      ];
}

/** Everything wrong with `ciText` as judged against the committed register. */
function conservationProblems(ciText: string, reg: Register): string[] {
  const problems: string[] = [];
  const found = new Map<string, string[]>();

  for (const job of reg.jobs) {
    const steps = stepsOf(ciText, job);
    if (steps.length === 0) problems.push(`C-5: job \`${job}\` has no steps, or does not exist`);
    for (const step of steps) {
      if (!found.has(step)) found.set(step, []);
      (found.get(step) as string[]).push(job);
    }
  }

  // C-1 — the register closes over the pre-split job.
  if (reg.shared.length !== reg.totals.shared) {
    problems.push(`C-1: the register lists ${reg.shared.length} shared steps but declares ${reg.totals.shared}`);
  }
  const assignedKeys = Object.keys(reg.assignment);
  if (assignedKeys.length !== reg.totals.assigned) {
    problems.push(`C-1: the register assigns ${assignedKeys.length} steps but declares ${reg.totals.assigned}`);
  }
  if (reg.totals.shared + reg.totals.assigned !== reg.baseline.steps) {
    problems.push(
      `C-1: ${reg.totals.shared} shared + ${reg.totals.assigned} assigned = ` +
        `${reg.totals.shared + reg.totals.assigned}, but the pre-split \`${reg.baseline.job}\` job of ` +
        `${reg.baseline.rev} had ${reg.baseline.steps} steps — a step is unaccounted for`,
    );
  }

  // C-2 — nothing runs that the register does not know about.
  for (const [step, jobs] of found) {
    const assigned = reg.assignment[step];
    if (reg.shared.includes(step)) continue;
    if (assigned === undefined) {
      problems.push(`C-2: \`${step}\` runs in ${jobs.join(', ')} and is in neither list of the register`);
      continue;
    }
    for (const job of jobs) {
      if (job !== assigned) {
        problems.push(`C-2: \`${step}\` runs in \`${job}\` but the register assigns it to \`${assigned}\``);
      }
    }
  }

  // C-3 — every assigned step runs exactly once, in its own job.
  for (const [step, job] of Object.entries(reg.assignment)) {
    const jobs = found.get(step);
    if (jobs === undefined) {
      problems.push(`C-3: \`${step}\` is assigned to \`${job}\` and runs in NO job of the family — the work is gone`);
      continue;
    }
    if (jobs.length > 1) {
      problems.push(`C-3: \`${step}\` is assigned to \`${job}\` but runs in ${jobs.length} jobs: ${jobs.join(', ')}`);
    }
  }

  // C-4 — "shared" has to be earned.
  for (const step of reg.shared) {
    const jobs = found.get(step) ?? [];
    if (jobs.length < 2) {
      problems.push(
        `C-4: \`${step}\` is declared shared but runs in ${jobs.length} job(s) — ` + `a unique step in the shared list is an assignment nobody checks`,
      );
    }
  }

  problems.push(...fingerprintProblems(reg), ...hollowProblems(ciText, reg));
  return problems;
}

const PARTS = ['backend', 'backend-static', 'backend-gates-p2', 'backend-golden'];
const AGG_JOB = 'backend-required';
const CHECK_NAME = 'backend';

/** One top-level job's text, from its `  id:` line to the next job. */
function jobText(ciText: string, job: string): string {
  const lines = ciText.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** The check-run name each job reports: its `name:` when it has one, else its id. */
function checkNames(ciText: string): Map<string, string> {
  const lines = ciText.split('\n');
  const from = lines.findIndex((l) => l === 'jobs:');
  const out = new Map<string, string>();
  if (from < 0) return out;
  for (let i = from + 1; i < lines.length; i += 1) {
    const id = /^ {2}([A-Za-z0-9_-]+):$/.exec(lines[i] ?? '')?.[1];
    if (id === undefined) continue;
    const name = /^ {4}name:\s*(.+?)\s*$/m.exec(jobText(ciText, id))?.[1];
    out.set(id, name ?? id);
  }
  return out;
}

/** The `run: |` script of the aggregate's only step, dedented. */
function aggregateScript(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  if (at < 0) return '';
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const l = lines[i] ?? '';
    if (l.trim() !== '' && !l.startsWith(' '.repeat(10))) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

/** part -> the env variable the aggregate reads its `needs.<part>.result` through. */
function aggregateEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^ {10}([A-Z0-9_]+): \$\{\{ needs\.([A-Za-z0-9_-]+)\.result \}\}$/gm)) out.set(m[2] as string, m[1] as string);
  return out;
}

/**
 * C-9 / C-10 (DR-147/1, owner condition on #87): the required check named
 * `backend` is a job that only reads the four parts. Text-level shape.
 */
function aggregateProblems(ciText: string): string[] {
  const problems: string[] = [];
  const text = jobText(ciText, AGG_JOB);
  if (text === '') return [`C-9: there is no \`${AGG_JOB}\` job — nothing makes the required check \`${CHECK_NAME}\` depend on the parts`];
  if (!new RegExp(`^ {4}name: ${CHECK_NAME}$`, 'm').test(text)) {
    problems.push(`C-9: \`${AGG_JOB}\` is not named \`${CHECK_NAME}\` literally, so the required check \`${CHECK_NAME}\` is not this job`);
  }
  if (!/^ {4}if: always\(\)$/m.test(text)) {
    problems.push(`C-9: \`${AGG_JOB}\` has no \`if: always()\` — a skipped part would skip it, and a skipped required check reads as green`);
  }
  const needs = /^ {4}needs: \[(.*)\]$/m.exec(text)?.[1]?.split(',').map((s) => s.trim()) ?? [];
  for (const part of PARTS) {
    if (!needs.includes(part)) problems.push(`C-9: \`${AGG_JOB}\` does not \`need\` \`${part}\` — that part can fail while \`${CHECK_NAME}\` stays green`);
  }
  for (const extra of needs.filter((n) => !PARTS.includes(n))) problems.push(`C-9: \`${AGG_JOB}\` needs \`${extra}\`, which is not a part of the family`);
  if (/continue-on-error/.test(text)) problems.push(`C-9: \`${AGG_JOB}\` carries continue-on-error`);
  const env = aggregateEnv(text);
  for (const part of PARTS) {
    if (!env.has(part)) problems.push(`C-9: \`${AGG_JOB}\` does not read \`needs.${part}.result\``);
  }
  const reporting = [...checkNames(ciText)].filter(([, name]) => name === CHECK_NAME).map(([id]) => id);
  if (reporting.length !== 1 || reporting[0] !== AGG_JOB) {
    problems.push(`C-10: ${reporting.length} job(s) report a check named \`${CHECK_NAME}\` (${reporting.join(', ')}); exactly one, \`${AGG_JOB}\`, may`);
  }
  return problems;
}

/**
 * C-9, behaviour: run the aggregate's own script under bash with every
 * combination of one part in a non-success state. A skipped or cancelled part
 * must fail it exactly as a failed one does.
 */
function aggregateBehaviourProblems(ciText: string): string[] {
  const text = jobText(ciText, AGG_JOB);
  const script = aggregateScript(text);
  const env = aggregateEnv(text);
  if (script === '' || env.size === 0) return ['C-9: the aggregate has no script or no env to run'];
  const run = (state: Record<string, string>) => {
    const vars: Record<string, string> = {};
    for (const [part, key] of env) vars[key] = state[part] ?? 'success';
    return spawnSync('bash', ['-c', script], { env: { ...process.env, ...vars }, encoding: 'utf8' });
  };
  const problems: string[] = [];
  const ok = run({});
  if (ok.status !== 0) problems.push(`C-9: with every part \`success\` the aggregate exits ${String(ok.status)} (${ok.stderr.trim()})`);
  for (const part of PARTS) {
    for (const bad of ['failure', 'cancelled', 'skipped', '']) {
      const r = run({ [part]: bad });
      if (r.status === 0) problems.push(`C-9: \`${part}\` finished \`${bad === '' ? '(empty)' : bad}\` and the aggregate still exits 0`);
    }
  }
  return problems;
}

const P2_GATES = [1, 2, 3, 4, 5, 6, 7, 8];

/** The `P2_Sn_TESTS` rosters of the eight Phase 2 gate scripts, read from the files. */
function p2Overlaps(): Record<string, string[]> {
  const sets: Record<string, string[]> = {};
  for (const n of P2_GATES) {
    const text = readFileSync(join(ROOT, 'scripts', `phase2-s${n}-gate.ts`), 'utf8');
    const m = new RegExp(`const P2_S${n}_TESTS = \\[([\\s\\S]*?)\\n\\]`).exec(text);
    const body = (m?.[1] ?? '').replace(/\/\/[^\n]*/g, '');
    sets[`P2-S${n}`] = [...new Set([...body.matchAll(/'([^']+\.test\.ts)'/g)].map((x) => x[1] as string))].sort();
  }
  const out: Record<string, string[]> = {};
  for (const f of [...new Set(Object.values(sets).flat())].sort()) {
    const gates = Object.keys(sets).filter((g) => (sets[g] as string[]).includes(f));
    if (gates.length > 1) out[f] = gates;
  }
  return out;
}

describe('the job-conservation law (DR-105)', () => {
  it('C-5: the four jobs of the family exist and have steps', () => {
    expect(register.jobs).toEqual(['backend', 'backend-static', 'backend-gates-p2', 'backend-golden']);
    for (const job of register.jobs) expect(stepsOf(ci, job).length, job).toBeGreaterThan(0);
  });

  it('C-1: the register closes over the pre-split job — shared + assigned = its step count', () => {
    expect(register.totals.shared + register.totals.assigned).toBe(register.baseline.steps);
    expect(register.shared.length).toBe(register.totals.shared);
    expect(Object.keys(register.assignment).length).toBe(register.totals.assigned);
  });

  it('C-2, C-3, C-4: the workflow and the register agree in both directions', () => {
    const problems = conservationProblems(ci, register);
    expect(
      problems,
      `the split no longer matches docs/ci-speed/ci-job-conservation.json:\n  ${problems.join('\n  ')}\n\n` +
        `Either the workflow lost or duplicated a step, or the register was not updated with it. ` +
        `Whichever it is, say which in the commit message: a step that runs in no job is work that ` +
        `stopped happening behind a green tick.`,
    ).toEqual([]);
  });

  /**
   * THE NEGATIVE CONTROLS. The owner's condition was exact: dropping a file
   * from the split must FAIL THE LAW BY NAME. Three ways to break it, three
   * plants, each on a copy of the text.
   */
  it('RED: a step is dropped from every job of the family', () => {
    const planted = ci.replace(/ {6}- name: Golden regression suite\n {8}run: npm run test:golden\n {8}env:\n {10}PG_PORT: '5432'\n/, '');
    expect(planted, 'the golden step was not found to remove — update this proof').not.toBe(ci);
    const problems = conservationProblems(planted, register);
    expect(problems.join('\n')).toContain('Golden regression suite');
    expect(problems.join('\n')).toContain('the work is gone');
  });

  it('RED: a step runs in two jobs while the register still claims one', () => {
    const planted = ci;
    // Duplicate the Lint step — assigned to `backend-static` — into `backend-golden`.
    const dup = planted.replace(
      / {6}- name: Tampered-migration hard-fail proof\n/,
      '      - name: Lint\n        run: npm run lint\n      - name: Tampered-migration hard-fail proof\n',
    );
    expect(dup, 'the tamper step was not found to duplicate beside — update this proof').not.toBe(planted);
    const problems = conservationProblems(dup, register);
    expect(problems.join('\n')).toContain('`Lint` is assigned to `backend-static` but runs in 2 jobs');
  });

  it('RED: a step runs that the register knows nothing about', () => {
    const planted = ci.replace(
      / {6}- name: Tampered-migration hard-fail proof\n/,
      '      - name: A step nobody registered\n        run: echo nothing\n      - name: Tampered-migration hard-fail proof\n',
    );
    expect(planted, 'the tamper step was not found to insert beside — update this proof').not.toBe(ci);
    const problems = conservationProblems(planted, register);
    expect(problems.join('\n')).toContain('`A step nobody registered` runs in backend-golden and is in neither list');
  });

  it('RED: a step keeps its name and loses its work, or can never run', () => {
    const golden = /^ {6}- name: Golden regression suite\n {8}run: npm run test:golden\n/m;
    const hollow = ci.replace(golden, '      - name: Golden regression suite\n        shell: bash\n');
    expect(hollow, 'the golden step was not found to hollow out — update this proof').not.toBe(ci);
    expect(conservationProblems(hollow, register).join('\n')).toContain('`Golden regression suite` in `backend-golden` has no `run:`');
    const never = ci.replace(golden, '      - name: Golden regression suite\n        if: false\n        run: npm run test:golden\n');
    expect(never, 'the golden step was not found to disable — update this proof').not.toBe(ci);
    expect(conservationProblems(never, register).join('\n')).toContain('carries `if: false`');
  });

  it('RED: the register forgets a step and lowers both counts to match', () => {
    const victim = Object.keys(register.assignment)[0] as string;
    const rest = { ...register.assignment };
    delete rest[victim];
    const forged: Register = {
      ...register,
      assignment: rest,
      totals: { ...register.totals, assigned: register.totals.assigned - 1 },
      baseline: { ...register.baseline, steps: register.baseline.steps - 1 },
    };
    expect(fingerprintProblems(forged).join('\n')).toContain('C-7');
    expect(fingerprintProblems(register)).toEqual([]);
  });

  /**
   * C-6 — DR-105 accepts assignment BY GATE because the Phase 2 gates' file
   * sets overlap, on the condition that the overlaps are measured and named
   * file by file in the register. The register's list must equal the one
   * recomputed from the eight gate scripts, so a roster that changes without
   * the register fails here.
   */
  it('C-6: the register names every Phase 2 test-file overlap, file by file', () => {
    const measured = p2Overlaps();
    expect(Object.keys(measured).length, 'the probe found no overlap at all — it is blind, not the rosters disjoint').toBeGreaterThan(0);
    expect(register.p2TestFileOverlaps).toEqual(measured);
  });

  it('RED: a roster gains an overlap the register does not name', () => {
    const measured = p2Overlaps();
    const [any] = Object.keys(measured);
    const forged = { ...register.p2TestFileOverlaps };
    delete forged[any as string];
    expect(forged).not.toEqual(measured);
  });

  /**
   * AND THE CONTROL ON THE CONTROLS. A plant that the resolver cannot see is
   * worse than no plant, because it reads as a passing proof. Each plant above
   * asserts `.not.toBe(ci)` for that reason; this one proves the unplanted
   * text is clean, so the three reds above are the plants' doing and not a
   * pre-existing problem.
   */
  it('the unplanted workflow has no conservation problem at all', () => {
    expect(conservationProblems(ci, register)).toEqual([]);
  });
});

/**
 * C-9 / C-10 — the REQUIRED check. DR-147/1, owner condition on #87: the
 * required check named `backend` must still FAIL when any part of the family
 * fails, is cancelled or is skipped. After the split the work job holds only
 * part of the work, so the name `backend` is carried by a job that does none.
 */
describe('the required-check aggregate (DR-147/1)', () => {
  it('the unplanted workflow has no C-9 / C-10 problem, in text or in behaviour', () => {
    expect(aggregateProblems(ci)).toEqual([]);
    expect(aggregateBehaviourProblems(ci)).toEqual([]);
  });

  it('RED: a part is dropped from `needs`', () => {
    const planted = ci.replace('needs: [backend, backend-static, backend-gates-p2, backend-golden]', 'needs: [backend, backend-static, backend-gates-p2]');
    expect(planted, 'the needs line was not found to shorten — update this proof').not.toBe(ci);
    expect(aggregateProblems(planted).join('\n')).toContain('does not `need` `backend-golden`');
  });

  it('RED: `if: always()` is removed, so a skipped part would skip the aggregate', () => {
    const planted = ci.replace(/(\n {2}backend-required:\n {4}name: backend\n {4}needs: [^\n]*\n) {4}if: always\(\)\n/, '$1');
    expect(planted, 'the if line was not found to remove — update this proof').not.toBe(ci);
    expect(aggregateProblems(planted).join('\n')).toContain('no `if: always()`');
  });

  it('RED: the aggregate stops carrying the required name', () => {
    const planted = ci.replace(/(\n {2}backend-required:\n) {4}name: backend\n/, '$1    name: backend-gate\n');
    expect(planted, 'the name line was not found to change — update this proof').not.toBe(ci);
    const problems = aggregateProblems(planted).join('\n');
    expect(problems).toContain('is not named `backend` literally');
    expect(problems).toContain('C-10: 0 job(s) report a check named `backend`');
  });

  it('RED: the work job loses its distinct check name, so two check-runs are named `backend`', () => {
    const planted = ci.replace('  backend:\n    name: backend-work\n', '  backend:\n');
    expect(planted, 'the work job name line was not found to remove — update this proof').not.toBe(ci);
    expect(aggregateProblems(planted).join('\n')).toContain('C-10: 2 job(s) report a check named `backend` (backend, backend-required)');
  });

  it('RED: continue-on-error is added to the aggregate', () => {
    const planted = ci.replace(/(\n {2}backend-required:\n {4}name: backend\n)/, '$1    continue-on-error: true\n');
    expect(planted, 'the aggregate was not found to extend — update this proof').not.toBe(ci);
    expect(aggregateProblems(planted).join('\n')).toContain('carries continue-on-error');
  });

  it('RED (behaviour): the script accepts a SKIPPED or CANCELLED part, as a check on `failure` alone would', () => {
    const planted = ci.replace('if [ "$result" != "success" ]; then', 'if [ "$result" = "failure" ]; then');
    expect(planted, 'the script test was not found to weaken — update this proof').not.toBe(ci);
    const problems = aggregateBehaviourProblems(planted).join('\n');
    expect(problems).toContain('`backend-golden` finished `skipped` and the aggregate still exits 0');
    expect(problems).toContain('`backend` finished `cancelled` and the aggregate still exits 0');
  });

  it('RED (behaviour): one part is simply not read by the script', () => {
    const planted = ci.replace('for part in BACKEND_WORK BACKEND_STATIC BACKEND_GATES_P2 BACKEND_GOLDEN; do', 'for part in BACKEND_WORK BACKEND_STATIC BACKEND_GATES_P2; do');
    expect(planted, 'the loop line was not found to shorten — update this proof').not.toBe(ci);
    expect(aggregateBehaviourProblems(planted).join('\n')).toContain('`backend-golden` finished `failure` and the aggregate still exits 0');
  });
});
