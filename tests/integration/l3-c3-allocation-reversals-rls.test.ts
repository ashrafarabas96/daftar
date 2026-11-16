/**
 * C3 — THE OWNER'S TWO CONDITIONS ON THE GRANT (`DR-168`), PROVED.
 *
 * The owner signed `GRANT SELECT ON allocation_reversals TO daftar_app` on two
 * blocking conditions, in these words: row security ENABLEd and FORCEd on the
 * table with a `business_id` policy, and a red test that another merchant
 * reads ZERO rows through the reader. This file is that proof, and it is
 * deliberately independent of the API half: the reversal row is written here
 * by the table's owner, copying its allocation's own figures, so what is under
 * test is the READ ISOLATION and not the command.
 *
 * WHY `FORCE` IS THE CLAUSE THAT CARRIES IT. `ENABLE ROW LEVEL SECURITY`
 * leaves the table's OWNER exempt; `FORCE` is what subjects the owner too.
 * The lane that lost `#98` lost it exactly there — a write from another tenant
 * answered "taken 1 row(s)" instead of `42501` — so §2 below plants the
 * absence of `FORCE` and shows this file's own claim collapsing, inside a
 * transaction it rolls back. A claim that cannot fail is not a proof.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDbUrl, dbUrl, ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { settlementWorld, settlementMissing, stockUp, newCustomer, sellOnCredit, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import { derivedRead, must } from '../golden-regression/phase4-s4/harness';
import { collectPayment, type AllocationInput } from '../golden-regression/phase4-s4/settlement-path';

const TABLE = 'allocation_reversals';

let a: SettlementWorld;
let b: SettlementWorld;
/** The invoice of business A whose allocation is reversed. */
let invoiceId = '';
let allocationId = '';
let reversalId = '';
let legMinor = 0n;
let totalTxn = 0n;

/** A `daftar_app` connection pinned to one business, which is how the runtime reads. */
async function appAs(w: SettlementWorld): Promise<Client> {
  const c = new Client({ connectionString: appDbUrl });
  await c.connect();
  await c.query(`SELECT set_config('app.tenant_id', $1, false), set_config('app.business_id', $2, false), set_config('app.bypass_rls', 'false', false)`, [
    w.shop.tenantId,
    w.shop.businessId,
  ]);
  return c;
}

beforeAll(async () => {
  await ensurePostgres();
  await resetData();

  a = await settlementWorld('l3 c3 rls a');
  const missingA = await settlementMissing(a);
  expect(missingA, `the settlement subject must be complete: ${missingA.join(', ')}`).toEqual([]);
  await stockUp(a, '1000', '1000');
  const customer = await newCustomer(a);
  const invoice = await sellOnCredit(a, customer, '8');
  invoiceId = invoice.invoiceId;
  totalTxn = BigInt(invoice.totalTxnMinor);
  legMinor = totalTxn / 2n;
  expect(legMinor > 0n, 'NO SUBJECT — half of this invoice is zero, so there is no partial allocation to reverse').toBe(true);

  const leg: AllocationInput = {
    invoiceId,
    appliedMinor: legMinor.toString(),
    releasedBeforeMinor: '0',
    invoiceTotalTxnMinor: invoice.totalTxnMinor,
    invoiceTotalBaseMinor: invoice.totalBaseMinor,
  };
  const paid = await collectPayment(a.t, a.headers, {
    paymentId: randomUUID(),
    customerId: customer,
    paymentMethodId: a.paymentMethodId,
    paymentDate: a.day,
    amountMinor: legMinor.toString(),
    allocations: [leg],
  });
  expect(paid.status, `the half payment is accepted: ${JSON.stringify(paid.body)}`).toBeLessThan(300);

  const alloc = await ownerPool().query<{ id: string }>(`SELECT a.id::text AS id FROM payment_allocations a WHERE a.business_id = $1 AND a.invoice_id = $2`, [
    a.shop.businessId,
    invoiceId,
  ]);
  allocationId = must(alloc.rows[0], 'the allocation this case reverses').id;

  // THE REVERSAL, written by the table's owner from the allocation's own
  // stored figures — which is also what `allocation_reversal_value_conserved`
  // demands, so a typo here is refused at COMMIT rather than measured.
  reversalId = randomUUID();
  await ownerPool().query(
    `INSERT INTO allocation_reversals (
       tenant_id, business_id, id, allocation_id, payment_id, customer_id, invoice_id,
       reversal_date, invoice_currency, invoice_amount_applied_minor,
       invoice_historical_to_base_rate, invoice_carrying_base_released_minor,
       reason, business_transaction_id, created_by, binding_source_id)
     SELECT x.tenant_id, x.business_id, $2::uuid, x.id, x.payment_id, x.customer_id, x.invoice_id,
            $3::date, x.invoice_currency, x.invoice_amount_applied_minor,
            x.invoice_historical_to_base_rate, x.invoice_carrying_base_released_minor,
            'the merchant allocated this to the wrong invoice', inventory_business_transaction_id(), x.created_by, $2::uuid
       FROM payment_allocations x
      WHERE x.business_id = $1 AND x.id = $4::uuid`,
    [a.shop.businessId, reversalId, a.day, allocationId],
  );

  b = await settlementWorld('l3 c3 rls b');
  const missingB = await settlementMissing(b);
  expect(missingB, `the second business must be complete too: ${missingB.join(', ')}`).toEqual([]);
}, 900_000);

