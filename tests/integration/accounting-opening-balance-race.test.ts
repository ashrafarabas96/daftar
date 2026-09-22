import { randomUUID } from 'node:crypto';
import { deriveSourceId } from '@daftar/accounting';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  appClient,
  fingerprintOf,
  must,
  openingBalanceFingerprintOf,
  positionPayload,
  postAdjustmentAs,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostLine,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * MATRIX — THE OPENING BALANCE UNDER GENUINE CONTENTION (round three, §9-§17).
 *
 * A concurrency test is not concurrent because it owns two connections.
 *
 * The earlier opening-balance case awaited the whole of connection A's
 * command, then issued B's, then committed A. Everything A could lock, A had
 * already locked before B existed, so what the test proved was that a
 * transaction blocks behind a finished statement. The race it claimed to be
 * about — two workflows inside `accounting_open_balance_draft` and
 * `accounting_open_balance_post` at the same moment — never happened.
 *
 * Every case here launches BOTH commands before either transaction commits,
 * and then refuses to proceed until PostgreSQL itself reports a backend
 * waiting on a lock. That wait is the barrier and it is also the evidence:
 * if the two commands did not contend, `contend()` fails the test rather than
 * letting it pass for the wrong reason.
 *
 * Two rules apply throughout:
 *
 *   A raw failure is a failure. `deadlock detected` (SQLSTATE 40P01), a
 *   serialization failure, a statement timeout, a duplicate key or an index
 *   name in a message are all defects here, never acceptable outcomes. The
 *   workflow owes the caller an accounting sentence.
 *
 *   Nothing may be orphaned. A loser's draft, positions and journal attempt
 *   go with its transaction, whatever it was refused for.
 */

let today: string;

const AT = new Date('2026-03-14T09:15:00Z');

const position = (systemKey: string, side: 'D' | 'C', amount: bigint): PostLine => ({
  account: { kind: 'system', systemKey },
  side,
  baseAmountMinor: amount,
  baseCurrency: 'ILS',
  txnAmountMinor: amount,
  txnCurrency: 'ILS',
  fxRate: '1',
  fxRateSource: 'base',
  fxRateAt: AT,
  memo: null,
});

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  today = await todayIn(ownerPool(), 'Asia/Hebron');
}, 180_000);

async function fresh(tag: string): Promise<PostingFixture> {
  return seedPostingFixture(ownerPool(), `ob-race-${tag}-${Math.floor(Math.random() * 1e6)}`);
}

function openingAssertion(fx: PostingFixture, openingBalanceId: string, positions: readonly PostLine[]): string {
  return sourceAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    operationKind: 'post',
    sourceType: 'opening_balance',
    sourceId: openingBalanceId,
    postingFingerprint: openingBalanceFingerprintOf({
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      openingBalanceId,
      asOfDate: today,
      baseCurrency: 'ILS',
      positions,
    }),
  });
}

/**
 * Block until the server reports a backend waiting on a lock.
 *
 * This is the start barrier §14 asks for, expressed as a fact about the
 * database rather than as a sleep. It is also the assertion that the test is
 * a race at all: when nothing ever waits, the two commands never met, and
 * saying so loudly is better than a green test that proved nothing.
 */
