/**
 * P3-S6 T-04 — MP-2: A PAYMENT METHOD'S HISTORY IS NEVER REWRITTEN
 * (docs/PHASE_3_S6_CONTRACT.md A-04, A-06 "Historical identity", A-17,
 * §2.3 `payment_method_guard`, §3, §6 T-04; GOLD-47).
 *
 * - DELETE is refused for every principal: the owner (the guard,
 *   `payment_method.not_deletable`), the migrator and the inventory
 *   principal (no DELETE privilege at all), and no route deletes;
 * - a USED method's account cannot change: through the routine
 *   `payment_method.posting_account_locked` (and through the API, 409), for a
 *   method used by a payment and for one used by a refund; with the guard
 *   neutered, the composite FK of the payment / refund to
 *   `payment_methods (business_id, id, posting_account_id)` still refuses it;
 * - deactivation changes `is_active` only: every posted journal line is
 *   byte-identical before and after (a digest of `journal_lines`);
 * - an inactive method can neither pay nor receive a refund
 *   (`payment_method.inactive`, 409), and writes nothing;
 * - an UNUSED method's account change is allowed (the ALLOW of the lock);
 * - `system_type` and the names change only by a real revision in the
 *   method's own transaction (`payment_method.field_immutable`).
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, migratorDbUrl, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  atCommit,
  expectAccepted,
  expectConstraint,
  must,
  onboardS3Business,
  refusedWith,
  registerActor,
  roleClient,
  rolledBack,
  scratch,
  settle,
  today,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { s4Delta } from '../helpers/purchase-commands';
import { receivedPurchase } from '../helpers/purchase-returns';
import {
  createMethod,
  expectRefusal,
  httpMethod,
  httpPay,
  httpReceived,
  journalLinesDigest,
  methodLifecycleCall,
  methodUpdateCall,
  outstandingOf,
  payBody,
  preparePay,
  refundBody,
  returnToCredit,
  runS6,
  s6Counts,
  seedSettlementAccounts,
  tryS6,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let day: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 history owner');
  A = await onboardS3Business(t, owner, 's6pmh');
  acc = await seedSettlementAccounts(ownerPool(), A);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const as = (): Record<string, string> => asMember(owner, A.businessId);

async function methodRow(id: string): Promise<{ posting_account_id: string; is_active: boolean; revision: number }> {
  return must(
    (
      await ownerPool().query<{ posting_account_id: string; is_active: boolean; revision: number }>(
        `SELECT posting_account_id::text, is_active, revision FROM payment_methods WHERE business_id = $1 AND id = $2`,
        [A.businessId, id],
      )
    ).rows[0],
  );
}

/** A method that has paid one received purchase in full, through the API. */
async function usedByPayment(): Promise<string> {
  const methodId = await httpMethod(t, owner, A, acc.settlement.cash);
  const p = await httpReceived(t, owner, A);
  const o = await outstandingOf(ownerPool(), A.businessId, p.purchaseId);
  const r = await httpPay(t, owner, A, payBody(p.supplierId, methodId, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: o.o.toString(10) }]));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return methodId;
}

describe('T-04 DELETE is refused for every principal', () => {
  it('the owner hits the guard; the migrator and the inventory principal hold no DELETE; there is no route', async () => {
    const id = await httpMethod(t, owner, A, acc.settlement.bank);
    await rolledBack(async (c: Client) => {
      refusedWith(
        await scratch(c, () => settle(() => c.query(`DELETE FROM payment_methods WHERE business_id = $1 AND id = $2`, [A.businessId, id]))),
        'P0001',
        'payment_method.not_deletable',
        'the owner',
      );
      const internal = await scratch(c, async () => {
        await c.query('SET LOCAL ROLE daftar_inventory_internal');
        return settle(() => c.query(`DELETE FROM payment_methods WHERE business_id = $1 AND id = $2`, [A.businessId, id]));
      });
      refusedWith(internal, '42501', null, 'the inventory principal holds no DELETE on payment_methods');
    });
    const migratorHolds = must(
      (await ownerPool().query<{ ok: boolean }>(`SELECT has_table_privilege('daftar_migrator', 'payment_methods', 'DELETE') AS ok`)).rows[0],
    ).ok;
    const m = await roleClient(migratorDbUrl);
    try {
      await m.query('BEGIN');
      const o = await settle(() => m.query(`DELETE FROM payment_methods WHERE business_id = $1 AND id = $2`, [A.businessId, id]));
      // Without the privilege it is 42501; a deployment where the migrator owns the table meets the guard instead.
      if (migratorHolds) refusedWith(o, 'P0001', 'payment_method.not_deletable', 'the migrator (owner) meets the guard');
      else refusedWith(o, '42501', null, 'the migrator holds no DELETE');
    } finally {
      await m.query('ROLLBACK');
      await m.end();
    }
    const route = await t.request.delete(`/v1/payment-methods/${id}`).set(as());
    expect(route.status, 'no route deletes a method').toBe(404);
    expect(await methodRow(id)).toMatchObject({ is_active: true, revision: 1 });
  });
});

