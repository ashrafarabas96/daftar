/**
 * REL-10 — THE PREFLIGHT ITSELF SAYS `credentials: false`, NOT THE SOURCE TEXT.
 *
 * `tests-unit/rel10-cors-allowlist.test.ts` reads `apps/api/src/main.ts` as
 * TEXT and refuses a relaxation written into the `enableCors` call. That law is
 * worth having and it is not this one: a text reader can only refuse the
 * spellings it was taught, and four spellings were recorded (in
 * `OWNER_QUEUE_AR.md`, by me, from `#98`'s reviews) as passing it:
 *
 *   1. a SECOND `app.enableCors({ credentials: true })` after the first,
 *   2. a `...spread` placed after the `credentials:` key,
 *   3. `app.use(cors({ credentials: true }))` beside the Nest call,
 *   4. a COMPUTED key (`[k]: true`) that no literal `credentials:` matches.
 *
 * **ALL FOUR DEFEAT THE TEXT LAW. ONLY TWO CHANGE THE RUNNING SERVER — AND
 * THAT WAS MEASURED HERE, NOT ASSUMED.** Seeded into `main.ts`, built with
 * the api's own config, booted, and read back off the wire: (4) relaxes the
 * preflight, (3) relaxes it ONLY when mounted BEFORE `enableCors`, (1) and (3)
 * mounted after do NOT — the first CORS layer answers the preflight and ENDS
 * the response — and (2) does not compile at all (`tsc` exits 2 with
 * **TS2783**, `'credentials' is specified more than once`).
 *
 * So the recorded account of these routes was wrong in a way that mattered:
 * "the text law cannot see it" was read as "the server relaxes". It is the
 * same error as calling a text law a behaviour law, one layer up — a claim
 * about a GUARD mistaken for a claim about the SYSTEM. The arms below carry
 * the corrected reading, each with its mechanism named, and the two dead
 * routes stay as RATCHETS rather than being deleted.
 *
 * None of this is a hypothesis: every arm seeds, builds, boots, and reads the
 * preflight, and every arm first proves its own seed reached the compiled
 * program — so an arm can never report "closed" when it merely failed to run.
 * `REL10-R1`/`REL10-R2` assert the header comes back `true` on the same
 * request `REL10-P1` asserts it is absent on, which IS the red-first proof of
 * `REL10-P1`: with either seed in the tree, `REL10-P1` fails.
 *
 * WHY THIS LAW HAS TO BOOT A PROCESS, AND WHY THE TEST HELPER WILL NOT DO.
 * `tests/helpers/test-app.ts` builds the application with
 * `Test.createTestingModule(...).createNestApplication()` and `init()`. It
 * never runs `bootstrap()`, so `app.enableCors(...)` is NEVER CALLED on the
 * app it hands out. A preflight asserted against that app would pass with the
 * bootstrap deleted entirely — a behaviour law on the wrong application, which
 * is the same error as a text law standing in for behaviour, wearing the other
 * mask. So this file spawns `apps/api/src/main.ts` itself, through `tsx`, with
 * the embedded cluster behind it, and talks to it over a socket.
 *
 * WHAT IS ASSERTED, AND THE POSITIVE CONTROL THAT KEEPS IT HONEST.
 * A law that only asserts a header is ABSENT passes on a server that is not
 * listening, on a 404, and on a CORS layer that was never enabled. So the
 * allowlisted arm first proves the preflight REACHED the CORS layer —
 * `Access-Control-Allow-Origin` comes back echoing the granted origin — and
 * only then that `Access-Control-Allow-Credentials` is absent. Without that
 * pairing the absence would be worth nothing.
 *
 * AND THE NON-ALLOWLISTED ARM IS A SEPARATE CLAIM, not a restatement: an
 * origin the allowlist never granted gets NO `Access-Control-Allow-Origin` at
 * all, which is what makes the allowlist an allowlist. Both arms assert the
 * credentials header is absent, because `credentials: true` with a reflected
 * origin is the pair that actually hands a cookie away.
 *
 * SCOPE, STATED SO NOBODY READS MORE INTO IT. This closes the four routes by
 * which the TEXT law could be satisfied while the server relaxed. It is not a
 * claim about every CORS misconfiguration, it says nothing about the values in
 * `CORS_ORIGINS` on any deployment, and it does not touch the grant text of
 * any database principal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ensurePostgres,
  PROVISIONING_ASSERTION_KEY_B64,
  PROVISIONING_ASSERTION_KID,
  ACCOUNTING_ASSERTION_KEY_B64,
  ACCOUNTING_ASSERTION_KID,
  INVENTORY_ASSERTION_KEY_B64,
  INVENTORY_ASSERTION_KID,
} from '../helpers/test-app';
import { PG_PORT, APP_DB_PASSWORD, IDENTITY_DB_PASSWORD, RESOLVER_DB_PASSWORD, PROVISIONER_DB_PASSWORD } from '../helpers/embedded-cluster';

const ROOT = resolve(__dirname, '../..');
const MAIN = join(ROOT, 'apps/api/src/main.ts');
/**
 * THE PROCESS IS BUILT, NOT TRANSPILED ON THE FLY. `tsx`/esbuild refuses this
 * tree (`Parameter decorators only work when experimentalDecorators is
 * enabled`) and, more to the point, esbuild cannot emit
 * `emitDecoratorMetadata` at all — so a Nest app it did produce would have no
 * DI metadata and would not be the deployed program. `tsc -p
 * apps/api/tsconfig.build.json` is the api's OWN build (`apps/api`'s `build`
 * script, same config), measured at ~5s, and the output goes UNDER
 * `node_modules/` so that (a) Node resolves `@nestjs/*` upward from it as
 * usual and (b) nothing is left in `apps/api/dist`, which `gate:phase1`
 * refuses to find in the tree.
 */
