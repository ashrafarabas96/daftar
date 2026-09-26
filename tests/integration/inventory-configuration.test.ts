import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createTestApp, grantFeature, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';

/**
 * P3-S1 — the inventory configuration command (P3-AL-03, P3-AL-04, P3-AL-05,
 * P3-AL-54 §E, P3-AL-55 §I), through the real HTTP surface.
 *
 * Every case counts the minter's calls. A refusal that is supposed to happen
 * BEFORE authority is signed is only proven when nothing was minted.
 */
describe('inventory configuration command (P3-S1)', () => {
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

  interface Merchant {
    token: string;
    businessId: string;
    tenantId: string;
    userId: string;
  }

  const auth = (token: string, businessId: string) => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });

  async function register(displayName: string): Promise<{ token: string; userId: string; email: string }> {
    const reg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName, preferredLocale: 'ar' });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken as string;
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    return { token, userId: me.body.userId as string, email: me.body.email as string };
  }

  async function merchant(name: string): Promise<Merchant> {
    const u = await register(name);
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `inv-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${u.token}`)
      .send({ businessName: name, countryCode: 'JO', baseCurrency: 'JOD', storeSlug: `inv-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    expect(on.status).toBe(201);
    const businessId = on.body.businessId as string;
    const tenant = await ownerPool().query<{ tenant_id: string }>('SELECT tenant_id FROM businesses WHERE id = $1', [businessId]);
    return { token: u.token, businessId, tenantId: tenant.rows[0]?.tenant_id ?? '', userId: u.userId };
  }

  async function product(m: Merchant, body: Record<string, unknown> = {}): Promise<string> {
    const res = await t.request
      .post('/v1/catalog/products')
      .set(auth(m.token, m.businessId))
      .send({ translations: { ar: 'قهوة' }, basePriceMinor: '1500', ...body });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  function configure(token: string, businessId: string, productId: string, body: Record<string, unknown>) {
    return t.request.put(`/v1/inventory/products/${productId}/configuration`).set(auth(token, businessId)).send(body);
  }

  async function productRow(productId: string) {
    return (
      await ownerPool().query<{ track_inventory: boolean; unit_code: string | null; unit_decimals: number | null; unit: string | null }>(
        'SELECT track_inventory, unit_code, unit_decimals, unit FROM products WHERE id = $1',
        [productId],
      )
    ).rows[0];
  }

  async function baseVariants(productId: string) {
    return (
      await ownerPool().query<{ id: string; sku: string | null; barcode: string | null; price_minor: string | null; attributes: Record<string, unknown> }>(
        'SELECT id, sku, barcode, price_minor::text, attributes FROM product_variants WHERE product_id = $1 AND is_base',
        [productId],
      )
    ).rows;
  }

  it('enabling tracking creates exactly one base variant with NULL identifiers, and a repeat is idempotent', async () => {
    const m = await merchant('Config Happy');
    const id = await product(m, { sku: 'COF-1', barcode: '6200000000011' });

    const first = await configure(m.token, m.businessId, id, { trackInventory: true, unitCode: 'piece' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ productId: id, trackInventory: true, unitCode: 'piece', unitDecimals: 0 });
    expect(first.body.businessTransactionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0]?.[0]).toMatchObject({
      actorUserId: m.userId,
      tenantId: m.tenantId,
      businessId: m.businessId,
      opCode: 'inventory.configure_product',
    });

    expect(await productRow(id)).toMatchObject({ track_inventory: true, unit_code: 'piece', unit_decimals: 0 });
    const base = await baseVariants(id);
    expect(base).toHaveLength(1);
    expect(base[0]).toMatchObject({ sku: null, barcode: null, price_minor: null, attributes: {} });

    const again = await configure(m.token, m.businessId, id, { trackInventory: true, unitCode: 'piece' });
    expect(again.status).toBe(200);
    expect(mint).toHaveBeenCalledTimes(2);
    // One trace id per user operation, never reused.
    expect(again.body.businessTransactionId).not.toBe(first.body.businessTransactionId);
    const baseAgain = await baseVariants(id);
    expect(baseAgain).toHaveLength(1);
    expect(baseAgain[0]?.id).toBe(base[0]?.id);
  });

  it('the routine writes the audit row with the actor; the application writes no second one', async () => {
    const m = await merchant('Config Audit');
    const id = await product(m);
    expect((await configure(m.token, m.businessId, id, { trackInventory: true, unitCode: 'kg' })).status).toBe(200);
    const rows = (
      await ownerPool().query<{ action: string; actor_user_id: string; business_id: string }>(
        `SELECT action, actor_user_id, business_id FROM audit_events WHERE entity_id = $1 AND action NOT LIKE 'catalog.%'`,
        [id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: m.userId, business_id: m.businessId });
  });

  it('a tracked product needs a canonical unit — refused before anything is minted', async () => {
    const m = await merchant('Config Unitless');
    const id = await product(m);
    const res = await configure(m.token, m.businessId, id, { trackInventory: true });
    expect(res.status).toBe(400);
    expect(res.body.error.details.inventoryCode).toBe('inventory.unit_required');
    expect(mint).not.toHaveBeenCalled();
    expect(await productRow(id)).toMatchObject({ track_inventory: false, unit_code: null, unit_decimals: null });
    expect(await baseVariants(id)).toHaveLength(0);
  });

  it('payload validation: a non-canonical or unknown unit code and out-of-range decimals are refused before minting', async () => {
    const m = await merchant('Config Validation');
    const id = await product(m);
    for (const body of [
      { trackInventory: true, unitCode: 'KG' }, // never case-folded into acceptance
      { trackInventory: true, unitCode: ' kg' },
      { trackInventory: true, unitCode: 'kg', unitDecimals: 5 },
      { trackInventory: true, unitCode: 'kg', unitDecimals: -1 },
      { trackInventory: true, unitCode: 'kg', unitDecimals: 1.5 },
      { trackInventory: 'yes', unitCode: 'kg' },
      // No authority flag can be smuggled in: the schema is strict.
      { trackInventory: true, unitCode: 'kg', trusted: true },
      { trackInventory: true, unitCode: 'kg', businessId: m.businessId },
    ]) {
      const res = await configure(m.token, m.businessId, id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const unknown = await configure(m.token, m.businessId, id, { trackInventory: true, unitCode: 'furlong' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details.inventoryCode).toBe('inventory.unit_unknown');
    const badId = await t.request.put('/v1/inventory/products/not-a-uuid/configuration').set(auth(m.token, m.businessId)).send({ trackInventory: false });
    expect(badId.status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
    expect(await productRow(id)).toMatchObject({ track_inventory: false, unit_code: null });
  });

  it('P3-AL-05 §D row 2: with no movement yet, the canonical unit of a tracked product may still be changed', async () => {
    const m = await merchant('Config Unit Change');
    const id = await product(m);
    expect((await configure(m.token, m.businessId, id, { trackInventory: true, unitCode: 'piece' })).status).toBe(200);

    const toKg = await configure(m.token, m.businessId, id, { trackInventory: true, unitCode: 'kg' });
    expect(toKg.status).toBe(200);
    // A newly selected unit takes the registry default at selection time.
    expect(toKg.body).toMatchObject({ trackInventory: true, unitCode: 'kg', unitDecimals: 3 });

    const decimals = await configure(m.token, m.businessId, id, { trackInventory: true, unitDecimals: 2 });
    expect(decimals.status).toBe(200);
    expect(await productRow(id)).toMatchObject({ track_inventory: true, unit_code: 'kg', unit_decimals: 2 });

    // Unchanged unit, decimals omitted: the persisted value is kept, not re-defaulted.
    const same = await configure(m.token, m.businessId, id, { trackInventory: true, unitCode: 'kg' });
    expect(same.body).toMatchObject({ unitCode: 'kg', unitDecimals: 2 });
    expect(await baseVariants(id)).toHaveLength(1);
  });

  it('disabling tracking keeps the canonical unit on the product', async () => {
    const m = await merchant('Config Disable');
    const id = await product(m);
    expect((await configure(m.token, m.businessId, id, { trackInventory: true, unitCode: 'litre', unitDecimals: 1 })).status).toBe(200);
    const off = await configure(m.token, m.businessId, id, { trackInventory: false });
    expect(off.status).toBe(200);
    expect(await productRow(id)).toMatchObject({ track_inventory: false, unit_code: 'litre', unit_decimals: 1 });
  });

  it('P3-AL-05 §D row 7: the free-text products.unit label may change on a tracked product, and no inventory field moves', async () => {
    const m = await merchant('Config Label');
    const id = await product(m, { unit: 'kg' });
    expect((await configure(m.token, m.businessId, id, { trackInventory: true, unitCode: 'kg' })).status).toBe(200);
    const baseBefore = await baseVariants(id);

    const patch = await t.request.patch(`/v1/catalog/products/${id}`).set(auth(m.token, m.businessId)).send({ unit: 'كغم' });
    expect(patch.status).toBe(200);
    expect(patch.body.unit).toBe('كغم');
    expect(await productRow(id)).toMatchObject({ unit: 'كغم', track_inventory: true, unit_code: 'kg', unit_decimals: 3 });
    expect(await baseVariants(id)).toEqual(baseBefore);

    // Ordinary catalog edits still work on a tracked product (price, SKU, barcode).
    const edit = await t.request
      .patch(`/v1/catalog/products/${id}`)
      .set(auth(m.token, m.businessId))
      .send({ basePriceMinor: '1750', sku: 'KG-1', barcode: '6200000000028' });
    expect(edit.status).toBe(200);
    expect(await productRow(id)).toMatchObject({ track_inventory: true, unit_code: 'kg', unit_decimals: 3 });
  });

  it('a member without inventory.adjust is refused before the minter is reached', async () => {
    const m = await merchant('Config Denied');
    await grantFeature(m.businessId, m.userId, 'CUSTOM_ROLES');
    const id = await product(m);
    const role = await t.request
      .post('/v1/businesses/current/roles')
      .set(auth(m.token, m.businessId))
      .send({ key: 'clerk', name: 'Clerk', permissions: ['catalog.view', 'catalog.update', 'inventory.view'] });
    expect(role.status).toBe(201);
    const clerk = await register('Clerk');
    const add = await t.request.post('/v1/businesses/current/members').set(auth(m.token, m.businessId)).send({ email: clerk.email, roleKey: 'clerk' });
    expect(add.status).toBe(201);

    const res = await configure(clerk.token, m.businessId, id, { trackInventory: true, unitCode: 'piece' });
    expect(res.status).toBe(403);
    expect(mint).not.toHaveBeenCalled();
    expect(await productRow(id)).toMatchObject({ track_inventory: false, unit_code: null });
    expect(await baseVariants(id)).toHaveLength(0);
  });

  it("DENY: tenant A cannot configure tenant B's product, even holding B's UUIDs", async () => {
    const a = await merchant('Tenant A');
    const b = await merchant('Tenant B');
    const bProduct = await product(b);

    // A's own business context, B's product id: invisible under RLS.
    const viaOwnBusiness = await configure(a.token, a.businessId, bProduct, { trackInventory: true, unitCode: 'piece' });
    expect(viaOwnBusiness.status).toBe(404);
    // B's business context: A is not a member of it.
    const viaForeignBusiness = await configure(a.token, b.businessId, bProduct, { trackInventory: true, unitCode: 'piece' });
    expect(viaForeignBusiness.status).toBe(403);

    expect(mint).not.toHaveBeenCalled();
    expect(await productRow(bProduct)).toMatchObject({ track_inventory: false, unit_code: null });
    expect(await baseVariants(bProduct)).toHaveLength(0);
  });

  it('an uppercase product id is canonicalized, so the signed payload matches what the routine rebuilds', async () => {
    const m = await merchant('Config Case');
    const id = await product(m);
    const res = await configure(m.token, m.businessId, id.toUpperCase(), { trackInventory: true, unitCode: 'box' });
    expect(res.status).toBe(200);
    expect(res.body.productId).toBe(id);
    expect(await productRow(id)).toMatchObject({ track_inventory: true, unit_code: 'box' });
  });
});
