import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { InventoryAuthorizationService } from '../../apps/api/src/modules/inventory/inventory-authorization';
import { newBusinessTransactionId } from '../../apps/api/src/modules/inventory/business-transaction';
import { TenancyService } from '../../apps/api/src/modules/tenancy/tenancy.service';
import {
  APP_DB_PASSWORD,
  PG_PASSWORD,
  PG_PORT,
  PG_USER,
  appDbUrl,
  applyBootstrap,
  createTestApp,
  dbUrl,
  ensurePostgres,
  grantFeature,
  ownerPool,
  raiseLimit,
  resetData,
  uniqueEmail,
  type TestApp,
} from '../helpers/test-app';

/**
 * P3-S1 — THE PERMANENT WAREHOUSE MATRIX OF P3-AL-15 §C, ROWS A–M.
 * Independent adversarial suite (Agent F).
 *
 * The rows were written from the lock, not from the implementation, and each
 * attacks its rule from a direction the implementer's own suites do not:
 *
 *   A  a pre-migration database with archived warehouses, archived branches
 *      and a branch holding two warehouses, upgraded by the real migrations;
 *   B  `createBranch()` over HTTP, with the maintainer made to fail AND with
 *      a failure injected after all three rows exist;
 *   C  `createWarehouse()` over HTTP, the same two injections;
 *   D  the maintainer REMOVED (not failing — silently gone) on a throwaway
 *      database, a real `daftar_app` write, and the negative control that
 *      removes the completeness trigger too and shows the orphan committing;
 *      plus the HTTP writer on the shared database with the maintainer
 *      disabled around one request;
 *   E  reach is granted and revoked through the association COMMANDS;
 *   F  an assigned-scope actor assigned to EVERY branch is still refused,
 *      even for a pair that already exists, with the minter never called;
 *   G  two concurrent identical association commands: one row, one audit;
 *   H  cross-business pairs refused by the database for three writers,
 *      including the internal principal's onboarding admission;
 *   I  the home row deleted by the internal principal itself, under scope;
 *   J  a non-home association of an ARCHIVED warehouse is still removable;
 *   K  the accepted list/create behaviour through HTTP;
 *   L  the maintainer made to fail inside BOTH frozen-routine writers
 *      (onboarding and the second-business command), then a retry;
 *   M  every DML verb as `daftar_app`, whatever the row.
 *
 * Failure injection follows the accepted idiom
 * (tests/integration/accounting-posting.test.ts): a superuser-created trigger
 * that raises, dropped in `finally`, never a production bypass. Row A and
 * row D's removal happen in a throwaway database built from the real
 * migrations, dropped at the end.
 */

// ── shared-database helpers ────────────────────────────────────────────────

/**
 * Install a raising BEFORE INSERT trigger on `table` for the length of `run`,
 * optionally only for rows matching `when`. SQLSTATE 58000 (system_error): an
 * infrastructure failure the API maps to no domain contract, so it surfaces
 * as a 5xx and cannot be mistaken for a refusal.
 */
async function injectFailure(table: string, run: () => Promise<void>, when = 'true'): Promise<void> {
  const name = `adv_fail_${table}`;
  await ownerPool().query(
    `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN RAISE EXCEPTION 'injected.${table}_unavailable' USING ERRCODE = '58000'; END $fn$`,
  );
  await ownerPool().query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
  try {
    await run();
  } finally {
    await ownerPool().query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await ownerPool().query(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await ownerPool().query<{ n: string }>(sql, params)).rows[0]?.n ?? '-1');
}

async function pairs(businessId: string): Promise<string[]> {
  return (
    await ownerPool().query<{ p: string }>(
      `SELECT warehouse_id::text || '>' || branch_id::text AS p FROM branch_warehouses WHERE business_id = $1 ORDER BY 1`,
      [businessId],
    )
  ).rows.map((r) => r.p);
}

/** The whole structural footprint of the database: what a rolled-back writer must leave unchanged. */
async function footprint(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ['tenants', 'businesses', 'branches', 'warehouses', 'branch_warehouses', 'business_roles', 'memberships', 'tenant_memberships']) {
    out[t] = await countRows(`SELECT count(*)::text AS n FROM ${t}`);
  }
  return out;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

