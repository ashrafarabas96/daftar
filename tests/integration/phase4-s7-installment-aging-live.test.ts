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

const SPEC = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'), 'utf8');

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
/** The absence guard's own definition, captured after the spec applies, for §G's negative control. */
let guardDefinition = '';
/** The business's tenant, read from the row rather than assumed. */
let tenantId = '';
/** Whether the reader-of-record restore actually landed, and what came back. */
let restoreError: string | null = null;
let restoredDefinition = '';

/** The one authoritative total, read back from the stored invoice row. */
let total = 0n;

async function aging(as_of: string): Promise<readonly AgingRow[]> {
  const r = await ownerPool().query<AgingRow>(`SELECT * FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[]) ORDER BY bucket_no`, [
    w.shop.businessId,
    customerId,
    as_of,
    BUCKET_DAYS,
  ]);
  return r.rows;
}

/**
 * Write a plan and its schedule in ONE transaction and try to commit it.
 * Returns the error message, or `null` when it committed — and records
 * whether every statement was ACCEPTED, which is what makes the refusal a
 * deferred one.
 */
async function commitPlan(
  rows: readonly { seq: number; amount: bigint; due: string }[],
  o: { downMinor?: bigint; planId?: string } = {},
): Promise<{ error: string | null; statementsAccepted: boolean; planId: string }> {
  const planId = o.planId ?? randomUUID();
  const client = await ownerPool().connect();
  let statementsAccepted = false;
  try {
    await client.query('BEGIN');
    // THE WRITER'S OBLIGATION, STATED BY THE SPECIFICATION AND NOT BY THIS
    // SUITE. `installment_plan_fact_sync()` writes the invoice's
    // `has_active_installment_plan` as `daftar_accounting_internal`, and
    // `invoices`' own `tenant_membership` / `business_isolation_update`
    // policies admit that UPDATE only when `app.tenant_id` and
    // `app.business_id` match the invoice's. Specification section 3a says
    // so in terms — «the command that creates, completes or cancels a plan
    // must run with app.tenant_id and app.business_id set to the invoice's
    // own values … a writer that does not gets
    // installment.plan_fact_unwritable and no row». This helper did not set
    // them, so after round 9 every plan write in this file was refused by
    // that rule instead of by the law under test. Transaction-local, the way
    // `0006` requires: nothing leaks into the next test.
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [w.shop.tenantId]);
    await client.query(`SELECT set_config('app.business_id', $1, true)`, [w.shop.businessId]);
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
    // THE WRITER'S OBLIGATION, STATED BY THE SPECIFICATION AND NOT BY THIS
    // SUITE. `installment_plan_fact_sync()` writes the invoice's
    // `has_active_installment_plan` as `daftar_accounting_internal`, and
    // `invoices`' own `tenant_membership` / `business_isolation_update`
    // policies admit that UPDATE only when `app.tenant_id` and
    // `app.business_id` match the invoice's. Specification section 3a says
    // so in terms — «the command that creates, completes or cancels a plan
    // must run with app.tenant_id and app.business_id set to the invoice's
    // own values … a writer that does not gets
    // installment.plan_fact_unwritable and no row». This helper did not set
    // them, so after round 9 every plan write in this file was refused by
    // that rule instead of by the law under test. Transaction-local, the way
    // `0006` requires: nothing leaks into the next test.
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [w.shop.tenantId]);
    await client.query(`SELECT set_config('app.business_id', $1, true)`, [w.shop.businessId]);
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
  liveDefinition =
    (await ownerPool().query<{ def: string }>(`SELECT pg_get_functiondef('customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure) AS def`)).rows[0]?.def ??
    '';
  predecessorReading = await aging(asOf);

  try {
    await ownerPool().query(SPEC);
  } catch (e) {
    specError = e instanceof Error ? `${(e as { code?: string }).code ?? '?'}: ${e.message}` : String(e);
  }
  if (specError === null) {
    guardDefinition =
      (await ownerPool().query<{ def: string }>(`SELECT pg_get_functiondef('installment_plan_fact_assert(bigint,bigint,bigint)'::regprocedure) AS def`)).rows[0]
        ?.def ?? '';
  }
  tenantId =
    (await ownerPool().query<{ t: string }>(`SELECT tenant_id::text AS t FROM invoices WHERE business_id = $1 AND id = $2`, [w.shop.businessId, invoiceId]))
      .rows[0]?.t ?? '';
}, 900_000);