describe('T-04 a used method keeps its account', () => {
  it('used by a payment: the routine refuses posting_account_locked, and with the guard neutered the payment FK still refuses', async () => {
    await rolledBack(async (c: Client) => {
      const methodId = await createMethod(c, A, { postingAccountId: acc.settlement.cash });
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '2', unitPriceMinor: '1000' }]);
      const pay = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: methodId,
        allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 2000n }],
      });
      await runS6(c, A, pay);
      expectAccepted(await atCommit(c), 'the payment commits');
      refusedWith(
        await tryS6(c, A, methodUpdateCall(A, methodId, 1, { postingAccountId: acc.settlement.bank })),
        'P0001',
        'payment_method.posting_account_locked',
        'a paid-through method',
      );
      // The ALLOW twin: the same update keeping the account is admitted.
      await runS6(c, A, methodUpdateCall(A, methodId, 1, { postingAccountId: acc.settlement.cash, sortOrder: 20 }));
      const fk = await scratch(c, async () => {
        // Fire the pending deferred events first: a table with pending events cannot be altered.
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await c.query(`ALTER TABLE payment_methods DISABLE TRIGGER payment_methods_guard`);
        return settle(() =>
          c.query(`UPDATE payment_methods SET posting_account_id = $3 WHERE business_id = $1 AND id = $2`, [A.businessId, methodId, acc.settlement.bank]),
        );
      });
      expectConstraint(fk, '23503', 'supplier_payments_method_fk', 'the payment names (method, account)');
    });
  });

  it('used by a refund: the API refuses 409 posting_account_locked, and with the guard neutered the refund FK still refuses', async () => {
    const payer = await httpMethod(t, owner, A, acc.settlement.cash);
    const refunder = await httpMethod(t, owner, A, acc.settlement.bank);
    const { creditNoteId } = await returnToCredit(t, owner, A, payer);
    const refund = await t.request
      .post('/v1/supplier-refunds')
      .set(as())
      .send(refundBody(creditNoteId, refunder, day, '100'));
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const before = await s6Counts(ownerPool(), A.businessId);
    const put = await t.request
      .put(`/v1/payment-methods/${refunder}`)
      .set(as())
      .send({
        expectedRevision: 1,
        postingAccountId: acc.settlement.card_clearing,
        requiresReference: false,
        sortOrder: 10,
        names: { en: 'Cash drawer', ar: 'الصندوق' },
      });
    expectRefusal(put, 409, 'payment_method.posting_account_locked', 'a refunded-through method');
    expect(s4Delta(before, await s6Counts(ownerPool(), A.businessId)), 'nothing written').toEqual({});
    await rolledBack(async (c: Client) => {
      const fk = await scratch(c, async () => {
        // Fire the pending deferred events first: a table with pending events cannot be altered.
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await c.query(`ALTER TABLE payment_methods DISABLE TRIGGER payment_methods_guard`);
        return settle(() =>
          c.query(`UPDATE payment_methods SET posting_account_id = $3 WHERE business_id = $1 AND id = $2`, [
            A.businessId,
            refunder,
            acc.settlement.card_clearing,
          ]),
        );
      });
      expectConstraint(fk, '23503', 'supplier_refunds_method_fk', 'the refund names (method, account)');
    });
  });

  it('an UNUSED method’s account change is allowed (200) and stored', async () => {
    const id = await httpMethod(t, owner, A, acc.settlement.cash);
    const put = await t.request
      .put(`/v1/payment-methods/${id}`)
      .set(as())
      .send({
        expectedRevision: 1,
        postingAccountId: acc.customAsset,
        requiresReference: true,
        sortOrder: 5,
        names: { en: 'Second bank' },
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({
      postingAccountId: acc.customAsset,
      revision: 2,
      requiresReference: true,
      names: { en: 'Second bank', ar: null, tr: null },
    });
    expect(await methodRow(id)).toEqual({ posting_account_id: acc.customAsset, is_active: true, revision: 2 });
  });
});