const OUT = join(ROOT, 'node_modules', '.cache', 'rel10-cors-law-dist');

const GRANTED = 'https://granted.example';
const STRANGER = 'https://stranger.example';

/** The bootstrap's own text, captured once, restored after every seeded arm. */
let pristine = '';
let pristineSha = '';
let logDir = '';

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function freePort(): Promise<number> {
  return await new Promise<number>((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a !== null ? a.port : 0;
      s.close(() => (p === 0 ? bad(new Error('no ephemeral port')) : ok(p)));
    });
  });
}

function role(name: string, password: string): string {
  return `postgresql://${name}:${password}@localhost:${PG_PORT}/daftar`;
}

type Booted = { readonly port: number; readonly child: ChildProcess; readonly log: () => string };

/** Compile `apps/api` as it stands on disk right now. Throws with tsc's own text. */
function buildApi(): void {
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'apps/api/tsconfig.build.json'), '--outDir', OUT], {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

async function boot(corsOrigins: string): Promise<Booted> {
  const port = await freePort();
  let out = '';
  const child = spawn(process.execPath, [join(OUT, 'main.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      SystemRoot: process.env['SystemRoot'],
      NODE_ENV: 'development',
      PROCESS_MODE: 'merchant-api',
      PORT: String(port),
      APP_DATABASE_URL: role('daftar_app', APP_DB_PASSWORD),
      IDENTITY_DATABASE_URL: role('daftar_identity', IDENTITY_DB_PASSWORD),
      RESOLVER_DATABASE_URL: role('daftar_resolver', RESOLVER_DB_PASSWORD),
      PROVISIONER_DATABASE_URL: role('daftar_provisioner', PROVISIONER_DB_PASSWORD),
      PROVISIONING_ASSERTION_KEY: PROVISIONING_ASSERTION_KEY_B64,
      PROVISIONING_ASSERTION_KID: PROVISIONING_ASSERTION_KID,
      ACCOUNTING_ASSERTION_KEY: ACCOUNTING_ASSERTION_KEY_B64,
      ACCOUNTING_ASSERTION_KID: ACCOUNTING_ASSERTION_KID,
      INVENTORY_ASSERTION_KEY: INVENTORY_ASSERTION_KEY_B64,
      INVENTORY_ASSERTION_KID: INVENTORY_ASSERTION_KID,
      JWT_SECRET: 'rel10-preflight-local-jwt-secret-with-32-plus-chars',
      MEDIA_ROOT: join(logDir, 'media'),
      DEV_MAILBOX_FILE: join(logDir, 'mailbox.log'),
      CORS_ORIGINS: corsOrigins,
      TRUSTED_PROXIES: '127.0.0.1,::1',
      LOG_LEVEL: 'warn',
    },
  });
  child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
  child.stderr?.on('data', (b: Buffer) => (out += b.toString('utf8')));
  let dead: string | null = null;
  child.once('exit', (code, signal) => (dead = `exit=${String(code)} signal=${String(signal)}`));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (dead !== null) throw new Error(`the api died before it listened (${dead}):\n${out}`);
    try {
      // ANY status answers the only question here — is it listening? A 404 is
      // an answer; `/v1/health` is a platform route and is not mounted in
      // `merchant-api` mode, so waiting for a 200 would wait forever.
      const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
      if (r.status > 0) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`the api did not listen on ${port} within 90s:\n${out}`);
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return { port, child, log: () => out };
}

async function stop(b: Booted): Promise<void> {
  await new Promise<void>((ok) => {
    if (b.child.exitCode !== null || b.child.signalCode !== null) return ok();
    b.child.once('exit', () => ok());
    b.child.kill('SIGKILL');
    setTimeout(ok, 5_000);
  });
}

/** A real browser preflight: `OPTIONS` carrying `Origin` and the method ask. */
async function preflight(port: number, origin: string): Promise<Headers> {
  const r = await fetch(`http://127.0.0.1:${port}/v1/sales`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });
  return r.headers;
}

beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), 'rel10-preflight-'));
  mkdirSync(join(logDir, 'media'), { recursive: true });
  pristine = readFileSync(MAIN, 'utf8');
  pristineSha = sha(pristine);
  buildApi();
  await ensurePostgres();
}, 600_000);

afterAll(() => {
  // A seeded arm that threw must never leave the bootstrap relaxed on disk.
  if (pristine !== '' && readFileSync(MAIN, 'utf8') !== pristine) writeFileSync(MAIN, pristine, 'utf8');
});

describe('REL-10 the preflight itself', () => {
  it('REL10-P1 AN ALLOWLISTED ORIGIN REACHES THE CORS LAYER AND GETS NO CREDENTIALS GRANT', async () => {
    const b = await boot(GRANTED);
    try {
      const h = await preflight(b.port, GRANTED);
      // THE POSITIVE CONTROL FIRST: without this, absence proves nothing.
      expect(h.get('access-control-allow-origin'), `the preflight never reached an enabled CORS layer:\n${b.log()}`).toBe(GRANTED);
      expect(h.get('access-control-allow-credentials'), 'the running server granted credentials to an allowlisted origin').toBeNull();
    } finally {
      await stop(b);
    }
  }, 300_000);

  it('REL10-P2 AN ORIGIN THE ALLOWLIST NEVER GRANTED IS NOT ECHOED, AND GETS NO CREDENTIALS GRANT', async () => {
    const b = await boot(GRANTED);
    try {
      const h = await preflight(b.port, STRANGER);
      expect(h.get('access-control-allow-origin'), 'an origin outside the allowlist was echoed back').not.toBe(STRANGER);
      expect(h.get('access-control-allow-credentials'), 'the running server granted credentials to a stranger origin').toBeNull();
    } finally {
      await stop(b);
    }
  }, 300_000);
});

