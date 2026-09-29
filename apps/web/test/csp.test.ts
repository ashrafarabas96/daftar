import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { createNonce, pageCsp } from '@/lib/csp';
import { middleware } from '@/middleware';

/**
 * The page CSP carries a per-request nonce (real-browser finding D-1): a bare
 * `script-src 'self'` blocks Next's inline bootstrap and every page stays
 * blank. The policy must stay strict — a nonce, `'strict-dynamic'`, never
 * `'unsafe-inline'` for scripts, no `'unsafe-eval'` in production — and the
 * nonce must differ on every request.
 */

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name = '', ...values]) => [name, values]),
  );

const CSP = 'content-security-policy';

function pageResponse(path: string) {
  const res = middleware(new NextRequest(`http://localhost${path}`, { headers: { 'accept-language': 'en' } }));
  const policy = res.headers.get(CSP) ?? '';
  // NextResponse.next({ request: { headers } }) forwards the request headers as x-middleware-request-*.
  const requestPolicy = res.headers.get(`x-middleware-request-${CSP}`);
  const requestNonce = res.headers.get('x-middleware-request-x-nonce');
  return { res, policy, requestPolicy, requestNonce };
}

describe('the page CSP (D-1)', () => {
  it('a nonce is 128 random bits in base64, fresh each time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const nonce = createNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(64);
  });

  it('production: nonce + strict-dynamic, no unsafe-inline or unsafe-eval for scripts, every other directive strict', () => {
    const d = directives(pageCsp('abc123==', { production: true }));
    expect(d.get('script-src')).toEqual([`'self'`, `'nonce-abc123=='`, `'strict-dynamic'`]);
    expect(d.get('default-src')).toEqual([`'self'`]);
    expect(d.get('connect-src')).toEqual([`'self'`]);
    expect(d.get('img-src')).toEqual([`'self'`, 'data:']);
    expect(d.get('font-src')).toEqual([`'self'`]);
    expect(d.get('object-src')).toEqual([`'none'`]);
    expect(d.get('frame-ancestors')).toEqual([`'none'`]);
    expect(d.get('base-uri')).toEqual([`'self'`]);
    expect(d.get('form-action')).toEqual([`'self'`]);
    expect(d.has('upgrade-insecure-requests')).toBe(true);
    expect(d.get('style-src')).toEqual([`'self'`, `'unsafe-inline'`]);
    for (const [name, values] of d) {
      if (name !== 'style-src') expect(values, name).not.toContain(`'unsafe-inline'`);
      expect(values, name).not.toContain(`'unsafe-eval'`);
      expect(values, name).not.toContain('*');
    }
  });

  it('development adds only unsafe-eval (React refresh), never unsafe-inline', () => {
    const script = directives(pageCsp('n', { production: false })).get('script-src');
    expect(script).toEqual([`'self'`, `'nonce-n'`, `'strict-dynamic'`, `'unsafe-eval'`]);
  });

  it('the middleware sends the policy on the response AND on the request (so Next stamps its scripts), with a nonce that differs per request', () => {
    const a = pageResponse('/en/login');
    const b = pageResponse('/en/login');
    for (const r of [a, b]) {
      const script = directives(r.policy).get('script-src') ?? [];
      const nonceSource = script.find((s) => s.startsWith(`'nonce-`));
      expect(nonceSource).toBe(`'nonce-${r.requestNonce ?? 'missing'}'`);
      expect(script).toContain(`'strict-dynamic'`);
      expect(script).not.toContain(`'unsafe-inline'`);
      expect(r.requestPolicy).toBe(r.policy);
    }
    expect(a.requestNonce).not.toBe(b.requestNonce);
    expect(a.policy).not.toBe(b.policy);
  });

  it('a locale redirect carries the policy too', () => {
    const r = pageResponse('/stock');
    expect(r.res.status).toBe(307);
    expect(r.res.headers.get('location')).toBe('http://localhost/en/stock');
    expect(
      directives(r.policy)
        .get('script-src')
        ?.some((s) => s.startsWith(`'nonce-`)),
    ).toBe(true);
  });

  it('next.config keeps no nonce-less CSP on pages (it would be enforced alongside and block the bootstrap), and keeps the static policy on /api and /_next', () => {
    const config = readFileSync(fileURLToPath(new URL('../next.config.mjs', import.meta.url)), 'utf8');
    expect(config).not.toMatch(/source: '\/:path\*', headers: \[staticCsp\]/);
    expect(config).toMatch(/source: '\/api\/:path\*', headers: \[staticCsp\]/);
    expect(config).toMatch(/source: '\/_next\/:path\*', headers: \[staticCsp\]/);
    expect(config).not.toMatch(/unsafe-eval/);
    expect(config).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('the pages render per request: the root layout forces dynamic rendering', () => {
    const layout = readFileSync(fileURLToPath(new URL('../src/app/[locale]/layout.tsx', import.meta.url)), 'utf8');
    expect(layout).toMatch(/^export const dynamic = 'force-dynamic';$/m);
  });
});
