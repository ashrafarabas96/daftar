import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import {
  fingerprintOf,
  must,
  postAdjustmentAs,
  postReversalAs,
  reversalFingerprintOf,
  seedPostingFixture,
  simpleCommand,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostingFixture,
} from '../helpers/accounting-posting';

/**
 * MATRIX — THE REVERSAL DATE IS THE MERCHANT'S, AT THE LOWEST BOUNDARY.
 *
 * `accounting-reversal-contract.test.ts` proves the HTTP command is
 * deterministic: `entryDate` is required at the DTO, the Zod schema, the
 * service and the engine, and an identical request replayed after the
 * business's civil day advances returns the same reversal rather than a
 * different one.
 *
 * All five of those layers are application code. The authoritative boundary
 * is `accounting_post_reversal`, and until this file existed it still
 * accepted a NULL date and filled it in with "today in the business
 * timezone". A Zod 400 is evidence about a pipe, not about the command: a
 * direct caller of the trusted routine — a later phase's worker, a support
 * script, a second service — would have received a reversal whose accounting
 * date, and therefore whose signed identity, was chosen by the clock.
 *
 * So every case here calls the routine ITSELF, as `daftar_app`, carrying a
 * real `reverse` assertion over a real original entry. The business clock is
 * still allowed one question — "is this explicit date in the future?" — and
 * the last case proves it is still asked.
 */

let fx: PostingFixture;
let today: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  fx = await seedPostingFixture(ownerPool(), `revdate-${Math.floor(Math.random() * 1e6)}`);
  today = await todayIn(ownerPool(), 'Asia/Hebron');
}, 180_000);

interface Counts {
  reversals: number;
  entries: number;
  bindings: number;
  audits: number;
  outbox: number;
}

/** Everything a committed reversal leaves behind, counted for one business. */
async function reversalCounts(businessId: string): Promise<Counts> {
  const r = await ownerPool().query<Counts>(
    `SELECT (SELECT count(*) FROM accounting_reversals          WHERE business_id = $1)::int AS reversals,
            (SELECT count(*) FROM journal_entries               WHERE business_id = $1 AND source_type = 'reversal')::int AS entries,
            (SELECT count(*) FROM accounting_source_bindings    WHERE business_id = $1 AND source_type = 'reversal')::int AS bindings,
            (SELECT count(*) FROM audit_events  WHERE business_id = $1 AND action = 'accounting.entry_reversed')::int AS audits,
            (SELECT count(*) FROM outbox_events WHERE business_id = $1 AND type   = 'accounting.entry.reversed')::int AS outbox`,
    [businessId],
  );
  return must(r.rows[0]);
}

/** An adjustment to undo, posted through the command that owns its source. */
async function original(entryDate: string): Promise<{ entryId: string; command: PostCommand }> {
  const c: PostCommand = { ...simpleCommand(fx, randomUUID(), entryDate), requestId: randomUUID() };
  const assertion = sourceAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });
  const posted = await postAdjustmentAs(assertion, c, 'the fact that will be undone');
  return { entryId: posted.entryId, command: c };
}

/**
 * Call `accounting_post_reversal` directly, with whatever date the case wants
 * — including none. The assertion is genuine and its fingerprint covers
 * `signedFor`, so a routine that decided to carry on with a manufactured date
 * would find the signature it needs already waiting for it.
 */
async function directReversal(
  o: { entryId: string; command: PostCommand },
  entryDate: string | null,
  signedFor: string = entryDate ?? today,
): Promise<{ entryId: string; created: boolean }> {
  const assertion = sourceAssertion({
    actorUserId: fx.userId,
    tenantId: fx.tenantId,
    businessId: fx.businessId,
    operationKind: 'reverse',
    sourceType: 'reversal',
    sourceId: o.entryId,
    postingFingerprint: reversalFingerprintOf(o.command, o.entryId, signedFor),
  });
  return postReversalAs(assertion, o.entryId, entryDate, 'a reversal at the database boundary', randomUUID());
}

const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('the command was accepted, but this case requires a refusal');
};

// ── §4, §5, §6: the routine itself refuses a NULL date ────────────────────

