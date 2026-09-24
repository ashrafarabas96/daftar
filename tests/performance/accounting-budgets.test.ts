/**
 * THE SIX AUTHORITATIVE BUDGETS (P2-S8 §33, §34, §35, §36).
 *
 * The budgets are the ones already accepted in the execution plan, copied here
 * unchanged. §34 is explicit that they may not be loosened to obtain a pass,
 * so they are written as constants with the section letter beside each one and
 * a comment saying where they came from: a future edit that raised one would
 * be visible in a diff rather than buried in an expectation.
 *
 * TWO TIERS (§35). Tier 1 runs on every push against a smaller dataset shaped
 * like the real thing, and its job is to catch a major regression before it
 * reaches a reviewer. Tier 2 is the acceptance run at the sizes §34 actually
 * names — 100,000 lines for the reporting budgets and 1,000,000 for
 * reconciliation — and is selected with P2S8_PERF_TIER=2. The dataset is NOT
 * reduced to make Tier 1 pass: Tier 1 asserts the same budgets on less data,
 * which is a weaker claim, and the evidence file says which tier produced it.
 *
 * MEASUREMENT DISCIPLINE (§33). Every case warms up, then takes many measured
 * iterations, and reports p50/p95/p99/max rather than one lucky timing. The
 * machine, the versions, the database settings that matter and the dataset
 * seed are all captured into the evidence file beside the numbers, because a
 * millisecond figure with no machine attached is not evidence of anything.
 */
import { execSync } from 'node:child_process';
import { cpus, totalmem, arch, platform, release } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { reconcile } from '@daftar/accounting';
import { appDbUrl, createTestApp, ensurePostgres, ownerPool, reconcilerDbUrl, resetData, type TestApp } from '../helpers/test-app';
import { PoolReconciliationConnection } from '../helpers/accounting-reconciliation';
import { DatabaseAccountingReconciliationReader } from '../../apps/api/src/modules/accounting/accounting-reconciliation.reader';
import { accountTotalsSql } from '../../apps/api/src/modules/accounting/accounting-reports.reader';
import { appClient, assertionFor, must, postAs, simpleCommand, todayIn } from '../helpers/accounting-posting';
import {
  generateDataset,
  measuredTableStatistics,
  TIER1_SPEC,
  TIER2_RECONCILIATION_SPEC,
  TIER2_REPORTING_SPEC,
  type DatasetSpec,
  type TableStatistics,
} from './accounting-dataset';
import { exactShaBinding } from '../../scripts/phase2-s8-binding';

/**
 * PHASE_2_ACCOUNTING_EXECUTION_PLAN §34, repeated verbatim. Milliseconds.
 * These are ceilings on p95 (and on the total, for F).
 */
const BUDGET = {
  /** A — post() of a 2–6 line entry inside an existing transaction. */
  A_POST_P95: 15,
  /** B — the manual-adjustment endpoint, end to end. */
  B_ADJUSTMENT_ENDPOINT_P95: 60,
  /** C — whole-business trial balance over 100,000 journal lines, one period. */
  C_TRIAL_BALANCE_P95: 500,
  /** D — general ledger, a 50-row keyset page, 100,000 lines. */
  D_LEDGER_PAGE_P95: 150,
  /** E — account balance as-of, a 100,000-line-class business. */
  E_BALANCE_AS_OF_P95: 100,
  /** F — a full reconciliation pass over 1,000,000 journal lines, one business. */
  F_RECONCILIATION_TOTAL: 5 * 60 * 1000,
} as const;

const TIER = process.env['P2S8_PERF_TIER'] === '2' ? 2 : 1;
const RUN_LOCATION = process.env['CI'] === 'true' ? 'CI' : 'LOCAL';
const ITERATIONS = TIER === 2 ? 60 : 30;
const WARMUP = 5;

interface Measurement {
  readonly name: string;
  readonly budgetMs: number;
  readonly iterations: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly min: number;
  /**
   * Every iteration, in the order it was taken (f §11, §12).
   *
   * Six summary statistics cannot tell a slow query from one stalled
   * iteration, and that distinction decides what to do about a missed
   * budget. Budget A missed once on a GitHub runner at p50 3.1 ms, min
   * 2.6 and max 208.2: the operation was its normal speed and one iteration
   * waited on something else. Without the series that had to be argued from
   * percentiles; with it, a reader can see where the stall sat.
   */
  readonly samplesMs: readonly number[];
}

const measurements: Measurement[] = [];

