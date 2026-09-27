#!/usr/bin/env tsx
/**
 * PHASE 3 SLICE GATE — P3-S7, the merchant screens and their reads
 * (docs/PHASE_3_EXECUTION_PLAN.md §8, P3-S7 contract §7.1 as amended by the
 * coordinator rulings and Annex R #14–#16).
 *
 * P3-S7 plans no migration. Its only admissible file is a conditional,
 * index-only `0069_…_read_indexes.sql` (A-02), admitted with T-17's EXPLAIN.
 * Two tenses, chosen by `S7_ACCEPTED_MARK`:
 *
 *   — CANDIDATE (`S7_ACCEPTED_MARK` null): `frozenThrough` is exactly the
 *     P3-S6 boundary 0068 and no migration sorts after it, or exactly
 *     `S7_MIGRATIONS` when 0069 was admitted.
 *   — ACCEPTED (the freeze commit sets the mark to 'P3-S7 accepted'):
 *     `frozenThrough` is a floor at 0068. With `S7_MIGRATIONS` empty nothing
 *     after 0068 is checked — P3-S8 owns 0069 on. Otherwise each S7 file
 *     hashes to `S7_ACCEPTED`.
 *
 * The S6 digests are checked through the manifest (0067/0068 recorded =
 * on disk) and by composing `gate:phase3:s6` as step 1 — never by importing
 * `phase3-s6-gate.ts`, which runs its gate at module load (Annex R #14).
 *
 * Structural checks, in both tenses: the boundary; no cache after 0068 (no
 * stored relation, view, grant or function; an admitted 0069 is CREATE INDEX
 * only); the required objects (three controllers in both process modules,
 * the eleven read routes, the shared DTO module, the Phase 3 client, the
 * proxy's PUT, the S7 pages, the web runner, the S7 catalog namespaces);
 * Rule 23 and the jargon pass as library calls; the suites; both runner
 * canaries.
 *
 * Usage: npm run gate:phase3:s7 [-- --list]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { findMerchantJargon, findS7SourceViolations, type CatalogLocale } from './guards/merchant-jargon';
import { discoverStoredRelations, stripComments } from './guards/sql-schema';
import { findResponsiveViolations, responsiveSurface } from './guards/web-responsive';

const ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(ROOT, 'infrastructure/database/migrations');
const LIST_ONLY = process.argv.slice(2).includes('--list');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The P3-S6 migrations, which P3-S7 sits directly on. */
const S6_MIGRATIONS = ['0067_payment_methods_supplier_settlement_sources.sql', '0068_supplier_settlement_commands.sql'] as const;

/** The P3-S6 acceptance boundary (S6 A-02). */
const S6_BOUNDARY = '0068_supplier_settlement_commands.sql';

/** P3-S7's migrations: none. Becomes ['0069_…_read_indexes.sql'] only under A-02's exception, with T-17's EXPLAIN attached. */
const S7_MIGRATIONS: readonly string[] = [];

/** The digests of `S7_MIGRATIONS` once accepted. Empty while there are none. */
const S7_ACCEPTED: Readonly<Record<string, string>> = {};

/** With no migration the tense cannot come from digests: the freeze commit sets this to 'P3-S7 accepted'. */
const S7_ACCEPTED_MARK: string | null = null;

const ACCEPTED = S7_ACCEPTED_MARK !== null;

/** The three new controllers (contract §4.2, §8 R). */
const CONTROLLERS: readonly (readonly [file: string, className: string])[] = [
  ['apps/api/src/modules/inventory/inventory-reads.controller.ts', 'InventoryReadsController'],
  ['apps/api/src/modules/purchasing/supplier-balances.controller.ts', 'SupplierBalancesController'],
  ['apps/api/src/modules/payment-methods/payment-method-defaults.controller.ts', 'PaymentMethodDefaultsController'],
];

/** The two process compositions every controller is registered in. */
const PROCESS_MODULES = ['apps/api/src/app/app.module.ts', 'apps/api/src/app/merchant-api.module.ts'];

