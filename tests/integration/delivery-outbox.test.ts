import { beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, ownerPool, resetData, uniqueEmail, type TestApp } from '../helpers/test-app';
import { CredentialDeliveryWorker, DELIVERY_MAX_ATTEMPTS } from '../../apps/api/src/modules/delivery/delivery-worker.service';
import type { CredentialDelivery } from '../../apps/api/src/modules/auth/tokens';

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected value');
  return v;
}

const failingDelivery: CredentialDelivery = {
  kind: 'always-fails-test-double',
  sendInvitation: () => Promise.reject(new Error('smtp unreachable')),
  sendPasswordReset: () => Promise.reject(new Error('smtp unreachable')),
};

/** §18–20 (Final Closure): credential delivery outbox — states, retry, dead-letter. */
describe('credential delivery outbox (§18–20)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp({ delivery: failingDelivery });
    await resetData();
  });

  async function onboardedOwner(): Promise<{ token: string; businessId: string }> {
    const reg = await t.request.post('/v1/auth/register').send({
      email: uniqueEmail(),
      password: 'Str0ng!Passw0rd',
      displayName: 'O',
      preferredLocale: 'ar',
    });
    const token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `idem-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        businessName: 'D',
        countryCode: 'PS',
        baseCurrency: 'ILS',
        storeSlug: `dl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    return { token, businessId: on.body.businessId as string };
  }

  it('failure → retryable (failed + backoff), then DEAD-LETTER at the retry limit; parent mirrors', async () => {
    const { token, businessId } = await onboardedOwner();
    const res = await t.request
      .post('/v1/businesses/current/invitations')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Business-Id', businessId)
      .send({ email: uniqueEmail(), roleKey: 'cashier' });
    expect(res.status).toBe(201);

    const worker = t.app.get(CredentialDeliveryWorker);
    // First drain happened post-commit (attempt 1 → failed with backoff).
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i += 1) {
      await ownerPool().query(`UPDATE credential_deliveries SET next_attempt_at = now() - interval '1 minute' WHERE status = 'failed'`);
      await worker.drain();
    }
    const d = must(
      (await ownerPool().query<{ status: string; attempts: number }>('SELECT status, attempts FROM credential_deliveries ORDER BY created_at DESC LIMIT 1'))
        .rows[0],
    );
    expect(d.status).toBe('dead');
    expect(d.attempts).toBe(DELIVERY_MAX_ATTEMPTS);
    const inv = must(
      (
        await ownerPool().query<{ delivery_status: string; delivery_attempts: number; last_delivery_error: string }>(
          'SELECT delivery_status, delivery_attempts, last_delivery_error FROM business_invitations ORDER BY created_at DESC LIMIT 1',
        )
      ).rows[0],
    );
    expect(inv.delivery_status).toBe('dead');
    expect(inv.delivery_attempts).toBe(DELIVERY_MAX_ATTEMPTS);
    expect(inv.last_delivery_error).toBe('DELIVERY_FAILED'); // §XXIII: classified, never raw
  });

  it('password reset uses the SAME pipeline (§20): failure tracked, retryable, dead-lettered', async () => {
    const email = uniqueEmail();
    await t.request.post('/v1/auth/register').send({
      email,
      password: 'Str0ng!Passw0rd',
      displayName: 'O',
      preferredLocale: 'ar',
    });
    const res = await t.request.post('/v1/auth/password-reset/request').send({ email });
    expect(res.status).toBeLessThan(300);
    const worker = t.app.get(CredentialDeliveryWorker);
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i += 1) {
      await ownerPool().query(`UPDATE credential_deliveries SET next_attempt_at = now() - interval '1 minute' WHERE status = 'failed'`);
      await worker.drain();
    }
    const tok = must(
      (await ownerPool().query<{ delivery_status: string }>('SELECT delivery_status FROM password_reset_tokens ORDER BY created_at DESC LIMIT 1')).rows[0],
    );
    expect(tok.delivery_status).toBe('dead');
  });

  it('retryable failure RECOVERS when the adapter heals (failed → sent)', async () => {
    // Adapter fails once, then succeeds.
    let calls = 0;
    const flaky: CredentialDelivery = {
      kind: 'flaky-test-double',
      sendInvitation: () => (calls++ === 0 ? Promise.reject(new Error('boom')) : Promise.resolve()),
      sendPasswordReset: () => Promise.resolve(),
    };
    await t.close();
    t = await createTestApp({ delivery: flaky });
    await resetData();
    const { token, businessId } = await onboardedOwner();
    const res = await t.request
      .post('/v1/businesses/current/invitations')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Business-Id', businessId)
      .send({ email: uniqueEmail(), roleKey: 'cashier' });
    expect(res.status).toBe(201);
    const worker = t.app.get(CredentialDeliveryWorker);
    // Part C: the request path never drains — attempt 1 happens HERE and fails.
    await worker.drain();
    await ownerPool().query(`UPDATE credential_deliveries SET next_attempt_at = now() - interval '1 minute' WHERE status = 'failed'`);
    await worker.drain(); // adapter healed → attempt 2 succeeds
    const inv = must(
      (
        await ownerPool().query<{ delivery_status: string; delivery_attempts: number }>(
          'SELECT delivery_status, delivery_attempts FROM business_invitations ORDER BY created_at DESC LIMIT 1',
        )
      ).rows[0],
    );
    expect(inv.delivery_status).toBe('sent');
    expect(inv.delivery_attempts).toBe(2);
  });
});
