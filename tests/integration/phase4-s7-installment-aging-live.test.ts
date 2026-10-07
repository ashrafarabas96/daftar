/**
 * P4-S7 — THE SCHEDULE VERIFIER AND THE PROJECTION, AGAINST A REAL INVOICE.
 *
 * The companion suite `phase4-s7-installment-aging-db.test.ts` settles that
 * the specification CREATES: the parser's opinion, in a scratch database. It
 * does not settle that the triggers FIRE, because a scratch database has no
 * invoice — and an installment plan's FK closure reaches
 * `invoices -> accounting_source_bindings -> journal_entries -> journal_lines`
 * with reverse deferred constraints, so a hand-forged invoice is not a cheaper
 * fixture than a real one, it is a different and unsound one.
 *
 * So the subject here is a REAL open credit invoice, committed through the
 * only sanctioned producer (`POST /v1/sales`, P4-S2), against the live
 * database of this worker's own exclusive cluster.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────
 *
 * §0 NON-VACUITY. The slice applied, the invoice is open, credit, carries
 *    money, and has a due date.
 * §B THE TRIGGERS FIRE, AT COMMIT, IN EVERY DIRECTION THE SUM CAN BE BROKEN:
 *      B1 a schedule summing BELOW the invoice total is refused;
 *      B2 a schedule summing ABOVE the invoice total is refused;
 *      B3 a COMPLETE schedule from which one row is DELETED is refused —
 *         the arm design §17.4 argued for structurally and which, until this
 *         file ran, had never executed in any form;
 *      B4 a non-contiguous `seq_no` is refused by obligation (c), so (c) is
 *         an exemption that is EVALUATED and not merely written.
 *    Each refusal is asserted to arrive AT COMMIT and not at the statement,
 *    which is the whole point of `DEFERRABLE INITIALLY DEFERRED`: a long
 *    schedule is written row by row and judged once.
 * §C EQUAL IS ACCEPTED. Without this, §B is a refusal of everything rather
 *    than a discrimination, and a verifier that raised unconditionally would
 *    pass §B four times.
 * §D PR-6 IS REAL, MEASURED. `daftar_app` holds no EXECUTE on
 *    `supplier_ap_release`, so the projection's base column is unreachable to
 *    the application role until the Migration Owner grants it. The blocked
 *    privilege request is therefore a measurement, not a worry.
 * §E THE 265-DAY CASE THROUGH THE ROUTINE. The permanent counterexample has
 *    only ever been computed by the TypeScript reference model. Here it is
 *    asked of `customer_ar_aging` in the installed database, and the live
 *    predecessor's answer to the same question is captured BEFORE the
 *    specification is applied — so the defect and its repair are two readings
 *    of one function, not a reading and a belief.
 *
 * THE LIVE DEFINITION IS RESTORED. The specification contains
 * `CREATE OR REPLACE FUNCTION customer_ar_aging(...)`, which REPLACES the
 * predecessor in this database. `pg_get_functiondef` is captured before the
 * replacement and executed again in `afterAll`, and the installment relations
 * are dropped — so this suite leaves the database as it found it rather than
 * leaving a replaced reader of record behind for whatever runs next.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { appDbUrl, ownerPool } from '../helpers/test-app';
import { confirmSale } from '../golden-regression/phase4-s2/sale-path';
import { invoiceTotals, must } from '../golden-regression/phase4-s4/harness';
import { newCustomer, settlementWorld, stockUp, type SettlementWorld } from '../golden-regression/phase4-s4/settlement-world';
import {
  CORRECT_POLICY,
  projectCustomerAging,
  type InstallmentPlan,
  type OpenInvoiceRow,
} from '../../packages/domain-core/test/phase4-s7-aging-reference-model';

const SPEC = readFileSync(
  join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'),
  'utf8',
);

/** `[30, 60, 90]` — four bands, the shape every S4 reading uses. */
const BUCKET_DAYS = [30, 60, 90];

interface AgingRow {
  readonly bucket_no: number;
  readonly currency_code: string;
  readonly txn_minor: string;
  readonly base_minor: string;
  readonly invoice_count: number;
}

