import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createTestApp, ownerPool, raiseLimit, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * Directive §69 — performance baseline. Not a load test: a repeatable
 * single-process measurement of the hot Phase 1 endpoints against the
 * in-process API + embedded PostgreSQL, so regressions show up as numbers.
 *
 * Run: npm run perf:baseline  (writes PERF_BASELINE_OUT if set, default
 * prints the table). Thresholds are deliberately generous (p95 < 750 ms on
 * a cold CI box) — the value is the recorded table, not the assertion.
 */
const ITERATIONS = Number(process.env['PERF_ITERATIONS'] ?? 60);
const P95_BUDGET_MS = 750;

interface Sample {
  name: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  meanMs: number;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function measure(name: string, n: number, fn: () => Promise<void>): Promise<Sample> {
  const times: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const started = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    name,
    n,
    p50: Math.round(pct(sorted, 50) * 10) / 10,
    p95: Math.round(pct(sorted, 95) * 10) / 10,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
    meanMs: Math.round((times.reduce((a, b) => a + b, 0) / n) * 10) / 10,
  };
}

describe('phase 1 performance baseline (§69)', () => {
  let t: TestApp;
  const samples: Sample[] = [];
  const email = uniqueEmail();
  const password = 'Str0ng!Passw0rd';
  let token = '';
  let businessId = '';
  let platformToken = '';

  beforeAll(async () => {
    t = await createTestApp();
    await resetData();
    const reg = await t.request.post('/v1/auth/register').send({ email, password, displayName: 'Perf', preferredLocale: 'ar' });
    token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `perf-${Date.now()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'Perf', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `perf-${Date.now()}` });
    businessId = on.body.businessId as string;
    const owner = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
    // The free plan caps MAX_PRODUCTS at 100; the baseline needs a page above the default size.
    await raiseLimit(businessId, owner.body.userId as string, 'MAX_PRODUCTS', 10_000);
    // Seed a realistic catalog page: 120 products (above the default page size).
    for (let i = 0; i < 120; i += 1) {
      const res = await t.request
        .post('/v1/catalog/products')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Business-Id', businessId)
        .send({ translations: { ar: `منتج ${i}`, en: `Product ${i}` }, basePriceMinor: String(1000 + i), priceCurrency: 'ILS', sku: `PERF-${i}` });
      if (res.status !== 201) throw new Error(`seed failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const preg = await t.request.post('/v1/auth/register').send({ email: uniqueEmail(), password, displayName: 'P', preferredLocale: 'en' });
    const me = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${preg.body.accessToken as string}`);
    await ownerPool().query(`INSERT INTO platform_role_memberships (user_id, role_key) VALUES ($1, 'platform_owner')`, [me.body.userId as string]);
    platformToken = preg.body.accessToken as string;
  }, 300_000);

  afterAll(() => {
    const lines = ['| endpoint | n | p50 ms | p95 ms | max ms | mean ms |', '|---|---:|---:|---:|---:|---:|'];
    for (const s of samples) lines.push(`| ${s.name} | ${s.n} | ${s.p50} | ${s.p95} | ${s.max} | ${s.meanMs} |`);
    const table = lines.join('\n');
    console.log(`\nPERF BASELINE (node ${process.versions.node}, iterations=${ITERATIONS})\n${table}\n`);
    const out = process.env['PERF_BASELINE_OUT'];
    if (out)
      writeFileSync(
        out,
        JSON.stringify({ generatedAt: new Date().toISOString(), node: process.versions.node, iterations: ITERATIONS, samples }, null, 2) + '\n',
      );
  });

  const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });

  it('login (argon2id verify + token issue)', async () => {
    // 8 iterations: the per-IP+account limiter allows 10 attempts per window (auth-abuse.test.ts) — the
    // baseline must measure the hash, not the limiter.
    const s = await measure('POST /v1/auth/login', Math.min(ITERATIONS, 8), async () => {
      const r = await t.request.post('/v1/auth/login').send({ email, password });
      expect(r.status).toBe(201);
    });
    samples.push(s);
    // argon2id at 19 MiB / t=3 is intentionally ~100–300 ms; the budget is 3× the generic one.
    expect(s.p95).toBeLessThan(P95_BUDGET_MS * 3);
  });

  it('GET /v1/auth/me (JWT verify + identity read)', async () => {
    const s = await measure('GET /v1/auth/me', ITERATIONS, async () => {
      const r = await t.request.get('/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(r.status).toBe(200);
    });
    samples.push(s);
    expect(s.p95).toBeLessThan(P95_BUDGET_MS);
  });

  it('GET /v1/catalog/products?limit=50 (RLS + translations join, 120 rows seeded)', async () => {
    const s = await measure('GET /v1/catalog/products?limit=50', ITERATIONS, async () => {
      const r = await t.request.get('/v1/catalog/products?limit=50').set(auth());
      expect(r.status).toBe(200);
      expect((r.body.items as unknown[]).length).toBe(50);
    });
    samples.push(s);
    expect(s.p95).toBeLessThan(P95_BUDGET_MS);
  });

  it('GET /v1/catalog/products?q=Product 7 (search over translation rows)', async () => {
    const s = await measure('GET /v1/catalog/products?q=', ITERATIONS, async () => {
      const r = await t.request.get('/v1/catalog/products?q=Product%207').set(auth());
      expect(r.status).toBe(200);
    });
    samples.push(s);
    expect(s.p95).toBeLessThan(P95_BUDGET_MS);
  });

  it('POST /v1/catalog/products (write: translations + identifier registry + audit + outbox)', async () => {
    let i = 0;
    const s = await measure('POST /v1/catalog/products', ITERATIONS, async () => {
      i += 1;
      const r = await t.request
        .post('/v1/catalog/products')
        .set(auth())
        .send({ translations: { ar: `كتابة ${i}`, en: `Write ${i}` }, basePriceMinor: '500', priceCurrency: 'ILS', sku: `PERF-W-${i}` });
      expect(r.status).toBe(201);
    });
    samples.push(s);
    expect(s.p95).toBeLessThan(P95_BUDGET_MS);
  });

  it('GET /v1/businesses/current/entitlement (effective state + usage counters)', async () => {
    const s = await measure('GET /v1/businesses/current/entitlement', ITERATIONS, async () => {
      const r = await t.request.get('/v1/businesses/current/entitlement').set(auth());
      expect(r.status).toBe(200);
    });
    samples.push(s);
    expect(s.p95).toBeLessThan(P95_BUDGET_MS);
  });

  it('GET /v1/businesses/current/members (team screen)', async () => {
    const s = await measure('GET /v1/businesses/current/members', ITERATIONS, async () => {
      const r = await t.request.get('/v1/businesses/current/members').set(auth());
      expect(r.status).toBe(200);
    });
    samples.push(s);
    expect(s.p95).toBeLessThan(P95_BUDGET_MS);
  });

  it('GET /v1/admin/tenants (platform console list)', async () => {
    const s = await measure('GET /v1/admin/tenants', ITERATIONS, async () => {
      const r = await t.request.get('/v1/admin/tenants').set('Authorization', `Bearer ${platformToken}`);
      expect(r.status).toBe(200);
    });
    samples.push(s);
    expect(s.p95).toBeLessThan(P95_BUDGET_MS);
  });
});