interface Actor {
  token: string;
  userId: string;
  email: string;
}
interface Shop {
  owner: Actor;
  tenantId: string;
  businessId: string;
  branch1: string;
  w1: string;
}

const hdr = (a: Actor, businessId: string): Record<string, string> => ({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': businessId });

async function register(t: TestApp, displayName: string): Promise<Actor> {
  const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName, preferredLocale: 'en' });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
  return { token, userId: me.body.userId as string, email: me.body.email as string };
}

function onboardRequest(t: TestApp, owner: Actor, name: string, key: string) {
  return t.request
    .post('/v1/onboarding/complete')
    .set('Idempotency-Key', key)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ businessName: name, countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `wm-${randomUUID().slice(0, 12)}`, preferredLocale: 'en' });
}

async function shop(t: TestApp, name: string): Promise<Shop> {
  const owner = await register(t, 'Owner');
  const on = await onboardRequest(t, owner, name, `wm-${randomUUID()}`);
  expect(on.status).toBe(201);
  const businessId = on.body.businessId as string;
  const row = (
    await ownerPool().query<{ tenant_id: string; branch_id: string; id: string }>(
      `SELECT b.tenant_id, w.branch_id, w.id FROM businesses b JOIN warehouses w ON w.business_id = b.id WHERE b.id = $1`,
      [businessId],
    )
  ).rows;
  expect(row).toHaveLength(1);
  await grantFeature(businessId, owner.userId, 'MULTI_BRANCH');
  await grantFeature(businessId, owner.userId, 'CUSTOM_ROLES');
  await raiseLimit(businessId, owner.userId, 'MAX_BRANCHES', 20);
  await raiseLimit(businessId, owner.userId, 'MAX_USERS', 20);
  return { owner, tenantId: row[0]?.tenant_id ?? '', businessId, branch1: row[0]?.branch_id ?? '', w1: row[0]?.id ?? '' };
}

async function newBranch(t: TestApp, s: Shop, name: string): Promise<{ branch: string; warehouse: string }> {
  const res = await t.request.post('/v1/businesses/current/branches').set(hdr(s.owner, s.businessId)).send({ name });
  expect(res.status).toBe(201);
  const branch = res.body.id as string;
  const w = (await ownerPool().query<{ id: string }>(`SELECT id FROM warehouses WHERE business_id = $1 AND branch_id = $2`, [s.businessId, branch])).rows;
  return { branch, warehouse: w[0]?.id ?? '' };
}

/** A member holding warehouse.manage through a custom role, with the given branch scope. */
async function warehouseManager(t: TestApp, s: Shop, mode: 'all' | 'assigned', branchIds: string[]): Promise<Actor> {
  const key = `wm-${randomUUID().slice(0, 8)}`;
  const role = await t.request
    .post('/v1/businesses/current/roles')
    .set(hdr(s.owner, s.businessId))
    .send({ key, name: 'Warehouse manager', permissions: ['branch.view', 'warehouse.view', 'warehouse.manage'] });
  expect(role.status).toBe(201);
  const member = await register(t, 'Warehouse manager');
  expect((await t.request.post('/v1/businesses/current/members').set(hdr(s.owner, s.businessId)).send({ email: member.email, roleKey: key })).status).toBe(201);
  const scope = await t.request.patch(`/v1/businesses/current/members/${member.userId}/branch-scope`).set(hdr(s.owner, s.businessId)).send({ mode, branchIds });
  expect(scope.status).toBe(200);
  return member;
}

const associate = (t: TestApp, a: Actor, s: Shop, warehouse: string, branch: string) =>
  t.request.post(`/v1/businesses/current/warehouses/${warehouse}/branches`).set(hdr(a, s.businessId)).send({ branchId: branch });
const dissociate = (t: TestApp, a: Actor, s: Shop, warehouse: string, branch: string) =>
  t.request.delete(`/v1/businesses/current/warehouses/${warehouse}/branches/${branch}`).set(hdr(a, s.businessId));

// ── throwaway database ─────────────────────────────────────────────────────

const SCRATCH = 'daftar_p3s1_adv_whmatrix';
const scratchSuper = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${SCRATCH}`;
const scratchApp = `postgresql://daftar_app:${APP_DB_PASSWORD}@localhost:${PG_PORT}/${SCRATCH}`;

