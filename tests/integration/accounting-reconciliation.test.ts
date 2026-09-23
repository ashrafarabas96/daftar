/**
 * RECONCILIATION, AGAINST REAL BOOKS (P2-S8 §20-§22, §24, §25, §26).
 *
 * The easy version of this file would seed a clean business, run the pass,
 * see every check say OK and call it proof. It would prove almost nothing —
 * §23's planted-discrepancy suite is where detection is proved. What THIS
 * file proves is the part that has to hold on every run in production:
 *
 *   the pass reaches a verdict on every check and never invents one;
 *   the result it publishes carries no money, by construction;
 *   nothing it does changes a financial row;
 *   a check the running credential cannot evaluate says so out loud;
 *   the daily schedule runs once a day and survives a crash.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_CORRECTION_NOTICE, RECONCILIATION_CHECKS, RECONCILIATION_CHECK_IDS, assertSafeCheckResult, type ReconciliationRunResult } from '@daftar/accounting';
import { createTestApp, ensurePostgres, ownerPool, reconcilerDbUrl, resetData, workerDbUrl, type TestApp } from '../helpers/test-app';
import { PoolReconciliationConnection } from '../helpers/accounting-reconciliation';
import { DatabaseAccountingReconciliationReader } from '../../apps/api/src/modules/accounting/accounting-reconciliation.reader';
import { reconcile } from '@daftar/accounting';
import { must, post, seedPostingFixture, simpleCommand, todayIn, type PostingFixture } from '../helpers/accounting-posting';
import { AccountingReconciliationService } from '../../apps/api/src/modules/accounting/accounting-reconciliation.service';
import { AccountingReconciliationWorker, RECONCILIATION_PERIOD_MS } from '../../apps/api/src/modules/accounting/accounting-reconciliation.worker';
import { InMemoryMetrics, ACCOUNTING_METRICS } from '../../apps/api/src/infra/metrics';
import { Client, Pool } from 'pg';

let t: TestApp;
let fx: PostingFixture;
let service: AccountingReconciliationService;
let metrics: InMemoryMetrics;
/** The production pass: the reconciler process's own credential, through 0051. */
let run: ReconciliationRunResult;

/** A clock the test drives, so "daily" is measured in milliseconds here. */
class FakeClock {
  constructor(private millis = Date.parse('2026-09-23T00:00:00Z')) {}
  now(): Date {
    return new Date(this.millis);
  }
  advance(by: number): void {
    this.millis += by;
  }
}
const clock = new FakeClock();

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  metrics = new InMemoryMetrics();
  t = await createTestApp({ metrics, reconciliationClock: clock });
  service = t.app.get(AccountingReconciliationService);

  fx = await seedPostingFixture(ownerPool(), `recon-${Date.now()}`);
  const today = await todayIn(ownerPool(), 'Asia/Hebron');
  // Real postings through the real command — not bulk SQL. The pass must be
  // checking the books the product actually writes.
  for (let i = 0; i < 3; i += 1) {
    const outcome = await post(simpleCommand(fx, randomUUID(), today, BigInt(10_000 + i)), fx.userId);
    expect(outcome.created).toBe(true);
  }

  // The pass exactly as the reconciler process runs it: composed from the
  // ReconcilerModule providers, reaching the database through the
  // `daftar_reconciler` pool. Nothing below simulates the authority.
  run = await service.runOnce();
}, 300_000);

afterAll(async () => {
  await t?.close();
});

