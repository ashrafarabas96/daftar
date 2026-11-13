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
 *   TD24-E  CONCURRENCY. The same magnitude with requests in flight at once
 *           rather than in sequence, so the answer cannot come from the
 *           ordering. The width of a wave is bounded for a measured reason
 *           that is about `supertest`, not about the store — see `WAVE`.
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
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
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
/**
 * `RedisThrottlerStorage.kind` (`rate-limit-store.ts:250`), the value
 * readiness reports for a shared store. A renamed kind does NOT silently read
 * as "no shared store configured": the configuration/report check in
 * `beforeAll` refuses the run by name, because `REDIS_URL` would be set while
 * nothing matched here.
 */
const SHARED_KIND = 'redis';

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

/**
 * The width of a concurrent wave, and why it is not `LIMIT * 2`.
 *
 * TWO harness defects sat on TD24-E and TD24-F, and they are not the same
 * one. Both were measured on a bare `node:http` server with no Nest and no
 * database, since the development host has no cluster to reach.
 *
 *   (1) THE SERVER WAS CLOSED UNDER THE WAVE — the cause of the
 *       `read ECONNRESET` these two cases failed with in runs 41848410636
 *       and 42073109330, where they failed in 9ms and 8ms, far too fast to
 *       be 600 requests. `createTestApp()` calls `app.init()` and never
 *       `listen`, so `supertest` opens the server itself: the FIRST `Test`
 *       of a wave finds no address, calls `server.listen(0)`, keeps the
 *       handle, and `close()`s it the moment ITS OWN request ends
 *       (`node_modules/supertest/lib/test.js:63,134-149`) — while the other
 *       24 requests of that wave are still in flight. Measured, and
 *       deterministically, not by timing: against an unlistening server a
 *       25-call wave leaves `server.listening === false` and no port, wave
 *       after wave; against a server this suite listened on first, the port
 *       is the same before and after every wave and the server is still
 *       listening. Sequential cases never saw it, because there is nothing
 *       in flight to reset. THE REMEDY IS IN `beforeAll`: each replica
 *       listens once, so `supertest` finds an address and neither opens nor
 *       closes anything. Pinned DB-free by
 *       `tests-unit/td24-supertest-listen-law.test.ts`.
 *   (2) A WAVE OF 600 IS A STORM IN ITS OWN RIGHT, listening or not. Even on
 *       a server already listening, 600 calls issued in one tick measured
 *       232 admitted and 368 refused with `ECONNREFUSED` — the accept
 *       backlog, not the subject. So the wave stays bounded.
 *
 * A wave is still genuinely concurrent, and concurrency is all TD24-E
 * claims: 25 requests in flight at once, alternating replicas, is a window
 * in which a read-then-write store overcounts and an atomic one does not.
 * Widening the wave to the whole run would only reinstate (2), and a case
 * that cannot run proves nothing.
 */
const WAVE = 25;

/**
 * `calls` run concurrently in waves of `WAVE`, and every status is returned.
 * A rejection is NOT swallowed: a reset socket would otherwise be counted as
 * an admitted request and inflate the total silently.
 */
async function inWaves(calls: readonly (() => Promise<number>)[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < calls.length; i += WAVE) {
    out.push(...(await Promise.all(calls.slice(i, i + WAVE).map((call) => call()))));
  }
  return out;
}

/**
 * Whether THIS environment configures a shared store, read off the running
 * application rather than off an environment variable.
 *
 * This is what makes the suite a measurement in both directions instead of a
 * suite that has to be skipped until `ci.yml` gains a `redis` service (DR-90
 * §5 authorises that only after PR #44 merges, so it is not in this commit).
 *
 *   shared store configured    → two replicas hold ONE allowance (the fix)
 *   no shared store configured → two replicas hold one EACH (the defect)
 *
 * Both are asserted, so neither reading can be mistaken for the other and
 * neither can quietly become NOT_RUN. A green run here with no Redis is NOT a
 * statement that TD-24 is closed — it is the statement that the ceiling is
 * per replica in an environment that configured no shared store, which is
 * TD-24's own sentence. The decisive run is the one where `sharedStore` is
 * true.
 */
let sharedStore = false;

