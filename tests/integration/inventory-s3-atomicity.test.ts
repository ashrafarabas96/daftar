/**
 * P3-S3 T-09 — ATOMICITY AND CRASH INJECTION THROUGH THE REAL SERVICES
 * (docs/PHASE_3_S3_CONTRACT.md A-06, A-08, §6 T-04, T-09; P:197, PM-10, PM-11).
 *
 * For each financial path (opening Case A, adjustment, damage, stocktake
 * finalize) a failure is injected (a) after the routine, before the posting —
 * the posting port throws — and (b) after the posting, before COMMIT — the
 * seam's callback throws once everything has been written. For the transfer
 * (seam 1, no posting) the throw comes after the routine. Each time the H-7
 * counts of the business, and the accounting replay registry, are exactly as
 * before: no movement, document, bridge, binding, entry, audit, outbox or
 * assertion use survives. Then the SAME request, uninjected, is accepted
 * (the ALLOW), and it writes stock, the entry and both audit rows together.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../../apps/api/src/infra/database';
import { DatabaseAccountingPostingAdapter } from '../../apps/api/src/modules/accounting/accounting-posting.adapter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, counts, delta, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let db: Database;
let posting: DatabaseAccountingPostingAdapter;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'Atomicity owner');
  A = await onboardS3Business(t, owner, 'atom');
  db = t.app.get(Database);
  posting = t.app.get(DatabaseAccountingPostingAdapter, { strict: false });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  await resetData();
});

const send = (method: 'post' | 'put', path: string, body: object): Promise<Response> =>
  t.request[method](`/v1/inventory/${path}`).set(asMember(owner, A.businessId)).send(body);

async function accountingUses(): Promise<number> {
  return must((await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM accounting_assertion_uses`)).rows[0]).n;
}

/** (a) The posting port throws: the routine has run in the seam, nothing is posted. */
function failPosting(): void {
  vi.spyOn(posting, 'postEntryInTransaction').mockRejectedValueOnce(new Error('injected: after the routine, before the posting'));
}

/** (b) The two-assertion seam's callback throws after it returned: routine and posting are written, COMMIT never comes. */
function failBeforeCommit(): void {
  const original = db.withBusinessInventoryAccountingTransaction.bind(db);
  vi.spyOn(db, 'withBusinessInventoryAccountingTransaction').mockImplementationOnce((scope, inventoryAssertion, accountingAssertion, fn) =>
    original(scope, inventoryAssertion, accountingAssertion, async (tx) => {
      await fn(tx);
      throw new Error('injected: after the posting, before COMMIT');
    }),
  );
}

/** Seam 1: the inventory seam's callback throws after the routine. */
function failSeam1(): void {
  const original = db.withBusinessInventoryTransaction.bind(db);
  vi.spyOn(db, 'withBusinessInventoryTransaction').mockImplementationOnce((scope, inventoryAssertion, fn) =>
    original(scope, inventoryAssertion, async (tx) => {
      await fn(tx);
      throw new Error('injected: after the routine, before COMMIT');
    }),
  );
}

/** Inject, send, and prove the business and the accounting registry unchanged; return nothing. */
async function expectNothingSurvives(inject: () => void, call: () => Promise<Response>, what: string): Promise<void> {
  const before = await counts(ownerPool(), A.businessId);
  const uses = await accountingUses();
  inject();
  const res = await call();
  expect(res.status, `${what}: the injected failure surfaces`).toBe(500);
  expect(delta(before, await counts(ownerPool(), A.businessId)), `${what}: nothing survives`).toEqual({});
  expect(await accountingUses(), `${what}: no accounting assertion use survives`).toBe(uses);
}

