import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { configureProductPayload, mintInventoryAssertion, splitInventoryAssertion } from '../../packages/inventory/src';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import {
  createTestApp,
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
 * P3-S1 — THE HTTP AUTHORITY OF THE INVENTORY COMMANDS: P3-AL-55 rows L and
 * M, and P3-AL-54 acceptance item 3. Independent adversarial suite (Agent F).
 *
 * Every refusal is paired with the ALLOW of the same request by an actor who
 * does hold the authority, and every refusal asserts the minter was never
 * called (a spy on InventoryAssertionMinterService.mint). What the domain
 * agent's own suites already prove (a custom-role manager, a branch2-only
 * assigned actor, a viewer, the owner) is not repeated; this suite attacks:
 *
 *   item 3 — the BUILT-IN manager and cashier templates; mass-assigned body
 *            fields, query flags and a genuine assertion smuggled in a header;
 *            a non-owner holding inventory.adjust through a custom role,
 *            audited as THAT member with the jti actually consumed; revocation
 *            by role reassignment and by role edit; repeated identical
 *            requests minting distinct, each-consumed jtis;
 *   row L  — ONE user who is all-scope in business A2 but assigned to every
 *            branch of business A: refused in A (POST and DELETE), allowed in
 *            A2; and the business context cannot be borrowed across the two;
 *   row M  — the BUILT-IN manager template associates and dissociates; the
 *            routine-written audit row names the manager, carries the jti
 *            that was minted for it and consumed, and the operation's trace.
 */

interface Actor {
  token: string;
  userId: string;
  email: string;
}

