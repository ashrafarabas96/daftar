import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverPhase4Routes } from '../../../scripts/phase4-s1-gate';
import { appDbUrl, createTestApp, ensurePostgres, ownerPool, resetData, uniqueEmail, type TestApp } from '../../helpers/test-app';

/**
 * GOLDEN REGRESSION — GOLD-20 / G-02: THE ENUMERATED CROSS-TENANT SURFACE
 * (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-38, P4-AL-40, P4-AL-43 scenario 8;
 * the `cross-tenant` check of scripts/phase4-s1-gate.ts).
 *
 * Every Phase 4 route refuses another tenant's data AT THE API and AGAIN AT
 * SQL, in ALLOW/DENY PAIRS: each DENY is the exact request or statement of its
 * ALLOW with one thing changed — the ids now name a row of another business —
 * so the pair proves the refusal is isolation and not a broken read.
 *
 * Three businesses. A and A2 belong to the SAME tenant and to the same owner;
 * B belongs to another tenant. A2 is the harder half, because the actor
 * legitimately holds authority there: only binding the read to the ONE
 * business in scope stops it, which is what P4-AL-38's restrictive
 * `business_isolation_read` policy does and what a controller filter alone
 * would not.
 *
 * WHY THE ROUTE LIST IS NOT WRITTEN DOWN TWICE. `PHASE4_ROUTES` below is
 * asserted EQUAL to `discoverPhase4Routes()`, the same function the slice gate
 * enumerates this golden from. A route mounted on the Phase 4 surface and not
 * added here therefore turns this suite red, rather than quietly escaping the
 * only suite that would have refused it. That is the whole of G-02's
 * "enumerated from the route surface": the enumeration is checked, not
 * trusted.
 *
 * WHAT THIS SUITE DOES NOT DO. It creates no command and no write route: P4-S1
 * grants no DML on any Phase 4 relation to any runtime principal, so the
 * fixtures below are inserted by the OWNER connection, which is a test
 * fixture and not a product path. This suite is therefore about ISOLATION —
 * that the reads refuse another tenant — and says nothing about write
 * authority, which no principal has yet. It also asserts nothing about what
 * a later slice may add: it reads the surface that exists.
 */

const REPO = join(__dirname, '..', '..', '..');

/**
 * The Phase 4 read surface, enumerated. Eight routes; the equality below is
 * what makes a ninth impossible to miss.
 */
const PHASE4_ROUTES: readonly string[] = [
  'GET /v1/customers',
  'GET /v1/customers/:customerId',
  'GET /v1/customers/:customerId/open-invoices',
  'GET /v1/customers/:customerId/receivable',
  'GET /v1/customers/:customerId/receivable/aging',
  'GET /v1/invoices',
  'GET /v1/invoices/:invoiceId',
  'GET /v1/invoices/:invoiceId/settlement',
];

/** The five relations 0075 creates, every one of which must refuse a foreign business at SQL. */
const PHASE4_RELATIONS: readonly string[] = ['customers', 'customer_contacts', 'invoices', 'invoice_items', 'invoice_sequences'];

interface Shop {
  readonly tenantId: string;
  readonly businessId: string;
  readonly branchId: string;
  readonly productId: string;
  readonly userId: string;
  readonly customerId: string;
  readonly invoiceId: string;
}

interface Actor {
  readonly token: string;
  readonly userId: string;
}

