/**
 * CLOSED BOOKS CANNOT CHANGE FROM BEHIND (P2-S6 correction §5-§24).
 *
 * The first version of this slice refused an entry whose own date fell inside
 * a closed period, and nothing else. That is a date filter, not an accounting
 * control, because a closed period's reported figures include the balances
 * CARRIED IN to it — and those come from every entry dated before it. So with
 * January open and February closed, one new January entry moves February's
 * opening balance, its closing balance and its balance-sheet positions, while
 * February is still declared final.
 *
 * The invariant that removes the whole class, rather than the one example:
 *
 *   a business's periods, sorted by date, are CLOSED periods followed by OPEN
 *   periods — never an open one before a closed one — and they are contiguous.
 *
 * Everything below follows from it. Closing goes oldest first; reopening goes
 * newest first; no earlier period may be created behind closed books; and no
 * new pre-period opening balance may be stated while any period is closed.
 * The last group asks the database directly, as the schema owner, because a
 * rule only the commands keep is a rule the next writer forgets.
 */
import { randomUUID } from 'node:crypto';
import { deriveSourceId } from '@daftar/accounting';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  must,
  openingBalanceFingerprintOf,
  openingBalanceSnapshot,
  post,
  postOpeningBalanceAs,
  postReversalAs,
  refusal,
  reversalFingerprintOfSnapshot,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostLine,
  type PostingFixture,
} from '../helpers/accounting-posting';
import { closePeriod, createPeriod, readPeriod, reopenPeriod } from '../helpers/accounting-periods';

let pool: Pool;
let today: string;

const AT = new Date('2026-03-14T09:15:00Z');

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  pool = ownerPool();
  today = await todayIn(pool, 'Asia/Hebron');
}, 180_000);

