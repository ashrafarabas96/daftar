/**
 * TD-24 — WHY THE CONCURRENT CASES LISTEN FIRST, AND THE LAW THAT KEEPS THEM
 * LISTENING.
 *
 * `tests/security/td24-distributed-rate-limiter.test.ts` has two cases that
 * must have requests in flight at the same time: TD24-E (one client across
 * both replicas under concurrency) and TD24-F (its negative control). They
 * failed with `read ECONNRESET` in CI runs 41848410636 and 42073109330 — in
 * 9ms and 8ms, far too fast to be 600 requests — so NEITHER OF THEM HAD EVER
 * MEASURED THE SUBJECT.
 *
 * ── THE MECHANISM ────────────────────────────────────────────────────────
 *
 * `createTestApp()` calls `app.init()` and never `listen`
 * (`tests/helpers/test-app.ts:304-305`), so the server `supertest` is handed
 * has no address. `supertest` then opens it itself: the first `Test` of a
 * concurrent batch finds no address, calls `server.listen(0)`, KEEPS THE
 * HANDLE, and `close()`s it the instant its own request ends
 * (`node_modules/supertest/lib/test.js:63` and `:134-149`) — while the other
 * requests of that batch are still in flight. Sequential cases never saw it,
 * because there is nothing in flight to reset.
 *
 * The reset itself is the operating system's answer to a socket closed under
 * it, and that is timing-dependent: it did not reproduce on the Windows
 * development host. THE CLOSE IS NOT TIMING-DEPENDENT, and it is the only
 * thing in the path that can reset a socket — so this law measures the close,
 * deterministically, rather than chasing the reset.
 *
 * Three claims, each with its control:
 *
 *   TD24-LISTEN-A  THE DEFECT. Against an unlistening server, a concurrent
 *                  `supertest` wave leaves the server NOT LISTENING and with
 *                  no address — proof that something inside the wave opened
 *                  and closed it. POSITIVE CONTROL in the same case: the
 *                  requests themselves were answered, so the reading does not
 *                  come from a wave that never ran.
 *   TD24-LISTEN-B  THE REMEDY. On a server listened on FIRST, the port is the
 *                  same before and after each of two waves and the server is
 *                  still listening: `supertest` neither opened nor closed
 *                  anything. This is the difference `beforeAll` relies on.
 *   TD24-LISTEN-C  THE LAW. The suite that depends on the remedy actually
 *                  applies it — to BOTH replicas. Without this, a later edit
 *                  could drop the two `listen` lines and the two cases would
 *                  go back to measuring nothing, which is how this defect
 *                  survived two CI runs.
 *
 * No assertion here pins a port, a count of requests or a line number.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SUITE = join(ROOT, 'tests', 'security', 'td24-distributed-rate-limiter.test.ts');

/** The width of a wave here — concurrent, and small enough not to be a storm. */
const WAVE = 25;

const open: Server[] = [];

/** A server that answers every request after a tick, as a real pipeline would. */
function answering(): Server {
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.statusCode = 401;
      res.end('x');
    }, 5);
  });
  open.push(server);
  return server;
}

interface WaveReading {
  /** How many of the wave's requests were answered at all. */
  readonly answered: number;
  readonly portBefore: number | null;
  readonly portAfter: number | null;
  readonly listeningAfter: boolean;
}

function portOf(server: Server): number | null {
  const address = server.address();
  return typeof address === 'object' && address !== null && 'port' in address ? address.port : null;
}

/** One concurrent wave through `supertest`, and what it left behind. */
async function wave(server: Server, n: number): Promise<WaveReading> {
  const request = supertest(server);
  const portBefore = portOf(server);
  const statuses = await Promise.all(
    Array.from({ length: n }, () =>
      request
        .get('/')
        .then((res) => res.status)
        .catch(() => null),
    ),
  );
  return {
    answered: statuses.filter((status) => status === 401).length,
    portBefore,
    portAfter: portOf(server),
    listeningAfter: server.listening,
  };
}

afterEach(async () => {
  for (const server of open.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('TD-24 law — a concurrent wave needs a server that is already listening', () => {
  it('TD24-LISTEN-A (the defect): against an unlistening server, a concurrent wave leaves it closed', async () => {
    const server = answering();
    expect(server.listening).toBe(false); // the shape `createTestApp()` hands out

    const first = await wave(server, WAVE);
    // POSITIVE CONTROL: the wave really ran. Without this, a reading of "not
    // listening" could come from a wave that never issued a request.
    expect(first.answered).toBeGreaterThan(0);
    // The server had no address of its own, and has none again: something
    // inside the wave opened it and closed it while requests were in flight.
    expect(first.portBefore).toBe(null);
    expect(first.listeningAfter).toBe(false);
    expect(first.portAfter).toBe(null);

    // And it is not once: every wave repeats it, so a suite of such cases
    // runs on a server that is opened and shut under each one.
    const second = await wave(server, WAVE);
    expect(second.listeningAfter).toBe(false);
  });

  it('TD24-LISTEN-B (the remedy): on a server listened on first, a wave opens and closes nothing', async () => {
    const server = answering();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const bound = portOf(server);
    expect(typeof bound).toBe('number');

    for (const round of [1, 2]) {
      const reading = await wave(server, WAVE);
      expect(reading.answered, `round ${round}`).toBe(WAVE);
      expect(reading.portBefore, `round ${round}`).toBe(bound);
      expect(reading.portAfter, `round ${round}`).toBe(bound);
      expect(reading.listeningAfter, `round ${round}`).toBe(true);
    }
  });

  it('TD24-LISTEN-C: the concurrent suite listens on both replicas before it measures anything', () => {
    const text = readFileSync(SUITE, 'utf8');
    // Both replicas, because a wave alternates between them: one unlistening
    // replica is enough to reinstate the defect on half the requests.
    for (const replica of ['replicaA', 'replicaB']) {
      expect(text, `${replica} must listen before the first wave`).toContain(`await ${replica}.app.listen(0, '127.0.0.1')`);
    }
    // The reason travels with the lines, so a later reader does not remove
    // them as ceremony.
    expect(text).toContain('EACH REPLICA LISTENS ONCE');
  });
});
