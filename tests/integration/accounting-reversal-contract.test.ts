import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PostingCommand } from '@daftar/accounting';
import { AccountingPostingService } from '../../apps/api/src/modules/accounting/accounting-posting.service';
import { TenancyService, type MembershipContext } from '../../apps/api/src/modules/tenancy/tenancy.service';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { must, todayIn } from '../helpers/accounting-posting';

/**
 * MATRIX — THE REVERSAL COMMAND IS DETERMINISTIC (§7-§11).
 *
 * A reversal needs no `Idempotency-Key`, because the original entry id IS its
 * source identity. That only holds if the command itself is stable: the
 * fingerprint covers the entry date, so a date the SERVER resolves from its
 * own clock makes the command's identity a function of when it happened to
 * arrive. Retry the identical HTTP request after local midnight and it signs
 * something different — and the route is no longer idempotent by
 * construction, however correct every individual layer is.
 *
 * So `entryDate` is REQUIRED at the merchant boundary, and the cases below
 * prove it from outside: through the real HTTP endpoint, the real Zod pipe,
 * the real permission guard, the real engine and the real database.
 *
 * The civil-day advance is simulated by moving the business's timezone, not
 * by waiting: `Pacific/Kiritimati` (UTC+14) and `Pacific/Honolulu` (UTC−10)
 * are a full day apart at every instant, so "today in the business timezone"
 * genuinely changes between the two attempts while the test runs in seconds.
 */

let t: TestApp;
let posting: AccountingPostingService;
let tenancy: TenancyService;
let today: string;

interface Owner {
  token: string;
  userId: string;
  businessId: string;
  membership: MembershipContext;
}

async function onboard(): Promise<Owner> {
  const reg = await t.request
    .post('/v1/auth/register')
    .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Ledger Owner', preferredLocale: 'ar' });
  const token = reg.body.accessToken as string;
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ businessName: 'Ledger Biz', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `rev-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
  const businessId = on.body.businessId as string;
  const userId = (await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`)).body.userId as string;
  const membership = await tenancy.resolveMembership(userId, businessId);
  return { token, userId, businessId, membership };
}

function command(m: MembershipContext, entryDate: string): PostingCommand {
  const at = new Date('2026-03-14T09:15:00Z');
  const line = (systemKey: string, side: 'D' | 'C') => ({
    account: { kind: 'system' as const, systemKey },
    side,
    baseAmountMinor: 50000n,
    baseCurrency: 'ILS',
    txnAmountMinor: 50000n,
    txnCurrency: 'ILS',
    fxRate: '1.0000000000',
    fxRateSource: 'base' as const,
    fxRateAt: at,
    branchId: null,
    warehouseId: null,
  });
  return {
    tenantId: m.tenantId,
    businessId: m.businessId,
    sourceType: 'manual_adjustment',
    sourceId: randomUUID(),
    entryDate,
    description: 'the entry to be reversed',
    requestId: 'req-original',
    lines: [line('cash', 'D'), line('opening_equity', 'C')],
  };
}

/** The business's own civil date, read the way the ledger reads it. */
async function businessToday(businessId: string): Promise<string> {
  const r = await ownerPool().query<{ d: string }>(
    `SELECT to_char((now() AT TIME ZONE b.timezone)::date, 'YYYY-MM-DD') AS d FROM businesses b WHERE b.id = $1`,
    [businessId],
  );
  return must(r.rows[0]).d;
}

async function setTimezone(businessId: string, timezone: string): Promise<string> {
  await ownerPool().query(`UPDATE businesses SET timezone = $2 WHERE id = $1`, [businessId, timezone]);
  return businessToday(businessId);
}