const hdr = (a: Actor, businessId: string): Record<string, string> => ({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': businessId });

/**
 * The query string each route needs to be a WELL-FORMED request. A route that
 * answers 400 for a missing parameter proves nothing about isolation: the
 * refusal has to be the isolation and not the validator, so every ALLOW below
 * must really be a 200 before its DENY means anything.
 */
const QUERY: Readonly<Record<string, string>> = {
  'GET /v1/customers/:customerId/open-invoices': '?asOf=2026-05-01',
  'GET /v1/customers/:customerId/receivable/aging': '?asOf=2026-05-01&bucketDays=30,60,90',
};

/** Whether a route names a resource in its path, as opposed to paging a collection. */
const isItemRoute = (route: string): boolean => route.includes(':');

/** Every declared route, with its path parameters bound to `shop`'s own ids. */
function bind(route: string, shop: Shop): { method: string; path: string } {
  const [method = 'GET', template = ''] = route.split(' ');
  const path = template.replace(':customerId', shop.customerId).replace(':invoiceId', shop.invoiceId);
  return { method, path: `${path}${QUERY[route] ?? ''}` };
}

/**
 * The Phase 4 fixture of one business: a customer with a contact, a document
 * series, and one OPEN invoice with one line — so every one of the eight reads
 * has something to return, and a leak is a visible row rather than an empty
 * page that looks like a refusal.
 */
async function seedPhase4(pool: Pool, shop: Omit<Shop, 'customerId' | 'invoiceId'>): Promise<{ customerId: string; invoiceId: string }> {
  const customerId = randomUUID();
  const invoiceId = randomUUID();
  const digest = 'a'.repeat(64);
  const period = '2026';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO customers (tenant_id, business_id, id, name, phone, status, revision,
                              create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, '+970000000', 'active', 1, $5, $5, $6, $7, $7)`,
      [shop.tenantId, shop.businessId, customerId, `Customer of ${shop.businessId.slice(0, 8)}`, digest, randomUUID(), shop.userId],
    );
    await client.query(
      `INSERT INTO customer_contacts (tenant_id, business_id, customer_id, id, contact_no, name, is_primary, business_transaction_id, created_by)
       VALUES ($1, $2, $3, $4, 1, 'Primary contact', true, $5, $6)`,
      [shop.tenantId, shop.businessId, customerId, randomUUID(), randomUUID(), shop.userId],
    );
    await client.query(
      `INSERT INTO invoice_sequences (tenant_id, business_id, document_kind, period, number_format)
       VALUES ($1, $2, 'invoice', $3, 'INV-{YYYY}-{SEQ:5}')`,
      [shop.tenantId, shop.businessId, period],
    );
    await client.query(
      `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq,
                             period, issue_date, due_date, currency_code, status, subtotal_txn_minor, discount_txn_minor, tax_minor,
                             total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                             customer_name_snapshot, issue_intent_sha256, business_transaction_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'invoice', $7, 1, $8, DATE '2026-03-14', DATE '2026-04-14', 'ILS', 'draft',
               1000, 0, 0, 1000, 1000, 1, 'base', TIMESTAMPTZ '2026-03-14T09:15:00Z', 'Customer snapshot', $9, $10, $11)`,
      [shop.tenantId, shop.businessId, invoiceId, randomUUID(), customerId, shop.branchId, `INV-${period}-00001`, period, digest, randomUUID(), shop.userId],
    );
    await client.query(
      `INSERT INTO invoice_items (tenant_id, business_id, invoice_id, id, line_no, product_id, name_snapshot, quantity,
                                  unit_price_txn_minor, gross_txn_minor, discount_txn_minor, net_txn_minor, tax_minor, base_share_minor)
       VALUES ($1, $2, $3, $4, 1, $5, 'Line snapshot', 1.0000, 1000, 1000, 0, 1000, 0, 1000)`,
      [shop.tenantId, shop.businessId, invoiceId, randomUUID(), shop.productId],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { customerId, invoiceId };
}

/** One `daftar_app` statement under the tenant/business GUCs of `scope`. */
async function asApp<T extends Record<string, unknown>>(
  pool: Pool,
  scope: { tenantId: string; businessId: string },
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
    const r = await client.query<T>(sql, params);
    await client.query('COMMIT');
    return r.rows;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

let t: TestApp;
let app: Pool;
let A: Shop;
let A2: Shop;
let B: Shop;
let owner: Actor;
let ownerB: Actor;

const onboarding = { countryCode: 'PS', baseCurrency: 'ILS', preferredLocale: 'en' } as const;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  app = new Pool({ connectionString: appDbUrl, max: 4 });

  const register = async (name: string): Promise<Actor> => {
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: name, preferredLocale: 'en' });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, userId: me.body.userId as string };
  };

  const furnish = async (o: Actor, businessId: string): Promise<Shop> => {
    const row = (
      await ownerPool().query<{ tenant_id: string; branch_id: string }>(
        `SELECT b.tenant_id, (SELECT br.id FROM branches br WHERE br.business_id = b.id ORDER BY br.is_default DESC, br.id LIMIT 1) AS branch_id
           FROM businesses b WHERE b.id = $1`,
        [businessId],
      )
    ).rows[0];
    const pr = await t.request
      .post('/v1/catalog/products')
      .set(hdr(o, businessId))
      .send({ translations: { en: 'Golden product' }, basePriceMinor: '1000' });
    expect(pr.status).toBe(201);
    const base = {
      tenantId: row?.tenant_id ?? '',
      businessId,
      branchId: row?.branch_id ?? '',
      productId: pr.body.id as string,
      userId: o.userId,
    };
    const { customerId, invoiceId } = await seedPhase4(ownerPool(), base);
    return { ...base, customerId, invoiceId };
  };

  owner = await register('Owner of A and A2');
  ownerB = await register('Owner of B');
  const a = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `gold20-${randomUUID()}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ ...onboarding, businessName: 'Gold A', storeSlug: `gold-a-${randomUUID().slice(0, 8)}` });
  expect(a.status).toBe(201);
  const a2 = await t.request
    .post(`/v1/tenants/${a.body.tenantId as string}/businesses`)
    .set('Idempotency-Key', `gold20-${randomUUID()}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ ...onboarding, businessName: 'Gold A2', storeSlug: `gold-a2-${randomUUID().slice(0, 8)}` });
  expect(a2.status).toBe(201);
  const b = await t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', `gold20-${randomUUID()}`)
    .set('Authorization', `Bearer ${ownerB.token}`)
    .send({ ...onboarding, businessName: 'Gold B', storeSlug: `gold-b-${randomUUID().slice(0, 8)}` });
  expect(b.status).toBe(201);

  A = await furnish(owner, a.body.businessId as string);
  A2 = await furnish(owner, a2.body.businessId as string);
  B = await furnish(ownerB, b.body.businessId as string);
  expect(A2.tenantId).toBe(A.tenantId);
  expect(B.tenantId).not.toBe(A.tenantId);
}, 300_000);

afterAll(async () => {
  await app?.end();
  await t?.close();
});

describe('the enumeration is checked, not trusted (G-02)', () => {
  it('PHASE4_ROUTES is exactly the Phase 4 route surface the slice gate discovers', () => {
    expect(PHASE4_ROUTES).toEqual(discoverPhase4Routes(REPO));
    expect(PHASE4_ROUTES).toHaveLength(8);
  });

  it('the fixture is real: each of the three businesses holds its own customer and its own invoice', async () => {
    for (const shop of [A, A2, B]) {
      const rows = await asApp<{ n: string }>(app, shop, `SELECT count(*)::text AS n FROM invoices WHERE business_id = $1`, [shop.businessId]);
      expect(rows[0]?.n, `${shop.businessId} has no invoice, so a leak below would look like a refusal`).toBe('1');
    }
    expect(new Set([A.businessId, A2.businessId, B.businessId]).size).toBe(3);
  });
});

describe('SQL: every Phase 4 relation refuses another business, under daftar_app’s row security', () => {
  for (const relation of PHASE4_RELATIONS) {
    it(`${relation}: A sees its own rows and NONE of A2’s or B’s`, async () => {
      // ALLOW: the unqualified read under A's scope returns only A's rows,
      // which is the restrictive business_isolation_read policy doing the
      // filtering — the statement names no business at all.
      const mine = await asApp<{ business_id: string }>(app, A, `SELECT DISTINCT business_id FROM ${relation}`);
      expect(mine.map((r) => r.business_id)).toEqual([A.businessId]);

      // DENY: the same statement, asking for the other business by id. A2 is
      // the same tenant and the same owner, so only the business binding
      // refuses it; B is another tenant and is refused twice over.
      for (const other of [A2, B]) {
        const rows = await asApp<{ business_id: string }>(app, A, `SELECT business_id FROM ${relation} WHERE business_id = $1`, [other.businessId]);
        expect(rows, `${relation} leaked ${other.businessId} to ${A.businessId}`).toEqual([]);
      }
    });
  }

  it('the four read functions refuse another business: they are SECURITY INVOKER, so they see what the caller sees', async () => {
    // ALLOW: A's own invoice and customer answer.
    expect(await asApp(app, A, `SELECT * FROM invoice_outstanding($1::uuid, $2::uuid)`, [A.businessId, A.invoiceId])).toHaveLength(1);
    expect(await asApp(app, A, `SELECT invoice_settlement_state($1::uuid, $2::uuid) AS s`, [A.businessId, A.invoiceId])).toHaveLength(1);

    // DENY: the same call for the other business's invoice. The routine reads
    // `invoices` with the CALLER's privileges and row security, so the row is
    // invisible and the routine raises its own not-found — a definer routine
    // here would have answered with another tenant's money.
    for (const other of [A2, B]) {
      await expect(asApp(app, A, `SELECT * FROM invoice_outstanding($1::uuid, $2::uuid)`, [other.businessId, other.invoiceId])).rejects.toThrow(
        /invoice\.not_found/,
      );
      await expect(asApp(app, A, `SELECT invoice_settlement_state($1::uuid, $2::uuid) AS s`, [other.businessId, other.invoiceId])).rejects.toThrow(
        /invoice\.not_found/,
      );
      expect(await asApp(app, A, `SELECT * FROM customer_ar_outstanding($1::uuid, $2::uuid)`, [other.businessId, other.customerId])).toEqual([]);
      expect(
        await asApp(app, A, `SELECT * FROM customer_ar_aging($1::uuid, $2::uuid, DATE '2026-05-01', ARRAY[30, 60, 90])`, [other.businessId, other.customerId]),
      ).toEqual([]);
    }
  });

  it('FORCE ROW LEVEL SECURITY is on, so the owner of the table is not exempt either', async () => {
    const rows = await ownerPool().query<{ relname: string; f: boolean }>(
      `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname = ANY ($1::text[]) ORDER BY relname`,
      [[...PHASE4_RELATIONS]],
    );
    expect(rows.rows.map((r) => `${r.relname}:${String(r.f)}`)).toEqual([...PHASE4_RELATIONS].sort().map((r) => `${r}:true`));
  });
});

describe('HTTP: every enumerated Phase 4 route refuses another tenant’s business', () => {
  /**
   * An ITEM route names a resource in its path, so it has two distinct denials
   * worth proving: the resource of another business asked for under a valid
   * header (a controller that trusted the path parameter would answer), and
   * this business's own resource asked for under another business's header (a
   * read bound to the header alone would answer).
   */
  for (const route of PHASE4_ROUTES.filter(isItemRoute)) {
    it(`${route}: answers for A, and refuses A2 and B`, async () => {
      const mine = bind(route, A);
      const ok = await t.request.get(mine.path).set(hdr(owner, A.businessId));
      expect(ok.status, `${route} does not answer for its own business: ${JSON.stringify(ok.body)}`).toBe(200);

      // DENY 1 — A's own ids under the OTHER business's header, by an actor
      // who legitimately holds authority in both. Only the business binding
      // refuses this; the token is valid everywhere it is used here.
      const foreignHeader = await t.request.get(mine.path).set(hdr(owner, A2.businessId));
      expect([403, 404], `${route} answered ${foreignHeader.status} for A's ids under A2's header`).toContain(foreignHeader.status);

      // DENY 2 — the harder half: the OTHER business's ids under the actor's
      // own valid header.
      for (const other of [A2, B]) {
        const theirs = bind(route, other);
        const res = await t.request.get(theirs.path).set(hdr(owner, A.businessId));
        expect([403, 404], `${route} answered ${res.status} for ${other.businessId}'s ids under A's header`).toContain(res.status);
      }

      // DENY 3 — another tenant's token against this tenant's business.
      const foreignToken = await t.request.get(mine.path).set(hdr(ownerB, A.businessId));
      expect([401, 403, 404], `${route} answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
    });
  }

  /**
   * A COLLECTION route has no id to swap, so "404 for another business" is not
   * the statement it can make: under A2's header the page SHOULD answer, with
   * A2's rows. The isolation claim is therefore about the CONTENTS — the page
   * holds every row of the business in the header and not one row of any
   * other — which is the stronger claim of the two anyway, because a leak
   * shows up as a row rather than as a status code.
   */
  for (const route of PHASE4_ROUTES.filter((r) => !isItemRoute(r))) {
    it(`${route}: each business's page holds its own rows and no other's`, async () => {
      const path = bind(route, A).path;
      const seen: string[] = [];
      for (const shop of [A, A2, B]) {
        const actor = shop === B ? ownerB : owner;
        const res = await t.request.get(path).set(hdr(actor, shop.businessId));
        expect(res.status, `${route} does not answer for ${shop.businessId}: ${JSON.stringify(res.body)}`).toBe(200);
        const ids = (res.body.items as { id: string }[]).map((x) => x.id);
        // Exactly the one row this business owns — the fixture gives each
        // business one customer and one invoice, so a leak doubles the page.
        const own = route.includes('invoices') ? shop.invoiceId : shop.customerId;
        expect(ids, `${route} returned ${JSON.stringify(ids)} for ${shop.businessId}`).toEqual([own]);
        seen.push(...ids);
      }
      // …and the three pages were three disjoint answers, not one shared one.
      expect(new Set(seen).size).toBe(3);
    });
  }

  it('another tenant’s token cannot page this tenant’s collection', async () => {
    for (const route of PHASE4_ROUTES.filter((r) => !isItemRoute(r))) {
      const res = await t.request.get(bind(route, A).path).set(hdr(ownerB, A.businessId));
      expect([401, 403, 404], `${route} answered ${res.status} for another tenant's token`).toContain(res.status);
    }
  });
});
