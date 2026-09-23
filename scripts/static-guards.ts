#!/usr/bin/env tsx
/**
 * Static architecture guards (Final Enforcement Directive §65).
 * Fails the build when a forbidden pattern re-enters the tree. These guards
 * are the machine enforcement of the Phase 1 security/tenancy invariants.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ACCOUNTING_AUTHORITY_TABLES,
  discoverAccountingTables,
  findAuthoritativeBalanceColumns,
  isForbiddenBalanceTable,
} from './guards/no-authoritative-balance';
import { findFloatRateColumns } from './guards/no-float-rate';
import { findDefinerSearchPathViolations } from './guards/definer-search-path';
import { findReadSurfaceViolations, readSurfaceFiles } from './guards/read-surface';
import { findPostingSurfaceViolations } from './guards/posting-surface';

const ROOT = join(__dirname, '..');
let failures = 0;
const fail = (rule: string, file: string, detail: string) => {
  failures++;
  console.error(`  FAIL [${rule}] ${relative(ROOT, file)}: ${detail}`);
};

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (['node_modules', '.next', 'dist', '.git', 'build', '.gradle'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.test(entry)) out.push(full);
  }
  return out;
}

const tsFiles = (dir: string) => walk(dir, /\.(ts|tsx)$/);

// Rule 1: Web/Admin must never touch the database or server infra.
for (const surface of ['apps/web/src', 'apps/admin/src']) {
  for (const f of tsFiles(join(ROOT, surface))) {
    const src = readFileSync(f, 'utf8');
    if (/from 'pg'|require\('pg'\)|@nestjs\/|DATABASE_URL|daftar_(app|platform|worker|migrator|provisioner|identity|resolver)/.test(src)) {
      fail('no-direct-db', f, 'web/admin imports database or server-only infrastructure');
    }
  }
}

// Rule 2: Android must never embed DB access or secrets.
for (const f of walk(join(ROOT, 'apps/android'), /\.(kt|kts|xml)$/)) {
  const src = readFileSync(f, 'utf8');
  if (/jdbc:|postgres:\/\/|DATABASE_URL|BEGIN TRANSACTION/i.test(src)) fail('android-no-db', f, 'android references a database');
  if (/DEV_TEST_KEY|argon2id\$|Daftar-[A-Za-z0-9]{8,}/.test(src) && !/test/i.test(f)) fail('android-no-secrets', f, 'android embeds secret material');
}

// Rule 3: migration credentials must never appear in HTTP runtime code.
for (const f of tsFiles(join(ROOT, 'apps/api/src'))) {
  if (/migrate\.ts|bootstrap-platform-owner|config\.ts/.test(f)) continue;
  const src = readFileSync(f, 'utf8');
  if (/MIGRATION_DATABASE_URL/.test(src)) fail('no-migration-creds-in-runtime', f, 'HTTP runtime references MIGRATION_DATABASE_URL');
}

// Rule 4: merchant flows must NOT use platform authority (withPlatformTransaction).
const MERCHANT_MODULES = ['catalog', 'tenancy', 'team', 'auth', 'onboarding', 'media', 'outbox', 'delivery'];
for (const f of tsFiles(join(ROOT, 'apps/api/src/modules'))) {
  if (!MERCHANT_MODULES.some((m) => f.includes(`modules/${m}/`))) continue;
  const src = readFileSync(f, 'utf8');
  if (/withPlatformTransaction/.test(src)) fail('merchant-no-platform-db', f, 'merchant module calls withPlatformTransaction');
}

// Rule 5: no generic RLS bypass outside the provisioner boundary.
for (const f of tsFiles(join(ROOT, 'apps/api/src'))) {
  const src = readFileSync(f, 'utf8');
  if (/app_bypass_rls|BYPASSRLS|SET row_security\s*=\s*off/i.test(src) && !/provisioner/.test(f)) {
    fail('no-generic-rls-bypass', f, 'generic RLS bypass outside provisioner boundary');
  }
}

// Rule 6: money is bigint minor units — never Float/Number for amounts (TS + SQL).
for (const f of [...tsFiles(join(ROOT, 'apps/api/src')), ...tsFiles(join(ROOT, 'packages'))]) {
  const src = readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\*)/.test(line)) return; // comments may name the anti-pattern
    if (/(amount|price|total|balance|cost|fee)(Minor)?\s*:\s*number\b/i.test(line)) {
      fail('money-bigint', f, `line ${i + 1}: money expressed as number`);
    }
    if (/Number\(\s*\w*(amount|price)\w*Minor\s*\)/i.test(line)) fail('money-bigint', f, `line ${i + 1}: Number() on minor units`);
  });
}
for (const f of walk(join(ROOT, 'infrastructure/database/migrations'), /\.sql$/)) {
  const src = readFileSync(f, 'utf8');
  if (/(amount|price|total|balance)\w*\s+(REAL|DOUBLE PRECISION|FLOAT|NUMERIC\(\d+\s*,\s*\d+\))/i.test(src)) {
    fail('money-bigint-sql', f, 'money column is float/numeric — must be bigint minor units');
  }
}

// Rule 6b (Completion Directive §34): NO BigInt → Number for money anywhere a
// client or contract package formats or parses amounts. `Number(`/parseFloat/
// parseInt applied to anything named like money is forbidden in every TS
// surface (API, contract packages, web, admin).
for (const dir of [
  'apps/api/src',
  'packages/domain-core/src',
  'packages/shared-contracts/src',
  'packages/design-system/src',
  'apps/web/src',
  'apps/admin/src',
]) {
  for (const f of tsFiles(join(ROOT, dir))) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/\b(Number|parseFloat|parseInt)\(\s*[^)]*\b\w*(minor|amount|price|money)\w*/i.test(line)) {
        fail('money-no-number-conversion', f, `line ${i + 1}: money converted through Number/parseFloat/parseInt`);
      }
    });
  }
}