function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-adv-wm-'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql') && x <= upTo)) cpSync(join(MIGRATIONS_DIR, f), join(dir, f));
  return dir;
}

describe('rows A and D — on a throwaway database built from the real migrations', () => {
  const admin = new Pool({ connectionString: dbUrl, max: 1 });
  admin.on('error', () => undefined);
  let pool: Pool;
  const X = { tenant: randomUUID(), business: randomUUID(), b1: randomUUID(), b2: randomUUID(), b3: randomUUID() };
  const Y = { tenant: randomUUID(), business: randomUUID(), b1: randomUUID() };
  const warehouses: { business: string; id: string; branch: string; label: string }[] = [
    { business: X.business, id: randomUUID(), branch: X.b1, label: 'default of the default branch' },
    { business: X.business, id: randomUUID(), branch: X.b1, label: 'a second warehouse of the same branch' },
    { business: X.business, id: randomUUID(), branch: X.b2, label: 'an archived warehouse' },
    { business: X.business, id: randomUUID(), branch: X.b3, label: 'a warehouse of an archived branch' },
    { business: Y.business, id: randomUUID(), branch: Y.b1, label: 'another business' },
  ];

  beforeAll(async () => {
    await ensurePostgres();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    await applyBootstrap(SCRATCH);
    const pre = migrationsUpTo('0055_inventory_configure_product.sql');
    try {
      await runMigrations(scratchSuper, pre);
    } finally {
      rmSync(pre, { recursive: true, force: true });
    }
    pool = new Pool({ connectionString: scratchSuper, max: 2 });
    pool.on('error', () => undefined);

    // The pre-P3-S1 world: no branch_warehouses table exists yet.
    expect((await pool.query(`SELECT to_regclass('branch_warehouses') AS r`)).rows).toEqual([{ r: null }]);
    for (const [biz, label] of [
      [X, 'x'],
      [Y, 'y'],
    ] as const) {
      await pool.query(`INSERT INTO tenants (id) VALUES ($1)`, [biz.tenant]);
      await pool.query(
        `INSERT INTO businesses (id, tenant_id, name, store_slug, country_code, base_currency, timezone) VALUES ($1, $2, $3, $4, 'PS', 'ILS', 'Asia/Hebron')`,
        [biz.business, biz.tenant, `Matrix ${label}`, `wm-pre-${label}-${randomUUID().slice(0, 8)}`],
      );
    }
    await pool.query(
      `INSERT INTO branches (business_id, id, name, is_default) VALUES ($1, $2, 'Main', true), ($1, $3, 'Two', false), ($1, $4, 'Three', false)`,
      [X.business, X.b1, X.b2, X.b3],
    );
    await pool.query(`INSERT INTO branches (business_id, id, name, is_default) VALUES ($1, $2, 'Main', true)`, [Y.business, Y.b1]);
    for (const [i, w] of warehouses.entries()) {
      await pool.query(`INSERT INTO warehouses (business_id, id, branch_id, name, is_default) VALUES ($1, $2, $3, $4, $5)`, [
        w.business,
        w.id,
        w.branch,
        w.label,
        i === 0 || i === 4,
      ]);
    }
    await pool.query(`UPDATE warehouses SET status = 'archived' WHERE id = $1`, [warehouses[2]?.id]);
    await pool.query(`UPDATE branches SET status = 'archived' WHERE id = $1`, [X.b3]);

    // The upgrade: 0056 onward, exactly as a deployment applies it.
    const applied = await runMigrations(scratchSuper);
    expect(applied[0]).toBe('0056_inventory_branch_warehouses.sql');
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.end();
  });

  it('row A: every pre-migration warehouse — archived, of an archived branch, sharing a branch — has EXACTLY its home association and no other', async () => {
    const rows = (
      await pool.query<{ business_id: string; branch_id: string; warehouse_id: string }>(`SELECT business_id, branch_id, warehouse_id FROM branch_warehouses`)
    ).rows;
    const got = rows.map((r) => `${r.business_id}/${r.warehouse_id}>${r.branch_id}`).sort();
    const want = warehouses.map((w) => `${w.business}/${w.id}>${w.branch}`).sort();
    expect(got).toEqual(want);
  });

  it('row D: with the maintainer REMOVED, a real daftar_app warehouse insert cannot commit — the completeness proof refuses it at COMMIT', async () => {
    await pool.query(`DROP TRIGGER warehouses_home_branch_maintain ON warehouses`);
    const id = randomUUID();
    const c = new Client({ connectionString: scratchApp });
    await c.connect();
    let commitError = '';
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [X.tenant, X.business]);
      // The INSERT itself succeeds: the proof is deferred, which is what lets
      // every writer finish its transaction before the invariant is judged.
      await c.query(`INSERT INTO warehouses (business_id, id, branch_id, name) VALUES ($1, $2, $3, 'Orphan')`, [X.business, id, X.b2]);
      await c.query('COMMIT').catch((e: unknown) => {
        commitError = `${(e as { code?: string }).code} ${(e as Error).message}`;
      });
    } finally {
      await c.end();
    }
    expect(commitError).toMatch(/^P0001 inventory\.home_branch_association_required:/);
    expect((await pool.query(`SELECT 1 FROM warehouses WHERE id = $1`, [id])).rowCount).toBe(0);
  });

  it('row D negative control: remove the completeness trigger too, and the same write commits an orphan — so the test above measures object 2 of §A', async () => {
    await pool.query(`DROP TRIGGER warehouses_require_home_branch ON warehouses`);
    const id = randomUUID();
    const c = new Client({ connectionString: scratchApp });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [X.tenant, X.business]);
      await c.query(`INSERT INTO warehouses (business_id, id, branch_id, name) VALUES ($1, $2, $3, 'Orphan')`, [X.business, id, X.b2]);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    expect((await pool.query(`SELECT 1 FROM warehouses WHERE id = $1`, [id])).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM branch_warehouses WHERE warehouse_id = $1`, [id])).rowCount).toBe(0);
  });
});

describe('rows B–M on the shared database', () => {
  let t: TestApp;
  let mint: MockInstance<InventoryAssertionMinterService['mint']>;

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
  });
  // One application per test: registration is rate-limited per process.
  beforeEach(async () => {
    t = await createTestApp();
    mint = vi.spyOn(t.app.get(InventoryAssertionMinterService), 'mint');
  });
  afterEach(async () => {
    mint.mockRestore();
    await t.close();
  });

  describe('row B — createBranch() commits branch, default warehouse and home association atomically', () => {
    it('success: all three, and the home association is exactly (branch, its default warehouse)', async () => {
      const s = await shop(t, 'Row B shop');
      const { branch, warehouse } = await newBranch(t, s, 'Row B branch');
      expect(await pairs(s.businessId)).toEqual([`${s.w1}>${s.branch1}`, `${warehouse}>${branch}`].sort());
    });

    it('the maintainer made to fail: none of the three survives', async () => {
      const s = await shop(t, 'Row B maintainer');
      const before = await footprint();
      await injectFailure('branch_warehouses', async () => {
        const res = await t.request.post('/v1/businesses/current/branches').set(hdr(s.owner, s.businessId)).send({ name: 'Doomed branch' });
        expect(res.status).toBeGreaterThanOrEqual(500);
      });
      expect(await footprint()).toEqual(before);
      expect(await countRows(`SELECT count(*)::text AS n FROM branches WHERE business_id = $1 AND name = 'Doomed branch'`, [s.businessId])).toBe(0);
    });

    it('a failure AFTER all three rows exist (the audit write): none of the three survives', async () => {
      const s = await shop(t, 'Row B audit');
      const before = await footprint();
      await injectFailure(
        'audit_events',
        async () => {
          const res = await t.request.post('/v1/businesses/current/branches').set(hdr(s.owner, s.businessId)).send({ name: 'Late failure' });
          expect(res.status).toBeGreaterThanOrEqual(500);
        },
        `NEW.action = 'structure.branch_created'`,
      );
      expect(await footprint()).toEqual(before);
    });
  });

  describe('row C — createWarehouse() commits warehouse and home association atomically', () => {
    it('success: the new warehouse has exactly its home association', async () => {
      const s = await shop(t, 'Row C shop');
      const res = await t.request.post('/v1/businesses/current/warehouses').set(hdr(s.owner, s.businessId)).send({ name: 'Row C WH', branchId: s.branch1 });
      expect(res.status).toBe(201);
      expect(await pairs(s.businessId)).toEqual([`${s.w1}>${s.branch1}`, `${res.body.id as string}>${s.branch1}`].sort());
    });

    it.each([
      ['the maintainer made to fail', 'branch_warehouses', 'true'],
      ['a failure after both rows exist (the audit write)', 'audit_events', `NEW.action = 'structure.warehouse_created'`],
    ])('%s: neither row survives', async (_name, table, when) => {
      const s = await shop(t, `Row C ${table}`);
      const before = await footprint();
      await injectFailure(
        table,
        async () => {
          const res = await t.request
            .post('/v1/businesses/current/warehouses')
            .set(hdr(s.owner, s.businessId))
            .send({ name: 'Doomed WH', branchId: s.branch1 });
          expect(res.status).toBeGreaterThanOrEqual(500);
        },
        when,
      );
      expect(await footprint()).toEqual(before);
    });
  });

  it('row D (HTTP writer): with the maintainer disabled around one request, createWarehouse() fails at COMMIT and leaves no warehouse', async () => {
    const s = await shop(t, 'Row D shop');
    const before = await footprint();
    await ownerPool().query(`ALTER TABLE warehouses DISABLE TRIGGER warehouses_home_branch_maintain`);
    try {
      const res = await t.request.post('/v1/businesses/current/warehouses').set(hdr(s.owner, s.businessId)).send({ name: 'Orphan WH', branchId: s.branch1 });
      // The completeness proof raises its P0001 refusal at COMMIT; the
      // accepted error filter maps every P0001 to 403 FORBIDDEN.
      expect(res.status).toBe(403);
    } finally {
      await ownerPool().query(`ALTER TABLE warehouses ENABLE TRIGGER warehouses_home_branch_maintain`);
    }
    expect(await footprint()).toEqual(before);
    expect((await ownerPool().query(`SELECT tgenabled::text AS e FROM pg_trigger WHERE tgname = 'warehouses_home_branch_maintain'`)).rows).toEqual([
      { e: 'O' },
    ]);
  });

  describe('row E — reach follows the association relation, as the commands change it', () => {
    it('an assigned-scope actor gains a warehouse only when a business-wide actor associates it, and loses it when it is removed', async () => {
      const s = await shop(t, 'Row E shop');
      const two = await newBranch(t, s, 'Two');
      const key = `adj-${randomUUID().slice(0, 8)}`;
      expect(
        (
          await t.request
            .post('/v1/businesses/current/roles')
            .set(hdr(s.owner, s.businessId))
            .send({ key, name: 'Adjuster', permissions: ['warehouse.view', 'inventory.adjust'] })
        ).status,
      ).toBe(201);
      const clerk = await register(t, 'Clerk');
      expect((await t.request.post('/v1/businesses/current/members').set(hdr(s.owner, s.businessId)).send({ email: clerk.email, roleKey: key })).status).toBe(
        201,
      );
      expect(
        (
          await t.request
            .patch(`/v1/businesses/current/members/${clerk.userId}/branch-scope`)
            .set(hdr(s.owner, s.businessId))
            .send({ mode: 'assigned', branchIds: [two.branch] })
        ).status,
      ).toBe(200);
      const authz = t.app.get(InventoryAuthorizationService);
      const m = await t.app.get(TenancyService).resolveMembership(clerk.userId, s.businessId);
      const reach = (w: string) =>
        authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [w]).then(
          () => 'allowed',
          (e: unknown) => String((e as { details?: { inventoryCode?: string } }).details?.inventoryCode),
        );

      expect(await reach(two.warehouse)).toBe('allowed');
      expect(await reach(s.w1)).toBe('inventory.warehouse_out_of_scope');
      expect((await associate(t, s.owner, s, s.w1, two.branch)).status).toBe(200);
      expect(await reach(s.w1)).toBe('allowed');
      expect((await dissociate(t, s.owner, s, s.w1, two.branch)).status).toBe(200);
      expect(await reach(s.w1)).toBe('inventory.warehouse_out_of_scope');
      // The home association of the clerk's own warehouse cannot be removed to strand them.
      expect((await dissociate(t, s.owner, s, two.warehouse, two.branch)).status).toBe(409);
      expect(await reach(two.warehouse)).toBe('allowed');
    });
  });

  describe('row F — the self-expansion case, pushed to its edges', () => {
    it('an assigned-scope actor assigned to EVERY branch is still refused — the rule is the scope mode, not coverage — and the minter is never reached', async () => {
      const s = await shop(t, 'Row F shop');
      const two = await newBranch(t, s, 'Two');
      const mgr = await warehouseManager(t, s, 'assigned', [s.branch1, two.branch]);
      const before = await pairs(s.businessId);
      for (const res of [
        await associate(t, mgr, s, s.w1, two.branch), // would widen nothing the actor lacks
        await associate(t, mgr, s, two.warehouse, s.branch1),
        await associate(t, mgr, s, s.w1, s.branch1), // the pair ALREADY exists: authority is decided before idempotency
        await dissociate(t, mgr, s, s.w1, s.branch1), // the home pair: authority is decided before the home rule
        await associate(t, mgr, s, randomUUID(), s.branch1), // a warehouse that does not exist: authority before existence
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error.details.inventoryCode).toBe('inventory.business_wide_scope_required');
      }
      expect(mint).not.toHaveBeenCalled();
      expect(await pairs(s.businessId)).toEqual(before);
    });
  });

  describe('row G — a business-wide actor adds an association', () => {
    it('two CONCURRENT identical commands: exactly one row, exactly one audit event, one changed:true and one changed:false', async () => {
      const s = await shop(t, 'Row G shop');
      const two = await newBranch(t, s, 'Two');
      const mgr = await warehouseManager(t, s, 'all', []);
      const [r1, r2] = await Promise.all([associate(t, mgr, s, s.w1, two.branch), associate(t, s.owner, s, s.w1, two.branch)]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect([r1.body.changed, r2.body.changed].sort()).toEqual([false, true]);
      expect(await pairs(s.businessId)).toEqual([`${s.w1}>${s.branch1}`, `${s.w1}>${two.branch}`, `${two.warehouse}>${two.branch}`].sort());
      const audit = await ownerPool().query<{ actor_user_id: string }>(
        `SELECT actor_user_id FROM audit_events WHERE business_id = $1 AND action = 'structure.warehouse_branch_associated'`,
        [s.businessId],
      );
      expect(audit.rows).toHaveLength(1);
      const winner = r1.body.changed === true ? mgr.userId : s.owner.userId;
      expect(audit.rows[0]?.actor_user_id).toBe(winner);
      expect(mint).toHaveBeenCalledTimes(2);
    });
  });

  describe('row H — a cross-business pair is refused by the database, whoever writes it', () => {
    let a: Shop;
    let b: Shop;
    beforeEach(async () => {
      a = await shop(t, 'Row H A');
      b = await shop(t, 'Row H B');
    });

    it('the schema owner (superuser, no RLS) → 23503 from the composite foreign keys', async () => {
      for (const [branch, warehouse] of [
        [a.branch1, b.w1],
        [b.branch1, a.w1],
      ]) {
        const o = await ownerPool()
          .query(`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3)`, [a.businessId, branch, warehouse])
          .then(
            () => 'inserted',
            (e: unknown) => (e as { code?: string }).code,
          );
        expect(o).toBe('23503');
      }
    });

    it('the internal principal under its no-scope onboarding admission → still 23503', async () => {
      const c = await ownerPool().connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL ROLE daftar_inventory_internal`);
        const o = await c
          .query(`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3)`, [a.businessId, a.branch1, b.w1])
          .then(
            () => 'inserted',
            (e: unknown) => (e as { code?: string }).code,
          );
        expect(o).toBe('23503');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('a warehouse row naming another business’s branch as its home → 23503, so the maintainer never sees such a pair', async () => {
      const c = new Client({ connectionString: appDbUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [a.tenantId, a.businessId]);
        const o = await c.query(`INSERT INTO warehouses (business_id, branch_id, name) VALUES ($1, $2, 'Cross')`, [a.businessId, b.branch1]).then(
          () => 'inserted',
          (e: unknown) => (e as { code?: string }).code,
        );
        expect(o).toBe('23503');
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
    });
  });

  describe('row I — the home association cannot be deleted', () => {
    it('not by daftar_app (42501, by privilege), and not by the internal principal itself under the business scope (keep-home at COMMIT)', async () => {
      const s = await shop(t, 'Row I shop');
      const app = new Client({ connectionString: appDbUrl });
      await app.connect();
      try {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [s.tenantId, s.businessId]);
        const o = await app.query(`DELETE FROM branch_warehouses WHERE warehouse_id = $1`, [s.w1]).then(
          () => 'deleted',
          (e: unknown) => (e as { code?: string }).code,
        );
        expect(o).toBe('42501');
      } finally {
        await app.query('ROLLBACK');
        await app.end();
      }

      const c = await ownerPool().connect();
      let commit = '';
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [s.tenantId, s.businessId]);
        await c.query(`SET LOCAL ROLE daftar_inventory_internal`);
        const deleted = await c.query(`DELETE FROM branch_warehouses WHERE business_id = $1 AND warehouse_id = $2 AND branch_id = $3`, [
          s.businessId,
          s.w1,
          s.branch1,
        ]);
        expect(deleted.rowCount).toBe(1); // the principal CAN delete the row …
        await c.query('COMMIT').catch((e: unknown) => {
          commit = `${(e as { code?: string }).code} ${(e as Error).message}`;
        });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
      expect(commit).toMatch(/^P0001 inventory\.home_branch_association_required:/); // … and still cannot commit it
      expect(await pairs(s.businessId)).toEqual([`${s.w1}>${s.branch1}`]);
    });

    it('deleting the home row and re-inserting it in the same transaction is not a loss, and commits', async () => {
      const s = await shop(t, 'Row I reinsert');
      const c = await ownerPool().connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [s.tenantId, s.businessId]);
        await c.query(`SET LOCAL ROLE daftar_inventory_internal`);
        await c.query(`DELETE FROM branch_warehouses WHERE business_id = $1 AND warehouse_id = $2`, [s.businessId, s.w1]);
        await c.query(`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3)`, [s.businessId, s.branch1, s.w1]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      expect(await pairs(s.businessId)).toEqual([`${s.w1}>${s.branch1}`]);
    });
  });

  describe('row J — deleting a non-home association', () => {
    it('is allowed for an ARCHIVED warehouse too (removing reach is never refused for being archived), and the home mapping stays', async () => {
      const s = await shop(t, 'Row J shop');
      const two = await newBranch(t, s, 'Two');
      const w = await t.request.post('/v1/businesses/current/warehouses').set(hdr(s.owner, s.businessId)).send({ name: 'To archive', branchId: s.branch1 });
      expect(w.status).toBe(201);
      const wid = w.body.id as string;
      expect((await associate(t, s.owner, s, wid, two.branch)).status).toBe(200);
      await ownerPool().query(`UPDATE warehouses SET status = 'archived' WHERE id = $1`, [wid]);
      const res = await dissociate(t, s.owner, s, wid, two.branch);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ associated: false, changed: true });
      expect((await pairs(s.businessId)).filter((p) => p.startsWith(wid))).toEqual([`${wid}>${s.branch1}`]);
    });
  });

  describe('row K — accepted Phase 1 warehouse behaviour', () => {
    it('list and create answer exactly as before: the association relation adds no field and no row to the Phase 1 contract', async () => {
      const s = await shop(t, 'Row K shop');
      const created = await t.request.post('/v1/businesses/current/warehouses').set(hdr(s.owner, s.businessId)).send({ name: 'K WH', branchId: s.branch1 });
      expect(created.status).toBe(201);
      expect(Object.keys(created.body as object).sort()).toEqual(['branchId', 'id', 'isDefault', 'name']);
      const list = await t.request.get('/v1/businesses/current/warehouses').set(hdr(s.owner, s.businessId));
      expect(list.status).toBe(200);
      expect(Object.keys(list.body as object)).toEqual(['items']);
      const items = (list.body as { items: { id: string; name: string }[] }).items;
      expect(items.map((x) => x.id).sort()).toEqual([s.w1, created.body.id as string].sort());
      for (const row of items) expect(Object.keys(row).sort()).toEqual(['branchId', 'id', 'isDefault', 'name']);
      // An extra association does not duplicate the warehouse in the Phase 1 list.
      const two = await newBranch(t, s, 'Two');
      expect((await associate(t, s.owner, s, s.w1, two.branch)).status).toBe(200);
      const again = await t.request.get('/v1/businesses/current/warehouses').set(hdr(s.owner, s.businessId));
      expect((again.body as { items: { id: string }[] }).items.filter((x) => x.id === s.w1)).toHaveLength(1);
    });
  });

  describe('row L — the maintainer made to fail inside the frozen provisioning routine', () => {
    it('onboarding: the WHOLE onboarding rolls back — no tenant, business, branch, warehouse, role or membership — and the same request then succeeds', async () => {
      const owner = await register(t, 'Row L owner');
      const key = `wm-l-${randomUUID()}`;
      const before = await footprint();
      await injectFailure('branch_warehouses', async () => {
        const res = await onboardRequest(t, owner, 'Row L shop', key);
        expect(res.status).toBeGreaterThanOrEqual(500);
      });
      expect(await footprint()).toEqual(before);

      const retry = await onboardRequest(t, owner, 'Row L shop', key);
      expect(retry.status).toBe(201);
      expect(retry.body.replayed).toBe(false);
      const w = await ownerPool().query<{ id: string; branch_id: string }>(`SELECT id, branch_id FROM warehouses WHERE business_id = $1`, [
        retry.body.businessId,
      ]);
      expect(await pairs(retry.body.businessId as string)).toEqual([`${w.rows[0]?.id}>${w.rows[0]?.branch_id}`]);
    });

    it('the second writer through provision_create_business (a tenant owner creating another business) rolls back whole as well', async () => {
      const s = await shop(t, 'Row L first business');
      const before = await footprint();
      const send = () =>
        t.request
          .post(`/v1/tenants/${s.tenantId}/businesses`)
          .set('Idempotency-Key', `wm-l2-${randomUUID()}`)
          .set('Authorization', `Bearer ${s.owner.token}`)
          .send({
            businessName: 'Row L second',
            countryCode: 'PS',
            baseCurrency: 'ILS',
            storeSlug: `wm-l2-${randomUUID().slice(0, 12)}`,
            preferredLocale: 'en',
          });
      await injectFailure('branch_warehouses', async () => {
        const res = await send();
        expect(res.status).toBeGreaterThanOrEqual(500);
      });
      expect(await footprint()).toEqual(before);
      const ok = await send();
      expect(ok.status).toBe(201);
      expect(await countRows(`SELECT count(*)::text AS n FROM branch_warehouses WHERE business_id = $1`, [ok.body.businessId])).toBe(1);
    });
  });

  describe('row M — raw association DML as daftar_app is refused by privilege, whatever the row', () => {
    it('INSERT, DELETE, UPDATE and TRUNCATE — own home row, own new pair, another business, no scope — each → 42501', async () => {
      const a = await shop(t, 'Row M A');
      const b = await shop(t, 'Row M B');
      const two = await newBranch(t, a, 'Two');
      const statements: [string, unknown[]][] = [
        [`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3)`, [a.businessId, two.branch, a.w1]],
        [`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [a.businessId, a.branch1, a.w1]],
        [`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3)`, [b.businessId, b.branch1, b.w1]],
        [`DELETE FROM branch_warehouses WHERE business_id = $1`, [a.businessId]],
        [`DELETE FROM branch_warehouses WHERE business_id = $1`, [b.businessId]],
        [`UPDATE branch_warehouses SET branch_id = $2 WHERE business_id = $1`, [a.businessId, two.branch]],
        [`TRUNCATE branch_warehouses`, []],
      ];
      for (const scope of [{ tenant: a.tenantId, business: a.businessId }, null]) {
        for (const [sql, params] of statements) {
          const c = new Client({ connectionString: appDbUrl });
          await c.connect();
          try {
            await c.query('BEGIN');
            if (scope) await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenant, scope.business]);
            const code = await c.query(sql, params).then(
              () => 'executed',
              (e: unknown) => (e as { code?: string }).code,
            );
            expect(code, `${scope ? 'scoped' : 'unscoped'}: ${sql}`).toBe('42501');
          } finally {
            await c.query('ROLLBACK');
            await c.end();
          }
        }
      }
      expect(await pairs(a.businessId)).toEqual([`${a.w1}>${a.branch1}`, `${two.warehouse}>${two.branch}`].sort());
      expect(await pairs(b.businessId)).toEqual([`${b.w1}>${b.branch1}`]);
    });
  });
});
