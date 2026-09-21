import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/api';

/**
 * BFF catch-all proxy (ADR-001): the browser only ever talks to its own
 * origin (CSP connect-src 'self'); this route forwards to the merchant API.
 * The refresh-token cookie is path-scoped to /api/auth and is therefore never
 * forwarded here. The access token arrives as an Authorization header from
 * in-memory JS state and is passed through.
 */
async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${API_URL}/v1/${path.join('/')}${url.search}`;
  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'x-business-id', 'idempotency-key']) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
  const res = await fetch(target, { method: req.method, headers, body });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
