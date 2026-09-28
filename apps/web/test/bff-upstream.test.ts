import { afterEach, describe, expect, it } from 'vitest';
import * as entry from '../server.mjs';
import { EDGE_TOKEN_ENV, EDGE_TOKEN_HEADER, clientAddressHeaders, retryAfterHeaders, upstreamJson } from '@/lib/bff-upstream';

/**
 * TD-19: the BFF's side of the production entry's stamp. The entry
 * (`server.mts`) cannot import this module (it is `server-only` and bundled by
 * Next), so the two copies of the names are pinned equal here.
 */
const stamped = (token: string, xff: string) => new Request('http://web.test/', { headers: { [EDGE_TOKEN_HEADER]: token, 'x-forwarded-for': xff } });

afterEach(() => {
  delete process.env[EDGE_TOKEN_ENV];
});

describe('TD-19 bff-upstream', () => {
  it('names the same header and environment variable as the production entry', () => {
    expect(EDGE_TOKEN_HEADER).toBe(entry.EDGE_TOKEN_HEADER);
    expect(EDGE_TOKEN_ENV).toBe(entry.EDGE_TOKEN_ENV);
  });

  it('forwards the chain only for the exact boot secret', () => {
    process.env[EDGE_TOKEN_ENV] = 's'.repeat(64);
    expect(clientAddressHeaders(stamped('s'.repeat(64), '203.0.113.1, 192.0.2.1'))).toEqual({ 'x-forwarded-for': '203.0.113.1, 192.0.2.1' });
    expect(clientAddressHeaders(stamped('s'.repeat(63), '203.0.113.1'))).toEqual({});
    expect(clientAddressHeaders(stamped('t'.repeat(64), '203.0.113.1'))).toEqual({});
    expect(clientAddressHeaders(stamped('s'.repeat(64), ' , '))).toEqual({});
  });

  it('forwards nothing when the process holds no boot secret, whatever the request says', () => {
    expect(clientAddressHeaders(stamped('', '203.0.113.1'))).toEqual({});
    expect(clientAddressHeaders(stamped('anything', '203.0.113.1'))).toEqual({});
  });

  it('passes only a numeric Retry-After, and reads only a JSON object body', async () => {
    expect(retryAfterHeaders(new Response(null, { status: 429, headers: { 'retry-after': '30' } }))).toEqual({ 'retry-after': '30' });
    expect(retryAfterHeaders(new Response(null, { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' } }))).toEqual({});
    expect(await upstreamJson(new Response('{"a":1}'))).toEqual({ a: 1 });
    expect(await upstreamJson(new Response('[1]'))).toBeNull();
    expect(await upstreamJson(new Response('<html>'))).toBeNull();
    expect(await upstreamJson(new Response(''))).toBeNull();
  });
});
