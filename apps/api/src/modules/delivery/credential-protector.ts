import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * CredentialPayloadProtector (Gate A §5–7, Terminal Closure §23–29):
 * application-level envelope encryption for credential delivery payloads
 * (invitation / password-reset tokens in transit). AES-256-GCM; key material
 * NEVER lives in the database, is NEVER logged, and NEVER enters the repo.
 *
 * KEY RING (§23–27): configured with one or more key versions. Exactly one
 * ACTIVE version encrypts new payloads; ACTIVE + PREVIOUS versions decrypt
 * (old pending jobs stay decryptable after rotation). A retired version must
 * not be removed while rows still reference it (ops procedure; unknown
 * versions fail loudly at decrypt time, never silently).
 *
 * AAD BINDING (§28): every payload is bound via AES-GCM additional
 * authenticated data to its context — credential kind, normalized recipient
 * email, parent credential id, and the delivery row id. Moving ciphertext
 * from delivery A to delivery B (or across recipients/parents/kinds) fails
 * authentication (§29 ciphertext swap rejection).
 *
 * - development/test: a fixed well-known test key is permitted (explicitly
 *   non-production; see config.ts).
 * - production: CREDENTIAL_PAYLOAD_KEYS (or legacy CREDENTIAL_PAYLOAD_KEY) is
 *   REQUIRED — config validation fails startup without it.
 */

export interface ProtectedPayload {
  ciphertext: string; // base64 (body || tag)
  nonce: string; // base64
  keyVersion: string;
}

export interface CredentialKeyEntry {
  version: string;
  key: Buffer;
  status: 'active' | 'previous';
}

export const CREDENTIAL_KEY_VERSION = 'v1';

/** Well-known TEST-ONLY key. Refused in production by config validation. */
export const DEV_TEST_KEY = Buffer.from('daftar-dev-test-credential-key-32b').subarray(0, 32);

/** §28: AAD context binding for one delivery row. */
export function credentialAad(parts: { kind: 'invitation' | 'password_reset'; email: string; parentId: string; deliveryId: string }): Buffer {
  return Buffer.from(`daftar-credential|${parts.kind}|${parts.email.trim().toLowerCase()}|${parts.parentId}|${parts.deliveryId}`, 'utf8');
}

export class CredentialPayloadProtector {
  private readonly active: CredentialKeyEntry;
  private readonly ring = new Map<string, Buffer>();

  constructor(entries: CredentialKeyEntry[]) {
    if (entries.length === 0) throw new Error('credential key ring must not be empty');
    const actives = entries.filter((e) => e.status === 'active');
    if (actives.length !== 1) throw new Error(`exactly one active credential key required (found ${actives.length})`);
    for (const e of entries) {
      if (e.key.length !== 32) throw new Error(`credential payload key ${e.version} must be 32 bytes (AES-256-GCM)`);
      if (this.ring.has(e.version)) throw new Error(`duplicate credential key version '${e.version}'`);
      this.ring.set(e.version, e.key);
    }
    this.active = actives[0] as CredentialKeyEntry;
  }

  /** Versions currently covered by the ring (for retirement checks). */
  coveredVersions(): string[] {
    return [...this.ring.keys()];
  }

  encrypt(secret: string, aad: Buffer): ProtectedPayload {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.active.key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([body, tag]).toString('base64'),
      nonce: nonce.toString('base64'),
      keyVersion: this.active.version,
    };
  }

  decrypt(payload: ProtectedPayload, aad: Buffer): string {
    const key = this.ring.get(payload.keyVersion);
    if (!key) throw new Error(`unknown credential payload key version: ${payload.keyVersion}`);
    const raw = Buffer.from(payload.ciphertext, 'base64');
    const body = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.nonce, 'base64'));
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}

