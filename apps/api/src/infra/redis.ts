import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import type { AppConfig } from '../config';

/**
 * How long a command may wait for the handshake before the limiter answers
 * fail-closed. It matches `connectTimeout` below, because the two cover the
 * two halves of the same connection: the socket, and the protocol.
 *
 * THIS IS A TIGHTENING, NOT A RAISED TIMEOUT (DR-92). There was no timeout on
 * this path at all: `connectTimeout` is cleared when the SOCKET connects, not
 * when the handshake finishes (`ioredis/built/Redis.js:163-184`), so a
 * backend that accepted TCP and never answered `INFO` was waited on
 * FOR EVER. Measured on a server that accepts and stays silent: the
 * unbounded version was still pending at 8001ms where the code before it
 * refused in 1ms. So this value bounds an unbounded wait, which is why it is
 * not read under DR-41/DR-74 ("no raised performance limit or timeout") —
 * what has no bound cannot be raised.
 */
const READY_TIMEOUT_MS = 2_000;

export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitError';
  }
}

/**
 * Directive §67 (Redis outage): the rate-limit backend being unreachable is
 * a FAIL-CLOSED condition for the abuse-protected auth paths — the request
 * is refused with a safe 503, never a 500 and never "no limit".
 */
export class RateLimiterUnavailableError extends Error {
  constructor(cause: unknown) {
    super('rate limiter backend unavailable');
    this.name = 'RateLimiterUnavailableError';
    this.cause = cause;
  }
}

export interface RateLimiter {
  /** Throws RateLimitError when the key exceeds max within windowSeconds. */
  take(key: string, max: number, windowSeconds: number): Promise<void>;
  /**
   * §XXXIII: increment a signal counter and return the current count within
   * the window. Used for SOFT-DELAY account risk (never a hard lockout an
   * attacker can trigger against a victim's account).
   */
  increment(key: string, windowSeconds: number): Promise<number>;
  /** §XXXIII: clear a signal counter (successful auth decays account risk). */
  reset(key: string): Promise<void>;
  /** Readiness probe (§29): backend reachable. */
  healthCheck(): Promise<boolean>;
  readonly kind: string;
  close(): Promise<void>;
}

