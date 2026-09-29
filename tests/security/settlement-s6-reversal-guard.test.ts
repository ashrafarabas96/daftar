/**
 * P3-S6 T-16 — THE GENERIC REVERSAL WORKFLOW REFUSES EVERY S6 ENTRY
 * (docs/PHASE_3_S6_CONTRACT.md A-14(c), §6 T-16; 0067 R-68).
 *
 * `accounting_reversals_20_domain_source_guard()` (replaced by the accounting
 * owner) refuses `accounting.reversal_source_domain_owned` for a
 * `supplier_payment`, a `supplier_credit_allocation` and a `supplier_refund`
 * entry — through the API (409, nothing written) and through
 * `accounting_post_reversal` directly under an honest reversal assertion
 * (P0001). It still admits S5's paired purchase reversal (a purchase entry
 * whose `purchase_reversals` row the same transaction wrote), and still
 * refuses the S3/S5 domain types and an unpaired purchase entry. Every DENY
 * is paired with the ALLOW of an ordinary entry.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import {
  asMember,
  atCommit,
  attempt,
  expectAccepted,
  must,
  onboardS3Business,
  ownerClient,
  refusedWith,
  registerActor,
  today,
  type HttpActor,
  type S3Business,
} from '../helpers/inventory-commands';
import { reverseInTx } from '../helpers/inventory-posting';
import { reversalFingerprintOfSnapshot } from '../helpers/accounting-posting';
import type { PostedEntrySnapshot } from '@daftar/accounting';
import { receivedPurchase } from '../helpers/purchase-returns';
import { post as postManualAdjustment, simpleCommand } from '../helpers/accounting-posting';
import {
  allocateBody,
  createMethod,
  httpMethod,
  httpPay,
  httpReceived,
  payBody,
  prepareAllocate,
  preparePay,
  prepareRefund,
  refundBody,
  returnToCredit,
  runS6,
  s6Counts,
  seedSettlementAccounts,
  settlementEntry,
  sqlReturnToCredit,
  type S6Call,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let method: string;
let day: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 reversal-guard owner');
  A = await onboardS3Business(t, owner, 's6revg');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.cash);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const headers = (): Record<string, string> => asMember(owner, A.businessId);

const reverse = (entryId: string): Promise<Response> =>
  t.request.post(`/v1/businesses/${A.businessId}/accounting/entries/${entryId}/reversals`).set(headers()).send({ entryDate: day, reason: 'undo it' });

async function entryIdOf(sourceType: string, sourceId: string): Promise<string> {
  return must(await settlementEntry(ownerPool(), A.businessId, sourceType, sourceId), `${sourceType} ${sourceId}`).id;
}

describe('T-16 through the API: each S6 entry → 409 reversal_source_domain_owned, nothing written', () => {
  it('a supplier_payment, a supplier_credit_allocation and a supplier_refund entry; an ordinary entry reverses (the ALLOW)', async () => {
    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '50.00' }], quantity: '2' });
    const target = await httpReceived(t, owner, A, { supplierId: note.purchase.supplierId });
    const paid = await httpPay(t, owner, A, payBody(target.supplierId, method, day, [{ purchaseId: target.purchaseId, paymentAmountMinor: '1000' }]));
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const allocationId = String(must((paid.body as { allocations: { allocationId: string }[] }).allocations[0]).allocationId);
    const creditBody = allocateBody(note.creditNoteId, target.purchaseId, day, '2000');
    const credited = await t.request.post('/v1/supplier-credit-allocations').set(headers()).send(creditBody);
    expect(credited.status, JSON.stringify(credited.body)).toBe(201);
    const refundRequest = refundBody(note.creditNoteId, method, day, '3000');
    const refunded = await t.request.post('/v1/supplier-refunds').set(headers()).send(refundRequest);
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(201);

    for (const [sourceType, sourceId] of [
      ['supplier_payment', allocationId],
      ['supplier_credit_allocation', String(creditBody.allocationId)],
      ['supplier_refund', String(refundRequest.refundId)],
    ] as const) {
      const entryId = await entryIdOf(sourceType, sourceId);
      const before = await s6Counts(ownerPool(), A.businessId);
      const r = await reverse(entryId);
      expect({ status: r.status, code: (r.body as { error?: { details?: { code?: string } } }).error?.details?.code }, sourceType).toEqual({
        status: 409,
        code: 'accounting.reversal_source_domain_owned',
      });
      expect(await s6Counts(ownerPool(), A.businessId), `${sourceType}: nothing written`).toEqual(before);
    }
    // The paid purchase's own entry: still domain-owned (no purchase_reversals row).
    const purchaseEntry = await entryIdOf('purchase', target.purchaseId);
    expect((await reverse(purchaseEntry)).status, 'a paid purchase entry').toBe(409);

    const fixture = {
      tenantId: A.tenantId,
      businessId: A.businessId,
      userId: owner.userId,
      branchId: A.branchX,
      otherBranchId: A.branchY,
      warehouseId: A.w1,
      otherTenantId: A.tenantId,
      otherBusinessId: A.businessId,
      otherUserId: owner.userId,
    };
    const manual = await postManualAdjustment(simpleCommand(fixture, randomUUID(), day, 700n), owner.userId);
    expect((await reverse(manual.entryId)).status, 'ALLOW: an ordinary entry reverses').toBe(201);
  });

  it('S5’s paired purchase reversal is still admitted through its own route', async () => {
    const p = await httpReceived(t, owner, A);
    const r = await t.request.post(`/v1/purchases/${p.purchaseId}/reversal`).set(headers()).send({ reversalDate: day, reason: 'Received twice' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = await ownerPool().query(`SELECT 1 FROM purchase_reversals WHERE business_id = $1 AND id = $2`, [A.businessId, p.purchaseId]);
    expect(row.rowCount, 'the purchase is reversed').toBe(1);
  });
});

/**
 * The entry as the ledger reader reads it (the account identity is its
 * system key, else its code): the reversal assertion is minted over its
 * mirror, so the only thing that can refuse the reversal is the domain guard.
 */