describe('T-04 deactivation changes is_active only', () => {
  it('every posted journal line is byte-identical before and after; the method can then neither pay nor refund', async () => {
    const methodId = await usedByPayment();
    const { creditNoteId } = await returnToCredit(t, owner, A, methodId);
    const linesBefore = await journalLinesDigest(ownerPool(), A.businessId);
    const off = await t.request.post(`/v1/payment-methods/${methodId}/deactivate`).set(as()).send({ expectedRevision: 1 });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ isActive: false, revision: 2, postingAccountId: acc.settlement.cash });
    expect(await journalLinesDigest(ownerPool(), A.businessId), 'posted lines unchanged by the deactivation').toBe(linesBefore);

    const p = await httpReceived(t, owner, A);
    const before = await s6Counts(ownerPool(), A.businessId);
    const pay = await httpPay(t, owner, A, payBody(p.supplierId, methodId, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '100' }]));
    expectRefusal(pay, 409, 'payment_method.inactive', 'an inactive method pays');
    const refund = await t.request
      .post('/v1/supplier-refunds')
      .set(as())
      .send(refundBody(creditNoteId, methodId, day, '100'));
    expectRefusal(refund, 409, 'payment_method.inactive', 'an inactive method receives a refund');
    expect(s4Delta(before, await s6Counts(ownerPool(), A.businessId)), 'nothing written').toEqual({});
  });

  it('the routine refuses an inactive method too, before any write', async () => {
    await rolledBack(async (c: Client) => {
      const methodId = await createMethod(c, A, { postingAccountId: acc.settlement.cash });
      const p = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '1', unitPriceMinor: '500' }]);
      const pay = await preparePay(c, A, {
        supplierId: p.supplierId,
        paymentMethodId: methodId,
        allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 500n }],
      });
      await runS6(c, A, methodLifecycleCall(A, 'method_deactivate', methodId, 1));
      refusedWith(await tryS6(c, A, pay), 'P0001', 'payment_method.inactive', 'supplier_pay with an inactive method');
    });
  });
});

describe('T-04 identity and names change only by a revision', () => {
  it('system_type, created_* and the names refuse a direct owner write (field_immutable); a name follows a real revision only', async () => {
    const id = await httpMethod(t, owner, A, acc.settlement.wallet_clearing, { systemType: 'wallet' });
    await rolledBack(async (c: Client) => {
      await c.query(`SELECT set_config('app.business_id', $1, true), set_config('app.business_transaction_id', $2, true)`, [A.businessId, randomUUID()]);
      for (const [what, sql] of [
        ['system_type', `UPDATE payment_methods SET system_type = 'cash', revision = revision + 1, updated_at = now() WHERE business_id = $1 AND id = $2`],
        [
          'created_at',
          `UPDATE payment_methods SET created_at = created_at - interval '1 day', revision = revision + 1, updated_at = now() WHERE business_id = $1 AND id = $2`,
        ],
        ['a name', `UPDATE payment_method_names SET display_name = 'Renamed' WHERE business_id = $1 AND payment_method_id = $2`],
        [
          'a new locale',
          `INSERT INTO payment_method_names (tenant_id, business_id, payment_method_id, locale, display_name) SELECT tenant_id, business_id, id, 'tr', 'Nakit' FROM payment_methods WHERE business_id = $1 AND id = $2`,
        ],
        ['a name deleted', `DELETE FROM payment_method_names WHERE business_id = $1 AND payment_method_id = $2`],
      ] as const) {
        refusedWith(await scratch(c, () => settle(() => c.query(sql, [A.businessId, id]))), 'P0001', 'payment_method.field_immutable', what);
      }
    });
    const named = await t.request.get(`/v1/payment-methods/${id}`).set(as());
    expect(named.status).toBe(200);
    expect(named.body).toMatchObject({ systemType: 'wallet', names: { en: 'Cash drawer', ar: 'الصندوق', tr: null }, revision: 1 });
  });
});
