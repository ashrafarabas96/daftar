/**
 * KEYSET PAGINATION, UNDER THE CONDITIONS THAT BREAK OFFSET (P2-S7 §28, §49, §50).
 *
 * Three cases, and each one is a defect that OFFSET pagination produces on a
 * real ledger rather than a theoretical worry.
 *
 * §50 — a page boundary that falls INSIDE one date. Month-end is not an edge
 * case in accounting, it is the busiest day of the month, and a cursor made of
 * a date alone cannot resume inside one. A cursor of `(date, entry, line)`
 * can, and the proof is that every row appears exactly once across the walk.
 *
 * §49 — a posting made BETWEEN two page requests. With OFFSET, a row inserted
 * before the current offset shifts everything after it by one, so page 2
 * repeats a row page 1 already showed. With a keyset, the predicate is stated
 * about values rather than positions, so no row that existed at page 1 is
 * repeated or skipped. What the walk does NOT promise is a snapshot: a row
 * appended after the cursor may appear later, and the contract says so rather
 * than claiming an isolation level HTTP cannot provide.
 *
 * §28 — the running balance must continue across pages. A resumed page whose
 * opening figure restarted at the range boundary would show a second page of
 * correct-looking rows with wrong balances beside them.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { fingerprintOf, must, postAdjustmentAs, sourceAssertion, todayIn, type PostCommand, type PostLine } from '../helpers/accounting-posting';

let t: TestApp;
const AT = new Date('2026-03-14T09:15:00Z');
const unique = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

interface Owner {
  token: string;
  userId: string;
  businessId: string;
  tenantId: string;
}

const auth = (o: Owner) => ({ Authorization: `Bearer ${o.token}`, 'X-Business-Id': o.businessId });

async function onboard(): Promise<Owner> {
  const reg = await t.request
    .post('/v1/auth/register')
    .send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Page Owner', preferredLocale: 'ar' });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  const on = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `idem-${unique()}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ businessName: 'Page Biz', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `pg-${unique()}`.slice(0, 60) });
  expect(on.status).toBe(201);
  const businessId = on.body.businessId as string;
  const r = await ownerPool().query<{ tenant_id: string }>(`SELECT tenant_id FROM businesses WHERE id = $1`, [businessId]);
  return { token, userId: me.body.userId as string, businessId, tenantId: must(r.rows[0]).tenant_id };
}

function daysBefore(today: string, n: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function pair(amount: bigint): PostLine[] {
  const base = {
    baseAmountMinor: amount,
    baseCurrency: 'ILS',
    txnAmountMinor: amount,
    txnCurrency: 'ILS',
    fxRate: '1',
    fxRateSource: 'base' as const,
    fxRateAt: AT,
    branchId: null,
    warehouseId: null,
  };
  return [
    { account: { kind: 'system', systemKey: 'cash' }, side: 'D', ...base },
    { account: { kind: 'system', systemKey: 'sales_revenue' }, side: 'C', ...base },
  ];
}

async function adjust(o: Owner, entryDate: string, amount: bigint): Promise<string> {
  const c: PostCommand = {
    tenantId: o.tenantId,
    businessId: o.businessId,
    sourceType: 'manual_adjustment',
    sourceId: randomUUID(),
    entryDate,
    description: 'a paged fact',
    requestId: 'req-page',
    lines: pair(amount),
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
  const out = await postAdjustmentAs(assertion, c, 'paging');
  return out.entryId;
}

interface Row {
  entryId: string;
  entryDate: string;
  lineNo: number;
  debitMinor: string;
  runningMinor: string;
}

interface Page {
  items: Row[];
  nextCursor: string | null;
  openingMinor: string;
  closingMinor: string;
}

async function ledgerPage(o: Owner, accountId: string, from: string, to: string, limit: number, cursor?: string | null): Promise<Page> {
  const res = await t.request
    .get(`/v1/businesses/${o.businessId}/accounting/ledger`)
    .query({ accountId, from, to, limit, ...(cursor === null || cursor === undefined ? {} : { cursor }) })
    .set(auth(o));
  expect(res.status).toBe(200);
  const body = res.body as Record<string, unknown>;
  return {
    items: body['items'] as Row[],
    nextCursor: body['nextCursor'] as string | null,
    openingMinor: body['openingMinor'] as string,
    closingMinor: body['closingMinor'] as string,
  };
}

/** Walk every page, bounded, and return the rows in the order they arrived. */
async function walk(o: Owner, accountId: string, from: string, to: string, limit: number): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const page: Page = await ledgerPage(o, accountId, from, to, limit, cursor);
    rows.push(...page.items);
    if (page.nextCursor === null) return rows;
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not terminate — a cursor is not advancing');
}

let o: Owner;
let today: string;
let cashId: string;

beforeAll(async () => {
  await resetData();
  t = await createTestApp();
  o = await onboard();
  today = await todayIn(ownerPool(), 'Asia/Hebron');
  // Eleven entries on ONE date, plus one on each neighbouring date. Every
  // entry touches cash, so the cash ledger has thirteen rows and eleven of
  // them share a date — which is where a `(date)` cursor gives up.
  await adjust(o, daysBefore(today, 40), 1_000n);
  for (let i = 0; i < 11; i += 1) await adjust(o, daysBefore(today, 30), BigInt(100 + i));
  await adjust(o, daysBefore(today, 20), 2_000n);
  const accounts = (await t.request.get(`/v1/businesses/${o.businessId}/accounting/accounts`).set(auth(o))).body.items as {
    code: string;
    accountId: string;
  }[];
  cashId = must(accounts.find((a) => a.code === '1000')).accountId;
}, 300_000);

