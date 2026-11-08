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
 * TD-24, and `RedisThrottlerStorage` below is what the guard is given
 * instead.
 *
 * HOW it is given matters, because the first wording of this header said
 * "passed to `forRoot`" and the wire never did that. `forRoot` still carries
 * no `storage`; the store is a PROVIDER OF THE MODULE THE GUARD LIVES IN
 * (`app/runtime.ts:556-565`), which is what a consumer in that module
 * resolves. The difference is not cosmetic: the ROOT of a testing module
 * answers the same token with the `@Global()` `ThrottlerModule`'s own
 * instance, which is exactly what made an integration probe read "no shared
 * store" while the application behaved as shared. Pinned by
 * `tests-unit/td24-limiter-store-law.test.ts` (TD24-LAW-D/D2/E).
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
import type { OnApplicationShutdown } from '@nestjs/common';
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

/** At most one warning per minute while a degradation lasts (see `degrade`). */
const WARN_COOLDOWN_MS = 60_000;

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

/** The documented tenant form: a UUID, and nothing that could carry a separator. */
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The scope segment of a key: `ip` for the pre-auth form, `t:<uuid>` for a verified tenant. */
export function rateLimitScopeSegment(scope: RateLimitScope): string {
  if (scope.kind === 'tenant') {
    const tenantId = scope.tenantId.trim();
    // A scope that claims a tenant and carries none would silently collapse
    // two tenants into one counter, which is the defect this segment exists
    // to prevent — so it is a refusal, not a default. The SHAPE is checked
    // too, and not for tidiness: the segments are joined with `:`, so a
    // tenant id carrying one could be read as a different scope entirely.
    // `t:<uuid>` is what this file documents, so `t:<uuid>` is what it takes.
    if (!TENANT_ID.test(tenantId))
      throw new Error(
        `a tenant-scoped rate limit key needs a tenant id of the documented form, not ${JSON.stringify(scope.tenantId)} — anything else would merge or misattribute an allowance`,
      );
    return `t:${tenantId}`;
  }
  return 'ip';
}

/**
 * The Redis key a counter lives under: prefix, then a HASH TAG holding the
 * scope segment and the key the caller computed. The segments are joined with
 * `:` and the scope comes BEFORE the caller's key, so no caller-supplied text
 * can reach across a scope boundary by containing a separator.
 *
 * ── WHY THE BRACES, AND WHY THEY ARE WHERE THEY ARE ──────────────────────
 *
 * `increment` runs ONE `EVAL` over TWO keys — this counter and its `:blocked`
 * flag — and Redis Cluster refuses a command whose keys do not hash to the
 * same slot: `CROSSSLOT Keys in request don't hash to the same slot`. Every
 * `EVAL` would then fail, `increment` would fall through to the per-replica
 * fallback, and the general allowance would be counted PER REPLICA again for
 * the whole life of the deployment — TD-24 itself, reached through the fix
 * for TD-24, with one log line and no visible failure.
 *
 * In cluster mode the slot is `CRC16(hash tag) mod 16384`, where the tag is
 * what lies between the FIRST `{` and the first `}` after it. So the remedy
 * is not a tag of some tenant's id — the general allowance has no verified
 * tenant by construction (see the header) — but a tag over exactly the part
 * the two keys of one request SHARE. The block key is this key plus a
 * `:blocked` suffix (`increment`), so both carry the same first `{`…`}` and
 * land in one slot BY CONSTRUCTION, including when the caller's own text
 * carries a brace: the tag ends before any of it.
 *
 * Measured, because the alternative was assuming: one constant tag for every
 * key would also satisfy the cluster, by collapsing every allowance in the
 * system into a single slot — a performance defect traded for a correctness
 * one. The tag here varies with the scope and the caller's key, so slots stay
 * spread (`rl:thr:v1:{ip:default:…}` and a tenant's key measured into 8558
 * and 9439 of 16384). `tests-unit/td24-eval-hash-tag-law.test.ts` computes
 * the slot of every key of one `EVAL` and asserts they match, with a negative
 * control that an untagged pair does NOT.
 *
 * This file still does NOT claim to have measured Redis Cluster: nothing in
 * CI or on a development host runs one. What is measured is slot equality,
 * which is the cluster's own published condition.
 */
