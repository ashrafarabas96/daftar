/**
 * TD-24 — THE GENERAL ALLOWANCE, COUNTED IN ONE PLACE FOR EVERY REPLICA.
 *
 * TD-24 (`TECHNICAL_DEBT.md`) is the request throttler counting per process:
 * each replica counts its own allowance, so a written ceiling of "300 per
 * client per minute" is the stated limit multiplied by a replica count that
 * autoscaling changes. This file is the store that removes it.
 *
 * ── WHY REDIS AND NOT A NEW TABLE (DR-90) ────────────────────────────────
 *
 * Measured, not assumed: `config.ts:281-282` makes `REDIS_URL` a STARTUP
 * REQUIREMENT of every production HTTP surface — "production requires
 * REDIS_URL (memory rate limiter is dev-only)". So Redis is not a new
 * service here; it is a dependency a production deployment already cannot
 * start without, and `infra/redis.ts:42` already describes its limiter as
 * "shared across API instances (§112)". The eight identity limits
 * (`auth.service.ts:61/85/86/89/92/150/264/265/293`) therefore ALREADY run
 * on a shared store in production and were never the per-replica half.
 *
 * What was never shared, in ANY environment, is the GENERAL allowance:
 * `ThrottlerModule.forRoot` is passed no `storage`, so `@nestjs/throttler`
 * binds its own in-process `ThrottlerStorageService`
 * (`dist/throttler.providers.js:17-23`). That is the whole of what remains of
 * TD-24, and `RedisThrottlerStorage` below is what `forRoot` is given
 * instead.
 *
 * A PostgreSQL counter was the first design and was withdrawn on measurement:
 * it would be a SECOND shared store beside a mandatory Redis, it would put a
 * transaction with nine `set_config` calls on every HTTP request through a
 * four-connection identity pool (`infra/database.ts:728`), and the table it
 * needs would be a relation no migration before `0073` created — which
 * `scripts/phase4-s4-gate.ts:303-317` requires to carry `tenant_id` AND
 * `business_id` as `uuid NOT NULL` with `ENABLE`, `FORCE` and `REVOKE ALL …
 * FROM PUBLIC`, a shape a pre-authentication counter cannot honestly have.
 * No migration is part of this card.
 *
 * ── ONE ROUND TRIP, AND NO READ-THEN-WRITE (DR-90 §2) ────────────────────
 *
 * `increment` is a single `EVAL`. Everything the answer depends on — the
 * counter, its window, the block flag and both remaining times — is decided
 * inside one Lua body, which Redis runs to completion without interleaving
 * another client. There is no path here that reads a count and writes it
 * back, so two replicas arriving together cannot both be told they are the
 * one that stayed under the limit.
 *
 * ── THE WINDOW IS FIXED, AND THAT IS A DIFFERENCE WORTH STATING ──────────
 *
 * The in-process store decays each hit with its own `setTimeout`
 * (`dist/throttler.service.js:25-33`), so its window slides per hit. This
 * store uses a FIXED window keyed on the counter's own TTL, which is exactly
 * what `RedisRateLimiter.take` (`infra/redis.ts:69-79`) already does for the
 * identity limits — the house semantics on the shared store, not a new
 * invention. The two are not equivalent at a window boundary, and this file
 * does not claim they are. What it does claim, and what matters for TD-24, is
 * that NO LIMIT IS CHANGED: the admitted count per key per window is `limit`
 * and request `limit + 1` is the first refused, which is the comparison
 * `redis.ts:74` makes.
 *
 * ── THE KEY, AND WHO IS ISOLATED FROM WHOM (DR-90 §1) ────────────────────
 *
 * DR-90 splits isolation in two, and the split is a measurement rather than a
 * preference:
 *
 *   — A caller with a VERIFIED tenant carries that tenant in the key, in the
 *     fixed form `t:<uuid>` built by `rateLimitKey` below. Two tenants with
 *     the same logical key count separately, and no tenant can spend
 *     another's allowance. `tests-unit/td24-redis-throttler-store.test.ts`
 *     proves it, and proves it the only way that means anything: with a
 *     negative control that drops the tenant segment and watches the same
 *     assertion fail.
 *
 *   — The GENERAL allowance has no verified tenant to carry, and this is not
 *     a choice. `ThrottlerGuard` is registered BEFORE `AuthGuard`
 *     (`app/runtime.ts`, the `APP_GUARD` pair), and the tenant is attached by
 *     `AuthGuard` itself (`common/guards.ts:80-82`, `req.membership` and
 *     `patchContext`). At throttle time, on every route, no verified tenant
 *     exists. Its key is therefore the PRE-AUTHENTICATION form: the route
 *     handler and the client address, which is what `ThrottlerGuard`'s own
 *     `generateKey` already hashes (`dist/throttler.guard.js:142-145`:
 *     `sha256(Class-handler-throttlerName-tracker)`) with our tracker being
 *     `clientLimiterKey` (`app/runtime.ts`, `common/client-ip.ts:129`).
 *
 * THE TEMPTATION THIS DOCUMENTS AGAINST. The only tenant-shaped value
 * available before authentication is the `X-Business-Id` HEADER, and keying
 * on it would be worse than keying on nothing: a caller rotating that header
 * would mint a fresh allowance per forged value and have no effective limit
 * at all. An unverified identity is not an isolation dimension. So
 * `PRE_AUTH_SCOPE` is a constant, not a header read.
 *
 * ── WHEN REDIS IS GONE (DR-90 §3) ────────────────────────────────────────
 *
 * The two layers answer an outage differently, and both answers are refusals
 * of one kind or another — neither is "no limit":
 *
 *   — The identity paths (login, verification codes, password reset) keep the
 *     behaviour `infra/redis.ts:60-68` already gives them: a backend failure
 *     becomes `RateLimiterUnavailableError`, which the error filter answers
 *     503. FAIL-CLOSED, unchanged by this file.
 *   — The general allowance DEGRADES instead of failing the request: it falls
 *     back to the per-replica in-process store, logs a warning and counts a
 *     metric. A 503 on every route because a cache is down would be an
 *     outage this limiter caused; a per-replica count is the ceiling the
 *     deployment had before this card, which is strictly better than none and
 *     is reported rather than silent.
 *
 * `degraded` is readable so a test can assert the fallback actually happened
 * rather than inferring it from a count.
 */
