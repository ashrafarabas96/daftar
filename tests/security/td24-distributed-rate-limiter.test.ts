/**
 * TD-24 — THE GENERAL ALLOWANCE IS COUNTED PER PROCESS, PROVED ON TWO
 * REPLICAS OF THE REAL APPLICATION SHARING ONE DATABASE.
 *
 * TD-24 (`TECHNICAL_DEBT.md`) says the throttler holds its counters in
 * process memory, so each replica counts its own allowance and the effective
 * production limit is the stated limit multiplied by the replica count. This
 * file is that sentence as a measurement rather than as a claim.
 *
 * ── WHICH OF THE TWO LIMITERS THIS FILE IS ABOUT ─────────────────────────
 *
 * There are two, and only ONE of them is per-process. Measured:
 *
 *   1. The eight identity limits (`auth.service.ts:61/85/86/89/92/150/264/
 *      265/293`) go through the `RATE_LIMITER` provider, which is
 *      `RedisRateLimiter` whenever `REDIS_URL` is set (`runtime.ts:531`) —
 *      and `config.ts:281-282` makes `REDIS_URL` a STARTUP REQUIREMENT of
 *      every production HTTP surface ("production requires REDIS_URL (memory
 *      rate limiter is dev-only)"). A production deployment therefore cannot
 *      reach `MemoryRateLimiter` on that path at all. It is shared already.
 *
 *   2. The GENERAL allowance — `ThrottlerModule.forRoot` at
 *      `runtime.ts:116`, 300 requests per minute for each route handler and
 *      client, enforced by `ThrottlerGuard` as a global guard
 *      (`runtime.ts:536`) — is passed NO `storage`. `@nestjs/throttler`
 *      6.4.0 then binds its own in-process `ThrottlerStorageService`
 *      (`dist/throttler.providers.js:19`: the override is used only when
 *      `options.storage` is present). That store is a `Map` in the process's
 *      heap, in EVERY environment including production.
 *
 * So the defect that survives on this head is (2), and this file measures (2)
 * and says nothing about (1).
 *
 * ── WHAT A "REPLICA" IS HERE ─────────────────────────────────────────────
 *
 * Two `createTestApp()` instances. Each one is a full Nest application with
 * its own providers, its own global `ThrottlerGuard` and its own store, and
 * both are wired to the SAME PostgreSQL cluster by the same URLs — which is
 * exactly the shape of two API processes behind one load balancer in front of
 * one database. Nothing here simulates a limiter: the requests go through the
 * real guard on a real route.
 *
 * `GET /v1/me/businesses` is the route, for the reason
 * `tests/integration/p3c-bff-route-throttle.test.ts:18-20` already measured:
 * the throttle runs BEFORE authentication, so an unauthenticated call is
 * counted (and answered 401) until the allowance is gone (429). No account,
 * no token, and no money is touched.
 *
 * The client is varied per request with `X-Forwarded-For` under
 * `TRUST_PROXY=true`, which `clientIp()` reads as "one proxy in front, the
 * client is the rightmost entry" (`client-ip.ts:81`). That is the dev/test
 * legacy mode and production refuses it — it is used here only to ADDRESS a
 * client, never to widen one.
 *
 * ── THE SHAPE OF EVERY CASE, AND WHY EACH CONTROL IS THERE ───────────────
 *
 * A case asserting "the second replica refuses" is satisfied by an
 * application that refuses everything — a broken fixture, a dead database, a
 * mistyped route. A case asserting "the sum is the limit" is satisfied by a
 * limiter that refuses from the first request. So:
 *
 *   TD24-A  POSITIVE CONTROL. One replica alone enforces the limit on one
 *           client: the first `LIMIT` requests are not 429 and request
 *           `LIMIT + 1` is. Without this, every assertion below could be read
 *           off an application that never answers.
 *   TD24-B  THE CLAIM. With that client's allowance exhausted on replica A,
 *           ONE request to replica B with the SAME client must be 429.
 *   TD24-C  NEGATIVE CONTROL for B. On replica B, a client that has spent
 *           nothing is NOT 429 in the same run — so B's 429 is about the
 *           spent allowance and not about replica B.
 *   TD24-D  THE MAGNITUDE. For a fresh client, requests alternating between
 *           the two replicas: the number of non-429 answers must be exactly
 *           `LIMIT`. Today it is `2 * LIMIT`, which is the TD-24 sentence as
 *           a number.
 *   TD24-E  CONCURRENCY. The same magnitude under `Promise.all` rather than
 *           in sequence, so the answer cannot come from the ordering.
 *   TD24-F  NEGATIVE CONTROL for E. The same concurrent shape with a
 *           DIFFERENT client per replica admits `2 * LIMIT` — so E's number
 *           is a limit being shared and not a connection pool saturating.
 *
 * Every count is read from the answers themselves, never from the length of
 * the input (RULE-19), and the admitted set is asserted to be non-empty
 * before any zero is believed (RULE-18).
 *
 * ── WHAT THIS FILE DOES NOT CLAIM ────────────────────────────────────────
 *
 * It does not claim a tenant dimension. The limiter contract is
 * `take(key, max, windowSeconds)` (`infra/redis.ts:25-39`) and the general
 * allowance's tracker is a CLIENT ADDRESS (`runtime.ts:118`); every call site
 * runs before authentication, so no tenant is known when the count is taken.
 * The isolation that is reachable at this layer is per CLIENT and per ROUTE
 * HANDLER, and that is what TD24-C and TD24-F measure. A row-security claim
 * over a counter no tenant-scoped connection ever writes would be a statement
 * about a migration, not about this limiter.
 *
 * ── WHERE THIS RUNS ──────────────────────────────────────────────────────
 *
 * A live cluster is required, so this suite is measured by CI's `backend` job
 * (`Integration + security`). On the Windows development host there is no
 * PostgreSQL it can reach, and a run here is NOT_RUN for that named reason —
 * never a pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/test-app';

/**
 * The production limit, read from `apps/api/src/app/runtime.ts:117`
 * (`throttlers: [{ ttl: 60_000, limit: 300 }]`). This card changes no limit:
 * if that line ever moves, this constant is wrong and TD24-A fails loudly
 * rather than measuring a limit that is not the product's.
 */
