#!/usr/bin/env tsx
/**
 * PHASE 1 RELEASE GATE (Directive §70–74, §77; Final Release Blockers 3, 5, 7).
 *
 * `npm run gate:phase1:release` runs the COMPLETE command matrix a release
 * candidate must survive on a clean checkout OR on the extracted release
 * archive (no .git required), in order, and stops at the first failure.
 * Every step's full output is captured to a log directory and a
 * machine-readable evidence file is written from what actually executed
 * (commands, exit codes, durations, parsed test counts, toolchain, OS,
 * migration/manifest facts, DB-from-zero results, Android results).
 *
 * MANDATORY CHECKS CANNOT BE SKIPPED (Blocker 5): if any RELEASE_GATE_SKIP_*
 * variable is set, the release gate FAILS before running anything. The
 * developer helper `npm run gate:phase1:dev` (--dev) may skip the Android
 * toolchain and prints SKIPPED, but it can never produce a release verdict.
 *
 * Usage:
 *   npm run gate:phase1:release -- [--evidence=<file.json>] [--log-dir=<dir>] [--archive-sha256=<hex>]
 *   npm run gate:phase1:release -- --list        (print the plan, run nothing)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');

// THE LIBRARY PACKAGES, IN THE ORDER THEIR TYPES HAVE TO EXIST.
//
// `clean build outputs` deletes every build output so the gate builds from
// source the way a fresh checkout does, and typed linting, typechecking and
// the tests all read those outputs afterwards. Both the list of outputs to
// delete and the list of packages to rebuild used to be written out by hand,
// and `@daftar/accounting` — added in Phase 2, long after this gate — was in
// neither. On any machine that had built the tree before, its `dist` survived
// the clean and everything resolved; on a fresh checkout there was nothing to
// resolve and typed linting reported 695 "type that cannot be resolved"
// errors. A release gate that passes only where the tree was already built is
// not a release gate.
//
// So neither list is written by hand any more. The SET is every workspace
// under `packages/` that has a `build` script, and the ORDER is a topological
// sort of their `@daftar/*` dependencies, so the package added next is built
// in the right place without anybody remembering to say so.
interface LibraryPackage {
  name: string;
  dir: string;
  deps: string[];
}

function libraryPackages(): LibraryPackage[] {
  const base = join(ROOT, 'packages');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map((entry) => ({
      dir: `packages/${entry.name}`,
      manifest: JSON.parse(readFileSync(join(base, entry.name, 'package.json'), 'utf8')) as {
        name?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      },
    }))
    .filter((entry) => typeof entry.manifest.name === 'string' && typeof entry.manifest.scripts?.['build'] === 'string')
    .map((entry) => ({
      name: entry.manifest.name as string,
      dir: entry.dir,
      deps: [
        ...new Set([
          ...Object.keys(entry.manifest.dependencies ?? {}),
          ...Object.keys(entry.manifest.peerDependencies ?? {}),
          ...Object.keys(entry.manifest.devDependencies ?? {}),
        ]),
      ]
        .filter((dep) => dep.startsWith('@daftar/'))
        .sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function libraryBuildOrder(): { order: LibraryPackage[]; problems: string[] } {
  const packages = libraryPackages();
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const state = new Map<string, 'visiting' | 'built'>();
  const order: LibraryPackage[] = [];
  const problems: string[] = [];
  const visit = (pkg: LibraryPackage, trail: string[]): void => {
    const seen = state.get(pkg.name);
    if (seen === 'built') return;
    if (seen === 'visiting') {
      problems.push(`the library packages depend on each other in a cycle: ${[...trail, pkg.name].join(' -> ')}`);
      return;
    }
    state.set(pkg.name, 'visiting');
    for (const dep of pkg.deps) {
      const next = byName.get(dep);
      if (next) visit(next, [...trail, pkg.name]);
    }
    state.set(pkg.name, 'built');
    order.push(pkg);
  };
  for (const pkg of packages) visit(pkg, []);
  return { order, problems };
}

const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string | undefined]));
const DEV_MODE = args.has('dev');
const LIST_ONLY = args.has('list');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_DIR = args.get('log-dir') ?? join(ROOT, 'release', `gate-logs-${stamp}`);
const EVIDENCE = args.get('evidence');
const ARCHIVE_SHA256 = args.get('archive-sha256') ?? null;
if (!LIST_ONLY) mkdirSync(LOG_DIR, { recursive: true });

interface StepResult {
  name: string;
  command: string;
  status: 'pass' | 'fail' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  log: string;
  summary?: string;
  data?: Record<string, unknown>;
}

const results: StepResult[] = [];
const REQUIRED_NODE_MAJOR = 24;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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
        /(STATIC GUARDS|LOCALIZATION CHECK|PHASE 1 GATE|Migration manifest OK|DB FROM ZERO|found 0 vulnerabilities|BUILD SUCCESSFUL|tests completed)/.test(l),
    );
  return lines.length > 0 ? lines.join(' | ') : undefined;
}

/** Vitest prints "Tests  291 passed (291)" / "Tests  1 failed | 7 passed (8)". Sum every such line. */
function parseVitestCounts(output: string): { passed: number; failed: number; total: number } | undefined {
  let passed = 0;
  let failed = 0;
  let total = 0;
  let seen = false;
  for (const line of output.replace(ANSI, '').split('\n')) {
    const m = /^\s*Tests\s+(.*)\((\d+)\)/.exec(line);
    if (!m) continue;
    seen = true;
    total += Number(m[2]);
    const p = /(\d+) passed/.exec(m[1] ?? '');
    const f = /(\d+) failed/.exec(m[1] ?? '');
    if (p) passed += Number(p[1]);
    if (f) failed += Number(f[1]);
  }
  return seen ? { passed, failed, total } : undefined;
}

