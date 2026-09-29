/**
 * P3-S6 T-13 — RECEIVE AND PAY IN ONE COMMAND (AL-24)
 * (docs/PHASE_3_S6_CONTRACT.md A-19, TL-11, §6 T-13; PM-22).
 *
 * `POST /v1/purchases/:id/receive-and-pay` is ONE transaction — the S4
 * receipt unchanged, then a one-allocation supplier payment dated the
 * document date:
 *   - the purchase entry is identical, line for line, to the entry of the
 *     same purchase received on credit (`POST …/receive`); the payment's
 *     `supplier_payment` entry follows it, and a partial immediate payment
 *     leaves `T − a` outstanding;
 *   - a failure in the payment half rolls the RECEIPT back too — nothing
 *     survives (no movement, no purchase entry, the purchase still a draft):
 *     the payment posting throws (after-routine), the seam's callback throws
 *     after the last post (after-last-post), the payment posting writes no
 *     entry (deferred-triggers: 409 `accounting.inventory_detail_missing` at
 *     COMMIT); then the SAME request commits everything (the ALLOW);
 *   - a replay answers the stored rows (200, `replayed`) and writes nothing;
 *   - a purchase already received by `POST …/receive` is
 *     `purchase.state_invalid` (409): its receipt belongs to another command;
 *   - an omitted applied amount requires the purchase currency
 *     (`supplier_payment.allocations_invalid`, 400).
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountingPostingTransaction, PostEntryInTransactionRequest, PostingResult } from '@daftar/accounting';
import { Database } from '../../apps/api/src/infra/database';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { s4Delta } from '../helpers/purchase-commands';
import {
  expectRefusal,
  httpDraft,
  httpMethod,
  outstandingOf,
  s6Counts,
  seedSettlementAccounts,
  settlementEntry,
  type HttpPurchase,
  type SettlementAccounts,
  type SettlementLine,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let method: string;
let db: Database;
let posting: DatabaseAccountingPostingAdapter;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 receive-and-pay owner');
  A = await onboardS3Business(t, owner, 's6rap');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.cash);
  db = t.app.get(Database);
  posting = t.app.get(DatabaseAccountingPostingAdapter, { strict: false });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  await resetData();
});

const headers = (): Record<string, string> => asMember(owner, A.businessId);
const LINES = [{ productId: '', quantity: '4', unitPrice: '12.50' }];

function draft(): Promise<HttpPurchase> {
  return httpDraft(t, owner, A, { lines: LINES.map((l) => ({ ...l, productId: A.piece.productId })) });
}

function body(o: { amountMinor?: string; applied?: string | null; currencyCode?: string; paymentMethodId?: string } = {}): Record<string, unknown> {
  return {
    draftRevision: 1,
    payment: {
      paymentId: randomUUID(),
      allocationId: randomUUID(),
      paymentMethodId: o.paymentMethodId ?? method,
      currencyCode: o.currencyCode ?? 'ILS',
      amountMinor: o.amountMinor ?? '5000',
      ...(o.applied === undefined ? {} : { purchaseAmountAppliedMinor: o.applied }),
    },
  };
}

function send(p: HttpPurchase, b: Record<string, unknown>): Promise<Response> {
  return t.request.post(`/v1/purchases/${p.purchaseId}/receive-and-pay`).set(headers()).send(b);
}

/** A purchase entry's lines without their ids. */
function shape(lines: readonly SettlementLine[]): Omit<SettlementLine, 'accountId'>[] {
  return lines.map(({ accountId: _a, ...rest }) => rest);
}

async function status(purchaseId: string): Promise<string> {
  return must(
    (await ownerPool().query<{ s: string }>(`SELECT status AS s FROM purchases WHERE business_id = $1 AND id = $2`, [A.businessId, purchaseId])).rows[0],
  ).s;
}

describe('T-13 PM-22: one command, the credit purchase’s entry, then the payment', () => {
  it('the purchase entry equals the same purchase received on credit; the payment entry is dated the document date; partial is allowed', async () => {
    const credit = await draft();
    const received = await t.request.post(`/v1/purchases/${credit.purchaseId}/receive`).set(headers()).send({ draftRevision: 1 });
    expect(received.status, JSON.stringify(received.body)).toBe(200);

    const p = await draft();
    const before = await s6Counts(ownerPool(), A.businessId);
    const b = body({ amountMinor: '3000' });
    const r = await send(p, b);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ purchaseId: p.purchaseId, replayed: false, receipt: { purchaseId: p.purchaseId, totalTxnMinor: '5000', replayed: false } });
    expect(await status(p.purchaseId)).toBe('received');
    const payment = (r.body as { payment: { paymentDate: string; allocations: { allocationId: string; purchaseAmountAppliedMinor: string }[] } }).payment;
    expect(payment.paymentDate, 'payment_date = document_date').toBe(p.documentDate);
    expect(payment.allocations.map((a) => a.purchaseAmountAppliedMinor)).toEqual(['3000']);
    const d = s4Delta(before, await s6Counts(ownerPool(), A.businessId));
    expect(d).toMatchObject({ supplier_payments: 1, supplier_payment_allocations: 1, journal_entries: 2, stock_movements: 1, inventory_assertion_uses: 2 });

    const creditEntry = must(await settlementEntry(ownerPool(), A.businessId, 'purchase', credit.purchaseId));
    const payEntry = must(await settlementEntry(ownerPool(), A.businessId, 'purchase', p.purchaseId));
    expect(shape(payEntry.lines), 'the purchase entry is the credit purchase’s').toEqual(shape(creditEntry.lines));
    const settlement = must(await settlementEntry(ownerPool(), A.businessId, 'supplier_payment', must(payment.allocations[0]).allocationId));
    expect(settlement.entryDate).toBe(p.documentDate);
    expect(settlement.lines.map((l) => [l.systemKey, l.side, l.baseAmountMinor])).toEqual([
      ['accounts_payable', 'D', '3000'],
      ['cash', 'C', '3000'],
    ]);
    expect(await outstandingOf(ownerPool(), A.businessId, p.purchaseId), 'a partial immediate payment leaves T − a').toMatchObject({ o: 2000n, t: 5000n });
  });
});