describe('accounting_post_reversal requires the caller to state the date (§4-§6)', () => {
  it('a NULL date is refused by name, under a genuine reverse authority', async () => {
    const o = await original(today);
    const before = await reversalCounts(fx.businessId);

    const message = await refusal(() => directReversal(o, null));
    expect(message).toMatch(/accounting\.entry_date_required/);
    // A stable domain sentence: no table, index or constraint name, and no
    // hint about what the routine would have chosen instead.
    expect(message).not.toMatch(/null value|not-null|23502|duplicate key|permission denied/i);

    // Nothing of the reversal survives the refusal — not the detail row, not
    // the entry, not the binding, and neither of the two side effects.
    expect(await reversalCounts(fx.businessId)).toEqual(before);
  });

  it('the refusal is the RULE, not a missing grant: the same authority reverses with an explicit date', async () => {
    // Without this case the one above could pass forever because `daftar_app`
    // had lost EXECUTE, and the invariant would be untested.
    const o = await original(today);
    const done = await directReversal(o, today);
    expect(done.created).toBe(true);
    expect((await reversalCounts(fx.businessId)).reversals).toBeGreaterThan(0);
  });

  it('an explicit date is never silently replaced by the original’s date either', async () => {
    // The other default a routine could reach for. The reversal is dated the
    // day the merchant stated, not the day the original carried.
    const o = await original('2026-03-02');
    await directReversal(o, today);
    const r = await ownerPool().query<{ entry_date: string }>(
      `SELECT to_char(entry_date, 'YYYY-MM-DD') AS entry_date
       FROM journal_entries WHERE business_id = $1 AND source_type = 'reversal' AND source_id = $2`,
      [fx.businessId, o.entryId],
    );
    expect(must(r.rows[0]).entry_date).toBe(today);
  });
});

// ── §8: no wall-clock value chooses the command's identity ────────────────

describe('the reversal is a pure function of its stated inputs (§8)', () => {
  it('the identical direct call replays across a civil-day change in the business timezone', async () => {
    // Two timezones a full day apart at every instant, so "today in the
    // business timezone" genuinely changes between the attempts while the
    // test runs in seconds. If the routine consulted that value for anything
    // but the future check, the second call would sign — or store — a
    // different date and be refused as a conflicting reversal.
    const far = await seedFarBusiness('Pacific/Honolulu');
    const o = await originalFor(far, await todayIn(ownerPool(), 'Pacific/Honolulu'));
    const stated = await todayIn(ownerPool(), 'Pacific/Honolulu');

    const first = await directReversalFor(far, o, stated);
    expect(first.created).toBe(true);

    await ownerPool().query(`UPDATE businesses SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [far.businessId]);
    const localNow = await todayIn(ownerPool(), 'Pacific/Kiritimati');
    expect(localNow, 'the civil day must actually differ for this case to mean anything').not.toBe(stated);

    const again = await directReversalFor(far, o, stated);
    expect(again.created).toBe(false);
    expect(again.entryId).toBe(first.entryId);
  });

  it('the business clock still answers the one question it owns: is this date in the future?', async () => {
    const o = await original(today);
    const beyond = await ownerPool().query<{ d: string }>(`SELECT to_char(((now() AT TIME ZONE 'Asia/Hebron')::date + 1), 'YYYY-MM-DD') AS d`);
    expect(await refusal(() => directReversal(o, must(beyond.rows[0]).d))).toMatch(/accounting\.entry_date_in_future/);
  });

  it('and the lower bound is still the original’s own date', async () => {
    const o = await original(today);
    const before = await ownerPool().query<{ d: string }>(`SELECT to_char(((now() AT TIME ZONE 'Asia/Hebron')::date - 1), 'YYYY-MM-DD') AS d`);
    expect(await refusal(() => directReversal(o, must(before.rows[0]).d))).toMatch(/accounting\.entry_date_before_original/);
  });
});

// ── fixtures for the timezone case, which needs a business of its own ─────

async function seedFarBusiness(timezone: string): Promise<PostingFixture> {
  const far = await seedPostingFixture(ownerPool(), `revdate-far-${Math.floor(Math.random() * 1e6)}`);
  await ownerPool().query(`UPDATE businesses SET timezone = $2 WHERE id = $1`, [far.businessId, timezone]);
  return far;
}

async function originalFor(who: PostingFixture, entryDate: string): Promise<{ entryId: string; command: PostCommand }> {
  const c: PostCommand = { ...simpleCommand(who, randomUUID(), entryDate), requestId: randomUUID() };
  const assertion = sourceAssertion({
    actorUserId: who.userId,
    tenantId: who.tenantId,
    businessId: who.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });
  const posted = await postAdjustmentAs(assertion, c, 'the fact that will be undone');
  return { entryId: posted.entryId, command: c };
}

async function directReversalFor(
  who: PostingFixture,
  o: { entryId: string; command: PostCommand },
  entryDate: string,
): Promise<{ entryId: string; created: boolean }> {
  const assertion = sourceAssertion({
    actorUserId: who.userId,
    tenantId: who.tenantId,
    businessId: who.businessId,
    operationKind: 'reverse',
    sourceType: 'reversal',
    sourceId: o.entryId,
    postingFingerprint: reversalFingerprintOf(o.command, o.entryId, entryDate),
  });
  return postReversalAs(assertion, o.entryId, entryDate, 'a reversal at the database boundary', randomUUID());
}
