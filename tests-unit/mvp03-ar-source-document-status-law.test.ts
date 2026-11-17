import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountingStatus } from '../apps/api/src/common/error.filter';

/**
 * MVP-03 — the HTTP contract of `0090`'s refusal.
 *
 * `0090_mvp03_ar_source_document_guard.sql` raises a NEW stable code,
 * `accounting.ar_source_document_required`, from a DEFERRABLE constraint
 * trigger: the refusal arrives at COMMIT because the books' own state (the
 * entry's source type) forbids a line on a guarded account, and NOT because
 * the caller sent a malformed payload. `accountingStatus`'s fallback is 400 by
 * design — the function's own comment says an unclassified accounting code
 * must land on 400 rather than 500, so that an unclassified refusal still
 * reads as a refusal and never as an outage. That fallback is right for a code
 * nobody has classified, and WRONG for this one, which is a conflict.
 *
 * The subject is not invented: `accounting.inventory_account_domain_owned` is
 * the structural twin already in the tree — also a COMMIT-time refusal from a
 * deferred trigger, on a system account, for `manual_adjustment` and
 * `opening_balance` — and `error.filter.ts` maps it to 409 with prose saying
 * 400 "tells the caller to fix a payload that is not wrong". This law holds
 * the new code to the same mapping as its twin.
 *
 * Why this lives in `tests-unit` and not only in the contract suite: this
 * assertion needs no database, so it runs on every machine and on the unit
 * lane (`npm test` → `test:unit` → `vitest.unit.config.ts` → `tests-unit/**`),
 * which `ci.yml` reaches. The row added to `ACCOUNTING_CONTRACT` in
 * `tests/integration/sale-s2-error-contract.test.ts` proves the same mapping
 * through the real route, at the cost of a cluster.
 *
 * WHAT THIS LAW DOES NOT CHECK, written down so nobody reads it for more than
 * it is: it does not prove the database raises the code (that is the
 * integration suite's), it does not prove the envelope the filter builds
 * around the status, and it does not prove any translation key exists in the
 * web — measured, the twin is absent from `packages/accounting/src/errors.ts`
 * too, so being outside the web's enumerated tables is a property this code
 * SHARES with the accepted twin and is deliberate, not a defect closed here.
 */
const CODE = 'accounting.ar_source_document_required';
const TWIN = 'accounting.inventory_account_domain_owned';
const MIGRATION = join(__dirname, '..', 'infrastructure', 'database', 'migrations', '0090_mvp03_ar_source_document_guard.sql');

describe('MVP-03 — the AR source-document refusal is a conflict, not a bad payload', () => {
  it('the law has a subject: the migration really raises this code', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    // A POSITIVE CONTROL ON THE PROBE ITSELF. If this file stopped raising the
    // code, every assertion below would pass while guarding nothing, so the
    // count is read here and not assumed.
    const raised = [...sql.matchAll(new RegExp(CODE.replace('.', '\\.'), 'g'))].length;
    expect(raised, 'the migration no longer raises this code, so this law has no subject').toBeGreaterThan(0);
    // ...and the code is raised, not merely mentioned in prose: the RAISE
    // carries it as the ERRCODE-bearing message that the filter will classify.
    expect(sql, 'the code appears but not on a RAISE line').toMatch(new RegExp('RAISE[\\s\\S]{0,400}' + CODE.replace('.', '\\.')));
  });

  it('the new code maps to 409, exactly as its structural twin does', () => {
    expect(accountingStatus(CODE), CODE + ' must be a conflict: the payload is well formed and the books refuse it').toBe(409);
  });

  it('the twin still maps to 409, so the comparison is real and not assumed', () => {
    expect(accountingStatus(TWIN), 'the twin changed mapping, so this law compares against nothing').toBe(409);
  });

  it('a NEGATIVE control: an unclassified accounting code still falls back to 400', () => {
    // Without this, the law above would also pass if someone made the whole
    // function return 409. The fallback is deliberate and must survive.
    expect(accountingStatus('accounting.zzz_not_a_real_code_for_this_control'), 'the 400 fallback was lost').toBe(400);
    expect(accountingStatus('accounting.payload_invalid'), 'a genuinely malformed payload must stay 400').toBe(400);
  });

  it('a NEGATIVE control on the other branches, so the subject is the real function', () => {
    expect(accountingStatus('accounting.forbidden')).toBe(403);
    expect(accountingStatus('accounting.entry_not_found')).toBe(404);
  });
});