/** POST the reversal endpoint exactly as a merchant client would. */
async function reverseOverHttp(o: Owner, entryId: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await t.request
    .post(`/v1/businesses/${o.businessId}/accounting/entries/${entryId}/reversals`)
    .set('Authorization', `Bearer ${o.token}`)
    .set('X-Business-Id', o.businessId)
    .send(body);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

beforeAll(async () => {
  t = await createTestApp();
  await resetData();
  posting = t.app.get(AccountingPostingService);
  tenancy = t.app.get(TenancyService);
  today = await todayIn(ownerPool(), 'Asia/Hebron');
});

// ── §8, §10.H the contract itself ─────────────────────────────────────────

describe('the public reversal contract requires an explicit date (§8, §10)', () => {
  it('H · a request that omits entryDate is refused, and reverses nothing', async () => {
    const o = await onboard();
    const original = await posting.post(o.membership, command(o.membership, today));

    const res = await reverseOverHttp(o, original.entryId, { reason: 'no date stated' });
    expect(res.status).toBe(400);

    const n = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_reversals WHERE business_id = $1`, [o.businessId]);
    expect(must(n.rows[0]).n).toBe(0);
  });

  it('H · a request that sends entryDate: null is refused too', async () => {
    const o = await onboard();
    const original = await posting.post(o.membership, command(o.membership, today));
    const res = await reverseOverHttp(o, original.entryId, { entryDate: null, reason: 'an explicit nothing' });
    expect(res.status).toBe(400);
  });

  it('A · an explicit date posts the reversal', async () => {
    const o = await onboard();
    const original = await posting.post(o.membership, command(o.membership, today));
    const res = await reverseOverHttp(o, original.entryId, { entryDate: today, reason: 'a considered correction' });
    expect(res.status).toBe(201);
    expect(res.body['entryId']).toBeTypeOf('string');
    expect(res.body['entryId']).not.toBe(original.entryId);
  });
});

// ── §10.B, §10.C determinism across a civil-day boundary ──────────────────

describe('the same reversal request replays whatever day it is (§10)', () => {
  it('B · an identical retry returns the same entry', async () => {
    const o = await onboard();
    const original = await posting.post(o.membership, command(o.membership, today));
    const body = { entryDate: today, reason: 'a considered correction' };

    const first = await reverseOverHttp(o, original.entryId, body);
    const second = await reverseOverHttp(o, original.entryId, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body['entryId']).toBe(first.body['entryId']);

    const n = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_reversals WHERE business_id = $1`, [o.businessId]);
    expect(must(n.rows[0]).n).toBe(1);
  });

  it('C · the identical request replayed after the business day has advanced returns the same entry', async () => {
    const o = await onboard();
    // Start far to the west, so the business's civil date is the earlier one.
    const dayOne = await setTimezone(o.businessId, 'Pacific/Honolulu');
    const original = await posting.post(o.membership, command(o.membership, dayOne));

    // The merchant's client formed this body once and will resend it verbatim.
    const body = { entryDate: dayOne, reason: 'a considered correction' };
    const first = await reverseOverHttp(o, original.entryId, body);
    expect(first.status).toBe(201);

    // Now the business is a full civil day ahead — the same wall clock, a
    // different "today". Before this correction, a body with no date would
    // have signed a different fingerprint here and the retry would have been
    // refused instead of replayed.
    const dayTwo = await setTimezone(o.businessId, 'Pacific/Kiritimati');
    expect(dayTwo).not.toBe(dayOne);

    const second = await reverseOverHttp(o, original.entryId, body);
    expect(second.status).toBe(201);
    expect(second.body['entryId']).toBe(first.body['entryId']);

    const counts = must(
      (
        await ownerPool().query<{ reversals: number; entries: number }>(
          `SELECT (SELECT count(*) FROM accounting_reversals WHERE business_id = $1)::int AS reversals,
                  (SELECT count(*) FROM journal_entries WHERE business_id = $1 AND source_type = 'reversal')::int AS entries`,
          [o.businessId],
        )
      ).rows[0],
    );
    expect(counts).toEqual({ reversals: 1, entries: 1 });
  });

  it('D · a different explicit date is a different command, and is refused', async () => {
    const o = await onboard();
    const origin = shift(today, -3);
    const original = await posting.post(o.membership, command(o.membership, origin));
    const first = await reverseOverHttp(o, original.entryId, { entryDate: today, reason: 'a considered correction' });
    expect(first.status).toBe(201);

    const second = await reverseOverHttp(o, original.entryId, { entryDate: shift(today, -1), reason: 'a considered correction' });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(second.body)).toMatch(/reversal_exists/);
  });

  it('E · a date before the original is refused', async () => {
    const o = await onboard();
    const original = await posting.post(o.membership, command(o.membership, today));
    const res = await reverseOverHttp(o, original.entryId, { entryDate: shift(today, -1), reason: 'too early' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/entry_date_before_original/);
  });

  it('F · a future date is refused', async () => {
    const o = await onboard();
    const original = await posting.post(o.membership, command(o.membership, today));
    const res = await reverseOverHttp(o, original.entryId, { entryDate: shift(today, 1), reason: 'too late' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/entry_date_in_future/);
  });

  it('G · the same date with a different reason is a different fact, and is refused', async () => {
    const o = await onboard();
    const original = await posting.post(o.membership, command(o.membership, today));
    expect((await reverseOverHttp(o, original.entryId, { entryDate: today, reason: 'the first reason' })).status).toBe(201);
    const second = await reverseOverHttp(o, original.entryId, { entryDate: today, reason: 'a different reason' });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(second.body)).toMatch(/reversal_exists/);
  });
});

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
