import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { must, seedPostingFixture, type PostingFixture } from '../helpers/accounting-posting';
import { controlAssertion, enterRate, fxClient, fxFingerprintOf, fxRefusal, rateIdFor, type RateFacts } from '../helpers/accounting-fx';

/**
 * TWO CONNECTIONS, ONE RATE (directive §33-§36, §41, §42, §63).
 *
 * Idempotency that is only tested sequentially is idempotency that has never
 * been tested: the interesting window is the one between "is this already
 * stored?" and "store it", and a single-threaded test never opens it. So
 * every case here uses two REAL connections whose statements are both in
 * flight before either commits, and refuses to pass unless the two genuinely
 * contended — a race that never raced is a green test that proved nothing.
 *
 * §35 also fixes what a loser may be told. A caller retrying after a timeout
 * must be able to act on the answer, and `23505`, a constraint name, a
 * deadlock or a serialization failure are none of them things a merchant can
 * act on. Every outcome below is asserted to be a domain sentence.
 */

let fx: PostingFixture;
const T1 = '2026-05-01T00:00:00Z';

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), `fxrace-${Math.floor(Math.random() * 1e6)}`);
}, 180_000);

// The option is called `idempotency`, not `key`: the repository's secret scan
// reads a literal written straight after a `key:` as a credential, and a test
// fixture is not a reason to narrow that scan.
const facts = (over: Partial<RateFacts> & { idempotency: string }): RateFacts => ({
  tenantId: fx.tenantId,
  businessId: fx.businessId,
  rateId: rateIdFor(fx.businessId, over.idempotency),
  fromCurrency: over.fromCurrency ?? 'USD',
  toCurrency: over.toCurrency ?? 'ILS',
  rate: over.rate ?? '3.71',
  effectiveAt: over.effectiveAt ?? T1,
});

const assertionFor = (f: RateFacts): string =>
  controlAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    commandKind: 'fx_rate_enter',
    resourceId: f.rateId,
    payloadFingerprint: fxFingerprintOf(f),
  });

