import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  appClient,
  fingerprintOf,
  must,
  openingBalanceFingerprintOf,
  post,
  postAdjustmentAs,
  postOpeningBalanceAs,
  openingBalanceSnapshot,
  positionPayload,
  postReversalAs,
  rate10,
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
 * MATRIX — P2-S4 ACCOUNTING-NATIVE SOURCES (directive §10-§34, §40-§44, §53).
 *
 * Three workflows, one law: a correction in accounting is another accounting
 * fact. Nothing here edits, deletes or rewrites a posted entry, and every
 * case goes through the real boundary as `daftar_app` carrying a real minted
 * assertion — the same path the merchant API takes.
 *
 * Authority is proved separately in
 * `tests/security/accounting-sources-authority.test.ts`. These cases assume a
 * caller who is entitled and ask the other question: does the workflow write
 * the right fact, and does it refuse the wrong one for the right reason?
 */

let fx: PostingFixture;
let today: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), 'sources');
  today = await todayIn(ownerPool(), 'Asia/Hebron');
}, 180_000);

// ── shared construction ───────────────────────────────────────────────────

const AT = new Date('2026-03-14T09:15:00Z');

/**
 * A well-formed fingerprint that describes nothing. The cases that use it
 * refuse BEFORE the fingerprint is compared, so its value is irrelevant — but
 * it must still be sha-256 shaped, because a malformed assertion would refuse
 * for the wrong reason and prove nothing about the rule under test.
 */
const UNREACHABLE_FINGERPRINT = 'f'.repeat(64);

/** A balanced adjustment command — the caller's own lines, as §40 requires. */
const adjustment = (sourceId: string = randomUUID(), entryDate: string = today, amount = 150000n): PostCommand =>
  simpleCommand(fx, sourceId, entryDate, amount, 'manual_adjustment');

const adjustmentAssertion = (c: PostCommand, actorUserId: string = fx.userId): string =>
  sourceAssertion({
    actorUserId,
    tenantId: c.tenantId,
    businessId: c.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });

/** Reverse an entry through the real writer, deriving the mirror in the test. */
async function reverse(
  original: { entryId: string },
  originalCmd: PostCommand,
  options: { entryDate?: string | null; reason?: string; requestId?: string | null; actorUserId?: string } = {},
): Promise<{ entryId: string; created: boolean }> {
  const date = options.entryDate === undefined ? today : options.entryDate;
  const assertion = sourceAssertion({
    actorUserId: options.actorUserId ?? fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    operationKind: 'reverse',
    sourceType: 'reversal',
    sourceId: original.entryId,
    postingFingerprint: reversalFingerprintOf(originalCmd, original.entryId, date ?? today),
  });
  return postReversalAs(assertion, original.entryId, date, options.reason ?? 'a considered correction', options.requestId ?? randomUUID());
}

/**
 * Reverse an entry whose lines the ENGINE derived — an opening balance. The
 * mirror is still derived independently in the test; only its starting point
 * differs, because no test writes the equity plug by hand.
 */
async function reverseOpeningBalance(
  entryId: string,
  input: { asOfDate: string; positions: readonly PostLine[] },
  reason = 'replacing the opening position',
): Promise<{ entryId: string; created: boolean }> {
  const snap = openingBalanceSnapshot({
    entryId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    asOfDate: input.asOfDate,
    baseCurrency: 'ILS',
    positions: input.positions,
  });
  const assertion = sourceAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    operationKind: 'reverse',
    sourceType: 'reversal',
    sourceId: entryId,
    postingFingerprint: reversalFingerprintOfSnapshot(snap, today),
  });
  return postReversalAs(assertion, entryId, today, reason, randomUUID());
}

interface EntryRow {
  id: string;
  entry_date: string;
  source_type: string;
  source_id: string;
  posting_fingerprint: string;
  description: string | null;
  actor_user_id: string;
}

interface LineRow {
  line_no: number;
  account_id: string;
  debit_minor: string;
  credit_minor: string;
  base_amount_minor: string;
  base_currency: string;
  txn_amount_minor: string;
  txn_currency: string;
  fx_rate: string;
  fx_rate_source: string;
  fx_rate_at: string;
  branch_id: string | null;
  warehouse_id: string | null;
}

async function entryOf(entryId: string): Promise<EntryRow> {
  const r = await ownerPool().query<EntryRow>(
    `SELECT id, to_char(entry_date,'YYYY-MM-DD') AS entry_date, source_type, source_id::text AS source_id,
            posting_fingerprint, description, actor_user_id::text AS actor_user_id
       FROM journal_entries WHERE business_id = $1 AND id = $2`,
    [fx.businessId, entryId],
  );
  return must(r.rows[0], 'journal entry');
}

