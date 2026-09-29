/**
 * P3-S6 T-19 — THE READS STAY LIVE-DERIVED (docs/PHASE_3_S6_CONTRACT.md
 * A-18 "Reads", AL-26, §6 T-19, §7 G-3).
 *
 * After EVERY step of one mixed USD scenario — two payments at two rates, an
 * S5 return, a credit allocation, a cross-currency payment and the final
 * flush — for the purchase:
 *   - the ledger AP in the purchase currency (credit − debit over every
 *     `accounts_payable` line of the purchase, its returns, its payment and
 *     credit allocations) = `purchase_ap_outstanding` = the API's
 *     `GET /v1/purchases/:id/payable` `outstandingTxnMinor`;
 *   - the ledger base AP = `B − Σ rel` (Σ of every reducer's carrying base
 *     released: payments, credit allocations, returns) = `outstandingBaseMinor`;
 *   - `GET /v1/suppliers/:id/payable` sums the same;
 *   - and at the end both are exactly 0.
 * For every note after every note step: `Σ notes − Σ allocations − Σ refunds`
 * (amount and carrying) = the stored remaining pair = what
 * `GET /v1/suppliers/:id/credit-notes` answers = the note's 1150 ledger.
 * The stored-document GETs (`/v1/supplier-payments/:id`,
 * `/v1/suppliers/:id/payments`, `/v1/purchases/:id/settlements`) answer the
 * stored rows.
 * G-3: no supplier, purchase, settlement or payment-method table stores a
 * balance, outstanding, paid, due or settled amount — read from the live
 * catalogue with the §7 G-3 vocabulary, and from the migration tree by the
 * repository guard itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, must, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  allocateBody,
  httpMethod,
  httpPay,
  httpReceived,
  httpReturn,
  noteOf,
  outstandingOf,
  payBody,
  refundBody,
  returnToCredit,
  seedSettlementAccounts,
  settlementLedgerAp,
  stateRate,
  type HttpPurchase,
  type SettlementAccounts,
} from '../helpers/supplier-settlement';
import { discoverSupplierTables, findAuthoritativeSupplierColumns, isForbiddenSupplierTable } from '../../scripts/guards/no-authoritative-balance';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;
let acc: SettlementAccounts;
let method: string;
let day: string;

function ago(n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 reads owner');
  A = await onboardS3Business(t, owner, 's6reads');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
  await stateRate(A, 'USD', 'ILS', '3.6000000000', `${ago(10)}T00:00:00Z`);
  await stateRate(A, 'USD', 'ILS', '3.7000000000', `${ago(3)}T00:00:00Z`);
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const get = (path: string): Promise<{ status: number; body: unknown }> => t.request.get(path).set(asMember(owner, A.businessId));

/** Σ rel: every reducer's carrying base released from the purchase, read from the stored documents. */
async function sumReleased(purchaseId: string): Promise<bigint> {
  const r = await ownerPool().query<{ rel: string }>(
    `SELECT ((SELECT coalesce(sum(purchase_carrying_base_released_minor), 0) FROM supplier_payment_allocations WHERE business_id = $1 AND purchase_id = $2)
           + (SELECT coalesce(sum(purchase_carrying_base_released_minor), 0) FROM supplier_credit_allocations WHERE business_id = $1 AND purchase_id = $2)
           + (SELECT coalesce(sum(ap_base_minor), 0) FROM supplier_returns WHERE business_id = $1 AND purchase_id = $2))::text AS rel`,
    [A.businessId, purchaseId],
  );
  return BigInt(must(r.rows[0]).rel);
}