const LIMIT = 300;
const ROUTE = '/v1/me/businesses';
const TOO_MANY = 429;

/** A fresh client address per case, so no case can spend another's allowance. */
let nextClient = 1;
const freshClient = (): string => `203.0.113.${nextClient++}`;

let replicaA: TestApp;
let replicaB: TestApp;

/** One unauthenticated GET through the real guard, as `client`. Returns the status. */
async function hit(replica: TestApp, client: string): Promise<number> {
  const res = await replica.request.get(ROUTE).set('X-Forwarded-For', client);
  return res.status;
}

/** `n` sequential hits; the statuses, in order. */
async function hitTimes(replica: TestApp, client: string, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(await hit(replica, client));
  return out;
}

/** How many of `statuses` were ADMITTED by the throttler (anything but 429). */
function admitted(statuses: readonly number[]): number {
  return statuses.filter((s) => s !== TOO_MANY).length;
}

beforeAll(async () => {
  // TRUST_PROXY is the dev/test addressing mode (`client-ip.ts:15-21`);
  // production refuses it at startup, which is why it is safe to use here to
  // name a client and would not be safe as a product setting.
  replicaA = await createTestApp({ configOverrides: { TRUST_PROXY: 'true' } });
  replicaB = await createTestApp({ configOverrides: { TRUST_PROXY: 'true' } });
}, 180_000);

afterAll(async () => {
  await replicaA?.close();
  await replicaB?.close();
});

describe('TD-24 — the general allowance across two replicas of one database', () => {
  it('TD24-A (positive control): one replica alone enforces the limit on one client', async () => {
    const client = freshClient();
    const spend = await hitTimes(replicaA, client, LIMIT);
    expect(spend.length).toBe(LIMIT); // the input was not empty (RULE-18/19)
    expect(admitted(spend)).toBe(LIMIT);
    expect(await hit(replicaA, client)).toBe(TOO_MANY);
  }, 180_000);

  it('TD24-B: a client whose allowance is spent on replica A is refused by replica B', async () => {
    const client = freshClient();
    const spend = await hitTimes(replicaA, client, LIMIT);
    expect(admitted(spend)).toBe(LIMIT);
    expect(await hit(replicaA, client)).toBe(TOO_MANY); // spent, measured on A

    // THE CLAIM. One allowance per client per route handler, whichever
    // replica answers. Red while the store is the process heap.
    expect(await hit(replicaB, client)).toBe(TOO_MANY);
  }, 180_000);

  it('TD24-C (negative control for B): on replica B a client that spent nothing is admitted', async () => {
    const spender = freshClient();
    const bystander = freshClient();
    expect(admitted(await hitTimes(replicaA, spender, LIMIT))).toBe(LIMIT);
    expect(await hit(replicaA, spender)).toBe(TOO_MANY);

    // Replica B is not refusing everything: a different client still passes.
    expect(await hit(replicaB, bystander)).not.toBe(TOO_MANY);
  }, 180_000);

  it('TD24-D: the admitted total over both replicas is the limit, not twice it', async () => {
    const client = freshClient();
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT * 2; i += 1) statuses.push(await hit(i % 2 === 0 ? replicaA : replicaB, client));
    expect(statuses.length).toBe(LIMIT * 2);
    expect(admitted(statuses)).toBe(LIMIT);
  }, 300_000);

  it('TD24-E: the same total holds under concurrency, not only in sequence', async () => {
    const client = freshClient();
    const statuses = await Promise.all(Array.from({ length: LIMIT * 2 }, (_, i) => hit(i % 2 === 0 ? replicaA : replicaB, client)));
    expect(statuses.length).toBe(LIMIT * 2);
    expect(admitted(statuses)).toBe(LIMIT);
  }, 300_000);

  it('TD24-F (negative control for E): one client per replica admits both allowances', async () => {
    const clientA = freshClient();
    const clientB = freshClient();
    const statuses = await Promise.all(Array.from({ length: LIMIT * 2 }, (_, i) => (i % 2 === 0 ? hit(replicaA, clientA) : hit(replicaB, clientB))));
    expect(statuses.length).toBe(LIMIT * 2);
    // Two clients, two allowances: the shared store must not merge them, and
    // TD24-E's number is therefore a limit and not a saturated pool.
    expect(admitted(statuses)).toBe(LIMIT * 2);
  }, 300_000);
});
