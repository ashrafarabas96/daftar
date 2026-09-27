/**
 * P3-S6 — ATOMICITY OF EVERY S6 COMMAND THROUGH THE REAL SERVICES
 * (docs/PHASE_3_S6_CONTRACT.md A-05, A-07, A-10, A-13; the S5 T-13 form).
 *
 * Each command is one transaction: the routine (the document, the note's
 * decrement, audit, outbox, the assertion use), its entries, COMMIT. A
 * failure is injected, as a named failpoint in the harness only:
 *
 * - `after-routine`: a posting throws once the routine has run — for a
 *   two-allocation payment, the SECOND allocation's posting, after the
 *   first entry is written;
 * - `after-last-post`: every entry is written, then the seam's callback
 *   throws before COMMIT;
 * - `deferred-triggers`: a posting is presented its assertion but writes no
 *   entry, so the document's DEFERRED binding refuses at COMMIT itself —
 *   409 `accounting.inventory_detail_missing` naming the source type.
 *
 * Each time every business row (documents, allocations, notes, entries,
 * bindings, audit, outbox, assertion uses) is exactly as before — the
 * purchase's outstanding and the note's remaining pair included. Then the
 * SAME request, uninjected, commits (the ALLOW). A method command (seam 1,
 * no posting) is atomic the same way.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountingPostingTransaction, PostEntryInTransactionRequest, PostingResult } from '@daftar/accounting';
import { Database } from '../../apps/api/src/infra/database';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  allocateBody,
  httpMethod,
  httpReceived,
  methodBody,
  noteOf,
  outstandingOf,
  payBody,
  refundBody,
  returnToCredit,
  s6Counts,
  seedSettlementAccounts,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let method: string;
let day: string;
let db: Database;
let posting: DatabaseAccountingPostingAdapter;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 atomicity owner');
  A = await onboardS3Business(t, owner, 's6atom');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
  db = t.app.get(Database);
  posting = t.app.get(DatabaseAccountingPostingAdapter, { strict: false });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  await resetData();
});

type Failpoint = 'after-routine' | 'after-last-post' | 'deferred-triggers';

/** Arm `fp` for the next request whose entries are of `sourceType`; `nth` picks which of its postings fails (1-based). */
function arm(fp: Failpoint, sourceType: string, nth = 1): void {
  const original = posting.postEntryInTransaction.bind(posting);
  let seen = 0;
  if (fp === 'after-routine') {
    vi.spyOn(posting, 'postEntryInTransaction').mockImplementation(async (tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest) => {
      if (request.command.sourceType === sourceType && ++seen === nth) throw new Error(`failpoint after-routine (${sourceType} #${nth})`);
      return original(tx, request);
    });
  } else if (fp === 'deferred-triggers') {
    vi.spyOn(posting, 'postEntryInTransaction').mockImplementation(
      async (tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest): Promise<PostingResult> => {
        if (request.command.sourceType !== sourceType || ++seen !== nth) return original(tx, request);
        await db.presentAccountingAssertion(tx, { sourceType: request.command.sourceType, sourceId: request.command.sourceId });
        return { entryId: randomUUID(), created: true };
      },
    );
  } else {
    const seam = db.withBusinessInventoryAccountingTransaction.bind(db);
    vi.spyOn(db, 'withBusinessInventoryAccountingTransaction').mockImplementationOnce((scope, inventoryAssertions, accountingAssertions, fn) =>
      seam(scope, inventoryAssertions, accountingAssertions, async (tx) => {
        await fn(tx);
        throw new Error('failpoint after-last-post');
      }),
    );
  }
}

const post = (path: string, body: Record<string, unknown>): Promise<Response> => t.request.post(path).set(asMember(owner, A.businessId)).send(body);

