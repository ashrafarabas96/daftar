#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 4 SEAL GATE — `npm run gate:phase4:release` (alias `gate:phase4`)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Phase 1 has `gate:phase1:release`, Phase 2 `gate:phase2:release`, Phase 3
 * `gate:phase3:release`. Phase 4 had only the four slice gates, so no single
 * command could say "this tree may be sealed". This is that command.
 *
 * WHAT IT COMPOSES (in this order, all mandatory, stop at the first failure)
 *
 *   — the permanent core: library build, runner canary, migration manifest,
 *     Phase 4 prefix, budget ratchet, format, lint, typecheck, unit tests;
 *   — the PREDECESSOR chain, verbatim: `gate:phase3:release`, which composes
 *     the Phase 2 release gate, the Phase 1 release gate and the permanent
 *     Phase 3 corrective gate. A Phase 4 seal cannot pass over a broken
 *     predecessor;
 *   — the live database steps CI runs before the slices: migrate, re-migrate,
 *     history verify, integration + security, golden regression;
 *   — EVERY Phase 4 slice gate the PLAN declares. The roster is read from
 *     docs/PHASE_4_EXECUTION_PLAN.md (the Gate line of each slice), not from
 *     what happens to be built. A slice the plan declares and the tree does not
 *     build (today P4-S5 … P4-S8) is a FAIL that names it; a slice the tree
 *     builds and the plan does not declare is a FAIL too. The built slices
 *     (gate:phase4:s1 …) are composed with the measured budget suites CI runs
 *     between them;
 *   — the closing CI steps: process-composition red proof, plan-evidence
 *     contract and target measurement, the tampered-migration hard-fail
 *     proof, the database-from-zero contract and the API build.
 *
 * WHAT IT REFUSES TO CALL A PASS
 *
 *   «A gate that reports PASS without running its subject is the defect.»
 *
 *   — a step that did not run is `not_run`; a step that was skipped is
 *     `skipped`; neither is a pass and either makes the verdict FAIL. The
 *     only verdict that is not FAIL is PASS, and PASS needs every planned step
 *     to carry the status `pass`;
 *   — an exit status is read off the spawn RESULT (never through a pipe) and
 *     a signal is a failure;
 *   — an exit 0 is not enough. A slice gate's output must carry its own PASS
 *     verdict and must NOT say it ran structurally only or that a runtime
 *     check was not run. A Vitest step's summary must show test files, at
 *     least one passing test, and no failed, skipped or todo test;
 *   — any `RELEASE_GATE_SKIP_*` in the environment refuses the run;
 *   — `--structural-only` exists for the red proofs and for the roster check:
 *     it exits 3 when clean (never 0) and its verdict is
 *     `STRUCTURAL_ONLY_NOT_A_SEAL`.
 *
 * FALSIFIABILITY
 *
 *   `npm run gate:phase4:release -- --prove-red` plants defects in the verdict
 *   machinery (a slice whose gate exits 0 but says it did not run its
 *   runtime checks, a slice dropped from the plan, a skipped step, a vitest
 *   step with skipped tests, a slice gate that failed, …) and exits 0 only if
 *   every one is caught BY NAME. `--root <dir> --structural-only` points the
 *   roster check at a copy of the tree, which is how an undeclared slice
 *   gate is shown to turn it red.
 *
 * WHAT A GATE CANNOT SEAL (listed in the evidence as `notGateCheckable`)
 *
 *   Owner decisions, the independent review and its signature, the merge. A
 *   script cannot hold them and does not pretend to.
 *
 * WHAT RUNS TWICE, AND WHY THAT IS ACCEPTED
 *
 *   `gate:phase4:s1` composes the Phase 3 corrective gate, which
 *   `gate:phase3:release` has already run. Avoiding that would need a switch
 *   on a predecessor gate that skips its own steps, and a predecessor gate
 *   with a skip switch is a weakened gate. Nothing is relaxed; time is spent.
 *
 * NAME
 *
 *   The plan calls the closing gate `gate:phase4:release`. That is the canonical
 *   script; `gate:phase4` is kept as an alias of the identical command, and the
 *   preflight fails if either differs from `tsx scripts/phase4-gate.ts`.
 *
 * Usage:
 *   npm run gate:phase4:release [-- --evidence=<file.json>] [--log-dir=<dir>] [--list]
 *                       [--root <dir> --structural-only] [--prove-red]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Client } from 'pg';
import { libraryBuildOrder } from './phase3-release-gate';

const npm = 'npm';
const win = process.platform === 'win32';

// ─────────────────────────────────────────────────────────────────────────
// The roster. Closed on purpose: a slice gate that exists in package.json and
// is not here is a FAIL, and so is a slice here that package.json lacks.
// ─────────────────────────────────────────────────────────────────────────

export const SLICES: readonly string[] = ['s1', 's2', 's3', 's4'];

export const PLAN_DOC = 'docs/PHASE_4_EXECUTION_PLAN.md';

/**
 * Slices that legitimately have a heading and no gate line. Each is classified with its reason, so the
 * roster is total: every `P4-SN` heading is either a captured Gate line or listed here, and anything else is a FAIL.
 */
export const UNGATED_HEADINGS: Readonly<Record<string, string>> = {
  s0: 'the architecture lock: a design slice that has no gate',
  s9: 'release closure: its gate IS gate:phase4:release, that is this script',
};

export interface PlanAnalysis {
  readonly slices: string[];
  readonly headings: string[];
  readonly classified: Record<string, string>;
  readonly problems: string[];
}

const bySliceNo = (a: string, b: string): number => Number(a.slice(1)) - Number(b.slice(1));

/**
 * Total parse of the plan. Three independent views must agree: the `P4-SN` headings, the "**Gate.** `gate:phase4:sN`" lines,
 * and every mention of `gate:phase4:sN` / `gate:phase4:release` anywhere in the text. A heading with no Gate line and
 * no classification, a mention nobody declared, or a Gate line without a heading is a named problem — never silence.
 */
