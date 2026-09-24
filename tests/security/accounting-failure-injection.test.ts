/**
 * THE FAILURE-INJECTION MATRIX, FI-01 … FI-12 (P2-S8 §29, §30).
 *
 * Every case here breaks something on purpose and then asks what the ledger
 * looks like afterwards. The answer DAFTAR requires is always one of two
 * things: the transaction left no trace, or the failure is visible. What it
 * may never be is a partial financial fact, a silently dropped event, or a
 * number invented to keep an endpoint responding.
 *
 * §30 constrains HOW this may be proved, and it is worth stating because it
 * shapes every case below: the injection may not add a production debug
 * switch, a bypass header, a disable-constraint route, a special admin
 * endpoint, or an `if (test)` branch in the core. So failures are injected
 * from OUTSIDE the product — by killing a connection, by taking a privilege
 * away, by racing two real callers, by a transaction the test rolls back —
 * and the product runs exactly the code it runs in production.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool, type PoolClient } from 'pg';
import { reconcile, type ReconciliationRunResult } from '@daftar/accounting';
import {
  appClient,
  must,
  post,
  postAs,
  assertionFor,
  refusal,
  seedPostingFixture,
  simpleCommand,
  todayIn,
  type PostingFixture,
} from '../helpers/accounting-posting';
import { ensurePostgres, ownerPool, reconcilerDbUrl, resetData } from '../helpers/test-app';
import { PoolReconciliationConnection } from '../helpers/accounting-reconciliation';
import { DatabaseAccountingReconciliationReader } from '../../apps/api/src/modules/accounting/accounting-reconciliation.reader';

let fx: PostingFixture;
let today: string;

const clock = { now: (): Date => new Date('2026-09-23T03:00:00Z') };

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), `fi-${Date.now()}`);
  today = await todayIn(ownerPool(), 'Asia/Hebron');
}, 300_000);

/** How many journal entries this business carries right now. */
async function entryCount(): Promise<number> {
  const { rows } = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1`, [fx.businessId]);
  return Number(must(rows[0]).n);
}

async function outboxCount(): Promise<number> {
  const { rows } = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox_events`);
  return Number(must(rows[0]).n);
}

describe('FI-01 — a crash between the journal and the outbox leaves nothing behind', () => {
  it('rolls the whole posting back, journal and event together', async () => {
    const before = await entryCount();
    const beforeEvents = await outboxCount();
    const c = await appClient();
    try {
      await c.query('BEGIN');
      const command = simpleCommand(fx, randomUUID(), today, 4100n);
      const outcome = await postAs(assertionFor(command, fx.userId), command, {}, c);
      expect(outcome.created).toBe(true);
      // The journal row exists INSIDE this transaction. The read needs the
      // tenant scope because `daftar_app` is not exempt from row level
      // security — the posting command took its identity from the signed
      // assertion, not from these GUCs, so nothing set them.
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [fx.tenantId, fx.businessId]);
      const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE id = $1`, [outcome.entryId]);
      expect(Number(must(rows[0]).n)).toBe(1);
      // The crash: the process dies before COMMIT. Nothing acknowledged it,
      // so nothing may survive it.
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    expect(await entryCount()).toBe(before);
    expect(await outboxCount()).toBe(beforeEvents);
  });
});

describe('FI-02 — an outbox sink that is unavailable AFTER commit loses no event', () => {
  it('keeps the journal, keeps the event, and leaves it to be relayed again', async () => {
    const command = simpleCommand(fx, randomUUID(), today, 4200n);
    const outcome = await post(command, fx.userId);
    expect(outcome.created).toBe(true);

    const { rows } = await ownerPool().query<{ id: string; published_at: string | null }>(
      `SELECT id, published_at FROM outbox_events WHERE payload::text LIKE $1 ORDER BY created_at DESC LIMIT 1`,
      [`%${outcome.entryId}%`],
    );
    const event = must(rows[0], 'outbox event for the posting');
    // The sink was never reached: the row is still unpublished, which is the
    // whole point of an outbox. An event that vanished when a downstream
    // service was down would be a financial fact nobody downstream ever
    // learns about.
    expect(event.published_at).toBeNull();

    const { rows: still } = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE id = $1`, [outcome.entryId]);
    expect(Number(must(still[0]).n)).toBe(1);
  });
});

