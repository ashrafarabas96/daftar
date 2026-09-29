/**
 * P3-S4 T-12 — ACCOUNTS PAYABLE IS READ FROM THE LEDGER
 * (docs/PHASE_3_S4_CONTRACT.md A-20, AL-26, §6 T-12; L:843-854).
 *
 * Through the real Nest application and the real database:
 *   - reconciliation proof: for every received purchase, the payable derived
 *     from the ledger equals the document's own totals (`total_base_minor`,
 *     and `total_txn_minor` in the purchase currency); a draft or a cancelled
 *     purchase owes nothing;
 *   - a supplier's payable is Σ of its received purchases — per base and per
 *     purchase currency (ILS and USD here) — and never another supplier's;
 *   - no stored balance column exists on any S4 table (the catalogue);
 *   - an assigned-scope actor is refused the supplier payable, while a
 *     business-wide member reads the same value as the owner.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enterRate, rateIdFor } from '../helpers/accounting-fx';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { S4_TABLES } from '../helpers/purchase-commands';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let supplierId: string;
let otherSupplierId: string;
const received: string[] = [];
let draftId: string;
let cancelledId: string;

const as = (a: HttpActor = owner): Record<string, string> => asMember(a, A.businessId);

async function supplier(): Promise<string> {
  const id = randomUUID();
  const r = await t.request
    .post('/v1/suppliers')
    .set(as())
    .send({ supplierId: id, name: `Supplier ${id.slice(0, 6)}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}

async function draft(sid: string, currency: string, quantity: string, unitPrice: string, landed: string | null = null): Promise<string> {
  const id = randomUUID();
  const r = await t.request
    .put(`/v1/purchases/${id}`)
    .set(as())
    .send({
      expectedRevision: 0,
      supplierId: sid,
      warehouseId: A.w1,
      currency,
      documentDate: day,
      lines: [{ lineId: randomUUID(), productId: A.piece.productId, quantity, unitPrice }],
      landedCosts: landed === null ? [] : [{ landedCostId: randomUUID(), description: 'Freight', amount: landed, mode: 'by_value' }],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id;
}

async function receive(id: string): Promise<void> {
  const r = await t.request.post(`/v1/purchases/${id}/receive`).set(as()).send({ draftRevision: 1 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S4 reads owner');
  A = await onboardS3Business(t, owner, 's4reads');
  // A USD rate in force at the document date's instant (R-17), entered through the real control boundary.
  await enterRate(
    {
      tenantId: A.tenantId,
      businessId: A.businessId,
      rateId: rateIdFor(A.businessId, randomUUID()),
      fromCurrency: 'USD',
      toCurrency: 'ILS',
      rate: '3.71',
      effectiveAt: new Date(Math.floor(Date.now() / 1000 - 60) * 1000).toISOString(),
    },
    A.userId,
  );
  supplierId = await supplier();
  otherSupplierId = await supplier();
  for (const [currency, qty, price, landed] of [
    ['ILS', '3', '12.50', null],
    ['ILS', '2', '7.35', '4.10'],
    ['USD', '5', '9.99', '1.00'],
  ] as const) {
    const id = await draft(supplierId, currency, qty, price, landed);
    await receive(id);
    received.push(id);
  }
  const theirs = await draft(otherSupplierId, 'ILS', '1', '100.00');
  await receive(theirs);
  received.push(theirs);
  draftId = await draft(supplierId, 'ILS', '4', '10.00');
  cancelledId = await draft(supplierId, 'ILS', '6', '10.00');
  const c = await t.request.post(`/v1/purchases/${cancelledId}/cancel`).set(as()).send({ draftRevision: 1 });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

interface DocumentTotals {
  id: string;
  supplier_id: string;
  currency: string;
  base: string;
  txn: string;
}

async function receivedDocuments(): Promise<DocumentTotals[]> {
  const r = await ownerPool().query<DocumentTotals>(
    `SELECT id::text, supplier_id::text, currency_code AS currency, total_base_minor::text AS base, total_txn_minor::text AS txn
       FROM purchases WHERE business_id = $1 AND status = 'received' ORDER BY id`,
    [A.businessId],
  );
  return r.rows;
}

describe('T-12 the purchase payable is the ledger, and equals the document', () => {
  it('for every received purchase, the ledger-derived payable equals total_base_minor and total_txn_minor', async () => {
    const docs = await receivedDocuments();
    expect(docs.map((d) => d.id).sort(), 'every received purchase of the business').toEqual([...received].sort());
    expect(new Set(docs.map((d) => d.currency)), 'both currencies are exercised').toEqual(new Set(['ILS', 'USD']));
    for (const d of docs) {
      const r = await t.request.get(`/v1/purchases/${d.id}/payable`).set(as());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body, d.id).toEqual({ purchaseId: d.id, currency: d.currency, outstandingBaseMinor: d.base, outstandingTxnMinor: d.txn });
    }
  });

  it('a draft and a cancelled purchase owe nothing', async () => {
    for (const id of [draftId, cancelledId]) {
      const r = await t.request.get(`/v1/purchases/${id}/payable`).set(as());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ purchaseId: id, currency: 'ILS', outstandingBaseMinor: '0', outstandingTxnMinor: '0' });
    }
  });
});

describe('T-12 the supplier payable is Σ of its received purchases', () => {
  it('per base and per purchase currency, and never another supplier’s', async () => {
    const docs = await receivedDocuments();
    for (const sid of [supplierId, otherSupplierId]) {
      const mine = docs.filter((d) => d.supplier_id === sid);
      const byCurrency = new Map<string, bigint>();
      for (const d of mine) byCurrency.set(d.currency, (byCurrency.get(d.currency) ?? 0n) + BigInt(d.txn));
      const r = await t.request.get(`/v1/suppliers/${sid}/payable`).set(as());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const body = r.body as { supplierId: string; baseMinor: string; byCurrency: { currency: string; txnMinor: string }[] };
      expect(body.supplierId).toBe(sid);
      expect(body.baseMinor, sid).toBe(mine.reduce((a, d) => a + BigInt(d.base), 0n).toString(10));
      expect(
        [...body.byCurrency].sort((x, y) => x.currency.localeCompare(y.currency)),
        sid,
      ).toEqual([...byCurrency.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([currency, v]) => ({ currency, txnMinor: v.toString(10) })));
    }
  });
});

describe('T-12 no stored balance', () => {
  it('no S4 table has a balance, outstanding, paid or payable column', async () => {
    const r = await ownerPool().query<{ t: string; col: string }>(
      `SELECT table_name::text AS t, column_name::text AS col FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
          AND column_name ~ '(balance|outstanding|paid|payable|settled|amount_due|owed)'`,
      [[...S4_TABLES]],
    );
    expect(r.rows).toEqual([]);
    const tables = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r'`, [
      [...S4_TABLES],
    ]);
    expect(must(tables.rows[0]).n, 'the catalogue query saw every S4 table').toBe(S4_TABLES.length);
  });
});

describe('T-12 the supplier payable requires business-wide scope', () => {
  it('an assigned-scope actor is refused; a business-wide member reads the owner’s value', async () => {
    const roleRes = await t.request
      .post('/v1/businesses/current/roles')
      .set(as())
      .send({ key: 's4-ap-reader', name: 's4-ap-reader', permissions: ['suppliers.view'] });
    expect(roleRes.status, JSON.stringify(roleRes.body)).toBe(201);
    const narrow = await registerActor(t, 'AP reader assigned to X');
    const wide = await registerActor(t, 'AP reader, business-wide');
    for (const a of [narrow, wide]) {
      const m = await t.request.post('/v1/businesses/current/members').set(as()).send({ email: a.email, roleKey: 's4-ap-reader' });
      expect(m.status, JSON.stringify(m.body)).toBe(201);
    }
    const scoped = await t.request
      .patch(`/v1/businesses/current/members/${narrow.userId}/branch-scope`)
      .set(as())
      .send({ mode: 'assigned', branchIds: [A.branchX] });
    expect(scoped.status).toBe(200);

    const refused = await t.request.get(`/v1/suppliers/${supplierId}/payable`).set(as(narrow));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.details?.inventoryCode).toBe('inventory.business_wide_scope_required');
    const ownerView = await t.request.get(`/v1/suppliers/${supplierId}/payable`).set(as());
    const wideView = await t.request.get(`/v1/suppliers/${supplierId}/payable`).set(as(wide));
    expect(wideView.status, JSON.stringify(wideView.body)).toBe(200);
    expect(wideView.body).toEqual(ownerView.body);
  });
});