export function analysePlan(text: string): PlanAnalysis {
  const problems: string[] = [];
  const slices: string[] = [];
  for (const m of text.matchAll(/\*\*Gate\.\*\*\s+`gate:phase4:(s\d+)`/g)) {
    const s = m[1] as string;
    if (!slices.includes(s)) slices.push(s);
  }
  slices.sort(bySliceNo);
  const headings: string[] = [];
  for (const m of text.matchAll(/^#{2,4}[ \t]*P4-S(\d+)\b/gm)) {
    const s = `s${m[1] as string}`;
    if (!headings.includes(s)) headings.push(s);
  }
  headings.sort(bySliceNo);
  const classified: Record<string, string> = {};
  if (headings.length === 0) problems.push(`${PLAN_DOC} has no "P4-SN" heading — nothing to derive a roster from`);
  for (const s of headings) {
    if (slices.includes(s)) continue;
    const why = UNGATED_HEADINGS[s];
    if (why !== undefined) classified[s] = why;
    else
      problems.push(
        `P4-${s.toUpperCase()} has a heading in ${PLAN_DOC} but no "**Gate.** \`gate:phase4:${s}\`" line and no declared classification — the roster would silently omit it`,
      );
  }
  for (const s of slices) {
    if (!headings.includes(s)) problems.push(`${PLAN_DOC} has a Gate line for gate:phase4:${s} but no P4-${s.toUpperCase()} heading`);
  }
  const mentioned = new Set<string>();
  for (const m of text.matchAll(/gate:phase4:(s\d+|release)\b/g)) mentioned.add(m[1] as string);
  for (const s of [...mentioned].filter((x) => x !== 'release').sort(bySliceNo)) {
    if (!slices.includes(s)) problems.push(`${PLAN_DOC} mentions gate:phase4:${s} but no Gate line declares it — the analysis did not capture it`);
  }
  if (mentioned.has('release') && classified['s9'] === undefined) {
    problems.push(`${PLAN_DOC} mentions gate:phase4:release but no P4-S9 heading classifies it as the release gate`);
  }
  return { slices, headings, classified, problems };
}

export function parsePlannedSlices(text: string): string[] {
  return analysePlan(text).slices;
}

export function plannedSlices(root: string): PlanAnalysis & { sha256: string | null } {
  const path = join(root, PLAN_DOC);
  if (!existsSync(path)) {
    return {
      slices: [],
      headings: [],
      classified: {},
      sha256: null,
      problems: [`${PLAN_DOC} is missing — the roster is derived from the plan, so without it no seal can be judged`],
    };
  }
  const raw = readFileSync(path);
  const a = analysePlan(raw.toString('utf8'));
  return {
    ...a,
    sha256: createHash('sha256').update(raw).digest('hex'),
    problems: a.slices.length === 0 ? [...a.problems, `${PLAN_DOC} declares no gate:phase4:sN gate`] : a.problems,
  };
}

export interface TreeIdentity {
  readonly root: string;
  readonly head: string | null;
  readonly dirty: boolean | null;
  readonly dirtyEntries: number | null;
  readonly planSha256: string | null;
  readonly manifestSha256: string | null;
  readonly notes: string[];
  readonly problems: string[];
}

const norm = (x: string): string => resolve(x).split(sep).join('/').toLowerCase();
const same = (a: string, b: string): boolean => norm(a) === norm(b);

/** What was measured: the resolved root, its HEAD, whether it is dirty, and the sha256 of the plan the roster came from. Measured, never inferred. */
export function measureTree(root: string): TreeIdentity {
  const problems: string[] = [];
  const notes: string[] = [];
  const abs = resolve(root);
  const git = (...args: string[]): { ok: boolean; out: string } => {
    const r = spawnSync('git', ['-C', abs, ...args], { encoding: 'utf8' });
    return { ok: r.status === 0 && r.error === undefined, out: (r.stdout ?? '').trim() };
  };
  const manifestPath = join(abs, 'DELIVERY_MANIFEST.json');
  const manifestSha256 = existsSync(manifestPath) ? createHash('sha256').update(readFileSync(manifestPath)).digest('hex') : null;
  let head: string | null = null;
  let dirty: boolean | null = null;
  let dirtyEntries: number | null = null;
  const top = git('rev-parse', '--show-toplevel');
  if (!top.ok || !same(top.out, abs)) {
    if (manifestSha256 === null) {
      problems.push(
        `HEAD could not be measured: ${abs} is not the root of a git tree and carries no DELIVERY_MANIFEST.json — a result cannot be attributed to one fingerprint`,
      );
    } else notes.push(`HEAD not measured: ${abs} is not a git tree; identified by the sha256 of its DELIVERY_MANIFEST.json only`);
  } else {
    const h = git('rev-parse', 'HEAD');
    if (h.ok && /^[0-9a-f]{40}$/.test(h.out)) head = h.out;
    else problems.push('HEAD could not be measured: git rev-parse HEAD failed');
    const st = git('status', '--porcelain');
    if (!st.ok) problems.push('git status --porcelain failed — whether the tree is dirty is unknown');
    else {
      dirtyEntries = st.out === '' ? 0 : st.out.split('\n').length;
      dirty = dirtyEntries > 0;
      if (dirty)
        problems.push(
          `the tree is DIRTY (${dirtyEntries} entr${dirtyEntries === 1 ? 'y' : 'ies'} in git status --porcelain) — a seal cannot be claimed on a tree that is not exactly HEAD`,
        );
    }
  }
  const planSha256 = plannedSlices(abs).sha256;
  if (planSha256 === null) problems.push(`${PLAN_DOC} could not be hashed — the roster's source is not identified`);
  return { root: abs, head, dirty, dirtyEntries, planSha256, manifestSha256, notes, problems };
}

/** Workspaces whose package.json has a `test` script that the root `test` script does not run. A sixth workspace must not be silently unmeasured. */
export function unitWorkspaces(root: string): { names: string[]; problems: string[] } {
  const problems: string[] = [];
  if (!existsSync(join(root, 'package.json'))) return { names: [], problems: [`${join(root, 'package.json')} is missing`] };
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[]; scripts?: Record<string, string> };
  const names = [...(pkg.scripts?.['test'] ?? '').matchAll(/npm run test -w (@[\w./-]+)/g)].map((m) => m[1] as string);
  for (const dir of pkg.workspaces ?? []) {
    const p = join(root, dir, 'package.json');
    if (!existsSync(p)) continue;
    const w = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; scripts?: Record<string, string> };
    if (w.scripts?.['test'] !== undefined && w.name !== undefined && !names.includes(w.name)) {
      problems.push(`workspace ${w.name} has a test script that the root "npm test" does not run — its summary would never be counted`);
    }
  }
  return { names, problems };
}

/** What a script must say, verbatim, for a slice to be the accepted gate (a flag added to weaken it is a finding). */
const sliceCommand = (s: string): string => `tsx scripts/phase4-${s}-gate.ts`;

/** Things no script can decide. They are printed and recorded, never silently omitted. */
export const NOT_GATE_CHECKABLE: readonly string[] = [
  'a slice gate the plan declares and the tree has not built is not "not checkable": it FAILS by name (unbuiltSlices in the evidence). Until P4-S5 … P4-S8 are built no run of this gate can be a PASS',
  'DR-01/DR-02/DR-03: owner decisions on 07c782f, the C-1 fix and migrations 0080–0086 (OWNER_DECISIONS_AR.md)',
  'independent review of the exact head, and the signature that belongs to that one SHA only',
  'red-before-green ORDER of DR-10 / DR-13 / DR-14 (a property of commit history; an extracted archive carries none)',
  'the merge into main and the INFRA (PR #14) merge that frees the CI database steps',
  'removal of the CANDIDATE-TENSE fence at acceptance (the s4 gate polices its presence, the owner decides the acceptance)',
];