export function rateLimitKey(scope: RateLimitScope, key: string): string {
  return `${RATE_LIMIT_KEY_PREFIX}:{${rateLimitScopeSegment(scope)}:${key}}`;
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
  /** Release the backend. Optional so a test fake need not implement it. */
  close?(): Promise<void>;
  /** Is the backend reachable RIGHT NOW? Optional; a fake without one reports reachable. */
  ping?(): Promise<boolean>;
  /**
   * How many times this evaluator has DIALLED the backend.
   *
   * It exists so that recovery can be measured rather than argued: a client
   * that stopped dialling after its retries were spent is the defect the
   * second review found, and the only honest proof that it dials again is a
   * count of attempts. Optional, so a fake need not have one.
   */
  dialAttempts?(): number;
}

/** Narrow logger seam: this store needs one level and no transport. */
export interface DegradationLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

/**
 * How long a caller waits for the handshake before the store degrades.
 *
 * NOT a new allowance (DR-41/DR-74): it is the SAME 2s as this file's own
 * `connectTimeout` and the same bound `infra/redis.ts:20` waits on, named
 * here so a wait cannot outlive the dial it is waiting for. Unbounded, a
 * backend that accepts the socket and never speaks would hang every request
 * instead of failing closed.
 */
const READY_TIMEOUT_MS = 2_000;

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
export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  readonly kind = 'redis';
  /**
   * When the CURRENT run of degradation began, and `null` the moment the
   * shared store answers again.
   *
   * It was a sticky flag in the first draft and that was a defect the review
   * measured: a single failure anywhere in the life of the process made
   * `degraded` true for ever, so the signal said nothing about now. It also
   * burned the one-off warning, which — with the connection defect below —
   * every process hit on its first request, leaving a REAL outage later to
   * pass without a line in the log.
   */
  private degradedSince: number | null = null;
  /** When the warning was last emitted, so an outage cannot amplify itself. */
  private lastWarnedAt = 0;
  /** Requests answered from the fallback, for the readiness surface to report. */
  private degradedRequestCount = 0;
  private readonly fallback = new ThrottlerStorageService();

  constructor(
    private readonly redis: RateLimitEvaluator,
    private readonly deps: {
      readonly logger?: DegradationLogger;
      readonly metrics?: Metrics;
      readonly scope?: RateLimitScope;
      readonly now?: () => number;
    } = {},
  ) {}

  /** Whether the shared store is unreachable RIGHT NOW, not ever. */
  get degraded(): boolean {
    return this.degradedSince !== null;
  }

  /** How many requests this replica has answered from its own store. */
  get degradedRequests(): number {
    return this.degradedRequestCount;
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const scope = this.deps.scope ?? PRE_AUTH_SCOPE;
    const counterKey = rateLimitKey(scope, `${throttlerName}:${key}`);
    // A SUFFIX of the counter key, and that is load-bearing rather than tidy:
    // the two keys of this one `EVAL` therefore share their hash tag, so a
    // cluster puts them in one slot instead of refusing the command with
    // CROSSSLOT (see `rateLimitKey`). Anything that made this key diverge
    // before the counter key's closing `}` would reopen TD-24 on a cluster.
    const blockKey = `${counterKey}:blocked`;
    // `blockDuration` is the guard's own default of `ttl` when a throttler
    // declares none (`dist/throttler.guard.js:83`); a zero would make the
    // block flag expire immediately and the refusal unobservable.
    const blockMs = blockDuration > 0 ? blockDuration : ttl;
    try {
      const out = await this.redis.eval(INCREMENT_LUA, [counterKey, blockKey], [String(limit), String(ttl), String(blockMs)]);
      const [totalHits, windowMs, blocked, blockMsLeft] = out;
      // `Number.isFinite`, not `typeof === 'number'`: the evaluator converts
      // with `Number()`, and `NaN` is a number. A `NaN` count compares false
      // against every limit, so it would admit every request for ever — the
      // exact shape of defect this store exists to remove.
      if (!Number.isFinite(totalHits) || !Number.isFinite(windowMs) || !Number.isFinite(blocked) || !Number.isFinite(blockMsLeft))
        throw new Error('the rate-limit script did not return four finite numbers, so the answer cannot be trusted');
      // The shared store answered: this replica is no longer degraded, and the
      // next outage gets its own warning.
      this.degradedSince = null;
      return {
        totalHits: totalHits as number,
        timeToExpire: toSeconds(windowMs as number),
        isBlocked: blocked === 1,
        timeToBlockExpire: toSeconds(blockMsLeft as number),
      };
    } catch (cause) {
      return this.degrade(cause, key, ttl, limit, blockDuration, throttlerName);
    }
  }

  /**
   * Is the shared store reachable RIGHT NOW?
   *
   * `degraded` answers "did the last request fall back", which the second
   * review rightly called a statement about the last request rather than
   * about now: an idle replica would read healthy while Redis was down. So
   * readiness asks the backend, exactly as it already asks the identity
   * limiter (`platform.controller.ts`, `limiter.healthCheck()`), and
   * `degradedRequests` stays beside it as the history.
   */
  async healthCheck(): Promise<boolean> {
    return (await this.redis.ping?.()) ?? true;
  }

  /** Release the backend with the application, so no client outlives `app.close()`. */
  async onApplicationShutdown(): Promise<void> {
    this.fallback.onApplicationShutdown();
    await this.redis.close?.();
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
    const now = (this.deps.now ?? Date.now)();
    if (this.degradedSince === null) this.degradedSince = now;
    this.degradedRequestCount += 1;
    this.deps.metrics?.increment(RATE_LIMIT_METRICS.storeDegradedTotal, { throttler: throttlerName });
    // A line per request would make the outage its own amplifier, and a
    // once-per-process line would be spent by the first blip and say nothing
    // about the outage that matters. So it is a COOLDOWN: the reason is
    // repeated while the degradation lasts, at most once a window.
    if (now - this.lastWarnedAt >= WARN_COOLDOWN_MS) {
      this.lastWarnedAt = now;
      this.deps.logger?.warn(
        { reason: cause instanceof Error ? cause.message : String(cause), throttler: throttlerName, degradedRequests: this.degradedRequestCount },
        'rate limit store unreachable — the general allowance is counted PER REPLICA until it returns',
      );
    }
    return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
  }
}

