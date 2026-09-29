/**
 * P3-S5 T-13 — ATOMICITY THROUGH THE REAL SERVICES
 * (docs/PHASE_3_S5_CONTRACT.md A-06, A-08, A-09 "never partially unwinds",
 * §2.5, §6 T-13; L:760).
 *
 * A return is one transaction: the routine (the header, lines, credit note,
 * movements, bridge, audit and outbox), the `supplier_return` entry, COMMIT.
 * A reversal is one transaction: the routine, the Phase 2 reversal, COMMIT.
 * A failure is injected, as a named failpoint in the harness only, after
 * each step:
 *
 * - `after-routine`: the posting throws (the routine has run, nothing is
 *   posted yet);
 * - `after-last-post`: the entry is written, then the seam's callback throws
 *   before COMMIT;
 * - `deferred-triggers`: the posting writes no entry, so the document's
 *   DEFERRED binding FK refuses at COMMIT itself — 409
 *   `accounting.inventory_detail_missing` naming the source type.
 *
 * Each time the business's rows (documents, lines, credit notes, bridges,
 * bindings, movements, the stock cache, entries, audit, outbox, assertion
 * uses) and the accounting replay registry are exactly as before. Then the
 * SAME request, uninjected, commits everything together (the ALLOW). The
 * return is run twice: against AP only, and — through the settlement fixture
 * (TL-9, test database only) — with a supplier credit note.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountingPostingTransaction, PostEntryInTransactionRequest, PostingResult } from '@daftar/accounting';
import { Database } from '../../apps/api/src/infra/database';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { DatabaseAccountingSourcesAdapter } from '../../apps/api/src/modules/accounting/accounting-sources.adapter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { s4Delta, type Counts } from '../helpers/purchase-commands';
import { s5Counts } from '../helpers/purchase-returns';
import { installSettlementFixture, type SettlementFixture } from '../helpers/purchase-settlement-fixture';

let t: TestApp;
let day: string;
let owner: HttpActor;
let H: S3Business;
let db: Database;
let posting: DatabaseAccountingPostingAdapter;
let sources: DatabaseAccountingSourcesAdapter;
let fixture: SettlementFixture | null = null;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S5 atomicity owner');
  H = await onboardS3Business(t, owner, 's5atom');
  db = t.app.get(Database);
  posting = t.app.get(DatabaseAccountingPostingAdapter, { strict: false });
  sources = t.app.get(DatabaseAccountingSourcesAdapter, { strict: false });
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (fixture !== null) await fixture.restore();
  await t.close();
  await resetData();
});

const headers = (): Record<string, string> => asMember(owner, H.businessId);

interface HttpPurchase {
  readonly purchaseId: string;
  readonly lineId: string;
}

/** A received one-line domestic purchase of 4 at 12.50 on W1, through the real API. */
async function received(productId: string): Promise<HttpPurchase> {
  const supplierId = randomUUID();
  const s = await t.request
    .post('/v1/suppliers')
    .set(headers())
    .send({ supplierId, name: `Supplier ${supplierId.slice(0, 6)}` });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  const purchaseId = randomUUID();
  const lineId = randomUUID();
  const d = await t.request
    .put(`/v1/purchases/${purchaseId}`)
    .set(headers())
    .send({
      expectedRevision: 0,
      supplierId,
      warehouseId: H.w1,
      currency: 'ILS',
      documentDate: day,
      lines: [{ lineId, productId, quantity: '4', unitPrice: '12.50' }],
      landedCosts: [],
    });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  const r = await t.request.post(`/v1/purchases/${purchaseId}/receive`).set(headers()).send({ draftRevision: 1 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { purchaseId, lineId };
}

/**
 * The accounting jtis consumed so far — a set, not a count. The 0061 prune
 * deletes uses older than an hour, so on a long run another test's uses can
 * disappear between two reads and a count difference goes negative. What a
 * case asserts is which jtis ITS command consumed.
 */
async function accountingUses(): Promise<ReadonlySet<string>> {
  return new Set((await ownerPool().query<{ jti: string }>(`SELECT jti::text FROM accounting_assertion_uses`)).rows.map((r) => r.jti));
}

/** The jtis in `after` that were not in `before`. */
function consumedSince(before: ReadonlySet<string>, after: ReadonlySet<string>): number {
  return [...after].filter((jti) => !before.has(jti)).length;
}

async function snapshot(): Promise<{ counts: Counts; uses: ReadonlySet<string> }> {
  return { counts: await s5Counts(ownerPool(), H.businessId), uses: await accountingUses() };
}

// ── the named failpoints ───────────────────────────────────────────────────

/** after-routine (a return): the entry posting throws; the routine has run, nothing is posted. */
function returnAfterRoutine(): void {
  vi.spyOn(posting, 'postEntryInTransaction').mockRejectedValueOnce(new Error('failpoint after-routine'));
}

/** after-routine (a reversal): the Phase 2 reversal throws. */
function reversalAfterRoutine(): void {
  vi.spyOn(sources, 'postReversalInTransaction').mockRejectedValueOnce(new Error('failpoint after-routine'));
}

/** after-last-post: the entry is written, then the seam's callback throws before COMMIT. */
function afterLastPost(): void {
  const original = db.withBusinessInventoryAccountingTransaction.bind(db);
  vi.spyOn(db, 'withBusinessInventoryAccountingTransaction').mockImplementationOnce((scope, inventoryAssertion, accountingAssertions, fn) =>
    original(scope, inventoryAssertion, accountingAssertions, async (tx) => {
      await fn(tx);
      throw new Error('failpoint after-last-post');
    }),
  );
}

/** deferred-triggers (a return): the posting is presented its assertion but writes no entry. */
function returnAtCommit(): void {
  vi.spyOn(posting, 'postEntryInTransaction').mockImplementationOnce(
    async (tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest): Promise<PostingResult> => {
      await db.presentAccountingAssertion(tx, { sourceType: request.command.sourceType, sourceId: request.command.sourceId });
      return { entryId: randomUUID(), created: true };
    },
  );
}

/** deferred-triggers (a reversal): the Phase 2 reversal writes nothing. */
function reversalAtCommit(): void {
  vi.spyOn(sources, 'postReversalInTransaction').mockResolvedValueOnce({ entryId: randomUUID(), created: true });
}

/**
 * The injected throw surfaces as 500. A refusal at COMMIT is the document's
 * deferred binding FK, which the purchasing mapping types as
 * `accounting.inventory_detail_missing` (409, A-15(a)).
 */
async function expectNothingSurvives(inject: () => void, call: () => Promise<Response>, what: string, unboundSource?: string): Promise<void> {
  const before = await snapshot();
  inject();
  const res = await call();
  vi.restoreAllMocks();
  expect(res.status, `${what}: the injected failure surfaces — ${JSON.stringify(res.body)}`).toBe(unboundSource === undefined ? 500 : 409);
  if (unboundSource !== undefined) {
    expect(res.body.error, `${what}: the COMMIT-time binding refusal`).toMatchObject({
      code: 'ACCOUNTING_REFUSED',
      details: { code: 'accounting.inventory_detail_missing', sourceType: unboundSource },
    });
  }
  const after = await snapshot();
  expect(s4Delta(before.counts, after.counts), `${what}: nothing survives`).toEqual({});
  expect(consumedSince(before.uses, after.uses), `${what}: no accounting assertion use survives`).toBe(0);
}

function returnRequest(p: HttpPurchase): () => Promise<Response> {
  const body = {
    returnId: randomUUID(),
    warehouseId: H.w1,
    documentDate: day,
    reason: 'Damaged on arrival',
    lines: [{ lineId: randomUUID(), purchaseLineId: p.lineId, quantity: '1' }],
  };
  return () => t.request.post(`/v1/purchases/${p.purchaseId}/returns`).set(headers()).send(body);
}

describe('T-13 a return: a failure after each step leaves nothing; then it commits', () => {
  it('against AP: after-routine, after-last-post and deferred-triggers, then the ALLOW', async () => {
    const p = await received(H.piece.productId);
    const call = returnRequest(p);
    await expectNothingSurvives(returnAfterRoutine, call, 'after-routine');
    await expectNothingSurvives(afterLastPost, call, 'after-last-post');
    await expectNothingSurvives(returnAtCommit, call, 'deferred-triggers', 'supplier_return');

    const before = await snapshot();
    const res = await call();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.replayed).toBe(false);
    const d = s4Delta(before.counts, (await snapshot()).counts);
    expect(d).toMatchObject({
      supplier_returns: 1,
      supplier_return_lines: 1,
      stock_movements: 1,
      stock_source_bindings: 1,
      stock_source_bridge_supplier_return: 1,
      journal_entries: 1,
      accounting_source_bindings: 1,
      // the routine's purchase.returned and the entry's own row
      audit_events: 2,
      outbox_events: 2,
      inventory_assertion_uses: 1,
    });
    expect(d.supplier_credit_notes ?? 0, 'AP covers the whole carrying value: no credit note').toBe(0);
    expect(consumedSince(before.uses, (await snapshot()).uses), 'one accounting jti consumed').toBe(1);
  });

  it('with a supplier credit note (the fixture states O = 0): the same failpoints leave no credit note; then it commits with one', async () => {
    fixture = await installSettlementFixture(ownerPool());
    const p = await received(H.piece.productId);
    await fixture.set(H.businessId, p.purchaseId, { outstandingTxn: 0n });
    const call = returnRequest(p);
    await expectNothingSurvives(returnAfterRoutine, call, 'after-routine');
    await expectNothingSurvives(afterLastPost, call, 'after-last-post');
    await expectNothingSurvives(returnAtCommit, call, 'deferred-triggers', 'supplier_return');

    const before = await snapshot();
    const res = await call();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const d = s4Delta(before.counts, (await snapshot()).counts);
    expect(d).toMatchObject({ supplier_returns: 1, supplier_credit_notes: 1, journal_entries: 1, inventory_assertion_uses: 1 });
    await fixture.restore();
    fixture = null;
  });
});

describe('T-13 a reversal: a failure after each step leaves nothing; then it commits', () => {
  it('after-routine, after-last-post and deferred-triggers, then the ALLOW', async () => {
    const p = await received(H.piece2.productId);
    const call = (): Promise<Response> =>
      t.request.post(`/v1/purchases/${p.purchaseId}/reversal`).set(headers()).send({ reversalDate: day, reason: 'Received against the wrong supplier' });
    await expectNothingSurvives(reversalAfterRoutine, call, 'after-routine');
    await expectNothingSurvives(afterLastPost, call, 'after-last-post');
    await expectNothingSurvives(reversalAtCommit, call, 'deferred-triggers', 'reversal');

    const before = await snapshot();
    const res = await call();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.replayed).toBe(false);
    const d = s4Delta(before.counts, (await snapshot()).counts);
    expect(d).toMatchObject({
      purchase_reversals: 1,
      purchase_reversal_lines: 1,
      stock_movements: 1,
      stock_source_bindings: 1,
      stock_source_bridge_purchase_reversal: 1,
      journal_entries: 1,
      accounting_reversals: 1,
      audit_events: 2,
      outbox_events: 2,
      inventory_assertion_uses: 1,
    });
    expect(consumedSince(before.uses, (await snapshot()).uses), 'one accounting jti consumed').toBe(1);
  });
});
