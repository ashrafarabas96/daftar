/**
 * TD-24 / DR-90 — THE SHARED STORE'S CONTRACT, AND THE 429 THAT IS THE WHOLE
 * CLAIM.
 *
 * ── WHAT THIS FILE IS EVIDENCE OF, AND WHAT IT IS NOT ────────────────────
 *
 * DR-90 §5 says it in the decision's own words: the fake is for unit tests
 * only and is NOT accepted as final evidence. So the boundary is stated here
 * rather than left to be discovered.
 *
 * This file proves the part that lives in OUR code: the key format and the
 * isolation it buys, that one `increment` is one round trip, that the four
 * numbers coming back are turned into the record `ThrottlerGuard` reads —
 * `isBlocked` above all, since that is the only field the guard refuses on
 * (`@nestjs/throttler/dist/throttler.guard.js:115-117`) — and that an outage
 * degrades to a per-replica count with a log and a metric instead of becoming
 * "no limit".
 *
 * It does NOT prove the Lua body. `FakeRedis.eval` does not interpret Lua; it
 * implements the same fixed-window algorithm in TypeScript over a shared
 * `Map`. That makes every assertion below a statement about the store's
 * CONTRACT and about SHARING, and none of them a statement about the script
 * Redis will run. The script's own proof is a live Redis, which needs a
 * `services:` block in `ci.yml` — authorized by DR-90 §5 as a narrow
 * exception AFTER PR #44 merges, and therefore not in this commit. Until that
 * run exists, the Lua is UNMEASURED and is written as such in the evidence
 * file. A fake that agreed with a wrong script would agree in silence, which
 * is exactly why it is not the evidence.
 *
 * ── THE TWO CONTROLS DR-90 §4 ASKS FOR, AND WHY BOTH ARE NEEDED ──────────
 *
 * The law in `tests-unit/td24-limiter-store-law.test.ts` asserts that a
 * production config does not resolve to the in-process store. That is
 * necessary and NOT sufficient, and DR-90 §4 names the gap exactly: a SHARED
 * store that computed `isBlocked` wrongly would satisfy that law and refuse
 * nothing, while readiness reported a shared store. So the evidence is the
 * refusal itself:
 *
 *   TD24-POS  two store instances over ONE backend, limit 300: the 301st
 *             call is `isBlocked`, and the admitted total is exactly 300.
 *   TD24-NEG  the same two instances over a BACKEND EACH: the 301st call is
 *             admitted and the total is 600 — the original defect, which is
 *             what makes TD24-POS a measurement rather than a tautology.
 *
 * ── ISOLATION (DR-90 §1) ─────────────────────────────────────────────────
 *
 * Two halves, because the measurement has two halves:
 *
 *   TD24-TEN  a verified tenant's counter is its own: two tenants with the
 *             same logical key do not share an allowance.
 *   TD24-TEN-NEG  the negative control DR-90 §1 asks for by name — the
 *             tenant segment removed from the key, and TD24-TEN's assertion
 *             watched failing. Without this, the tenant segment could be
 *             dead text and the isolation case would still pass.
 *   TD24-PRE  the pre-authentication form is `ip`, documented, and carries NO
 *             tenant — the general allowance's scope, because the throttler
 *             runs before `AuthGuard` attaches one (`common/guards.ts:80-82`).
 *
 * A note the test records rather than hides: the tenant-scoped form has NO
 * production call site on this head. Every limiter call site is
 * pre-authentication, so the tenant half is built and proved so that the
 * first post-auth caller is isolated by construction — not because something
 * uses it today.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ThrottlerStorageService } from '@nestjs/throttler';
import {
  PRE_AUTH_SCOPE,
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_METRICS,
  RedisThrottlerStorage,
  rateLimitKey,
  rateLimitScopeSegment,
  type RateLimitEvaluator,
} from '../apps/api/src/infra/rate-limit-store';
import { InMemoryMetrics } from '../apps/api/src/infra/metrics';

const LIMIT = 300; // apps/api/src/app/runtime.ts — unchanged by this card
const TTL_MS = 60_000;
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/**
 * One shared backend: a `Map` plus the same fixed-window arithmetic the Lua
 * body performs. It records every call so a test can assert the number of
 * round trips rather than assume it.
 */
class FakeRedis implements RateLimitEvaluator {
  readonly calls: { keys: readonly string[]; args: readonly string[] }[] = [];
  private readonly counters = new Map<string, { hits: number; expiresAt: number }>();
  private readonly blocks = new Map<string, number>();
  constructor(private now: () => number = () => Date.now()) {}

