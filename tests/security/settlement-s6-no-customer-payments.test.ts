/**
 * P3-S6 T-09 — MP-7: NO CUSTOMER PAYMENTS
 * (docs/PHASE_3_S6_CONTRACT.md A-01, A-05, A-22, §6 T-09; P:251).
 *
 * S6 settles SUPPLIERS only. Nothing of the customer side exists:
 *   - the tables `payments`, `payment_allocations`, `payment_reversals`,
 *     `refunds`, `customer_credits`, `credit_notes` are absent, and no
 *     relation names a customer, a sale or an invoice; the only settlement
 *     tables are the six S6 tables and the S5 supplier credit notes;
 *   - the routes `/v1/payments`, `/v1/customer-payments`, `/v1/refunds` (and
 *     their siblings) answer 404 to the business owner, for every verb;
 *   - no accounting source type and no operation kind names a payment, a
 *     sale, an invoice, a customer or a refund other than the three supplier
 *     source types and the four payment-METHOD kinds, in the database and in
 *     the package registry.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_SOURCE_TYPES } from '../../packages/accounting/src/post';
import { createTestApp, ensurePostgres, ownerPool, resetData, type TestApp } from '../helpers/test-app';
import { asMember, onboardS3Business, registerActor, type HttpActor, type S3Business } from '../helpers/inventory-commands';
import { S6_SOURCE_TYPES } from '../helpers/supplier-settlement';

let t: TestApp;
let owner: HttpActor;
let A: S3Business;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  t = await createTestApp();
  owner = await registerActor(t, 'S6 no-customer owner');
  A = await onboardS3Business(t, owner, 's6nocust');
});

afterAll(async () => {
  await t.close();
  await resetData();
});

describe('T-09 MP-7: no customer-payment table', () => {
  it('payments, payment_allocations, payment_reversals, refunds, customer_credits and credit_notes do not exist', async () => {
    for (const name of [
      'payments',
      'payment_allocations',
      'payment_reversals',
      'refunds',
      'customer_credits',
      'credit_notes',
      'customer_payments',
      'customer_refunds',
    ]) {
      const r = await ownerPool().query<{ oid: string | null }>(`SELECT to_regclass($1)::text AS oid`, [`public.${name}`]);
      expect(r.rows[0]?.oid ?? null, name).toBeNull();
    }
  });

  it('no relation names a customer, a sale or an invoice; the settlement relations are exactly the S6 tables and the S5 credit notes', async () => {
    const other = await ownerPool().query<{ n: string }>(
      `SELECT relname::text AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm')
          AND relname ~ '(customer|sale|invoice)' ORDER BY relname`,
    );
    expect(other.rows.map((r) => r.n)).toEqual([]);
    const settlement = await ownerPool().query<{ n: string }>(
      `SELECT relname::text AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm')
          AND relname ~ '(payment|refund|credit_note|credit_alloc)' ORDER BY relname`,
    );
    expect(settlement.rows.map((r) => r.n)).toEqual([
      'payment_method_names',
      'payment_methods',
      'supplier_credit_allocations',
      'supplier_credit_notes',
      'supplier_payment_allocations',
      'supplier_payments',
      'supplier_refunds',
    ]);
  });
});

describe('T-09 MP-7: no customer-payment route', () => {
  it('every verb on the customer-side paths is 404 for the business owner; the supplier routes exist (the ALLOW)', async () => {
    const id = randomUUID();
    const paths = [
      '/v1/payments',
      `/v1/payments/${id}`,
      '/v1/customer-payments',
      `/v1/customer-payments/${id}`,
      '/v1/refunds',
      `/v1/refunds/${id}`,
      '/v1/customer-refunds',
      '/v1/customer-credits',
      '/v1/credit-notes',
      `/v1/customers/${id}/payments`,
      '/v1/invoices',
      '/v1/sales',
    ];
    const headers = asMember(owner, A.businessId);
    for (const path of paths) {
      for (const verb of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const r = await t.request[verb](path).set(headers).send({});
        expect(r.status, `${verb.toUpperCase()} ${path}`).toBe(404);
      }
    }
    // The supplier side answers (not 404): the routes exist and are reached.
    expect((await t.request.get(`/v1/supplier-payments/${id}`).set(headers)).status).toBe(404);
    const reached = await t.request.post('/v1/supplier-payments').set(headers).send({});
    expect(reached.status, 'the supplier payment route validates its body').toBe(400);
  });
});

describe('T-09 MP-7: no customer source type or operation kind', () => {
  it('the accounting registry holds the three supplier types and nothing of the customer side', async () => {
    const types = await ownerPool().query<{ t: string }>(`SELECT source_type AS t FROM accounting_source_types ORDER BY sort_order`);
    const names = types.rows.map((r) => r.t);
    expect(names.filter((n) => /payment|refund|sale|invoice|customer|credit/.test(n))).toEqual([...S6_SOURCE_TYPES]);
    const kinds = await ownerPool().query<{ s: string }>(
      `SELECT DISTINCT source_type AS s FROM accounting_operation_kinds WHERE source_type ~ '(payment|refund|sale|invoice|customer)' ORDER BY 1`,
    );
    expect(kinds.rows.map((r) => r.s)).toEqual(['supplier_payment', 'supplier_refund']);
    expect((DOMAIN_SOURCE_TYPES as readonly string[]).filter((n) => /payment|refund|sale|invoice|customer|credit/.test(n))).toEqual([...S6_SOURCE_TYPES]);
  });

  it('the operation kinds: the only payment.* kinds are the four METHOD kinds; nothing names a sale, an invoice, a customer or a refund other than the supplier one', async () => {
    const r = await ownerPool().query<{ k: string }>(`SELECT op_code AS k FROM inventory_operation_kinds ORDER BY op_code`);
    const ops = r.rows.map((x) => x.k);
    expect(ops.filter((k) => k.startsWith('payment.'))).toEqual([
      'payment.activate_method',
      'payment.create_method',
      'payment.deactivate_method',
      'payment.update_method',
    ]);
    expect(ops.filter((k) => /sale|invoice|customer/.test(k))).toEqual([]);
    expect(ops.filter((k) => /refund/.test(k))).toEqual(['supplier.receive_refund']);
  });
});
