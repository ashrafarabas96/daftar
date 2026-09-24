/**
 * THE CANDIDATE CORRECTION, MEASURED BEFORE IT IS WRITTEN.
 *
 * `accounting-trial-balance-diagnosis.test.ts` established two independent
 * causes for the trial balance missing budget C at the acceptance scale, and
 * this suite measures the correction for both of them together, because
 * neither one alone is a fix:
 *
 *   CAUSE 1 — THE CALL. `app_bypass()`, `app_tenant()` and `app_business()`
 *     each carry `SET search_path`, and PostgreSQL's SQL-function inliner
 *     refuses outright to inline any function with a SET clause. So every
 *     policy evaluation is four real function calls per journal line. Removing
 *     the need for the clause — by resolving every name in the bodies at
 *     creation time instead of at call time — took the raw line aggregate
 *     from 965 ms to 107 ms.
 *
 *   CAUSE 2 — THE ESTIMATE. `tenant_id::text = app_tenant()` casts the COLUMN,
 *     which throws away that column's statistics: the planner falls back to a
 *     blind default and estimated 522 rows out of 104,478. Comparing uuid to
 *     uuid instead — casting the setting once rather than every row — was the
 *     only form measured that estimated 104,464, which is right. With cause 1
 *     fixed and cause 2 left alone the whole report got WORSE, not better:
 *     6,892 ms and 4.8 million blocks, because the planner re-ran the
 *     aggregate once per chart account.
 *
 * So the candidate is both, and this suite measures both, on one scratch
 * database, against the same rows, with the answer compared every time. It
 * also measures the restrictive `business_isolation` policy's own cast
 * separately — NOT as a proposal, since the directive's §5 puts that policy
 * out of scope, but so the evidence can say whether leaving it as it is
 * costs the budget anything.
 *
 * `P2S8_CANDIDATE=1`.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { accountTotalsSql } from '../../apps/api/src/modules/accounting/accounting-reports.reader';
import { APP_DB_PASSWORD, PG_PASSWORD, PG_PORT, PG_USER, applyBootstrap, ensureDatabase, startOrReuse } from '../helpers/embedded-cluster';
import { must } from '../helpers/accounting-posting';
import { generateDataset, TIER2_REPORTING_SPEC } from './accounting-dataset';

const ENABLED = process.env['P2S8_CANDIDATE'] === '1';
const DB = `daftar_candidate_${process.pid}`;
const ownerUrl = (db: string): string => `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`;
const appUrl = `postgresql://daftar_app:${APP_DB_PASSWORD}@localhost:${PG_PORT}/${DB}`;

const WARMUP = 3;
const ITERATIONS = 10;

const PRODUCTION_SQL = accountTotalsSql(['l.business_id = $1', 'e.entry_date >= $2::date', 'e.entry_date <= $3::date'], ['a.business_id = $1']);
const RAW_LINE_AGGREGATE_SQL = `SELECT l.account_id, sum(l.debit_minor) AS debit, sum(l.credit_minor) AS credit
                                  FROM journal_lines l WHERE l.business_id = $1 GROUP BY l.account_id`;

/** The three helpers, with every name in them resolved at creation time. */
const INLINABLE_HELPERS = [
  `CREATE OR REPLACE FUNCTION app_tenant() RETURNS TEXT LANGUAGE sql STABLE PARALLEL SAFE
     RETURN pg_catalog.current_setting('app.tenant_id', true)`,
  `CREATE OR REPLACE FUNCTION app_business() RETURNS TEXT LANGUAGE sql STABLE PARALLEL SAFE
     RETURN pg_catalog.current_setting('app.business_id', true)`,
  `CREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE PARALLEL SAFE
     RETURN CURRENT_USER OPERATOR(pg_catalog.=) 'daftar_platform'::pg_catalog.name`,
];

/**
 * The tenant policy, comparing uuid to uuid.
 *
 * `nullif(..., '')` is what keeps the accepted behaviour for a caller with no
 * scope set: `current_setting(..., true)` answers the empty string, which is
 * not a uuid, and casting it would raise where the accepted contract is that
 * an unscoped read sees nothing. `nullif` turns it into NULL first, and
 * `tenant_id = NULL` is NULL, so the row is not visible — the same answer the
 * text comparison gave, by the same reasoning.
 */
const TENANT_POLICY_UUID = `ALTER POLICY tenant_membership ON journal_lines
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`;

/** DIAGNOSTIC ONLY — §5 puts this policy out of scope for 0052. */
const BUSINESS_POLICY_UUID = `ALTER POLICY business_isolation ON journal_lines
  USING      (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid)`;

