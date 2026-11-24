import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/api/src/config';

/**
 * §31 of `apps/api/src/config.ts`: ACTUAL PRINCIPALS MUST DIFFER — two database
 * roles may not be the same credential. NOTHING asserted it, in any lane.
 *
 * WHY THIS FILE EXISTS, MEASURED RATHER THAN READ. `DR-145` applies to every
 * guard over a file L4 owns, and a guard is proved by PLANTING, not by reading
 * the test that looks like it covers it. Four missing-refusal seeds went into
 * `config.ts` one at a time, with the whole unit lane run against each and the
 * tree restored byte for byte after:
 *
 *   AC  `TRUST_PROXY=true` no longer refused in production  -> unit lane GREEN
 *   AD  accounting key may equal the provisioning key       -> unit lane GREEN
 *   AE  provisioning key may be under 32 bytes              -> unit lane GREEN
 *   AF  two DB principals may share one credential          -> unit lane GREEN
 *
 * THE TREE EACH NUMBER BELONGS TO, since a count that names no tree cannot be
 * reproduced (review of this PR, finding 1, which was right): those four seeds
 * ran in the `l4-security-gates` worktree on `sec/rel11-secret-scan-scope-law`,
 * whose unit lane is 29 files / 246 cases — that branch carries its own law
 * files.
 *
 * NO LANE TOTAL FOR *THIS* BRANCH IS QUOTED HERE, deliberately, and the
 * omission is the lesson. An earlier version said "29 files / 238 cases with
 * this file"; the arms added further down made it 241, and the number went
 * stale inside the very commit whose subject line was "drops a false count"
 * (the second review of this PR caught it, and it was right). A total that
 * every new arm falsifies is a trap, not evidence — and it was never the
 * evidence anyway: what carries the claim below is the GREP ZERO, which no
 * arm of this file can change.
 *
 * Four greens are not four gaps, and saying so would be the overstatement this
 * file exists to avoid. Three of them ARE covered — by laws that cannot run
 * outside CI, since their lanes boot a database (`ensurePostgres`, so `NOT_RUN`
 * on a developer machine, never `PASS`):
 *
 *   AC  `tests/security/p3c-legacy-trust-proxy.test.ts` pins the refusal's own
 *       message text, in its `REFUSED` constant
 *       (`/TRUST_PROXY: TRUST_PROXY=true is refused in production/`)
 *   AD  `tests/integration/assertion-key-separation.test.ts`, in the arm that
 *       expects `/ACCOUNTING_ASSERTION_KEY must not be the same secret as
 *       PROVISIONING_ASSERTION_KEY/`
 *   AE  `tests/integration/production-providers.test.ts` plants an 8-byte key
 *       (`Buffer.alloc(8, 1)` on `PROVISIONING_ASSERTION_KEY`) and expects
 *       `/at least 32 bytes/`
 *
 * AF is the one with NO law anywhere: `grep` for its message, for "every DB
 * principal", and for the duplicate claim over `tests/**`, `tests-unit/**` and
 * `packages/**` returns nothing. The same probe finds the other three by name,
 * so the zero is a measurement and not a blind spot (`RULE-11`).
 *
 * WHY IT IS NOT COSMETIC. The whole point of these roles is that a compromise
 * of one does not reach the others: the resolver reads tenancy, the app reads a
 * business's ledger, identity holds auth credentials. Alias two of them to one
 * credential by a copy-paste in a deployment's environment and every one of
 * those boundaries is gone — while the process starts, serves, and reports
 * nothing. That is a silent collapse of privilege separation, which is the
 * class of defect a startup refusal exists for.
 *
 * HOW MUCH OF §31 THIS FILE REACHES, counted rather than implied.
 *
 * A previous version of this paragraph claimed that ELEVEN of the fifteen
 * pairs "cannot be built in any fixture, because a mode refusal fires first
 * and the process never reaches §31 — measured". **That was false, and the
 * contradiction was already in this file**, at the DUP-B arms below: `fail`
 * ACCUMULATES and does not throw at the first defect, so a mode refusal does
 * not stop §31 from running. Measured, in a production `merchant-api`:
 *
 *   WORKER_DATABASE_URL = APP_DATABASE_URL     -> "must NOT be set in
 *       PROCESS_MODE=merchant-api (merchant API has no worker authority);
 *       WORKER_DATABASE_URL: duplicates APP_DATABASE_URL — every DB principal
 *       must use distinct credentials"      ← BOTH clauses, in one message
 *   RECONCILER_DATABASE_URL = APP_DATABASE_URL -> both, likewise
 *   PLATFORM_DATABASE_URL  = APP_DATABASE_URL  -> both, likewise
 *
 * So all fifteen pairs are constructible, every one of them in `merchant-api`
 * alone, and the earlier count was an artefact of reading the code's order
 * instead of running it.
 *
 * WHAT THIS FILE PINS, and the criterion it is chosen by: not all fifteen
 * pairs — that would be bulk, not coverage — but at least one pair for EVERY
 * MEMBER of the §31 map. With the DUP-E arms added for the three names above,
 * all six members (`APP`, `PLATFORM`, `IDENTITY`, `RESOLVER`, `WORKER`,
 * `RECONCILER`) appear in a pinned pair. **Shrinking the map therefore reddens
 * this file**, which is the property the old paragraph gave away: under it,
 * `WORKER` and `RECONCILER` could have been dropped from the separation set
 * with this law still green.
 *
 * NO SECRET HERE: every URL is an obvious placeholder with no authority
 * anywhere outside this file, and every key is `Buffer.alloc`-filled — the
 * pattern `tests-unit/config-production-refusals.test.ts` already uses.
 *
 * WHO MOVES THIS EXPECTATION. The set of principals below changes in the SAME
 * commit that changes the `urls` map in `config.ts` §31, by the owner of
 * `config.ts` (L4), and only when a principal is deliberately taken out of the
 * separation set. A lane that finds this file red without having decided such a
 * removal has found a defect, not a stale expectation.
 */