describe('THE WORKER IS UNCHANGED (§15) — a permanent regression', () => {
  /**
   * This slice began with a finding: `daftar_worker` could not list the
   * businesses it would reconcile, because since `0032` row level security
   * exempts exactly one principal, `daftar_platform`. The cheap answer would
   * have been to widen the worker. It was refused, because the worker already
   * carries the credential decryption key ring, the SMTP credential and the
   * outbox relay: delivery authority is not financial authority.
   *
   * So the worker must still be unable to do this, and that is asserted here
   * rather than assumed — with the SAME reader the production pass uses, so a
   * future change that quietly widened the worker would be caught by the code
   * that would have benefited from it.
   */
  it('still cannot enumerate the businesses to reconcile, and says so rather than reporting a clean system', async () => {
    const pool = new Pool({ connectionString: workerDbUrl, max: 1 });
    try {
      const reader = new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool));
      const denied = await reconcile(reader, clock);
      expect(denied.enumeration).toBe('unavailable');
      expect(denied.enumerationReason).toMatch(/daftar_worker/);
      expect(denied.businessCount).toBe(0);
      expect(denied.results).toEqual([]);
      expect(denied.enumerationReason).toMatch(/accounting_reconcile_businesses/);
    } finally {
      await pool.end();
    }
  });

  it('still holds no read on the chart of accounts or the period calendar', async () => {
    const c = new Client({ connectionString: workerDbUrl });
    await c.connect();
    try {
      const { rows } = await c.query<{ name: string; allowed: boolean }>(
        `SELECT t.name, has_any_column_privilege(current_user, t.name, 'SELECT') AS allowed
           FROM unnest($1::text[]) AS t(name)`,
        [['journal_entries', 'journal_lines', 'accounting_source_bindings', 'businesses', 'accounts', 'accounting_periods']],
      );
      const denied = rows
        .filter((r) => !r.allowed)
        .map((r) => r.name)
        .sort();
      expect(denied).toEqual(['accounting_periods', 'accounts']);
    } finally {
      await c.end();
    }
  });
});

describe('the nine checks, through the production reconciliation authority (§17)', () => {
  /**
   * §3 is explicit that nine checks RUNNING is not the result — they must run
   * through the authority production uses. So every assertion below reads
   * `run`, which came from the composed service over the `daftar_reconciler`
   * pool, and not from a convenient owner connection.
   */
  it('visits every business and reaches a verdict on every check', () => {
    expect(run.enumeration).toBe('complete');
    expect(run.checkCount).toBe(RECONCILIATION_CHECK_IDS.length);
    expect(run.businessCount).toBeGreaterThanOrEqual(2);
    expect(run.results.length).toBe(run.businessCount * RECONCILIATION_CHECK_IDS.length);
    expect(run.unavailableCount).toBe(0);
    expect(run.errorCount).toBe(0);
  });

  it('is the run the service counts as successful', () => {
    expect(service.lastSuccess()).toBe(run.completedAt);
    const outcome = must(metrics.snapshot().find((s) => s.name === ACCOUNTING_METRICS.reconciliationRunTotal));
    expect(outcome.labels['outcome']).toBe('complete');
  });

  it('finds no discrepancy and no error in books written by the real posting path', () => {
    const offenders = run.results.filter((r) => r.status !== 'ok');
    expect(offenders.map((r) => `${r.checkId}:${r.status}:${r.errorCode ?? ''}`)).toEqual([]);
  });

  it('reports OK for a business with no journal at all', () => {
    const empty = run.results.filter((r) => r.businessId === fx.otherBusinessId);
    expect(empty.length).toBe(RECONCILIATION_CHECK_IDS.length);
    expect(empty.every((r) => r.status === 'ok')).toBe(true);
  });

  /**
   * §24: the enumeration is a keyset walk, and a walk that was only ever
   * exercised on one page is a walk whose paging was never tested. The page
   * size the production reader uses is 200, so this asks the enumerator
   * directly for pages of one and proves the cursor advances, terminates and
   * yields exactly the same set in the same order.
   */
  it('enumerates across more than one page, in keyset order, without repeating or skipping', async () => {
    const pool = new Pool({ connectionString: reconcilerDbUrl, max: 1 });
    try {
      const walked: string[] = [];
      let afterTenant: string | null = null;
      let afterBusiness: string | null = null;
      let pages = 0;
      for (;;) {
        const params: (string | number | null)[] = [afterTenant, afterBusiness, 1];
        const page = await pool.query<{ tenant_id: string; business_id: string }>(
          `SELECT tenant_id, business_id FROM accounting_reconcile_businesses($1::uuid, $2::uuid, $3::int)`,
          params,
        );
        if (page.rows.length === 0) break;
        pages += 1;
        const only = must(page.rows[0]);
        walked.push(`${only.tenant_id}/${only.business_id}`);
        afterTenant = only.tenant_id;
        afterBusiness = only.business_id;
      }
      expect(pages).toBeGreaterThan(1);
      // No business was visited twice, and none was lost between pages: the
      // one-at-a-time walk yields the same businesses, in the same order, as
      // the single page that holds them all.
      expect(new Set(walked).size).toBe(walked.length);
      const whole = await pool.query<{ tenant_id: string; business_id: string }>(
        `SELECT tenant_id, business_id FROM accounting_reconcile_businesses(NULL, NULL, 1000)`,
      );
      expect(walked).toEqual(whole.rows.map((r) => `${r.tenant_id}/${r.business_id}`));
      expect(walked.length).toBe(run.businessCount);
    } finally {
      await pool.end();
    }
  });

  /** §10: the enumeration payload is two identifiers. Nothing else travels. */
  it('returns tenant_id and business_id and nothing else', async () => {
    const pool = new Pool({ connectionString: reconcilerDbUrl, max: 1 });
    try {
      const page = await pool.query(`SELECT * FROM accounting_reconcile_businesses(NULL, NULL, 5)`);
      expect(page.fields.map((f) => f.name)).toEqual(['tenant_id', 'business_id']);
    } finally {
      await pool.end();
    }
  });
});