export function rosterProblems(root: string, declared: readonly string[] = SLICES, planned?: readonly string[]): string[] {
  const problems: string[] = [];
  let plan: readonly string[];
  if (planned !== undefined) plan = planned;
  else {
    const r = plannedSlices(root);
    problems.push(...r.problems);
    plan = r.slices;
  }
  for (const s of plan) {
    if (!declared.includes(s))
      problems.push(`P4-${s.toUpperCase()} is declared by ${PLAN_DOC} but its slice gate is not built into this tree — the seal gate refuses to pass over it`);
  }
  for (const s of declared) {
    if (plan.length > 0 && !plan.includes(s)) problems.push(`slice ${s} is composed by the seal gate but ${PLAN_DOC} does not declare it`);
  }
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return [`${pkgPath} is missing`];
  const scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  const found = Object.keys(scripts)
    .map((k) => /^gate:phase4:(s\d+)$/.exec(k)?.[1])
    .filter((s): s is string => s !== undefined);
  const filesDir = join(root, 'scripts');
  const files = existsSync(filesDir)
    ? readdirSync(filesDir)
        .map((f) => /^phase4-(s\d+)-gate\.ts$/.exec(f)?.[1])
        .filter((s): s is string => s !== undefined)
    : [];
  for (const s of new Set([...found, ...files])) {
    if (!declared.includes(s))
      problems.push(`slice gate ${s} exists in the tree (package.json or scripts/) but the Phase 4 seal gate's roster does not compose it`);
  }
  for (const s of declared) {
    if (!found.includes(s)) problems.push(`the roster names slice ${s} but package.json has no gate:phase4:${s}`);
    if (!files.includes(s)) problems.push(`the roster names slice ${s} but scripts/phase4-${s}-gate.ts does not exist`);
    const cmd = scripts[`gate:phase4:${s}`];
    if (cmd !== undefined && cmd.trim() !== sliceCommand(s)) {
      problems.push(`gate:phase4:${s} is "${cmd}" — the accepted command is "${sliceCommand(s)}" (an added flag is a weakened gate)`);
    }
  }
  for (const name of ['gate:phase4:release', 'gate:phase4']) {
    const c = scripts[name];
    if (c === undefined) problems.push(`package.json has no ${name} script`);
    else if (c.trim() !== 'tsx scripts/phase4-gate.ts') problems.push(`${name} is "${c}" — the accepted command is "tsx scripts/phase4-gate.ts"`);
  }
  return problems;
}

/** Set by the identity step; the evidence artefact records exactly what that step measured. */
let measuredTree: TreeIdentity | undefined;

function treeIsAPhase4Candidate(root: string): string[] {
  const manifestPath = join(root, 'DELIVERY_MANIFEST.json');
  if (!existsSync(manifestPath)) {
    console.log('   (no delivery manifest — the identity is the measured git root, HEAD and clean/dirty state recorded in the evidence)');
    return [];
  }
  let phase: unknown;
  try {
    phase = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { phase?: unknown }).phase;
  } catch (e) {
    return [`DELIVERY_MANIFEST.json is not readable JSON: ${e instanceof Error ? e.message : String(e)}`];
  }
  return phase === 4 ? [] : [`DELIVERY_MANIFEST.json says phase ${JSON.stringify(phase)}; the Phase 4 seal gate gates a Phase 4 candidate only`];
}

// ─────────────────────────────────────────────────────────────────────────
// Evidence validators. An exit status of 0 is necessary, never sufficient.
// ─────────────────────────────────────────────────────────────────────────

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const clean = (s: string): string => s.replace(ANSI, '');

export interface Tally {
  readonly files: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly todo: number;
}

/** Sum every Vitest `Test Files` / `Tests` summary line in a log. */
export function vitestTally(output: string): Tally & { readonly summaries: number } {
  const text = clean(output);
  const count = (line: string, word: string): number => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  let files = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  let summaries = 0;
  for (const line of text.split('\n')) {
    if (/^\s*Test Files\s+\d/.test(line)) files += count(line, 'passed') + count(line, 'failed') + count(line, 'skipped');
    if (/^\s*Tests\s+\d/.test(line)) {
      summaries += 1;
      passed += count(line, 'passed');
      failed += count(line, 'failed');
      skipped += count(line, 'skipped');
      todo += count(line, 'todo');
    }
  }
  return { files, passed, failed, skipped, todo, summaries };
}

export function vitestEvidence(label: string, minSummaries = 1): (out: string) => string[] {
  return (out) => {
    const t = vitestTally(out);
    const p: string[] = [];
    if (t.summaries < minSummaries) p.push(`${label}: expected ${minSummaries} Vitest summary line(s), found ${t.summaries} — the subject did not run`);
    if (t.passed < 1) p.push(`${label}: no passing test reported — a runner that asserted nothing is not evidence`);
    if (t.failed > 0) p.push(`${label}: ${t.failed} failed test(s)`);
    if (t.skipped > 0) p.push(`${label}: ${t.skipped} skipped test(s) — a skipped test is not a pass`);
    if (t.todo > 0) p.push(`${label}: ${t.todo} todo test(s) — a todo test is not a pass`);
    return p;
  };
}