async function linesOf(entryId: string): Promise<LineRow[]> {
  const r = await ownerPool().query<LineRow>(
    `SELECT line_no, account_id::text AS account_id, debit_minor::text AS debit_minor, credit_minor::text AS credit_minor,
            base_amount_minor::text AS base_amount_minor, base_currency, txn_amount_minor::text AS txn_amount_minor,
            txn_currency, fx_rate::text AS fx_rate, fx_rate_source,
            to_char(fx_rate_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS fx_rate_at,
            branch_id::text AS branch_id, warehouse_id::text AS warehouse_id
       FROM journal_lines WHERE business_id = $1 AND journal_entry_id = $2 ORDER BY line_no`,
    [fx.businessId, entryId],
  );
  return r.rows;
}

/** Everything about an entry that a reversal must not disturb. */
async function snapshot(entryId: string): Promise<string> {
  const head = await entryOf(entryId);
  const lines = await linesOf(entryId);
  return JSON.stringify({ head, lines });
}

async function createAccount(code: string, type = 'asset'): Promise<string> {
  const r = await ownerPool().query<{ id: string }>(`INSERT INTO accounts (tenant_id, business_id, code, name, type) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
    fx.tenantId,
    fx.businessId,
    code,
    `Custom ${code}`,
    type,
  ]);
  return must(r.rows[0], 'account').id;
}

async function countEvents(entryId: string): Promise<{ audit: number; outbox: number }> {
  const a = await ownerPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND action = 'accounting.entry_reversed' AND entity_id = $2`,
    [fx.businessId, entryId],
  );
  const o = await ownerPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox_events WHERE business_id = $1 AND type = 'accounting.entry.reversed' AND payload->>'entryId' = $2`,
    [fx.businessId, entryId],
  );
  return { audit: must(a.rows[0]).n, outbox: must(o.rows[0]).n };
}

// ── §40 MANUAL ADJUSTMENT ─────────────────────────────────────────────────

describe('manual adjustment (§10, §40)', () => {
  it('posts a balanced two-line adjustment and registers its detail row in the same transaction', async () => {
    const c = adjustment();
    const out = await postAdjustmentAs(adjustmentAssertion(c), c, 'reclassify a misfiled receipt');
    expect(out.created).toBe(true);

    const head = await entryOf(out.entryId);
    expect(head.source_type).toBe('manual_adjustment');
    expect(head.source_id).toBe(c.sourceId);

    const detail = await ownerPool().query<{ reason: string; id: string }>(
      `SELECT reason, id::text AS id FROM accounting_manual_adjustments WHERE business_id = $1 AND id = $2`,
      [fx.businessId, c.sourceId],
    );
    expect(must(detail.rows[0]).reason).toBe('reclassify a misfiled receipt');

    const binding = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM accounting_source_bindings
        WHERE business_id = $1 AND source_type = 'manual_adjustment' AND source_id = $2 AND journal_entry_id = $3`,
      [fx.businessId, c.sourceId, out.entryId],
    );
    expect(must(binding.rows[0]).n).toBe(1);
  });

  it('is idempotent on the financial identity: the same source id returns the same entry', async () => {
    const c = adjustment();
    const first = await postAdjustmentAs(adjustmentAssertion(c), c, 'same reason');
    const again = await postAdjustmentAs(adjustmentAssertion(c), c, 'same reason');
    expect(again.created).toBe(false);
    expect(again.entryId).toBe(first.entryId);

    const n = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_id = $2`, [
      fx.businessId,
      c.sourceId,
    ]);
    expect(must(n.rows[0]).n).toBe(1);
  });

  it('refuses an empty reason', async () => {
    const c = adjustment();
    expect(await refusal(() => postAdjustmentAs(adjustmentAssertion(c), c, '   '))).toMatch(/adjustment_reason_required/);
  });

  it('refuses a single-line adjustment, an unbalanced one and one naming an inactive account', async () => {
    const one = adjustment();
    one.lines = [must(one.lines[0])];
    expect(await refusal(() => postAdjustmentAs(adjustmentAssertion(one), one, 'too few'))).toMatch(/payload_invalid|too_few_lines/);

    const skewed = adjustment();
    must(skewed.lines[1]).baseAmountMinor = 149999n;
    must(skewed.lines[1]).txnAmountMinor = 149999n;
    expect(await refusal(() => postAdjustmentAs(adjustmentAssertion(skewed), skewed, 'skewed'))).toMatch(/unbalanced|payload_invalid/);

    const code = `ADJ${Date.now() % 100000}`;
    const acct = await createAccount(code);
    await ownerPool().query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND id = $2`, [fx.businessId, acct]);
    const dead = adjustment();
    must(dead.lines[0]).account = { kind: 'code', code };
    expect(await refusal(() => postAdjustmentAs(adjustmentAssertion(dead), dead, 'dead account'))).toMatch(/account_inactive/);
  });

  it('refuses a future date and permits a backdated one', async () => {
    const future = await ownerPool().query<{ d: string }>(`SELECT to_char(((now() AT TIME ZONE 'Asia/Hebron')::date + 1),'YYYY-MM-DD') AS d`);
    const ahead = adjustment(randomUUID(), must(future.rows[0]).d);
    expect(await refusal(() => postAdjustmentAs(adjustmentAssertion(ahead), ahead, 'tomorrow'))).toMatch(/entry_date_in_future/);

    const back = adjustment(randomUUID(), '2025-01-15');
    expect((await postAdjustmentAs(adjustmentAssertion(back), back, 'last year')).created).toBe(true);
  });

  it('never mutates after posting — the detail row is immutable and the entry is untouched', async () => {
    const c = adjustment();
    const out = await postAdjustmentAs(adjustmentAssertion(c), c, 'original reason');
    const before = await snapshot(out.entryId);

    await expect(
      ownerPool().query(`UPDATE accounting_manual_adjustments SET reason = 'rewritten' WHERE business_id = $1 AND id = $2`, [fx.businessId, c.sourceId]),
    ).rejects.toThrow(/source_immutable/);
    await expect(
      ownerPool().query(`DELETE FROM accounting_manual_adjustments WHERE business_id = $1 AND id = $2`, [fx.businessId, c.sourceId]),
    ).rejects.toThrow(/source_immutable/);
    expect(await snapshot(out.entryId)).toBe(before);
  });

  it('writes the standard posted event, not a new one', async () => {
    const c = adjustment();
    const out = await postAdjustmentAs(adjustmentAssertion(c), c, 'event shape');
    const r = await ownerPool().query<{ type: string }>(`SELECT type FROM outbox_events WHERE business_id = $1 AND payload->>'entryId' = $2`, [
      fx.businessId,
      out.entryId,
    ]);
    expect(r.rows.map((x) => x.type)).toEqual(['accounting.entry.posted']);
  });
});