/** The eleven S7 read routes, by decorator text: file → [controller prefix, route decorators]. */
const ROUTES: readonly (readonly [file: string, controller: string, gets: readonly string[]])[] = [
  [
    'apps/api/src/modules/inventory/inventory-reads.controller.ts',
    '/v1/inventory',
    ['access', 'warehouses', 'items', 'units', 'stock', 'stocktakes', 'stocktakes/:stocktakeId'],
  ],
  ['apps/api/src/modules/purchasing/supplier-balances.controller.ts', '/v1/supplier-balances', ['']],
  ['apps/api/src/modules/purchasing/suppliers.controller.ts', '/v1/suppliers', [':supplierId/open-purchases']],
  ['apps/api/src/modules/purchasing/purchases.controller.ts', '/v1/purchases', [':purchaseId/return-options']],
  ['apps/api/src/modules/payment-methods/payment-method-defaults.controller.ts', '/v1/payment-method-defaults', ['']],
];

/** The S7 screens of A-11 (eleven routes; Count Stock has its list and its detail page). */
const PAGES = [
  'stock',
  'stock/move',
  'stock/count',
  'stock/count/[stocktakeId]',
  'stock/adjust',
  'purchases',
  'purchases/receive',
  'purchases/[purchaseId]',
  'purchases/[purchaseId]/return',
  'suppliers',
  'suppliers/[supplierId]',
  'suppliers/[supplierId]/pay',
].map((route) => `apps/web/src/app/[locale]/${route}/page.tsx`);

const WEB_FILES = [
  'apps/web/src/lib/phase3-api.ts',
  'apps/web/src/lib/phase3-errors.ts',
  'apps/web/src/lib/phase3-format.ts',
  'apps/web/vitest.config.mts',
  'apps/web/test/fixtures/runner-exit-code/vitest.config.mts',
  'apps/web/test/fixtures/runner-exit-code/failing.fixture.tsx',
];

/** The S7 key namespaces (§4.3) every catalog carries. */
const NAMESPACES = ['nav.', 'common.', 'error.', 'stock.', 'purchasing.', 'suppliers.', 'payments.'];
const LOCALES: readonly CatalogLocale[] = ['ar', 'en', 'tr'];

/** T-17, run alone and last (§6 T-17; SM:36). */
const BUDGET_SUITE = 'tests/performance/phase3-s7-read-budgets.test.ts';

/**
 * T-17 Tier 1 (the P2-S8 §35 pattern): every push measures the unchanged
 * budgets at a tenth of the contract volume, because the contract-volume seed
 * takes about two hours through the real routines. An explicit
 * P3S7_PERF_SCALE in the environment wins. Tier 2 (scale 1) is the acceptance
 * evidence, run once and recorded in docs/PHASE_3_S7_ACCEPTANCE.md.
 */
const TIER1_SCALE = process.env['P3S7_PERF_SCALE'] ?? '0.1';
/** The guard proofs of Rule 23 and the widened G-6 (§7.2(b), (c)). */
const GUARD_SUITE = 'tests/integration/static-guards-s7.test.ts';

/** §6: at least the fifteen automated S7 suites. */
const MIN_SUITES = 15;

let failures = 0;
const fail = (check: string, detail: string): void => {
  failures += 1;
  console.error(`  FAIL [${check}] ${detail}`);
};
const ok = (detail: string): void => console.log(`  ok      ${detail}`);

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const sqlFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const sha256 = (name: string): string =>
  createHash('sha256')
    .update(readFileSync(join(MIGRATIONS_DIR, name)))
    .digest('hex');
const stripTsProse = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

function walk(dir: string, accept: (name: string) => boolean): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs).sort()) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) out.push(...walk(relative(ROOT, full), accept));
    else if (accept(entry)) out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out;
}

/** The S7 suites (§7.1(5)): `read-s7-*` and `web-s7-*` under tests/, and every web test. */
const discoveredSuites = (): string[] => walk('tests', (f) => /^(read|web)-s7-.*\.test\.ts$/.test(f)).sort();
const webSuites = (): string[] => walk('apps/web/test', (f) => /\.test\.tsx?$/.test(f)).sort();