/** The gate must say its own PASS, and must not say it ran less than everything. */
export function sliceEvidence(slice: string): (out: string) => string[] {
  return (out) => {
    const text = clean(out);
    const p: string[] = [];
    const passLine = slice === 's1' ? /P4-S1 GATE: PASS(?! \(structural checks only\))/ : new RegExp(`PASS gate:phase4:${slice} at `);
    if (!passLine.test(text)) p.push(`gate:phase4:${slice} printed no PASS verdict of its own — an exit status alone is not evidence`);
    if (/NOT RUN \(--structural-only\)/.test(text)) p.push(`gate:phase4:${slice} reports that runtime checks did NOT run (structural-only) — not a pass`);
    if (/PASS \(structural checks only\)|STRUCTURAL_PASS/.test(text)) p.push(`gate:phase4:${slice} ran structurally only — not a pass`);
    return p;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────

export type StepStatus = 'pass' | 'fail' | 'skipped' | 'not_run';

export interface Step {
  readonly id: string;
  readonly name: string;
  readonly kind: 'command' | 'in-process';
  readonly cmd?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Structural steps are the only ones `--structural-only` runs. */
  readonly structural: boolean;
  readonly fn?: () => string[] | Promise<string[]>;
  readonly validate?: (output: string) => string[];
  /** `slice:<n>` marks a Phase 4 slice gate; the verdict machinery requires every roster slice to have such a step. */
  readonly slice?: string;
}

export interface Result {
  readonly id: string;
  readonly name: string;
  status: StepStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  log: string | null;
  problems: string[];
}

interface Options {
  readonly root: string;
  readonly list: boolean;
  readonly structuralOnly: boolean;
  readonly proveRed: boolean;
  readonly evidence: string;
  readonly logDir: string;
}

export function parseOptions(argv: readonly string[]): Options {
  const value = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq !== undefined) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value (got ${v === undefined ? 'nothing' : JSON.stringify(v)})`);
    return v;
  };
  const rootArg = value('root');
  const root = rootArg !== undefined ? resolve(rootArg) : join(__dirname, '..');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    root,
    list: argv.includes('--list'),
    structuralOnly: argv.includes('--structural-only'),
    proveRed: argv.includes('--prove-red'),
    evidence: resolve(value('evidence') ?? join(root, 'release', 'phase4-seal-gate.json')),
    logDir: resolve(value('log-dir') ?? join(root, 'release', `phase4-gate-logs-${stamp}`)),
  };
}

async function databaseReachable(): Promise<string[]> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    return ['DATABASE_URL is not set — the live database steps cannot run, and a step that cannot run is a FAIL, not a skip'];
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return [];
  } catch (e) {
    return [`DATABASE_URL is set but the server is not reachable: ${e instanceof Error ? e.message : String(e)}`];
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** CI's "Tampered-migration hard-fail proof", done in process: plant a foreign history row, require verify:history to refuse it, always remove it. */
async function tamperedMigrationProof(root: string): Promise<string[]> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') return ['DATABASE_URL is not set — the tampered-migration proof did not run'];
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  const problems: string[] = [];
  try {
    await client.connect();
    await client.query("INSERT INTO schema_migrations(name, sha256) VALUES ('9999_foreign_tamper.sql', 'deadbeef')");
    try {
      const res = spawnSync(npm, ['run', 'verify:history'], { cwd: root, encoding: 'utf8', env: process.env, shell: win });
      if (res.error !== undefined) problems.push(`verify:history could not be spawned: ${res.error.message}`);
      else if (res.status === 0) problems.push('tampered history was ACCEPTED by verify:history — the history gate is broken');
    } finally {
      await client.query("DELETE FROM schema_migrations WHERE name='9999_foreign_tamper.sql'");
    }
  } catch (e) {
    problems.push(`the tampered-migration proof did not complete: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
  return problems;
}

const cmd = (id: string, name: string, args: readonly string[], extra: Partial<Pick<Step, 'validate' | 'env' | 'structural' | 'slice'>> = {}): Step => ({
  id,
  name,
  kind: 'command',
  cmd: npm,
  args,
  structural: false,
  ...extra,
});

/** A slice the plan declares and the tree does not build: a step that can only fail, by name. */
const unbuiltStep = (s: string): Step => ({
  id: `slice-${s}`,
  name: `Phase 4 slice gate — P4-${s.toUpperCase()} (declared by the plan, NOT BUILT)`,
  kind: 'in-process',
  structural: true,
  slice: s,
  fn: () => [`P4-${s.toUpperCase()} is declared by ${PLAN_DOC} but gate:phase4:${s} does not exist in this tree — an unbuilt slice cannot be sealed over`],
});

export function sealPlan(o: Pick<Options, 'root' | 'logDir'>, slices: readonly string[] = SLICES, explicitPlanned?: readonly string[]): readonly Step[] {
  const planned = explicitPlanned ?? plannedSlices(o.root).slices;
  const sliceStep = (s: string): Step =>
    cmd(`slice-${s}`, `Phase 4 slice gate — P4-${s.toUpperCase()}`, ['run', '-s', `gate:phase4:${s}`], { validate: sliceEvidence(s), slice: s });
  const bySlice = new Map(slices.map((s) => [s, sliceStep(s)]));
  const slice = (s: string): readonly Step[] => (bySlice.has(s) ? [bySlice.get(s) as Step] : []);
  // Any slice the roster names that has no fixed position below still runs, after s4.
  const extra = slices.filter((s) => !['s1', 's2', 's3', 's4'].includes(s)).flatMap(slice);
  const unit = unitWorkspaces(o.root);
  const unbuilt = planned.filter((s) => !slices.includes(s)).map(unbuiltStep);
  return [
    {
      id: 'preflight',
      name: 'preflight: the roster agrees with the tree; no mandatory skip is set',
      kind: 'in-process',
      structural: true,
      fn: () => rosterProblems(o.root, slices, explicitPlanned),
    },
    {
      id: 'identity',
      name: 'tree identity: root, HEAD, clean/dirty and the plan hash are measured; a delivery manifest, if present, says phase 4',
      kind: 'in-process',
      structural: true,
      fn: () => {
        measuredTree = measureTree(o.root);
        return [...measuredTree.problems, ...treeIsAPhase4Candidate(o.root)];
      },
    },
    {
      id: 'libs',
      name: 'library packages built from source, in dependency order',
      kind: 'in-process',
      structural: false,
      fn: () => {
        const { order, problems } = libraryBuildOrder(o.root);
        if (problems.length > 0) return problems;
        for (const dir of order) {
          const res = spawnSync(npm, ['run', 'build', '-w', dir], { cwd: o.root, encoding: 'utf8', env: process.env, shell: win });
          if (res.status !== 0)
            return [`npm run build -w ${dir} exited ${res.status ?? res.signal ?? 'abnormally'}:\n${`${res.stdout ?? ''}${res.stderr ?? ''}`.slice(-1500)}`];
        }
        return [];
      },
    },
    cmd('canary', 'runner failure canaries, root and web (outside Vitest)', ['exec', '--', 'tsx', 'scripts/runner-canary.ts']),
    cmd('migrations-manifest', 'migration manifest check', ['run', '-s', 'check:migrations']),
    cmd('phase4-prefix', 'Phase 4 migration prefix', ['run', '-s', 'phase4-prefix']),
    cmd('budget-ratchet', 'budget ratchet (tighten-only, agrees with the lock)', ['run', '-s', 'check:budget-ratchet']),
    cmd('format', 'format', ['run', '-s', 'format']),
    cmd('lint', 'lint (no warning permitted)', ['run', '-s', 'lint'], { env: { NODE_OPTIONS: '--max-old-space-size=6144' } }),
    cmd('typecheck', 'typecheck', ['run', '-s', 'typecheck']),
    cmd('unit', `unit tests (one Vitest summary per workspace: ${unit.names.join(', ') || 'NONE FOUND'})`, ['test'], {
      validate: (out) => [
        ...unit.problems,
        ...(unit.names.length === 0 ? ['no workspace test commands were found in the root "test" script'] : []),
        ...vitestEvidence('npm test', unit.names.length)(out),
      ],
    }),
    // The predecessor chain, verbatim. Phase 4 is sealed over Phase 3, never beside it.
    cmd(
      'predecessor-phase3',
      'Phase 3 release gate (composes the Phase 2 and Phase 1 release gates and the Phase 3 corrective gate)',
      ['run', '-s', 'gate:phase3:release'],
      {
        validate: (out) =>
          /PHASE 3 RELEASE GATE: PASS/.test(clean(out))
            ? []
            : ['gate:phase3:release printed no "PHASE 3 RELEASE GATE: PASS" — an exit status alone is not evidence'],
      },
    ),
    {
      id: 'dist-removed',
      name: 'the source tree is a source tree again (the API build output is removed)',
      kind: 'in-process',
      structural: false,
      fn: () => {
        rmSync(join(o.root, 'apps/api/dist'), { recursive: true, force: true });
        return existsSync(join(o.root, 'apps/api/dist')) ? ['apps/api/dist is still present after being removed'] : [];
      },
    },
    { id: 'db-reachable', name: 'the live database is reachable (DATABASE_URL)', kind: 'in-process', structural: false, fn: databaseReachable },
    cmd('migrate', 'fresh database migrate (0000 → latest)', ['run', '-s', 'migrate']),
    cmd('re-migrate', 're-migrate latest → no-op', ['run', '-s', 'migrate']),
    cmd('verify-history', 'migration history verify', ['run', '-s', 'verify:history']),
    cmd('integration', 'integration + security + guard tests', ['run', '-s', 'test:integration'], { validate: vitestEvidence('test:integration') }),
    cmd('golden', 'golden regression suite', ['run', '-s', 'test:golden'], { validate: vitestEvidence('test:golden') }),
    ...slice('s1'),
    ...slice('s2'),
    ...slice('s3'),
    cmd('pos-budgets', 'POS read budgets — P4-A and P4-B, measured', ['exec', '--', 'vitest', 'run', 'tests/performance/pos-s3-budgets.test.ts'], {
      validate: vitestEvidence('pos-s3-budgets'),
    }),
    cmd('receivables-budgets', 'receivables read budgets — P4-D and P4-F, measured', ['run', '-s', 'perf:phase4:s4'], {
      validate: vitestEvidence('receivables-s4-budgets'),
    }),
    cmd('ar-setbased', 'set-based AR answer equivalence', ['exec', '--', 'vitest', 'run', 'tests/performance/receivables-ar-setbased-equivalence.test.ts'], {
      validate: vitestEvidence('receivables-ar-setbased-equivalence'),
    }),
    cmd('open-page', 'open-invoice page equivalence', ['exec', '--', 'vitest', 'run', 'tests/performance/receivables-open-page-equivalence.test.ts'], {
      validate: vitestEvidence('receivables-open-page-equivalence'),
    }),
    ...slice('s4'),
    ...extra,
    ...unbuilt,
    cmd('composition-red', 'process composition guard — planted-defect red proof', ['run', '-s', 'proof:composition:red']),
    cmd('plan-contract', 'plan-evidence contract', ['run', '-s', 'plan-evidence:contract'], { validate: vitestEvidence('plan-evidence-contract') }),
    cmd('plan-target', 'plan-evidence target measurement', ['run', '-s', 'plan-evidence:target', '--', '--measure']),
    { id: 'tampered', name: 'tampered-migration hard-fail proof', kind: 'in-process', structural: false, fn: () => tamperedMigrationProof(o.root) },
    cmd('db-from-zero', 'database contract from zero', ['run', '-s', 'check:db-from-zero']),
    cmd('api-build', 'API build', ['run', '-s', 'build', '-w', '@daftar/api']),
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// The verdict. Pure, so the red proofs can drive it with planted inputs.
// ─────────────────────────────────────────────────────────────────────────

/**
 * PASS needs: every roster slice has a step in the plan, and every planned step has a result whose
 * status is exactly `pass`. A missing result is `not_run`; `skipped`, `fail` and `not_run` are each a FAIL.
 */
export function judge(plan: readonly Step[], results: readonly Result[], roster: readonly string[] = SLICES): { verdict: 'PASS' | 'FAIL'; reasons: string[] } {
  const reasons: string[] = [];
  for (const s of roster) {
    if (!plan.some((st) => st.slice === s)) reasons.push(`slice ${s} is on the roster but the plan has no step that runs it`);
  }
  for (const st of plan) {
    const r = results.find((x) => x.id === st.id);
    if (r === undefined) reasons.push(`${st.id} (${st.name}) has no result — NOT_RUN`);
    else if (r.status === 'skipped') reasons.push(`${st.id} (${st.name}) was SKIPPED — a skipped step is red`);
    else if (r.status === 'not_run') reasons.push(`${st.id} (${st.name}) was NOT_RUN`);
    else if (r.status === 'fail') reasons.push(`${st.id} (${st.name}) FAILED${r.problems.length > 0 ? `: ${r.problems[0]?.split('\n')[0] ?? ''}` : ''}`);
    else if (r.status !== 'pass') reasons.push(`${st.id} has the unrecognised status ${String(r.status)}`);
  }
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}

// ─────────────────────────────────────────────────────────────────────────
// Red proofs (`--prove-red`)
// ─────────────────────────────────────────────────────────────────────────

export function proveRed(): { name: string; caught: boolean; by: string }[] {
  const o = { root: '/nowhere', logDir: '/nowhere/logs' };
  const plan = sealPlan(o);
  const ok = (st: Step): Result => ({ id: st.id, name: st.name, status: 'pass', exitCode: 0, signal: null, durationMs: 1, log: null, problems: [] });
  const allPass = plan.map(ok);
  const proofs: { name: string; caught: boolean; by: string }[] = [];
  const expectRed = (name: string, found: readonly string[], needle: RegExp): void => {
    const hit = found.find((r) => needle.test(r));
    proofs.push({ name, caught: hit !== undefined, by: hit ?? '(NOT CAUGHT)' });
  };
  // 0. Control: the unplanted machinery is green, or the proofs below mean nothing.
  proofs.push({ name: 'control: every step passes → PASS', caught: judge(plan, allPass).verdict === 'PASS', by: 'judge' });
  // 1. A slice dropped from the plan.
  for (const s of SLICES) {
    const dropped = sealPlan(
      o,
      SLICES.filter((x) => x !== s),
    );
    expectRed(
      `slice ${s} removed from the plan`,
      judge(
        dropped,
        allPass.filter((r) => r.id !== `slice-${s}`),
      ).reasons,
      new RegExp(`slice ${s} is on the roster but the plan has no step`),
    );
  }
  // 2. A slice step that never produced a result.
  expectRed(
    'a slice step has no result (NOT_RUN)',
    judge(
      plan,
      allPass.filter((r) => r.id !== 'slice-s3'),
    ).reasons,
    /slice-s3 .* NOT_RUN/,
  );
  // 3. A skipped step.
  expectRed(
    'a slice step is skipped',
    judge(
      plan,
      allPass.map((r) => (r.id === 'slice-s2' ? { ...r, status: 'skipped' as const } : r)),
    ).reasons,
    /slice-s2 .* SKIPPED/,
  );
  expectRed(
    'the predecessor chain is skipped',
    judge(
      plan,
      allPass.map((r) => (r.id === 'predecessor-phase3' ? { ...r, status: 'skipped' as const } : r)),
    ).reasons,
    /predecessor-phase3 .* SKIPPED/,
  );
  // 4. A failed predecessor.
  expectRed(
    'the predecessor chain fails',
    judge(
      plan,
      allPass.map((r) => (r.id === 'predecessor-phase3' ? { ...r, status: 'fail' as const, problems: ['x'] } : r)),
    ).reasons,
    /predecessor-phase3 .* FAILED/,
  );
  // 5. Evidence validators: exit 0 with the subject not run.
  const s4 = sliceEvidence('s4');
  expectRed(
    's4 exits 0 but ran structurally only',
    s4('ok   roster — x\nPASS gate:phase4:s4 at /r: 16 check(s) ok; 1 runtime check(s) NOT RUN (--structural-only) — not a pass'),
    /did NOT run/,
  );
  expectRed('s4 exits 0 but printed no verdict', s4('nothing useful'), /printed no PASS verdict/);
  expectRed('s1 structural-only PASS', sliceEvidence('s1')('P4-S1 GATE: PASS (structural checks only)'), /printed no PASS verdict|structurally only/);
  const v = vitestEvidence('suite');
  expectRed('vitest: skipped tests', v(' Test Files  1 passed (1)\n      Tests  3 passed | 2 skipped (5)'), /skipped test/);
  expectRed('vitest: todo tests', v(' Test Files  1 passed (1)\n      Tests  3 passed | 1 todo (4)'), /todo test/);
  expectRed('vitest: failed tests', v(' Test Files  1 failed (1)\n      Tests  1 failed | 3 passed (4)'), /failed test/);
  expectRed('vitest: no summary at all (exit 0 over nothing)', v('everything is fine'), /did not run/);
  expectRed('vitest: zero tests', v(' Test Files  1 passed (1)\n      Tests  0 passed (0)'), /no passing test/);
  expectRed(
    'npm test: a workspace reported nothing',
    vitestEvidence('npm test', 5)(' Test Files  1 passed (1)\n      Tests  4 passed (4)'),
    /expected 5 Vitest summary/,
  );
  // 6. The roster check against a tree whose package.json carries an undeclared slice gate.
  expectRed(
    'an undeclared slice gate exists in the tree',
    rosterProblems(
      join(__dirname, '..'),
      SLICES.filter((s) => s !== 's4'),
    ),
    /slice gate s4 exists in the tree .* does not compose it/,
  );

  // 7. The PLAN is the roster, not the build (review blocker 1). A slice the plan declares and the tree does
  //    not build must turn the verdict red BY NAME — through the plan, the roster check and the real runner.
  const planned8 = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
  const planned = sealPlan(o, SLICES, planned8);
  const unbuiltIds = ['s5', 's6', 's7', 's8'].map((s) => `slice-${s}`);
  proofs.push({
    name: 'the plan carries a step for every declared slice',
    caught: unbuiltIds.every((id) => planned.some((st) => st.id === id)),
    by: 'sealPlan',
  });
  for (const s of ['s5', 's6', 's7', 's8']) {
    const step = planned.find((st) => st.id === `slice-${s}`);
    expectRed(
      `slice ${s} is declared by the plan but not built`,
      step?.fn !== undefined ? (step.fn() as string[]) : [],
      new RegExp(`P4-${s.toUpperCase()} is declared .* does not exist`),
    );
    expectRed(
      `roster check: slice ${s} declared, not built`,
      rosterProblems(join(__dirname, '..'), SLICES, planned8),
      new RegExp(`P4-${s.toUpperCase()} is declared by .* not built`),
    );
  }
  expectRed(
    'roster check: a built slice the plan does not declare',
    rosterProblems(join(__dirname, '..'), SLICES, ['s1', 's2', 's3']),
    /slice s4 is composed by the seal gate but .* does not declare it/,
  );
  expectRed(
    'the plan document is missing → no roster, no seal',
    plannedSlices(join(tmpdir(), 'phase4-gate-no-such-root')).problems,
    /is missing — the roster is derived from the plan/,
  );
  proofs.push({
    name: 'the plan parser reads s1…s8 from the Gate lines',
    caught:
      parsePlannedSlices('**Gate.** `gate:phase4:s2` x\n**Gate.** `gate:phase4:s10` y\n**Gate.** `gate:phase4:s1`\nprose `gate:phase4:s9`').join() ===
      's1,s2,s10',
    by: 'parsePlannedSlices',
  });
  // 7b. The analysis is total (coordinator blocker B-1): headings, Gate lines and mentions must agree, or it is a named FAIL.
  const doc = (heads: Record<string, string>, extra = ''): string =>
    `${Object.entries(heads)
      .map(([n, gate]) => `### P4-${n.toUpperCase()} — x\n${gate}\n`)
      .join('\n')}${extra}`;
  const gl = (s: string): string => `**Gate.** \`gate:phase4:${s}\` — x`;
  const full = { s0: '', s1: gl('s1'), s5: gl('s5'), s9: 'closes with `gate:phase4:release`' };
  proofs.push({ name: 'analysis control: a consistent plan has no problem', caught: analysePlan(doc(full)).problems.length === 0, by: 'analysePlan' });
  const reworded = analysePlan(doc({ ...full, s5: '**Gate:** `gate:phase4:s5`' })).problems;
  expectRed('plan: S5 Gate line reworded ("**Gate:**") → the slice is not silently dropped', reworded, /P4-S5 has a heading .* no declared classification/);
  expectRed('plan: S5 Gate line reworded → the uncaptured mention is named too', reworded, /mentions gate:phase4:s5 but no Gate line declares it/);
  expectRed('plan: S5 Gate line without the backticks', analysePlan(doc({ ...full, s5: '**Gate.** gate:phase4:s5' })).problems, /P4-S5 has a heading/);
  expectRed('plan: a heading with no Gate line and no classification', analysePlan(doc({ ...full, s7: 'no gate here' })).problems, /P4-S7 has a heading/);
  expectRed(
    'plan: a mention nobody declared (prose names gate:phase4:s6)',
    analysePlan(doc(full, '\nsee also gate:phase4:s6\n')).problems,
    /mentions gate:phase4:s6 but no Gate line declares it/,
  );
  expectRed('plan: a Gate line without a heading', analysePlan(`${doc(full)}\n${gl('s4')}\n`).problems, /Gate line for gate:phase4:s4 but no P4-S4 heading/);
  expectRed(
    'plan: gate:phase4:release named but no S9 heading classifies it',
    analysePlan(doc({ s1: gl('s1') }, '\ngate:phase4:release\n')).problems,
    /mentions gate:phase4:release but no P4-S9 heading/,
  );
  expectRed('plan: no P4 heading at all', analysePlan('nothing').problems, /no "P4-SN" heading/);
  {
    const real = plannedSlices(join(__dirname, '..'));
    proofs.push({
      name: 'the real plan is total: every heading is a Gate line or a declared classification, every mention is captured',
      caught: real.problems.length === 0 && real.headings.length === real.slices.length + Object.keys(real.classified).length,
      by: real.problems[0] ?? `${real.slices.join(',')} + ${Object.keys(real.classified).join(',')}`,
    });
  }
  // 7c. The artefact names the tree it measured (coordinator blocker B-2). Real git trees, built on the spot.
  const idRoot = mkdtempSync(join(tmpdir(), 'phase4-gate-id-'));
  try {
    const sh = (cwd: string, ...args: string[]): void => {
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
        cwd,
        encoding: 'utf8',
      });
    };
    const repo = join(idRoot, 'repo');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, PLAN_DOC), doc(full));
    sh(repo, 'init', '-q');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'x');
    const headNow = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const clean0 = measureTree(repo);
    proofs.push({
      name: 'tree identity: a clean git tree records its own HEAD, clean, and the plan hash',
      caught: clean0.head === headNow && clean0.dirty === false && clean0.problems.length === 0 && /^[0-9a-f]{64}$/.test(clean0.planSha256 ?? ''),
      by: `head ${clean0.head ?? 'null'}`,
    });
    const nested = join(repo, 'sub');
    mkdirSync(nested);
    expectRed('tree identity: a sub-directory of a git tree is not that tree root', measureTree(nested).problems, /not the root of a git tree/);
    writeFileSync(join(repo, 'stray.txt'), 'x');
    expectRed('tree identity: an untracked file makes the tree DIRTY (no seal claimed)', measureTree(repo).problems, /tree is DIRTY/);
    rmSync(join(repo, 'stray.txt'));
    writeFileSync(join(repo, PLAN_DOC), `${doc(full)}\nedited`);
    expectRed('tree identity: an edited plan document is DIRTY too', measureTree(repo).problems, /tree is DIRTY/);
    proofs.push({
      name: 'tree identity: editing the plan changes its recorded sha256',
      caught: measureTree(repo).planSha256 !== clean0.planSha256,
      by: 'planSha256',
    });
    const bare = join(idRoot, 'bare');
    mkdirSync(join(bare, 'docs'), { recursive: true });
    writeFileSync(join(bare, PLAN_DOC), doc(full));
    expectRed(
      'tree identity: not a git tree and no manifest → HEAD unmeasured is a reason, not silence',
      measureTree(bare).problems,
      /HEAD could not be measured/,
    );
    writeFileSync(join(bare, 'DELIVERY_MANIFEST.json'), '{"phase":4}');
    const arch = measureTree(bare);
    proofs.push({
      name: 'tree identity: an archive is identified by its manifest hash and says HEAD was not measured',
      caught: arch.head === null && arch.manifestSha256 !== null && arch.notes.some((n) => /HEAD not measured/.test(n)),
      by: arch.notes[0] ?? '(no note)',
    });
    // N-3: the workspace floor is read from the source and names its workspaces.
    const ws = join(idRoot, 'ws');
    mkdirSync(join(ws, 'a'), { recursive: true });
    mkdirSync(join(ws, 'b'), { recursive: true });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ workspaces: ['a', 'b'], scripts: { test: 'npm run test -w @x/a' } }));
    writeFileSync(join(ws, 'a', 'package.json'), JSON.stringify({ name: '@x/a', scripts: { test: 'vitest run' } }));
    writeFileSync(join(ws, 'b', 'package.json'), JSON.stringify({ name: '@x/b', scripts: { test: 'vitest run' } }));
    const uw = unitWorkspaces(ws);
    proofs.push({ name: 'unit floor: names are read from the root test script', caught: uw.names.join() === '@x/a', by: uw.names.join() });
    expectRed('unit floor: a workspace with tests that npm test does not run is named', uw.problems, /workspace @x\/b has a test script/);
    const rootUw = unitWorkspaces(join(__dirname, '..'));
    proofs.push({
      name: 'unit floor: the real tree runs every workspace test script, and the floor is read, not typed',
      caught: rootUw.problems.length === 0 && rootUw.names.length >= 5,
      by: rootUw.names.join(','),
    });
  } finally {
    rmSync(idRoot, { recursive: true, force: true });
  }
  const optionsError = (argv: readonly string[]): string[] => {
    try {
      parseOptions(argv);
      return [];
    } catch (e) {
      return [String(e)];
    }
  };
  expectRed('options: --root with no value is refused, not swallowed', optionsError(['--root', '--structural-only']), /--root needs a value/);
  expectRed('options: --root as the last token is refused', optionsError(['--root']), /--root needs a value/);
  // 8. main() itself (review note 4): run the real runner against a scratch tree and read its exit code and text.
  const scratch = mkdtempSync(join(tmpdir(), 'phase4-gate-main-'));
  try {
    const real = join(__dirname, '..');
    const tree = (planSlices: readonly string[], name: string, gateLine: (s: string) => string = gl): string => {
      const dir = join(scratch, name);
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      mkdirSync(join(dir, 'docs'), { recursive: true });
      copyFileSync(join(real, 'package.json'), join(dir, 'package.json'));
      for (const s of SLICES) writeFileSync(join(dir, 'scripts', `phase4-${s}-gate.ts`), '');
      const heads: Record<string, string> = { s0: '', s9: 'closes with `gate:phase4:release`' };
      for (const s of planSlices) heads[s] = gateLine(s);
      writeFileSync(join(dir, PLAN_DOC), doc(heads));
      writeFileSync(join(dir, 'DELIVERY_MANIFEST.json'), '{"phase":4}');
      return dir;
    };
    interface Ran {
      status: number | null;
      out: string;
      evidence: string;
    }
    const run = (
      root: string,
      extra: readonly string[],
      env: Record<string, string> = {},
      flags: readonly string[] = ['--root', root, '--structural-only'],
    ): Ran => {
      const evidence = join(scratch, `${String(proofs.length)}-ev.json`);
      const res = spawnSync(npm, ['exec', '--', 'tsx', 'scripts/phase4-gate.ts', ...flags, `--evidence=${evidence}`, ...extra], {
        cwd: real,
        encoding: 'utf8',
        shell: win,
        env: { ...process.env, ...env },
      });
      return { status: res.status, out: clean(`${res.stdout ?? ''}${res.stderr ?? ''}`), evidence };
    };
    const mainProof = (name: string, r: Ran, status: number, needle: RegExp): void => {
      proofs.push({ name, caught: r.status === status && needle.test(r.out), by: `main() exit ${String(r.status)}` });
    };
    const unbuiltRun = run(tree(planned8, 'unbuilt'), []);
    mainProof('main(): a plan declaring s5–s8 → exit 1 naming P4-S5', unbuiltRun, 1, /P4-S5 is declared by/);
    mainProof('main(): the verdict line is not a pass', unbuiltRun, 1, /PHASE 4 SEAL GATE: FAIL/);
    const built = tree(['s1', 's2', 's3', 's4'], 'built');
    mainProof('main(): a fully built plan (archive, manifest), structural only → exit 3, never 0', run(built, []), 3, /STRUCTURAL_ONLY_NOT_A_SEAL/);
    mainProof('main(): RELEASE_GATE_SKIP_X → REFUSED, exit 1', run(built, [], { RELEASE_GATE_SKIP_X: '1' }), 1, /REFUSED/);
    mainProof('main(): RELEASE_GATE_SKIP_X with --list is refused too', run(built, ['--list'], { RELEASE_GATE_SKIP_X: '1' }), 1, /REFUSED/);
    mainProof(
      'main(): S5 and S6 Gate lines reworded → exit 1, no clean exit 3 (B-1)',
      run(
        tree(planned8, 'reworded', (s) => (s === 's5' || s === 's6' ? `**Gate:** \`gate:phase4:${s}\`` : gl(s))),
        [],
      ),
      1,
      /P4-S5 has a heading[\s\S]*P4-S6 has a heading/,
    );
    mainProof('main(): --root with no value → exit 1, not a swallowed flag', run(built, [], {}, ['--root', '--structural-only']), 1, /--root needs a value/);
    // B-2 through main(): the evidence of a git tree carries that tree's own HEAD, clean state and plan hash.
    const gitTree = tree(['s1', 's2', 's3', 's4'], 'gitclean');
    rmSync(join(gitTree, 'DELIVERY_MANIFEST.json'));
    const g = (...a: string[]): string =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], {
        cwd: gitTree,
        encoding: 'utf8',
      }).stdout.trim();
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'x');
    const cleanRun = run(gitTree, []);
    mainProof('main(): a clean git tree, built plan → exit 3', cleanRun, 3, /STRUCTURAL_ONLY_NOT_A_SEAL/);
    let recorded: { root?: string; head?: string | null; dirty?: boolean | null; planSha256?: string | null } = {};
    try {
      recorded = (JSON.parse(readFileSync(cleanRun.evidence, 'utf8')) as { tree: typeof recorded }).tree;
    } catch {
      /* stays empty → the proof below fails */
    }
    const planHash = createHash('sha256')
      .update(readFileSync(join(gitTree, PLAN_DOC)))
      .digest('hex');
    proofs.push({
      name: 'main(): the evidence records the resolved root, the measured HEAD, dirty=false and the plan sha256',
      caught: recorded.head === g('rev-parse', 'HEAD') && recorded.dirty === false && recorded.planSha256 === planHash && same(recorded.root ?? '', gitTree),
      by: `head ${String(recorded.head)}`,
    });
    writeFileSync(join(gitTree, 'stray.txt'), 'x');
    mainProof('main(): a dirty tree → exit 1 naming DIRTY (no seal on a dirty tree)', run(gitTree, []), 1, /tree is DIRTY/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return proofs;
}

