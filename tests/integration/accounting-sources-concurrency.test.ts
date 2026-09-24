import { randomUUID } from 'node:crypto';
import { deriveSourceId } from '@daftar/accounting';
import type { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  appClient,
  must,
  openingBalanceFingerprintOf,
  post,
  postOpeningBalanceAs,
  postReversalAs,
  positionPayload,
  reversalFingerprintOf,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostLine,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * MATRIX — P2-S4 SOURCE CONCURRENCY AND ATOMICITY (directive §41, §43, §44).
 *
 * Same discipline as MATRIX 5: TWO REAL CONNECTIONS, interleaved explicitly.
 * A concurrency proof that fires two promises and trusts the scheduler proves
 * whichever order it happened to get; each case here opens both transactions,
 * lets the one that must win take its lock, issues the second command while
 * the first still holds it, and only then commits.
 *
 * The atomicity cases inject failure through the ordinary boundary — a
 * refused command, a rolled-back transaction — and never through a production
 * failpoint, because a failpoint is a code path that exists only to be
 * triggered and is therefore a bypass with a friendly name (§44).
 */

let fx: PostingFixture;
let today: string;

const AT = new Date('2026-03-14T09:15:00Z');

async function closeAll(...clients: Client[]): Promise<void> {
  for (const c of clients) await c.end().catch(() => undefined);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'src-conc');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
});

const adjustment = (): PostCommand => simpleCommand(fx, randomUUID(), today, 150000n, 'manual_adjustment');

const reversalAssertion = (c: PostCommand, entryId: string): string =>
  sourceAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    operationKind: 'reverse',
    sourceType: 'reversal',
    sourceId: entryId,
    postingFingerprint: reversalFingerprintOf(c, entryId, today),
  });

// ── §41 double reversal ───────────────────────────────────────────────────

describe('two simultaneous reversals of one entry (§41)', () => {
  it('one reversal entry, one detail row, one audit event, one outbox event — and no raw unique violation', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    // Two independently minted assertions over one identical mirror: same
    // fingerprint, different replay ids. Replay protection must not turn a
    // legitimate concurrent retry into a failure.
    const first = reversalAssertion(c, original.entryId);
    const second = reversalAssertion(c, original.entryId);
    expect(first).not.toBe(second);

    const a = await appClient();
    const d = await appClient();
    try {
      await a.query('BEGIN');
      await d.query('BEGIN');
      // A takes the per-original advisory lock and writes its reversal.
      const ra = await postReversalAs(first, original.entryId, today, 'the only correction', 'req-a', a);
      // D issues the identical command while A still holds the lock. It must
      // block on A rather than write a second reversal or deadlock.
      const pending = postReversalAs(second, original.entryId, today, 'the only correction', 'req-d', d).catch((e) => e as Error);
      await a.query('COMMIT');
      const rd = await pending;
      await d.query('COMMIT');

      expect(rd).not.toBeInstanceOf(Error);
      const loser = rd as { entryId: string; created: boolean };
      expect(ra.created).toBe(true);
      expect(loser.created).toBe(false);
      expect(loser.entryId).toBe(ra.entryId);

      const counts = must(
        (
          await ownerPool().query<{ reversals: number; entries: number; bindings: number; audits: number; outbox: number }>(
            `SELECT (SELECT count(*) FROM accounting_reversals WHERE business_id = $1 AND original_entry_id = $2)::int AS reversals,
                    (SELECT count(*) FROM journal_entries WHERE business_id = $1 AND source_type = 'reversal' AND source_id = $2)::int AS entries,
                    (SELECT count(*) FROM accounting_source_bindings WHERE business_id = $1 AND source_type = 'reversal' AND source_id = $2)::int AS bindings,
                    (SELECT count(*) FROM audit_events WHERE business_id = $1 AND action = 'accounting.entry_reversed' AND entity_id = $3)::int AS audits,
                    (SELECT count(*) FROM outbox_events WHERE business_id = $1 AND type = 'accounting.entry.reversed' AND payload->>'entryId' = $3)::int AS outbox`,
            [fx.businessId, original.entryId, ra.entryId],
          )
        ).rows[0],
      );
      expect(counts).toEqual({ reversals: 1, entries: 1, bindings: 1, audits: 1, outbox: 1 });
    } finally {
      await closeAll(a, d);
    }
  });

  it('a concurrent DIFFERENT reversal loses by name, never by index (§14)', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    const a = await appClient();
    const d = await appClient();
    try {
      await a.query('BEGIN');
      await d.query('BEGIN');
      await postReversalAs(reversalAssertion(c, original.entryId), original.entryId, today, 'the first reason', 'req-a', a);
      // A different reason is a different fact, so this is genuinely a
      // SECOND reversal rather than a retry.
      const pending = postReversalAs(reversalAssertion(c, original.entryId), original.entryId, today, 'a different reason', 'req-d', d).catch(
        (e) => e as Error,
      );
      await a.query('COMMIT');
      const rd = await pending;

      expect(rd).toBeInstanceOf(Error);
      const message = (rd as Error).message;
      expect(message).toMatch(/accounting\.reversal_exists/);
      // §14, §49: a stable domain code, never the index that enforced it.
      expect(message).not.toMatch(/duplicate key|unique constraint|23505|accounting_reversals_.*_uq|_key\b/);
    } finally {
      await d.query('ROLLBACK').catch(() => undefined);
      await closeAll(a, d);
    }
  });
});

