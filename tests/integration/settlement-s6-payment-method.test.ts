/**
 * P3-S6 T-03 — MP-1: A PAYMENT METHOD POSTS ONLY TO AN ACTIVE SETTLEMENT
 * ASSET ACCOUNT OF ITS OWN BUSINESS
 * (docs/PHASE_3_S6_CONTRACT.md A-06, A-14(b), §2.3 `payment_method_guard`,
 * §2.6, §3, §6 T-03; GOLD-47).
 *
 * The account rule is proven at every layer it is stated:
 *   - through the real API: create is ADMITTED for the five settlement system
 *     accounts (1000–1040) and a merchant asset account; it is REFUSED 422
 *     for an inactive account, a liability, an expense, the engine's
 *     non-settlement assets 1100 / 1150 / 1200, and another business's account
 *     (the same owner's A2 and another tenant's B) — each refusal writes
 *     nothing;
 *   - through the routine itself (a real signed call as `daftar_app`): the
 *     same refusals, `payment_method.posting_account_ineligible` /
 *     `payment_method.posting_account_not_found`;
 *   - physically: the tgtype-31 guard refuses an owner INSERT on an
 *     ineligible account, and with that guard neutered the composite FK
 *     `payment_methods_account_fk` refuses another business's account;
 *   - activation re-checks the account: a method whose account was
 *     deactivated since it was created cannot be re-activated (API and
 *     routine) until the account is active again.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  expectConstraint,
  must,
  onboardS3Business,
  refusedWith,
  registerActor,
  rolledBack,
  scratch,
  settle,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { s4Delta } from '../helpers/purchase-commands';
import {
  customAccount,
  expectRefusal,
  methodBody,
  methodCreateCall,
  methodLifecycleCall,
  runS6,
  s6Counts,
  seedSettlementAccounts,
  SETTLEMENT_KEYS,
  tryS6,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let bOwner: HttpActor;
let A: S3Business;
let A2: S3Business;
let B: S3Business;
let acc: SettlementAccounts;
let acc2: SettlementAccounts;
let accB: SettlementAccounts;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 method owner');
  A = await onboardS3Business(t, owner, 's6pm');
  A2 = await onboardS3Business(t, owner, 's6pm2', A.tenantId);
  bOwner = await registerActor(t, 'S6 other owner');
  B = await onboardS3Business(t, bOwner, 's6pmB');
  acc = await seedSettlementAccounts(ownerPool(), A);
  acc2 = await seedSettlementAccounts(ownerPool(), A2);
  accB = await seedSettlementAccounts(ownerPool(), B);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const as = (): Record<string, string> => asMember(owner, A.businessId);

async function codeOf(accountId: string): Promise<string> {
  return must((await ownerPool().query<{ code: string }>(`SELECT code FROM accounts WHERE id = $1`, [accountId])).rows[0]).code;
}

async function setAccountActive(accountId: string, active: boolean): Promise<void> {
  const r = await ownerPool().query(`UPDATE accounts SET is_active = $2 WHERE id = $1`, [accountId, active]);
  expect(r.rowCount).toBe(1);
}

/** The refused accounts of A-06, each with the code the API and the routine answer. */
function refusedAccounts(): readonly (readonly [what: string, accountId: string, code: string])[] {
  return [
    ['an inactive merchant asset account', acc.inactiveAsset, 'payment_method.posting_account_ineligible'],
    ['a merchant liability account', acc.customLiability, 'payment_method.posting_account_ineligible'],
    ['a merchant expense account', acc.customExpense, 'payment_method.posting_account_ineligible'],
    ['the system liability accounts_payable', acc.accountsPayable, 'payment_method.posting_account_ineligible'],
    ['the system expense fx_loss', acc.fxLoss, 'payment_method.posting_account_ineligible'],
    ['accounts_receivable (1100)', acc.accountsReceivable, 'payment_method.posting_account_ineligible'],
    ['supplier_receivable (1150)', acc.supplierReceivable, 'payment_method.posting_account_ineligible'],
    ['inventory (1200)', acc.inventory, 'payment_method.posting_account_ineligible'],
    ["the same owner's other business's cash account", acc2.settlement.cash, 'payment_method.posting_account_not_found'],
    ["another tenant's cash account", accB.settlement.cash, 'payment_method.posting_account_not_found'],
    ['an account that does not exist', randomUUID(), 'payment_method.posting_account_not_found'],
  ];
}

