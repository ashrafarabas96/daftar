/**
 * P3-S4 T-11 — IDEMPOTENCY OF THE PURCHASE COMMANDS
 * (docs/PHASE_3_S4_CONTRACT.md A-08, §2.4, §6 T-11; P:215).
 *
 * Through the real Nest application and the real database:
 *   1. a retried receive answers the stored receipt (`replayed: true`, the
 *      first operation's trace) and creates no second movement or entry —
 *      nothing is minted and nothing at all is written;
 *   2. the proof comes before the state: once the draft's product (and so
 *      its variant) is archived, a fresh receipt of another draft over it is
 *      refused, yet the retried receipt still replays, with zero mints;
 *   3. a retried draft save — a create and a replace — replays without a
 *      mint or a write;
 *   4. two identical receipts racing past the proof: one commits, the other
 *      meets the committed receipt inside the routine and replays there; its
 *      accounting assertions are never consumed (they expire unused) and only
 *      one entry and one movement set exist.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { splitAccountingAssertion } from '@daftar/accounting';
import { InventoryAssertionMinterService } from '../../apps/api/src/modules/inventory/inventory-assertion.minter';
import { AccountingAssertionMinterService } from '../../apps/api/src/modules/accounting/accounting-assertion.minter';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, ownerClient, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { s4Counts, s4Delta } from '../helpers/purchase-commands';

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
  owner = await registerActor(t, 'S4 idempotency owner');
  A = await onboardS3Business(t, owner, 's4idem');
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

async function supplier(): Promise<string> {
  const id = randomUUID();
  const r = await t.request
    .post('/v1/suppliers')
    .set(as())
    .send({ supplierId: id, name: `Supplier ${id.slice(0, 6)}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}

function draftBody(supplierId: string, productId: string, quantity: string, expectedRevision = 0, lineId: string = randomUUID()): Record<string, unknown> {
  return {
    expectedRevision,
    supplierId,
    warehouseId: A.w1,
    currency: 'ILS',
    documentDate: day,
    lines: [{ lineId, productId, quantity, unitPrice: '12.50' }],
    landedCosts: [],
  };
}

async function draft(productId: string = A.piece.productId, quantity = '2'): Promise<string> {
  const id = randomUUID();
  const r = await t.request
    .put(`/v1/purchases/${id}`)
    .set(as())
    .send(draftBody(await supplier(), productId, quantity));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}

const receive = (id: string): Promise<Response> => t.request.post(`/v1/purchases/${id}/receive`).set(as()).send({ draftRevision: 1 });

/** Start a request now (supertest is lazy) and settle it later. */
function started(id: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    t.request
      .post(`/v1/purchases/${id}/receive`)
      .set(as())
      .send({ draftRevision: 1 })
      .end((err: Error | null, res: Response) => (err === null ? resolve(res) : reject(err)));
  });
}

