/**
 * The Accounting Command Assertion (AL-03, directive §14).
 *
 * A caller-settable GUC is not authorization. `app.tenant_id`,
 * `app.business_id` and `app.actor_user_id` can all be set by anything holding
 * the `daftar_app` credential, so a stolen credential could otherwise name a
 * victim's tenant, a genuinely active member, and post. The assertion closes
 * that hole: the merchant API mints it AFTER authentication, membership, RBAC
 * and branch-scope checks, and the database verifies the HMAC against key
 * material no runtime role can read.
 *
 * Format — exactly twelve dot-separated components:
 *
 *   v1.<kid>.<actor>.<tenant>.<business>.<kind>.<source_type>.<source_id>
 *     .<fingerprint>.<exp>.<jti>.<hmac>
 *
 * The signature covers the first eleven, so every claim is bound: swapping the
 * business, the source, the actor or the fingerprint after minting invalidates
 * it. Because the FINGERPRINT is signed, the payload is bound too — the
 * database recomputes the fingerprint from the actual lines it received and
 * refuses a mismatch before any write (§27).
 *
 * This module mints and parses. It never reads configuration and never
 * verifies — verification is the database's job, and duplicating it here would
 * create a second place for the two to disagree.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AccountingError } from './errors';

/**
 * The operation kinds that exist. P2-S3 registered one; P2-S4 registers
 * `reverse`, because a reversal is written by a different routine under
 * different rules and an assertion minted to post must not be able to drive
 * it. Which kind may carry which source identity is data in the database's
 * `accounting_operation_kinds` registry, not a rule duplicated here.
 * Speculative kinds are still not registered.
 */
export type AccountingOperationKind = 'post' | 'reverse';

export const ACCOUNTING_OPERATION_KINDS: readonly AccountingOperationKind[] = ['post', 'reverse'];

export interface AccountingAssertionKey {
  readonly kid: string;
  readonly secret: Buffer;
}

/** Short enough that a captured assertion is useless before it can be replayed. */
export const ACCOUNTING_ASSERTION_TTL_SECONDS = 60;

export const ACCOUNTING_ASSERTION_COMPONENTS = 12;

export interface AccountingAssertionClaims {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly operationKind: AccountingOperationKind;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly postingFingerprint: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reject = (what: string): never => {
  throw new AccountingError('accounting.assertion_malformed', `accounting assertion ${what}`);
};

/**
 * Validate an accounting assertion key. Mirrors the database's own CHECKs so a
 * misconfigured deployment fails at startup rather than at the first posting.
 */
export function parseAccountingAssertionKey(config: {
  ACCOUNTING_ASSERTION_KEY?: string | undefined;
  ACCOUNTING_ASSERTION_KID?: string | undefined;
}): AccountingAssertionKey | null {
  if (!config.ACCOUNTING_ASSERTION_KEY) return null;
  const secret = Buffer.from(config.ACCOUNTING_ASSERTION_KEY, 'base64');
  if (secret.length < 32) throw new Error('ACCOUNTING_ASSERTION_KEY must be base64 of at least 32 bytes');
  const kid = config.ACCOUNTING_ASSERTION_KID ?? 'v1';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error('ACCOUNTING_ASSERTION_KID must match ^[A-Za-z0-9_-]{1,32}$');
  return { kid, secret };
}

/**
 * True when two secrets are the same bytes. §19 forbids the accounting and
 * provisioning keys being equal in production: a provisioning-key compromise
 * must not automatically become a ledger compromise, and sharing one secret
 * would make the two domains one. Compared in constant time so this helper
 * cannot itself become an oracle.
 */
export function secretsAreIdentical(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The eleven signed components, in order. */
function claimComponents(kid: string, claims: AccountingAssertionClaims, exp: number, jti: string): string[] {
  const parts = [
    'v1',
    kid,
    claims.actorUserId.toLowerCase(),
    claims.tenantId.toLowerCase(),
    claims.businessId.toLowerCase(),
    claims.operationKind,
    claims.sourceType,
    claims.sourceId.toLowerCase(),
    claims.postingFingerprint.toLowerCase(),
    String(exp),
    jti.toLowerCase(),
  ];
  // A component containing the separator would make the assertion ambiguous
  // and could let one claim be read as two.
  for (const p of parts) {
    if (p.length === 0 || p.includes('.')) reject('claims contain an illegal component');
  }
  return parts;
}

/**
 * Mint an assertion for one posting command.
 *
 * The caller has already proved the actor is an authenticated active member
 * holding `accounting.post` within a validated branch scope; this function
 * only binds that decision to a specific payload via its fingerprint.
 */
export function mintAccountingAssertion(
  key: AccountingAssertionKey,
  claims: AccountingAssertionClaims,
  now: Date = new Date(),
  ttlSeconds: number = ACCOUNTING_ASSERTION_TTL_SECONDS,
): string {
  if (!UUID_RE.test(claims.actorUserId)) reject('requires an actor uuid');
  if (!UUID_RE.test(claims.tenantId)) reject('requires a tenant uuid');
  if (!UUID_RE.test(claims.businessId)) reject('requires a business uuid');
  if (!UUID_RE.test(claims.sourceId)) reject('requires a source uuid');
  if (!/^[0-9a-f]{64}$/i.test(claims.postingFingerprint)) reject('requires a sha-256 posting fingerprint');
  if (!ACCOUNTING_OPERATION_KINDS.includes(claims.operationKind)) reject('names an unregistered operation kind');
  if (!/^[a-z_]{1,64}$/.test(claims.sourceType)) reject('requires a registered source type');
  // The TTL is BOUNDED, not merely defaulted. `ttlSeconds` exists so a test
  // can mint a shorter-lived assertion, and a parameter that only tests are
  // expected to pass is a parameter production will eventually pass by
  // accident. AL-03 fixes accounting assertions at sixty seconds; nothing —
  // a retry wrapper, a queue, a batch job, a future overload — may mint one
  // that outlives that, so the ceiling is enforced here rather than trusted
  // to every call site that omits the argument.
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > ACCOUNTING_ASSERTION_TTL_SECONDS) {
    reject(`requires a ttl of 1 to ${ACCOUNTING_ASSERTION_TTL_SECONDS} seconds`);
  }

  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const parts = claimComponents(key.kid, claims, exp, randomUUID());
  const mac = createHmac('sha256', key.secret).update(parts.join('.'), 'utf8').digest('hex');
  return `${parts.join('.')}.${mac}`;
}

/**
 * Split an assertion into its twelve components without verifying it. Used by
 * tests that tamper with exactly one claim, and by the transport adapter to
 * fail fast on a structurally impossible value. Verification remains the
 * database's, and only the database's.
 */
export function splitAccountingAssertion(raw: string): string[] {
  const parts = raw.split('.');
  if (parts.length !== ACCOUNTING_ASSERTION_COMPONENTS || parts[0] !== 'v1') reject('is malformed');
  return parts;
}