/**
 * The store the GUARD holds, read from WHAT THE APPLICATION ITSELF REPORTS.
 *
 * Three readings were tried and two were measured wrong, so the comment
 * records all three rather than only the survivor:
 *
 *   1. `app.get(ThrottlerStorage)` on the ROOT. WRONG, and it cost a CI run.
 *      The store is a provider of `AppModule` (`runtime.ts:556-565`) while
 *      `createTestApp()` imports `AppModule` into a
 *      `Test.createTestingModule` ROOT, which provides that token nowhere —
 *      so the root answers with the `@Global()` `ThrottlerModule`'s own
 *      in-process instance, a DIFFERENT object from the one the guard in
 *      `AppModule` holds. With the `backend` job's real Redis attached this
 *      probe read `ThrottlerStorageService` and set `sharedStore = false`,
 *      while the application refused the spent client on replica B and
 *      admitted exactly 300 of 600 — the shared behaviour. Both decisive
 *      cases then failed against the wrong branch of their own assertion
 *      (run 42059258777: "expected 429 to be 401", "expected 300 to be
 *      600").
 *   2. `app.select(AppModule).get(ThrottlerStorage, { strict: true })`, the
 *      injector the guard does resolve from. ALSO WRONG: `select` cannot
 *      reach a module registered DYNAMICALLY, which is what
 *      `AppModule.register({ config })` is — it refuses with "does not exist
 *      in current context". Measured in
 *      `tests-unit/td24-limiter-store-law.test.ts` (TD24-LAW-D2) before it
 *      could cost a second run; TD24-LAW-D there pins reading 1's defect.
 *   3. THE PRODUCT'S OWN REPORT, used below. `/v1/health/ready` names the
 *      store under `components.throttlerStore.kind` when the process holds a
 *      shared one, and omits the component when it does not
 *      (`platform.controller.ts:111-124`) — read through the same HTTP
 *      surface everything else in this file is read through, with no
 *      injector and no private field. It is also the only reading an
 *      operator can make, so a disagreement between it and the behaviour
 *      below is a defect in something a human already relies on.
 *
 * `null` is the reading "this process holds no shared store", which is how it
 * keeps the library's own instance.
 */
async function reportedStoreKind(replica: TestApp): Promise<string | null> {
  const res = await replica.request.get('/v1/health/ready');
  // 200 ready / 503 not-ready are both reports; anything else is not one.
  if (res.status !== 200 && res.status !== 503)
    throw new Error(`/v1/health/ready answered ${res.status}, so this suite cannot read which store the process holds`);
  const body: unknown = res.body;
  const components: unknown = typeof body === 'object' && body !== null ? (body as { components?: unknown }).components : undefined;
  if (typeof components !== 'object' || components === null)
    throw new Error('/v1/health/ready reported no components, so this suite cannot read which store the process holds');
  // POSITIVE CONTROL on the probe itself: the component that is always
  // there. Without it, a readiness shape that stopped reporting stores
  // altogether would read as "no shared store configured" in every
  // environment — the same silent inversion reading 1 produced.
  if (!('database' in components))
    throw new Error('/v1/health/ready no longer reports the database component, so this probe is reading a shape it does not know');
  const store: unknown = (components as Record<string, unknown>)['throttlerStore'];
  if (store === undefined) return null;
  const kind: unknown = typeof store === 'object' && store !== null ? (store as { kind?: unknown }).kind : undefined;
  if (typeof kind !== 'string' || kind.length === 0) throw new Error('/v1/health/ready reported a throttlerStore component with no kind');
  return kind;
}