describe('T-03 MP-1 through the API', () => {
  it('the five settlement system accounts are 1000–1040 and each is admitted, as is a merchant asset account', async () => {
    const codes = await Promise.all(SETTLEMENT_KEYS.map((k) => codeOf(acc.settlement[k])));
    expect(codes, 'the settlement system accounts').toEqual(['1000', '1010', '1020', '1030', '1040']);
    for (const accountId of [...SETTLEMENT_KEYS.map((k) => acc.settlement[k]), acc.customAsset]) {
      const body = methodBody(accountId);
      const r = await t.request.post('/v1/payment-methods').set(as()).send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({
        paymentMethodId: body.paymentMethodId,
        postingAccountId: accountId,
        isActive: true,
        revision: 1,
        replayed: false,
      });
      const stored = must(
        (
          await ownerPool().query<{ posting_account_id: string; is_active: boolean }>(
            `SELECT posting_account_id::text, is_active FROM payment_methods WHERE business_id = $1 AND id = $2`,
            [A.businessId, body.paymentMethodId],
          )
        ).rows[0],
      );
      expect(stored).toEqual({ posting_account_id: accountId, is_active: true });
    }
  });

  it('create is refused 422 for every ineligible account, and nothing is written', async () => {
    for (const [what, accountId, code] of refusedAccounts()) {
      const before = await s6Counts(ownerPool(), A.businessId);
      const r = await t.request.post('/v1/payment-methods').set(as()).send(methodBody(accountId));
      expectRefusal(r, 422, code, what);
      expect(s4Delta(before, await s6Counts(ownerPool(), A.businessId)), `${what}: nothing written`).toEqual({});
    }
  });

  it('activation re-checks the account: a method whose account was since deactivated is refused 422 until the account is active again', async () => {
    const account = await customAccount(ownerPool(), A, 'asset');
    const body = methodBody(account);
    const id = String(body.paymentMethodId);
    const created = await t.request.post('/v1/payment-methods').set(as()).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const off = await t.request.post(`/v1/payment-methods/${id}/deactivate`).set(as()).send({ expectedRevision: 1 });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ isActive: false, revision: 2 });
    await setAccountActive(account, false);
    const before = await s6Counts(ownerPool(), A.businessId);
    const refused = await t.request.post(`/v1/payment-methods/${id}/activate`).set(as()).send({ expectedRevision: 2 });
    expectRefusal(refused, 422, 'payment_method.posting_account_ineligible', 'activate on an inactive account');
    expect(s4Delta(before, await s6Counts(ownerPool(), A.businessId)), 'the refused activation writes nothing').toEqual({});
    await setAccountActive(account, true);
    const on = await t.request.post(`/v1/payment-methods/${id}/activate`).set(as()).send({ expectedRevision: 2 });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ isActive: true, revision: 3, postingAccountId: account });
  });
});

describe('T-03 MP-1 at the routine (a real signed call as daftar_app)', () => {
  it('payment_method_create refuses every ineligible account with its stable code and admits every eligible one', async () => {
    await rolledBack(async (c: Client) => {
      for (const [what, accountId, code] of refusedAccounts()) {
        refusedWith(await tryS6(c, A, methodCreateCall(A, { postingAccountId: accountId })), 'P0001', code, what);
      }
      for (const accountId of [...SETTLEMENT_KEYS.map((k) => acc.settlement[k]), acc.customAsset]) {
        const call = methodCreateCall(A, { postingAccountId: accountId });
        const rows = await runS6(c, A, call);
        expect(rows, 'created active at revision 1').toEqual([{ payment_method_id: call.params[0], replayed: false, revision: 1, is_active: true }]);
      }
    });
  });

  it('payment_method_activate re-checks eligibility', async () => {
    await rolledBack(async (c: Client) => {
      const account = await customAccount(c, A, 'asset');
      const create = methodCreateCall(A, { postingAccountId: account });
      await runS6(c, A, create);
      const id = String(create.params[0]);
      await runS6(c, A, methodLifecycleCall(A, 'method_deactivate', id, 1));
      await c.query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND id = $2`, [A.businessId, account]);
      refusedWith(
        await tryS6(c, A, methodLifecycleCall(A, 'method_activate', id, 2)),
        'P0001',
        'payment_method.posting_account_ineligible',
        'activate on a deactivated account',
      );
      await c.query(`UPDATE accounts SET is_active = true WHERE business_id = $1 AND id = $2`, [A.businessId, account]);
      expect(await runS6(c, A, methodLifecycleCall(A, 'method_activate', id, 2))).toEqual([
        { payment_method_id: id, replayed: false, revision: 3, is_active: true },
      ]);
    });
  });
});

describe('T-03 MP-1 physically', () => {
  /** An owner INSERT of a method row shaped exactly as the guard requires, but for `accountId`. */
  async function ownerInsert(c: Client, accountId: string): Promise<void> {
    const trace = randomUUID();
    await c.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true), set_config('app.business_transaction_id', $3, true)`,
      [A.tenantId, A.businessId, trace],
    );
    const digest = 'a'.repeat(64);
    await c.query(
      `INSERT INTO payment_methods (tenant_id, business_id, id, system_type, posting_account_id, is_active, requires_reference, sort_order, revision,
                                    create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
       VALUES ($1, $2, $3, 'cash', $4, true, false, 0, 1, $5, $5, $6, $7, $7)`,
      [A.tenantId, A.businessId, randomUUID(), accountId, digest, trace, A.userId],
    );
  }

  it('the guard refuses an owner INSERT on each ineligible account; the composite FK refuses another business’s account once the guard is neutered', async () => {
    await rolledBack(async (c: Client) => {
      for (const [what, accountId] of refusedAccounts()) {
        refusedWith(await scratch(c, () => settle(() => ownerInsert(c, accountId))), 'P0001', 'payment_method.posting_account_ineligible', `guard: ${what}`);
      }
      await scratch(c, async () => {
        // The ALLOW twin: the same statement on an eligible account passes the guard.
        await ownerInsert(c, acc.settlement.bank);
      });
      for (const foreign of [acc2.settlement.cash, accB.settlement.cash]) {
        const o = await scratch(c, async () => {
          await c.query(`ALTER TABLE payment_methods DISABLE TRIGGER payment_methods_guard`);
          return settle(() => ownerInsert(c, foreign));
        });
        expectConstraint(o, '23503', 'payment_methods_account_fk', 'another business’s account');
      }
    });
  });
});
