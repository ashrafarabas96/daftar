import { z } from 'zod';
import { hmacKeysEquivalent } from '@daftar/accounting';

/**
 * Central validated config (§34). No module reads process.env directly; missing
 * required config fails startup fast.
 *
 * Security Gate Zero (§8–§14):
 * - The API runtime NEVER knows the migration/owner connection. There is no
 *   DATABASE_URL/MIGRATION_DATABASE_URL here — the migration CLI reads
 *   MIGRATION_DATABASE_URL itself, inside the migration command only.
 * - APP_DATABASE_URL (daftar_app) is the normal runtime role — RLS-enforced.
 * - PLATFORM_DATABASE_URL (daftar_platform) is the identity/platform boundary.
 * - Production FAILS CLOSED: local storage, log delivery, memory rate limiter
 *   or a missing platform URL are startup errors, never silent fallbacks.
 */

/**
 * REL-10: the development allowlist, named once so the production gate can
 * recognise "still the default" and say so, rather than refusing for the
 * incidental reason that the default happens to be loopback http.
 */
const DEV_CORS_ORIGINS = 'http://localhost:3001';

/**
 * REL-10: the browser allowlist, parsed in ONE place.
 *
 * `main.ts` used to run its own `CORS_ORIGINS.split(',').map(trim)` next to the
 * validation below. Two parses of one value is exactly how a gate and the
 * server it guards come to disagree — the gate approves what it split, the
 * server enables what it split, and nobody compares them. There is now one
 * function, `main.ts` calls it, and `tests-unit/rel10-cors-allowlist.test.ts`
 * fails if that stops being true.
 *
 * It deliberately does NOT drop empty entries. `'a,,b'` is an operator mistake,
 * and silently discarding the gap would hide it; `corsOriginProblem` refuses it
 * by name instead.
 */
export function parseCorsOrigins(raw: string): readonly string[] {
  return raw.split(',').map((o) => o.trim());
}

/**
 * Why `origin` is not something a browser can ever match — in ANY environment —
 * or `null` if it is a well-formed origin.
 *
 * Every case here is a value that is BROKEN rather than merely permissive, so
 * none of them is a production-only concern:
 *
 *  - `''`: `enableCors` would hold an empty string in its allowlist, which
 *    matches no `Origin` header, while the comma that produced it reads as a
 *    second origin.
 *  - `'*'`: `enableCors` receives an ARRAY here, and `cors` compares array
 *    members for EQUALITY. `'*'` in a list therefore does not mean "any
 *    origin"; it means an origin spelled `*`, which no browser sends. It reads
 *    as "wide open" and behaves as "nothing" — the one combination worth
 *    refusing outright. (A deliberately open API would pass `origin: true`,
 *    which is a different decision, in a different place, and is not this
 *    value.)
 *  - anything that is not exactly scheme + host + optional port: a trailing
 *    slash, a path, a query, a fragment, embedded credentials, or a bare host.
 *    A browser's `Origin` header carries none of those, so such an entry never
 *    matches and fails SILENTLY — a CORS error in a merchant's browser weeks
 *    later, with nothing in any log to name the cause.
 */