async function storedSnapshot(c: Client, entryId: string): Promise<PostedEntrySnapshot> {
  const head = must(
    (
      await c.query<{ tenant_id: string; source_type: string; entry_date: string }>(
        `SELECT tenant_id::text, source_type, to_char(entry_date, 'YYYY-MM-DD') AS entry_date FROM journal_entries WHERE business_id = $1 AND id = $2`,
        [A.businessId, entryId],
      )
    ).rows[0],
  );
  const lines = await c.query<{
    line_no: number;
    system_key: string | null;
    code: string;
    debit_minor: string;
    base_amount_minor: string;
    base_currency: string;
    txn_amount_minor: string;
    txn_currency: string;
    fx_rate: string;
    fx_rate_source: string;
    fx_rate_at: Date;
    branch_id: string | null;
    warehouse_id: string | null;
    memo: string | null;
  }>(
    `SELECT l.line_no, a.system_key, a.code, l.debit_minor::text AS debit_minor, l.base_amount_minor::text AS base_amount_minor, l.base_currency,
            l.txn_amount_minor::text AS txn_amount_minor, l.txn_currency, l.fx_rate::text AS fx_rate, l.fx_rate_source, l.fx_rate_at,
            l.branch_id::text, l.warehouse_id::text, l.memo
       FROM journal_lines l JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
      WHERE l.business_id = $1 AND l.journal_entry_id = $2 ORDER BY l.line_no`,
    [A.businessId, entryId],
  );
  return {
    entryId,
    tenantId: head.tenant_id,
    businessId: A.businessId,
    sourceType: head.source_type,
    entryDate: head.entry_date,
    lines: lines.rows.map((r) => ({
      lineNo: r.line_no,
      account: r.system_key !== null ? { kind: 'system', systemKey: r.system_key } : { kind: 'code', code: r.code },
      side: BigInt(r.debit_minor) > 0n ? 'D' : 'C',
      baseAmountMinor: BigInt(r.base_amount_minor),
      baseCurrency: r.base_currency,
      txnAmountMinor: BigInt(r.txn_amount_minor),
      txnCurrency: r.txn_currency,
      fxRate: r.fx_rate,
      fxRateSource: r.fx_rate_source,
      fxRateAt: r.fx_rate_at,
      branchId: r.branch_id,
      warehouseId: r.warehouse_id,
      memo: r.memo,
    })),
  };
}

async function inTx(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await ownerClient();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

describe('T-16 through accounting_post_reversal directly, under an honest reversal assertion', () => {
  it('each S6 entry → P0001 reversal_source_domain_owned; nothing written', async () => {
    await inTx(async (c) => {
      const m = await createMethod(c, A, { postingAccountId: acc.settlement.bank });
      const n = await sqlReturnToCredit(c, A, m, { qty: '2', unitPriceMinor: '5000', returnQty: '2' });
      const target = await receivedPurchase(c, A, [{ variantId: A.piece.variantId, qty: '2', unitPriceMinor: '5000' }], { supplierId: n.purchase.supplierId });
      const calls: S6Call[] = [
        await preparePay(c, A, {
          supplierId: target.supplierId,
          paymentMethodId: m,
          allocations: [{ purchaseId: target.purchaseId, paymentAmountMinor: 1000n }],
        }),
      ];
      await runS6(c, A, must(calls[0]));
      calls.push(await prepareAllocate(c, A, { creditNoteId: n.creditNoteId, purchaseId: target.purchaseId, consumedMinor: 2000n }));
      await runS6(c, A, must(calls[1]));
      calls.push(await prepareRefund(c, A, { creditNoteId: n.creditNoteId, paymentMethodId: m, consumedMinor: 3000n }));
      await runS6(c, A, must(calls[2]));
      expectAccepted(await atCommit(c), 'the honest state passes the COMMIT probe');
      const date = await today(c);
      const before = await s6Counts(c, A.businessId);
      for (const call of calls) {
        const posting = must(call.postings[0]);
        const entry = must(await settlementEntry(c, A.businessId, posting.sourceType, posting.sourceId), posting.sourceType);
        refusedWith(
          await attempt(c, async () => reverseInTx(c, A, entry.id, date, reversalFingerprintOfSnapshot(await storedSnapshot(c, entry.id), date))),
          'P0001',
          'accounting.reversal_source_domain_owned',
          posting.sourceType,
        );
      }
      expect(await s6Counts(c, A.businessId), 'nothing written').toEqual(before);
    });
  });

  it('catalogue: the replaced guard names the seven always-refused types and admits only a purchase paired with its purchase_reversals row', async () => {
    const def = must(
      (
        await ownerPool().query<{ d: string; o: string }>(
          `SELECT pg_get_functiondef(p.oid) AS d, pg_get_userbyid(p.proowner) AS o FROM pg_proc p WHERE p.oid = 'accounting_reversals_20_domain_source_guard()'::regprocedure`,
        )
      ).rows[0],
    );
    expect(def.o, 'owned by the accounting principal').toBe('daftar_accounting_internal');
    for (const type of [
      'inventory_adjustment',
      'inventory_opening',
      'negative_inventory_cost_adjustment',
      'supplier_return',
      'supplier_payment',
      'supplier_credit_allocation',
      'supplier_refund',
    ]) {
      expect(def.d, type).toContain(`'${type}'`);
    }
    expect(def.d).toContain('FROM purchase_reversals r');
  });
});
