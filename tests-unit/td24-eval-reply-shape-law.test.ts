/**
 * THE LAW: the rate-limit evaluator refuses a reply that is not an array, and
 * its refusal NAMES the cause.
 *
 * `createRedisEvaluator(...).eval()` ends with
 *
 *     if (!Array.isArray(out)) throw new Error('the rate-limit script did not return an array');
 *     return out.map((v) => Number(v));
 *
 * ── WHY THIS LAW EXISTS, STATED AS MEASURED AND NOT WIDER ───────────────────
 *
 * The guard was found by planting, under DR-145, on
 * `apps/api/src/infra/rate-limit-store.ts` — a file this lane owns. Five
 * guards were defeated one at a time against the whole unit lane on
 * `edf2b6eb`, with the lane green first as the positive control:
 *
 *   the tenant-id shape refusal      → RED (td24-redis-throttler-store)
 *   the hash-tag braces              → RED (td24-eval-hash-tag-law, …-store)
 *   the four-finite-numbers check    → RED (td24-redis-throttler-store)
 *   the released-store reconnect ban → RED (td24-redis-throttler-store)
 *   **the array-shape check**        → **GREEN: no law held it**
 *
 * And what the defeat costs is stated no higher than it measures: without the
 * guard, `out.map` is reached on a value that has no `map`, so the request
 * still fails — the store catches per command and stays FAIL-CLOSED. **So this
 * is a DIAGNOSIS law, not a hole**: it keeps the one line a real outage gets
 * from becoming `out.map is not a function`, in a file that argues for named
 * causes at `createRedisEvaluator`'s own `lastError`. A law that claimed a
 * security gap here would be claiming more than the planting showed.
 *
 * ── WHO MOVES THIS ─────────────────────────────────────────────────────────
 *
 * L4, with the guard. If the guard's message changes, this file is the second
 * half of that change; if the guard goes, this file reddens — which is the
 * point, because nothing else does.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRedisEvaluator, type RateLimitEvaluator } from '../apps/api/src/infra/rate-limit-store';

const SCRIPT = 'return 1';

/** What a server can be told to answer an `EVAL` with. */
type EvalReply = 'array' | 'integer' | 'bulk' | 'null' | 'simple';

const RESP: Record<EvalReply, string> = {
  // The well-formed answer: the four numbers the store reads.
  array: '*4\r\n:1\r\n:60000\r\n:0\r\n:0\r\n',
  integer: ':7\r\n',
  bulk: '$3\r\nabc\r\n',
  null: '$-1\r\n',
  simple: '+OK\r\n',
};

interface FakeRedis {
  readonly url: string;
  /** Command names this server received, so a case cannot pass against a server that answered nothing. */
  readonly seen: string[];
  close(): Promise<void>;
}

/**
 * A loopback server that speaks just enough RESP for ioredis to become
 * `ready` and to answer `EVAL` with a reply this file chooses.
 *
 * Written out rather than imported from a sibling suite, for the reason
 * `tests-unit/td24-redis-reconnect-law.test.ts` states: importing a module
 * another suite owns runs that suite inside this file, which would tie this
 * law's result to another lane's.
 */
async function startFakeRedis(reply: EvalReply): Promise<FakeRedis> {
  const seen: string[] = [];
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
        else if (command === 'eval') socket.write(RESP[reply]);
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
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const open: { evaluator?: RateLimitEvaluator; fake?: FakeRedis } = {};

afterEach(async () => {
  await open.evaluator?.close?.();
  await open.fake?.close();
  delete open.evaluator;
  delete open.fake;
});

async function evaluatorAgainst(reply: EvalReply): Promise<{ evaluator: RateLimitEvaluator; fake: FakeRedis }> {
  const fake = await startFakeRedis(reply);
  open.fake = fake;
  const evaluator = createRedisEvaluator(fake.url);
  open.evaluator = evaluator;
  return { evaluator, fake };
}

describe('TD-24 law — a reply that is not an array is refused by name', () => {
  it('POSITIVE CONTROL: a well-formed four-element reply is read, from this very server', async () => {
    // Without this arm, every refusal below could be a handshake that never
    // happened rather than the shape check doing its work.
    const { evaluator, fake } = await evaluatorAgainst('array');
    expect(await evaluator.eval(SCRIPT, ['k1', 'k2'], ['1', '2', '3'])).toEqual([1, 60000, 0, 0]);
    expect(fake.seen).toContain('eval');
  });

  const refused: readonly { readonly reply: EvalReply; readonly what: string }[] = [
    { reply: 'integer', what: 'an integer' },
    { reply: 'bulk', what: 'a bulk string' },
    { reply: 'null', what: 'a null bulk string' },
    { reply: 'simple', what: 'a simple string' },
  ];

  for (const { reply, what } of refused) {
    it(`refuses ${what} reply with the named cause, and the server was really asked`, async () => {
      const { evaluator, fake } = await evaluatorAgainst(reply);
      // The MESSAGE, not merely "it threw": an unnamed `out.map is not a
      // function` is exactly the degradation this law exists to prevent, and
      // it also throws.
      await expect(evaluator.eval(SCRIPT, ['k1', 'k2'], ['1', '2', '3'])).rejects.toThrow('the rate-limit script did not return an array');
      expect(fake.seen).toContain('eval');
    });
  }
});
