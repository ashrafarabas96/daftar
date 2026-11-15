/**
 * TD-24 — THE LUA, THE PATCH AND THE SHARED ALLOWANCE, ON A REAL REDIS.
 *
 * This is the file DR-90 §5 was waiting for. Every other TD-24 suite proves
 * something about OUR code against a fake: the key format, the seconds
 * conversion, the `isBlocked` plumbing, the handshake, the fallback. None of
 * them runs the Lua body, because `FakeRedis.eval` does not interpret Lua —
 * and a fake that agreed with a wrong script would agree in silence. So
 * until this suite executes, the script and the `redis.ts` patch were
 * NOT_RUN, and the evidence said so in those words.
 *
 * It needs a real server, which `ci.yml`'s `backend` job now provides as a
 * pinned `redis:7.2-alpine` service (the narrow exception DR-90 §5 authorised
 * after PR #44 merged). `REDIS_URL` reaches the application through
 * `createTestApp`'s existing `configOverrides` seam, so
 * `tests/helpers/test-app.ts` is not touched — PR #7 owns that file and is
 * frozen by DR-89.
 *
 * ── WHAT A SKIP WOULD MEAN, AND WHY IT IS NOT HIDDEN ─────────────────────
 *
 * With no `REDIS_URL` — the Windows development host, where there is no Redis
 * and no Docker — these cases cannot run, and a suite that quietly reported
 * nothing would be the NOT_RUN rot this project has been bitten by. Two
 * things stop that:
 *
 *   1. `REQUIRES_REDIS` is read once and printed, so a run's own log says
 *      whether the live cases executed.
 *   2. `tests-unit/td24-ci-redis-service-law.test.ts` fails if the `backend`
 *      job stops defining the service or stops passing `REDIS_URL` to the
 *      integration step. A configuration regression therefore turns a LAW
 *      red rather than turning this suite silent.
 *
 * ── THE TWO CONTROLS DR-90 §4 NAMES, NOW ON THE REAL THING ───────────────
 *
 *   TD24-LIVE-POS  two store instances over ONE Redis: request `limit + 1`
 *                  is refused and the admitted total is exactly `limit`.
 *   TD24-LIVE-NEG  the same two instances over SEPARATE key spaces — the
 *                  per-replica store this card removes — admit `2 × limit`.
 *
 * The negative control is what makes the positive one a measurement. It is
 * built by giving each instance its own key prefix rather than its own
 * server, because what is being contrasted is ONE counter against TWO; a
 * second container would also change the clock, the connection and the
 * eviction policy, and then the difference would not be attributable.
 *
 * Every key is namespaced with a fresh UUID per case, so no case can inherit
 * another's counter and nothing is left behind for the next run of the suite
 * against the same server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { PRE_AUTH_SCOPE, RedisThrottlerStorage, createRedisEvaluator, rateLimitKey, type RateLimitEvaluator } from '../../apps/api/src/infra/rate-limit-store';
import { RateLimiterUnavailableError, RedisRateLimiter } from '../../apps/api/src/infra/redis';
import type { AppConfig } from '../../apps/api/src/config';

const REDIS_URL = process.env['REDIS_URL'];
const REQUIRES_REDIS = typeof REDIS_URL === 'string' && REDIS_URL.length > 0;

/** A small limit: this suite measures the counter's edge, not the product's 300. */
const LIMIT = 5;
const TTL_MS = 60_000;

const configFor = (url: string): AppConfig => ({ REDIS_URL: url }) as unknown as AppConfig;

let evaluators: RateLimitEvaluator[] = [];
let inspector: Redis | null = null;

function evaluator(): RateLimitEvaluator {
  if (!REQUIRES_REDIS) throw new Error('no REDIS_URL: this helper must only be reached inside the live describe');
  const made = createRedisEvaluator(REDIS_URL);
  evaluators.push(made);
  return made;
}

