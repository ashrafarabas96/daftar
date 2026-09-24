/**
 * WHY THE TRIAL BALANCE MISSES BUDGET C AT THE ACCEPTANCE SCALE.
 *
 * This is the one deterministic diagnostic harness the P2-S8 root-cause
 * directive asks for (§6). It measures the EXACT SQL the production reader
 * generates — `accountTotalsSql`, imported, never re-typed — on one seeded
 * database of at least 100,000 journal lines, under every principal and every
 * component decomposition the directive names, with one protocol for all of
 * them: warm up, then time N iterations, then EXPLAIN once.
 *
 * It answers four questions the budget run cannot:
 *
 *   §8  WHO PAYS. The identical query as `daftar_app` (policies apply), as
 *       `daftar_platform` (`app_bypass()` short-circuits but the policy
 *       expression is still evaluated per row), and as a superuser (PostgreSQL
 *       does not apply row-level security at all). The superuser reading is
 *       DIAGNOSTIC ONLY — nothing in DAFTAR's runtime connects that way — and
 *       its only job is to put a number on the query without security.
 *
 *   §10 WHERE IT GOES. The aggregate alone, the entry filter alone, the join
 *       without aggregation, the join with it, and the whole production
 *       statement, so the deltas name the expensive step instead of a guess
 *       naming it.
 *
 *   §12 WHETHER THE SHAPE IS FORCED. Answer-equivalent rewrites of the same
 *       read, measured beside the production one.
 *
 *   §13 WHETHER A KNOB EXPLAINS IT. `enable_nestloop = off`, `jit = off` and
 *       `max_parallel_workers_per_gather = 0`, each as evidence about a cause
 *       and never as a proposed fix.
 *
 * It also runs one experiment the others cannot: DAFTAR's policy helpers
 * (`app_bypass`, `app_tenant`, `app_business`) were created without a
 * parallel-safety marker, and PostgreSQL's default for an unmarked function is
 * PARALLEL UNSAFE. A parallel-unsafe function in a row-level security
 * expression makes the WHOLE query plan parallel-unsafe, which no reading of
 * the policy's text would ever reveal. The harness therefore measures the
 * production statement again after declaring the three helpers PARALLEL SAFE
 * on its own scratch database, so the evidence says what that costs rather
 * than leaving it to argument.
 *
 * It is expensive, so it runs only when asked: `P2S8_DIAGNOSE=1`.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { accountTotalsSql } from '../../apps/api/src/modules/accounting/accounting-reports.reader';
import {
  APP_DB_PASSWORD,
  PG_PASSWORD,
  PG_PORT,
  PG_USER,
  PLATFORM_DB_PASSWORD,
  applyBootstrap,
  ensureDatabase,
  startOrReuse,
} from '../helpers/embedded-cluster';
import { must } from '../helpers/accounting-posting';
import { generateDataset, TIER2_REPORTING_SPEC } from './accounting-dataset';

const ENABLED = process.env['P2S8_DIAGNOSE'] === '1';
const DB = `daftar_tb_diagnosis_${process.pid}`;
const ownerUrl = (db: string): string => `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`;
const appUrl = `postgresql://daftar_app:${APP_DB_PASSWORD}@localhost:${PG_PORT}/${DB}`;
const platformUrl = `postgresql://daftar_platform:${PLATFORM_DB_PASSWORD}@localhost:${PG_PORT}/${DB}`;

const WARMUP = 3;
const ITERATIONS = 10;

/**
 * THE PRODUCTION STATEMENT, imported rather than copied (§6).
 *
 * These are the conditions `trialBalanceTotals` builds for a whole business
 * over a closed date range with no branch restriction, which is exactly what
 * budget C measures.
 */
const PRODUCTION_SQL = accountTotalsSql(['l.business_id = $1', 'e.entry_date >= $2::date', 'e.entry_date <= $3::date'], ['a.business_id = $1']);

/** §10 A — what summing 100,000 authoritative lines costs, and nothing else. */
const RAW_LINE_AGGREGATE_SQL = `SELECT l.account_id, sum(l.debit_minor) AS debit, sum(l.credit_minor) AS credit
                                  FROM journal_lines l
                                 WHERE l.business_id = $1
                                 GROUP BY l.account_id`;

/** §10 B — choosing the qualifying entries, with no line touched. */
const ENTRY_FILTER_SQL = `SELECT count(*) AS n FROM journal_entries e
                           WHERE e.business_id = $1 AND e.entry_date >= $2::date AND e.entry_date <= $3::date`;