function corsOriginProblem(origin: string): string | null {
  if (origin === '') return 'an empty entry is not an origin (check for a stray or trailing comma in CORS_ORIGINS)';
  if (origin === '*') {
    return '\'*\' is refused: the allowlist is a LIST and members are compared for equality, so \'*\' matches no Origin any browser sends — it reads as "open" and behaves as "nothing"';
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return `${JSON.stringify(origin)} is not an absolute origin; a browser Origin is scheme://host[:port]`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${JSON.stringify(origin)} is not an http(s) origin`;
  }
  if (origin !== parsed.origin) {
    return `${JSON.stringify(origin)} must be written exactly as ${parsed.origin} — a browser Origin header carries no trailing slash, path, query, fragment or credentials, so anything else silently matches nothing`;
  }
  return null;
}

/**
 * Why a well-formed `origin` is not acceptable IN PRODUCTION, or `null`.
 *
 * Only called for an origin `corsOriginProblem` has already accepted, so the
 * `new URL` here cannot throw.
 */
function productionCorsOriginProblem(origin: string): string | null {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:') {
    return `${origin} is not https: a production browser origin is served over TLS, and an http origin in the allowlist invites the downgrade it would accept`;
  }
  if (isLocalHost(parsed.hostname)) {
    return `${origin} is a loopback or all-interfaces origin: production names the real web origins it serves`;
  }
  return null;
}

/**
 * Does `hostname` — as the URL parser normalised it — name only this machine?
 *
 * REL-10 review, finding 3. The first form of this check listed four spellings
 * (`localhost`, `*.localhost`, `127.0.0.1`, `::1`) and so READ as "no loopback
 * in production" while MEANING "not those four". Measured as passing before
 * this: `https://127.0.0.2` (the rest of 127.0.0.0/8), `https://0.0.0.0` and
 * `https://[::]` (every interface, which includes the loopback one), and
 * `https://[::ffff:7f00:1]`. A rule that reads wider than it acts is the kind
 * that gets trusted for what it says.
 *
 * It matches the PARSED host, not the operator's text, because the parser folds
 * the short and numeric spellings first (measured: `https://127.1` and
 * `https://2130706433` both normalise to `127.0.0.1`, and
 * `https://[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`). The bracket strip is for
 * the IPv6 forms, whose `hostname` keeps the brackets.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // The whole loopback block, not only its first address.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // Not loopback, but "every interface on this machine" — never an origin a
  // merchant's browser can send.
  if (host === '0.0.0.0' || host === '::') return true;
  if (host === '::1') return true;
  // IPv4-mapped loopback, in the hex form the parser produces.
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return true;
  return false;
}

/** PostgreSQL's default port, which a URL may write out or leave implicit. */
const DEFAULT_POSTGRES_PORT = '5432';

/**
 * Percent-decoding applied EXACTLY ONCE, with a malformed escape left alone.
 *
 * Once, not repeatedly: `%2578` denotes the literal text `%78`, which is a
 * DIFFERENT secret from `x` (`%78`). Decoding twice would merge two distinct
 * passwords into one and refuse a deployment that is correct. And a malformed
 * escape (`%zz`) makes `decodeURIComponent` throw, so it is returned as written
 * — a startup refusal must not become a crash inside the refusal check.
 */
function decodeOnce(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The same, with `decodeURI` — the function the driver uses for the PATH
 * (`pg-connection-string/index.js:67`), where it uses `decodeURIComponent`
 * for the host (`:56`). They differ: `decodeURI` leaves the reserved set
 * (`%2F`, `%3F`, `%23` …) encoded. Copying the driver function by function is
 * the point — a key built with the wrong one of the two would be finer than
 * the driver for `%2F` in a database name and would accept a duplicate.
 *
 * A malformed escape throws, and that must not take the process down before
 * the refusal is reported, so it compares as written.
 */
function decodeUriOnce(part: string): string {
  try {
    return decodeURI(part);
  } catch {
    return part;
  }
}

/**
 * THE IDENTITY OF A DATABASE PRINCIPAL, as §31 compares them.
 *
 * §31 used to compare the connection strings as TEXT. Measured on `main`
 * (`0af68e81`), with an otherwise correct production `merchant-api` that
 * started as the control: of eight spellings of ONE credential, only the
 * byte-identical one was refused. These all started —
 *
 *   `@db:5432/` (the default port written out) · `?sslmode=require` appended ·
 *   a trailing slash · `postgres://` for `postgresql://` · `@DB/` in another
 *   case · `%78` for the password `x` · `%61` inside the role name
 *
 * — so the law over §31 pinned TEXTUAL EQUALITY, not one credential. Any of
 * those seven collapses two roles onto one principal while the process starts,
 * serves and reports nothing, which is the whole class §31 exists to refuse.
 *
 * THREE MORE STARTED AGAINST THE FIRST VERSION OF THIS VERY FUNCTION, and
 * they are listed beside the original seven because they are the same class
 * and were found the same way — the sixth review of #118, measured on this
 * branch at `4f0a2fc0`, each reproduced as a red arm before it was closed:
 *
 *   `@d%62/` (the host encoded) · `/daft%61r` (the database encoded) ·
 *   `?user=zz&user=daftar_app` (a repeated parameter, whose LAST value is the
 *   one the driver connects with)
 *
 * The lesson they share is the one invariant this function has: THE KEY MUST
 * NEVER BE FINER THAN THE DRIVER. Every field here is derived by copying what
 * `pg-connection-string` does to that field, function by function — not by
 * choosing a normalization that looks reasonable. A key coarser than the
 * driver refuses a deployment that should work, which is visible and
 * recoverable; a key finer than the driver accepts a duplicate credential
 * while the process starts and reports nothing, which is not.
 *
 * WHAT IS NORMALIZED, and nothing beyond it:
 *   1. the scheme, case-insensitively, with `postgres` ≡ `postgresql`
 *   2. the host, percent-decoded ONCE and lower-cased ONLY when it is a NAME.
 *      DNS is case-insensitive, but this field can also hold a Unix socket
 *      PATH (`?host=/var/run/postgresql`), and a path is case-sensitive — so a
 *      value starting with `/` keeps its case. Lower-casing it unconditionally
 *      read two different sockets as one principal.
 *   3. the port, with `5432` and "absent" the same
 *   4. the role and the password, percent-decoded ONCE (see `decodeOnce`)
 *   5. the database path, without a trailing slash, percent-decoded ONCE with
 *      `decodeURI` — the driver's own function for this field, which is NOT
 *      `decodeURIComponent` (see `decodeUriOnce`)
 *   6. the query parameters that CARRY IDENTITY — `user`, `password`, `host`
 *      and `port` — each overriding the same field in the URL, taking the LAST
 *      value when one is repeated, because that is what the driver does: it
 *      assigns every entry in a loop, while `URLSearchParams.get()` returns
 *      the first. Measured against `pg-connection-string`, the
 *      parser behind `new Pool({ connectionString })`, and pinned by an arm
 *      that reads it so a change in the dependency reddens here.
 *      `sslmode`, timeouts and pool options are NOT in the key: they change
 *      how a principal connects, not which principal it is. `dbname` is not
 *      either, because that parser does not let it override the path —
 *      measured, and pinned, so the day it does this file reddens instead of
 *      quietly keying two databases as one.
 *
 * WHAT IS DELIBERATELY NOT NORMALIZED, because normalizing is a widening and
 * each widening can refuse a correct deployment:
 *   · two different hosts are two principals here — this function resolves no
 *     DNS and will not assume two names are one server
 *   · a non-default port is part of the identity
 *   · two different database names are two principals
 *   · an unparseable value is returned unchanged, so it still compares as text
 *     rather than silently matching everything
 *
 * WHAT THIS DOES NOT REACH, named here because the next reader of §31 is
 * looking at this function and would otherwise read it as covering more than
 * it does: only the names in §31's own map are compared through this key.
 * The clause whose message is "must be a distinct role from APP/PLATFORM
 * (least-privilege provisioning boundary)" compares `PROVISIONER_DATABASE_URL`
 * against APP and PLATFORM as RAW TEXT, so on a tree where that name is not a
 * member of the map, a provisioner credential written another way is still
 * accepted — `postgres://` for `postgresql://`, say. #111 adds it to the map;
 * until that lands, the class is closed for the map's members and open for the
 * provisioner. (Review of #118, finding 2.)
 *
 * It is cited by its WORDING, not by its line. The number written here was
 * `:521-522`, measured before the block you are reading was added, and by the
 * time anyone read it the clause had moved to `:697-698` — a line number
 * inside the SAME file shifts with any edit above it, so a citation by line is
 * stale the moment the file is touched. The wording is greppable and moves
 * with the clause. (Sixth review, finding 3.)
 *
 * TWO MORE THINGS THIS KEY DOES NOT REACH, with the DIRECTION of each, since
 * that is what decides whether it matters: a key that is COARSER than the
 * driver can refuse a correct deployment, and one that is FINER accepts a
 * duplicate credential. Only the second is a security hole, and neither of
 * these is of that kind:
 *   · `pg-connection-string:57-59` prepends a `%2f…` hostname to the pathname
 *     when a `host` parameter is also present, which changes the DATABASE the
 *     driver connects to. This key reads the pathname alone, so such a pair
 *     can key EQUAL while the driver sees two databases — coarser, so it
 *     refuses rather than accepts.
 *   · under the `socket:` scheme the driver takes the database from `?db`
 *     (`:49`) and the host from the path (`:48`). `?db` is not in this key, so
 *     two `socket:` URLs differing only there key equal — coarser again. The
 *     scheme is itself element 1, so a `socket:` URL never collides with a
 *     `postgresql://` one.
 *
 * Pinned, element by element with a negative control for each, in
 * `tests-unit/config-db-principal-normalize-law.test.ts`.
 */
function dbPrincipalKey(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL: compare it as text, which is what §31 did for everything
    // before this function existed.
    return JSON.stringify(['raw', raw]);
  }
  const query = url.searchParams;
  /**
   * A query parameter WINS over the same field in the URL, because that is
   * what the driver does — measured, not assumed, against
   * `pg-connection-string` (the parser `new Pool({ connectionString })` uses
   * in `apps/api/src/infra/database.ts`):
   *
   *   `…://daftar_resolver:y@db/daftar?user=daftar_app&password=x`
   *       -> user `daftar_app`, password `x`
   *   `…://daftar_app:x@db/daftar?port=5433`   -> port 5433
   *   `…://daftar_app:x@db/daftar?host=/var/run/postgresql` -> that host
   *
   * The first of those is why the query string is NOT excluded from this key.
   * An earlier version of this function excluded it, with the comment that a
   * parameter changes "how a principal connects, never which principal it
   * is". That was false in BOTH directions and the review of #118 caught it:
   * `?user=…&password=…` reaches another role while the URL's userinfo still
   * spells this one, and two servers that differ only in `?port=` would have
   * been refused as one principal.
   *
   * Note the asymmetry, which is a property of the platform and not a choice:
   * `URL` does NOT decode userinfo, while `searchParams` DOES decode a
   * parameter. So a value taken from the query is already decoded and must not
   * be decoded again.
   */
  const effective = (param: string, fromUrl: string, decodeFromUrl: boolean): string => {
    // The LAST value of a repeated parameter, not the first. The driver
    // assigns every entry of `searchParams` in a loop
    // (`pg-connection-string/index.js:40-42`), so for `?user=a&user=b` the
    // one it connects with is `b`. `query.get()` returns `a`, and reading it
    // meant `?user=zz&user=daftar_app` keyed as `zz` while reaching the app
    // credential — a duplicate accepted, the worst direction. (Sixth review,
    // finding 2.)
    const all = query.getAll(param);
    const fromQuery = all.length === 0 ? null : (all[all.length - 1] ?? null);
    if (fromQuery !== null && fromQuery !== '') return fromQuery;
    return decodeFromUrl ? decodeOnce(fromUrl) : fromUrl;
  };
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const canonicalScheme = scheme === 'postgres' ? 'postgresql' : scheme;
  const port = effective('port', url.port, false);
  // Percent-DECODED, with the driver's own two functions: it uses
  // `decodeURI` for the path (`:67`) and `decodeURIComponent` for the host
  // (`:56`), which are not the same function — `decodeURI` leaves reserved
  // characters like `%2F` alone. Leaving either raw made this key FINER than
  // the driver, which is the one property it must never have: `d%62` and `db`
  // are one host to the driver, and `daft%61r` and `daftar` one database, so
  // both spellings reached the app credential while keying differently and
  // starting. (Sixth review, finding 1.)
  const database = decodeUriOnce(url.pathname.replace(/\/+$/, ''));
  // The host is lower-cased ONLY when it is a NAME. The query form may carry a
  // Unix socket PATH (`?host=/var/run/postgresql`), and a file path is
  // case-sensitive, so lower-casing it would read two different sockets as one
  // principal and refuse a correct deployment. The old comment justified the
  // lower-casing by DNS alone, which is not true of every value this field can
  // hold. (Sixth review, finding 4.)
  const host = effective('host', url.hostname, true);
  const canonicalHost = host.startsWith('/') ? host : host.toLowerCase();
  // JSON.stringify, not a NUL-joined string: the parts are percent-DECODED
  // before they are joined, so a `%00` inside a role name used to shift the
  // field boundaries and merge two different secrets into one key — measured in
  // the review of #118. An array encodes its own boundaries.
  return JSON.stringify([
    canonicalScheme,
    effective('user', url.username, true),
    effective('password', url.password, true),
    canonicalHost,
    port === DEFAULT_POSTGRES_PORT ? '' : port,
    database,
  ]);
}

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // §XXV–XXIX: deployment modes within the SAME modular monolith.
    //  - merchant-api: merchant surface only (app/identity/resolver DB roles)
    //  - platform-api: super-admin surface (platform + identity-read DB roles)
    //  - worker:       credential delivery + outbox (worker DB role, key ring, SMTP)
    //  - reconciler:   accounting reconciliation ONLY (reconciler DB role, no
    //                  HTTP surface, no delivery secrets) — P2-S8 §6/§7. It is
    //                  a separate mode rather than a provider inside the worker
    //                  because delivery authority is not financial authority:
    //                  the worker already holds the credential key ring and the
    //                  SMTP credential, and a process that reads every
    //                  business's ledger must not also hold those.
    //  - all:          single-process deployment (small installs, dev/test)
    PROCESS_MODE: z.enum(['merchant-api', 'platform-api', 'worker', 'reconciler', 'all']).default('all'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000), // 0 = ephemeral (tests)
    // Required for HTTP modes; the WORKER process must not receive it (§XXVIII).
    APP_DATABASE_URL: z.string().min(1).optional(),
    PLATFORM_DATABASE_URL: z.string().min(1).optional(),
    IDENTITY_DATABASE_URL: z.string().min(1).optional(),
    RESOLVER_DATABASE_URL: z.string().min(1).optional(),
    // §13 (Stabilization): narrow provisioning principal — onboarding,
    // create-business, invitation acceptance ONLY.
    PROVISIONER_DATABASE_URL: z.string().min(1).optional(),
    // Blocker 1: HMAC key (base64, ≥32 bytes) the merchant API uses to MINT
    // provisioning assertions; the database holds the same key (0038) and
    // verifies every provisioning command against it.
    PROVISIONING_ASSERTION_KEY: z.string().optional(),
    PROVISIONING_ASSERTION_KID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .optional(),
    // P2-S3 (§19): the HMAC key the merchant API uses to MINT accounting
    // command assertions. A SEPARATE secret from the provisioning key: one
    // stolen secret must not compromise both business provisioning and the
    // general ledger, and either must be rotatable without the other.
    ACCOUNTING_ASSERTION_KEY: z.string().optional(),
    ACCOUNTING_ASSERTION_KID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .optional(),
    // P3-AL-55 §C: the HMAC key the merchant API uses to MINT `invctl/1`
    // inventory command assertions. A THIRD, separate secret: an inventory
    // key compromise must not reach the ledger or onboarding, and the reverse.
    // The database holds the same bytes in `inventory_assertion_keys`, a table
    // no runtime role can read.
    INVENTORY_ASSERTION_KEY: z.string().optional(),
    INVENTORY_ASSERTION_KID: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .optional(),
    WORKER_DATABASE_URL: z.string().min(1).optional(),
    // P2-S8 §6: the reconciliation principal (daftar_reconciler). Read-only by
    // grant, and the ONLY database authority the reconciler process receives.
    RECONCILER_DATABASE_URL: z.string().min(1).optional(),
    // Required for HTTP modes; the WORKER process must not receive it (§XXVIII).
    JWT_SECRET: z.string().min(32).optional(),
    // §56–60: JWT key ring — JSON array [{kid, secret, status:'active'|'previous'}].
    // Exactly one active key signs; active+previous verify (rotation without mass logout).
    // When unset, JWT_SECRET is used as a single legacy key.
    JWT_KEYS: z.string().optional(),
    // §52–55: legacy single-proxy mode, dev/test only (refused in production,
    // TD-19 review M-1): the client is the RIGHTMOST X-Forwarded-For entry.
    TRUST_PROXY: z.enum(['true', 'false']).default('false'),
    // §XXXIX–XL: known proxies of this deployment — comma-separated exact IPs
    // (v4/v6) and/or IPv4 CIDR ranges. When set, XFF is walked right-to-left
    // skipping trusted hops; a direct (untrusted) socket peer voids XFF.
    TRUSTED_PROXIES: z.string().default(''),
    PLATFORM_ROOT_DOMAIN: z.string().min(1).default('localhost:3001'),
    MEDIA_STORAGE: z.enum(['local', 's3']).default('local'),
    MEDIA_ROOT: z.string().min(1).default('./var/media'),
    MEDIA_PUBLIC_BASE_URL: z.string().min(1).default('/media'),
    MEDIA_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(5 * 1024 * 1024),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_PUBLIC_BASE_URL: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    REDIS_URL: z.string().optional(),
    CREDENTIAL_DELIVERY_KIND: z.enum(['log', 'smtp']).default('log'),
    CREDENTIAL_PAYLOAD_KEY: z.string().optional(),
    CREDENTIAL_KMS_ENDPOINT: z.string().url().optional(),
    // Blocker 4: the KMS bridge is an AUTHENTICATED HTTPS service. Token ≥32
    // chars; bounded timeout (ms) for the encrypt call.
    CREDENTIAL_KMS_TOKEN: z.string().min(32).optional(),
    CREDENTIAL_KMS_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
    // §23–27: credential encryption key ring — JSON [{version, key(base64 32B), status:'active'|'previous'}].
    CREDENTIAL_PAYLOAD_KEYS: z.string().optional(),
    SMTP_URL: z.string().optional(),
    SMTP_FROM: z.string().email().optional(),
    DEV_MAILBOX_FILE: z.string().min(1).default('./var/dev-mailbox.log'),
    CORS_ORIGINS: z.string().default(DEV_CORS_ORIGINS),
    // §11 (Final Enforcement): support session lifetime is capped SERVER-SIDE.
    // Arbitrary far-future expiry is rejected; default maximum is 4 hours.
    SUPPORT_SESSION_MAX_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(240),
    LOG_LEVEL: z.string().default('info'),
  })
  .superRefine((c, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    const mode = c.PROCESS_MODE;

    // ── P2-S8 §7: the reconciler's environment, checked in EVERY environment ─
    // The rest of this function only runs in production, because the other
    // modes accept dev conveniences. The reconciler has none. A process that
    // may read every business's ledger must not be able to hold the delivery
    // key ring, the SMTP credential, an assertion signing key or any other
    // runtime database credential — not in production, not in a staging box,
    // and not on a laptop where the habit would be formed. So this separation
    // is a property of the mode rather than of NODE_ENV.
    if (mode === 'reconciler') {
      if (!c.RECONCILER_DATABASE_URL) {
        fail('RECONCILER_DATABASE_URL', 'PROCESS_MODE=reconciler requires the reconciler DB URL (daftar_reconciler role) — there is no fallback');
      }
      for (const n of [
        'APP_DATABASE_URL',
        'PLATFORM_DATABASE_URL',
        'IDENTITY_DATABASE_URL',
        'RESOLVER_DATABASE_URL',
        'PROVISIONER_DATABASE_URL',
        'WORKER_DATABASE_URL',
        'PROVISIONING_ASSERTION_KEY',
        'ACCOUNTING_ASSERTION_KEY',
        'INVENTORY_ASSERTION_KEY',
        'CREDENTIAL_PAYLOAD_KEY',
        'CREDENTIAL_PAYLOAD_KEYS',
        'CREDENTIAL_KMS_ENDPOINT',
        'CREDENTIAL_KMS_TOKEN',
        'SMTP_URL',
        'JWT_SECRET',
        'JWT_KEYS',
        'S3_ACCESS_KEY_ID',
        'S3_SECRET_ACCESS_KEY',
      ] as const) {
        if (c[n]) {
          fail(n, 'must NOT be set in PROCESS_MODE=reconciler (reconciliation is a read-only accounting authority and holds no other credential)');
        }
      }
    } else if (c.RECONCILER_DATABASE_URL && mode !== 'all') {
      // The converse, and the one that matters most for §15: no HTTP runtime
      // and no delivery worker may quietly acquire the credential that can
      // read every business's ledger.
      fail('RECONCILER_DATABASE_URL', `must NOT be set in PROCESS_MODE=${mode} (only the reconciler process holds reconciliation authority)`);
    }

    // ── SEC-01: the worker is denied the SESSION signing key, in EVERY
    // environment ────────────────────────────────────────────────────────
    // `JWT_SECRET`/`JWT_KEYS` are the ring that mints access tokens. The
    // worker has no session authority — it delivers credentials and
    // publishes the outbox — and `TokenService` is provided only in
    // `identityProviders`, never in the worker's container. That is not
    // enough. The ring is a VALUE on the configuration object that every
    // worker provider receives ('APP_CONFIG'), and `parseKeyRing` is a
    // top-level export, so a worker that merely RECEIVES the secret can mint
    // a token for any user and any session by constructing TokenService by
    // hand. Measured before this block existed: it did, and the merchant
    // API's own verifier accepted the token
    // (`tests-unit/sec01-worker-jwt-deny.test.ts`).
    //
    // Like the reconciler block above, this is therefore a property of the
    // MODE rather than of NODE_ENV: a staging box or a laptop is exactly
    // where the habit — and then the adapter that uses it — gets written. So
    // it sits BEFORE the production gate below, and a test that only proves
    // the production case proves nothing about the denial.
    //
    // It is deliberately an INDEPENDENT `if`, NOT an arm chained onto the
    // reconciler's `if/else if`: that chain's `else` arm is the converse
    // control that denies RECONCILER_DATABASE_URL to every OTHER mode, and a
    // worker arm inside it would exempt the worker from that control —
    // opening a wider hole than this one closes.
    if (mode === 'worker') {
      for (const n of ['JWT_SECRET', 'JWT_KEYS'] as const) {
        if (c[n]) {
          fail(
            n,
            'must NOT be set in PROCESS_MODE=worker (the session signing key mints an access token for any user; the worker holds no session authority — SEC-01)',
          );
        }
      }
    }

    // ── REL-10: the browser allowlist, checked in EVERY environment ─────────
    // Only the BROKEN cases live here (see `corsOriginProblem`): an empty
    // entry, `*`, and anything that is not exactly an origin. A development
    // box is where such a value is typed, and a value that matches nothing is
    // no more acceptable there than in production — it just costs an afternoon
    // instead of a launch. The production-only rules (https, no loopback) are
    // below the gate, because dev needs their opposite.
    for (const origin of parseCorsOrigins(c.CORS_ORIGINS)) {
      const problem = corsOriginProblem(origin);
      if (problem !== null) fail('CORS_ORIGINS', problem);
    }

    if (c.NODE_ENV !== 'production') return;
    // REL-10: production names its browser origins explicitly, or does not
    // start. The default is loopback http, so a process that never sets
    // CORS_ORIGINS would already be refused by the two rules below — but it
    // would be refused for the incidental reason that the DEFAULT is loopback,
    // with a message about TLS, and the operator's actual mistake (they never
    // set the variable) would be left to be inferred. So that case is named.
    // Only a process that SERVES HTTP has a browser allowlist: the worker and
    // the reconciler create an application context with no HTTP server
    // (`main.ts`), so `enableCors` is never called for them and demanding
    // origins of them would be a requirement with no subject — the same
    // reasoning the blocks above already apply to those modes' credentials.
    //
    // The condition NAMES THE HTTP MODES rather than excluding the other two,
    // and that is not a stylistic choice. `scripts/phase2-s8-gate.ts` holds a
    // structural law (§8, `s8-process`) that refuses this file if the text
    // `mode === 'reconciler'` appears anywhere AFTER the production gate
    // above: it is how that law detects a reconciler secret refusal that has
    // been made production-only. Written the other way, this CORS requirement
    // — which refuses no secret and says nothing about the reconciler — turns
    // that law red. Measured: `npm run gate:phase2:s8` EXIT 1 with
    // `FAIL [s8-process] config.ts refuses the other processes' secrets only
    // in production`, and EXIT 0 as written here. The positive form is also
    // the more honest one: the subject of the rule is a process that serves
    // browsers, so the rule should say so.
    const servesBrowsers = mode === 'merchant-api' || mode === 'platform-api' || mode === 'all';
    if (servesBrowsers) {
      if (c.CORS_ORIGINS === DEV_CORS_ORIGINS) {
        fail(
          'CORS_ORIGINS',
          `production requires an explicit browser allowlist: CORS_ORIGINS is still the development default ${JSON.stringify(DEV_CORS_ORIGINS)} (comma-separated https origins, e.g. https://app.example.com)`,
        );
      } else {
        for (const origin of parseCorsOrigins(c.CORS_ORIGINS)) {
          // Already reported by the all-environment pass above; `new URL`
          // inside the production check would throw on it rather than explain
          // it.
          if (corsOriginProblem(origin) !== null) continue;
          const problem = productionCorsOriginProblem(origin);
          if (problem !== null) fail('CORS_ORIGINS', problem);
        }
      }
    }
    // §10 (Stabilization): PROCESS_MODE=all is a dev/test convenience ONLY —
    // production must deploy the separated runtimes.
    if (mode === 'all') fail('PROCESS_MODE', 'PROCESS_MODE=all is forbidden in production (dev/test only)');
    // TD-19 review M-1: the legacy proxy mode trusts whatever socket peer
    // connects as "the one proxy", so a caller that reaches the API directly
    // chooses its own address — and with it a fresh allowance of every
    // per-client limit. A deployment names its proxies instead.
    if (c.TRUST_PROXY === 'true') {
      fail(
        'TRUST_PROXY',
        "TRUST_PROXY=true is refused in production: it lets a caller choose its client address with X-Forwarded-For; list the deployment's proxies in TRUSTED_PROXIES",
      );
    }
    if (mode !== 'worker' && mode !== 'reconciler') {
      if (!c.JWT_SECRET && !c.JWT_KEYS) fail('JWT_SECRET', `${mode} requires JWT_SECRET or JWT_KEYS`);
    }
    if (mode === 'all' || mode === 'merchant-api') {
      // Directive §17: the platform process has no merchant (app-role) pool.
      if (!c.APP_DATABASE_URL) fail('APP_DATABASE_URL', `${mode} requires the app DB URL (daftar_app role)`);
    }
    if (mode === 'worker') {
      for (const n of [
        'APP_DATABASE_URL',
        'PLATFORM_DATABASE_URL',
        'IDENTITY_DATABASE_URL',
        'RESOLVER_DATABASE_URL',
        'PROVISIONER_DATABASE_URL',
        'PROVISIONING_ASSERTION_KEY',
        'ACCOUNTING_ASSERTION_KEY',
        'INVENTORY_ASSERTION_KEY',
        'CREDENTIAL_KMS_ENDPOINT',
      ] as const) {
        if (c[n]) fail(n, 'must NOT be set in PROCESS_MODE=worker (worker receives worker DB + key ring + SMTP only)');
      }
    }

    // ── §XXV–XXIX: per-mode SECRET ENVIRONMENT SEPARATION ────────────────
    // A process must not even RECEIVE secrets outside its authority.
    const forbid = (
      name:
        | 'APP_DATABASE_URL'
        | 'PLATFORM_DATABASE_URL'
        | 'WORKER_DATABASE_URL'
        | 'PROVISIONER_DATABASE_URL'
        | 'PROVISIONING_ASSERTION_KEY'
        | 'ACCOUNTING_ASSERTION_KEY'
        | 'INVENTORY_ASSERTION_KEY'
        | 'CREDENTIAL_PAYLOAD_KEY'
        | 'CREDENTIAL_PAYLOAD_KEYS'
        | 'SMTP_URL',
      why: string,
    ): void => {
      if (c[name]) fail(name, `must NOT be set in PROCESS_MODE=${mode} (${why})`);
    };
    if (mode === 'merchant-api') {
      forbid('PLATFORM_DATABASE_URL', 'merchant API has no platform authority');
      forbid('WORKER_DATABASE_URL', 'merchant API has no worker authority');
      forbid('CREDENTIAL_PAYLOAD_KEY', 'decryption keys belong to the worker process');
      forbid('CREDENTIAL_PAYLOAD_KEYS', 'decryption keys belong to the worker process');
      forbid('SMTP_URL', 'delivery is the worker process');
    }
    if (mode === 'platform-api') {
      // TD-14 (Phase 3 corrective §13): the platform process opens no app
      // pool (`Database` owns it only in merchant-api and all), so the
      // merchant credential is one it cannot use. Beside the platform's
      // key-install authority it would complete a signing authority in one
      // environment (install a key, then act as daftar_app): refused, not
      // silently ignored.
      forbid('APP_DATABASE_URL', 'the platform process has no merchant (daftar_app) authority');
      forbid('WORKER_DATABASE_URL', 'platform API has no worker authority');
      forbid('PROVISIONER_DATABASE_URL', 'provisioning is a merchant-surface boundary');
      forbid('PROVISIONING_ASSERTION_KEY', 'only the merchant API mints provisioning assertions');
      // §19/§20: platform administration is not financial authority. A
      // platform credential may install and retire accounting keys; holding
      // the signing secret would let it mint postings.
      forbid('ACCOUNTING_ASSERTION_KEY', 'only the merchant API mints accounting assertions');
      // P3-AL-55 §C: the same rule for the inventory command key. The
      // platform may install and retire inventory keys; holding the signing
      // secret would let it mint an inventory command for any business.
      forbid('INVENTORY_ASSERTION_KEY', 'only the merchant API mints inventory assertions');
      forbid('CREDENTIAL_PAYLOAD_KEY', 'no worker credential payload authority');
      forbid('CREDENTIAL_PAYLOAD_KEYS', 'no worker credential payload authority');
      forbid('SMTP_URL', 'delivery is the worker process');
    }

    // ── per-mode REQUIRED configuration ──────────────────────────────────
    if (mode === 'all' || mode === 'platform-api') {
      if (!c.PLATFORM_DATABASE_URL) {
        fail('PLATFORM_DATABASE_URL', `${mode} requires the platform DB URL (daftar_platform role)`);
      } else if (c.PLATFORM_DATABASE_URL === c.APP_DATABASE_URL) {
        fail('PLATFORM_DATABASE_URL', 'must be a distinct role from APP_DATABASE_URL (privilege separation)');
      }
    }
    if (mode === 'all' || mode === 'worker') {
      if (!c.WORKER_DATABASE_URL) {
        fail('WORKER_DATABASE_URL', `${mode} requires the worker DB URL (daftar_worker role)`);
      }
      if (!c.CREDENTIAL_PAYLOAD_KEY && !c.CREDENTIAL_PAYLOAD_KEYS) {
        fail(
          'CREDENTIAL_PAYLOAD_KEYS',
          'production requires CREDENTIAL_PAYLOAD_KEYS (JSON key ring, base64 32-byte AES-256-GCM keys, KMS-managed) or legacy CREDENTIAL_PAYLOAD_KEY. The dev/test key is forbidden in production.',
        );
      }
    }
    if (mode === 'all' || mode === 'merchant-api' || mode === 'platform-api') {
      // HTTP surfaces
      if (!c.REDIS_URL) {
        fail('REDIS_URL', 'production requires REDIS_URL (memory rate limiter is dev-only)');
      }
      if (!c.IDENTITY_DATABASE_URL) {
        fail('IDENTITY_DATABASE_URL', `production requires the identity DB URL (daftar_identity role)`);
      } else if (c.IDENTITY_DATABASE_URL === c.APP_DATABASE_URL || c.IDENTITY_DATABASE_URL === c.PLATFORM_DATABASE_URL) {
        fail('IDENTITY_DATABASE_URL', 'must be distinct from APP_DATABASE_URL and PLATFORM_DATABASE_URL (auth credentials ≠ platform admin credentials)');
      }
    }
    if (mode === 'merchant-api' || mode === 'platform-api') {
      // Part C / Directive §24: HTTP runtimes encrypt (password-reset and
      // invitation enqueue) via a KMS-style provider only — they must never
      // hold credential key material (encrypt OR decrypt) in production.
      if (!c.CREDENTIAL_KMS_ENDPOINT) {
        fail(
          'CREDENTIAL_KMS_ENDPOINT',
          `production ${mode} runtime requires a KMS-style credential encrypt provider (local/DEV keys are structurally forbidden)`,
        );
      } else {
        if (!/^https:\/\//i.test(c.CREDENTIAL_KMS_ENDPOINT)) {
          fail('CREDENTIAL_KMS_ENDPOINT', 'production requires an https:// KMS endpoint (credential plaintext never travels over plaintext http)');
        }
        if (!c.CREDENTIAL_KMS_TOKEN) {
          fail('CREDENTIAL_KMS_TOKEN', 'production requires CREDENTIAL_KMS_TOKEN (authenticated KMS bridge; unauthenticated endpoints are forbidden)');
        }
      }
    }
    if (mode === 'all' || mode === 'merchant-api') {
      if (!c.RESOLVER_DATABASE_URL) {
        fail('RESOLVER_DATABASE_URL', 'production requires the membership-resolver DB URL (daftar_resolver role)');
      }
      if (!c.PROVISIONER_DATABASE_URL) {
        fail('PROVISIONER_DATABASE_URL', 'production requires the provisioning DB URL (daftar_provisioner role)');
      } else if (c.PROVISIONER_DATABASE_URL === c.APP_DATABASE_URL || c.PROVISIONER_DATABASE_URL === c.PLATFORM_DATABASE_URL) {
        fail('PROVISIONER_DATABASE_URL', 'must be a distinct role from APP/PLATFORM (least-privilege provisioning boundary)');
      }
      if (!c.PROVISIONING_ASSERTION_KEY) {
        fail('PROVISIONING_ASSERTION_KEY', 'production provisioning requires the assertion HMAC key (base64 ≥32 bytes) installed in the database (0038)');
      } else if (Buffer.from(c.PROVISIONING_ASSERTION_KEY, 'base64').length < 32) {
        fail('PROVISIONING_ASSERTION_KEY', 'must be base64 of at least 32 bytes');
      }
      // ── P2-S3 §19/§20: the accounting signing key ──────────────────────
      if (!c.ACCOUNTING_ASSERTION_KEY) {
        fail('ACCOUNTING_ASSERTION_KEY', 'production posting requires the accounting assertion HMAC key (base64 ≥32 bytes) installed in the database (0044)');
      } else if (Buffer.from(c.ACCOUNTING_ASSERTION_KEY, 'base64').length < 32) {
        fail('ACCOUNTING_ASSERTION_KEY', 'must be base64 of at least 32 bytes');
      } else if (
        c.PROVISIONING_ASSERTION_KEY &&
        hmacKeysEquivalent(Buffer.from(c.ACCOUNTING_ASSERTION_KEY, 'base64'), Buffer.from(c.PROVISIONING_ASSERTION_KEY, 'base64'))
      ) {
        // Compared as the EFFECTIVE HMAC-SHA-256 KEY of the decoded bytes
        // (P3-S8 A-19, TD-12), not as strings and not as raw bytes: two base64
        // spellings of one secret are one secret, and `K` and `K‖0x00` are one
        // HMAC-SHA-256 key. Sharing either would mean a single compromise
        // reaches both provisioning and the ledger.
        fail('ACCOUNTING_ASSERTION_KEY', 'must not be the same secret as PROVISIONING_ASSERTION_KEY (separate domains, rotated independently)');
      }
      // ── P3-AL-55 §C: the inventory command signing key ─────────────────
      if (!c.INVENTORY_ASSERTION_KEY) {
        fail('INVENTORY_ASSERTION_KEY', 'production inventory commands require the inventory assertion HMAC key (base64 ≥32 bytes) installed in the database');
      } else {
        const inventory = Buffer.from(c.INVENTORY_ASSERTION_KEY, 'base64');
        if (inventory.length < 32) {
          fail('INVENTORY_ASSERTION_KEY', 'must be base64 of at least 32 bytes');
        } else {
          // Compared as the EFFECTIVE HMAC-SHA-256 KEY of the decoded bytes,
          // never as strings and not even as raw bytes: two base64 spellings
          // of one secret are one secret, `K` and `K‖0x00` are one HMAC key,
          // and different variable names are not separation. Either
          // equivalence would let a single compromise reach inventory
          // authority and provisioning or the ledger.
          if (c.PROVISIONING_ASSERTION_KEY && hmacKeysEquivalent(inventory, Buffer.from(c.PROVISIONING_ASSERTION_KEY, 'base64'))) {
            fail('INVENTORY_ASSERTION_KEY', 'must not be the same secret as PROVISIONING_ASSERTION_KEY (separate domains, rotated independently)');
          }
          if (c.ACCOUNTING_ASSERTION_KEY && hmacKeysEquivalent(inventory, Buffer.from(c.ACCOUNTING_ASSERTION_KEY, 'base64'))) {
            fail('INVENTORY_ASSERTION_KEY', 'must not be the same secret as ACCOUNTING_ASSERTION_KEY (separate domains, rotated independently)');
          }
        }
      }
      if (c.MEDIA_STORAGE === 'local') {
        fail('MEDIA_STORAGE', 'production requires MEDIA_STORAGE=s3 (local disk is dev-only)');
      }
      if (c.MEDIA_STORAGE === 's3' && (!c.S3_ENDPOINT || !c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY)) {
        fail('S3_BUCKET', 'S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY are all required for s3 storage');
      }
    }
    if (mode === 'all' || mode === 'worker') {
      if (c.CREDENTIAL_DELIVERY_KIND === 'log') {
        fail('CREDENTIAL_DELIVERY_KIND', 'production requires CREDENTIAL_DELIVERY_KIND=smtp (log delivery is dev-only)');
      }
      if (c.CREDENTIAL_DELIVERY_KIND === 'smtp' && !c.SMTP_URL) {
        fail('SMTP_URL', 'SMTP_URL required when CREDENTIAL_DELIVERY_KIND=smtp');
      }
      if (c.CREDENTIAL_DELIVERY_KIND === 'smtp' && !c.SMTP_FROM) {
        fail('SMTP_FROM', 'SMTP_FROM (sender address) required when CREDENTIAL_DELIVERY_KIND=smtp');
      }
    }
    // §31: ACTUAL PRINCIPALS MUST DIFFER — no aliasing one role's credentials
    // for another pool via misconfiguration. Compared through
    // `dbPrincipalKey`, NOT as raw text: see that function for what is
    // normalized and, more importantly, for what deliberately is not.
    //
    // `PROVISIONER_DATABASE_URL` is a member as of the owner's order of
    // 2026-11-15 («تشديد أمني لا تخفيف»). It was absent, and the manual
    // comparison below it covered only APP and PLATFORM by hand — so a
    // provisioner credential equal to IDENTITY or to RESOLVER started a
    // production merchant-api, measured by loading the config once per pair.
    // The fix is membership and not two more hand comparisons, so that the
    // separation set keeps ONE definition and the next credential added is
    // covered by it.
    // Pinned by `tests-unit/config-provisioner-principal-separation-law.test.ts`;
    // the set's own reach is pinned by
    // `tests-unit/config-duplicate-db-principal-law.test.ts`.
    const urls: Record<string, string | undefined> = {
      APP_DATABASE_URL: c.APP_DATABASE_URL,
      PLATFORM_DATABASE_URL: c.PLATFORM_DATABASE_URL,
      IDENTITY_DATABASE_URL: c.IDENTITY_DATABASE_URL,
      RESOLVER_DATABASE_URL: c.RESOLVER_DATABASE_URL,
      WORKER_DATABASE_URL: c.WORKER_DATABASE_URL,
      RECONCILER_DATABASE_URL: c.RECONCILER_DATABASE_URL,
      PROVISIONER_DATABASE_URL: c.PROVISIONER_DATABASE_URL,
    };
    const seen = new Map<string, string>();
    for (const [name, url] of Object.entries(urls)) {
      if (!url) continue;
      const key = dbPrincipalKey(url);
      const prior = seen.get(key);
      if (prior) fail(name, `duplicates ${prior} — every DB principal must use distinct credentials`);
      seen.set(key, name);
    }
  });