/** How many of `n` calls `store` admitted under `key`. */
async function admitted(store: RedisThrottlerStorage, key: string, n: number): Promise<number> {
  let ok = 0;
  for (let i = 0; i < n; i += 1) {
    const record = await store.increment(key, TTL_MS, LIMIT, TTL_MS, 'default');
    if (!record.isBlocked) ok += 1;
  }
  return ok;
}

beforeAll(() => {
  // A run's own log states whether the decisive cases executed, so "green"
  // can never be read as "the Lua was measured" when it was not.
  console.info(
    '[TD-24] live Redis suite',
    JSON.stringify({ redisConfigured: REQUIRES_REDIS, reason: REQUIRES_REDIS ? 'executing' : 'NOT_RUN: no REDIS_URL in this environment' }),
  );
});

afterAll(async () => {
  for (const made of evaluators) await made.close?.().catch(() => undefined);
  evaluators = [];
  if (inspector) {
    inspector.disconnect();
    inspector = null;
  }
});

describe.skipIf(!REQUIRES_REDIS)('TD-24 — on a real Redis', () => {
  it('TD24-LIVE-POS: two replicas over one Redis hold ONE allowance, and request limit+1 is refused', async () => {
    const key = `pos:${randomUUID()}`;
    const replicaA = new RedisThrottlerStorage(evaluator());
    const replicaB = new RedisThrottlerStorage(evaluator());

    let ok = 0;
    for (let i = 0; i < LIMIT; i += 1) {
      const record = await (i % 2 === 0 ? replicaA : replicaB).increment(key, TTL_MS, LIMIT, TTL_MS, 'default');
      if (!record.isBlocked) ok += 1;
    }
    expect(ok).toBe(LIMIT);

    // THE CLAIM, on the real script: the next request is refused whichever
    // replica answers it.
    const over = await replicaB.increment(key, TTL_MS, LIMIT, TTL_MS, 'default');
    expect(over.isBlocked).toBe(true);
    expect(over.totalHits).toBe(LIMIT + 1);
    expect(over.timeToExpire).toBeGreaterThan(0);
    expect(over.timeToExpire).toBeLessThanOrEqual(TTL_MS / 1000);
  }, 60_000);

  it('TD24-LIVE-NEG (negative control): a key space each admits twice the limit — the defect itself', async () => {
    const key = `neg:${randomUUID()}`;
    // Separate key spaces = the per-replica counting this card removes. Same
    // server, same clock, same connection options, so the only difference is
    // one counter against two.
    const replicaA = new RedisThrottlerStorage(evaluator(), { scope: { kind: 'tenant', tenantId: randomUUID() } });
    const replicaB = new RedisThrottlerStorage(evaluator(), { scope: { kind: 'tenant', tenantId: randomUUID() } });

    expect(await admitted(replicaA, key, LIMIT)).toBe(LIMIT);
    expect(await admitted(replicaB, key, LIMIT)).toBe(LIMIT);
    expect((await replicaA.increment(key, TTL_MS, LIMIT, TTL_MS, 'default')).isBlocked).toBe(true);
    expect((await replicaB.increment(key, TTL_MS, LIMIT, TTL_MS, 'default')).isBlocked).toBe(true);
    // 2 x LIMIT admitted in total: the stated ceiling doubled, which is TD-24
    // as a number, and the reason TD24-LIVE-POS's number means something.
  }, 60_000);

  it('TD24-LIVE-ATOMIC: concurrent requests across both replicas admit exactly the limit, never more', async () => {
    const key = `atomic:${randomUUID()}`;
    const replicaA = new RedisThrottlerStorage(evaluator());
    const replicaB = new RedisThrottlerStorage(evaluator());

    // The whole point of one EVAL: under genuine concurrency two callers must
    // not both be told they were the one that stayed under the limit.
    const records = await Promise.all(
      Array.from({ length: LIMIT * 4 }, (_, i) => (i % 2 === 0 ? replicaA : replicaB).increment(key, TTL_MS, LIMIT, TTL_MS, 'default')),
    );
    expect(records.length).toBe(LIMIT * 4);
    expect(records.filter((r) => !r.isBlocked).length).toBe(LIMIT);
  }, 60_000);

  it('TD24-LIVE-WINDOW: the window expires and the allowance returns, and NOT before', async () => {
    const key = `window:${randomUUID()}`;
    const store = new RedisThrottlerStorage(evaluator());
    const shortMs = 2_000;

    for (let i = 0; i < LIMIT; i += 1) await store.increment(key, shortMs, LIMIT, shortMs, 'default');
    // NEGATIVE CONTROL, in the same run: before the window elapses it is
    // still refused, so "admitted again" below is not a window that was never
    // counted at all.
    expect((await store.increment(key, shortMs, LIMIT, shortMs, 'default')).isBlocked).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, shortMs + 500));
    expect((await store.increment(key, shortMs, LIMIT, shortMs, 'default')).isBlocked).toBe(false);
  }, 60_000);

  it('TD24-LIVE-TENANT: two tenants do not share an allowance, and the keys are really distinct in Redis', async () => {
    const key = `tenant:${randomUUID()}`;
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const forA = new RedisThrottlerStorage(evaluator(), { scope: { kind: 'tenant', tenantId: tenantA } });
    const forB = new RedisThrottlerStorage(evaluator(), { scope: { kind: 'tenant', tenantId: tenantB } });

    expect(await admitted(forA, key, LIMIT)).toBe(LIMIT);
    expect((await forA.increment(key, TTL_MS, LIMIT, TTL_MS, 'default')).isBlocked).toBe(true);
    // Positive control: B has spent nothing, in the same server, under the
    // same logical key — so A's refusal is about A's allowance.
    const first = await forB.increment(key, TTL_MS, LIMIT, TTL_MS, 'default');
    expect(first.isBlocked).toBe(false);
    expect(first.totalHits).toBe(1);

    // And read the separation off the SERVER rather than off our own key
    // builder: two distinct keys exist, with the counts we expect.
    inspector ??= new Redis(REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await inspector.connect().catch(() => undefined);
    const keyA = rateLimitKey({ kind: 'tenant', tenantId: tenantA }, `default:${key}`);
    const keyB = rateLimitKey({ kind: 'tenant', tenantId: tenantB }, `default:${key}`);
    expect(keyA).not.toBe(keyB);
    expect(Number(await inspector.get(keyA))).toBe(LIMIT + 1);
    expect(Number(await inspector.get(keyB))).toBe(1);
    // The pre-auth scope is a third, separate space, and holds nothing here.
    expect(await inspector.get(rateLimitKey(PRE_AUTH_SCOPE, `default:${key}`))).toBe(null);
  }, 60_000);

  it('TD24-LIVE-PATCH: the identity limiter admits its FIRST take against a real Redis', async () => {
    // The `redis.ts` patch (DR-92), measured against a real server rather
    // than a loopback RESP fake: before it, the first command of every
    // process was rejected before it left the process and answered 503.
    const limiter = new RedisRateLimiter(configFor(REDIS_URL as string));
    try {
      await expect(limiter.take(`live:first:${randomUUID()}`, 30, 300)).resolves.toBeUndefined();
      expect(await limiter.healthCheck()).toBe(true);
    } finally {
      await limiter.close().catch(() => undefined);
    }
  }, 60_000);

  it('TD24-LIVE-PATCH-CLOSED (negative control): an unreachable Redis still fails closed', async () => {
    // The patch must not have turned an outage into a pass. Port 1 is
    // privileged and unbound; the answer must still be the fail-closed error
    // §67 requires, and it must arrive on the handshake budget.
    const limiter = new RedisRateLimiter(configFor('redis://127.0.0.1:1'));
    try {
      const started = Date.now();
      await expect(limiter.take(`live:closed:${randomUUID()}`, 30, 300)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await limiter.close().catch(() => undefined);
    }
  }, 60_000);
});