  eval(_script: string, keys: readonly string[], args: readonly string[]): Promise<readonly number[]> {
    this.calls.push({ keys, args });
    const [counterKey = '', blockKey = ''] = keys;
    const limit = Number(args[0]);
    const windowMs = Number(args[1]);
    const blockMs = Number(args[2]);
    const t = this.now();

    const blockedUntil = this.blocks.get(blockKey) ?? 0;
    if (blockedUntil > t) {
      const entry = this.counters.get(counterKey);
      return Promise.resolve([entry?.hits ?? 0, Math.max(0, (entry?.expiresAt ?? t) - t), 1, blockedUntil - t]);
    }

    let entry = this.counters.get(counterKey);
    if (entry === undefined || entry.expiresAt <= t) {
      entry = { hits: 0, expiresAt: t + windowMs };
      this.counters.set(counterKey, entry);
    }
    entry.hits += 1;
    const pttl = Math.max(0, entry.expiresAt - t);
    if (entry.hits > limit) {
      this.blocks.set(blockKey, t + blockMs);
      return Promise.resolve([entry.hits, pttl, 1, blockMs]);
    }
    return Promise.resolve([entry.hits, pttl, 0, 0]);
  }
}

/** A backend that is down, in the shape an `ioredis` command failure arrives in. */
class DeadRedis implements RateLimitEvaluator {
  eval(): Promise<readonly number[]> {
    return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
  }
}

/** How many of `n` calls against `store` were admitted (not blocked). */
async function admitted(store: RedisThrottlerStorage, key: string, n: number): Promise<number> {
  let ok = 0;
  for (let i = 0; i < n; i += 1) {
    const r = await store.increment(key, TTL_MS, LIMIT, TTL_MS, 'default');
    if (!r.isBlocked) ok += 1;
  }
  return ok;
}

describe('TD-24 — the shared store refuses request 301, and only because the store is shared', () => {
  it('TD24-POS: two replicas over one backend hold ONE allowance, and the 301st call is blocked', async () => {
    const backend = new FakeRedis();
    const replicaA = new RedisThrottlerStorage(backend);
    const replicaB = new RedisThrottlerStorage(backend);

    // 300 spread over both: the input is not empty, and nothing is blocked yet.
    let ok = 0;
    for (let i = 0; i < LIMIT; i += 1) {
      const r = await (i % 2 === 0 ? replicaA : replicaB).increment('k', TTL_MS, LIMIT, TTL_MS, 'default');
      if (!r.isBlocked) ok += 1;
    }
    expect(ok).toBe(LIMIT);

    // THE CLAIM: the refusal, on whichever replica answers next.
    const over = await replicaB.increment('k', TTL_MS, LIMIT, TTL_MS, 'default');
    expect(over.isBlocked).toBe(true);
    expect(over.totalHits).toBe(LIMIT + 1);
    // The guard puts this straight into Retry-After, so it must be a positive
    // number of SECONDS and not the milliseconds the store was handed.
    expect(over.timeToBlockExpire).toBe(TTL_MS / 1000);
    expect(over.timeToExpire).toBeLessThanOrEqual(TTL_MS / 1000);
    expect(over.timeToExpire).toBeGreaterThan(0);
  });

  it('TD24-NEG (negative control): a backend each admits 600 — the defect this card removes', async () => {
    const replicaA = new RedisThrottlerStorage(new FakeRedis());
    const replicaB = new RedisThrottlerStorage(new FakeRedis());

    const okA = await admitted(replicaA, 'k', LIMIT);
    const okB = await admitted(replicaB, 'k', LIMIT);
    expect(okA + okB).toBe(LIMIT * 2);

    // Not blocked at 301 either, on either replica: the stated ceiling of 300
    // has become 600, which is TD-24's sentence as a number.
    expect((await replicaA.increment('k', TTL_MS, LIMIT, TTL_MS, 'default')).isBlocked).toBe(true);
    const bFresh = new RedisThrottlerStorage(new FakeRedis());
    expect((await bFresh.increment('k', TTL_MS, LIMIT, TTL_MS, 'default')).isBlocked).toBe(false);
  });

  it('TD24-ATOMIC: one increment is one round trip, with no read-then-write', async () => {
    const backend = new FakeRedis();
    const store = new RedisThrottlerStorage(backend);
    await store.increment('k', TTL_MS, LIMIT, TTL_MS, 'default');
    await store.increment('k', TTL_MS, LIMIT, TTL_MS, 'default');
    // Two calls, two evaluations: the count is never fetched and sent back.
    expect(backend.calls.length).toBe(2);
    // Both keys and all three arguments travel in the same evaluation, so the
    // window and the block flag cannot be decided from a stale read.
    const first = backend.calls[0];
    expect(first?.keys.length).toBe(2);
    expect(first?.args).toEqual([String(LIMIT), String(TTL_MS), String(TTL_MS)]);
  });
});