// ─────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));

  if (o.proveRed) {
    const proofs = proveRed();
    for (const p of proofs) console.log(`${p.caught ? 'caught' : 'MISSED'}  ${p.name}  ←  ${p.by}`);
    const missed = proofs.filter((p) => !p.caught);
    console.log(
      missed.length === 0
        ? `\nPHASE 4 SEAL GATE red proofs: ${proofs.length} of ${proofs.length} caught by name`
        : `\nPHASE 4 SEAL GATE red proofs: ${missed.length} MISSED`,
    );
    process.exit(missed.length === 0 ? 0 : 1);
  }

  const plan = sealPlan(o).filter((s) => !o.structuralOnly || s.structural);
  const fullPlan = sealPlan(o);
  console.log(`PHASE 4 SEAL GATE${o.structuralOnly ? ' (structural checks only — NOT A SEAL)' : ''}\n`);

  const skips = Object.keys(process.env).filter((k) => k.startsWith('RELEASE_GATE_SKIP_'));
  if (skips.length > 0) {
    console.error(`REFUSED: a seal verdict may not be produced with ${skips.join(', ')} set.`);
    mkdirSync(dirname(o.evidence), { recursive: true });
    writeFileSync(o.evidence, `${JSON.stringify({ verdict: 'FAIL', mandatorySkips: skips, steps: [], producedAt: new Date().toISOString() }, null, 2)}\n`);
    process.exit(1);
  }
  if (!o.list && !o.structuralOnly) mkdirSync(o.logDir, { recursive: true });

  const results: Result[] = fullPlan.map((s) => ({
    id: s.id,
    name: s.name,
    status: 'not_run' as StepStatus,
    exitCode: null,
    signal: null,
    durationMs: 0,
    log: null,
    problems: [],
  }));
  const resultOf = (id: string): Result => results.find((r) => r.id === id) as Result;

  if (o.list) {
    for (const s of fullPlan)
      console.log(`  [mandatory] ${s.id} — ${s.name} — ${s.kind === 'command' ? [s.cmd, ...(s.args ?? [])].join(' ') : '(in process)'}`);
    console.log(`\n${fullPlan.length} steps planned. Nothing was run.`);
    return;
  }

  let stopped = false;
  for (const step of plan) {
    const r = resultOf(step.id);
    console.log(`\n── ${step.name}${step.kind === 'command' ? `\n   ${[step.cmd, ...(step.args ?? [])].join(' ')}` : ''}`);
    const started = Date.now();
    if (step.kind === 'in-process') {
      try {
        r.problems = await (step.fn?.() ?? []);
      } catch (e) {
        r.problems = [e instanceof Error ? e.message : String(e)];
      }
      r.exitCode = r.problems.length === 0 ? 0 : 1;
    } else {
      const res = spawnSync(step.cmd as string, [...(step.args ?? [])], {
        cwd: o.root,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0', ...(step.env ?? {}) },
        maxBuffer: 256 * 1024 * 1024,
        shell: win,
      });
      const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      const logFile = join(o.logDir, `${step.id}.log`);
      writeFileSync(logFile, output);
      r.log = relative(o.root, logFile).split('\\').join('/');
      r.exitCode = res.status;
      r.signal = res.signal;
      if (res.error !== undefined) r.problems.push(`could not be spawned: ${res.error.message}`);
      else if (res.signal !== null) r.problems.push(`terminated by signal ${res.signal}`);
      else if (res.status !== 0) r.problems.push(`exited ${String(res.status)}\n${clean(output).slice(-3000)}`);
      else r.problems.push(...(step.validate?.(output) ?? []));
    }
    r.durationMs = Date.now() - started;
    r.status = r.problems.length === 0 ? 'pass' : 'fail';
    console.log(`   ${r.status === 'pass' ? 'PASS' : `FAIL\n     ${r.problems.join('\n     ')}`} in ${(r.durationMs / 1000).toFixed(1)}s`);
    if (r.status === 'fail') {
      stopped = true;
      break; // a seal verdict is not a survey; everything after is recorded as not_run
    }
  }

  const plannedDoc = plannedSlices(o.root);
  const planned = plannedDoc.slices;
  const tree = measuredTree ?? measureTree(o.root);
  const { verdict: judged, reasons } = judge(fullPlan, results, [...new Set([...SLICES, ...planned])]);
  const verdict = o.structuralOnly ? (reasons.some((x) => !/NOT_RUN/.test(x)) ? 'FAIL' : 'STRUCTURAL_ONLY_NOT_A_SEAL') : judged;
  const artefact = {
    produced: 'scripts/phase4-gate.ts',
    producedAt: new Date().toISOString(),
    phase: 4,
    roster: SLICES,
    tree: { ...tree, planDoc: PLAN_DOC, planSha256: plannedDoc.sha256, planClassifiedWithoutGate: plannedDoc.classified, planHeadings: plannedDoc.headings },
    plannedByDocs: planned,
    unbuiltSlices: planned.filter((x) => !SLICES.includes(x)),
    structuralOnly: o.structuralOnly,
    environment: { node: process.version, platform: `${platform()}-${arch()}` },
    mandatorySkips: skips,
    steps: results,
    reasons,
    notGateCheckable: NOT_GATE_CHECKABLE,
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === 'pass').length,
      fail: results.filter((r) => r.status === 'fail').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      notRun: results.filter((r) => r.status === 'not_run').length,
    },
    verdict,
  };
  mkdirSync(dirname(o.evidence), { recursive: true });
  writeFileSync(o.evidence, `${JSON.stringify(artefact, null, 2)}\n`);

  console.log(`\nPHASE 4 SEAL GATE: ${verdict}`);
  console.log(`  ${artefact.summary.pass} pass, ${artefact.summary.fail} fail, ${artefact.summary.notRun} not run, ${artefact.summary.skipped} skipped`);
  if (verdict !== 'PASS') for (const x of reasons.slice(0, 12)) console.log(`  - ${x}`);
  console.log('  not checkable by a gate (owner / reviewer):');
  for (const x of NOT_GATE_CHECKABLE) console.log(`    · ${x}`);
  console.log(`  evidence: ${relative(o.root, o.evidence)}`);
  if (verdict === 'PASS') return;
  // A structural-only run that is clean is still not a seal: exit 3, never 0.
  process.exit(verdict === 'STRUCTURAL_ONLY_NOT_A_SEAL' && !stopped ? 3 : 1);
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  });
}
