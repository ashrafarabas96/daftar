/**
 * THE BROWSER GATE MUST NOT CLAIM A PORT NUMBER IT WROTE DOWN IN ADVANCE.
 *
 * The defect this law is built from, measured on the runner by the CI-speed
 * lane: run 43073393847, job 130706974448, step 40 "Phase 4 slice gate —
 * P4-S1" died with
 *
 *     Error: port 56246 is already in use on 0.0.0.0; refusing to start the web server.
 *     FAIL [browser] real-browser red proof: every planted defect reported in every run (exit 1)
 *     P3 CORRECTIVE GATE: FAIL (1)  ⇒  P4-S1 GATE: FAIL (1)
 *
 * 56246 was not a coincidence: `portsFromEnv()` wrote the three numbers
 * 56240/56245/56246 into the source, so TWO gate runs on one machine ask for
 * the same three ports and the second one cannot have them. The gate was
 * red for a reason that has nothing to do with the tree under test — the
 * worst kind of red, because it is read as a defect.
 *
 * THE FIX IS NOT A RETRY, A LONGER TIMEOUT, OR A SKIP. It is that a port is
 * taken from the operating system at the moment the gate starts, and HELD
 * until the server that needs it is about to bind. The law below is what
 * "taken and held" has to mean:
 *
 *   1. two allocations made at the same time never name the same port;
 *   2. a reserved port is genuinely unavailable to anyone else while it is
 *      reserved — otherwise the reservation is a guess with a nicer name;
 *   3. releasing a role frees that role's port and leaves the others held;
 *   4. an explicitly pinned port is still honoured exactly, and is NOT held,
 *      because the process that pinned it means to bind it itself.
 *
 * Every assertion here binds real TCP sockets and no database, so this file
 * belongs to the no-database lane and runs on every CI run and on Windows.
 */
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { portsFromEnv, reservePorts, type PortRole } from '../tests/browser/config';

const ENV_NAMES = ['BROWSER_PG_PORT', 'BROWSER_API_PORT', 'BROWSER_WEB_PORT'] as const;
const ROLES: readonly PortRole[] = ['pg', 'api', 'web'];

function clearEnv(): void {
  for (const name of ENV_NAMES) delete process.env[name];
}

/**
 * Can this process bind the port right now? This is the same question
 * `stack.ts`'s own guard asks, and the same one the servers ask implicitly, so
 * a `false` here is exactly the failure the runner saw.
 */
async function bindable(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else resolve(false);
    });
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** A listener that holds a port, so the detector above can be proved to detect. */
async function holdSomePort(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '0.0.0.0', exclusive: true }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the holding listener has no numeric address');
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

afterEach(() => {
  clearEnv();
});