/** One well-formed domestic amount, shared by both lines of the B measurement. */
const MONEY = {
  baseAmountMinor: '5000',
  baseCurrency: 'ILS',
  txnAmountMinor: '5000',
  txnCurrency: 'ILS',
  fxRate: '1',
  fxRateSource: 'base',
  // Second precision, UTC, ending Z: the `instant` scalar refuses sub-second
  // rather than truncating it, so `.000Z` here would have measured a 400, not
  // the adjustment endpoint.
  fxRateAt: '2026-03-14T09:15:00Z',
} as const;

function summarise(name: string, budgetMs: number, samples: number[]): Measurement {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => must(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  const m: Measurement = {
    name,
    budgetMs,
    iterations: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: must(sorted[sorted.length - 1]),
    min: must(sorted[0]),
    samplesMs: samples.map((v) => Number(v.toFixed(3))),
  };
  measurements.push(m);
  return m;
}

/** Warm up, then measure. The warm-up samples are discarded, never averaged in. */
async function measure(name: string, budgetMs: number, once: () => Promise<void>, iterations = ITERATIONS): Promise<Measurement> {
  for (let i = 0; i < WARMUP; i += 1) await once();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    await once();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return summarise(name, budgetMs, samples);
}

/**
 * WHAT THE C BUDGET'S READ ACTUALLY DID (§10, §11; f §11, §12).
 *
 * A millisecond figure says a query was slow. It does not say WHY, and the
 * first thing anyone asks of a budget that misses on one machine and passes
 * on another is "was it a different plan or a slower disk" — a question no
 * timing can answer. So the trial balance, the one budget that has ever
 * missed, records `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` beside its
 * numbers: the plan tree, the shared blocks hit and read, and the JIT block
 * PostgreSQL adds when it compiled the query rather than interpreting it.
 *
 * It is captured through `accountTotalsSql`, which is the function the
 * trial-balance reader itself calls, so this stays a recording of the query
 * DAFTAR serves rather than of a copy that can drift away from it.
 */
let trialBalancePlan: Record<string, unknown> | null = null;
/** What the planner could see when these numbers were measured (§11). */
let planningStatistics: TableStatistics[] = [];

async function captureTrialBalancePlan(): Promise<void> {
  const sql = accountTotalsSql(['l.business_id = $1', 'e.entry_date >= $2::date', 'e.entry_date <= $3::date'], ['a.business_id = $1']);
  const client = new Client({ connectionString: appDbUrl });
  await client.connect();
  try {
    // The same principal and the same transaction-local scope the endpoint
    // runs under: an EXPLAIN taken as the owner would plan without row level
    // security and describe a query nobody serves.
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantId, businessId]);
    const explained = await client.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [businessId, '2000-01-01', spec.endDate]);
    await client.query('ROLLBACK');
    trialBalancePlan = ((explained.rows[0]?.['QUERY PLAN'] as Record<string, unknown>[] | undefined) ?? [])[0] ?? null;
    // Printed as well as recorded. The artefact is the evidence, but it is an
    // attachment on a workflow run, and the first person to look at a red
    // budget is looking at the log. A plan that is only in a file people have
    // to download is a plan nobody reads while the failure is fresh.
    if (trialBalancePlan !== null) {
      console.log(`\nC TRIAL BALANCE PLAN\n${JSON.stringify(trialBalancePlan, null, 1)}\n`);
    }
  } finally {
    await client.end();
  }
}

