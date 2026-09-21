import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Injectable, Inject } from '@nestjs/common';
import * as argon2 from 'argon2';
import { SignJWT, jwtVerify, decodeProtectedHeader } from 'jose';
import type { AppConfig } from '../../config';

/**
 * Token + password cryptography (§41–43, §56–60).
 * - Argon2id with explicit production-class parameters (benchmarked choice, ADR-012).
 * - Opaque 48-byte refresh tokens; only SHA-256 hashes are stored.
 * - Short-lived HS256 access JWTs bound to a session id (sid).
 * - KEY RING: tokens carry a `kid` header. Exactly one ring key is `active`
 *   (signs); `active` + `previous` keys verify, so rotation never logs users
 *   out. Unknown kids and retired keys are rejected.
 */
export interface JwtKeyEntry {
  kid: string;
  secret: string;
  status: 'active' | 'previous';
}

export function parseKeyRing(config: Pick<AppConfig, 'JWT_SECRET' | 'JWT_KEYS'>): {
  active: JwtKeyEntry;
  byKid: Map<string, JwtKeyEntry>;
} {
  let entries: JwtKeyEntry[];
  if (!config.JWT_KEYS) {
    if (!config.JWT_SECRET) throw new Error('JWT_KEYS or JWT_SECRET required for token signing');
    entries = [{ kid: 'legacy', secret: config.JWT_SECRET, status: 'active' }];
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(config.JWT_KEYS);
    } catch {
      throw new Error('JWT_KEYS is not valid JSON');
    }
    if (!Array.isArray(raw)) throw new Error('JWT_KEYS must be a JSON array of {kid, secret, status}');
    entries = raw.map((e): JwtKeyEntry => {
      const o = e as Record<string, unknown>;
      if (typeof o?.kid !== 'string' || o.kid.length < 1 || o.kid.length > 64) throw new Error('JWT_KEYS: every key needs a kid (1–64 chars)');
      if (typeof o?.secret !== 'string' || o.secret.length < 32) throw new Error(`JWT_KEYS: key ${o.kid} secret must be ≥ 32 chars`);
      if (o?.status !== 'active' && o?.status !== 'previous') throw new Error(`JWT_KEYS: key ${o.kid} status must be 'active' or 'previous'`);
      return { kid: o.kid, secret: o.secret, status: o.status };
    });
  }
  const byKid = new Map<string, JwtKeyEntry>();
  for (const e of entries) {
    if (byKid.has(e.kid)) throw new Error(`JWT_KEYS: duplicate kid '${e.kid}'`);
    byKid.set(e.kid, e);
  }
  const active = entries.filter((e) => e.status === 'active');
  if (active.length !== 1) throw new Error(`JWT_KEYS: exactly one active key required (found ${active.length})`);
  return { active: active[0] as JwtKeyEntry, byKid };
}

@Injectable()
export class TokenService {
  private readonly active: JwtKeyEntry;
  private readonly ring: Map<string, Uint8Array>;
  readonly accessTtlSeconds = 900;

  constructor(@Inject('APP_CONFIG') config: AppConfig) {
    const { active, byKid } = parseKeyRing(config);
    this.active = active;
    this.ring = new Map([...byKid].map(([kid, e]) => [kid, new TextEncoder().encode(e.secret)]));
  }

  async signAccessToken(userId: string, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', kid: this.active.kid })
      .setSubject(userId)
      .setIssuer('daftar')
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.ring.get(this.active.kid) as Uint8Array);
  }

  async verifyAccessToken(token: string): Promise<{ sub: string; sid: string }> {
    let kid: string | undefined;
    try {
      const header = decodeProtectedHeader(token);
      kid = typeof header.kid === 'string' ? header.kid : undefined;
    } catch {
      throw new Error('malformed token');
    }
    // Unknown kid → reject outright; known kid → verify against exactly that key.
    const key = kid !== undefined ? this.ring.get(kid) : undefined;
    if (!key) throw new Error('unknown signing key');
    const { payload } = await jwtVerify(token, key, { issuer: 'daftar' });
    const sub = payload.sub;
    const sid = payload['sid'];
    if (typeof sub !== 'string' || typeof sid !== 'string') throw new Error('invalid token payload');
    return { sub, sid };
  }

  newRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  newSessionFamily(): string {
    return randomUUID();
  }
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenHashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function hashPassword(password: string): Promise<string> {
  // Argon2id, production-class parameters (ADR-012): contextual typing keeps the literal type.
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Credential delivery port (password reset etc.). The log adapter is the
 * deterministic development adapter — it announces itself and never claims a
 * real email was sent (§106: no fake production features).
 *
 * §15: TOKENS ARE NEVER LOGGED. The dev adapter writes the token to a local
 * mailbox FILE (gitignored dev artifact) and the log line contains only the
 * recipient and the file path.
 */
export interface CredentialDelivery {
  sendPasswordReset(email: string, token: string): Promise<void>;
  sendInvitation(email: string, token: string): Promise<void>;
  readonly kind: string;
}

export class LogDelivery implements CredentialDelivery {
  readonly kind = 'log-development-only';
  constructor(
    private readonly mailboxFile = './var/dev-mailbox.log',
    private readonly sink: (line: string) => void = () => undefined,
  ) {}
  private async deliver(kind: 'password-reset' | 'invitation', email: string, token: string): Promise<void> {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.mailboxFile), { recursive: true }).catch(() => undefined);
    await appendFile(this.mailboxFile, `${new Date().toISOString()} ${kind} email=${email} token=${token}\n`, 'utf8');
    // Log line carries NO token (§15).
    this.sink(`${kind} (DEV LOG DELIVERY — no real email): ${email} → dev mailbox ${this.mailboxFile}`);
  }
  sendPasswordReset(email: string, token: string): Promise<void> {
    return this.deliver('password-reset', email, token);
  }
  sendInvitation(email: string, token: string): Promise<void> {
    return this.deliver('invitation', email, token);
  }
}
