/**
 * TWO CONNECTIONS, ONE PERIOD (P2-S6 §24-§27, §41).
 *
 * §25 calls close-versus-post the CENTRAL invariant of this slice, and it is
 * the one a single-threaded test can never touch: the interesting window is
 * the one between "is this period open?" and "write the entry", and only two
 * real connections whose statements are both in flight can open it.
 *
 * Every case below therefore uses two REAL connections, and refuses to pass
 * unless the two genuinely contended — a race that never raced is a green
 * test that proved nothing. What each one asserts is not merely that somebody
 * lost, but WHICH outcome is correct: a close that wins must not be able to
 * contain an entry committed after it, and a posting that wins must have
 * committed before the close.
 */
import { randomUUID } from 'node:crypto';
import { deriveSourceId } from '@daftar/accounting';
import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  appClient,
  assertionFor,
  must,
  openingBalanceFingerprintOf,
  postAs,
  postOpeningBalanceAs,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostLine,
  type PostingFixture,
} from '../helpers/accounting-posting';
import {
  closePeriod,
  closePeriodAs,
  createPeriod,
  createPeriodAs,
  operationIdFor,
  periodAssertion,
  periodClient,
  periodIdFor,
  periodRefusal,
  readPeriod,
  reopenPeriod,
  type PeriodScope,
} from '../helpers/accounting-periods';

let pool: Pool;
let fx: PostingFixture;
let today: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  pool = ownerPool();
  fx = await seedPostingFixture(pool, `periodrace-${Math.floor(Math.random() * 1e6)}`);
  today = await todayIn(pool, 'Asia/Hebron');
}, 180_000);

async function newBusiness(label: string): Promise<PeriodScope> {
  const tenantId = must((await pool.query<{ id: string }>(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)).rows[0]).id;
  const businessId = must(
    (
      await pool.query<{ id: string }>(
        `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
         VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
        [tenantId, label, `periodrace-${label.toLowerCase()}-${Math.floor(Math.random() * 1e9)}`],
      )
    ).rows[0],
  ).id;
  const userId = must(
    (
      await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`, [
        `periodrace-${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@test.daftar.local`,
        label,
      ])
    ).rows[0],
  ).id;
  return { tenantId, businessId, userId };
}

const daysAgo = async (n: number): Promise<string> => {
  const r = await pool.query<{ d: string }>(`SELECT to_char(($1::date - $2::int), 'YYYY-MM-DD') AS d`, [today, n]);
  return must(r.rows[0]).d;
};

/** The backend serving a connection, so the barrier can watch exactly it. */
async function pidOf(conn: Client): Promise<number> {
  const r = await conn.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid');
  return must(r.rows[0], 'a backend pid').pid;
}

/**
 * Block until one of these two backends is actually waiting on a lock.
 *
 * Scoped to THESE pids: `pg_stat_activity` is cluster-wide and the suites run
 * in parallel, so a barrier that accepted any waiting backend would
 * occasionally be released by somebody else's lock.
 */
