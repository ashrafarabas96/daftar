/** SCRATCH: round-11 step zero. Deleted before commit. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb, urlOf } from '../helpers/scratch-db';

const DB = 'daftar_s7r11_z';
const SPEC = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'), 'utf8');
const SHA = 'a'.repeat(64);
const STAMP = '2026-01-02T00:00:00Z';
const BUCKETS = [30, 60, 90];
interface Outcome { readonly error: string | null; readonly rows: readonly Record<string, unknown>[]; }
const M: Record<string, unknown> = {};
const err = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let db: ScratchDb; let sup: Pool; let mig: Pool; let app: Pool;
let world: { tenantId: string; businessId: string; customerId: string; invoiceId: string; invoice2Id: string; userId: string };

async function inCtx(pool: Pool, ctx: Record<string, string>, work: readonly { sql: string; params?: readonly unknown[] }[]): Promise<Outcome> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(ctx)) await c.query(`SELECT set_config($1,$2,true)`, [k, v]);
    let rows: readonly Record<string, unknown>[] = [];
    for (const w of work) rows = (await c.query(w.sql, [...(w.params ?? [])])).rows as readonly Record<string, unknown>[];
    await c.query('COMMIT');
    return { error: null, rows };
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); return { error: err(e), rows: [] }; }
  finally { c.release(); }
}
const APP_CTX = (): Record<string, string> => ({ 'app.tenant_id': world.tenantId, 'app.business_id': world.businessId });
const ddl = async (sql: string): Promise<string | null> => { try { await mig.query(sql); return null; } catch (e) { return err(e); } };

const RESTORE = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
     USING (app_bypass() OR current_user IN ('daftar_inventory_internal','daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid)`;
/** STEP ZERO's policy: the shipped text, predicated additionally on status <> 'active'. */
const STATUS_BLIND = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
     USING (status <> 'active'
            AND (app_bypass() OR current_user IN ('daftar_inventory_internal','daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid))`;
/** The same, blinding ONLY the definer: daftar_migrator and daftar_app keep seeing active rows. */
const STATUS_BLIND_WRITER_ONLY = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
     USING (app_bypass()
            OR (current_user = 'daftar_accounting_internal' AND status <> 'active')
            OR (current_user <> 'daftar_accounting_internal'
                AND (current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)))`;
const rePolicy = async (create: string): Promise<(string | null)[]> => [await ddl(`DROP POLICY business_isolation_read ON installment_plans`), await ddl(create)];

const flagOf = async (inv: string): Promise<string> =>
  String((await inCtx(sup, {}, [{ sql: `SELECT has_active_installment_plan::text AS f FROM invoices WHERE id=$1`, params: [inv] }])).rows[0]?.['f'] ?? 'MISSING');
const truthOf = async (inv: string): Promise<string> =>
  String((await inCtx(sup, {}, [{ sql: `SELECT EXISTS(SELECT 1 FROM installment_plans p WHERE p.invoice_id=$1 AND p.status='active')::text AS t`, params: [inv] }])).rows[0]?.['t'] ?? 'MISSING');
const plansOf = async (inv: string): Promise<unknown> =>
  (await inCtx(sup, {}, [{ sql: `SELECT status, count(*)::text AS n FROM installment_plans WHERE invoice_id=$1 GROUP BY status ORDER BY status`, params: [inv] }])).rows;
const state = async (inv: string): Promise<unknown> => ({ flag: await flagOf(inv), truth: await truthOf(inv), plans: await plansOf(inv) });
const aging = async (): Promise<Outcome> =>
  inCtx(app, APP_CTX(), [{ sql: `SELECT * FROM public.customer_ar_aging($1,$2,$3::DATE,$4::INTEGER[]) ORDER BY bucket_no`, params: [world.businessId, world.customerId, '2026-06-30', BUCKETS] }]);

const barePlan = async (inv: string, status: string, planId: string): Promise<string | null> =>
  (await inCtx(mig, APP_CTX(), [{
    sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
          VALUES ($1,$2,$3,$4,$5,$6,0,'2026-01-02'::DATE,$7,gen_random_uuid())`,
    params: [world.tenantId, world.businessId, planId, inv, world.customerId, status, world.userId],
  }])).error;
