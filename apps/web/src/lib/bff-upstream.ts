import 'server-only';
import { timingSafeEqual } from 'node:crypto';

/**
 * What the BFF tells the API about the browser behind a request (TD-19).
 *
 * The API rate-limits login, refresh, registration and password reset per
 * client address, and its `clientIp()` (`apps/api/src/common/client-ip.ts`)
 * stays the only authority on what that address is: it believes
 * `X-Forwarded-For` only from a socket peer listed in `TRUSTED_PROXIES`, and
 * then walks the chain right to left to the first hop it does not trust.
 *
 * The web server takes part in that chain as one more proxy. The production
 * entry (`apps/web/server.mts`) appends the TCP peer to `X-Forwarded-For` and
 * stamps the request with a secret generated at boot. This module forwards
 * the chain upstream only when that stamp is present and correct, so:
 *
 * - through the entry, the chain's last hop is the address that actually
 *   connected; a client-supplied value can only sit to its left, where the
 *   API never reaches it unless every hop to its right is a proxy the API
 *   trusts;
 * - any other way into a route handler (plain `next start`, `next dev`)
 *   forwards nothing, and the API then counts the web server itself: one
 *   shared allowance, never a caller-chosen one.
 *
 * The deployment must list the web server's address (and any load balancer in
 * front of it) in the API's `TRUSTED_PROXIES`; without that the API ignores
 * the header and every user of one web server shares one allowance again
 * (`docs/DAFTAR_AWS_REFERENCE_ARCHITECTURE.md`, "Client address chain").
 */

/** The request header the production entry stamps (see `apps/web/server.mts`). */
export const EDGE_TOKEN_HEADER = 'x-daftar-edge';
/** Where the production entry leaves the boot secret for the route handlers. */
export const EDGE_TOKEN_ENV = 'DAFTAR_WEB_EDGE_TOKEN';

/** Hops kept, counted from the right: the entries the API's walk can reach. */
const MAX_HOPS = 16;
/** The API drops longer entries as malformed (`client-ip.ts`); so does this. */
const MAX_HOP_LENGTH = 45;

function stampMatches(presented: string | null): boolean {
  const expected = process.env[EDGE_TOKEN_ENV];
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The `X-Forwarded-For` header to send upstream for this request, or no
 * header at all when the request did not come through the production entry.
 */
export function clientAddressHeaders(req: Request): Record<string, string> {
  if (!stampMatches(req.headers.get(EDGE_TOKEN_HEADER))) return {};
  const chain = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0 && hop.length <= MAX_HOP_LENGTH);
  if (chain.length === 0) return {};
  return { 'x-forwarded-for': chain.slice(-MAX_HOPS).join(', ') };
}

/** The upstream `Retry-After`, when it is a plain number of seconds. */
export function retryAfterHeaders(res: Response): Record<string, string> {
  const value = res.headers.get('retry-after');
  return value !== null && /^\d{1,6}$/.test(value) ? { 'retry-after': value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The upstream JSON object body, or null when there is none or it is not a JSON object. */
export async function upstreamJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch (e: unknown) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}