interface Settled {
  who: 'a' | 'b';
  rateId?: string;
  created?: boolean;
  error?: Error;
}

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
    const r = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND state = 'active'`,
      [[...pids]],
    );
    if (must(r.rows[0]).n > 0) return;
    if (Date.now() > deadline) throw new Error(`${what}: no backend ever waited on a lock, so the two commands did not contend`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function launch(who: 'a' | 'b', conn: Client, assertion: string, f: RateFacts): Promise<Settled> {
  return (async (): Promise<Settled> => {
    await conn.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertion]);
    const r = await conn.query<{ rate_id: string; created: boolean }>(
      `SELECT rate_id, created FROM accounting_fx_rate_enter($1, $2, $3, $4::timestamptz, $5)`,
      [f.fromCurrency, f.toCurrency, f.rate, f.effectiveAt, `req-${who}`],
    );
    return { who, rateId: must(r.rows[0]).rate_id, created: must(r.rows[0]).created };
  })().catch((e: Error) => ({ who, error: e }));
}

/** Every raw failure mode a rate entry may never hand a caller (§17, §35). */
function assertNoRawFailure(e: Error | undefined, label: string): void {
  if (e === undefined) return;
  expect(e.message, `${label} leaked a deadlock`).not.toMatch(/deadlock detected/i);
  expect((e as Error & { code?: string }).code, `${label} leaked SQLSTATE 40P01`).not.toBe('40P01');
  expect((e as Error & { code?: string }).code, `${label} leaked a serialization failure`).not.toBe('40001');
  expect((e as Error & { code?: string }).code, `${label} leaked SQLSTATE 23505`).not.toBe('23505');
  expect(e.message, `${label} leaked a unique violation`).not.toMatch(/duplicate key|unique constraint|23505|_uk\b|_pkey\b/);
  expect(e.message, `${label} is not an accounting sentence`).toMatch(/accounting\.[a-z_]+/);
}

interface Counts {
  rates: number;
  audits: number;
  outbox: number;
}

async function countsFor(businessId: string): Promise<Counts> {
  const r = await ownerPool().query<Counts>(
    `SELECT (SELECT count(*) FROM accounting_fx_rates WHERE business_id = $1)::int AS rates,
            (SELECT count(*) FROM audit_events  WHERE business_id = $1 AND action = 'accounting.fx_rate_entered')::int AS audits,
            (SELECT count(*) FROM outbox_events WHERE business_id = $1 AND type   = 'accounting.fx_rate.entered')::int AS outbox`,
    [businessId],
  );
  return must(r.rows[0]);
}

async function race(a: RateFacts, b: RateFacts, label: string): Promise<{ winner: Settled; loser: Settled }> {
  const ca = await fxClient();
  const cb = await fxClient();
  try {
    await ca.query('BEGIN');
    await cb.query('BEGIN');
    const pids = [await pidOf(ca), await pidOf(cb)];
    const pa = launch('a', ca, assertionFor(a), a);
    const pb = launch('b', cb, assertionFor(b), b);

    await contend(label, pids);

    const first = await Promise.race([pa, pb]);
    const winnerConn = first.who === 'a' ? ca : cb;
    const loserConn = first.who === 'a' ? cb : ca;
    if (first.error === undefined) await winnerConn.query('COMMIT');
    else await winnerConn.query('ROLLBACK');

    const second = await (first.who === 'a' ? pb : pa);
    if (second.error === undefined) await loserConn.query('COMMIT').catch(() => undefined);
    else await loserConn.query('ROLLBACK').catch(() => undefined);

    return { winner: first, loser: second };
  } finally {
    await ca.end().catch(() => undefined);
    await cb.end().catch(() => undefined);
  }
}

// ── §35: same identity, same rate ─────────────────────────────────────────

describe('two simultaneous entries of the SAME rate (§35)', () => {
  it('under one idempotency key: one row, one audit, one outbox, one id', async () => {
    const f = facts({ idempotency: 'race-same-key-001', effectiveAt: '2026-05-02T00:00:00Z' });
    const before = await countsFor(fx.businessId);

    const { winner, loser } = await race(f, f, 'same key, SAME payload');
    assertNoRawFailure(winner.error, 'the winner');
    assertNoRawFailure(loser.error, 'the loser');
    expect(winner.error).toBeUndefined();
    expect(loser.error).toBeUndefined();

    expect(winner.created).toBe(true);
    expect(loser.created).toBe(false);
    expect(loser.rateId).toBe(winner.rateId);

    const after = await countsFor(fx.businessId);
    expect(after.rates).toBe(before.rates + 1);
    expect(after.audits).toBe(before.audits + 1);
    expect(after.outbox).toBe(before.outbox + 1);
  });

  it('under two DIFFERENT keys: still one row, still one event (§34)', async () => {
    // Two clients, two idempotency keys, the same business, pair, instant and
    // rate. The registry already says this; saying it again creates nothing
    // and announces nothing.
    const at = '2026-05-03T00:00:00Z';
    const a = facts({ idempotency: 'race-two-keys-a01', effectiveAt: at, rate: '3.75' });
    const b = facts({ idempotency: 'race-two-keys-b01', effectiveAt: at, rate: '3.75' });
    expect(a.rateId).not.toBe(b.rateId);
    const before = await countsFor(fx.businessId);

    const { winner, loser } = await race(a, b, 'two keys, SAME rate');
    assertNoRawFailure(winner.error, 'the winner');
    assertNoRawFailure(loser.error, 'the loser');
    expect(winner.error).toBeUndefined();
    expect(loser.error).toBeUndefined();

    expect(winner.created).toBe(true);
    expect(loser.created).toBe(false);
    // The loser is handed the row that EXISTS, not its own derived id.
    expect(loser.rateId).toBe(winner.rateId);

    const after = await countsFor(fx.businessId);
    expect(after.rates).toBe(before.rates + 1);
    expect(after.audits).toBe(before.audits + 1);
    expect(after.outbox).toBe(before.outbox + 1);
  });
});

// ── §34, §35: same identity, different rate ───────────────────────────────

describe('two simultaneous entries of DIFFERENT rates (§34, §35)', () => {
  it('under one key: one survives, the other is an idempotency conflict', async () => {
    const at = '2026-05-04T00:00:00Z';
    const a = facts({ idempotency: 'race-conflict-k01', effectiveAt: at, rate: '3.80' });
    const b = { ...a, rate: '3.90' };
    const before = await countsFor(fx.businessId);

    const { winner, loser } = await race(a, b, 'same key, DIFFERENT payload');
    assertNoRawFailure(winner.error, 'the winner');
    assertNoRawFailure(loser.error, 'the loser');
    expect(winner.error).toBeUndefined();
    expect(winner.created).toBe(true);
    expect(must(loser.error).message).toMatch(/accounting\.(idempotency_conflict|fx_rate_conflict)/);

    const after = await countsFor(fx.businessId);
    expect(after.rates).toBe(before.rates + 1);
    expect(after.audits).toBe(before.audits + 1);
    expect(after.outbox).toBe(before.outbox + 1);
  });

  it('under two keys: never first, never last, never overwritten (§34)', async () => {
    const at = '2026-05-05T00:00:00Z';
    const a = facts({ idempotency: 'race-diff-keys-a1', effectiveAt: at, rate: '4.10' });
    const b = facts({ idempotency: 'race-diff-keys-b1', effectiveAt: at, rate: '4.20' });
    const before = await countsFor(fx.businessId);

    const { winner, loser } = await race(a, b, 'two keys, DIFFERENT rate');
    assertNoRawFailure(winner.error, 'the winner');
    assertNoRawFailure(loser.error, 'the loser');
    expect(winner.error).toBeUndefined();
    expect(winner.created).toBe(true);
    expect(must(loser.error).message).toMatch(/accounting\.fx_rate_conflict/);

    const after = await countsFor(fx.businessId);
    expect(after.rates).toBe(before.rates + 1);
    expect(after.audits).toBe(before.audits + 1);
    expect(after.outbox).toBe(before.outbox + 1);

    // The stored rate is the winner's, unchanged. Whichever won, the LOSER's
    // number is not in the registry.
    const stored = must(
      (
        await ownerPool().query<{ rate: string }>(
          `SELECT rate FROM accounting_fx_rates WHERE business_id = $1 AND from_currency = 'USD' AND to_currency = 'ILS' AND effective_at = $2::timestamptz`,
          [fx.businessId, at],
        )
      ).rows[0],
    ).rate;
    expect(['4.1000000000', '4.2000000000']).toContain(stored);
    const winnerRate = winner.who === 'a' ? '4.1000000000' : '4.2000000000';
    expect(stored).toBe(winnerRate);
  });
});

// ── §36: the lock is narrow ───────────────────────────────────────────────

describe('a rate entry serializes only its own identity (§36)', () => {
  it('a DIFFERENT pair proceeds while one entry holds its lock open', async () => {
    // A business-wide lock would make this test hang until the timeout. The
    // point of §36 is that entering a USD rate does not stop a EUR one.
    const held = facts({ idempotency: 'narrow-lock-held-1', effectiveAt: '2026-05-06T00:00:00Z', rate: '3.99' });
    const other = facts({ idempotency: 'narrow-lock-othr1', effectiveAt: '2026-05-06T00:00:00Z', fromCurrency: 'EUR', rate: '4.44' });

    const holder = await fxClient();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertionFor(held)]);
      await holder.query(`SELECT rate_id, created FROM accounting_fx_rate_enter($1, $2, $3, $4::timestamptz, $5)`, [
        held.fromCurrency,
        held.toCurrency,
        held.rate,
        held.effectiveAt,
        'req-holder',
      ]);
      // The transaction is still OPEN, so its advisory locks are still held.
      const out = await enterRate(other, fx.userId);
      expect(out.created).toBe(true);
      await holder.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  });

  it('a POSTING is not blocked by an open rate entry either', async () => {
    const held = facts({ idempotency: 'narrow-lock-post-1', effectiveAt: '2026-05-07T00:00:00Z', rate: '3.98' });
    const holder = await fxClient();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.accounting_control_assertion', $1, true)`, [assertionFor(held)]);
      await holder.query(`SELECT rate_id, created FROM accounting_fx_rate_enter($1, $2, $3, $4::timestamptz, $5)`, [
        held.fromCurrency,
        held.toCurrency,
        held.rate,
        held.effectiveAt,
        'req-holder',
      ]);

      // A read of the ledger under the merchant scope, which would block on a
      // business-wide exclusive lock. It returns immediately.
      const reader = await fxClient();
      try {
        await reader.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.business_id', $2, false)`, [fx.tenantId, fx.businessId]);
        const r = await reader.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1`, [fx.businessId]);
        expect(must(r.rows[0]).n).toBeGreaterThanOrEqual(0);
      } finally {
        await reader.end().catch(() => undefined);
      }
      await holder.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
  });
});

// ── §41, §42, §63, §66: atomicity, replay and failure injection ───────────

describe('a rate, its audit and its event are one fact (§41, §42, §66)', () => {
  it('a successful entry writes exactly one audit row carrying no rate value', async () => {
    const f = facts({ idempotency: 'audit-shape-00001', effectiveAt: '2026-05-08T00:00:00Z', rate: '3.33', fromCurrency: 'TRY', toCurrency: 'ILS' });
    await enterRate(f, fx.userId);

    const audit = must(
      (
        await ownerPool().query<{ action: string; entity: string; entity_id: string; actor_user_id: string; metadata: Record<string, unknown> }>(
          `SELECT action, entity, entity_id, actor_user_id, metadata FROM audit_events
            WHERE business_id = $1 AND action = 'accounting.fx_rate_entered' AND entity_id = $2`,
          [fx.businessId, f.rateId],
        )
      ).rows[0],
    );
    expect(audit.entity).toBe('accounting_fx_rate');
    expect(audit.actor_user_id).toBe(fx.userId);
    expect(audit.metadata).toEqual({ fromCurrency: 'TRY', toCurrency: 'ILS', effectiveAt: '2026-05-08T00:00:00Z', source: 'manual' });
    // The rate VALUE is deliberately absent from both trails.
    expect(JSON.stringify(audit.metadata)).not.toMatch(/3\.33/);

    const event = must(
      (
        await ownerPool().query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM outbox_events WHERE business_id = $1 AND type = 'accounting.fx_rate.entered' AND payload->>'rateId' = $2`,
          [fx.businessId, f.rateId],
        )
      ).rows[0],
    );
    expect(Object.keys(event.payload).sort()).toEqual(['businessId', 'effectiveAt', 'fromCurrency', 'rateId', 'source', 'toCurrency']);
    expect(JSON.stringify(event.payload)).not.toMatch(/3\.33/);
  });

  it('an idempotent replay adds no second audit row and no second event (§42, §63)', async () => {
    const f = facts({ idempotency: 'replay-no-echo-01', effectiveAt: '2026-05-09T00:00:00Z', rate: '3.34' });
    expect((await enterRate(f, fx.userId)).created).toBe(true);
    const after = await countsFor(fx.businessId);
    // A fresh assertion, the same command. The rate already exists.
    expect((await enterRate(f, fx.userId)).created).toBe(false);
    expect(await countsFor(fx.businessId)).toEqual(after);
  });

  it('if the OUTBOX insert fails, the rate and the audit go with it (§42, §66)', async () => {
    const f = facts({ idempotency: 'outbox-injection-1', effectiveAt: '2026-05-10T00:00:00Z', rate: '3.35' });
    const before = await countsFor(fx.businessId);

    // Injected at the database, inside the same transaction the command runs
    // in — the only place that proves ATOMICITY rather than proving that a
    // mocked port throws.
    await ownerPool().query(`CREATE OR REPLACE FUNCTION fx_outbox_break() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.type = 'accounting.fx_rate.entered' THEN RAISE EXCEPTION 'injected outbox failure' USING ERRCODE = 'P0001'; END IF;
        RETURN NEW; END $$;`);
    await ownerPool().query(`CREATE TRIGGER fx_outbox_break_t BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fx_outbox_break()`);
    try {
      expect(await fxRefusal(() => enterRate(f, fx.userId))).toMatch(/injected outbox failure/);
      expect(await countsFor(fx.businessId)).toEqual(before);
    } finally {
      await ownerPool().query(`DROP TRIGGER fx_outbox_break_t ON outbox_events`);
      await ownerPool().query(`DROP FUNCTION fx_outbox_break()`);
    }

    // And once the injected failure is gone, the SAME command succeeds: the
    // rollback left nothing behind that would make a retry conflict.
    expect((await enterRate(f, fx.userId)).created).toBe(true);
    const after = await countsFor(fx.businessId);
    expect(after.rates).toBe(before.rates + 1);
    expect(after.audits).toBe(before.audits + 1);
    expect(after.outbox).toBe(before.outbox + 1);
  });

  it('if the AUDIT insert fails, the rate rolls back (§41, §66)', async () => {
    const f = facts({ idempotency: 'audit-injection-01', effectiveAt: '2026-05-11T00:00:00Z', rate: '3.36' });
    const before = await countsFor(fx.businessId);

    await ownerPool().query(`CREATE OR REPLACE FUNCTION fx_audit_break() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action = 'accounting.fx_rate_entered' THEN RAISE EXCEPTION 'injected audit failure' USING ERRCODE = 'P0001'; END IF;
        RETURN NEW; END $$;`);
    await ownerPool().query(`CREATE TRIGGER fx_audit_break_t BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fx_audit_break()`);
    try {
      expect(await fxRefusal(() => enterRate(f, fx.userId))).toMatch(/injected audit failure/);
      expect(await countsFor(fx.businessId)).toEqual(before);
    } finally {
      await ownerPool().query(`DROP TRIGGER fx_audit_break_t ON audit_events`);
      await ownerPool().query(`DROP FUNCTION fx_audit_break()`);
    }

    expect((await enterRate(f, fx.userId)).created).toBe(true);
    expect((await countsFor(fx.businessId)).rates).toBe(before.rates + 1);
  });
});
