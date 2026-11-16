import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseCorsOrigins } from '../apps/api/src/config';

/**
 * REL-10: `CORS_ORIGINS` had a development default and no claim of any kind on
 * it.
 *
 * Measured on `origin/main` @ `c079a2df`, before this guard existed:
 * `apps/api/src/config.ts:114` was `CORS_ORIGINS: z.string().default('http://
 * localhost:3001')`, `apps/api/src/main.ts:90` passed
 * `config.CORS_ORIGINS.split(',').map((o) => o.trim())` straight to
 * `app.enableCors`, and a probe for `CORS` across `config.ts` returned exactly
 * one hit — line 114 itself — against a positive control of 37 `fail(` calls in
 * the same file. So the absence of a production claim was a measurement.
 *
 * WHAT IS REFUSED, AND WHERE
 *
 * In EVERY environment, because each of these is a broken value rather than a
 * relaxed one:
 *   - an empty entry (`'a,,b'`, `''`, `'  '`) — `enableCors` would receive `''`
 *     as a member of its allowlist, which matches no browser Origin
 *   - `*` — `enableCors` is given an ARRAY, and `cors` compares array members
 *     for equality, so `'*'` in a list does not mean "any origin": it means an
 *     origin literally spelled `*`, which no browser ever sends. Accepting it
 *     is accepting a value that silently matches nothing while reading, to a
 *     operator, as "wide open".
 *   - anything that is not an absolute origin: a trailing slash, a path, a
 *     query, a fragment, embedded credentials, or a bare host. A browser's
 *     `Origin` header is scheme + host + optional port and nothing else, so
 *     `https://app.example.com/` never matches and fails SILENTLY — the worst
 *     failure mode a deployment can have.
 *
 * In PRODUCTION only, because dev needs the opposite:
 *   - a non-https scheme
 *   - a loopback or `localhost` host
 *
 * Together those two mean the stated requirement holds as a CONSEQUENCE and not
 * as a separate rule: a production process that never sets `CORS_ORIGINS` gets
 * the `http://localhost:3001` default, which is both non-https and loopback, so
 * it does not start. That case is asserted by name below rather than left to be
 * inferred.
 */

const KMS = {
  CREDENTIAL_KMS_ENDPOINT: 'https://kms-bridge.internal.example/encrypt',
  CREDENTIAL_KMS_TOKEN: 'kms-bridge-token-with-at-least-32-characters!!',
};

/** A production merchant process, mirroring `tests/security/p3c-legacy-trust-proxy.test.ts`. */
const MERCHANT_PROD: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PROCESS_MODE: 'merchant-api',
  APP_DATABASE_URL: 'postgresql://daftar_app:x@db/daftar',
  IDENTITY_DATABASE_URL: 'postgresql://daftar_identity:x@db/daftar',
  RESOLVER_DATABASE_URL: 'postgresql://daftar_resolver:x@db/daftar',
  PROVISIONER_DATABASE_URL: 'postgresql://daftar_provisioner:x@db/daftar',
  PROVISIONING_ASSERTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  ACCOUNTING_ASSERTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  INVENTORY_ASSERTION_KEY: Buffer.alloc(32, 13).toString('base64'),
  JWT_SECRET: 'production-secret-with-at-least-32-characters',
  MEDIA_STORAGE: 's3',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_BUCKET: 'daftar-media',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
  REDIS_URL: 'redis://redis:6379',
  TRUSTED_PROXIES: '10.0.0.0/8',
  ...KMS,
};

const GOOD = 'https://app.example.com';
const DEV_DEFAULT = 'http://localhost:3001';
const CORS = /CORS_ORIGINS:/;