// ── §43 opening balance ───────────────────────────────────────────────────

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

interface OpeningInput {
  tenantId: string;
  businessId: string;
  userId: string;
}

function openingAssertion(who: OpeningInput, openingBalanceId: string, positions: readonly PostLine[]): string {
  return sourceAssertion({
    actorUserId: who.userId,
    tenantId: who.tenantId,
    businessId: who.businessId,
    operationKind: 'post',
    sourceType: 'opening_balance',
    sourceId: openingBalanceId,
    postingFingerprint: openingBalanceFingerprintOf({
      tenantId: who.tenantId,
      businessId: who.businessId,
      openingBalanceId,
      asOfDate: today,
      baseCurrency: 'ILS',
      positions,
    }),
  });
}

/**
 * The case below is a LATE arrival, not a race: A's whole command has already
 * returned when D's begins, so what it proves is that a second opening
 * balance arriving after the first is refused by name and leaves nothing
 * behind. That is worth keeping and it is not the race.
 *
 * The genuine contention — both commands inside the workflow at the same
 * moment, neither transaction committed, the test refusing to proceed until
 * PostgreSQL reports a backend actually waiting on a lock — lives in
 * `accounting-opening-balance-race.test.ts`, with the same-key, different-key
 * and first-ordinary-posting cases.
 */