let w: SettlementWorld;
let invoiceId = '';
let currencyCode = '';
let customerId: string;
let dueDate = '';
let asOf = '';
/** The predecessor's definition, captured before the specification replaces it. */
let liveDefinition = '';
/** The predecessor's answer to the 265-day question, with no plan in existence. */
let predecessorReading: readonly AgingRow[] = [];
let specError: string | null = null;

/** The one authoritative total, read back from the stored invoice row. */
let total = 0n;

async function aging(as_of: string): Promise<readonly AgingRow[]> {
  const r = await ownerPool().query<AgingRow>(
    `SELECT * FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[]) ORDER BY bucket_no`,
    [w.shop.businessId, customerId, as_of, BUCKET_DAYS],
  );
  return r.rows;
}

/**
 * Write a plan and its schedule in ONE transaction and try to commit it.
 * Returns the error message, or `null` when it committed — and records
 * whether every statement was ACCEPTED, which is what makes the refusal a
 * deferred one.
 */
async function commitPlan(rows: readonly { seq: number; amount: bigint; due: string }[], o: { downMinor?: bigint; planId?: string } = {}): Promise<{ error: string | null; statementsAccepted: boolean; planId: string }> {
  const planId = o.planId ?? randomUUID();
  const client = await ownerPool().connect();
  let statementsAccepted = false;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO installment_plans (tenant_id, business_id, id, invoice_id, customer_id, status,
                                      down_payment_minor, down_payment_due_date, created_by, business_transaction_id)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7::DATE, $8, $9)`,
      [w.shop.tenantId, w.shop.businessId, planId, invoiceId, customerId, String(o.downMinor ?? 0n), dueDate, w.shop.userId, randomUUID()],
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO installments (tenant_id, business_id, id, plan_id, seq_no, due_date, amount_txn_minor)
         VALUES ($1, $2, $3, $4, $5, $6::DATE, $7)`,
        [w.shop.tenantId, w.shop.businessId, randomUUID(), planId, row.seq, row.due, String(row.amount)],
      );
    }
    statementsAccepted = true;
    await client.query('COMMIT');
    return { error: null, statementsAccepted, planId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { error: e instanceof Error ? e.message : String(e), statementsAccepted, planId };
  } finally {
    client.release();
  }
}

/**
 * Remove a plan and its whole schedule, IN ONE TRANSACTION.
 *
 * It cannot be two statements in two transactions, and that is the verifier's
 * design and not a fixture quirk: deleting the installments alone drops the
 * schedule sum to zero against a live total, which obligation (a) refuses —
 * correctly. Removing the PLAN in the same transaction reaches the verifier's
 * `IF NOT FOUND THEN RETURN NULL` arm («a plan deleted inside this transaction
 * implicates nothing: there is no schedule left to be incomplete»), so this
 * helper is also the only thing that exercises that arm.
 */
