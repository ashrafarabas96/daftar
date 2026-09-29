import { createServer, type IncomingHttpHeaders } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import next from 'next';

/**
 * The admin console's production entry (TD-19): `next start`, plus the one
 * thing a Next route handler cannot do for itself — see the TCP peer. The
 * same entry as `apps/web/server.mts` (the two are held equal, apart from the
 * default port, by `tests/security/p3c-bff-entry-parity.test.ts`).
 *
 * The API rate-limits login, refresh, registration and password reset per
 * client address, resolved by its `clientIp()` against `TRUSTED_PROXIES`
 * (`apps/api/src/common/client-ip.ts`): XFF is walked right to left and the
 * first untrusted hop is the client. For that walk to find the browser rather
 * than the web server, the web server has to behave as a proxy does — append
 * the address that connected to it to `X-Forwarded-For` — and the API has to
 * list the web server in `TRUSTED_PROXIES`.
 *
 * Next hands a route handler the request headers only. `next start` fills
 * `X-Forwarded-For` with the peer only when the caller sent none (`??=`), so
 * a caller that sends one is indistinguishable from a proxy chain. This entry
 * therefore wraps Next's handler and, before Next sees the request:
 *
 * - appends the socket peer to whatever `X-Forwarded-For` arrived, exactly as
 *   a reverse proxy does (a client-supplied value stays to the LEFT of the
 *   peer, where the API's right-to-left walk never reaches it unless every
 *   hop to its right is a proxy the API trusts);
 * - stamps `x-daftar-edge` with a secret generated at boot and handed to the
 *   route handlers through the process environment, overwriting whatever the
 *   caller sent in that header.
 *
 * The admin BFF (`src/lib/bff-upstream.ts`) forwards `X-Forwarded-For` upstream only
 * when the stamp matches, so a process started some other way (plain
 * `next start`, `next dev`) forwards nothing: every caller is then the web
 * server itself to the API — one shared allowance, never a spoofable one.
 */

/** The request header carrying the boot secret from this entry to the BFF. */
export const EDGE_TOKEN_HEADER = 'x-daftar-edge';
/** The environment variable the BFF reads the boot secret from. */
export const EDGE_TOKEN_ENV = 'DAFTAR_WEB_EDGE_TOKEN';

/**
 * Append `peer` to `X-Forwarded-For` and stamp the edge token, in place.
 * Whatever the caller sent in the token header is removed first; without a
 * peer address (a socket already gone) nothing is stamped, and the BFF then
 * forwards no address at all.
 */
export function stampPeer(headers: IncomingHttpHeaders, peer: string | undefined, token: string): void {
  delete headers[EDGE_TOKEN_HEADER];
  if (!peer) return;
  const prior = headers['x-forwarded-for'];
  const chain = (Array.isArray(prior) ? prior.join(', ') : (prior ?? '')).trim();
  headers['x-forwarded-for'] = chain.length > 0 ? `${chain}, ${peer}` : peer;
  headers[EDGE_TOKEN_HEADER] = token;
}

async function main(): Promise<void> {
  const token = randomBytes(32).toString('hex');
  process.env[EDGE_TOKEN_ENV] = token;
  const port = Number(process.env['PORT'] ?? 3100);
  const app = next({ dev: false, dir: fileURLToPath(new URL('.', import.meta.url)), port });
  await app.prepare();
  const handle = app.getRequestHandler();
  createServer((req, res) => {
    stampPeer(req.headers, req.socket.remoteAddress, token);
    void handle(req, res);
  }).listen(port, () => {
    process.stdout.write(`daftar admin listening on ${port}\n`);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