const books = (label: string): Promise<PostingFixture> => seedPostingFixture(pool, `closedbooks-${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);

const daysAgo = async (n: number): Promise<string> => {
  const r = await pool.query<{ d: string }>(`SELECT to_char(($1::date - $2::int), 'YYYY-MM-DD') AS d`, [today, n]);
  return must(r.rows[0]).d;
};

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

const positions = (): PostLine[] => [domestic('cash', 'D', 50000n), domestic('bank', 'D', 20000n)];

async function openBalance(
  who: PostingFixture,
  idempotencyKey: string,
  asOfDate: string,
  lines: readonly PostLine[] = positions(),
): Promise<{ entryId: string; created: boolean }> {
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
  return postOpeningBalanceAs(assertion, { asOfDate, positions: lines, openingBalanceId, description: 'opening position', requestId: randomUUID() });
}

/** Three contiguous periods, oldest first, all open. */
async function threePeriods(who: PostingFixture, label: string): Promise<{ p1: string; p2: string; p3: string }> {
  const p1 = await createPeriod(who, `${label}-period-one`, await daysAgo(90), await daysAgo(61));
  const p2 = await createPeriod(who, `${label}-period-two`, await daysAgo(60), await daysAgo(31));
  const p3 = await createPeriod(who, `${label}-period-three`, await daysAgo(30), today);
  return { p1: p1.periodId, p2: p2.periodId, p3: p3.periodId };
}

/** The business's periods as a status word per period, oldest first. */
async function shape(businessId: string): Promise<string[]> {
  const r = await pool.query<{ status: string }>(`SELECT status FROM accounting_periods WHERE business_id = $1 ORDER BY start_date`, [businessId]);
  return r.rows.map((x) => x.status);
}

// ── §16: closing goes oldest first ────────────────────────────────────────

describe('the close matrix — oldest first (§16)', () => {
  it('a later period cannot be closed while an earlier one is open, and closing in order works', async () => {
    const b = await books('close-order');
    const { p1, p2, p3 } = await threePeriods(b, 'close');
    expect(await shape(b.businessId)).toEqual(['open', 'open', 'open']);

    // The middle one, then the last one: both refused, and both by name.
    expect(await refusal(() => closePeriod(b, 'close-second-first', p2))).toMatch(/accounting\.period_close_order/);
    expect(await refusal(() => closePeriod(b, 'close-third-first', p3))).toMatch(/accounting\.period_close_order/);

    // Nothing closed as a side effect of the refusals — no cascade, and no
    // half-applied close.
    expect(await shape(b.businessId)).toEqual(['open', 'open', 'open']);

    expect((await closePeriod(b, 'close-first-one', p1)).changed).toBe(true);
    expect(await shape(b.businessId)).toEqual(['closed', 'open', 'open']);

    expect((await closePeriod(b, 'close-second-two', p2)).changed).toBe(true);
    expect(await shape(b.businessId)).toEqual(['closed', 'closed', 'open']);

    expect((await closePeriod(b, 'close-third-three', p3)).changed).toBe(true);
    expect(await shape(b.businessId)).toEqual(['closed', 'closed', 'closed']);
  }, 120_000);

  it('the refusal names no table, constraint or SQLSTATE', async () => {
    const b = await books('close-message');
    const { p2 } = await threePeriods(b, 'msg');
    const message = await refusal(() => closePeriod(b, 'close-msg-second', p2));
    // The SQLSTATE patterns are word-bounded on purpose. The refusal carries
    // the business and period ids, which the caller owns and is entitled to,
    // and a UUID's hex runs contain decimal digits: `…8c98d23726f8` satisfies
    // an unbounded /23\d\d\d/ and turned this assertion into a coin toss that
    // came up tails a few percent of runs. A SQLSTATE appears as a token of
    // its own, so `\b` refuses the leak this test is about and nothing else.
    expect(message).not.toMatch(/accounting_periods|trigger|constraint|\b23\d{3}\b|\bP0001\b/i);
  }, 120_000);
});

// ── §17: reopening goes newest first ──────────────────────────────────────

describe('the reopen matrix — newest first (§17)', () => {
  it('an earlier period cannot be reopened while a later one is closed, and reopening in order works', async () => {
    const b = await books('reopen-order');
    const { p1, p2, p3 } = await threePeriods(b, 'reopen');
    await closePeriod(b, 'reopen-close-one', p1);
    await closePeriod(b, 'reopen-close-two', p2);
    await closePeriod(b, 'reopen-close-three', p3);
    expect(await shape(b.businessId)).toEqual(['closed', 'closed', 'closed']);

    expect(await refusal(() => reopenPeriod(b, 'reopen-first-first', p1, 'the oldest one, out of order'))).toMatch(/accounting\.period_reopen_order/);
    expect(await refusal(() => reopenPeriod(b, 'reopen-second-first', p2, 'the middle one, out of order'))).toMatch(/accounting\.period_reopen_order/);
    expect(await shape(b.businessId)).toEqual(['closed', 'closed', 'closed']);

    expect((await reopenPeriod(b, 'reopen-third-three', p3, 'the newest period, first')).changed).toBe(true);
    expect(await shape(b.businessId)).toEqual(['closed', 'closed', 'open']);

    expect((await reopenPeriod(b, 'reopen-second-two', p2, 'then the middle one')).changed).toBe(true);
    expect(await shape(b.businessId)).toEqual(['closed', 'open', 'open']);

    expect((await reopenPeriod(b, 'reopen-first-one', p1, 'and finally the oldest')).changed).toBe(true);
    expect(await shape(b.businessId)).toEqual(['open', 'open', 'open']);

    // The reopen of the oldest period carries its own reason and its own
    // instant: nothing cascaded, so each transition is separately recorded.
    const row = await readPeriod(pool, b.businessId, p1);
    expect(row.last_reopen_reason).toBe('and finally the oldest');
  }, 120_000);
});

// ── §18: the operational topology, and what it permits ────────────────────

describe('the intended operational topology (§18)', () => {
  it('CLOSED CLOSED OPEN accepts a posting into the open period and refuses one into either closed period', async () => {
    const b = await books('stability');
    const { p1, p2 } = await threePeriods(b, 'stab');
    await closePeriod(b, 'stability-close-one', p1);
    await closePeriod(b, 'stability-close-two', p2);
    expect(await shape(b.businessId)).toEqual(['closed', 'closed', 'open']);

    const inOpen = await daysAgo(15);
    const postOn = (d: string): Promise<{ entryId: string; created: boolean }> =>
      post({ ...simpleCommand(b, randomUUID(), d), tenantId: b.tenantId, businessId: b.businessId }, b.userId);
    expect((await postOn(inOpen)).created).toBe(true);

    for (const closed of [await daysAgo(80), await daysAgo(45)]) {
      expect(await refusal(() => postOn(closed))).toMatch(/accounting\.period_closed/);
    }
  }, 120_000);

  it('OPEN behind CLOSED cannot be reached through any supported command', async () => {
    // The whole point, stated as an exhaustive attempt: there are exactly
    // three commands, and none of them leaves an earlier period open while a
    // later one is closed.
    const b = await books('unreachable');
    const { p1, p2, p3 } = await threePeriods(b, 'unreach');
    await closePeriod(b, 'unreachable-close-one', p1);
    await closePeriod(b, 'unreachable-close-two', p2);

    // close out of order, reopen out of order, prepend behind closed books.
    expect(await refusal(() => reopenPeriod(b, 'unreachable-reopen-one', p1, 'trying to open behind a closed period'))).toMatch(
      /accounting\.period_reopen_order/,
    );
    const earlier = await daysAgo(120);
    const earlierEnd = await daysAgo(91);
    expect(await refusal(() => createPeriod(b, 'unreachable-prepend', earlier, earlierEnd))).toMatch(/accounting\.period_prepend_closed_history/);

    expect(await shape(b.businessId)).toEqual(['closed', 'closed', 'open']);
    expect(p3).toBeTruthy();
  }, 120_000);
});

// ── §19: the prepend matrix ───────────────────────────────────────────────

describe('the prepend matrix (§19)', () => {
  it('A. every existing period is OPEN — an earlier contiguous period may be created', async () => {
    const b = await books('prepend-open');
    await createPeriod(b, 'prepend-open-first', await daysAgo(60), await daysAgo(31));
    const created = await createPeriod(b, 'prepend-open-earlier', await daysAgo(90), await daysAgo(61));
    expect(created.changed).toBe(true);
    expect(await shape(b.businessId)).toEqual(['open', 'open']);
  }, 120_000);

  it('B. any existing period is CLOSED — an earlier contiguous period is REFUSED', async () => {
    const b = await books('prepend-closed');
    const first = await createPeriod(b, 'prepend-closed-first', await daysAgo(60), await daysAgo(31));
    await closePeriod(b, 'prepend-closed-close', first.periodId);

    const earlierStart = await daysAgo(90);
    const earlierEnd = await daysAgo(61);
    const message = await refusal(() => createPeriod(b, 'prepend-closed-earlier', earlierStart, earlierEnd));
    expect(message).toMatch(/accounting\.period_prepend_closed_history/);
    expect(await shape(b.businessId)).toEqual(['closed']);
  }, 120_000);

  it('C. a CLOSED prefix still takes a new period AFTER the latest end, and it lands OPEN', async () => {
    const b = await books('append-closed');
    const first = await createPeriod(b, 'append-closed-first', await daysAgo(60), await daysAgo(31));
    await closePeriod(b, 'append-closed-close', first.periodId);

    const appended = await createPeriod(b, 'append-closed-later', await daysAgo(30), today);
    expect(appended.changed).toBe(true);
    expect(await shape(b.businessId)).toEqual(['closed', 'open']);
  }, 120_000);

  it('the FIRST period of a business is never a prepend, whatever its dates', async () => {
    const b = await books('first-period');
    const created = await createPeriod(b, 'first-period-only', await daysAgo(900), await daysAgo(871));
    expect(created.changed).toBe(true);
  }, 120_000);
});

// ── §20: the opening balance against closed books ─────────────────────────

describe('the opening balance and closed books (§20)', () => {
  it('A. the first period is OPEN — a historical opening balance still posts', async () => {
    const b = await books('ob-open');
    await createPeriod(b, 'ob-open-period', await daysAgo(60), await daysAgo(31));
    const beforeFirst = await daysAgo(61);
    expect((await openBalance(b, 'ob-open-key', beforeFirst)).created).toBe(true);
  }, 120_000);

  it('B. the first period is CLOSED — REFUSED, with period_closed_history and NOT period_closed', async () => {
    const b = await books('ob-closed');
    const first = await createPeriod(b, 'ob-closed-period', await daysAgo(60), await daysAgo(31));
    await closePeriod(b, 'ob-closed-close', first.periodId);

    const beforeClosed = await daysAgo(61);
    const message = await refusal(() => openBalance(b, 'ob-closed-key', beforeClosed));
    // The distinction is the point: the date is OUTSIDE every period, so
    // saying "the period covering it is closed" would be untrue. What is
    // refused is writing BEHIND closed books.
    expect(message).toMatch(/accounting\.period_closed_history/);
    expect(message).not.toMatch(/accounting\.period_closed:/);
  }, 120_000);

  it('C. several periods, one of them closed — a new pre-period opening balance is REFUSED', async () => {
    const b = await books('ob-mixed');
    const { p1 } = await threePeriods(b, 'obmixed');
    await closePeriod(b, 'ob-mixed-close-one', p1);
    expect(await shape(b.businessId)).toEqual(['closed', 'open', 'open']);

    const before = await daysAgo(91);
    expect(await refusal(() => openBalance(b, 'ob-mixed-key', before))).toMatch(/accounting\.period_closed_history/);
  }, 120_000);

  it('D. once every period is reopened, the historical opening balance posts', async () => {
    // The merchant's route back, and it is deliberately not a shortcut: the
    // closed periods are reopened newest first, each one audited with its own
    // reason, and only then may truth be written behind them.
    const b = await books('ob-reopened');
    const first = await createPeriod(b, 'ob-reopened-period', await daysAgo(60), await daysAgo(31));
    await closePeriod(b, 'ob-reopened-close', first.periodId);
    const before = await daysAgo(61);
    expect(await refusal(() => openBalance(b, 'ob-reopened-key', before))).toMatch(/accounting\.period_closed_history/);

    await reopenPeriod(b, 'ob-reopened-reopen', first.periodId, 'the opening position was stated late');
    expect((await openBalance(b, 'ob-reopened-key', before)).created).toBe(true);
  }, 120_000);

  it('E. an opening balance posted BEFORE the close replays after it, and writes nothing twice', async () => {
    const b = await books('ob-replay');
    const before = await daysAgo(400);
    const first = await openBalance(b, 'ob-replay-key', before);
    expect(first.created).toBe(true);

    const period = await createPeriod(b, 'ob-replay-period', await daysAgo(60), await daysAgo(31));
    await closePeriod(b, 'ob-replay-close', period.periodId);

    const counts = await sideEffects(b.businessId);
    const replay = await openBalance(b, 'ob-replay-key', before);
    expect(replay.created).toBe(false);
    expect(replay.entryId).toBe(first.entryId);
    expect(await sideEffects(b.businessId)).toEqual(counts);
  }, 120_000);

  it('F and G. inside an OPEN period it posts; inside a CLOSED period it is period_closed', async () => {
    const open = await books('ob-inside-open');
    await createPeriod(open, 'ob-inside-open-period', await daysAgo(60), await daysAgo(31));
    const insideOpen = await daysAgo(45);
    expect((await openBalance(open, 'ob-inside-open-key', insideOpen)).created).toBe(true);

    const closed = await books('ob-inside-closed');
    const period = await createPeriod(closed, 'ob-inside-closed-period', await daysAgo(60), await daysAgo(31));
    await closePeriod(closed, 'ob-inside-closed-close', period.periodId);
    const inside = await daysAgo(45);
    expect(await refusal(() => openBalance(closed, 'ob-inside-closed-key', inside))).toMatch(/accounting\.period_closed:/);
  }, 120_000);
});

// ── §21 and the cross-slice lifecycle proof ───────────────────────────────

/**
 * The opening balance is not a once-in-a-lifetime entry, and this is the
 * proof that says so END TO END rather than by assertion.
 *
 * An earlier version of this file carried a test with this describe's name
 * which never created the state its title claimed: it posted one opening
 * balance, watched a second be refused, and counted the posted rows. That is
 * evidence for `accounting.opening_balance_exists` and for nothing else. A
 * test is evidence only for what it actually does, so the whole lifecycle is
 * performed here through the real commands — no status is written by hand,
 * no period row is updated directly, and every step uses a genuine signed
 * assertion.
 *
 * What it walks through is the only legal way a merchant can restate their
 * opening position once their books have periods:
 *
 *   post OB1 → open the books with periods → close them → find the
 *   replacement refused → reopen newest-first → reverse OB1 inside an OPEN
 *   period → find the replacement STILL refused while the books are closed →
 *   reopen → post OB2, which supersedes OB1 → close again → and a retry of
 *   OB2 is still a retry.
 */
describe('opening-balance replacement semantics (§21, AL-13) — the whole lifecycle', () => {
  /** Reverse a posted opening balance through the ordinary reversal writer. */
  async function reverseOpening(
    who: PostingFixture,
    entryId: string,
    openedAsOf: string,
    lines: readonly PostLine[],
    reversalDate: string,
  ): Promise<{ entryId: string; created: boolean }> {
    const snap = openingBalanceSnapshot({
      entryId,
      tenantId: who.tenantId,
      businessId: who.businessId,
      asOfDate: openedAsOf,
      baseCurrency: 'ILS',
      positions: lines,
    });
    const assertion = sourceAssertion({
      actorUserId: who.userId,
      tenantId: who.tenantId,
      businessId: who.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: entryId,
      postingFingerprint: reversalFingerprintOfSnapshot(snap, reversalDate),
    });
    return postReversalAs(assertion, entryId, reversalDate, 'restating the opening position', randomUUID());
  }

  /** Everything a refused attempt must not have left behind. */
  async function state(businessId: string): Promise<Record<string, number>> {
    const r = await pool.query<{ entries: number; sets: number; bindings: number; audits: number; outbox: number; reversals: number }>(
      `SELECT (SELECT count(*) FROM journal_entries              WHERE business_id = $1)::int AS entries,
              (SELECT count(*) FROM accounting_opening_balances  WHERE business_id = $1)::int AS sets,
              (SELECT count(*) FROM accounting_source_bindings   WHERE business_id = $1)::int AS bindings,
              (SELECT count(*) FROM audit_events                 WHERE business_id = $1)::int AS audits,
              (SELECT count(*) FROM outbox_events                WHERE business_id = $1)::int AS outbox,
              (SELECT count(*) FROM accounting_reversals         WHERE business_id = $1)::int AS reversals`,
      [businessId],
    );
    const row = must(r.rows[0]);
    return { entries: row.entries, sets: row.sets, bindings: row.bindings, audits: row.audits, outbox: row.outbox, reversals: row.reversals };
  }

  /** A digest of one journal entry and its lines — the bytes that must not move. */
  async function journalDigest(entryId: string): Promise<string> {
    const r = await pool.query<{ d: string }>(
      `SELECT md5(string_agg(t, '|' ORDER BY t)) AS d FROM (
         SELECT concat_ws(':', je.id, je.entry_date, je.source_type, je.source_id, je.posting_fingerprint, je.description) AS t
           FROM journal_entries je WHERE je.id = $1
         UNION ALL
         SELECT concat_ws(':', l.line_no, l.account_id, l.debit_minor, l.credit_minor, l.base_currency,
                               l.txn_amount_minor, l.txn_currency, l.fx_rate, l.fx_rate_source) AS t
           FROM journal_lines l WHERE l.journal_entry_id = $1
       ) x`,
      [entryId],
    );
    return must(r.rows[0], 'a journal digest').d;
  }

  /** The opening-balance sets of a business, oldest first, as status words. */
  async function sets(businessId: string): Promise<{ id: string; status: string; entry: string | null }[]> {
    const r = await pool.query<{ id: string; status: string; entry: string | null }>(
      `SELECT id::text AS id, status, journal_entry_id::text AS entry
         FROM accounting_opening_balances WHERE business_id = $1 ORDER BY created_at, id`,
      [businessId],
    );
    return r.rows;
  }

  it('OB1 posted behind the books, refused replacement while closed, reversed, replaced, and still replayable', async () => {
    const b = await books('ob-lifecycle');
    const firstLines = positions();
    const secondLines = [domestic('cash', 'D', 61000n), domestic('bank', 'D', 14000n)];

    // ── §3. OB1, dated strictly before any period exists ──────────────────
    const historic = await daysAgo(400);
    const ob1 = await openBalance(b, 'lifecycle-ob1-key', historic, firstLines);
    expect(ob1.created).toBe(true);
    const ob1Digest = await journalDigest(ob1.entryId);

    // Two periods, so the topology is a real one, then closed oldest first.
    const p1 = (await createPeriod(b, 'lifecycle-period-one', await daysAgo(90), await daysAgo(31))).periodId;
    const p2 = (await createPeriod(b, 'lifecycle-period-two', await daysAgo(30), today)).periodId;
    await closePeriod(b, 'lifecycle-close-one', p1);
    await closePeriod(b, 'lifecycle-close-two', p2);
    expect(await shape(b.businessId)).toEqual(['closed', 'closed']);
    expect((await sets(b.businessId)).map((x) => x.status)).toEqual(['posted']);

    // ── §4. The replacement is refused while the books are closed ─────────
    //
    // Two rules stand between the merchant and a new historical opening
    // position, and the command reports the FIRST one that fails. With OB1
    // still current and unreversed, that is AL-13's own rule — a posted set
    // must be reversed before another is stated — so this attempt names it.
    // The closed-books refusal is proved below on its own, once this one is
    // out of the way, which is the only honest way to prove either.
    const blockedWhileCurrent = await state(b.businessId);
    expect(await refusal(() => openBalance(b, 'lifecycle-ob2-key', historic, secondLines))).toMatch(/accounting\.opening_balance_exists/);
    expect(await state(b.businessId)).toEqual(blockedWhileCurrent);

    // ── §5. Reopen through the real command, newest first ─────────────────
    expect(await refusal(() => reopenPeriod(b, 'lifecycle-reopen-wrong', p1, 'oldest first is not how books reopen'))).toMatch(
      /accounting\.period_reopen_order/,
    );
    await reopenPeriod(b, 'lifecycle-reopen-two', p2, 'restating the opening position');
    expect(await shape(b.businessId)).toEqual(['closed', 'open']);
    await reopenPeriod(b, 'lifecycle-reopen-one', p1, 'restating the opening position');
    expect(await shape(b.businessId)).toEqual(['open', 'open']);

    // Each reopen wrote its own audit and outbox rows, in its own transaction.
    const afterReopen = await state(b.businessId);
    expect(afterReopen.audits).toBe(blockedWhileCurrent.audits + 2);
    expect(afterReopen.outbox).toBe(blockedWhileCurrent.outbox + 2);

    // ── §6 step 1. Reverse OB1, dated inside an OPEN period ───────────────
    //
    // The reversal is an ordinary entry and obeys the period model like any
    // other: its own date must be covered, so it is dated inside the open
    // second period rather than back at the opening position's own date.
    //
    // And it really is subject to it: dated back at the opening position's own
    // date, where no period covers it, the reversal is refused. The
    // replacement lifecycle does not get a private door through P2-S6.
    const beforeReversal = await state(b.businessId);
    expect(await refusal(() => reverseOpening(b, ob1.entryId, historic, firstLines, historic))).toMatch(/accounting\.period_missing_for_date/);
    expect(await state(b.businessId)).toEqual(beforeReversal);

    const reversalDate = await daysAgo(15);
    const reversal = await reverseOpening(b, ob1.entryId, historic, firstLines, reversalDate);
    expect(reversal.created).toBe(true);
    expect(reversal.entryId).not.toBe(ob1.entryId);
    expect(await journalDigest(ob1.entryId)).toBe(ob1Digest);
    expect((await sets(b.businessId)).map((x) => x.status)).toEqual(['posted']);

    // ── §4, isolated. NOW the only thing left is the closed books ─────────
    //
    // Close the books again and try the replacement. AL-13 is satisfied —
    // the current set has been reversed — so the command gets past its own
    // rule and reaches the posting guard, which refuses by the name that
    // belongs to a date lying outside every period.
    await closePeriod(b, 'lifecycle-reclose-one', p1);
    await closePeriod(b, 'lifecycle-reclose-two', p2);
    expect(await shape(b.businessId)).toEqual(['closed', 'closed']);

    const beforeBlocked = await state(b.businessId);
    const blocked = await refusal(() => openBalance(b, 'lifecycle-ob2-key', historic, secondLines));
    expect(blocked).toMatch(/accounting\.period_closed_history/);
    expect(blocked).not.toMatch(/accounting\.period_closed:/);

    // Nothing from the attempt survived — and in particular OB1 was NOT left
    // superseded by a replacement that never posted. The supersession and the
    // insert are one transaction, and this is what says so.
    expect(await state(b.businessId)).toEqual(beforeBlocked);
    expect((await sets(b.businessId)).map((x) => x.status)).toEqual(['posted']);
    expect(await journalDigest(ob1.entryId)).toBe(ob1Digest);

    // ── §5 again, then §6 step 2. The replacement, legally ────────────────
    await reopenPeriod(b, 'lifecycle-reopen-two-b', p2, 'restating the opening position');
    await reopenPeriod(b, 'lifecycle-reopen-one-b', p1, 'restating the opening position');
    expect(await shape(b.businessId)).toEqual(['open', 'open']);

    const ob2 = await openBalance(b, 'lifecycle-ob2-key', historic, secondLines);
    expect(ob2.created).toBe(true);
    expect(ob2.entryId).not.toBe(ob1.entryId);

    // ── §7. The required final state, all of it at once ───────────────────
    const finalSets = await sets(b.businessId);
    expect(finalSets.map((x) => x.status)).toEqual(['superseded', 'posted']);
    expect(must(finalSets[1]).entry).toBe(ob2.entryId);
    expect(must(finalSets[0]).entry).toBe(ob1.entryId);

    const counts = await pool.query<{ posted: number; superseded: number; reversals: number }>(
      `SELECT (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1 AND status = 'posted')::int      AS posted,
              (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1 AND status = 'superseded')::int  AS superseded,
              (SELECT count(*) FROM accounting_reversals        WHERE business_id = $1 AND original_entry_id = $2)::int AS reversals`,
      [b.businessId, ob1.entryId],
    );
    expect(must(counts.rows[0]).posted).toBe(1);
    expect(must(counts.rows[0]).superseded).toBe(1);
    expect(must(counts.rows[0]).reversals).toBe(1);

    // The superseded set is history, not an erasure: its lines are still
    // there and its journal entry has not moved a byte.
    const keptLines = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM accounting_opening_balance_lines WHERE business_id = $1 AND opening_balance_id = $2`,
      [b.businessId, must(finalSets[0]).id],
    );
    expect(must(keptLines.rows[0]).n).toBeGreaterThan(0);
    expect(await journalDigest(ob1.entryId)).toBe(ob1Digest);

    // ── §8. Close again, and the door stays shut ──────────────────────────
    await closePeriod(b, 'lifecycle-final-close-one', p1);
    await closePeriod(b, 'lifecycle-final-close-two', p2);
    expect(await shape(b.businessId)).toEqual(['closed', 'closed']);

    const beforeThird = await state(b.businessId);
    expect(await refusal(() => openBalance(b, 'lifecycle-ob3-key', historic, positions()))).toMatch(/accounting\.opening_balance_exists/);
    expect(await state(b.businessId)).toEqual(beforeThird);

    // ── §9. A retry is still a retry, even though the books closed after ──
    const replay = await openBalance(b, 'lifecycle-ob2-key', historic, secondLines);
    expect(replay.created).toBe(false);
    expect(replay.entryId).toBe(ob2.entryId);
    expect(await state(b.businessId)).toEqual(beforeThird);
    expect((await sets(b.businessId)).map((x) => x.status)).toEqual(['superseded', 'posted']);
  }, 180_000);
});