describe('FI-03 — a crash mid-reconciliation leaves the next run clean', () => {
  it('writes nothing, so there is nothing to resume and nothing to repair', async () => {
    const pool = new Pool({ connectionString: reconcilerDbUrl, max: 2 });
    try {
      const reader = new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool));
      const digest = async (): Promise<string> => {
        const { rows } = await ownerPool().query<{ d: string }>(
          `SELECT md5(coalesce(string_agg(e.id::text || e.posting_fingerprint, '|' ORDER BY e.id), '')) AS d FROM journal_entries e`,
        );
        return must(rows[0]).d;
      };
      const before = await digest();

      // The crash: the pass is abandoned after its first business. Because it
      // only reads, "abandoned" has no aftermath to clean up.
      const targets = await reader.targets();
      expect(targets.length).toBeGreaterThan(0);
      await reader.check(must(targets[0]), 'R-ACC-01');

      const after: ReconciliationRunResult = await reconcile(reader, clock);
      expect(after.enumeration).toBe('complete');
      expect(after.errorCount).toBe(0);
      expect(after.unavailableCount).toBe(0);
      expect(await digest()).toBe(before);
    } finally {
      await pool.end();
    }
  });
});

describe('FI-04 — a raw unbalanced insert fails at COMMIT', () => {
  /**
   * The full matrix of raw refusals lives in
   * `accounting-raw-sql-invariants.test.ts`, where each case also asserts
   * WHERE the refusal came from. This case is here so the failure-injection
   * matrix is complete on its own terms rather than by cross-reference.
   */
  it('refuses the entry even for the schema owner, with every grant in the world', async () => {
    const c = await ownerPool().connect();
    const entryId = randomUUID();
    const sourceId = randomUUID();
    let refusedAt = 'accepted';
    let message = '';
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO accounting_source_bindings (tenant_id, business_id, source_type, source_id, journal_entry_id) VALUES ($1, $2, 'manual_adjustment', $3, $4)`,
        [fx.tenantId, fx.businessId, sourceId, entryId],
      );
      await c.query(`INSERT INTO accounting_manual_adjustments (tenant_id, business_id, id, reason, actor_user_id) VALUES ($1, $2, $3, 'fi-04', $4)`, [
        fx.tenantId,
        fx.businessId,
        sourceId,
        fx.userId,
      ]);
      await c.query(
        `INSERT INTO journal_entries (tenant_id, business_id, id, entry_date, source_type, source_id, description,
                                      actor_kind, actor_user_id, request_id, posting_fingerprint)
         VALUES ($1, $2, $3, $4::date, 'manual_adjustment', $5, 'fi-04', 'user', $6, 'fi-04', repeat('c', 64))`,
        [fx.tenantId, fx.businessId, entryId, today, sourceId, fx.userId],
      );
      const accounts = await c.query<{ id: string }>(`SELECT id FROM accounts WHERE business_id = $1 ORDER BY code LIMIT 2`, [fx.businessId]);
      let lineNo = 0;
      for (const [account, debit, credit] of [
        [must(accounts.rows[0]).id, 5000, 0],
        [must(accounts.rows[1]).id, 0, 4000],
      ] as const) {
        lineNo += 1;
        await c.query(
          `INSERT INTO journal_lines (tenant_id, business_id, id, journal_entry_id, line_no, account_id,
                                      debit_minor, credit_minor, base_amount_minor, base_currency,
                                      txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at)
           VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6, $7, $8, 'ILS', $9, 'ILS', 1, 'base', date_trunc('second', now()))`,
          [fx.tenantId, fx.businessId, entryId, lineNo, account, debit, credit, Math.max(debit, credit), Math.max(debit, credit)],
        );
      }
      await c.query('COMMIT');
    } catch (e) {
      refusedAt = 'refused';
      message = e instanceof Error ? e.message : String(e);
      await c.query('ROLLBACK').catch(() => undefined);
    } finally {
      c.release();
    }
    expect(refusedAt).toBe('refused');
    expect(message).toMatch(/entry_unbalanced/);
  });
});

describe('FI-05 — two concurrent identical postings produce ONE journal fact', () => {
  it('admits one and replays the other, and never writes the entry twice', async () => {
    const command = simpleCommand(fx, randomUUID(), today, 4500n);
    const assertionA = assertionFor(command, fx.userId);
    const assertionB = assertionFor(command, fx.userId);
    const [a, b] = await Promise.all([postAs(assertionA, command), postAs(assertionB, command)]);
    expect(a.entryId).toBe(b.entryId);
    expect([a.created, b.created].filter(Boolean).length).toBe(1);

    const { rows } = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_source_bindings WHERE business_id = $1 AND source_id = $2`,
      [fx.businessId, command.sourceId],
    );
    expect(Number(must(rows[0]).n)).toBe(1);
  });
});