/** §10 C — the join, carrying no aggregate. */
const JOIN_ONLY_SQL = `SELECT count(*) AS n
                         FROM journal_lines l
                         JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
                        WHERE l.business_id = $1 AND e.entry_date >= $2::date AND e.entry_date <= $3::date`;

/** §10 D — the financial core: the derived table the report left-joins to. */
const JOIN_AGGREGATE_SQL = `SELECT l.account_id, sum(l.debit_minor) AS debit, sum(l.credit_minor) AS credit
                              FROM journal_lines l
                              JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
                             WHERE l.business_id = $1 AND e.entry_date >= $2::date AND e.entry_date <= $3::date
                             GROUP BY l.account_id`;

/** §12 2 — preselect the qualifying entries, then join the lines to that set. */
const PRESELECT_SQL = `SELECT a.id, a.code, a.name, a.type, a.is_active,
                              coalesce(t.debit, 0)::text AS debit, coalesce(t.credit, 0)::text AS credit
                         FROM accounts a
                         LEFT JOIN (
                                WITH qualifying AS MATERIALIZED (
                                  SELECT e.id FROM journal_entries e
                                   WHERE e.business_id = $1 AND e.entry_date >= $2::date AND e.entry_date <= $3::date
                                )
                                SELECT l.account_id, sum(l.debit_minor) AS debit, sum(l.credit_minor) AS credit
                                  FROM journal_lines l
                                  JOIN qualifying q ON q.id = l.journal_entry_id
                                 WHERE l.business_id = $1
                                 GROUP BY l.account_id
                              ) t ON t.account_id = a.id
                        WHERE a.business_id = $1
                        ORDER BY a.code`;

/** §12 3 — the same restriction expressed as a semi-join. */
const EXISTS_SQL = `SELECT a.id, a.code, a.name, a.type, a.is_active,
                           coalesce(t.debit, 0)::text AS debit, coalesce(t.credit, 0)::text AS credit
                      FROM accounts a
                      LEFT JOIN (
                             SELECT l.account_id, sum(l.debit_minor) AS debit, sum(l.credit_minor) AS credit
                               FROM journal_lines l
                              WHERE l.business_id = $1
                                AND EXISTS (SELECT 1 FROM journal_entries e
                                             WHERE e.business_id = l.business_id AND e.id = l.journal_entry_id
                                               AND e.entry_date >= $2::date AND e.entry_date <= $3::date)
                              GROUP BY l.account_id
                           ) t ON t.account_id = a.id
                     WHERE a.business_id = $1
                     ORDER BY a.code`;

interface Reading {
  readonly variant: string;
  readonly principal: string;
  readonly boundary: string;
  readonly knobs: readonly string[];
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly rowCount: number;
  readonly planningMs: number;
  readonly executionMs: number;
  readonly sharedHit: number;
  readonly sharedRead: number;
  readonly tempRead: number;
  readonly tempWritten: number;
  readonly actualRows: number;
  readonly estimatedRows: number;
  readonly linesEstimated: number;
  readonly linesActual: number;
  readonly linesLoops: number;
  readonly nodeTypes: string[];
  readonly sortMethods: string[];
  readonly workersPlanned: number;
  readonly workersLaunched: number;
  readonly jitCount: number;
  readonly jitTotalMs: number;
  readonly subplanRelations: Record<string, string[]>;
  readonly settings: Record<string, unknown>;
}

const readings: Reading[] = [];

interface Walked {
  nodes: string[];
  sorts: string[];
  subplanRelations: Record<string, string[]>;
  scans: Record<string, { est: number; act: number; loops: number }>;
  tempRead: number;
  tempWritten: number;
  workersPlanned: number;
  workersLaunched: number;
}