async function sideEffects(businessId: string): Promise<Record<string, number>> {
  const r = await pool.query<{ entries: number; sets: number; audits: number; outbox: number }>(
    `SELECT (SELECT count(*) FROM journal_entries             WHERE business_id = $1)::int AS entries,
            (SELECT count(*) FROM accounting_opening_balances WHERE business_id = $1)::int AS sets,
            (SELECT count(*) FROM audit_events                WHERE business_id = $1)::int AS audits,
            (SELECT count(*) FROM outbox_events               WHERE business_id = $1)::int AS outbox`,
    [businessId],
  );
  const row = must(r.rows[0]);
  return { entries: row.entries, sets: row.sets, audits: row.audits, outbox: row.outbox };
}

// ── §24: the invariant asked of the DATABASE, not of the commands ─────────

/**
 * These cases bypass every command and are issued as the SCHEMA OWNER — the
 * one principal no privilege check can stop. If the topology rule lived in
 * `accounting_period_close()` alone, every one of them would commit.
 *
 * They are also the proof that the constraint is DEFERRED: each statement
 * succeeds, and it is COMMIT that refuses. A rule checked per statement could
 * not express "the final shape of this set", and would refuse valid
 * intermediate states along the way.
 */
describe('the topology invariant asked directly, as the schema owner (§24)', () => {
  interface Slot {
    start: string;
    end: string;
    close?: boolean;
  }

  /** Write these periods in one transaction and try to COMMIT. Returns '' on success. */
  async function attempt(businessId: string, tenantId: string, userId: string, slots: readonly Slot[]): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const slot of slots) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO accounting_periods (tenant_id, business_id, id, start_date, end_date, status, created_by_user_id)
           VALUES ($1, $2, $3, $4::date, $5::date, 'open', $6)`,
          [tenantId, businessId, id, slot.start, slot.end, userId],
        );
        if (slot.close === true) {
          // The transition trigger still applies: closing records who and
          // when. What it does NOT know is anything about the other periods.
          await client.query(`UPDATE accounting_periods SET status = 'closed', closed_at = now(), closed_by_user_id = $2 WHERE id = $1`, [id, userId]);
        }
      }
      await client.query('COMMIT');
      return '';
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      return e instanceof Error ? e.message : String(e);
    } finally {
      client.release();
    }
  }

  const span = async (from: number, to: number): Promise<Slot> => ({ start: await daysAgo(from), end: await daysAgo(to) });

  it('OPEN CLOSED cannot commit', async () => {
    const b = await books('raw-open-closed');
    const message = await attempt(b.businessId, b.tenantId, b.userId, [await span(60, 31), { ...(await span(30, 1)), close: true }]);
    expect(message).toMatch(/accounting\.period_topology_invalid/);
    expect(await shape(b.businessId)).toEqual([]);
  }, 120_000);

  it('CLOSED OPEN CLOSED cannot commit', async () => {
    const b = await books('raw-sandwich');
    const message = await attempt(b.businessId, b.tenantId, b.userId, [
      { ...(await span(90, 61)), close: true },
      await span(60, 31),
      { ...(await span(30, 1)), close: true },
    ]);
    expect(message).toMatch(/accounting\.period_topology_invalid/);
    expect(await shape(b.businessId)).toEqual([]);
  }, 120_000);

  it('a GAP in the chain cannot commit', async () => {
    const b = await books('raw-gap');
    const message = await attempt(b.businessId, b.tenantId, b.userId, [await span(90, 61), await span(30, 1)]);
    expect(message).toMatch(/accounting\.period_not_contiguous/);
    expect(await shape(b.businessId)).toEqual([]);
  }, 120_000);

  it('CLOSED CLOSED OPEN OPEN commits', async () => {
    // Without this case the three above could pass forever because the
    // trigger refused everything.
    const b = await books('raw-valid');
    const message = await attempt(b.businessId, b.tenantId, b.userId, [
      { ...(await span(120, 91)), close: true },
      { ...(await span(90, 61)), close: true },
      await span(60, 31),
      await span(30, 1),
    ]);
    expect(message).toBe('');
    expect(await shape(b.businessId)).toEqual(['closed', 'closed', 'open', 'open']);
  }, 120_000);

  it('the refusal happens at COMMIT, not at the statement — the constraint is DEFERRED', async () => {
    const b = await books('raw-deferred');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const early = await span(60, 31);
      const late = await span(30, 1);
      const earlyId = randomUUID();
      const lateId = randomUUID();
      for (const [id, s] of [
        [earlyId, early],
        [lateId, late],
      ] as const) {
        await client.query(
          `INSERT INTO accounting_periods (tenant_id, business_id, id, start_date, end_date, status, created_by_user_id)
           VALUES ($1, $2, $3, $4::date, $5::date, 'open', $6)`,
          [b.tenantId, b.businessId, id, s.start, s.end, b.userId],
        );
      }
      // The later period is closed while the earlier one is open. The
      // statement itself is accepted…
      await client.query(`UPDATE accounting_periods SET status = 'closed', closed_at = now(), closed_by_user_id = $2 WHERE id = $1`, [lateId, b.userId]);
      const seen = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_periods WHERE business_id = $1 AND status = 'closed'`, [
        b.businessId,
      ]);
      expect(must(seen.rows[0]).n).toBe(1);

      // …and COMMIT is what refuses it.
      let message = '';
      try {
        await client.query('COMMIT');
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/accounting\.period_topology_invalid/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await shape(b.businessId)).toEqual([]);
  }, 120_000);
});