describe('the browser gate takes its ports from the operating system', () => {
  it('detects a taken port at all — the control for every assertion below', async () => {
    const held = await holdSomePort();
    try {
      expect(await bindable(held.port), `a port held by a live listener must read as unavailable`).toBe(false);
    } finally {
      await held.close();
    }
    // And the same number is bindable once nothing holds it, so the detector
    // is not simply answering `false` to everything.
    expect(await bindable(held.port)).toBe(true);
  });

  it('never hands the same port to two allocations made at the same time', async () => {
    clearEnv();
    const [a, b] = await Promise.all([reservePorts(), reservePorts()]);
    try {
      const all = [a.ports.pg, a.ports.api, a.ports.web, b.ports.pg, b.ports.api, b.ports.web];
      for (const port of all) expect(port, `${JSON.stringify(all)}`).toBeGreaterThan(0);
      expect(new Set(all).size, `two concurrent gate runs were handed overlapping ports: ${JSON.stringify(all)}`).toBe(6);
    } finally {
      await a.releaseAll();
      await b.releaseAll();
    }
  });

  it('holds every reserved port until its own role is released', async () => {
    clearEnv();
    const reservation = await reservePorts();
    try {
      for (const role of ROLES) {
        expect(await bindable(reservation.ports[role]), `the ${role} port was reserved and is still free, so the reservation holds nothing`).toBe(false);
      }
      await reservation.release('api');
      expect(await bindable(reservation.ports.api), `the api port stayed held after its release, so its server cannot bind`).toBe(true);
      for (const role of ['pg', 'web'] as const) {
        expect(await bindable(reservation.ports[role]), `releasing api also freed ${role}, so a concurrent run can steal it`).toBe(false);
      }
    } finally {
      await reservation.releaseAll();
    }
  });

  it('frees everything on releaseAll, so the servers can actually start', async () => {
    clearEnv();
    const reservation = await reservePorts();
    const ports = { ...reservation.ports };
    await reservation.releaseAll();
    for (const role of ROLES) expect(await bindable(ports[role]), `${role} stayed held after releaseAll`).toBe(true);
    // Releasing twice is how `stop()` paths behave; it must not throw.
    await reservation.releaseAll();
  });

  it('honours an explicitly pinned port exactly, and does not hold it', async () => {
    clearEnv();
    const free = await Promise.all([holdSomePort(), holdSomePort(), holdSomePort()]);
    const pinned = free.map((f) => f.port);
    for (const f of free) await f.close();
    process.env['BROWSER_PG_PORT'] = String(pinned[0]);
    process.env['BROWSER_API_PORT'] = String(pinned[1]);
    process.env['BROWSER_WEB_PORT'] = String(pinned[2]);
    expect(portsFromEnv()).toEqual({ pg: pinned[0], api: pinned[1], web: pinned[2] });
    const reservation = await reservePorts();
    try {
      expect(reservation.ports).toEqual({ pg: pinned[0], api: pinned[1], web: pinned[2] });
      for (const role of ROLES) {
        expect(await bindable(reservation.ports[role]), `a pinned ${role} port must be left alone for the caller that pinned it`).toBe(true);
      }
    } finally {
      await reservation.releaseAll();
    }
  });

  /**
   * THE CONTROL OVER THE DEFECT ITSELF, not over the detector.
   *
   * The test above says two concurrent allocations get six different ports.
   * On its own that proves nothing: a machine with a wide ephemeral range
   * would hand out six different ports even if the code asked for the same
   * one twice, and the suite would read green while the defect stood. So this
   * is the other half — two runs that ask for the SAME port, which is exactly
   * what the three written-down constants did, and the second one must be
   * refused. If this ever passes without an EADDRINUSE, the machine stopped
   * being able to collide and the test above has lost its meaning.
   */
  it('still collides when two runs ask for one port — so the test above is measuring the fix, not the machine', async () => {
    clearEnv();
    const one = await holdSomePort();
    const sharedPort = one.port;
    await one.close();
    for (const name of ENV_NAMES) process.env[name] = String(sharedPort);

    const first = await reservePorts();
    try {
      expect(first.ports, 'a pinned port must come back as itself').toEqual({ pg: sharedPort, api: sharedPort, web: sharedPort });
      // The first run's own server takes it, as `startStack` would.
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: sharedPort, host: '0.0.0.0', exclusive: true }, () => resolve());
      });
      try {
        // The second run asks for the same pinned port and cannot have it.
        const second = await reservePorts();
        try {
          expect(second.ports.web).toBe(sharedPort);
          expect(
            await bindable(second.ports.web),
            `two runs pinned to port ${sharedPort} both got it — this machine can no longer reproduce the collision, ` +
              `so the disjointness test above proves nothing and must be re-measured before it is trusted`,
          ).toBe(false);
        } finally {
          await second.releaseAll();
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await first.releaseAll();
    }
  });

  it('asks the operating system when nothing is pinned, rather than naming a number', () => {
    clearEnv();
    expect(portsFromEnv(), `an unset port must mean "the OS picks", not a constant two runs can both claim`).toEqual({ pg: 0, api: 0, web: 0 });
  });

  it('still rejects a value that is not a port', () => {
    clearEnv();
    process.env['BROWSER_API_PORT'] = '70000';
    expect(() => portsFromEnv()).toThrow(/BROWSER_API_PORT is not a port/);
  });

  it('leaves no prose claiming the ports are fixed', () => {
    const stack = readFileSync(join(__dirname, '..', 'tests', 'browser', 'stack.ts'), 'utf8');
    // Positive control: the probe is reading the right file.
    expect(stack).toContain('assertPortFree');
    expect(stack, `stack.ts still tells the reader the ports are fixed, which is now false`).not.toContain('the ports are fixed');
  });
});
