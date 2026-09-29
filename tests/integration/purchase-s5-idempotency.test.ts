/**
 * P3-S5 T-11 — IDEMPOTENCY OF THE RETURN AND THE REVERSAL
 * (docs/PHASE_3_S5_CONTRACT.md A-08, A-17, §2.5, §6 T-11; P:215 analogue).
 *
 * Through the real Nest application and the real database:
 *   1. a retried return answers the stored return (200, `replayed: true`,
 *      the first operation's trace) and a retried reversal the stored
 *      reversal: no mint, no second movement or entry, nothing written;
 *   2. the proof comes before the state: once the returned product is
 *      archived, a fresh return over it is refused, yet the retried return
 *      still replays with zero mints; once a reversed purchase's product is
 *      archived, the retried reversal still replays;
 *   3. two identical returns, and two identical reversals, racing past the
 *      proof: one commits, the other meets it inside the routine and
 *      replays there; its accounting assertion is never consumed (it
 *      expires unused) and exactly one entry and one movement set exist.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { splitAccountingAssertion } from '@daftar/accounting';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { AccountingAssertionMinterService } from '../../apps/api/src/modules/accounting/accounting-assertion.minter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, ownerClient, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { s4Delta } from '../helpers/purchase-commands';
import { s5Counts } from '../helpers/purchase-returns';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let mint: MockInstance<InventoryAssertionMinterService['mint']>;
let acctMint: MockInstance<AccountingAssertionMinterService['mint']>;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S5 idempotency owner');
  A = await onboardS3Business(t, owner, 's5idem');
  mint = vi.spyOn(t.app.get(InventoryAssertionMinterService), 'mint');
  acctMint = vi.spyOn(t.app.get(AccountingAssertionMinterService), 'mint');
});

beforeEach(() => {
  mint.mockClear();
  acctMint.mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await t.close();
  await resetData();
});

const as = (): Record<string, string> => asMember(owner, A.businessId);

interface HttpPurchase {
  readonly purchaseId: string;
  readonly lineId: string;
}

/** A received purchase of `quantity` of `productId` at 12.50 on W1, made through the API. */
async function received(productId: string, quantity: string): Promise<HttpPurchase> {
  const supplierId = randomUUID();
  const s = await t.request
    .post('/v1/suppliers')
    .set(as())
    .send({ supplierId, name: `Supplier ${supplierId.slice(0, 6)}` });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  const purchaseId = randomUUID();
  const lineId = randomUUID();
  const d = await t.request
    .put(`/v1/purchases/${purchaseId}`)
    .set(as())
    .send({
      expectedRevision: 0,
      supplierId,
      warehouseId: A.w1,
      currency: 'ILS',
      documentDate: day,
      lines: [{ lineId, productId, quantity, unitPrice: '12.50' }],
      landedCosts: [],
    });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  const r = await t.request.post(`/v1/purchases/${purchaseId}/receive`).set(as()).send({ draftRevision: 1 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { purchaseId, lineId };
}

function returnBody(p: HttpPurchase, quantity: string): Record<string, unknown> {
  return {
    returnId: randomUUID(),
    warehouseId: A.w1,
    documentDate: day,
    reason: 'Damaged on arrival',
    lines: [{ lineId: randomUUID(), purchaseLineId: p.lineId, quantity }],
  };
}

const REVERSAL = { reversalDate: '', reason: 'Received against the wrong supplier' };
const reversalBody = (): Record<string, unknown> => ({ ...REVERSAL, reversalDate: day });

const postReturn = (p: HttpPurchase, body: Record<string, unknown>): Promise<Response> =>
  t.request.post(`/v1/purchases/${p.purchaseId}/returns`).set(as()).send(body);
const postReversal = (p: HttpPurchase): Promise<Response> => t.request.post(`/v1/purchases/${p.purchaseId}/reversal`).set(as()).send(reversalBody());

/** Start a request now (supertest is lazy) and settle it later. */
function started(path: string, body: Record<string, unknown>): Promise<Response> {
  return new Promise((resolve, reject) => {
    t.request
      .post(path)
      .set(as())
      .send(body)
      .end((err: Error | null, res: Response) => (err === null ? resolve(res) : reject(err)));
  });
}

async function entriesOf(sourceType: string, sourceId: string): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_type = $2 AND source_id = $3`,
    [A.businessId, sourceType, sourceId],
  );
  return must(r.rows[0]).n;
}

/** The reversal entries of a purchase's entry. */
async function reversalsOf(purchaseId: string): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM accounting_reversals ar
       JOIN journal_entries je ON je.business_id = ar.business_id AND je.id = ar.original_entry_id
      WHERE ar.business_id = $1 AND je.source_type = 'purchase' AND je.source_id = $2`,
    [A.businessId, purchaseId],
  );
  return must(r.rows[0]).n;
}