/**
 * A merchant API that is otherwise complete and correct, in production.
 *
 * Repeated from `tests-unit/config-production-refusals.test.ts` deliberately,
 * for the reason that file states: a shared fixture would tie two cards'
 * suites together, so that a variable one card needs would silently change
 * what the other measures.
 */
const MERCHANT_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar',
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

/**
 * A platform API that is otherwise complete and correct, in production. It
 * carries no app pool, no provisioner and no assertion keys, because a platform
 * surface is REFUSED those (TD-14, §8) — which is why the platform pair needs
 * its own fixture rather than a tweak of the merchant one.
 */
const PLATFORM_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'platform-api',
  PLATFORM_DATABASE_URL: 'postgresql://daftar_platform:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  REDIS_URL: 'redis://redis:6379',
  CREDENTIAL_KMS_ENDPOINT: 'https://kms.example.com/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
  CORS_ORIGINS: 'https://admin.example.com',
};

const DUP = /duplicates .* — every DB principal must use distinct credentials/;

/**
 * Read a §31 refusal by the PAIR it names, in EITHER direction, selecting the
 * clause by the `'; '` the loader joins problems with.
 *
 * `fail()` is called on the key the loop reaches LATER, naming the one it saw
 * EARLIER, so the direction is decided by the ORDER of
 * `DB_PRINCIPAL_URL_KEYS`. Matching one direction made these arms positional:
 * MEASURED, swapping two members of that list — membership identical, refusal
 * working perfectly — reddened an arm here whose name is about §31's REACH and
 * says nothing about order. The order is pinned by the arm that names the list,
 * in the provisioner law; these read the pair. (Third review of this cart,
 * finding 2 — and the same defect as #111's note, committed again by me while
 * closing it.)
 */
