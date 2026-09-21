import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, grantFeature, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * §32–37 / WAVE 6 — Branch scopes actually AUTHORIZE:
 * MembershipContext carries scopeMode + allowedBranchIds; assigned-scope
 * members see only their branches/warehouses, cannot create warehouses in
 * unassigned branches, and cannot create branches (business-wide action).
 * Matrix: ALL_BUSINESS / one assigned / several assigned / none / archived.
 */
describe('branch scope enforcement (§32–37)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
  });

  function auth(token: string, businessId: string) {
    return { Authorization: `Bearer ${token}`, 'X-Business-Id': businessId };
  }

  interface Ctx {
    owner: { token: string; businessId: string; userId: string };
    scoped: { token: string; userId: string };
    branch1: string;
    branch2: string;
  }

  async function setup(): Promise<Ctx> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Owner', preferredLocale: 'ar',
    });
    const ownerToken = reg.body.accessToken as string;
    const on = await t.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`).set('Authorization', `Bearer ${ownerToken}`).send({
      businessName: 'Branch Biz', countryCode: 'PS', baseCurrency: 'ILS',
      storeSlug: `br-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });
    const businessId = on.body.businessId as string;
    const ownerId = (
      await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${ownerToken}`)
    ).body.userId as string;

    // Free plan: MULTI_BRANCH off + 1 branch — fixture overrides both.
    await grantFeature(businessId, ownerId, 'MULTI_BRANCH');
    await grantFeature(businessId, ownerId, 'CUSTOM_ROLES');
    await ownerPool().query(
      `INSERT INTO entitlement_overrides (business_id, limit_key, limit_value, reason, actor_user_id)
       VALUES ($1, 'MAX_BRANCHES', 10, 'branch-scope-test', $2)`,
      [businessId, ownerId],
    );

    const branches = (
      await t.request.get('/v1/businesses/current/branches').set(auth(ownerToken, businessId))
    ).body.items as { id: string }[];
    const branch1 = branches[0]?.id ?? '';
    const b2 = await t.request.post('/v1/businesses/current/branches').set(auth(ownerToken, businessId)).send({ name: 'Second' });
    expect(b2.status).toBe(201);
    const branch2 = b2.body.id as string;

    // A warehouse in each branch.
    const w1 = await t.request.post('/v1/businesses/current/warehouses').set(auth(ownerToken, businessId)).send({ name: 'W1', branchId: branch1 });
    const w2 = await t.request.post('/v1/businesses/current/warehouses').set(auth(ownerToken, businessId)).send({ name: 'W2', branchId: branch2 });
    expect(w1.status).toBe(201);
    expect(w2.status).toBe(201);

    // Scoped member: branch/warehouse permissions but no business-wide power.
    const role = await t.request.post('/v1/businesses/current/roles').set(auth(ownerToken, businessId)).send({
      key: 'scoped', name: 'Scoped',
      permissions: ['branch.view', 'warehouse.view', 'warehouse.manage', 'member.view'],
    });
    expect(role.status).toBe(201);
    const regB = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'Scoped', preferredLocale: 'ar',
    });
    const scopedToken = regB.body.accessToken as string;
    const scopedEmail = (
      await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${scopedToken}`)
    ).body.email as string;
    const scopedId = (
      await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${scopedToken}`)
    ).body.userId as string;
    const add = await t.request.post('/v1/businesses/current/members').set(auth(ownerToken, businessId)).send({
      email: scopedEmail, roleKey: 'scoped',
    });
    expect(add.status).toBe(201);

    return {
      owner: { token: ownerToken, businessId, userId: ownerId },
      scoped: { token: scopedToken, userId: scopedId },
      branch1, branch2,
    };
  }

  async function setScope(c: Ctx, mode: 'all' | 'assigned', branchIds: string[]) {
    return t.request
      .patch(`/v1/businesses/current/members/${c.scoped.userId}/branch-scope`)
      .set(auth(c.owner.token, c.owner.businessId))
      .send({ mode, branchIds });
  }

  async function branchesOf(token: string, businessId: string): Promise<string[]> {
    const res = await t.request.get('/v1/businesses/current/branches').set(auth(token, businessId));
    expect(res.status).toBe(200);
    return (res.body.items as { id: string }[]).map((b) => b.id).sort();
  }

  async function warehouseBranchesOf(token: string, businessId: string): Promise<string[]> {
    const res = await t.request.get('/v1/businesses/current/warehouses').set(auth(token, businessId));
    expect(res.status).toBe(200);
    return [...new Set((res.body.items as { branchId: string }[]).map((w) => w.branchId))].sort();
  }

  it('ALL_BUSINESS mode: sees every branch and warehouse (default)', async () => {
    const c = await setup();
    expect(await branchesOf(c.scoped.token, c.owner.businessId)).toEqual([c.branch1, c.branch2].sort());
    expect(await warehouseBranchesOf(c.scoped.token, c.owner.businessId)).toEqual([c.branch1, c.branch2].sort());
  });

  it('one assigned branch: lists only that branch and its warehouses', async () => {
    const c = await setup();
    const res = await setScope(c, 'assigned', [c.branch1]);
    expect(res.status).toBe(200);
    expect(await branchesOf(c.scoped.token, c.owner.businessId)).toEqual([c.branch1]);
    expect(await warehouseBranchesOf(c.scoped.token, c.owner.businessId)).toEqual([c.branch1]);
  });

  it('several assigned branches: sees exactly the assigned set', async () => {
    const c = await setup();
    expect((await setScope(c, 'assigned', [c.branch1, c.branch2])).status).toBe(200);
    expect(await branchesOf(c.scoped.token, c.owner.businessId)).toEqual([c.branch1, c.branch2].sort());
    expect(await warehouseBranchesOf(c.scoped.token, c.owner.businessId)).toEqual([c.branch1, c.branch2].sort());
  });

  it('assigned mode with ZERO branches: sees nothing, creates nothing', async () => {
    const c = await setup();
    expect((await setScope(c, 'assigned', [])).status).toBe(200);
    expect(await branchesOf(c.scoped.token, c.owner.businessId)).toEqual([]);
    expect(await warehouseBranchesOf(c.scoped.token, c.owner.businessId)).toEqual([]);
    const create = await t.request
      .post('/v1/businesses/current/warehouses')
      .set(auth(c.scoped.token, c.owner.businessId))
      .send({ name: 'Nope', branchId: c.branch1 });
    expect(create.status).toBe(403);
  });

  it('assigned user cannot create a warehouse in an unassigned branch (403)', async () => {
    const c = await setup();
    expect((await setScope(c, 'assigned', [c.branch1])).status).toBe(200);
    const denied = await t.request
      .post('/v1/businesses/current/warehouses')
      .set(auth(c.scoped.token, c.owner.businessId))
      .send({ name: 'Sneaky', branchId: c.branch2 });
    expect(denied.status).toBe(403);
    const allowed = await t.request
      .post('/v1/businesses/current/warehouses')
      .set(auth(c.scoped.token, c.owner.businessId))
      .send({ name: 'Fine', branchId: c.branch1 });
    expect(allowed.status).toBe(201);
  });

  it('assigned user cannot create a branch (business-wide action)', async () => {
    const c = await setup();
    expect((await setScope(c, 'assigned', [c.branch1])).status).toBe(200);
    const res = await t.request
      .post('/v1/businesses/current/branches')
      .set(auth(c.scoped.token, c.owner.businessId))
      .send({ name: 'Self-service branch' });
    expect(res.status).toBe(403);
  });

  it('archived assigned branch disappears from scope; warehouse creation rejected', async () => {
    const c = await setup();
    expect((await setScope(c, 'assigned', [c.branch2])).status).toBe(200);
    await ownerPool().query(
      `UPDATE branches SET status = 'archived' WHERE business_id = $1 AND id = $2`,
      [c.owner.businessId, c.branch2],
    );
    expect(await branchesOf(c.scoped.token, c.owner.businessId)).toEqual([]);
    expect(await warehouseBranchesOf(c.scoped.token, c.owner.businessId)).toEqual([]);
    const res = await t.request
      .post('/v1/businesses/current/warehouses')
      .set(auth(c.scoped.token, c.owner.businessId))
      .send({ name: 'Into archived', branchId: c.branch2 });
    expect([400, 403]).toContain(res.status);
  });

  it('scope assignment validates branches (archived/foreign rejected) and is audited', async () => {
    const c = await setup();
    const bogus = await setScope(c, 'assigned', ['00000000-0000-0000-0000-000000000000']);
    expect(bogus.status).toBe(400);
    expect((await setScope(c, 'assigned', [c.branch1])).status).toBe(200);
    const audit = await ownerPool().query(
      `SELECT action, metadata FROM audit_events WHERE action = 'structure.member_branch_scope_changed' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.action).toBe('structure.member_branch_scope_changed');
    expect((audit.rows[0]?.metadata as { branchIds?: string[] }).branchIds).toEqual([c.branch1]);
  });

  it('switching back to ALL_BUSINESS restores full visibility', async () => {
    const c = await setup();
    expect((await setScope(c, 'assigned', [c.branch1])).status).toBe(200);
    expect(await branchesOf(c.scoped.token, c.owner.businessId)).toEqual([c.branch1]);
    expect((await setScope(c, 'all', [])).status).toBe(200);
    expect(await branchesOf(c.scoped.token, c.owner.businessId)).toEqual([c.branch1, c.branch2].sort());
  });

  it('listMembers exposes branch scope for the team screen', async () => {
    const c = await setup();
    expect((await setScope(c, 'assigned', [c.branch1])).status).toBe(200);
    const res = await t.request.get('/v1/businesses/current/members').set(auth(c.owner.token, c.owner.businessId));
    const scoped = (res.body.items as { userId: string; branchScopeMode: string; allowedBranchIds: string[] }[])
      .find((x) => x.userId === c.scoped.userId);
    expect(scoped?.branchScopeMode).toBe('assigned');
    expect(scoped?.allowedBranchIds).toEqual([c.branch1]);
    const ownerRow = (res.body.items as { userId: string; branchScopeMode: string }[])
      .find((x) => x.userId === c.owner.userId);
    expect(ownerRow?.branchScopeMode).toBe('all');
  });
});