async function removePlan(planId: string): Promise<string | null> {
  const client = await ownerPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM installments WHERE business_id = $1 AND plan_id = $2`, [w.shop.businessId, planId]);
    await client.query(`DELETE FROM installment_plans WHERE business_id = $1 AND id = $2`, [w.shop.businessId, planId]);
    await client.query('COMMIT');
    return null;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    return e instanceof Error ? e.message : String(e);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  w = await settlementWorld('p4s7 live schedule');
  await stockUp(w, '400', '1000');
  customerId = await newCustomer(w);

  // THE DUE DATE IS STATED ON THE SALE, and this is not a convenience.
  // `sellOnCredit` states none, and an invoice with NO due date comes back
  // with `due_date IS NULL` — which `customer_ar_aging` reads as the
  // not-yet-due band and which makes every aging figure here meaningless.
  // `sale.due_date_invalid` (`0078:636`) refuses a due date BEFORE the
  // document date, so equal to the document date is the earliest lawful one.
  const saleId = randomUUID();
  const sale = await confirmSale(w.t, w.headers, {
    saleId,
    customerId,
    warehouseId: w.shop.w1,
    branchId: w.shop.branchX,
    occurredOn: w.day,
    dueDate: w.day,
    lines: [{ productId: w.shop.piece.productId, quantity: '9' }],
  });
  expect(sale.status, `the credit sale commits: ${JSON.stringify(sale.body)}`).toBeLessThan(300);
  const found = await ownerPool().query<{ invoice_id: string; status: string; settlement_mode: string }>(
    `SELECT i.id::text AS invoice_id, i.status, s.settlement_mode
       FROM sales s JOIN invoices i ON i.business_id = s.business_id AND i.sale_id = s.id
      WHERE s.business_id = $1 AND s.id = $2`,
    [w.shop.businessId, saleId],
  );
  const row = must(found.rows[0], `the committed sale ${saleId} and its invoice`);
  expect(row.status, 'an open invoice is the only status the reader of record reads (0075:722)').toBe('open');
  expect(row.settlement_mode, 'a receivable is a CREDIT invoice').toBe('credit');
  invoiceId = row.invoice_id;
  const totals = await invoiceTotals(ownerPool(), w.shop.businessId, invoiceId);
  total = BigInt(totals.totalTxnMinor);
  currencyCode = totals.currencyCode;

  const d = await ownerPool().query<{ due_date: string | null; as_of: string | null }>(
    `SELECT to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
            to_char(i.due_date + 265, 'YYYY-MM-DD') AS as_of
       FROM invoices i WHERE i.business_id = $1 AND i.id = $2`,
    [w.shop.businessId, invoiceId],
  );
  dueDate = d.rows[0]?.due_date ?? '';
  asOf = d.rows[0]?.as_of ?? '';
  expect(dueDate, 'the invoice carries a real due date, or every figure below is about the wrong document').toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // THE PREDECESSOR'S ANSWER, before anything of this slice exists.
  liveDefinition = (
    await ownerPool().query<{ def: string }>(
      `SELECT pg_get_functiondef('customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure) AS def`,
    )
  ).rows[0]?.def ?? '';
  predecessorReading = await aging(asOf);

  try {
    await ownerPool().query(SPEC);
  } catch (e) {
    specError = e instanceof Error ? `${(e as { code?: string }).code ?? '?'}: ${e.message}` : String(e);
  }
}, 900_000);

afterAll(async () => {
  const p = ownerPool();
  await p.query('DROP TABLE IF EXISTS installments').catch(() => undefined);
  await p.query('DROP TABLE IF EXISTS installment_plans').catch(() => undefined);
  await p.query('DROP FUNCTION IF EXISTS installment_schedule_verify()').catch(() => undefined);
  if (liveDefinition !== '') await p.query(liveDefinition).catch(() => undefined);
}, 120_000);

