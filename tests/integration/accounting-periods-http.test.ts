/**
 * THE MERCHANT PERIOD ROUTES, THROUGH THE REAL APPLICATION (P2-S6 §21, §22, §29-§32).
 *
 * Everything below goes over HTTP: the real router, the real authentication,
 * the real permission guard, the real Zod pipe, the real service, the real
 * minter and the real database. Nothing constructs a `MembershipContext` by
 * hand, because a hand-built context is the one thing an attacker cannot
 * send — and the questions this file asks are all about what a caller CAN
 * send.
 *
 * Four of them matter most.
 *
 *   §21 — `accounting.period.reopen` is NOT implied by
 *   `accounting.period.manage`. A member who may close the books may not
 *   silently be able to undo it, and the case is built the long way through
 *   the real role endpoints so that the refusal is about the permission and
 *   not about the member.
 *
 *   §22 — a period governs every branch, so a branch-scoped member may not
 *   manage one even holding the permission.
 *
 *   §29-§31 — the payload is strict, both dates are explicit, and neither the
 *   closing actor nor the closing instant is a field a client can send.
 *
 *   §32 — the list is an OBJECT with `items`, and it exposes no assertion, no
 *   internal operation id and no audit internals.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, grantFeature, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { must } from '../helpers/accounting-posting';

let t: TestApp;

interface Actor {
  token: string;
  userId: string;
  email: string;
}

interface Owner extends Actor {
  businessId: string;
  tenantId: string;
}

const auth = (a: Actor, businessId: string) => ({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': businessId });

const unique = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

async function register(displayName: string): Promise<Actor> {
  const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName, preferredLocale: 'ar' });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  return { token, userId: me.body.userId as string, email: me.body.email as string };
}

async function onboard(): Promise<Owner> {
  const u = await register('Period Owner');
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${unique()}`)
    .set('Authorization', `Bearer ${u.token}`)
    .send({ businessName: 'Period Biz', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `pdh-${unique()}`.slice(0, 60) });
  expect(on.status).toBe(201);
  const businessId = on.body.businessId as string;
  const r = await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId]);
  return { ...u, businessId, tenantId: must(r.rows[0]).tenant_id };
}

interface Response {
  status: number;
  body: Record<string, unknown>;
}

async function createPeriod(a: Actor, businessId: string, body: unknown, key: string, pathBusinessId = businessId): Promise<Response> {
  const res = await t.request
    .post(`/v1/businesses/${pathBusinessId}/accounting/periods`)
    .set(auth(a, businessId))
    .set('Idempotency-Key', key)
    .send(body as object);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function closePeriod(a: Actor, businessId: string, periodId: string, key: string): Promise<Response> {
  const res = await t.request
    .post(`/v1/businesses/${businessId}/accounting/periods/${periodId}/close`)
    .set(auth(a, businessId))
    .set('Idempotency-Key', key)
    .send({});
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function reopenPeriod(a: Actor, businessId: string, periodId: string, body: unknown, key: string): Promise<Response> {
  const res = await t.request
    .post(`/v1/businesses/${businessId}/accounting/periods/${periodId}/reopen`)
    .set(auth(a, businessId))
    .set('Idempotency-Key', key)
    .send(body as object);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function listPeriods(a: Actor, businessId: string): Promise<Response> {
  const res = await t.request.get(`/v1/businesses/${businessId}/accounting/periods`).set(auth(a, businessId));
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function periodCount(businessId: string): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_periods WHERE business_id = $1`, [businessId]);
  return must(r.rows[0]).n;
}

/**
 * A fresh application per group.
 *
 * Registration is rate limited per IP — correctly, since a scripted account
 * farm is exactly what that limit is for — and the limiter lives in the
 * process. A group that needs more than a handful of merchants therefore
 * starts its own application rather than weakening the limit for everyone.
 */
async function restart(): Promise<void> {
  if (t) await t.close();
  t = await createTestApp();
  await resetData();
}

// ── §29-§31: the routes do their job ──────────────────────────────────────

