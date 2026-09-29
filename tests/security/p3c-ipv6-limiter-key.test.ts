import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { limiterKey } from '../../apps/api/src/common/client-ip';
import { createTestApp, type TestApp } from '../helpers/test-app';

/**
 * TD-19 review L-3: the per-client limits count an IPv6 client by its /64.
 *
 * One IPv6 subscriber is routinely delegated a /64 (or more) and can use any
 * of its 2^64 addresses, so counting single IPv6 addresses gives such a
 * client a fresh allowance per address. Every per-client limiter — the auth
 * limits (login, register, refresh, password reset) and the per-route
 * throttle — keys on the /64 of an IPv6 client. IPv4 is counted per address
 * as before, and an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is that IPv4
 * address.
 */

describe('L-3: the limiter key of a client address', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['::FFFF:203.0.113.9', '203.0.113.9'],
    ['0:0:0:0:0:ffff:cb00:7109', '203.0.113.9'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:0000:0000:0000:0001', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::203.0.113.9', '64:ff9b:0:0::/64'],
    ['unknown', 'unknown'],
  ])('%s → %s', (ip, key) => {
    expect(limiterKey(ip)).toBe(key);
  });
});

let t: TestApp;
let api: string;

/** A request as the trusted web server (127.0.0.1) forwards it for `client`. */
function forwardedFor(client: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<number> {
  const url = new URL(path, api);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { 'x-forwarded-for': client };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method, localAddress: '127.0.0.1', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const route = (client: string) => forwardedFor(client, 'GET', '/v1/me/businesses');
const login = (client: string, i: number) =>
  forwardedFor(client, 'POST', '/v1/auth/login', { email: `v6-${i}-${client.replace(/[^0-9a-f]/gi, '')}@example.com`, password: 'wrong-password-123' });

describe('L-3: IPv6 clients are counted per /64, IPv4 per address', () => {
  beforeAll(async () => {
    t = await createTestApp({ configOverrides: { TRUSTED_PROXIES: '127.0.0.1' } });
    await t.app.listen(0, '127.0.0.1');
    const address: unknown = t.app.getHttpServer().address();
    if (typeof address !== 'object' || address === null || !('port' in address)) throw new Error('the API is not listening on a port');
    api = `http://127.0.0.1:${String(address.port)}`;
  });
  afterAll(async () => {
    await t.close();
  });

  it('per-route: 300 from one address of a /64 spend the allowance of every address in it; another /64 keeps its own', async () => {
    for (let i = 0; i < 300; i += 1) expect(await route(`2001:db8:a:1::${(i + 1).toString(16)}`), `call ${i + 1}`).toBe(401);
    expect(await route('2001:db8:a:1:ffff::1')).toBe(429);
    expect(await route('2001:db8:a:2::1')).toBe(401);
  });

  it('per-route: an IPv4 client and its IPv4-mapped spelling are one client; its neighbour is another', async () => {
    for (let i = 0; i < 300; i += 1) expect(await route(i % 2 === 0 ? '198.51.100.7' : '::ffff:198.51.100.7'), `call ${i + 1}`).toBe(401);
    expect(await route('198.51.100.7')).toBe(429);
    expect(await route('198.51.100.8')).toBe(401);
  });

  it('login: 30 failures across a /64 lock the /64, not another one', async () => {
    for (let i = 0; i < 30; i += 1) expect(await login(`2001:db8:b:1::${(i + 1).toString(16)}`, i), `login ${i + 1}`).toBe(401);
    expect(await login('2001:db8:b:1::ffff', 99)).toBe(429);
    expect(await login('2001:db8:b:2::1', 100)).toBe(401);
  });
});