/**
 * THE SEEDED ARMS — AND THE FIRST THING THEY MEASURED WAS THAT THE RECORDED
 * ACCOUNT OF THESE ROUTES WAS WRONG.
 *
 * The four routes were recorded (by me, from `#98`'s reviews) as four ways a
 * request reaches the CORS layer with a relaxation the TEXT law cannot see.
 * That is true of all four AS TEXT. It is NOT true of the running server:
 * seeded into `main.ts`, built with the api's own config and booted, only
 * TWO of them change what comes back off the wire, and WHICH two is decided
 * by POSITION, not by spelling.
 *
 *  - LIVE: a credentials key the reader and the compiler cannot see, inside
 *    the one `enableCors` options object.                       (`REL10-R1`)
 *  - LIVE: `app.use(cors(...))` placed BEFORE `enableCors`.     (`REL10-R2`)
 *  - DEAD: a SECOND `enableCors` after the first.               (`REL10-N1`)
 *  - DEAD: `app.use(cors(...))` placed AFTER `enableCors`.      (`REL10-N2`)
 *  - REFUSED BY THE COMPILER: a `...spread` carrying `credentials` after a
 *    literal `credentials:` key — `tsc` exits 2 with **TS2783**, measured.
 *                                                               (`REL10-N3`)
 *
 * The mechanism behind both DEAD arms is one fact, and it is the reason they
 * must be arms and not a deletion: the first CORS layer ANSWERS the preflight
 * and ENDS the response, so nothing mounted after it ever runs for an
 * `OPTIONS`. A relaxation that runs second is not a relaxation. And an arm
 * that pins that is a RATCHET: if a future Nest or middleware order lets the
 * second one through, `REL10-N1`/`REL10-N2` redden and somebody reads this.
 *
 * EVERY ARM PROVES IT IS LIVE BEFORE IT CONCLUDES ANYTHING. The seed must
 * appear in the COMPILED output (`main.js`), not merely in the source — a
 * seed `tsc` dropped, or an anchor that moved, would otherwise be read as
 * "the route is closed". That check is what turns `REL10-N*` from an absence
 * into a measurement.
 */
