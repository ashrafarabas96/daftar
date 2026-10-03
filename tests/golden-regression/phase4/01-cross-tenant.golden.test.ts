import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverPhase4Routes } from '../../../scripts/phase4-s1-gate';
import { requireSubject, saleSubject, type SaleSubject } from '../phase4-s2/harness';
import { SALE_COMMIT_ROUTINE, confirmSale } from '../phase4-s2/sale-path';
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
 * The Phase 4 route surface, enumerated. The equality below against
 * `discoverPhase4Routes` is what makes a route mounted and not added here
 * impossible to miss — and it has now fired once, for real: P4-S2's
 * `SalesController` mounted `POST /v1/sales` and `GET /v1/sales/:saleId`, and
 * `crossTenantProblems` turned the SEALED `gate:phase4:s1` red because neither
 * appeared in any enumerated cross-tenant golden. That is the mechanism of
 * G-02 working exactly as designed, so the two routes are added HERE rather
 * than in a new file: this suite is listed by `S1_SUITES`, while a new
 * `.test.ts` under `tests/golden-regression/phase4/` would itself redden the
 * sealed gate through the `GOLDEN_DIR` clause of `suiteProblems`
 * (`scripts/phase4-s1-gate.ts:755-758`).
 *
 * `POST /v1/sales` is the FIRST WRITING route on the Phase 4 surface, and a
 * write route cannot be proved by the two loops below: a POST driven as a GET
 * would be a 404 that looked like isolation. It and its read are treated in
 * their own section, with their own ALLOW/DENY pairs.
 */
const PHASE4_ROUTES: readonly string[] = [
  'DELETE /v1/pos/till-sessions/:sessionId/cart-lines/:cartLineId',
  'GET /v1/customers',
  'GET /v1/customers/:customerId',
  'GET /v1/customers/:customerId/open-invoices',
  'GET /v1/customers/:customerId/receivable',
  'GET /v1/customers/:customerId/receivable/aging',
  'GET /v1/invoices',
  'GET /v1/invoices/:invoiceId',
  'GET /v1/invoices/:invoiceId/settlement',
  'GET /v1/pos/products',
  'GET /v1/pos/till-sessions/:sessionId',
  'GET /v1/pos/till-sessions/:sessionId/cart-lines',
  'GET /v1/pos/till-sessions/current',
  'GET /v1/sales/:saleId',
  'PATCH /v1/pos/till-sessions/:sessionId/cart-lines/:cartLineId',
  'POST /v1/pos/till-sessions',
  'POST /v1/pos/till-sessions/:sessionId/cart-lines',
  'POST /v1/pos/till-sessions/:sessionId/cart-lines/:cartLineId/discount',
  'POST /v1/pos/till-sessions/:sessionId/close',
  'POST /v1/sales',
];

/**
 * THE TEN POS ROUTES OF P4-S3, and why they are a section of their own.
 *
 * A new route surface with no cross-tenant golden is an untested boundary, and
 * a cross-tenant or cross-business leak is a BLOCKER in this project. So every
 * one of the ten appears in `PHASE4_ROUTES` above — the equality against
 * `discoverPhase4Routes` would not tolerate otherwise — and all ten get real
 * ALLOW/DENY pairs below.
 *
 * It was NINE until the cart READ landed.
 * `GET /v1/pos/till-sessions/:sessionId/cart-lines` is the tenth: the slice
 * shipped a server-side basket whose only readers were its own four write
 * commands, so a reloaded till screen lost the basket while its rows sat in
 * `pos_cart_lines`. The count moved because the surface did, and its
 * ALLOW/DENY pair is below with the rest — a new read route with no
 * cross-business probe is exactly the untested boundary this file exists to
 * refuse.
 *
 * They cannot be driven by the two generic loops, for the reason `SALE_ROUTES`
 * already records and more so:
 *
 *   - six of them are WRITES. A `POST` driven as a `GET` is a 404 that looks
 *     exactly like isolation, which is a DENY with no ALLOW beside it;
 *   - the four reads are scoped by a TILL SESSION, not by a customer or an
 *     invoice, so `bind()` has no id to put in their paths and
 *     `GET /v1/pos/products` needs a `sessionId` in its QUERY STRING before it
 *     is a well-formed request at all;
 *   - `GET /v1/pos/till-sessions/current` names no resource and answers
 *     `null` rather than a row, so neither the item loop nor the collection
 *     loop states anything true about it. Its isolation claim is about the
 *     CONTENTS: under each business's header it answers that business's own
 *     till and never another's.
 *
 * The section builds its own fixture, lazily, so this suite's existing
 * 300-second `beforeAll` and the eight P4-S1 read routes keep their verdicts.
 */
const POS_ROUTES: readonly string[] = PHASE4_ROUTES.filter((r) => r.includes(' /v1/pos'));

/**
 * The routes whose SERVER-SIDE SUBJECT arrives with `0077` — `sales`,
 * `sale_items`, the `sale` source types and `sale_commit`. Until it does,
 * "the sale routes refuse another tenant" has no subject: no sale can be
 * committed, so no ALLOW can be formed, and a DENY with no ALLOW beside it
 * proves only that the route refuses everything.
 *
 * They are therefore excluded from the two generic loops and asserted in their
 * own section, which REFUSES with the missing names through `requireSubject`
 * while the subject is absent. Not skipped, not `todo`, not conditional: a
 * conditional pass is a `.skip` the gate's SKIP regex cannot see, and this
 * file's own doctrine is that an unpaired refusal proves nothing.
 */
const SALE_ROUTES: readonly string[] = ['POST /v1/sales', 'GET /v1/sales/:saleId'];

/** A route the two generic loops below can drive: a GET whose subject is a customer or an invoice. */
const isGenericReadRoute = (route: string): boolean => route.startsWith('GET ') && !SALE_ROUTES.includes(route) && !POS_ROUTES.includes(route);

/** The two relations 0079 creates. Both must refuse a foreign business at SQL, and neither may be written by `daftar_app`. */
const POS_RELATIONS: readonly string[] = ['pos_cart_lines', 'pos_till_sessions'];

/** The four SECURITY DEFINER routines the six POS WRITES call. A route cannot write by issuing SQL; it mints and calls one of these; the four reads call none. */
const POS_ROUTINES: readonly string[] = ['pos_cart_remove_line', 'pos_cart_set_line', 'pos_till_session_close', 'pos_till_session_open'];