// ── §12-§21, §41-§42 REVERSAL ─────────────────────────────────────────────

describe('reversal (§12-§21, §41, §42)', () => {
  it('mirrors a domestic entry exactly, swapping only the sides', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    const before = await snapshot(original.entryId);

    const rev = await reverse(original, c);
    expect(rev.created).toBe(true);

    const originalLines = await linesOf(original.entryId);
    const mirrored = await linesOf(rev.entryId);
    expect(mirrored).toHaveLength(originalLines.length);
    for (const [i, src] of originalLines.entries()) {
      const dst = must(mirrored[i]);
      expect(dst.debit_minor).toBe(src.credit_minor);
      expect(dst.credit_minor).toBe(src.debit_minor);
      expect(dst.account_id).toBe(src.account_id);
      expect(dst.base_amount_minor).toBe(src.base_amount_minor);
      expect(dst.base_currency).toBe(src.base_currency);
      expect(dst.txn_amount_minor).toBe(src.txn_amount_minor);
      expect(dst.txn_currency).toBe(src.txn_currency);
      expect(dst.fx_rate).toBe(src.fx_rate);
      expect(dst.fx_rate_source).toBe(src.fx_rate_source);
      expect(dst.fx_rate_at).toBe(src.fx_rate_at);
      expect(dst.branch_id).toBe(src.branch_id);
      expect(dst.warehouse_id).toBe(src.warehouse_id);
    }

    // §12: the original is byte-for-byte what it was.
    expect(await snapshot(original.entryId)).toBe(before);
  });

  it('is a NEW entry bound to the original — the original carries no reversal marker', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    const rev = await reverse(original, c);
    expect(rev.entryId).not.toBe(original.entryId);

    const head = await entryOf(rev.entryId);
    expect(head.source_type).toBe('reversal');
    expect(head.source_id).toBe(original.entryId);

    // §12: journal_entries must never grow a reversal column.
    const cols = await ownerPool().query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'journal_entries'`);
    const names = cols.rows.map((r) => r.column_name);
    for (const forbidden of ['reversed', 'reversed_at', 'reversed_by_entry_id', 'is_reversed', 'voided', 'void_reason']) {
      expect(names).not.toContain(forbidden);
    }
    // `status` exists and is frozen P2-S2 truth: posted is the ONLY value a
    // journal entry ever has, before and after a reversal (§10).
    const statuses = await ownerPool().query<{ status: string }>(`SELECT DISTINCT status FROM journal_entries WHERE business_id = $1`, [fx.businessId]);
    expect(statuses.rows.map((r) => r.status)).toEqual(['posted']);
  });

  it('carries the original FX snapshot, never today’s rate', async () => {
    const c = adjustment();
    const at = new Date('2025-02-03T11:22:33Z');
    c.entryDate = '2025-02-03';
    c.lines = [
      {
        account: { kind: 'system', systemKey: 'cash' },
        side: 'D',
        baseAmountMinor: 36000n,
        baseCurrency: 'ILS',
        txnAmountMinor: 10000n,
        txnCurrency: 'USD',
        fxRate: '3.6',
        fxRateSource: 'manual',
        fxRateAt: at,
        branchId: fx.branchId,
        warehouseId: fx.warehouseId,
      },
      {
        account: { kind: 'system', systemKey: 'opening_equity' },
        side: 'C',
        baseAmountMinor: 36000n,
        baseCurrency: 'ILS',
        txnAmountMinor: 10000n,
        txnCurrency: 'USD',
        fxRate: '3.6',
        fxRateSource: 'manual',
        fxRateAt: at,
        branchId: fx.branchId,
        warehouseId: null,
      },
    ];
    const original = await post(c, fx.userId);
    const rev = await reverse(original, c);

    const mirrored = await linesOf(rev.entryId);
    for (const line of mirrored) {
      expect(line.fx_rate).toBe(rate10('3.6'));
      expect(line.fx_rate_source).toBe('manual');
      expect(line.fx_rate_at).toBe('2025-02-03T11:22:33Z');
      expect(line.txn_currency).toBe('USD');
    }
    expect(must(mirrored[0]).branch_id).toBe(fx.branchId);
    expect(must(mirrored[0]).warehouse_id).toBe(fx.warehouseId);
    expect(must(mirrored[1]).warehouse_id).toBeNull();
  });

  it('mirrors a multi-line entry, preserving line order and every dimension', async () => {
    const c = adjustment();
    c.lines = [
      { ...must(c.lines[0]), baseAmountMinor: 60000n, txnAmountMinor: 60000n, branchId: fx.branchId, memo: 'first' },
      { ...must(c.lines[0]), baseAmountMinor: 40000n, txnAmountMinor: 40000n, branchId: fx.otherBranchId, memo: 'second' },
      { ...must(c.lines[1]), baseAmountMinor: 100000n, txnAmountMinor: 100000n, branchId: null, memo: null },
    ];
    const original = await post(c, fx.userId);
    const rev = await reverse(original, c);

    const src = await linesOf(original.entryId);
    const dst = await linesOf(rev.entryId);
    expect(dst.map((l) => l.line_no)).toEqual([1, 2, 3]);
    expect(dst.map((l) => l.branch_id)).toEqual(src.map((l) => l.branch_id));
    expect(dst.map((l) => l.credit_minor)).toEqual(src.map((l) => l.debit_minor));
    expect(dst.map((l) => l.debit_minor)).toEqual(src.map((l) => l.credit_minor));
  });

  it('reverses an entry whose custom account was deactivated afterwards — without reactivating it (§15)', async () => {
    const code = `REV${Date.now() % 100000}`;
    const acctId = await createAccount(code);
    const c = adjustment();
    must(c.lines[0]).account = { kind: 'code', code };
    const original = await post(c, fx.userId);

    await ownerPool().query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND id = $2`, [fx.businessId, acctId]);

    const rev = await reverse(original, c);
    expect(rev.created).toBe(true);
    expect((await linesOf(rev.entryId)).map((l) => l.account_id)).toContain(acctId);

    // The account is STILL inactive: the reversal routed around nothing and
    // reactivated nothing.
    const state = await ownerPool().query<{ is_active: boolean }>(`SELECT is_active FROM accounts WHERE business_id = $1 AND id = $2`, [fx.businessId, acctId]);
    expect(must(state.rows[0]).is_active).toBe(false);

    // And ordinary posting is not weakened: a NEW entry naming it is refused.
    const fresh = adjustment();
    must(fresh.lines[0]).account = { kind: 'code', code };
    expect(await refusal(() => postAdjustmentAs(adjustmentAssertion(fresh), fresh, 'should not post'))).toMatch(/account_inactive/);
  });

  it('refuses a second reversal of the same entry with a stable domain code', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    await reverse(original, c);
    const second = await refusal(() => reverse(original, c, { requestId: randomUUID(), reason: 'again' }));
    expect(second).toMatch(/accounting\.reversal_exists/);
    // §14: never a raw duplicate-key error.
    expect(second).not.toMatch(/duplicate key|unique constraint|23505|_uq\b/);
  });

  it('replays an exact retry instead of writing a second entry', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    const requestId = randomUUID();
    const first = await reverse(original, c, { requestId, reason: 'identical' });
    const retry = await reverse(original, c, { requestId, reason: 'identical' });
    expect(retry.created).toBe(false);
    expect(retry.entryId).toBe(first.entryId);
    expect(await countEvents(first.entryId)).toEqual({ audit: 1, outbox: 1 });
  });

  it('refuses a reversal of a reversal', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    const rev = await reverse(original, c);
    // The mirror of a mirror is derivable, so the refusal has to be a rule,
    // not an accident of arithmetic.
    const assertion = sourceAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: rev.entryId,
      postingFingerprint: UNREACHABLE_FINGERPRINT,
    });
    expect(await refusal(() => postReversalAs(assertion, rev.entryId, today, 'undo the undo', randomUUID()))).toMatch(/reversal_of_reversal/);
  });

  it('refuses an empty reason, a missing original and another business’s entry', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    expect(await refusal(() => reverse(original, c, { reason: '  ' }))).toMatch(/reversal_reason_required/);

    const ghost = randomUUID();
    const assertion = sourceAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: ghost,
      postingFingerprint: UNREACHABLE_FINGERPRINT,
    });
    expect(await refusal(() => postReversalAs(assertion, ghost, today, 'nothing there', randomUUID()))).toMatch(/entry_not_found/);

    // An entry that exists — in someone else's business. Composite identity
    // means this business cannot see it, so it is simply not found.
    const otherFx = await seedPostingFixture(ownerPool(), `sources-far-${Date.now()}`);
    const otherCmd = simpleCommand(otherFx, randomUUID(), today, 150000n, 'manual_adjustment');
    const foreign = await post(otherCmd, otherFx.userId);
    const crossed = sourceAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: foreign.entryId,
      postingFingerprint: UNREACHABLE_FINGERPRINT,
    });
    expect(await refusal(() => postReversalAs(crossed, foreign.entryId, today, 'not mine', randomUUID()))).toMatch(/entry_not_found/);
  });

  it('refuses a future date and one earlier than the original', async () => {
    const c = adjustment(randomUUID(), '2025-06-10');
    const original = await post(c, fx.userId);
    expect(await refusal(() => reverse(original, c, { entryDate: '2025-06-09' }))).toMatch(/entry_date_before_original/);

    const future = await ownerPool().query<{ d: string }>(`SELECT to_char(((now() AT TIME ZONE 'Asia/Hebron')::date + 1),'YYYY-MM-DD') AS d`);
    expect(await refusal(() => reverse(original, c, { entryDate: must(future.rows[0]).d }))).toMatch(/entry_date_in_future/);
  });

  it('defaults an omitted date to today in the business timezone', async () => {
    const c = adjustment(randomUUID(), '2025-03-01');
    const original = await post(c, fx.userId);
    const assertion = sourceAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: original.entryId,
      postingFingerprint: reversalFingerprintOf(c, original.entryId, today),
    });
    const rev = await postReversalAs(assertion, original.entryId, null, 'no date given', randomUUID());
    expect((await entryOf(rev.entryId)).entry_date).toBe(today);
  });

  it('records exactly one reversal registration, one audit row and one outbox event', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    const rev = await reverse(original, c);

    const detail = await ownerPool().query<{ original_entry_id: string }>(
      `SELECT original_entry_id::text AS original_entry_id
         FROM accounting_reversals WHERE business_id = $1 AND journal_entry_id = $2`,
      [fx.businessId, rev.entryId],
    );
    expect(detail.rows).toHaveLength(1);
    expect(must(detail.rows[0]).original_entry_id).toBe(original.entryId);
    expect(await countEvents(rev.entryId)).toEqual({ audit: 1, outbox: 1 });

    const payload = await ownerPool().query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE business_id = $1 AND type = 'accounting.entry.reversed' AND payload->>'entryId' = $2`,
      [fx.businessId, rev.entryId],
    );
    // §49: identifiers only.
    expect(Object.keys(must(payload.rows[0]).payload).sort()).toEqual(['businessId', 'entryId', 'originalEntryId', 'sourceId', 'sourceType']);
  });

  it('refuses a mirror that does not match what was signed', async () => {
    const c = adjustment();
    const original = await post(c, fx.userId);
    const wrong = sourceAssertion({
      actorUserId: fx.userId,
      tenantId: fx.tenantId,
      businessId: fx.businessId,
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: original.entryId,
      // A fingerprint over a DIFFERENT date: the derivation is honest, the
      // authorization is for something else.
      postingFingerprint: reversalFingerprintOf(c, original.entryId, '2025-12-01'),
    });
    expect(await refusal(() => postReversalAs(wrong, original.entryId, today, 'mismatched', randomUUID()))).toMatch(/assertion_payload_mismatch/);
  });
});

// ── §22-§34 OPENING BALANCE ───────────────────────────────────────────────

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

async function openBalance(
  positions: readonly PostLine[],
  options: { asOfDate?: string; openingBalanceId?: string; requestId?: string } = {},
): Promise<{ entryId: string; created: boolean; openingBalanceId: string }> {
  const openingBalanceId = options.openingBalanceId ?? randomUUID();
  const asOfDate = options.asOfDate ?? today;
  const assertion = sourceAssertion({
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
      asOfDate,
      baseCurrency: 'ILS',
      positions,
    }),
  });
  const out = await postOpeningBalanceAs(assertion, {
    asOfDate,
    positions,
    openingBalanceId,
    description: 'opening position',
    requestId: options.requestId ?? randomUUID(),
  });
  return { ...out, openingBalanceId };
}

/** A business of its own, so the one-posted-set rule can be proved repeatedly. */
async function freshBusiness(label: string): Promise<PostingFixture> {
  return seedPostingFixture(ownerPool(), `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
}