describe('REL-10: production will not start without an explicit browser allowlist', () => {
  it('POSITIVE CONTROL: a production process with a real https allowlist starts', () => {
    // Without this, every `toThrow` below could be passing for an unrelated
    // reason — a missing key, a refused mode — and prove nothing about CORS.
    expect(() => loadConfig({ ...MERCHANT_PROD, CORS_ORIGINS: GOOD })).not.toThrow();
    expect(() => loadConfig({ ...MERCHANT_PROD, CORS_ORIGINS: `${GOOD},https://admin.example.com:8443` })).not.toThrow();
  });

  it('DENY: a production process that never sets CORS_ORIGINS does not start', () => {
    // The requirement as the owner stated it: the list missing is a refusal to
    // boot, not a silent fallback to the development default.
    expect(() => loadConfig(MERCHANT_PROD)).toThrow(CORS);
    // And it must refuse FOR THAT REASON. `/CORS_ORIGINS:/` alone is matched by
    // the https and the loopback refusals too, so without pinning this sentence
    // the whole "still the development default" branch could be deleted and
    // this suite would stay green — the one branch the requirement names by
    // name would be the one nothing holds. (REL-10 review, finding 2.)
    expect(() => loadConfig(MERCHANT_PROD)).toThrow(/still the development default/);
    expect(() => loadConfig({ ...MERCHANT_PROD, CORS_ORIGINS: DEV_DEFAULT })).toThrow(/still the development default/);
  });

  it.each([
    ['the development default', 'http://localhost:3001'],
    ['plain http', 'http://app.example.com'],
    ['a loopback address', 'https://127.0.0.1:3001'],
    ['localhost over https', 'https://localhost:3001'],
    ['one good origin and one loopback', `${GOOD},http://localhost:3001`],
    // REL-10 review, finding 3: the first form of the rule named four
    // spellings and read as "no loopback". These are the spellings it missed.
    ['another address inside 127.0.0.0/8', 'https://127.0.0.2'],
    ['a short-form loopback the parser expands', 'https://127.1'],
    ['the all-interfaces address', 'https://0.0.0.0'],
    ['the IPv6 loopback', 'https://[::1]'],
    ['IPv4-mapped loopback, as the parser writes it', 'https://[::ffff:7f00:1]'],
    ['the IPv6 all-interfaces address', 'https://[::]'],
  ])('DENY: production refuses %s', (_why, value) => {
    expect(() => loadConfig({ ...MERCHANT_PROD, CORS_ORIGINS: value })).toThrow(CORS);
  });

  it('ALLOW: development and test keep the loopback default', () => {
    // NEGATIVE CONTROL for the production gate: if these threw, the gate would
    // not be a production gate but a new global requirement.
    expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3001,http://127.0.0.1:3002' })).not.toThrow();
  });
});

describe('REL-10: a value that matches nothing is refused in every environment', () => {
  it.each([
    ['a wildcard', '*'],
    ['a wildcard among real origins', `${GOOD},*`],
    ['an empty list', ''],
    ['whitespace only', '   '],
    ['an empty entry between two origins', `${GOOD},,https://admin.example.com`],
    ['a trailing slash', `${GOOD}/`],
    ['a path', `${GOOD}/api`],
    ['a query', `${GOOD}?x=1`],
    ['a fragment', `${GOOD}#x`],
    ['embedded credentials', 'https://user:pw@app.example.com'],
    ['a bare host', 'app.example.com'],
  ])('DENY: %s is refused in production, development and test', (_why, value) => {
    for (const env of ['production', 'development', 'test'] as const) {
      const base = env === 'production' ? MERCHANT_PROD : { NODE_ENV: env };
      expect(() => loadConfig({ ...base, NODE_ENV: env, CORS_ORIGINS: value })).toThrow(CORS);
    }
  });
});

