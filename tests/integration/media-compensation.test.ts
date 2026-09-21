import { beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { LocalObjectStorage } from '../../apps/api/src/infra/storage';
import { loadConfig } from '../../apps/api/src/config';

/**
 * Gate A §23–24: storage delete() port + media compensation.
 * Upload succeeds in storage but the flow fails afterwards → uploaded objects
 * are deleted best-effort; a delete failure is NEVER silent — an orphan
 * reconciliation record is written to the outbox.
 */
describe('media compensation (Gate A §23–24)', () => {
  let t: TestApp;

  beforeEach(async () => {
    await resetData();
  });

  async function onboardUser(app: TestApp) {
    const reg = await app.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'O', preferredLocale: 'ar',
    });
    const on = await app.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`).set('Authorization', `Bearer ${reg.body.accessToken as string}`).send({
      businessName: 'B', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `mc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });
    return { token: reg.body.accessToken as string, businessId: on.body.businessId as string };
  }

  function baseConfig() {
    return loadConfig({
      NODE_ENV: 'test', APP_DATABASE_URL: 'postgresql://unused:unused@localhost/daftar',
      JWT_SECRET: 'test-secret-key-with-at-least-32-characters!', MEDIA_ROOT: '/tmp/daftar-test-media',
    });
  }

  async function png500(): Promise<Buffer> {
    return sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 10, g: 80, b: 200 } } }).png().toBuffer();
  }

  it('variant upload fails after original succeeded → original object deleted, no media row', async () => {
    const real = new LocalObjectStorage(baseConfig());
    const deleted: string[] = [];
    const puts: string[] = [];
    const flaky = {
      kind: 'test-flaky',
      put: async (key: string, data: Buffer, ct: string) => {
        puts.push(key);
        if (puts.length > 1) throw new Error('storage mid-upload failure');
        void ct; return real.put(key, data);
      },
      get: (key: string) => real.get(key),
      delete: async (key: string) => { deleted.push(key); return real.delete(key); },
      publicUrl: (key: string) => real.publicUrl(key),
      signedUrl: (key: string) => real.signedUrl(key),
      healthCheck: () => Promise.resolve(true),
    };
    t = await createTestApp({ storage: flaky });
    const u = await onboardUser(t);
    const res = await t.request.post('/v1/catalog/media')
      .set('Authorization', `Bearer ${u.token}`).set('X-Business-Id', u.businessId)
      .attach('file', await png500(), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(500);
    expect(puts.length).toBeGreaterThan(1);
    // Every successfully uploaded object was compensated.
    expect(deleted).toEqual([puts[0] as string]);
    const { rows } = await ownerPool().query<{ n: number }>('SELECT count(*)::int AS n FROM media');
    expect(rows[0]?.n).toBe(0);
    // No orphan record needed — cleanup succeeded.
    const { rows: ob } = await ownerPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'media.orphan_cleanup_failed'`,
    );
    expect(ob[0]?.n).toBe(0);
    await t.close();
  });

  it('compensation delete ALSO fails → orphan reconciliation record (never silent)', async () => {
    const puts: string[] = [];
    const failing = {
      kind: 'test-failing',
      put: async (key: string) => {
        puts.push(key);
        if (puts.length > 1) throw new Error('storage mid-upload failure');
      },
      get: () => Promise.reject(new Error('n/a')),
      delete: () => Promise.reject(new Error('delete unavailable')),
      publicUrl: () => 'x',
      signedUrl: () => Promise.resolve('x'),
      healthCheck: () => Promise.resolve(true),
    };
    t = await createTestApp({ storage: failing });
    const u = await onboardUser(t);
    const res = await t.request.post('/v1/catalog/media')
      .set('Authorization', `Bearer ${u.token}`).set('X-Business-Id', u.businessId)
      .attach('file', await png500(), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(500);
    const { rows } = await ownerPool().query<{ payload: { keys: string[] } }>(
      `SELECT payload FROM outbox_events WHERE type = 'media.orphan_cleanup_failed'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.payload.keys).toEqual([puts[0] as string]);
    await t.close();
  });
});