/** The AP identities of one purchase after a step. */
async function apHolds(p: HttpPurchase, step: string): Promise<{ o: bigint; base: bigint }> {
  const { o, b } = await outstandingOf(ownerPool(), A.businessId, p.purchaseId);
  const ledger = await settlementLedgerAp(ownerPool(), A.businessId, p.purchaseId);
  const rel = await sumReleased(p.purchaseId);
  expect(ledger.txn, `${step}: ledger AP (txn) = purchase_ap_outstanding`).toBe(o);
  expect(ledger.base, `${step}: ledger base AP = B − Σ rel`).toBe(b - rel);
  const payable = await get(`/v1/purchases/${p.purchaseId}/payable`);
  expect(payable.status, step).toBe(200);
  expect(payable.body, `${step}: GET …/payable`).toEqual({
    purchaseId: p.purchaseId,
    currency: 'USD',
    outstandingTxnMinor: o.toString(10),
    outstandingBaseMinor: (b - rel).toString(10),
  });
  return { o, base: b - rel };
}

/** Σ notes − Σ allocations − Σ refunds, per note, from the stored documents. */
async function derivedCredit(creditNoteId: string): Promise<{ remaining: bigint; remainingCarrying: bigint }> {
  const r = must(
    (
      await ownerPool().query<{ r: string; rb: string }>(
        `SELECT (n.original_amount_minor
                 - (SELECT coalesce(sum(credit_amount_consumed_minor), 0) FROM supplier_credit_allocations WHERE business_id = n.business_id AND credit_note_id = n.id)
                 - (SELECT coalesce(sum(source_amount_consumed_minor), 0) FROM supplier_refunds WHERE business_id = n.business_id AND credit_note_id = n.id))::text AS r,
                (n.original_carrying_base_amount_minor
                 - (SELECT coalesce(sum(credit_carrying_base_released_minor), 0) FROM supplier_credit_allocations WHERE business_id = n.business_id AND credit_note_id = n.id)
                 - (SELECT coalesce(sum(source_carrying_base_released_minor), 0) FROM supplier_refunds WHERE business_id = n.business_id AND credit_note_id = n.id))::text AS rb
           FROM supplier_credit_notes n WHERE n.business_id = $1 AND n.id = $2`,
        [A.businessId, creditNoteId],
      )
    ).rows[0],
  );
  return { remaining: BigInt(r.r), remainingCarrying: BigInt(r.rb) };
}

/** The note's supplier_receivable ledger (debit − credit) over its return, its allocations and its refunds. */
async function ledger1150(creditNoteId: string): Promise<bigint> {
  const r = await ownerPool().query<{ v: string }>(
    `WITH src AS (
       SELECT 'supplier_return'::text AS t, n.supplier_return_id AS id FROM supplier_credit_notes n WHERE n.business_id = $1 AND n.id = $2
       UNION ALL SELECT 'supplier_credit_allocation', a.id FROM supplier_credit_allocations a WHERE a.business_id = $1 AND a.credit_note_id = $2
       UNION ALL SELECT 'supplier_refund', f.id FROM supplier_refunds f WHERE f.business_id = $1 AND f.credit_note_id = $2)
     SELECT coalesce(sum(l.debit_minor - l.credit_minor), 0)::text AS v
       FROM src JOIN journal_entries e ON e.business_id = $1 AND e.source_type = src.t AND e.source_id = src.id
       JOIN journal_lines l ON l.business_id = e.business_id AND l.journal_entry_id = e.id
       JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id AND a.system_key = 'supplier_receivable'`,
    [A.businessId, creditNoteId],
  );
  return BigInt(must(r.rows[0]).v);
}

async function creditHolds(supplierId: string, creditNoteId: string, step: string): Promise<{ remaining: bigint; remainingCarrying: bigint }> {
  const stored = await noteOf(ownerPool(), A.businessId, creditNoteId);
  const derived = await derivedCredit(creditNoteId);
  expect(derived, `${step}: Σ notes − Σ allocations − Σ refunds = stored remaining`).toEqual({
    remaining: stored.remaining,
    remainingCarrying: stored.remainingCarrying,
  });
  expect(await ledger1150(creditNoteId), `${step}: the note's 1150 ledger = its remaining carrying`).toBe(stored.remainingCarrying);
  const listed = await get(`/v1/suppliers/${supplierId}/credit-notes`);
  expect(listed.status, step).toBe(200);
  const item = must(
    (listed.body as { items: Record<string, unknown>[] }).items.find((n) => n.creditNoteId === creditNoteId),
    `${step}: the note is listed`,
  );
  expect(item, `${step}: GET …/credit-notes reads the stored pair`).toMatchObject({
    remainingTxnMinor: stored.remaining.toString(10),
    remainingCarryingBaseMinor: stored.remainingCarrying.toString(10),
  });
  return derived;
}

