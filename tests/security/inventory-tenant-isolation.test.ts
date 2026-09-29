import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  associateWarehouseBranchPayload,
  configureProductPayload,
  dissociateWarehouseBranchPayload,
  mintInventoryAssertion,
  type InventoryOperationCode,
} from '../../packages/inventory/src';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import {
  appDbUrl,
  createTestApp,
  dbUrl,
  ensurePostgres,
  grantFeature,
  inventoryAssertionKey,
  ownerPool,
  raiseLimit,
  resetData,
  uniqueEmail,
  type TestApp,
} from '../helpers/test-app';

/**
 * P3-S1 — TENANT AND BUSINESS ISOLATION OF EVERY NEW INVENTORY SURFACE, IN
 * ALLOW/DENY PAIRS. Independent adversarial suite (Agent F).
 *
 * Three businesses: A and A2 belong to the SAME tenant (and, over HTTP, to the
 * same owner), B to another tenant. Every DENY below is the exact statement or
 * request of its ALLOW with one thing changed — the UUIDs now name a row of
 * A2 or B — so the pair proves the refusal is isolation and not a broken
 * command. A2 is the harder half: the actor legitimately holds authority
 * there, so only binding to the ONE asserted business stops it.
 *
 *   DATABASE (raw connections, genuine invctl/1 assertions minted for A):
 *     the three routines, SELECT / UPDATE as `daftar_app`, and SELECT /
 *     INSERT / DELETE as `daftar_inventory_internal` (reached by the
 *     superuser's SET LOCAL ROLE — no runtime grant is added);
 *   HTTP (the merchant API, minter call counter spied):
 *     configuration, association, dissociation, the warehouse list and the
 *     catalog product read.
 */

// ── database half ──────────────────────────────────────────────────────────

type Outcome = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; sqlstate: string; code: string; message: string };

function toOutcome(e: unknown): Outcome {
  const err = e as { code?: unknown; message?: unknown };
  const message = typeof err.message === 'string' ? err.message : String(e);
  return { ok: false, sqlstate: typeof err.code === 'string' ? err.code : '', code: /^([a-z_]+\.[a-z_]+):/.exec(message)?.[1] ?? '', message };
}

function refused(o: Outcome, sqlstate: string, code: string | null): void {
  if (o.ok) throw new Error(`expected ${sqlstate} ${code ?? ''}, but it succeeded: ${JSON.stringify(o.rows)}`);
  expect({ sqlstate: o.sqlstate, code: code === null ? null : o.code }, o.message).toEqual({ sqlstate, code });
}

function accepted(o: Outcome): { rows: Record<string, unknown>[]; rowCount: number } {
  if (!o.ok) throw new Error(`expected success, got ${o.sqlstate} ${o.message}`);
  return o;
}

interface Scope {
  tenant: string;
  business: string;
  assertion?: string;
}

/**
 * One transaction on a fresh connection. `asInternal` connects as the
 * superuser and drops to daftar_inventory_internal for the statement, so the
 * policies judged are the internal role's. Committed only when `commit`.
 */
async function once(scope: Scope, sql: string, params: unknown[], opts: { commit?: boolean; asInternal?: boolean } = {}): Promise<Outcome> {
  const c = new Client({ connectionString: opts.asInternal ? dbUrl : appDbUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.inventory_assertion', $3, true)`, [
      scope.tenant,
      scope.business,
      scope.assertion ?? '',
    ]);
    if (opts.asInternal) await c.query('SET LOCAL ROLE daftar_inventory_internal');
    let out: Outcome;
    try {
      const r = await c.query<Record<string, unknown>>(sql, params);
      out = { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 };
    } catch (e) {
      out = toOutcome(e);
    }
    await c.query(out.ok && opts.commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } finally {
    await c.end();
  }
}

interface Biz {
  tenant: string;
  business: string;
  branches: string[];
  warehouses: string[];
  product: string;
}

async function id(pool: Pool, sql: string, params: unknown[] = []): Promise<string> {
  const v = (await pool.query<{ id: string }>(sql, params)).rows[0]?.id;
  if (v === undefined) throw new Error(`fixture returned no id: ${sql}`);
  return v;
}