const setStatus = async (planId: string, status: string): Promise<string | null> =>
  (await inCtx(mig, APP_CTX(), [{ sql: `UPDATE installment_plans SET status=$2 WHERE id=$1`, params: [planId, status] }])).error;

beforeAll(async () => {
  db = await createScratchDb(DB, { migratorOwned: true });
  sup = new Pool({ connectionString: urlOf(DB, 'postgres'), max: 3 });
  mig = new Pool({ connectionString: urlOf(DB, 'daftar_migrator'), max: 3 });
  app = new Pool({ connectionString: urlOf(DB, 'daftar_app'), max: 3 });
  const c = await sup.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_binding_fk');
    await c.query('ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_binding_fk');
    await c.query('ALTER TABLE sales DISABLE TRIGGER USER');
    const one = async (sql: string, p: readonly unknown[] = []): Promise<string> => String((await c.query<{ id: string }>(sql, [...p])).rows[0]?.id);
    const tenantId = await one('INSERT INTO tenants DEFAULT VALUES RETURNING id');
    const userId = await one(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x','Z') RETURNING id`, [`s7z-${process.pid}@test.daftar.local`]);
    const businessId = await one(`INSERT INTO businesses (tenant_id,name,store_slug,country_code,base_currency,timezone) VALUES ($1,'Z Books',$2,'PS','ILS','Asia/Hebron') RETURNING id`, [tenantId, `s7z-${process.pid}`]);
    const branchId = await one(`INSERT INTO branches (business_id,name,is_default) VALUES ($1,'Main',true) RETURNING id`, [businessId]);
    const warehouseId = await one(`INSERT INTO warehouses (business_id,branch_id,name,is_default) VALUES ($1,$2,'WH',true) RETURNING id`, [businessId, branchId]);
    const customerId = randomUUID();
    await c.query(`INSERT INTO customers (tenant_id,business_id,id,name,status,revision,create_intent_sha256,last_intent_sha256,business_transaction_id,created_by,updated_by)
       VALUES ($1,$2,$3,'Z Customer','active',1,$4,$4,gen_random_uuid(),$5,$5)`, [tenantId, businessId, customerId, SHA, userId]);
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const saleId = randomUUID();
      await c.query(`INSERT INTO sales (tenant_id,business_id,id,customer_id,branch_id,warehouse_id,status,settlement_mode,document_date,currency_code,
          subtotal_txn_minor,discount_txn_minor,total_txn_minor,total_base_minor,source_to_base_rate,rate_source,rate_timestamp,
          customer_name_snapshot,commit_intent_sha256,confirmed_by,confirmed_at,business_transaction_id,created_by,binding_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed','credit','2026-01-02','ILS',900000,0,900000,900000,1,'base',$7::timestamptz,'Z Customer',$8,$9,$7::timestamptz,gen_random_uuid(),$9,$3)`,
        [tenantId, businessId, saleId, customerId, branchId, warehouseId, STAMP, SHA, userId]);
      const invoiceId = randomUUID();
      await c.query(`INSERT INTO invoices (tenant_id,business_id,id,sale_id,customer_id,branch_id,document_kind,document_number,number_seq,period,issue_date,due_date,
          currency_code,status,subtotal_txn_minor,discount_txn_minor,tax_minor,total_txn_minor,total_base_minor,source_to_base_rate,
          rate_source,rate_timestamp,customer_name_snapshot,issue_intent_sha256,business_transaction_id,created_by,binding_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'invoice',$10,$11,'2026','2026-01-02','2026-01-02','ILS','open',900000,0,0,900000,900000,1,'base',$7::timestamptz,
                 'Z Customer',$8,gen_random_uuid(),$9,$3)`,
        [tenantId, businessId, invoiceId, saleId, customerId, branchId, STAMP, SHA, userId, `INV-Z${n}`, n]);
      ids.push(invoiceId);
    }
    await c.query(`GRANT EXECUTE ON FUNCTION public.supplier_ap_release(BIGINT,BIGINT,BIGINT,BIGINT) TO daftar_app`);
    await c.query('COMMIT');
    await c.query('ALTER TABLE sales ENABLE TRIGGER USER');
    world = { tenantId, businessId, customerId, invoiceId: ids[0] as string, invoice2Id: ids[1] as string, userId };
  } finally { c.release(); }

  let specError: string | null = null;
  try { await mig.query(SPEC); } catch (e) { specError = err(e); }
  M['specError'] = specError;
  if (specError !== null) { writeFileSync('/tmp/claude-0/s7r11-stepzero.json', JSON.stringify(M, null, 2)); return; }

  // PROVE WHAT IS INSTALLED before trusting any probe.
  M['installed_sync_sha'] = (await sup.query(`SELECT md5(prosrc) AS h, (prosrc LIKE '%plan_fact_blind%') AS blind, (prosrc LIKE '%v_asserted%') AS asserted FROM pg_proc WHERE oid='public.installment_plan_fact_sync()'::regprocedure`)).rows[0];

  // ── Z0 the asymmetry, measured first.
  M['Z0_blind_ddl'] = await rePolicy(STATUS_BLIND);
  M['Z0_definer_sees_active'] = (await sup.query(`SELECT count(*)::text AS n FROM installment_plans`)).rows[0];
  M['Z0_restore'] = await rePolicy(RESTORE);

  // ── Z1 INVOICE 1: flag already FALSE, no plan at all. status-blinded INSERT of a CANCELLED plan.
  M['Z1_pre'] = await state(world.invoiceId);
  await rePolicy(STATUS_BLIND);
  const z1 = randomUUID();
  M['Z1_insert_cancelled_error'] = await barePlan(world.invoiceId, 'cancelled', z1);
  M['Z1_state'] = await state(world.invoiceId);
  await rePolicy(RESTORE);
  M['Z1_state_after_restore'] = await state(world.invoiceId);
  M['Z1_aging'] = await aging();

  // ── Z2 the direction that WOULD make the flag wrong: status-blinded INSERT of an ACTIVE plan
  //    on an invoice whose flag is already false.
  await rePolicy(STATUS_BLIND);
  const z2 = randomUUID();
  M['Z2_insert_active_error'] = await barePlan(world.invoiceId, 'active', z2);
  M['Z2_state'] = await state(world.invoiceId);
  await rePolicy(RESTORE);

  // ── Z3 the same, with ONLY the definer blinded (migrator still sees active rows).
  await rePolicy(STATUS_BLIND_WRITER_ONLY);
  M['Z3_mig_sees_active'] = (await inCtx(mig, APP_CTX(), [{ sql: `SELECT count(*)::text AS n FROM installment_plans WHERE invoice_id=$1`, params: [world.invoiceId] }])).rows[0];
  const z3 = randomUUID();
  M['Z3_insert_active_error'] = await barePlan(world.invoiceId, 'active', z3);
  M['Z3_state'] = await state(world.invoiceId);
  await rePolicy(RESTORE);

  // ── a REAL active plan: a bare active plan is refused by obligation (a), so the
  //    schedule goes in the same transaction.
  const planWithSchedule = async (inv: string, planId: string, status = 'active'): Promise<string | null> =>
    (await inCtx(mig, APP_CTX(), [
      { sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
              VALUES ($1,$2,$3,$4,$5,$6,100000,'2026-01-02'::DATE,$7,gen_random_uuid())`,
        params: [world.tenantId, world.businessId, planId, inv, world.customerId, status, world.userId] },
      { sql: `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
              VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-02-02'::DATE,400000),($1,$2,gen_random_uuid(),$3,2,'2026-06-02'::DATE,400000)`,
        params: [world.tenantId, world.businessId, planId] },
    ])).error;

  // ── Z4 FLAG TRUE: a real active plan, then a status-blinded DELETE of a cancelled plan
  //    beside it. Empty write set, no probe, cross-check never runs -- F-3's case.
  const z4 = randomUUID();
  M['Z4_active_plan_commits'] = await planWithSchedule(world.invoice2Id, z4);
  M['Z4_pre'] = await state(world.invoice2Id);
  const z4c = randomUUID();
  M['Z4_cancelled_beside'] = await barePlan(world.invoice2Id, 'cancelled', z4c);
  await rePolicy(STATUS_BLIND_WRITER_ONLY);
  M['Z4_blinded_delete_cancelled'] = (await inCtx(mig, APP_CTX(), [{ sql: `DELETE FROM installment_plans WHERE id=$1`, params: [z4c] }])).error;
  M['Z4_state'] = await state(world.invoice2Id);
  await rePolicy(RESTORE);

  // ── Z5 the status-blinded CANCEL of the active plan: write set {false}, probe passes
  //    because a cancelled row is visible, cross-check agrees because it is blinded to
  //    exactly the rows that are gone. Flag -> false.
  await rePolicy(STATUS_BLIND_WRITER_ONLY);
  M['Z5_blinded_cancel'] = await setStatus(z4, 'cancelled');
  M['Z5_state'] = await state(world.invoice2Id);
  //    and the REACTIVATION from a flag that is now FALSE.
  M['Z5_blinded_reactivate'] = await setStatus(z4, 'active');
  M['Z5_state_after_reactivate'] = await state(world.invoice2Id);
  //    and cancel-then-activate in ONE transaction from the flag-false state.
  M['Z5_one_txn_cancel_then_activate'] = (await inCtx(mig, APP_CTX(), [
    { sql: `UPDATE installment_plans SET status='cancelled' WHERE id=$1`, params: [z4] },
    { sql: `UPDATE installment_plans SET status='active' WHERE id=$1`, params: [z4] },
  ])).error;
  M['Z5_state_after_one_txn'] = await state(world.invoice2Id);
  await rePolicy(RESTORE);
  M['Z5_state_after_restore'] = await state(world.invoice2Id);
  M['Z5_aging'] = await aging();

  // ── Z6 TWO FAULTS. The deferred verifier is the backstop that catches a DISABLED sync
  //    trigger (the suite's D1). Under status-predicated blinding its EXISTS reads false,
  //    and against a flag that is ALREADY FALSE the two readings AGREE -- the "degrades to
  //    a pass" direction the spec declares. Measured here with both faults in place.
  //    The CONTROL (one fault: the trigger alone) comes first.
  //    Clean up invoice 2 so its flag is false and no plan is on it.
  M['Z6_cleanup'] = (await inCtx(mig, APP_CTX(), [
    { sql: `DELETE FROM installments WHERE plan_id=$1`, params: [z4] },
    { sql: `DELETE FROM installment_plans WHERE id=$1`, params: [z4] },
  ])).error;
  M['Z6_pre'] = await state(world.invoice2Id);
  M['Z6_disable_sync'] = await ddl(`ALTER TABLE installment_plans DISABLE TRIGGER installment_plans_fact_sync`);
  //    CONTROL: trigger disabled, policy SHIPPED. The deferred verifier must refuse.
  const z6a = randomUUID();
  M['Z6_control_one_fault'] = await planWithSchedule(world.invoice2Id, z6a);
  M['Z6_control_state'] = await state(world.invoice2Id);
  //    THE SUBJECT: trigger disabled AND the status-predicated policy installed.
  await rePolicy(STATUS_BLIND_WRITER_ONLY);
  const z6b = randomUUID();
  M['Z6_two_faults'] = await planWithSchedule(world.invoice2Id, z6b);
  M['Z6_two_faults_state'] = await state(world.invoice2Id);
  //    AND WHAT THE READER SERVES, with everything restored -- no fault left in place.
  await rePolicy(RESTORE);
  M['Z6_enable_sync'] = await ddl(`ALTER TABLE installment_plans ENABLE TRIGGER installment_plans_fact_sync`);
  M['Z6_state_all_restored'] = await state(world.invoice2Id);
  M['Z6_aging_all_restored'] = await aging();
  //    AND THE CORRECT READING, for comparison: the same world with the flag repaired.
  M['Z6_repair_flag'] = (await inCtx(sup, APP_CTX(), [{
    sql: `UPDATE invoices SET has_active_installment_plan = EXISTS (SELECT 1 FROM installment_plans p WHERE p.business_id=invoices.business_id AND p.invoice_id=invoices.id AND p.status='active') WHERE id=$1`,
    params: [world.invoice2Id] }])).error;
  M['Z6_state_after_repair'] = await state(world.invoice2Id);
  M['Z6_aging_after_repair'] = await aging();

  writeFileSync('/tmp/claude-0/s7r11-stepzero.json', JSON.stringify(M, null, 2));
}, 1800000);

afterAll(async () => {
  await Promise.all([sup?.end(), mig?.end(), app?.end()].map((p) => (p ?? Promise.resolve()).catch(() => undefined)));
  await db?.drop().catch(() => undefined);
});

describe('STEP ZERO', () => {
  it('records', () => { expect(M['specError']).toBeNull(); });
});