/** Every failpoint leaves everything as it was (and `extra` unchanged); then the same request commits. */
async function atomic(path: string, body: Record<string, unknown>, sourceType: string, nth: number, extra: () => Promise<unknown>, ok: number): Promise<void> {
  for (const fp of ['after-routine', 'after-last-post', 'deferred-triggers'] as const) {
    const before = await s6Counts(ownerPool(), A.businessId);
    const extraBefore = await extra();
    arm(fp, sourceType, nth);
    const r = await post(path, body);
    vi.restoreAllMocks();
    if (fp === 'deferred-triggers') {
      expect(r.status, `${fp}: ${JSON.stringify(r.body)}`).toBe(409);
      expect(r.body.error, `${fp}: the COMMIT-time binding refusal`).toMatchObject({
        code: 'ACCOUNTING_REFUSED',
        details: { code: 'accounting.inventory_detail_missing', sourceType },
      });
    } else {
      expect(r.status, `${fp}: ${JSON.stringify(r.body)}`).toBe(500);
    }
    expect(await s6Counts(ownerPool(), A.businessId), `${fp}: nothing survives`).toEqual(before);
    expect(await extra(), `${fp}: the settled state is unchanged`).toEqual(extraBefore);
  }
  const r = await post(path, body);
  expect(r.status, `the same request, uninjected: ${JSON.stringify(r.body)}`).toBe(ok);
  expect((r.body as { replayed: boolean }).replayed).toBe(false);
}

describe('S6 atomicity: each command is one transaction', () => {
  it('a two-allocation payment: a failure at the second allocation’s posting leaves neither allocation nor the first entry', async () => {
    const p1 = await httpReceived(t, owner, A);
    const p2 = await httpReceived(t, owner, A, { supplierId: p1.supplierId });
    const body = payBody(p1.supplierId, method, day, [
      { purchaseId: p1.purchaseId, paymentAmountMinor: '1000' },
      { purchaseId: p2.purchaseId, paymentAmountMinor: '2000' },
    ]);
    const outstanding = async (): Promise<bigint[]> => [
      (await outstandingOf(ownerPool(), A.businessId, p1.purchaseId)).o,
      (await outstandingOf(ownerPool(), A.businessId, p2.purchaseId)).o,
    ];
    await atomic('/v1/supplier-payments', body, 'supplier_payment', 2, outstanding, 201);
    expect(await outstanding()).toEqual([4000n, 3000n]);
  });

  it('a credit allocation: the note’s remaining pair and the purchase’s outstanding survive every failure', async () => {
    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '50.00' }], quantity: '2' });
    const p = await httpReceived(t, owner, A, { supplierId: note.purchase.supplierId });
    const state = async (): Promise<unknown> => [
      await noteOf(ownerPool(), A.businessId, note.creditNoteId),
      (await outstandingOf(ownerPool(), A.businessId, p.purchaseId)).o,
    ];
    await atomic('/v1/supplier-credit-allocations', allocateBody(note.creditNoteId, p.purchaseId, day, '1500'), 'supplier_credit_allocation', 1, state, 201);
    expect(await noteOf(ownerPool(), A.businessId, note.creditNoteId)).toMatchObject({ remaining: 8500n, remainingCarrying: 8500n });
  });

  it('a refund: the note’s remaining pair survives every failure', async () => {
    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece2.productId, quantity: '2', unitPrice: '50.00' }], quantity: '2' });
    const state = (): Promise<unknown> => noteOf(ownerPool(), A.businessId, note.creditNoteId);
    await atomic('/v1/supplier-refunds', refundBody(note.creditNoteId, method, day, '2500'), 'supplier_refund', 1, state, 201);
    expect(await noteOf(ownerPool(), A.businessId, note.creditNoteId)).toMatchObject({ remaining: 7500n, remainingCarrying: 7500n });
  });

  it('a method command (seam 1): a failure after the routine leaves no method, no name, no audit, no assertion use', async () => {
    const body = methodBody(acc.settlement.cash, { names: { en: 'Atomic till' } });
    const before = await s6Counts(ownerPool(), A.businessId);
    const seam = db.withBusinessInventoryTransaction.bind(db);
    vi.spyOn(db, 'withBusinessInventoryTransaction').mockImplementationOnce((scope, assertion, fn) =>
      seam(scope, assertion, async (tx) => {
        await fn(tx);
        throw new Error('failpoint after-routine');
      }),
    );
    const r = await post('/v1/payment-methods', body);
    vi.restoreAllMocks();
    expect(r.status, JSON.stringify(r.body)).toBe(500);
    expect(await s6Counts(ownerPool(), A.businessId)).toEqual(before);
    expect((await post('/v1/payment-methods', body)).status).toBe(201);
  });
});