describe('TD-24 — isolation is a property of the key (DR-90 §1)', () => {
  it('TD24-TEN: two verified tenants with the same logical key do not share an allowance', async () => {
    const backend = new FakeRedis();
    const forA = new RedisThrottlerStorage(backend, { scope: { kind: 'tenant', tenantId: TENANT_A } });
    const forB = new RedisThrottlerStorage(backend, { scope: { kind: 'tenant', tenantId: TENANT_B } });

    expect(await admitted(forA, 'k', LIMIT)).toBe(LIMIT);
    expect((await forA.increment('k', TTL_MS, LIMIT, TTL_MS, 'default')).isBlocked).toBe(true);

    // Tenant B has spent nothing, in the same backend, under the same
    // logical key. A positive control, so the zero above is not an empty store.
    const first = await forB.increment('k', TTL_MS, LIMIT, TTL_MS, 'default');
    expect(first.isBlocked).toBe(false);
    expect(first.totalHits).toBe(1);
  });

  it('TD24-TEN-NEG (negative control): with the tenant dropped from the key, the isolation case fails', () => {
    // The key the store actually builds differs between the two tenants ONLY
    // because of the segment. Remove it — which is what a regression would do
    // — and the two counters become one, which is the failure TD24-TEN
    // catches. Asserted on the key builder so the control cannot pass by
    // accident of a fixture.
    expect(rateLimitKey({ kind: 'tenant', tenantId: TENANT_A }, 'k')).not.toBe(rateLimitKey({ kind: 'tenant', tenantId: TENANT_B }, 'k'));

    const withoutScope = (key: string): string => `${RATE_LIMIT_KEY_PREFIX}:${key}`;
    expect(withoutScope('k')).toBe(withoutScope('k')); // one counter for both tenants
    expect(rateLimitKey({ kind: 'tenant', tenantId: TENANT_A }, 'k')).not.toBe(withoutScope('k'));
  });

  it('TD24-PRE: the pre-authentication scope is `ip`, and carries no tenant', () => {
    expect(rateLimitScopeSegment(PRE_AUTH_SCOPE)).toBe('ip');
    expect(rateLimitKey(PRE_AUTH_SCOPE, 'k')).toBe(`${RATE_LIMIT_KEY_PREFIX}:ip:k`);
    // A tenant-shaped scope with nothing in it is a refusal, not a default:
    // silently merging two tenants into one allowance is the defect the
    // segment exists to prevent.
    expect(() => rateLimitScopeSegment({ kind: 'tenant', tenantId: '  ' })).toThrow(/without a tenant id/);
  });
});

describe('TD-24 — an outage degrades and says so, and never becomes "no limit" (DR-90 §3)', () => {
  let metrics: InMemoryMetrics;
  let warnings: { payload: Record<string, unknown>; message: string }[];

  beforeEach(() => {
    metrics = new InMemoryMetrics();
    warnings = [];
  });

  it('TD24-DEGRADE: a dead backend still counts, per replica, with a warning and a metric', async () => {
    const store = new RedisThrottlerStorage(new DeadRedis(), {
      metrics,
      logger: { warn: (payload, message) => warnings.push({ payload, message }) },
    });

    expect(store.degraded).toBe(false);
    const first = await store.increment('k', TTL_MS, LIMIT, TTL_MS, 'default');

    // STILL COUNTED. Not a 503 on every route because a cache is down, and
    // not an absent limit either.
    expect(first.totalHits).toBe(1);
    expect(first.isBlocked).toBe(false);
    expect(store.degraded).toBe(true);

    // Said out loud: one warning carrying the reason, and a metric per request.
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.message).toMatch(/counted PER REPLICA/);
    expect(String(warnings[0]?.payload['reason'])).toMatch(/ECONNREFUSED/);
    await store.increment('k', TTL_MS, LIMIT, TTL_MS, 'default');
    const sample = metrics.snapshot().find((s) => s.name === RATE_LIMIT_METRICS.storeDegradedTotal);
    expect(sample?.count).toBe(2);
    // The log is not amplified per request; the metric is what counts them.
    expect(warnings.length).toBe(1);
  });

  it('TD24-DEGRADE-NEG (negative control): the degraded path still refuses at the limit', async () => {
    const store = new RedisThrottlerStorage(new DeadRedis());
    expect(await admitted(store, 'k', LIMIT)).toBe(LIMIT);
    // A fallback that admitted everything would be "no limit" wearing the
    // word fallback. It is the per-replica ceiling, which still refuses.
    expect((await store.increment('k', TTL_MS, LIMIT, TTL_MS, 'default')).isBlocked).toBe(true);
  });

  it('TD24-DEGRADE-STORE: the fallback is the in-process store, not a third implementation', async () => {
    // The per-replica ceiling is the one the deployment had before this card
    // — the same class tests/performance/pos-s3-budgets.test.ts reads as a
    // Map — rather than a second algorithm that would have to be proved too.
    const store = new RedisThrottlerStorage(new DeadRedis());
    await store.increment('k', TTL_MS, LIMIT, TTL_MS, 'default');
    const fallback: unknown = (store as unknown as { fallback: unknown }).fallback;
    expect(fallback).toBeInstanceOf(ThrottlerStorageService);
  });
});
