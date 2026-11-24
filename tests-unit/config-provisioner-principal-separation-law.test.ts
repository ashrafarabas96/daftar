/**
 * THE LAW: the provisioning credential is a PRINCIPAL like any other — a
 * production `merchant-api` does not start when `PROVISIONER_DATABASE_URL`
 * carries the same credential as another reachable principal.
 *
 * Owner's order, 2026-11-15, verbatim: «PROVISIONER_DATABASE_URL: موافق على
 * إضافة الرفض، فهذا تشديد أمني لا تخفيف. ينفّذه L4 باختبار أحمر أولًا: اعتماد
 * يساوي IDENTITY أو RESOLVER يُرفض فلا تبدأ العملية، واعتماد مستقل يُقبل.»
 *
 * ── WHAT WAS MEASURED, AND ON WHICH TREE ────────────────────────────────────
 *
 * The reach was not reasoned about; it was ENUMERATED by loading the config
 * once per pair on `l4/config-duplicate-db-principal` @ `3fcec768` (the tree
 * this branch was cut from, i.e. BEFORE this file's fix), with an otherwise
 * complete and correct production `merchant-api` fixture as the control — and
 * that control STARTED, so a refusal below is the pair's doing and not the
 * fixture's:
 *
 *   APP      = IDENTITY    → REFUSED (the least-privilege APP/PLATFORM clause AND the §31 membership clause, both)
 *   APP      = RESOLVER    → REFUSED (§31 only)
 *   APP      = PROVISIONER → REFUSED (the provisioner's own APP/PLATFORM clause only)
 *   IDENTITY = RESOLVER    → REFUSED (§31 only)
 *   IDENTITY = PROVISIONER → **STARTED**
 *   RESOLVER = PROVISIONER → **STARTED**
 *
 * So of the six pairs of the four credentials a production `merchant-api` can
 * reach — `APP`, `IDENTITY`, `RESOLVER`, `PROVISIONER` — exactly TWO were
 * exposed, and both are the owner's two. The other four were already closed,
 * two of them by §31's duplicate-principal check, whose reach is pinned
 * separately in `tests-unit/config-duplicate-db-principal-law.test.ts`
 * (PR #110, this branch's parent).
 *
 * ── HOW THAT SET OF FOUR IS ARRIVED AT, MECHANISM BY MECHANISM ──────────────
 *
 * The four is not a subset of §31's map; it is that map with one name taken
 * out and another put in, and the two are excluded by DIFFERENT clauses. On
 * the base tree §31's `urls` map holds SIX names — `APP`, `PLATFORM`,
 * `IDENTITY`, `RESOLVER`, `WORKER`, `RECONCILER` — and `PROVISIONER` is not
 * among them, which is this branch's whole subject. Three removals and one
 * addition give the four:
 *
 *   `PLATFORM`, `WORKER` → `forbid(...)` in the `mode === 'merchant-api'` block ("merchant API has no
 *                          platform/worker authority"): a merchant API that
 *                          is merely GIVEN either one does not start.
 *   `RECONCILER`         → NOT `forbid`. The §7 converse clause,
 *                          "must NOT be set in PROCESS_MODE=merchant-api
 *                          (only the reconciler process holds reconciliation
 *                          authority)". A separate clause with a separate
 *                          wording, written for a separate reason (§7 keeps
 *                          the ledger-wide reader out of every other mode).
 *   `PROVISIONER`        → added to the reachable four, because the
 *                          `all || merchant-api` block that requires
 *                          RESOLVER and PROVISIONER REQUIRES it in this mode
 *                          — and the condition alone does not name it, since
 *                          another block carries the same condition and
 *                          requires APP_DATABASE_URL.
 *
 * Measured, not read off the source: on blob `d0d0d99b` of `config.ts`, whose
 * lines `242-290` are byte-identical to this branch's blob `e91531d1` (diffed,
 * no output), with the `MERCHANT_PROD` fixture below as the control — and that
 * control STARTED:
 *
 *   fixture alone                      → STARTED
 *   + RECONCILER, distinct credential  → REFUSED, the §7 converse wording only
 *   + RECONCILER = APP                 → REFUSED, the §7 converse AND §31, both in
 *                                        the one message (`fail` accumulates)
 *
 * That last line is why `RECONCILER` cannot be called "excluded from the
 * separation set": it is IN the map and §31 does compare it. It is excluded
 * from the REACHABLE set, by a mode clause, which is a different statement.
 * If the §7 converse were ever relaxed, this file's "four" would become five and
 * the enumeration above would be measuring the wrong set — so the clause is
 * named here by line and by wording rather than left to be inferred.
 *
 * ── WHY THE FIX IS A MEMBERSHIP AND NOT A THIRD COMPARISON ──────────────────
 *
 * the least-privilege clause already compares the provisioner against APP and PLATFORM by
 * hand. Adding `=== IDENTITY` and `=== RESOLVER` beside it would close these
 * two pairs and leave the next credential to be added exposed again. §31
 * exists precisely so that the separation set has ONE definition, so the fix
 * is to make `PROVISIONER_DATABASE_URL` a member of it. That clause stays as
 * it is: it carries its own least-privilege wording, and in production both
 * clauses now accumulate for `APP = PROVISIONER` (`fail` collects and does not
 * throw at the first defect: `fail()` accumulates into one message), which
 * the last arm here records.
 *
 * ── WHO MOVES THIS ─────────────────────────────────────────────────────────
 *
 * L4, in the same commit as the §31 `urls` map, and only for a deliberate
 * REMOVAL of a principal from the separation set. A name that leaves the map
 * while this file still names it reddens here, which is the point: a principal
 * does not leave the separation set silently.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_PRINCIPAL_URL_KEYS, loadConfig } from '../apps/api/src/config';

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
 * Read a §31 refusal by the PAIR it names, in EITHER direction.
 *
 * `fail()` is called on the key the loop reaches LATER, naming the one it saw
 * EARLIER, so «A duplicates B» or «B duplicates A» is decided by the order of
 * `DB_PRINCIPAL_URL_KEYS` and not by the misconfiguration. Matching one
 * spelling made these arms pass BY POSITION: measured, swapping two members of
 * that list — membership identical — reddened all three of them although the
 * refusal still worked perfectly. The order is pinned in ONE place, by the arm
 * that names the list; these read the pair.
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

describe('THE LAW: the provisioning credential is a principal in the separation set', () => {
  it('POSITIVE CONTROL: four distinct credentials start the process', () => {
    // Without this arm every refusal below could be the fixture's own doing.
    expect(() => loadConfig({ ...MERCHANT_PROD })).not.toThrow();
  });

  it('refuses a provisioner credential equal to IDENTITY, naming both fields', () => {
    expectDuplicatePair(
      { ...MERCHANT_PROD, PROVISIONER_DATABASE_URL: MERCHANT_PROD.IDENTITY_DATABASE_URL },
      'PROVISIONER_DATABASE_URL',
      'IDENTITY_DATABASE_URL',
    );
  });

  it('refuses a provisioner credential equal to RESOLVER, naming both fields', () => {
    expectDuplicatePair(
      { ...MERCHANT_PROD, PROVISIONER_DATABASE_URL: MERCHANT_PROD.RESOLVER_DATABASE_URL },
      'PROVISIONER_DATABASE_URL',
      'RESOLVER_DATABASE_URL',
    );
  });

  it('NEGATIVE CONTROL: the same ROLE with a different CREDENTIAL still starts', () => {
    // The law keys on the credential, not on the role name in the URL: a
    // second `daftar_provisioner` password is a different credential, and
    // refusing it would be refusing a rotation. This is the boundary that
    // keeps the fix from becoming "any URL that looks alike".
    expect(() =>
      loadConfig({
        ...MERCHANT_PROD,
        PROVISIONER_DATABASE_URL: 'postgresql://daftar_provisioner:y@db/daftar',
      }),
    ).not.toThrow();
  });

  it('RECORDS: an APP-equal provisioner now fails under BOTH clauses at once', () => {
    // Measured, not assumed: `fail()` accumulates into one message rather than
    // throwing at the first defect, so the pre-existing
    // provisioner's own APP/PLATFORM clause and the new membership both appear
    // in the one
    // message. This arm exists so that removing either clause is visible.
    const env = {
      ...MERCHANT_PROD,
      PROVISIONER_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL,
    };
    expect(() => loadConfig(env)).toThrow(/PROVISIONER_DATABASE_URL: must be a distinct role from APP\/PLATFORM \(least-privilege provisioning boundary\)/);
    expectDuplicatePair(env, 'PROVISIONER_DATABASE_URL', 'APP_DATABASE_URL');
  });

  // ── #111's REMAINING NOTES, BOTH ONE DEFECT: THE SET AND ITS ORDER WERE
  //    PINNED BY NOTHING BUT THIS FILE'S PROSE ──────────────────────────────
  it('selects the §31 clause ALONE out of a refusal that carries several, which is what makes «names no third principal» mean anything', () => {
    // A refusal with TWO clauses: the §31 duplicate, and a missing
    // `RESOLVER_DATABASE_URL` whose own clause names that key. `config.ts`
    // joins problems with `'; '`, so the message is one line — selecting on
    // `'\n'` returns the WHOLE message and the third-principal check then sees
    // `RESOLVER_DATABASE_URL` and fails. This arm is what made the clause
    // selection provable instead of merely correct.
    const env = { ...MERCHANT_PROD, PROVISIONER_DATABASE_URL: MERCHANT_PROD.IDENTITY_DATABASE_URL, RESOLVER_DATABASE_URL: undefined };
    let message = '';
    try {
      loadConfig(env);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    // the refusal really does carry both clauses, so the arm has a subject
    expect(message).toMatch(/RESOLVER_DATABASE_URL: production requires/);
    expect(message).toMatch(/every DB principal must use distinct credentials/);
    expect(message.split('\n')).toHaveLength(1); // one line, joined with '; '
    // and the pair reading still holds, because it selects the clause
    expectDuplicatePair(env, 'PROVISIONER_DATABASE_URL', 'IDENTITY_DATABASE_URL');
  });

  it('every doc block in `config.ts` touches its subject — an argument detached from its declaration is a claim that names nothing', () => {
    // THE DEFECT THIS PINS, found by review on the previous head of this cart:
    // exporting `DB_PRINCIPAL_URL_KEYS` put its declaration BETWEEN
    // `isLocalHost`'s doc block and `isLocalHost`. The loopback block — which
    // carries measured evidence about `127.0.0.0/8`, `0.0.0.0` and `[::]` —
    // then sat above an unrelated constant, and the function it was written
    // for had no adjacent documentation at all. A reader, and any tool that
    // reads TSDoc, attributes a security argument to the wrong subject. That
    // is the same class as a count that names no tree, in prose.
    //
    // THE FIRST BLOCK IS EXEMPT BY POSITION, not by content: it documents the
    // FILE (`Central validated config (§34)`) and is legitimately followed by
    // the first declaration's own block. Exempting it by position keeps the
    // law from being a law about one sentence.
    const text = readFileSync(join(__dirname, '..', 'apps', 'api', 'src', 'config.ts'), 'utf8');
    const blocks = [...text.matchAll(/\/\*\*[\s\S]*?\*\/\s*/g)];
    expect(blocks.length, 'no doc blocks found at all, so this arm measures nothing').toBeGreaterThan(5);
    const detached = blocks
      .slice(1)
      .filter((m) => text.slice(m.index + m[0].length).startsWith('/**'))
      .map((m) => `line ${text.slice(0, m.index).split('\n').length}: ${(m[0].split('\n')[1] ?? '').trim().slice(0, 60)}`);
    expect(detached).toEqual([]);
    // AND THE CONTROL that this is not vacuous: the FILE header really is
    // followed by another block, so the slice(1) is doing work.
    const header = blocks[0];
    expect(header, 'no doc block at all, so the exemption cannot be tested').toBeDefined();
    const afterHeader = header === undefined ? '' : text.slice(header.index + header[0].length);
    expect(afterHeader.startsWith('/**'), 'the module header is not followed by another block, so the exemption is untested').toBe(true);
  });

  it("the pair reader REFUSES a cross-pair here too — this file's copy of the helper was pinned by nothing", () => {
    // MEASURED: restoring the «join every §31 clause» form in THIS file
    // reddened nothing, because every fixture here plants a single pair. The
    // duplicate law had an arm for it and this one did not, so the same helper
    // was guarded in one place and unguarded in the other. Two pairs are
    // planted and the CROSS-pair must be refused by the reader itself.
    const env = {
      ...MERCHANT_PROD,
      PROVISIONER_DATABASE_URL: MERCHANT_PROD.IDENTITY_DATABASE_URL,
      WORKER_DATABASE_URL: MERCHANT_PROD.RESOLVER_DATABASE_URL,
    };
    expectDuplicatePair(env, 'PROVISIONER_DATABASE_URL', 'IDENTITY_DATABASE_URL');
    expectDuplicatePair(env, 'WORKER_DATABASE_URL', 'RESOLVER_DATABASE_URL');
    expect(() => expectDuplicatePair(env, 'PROVISIONER_DATABASE_URL', 'RESOLVER_DATABASE_URL')).toThrow();
  });

  it('pins the separation set the gate CONSUMES, by name and in order', () => {
    // The members used to be a local `const urls` literal inside the refusal,
    // which no test could reach: the claim that a seventh credential had been
    // ADDED TO THE SET rested on reading the source. The gate now loops this
    // exported object, so this arm pins what decides.
    expect([...DB_PRINCIPAL_URL_KEYS]).toEqual([
      'APP_DATABASE_URL',
      'PLATFORM_DATABASE_URL',
      'IDENTITY_DATABASE_URL',
      'RESOLVER_DATABASE_URL',
      'WORKER_DATABASE_URL',
      'RECONCILER_DATABASE_URL',
      'PROVISIONER_DATABASE_URL',
    ]);
    // AN ORDERED SET BY NAME, not a length: `toHaveLength(7)` passes when one
    // key is swapped for another, and the whole point here is WHICH keys.
    expect(Object.isFrozen(DB_PRINCIPAL_URL_KEYS)).toBe(true);
  });

  it('reads the refusal by the PAIR it names, not by which key the loop reached last', () => {
    // The direction of the message is a consequence of the loop ORDER:
    // `fail()` is called on the key reached later, naming the one seen
    // earlier. Every arm above matches `PROVISIONER … duplicates IDENTITY …`
    // only because `PROVISIONER_DATABASE_URL` is LAST in the set — insert a
    // key after it and those arms redden although the refusal still works
    // perfectly. That is the positional trap. This arm accepts EITHER
    // direction and requires both names, so it survives a reorder, and the
    // arm above is what makes a reorder visible in ONE place with a named
    // cause.
    let message = '';
    try {
      loadConfig({ ...MERCHANT_PROD, PROVISIONER_DATABASE_URL: MERCHANT_PROD.IDENTITY_DATABASE_URL });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toBe('');
    expect(message).toMatch(/every DB principal must use distinct credentials/);
    expect(message).toMatch(/PROVISIONER_DATABASE_URL/);
    expect(message).toMatch(/IDENTITY_DATABASE_URL/);
    // AND THE CONTROL that keeps this from being satisfied by any refusal at
    // all: a THIRD key must not appear in the duplicate clause, or "names both
    // keys" would be true of a message that named everything.
    const duplicateClause = message
      .split('\n')
      .filter((l) => l.includes('every DB principal must use distinct credentials'))
      .join('\n');
    // EVERY other member, from the exported set, not a hand-written list that
    // happened to omit `APP_DATABASE_URL` — which made this arm's control
    // WEAKER than the one `expectDuplicatePair` applies. (Third review of this
    // cart, finding 3.)
    for (const other of DB_PRINCIPAL_URL_KEYS) {
      if (other === 'PROVISIONER_DATABASE_URL' || other === 'IDENTITY_DATABASE_URL') continue;
      expect(duplicateClause, `the duplicate clause also names ${other}`).not.toContain(other);
    }
  });
});
