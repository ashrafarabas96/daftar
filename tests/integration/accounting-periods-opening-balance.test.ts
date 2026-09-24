/**
 * THE OPENING-BALANCE EXCEPTION (P2-S6 correction §2-§13).
 *
 * An opening balance is the position a merchant carried INTO DAFTAR. It is
 * older than the books by definition, and 0042 registers it with
 * `lower_bound_policy = 'none'` for exactly that reason.
 *
 * Periods narrow where NEW truth may be written. Applied without an exception
 * they would also have made this true:
 *
 *   enter the opening position, then define the first period -> accepted
 *   define the first period, then enter the same opening position -> REFUSED
 *
 * The same financial fact, accepted or refused depending on which button the
 * merchant pressed first. That is what this suite exists to prevent, and the
 * first two cases below are the primary regression: two businesses, the same
 * facts, opposite setup order, one answer.
 *
 * The rest of the suite is the other half of the job — proving the exception
 * stayed narrow. It is a rule about placement relative to the BEGINNING of the
 * books, not a licence for one source to ignore period state, so an opening
 * balance inside a CLOSED period is still refused, an opening balance after
 * the chain is still refused, and no other source gets the exception at all.
 */
import { randomUUID } from 'node:crypto';
import { deriveSourceId } from '@daftar/accounting';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  must,
  openingBalanceFingerprintOf,
  post,
  postOpeningBalanceAs,
  postReversalAs,
  refusal,
  reversalFingerprintOf,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostLine,
  type PostingFixture,
} from '../helpers/accounting-posting';
import { closePeriod, createPeriod } from '../helpers/accounting-periods';

let pool: Pool;
let today: string;

const AT = new Date('2026-03-14T09:15:00Z');

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  pool = ownerPool();
  today = await todayIn(pool, 'Asia/Hebron');
}, 180_000);

/**
 * A business of its own for every case. The one-posted-set rule of P2-S4
 * allows exactly one opening balance per business, so a matrix over opening
 * balances is necessarily a matrix over businesses.
 */