import type { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';
import type { Metrics } from './metrics';

/** Metric names this file emits. Naming them makes a typo a compile error. */
export const RATE_LIMIT_METRICS = {
  /** One per request answered from the per-replica fallback instead of the shared store. */
  storeDegradedTotal: 'rate_limit_store_degraded_total',
} as const;

/** The key prefix and format version. A format change must not read old counters. */
export const RATE_LIMIT_KEY_PREFIX = 'rl:thr:v1';

/**
 * The isolation dimension a counter is kept under.
 *
 * `pre-auth` is the general allowance's scope, for the measured reason in the
 * header block: the throttler runs before authentication, so there is no
 * verified tenant and the route handler plus client address IS the identity.
 */
export type RateLimitScope = { readonly kind: 'pre-auth' } | { readonly kind: 'tenant'; readonly tenantId: string };

export const PRE_AUTH_SCOPE: RateLimitScope = { kind: 'pre-auth' };

/** The scope segment of a key: `ip` for the pre-auth form, `t:<uuid>` for a verified tenant. */
export function rateLimitScopeSegment(scope: RateLimitScope): string {
  if (scope.kind === 'tenant') {
    const tenantId = scope.tenantId.trim();
    // A scope that claims a tenant and carries none would silently collapse
    // two tenants into one counter, which is the defect this segment exists
    // to prevent — so it is a refusal, not a default.
    if (tenantId.length === 0)
      throw new Error('a tenant-scoped rate limit key was asked for without a tenant id, which would merge two tenants into one allowance');
    return `t:${tenantId}`;
  }
  return 'ip';
}

/**
 * The Redis key a counter lives under: prefix, scope segment, then the key
 * the caller computed. The segments are joined with `:` and the scope comes
 * BEFORE the caller's key, so no caller-supplied text can reach across a
 * scope boundary by containing a separator.
 */
export function rateLimitKey(scope: RateLimitScope, key: string): string {
  return `${RATE_LIMIT_KEY_PREFIX}:${rateLimitScopeSegment(scope)}:${key}`;
}

/**
 * The fixed-window counter, the block flag and both remaining times, decided
 * in one body.
 *
 * KEYS[1] counter · KEYS[2] block flag
 * ARGV[1] limit · ARGV[2] window ms · ARGV[3] block ms
 *
 * Returns { totalHits, timeToExpireMs, isBlocked, timeToBlockExpireMs }.
 *
 * A key already blocked is NOT counted again — the same choice
 * `dist/throttler.service.js:67-70` makes, so a blocked caller cannot push
 * the counter further and extend its own window.
 */
const INCREMENT_LUA = `
local blockPttl = redis.call('PTTL', KEYS[2])
if blockPttl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  local pttl = redis.call('PTTL', KEYS[1])
  if pttl < 0 then pttl = 0 end
  return { hits, pttl, 1, blockPttl }
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  pttl = tonumber(ARGV[2])
end
if hits > tonumber(ARGV[1]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, pttl, 1, tonumber(ARGV[3]) }
end
return { hits, pttl, 0, 0 }
`;

/** The one Redis command this store needs, so a test can supply a fake without a server. */
export interface RateLimitEvaluator {
  /** `EVAL script 2 counterKey blockKey limit windowMs blockMs` → the four numbers above. */
  eval(script: string, keys: readonly string[], args: readonly string[]): Promise<readonly number[]>;
}

/** Narrow logger seam: this store needs one level and no transport. */
export interface DegradationLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

/** `@nestjs/throttler` reports both remaining times in SECONDS (`dist/throttler.service.js:19-24`). */
const toSeconds = (ms: number): number => Math.ceil(ms / 1000);

/**
 * The shared store behind the general allowance.
 *
 * It implements `ThrottlerStorage` exactly as 6.4.0 declares it —
 * `increment(key, ttl, limit, blockDuration, throttlerName)` with `ttl` and
 * `blockDuration` in MILLISECONDS (`app/runtime.ts` passes `ttl: 60_000`) —
 * and returns a record carrying `isBlocked`, because `isBlocked` is the ONLY
 * field `ThrottlerGuard` refuses on (`dist/throttler.guard.js:115-117`). A
 * store that returned a count and left that flag false would make a stated
 * limit of 300 refuse nothing at all while readiness reported a shared store,
 * which is worse than the defect it replaced. That is why the suites assert a
 * real 429 on request `limit + 1` and not merely "the store is not the
 * in-process one".
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  readonly kind = 'redis';
  /** True once an outage has pushed at least one request to the fallback. */
  private degradedAt: number | null = null;
  private readonly fallback = new ThrottlerStorageService();

  constructor(
    private readonly redis: RateLimitEvaluator,
    private readonly deps: { readonly logger?: DegradationLogger; readonly metrics?: Metrics; readonly scope?: RateLimitScope } = {},
  ) {}

  /** Whether any request has been answered from the per-replica fallback. */
  get degraded(): boolean {
    return this.degradedAt !== null;
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const scope = this.deps.scope ?? PRE_AUTH_SCOPE;
    const counterKey = rateLimitKey(scope, `${throttlerName}:${key}`);
    const blockKey = `${counterKey}:blocked`;
    // `blockDuration` is the guard's own default of `ttl` when a throttler
    // declares none (`dist/throttler.guard.js:83`); a zero would make the
    // block flag expire immediately and the refusal unobservable.
    const blockMs = blockDuration > 0 ? blockDuration : ttl;
    try {
      const out = await this.redis.eval(INCREMENT_LUA, [counterKey, blockKey], [String(limit), String(ttl), String(blockMs)]);
      const [totalHits, windowMs, blocked, blockMsLeft] = out;
      if (typeof totalHits !== 'number' || typeof windowMs !== 'number' || typeof blocked !== 'number' || typeof blockMsLeft !== 'number')
        throw new Error('the rate-limit script did not return the four numbers this store reads, so the answer cannot be trusted');
      return {
        totalHits,
        timeToExpire: toSeconds(windowMs),
        isBlocked: blocked === 1,
        timeToBlockExpire: toSeconds(blockMsLeft),
      };
    } catch (cause) {
      return this.degrade(cause, key, ttl, limit, blockDuration, throttlerName);
    }
  }

  /**
   * DR-90 §3, the non-identity half: the request is still counted, against
   * this replica's own store, and the degradation is said out loud.
   *
   * It is never "no limit": the fallback is the same in-process store the
   * deployment had before this card, so the worst case is the ceiling TD-24
   * described rather than an absent one.
   */
  private async degrade(
    cause: unknown,
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const first = this.degradedAt === null;
    this.degradedAt = Date.now();
    this.deps.metrics?.increment(RATE_LIMIT_METRICS.storeDegradedTotal, { throttler: throttlerName });
    // One line per request would become the outage's own amplifier, so the
    // body is logged on the first degraded request and counted on every one.
    if (first)
      this.deps.logger?.warn(
        { reason: cause instanceof Error ? cause.message : String(cause), throttler: throttlerName },
        'rate limit store unreachable — the general allowance is counted PER REPLICA until it returns',
      );
    return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
  }
}