/** The uninjected request: it writes the document, its stock, its entry and both audit and outbox rows together. */
async function expectAllTogether(call: () => Promise<Response>, status: number, what: string, entry: boolean): Promise<Response> {
  const before = await counts(ownerPool(), A.businessId);
  const res = await call();
  expect(res.status, `${what}: ALLOW`).toBe(status);
  const d = delta(before, await counts(ownerPool(), A.businessId));
  expect(d['stock_movements'] ?? 0, `${what}: stock moved`).toBeGreaterThan(0);
  expect(d['journal_entries'] ?? 0, `${what}: entry`).toBe(entry ? 1 : 0);
  expect(d['accounting_source_bindings'] ?? 0, `${what}: binding`).toBe(entry ? 1 : 0);
  expect(d['audit_events'], `${what}: the routine's audit row, and the entry's when there is one`).toBe(entry ? 2 : 1);
  expect(d['outbox_events'], `${what}: the routine's outbox row, and the entry's when there is one`).toBe(entry ? 2 : 1);
  expect(d['inventory_assertion_uses'], `${what}: one consumed jti`).toBe(1);
  // T-04: one commit — the accounting jti was consumed by the very transaction that consumed the inventory jti.
  const sameXact = await ownerPool().query<{ joined: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM accounting_assertion_uses a
                     WHERE a.xact = (SELECT u.xact FROM inventory_assertion_uses u WHERE u.business_id = $1 ORDER BY u.consumed_at DESC LIMIT 1)) AS joined`,
    [A.businessId],
  );
  expect(must(sameXact.rows[0]).joined, `${what}: the inventory and accounting assertions in one transaction`).toBe(entry);
  return res;
}

describe('T-09 a failure at either point of a financial command leaves nothing; the same request then commits everything together', () => {
  it('opening (Case A)', async () => {
    const body = {
      openingId: randomUUID(),
      occurredOn: day,
      lines: [
        { productId: A.piece.productId, warehouseId: A.w1, quantity: '10', unitCost: '10' },
        { productId: A.piece2.productId, warehouseId: A.w2, quantity: '4', unitCost: '2.5' },
      ],
    };
    await expectNothingSurvives(failPosting, () => send('post', 'openings', body), 'opening (a)');
    await expectNothingSurvives(failBeforeCommit, () => send('post', 'openings', body), 'opening (b)');
    const res = await expectAllTogether(() => send('post', 'openings', body), 201, 'opening', true);
    expect(res.body.replayed).toBe(false);
  });

  it('adjustment', async () => {
    const body = {
      adjustmentId: randomUUID(),
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'found in the back',
      lines: [{ productId: A.piece.productId, quantity: '2', unitCost: '13' }],
    };
    await expectNothingSurvives(failPosting, () => send('post', 'adjustments', body), 'adjustment (a)');
    await expectNothingSurvives(failBeforeCommit, () => send('post', 'adjustments', body), 'adjustment (b)');
    await expectAllTogether(() => send('post', 'adjustments', body), 201, 'adjustment', true);
  });

  it('damage', async () => {
    const body = {
      adjustmentId: randomUUID(),
      warehouseId: A.w1,
      occurredOn: day,
      reason: 'dropped',
      lines: [{ productId: A.piece.productId, quantity: '1' }],
    };
    await expectNothingSurvives(failPosting, () => send('post', 'damages', body), 'damage (a)');
    await expectNothingSurvives(failBeforeCommit, () => send('post', 'damages', body), 'damage (b)');
    await expectAllTogether(() => send('post', 'damages', body), 201, 'damage', true);
  });

  it('stocktake finalize: the draft stays a draft after each failure, then finalizes', async () => {
    const stocktakeId = randomUUID();
    expect((await send('post', 'stocktakes', { stocktakeId, warehouseId: A.w1 })).status).toBe(201);
    expect((await send('put', `stocktakes/${stocktakeId}/counts`, { lines: [{ productId: A.piece.productId, quantity: '9' }] })).status).toBe(200);
    const status = async (): Promise<string> =>
      must(
        (await ownerPool().query<{ status: string }>(`SELECT status FROM stocktakes WHERE business_id = $1 AND id = $2`, [A.businessId, stocktakeId])).rows[0],
      ).status;
    await expectNothingSurvives(failPosting, () => send('post', `stocktakes/${stocktakeId}/finalize`, { occurredOn: day }), 'finalize (a)');
    expect(await status()).toBe('draft');
    await expectNothingSurvives(failBeforeCommit, () => send('post', `stocktakes/${stocktakeId}/finalize`, { occurredOn: day }), 'finalize (b)');
    expect(await status()).toBe('draft');
    await expectAllTogether(() => send('post', `stocktakes/${stocktakeId}/finalize`, { occurredOn: day }), 200, 'finalize', true);
    expect(await status()).toBe('finalized');
  });

  it('transfer (seam 1): a throw after the routine leaves nothing; then it commits with no entry', async () => {
    const body = { transferId: randomUUID(), sourceWarehouseId: A.w1, destinationWarehouseId: A.w2, lines: [{ productId: A.piece.productId, quantity: '3' }] };
    await expectNothingSurvives(failSeam1, () => send('post', 'transfers', body), 'transfer');
    await expectAllTogether(() => send('post', 'transfers', body), 201, 'transfer', false);
  });
});