describe('a page boundary inside one busy date (§50)', () => {
  it('returns every row exactly once, with no duplicate and no omission, at every page size', async () => {
    const from = daysBefore(today, 60);
    const full = await walk(o, cashId, from, today, 200);
    expect(full.length).toBe(13);

    const identity = (r: Row): string => `${r.entryId}:${r.lineNo}`;
    const expected = full.map(identity);
    expect(new Set(expected).size).toBe(13);

    // Page sizes that deliberately cut through the eleven same-date rows.
    for (const size of [1, 2, 3, 4, 5, 7, 12]) {
      const paged = await walk(o, cashId, from, today, size);
      expect(paged.map(identity)).toEqual(expected);
    }
  }, 180_000);

  it('the running balance continues across pages instead of restarting (§29)', async () => {
    const from = daysBefore(today, 60);
    const oneShot = await walk(o, cashId, from, today, 200);
    const paged = await walk(o, cashId, from, today, 3);
    expect(paged.map((r) => r.runningMinor)).toEqual(oneShot.map((r) => r.runningMinor));

    // And the opening figure of a resumed page is the balance AT the cursor,
    // so the first row of page 2 continues from where page 1 stopped.
    const first = await ledgerPage(o, cashId, from, today, 3);
    const second = await ledgerPage(o, cashId, from, today, 3, first.nextCursor);
    expect(second.openingMinor).toBe(first.closingMinor);
  }, 180_000);

  it('a cursor from one range is not silently reused to escape another', async () => {
    // A cursor is a position in an ordering, not an authority. Handing page
    // 1's cursor to a NARROWER range must still respect that range's own
    // bounds rather than resuming outside them.
    const wide = await ledgerPage(o, cashId, daysBefore(today, 60), today, 1);
    const narrow = await ledgerPage(o, cashId, daysBefore(today, 25), today, 50, wide.nextCursor);
    expect(narrow.items.every((r) => r.entryDate >= daysBefore(today, 25))).toBe(true);
  });
});

describe('a posting appended between two page requests (§49)', () => {
  it('repeats no row of page 1 and skips no row that already existed', async () => {
    const from = daysBefore(today, 60);
    const before = await walk(o, cashId, from, today, 200);
    const page1 = await ledgerPage(o, cashId, from, today, 5);
    expect(page1.items.length).toBe(5);
    expect(page1.nextCursor).not.toBeNull();

    // A real posting, through the real command, on a LATER date — the
    // append-only case a live ledger actually produces.
    const appended = await adjust(o, daysBefore(today, 5), 9_999n);

    const page2 = await ledgerPage(o, cashId, from, today, 200, page1.nextCursor);
    const identity = (r: Row): string => `${r.entryId}:${r.lineNo}`;
    const page1Ids = new Set(page1.items.map(identity));

    // No repeat.
    for (const row of page2.items) expect(page1Ids.has(identity(row))).toBe(false);

    // No omission: everything that existed when page 1 was served is on one
    // of the two pages.
    const seen = new Set([...page1.items.map(identity), ...page2.items.map(identity)]);
    for (const row of before) expect(seen.has(identity(row))).toBe(true);

    // The appended row MAY appear, because it sorts after the cursor. The
    // documented model is append-stable traversal, not a snapshot, and this
    // is the assertion that says which one DAFTAR promises.
    expect(page2.items.some((r) => r.entryId === appended)).toBe(true);
  }, 180_000);
});

describe('the server bounds the page, whatever the caller asks for (§53)', () => {
  it('refuses an absurd page size rather than serving it', async () => {
    const res = await t.request
      .get(`/v1/businesses/${o.businessId}/accounting/ledger`)
      .query({ accountId: cashId, from: daysBefore(today, 60), to: today, limit: 100000 })
      .set(auth(o));
    expect(res.status).toBe(400);
  });

  it('refuses a page size of zero or a negative one', async () => {
    for (const limit of [0, -1]) {
      const res = await t.request
        .get(`/v1/businesses/${o.businessId}/accounting/ledger`)
        .query({ accountId: cashId, from: daysBefore(today, 60), to: today, limit })
        .set(auth(o));
      expect(res.status).toBe(400);
    }
  });

  it('the entry list paginates on its own tuple and terminates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const res = await t.request
        .get(`/v1/businesses/${o.businessId}/accounting/entries`)
        .query({ limit: 2, ...(cursor === null || cursor === undefined ? {} : { cursor }) })
        .set(auth(o));
      expect(res.status).toBe(200);
      const body = res.body as { items: { entryId: string }[]; nextCursor: string | null };
      seen.push(...body.items.map((e) => e.entryId));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(seen.length).toBeGreaterThanOrEqual(14);
    expect(new Set(seen).size).toBe(seen.length);
  }, 180_000);

  it('refuses an entry-list cursor presented to the ledger, and the reverse', async () => {
    const entryPage = await t.request.get(`/v1/businesses/${o.businessId}/accounting/entries`).query({ limit: 1 }).set(auth(o));
    const entryCursor = (entryPage.body as { nextCursor: string | null }).nextCursor;
    expect(entryCursor).not.toBeNull();

    const wrong = await t.request
      .get(`/v1/businesses/${o.businessId}/accounting/ledger`)
      .query({ accountId: cashId, from: daysBefore(today, 60), to: today, cursor: entryCursor })
      .set(auth(o));
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);

    const ledger = await ledgerPage(o, cashId, daysBefore(today, 60), today, 1);
    const backwards = await t.request.get(`/v1/businesses/${o.businessId}/accounting/entries`).query({ cursor: ledger.nextCursor }).set(auth(o));
    expect(backwards.status).toBeGreaterThanOrEqual(400);
    expect(backwards.status).toBeLessThan(500);
  });
});
