import { createHmac, randomUUID } from 'node:crypto';

/**
 * Provisioning assertions (Final Release Blocker 1).
 *
 * The provisioning SECURITY DEFINER commands derive the ACTOR from an
 * assertion the API mints for the authenticated principal — never from a
 * caller-settable GUC. The database verifies the HMAC with a key that no
 * runtime role can read (migration 0038), so a connection that only holds the
 * daftar_provisioner credential cannot impersonate anyone.
 *
 * Format: v1.<kid>.<actor uuid>.<kind>.<expires epoch s>.<jti uuid>.<hmac-sha256 hex>
 * Bound to ONE operation kind, short-lived, and single-use per transaction.
 */
export type ProvisioningKind = 'onboarding' | 'create_business' | 'accept_invitation';

export interface ProvisioningAssertionKey {
  kid: string;
  secret: Buffer;
}

export const PROVISIONING_ASSERTION_TTL_SECONDS = 60;

export function parseProvisioningAssertionKey(config: {
  PROVISIONING_ASSERTION_KEY?: string | undefined;
  PROVISIONING_ASSERTION_KID?: string | undefined;
}): ProvisioningAssertionKey | null {
  if (!config.PROVISIONING_ASSERTION_KEY) return null;
  const secret = Buffer.from(config.PROVISIONING_ASSERTION_KEY, 'base64');
  if (secret.length < 32) throw new Error('PROVISIONING_ASSERTION_KEY must be base64 of at least 32 bytes');
  const kid = config.PROVISIONING_ASSERTION_KID ?? 'v1';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error('PROVISIONING_ASSERTION_KID must match ^[A-Za-z0-9_-]{1,32}$');
  return { kid, secret };
}

export function mintProvisioningAssertion(
  key: ProvisioningAssertionKey,
  actorUserId: string,
  kind: ProvisioningKind,
  now: Date = new Date(),
  ttlSeconds: number = PROVISIONING_ASSERTION_TTL_SECONDS,
): string {
  if (!/^[0-9a-f-]{36}$/i.test(actorUserId)) throw new Error('provisioning assertion requires an actor uuid');
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const claims = ['v1', key.kid, actorUserId, kind, String(exp), randomUUID()].join('.');
  const mac = createHmac('sha256', key.secret).update(claims, 'utf8').digest('hex');
  return `${claims}.${mac}`;
}
