/** SCRATCH: round-11 step zero. Deleted before commit. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb, urlOf } from '../helpers/scratch-db';

const DB = 'daftar_s7r11_w';
const SPEC = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql'), 'utf8');
const SYNC_HEAD = `CREATE OR REPLACE FUNCTION public.installment_plan_fact_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business UUID;
  v_invoices UUID[];
  v_invoice  UUID;
  v_state    BOOLEAN;
  v_rows     INTEGER;`;
const SYNC_TAIL = `  FOREACH v_invoice IN ARRAY v_invoices LOOP
    SELECT EXISTS (SELECT 1 FROM public.installment_plans p
                    WHERE p.business_id = v_business AND p.invoice_id = v_invoice
                      AND p.status = 'active')
      INTO v_state;
__FLOOR__
    UPDATE public.invoices i SET has_active_installment_plan = v_state
     WHERE i.business_id = v_business AND i.id = v_invoice;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'installment.plan_fact_unwritable: this transaction changed a plan on invoice %/% but could not write the invoice''s own has_active_installment_plan (% rows), so the aging would read a fact nobody maintained',
        v_business, v_invoice, v_rows USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$fn$;`;

const SYNC_R8 = `${SYNC_HEAD}
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_business := OLD.business_id;
    v_invoices := ARRAY[OLD.invoice_id];
  ELSE
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
    IF OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
      v_invoices := v_invoices || OLD.invoice_id;
    END IF;
  END IF;
${SYNC_TAIL.replace('__FLOOR__\n', '')}`;

const SYNC_R9 = `${SYNC_HEAD}
  v_asserted UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
    IF NEW.status = 'active' THEN v_asserted := NEW.invoice_id; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_business := OLD.business_id;
    v_invoices := ARRAY[OLD.invoice_id];
  ELSE
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
    IF NEW.status = 'active' THEN v_asserted := NEW.invoice_id; END IF;
    IF OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
      v_invoices := v_invoices || OLD.invoice_id;
    END IF;
  END IF;
${SYNC_TAIL.replace(
  '__FLOOR__',
  `    IF v_asserted IS NOT NULL AND v_invoice = v_asserted AND NOT v_state THEN
      RAISE EXCEPTION 'installment.plan_fact_blind: this transaction wrote an ACTIVE plan on invoice %/% and the recomputation over installment_plans then found none, so the recomputation is blinded rather than the plan absent, and writing false would commit a fact that can never heal',
        v_business, v_invoice USING ERRCODE = 'P0001';
    END IF;`,
)}`;


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
  if (specError !== null) { writeFileSync('/tmp/claude-0/s7r11-w.json', JSON.stringify(M, null, 2)); return; }

  // PROVE WHAT IS INSTALLED before trusting any probe.
  M['installed_sync_sha'] = (await sup.query(`SELECT md5(prosrc) AS h, (prosrc LIKE '%plan_fact_blind%') AS blind, (prosrc LIKE '%v_asserted%') AS asserted FROM pg_proc WHERE oid='public.installment_plan_fact_sync()'::regprocedure`)).rows[0];


  const planWithSchedule = async (inv: string, planId: string, status = 'active'): Promise<string | null> =>
    (await inCtx(mig, APP_CTX(), [
      { sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
              VALUES ($1,$2,$3,$4,$5,$6,100000,'2026-01-02'::DATE,$7,gen_random_uuid())`,
        params: [world.tenantId, world.businessId, planId, inv, world.customerId, status, world.userId] },
      { sql: `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
              VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-02-02'::DATE,400000),($1,$2,gen_random_uuid(),$3,2,'2026-06-02'::DATE,400000)`,
        params: [world.tenantId, world.businessId, planId] },
    ])).error;
  const SYNC_NEW = (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.installment_plan_fact_sync()'::regprocedure) AS d`)).rows[0]?.d as string;
  const installSync = async (b: string): Promise<string | null> => { try { await sup.query(b); return null; } catch (e) { return err(e); } };
  M['W_counterfactual_rewrote'] = SYNC_NEW !== SYNC_R9 && SYNC_R9.includes('v_asserted') && !SYNC_NEW.includes('v_asserted');

  // ══ W1 THE INSERT-BRANCH DERIVATION IS LOAD-BEARING, AND THE CASE IS NOT THE PROBE.
  //    The status-predicated policy leaves the by-PK probe PASSING for a non-active row.
  //    Round 9's INSERT branch then lets the blinded recomputation decide, writes false,
  //    and the deferred verifier AGREES with it because it is blinded the same way.
  const w1Active = randomUUID();
  M['W1_active_commits'] = await planWithSchedule(world.invoiceId, w1Active);
  M['W1_pre'] = await state(world.invoiceId);
  M['W1_r9_install'] = await installSync(SYNC_R9);
  await rePolicy(STATUS_BLIND_WRITER_ONLY);
  M['W1_probe_target_visible_to_definer'] = (await sup.query(`SELECT count(*)::text AS n FROM installment_plans WHERE status <> 'active'`)).rows[0];
  const w1c = randomUUID();
  M['W1_r9_insert_cancelled'] = await barePlan(world.invoiceId, 'cancelled', w1c);
  M['W1_r9_state'] = await state(world.invoiceId);
  await rePolicy(RESTORE);
  M['W1_r9_state_after_restore'] = await state(world.invoiceId);
  M['W1_r9_aging_after_restore'] = await aging();
  //    clean the planted row and the flag, then the SHIPPED body on the SAME construction
  M['W1_cleanup'] = (await inCtx(mig, APP_CTX(), [{ sql: `DELETE FROM installment_plans WHERE id=$1`, params: [w1c] }])).error;
  M['W1_cleanup_state'] = await state(world.invoiceId);
  M['W1_new_install'] = await installSync(SYNC_NEW);
  M['W1_repair_flag'] = (await inCtx(sup, APP_CTX(), [{ sql: `UPDATE invoices SET has_active_installment_plan = EXISTS (SELECT 1 FROM installment_plans p WHERE p.business_id=invoices.business_id AND p.invoice_id=invoices.id AND p.status='active') WHERE id=$1`, params: [world.invoiceId] }])).error;
  M['W1_pre_new'] = await state(world.invoiceId);
  await rePolicy(STATUS_BLIND_WRITER_ONLY);
  const w1d = randomUUID();
  M['W1_new_insert_cancelled'] = await barePlan(world.invoiceId, 'cancelled', w1d);
  M['W1_new_state'] = await state(world.invoiceId);
  await rePolicy(RESTORE);
  M['W1_new_state_after_restore'] = await state(world.invoiceId);
  M['W1_new_aging'] = await aging();

  /** A plan row plus a LAWFUL two-row schedule: obligation (b) refuses an active plan with none. */
  const PAIR = (planId: string, status: string): { sql: string; params: readonly unknown[] }[] => [
    { sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
            VALUES ($1,$2,$3,$4,$5,$6,100000,'2026-01-02'::DATE,$7,gen_random_uuid())`,
      params: [world.tenantId, world.businessId, planId, world.invoice2Id, world.customerId, status, world.userId] },
    { sql: `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
            VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-02-02'::DATE,400000),($1,$2,gen_random_uuid(),$3,2,'2026-06-02'::DATE,400000)`,
      params: [world.tenantId, world.businessId, planId] },
  ];

  // ══ W2 F-4 ROW ORDER. A single statement moving `active` from one plan to another of the
  //    same invoice, with the fixture built in the two heap orders. Three repeats each.
  const moveOne = async (activeFirst: boolean): Promise<Record<string, unknown>> => {
    const a = randomUUID(); const b = randomUUID();
    // heap order is insertion order in a fresh pair of rows
    const first = activeFirst ? { id: a, st: 'active' } : { id: b, st: 'cancelled' };
    const second = activeFirst ? { id: b, st: 'cancelled' } : { id: a, st: 'active' };
    const build = await inCtx(mig, APP_CTX(), [
      ...PAIR(first.id, first.st), ...PAIR(second.id, second.st),
    ]);
    const ctid = (await sup.query(`SELECT id::text, status, ctid::text FROM installment_plans WHERE invoice_id=$1 ORDER BY ctid`, [world.invoice2Id])).rows;
    const move = await inCtx(mig, APP_CTX(), [
      { sql: `UPDATE installment_plans SET status = CASE WHEN id = $1 THEN 'cancelled' ELSE 'active' END WHERE invoice_id = $2 AND id IN ($1,$3)`,
        params: [a, world.invoice2Id, b] },
    ]);
    const st = await state(world.invoice2Id);
    const clean = (await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installments WHERE plan_id IN (SELECT id FROM installment_plans WHERE invoice_id=$1)`, params: [world.invoice2Id] },
      { sql: `DELETE FROM installment_plans WHERE invoice_id=$1`, params: [world.invoice2Id] }])).error;
    return { build: build.error, heap: ctid, moveError: move.error, state: st, clean, flagAfterClean: await flagOf(world.invoice2Id) };
  };
  const w2: unknown[] = [];
  for (const activeFirst of [true, false]) for (const _n of [1, 2, 3]) w2.push({ activeFirst, ...(await moveOne(activeFirst)) });
  M['W2_single_statement_move'] = w2;

  // ══ W3 F-4 half two: the TWO-STATEMENT orders, both ways, in one transaction.
  const twoStatement = async (cancelFirst: boolean): Promise<Record<string, unknown>> => {
    const a = randomUUID(); const b = randomUUID();
    const build = await inCtx(mig, APP_CTX(), [...PAIR(a, 'active'), ...PAIR(b, 'cancelled')]);
    const s1 = { sql: `UPDATE installment_plans SET status='cancelled' WHERE id=$1`, params: [a] };
    const s2 = { sql: `UPDATE installment_plans SET status='active' WHERE id=$1`, params: [b] };
    const move = await inCtx(mig, APP_CTX(), cancelFirst ? [s1, s2] : [s2, s1]);
    const st = await state(world.invoice2Id);
    const clean = (await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installments WHERE plan_id IN (SELECT id FROM installment_plans WHERE invoice_id=$1)`, params: [world.invoice2Id] },
      { sql: `DELETE FROM installment_plans WHERE invoice_id=$1`, params: [world.invoice2Id] }])).error;
    return { build: build.error, moveError: move.error, state: st, clean };
  };
  M['W3_cancel_then_activate'] = await twoStatement(true);
  M['W3_activate_then_cancel'] = await twoStatement(false);

  // ══ W4 F-6 the two advertised sync refusals.
  const w4Plan = randomUUID();
  M['W4_build'] = await planWithSchedule(world.invoiceId, w4Plan, 'cancelled');
  M['W4_business_change'] = (await inCtx(mig, APP_CTX(), [
    { sql: `UPDATE installment_plans SET business_id = gen_random_uuid() WHERE id=$1`, params: [w4Plan] },
  ])).error;
  M['W4_business_change_sup'] = (await inCtx(sup, APP_CTX(), [
    { sql: `UPDATE installment_plans SET business_id = gen_random_uuid() WHERE id=$1`, params: [w4Plan] },
  ])).error;
  const otherTenant = String((await sup.query('INSERT INTO tenants DEFAULT VALUES RETURNING id')).rows[0]?.id);
  M['W4_cross_tenant'] = (await inCtx(mig, { 'app.tenant_id': otherTenant, 'app.business_id': world.businessId }, [
    { sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
            VALUES ($1,$2,$3,$4,$5,'cancelled',0,'2026-01-02'::DATE,$6,gen_random_uuid())`,
      params: [otherTenant, world.businessId, randomUUID(), world.invoiceId, world.customerId, world.userId] },
  ])).error;
  M['W4_cross_tenant_active'] = (await inCtx(mig, { 'app.tenant_id': otherTenant, 'app.business_id': world.businessId }, [
    { sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
            VALUES ($1,$2,$3,$4,$5,'active',0,'2026-01-02'::DATE,$6,gen_random_uuid())`,
      params: [otherTenant, world.businessId, randomUUID(), world.invoiceId, world.customerId, world.userId] },
  ])).error;

  M['W4_cross_tenant_ctx_own'] = (await inCtx(mig, APP_CTX(), [
    { sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
            VALUES ($1,$2,$3,$4,$5,'cancelled',0,'2026-01-02'::DATE,$6,gen_random_uuid())`,
      params: [otherTenant, world.businessId, randomUUID(), world.invoiceId, world.customerId, world.userId] },
  ])).error;
  const bare = randomUUID();
  M['W4_bare_build'] = await barePlan(world.invoiceId, 'cancelled', bare);
  M['W4_bare_business_change_sup'] = (await inCtx(sup, APP_CTX(), [
    { sql: `UPDATE installment_plans SET business_id = gen_random_uuid() WHERE id=$1`, params: [bare] },
  ])).error;
  const otherBiz = String((await sup.query(`INSERT INTO businesses (tenant_id,name,store_slug,country_code,base_currency,timezone) VALUES ($1,'Other',$2,'PS','ILS','Asia/Hebron') RETURNING id`, [world.tenantId, `s7z2-${process.pid}`])).rows[0]?.id);
  M['W4_bare_business_change_sup_real'] = (await inCtx(sup, APP_CTX(), [
    { sql: `UPDATE installment_plans SET business_id = $2 WHERE id=$1`, params: [bare, otherBiz] },
  ])).error;

  writeFileSync('/tmp/claude-0/s7r11-w.json', JSON.stringify(M, null, 2));
}, 1800000);

afterAll(async () => {
  await Promise.all([sup?.end(), mig?.end(), app?.end()].map((p) => (p ?? Promise.resolve()).catch(() => undefined)));
  await db?.drop().catch(() => undefined);
});

describe('W PROBE', () => { it('records', () => { expect(M['specError']).toBeNull(); }); });
