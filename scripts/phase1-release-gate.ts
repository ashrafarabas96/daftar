#!/usr/bin/env tsx
/**
 * PHASE 1 RELEASE GATE (Directive §70–74, §77).
 *
 * `npm run gate:phase1:release` runs the COMPLETE command matrix a release
 * candidate must survive on a clean checkout, in order, and stops at the
 * first failure. Every step's full output is captured to a log directory and
 * a machine-readable evidence file (durations, exit codes, test counts) is
 * written so the acceptance report quotes real numbers, never claims.
 *
 * Nothing here is skippable by default. The ONLY opt-out is the Android
 * toolchain (RELEASE_GATE_SKIP_ANDROID=1) and it is printed as SKIPPED in the
 * summary and recorded in the evidence file — a skipped Android step is
 * visible, never silent.
 *
 * Usage:
 *   npm run gate:phase1:release [-- --evidence=<file.json>] [--log-dir=<dir>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string | undefined]));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = args.get('log-dir') ?? join(tmpdir(), `daftar-release-gate-${stamp}`);
const EVIDENCE = args.get('evidence');
mkdirSync(LOG_DIR, { recursive: true });

interface StepResult {
  name: string;
  command: string;
  status: 'pass' | 'fail' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  log: string;
  summary?: string;
}

const results: StepResult[] = [];
const REQUIRED_NODE_MAJOR = 24;

function cmdString(cmd: string, cmdArgs: string[]): string {
  return [cmd, ...cmdArgs].join(' ');
}

/** ANSI colour sequences are stripped before summary matching (FORCE_COLOR=0 is set, this is belt and braces). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Pull the human-facing summary lines (test counts, PASS lines) out of a log. */
function extractSummary(output: string): string | undefined {
  const lines = output
    .split('\n')
    .map((l) => l.replace(ANSI, '').trim())
    .filter(
      (l) =>
        /^Test Files\s/.test(l) ||
        /^Tests\s+\d/.test(l) ||
        /(STATIC GUARDS|LOCALIZATION CHECK|PHASE 1 GATE|Migration manifest OK|found 0 vulnerabilities|BUILD SUCCESSFUL|tests completed)/.test(l),
    );
  return lines.length > 0 ? lines.join(' | ') : undefined;
}

function run(name: string, cmd: string, cmdArgs: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const logFile = join(LOG_DIR, `${String(results.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
  process.stdout.write(`\n▶ ${name}\n  $ ${cmdString(cmd, cmdArgs)}\n`);
  const started = Date.now();
  const res = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}), FORCE_COLOR: '0', CI: process.env['CI'] ?? '1' },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    shell: false,
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  writeFileSync(logFile, output);
  const durationMs = Date.now() - started;
  const ok = res.status === 0;
  const summary = extractSummary(output);
  results.push({
    name,
    command: cmdString(cmd, cmdArgs),
    status: ok ? 'pass' : 'fail',
    exitCode: res.status,
    durationMs,
    log: logFile,
    ...(summary ? { summary } : {}),
  });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s)${summary ? ` — ${summary}` : ''}\n`);
  if (!ok) {
    const tail = output.trim().split('\n').slice(-40).join('\n');
    process.stdout.write(`  --- last lines of ${relative(ROOT, logFile)} ---\n${tail}\n`);
  }
  return ok;
}

function skip(name: string, reason: string): void {
  results.push({ name, command: '(skipped)', status: 'skipped', exitCode: null, durationMs: 0, log: '', summary: reason });
  process.stdout.write(`\n▶ ${name}\n  SKIPPED — ${reason}\n`);
}