// Rule 7: no mutable derived financial columns (product.stock / customer.balance ledgers).
for (const f of walk(join(ROOT, 'infrastructure/database/migrations'), /\.sql$/)) {
  const src = readFileSync(f, 'utf8');
  if (/\.stock\b.*UPDATE|UPDATE.*SET\s+stock\s*=/i.test(src)) fail('no-mutable-ledger', f, 'mutable stock column update');
}

// Rule 7b (Ultimate Closure §15–16): the EFFECTIVE app_bypass() definition must
// name ONLY the platform administrative principal. The last CREATE OR REPLACE
// across migrations wins — check that final definition.
{
  const files = walk(join(ROOT, 'infrastructure/database/migrations'), /\.sql$/).sort();
  let lastDef: { file: string; body: string } | null = null;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = /CREATE OR REPLACE FUNCTION app_bypass\(\)[\s\S]*?AS \$\$[\s\S]*?\$\$;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) lastDef = { file: f, body: m[0] };
  }
  if (!lastDef) {
    fail('bypass-definition', 'infrastructure/database/migrations', 'app_bypass() definition not found');
  } else {
    if (!lastDef.body.includes('daftar_platform')) {
      fail('bypass-definition', lastDef.file, 'app_bypass() must include the platform administrative principal');
    }
    for (const role of ['daftar_provisioner', 'daftar_worker', 'daftar_resolver', 'daftar_identity', 'daftar_app']) {
      if (lastDef.body.includes(role)) {
        fail('bypass-definition', lastDef.file, `app_bypass() must NOT include runtime role ${role} (Ultimate Closure §15–16)`);
      }
    }
  }
}

// Rule 8: production must never select the DEV_TEST_KEY adapter.
for (const f of tsFiles(join(ROOT, 'apps/api/src'))) {
  const src = readFileSync(f, 'utf8');
  if (/DEV_TEST_KEY/.test(src) && !/NODE_ENV.*(test|development)|isProd|production/i.test(src)) {
    fail('no-dev-key-prod', f, 'DEV_TEST_KEY without an explicit non-production guard');
  }
}

