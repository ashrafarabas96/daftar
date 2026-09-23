import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, grantFeature, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { must } from '../helpers/accounting-posting';

/**
 * THE MERCHANT FX ROUTE, THROUGH THE REAL APPLICATION (§38, §39, §40).
 *
 * Everything below goes over HTTP: the real router, the real authentication,
 * the real permission guard, the real Zod pipe, the real service, the real
 * minter and the real database. Nothing constructs a `MembershipContext` by
 * hand, because a hand-built context is the one thing an attacker cannot
 * send — and the questions this file asks are all about what a caller CAN
 * send.
 *
 * Three of them matter most.
 *
 *   §38 — a rate is business-wide configuration, so a member restricted to
 *   one branch may not set it EVEN holding `accounting.fx.manage` through a
 *   custom role. That case is built the long way, through the real role and
 *   branch-scope endpoints, because the refusal is only meaningful if the
 *   member genuinely holds the permission.
 *
 *   §39 — the payload is strict. An unknown field is refused rather than
 *   ignored, the rate is a STRING, and no JSON number ever reaches the money
 *   boundary.
 *
 *   §40 — the source is the SERVER's. A client cannot state it, and what
 *   lands in the row is `manual` with the actor taken from the verified
 *   authority rather than from anything the client typed.
 */

let t: TestApp;

interface Actor {
  token: string;
  userId: string;
}

interface Owner extends Actor {
  businessId: string;
  tenantId: string;
}

const auth = (a: Actor, businessId: string) => ({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': businessId });

const unique = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

/** A distinct instant per case, so no two cases collide on §34's identity. */
let instantSeq = 0;
function anInstant(): string {
  instantSeq += 1;
  const base = Date.UTC(2026, 0, 1, 0, 0, 0) + instantSeq * 1000;
  return new Date(base).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function register(displayName: string): Promise<Actor & { email: string }> {
  const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName, preferredLocale: 'ar' });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  return { token, userId: me.body.userId as string, email: me.body.email as string };
}

async function onboard(): Promise<Owner> {
  const u = await register('FX Owner');
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${unique()}`)
    .set('Authorization', `Bearer ${u.token}`)
    .send({ businessName: 'FX Biz', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `fxh-${unique()}`.slice(0, 60) });
  expect(on.status).toBe(201);
  const businessId = on.body.businessId as string;
  const r = await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId]);
  return { ...u, businessId, tenantId: must(r.rows[0]).tenant_id };
}

interface Posted {
  status: number;
  body: Record<string, unknown>;
}

/** POST the FX endpoint exactly as a merchant client would. */
async function enter(a: Actor, businessId: string, body: unknown, key: string, pathBusinessId = businessId): Promise<Posted> {
  const res = await t.request
    .post(`/v1/businesses/${pathBusinessId}/accounting/fx-rates`)
    .set(auth(a, businessId))
    .set('Idempotency-Key', key)
    .send(body as object);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

/** The same POST with NO `Idempotency-Key` header at all. */
async function enterWithoutKey(a: Actor, businessId: string, body: unknown): Promise<Posted> {
  const res = await t.request
    .post(`/v1/businesses/${businessId}/accounting/fx-rates`)
    .set(auth(a, businessId))
    .send(body as object);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  fromCurrency: 'USD',
  toCurrency: 'ILS',
  rate: '3.7100000000',
  effectiveAt: anInstant(),
  ...over,
});

interface StoredRate {
  id: string;
  tenant_id: string;
  business_id: string;
  from_currency: string;
  to_currency: string;
  rate: string;
  source: string;
  effective_at: Date;
  entered_by_user_id: string;
}

async function storedRate(rateId: string): Promise<StoredRate> {
  const r = await ownerPool().query<StoredRate>(`SELECT * FROM accounting_fx_rates WHERE id = $1`, [rateId]);
  return must(r.rows[0]);
}

async function rateCount(businessId: string): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_fx_rates WHERE business_id = $1`, [businessId]);
  return must(r.rows[0]).n;
}

/**
 * A fresh application per group.
 *
 * Registration is rate limited per IP — correctly, since a scripted account
 * farm is exactly what that limit is for — and the limiter lives in the
 * process. A group that needs more than a handful of merchants therefore
 * starts its own application rather than weakening the limit for everyone: a
 * test that turned an abuse control off would be proving something about a
 * system nobody runs. The previous one is closed first, so the file never
 * holds two sets of role pools at once.
 */
async function restart(): Promise<void> {
  if (t) await t.close();
  t = await createTestApp();
  await resetData();
}

// ── §38, §40 the route does its job ───────────────────────────────────────

