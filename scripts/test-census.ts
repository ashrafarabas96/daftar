#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────
 * TEST CENSUS — `npm run census:tests [-- --json=<file>] [--markdown=<file>]`
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The exact number of test files and test cases in each estate of the tree it
 * runs in (Tech Lead directive §16: no number carried over from an earlier
 * slice). Every count comes from vitest's own collection — the same
 * `collect` that `vitest list` runs — through each estate's own config, so a
 * parametrised `it.each` counts its cases and a comment or a test title that
 * mentions `it(` counts nothing. Nothing is grepped, except the Android JVM
 * tests, whose runner is Gradle: those are read from Gradle's JUnit XML
 * results when a local run left them, and otherwise from the `@Test`
 * annotations of the JVM test sources, and the output says which.
 *
 * WHAT IT DOES NOT RUN
 *
 * Collection imports each test file and registers its cases; it runs no test
 * and no hook. The root config's global setup (it starts PostgreSQL and
 * migrates it) and the web config's (it guards the exit code) define no test,
 * so they are not run, and no count here needs a database. A file that fails
 * to collect fails the census; it never counts as zero. Pass/fail results are
 * not counts: they come from the commands in the `command` column.
 *
 * A root test file that no estate claims fails the census too, so a new test
 * directory cannot silently fall out of the totals.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(__dirname, '..');

type Mode = 'run' | 'skip' | 'todo' | 'only';

export interface FileCount {
  readonly file: string;
  readonly tests: number;
}

export interface EstateCount {
  readonly id: string;
  readonly title: string;
  /** The command that runs the estate and reports pass/fail. */
  readonly command: string;
  /** Another estate this one is a subset of (not added to the totals twice). */
  readonly subsetOf: string | null;
  readonly files: number;
  readonly tests: number;
  /** Cases per mode at collection: `skip` are declared but skipped in this environment. */
  readonly modes: Readonly<Record<Mode, number>>;
  readonly source: string;
  readonly perFile: readonly FileCount[];
}

export interface Census {
  readonly tree: { readonly commit: string | null; readonly dirty: boolean | null; readonly identity: string };
  readonly method: string;
  readonly estates: readonly EstateCount[];
  readonly totals: { readonly files: number; readonly tests: number; readonly skipped: number };
  readonly notCounted: readonly { readonly what: string; readonly producedBy: string }[];
}

// ─────────────────────────────────────────────────────────────────────────
// The estates
// ─────────────────────────────────────────────────────────────────────────

interface VitestProject {
  readonly id: string;
  /** Config path relative to the repository. */
  readonly config: string;
  /** Root directory the config runs in, relative to the repository. */
  readonly root: string;
}

const PROJECTS: readonly VitestProject[] = [
  { id: 'root', config: 'vitest.config.ts', root: '.' },
  { id: 'domain-core', config: 'packages/domain-core/vitest.config.ts', root: 'packages/domain-core' },
  { id: 'accounting', config: 'packages/accounting/vitest.config.ts', root: 'packages/accounting' },
  { id: 'shared-contracts', config: 'packages/shared-contracts/vitest.config.ts', root: 'packages/shared-contracts' },
  { id: 'inventory', config: 'packages/inventory/vitest.config.ts', root: 'packages/inventory' },
  { id: 'web', config: 'apps/web/vitest.config.mts', root: 'apps/web' },
];

interface EstateRule {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly command: string;
  readonly subsetOf: string | null;
  /** Repository-relative test file paths this estate claims. */
  readonly claims: (file: string) => boolean;
}

