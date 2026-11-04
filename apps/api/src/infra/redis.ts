import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import type { AppConfig } from '../config';

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

  private connecting: Promise<unknown> | null = null;
  private closed = false;

  /**
   * Complete the handshake before issuing a command — and be able to do it
   * AGAIN after an outage.
   *
   * Without this, `lazyConnect` and `enableOfflineQueue: false` combine into a
   * refusal of real traffic: `sendCommand` sees status `wait`, starts
   * `connect()`, and computes `writable` in the SAME TICK, when `this.stream`
   * does not exist yet (ioredis `built/Redis.js:327-366`). The command is
   * rejected with "Stream isn't writeable and enableOfflineQueue options is
   * false", `guarded` reads that as a backend failure, and a login or a
   * password reset is answered 503 while Redis is perfectly healthy. Measured
   * against a real RESP handshake in
   * `tests-unit/td24-redis-first-command.test.ts`: the refusals last as long
   * as the handshake does, so a deploy refuses a RUN of requests, not one.
   *
   * A finished attempt is cleared rather than kept as a standing liveness
   * claim, and a client in `end` or `wait` is dialled again — `connect()`
   * rejects only from `connecting`/`connect`/`ready` (`built/Redis.js:103-110`).
   * Without the re-dial, ioredis's retry budget (which it resets only on
   * `ready`) would leave the client in `end` for the life of the process and
   * every later request would be refused, which is the same defect with a
   * longer fuse.
   *
   * The offline queue stays OFF: a genuine outage must still surface as an
   * error on the command rather than hang a request behind a reconnect, and
   * `take` must still fail closed (§67).
   */
  private async ready(): Promise<void> {
    if (this.closed) throw new Error('the rate limiter was closed and must not reconnect');
    if (this.redis.status === 'ready') return;
    if (this.redis.status === 'end' || this.redis.status === 'wait') this.connecting = null;
    this.connecting ??= this.redis.connect().then(
      () => {
        this.connecting = null;
      },
      (e: unknown) => {
        this.connecting = null;
        throw e;
      },
    );
    await this.connecting;
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
    // `quit` on a client that never connected rejects — a limiter that was
    // built and never used must still close cleanly, and `disconnect` leaves
    // no reconnect timer behind either way.
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