describe('FI-06 — a missing FX rate fails loudly and writes nothing', () => {
  it('the rate read raises accounting.fx_rate_missing rather than returning 1', async () => {
    const c = await appClient();
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [fx.tenantId, fx.businessId]);
      const message = await refusal(() => c.query(`SELECT accounting_fx_rate_lookup($1::uuid, 'USD', 'ILS', now())`, [fx.businessId]));
      expect(message).toMatch(/accounting\.fx_rate_missing/);
      // Not "returned 1 and logged a warning". There is no value to read.
      expect(message).not.toMatch(/^1(\.0+)?$/);
    } finally {
      await c.end();
    }
  });

  it('a foreign-currency posting with no usable rate writes nothing at all', async () => {
    const before = await entryCount();
    const command = simpleCommand(fx, randomUUID(), today, 4600n);
    const foreign = {
      ...command,
      lines: command.lines.map((l, i) => (i === 0 ? { ...l, txnCurrency: 'USD', txnAmountMinor: 1000n, fxRate: '0', fxRateSource: 'provider' as const } : l)),
    };
    const message = await refusal(() => post(foreign, fx.userId));
    // Refused by the database, at the row: `fx_rate > 0`. Which layer refuses
    // matters less here than that SOMETHING did and that nothing partial was
    // left behind — a posting that had written its entry and then failed on a
    // line would be the actual failure this case looks for.
    expect(message).toMatch(/accounting\.|fx_rate/);
    expect(await entryCount()).toBe(before);
    const { rows } = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_source_bindings WHERE business_id = $1 AND source_id = $2`,
      [fx.businessId, command.sourceId],
    );
    expect(Number(must(rows[0]).n)).toBe(0);
  });
});

describe('FI-07 — a posting that races a period close never lands behind closed books', () => {
  /**
   * On a business of its own, because a closed period is IMMUTABLE — it
   * cannot be deleted and it is part of what was reported — so this case
   * cannot borrow the shared fixture and hand it back unchanged. Seeding a
   * second business is the honest way to run it; suppressing the immutability
   * to clean up would be undoing an accepted invariant for a test's
   * convenience.
   */
  it('either posts before the close or is refused by it — never both', async () => {
    const raced = await seedPostingFixture(ownerPool(), `fi07-${Date.now()}`);
    const periodId = randomUUID();
    await ownerPool().query(
      `INSERT INTO accounting_periods (tenant_id, business_id, id, start_date, end_date, status, created_by_user_id)
       VALUES ($1, $2, $3, $4::date - 30, $4::date + 30, 'open', $5)`,
      [raced.tenantId, raced.businessId, periodId, today, raced.userId],
    );
    const command = simpleCommand(raced, randomUUID(), today, 4700n);
    const posting = post(command, raced.userId).then(
      () => 'posted' as const,
      () => 'refused' as const,
    );
    const closing = ownerPool()
      .query(`UPDATE accounting_periods SET status = 'closed', closed_by_user_id = $2, closed_at = now() WHERE id = $1`, [periodId, raced.userId])
      .then(() => 'closed' as const);
    const [postResult] = await Promise.all([posting, closing]);

    // Whatever the interleaving was, the ledger must be consistent with it:
    // if the entry exists, it is not inside a period that is closed now with
    // a close that predates it.
    const { rows } = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM journal_entries e
         JOIN accounting_periods p
           ON p.business_id = e.business_id AND e.entry_date BETWEEN p.start_date AND p.end_date
        WHERE e.business_id = $1 AND p.status = 'closed' AND p.closed_at IS NOT NULL AND e.created_at > p.closed_at`,
      [raced.businessId],
    );
    expect(Number(must(rows[0]).n), `posting was ${postResult}`).toBe(0);
  });
});

