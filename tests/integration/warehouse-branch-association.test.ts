import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { associateWarehouseBranchPayload, configureProductPayload } from '@daftar/inventory';
import { createTestApp, grantFeature, ownerPool, raiseLimit, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { InventoryAuthorizationService, type InventoryCommandAuthority } from '../../apps/api/src/modules/inventory/inventory-authorization';
import { TenancyService } from '../../apps/api/src/modules/tenancy/tenancy.service';
import { newBusinessTransactionId } from '../../apps/api/src/modules/inventory/business-transaction';

/**
 * P3-S1 — the warehouse–branch association commands on the Structure domain
 * (P3-AL-15 §B, P3-AL-54 §E, P3-AL-55 §I), and the authorization seam every
 * inventory command uses (P3-AL-33, P3-AL-39).
 *
 * Signed-authority matrix rows L and M, warehouse matrix rows E, F, G, I
 * (through the command), J, and the tenant-isolation DENY cases.
 */
describe('warehouse–branch association (P3-S1)', () => {
  let t: TestApp;
  let mint: MockInstance<InventoryAssertionMinterService['mint']>;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
    mint = vi.spyOn(t.app.get(InventoryAssertionMinterService), 'mint');
  });
  afterEach(async () => {
    mint.mockRestore();
    await t?.close();
  });

  const auth = (token: string, businessId: string) => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });

  interface Fixture {
    owner: { token: string; userId: string };
    businessId: string;
    tenantId: string;
    /** The onboarding branch, and its 'Main warehouse' (home = branch1). */
    branch1: string;
    w1: string;
    /** A second branch, and the default warehouse createBranch() gave it (home = branch2). */
    branch2: string;
    w2: string;
    /** A member holding warehouse.manage through a custom role; scope mode set per test. */
    manager: { token: string; userId: string };
  }

  async function register(displayName: string): Promise<{ token: string; userId: string; email: string }> {
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName, preferredLocale: 'ar' });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, userId: me.body.userId as string, email: me.body.email as string };
  }

  async function setup(name = 'Assoc Biz'): Promise<Fixture> {
    const owner = await register('Owner');
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `assoc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ businessName: name, countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `assoc-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    expect(on.status).toBe(201);
    const businessId = on.body.businessId as string;
    const tenantId = (await ownerPool().query<{ tenant_id: string }>('SELECT tenant_id FROM businesses WHERE id = $1', [businessId])).rows[0]?.tenant_id ?? '';

    await grantFeature(businessId, owner.userId, 'MULTI_BRANCH');
    await grantFeature(businessId, owner.userId, 'CUSTOM_ROLES');
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id) VALUES ($1, 'MAX_BRANCHES', 10, 'assoc-test', $2)`,
      [businessId, owner.userId],
    );
    // The free plan seats two users; the viewer case adds a third member.
    await raiseLimit(businessId, owner.userId, 'MAX_USERS', 10);

    const b2 = await t.request.post('/v1/businesses/current/branches').set(auth(owner.token, businessId)).send({ name: 'Second' });
    expect(b2.status).toBe(201);
    const homes = (
      await ownerPool().query<{ id: string; branch_id: string }>('SELECT id, branch_id FROM warehouses WHERE business_id = $1 ORDER BY created_at', [
        businessId,
      ])
    ).rows;
    const branch2 = b2.body.id as string;
    const w2 = homes.find((w) => w.branch_id === branch2)?.id ?? '';
    const first = homes.find((w) => w.branch_id !== branch2);
    const branch1 = first?.branch_id ?? '';
    const w1 = first?.id ?? '';

    const role = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(owner.token, businessId))
      .send({ key: 'stock-manager', name: 'Stock manager', permissions: ['branch.view', 'warehouse.view', 'warehouse.manage'] });
    expect(role.status).toBe(201);
    const manager = await register('Manager');
    const add = await t.request
      .post('/v1/businesses/current/members')
      .set(auth(owner.token, businessId))
      .send({ email: manager.email, roleKey: 'stock-manager' });
    expect(add.status).toBe(201);

    return { owner, businessId, tenantId, branch1, w1, branch2, w2, manager };
  }

  async function setScope(f: Fixture, mode: 'all' | 'assigned', branchIds: string[]) {
    const res = await t.request
      .patch(`/v1/businesses/current/members/${f.manager.userId}/branch-scope`)
      .set(auth(f.owner.token, f.businessId))
      .send({ mode, branchIds });
    expect(res.status).toBe(200);
  }

  function associate(token: string, businessId: string, warehouseId: string, branchId: string) {
    return t.request.post(`/v1/businesses/current/warehouses/${warehouseId}/branches`).set(auth(token, businessId)).send({ branchId });
  }
  function dissociate(token: string, businessId: string, warehouseId: string, branchId: string) {
    return t.request.delete(`/v1/businesses/current/warehouses/${warehouseId}/branches/${branchId}`).set(auth(token, businessId));
  }

  async function associations(businessId: string): Promise<string[]> {
    return (
      await ownerPool().query<{ pair: string }>(
        `SELECT warehouse_id::text || '>' || branch_id::text AS pair FROM branch_warehouses WHERE business_id = $1 ORDER BY 1`,
        [businessId],
      )
    ).rows.map((r) => r.pair);
  }

  async function auditRows(businessId: string, action: string) {
    return (
      await ownerPool().query<{ actor_user_id: string; entity_id: string | null; trace: string | null }>(
        `SELECT actor_user_id, entity_id, metadata->>'business_transaction_id' AS trace
           FROM audit_events WHERE business_id = $1 AND action = $2 ORDER BY created_at`,
        [businessId, action],
      )
    ).rows;
  }

  it('row M/G: an all-scope actor with warehouse.manage associates; the routine-written audit row names that actor; a repeat is idempotent', async () => {
    const f = await setup();
    await setScope(f, 'all', []);
    const before = await associations(f.businessId);
    expect(before).toEqual([`${f.w1}>${f.branch1}`, `${f.w2}>${f.branch2}`].sort());

    const res = await associate(f.manager.token, f.businessId, f.w1, f.branch2);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ warehouseId: f.w1, branchId: f.branch2, associated: true, changed: true });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]?.[0]).toMatchObject({
      actorUserId: f.manager.userId,
      tenantId: f.tenantId,
      businessId: f.businessId,
      opCode: 'structure.associate_warehouse_branch',
      payloadSha256: associateWarehouseBranchPayload({ tenantId: f.tenantId, businessId: f.businessId, warehouseId: f.w1, branchId: f.branch2 }).sha256,
    });
    expect(await associations(f.businessId)).toEqual([...before, `${f.w1}>${f.branch2}`].sort());

    const audit = await auditRows(f.businessId, 'structure.warehouse_branch_associated');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_user_id).toBe(f.manager.userId);
    // P3-AL-35: the routine-written row carries the trace id the boundary minted for this operation.
    expect(audit[0]?.trace).toBe(res.body.businessTransactionId);

    const again = await associate(f.owner.token, f.businessId, f.w1, f.branch2);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ associated: true, changed: false });
    expect(await associations(f.businessId)).toEqual([...before, `${f.w1}>${f.branch2}`].sort());
    // No second row and no second audit event.
    expect(await auditRows(f.businessId, 'structure.warehouse_branch_associated')).toHaveLength(1);
  });

  it('row L/F: an assigned-scope actor holding warehouse.manage is refused BEFORE the minter — the self-expansion case', async () => {
    const f = await setup();
    await setScope(f, 'assigned', [f.branch2]);
    const before = await associations(f.businessId);

    const add = await associate(f.manager.token, f.businessId, f.w1, f.branch2);
    expect(add.status).toBe(403);
    expect(add.body.error.details.inventoryCode).toBe('inventory.business_wide_scope_required');
    const remove = await dissociate(f.manager.token, f.businessId, f.w2, f.branch2);
    expect(remove.status).toBe(403);

    expect(mint).toHaveBeenCalledTimes(0);
    expect(await associations(f.businessId)).toEqual(before);
    expect(await auditRows(f.businessId, 'structure.warehouse_branch_associated')).toHaveLength(0);
  });

  it('a member without warehouse.manage is refused before the minter', async () => {
    const f = await setup();
    const viewer = await register('Viewer');
    await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(f.owner.token, f.businessId))
      .send({ key: 'viewer', name: 'Viewer', permissions: ['branch.view', 'warehouse.view'] });
    expect(
      (await t.request.post('/v1/businesses/current/members').set(auth(f.owner.token, f.businessId)).send({ email: viewer.email, roleKey: 'viewer' })).status,
    ).toBe(201);
    expect((await associate(viewer.token, f.businessId, f.w1, f.branch2)).status).toBe(403);
    expect(mint).not.toHaveBeenCalled();
  });

  it('row I (command): removing the home association is refused, and the mapping survives', async () => {
    const f = await setup();
    const res = await dissociate(f.owner.token, f.businessId, f.w1, f.branch1);
    expect(res.status).toBe(409);
    expect(res.body.error.details.inventoryCode).toBe('inventory.home_branch_association_required');
    expect(mint).not.toHaveBeenCalled();
    expect(await associations(f.businessId)).toContain(`${f.w1}>${f.branch1}`);
  });

  it('row J: removing a non-home association is allowed, audited, idempotent, and the home mapping stays', async () => {
    const f = await setup();
    expect((await associate(f.owner.token, f.businessId, f.w1, f.branch2)).status).toBe(200);
    mint.mockClear();

    const res = await dissociate(f.owner.token, f.businessId, f.w1, f.branch2);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ warehouseId: f.w1, branchId: f.branch2, associated: false, changed: true });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]?.[0]).toMatchObject({ opCode: 'structure.dissociate_warehouse_branch', actorUserId: f.owner.userId });
    expect(await associations(f.businessId)).toEqual([`${f.w1}>${f.branch1}`, `${f.w2}>${f.branch2}`].sort());
    const audit = await auditRows(f.businessId, 'structure.warehouse_branch_dissociated');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_user_id).toBe(f.owner.userId);
    expect(audit[0]?.trace).toBe(res.body.businessTransactionId);

    const again = await dissociate(f.owner.token, f.businessId, f.w1, f.branch2);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ associated: false, changed: false });
    expect(await auditRows(f.businessId, 'structure.warehouse_branch_dissociated')).toHaveLength(1);
  });

  it('adding refuses an archived branch or an archived warehouse, before anything is minted', async () => {
    const f = await setup();
    const w3 = await t.request.post('/v1/businesses/current/warehouses').set(auth(f.owner.token, f.businessId)).send({ name: 'W3', branchId: f.branch1 });
    expect(w3.status).toBe(201);
    const w3Id = w3.body.id as string;
    await ownerPool().query(`UPDATE warehouses SET status = 'archived' WHERE business_id = $1 AND id = $2`, [f.businessId, w3Id]);
    const archivedWarehouse = await associate(f.owner.token, f.businessId, w3Id, f.branch2);
    expect(archivedWarehouse.status).toBe(409);
    expect(archivedWarehouse.body.error.details.inventoryCode).toBe('structure.warehouse_archived');

    await ownerPool().query(`UPDATE branches SET status = 'archived' WHERE business_id = $1 AND id = $2`, [f.businessId, f.branch2]);
    const archivedBranch = await associate(f.owner.token, f.businessId, f.w1, f.branch2);
    expect(archivedBranch.status).toBe(409);
    expect(archivedBranch.body.error.details.inventoryCode).toBe('structure.branch_archived');

    expect(mint).not.toHaveBeenCalled();
    expect(await associations(f.businessId)).not.toContain(`${f.w1}>${f.branch2}`);
  });

  it("DENY: tenant A cannot associate or dissociate tenant B's warehouse or branch, even with B's UUIDs", async () => {
    const a = await setup('Tenant A');
    const b = await setup('Tenant B');
    const bBefore = await associations(b.businessId);

    // Entirely foreign pair, in A's business context: invisible under RLS.
    const foreign = await associate(a.owner.token, a.businessId, b.w1, b.branch2);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.details.inventoryCode).toBe('structure.warehouse_not_found');
    // Mixed pairs: A's warehouse with B's branch, B's warehouse with A's branch.
    const foreignBranch = await associate(a.owner.token, a.businessId, a.w1, b.branch2);
    expect(foreignBranch.status).toBe(404);
    expect(foreignBranch.body.error.details.inventoryCode).toBe('structure.branch_not_found');
    expect((await associate(a.owner.token, a.businessId, b.w1, a.branch2)).status).toBe(404);
    expect((await dissociate(a.owner.token, a.businessId, b.w2, b.branch2)).status).toBe(404);
    // B's business context: A is not a member.
    expect((await associate(a.owner.token, b.businessId, b.w1, b.branch2)).status).toBe(403);

    expect(mint).not.toHaveBeenCalled();
    expect(await associations(b.businessId)).toEqual(bBefore);
    expect(await associations(a.businessId)).not.toContain(`${a.w1}>${b.branch2}`);
  });

  it('malformed ids are a 400 before any read', async () => {
    const f = await setup();
    expect((await associate(f.owner.token, f.businessId, 'nope', f.branch2)).status).toBe(400);
    expect((await associate(f.owner.token, f.businessId, f.w1, 'nope')).status).toBe(400);
    expect((await dissociate(f.owner.token, f.businessId, f.w1, 'nope')).status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
  });

  describe('the authorization seam (P3-AL-33, P3-AL-39)', () => {
    it('row E: an assigned-scope actor reaches exactly the warehouses associated with an active branch of their scope — every affected warehouse must pass', async () => {
      const f = await setup();
      const authz = t.app.get(InventoryAuthorizationService);
      const tenancy = t.app.get(TenancyService);

      await setScope(f, 'assigned', [f.branch2]);
      let m = await tenancy.resolveMembership(f.manager.userId, f.businessId);
      // warehouse.manage does not carry inventory.adjust: the permission half refuses first.
      await expect(authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [f.w2])).rejects.toMatchObject({ httpStatus: 403 });

      // An owner-granted inventory role, still assigned to branch2 only.
      await t.request
        .post('/v1/businesses/current/roles')
        .set(auth(f.owner.token, f.businessId))
        .send({ key: 'stock-adjuster', name: 'Adjuster', permissions: ['warehouse.view', 'inventory.adjust'] });
      await t.request
        .patch(`/v1/businesses/current/members/${f.manager.userId}/roles`)
        .set(auth(f.owner.token, f.businessId))
        .send({ roleKeys: ['stock-adjuster'] });
      m = await tenancy.resolveMembership(f.manager.userId, f.businessId);

      await expect(authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [f.w2])).resolves.toMatchObject({ warehouseIds: [f.w2] });
      await expect(authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [f.w1])).rejects.toMatchObject({
        httpStatus: 403,
        details: { inventoryCode: 'inventory.warehouse_out_of_scope' },
      });
      // A two-warehouse command: both must pass.
      await expect(authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [f.w2, f.w1])).rejects.toMatchObject({ httpStatus: 403 });

      // A business-wide actor associates w1 with branch2; now both are reachable.
      expect((await associate(f.owner.token, f.businessId, f.w1, f.branch2)).status).toBe(200);
      await expect(authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [f.w2, f.w1])).resolves.toBeTruthy();

      // An archived branch in the scope grants nothing.
      await ownerPool().query(`UPDATE branches SET status = 'archived' WHERE business_id = $1 AND id = $2`, [f.businessId, f.branch2]);
      await expect(authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [f.w2])).rejects.toMatchObject({ httpStatus: 403 });

      // Default deny: assigned with no branch reaches no warehouse.
      await setScope(f, 'assigned', []);
      m = await tenancy.resolveMembership(f.manager.userId, f.businessId);
      await expect(authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [f.w1])).rejects.toMatchObject({ httpStatus: 403 });
      // ...but a command that affects no warehouse needs only its permission.
      await expect(authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [])).resolves.toBeTruthy();
    });

    it('a warehouse of another business is refused exactly like one out of scope', async () => {
      const a = await setup('Scope A');
      const b = await setup('Scope B');
      const authz = t.app.get(InventoryAuthorizationService);
      await t.request
        .post('/v1/businesses/current/roles')
        .set(auth(a.owner.token, a.businessId))
        .send({ key: 'stock-adjuster', name: 'Adjuster', permissions: ['warehouse.view', 'inventory.adjust'] });
      await t.request
        .patch(`/v1/businesses/current/members/${a.manager.userId}/roles`)
        .set(auth(a.owner.token, a.businessId))
        .send({ roleKeys: ['stock-adjuster'] });
      await setScope(a, 'assigned', [a.branch1, a.branch2]);
      const m = await t.app.get(TenancyService).resolveMembership(a.manager.userId, a.businessId);
      await expect(authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId(), [b.w1])).rejects.toMatchObject({
        details: { inventoryCode: 'inventory.warehouse_out_of_scope' },
      });
    });

    it('mint accepts only an authority the seam issued, and only for the kind it was issued for', async () => {
      const f = await setup();
      const authz = t.app.get(InventoryAuthorizationService);
      const m = await t.app.get(TenancyService).resolveMembership(f.owner.userId, f.businessId);
      const payload = configureProductPayload({
        tenantId: f.tenantId,
        businessId: f.businessId,
        productId: '00000000-0000-4000-8000-000000000001',
        trackInventory: false,
        unitCode: null,
        unitDecimals: null,
      });

      const forged: InventoryCommandAuthority = {
        scope: { tenantId: f.tenantId, businessId: f.businessId, actorUserId: f.owner.userId, businessTransactionId: newBusinessTransactionId() },
        opCode: 'inventory.configure_product',
        warehouseIds: [],
      };
      expect(() => authz.mint(forged, payload)).toThrow(/established by InventoryAuthorizationService/);

      const association = await authz.authorize(m, 'structure.associate_warehouse_branch', newBusinessTransactionId());
      expect(() => authz.mint(association, payload)).toThrow(/cannot sign/);
      expect(mint).not.toHaveBeenCalled();

      const genuine = await authz.authorize(m, 'inventory.configure_product', newBusinessTransactionId());
      expect(typeof authz.mint(genuine, payload)).toBe('string');
      expect(mint).toHaveBeenCalledTimes(1);
    });
  });
});