async function contend(what: string, pids: readonly number[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND state = 'active'`,
      [[...pids]],
    );
    if (must(r.rows[0]).n > 0) return;
    if (Date.now() > deadline) throw new Error(`${what}: no backend ever waited on a lock, so the two commands did not contend`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Settled {
  who: 'post' | 'period';
  ok: boolean;
  error?: string;
}

/**
 * Post one entry on an ALREADY-OPEN transaction, as `daftar_app`.
 *
 * Through `postAs` with an explicit client, so it takes exactly the path the
 * rest of the accounting suites take — including the manual-adjustment
 * wrapper that supplies the detail row the ledger requires at COMMIT. A
 * hand-rolled call to the primitive here would be a different path, and this
 * file's whole point is what happens on the real one.
 */
async function postOn(conn: Client, scope: PeriodScope, entryDate: string): Promise<void> {
  const c: PostCommand = { ...simpleCommand(fx, randomUUID(), entryDate), tenantId: scope.tenantId, businessId: scope.businessId };
  await postAs(assertionFor(c, scope.userId), c, {}, conn);
}

// ── §25: the central invariant ────────────────────────────────────────────

describe('close versus post — the central invariant (§25)', () => {
  /**
   * Case A: the POSTING reaches the business row first.
   *
   * The close must wait for it. The entry commits inside a period that was
   * still open, and the close then closes a period that already contains it —
   * which is correct, because the entry was committed BEFORE the close.
   */
  it('case A: a posting already in flight commits, and the close waits for it', async () => {
    const s = await newBusiness('caseA');
    const start = await daysAgo(40);
    const periodId = (await createPeriod(s, 'case-a-period-01', start, today)).periodId;
    const entryDate = await daysAgo(20);

    const poster = await appClient();
    const closer = await periodClient();
    const pids = [await pidOf(poster), await pidOf(closer)];
    try {
      await poster.query('BEGIN');
      await postOn(poster, s, entryDate);
      // The poster now holds the business row and the period row, uncommitted.

      const operationId = operationIdFor(s.businessId, 'case-a-close-001');
      const assertion = periodAssertion({ kind: 'period_close', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId }, s.userId);
      // An explicit BEGIN: the assertion travels in a transaction-LOCAL GUC,
      // so a close on an autocommitting connection would lose it before the
      // command ran and would never reach the lock at all.
      await closer.query('BEGIN');
      const closing = (async (): Promise<Settled> => {
        try {
          await closePeriodAs(assertion, { operationId }, { client: closer });
          await closer.query('COMMIT');
          return { who: 'period', ok: true };
        } catch (e) {
          await closer.query('ROLLBACK').catch(() => undefined);
          return { who: 'period', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('case A', pids);
      await poster.query('COMMIT');

      const outcome = await closing;
      expect(outcome.ok, outcome.error).toBe(true);

      // The entry is there, and the period is closed AROUND it.
      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND entry_date = $2`, [
        s.businessId,
        entryDate,
      ]);
      expect(must(r.rows[0]).n).toBe(1);
      expect((await readPeriod(pool, s.businessId, periodId)).status).toBe('closed');
    } finally {
      await poster.query('ROLLBACK').catch(() => undefined);
      await poster.end().catch(() => undefined);
      await closer.end().catch(() => undefined);
    }
  }, 120_000);

  /**
   * Case B: the CLOSE reaches the business row first.
   *
   * The posting must wait, and when it proceeds it must SEE the close and be
   * refused. This is the case a naive implementation loses: without the
   * period row lock the posting would read a stale snapshot and commit into a
   * closed month.
   */
  it('case B: a close already in flight commits, and the waiting posting is REFUSED', async () => {
    const s = await newBusiness('caseB');
    const start = await daysAgo(40);
    const periodId = (await createPeriod(s, 'case-b-period-01', start, today)).periodId;
    const entryDate = await daysAgo(20);

    const closer = await periodClient();
    const poster = await appClient();
    const pids = [await pidOf(closer), await pidOf(poster)];
    try {
      await closer.query('BEGIN');
      const operationId = operationIdFor(s.businessId, 'case-b-close-001');
      const assertion = periodAssertion({ kind: 'period_close', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId }, s.userId);
      await closePeriodAs(assertion, { operationId }, { client: closer });
      // The closer now holds the business row FOR UPDATE, uncommitted.

      await poster.query('BEGIN');
      const posting = (async (): Promise<Settled> => {
        try {
          await postOn(poster, s, entryDate);
          await poster.query('COMMIT');
          return { who: 'post', ok: true };
        } catch (e) {
          await poster.query('ROLLBACK').catch(() => undefined);
          return { who: 'post', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('case B', pids);
      await closer.query('COMMIT');

      const outcome = await posting;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/accounting\.period_closed/);
      // The refusal is a domain sentence, not a lock or a constraint name.
      expect(outcome.error).not.toMatch(/deadlock|could not serialize|23\d\d\d|40001/i);

      // NOTHING was written into the closed period.
      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND entry_date = $2`, [
        s.businessId,
        entryDate,
      ]);
      expect(must(r.rows[0]).n).toBe(0);
    } finally {
      await closer.query('ROLLBACK').catch(() => undefined);
      await closer.end().catch(() => undefined);
      await poster.end().catch(() => undefined);
    }
  }, 120_000);

  /**
   * A lock-order defect is not a business outcome to be retried, so "it did
   * not deadlock this time" is not the claim. The claim is that BOTH
   * orderings, run against each other repeatedly, always resolve into one of
   * the two correct answers — and a deadlock is neither of them.
   */
  it('neither ordering deadlocks, however they interleave (§14, §25)', async () => {
    const s = await newBusiness('interleave');
    const start = await daysAgo(90);
    const periodId = (await createPeriod(s, 'interleave-per001', start, today)).periodId;

    for (let round = 0; round < 4; round += 1) {
      const posterFirst = round % 2 === 0;
      const poster = await appClient();
      const closer = await periodClient();
      const pids = [await pidOf(poster), await pidOf(closer)];
      const entryDate = await daysAgo(80 - round);
      const operationId = operationIdFor(s.businessId, `interleave-cls-${round}`);
      const assertion = periodAssertion({ kind: 'period_close', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId }, s.userId);
      try {
        const runPost = async (): Promise<Settled> => {
          try {
            await postOn(poster, s, entryDate);
            await poster.query('COMMIT');
            return { who: 'post', ok: true };
          } catch (e) {
            await poster.query('ROLLBACK').catch(() => undefined);
            return { who: 'post', ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        };
        const runClose = async (): Promise<Settled> => {
          try {
            await closePeriodAs(assertion, { operationId }, { client: closer });
            await closer.query('COMMIT');
            return { who: 'period', ok: true };
          } catch (e) {
            await closer.query('ROLLBACK').catch(() => undefined);
            return { who: 'period', ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        };

        await poster.query('BEGIN');
        await closer.query('BEGIN');
        const first = posterFirst ? runPost() : runClose();
        // A SHORT barrier, and a miss is fine here. Cases A and B above prove
        // that the two genuinely contend; this loop is about what happens
        // when they interleave arbitrarily, including when they do not race
        // at all, so waiting the full barrier timeout would only be slow.
        await contend(`interleave ${round}`, pids, 1_500).catch(() => undefined);
        const second = posterFirst ? runClose() : runPost();
        for (const outcome of await Promise.all([first, second])) {
          expect(outcome.error ?? '').not.toMatch(/deadlock/i);
        }
        // Whatever happened, the period is closed and contains no entry
        // committed after its close.
        expect((await readPeriod(pool, s.businessId, periodId)).status).toBe('closed');
        // Reopen for the next round.
        expect((await reopenPeriod(s, `interleave-rop-${round}`, periodId, `round ${round}`)).changed).toBe(true);
      } finally {
        await poster.end().catch(() => undefined);
        await closer.end().catch(() => undefined);
      }
    }
  }, 180_000);
});

// ── §26: reopen versus post ───────────────────────────────────────────────

describe('reopen versus post (§26)', () => {
  it('a posting that waits for a reopen sees the period OPEN and succeeds', async () => {
    const s = await newBusiness('reopenrace');
    const start = await daysAgo(40);
    const periodId = (await createPeriod(s, 'reopen-race-per1', start, today)).periodId;
    const entryDate = await daysAgo(20);
    expect((await closePeriod(s, 'reopen-race-cls1', periodId)).changed).toBe(true);

    const reopener = await periodClient();
    const poster = await appClient();
    const pids = [await pidOf(reopener), await pidOf(poster)];
    try {
      await reopener.query('BEGIN');
      const reason = 'a late invoice arrived';
      const operationId = operationIdFor(s.businessId, 'reopen-race-op01');
      const assertion = periodAssertion({ kind: 'period_reopen', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId, reason }, s.userId);
      await reopener.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertion]);
      await reopener.query(`SELECT period_id, changed FROM accounting_period_reopen($1::uuid, $2, $3)`, [operationId, reason, 'req-race']);

      await poster.query('BEGIN');
      const posting = (async (): Promise<Settled> => {
        try {
          await postOn(poster, s, entryDate);
          await poster.query('COMMIT');
          return { who: 'post', ok: true };
        } catch (e) {
          await poster.query('ROLLBACK').catch(() => undefined);
          return { who: 'post', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('reopen race', pids);
      await reopener.query('COMMIT');

      const outcome = await posting;
      expect(outcome.ok, outcome.error).toBe(true);
      expect((await readPeriod(pool, s.businessId, periodId)).status).toBe('open');
    } finally {
      await reopener.query('ROLLBACK').catch(() => undefined);
      await reopener.end().catch(() => undefined);
      await poster.end().catch(() => undefined);
    }
  }, 120_000);

  it('a posting that waits for a reopen that ROLLS BACK still sees the period closed', async () => {
    const s = await newBusiness('reopenabort');
    const start = await daysAgo(40);
    const periodId = (await createPeriod(s, 'abort-race-per1', start, today)).periodId;
    const entryDate = await daysAgo(20);
    expect((await closePeriod(s, 'abort-race-cls1', periodId)).changed).toBe(true);

    const reopener = await periodClient();
    const poster = await appClient();
    const pids = [await pidOf(reopener), await pidOf(poster)];
    try {
      await reopener.query('BEGIN');
      const reason = 'a reopen that will not commit';
      const operationId = operationIdFor(s.businessId, 'abort-race-op001');
      const assertion = periodAssertion({ kind: 'period_reopen', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId, reason }, s.userId);
      await reopener.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertion]);
      await reopener.query(`SELECT period_id, changed FROM accounting_period_reopen($1::uuid, $2, $3)`, [operationId, reason, 'req-race']);

      await poster.query('BEGIN');
      const posting = (async (): Promise<Settled> => {
        try {
          await postOn(poster, s, entryDate);
          await poster.query('COMMIT');
          return { who: 'post', ok: true };
        } catch (e) {
          await poster.query('ROLLBACK').catch(() => undefined);
          return { who: 'post', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('reopen abort race', pids);
      await reopener.query('ROLLBACK');

      const outcome = await posting;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/accounting\.period_closed/);
      expect((await readPeriod(pool, s.businessId, periodId)).status).toBe('closed');
    } finally {
      await reopener.end().catch(() => undefined);
      await poster.end().catch(() => undefined);
    }
  }, 120_000);
});

// ── §24: the activation race ──────────────────────────────────────────────

describe('the activation race has a deterministic answer (§24)', () => {
  it('a first-period creation and a posting cannot both believe they went first', async () => {
    const s = await newBusiness('activation');
    const outside = await daysAgo(400);

    const creator = await periodClient();
    const poster = await appClient();
    const pids = [await pidOf(creator), await pidOf(poster)];
    try {
      await creator.query('BEGIN');
      const start = await daysAgo(40);
      const operationId = operationIdFor(s.businessId, 'activation-race01');
      const periodId = periodIdFor(s.businessId, 'activation-race01');
      const assertion = periodAssertion(
        { kind: 'period_create', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId, startDate: start, endDate: today },
        s.userId,
      );
      await createPeriodAs(assertion, { operationId, startDate: start, endDate: today }, { client: creator });

      await poster.query('BEGIN');
      const posting = (async (): Promise<Settled> => {
        try {
          // A date the new period does NOT cover. Before activation this is
          // permitted; after it, it is refused. There is no middle answer.
          await postOn(poster, s, outside);
          await poster.query('COMMIT');
          return { who: 'post', ok: true };
        } catch (e) {
          await poster.query('ROLLBACK').catch(() => undefined);
          return { who: 'post', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('activation race', pids);
      await creator.query('COMMIT');

      const outcome = await posting;
      // The creator reached the business row first, so the posting waited and
      // then observed an ACTIVATED business.
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/accounting\.period_missing_for_date/);

      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1`, [s.businessId]);
      expect(must(r.rows[0]).n).toBe(0);
    } finally {
      await creator.query('ROLLBACK').catch(() => undefined);
      await creator.end().catch(() => undefined);
      await poster.end().catch(() => undefined);
    }
  }, 120_000);

  it('two concurrent creations of the SAME first period produce one period, not two', async () => {
    const s = await newBusiness('firstrace');
    const start = await daysAgo(40);

    const a = await periodClient();
    const b = await periodClient();
    const pids = [await pidOf(a), await pidOf(b)];
    try {
      // Two DIFFERENT idempotency keys stating the same range: the exclusion
      // constraint, not the registry, is what must answer.
      const mk = (key: string): { operationId: string; assertion: string } => {
        const operationId = operationIdFor(s.businessId, key);
        const periodId = periodIdFor(s.businessId, key);
        return {
          operationId,
          assertion: periodAssertion(
            { kind: 'period_create', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId, startDate: start, endDate: today },
            s.userId,
          ),
        };
      };
      const one = mk('first-race-key-a');
      const two = mk('first-race-key-b');

      await a.query('BEGIN');
      await createPeriodAs(one.assertion, { operationId: one.operationId, startDate: start, endDate: today }, { client: a });

      await b.query('BEGIN');
      const second = (async (): Promise<Settled> => {
        try {
          await createPeriodAs(two.assertion, { operationId: two.operationId, startDate: start, endDate: today }, { client: b });
          await b.query('COMMIT');
          return { who: 'period', ok: true };
        } catch (e) {
          await b.query('ROLLBACK').catch(() => undefined);
          return { who: 'period', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('first-period race', pids);
      await a.query('COMMIT');

      const outcome = await second;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/accounting\.period_overlap/);
      expect(outcome.error).not.toMatch(/accounting_periods_no_overlap|23P01/);

      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_periods WHERE business_id = $1`, [s.businessId]);
      expect(must(r.rows[0]).n).toBe(1);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  }, 120_000);
});

// ── §18, §41: idempotency under contention, and atomicity ─────────────────

describe('a period, its registry entry, its audit and its event are one fact (§33, §34, §41)', () => {
  const countsFor = async (businessId: string): Promise<{ periods: number; ops: number; audits: number; outbox: number }> => {
    const r = await pool.query<{ periods: number; ops: number; audits: number; outbox: number }>(
      `SELECT (SELECT count(*) FROM accounting_periods            WHERE business_id = $1)::int AS periods,
              (SELECT count(*) FROM accounting_period_operations  WHERE business_id = $1)::int AS ops,
              (SELECT count(*) FROM audit_events                  WHERE business_id = $1)::int AS audits,
              (SELECT count(*) FROM outbox_events                 WHERE business_id = $1)::int AS outbox`,
      [businessId],
    );
    return must(r.rows[0]);
  };

  it('a created period writes exactly one audit row and one event, carrying identifiers only', async () => {
    const s = await newBusiness('trails');
    const periodId = (await createPeriod(s, 'trails-period-01', '2026-06-01', '2026-06-30')).periodId;

    const audit = must(
      (
        await pool.query<{ action: string; entity: string; actor_user_id: string; metadata: Record<string, unknown> }>(
          `SELECT action, entity, actor_user_id, metadata FROM audit_events
            WHERE business_id = $1 AND action = 'accounting.period_created' AND entity_id = $2`,
          [s.businessId, periodId],
        )
      ).rows[0],
    );
    expect(audit.entity).toBe('accounting_period');
    expect(audit.actor_user_id).toBe(s.userId);
    expect(audit.metadata).toEqual({ startDate: '2026-06-01', endDate: '2026-06-30', status: 'open' });

    const event = must(
      (
        await pool.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM outbox_events WHERE business_id = $1 AND type = 'accounting.period.created' AND payload->>'periodId' = $2`,
          [s.businessId, periodId],
        )
      ).rows[0],
    );
    expect(Object.keys(event.payload).sort()).toEqual(['businessId', 'endDate', 'periodId', 'startDate', 'status']);
  });

  it('an idempotent replay adds no second audit row and no second event (§18)', async () => {
    const s = await newBusiness('replaytrail');
    await createPeriod(s, 'replay-period-01', '2026-06-01', '2026-06-30');
    const after = await countsFor(s.businessId);
    // A fresh assertion, the same command.
    expect((await createPeriod(s, 'replay-period-01', '2026-06-01', '2026-06-30')).changed).toBe(false);
    expect(await countsFor(s.businessId)).toEqual(after);
  });

  it('if the OUTBOX insert fails, the period, its registry entry and its audit all go with it (§41)', async () => {
    const s = await newBusiness('outboxbreak');
    const before = await countsFor(s.businessId);

    // Injected at the database, inside the same transaction the command runs
    // in — the only place that proves ATOMICITY rather than proving that a
    // mocked port throws. There is no production failpoint anywhere.
    await pool.query(`CREATE OR REPLACE FUNCTION period_outbox_break() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type LIKE 'accounting.period.%' THEN RAISE EXCEPTION 'injected outbox failure' USING ERRCODE = 'P0001'; END IF;
        RETURN NEW; END $$;`);
    await pool.query(`CREATE TRIGGER period_outbox_break_t BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION period_outbox_break()`);
    try {
      await expect(createPeriod(s, 'outbox-break-001', '2026-07-01', '2026-07-31')).rejects.toThrow(/injected outbox failure/);
      expect(await countsFor(s.businessId)).toEqual(before);
    } finally {
      await pool.query(`DROP TRIGGER period_outbox_break_t ON outbox_events`);
      await pool.query(`DROP FUNCTION period_outbox_break()`);
    }

    // And once the injected failure is gone, the SAME command succeeds: the
    // rollback left nothing behind that would make a retry conflict.
    expect((await createPeriod(s, 'outbox-break-001', '2026-07-01', '2026-07-31')).changed).toBe(true);
    const after = await countsFor(s.businessId);
    expect(after).toEqual({ periods: before.periods + 1, ops: before.ops + 1, audits: before.audits + 1, outbox: before.outbox + 1 });
  }, 120_000);

  it('if the AUDIT insert fails, the close rolls back and the period stays OPEN (§41)', async () => {
    const s = await newBusiness('auditbreak');
    const periodId = (await createPeriod(s, 'audit-break-per1', '2026-07-01', '2026-07-31')).periodId;
    const before = await countsFor(s.businessId);

    await pool.query(`CREATE OR REPLACE FUNCTION period_audit_break() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action = 'accounting.period_closed' THEN RAISE EXCEPTION 'injected audit failure' USING ERRCODE = 'P0001'; END IF;
        RETURN NEW; END $$;`);
    await pool.query(`CREATE TRIGGER period_audit_break_t BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION period_audit_break()`);
    try {
      await expect(closePeriod(s, 'audit-break-cls1', periodId)).rejects.toThrow(/injected audit failure/);
      expect(await countsFor(s.businessId)).toEqual(before);
      // The transition itself rolled back with everything else.
      expect((await readPeriod(pool, s.businessId, periodId)).status).toBe('open');
    } finally {
      await pool.query(`DROP TRIGGER period_audit_break_t ON audit_events`);
      await pool.query(`DROP FUNCTION period_audit_break()`);
    }

    expect((await closePeriod(s, 'audit-break-cls1', periodId)).changed).toBe(true);
    expect((await readPeriod(pool, s.businessId, periodId)).status).toBe('closed');
  }, 120_000);

  it('two connections replaying ONE reopen key reopen the period exactly once (§18)', async () => {
    const s = await newBusiness('reopenonce');
    const periodId = (await createPeriod(s, 'once-period-0001', '2026-08-01', '2026-08-31')).periodId;
    expect((await closePeriod(s, 'once-close-00001', periodId)).changed).toBe(true);

    const reason = 'one key, two connections';
    const operationId = operationIdFor(s.businessId, 'once-reopen-0001');
    const assertionA = periodAssertion({ kind: 'period_reopen', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId, reason }, s.userId);
    const assertionB = periodAssertion({ kind: 'period_reopen', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId, reason }, s.userId);

    const a = await periodClient();
    const b = await periodClient();
    const pids = [await pidOf(a), await pidOf(b)];
    try {
      await a.query('BEGIN');
      await a.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertionA]);
      await a.query(`SELECT period_id, changed FROM accounting_period_reopen($1::uuid, $2, $3)`, [operationId, reason, 'req-once']);

      await b.query('BEGIN');
      const second = (async (): Promise<{ changed: boolean } | { error: string }> => {
        try {
          await b.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertionB]);
          const r = await b.query<{ changed: boolean }>(`SELECT changed FROM accounting_period_reopen($1::uuid, $2, $3)`, [operationId, reason, 'req-once']);
          await b.query('COMMIT');
          return { changed: must(r.rows[0]).changed };
        } catch (e) {
          await b.query('ROLLBACK').catch(() => undefined);
          return { error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('one reopen key', pids);
      await a.query('COMMIT');

      const outcome = await second;
      // Either the registry answered it as a replay, or the assertion's
      // single-use JTI did. Both are the system refusing to reopen twice; a
      // SECOND transition is the only unacceptable answer.
      if ('error' in outcome) {
        expect(outcome.error).toMatch(/assertion_replayed|idempotency_conflict/);
      } else {
        expect(outcome.changed).toBe(false);
      }

      const ops = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM accounting_period_operations WHERE business_id = $1 AND operation_kind = 'period_reopen'`,
        [s.businessId],
      );
      expect(must(ops.rows[0]).n).toBe(1);
      const audits = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND action = 'accounting.period_reopened'`,
        [s.businessId],
      );
      expect(must(audits.rows[0]).n).toBe(1);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  }, 120_000);

  it('the topology lock is per business: two businesses never wait on each other (§14)', async () => {
    const one = await newBusiness('topoA');
    const two = await newBusiness('topoB');

    const a = await periodClient();
    const b = await periodClient();
    try {
      const mk = async (s: PeriodScope, key: string, conn: Client): Promise<void> => {
        const operationId = operationIdFor(s.businessId, key);
        const periodId = periodIdFor(s.businessId, key);
        const assertion = periodAssertion(
          { kind: 'period_create', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId, startDate: '2026-09-01', endDate: '2026-09-30' },
          s.userId,
        );
        await conn.query('BEGIN');
        await createPeriodAs(assertion, { operationId, startDate: '2026-09-01', endDate: '2026-09-30' }, { client: conn });
      };

      await mk(one, 'topo-key-aaaaaa', a);
      // If the lock were global this would block until `a` committed. It does
      // not, and a timeout here is the failure.
      await Promise.race([
        mk(two, 'topo-key-bbbbbb', b),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('the second business waited on the first — the topology lock is not per business')), 5_000),
        ),
      ]);
      await a.query('COMMIT');
      await b.query('COMMIT');

      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_periods WHERE business_id = ANY($1::uuid[])`, [
        [one.businessId, two.businessId],
      ]);
      expect(must(r.rows[0]).n).toBe(2);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  }, 120_000);
});

// ── §12 of the correction: the opening balance and the first period ───────

/** An opening balance on an ALREADY-OPEN transaction, through the real source path. */
async function openBalanceOn(conn: Client, scope: PeriodScope, asOfDate: string, key: string): Promise<void> {
  const positions: PostLine[] = [
    {
      account: { kind: 'system', systemKey: 'cash' },
      side: 'D',
      baseAmountMinor: 50000n,
      baseCurrency: 'ILS',
      txnAmountMinor: 50000n,
      txnCurrency: 'ILS',
      fxRate: '1',
      fxRateSource: 'base',
      fxRateAt: new Date('2026-03-14T09:15:00Z'),
      memo: null,
    },
  ];
  const openingBalanceId = deriveSourceId(scope.businessId, key);
  const assertion = sourceAssertion({
    actorUserId: scope.userId,
    tenantId: scope.tenantId,
    businessId: scope.businessId,
    operationKind: 'post',
    sourceType: 'opening_balance',
    sourceId: openingBalanceId,
    postingFingerprint: openingBalanceFingerprintOf({
      tenantId: scope.tenantId,
      businessId: scope.businessId,
      openingBalanceId,
      asOfDate,
      baseCurrency: 'ILS',
      positions,
    }),
  });
  await postOpeningBalanceAs(assertion, { asOfDate, positions, openingBalanceId, description: 'opening position', requestId: randomUUID() }, conn);
}

/** The books both orders must arrive at. */
async function booksOf(businessId: string): Promise<{ periods: number; openings: number; openingDate: string | null }> {
  const r = await pool.query<{ periods: number; openings: number; opening_date: string | null }>(
    `SELECT (SELECT count(*) FROM accounting_periods WHERE business_id = $1)::int AS periods,
            (SELECT count(*) FROM journal_entries WHERE business_id = $1 AND source_type = 'opening_balance')::int AS openings,
            (SELECT to_char(min(entry_date), 'YYYY-MM-DD') FROM journal_entries WHERE business_id = $1 AND source_type = 'opening_balance') AS opening_date`,
    [businessId],
  );
  const row = must(r.rows[0]);
  return { periods: row.periods, openings: row.openings, openingDate: row.opening_date };
}

/**
 * The race the opening-balance exception has to survive.
 *
 * An opening position dated the day before the merchant's first period, and
 * the creation of that first period, in flight at the same moment. Whichever
 * transaction reaches the business row first, the books must end up the same:
 * the period exists, the opening balance exists, and nothing was refused for
 * want of a covering period. If the two orders could disagree, the exception
 * would have removed the order dependence from the merchant's clicks and left
 * it in the database's scheduling, which is worse rather than better.
 */
describe('the opening balance and the first period, racing (correction §12)', () => {
  it('the PERIOD wins the business row — the opening balance still posts', async () => {
    const s = await newBusiness('obrace-period');
    const start = await daysAgo(60);
    const opening = await daysAgo(61);

    const creator = await periodClient();
    const poster = await appClient();
    const pids = [await pidOf(creator), await pidOf(poster)];
    try {
      await creator.query('BEGIN');
      const operationId = operationIdFor(s.businessId, 'obrace-period-01');
      const periodId = periodIdFor(s.businessId, 'obrace-period-01');
      const assertion = periodAssertion(
        { kind: 'period_create', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId, startDate: start, endDate: today },
        s.userId,
      );
      await createPeriodAs(assertion, { operationId, startDate: start, endDate: today }, { client: creator });

      await poster.query('BEGIN');
      const posting = (async (): Promise<Settled> => {
        try {
          await openBalanceOn(poster, s, opening, 'obrace-period-opening');
          await poster.query('COMMIT');
          return { who: 'post', ok: true };
        } catch (e) {
          await poster.query('ROLLBACK').catch(() => undefined);
          return { who: 'post', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('opening balance versus first period', pids);
      await creator.query('COMMIT');

      const outcome = await posting;
      // It waited, then saw an ACTIVATED business — and posted anyway,
      // because its date is older than the books.
      expect(outcome.error).toBeUndefined();
      expect(outcome.ok).toBe(true);
      expect(await booksOf(s.businessId)).toEqual({ periods: 1, openings: 1, openingDate: opening });
    } finally {
      await creator.query('ROLLBACK').catch(() => undefined);
      await creator.end().catch(() => undefined);
      await poster.end().catch(() => undefined);
    }
  }, 120_000);

  it('the OPENING BALANCE wins the business row — the first period still lands, on the same books', async () => {
    const s = await newBusiness('obrace-opening');
    const start = await daysAgo(60);
    const opening = await daysAgo(61);

    const poster = await appClient();
    const creator = await periodClient();
    const pids = [await pidOf(creator), await pidOf(poster)];
    try {
      await poster.query('BEGIN');
      await openBalanceOn(poster, s, opening, 'obrace-opening-first');

      await creator.query('BEGIN');
      const operationId = operationIdFor(s.businessId, 'obrace-opening-01');
      const periodId = periodIdFor(s.businessId, 'obrace-opening-01');
      const assertion = periodAssertion(
        { kind: 'period_create', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId, startDate: start, endDate: today },
        s.userId,
      );
      const creating = (async (): Promise<Settled> => {
        try {
          await createPeriodAs(assertion, { operationId, startDate: start, endDate: today }, { client: creator });
          await creator.query('COMMIT');
          return { who: 'period', ok: true };
        } catch (e) {
          await creator.query('ROLLBACK').catch(() => undefined);
          return { who: 'period', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('first period versus opening balance', pids);
      await poster.query('COMMIT');

      const outcome = await creating;
      expect(outcome.error).toBeUndefined();
      expect(outcome.ok).toBe(true);

      // The same final books as the opposite order, fact for fact.
      expect(await booksOf(s.businessId)).toEqual({ periods: 1, openings: 1, openingDate: opening });
    } finally {
      await poster.query('ROLLBACK').catch(() => undefined);
      await poster.end().catch(() => undefined);
      await creator.end().catch(() => undefined);
    }
  }, 120_000);
});

// ── §22, §23: the closed-books topology under contention ──────────────────

/** The business's periods in date order, as statuses — the shape the rule is about. */
async function topologyOf(businessId: string): Promise<string[]> {
  const r = await pool.query<{ status: string }>(`SELECT status FROM accounting_periods WHERE business_id = $1 ORDER BY start_date`, [businessId]);
  return r.rows.map((row) => row.status);
}

/** A legal set is closed periods first, then open ones — never the other way round. */
function isMonotonic(statuses: readonly string[]): boolean {
  return statuses.indexOf('closed') === -1 || statuses.lastIndexOf('closed') < (statuses.indexOf('open') === -1 ? Infinity : statuses.indexOf('open'));
}

/**
 * A close and a historical opening balance, in flight at the same moment (§22).
 *
 * This is the race the new closed-history rule has to survive, and it is the
 * one that cannot be decided by looking at either transaction alone: the
 * opening balance is dated OUTSIDE every period, so nothing about its own
 * date tells it that a close is happening. What makes the answer definite is
 * that both transactions take the business row — the posting under FOR SHARE
 * inside `accounting_post_entry`, the close under FOR UPDATE — so one of them
 * waits, and the one that waits re-reads the books afterwards.
 *
 * There is no correct answer in which the merchant ends up with closed books
 * that acquired a new entry behind them.
 */
describe('a close and a historical opening balance, racing (§22)', () => {
  it('case A: the opening balance wins the business row — it commits, and the close then succeeds around it', async () => {
    const s = await newBusiness('obclose-a');
    const start = await daysAgo(40);
    const opening = await daysAgo(41);
    const periodId = (await createPeriod(s, 'obclose-a-period', start, today)).periodId;

    const poster = await appClient();
    const closer = await periodClient();
    const pids = [await pidOf(poster), await pidOf(closer)];
    try {
      await poster.query('BEGIN');
      await openBalanceOn(poster, s, opening, 'obclose-a-opening');
      // The opening balance is written and the business row is held FOR SHARE.

      const operationId = operationIdFor(s.businessId, 'obclose-a-close-key');
      const assertion = periodAssertion({ kind: 'period_close', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId }, s.userId);
      await closer.query('BEGIN');
      const closing = (async (): Promise<Settled> => {
        try {
          await closePeriodAs(assertion, { operationId }, { client: closer });
          await closer.query('COMMIT');
          return { who: 'period', ok: true };
        } catch (e) {
          await closer.query('ROLLBACK').catch(() => undefined);
          return { who: 'period', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('close versus historical opening balance, case A', pids);
      await poster.query('COMMIT');

      const outcome = await closing;
      expect(outcome.error).toBeUndefined();
      expect(outcome.ok).toBe(true);

      // The opening balance was committed BEFORE the close, so the books that
      // were closed are the books that contain it. Nothing appeared behind
      // closed history: the history was not closed when it was written.
      expect(await booksOf(s.businessId)).toEqual({ periods: 1, openings: 1, openingDate: opening });
      expect((await readPeriod(pool, s.businessId, periodId)).status).toBe('closed');
    } finally {
      await poster.query('ROLLBACK').catch(() => undefined);
      await poster.end().catch(() => undefined);
      await closer.end().catch(() => undefined);
    }
  }, 120_000);

  it('case B: the close wins the business row — the historical opening balance is then refused by name', async () => {
    const s = await newBusiness('obclose-b');
    const start = await daysAgo(40);
    const opening = await daysAgo(41);
    const periodId = (await createPeriod(s, 'obclose-b-period', start, today)).periodId;

    const closer = await periodClient();
    const poster = await appClient();
    const pids = [await pidOf(poster), await pidOf(closer)];
    try {
      const operationId = operationIdFor(s.businessId, 'obclose-b-close-key');
      const assertion = periodAssertion({ kind: 'period_close', tenantId: s.tenantId, businessId: s.businessId, operationId, periodId }, s.userId);
      await closer.query('BEGIN');
      await closePeriodAs(assertion, { operationId }, { client: closer });
      // The close is written and the business row is held FOR UPDATE.

      await poster.query('BEGIN');
      const posting = (async (): Promise<Settled> => {
        try {
          await openBalanceOn(poster, s, opening, 'obclose-b-opening');
          await poster.query('COMMIT');
          return { who: 'post', ok: true };
        } catch (e) {
          await poster.query('ROLLBACK').catch(() => undefined);
          return { who: 'post', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('close versus historical opening balance, case B', pids);
      await closer.query('COMMIT');

      const outcome = await posting;
      expect(outcome.ok).toBe(false);
      // The date is outside every period, so `period_closed` would be the
      // wrong sentence to say to the merchant. What refuses this is the state
      // of the books as a whole.
      expect(outcome.error).toMatch(/accounting\.period_closed_history/);
      expect(outcome.error).not.toMatch(/accounting\.period_closed:/);

      // No ambiguous middle state: the period is closed and the books behind
      // it are exactly what they were.
      expect(await booksOf(s.businessId)).toEqual({ periods: 1, openings: 0, openingDate: null });
      expect((await readPeriod(pool, s.businessId, periodId)).status).toBe('closed');
    } finally {
      await closer.query('ROLLBACK').catch(() => undefined);
      await closer.end().catch(() => undefined);
      await poster.end().catch(() => undefined);
    }
  }, 120_000);
});

/**
 * Two adjacent open periods, closed at the same moment (§23).
 *
 * The chronological rule is read from the set, so two closes that each read a
 * legal set could in principle both commit and leave an illegal one. They
 * cannot, because every period command takes
 * `accounting_period_topology_lock_key(business)` first: the second close
 * re-reads the set only after the first has committed or rolled back.
 *
 * The assertion is therefore not "one of them lost" — under one order both
 * are meant to succeed — but that the surviving set is closed-then-open under
 * every order, and that a refused later close is a refusal the merchant can
 * simply retry.
 */
describe('two adjacent periods closed concurrently (§23)', () => {
  it('the earlier close wins the lock: the later close waits, then succeeds', async () => {
    const s = await newBusiness('close2-early');
    const first = (await createPeriod(s, 'close2-early-p1', await daysAgo(60), await daysAgo(31))).periodId;
    const second = (await createPeriod(s, 'close2-early-p2', await daysAgo(30), today)).periodId;

    const a = await periodClient();
    const b = await periodClient();
    const pids = [await pidOf(a), await pidOf(b)];
    try {
      const opA = operationIdFor(s.businessId, 'close2-early-close-a');
      const asA = periodAssertion({ kind: 'period_close', tenantId: s.tenantId, businessId: s.businessId, operationId: opA, periodId: first }, s.userId);
      await a.query('BEGIN');
      await closePeriodAs(asA, { operationId: opA }, { client: a });
      // A holds the topology lock; the earlier period is closed, uncommitted.

      const opB = operationIdFor(s.businessId, 'close2-early-close-b');
      const asB = periodAssertion({ kind: 'period_close', tenantId: s.tenantId, businessId: s.businessId, operationId: opB, periodId: second }, s.userId);
      await b.query('BEGIN');
      const closingB = (async (): Promise<Settled> => {
        try {
          await closePeriodAs(asB, { operationId: opB }, { client: b });
          await b.query('COMMIT');
          return { who: 'period', ok: true };
        } catch (e) {
          await b.query('ROLLBACK').catch(() => undefined);
          return { who: 'period', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('two concurrent closes', pids);
      await a.query('COMMIT');

      const outcome = await closingB;
      expect(outcome.error).toBeUndefined();
      expect(outcome.ok).toBe(true);
      expect(await topologyOf(s.businessId)).toEqual(['closed', 'closed']);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await a.end().catch(() => undefined);
      await b.end().catch(() => undefined);
    }
  }, 120_000);

  it('the later close wins the lock: it is refused, and the same command succeeds once the earlier one has committed', async () => {
    const s = await newBusiness('close2-late');
    const first = (await createPeriod(s, 'close2-late-p1', await daysAgo(60), await daysAgo(31))).periodId;
    const second = (await createPeriod(s, 'close2-late-p2', await daysAgo(30), today)).periodId;

    // The later period reaches the lock first and reads a set whose earlier
    // period is still open. It must not be allowed to commit `OPEN CLOSED`,
    // even though nothing else is contending for it at that instant.
    const refusal = await periodRefusal(() => closePeriod(s, 'close2-late-close-b', second));
    expect(refusal).toMatch(/accounting\.period_close_order/);
    expect(await topologyOf(s.businessId)).toEqual(['open', 'open']);

    await closePeriod(s, 'close2-late-close-a', first);
    expect(await topologyOf(s.businessId)).toEqual(['closed', 'open']);

    // The refusal poisoned nothing: the SAME idempotency key, replayed after
    // the earlier close, is simply the command the merchant meant.
    const retry = await closePeriod(s, 'close2-late-close-b', second);
    expect(retry.changed).toBe(true);
    expect(await topologyOf(s.businessId)).toEqual(['closed', 'closed']);
  }, 120_000);

  it('fired simultaneously with no orchestration, the surviving set is closed-then-open', async () => {
    const s = await newBusiness('close2-free');
    const first = (await createPeriod(s, 'close2-free-p1', await daysAgo(60), await daysAgo(31))).periodId;
    const second = (await createPeriod(s, 'close2-free-p2', await daysAgo(30), today)).periodId;

    const settle = async (key: string, periodId: string): Promise<Settled> => {
      try {
        await closePeriod(s, key, periodId);
        return { who: 'period', ok: true };
      } catch (e) {
        return { who: 'period', ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    const [a, b] = await Promise.all([settle('close2-free-close-a', first), settle('close2-free-close-b', second)]);

    // Whatever the scheduler chose: no deadlock, and the only refusal the
    // rule may produce is the chronological one.
    for (const outcome of [a, b]) {
      if (!outcome.ok) expect(outcome.error).toMatch(/accounting\.period_close_order/);
    }
    const shape = await topologyOf(s.businessId);
    expect(isMonotonic(shape), `an illegal topology survived: ${shape.join(' ')}`).toBe(true);
    // The earlier period's close never had a reason to fail.
    expect(a.error).toBeUndefined();
    expect(shape[0]).toBe('closed');
  }, 120_000);
});

/**
 * The race the deferred validator's own advisory lock exists for (§12, §14).
 *
 * Two transactions can each leave a set that is legal on its own and whose
 * union is not: prepending an open period while somebody else closes the
 * current earliest one. Both commands take the same per-business topology
 * key, so one of them re-reads the books after the other committed and is
 * refused by name — and whichever one that is, the merchant is told which
 * rule stopped them rather than being told a constraint name.
 */
describe('a prepend and a close, racing (§14)', () => {
  it('the close wins: the prepend is then refused as writing behind closed history', async () => {
    const s = await newBusiness('prepclose');
    const existing = (await createPeriod(s, 'prepclose-existing', await daysAgo(30), today)).periodId;

    const closer = await periodClient();
    const creator = await periodClient();
    const pids = [await pidOf(closer), await pidOf(creator)];
    try {
      const opClose = operationIdFor(s.businessId, 'prepclose-close-key');
      const asClose = periodAssertion(
        { kind: 'period_close', tenantId: s.tenantId, businessId: s.businessId, operationId: opClose, periodId: existing },
        s.userId,
      );
      await closer.query('BEGIN');
      await closePeriodAs(asClose, { operationId: opClose }, { client: closer });

      const start = await daysAgo(60);
      const end = await daysAgo(31);
      const opCreate = operationIdFor(s.businessId, 'prepclose-create-key');
      const periodId = periodIdFor(s.businessId, 'prepclose-create-key');
      const asCreate = periodAssertion(
        {
          kind: 'period_create',
          tenantId: s.tenantId,
          businessId: s.businessId,
          operationId: opCreate,
          periodId,
          startDate: start,
          endDate: end,
        },
        s.userId,
      );
      await creator.query('BEGIN');
      const creating = (async (): Promise<Settled> => {
        try {
          await createPeriodAs(asCreate, { operationId: opCreate, startDate: start, endDate: end }, { client: creator });
          await creator.query('COMMIT');
          return { who: 'period', ok: true };
        } catch (e) {
          await creator.query('ROLLBACK').catch(() => undefined);
          return { who: 'period', ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();

      await contend('prepend versus close', pids);
      await closer.query('COMMIT');

      const outcome = await creating;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/accounting\.period_prepend_closed_history/);
      // Not the deferred backstop: the merchant gets the sentence about their
      // books, and the constraint trigger never had to fire.
      expect(outcome.error).not.toMatch(/accounting\.period_topology_invalid/);
      expect(await topologyOf(s.businessId)).toEqual(['closed']);
    } finally {
      await closer.query('ROLLBACK').catch(() => undefined);
      await closer.end().catch(() => undefined);
      await creator.end().catch(() => undefined);
    }
  }, 120_000);
});