// Rule 9: merchant request path must never drain the worker queue.
for (const f of tsFiles(join(ROOT, 'apps/api/src/modules'))) {
  if (f.includes('modules/worker/') || f.endsWith('delivery-worker.service.ts')) continue;
  const src = readFileSync(f, 'utf8');
  if (/drainSafely|DeliveryWorkerService/.test(src) && !/enqueuer/i.test(f)) {
    fail('merchant-no-drain', f, 'merchant module references worker drain/DeliveryWorkerService');
  }
}

// Rule 10: no plaintext credential columns.
for (const f of walk(join(ROOT, 'infrastructure/database/migrations'), /\.sql$/)) {
  const num = Number(f.match(/(\d{4})_/)?.[1] ?? '9999');
  if (num <= 28) continue; // frozen history — remediated by 0025/0028 payload protection
  const src = readFileSync(f, 'utf8');
  if (/\b(password|token|secret)\b(?!_hash|_digest|_ciphertext)\s+(TEXT|VARCHAR)/i.test(src)) {
    if (!/password_hash|refresh_token_hash|token_hash|token_digest/.test(src)) {
      fail('no-plaintext-credentials', f, 'possible plaintext credential column');
    }
  }
}

// Rule 11: no token/secret logging.
for (const f of tsFiles(join(ROOT, 'apps/api/src'))) {
  const src = readFileSync(f, 'utf8');
  if (
    /console\.(log|info|debug)\([^)]*(refreshToken|accessToken|password|secret)/i.test(src) ||
    /logger\.(log|debug|verbose)\([^)]*(refreshToken|password|secret_ciphertext)/i.test(src)
  ) {
    fail('no-token-logging', f, 'token/secret passed to a logger');
  }
}

// Rule 12: no client-provided owner authority, no hard-coded plan-name branching.
for (const f of tsFiles(join(ROOT, 'apps/api/src/modules'))) {
  const src = readFileSync(f, 'utf8');
  if (/body\.(isOwner|isPlatformOwner|role\s*===?\s*'owner')/.test(src)) fail('no-client-authority', f, 'client-controlled authority flag');
  if (/planKey\s*===?\s*'(free|starter|pro|business)'/.test(src) && !f.includes('modules/admin/')) {
    fail('no-hardcoded-plan-branching', f, 'hard-coded plan-name branching outside admin');
  }
}