let t: TestApp;
let token = '';
let tenantId = '';
let businessId = '';
let userId = '';
let today = '';
let accountId = '';
let spec: DatasetSpec;
let seededLines = 0;
/** What C, D and E actually read (§13: 100,000 at tier 2). */
let reportingLines = 0;
/** What F actually walks in its own business (§13: 1,000,000 at tier 2). */
let reconciliationLines = 0;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();

  const email = `perf-${Date.now()}@test.daftar.local`;
  const reg = await t.request.post('/v1/auth/register').send({ email, password: 'Str0ng!Passw0rd', displayName: 'Perf', preferredLocale: 'ar' });
  token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  userId = me.body.userId as string;
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${Date.now()}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ businessName: 'Budget Books', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `budget-${Date.now()}` });
  expect(on.status).toBe(201);
  businessId = on.body.businessId as string;
  tenantId = must((await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId])).rows[0]).tenant_id;
  today = await todayIn(ownerPool(), 'Asia/Hebron');
  accountId = must((await ownerPool().query<{ id: string }>(`SELECT id FROM accounts WHERE business_id = $1 ORDER BY code LIMIT 1`, [businessId])).rows[0]).id;

  // §34 and the RLS directive §13 state the acceptance sizes exactly:
  // 100,000 journal lines for the reporting reads C, D and E, and 1,000,000
  // for the reconciliation pass F.
  //
  // So Tier 2 seeds BOTH, in two businesses: this one carries the 100,000-line
  // reporting shape that A, B, C, D and E are measured against, and a second
  // business carries the 1,000,000-line reconciliation shape. F is a pass over
  // every business, so it reads both — 1.1 million lines — which is at or above
  // what §13 asks and never below it. An earlier version measured C, D and E
  // against the million-line business on the reasoning that a stricter dataset
  // subsumes a weaker one; the evidence then could not state the sizes §13
  // names, and §15 is explicit that a run whose dataset is not the stated one
  // is a failure of evidence.
  //
  // Tier 1 seeds the small shape, unchanged, which is the weaker claim it has
  // always made.
  spec = TIER === 2 ? TIER2_REPORTING_SPEC : TIER1_SPEC;
  const result = await generateDataset(ownerPool(), [{ tenantId, businessId, userId, baseCurrency: 'ILS' }], spec);
  seededLines = result.lineCount;
  reportingLines = result.lineCount;

  if (TIER === 2) {
    const one = async (sql: string, params: unknown[] = []): Promise<string> => must((await ownerPool().query<{ id: string }>(sql, params)).rows[0]).id;
    const otherTenantId = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const otherBusinessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, 'Reconciliation Scale', $2, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
      [otherTenantId, `recon-scale-${Date.now()}`],
    );
    const otherUserId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Scale') RETURNING id`, [
      `perf-scale-${Date.now()}@test.daftar.local`,
    ]);
    await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [otherBusinessId]);
    const big = await generateDataset(
      ownerPool(),
      [{ tenantId: otherTenantId, businessId: otherBusinessId, userId: otherUserId, baseCurrency: 'ILS' }],
      TIER2_RECONCILIATION_SPEC,
    );
    reconciliationLines = big.lineCount;
    seededLines = result.lineCount + big.lineCount;
  }

  // A MEASUREMENT TAKEN ON TOP OF THE SEEDING MEASURES THE SEEDING (f §11).
  //
  // Tier 2 writes a million journal lines immediately before the first
  // iteration, and those pages are still dirty when it starts. Budget A —
  // an operation that takes about three milliseconds — missed its 15 ms
  // ceiling once on a GitHub runner at p50 3.1 ms, min 2.6 and max 208.2:
  // one iteration waited on a checkpoint flush while every other one was
  // its normal speed. The flush is forced here instead, deliberately and
  // before the clock starts, so a measured iteration waits on its own work
  // rather than on the harness's. `ownerPool()` connects as the cluster
  // superuser, which is what CHECKPOINT requires; if that ever stops being
  // true the suite fails here rather than publishing a number it cannot
  // account for.
  await ownerPool().query('CHECKPOINT');

  // Read AFTER every business is seeded, so the snapshot describes the
  // database the budgets are about to be measured on and not an earlier one.
  planningStatistics = await measuredTableStatistics(ownerPool());
}, 21_600_000);