function walk(node: Record<string, unknown>, out: Walked, owner?: string, inSubplan = false): void {
  const type = node['Node Type'];
  if (typeof type === 'string') out.nodes.push(type);
  const sort = node['Sort Method'];
  if (typeof sort === 'string') out.sorts.push(`${sort} ${String(node['Sort Space Used'] ?? '?')}kB ${String(node['Sort Space Type'] ?? '')}`.trim());
  out.tempRead += Number(node['Temp Read Blocks'] ?? 0);
  out.tempWritten += Number(node['Temp Written Blocks'] ?? 0);
  out.workersPlanned = Math.max(out.workersPlanned, Number(node['Workers Planned'] ?? 0));
  out.workersLaunched = Math.max(out.workersLaunched, Number(node['Workers Launched'] ?? 0));

  const relation = node['Relation Name'];
  const nowInSubplan = inSubplan || node['Parent Relationship'] === 'SubPlan';
  if (typeof relation === 'string') {
    if (nowInSubplan && owner !== undefined) (out.subplanRelations[owner] ??= []).push(relation);
    else out.scans[relation] = { est: Number(node['Plan Rows'] ?? 0), act: Number(node['Actual Rows'] ?? 0), loops: Number(node['Actual Loops'] ?? 0) };
  }
  const nextOwner = nowInSubplan ? owner : typeof relation === 'string' ? relation : owner;
  const children = node['Plans'];
  if (Array.isArray(children)) for (const child of children) walk(child as Record<string, unknown>, out, nextOwner, nowInSubplan);
}

function percentile(sorted: readonly number[], q: number): number {
  return must(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]);
}

/**
 * One reading. The timing and the EXPLAIN are separate deliberately:
 * `EXPLAIN (ANALYZE)` instruments every node and charges for it, and the
 * milliseconds a budget is judged against must come from the plain statement.
 */
