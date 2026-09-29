/**
 * `invctl/1` — the Inventory Command Assertion (P3-AL-55).
 *
 * `EXECUTE` on an inventory routine is transport reachability only. A
 * caller-settable GUC is not authorization: anything holding the `daftar_app`
 * credential can set `app.tenant_id`, `app.business_id` and
 * `app.actor_user_id` itself. The merchant API therefore mints this assertion
 * AFTER authentication, membership, domain permission, branch/warehouse scope
 * and payload validation (§I), and the database routine verifies it against
 * key material no runtime role can read, then consumes it exactly once (§G–§H).
 *
 * Format — exactly ten ASCII components separated by `.` (§D):
 *
 *   invctl1.<kid>.<actor>.<tenant>.<business>.<wire_op>.<payload_sha256>
 *     .<exp>.<jti>.<mac>
 *
 *   mac = lowercase hex HMAC-SHA-256(secret, 'invctl/1' LF c1 '.' … '.' c9)
 *
 * The literal `invctl/1` + LF prefix makes the preimage language disjoint
 * from every other signed format in DAFTAR: provisioning and posting
 * preimages begin `v1.`, the accounting control preimage begins `acctctl/1`
 * + LF. The separate key (its own table, its own variable, byte-distinct from
 * the provisioning and accounting keys) already makes substitution fail; the
 * prefix makes it fail even if a key were ever shared by mistake.
 *
 * The verifier REFUSES any non-canonical component and never lowercases,
 * trims or normalizes one into acceptance, so the minter refuses to produce
 * one: an uppercase UUID is an error here, not something to fix up.
 *
 * This module mints and splits. It never reads configuration and NEVER
 * verifies — verification is the database's, and a second implementation of
 * it would be a second place for the two to disagree.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { InventoryError } from './errors';
import { CANONICAL_UUID_RE, isInventoryOperationCode, OPERATION_CODE_RE, type InventoryOperationCode } from './payload';

/** The literal bytes that open every MAC preimage. */
export const INVCTL_DOMAIN = 'invctl/1';
/** Component 1. The dot-free spelling of the domain, since `.` separates components. */
export const INVCTL_VERSION = 'invctl1';
export const INVENTORY_ASSERTION_COMPONENTS = 10;

/**
 * Short enough that a captured assertion is useless before it can be
 * replayed. The database refuses `exp` more than 65 seconds ahead of its own
 * clock (60 plus a fixed 5-second skew allowance), so even a defective minter
 * cannot issue a long-lived assertion the database accepts.
 */
export const INVENTORY_ASSERTION_TTL_SECONDS = 60;

export const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const WIRE_OPERATION_CODE_RE = /^[a-z]+(:[a-z_]+)+$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const EXP_RE = /^[1-9][0-9]{0,18}$/;
const STANDARD_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** The key material the minter signs with. Mirrors `inventory_assertion_keys`' CHECKs. */
export interface InventoryAssertionKey {
  readonly kid: string;
  readonly secret: Buffer;
}

export interface InventoryAssertionClaims {
  /** The authenticated user. Canonical lowercase UUID. */
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
  /** The operation kind IS the server-side decision; no permission string is ever carried. */
  readonly opCode: InventoryOperationCode;
  /** Lowercase hex SHA-256 of the `invpl/1` stream for this exact command. */
  readonly payloadSha256: string;
  /** Fixed only by tests and vectors; a fresh random UUID otherwise. */
  readonly jti?: string;
}

/** The ten components of an assertion, by name. Structure only — never verified. */
export interface InventoryAssertionParts {
  readonly version: string;
  readonly kid: string;
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
  /** The operation in wire form (`:` for `.`). */
  readonly wireOperation: string;
  readonly payloadSha256: string;
  /** Unix epoch seconds as the base-10 string that was signed. */
  readonly exp: string;
  readonly jti: string;
  readonly mac: string;
  /** All ten components, in order. */
  readonly components: readonly string[];
}

const reject = (what: string): never => {
  throw new InventoryError('inventory.assertion_malformed', `inventory assertion ${what}`);
};

/**
 * Validate the configured inventory key. Mirrors the database's own CHECKs
 * (`kid ~ '^[A-Za-z0-9_-]{1,32}$'`, `octet_length(secret) >= 32`) so a
 * misconfigured deployment fails at startup rather than at the first command.
 * The error messages never include the key or any part of it.
 */
export function parseInventoryAssertionKey(input: { kid: string; keyBase64: string }): InventoryAssertionKey {
  if (typeof input.kid !== 'string' || !KID_RE.test(input.kid)) {
    throw new Error('INVENTORY_ASSERTION_KID must match ^[A-Za-z0-9_-]{1,32}$');
  }
  // `Buffer.from(…, 'base64')` silently drops characters outside the
  // alphabet, which would turn a mangled key into a different, shorter one.
  // Refuse anything that is not plain base64 instead.
  if (typeof input.keyBase64 !== 'string' || !STANDARD_BASE64_RE.test(input.keyBase64)) {
    throw new Error('INVENTORY_ASSERTION_KEY must be standard base64');
  }
  const secret = Buffer.from(input.keyBase64, 'base64');
  if (secret.length < 32) throw new Error('INVENTORY_ASSERTION_KEY must be base64 of at least 32 bytes');
  return { kid: input.kid, secret };
}