// ── 1. Migration boundary ───────────────────────────────────────────────────
/** The migration files this gate owns: every file after 0068 while a candidate, only S7_MIGRATIONS once accepted. */
function s7Files(): string[] {
  return ACCEPTED ? [...S7_MIGRATIONS] : sqlFiles().filter((f) => f > S6_BOUNDARY);
}

function checkMigrationBoundary(): void {
  console.log(`P3-S7 GATE — migration boundary (${ACCEPTED ? 'accepted' : 'candidate'})`);
  const manifest = JSON.parse(read('infrastructure/database/MIGRATION_MANIFEST.json')) as {
    frozenThrough: string;
    migrations: { name: string; sha256: string }[];
  };
  const recorded = new Map(manifest.migrations.map((m) => [m.name, m.sha256]));

  // The S6 digests, through the manifest (Annex R #14): recorded = on disk.
  const s6Mark = failures;
  for (const name of S6_MIGRATIONS) {
    if (!existsSync(join(MIGRATIONS_DIR, name))) {
      fail('boundary', `${name} is missing`);
      continue;
    }
    const inManifest = recorded.get(name);
    if (inManifest === undefined) fail('boundary', `${name} is not frozen in the manifest — P3-S7 starts only after the P3-S6 freeze (TL-1)`);
    else if (inManifest !== sha256(name))
      fail('boundary', `${name} hashes to ${sha256(name).slice(0, 12)}… on disk but the manifest records ${inManifest.slice(0, 12)}…`);
  }
  if (failures === s6Mark) ok('0067 and 0068 hash to their manifest digests (the accepted digests themselves are proven by step 1)');

  if (!ACCEPTED) {
    if (manifest.frozenThrough !== S6_BOUNDARY) {
      fail('boundary', `frozenThrough is ${manifest.frozenThrough} — a P3-S7 candidate sits exactly on the P3-S6 boundary ${S6_BOUNDARY}`);
    } else {
      ok(`frozenThrough = ${S6_BOUNDARY} — P3-S7 is not frozen`);
    }
    const after = sqlFiles().filter((f) => f > S6_BOUNDARY);
    if (JSON.stringify(after) !== JSON.stringify([...S7_MIGRATIONS])) {
      fail(
        'boundary',
        `after 0068 a P3-S7 candidate holds ${S7_MIGRATIONS.length === 0 ? 'no migration' : `exactly ${S7_MIGRATIONS.join(', ')}`} — found ${after.join(', ') || 'none'}`,
      );
    } else {
      ok(S7_MIGRATIONS.length === 0 ? 'no migration sorts after 0068 — S7 plans none' : `after 0068 exactly ${S7_MIGRATIONS.join(', ')}`);
    }
    for (const name of S7_MIGRATIONS) {
      if (recorded.has(name)) fail('boundary', `${name} is in the manifest before P3-S7 was accepted — premature freeze`);
    }
    return;
  }

  if (manifest.frozenThrough < S6_BOUNDARY) {
    fail('boundary', `frozenThrough is ${manifest.frozenThrough} — it is a floor at ${S6_BOUNDARY} once P3-S7 is accepted`);
  } else {
    ok(`frozenThrough = ${manifest.frozenThrough} — at or beyond ${S6_BOUNDARY}`);
  }
  if (S7_MIGRATIONS.length === 0) {
    ok('S7 has no migration: nothing after 0068 is this gate’s to check (P3-S8 owns 0069 on)');
    return;
  }
  if (JSON.stringify(Object.keys(S7_ACCEPTED).sort()) !== JSON.stringify([...S7_MIGRATIONS].sort())) {
    fail('boundary', `S7_ACCEPTED must name exactly ${S7_MIGRATIONS.join(', ')}`);
  }
  for (const [name, accepted] of Object.entries(S7_ACCEPTED)) {
    if (!existsSync(join(MIGRATIONS_DIR, name))) {
      fail('boundary', `${name} was accepted but is missing`);
      continue;
    }
    if (sha256(name) !== accepted) fail('boundary', `${name} hashes to ${sha256(name).slice(0, 12)}… but was accepted at ${accepted.slice(0, 12)}…`);
    const inManifest = recorded.get(name);
    if (inManifest !== accepted) fail('boundary', `${name} is not frozen in the manifest at its accepted digest`);
  }
}

