import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, uniqueEmail, type TestApp } from '../../helpers/test-app';

/**
 * Stabilization Part D/E/N §24–27, §69: Merchant Web ↔ API contract.
 * (1) ONE path convention — the BFF proxy prepends /v1 exactly once; no
 *     page may hand-build a /v1 URL (the double-/v1 bug class).
 * (2) Every endpoint the typed client calls EXISTS on the API.
 */

const WEB_SRC = join(process.cwd(), 'apps/web/src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('golden: web contract', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
  });

  it('P1-GOLD-37 the BFF proxy prepends /v1 exactly once; pages never hand-build /v1 URLs', () => {
    const proxy = readFileSync(join(WEB_SRC, 'app/api/proxy/[...path]/route.ts'), 'utf8');
    // The ONLY place /v1 is added to a browser-facing path.
    expect(proxy).toContain('/v1/${path.join');
    for (const file of walk(join(WEB_SRC, 'app/[locale]'))) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must not contain the double-/v1 pattern`).not.toMatch(/api\/proxy\/v1|\$\{API_URL\}\/v1/);
    }
    // The typed client is the single browser path root and contains no /v1.
    const client = readFileSync(join(WEB_SRC, 'lib/merchant-api.ts'), 'utf8');
    expect(client).not.toMatch(/\$\{BFF\}\/v1|api\/proxy\/v1/);
    expect(client).toContain("const BFF = '/api/proxy'");
  });

  it('P1-GOLD-38 every endpoint the merchant client uses exists on the API', async () => {
    t = await createTestApp();
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'W',
      preferredLocale: 'en',
    });
    const token = (reg.body as { accessToken: string }).accessToken;
    const auth = { Authorization: `Bearer ${token}` };

    // Public reference endpoints used by onboarding.
    expect((await t.request.get('/v1/platform/countries')).status).toBe(200);
    expect((await t.request.get('/v1/platform/currencies')).status).toBe(200);
    expect((await t.request.get('/v1/onboarding/slug-availability?slug=golden-contract').set(auth)).status).toBe(200);

    // Onboard so business-scoped endpoints have a context.
    const onb = await t.request
      .post('/v1/onboarding/complete')
      .set(auth)
      .set('Idempotency-Key', `webc-${Date.now()}`)
      .send({
        businessName: 'Web Contract Co',
        countryCode: 'JO',
        baseCurrency: 'JOD',
        storeSlug: `wc-${Date.now()}`,
        timezone: 'Asia/Amman',
      });
    expect(onb.status).toBe(201);
    const businessId = (onb.body as { businessId: string }).businessId;
    const scoped = { ...auth, 'X-Business-Id': businessId };

    for (const path of [
      '/v1/me/businesses',
      '/v1/businesses/current',
      '/v1/businesses/current/branches',
      '/v1/businesses/current/warehouses',
      '/v1/businesses/current/members',
      '/v1/businesses/current/roles',
      '/v1/businesses/current/invitations',
      '/v1/businesses/current/entitlement',
      '/v1/catalog/products',
      '/v1/catalog/categories',
    ]) {
      const res = await t.request.get(path).set(scoped);
      expect(res.status, `GET ${path} must exist`).toBe(200);
    }

    // §29: the entitlement DTO shape the plan page renders.
    const ent = await t.request.get('/v1/businesses/current/entitlement').set(scoped);
    const body = ent.body as Record<string, unknown>;
    expect(typeof body.planKey).toBe('string');
    expect(typeof body.planVersion).toBe('number');
    expect(Array.isArray(body.features)).toBe(true);
    expect(Array.isArray(body.limits)).toBe(true);
    expect(body).toHaveProperty('effectiveState');
    expect(body).toHaveProperty('trialEndsAt');

    // §32: catalog list items carry name/sku/basePriceMinor — no translations map.
    const prod = await t.request
      .post('/v1/catalog/products')
      .set(scoped)
      .send({ translations: { en: 'Contract Product' }, basePriceMinor: '1250' });
    expect(prod.status, 'create without priceCurrency derives business base currency').toBe(201);
    const list = await t.request.get('/v1/catalog/products').set(scoped);
    const item = (list.body as { items: Record<string, unknown>[] }).items[0];
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('basePriceMinor');
    expect(item).toHaveProperty('priceCurrency', 'JOD');
    expect(item).not.toHaveProperty('translations');

    // §37: a client-sent currency ≠ business base currency is rejected.
    const bad = await t.request
      .post('/v1/catalog/products')
      .set(scoped)
      .send({ translations: { en: 'Wrong Currency' }, basePriceMinor: '100', priceCurrency: 'USD' });
    expect(bad.status).toBe(400);

    // auth/logout-all exists.
    expect([200, 201, 204]).toContain((await t.request.post('/v1/auth/logout-all').set(auth).send({})).status);
  });
});
