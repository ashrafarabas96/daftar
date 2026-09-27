import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/api';

/**
 * BFF catch-all proxy (ADR-001): the browser only ever talks to its own
 * origin (CSP connect-src 'self'); this route forwards to the merchant API.
 * The refresh-token cookie is path-scoped to /api/auth and is therefore never
 * forwarded here. The access token arrives as an Authorization header from
 * in-memory JS state and is passed through.
 *
 * P3-S7 (contract A-12(1)):
 * - PUT is exported, so the Phase 3 PUTs (purchase draft, stocktake counts,
 *   supplier and payment-method updates, product configuration) do not 405;
 * - `accept-language` travels upstream, so the reads resolve names in the
 *   page's locale;
 * - every answer goes back with `cache-control: no-store`, whatever the API
 *   sent, so no layer between the API and the browser keeps a copy of a live
 *   stock or balance read (A-03(5)) — independent of the API's own header.
 *
 * Path safety: Next hands the catch-all segments over DECODED, so `%2F`,
 * `%3F` and `%23` inside a segment arrive as `/`, `?` and `#`, and `..` would
 * be normalised by `fetch()`. A page that puts a URL-derived id into a
 * command path could then be steered to another route with the caller's own
 * token. So a segment that is empty, `.` or `..`, or holds `/`, `\`, `?`, `#`
 * or a control character is refused with 400 before anything is sent; every
 * other segment is re-encoded, and the target must still sit under `/v1/`.
 */
const FORWARDED = ['authorization', 'content-type', 'x-business-id', 'idempotency-key', 'accept-language'];

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
  // /v1 is prepended here, exactly once (P1-GOLD-37).
  const target = `${API_URL}/v1/${path.join('/')}${url.search}`;
  if (!new URL(target).pathname.startsWith(new URL(`${API_URL}/v1/`).pathname)) return refused();
  const headers = new Headers();
  for (const name of FORWARDED) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  // Bodies are forwarded as raw bytes so multipart uploads (media) survive intact.
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  const res = await fetch(target, { method: req.method, headers, body });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