interface Reading {
  readonly variant: string;
  readonly stage: string;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly rowCount: number;
  readonly sharedBlocks: number;
  readonly linesEstimated: number;
  readonly linesActual: number;
  readonly linesLoops: number;
  readonly workersLaunched: number;
  readonly nodeTypes: string[];
}

const readings: Reading[] = [];
const answers: Record<string, string> = {};

function walk(node: Record<string, unknown>, out: { nodes: string[]; scans: Record<string, { est: number; act: number; loops: number }> }): void {
  const type = node['Node Type'];
  if (typeof type === 'string') out.nodes.push(type);
  const relation = node['Relation Name'];
  if (typeof relation === 'string') {
    out.scans[relation] = { est: Number(node['Plan Rows'] ?? 0), act: Number(node['Actual Rows'] ?? 0), loops: Number(node['Actual Loops'] ?? 0) };
  }
  const children = node['Plans'];
  if (Array.isArray(children)) for (const child of children) walk(child as Record<string, unknown>, out);
}

function percentile(sorted: readonly number[], q: number): number {
  return must(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]);
}

let scope: { tenantId: string; businessId: string; from: string; to: string };
let seededLines = 0;
let seededEntries = 0;

async function read(variant: string, sql: string, stage: string, keepAnswer = false): Promise<Reading> {
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    const highest = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    const params = [scope.businessId, scope.from, scope.to].slice(0, highest);
    const open = async (): Promise<void> => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
    };

    let rowCount = 0;
    const samples: number[] = [];
    for (let i = 0; i < WARMUP + ITERATIONS; i += 1) {
      await open();
      const started = process.hrtime.bigint();
      const answer = await client.query(sql, params);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      await client.query('ROLLBACK');
      rowCount = answer.rowCount ?? 0;
      if (i === 0 && keepAnswer) answers[stage] = JSON.stringify(answer.rows);
      if (i >= WARMUP) samples.push(elapsed);
    }

    await open();
    const explained = await client.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    await client.query('ROLLBACK');
    const plan = ((explained.rows[0]?.['QUERY PLAN'] as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
    const root = (plan['Plan'] ?? {}) as Record<string, unknown>;
    const out = { nodes: [] as string[], scans: {} as Record<string, { est: number; act: number; loops: number }> };
    walk(root, out);
    const lines = out.scans['journal_lines'] ?? { est: 0, act: 0, loops: 0 };

    const sorted = [...samples].sort((a, b) => a - b);
    const reading: Reading = {
      variant,
      stage,
      min: must(sorted[0]),
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: must(sorted[sorted.length - 1]),
      rowCount,
      sharedBlocks: Number(root['Shared Hit Blocks'] ?? 0) + Number(root['Shared Read Blocks'] ?? 0),
      linesEstimated: lines.est,
      linesActual: lines.act,
      linesLoops: lines.loops,
      workersLaunched: Number(root['Workers Launched'] ?? 0),
      nodeTypes: out.nodes,
    };
    readings.push(reading);
    return reading;
  } finally {
    await client.end();
  }
}

function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-candidate-'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (file <= `${upTo}_zzz`) cpSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  return dir;
}