// ── 2. No cache after 0068 ──────────────────────────────────────────────────
function checkNoCache(): void {
  console.log('P3-S7 GATE — no stored figure, view, grant or function after 0068 (A-02, A-03)');
  const files = s7Files();
  if (files.length === 0) {
    ok('no P3-S7 migration to read');
    return;
  }
  const mark = failures;
  for (const name of files) {
    const path = join(MIGRATIONS_DIR, name);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    const relations = discoverStoredRelations(raw);
    if (relations.length > 0) fail('no-cache', `${name} stores ${relations.join(', ')} — S7 reads are derived at request time`);
    const sql = stripComments(raw);
    const forbidden = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b|\bGRANT\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.exec(sql);
    if (forbidden) fail('no-cache', `${name} contains ${forbidden[0].replace(/\s+/g, ' ')} — P3-S7 adds no view, grant or function`);
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const other = statements.filter((s) => !/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(s));
    if (other.length > 0) fail('no-cache', `${name} holds a statement other than CREATE INDEX: ${(other[0] ?? '').slice(0, 80)}`);
  }
  if (failures === mark) ok(`${files.join(', ')}: CREATE INDEX and comments only`);
}

// ── 3. Required objects ─────────────────────────────────────────────────────
function checkRequiredObjects(): void {
  console.log('P3-S7 GATE — required objects (contract §4, A-11, A-12)');
  const mark = failures;
  for (const [file, className] of CONTROLLERS) {
    if (!existsSync(join(ROOT, file))) {
      fail('objects', `${file} is missing`);
      continue;
    }
    for (const mod of PROCESS_MODULES) {
      const code = stripTsProse(read(mod));
      if (!new RegExp(`controllers[\\s\\S]*\\b${className}\\b`).test(code)) {
        fail('objects', `${className} is not registered in ${mod}`);
      }
    }
  }
  let routes = 0;
  for (const [file, controller, gets] of ROUTES) {
    if (!existsSync(join(ROOT, file))) {
      fail('objects', `${file} is missing`);
      continue;
    }
    const code = stripTsProse(read(file));
    if (!code.includes(`@Controller('${controller}')`)) fail('objects', `${file} has no @Controller('${controller}')`);
    for (const route of gets) {
      const decorator = route === '' ? /@Get\(\s*\)/ : new RegExp(`@Get\\(\\s*'${route.replace(/[/:]/g, (c) => `\\${c}`)}'\\s*\\)`);
      if (decorator.test(code)) routes += 1;
      else fail('objects', `GET ${controller}${route === '' ? '' : `/${route}`} is not declared in ${file}`);
    }
  }
  if (routes !== 11) fail('objects', `the eleven S7 read routes must all be declared — found ${routes}`);
  const contracts = 'packages/shared-contracts/src/merchant-reads.ts';
  if (!existsSync(join(ROOT, contracts))) fail('objects', `${contracts} is missing`);
  if (
    !/export\s+\*\s+from\s+'\.\/merchant-reads'|export\s+(?:type\s+)?\{[^}]*\}\s+from\s+'\.\/merchant-reads'/.test(
      read('packages/shared-contracts/src/index.ts'),
    )
  ) {
    fail('objects', 'packages/shared-contracts/src/index.ts does not export ./merchant-reads');
  }
  for (const file of WEB_FILES) if (!existsSync(join(ROOT, file))) fail('objects', `${file} is missing`);
  const proxy = stripTsProse(read('apps/web/src/app/api/proxy/[...path]/route.ts'));
  if (!/export\s+(?:async\s+function\s+PUT\b|const\s+PUT\b|\{[^}]*\bPUT\b[^}]*\})/.test(proxy)) fail('objects', 'the BFF proxy does not export PUT (A-12(1))');
  for (const header of ['accept-language', 'idempotency-key']) if (!proxy.includes(`'${header}'`)) fail('objects', `the BFF proxy does not forward ${header}`);
  if (!proxy.includes('cache-control')) fail('objects', 'the BFF proxy does not return cache-control');
  for (const page of PAGES) if (!existsSync(join(ROOT, page))) fail('objects', `the S7 page ${page} is missing (A-11)`);
  const rootPackage = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  if (!(rootPackage.scripts['test'] ?? '').includes('npm run test -w @daftar/web')) fail('objects', 'root npm test does not run the web tests (§7.3 pin 1)');
  const webPackage = JSON.parse(read('apps/web/package.json')) as { scripts: Record<string, string> };
  if (!(webPackage.scripts['test'] ?? '').includes('vitest.config.mts')) fail('objects', 'apps/web has no test script on vitest.config.mts');
  for (const locale of LOCALES) {
    const catalog = JSON.parse(read(`apps/web/src/messages/${locale}.json`)) as Record<string, string>;
    for (const ns of NAMESPACES) {
      if (!Object.keys(catalog).some((k) => k.startsWith(ns))) fail('objects', `the ${locale} catalog has no ${ns}* key (§4.3)`);
    }
  }
  if (failures === mark)
    ok(
      `${CONTROLLERS.length} controllers in both processes; the 11 read routes; merchant-reads exported; the Phase 3 client and proxy PUT; ${PAGES.length} S7 pages; the web runner; ${NAMESPACES.length} namespaces × 3 catalogs`,
    );
}