async function seedBiz(pool: Pool, tenant: string, label: string): Promise<Biz> {
  const business = await id(
    pool,
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone) VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenant, `Isolation ${label}`, `iso-${label}-${randomUUID().slice(0, 8)}`],
  );
  const branches: string[] = [];
  for (const [i, name] of ['Main', 'North', 'South'].entries()) {
    branches.push(await id(pool, `INSERT INTO branches (business_id, name, is_default) VALUES ($1, $2, $3) RETURNING id`, [business, name, i === 0]));
  }
  const warehouses: string[] = [];
  for (const [i, home] of [branches[0], branches[1]].entries()) {
    warehouses.push(
      await id(pool, `INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, $3, $4) RETURNING id`, [
        business,
        home,
        `WH ${i}`,
        i === 0,
      ]),
    );
  }
  const c = await pool.connect();
  const product = randomUUID();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO products (business_id, id, base_price_minor, price_currency) VALUES ($1, $2, 500, 'ILS')`, [business, product]);
    await c.query(`INSERT INTO product_translations (business_id, product_id, locale, name) VALUES ($1, $2, 'en', 'Isolation product')`, [business, product]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return { tenant, business, branches, warehouses, product };
}

const KEY = inventoryAssertionKey();

function mint(actor: string, b: Biz, opCode: InventoryOperationCode, payloadSha256: string): string {
  return mintInventoryAssertion({ actorUserId: actor, tenantId: b.tenant, businessId: b.business, opCode, payloadSha256 }, KEY, new Date(), 60);
}

const CONFIGURE_SQL = `SELECT * FROM inventory_configure_product($1::uuid, $2::boolean, $3::text, $4::smallint)`;
const ASSOCIATE_SQL = `SELECT structure_associate_warehouse_branch($1::uuid, $2::uuid) AS changed`;
const DISSOCIATE_SQL = `SELECT structure_dissociate_warehouse_branch($1::uuid, $2::uuid) AS changed`;

/** A genuine assertion minted for `asserted`, naming `product` (possibly another business's), run in `asserted`'s scope. */
async function configure(actor: string, asserted: Biz, product: string, commit = true): Promise<Outcome> {
  const payload = configureProductPayload({
    tenantId: asserted.tenant,
    businessId: asserted.business,
    productId: product,
    trackInventory: true,
    unitCode: 'piece',
    unitDecimals: null,
  });
  const assertion = mint(actor, asserted, 'inventory.configure_product', payload.sha256);
  return once({ tenant: asserted.tenant, business: asserted.business, assertion }, CONFIGURE_SQL, [product, true, 'piece', null], { commit });
}

async function pair(op: 'associate' | 'dissociate', actor: string, asserted: Biz, warehouse: string, branch: string): Promise<Outcome> {
  const input = { tenantId: asserted.tenant, businessId: asserted.business, warehouseId: warehouse, branchId: branch };
  const payload = op === 'associate' ? associateWarehouseBranchPayload(input) : dissociateWarehouseBranchPayload(input);
  const assertion = mint(
    actor,
    asserted,
    op === 'associate' ? 'structure.associate_warehouse_branch' : 'structure.dissociate_warehouse_branch',
    payload.sha256,
  );
  return once({ tenant: asserted.tenant, business: asserted.business, assertion }, op === 'associate' ? ASSOCIATE_SQL : DISSOCIATE_SQL, [warehouse, branch], {
    commit: true,
  });
}

describe('database: every new routine and table, tenant A against A2 (same tenant) and B (another tenant)', () => {
  let owner: string;
  let A: Biz;
  let A2: Biz;
  let B: Biz;
  const scope = (b: Biz): Scope => ({ tenant: b.tenant, business: b.business });

  /** Everything of A2 and B an isolation failure could change, read by the superuser. */
  async function foreign(): Promise<string> {
    const r = await ownerPool().query<{ s: string }>(
      `SELECT jsonb_build_object(
         'products', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM products p WHERE p.business_id = ANY ($1::uuid[])),
         'variants', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM product_variants v WHERE v.business_id = ANY ($1::uuid[])),
         'pairs', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.business_id, b.warehouse_id, b.branch_id) FROM branch_warehouses b WHERE b.business_id = ANY ($1::uuid[])),
         'audit', (SELECT count(*) FROM audit_events a WHERE a.business_id = ANY ($1::uuid[])),
         'uses', (SELECT count(*) FROM inventory_assertion_uses))::text AS s`,
      [[A2.business, B.business]],
    );
    return r.rows[0]?.s ?? '';
  }

  /** A DENY must refuse with the code AND leave A2 and B byte-identical, with no assertion use recorded. */
  async function deniedUntouched(run: () => Promise<Outcome>, sqlstate: string, code: string | null): Promise<void> {
    const before = await foreign();
    refused(await run(), sqlstate, code);
    expect(await foreign()).toBe(before);
  }

  beforeAll(async () => {
    await ensurePostgres();
    const pool = ownerPool();
    owner = await id(pool, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Isolation owner') RETURNING id`, [uniqueEmail()]);
    const tA = await id(pool, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    const tB = await id(pool, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    A = await seedBiz(pool, tA, 'a');
    A2 = await seedBiz(pool, tA, 'a2');
    B = await seedBiz(pool, tB, 'b');
    // A2 and B each already hold a non-home association and a configured
    // product with a base variant, written by their OWN genuine authority —
    // the rows a leak would expose or damage.
    for (const b of [A2, B]) {
      accepted(await pair('associate', owner, b, b.warehouses[0] ?? '', b.branches[2] ?? ''));
      accepted(await configure(owner, b, b.product));
    }
  });

  describe('inventory_configure_product', () => {
    it('DENY: an assertion genuinely minted for A, naming B’s product → inventory.product_not_found, B untouched', async () => {
      await deniedUntouched(() => configure(owner, A, B.product), 'P0001', 'inventory.product_not_found');
    });

    it('DENY: the same for A2’s product, in the same tenant → inventory.product_not_found, A2 untouched', async () => {
      await deniedUntouched(() => configure(owner, A, A2.product), 'P0001', 'inventory.product_not_found');
    });

    it('ALLOW: the identical call naming A’s own product configures it and creates its base variant', async () => {
      const rows = accepted(await configure(owner, A, A.product)).rows;
      expect(rows[0]).toMatchObject({ product_id: A.product, track_inventory: true, unit_code: 'piece', changed: true });
    });
  });

  describe('structure_associate_warehouse_branch', () => {
    it.each([
      ['B’s warehouse + B’s branch', 'structure.warehouse_not_found', (): [string, string] => [B.warehouses[0] ?? '', B.branches[1] ?? '']],
      ['A’s warehouse + B’s branch', 'structure.branch_not_found', (): [string, string] => [A.warehouses[0] ?? '', B.branches[1] ?? '']],
      ['B’s warehouse + A’s branch', 'structure.warehouse_not_found', (): [string, string] => [B.warehouses[0] ?? '', A.branches[2] ?? '']],
      ['A2’s warehouse + A2’s branch (same tenant)', 'structure.warehouse_not_found', (): [string, string] => [A2.warehouses[0] ?? '', A2.branches[1] ?? '']],
      ['A’s warehouse + A2’s branch (same tenant)', 'structure.branch_not_found', (): [string, string] => [A.warehouses[0] ?? '', A2.branches[1] ?? '']],
    ])('DENY: an A assertion over %s → %s, nothing written', async (_n, code, ids) => {
      const [w, b] = ids();
      await deniedUntouched(() => pair('associate', owner, A, w, b), 'P0001', code);
    });

    it('ALLOW: the identical call over A’s own warehouse and branch associates them', async () => {
      expect(accepted(await pair('associate', owner, A, A.warehouses[0] ?? '', A.branches[2] ?? '')).rows).toEqual([{ changed: true }]);
    });
  });

  describe('structure_dissociate_warehouse_branch', () => {
    it.each([
      ['B’s existing non-home pair', (): [string, string] => [B.warehouses[0] ?? '', B.branches[2] ?? '']],
      ['A2’s existing non-home pair (same tenant)', (): [string, string] => [A2.warehouses[0] ?? '', A2.branches[2] ?? '']],
    ])('DENY: an A assertion removing %s → structure.warehouse_not_found, the pair survives', async (_n, ids) => {
      const [w, b] = ids();
      await deniedUntouched(() => pair('dissociate', owner, A, w, b), 'P0001', 'structure.warehouse_not_found');
      expect((await ownerPool().query(`SELECT 1 FROM branch_warehouses WHERE warehouse_id = $1 AND branch_id = $2`, [w, b])).rowCount).toBe(1);
    });

    it('ALLOW: the identical call over A’s own non-home pair removes it', async () => {
      accepted(await pair('associate', owner, A, A.warehouses[1] ?? '', A.branches[2] ?? ''));
      expect(accepted(await pair('dissociate', owner, A, A.warehouses[1] ?? '', A.branches[2] ?? '')).rows).toEqual([{ changed: true }]);
    });
  });

  describe('SELECT as daftar_app under A’s scope', () => {
    it('branch_warehouses: ALLOW A’s rows are visible; DENY not one row of A2 or B, filtered or not', async () => {
      const own = accepted(await once(scope(A), `SELECT count(*)::int AS n FROM branch_warehouses WHERE business_id = $1`, [A.business])).rows[0]?.['n'];
      expect(own).toBeGreaterThanOrEqual(3);
      for (const other of [A2, B]) {
        expect(accepted(await once(scope(A), `SELECT count(*)::int AS n FROM branch_warehouses WHERE business_id = $1`, [other.business])).rows[0]?.['n']).toBe(
          0,
        );
        expect(
          accepted(await once(scope(A), `SELECT count(*)::int AS n FROM branch_warehouses WHERE warehouse_id = $1`, [other.warehouses[0]])).rows[0]?.['n'],
        ).toBe(0);
      }
      const all = accepted(await once(scope(A), `SELECT DISTINCT business_id::text AS b FROM branch_warehouses`, [])).rows;
      expect(all).toEqual([{ b: A.business }]);
    });

    it('products’ inventory columns: ALLOW A’s product reads back its configuration; DENY A2’s and B’s configured products do not exist', async () => {
      const q = `SELECT track_inventory, unit_code, unit_decimals FROM products WHERE id = $1`;
      expect(accepted(await once(scope(A), q, [A.product])).rows).toEqual([{ track_inventory: true, unit_code: 'piece', unit_decimals: 0 }]);
      for (const other of [A2, B]) expect(accepted(await once(scope(A), q, [other.product])).rows).toEqual([]);
    });

    it('base variants: ALLOW A’s is visible to A; DENY A2’s and B’s are not', async () => {
      const q = `SELECT count(*)::int AS n FROM product_variants WHERE product_id = $1 AND is_base`;
      expect(accepted(await once(scope(A), q, [A.product])).rows[0]?.['n']).toBe(1);
      for (const other of [A2, B]) expect(accepted(await once(scope(A), q, [other.product])).rows[0]?.['n']).toBe(0);
    });
  });

  describe('UPDATE as daftar_app under A’s scope', () => {
    it('an ordinary product column: ALLOW updates A’s row; DENY reaches 0 rows of A2 and B', async () => {
      const q = `UPDATE products SET base_price_minor = base_price_minor + 1 WHERE id = $1`;
      expect(accepted(await once(scope(A), q, [A.product])).rowCount).toBe(1);
      for (const other of [A2, B]) expect(accepted(await once(scope(A), q, [other.product])).rowCount).toBe(0);
    });

    it('an inventory column: A’s row is REACHED and the column guard refuses it; A2’s and B’s rows are never reached at all', async () => {
      const q = `UPDATE products SET unit_decimals = 2 WHERE id = $1`;
      refused(await once(scope(A), q, [A.product]), 'P0001', 'inventory.configuration_authority_required');
      for (const other of [A2, B]) expect(accepted(await once(scope(A), q, [other.product])).rowCount).toBe(0);
    });

    it('a base variant: A’s is REACHED and refused as not mutable; A2’s and B’s are never reached', async () => {
      const q = `UPDATE product_variants SET sku = 'LEAK' WHERE product_id = $1 AND is_base`;
      refused(await once(scope(A), q, [A.product]), 'P0001', 'catalog.base_variant_not_mutable');
      for (const other of [A2, B]) expect(accepted(await once(scope(A), q, [other.product])).rowCount).toBe(0);
    });
  });

  describe('the internal principal, bound to A’s scope (its read policy is USING (true) — the restrictive one must still bound it)', () => {
    const internal = (sql: string, params: unknown[]): Promise<Outcome> => once(scope(A), sql, params, { asInternal: true });

    it('SELECT: ALLOW A’s associations; DENY none of A2’s or B’s', async () => {
      expect(accepted(await internal(`SELECT count(*)::int AS n FROM branch_warehouses WHERE business_id = $1`, [A.business])).rows[0]?.['n']).toBeGreaterThan(
        0,
      );
      for (const other of [A2, B]) {
        expect(accepted(await internal(`SELECT count(*)::int AS n FROM branch_warehouses WHERE business_id = $1`, [other.business])).rows[0]?.['n']).toBe(0);
      }
    });

    it('INSERT: ALLOW an A pair; DENY an A2 pair and a B pair → 42501 row level security', async () => {
      const q = `INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3)`;
      expect(accepted(await internal(q, [A.business, A.branches[2], A.warehouses[1]])).rowCount).toBe(1);
      for (const other of [A2, B]) {
        const before = await foreign();
        refused(await internal(q, [other.business, other.branches[2], other.warehouses[1]]), '42501', null);
        expect(await foreign()).toBe(before);
      }
    });

    it('DELETE: ALLOW A’s non-home pair; DENY A2’s and B’s non-home pairs → 0 rows', async () => {
      const q = `DELETE FROM branch_warehouses WHERE warehouse_id = $1 AND branch_id = $2`;
      expect(accepted(await internal(q, [A.warehouses[0], A.branches[2]])).rowCount).toBe(1);
      for (const other of [A2, B]) expect(accepted(await internal(q, [other.warehouses[0], other.branches[2]])).rowCount).toBe(0);
    });
  });
});

