import { randomUUID } from 'node:crypto';
import { deriveSourceId } from '@daftar/accounting';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  fingerprintOf,
  must,
  openingBalanceFingerprintOf,
  openingBalanceSnapshot,
  post,
  postAdjustmentAs,
  postOpeningBalanceAs,
  postReversalAs,
  refusal,
  reversalFingerprintOf,
  reversalFingerprintOfSnapshot,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostLine,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * MATRIX — TRANSPORT IDEMPOTENCY ACROSS EVERY P2-S4 SOURCE (§8-§14, §29).
 *
 * An idempotency key is not permission to ignore a different financial
 * request. The whole matrix below turns on one question asked three times,
 * once per source: when the SAME source identity arrives carrying DIFFERENT
 * money, does the ledger refuse, or does it answer "success" and hand back
 * the money that is already there?
 *
 * Every case derives its source identity the way the merchant API derives it
 * — `deriveSourceId(businessId, idempotencyKey)` — so the identity under test
 * is the real transport identity and not a UUID invented by the test. The
 * fingerprint is likewise computed by the engine's own derivation from the
 * submitted payload, because a test that signed the PERSISTED payload would
 * agree with the database by construction and prove nothing.
 */

let fx: PostingFixture;
let today: string;

const AT = new Date('2026-03-14T09:15:00Z');

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'idem');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
}, 180_000);

// ── shared construction ───────────────────────────────────────────────────

