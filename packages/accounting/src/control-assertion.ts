/**
 * `acctctl/1` — the Accounting CONTROL Assertion (directive §29-§31).
 *
 * `assertion.ts` mints the authority to POST: it binds an actor to a source
 * identity and a posting fingerprint. Entering an FX rate is not a posting.
 * It writes no journal entry, it has no lines, it has no entry date and it is
 * not a source — so reusing the posting format for it would mean either
 * registering a fake source type, which corrupts the domain model, or
 * widening the posting verifier until "authority to post" and "authority to
 * configure" were one sentence.
 *
 * Hence a second format, on the SAME key material. Two secrets would mean two
 * rotations, two deployment variables and two ways to be misconfigured, for a
 * separation that cryptography can provide directly.
 *
 * Format — exactly eleven dot-separated components:
 *
 *   acctctl1.<kid>.<actor>.<tenant>.<business>.<command_kind>.<resource_id>
 *     .<payload_fingerprint>.<exp>.<jti>.<hmac>
 *
 * ── The domain separation, and why it is cryptographic (§30) ─────────────
 *
 * The MAC covers
 *
 *   'acctctl/1' + '\n' + <the ten claims joined by '.'>
 *
 * and NOT the claims alone. A posting assertion's MAC preimage is
 * `v1.<kid>.…` — its own claims joined by dots, with no prefix — and every
 * component of it is drawn from `[0-9a-f-]`, `[a-z_]` or digits. The bytes
 * `acctctl/1\n` contain `/` and a newline, neither of which can appear in any
 * posting preimage, so the two preimage sets are DISJOINT: no byte string is
 * a valid MAC input for both formats. Re-packing a posting assertion into
 * this shape does not help, because the verifier recomputes the MAC with the
 * prefix. The reverse holds too: `accounting_actor` demands twelve components
 * beginning `v1` and computes its MAC without a prefix.
 *
 * This module mints and parses. It never verifies — verification is the
 * database's, and a second implementation of it would be a second place for
 * the two to disagree.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { ACCOUNTING_ASSERTION_TTL_SECONDS, type AccountingAssertionKey } from './assertion';
import { AccountingError } from './errors';

/**
 * The control commands that exist. A speculative kind here would be an
 * authority the database has no routine to refuse, so new kinds arrive with
 * the command that consumes them: P2-S5 registered `fx_rate_enter`, and
 * P2-S6 registers exactly the three period commands it implements.
 *
 * Note what P2-S6 did NOT do: it did not invent a third assertion protocol.
 * `acctctl/1` already expresses "this actor, in this business, was authorized
 * for this command kind on this resource with this payload", which is exactly
 * what a period command needs. A second protocol over the same signing secret
 * would be separated only by its parser's shape, and a parser is not a
 * cryptographic boundary.
 */
export type AccountingControlCommandKind = 'fx_rate_enter' | 'period_create' | 'period_close' | 'period_reopen';

export const ACCOUNTING_CONTROL_COMMAND_KINDS: readonly AccountingControlCommandKind[] = ['fx_rate_enter', 'period_create', 'period_close', 'period_reopen'];

/** The literal bytes that separate this domain from the posting one. */
export const ACCTCTL_DOMAIN = 'acctctl/1';
/** The first component. Dot-free, because the components are dot-separated. */
export const ACCTCTL_VERSION = 'acctctl1';
export const ACCOUNTING_CONTROL_ASSERTION_COMPONENTS = 11;

export interface AccountingControlAssertionClaims {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly commandKind: AccountingControlCommandKind;
  /**
   * The thing the command acts on: the rate id being entered, or the period
   * being created, closed or reopened.
   */
  readonly resourceId: string;
  /**
   * The digest of every fact that identifies the command — `fxrate/1` for a
   * rate entry, `acctperiod/1` for a period command.
   */
  readonly payloadFingerprint: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reject = (what: string): never => {
  throw new AccountingError('accounting.assertion_malformed', `accounting control assertion ${what}`);
};

/** The ten signed components, in order. */
function claimComponents(kid: string, claims: AccountingControlAssertionClaims, exp: number, jti: string): string[] {
  const parts = [
    ACCTCTL_VERSION,
    kid,
    claims.actorUserId.toLowerCase(),
    claims.tenantId.toLowerCase(),
    claims.businessId.toLowerCase(),
    claims.commandKind,
    claims.resourceId.toLowerCase(),
    claims.payloadFingerprint.toLowerCase(),
    String(exp),
    jti.toLowerCase(),
  ];
  for (const p of parts) {
    if (p.length === 0 || p.includes('.')) reject('claims contain an illegal component');
  }
  return parts;
}

/** The exact bytes the MAC is taken over. Exported so a test can prove §30. */
export function controlAssertionPreimage(signedComponents: readonly string[]): string {
  return `${ACCTCTL_DOMAIN}\n${signedComponents.join('.')}`;
}

/**
 * Mint a control assertion for one already-authorized command.
 *
 * The caller has proved the actor is an authenticated active member holding
 * the required permission with business-wide branch authority; this function
 * only binds that decision to a specific payload via its fingerprint.
 */
export function mintAccountingControlAssertion(
  key: AccountingAssertionKey,
  claims: AccountingControlAssertionClaims,
  now: Date = new Date(),
  ttlSeconds: number = ACCOUNTING_ASSERTION_TTL_SECONDS,
): string {
  if (!UUID_RE.test(claims.actorUserId)) reject('requires an actor uuid');
  if (!UUID_RE.test(claims.tenantId)) reject('requires a tenant uuid');
  if (!UUID_RE.test(claims.businessId)) reject('requires a business uuid');
  if (!UUID_RE.test(claims.resourceId)) reject('requires a resource uuid');
  if (!/^[0-9a-f]{64}$/i.test(claims.payloadFingerprint)) reject('requires a sha-256 payload fingerprint');
  if (!ACCOUNTING_CONTROL_COMMAND_KINDS.includes(claims.commandKind)) reject('names an unregistered control command');
  // Bounded, not merely defaulted — the same reasoning as the posting format:
  // a parameter only tests are expected to pass is a parameter production
  // will eventually pass by accident.
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > ACCOUNTING_ASSERTION_TTL_SECONDS) {
    reject(`requires a ttl of 1 to ${ACCOUNTING_ASSERTION_TTL_SECONDS} seconds`);
  }

  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const parts = claimComponents(key.kid, claims, exp, randomUUID());
  const mac = createHmac('sha256', key.secret).update(controlAssertionPreimage(parts), 'utf8').digest('hex');
  return `${parts.join('.')}.${mac}`;
}

/**
 * Split a control assertion into its eleven components without verifying it.
 * Used by the tamper matrix, which rewrites exactly one claim and re-signs or
 * does not, and by the transport adapter to fail fast on an impossible value.
 */
export function splitAccountingControlAssertion(raw: string): string[] {
  const parts = raw.split('.');
  if (parts.length !== ACCOUNTING_CONTROL_ASSERTION_COMPONENTS || parts[0] !== ACCTCTL_VERSION) reject('is malformed');
  return parts;
}