describe('the result contract (§22)', () => {
  it('every published result satisfies the safe contract', () => {
    expect(run.results.length).toBeGreaterThan(0);
    for (const result of run.results) assertSafeCheckResult(result);
  });

  /**
   * The contract stated as a property of the RENDERED text rather than of the
   * object, because a log line is text. Sentinel values are planted in the
   * books above (10000, 10001, 10002 minor units) and must not appear.
   */
  it('carries no money, no rate and no balance anywhere in its rendered form', () => {
    const rendered = JSON.stringify(run);
    for (const key of ['debit', 'credit', 'amount', 'balance', 'rate', 'minor', 'currency', 'fx']) {
      expect(rendered.toLowerCase()).not.toContain(key);
    }
    for (const sentinel of ['10000', '10001', '10002']) {
      expect(rendered).not.toContain(sentinel);
    }
  });

  it('always says that nothing was corrected', () => {
    expect(run.correction).toBe(NO_CORRECTION_NOTICE);
    for (const result of run.results) expect(result.correction).toBe(NO_CORRECTION_NOTICE);
  });

  it('offers no correction command of any kind', () => {
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).sort();
    expect(surface).toEqual(['constructor', 'lastRun', 'lastSuccess', 'runOnce']);
    expect(JSON.stringify(run)).not.toMatch(/repair|correct(ed|ion)?\s*[:=]\s*true|fix/i);
  });

  it('describes every check it ran', () => {
    for (const id of RECONCILIATION_CHECK_IDS) {
      const definition = must(RECONCILIATION_CHECKS.find((d) => d.id === id));
      expect(definition.title.length).toBeGreaterThan(0);
      expect(definition.invariant.length).toBeGreaterThan(0);
      expect(definition.requires.length).toBeGreaterThan(0);
    }
  });
});