async function contend(what: string, pids: readonly number[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Scoped to THESE two backends. `pg_stat_activity` is cluster-wide and
    // the suites run in parallel, so a barrier that accepted any waiting
    // backend would occasionally be released by somebody else's lock and let
    // the race proceed before it was a race.
    const r = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND state = 'active'`,
      [[...pids]],
    );
    if (must(r.rows[0]).n > 0) return;
    if (Date.now() > deadline) throw new Error(`${what}: no backend ever waited on a lock, so the two commands did not contend`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The backend serving a connection, so the barrier can watch exactly it. */
async function pidOf(conn: { query: (sql: string) => Promise<{ rows: { pid: number }[] }> }): Promise<number> {
  const r = await conn.query('SELECT pg_backend_pid()::int AS pid');
  return must(r.rows[0], 'a backend pid').pid;
}

interface Settled {
  who: 'a' | 'b';
  entryId?: string;
  created?: boolean;
  error?: Error;
}

/** Launch one opening-balance command on an already-open transaction. */
function launch(
  who: 'a' | 'b',
  conn: Client,
  assertion: string,
  input: { openingBalanceId: string; positions: readonly PostLine[]; requestId: string },
): Promise<Settled> {
  return (async (): Promise<Settled> => {
    await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
    await conn.query(`SELECT accounting_open_balance_draft($1::date, $2::jsonb)`, [today, JSON.stringify(positionPayload(input.positions))]);
    const r = await conn.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_open_balance_post($1::uuid, $2, $3)`, [
      input.openingBalanceId,
      null,
      input.requestId,
    ]);
    return { who, entryId: must(r.rows[0]).entry_id, created: must(r.rows[0]).created };
  })().catch((e: Error) => ({ who, error: e }));
}

/** Every raw failure mode the workflow may never hand a caller (§16). */
function assertNoRawFailure(e: Error | undefined, label: string): void {
  if (e === undefined) return;
  expect(e.message, `${label} leaked a deadlock`).not.toMatch(/deadlock detected/i);
  expect((e as Error & { code?: string }).code, `${label} leaked SQLSTATE 40P01`).not.toBe('40P01');
  expect((e as Error & { code?: string }).code, `${label} leaked a serialization failure`).not.toBe('40001');
  expect((e as Error & { code?: string }).code, `${label} leaked a statement timeout`).not.toBe('57014');
  expect(e.message, `${label} leaked a unique violation`).not.toMatch(/duplicate key|unique constraint|23505|_uq\b|_pkey\b/);
  expect(e.message, `${label} is not an accounting sentence`).toMatch(/accounting\.[a-z_]+/);
}

interface Ledger {
  posted: number;
  sets: number;
  entries: number;
  positions: number;
  bindings: number;
  audits: number;
  outbox: number;
}

async function ledgerOf(businessId: string): Promise<Ledger> {
  const r = await ownerPool().query<Ledger>(
    `SELECT (SELECT count(*) FROM accounting_opening_balances      WHERE business_id = $1 AND status = 'posted')::int AS posted,
            (SELECT count(*) FROM accounting_opening_balances      WHERE business_id = $1)::int AS sets,
            (SELECT count(*) FROM journal_entries                  WHERE business_id = $1)::int AS entries,
            (SELECT count(*) FROM accounting_opening_balance_lines WHERE business_id = $1)::int AS positions,
            (SELECT count(*) FROM accounting_source_bindings       WHERE business_id = $1)::int AS bindings,
            (SELECT count(*) FROM audit_events  WHERE business_id = $1 AND action LIKE 'accounting.opening_balance%')::int AS audits,
            (SELECT count(*) FROM outbox_events WHERE business_id = $1 AND type   LIKE 'accounting.opening_balance%')::int AS outbox`,
    [businessId],
  );
  return must(r.rows[0]);
}

/**
 * Run two opening-balance commands that genuinely overlap.
 *
 * Both transactions are open and both statements are in flight before either
 * commits. `Promise.race` names the one that got through; its COMMIT is what
 * releases the other, which is then awaited and rolled back if it failed.
 */