/** Empty a product's W1 stock through the API, then archive it. */
async function emptyAndArchive(productId: string, onHand: string): Promise<void> {
  if (onHand !== '0') {
    const out = await t.request
      .post('/v1/inventory/adjustments')
      .set(as())
      .send({ adjustmentId: randomUUID(), warehouseId: A.w1, occurredOn: day, reason: 'written off', lines: [{ productId, quantity: `-${onHand}` }] });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
  }
  const archived = await t.request.delete(`/v1/catalog/products/${productId}`).set(as());
  expect(archived.status, JSON.stringify(archived.body)).toBe(200);
}

function expectNoMint(): void {
  expect(mint, 'no inventory assertion').not.toHaveBeenCalled();
  expect(acctMint, 'no accounting assertion').not.toHaveBeenCalled();
}

describe('T-11 1. a retried return or reversal is answered from the stored rows', () => {
  it('a retried return replays with the first trace: no mint, no second movement or entry, nothing written', async () => {
    const p = await received(A.piece.productId, '4');
    const body = returnBody(p, '1');
    const first = await postReturn(p, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.replayed).toBe(false);
    const before = await s5Counts(ownerPool(), A.businessId);
    mint.mockClear();
    acctMint.mockClear();
    const retry = await postReturn(p, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.businessTransactionId, 'the first operation’s trace').toBe(first.body.businessTransactionId);
    expect({ ...retry.body, replayed: false }, 'the same return').toEqual(first.body);
    expectNoMint();
    expect(s4Delta(before, await s5Counts(ownerPool(), A.businessId)), 'no movement, entry or assertion use').toEqual({});
    expect(await entriesOf('supplier_return', String(body.returnId))).toBe(1);
  });

  it('the same return id with another intent is supplier_return.idempotency_conflict, nothing minted or written', async () => {
    const p = await received(A.piece.productId, '4');
    const body = returnBody(p, '1');
    expect((await postReturn(p, body)).status).toBe(201);
    const before = await s5Counts(ownerPool(), A.businessId);
    mint.mockClear();
    acctMint.mockClear();
    const lines = body.lines as Record<string, unknown>[];
    const conflict = await postReturn(p, { ...body, lines: [{ ...must(lines[0]), quantity: '2' }] });
    expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
    expect(conflict.body.error.details?.purchasingCode).toBe('supplier_return.idempotency_conflict');
    expectNoMint();
    expect(s4Delta(before, await s5Counts(ownerPool(), A.businessId))).toEqual({});
  });

  it('a retried reversal replays with the first trace: no mint, no second movement or reversal entry, nothing written', async () => {
    const p = await received(A.piece.productId, '2');
    const first = await postReversal(p);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.replayed).toBe(false);
    const before = await s5Counts(ownerPool(), A.businessId);
    mint.mockClear();
    acctMint.mockClear();
    const retry = await postReversal(p);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.businessTransactionId, 'the first operation’s trace').toBe(first.body.businessTransactionId);
    expect({ ...retry.body, replayed: false }, 'the same reversal').toEqual(first.body);
    expectNoMint();
    expect(s4Delta(before, await s5Counts(ownerPool(), A.businessId))).toEqual({});
    expect(await reversalsOf(p.purchaseId)).toBe(1);
  });
});

describe('T-11 2. the proof comes before the state', () => {
  it('after the product is archived a fresh return is refused, the retried return still replays with zero mints', async () => {
    const productId = A.dec2.productId;
    const p = await received(productId, '1.5');
    const body = returnBody(p, '0.5');
    const first = await postReturn(p, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await emptyAndArchive(productId, '1');

    const before = await s5Counts(ownerPool(), A.businessId);
    mint.mockClear();
    acctMint.mockClear();
    const fresh = await postReturn(p, returnBody(p, '0.5'));
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(409);
    expect(fresh.body.error.details?.inventoryCode, 'the state check refuses a fresh return').toBe('inventory.variant_archived');
    expect(mint, 'a refused fresh return mints nothing').not.toHaveBeenCalled();
    const retry = await postReturn(p, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.businessTransactionId).toBe(first.body.businessTransactionId);
    expectNoMint();
    expect(s4Delta(before, await s5Counts(ownerPool(), A.businessId)), 'nothing written').toEqual({});
  });

  it('after a reversed purchase’s product is archived, the retried reversal still replays with zero mints', async () => {
    const productId = A.piece2.productId;
    const p = await received(productId, '2');
    const first = await postReversal(p);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // The reversal took the key to zero: the product archives without an adjustment.
    await emptyAndArchive(productId, '0');
    const before = await s5Counts(ownerPool(), A.businessId);
    mint.mockClear();
    acctMint.mockClear();
    const retry = await postReversal(p);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.businessTransactionId).toBe(first.body.businessTransactionId);
    expectNoMint();
    expect(s4Delta(before, await s5Counts(ownerPool(), A.businessId))).toEqual({});
  });
});