/** The five relations 0075 creates, every one of which must refuse a foreign business at SQL. */
const PHASE4_RELATIONS: readonly string[] = ['customers', 'customer_contacts', 'invoices', 'invoice_items', 'invoice_sequences'];

interface Shop {
  readonly tenantId: string;
  readonly businessId: string;
  readonly branchId: string;
  /** The business's own default warehouse — the sale's stock scope, and never the client's to choose. */
  readonly warehouseId: string;
  readonly productId: string;
  readonly userId: string;
  readonly customerId: string;
  readonly invoiceId: string;
  /** The sale this business committed, once `0077` makes one possible. */
  saleId?: string;
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
  const path = template
    .replace(':customerId', shop.customerId)
    .replace(':invoiceId', shop.invoiceId)
    .replace(':saleId', shop.saleId ?? '00000000-0000-0000-0000-000000000000');
  return { method, path: `${path}${QUERY[route] ?? ''}` };
}

/**
 * The Phase 4 fixture of one business: a customer with a contact, a document
 * series, and one OPEN invoice with one line — so every one of the eight reads
 * has something to return, and a leak is a visible row rather than an empty
 * page that looks like a refusal.
 *
 * The invoice needs a PARENT SALE. `0077` closed seam S-P4-01 with
 * `invoices_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales
 * (business_id, id)` (`0077:353`), so the fresh `randomUUID()` this fixture
 * used to pass as `sale_id` no longer inserts, and the whole `beforeAll` went
 * with it. The parent is written as a DRAFT, which is the only sale shape a
 * fixture may write by hand: `sale_header_guard()` admits a draft carrying no
 * binding, `sales_cogs_owed()` returns early for one, and no `sale_items` row
 * is written, so the deferred `stock_source_complete_sale` has no subject.
 * A CONFIRMED sale is the commit primitive's to write and nobody else's —
 * hand-seeding one here would plant exactly the half-built commercial fact
 * that the atomic sale law exists to forbid.
 */
async function seedPhase4(pool: Pool, shop: Omit<Shop, 'customerId' | 'invoiceId'>): Promise<{ customerId: string; invoiceId: string }> {
  const customerId = randomUUID();
  const invoiceId = randomUUID();
  /** The invoice's parent sale. Local, never published as `shop.saleId`: that one is a COMMITTED sale, and `sellable()` makes it. */
  const parentSaleId = randomUUID();
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
      `INSERT INTO sales (tenant_id, business_id, id, customer_id, branch_id, warehouse_id, status, settlement_mode,
                          document_date, currency_code, subtotal_txn_minor, discount_txn_minor, tax_minor,
                          total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                          customer_name_snapshot, commit_intent_sha256, business_transaction_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', 'credit', DATE '2026-03-14', 'ILS', 1000, 0, 0, 1000, 1000,
               1, 'base', TIMESTAMPTZ '2026-03-14T09:15:00Z', 'Customer snapshot', $7, $8, $9)`,
      [shop.tenantId, shop.businessId, parentSaleId, customerId, shop.branchId, shop.warehouseId, digest, randomUUID(), shop.userId],
    );
    await client.query(
      `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq,
                             period, issue_date, due_date, currency_code, status, subtotal_txn_minor, discount_txn_minor, tax_minor,
                             total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                             customer_name_snapshot, issue_intent_sha256, business_transaction_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'invoice', $7, 1, $8, DATE '2026-03-14', DATE '2026-04-14', 'ILS', 'draft',
               1000, 0, 0, 1000, 1000, 1, 'base', TIMESTAMPTZ '2026-03-14T09:15:00Z', 'Customer snapshot', $9, $10, $11)`,
      [shop.tenantId, shop.businessId, invoiceId, parentSaleId, customerId, shop.branchId, `INV-${period}-00001`, period, digest, randomUUID(), shop.userId],
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
      await ownerPool().query<{ tenant_id: string; branch_id: string; warehouse_id: string }>(
        `SELECT b.tenant_id, (SELECT br.id FROM branches br WHERE br.business_id = b.id ORDER BY br.is_default DESC, br.id LIMIT 1) AS branch_id,
                (SELECT w.id FROM warehouses w WHERE w.business_id = b.id ORDER BY w.id LIMIT 1) AS warehouse_id
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
      warehouseId: row?.warehouse_id ?? '',
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
    // The count was a LITERAL 8, which is a second copy of the line above and
    // a closure rule on the surface: it had to be edited by hand for every
    // authorized route a later slice mounts, and editing it is the moment
    // somebody edits the list instead of adding the route's pair. What the
    // literal was really guarding is NON-VACUITY — a discovery that returned
    // nothing would satisfy `toEqual` against an empty list — so that is what
    // is asserted, and the exact surface stays the business of the equality.
    // `[[daftar-a-closure-rule-is-not-an-invariant]]`.
    expect(PHASE4_ROUTES.length, 'NO SUBJECT — the route surface is empty, so the equality above compared nothing with nothing').toBeGreaterThan(0);
    // Every declared sale route is really on the surface, and every route this
    // file excludes from the generic loops is really a sale route: the two
    // partitions below must cover the surface exactly once.
    for (const route of SALE_ROUTES) expect(PHASE4_ROUTES, `${route} is declared a sale route but is not on the surface`).toContain(route);
    // Every POS route this file excludes from the generic loops is really a
    // POS route, and the three partitions cover the surface exactly once: a
    // route driven by neither loop nor section would be a route with no
    // cross-tenant pair at all, which is the hole G-02 exists to close.
    for (const route of POS_ROUTES) expect(PHASE4_ROUTES, `${route} is declared a POS route but is not on the surface`).toContain(route);
    // Ten: six writes and four reads. It was nine until the cart read landed
    // (`GET …/cart-lines`), and the number is asserted rather than bounded so
    // a route added without a cross-business probe below is red here.
    expect(POS_ROUTES.length, 'the POS surface is empty, so its whole section below would prove nothing').toBe(10);
    expect(
      PHASE4_ROUTES.filter((r) => !isGenericReadRoute(r)).sort(),
      'a route is driven by the generic loops, by the sale section or by the POS section — never by none of them',
    ).toEqual([...SALE_ROUTES, ...POS_ROUTES].sort());
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
  for (const route of PHASE4_ROUTES.filter((r) => isGenericReadRoute(r) && isItemRoute(r))) {
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
  for (const route of PHASE4_ROUTES.filter((r) => isGenericReadRoute(r) && !isItemRoute(r))) {
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
    for (const route of PHASE4_ROUTES.filter((r) => isGenericReadRoute(r) && !isItemRoute(r))) {
      const res = await t.request.get(bind(route, A).path).set(hdr(ownerB, A.businessId));
      expect([401, 403, 404], `${route} answered ${res.status} for another tenant's token`).toContain(res.status);
    }
  });
});