// ── HTTP half ──────────────────────────────────────────────────────────────

interface Actor {
  token: string;
  userId: string;
  email: string;
}
interface Shop {
  businessId: string;
  tenantId: string;
  branch1: string;
  branch2: string;
  w1: string;
  product: string;
}

describe('HTTP: one owner of A and A2 (same tenant), another tenant B', () => {
  let t: TestApp;
  let mintSpy: MockInstance<InventoryAssertionMinterService['mint']>;
  let owner: Actor;
  let ownerB: Actor;
  let A: Shop;
  let A2: Shop;
  let B: Shop;

  const hdr = (a: Actor, businessId: string): Record<string, string> => ({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': businessId });

  async function register(name: string): Promise<Actor> {
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: name, preferredLocale: 'en' });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, userId: me.body.userId as string, email: me.body.email as string };
  }

  async function furnish(o: Actor, businessId: string): Promise<Shop> {
    await grantFeature(businessId, o.userId, 'MULTI_BRANCH');
    await raiseLimit(businessId, o.userId, 'MAX_BRANCHES', 10);
    const row = (
      await ownerPool().query<{ tenant_id: string; branch_id: string; id: string }>(
        `SELECT b.tenant_id, w.branch_id, w.id FROM businesses b JOIN warehouses w ON w.business_id = b.id WHERE b.id = $1`,
        [businessId],
      )
    ).rows[0];
    const br = await t.request.post('/v1/businesses/current/branches').set(hdr(o, businessId)).send({ name: 'Second' });
    expect(br.status).toBe(201);
    const pr = await t.request
      .post('/v1/catalog/products')
      .set(hdr(o, businessId))
      .send({ translations: { en: 'Isolated' }, basePriceMinor: '900' });
    expect(pr.status).toBe(201);
    return {
      businessId,
      tenantId: row?.tenant_id ?? '',
      branch1: row?.branch_id ?? '',
      w1: row?.id ?? '',
      branch2: br.body.id as string,
      product: pr.body.id as string,
    };
  }

  const onboarding = { countryCode: 'PS', baseCurrency: 'ILS', preferredLocale: 'en' } as const;

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    t = await createTestApp();
    mintSpy = vi.spyOn(t.app.get(InventoryAssertionMinterService), 'mint');
    owner = await register('Owner of A and A2');
    ownerB = await register('Owner of B');
    const a = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `iso-${randomUUID()}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ ...onboarding, businessName: 'Iso A', storeSlug: `iso-a-${randomUUID().slice(0, 8)}` });
    expect(a.status).toBe(201);
    const a2 = await t.request
      .post(`/v1/tenants/${a.body.tenantId as string}/businesses`)
      .set('Idempotency-Key', `iso-${randomUUID()}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ ...onboarding, businessName: 'Iso A2', storeSlug: `iso-a2-${randomUUID().slice(0, 8)}` });
    expect(a2.status).toBe(201);
    const b = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `iso-${randomUUID()}`)
      .set('Authorization', `Bearer ${ownerB.token}`)
      .send({ ...onboarding, businessName: 'Iso B', storeSlug: `iso-b-${randomUUID().slice(0, 8)}` });
    expect(b.status).toBe(201);
    A = await furnish(owner, a.body.businessId as string);
    A2 = await furnish(owner, a2.body.businessId as string);
    B = await furnish(ownerB, b.body.businessId as string);
    expect(A2.tenantId).toBe(A.tenantId);
    // A2 and B already hold a non-home association, written by their owners.
    for (const [o, s] of [
      [owner, A2],
      [ownerB, B],
    ] as const) {
      expect((await t.request.post(`/v1/businesses/current/warehouses/${s.w1}/branches`).set(hdr(o, s.businessId)).send({ branchId: s.branch2 })).status).toBe(
        200,
      );
    }
  }, 60_000);

  beforeEach(() => {
    mintSpy.mockClear();
  });

  afterAll(async () => {
    mintSpy?.mockRestore();
    await t?.close();
  });

  async function productRow(product: string): Promise<unknown> {
    return (await ownerPool().query(`SELECT track_inventory, unit_code, unit_decimals FROM products WHERE id = $1`, [product])).rows[0];
  }
  async function pairsOf(businessId: string): Promise<string[]> {
    return (
      await ownerPool().query<{ p: string }>(
        `SELECT warehouse_id::text || '>' || branch_id::text AS p FROM branch_warehouses WHERE business_id = $1 ORDER BY 1`,
        [businessId],
      )
    ).rows.map((r) => r.p);
  }
  const configure = (a: Actor, header: string, product: string) =>
    t.request.put(`/v1/inventory/products/${product}/configuration`).set(hdr(a, header)).send({ trackInventory: true, unitCode: 'piece' });
  const associate = (a: Actor, header: string, w: string, b: string) =>
    t.request.post(`/v1/businesses/current/warehouses/${w}/branches`).set(hdr(a, header)).send({ branchId: b });
  const dissociate = (a: Actor, header: string, w: string, b: string) =>
    t.request.delete(`/v1/businesses/current/warehouses/${w}/branches/${b}`).set(hdr(a, header));

  describe('PUT /v1/inventory/products/:productId/configuration', () => {
    it('DENY: the owner of BOTH A and A2, in A’s context, naming A2’s product → 404 inventory.product_not_found, nothing minted, A2 untouched', async () => {
      const before = await productRow(A2.product);
      const res = await configure(owner, A.businessId, A2.product);
      expect(res.status).toBe(404);
      expect(res.body.error.details.inventoryCode).toBe('inventory.product_not_found');
      expect(mintSpy).not.toHaveBeenCalled();
      expect(await productRow(A2.product)).toEqual(before);
    });

    it('DENY: the same owner, in A’s context, naming B’s product → 404, nothing minted, B untouched', async () => {
      const before = await productRow(B.product);
      expect((await configure(owner, A.businessId, B.product)).status).toBe(404);
      expect(mintSpy).not.toHaveBeenCalled();
      expect(await productRow(B.product)).toEqual(before);
    });

    it('DENY: the same owner claiming B’s context → 403, nothing minted', async () => {
      expect((await configure(owner, B.businessId, B.product)).status).toBe(403);
      expect(mintSpy).not.toHaveBeenCalled();
    });

    it('ALLOW: the identical request in A2’s OWN context configures A2’s product, minting one assertion bound to A2', async () => {
      const res = await configure(owner, A2.businessId, A2.product);
      expect(res.status).toBe(200);
      expect(mintSpy).toHaveBeenCalledTimes(1);
      expect(mintSpy.mock.calls[0]?.[0]).toMatchObject({ tenantId: A2.tenantId, businessId: A2.businessId });
      expect(await productRow(A2.product)).toEqual({ track_inventory: true, unit_code: 'piece', unit_decimals: 0 });
    });

    it('ALLOW: and in A’s context, A’s product', async () => {
      expect((await configure(owner, A.businessId, A.product)).status).toBe(200);
      expect(mintSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST and DELETE /v1/businesses/current/warehouses/:warehouseId/branches', () => {
    it.each([
      ['A2’s warehouse + A2’s branch', 'structure.warehouse_not_found', (): [string, string] => [A2.w1, A2.branch2]],
      ['A’s warehouse + A2’s branch', 'structure.branch_not_found', (): [string, string] => [A.w1, A2.branch2]],
      ['B’s warehouse + A’s branch', 'structure.warehouse_not_found', (): [string, string] => [B.w1, A.branch2]],
    ])('DENY associate: owner of A and A2, in A’s context, over %s → 404 %s, nothing minted', async (_n, code, ids) => {
      const [w, b] = ids();
      const before = [await pairsOf(A.businessId), await pairsOf(A2.businessId), await pairsOf(B.businessId)];
      const res = await associate(owner, A.businessId, w, b);
      expect(res.status).toBe(404);
      expect(res.body.error.details.inventoryCode).toBe(code);
      expect(mintSpy).not.toHaveBeenCalled();
      expect([await pairsOf(A.businessId), await pairsOf(A2.businessId), await pairsOf(B.businessId)]).toEqual(before);
    });

    it('ALLOW associate: the identical request over A’s own pair → 200, minted once, for A', async () => {
      const res = await associate(owner, A.businessId, A.w1, A.branch2);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ associated: true, changed: true });
      expect(mintSpy).toHaveBeenCalledTimes(1);
      expect(mintSpy.mock.calls[0]?.[0]).toMatchObject({ businessId: A.businessId });
    });

    it.each([
      ['A2’s existing non-home pair', (): [string, string, string] => [A2.w1, A2.branch2, A2.businessId]],
      ['B’s existing non-home pair', (): [string, string, string] => [B.w1, B.branch2, B.businessId]],
    ])('DENY dissociate: in A’s context, removing %s → 404, nothing minted, the pair survives', async (_n, ids) => {
      const [w, b, business] = ids();
      const res = await dissociate(owner, A.businessId, w, b);
      expect(res.status).toBe(404);
      expect(res.body.error.details.inventoryCode).toBe('structure.warehouse_not_found');
      expect(mintSpy).not.toHaveBeenCalled();
      expect(await pairsOf(business)).toContain(`${w}>${b}`);
    });

    it('ALLOW dissociate: the identical request for A2’s pair in A2’s OWN context removes it', async () => {
      const res = await dissociate(owner, A2.businessId, A2.w1, A2.branch2);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ associated: false, changed: true });
      expect(mintSpy).toHaveBeenCalledTimes(1);
      expect(await pairsOf(A2.businessId)).not.toContain(`${A2.w1}>${A2.branch2}`);
    });
  });

  describe('reads', () => {
    it('warehouse list: ALLOW each context lists its own warehouses; DENY never another business’s, even for the same owner', async () => {
      const ids = async (header: string): Promise<string[]> => {
        const res = await t.request.get('/v1/businesses/current/warehouses').set(hdr(owner, header));
        expect(res.status).toBe(200);
        return (res.body.items as { id: string }[]).map((x) => x.id);
      };
      const inA = await ids(A.businessId);
      const inA2 = await ids(A2.businessId);
      expect(inA).toContain(A.w1);
      expect(inA).not.toContain(A2.w1);
      expect(inA).not.toContain(B.w1);
      expect(inA2).toContain(A2.w1);
      expect(inA2).not.toContain(A.w1);
    });

    it('catalog product with a hidden base variant: ALLOW A2’s context reads it; DENY A’s context → 404', async () => {
      expect((await t.request.get(`/v1/catalog/products/${A2.product}`).set(hdr(owner, A2.businessId))).status).toBe(200);
      expect((await t.request.get(`/v1/catalog/products/${A2.product}`).set(hdr(owner, A.businessId))).status).toBe(404);
      expect((await t.request.get(`/v1/catalog/products/${B.product}`).set(hdr(owner, A.businessId))).status).toBe(404);
    });
  });
});