/**
 * C1.5 — THE MIGRATION THIS BUILD REQUIRES.
 *
 * The highest migration the shipped code assumes is present. It is a
 * CONSTANT and not a count: counting rows in `schema_migrations` would answer
 * «how many» when the question is «which», and a database that had 87
 * migrations of some other lineage would satisfy a count.
 *
 * It is pinned here rather than read from `infrastructure/database/migrations`
 * at run time because a deployed API does not ship the migration directory —
 * a guard that globbed a folder absent in production would fail open exactly
 * where it is needed. `schemaFloor` keeps the constant honest: it is asserted
 * against the shipped migration set by a test, so this cannot quietly fall
 * behind the DDL the code was written against.
 */
export const REQUIRED_SCHEMA_MIGRATION = '0086_phase4_rls_quals_once_per_query.sql';

/**
 * The ordinal of a migration file name — `0084_…sql` → `84`.
 *
 * The comparison is on the ORDINAL and not on the string. Lexicographic order
 * happens to agree while every prefix is four digits, and agreeing by accident
 * is not the same as being right: the day a fifth digit arrives, `'10000_…' <
 * '0999_…'` would read a newer database as older and the guard would refuse a
 * correct deployment. A name without a leading ordinal is not a migration this
 * guard can place, and it returns `null` rather than guessing.
 */