/**
 * An `ioredis` client as the one command this store needs.
 *
 * ── THE HANDSHAKE IS AWAITED, AND THAT IS NOT A STYLE CHOICE ─────────────
 *
 * The first draft copied `RedisRateLimiter`'s options verbatim
 * (`infra/redis.ts:49-58`) — `lazyConnect: true` with `enableOfflineQueue:
 * false` — and the review caught what that combination does. Measured in
 * `node_modules/ioredis/built/Redis.js:327-366`: `sendCommand` sees status
 * `wait`, kicks off `connect()`, and then computes `writable` IN THE SAME
 * TICK, when the status is `connecting` and `this.stream` does not exist
 * yet. `writable` is false, and with no offline queue the command is
 * REJECTED — "Stream isn't writeable and enableOfflineQueue options is
 * false", reproduced directly.
 *
 * So the FIRST request of every process would have been answered from the
 * fallback against a perfectly healthy Redis. With a sticky flag and a
 * once-per-process warning, that one unavoidable failure would have marked
 * the replica degraded for its whole life and spent the only line a real
 * outage had left to say anything with.
 *
 * `ready()` is therefore awaited before every evaluation: it performs the
 * connect once, and a FAILED connect clears the promise so the next request
 * tries again rather than inheriting a dead one. The offline queue stays off,
 * so a real outage still surfaces as an error on the command rather than
 * hanging a request behind a reconnect.
 *
 * The client-level `error` listener exists only so an unhandled event cannot
 * take the process down; every failure that matters is caught per command, at
 * the call site that can answer for it.
 */
