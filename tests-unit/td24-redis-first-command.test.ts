/**
 * THE IDENTITY LIMITER REFUSES REAL LOGINS WITH 503 UNTIL ITS CONNECTION IS
 * READY — AGAINST A HEALTHY REDIS.
 *
 * Found by the second independent review of PR #46 (finding 5) and brought
 * into this lane by the coordinator, because `apps/api/src/infra/redis.ts` is
 * the Redis client the limiter stands on. It is NOT a defect this card
 * introduced: it is on `main`.
 *
 * ── THE MECHANISM, MEASURED ──────────────────────────────────────────────
 *
 * `RedisRateLimiter` builds its client with `lazyConnect: true` and
 * `enableOfflineQueue: false` (`infra/redis.ts:49-58`). In
 * `node_modules/ioredis/built/Redis.js:327-366`, `sendCommand` sees status
 * `wait`, kicks off `connect()`, and then computes `writable` IN THE SAME
 * TICK — when the status is `connecting` and `this.stream` does not exist
 * yet. `writable` is false, and with no offline queue the command is
 * rejected outright: "Stream isn't writeable and enableOfflineQueue options
 * is false".
 *
 * `guarded()` (`infra/redis.ts:61-68`) then wraps that into
 * `RateLimiterUnavailableError`, which is the deliberate FAIL-CLOSED answer
 * for a real outage (Directive §67) and becomes a 503. So the refusal is
 * correct machinery reading a false premise: the backend was never
 * unreachable, the command simply never left the process.
 *
 * ── WHY THIS FILE NEEDS A SERVER, AND HOW IT HAS ONE ─────────────────────
 *
 * The claim is "with a HEALTHY Redis the request must not be refused", and
 * that cannot be measured against a closed port — every answer there is a
 * refusal, so the case would pass before the fix and after it. There is no
 * Redis on this host and no Docker, so the suite starts a MINIMAL RESP
 * SERVER on a loopback port: enough of the protocol for ioredis to complete
 * its handshake (`INFO` reporting `loading:0`) and to answer the two commands
 * `take` issues (`INCR`, `EXPIRE`).
 *
 * It is a fake, and the boundary is stated rather than left to be found: it
 * is evidence about WHEN A COMMAND IS SENT, which is the whole subject here,
 * and it is NOT evidence about Redis's own semantics. `seen` is asserted so
 * that a case cannot pass against a server that answered nothing — the
 * commands are read off the wire, not assumed.
 *
 * ── MEASURED BEFORE THE FIX, ON THIS SERVER ──────────────────────────────
 *
 *   today's options, first command    FAIL  Stream isn't writeable…
 *   today's options, second command   FAIL  Stream isn't writeable…
 *   handshake awaited, first command  OK 1
 *
 * The second line is why this file says "until the connection is ready"
 * rather than "the first request": the refusals last as long as the handshake
 * does, so a deploy refuses a RUN of logins and password resets, not one.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { RateLimiterUnavailableError, RedisRateLimiter } from '../apps/api/src/infra/redis';
import type { AppConfig } from '../apps/api/src/config';

/**
 * A server that ACCEPTS the socket and never speaks — Redis loading an RDB,
 * or a load balancer that accepts and swallows. This is not a hypothetical
 * shape: it is what this host's own shared cluster on port 55432 was doing
 * while this card was written (TCP accepted in 3ms, zero bytes back in 60s).
 */
