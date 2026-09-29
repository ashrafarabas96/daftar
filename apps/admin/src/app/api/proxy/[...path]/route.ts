import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '../../../../lib/api';
import { clientAddressHeaders, retryAfterHeaders } from '../../../../lib/bff-upstream';

/**
 * BFF proxy to the PLATFORM API only (browser stays same-origin; CSP 'self').
 *
 * TD-19: the password-reset endpoints the proxy can reach are limited per
 * client address, so the entry-stamped address chain travels upstream, and a
 * 429 or 503 keeps the API's Retry-After on the way back.
 *
 * Path safety (security review L-1, the web proxy's rule): Next hands the
 * catch-all segments over DECODED, so `%2F`, `%3F`, `%23` and `%5C` inside a
 * segment arrive as `/`, `?`, `#` and `\`, and `..` would be normalised by
 * `fetch()` — an operator's request could be steered to another platform
 * route with the operator's own token. A segment that is empty, `.` or `..`,
 * or holds `/`, `\`, `?`, `#` or a control character is refused with 400
 * before anything is sent; every other segment is re-encoded, and the target
 * must still sit under `/v1/`.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses.
const UNSAFE_SEGMENT = /[/\\?#\u0000-\u001f\u007f]/;

/** The decoded segments, each re-encoded, or null when a segment could leave its place. */
function encodedSegments(segments: readonly string[]): string[] | null {
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || UNSAFE_SEGMENT.test(segment)) return null;
  }
  return segments.map((segment) => encodeURIComponent(segment));
}

const refused = () =>
  new NextResponse(JSON.stringify({ error: { code: 'VALIDATION_FAILED' } }), {
    status: 400,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: decoded } = await ctx.params;
  const url = new URL(req.url);
  const path = encodedSegments(decoded);
  if (path === null) return refused();
  const target = `${API_URL}/v1/${path.join('/')}${url.search}`;
  if (!new URL(target).pathname.startsWith(new URL(`${API_URL}/v1/`).pathname)) return refused();
  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'idempotency-key']) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  for (const [name, value] of Object.entries(clientAddressHeaders(req))) headers.set(name, value);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
  const res = await fetch(target, { method: req.method, headers, body });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', ...retryAfterHeaders(res) },
  });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