async function purchaseEntries(id: string): Promise<number> {
  const r = await ownerPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'purchase' AND source_id = $2`,
    [A.businessId, id],
  );
  return must(r.rows[0]).n;
}

describe('T-11 a retried receive is answered from the stored receipt', () => {
  it('1. the retry replays with the first trace: no mint, no second movement or entry, nothing written', async () => {
    const id = await draft();
    const first = await receive(id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.replayed).toBe(false);
    const before = await s4Counts(ownerPool(), A.businessId);
    mint.mockClear();
    acctMint.mockClear();
    const retry = await receive(id);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.businessTransactionId, 'the first operation’s trace').toBe(first.body.businessTransactionId);
    expect({ ...retry.body, replayed: false }, 'the same receipt').toEqual(first.body);
    expect(mint, 'no inventory assertion').not.toHaveBeenCalled();
    expect(acctMint, 'no accounting assertion').not.toHaveBeenCalled();
    expect(s4Delta(before, await s4Counts(ownerPool(), A.businessId)), 'no movement, entry or assertion use').toEqual({});
    expect(await purchaseEntries(id)).toBe(1);
  });

  it('2. proof before state: after the product is archived a fresh receipt is refused, the retry still replays with zero mints', async () => {
    const productId = A.dec2.productId;
    const id = await draft(productId, '1.5');
    const other = await draft(productId, '1');
    const first = await receive(id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // Empty the stock, then archive: a product holding stock cannot be archived.
    const out = await t.request
      .post('/v1/inventory/adjustments')
      .set(as())
      .send({ adjustmentId: randomUUID(), warehouseId: A.w1, occurredOn: day, reason: 'returned to the supplier', lines: [{ productId, quantity: '-1.5' }] });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const archived = await t.request.delete(`/v1/catalog/products/${productId}`).set(as());
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);

    const before = await s4Counts(ownerPool(), A.businessId);
    mint.mockClear();
    acctMint.mockClear();
    const fresh = await receive(other);
    expect(fresh.status, JSON.stringify(fresh.body)).not.toBe(200);
    expect(fresh.body.error.details?.inventoryCode, 'the state check refuses a fresh receipt').toBe('inventory.product_archived');
    const retry = await receive(id);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.businessTransactionId).toBe(first.body.businessTransactionId);
    expect(mint, 'zero inventory mints').not.toHaveBeenCalled();
    expect(acctMint, 'zero accounting mints').not.toHaveBeenCalled();
    expect(s4Delta(before, await s4Counts(ownerPool(), A.businessId)), 'nothing written').toEqual({});
  });
});

describe('T-11 a retried draft save replays', () => {
  it('3. a create and a replace, each retried: replayed, the same revision and trace, no mint, nothing written', async () => {
    const supplierId = await supplier();
    const id = randomUUID();
    const create = draftBody(supplierId, A.piece.productId, '2');
    const first = await t.request.put(`/v1/purchases/${id}`).set(as()).send(create);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.replayed).toBe(false);

    let before = await s4Counts(ownerPool(), A.businessId);
    mint.mockClear();
    const again = await t.request.put(`/v1/purchases/${id}`).set(as()).send(create);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, revision: 1, businessTransactionId: first.body.businessTransactionId });
    expect(mint).not.toHaveBeenCalled();
    expect(s4Delta(before, await s4Counts(ownerPool(), A.businessId))).toEqual({});

    const lines = create.lines as { lineId: string }[];
    const replace = draftBody(supplierId, A.piece.productId, '3', 1, must(lines[0]).lineId);
    const replaced = await t.request.put(`/v1/purchases/${id}`).set(as()).send(replace);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body).toMatchObject({ replayed: false, revision: 2 });
    before = await s4Counts(ownerPool(), A.businessId);
    mint.mockClear();
    const replacedAgain = await t.request.put(`/v1/purchases/${id}`).set(as()).send(replace);
    expect(replacedAgain.status, JSON.stringify(replacedAgain.body)).toBe(200);
    expect(replacedAgain.body).toMatchObject({ replayed: true, revision: 2, businessTransactionId: replaced.body.businessTransactionId });
    expect(mint).not.toHaveBeenCalled();
    expect(s4Delta(before, await s4Counts(ownerPool(), A.businessId))).toEqual({});
  });
});

describe('T-11 a replay inside the routine', () => {
  it('4. two identical receipts past the proof: one commits, the other replays in the routine; its accounting assertion is never consumed', async () => {
    const id = await draft();
    const before = await s4Counts(ownerPool(), A.businessId);
    // Hold the routine's own idempotency lock, so both requests pass the service's proof and wait inside seam 2.
    const gate = await ownerClient();
    let results: Response[];
    try {
      await gate.query('BEGIN');
      await gate.query(`SELECT pg_advisory_xact_lock(hashtext('daftar.purchase_id'), hashtext($1::text))`, [id]);
      mint.mockClear();
      acctMint.mockClear();
      const racing = [started(id), started(id)];
      let waiting = 0;
      for (let i = 0; i < 600 && waiting < 2; i += 1) {
        const r = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
        waiting = must(r.rows[0]).n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting, 'both receipts wait on the purchase key inside the routine').toBe(2);
      await gate.query('COMMIT');
      results = await Promise.all(racing);
    } finally {
      await gate.end();
    }
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(results.map((r) => r.body.replayed as boolean).sort()).toEqual([false, true]);
    expect(mint, 'both passed the proof and were signed').toHaveBeenCalledTimes(2);
    expect(acctMint, 'one purchase-entry assertion each').toHaveBeenCalledTimes(2);

    const jtis = acctMint.mock.results.map((r) => {
      if (r.type !== 'return') throw new Error('an accounting mint threw');
      return must(splitAccountingAssertion(r.value)[10], 'jti');
    });
    const used = await ownerPool().query<{ jti: string }>(`SELECT jti::text FROM accounting_assertion_uses WHERE jti = ANY($1::uuid[])`, [jtis]);
    expect(used.rowCount, 'only the winner’s accounting assertion was consumed').toBe(1);

    expect(await purchaseEntries(id), 'one entry').toBe(1);
    const d = s4Delta(before, await s4Counts(ownerPool(), A.businessId));
    expect({ movements: d.stock_movements, entries: d.journal_entries }, 'one movement (one line) and one entry').toEqual({ movements: 1, entries: 1 });
  });
});