afterAll(async () => {
  const p = ownerPool();
  await p.query('DROP TABLE IF EXISTS installments').catch(() => undefined);
  await p.query('DROP TABLE IF EXISTS installment_plans').catch(() => undefined);
  // ROUND 7 F1 WIDENS WHAT THIS TEARDOWN OWES, AND THAT IS A SEAM, NOT A
  // FIX. `TL-P4-COORD-R38` direction (d) puts a COLUMN and a DEFERRED
  // CONSTRAINT TRIGGER on `public.invoices` — a PREDECESSOR relation this
  // suite does not own. So an interrupted run of this file now leaves
  // something behind on `invoices` and not only in two relations of its own,
  // which makes round-7 F5's «drops first, restores second» residue worse
  // rather than better. F5 is a LATER round and is deliberately not touched
  // here; this comment is the disclosure, and the drops below are the
  // teardown doing what it can.
  await p.query('DROP TRIGGER IF EXISTS invoices_installment_fact_agrees ON invoices').catch(() => undefined);
  // AND `TL-P4-COORD-R43` F1-d PUTS A SECOND ONE THERE, for the same reason:
  // obligation (a)'s right-hand side is `invoices.total_txn_minor`, so the
  // relation that carries it has to be one of the verifier's events. Without
  // this drop an interrupted run leaves the trigger behind and the NEXT run of
  // this file fails to apply the specification at all, with
  // `42710 trigger "invoices_installment_schedule_complete" ... already
  // exists` — measured, this round, on exactly that sequence.
  await p.query('DROP TRIGGER IF EXISTS invoices_installment_schedule_complete ON invoices').catch(() => undefined);
  await p.query('ALTER TABLE invoices DROP COLUMN IF EXISTS has_active_installment_plan').catch(() => undefined);
  await p.query('DROP FUNCTION IF EXISTS installment_schedule_verify()').catch(() => undefined);
  await p.query('DROP FUNCTION IF EXISTS installment_plan_fact_sync()').catch(() => undefined);
  await p.query('DROP FUNCTION IF EXISTS installment_plan_fact_verify()').catch(() => undefined);
  await p.query('DROP FUNCTION IF EXISTS installment_plan_fact_assert(bigint,bigint,bigint)').catch(() => undefined);
  // THE RESTORE IS ASSERTED, NOT HOPED FOR (challenger M8). A `LANGUAGE sql`
  // body supplied as a string literal records NO `pg_depend` edge on the
  // relations it names, so the DROPs above succeed and leave
  // `customer_ar_aging` pointing at relations that no longer exist until this
  // statement lands. The first version swallowed this statement's failure with
  // `.catch(() => undefined)` and asserted nothing, so the claim that the
  // suite "leaves the database as it found it" was unmeasured by the suite
  // itself — and had the restore failed, every later aging read in the cluster
  // would error with nothing saying why.
  expect(liveDefinition, 'the predecessor definition was never captured, so there is nothing to restore').not.toBe('');
  restoreError = await p
    .query(liveDefinition)
    .then(() => null)
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  restoredDefinition = await p
    .query<{ def: string }>(`SELECT pg_get_functiondef('customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure) AS def`)
    .then((r) => r.rows[0]?.def ?? '')
    .catch(() => '');
  // An afterAll that fails reds the file, which is the only way a teardown
  // claim can be evidence rather than a comment.
  expect(restoreError, `THE READER OF RECORD WAS NOT RESTORED: ${restoreError ?? ''}`).toBeNull();
  expect(restoredDefinition, 'the installed body is not the predecessor the suite replaced').toBe(liveDefinition);
  const leftovers = await p.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('installment_plans', 'installments')`,
  );
  expect(leftovers.rows[0]?.n, 'the suite left its own relations behind in the shared database').toBe('0');
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
    // WHICH (a) ARM FIRED (challenger M7). Obligation (a) raises from TWO
    // places and both emit `installment.schedule_incomplete` and `(a)`: the
    // sum comparison, and «the plan names no invoice of this business». A
    // verifier that could not see `public.invoices` at all would take the
    // NOT-FOUND arm on every transaction and satisfy B1, B2 and B3
    // identically — the very "refuses everything" state §C is offered
    // against. §C does rule it out, but it lives in a different block, so
    // each refusal arm names its own arm and is self-sufficient.
    expect(r.error ?? '', 'the NOT-FOUND arm fired, not the sum comparison').toContain('sums to');
  });

  it('B2 a schedule summing ABOVE the invoice total is REFUSED by the same comparison', async () => {
    const r = await commitPlan([{ seq: 1, amount: total + 1n, due: dueDate }]);
    expect(r.statementsAccepted).toBe(true);
    expect(r.error ?? '').toContain('installment.schedule_incomplete');
    expect(r.error ?? '').toContain('(a)');
    // WHICH (a) ARM FIRED (challenger M7). Obligation (a) raises from TWO
    // places and both emit `installment.schedule_incomplete` and `(a)`: the
    // sum comparison, and «the plan names no invoice of this business». A
    // verifier that could not see `public.invoices` at all would take the
    // NOT-FOUND arm on every transaction and satisfy B1, B2 and B3
    // identically — the very "refuses everything" state §C is offered
    // against. §C does rule it out, but it lives in a different block, so
    // each refusal arm names its own arm and is self-sufficient.
    expect(r.error ?? '', 'the NOT-FOUND arm fired, not the sum comparison').toContain('sums to');
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
      // THE WRITER'S OBLIGATION, STATED BY THE SPECIFICATION AND NOT BY THIS
      // SUITE. `installment_plan_fact_sync()` writes the invoice's
      // `has_active_installment_plan` as `daftar_accounting_internal`, and
      // `invoices`' own `tenant_membership` / `business_isolation_update`
      // policies admit that UPDATE only when `app.tenant_id` and
      // `app.business_id` match the invoice's. Specification section 3a says
      // so in terms — «the command that creates, completes or cancels a plan
      // must run with app.tenant_id and app.business_id set to the invoice's
      // own values … a writer that does not gets
      // installment.plan_fact_unwritable and no row». This helper did not set
      // them, so after round 9 every plan write in this file was refused by
      // that rule instead of by the law under test. Transaction-local, the way
      // `0006` requires: nothing leaks into the next test.
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [w.shop.tenantId]);
      await client.query(`SELECT set_config('app.business_id', $1, true)`, [w.shop.businessId]);
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
    // ...and it is the SUM arm, not the invoice-not-found arm (M7).
    expect(error ?? '', 'the NOT-FOUND arm fired, not the sum comparison').toContain('sums to');

    // and the complete plan survives, because the refusal rolled the DELETE back
    const after = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM installments WHERE business_id = $1 AND plan_id = $2`, [
      w.shop.businessId,
      planId,
    ]);
    expect(after.rows[0]?.n).toBe('2');
    // AND THE EXEMPTION IS EVALUATED TOO: removing the plan WITH its schedule
    // in one transaction is accepted, which is the `IF NOT FOUND` arm. Without
    // this, obligation (a) would make a cancelled plan undeletable.
    expect(await removePlan(planId), 'a plan and its whole schedule can be removed in one transaction').toBeNull();
    const gone = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM installment_plans WHERE business_id = $1 AND id = $2`, [
      w.shop.businessId,
      planId,
    ]);
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

  it('B5 the tenant divergence is REFUSED IMMEDIATELY now, by the structural edge F2 found had been left off', async () => {
    // This is the OTHER asymmetry, and it was mine: every policy here is keyed
    // on `tenant_id`, so a plan with a foreign tenant was invisible to the
    // very caller who could see the invoice.
    //
    // IT WAS A DEFERRED CHECK, obligation (e), and its stated reason was that
    // no composite key existed for a foreign key to name. `TL-P4-COORD-R43`
    // F2 measured that reason FALSE — `0016:10` is
    // `businesses (tenant_id, id) UNIQUE` and `0075:318` already names it from
    // `invoices` — so the edge is carried now and the refusal is the FOREIGN
    // KEY, at the statement, not a verifier at COMMIT. This arm therefore
    // asserts the EARLIER refusal, which is a strengthening: the state is
    // unreachable rather than caught.
    const foreign = randomUUID();
    const client = await ownerPool().connect();
    let error: string | null = null;
    let accepted = false;
    try {
      await client.query('BEGIN');
      // THE WRITER'S OBLIGATION, STATED BY THE SPECIFICATION AND NOT BY THIS
      // SUITE. `installment_plan_fact_sync()` writes the invoice's
      // `has_active_installment_plan` as `daftar_accounting_internal`, and
      // `invoices`' own `tenant_membership` / `business_isolation_update`
      // policies admit that UPDATE only when `app.tenant_id` and
      // `app.business_id` match the invoice's. Specification section 3a says
      // so in terms — «the command that creates, completes or cancels a plan
      // must run with app.tenant_id and app.business_id set to the invoice's
      // own values … a writer that does not gets
      // installment.plan_fact_unwritable and no row». This helper did not set
      // them, so after round 9 every plan write in this file was refused by
      // that rule instead of by the law under test. Transaction-local, the way
      // `0006` requires: nothing leaks into the next test.
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [w.shop.tenantId]);
      await client.query(`SELECT set_config('app.business_id', $1, true)`, [w.shop.businessId]);
      const pid = randomUUID();
      await client.query(
        `INSERT INTO installment_plans (tenant_id, business_id, id, invoice_id, customer_id, status,
                                        down_payment_minor, down_payment_due_date, created_by, business_transaction_id)
         VALUES ($1, $2, $3, $4, $5, 'active', 0, $6::DATE, $7, $8)`,
        [foreign, w.shop.businessId, pid, invoiceId, customerId, dueDate, w.shop.userId, randomUUID()],
      );
      await client.query(
        `INSERT INTO installments (tenant_id, business_id, id, plan_id, seq_no, due_date, amount_txn_minor)
         VALUES ($1, $2, $3, $4, 1, $5::DATE, $6)`,
        [foreign, w.shop.businessId, randomUUID(), pid, dueDate, String(total)],
      );
      accepted = true;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      error = e instanceof Error ? e.message : String(e);
    } finally {
      client.release();
    }
    expect(accepted, 'the refusal came at COMMIT, so the structural edge is not the thing that refused').toBe(false);
    expect(error ?? '').toContain('installment_plans_tenant_fk');
    expect(error ?? '').toContain('foreign key constraint');
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
    const future = (await ownerPool().query<{ d: string }>(`SELECT to_char($1::DATE + 400, 'YYYY-MM-DD') AS d`, [dueDate])).rows[0]?.d ?? '';
    const r = await commitPlan([
      { seq: 1, amount: firstAmount, due: dueDate },
      { seq: 2, amount: secondAmount, due: future },
    ]);
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

  it("EVERY BUCKET CARRIES THE INVOICE'S OWN CURRENCY, and the routine relabels nothing", async () => {
    // FOUND BY LINT, AND IT WAS A MISSING ASSERTION RATHER THAN A DEAD
    // VARIABLE. `currencyCode` was read off the invoice in `beforeAll` and
    // never used — in a suite about a CURRENCY-SENSITIVE aging read whose
    // return shape carries `currency_code` in every row and whose GROUP BY is
    // `(bucket_no, currency_code)`. A `_` prefix would have preserved the gap
    // exactly. The law it was missing:
    expect(currencyCode, 'the invoice carries no currency, so the law below has no subject').not.toBe('');
    expect(reading.length, 'the routine returned nothing to check the currency of').toBeGreaterThan(0);
    for (const r of reading) {
      expect(r.currency_code, `bucket ${String(r.bucket_no)} is labelled with a currency the invoice does not carry`).toBe(currencyCode);
    }
    // ...and the GROUPING really is per currency, so one invoice yields one
    // currency label per band and never two.
    const perBucket = new Map<number, Set<string>>();
    for (const r of reading) perBucket.set(r.bucket_no, (perBucket.get(r.bucket_no) ?? new Set()).add(r.currency_code));
    for (const [band, codes] of perBucket) expect(codes.size, `band ${String(band)} came back under two currencies`).toBe(1);
    // ...and the predecessor labelled it the same way, so the repair did not
    // change the currency column while changing the band column.
    for (const r of predecessorReading) expect(r.currency_code).toBe(currencyCode);
  });

  it('CONSERVATION, through the routine: the buckets sum to the authoritative outstanding', async () => {
    const o = await ownerPool().query<{ out: string }>(`SELECT o.outstanding_txn_minor::text AS out FROM invoice_outstanding($1, ARRAY[$2::UUID]) o`, [
      w.shop.businessId,
      invoiceId,
    ]);
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
describe('§D2 PR-6 (round 6 F3) — the outage is TOTAL, which is the arm M10 never had', () => {
  // THIS IS ITS OWN `describe` ON PURPOSE. §E's `afterAll` is what removes the
  // plan, and an arm about the PLAN-LESS read placed among §E's cases would
  // have run WITH the plan still attached and measured the planned case
  // twice — the same shape as the finding it exists to correct.
  it('a customer with NO plan, and a customer with NO invoice, are refused all the same', async () => {
    // MY OWN M10 CLAIM WAS FALSE AS STATED. It said the missing EXECUTE made
    // the base column unreachable "on an invoice under a plan" — a partial,
    // data-dependent outage that a merchant with no installment plans would
    // never meet. The arm above measures only the PLANNED case, so nothing
    // here exercised the plan-less read and the claim was belief.
    //
    // The mechanism refutes it: `customer_ar_aging` is `LANGUAGE sql`, and
    // EXECUTE on a function NAMED IN A `LANGUAGE sql` BODY is checked when the
    // body is PLANNED, not per row. So the refusal cannot depend on whether
    // any row reaches the call. The outage is TOTAL: every call by
    // `daftar_app`, for every customer, with or without a plan, with or
    // without an invoice.
    //
    // Measured here at the two extremes the planned arm cannot reach: a
    // customer with no plan, and a customer with no invoice at all — where the
    // projection's own answer is zero rows and `supplier_ap_release` would be
    // evaluated zero times.
    const app = new Pool({ connectionString: appDbUrl, max: 1 });
    try {
      // (i) A REAL CUSTOMER WITH A REAL OPEN INVOICE AND NO PLAN. §E's plan is
      //     torn down in its own `afterAll`, so this reads the same customer
      //     with nothing of this slice attached — and the owner's reading
      //     proves the question is answerable, or the refusal below would be
      //     indistinguishable from "nothing to answer".
      const noPlan = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM installment_plans WHERE business_id = $1 AND status = 'active'`, [
        w.shop.businessId,
      ]);
      expect(noPlan.rows[0]?.n, 'a plan is still attached, so this arm is not the plan-less case it claims to be').toBe('0');
      const ownerAnswer = await aging(asOf);
      expect(ownerAnswer.length, 'the owner cannot answer the plan-less question either, so the refusal below measures nothing').toBeGreaterThan(0);

      let planlessError = '';
      try {
        await app.query(`SELECT * FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[])`, [w.shop.businessId, customerId, asOf, BUCKET_DAYS]);
      } catch (e) {
        planlessError = (e as { code?: string }).code ?? String(e);
      }
      expect(planlessError, 'PLAN-LESS AND STILL REFUSED: the outage is total, so M10 was wrong to call it data-dependent').toBe('42501');

      // (ii) A CUSTOMER WITH NO INVOICE AT ALL. The owner's reading of this
      //      same question is ZERO ROWS, so there is no row for the
      //      unreachable call to be evaluated on — and it is refused anyway,
      //      which is the plan-time check itself and not an inference about it.
      const emptyCustomer = await newCustomer(w);
      const emptyOwner = await ownerPool().query(`SELECT * FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[])`, [
        w.shop.businessId,
        emptyCustomer,
        asOf,
        BUCKET_DAYS,
      ]);
      expect(emptyOwner.rowCount, 'the empty customer is not empty, so the zero-row claim below is false').toBe(0);

      let emptyError = '';
      let emptyMessage = '';
      try {
        await app.query(`SELECT * FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[])`, [w.shop.businessId, emptyCustomer, asOf, BUCKET_DAYS]);
      } catch (e) {
        emptyError = (e as { code?: string }).code ?? String(e);
        emptyMessage = e instanceof Error ? e.message : String(e);
      }
      expect(emptyError, 'ZERO ROWS AND STILL REFUSED: EXECUTE is checked at PLAN time, which is why the outage cannot be partial').toBe('42501');
      // ...and it is THE PRIVILEGE PR-6 NAMES that was refused. A `42501` from
      // some other object would have satisfied the code test while measuring a
      // different outage, which is how a law ends up about a coincidence.
      expect(emptyMessage, `the 42501 does not name the function PR-6 asks for: ${emptyMessage}`).toContain('supplier_ap_release');

      // ...and NON-VACUITY of the whole arm: `daftar_app` really can call the
      // PREDECESSOR'S shape of this question, so `42501` above is about the
      // one missing EXECUTE and not about the role being unable to read
      // receivables at all.
      const predecessorCall = await app.query(`SELECT * FROM customer_ar_outstanding($1, $2)`, [w.shop.businessId, emptyCustomer]);
      expect(predecessorCall.rowCount, 'daftar_app cannot reach the receivable readers at all, so 42501 above is not evidence about PR-6').toBe(0);
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
    const defective = projectCustomerAging([row as OpenInvoiceRow], [plan as InstallmentPlan], h, BUCKET_DAYS, {
      ...CORRECT_POLICY,
      bucketBy: 'invoice_due_date',
    }).map((b) => [b.bucketNo, String(b.txnMinor), String(b.baseMinor)]);
    expect(defective, 'the shipped defect produces the SAME answer as the repair — then the arm above measures nothing').not.toEqual(sql);
    // and the defect's signature is exactly the one the brief describes: the
    // whole outstanding collapsed onto ONE band.
    expect(defective.length).toBe(1);
    expect(sql.length).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("§G ROW SECURITY, MEASURED AS A NON-SUPERUSER — and C1's negative control", () => {
  /**
   * CHALLENGER H3. Every database read in the 109-case corpus was a
   * SUPERUSER's: `embedded-cluster.ts:21` sets `PG_USER = 'postgres'`, and a
   * superuser BYPASSES row level security entirely — `FORCE ROW LEVEL
   * SECURITY` removes the table OWNER's exemption, not a superuser's. So two
   * new relations carrying `tenant_id` and `business_id` under FORCE RLS
   * shipped with their isolation asserted by nothing, and **the one route that
   * would have exposed C1 was the one route the evidence could not see.**
   *
   * `SET LOCAL ROLE` is what makes the measurement possible: RLS is decided by
   * the EFFECTIVE user, so after a role switch to a `NOSUPERUSER NOBYPASSRLS`
   * principal the policies really apply. §20.7's claim that the suite "writes
   * its plan rows as the migration-level principal" was FALSE — that principal
   * is `daftar_migrator` (NOSUPERUSER NOBYPASSRLS, `bootstrap.sql:187`) and the
   * writes are `postgres`. The record is corrected in the design document.
   */
  let planId = '';

  /** Read `sql` as `role`, with the given transaction-local app context. */
  async function asRole<T extends Record<string, unknown>>(
    role: string,
    ctx: { tenant?: string; business?: string },
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: readonly T[]; error: string | null; code: string | null }> {
    const client = await ownerPool().connect();
    try {
      await client.query('BEGIN');
      // Transaction-local, the way 0006 requires: no global SET on a pooled
      // connection, so nothing leaks into the next test.
      if (ctx.tenant !== undefined) await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenant]);
      if (ctx.business !== undefined) await client.query(`SELECT set_config('app.business_id', $1, true)`, [ctx.business]);
      await client.query(`SET LOCAL ROLE ${role}`);
      const r = await client.query<T>(sql, [...params]);
      await client.query('ROLLBACK');
      return { rows: r.rows, error: null, code: null };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      return { rows: [], error: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code ?? null };
    } finally {
      client.release();
    }
  }

  const COUNT_PLANS = `SELECT count(*)::text AS n FROM installment_plans`;
  const COUNT_SCHED = `SELECT count(*)::text AS n FROM installments`;
  const COUNT_INVOICE = `SELECT count(*)::text AS n FROM invoices WHERE id = $1`;

  beforeAll(async () => {
    const half = total / 2n;
    // TWO DIFFERENT DATES, and that is load-bearing for the negative control:
    // a schedule whose rows share one date lands in ONE bucket, so "the
    // unguarded arm collapses the invoice onto one band" would be true of the
    // healthy read as well and the control would measure nothing. The first
    // version of this fixture dated both rows alike and the control's own
    // closing assertion caught it.
    const future = (await ownerPool().query<{ d: string }>(`SELECT to_char($1::DATE + 400, 'YYYY-MM-DD') AS d`, [dueDate])).rows[0]?.d ?? '';
    const r = await commitPlan([
      { seq: 1, amount: half, due: dueDate },
      { seq: 2, amount: total - half, due: future },
    ]);
    expect(r.error, `§G needs a real committed plan: ${r.error ?? ''}`).toBeNull();
    planId = r.planId;
  }, 180_000);

  afterAll(async () => {
    if (planId !== '') await removePlan(planId);
  });

  it('NON-VACUITY: the superuser sees the plan, and the role switch really changes the effective user', async () => {
    const sup = await ownerPool().query<{ n: string }>(COUNT_PLANS);
    expect(sup.rows[0]?.n, 'there is no plan row, so every count below would be 0 either way').toBe('1');
    const who = await asRole<{ cu: string; su: boolean }>(
      'daftar_app',
      {},
      `SELECT current_user::text AS cu, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`,
    );
    expect(who.rows[0]?.cu).toBe('daftar_app');
    expect(who.rows[0]?.su, 'the effective user is still a superuser, so RLS would be bypassed and §G measures nothing').toBe(false);
    expect(tenantId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('DEFAULT DENY: `daftar_app` with no app context sees NEITHER the plan nor its invoice', async () => {
    // The point is the CONJUNCTION. Hiding the plan alone is what C1 is about;
    // hiding both means the projection returns NO ROW rather than a wrong row.
    const plans = await asRole<{ n: string }>('daftar_app', {}, COUNT_PLANS);
    const sched = await asRole<{ n: string }>('daftar_app', {}, COUNT_SCHED);
    const inv = await asRole<{ n: string }>('daftar_app', {}, COUNT_INVOICE, [invoiceId]);
    expect(plans.rows[0]?.n).toBe('0');
    expect(sched.rows[0]?.n).toBe('0');
    expect(inv.rows[0]?.n, 'the invoice is visible while its plan is not — that is exactly C1').toBe('0');
  });

  it('THE RUNTIME PATH: `daftar_app` with its own tenant and business sees the plan AND the schedule', async () => {
    const plans = await asRole<{ n: string }>('daftar_app', { tenant: tenantId, business: w.shop.businessId }, COUNT_PLANS);
    const sched = await asRole<{ n: string }>('daftar_app', { tenant: tenantId, business: w.shop.businessId }, COUNT_SCHED);
    expect(plans.rows[0]?.n, 'the ten isolation policies deny the legitimate caller too').toBe('1');
    expect(sched.rows[0]?.n).toBe('2');
  });

  it('CROSS-BUSINESS and CROSS-TENANT isolation: a foreign context sees nothing', async () => {
    const otherBusiness = randomUUID();
    const otherTenant = randomUUID();
    const a = await asRole<{ n: string }>('daftar_app', { tenant: tenantId, business: otherBusiness }, COUNT_PLANS);
    const b = await asRole<{ n: string }>('daftar_app', { tenant: otherTenant, business: w.shop.businessId }, COUNT_PLANS);
    expect(a.rows[0]?.n, 'the restrictive business policy does not isolate').toBe('0');
    expect(b.rows[0]?.n, 'the permissive tenant policy does not isolate').toBe('0');
  });

  it('C1.c THE ASYMMETRY IS CLOSED: `daftar_inventory_internal` sees the plan exactly as it sees the invoice', async () => {
    // BEFORE the repair this role saw the INVOICE unconditionally
    // (`0075:455-456`) and the PLAN not at all, because §2a shipped
    // `c_source` minus `inventory_internal_read`. That is the asymmetry, and
    // it is the whole mechanism of C1: equal visibility is the property, and
    // it is measured here rather than argued.
    const inv = await asRole<{ n: string }>('daftar_inventory_internal', {}, COUNT_INVOICE, [invoiceId]);
    const plans = await asRole<{ n: string }>('daftar_inventory_internal', {}, COUNT_PLANS);
    const sched = await asRole<{ n: string }>('daftar_inventory_internal', {}, COUNT_SCHED);
    expect(inv.rows[0]?.n, 'the predecessor policy no longer gives this role the invoice').toBe('1');
    expect(plans.rows[0]?.n, 'the invoice is visible and its plan is not — the C1 asymmetry is back').toBe('1');
    expect(sched.rows[0]?.n).toBe('2');
  });

  it('C1.a THE NEGATIVE CONTROL (inventory_internal_read): the arm REFUSES BY NAME, and the column alone would have been SILENT', async () => {
    // The estate's own idiom: remove exactly one invariant and show what then
    // happens. Here the invariant is `inventory_internal_read ON
    // installment_plans`, and removing it recreates C1's asymmetry exactly —
    // the invoice visible, the plan not.
    //
    // ROUND 7 F1 CHANGED WHAT THE THIRD STEP MEASURES, AND THE CHANGE IS THE
    // POINT. Before the repair, neutralising the guard made this read serve
    // THE WHOLE OUTSTANDING AT THE SINGLE INVOICE DUE DATE — a plausible wrong
    // number. Arm (c) is now keyed on the INVOICE's own
    // `has_active_installment_plan`, so with the refusal neutralised the
    // invoice is EXCLUDED from arm (c) instead and contributes NOTHING: the
    // wrong number is gone by construction and what is left is a SILENT
    // OMISSION. That is quieter and still wrong, which is exactly why
    // `installment_plan_fact_assert` exists. Both states are measured.
    expect(guardDefinition, 'the refusal definition was never captured, so it cannot be neutralised and restored').not.toBe('');
    const p = ownerPool();
    const AGING = `SELECT bucket_no, txn_minor::text AS txn_minor FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[]) ORDER BY bucket_no`;
    await p.query(`DROP POLICY inventory_internal_read ON installment_plans`);
    try {
      // 1. THE ASYMMETRY IS BACK — measured, not assumed.
      const plans = await asRole<{ n: string }>('daftar_inventory_internal', {}, COUNT_PLANS);
      const inv = await asRole<{ n: string }>('daftar_inventory_internal', {}, COUNT_INVOICE, [invoiceId]);
      expect(inv.rows[0]?.n).toBe('1');
      expect(plans.rows[0]?.n, 'dropping the policy did not actually hide the plan, so this control measures nothing').toBe('0');

      // 2. AND THE READ FAILS CLOSED, BY NAME.
      const guarded = await asRole<{ bucket_no: number; txn_minor: string }>('daftar_inventory_internal', {}, AGING, [
        w.shop.businessId,
        customerId,
        asOf,
        BUCKET_DAYS,
      ]);
      expect(guarded.error ?? '', 'the invisible plan did not raise — the arm is open again').toContain('installment.plan_fact_unreadable');
      expect(guarded.rows.length, 'and it returned a row as well as raising').toBe(0);

      // 3. AND WITH THE REFUSAL NEUTRALISED IT IS AN OMISSION AND NOT A WRONG
      //    NUMBER. The column has already removed the pre-S7 answer; this is
      //    what the three counts are for.
      // THE PARAMETER NAMES ARE PART OF THE SIGNATURE TO `CREATE OR REPLACE`:
      // PostgreSQL refuses `cannot change name of input parameter
      // "p_unreadable_plan"`, and this stub omitted them. It was never
      // reached until this round, because every plan write in this file was
      // being refused upstream.
      await p.query(`CREATE OR REPLACE FUNCTION installment_plan_fact_assert(p_unreadable_plan BIGINT, p_unflagged_plan BIGINT, p_unreadable_schedule BIGINT)
                     RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS 'SELECT true'`);
      try {
        const open = await asRole<{ bucket_no: number; txn_minor: string }>('daftar_inventory_internal', {}, AGING, [
          w.shop.businessId,
          customerId,
          asOf,
          BUCKET_DAYS,
        ]);
        expect(open.error, `the unguarded read failed for an unrelated reason: ${open.error ?? ''}`).toBeNull();
        expect(open.rows.length, 'the unguarded arm served a number for an invoice whose plan it cannot see').toBe(0);
      } finally {
        await p.query(`DROP FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT)`);
        await p.query(guardDefinition);
        await p.query(`ALTER FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) OWNER TO daftar_accounting_internal`);
        await p.query(`REVOKE ALL ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) FROM PUBLIC`);
        await p.query(`GRANT EXECUTE ON FUNCTION installment_plan_fact_assert(BIGINT, BIGINT, BIGINT) TO daftar_app, daftar_inventory_internal`);
      }
    } finally {
      await p.query(`CREATE POLICY inventory_internal_read ON installment_plans
                       FOR SELECT TO daftar_inventory_internal USING (true)`);
    }
    // AND THE INVARIANT IS BACK: the control restored what it removed.
    const back = await asRole<{ n: string }>('daftar_inventory_internal', {}, COUNT_PLANS);
    expect(back.rows[0]?.n, 'the negative control did not restore the policy it removed').toBe('1');
    const healthy = await asRole<{ bucket_no: number; txn_minor: string }>('daftar_inventory_internal', {}, AGING, [
      w.shop.businessId,
      customerId,
      asOf,
      BUCKET_DAYS,
    ]);
    expect(healthy.error, `the restored read does not work: ${healthy.error ?? ''}`).toBeNull();
    expect(healthy.rows.length, 'the restored read did not split the invoice across bands').toBeGreaterThan(1);
  });

  it('ROUND 7 F1 THE READ NO LONGER DEPENDS ON THE WHOLE POLICY SET — one dropped policy that hides NOTHING is no longer a refusal', async () => {
    // ROUND 6's F2 arm asserted that dropping `accounting_validator ON
    // installment_plans` ALONE made this read refuse. That was true of the
    // retired guard, which compared the declared policy NAME SET from
    // `pg_policy` — and it is DELIBERATELY NO LONGER TRUE. The read does not
    // consult the catalogue, so a policy whose absence hides no row from THIS
    // caller is not the read's business: `daftar_inventory_internal` still
    // sees every plan through `inventory_internal_read`.
    //
    // THAT IS THE TRADE `TL-P4-COORD-R38` MAKES, AND IT IS STATED RATHER THAN
    // DISCOVERED: the whole-policy-set assertion moves to APPLY TIME, in §2b's
    // `DO $end$` block, where it reads the live catalogue once and cannot be
    // satisfied by a substring; at READ time the only thing that refuses is a
    // DISAGREEMENT BETWEEN TWO READINGS OF DATA. A read that refused on a
    // policy change that hid nothing would be refusing on a proxy, which is
    // the whole class of defect this direction retires.
    const p = ownerPool();
    const AGING = `SELECT bucket_no, txn_minor::text AS txn_minor FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[]) ORDER BY bucket_no`;
    const args = [w.shop.businessId, customerId, asOf, BUCKET_DAYS];
    await p.query(`DROP POLICY accounting_validator ON installment_plans`);
    try {
      // ONE fault that hides nothing from this caller: the read must ANSWER,
      // and answer CORRECTLY.
      const oneFault = await asRole<{ bucket_no: number }>('daftar_inventory_internal', {}, AGING, args);
      expect(oneFault.error, `a policy change that hides nothing made the read refuse: ${oneFault.error ?? ''}`).toBeNull();
      expect(oneFault.rows.length, 'and the answer is still the schedule, across bands').toBeGreaterThan(1);

      // TWO faults — now the caller really is blind, and the read REFUSES.
      await p.query(`DROP POLICY inventory_internal_read ON installment_plans`);
      try {
        const plans = await asRole<{ n: string }>('daftar_inventory_internal', {}, COUNT_PLANS);
        const inv = await asRole<{ n: string }>('daftar_inventory_internal', {}, COUNT_INVOICE, [invoiceId]);
        expect(inv.rows[0]?.n, 'the asymmetry is not actually set up, so this measures nothing').toBe('1');
        expect(plans.rows[0]?.n).toBe('0');
        const twoFaults = await asRole<{ bucket_no: number; txn_minor: string }>('daftar_inventory_internal', {}, AGING, args);
        expect(twoFaults.error ?? '', "the challenger's two-fault case still answers").toContain('installment.plan_fact_unreadable');
        expect(twoFaults.rows.length, 'and it returned a row as well as raising').toBe(0);
      } finally {
        await p.query(`CREATE POLICY inventory_internal_read ON installment_plans
                         FOR SELECT TO daftar_inventory_internal USING (true)`);
      }
    } finally {
      await p.query(`CREATE POLICY accounting_validator ON installment_plans
                       FOR SELECT TO daftar_accounting_internal USING (true)`);
    }
    const back = await asRole<{ bucket_no: number }>('daftar_inventory_internal', {}, AGING, args);
    expect(back.error, `the control did not restore both policies: ${back.error ?? ''}`).toBeNull();
    expect(back.rows.length).toBeGreaterThan(1);
  });

  it('ROUND 7 F1 WHAT REFUSES AT READ TIME IS A HIDDEN ROW, AND A WIDENING IS NOT A DEFECT', async () => {
    // Round 6's «every other confirmation refuses» arm walked four CATALOGUE
    // faults — row security no longer FORCED, a policy of the right name for
    // the wrong role, a read expression that no longer matches the one
    // `public.invoices` carries, an extra policy nobody declared — and
    // asserted that the guard refused each. Those are gone WITH the guard, and
    // they are asserted at APPLY TIME by §2b instead.
    //
    // So this arm measures the thing that is actually load-bearing now: a
    // state that HIDES A ROW refuses, and a state that merely WIDENS does not.
    // The second half is the round-7 challenger's own preserved negative — a
    // bypassing or over-sighted caller is MORE-sighted, which makes the
    // comparison of the two readings correct rather than wrong — and a law
    // that refused a widening would be refusing on a proxy again.
    const p = ownerPool();
    const ctx = { tenant: tenantId, business: w.shop.businessId };
    const AGING = `SELECT bucket_no, txn_minor::text AS txn_minor FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[]) ORDER BY bucket_no`;
    const args = [w.shop.businessId, customerId, asOf, BUCKET_DAYS];

    // ── ONE DISCLOSED FIXTURE DEPARTURE, FOR THE LENGTH OF THIS ARM ONLY.
    //
    // This arm reads as `daftar_app`, and `daftar_app` holds NO EXECUTE on
    // `supplier_ap_release` in this database: that is PATCH REQUEST PR-6, a
    // declared blocker, and §D and §D2 of this same file MEASURE its absence,
    // so it cannot be pre-applied for the whole suite without falsifying them.
    // It is therefore granted here and REVOKED in the `finally`, which is the
    // only arrangement under which both readings are of the real database.
    // Without it this arm's own non-vacuity check fails with `42501
    // permission denied for function supplier_ap_release` and the arm measures
    // the missing grant instead of the law — which is what it did when the
    // plan writes in this file started reaching it.
    await p.query(`GRANT EXECUTE ON FUNCTION public.supplier_ap_release(BIGINT, BIGINT, BIGINT, BIGINT) TO daftar_app`);
    try {
      // NON-VACUITY FIRST: on a healthy database the read ANSWERS, or every
      // refusal below is a refusal of everything.
      const ok = await asRole<{ bucket_no: number }>('daftar_app', ctx, AGING, args);
      expect(ok.error, `the read refuses a healthy database: ${ok.error ?? ''}`).toBeNull();
      expect(ok.rows.length).toBeGreaterThan(1);

      const hides: readonly { readonly label: string; readonly code: string; readonly fault: string; readonly undo: string }[] = [
        {
          label: 'the plan relation hidden from the caller',
          code: 'installment.plan_fact_unreadable',
          fault: `DROP POLICY business_isolation_read ON installment_plans;
                CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT USING (false)`,
          undo: `DROP POLICY business_isolation_read ON installment_plans;
               CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
                 USING (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
                        OR business_id = nullif(app_business(), '')::uuid)`,
        },
        {
          label: 'the SCHEDULE relation hidden while the plan stays visible',
          code: 'installment.plan_schedule_unreadable',
          fault: `DROP POLICY business_isolation_read ON installments;
                CREATE POLICY business_isolation_read ON installments AS RESTRICTIVE FOR SELECT USING (false)`,
          undo: `DROP POLICY business_isolation_read ON installments;
               CREATE POLICY business_isolation_read ON installments AS RESTRICTIVE FOR SELECT
                 USING (app_bypass() OR current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal')
                        OR business_id = nullif(app_business(), '')::uuid)`,
        },
      ];
      for (const c of hides) {
        await p.query(c.fault);
        try {
          const r = await asRole<{ bucket_no: number }>('daftar_app', ctx, AGING, args);
          expect(r.error ?? '', `${c.label}: the read did not refuse`).toContain(c.code);
        } finally {
          await p.query(c.undo);
        }
        const after = await asRole<{ bucket_no: number }>('daftar_app', ctx, AGING, args);
        expect(after.error, `${c.label}: the undo did not restore the database`).toBeNull();
        expect(after.rows.length, `${c.label}: the undo restored the policy but not the answer`).toBeGreaterThan(1);
      }

      // AND THE WIDENINGS, which must NOT refuse.
      const widenings: readonly { readonly label: string; readonly fault: string; readonly undo: string }[] = [
        {
          label: 'row security no longer FORCED',
          fault: `ALTER TABLE installments NO FORCE ROW LEVEL SECURITY`,
          undo: `ALTER TABLE installments FORCE ROW LEVEL SECURITY`,
        },
        {
          label: 'an EXTRA permissive policy nobody declared',
          fault: `CREATE POLICY an_extra_policy ON installment_plans FOR SELECT TO daftar_app USING (true)`,
          undo: `DROP POLICY an_extra_policy ON installment_plans`,
        },
      ];
      for (const c of widenings) {
        await p.query(c.fault);
        try {
          const r = await asRole<{ bucket_no: number }>('daftar_app', ctx, AGING, args);
          expect(r.error, `${c.label}: a WIDENING made the read refuse, which is refusing on a proxy: ${r.error ?? ''}`).toBeNull();
          expect(r.rows.length, `${c.label}: the answer changed under a widening`).toBe(ok.rows.length);
        } finally {
          await p.query(c.undo);
        }
      }
    } finally {
      // PR-6 GOES BACK. §D and §D2 measure its absence, so the database must be
      // left exactly as this arm found it.
      await p.query(`REVOKE EXECUTE ON FUNCTION public.supplier_ap_release(BIGINT, BIGINT, BIGINT, BIGINT) FROM daftar_app`);
    }
  });

  it('ROUND 7 F1 THE REFUSAL IS NOT AN ORACLE — it is TOLD three numbers, reads nothing, and is INVOKER', async () => {
    // Round 6's DEFINER predecessor took `(business_id, invoice_id[])`, so on
    // its GRANTED SURFACE — not at its one call site — it answered
    // `(business, invoice) -> has an active plan` about rows row security
    // denies that role, with the COUNT in the error. Round 6 replaced it with
    // a zero-argument catalogue reader and pinned `pronargs = 0`.
    //
    // THIS ONE TAKES THREE ARGUMENTS AND IS STILL NOT AN ORACLE, and the
    // reason is structural rather than rhetorical: the arguments are three
    // `bigint`s, which NAME NO ROW, and the body reads NOTHING AT ALL — no
    // relation and no catalogue — so a caller learns only what it already
    // supplied. `pronargs = 0` is replaced by a pin on the argument TYPES.
    const meta = await ownerPool().query<{ argtypes: string; nargs: number; secdef: boolean; vol: string; src: string }>(
      `SELECT p.proargtypes::text AS argtypes, p.pronargs AS nargs, p.prosecdef AS secdef, p.provolatile::text AS vol, p.prosrc AS src
         FROM pg_proc p WHERE p.oid = 'installment_plan_fact_assert(bigint,bigint,bigint)'::regprocedure`,
    );
    // oid 20 is `bigint`. Three numbers name no row, no business and no tenant.
    expect(meta.rows[0]?.argtypes, 'it can be asked about something other than three numbers').toBe('20 20 20');
    expect(meta.rows[0]?.nargs).toBe(3);
    expect(meta.rows[0]?.secdef, "it is a DEFINER, so it lends its owner's visibility to its callers").toBe(false);
    expect(meta.rows[0]?.vol).toBe('s');
    const src = meta.rows[0]?.src ?? '';
    // IT READS NOTHING. That is what makes "three bigints" sufficient and not
    // merely necessary, and it is the difference between this and every
    // previous version.
    expect(src, 'it reads a tenant relation').not.toMatch(/FROM\s+public\./);
    expect(src, 'it reads the policy catalogue, which is the retired mechanism').not.toContain('pg_policy');
    expect(src, 'it asks about the caller rather than being told').not.toContain('has_table_privilege');
    expect(src).not.toContain('current_user');
    expect(src).not.toContain('SELECT');

    // MEASURED AS THE APPLICATION ROLE: the same three numbers give the same
    // answer with and without app context, because there is nothing in it that
    // depends on the session at all.
    const ASK = `SELECT installment_plan_fact_assert(0::BIGINT, 0::BIGINT, 0::BIGINT) AS ok`;
    const withCtx = await asRole<{ ok: boolean }>('daftar_app', { tenant: tenantId, business: w.shop.businessId }, ASK);
    const without = await asRole<{ ok: boolean }>('daftar_app', {}, ASK);
    expect(withCtx.error).toBeNull();
    expect(without.error, 'it behaves differently with and without app context, which is itself information').toBeNull();
    expect(withCtx.rows[0]?.ok).toBe(true);
    expect(without.rows[0]?.ok).toBe(true);
    // ...and it refuses on a non-zero count it was TOLD, which is the only
    // input it has.
    const told = await asRole<{ ok: boolean }>('daftar_app', {}, `SELECT installment_plan_fact_assert(1::BIGINT, 0::BIGINT, 0::BIGINT) AS ok`);
    expect(told.error ?? '', 'it does not refuse the count it is told').toContain('installment.plan_fact_unreadable');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('§H "ONCE PER CALL" — the claim that reached TL-P4-COORD-R31 out of my report, now MEASURED (round 6 F5)', () => {
  /**
   * F5 WAS AS MUCH THE COORDINATOR'S AS MINE, AND IT IS THE CHEAPEST KIND OF
   * DEFECT TO LET THROUGH. My round-5 report said the guard was "asked ONCE
   * PER CALL about the whole set"; that sentence was written into a ruling and
   * nothing in any suite had ever counted a call. It sat in the INDICATIVE
   * inside a section headed "NOT MEASURED", which is the worst place for it.
   *
   * It also mattered. A guard evaluated PER ROW on a customer with a thousand
   * open invoices is a thousand catalogue scans inside a reader, and the whole
   * reason the round-6 shape is safe to put in the hot path is that it runs
   * once.
   *
   * SO IT IS COUNTED, BY POSTGRESQL, AND THE FIXTURE DISCRIMINATES. A
   * measurement that only ever looks at ONE no-plan invoice cannot tell "once
   * per call" from "once per row" — the two answers coincide at one row, which
   * is exactly the shape of a matrix built to the detector. So two customers
   * are read: one with ONE open invoice and one with THREE, and the row counts
   * are asserted to differ before the call counts are compared. Per call, both
   * are 1; per row, they would be 1 and 3.
   *
   * THE INSTRUMENT is `pg_stat_user_functions.calls` with `track_functions`,
   * reset precisely with `pg_stat_reset_single_function_counters(oid)` rather
   * than `pg_stat_reset()`, which would clear the whole cluster's statistics
   * for everything else running here.
   */
  let manyCustomer = '';
  let oneCustomer = '';
  let guardOid = '';

  beforeAll(async () => {
    oneCustomer = customerId;
    manyCustomer = await newCustomer(w);
    for (let n = 0; n < 3; n += 1) {
      const saleId = randomUUID();
      const sale = await confirmSale(w.t, w.headers, {
        saleId,
        customerId: manyCustomer,
        warehouseId: w.shop.w1,
        branchId: w.shop.branchX,
        occurredOn: w.day,
        dueDate: w.day,
        lines: [{ productId: w.shop.piece.productId, quantity: '3' }],
      });
      expect(sale.status, `credit sale ${String(n)} for the three-invoice customer: ${JSON.stringify(sale.body)}`).toBeLessThan(300);
    }
    guardOid =
      (
        await ownerPool().query<{ oid: string }>(
          // ROUND 7 F1: the routine this arm counts is the read-time refusal of
          // `TL-P4-COORD-R38` direction (d). Only the SUBJECT moves here —
          // round-6 F3's reasoning about WHY it is once per call is a LATER
          // round's and is deliberately left exactly as it was written.
          `SELECT 'public.installment_plan_fact_assert(bigint,bigint,bigint)'::regprocedure::oid::text AS oid`,
        )
      ).rows[0]?.oid ?? '';
    expect(guardOid, 'the guard has no oid, so there is nothing to count').not.toBe('');
  }, 300_000);

  it('the guard is evaluated ONCE PER CALL and not once per no-plan invoice', async () => {
    const c = await ownerPool().connect();
    try {
      // `track_functions` is session-settable by a superuser, and this is why
      // the arm holds ONE client rather than borrowing from the pool: a `SET`
      // on a connection that goes back to the pool measures the wrong session.
      await c.query(`SET track_functions = 'pl'`);
      // `SHOW` names its own column, so the reading is taken through
      // `current_setting`: a `SHOW` read as `{ s }` comes back UNDEFINED, and
      // the assertion below then fails for the wrong reason — which is how a
      // non-vacuity check turns into noise about itself.
      const setting = await c.query<{ s: string }>(`SELECT pg_catalog.current_setting('track_functions') AS s`);
      expect(setting.rows[0]?.s, 'function statistics are not being collected, so every count below would be zero').toBe('pl');

      const countFor = async (customer: string): Promise<{ calls: number; invoices: number }> => {
        await c.query(`SELECT pg_stat_reset_single_function_counters($1::oid)`, [guardOid]);
        const r = await c.query<AgingRow>(`SELECT * FROM customer_ar_aging($1, $2, $3::DATE, $4::INTEGER[])`, [w.shop.businessId, customer, asOf, BUCKET_DAYS]);
        // THE FLUSH IS FORCED, AND THE FIRST VERSION OF THIS ARM DID NOT DO
        // IT AND READ ZERO. A backend accumulates its function statistics
        // locally and flushes them to shared memory at transaction end, but
        // subsequent flushes are RATE-LIMITED, so the reading taken
        // immediately afterwards saw nothing and the non-vacuity check
        // correctly refused to call that a measurement.
        // `pg_stat_force_next_flush()` removes the rate limit for this
        // backend's next flush.
        await c.query(`SELECT pg_stat_force_next_flush()`);
        const s = await c.query<{ calls: string | null }>(`SELECT calls::text AS calls FROM pg_stat_user_functions WHERE funcid = $1::oid`, [guardOid]);
        // THE ROW COUNT IS NOT THE SUBJECT, AND THE FIRST FIXTURE GOT THIS
        // WRONG. Three invoices sharing one due date fall in ONE band, so the
        // reader returns one row for one invoice and one row for three — and
        // "more rows" was therefore false of a fixture that really does differ.
        // What a per-row evaluation would scale with is the number of NO-PLAN
        // INVOICES reaching arm (c), and the return shape carries exactly that
        // in `invoice_count`.
        const invoices = r.rows.reduce((t, x) => t + Number(x.invoice_count), 0);
        return { calls: Number(s.rows[0]?.calls ?? '0'), invoices };
      };

      // NON-VACUITY FIRST: the instrument must be able to see a call at all,
      // or "exactly 1" is indistinguishable from "statistics are off".
      const one = await countFor(oneCustomer);
      expect(one.calls, 'the counter saw NO call, so this arm measures the instrument and not the guard').toBeGreaterThan(0);

      const many = await countFor(manyCustomer);
      // THE FIXTURE DISCRIMINATES, asserted BEFORE the counts are compared:
      // one no-plan invoice against three, read by the routine itself.
      expect(one.invoices, 'the one-invoice customer is not serving one no-plan invoice').toBe(1);
      expect(many.invoices, 'the three-invoice customer is not serving three no-plan invoices, so the fixture cannot tell per-call from per-row').toBe(3);
      const invoices = await ownerPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM invoices WHERE business_id = $1 AND customer_id = $2 AND status = 'open'`,
        [w.shop.businessId, manyCustomer],
      );
      expect(invoices.rows[0]?.n, 'the three-invoice customer does not have three open invoices').toBe('3');

      // THE LAW.
      expect(one.calls, 'the guard is called more than once for a single call of the reader').toBe(1);
      expect(many.calls, 'THE GUARD IS EVALUATED PER ROW: the claim written into TL-P4-COORD-R31 is false').toBe(1);

      // THE INSTRUMENT CAN SAY MORE THAN ONE, and without this the law above
      // is a counter that only ever reads 1.
      //
      // I TRIED THE OBVIOUS MUTANT FIRST AND IT DID NOT DISCRIMINATE. Moving
      // the call from `CROSS JOIN (SELECT assert()) g WHERE g.ok` into the
      // row qualification itself — `WHERE assert()` over `no_plan` — still
      // read exactly 1, because a row-INDEPENDENT qualification is a one-time
      // filter to the planner. So "once per call" is NOT a property of this
      // spelling; it is a property of the SIGNATURE, and it is the
      // zero-argument shape F1 required that makes a per-row evaluation
      // INEXPRESSIBLE. §2b refuses `pronargs <> 0` at apply time, which is
      // therefore also what keeps this reading true.
      //
      // Which leaves one thing still to measure: that `calls` would have
      // reported a per-row evaluation had there been one. A one-argument
      // STABLE probe — the shape the guard is forbidden to have — called with
      // a value from each row, counted the same way:
      await c.query(
        `CREATE FUNCTION pg_temp.s7_percall_probe(p UUID) RETURNS BOOLEAN
         LANGUAGE plpgsql STABLE AS $probe$ BEGIN RETURN p IS NOT NULL; END; $probe$`,
      );
      const probeOid = (await c.query<{ oid: string }>(`SELECT 'pg_temp.s7_percall_probe(uuid)'::regprocedure::oid::text AS oid`)).rows[0]?.oid ?? '';
      expect(probeOid, 'the probe has no oid, so the control below counts nothing').not.toBe('');
      await c.query(`SELECT pg_stat_reset_single_function_counters($1::oid)`, [probeOid]);
      const probed = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM invoices i
          WHERE i.business_id = $1 AND i.customer_id = $2 AND i.status = 'open' AND pg_temp.s7_percall_probe(i.id)`,
        [w.shop.businessId, manyCustomer],
      );
      await c.query(`SELECT pg_stat_force_next_flush()`);
      const probeCalls = await c.query<{ calls: string | null }>(`SELECT calls::text AS calls FROM pg_stat_user_functions WHERE funcid = $1::oid`, [probeOid]);
      expect(probed.rows[0]?.n, 'the probe did not see the three rows it was supposed to be called on').toBe('3');
      expect(
        Number(probeCalls.rows[0]?.calls ?? '0'),
        'THE INSTRUMENT CANNOT COUNT PAST ONE: the law above is a counter that only ever reads 1, so it measures nothing',
      ).toBe(3);
      await c.query(`DROP FUNCTION pg_temp.s7_percall_probe(UUID)`);
    } finally {
      await c.query(`RESET track_functions`).catch(() => undefined);
      c.release();
    }
  }, 180_000);
});
