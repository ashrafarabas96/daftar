import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/config';
import { KmsCredentialEncryptor, KmsEncryptError, createCredentialEncryptor } from '../../apps/api/src/modules/delivery/credential-protector';
import type { CredentialPayloadEncryptor } from '../../apps/api/src/modules/delivery/credential-protector';
import { createTestApp, ownerPool, resetData, uniqueEmail } from '../helpers/test-app';

/**
 * Final Release Blocker 4 — credential KMS bridge hardening.
 * Production: HTTPS-only, authenticated, bounded timeout/size, schema-checked,
 * controlled retry, classified errors that never carry the secret. The
 * merchant transaction that enqueues a credential fails closed when the
 * bridge fails: nothing is persisted, nothing is delivered.
 */
const SECRET = 'Daftar-super-secret-invite-token-XYZ';
const TOKEN = 'kms-bridge-token-with-at-least-32-characters!!';
const PROD_BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:x@db/daftar',
  PROVISIONER_DATABASE_URL: 'postgresql://daftar_provisioner:x@db/daftar',
  PROVISIONING_ASSERTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  // Deliberately DIFFERENT bytes from the provisioning key: since P2-S3 a
  // production merchant process refuses to start when the two secrets are
  // byte-equal, because one compromise would then reach both provisioning
  // and the ledger.
  ACCOUNTING_ASSERTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  ACCOUNTING_ASSERTION_KID: 'acct1',
  // P3-AL-55 §C: a third, distinct secret — equal bytes to either key above
  // are a production startup failure.
  INVENTORY_ASSERTION_KEY: Buffer.alloc(32, 13).toString('base64'),
  INVENTORY_ASSERTION_KID: 'inv1',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  MEDIA_STORAGE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'daftar-media',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
  REDIS_URL: 'redis://redis:6379',
};

type Handler = Parameters<typeof createServer>[1];