describe('a second opening balance arriving after the first (§43)', () => {
  it('at most one posted set survives, the loser gets a stable domain error, and nothing is orphaned', async () => {
    const b = await seedPostingFixture(ownerPool(), `src-conc-ob-${Date.now()}`);
    const positionsA = [position('cash', 'D', 50000n)];
    const positionsD = [position('cash', 'D', 90000n)];
    const idA = randomUUID();
    const idD = randomUUID();

    const a = await appClient();
    const d = await appClient();
    try {
      await a.query('BEGIN');
      await d.query('BEGIN');
      const ra = await postOpeningBalanceAs(
        openingAssertion(b, idA, positionsA),
        { asOfDate: today, positions: positionsA, openingBalanceId: idA, requestId: 'req-a' },
        a,
      );
      const pending = postOpeningBalanceAs(
        openingAssertion(b, idD, positionsD),
        { asOfDate: today, positions: positionsD, openingBalanceId: idD, requestId: 'req-d' },
        d,
      ).catch((e) => e as Error);
      await a.query('COMMIT');
      const rd = await pending;

      expect(ra.created).toBe(true);
      expect(rd).toBeInstanceOf(Error);
      expect((rd as Error).message).toMatch(/accounting\.opening_balance_exists/);
      expect((rd as Error).message).not.toMatch(/duplicate key|unique constraint|23505|_uq\b/);
      await d.query('ROLLBACK').catch(() => undefined);

      const state = must(
        (
          await ownerPool().query<{ posted: number; sets: number; entries: number; lines: number; bindings: number }>(
            `SELECT (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1 AND status = 'posted')::int AS posted,
                    (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1)::int AS sets,
                    (SELECT count(*) FROM journal_entries WHERE business_id = $1)::int AS entries,
                    (SELECT count(*) FROM accounting_opening_balance_lines WHERE business_id = $1)::int AS lines,
                    (SELECT count(*) FROM accounting_source_bindings WHERE business_id = $1)::int AS bindings`,
            [b.businessId],
          )
        ).rows[0],
      );
      // The loser rolled back entirely: its draft, its lines and its journal
      // attempt are all gone, and only the winner's set remains.
      expect(state.posted).toBe(1);
      expect(state.sets).toBe(1);
      expect(state.entries).toBe(1);
      expect(state.bindings).toBe(1);
      // The opening-balance lines are the merchant's POSITIONS. The equity
      // plug is engine output, so it lives in the journal and not here —
      // storing it among the positions would make a derived line look like
      // one somebody stated.
      expect(state.lines).toBe(positionsA.length);
      const journal = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_lines WHERE business_id = $1 AND journal_entry_id = $2`, [
        b.businessId,
        ra.entryId,
      ]);
      expect(must(journal.rows[0]).n).toBe(positionsA.length + 1);
    } finally {
      await closeAll(a, d);
    }
  });
});

// ── §44 atomicity under injected failure ──────────────────────────────────

describe('a failed workflow leaves nothing behind (§33, §44)', () => {
  it('a reversal that fails after its draft work commits nothing', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    const conn = await appClient();
    try {
      await conn.query('BEGIN');
      await postReversalAs(reversalAssertion(c, original.entryId), original.entryId, today, 'will be abandoned', 'req-x', conn);
      // Failure injected the honest way: the transaction the command runs in
      // does not commit. No production code path exists to make this happen,
      // which is the point — atomicity is the database's, not a flag's.
      await conn.query('ROLLBACK');
    } finally {
      await conn.end().catch(() => undefined);
    }

    const after = must(
      (
        await ownerPool().query<{ reversals: number; entries: number; audits: number; outbox: number }>(
          `SELECT (SELECT count(*) FROM accounting_reversals WHERE business_id = $1 AND original_entry_id = $2)::int AS reversals,
                  (SELECT count(*) FROM journal_entries WHERE business_id = $1 AND source_type = 'reversal' AND source_id = $2)::int AS entries,
                  (SELECT count(*) FROM audit_events WHERE business_id = $1 AND action = 'accounting.entry_reversed' AND metadata->>'originalEntryId' = $2::text)::int AS audits,
                  (SELECT count(*) FROM outbox_events WHERE business_id = $1 AND type = 'accounting.entry.reversed' AND payload->>'originalEntryId' = $2::text)::int AS outbox`,
          [fx.businessId, original.entryId],
        )
      ).rows[0],
    );
    expect(after).toEqual({ reversals: 0, entries: 0, audits: 0, outbox: 0 });

    // And the original is still reversible afterwards: a rolled-back attempt
    // must not consume the one reversal an entry is allowed.
    const retry = await postReversalAs(reversalAssertion(c, original.entryId), original.entryId, today, 'the real correction', randomUUID());
    expect(retry.created).toBe(true);
  });

  it('an opening balance whose post is refused leaves no draft behind', async () => {
    const b = await seedPostingFixture(ownerPool(), `src-conc-fail-${Date.now()}`);
    const positions = [position('cash', 'D', 44000n)];
    const openingBalanceId = randomUUID();
    const conn = await appClient();
    try {
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [openingAssertion(b, openingBalanceId, positions)]);
      // Row level security is keyed on the tenant, so a caller that wants to
      // SEE its own draft has to say which tenant it is. Note what this does
      // NOT buy: the draft was still created under the authority of the
      // assertion, and setting these changes nothing about that.
      await conn.query(`SELECT set_config('app.tenant_id', $1, true)`, [b.tenantId]);
      await conn.query(`SELECT set_config('app.business_id', $1, true)`, [b.businessId]);
      await conn.query(`SELECT accounting_open_balance_draft($1::date, $2::jsonb)`, [today, JSON.stringify(positionPayload(positions))]);
      // The draft exists inside this transaction...
      const inside = await conn.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_opening_balances WHERE business_id = $1`, [b.businessId]);
      expect(must(inside.rows[0]).n).toBe(1);
      await conn.query('ROLLBACK');
    } finally {
      await conn.end().catch(() => undefined);
    }

    // ...and nowhere outside it.
    for (const table of ['accounting_opening_balances', 'accounting_opening_balance_lines', 'journal_entries']) {
      const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [b.businessId]);
      expect(must(r.rows[0]).n, table).toBe(0);
    }
  });

  it('an adjustment refused mid-command writes no entry, no detail row, no audit and no outbox event', async () => {
    const c = adjustment();
    // A fingerprint over a different date: the database derives the actual
    // payload's fingerprint and refuses, after it has already resolved
    // accounts and taken its locks.
    const wrong = sourceAssertion({
      actorUserId: fx.userId,
      tenantId: c.tenantId,
      businessId: c.businessId,
      operationKind: 'post',
      sourceType: 'manual_adjustment',
      sourceId: c.sourceId,
      postingFingerprint: 'b'.repeat(64),
    });
    const conn = await appClient();
    let failed = false;
    try {
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [wrong]);
      await conn.query(`SELECT entry_id FROM accounting_post_manual_adjustment($1::date, $2, $3, $4, $5::jsonb)`, [
        c.entryDate,
        'refused',
        'refused',
        null,
        JSON.stringify(positionPayload(c.lines).map((p, i) => ({ ...(p as object), branch_id: null, warehouse_id: null, side: must(c.lines[i]).side }))),
      ]);
    } catch (e) {
      failed = true;
      expect((e as Error).message).toMatch(/assertion_payload_mismatch|payload_/);
    } finally {
      await conn.query('ROLLBACK').catch(() => undefined);
      await conn.end().catch(() => undefined);
    }
    expect(failed).toBe(true);

    const after = must(
      (
        await ownerPool().query<{ entries: number; details: number }>(
          `SELECT (SELECT count(*) FROM journal_entries WHERE business_id = $1 AND source_id = $2)::int AS entries,
                  (SELECT count(*) FROM accounting_manual_adjustments WHERE business_id = $1 AND id = $2)::int AS details`,
          [fx.businessId, c.sourceId],
        )
      ).rows[0],
    );
    expect(after).toEqual({ entries: 0, details: 0 });
  });
});