/** A business of its own: the one-posted-set rule makes every case a new tenant. */
async function freshBusiness(label: string): Promise<PostingFixture> {
  return seedPostingFixture(ownerPool(), `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
}

/** A domestic position, stated in the business's base currency. */
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

/**
 * A foreign position carrying a full manual snapshot. Every field §9 asks to
 * mutate independently is present here, which is why the base set below has
 * one of these in it: a matrix over a purely domestic position could not vary
 * the transaction currency, the rate, its source or its instant at all.
 */
const foreign = (): PostLine => ({
  account: { kind: 'system', systemKey: 'bank' },
  side: 'D',
  baseAmountMinor: 30000n,
  baseCurrency: 'ILS',
  txnAmountMinor: 8000n,
  txnCurrency: 'USD',
  fxRate: '3.75',
  fxRateSource: 'manual',
  fxRateAt: AT,
  memo: null,
});

const basePositions = (): PostLine[] => [domestic('cash', 'D', 50000n), foreign()];

interface OpeningAttempt {
  entryId: string;
  created: boolean;
}

/**
 * The merchant path for an opening balance, entered at the transport layer:
 * an `Idempotency-Key` in, a posted entry out. The source identity, the
 * derived lines and the signed fingerprint are all produced from the payload
 * being submitted right now — exactly as `AccountingSourcesService` does it.
 */
async function openBalanceWithKey(
  who: PostingFixture,
  idempotencyKey: string,
  input: { positions: readonly PostLine[]; asOfDate?: string; requestId?: string },
): Promise<OpeningAttempt> {
  const asOfDate = input.asOfDate ?? today;
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
      positions: input.positions,
    }),
  });
  return postOpeningBalanceAs(assertion, {
    asOfDate,
    positions: input.positions,
    openingBalanceId,
    description: 'opening position',
    requestId: input.requestId ?? randomUUID(),
  });
}

interface LedgerCounts {
  entries: number;
  bindings: number;
  sets: number;
  positions: number;
  audits: number;
  outbox: number;
}

/** Everything a second posting would have to add to, counted in one read. */
async function countsFor(businessId: string): Promise<LedgerCounts> {
  return must(
    (
      await ownerPool().query<LedgerCounts>(
        `SELECT (SELECT count(*) FROM journal_entries               WHERE business_id = $1)::int AS entries,
                (SELECT count(*) FROM accounting_source_bindings    WHERE business_id = $1)::int AS bindings,
                (SELECT count(*) FROM accounting_opening_balances   WHERE business_id = $1)::int AS sets,
                (SELECT count(*) FROM accounting_opening_balance_lines WHERE business_id = $1)::int AS positions,
                (SELECT count(*) FROM audit_events                  WHERE business_id = $1)::int AS audits,
                (SELECT count(*) FROM outbox_events                 WHERE business_id = $1)::int AS outbox`,
        [businessId],
      )
    ).rows[0],
  );
}

/** The persisted positions, in a form a test can compare for byte equality. */
async function positionsOf(businessId: string): Promise<string> {
  const r = await ownerPool().query(
    `SELECT line_no, account_ref_kind, account_system_key, account_code, side, base_amount_minor, base_currency,
            txn_amount_minor, txn_currency, fx_rate, fx_rate_source, fx_rate_at, memo
     FROM accounting_opening_balance_lines WHERE business_id = $1 ORDER BY opening_balance_id, line_no`,
    [businessId],
  );
  return JSON.stringify(r.rows);
}

async function fingerprintOfEntry(businessId: string, entryId: string): Promise<string> {
  const r = await ownerPool().query<{ fp: string }>(`SELECT posting_fingerprint AS fp FROM journal_entries WHERE business_id = $1 AND id = $2`, [
    businessId,
    entryId,
  ]);
  return must(r.rows[0]).fp;
}

// ── §8 the mandatory regression ───────────────────────────────────────────

describe('same key, different amount (§8)', () => {
  it('refuses with accounting.idempotency_conflict and adds nothing to the ledger', async () => {
    const b = await freshBusiness('idem-amount');
    const key = 'opening-balance-key-0001';

    const first = await openBalanceWithKey(b, key, { positions: basePositions() });
    expect(first.created).toBe(true);

    const before = await countsFor(b.businessId);
    const positionsBefore = await positionsOf(b.businessId);
    const fingerprintBefore = await fingerprintOfEntry(b.businessId, first.entryId);

    // One financial amount changed, and nothing else in the request.
    const mutated = basePositions();
    must(mutated[0]).baseAmountMinor = 50001n;
    must(mutated[0]).txnAmountMinor = 50001n;

    const message = await refusal(() => openBalanceWithKey(b, key, { positions: mutated }));
    expect(message).toMatch(/accounting\.idempotency_conflict/);
    // §20: a stable domain code, never the money it was protecting.
    expect(message).not.toMatch(/50000|50001|30000|8000|3\.75|duplicate key|unique constraint|23505|_uq\b/);

    expect(await countsFor(b.businessId)).toEqual(before);
    expect(await positionsOf(b.businessId)).toBe(positionsBefore);
    expect(await fingerprintOfEntry(b.businessId, first.entryId)).toBe(fingerprintBefore);
  });
});

// ── §9 the complete financial-mutation matrix ─────────────────────────────

/**
 * Nine independent mutations of one already-posted opening balance, each
 * re-submitted under the SAME idempotency key. Testing one amount and
 * assuming the rest is exactly the assumption that let the original defect
 * through, so every field acctfp/1 carries gets its own case.
 */
const MUTATIONS: ReadonlyArray<{ name: string; apply: (p: PostLine[]) => void; asOfDate?: (base: string) => string }> = [
  { name: 'base amount', apply: (p) => void (must(p[1]).baseAmountMinor = 30500n) },
  { name: 'side', apply: (p) => void (must(p[0]).side = 'C') },
  { name: 'account identity', apply: (p) => void (must(p[0]).account = { kind: 'system', systemKey: 'inventory' }) },
  { name: 'transaction amount', apply: (p) => void (must(p[1]).txnAmountMinor = 8100n) },
  { name: 'transaction currency', apply: (p) => void (must(p[1]).txnCurrency = 'EUR') },
  { name: 'fx rate', apply: (p) => void (must(p[1]).fxRate = '3.8') },
  { name: 'fx rate source', apply: (p) => void (must(p[1]).fxRateSource = 'base') },
  { name: 'fx rate instant', apply: (p) => void (must(p[1]).fxRateAt = new Date('2026-03-14T09:15:01Z')) },
  { name: 'as-of date', apply: () => undefined, asOfDate: (base) => shiftDate(base, -1) },
];

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('the financial mutation matrix (§9)', () => {
  it.each(MUTATIONS)('same key, changed $name → accounting.idempotency_conflict', async ({ name, apply, asOfDate }) => {
    const b = await freshBusiness(`idem-${name.replace(/\s+/g, '-')}`);
    const key = `opening-balance-key-${name.replace(/\s+/g, '-')}`;

    const first = await openBalanceWithKey(b, key, { positions: basePositions() });
    expect(first.created).toBe(true);
    const before = await countsFor(b.businessId);

    const mutated = basePositions();
    apply(mutated);
    const message = await refusal(() => openBalanceWithKey(b, key, { positions: mutated, asOfDate: asOfDate?.(today) }));

    expect(message, name).toMatch(/accounting\.idempotency_conflict/);
    expect(await countsFor(b.businessId)).toEqual(before);
  });
});

// ── §10 canonical equivalence ─────────────────────────────────────────────

/**
 * acctfp/1 sorts lines by their canonical field bytes and normalizes a rate
 * to exactly ten fraction digits. Two submissions that differ only in those
 * respects are therefore the SAME financial fact, and the ledger must replay
 * rather than conflict. These are the canonical contract's own equivalences,
 * not equivalences this test invented.
 */
describe('canonically equivalent retries replay (§10)', () => {
  it('positions submitted in a different order are the same fact', async () => {
    const b = await freshBusiness('idem-order');
    const key = 'opening-balance-key-order';
    const first = await openBalanceWithKey(b, key, { positions: basePositions() });
    const before = await countsFor(b.businessId);

    const reordered = basePositions().reverse();
    const second = await openBalanceWithKey(b, key, { positions: reordered });

    expect(second.entryId).toBe(first.entryId);
    expect(second.created).toBe(false);
    expect(await countsFor(b.businessId)).toEqual(before);
  });

  it('a rate written with fewer digits normalizes to the same fact', async () => {
    const b = await freshBusiness('idem-rate-text');
    const key = 'opening-balance-key-rate-text';
    const first = await openBalanceWithKey(b, key, { positions: basePositions() });
    const before = await countsFor(b.businessId);

    // '3.75' and '3.7500000000' are one rate under canonicalRate, and the
    // column is NUMERIC(20,10), so the ledger could not tell them apart
    // either. The value did not change; only the way it was written did.
    const restated = basePositions();
    must(restated[1]).fxRate = '3.7500000000';
    const second = await openBalanceWithKey(b, key, { positions: restated });

    expect(second.entryId).toBe(first.entryId);
    expect(second.created).toBe(false);
    expect(await countsFor(b.businessId)).toEqual(before);
  });
});

// ── §11 the exact retry ───────────────────────────────────────────────────

describe('an exact retry replays (§11)', () => {
  it('returns the same entry, creates nothing, and writes no second event', async () => {
    const b = await freshBusiness('idem-exact');
    const key = 'opening-balance-key-exact';
    const first = await openBalanceWithKey(b, key, { positions: basePositions(), requestId: 'req-one' });
    expect(first.created).toBe(true);
    const before = await countsFor(b.businessId);

    // A new request id only: narrative, outside acctfp/1, and therefore the
    // same financial fact (§7).
    const second = await openBalanceWithKey(b, key, { positions: basePositions(), requestId: 'req-two' });

    expect(second.entryId).toBe(first.entryId);
    expect(second.created).toBe(false);
    expect(await countsFor(b.businessId)).toEqual(before);

    const domain = must(
      (
        await ownerPool().query<{ audits: number; outbox: number }>(
          `SELECT (SELECT count(*) FROM audit_events  WHERE business_id = $1 AND action = 'accounting.opening_balance_posted')::int AS audits,
                  (SELECT count(*) FROM outbox_events WHERE business_id = $1 AND type   = 'accounting.opening_balance.posted')::int AS outbox`,
          [b.businessId],
        )
      ).rows[0],
    );
    expect(domain).toEqual({ audits: 1, outbox: 1 });

    // §7, §19: the posted narrative is NOT rewritten to the latest retry.
    const head = must(
      (
        await ownerPool().query<{ request_id: string }>(`SELECT request_id FROM journal_entries WHERE business_id = $1 AND id = $2`, [
          b.businessId,
          first.entryId,
        ])
      ).rows[0],
    );
    expect(head.request_id).toBe('req-one');
  });
});

// ── §14 the same three questions, asked of the other two sources ──────────

describe('idempotency audit — manual adjustment (§14, §16)', () => {
  const adjustmentFor = (who: PostingFixture, sourceId: string, amount: bigint): PostCommand =>
    simpleCommand(who, sourceId, today, amount, 'manual_adjustment');

  async function adjust(who: PostingFixture, key: string, amount: bigint, reason: string): Promise<OpeningAttempt> {
    const sourceId = deriveSourceId(who.businessId, key);
    const command = { ...adjustmentFor(who, sourceId, amount), requestId: randomUUID() };
    const assertion = sourceAssertion({
      actorUserId: who.userId,
      tenantId: who.tenantId,
      businessId: who.businessId,
      operationKind: 'post',
      sourceType: 'manual_adjustment',
      sourceId,
      postingFingerprint: fingerprintOf(command),
    });
    return postAdjustmentAs(assertion, command, reason);
  }

  it('same source + same financial fact → the existing entry, created=false', async () => {
    const b = await freshBusiness('idem-adj-same');
    const key = 'adjustment-key-same';
    const first = await adjust(b, key, 150000n, 'the original reason');
    const before = await countsFor(b.businessId);
    const second = await adjust(b, key, 150000n, 'the original reason');
    expect(second.entryId).toBe(first.entryId);
    expect(second.created).toBe(false);
    expect(await countsFor(b.businessId)).toEqual(before);
  });

  it('same source + materially different financial fact → accounting.idempotency_conflict', async () => {
    const b = await freshBusiness('idem-adj-diff');
    const key = 'adjustment-key-diff';
    await adjust(b, key, 150000n, 'the original reason');
    const before = await countsFor(b.businessId);
    const message = await refusal(() => adjust(b, key, 150001n, 'the original reason'));
    expect(message).toMatch(/accounting\.idempotency_conflict/);
    expect(await countsFor(b.businessId)).toEqual(before);
  });

  it('same source + narrative-only difference → replays, and the posted reason is not rewritten', async () => {
    const b = await freshBusiness('idem-adj-narr');
    const key = 'adjustment-key-narrative';
    const first = await adjust(b, key, 150000n, 'the original reason');
    const before = await countsFor(b.businessId);
    const second = await adjust(b, key, 150000n, 'a reworded reason');

    expect(second.entryId).toBe(first.entryId);
    expect(second.created).toBe(false);
    expect(await countsFor(b.businessId)).toEqual(before);

    // §16: posted truth is immutable, narrative included.
    const stored = must(
      (
        await ownerPool().query<{ reason: string }>(`SELECT reason FROM accounting_manual_adjustments WHERE business_id = $1 AND id = $2`, [
          b.businessId,
          deriveSourceId(b.businessId, key),
        ])
      ).rows[0],
    );
    expect(stored.reason).toBe('the original reason');
  });
});

describe('idempotency audit — reversal (§14, §15)', () => {
  async function reverse(who: PostingFixture, command: PostCommand, entryId: string, entryDate: string, reason: string): Promise<OpeningAttempt> {
    const assertion = sourceAssertion({
      actorUserId: who.userId,
      tenantId: who.tenantId,
      businessId: who.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: entryId,
      postingFingerprint: reversalFingerprintOf(command, entryId, entryDate),
    });
    return postReversalAs(assertion, entryId, entryDate, reason, randomUUID());
  }

  it('same source + same financial fact → the existing reversal, created=false', async () => {
    const command = simpleCommand(fx, randomUUID(), today, 150000n, 'manual_adjustment');
    const original = await post(command, fx.userId);
    const first = await reverse(fx, command, original.entryId, today, 'the correction');
    const second = await reverse(fx, command, original.entryId, today, 'the correction');
    expect(second.entryId).toBe(first.entryId);
    expect(second.created).toBe(false);
  });

  it('same source + a different reversal date → refused, never replayed', async () => {
    // The original is backdated so that TWO legal reversal dates exist. With
    // an original dated today the date policy would refuse the retry before
    // the replay comparison was ever reached, and the case would pass while
    // proving nothing about idempotency.
    const origin = shiftDate(today, -3);
    const command = simpleCommand(fx, randomUUID(), origin, 150000n, 'manual_adjustment');
    const original = await post(command, fx.userId);
    await reverse(fx, command, original.entryId, today, 'the correction');
    // A reversal's financial identity IS the original entry, so a second
    // reversal of it can never be new truth — the refusal names that, rather
    // than a generic conflict.
    const message = await refusal(() => reverse(fx, command, original.entryId, shiftDate(today, -1), 'the correction'));
    expect(message).toMatch(/accounting\.reversal_exists/);
  });

  it('same source + a different reason is a different fact, and is refused (§15)', async () => {
    const command = simpleCommand(fx, randomUUID(), today, 150000n, 'manual_adjustment');
    const original = await post(command, fx.userId);
    await reverse(fx, command, original.entryId, today, 'the first reason');
    const message = await refusal(() => reverse(fx, command, original.entryId, today, 'a different reason'));
    expect(message).toMatch(/accounting\.reversal_exists/);

    const stored = must(
      (
        await ownerPool().query<{ reason: string }>(`SELECT reason FROM accounting_reversals WHERE business_id = $1 AND original_entry_id = $2`, [
          fx.businessId,
          original.entryId,
        ])
      ).rows[0],
    );
    expect(stored.reason).toBe('the first reason');
  });
});

// ── §17 the replacement lifecycle still works after the fix ───────────────

describe('replacement still works (§17)', () => {
  it('reverse, supersede, and post a new opening balance under a NEW key', async () => {
    const b = await freshBusiness('idem-replace');
    const positions = basePositions();
    const first = await openBalanceWithKey(b, 'opening-balance-key-replace-1', { positions });

    const lines = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_lines WHERE business_id = $1 AND journal_entry_id = $2`, [
      b.businessId,
      first.entryId,
    ]);
    expect(must(lines.rows[0]).n).toBe(positions.length + 1);

    // The opening entry is reversed, which is an accounting fact of its own
    // and the precondition the database checks before any supersession.
    const snapshot = openingBalanceSnapshot({
      entryId: first.entryId,
      tenantId: b.tenantId,
      businessId: b.businessId,
      asOfDate: today,
      baseCurrency: 'ILS',
      positions,
    });
    await postReversalAs(
      sourceAssertion({
        actorUserId: b.userId,
        tenantId: b.tenantId,
        businessId: b.businessId,
        operationKind: 'reverse',
        sourceType: 'reversal',
        sourceId: first.entryId,
        postingFingerprint: reversalFingerprintOfSnapshot(snapshot, today),
      }),
      first.entryId,
      today,
      'replacing the opening position',
      randomUUID(),
    );

    // A replacement is a NEW request with a NEW key, so it carries a new
    // source identity. The old key is never made reusable (§19).
    const second = await openBalanceWithKey(b, 'opening-balance-key-replace-2', { positions: [domestic('cash', 'D', 77000n)] });
    expect(second.created).toBe(true);
    expect(second.entryId).not.toBe(first.entryId);

    const states = await ownerPool().query<{ status: string }>(`SELECT status FROM accounting_opening_balances WHERE business_id = $1`, [b.businessId]);
    expect(states.rows.map((r) => r.status).sort()).toEqual(['posted', 'superseded']);
  });
});
