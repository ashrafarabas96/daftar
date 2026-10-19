import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import sharp from 'sharp';
import { createTestApp, ownerPool, resetData, uniqueEmail } from '../helpers/test-app';
import { DisabledDevelopmentMalwareScanner, type MalwareScanner, type ObjectStorage } from '../../apps/api/src/infra/storage';
import {
  FakeCleanDisabledMalwareScanner,
  HangingMalwareScanner,
  StubCleanMalwareScanner,
  StubInfectedMalwareScanner,
  StubUnavailableMalwareScanner,
  ThrowingMalwareScanner,
  UnreadableVerdictMalwareScanner,
} from '../helpers/malware-scanner';

/**
 * FAIL-CLOSED upload scanning (owner ruling, 2026-10-12).
 *
 * An upload that requires a security scan is REFUSED when the scanner is
 * disabled, unavailable, failing, or cannot produce a trustworthy result —
 * and nothing is stored on the refused path, so no restart can later treat an
 * unscanned file as accepted.
 *
 * Every case here asserts the refusal BY NAME (error code + status) and asserts
 * the ABSENCE of side effects (no media row, no object written). Deleting the
 * `assertScannedClean()` call in MediaService.upload turns all six refusal
 * cases red.
 */
describe('media upload fails closed without a trustworthy scan verdict', () => {
  const recordingStorage = (): { storage: ObjectStorage; puts: string[] } => {
    const puts: string[] = [];
    const storage: ObjectStorage = {
      kind: 'test-recording',
      put: (key: string) => {
        puts.push(key);
        return Promise.resolve();
      },
      get: () => Promise.resolve(Buffer.alloc(0)),
      delete: () => Promise.resolve(),
      publicUrl: (key: string) => `/media/${key}`,
      signedUrl: (key: string) => Promise.resolve(`/media/${key}?sig=test`),
      healthCheck: () => Promise.resolve(true),
    };
    return { storage, puts };
  };

  let png: Buffer;

  beforeEach(async () => {
    await resetData();
    png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 20, g: 120, b: 90 } } })
      .png()
      .toBuffer();
  });

  async function appWith(scanner: MalwareScanner, configOverrides?: Record<string, string>) {
    const { storage, puts } = recordingStorage();
    const t = await createTestApp({ scanner, storage, ...(configOverrides ? { configOverrides } : {}) });
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'S',
      preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessName: 'Scan Co',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: `scan-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    const businessId = on.body.businessId as string;
    const upload = (): Promise<{ status: number; body: { id?: string; error?: { code?: string } } }> =>
      t.request
        .post('/v1/catalog/media')
        .set({ Authorization: `Bearer ${token}`, 'X-Business-Id': businessId })
        .attach('file', png, { filename: 'photo.png', contentType: 'image/png' })
        .then((r) => ({ status: r.status, body: r.body as { id?: string; error?: { code?: string } } }));
    return { t, upload, puts, businessId };
  }

  async function mediaRowCount(businessId: string): Promise<number> {
    const r = await ownerPool().query<{ n: string }>('SELECT count(*)::text AS n FROM media WHERE business_id = $1', [businessId]);
    return Number(r.rows[0]?.n ?? '-1');
  }

  it('DISABLED scanner (the adapter dev/test actually composes) → 503 MEDIA_SCAN_UNAVAILABLE, nothing stored', async () => {
    const { upload, puts, businessId } = await appWith(new DisabledDevelopmentMalwareScanner());
    const res = await upload();
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('MEDIA_SCAN_UNAVAILABLE');
    expect(puts).toEqual([]);
    expect(await mediaRowCount(businessId)).toBe(0);
  });

  it('scanner reports INFECTED → 422 MEDIA_INFECTED, nothing stored', async () => {
    const { upload, puts, businessId } = await appWith(new StubInfectedMalwareScanner('Daftar-Test-Signature'));
    const res = await upload();
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('MEDIA_INFECTED');
    expect(puts).toEqual([]);
    expect(await mediaRowCount(businessId)).toBe(0);
  });

  it('an INFECTED signature cannot forge a log record: the peer-chosen text is escaped', async () => {
    // The signature is whatever answered on the scanner address, so it is
    // attacker-shaped input on its way into a log line. Deleting `forLog()`
    // from the infected branch of `assertScannedClean()` turns this red.
    const forged = 'EICAR\nERROR media upload ACCEPTED: scan skipped\r\x1b[2J';
    const written: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
      written.push(String(args[0]));
    });
    try {
      const { upload, puts, businessId } = await appWith(new StubInfectedMalwareScanner(forged));
      const res = await upload();
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe('MEDIA_INFECTED');
      expect(puts).toEqual([]);
      expect(await mediaRowCount(businessId)).toBe(0);

      const record = written.find((line) => line.includes('malware scan reported'));
      expect(record).toBeDefined();
      // One line, no control characters, and the forged text is still visible
      // in its escaped form rather than dropped.
      expect([...(record ?? '')].filter((ch) => ch.charCodeAt(0) < 0x20)).toEqual([]);
      expect(record).toContain('\\n');
      expect(record).toContain('EICAR');
    } finally {
      spy.mockRestore();
    }
  });

  it('scanner THROWS (clamd unreachable) → 503, nothing stored', async () => {
    const { upload, puts, businessId } = await appWith(new ThrowingMalwareScanner());
    const res = await upload();
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('MEDIA_SCAN_UNAVAILABLE');
    expect(puts).toEqual([]);
    expect(await mediaRowCount(businessId)).toBe(0);
  });

  it('scanner NEVER ANSWERS → refused on the timeout, nothing stored ("no result" is not a pass)', async () => {
    const { upload, puts, businessId } = await appWith(new HangingMalwareScanner(), { MALWARE_SCAN_TIMEOUT_MS: '300' });
    const started = Date.now();
    const res = await upload();
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('MEDIA_SCAN_UNAVAILABLE');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(puts).toEqual([]);
    expect(await mediaRowCount(businessId)).toBe(0);
  });

  it('an ENABLED scanner that answers UNAVAILABLE (clamd down) → 503, nothing stored', async () => {
    const { upload, puts, businessId } = await appWith(new StubUnavailableMalwareScanner());
    const res = await upload();
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('MEDIA_SCAN_UNAVAILABLE');
    expect(puts).toEqual([]);
    expect(await mediaRowCount(businessId)).toBe(0);
  });

  it('FAKE clean from a scanner that is not enabled → refused (a disabled adapter cannot vouch for a file)', async () => {
    const { upload, puts, businessId } = await appWith(new FakeCleanDisabledMalwareScanner());
    const res = await upload();
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('MEDIA_SCAN_UNAVAILABLE');
    expect(puts).toEqual([]);
    expect(await mediaRowCount(businessId)).toBe(0);
  });

  it('UNREADABLE verdict → refused (an unrecognised answer is never read as a pass)', async () => {
    const { upload, puts, businessId } = await appWith(new UnreadableVerdictMalwareScanner());
    const res = await upload();
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('MEDIA_SCAN_UNAVAILABLE');
    expect(puts).toEqual([]);
    expect(await mediaRowCount(businessId)).toBe(0);
  });

  it('a REAL clean verdict → 201, stored once, and the audit trail names the scanner that cleared it', async () => {
    const scanner = new StubCleanMalwareScanner();
    const { upload, puts, businessId } = await appWith(scanner);
    const res = await upload();
    expect(res.status).toBe(201);
    expect(scanner.calls).toBe(1);
    expect(puts.length).toBeGreaterThan(0);
    expect(await mediaRowCount(businessId)).toBe(1);
    const audit = await ownerPool().query<{ metadata: { scan?: string } }>(
      "SELECT metadata FROM audit_events WHERE business_id = $1 AND action = 'catalog.media_uploaded'",
      [businessId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.metadata.scan).toBe(`clean:${scanner.kind}`);
    // The refusal labels of the old code can never appear on an accepted upload.
    expect(audit.rows[0]?.metadata.scan).not.toContain('disabled');
  });
});