async function read(
  variant: string,
  sql: string,
  url: string,
  principal: string,
  boundary: string,
  scope: { tenantId: string; businessId: string; from: string; to: string },
  knobs: readonly string[] = [],
  paramsOverride?: readonly unknown[],
): Promise<Reading> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Every variant binds the business as $1 and, when it restricts by date,
    // the window as $2 and $3. Passing a parameter a statement does not
    // mention is an error, so the count comes from the statement itself.
    const highest = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    const params = paramsOverride === undefined ? [scope.businessId, scope.from, scope.to].slice(0, highest) : [...paramsOverride];
    const open = async (): Promise<void> => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
      for (const knob of knobs) await client.query(knob);
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
      if (i >= WARMUP) samples.push(elapsed);
    }

    await open();
    const explained = await client.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${sql}`, params);
    await client.query('ROLLBACK');

    const plan = ((explained.rows[0]?.['QUERY PLAN'] as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
    const root = (plan['Plan'] ?? {}) as Record<string, unknown>;
    const out: Walked = {
      nodes: [],
      sorts: [],
      subplanRelations: {},
      scans: {},
      tempRead: 0,
      tempWritten: 0,
      workersPlanned: 0,
      workersLaunched: 0,
    };
    walk(root, out);
    const lines = out.scans['journal_lines'] ?? { est: 0, act: 0, loops: 0 };
    const jit = (plan['JIT'] ?? {}) as Record<string, unknown>;
    const jitTiming = (jit['Timing'] ?? {}) as Record<string, unknown>;

    const sorted = [...samples].sort((a, b) => a - b);
    const reading: Reading = {
      variant,
      principal,
      boundary,
      knobs,
      min: must(sorted[0]),
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: must(sorted[sorted.length - 1]),
      rowCount,
      planningMs: Number(plan['Planning Time'] ?? 0),
      executionMs: Number(plan['Execution Time'] ?? 0),
      sharedHit: Number(root['Shared Hit Blocks'] ?? 0),
      sharedRead: Number(root['Shared Read Blocks'] ?? 0),
      tempRead: out.tempRead,
      tempWritten: out.tempWritten,
      actualRows: Number(root['Actual Rows'] ?? 0),
      estimatedRows: Number(root['Plan Rows'] ?? 0),
      linesEstimated: lines.est,
      linesActual: lines.act,
      linesLoops: lines.loops,
      nodeTypes: out.nodes,
      sortMethods: out.sorts,
      workersPlanned: out.workersPlanned,
      workersLaunched: out.workersLaunched,
      jitCount: Number(jit['Functions'] ?? 0),
      jitTotalMs: Number(jitTiming['Total'] ?? 0),
      subplanRelations: out.subplanRelations,
      settings: (plan['Settings'] ?? {}) as Record<string, unknown>,
    };
    readings.push(reading);
    return reading;
  } finally {
    await client.end();
  }
}

function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-tb-diagnosis-'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (file <= `${upTo}_zzz`) cpSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  return dir;
}

let scope: { tenantId: string; businessId: string; from: string; to: string };
let seededLines = 0;
let seededEntries = 0;
/** The production answer, captured once per boundary, to compare rewrites against. */
const answers: Record<string, string> = {};

async function captureAnswer(key: string, sql: string, url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
    const { rows } = await client.query(sql, [scope.businessId, scope.from, scope.to]);
    await client.query('ROLLBACK');
    answers[key] = JSON.stringify(rows);
  } finally {
    await client.end();
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

  const upTo0051 = migrationsUpTo('0051');
  try {
    await runMigrations(ownerUrl(DB), upTo0051);
  } finally {
    rmSync(upTo0051, { recursive: true, force: true });
  }

  const pool = new Pool({ connectionString: ownerUrl(DB), max: 4 });
  try {
    const one = async (sql: string, params: unknown[] = []): Promise<string> => must((await pool.query<{ id: string }>(sql, params)).rows[0]).id;
    const tenantId = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const businessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, 'Diagnosis Books', 'tb-diagnosis', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
      [tenantId],
    );
    const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Diagnosis') RETURNING id`, [
      'tb-diagnosis@test.daftar.local',
    ]);
    await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]);

    const generated = await generateDataset(pool, [{ tenantId, businessId, userId, baseCurrency: 'ILS' }], TIER2_REPORTING_SPEC);
    seededLines = generated.lineCount;
    seededEntries = generated.entryCount;
    scope = { tenantId, businessId, from: '2000-01-01', to: TIER2_REPORTING_SPEC.endDate };
    // The planner is entitled to current statistics; a reading taken against
    // stale ones measures the seeding, not the query.
    await pool.query(`ANALYZE`);
  } finally {
    await pool.end();
  }

  // ── §8, at the accepted boundary 0051 ────────────────────────────────────
  await read('production', PRODUCTION_SQL, appUrl, 'daftar_app', '0051', scope);
  await read('production', PRODUCTION_SQL, platformUrl, 'daftar_platform', '0051', scope);
  await read('production', PRODUCTION_SQL, ownerUrl(DB), 'superuser', '0051', scope);

  // ── the one authorised schema change, applied to the same rows ───────────
  await runMigrations(ownerUrl(DB));
  const analyze = new Pool({ connectionString: ownerUrl(DB), max: 1 });
  try {
    await analyze.query(`ANALYZE`);
  } finally {
    await analyze.end();
  }

  await read('production', PRODUCTION_SQL, appUrl, 'daftar_app', '0052', scope);
  await read('production', PRODUCTION_SQL, platformUrl, 'daftar_platform', '0052', scope);
  await read('production', PRODUCTION_SQL, ownerUrl(DB), 'superuser', '0052', scope);

  // ── §13 — knobs, as evidence about a cause and never as a fix ────────────
  await read('production', PRODUCTION_SQL, appUrl, 'daftar_app', '0052', scope, ['SET LOCAL enable_nestloop = off']);
  await read('production', PRODUCTION_SQL, appUrl, 'daftar_app', '0052', scope, ['SET LOCAL jit = off']);
  await read('production', PRODUCTION_SQL, ownerUrl(DB), 'superuser', '0052', scope, ['SET LOCAL max_parallel_workers_per_gather = 0']);

  // ── §10 — where the time goes, component by component ────────────────────
  for (const [variant, sql] of [
    ['A raw line aggregate', RAW_LINE_AGGREGATE_SQL],
    ['B entry filter only', ENTRY_FILTER_SQL],
    ['C join, no aggregate', JOIN_ONLY_SQL],
    ['D join + aggregate', JOIN_AGGREGATE_SQL],
  ] as const) {
    await read(variant, sql, appUrl, 'daftar_app', '0052', scope);
    await read(variant, sql, ownerUrl(DB), 'superuser', '0052', scope);
  }

  // ── §12 — answer-equivalent rewrites of the same read ────────────────────
  await captureAnswer('production@0052', PRODUCTION_SQL, appUrl);
  for (const [variant, sql] of [
    ['§12.2 preselect entries', PRESELECT_SQL],
    ['§12.3 semi-join', EXISTS_SQL],
  ] as const) {
    await captureAnswer(`${variant}@0052`, sql, appUrl);
    await read(variant, sql, appUrl, 'daftar_app', '0052', scope);
  }

  // ── THE PREDICATE ITSELF, PRICED PIECE BY PIECE ──────────────────────────
  // Every reading above says the same thing: the cost tracks the policy
  // expression, not the join, the blocks or the compiler. These price the
  // expression directly. They run as a SUPERUSER so row-level security is not
  // applied at all and the predicate under test is the ONLY difference
  // between one reading and the next — the same rows, the same scan, one
  // clause added at a time. The difference between M0 and each of the others,
  // divided by the row count, is that clause's cost per journal line.
  const MICRO_BASE = `SELECT count(*) AS n FROM journal_lines l WHERE l.business_id = $1`;
  for (const [variant, clause, params] of [
    ['M0 no predicate', '', [scope.businessId]],
    ['M1 cast vs bound text', ` AND l.tenant_id::text = $2`, [scope.businessId, scope.tenantId]],
    ['M2 cast vs current_setting', ` AND l.tenant_id::text = current_setting('app.tenant_id', true)`, [scope.businessId]],
    ['M3 cast vs app_tenant()', ` AND l.tenant_id::text = app_tenant()`, [scope.businessId]],
    ['M4 the policy, as written', ` AND (app_bypass() OR l.tenant_id::text = app_tenant())`, [scope.businessId]],
    ['M5 uuid vs app_tenant()::uuid', ` AND (app_bypass() OR l.tenant_id = app_tenant()::uuid)`, [scope.businessId]],
    ['M6 app_bypass() alone', ` AND app_bypass()`, [scope.businessId]],
    ['M7 app_tenant() alone', ` AND app_tenant() IS NOT NULL`, [scope.businessId]],
  ] as const) {
    await read(variant, `${MICRO_BASE}${clause}`, ownerUrl(DB), 'superuser', '0052', scope, [], params);
  }

  // ── THE PARALLEL-SAFETY EXPERIMENT ───────────────────────────────────────
  // `app_bypass`, `app_tenant` and `app_business` were created with no
  // parallel-safety marker, and PostgreSQL's default for one is PARALLEL
  // UNSAFE. A parallel-unsafe function inside a row-level security expression
  // makes the entire plan parallel-unsafe — which is why the superuser, who
  // evaluates no policy at all, is the only principal here whose plan is
  // allowed to use workers. Declaring them PARALLEL SAFE asserts a fact about
  // what they read (the session's own GUCs and role, both of which PostgreSQL
  // copies into every worker), not a change to what they return.
  const alter = new Pool({ connectionString: ownerUrl(DB), max: 1 });
  try {
    await alter.query(`ALTER FUNCTION app_bypass() PARALLEL SAFE`);
    await alter.query(`ALTER FUNCTION app_tenant() PARALLEL SAFE`);
    await alter.query(`ALTER FUNCTION app_business() PARALLEL SAFE`);
  } finally {
    await alter.end();
  }
  await read('production', PRODUCTION_SQL, appUrl, 'daftar_app', '0052+parallel-safe', scope);
  await read('production', PRODUCTION_SQL, platformUrl, 'daftar_platform', '0052+parallel-safe', scope);
  await read('A raw line aggregate', RAW_LINE_AGGREGATE_SQL, appUrl, 'daftar_app', '0052+parallel-safe', scope);
  await read('D join + aggregate', JOIN_AGGREGATE_SQL, appUrl, 'daftar_app', '0052+parallel-safe', scope);
  await captureAnswer('production@0052+parallel-safe', PRODUCTION_SQL, appUrl);

  // ── THE PROPOSED CORRECTION, MEASURED BEFORE IT IS PROPOSED ──────────────
  // `pg_proc` says why the calls are expensive, and it is not the body: all
  // three helpers carry `proconfig = {search_path=...}`, and PostgreSQL's SQL
  // function inliner refuses outright to inline ANY function with a SET
  // clause. So every policy evaluation is a real function call — four of them
  // per journal line once the restrictive business policy is counted — and
  // each one additionally saves and restores the GUC nest level that the SET
  // clause demands. `EXPLAIN (VERBOSE)` shows the filter still naming
  // `app_bypass()`, `app_tenant()` and `app_business()`, never their bodies.
  //
  // The correction is therefore to remove the need for the SET clause rather
  // than the protection it provides: schema-qualify everything the bodies
  // touch, so no name in them can be captured by a caller's `search_path`,
  // and then the SET clause is redundant and the function inlines. PARALLEL
  // SAFE comes with it, for the reason above.
  //
  // THIS IS A MEASUREMENT, NOT A MIGRATION. It happens on a scratch database
  // that this suite drops when it finishes. Nothing in the repository's
  // migration history is touched, and the directive's §5 boundary for `0052`
  // is not crossed: what the numbers below are for is to let the Tech Lead
  // decide whether to authorise the change at all.
  const correct = new Pool({ connectionString: ownerUrl(DB), max: 1 });
  try {
    await correct.query(`CREATE OR REPLACE FUNCTION app_tenant() RETURNS TEXT LANGUAGE sql STABLE PARALLEL SAFE AS $$
      SELECT pg_catalog.current_setting('app.tenant_id', true)
    $$`);
    await correct.query(`CREATE OR REPLACE FUNCTION app_business() RETURNS TEXT LANGUAGE sql STABLE PARALLEL SAFE AS $$
      SELECT pg_catalog.current_setting('app.business_id', true)
    $$`);
    await correct.query(`CREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE PARALLEL SAFE AS $$
      SELECT CURRENT_USER OPERATOR(pg_catalog.=) 'daftar_platform'
    $$`);
    // Proof that the SET clause is gone, since that is the property the
    // inliner actually checks.
    const { rows } = await correct.query<{ proname: string; proconfig: string[] | null; proparallel: string }>(
      `SELECT proname, proconfig, proparallel FROM pg_proc WHERE proname IN ('app_bypass','app_tenant','app_business') ORDER BY proname`,
    );
    for (const row of rows) {
      expect(row.proconfig, `${row.proname} still carries a SET clause`).toBeNull();
      expect(row.proparallel, `${row.proname} parallel safety`).toBe('s');
    }
  } finally {
    await correct.end();
  }
  await read('production', PRODUCTION_SQL, appUrl, 'daftar_app', '0052+inlinable', scope);
  await read('production', PRODUCTION_SQL, platformUrl, 'daftar_platform', '0052+inlinable', scope);
  await read('A raw line aggregate', RAW_LINE_AGGREGATE_SQL, appUrl, 'daftar_app', '0052+inlinable', scope);
  await read('D join + aggregate', JOIN_AGGREGATE_SQL, appUrl, 'daftar_app', '0052+inlinable', scope);
  await read('B entry filter only', ENTRY_FILTER_SQL, appUrl, 'daftar_app', '0052+inlinable', scope);
  await read('C join, no aggregate', JOIN_ONLY_SQL, appUrl, 'daftar_app', '0052+inlinable', scope);
  await captureAnswer('production@0052+inlinable', PRODUCTION_SQL, appUrl);

  // And the same correction WITHOUT `0052`'s policy reshape would be a
  // different claim, so it is not made here: this reading is `0052` plus the
  // helper correction, and the evidence says exactly that.
}, 21_600_000);