// Rule 13 (Completion Directive §15–18): REAL runtime process isolation is a
// compile-time property of the process modules — a merchant process module
// must never reference admin/worker/decrypt providers; the platform module
// must never reference merchant mutation surfaces; the worker must have no
// controllers at all.
{
  // Comments may NAME the forbidden providers (to say they are absent); only code counts.
  const read = (rel: string) =>
    readFileSync(join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const merchant = read('apps/api/src/app/merchant-api.module.ts');
  for (const forbidden of [
    'AdminController',
    'AdminService',
    'CredentialDeliveryWorker',
    'CredentialPayloadProtector',
    'OutboxPublisher',
    'workerProviders',
    'CREDENTIAL_DELIVERY',
  ]) {
    if (merchant.includes(forbidden)) fail('runtime-isolation', 'apps/api/src/app/merchant-api.module.ts', `merchant process references ${forbidden}`);
  }
  const platform = read('apps/api/src/app/platform-api.module.ts');
  for (const forbidden of [
    'TenancyController',
    'CatalogController',
    'EntitlementsController',
    'MediaService',
    'CatalogService',
    'StructureService',
    'InvitationsService',
    'CredentialDeliveryWorker',
    'CredentialPayloadProtector',
    'workerProviders',
    'merchantInfraProviders',
  ]) {
    if (platform.includes(forbidden)) fail('runtime-isolation', 'apps/api/src/app/platform-api.module.ts', `platform process references ${forbidden}`);
  }
  const worker = read('apps/api/src/app/worker.module.ts');
  if (/controllers\s*:/.test(worker) || /Controller\b/.test(worker) || /httpProviders|identityProviders|merchantInfraProviders|TokenService/.test(worker)) {
    fail('runtime-isolation', 'apps/api/src/app/worker.module.ts', 'worker process must have no HTTP surface, identity or merchant providers');
  }
  const main = read('apps/api/src/main.ts');
  for (const mod of ['MerchantApiModule', 'PlatformApiModule', 'WorkerModule']) {
    if (!main.includes(mod)) fail('runtime-isolation', 'apps/api/src/main.ts', `entrypoint does not compose ${mod}`);
  }
}

// Rule 14 (§57): migration credentials never appear in any runtime module,
// package or client; only the migrator/bootstrap CLIs may read them.
for (const dir of ['apps/api/src', 'apps/web/src', 'apps/admin/src', 'packages']) {
  for (const f of tsFiles(join(ROOT, dir))) {
    if (/migrate\.ts$|config\.ts$/.test(f)) continue;
    if (/MIGRATION_DATABASE_URL/.test(readFileSync(f, 'utf8'))) fail('no-migration-creds-in-runtime', f, 'references MIGRATION_DATABASE_URL');
  }
}

// Rule 15 — GUARD G-3 (Architecture Lock, P2-S1): no authoritative mutable
// balance column on an accounting source-of-truth table. The journal is the
// financial truth; a stored balance column is a second truth that can drift
// and, once it does, nothing says which of the two lied. Storage authority
// only — a report DTO or a query result named `balance` is a read model and
// is deliberately untouched by this rule.
{
  const migrations = walk(join(ROOT, 'infrastructure/database/migrations'), /\.sql$/);
  const schema = migrations.map((f) => readFileSync(f, 'utf8')).join('\n');

  // P2-S7 §60: the watched set is every accounting-owned table the schema
  // actually creates, not a list somebody has to remember to extend.
  const watched = discoverAccountingTables(schema);
  for (const f of migrations) {
    for (const hit of findAuthoritativeBalanceColumns(readFileSync(f, 'utf8'), watched)) {
      fail('no-authoritative-balance', f, `${hit.table}.${hit.column} claims storage authority over a derived financial quantity (G-3)`);
    }
  }

  // The other shape: a table that IS the stored balance, whose columns are
  // innocently named. AL-15 refuses the storage, however it is spelled.
  for (const table of watched) {
    if (isForbiddenBalanceTable(table)) {
      fail(
        'no-authoritative-balance',
        'infrastructure/database/migrations',
        `table \`${table}\` stores accounting balances — the journal is the only financial truth (G-3/AL-15)`,
      );
    }
  }

  // The guard must actually be watching something: if the declared
  // source-of-truth table has not been created yet, G-3 is decorative.
  for (const table of ACCOUNTING_AUTHORITY_TABLES) {
    if (!watched.includes(table)) {
      fail(
        'no-authoritative-balance',
        'infrastructure/database/migrations',
        `declared accounting source-of-truth table \`${table}\` does not exist — G-3 is watching nothing`,
      );
    }
  }
}

// Rule 16 — GUARD G-2 (Architecture Lock, P2-S2): no floating-point financial
// rate in authoritative accounting storage. Rule 6's SQL half keys off
// `amount|price|total|balance`, so a column named `fx_rate` passes it
// untouched; this is the rate-shaped half. Scoped to accounting tables on
// purpose — a conversion rate on a marketing funnel is not ledger authority,
// and a repository-wide ban would be a guard nobody could live with.
{
  const migrations = walk(join(ROOT, 'infrastructure/database/migrations'), /\.sql$/);
  for (const f of migrations) {
    for (const hit of findFloatRateColumns(readFileSync(f, 'utf8'))) {
      fail('no-float-rate', f, `${hit.table}.${hit.column} ${hit.detail}`);
    }
  }
  // A guard watching nothing is decorative: the rate column it exists for
  // must actually be in the tree.
  const schema = migrations.map((f) => readFileSync(f, 'utf8')).join('\n');
  if (!/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?journal_lines\b/i.test(schema)) {
    fail('no-float-rate', 'infrastructure/database/migrations', 'journal_lines does not exist — G-2 is watching nothing');
  }
}

// Rule 17 — GUARD G-4 (P2-S3, §67): the ledger writer may not exist without
// the protections that make it safe, may not be reachable by any runtime role
// but the merchant one, and may not be bypassed by application code writing
// the journal directly. Stated as an implication, so a repository with no
// writer passes and a repository with a half-dismantled one does not.
{
  const migrations = walk(join(ROOT, 'infrastructure/database/migrations'), /\.sql$/)
    .sort()
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  // Application code only. Tests legitimately write the journal as the schema
  // owner to reach a constraint the writer would never let them reach, and
  // migrations ARE the schema; neither is a service going around the writer.
  const appFiles: Record<string, string> = {};
  for (const surface of ['apps/api/src', 'apps/web/src', 'apps/admin/src', 'packages']) {
    for (const f of tsFiles(join(ROOT, surface))) {
      if (/\.(test|spec)\.ts$/.test(f) || /[\\/]test[\\/]/.test(f)) continue;
      appFiles[relative(ROOT, f)] = readFileSync(f, 'utf8');
    }
  }
  for (const violation of findPostingSurfaceViolations({ schema: migrations, appFiles })) {
    fail('posting-surface', 'infrastructure/database/migrations', violation);
  }
}

// Rule 18 — GUARD G-5 (P2-S3 correction, §9): no SECURITY DEFINER routine may
// resolve a name through a schema its caller can write, and no routine may
// depend on a session relation. The live half of this rule is the catalogue
// matrix in tests/security/search-path-shadowing.test.ts; this half fails on a
// pull request, before any server exists to ask.
{
  const migrations: Record<string, string> = {};
  for (const f of walk(join(ROOT, 'infrastructure/database/migrations'), /\.sql$/).sort()) {
    migrations[relative(ROOT, f)] = readFileSync(f, 'utf8');
  }
  // Frozen files are reported only for the one shape no ALTER can repair (no
  // pinned path at all). Their ordering is corrected in the effective state by
  // a candidate migration, because their bytes may never change.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'infrastructure/database/MIGRATION_MANIFEST.json'), 'utf8')) as {
    migrations: { name: string }[];
  };
  const frozen = new Set(manifest.migrations.map((m) => m.name));
  for (const violation of findDefinerSearchPathViolations({
    migrations,
    bootstrap: readFileSync(join(ROOT, 'infrastructure/database/bootstrap.sql'), 'utf8'),
    frozen,
  })) {
    fail('definer-search-path', 'infrastructure/database', violation);
  }
}