describe('a rate entered over HTTP (§38, §40)', () => {
  beforeAll(restart, 180_000);

  it('is stored with the server-fixed source and the authenticated actor', async () => {
    const o = await onboard();
    const body = payload();

    const res = await enter(o, o.businessId, body, `fx-happy-${unique()}`);

    expect(res.status).toBe(201);
    expect(res.body['created']).toBe(true);
    expect(res.body['rateId']).toBeTypeOf('string');
    // The response says what happened and nothing more: no rate, no
    // fingerprint, no assertion, no constraint name (§17).
    expect(Object.keys(res.body).sort()).toEqual(['created', 'rateId']);

    const row = await storedRate(res.body['rateId'] as string);
    expect(row.business_id).toBe(o.businessId);
    expect(row.tenant_id).toBe(o.tenantId);
    expect(row.from_currency).toBe('USD');
    expect(row.to_currency).toBe('ILS');
    expect(row.rate).toBe('3.7100000000');
    expect(row.source).toBe('manual');
    // §37: the actor is the verified authority's, never a field of the body.
    expect(row.entered_by_user_id).toBe(o.userId);
    expect(row.effective_at.toISOString().replace(/\.\d{3}Z$/, 'Z')).toBe(body['effectiveAt']);
  });

  it('canonicalizes an abbreviated rate without changing its value (§15, §59)', async () => {
    const o = await onboard();
    const res = await enter(o, o.businessId, payload({ rate: '3.71' }), `fx-canon-${unique()}`);
    expect(res.status).toBe(201);
    expect((await storedRate(res.body['rateId'] as string)).rate).toBe('3.7100000000');
  });

  it('treats the direction as part of the rate identity (§19)', async () => {
    const o = await onboard();
    const at = anInstant();
    const forward = await enter(o, o.businessId, payload({ fromCurrency: 'USD', toCurrency: 'ILS', rate: '3.71', effectiveAt: at }), `fx-fwd-${unique()}`);
    const back = await enter(
      o,
      o.businessId,
      payload({ fromCurrency: 'ILS', toCurrency: 'USD', rate: '0.2695417790', effectiveAt: at }),
      `fx-back-${unique()}`,
    );

    expect(forward.status).toBe(201);
    expect(back.status).toBe(201);
    expect(back.body['rateId']).not.toBe(forward.body['rateId']);
    expect(await rateCount(o.businessId)).toBe(2);
  });
});

// ── §33, §34 idempotency and conflict, over the wire ──────────────────────

describe('the Idempotency-Key is the rate identity (§33, §34)', () => {
  beforeAll(restart, 180_000);

  it('replays the identical request onto the same row', async () => {
    const o = await onboard();
    const key = `fx-replay-${unique()}`;
    const body = payload();

    const first = await enter(o, o.businessId, body, key);
    const second = await enter(o, o.businessId, body, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body['rateId']).toBe(first.body['rateId']);
    expect(first.body['created']).toBe(true);
    expect(second.body['created']).toBe(false);
    expect(await rateCount(o.businessId)).toBe(1);
  });

  it('refuses the same key carrying a different rate', async () => {
    const o = await onboard();
    const key = `fx-conflict-${unique()}`;
    const body = payload();

    expect((await enter(o, o.businessId, body, key)).status).toBe(201);
    const second = await enter(o, o.businessId, { ...body, rate: '3.8000000000' }, key);

    expect(second.status).toBe(409);
    expect((second.body['error'] as Record<string, unknown>)['details']).toMatchObject({ code: 'accounting.idempotency_conflict' });
    expect(await rateCount(o.businessId)).toBe(1);
  });

  it('refuses two different keys stating different rates for one pair and instant', async () => {
    const o = await onboard();
    const body = payload();

    expect((await enter(o, o.businessId, body, `fx-a-${unique()}`)).status).toBe(201);
    const second = await enter(o, o.businessId, { ...body, rate: '3.9000000000' }, `fx-b-${unique()}`);

    expect(second.status).toBe(409);
    expect((second.body['error'] as Record<string, unknown>)['details']).toMatchObject({ code: 'accounting.fx_rate_conflict' });
    expect(await rateCount(o.businessId)).toBe(1);
  });

  it('accepts two different keys stating the SAME rate, and stores one row', async () => {
    const o = await onboard();
    const body = payload();

    const first = await enter(o, o.businessId, body, `fx-same-a-${unique()}`);
    const second = await enter(o, o.businessId, body, `fx-same-b-${unique()}`);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body['created']).toBe(false);
    expect(second.body['rateId']).toBe(first.body['rateId']);
    expect(await rateCount(o.businessId)).toBe(1);
  });

  it('refuses a request that carries no Idempotency-Key at all (§33)', async () => {
    const o = await onboard();
    const res = await enterWithoutKey(o, o.businessId, payload());
    expect(res.status).toBe(400);
    expect(await rateCount(o.businessId)).toBe(0);
  });

  it('refuses an Idempotency-Key too short to be one', async () => {
    const o = await onboard();
    const res = await enter(o, o.businessId, payload(), 'short');
    expect(res.status).toBe(400);
    expect(await rateCount(o.businessId)).toBe(0);
  });
});

