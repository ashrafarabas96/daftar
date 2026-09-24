/**
 * BEFORE / AFTER: THE ANSWER AND THE PLAN (P2-S8 RLS directive §10, §11).
 *
 * `0052` changes the shape of a row-level security policy for speed. The
 * claim that needs proving is not that the new policy is fast — the budgets
 * measure that — it is that IT IS THE SAME POLICY, expressed differently.
 * Two things must hold, and neither can be established by reading SQL:
 *
 *   §10 THE ANSWER IS IDENTICAL. On one database, with one deterministic
 *       dataset, the whole-business trial balance is read as `daftar_app`
 *       under the same tenant and business context, with the same query and
 *       the same rows — once at `0051`, once after `0052` has been applied to
 *       that very database. The two results are compared byte for byte. No
 *       missing account, no extra account, no changed debit, credit or
 *       balance. The optimisation must change WORK, never the ANSWER.
 *
 *   §11 THE CORRELATED SUBPLAN IS GONE. `EXPLAIN (ANALYZE, BUFFERS)` on the
 *       same read, before and after, recorded in full: execution time, actual
 *       and estimated rows, shared blocks hit and read, the node shape and
 *       the subplans. The assertion is deliberately NOT "the planner must
 *       choose algorithm X forever" — planners change their minds for good
 *       reasons. It is the narrow, durable one: the per-row `businesses`
 *       lookup the old policy forced is no longer in the plan.
 *
 * WHY IT BUILDS ITS OWN DATABASE. The question is about two schema states of
 * the SAME data, and the shared test database only ever exists in the latest
 * state. So this suite creates a scratch database inside the same embedded
 * PostgreSQL every other suite uses — the idiom `migration-upgrade.test.ts`
 * already established — applies the accepted history up to `0051`, seeds,
 * measures, applies `0052` to that database, and measures again. Nothing is
 * simulated and nothing is reset in between: the rows the second read sees
 * are exactly the rows the first read saw.
 *
 * It also writes `release/phase2-s8-rls-equivalence.json`, which is the
 * machine-readable half of the evidence the acceptance page quotes.
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
import { generateDataset, TIER1_SPEC } from './accounting-dataset';

/** A scratch database of this suite's own. Created here, dropped here. */
const DB = `daftar_rls_equivalence_${process.pid}`;
const ownerUrl = (db: string): string => `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`;
const appUrl = `postgresql://daftar_app:${APP_DB_PASSWORD}@localhost:${PG_PORT}/${DB}`;

/**
 * THE PRODUCTION QUERY, not a copy of it.
 *
 * `accountTotalsSql` is the very function the trial-balance reader calls, so
 * a future change to the report changes what this evidence measures instead
 * of leaving it quietly measuring a query nobody serves. The conditions are
 * the ones `trialBalanceTotals` builds for a whole business over a closed
 * date range.
 */
const TRIAL_BALANCE_SQL = accountTotalsSql(['l.business_id = $1', 'e.entry_date >= $2::date', 'e.entry_date <= $3::date'], ['a.business_id = $1']);

/** Copy the migrations at or before `upTo` into a directory of their own. */
function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-rls-equivalence-'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (file <= `${upTo}_zzz`) cpSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  return dir;
}

interface Capture {
  rows: unknown[];
  rowCount: number;
  plan: unknown;
  executionMs: number;
  planningMs: number;
  sharedHit: number;
  sharedRead: number;
  actualRows: number;
  estimatedRows: number;
  nodeTypes: string[];
  subplanNames: string[];
  relations: string[];
  /**
   * Which relations each scanned relation reaches THROUGH A SUBPLAN — that is,
   * once per row of it. `{ journal_lines: ['businesses'] }` is the defect; the
   * same entry under `journal_entries` is the policy §5 forbids touching, so
   * it is expected to survive unchanged on both sides of the measurement.
   */
  subplanRelations: Record<string, string[]>;
}

/**
 * Walk the plan tree, gathering everything §11 asks to be recorded.
 *
 * `owner` is the relation of the nearest enclosing scan, and `inSubplan` says
 * whether this node sits under a `"Parent Relationship": "SubPlan"` edge. The
 * two together are what turn a flat list of relation names — which cannot tell
 * a per-row lookup apart from a join — into the attribution §11 actually
 * asks for: this relation is read once per row of that one.
 */
