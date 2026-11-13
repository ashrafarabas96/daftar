/**
 * TD-24 — A HEALTHY REDIS MID-RECONNECT MUST NOT PUT THE GENERAL ALLOWANCE
 * BACK TO BEING COUNTED PER REPLICA.
 *
 * Found by the third independent review of PR #46, verified here against the
 * library rather than taken on trust, and this file is the control that keeps
 * it from coming back.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────
 *
 * `createRedisEvaluator`'s `ready()` called `redis.connect()` from ANY status
 * that was not `ready`. But `connect()` rejects outright from `connecting`,
 * `connect` and `ready` (`node_modules/ioredis/built/Redis.js:103-110`, read
 * in this repository's installed copy), and from `reconnecting` it is
 * accepted and opens a SECOND dial alongside the library's own retry timer.
 *
 * So a replica whose connection merely DROPPED — with ioredis already on its
 * way back without any help — answered the next request with "Redis is
 * already connecting/connected". To this store that error is
 * indistinguishable from a real outage: `increment` falls through to the
 * in-process fallback, the general allowance is counted PER REPLICA again,
 * and `/v1/health/ready` reports `throttlerStore.ok = false` against a
 * perfectly healthy backend. That is TD-24's own defect, reached through the
 * fix for TD-24 — and a dropped connection is an ordinary event, not an
 * outage: a failover, a `CLIENT KILL`, an idle timeout on a proxy.
 *
 * The remedy is the one the sibling limiter already uses
 * (`apps/api/src/infra/redis.ts:143-150`): `connect()` ONLY from `wait` and
 * `end`, the two states it is legal from, and every other state waited out on
 * the client's own `ready`/`end` events.
 *
 * ── WHY A FAKE SERVER, AND WHAT IT IS NOT EVIDENCE OF ────────────────────
 *
 * The claim is "with a backend that is COMING BACK, the request must be
 * served, not degraded", and that cannot be measured against a dead port:
 * there every answer is a refusal, so the case would pass before the fix and
 * after it. This host has no Redis and no Docker, so the suite speaks just
 * enough RESP for ioredis to reach `ready` and to answer one `EVAL`.
 *
 * It is a fake, and the boundary is stated rather than left to be found: it
 * is evidence about WHICH STATE A DIAL IS ATTEMPTED FROM, which is the whole
 * subject here. It is NOT evidence about Redis's own semantics, and not about
 * the Lua script — `tests/security/td24-redis-live.test.ts` measures those
 * against a real server in CI.
 *
 * Two claims, and the second is what keeps the first honest:
 *
 *   TD24-RECONNECT-A  THE CLAIM. A connection that drops and comes back is
 *                     served, and `dialAttempts()` does NOT move while it is
 *                     on its way — nothing dialled from a state that rejects
 *                     a dial. POSITIVE CONTROL first: the same evaluator
 *                     answers before the drop, and dialled exactly once, so
 *                     neither reading can come from a client that never
 *                     connected.
 *   TD24-RECONNECT-B  NEGATIVE CONTROL. A backend that is genuinely GONE
 *                     still fails, and the client still dials again
 *                     afterwards. Without this, A would also pass against an
 *                     evaluator that had simply stopped dialling, or one that
 *                     swallowed every failure — which is the shape of the
 *                     defect this card exists to remove.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedisEvaluator, type RateLimitEvaluator } from '../apps/api/src/infra/rate-limit-store';

const SCRIPT = 'return 1';
/** Long enough for ioredis's first retry (`times * 200`) to be pending, short enough to be inside it. */
const MID_RECONNECT_MS = 50;

interface FakeRedis {
  readonly url: string;
  /** Command names this server received, in order — so a case cannot pass against a server that answered nothing. */
  readonly seen: string[];
  /** Drop every open connection, as a failover or a `CLIENT KILL` would. */
  dropConnections(): void;
  close(): Promise<void>;
}

/**
 * A loopback server that speaks just enough RESP for ioredis to become
 * `ready` and to answer `EVAL`. Every reply is a fixed, well-formed RESP
 * value; nothing here interprets Redis semantics.
 *
 * Written out rather than imported from a sibling test: importing a module
 * that another suite owns runs that suite inside this file, which ties this
 * law's result to another lane's — measured once already on this branch.
 */
async function startFakeRedis(): Promise<FakeRedis> {
  const seen: string[] = [];
  // `server.close()` stops accepting but WAITS for open connections, so a
  // client still attached would hang the teardown.
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
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
        else if (command === 'eval') socket.write('*4\r\n:1\r\n:60000\r\n:0\r\n:0\r\n');
        else socket.write('+OK\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake Redis did not bind a port');
  return {
    url: `redis://127.0.0.1:${address.port}`,
    seen,
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const open: { evaluator?: RateLimitEvaluator; fake?: FakeRedis } = {};

afterEach(async () => {
  await open.evaluator?.close?.();
  await open.fake?.close();
  delete open.evaluator;
  delete open.fake;
});

describe('TD-24 law — a dial is only ever attempted from a state that allows one', () => {
  it('TD24-RECONNECT-A: a connection that drops and returns is served, and nothing dials while it is on its way', async () => {
    const fake = await startFakeRedis();
    open.fake = fake;
    const evaluator = createRedisEvaluator(fake.url);
    open.evaluator = evaluator;

    // POSITIVE CONTROL: this evaluator really does talk to this server, and
    // it dialled exactly once to get there.
    expect(await evaluator.eval(SCRIPT, [], [])).toEqual([1, 60000, 0, 0]);
    expect(fake.seen).toContain('eval');
    expect(evaluator.dialAttempts?.()).toBe(1);

    // A failover, a `CLIENT KILL`, a proxy's idle timeout: the socket goes,
    // the server does not. ioredis starts its own retry timer.
    fake.dropConnections();
    await delay(MID_RECONNECT_MS);

    // THE CLAIM. The request is served — not answered from the fallback —
    // and the count of dials has not moved, so nothing called `connect()`
    // from `connecting` or `reconnecting`.
    expect(await evaluator.eval(SCRIPT, [], [])).toEqual([1, 60000, 0, 0]);
    expect(evaluator.dialAttempts?.()).toBe(1);
  });

  it('TD24-RECONNECT-B (negative control): a backend that is genuinely gone still fails, and is dialled again after', async () => {
    const fake = await startFakeRedis();
    const evaluator = createRedisEvaluator(fake.url);
    open.evaluator = evaluator;

    expect(await evaluator.eval(SCRIPT, [], [])).toEqual([1, 60000, 0, 0]); // the input was not empty
    const afterConnect = evaluator.dialAttempts?.() ?? 0;
    expect(afterConnect).toBe(1);

    // Not a drop this time: the server is gone. A store that reported this
    // as served would be the defect TD-24 is about, pointing the other way.
    await fake.close();
    await expect(evaluator.eval(SCRIPT, [], [])).rejects.toThrow();

    // And once its retries are spent the client must dial AGAIN rather than
    // sit in `end` for the life of the process — the first defect this
    // function had, and the reason a count of dials exists at all.
    for (let i = 0; i < 20 && (evaluator.dialAttempts?.() ?? 0) === afterConnect; i += 1) {
      await evaluator.eval(SCRIPT, [], []).catch(() => undefined);
      await delay(100);
    }
    expect(evaluator.dialAttempts?.() ?? 0).toBeGreaterThan(afterConnect);
  });
});