// ── §38 authority ─────────────────────────────────────────────────────────

describe('who may configure a rate (§38)', () => {
  beforeAll(restart, 180_000);

  it('refuses a member who does not hold accounting.fx.manage', async () => {
    const o = await onboard();
    await grantFeature(o.businessId, o.userId, 'CUSTOM_ROLES');

    const role = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(o, o.businessId))
      .send({ key: `nofx-${Math.floor(Math.random() * 1e6)}`, name: 'No FX', permissions: ['accounting.view'] });
    expect(role.status).toBe(201);

    const member = await register('No FX');
    const add = await t.request
      .post('/v1/businesses/current/members')
      .set(auth(o, o.businessId))
      .send({ email: member.email, roleKey: (role.body as { key: string }).key });
    expect(add.status).toBe(201);

    const res = await enter(member, o.businessId, payload(), `fx-noperm-${unique()}`);
    expect(res.status).toBe(403);
    expect(await rateCount(o.businessId)).toBe(0);
  });

  it('refuses a BRANCH-SCOPED member who does hold accounting.fx.manage', async () => {
    const o = await onboard();
    await grantFeature(o.businessId, o.userId, 'CUSTOM_ROLES');
    await grantFeature(o.businessId, o.userId, 'MULTI_BRANCH');

    const roleKey = `fxbranch-${Math.floor(Math.random() * 1e6)}`;
    const role = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(o, o.businessId))
      .send({ key: roleKey, name: 'Branch FX', permissions: ['accounting.view', 'accounting.fx.manage'] });
    expect(role.status).toBe(201);

    const member = await register('Branch FX');
    const add = await t.request.post('/v1/businesses/current/members').set(auth(o, o.businessId)).send({ email: member.email, roleKey });
    expect(add.status).toBe(201);

    const branches = await t.request.get('/v1/businesses/current/branches').set(auth(o, o.businessId));
    const branchId = (branches.body.items as { id: string }[])[0]?.id ?? '';
    expect(branchId).not.toBe('');

    const scope = await t.request
      .patch(`/v1/businesses/current/members/${member.userId}/branch-scope`)
      .set(auth(o, o.businessId))
      .send({ mode: 'assigned', branchIds: [branchId] });
    expect(scope.status).toBe(200);

    // Holding the permission is not the question. A rate applies to every
    // branch, and this member's authority reaches one.
    const res = await enter(member, o.businessId, payload(), `fx-scoped-${unique()}`);
    expect(res.status).toBe(403);
    expect(await rateCount(o.businessId)).toBe(0);

    // The same member, given business-wide authority, is accepted — so the
    // refusal above is the branch scope and nothing else.
    const widened = await t.request
      .patch(`/v1/businesses/current/members/${member.userId}/branch-scope`)
      .set(auth(o, o.businessId))
      .send({ mode: 'all', branchIds: [] });
    expect(widened.status).toBe(200);

    const accepted = await enter(member, o.businessId, payload(), `fx-widened-${unique()}`);
    expect(accepted.status).toBe(201);
    expect((await storedRate(accepted.body['rateId'] as string)).entered_by_user_id).toBe(member.userId);
  });

  it('refuses a path business that is not the business the membership resolved', async () => {
    const a = await onboard();
    const b = await onboard();

    const res = await enter(a, a.businessId, payload(), `fx-foreign-${unique()}`, b.businessId);
    expect(res.status).toBe(403);
    expect(await rateCount(a.businessId)).toBe(0);
    expect(await rateCount(b.businessId)).toBe(0);
  });

  it('refuses an unauthenticated request', async () => {
    const o = await onboard();
    const res = await t.request
      .post(`/v1/businesses/${o.businessId}/accounting/fx-rates`)
      .set('X-Business-Id', o.businessId)
      .set('Idempotency-Key', `fx-anon-${unique()}`)
      .send(payload());
    expect(res.status).toBe(401);
    expect(await rateCount(o.businessId)).toBe(0);
  });
});

