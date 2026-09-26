/**
 * P3-S4 T-13 — ATOMICITY THROUGH THE REAL SERVICES (docs/PHASE_3_S4_CONTRACT.md
 * A-06, A-08, §2.4, §6 T-13; P:207; R-B1).
 *
 * A receipt is one transaction: the routine (stock, coverage, deficits, the
 * document, bridges, audit and outbox), the `purchase` entry, the catch-up
 * entry iff N ≠ 0, COMMIT. A failure is injected, as a named failpoint in the
 * harness only, after each step:
 *
 * - `after-routine`: the first posting throws (nothing posted yet);
 * - `after-first-post`: the purchase entry is written, the catch-up posting
 *   throws;
 * - `after-second-post`: both entries written, the seam's callback throws
 *   before COMMIT;
 * - `deferred-triggers`: the last posting takes its assertion but writes no
 *   entry, so the document's DEFERRED binding FK refuses at COMMIT itself.
 *
 * Each time the business's purchasing rows (documents, lines, coverage
 * header and rows, deficit layers, bridges, bindings, movements, cache,
 * entries, bindings, audit, outbox, assertion uses) and the accounting
 * replay registry are exactly as before. Then the SAME request, uninjected,
 * commits everything together (the ALLOW). Drafts, cancels and suppliers run
 * on seam 1 and get the after-routine failpoint.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountingPostingTransaction, PostEntryInTransactionRequest, PostingResult } from '@daftar/accounting';
import { Database } from '../../apps/api/src/infra/database';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { s4Counts, s4Delta, type Counts } from '../helpers/purchase-commands';
import { coverageVector, installCommittedDeficitFixture, removeCommittedDeficitFixture, seedCommittedDeficitKey } from '../helpers/purchase-deficits';

let t: TestApp;
let day: string;
let owner: HttpActor;
let H: S3Business;
let db: Database;
let posting: DatabaseAccountingPostingAdapter;
let supplierId: string;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  await installCommittedDeficitFixture();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'Atomicity owner');
  H = await onboardS3Business(t, owner, 's4atom');
  db = t.app.get(Database);
  posting = t.app.get(DatabaseAccountingPostingAdapter, { strict: false });
  const sup = await t.request.post('/v1/suppliers').set(asMember(owner, H.businessId)).send({ supplierId: randomUUID(), name: 'Atomic supplier' });
  expect(sup.status).toBe(201);
  supplierId = String(sup.body.id);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  await removeCommittedDeficitFixture();
  await resetData();
});

const headers = (): Record<string, string> => asMember(owner, H.businessId);

async function accountingUses(): Promise<number> {
  return must((await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_assertion_uses`)).rows[0]).n;
}

/** A one-line domestic draft through the real API; returns its id. */
async function draft(productId: string, quantity: string, unitPrice: string): Promise<string> {
  const purchaseId = randomUUID();
  const r = await t.request
    .put(`/v1/purchases/${purchaseId}`)
    .set(headers())
    .send({
      expectedRevision: 0,
      supplierId,
      warehouseId: H.w1,
      currency: 'ILS',
      documentDate: day,
      lines: [{ lineId: randomUUID(), productId, quantity, unitPrice }],
      landedCosts: [],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return purchaseId;
}

const receive = (purchaseId: string): Promise<Response> => t.request.post(`/v1/purchases/${purchaseId}/receive`).set(headers()).send({ draftRevision: 1 });

type Post = (tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest) => Promise<PostingResult>;

/** The posting adapter's own method, unmocked. */
function realPost(): Post {
  const original = posting.postEntryInTransaction.bind(posting);
  return (tx, request) => original(tx, request);
}

// ── the named failpoints ───────────────────────────────────────────────────

/** after-routine: the first posting throws; the routine has run, nothing is posted. */
function afterRoutine(): void {
  vi.spyOn(posting, 'postEntryInTransaction').mockRejectedValueOnce(new Error('failpoint after-routine'));
}

/** after-first-post: the purchase entry is written, then the catch-up posting throws. */
function afterFirstPost(): void {
  const real = realPost();
  vi.spyOn(posting, 'postEntryInTransaction').mockImplementationOnce(real).mockRejectedValueOnce(new Error('failpoint after-first-post'));
}

/** after-second-post: every entry is written, then the seam's callback throws before COMMIT. */
function afterLastPost(): void {
  const original = db.withBusinessInventoryAccountingTransaction.bind(db);
  vi.spyOn(db, 'withBusinessInventoryAccountingTransaction').mockImplementationOnce((scope, inventoryAssertion, accountingAssertions, fn) =>
    original(scope, inventoryAssertion, accountingAssertions, async (tx) => {
      await fn(tx);
      throw new Error('failpoint after-last-post');
    }),
  );
}

/**
 * deferred-triggers: the LAST posting is presented its assertion (so R-B1's
 * completeness check passes) but writes no entry — the document's deferred
 * binding FK has nothing to bind to and COMMIT itself refuses.
 */
function atCommit(postings: 1 | 2): void {
  const real = realPost();
  const skip: Post = async (tx, request) => {
    await db.presentAccountingAssertion(tx, { sourceType: request.command.sourceType, sourceId: request.command.sourceId });
    return { entryId: randomUUID(), created: true };
  };
  const spy = vi.spyOn(posting, 'postEntryInTransaction');
  if (postings === 2) spy.mockImplementationOnce(real);
  spy.mockImplementationOnce(skip);
}

/** Seam 1: the callback throws after the routine. */
function afterSeam1Routine(): void {
  const original = db.withBusinessInventoryTransaction.bind(db);
  vi.spyOn(db, 'withBusinessInventoryTransaction').mockImplementationOnce((scope, inventoryAssertion, fn) =>
    original(scope, inventoryAssertion, async (tx) => {
      await fn(tx);
      throw new Error('failpoint after-routine (seam 1)');
    }),
  );
}

async function snapshot(): Promise<{ counts: Counts; uses: number }> {
  return { counts: await s4Counts(ownerPool(), H.businessId), uses: await accountingUses() };
}

/**
 * The injected throw surfaces as 500. A refusal at COMMIT is the document's
 * deferred binding FK (23503 on PG16, 23001 on PG18), which the purchasing
 * mapping types as `accounting.inventory_detail_missing` (409, A-14(a), the
 * reverse direction of the entry-completeness trigger).
 */
async function expectNothingSurvives(inject: () => void, call: () => Promise<Response>, what: string, unboundSource?: string): Promise<void> {
  const status = unboundSource === undefined ? 500 : 409;
  const before = await snapshot();
  inject();
  const res = await call();
  vi.restoreAllMocks();
  expect(res.status, `${what}: the injected failure surfaces — ${JSON.stringify(res.body)}`).toBe(status);
  if (unboundSource !== undefined) {
    expect(res.body.error, `${what}: the COMMIT-time binding refusal`).toMatchObject({
      code: 'ACCOUNTING_REFUSED',
      details: { code: 'accounting.inventory_detail_missing', sourceType: unboundSource },
    });
  }
  const after = await snapshot();
  expect(s4Delta(before.counts, after.counts), `${what}: nothing survives`).toEqual({});
  expect(after.uses, `${what}: no accounting assertion use survives`).toBe(before.uses);
}

describe('T-13 a receipt without coverage (one entry): a failure at each point leaves nothing; then it commits', () => {
  it('after-routine, after-last-post and deferred-triggers, then the ALLOW', async () => {
    const purchaseId = await draft(H.piece2.productId, '4', '12.50');
    await expectNothingSurvives(afterRoutine, () => receive(purchaseId), 'after-routine');
    await expectNothingSurvives(afterLastPost, () => receive(purchaseId), 'after-last-post');
    await expectNothingSurvives(
      () => atCommit(1),
      () => receive(purchaseId),
      'deferred-triggers',
      'purchase',
    );

    const before = await snapshot();
    const res = await receive(purchaseId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.replayed).toBe(false);
    expect(res.body.coverage).toBeNull();
    expect(res.body.catchUpEntryId).toBeNull();
    const d = s4Delta(before.counts, (await snapshot()).counts);
    expect(d).toMatchObject({
      stock_movements: 1,
      stock_source_bindings: 1,
      stock_source_bridge_purchase: 1,
      journal_entries: 1,
      accounting_source_bindings: 1,
      // the routine's purchase.received and the entry's own row
      audit_events: 2,
      outbox_events: 2,
      inventory_assertion_uses: 1,
      purchases_state: 'changed',
      purchase_lines_state: 'changed',
    });
    expect((await snapshot()).uses - before.uses, 'one accounting jti consumed').toBe(1);
  });
});

describe('T-13 a receipt that covers a deficit (two entries): a failure after each step leaves nothing; then it commits', () => {
  it('after-routine, after-first-post, after-last-post and deferred-triggers, then the ALLOW (GOLD-54)', async () => {
    const v = coverageVector('GOLD54');
    const seed = must(v.seed[0]);
    await seedCommittedDeficitKey(H, H.w1, H.piece.variantId, seed);
    const receipt = must(v.receipts[0]);
    const line = must(receipt.lines[0]);
    // 10 at 1.20 ILS: the vector's base share of 1200.
    const purchaseId = await draft(H.piece.productId, line.qty, '1.20');

    await expectNothingSurvives(afterRoutine, () => receive(purchaseId), 'after-routine');
    await expectNothingSurvives(afterFirstPost, () => receive(purchaseId), 'after-first-post');
    await expectNothingSurvives(afterLastPost, () => receive(purchaseId), 'after-last-post');
    await expectNothingSurvives(
      () => atCommit(2),
      () => receive(purchaseId),
      'deferred-triggers',
      'negative_inventory_cost_adjustment',
    );

    const before = await snapshot();
    const res = await receive(purchaseId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.coverage.totalValueBaseMinor).toBe(receipt.expect.totalValueBaseMinor);
    expect(typeof res.body.catchUpEntryId).toBe('string');
    const d = s4Delta(before.counts, (await snapshot()).counts);
    expect(d).toMatchObject({
      stock_movements: 2,
      stock_source_bindings: 2,
      stock_source_bridge_purchase: 1,
      stock_source_bridge_negative_inventory_cost_adjustment: 1,
      negative_inventory_cost_adjustments: 1,
      negative_deficit_coverages: 1,
      deficits_state: 'changed',
      journal_entries: 2,
      accounting_source_bindings: 2,
      // purchase.received, inventory.deficit_covered and one per entry
      audit_events: 4,
      outbox_events: 4,
      inventory_assertion_uses: 1,
    });
    expect((await snapshot()).uses - before.uses, 'two accounting jtis consumed, in one transaction').toBe(2);
  });
});

describe('T-13 seam-1 commands: a throw after the routine leaves nothing; then it commits', () => {
  it('supplier create, draft create, draft replace and cancel', async () => {
    const newSupplier = randomUUID();
    const create = (): Promise<Response> => t.request.post('/v1/suppliers').set(headers()).send({ supplierId: newSupplier, name: 'Seam one supplier' });
    await expectNothingSurvives(afterSeam1Routine, create, 'supplier create');
    expect((await create()).status).toBe(201);

    const purchaseId = randomUUID();
    const body = (expectedRevision: number, quantity: string): object => ({
      expectedRevision,
      supplierId,
      warehouseId: H.w1,
      currency: 'ILS',
      documentDate: day,
      lines: [{ lineId: '0b5e1c1a-0000-4000-8000-000000000001', productId: H.dec2.productId, quantity, unitPrice: '3' }],
      landedCosts: [],
    });
    const put = (b: object): Promise<Response> => t.request.put(`/v1/purchases/${purchaseId}`).set(headers()).send(b);
    await expectNothingSurvives(afterSeam1Routine, () => put(body(0, '1.5')), 'draft create');
    expect((await put(body(0, '1.5'))).status).toBe(201);
    await expectNothingSurvives(afterSeam1Routine, () => put(body(1, '2.5')), 'draft replace');
    expect((await put(body(1, '2.5'))).status).toBe(200);
    const cancel = (): Promise<Response> => t.request.post(`/v1/purchases/${purchaseId}/cancel`).set(headers()).send({ draftRevision: 2 });
    await expectNothingSurvives(afterSeam1Routine, cancel, 'cancel');
    const res = await cancel();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });
});