function expectDuplicatePair(env: NodeJS.ProcessEnv, a: string, b: string): void {
  let message = '';
  try {
    loadConfig(env);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  expect(message, 'the configuration started, so there is no refusal to read').not.toBe('');
  // THE ONE CLAUSE THAT NAMES BOTH, not the join of every §31 clause. Joining
  // them let a CROSS-pair pass when two real pairs were planted (measured),
  // and my first attempt at the fix — a «no third principal» check over the
  // join — was worse than weak: it made a CORRECT pair fail as soon as another
  // correct pair existed, also measured. Exactly one clause must name both
  // keys, which is what «the refusal names this pair» actually means.
  const clauses = message.split('; ').filter((l) => l.includes('every DB principal must use distinct credentials'));
  expect(clauses.length, 'no §31 duplicate clause in the refusal at all').toBeGreaterThan(0);
  const naming = clauses.filter((l) => l.includes(a) && l.includes(b));
  expect(naming, `no single §31 clause names both ${a} and ${b}; the clauses are:\n${clauses.join('\n')}`).toHaveLength(1);
}

describe('§31: two database roles may not be one credential', () => {
  // DUP-0. The positive controls come first, and they are not a formality:
  // without them every refusal below could be a fixture failing for a reason
  // this file is not about, and each would read as a pass.
  it('POSITIVE CONTROL: both fixtures start, with distinct principals', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD })).not.toThrow();
    expect(() => loadConfig({ ...PLATFORM_PROD })).not.toThrow();
  });

  it('the pair reader REFUSES a cross-pair, so «names both» cannot be satisfied by a refusal that names everything', () => {
    // THE HELPER'S OWN STRICTNESS, pinned. With TWO pairs planted the refusal
    // carries TWO §31 clauses — «IDENTITY duplicates APP» and «PROVISIONER
    // duplicates RESOLVER» — and joining them would let a CROSS-pair
    // (IDENTITY with PROVISIONER) pass although it was never refused as a
    // pair. Review of the previous head measured exactly that, and dropping
    // the «no third principal» loop reddened NOTHING, because every other
    // fixture plants a single pair. This arm is what makes that loop live.
    const env = {
      ...MERCHANT_PROD,
      IDENTITY_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL,
      PROVISIONER_DATABASE_URL: MERCHANT_PROD.RESOLVER_DATABASE_URL,
    };
    // both real pairs read correctly
    expectDuplicatePair(env, 'IDENTITY_DATABASE_URL', 'APP_DATABASE_URL');
    expectDuplicatePair(env, 'PROVISIONER_DATABASE_URL', 'RESOLVER_DATABASE_URL');
    // and the cross-pair is REFUSED by the reader itself
    expect(() => expectDuplicatePair(env, 'IDENTITY_DATABASE_URL', 'PROVISIONER_DATABASE_URL')).toThrow();
  });

  // DUP-A. The two pairs §31 holds ALONE. `config.ts` names three role pairs
  // explicitly (platform vs app, identity vs APP/PLATFORM, and provisioner
  // vs APP/PLATFORM — each its own least-privilege clause),
  // and the resolver appears in none of them — so these two pairs measure §31
  // rather than its neighbours.
  it('REFUSES app=resolver and identity=resolver, by §31 alone', () => {
    expectDuplicatePair({ ...MERCHANT_PROD, RESOLVER_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL }, 'RESOLVER_DATABASE_URL', 'APP_DATABASE_URL');
    expectDuplicatePair({ ...MERCHANT_PROD, RESOLVER_DATABASE_URL: MERCHANT_PROD.IDENTITY_DATABASE_URL }, 'RESOLVER_DATABASE_URL', 'IDENTITY_DATABASE_URL');
  });

  // DUP-B. The other two reachable pairs. Each ALSO has a refusal of its own
  // (its own least-privilege clause), and `fail()` accumulates rather than
  // throwing on the first problem,
  // so BOTH clauses appear — measured, not assumed. The point of asserting them
  // here is that §31's clause is present IN ADDITION to the specific one: a §31
  // that had quietly shrunk to the resolver would still satisfy that clause and
  // would leave these two pairs resting on a single comparison.
  it('REFUSES app=identity and platform=identity, with the §31 clause present too', () => {
    const merchantPair = { ...MERCHANT_PROD, IDENTITY_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL };
    expect(() => loadConfig(merchantPair)).toThrow(/must be distinct from APP_DATABASE_URL/);
    expectDuplicatePair(merchantPair, 'IDENTITY_DATABASE_URL', 'APP_DATABASE_URL');

    const platformPair = { ...PLATFORM_PROD, IDENTITY_DATABASE_URL: PLATFORM_PROD.PLATFORM_DATABASE_URL };
    expect(() => loadConfig(platformPair)).toThrow(/must be distinct from APP_DATABASE_URL and PLATFORM_DATABASE_URL/);
    expectDuplicatePair(platformPair, 'IDENTITY_DATABASE_URL', 'PLATFORM_DATABASE_URL');
  });

  // DUP-C. WHAT MAKES THE REFUSAL ACTIONABLE, and nothing more: one name is the
  // SUBJECT of the clause (`X: duplicates Y`), so the operator learns which
  // line of their environment to change rather than merely that something
  // collides.
  //
  // AND IT READS THE PAIR, NOT THE DIRECTION, narrowed by review on the
  // previous head: WHICH of the two becomes the subject follows the order of
  // `DB_PRINCIPAL_URL_KEYS`, so asserting «RESOLVER duplicates APP» literally
  // would redden on a pure REORDER of that frozen list — a change that alters
  // no refusal, since the pair is refused whichever member is read first. The
  // pair itself is read by `expectDuplicatePair`, which is the reader the rest
  // of this file uses; what is added here is the subject MARKER, in either
  // direction.
  //
  // AND IT ASSERTS THE REQUIRED ELEMENTS, NOT THE SENTENCE. My first form of
  // this arm matched the refusal's text literally (`X: duplicates Y`), which
  // makes a legitimate REWORDING of `fail`'s message a false red tomorrow —
  // the same class as a hardcoded count. So the two elements are read apart:
  // the clause names both keys (the reader above), and one of them is its
  // SUBJECT, which in this project's refusals is the name followed by `: `.
  // The verb is not read at all.
  it('one of the colliding pair is the SUBJECT of the §31 clause, in either direction', () => {
    const env = { ...MERCHANT_PROD, RESOLVER_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL };
    expectDuplicatePair(env, 'RESOLVER_DATABASE_URL', 'APP_DATABASE_URL');
    let message = '';
    try {
      loadConfig(env);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    const clause = message.split('; ').find((l) => l.includes('RESOLVER_DATABASE_URL') && l.includes('APP_DATABASE_URL'));
    expect(clause, `no single clause names both keys; the refusal reads:\n${message}`).toBeDefined();
    // NOT `startsWith`: the FIRST clause carries the refusal's own header
    // («Invalid configuration (fails fast at startup): …»), measured — so the
    // marker is read with a word boundary instead of at the start of the
    // clause, which is also why the key names are matched with one.
    const subject = /(^|[^A-Z_])(RESOLVER_DATABASE_URL|APP_DATABASE_URL): /.test(clause ?? '');
    expect(subject, `neither key is the subject of the clause, so the operator is not told which line to change: ${clause ?? ''}`).toBe(true);
    expect(message).toMatch(DUP);
  });

  // DUP-D. THE OTHER FACE OF THE BOUNDARY (`DR-145`): a change §31 is NOT about
  // must not redden this file. The same role with a different password is a
  // different CREDENTIAL on the same host and database — and §31 compares the
  // credential string, so reading it as "no two roles may share a host" would
  // refuse every real single-server deployment. (Review finding 3: the earlier
  // comment here called this "a different principal", which is not what it is.)
  it('NEGATIVE CONTROL: a different credential on the same host and database still starts', () => {
    expect(() => loadConfig({ ...MERCHANT_PROD, RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:y@db/daftar' })).not.toThrow();
  });

  // DUP-E. THE THREE MEMBERS NOTHING HELD. A mode refusal does not stop §31
  // from running, because `fail` accumulates — so the names a production
  // `merchant-api` is forbidden to carry still reach the duplicate check, and
  // their membership of the map is pinnable. Without these arms, `WORKER` and
  // `RECONCILER` could be dropped from the separation set with this file still
  // green, which is exactly what the review found.
  const forbiddenInMerchant: readonly { readonly name: string; readonly mode: RegExp }[] = [
    { name: 'WORKER_DATABASE_URL', mode: /WORKER_DATABASE_URL: must NOT be set in PROCESS_MODE=merchant-api/ },
    { name: 'RECONCILER_DATABASE_URL', mode: /RECONCILER_DATABASE_URL: must NOT be set in PROCESS_MODE=merchant-api/ },
    { name: 'PLATFORM_DATABASE_URL', mode: /PLATFORM_DATABASE_URL: must NOT be set in PROCESS_MODE=merchant-api/ },
  ];

  for (const { name, mode } of forbiddenInMerchant) {
    it(`§31 reaches ${name} even where the mode forbids it, and BOTH clauses appear`, () => {
      const env = { ...MERCHANT_PROD, [name]: MERCHANT_PROD.APP_DATABASE_URL ?? '' };
      // The mode clause: without asserting it, this arm would pass against a
      // loader that had stopped refusing the name in this mode at all.
      expect(() => loadConfig(env)).toThrow(mode);
      // And the §31 clause, which is this file's subject: it is what proves
      // the name is still a member of the separation set.
      expectDuplicatePair(env, name, 'APP_DATABASE_URL');
    });
  }
});

/**
 * THE GAP THIS FILE RECORDED IS CLOSED, IN THIS COMMIT'S OWN BRANCH.
 *
 * An earlier version of this comment said `PROVISIONER_DATABASE_URL` was not
 * a member of the §31 `urls` map, that a provisioner credential equal to the
 * identity or resolver credential was refused by nothing, and that the item
 * sat in L4's queue. It is removed rather than reworded: the owner authorised
 * the refusal on 2026-11-15 as a TIGHTENING (recorded in
 * `.local-context/OWNER_DECISIONS_AR.md`, dated entry, with the order's own
 * words), and `apps/api/src/config.ts` on this branch now carries
 * `PROVISIONER_DATABASE_URL` in that map, with
 * `tests-unit/config-provisioner-principal-separation-law.test.ts` pinning it.
 *
 * It is removed HERE, in the branch that closes it, because a comment that
 * announces its own expiry still needs someone to carry out the expiry: the
 * independent review of #116 measured that nothing else in this pull request's
 * tree touches this file, so left alone the text would have survived on `main`
 * as a claim false by its own terms. A law and the production refusal it needs
 * ship together — and so do a claim and its retraction.
 */