/** Build the ring from config: JSON ring preferred, legacy single key → v1. */
export function credentialKeyRingFromConfig(config: {
  NODE_ENV?: string | undefined;
  CREDENTIAL_PAYLOAD_KEYS?: string | undefined;
  CREDENTIAL_PAYLOAD_KEY?: string | undefined;
}): CredentialKeyEntry[] {
  if (config.CREDENTIAL_PAYLOAD_KEYS) {
    let raw: unknown;
    try {
      raw = JSON.parse(config.CREDENTIAL_PAYLOAD_KEYS);
    } catch {
      throw new Error('CREDENTIAL_PAYLOAD_KEYS is not valid JSON');
    }
    if (!Array.isArray(raw)) throw new Error('CREDENTIAL_PAYLOAD_KEYS must be a JSON array of {version, key, status}');
    return raw.map((e): CredentialKeyEntry => {
      const o = e as Record<string, unknown>;
      if (typeof o?.version !== 'string' || o.version.length < 1 || o.version.length > 32)
        throw new Error('CREDENTIAL_PAYLOAD_KEYS: every key needs a version (1–32 chars)');
      if (typeof o?.key !== 'string') throw new Error(`CREDENTIAL_PAYLOAD_KEYS: key ${o.version} missing`);
      const key = Buffer.from(o.key, 'base64');
      if (key.length !== 32) throw new Error(`CREDENTIAL_PAYLOAD_KEYS: key ${o.version} must be base64 of 32 bytes`);
      if (o?.status !== 'active' && o?.status !== 'previous')
        throw new Error(`CREDENTIAL_PAYLOAD_KEYS: key ${o.version} status must be 'active' or 'previous'`);
      return { version: o.version, key, status: o.status };
    });
  }
  if (config.CREDENTIAL_PAYLOAD_KEY) {
    const key = Buffer.from(config.CREDENTIAL_PAYLOAD_KEY, 'base64');
    if (key.length !== 32) throw new Error('CREDENTIAL_PAYLOAD_KEY must be base64 of 32 bytes');
    return [{ version: CREDENTIAL_KEY_VERSION, key, status: 'active' }];
  }
  // Directive §24: NO DEV_TEST_KEY fallback in production — config validation
  // already fails startup, and this guard makes the fallback structurally
  // impossible even if a caller bypasses loadConfig().
  if (config.NODE_ENV === 'production') {
    throw new Error('production requires CREDENTIAL_PAYLOAD_KEYS (or CREDENTIAL_PAYLOAD_KEY); the DEV_TEST_KEY fallback is forbidden');
  }
  return [{ version: CREDENTIAL_KEY_VERSION, key: DEV_TEST_KEY, status: 'active' }];
}

/**
 * §21–23 (Stabilization Part C): KMS-style separation of ENCRYPT from DECRYPT.
 * The merchant request path only ever ENCRYPTS (enqueue); the worker process
 * only ever DECRYPTS (drain). In production the merchant process must not
 * even hold decryption material — it calls an external encrypt provider
 * (KMS-style). The dev/test local adapter exists only outside production.
 */
export interface CredentialPayloadEncryptor {
  /** Encrypt a credential payload for enqueue. May be remote (KMS). */
  encrypt(secret: string, aad: Buffer): Promise<ProtectedPayload>;
}

/** DEV/TEST-ONLY local encryptor. Never instantiated in production. */
export class LocalCredentialEncryptor implements CredentialPayloadEncryptor {
  constructor(
    private readonly key: Buffer,
    private readonly version: string,
  ) {
    if (key.length !== 32) throw new Error('local encryptor key must be 32 bytes (AES-256-GCM)');
  }

  encrypt(secret: string, aad: Buffer): Promise<ProtectedPayload> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Promise.resolve({
      ciphertext: Buffer.concat([body, tag]).toString('base64'),
      nonce: nonce.toString('base64'),
      keyVersion: this.version,
    });
  }
}

/** Sanitized, classified failure of the KMS bridge — never carries plaintext, response bodies or headers. */
export class KmsEncryptError extends Error {
  constructor(
    readonly code: 'KMS_TIMEOUT' | 'KMS_UNREACHABLE' | 'KMS_REJECTED' | 'KMS_MALFORMED' | 'KMS_TOO_LARGE',
    detail: string,
  ) {
    super(`credential KMS encrypt failed: ${code} (${detail})`);
    this.name = 'KmsEncryptError';
  }
}