afterAll(async () => {
  // Before the app closes, and outside any measured iteration.
  await captureTrialBalancePlan().catch((e: unknown) => {
    // A failure to EXPLAIN is a gap in the evidence, never a reason to lose
    // the measurements that were taken.
    trialBalancePlan = { error: e instanceof Error ? e.message : String(e) };
  });
  const { rows: version } = await ownerPool().query<{ v: string }>(`SELECT version() AS v`);
  const { rows: settings } = await ownerPool().query<{ name: string; setting: string; unit: string | null }>(
    `SELECT name, setting, unit FROM pg_settings
      WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','max_parallel_workers_per_gather','random_page_cost','jit')
      ORDER BY name`,
  );
  const sha = (() => {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();
  const npmVersion = (() => {
    try {
      return execSync('npm --version', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();
  const evidence = {
    slice: 'P2-S8',
    // f §11: the head commit, both candidate migration digests, the Node
    // version and — when a workflow produced this — the run that did. A
    // millisecond figure that cannot name the tree it was measured on is a
    // figure about nothing in particular.
    binding: exactShaBinding(),
    tier: TIER,
    // §35: a full-scale result run on a laptop is not a CI result, and the
    // file says which it was rather than leaving a reader to assume.
    executedIn: RUN_LOCATION,
    gitSha: sha,
    node: process.version,
    npm: npmVersion,
    postgres: version[0]?.v ?? 'unknown',
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    totalMemoryBytes: totalmem(),
    databaseSettings: settings,
    // `reportingLines` and `reconciliationLines` are separate on purpose: §13
    // names two sizes, and one total would let a reader assume the wrong one
    // produced a given number.
    dataset: { ...spec, seededLines, reportingLines, reconciliationLines },
    budgets: BUDGET,
    measurements,
    /** §11: the plan behind budget C, recorded rather than described. */
    plans: { C_TRIAL_BALANCE: trialBalancePlan },
    /**
     * §11: what the planner could see. A budget figure measured against a
     * table with no statistics is a figure about the missing statistics, so
     * the evidence names when each measured table was last analyzed instead
     * of leaving a reader to assume it was.
     */
    planningStatistics,
  };
  const dir = join(__dirname, '../../release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase2-s8-performance-tier${TIER}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  await t?.close();
});

describe('A — the posting command, inside an existing transaction (§34 A)', () => {
  it(`p95 ≤ ${BUDGET.A_POST_P95} ms`, async () => {
    const c = await appClient();
    try {
      const m = await measure('A post() in an open transaction', BUDGET.A_POST_P95, async () => {
        const command = simpleCommand({ tenantId, businessId, userId } as never, randomUUID(), today, 12_345n);
        await c.query('BEGIN');
        await postAs(assertionFor(command, userId), command, {}, c);
        // Measured through COMMIT on purpose: the deferred entry validators
        // run there, so timing only the call would leave out the part of the
        // cost that scales with the journal. This is a stricter reading of
        // the budget than §34 requires, never a looser one.
        await c.query('COMMIT');
      });
      expect(m.p95, JSON.stringify(m)).toBeLessThanOrEqual(BUDGET.A_POST_P95);
    } finally {
      await c.end();
    }
  }, 900_000);
});

describe('B — the manual-adjustment endpoint, end to end (§34 B)', () => {
  it(`p95 ≤ ${BUDGET.B_ADJUSTMENT_ENDPOINT_P95} ms`, async () => {
    const m = await measure('B manual adjustment endpoint', BUDGET.B_ADJUSTMENT_ENDPOINT_P95, async () => {
      const response = await t.request
        .post(`/v1/businesses/${businessId}/accounting/adjustments`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Business-Id', businessId)
        .set('Idempotency-Key', randomUUID())
        .send({
          entryDate: today,
          description: 'budget measurement',
          reason: 'budget measurement',
          lines: [
            { account: { kind: 'system', systemKey: 'cash' }, side: 'D', ...MONEY },
            { account: { kind: 'system', systemKey: 'opening_equity' }, side: 'C', ...MONEY },
          ],
        });
      expect([200, 201]).toContain(response.status);
    });
    expect(m.p95, JSON.stringify(m)).toBeLessThanOrEqual(BUDGET.B_ADJUSTMENT_ENDPOINT_P95);
  }, 900_000);
});

describe('C — whole-business trial balance (§34 C)', () => {
  it(`p95 ≤ ${BUDGET.C_TRIAL_BALANCE_P95} ms`, async () => {
    const m = await measure('C trial balance', BUDGET.C_TRIAL_BALANCE_P95, async () => {
      const response = await t.request
        .get(`/v1/businesses/${businessId}/accounting/trial-balance?from=2000-01-01&to=${spec.endDate}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Business-Id', businessId);
      expect(response.status).toBe(200);
    });
    expect(m.p95, JSON.stringify(m)).toBeLessThanOrEqual(BUDGET.C_TRIAL_BALANCE_P95);
  }, 900_000);
});

describe('D — a 50-row general-ledger page (§34 D)', () => {
  it(`p95 ≤ ${BUDGET.D_LEDGER_PAGE_P95} ms`, async () => {
    const m = await measure('D ledger 50-row page', BUDGET.D_LEDGER_PAGE_P95, async () => {
      const response = await t.request
        .get(`/v1/businesses/${businessId}/accounting/ledger?accountId=${accountId}&from=2000-01-01&to=${spec.endDate}&limit=50`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Business-Id', businessId);
      expect(response.status).toBe(200);
    });
    expect(m.p95, JSON.stringify(m)).toBeLessThanOrEqual(BUDGET.D_LEDGER_PAGE_P95);
  }, 900_000);
});

describe('E — account balance as of a date (§34 E)', () => {
  it(`p95 ≤ ${BUDGET.E_BALANCE_AS_OF_P95} ms`, async () => {
    const m = await measure('E account balance as-of', BUDGET.E_BALANCE_AS_OF_P95, async () => {
      const response = await t.request
        .get(`/v1/businesses/${businessId}/accounting/balances?asOf=${spec.endDate}&accountId=${accountId}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Business-Id', businessId);
      expect(response.status).toBe(200);
    });
    expect(m.p95, JSON.stringify(m)).toBeLessThanOrEqual(BUDGET.E_BALANCE_AS_OF_P95);
  }, 900_000);
});

describe('F — a full reconciliation pass (§34 F)', () => {
  it(`total ≤ ${BUDGET.F_RECONCILIATION_TOTAL / 1000} s`, async () => {
    const pool = new Pool({ connectionString: reconcilerDbUrl, max: 2 });
    try {
      const reader = new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool));
      const clock = { now: (): Date => new Date() };
      // One pass, measured once: the budget is a wall-clock ceiling on a
      // whole cycle, not a percentile over repetitions, and repeating a
      // five-minute pass thirty times would measure the page cache rather
      // than the pass.
      const started = process.hrtime.bigint();
      const result = await reconcile(reader, clock);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      summarise('F full reconciliation', BUDGET.F_RECONCILIATION_TOTAL, [elapsed]);

      expect(result.enumeration).toBe('complete');
      expect(result.errorCount).toBe(0);
      expect(result.unavailableCount).toBe(0);
      expect(elapsed, `${seededLines} lines in ${elapsed} ms`).toBeLessThanOrEqual(BUDGET.F_RECONCILIATION_TOTAL);
    } finally {
      await pool.end();
    }
  }, 1_800_000);
});

describe('the dataset is what it claims to be (§32)', () => {
  it('is financially valid: balanced, bound, and complete in its FX snapshot', async () => {
    const { rows } = await ownerPool().query<{ unbalanced: string; unbound: string; lines: string }>(
      `SELECT (SELECT count(*)::text FROM (
                 SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
                  WHERE e.business_id = $1
                  GROUP BY e.id
                 HAVING sum(CASE WHEN l.debit_minor > 0 THEN l.base_amount_minor ELSE 0 END)
                     <> sum(CASE WHEN l.credit_minor > 0 THEN l.base_amount_minor ELSE 0 END)) x) AS unbalanced,
              (SELECT count(*)::text FROM journal_entries e
                WHERE e.business_id = $1
                  AND NOT EXISTS (SELECT 1 FROM accounting_source_bindings b
                                   WHERE b.business_id = e.business_id AND b.journal_entry_id = e.id)) AS unbound,
              (SELECT count(*)::text FROM journal_lines l WHERE l.business_id = $1) AS lines`,
      [businessId],
    );
    const row = must(rows[0]);
    expect({ unbalanced: row.unbalanced, unbound: row.unbound }).toEqual({ unbalanced: '0', unbound: '0' });
    // `reportingLines`, not `seededLines`: the query above counts THIS
    // business, and at tier 2 `seededLines` also carries the second,
    // million-line business that F walks. Comparing the one against the other
    // compared a business against the whole database.
    expect(Number(row.lines)).toBeGreaterThanOrEqual(reportingLines);
  });

  it('reaches the size the tier claims', () => {
    // Tier 1 is deliberately smaller than §34's datasets and says so; Tier 2
    // is the acceptance size and must actually BE it — both of them. §15: a
    // "100k" run that created 21k lines is a failure of evidence, not a pass.
    if (TIER === 2) {
      expect(reportingLines, 'C, D and E are measured at 100,000 lines (§13)').toBeGreaterThanOrEqual(100_000);
      expect(reconciliationLines, 'F is measured at 1,000,000 lines (§13)').toBeGreaterThanOrEqual(1_000_000);
    } else {
      expect(seededLines).toBeGreaterThanOrEqual(10_000);
    }
  });

  it('was measured by a planner that had statistics for every table it reads', () => {
    // The reason this assertion exists, permanently: `accounts` is read by
    // the trial balance and written by nobody here, and one business's chart
    // is roughly twenty rows — under `autovacuum_analyze_threshold`, so
    // nothing analyzes it by itself. It went into the measurement with
    // `reltuples = -1`, the planner estimated one row where there were
    // twenty-one, and chose to re-execute the whole journal aggregate once
    // per account. That cost 327 ms locally and 2.9 s on a GitHub runner,
    // where the re-executed side is a parallel `Gather Merge`. The budget was
    // measuring the absence of statistics.
    //
    // `generateDataset` now analyzes every measured table. If a future edit
    // drops one from that list, this fails here rather than turning up as an
    // unexplained regression in a budget nobody can reproduce.
    expect(planningStatistics.map((s) => s.table)).toEqual(['accounts', 'branches', 'businesses', 'journal_entries', 'journal_lines']);
    for (const stat of planningStatistics) {
      expect(stat.analyzedAt, `${stat.table} was never analyzed: this measurement is not evidence`).not.toBeNull();
      expect(stat.reltuples, `${stat.table} has no row estimate`).toBeGreaterThanOrEqual(0);
    }
  });
});