describe('periods created, closed and reopened over HTTP (§29-§31)', () => {
  beforeAll(restart, 180_000);

  it('creates a period with the authenticated actor and an open status', async () => {
    const o = await onboard();
    const res = await createPeriod(o, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-happy-${unique()}`);

    expect(res.status).toBe(201);
    expect(res.body['changed']).toBe(true);
    // The response says what happened and nothing more: no assertion, no
    // operation id, no fingerprint, no constraint name.
    expect(Object.keys(res.body).sort()).toEqual(['changed', 'periodId']);

    const row = must(
      (
        await ownerPool().query<{ tenant_id: string; status: string; created_by_user_id: string; start_date: Date; end_date: Date }>(
          `SELECT tenant_id, status, created_by_user_id, start_date, end_date FROM accounting_periods WHERE id = $1`,
          [res.body['periodId']],
        )
      ).rows[0],
    );
    expect(row.tenant_id).toBe(o.tenantId);
    expect(row.status).toBe('open');
    expect(row.created_by_user_id).toBe(o.userId);
  });

  it('closes it, taking the actor and the instant from the server', async () => {
    const o = await onboard();
    const created = await createPeriod(o, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-close-${unique()}`);
    const periodId = created.body['periodId'] as string;

    const res = await closePeriod(o, o.businessId, periodId, `pd-close-op-${unique()}`);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ periodId, changed: true });

    const row = must(
      (
        await ownerPool().query<{ status: string; closed_by_user_id: string; closed_at: Date }>(
          `SELECT status, closed_by_user_id, closed_at FROM accounting_periods WHERE id = $1`,
          [periodId],
        )
      ).rows[0],
    );
    expect(row.status).toBe('closed');
    expect(row.closed_by_user_id).toBe(o.userId);
    expect(row.closed_at).not.toBeNull();
  });

  it('reopens it with a mandatory reason, and records the reason in the audit trail', async () => {
    const o = await onboard();
    const created = await createPeriod(o, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-reopen-${unique()}`);
    const periodId = created.body['periodId'] as string;
    expect((await closePeriod(o, o.businessId, periodId, `pd-reopen-cls-${unique()}`)).status).toBe(201);

    const res = await reopenPeriod(o, o.businessId, periodId, { reason: 'A late supplier invoice' }, `pd-reopen-op-${unique()}`);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ periodId, changed: true });

    const audit = must(
      (
        await ownerPool().query<{ metadata: Record<string, unknown> }>(
          `SELECT metadata FROM audit_events WHERE action = 'accounting.period_reopened' AND entity_id = $1`,
          [periodId],
        )
      ).rows[0],
    );
    expect(audit.metadata['reason']).toBe('A late supplier invoice');
  });

  it('replays an identical create onto the same period', async () => {
    const o = await onboard();
    const key = `pd-replay-${unique()}`;
    const body = { startDate: '2026-03-01', endDate: '2026-03-31' };

    const first = await createPeriod(o, o.businessId, body, key);
    const second = await createPeriod(o, o.businessId, body, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body['periodId']).toBe(first.body['periodId']);
    expect(first.body['changed']).toBe(true);
    expect(second.body['changed']).toBe(false);
    expect(await periodCount(o.businessId)).toBe(1);
  });

  it('refuses the same key carrying different boundaries', async () => {
    const o = await onboard();
    const key = `pd-conflict-${unique()}`;

    expect((await createPeriod(o, o.businessId, { startDate: '2026-03-01', endDate: '2026-03-31' }, key)).status).toBe(201);
    const second = await createPeriod(o, o.businessId, { startDate: '2026-04-01', endDate: '2026-04-30' }, key);

    expect(second.status).toBe(409);
    expect((second.body['error'] as Record<string, unknown>)['details']).toMatchObject({ code: 'accounting.idempotency_conflict' });
    expect(await periodCount(o.businessId)).toBe(1);
  });

  it('refuses an overlapping period with the domain sentence and no constraint name', async () => {
    const o = await onboard();
    expect((await createPeriod(o, o.businessId, { startDate: '2026-03-01', endDate: '2026-03-31' }, `pd-ov-a-${unique()}`)).status).toBe(201);
    const second = await createPeriod(o, o.businessId, { startDate: '2026-03-15', endDate: '2026-04-15' }, `pd-ov-b-${unique()}`);

    expect(second.status).toBe(409);
    expect((second.body['error'] as Record<string, unknown>)['details']).toMatchObject({ code: 'accounting.period_overlap' });
    expect(JSON.stringify(second.body)).not.toMatch(/accounting_periods_no_overlap|23P01/);
    expect(await periodCount(o.businessId)).toBe(1);
  });

  it('refuses a gap with the contiguity sentence', async () => {
    const o = await onboard();
    expect((await createPeriod(o, o.businessId, { startDate: '2026-03-01', endDate: '2026-03-31' }, `pd-gap-a-${unique()}`)).status).toBe(201);
    const second = await createPeriod(o, o.businessId, { startDate: '2026-05-01', endDate: '2026-05-31' }, `pd-gap-b-${unique()}`);

    expect(second.status).toBe(409);
    expect((second.body['error'] as Record<string, unknown>)['details']).toMatchObject({ code: 'accounting.period_not_contiguous' });
    expect(await periodCount(o.businessId)).toBe(1);
  });
});

// ── §32: the read ─────────────────────────────────────────────────────────

describe('the period list (§32)', () => {
  let o: Owner;

  beforeAll(async () => {
    await restart();
    o = await onboard();
    expect((await createPeriod(o, o.businessId, { startDate: '2026-02-01', endDate: '2026-02-28' }, `pd-list-b-${unique()}`)).status).toBe(201);
    expect((await createPeriod(o, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-list-a-${unique()}`)).status).toBe(201);
  }, 180_000);

  it('is an OBJECT with items, ordered by start date, never a bare array', async () => {
    const res = await listPeriods(o, o.businessId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    const items = res.body['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i['startDate'])).toEqual(['2026-01-01', '2026-02-01']);
  });

  it('carries the civil dates verbatim, with no time and no zone', async () => {
    const items = (await listPeriods(o, o.businessId)).body['items'] as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ startDate: '2026-01-01', endDate: '2026-01-31', status: 'open', closedAt: null, lastReopenedAt: null });
  });

  it('exposes no assertion, no operation id, no actor and no reason', async () => {
    const items = (await listPeriods(o, o.businessId)).body['items'] as Record<string, unknown>[];
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['closedAt', 'endDate', 'lastReopenedAt', 'periodId', 'startDate', 'status']);
    }
    expect(JSON.stringify(items)).not.toMatch(/acctctl1|operationId|createdBy|reason|tenantId/i);
  });

  it('shows another business nothing', async () => {
    const other = await onboard();
    const res = await listPeriods(other, other.businessId);
    expect(res.status).toBe(200);
    expect(res.body['items']).toEqual([]);
  });
});

