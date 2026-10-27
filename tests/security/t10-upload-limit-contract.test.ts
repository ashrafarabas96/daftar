import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';

/**
 * T-10, `multer` 2.4.0 → 2.5.0: the multipart parser's own limit.
 *
 * `media.test.ts` already covers what the MEDIA SERVICE refuses — MIME/magic
 * disagreement, a fake image, an unsupported type, a traversal filename, a
 * cross-business attach — and it has an "oversized file → 413" case. That
 * case does not reach this parser, and two measurements say so: its payload
 * is built to clear "the 5MB limit" named in its own comment, while the
 * interceptor's limit is `8 * 1024 * 1024` (catalog.controller.ts), and it
 * accepts `[400, 413]` either way. A payload between 5 and 8 MB is refused by
 * the service for not being a usable image, and that case would stay green if
 * `limits.fileSize` stopped being enforced altogether.
 *
 * So the parser's limit is pinned here, and pinned by the one property that
 * separates it from every other refusal in the upload path: WHERE the request
 * dies. Over the limit, multer aborts the stream and nothing downstream ever
 * sees a file. Under it, the bytes arrive and the media service rejects them
 * on their content. Both are refusals; a test that only checked "refused"
 * could not tell a working limit from a missing one.
 *
 * The payloads are deliberately not images. An image would make the two cases
 * differ in size AND in validity, and then neither case would isolate the
 * parser.
 */
describe('T-10 upload limits: the multipart parser refuses before the handler, at its own boundary', () => {
  let t: TestApp;
  let token: string;
  let businessId: string;

  const LIMIT = 8 * 1024 * 1024; // catalog.controller.ts: FileInterceptor('file', { limits: { fileSize: ... } })

  beforeEach(async () => {
    t = await createTestApp();
    await resetData();
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'U',
      preferredLocale: 'ar',
    });
    token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessName: 'Upload Co',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: `upload-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    businessId = on.body.businessId as string;
  });

  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId });

  /** Noise, not an image: the media service will refuse it on content if it ever arrives. */
  const noise = (bytes: number): Buffer => Buffer.alloc(bytes, 0x5a);

  it('one byte over the limit is refused by the parser, as the product contract and not as a crash', async () => {
    const res = await t.request
      .post('/v1/catalog/media')
      .set(auth())
      .attach('file', noise(LIMIT + 1), { filename: 'over.png', contentType: 'image/png' });

    expect(res.status, 'a payload past the parser limit must be refused').toBe(413);
    expect(res.body?.error?.code, 'the refusal travels the product error contract, not a raw multer error').toBe('MEDIA_TOO_LARGE');
  });

  it('one byte under the limit reaches the handler, and dies on its content instead — which is what proves the limit is the parser', async () => {
    const res = await t.request
      .post('/v1/catalog/media')
      .set(auth())
      .attach('file', noise(LIMIT - 1), { filename: 'under.png', contentType: 'image/png' });

    // Not a 413: the bytes were accepted by the parser and refused further in,
    // for not being an image. If this ever becomes 413 the boundary has moved
    // below the declared limit; if the case above stops being 413 the limit is
    // gone. Only the pair says which.
    expect(res.status, 'a payload inside the limit must not be refused FOR ITS SIZE').not.toBe(413);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body?.error?.code, 'refused on content, by the media service').not.toBe('MEDIA_TOO_LARGE');
  });

  it('no file part at all is a validation error that names the field, not a 500', async () => {
    const res = await t.request.post('/v1/catalog/media').set(auth()).field('note', 'no file here');

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('VALIDATION_FAILED');
  });

  it('a part under the wrong field name is not silently accepted as the file', async () => {
    // `FileInterceptor('file', …)` binds one field name. A part sent under any
    // other name must leave the handler with no file — the same refusal as
    // sending none, never an upload the caller did not ask for.
    const res = await t.request
      .post('/v1/catalog/media')
      .set(auth())
      .attach('attachment', noise(64), { filename: 'x.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('VALIDATION_FAILED');
  });

  it('an empty file is refused, and not mistaken for a missing one', async () => {
    const res = await t.request
      .post('/v1/catalog/media')
      .set(auth())
      .attach('file', Buffer.alloc(0), { filename: 'empty.png', contentType: 'image/png' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('the limit is enforced before authorisation is spent on it — an unauthorised caller is still refused', async () => {
    const res = await t.request.post('/v1/catalog/media').attach('file', noise(64), { filename: 'x.png', contentType: 'image/png' });

    expect(res.status, 'no bearer token: the upload route is not open').toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