// Rule 19 — GUARD G-6 (P2-S7, §61): the financial READ surface is read-only,
// pages by keyset, renders the FX snapshot frozen on the line, never filters
// history on `is_active`, and never turns an amount into a double. G-4 says
// "application code must not write the journal" repository-wide; this says
// the narrower things that are only wrong in a report, and says them where a
// report is.
{
  const reportFiles: Record<string, string> = {};
  for (const surface of ['apps/api/src', 'packages']) {
    for (const f of tsFiles(join(ROOT, surface))) {
      if (/\.(test|spec)\.ts$/.test(f) || /[\\/]test[\\/]/.test(f)) continue;
      reportFiles[relative(ROOT, f)] = readFileSync(f, 'utf8');
    }
  }
  for (const v of findReadSurfaceViolations(reportFiles)) {
    fail('read-surface', v.file, `${v.rule}: found \`${v.evidence}\` — ${v.why} (G-6)`);
  }
  // A guard watching nothing is decorative.
  if (readSurfaceFiles(reportFiles).length === 0) {
    fail('read-surface', 'apps/api/src', 'no accounting reporting module found — G-6 is watching nothing');
  }
}

if (failures > 0) {
  console.error(`\nSTATIC GUARDS: FAIL (${failures})`);
  process.exit(1);
}
console.log('STATIC GUARDS: PASS (19 rules)');