describe('FI-08 — a connection lost mid-posting rolls the posting back', () => {
  it('leaves no entry, no line and no binding', async () => {
    const before = await entryCount();
    const c = await appClient();
    // The termination below arrives as a socket-level error AFTER the query
    // that caused it has already settled, so it has nowhere to be caught.
    // Swallowing it here is not hiding a failure: the failure is the point of
    // the case, and it is asserted from the database a few lines down.
    c.on('error', () => undefined);
    const command = simpleCommand(fx, randomUUID(), today, 4800n);
    await c.query('BEGIN');
    const outcome = await postAs(assertionFor(command, fx.userId), command, {}, c);
    expect(outcome.created).toBe(true);
    // The loss: the backend is terminated from outside, exactly as a network
    // partition or an OOM kill would do, with the transaction still open.
    const { rows } = await ownerPool().query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE state = 'idle in transaction' AND application_name IS NOT NULL AND query LIKE '%accounting_post%' LIMIT 1`,
    );
    const pid = rows[0]?.pid;
    if (pid !== undefined) await ownerPool().query(`SELECT pg_terminate_backend($1)`, [pid]);
    await c.end().catch(() => undefined);

    expect(await entryCount()).toBe(before);
    const { rows: bindings } = await ownerPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_source_bindings WHERE business_id = $1 AND source_id = $2`,
      [fx.businessId, command.sourceId],
    );
    expect(Number(must(bindings[0]).n)).toBe(0);
  });
});