async function race(
  a: { assertion: string; openingBalanceId: string; positions: readonly PostLine[] },
  b: { assertion: string; openingBalanceId: string; positions: readonly PostLine[] },
  label: string,
): Promise<{ winner: Settled; loser: Settled }> {
  const ca = await appClient();
  const cb = await appClient();
  try {
    await ca.query('BEGIN');
    await cb.query('BEGIN');
    const pids = [await pidOf(ca), await pidOf(cb)];
    const pa = launch('a', ca, a.assertion, { ...a, requestId: 'req-a' });
    const pb = launch('b', cb, b.assertion, { ...b, requestId: 'req-b' });

    await contend(label, pids);

    const first = await Promise.race([pa, pb]);
    const winnerConn = first.who === 'a' ? ca : cb;
    const loserConn = first.who === 'a' ? cb : ca;
    // The winner is only a winner once its transaction is true.
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

// ── CASE A — same key, same payload (§15) ─────────────────────────────────

describe('CASE A — the same idempotency key and the same positions, at the same moment', () => {
  it('one financial truth: one created=true, one created=false, one of everything', async () => {
    const fx = await fresh('same');
    // One transport key, so BOTH requests derive the SAME source identity.
    // This is the shape the API actually produces, and it is the shape that
    // used to race on the draft's primary key.
    const id = deriveSourceId(fx.businessId, 'idem-the-one-key');
    const positions = [position('cash', 'D', 50000n)];

    const { winner, loser } = await race(
      { assertion: openingAssertion(fx, id, positions), openingBalanceId: id, positions },
      { assertion: openingAssertion(fx, id, positions), openingBalanceId: id, positions },
      'CASE A',
    );

    assertNoRawFailure(winner.error, 'the winner');
    assertNoRawFailure(loser.error, 'the loser');
    expect(winner.error).toBeUndefined();
    expect(loser.error).toBeUndefined();
    expect(winner.created).toBe(true);
    expect(loser.created).toBe(false);
    expect(loser.entryId).toBe(winner.entryId);

    expect(await ledgerOf(fx.businessId)).toEqual({
      posted: 1,
      sets: 1,
      entries: 1,
      positions: positions.length,
      bindings: 1,
      audits: 1,
      outbox: 1,
    });
  });
});

// ── CASE B — same key, different payload (§15) ────────────────────────────

describe('CASE B — the same idempotency key, materially different money, at the same moment', () => {
  it('one truth survives, the loser is told the key already describes something else, and the winner is untouched', async () => {
    const fx = await fresh('conflict');
    const id = deriveSourceId(fx.businessId, 'idem-one-key-two-facts');
    const mine = [position('cash', 'D', 50000n)];
    const theirs = [position('cash', 'D', 90000n)];

    const { winner, loser } = await race(
      { assertion: openingAssertion(fx, id, mine), openingBalanceId: id, positions: mine },
      { assertion: openingAssertion(fx, id, theirs), openingBalanceId: id, positions: theirs },
      'CASE B',
    );

    expect(winner.error).toBeUndefined();
    assertNoRawFailure(loser.error, 'the loser');
    expect(must(loser.error, 'a refusal').message).toMatch(/accounting\.idempotency_conflict/);

    const state = await ledgerOf(fx.businessId);
    expect(state.posted).toBe(1);
    expect(state.sets).toBe(1);
    expect(state.entries).toBe(1);
    expect(state.positions).toBe(1);

    // The winner's position is the one on file. A conflicting retry does not
    // edit the money it lost to. WHICH of the two won is the lock manager's
    // business, so the expectation is read from the outcome rather than
    // written down — a test that named one of them in advance would be a
    // coin flip dressed as an assertion.
    const expected = winner.who === 'a' ? '50000' : '90000';
    const amount = await ownerPool().query<{ base_amount_minor: string }>(
      `SELECT base_amount_minor FROM accounting_opening_balance_lines WHERE business_id = $1`,
      [fx.businessId],
    );
    expect(must(amount.rows[0]).base_amount_minor).toBe(expected);
  });
});

// ── CASE C — different keys, one business (§15) ───────────────────────────

describe('CASE C — two different opening balances of one business, at the same moment', () => {
  it('one posts, the other is refused by name, and the loser leaves no draft behind', async () => {
    const fx = await fresh('two');
    const mine = [position('cash', 'D', 50000n)];
    const theirs = [position('cash', 'D', 90000n)];
    const idA = randomUUID();
    const idB = randomUUID();

    const { winner, loser } = await race(
      { assertion: openingAssertion(fx, idA, mine), openingBalanceId: idA, positions: mine },
      { assertion: openingAssertion(fx, idB, theirs), openingBalanceId: idB, positions: theirs },
      'CASE C',
    );

    expect(winner.error).toBeUndefined();
    assertNoRawFailure(loser.error, 'the loser');
    expect(must(loser.error, 'a refusal').message).toMatch(/accounting\.opening_balance_exists/);

    // No orphan draft: the loser's set and positions went with its rollback.
    expect(await ledgerOf(fx.businessId)).toEqual({
      posted: 1,
      sets: 1,
      entries: 1,
      positions: 1,
      bindings: 1,
      audits: 1,
      outbox: 1,
    });
  });
});

// ── CASE D — an opening balance and a first ordinary posting (§15) ────────

describe('CASE D — an opening balance and the business’s first manual adjustment, at the same moment', () => {
  it('both commit, neither deadlocks, and the business snapshot stays coherent', async () => {
    const fx = await fresh('first');
    const positions = [position('cash', 'D', 50000n)];
    const id = randomUUID();
    const adjSourceId = randomUUID();
    const adjustment = simpleCommand(fx, adjSourceId, today, 150000n);
    const adjAssertion = sourceAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      operationKind: 'post',
      sourceType: 'manual_adjustment',
      sourceId: adjSourceId,
      postingFingerprint: fingerprintOf(adjustment),
    });

    const ca = await appClient();
    const cb = await appClient();
    try {
      await ca.query('BEGIN');
      await cb.query('BEGIN');
      const pids = [await pidOf(ca), await pidOf(cb)];
      // Both of these want the business row: the opening balance takes it
      // FOR UPDATE after its own lock, and `accounting_post_entry` takes it
      // FOR UPDATE because this would be the first financial activity. One
      // waits for the other. Neither may wait for BOTH.
      const ob = launch('a', ca, openingAssertion(fx, id, positions), { openingBalanceId: id, positions, requestId: 'req-ob' });
      const adj = postAdjustmentAs(adjAssertion, adjustment, 'the first correction', cb).catch((e: Error) => e);

      await contend('CASE D', pids);

      const first = await Promise.race([ob, adj]);
      const obFirst = typeof first === 'object' && first !== null && 'who' in first;
      await (obFirst ? ca : cb).query('COMMIT');
      const second = await (obFirst ? adj : ob);
      await (obFirst ? cb : ca).query('COMMIT');

      for (const outcome of [first, second]) {
        const err = outcome instanceof Error ? outcome : 'error' in (outcome as Settled) ? (outcome as Settled).error : undefined;
        assertNoRawFailure(err, 'a command in CASE D');
        expect(err, 'a command in CASE D was refused').toBeUndefined();
      }

      // Two entries, one business, one coherent snapshot.
      const state = await ownerPool().query<{ entries: number; currencies: number; started: string | null; base: string }>(
        `SELECT (SELECT count(*) FROM journal_entries WHERE business_id = $1)::int AS entries,
                (SELECT count(DISTINCT base_currency) FROM journal_lines WHERE business_id = $1)::int AS currencies,
                b.financial_started_at::text AS started, b.base_currency AS base
         FROM businesses b WHERE b.id = $1`,
        [fx.businessId],
      );
      const row = must(state.rows[0]);
      expect(row.entries).toBe(2);
      expect(row.currencies).toBe(1);
      expect(row.base).toBe('ILS');
      // The first financial activity happened, once, and is recorded.
      expect(row.started).not.toBeNull();
    } finally {
      await ca.end().catch(() => undefined);
      await cb.end().catch(() => undefined);
    }
  });
});