/**
 * THE SALE ROUTES — the first WRITING route on the Phase 4 surface, and its
 * read (P4-AL-16, P4-AL-18, P4-AL-30, P4-AL-40, P4-AL-43 scenario 8).
 *
 * The two loops above cannot state this claim. A collection loop would have
 * issued `POST /v1/sales` as a GET and read the 404 as isolation; an item loop
 * would have asked for a sale id no business holds and read the 404 as
 * isolation too. Both are the failure this file's header warns about: a DENY
 * whose ALLOW was never formed proves only that the route refuses everything.
 *
 * So each route gets a real pair, and the pair needs a real committed sale —
 * which needs `0077`. Until `0077` lands, `requireSubject` REFUSES with the
 * missing names. Nothing here is skipped and nothing is conditional.
 *
 * The fixture is built ONCE, lazily, inside this section: while the subject is
 * absent it never runs, so the existing 300-second `beforeAll` of this suite is
 * untouched and the eight read routes above keep their current verdict.
 */
describe('HTTP: the sale command and the sale read refuse another tenant’s business', () => {
  const CLAIM = 'the sale routes refuse another tenant’s business at the API';
  let subject: SaleSubject;
  let documentDate = '';
  /** Built at most once; the error of a failed build is re-thrown to every case rather than swallowed. */
  let fixture: Promise<void> | null = null;

  /**
   * Make this shop's product sellable and give it stock, through the product's
   * OWN commands, then commit one sale. The stock is 10 so no case below can
   * be refused for the stock rather than for the isolation — a 409 that meant
   * `insufficient_stock` would be a DENY that proved nothing.
   */
  async function sellable(shop: Shop, actor: Actor): Promise<void> {
    const configured = await t.request
      .put(`/v1/inventory/products/${shop.productId}/configuration`)
      .set(hdr(actor, shop.businessId))
      .send({ trackInventory: true, unitCode: 'piece' });
    expect(configured.status, `the product of ${shop.businessId} could not be configured: ${JSON.stringify(configured.body)}`).toBe(200);
    const stocked = await t.request
      .post('/v1/inventory/adjustments')
      .set(hdr(actor, shop.businessId))
      .send({
        adjustmentId: randomUUID(),
        warehouseId: shop.warehouseId,
        occurredOn: documentDate,
        reason: 'the cross-tenant sale fixture',
        lines: [{ productId: shop.productId, quantity: '10', unitCost: '5' }],
      });
    expect(stocked.status, `the stock of ${shop.businessId} could not be seeded: ${JSON.stringify(stocked.body)}`).toBe(201);
    const saleId = randomUUID();
    const res = await confirmSale(t, hdr(actor, shop.businessId), {
      saleId,
      customerId: shop.customerId,
      warehouseId: shop.warehouseId,
      occurredOn: documentDate,
      lines: [{ productId: shop.productId, quantity: '1' }],
    });
    expect(res.status, `the ALLOW sale of ${shop.businessId} was refused: ${JSON.stringify(res.body)}`).toBe(200);
    shop.saleId = saleId;
  }

  /** The number of `sales` rows a business holds, read as the owner so no policy can hide a leak. */
  async function saleCount(shop: Shop): Promise<number> {
    return Number(
      (await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM sales WHERE business_id = $1`, [shop.businessId])).rows[0]?.n ?? '-1',
    );
  }

  /** Build the fixture at most once, and hand the same failure to every case that needs it. */
  async function ready(): Promise<void> {
    subject = await saleSubject(ownerPool());
    requireSubject(subject.missing, CLAIM);
    if (fixture === null)
      fixture = (async (): Promise<void> => {
        documentDate = String((await ownerPool().query<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]?.d ?? '');
        await sellable(A, owner);
        await sellable(A2, owner);
        await sellable(B, ownerB);
      })();
    await fixture;
  }

  it('the subject exists: the sale relations, the two source types, the sale.* kinds and the commit routine are in the tree', async () => {
    subject = await saleSubject(ownerPool());
    requireSubject(subject.missing, CLAIM);
    expect(subject.routine, 'the commit routine the route calls').toBe(SALE_COMMIT_ROUTINE);
  });

  it('POST /v1/sales: commits for A, and refuses every cross-business form of the same request', async () => {
    await ready();

    // DENY 1 — A's own customer and warehouse under A2's HEADER, by an actor
    // who legitimately holds `sales.create` in both businesses. Only the
    // business binding refuses this; the token is valid everywhere it is used.
    const beforeA2 = await saleCount(A2);
    const foreignHeader = await confirmSale(t, hdr(owner, A2.businessId), {
      saleId: randomUUID(),
      customerId: A.customerId,
      warehouseId: A.warehouseId,
      occurredOn: documentDate,
      lines: [{ productId: A.productId, quantity: '1' }],
    });
    expect([403, 404, 409, 422], `POST /v1/sales answered ${foreignHeader.status} for A's ids under A2's header`).toContain(foreignHeader.status);
    expect(await saleCount(A2), 'the refused command wrote a sale into A2 anyway').toBe(beforeA2);

    // DENY 2 — the harder half: the OTHER business's customer, warehouse and
    // product under the actor's own valid header. A controller that trusted
    // the body would have written A2's stock into A's sale.
    for (const other of [A2, B]) {
      const beforeOther = await saleCount(other);
      const beforeMine = await saleCount(A);
      const res = await confirmSale(t, hdr(owner, A.businessId), {
        saleId: randomUUID(),
        customerId: other.customerId,
        warehouseId: other.warehouseId,
        occurredOn: documentDate,
        lines: [{ productId: other.productId, quantity: '1' }],
      });
      expect([403, 404, 409, 422], `POST /v1/sales answered ${res.status} for ${other.businessId}'s ids under A's header`).toContain(res.status);
      expect(await saleCount(other), `the refused command wrote a sale into ${other.businessId}`).toBe(beforeOther);
      expect(await saleCount(A), 'the refused command wrote a sale into A out of another business’s rows').toBe(beforeMine);
    }

    // DENY 3 — another tenant's token against this tenant's business.
    const beforeToken = await saleCount(A);
    const foreignToken = await confirmSale(t, hdr(ownerB, A.businessId), {
      saleId: randomUUID(),
      customerId: A.customerId,
      warehouseId: A.warehouseId,
      occurredOn: documentDate,
      lines: [{ productId: A.productId, quantity: '1' }],
    });
    expect([401, 403, 404], `POST /v1/sales answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
    expect(await saleCount(A), 'another tenant’s token wrote a sale into A').toBe(beforeToken);
  });

  it('GET /v1/sales/:saleId: answers for A, and refuses A2 and B', async () => {
    await ready();
    const route = 'GET /v1/sales/:saleId';

    // ALLOW — the pair's other half: A's own sale answers, so each refusal
    // below is the isolation and not a route that reads nothing.
    const ok = await t.request.get(bind(route, A).path).set(hdr(owner, A.businessId));
    expect(ok.status, `${route} does not answer for its own business: ${JSON.stringify(ok.body)}`).toBe(200);
    // `saleId`, not `id`: the sale DTO names the document by the field the
    // contract names it by (`sale-reads.ts:302` maps `row.id` to `saleId`),
    // and `ok.body.id` was `undefined` — an assertion comparing `undefined`
    // with the id would have been satisfied by any read that returned nothing
    // under a different field name.
    expect(ok.body.saleId, `${route} answered with some other sale`).toBe(A.saleId);

    // DENY 1 — A's own id under A2's header.
    const foreignHeader = await t.request.get(bind(route, A).path).set(hdr(owner, A2.businessId));
    expect([403, 404], `${route} answered ${foreignHeader.status} for A's id under A2's header`).toContain(foreignHeader.status);

    // DENY 2 — the other business's id under the actor's own header.
    for (const other of [A2, B]) {
      const res = await t.request.get(bind(route, other).path).set(hdr(owner, A.businessId));
      expect([403, 404], `${route} answered ${res.status} for ${other.businessId}'s id under A's header`).toContain(res.status);
    }

    // DENY 3 — another tenant's token against this tenant's business.
    const foreignToken = await t.request.get(bind(route, A).path).set(hdr(ownerB, A.businessId));
    expect([401, 403, 404], `${route} answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
  });

  it('SQL: the sale relations refuse another business under daftar_app’s row security', async () => {
    await ready();
    const relations = ['sales', 'sale_items', 'stock_source_bridge_sale'];
    // The three relations are NOT all reachable by the runtime principal, and
    // the probe must not pretend otherwise. `0077:484-485` grants
    // `stock_source_bridge_sale` to `daftar_inventory_internal` only, so a
    // `SELECT` as `daftar_app` is `permission denied for table …` — which this
    // loop used to take as a suite error rather than as the answer.
    //
    // So the surface is PARTITIONED by what the catalogue actually grants,
    // discovered with `has_table_privilege` and never listed: a relation
    // `daftar_app` can read is proved by its ROW SECURITY, and one it cannot
    // read is proved by the PRIVILEGE BEING ABSENT — which is the stronger of
    // the two, because an ungranted relation needs no policy to be
    // unreachable. Writing the bridge into the RLS loop would have been a
    // claim the grant makes unprovable; leaving it out silently would have
    // been an exemption nobody stated.
    const granted = new Set(
      (
        await ownerPool().query<{ relation: string }>(
          `SELECT c.relname::text AS relation FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND has_table_privilege('daftar_app', c.oid, 'SELECT')`,
          [relations],
        )
      ).rows.map((r) => r.relation),
    );
    const readable = relations.filter((r) => granted.has(r));
    const unreachable = relations.filter((r) => !granted.has(r));
    expect(
      readable.length,
      'NO SUBJECT — daftar_app may read none of the sale relations, so the row-security claim below has nothing to prove',
    ).toBeGreaterThan(0);
    expect([...readable, ...unreachable].sort(), 'the partition covers the three sale relations exactly once').toEqual([...relations].sort());

    for (const relation of readable) {
      // ALLOW: the unqualified read under A's scope returns only A's rows —
      // the statement names no business at all.
      const mine = await asApp<{ business_id: string }>(app, A, `SELECT DISTINCT business_id FROM ${relation}`);
      expect(
        mine.map((r) => r.business_id),
        `${relation} under A's scope`,
      ).toEqual([A.businessId]);
      // DENY: the same statement asking for the other business by id.
      for (const other of [A2, B]) {
        const rows = await asApp<{ business_id: string }>(app, A, `SELECT business_id FROM ${relation} WHERE business_id = $1`, [other.businessId]);
        expect(rows, `${relation} leaked ${other.businessId} to ${A.businessId}`).toEqual([]);
      }
    }

    // And the other half of the partition, asserted rather than skipped: the
    // statement is refused by the GRANT, before any policy is consulted.
    for (const relation of unreachable) {
      const outcome = await asApp<{ n: string }>(app, A, `SELECT count(*)::text AS n FROM ${relation}`).then(
        () => 'allowed',
        (e: unknown) => String((e as { message?: unknown }).message ?? e),
      );
      expect(outcome, `${relation} is readable by daftar_app, so it owes the row-security proof above and must join the loop`).toMatch(
        /permission denied for table/,
      );
    }
  });
});