describe('T-13 a failure in the payment half rolls the receipt back', () => {
  /** after-routine: the supplier_payment posting throws; the receipt's own posting runs. */
  function paymentPostingThrows(): void {
    const original = posting.postEntryInTransaction.bind(posting);
    vi.spyOn(posting, 'postEntryInTransaction').mockImplementation(async (tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest) => {
      if (request.command.sourceType === 'supplier_payment') throw new Error('failpoint after-routine');
      return original(tx, request);
    });
  }

  /** after-last-post: every entry is written, then the seam's callback throws before COMMIT. */
  function afterLastPost(): void {
    const original = db.withBusinessInventoryAccountingTransaction.bind(db);
    vi.spyOn(db, 'withBusinessInventoryAccountingTransaction').mockImplementationOnce((scope, inventoryAssertions, accountingAssertions, fn) =>
      original(scope, inventoryAssertions, accountingAssertions, async (tx) => {
        await fn(tx);
        throw new Error('failpoint after-last-post');
      }),
    );
  }

  /** deferred-triggers: the supplier_payment posting is presented its assertion but writes no entry. */
  function paymentPostingWritesNothing(): void {
    const original = posting.postEntryInTransaction.bind(posting);
    vi.spyOn(posting, 'postEntryInTransaction').mockImplementation(
      async (tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest): Promise<PostingResult> => {
        if (request.command.sourceType !== 'supplier_payment') return original(tx, request);
        await db.presentAccountingAssertion(tx, { sourceType: request.command.sourceType, sourceId: request.command.sourceId });
        return { entryId: randomUUID(), created: true };
      },
    );
  }

  async function nothingSurvives(p: HttpPurchase, inject: () => void, b: Record<string, unknown>, what: string, atCommit: boolean): Promise<void> {
    const before = await s6Counts(ownerPool(), A.businessId);
    inject();
    const r = await send(p, b);
    vi.restoreAllMocks();
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(atCommit ? 409 : 500);
    if (atCommit) {
      expect(r.body.error, `${what}: the COMMIT-time binding refusal`).toMatchObject({
        code: 'ACCOUNTING_REFUSED',
        details: { code: 'accounting.inventory_detail_missing', sourceType: 'supplier_payment' },
      });
    }
    expect(s4Delta(before, await s6Counts(ownerPool(), A.businessId)), `${what}: nothing survives, the receipt included`).toEqual({});
    expect(await status(p.purchaseId), `${what}: still a draft`).toBe('draft');
  }

  it('after-routine, after-last-post and deferred-triggers leave the purchase a draft with nothing written; then the same request commits', async () => {
    const p = await draft();
    const b = body();
    await nothingSurvives(p, paymentPostingThrows, b, 'after-routine', false);
    await nothingSurvives(p, afterLastPost, b, 'after-last-post', false);
    await nothingSurvives(p, paymentPostingWritesNothing, b, 'deferred-triggers', true);
    const r = await send(p, b);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.replayed).toBe(false);
    expect(await status(p.purchaseId)).toBe('received');
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o, 'paid in full').toBe(0n);
  });
});

describe('T-13 replay and the refusals', () => {
  it('a replay answers the stored rows and writes nothing', async () => {
    const p = await draft();
    const b = body();
    const first = await send(p, b);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const before = await s6Counts(ownerPool(), A.businessId);
    const again = await send(p, b);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.payment).toEqual(first.body.payment);
    expect(s4Delta(before, await s6Counts(ownerPool(), A.businessId)), 'a replay writes nothing').toEqual({});
  });

  it('a purchase already received by POST …/receive is purchase.state_invalid, and nothing is paid', async () => {
    const p = await draft();
    const received = await t.request.post(`/v1/purchases/${p.purchaseId}/receive`).set(headers()).send({ draftRevision: 1 });
    expect(received.status).toBe(200);
    const before = await s6Counts(ownerPool(), A.businessId);
    expectRefusal(await send(p, body()), 409, 'purchase.state_invalid', 'received by another command');
    expect(s4Delta(before, await s6Counts(ownerPool(), A.businessId))).toEqual({});
    expect((await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o).toBe(5000n);
  });

  it('an omitted applied amount in another currency is supplier_payment.allocations_invalid (400) before anything is written', async () => {
    const p = await draft();
    const before = await s6Counts(ownerPool(), A.businessId);
    expectRefusal(await send(p, body({ currencyCode: 'USD' })), 400, 'supplier_payment.allocations_invalid', 'no applied amount across currencies');
    expect(s4Delta(before, await s6Counts(ownerPool(), A.businessId))).toEqual({});
    expect(await status(p.purchaseId)).toBe('draft');
  });
});