const books = (label: string): Promise<PostingFixture> => seedPostingFixture(pool, `obperiod-${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);

const daysAgo = async (n: number): Promise<string> => {
  const r = await pool.query<{ d: string }>(`SELECT to_char(($1::date - $2::int), 'YYYY-MM-DD') AS d`, [today, n]);
  return must(r.rows[0]).d;
};

const daysAhead = async (n: number): Promise<string> => {
  const r = await pool.query<{ d: string }>(`SELECT to_char(($1::date + $2::int), 'YYYY-MM-DD') AS d`, [today, n]);
  return must(r.rows[0]).d;
};

/** A domestic position stated in the business's base currency. */
const domestic = (systemKey: string, side: 'D' | 'C', amount: bigint): PostLine => ({
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

/** The identical opening position used by every case, so only the DATES differ. */
const positions = (): PostLine[] => [domestic('cash', 'D', 50000n), domestic('bank', 'D', 20000n)];

/**
 * The merchant path for an opening balance, entered at the transport layer
 * exactly as `AccountingSourcesService` enters it: an idempotency key in, a
 * posted entry out, with the source identity and the signed fingerprint both
 * derived from the payload being submitted right now.
 */
async function openBalance(
  who: PostingFixture,
  idempotencyKey: string,
  asOfDate: string,
  input: { positions?: readonly PostLine[]; requestId?: string } = {},
): Promise<{ entryId: string; created: boolean }> {
  const lines = input.positions ?? positions();
  const openingBalanceId = deriveSourceId(who.businessId, idempotencyKey);
  const assertion = sourceAssertion({
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
      asOfDate,
      baseCurrency: 'ILS',
      positions: lines,
    }),
  });
  return postOpeningBalanceAs(assertion, {
    asOfDate,
    positions: lines,
    openingBalanceId,
    description: 'opening position',
    requestId: input.requestId ?? randomUUID(),
  });
}

/** An ordinary manual adjustment, which must gain nothing from the exception. */
const adjust = (who: PostingFixture, entryDate: string): Promise<{ entryId: string; created: boolean }> =>
  post({ ...simpleCommand(who, randomUUID(), entryDate), tenantId: who.tenantId, businessId: who.businessId }, who.userId);

/** The posted opening balance, as the merchant would read it back. */
async function entryOf(businessId: string): Promise<{ entryDate: string; lines: string }> {
  const e = must(
    (
      await pool.query<{ id: string; entry_date: string }>(
        `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date
         FROM journal_entries WHERE business_id = $1 AND source_type = 'opening_balance'`,
        [businessId],
      )
    ).rows[0],
    'the opening balance entry',
  );
  const lines = await pool.query<{ row: string }>(
    `SELECT a.system_key || ':' || l.debit_minor::text || ':' || l.credit_minor::text || ':' || l.base_currency AS row
     FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
     WHERE l.journal_entry_id = $1 ORDER BY l.line_no`,
    [e.id],
  );
  return { entryDate: e.entry_date, lines: lines.rows.map((r) => r.row).join('|') };
}

// ── §8: the primary regression — the answer does not depend on setup order ─

describe('order independence — the same facts give the same answer either way (§8)', () => {
  let flowOne: PostingFixture;
  let flowTwo: PostingFixture;
  let opening: string;
  let periodStart: string;
  let periodEnd: string;

  beforeAll(async () => {
    // The directive's own example, expressed relatively so the suite does not
    // expire: a first operating period, and an opening position the day
    // before it begins.
    periodStart = await daysAgo(60);
    periodEnd = await daysAgo(31);
    opening = await daysAgo(61);
    flowOne = await books('flow-one');
    flowTwo = await books('flow-two');
  }, 120_000);

  it('FLOW 1 — opening balance first, then the first period', async () => {
    expect((await openBalance(flowOne, 'flow-one-opening-key', opening)).created).toBe(true);
    const period = await createPeriod(flowOne, 'flow-one-period-key', periodStart, periodEnd);
    expect(period.changed).toBe(true);
  });

  it('FLOW 2 — the first period first, then the SAME opening balance', async () => {
    const period = await createPeriod(flowTwo, 'flow-two-period-key', periodStart, periodEnd);
    expect(period.changed).toBe(true);

    // Before the correction this refused with accounting.period_missing_for_date.
    expect((await openBalance(flowTwo, 'flow-two-opening-key', opening)).created).toBe(true);
  });

  it('and the two businesses hold the SAME accounting fact', async () => {
    // Not merely "both succeeded": the posted entry — its date and its
    // derived lines — must be identical, or the two orders would have
    // produced two different books.
    const one = await entryOf(flowOne.businessId);
    const two = await entryOf(flowTwo.businessId);
    expect(one.entryDate).toBe(opening);
    expect(two).toEqual(one);
  });
});

// ── §9: the opening-balance period matrix ─────────────────────────────────

describe('the opening-balance period matrix (§9)', () => {
  it('A. zero periods — a historical opening balance posts, as it always did', async () => {
    const b = await books('matrix-a');
    expect((await openBalance(b, 'matrix-a-key', await daysAgo(400))).created).toBe(true);
  });

  it('B. one day before the earliest period start — PASS', async () => {
    const b = await books('matrix-b');
    await createPeriod(b, 'matrix-b-period-key', await daysAgo(60), await daysAgo(31));
    expect((await openBalance(b, 'matrix-b-key', await daysAgo(61))).created).toBe(true);
  });

  it('C. far before the earliest period start — PASS', async () => {
    const b = await books('matrix-c');
    await createPeriod(b, 'matrix-c-period-key', await daysAgo(60), await daysAgo(31));
    expect((await openBalance(b, 'matrix-c-key', await daysAgo(900))).created).toBe(true);
  });

  it('D. exactly ON the earliest start of an OPEN period — PASS, through the ordinary covering rule', async () => {
    // The boundary case that says which side of the exception the start date
    // falls on. `entry_date < earliest_start` is strict, so this date is NOT
    // the exception: it is covered, and it passes because the period is open.
    const b = await books('matrix-d');
    const start = await daysAgo(60);
    await createPeriod(b, 'matrix-d-period-key', start, await daysAgo(31));
    expect((await openBalance(b, 'matrix-d-key', start)).created).toBe(true);
  });

  it('E. inside an OPEN period — PASS', async () => {
    const b = await books('matrix-e');
    await createPeriod(b, 'matrix-e-period-key', await daysAgo(60), await daysAgo(31));
    expect((await openBalance(b, 'matrix-e-key', await daysAgo(45))).created).toBe(true);
  });

  it('F. inside a CLOSED period — REFUSED, and the exception does not save it (§11)', async () => {
    const b = await books('matrix-f');
    const period = await createPeriod(b, 'matrix-f-period-key', await daysAgo(60), await daysAgo(31));
    expect((await closePeriod(b, 'matrix-f-close-key', period.periodId)).changed).toBe(true);

    const inside = await daysAgo(45);
    const message = await refusal(() => openBalance(b, 'matrix-f-key', inside));
    expect(message).toMatch(/accounting\.period_closed/);
    // Nothing of it survives: a refused opening balance is not a half-open set.
    expect(await countOpeningBalances(b.businessId)).toBe(0);
  });

  it('F2. inside the EARLIEST period, once that period is closed — still REFUSED', async () => {
    // The sharpest form of §11. The date is inside the chain rather than
    // before it, so "the opening balance is historical" is not an answer the
    // guard may reach for.
    const b = await books('matrix-f2');
    const period = await createPeriod(b, 'matrix-f2-period-key', await daysAgo(60), await daysAgo(31));
    expect((await closePeriod(b, 'matrix-f2-close-key', period.periodId)).changed).toBe(true);
    const onStart = await daysAgo(60);
    expect(await refusal(() => openBalance(b, 'matrix-f2-key', onStart))).toMatch(/accounting\.period_closed/);
  });

  it('G. after the latest period end — REFUSED for want of a covering period', async () => {
    const b = await books('matrix-g');
    await createPeriod(b, 'matrix-g-period-key', await daysAgo(60), await daysAgo(31));
    const after = await daysAgo(30);
    const message = await refusal(() => openBalance(b, 'matrix-g-key', after));
    expect(message).toMatch(/accounting\.period_missing_for_date/);
    expect(await countOpeningBalances(b.businessId)).toBe(0);
  });

  it('H. any other uncovered date after activation — REFUSED', async () => {
    const b = await books('matrix-h');
    await createPeriod(b, 'matrix-h-period-key', await daysAgo(60), await daysAgo(31));
    expect(await refusal(() => openBalance(b, 'matrix-h-key', today))).toMatch(/accounting\.period_missing_for_date/);
  });

  it('I. a FUTURE opening balance — REFUSED by the universal date rule, period or not', async () => {
    // An open period covering tomorrow does not make tomorrow postable, and
    // the exception has no bearing on it: the refusal comes from P2-S3,
    // before this guard is ever reached.
    const b = await books('matrix-i');
    const tomorrow = await daysAhead(1);
    const message = await refusal(() => openBalance(b, 'matrix-i-key', tomorrow));
    expect(message).toMatch(/accounting\.entry_date_in_future/);
  });
});

async function countOpeningBalances(businessId: string): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'opening_balance'`, [
    businessId,
  ]);
  return must(r.rows[0]).n;
}