describe('read-only, proved at the credential (§20)', () => {
  /**
   * The pass cannot write financial truth however it is called, because the
   * role it runs as holds no DML on any financial table. This is the
   * assertion that would still hold if every line of the service were
   * rewritten tomorrow.
   */
  it('the reconciliation credential holds no INSERT, UPDATE or DELETE on the journal', async () => {
    const c = new Client({ connectionString: reconcilerDbUrl });
    await c.connect();
    try {
      for (const table of ['journal_entries', 'journal_lines', 'accounting_source_bindings', 'businesses']) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          const { rows } = await c.query<{ ok: boolean }>(`SELECT has_table_privilege(current_user, $1, $2) AS ok`, [table, privilege]);
          expect(must(rows[0]).ok, `${table} ${privilege}`).toBe(false);
        }
      }
    } finally {
      await c.end();
    }
  });

  it('leaves the journal byte-identical across a repeated pass (§20 idempotent, safe to repeat)', async () => {
    const digest = async (): Promise<string> => {
      const { rows } = await ownerPool().query<{ d: string }>(
        `SELECT md5(coalesce(string_agg(t.row, '|' ORDER BY t.row), '')) AS d
           FROM (SELECT e.id::text || e.entry_date::text || e.posting_fingerprint AS row FROM journal_entries e
                 UNION ALL
                 SELECT l.id::text || l.debit_minor::text || l.credit_minor::text || l.base_amount_minor::text FROM journal_lines l) t`,
      );
      return must(rows[0]).d;
    };
    const before = await digest();
    const second = await service.runOnce();
    const third = await service.runOnce();
    expect(await digest()).toBe(before);
    // Repeating it is not merely harmless, it is the SAME answer.
    expect(second.results.map((r) => `${r.businessId}/${r.checkId}/${r.status}`)).toEqual(third.results.map((r) => `${r.businessId}/${r.checkId}/${r.status}`));
  });
});

describe('observability (§26, §28)', () => {
  it('counts the run and its duration without counting money', () => {
    const names = metrics.snapshot().map((s) => s.name);
    expect(names).toContain(ACCOUNTING_METRICS.reconciliationRunTotal);
    expect(names).toContain(ACCOUNTING_METRICS.reconciliationDurationMs);
    for (const sample of metrics.snapshot()) {
      for (const value of Object.values(sample.labels)) {
        expect(value).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
      }
    }
  });
});

describe('the daily schedule (§25) — measured in milliseconds, never in days', () => {
  it('runs on the first tick, then not again until a day has passed', async () => {
    const worker = t.app.get(AccountingReconciliationWorker);
    expect(await worker.tickSafely()).toBe(true);
    expect(await worker.tickSafely()).toBe(false);

    clock.advance(RECONCILIATION_PERIOD_MS - 1);
    expect(await worker.tickSafely()).toBe(false);

    clock.advance(1);
    expect(await worker.tickSafely()).toBe(true);
    expect(await worker.tickSafely()).toBe(false);
  }, 120_000);

  /**
   * §24: a pass that dies halfway leaves nothing behind, so the next one
   * starts clean. There is no lease to expire and no cursor to resume,
   * because there is nothing to resume — which is what read-only buys.
   */
  it('a run that throws does not stop the schedule, and the next run is a full pass', async () => {
    const before = AccountingReconciliationWorker.failures;
    const worker = t.app.get(AccountingReconciliationWorker);
    const original = service.runOnce.bind(service);
    let calls = 0;
    (service as unknown as { runOnce: () => Promise<ReconciliationRunResult> }).runOnce = () => {
      calls += 1;
      return Promise.reject(new Error('worker died mid-reconciliation'));
    };
    clock.advance(RECONCILIATION_PERIOD_MS);
    expect(await worker.tickSafely()).toBe(false);
    expect(calls).toBe(1);
    expect(AccountingReconciliationWorker.failures).toBe(before + 1);

    (service as unknown as { runOnce: () => Promise<ReconciliationRunResult> }).runOnce = original;
    clock.advance(RECONCILIATION_PERIOD_MS);
    expect(await worker.tickSafely()).toBe(true);
    const after = await original();
    expect(after.results.length).toBe(run.results.length);
    expect(after.enumeration).toBe(run.enumeration);
  }, 120_000);
});
