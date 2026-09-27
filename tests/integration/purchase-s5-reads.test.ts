/**
 * P3-S5 T-12 — ACCOUNTS PAYABLE AFTER RETURNS IS READ FROM THE LEDGER
 * (docs/PHASE_3_S5_CONTRACT.md A-16, A-19, §6 T-12; L:843-854, L:1260).
 *
 * Through the real Nest application and the real database:
 *   - after partial returns, in the purchase currency and in USD, the
 *     ledger-derived payable of each purchase (`GET /purchases/:id/payable`,
 *     which now adds the AP lines of its `supplier_return` entries and of the
 *     reversal of its entry) equals `purchase_ap_outstanding` in txn, and
 *     `B − Σ ap_base` of its stored returns in base; a reversed purchase owes
 *     0 both ways;
 *   - the supplier payable is Σ of those, per base and per currency, and
 *     never another supplier's;
 *   - the credit-note list is supplier-scoped (each supplier sees exactly its
 *     own notes, as stored: original = remaining) and business-wide (an
 *     assigned-scope actor is refused 403
 *     `inventory.business_wide_scope_required`; a business-wide member reads
 *     the owner's list);
 *   - no S5 table stores a balance, outstanding, paid or payable column.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enterRate, rateIdFor } from '../helpers/accounting-fx';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { S5_TABLES } from '../helpers/purchase-returns';
import { installSettlementFixture, type SettlementFixture } from '../helpers/purchase-settlement-fixture';

let t: TestApp;
let day: string;
let owner: HttpActor;
let A: S3Business;
let supplierId: string;
let otherSupplierId: string;
let fixture: SettlementFixture | null = null;

interface HttpPurchase {
  readonly purchaseId: string;
  readonly lineId: string;
  readonly supplierId: string;
}

/** Every received purchase of the business and what happened to it. */
const purchases: { readonly p: HttpPurchase; readonly what: string }[] = [];
/** The credit notes each supplier was issued, by return id. */
const creditReturns = new Map<string, string[]>();

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

