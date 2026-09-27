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
 * - the API's `cache-control` travels back, falling back to `no-store`, so no
 *   layer between the API and the browser keeps a copy of a live stock or
 *   balance read (A-03(5)).
 */
const FORWARDED = ['authorization', 'content-type', 'x-business-id', 'idempotency-key', 'accept-language'];

async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${API_URL}/v1/${path.join('/')}${url.search}`;
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
      'cache-control': res.headers.get('cache-control') ?? 'no-store',
    },
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