afterAll(async () => {
  if (!ENABLED) return;
  const evidence = {
    slice: 'P2-S8',
    what: 'trial balance root-cause diagnosis at the acceptance scale (directive §6–§13)',
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
    productionSql: PRODUCTION_SQL,
    answersIdentical: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v === answers['production@0052']])),
    readings,
  };
  const dir = join(__dirname, '../../release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'phase2-s8-trial-balance-diagnosis.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  const admin = new Pool({ connectionString: ownerUrl('postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  } catch {
    // the name carries the pid; the next run drops it before creating its own
  } finally {
    await admin.end().catch(() => undefined);
  }
});

describe.skipIf(!ENABLED)('the trial balance at the acceptance scale', () => {
  it('is measured on the dataset the directive names, not a smaller one', () => {
    expect(seededLines, `${seededLines} lines from ${seededEntries} entries`).toBeGreaterThanOrEqual(100_000);
  });

  it('answers identically however it is read and however it is written', () => {
    for (const [key, identical] of Object.entries(answers).map(([k, v]) => [k, v === answers['production@0052']] as const)) {
      expect(identical, `${key} differs from the production answer`).toBe(true);
    }
  });

  it('records what every reading cost', () => {
    for (const r of readings) {
      console.log(
        `${r.variant.padEnd(24)} ${r.principal.padEnd(16)} ${r.boundary.padEnd(20)} ${(r.knobs.join(';') || '—').padEnd(38)} ` +
          `p50 ${r.p50.toFixed(1).padStart(8)}  p95 ${r.p95.toFixed(1).padStart(8)}  blocks ${String(r.sharedHit + r.sharedRead).padStart(7)}  ` +
          `workers ${r.workersLaunched}/${r.workersPlanned}  jit ${r.jitTotalMs.toFixed(1)}ms  lines est ${String(r.linesEstimated).padStart(7)} act ${String(r.linesActual).padStart(7)} loops ${r.linesLoops}`,
      );
    }
    expect(readings.length).toBeGreaterThan(0);
  });
});