export function createRedisEvaluator(url: string): RateLimitEvaluator {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1_000)),
  });
  /**
   * The client's own last failure, so a refusal from here NAMES ITS CAUSE.
   *
   * Measured on a dead port, because the first version of the wait below
   * threw its own message away over the cause and the evidence got worse:
   * `connect()` rejects while the status is still `reconnecting`, ioredis
   * keeps retrying on its own timer, and `end` arrives only after the
   * retries are spent — later than the bound here. A caller that reported
   * "did not complete its handshake" where ioredis had said `ECONNREFUSED`
   * would put the useless half in the degradation log, which is the one line
   * a real outage gets.
   *
   * It is cleared at the start of each wait, so a stale failure can never be
   * reported as the reason for a later one.
   */
  let lastError: unknown;
  redis.on('error', (e: unknown) => {
    lastError = e;
  });
  /** The one wait every concurrent caller shares while the client is on its way. */
  let waiting: Promise<void> | null = null;
  let closed = false;
  let dialled = 0;
  /**
   * Connect once, be able to connect AGAIN, and NEVER call `connect()` from a
   * state that rejects it. Three defects sat here in turn, each found by a
   * review, and the third is why this now reads like `infra/redis.ts` does.
   *
   *   (1) `retryStrategy` returns null after three attempts, and ioredis does
   *       not reset its attempt counter until it reaches `ready`
   *       (`built/redis/event_handler.js`), so an outage of more than about a
   *       second puts the client in status `end` PERMANENTLY: `sendCommand`
   *       rejects "Connection is closed." without ever dialling again
   *       (`built/Redis.js:331-334`). A promise cleared only on failure
   *       stayed resolved from the first success, so nothing dialled again
   *       either, and the replica counted per replica for the rest of its
   *       life even after Redis came back — TD-24's own defect, reintroduced
   *       by the fix for it.
   *   (2) `connect()` IS NOT LEGAL FROM EVERY STATE. It rejects outright from
   *       `connecting`, `connect` and `ready` (`built/Redis.js:103-110`).
   *       Calling it after a successful connect had cleared the promise meant
   *       that a replica whose connection merely DROPPED — with ioredis
   *       already dialling again on its own timer — answered the next request
   *       with "Redis is already connecting/connected". That error is
   *       indistinguishable here from a real outage: `increment` degrades,
   *       the general allowance goes back to being counted PER REPLICA, and
   *       `/v1/health/ready` reports `throttlerStore.ok = false` against a
   *       perfectly healthy Redis. A HEALTHY BACKEND MID-RECONNECT WOULD HAVE
   *       REOPENED TD-24. From `reconnecting` it is worse than an error: the
   *       call is accepted and opens a SECOND dial alongside the library's
   *       own retry timer.
   *   (3) `dialled` counted calls to this function rather than dials, so
   *       `TD24-REDIAL`'s "it dialled again" would have held even if
   *       `connect()` had never fired. It is now incremented at the one place
   *       a dial actually happens.
   *
   * So `connect()` is called ONLY from `wait` and `end`, the two states it is
   * legal from; every other state is ALREADY on its way and is waited out, on
   * the client's own `ready`/`end` events. One shared wait serves all
   * concurrent callers and clears itself only if it is still the current one
   * — a stale rejection must not wipe a live caller's wait.
   *
   * The offline queue stays off, so a genuine outage still surfaces as an
   * error on the command and the store still degrades deliberately (§67)
   * rather than hanging a request behind a reconnect.
   */
  const awaitReady = (): Promise<void> => {
    lastError = undefined; // this wait reports only what fails during it
    /** The client's own failure where there is one; otherwise what this wait can honestly say. */
    const reason = (fallback: string): Error => (lastError instanceof Error ? lastError : new Error(fallback));
    const promise = new Promise<void>((resolve, reject) => {
      if (redis.status === 'wait' || redis.status === 'end') {
        dialled += 1; // counted WHERE THE DIAL IS, so the count cannot overstate it
        void redis.connect().catch(() => undefined); // the events below are the answer
      }
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        redis.off('ready', onReady);
        redis.off('end', onEnd);
        fn();
      };
      const onReady = (): void => settle(resolve);
      const onEnd = (): void => settle(() => reject(reason('the rate limit store backend connection ended before the handshake completed')));
      const timer = setTimeout(
        () => settle(() => reject(reason(`the rate limit store backend did not complete its handshake within ${READY_TIMEOUT_MS}ms`))),
        READY_TIMEOUT_MS,
      );
      redis.once('ready', onReady);
      redis.once('end', onEnd);
      if (redis.status === 'ready') settle(resolve); // became ready while we subscribed
    });
    const chained: Promise<void> = promise.finally(() => {
      // THE FIELD HOLDS THE CHAINED PROMISE, so that is what is compared.
      // Comparing the inner one never matched, so the wait was NEVER cleared:
      // after the first success every later caller awaited a promise that was
      // already resolved, `ready()` became a no-op, and nothing ever dialled
      // again. Measured by `tests-unit/td24-redis-reconnect-law.test.ts`,
      // which failed on exactly this while the rest of the remedy was right.
      // Only the CURRENT wait may clear the field: a late rejection from a
      // superseded attempt must not erase a live one.
      if (waiting === chained) waiting = null;
    });
    return chained;
  };
  const ready = async (): Promise<void> => {
    if (closed) throw new Error('the rate limit store was released with the application and must not reconnect');
    if (redis.status === 'ready') return;
    waiting ??= awaitReady();
    await waiting;
  };
  return {
    eval: async (script, keys, args) => {
      await ready();
      const out: unknown = await redis.eval(script, keys.length, ...keys, ...args);
      if (!Array.isArray(out)) throw new Error('the rate-limit script did not return an array');
      return out.map((v) => Number(v));
    },
    dialAttempts: () => dialled,
    ping: async () => {
      try {
        await ready();
        return (await redis.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    close: async () => {
      closed = true;
      // `quit` on a client that never connected rejects, so `disconnect()`
      // is the honest shutdown either way.
      //
      // And only that much is claimed: an earlier wording here said it
      // "leaves no reconnect timer behind", which `infra/redis.ts:208-221`
      // withdraws by name after measuring it. `disconnect()` DOES stop the
      // reconnect loop — it clears a pending reconnect timer and marks the
      // close as manual — but it is not a teardown of everything: it arms its
      // own short `disconnectTimeout` and adds a listener per call in the
      // connector. Two comments in one PR may not disagree about the same
      // call, and the measured one wins.
      redis.disconnect();
      await Promise.resolve();
    },
  };
}

/**
 * The store the guard resolves — bound as a provider of the module the guard
 * lives in (`app/runtime.ts:556-565`), not passed to `forRoot`.
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
 * `undefined` means "no opinion": the provider is then absent rather than
 * defaulted, and `ThrottlerModule` keeps answering with the in-process store
 * it binds itself — so this function never has to name the default twice.
 */
export function createThrottlerStorage(
  config: { readonly REDIS_URL?: string | undefined },
  deps: { readonly logger?: DegradationLogger; readonly metrics?: Metrics } = {},
): ThrottlerStorage | undefined {
  if (!config.REDIS_URL) return undefined;
  return new RedisThrottlerStorage(createRedisEvaluator(config.REDIS_URL), deps);
}