export function migrationOrdinal(name: string): number | null {
  const m = /^(\d+)_/.exec(name);
  if (m?.[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The ordinal the schema floor gate COMPARES AGAINST where it can read the
 * migration ledger.
 *
 * It is deliberately not described as «the ordinal this build refuses to start
 * below», which is what this comment used to say and what is not true on a
 * real deployment: the API's own principal cannot read `schema_migrations`
 * there, so the ordinal half of the gate does not run and nothing refuses on
 * version. What protects that case is the gate's surface half, which pins the
 * money-read shapes instead — a different and narrower guarantee. See
 * `assertSchemaFloor` in `app/runtime.ts`.
 */
export function schemaFloor(): number {
  const n = migrationOrdinal(REQUIRED_SCHEMA_MIGRATION);
  if (n === null) throw new Error(`REQUIRED_SCHEMA_MIGRATION ${JSON.stringify(REQUIRED_SCHEMA_MIGRATION)} has no leading ordinal`);
  return n;
}

export type AppConfig = z.infer<typeof EnvSchema> & { isTest: boolean; isProd: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration (fails fast at startup): ${issues}`);
  }
  const c = parsed.data;
  return { ...c, isTest: c.NODE_ENV === 'test', isProd: c.NODE_ENV === 'production' };
}