function run(
  name: string,
  cmd: string,
  cmdArgs: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; enrich?: (output: string) => Record<string, unknown> } = {},
): boolean {
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
  const counts = parseVitestCounts(output);
  let data: Record<string, unknown> | undefined = counts ? { tests: counts } : undefined;
  if (opts.enrich) {
    try {
      data = { ...(data ?? {}), ...opts.enrich(output) };
    } catch (e) {
      data = { ...(data ?? {}), enrichError: e instanceof Error ? e.message : String(e) };
    }
  }
  results.push({
    name,
    command: cmdString(cmd, cmdArgs),
    status: ok ? 'pass' : 'fail',
    exitCode: res.status,
    durationMs,
    log: logFile,
    ...(summary ? { summary } : {}),
    ...(data ? { data } : {}),
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

function inProcess(name: string, fn: () => string[], data?: () => Record<string, unknown>): boolean {
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
  let extra: Record<string, unknown> | undefined;
  if (data) {
    try {
      extra = data();
    } catch (e) {
      extra = { dataError: e instanceof Error ? e.message : String(e) };
    }
  }
  results.push({
    name,
    command: '(in-process)',
    status: problems.length === 0 ? 'pass' : 'fail',
    exitCode: problems.length === 0 ? 0 : 1,
    durationMs,
    log: logFile,
    summary: problems.length === 0 ? 'ok' : `${problems.length} problem(s)`,
    ...(extra ? { data: extra } : {}),
  });
  process.stdout.write(`  ${problems.length === 0 ? 'PASS' : 'FAIL'}${problems.length > 0 ? `\n  ${problems.join('\n  ')}` : ''}\n`);
  return problems.length === 0;
}

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

/** Files every reproduction command needs — missing means the archive is not self-contained (Blocker 3). */
const REQUIRED_SOURCE_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'tsconfig.json',
  'vitest.config.ts',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.nvmrc',
  'apps/api/package.json',
  'apps/api/tsconfig.json',
  'apps/api/tsconfig.build.json',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
  'apps/web/next.config.mjs',
  'apps/admin/package.json',
  'apps/admin/tsconfig.json',
  'apps/admin/next.config.mjs',
  'packages/domain-core/package.json',
  'packages/domain-core/tsconfig.json',
  'packages/domain-core/tsconfig.build.json',
  'packages/domain-core/vitest.config.ts',
  'packages/shared-contracts/package.json',
  'packages/shared-contracts/tsconfig.json',
  'packages/shared-contracts/tsconfig.build.json',
  'packages/shared-contracts/vitest.config.ts',
  'packages/design-system/package.json',
  'packages/design-system/tsconfig.json',
  'apps/android/settings.gradle.kts',
  'apps/android/build.gradle.kts',
  'apps/android/gradle.properties',
  'apps/android/app/build.gradle.kts',
  'apps/android/app/proguard-rules.pro',
  'apps/android/app/src/main/AndroidManifest.xml',
  'apps/android/app/src/main/res/xml/network_security_config.xml',
  'apps/android/app/src/debug/res/xml/network_security_config.xml',
  'infrastructure/database/bootstrap.sql',
  'infrastructure/database/MIGRATION_MANIFEST.json',
  'infrastructure/database/migrations/0000_extensions.sql',
  'tests/helpers/test-app.ts',
  'tests/helpers/global-setup.ts',
  'tests/helpers/setup.ts',
  'scripts/phase1-gate.ts',
  'scripts/phase1-release-gate.ts',
  'scripts/export-release.ts',
  'scripts/static-guards.ts',
  'scripts/check-localization.ts',
  'scripts/check-migration-manifest.ts',
  'scripts/verify-migration-history.ts',
  'scripts/bootstrap-db-roles.ts',
  'scripts/bootstrap-platform-owner.ts',
  'scripts/install-provisioning-key.ts',
  'scripts/db-from-zero.ts',
  '.github/workflows/ci.yml',
];

const FORBIDDEN_ARTIFACT = /(^|\/)(\.env|.*\.log|dev-mailbox.*|.*\.tsbuildinfo|.*\.pem|.*\.key|.*\.zip|.*\.dump|.*\.sql\.gz)$/;
const RAW_CREDENTIAL = /argon2id\$[A-Za-z0-9+/=]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.gradle', 'coverage', 'release', 'var', '.pgdata']);

const IS_GIT = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' }).status === 0;

/** Files a commit or the release archive would carry. Git when available; otherwise the tree minus build/ignored directories (extracted archive). */
function shippedFiles(): string[] {
  if (IS_GIT) {
    const out = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
    return out.stdout.split('\0').filter((f) => f.length > 0 && existsSync(join(ROOT, f)));
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(relative(ROOT, full));
    }
  };
  walk(ROOT);
  return out.filter((f) => f !== 'apps/android/local.properties');
}

function sha256File(rel: string): string | null {
  const full = join(ROOT, rel);
  return existsSync(full) ? createHash('sha256').update(readFileSync(full)).digest('hex') : null;
}

function sourceIdentity(): Record<string, unknown> {
  const commit = IS_GIT ? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() : null;
  const dirty = IS_GIT ? spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().length > 0 : null;
  let deliveryManifest: Record<string, unknown> | null = null;
  const dm = join(ROOT, 'DELIVERY_MANIFEST.json');
  if (existsSync(dm)) {
    const m = JSON.parse(readFileSync(dm, 'utf8')) as Record<string, unknown>;
    deliveryManifest = { treeHash: m['treeHash'], fileCount: m['fileCount'], generatedAt: m['generatedAt'], sourceCommit: m['sourceCommit'] ?? null };
  }
  return { kind: IS_GIT ? 'git-checkout' : 'extracted-archive', gitCommit: commit, gitDirty: dirty, deliveryManifest, archiveSha256: ARCHIVE_SHA256 };
}

function migrationFacts(): Record<string, unknown> {
  const dir = join(ROOT, 'infrastructure/database/migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    frozenThrough?: string;
    migrations?: unknown[];
  };
  return {
    count: files.length,
    latest: files[files.length - 1] ?? null,
    manifestFrozenThrough: manifest.frozenThrough ?? null,
    manifestEntries: Array.isArray(manifest.migrations) ? manifest.migrations.length : 0,
    manifestSha256: sha256File('infrastructure/database/MIGRATION_MANIFEST.json'),
    unmanifested: files.filter((f) => manifest.frozenThrough && f > manifest.frozenThrough),
  };
}

function androidFacts(): Record<string, unknown> {
  const resultsDir = join(ROOT, 'apps/android/app/build/test-results/testDebugUnitTest');
  let tests = 0;
  let failures = 0;
  let errors = 0;
  if (existsSync(resultsDir)) {
    for (const f of readdirSync(resultsDir).filter((f) => f.endsWith('.xml'))) {
      const xml = readFileSync(join(resultsDir, f), 'utf8');
      tests += Number(/tests="(\d+)"/.exec(xml)?.[1] ?? 0);
      failures += Number(/failures="(\d+)"/.exec(xml)?.[1] ?? 0);
      errors += Number(/errors="(\d+)"/.exec(xml)?.[1] ?? 0);
    }
  }
  const lintTxt = join(ROOT, 'apps/android/app/build/reports/lint-results-debug.txt');
  const lint = existsSync(lintTxt) ? (/(\d+) errors?, (\d+) warnings?/.exec(readFileSync(lintTxt, 'utf8'))?.[0] ?? 'report present') : 'no lint report';
  const apk = join(ROOT, 'apps/android/app/build/outputs/apk/debug/app-debug.apk');
  return {
    unitTests: { tests, failures, errors },
    lint,
    apk: existsSync(apk) ? { path: 'apps/android/app/build/outputs/apk/debug/app-debug.apk', bytes: statSync(apk).size } : null,
  };
}

const requestedSkips = Object.keys(process.env).filter((k) => /^RELEASE_GATE_SKIP_/.test(k) && process.env[k] !== '' && process.env[k] !== '0');

const steps: { name: string; fn: () => boolean }[] = [
  {
    name: 'mandatory checks cannot be skipped',
    fn: () =>
      inProcess('mandatory checks cannot be skipped (Blocker 5)', () => {
        if (requestedSkips.length === 0) return [];
        if (DEV_MODE) return [];
        return requestedSkips.map(
          (k) => `${k} is set — a release verdict with a skipped mandatory check is impossible; unset it or use npm run gate:phase1:dev for local iteration`,
        );
      }),
  },
  {
    name: 'toolchain',
    fn: () =>
      inProcess(
        `toolchain: Node ${REQUIRED_NODE_MAJOR}.x`,
        () => {
          const major = Number(process.versions.node.split('.')[0]);
          return major === REQUIRED_NODE_MAJOR ? [] : [`node ${process.versions.node} — release acceptance runs on Node ${REQUIRED_NODE_MAJOR}.x (engines)`];
        },
        () => ({ node: process.versions.node, npm: spawnSync(npm, ['-v'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || null }),
      ),
  },
  {
    name: 'self-contained source tree',
    fn: () =>
      inProcess(
        'self-contained source tree (Blocker 3: every reproduction input present)',
        () => REQUIRED_SOURCE_FILES.filter((f) => !existsSync(join(ROOT, f))).map((f) => `missing ${f}`),
        () => ({
          checkedFiles: REQUIRED_SOURCE_FILES.length,
          source: sourceIdentity(),
        }),
      ),
  },
  {
    name: 'clean build outputs',
    fn: () =>
      inProcess('clean build outputs (build from source, like a fresh checkout)', () => {
        for (const rel of [
          'apps/api/dist',
          'apps/web/.next',
          'apps/admin/.next',
          'apps/android/app/build',
          'apps/android/build',
          ...libraryPackages().map((pkg) => `${pkg.dir}/dist`),
        ]) {
          rmSync(join(ROOT, rel), { recursive: true, force: true });
        }
        return [];
      }),
  },
  {
    name: 'migration manifest',
    fn: () =>
      run('migration manifest (frozen files unchanged; nothing unmanifested)', npm, ['run', '-s', 'check:migrations'], {
        enrich: () => {
          const facts = migrationFacts();
          if ((facts['unmanifested'] as string[]).length > 0) throw new Error(`unmanifested migrations: ${(facts['unmanifested'] as string[]).join(', ')}`);
          return { migrations: facts };
        },
      }) && (migrationFacts()['unmanifested'] as string[]).length === 0,
  },
  {
    name: 'db from zero',
    fn: () =>
      run(
        'database contract from zero (roles → migrate → no-op → manifest → tamper → role contract)',
        npm,
        ['run', '-s', 'check:db-from-zero', '--', '--release'],
        {
          enrich: (out) => ({ dbFromZero: JSON.parse(/DB_FROM_ZERO: (\{.*\})/.exec(out)?.[1] ?? 'null') }),
        },
      ),
  },
  { name: 'machine gate', fn: () => run('phase 1 machine gate', npm, ['run', '-s', 'gate:phase1']) },
  { name: 'static guards', fn: () => run('static architecture guards', npm, ['run', '-s', 'check:guards']) },
  { name: 'localization', fn: () => run('localization completeness', npm, ['run', '-s', 'check:localization']) },
  { name: 'format', fn: () => run('format', npm, ['run', '-s', 'format']) },
  {
    name: 'packages',
    fn: () => {
      const { order, problems } = libraryBuildOrder();
      const resolved = inProcess(
        'every library package builds, in dependency order',
        () => problems,
        () => ({ libraryBuildOrder: order.map((pkg) => pkg.name) }),
      );
      return resolved && order.every((pkg) => run(`build ${pkg.name}`, npm, ['run', '-s', 'build', '-w', pkg.name]));
    },
  },
  { name: 'lint', fn: () => run('lint (zero warnings)', npm, ['run', '-s', 'lint']) },
  { name: 'typecheck', fn: () => run('typecheck (all workspaces)', npm, ['run', '-s', 'typecheck']) },
  { name: 'unit', fn: () => run('unit tests', npm, ['test', '-s']) },
  { name: 'integration', fn: () => run('integration + security tests (incl. DB contract + upgrade matrix)', npm, ['run', '-s', 'test:integration']) },
  { name: 'golden', fn: () => run('golden regression suite', npm, ['run', '-s', 'test:golden']) },
  { name: 'api build', fn: () => run('API build', npm, ['run', '-s', 'build', '-w', '@daftar/api']) },
  { name: 'web build', fn: () => run('merchant web build', npm, ['run', '-s', 'build', '-w', '@daftar/web']) },
  { name: 'admin build', fn: () => run('admin web build', npm, ['run', '-s', 'build', '-w', '@daftar/admin']) },
  {
    name: 'android',
    fn: () => {
      if (DEV_MODE && requestedSkips.includes('RELEASE_GATE_SKIP_ANDROID')) {
        skip('Android lint + unit tests + assemble', 'dev gate only — RELEASE_GATE_SKIP_ANDROID set; this run can never be a release verdict');
        return true;
      }
      const wrapper = join(ROOT, 'apps/android/gradlew');
      const gradle = existsSync(wrapper) ? wrapper : 'gradle';
      return run('Android lint + unit tests + assemble', gradle, ['lint', 'testDebugUnitTest', 'assembleDebug', '--no-daemon', '-q'], {
        cwd: join(ROOT, 'apps/android'),
        enrich: () => ({ android: androidFacts() }),
      });
    },
  },
  { name: 'audit', fn: () => run('dependency audit (high/critical = 0)', npm, ['audit', '--audit-level=high']) },
  {
    name: 'artifact scan',
    fn: () =>
      inProcess('forbidden artifact scan (files the release would ship)', () => {
        const files = shippedFiles();
        const bad = files.filter((rel) => FORBIDDEN_ARTIFACT.test(rel)).map((rel) => `forbidden artifact: ${rel}`);
        if (files.some((rel) => rel.startsWith('apps/api/dist/'))) bad.push('apps/api/dist is tracked or not git-ignored');
        if (files.some((rel) => /(^|\/)node_modules\//.test(rel))) bad.push('node_modules content would ship');
        return bad;
      }),
  },
  {
    name: 'secret scan',
    fn: () =>
      inProcess('raw credential scan', () =>
        shippedFiles()
          .filter((rel) => /^(apps|packages|infrastructure|scripts)\//.test(rel) && /\.(ts|tsx|sql|kt|kts|json|xml|mjs)$/.test(rel))
          .filter((rel) => !/static-guards|export-release|phase1-release-gate/.test(rel))
          .filter((rel) => RAW_CREDENTIAL.test(readFileSync(join(ROOT, rel), 'utf8')))
          .map((rel) => `raw credential material: ${rel}`),
      ),
  },
  {
    name: 'docs',
    fn: () =>
      inProcess('release documents (§76) present and non-placeholder', () =>
        REQUIRED_DOCS.flatMap((d) => {
          const full = join(ROOT, d);
          if (!existsSync(full)) return [`missing ${d}`];
          if (statSync(full).size < 1500) return [`${d} is a placeholder (${statSync(full).size} bytes)`];
          return [];
        }),
      ),
  },
];

if (LIST_ONLY) {
  process.stdout.write(`PHASE 1 RELEASE GATE — plan (${DEV_MODE ? 'dev' : 'release'} mode)\n`);
  steps.forEach((s, i) => process.stdout.write(`${String(i + 1).padStart(2, ' ')}. ${s.name}\n`));
  if (requestedSkips.length > 0) process.stdout.write(`requested skips: ${requestedSkips.join(', ')} → ${DEV_MODE ? 'SKIPPED (dev only)' : 'FAIL'}\n`);
  process.exit(0);
}

process.stdout.write(`PHASE 1 RELEASE GATE (${DEV_MODE ? 'DEV helper — never a release verdict' : 'release'}) — logs in ${LOG_DIR}\n`);
let allOk = true;
for (const step of steps) {
  if (!step.fn()) {
    allOk = false;
    break; // first failure stops the gate: a later PASS would be meaningless
  }
}
const skipped = results.filter((r) => r.status === 'skipped').length;
const verdict = allOk && !DEV_MODE && skipped === 0 ? 'PASS' : allOk && DEV_MODE ? 'DEV-OK (not a release verdict)' : 'FAIL';

const totalMs = results.reduce((a, r) => a + r.durationMs, 0);
process.stdout.write('\n==================== SUMMARY ====================\n');
for (const r of results) {
  process.stdout.write(
    `${r.status.toUpperCase().padEnd(8)} ${(r.durationMs / 1000).toFixed(1).padStart(7)}s  ${r.name}${r.summary ? `  [${r.summary}]` : ''}\n`,
  );
}
process.stdout.write(
  `total ${(totalMs / 1000 / 60).toFixed(1)} min — ${results.filter((r) => r.status === 'pass').length} pass, ${results.filter((r) => r.status === 'fail').length} fail, ${skipped} skipped\n`,
);

if (EVIDENCE) {
  const byName = (needle: string) => results.find((r) => r.name.toLowerCase().includes(needle));
  const evidence = {
    schema: 'daftar.release-evidence/2',
    generatedAt: new Date().toISOString(),
    verdict,
    mode: DEV_MODE ? 'dev' : 'release',
    requestedSkips,
    toolchain: { node: process.versions.node, npm: byName('toolchain')?.data?.['npm'] ?? null, platform: process.platform, arch: arch() },
    os: { platform: platform(), release: release(), arch: arch(), cpus: cpus().length, totalMemGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10 },
    source: sourceIdentity(),
    migrations: migrationFacts(),
    dbFromZero: byName('database contract from zero')?.data?.['dbFromZero'] ?? null,
    tests: {
      unit: byName('unit tests')?.data?.['tests'] ?? null,
      integrationAndSecurity: byName('integration + security')?.data?.['tests'] ?? null,
      golden: byName('golden')?.data?.['tests'] ?? null,
      android: byName('android')?.data?.['android'] ?? null,
    },
    builds: {
      api: byName('api build')?.status ?? null,
      merchantWeb: byName('merchant web build')?.status ?? null,
      adminWeb: byName('admin web build')?.status ?? null,
      android: byName('android')?.status ?? null,
    },
    scans: {
      artifact: byName('artifact scan')?.status ?? null,
      secret: byName('credential scan')?.status ?? null,
      dependencyAudit: byName('dependency audit')?.status ?? null,
    },
    commands: results.map((r) => ({ step: r.name, command: r.command, exitCode: r.exitCode, status: r.status, durationMs: r.durationMs })),
    logDir: LOG_DIR,
    steps: results,
  };
  writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(`evidence written to ${EVIDENCE}\n`);
}

process.stdout.write(`\nPHASE 1 RELEASE GATE: ${verdict}\n`);
process.exit(verdict === 'PASS' || verdict.startsWith('DEV-OK') ? 0 : 1);
