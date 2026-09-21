import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/api';

/** BFF proxy to the PLATFORM API only (browser stays same-origin; CSP 'self'). */
async function handler(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const target = `${API_URL}/v1/${path.join('/')}${url.search}`;
  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'idempotency-key']) {
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