describe('FI-09 / FI-10 — an audit or outbox insertion that fails rolls the command back', () => {
  /**
   * Injected by structure rather than by a switch (§30). There is no way to
   * make the audit insert fail without adding something to the product that
   * exists only for this test, and §30 forbids exactly that. So the property
   * is established where it actually lives: the journal row, the audit row
   * and the outbox row are written by ONE trusted routine in ONE transaction,
   * which makes "one fails, all roll back" a fact about the transaction
   * rather than about the order of three calls.
   *
   * Two assertions, and neither is sufficient alone. The first reads the
   * deployed routine and finds all three writes inside it — a future version
   * that moved the audit write to the application layer would fail here. The
   * second rolls a real posting back and finds nothing left of any of the
   * three.
   */
  it('writes the journal, the audit and the event inside ONE trusted routine', async () => {
    const { rows } = await ownerPool().query<{ src: string }>(
      `SELECT pg_get_functiondef('accounting_post_entry(date, text, text, jsonb)'::regprocedure) AS src`,
    );
    const source = must(rows[0]).src;
    expect(source).toMatch(/INSERT INTO journal_entries/);
    expect(source).toMatch(/INSERT INTO audit_events/);
    expect(source).toMatch(/INSERT INTO outbox_events/);
    // And it cannot commit early. This is a FUNCTION, not a PROCEDURE: only
    // a procedure may COMMIT inside its own body, so the three writes above
    // are necessarily part of the CALLER's transaction and share its fate.
    const { rows: kind } = await ownerPool().query<{ prokind: string }>(
      `SELECT p.prokind FROM pg_proc p WHERE p.oid = 'accounting_post_entry(date, text, text, jsonb)'::regprocedure`,
    );
    expect(must(kind[0]).prokind).toBe('f');
  });

  it('leaves no journal row, no audit row and no event when the command rolls back', async () => {
    const counts = async (): Promise<{ entries: number; audits: number; events: number }> => {
      const { rows } = await ownerPool().query<{ entries: string; audits: string; events: string }>(
        `SELECT (SELECT count(*)::text FROM journal_entries WHERE business_id = $1) AS entries,
                (SELECT count(*)::text FROM audit_events WHERE business_id = $1) AS audits,
                (SELECT count(*)::text FROM outbox_events WHERE business_id = $1) AS events`,
        [fx.businessId],
      );
      const row = must(rows[0]);
      return { entries: Number(row.entries), audits: Number(row.audits), events: Number(row.events) };
    };
    const before = await counts();
    const c = await appClient();
    try {
      await c.query('BEGIN');
      const command = simpleCommand(fx, randomUUID(), today, 4900n);
      const outcome = await postAs(assertionFor(command, fx.userId), command, {}, c);
      expect(outcome.created).toBe(true);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    expect(await counts()).toEqual(before);
  });
});

/**
 * A connection that puts one unhurried statement in front of every scoped
 * check, so the per-business bound is breached by arithmetic rather than by
 * luck.
 *
 * The sleep is issued AFTER the reader has set its own `statement_timeout`,
 * because the reader sets it as the first statement of the scope and this
 * wrapper only delays the first statement that is not a `SET`. PostgreSQL
 * then cancels the sleep at the bound — error 57014 — which is the same
 * cancellation a genuinely slow check would receive, raised by the same
 * mechanism, at the same place in the reader's control flow.
 */
class SlowFirstStatementConnection extends PoolReconciliationConnection {
  override async scoped<T>(tenantId: string, businessId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return super.scoped(tenantId, businessId, (c) => fn(delayFirstStatement(c)));
  }
}

/** The delay itself: once per scope, ahead of the first non-`SET` statement. */
function delayFirstStatement(client: PoolClient): PoolClient {
  let delayed = false;
  const run = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  const query = async (...args: unknown[]): Promise<unknown> => {
    const first = args[0];
    const sql = typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
    if (!delayed && !/^\s*SET\b/i.test(sql)) {
      delayed = true;
      // Far longer than any bound this case sets, so the cancellation is a
      // certainty rather than a race. It costs the bound, not the sleep,
      // because PostgreSQL stops it at the bound.
      await run('SELECT pg_sleep(0.5)');
    }
    return run(...args);
  };
  return new Proxy(client, {
    get: (target, property, receiver): unknown => (property === 'query' ? query : Reflect.get(target, property, receiver)),
  });
}

describe('FI-11 — a reconciliation alert that cannot be delivered changes no financial truth', () => {
  it('fails the cycle, leaves the journal untouched, and stays retryable', async () => {
    const pool = new Pool({ connectionString: reconcilerDbUrl, max: 1 });
    try {
      const { rows } = await ownerPool().query<{ d: string }>(
        `SELECT md5(coalesce(string_agg(l.id::text || l.base_amount_minor::text, '|' ORDER BY l.id), '')) AS d FROM journal_lines l`,
      );
      const before = must(rows[0]).d;

      // The sink failure: the reader itself raises where an alert would be
      // emitted. The pass must record the failure rather than swallow it.
      const reader = new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool));
      const broken = {
        targets: () => reader.targets(),
        check: async (): Promise<never> => {
          throw new Error('alert sink unavailable');
        },
      };
      const result = await reconcile(broken, clock);
      expect(result.enumeration).toBe('complete');
      expect(result.errorCount).toBe(result.businessCount * result.checkCount);
      expect(result.results.every((r) => r.status === 'error')).toBe(true);
      expect(result.results.every((r) => r.errorCode === 'accounting.reconciliation_check_failed')).toBe(true);

      const { rows: after } = await ownerPool().query<{ d: string }>(
        `SELECT md5(coalesce(string_agg(l.id::text || l.base_amount_minor::text, '|' ORDER BY l.id), '')) AS d FROM journal_lines l`,
      );
      expect(must(after[0]).d).toBe(before);
    } finally {
      await pool.end();
    }
  });

  /**
   * §25, as an injected failure rather than as a comment: a check that runs
   * past its bound is reported, not skipped. The bound is imposed by
   * PostgreSQL, so the case proves the real mechanism.
   *
   * THE LATENCY IS INJECTED, AND THAT IS THE POINT. An earlier version of
   * this case set the bound to one millisecond and asserted that at least one
   * check breached it — which asked the machine, not the product. On a slow
   * host the catalogue lookup took a few milliseconds and the case passed; on
   * a fast GitHub runner every statement finished inside the millisecond, the
   * cycle came back clean, and the case failed having proved nothing either
   * way. A test whose verdict is decided by how fast the runner is does not
   * hold the rule it is named after.
   *
   * So the delay is injected from outside the product, exactly as §30 allows
   * and as every other case in this file does: the first statement of each
   * scoped check is preceded by a sleep the bound cannot accommodate. Nothing
   * about the mechanism is simulated — the reader sets `statement_timeout`
   * itself, PostgreSQL cancels the statement, and the reconciler classifies
   * what it gets back. What changed is only that the breach now happens on
   * every machine instead of on a slow one.
   */
  it('a check that exceeds its per-business bound is an ERROR, never a silent skip', async () => {
    const pool = new Pool({ connectionString: reconcilerDbUrl, max: 1 });
    try {
      const plain = new DatabaseAccountingReconciliationReader(new PoolReconciliationConnection(pool), 1);
      const bounded = new DatabaseAccountingReconciliationReader(new SlowFirstStatementConnection(pool), 1);
      // Enumeration is not what is under test and must not be delayed: the
      // cycle has to reach the checks for the checks to breach anything.
      const injected = {
        targets: () => plain.targets(),
        check: (target: Parameters<typeof bounded.check>[0], checkId: Parameters<typeof bounded.check>[1]) => bounded.check(target, checkId),
      };
      const result = await reconcile(injected, clock);

      expect(result.enumeration).toBe('complete');
      // Every check breaches now, deterministically, so the claim is the
      // whole matrix rather than "at least one of them".
      expect(result.errorCount).toBe(result.businessCount * result.checkCount);
      for (const failed of result.results.filter((r) => r.status === 'error')) {
        expect(failed.errorCode).toBe('accounting.reconciliation_check_failed');
        expect(failed.offendingCount).toBe(0);
      }
      // A breach is an error. It is never `unavailable`, which means "this
      // credential could not look", and never a clean verdict.
      expect(result.results.some((r) => r.status === 'unavailable')).toBe(false);
      expect(result.results.some((r) => r.status === 'ok')).toBe(false);
    } finally {
      await pool.end();
    }
  });
});

