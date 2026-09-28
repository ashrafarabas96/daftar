/**
 * PHASE 3 CORRECTIVE — `GET /v1/inventory/access` ANSWERS `openingPosted`.
 *
 * The opening screen needs to know, before it offers the form, whether the
 * business already holds a posted inventory opening (the command refuses a
 * second one with `inventory.opening_already_posted`). `openingPosted` is
 * exactly that predicate — `EXISTS (inventory_openings WHERE business_id =
 * <caller's business> AND status = 'posted')`, the one postedOpeningExists()
 * and 0062 use — read under the caller's X-Business-Id membership. It is a
 * boolean and nothing else: no quantity, no value, no opening id.
 *
 *   A   posted opening           → true
 *   A2  same owner, same tenant  → false (its own business, not A's)
 *   B   another tenant           → false; B's owner naming A is refused
 *   a draft (unposted) opening is not a posted one → false
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHASE3_PERMISSIONS } from '@daftar/shared-contracts';
import { asMember, must, onboardS3Business, openingCommand, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { runOpening } from '../helpers/inventory-posting';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';

let t: TestApp;
let owner: HttpActor;
let ownerB: HttpActor;
let A: S3Business;
let A2: S3Business;
let B: S3Business;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'Access Owner');
  ownerB = await registerActor(t, 'Access Owner B');
  A = await onboardS3Business(t, owner, 'acc-a');
  A2 = await onboardS3Business(t, owner, 'acc-a2', A.tenantId);
  B = await onboardS3Business(t, ownerB, 'acc-b');
  const day = await today();
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    await runOpening(c, A, openingCommand(day, [{ warehouseId: A.w1, variantId: A.piece.variantId, qty: '3', unitCost: '2' }]));
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}, 300_000);

afterAll(async () => {
  await t?.close();
  await resetData();
});

const access = async (by: HttpActor, businessId: string): Promise<{ status: number; body: unknown }> => {
  const r = await t.request.get('/v1/inventory/access').set(asMember(by, businessId));
  return { status: r.status, body: r.body };
};

describe('openingPosted on GET /v1/inventory/access', () => {
  it('the fixture: A holds exactly one posted opening, A2 and B none', async () => {
    const r = await ownerPool().query<{ b: string; n: number }>(
      `SELECT business_id::text AS b, count(*)::int AS n FROM inventory_openings WHERE status = 'posted' AND business_id = ANY($1::uuid[]) GROUP BY 1`,
      [[A.businessId, A2.businessId, B.businessId]],
    );
    expect(r.rows).toEqual([{ b: A.businessId, n: 1 }]);
  });

  it('A with a posted opening reads true; the answer holds only the scope, the grants and the flag', async () => {
    const r = await access(owner, A.businessId);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ businessWide: true, openingPosted: true, permissions: [...PHASE3_PERMISSIONS] });
  });

  it('ALLOW same-owner second business: A2 reads false — its own business, not A’s', async () => {
    const r = await access(owner, A2.businessId);
    expect(r.status).toBe(200);
    expect(must(r.body as { openingPosted?: boolean }).openingPosted).toBe(false);
  });

  it('another tenant: B reads false for itself, and B’s owner cannot read A at all', async () => {
    const own = await access(ownerB, B.businessId);
    expect(own.status).toBe(200);
    expect((own.body as { openingPosted?: boolean }).openingPosted).toBe(false);
    const cross = await access(ownerB, A.businessId);
    expect(cross.status).toBe(403);
    expect(JSON.stringify(cross.body)).not.toContain('openingPosted');
  });

  it('DENY the same owner naming A2 while holding A’s posted opening does not leak it: each business answers for itself', async () => {
    const [a, a2] = await Promise.all([access(owner, A.businessId), access(owner, A2.businessId)]);
    expect([(a.body as { openingPosted: boolean }).openingPosted, (a2.body as { openingPosted: boolean }).openingPosted]).toEqual([true, false]);
  });

  it('the answer’s keys are exactly the scope, the flag and the grants: no quantity, value or opening id', async () => {
    const r = await access(owner, A.businessId);
    const body = r.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['businessWide', 'openingPosted', 'permissions']);
    expect(typeof body['openingPosted']).toBe('boolean');
  });
});
