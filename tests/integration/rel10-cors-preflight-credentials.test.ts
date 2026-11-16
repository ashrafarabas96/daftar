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
 * None of this is a hypothesis — and the exact reach is worth stating, since
 * an earlier wording here said "every arm seeds, builds, boots, and reads the
 * preflight" and that was false of three of them: `REL10-P1` and `REL10-P2`
 * seed NOTHING (they measure the tree as it stands), and `REL10-N3` neither
 * boots nor sends a request (the compiler refuses its seed, which is the
 * finding). What holds of every SEEDED arm is that it proves its seed reached
 * the compiled program before concluding anything — so an arm can never
 * report "closed" when it merely failed to apply.
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
 * usual and (b) nothing is left in `apps/api/dist`, which the Phase 1 build
 * gate refuses to find in the tree.
 *
 * THE PHRASE ABOVE NAMES NEITHER THAT GATE'S SCRIPT NOR ITS FILE, AND THAT IS
 * THE POINT. The review index counts a test as COVERAGE for a file when the
 * test merely NAMES it — its path, its basename, or any `npm run` script that
 * runs it. An earlier wording here used the script name and flipped that
 * gate's row from «none found by reference» to «covered», on a file marked
 * `security: high`, although this law never runs it and asserts nothing about
 * it: the page would have told the owner a gate was protected by a test that
 * does not touch it.
 *
 * AND THE FIRST ATTEMPT TO SET THAT OUT, HERE, DID IT AGAIN — by writing the
 * file's own path into the note. The regenerated page kept the row flipped
 * and the check still passed, so nothing complained; it took reading the
 * generator's needles (path, basename, script name) to see that the sentence
 * describing the trap was setting it.
 *
 * AND A THIRD TIME, ON A DIFFERENT GENERATED RECORD — which cannot be set
 * out HERE at all, because the words that would describe it are the very
 * signals that record's generator scans comments for: two attempts to
 * write it down each added a row to a record this law has no business
 * appearing in, and the second attempt tripped a different signal than the
 * first. It is written in `.local-context/OWNER_QUEUE_AR.md` instead, with
 * its numbers. Some findings cannot live in the file they are about.
 *
 * Hence the rule in its sharpest form: IN A COMMENT, DESCRIBE THE GATE, NEVER
 * NAME IT — and that includes the vocabulary a generator reads as a signal. Third occurrence today of prose moving a generated count — a stale row,
 * a `(+N)` cap, and this one, which is the only one that could MISLEAD about
 * a security file rather than merely fail a check.
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

  // EVERY THROW ON THIS PATH KILLS THE CHILD FIRST. `boot` throws BEFORE its
  // caller has a value to pass to `stop`, so the caller's `finally` cannot
  // clean up after it — a server left listening would hold cluster
  // connections through the REST of `backend-work`'s steps (the Phase 4 gates
  // and the perf budgets run after the tests, in the same job), and the
  // failure would be attributed to whatever ran next. Measured as a defect by
  // the review of this file, not after an incident.
  const die = async (why: string): Promise<never> => {
    await stopChild(child);
    throw new Error(`${why}:\n${out}`);
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (dead !== null) return await die(`the api died before it listened (${dead})`);
    try {
      // ANY status answers the only question here — is it listening? A 404 is
      // an answer; `/v1/health` is a platform route and is not mounted in
      // `merchant-api` mode, so waiting for a 200 would wait forever.
      const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
      if (r.status > 0) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return await die(`the api did not listen on ${port} within 90s`);
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return { port, child, log: () => out };
}

async function stopChild(child: ChildProcess): Promise<void> {
  await new Promise<void>((ok) => {
    if (child.exitCode !== null || child.signalCode !== null) return ok();
    child.once('exit', () => ok());
    child.kill('SIGKILL');
    setTimeout(ok, 5_000);
  });
}

async function stop(b: Booted): Promise<void> {
  await stopChild(b.child);
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
      // THE POSITIVE WITNESS FIRST, ON THE SAME SERVER. Every assertion below
      // is an ABSENCE, and three absences hold on a server that enabled no
      // CORS at all — which is how the first version of this arm could have
      // passed with `enableCors` deleted. So the granted origin is asked
      // first, and it must be echoed: that is what proves there IS a layer
      // here to refuse the stranger.
      const granted = await preflight(b.port, GRANTED);
      expect(granted.get('access-control-allow-origin'), 'the preflight never reached an enabled CORS layer, so nothing below is evidence').toBe(GRANTED);

      const h = await preflight(b.port, STRANGER);
      // AND THE HEADER IS ABSENT, not merely different from the stranger.
      // `not.toBe(STRANGER)` passed on `Access-Control-Allow-Credentials: *`
      // — a REAL relaxation — while this file's own header promised "no
      // `Access-Control-Allow-Origin` at all". The assertion now says what
      // the header says. (Review of this file, finding 1.)
      expect(h.get('access-control-allow-origin'), 'an origin outside the allowlist got an echo or a wildcard').toBeNull();
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
 *  - LIVE: the dead arm's OWN options, as the only call — which is what makes
 *    `REL10-N1` a claim about POSITION rather than about Nest ignoring those
 *    options.                                                   (`REL10-R3`)
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
  // `cors` is resolved at run time, and it is a TRANSITIVE dependency (of
  // `@nestjs/platform-express`), not one this repository declares. If an
  // install ever stops hoisting it, these two arms throw on `require` and
  // redden loudly — they cannot go quietly green, which is the only property
  // that matters here. Said rather than left for the next reader to discover.
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
      id: 'REL10-R3',
      what: 'the SAME options as REL10-N1, as the ONLY enableCors call',
      relaxes: true,
      marker: 'rel10SeededOnly',
      apply: (s) => s.replace(CALL, `  const rel10SeededOnly = { origin: true, credentials: true } as const;\n  app.enableCors(rel10SeededOnly);`),
    },
    {
      id: 'REL10-N1',
      what: 'a SECOND enableCors after the first',
      relaxes: false,
      marker: 'rel10SeededSecond',
      why: 'the first CORS layer answers the preflight and ends the response, so the second never runs — and REL10-R3 proves these very options DO relax when they are the only call, so this arm is about POSITION and not about Nest ignoring them',
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
      // THE TREE IS PRISTINE BEFORE THIS ARM SEEDS IT. If a previous arm timed
      // out, vitest moves on while that arm's `finally` is still pending, and
      // its restore would later land on top of THIS arm's seed. That would
      // make an arm measure a tree it did not write — silently. Asserting the
      // starting state turns that race into a red. (Review of this file,
      // finding 2.)
      expect(readFileSync(MAIN, 'utf8'), `the bootstrap was not pristine when «${arm.id}» began: a previous arm is still unwinding`).toBe(pristine);
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
    expect(readFileSync(MAIN, 'utf8'), 'the bootstrap was not pristine when REL10-N3 began').toBe(pristine);
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