// ── §39, §40 the payload contract ─────────────────────────────────────────

describe('the payload is strict (§39, §40)', () => {
  let o: Owner;

  beforeAll(async () => {
    await restart();
    o = await onboard();
  }, 180_000);

  const refused = async (body: Record<string, unknown>): Promise<number> => {
    const before = await rateCount(o.businessId);
    const res = await enter(o, o.businessId, body, `fx-bad-${unique()}`);
    expect(await rateCount(o.businessId)).toBe(before);
    return res.status;
  };

  it.each([
    ['an unknown field', payload({ note: 'anything' })],
    ['a client-stated source', payload({ source: 'provider' })],
    ['a client-stated actor', payload({ enteredByUserId: '00000000-0000-0000-0000-000000000001' })],
    ['a client-stated tenant', payload({ tenantId: '00000000-0000-0000-0000-000000000001' })],
    ['a client-stated business', payload({ businessId: '00000000-0000-0000-0000-000000000001' })],
    ['a client-stated rate id', payload({ rateId: '00000000-0000-0000-0000-000000000001' })],
  ])('refuses %s', async (_name, body) => {
    expect(await refused(body)).toBe(400);
  });

  it.each([
    ['a JSON number', 3.71],
    ['a JSON number that happens to be an integer', 4],
    ['scientific notation', '3.71e0'],
    ['an exponent', '1E2'],
    ['NaN as text', 'NaN'],
    ['Infinity as text', 'Infinity'],
    ['a negative rate', '-3.71'],
    ['zero', '0'],
    ['zero to full scale', '0.0000000000'],
    ['eleven fraction digits', '1.00000000001'],
    ['a leading plus', '+3.71'],
    ['a bare decimal point', '.71'],
    ['a trailing decimal point', '3.'],
    ['a thousands separator', '3,71'],
    ['whitespace', ' 3.71 '],
    ['an empty string', ''],
    ['null', null],
  ])('refuses a rate given as %s', async (_name, rate) => {
    expect(await refused(payload({ rate }))).toBe(400);
  });

  it.each([
    ['sub-second precision', '2026-01-01T00:00:00.500Z'],
    ['a non-UTC offset', '2026-01-01T02:00:00+02:00'],
    ['no zone at all', '2026-01-01T00:00:00'],
    ['a lowercase zone marker', '2026-01-01T00:00:00z'],
    ['a date alone', '2026-01-01'],
    ['null', null],
  ])('refuses an effectiveAt given with %s', async (_name, effectiveAt) => {
    expect(await refused(payload({ effectiveAt }))).toBe(400);
  });

  it.each([
    ['a lowercase code', { fromCurrency: 'usd' }],
    ['a four-letter code', { fromCurrency: 'USDT' }],
    ['a two-letter code', { toCurrency: 'IL' }],
    ['a numeric code', { fromCurrency: '840' }],
    ['the same currency on both sides', { fromCurrency: 'ILS', toCurrency: 'ILS' }],
  ])('refuses %s', async (_name, over) => {
    expect(await refused(payload(over))).toBe(400);
  });

  it('refuses a well-formed code that is not a registered currency (§13)', async () => {
    // ZZZ matches `[A-Z]{3}` and is still not money: the registry decides,
    // not the regular expression.
    const res = await enter(o, o.businessId, payload({ fromCurrency: 'ZZZ' }), `fx-zzz-${unique()}`);
    expect(res.status).toBe(400);
    expect((res.body['error'] as Record<string, unknown>)['details']).toMatchObject({ code: 'accounting.fx_currency_unknown' });
  });

  it.each([['fromCurrency'], ['toCurrency'], ['rate'], ['effectiveAt']])('refuses a payload missing %s', async (field) => {
    const body = payload();
    delete body[field];
    expect(await refused(body)).toBe(400);
  });

  it('never leaks a SQLSTATE, a constraint name or the rate itself in a refusal (§17)', async () => {
    const key = `fx-leak-${unique()}`;
    const body = payload();
    expect((await enter(o, o.businessId, body, key)).status).toBe(201);
    const conflict = await enter(o, o.businessId, { ...body, rate: '9.9900000000' }, key);

    expect(conflict.status).toBe(409);
    const text = JSON.stringify(conflict.body);
    // Word-bounded: the body carries a requestId, and an unbounded SQLSTATE
    // pattern can match the decimal digits inside a UUID's hex.
    expect(text).not.toMatch(/\b23505\b|\bP0001\b|accounting_fx_rates_|unique|constraint/i);
    expect(text).not.toContain('9.99');
    expect(text).not.toContain('3.71');
  });
});