/**
 * True when two secrets are the same bytes. P3-AL-55 §C forbids the inventory
 * key being byte-equal to the provisioning or the accounting key: separate
 * variable names are not separation. Compared in constant time so this helper
 * cannot itself become an oracle. Defined here rather than imported from
 * `@daftar/accounting` so the inventory key domain has no dependency on the
 * ledger's package.
 */
export function secretsAreIdentical(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `inventory.configure_product` → `inventory:configure_product`. A bijection: `op_code` cannot contain `:`. */
export function wireOperationCode(opCode: InventoryOperationCode): string {
  if (!isInventoryOperationCode(opCode) || !OPERATION_CODE_RE.test(opCode)) reject('names an unregistered operation kind');
  const wire = opCode.replace(/\./g, ':');
  if (!WIRE_OPERATION_CODE_RE.test(wire)) reject('produced a non-canonical wire operation');
  return wire;
}

/** The inverse of `wireOperationCode`. Refuses a malformed or unregistered wire operation. */
export function operationCodeFromWire(wire: string): InventoryOperationCode {
  if (typeof wire !== 'string' || !WIRE_OPERATION_CODE_RE.test(wire)) reject('carries a malformed wire operation');
  const opCode = wire.replace(/:/g, '.');
  if (!isInventoryOperationCode(opCode)) return reject('names an unregistered operation kind');
  return opCode;
}

/** The exact bytes the MAC is taken over (§D). Exported so a test can prove the domain prefix. */
export function inventoryAssertionPreimage(signedComponents: readonly string[]): Buffer {
  if (signedComponents.length !== INVENTORY_ASSERTION_COMPONENTS - 1) reject('preimage requires exactly nine components');
  return Buffer.from(`${INVCTL_DOMAIN}\n${signedComponents.join('.')}`, 'utf8');
}

/**
 * Mint an assertion for one already-authorized command.
 *
 * The caller has proved the actor's authentication, membership, domain
 * permission and warehouse/branch scope, and has computed `payloadSha256`
 * over the exact arguments it will pass to the routine; this function only
 * binds that decision. `now` is explicit so no hidden clock decides expiry.
 *
 * `ttlSeconds` is BOUNDED, not merely defaulted: it exists so a test can mint
 * a shorter-lived assertion, and a parameter only tests are expected to pass
 * is a parameter production will eventually pass by accident. Nothing may
 * mint one that outlives sixty seconds.
 */
export function mintInventoryAssertion(
  claims: InventoryAssertionClaims,
  key: InventoryAssertionKey,
  now: Date,
  ttlSeconds: number = INVENTORY_ASSERTION_TTL_SECONDS,
): string {
  if (!KID_RE.test(key.kid)) reject('requires a kid matching ^[A-Za-z0-9_-]{1,32}$');
  if (!Buffer.isBuffer(key.secret) || key.secret.length < 32) reject('requires a secret of at least 32 bytes');
  if (!CANONICAL_UUID_RE.test(claims.actorUserId)) reject('requires a canonical lowercase actor uuid');
  if (!CANONICAL_UUID_RE.test(claims.tenantId)) reject('requires a canonical lowercase tenant uuid');
  if (!CANONICAL_UUID_RE.test(claims.businessId)) reject('requires a canonical lowercase business uuid');
  if (!SHA256_HEX_RE.test(claims.payloadSha256)) reject('requires a lowercase hex sha-256 payload digest');
  const wireOp = wireOperationCode(claims.opCode);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > INVENTORY_ASSERTION_TTL_SECONDS) {
    reject(`requires a ttl of 1 to ${INVENTORY_ASSERTION_TTL_SECONDS} seconds`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) reject('requires a valid minting time');

  const exp = String(Math.floor(now.getTime() / 1000) + ttlSeconds);
  if (!EXP_RE.test(exp)) reject('produced a non-canonical expiry');

  const jti = claims.jti ?? randomUUID();
  if (!CANONICAL_UUID_RE.test(jti)) reject('requires a canonical lowercase jti uuid');

  const signed = [INVCTL_VERSION, key.kid, claims.actorUserId, claims.tenantId, claims.businessId, wireOp, claims.payloadSha256, exp, jti];
  // Every component was checked against its own pattern above, none of which
  // admits `.`, whitespace or an empty string. Re-assert the framing so a
  // future edit to one pattern cannot make one claim readable as two.
  for (const c of signed) {
    if (c.length === 0 || c.includes('.') || /\s/.test(c)) reject('claims contain an illegal component');
  }
  const mac = createHmac('sha256', key.secret).update(inventoryAssertionPreimage(signed)).digest('hex');
  return `${signed.join('.')}.${mac}`;
}

/**
 * Split an assertion into its ten named components WITHOUT verifying it.
 * Checks only the component count and the version prefix; it never checks a
 * component's pattern and never touches the MAC. Used by the tamper matrix,
 * which rewrites exactly one claim, and by the transport adapter to fail fast
 * on a structurally impossible value. Verification remains the database's.
 */
export function splitInventoryAssertion(raw: string): InventoryAssertionParts {
  if (typeof raw !== 'string') return reject('is not a string');
  const c = raw.split('.');
  if (c.length !== INVENTORY_ASSERTION_COMPONENTS || c[0] !== INVCTL_VERSION) return reject('is malformed');
  const [version, kid, actorUserId, tenantId, businessId, wireOperation, payloadSha256, exp, jti, mac] = c as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return { version, kid, actorUserId, tenantId, businessId, wireOperation, payloadSha256, exp, jti, mac, components: c };
}