function inProcess(name: string, fn: () => string[]): boolean {
  process.stdout.write(`\n▶ ${name}\n`);
  const started = Date.now();
  let problems: string[] = [];
  try {
    problems = fn();
  } catch (e) {
    problems = [e instanceof Error ? e.message : String(e)];
  }
  const durationMs = Date.now() - started;
  const logFile = join(LOG_DIR, `${String(results.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
  writeFileSync(logFile, problems.length === 0 ? 'ok\n' : problems.join('\n') + '\n');
  results.push({
    name,
    command: '(in-process)',
    status: problems.length === 0 ? 'pass' : 'fail',
    exitCode: problems.length === 0 ? 0 : 1,
    durationMs,
    log: logFile,
    summary: problems.length === 0 ? 'ok' : `${problems.length} problem(s)`,
  });
  process.stdout.write(`  ${problems.length === 0 ? 'PASS' : 'FAIL'}${problems.length > 0 ? `\n  ${problems.join('\n  ')}` : ''}\n`);
  return problems.length === 0;
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Directive §76 — every document the closure must ship, non-placeholder. */
const REQUIRED_DOCS = [
  'docs/PHASE_1_REALITY_AUDIT.md',
  'docs/PHASE_1_PROTECTED_BEHAVIORS.md',
  'docs/PHASE_1_CLOSURE_TRACKER.md',
  'docs/DAFTAR_IMPLEMENTATION_ROADMAP.md',
  'TECHNICAL_DEBT.md',
  'docs/PHASE_1_IMPLEMENTATION_REPORT.md',
  'docs/PHASE_1_TEST_REPORT.md',
  'docs/PHASE_1_SECURITY_REVIEW.md',
  'docs/PHASE_1_MULTI_USER_REVIEW.md',
  'docs/PHASE_1_RBAC_REVIEW.md',
  'docs/PHASE_1_ENTITLEMENT_REVIEW.md',
  'docs/PHASE_1_SUPER_ADMIN_REVIEW.md',
  'docs/PHASE_1_DESIGN_REVIEW.md',
  'docs/PHASE_1_ANDROID_REVIEW.md',
  'docs/PHASE_1_REGRESSION_REPORT.md',
  'docs/PHASE_1_PERFORMANCE_BASELINE.md',
  'docs/PHASE_1_ASVS_MAPPING.md',
  'docs/DAFTAR_EXTENSION_READINESS.md',
  'docs/DAFTAR_AWS_REFERENCE_ARCHITECTURE.md',
  'docs/PHASE_2_PREMORTEM.md',
  'docs/PHASE_1_ACCEPTANCE_REPORT.md',
];

const FORBIDDEN_ARTIFACT = /(^|\/)(\.env|.*\.log|dev-mailbox.*|.*\.tsbuildinfo|.*\.pem|.*\.key|.*\.zip)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.gradle', 'coverage']);
const RAW_CREDENTIAL = /argon2id\$[A-Za-z0-9+/=]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, visit);
    else visit(full);
  }
}

const steps: (() => boolean)[] = [
  () =>
    inProcess(`toolchain: Node ${REQUIRED_NODE_MAJOR}.x`, () => {
      const major = Number(process.versions.node.split('.')[0]);
      return major === REQUIRED_NODE_MAJOR ? [] : [`node ${process.versions.node} — release acceptance runs on Node ${REQUIRED_NODE_MAJOR}.x (engines)`];
    }),
  () => run('migration manifest (frozen files unchanged)', npm, ['run', '-s', 'check:migrations']),
  () => run('phase 1 machine gate', npm, ['run', '-s', 'gate:phase1']),
  () => run('static architecture guards', npm, ['run', '-s', 'check:guards']),
  () => run('localization completeness', npm, ['run', '-s', 'check:localization']),
  () => run('format', npm, ['run', '-s', 'format']),
  () =>
    run('build contract + design packages', npm, [
      'run',
      '-s',
      'build',
      '-w',
      '@daftar/domain-core',
      '-w',
      '@daftar/shared-contracts',
      '-w',
      '@daftar/design-system',
    ]),
  () => run('lint (zero warnings)', npm, ['run', '-s', 'lint']),
  () => run('typecheck (all workspaces)', npm, ['run', '-s', 'typecheck']),
  () => run('unit tests', npm, ['test', '-s']),
  () => run('integration + security tests', npm, ['run', '-s', 'test:integration']),
  () => run('golden regression suite', npm, ['run', '-s', 'test:golden']),
  () => run('API build', npm, ['run', '-s', 'build', '-w', '@daftar/api']),
  () => run('merchant web build', npm, ['run', '-s', 'build', '-w', '@daftar/web']),
  () => run('admin web build', npm, ['run', '-s', 'build', '-w', '@daftar/admin']),
  () => {
    if (process.env['RELEASE_GATE_SKIP_ANDROID'] === '1') {
      skip('Android lint + unit tests + assemble', 'RELEASE_GATE_SKIP_ANDROID=1 — run it on a machine with the Android SDK before signing off');
      return true;
    }
    const wrapper = join(ROOT, 'apps/android/gradlew');
    const gradle = existsSync(wrapper) ? wrapper : 'gradle';
    return run('Android lint + unit tests + assemble', gradle, ['lint', 'testDebugUnitTest', 'assembleDebug', '--no-daemon', '-q'], {
      cwd: join(ROOT, 'apps/android'),
    });
  },
  () => run('dependency audit (high/critical = 0)', npm, ['audit', '--audit-level=high']),
  () =>
    inProcess('forbidden artifact scan', () => {
      const bad: string[] = [];
      walk(ROOT, (f) => {
        const rel = relative(ROOT, f);
        if (FORBIDDEN_ARTIFACT.test(rel)) bad.push(`forbidden artifact: ${rel}`);
      });
      if (existsSync(join(ROOT, 'apps/api/dist'))) bad.push('stale apps/api/dist in source tree');
      return bad;
    }),
  () =>
    inProcess('raw credential scan', () => {
      const bad: string[] = [];
      for (const top of ['apps', 'packages', 'infrastructure', 'scripts']) {
        walk(join(ROOT, top), (f) => {
          if (!/\.(ts|tsx|sql|kt)$/.test(f)) return;
          if (/static-guards|export-release|phase1-release-gate/.test(f)) return;
          if (RAW_CREDENTIAL.test(readFileSync(f, 'utf8'))) bad.push(`raw credential material: ${relative(ROOT, f)}`);
        });
      }
      return bad;
    }),
  () =>
    inProcess('release documents (§76) present and non-placeholder', () =>
      REQUIRED_DOCS.flatMap((d) => {
        const full = join(ROOT, d);
        if (!existsSync(full)) return [`missing ${d}`];
        if (statSync(full).size < 1500) return [`${d} is a placeholder (${statSync(full).size} bytes)`];
        return [];
      }),
    ),
];

process.stdout.write(`PHASE 1 RELEASE GATE — logs in ${LOG_DIR}\n`);
let allOk = true;
for (const step of steps) {
  if (!step()) {
    allOk = false;
    break; // first failure stops the gate: a later PASS would be meaningless
  }
}

const totalMs = results.reduce((a, r) => a + r.durationMs, 0);
process.stdout.write('\n==================== SUMMARY ====================\n');
for (const r of results) {
  process.stdout.write(
    `${r.status.toUpperCase().padEnd(8)} ${(r.durationMs / 1000).toFixed(1).padStart(7)}s  ${r.name}${r.summary ? `  [${r.summary}]` : ''}\n`,
  );
}
process.stdout.write(
  `total ${(totalMs / 1000 / 60).toFixed(1)} min — ${results.filter((r) => r.status === 'pass').length} pass, ${results.filter((r) => r.status === 'fail').length} fail, ${results.filter((r) => r.status === 'skipped').length} skipped\n`,
);

if (EVIDENCE) {
  writeFileSync(
    EVIDENCE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.versions.node,
        platform: `${process.platform}/${process.arch}`,
        verdict: allOk ? 'PASS' : 'FAIL',
        logDir: LOG_DIR,
        steps: results,
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(`evidence written to ${EVIDENCE}\n`);
}

process.stdout.write(`\nPHASE 1 RELEASE GATE: ${allOk ? 'PASS' : 'FAIL'}\n`);
process.exit(allOk ? 0 : 1);
