/**
 * P3-S6 T-14 — THE INVENTORY-ASSERTION SEQUENCE UNDER THE REAL ROUTINES
 * (docs/PHASE_3_S6_CONTRACT.md A-19, §6 T-14).
 *
 * Pure first — the combined command's own pair (`purchase.receive`, then
 * `supplier.pay`) through `InventoryAssertionSequence.plan`: a single string
 * (or a one-element tuple) is the old seam; two start the GUC empty; the
 * rules `unused`, `exhausted`, `operation_mismatch`, `malformed` (a
 * duplicate), `missing` (empty) and `scope_mismatch` (another business).
 *
 * Then live, through the application's own seam 2 and the REAL 0068 routine:
 *   - fail-closed: `supplier_pay` called before its assertion is presented
 *     sees an empty GUC → `inventory.assertion_missing`; called while the
 *     `purchase.receive` element is presented → `inventory.assertion_wrong_operation`;
 *     presented in order, the honest payment is accepted, and a commit that
 *     left the `supplier.pay` element unpresented rolls everything back;
 *   - the combined command takes the payment key FIRST: raced against a
 *     `POST /v1/supplier-payments` of the SAME payment id (another purchase),
 *     every round ends with exactly one payment under that id and the other
 *     command a clean 409 `supplier_payment.idempotency_conflict` — never a
 *     deadlock, never a 500 — and a losing receive-and-pay leaves its draft
 *     a draft with no movement and no entry.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InventoryOperationCode } from '@daftar/inventory';
import { Database, InventoryAssertionSequence, presentInventoryAssertion, TransactionSeamError, type BusinessScope } from '../../apps/api/src/infra/database';
import { createTestApp, ensurePostgres, mintTestInventoryAssertion, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  httpDraft,
  httpMethod,
  httpPay,
  httpReceived,
  mintSettlementPosting,
  payBody,
  preparePay,
  refusalCode,
  s6AssertionFor,
  seedSettlementAccounts,
  settleConcurrently,
  sqlOf,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

function seamCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof TransactionSeamError) return e.code;
    throw e;
  }
  return 'accepted';
}

/** The stable code a refused seam run ends with: a seam code, or the routine's `code:` message prefix. */
async function outcomeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof TransactionSeamError) return e.code;
    if (e instanceof Error) return must(e.message.split(':')[0]);
    throw e;
  }
  return 'accepted';
}

describe('T-14 InventoryAssertionSequence — the pure rules of the combined command', () => {
  const scope: BusinessScope = { tenantId: randomUUID(), businessId: randomUUID(), actorUserId: randomUUID(), businessTransactionId: randomUUID() };
  const mint = (opCode: InventoryOperationCode, businessId = scope.businessId): string =>
    mintTestInventoryAssertion({ actorUserId: scope.actorUserId, tenantId: scope.tenantId, businessId, opCode, payloadSha256: 'a'.repeat(64) });

  it('single-string form unchanged; the pair starts empty and hands out receive then pay; unused / exhausted / mismatch / duplicate / scope', () => {
    const receive = mint('purchase.receive');
    const pay = mint('supplier.pay');
    for (const form of [pay, [pay] as const]) {
      const single = InventoryAssertionSequence.plan(scope, form);
      expect({ guc: single.guc, sequence: single.sequence, op: single.singleOperation }).toEqual({ guc: pay, sequence: null, op: 'supplier.pay' });
    }
    const plan = InventoryAssertionSequence.plan(scope, [receive, pay]);
    expect(plan.guc, 'with two, the GUC starts empty').toBe('');
    const seq = must(plan.sequence);
    expect(seamCode(() => seq.assertComplete())).toBe('seam.inventory_assertion_unused');
    expect(
      seamCode(() => seq.next('supplier.pay')),
      'the payment before the receipt',
    ).toBe('seam.inventory_assertion_operation_mismatch');
    expect(seq.next('purchase.receive')).toBe(receive);
    expect(
      seamCode(() => seq.assertComplete()),
      'the payment unpresented',
    ).toBe('seam.inventory_assertion_unused');
    expect(seq.next('supplier.pay')).toBe(pay);
    expect(seamCode(() => seq.assertComplete())).toBe('accepted');
    expect(seamCode(() => seq.next('supplier.pay'))).toBe('seam.inventory_assertion_exhausted');
    expect(seamCode(() => InventoryAssertionSequence.plan(scope, [pay, pay]))).toBe('seam.inventory_assertion_malformed');
    expect(seamCode(() => Reflect.apply(InventoryAssertionSequence.plan, InventoryAssertionSequence, [scope, []]))).toBe('seam.inventory_assertion_missing');
    expect(seamCode(() => InventoryAssertionSequence.plan(scope, [receive, mint('supplier.pay', randomUUID())]))).toBe(
      'seam.inventory_assertion_scope_mismatch',
    );
  });
});