export interface KmsEncryptorOptions {
  endpoint: string;
  /** Bearer token for the bridge — REQUIRED in production (authenticated encryption service only). */
  token: string | null;
  timeoutMs: number;
  /** Non-production only: allow http:// for a local bridge. Production is HTTPS-only. */
  allowInsecureHttp: boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const KMS_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Production merchant-side encryptor (Final Release Blocker 4): delegates
 * encryption to an AUTHENTICATED KMS-style bridge over HTTPS. The merchant
 * process carries NO key material of any kind.
 *
 * Network protections: HTTPS-only (production), bearer authentication,
 * bounded timeout with abort, bounded response size, schema-validated
 * response, ONE retry only on transport failure / 502–504 (the request is
 * idempotent: same plaintext + AAD → a fresh envelope, nothing is persisted
 * until the transaction commits), and classified errors that never include
 * the plaintext, the response body or headers. Nothing here logs.
 */
export class KmsCredentialEncryptor implements CredentialPayloadEncryptor {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: KmsEncryptorOptions) {
    let url: URL;
    try {
      url = new URL(opts.endpoint);
    } catch {
      throw new Error('CREDENTIAL_KMS_ENDPOINT is not a valid URL');
    }
    if (url.protocol !== 'https:' && !(opts.allowInsecureHttp && url.protocol === 'http:')) {
      throw new Error('CREDENTIAL_KMS_ENDPOINT must use https:// (plaintext http is forbidden for credential payloads)');
    }
    if (url.username || url.password) throw new Error('CREDENTIAL_KMS_ENDPOINT must not embed credentials');
    if (opts.token !== null && opts.token.length < 32) throw new Error('CREDENTIAL_KMS_TOKEN must be at least 32 characters');
    if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 100 || opts.timeoutMs > 60_000) throw new Error('CREDENTIAL_KMS_TIMEOUT_MS must be 100–60000');
    this.endpoint = url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async encrypt(secret: string, aad: Buffer): Promise<ProtectedPayload> {
    const body = JSON.stringify({ plaintext: Buffer.from(secret, 'utf8').toString('base64'), aad: aad.toString('base64') });
    let lastError: KmsEncryptError | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.once(body);
      } catch (e) {
        const err = e instanceof KmsEncryptError ? e : new KmsEncryptError('KMS_UNREACHABLE', 'unexpected client failure');
        lastError = err;
        const retryable = err.code === 'KMS_UNREACHABLE' || err.code === 'KMS_TIMEOUT' || (err.code === 'KMS_REJECTED' && /status 50[234]/.test(err.message));
        if (!retryable || attempt === 1) throw err;
      }
    }
    throw lastError ?? new KmsEncryptError('KMS_UNREACHABLE', 'no attempt made');
  }

  private async once(body: string): Promise<ProtectedPayload> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (this.opts.token !== null) headers['authorization'] = `Bearer ${this.opts.token}`;
      res = await this.fetchImpl(this.endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
    } catch (e) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new KmsEncryptError('KMS_TIMEOUT', `no response within ${this.opts.timeoutMs}ms`);
      throw new KmsEncryptError('KMS_UNREACHABLE', (e as { cause?: { code?: string } })?.cause?.code ?? 'transport failure');
    }
    try {
      if (!res.ok) {
        // Drain without reading into memory beyond the cap; never surface the body.
        await res.body?.cancel().catch(() => undefined);
        throw new KmsEncryptError('KMS_REJECTED', `status ${res.status}`);
      }
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > KMS_MAX_RESPONSE_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        throw new KmsEncryptError('KMS_TOO_LARGE', `content-length ${declared}`);
      }
      const text = await readBounded(res, KMS_MAX_RESPONSE_BYTES, controller);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new KmsEncryptError('KMS_MALFORMED', 'response is not JSON');
      }
      const o = parsed as Partial<Record<keyof ProtectedPayload, unknown>>;
      if (
        typeof o?.ciphertext !== 'string' ||
        typeof o?.nonce !== 'string' ||
        typeof o?.keyVersion !== 'string' ||
        !/^[A-Za-z0-9+/=]{16,}$/.test(o.ciphertext) ||
        !/^[A-Za-z0-9+/=]{12,}$/.test(o.nonce) ||
        !/^[A-Za-z0-9_.:-]{1,64}$/.test(o.keyVersion)
      ) {
        throw new KmsEncryptError('KMS_MALFORMED', 'response fields missing or malformed');
      }
      return { ciphertext: o.ciphertext, nonce: o.nonce, keyVersion: o.keyVersion };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read at most `max` bytes of the body; abort the request and fail if the peer sends more. */
async function readBounded(res: Response, max: number, controller: AbortController): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch {
      if (controller.signal.aborted) throw new KmsEncryptError('KMS_TIMEOUT', 'response body timed out');
      throw new KmsEncryptError('KMS_UNREACHABLE', 'response body failed');
    }
    if (next.done) break;
    const chunk = next.value;
    total += chunk.byteLength;
    if (total > max) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      throw new KmsEncryptError('KMS_TOO_LARGE', `body exceeds ${max} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Factory for the merchant-side ENCRYPTOR. Production REQUIRES a KMS-style
 * provider (CREDENTIAL_KMS_ENDPOINT) — the DEV_TEST_KEY path is structurally
 * impossible in production (config validation + this guard).
 */
export function createCredentialEncryptor(config: {
  NODE_ENV: string;
  CREDENTIAL_KMS_ENDPOINT?: string | undefined;
  CREDENTIAL_KMS_TOKEN?: string | undefined;
  CREDENTIAL_KMS_TIMEOUT_MS?: number | undefined;
}): CredentialPayloadEncryptor {
  const isProd = config.NODE_ENV === 'production';
  if (config.CREDENTIAL_KMS_ENDPOINT) {
    if (isProd && !config.CREDENTIAL_KMS_TOKEN) {
      throw new Error('production requires CREDENTIAL_KMS_TOKEN — credential plaintext is never sent to an unauthenticated endpoint');
    }
    return new KmsCredentialEncryptor({
      endpoint: config.CREDENTIAL_KMS_ENDPOINT,
      token: config.CREDENTIAL_KMS_TOKEN ?? null,
      timeoutMs: config.CREDENTIAL_KMS_TIMEOUT_MS ?? 5000,
      allowInsecureHttp: !isProd,
    });
  }
  if (isProd) {
    throw new Error('production merchant runtime requires CREDENTIAL_KMS_ENDPOINT (KMS-style encrypt provider; local keys are forbidden)');
  }
  return new LocalCredentialEncryptor(DEV_TEST_KEY, CREDENTIAL_KEY_VERSION);
}