describe('opening balance (§22-§34)', () => {
  it('posts a positive plug: assets exceed liabilities, equity takes the credit', async () => {
    const out = await openBalance([position('cash', 'D', 250000n)]);
    expect(out.created).toBe(true);

    const lines = await linesOf(out.entryId);
    expect(lines).toHaveLength(2);
    const plug = must(lines[1]);
    expect(plug.credit_minor).toBe('250000');
    expect(plug.base_currency).toBe('ILS');
    expect(plug.fx_rate_source).toBe('base');
    expect(plug.branch_id).toBeNull();
    expect(plug.warehouse_id).toBeNull();

    const equity = await ownerPool().query<{ id: string }>(`SELECT id::text AS id FROM accounts WHERE business_id = $1 AND system_key = 'opening_equity'`, [
      fx.businessId,
    ]);
    expect(plug.account_id).toBe(must(equity.rows[0]).id);

    const head = await entryOf(out.entryId);
    expect(head.source_type).toBe('opening_balance');
    expect(head.source_id).toBe(out.openingBalanceId);
  });

  it('posts a negative plug: liabilities exceed assets, equity takes the debit', async () => {
    const far = fx;
    fx = await freshBusiness('ob-negative');
    try {
      const out = await openBalance([position('accounts_payable', 'C', 180000n)]);
      const lines = await linesOf(out.entryId);
      expect(must(lines[1]).debit_minor).toBe('180000');
    } finally {
      fx = far;
    }
  });

  it('posts a ZERO plug by writing no plug line at all', async () => {
    // Journal invariants forbid a zero-amount line, so "the plug is zero"
    // cannot mean "a line worth nothing". It means the positions already
    // balance and equity needs no entry — which is the only reading that is
    // both true and postable.
    const far = fx;
    fx = await freshBusiness('ob-zero');
    try {
      const out = await openBalance([position('cash', 'D', 90000n), position('accounts_payable', 'C', 90000n)]);
      const lines = await linesOf(out.entryId);
      expect(lines).toHaveLength(2);
      const equity = await ownerPool().query<{ id: string }>(`SELECT id::text AS id FROM accounts WHERE business_id = $1 AND system_key = 'opening_equity'`, [
        fx.businessId,
      ]);
      expect(lines.map((l) => l.account_id)).not.toContain(must(equity.rows[0]).id);
    } finally {
      fx = far;
    }
  });

  it('carries a full manual FX snapshot for a foreign position', async () => {
    const far = fx;
    fx = await freshBusiness('ob-fx');
    try {
      const foreign: PostLine = {
        account: { kind: 'system', systemKey: 'cash' },
        side: 'D',
        baseAmountMinor: 36000n,
        baseCurrency: 'ILS',
        txnAmountMinor: 10000n,
        txnCurrency: 'USD',
        fxRate: '3.6',
        fxRateSource: 'manual',
        fxRateAt: new Date('2025-01-01T00:00:00Z'),
        memo: null,
      };
      const out = await openBalance([foreign]);
      const lines = await linesOf(out.entryId);
      expect(must(lines[0]).fx_rate).toBe(rate10('3.6'));
      expect(must(lines[0]).fx_rate_source).toBe('manual');
      expect(must(lines[0]).txn_currency).toBe('USD');
      // The plug is in base currency: equity is not a foreign position.
      expect(must(lines[1]).fx_rate_source).toBe('base');
      expect(must(lines[1]).txn_currency).toBe('ILS');
    } finally {
      fx = far;
    }
  });

  it('posts at business level with NULL branch and warehouse on every line', async () => {
    const far = fx;
    fx = await freshBusiness('ob-scope');
    try {
      const out = await openBalance([position('cash', 'D', 120000n)]);
      for (const line of await linesOf(out.entryId)) {
        expect(line.branch_id).toBeNull();
        expect(line.warehouse_id).toBeNull();
      }
    } finally {
      fx = far;
    }
  });

  it('refuses a future as-of date and permits any historical one', async () => {
    const far = fx;
    fx = await freshBusiness('ob-dates');
    try {
      const ahead = await ownerPool().query<{ d: string }>(`SELECT to_char(((now() AT TIME ZONE 'Asia/Hebron')::date + 1),'YYYY-MM-DD') AS d`);
      expect(await refusal(() => openBalance([position('cash', 'D', 1000n)], { asOfDate: must(ahead.rows[0]).d }))).toMatch(/entry_date_in_future/);
      // No lower bound: a business may open its books from any past date.
      expect((await openBalance([position('cash', 'D', 1000n)], { asOfDate: '2019-04-01' })).created).toBe(true);
    } finally {
      fx = far;
    }
  });

  it('refuses a position on the equity account the plug owns', async () => {
    const far = fx;
    fx = await freshBusiness('ob-equity');
    try {
      // The engine refuses this before it signs anything, so proving the
      // DATABASE refuses it means bypassing the engine: sign a legal set and
      // present an illegal one. That is exactly the attack the rule exists
      // for, and the only way to see the database's own answer.
      const legal = [position('cash', 'D', 1000n)];
      const openingBalanceId = randomUUID();
      const assertion = sourceAssertion({
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
          positions: legal,
        }),
      });
      const conn = await appClient();
      try {
        await conn.query('BEGIN');
        await conn.query(`SELECT set_config('app.accounting_assertion', $1, true)`, [assertion]);
        await expect(
          conn.query(`SELECT accounting_open_balance_draft($1::date, $2::jsonb)`, [
            today,
            JSON.stringify(positionPayload([position('cash', 'D', 1000n), position('opening_equity', 'C', 1000n)])),
          ]),
        ).rejects.toThrow(/payload_invalid/);
      } finally {
        await conn.query('ROLLBACK').catch(() => undefined);
        await conn.end().catch(() => undefined);
      }

      // And the engine refuses it too, so the merchant never reaches the
      // database with such a set in the first place.
      expect(await refusal(() => openBalance([position('cash', 'D', 1000n), position('opening_equity', 'C', 1000n)]))).toMatch(
        /may not be stated as a position/,
      );
    } finally {
      fx = far;
    }
  });

  it('refuses a second posted set while the first stands', async () => {
    const far = fx;
    fx = await freshBusiness('ob-second');
    try {
      await openBalance([position('cash', 'D', 50000n)]);
      expect(await refusal(() => openBalance([position('cash', 'D', 70000n)]))).toMatch(/opening_balance_exists/);
      const n = await ownerPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM accounting_opening_balances WHERE business_id = $1 AND status = 'posted'`,
        [fx.businessId],
      );
      expect(must(n.rows[0]).n).toBe(1);
    } finally {
      fx = far;
    }
  });

  it('is immutable once posted: lines, date and journal link cannot change', async () => {
    const far = fx;
    fx = await freshBusiness('ob-immutable');
    try {
      const out = await openBalance([position('cash', 'D', 30000n)]);
      const before = await snapshot(out.entryId);
      for (const sql of [
        `UPDATE accounting_opening_balances SET as_of_date = '2020-01-01' WHERE business_id = $1 AND id = $2`,
        `UPDATE accounting_opening_balances SET journal_entry_id = NULL WHERE business_id = $1 AND id = $2`,
        `DELETE FROM accounting_opening_balances WHERE business_id = $1 AND id = $2`,
      ]) {
        await expect(ownerPool().query(sql, [fx.businessId, out.openingBalanceId])).rejects.toThrow(/opening_balance_state_invalid|source_immutable/);
      }
      await expect(
        ownerPool().query(`UPDATE accounting_opening_balance_lines SET base_amount_minor = 1 WHERE business_id = $1 AND opening_balance_id = $2`, [
          fx.businessId,
          out.openingBalanceId,
        ]),
      ).rejects.toThrow(/opening_balance_state_invalid|source_immutable/);
      expect(await snapshot(out.entryId)).toBe(before);
    } finally {
      fx = far;
    }
  });

  it('refuses supersession without a reversal of its journal entry', async () => {
    const far = fx;
    fx = await freshBusiness('ob-supersede-bare');
    try {
      const out = await openBalance([position('cash', 'D', 40000n)]);
      await expect(
        ownerPool().query(`UPDATE accounting_opening_balances SET status = 'superseded' WHERE business_id = $1 AND id = $2`, [
          fx.businessId,
          out.openingBalanceId,
        ]),
      ).rejects.toThrow(/supersede_without_reversal/);
    } finally {
      fx = far;
    }
  });

  it('replaces a posted set the only legal way: reverse, supersede, post again (§32)', async () => {
    const far = fx;
    fx = await freshBusiness('ob-replace');
    try {
      const positions = [position('cash', 'D', 55000n)];
      const first = await openBalance(positions);
      const firstEntry = await snapshot(first.entryId);

      // Step one: the opening entry is reversed, through the ordinary
      // reversal writer. Nothing about the original changes.
      const reversed = await reverseOpeningBalance(first.entryId, { asOfDate: today, positions });
      expect(reversed.created).toBe(true);
      expect(await snapshot(first.entryId)).toBe(firstEntry);

      // Step two and three: posting a replacement supersedes the first set.
      const second = await openBalance([position('cash', 'D', 77000n)]);
      expect(second.created).toBe(true);
      expect(second.openingBalanceId).not.toBe(first.openingBalanceId);

      const states = await ownerPool().query<{ id: string; status: string }>(
        `SELECT id::text AS id, status FROM accounting_opening_balances WHERE business_id = $1 ORDER BY created_at`,
        [fx.businessId],
      );
      expect(states.rows.map((r) => r.status)).toEqual(['superseded', 'posted']);
      expect(must(states.rows[1]).id).toBe(second.openingBalanceId);

      // And the first set's own rows are exactly as they were: superseded is
      // a status change, not an erasure.
      const kept = await ownerPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM accounting_opening_balance_lines WHERE business_id = $1 AND opening_balance_id = $2`,
        [fx.businessId, first.openingBalanceId],
      );
      expect(must(kept.rows[0]).n).toBeGreaterThan(0);
    } finally {
      fx = far;
    }
  });

  it('leaves superseded terminal', async () => {
    const far = fx;
    fx = await freshBusiness('ob-terminal');
    try {
      const positions = [position('cash', 'D', 12000n)];
      const out = await openBalance(positions);
      await reverseOpeningBalance(out.entryId, { asOfDate: today, positions });
      await openBalance([position('cash', 'D', 13000n)]);

      await expect(
        ownerPool().query(`UPDATE accounting_opening_balances SET status = 'posted' WHERE business_id = $1 AND id = $2`, [fx.businessId, out.openingBalanceId]),
      ).rejects.toThrow(/opening_balance_state_invalid/);
      await expect(
        ownerPool().query(`UPDATE accounting_opening_balances SET status = 'draft' WHERE business_id = $1 AND id = $2`, [fx.businessId, out.openingBalanceId]),
      ).rejects.toThrow(/opening_balance_state_invalid/);
    } finally {
      fx = far;
    }
  });

  it('writes its own posted event with identifiers only', async () => {
    const far = fx;
    fx = await freshBusiness('ob-event');
    try {
      const out = await openBalance([position('cash', 'D', 21000n)]);
      const r = await ownerPool().query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM outbox_events WHERE business_id = $1 AND type = 'accounting.opening_balance.posted'`,
        [fx.businessId],
      );
      expect(r.rows).toHaveLength(1);
      const payload = must(r.rows[0]).payload;
      expect(payload['entryId']).toBe(out.entryId);
      for (const key of Object.keys(payload)) expect(key).toMatch(/Id$|^sourceType$/);
    } finally {
      fx = far;
    }
  });

  it('leaves nothing behind when the post is refused — no orphan draft, no partial journal', async () => {
    const far = fx;
    fx = await freshBusiness('ob-atomic');
    try {
      const ahead = await ownerPool().query<{ d: string }>(`SELECT to_char(((now() AT TIME ZONE 'Asia/Hebron')::date + 1),'YYYY-MM-DD') AS d`);
      await refusal(() => openBalance([position('cash', 'D', 5000n)], { asOfDate: must(ahead.rows[0]).d }));
      for (const table of ['accounting_opening_balances', 'accounting_opening_balance_lines', 'journal_entries', 'accounting_source_bindings']) {
        const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [fx.businessId]);
        expect(must(r.rows[0]).n, table).toBe(0);
      }
    } finally {
      fx = far;
    }
  });
});