// ═══════════════════════════════════════════════════════════════════════════
describe('§0 NON-VACUITY — the subject is a real open credit invoice and the slice applied', () => {
  it('the specification applied to the live database, and if it did not THIS MESSAGE IS THE FINDING', () => {
    expect(specError, `the specification does not apply to the live database: ${specError ?? ''}`).toBeNull();
  });

  it('the invoice is open, credit, carries money and has a due date', async () => {
    const r = await ownerPool().query<{ status: string; due_date: string | null; total_txn_minor: string }>(
      `SELECT i.status, i.due_date::text AS due_date, i.total_txn_minor::text
         FROM invoices i WHERE i.business_id = $1 AND i.id = $2`,
      [w.shop.businessId, invoiceId],
    );
    expect(r.rows[0]?.status).toBe('open');
    expect(r.rows[0]?.due_date).not.toBeNull();
    expect(total > 0n, `NO SUBJECT: the invoice totals ${String(total)}`).toBe(true);
    expect(dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the horizon really is 265 days past the due date, measured BY POSTGRESQL', async () => {
    const r = await ownerPool().query<{ days: number }>(`SELECT ($1::DATE - $2::DATE) AS days`, [asOf, dueDate]);
    expect(r.rows[0]?.days).toBe(265);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§B THE TRIGGERS FIRE — at COMMIT, in every direction the sum can be broken', () => {
  it('B1 a schedule summing BELOW the invoice total is REFUSED, and refused at COMMIT', async () => {
    const r = await commitPlan([{ seq: 1, amount: total - 1n, due: dueDate }]);
    expect(r.statementsAccepted, 'every statement was accepted — the refusal is DEFERRED, not immediate').toBe(true);
    expect(r.error ?? '').toContain('installment.schedule_incomplete');
    expect(r.error ?? '').toContain('(a)');
  });

  it('B2 a schedule summing ABOVE the invoice total is REFUSED by the same comparison', async () => {
    const r = await commitPlan([{ seq: 1, amount: total + 1n, due: dueDate }]);
    expect(r.statementsAccepted).toBe(true);
    expect(r.error ?? '').toContain('installment.schedule_incomplete');
    expect(r.error ?? '').toContain('(a)');
  });

  it('B3 DELETING a row from a COMPLETE schedule is REFUSED — the arm that had never executed', async () => {
    const half = total / 2n;
    const planId = randomUUID();
    const seeded = await commitPlan(
      [
        { seq: 1, amount: half, due: dueDate },
        { seq: 2, amount: total - half, due: dueDate },
      ],
      { planId },
    );
    expect(seeded.error, `the complete schedule must commit first, or the DELETE arm has no subject: ${seeded.error ?? ''}`).toBeNull();

    const client = await ownerPool().connect();
    let deleteAccepted = false;
    let error: string | null = null;
    try {
      await client.query('BEGIN');
      const del = await client.query(`DELETE FROM installments WHERE business_id = $1 AND plan_id = $2 AND seq_no = 2`, [w.shop.businessId, planId]);
      expect(del.rowCount, 'the DELETE really removed a row, or the trigger had nothing to fire on').toBe(1);
      deleteAccepted = true;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      error = e instanceof Error ? e.message : String(e);
    } finally {
      client.release();
    }
    expect(deleteAccepted, 'the DELETE statement itself was accepted — the refusal is at COMMIT').toBe(true);
    expect(error ?? '').toContain('installment.schedule_incomplete');
    expect(error ?? '').toContain('(a)');

    // and the complete plan survives, because the refusal rolled the DELETE back
    const after = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM installments WHERE business_id = $1 AND plan_id = $2`, [w.shop.businessId, planId]);
    expect(after.rows[0]?.n).toBe('2');
    // AND THE EXEMPTION IS EVALUATED TOO: removing the plan WITH its schedule
    // in one transaction is accepted, which is the `IF NOT FOUND` arm. Without
    // this, obligation (a) would make a cancelled plan undeletable.
    expect(await removePlan(planId), 'a plan and its whole schedule can be removed in one transaction').toBeNull();
    const gone = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM installment_plans WHERE business_id = $1 AND id = $2`, [w.shop.businessId, planId]);
    expect(gone.rows[0]?.n).toBe('0');
  });

  it('B4 a NON-CONTIGUOUS seq_no is refused by obligation (c), so (c) is evaluated and not merely written', async () => {
    const half = total / 2n;
    const r = await commitPlan([
      { seq: 1, amount: half, due: dueDate },
      { seq: 7, amount: total - half, due: dueDate },
    ]);
    expect(r.statementsAccepted).toBe(true);
    expect(r.error ?? '').toContain('installment.schedule_incomplete');
    expect(r.error ?? '').toContain('(c)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§C EQUAL IS ACCEPTED — so §B is a discrimination and not a refusal of everything', () => {
  it('a schedule summing EXACTLY to the invoice total commits, down payment included', async () => {
    const down = 1000n;
    const rest = total - down;
    const a = rest / 3n;
    const r = await commitPlan(
      [
        { seq: 1, amount: a, due: dueDate },
        { seq: 2, amount: a, due: dueDate },
        { seq: 3, amount: rest - 2n * a, due: dueDate },
      ],
      { downMinor: down },
    );
    expect(r.error, `the exact schedule must commit: ${r.error ?? ''}`).toBeNull();
    const back = await ownerPool().query<{ n: string; s: string }>(
      `SELECT count(*)::text AS n, coalesce(sum(amount_txn_minor), 0)::text AS s FROM installments WHERE business_id = $1 AND plan_id = $2`,
      [w.shop.businessId, r.planId],
    );
    expect(back.rows[0]?.n).toBe('3');
    expect(BigInt(back.rows[0]?.s ?? '0') + down).toBe(total);
    expect(await removePlan(r.planId)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§E THE 265-DAY CASE THROUGH THE ROUTINE — and the predecessor on the same question', () => {
  /** A legitimate two-row schedule: half fallen due 265 days ago, half far in the future. */
  let planId = '';
  let firstAmount = 0n;
  let secondAmount = 0n;
  let reading: readonly AgingRow[] = [];

  beforeAll(async () => {
    firstAmount = total / 2n;
    secondAmount = total - firstAmount;
    const future = (
      await ownerPool().query<{ d: string }>(`SELECT to_char($1::DATE + 400, 'YYYY-MM-DD') AS d`, [dueDate])
    ).rows[0]?.d ?? '';
    const r = await commitPlan(
      [
        { seq: 1, amount: firstAmount, due: dueDate },
        { seq: 2, amount: secondAmount, due: future },
      ],
    );
    expect(r.error, `the 265-day schedule must be LEGITIMATE and commit: ${r.error ?? ''}`).toBeNull();
    planId = r.planId;
    reading = await aging(asOf);
  }, 180_000);

  afterAll(async () => {
    if (planId !== '') await removePlan(planId);
  });

  it('THE DEFECT, from the predecessor itself: the WHOLE outstanding sat in the oldest band', () => {
    const oldest = predecessorReading.filter((r) => r.bucket_no === BUCKET_DAYS.length + 1);
    expect(predecessorReading.length, 'the predecessor returned nothing — then the defect reading is vacuous').toBeGreaterThan(0);
    expect(oldest.reduce((s, r) => s + BigInt(r.txn_minor), 0n)).toBe(total);
  });

  it('THE REPAIR, through the routine: only the FALLEN-DUE half is in the oldest band', () => {
    const byBucket = new Map(reading.map((r) => [r.bucket_no, BigInt(r.txn_minor)]));
    expect(byBucket.get(BUCKET_DAYS.length + 1)).toBe(firstAmount);
  });

  it('the NOT-YET-DUE half is in the not-yet-due band and in no overdue band', () => {
    const byBucket = new Map(reading.map((r) => [r.bucket_no, BigInt(r.txn_minor)]));
    expect(byBucket.get(1)).toBe(secondAmount);
    for (const b of [2, 3]) expect(byBucket.get(b) ?? 0n).toBe(0n);
  });

  it('CONSERVATION, through the routine: the buckets sum to the authoritative outstanding', async () => {
    const o = await ownerPool().query<{ out: string }>(
      `SELECT o.outstanding_txn_minor::text AS out FROM invoice_outstanding($1, ARRAY[$2::UUID]) o`,
      [w.shop.businessId, invoiceId],
    );
    const sum = reading.reduce((s, r) => s + BigInt(r.txn_minor), 0n);
    expect(sum).toBe(BigInt(o.rows[0]?.out ?? '-1'));
    expect(sum).toBe(total);
  });

  it('§D PR-6: daftar_app cannot execute the base allocation, so the base column is unreachable until it is granted', async () => {
    const app = new Pool({ connectionString: appDbUrl, max: 1 });
    try {
      let releaseError = '';
      try {
        await app.query(`SELECT supplier_ap_release(100::BIGINT, 100::BIGINT, 0::BIGINT, 50::BIGINT)`);
      } catch (e) {
        releaseError = (e as { code?: string }).code ?? String(e);
      }
      expect(releaseError, 'daftar_app must NOT hold EXECUTE on supplier_ap_release today — PR-6 is the request to grant it').toBe('42501');

      let agingError = '';
      try {
        await app.query(`SELECT * FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[])`, [w.shop.businessId, customerId, asOf, BUCKET_DAYS]);
      } catch (e) {
        agingError = (e as { code?: string }).code ?? String(e);
      }
      expect(agingError, 'and the INVOKER projection therefore refuses the application role on an invoice with a plan').toBe('42501');
    } finally {
      await app.end();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§F MODEL-TO-SQL EQUIVALENCE — the reference model and the routine answer alike', () => {
  /**
   * P4-AL-07 says the derived value is read through the PRODUCT'S OWN
   * function and that a second TypeScript copy would be a second truth. The
   * reference model lives under `test/` and is unreachable from product code
   * for exactly that reason — which makes it an ORACLE, and an oracle is only
   * worth having if it is measured against the thing it is an oracle for.
   *
   * Eighty-six cases judged the model. None of them judged the SQL. This
   * section asks the two the SAME question about the SAME rows, at four
   * horizons, and compares every column of every bucket — `base_minor`
   * included, which is the column the canonical cumulative release law
   * produces and the one a rounding defect would land in.
   */
  let planId = '';
  let row: OpenInvoiceRow | null = null;
  let plan: InstallmentPlan | null = null;
  let horizons: readonly string[] = [];

  beforeAll(async () => {
    // A LAWFUL FOUR-ROW SCHEDULE, one row per band at the middle horizon, so
    // the comparison is not a comparison of one bucket against itself.
    const dates = (
      await ownerPool().query<{ d0: string; d1: string; d2: string; d3: string; h1: string; h2: string; h3: string; h4: string }>(
        `SELECT to_char($1::DATE, 'YYYY-MM-DD') AS d0, to_char($1::DATE + 40, 'YYYY-MM-DD') AS d1,
                to_char($1::DATE + 80, 'YYYY-MM-DD') AS d2, to_char($1::DATE + 400, 'YYYY-MM-DD') AS d3,
                to_char($1::DATE + 10, 'YYYY-MM-DD') AS h1, to_char($1::DATE + 95, 'YYYY-MM-DD') AS h2,
                to_char($1::DATE + 200, 'YYYY-MM-DD') AS h3, to_char($1::DATE + 500, 'YYYY-MM-DD') AS h4`,
        [dueDate],
      )
    ).rows[0];
    const q = total / 4n;
    const amounts = [q, q, q, total - 3n * q];
    const dues = [dates?.d0 ?? '', dates?.d1 ?? '', dates?.d2 ?? '', dates?.d3 ?? ''];
    const r = await commitPlan(amounts.map((amount, i) => ({ seq: i + 1, amount, due: dues[i] as string })));
    expect(r.error, `the equivalence fixture must be a LAWFUL schedule: ${r.error ?? ''}`).toBeNull();
    planId = r.planId;

    // THE MODEL'S INPUT IS READ OUT OF THE DATABASE, never typed here: an
    // oracle fed a fixture's idea of the invoice proves nothing about the
    // invoice. The money comes from the product's own reader of record.
    const o = (
      await ownerPool().query<{ paid_txn: string; paid_base: string; out_txn: string; out_base: string; currency_code: string; due_date: string }>(
        `SELECT o.paid_txn_minor::text AS paid_txn, o.paid_base_minor::text AS paid_base,
                o.outstanding_txn_minor::text AS out_txn, o.outstanding_base_minor::text AS out_base,
                o.currency_code, to_char(o.due_date, 'YYYY-MM-DD') AS due_date
           FROM invoice_outstanding($1, ARRAY[$2::UUID]) o`,
        [w.shop.businessId, invoiceId],
      )
    ).rows[0];
    row = {
      invoiceId,
      currencyCode: o?.currency_code ?? '',
      dueDate: o?.due_date ?? null,
      paidTxnMinor: BigInt(o?.paid_txn ?? '0'),
      paidBaseMinor: BigInt(o?.paid_base ?? '0'),
      outstandingTxnMinor: BigInt(o?.out_txn ?? '0'),
      outstandingBaseMinor: BigInt(o?.out_base ?? '0'),
    };
    const sched = await ownerPool().query<{ seq_no: number; due_date: string; amount: string }>(
      `SELECT n.seq_no, to_char(n.due_date, 'YYYY-MM-DD') AS due_date, n.amount_txn_minor::text AS amount
         FROM installments n WHERE n.business_id = $1 AND n.plan_id = $2 ORDER BY n.due_date, n.seq_no`,
      [w.shop.businessId, planId],
    );
    const p = await ownerPool().query<{ down: string; down_due: string }>(
      `SELECT down_payment_minor::text AS down, to_char(down_payment_due_date, 'YYYY-MM-DD') AS down_due
         FROM installment_plans WHERE business_id = $1 AND id = $2`,
      [w.shop.businessId, planId],
    );
    plan = {
      invoiceId,
      status: 'active',
      downPaymentMinor: BigInt(p.rows[0]?.down ?? '0'),
      downPaymentDueDate: p.rows[0]?.down_due ?? '',
      installments: sched.rows.map((x) => ({ seqNo: x.seq_no, dueDate: x.due_date, amountTxnMinor: BigInt(x.amount) })),
    };
    horizons = [dates?.h1 ?? '', dates?.h2 ?? '', dates?.h3 ?? '', dates?.h4 ?? ''];
  }, 180_000);

  afterAll(async () => {
    if (planId !== '') await removePlan(planId);
  });

  it('NON-VACUITY: the fixture really spreads across more than one band at the middle horizon', async () => {
    expect(plan?.installments.length).toBe(4);
    expect(horizons.length).toBe(4);
    const mid = await aging(horizons[2] as string);
    expect(new Set(mid.map((x) => x.bucket_no)).size, 'one bucket only — the equivalence would compare a single band').toBeGreaterThan(1);
  });

  it('EVERY COLUMN OF EVERY BUCKET AGREES, at four horizons, base_minor included', async () => {
    for (const h of horizons) {
      const sql = (await aging(h)).map((x) => ({
        bucketNo: x.bucket_no,
        currencyCode: x.currency_code,
        txnMinor: BigInt(x.txn_minor),
        baseMinor: BigInt(x.base_minor),
        invoiceCount: x.invoice_count,
      }));
      const model = projectCustomerAging([row as OpenInvoiceRow], [plan as InstallmentPlan], h, BUCKET_DAYS).map((b) => ({
        bucketNo: b.bucketNo,
        currencyCode: b.currencyCode,
        txnMinor: b.txnMinor,
        baseMinor: b.baseMinor,
        invoiceCount: b.invoiceCount,
      }));
      expect(sql.length, `at ${h}: the routine returned no row, so the comparison would be empty === empty`).toBeGreaterThan(0);
      expect(model, `at ${h}: the reference model and the installed routine DISAGREE`).toEqual(sql);
      // CONSERVATION in both, at every horizon, against the authoritative figure.
      expect(sql.reduce((a, x) => a + x.txnMinor, 0n)).toBe(row?.outstandingTxnMinor);
      expect(sql.reduce((a, x) => a + x.baseMinor, 0n)).toBe(row?.outstandingBaseMinor);
    }
  });

  it('AND THE EQUIVALENCE CAN FAIL — the defect the slice exists to fix makes it disagree', async () => {
    // THE CANARY FOR THE ARM ABOVE. An equivalence that has never been seen to
    // break is a green light of unknown wiring: if the two sides were somehow
    // the same computation, or if either returned nothing, `toEqual` would be
    // satisfied by construction. So the model is re-run with the ONE knob that
    // reproduces the shipped defect — bucketing every schedule row by
    // `invoices.due_date` instead of its own date — and the comparison must
    // then FAIL at the horizon where the two differ.
    const h = horizons[2] as string;
    const sql = (await aging(h)).map((x) => [x.bucket_no, x.txn_minor, x.base_minor]);
    const defective = projectCustomerAging(
      [row as OpenInvoiceRow],
      [plan as InstallmentPlan],
      h,
      BUCKET_DAYS,
      { ...CORRECT_POLICY, bucketBy: 'invoice_due_date' },
    ).map((b) => [b.bucketNo, String(b.txnMinor), String(b.baseMinor)]);
    expect(defective, 'the shipped defect produces the SAME answer as the repair — then the arm above measures nothing').not.toEqual(sql);
    // and the defect's signature is exactly the one the brief describes: the
    // whole outstanding collapsed onto ONE band.
    expect(defective.length).toBe(1);
    expect(sql.length).toBeGreaterThan(1);
  });
});
