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
 *   APP      = IDENTITY    → REFUSED (:494 clause AND §31 clause, both)
 *   APP      = RESOLVER    → REFUSED (§31 only)
 *   APP      = PROVISIONER → REFUSED (:522 clause only)
 *   IDENTITY = RESOLVER    → REFUSED (§31 only)
 *   IDENTITY = PROVISIONER → **STARTED**
 *   RESOLVER = PROVISIONER → **STARTED**
 *
 * So of the six pairs of the four credentials a production `merchant-api` can
 * reach — `APP`, `IDENTITY`, `RESOLVER`, `PROVISIONER`; `PLATFORM` and
 * `WORKER` are REFUSED outright in this mode (`forbid(...)`, "merchant API has
 * no platform/worker authority"), which is what makes the set four and not
 * six — exactly TWO were exposed, and both are the owner's two. The other
 * four were already closed, two of them by §31's duplicate-principal check,
 * whose reach is pinned separately in
 * `tests-unit/config-duplicate-db-principal-law.test.ts` (PR #110, this
 * branch's parent).
 *
 * ── WHY THE FIX IS A MEMBERSHIP AND NOT A THIRD COMPARISON ──────────────────
 *
 * `:521-522` already compares the provisioner against APP and PLATFORM by
 * hand. Adding `=== IDENTITY` and `=== RESOLVER` beside it would close these
 * two pairs and leave the next credential to be added exposed again. §31
 * exists precisely so that the separation set has ONE definition, so the fix
 * is to make `PROVISIONER_DATABASE_URL` a member of it. `:521-522` stays as
 * it is: it carries its own least-privilege wording, and in production both
 * clauses now accumulate for `APP = PROVISIONER` (`fail` collects and does not
 * throw at the first defect, `:494`), which the last arm here records.
 *
 * ── WHO MOVES THIS ─────────────────────────────────────────────────────────
 *
 * L4, in the same commit as the §31 `urls` map, and only for a deliberate
 * REMOVAL of a principal from the separation set. A name that leaves the map
 * while this file still names it reddens here, which is the point: a principal
 * does not leave the separation set silently.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../apps/api/src/config';

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

describe('THE LAW: the provisioning credential is a principal in the separation set', () => {
  it('POSITIVE CONTROL: four distinct credentials start the process', () => {
    // Without this arm every refusal below could be the fixture's own doing.
    expect(() => loadConfig({ ...MERCHANT_PROD })).not.toThrow();
  });

  it('refuses a provisioner credential equal to IDENTITY, naming both fields', () => {
    expect(() =>
      loadConfig({
        ...MERCHANT_PROD,
        PROVISIONER_DATABASE_URL: MERCHANT_PROD.IDENTITY_DATABASE_URL,
      }),
    ).toThrow(/PROVISIONER_DATABASE_URL: duplicates IDENTITY_DATABASE_URL — every DB principal must use distinct credentials/);
  });

  it('refuses a provisioner credential equal to RESOLVER, naming both fields', () => {
    expect(() =>
      loadConfig({
        ...MERCHANT_PROD,
        PROVISIONER_DATABASE_URL: MERCHANT_PROD.RESOLVER_DATABASE_URL,
      }),
    ).toThrow(/PROVISIONER_DATABASE_URL: duplicates RESOLVER_DATABASE_URL — every DB principal must use distinct credentials/);
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
    // Measured, not assumed: `fail` accumulates (`:494`), so the pre-existing
    // least-privilege clause and the new membership both appear in the one
    // message. This arm exists so that removing either clause is visible.
    const env = {
      ...MERCHANT_PROD,
      PROVISIONER_DATABASE_URL: MERCHANT_PROD.APP_DATABASE_URL,
    };
    expect(() => loadConfig(env)).toThrow(/PROVISIONER_DATABASE_URL: must be a distinct role from APP\/PLATFORM \(least-privilege provisioning boundary\)/);
    expect(() => loadConfig(env)).toThrow(/PROVISIONER_DATABASE_URL: duplicates APP_DATABASE_URL — every DB principal must use distinct credentials/);
  });
});