function listen(handler: Handler): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/encrypt` }));
  });
}

describe('credential KMS bridge — configuration (Blocker 4)', () => {
  it('production REJECTS a plaintext http:// endpoint at configuration time', () => {
    expect(() => loadConfig({ ...PROD_BASE, CREDENTIAL_KMS_ENDPOINT: 'http://kms.internal/encrypt', CREDENTIAL_KMS_TOKEN: TOKEN })).toThrow(/https:\/\//);
  });
  it('production REJECTS an unauthenticated endpoint (no CREDENTIAL_KMS_TOKEN)', () => {
    expect(() => loadConfig({ ...PROD_BASE, CREDENTIAL_KMS_ENDPOINT: 'https://kms.internal/encrypt' })).toThrow(/CREDENTIAL_KMS_TOKEN/);
    expect(() => createCredentialEncryptor({ NODE_ENV: 'production', CREDENTIAL_KMS_ENDPOINT: 'https://kms.internal/encrypt' })).toThrow(
      /CREDENTIAL_KMS_TOKEN/,
    );
  });
  it('production ACCEPTS https + token; the factory returns the KMS client, never the local adapter', () => {
    const cfg = loadConfig({ ...PROD_BASE, CREDENTIAL_KMS_ENDPOINT: 'https://kms.internal/encrypt', CREDENTIAL_KMS_TOKEN: TOKEN });
    expect(createCredentialEncryptor(cfg)).toBeInstanceOf(KmsCredentialEncryptor);
    expect(cfg.CREDENTIAL_KMS_TIMEOUT_MS).toBe(5000);
  });
  it('the client itself refuses http:// unless explicitly allowed (non-production only), embedded credentials, short tokens and silly timeouts', () => {
    expect(() => new KmsCredentialEncryptor({ endpoint: 'http://kms/encrypt', token: TOKEN, timeoutMs: 1000, allowInsecureHttp: false })).toThrow(/https/);
    expect(() => new KmsCredentialEncryptor({ endpoint: 'https://user:pw@kms/encrypt', token: TOKEN, timeoutMs: 1000, allowInsecureHttp: false })).toThrow(
      /credentials/,
    );
    expect(() => new KmsCredentialEncryptor({ endpoint: 'https://kms/encrypt', token: 'short', timeoutMs: 1000, allowInsecureHttp: false })).toThrow(
      /32 characters/,
    );
    expect(() => new KmsCredentialEncryptor({ endpoint: 'https://kms/encrypt', token: TOKEN, timeoutMs: 10, allowInsecureHttp: false })).toThrow(/TIMEOUT_MS/);
  });
});

describe('credential KMS bridge — transport failures are bounded and sanitized (Blocker 4)', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server?.close(() => r()));
    server = null;
  });
  const client = (url: string, timeoutMs = 400) => new KmsCredentialEncryptor({ endpoint: url, token: TOKEN, timeoutMs, allowInsecureHttp: true });
  const aad = Buffer.from('kind|email|parent|delivery');
  const okBody = JSON.stringify({ ciphertext: Buffer.alloc(48, 1).toString('base64'), nonce: Buffer.alloc(12, 2).toString('base64'), keyVersion: 'v7' });

  it('happy path: bearer token sent, plaintext travels only as base64 JSON, response validated', async () => {
    let seen: { auth: string | undefined; body: string } | null = null;
    ({ server } = await listen((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen = { auth: req.headers.authorization, body };
        res.setHeader('content-type', 'application/json');
        res.end(okBody);
      });
    }));
    const out = await client(server.address() ? `http://127.0.0.1:${(server.address() as AddressInfo).port}/encrypt` : '').encrypt(SECRET, aad);
    expect(out.keyVersion).toBe('v7');
    const observed = seen as { auth: string | undefined; body: string } | null;
    expect(observed).not.toBeNull();
    expect(observed?.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(observed?.body ?? '{}')).toEqual({ plaintext: Buffer.from(SECRET).toString('base64'), aad: aad.toString('base64') });
  });

  it('timeout: a hanging bridge fails within the bound (one retry) as KMS_TIMEOUT, never hangs the request', async () => {
    let calls = 0;
    ({ server } = await listen(() => {
      calls += 1; /* never respond */
    }));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/encrypt`;
    const started = Date.now();
    await expect(client(url, 300).encrypt(SECRET, aad)).rejects.toMatchObject({ code: 'KMS_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(calls).toBe(2);
  });

  it('unreachable bridge → KMS_UNREACHABLE (bounded, retried once)', async () => {
    await expect(client('http://127.0.0.1:1/encrypt').encrypt(SECRET, aad)).rejects.toMatchObject({ code: 'KMS_UNREACHABLE' });
  });

  it('KMS error responses: 503 is retried once then KMS_REJECTED; 400 is not retried; the body is never surfaced', async () => {
    let calls = 0;
    let status = 503;
    ({ server } = await listen((_req, res) => {
      calls += 1;
      res.statusCode = status;
      res.end(`leaked-body-${SECRET}`);
    }));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/encrypt`;
    const err = await client(url)
      .encrypt(SECRET, aad)
      .catch((e: unknown) => e as KmsEncryptError);
    expect(err).toBeInstanceOf(KmsEncryptError);
    expect((err as KmsEncryptError).code).toBe('KMS_REJECTED');
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).not.toContain('leaked-body');
    expect(calls).toBe(2);
    calls = 0;
    status = 400;
    await expect(client(url).encrypt(SECRET, aad)).rejects.toMatchObject({ code: 'KMS_REJECTED' });
    expect(calls).toBe(1);
  });

  it('malformed responses are rejected: not JSON, missing fields, non-base64 ciphertext', async () => {
    const bodies = [
      '<html>oops</html>',
      JSON.stringify({ ciphertext: 'x' }),
      JSON.stringify({ ciphertext: '!!not base64!!', nonce: 'AAAAAAAAAAAAAAAA', keyVersion: 'v1' }),
    ];
    let i = 0;
    ({ server } = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(bodies[i++ % bodies.length]);
    }));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/encrypt`;
    for (let n = 0; n < bodies.length; n += 1) {
      await expect(client(url).encrypt(SECRET, aad)).rejects.toMatchObject({ code: 'KMS_MALFORMED' });
    }
  });

  it('oversized responses are cut off: declared content-length and streamed bodies over 64 KiB → KMS_TOO_LARGE', async () => {
    let mode: 'declared' | 'streamed' = 'declared';
    ({ server } = await listen((_req, res) => {
      if (mode === 'declared') {
        res.setHeader('content-length', String(10 * 1024 * 1024));
        res.write('{');
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.write('{"ciphertext":"');
        res.write('A'.repeat(70 * 1024));
        res.end('"}');
      }
    }));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/encrypt`;
    await expect(client(url).encrypt(SECRET, aad)).rejects.toMatchObject({ code: 'KMS_TOO_LARGE' });
    mode = 'streamed';
    await expect(client(url).encrypt(SECRET, aad)).rejects.toMatchObject({ code: 'KMS_TOO_LARGE' });
  });

  it('redirects are refused (no following to an attacker-chosen host)', async () => {
    ({ server } = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/elsewhere');
      res.end();
    }));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/encrypt`;
    await expect(client(url).encrypt(SECRET, aad)).rejects.toBeInstanceOf(KmsEncryptError);
  });
});

describe('credential KMS bridge — merchant transaction semantics on encrypt failure (Blocker 4)', () => {
  it('an invitation whose credential cannot be encrypted is NOT created: the whole request transaction rolls back (fail closed)', async () => {
    const failing: CredentialPayloadEncryptor = {
      encrypt: () => Promise.reject(new KmsEncryptError('KMS_TIMEOUT', 'simulated bridge outage')),
    };
    const t = await createTestApp({ encryptor: failing });
    await resetData();
    const email = uniqueEmail();
    const reg = await t.request.post('/v1/auth/register').send({ email, password: 'Str0ng!Passw0rd', displayName: 'O', preferredLocale: 'ar' });
    const token = reg.body.accessToken as string;
    const on = await t.request
      .post('/v1/onboarding/complete')
      .set('Idempotency-Key', `kms-${Date.now()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ businessName: 'K', countryCode: 'PS', baseCurrency: 'ILS', storeSlug: `kms-${Date.now()}` });
    expect(on.status).toBe(201);
    const businessId = on.body.businessId as string;
    const invitee = uniqueEmail();
    const res = await t.request
      .post('/v1/businesses/current/invitations')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Business-Id', businessId)
      .send({ email: invitee, roleKey: 'cashier' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toContain('simulated bridge outage'); // classified, not leaked
    expect(res.body.error.requestId).toBeTruthy();
    const inv = await ownerPool().query('SELECT 1 FROM business_invitations WHERE business_id = $1 AND email = $2', [businessId, invitee]);
    expect(inv.rows).toEqual([]);
    const del = await ownerPool().query('SELECT 1 FROM credential_deliveries WHERE email = $1', [invitee]);
    expect(del.rows).toEqual([]);
    // Password reset: same fail-closed semantics — no token row survives an encrypt failure.
    const pr = await t.request.post('/v1/auth/password-reset/request').send({ email });
    expect(pr.status).toBeGreaterThanOrEqual(500);
    const tokens = await ownerPool().query<{ n: string }>('SELECT count(*)::text AS n FROM password_reset_tokens');
    expect(Number(tokens.rows[0]?.n)).toBe(0);
  });
});