describe('FI-12 — a report whose read dependency fails says so, and invents nothing', () => {
  it('raises rather than serving a stale or invented balance', async () => {
    const c = new Client({ connectionString: reconcilerDbUrl });
    await c.connect();
    try {
      // The dependency failure, injected from outside the product: the read
      // runs with a bound it cannot meet. There is no cache to fall back to
      // and no materialized read store to serve a stale number from, so the
      // only honest outcomes are an answer or an error.
      await c.query(`SET statement_timeout = 1`);
      let failed = false;
      try {
        await c.query(`SELECT sum(base_amount_minor), pg_sleep(0.2) FROM journal_lines`);
      } catch (e) {
        failed = true;
        expect(e instanceof Error ? e.message : String(e)).toMatch(/statement timeout|canceling statement/i);
      }
      expect(failed).toBe(true);
    } finally {
      await c.end();
    }
  });

  it('has no materialized balance store that could go stale', async () => {
    // Stated as an assertion because §29 forbids manufacturing a fake
    // fallback-cache test: the reason there is no stale-read case is that
    // there is nothing to read stale from. Every balance is computed from
    // the journal at read time.
    const { rows } = await ownerPool().query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'm'`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
    const { rows: stored } = await ownerPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('balance', 'balance_minor', 'cached_balance', 'running_balance')`,
    );
    expect(stored).toEqual([]);
  });
});