afterAll(async () => {
  await ownerPool()
    .query('SELECT 1')
    .catch(() => undefined);
});

describe("C3 §1 — the owner's first condition: ENABLE, FORCE and a business_id policy", () => {
  it('row security is enabled AND forced on the relation', async () => {
    const r = await ownerPool().query<{ enabled: boolean; forced: boolean }>(
      `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c WHERE c.oid = ('public.' || $1)::regclass`,
      [TABLE],
    );
    const row = must(r.rows[0], `the relation ${TABLE} must exist`);
    expect(row.enabled, 'ENABLE ROW LEVEL SECURITY').toBe(true);
    expect(row.forced, 'FORCE ROW LEVEL SECURITY — without it the table OWNER is exempt, which is how #98 was lost').toBe(true);
  }, 120_000);

  it('and a policy keyed on business_id governs reading it', async () => {
    const r = await ownerPool().query<{ policyname: string; qual: string | null }>(
      `SELECT p.policyname, p.qual FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = $1`,
      [TABLE],
    );
    expect(r.rows.length, 'the table must carry policies at all').toBeGreaterThan(0);
    const businessKeyed = r.rows.filter((x) => (x.qual ?? '').includes('business_id'));
    expect(
      businessKeyed.map((x) => x.policyname).sort(),
      `a policy whose USING names business_id must exist; found ${r.rows.map((x) => x.policyname).join(', ')}`,
    ).toContain('business_isolation_read');
  }, 120_000);
});

describe('C3 §2 — and that claim can fail: without FORCE it collapses', () => {
  it('NO FORCE, inside a transaction this case rolls back, breaks §1', async () => {
    const conn = new Client({ connectionString: dbUrl });
    await conn.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(`ALTER TABLE ${TABLE} NO FORCE ROW LEVEL SECURITY`);
      const r = await conn.query<{ forced: boolean }>(`SELECT c.relforcerowsecurity AS forced FROM pg_class c WHERE c.oid = ('public.' || $1)::regclass`, [
        TABLE,
      ]);
      expect(must(r.rows[0], 'the relation').forced, 'the plant must really have removed FORCE, or this control proves nothing').toBe(false);
    } finally {
      await conn.query('ROLLBACK').catch(() => undefined);
      await conn.end().catch(() => undefined);
    }
    const after = await ownerPool().query<{ forced: boolean }>(
      `SELECT c.relforcerowsecurity AS forced FROM pg_class c WHERE c.oid = ('public.' || $1)::regclass`,
      [TABLE],
    );
    expect(must(after.rows[0], 'the relation').forced, 'the rollback took the plant with it').toBe(true);
  }, 120_000);
});

describe("C3 §3 — the owner's second condition: another merchant reads ZERO, through the reader", () => {
  it('business B sees no reversal row at all, and the reader refuses A’s invoice to it', async () => {
    const other = await appAs(b);
    try {
      // The table itself, as the runtime role of ANOTHER business: zero rows.
      // The grant is SELECT, so this is a read the privilege allows and only
      // row security refuses — which is the point of the owner's condition.
      const seen = await other.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${TABLE}`);
      expect(must(seen.rows[0], 'a count').c, 'another merchant must see no reversal of this one').toBe('0');

      // AND THROUGH THE READER, which is what the condition names: asking
      // about A's invoice as B answers `invoice.not_found` rather than a
      // figure — under row security a cross-business id is not found, and that
      // is G-02's own wording.
      let message = '';
      try {
        await other.query(`SELECT * FROM invoice_outstanding($1::uuid, ARRAY[$2::uuid])`, [b.shop.businessId, invoiceId]);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message, `the reader must refuse another business's invoice by not finding it: ${message}`).toContain('invoice.not_found');
    } finally {
      await other.end().catch(() => undefined);
    }
  }, 300_000);

  it('while business A, through the same reader, sees the debt come back', async () => {
    const read = await derivedRead(ownerPool(), a.shop.businessId, invoiceId);
    // The half allocation settled half the invoice; the reversal gives that
    // half back. Read through the estate's own reader, so the figure is the
    // one a merchant sees — and asserted against the invoice's own total,
    // captured from the document and not recomputed here.
    expect(read.paidTxnMinor, 'the only allocation was reversed, so nothing is paid').toBe(0n);
    expect(read.outstandingTxnMinor, 'the whole invoice is owed again, to the minor unit').toBe(totalTxn);
  }, 300_000);
});
