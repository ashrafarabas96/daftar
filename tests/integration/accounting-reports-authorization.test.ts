/**
 * WHO MAY READ THE BOOKS, AND HOW MUCH OF THEM (P2-S7 §36, §37, §62, §63, §64).
 *
 * Every case below goes over HTTP, through the real guard, the real
 * membership resolution and the real database. A unit test of the service
 * would prove that one function refuses; what has to be proven here is that
 * the refusal is reachable from the wire, on every one of the six read
 * endpoints, for every membership shape the product can actually produce.
 *
 * Three matrices, and they are deliberately not merged:
 *
 *   §62 — the PERMISSION matrix. `accounting.view` and nothing else opens the
 *         books. `accounting.post` is a different authority and grants no
 *         read; the built-in manager and cashier gain neither by existing.
 *
 *   §63 — the BRANCH matrix. An assigned-scope member has a dimension, not a
 *         smaller business: they may name a branch they hold, and they may
 *         not have an unfiltered business-wide aggregate at all. A journal
 *         entry is whole or invisible, because a partial entry does not
 *         balance and a reader would not know it had been trimmed.
 *
 *   §64 — the TENANT matrix. Business A cannot reach business B by any of the
 *         six routes, and cannot learn from the refusal whether the id it
 *         guessed was real.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, grantFeature, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import {
  fingerprintOf,
  must,
  openingBalanceFingerprintOf,
  postAdjustmentAs,
  postOpeningBalanceAs,
  sourceAssertion,
  todayIn,
  type PostCommand,
  type PostLine,
} from '../helpers/accounting-posting';

let t: TestApp;

const AT = new Date('2026-03-14T09:15:00Z');
const unique = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

interface Principal {
  token: string;
  userId: string;
  email: string;
}

interface Business extends Principal {
  businessId: string;
  tenantId: string;
}

const auth = (token: string, businessId: string) => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });

async function register(name: string): Promise<Principal> {
  const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: name, preferredLocale: 'ar' });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  return { token, userId: me.body.userId as string, email: me.body.email as string };
}

async function onboard(name: string, slug: string): Promise<Business> {
  const u = await register(name);
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${unique()}`)
    .set('Authorization', `Bearer ${u.token}`)
    .send({ businessName: name, countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `${slug}-${unique()}`.slice(0, 60) });
  expect(on.status).toBe(201);
  const businessId = on.body.businessId as string;
  const r = await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId]);
  return { ...u, businessId, tenantId: must(r.rows[0]).tenant_id };
}

type Key = 'cash' | 'opening_equity' | 'sales_revenue';

function line(key: Key, side: 'D' | 'C', amount: bigint, branchId: string | null): PostLine {
  return {
    account: { kind: 'system', systemKey: key },
    side,
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base',
    fxRateAt: AT,
    branchId,
    warehouseId: null,
  };
}

async function adjust(o: Business, entryDate: string, lines: readonly PostLine[]): Promise<string> {
  const c: PostCommand = {
    tenantId: o.tenantId,
    businessId: o.businessId,
    sourceType: 'manual_adjustment',
    sourceId: randomUUID(),
    entryDate,
    description: 'a dimensioned fact',
    requestId: 'req-auth',
    lines: [...lines],
  };
  const assertion = sourceAssertion({
    actorUserId: o.userId,
    tenantId: o.tenantId,
    businessId: o.businessId,
    operationKind: 'post',
    sourceType: 'manual_adjustment',
    sourceId: c.sourceId,
    postingFingerprint: fingerprintOf(c),
  });
  return (await postAdjustmentAs(assertion, c, 'because the merchant said so')).entryId;
}

async function openingBalance(o: Business, asOfDate: string, positions: readonly PostLine[]): Promise<string> {
  const openingBalanceId = randomUUID();
  const assertion = sourceAssertion({
    actorUserId: o.userId,
    tenantId: o.tenantId,
    businessId: o.businessId,
    operationKind: 'post',
    sourceType: 'opening_balance',
    sourceId: openingBalanceId,
    postingFingerprint: openingBalanceFingerprintOf({
      tenantId: o.tenantId,
      businessId: o.businessId,
      openingBalanceId,
      asOfDate,
      baseCurrency: 'ILS',
      positions,
    }),
  });
  return (await postOpeningBalanceAs(assertion, { asOfDate, positions, openingBalanceId })).entryId;
}

function daysBefore(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** The six read routes, each named by the query that makes it well-formed. */
function readRoutes(
  businessId: string,
  ctx: { entryId: string; accountId: string; today: string },
): { name: string; path: string; query: Record<string, string> }[] {
  const base = `/v1/businesses/${businessId}/accounting`;
  return [
    { name: 'accounts', path: `${base}/accounts`, query: {} },
    { name: 'entries', path: `${base}/entries`, query: {} },
    { name: 'entry detail', path: `${base}/entries/${ctx.entryId}`, query: {} },
    { name: 'trial balance', path: `${base}/trial-balance`, query: { asOf: ctx.today } },
    { name: 'ledger', path: `${base}/ledger`, query: { accountId: ctx.accountId, from: daysBefore(ctx.today, 500), to: ctx.today } },
    { name: 'balances', path: `${base}/balances`, query: { asOf: ctx.today } },
  ];
}