let t: TestApp;
let db: Database;
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
  db = t.app.get(Database);
  owner = await registerActor(t, 'S6 seam owner');
  A = await onboardS3Business(t, owner, 's6seam');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
});

afterAll(async () => {
  await t.close();
  await resetData();
});

describe('T-14 live: the real supplier_pay routine inside seam 2', () => {
  /** A received purchase and an honest payment bound over it, with its signed pair and its accounting assertion. */
  async function bound(): Promise<{ scope: BusinessScope; params: unknown[]; pair: [string, string]; accounting: string; paymentId: string }> {
    const p = await httpReceived(t, owner, A);
    const call = await preparePay(ownerPool(), A, {
      supplierId: p.supplierId,
      paymentMethodId: method,
      allocations: [{ purchaseId: p.purchaseId, paymentAmountMinor: 1000n }],
    });
    const scope: BusinessScope = { tenantId: A.tenantId, businessId: A.businessId, actorUserId: A.userId, businessTransactionId: call.trace };
    const receive = mintTestInventoryAssertion({
      actorUserId: A.userId,
      tenantId: A.tenantId,
      businessId: A.businessId,
      opCode: 'purchase.receive',
      payloadSha256: 'b'.repeat(64),
    });
    return {
      scope,
      params: [...call.params],
      pair: [receive, s6AssertionFor(A, call)],
      accounting: mintSettlementPosting(must(call.postings[0]), A.userId),
      paymentId: String(call.params[0]),
    };
  }

  const payments = async (id: string): Promise<number> =>
    must(
      (await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM supplier_payments WHERE business_id = $1 AND id = $2`, [A.businessId, id]))
        .rows[0],
    ).n;

  it('before its element is presented, the routine sees an empty GUC: assertion_missing; under the receive element: wrong_operation', async () => {
    const b = await bound();
    expect(
      await outcomeOf(() => db.withBusinessInventoryAccountingTransaction(b.scope, b.pair, b.accounting, async (tx) => tx.query(sqlOf('pay'), b.params))),
    ).toBe('inventory.assertion_missing');
    expect(
      await outcomeOf(() =>
        db.withBusinessInventoryAccountingTransaction(b.scope, b.pair, b.accounting, async (tx) => {
          await presentInventoryAssertion(tx, 'purchase.receive');
          return tx.query(sqlOf('pay'), b.params);
        }),
      ),
    ).toBe('inventory.assertion_wrong_operation');
    expect(await payments(b.paymentId), 'nothing committed').toBe(0);
  });

  it('presented in order the routine accepts; a commit that left the pay element unpresented rolls back', async () => {
    const b = await bound();
    // The receive element is presented and not consumed by any routine here; the pay element is presented and consumed.
    expect(
      await outcomeOf(() =>
        db.withBusinessInventoryAccountingTransaction(b.scope, b.pair, b.accounting, async (tx) => {
          await presentInventoryAssertion(tx, 'purchase.receive');
          await presentInventoryAssertion(tx, 'supplier.pay');
          const r = await tx.query<{ replayed: boolean }>(sqlOf('pay'), b.params);
          expect(must(r.rows[0]).replayed).toBe(false);
          throw new Error('probe.rollback: the routine accepted');
        }),
      ),
    ).toBe('probe.rollback');
    expect(
      await outcomeOf(() =>
        db.withBusinessInventoryAccountingTransaction(b.scope, b.pair, b.accounting, async (tx) => {
          await presentInventoryAssertion(tx, 'purchase.receive');
        }),
      ),
    ).toBe('seam.inventory_assertion_unused');
    expect(await payments(b.paymentId), 'nothing committed').toBe(0);
  });
});

describe('T-14 the combined command takes the payment key first', () => {
  it('raced against a standalone payment of the same id: exactly one payment, the other a clean 409 — never a deadlock or a 500', async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 6; round += 1) {
      const draft = await httpDraft(t, owner, A);
      const other = await httpReceived(t, owner, A, { supplierId: draft.supplierId });
      const paymentId = randomUUID();
      const standalone = { ...payBody(other.supplierId, method, day, [{ purchaseId: other.purchaseId, paymentAmountMinor: '1000' }]), paymentId };
      const combined = {
        draftRevision: 1,
        payment: { paymentId, allocationId: randomUUID(), paymentMethodId: method, currencyCode: 'ILS', amountMinor: '1000' },
      };
      const outcomes = await settleConcurrently<Response>(2, (i) =>
        i === 0
          ? Promise.resolve(t.request.post(`/v1/purchases/${draft.purchaseId}/receive-and-pay`).set(asMember(owner, A.businessId)).send(combined))
          : httpPay(t, owner, A, standalone),
      );
      const [rp, sp] = outcomes.map((o, i) => {
        if (!o.ok) throw new Error(`round ${round}: request ${i} failed: ${o.message}`);
        return o.value;
      });
      const r = must(rp);
      const s = must(sp);
      const statuses = `${r.status}/${s.status} ${JSON.stringify([r.body, s.body])}`;
      expect(
        [r.status, s.status].filter((x) => x >= 500),
        statuses,
      ).toEqual([]);
      const winners = [r.status === 200, s.status === 201].filter(Boolean).length;
      expect(winners, `round ${round}: exactly one command pays under the id — ${statuses}`).toBe(1);
      const loser = r.status === 200 ? s : r;
      expect({ status: loser.status, code: refusalCode(loser) }, statuses).toEqual({ status: 409, code: 'supplier_payment.idempotency_conflict' });
      const rows = await ownerPool().query<{ purchase_id: string }>(
        `SELECT a.purchase_id::text FROM supplier_payment_allocations a WHERE a.business_id = $1 AND a.payment_id = $2`,
        [A.businessId, paymentId],
      );
      expect(rows.rows.map((x) => x.purchase_id)).toEqual([r.status === 200 ? draft.purchaseId : other.purchaseId]);
      if (r.status !== 200) {
        const state = must(
          (
            await ownerPool().query<{ status: string; movements: number; entries: number }>(
              `SELECT p.status,
                      (SELECT count(*)::int FROM stock_movements m WHERE m.business_id = p.business_id AND m.source_id = p.id) AS movements,
                      (SELECT count(*)::int FROM journal_entries e WHERE e.business_id = p.business_id AND e.source_id = p.id) AS entries
                 FROM purchases p WHERE p.business_id = $1 AND p.id = $2`,
              [A.businessId, draft.purchaseId],
            )
          ).rows[0],
        );
        expect(state, 'the losing receive-and-pay rolled its receipt back').toEqual({ status: 'draft', movements: 0, entries: 0 });
      }
      seen.add(r.status === 200 ? 'combined' : 'standalone');
    }
    // Which one wins is the scheduler's; both outcomes are clean. Record which were exercised.
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });
});