// ── 4. Web static rules, as library calls ───────────────────────────────────
function checkWebStatics(): void {
  console.log('P3-S7 GATE — Rule 23 and the merchant-jargon pass');
  const mark = failures;
  const files: Record<string, string> = {};
  for (const path of walk('apps/web/src', (f) => /\.tsx?$/.test(f))) files[path] = read(path);
  if (responsiveSurface(files).length === 0) fail('web', 'no S7 web file found — Rule 23 would be watching nothing');
  for (const v of findResponsiveViolations(files)) fail('web', `${v.file}:${v.line} ${v.rule}: \`${v.evidence}\` — ${v.why}`);
  for (const v of findS7SourceViolations(files)) fail('web', `${v.file}:${v.line} ${v.rule}: \`${v.evidence}\``);
  const catalogs: Partial<Record<CatalogLocale, Record<string, string>>> = {};
  for (const locale of LOCALES) catalogs[locale] = JSON.parse(read(`apps/web/src/messages/${locale}.json`)) as Record<string, string>;
  for (const hit of findMerchantJargon(catalogs)) fail('jargon', `${hit.locale} ${hit.key}: "${hit.value}" uses "${hit.term}"`);
  if (failures === mark) ok(`Rule 23 clean over ${responsiveSurface(files).length} S7 web files; no S7 key or view carries jargon`);
}

// ── 5. Suites ───────────────────────────────────────────────────────────────
function checkSuites(): void {
  console.log('P3-S7 GATE — suites');
  const mark = failures;
  const suites = [...discoveredSuites(), ...webSuites()];
  if (suites.length < MIN_SUITES) fail('suite', `fewer than ${MIN_SUITES} S7 suites exist (found ${suites.length}: ${suites.join(', ')})`);
  for (const required of [GUARD_SUITE, BUDGET_SUITE]) if (!existsSync(join(ROOT, required))) fail('suite', `${required} is missing`);
  if (failures === mark) ok(`${suites.length} S7 suites discovered (${discoveredSuites().length} API, ${webSuites().length} web), the guard proofs and T-17`);
}

// ── 6. Runner canaries ──────────────────────────────────────────────────────
/** Prove a runner can still report failure before trusting any result (phase3-s6-gate.ts, Annex R #15). */
function canary(label: string, args: readonly string[]): void {
  const res = spawnSync('npx', ['vitest', 'run', ...args], { cwd: ROOT, encoding: 'utf8', env: process.env });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!/1 failed/.test(output)) {
    fail('runner', `the ${label} canary did not run its failing test, so this run proves nothing about that runner:\n${output.slice(-2000)}`);
    return;
  }
  if (res.status === 0) {
    fail('runner', `the ${label} runner exited 0 over a failing test; no result it gives is evidence (tests/helpers/exit-code.ts)`);
    return;
  }
  ok(`the ${label} runner reports failure (canary exited ${res.status ?? 'on a signal'})`);
}