describe('REL-10 the seeded routes, each measured on the running server', () => {
  const CALL = `  app.enableCors({\n    origin: [...parseCorsOrigins(config.CORS_ORIGINS)],\n    credentials: false,\n  });`;

  type Arm = {
    readonly id: string;
    readonly what: string;
    /** `relaxes`: the preflight comes back with the credentials grant. */
    readonly relaxes: boolean;
    /** Proof the seed survived into the built program. */
    readonly marker: string;
    readonly apply: (s: string) => string;
    readonly why?: string;
  };

  const HIDDEN_KEY = ['cred', 'entials'];
  const REQUIRE_CORS = `(await import('node:module')).createRequire(__filename)('cors') as (o: unknown) => never`;

  const arms: readonly Arm[] = [
    {
      id: 'REL10-R1',
      what: 'a credentials key neither the reader nor the compiler can see',
      relaxes: true,
      marker: 'rel10SeededKey',
      apply: (s) =>
        s.replace(
          CALL,
          `  const rel10SeededKey = ${JSON.stringify(HIDDEN_KEY[0])} + ${JSON.stringify(HIDDEN_KEY[1])};\n  const rel10SeededOpts: Record<string, unknown> = {\n    origin: [...parseCorsOrigins(config.CORS_ORIGINS)],\n    [rel10SeededKey]: true,\n  };\n  app.enableCors(rel10SeededOpts as Parameters<typeof app.enableCors>[0]);`,
        ),
    },
    {
      id: 'REL10-R2',
      what: 'app.use(cors({ credentials: true })) placed BEFORE enableCors',
      relaxes: true,
      marker: 'rel10SeededBefore',
      apply: (s) =>
        s.replace(CALL, `  const rel10SeededBefore = ${REQUIRE_CORS};\n  app.use(rel10SeededBefore({ origin: true, credentials: true }));\n${CALL}`),
    },
    {
      id: 'REL10-N1',
      what: 'a SECOND enableCors after the first',
      relaxes: false,
      marker: 'rel10SeededSecond',
      why: 'the first CORS layer answers the preflight and ends the response, so the second never runs',
      apply: (s) => s.replace(CALL, `${CALL}\n  const rel10SeededSecond = { origin: true, credentials: true } as const;\n  app.enableCors(rel10SeededSecond);`),
    },
    {
      id: 'REL10-N2',
      what: 'app.use(cors({ credentials: true })) placed AFTER enableCors',
      relaxes: false,
      marker: 'rel10SeededAfter',
      why: 'same mechanism as REL10-N1 — the preflight is already answered by the time this middleware is reached',
      apply: (s) => s.replace(CALL, `${CALL}\n  const rel10SeededAfter = ${REQUIRE_CORS};\n  app.use(rel10SeededAfter({ origin: true, credentials: true }));`),
    },
  ];

  for (const arm of arms) {
    it(`${arm.id} ${arm.what}`, async () => {
      const seeded = arm.apply(pristine);
      expect(seeded, `the seed «${arm.id}» did not apply: the capture anchor moved`).not.toBe(pristine);
      writeFileSync(MAIN, seeded, 'utf8');
      try {
        buildApi(); // the seeded bootstrap, compiled by the api's own config
        // THE SEED IS IN THE BUILT PROGRAM, not only in the source. Without
        // this, a dropped seed would read as "the route is closed".
        expect(readFileSync(join(OUT, 'main.js'), 'utf8'), `the seed «${arm.id}» did not reach the compiled program, so this arm measures nothing`).toContain(
          arm.marker,
        );
        const b = await boot(GRANTED);
        try {
          const h = await preflight(b.port, GRANTED);
          const got = h.get('access-control-allow-credentials');
          if (arm.relaxes) {
            expect(got, `the seed «${arm.id}» did not relax the running server, so this arm measures nothing:\n${b.log()}`).toBe('true');
          } else {
            expect(
              got,
              `${arm.id} reached the wire after all — ${String(arm.why)} no longer holds, and the recorded account of this route must be re-measured:\n${b.log()}`,
            ).toBeNull();
            // AND THE LAYER WAS STILL THERE: without this, a server that
            // failed to enable CORS at all would pass this arm.
            expect(h.get('access-control-allow-origin'), `${arm.id} answered with no CORS layer at all, so its null credentials header says nothing`).toBe(
              GRANTED,
            );
          }
        } finally {
          await stop(b);
        }
      } finally {
        writeFileSync(MAIN, pristine, 'utf8');
        expect(sha(readFileSync(MAIN, 'utf8')), 'the bootstrap was not restored byte-for-byte').toBe(pristineSha);
        buildApi(); // leave the build output on the pristine bootstrap too
      }
    }, 300_000);
  }

  it('REL10-N3 A SPREAD CARRYING credentials AFTER A LITERAL credentials KEY IS REFUSED BY THE COMPILER', () => {
    const seeded = pristine.replace(
      CALL,
      `  const rel10SeededSpread = { credentials: true } as const;\n  app.enableCors({\n    origin: [...parseCorsOrigins(config.CORS_ORIGINS)],\n    credentials: false,\n    ...rel10SeededSpread,\n  });`,
    );
    expect(seeded, 'the REL10-N3 seed did not apply: the capture anchor moved').not.toBe(pristine);
    writeFileSync(MAIN, seeded, 'utf8');
    try {
      let thrown: { status?: number; stdout?: string } | null = null;
      try {
        buildApi();
      } catch (e: unknown) {
        thrown = e as { status?: number; stdout?: string };
      }
      // THIS ROUTE IS CLOSED BY THE BUILD, NOT BY THIS LAW, and saying so is
      // the point: it was recorded as one of the four and it is not one.
      expect(thrown, 'the spread-after-key form compiled, so this route is live and REL10-N3 must become a red arm').not.toBeNull();
      expect(String(thrown?.stdout ?? ''), 'the build refused the seed for some other reason than the duplicate key').toContain('TS2783');
    } finally {
      writeFileSync(MAIN, pristine, 'utf8');
      expect(sha(readFileSync(MAIN, 'utf8')), 'the bootstrap was not restored byte-for-byte').toBe(pristineSha);
      buildApi();
    }
  }, 300_000);
});
