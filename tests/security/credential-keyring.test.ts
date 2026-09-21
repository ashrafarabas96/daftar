import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialPayloadProtector,
  credentialAad,
  credentialKeyRingFromConfig,
} from '../../apps/api/src/modules/delivery/credential-protector';
import {
  createTestApp, ownerPool, resetData, uniqueEmail, type TestApp,
} from '../helpers/test-app';

function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}

const key = () => randomBytes(32);
const aad = (over: Partial<Parameters<typeof credentialAad>[0]> = {}) =>
  credentialAad({
    kind: 'password_reset',
    email: 'User@Example.com',
    parentId: 'parent-1',
    deliveryId: 'delivery-1',
    ...over,
  });

/**
 * Terminal Closure §23–29: real credential encryption key ring + AAD binding.
 */
describe('credential encryption key ring (§23–27)', () => {
  it('new writes use the CURRENT active key; old pending payloads stay decryptable', () => {
    const k1 = key();
    const k2 = key();
    const gen1 = new CredentialPayloadProtector([{ version: 'v1', key: k1, status: 'active' }]);
    const payload = gen1.encrypt('secret-token', aad());
    expect(payload.keyVersion).toBe('v1');

    // Rotate: v2 active, v1 previous.
    const gen2 = new CredentialPayloadProtector([
      { version: 'v2', key: k2, status: 'active' },
      { version: 'v1', key: k1, status: 'previous' },
    ]);
    expect(gen2.decrypt(payload, aad())).toBe('secret-token'); // old job still decrypts
    const fresh = gen2.encrypt('new-token', aad());
    expect(fresh.keyVersion).toBe('v2'); // new writes use current key
    expect(gen2.decrypt(fresh, aad())).toBe('new-token');
  });

  it('retired key (removed from ring) can no longer decrypt — loud failure', () => {
    const k1 = key();
    const gen1 = new CredentialPayloadProtector([{ version: 'v1', key: k1, status: 'active' }]);
    const payload = gen1.encrypt('secret-token', aad());
    const retired = new CredentialPayloadProtector([{ version: 'v2', key: key(), status: 'active' }]);
    expect(() => retired.decrypt(payload, aad())).toThrow(/unknown credential payload key version/);
  });

  it('ring validation: exactly one active, no duplicate versions, 32-byte keys', () => {
    expect(() => new CredentialPayloadProtector([{ version: 'v1', key: key(), status: 'previous' }])).toThrow(/exactly one active/);
    expect(() =>
      new CredentialPayloadProtector([
        { version: 'v1', key: key(), status: 'active' },
        { version: 'v1', key: key(), status: 'previous' },
      ]),
    ).toThrow(/duplicate/);
    expect(() => new CredentialPayloadProtector([{ version: 'v1', key: Buffer.alloc(16), status: 'active' }])).toThrow(/32 bytes/);
  });

  it('credentialKeyRingFromConfig: JSON ring, legacy single key → v1, dev fallback', () => {
    const k1 = key().toString('base64');
    const ring = credentialKeyRingFromConfig({
      CREDENTIAL_PAYLOAD_KEYS: JSON.stringify([{ version: 'v9', key: k1, status: 'active' }]),
    });
    expect(ring).toHaveLength(1);
    expect(ring[0]?.version).toBe('v9');
    const legacy = credentialKeyRingFromConfig({ CREDENTIAL_PAYLOAD_KEY: k1 });
    expect(legacy[0]?.version).toBe('v1');
    const dev = credentialKeyRingFromConfig({});
    expect(dev[0]?.version).toBe('v1'); // dev/test only; config refuses in production
    expect(() => credentialKeyRingFromConfig({ CREDENTIAL_PAYLOAD_KEYS: '{bad' })).toThrow(/not valid JSON/);
    expect(() =>
      credentialKeyRingFromConfig({
        CREDENTIAL_PAYLOAD_KEYS: JSON.stringify([{ version: 'v1', key: 'c2hvcnQ=', status: 'active' }]),
      }),
    ).toThrow(/32 bytes/);
  });
});

describe('AAD context binding (§28–29)', () => {
  it('ciphertext swap: payload of delivery A cannot be decrypted in the context of delivery B', () => {
    const k1 = key();
    const p = new CredentialPayloadProtector([{ version: 'v1', key: k1, status: 'active' }]);
    const payload = p.encrypt('secret-A', aad({ deliveryId: 'delivery-A' }));
    // Swapped into delivery B (different id) → authentication failure.
    expect(() => p.decrypt(payload, aad({ deliveryId: 'delivery-B' }))).toThrow();
  });

  it('context fields all bind: kind, normalized email, parent id', () => {
    const k1 = key();
    const p = new CredentialPayloadProtector([{ version: 'v1', key: k1, status: 'active' }]);
    const payload = p.encrypt('secret', aad());
    expect(p.decrypt(payload, aad())).toBe('secret');
    expect(p.decrypt(payload, aad({ email: 'user@example.com' }))).toBe('secret'); // normalized
    expect(() => p.decrypt(payload, aad({ email: 'other@example.com' }))).toThrow();
    expect(() => p.decrypt(payload, aad({ kind: 'invitation' }))).toThrow();
    expect(() => p.decrypt(payload, aad({ parentId: 'parent-2' }))).toThrow();
  });

  it('END-TO-END swap in the DB: swapped rows fail authentication, nothing is delivered', async () => {
    const delivered: string[] = [];
    let failMode = true; // keep rows pending (payload preserved) until the swap is in place
    const t: TestApp = await createTestApp({
      delivery: {
        kind: 'capture',
        sendPasswordReset: (email: string) => {
          if (failMode) return Promise.reject(new Error('smtp down'));
          delivered.push(email);
          return Promise.resolve();
        },
        sendInvitation: () => (failMode ? Promise.reject(new Error('smtp down')) : Promise.resolve()),
      },
    });
    try {
      await resetData();
      const emailA = uniqueEmail();
      const emailB = uniqueEmail();
      for (const email of [emailA, emailB]) {
        await t.request.post('/v1/auth/register').send({
          email, password: 'Str0ng!Passw0rd', displayName: 'U', preferredLocale: 'ar',
        });
        await t.request.post('/v1/auth/password-reset/request').send({ email });
      }
      // Swap the payloads of the two queued deliveries (privilege: superuser,
      // simulating any attacker who can write rows but has no key/AAD context).
      const { rows } = await ownerPool().query<{ id: string }>(
        `SELECT id FROM credential_deliveries WHERE status IN ('pending','failed') ORDER BY email`,
      );
      expect(rows.length).toBe(2);
      const a = must(rows[0], 'row a').id;
      const b = must(rows[1], 'row b').id;
      await ownerPool().query(
        `UPDATE credential_deliveries d SET secret_ciphertext = s.secret_ciphertext, secret_nonce = s.secret_nonce
         FROM (SELECT id, secret_ciphertext, secret_nonce FROM credential_deliveries WHERE id IN ($1, $2)) s
         WHERE d.id <> s.id AND d.id IN ($1, $2)`,
        [a, b],
      );
      failMode = false;
      const result = await t.worker.drain();
      expect(result.sent).toBe(0);
      expect(delivered).toHaveLength(0);
      const after = await ownerPool().query<{ status: string; last_error: string | null }>(
        `SELECT status, last_error FROM credential_deliveries WHERE id IN ($1, $2)`, [a, b],
      );
      for (const r of after.rows) {
        expect(['pending', 'failed']).toContain(r.status);
        expect(r.last_error ?? '').not.toContain('secret'); // safe errors only
      }
    } finally {
      await t.close();
    }
  });
});