// ── §21, §22: who may manage a period ─────────────────────────────────────

describe('authorization (§21, §22)', () => {
  beforeAll(restart, 180_000);

  it('refuses a member holding only accounting.view', async () => {
    const o = await onboard();
    await grantFeature(o.businessId, o.userId, 'CUSTOM_ROLES');

    const roleKey = `pdview-${Math.floor(Math.random() * 1e6)}`;
    expect(
      (
        await t.request
          .post('/v1/businesses/current/roles')
          .set(auth(o, o.businessId))
          .send({ key: roleKey, name: 'Read only', permissions: ['accounting.view'] })
      ).status,
    ).toBe(201);

    const member = await register('Read only');
    expect((await t.request.post('/v1/businesses/current/members').set(auth(o, o.businessId)).send({ email: member.email, roleKey })).status).toBe(201);

    const res = await createPeriod(member, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-noperm-${unique()}`);
    expect(res.status).toBe(403);
    expect(await periodCount(o.businessId)).toBe(0);
  });

  /**
   * §21, stated as sharply as it can be: manage does NOT imply reopen.
   *
   * The member below genuinely holds `accounting.period.manage` and uses it
   * to create and close a period. The reopen is refused all the same, and
   * only granting the second key changes that — so the refusal is about the
   * permission boundary and nothing else.
   */
  it('lets a manage-only member close, and REFUSES the same member a reopen', async () => {
    const o = await onboard();
    await grantFeature(o.businessId, o.userId, 'CUSTOM_ROLES');

    const roleKey = `pdmanage-${Math.floor(Math.random() * 1e6)}`;
    expect(
      (
        await t.request
          .post('/v1/businesses/current/roles')
          .set(auth(o, o.businessId))
          .send({ key: roleKey, name: 'Closes the books', permissions: ['accounting.view', 'accounting.period.manage'] })
      ).status,
    ).toBe(201);

    const member = await register('Closes the books');
    expect((await t.request.post('/v1/businesses/current/members').set(auth(o, o.businessId)).send({ email: member.email, roleKey })).status).toBe(201);

    const created = await createPeriod(member, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-mng-new-${unique()}`);
    expect(created.status).toBe(201);
    const periodId = created.body['periodId'] as string;
    expect((await closePeriod(member, o.businessId, periodId, `pd-mng-cls-${unique()}`)).status).toBe(201);

    const refused = await reopenPeriod(member, o.businessId, periodId, { reason: 'I would like it back' }, `pd-mng-rop-${unique()}`);
    expect(refused.status).toBe(403);
    expect(must((await ownerPool().query<{ status: string }>(`SELECT status FROM accounting_periods WHERE id = $1`, [periodId])).rows[0]).status).toBe(
      'closed',
    );

    // The owner, who holds both, can. So the refusal above is the permission.
    expect((await reopenPeriod(o, o.businessId, periodId, { reason: 'the owner may' }, `pd-own-rop-${unique()}`)).status).toBe(201);
  });

  it('refuses a BRANCH-SCOPED member who does hold accounting.period.manage (§22)', async () => {
    const o = await onboard();
    await grantFeature(o.businessId, o.userId, 'CUSTOM_ROLES');
    await grantFeature(o.businessId, o.userId, 'MULTI_BRANCH');

    const roleKey = `pdbranch-${Math.floor(Math.random() * 1e6)}`;
    expect(
      (
        await t.request
          .post('/v1/businesses/current/roles')
          .set(auth(o, o.businessId))
          .send({ key: roleKey, name: 'Branch books', permissions: ['accounting.view', 'accounting.period.manage'] })
      ).status,
    ).toBe(201);

    const member = await register('Branch books');
    expect((await t.request.post('/v1/businesses/current/members').set(auth(o, o.businessId)).send({ email: member.email, roleKey })).status).toBe(201);

    const branches = await t.request.get('/v1/businesses/current/branches').set(auth(o, o.businessId));
    const branchId = (branches.body.items as { id: string }[])[0]?.id ?? '';
    expect(branchId).not.toBe('');
    expect(
      (
        await t.request
          .patch(`/v1/businesses/current/members/${member.userId}/branch-scope`)
          .set(auth(o, o.businessId))
          .send({ mode: 'assigned', branchIds: [branchId] })
      ).status,
    ).toBe(200);

    // Holding the permission is not the question. A period governs every
    // branch, and this member's authority reaches one.
    expect((await createPeriod(member, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-scoped-${unique()}`)).status).toBe(403);
    expect(await periodCount(o.businessId)).toBe(0);

    expect(
      (await t.request.patch(`/v1/businesses/current/members/${member.userId}/branch-scope`).set(auth(o, o.businessId)).send({ mode: 'all', branchIds: [] }))
        .status,
    ).toBe(200);

    const accepted = await createPeriod(member, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-widened-${unique()}`);
    expect(accepted.status).toBe(201);
  });

  it('lets a branch-scoped member READ the periods (§22)', async () => {
    const o = await onboard();
    await grantFeature(o.businessId, o.userId, 'CUSTOM_ROLES');
    await grantFeature(o.businessId, o.userId, 'MULTI_BRANCH');
    expect((await createPeriod(o, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-read-${unique()}`)).status).toBe(201);

    const roleKey = `pdreader-${Math.floor(Math.random() * 1e6)}`;
    expect(
      (
        await t.request
          .post('/v1/businesses/current/roles')
          .set(auth(o, o.businessId))
          .send({ key: roleKey, name: 'Branch reader', permissions: ['accounting.view'] })
      ).status,
    ).toBe(201);
    const member = await register('Branch reader');
    expect((await t.request.post('/v1/businesses/current/members').set(auth(o, o.businessId)).send({ email: member.email, roleKey })).status).toBe(201);

    const branches = await t.request.get('/v1/businesses/current/branches').set(auth(o, o.businessId));
    const branchId = (branches.body.items as { id: string }[])[0]?.id ?? '';
    expect(
      (
        await t.request
          .patch(`/v1/businesses/current/members/${member.userId}/branch-scope`)
          .set(auth(o, o.businessId))
          .send({ mode: 'assigned', branchIds: [branchId] })
      ).status,
    ).toBe(200);

    // Knowing which months are closed is not managing them. A branch manager
    // needs the answer and may not change it.
    const res = await listPeriods(member, o.businessId);
    expect(res.status).toBe(200);
    expect((res.body['items'] as unknown[]).length).toBe(1);
  });
});

/**
 * The same section, continued in a second application.
 *
 * Eight merchants and members is already the per-IP registration cap, and the
 * cap is an abuse control rather than test scaffolding: raising it here would
 * prove the routes work on a system nobody deploys. So the two cases that
 * need their own merchants get their own application.
 */
describe('authorization, continued (§21, §22)', () => {
  beforeAll(restart, 180_000);

  it('refuses a path business that is not the business the membership resolved', async () => {
    const a = await onboard();
    const b = await onboard();

    const res = await createPeriod(a, a.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-foreign-${unique()}`, b.businessId);
    expect(res.status).toBe(403);
    expect(await periodCount(a.businessId)).toBe(0);
    expect(await periodCount(b.businessId)).toBe(0);
  });

  it('refuses an unauthenticated request', async () => {
    const o = await onboard();
    const res = await t.request
      .post(`/v1/businesses/${o.businessId}/accounting/periods`)
      .set('X-Business-Id', o.businessId)
      .set('Idempotency-Key', `pd-anon-${unique()}`)
      .send({ startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(res.status).toBe(401);
    expect(await periodCount(o.businessId)).toBe(0);
  });
});

// ── §29-§31: the payload contract ─────────────────────────────────────────

describe('the payload is strict (§29-§31)', () => {
  let o: Owner;

  beforeAll(async () => {
    await restart();
    o = await onboard();
  }, 180_000);

  const refused = async (body: Record<string, unknown>): Promise<number> => {
    const before = await periodCount(o.businessId);
    const res = await createPeriod(o, o.businessId, body, `pd-bad-${unique()}`);
    expect(await periodCount(o.businessId)).toBe(before);
    return res.status;
  };

  it.each([
    ['an unknown field', { startDate: '2026-01-01', endDate: '2026-01-31', note: 'anything' }],
    ['a client-stated status', { startDate: '2026-01-01', endDate: '2026-01-31', status: 'closed' }],
    ['a client-stated actor', { startDate: '2026-01-01', endDate: '2026-01-31', createdByUserId: '00000000-0000-0000-0000-000000000001' }],
    ['a client-stated tenant', { startDate: '2026-01-01', endDate: '2026-01-31', tenantId: '00000000-0000-0000-0000-000000000001' }],
    ['a client-stated period id', { startDate: '2026-01-01', endDate: '2026-01-31', periodId: '00000000-0000-0000-0000-000000000001' }],
    ['a client-stated closed_at', { startDate: '2026-01-01', endDate: '2026-01-31', closedAt: '2026-02-01T00:00:00Z' }],
    ['a missing start date', { endDate: '2026-01-31' }],
    ['a missing end date', { startDate: '2026-01-01' }],
    ['a null start date', { startDate: null, endDate: '2026-01-31' }],
    ['an end date before the start', { startDate: '2026-01-31', endDate: '2026-01-01' }],
    ['a date that is not a real calendar date', { startDate: '2026-02-30', endDate: '2026-03-31' }],
    ['a timestamp where a civil date belongs', { startDate: '2026-01-01T00:00:00Z', endDate: '2026-01-31' }],
  ])('refuses %s', async (_name, body) => {
    expect(await refused(body as Record<string, unknown>)).toBe(400);
  });

  it('refuses a create with no Idempotency-Key header at all', async () => {
    const res = await t.request
      .post(`/v1/businesses/${o.businessId}/accounting/periods`)
      .set(auth(o, o.businessId))
      .send({ startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(res.status).toBe(400);
    expect(await periodCount(o.businessId)).toBe(0);
  });

  it('refuses a reopen with no reason, a blank reason and an oversized one', async () => {
    const created = await createPeriod(o, o.businessId, { startDate: '2026-01-01', endDate: '2026-01-31' }, `pd-rsn-${unique()}`);
    const periodId = created.body['periodId'] as string;
    expect((await closePeriod(o, o.businessId, periodId, `pd-rsn-cls-${unique()}`)).status).toBe(201);

    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { reason: 42 }]) {
      const res = await reopenPeriod(o, o.businessId, periodId, body, `pd-rsn-${unique()}`);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(must((await ownerPool().query<{ status: string }>(`SELECT status FROM accounting_periods WHERE id = $1`, [periodId])).rows[0]).status).toBe(
      'closed',
    );
  });

  it('refuses a close naming a period id that is not a uuid', async () => {
    const res = await t.request
      .post(`/v1/businesses/${o.businessId}/accounting/periods/not-a-uuid/close`)
      .set(auth(o, o.businessId))
      .set('Idempotency-Key', `pd-badid-${unique()}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('there is no generic period PATCH to reach (§15)', async () => {
    const created = await createPeriod(o, o.businessId, { startDate: '2026-02-01', endDate: '2026-02-28' }, `pd-patch-${unique()}`);
    const periodId = created.body['periodId'] as string;
    const res = await t.request
      .patch(`/v1/businesses/${o.businessId}/accounting/periods/${periodId}`)
      .set(auth(o, o.businessId))
      .send({ endDate: '2026-03-31' });
    expect(res.status).toBe(404);
  });
});