// ── §12, §13 one idempotency key, two connections ─────────────────────────

/**
 * The transport identity, derived exactly as the merchant API derives it, so
 * these two cases race over a real `Idempotency-Key` rather than over a UUID
 * the test chose to share.
 */
function keyedOpening(who: OpeningInput, idempotencyKey: string, positions: readonly PostLine[]): { id: string; assertion: string } {
  const id = deriveSourceId(who.businessId, idempotencyKey);
  return { id, assertion: openingAssertion(who, id, positions) };
}

describe('one idempotency key, two connections (§12, §13)', () => {
  it('same key, SAME payload: one posting, one created=true, one created=false, no duplicate domain events (§13)', async () => {
    const b = await seedPostingFixture(ownerPool(), `src-conc-idem-same-${Date.now()}`);
    const positions = [position('cash', 'D', 64000n)];
    const key = 'concurrent-opening-key-same';
    // Two independently minted assertions over one identical payload: the
    // same fingerprint, different replay ids. Replay protection must not turn
    // a legitimate concurrent retry into a failure.
    const a = keyedOpening(b, key, positions);
    const d = keyedOpening(b, key, positions);
    expect(a.id).toBe(d.id);
    expect(a.assertion).not.toBe(d.assertion);

    const ca = await appClient();
    const cd = await appClient();
    try {
      await ca.query('BEGIN');
      await cd.query('BEGIN');
      const ra = await postOpeningBalanceAs(a.assertion, { asOfDate: today, positions, openingBalanceId: a.id, requestId: 'req-a' }, ca);
      // D issues the identical command while A still holds the per-business
      // advisory lock. It must block on A rather than write a second posting.
      const pending = postOpeningBalanceAs(d.assertion, { asOfDate: today, positions, openingBalanceId: d.id, requestId: 'req-d' }, cd).catch(
        (e) => e as Error,
      );
      await ca.query('COMMIT');
      const rd = await pending;
      await cd.query('COMMIT');

      expect(rd).not.toBeInstanceOf(Error);
      const loser = rd as { entryId: string; created: boolean };
      expect(ra.created).toBe(true);
      expect(loser.created).toBe(false);
      expect(loser.entryId).toBe(ra.entryId);

      const counts = must(
        (
          await ownerPool().query<{ posted: number; sets: number; entries: number; bindings: number; audits: number; outbox: number }>(
            `SELECT (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1 AND status = 'posted')::int AS posted,
                    (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1)::int AS sets,
                    (SELECT count(*) FROM journal_entries WHERE business_id = $1)::int AS entries,
                    (SELECT count(*) FROM accounting_source_bindings WHERE business_id = $1)::int AS bindings,
                    (SELECT count(*) FROM audit_events WHERE business_id = $1 AND action = 'accounting.opening_balance_posted')::int AS audits,
                    (SELECT count(*) FROM outbox_events WHERE business_id = $1 AND type = 'accounting.opening_balance.posted')::int AS outbox`,
            [b.businessId],
          )
        ).rows[0],
      );
      expect(counts).toEqual({ posted: 1, sets: 1, entries: 1, bindings: 1, audits: 1, outbox: 1 });
    } finally {
      await closeAll(ca, cd);
    }
  });

  it('same key, DIFFERENT payload: exactly one financial source wins and the loser gets accounting.idempotency_conflict (§12)', async () => {
    const b = await seedPostingFixture(ownerPool(), `src-conc-idem-diff-${Date.now()}`);
    const positionsA = [position('cash', 'D', 64000n)];
    const positionsD = [position('cash', 'D', 99000n)];
    const key = 'concurrent-opening-key-diff';
    const a = keyedOpening(b, key, positionsA);
    const d = keyedOpening(b, key, positionsD);
    // One key, one source identity — and two different financial facts
    // claiming it. Exactly one of them may become truth.
    expect(a.id).toBe(d.id);

    const ca = await appClient();
    const cd = await appClient();
    try {
      await ca.query('BEGIN');
      await cd.query('BEGIN');
      const ra = await postOpeningBalanceAs(a.assertion, { asOfDate: today, positions: positionsA, openingBalanceId: a.id, requestId: 'req-a' }, ca);
      const pending = postOpeningBalanceAs(d.assertion, { asOfDate: today, positions: positionsD, openingBalanceId: d.id, requestId: 'req-d' }, cd).catch(
        (e) => e as Error,
      );
      await ca.query('COMMIT');
      const rd = await pending;

      expect(ra.created).toBe(true);
      expect(rd).toBeInstanceOf(Error);
      const message = (rd as Error).message;
      // Never both success, never last-write-wins, and never the index that
      // enforced it (§12, §20).
      expect(message).toMatch(/accounting\.idempotency_conflict/);
      expect(message).not.toMatch(/duplicate key|unique constraint|23505|_uq\b|64000|99000/);
      await cd.query('ROLLBACK').catch(() => undefined);

      const state = must(
        (
          await ownerPool().query<{ posted: number; sets: number; entries: number; bindings: number; positions: number; audits: number; outbox: number }>(
            `SELECT (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1 AND status = 'posted')::int AS posted,
                    (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1)::int AS sets,
                    (SELECT count(*) FROM journal_entries WHERE business_id = $1)::int AS entries,
                    (SELECT count(*) FROM accounting_source_bindings WHERE business_id = $1)::int AS bindings,
                    (SELECT count(*) FROM accounting_opening_balance_lines WHERE business_id = $1)::int AS positions,
                    (SELECT count(*) FROM audit_events WHERE business_id = $1 AND action = 'accounting.opening_balance_posted')::int AS audits,
                    (SELECT count(*) FROM outbox_events WHERE business_id = $1 AND type = 'accounting.opening_balance.posted')::int AS outbox`,
            [b.businessId],
          )
        ).rows[0],
      );
      // One source, one entry, one binding, one of each event — and no orphan
      // draft left behind by the loser.
      expect(state).toEqual({ posted: 1, sets: 1, entries: 1, bindings: 1, positions: positionsA.length, audits: 1, outbox: 1 });

      // §19: the winner's stored position is untouched by the loser's attempt.
      const stored = must(
        (
          await ownerPool().query<{ base_amount_minor: string }>(
            `SELECT base_amount_minor::text FROM accounting_opening_balance_lines WHERE business_id = $1`,
            [b.businessId],
          )
        ).rows[0],
      );
      expect(stored.base_amount_minor).toBe('64000');
    } finally {
      await closeAll(ca, cd);
    }
  });
});