describe('REL-10: the gate and the running server parse the same way', () => {
  it('parseCorsOrigins is the one parse, and it is what main.ts hands to enableCors', () => {
    // `main.ts` used to do its own `.split(',').map(trim)`. Two parses of one
    // value is how a gate and a server come to disagree, so there is now one
    // exported function and both call it.
    expect(parseCorsOrigins(`${GOOD}, https://admin.example.com:8443 `)).toEqual([GOOD, 'https://admin.example.com:8443']);
    expect(parseCorsOrigins('http://localhost:3001')).toEqual(['http://localhost:3001']);
  });

  it('main.ts calls that function instead of splitting the value itself', () => {
    // A gate that validates one parse while the server performs another is not
    // a gate. This is a source-text law, which is what this lane is for.
    const main = readFileSync(join(resolve(__dirname, '..'), 'apps/api/src/main.ts'), 'utf8');
    // Positive control: the probe is reading the bootstrap it thinks it is.
    expect(main).toContain('app.enableCors(');
    expect(main).toContain('parseCorsOrigins(config.CORS_ORIGINS)');
    expect(main).not.toContain('CORS_ORIGINS.split(');
  });

  it('the allowlist does not also hand out credentials', () => {
    // The allowlist decides WHICH origins may call. `credentials` decides
    // whether the browser attaches cookies and `Authorization` to those calls
    // and lets the page read the response. Turning it on makes every origin on
    // the list a session-bearing caller, and this API authenticates with a
    // bearer token the front end holds — it needs no cookie from a browser to
    // be sent automatically.
    //
    // It is `false` in the bootstrap and nothing held it there, so a later
    // edit could flip it in one word with no test going red. Measured as red
    // before this law: with `credentials: true` in `main.ts` this assertion
    // fails and the rest of the suite stays green, which is exactly the hole
    // it closes.
    const main = readFileSync(join(resolve(__dirname, '..'), 'apps/api/src/main.ts'), 'utf8');
    // Positive control first: the probe is reading a bootstrap that configures
    // CORS at all, so a passing assertion below cannot be a missing file.
    expect(main).toContain('app.enableCors(');

    // The claim is about the ARGUMENT of that call, not about the file's text.
    // Read over the whole file, a comment mentioning `credentials: false`
    // elsewhere would have kept this green above a real call passing a value
    // from config — a false green, which is the one direction a security law
    // must never fail in. (Review of this PR, finding 1.)
    const call = /app\.enableCors\(([\s\S]*?)\n\s*\}\);/.exec(main);
    expect(call, 'the enableCors call could not be located to read its argument').not.toBeNull();
    const raw = call?.[1] ?? '';
    expect(raw).not.toBe('');

    // COMMENTS ARE STRIPPED BEFORE THE CLAIM. Narrowing to the argument shrank
    // the false green; it did not close it. Two routes survived and were
    // measured: a comment INSIDE the options object saying `credentials: false`
    // above a value read from the environment, and — if the call is ever
    // reformatted onto one line, losing the `\n });` this capture ends at — an
    // over-capture running to the next `});` in the file, where any later
    // mention of `credentials: false` in a comment would do. Stripping closes
    // those TWO, because only code can satisfy the claim now.
    // (Second review of this PR, finding 2.)
    //
    // "Those two" is the whole claim, and the narrowing is deliberate. An
    // earlier wording here read as though the class of false greens were
    // closed. It is not. What is closed is the set of routes by which THIS
    // PROBE could read a relaxation as `credentials: false` — and the probe is
    // a text reader. A guard gap of a different kind is recorded separately
    // and is NOT closed by anything in this file: four routes by which a
    // request can reach the CORS layer with an origin the allowlist never
    // granted. Those live in `.local-context/OWNER_QUEUE_AR.md` with their
    // class and their falsifiers, and closing them needs an assertion on a
    // real `OPTIONS` response, which needs a booting app — the integration
    // lane, NOT_RUN here and never to be reported as PASS from this file.
    // A law over the bootstrap's text cannot hold the behaviour of a request.
    const options = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(options).not.toBe('');

    // THE CAPTURE DID NOT RUN PAST THE CALL. Measured, the third review found
    // the one route that stripping left open: reformat `enableCors` onto a
    // single line and the capture, which ends at `\n });`, runs on to the next
    // one in the file, carrying whatever lies between. No character counts are
    // given for the two captures: a pair of figures stood here and did not
    // reproduce when re-measured, and a number whose measurement cannot be
    // repeated is worse than none — it invites the next reader to tune a
    // length bound to it. The direction is what was measured and it holds:
    // the reformatted capture is the LONGER one, and it swallows the lines
    // after the call. These two assertions bound it by STRUCTURE, which the length
    // bound below cannot do here: from the call to the end of the file is only
    // 340 characters, under any length a growing options object could live
    // with. What follows the call is the listen and the log line, so their
    // absence is what proves the capture stopped where the call stops.
    expect(options).not.toContain('app.listen');
    expect(options).not.toContain('logger.');

    // A SECOND `credentials:` KEY IS REFUSED IN THE RAW TEXT TOO, not only
    // after stripping. The review measured the last route that stayed green: a
    // duplicate key whose second — and at runtime winning — occurrence sits on
    // a line carrying `//` inside a string literal such as 'https://ops…', so
    // stripping removed the relaxation along with the rest of that line and
    // left one `false` behind. Counting on the raw text closes it without
    // leaning on `no-dupe-keys` in another gate to catch it for us.
    expect([...raw.matchAll(/credentials\s*:/g)]).toHaveLength(1);

    // The located text really is this call's argument:
    //  - the allowlist parse lives inside it, and nothing else in the file
    //    calls `parseCorsOrigins`;
    //  - and it is SHORT. An absolute bound is the one that can fail: a
    //    successful capture is shorter than the file by construction, so
    //    comparing it to the file's length asserted nothing at all, and the
    //    comment that claimed otherwise was wrong. (Second review, finding 1.)
    expect(options).toContain('parseCorsOrigins');
    expect(options.length).toBeLessThan(400);

    // Exactly one `credentials:` key, so a second mention cannot mask the one
    // that counts.
    expect([...options.matchAll(/credentials\s*:/g)]).toHaveLength(1);
    expect(options).toContain('credentials: false');
    expect(options).not.toContain('credentials: true');

    // AND ONE MORE CONSEQUENCE. The sentence that stood here was WRONG, and
    // the third review measured it: it said reformatting the call onto a
    // single line makes this case fail. It did not — the capture simply ran
    // past the call and stayed GREEN. It fails now, because
    // the two structural assertions above refuse a capture that swallowed the
    // listen and the log line. So the consequence is real only since those
    // were added, and the answer to it is to move this expectation with the
    // reformat — never to widen the pattern until it matches whatever the file
    // now says.
    //
    // AND WHAT THE REVIEW INDEX DOES NOT SAY ABOUT THIS CLAIM. The pull
    // request recorded that `check:phase3:review-index` shows zero change and
    // gave the reason that this file "is already counted in the
    // `apps/api/src/config.ts` row". That reason is incidental, and it hides
    // the load-bearing part. Measured on the merged tree:
    //
    //  - zero change does NOT follow from the file not being NEW. That is how
    //    this bullet first read, and THIS COMMIT FALSIFIED IT: the generator
    //    counts a test as coverage when it IMPORTS a path or merely NAMES it
    //    (`scripts/phase3-review-index.ts:353`), so writing
    //    `scripts/phase3-review-index.ts` into the prose above reached a path
    //    this file had never reached, and that row moved from
    //    `2: tests-unit/release-evidence-path-portability,
    //    security/p3c-review-index` to `3:` with
    //    `tests-unit/rel10-cors-allowlist` added -- one line, the only line,
    //    measured by `npm run index:phase3:review` on this tree.
    //    `check:phase3:review-index` reddened in CI before it was regenerated
    //    (`backend-work`, step 15/45, run `43832930909`: `line 335: stale
    //    row`), and that red was MINE, not a flake.
    //    The rule that survives is narrower: zero change follows from the file
    //    reaching no path it had not already reached -- being old is not
    //    enough, and a sentence of PROSE is enough to move a count.
    //  - and `apps/api/src/main.ts` — the file whose text this case reads, the
    //    subject of the whole claim — has NO row in the index: a search of
    //    `docs/PHASE_3_REVIEW_INDEX.md` for `main.ts` returns nothing, because
    //    rows are built from the indexed history through HEAD and the tree,
    //    not from every source file. So zero change is not evidence that this
    //    law's subject is accounted for. Its subject is not indexed.
    //
    // One instrument note, because it nearly produced a false finding of my
    // own: the index prints only the first few covering tests per row and then
    // `(+21)`. Grepping the printed page for a test name therefore proves
    // nothing about membership — the page is capped, and the cap says so.
    //
    // CONSEQUENCE, named here because whoever it reddens reads this file and
    // not a card: moving these options into a constant or another module makes
    // this case fail for a reason that is not a security relaxation. That is
    // failing CLOSED, and it is deliberate — the claim is that the bootstrap's
    // own call carries `credentials: false`. Whoever moves the options moves
    // this expectation with them, in the same commit.
  });
});