export const ESTATES: readonly EstateRule[] = [
  {
    id: 'unit:domain-core',
    title: 'Unit — @daftar/domain-core',
    project: 'domain-core',
    command: 'npm run test -w @daftar/domain-core',
    subsetOf: null,
    claims: () => true,
  },
  {
    id: 'unit:accounting',
    title: 'Unit — @daftar/accounting',
    project: 'accounting',
    command: 'npm run test -w @daftar/accounting',
    subsetOf: null,
    claims: () => true,
  },
  {
    id: 'unit:shared-contracts',
    title: 'Unit — @daftar/shared-contracts',
    project: 'shared-contracts',
    command: 'npm run test -w @daftar/shared-contracts',
    subsetOf: null,
    claims: () => true,
  },
  {
    id: 'unit:inventory',
    title: 'Unit — @daftar/inventory',
    project: 'inventory',
    command: 'npm run test -w @daftar/inventory',
    subsetOf: null,
    claims: () => true,
  },
  { id: 'web', title: 'Web (SSR and unit)', project: 'web', command: 'npm run test -w @daftar/web', subsetOf: null, claims: () => true },
  {
    id: 'integration',
    title: 'Integration (tests/integration)',
    project: 'root',
    command: 'npm run test:integration (with security; needs PostgreSQL)',
    subsetOf: null,
    claims: (f) => f.startsWith('tests/integration/'),
  },
  {
    id: 'security',
    title: 'Security (tests/security)',
    project: 'root',
    command: 'npm run test:integration (with integration; needs PostgreSQL)',
    subsetOf: null,
    claims: (f) => f.startsWith('tests/security/'),
  },
  {
    id: 'golden',
    title: 'Golden regression (tests/golden-regression)',
    project: 'root',
    command: 'npm run test:golden (needs PostgreSQL)',
    subsetOf: null,
    claims: (f) => f.startsWith('tests/golden-regression/'),
  },
  {
    id: 'performance-tier1',
    title: 'Performance, Tier 1 (tests/performance, tests/perf)',
    project: 'root',
    command: 'npm run perf:phase2:s8 and npm run perf:baseline (need PostgreSQL)',
    subsetOf: null,
    claims: (f) => f.startsWith('tests/performance/') || f.startsWith('tests/perf/'),
  },
  {
    id: 'premortem',
    title: 'Premortem matrix (subset of security)',
    project: 'root',
    command: 'npx vitest run tests/security/phase3-s8-premortem-matrix.test.ts',
    subsetOf: 'security',
    claims: (f) => f === 'tests/security/phase3-s8-premortem-matrix.test.ts',
  },
  {
    id: 'migration',
    title: 'Migration (subset of integration: tests/integration/migration-*)',
    project: 'root',
    command: 'npx vitest run tests/integration/migration-*.test.ts (needs PostgreSQL)',
    subsetOf: 'integration',
    claims: (f) => /^tests\/integration\/migration-[^/]+\.test\.ts$/.test(f),
  },
];

export const NOT_COUNTED: readonly { readonly what: string; readonly producedBy: string }[] = [
  { what: 'Pass/fail of every estate above', producedBy: 'the command in its row; the composed gates (gate:phase3:release) run them all' },
  {
    what: 'Performance Tier 2 (supporting evidence)',
    producedBy: 'the Tier 1 files re-run with P2S8_PERF_TIER=2 / P3S8_PERF_TIER=2 / P3S7_PERF_SCALE; recorded on the slice acceptance pages',
  },
  { what: 'Browser runs, screenshots, locales and viewports', producedBy: 'the real-browser gate and its evidence, not vitest' },
  { what: 'Android lint and build', producedBy: 'CI job "android": ./gradlew lint testDebugUnitTest assembleDebug' },
  { what: 'Deployment rehearsal', producedBy: 'npm run rehearse:phase3:deployed (needs PostgreSQL), composed by gate:phase3:release' },
];

// ─────────────────────────────────────────────────────────────────────────
// Collection
// ─────────────────────────────────────────────────────────────────────────

interface Collected {
  readonly file: string;
  readonly modes: Record<Mode, number>;
}

const zeroModes = (): Record<Mode, number> => ({ run: 0, skip: 0, todo: 0, only: 0 });
const toRepo = (absolute: string): string => relative(ROOT, absolute).split(sep).join('/');