function checkRunnersReportFailure(): void {
  canary('root', ['--config', 'tests/fixtures/runner-exit-code/vitest.config.ts', 'failing']);
  canary('web', ['--config', 'apps/web/test/fixtures/runner-exit-code/vitest.config.mts', 'failing']);
}

const STEPS = (): { name: string; cmd: string; args: string[]; env?: Record<string, string> }[] => [
  { name: 'P3-S6 gate (permanent predecessor, composes P3-S5 … P3-S1, P2 and Phase 1)', cmd: npm, args: ['run', 'gate:phase3:s6'] },
  { name: 'localization, with the S7 jargon and source pass', cmd: npm, args: ['run', 'check:localization'] },
  { name: 'static guards, with Rules 19 (G-6 widened) and 23', cmd: npm, args: ['run', 'check:guards'] },
  { name: '@daftar/shared-contracts unit suite', cmd: npm, args: ['run', 'test', '-w', '@daftar/shared-contracts'] },
  { name: 'web SSR, catalog and platform suites (T-08 … T-10, T-12, T-15, T-16)', cmd: npm, args: ['run', 'test', '-w', '@daftar/web'] },
  { name: 'S7 read and client-contract suites, and the guard proofs', cmd: 'npx', args: ['vitest', 'run', ...discoveredSuites(), GUARD_SUITE] },
  {
    name: 'Phase 1 web contract golden and process composition',
    cmd: 'npx',
    args: ['vitest', 'run', 'tests/golden-regression/phase1/06-web-contract.golden.test.ts', 'tests/integration/process-composition.test.ts'],
  },
  {
    name: `T-17 read budgets (Tier 1, scale ${TIER1_SCALE}), in isolation and last`,
    cmd: 'npx',
    args: ['vitest', 'run', BUDGET_SUITE],
    env: { P3S7_PERF_SCALE: TIER1_SCALE },
  },
];

function runSteps(): void {
  console.log('P3-S7 GATE — composed regression matrix');
  checkRunnersReportFailure();
  if (failures > 0) {
    console.error('\nP3-S7 GATE: FAIL — a test runner cannot report failure; refusing to run the regression matrix');
    process.exit(1);
  }
  for (const step of STEPS()) {
    const started = Date.now();
    const res = spawnSync(step.cmd, [...step.args], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', env: { ...process.env, ...step.env } });
    const ms = Date.now() - started;
    if (res.status !== 0) fail('regression', `${step.name} failed (exit ${res.status ?? 'signal'}) after ${ms}ms`);
    else ok(`${step.name} (${ms}ms)`);
  }
}

if (LIST_ONLY) {
  console.log(`P3-S7 GATE plan (${ACCEPTED ? 'accepted' : 'candidate'}):`);
  if (ACCEPTED)
    console.log(
      `  structural: frozenThrough at or beyond ${S6_BOUNDARY}; ${S7_MIGRATIONS.length === 0 ? 'nothing after it checked' : S7_MIGRATIONS.join(', ')}`,
    );
  else
    console.log(
      `  structural: frozenThrough = ${S6_BOUNDARY}; after it ${S7_MIGRATIONS.length === 0 ? 'no migration' : `exactly ${S7_MIGRATIONS.join(', ')}`}`,
    );
  console.log('  structural: 0067/0068 manifest digests = disk; no stored relation, view, grant or function after 0068');
  console.log('  structural: controllers in both processes, 11 routes, merchant-reads export, phase3-api, proxy PUT, S7 pages, web runner, namespaces');
  console.log('  structural: Rule 23 and the jargon pass as library calls; at least 15 S7 suites; root and web runner canaries');
  for (const s of STEPS()) console.log(`  command:    ${s.cmd} ${s.args.join(' ')}`);
  process.exit(0);
}

checkMigrationBoundary();
checkNoCache();
checkRequiredObjects();
checkWebStatics();
checkSuites();
if (failures > 0) {
  console.error(`\nP3-S7 GATE: FAIL (${failures} structural violation${failures === 1 ? '' : 's'}) — not running the regression matrix`);
  process.exit(1);
}
runSteps();

if (failures > 0) {
  console.error(`\nP3-S7 GATE: FAIL (${failures})`);
  process.exit(1);
}
console.log('\nP3-S7 GATE: PASS');