describe('T-11 3. a replay inside the routine', () => {
  /** Hold `key`'s advisory lock on `id`, start both requests, wait until both wait on it inside the routine, release. */
  async function race(key: string, id: string, path: string, body: Record<string, unknown>): Promise<Response[]> {
    const gate = await ownerClient();
    try {
      await gate.query('BEGIN');
      await gate.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2::text))`, [key, id]);
      mint.mockClear();
      acctMint.mockClear();
      const racing = [started(path, body), started(path, body)];
      let waiting = 0;
      for (let i = 0; i < 600 && waiting < 2; i += 1) {
        const r = await ownerPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND classid = hashtext($1)::oid AND objid = hashtext($2::text)::oid AND objsubid = 2`,
          [key, id],
        );
        waiting = must(r.rows[0]).n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting, 'both requests wait on the key inside the routine').toBe(2);
      await gate.query('COMMIT');
      return await Promise.all(racing);
    } finally {
      await gate.end();
    }
  }

  async function consumedOfAccountingMints(): Promise<number> {
    const jtis = acctMint.mock.results.map((r) => {
      if (r.type !== 'return') throw new Error('an accounting mint threw');
      return must(splitAccountingAssertion(r.value)[10], 'jti');
    });
    expect(jtis.length, 'one accounting assertion each').toBe(2);
    const used = await ownerPool().query<{ jti: string }>(`SELECT jti::text FROM accounting_assertion_uses WHERE jti = ANY($1::uuid[])`, [jtis]);
    return used.rowCount ?? 0;
  }

  it('two identical returns: one commits, the other replays in the routine; its accounting assertion is never consumed', async () => {
    const p = await received(A.piece.productId, '4');
    const body = returnBody(p, '1');
    const before = await s5Counts(ownerPool(), A.businessId);
    const results = await race('daftar.supplier_return_id', String(body.returnId), `/v1/purchases/${p.purchaseId}/returns`, body);
    expect(results.map((r) => r.status).sort(), JSON.stringify(results.map((r): unknown => r.body))).toEqual([200, 201]);
    expect(results.map((r) => r.body.replayed as boolean).sort()).toEqual([false, true]);
    expect(mint, 'both passed the proof and were signed').toHaveBeenCalledTimes(2);
    expect(await consumedOfAccountingMints(), 'only the winner’s accounting assertion was consumed').toBe(1);
    expect(await entriesOf('supplier_return', String(body.returnId)), 'one entry').toBe(1);
    const d = s4Delta(before, await s5Counts(ownerPool(), A.businessId));
    expect({ returns: d.supplier_returns, movements: d.stock_movements, entries: d.journal_entries }).toEqual({ returns: 1, movements: 1, entries: 1 });
  });

  it('two identical reversals: one commits, the other replays in the routine; its reversal assertion is never consumed', async () => {
    const p = await received(A.piece.productId, '2');
    const before = await s5Counts(ownerPool(), A.businessId);
    const results = await race('daftar.purchase_id', p.purchaseId, `/v1/purchases/${p.purchaseId}/reversal`, reversalBody());
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(results.map((r) => r.body.replayed as boolean).sort()).toEqual([false, true]);
    expect(mint, 'both passed the proof and were signed').toHaveBeenCalledTimes(2);
    expect(await consumedOfAccountingMints(), 'only the winner’s reversal assertion was consumed').toBe(1);
    expect(await reversalsOf(p.purchaseId), 'one reversal entry').toBe(1);
    const d = s4Delta(before, await s5Counts(ownerPool(), A.businessId));
    expect({ reversals: d.purchase_reversals, movements: d.stock_movements, entries: d.journal_entries }).toEqual({ reversals: 1, movements: 1, entries: 1 });
  });
});