/** Every test file of one vitest project, with its cases by mode, as vitest collects them. */
async function collectProject(project: VitestProject): Promise<Collected[]> {
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', {
    root: join(ROOT, project.root),
    config: join(ROOT, project.config),
    globalSetup: [],
    watch: false,
    reporters: [],
  });
  try {
    const result = await vitest.collect();
    const problems: string[] = [];
    for (const error of result.unhandledErrors) problems.push(`unhandled: ${error instanceof Error ? error.message : String(error)}`);
    const out: Collected[] = [];
    for (const module of result.testModules) {
      const file = toRepo(module.moduleId);
      for (const error of module.errors()) problems.push(`${file}: ${error.message}`);
      const modes = zeroModes();
      for (const test of module.children.allTests()) modes[test.options.mode] += 1;
      out.push({ file, modes });
    }
    if (problems.length > 0) throw new Error(`vitest could not collect the ${project.id} project:\n  ${problems.join('\n  ')}`);
    return out.sort((a, b) => a.file.localeCompare(b.file));
  } finally {
    await vitest.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Android (Gradle)
// ─────────────────────────────────────────────────────────────────────────

function walk(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, keep));
    else if (keep(name)) out.push(path);
  }
  return out.sort();
}

/** `@Test` annotations of Kotlin/Java source, outside comments. */
export function countJvmTests(source: string): number {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return (code.match(/@(?:org\.junit\.)?Test\b(?!\w)/g) ?? []).length;
}