// ── §10: the exception belongs to ONE source ──────────────────────────────

describe('no other source gains the exception (§10)', () => {
  it('a manual adjustment one day before the earliest period is REFUSED', async () => {
    const b = await books('other-adjust');
    await createPeriod(b, 'adjust-period-key', await daysAgo(60), await daysAgo(31));
    const before = await daysAgo(61);
    const message = await refusal(() => adjust(b, before));
    expect(message).toMatch(/accounting\.period_missing_for_date/);
  });

  it('a manual adjustment FAR before the earliest period is REFUSED too', async () => {
    // Stated separately because a rule written as `entry_date < earliest`
    // without the source test would have let this one through, and the
    // one-day case above is the easier one to get right by accident.
    const b = await books('other-adjust-far');
    await createPeriod(b, 'adjust-far-period-key', await daysAgo(60), await daysAgo(31));
    const farBefore = await daysAgo(900);
    expect(await refusal(() => adjust(b, farBefore))).toMatch(/accounting\.period_missing_for_date/);
  });

  it('a REVERSAL dated before the earliest period is REFUSED', async () => {
    const b = await books('other-reversal');
    const originalDate = await daysAgo(200);

    // The original is posted while the business still has no periods, which
    // is the only way it can exist at that date at all.
    const command: PostCommand = { ...simpleCommand(b, randomUUID(), originalDate), tenantId: b.tenantId, businessId: b.businessId };
    const original = await post(command, b.userId);
    expect(original.created).toBe(true);

    await createPeriod(b, 'reversal-period-key', await daysAgo(60), await daysAgo(31));

    // Dated at the original, so the reversal's own lower bound is satisfied
    // and the only rule left to refuse it is period coverage.
    const assertion = sourceAssertion({
      actorUserId: b.userId,
      tenantId: b.tenantId,
      businessId: b.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: original.entryId,
      postingFingerprint: reversalFingerprintOf(command, original.entryId, originalDate),
    });
    const message = await refusal(() => postReversalAs(assertion, original.entryId, originalDate, 'undoing a pre-period fact', randomUUID()));
    expect(message).toMatch(/accounting\.period_missing_for_date/);
  });
});