function walk(
  node: Record<string, unknown>,
  out: { nodes: string[]; subplans: string[]; relations: string[]; subplanRelations: Record<string, string[]> },
  owner?: string,
  inSubplan = false,
): void {
  const type = node['Node Type'];
  if (typeof type === 'string') out.nodes.push(type);
  const subplan = node['Subplan Name'];
  if (typeof subplan === 'string') out.subplans.push(subplan);
  const relation = node['Relation Name'];
  if (typeof relation === 'string') out.relations.push(relation);

  const nowInSubplan = inSubplan || node['Parent Relationship'] === 'SubPlan';
  if (nowInSubplan && typeof relation === 'string' && owner !== undefined) {
    (out.subplanRelations[owner] ??= []).push(relation);
  }
  const nextOwner = nowInSubplan ? owner : typeof relation === 'string' ? relation : owner;

  const children = node['Plans'];
  if (Array.isArray(children)) for (const child of children) walk(child as Record<string, unknown>, out, nextOwner, nowInSubplan);
}

async function capture(scope: { tenantId: string; businessId: string; from: string; to: string }): Promise<Capture> {
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
    const params = [scope.businessId, scope.from, scope.to];
    const answer = await client.query(TRIAL_BALANCE_SQL, params);
    const explained = await client.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${TRIAL_BALANCE_SQL}`, params);
    await client.query('ROLLBACK');

    const plan = ((explained.rows[0]?.['QUERY PLAN'] as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
    const root = (plan['Plan'] ?? {}) as Record<string, unknown>;
    const out = { nodes: [] as string[], subplans: [] as string[], relations: [] as string[], subplanRelations: {} as Record<string, string[]> };
    walk(root, out);
    return {
      rows: answer.rows,
      rowCount: answer.rowCount ?? 0,
      plan,
      executionMs: Number(plan['Execution Time'] ?? 0),
      planningMs: Number(plan['Planning Time'] ?? 0),
      sharedHit: Number(root['Shared Hit Blocks'] ?? 0),
      sharedRead: Number(root['Shared Read Blocks'] ?? 0),
      actualRows: Number(root['Actual Rows'] ?? 0),
      estimatedRows: Number(root['Plan Rows'] ?? 0),
      nodeTypes: out.nodes,
      subplanNames: out.subplans,
      relations: out.relations,
      subplanRelations: out.subplanRelations,
    };
  } finally {
    await client.end();
  }
}

let before: Capture;
let after: Capture;
let boundaryBefore = '';
let boundaryAfter = '';
let seededLines = 0;
let seededEntries = 0;

beforeAll(async () => {
  await startOrReuse();
  // `bootstrap.sql` grants CONNECT on the database named `daftar`, so that
  // database has to exist before the file can be run anywhere.
  await ensureDatabase('daftar');
  const admin = new Pool({ connectionString: ownerUrl('postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
  // The deployment's own bootstrap, against the scratch database: the same
  // grants a real deployment gets — including the REVOKE of TEMPORARY that
  // the elevated routines insist on — from the same file, never a list
  // maintained by hand beside it.
  await applyBootstrap(DB);

  const upTo0051 = migrationsUpTo('0051');
  try {
    await runMigrations(ownerUrl(DB), upTo0051);
  } finally {
    rmSync(upTo0051, { recursive: true, force: true });
  }

  const pool = new Pool({ connectionString: ownerUrl(DB), max: 4 });
  let scope: { tenantId: string; businessId: string; from: string; to: string };
  try {
    boundaryBefore = must((await pool.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`)).rows[0]).name;

    const one = async (sql: string, params: unknown[] = []): Promise<string> => must((await pool.query<{ id: string }>(sql, params)).rows[0]).id;
    const tenantId = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    // Inserting the business is what seeds its chart of accounts: 0040 puts a
    // trigger on the table, so the chart measured here is the product's own.
    const businessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, 'Equivalence Books', 'rls-equivalence', 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
      [tenantId],
    );
    const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Equivalence') RETURNING id`, [
      'equivalence@test.daftar.local',
    ]);
    await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]);

    const generated = await generateDataset(pool, [{ tenantId, businessId, userId, baseCurrency: 'ILS' }], TIER1_SPEC);
    seededLines = generated.lineCount;
    seededEntries = generated.entryCount;
    scope = { tenantId, businessId, from: '2000-01-01', to: TIER1_SPEC.endDate };
  } finally {
    await pool.end();
  }

  before = await capture(scope);

  // The one change under test, applied to the SAME database with the SAME
  // rows already in it. Nothing is reset, reseeded or re-ANALYZEd.
  await runMigrations(ownerUrl(DB));
  const check = new Pool({ connectionString: ownerUrl(DB), max: 1 });
  try {
    boundaryAfter = must((await check.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`)).rows[0]).name;
  } finally {
    await check.end();
  }

  after = await capture(scope);
}, 3_600_000);

afterAll(async () => {
  const evidence = {
    slice: 'P2-S8',
    what: 'journal_lines tenant_membership: answer equivalence (§10) and before/after plan evidence (§11)',
    producedAt: new Date().toISOString(),
    gitSha: (() => {
      try {
        return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
      } catch {
        return 'unknown';
      }
    })(),
    boundaryBefore,
    boundaryAfter,
    dataset: { ...TIER1_SPEC, entryCount: seededEntries, lineCount: seededLines },
    query: TRIAL_BALANCE_SQL,
    answerIdentical: JSON.stringify(before?.rows) === JSON.stringify(after?.rows),
    rowCount: before?.rowCount ?? 0,
    before: before === undefined ? null : { ...before, rows: undefined },
    after: after === undefined ? null : { ...after, rows: undefined },
  };
  const dir = join(__dirname, '../../release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'phase2-s8-rls-equivalence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  const admin = new Pool({ connectionString: ownerUrl('postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  } catch {
    // a connection may still be draining; the name carries the pid, so the
    // next run of this suite drops it before it creates its own
  } finally {
    await admin.end().catch(() => undefined);
  }
});

describe('the two schema states this evidence compares', () => {
  it('measured BEFORE at 0051 and AFTER at 0052, on one database', () => {
    expect(boundaryBefore.startsWith('0051'), `before: ${boundaryBefore}`).toBe(true);
    expect(boundaryAfter.startsWith('0052'), `after: ${boundaryAfter}`).toBe(true);
  });

  it('over the deterministic performance dataset, not a handful of rows', () => {
    expect(seededLines).toBeGreaterThan(10_000);
    expect(before.rowCount).toBeGreaterThan(0);
  });
});

describe('§10 — the optimisation changes work, not the answer', () => {
  it('the trial balance is byte-for-byte identical before and after 0052', () => {
    expect(JSON.stringify(after.rows)).toBe(JSON.stringify(before.rows));
  });

  it('with the same number of accounts, none added and none lost', () => {
    expect(after.rowCount).toBe(before.rowCount);
  });
});

describe('§11 — the correlated businesses lookup is gone', () => {
  /**
   * Attribution, not a relation count. `businesses` appearing in a plan is
   * not the defect; a relation being read ONCE PER ROW of another is. So the
   * question is asked of the scan the subplan hangs under, which is why
   * `walk()` carries an owner through the tree instead of flattening it.
   */
  it.each(['journal_lines', 'journal_entries', 'accounts'])('at 0051 %s looks up businesses per row; at 0052 it does not', (table) => {
    expect(before.subplanRelations[table] ?? [], `before: ${JSON.stringify(before.subplanRelations)}`).toContain('businesses');
    expect(after.subplanRelations[table] ?? [], `after: ${JSON.stringify(after.subplanRelations)}`).not.toContain('businesses');
  });

  /**
   * And the correction stops where the measurement stopped. The trial balance
   * reads three relations; every other table in the schema still carries the
   * shape 0042 and 0049 wrote, which `journal-lines-rls-policy.test.ts`
   * asserts against the live catalogue rather than against a plan.
   */
  it('and no relation outside those three is read per row on either side', () => {
    for (const state of [before, after]) {
      for (const owner of Object.keys(state.subplanRelations)) {
        expect(['journal_lines', 'journal_entries', 'accounts'], `unexpected per-row lookup under ${owner}`).toContain(owner);
      }
    }
  });

  it('and the work actually fell', () => {
    const beforeBlocks = before.sharedHit + before.sharedRead;
    const afterBlocks = after.sharedHit + after.sharedRead;
    expect(afterBlocks, `${beforeBlocks} → ${afterBlocks} shared blocks`).toBeLessThan(beforeBlocks);
    expect(after.executionMs, `${before.executionMs} ms → ${after.executionMs} ms`).toBeLessThan(before.executionMs);
  });
});