export function androidEstate(root: string): EstateCount {
  const results = walk(join(root, 'apps/android/app/build/test-results'), (n) => n.startsWith('TEST-') && n.endsWith('.xml'));
  if (results.length > 0) {
    const perFile = results.map((path) => {
      const suite = /<testsuite\b[^>]*\btests="(\d+)"[^>]*\bskipped="(\d+)"/.exec(readFileSync(path, 'utf8'));
      if (suite?.[1] === undefined) throw new Error(`${toRepo(path)}: no <testsuite tests="…"> in the JUnit result`);
      return { file: toRepo(path), tests: Number(suite[1]), skipped: Number(suite[2] ?? '0') };
    });
    const tests = perFile.reduce((n, f) => n + f.tests, 0);
    const skipped = perFile.reduce((n, f) => n + f.skipped, 0);
    return {
      id: 'android-jvm',
      title: 'Android JVM unit tests',
      command: 'cd apps/android && ./gradlew testDebugUnitTest (CI job "android")',
      subsetOf: null,
      files: perFile.length,
      tests,
      modes: { run: tests - skipped, skip: skipped, todo: 0, only: 0 },
      source: 'Gradle JUnit XML results of a local run (apps/android/app/build/test-results)',
      perFile: perFile.map(({ file, tests: n }) => ({ file, tests: n })),
    };
  }
  const sources = walk(join(root, 'apps/android/app/src/test'), (n) => n.endsWith('.kt') || n.endsWith('.java'));
  const perFile = sources.map((path) => ({ file: toRepo(path), tests: countJvmTests(readFileSync(path, 'utf8')) }));
  const tests = perFile.reduce((n, f) => n + f.tests, 0);
  return {
    id: 'android-jvm',
    title: 'Android JVM unit tests',
    command: 'cd apps/android && ./gradlew testDebugUnitTest (CI job "android")',
    subsetOf: null,
    files: perFile.length,
    tests,
    modes: { run: tests, skip: 0, todo: 0, only: 0 },
    source:
      'no local Gradle results (no Android SDK here): the @Test annotations of apps/android/app/src/test; CI reports the executed count in the "android" job log and its JUnit XML',
    perFile,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The census
// ─────────────────────────────────────────────────────────────────────────

/** Split one project's collection into the estates that claim it. Pure. */
export function assignEstates(collected: ReadonlyMap<string, readonly Collected[]>): { estates: EstateCount[]; unclaimed: string[] } {
  const estates: EstateCount[] = [];
  const claimed = new Set<string>();
  for (const rule of ESTATES) {
    const files = (collected.get(rule.project) ?? []).filter((c) => rule.claims(c.file));
    if (rule.subsetOf === null) for (const f of files) claimed.add(`${rule.project}:${f.file}`);
    const modes = zeroModes();
    for (const f of files) for (const m of Object.keys(modes) as Mode[]) modes[m] += f.modes[m];
    const perFile = files.map((f) => ({ file: f.file, tests: f.modes.run + f.modes.skip + f.modes.todo + f.modes.only }));
    estates.push({
      id: rule.id,
      title: rule.title,
      command: rule.command,
      subsetOf: rule.subsetOf,
      files: files.length,
      tests: perFile.reduce((n, f) => n + f.tests, 0),
      modes,
      source: `vitest collect, ${PROJECTS.find((p) => p.id === rule.project)?.config ?? rule.project}`,
      perFile,
    });
  }
  const unclaimed: string[] = [];
  for (const [project, files] of collected) for (const f of files) if (!claimed.has(`${project}:${f.file}`)) unclaimed.push(`${project}:${f.file}`);
  return { estates, unclaimed };
}

export function totals(estates: readonly EstateCount[]): Census['totals'] {
  const top = estates.filter((e) => e.subsetOf === null);
  return {
    files: top.reduce((n, e) => n + e.files, 0),
    tests: top.reduce((n, e) => n + e.tests, 0),
    skipped: top.reduce((n, e) => n + e.modes.skip, 0),
  };
}

/** The commit and cleanliness of the tree, or the archive's own identity. A failure is recorded, never guessed. */
function treeIdentity(root: string): Census['tree'] {
  const manifest = join(root, 'DELIVERY_MANIFEST.json');
  if (existsSync(manifest)) {
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { sourceCommit?: unknown };
    return { commit: typeof m.sourceCommit === 'string' ? m.sourceCommit : null, dirty: false, identity: 'extracted archive (DELIVERY_MANIFEST.json)' };
  }
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { commit, dirty: status.trim() !== '', identity: 'git checkout' };
  } catch (e) {
    return { commit: null, dirty: null, identity: `unknown: ${e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)}` };
  }
}

export function renderMarkdown(census: Census): string {
  const out: string[] = [];
  const commit = census.tree.commit === null ? 'unknown commit' : `\`${census.tree.commit}\``;
  const dirty = census.tree.dirty === true ? ', with uncommitted changes to tracked files' : '';
  out.push(`Test census at ${commit} (${census.tree.identity}${dirty}). ${census.method}`);
  out.push('');
  out.push('| Estate | Files | Tests | Skipped here | Source | Runs with |');
  out.push('| --- | ---: | ---: | ---: | --- | --- |');
  for (const e of census.estates) out.push(`| ${e.title} | ${e.files} | ${e.tests} | ${e.modes.skip} | ${e.source} | \`${e.command}\` |`);
  out.push(`| **Total (subsets not added twice)** | **${census.totals.files}** | **${census.totals.tests}** | **${census.totals.skipped}** | | |`);
  out.push('');
  out.push('Not counted here:');
  for (const n of census.notCounted) out.push(`- ${n.what}: ${n.producedBy}.`);
  out.push('');
  return out.join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const arg = (name: string): string | undefined => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const collected = new Map<string, Collected[]>();
  for (const project of PROJECTS) {
    console.error(`census: collecting ${project.id} (${project.config}) …`);
    collected.set(project.id, await collectProject(project));
  }
  const { estates, unclaimed } = assignEstates(collected);
  if (unclaimed.length > 0) {
    console.error(`TEST CENSUS: FAIL — ${unclaimed.length} collected test file(s) belong to no estate:`);
    for (const u of unclaimed) console.error(`  ${u}`);
    return 1;
  }
  const all = [...estates, androidEstate(ROOT)];
  const census: Census = {
    tree: treeIdentity(ROOT),
    method:
      'Vitest counts come from vitest collect through each estate’s own config (no test or hook runs; the root and web global setups are not run, and no count needs a database); a `skip` case is declared but skipped in this environment.',
    estates: all,
    totals: totals(all),
    notCounted: NOT_COUNTED,
  };
  const json = `${JSON.stringify(census, null, 2)}\n`;
  const markdown = renderMarkdown(census);
  const jsonOut = arg('json');
  const markdownOut = arg('markdown');
  if (jsonOut !== undefined) writeFileSync(jsonOut, json);
  if (markdownOut !== undefined) writeFileSync(markdownOut, markdown);
  console.log(markdown);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`TEST CENSUS: FAIL — ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