// ── The fixture ───────────────────────────────────────────────────────────
//
// One business, two branches, and four entries chosen so that every branch
// shape a report can meet is present exactly once: wholly in branch one,
// wholly in branch two, split across both, and carrying the business-level
// NULL dimension an opening balance writes.

interface Fixture {
  owner: Business;
  other: Business;
  branch1: string;
  branch2: string;
  today: string;
  cashId: string;
  entryBranch1: string;
  entryBranch2: string;
  entryMixed: string;
  entryOpening: string;
  viewer: Principal; // accounting.view, whole-business scope
  assigned: Principal; // accounting.view, assigned to branch1 only
  poster: Principal; // accounting.post WITHOUT accounting.view
  manager: Principal; // built-in manager
  cashier: Principal; // built-in cashier
}

let f: Fixture;

async function addMember(owner: Business, roleKey: string, name: string): Promise<Principal> {
  const u = await register(name);
  const add = await t.request.post('/v1/businesses/current/members').set(auth(owner.token, owner.businessId)).send({ email: u.email, roleKey });
  expect(add.status).toBe(201);
  return u;
}

beforeAll(async () => {
  await resetData();
  t = await createTestApp();

  const owner = await onboard('Authz Biz', 'authz');
  const other = await onboard('Other Biz', 'authz-other');
  const today = await todayIn(ownerPool(), 'Asia/Hebron');

  await grantFeature(owner.businessId, owner.userId, 'MULTI_BRANCH');
  await grantFeature(owner.businessId, owner.userId, 'CUSTOM_ROLES');
  await ownerPool().query(
    `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id) VALUES ($1, 'MAX_BRANCHES', 10, 'p2-s7-authz', $2), ($1, 'MAX_USERS', 20, 'p2-s7-authz', $2)`,
    [owner.businessId, owner.userId],
  );

  const branches = (await t.request.get('/v1/businesses/current/branches').set(auth(owner.token, owner.businessId))).body.items as { id: string }[];
  const branch1 = must(branches[0]).id;
  const second = await t.request.post('/v1/businesses/current/branches').set(auth(owner.token, owner.businessId)).send({ name: 'Second' });
  expect(second.status).toBe(201);
  const branch2 = second.body.id as string;

  // The four dimension shapes.
  const entryOpening = await openingBalance(owner, daysBefore(today, 400), [line('cash', 'D', 100_000n, null)]);
  const entryBranch1 = await adjust(owner, daysBefore(today, 60), [line('cash', 'D', 10_000n, branch1), line('sales_revenue', 'C', 10_000n, branch1)]);
  const entryBranch2 = await adjust(owner, daysBefore(today, 50), [line('cash', 'D', 20_000n, branch2), line('sales_revenue', 'C', 20_000n, branch2)]);
  const entryMixed = await adjust(owner, daysBefore(today, 40), [line('cash', 'D', 5_000n, branch1), line('sales_revenue', 'C', 5_000n, branch2)]);

  const cash = await ownerPool().query<{ id: string }>(`SELECT id FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [owner.businessId]);
  const cashId = must(cash.rows[0]).id;

  for (const [key, name, permissions] of [
    ['reader', 'Reader', ['accounting.view']],
    ['poster', 'Poster', ['accounting.post']],
  ] as const) {
    const role = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, owner.businessId))
      .send({ key, name, permissions: [...permissions] });
    expect(role.status).toBe(201);
  }

  const viewer = await addMember(owner, 'reader', 'Viewer');
  const assigned = await addMember(owner, 'reader', 'Assigned');
  const poster = await addMember(owner, 'poster', 'Poster');
  const manager = await addMember(owner, 'manager', 'Manager');
  const cashier = await addMember(owner, 'cashier', 'Cashier');

  const scope = await t.request
    .patch(`/v1/businesses/current/members/${assigned.userId}/branch-scope`)
    .set(auth(owner.token, owner.businessId))
    .send({ mode: 'assigned', branchIds: [branch1] });
  expect(scope.status).toBe(200);

  f = { owner, other, branch1, branch2, today, cashId, entryBranch1, entryBranch2, entryMixed, entryOpening, viewer, assigned, poster, manager, cashier };
}, 300_000);

/**
 * A refusal, stripped of the one field that is SUPPOSED to differ.
 *
 * Every error body carries a fresh `requestId` so an operator can correlate
 * a complaint with a log line. It is per-request by construction, so the
 * indistinguishability claims below compare everything else: the code, the
 * message, and the absence of any field one refusal carries and the other
 * does not.
 */
function refusal(body: Record<string, unknown>): string {
  const e = { ...(body['error'] as Record<string, unknown>) };
  delete e['requestId'];
  return JSON.stringify({ ...body, error: e });
}

const routes = (): { name: string; path: string; query: Record<string, string> }[] =>
  readRoutes(f.owner.businessId, { entryId: f.entryBranch1, accountId: f.cashId, today: f.today });

async function call(token: string, businessId: string, route: { path: string; query: Record<string, string> }) {
  return t.request.get(route.path).query(route.query).set(auth(token, businessId));
}

describe('the permission matrix (§62)', () => {
  it('the owner reads every one of the six financial reads', async () => {
    for (const r of routes()) {
      const res = await call(f.owner.token, f.owner.businessId, r);
      expect(`${r.name}:${res.status}`).toBe(`${r.name}:200`);
    }
  });

  it('a member holding nothing but accounting.view reads every one of them', async () => {
    for (const r of routes()) {
      const res = await call(f.viewer.token, f.owner.businessId, r);
      expect(`${r.name}:${res.status}`).toBe(`${r.name}:200`);
    }
  });

  /**
   * The key that creates financial facts is not the key that reads the
   * books. A source workflow may post; it may not therefore see the
   * merchant's position, their revenue, or anyone else's entries.
   */
  it('accounting.post grants no read authority on any of them', async () => {
    for (const r of routes()) {
      const res = await call(f.poster.token, f.owner.businessId, r);
      expect(`${r.name}:${res.status}`).toBe(`${r.name}:403`);
    }
  });

  it('the built-in manager and cashier roles gain no read authority by existing', async () => {
    for (const who of [f.manager, f.cashier]) {
      for (const r of routes()) {
        const res = await call(who.token, f.owner.businessId, r);
        expect(`${r.name}:${res.status}`).toBe(`${r.name}:403`);
      }
    }
  });
});

describe('the branch matrix (§36, §37, §63)', () => {
  it('a whole-business member gets the whole business, and it balances', async () => {
    const res = await call(f.viewer.token, f.owner.businessId, {
      path: `/v1/businesses/${f.owner.businessId}/accounting/trial-balance`,
      query: { asOf: f.today },
    });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('whole_business');
    expect(res.body.isBalanced).toBe(true);
    expect(res.body.totalDebitMinor).toBe('135000');
    expect(res.body.totalCreditMinor).toBe('135000');
  });

  /**
   * §24. A branch is a DIMENSION over one set of books, not a second set of
   * books, so a branch-filtered trial balance is free not to balance — here
   * the split entry puts its debit in branch one and its credit in branch
   * two. The report says so rather than inventing a clearing account or
   * dropping the entry to make the columns agree.
   */
  it('a branch filter is a dimension, and says plainly that it does not balance', async () => {
    const res = await call(f.viewer.token, f.owner.businessId, {
      path: `/v1/businesses/${f.owner.businessId}/accounting/trial-balance`,
      query: { asOf: f.today, branchId: f.branch1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('branch_dimension');
    expect(res.body.isBalanced).toBe(false);
    expect(res.body.totalDebitMinor).toBe('15000');
    expect(res.body.totalCreditMinor).toBe('10000');
  });

  /**
   * §37. The opening balance carries the business-level NULL dimension: it
   * is the position of the business, not of any branch. A branch report that
   * swept it in would tell a branch manager their branch holds 100,000 of
   * cash it never received.
   */
  it('a NULL-dimension opening balance never appears in a branch-filtered report', async () => {
    const both = await Promise.all(
      [f.branch1, f.branch2].map((branchId) =>
        call(f.viewer.token, f.owner.businessId, { path: `/v1/businesses/${f.owner.businessId}/accounting/trial-balance`, query: { asOf: f.today, branchId } }),
      ),
    );
    const cashOf = (res: { body: Record<string, unknown> }): string =>
      must((res.body['items'] as { code: string; totalDebitMinor: string }[]).find((r) => r.code === '1000')).totalDebitMinor;
    expect(cashOf(must(both[0]))).toBe('15000');
    expect(cashOf(must(both[1]))).toBe('20000');
  });

  it('an assigned member may not have an unfiltered business-wide aggregate', async () => {
    for (const [path, query] of [
      [`trial-balance`, { asOf: f.today }],
      [`balances`, { asOf: f.today }],
      [`ledger`, { accountId: f.cashId, from: daysBefore(f.today, 500), to: f.today }],
    ] as const) {
      const res = await call(f.assigned.token, f.owner.businessId, { path: `/v1/businesses/${f.owner.businessId}/accounting/${path}`, query });
      expect(`${path}:${res.status}`).toBe(`${path}:403`);
    }
  });

  it('an assigned member reading their own branch gets their own branch', async () => {
    const res = await call(f.assigned.token, f.owner.businessId, {
      path: `/v1/businesses/${f.owner.businessId}/accounting/trial-balance`,
      query: { asOf: f.today, branchId: f.branch1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.totalDebitMinor).toBe('15000');
    expect(res.body.totalCreditMinor).toBe('10000');
  });

  /**
   * A branch they do not hold, a branch of another business and a branch
   * that never existed are all refused, and refused identically: the
   * response does not tell the caller which of the three they guessed.
   */
  it('a branch outside the assignment is refused, whoever it belongs to', async () => {
    const foreign = (await ownerPool().query<{ id: string }>(`SELECT id FROM branches WHERE business_id = $1 LIMIT 1`, [f.other.businessId])).rows;
    const candidates = [f.branch2, must(foreign[0]).id, randomUUID()];
    const seen = new Set<string>();
    for (const branchId of candidates) {
      const res = await call(f.assigned.token, f.owner.businessId, {
        path: `/v1/businesses/${f.owner.businessId}/accounting/trial-balance`,
        query: { asOf: f.today, branchId },
      });
      expect(res.status).toBe(403);
      seen.add(refusal(res.body as Record<string, unknown>));
    }
    expect(seen.size).toBe(1);
  });

  /**
   * The entry LIST is the one aggregate an assigned member may read
   * unfiltered, because the visibility predicate has already done the work:
   * an entry reaches them only when EVERY line is inside their allowance.
   * The split entry fails that test, and so does the NULL-dimension opening.
   */
  it('the entry list shows only entries that lie wholly inside the assignment', async () => {
    const res = await call(f.assigned.token, f.owner.businessId, { path: `/v1/businesses/${f.owner.businessId}/accounting/entries`, query: {} });
    expect(res.status).toBe(200);
    const ids = (res.body.items as { entryId: string }[]).map((e) => e.entryId);
    expect(ids).toEqual([f.entryBranch1]);

    const all = await call(f.viewer.token, f.owner.businessId, { path: `/v1/businesses/${f.owner.businessId}/accounting/entries`, query: {} });
    expect((all.body.items as { entryId: string }[]).length).toBe(4);
  });

  it('a split entry and a NULL-dimension entry are invisible to an assigned member, not trimmed', async () => {
    const mine = await call(f.assigned.token, f.owner.businessId, {
      path: `/v1/businesses/${f.owner.businessId}/accounting/entries/${f.entryBranch1}`,
      query: {},
    });
    expect(mine.status).toBe(200);
    expect((mine.body.lines as unknown[]).length).toBe(2);

    for (const entryId of [f.entryMixed, f.entryOpening, f.entryBranch2]) {
      const res = await call(f.assigned.token, f.owner.businessId, { path: `/v1/businesses/${f.owner.businessId}/accounting/entries/${entryId}`, query: {} });
      expect(res.status).toBe(404);
    }
  });

  it('the refusal for a real hidden entry reads exactly like the refusal for an invented one', async () => {
    const hidden = await call(f.assigned.token, f.owner.businessId, {
      path: `/v1/businesses/${f.owner.businessId}/accounting/entries/${f.entryMixed}`,
      query: {},
    });
    const invented = await call(f.assigned.token, f.owner.businessId, {
      path: `/v1/businesses/${f.owner.businessId}/accounting/entries/${randomUUID()}`,
      query: {},
    });
    expect(hidden.status).toBe(invented.status);
    expect(refusal(hidden.body as Record<string, unknown>)).toBe(refusal(invented.body as Record<string, unknown>));
  });
});

describe('the tenant matrix (§64)', () => {
  it('one business cannot name another business on the path, on any route', async () => {
    const foreign = readRoutes(f.owner.businessId, { entryId: f.entryBranch1, accountId: f.cashId, today: f.today });
    for (const r of foreign) {
      const res = await call(f.other.token, f.other.businessId, r);
      expect(`${r.name}:${res.status}`).toBe(`${r.name}:403`);
    }
  });

  it("another business's ids are unreachable through one's own routes", async () => {
    const own = `/v1/businesses/${f.other.businessId}/accounting`;
    const entry = await t.request.get(`${own}/entries/${f.entryBranch1}`).set(auth(f.other.token, f.other.businessId));
    expect(entry.status).toBe(404);
    const ledger = await t.request
      .get(`${own}/ledger`)
      .query({ accountId: f.cashId, from: daysBefore(f.today, 500), to: f.today })
      .set(auth(f.other.token, f.other.businessId));
    expect(ledger.status).toBe(404);
    const balances = await t.request.get(`${own}/balances`).query({ asOf: f.today, accountId: f.cashId }).set(auth(f.other.token, f.other.businessId));
    expect(balances.status).toBe(200);
    expect(balances.body.items).toEqual([]);
  });

  it('a foreign id and an invented id are refused in the same words', async () => {
    const own = `/v1/businesses/${f.other.businessId}/accounting`;
    const foreign = await t.request.get(`${own}/entries/${f.entryBranch1}`).set(auth(f.other.token, f.other.businessId));
    const invented = await t.request.get(`${own}/entries/${randomUUID()}`).set(auth(f.other.token, f.other.businessId));
    expect(refusal(foreign.body as Record<string, unknown>)).toBe(refusal(invented.body as Record<string, unknown>));

    const foreignLedger = await t.request
      .get(`${own}/ledger`)
      .query({ accountId: f.cashId, from: daysBefore(f.today, 500), to: f.today })
      .set(auth(f.other.token, f.other.businessId));
    const inventedLedger = await t.request
      .get(`${own}/ledger`)
      .query({ accountId: randomUUID(), from: daysBefore(f.today, 500), to: f.today })
      .set(auth(f.other.token, f.other.businessId));
    expect(refusal(foreignLedger.body as Record<string, unknown>)).toBe(refusal(inventedLedger.body as Record<string, unknown>));
  });

  it("no report of one business carries a single row of another's journal", async () => {
    const own = `/v1/businesses/${f.other.businessId}/accounting`;
    const tb = await t.request.get(`${own}/trial-balance`).query({ asOf: f.today }).set(auth(f.other.token, f.other.businessId));
    expect(tb.status).toBe(200);
    expect(tb.body.totalDebitMinor).toBe('0');
    expect(tb.body.totalCreditMinor).toBe('0');
    const entries = await t.request.get(`${own}/entries`).set(auth(f.other.token, f.other.businessId));
    expect(entries.body.items).toEqual([]);
  });
});