describe('HTTP authority of the inventory commands', () => {
  let t: TestApp;
  let mintSpy: MockInstance<InventoryAssertionMinterService['mint']>;
  let owner: Actor;
  let manager: Actor;
  let cashier: Actor;
  let adjuster: Actor;
  let revokee: Actor;
  let split: Actor;
  let A: { businessId: string; tenantId: string; branch1: string; branch2: string; w1: string; w2: string };
  let A2: { businessId: string; branch1: string; branch2: string; w1: string };

  const hdr = (a: Actor, businessId: string): Record<string, string> => ({ Authorization: `Bearer ${a.token}`, 'X-Business-Id': businessId });

  async function register(name: string): Promise<Actor> {
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: name, preferredLocale: 'en' });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, userId: me.body.userId as string, email: me.body.email as string };
  }

  async function prepare(businessId: string): Promise<{ branch1: string; branch2: string; w1: string; w2: string }> {
    await grantFeature(businessId, owner.userId, 'MULTI_BRANCH');
    await grantFeature(businessId, owner.userId, 'CUSTOM_ROLES');
    await raiseLimit(businessId, owner.userId, 'MAX_BRANCHES', 10);
    await raiseLimit(businessId, owner.userId, 'MAX_USERS', 20);
    const home = (await ownerPool().query<{ branch_id: string; id: string }>(`SELECT branch_id, id FROM warehouses WHERE business_id = $1`, [businessId]))
      .rows[0];
    const br = await t.request.post('/v1/businesses/current/branches').set(hdr(owner, businessId)).send({ name: 'Second' });
    expect(br.status).toBe(201);
    const w2 = (
      await ownerPool().query<{ id: string }>(`SELECT id FROM warehouses WHERE business_id = $1 AND branch_id = $2`, [businessId, br.body.id as string])
    ).rows[0];
    return { branch1: home?.branch_id ?? '', w1: home?.id ?? '', branch2: br.body.id as string, w2: w2?.id ?? '' };
  }

  async function role(businessId: string, key: string, permissions: string[]): Promise<void> {
    const r = await t.request.post('/v1/businesses/current/roles').set(hdr(owner, businessId)).send({ key, name: key, permissions });
    expect(r.status).toBe(201);
  }
  async function member(businessId: string, a: Actor, roleKey: string): Promise<void> {
    expect((await t.request.post('/v1/businesses/current/members').set(hdr(owner, businessId)).send({ email: a.email, roleKey })).status).toBe(201);
  }

  beforeAll(async () => {
    await ensurePostgres();
    await resetData();
    t = await createTestApp();
    mintSpy = vi.spyOn(t.app.get(InventoryAssertionMinterService), 'mint');
    owner = await register('Owner');
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `ha-${randomUUID()}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ businessName: 'Authority A', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `ha-a-${randomUUID().slice(0, 8)}`, preferredLocale: 'en' });
    expect(on.status).toBe(201);
    const second = await t.request
      .post(`/v1/tenants/${on.body.tenantId as string}/businesses`)
      .set('Idempotency-Key', `ha-${randomUUID()}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ businessName: 'Authority A2', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `ha-a2-${randomUUID().slice(0, 8)}`, preferredLocale: 'en' });
    expect(second.status).toBe(201);
    A = { businessId: on.body.businessId as string, tenantId: on.body.tenantId as string, ...(await prepare(on.body.businessId as string)) };
    A2 = { businessId: second.body.businessId as string, ...(await prepare(second.body.businessId as string)) };

    manager = await register('Built-in manager');
    cashier = await register('Built-in cashier');
    adjuster = await register('Custom adjuster');
    revokee = await register('Revokee');
    split = await register('All-scope in A2, assigned in A');
    await role(A.businessId, 'stock-adjuster', ['catalog.view', 'inventory.adjust']);
    await role(A.businessId, 'temp-adjuster', ['catalog.view', 'inventory.adjust']);
    await role(A.businessId, 'wh-manager', ['branch.view', 'warehouse.view', 'warehouse.manage']);
    await role(A2.businessId, 'wh-manager', ['branch.view', 'warehouse.view', 'warehouse.manage']);
    await member(A.businessId, manager, 'manager');
    await member(A.businessId, cashier, 'cashier');
    await member(A.businessId, adjuster, 'stock-adjuster');
    await member(A.businessId, revokee, 'temp-adjuster');
    await member(A.businessId, split, 'wh-manager');
    await member(A2.businessId, split, 'wh-manager');
    // In A, assigned to EVERY branch; in A2, business-wide.
    const scope = await t.request
      .patch(`/v1/businesses/current/members/${split.userId}/branch-scope`)
      .set(hdr(owner, A.businessId))
      .send({ mode: 'assigned', branchIds: [A.branch1, A.branch2] });
    expect(scope.status).toBe(200);
  }, 60_000);

  beforeEach(() => {
    mintSpy.mockClear();
  });

  afterAll(async () => {
    mintSpy?.mockRestore();
    await t?.close();
  });

  // ── shared readers ──────────────────────────────────────────────────────

  async function newProduct(): Promise<string> {
    const pr = await t.request
      .post('/v1/catalog/products')
      .set(hdr(owner, A.businessId))
      .send({ translations: { en: 'Authority product' }, basePriceMinor: '700' });
    expect(pr.status).toBe(201);
    return pr.body.id as string;
  }
  async function productState(product: string): Promise<unknown> {
    const p = (await ownerPool().query(`SELECT track_inventory, unit_code, unit_decimals FROM products WHERE id = $1`, [product])).rows[0];
    const v = (await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM product_variants WHERE product_id = $1 AND is_base`, [product])).rows[0];
    return { ...p, baseVariants: v?.n };
  }
  async function audits(entityId: string, action: string): Promise<{ actor_user_id: string; metadata: Record<string, unknown> }[]> {
    return (
      await ownerPool().query<{ actor_user_id: string; metadata: Record<string, unknown> }>(
        `SELECT actor_user_id::text, metadata FROM audit_events WHERE entity_id = $1 AND action = $2 ORDER BY created_at`,
        [entityId, action],
      )
    ).rows;
  }
  async function use(jti: string): Promise<{ op_code: string; business_id: string } | undefined> {
    return (
      await ownerPool().query<{ op_code: string; business_id: string }>(`SELECT op_code, business_id::text FROM inventory_assertion_uses WHERE jti = $1`, [jti])
    ).rows[0];
  }
  /** The assertions the minter actually returned during this test. */
  const minted = (): string[] => mintSpy.mock.results.map((r) => (r.type === 'return' ? String(r.value) : '<threw>'));

  const configure = (a: Actor, product: string, body: Record<string, unknown> = { trackInventory: true, unitCode: 'piece' }) =>
    t.request.put(`/v1/inventory/products/${product}/configuration`).set(hdr(a, A.businessId)).send(body);

  // ── P3-AL-54 acceptance item 3 ─────────────────────────────────────────

  describe('item 3 — inventory_configure_product only after inventory.adjust AND a consumed assertion; nothing skips either', () => {
    it('DENY: the BUILT-IN manager and cashier templates hold no inventory.adjust → 403 before the minter; the product is untouched', async () => {
      const p = await newProduct();
      const before = await productState(p);
      for (const a of [manager, cashier]) {
        const res = await configure(a, p);
        expect(res.status, a === manager ? 'manager' : 'cashier').toBe(403);
      }
      expect(mintSpy).not.toHaveBeenCalled();
      expect(await productState(p)).toEqual(before);
    });

    it('ALLOW: the same request by a non-owner holding inventory.adjust through a custom role — audited as THAT member, with the minted jti consumed', async () => {
      const p = await newProduct();
      const res = await configure(adjuster, p);
      expect(res.status).toBe(200);
      expect(mintSpy).toHaveBeenCalledTimes(1);
      const [assertion] = minted();
      const parts = splitInventoryAssertion(assertion ?? '');
      expect({ actor: parts.actorUserId, tenant: parts.tenantId, business: parts.businessId, op: parts.wireOperation }).toEqual({
        actor: adjuster.userId,
        tenant: A.tenantId,
        business: A.businessId,
        op: 'inventory:configure_product',
      });
      const rows = await audits(p, 'inventory.product_configured');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(adjuster.userId);
      expect(rows[0]?.metadata['assertionJti']).toBe(parts.jti);
      expect(rows[0]?.metadata['business_transaction_id']).toBe(res.body.businessTransactionId);
      expect(await use(parts.jti)).toEqual({ op_code: 'inventory.configure_product', business_id: A.businessId });
      expect(await productState(p)).toEqual({ track_inventory: true, unit_code: 'piece', unit_decimals: 0, baseVariants: 1 });
    });

    const SMUGGLED: [string, Record<string, unknown>][] = [
      ['trusted', { trusted: true }],
      ['force', { force: true }],
      ['skipAuthorization', { skipAuthorization: true }],
      ['tenantId', { tenantId: randomUUID() }],
      ['businessId', { businessId: randomUUID() }],
      ['actorUserId', { actorUserId: randomUUID() }],
      ['assertion', { assertion: 'invctl/1.x' }],
      ['inventoryAssertion', { inventoryAssertion: 'invctl/1.x' }],
      ['permissions', { permissions: ['inventory.adjust'] }],
    ];

    it.each(SMUGGLED)('DENY: a member WITHOUT the permission adding `%s` to the body → 403, nothing minted', async (_k, extra) => {
      const p = await newProduct();
      const before = await productState(p);
      expect((await configure(cashier, p, { trackInventory: true, unitCode: 'piece', ...extra })).status).toBe(403);
      expect(mintSpy).not.toHaveBeenCalled();
      expect(await productState(p)).toEqual(before);
    });

    it.each(SMUGGLED)('…and the member WITH it adding `%s` is refused as a malformed request (400), still nothing minted', async (_k, extra) => {
      const p = await newProduct();
      const before = await productState(p);
      expect((await configure(adjuster, p, { trackInventory: true, unitCode: 'piece', ...extra })).status).toBe(400);
      expect(mintSpy).not.toHaveBeenCalled();
      expect(await productState(p)).toEqual(before);
    });

    it('DENY: query flags and a GENUINE, correctly scoped assertion smuggled in headers do not help a member without the permission', async () => {
      const p = await newProduct();
      const before = await productState(p);
      const smuggled = mintInventoryAssertion(
        {
          actorUserId: cashier.userId,
          tenantId: A.tenantId,
          businessId: A.businessId,
          opCode: 'inventory.configure_product',
          payloadSha256: configureProductPayload({
            tenantId: A.tenantId,
            businessId: A.businessId,
            productId: p,
            trackInventory: true,
            unitCode: 'piece',
            unitDecimals: null,
          }).sha256,
        },
        inventoryAssertionKey(),
        new Date(),
        60,
      );
      const res = await t.request
        .put(`/v1/inventory/products/${p}/configuration?force=true&trusted=1&skipAuthorization=true&assertion=${encodeURIComponent(smuggled)}`)
        .set({ ...hdr(cashier, A.businessId), 'X-Inventory-Assertion': smuggled, 'X-Trusted': 'true', 'X-Force': 'true' })
        .send({ trackInventory: true, unitCode: 'piece' });
      expect(res.status).toBe(403);
      expect(mintSpy).not.toHaveBeenCalled();
      expect(await productState(p)).toEqual(before);
      expect(await use(splitInventoryAssertion(smuggled).jti)).toBeUndefined();
    });

    it('ALLOW: the same flags and header on the permitted member’s request are ignored — the server mints its own assertion and consumes THAT one', async () => {
      const p = await newProduct();
      const decoy = randomUUID();
      const res = await t.request
        .put(`/v1/inventory/products/${p}/configuration?force=true&trusted=1`)
        .set({ ...hdr(adjuster, A.businessId), 'X-Inventory-Assertion': `invctl/1.inv1.${decoy}`, 'X-Trusted': 'true' })
        .send({ trackInventory: true, unitCode: 'piece' });
      expect(res.status).toBe(200);
      expect(mintSpy).toHaveBeenCalledTimes(1);
      const jti = splitInventoryAssertion(minted()[0] ?? '').jti;
      expect(await use(jti)).toEqual({ op_code: 'inventory.configure_product', business_id: A.businessId });
      expect((await audits(p, 'inventory.product_configured'))[0]?.actor_user_id).toBe(adjuster.userId);
    });

    it('revocation by role reassignment: ALLOW while held, DENY (403, nothing minted) at the very next request after the owner reassigns', async () => {
      const p1 = await newProduct();
      expect((await configure(revokee, p1)).status).toBe(200);
      expect(mintSpy).toHaveBeenCalledTimes(1);
      const patch = await t.request
        .patch(`/v1/businesses/current/members/${revokee.userId}/roles`)
        .set(hdr(owner, A.businessId))
        .send({ roleKeys: ['cashier'] });
      expect(patch.status).toBe(200);
      const p2 = await newProduct();
      expect((await configure(revokee, p2)).status).toBe(403);
      expect(mintSpy).toHaveBeenCalledTimes(1);
      // Restore for the next case.
      expect(
        (
          await t.request
            .patch(`/v1/businesses/current/members/${revokee.userId}/roles`)
            .set(hdr(owner, A.businessId))
            .send({ roleKeys: ['temp-adjuster'] })
        ).status,
      ).toBe(200);
    });

    it('revocation by role EDIT: removing inventory.adjust from the role the member holds takes effect at the next request', async () => {
      const p1 = await newProduct();
      expect((await configure(revokee, p1)).status).toBe(200);
      const roleId = (await ownerPool().query<{ id: string }>(`SELECT id FROM business_roles WHERE business_id = $1 AND key = 'temp-adjuster'`, [A.businessId]))
        .rows[0]?.id;
      const edit = await t.request
        .patch(`/v1/businesses/current/roles/${roleId}`)
        .set(hdr(owner, A.businessId))
        .send({ permissions: ['catalog.view'] });
      expect(edit.status).toBe(200);
      const p2 = await newProduct();
      const before = await productState(p2);
      expect((await configure(revokee, p2)).status).toBe(403);
      expect(mintSpy).toHaveBeenCalledTimes(1);
      expect(await productState(p2)).toEqual(before);
    });

    it('repeated identical requests each mint a DISTINCT jti and each consume it; only the one that changed something is audited', async () => {
      const p = await newProduct();
      const first = await configure(adjuster, p);
      const again = await configure(adjuster, p);
      expect([first.status, again.status]).toEqual([200, 200]);
      expect([first.body.changed, again.body.changed]).toEqual([true, false]);
      const jtis = minted().map((a) => splitInventoryAssertion(a).jti);
      expect(jtis).toHaveLength(2);
      expect(new Set(jtis).size).toBe(2);
      for (const j of jtis) expect(await use(j)).toEqual({ op_code: 'inventory.configure_product', business_id: A.businessId });
      expect((await audits(p, 'inventory.product_configured')).map((r) => r.metadata['assertionJti'])).toEqual([jtis[0]]);
      expect(first.body.businessTransactionId).not.toBe(again.body.businessTransactionId);
    });
  });

  // ── P3-AL-55 row L ─────────────────────────────────────────────────────

  describe('row L — one user, all-scope in A2 and assigned to every branch in A', () => {
    const assoc = (header: string, w: string, b: string) =>
      t.request.post(`/v1/businesses/current/warehouses/${w}/branches`).set(hdr(split, header)).send({ branchId: b });
    const dissoc = (header: string, w: string, b: string) => t.request.delete(`/v1/businesses/current/warehouses/${w}/branches/${b}`).set(hdr(split, header));

    it('DENY in A: associate → 403 inventory.business_wide_scope_required, before the minter; no row', async () => {
      const res = await assoc(A.businessId, A.w1, A.branch2);
      expect(res.status).toBe(403);
      expect(res.body.error.details.inventoryCode).toBe('inventory.business_wide_scope_required');
      expect(mintSpy).not.toHaveBeenCalled();
      expect((await ownerPool().query(`SELECT 1 FROM branch_warehouses WHERE warehouse_id = $1 AND branch_id = $2`, [A.w1, A.branch2])).rowCount).toBe(0);
    });

    it('DENY in A: dissociate of an EXISTING pair (created by the owner) → 403 before the minter; the pair survives', async () => {
      expect(
        (await t.request.post(`/v1/businesses/current/warehouses/${A.w2}/branches`).set(hdr(owner, A.businessId)).send({ branchId: A.branch1 })).status,
      ).toBe(200);
      mintSpy.mockClear();
      const res = await dissoc(A.businessId, A.w2, A.branch1);
      expect(res.status).toBe(403);
      expect(res.body.error.details.inventoryCode).toBe('inventory.business_wide_scope_required');
      expect(mintSpy).not.toHaveBeenCalled();
      expect((await ownerPool().query(`SELECT 1 FROM branch_warehouses WHERE warehouse_id = $1 AND branch_id = $2`, [A.w2, A.branch1])).rowCount).toBe(1);
    });

    it('ALLOW in A2: the identical associate and dissociate by the same user → 200, one mint each, audited as that user', async () => {
      const add = await assoc(A2.businessId, A2.w1, A2.branch2);
      expect(add.status).toBe(200);
      expect(add.body).toMatchObject({ associated: true, changed: true });
      const del = await dissoc(A2.businessId, A2.w1, A2.branch2);
      expect(del.status).toBe(200);
      expect(del.body).toMatchObject({ associated: false, changed: true });
      expect(mintSpy).toHaveBeenCalledTimes(2);
      for (const a of minted()) expect(splitInventoryAssertion(a).businessId).toBe(A2.businessId);
      expect((await audits(A2.w1, 'structure.warehouse_branch_associated')).map((r) => r.actor_user_id)).toEqual([split.userId]);
    });

    it('DENY: borrowing A2’s business-wide context for A’s warehouse and branch → 404, nothing minted, nothing in A', async () => {
      const res = await assoc(A2.businessId, A.w1, A.branch2);
      expect(res.status).toBe(404);
      expect(mintSpy).not.toHaveBeenCalled();
      expect((await ownerPool().query(`SELECT 1 FROM branch_warehouses WHERE warehouse_id = $1 AND branch_id = $2`, [A.w1, A.branch2])).rowCount).toBe(0);
    });
  });

  // ── P3-AL-55 row M ─────────────────────────────────────────────────────

  describe('row M — the BUILT-IN manager template, business-wide by default', () => {
    it('ALLOW: associates; the routine-written audit row names the manager, carries the minted jti — which was consumed — and the trace', async () => {
      const res = await t.request.post(`/v1/businesses/current/warehouses/${A.w1}/branches`).set(hdr(manager, A.businessId)).send({ branchId: A.branch2 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ associated: true, changed: true });
      expect(mintSpy).toHaveBeenCalledTimes(1);
      const parts = splitInventoryAssertion(minted()[0] ?? '');
      expect(parts.actorUserId).toBe(manager.userId);
      const rows = await audits(A.w1, 'structure.warehouse_branch_associated');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(manager.userId);
      expect(rows[0]?.metadata).toMatchObject({
        warehouseId: A.w1,
        branchId: A.branch2,
        assertionJti: parts.jti,
        business_transaction_id: res.body.businessTransactionId,
      });
      expect(await use(parts.jti)).toEqual({ op_code: 'structure.associate_warehouse_branch', business_id: A.businessId });
    });

    it('ALLOW: dissociates the same pair; the dissociation audit names the manager with ITS own consumed jti', async () => {
      const res = await t.request.delete(`/v1/businesses/current/warehouses/${A.w1}/branches/${A.branch2}`).set(hdr(manager, A.businessId));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ associated: false, changed: true });
      const parts = splitInventoryAssertion(minted()[0] ?? '');
      const rows = await audits(A.w1, 'structure.warehouse_branch_dissociated');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(manager.userId);
      expect(rows[0]?.metadata).toMatchObject({ assertionJti: parts.jti, business_transaction_id: res.body.businessTransactionId });
      expect(await use(parts.jti)).toEqual({ op_code: 'structure.dissociate_warehouse_branch', business_id: A.businessId });
    });

    it('DENY: the same manager narrowed to an assigned scope — even covering every branch — is refused before the minter', async () => {
      const narrow = await t.request
        .patch(`/v1/businesses/current/members/${manager.userId}/branch-scope`)
        .set(hdr(owner, A.businessId))
        .send({ mode: 'assigned', branchIds: [A.branch1, A.branch2] });
      expect(narrow.status).toBe(200);
      const res = await t.request.post(`/v1/businesses/current/warehouses/${A.w1}/branches`).set(hdr(manager, A.businessId)).send({ branchId: A.branch2 });
      expect(res.status).toBe(403);
      expect(mintSpy).not.toHaveBeenCalled();
    });
  });
});
