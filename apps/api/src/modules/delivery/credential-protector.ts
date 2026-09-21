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
export function credentialAad(parts: {
  kind: 'invitation' | 'password_reset';
  email: string;
  parentId: string;
  deliveryId: string;
}): Buffer {
  return Buffer.from(
    `daftar-credential|${parts.kind}|${parts.email.trim().toLowerCase()}|${parts.parentId}|${parts.deliveryId}`,
    'utf8',
  );
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
  // Non-production only (config validation forbids this in production).
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

/**
 * Production merchant-side encryptor: delegates encryption to a KMS-style
 * endpoint. The merchant process carries NO key material of any kind —
 * neither encryption nor decryption keys.
 */
export class KmsCredentialEncryptor implements CredentialPayloadEncryptor {
  constructor(private readonly endpoint: string) {}

  async encrypt(secret: string, aad: Buffer): Promise<ProtectedPayload> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plaintext: Buffer.from(secret, 'utf8').toString('base64'), aad: aad.toString('base64') }),
    });
    if (!res.ok) throw new Error(`credential KMS encrypt failed (status ${res.status})`);
    const body = (await res.json()) as Partial<ProtectedPayload>;
    if (typeof body.ciphertext !== 'string' || typeof body.nonce !== 'string' || typeof body.keyVersion !== 'string') {
      throw new Error('credential KMS encrypt returned a malformed payload');
    }
    return { ciphertext: body.ciphertext, nonce: body.nonce, keyVersion: body.keyVersion };
  }
}

/**
 * Factory for the merchant-side ENCRYPTOR. Production REQUIRES a KMS-style
 * provider (CREDENTIAL_KMS_ENDPOINT) — the DEV_TEST_KEY path is structurally
 * impossible in production (config validation + this guard).
 */
export function createCredentialEncryptor(config: {
  NODE_ENV: string;
  CREDENTIAL_KMS_ENDPOINT?: string | undefined;
}): CredentialPayloadEncryptor {
  if (config.NODE_ENV === 'production') {
    if (!config.CREDENTIAL_KMS_ENDPOINT) {
      throw new Error('production merchant runtime requires CREDENTIAL_KMS_ENDPOINT (KMS-style encrypt provider; local keys are forbidden)');
    }
    return new KmsCredentialEncryptor(config.CREDENTIAL_KMS_ENDPOINT);
  }
  return new LocalCredentialEncryptor(DEV_TEST_KEY, CREDENTIAL_KEY_VERSION);
}