/**
 * THE POS SURFACE — ten routes, six of them WRITES (P4-S3; `OD-P4-01`
 * OPTION A, `OD-P4-09` OPTION A; lock `P4-AL-18`, `P4-AL-38`, `P4-AL-40`,
 * `P4-AL-43` scenario 8, `P4-AL-86`).
 *
 * A new route surface with no cross-tenant golden is an untested boundary, and
 * a cross-tenant or cross-business leak is a BLOCKER in this project. These
 * ten routes cannot be driven by the two generic loops above, for the reasons
 * `POS_ROUTES` records: six are writes, and all four reads are scoped by a
 * TILL SESSION rather than by a customer or an invoice.
 *
 * EVERY ALLOW HERE IS REAL, AND THAT IS THE POINT. The till is opened through
 * `POST /v1/pos/till-sessions` and the basket through `POST .../cart-lines` —
 * no `pos_till_sessions` or `pos_cart_lines` row is ever inserted by hand. It
 * could not be: `daftar_app` holds `SELECT` only on both relations
 * (`0079:605`) and every write goes through a `SECURITY DEFINER` routine
 * consuming an `invctl/1` assertion of its own registered kind. So a DENY below
 * is always the isolation refusing a request whose ALLOW form demonstrably
 * works, never a route that refuses everything.
 *
 * Three DENY forms per route, the same three the sale section uses:
 *
 *   1. this business's own ids under ANOTHER business's header, by an actor who
 *      legitimately holds `sales.create` and `sales.view` in both. Only the
 *      business binding refuses it; the token is valid everywhere it is used. A
 *      session of another business is INVISIBLE under RLS, so the honest answer
 *      is `pos.session_not_found` — a 403 would confirm a row exists in a
 *      business the caller has no membership in;
 *   2. the OTHER business's ids under the actor's own valid header — the harder
 *      half, which a controller that trusted its path parameters would have
 *      answered;
 *   3. another tenant's token against this tenant's business.
 *
 * And after every refused WRITE the other business's row count is read back as
 * the SCHEMA OWNER, who bypasses row security, so a write that happened and was
 * merely hidden from the caller is still visible to the assertion.
 *
 * The fixture is built ONCE, lazily, inside this section: this suite's existing
 * 300-second `beforeAll` is untouched and the eight P4-S1 read routes keep
 * their current verdicts.
 */