/**
 * An `ioredis` client as the one command this store needs.
 *
 * The connection options are the ones `RedisRateLimiter` already measured its
 * way to (`infra/redis.ts:49-58`): no offline queue, so an outage surfaces as
 * an error immediately instead of hanging a request behind a reconnect, and a
 * client-level `error` listener that exists only so an unhandled event cannot
 * take the process down — every failure that matters is caught per command,
 * at the call site that can answer for it.
 */
export function createRedisEvaluator(url: string): RateLimitEvaluator & { close(): Promise<void> } {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1_000)),
  });
  redis.on('error', () => undefined);
  return {
    eval: async (script, keys, args) => {
      const out: unknown = await redis.eval(script, keys.length, ...keys, ...args);
      if (!Array.isArray(out)) throw new Error('the rate-limit script did not return an array');
      return out.map((v) => Number(v));
    },
    close: async () => {
      await redis.quit();
    },
  };
}

/**
 * The store `ThrottlerModule.forRoot` is given.
 *
 * The selection is the SAME CONDITION the identity limiter already uses
 * (`app/runtime.ts`, `REDIS_URL ? RedisRateLimiter : MemoryRateLimiter`), and
 * deliberately not `isProd`:
 *
 *   — production cannot start without `REDIS_URL` (`config.ts:281-282`), so
 *     every production HTTP surface gets the shared store by construction;
 *   — a test or development process has none, so it keeps the in-process
 *     store — which is the premise
 *     `tests/performance/pos-s3-budgets.test.ts:548-553` depends on when it
 *     clears that store's `Map` between two measurements, and that file
 *     belongs to another lane and is not touched by this card.
 *
 * `undefined` means "no opinion": `forRoot` then binds the in-process store
 * itself, so this function never has to name the default twice.
 */
export function createThrottlerStorage(
  config: { readonly REDIS_URL?: string | undefined },
  deps: { readonly logger?: DegradationLogger; readonly metrics?: Metrics } = {},
): ThrottlerStorage | undefined {
  if (!config.REDIS_URL) return undefined;
  return new RedisThrottlerStorage(createRedisEvaluator(config.REDIS_URL), deps);
}