async function startSilentServer(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the silent server did not bind a port');
  return {
    url: `redis://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on: bound, read, then released, so it is never a guess. */
async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('could not reserve a port to then release');
  const { port } = address;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface FakeRedis {
  readonly url: string;
  /** The command names this server actually received, in order. */
  readonly seen: string[];
  /** Drop every open connection, as a restarting Redis would. */
  dropConnections(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A loopback server that speaks just enough RESP for ioredis to become
 * `ready` and to answer the limiter's commands. Every reply is a fixed,
 * well-formed RESP value; nothing here interprets Redis semantics.
 */
async function startFakeRedis(): Promise<FakeRedis> {
  const seen: string[] = [];
  // `server.close()` stops accepting but WAITS for open connections, so a
  // client still attached would hang the teardown — which it did, and the
  // failure looked like the subject timing out rather than the fake.
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        if (!buffered.startsWith('*')) break;
        const lines = buffered.split('\r\n');
        const argc = Number(lines[0]?.slice(1));
        if (!Number.isFinite(argc)) break;
        const consumed = 1 + argc * 2;
        if (lines.length - 1 < consumed) break; // a partial command: wait for more
        const args: string[] = [];
        for (let i = 0; i < argc; i += 1) args.push(lines[2 + i * 2] ?? '');
        buffered = lines.slice(consumed).join('\r\n');
        const command = (args[0] ?? '').toLowerCase();
        seen.push(command);
        if (command === 'info') {
          // `loading:0` is what ioredis's ready check waits for.
          const body = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';
          socket.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
        } else if (command === 'ping') socket.write('+PONG\r\n');
        else if (command === 'incr' || command === 'expire' || command === 'ttl' || command === 'del') socket.write(':1\r\n');
        else socket.write('+OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake Redis did not bind a port, so nothing below would be a measurement');
  return {
    url: `redis://127.0.0.1:${address.port}`,
    seen,
    dropConnections: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

/** The limiter's own slice of configuration, and nothing else. */
const configFor = (url: string): AppConfig => ({ REDIS_URL: url }) as unknown as AppConfig;

let limiter: RedisRateLimiter | null = null;
let fake: FakeRedis | null = null;

afterEach(async () => {
  await limiter?.close().catch(() => undefined);
  limiter = null;
  await fake?.close();
  fake = null;
}, 20_000);

describe('TD-24 / finding 5 — a healthy Redis must not produce a 503', () => {
  it('TD24-FIRST: the first take against a healthy Redis is NOT refused', async () => {
    fake = await startFakeRedis();
    limiter = new RedisRateLimiter(configFor(fake.url));

    // THE CLAIM. Red before the fix with `RateLimiterUnavailableError`, which
    // the error filter answers 503 — on login, on refresh, on password reset.
    await expect(limiter.take('login:ip:198.51.100.7', 30, 300)).resolves.toBeUndefined();

    // Read off the wire: the command reached the server. Without this the
    // case could pass against a client that answered locally.
    expect(fake.seen).toContain('incr');
  }, 20_000);

  it('TD24-FIRST-RUN: and neither are the ones behind it, which is the real shape of the outage', async () => {
    fake = await startFakeRedis();
    limiter = new RedisRateLimiter(configFor(fake.url));

    // Issued together, as a deploy's first arrivals are: with the handshake
    // unawaited these all raced it and all lost.
    const answers = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        limiter?.take(`login:ip:203.0.113.${i}`, 30, 300).then(
          () => 'admitted',
          (e: unknown) => (e instanceof Error ? e.name : 'unknown'),
        ),
      ),
    );
    expect(answers.length).toBe(5);
    expect(answers).toEqual(['admitted', 'admitted', 'admitted', 'admitted', 'admitted']);
  }, 20_000);

  it('TD24-FIRST-NEG (negative control): the old client options still fail on a healthy server', async () => {
    fake = await startFakeRedis();
    // The options exactly as `infra/redis.ts` set them before this commit,
    // with no awaited handshake. If this case ever stops failing, ioredis has
    // changed and the fix above is no longer the thing holding the claim up —
    // so the law is pinned to the BEHAVIOUR, not to the diff.
    const raw = new Redis(fake.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 2_000,
      enableOfflineQueue: false,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1_000)),
    });
    raw.on('error', () => undefined);
    try {
      const reason = await raw.incr('rl:probe').then(
        () => 'admitted',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(reason).toMatch(/Stream isn't writeable/);
    } finally {
      raw.disconnect();
    }
  }, 20_000);

  it('TD24-FIRST-CLOSED: a backend that is genuinely unreachable still fails closed', async () => {
    // The fix must not turn an outage into a pass: the answer must still be
    // the fail-closed error §67 requires, never a silent "no limit". The port
    // is RESERVED AND RELEASED rather than written down — a hardcoded number
    // that something happened to be listening on would quietly turn this case
    // into a different one.
    const port = await unusedPort();
    limiter = new RedisRateLimiter(configFor(`redis://127.0.0.1:${port}`));
    await expect(limiter.take('login:ip:198.51.100.9', 30, 300)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  }, 15_000);

  it('TD24-SILENT: a backend that accepts and never speaks is REFUSED, not waited on', async () => {
    // The defect the first version of this fix introduced, and the reason the
    // handshake wait is bounded. Measured then: the old code refused in 1ms,
    // the awaited connect() was still pending at 8001ms. A hung login is
    // worse than a wrong 503, and DR-90 §3 asks for a clear fail-closed 503.
    const silent = await startSilentServer();
    try {
      limiter = new RedisRateLimiter(configFor(silent.url));
      const started = Date.now();
      await expect(limiter.take('login:ip:198.51.100.11', 30, 300)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
      // BOUNDED: the refusal arrives on the handshake budget, not when the
      // test runner gives up. 5s is well inside this case's own timeout, so a
      // regression to an unbounded wait fails here rather than timing out.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await limiter?.close().catch(() => undefined);
      limiter = null;
      await silent.close();
    }
  }, 20_000);

  it('TD24-REDIAL: after the connection drops, a later request connects again', async () => {
    // The other half the review found untested: the re-dial. Without it,
    // ioredis's retry budget — reset only on `ready` — leaves the client in
    // `end` for the life of the process, so one blip refuses everything
    // afterwards. The fake drops the socket, which is what a restart looks
    // like from the client's side.
    fake = await startFakeRedis();
    limiter = new RedisRateLimiter(configFor(fake.url));
    await expect(limiter.take('login:ip:198.51.100.13', 30, 300)).resolves.toBeUndefined();

    await fake.dropConnections();
    // A command may lose the race with the drop; what must NOT happen is that
    // every later command fails for ever. Retried briefly, it must succeed.
    let admitted = false;
    for (let attempt = 0; attempt < 10 && !admitted; attempt += 1) {
      admitted = await limiter.take('login:ip:198.51.100.13', 30, 300).then(
        () => true,
        () => false,
      );
      if (!admitted) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(admitted).toBe(true);
  }, 25_000);
});