async function received(sid: string, currency: string, quantity: string, unitPrice: string, landed: string | null = null): Promise<HttpPurchase> {
  const purchaseId = randomUUID();
  const lineId = randomUUID();
  const d = await t.request
    .put(`/v1/purchases/${purchaseId}`)
    .set(as())
    .send({
      expectedRevision: 0,
      supplierId: sid,
      warehouseId: A.w1,
      currency,
      documentDate: day,
      lines: [{ lineId, productId: A.piece.productId, quantity, unitPrice }],
      landedCosts: landed === null ? [] : [{ landedCostId: randomUUID(), description: 'Freight', amount: landed, mode: 'by_value' }],
    });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  const r = await t.request.post(`/v1/purchases/${purchaseId}/receive`).set(as()).send({ draftRevision: 1 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { purchaseId, lineId, supplierId: sid };
}

async function returnOf(p: HttpPurchase, quantity: string): Promise<string> {
  const returnId = randomUUID();
  const r = await t.request
    .post(`/v1/purchases/${p.purchaseId}/returns`)
    .set(as())
    .send({ returnId, warehouseId: A.w1, documentDate: day, lines: [{ lineId: randomUUID(), purchaseLineId: p.lineId, quantity }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return returnId;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S5 reads owner');
  A = await onboardS3Business(t, owner, 's5reads');
  // A USD rate in force at the document date's instant, entered through the real control boundary.
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

  // Partial returns, domestic and foreign (two partials of a USD purchase leave base dust on the AP lines).
  const ils = await received(supplierId, 'ILS', '3', '12.50');
  await returnOf(ils, '1');
  purchases.push({ p: ils, what: 'ILS, 1 of 3 returned' });
  const usd = await received(supplierId, 'USD', '3', '9.99', '1.00');
  await returnOf(usd, '1');
  await returnOf(usd, '1');
  purchases.push({ p: usd, what: 'USD with landed cost, 2 of 3 returned in two parts' });
  const whole = await received(supplierId, 'ILS', '2', '7.35');
  await returnOf(whole, '2');
  purchases.push({ p: whole, what: 'ILS, returned whole' });
  const reversed = await received(supplierId, 'ILS', '2', '8.00');
  const rev = await t.request.post(`/v1/purchases/${reversed.purchaseId}/reversal`).set(as()).send({ reversalDate: day, reason: 'Received twice' });
  expect(rev.status, JSON.stringify(rev.body)).toBe(200);
  purchases.push({ p: reversed, what: 'reversed' });
  const theirs = await received(otherSupplierId, 'ILS', '4', '100.00');
  await returnOf(theirs, '1');
  purchases.push({ p: theirs, what: 'the other supplier, 1 of 4 returned' });

  // Credit notes (the settlement fixture states O = 0, TL-9): two for the supplier, one for the other.
  fixture = await installSettlementFixture(ownerPool());
  for (const sid of [supplierId, supplierId, otherSupplierId]) {
    const p = await received(sid, 'ILS', '2', '10.00');
    await fixture.set(A.businessId, p.purchaseId, { outstandingTxn: 0n });
    const returnId = await returnOf(p, '1');
    creditReturns.set(sid, [...(creditReturns.get(sid) ?? []), returnId]);
  }
  await fixture.restore();
  fixture = null;
});

afterAll(async () => {
  if (fixture !== null) await fixture.restore();
  await t.close();
  await resetData();
});

interface Expected {
  readonly currency: string;
  readonly txn: string;
  readonly base: string;
}

/** What the payable must be: `purchase_ap_outstanding` in txn, `B − Σ ap_base` of the stored returns in base (0 once reversed). */
async function expectedOf(purchaseId: string): Promise<Expected> {
  return must(
    (
      await ownerPool().query<Expected>(
        `SELECT p.currency_code::text AS currency, purchase_ap_outstanding(p.business_id, p.id)::text AS txn,
                CASE WHEN EXISTS (SELECT 1 FROM purchase_reversals v WHERE v.business_id = p.business_id AND v.id = p.id) THEN '0'
                     ELSE (p.total_base_minor - (SELECT coalesce(sum(r.ap_base_minor), 0) FROM supplier_returns r
                                                  WHERE r.business_id = p.business_id AND r.purchase_id = p.id))::text END AS base
           FROM purchases p WHERE p.business_id = $1 AND p.id = $2`,
        [A.businessId, purchaseId],
      )
    ).rows[0],
    purchaseId,
  );
}

describe('T-12 the purchase payable after returns is the ledger, and equals the S6 extension point', () => {
  it('each purchase: ledger txn AP = purchase_ap_outstanding, ledger base AP = B − Σ ap_base; reversed → 0 / 0', async () => {
    expect(purchases.length).toBe(5);
    for (const { p, what } of purchases) {
      const e = await expectedOf(p.purchaseId);
      const r = await t.request.get(`/v1/purchases/${p.purchaseId}/payable`).set(as());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body, what).toEqual({ purchaseId: p.purchaseId, currency: e.currency, outstandingTxnMinor: e.txn, outstandingBaseMinor: e.base });
    }
    const reversed = must(purchases.find((x) => x.what === 'reversed')).p;
    expect(await expectedOf(reversed.purchaseId), 'a reversed purchase owes nothing').toMatchObject({ txn: '0', base: '0' });
    const whole = must(purchases.find((x) => x.what === 'ILS, returned whole')).p;
    expect(await expectedOf(whole.purchaseId), 'a purchase returned whole owes nothing').toMatchObject({ txn: '0', base: '0' });
  });

  it('the supplier payable is Σ of its purchases, per base and per currency, and never another supplier’s', async () => {
    for (const sid of [supplierId, otherSupplierId]) {
      const r = await ownerPool().query<{ id: string }>(`SELECT id::text FROM purchases WHERE business_id = $1 AND supplier_id = $2 AND status = 'received'`, [
        A.businessId,
        sid,
      ]);
      let base = 0n;
      const byCurrency = new Map<string, bigint>();
      for (const { id } of r.rows) {
        const e = await expectedOf(id);
        base += BigInt(e.base);
        byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0n) + BigInt(e.txn));
      }
      const res = await t.request.get(`/v1/suppliers/${sid}/payable`).set(as());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = res.body as { supplierId: string; baseMinor: string; byCurrency: { currency: string; txnMinor: string }[] };
      expect(body.baseMinor, sid).toBe(base.toString(10));
      expect(
        [...body.byCurrency].sort((x, y) => x.currency.localeCompare(y.currency)),
        sid,
      ).toEqual([...byCurrency.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([currency, v]) => ({ currency, txnMinor: v.toString(10) })));
    }
  });
});

describe('T-12 the credit-note list', () => {
  it('is supplier-scoped: each supplier lists exactly its own notes, as stored (original = remaining)', async () => {
    for (const sid of [supplierId, otherSupplierId]) {
      const res = await t.request.get(`/v1/suppliers/${sid}/credit-notes`).set(as());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const items = res.body.items as {
        supplierId: string;
        returnId: string;
        originalTxnMinor: string;
        remainingTxnMinor: string;
        originalCarryingBaseMinor: string;
        remainingCarryingBaseMinor: string;
      }[];
      expect(items.map((n) => n.returnId).sort(), sid).toEqual([...must(creditReturns.get(sid))].sort());
      for (const n of items) {
        expect(n.supplierId).toBe(sid);
        expect(n.remainingTxnMinor, 'remaining as stored').toBe(n.originalTxnMinor);
        expect(n.remainingCarryingBaseMinor).toBe(n.originalCarryingBaseMinor);
        const stored = must(
          (
            await ownerPool().query<{ c: string; b: string }>(
              `SELECT credit_txn_minor::text AS c, credit_base_minor::text AS b FROM supplier_returns WHERE business_id = $1 AND id = $2`,
              [A.businessId, n.returnId],
            )
          ).rows[0],
        );
        expect([n.originalTxnMinor, n.originalCarryingBaseMinor], 'the credit note carries its return’s credit').toEqual([stored.c, stored.b]);
      }
    }
  });

  it('requires business-wide scope: an assigned-scope actor is refused; a business-wide member reads the owner’s list', async () => {
    const roleRes = await t.request
      .post('/v1/businesses/current/roles')
      .set(as())
      .send({ key: 's5-credit-reader', name: 's5-credit-reader', permissions: ['suppliers.view'] });
    expect(roleRes.status, JSON.stringify(roleRes.body)).toBe(201);
    const narrow = await registerActor(t, 'Credit reader assigned to X');
    const wide = await registerActor(t, 'Credit reader, business-wide');
    for (const a of [narrow, wide]) {
      const m = await t.request.post('/v1/businesses/current/members').set(as()).send({ email: a.email, roleKey: 's5-credit-reader' });
      expect(m.status, JSON.stringify(m.body)).toBe(201);
    }
    const scoped = await t.request
      .patch(`/v1/businesses/current/members/${narrow.userId}/branch-scope`)
      .set(as())
      .send({ mode: 'assigned', branchIds: [A.branchX] });
    expect(scoped.status).toBe(200);
    const refused = await t.request.get(`/v1/suppliers/${supplierId}/credit-notes`).set(as(narrow));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.details?.inventoryCode).toBe('inventory.business_wide_scope_required');
    const ownerView = await t.request.get(`/v1/suppliers/${supplierId}/credit-notes`).set(as());
    const wideView = await t.request.get(`/v1/suppliers/${supplierId}/credit-notes`).set(as(wide));
    expect(wideView.status, JSON.stringify(wideView.body)).toBe(200);
    expect(wideView.body).toEqual(ownerView.body);
  });
});

describe('T-12 no stored balance', () => {
  it('no S5 table has a balance, outstanding, paid or payable column', async () => {
    const r = await ownerPool().query<{ t: string; col: string }>(
      `SELECT table_name::text AS t, column_name::text AS col FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
          AND column_name ~ '(balance|outstanding|paid|payable|settled|amount_due|owed)'`,
      [[...S5_TABLES]],
    );
    expect(r.rows).toEqual([]);
    const tables = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r'`, [
      [...S5_TABLES],
    ]);
    expect(must(tables.rows[0]).n, 'the catalogue query saw every S5 table').toBe(S5_TABLES.length);
  });
});