async function asOwner(statements: readonly string[]): Promise<void> {
  const pool = new Pool({ connectionString: ownerUrl(DB), max: 1 });
  try {
    for (const statement of statements) await pool.query(statement);
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  await startOrReuse();
  await ensureDatabase('daftar');
  const admin = new Pool({ connectionString: ownerUrl('postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
  await applyBootstrap(DB);
  const upTo = migrationsUpTo('0052');
  try {
    await runMigrations(ownerUrl(DB), upTo);
  } finally {
    rmSync(upTo, { recursive: true, force: true });
  }

  const pool = new Pool({ connectionString: ownerUrl(DB), max: 4 });
  try {
    const one = async (sql: string, params: unknown[] = []): Promise<string> => must((await pool.query<{ id: string }>(sql, params)).rows[0]).id;
    const tenantId = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const businessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, 'Candidate Books', 'candidate', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
      [tenantId],
    );
    const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Candidate') RETURNING id`, [
      'candidate@test.daftar.local',
    ]);
    await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]);
    const generated = await generateDataset(pool, [{ tenantId, businessId, userId, baseCurrency: 'ILS' }], TIER2_REPORTING_SPEC);
    seededLines = generated.lineCount;
    seededEntries = generated.entryCount;
    scope = { tenantId, businessId, from: '2000-01-01', to: TIER2_REPORTING_SPEC.endDate };
    await pool.query(`ANALYZE`);
  } finally {
    await pool.end();
  }

  await read('production', PRODUCTION_SQL, 'S0 as shipped (0052)', true);
  await read('raw line aggregate', RAW_LINE_AGGREGATE_SQL, 'S0 as shipped (0052)');

  await asOwner([TENANT_POLICY_UUID]);
  await read('production', PRODUCTION_SQL, 'S1 uuid comparison only', true);
  await read('raw line aggregate', RAW_LINE_AGGREGATE_SQL, 'S1 uuid comparison only');

  await asOwner(INLINABLE_HELPERS);
  await read('production', PRODUCTION_SQL, 'S2 uuid + inlinable helpers', true);
  await read('raw line aggregate', RAW_LINE_AGGREGATE_SQL, 'S2 uuid + inlinable helpers');

  await asOwner([BUSINESS_POLICY_UUID]);
  await read('production', PRODUCTION_SQL, 'S3 + business policy (DIAGNOSTIC)', true);
  await read('raw line aggregate', RAW_LINE_AGGREGATE_SQL, 'S3 + business policy (DIAGNOSTIC)');

  // S4 and S5 are DIAGNOSTIC and outside what the directive authorises for
  // `0052`. They are measured because the report still misses its budget with
  // `journal_lines` fully corrected, and the readings above say where the rest
  // of the time is: the trial balance joins `journal_entries` and `accounts`,
  // whose own policies still carry both defects — the correlated `businesses`
  // lookup and the column cast that throws the statistics away. Both tables
  // store `tenant_id` under the same composite foreign key that makes the
  // `journal_lines` proof sound, so the same rewrite is available to them;
  // whether it is AUTHORISED is a separate question, and these numbers exist
  // so that it can be decided on evidence rather than on argument.
  await asOwner([
    `ALTER POLICY tenant_membership ON journal_entries
       USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
       WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`,
    `ALTER POLICY business_isolation ON journal_entries
       USING      (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid)
       WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid)`,
  ]);
  await read('production', PRODUCTION_SQL, 'S4 + journal_entries (DIAGNOSTIC)', true);
  await read('raw line aggregate', RAW_LINE_AGGREGATE_SQL, 'S4 + journal_entries (DIAGNOSTIC)');

  await asOwner([
    `ALTER POLICY tenant_membership ON accounts
       USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
       WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`,
    `ALTER POLICY business_isolation ON accounts
       USING      (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid)
       WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid)`,
  ]);
  await read('production', PRODUCTION_SQL, 'S5 + accounts (DIAGNOSTIC)', true);
  await read('raw line aggregate', RAW_LINE_AGGREGATE_SQL, 'S5 + accounts (DIAGNOSTIC)');
}, 21_600_000);

afterAll(async () => {
  if (!ENABLED) return;
  const evidence = {
    slice: 'P2-S8',
    what: 'the candidate correction for budget C, staged and measured at the acceptance scale',
    producedAt: new Date().toISOString(),
    gitSha: (() => {
      try {
        return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
      } catch {
        return 'unknown';
      }
    })(),
    dataset: { ...TIER2_REPORTING_SPEC, entryCount: seededEntries, lineCount: seededLines },
    warmup: WARMUP,
    iterations: ITERATIONS,
    statements: { tenantPolicy: TENANT_POLICY_UUID, helpers: INLINABLE_HELPERS, businessPolicyDiagnostic: BUSINESS_POLICY_UUID },
    answersIdentical: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v === answers['S0 as shipped (0052)']])),
    readings,
  };
  const dir = join(__dirname, '../../release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'phase2-s8-correction-candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const admin = new Pool({ connectionString: ownerUrl('postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  } catch {
    // the name carries the pid; the next run drops it before creating its own
  } finally {
    await admin.end().catch(() => undefined);
  }
});

describe.skipIf(!ENABLED)('the candidate correction', () => {
  it('is measured at the acceptance size', () => {
    expect(seededLines).toBeGreaterThanOrEqual(100_000);
  });

  it('never changes the answer at any stage', () => {
    for (const [stage, identical] of Object.entries(answers).map(([k, v]) => [k, v === answers['S0 as shipped (0052)']] as const)) {
      expect(identical, `${stage} changed the trial balance`).toBe(true);
    }
  });

  it('records what every stage cost', () => {
    for (const r of readings) {
      console.log(
        `${r.stage.padEnd(36)} ${r.variant.padEnd(20)} p50 ${r.p50.toFixed(1).padStart(9)}  p95 ${r.p95.toFixed(1).padStart(9)}  ` +
          `blocks ${String(r.sharedBlocks).padStart(9)}  lines est ${String(r.linesEstimated).padStart(7)} act ${String(r.linesActual).padStart(7)} loops ${r.linesLoops}  workers ${r.workersLaunched}`,
      );
    }
    expect(readings).toHaveLength(12);
  });
});
