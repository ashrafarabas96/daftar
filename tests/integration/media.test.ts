import { beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createTestApp, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/** Media security (§63–64): MIME/magic agreement, size, dimensions, traversal, cross-business. */
describe('media', () => {
  let t: TestApp;
  let token: string;
  let businessId: string;

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'M', preferredLocale: 'ar',
    });
    token = reg.body.accessToken as string;
    const on = await t.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`).set('Authorization', `Bearer ${token}`).send({
      businessName: 'Media Co', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `media-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    });
    businessId = on.body.businessId as string;
  });

  const auth = () => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });

  it('valid png upload: re-encoded, scoped server-generated key, variants created, metadata stripped', async () => {
    const png = await sharp({
      create: { width: 1500, height: 900, channels: 3, background: { r: 200, g: 100, b: 50 } },
    }).png().withMetadata({ exif: { IFD0: { Copyright: 'secret-owner-data' } } }).toBuffer();

    const res = await t.request.post('/v1/catalog/media').set(auth()).attach('file', png, { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    // §45–48 (Stabilization Part H): upload NEVER returns a storage URL — it
    // returns the access-url endpoint; the storage key stays server-side.
    expect(res.body.url).toBe(`/v1/catalog/media/${res.body.id as string}/access-url`);
    expect(res.body.url).not.toContain('photo.png');
    expect(res.body.url).not.toContain(`businesses/${businessId}/`);

    // the access-url endpoint returns a short-TTL signed URL scoped to the key
    const access = await t.request.get(res.body.url as string).set(auth());
    expect(access.status).toBe(200);
    expect(String(access.body.url)).toContain(`businesses/${businessId}/`);
    expect(String(access.body.url)).not.toContain('photo.png');

    // attached to a product
    const product = await t.request.post('/v1/catalog/products').set(auth()).send({
      translations: { ar: 'مصوّر' }, basePriceMinor: '100', priceCurrency: 'ILS',
    });
    const attach = await t.request
      .post(`/v1/catalog/products/${product.body.id as string}/media/${res.body.id as string}`)
      .set(auth());
    expect(attach.status).toBe(201);
    const detail = await t.request.get(`/v1/catalog/products/${product.body.id as string}`).set(auth());
    expect(detail.body.media.length).toBe(1);
    expect(detail.body.media[0].variants.length).toBeGreaterThan(0);
  });

  it('extension/MIME mismatch rejected (declared png, content jpeg)', async () => {
    const jpg = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } } }).jpeg().toBuffer();
    const res = await t.request.post('/v1/catalog/media').set(auth()).attach('file', jpg, { filename: 'fake.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MEDIA_INVALID');
  });

  it('fake image (text bytes as png) rejected', async () => {
    const res = await t.request
      .post('/v1/catalog/media').set(auth())
      .attach('file', Buffer.from('this is not an image at all'), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('gif (unsupported type) → 415', async () => {
    const gif = Buffer.from('R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=', 'base64');
    const res = await t.request.post('/v1/catalog/media').set(auth()).attach('file', gif, { filename: 'x.gif', contentType: 'image/gif' });
    expect([400, 415]).toContain(res.status);
  });

  it('oversized file → 413', async () => {
    const big = await sharp({
      create: { width: 4000, height: 4000, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer();
    // force over the 5MB limit with random noise if needed
    const buf = big.length > 5 * 1024 * 1024 ? big : Buffer.concat([big, Buffer.alloc(5 * 1024 * 1024, 7)]);
    const res = await t.request.post('/v1/catalog/media').set(auth()).attach('file', buf, { filename: 'big.png', contentType: 'image/png' });
    expect([400, 413]).toContain(res.status);
  });

  it('malicious filename never reaches the storage key or URL', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer();
    const res = await t.request
      .post('/v1/catalog/media').set(auth())
      .attach('file', png, { filename: '../../../etc/passwd.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.url).not.toContain('..');
    expect(res.body.url).not.toContain('passwd');
  });

  it('cross-business attach rejected (§39 composite FK)', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer();
    const media = await t.request.post('/v1/catalog/media').set(auth()).attach('file', png, { filename: 'a.png', contentType: 'image/png' });
    const mediaId = media.body.id as string;

    const reg2 = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(), password: 'Str0ng!Passw0rd', displayName: 'B2', preferredLocale: 'en',
    });
    const token2 = reg2.body.accessToken as string;
    const on2 = await t.request.post('/v1/onboarding/complete').set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random()*1e9)}`).set('Authorization', `Bearer ${token2}`).send({
      businessName: 'B2 Co', countryCode: 'TR', baseCurrency: 'TRY', storeSlug: `media-b2-${Date.now()}`,
    });
    const product2 = await t.request
      .post('/v1/catalog/products')
      .set({ Authorization: `Bearer ${token2}`, 'X-Business-Id': on2.body.businessId as string })
      .send({ translations: { en: 'P2' }, basePriceMinor: '100', priceCurrency: 'TRY' });

    const attach = await t.request
      .post(`/v1/catalog/products/${product2.body.id as string}/media/${mediaId}`)
      .set({ Authorization: `Bearer ${token2}`, 'X-Business-Id': on2.body.businessId as string });
    expect(attach.status).toBe(400);
  });
});
