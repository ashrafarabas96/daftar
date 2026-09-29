/**
 * P3-S6 — THE OD-03 TAX BOUNDARY (docs/PHASE_3_S6_CONTRACT.md A-21).
 *
 * S6 is designed only for the zero case. Withholding tax on a payment, tax on
 * a refund and tax-inclusive settlement are each BLOCKED BY OD-03, so:
 *   - no S6 table has a tax column, no S6 routine a tax argument, and
 *     neither S6 migration names tax at all;
 *   - no request accepts a tax field: a payment (header or allocation), a
 *     credit allocation, a refund, a receive-and-pay (body or payment half)
 *     or a method carrying one is 400 at the strict DTO, nothing minted or
 *     written;
 *   - no S6 entry has a line on `tax_payable` or any account whose system
 *     key names tax — while the books hold `tax_payable`, so the absence is
 *     not vacuous — and every purchase an S6 document settles has
 *     `tax_minor = 0` under `purchases_tax_policy_absent_ck`.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, today, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import {
  S6_ROUTINE_OF,
  S6_SOURCE_TYPES,
  S6_TABLES,
  S6_WRITER,
  allocateBody,
  httpDraft,
  httpMethod,
  httpReceived,
  methodBody,
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

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  day = await today();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 tax owner');
  A = await onboardS3Business(t, owner, 's6tax');
  acc = await seedSettlementAccounts(ownerPool(), A);
  method = await httpMethod(t, owner, A, acc.settlement.bank, { systemType: 'bank_transfer' });
});

afterAll(async () => {
  await t.close();
  await resetData();
});

const post = (path: string, body: Record<string, unknown>): Promise<Response> => t.request.post(path).set(asMember(owner, A.businessId)).send(body);

describe('A-21 OD-03: no tax object in S6', () => {
  it('no S6 table has a tax column; no S6 routine a tax argument; neither migration names tax', async () => {
    const cols = await ownerPool().query<{ t: string; col: string }>(
      `SELECT table_name::text AS t, column_name::text AS col FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND column_name ~ 'tax|vat|withholding'`,
      [[...S6_TABLES]],
    );
    expect(cols.rows).toEqual([]);
    const tables = await ownerPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r'`, [
      [...S6_TABLES],
    ]);
    expect(tables.rows[0]?.n, 'every S6 table exists, so the absence is not vacuous').toBe(S6_TABLES.length);
    const routines = [...Object.values(S6_ROUTINE_OF), S6_WRITER];
    const args = await ownerPool().query<{ fn: string; names: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS fn, p.proargnames AS names FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[])`,
      [routines],
    );
    expect(args.rows).toHaveLength(routines.length);
    for (const r of args.rows)
      expect(
        (r.names ?? []).filter((n) => /tax|vat|withholding/.test(n)),
        r.fn,
      ).toEqual([]);
    const dir = join(__dirname, '..', '..', 'infrastructure', 'database', 'migrations');
    for (const f of ['0067_payment_methods_supplier_settlement_sources.sql', '0068_supplier_settlement_commands.sql']) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/\btax|\bvat\b|withholding/i);
    }
  });

  it('a tax field on any S6 request is 400 at the strict DTO, nothing written', async () => {
    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece.productId, quantity: '2', unitPrice: '50.00' }], quantity: '2' });
    const p = await httpReceived(t, owner, A, { supplierId: note.purchase.supplierId });
    const d = await httpDraft(t, owner, A);
    const pay = payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '1000' }]);
    const allocations = pay.allocations as Record<string, unknown>[];
    const payHalf = { paymentId: randomUUID(), allocationId: randomUUID(), paymentMethodId: method, currencyCode: 'ILS', amountMinor: '1000' };
    const cases: readonly (readonly [string, string, Record<string, unknown>])[] = [
      ['payment: withholding tax', '/v1/supplier-payments', { ...pay, withholdingTaxMinor: '100' }],
      ['payment: tax', '/v1/supplier-payments', { ...pay, taxMinor: '0' }],
      ['payment allocation: tax', '/v1/supplier-payments', { ...pay, allocations: allocations.map((a) => ({ ...a, taxMinor: '0' })) }],
      ['credit allocation: tax', '/v1/supplier-credit-allocations', { ...allocateBody(note.creditNoteId, p.purchaseId, day, '100'), taxMinor: '0' }],
      ['refund: tax', '/v1/supplier-refunds', { ...refundBody(note.creditNoteId, method, day, '100'), taxMinor: '0' }],
      ['refund: tax inclusive', '/v1/supplier-refunds', { ...refundBody(note.creditNoteId, method, day, '100'), taxInclusive: true }],
      ['receive-and-pay: tax', `/v1/purchases/${d.purchaseId}/receive-and-pay`, { draftRevision: 1, taxMinor: '0', payment: payHalf }],
      [
        'receive-and-pay payment half: withholding',
        `/v1/purchases/${d.purchaseId}/receive-and-pay`,
        { draftRevision: 1, payment: { ...payHalf, withholdingTaxMinor: '100' } },
      ],
      ['method: tax rate', '/v1/payment-methods', { ...methodBody(acc.settlement.cash), taxRate: '0.16' }],
    ];
    const before = await s6Counts(ownerPool(), A.businessId);
    for (const [what, path, body] of cases) {
      const r = await post(path, body);
      expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBe(400);
      expect((r.body as { error?: { code?: string } }).error?.code, what).toBe('VALIDATION_FAILED');
    }
    expect(await s6Counts(ownerPool(), A.businessId), 'nothing written').toEqual(before);
    // The same bodies without the tax field are admitted (the DENY is about the field).
    expect((await post('/v1/supplier-payments', pay)).status).toBe(201);
    expect((await post(`/v1/purchases/${d.purchaseId}/receive-and-pay`, { draftRevision: 1, payment: payHalf })).status).toBe(200);
  });

  it('no S6 entry has a tax line, while the books hold tax_payable; every settled purchase has tax_minor = 0', async () => {
    const note = await returnToCredit(t, owner, A, method, { lines: [{ productId: A.piece2.productId, quantity: '2', unitPrice: '50.00' }], quantity: '2' });
    const p = await httpReceived(t, owner, A, { supplierId: note.purchase.supplierId });
    expect((await post('/v1/supplier-credit-allocations', allocateBody(note.creditNoteId, p.purchaseId, day, '1000'))).status).toBe(201);
    expect((await post('/v1/supplier-refunds', refundBody(note.creditNoteId, method, day, '1000'))).status).toBe(201);
    expect((await post('/v1/supplier-payments', payBody(p.supplierId, method, day, [{ purchaseId: p.purchaseId, paymentAmountMinor: '1000' }]))).status).toBe(
      201,
    );

    const books = await ownerPool().query<{ k: string }>(`SELECT system_key AS k FROM accounts WHERE business_id = $1 AND system_key ~ 'tax'`, [A.businessId]);
    expect(books.rows.map((x) => x.k)).toContain('tax_payable');
    const lines = await ownerPool().query<{ source_type: string; k: string | null }>(
      `SELECT e.source_type, a.system_key AS k FROM journal_entries e
         JOIN journal_lines l ON l.business_id = e.business_id AND l.journal_entry_id = e.id
         JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
        WHERE e.business_id = $1 AND e.source_type = ANY($2::text[])`,
      [A.businessId, [...S6_SOURCE_TYPES]],
    );
    expect(new Set(lines.rows.map((x) => x.source_type)), 'every S6 source type posted').toEqual(new Set(S6_SOURCE_TYPES));
    expect(lines.rows.filter((x) => x.k !== null && /tax/.test(x.k))).toEqual([]);

    const settled = await ownerPool().query<{ t: string }>(
      `SELECT DISTINCT p.tax_minor::text AS t FROM purchases p
        WHERE p.business_id = $1
          AND (p.id IN (SELECT purchase_id FROM supplier_payment_allocations WHERE business_id = $1)
               OR p.id IN (SELECT purchase_id FROM supplier_credit_allocations WHERE business_id = $1)
               OR p.id IN (SELECT sr.purchase_id FROM supplier_credit_notes n
                            JOIN supplier_returns sr ON sr.business_id = n.business_id AND sr.id = n.supplier_return_id
                            JOIN supplier_refunds r ON r.business_id = n.business_id AND r.credit_note_id = n.id
                           WHERE n.business_id = $1))`,
      [A.businessId],
    );
    expect(settled.rows.map((x) => x.t)).toEqual(['0']);
    const ck = await ownerPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'purchases'::regclass AND conname = 'purchases_tax_policy_absent_ck'`,
    );
    expect(ck.rows.map((x) => x.def)).toEqual(['CHECK ((tax_minor = 0))']);
  });
});
