/**
 * THE LAW: §31 refuses one CREDENTIAL used twice, not one STRING written twice.
 *
 * Source of the finding: the independent review of #110, carried to L4 as
 * `.local-context/cards/L4_CONFIG_URL_LITERAL_COMPARE_CARD_AR.md`. The card
 * said plainly that it had NOT been measured. It was then measured on the
 * merged `main` (`0af68e81`), with an otherwise complete and correct
 * production `merchant-api` fixture that STARTED as the control — so every
 * result below is the spelling's doing and not the fixture's. Of eight
 * spellings of ONE credential, only the byte-identical one was refused:
 *
 *   byte-identical            -> REFUSED
 *   `@db:5432/`               -> started
 *   `?sslmode=require`        -> started
 *   a trailing slash          -> started
 *   `postgres://`             -> started
 *   `@DB/`                    -> started
 *   password as `%78`         -> started
 *   role as `daftar_%61pp`    -> started
 *
 * Seven of eight. Each of them aliases two roles onto one principal while the
 * process starts and reports nothing.
 *
 * ── WHAT THIS FILE PINS, AND WHY IN THIS SHAPE ──────────────────────────────
 *
 * Normalizing is a WIDENING: every element added to `dbPrincipalKey` shrinks
 * the space of configurations the loader accepts, so an element that goes too
 * far refuses a deployment that is correct. A law that only proved refusals
 * would therefore be half a law — it would pass just as happily over a
 * `dbPrincipalKey` that returned a constant and refused everything.
 *
 * So every element gets TWO arms: a positive one that must be refused, and a
 * NEGATIVE CONTROL that must still start. The negative controls are the half
 * that makes this safe to ship, and they are listed with the element each one
 * defends.
 *
 * ── WHO MOVES THIS ─────────────────────────────────────────────────────────
 *
 * L4, in the same commit as `dbPrincipalKey`. Removing an element from that
 * function reddens its positive arm here and nothing else; adding one needs
 * its own pair of arms in this file, in that same commit.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/api/src/config';

const APP = 'postgresql://daftar_app:x@db/daftar';

/** The §31 clause, which names both fields. */
const DUP = /IDENTITY_DATABASE_URL: duplicates APP_DATABASE_URL — every DB principal must use distinct credentials/;

/**
 * A production `merchant-api` that is otherwise complete and correct.
 *
 * Repeated from `tests-unit/config-production-refusals.test.ts` deliberately,
 * for the reason that file states: a shared fixture would tie two cards'
 * suites together, so a variable one card needs would silently change what the
 * other measures.
 */
const MERCHANT_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: APP,
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:x@db/daftar',
  PROVISIONER_DATABASE_URL: 'postgresql://daftar_provisioner:x@db/daftar',
  PROVISIONING_ASSERTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  ACCOUNTING_ASSERTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  ACCOUNTING_ASSERTION_KID: 'acct1',
  INVENTORY_ASSERTION_KEY: Buffer.alloc(32, 13).toString('base64'),
  INVENTORY_ASSERTION_KID: 'inv1',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  REDIS_URL: 'redis://redis:6379',
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.com/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
  MEDIA_STORAGE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'daftar-media',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
  CORS_ORIGINS: 'https://app.example.com',
};

/** The loader, with `IDENTITY_DATABASE_URL` set to one spelling. */
const withIdentity = (url: string): NodeJS.ProcessEnv => ({ ...MERCHANT_PROD, IDENTITY_DATABASE_URL: url });