beforeAll(async () => {
  // TRUST_PROXY is the dev/test addressing mode (`client-ip.ts:15-21`);
  // production refuses it at startup, which is why it is safe to use here to
  // name a client and would not be safe as a product setting.
  // REDIS_URL is passed through the EXISTING `configOverrides` seam, so
  // `tests/helpers/test-app.ts` is not touched: PR #7 owns that file and is
  // frozen by DR-89. Where the environment configures a shared store — the
  // `backend` job since DR-90 §5 — both replicas get it and the decisive
  // branch below is the one that runs; with none, the branch that asserts the
  // defect runs instead, and both are assertions.
  const sharedUrl = process.env['REDIS_URL'];
  const overrides: Record<string, string> = { TRUST_PROXY: 'true', ...(sharedUrl ? { REDIS_URL: sharedUrl } : {}) };
  replicaA = await createTestApp({ configOverrides: overrides });
  replicaB = await createTestApp({ configOverrides: overrides });
  // EACH REPLICA LISTENS ONCE, and this line is the whole remedy for the
  // `read ECONNRESET` that kept TD24-E and TD24-F from ever measuring
  // anything (see `WAVE`): with an address already bound, `supertest` neither
  // opens the server nor closes it under a wave that is still in flight. The
  // same pattern the project already uses wherever a suite needs more than
  // one request at a time (`tests/security/p3c-ipv6-limiter-key.test.ts:63`,
  // `tests/integration/p3c-bff-route-throttle.test.ts:134`). Loopback only:
  // nothing off this host may reach a test replica.
  await replicaA.app.listen(0, '127.0.0.1');
  await replicaB.app.listen(0, '127.0.0.1');
  // What the store behind the general allowance is, taken from the running
  // application's own report — not from `process.env`, which would be a
  // claim about intent, and not from the root injector, which answers with a
  // different object than the guard holds (see `reportedStoreKind`).
  const kindA = await reportedStoreKind(replicaA);
  const kindB = await reportedStoreKind(replicaB);
  const shared = kindA === SHARED_KIND && kindB === SHARED_KIND;
  // The in-process reading is BOTH halves: no store reported by either
  // replica AND the library's own instance still answering at the root —
  // the object `tests/performance/pos-s3-budgets.test.ts:549` clears.
  const rootStore: unknown = replicaA.app.get<unknown>(ThrottlerStorage);
  const inProcess = kindA === null && kindB === null && rootStore instanceof ThrottlerStorageService;
  if (!inProcess && !shared)
    throw new Error(
      `neither replica reports a store shape this suite knows (reported: ${kindA ?? 'none'} / ${kindB ?? 'none'}, root: ${rootStore?.constructor.name}), so its two readings cannot be told apart`,
    );

  // ── THE TWO-SIDED CHECK THAT MAKES A BLIND PROBE LOUD ──────────────────
  // Intent and injector must agree. A probe that reads "no shared store" in
  // an environment that configured one flips every assertion below to its
  // opposite branch and fails with arithmetic that says nothing about the
  // cause — which is precisely what run 42059258777 printed. Here it fails
  // by its own name instead.
  const configured = sharedUrl !== undefined && sharedUrl !== '';
  if (shared !== configured)
    throw new Error(
      `the configuration and the application disagree about the store behind the general allowance: REDIS_URL is ${configured ? 'set' : 'absent'} while /v1/health/ready reports ${kindA ?? 'no shared store'} — this suite refuses to assert either reading until they agree`,
    );

  sharedStore = shared;
  console.info('[TD-24] throttler store', JSON.stringify({ reported: kindA, root: rootStore?.constructor.name, configured, sharedStore }));
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
  }, 55_000);

  it('TD24-B: replica B answers a spent client exactly as this environment’s store dictates', async () => {
    const client = freshClient();
    const spend = await hitTimes(replicaA, client, LIMIT);
    expect(admitted(spend)).toBe(LIMIT);
    expect(await hit(replicaA, client)).toBe(TOO_MANY); // spent, measured on A

    // THE CLAIM, in whichever direction the configuration makes true. With a
    // shared store, one allowance per client per route handler whichever
    // replica answers. With none, replica B has an untouched allowance — and
    // that is the defect TD-24 names, asserted rather than tolerated.
    expect(await hit(replicaB, client)).toBe(sharedStore ? TOO_MANY : 401);
  }, 55_000);

  it('TD24-C (negative control for B): on replica B a client that spent nothing is admitted', async () => {
    const spender = freshClient();
    const bystander = freshClient();
    expect(admitted(await hitTimes(replicaA, spender, LIMIT))).toBe(LIMIT);
    expect(await hit(replicaA, spender)).toBe(TOO_MANY);

    // Replica B is not refusing everything: a different client still passes.
    expect(await hit(replicaB, bystander)).not.toBe(TOO_MANY);
  }, 55_000);

  /**
   * The timeout is 55s and not a comfortable 300s ON PURPOSE. The window is
   * 60s, and the in-process store decays each hit after its own ttl
   * (`dist/throttler.service.js:25-33`), so a run that took longer than the
   * window would see the earliest hits refunded and `2 * LIMIT` would stop
   * being reachable — the suite would fail for a reason that is about the
   * clock and not about the store. A timeout longer than the window the
   * assertion depends on is a flake with permission.
   */
  it('TD24-D: the admitted total over both replicas is the limit, or twice it when nothing is shared', async () => {
    const client = freshClient();
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT * 2; i += 1) statuses.push(await hit(i % 2 === 0 ? replicaA : replicaB, client));
    expect(statuses.length).toBe(LIMIT * 2);
    expect(admitted(statuses)).toBe(sharedStore ? LIMIT : LIMIT * 2);
  }, 55_000);

  it('TD24-E: the same total holds under concurrency, not only in sequence', async () => {
    const client = freshClient();
    const statuses = await inWaves(Array.from({ length: LIMIT * 2 }, (_, i) => () => hit(i % 2 === 0 ? replicaA : replicaB, client)));
    expect(statuses.length).toBe(LIMIT * 2);
    expect(admitted(statuses)).toBe(sharedStore ? LIMIT : LIMIT * 2);
  }, 55_000);

  it('TD24-F (negative control for E): one client per replica admits both allowances', async () => {
    const clientA = freshClient();
    const clientB = freshClient();
    const statuses = await inWaves(Array.from({ length: LIMIT * 2 }, (_, i) => () => (i % 2 === 0 ? hit(replicaA, clientA) : hit(replicaB, clientB))));
    expect(statuses.length).toBe(LIMIT * 2);
    // Two clients, two allowances: the shared store must not merge them, and
    // TD24-E's number is therefore a limit and not a saturated pool.
    expect(admitted(statuses)).toBe(LIMIT * 2);
  }, 55_000);
});