// ── CASE E / F — against the business settings P2-S3 already serializes ───

describe('CASE E and F — an opening balance against a change to the business itself', () => {
  it('a concurrent base-currency change never deadlocks, and the entry matches the currency on file', async () => {
    const fx = await fresh('ccy');
    const positions = [position('cash', 'D', 50000n)];
    const id = randomUUID();

    const ca = await appClient();
    const owner = await ownerPool().connect();
    try {
      await ca.query('BEGIN');
      await owner.query('BEGIN');
      const pids = [await pidOf(ca), await pidOf(owner)];
      const ob = launch('a', ca, openingAssertion(fx, id, positions), { openingBalanceId: id, positions, requestId: 'req-ob' });
      const change = owner.query(`UPDATE businesses SET base_currency = 'JOD' WHERE id = $1`, [fx.businessId]).then(
        () => null,
        (e: Error) => e,
      );

      await contend('CASE E', pids);

      const first = await Promise.race([ob, change]);
      const obWon = first !== null && typeof first === 'object' && 'who' in (first as object);
      if (obWon) {
        await ca.query('COMMIT');
        const after = await change;
        // P2-S3 froze the base currency at the first financial activity, so
        // the change is REFUSED rather than racing the posting. That refusal
        // is the accepted semantics, not a concurrency failure.
        assertNoRawFailure(after instanceof Error ? after : undefined, 'the currency change');
        await owner.query(after instanceof Error ? 'ROLLBACK' : 'COMMIT').catch(() => undefined);
      } else {
        await owner.query('COMMIT');
        const after = await ob;
        assertNoRawFailure(after.error, 'the opening balance');
        await ca.query(after.error === undefined ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
      }

      const row = must(
        (
          await ownerPool().query<{ base: string; mismatched: number }>(
            `SELECT b.base_currency AS base,
                    (SELECT count(*) FROM journal_lines l WHERE l.business_id = b.id AND l.base_currency <> b.base_currency)::int AS mismatched
             FROM businesses b WHERE b.id = $1`,
            [fx.businessId],
          )
        ).rows[0],
      );
      // Whichever went first, the ledger and the business agree afterwards.
      expect(row.mismatched).toBe(0);
    } finally {
      await ca.end().catch(() => undefined);
      owner.release();
    }
  });

  it('a concurrent timezone change never deadlocks, and the entry keeps one business date', async () => {
    const fx = await fresh('tz');
    const positions = [position('cash', 'D', 50000n)];
    const id = randomUUID();

    const ca = await appClient();
    const owner = await ownerPool().connect();
    try {
      await ca.query('BEGIN');
      await owner.query('BEGIN');
      const pids = [await pidOf(ca), await pidOf(owner)];
      const ob = launch('a', ca, openingAssertion(fx, id, positions), { openingBalanceId: id, positions, requestId: 'req-ob' });
      const change = owner.query(`UPDATE businesses SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [fx.businessId]).then(
        () => null,
        (e: Error) => e,
      );

      await contend('CASE F', pids);

      const first = await Promise.race([ob, change]);
      const obWon = first !== null && typeof first === 'object' && 'who' in (first as object);
      if (obWon) {
        await ca.query('COMMIT');
        await change;
        await owner.query('COMMIT').catch(() => undefined);
      } else {
        await owner.query('COMMIT');
        const after = await ob;
        assertNoRawFailure(after.error, 'the opening balance');
        await ca.query(after.error === undefined ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
      }

      // One entry, one date, whichever order the two took. The as-of date the
      // draft persisted is the date the entry carries: a timezone change
      // landing mid-command may not retro-date the position.
      const rows = await ownerPool().query<{ entry_date: string; as_of: string }>(
        `SELECT je.entry_date::text AS entry_date, ob.as_of_date::text AS as_of
         FROM accounting_opening_balances ob JOIN journal_entries je ON je.id = ob.journal_entry_id
         WHERE ob.business_id = $1`,
        [fx.businessId],
      );
      for (const r of rows.rows) expect(r.entry_date).toBe(r.as_of);
    } finally {
      await ca.end().catch(() => undefined);
      owner.release();
    }
  });
});