describe('§31 compares credentials, not strings', () => {
  it('POSITIVE CONTROL: the fixture itself starts, with four distinct credentials', () => {
    // Without this arm, every refusal below could be the fixture's own doing.
    expect(() => loadConfig({ ...MERCHANT_PROD })).not.toThrow();
  });

  // ── THE SEVEN SPELLINGS THAT WERE MEASURED PASSING ON `main` ──────────────
  const refused: readonly { readonly element: string; readonly url: string; readonly what: string }[] = [
    { element: '3 port', url: 'postgresql://daftar_app:x@db:5432/daftar', what: "PostgreSQL's default port written out" },
    { element: 'query', url: 'postgresql://daftar_app:x@db/daftar?sslmode=require', what: 'a connection parameter appended' },
    { element: '5 path', url: 'postgresql://daftar_app:x@db/daftar/', what: 'a trailing slash on the database path' },
    { element: '1 scheme', url: 'postgres://daftar_app:x@db/daftar', what: 'the `postgres://` spelling of the same scheme' },
    {
      element: 'platform (not our element 1)',
      url: 'POSTGRESQL://daftar_app:x@db/daftar',
      what: "the scheme in upper case — pinned because `URL` lower-cases `protocol` ITSELF, so this arm measures the platform's behaviour and not ours; our own `.toLowerCase()` there is defensive and seeding it away reddens nothing",
    },
    { element: '2 host', url: 'postgresql://daftar_app:x@DB/daftar', what: 'the host in another case' },
    { element: '4 decode', url: 'postgresql://daftar_app:%78@db/daftar', what: 'the password percent-encoded (`%78` is `x`)' },
    { element: '4 decode', url: 'postgresql://daftar_%61pp:x@db/daftar', what: 'the role percent-encoded (`%61` is `a`)' },
    // The sixth review's two blocking findings, as refusal arms. Both are the
    // worst class: an input that reaches the APP credential at the DRIVER and
    // started. Verified in `node_modules/pg-connection-string/index.js`, not
    // taken on report: `:56` is `config.host = decodeURIComponent(hostname)`
    // and `:67` is `config.database = decodeURI(pathname)`, so the first two
    // spellings here are the same credential; and `:40-42` assigns every
    // query entry in a loop, so for a REPEATED parameter the LAST one wins,
    // while this key had been reading the first.
    {
      element: '2 host decode',
      url: 'postgresql://daftar_app:x@d%62/daftar',
      what: 'the HOST percent-encoded (`%62` is `b`) — the driver decodes the host, so this is `db`',
    },
    {
      element: '6 path decode',
      url: 'postgresql://daftar_app:x@db/daft%61r',
      what: 'the DATABASE percent-encoded (`%61` is `a`) — the driver decodes the path, so this is `daftar`',
    },
    {
      element: '6 query last wins',
      url: 'postgresql://daftar_identity:z@db/daftar?user=zz&user=daftar_app&password=zz&password=x',
      what: 'a REPEATED parameter whose LAST value is the app credential, which is the one the driver uses',
    },
  ];

  for (const { element, url, what } of refused) {
    it(`refuses ${what} — element ${element}`, () => {
      // The MESSAGE, not merely "it threw": a refusal for some other reason
      // would pass an assertion that only checked that something was thrown.
      expect(() => loadConfig(withIdentity(url))).toThrow(DUP);
    });
  }

  /**
   * THE THREE HOLES THE FIRST INDEPENDENT REVIEW OF THIS BRANCH MEASURED —
   * each the dangerous direction, the key FINER than the driver, so the pair
   * started and served. Each is a PAIR of spellings of ONE credential, and
   * the first draft of these arms got that wrong: it compared each spelling
   * against the fixture's `@db/daftar`, which is a DIFFERENT credential, so
   * all three went red for the right reason and told me the ARMS were
   * mis-paired rather than the fix being wrong. An arm that names a pair must
   * hold that pair.
   */
  it('refuses two EMPTY-HOST spellings of one credential — the hole that reopened the whole class', () => {
    // `new URL` refuses `…@/db` with `ERR_INVALID_URL` (measured on Node 24)
    // and the driver accepts it, substituting a dummy authority of its own.
    // The old fallback compared such a value as RAW TEXT, so these two — for
    // which `parse()` reports identical user, password, host, port and
    // database — keyed differently and the process STARTED.
    const a = 'postgresql://daftar_app:x@/daftar';
    const b = 'postgresql://daftar_app:x@/daftar?sslmode=require';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).toThrow(DUP);
  });

  it('refuses an ABSENT database against the role name, because that is the default `pg` applies', () => {
    // `parse('…@db')` reports `database: null`, and `pg` then sets
    // `database = user` — so these two are one credential. The key had
    // represented `pg`'s PORT default while ignoring this one.
    const a = 'postgresql://daftar_app:x@db';
    const b = 'postgresql://daftar_app:x@db/daftar_app';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).toThrow(DUP);
  });

  it('refuses a `socket:` pair differing only in the `?host=` the driver throws away', () => {
    // Under `socket:` the loop at `:40-42` sets `config.host` from the
    // parameter and `:48` overwrites it from the pathname before returning,
    // so `?host=` is DEAD at the driver and these reach one socket.
    const a = 'socket:/var/run/daftar-pg?db=daftar';
    const b = 'socket:/var/run/daftar-pg?db=daftar&host=/var/run/somewhere-else';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).toThrow(DUP);
  });

  /**
   * AND THE TWO THE SEVENTH REVIEW MEASURED — both in lines this branch had
   * already written, and both the same dangerous direction as the three
   * above. The arms for the three were written over the branch that the fix
   * then stopped taking, so they passed through the surviving branch and
   * pinned nothing: seeding the fix away left the law green. These two name
   * the branch they pin, and each was proved red before the fix was kept.
   */
  it('refuses an EMPTY host with `?host=` against the same host spelled in the authority', () => {
    // `:54-57` fills `config.host` only `if (!config.host)`, and the loop at
    // `:40-42` has already set it from `?host=`, so the parameter WINS.
    // Measured on `parse()`: both of these report
    // `{user:daftar_app, password:x, host:db, port:'', database:daftar}`.
    // Forcing the host to `''` whenever the authority was empty keyed them
    // as two principals and the process STARTED.
    const a = 'postgresql://daftar_app:x@/daftar?host=db';
    const b = 'postgresql://daftar_app:x@db/daftar';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).toThrow(DUP);
  });

  it('refuses a `socket:` pair whose path differs only by percent-encoding', () => {
    // `:48` is `decodeURI(result.pathname)`, so the driver reads one host
    // here: measured, both report `host: '/var/run/daftar-pg'`. Taking the
    // path raw made this key finer than the driver inside the very branch
    // written to make it coarser.
    const a = 'socket:/var/run/daftar-pg?db=daftar';
    const b = 'socket:/var/run/daftar-%70g?db=daftar';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).toThrow(DUP);
  });

  it('RULES: `%2F` in a path is NOT a separator, so the pair STARTS — which is why this is `decodeURI` and not `decodeURIComponent`', () => {
    // The driver decodes the DATABASE with `decodeURI` (`:67`), which leaves
    // reserved characters alone: measured, `…/a%2Fb` reports
    // `database: 'a%2Fb'` and `…/a/b` reports `database: 'a/b'`, so these are
    // TWO databases and two principals. Swapping in `decodeURIComponent`
    // merges them and REFUSES a correct deployment — the safe direction, so
    // not blocking, but it was the one element of this key whose choice of
    // function nothing pinned. This arm is that pin, and it reddens on the
    // swap. (Seventh review, finding 3.)
    const a = 'postgresql://daftar_app:x@db/a%2Fb';
    const b = 'postgresql://daftar_app:x@db/a/b';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).not.toThrow();
  });

  it('NEGATIVE CONTROL: two DIFFERENT `?host=` values under an empty authority stay two principals', () => {
    // The fix for the empty host must not buy its coarseness by collapsing
    // the parameter it now honours. Measured: `parse()` reports `host: 'db'`
    // for the first and `host: 'other'` for the second, so these are two
    // servers and a real deployment can have both.
    const a = 'postgresql://daftar_app:x@/daftar?host=db';
    const b = 'postgresql://daftar_app:x@/daftar?host=other';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).not.toThrow();
  });

  /**
   * AND THE TWO THE SEVENTH REVIEW MEASURED — both at the layer that actually
   * connects, `new ConnectionParameters`, not at `parse()` alone, and both the
   * same forbidden direction: the key FINER than the driver.
   */
  it('refuses an `@` inside the password against its percent-encoded spelling, under an empty host', () => {
    // `pg-connection-string:30` retries with `str.replace('@/', …)` — the FIRST
    // two characters `@/`, no anchor, no character class. The key's own regex
    // used `[^/@]*@`, which cannot cross an `@`, so this pair fell to
    // `unparseable-by-this-key` on one side and a real key on the other.
    // Measured: `parse()` reports the same five fields for both, and
    // `new ConnectionParameters` the same `["localhost",5432,"daftar_app","daftar"]`.
    const a = 'postgresql://daftar_app:p%40ss@/daftar';
    const b = 'postgresql://daftar_app:p@ss@/daftar';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).toThrow(DUP);
  });

  it("refuses an EMPTY host against an explicit `localhost`, because that is `pg`'s default host", () => {
    // `connection-parameters.js` reads `config.host || PGHOST || defaults.host`
    // and `defaults.host` is `'localhost'`. Measured with PGHOST unset: both
    // of these give `["localhost",5432,"daftar_app","daftar"]`, one connection.
    const a = 'postgresql://daftar_app:x@/daftar';
    const b = 'postgresql://daftar_app:x@localhost/daftar';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).toThrow(DUP);
  });

  it('NEGATIVE CONTROL: the default host does not collapse two NAMED hosts', () => {
    // The fix maps only the EMPTY host onto `localhost`. A deployment with two
    // genuinely different named hosts must still start, or the remedy would
    // have bought its coarseness by collapsing everything.
    const a = 'postgresql://daftar_app:x@db/daftar';
    const b = 'postgresql://daftar_app:x@localhost/daftar';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).not.toThrow();
  });

  it('NEGATIVE CONTROL: the literal `@/` retry does not make two DIFFERENT passwords one', () => {
    // Mirroring the driver's literal replacement must not blur the userinfo it
    // rewrites around: two empty-host URLs differing only in the password are
    // two credentials and a real deployment can hold both.
    const a = 'postgresql://daftar_app:p@ss@/daftar';
    const b = 'postgresql://daftar_app:other@ss@/daftar';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).not.toThrow();
  });

  it('refuses a non-canonical default port in the QUERY form against no port at all', () => {
    // `pg` reads the port with `parseInt`, so `?port=05432` IS 5432. The key
    // compared the TEXT to `'5432'`, which `new URL` normalizes in the
    // authority but `effective` returns verbatim from the query. Measured:
    // both give `["db",5432,"daftar_app","daftar"]`.
    const a = 'postgresql://daftar_app:x@db/daftar?port=05432';
    const b = 'postgresql://daftar_app:x@db/daftar';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).toThrow(DUP);
  });

  it('NEGATIVE CONTROL: reading the port as a number does not collapse two DIFFERENT ports', () => {
    const a = 'postgresql://daftar_app:x@db/daftar?port=05433';
    const b = 'postgresql://daftar_app:x@db/daftar';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).not.toThrow();
  });

  it('FAILS CLOSED: two ports that are not numbers collide, because `parseInt` cannot tell them apart either', () => {
    const a = 'postgresql://daftar_app:x@db/daftar?port=abc';
    const b = 'postgresql://daftar_app:x@db/daftar?port=zzz';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: a, IDENTITY_DATABASE_URL: b })).toThrow(DUP);
  });

  it('refuses the byte-identical spelling too, which is what held before this law', () => {
    expect(() => loadConfig(withIdentity(APP))).toThrow(DUP);
  });

  // ── THE OTHER HALF: ONE NEGATIVE CONTROL PER ELEMENT ─────────────────────
  //
  // Each of these is a configuration a real deployment can have, and each
  // would be refused by an element that normalized more than it should. A
  // `dbPrincipalKey` that collapsed everything would redden exactly here.
  const started: readonly { readonly element: string; readonly url: string; readonly what: string }[] = [
    {
      element: '2 host',
      url: 'postgresql://daftar_app:x@identity-db/daftar',
      what: 'a different host — no DNS is resolved, so two names stay two principals',
    },
    {
      element: '3 port',
      url: 'postgresql://daftar_app:x@db:5433/daftar',
      what: 'a NON-default port — two servers on one host is a real deployment',
    },
    {
      element: '5 path',
      url: 'postgresql://daftar_app:x@db/daftar_identity',
      what: 'a different database on the same host',
    },
    {
      element: '4 decode',
      url: 'postgresql://daftar_app:%79@db/daftar',
      what: 'a different password after decoding (`%79` is `y`) — a rotation must not be refused',
    },
    {
      element: '4 decode',
      url: 'postgresql://daftar_identity:x@db/daftar',
      what: 'a different role with the same password — the roster this file is about',
    },
    {
      element: '1 scheme',
      url: 'mysql://daftar_app:x@db/daftar',
      what: 'a genuinely different scheme — only `postgres`/`postgresql` are one',
    },
  ];

  for (const { element, url, what } of started) {
    it(`NEGATIVE CONTROL: ${what} — defends element ${element}`, () => {
      expect(() => loadConfig(withIdentity(url))).not.toThrow();
    });
  }

  // ── THE DOUBLE-ENCODING RULING, WRITTEN DOWN RATHER THAN LEFT TO CHANCE ───
  it('RULES: a double-encoded escape is a DIFFERENT secret, so it starts', () => {
    // `%2578` is the literal text `%78`, not `x`. Decoding once keeps them
    // apart; decoding repeatedly would merge two different passwords and
    // refuse a correct deployment. This arm fixes the choice so that a future
    // "just decode until it stops changing" cannot slip in unnoticed.
    expect(() => loadConfig(withIdentity('postgresql://daftar_app:%2578@db/daftar'))).not.toThrow();
  });

  it('RULES: a malformed escape does not crash the check, and still compares', () => {
    // `decodeURIComponent('%zz')` throws. The refusal must not become a
    // TypeError out of the middle of the loader — and the value must still
    // compare, so the identical malformed string is refused.
    const env = { ...MERCHANT_PROD, APP_DATABASE_URL: 'postgresql://daftar_app:%zz@db/daftar' };
    expect(() => loadConfig({ ...env, IDENTITY_DATABASE_URL: 'postgresql://daftar_app:%zz@db/daftar' })).toThrow(DUP);
    expect(() => loadConfig({ ...env, IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:%zz@db/daftar' })).not.toThrow();
  });

  // ── ELEMENT 6: THE QUERY PARAMETERS THAT CARRY IDENTITY ──────────────────
  //
  // The blocking finding of #118's review. An earlier version excluded the
  // query string with the comment that a parameter changes "how a principal
  // connects, never which principal it is". Measured against the driver's own
  // parser, that was false in BOTH directions: `?user=…&password=…` reaches
  // another role while the URL still spells this one, and two servers that
  // differ only in `?port=` were keyed as one principal and refused.
  const byParameter: readonly { readonly url: string; readonly what: string }[] = [
    {
      url: 'postgresql://daftar_resolver:y@db/daftar?user=daftar_app&password=x',
      what: '`?user=` and `?password=` reaching APP while the userinfo spells another role',
    },
    { url: 'postgresql://daftar_app:x@elsewhere/daftar?host=db', what: '`?host=` overriding the host' },
    { url: 'postgresql://daftar_app:x@db:5433/daftar?port=5432', what: '`?port=` overriding back to the default port' },
    { url: 'postgresql://daftar_app:x@db/daftar?dbname=other', what: '`?dbname=`, which that parser does NOT honour, so it rescues nothing' },
  ];

  for (const { url, what } of byParameter) {
    it(`refuses ${what} — element 6 query parameters`, () => {
      expect(() => loadConfig(withIdentity(url))).toThrow(DUP);
    });
  }

  it('NEGATIVE CONTROL: `?port=` to a NON-default port is a different principal — defends element 6', () => {
    // The direction the exclusion got wrong the other way: two servers on one
    // host, told apart only by a parameter, must both start.
    expect(() => loadConfig(withIdentity('postgresql://daftar_app:x@db/daftar?port=5433'))).not.toThrow();
  });

  it('an EMPTY parameter falls back to the URL, so the two spellings are ONE credential and are refused', () => {
    // The arm that MEASURES the empty-value fallback, added because the
    // negative control below does not: with `fromQuery !== ''` seeded away,
    // that control stays GREEN (the user becomes the empty string, which is
    // still different from `daftar_app`), so nothing in this file held the
    // condition. Here the empty `?user=` must fall back to the URL's own
    // `daftar_app` — if it did not, this pair would key differently and
    // START. (First independent review of this branch, finding 4.)
    expect(() => loadConfig(withIdentity('postgresql://daftar_app:x@db/daftar?user='))).toThrow(DUP);
  });

  it('NEGATIVE CONTROL: a parameter that is present but EMPTY falls back to the URL — defends element 6', () => {
    // `?user=` with no value must not blank the role out and collapse
    // everything onto one key.
    expect(() => loadConfig(withIdentity('postgresql://daftar_identity:x@db/daftar?user='))).not.toThrow();
  });

  it('DEPENDENCY: the precedence this key copies is read from the driver, not assumed', async () => {
    // If `pg-connection-string` stops letting these parameters override — or
    // starts honouring `dbname` — this arm reddens and the key above is wrong
    // until it is changed. A claim about someone else's behaviour has to be
    // measured where it lives. (`database.ts` builds its pool with
    // `new Pool({ connectionString })`, which is this parser.)
    const { parse } = await import('pg-connection-string');
    const overridden = parse('postgresql://daftar_resolver:y@db/daftar?user=daftar_app&password=x&host=other&port=5433');
    expect(overridden.user).toBe('daftar_app');
    expect(overridden.password).toBe('x');
    expect(overridden.host).toBe('other');
    expect(overridden.port).toBe('5433');
    // And the one that does NOT override, which is why it is absent from the key:
    expect(parse('postgresql://daftar_app:x@db/daftar?dbname=other').database).toBe('daftar');

    // THE THREE BEHAVIOURS THE SIXTH REVIEW FOUND THE KEY DISAGREEING WITH,
    // pinned HERE, at the dependency, and not only through `loadConfig`. Each
    // one of them, left unmatched, made the key FINER than the driver — and a
    // key finer than the driver accepts a duplicate credential, which is the
    // one direction §31 may never fail in.
    //
    // 1. the host IS decoded (`index.js:56`, `decodeURIComponent`)
    expect(parse('postgresql://daftar_app:x@d%62/daftar').host).toBe('db');
    // 2. the database IS decoded (`:67`) — and with `decodeURI`, which is NOT
    //    the same function: it leaves the reserved set alone. Both halves are
    //    pinned, because copying the wrong one of the two is itself the bug.
    expect(parse('postgresql://daftar_app:x@db/daft%61r').database).toBe('daftar');
    expect(parse('postgresql://daftar_app:x@db/a%2Fb').database).toBe('a%2Fb');
    // 3. for a REPEATED parameter the LAST value wins (`:40-42` assigns every
    //    entry in a loop), where `URLSearchParams.get()` returns the first.
    const repeated = parse('postgresql://daftar_identity:z@db/daftar?user=zz&user=daftar_app');
    expect(repeated.user).toBe('daftar_app');
    expect(new URL('postgresql://daftar_identity:z@db/daftar?user=zz&user=daftar_app').searchParams.get('user')).toBe('zz');
  });

  it('NEGATIVE CONTROL: two Unix socket paths that differ only in CASE stay two principals', () => {
    // A file path is case-sensitive, so the host is lower-cased only when it
    // is a NAME. Lower-casing it unconditionally read two different sockets as
    // one principal and refused a correct deployment — the other defect class,
    // and the reason this arm is a negative control rather than a refusal.
    // (Sixth review, finding 4.)
    //
    // BOTH URLs carry the socket path, and that is the whole point of the arm.
    // The first version of this control set only IDENTITY to a socket path and
    // left APP on `db`: the two were different hosts either way, so the arm
    // passed whether the case was folded or not. Seeding the guard away left
    // it GREEN — a control that does not move with the line it names measures
    // nothing, and this file says so about other people's arms, so it says it
    // about its own.
    const socketApp = 'postgresql://daftar_app:x@db/daftar?host=/var/run/PG';
    const socketIdentity = 'postgresql://daftar_app:x@db/daftar?host=/var/run/pg';
    expect(() => loadConfig({ ...MERCHANT_PROD, APP_DATABASE_URL: socketApp, IDENTITY_DATABASE_URL: socketIdentity })).not.toThrow();
    // And the same pair as NAMES still collapses, which is element 2's own
    // claim — so the arm pins the boundary between the two cases rather than
    // just one side of it.
    expect(() =>
      loadConfig({
        ...MERCHANT_PROD,
        APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar?host=PG',
        IDENTITY_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar?host=pg',
      }),
    ).toThrow(DUP);
  });

  it('RULES: a decoded `%00` cannot shift the field boundaries of the key', () => {
    // The parts are percent-decoded before they are joined, so a NUL-joined
    // key let `a%00b:c` and `a:b%00c` produce the same string — two different
    // secrets as one principal. (#118's review, finding 3.) The key is JSON
    // now, which encodes its own boundaries, so these are two principals and
    // the process starts.
    const env = { ...MERCHANT_PROD, APP_DATABASE_URL: 'postgresql://a%00b:c@db/daftar' };
    expect(() => loadConfig({ ...env, IDENTITY_DATABASE_URL: 'postgresql://a:b%00c@db/daftar' })).not.toThrow();
    // And the same value twice is still one principal, so the fallback did not
    // become "nothing ever matches".
    expect(() => loadConfig({ ...env, IDENTITY_DATABASE_URL: 'postgresql://a%00b:c@db/daftar' })).toThrow(DUP);
  });

  it('RULES: a value this key cannot parse FAILS CLOSED — every such value collides, rather than comparing as text', () => {
    // It used to compare as raw text, and that was the blocking defect: raw
    // text is FINER than the driver, so two spellings of one credential that
    // this key could not parse keyed differently and started. Now every
    // unparseable value keys the same, so §31 REFUSES the pair — coarser,
    // which refuses a deployment visibly instead of accepting a duplicate
    // credential silently.
    const env = { ...MERCHANT_PROD, APP_DATABASE_URL: 'not-a-url' };
    expect(() => loadConfig({ ...env, IDENTITY_DATABASE_URL: 'not-a-url' })).toThrow(DUP);
    // AND TWO DIFFERENT unparseable values are refused too, which is what
    // "fails closed" means here and is the half a byte-identical pair cannot
    // show.
    expect(() => loadConfig({ ...env, IDENTITY_DATABASE_URL: 'also-not-a-url' })).toThrow(DUP);
  });
});