async function pay(p: HttpPurchase, date: string, currencyCode: string, amount: string, applied: string): Promise<Record<string, unknown>> {
  const body = payBody(p.supplierId, method, date, [{ purchaseId: p.purchaseId, paymentAmountMinor: amount, purchaseAmountAppliedMinor: applied }], {
    currencyCode,
  });
  const r = await httpPay(t, owner, A, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Record<string, unknown>;
}

describe('T-19 AL-26: every read is derived live, after every step', () => {
  it('a mixed USD scenario: ledger AP = O, base AP = B − Σ rel; supplier credit = Σ notes − Σ allocations − Σ refunds = stored', async () => {
    // The supplier's credit: 2 × 30.00 USD bought @ 3.60, paid in full, both returned.
    const note = await returnToCredit(t, owner, A, method, {
      currency: 'USD',
      documentDate: ago(9),
      lines: [{ productId: A.piece2.productId, quantity: '2', unitPrice: '30.00' }],
      quantity: '2',
    });
    const supplierId = note.purchase.supplierId;
    expect(await creditHolds(supplierId, note.creditNoteId, 'the note issued')).toEqual({ remaining: 6000n, remainingCarrying: 21600n });

    const p = await httpReceived(t, owner, A, {
      supplierId,
      currency: 'USD',
      documentDate: ago(8),
      lines: [{ productId: A.piece.productId, quantity: '4', unitPrice: '100.00' }],
    });
    expect(await apHolds(p, 'received')).toEqual({ o: 40000n, base: 144000n });

    const first = await pay(p, ago(5), 'USD', '10000', '10000');
    expect(await apHolds(p, 'paid 100.00 USD @ 3.60')).toEqual({ o: 30000n, base: 108000n });

    await pay(p, day, 'USD', '3333', '3333');
    expect((await apHolds(p, 'paid 33.33 USD @ 3.70')).o).toBe(26667n);

    await httpReturn(t, owner, A, p, '1');
    expect((await apHolds(p, 'one piece returned')).o).toBe(16667n);

    const alloc = allocateBody(note.creditNoteId, p.purchaseId, day, '3000');
    const a = await t.request.post('/v1/supplier-credit-allocations').set(asMember(owner, A.businessId)).send(alloc);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect((await apHolds(p, '30.00 USD of credit applied')).o).toBe(13667n);
    expect(await creditHolds(supplierId, note.creditNoteId, 'allocated')).toEqual({ remaining: 3000n, remainingCarrying: 10800n });

    await pay(p, day, 'ILS', '20000', '5000');
    expect((await apHolds(p, '50.00 USD paid as 200.00 ILS')).o).toBe(8667n);

    const final = await pay(p, day, 'USD', '8667', '8667');
    expect(await apHolds(p, 'the final flush'), 'the purchase clears to exactly zero').toEqual({ o: 0n, base: 0n });

    // The rest of the credit, received in two currencies.
    for (const [i, body] of [
      refundBody(note.creditNoteId, method, day, '1500', { receiptCurrencyCode: 'USD', receiptAmountMinor: '1500' }),
      refundBody(note.creditNoteId, method, day, '1500', { receiptCurrencyCode: 'ILS', receiptAmountMinor: '5400' }),
    ].entries()) {
      const r = await t.request.post('/v1/supplier-refunds').set(asMember(owner, A.businessId)).send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await creditHolds(supplierId, note.creditNoteId, `refund ${i + 1}`);
    }
    expect(await noteOf(ownerPool(), A.businessId, note.creditNoteId)).toMatchObject({ remaining: 0n, remainingCarrying: 0n });

    // The supplier's payable sums the same derivation (both its purchases at 0).
    const sp = await get(`/v1/suppliers/${supplierId}/payable`);
    expect(sp.status).toBe(200);
    expect((sp.body as { baseMinor: string }).baseMinor).toBe('0');
    for (const c of (sp.body as { byCurrency: { txnMinor: string }[] }).byCurrency) expect(c.txnMinor).toBe('0');

    // The stored-document reads answer the stored rows.
    const one = await get(`/v1/supplier-payments/${String(first.paymentId)}`);
    expect(one.status).toBe(200);
    const { replayed: _r, businessTransactionId: _b, ...stored } = first;
    expect(one.body).toEqual(stored);
    const list = await get(`/v1/suppliers/${supplierId}/payments`);
    expect(list.status).toBe(200);
    const ids = (list.body as { items: { paymentId: string }[] }).items.map((x) => x.paymentId);
    expect(ids, 'the supplier’s five payments (the note purchase’s and four on P)').toHaveLength(5);
    expect(ids).toContain(String(final.paymentId));
    const settlements = await get(`/v1/purchases/${p.purchaseId}/settlements`);
    expect(settlements.status).toBe(200);
    const s = settlements.body as { payments: { purchaseAmountAppliedMinor: string }[]; creditAllocations: { purchaseAmountAppliedMinor: string }[] };
    expect(s.payments.map((x) => x.purchaseAmountAppliedMinor)).toEqual(['10000', '3333', '5000', '8667']);
    expect(s.creditAllocations.map((x) => x.purchaseAmountAppliedMinor)).toEqual(['3000']);
  });
});

describe('T-19 G-3: no stored balance', () => {
  /** §7 G-3 as extended: the supplier, purchase and payment-method vocabulary. */
  const TABLE = /^(suppliers|supplier_[a-z0-9_]+|purchases|purchase_[a-z0-9_]+|payment_methods|payment_method_[a-z0-9_]+)$/;
  const COLUMN = /(^|_)(balances?|outstanding|paid|unpaid|due|owed|payable|settled)($|_)/;

  it('the live catalogue: no such table stores a balance, outstanding, paid, due or settled amount; remaining_* is the document', async () => {
    const r = await ownerPool().query<{ table: string; column: string }>(
      `SELECT c.relname AS table, a.attname AS column FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p', 'v', 'm')`,
    );
    const watched = r.rows.filter((x) => TABLE.test(x.table));
    const tables = new Set(watched.map((x) => x.table));
    for (const s6 of [
      'payment_methods',
      'payment_method_names',
      'supplier_payments',
      'supplier_payment_allocations',
      'supplier_credit_allocations',
      'supplier_refunds',
    ]) {
      expect(tables.has(s6), `${s6} is watched`).toBe(true);
    }
    const offenders = watched.filter((x) => COLUMN.test(x.column) && !/_(id|ids|at|by)$/.test(x.column)).map((x) => `${x.table}.${x.column}`);
    expect(offenders).toEqual([]);
    expect(
      [...tables].filter((x) => /(^|_)(balances?|outstanding|payables?|caches?|projections?|summar(y|ies)|snapshots?|rollups?)($|_)/.test(x)),
      'no balance or cache table',
    ).toEqual([]);
    expect(watched.map((x) => `${x.table}.${x.column}`)).toEqual(
      expect.arrayContaining(['supplier_credit_notes.remaining_amount_minor', 'supplier_credit_notes.remaining_carrying_base_amount_minor']),
    );
  });

  it('the repository guard over the migration tree watches the S6 settlement tables and finds nothing', () => {
    const dir = join(__dirname, '..', '..', 'infrastructure', 'database', 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const schema = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    const watched = discoverSupplierTables(schema);
    expect(watched).toEqual(expect.arrayContaining(['supplier_payments', 'supplier_payment_allocations', 'supplier_credit_allocations', 'supplier_refunds']));
    for (const table of watched) expect(isForbiddenSupplierTable(table), table).toBe(false);
    for (const f of files) expect(findAuthoritativeSupplierColumns(readFileSync(join(dir, f), 'utf8'), watched), f).toEqual([]);
  });
});
