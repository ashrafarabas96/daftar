/**
 * `RouteCoverage` is the gate's proof that its pacing sits in front of every
 * proxied request: `seen === paced + fulfilled + cancelled` for every route
 * key, and a key where it does not hold fails the gate.
 *
 * The case it exists for is a URL the context's route handler does NOT match.
 * That request goes straight to the API and spends an allowance nobody
 * charged, and the first symptom is a 429 on the busiest route - which is
 * indistinguishable from "the budget is set too high" unless the counts are
 * kept apart.
 *
 * `cancelled` was added for the opposite case, measured on run 40864085275:
 * two `GET /api/proxy/inventory/stock` requests issued in `starting-stock`,
 * whose first act is a reload. `page.on('request')` had counted them; the
 * navigation abandoned them before the handler ran. They never left the
 * interception layer, so they never reached the API - and failing the gate on
 * them is failing it on a non-event.
 *
 * The danger in that addition is obvious and is what most of this file is
 * about: an excuse that is slightly too wide stops the invariant catching the
 * thing it was written for.
 */
import { describe, expect, it } from 'vitest';
import { RouteCoverage } from '../tests/browser/pacer';

const KEY = 'GET /api/proxy/inventory/stock';
const row = (c: RouteCoverage) => c.table().find((r) => r.route === KEY);

/** A stand-in for Playwright's Request object: identity is all the coverage uses. */
const token = (): object => ({});

describe('RouteCoverage - cancelled must not widen into an excuse', () => {
  it('still fails a request that reached the API with no budget', () => {
    // The whole point. Nothing settles it, so it stays unpaced and named.
    const c = new RouteCoverage();
    const t = token();
    c.seen('GET', '/api/proxy/inventory/stock', t, { locale: 'en', viewport: '768', step: 'stock', url: '/x', atMs: 1 });
    expect(c.unpaced()).toEqual([{ route: KEY, unpaced: 1 }]);
    expect(c.unaccounted().map((u) => u.step)).toEqual(['stock']);
  });

  it('settles a request the navigation abandoned, and counts it where it can be seen', () => {
    const c = new RouteCoverage();
    const t = token();
    c.seen('GET', '/api/proxy/inventory/stock', t, { locale: 'en', viewport: '768', step: 'starting-stock', url: '/x', atMs: 1 });
    c.cancelled('GET', '/api/proxy/inventory/stock', t);
    expect(c.unpaced()).toEqual([]);
    expect(row(c)).toMatchObject({ seen: 1, paced: 0, fulfilled: 0, cancelled: 1, unpaced: 0 });
    expect(c.unaccounted()).toEqual([]);
  });

  it('refuses to count an abort that arrives AFTER the request was paced', () => {
    // A request that was paced reached the API. If a later abort also counted,
    // the row would read `seen 1, paced 1, cancelled 1` and the arithmetic
    // would go negative - and in a busier run an abort could absorb a real
    // hole on the same route instead.
    const c = new RouteCoverage();
    const t = token();
    c.seen('GET', '/api/proxy/inventory/stock', t, { locale: 'en', viewport: '768', step: 'stock', url: '/x', atMs: 1 });
    c.paced('GET', '/api/proxy/inventory/stock', t);
    c.cancelled('GET', '/api/proxy/inventory/stock', t);
    expect(row(c)).toMatchObject({ seen: 1, paced: 1, cancelled: 0, unpaced: 0 });
  });

  it('refuses to count an abort that arrives after a step answered the request locally', () => {
    const c = new RouteCoverage();
    const t = token();
    c.seen('GET', '/api/proxy/inventory/stock', t, { locale: 'en', viewport: '768', step: 'states', url: '/x', atMs: 1 });
    c.fulfilled('GET', '/api/proxy/inventory/stock', t);
    c.cancelled('GET', '/api/proxy/inventory/stock', t);
    expect(row(c)).toMatchObject({ seen: 1, fulfilled: 1, cancelled: 0, unpaced: 0 });
  });

  it('does not let one cancelled request cover for a different unpaced one on the same route', () => {
    // Two requests, one abandoned and one that got through unpaced. Counting
    // by key alone would net to zero and report a clean route.
    const c = new RouteCoverage();
    const abandoned = token();
    const escaped = token();
    c.seen('GET', '/api/proxy/inventory/stock', abandoned, { locale: 'en', viewport: '768', step: 'starting-stock', url: '/a', atMs: 1 });
    c.seen('GET', '/api/proxy/inventory/stock', escaped, { locale: 'tr', viewport: '360', step: 'stock', url: '/b', atMs: 2 });
    c.cancelled('GET', '/api/proxy/inventory/stock', abandoned);
    expect(c.unpaced()).toEqual([{ route: KEY, unpaced: 1 }]);
    expect(c.unaccounted().map((u) => u.url)).toEqual(['/b']);
  });

  it('ignores an abort for a request it never saw, rather than inventing a row', () => {
    const c = new RouteCoverage();
    c.cancelled('GET', '/api/proxy/inventory/stock', token());
    expect(c.table()).toEqual([]);
  });
});