// ── §5: the exception is in the DATABASE, not in a service ────────────────

describe('the exception lives on the table (§5)', () => {
  it('the SCHEMA OWNER is refused for an adjustment and gets past the guard for an opening balance', async () => {
    // Both statements are issued by the schema OWNER, through no command, no
    // service and no route, so neither can be refused by a privilege check or
    // by anything written in TypeScript.
    //
    // Neither row can ultimately land — 0042 requires a source binding that
    // only the real command path creates — and that is what makes the pair
    // readable: the two statements are identical but for the source, and they
    // fail at DIFFERENT rules. The adjustment never reaches the binding
    // constraint because the BEFORE INSERT guard refuses it first. The
    // opening balance passes the guard and is stopped by the binding.
    const b = await books('direct');
    await createPeriod(b, 'direct-period-key', await daysAgo(60), await daysAgo(31));
    const before = await daysAgo(120);

    const insert = (sourceType: string): Promise<unknown> =>
      pool.query(
        `INSERT INTO journal_entries (tenant_id, business_id, entry_date, source_type, source_id, actor_kind, actor_user_id, posting_fingerprint)
         VALUES ($1, $2, $3::date, $4, $5, 'user', $6, $7)`,
        [b.tenantId, b.businessId, before, sourceType, randomUUID(), b.userId, 'b'.repeat(64)],
      );

    expect(await refusal(() => insert('manual_adjustment'))).toMatch(/accounting\.period_missing_for_date/);

    const opening = await refusal(() => insert('opening_balance'));
    expect(opening).not.toMatch(/accounting\.period_/);
    expect(opening).toMatch(/journal_entries_binding_fk/);
  });
});

// ── §13: replay of a historical opening balance, after activation ─────────

describe('an opening balance posted before activation replays after it (§13)', () => {
  it('returns the original result and writes nothing a second time', async () => {
    const b = await books('replay');
    const key = 'replay-opening-key';
    const opening = await daysAgo(400);

    const first = await openBalance(b, key, opening);
    expect(first.created).toBe(true);

    // Activate periods, and close the one that exists, so the business is in
    // the strictest state it can be in when the retry arrives.
    const period = await createPeriod(b, 'replay-period-key', await daysAgo(60), await daysAgo(31));
    expect((await closePeriod(b, 'replay-close-key', period.periodId)).changed).toBe(true);

    // Counted after the period commands, which write audit and outbox rows of
    // their own: what this case is about is what the REPLAY adds.
    const before = await sideEffects(b.businessId);

    const replay = await openBalance(b, key, opening);
    expect(replay.created).toBe(false);
    expect(replay.entryId).toBe(first.entryId);
    expect(await sideEffects(b.businessId)).toEqual(before);
  });
});

/** Everything a second posting would have had to add to. */
async function sideEffects(businessId: string): Promise<Record<string, number>> {
  const r = await pool.query<{ entries: number; bindings: number; sets: number; positions: number; audits: number; outbox: number }>(
    `SELECT (SELECT count(*) FROM journal_entries                  WHERE business_id = $1)::int AS entries,
            (SELECT count(*) FROM accounting_source_bindings       WHERE business_id = $1)::int AS bindings,
            (SELECT count(*) FROM accounting_opening_balances      WHERE business_id = $1)::int AS sets,
            (SELECT count(*) FROM accounting_opening_balance_lines WHERE business_id = $1)::int AS positions,
            (SELECT count(*) FROM audit_events                     WHERE business_id = $1)::int AS audits,
            (SELECT count(*) FROM outbox_events                    WHERE business_id = $1)::int AS outbox`,
    [businessId],
  );
  const row = must(r.rows[0]);
  return { entries: row.entries, bindings: row.bindings, sets: row.sets, positions: row.positions, audits: row.audits, outbox: row.outbox };
}