describe('HTTP: the POS till, its type-ahead and its cart refuse another tenant’s business', () => {
  /** One shop's POS state, every piece of it created through the shop's own routes. */
  interface Till {
    readonly sessionId: string;
    readonly branchId: string;
    readonly warehouseId: string;
    /** The one cart line the fixture appended, through `POST .../cart-lines`. */
    lineId: string;
  }

  const tills = new Map<string, Till>();
  /** Built at most once; the error of a failed build is re-thrown to every case rather than swallowed. */
  let fixture: Promise<void> | null = null;

  const till = (shop: Shop): Till => {
    const found = tills.get(shop.businessId);
    if (found === undefined) throw new Error(`no till was opened for ${shop.businessId}`);
    return found;
  };

  const cartBase = (shop: Shop): string => `/v1/pos/till-sessions/${till(shop).sessionId}/cart-lines`;

  /** Rows of a POS relation a business holds, read as the OWNER so no policy can hide a leak. */
  async function posCount(relation: string, shop: Shop): Promise<number> {
    return Number(
      (await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM ${relation} WHERE business_id = $1`, [shop.businessId])).rows[0]?.n ?? '-1',
    );
  }

  /** Open sessions a business holds, read as the OWNER — the figure a refused close must not change. */
  async function openCount(shop: Shop): Promise<number> {
    return Number(
      (
        await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM pos_till_sessions WHERE business_id = $1 AND status = 'open'`, [
          shop.businessId,
        ])
      ).rows[0]?.n ?? '-1',
    );
  }

  /**
   * Open this shop's till and append one line to its basket, through the routes
   * and nothing else.
   *
   * The branch and warehouse come from the shop's own onboarding, so the
   * authorization's branch-scope check is satisfied by a real membership rather
   * than by a fixture arranging to be believed. `terminalCode` is held to the
   * `invpl/1` `code` grammar by the schema AND by the column's own named CHECK,
   * and `pos_till_sessions_one_open_per_terminal_uq` closes the other half, so
   * each shop gets its own.
   */
  async function openTill(shop: Shop, actor: Actor, code: string): Promise<void> {
    const sessionId = randomUUID();
    const opened = await t.request
      .post('/v1/pos/till-sessions')
      .set(hdr(actor, shop.businessId))
      .send({ sessionId, branchId: shop.branchId, warehouseId: shop.warehouseId, terminalCode: code, openingFloatMinor: '0' });
    expect(opened.status, `the till of ${shop.businessId} was refused: ${JSON.stringify(opened.body)}`).toBe(200);
    expect(opened.body.id).toBe(sessionId);
    expect(opened.body.opened_by, 'the owner of a session is the verified assertion’s actor, never a request field').toBe(actor.userId);

    const entry: Till = { sessionId, branchId: shop.branchId, warehouseId: shop.warehouseId, lineId: '' };
    tills.set(shop.businessId, entry);

    const added = await t.request
      .post(`/v1/pos/till-sessions/${sessionId}/cart-lines`)
      .set(hdr(actor, shop.businessId))
      .send({ productId: shop.productId, variantId: null, quantity: '1' });
    expect(added.status, `the basket of ${shop.businessId} was refused: ${JSON.stringify(added.body)}`).toBe(201);
    const line = (added.body.lines as { cartLineId: string }[])[0];
    expect(line, 'the append answered with no line, so every cart case below would have no subject').toBeDefined();
    entry.lineId = (line as { cartLineId: string }).cartLineId;
  }

  /** Build the fixture at most once, and hand the same failure to every case that needs it. */
  async function ready(): Promise<void> {
    if (fixture === null)
      fixture = (async (): Promise<void> => {
        await openTill(A, owner, 'gold_pos_a');
        await openTill(A2, owner, 'gold_pos_a2');
        await openTill(B, ownerB, 'gold_pos_b');
      })();
    await fixture;
  }

  it('the subject exists: both POS relations and all four POS routines are in the tree', async () => {
    const relations = (
      await ownerPool().query<{ relname: string }>(
        `SELECT c.relname::text AS relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
        [[...POS_RELATIONS]],
      )
    ).rows.map((r) => r.relname);
    const routines = (
      await ownerPool().query<{ proname: string }>(
        `SELECT DISTINCT p.proname::text AS proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY 1`,
        [[...POS_ROUTINES]],
      )
    ).rows.map((r) => r.proname);
    // Named rather than skipped. A missing subject is a FAILURE with the
    // missing names in it: a conditional pass is a `.skip` no SKIP regex can
    // see, and an unpaired refusal proves nothing.
    expect(relations, 'the POS relations the nine routes write and read').toEqual([...POS_RELATIONS].sort());
    expect(routines, 'the SECURITY DEFINER routines the routes call — a route cannot write by issuing SQL').toEqual([...POS_ROUTINES].sort());
  });

  it('POST /v1/pos/till-sessions: opens for A, and refuses every cross-business form of the same request', async () => {
    await ready();

    // DENY 1 — A's own branch and warehouse under A2's HEADER. The actor holds
    // `sales.create` in both businesses, so only the business binding and the
    // branch-scope authorization refuse this.
    const beforeA2 = await posCount('pos_till_sessions', A2);
    const foreignHeader = await t.request
      .post('/v1/pos/till-sessions')
      .set(hdr(owner, A2.businessId))
      .send({ sessionId: randomUUID(), branchId: A.branchId, warehouseId: A.warehouseId, terminalCode: 'gold_deny_1', openingFloatMinor: '0' });
    expect([403, 404, 409, 422], `the open answered ${foreignHeader.status} for A's branch under A2's header`).toContain(foreignHeader.status);
    expect(await posCount('pos_till_sessions', A2), 'the refused open wrote a session into A2 anyway').toBe(beforeA2);

    // DENY 2 — the harder half: the OTHER business's branch and warehouse under
    // the actor's own valid header. A route that trusted the body would have
    // opened a till on another business's drawer.
    for (const other of [A2, B]) {
      const beforeOther = await posCount('pos_till_sessions', other);
      const beforeMine = await posCount('pos_till_sessions', A);
      const res = await t.request
        .post('/v1/pos/till-sessions')
        .set(hdr(owner, A.businessId))
        .send({ sessionId: randomUUID(), branchId: other.branchId, warehouseId: other.warehouseId, terminalCode: 'gold_deny_2', openingFloatMinor: '0' });
      expect([403, 404, 409, 422], `the open answered ${res.status} for ${other.businessId}'s branch under A's header`).toContain(res.status);
      expect(await posCount('pos_till_sessions', other), `the refused open wrote a session into ${other.businessId}`).toBe(beforeOther);
      expect(await posCount('pos_till_sessions', A), 'the refused open wrote a session into A out of another business’s rows').toBe(beforeMine);
    }

    // DENY 3 — another tenant's token against this tenant's business.
    const beforeToken = await posCount('pos_till_sessions', A);
    const foreignToken = await t.request
      .post('/v1/pos/till-sessions')
      .set(hdr(ownerB, A.businessId))
      .send({ sessionId: randomUUID(), branchId: A.branchId, warehouseId: A.warehouseId, terminalCode: 'gold_deny_3', openingFloatMinor: '0' });
    expect([401, 403, 404], `the open answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
    expect(await posCount('pos_till_sessions', A), 'another tenant’s token opened a till in A').toBe(beforeToken);
  });

  it('GET /v1/pos/till-sessions/:sessionId: answers for A, and refuses A2 and B', async () => {
    await ready();
    const path = (shop: Shop): string => `/v1/pos/till-sessions/${till(shop).sessionId}`;

    const ok = await t.request.get(path(A)).set(hdr(owner, A.businessId));
    expect(ok.status, `the session read does not answer for its own business: ${JSON.stringify(ok.body)}`).toBe(200);
    expect(ok.body.id).toBe(till(A).sessionId);

    const foreignHeader = await t.request.get(path(A)).set(hdr(owner, A2.businessId));
    expect([403, 404], `the session read answered ${foreignHeader.status} for A's id under A2's header`).toContain(foreignHeader.status);

    for (const other of [A2, B]) {
      const res = await t.request.get(path(other)).set(hdr(owner, A.businessId));
      expect([403, 404], `the session read answered ${res.status} for ${other.businessId}'s id under A's header`).toContain(res.status);
    }

    const foreignToken = await t.request.get(path(A)).set(hdr(ownerB, A.businessId));
    expect([401, 403, 404], `the session read answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
  });

  /**
   * `GET /v1/pos/till-sessions/current` names no resource, so "404 for another
   * business" is not the statement it can make — under A2's header it SHOULD
   * answer, with A2's own till. The isolation claim is therefore about the
   * CONTENTS, which is the stronger claim anyway: a leak shows up as another
   * business's session id rather than as a status code.
   */
  it('GET /v1/pos/till-sessions/current: each business’s header answers that business’s own till and no other’s', async () => {
    await ready();
    const seen: string[] = [];
    for (const shop of [A, A2, B]) {
      const actor = shop === B ? ownerB : owner;
      const res = await t.request.get('/v1/pos/till-sessions/current').set(hdr(actor, shop.businessId));
      expect(res.status, `current does not answer for ${shop.businessId}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body?.id, `current returned ${JSON.stringify(res.body?.id)} for ${shop.businessId}`).toBe(till(shop).sessionId);
      seen.push(res.body.id as string);
    }
    expect(new Set(seen).size, 'the three answers were three disjoint tills, not one shared one').toBe(3);

    const foreignToken = await t.request.get('/v1/pos/till-sessions/current').set(hdr(ownerB, A.businessId));
    expect([401, 403, 404], `current answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
  });

  /**
   * `GET /v1/pos/products` is scoped by the SESSION, and the warehouse is the
   * server's derivation from it (RULING 2). So the cross-business probe is a
   * session id — which is exactly the identifier a client could otherwise have
   * used to read another business's shelves.
   */
  it('GET /v1/pos/products: answers for A’s own till, and refuses every other business’s session', async () => {
    await ready();
    const path = (shop: Shop): string => `/v1/pos/products?sessionId=${till(shop).sessionId}&q=golden`;

    const ok = await t.request.get(path(A)).set(hdr(owner, A.businessId));
    expect(ok.status, `the type-ahead does not answer for its own business: ${JSON.stringify(ok.body)}`).toBe(200);
    expect(ok.body.warehouseId, 'the warehouse is derived from the session, never named by the client').toBe(till(A).warehouseId);

    const foreignHeader = await t.request.get(path(A)).set(hdr(owner, A2.businessId));
    expect([403, 404], `the type-ahead answered ${foreignHeader.status} for A's session under A2's header`).toContain(foreignHeader.status);

    for (const other of [A2, B]) {
      const res = await t.request.get(path(other)).set(hdr(owner, A.businessId));
      expect([403, 404], `the type-ahead answered ${res.status} for ${other.businessId}'s session under A's header`).toContain(res.status);
      // …and it never answered an empty PAGE, which would read as "nothing in
      // stock" rather than as a refusal.
      expect(res.body.items, `the type-ahead handed out a page for ${other.businessId}'s session`).toBeUndefined();
    }

    const foreignToken = await t.request.get(path(A)).set(hdr(ownerB, A.businessId));
    expect([401, 403, 404], `the type-ahead answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
  });

  /**
   * `GET /v1/pos/till-sessions/:sessionId/cart-lines` — the cart READ, whose
   * subject is the basket the fixture appended through the route.
   *
   * The DENY that matters here is not the status code: it is that no refusal
   * answers an EMPTY CART. A cross-business session answered `200 { lines: [] }`
   * would be a leak dressed as a zero — the cashier would read it as "the
   * basket is empty" and the suite would read it as "no row escaped" — so each
   * refusal is asserted to carry no `lines` at all.
   */
  it('GET /v1/pos/till-sessions/:sessionId/cart-lines: answers A’s own basket, and refuses A2 and B without an empty cart', async () => {
    await ready();
    const path = (shop: Shop): string => `/v1/pos/till-sessions/${till(shop).sessionId}/cart-lines`;

    const ok = await t.request.get(path(A)).set(hdr(owner, A.businessId));
    expect(ok.status, `the cart read does not answer for its own business: ${JSON.stringify(ok.body)}`).toBe(200);
    expect(ok.body.tillSessionId).toBe(till(A).sessionId);
    expect(
      (ok.body.lines as { cartLineId: string }[]).map((l) => l.cartLineId),
      'the cart read answered some other basket than the one the fixture appended to',
    ).toContain(till(A).lineId);

    const foreignHeader = await t.request.get(path(A)).set(hdr(owner, A2.businessId));
    expect([403, 404], `the cart read answered ${foreignHeader.status} for A's session under A2's header`).toContain(foreignHeader.status);
    expect(foreignHeader.body.lines, 'the cart read handed out A’s lines under A2’s header').toBeUndefined();

    for (const other of [A2, B]) {
      const res = await t.request.get(path(other)).set(hdr(owner, A.businessId));
      expect([403, 404], `the cart read answered ${res.status} for ${other.businessId}'s session under A's header`).toContain(res.status);
      expect(res.body.lines, `the cart read handed out a basket for ${other.businessId}'s session`).toBeUndefined();
    }

    const foreignToken = await t.request.get(path(A)).set(hdr(ownerB, A.businessId));
    expect([401, 403, 404], `the cart read answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
    expect(foreignToken.body.lines, 'another tenant’s token read A’s basket').toBeUndefined();
  });

  it('POST /v1/pos/till-sessions/:sessionId/cart-lines: appends for A, and refuses every cross-business form', async () => {
    await ready();
    const body = (shop: Shop): Record<string, unknown> => ({ productId: shop.productId, variantId: null, quantity: '1' });

    // ALLOW — a real append, so every refusal below is the isolation and not a
    // route that refuses everything. 201: the basket is append-only.
    const ok = await t.request.post(cartBase(A)).set(hdr(owner, A.businessId)).send(body(A));
    expect(ok.status, `the append does not work for its own business: ${JSON.stringify(ok.body)}`).toBe(201);

    // DENY 1 — A's own session and product under A2's header.
    const beforeA2 = await posCount('pos_cart_lines', A2);
    const foreignHeader = await t.request.post(cartBase(A)).set(hdr(owner, A2.businessId)).send(body(A));
    expect([403, 404, 409, 422], `the append answered ${foreignHeader.status} for A's session under A2's header`).toContain(foreignHeader.status);
    expect(await posCount('pos_cart_lines', A2), 'the refused append wrote a line into A2 anyway').toBe(beforeA2);

    // DENY 2 — the other business's session and product under A's own header.
    for (const other of [A2, B]) {
      const beforeOther = await posCount('pos_cart_lines', other);
      const beforeMine = await posCount('pos_cart_lines', A);
      const res = await t.request.post(cartBase(other)).set(hdr(owner, A.businessId)).send(body(other));
      expect([403, 404, 409, 422], `the append answered ${res.status} for ${other.businessId}'s session under A's header`).toContain(res.status);
      expect(await posCount('pos_cart_lines', other), `the refused append wrote a line into ${other.businessId}`).toBe(beforeOther);
      expect(await posCount('pos_cart_lines', A), 'the refused append wrote a line into A out of another business’s rows').toBe(beforeMine);
    }

    // DENY 3 — another tenant's token against this tenant's business.
    const beforeToken = await posCount('pos_cart_lines', A);
    const foreignToken = await t.request.post(cartBase(A)).set(hdr(ownerB, A.businessId)).send(body(A));
    expect([401, 403, 404], `the append answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
    expect(await posCount('pos_cart_lines', A), 'another tenant’s token appended a line to A’s basket').toBe(beforeToken);
  });

  /**
   * The three LINE routes together, driven over the same three DENY forms.
   *
   * They share one loop because they share one claim and one subject: each
   * addresses an EXISTING line by `(sessionId, cartLineId)`, and a route that
   * trusted either path parameter would reach into another business's basket.
   * Writing them out three times would have been three copies of one law, and
   * the ALLOW of each is performed individually so no refusal here is unpaired.
   *
   * The ALLOW comes LAST within each form, for the removal's sake: a tombstoned
   * line would make every later refusal `pos.cart_line_not_found`, which is the
   * removal's own answer rather than the isolation's.
   */
  it('PATCH, POST discount and DELETE on a cart line: each works for A and refuses A2 and B', async () => {
    await ready();

    /** One line route, as the request a supertest verb issues against a shop's own basket. */
    const forms: readonly { readonly name: string; readonly send: (shop: Shop, actor: Actor, headerOf: Shop) => Promise<{ status: number }> }[] = [
      {
        name: 'PATCH /v1/pos/till-sessions/:sessionId/cart-lines/:cartLineId',
        send: (shop, actor, headerOf) =>
          t.request
            .patch(`${cartBase(shop)}/${till(shop).lineId}`)
            .set(hdr(actor, headerOf.businessId))
            .send({ quantity: '2' }),
      },
      {
        name: 'POST /v1/pos/till-sessions/:sessionId/cart-lines/:cartLineId/discount',
        send: (shop, actor, headerOf) =>
          t.request
            .post(`${cartBase(shop)}/${till(shop).lineId}/discount`)
            .set(hdr(actor, headerOf.businessId))
            .send({ discountMinor: '1' }),
      },
      {
        name: 'DELETE /v1/pos/till-sessions/:sessionId/cart-lines/:cartLineId',
        send: (shop, actor, headerOf) =>
          t.request
            .delete(`${cartBase(shop)}/${till(shop).lineId}`)
            .set(hdr(actor, headerOf.businessId))
            .send({}),
      },
    ];

    for (const form of forms) {
      // DENY 1 — A's own session and line under A2's header.
      const beforeA2 = await posCount('pos_cart_lines', A2);
      const foreignHeader = await form.send(A, owner, A2);
      expect([403, 404, 409, 422], `${form.name} answered ${foreignHeader.status} for A's line under A2's header`).toContain(foreignHeader.status);
      expect(await posCount('pos_cart_lines', A2), `${form.name}: the refused call wrote into A2 anyway`).toBe(beforeA2);

      // DENY 2 — the other business's session and line under A's own header.
      for (const other of [A2, B]) {
        const res = await form.send(other, owner, A);
        expect([403, 404, 409, 422], `${form.name} answered ${res.status} for ${other.businessId}'s line under A's header`).toContain(res.status);
      }

      // DENY 3 — another tenant's token against this tenant's business.
      const foreignToken = await form.send(A, ownerB, A);
      expect([401, 403, 404], `${form.name} answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);

      // ALLOW — the pair's other half, on A's own basket under A's own header.
      // If this is not a success, every refusal above proved only that the
      // route refuses everything.
      const ok = await form.send(A, owner, A);
      expect(ok.status, `${form.name} does not work for its own business`).toBe(200);
    }
  });

  /**
   * The close, LAST — it ends A's shift, and a cart command on a closed session
   * is correctly `pos.session_not_open`, so running it earlier would have made
   * the cases above refuse for the lifecycle instead of for the isolation.
   */
  it('POST /v1/pos/till-sessions/:sessionId/close: closes A’s own till, and refuses A2’s and B’s', async () => {
    await ready();
    const path = (shop: Shop): string => `/v1/pos/till-sessions/${till(shop).sessionId}/close`;

    // DENY 1 — A's own session under A2's header.
    const beforeA2 = await openCount(A2);
    const foreignHeader = await t.request.post(path(A)).set(hdr(owner, A2.businessId)).send({ closingCountMinor: '0' });
    expect([403, 404, 409, 422], `the close answered ${foreignHeader.status} for A's session under A2's header`).toContain(foreignHeader.status);
    expect(await openCount(A2), 'the refused close counted a till in A2').toBe(beforeA2);

    // DENY 2 — the other business's session under A's own header. A route that
    // trusted the path parameter would have counted another business's drawer.
    for (const other of [A2, B]) {
      const beforeOther = await openCount(other);
      const res = await t.request.post(path(other)).set(hdr(owner, A.businessId)).send({ closingCountMinor: '0' });
      expect([403, 404, 409, 422], `the close answered ${res.status} for ${other.businessId}'s session under A's header`).toContain(res.status);
      expect(await openCount(other), `the refused close counted ${other.businessId}'s till`).toBe(beforeOther);
    }

    // DENY 3 — another tenant's token against this tenant's business.
    const beforeToken = await openCount(A);
    const foreignToken = await t.request.post(path(A)).set(hdr(ownerB, A.businessId)).send({ closingCountMinor: '0' });
    expect([401, 403, 404], `the close answered ${foreignToken.status} for another tenant's token`).toContain(foreignToken.status);
    expect(await openCount(A), 'another tenant’s token closed A’s till').toBe(beforeToken);

    // ALLOW — and the close really closes, so every refusal above was the
    // isolation and not a route that refuses every close.
    const ok = await t.request.post(path(A)).set(hdr(owner, A.businessId)).send({ closingCountMinor: '0' });
    expect(ok.status, `the close does not work for its own business: ${JSON.stringify(ok.body)}`).toBe(200);
    expect(ok.body.status).toBe('closed');
    expect(await openCount(A2), 'closing A’s till closed A2’s as well').toBe(beforeA2);
  });

  it('SQL: both POS relations refuse another business under daftar_app’s row security, and neither is writable by it', async () => {
    await ready();
    // `daftar_app` holds SELECT and nothing else on both relations
    // (`0079:605`), so the READ is the thing row security has to decide and the
    // absence of DML is what makes a routine the only writer.
    const granted = new Set(
      (
        await ownerPool().query<{ relation: string }>(
          `SELECT c.relname::text AS relation FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND has_table_privilege('daftar_app', c.oid, 'SELECT')`,
          [[...POS_RELATIONS]],
        )
      ).rows.map((r) => r.relation),
    );
    expect([...granted].sort(), 'daftar_app must be able to READ both POS relations — the reads above run as it').toEqual([...POS_RELATIONS].sort());

    for (const relation of POS_RELATIONS) {
      // ALLOW: the unqualified read under A's scope returns only A's rows. The
      // statement names no business at all, so the filtering is the restrictive
      // `business_isolation` policy and not a predicate.
      const mine = await asApp<{ business_id: string }>(app, A, `SELECT DISTINCT business_id FROM ${relation}`);
      expect(
        mine.map((r) => r.business_id),
        `${relation} under A's scope`,
      ).toEqual([A.businessId]);
      // DENY: the same statement, asking for the other business by id.
      for (const other of [A2, B]) {
        const rows = await asApp<{ business_id: string }>(app, A, `SELECT business_id FROM ${relation} WHERE business_id = $1`, [other.businessId]);
        expect(rows, `${relation} leaked ${other.businessId} to ${A.businessId}`).toEqual([]);
      }
    }

    // And no runtime principal may write either relation by issuing SQL: every
    // write is a SECURITY DEFINER routine consuming an `invctl/1` assertion, so
    // a route that tried to INSERT would be refused by the GRANT before any
    // policy was consulted. That is stronger than a policy, because an
    // ungranted privilege needs no policy to be unreachable.
    for (const relation of POS_RELATIONS) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
        const held = (await ownerPool().query<{ held: boolean }>(`SELECT has_table_privilege('daftar_app', $1, $2) AS held`, [relation, privilege])).rows[0];
        expect(held?.held, `daftar_app holds ${privilege} on ${relation} — a route could then write without an assertion`).toBe(false);
      }
    }
  });

  it('FORCE ROW LEVEL SECURITY is on for both POS relations, so the table owner is not exempt either', async () => {
    const rows = await ownerPool().query<{ relname: string; f: boolean }>(
      `SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname = ANY ($1::text[]) ORDER BY relname`,
      [[...POS_RELATIONS]],
    );
    expect(rows.rows.map((r) => `${r.relname}:${String(r.f)}`)).toEqual([...POS_RELATIONS].sort().map((r) => `${r}:true`));
  });
});