/** Redis fixed-window limiter — shared across API instances (§112: no process-local uniqueness/locks). */
@Injectable()
export class RedisRateLimiter implements RateLimiter {
  readonly kind = 'redis';
  private readonly redis: Redis;
  constructor(@Inject('APP_CONFIG') config: AppConfig) {
    if (!config.REDIS_URL) throw new Error('REDIS_URL required for RedisRateLimiter');
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 2_000,
      enableOfflineQueue: false, // an outage surfaces as an error immediately, not a hang
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1_000)),
    });
    // Errors are surfaced per command (below); the client-level listener only
    // prevents an unhandled 'error' event from crashing the process.
    this.redis.on('error', () => undefined);
  }

  private waiting: Promise<void> | null = null;
  private closed = false;

  /**
   * Complete the handshake before issuing a command — WITHIN A BOUND, and
   * without ever dialling a client that is already dialling.
   *
   * ── WHY THE HANDSHAKE IS AWAITED AT ALL ──────────────────────────────
   *
   * `lazyConnect` and `enableOfflineQueue: false` combine into a refusal of
   * real traffic: `sendCommand` sees status `wait`, starts `connect()`, and
   * computes `writable` in the SAME TICK, when `this.stream` does not exist
   * (ioredis `built/Redis.js:327-366`). The command is rejected with "Stream
   * isn't writeable and enableOfflineQueue options is false", `guarded` reads
   * that as a backend failure, and a login or a password reset is answered
   * 503 while Redis is perfectly healthy. The refusals last as long as the
   * handshake does — in status `connect` only handshake commands are writable
   * (`:345-349`), and `INCR` is not one — so a deploy refuses a RUN of
   * requests, not one.
   *
   * ── AND WHY IT IS A BOUNDED WAIT ON AN EVENT, NOT A DIAL ─────────────
   *
   * The first version of this fix awaited `connect()` and kept the promise in
   * a field, and the independent review measured two defects in it that were
   * worse than the one it removed. Both are now the reason for the shape
   * below, so neither can come back quietly:
   *
   *   1. AN UNBOUNDED WAIT. `connectTimeout` is cleared when the SOCKET
   *      connects, not when the handshake finishes (`Redis.js:163-184`), so a
   *      backend that accepts TCP and never answers `INFO` — Redis loading an
   *      RDB, or a load balancer that accepts and swallows — left the await
   *      pending for ever. Measured on a server that accepts and stays
   *      silent: the OLD code refused in 1ms, the awaited `connect()` was
   *      still pending at 8001ms with status `connect`. Trading a wrong 503
   *      for a hung login is not an improvement, and DR-90 §3 asks for "a
   *      clear fail-closed 503". Hence `READY_TIMEOUT_MS`, after which this
   *      throws and `guarded` answers 503 — the honest answer for a backend
   *      that will not speak. The same bound covers `healthCheck`, so
   *      `/ready` cannot hang on it either.
   *
   *   2. DIALLING A CLIENT THAT IS ALREADY DIALLING. ioredis reconnects on
   *      its own timer after a drop (`event_handler.js`), which this class
   *      does not see. A request arriving in status `connecting` or
   *      `reconnecting` with no promise in hand called `connect()`, which
   *      rejects from those states (`Redis.js:103-110`) — so a healthy
   *      backend mid-reconnect produced a 503 from the very code meant to
   *      stop that. So `connect()` is called ONLY from `wait` and `end`, the
   *      two states it is legal from; every other state is waited out.
   *
   * One shared wait serves all concurrent callers, and it clears itself only
   * if it is still the current one — a stale rejection must not wipe a live
   * caller's wait, which was the second half of defect 2.
   *
   * The offline queue stays OFF: a genuine outage still surfaces as an error
   * on the command, and `take` still fails closed (§67).
   */
  private async ready(): Promise<void> {
    if (this.closed) throw new Error('the rate limiter was closed and must not reconnect');
    if (this.redis.status === 'ready') return;
    this.waiting ??= this.awaitReady();
    await this.waiting;
  }

  /** Resolve on `ready`, reject on `end` or on the bound — never hang. */
  private awaitReady(): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      // `connect()` is legal only from these two states; from `connecting`,
      // `connect` or `reconnecting` it rejects, and ioredis is already on its
      // way without our help.
      if (this.redis.status === 'wait' || this.redis.status === 'end') void this.redis.connect().catch(() => undefined);
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        this.redis.off('ready', onReady);
        this.redis.off('end', onEnd);
        fn();
      };
      const onReady = (): void => settle(resolve);
      const onEnd = (): void => settle(() => reject(new Error('the rate limiter backend connection ended before the handshake completed')));
      const timer = setTimeout(
        () => settle(() => reject(new Error(`the rate limiter backend did not complete its handshake within ${READY_TIMEOUT_MS}ms`))),
        READY_TIMEOUT_MS,
      );
      this.redis.once('ready', onReady);
      this.redis.once('end', onEnd);
      if (this.redis.status === 'ready') settle(resolve); // became ready while we subscribed
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
      if (this.waiting === chained) this.waiting = null;
    });
    return chained;
  }

  /** Wrap backend failures into the fail-closed error (RateLimitError passes through). */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await this.ready();
      return await fn();
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      throw new RateLimiterUnavailableError(e);
    }
  }
  async take(key: string, max: number, windowSeconds: number): Promise<void> {
    await this.guarded(async () => {
      const k = `rl:${key}`;
      const count = await this.redis.incr(k);
      if (count === 1) await this.redis.expire(k, windowSeconds);
      if (count > max) {
        const ttl = await this.redis.ttl(k);
        throw new RateLimitError(ttl > 0 ? ttl : windowSeconds);
      }
    });
  }
  async increment(key: string, windowSeconds: number): Promise<number> {
    return this.guarded(async () => {
      const k = `rl:${key}`;
      const count = await this.redis.incr(k);
      if (count === 1) await this.redis.expire(k, windowSeconds);
      return count;
    });
  }
  async reset(key: string): Promise<void> {
    await this.guarded(() => this.redis.del(`rl:${key}`).then(() => undefined));
  }
  async healthCheck(): Promise<boolean> {
    try {
      // Readiness asked this BEFORE the handshake and read `false` from a
      // healthy backend, which is the same defect wearing a different answer:
      // a process could report itself not ready for as long as it took to
      // connect.
      await this.ready();
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    // `quit` on a client that never connected rejects, and a limiter that was
    // built and never used must still close cleanly.
    //
    // Precisely, because the first wording of this comment over-claimed:
    // `disconnect()` STOPS the reconnect loop (it clears any pending
    // reconnect timer and marks the close as manual), but it is not a
    // teardown of everything — it arms its own short `disconnectTimeout` and
    // adds a `close` listener per call in the connector, and the
    // client-level `error` listener this constructor attached is never
    // removed. Nothing here is unbounded and nothing holds the event loop
    // open, which is what matters at shutdown; "leaves no timer behind" was
    // simply not true.
    if (this.redis.status === 'ready') await this.redis.quit().catch(() => undefined);
    else this.redis.disconnect();
  }
}

/** Deterministic in-memory limiter — tests and single-process dev ONLY. Never production multi-instance. */
export class MemoryRateLimiter implements RateLimiter {
  readonly kind = 'memory-development-only';
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  take(key: string, max: number, windowSeconds: number): Promise<void> {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return Promise.resolve();
    }
    entry.count += 1;
    if (entry.count > max) {
      return Promise.reject(new RateLimitError(Math.ceil((entry.resetAt - now) / 1000)));
    }
    return Promise.resolve();
  }
  increment(key: string, windowSeconds: number): Promise<number> {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return Promise.resolve(1);
    }
    entry.count += 1;
    return Promise.resolve(entry.count);
  }
  reset(key: string): Promise<void> {
    this.hits.delete(key);
    return Promise.resolve();
  }
  healthCheck(): Promise<boolean> {
    return Promise.resolve(true);
  }
  close(): Promise<void> {
    this.hits.clear();
    return Promise.resolve();
  }
}
