/**
 * P4-S7 — THE INVOICE-BORNE FACT, MEASURED (`TL-P4-COORD-R38` direction (d)).
 *
 * This suite exists because the SAME defect was shipped three times and the
 * third time it was inside the routine written to prevent it. Challenger C1.a:
 * `customer_ar_aging`'s no-plan arm was keyed on `NOT EXISTS` over
 * `installment_plans` read through the CALLER's row security, and under row
 * security ABSENT and INVISIBLE are one answer — so a caller who could see an
 * invoice and not its plan was served the whole outstanding at the single
 * invoice due date, silently.
 *
 * `TL-P4-COORD-R38` retired the whole family of repairs that answer «can I see
 * the plans?» from inside the reader: A READER CANNOT CERTIFY ITS OWN
 * VISIBILITY. The repair carries the fact on the invoice row instead
 * (specification §2c, §3a, §6a).
 *
 * ── WHY THIS SUITE AND NOT THE LIVE ONE ─────────────────────────────────
 *
 * `phase4-s7-installment-aging-live.test.ts` applies the specification to the
 * shared `daftar` database — which is round-7 F5, is NOT this round's subject,
 * and which I am forbidden to do. Everything here runs in a SCRATCH database
 * built from the real migrations by the real runner and applied as
 * `daftar_migrator`, and every row-security reading is taken AS THE ROLE THE
 * POLICY NAMES. The scratch database is dropped afterwards.
 *
 * ── THE TWO DISCLOSED FIXTURE DEPARTURES ────────────────────────────────
 *
 * 1. `invoices_binding_fk` and `sales_binding_fk` are DROPPED, and the USER
 *    triggers on `sales` are disabled for the length of the seeding
 *    transaction. A real accounting binding needs a journal entry and the
 *    whole posting path; the subject here is row security and a denormalised
 *    flag, and neither is the binding. Every other constraint on `invoices`
 *    stays, every policy on every relation stays, and every trigger on
 *    `invoices` and on the two P4-S7 relations stays — including the ones
 *    this repair adds, which §C and §D then exercise.
 * 2. `GRANT EXECUTE ON supplier_ap_release` TO `daftar_app` is PRE-APPLIED.
 *    That grant is patch request PR-6 and is a declared blocker expected to
 *    land; without it `daftar_app` cannot reach the schedule arms at all, and
 *    the round-7 challenger had to leave «arm (c) then serves the pre-S7
 *    number» as a seam it could not measure end to end. Pre-applying PR-6 is
 *    what CLOSES that seam here: §E measures the defect reproduced and then
 *    closed, in one database, on one fixture.
 *
 * ── BOTH DIRECTIONS, EVERYWHERE ─────────────────────────────────────────
 *
 * A suite that only asserts refusals cannot tell a working guard from one that
 * refuses everything. Every refusal below is paired with a control that
 * COMMITS or ANSWERS, and §E restores each attacked policy and re-reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb, urlOf } from '../helpers/scratch-db';

const DB = 'daftar_s7f1_fact';
const SPEC_PATH = join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');
const SPEC = readFileSync(SPEC_PATH, 'utf8');
const SHA = 'a'.repeat(64);
const STAMP = '2026-01-02T00:00:00Z';
const BUCKETS = [30, 60, 90];
const TOTAL = 900000n;

interface Outcome {
  readonly error: string | null;
  readonly rows: readonly Record<string, unknown>[];
}
interface AgingRow {
  readonly bucket_no: number;
  readonly currency_code: string;
  readonly txn_minor: string;
  readonly base_minor: string;
  readonly invoice_count: number;
}

let db: ScratchDb;
let sup: Pool;
let mig: Pool;
let app: Pool;
/** The parser's verdict on the whole specification. `null` means it created. */
let specError: string | null = null;
let world: {
  tenantId: string;
  otherTenantId: string;
  businessId: string;
  customerId: string;
  invoiceId: string;
  saleId2: string;
  userId: string;
};
/** Every labelled measurement, written to disk so a swallowed console.log cannot produce a green run with no data. */
const M: Record<string, unknown> = {};

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run one statement as a role, inside a transaction carrying the app context. */
async function inCtx(pool: Pool, ctx: Record<string, string>, work: readonly { sql: string; params?: readonly unknown[] }[]): Promise<Outcome> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(ctx)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    let rows: readonly Record<string, unknown>[] = [];
    for (const w of work) rows = (await c.query(w.sql, [...(w.params ?? [])])).rows as readonly Record<string, unknown>[];
    await c.query('COMMIT');
    return { error: null, rows };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    return { error: err(e), rows: [] };
  } finally {
    c.release();
  }
}

const APP_CTX = (): Record<string, string> => ({ 'app.tenant_id': world.tenantId, 'app.business_id': world.businessId });

/** The aging, as a role, with the context. */
async function aging(pool: Pool, ctx: Record<string, string>): Promise<Outcome> {
  return inCtx(pool, ctx, [
    {
      sql: `SELECT * FROM public.customer_ar_aging($1,$2,$3::DATE,$4::INTEGER[]) ORDER BY bucket_no`,
      params: [world.businessId, world.customerId, '2026-06-30', BUCKETS],
    },
  ]);
}

/** How many plans this role can read for the fixture invoice. */
async function visiblePlans(pool: Pool, ctx: Record<string, string>): Promise<Outcome> {
  return inCtx(pool, ctx, [{ sql: `SELECT count(*)::text AS n FROM public.installment_plans WHERE invoice_id = $1`, params: [world.invoiceId] }]);
}

/** Write a plan and a two-row schedule in ONE transaction and try to commit. */
async function commitPlan(ctx: Record<string, string>, o: { planId?: string; status?: string; tenantId?: string } = {}): Promise<Outcome & { planId: string }> {
  const planId = o.planId ?? randomUUID();
  const r = await inCtx(mig, ctx, [
    {
      sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
            VALUES ($1,$2,$3,$4,$5,$6,100000,'2026-01-02'::DATE,$7,gen_random_uuid())`,
      params: [o.tenantId ?? world.tenantId, world.businessId, planId, world.invoiceId, world.customerId, o.status ?? 'active', world.userId],
    },
    {
      sql: `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
            VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-02-02'::DATE,400000),
                   ($1,$2,gen_random_uuid(),$3,2,'2026-06-02'::DATE,400000)`,
      params: [world.tenantId, world.businessId, planId],
    },
  ]);
  return { ...r, planId };
}

async function flag(): Promise<string> {
  const r = await inCtx(sup, {}, [{ sql: `SELECT has_active_installment_plan::text AS f FROM invoices WHERE id = $1`, params: [world.invoiceId] }]);
  return String(r.rows[0]?.['f'] ?? 'MISSING');
}

/** DDL as the owner of the two relations, which `migratorOwned` makes `daftar_migrator`. */
async function ddl(sql: string): Promise<string | null> {
  try {
    await mig.query(sql);
    return null;
  } catch (e) {
    return err(e);
  }
}

beforeAll(async () => {
  db = await createScratchDb(DB, { migratorOwned: true });
  sup = new Pool({ connectionString: urlOf(DB, 'postgres'), max: 3 });
  mig = new Pool({ connectionString: urlOf(DB, 'daftar_migrator'), max: 3 });
  app = new Pool({ connectionString: urlOf(DB, 'daftar_app'), max: 3 });
  M['applied'] = db.applied.length;
  M['head'] = db.applied[db.applied.length - 1];

  // ── THE WORLD. Built as the superuser, because it is a WORLD and not
  //    evidence; every measurement below is taken as the role the policy names.
  const c = await sup.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_binding_fk');
    await c.query('ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_binding_fk');
    await c.query('ALTER TABLE sales DISABLE TRIGGER USER');
    const one = async (sql: string, p: readonly unknown[] = []): Promise<string> => String((await c.query<{ id: string }>(sql, [...p])).rows[0]?.id);
    const tenantId = await one('INSERT INTO tenants DEFAULT VALUES RETURNING id');
    const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','S7 F1') RETURNING id`, [
      `s7f1-${process.pid}@test.daftar.local`,
    ]);
    const businessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1,'F1 Books',$2,'PS','ILS','Asia/Hebron') RETURNING id`,
      [tenantId, `s7f1-${process.pid}`],
    );
    const branchId = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1,'Main',true) RETURNING id`, [businessId]);
    const warehouseId = await one(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1,$2,'WH',true) RETURNING id`, [
      businessId,
      branchId,
    ]);
    const customerId = randomUUID();
    await c.query(
      `INSERT INTO customers (tenant_id,business_id,id,name,status,revision,create_intent_sha256,last_intent_sha256,business_transaction_id,created_by,updated_by)
       VALUES ($1,$2,$3,'F1 Customer','active',1,$4,$4,gen_random_uuid(),$5,$5)`,
      [tenantId, businessId, customerId, SHA, userId],
    );
    const saleId = randomUUID();
    await c.query(
      `INSERT INTO sales (tenant_id,business_id,id,customer_id,branch_id,warehouse_id,status,settlement_mode,document_date,currency_code,
                          subtotal_txn_minor,discount_txn_minor,total_txn_minor,total_base_minor,source_to_base_rate,rate_source,rate_timestamp,
                          customer_name_snapshot,commit_intent_sha256,confirmed_by,confirmed_at,business_transaction_id,created_by,binding_source_id)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed','credit','2026-01-02','ILS',900000,0,900000,900000,1,'base',$7::timestamptz,'F1 Customer',$8,$9,$7::timestamptz,gen_random_uuid(),$9,$3)`,
      [tenantId, businessId, saleId, customerId, branchId, warehouseId, STAMP, SHA, userId],
    );
    // A SECOND SALE, so §D5 can insert a second invoice at all:
    // `invoices_sale_uq` is UNIQUE (business_id, sale_id, document_kind) and
    // `invoices_sale_fk` requires the sale to exist.
    const saleId2 = randomUUID();
    await c.query(
      `INSERT INTO sales (tenant_id,business_id,id,customer_id,branch_id,warehouse_id,status,settlement_mode,document_date,currency_code,
                          subtotal_txn_minor,discount_txn_minor,total_txn_minor,total_base_minor,source_to_base_rate,rate_source,rate_timestamp,
                          customer_name_snapshot,commit_intent_sha256,confirmed_by,confirmed_at,business_transaction_id,created_by,binding_source_id)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed','credit','2026-01-02','ILS',900000,0,900000,900000,1,'base',$7::timestamptz,'F1 Customer',$8,$9,$7::timestamptz,gen_random_uuid(),$9,$3)`,
      [tenantId, businessId, saleId2, customerId, branchId, warehouseId, STAMP, SHA, userId],
    );
    // A SECOND TENANT, so §C7 can build the one state that actually reaches
    // the sync trigger's ROW_COUNT refusal.
    const otherTenantId = await one('INSERT INTO tenants DEFAULT VALUES RETURNING id');
    const invoiceId = randomUUID();
    await c.query(
      `INSERT INTO invoices (tenant_id,business_id,id,sale_id,customer_id,branch_id,document_kind,document_number,number_seq,period,issue_date,due_date,
                             currency_code,status,subtotal_txn_minor,discount_txn_minor,tax_minor,total_txn_minor,total_base_minor,source_to_base_rate,
                             rate_source,rate_timestamp,customer_name_snapshot,issue_intent_sha256,business_transaction_id,created_by,binding_source_id)
       VALUES ($1,$2,$3,$4,$5,$6,'invoice','INV-1',1,'2026','2026-01-02','2026-01-02','ILS','open',900000,0,0,900000,900000,1,'base',$7::timestamptz,
               'F1 Customer',$8,gen_random_uuid(),$9,$3)`,
      [tenantId, businessId, invoiceId, saleId, customerId, branchId, STAMP, SHA, userId],
    );
    // PR-6, PRE-APPLIED AND DISCLOSED. Without it `daftar_app` cannot reach the
    // schedule arms and the end-to-end step cannot be measured at all.
    await c.query(`GRANT EXECUTE ON FUNCTION public.supplier_ap_release(BIGINT,BIGINT,BIGINT,BIGINT) TO daftar_app`);
    await c.query('COMMIT');
    // RE-ENABLED OUTSIDE the transaction: `ALTER TABLE` refuses while the
    // transaction holds pending deferred trigger events, which the inserts
    // above create.
    await c.query('ALTER TABLE sales ENABLE TRIGGER USER');
    world = { tenantId, otherTenantId, businessId, customerId, invoiceId, saleId2, userId };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw new Error(`the fixture world did not build: ${err(e)}`);
  } finally {
    c.release();
  }
  M['world'] = world;

  // ── §A THE PARSER'S OPINION, as `daftar_migrator`.
  try {
    await mig.query(SPEC);
  } catch (e) {
    specError = err(e);
  }
  M['specError'] = specError;
  if (specError !== null) {
    writeFileSync('/tmp/claude-0/s7f1-fact.json', JSON.stringify(M, null, 2));
    return;
  }

  // ── §B THE FIXTURE DISCRIMINATES, and the base case of the induction.
  M['B_flag_after_apply'] = await flag();
  M['B_app_sees_invoice'] = await inCtx(app, APP_CTX(), [{ sql: `SELECT count(*)::text AS n FROM public.invoices WHERE id = $1`, params: [world.invoiceId] }]);
  M['B_aging_no_plan'] = await aging(app, APP_CTX());

  // ── §C THE INDUCTIVE STEP, in both directions.
  const planned = await commitPlan(APP_CTX());
  M['C1_plan_commits'] = { error: planned.error };
  M['C1_flag_after'] = await flag();
  M['C2_aging_with_plan'] = await aging(app, APP_CTX());
  M['C2_app_sees_plan'] = await visiblePlans(app, APP_CTX());

  // ── §E THE THREE ROUND-7 ATTACKS, RE-RUN AGAINST THE REPAIR.
  //    Each one blinds `daftar_app` to `installment_plans` without touching
  //    `public.invoices`, which is precisely the symmetry the three attacks had
  //    to break. The OLD reader is installed first so the defect is REPRODUCED
  //    in this database before it is shown closed.
  const NEW_BODY = (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure) AS d`))
    .rows[0]?.d as string;
  // The counterfactual: the pre-repair arm (c), and nothing else changed.
  const OLD_BODY = NEW_BODY.replace(
    /FROM open_invoice oi\n\s*WHERE NOT oi\.flagged/,
    'FROM open_invoice oi\n     WHERE NOT EXISTS (SELECT 1 FROM active_plan ap WHERE ap.invoice_id = oi.invoice_id)',
  ).replace(/CROSS JOIN \(SELECT public\.installment_plan_fact_assert\([\s\S]*?FROM fact f\) g\n\s*WHERE g\.ok/, 'WHERE true');
  M['E_counterfactual_rewrote'] = OLD_BODY !== NEW_BODY && !OLD_BODY.includes('installment_plan_fact_assert') && OLD_BODY.includes('NOT EXISTS');

  const ATTACKS: readonly { label: string; mutate: readonly string[]; restore: readonly string[] }[] = [
    {
      label: 'A1 business_isolation_delete re-created AS RESTRICTIVE FOR SELECT USING (false)',
      mutate: [
        `DROP POLICY business_isolation_delete ON installment_plans`,
        `CREATE POLICY business_isolation_delete ON installment_plans AS RESTRICTIVE FOR SELECT USING (false)`,
      ],
      restore: [
        `DROP POLICY business_isolation_delete ON installment_plans`,
        `CREATE POLICY business_isolation_delete ON installment_plans AS RESTRICTIVE FOR DELETE USING (app_bypass() OR business_id = nullif(app_business(), '')::uuid)`,
      ],
    },
    {
      label: 'A2 tenant_membership re-created with identical text but FOR ALL TO daftar_platform',
      mutate: [
        `DROP POLICY tenant_membership ON installment_plans`,
        `CREATE POLICY tenant_membership ON installment_plans FOR ALL TO daftar_platform
           USING (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
           WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`,
      ],
      restore: [
        `DROP POLICY tenant_membership ON installment_plans`,
        `CREATE POLICY tenant_membership ON installment_plans
           USING (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
           WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`,
      ],
    },
    {
      label: 'B3 tenant_membership re-created carrying every token the retired check looked for plus one extra conjunct',
      mutate: [
        `DROP POLICY tenant_membership ON installment_plans`,
        `CREATE POLICY tenant_membership ON installment_plans
           USING ((app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid) AND created_at > now())
           WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`,
      ],
      restore: [
        `DROP POLICY tenant_membership ON installment_plans`,
        `CREATE POLICY tenant_membership ON installment_plans
           USING (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
           WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`,
      ],
    },
  ];

  const attackLog: unknown[] = [];
  for (const a of ATTACKS) {
    const ddlErrors: (string | null)[] = [];
    for (const sql of a.mutate) ddlErrors.push(await ddl(sql));
    const seen = await visiblePlans(app, APP_CTX());
    // the OLD reader, in this database, on this blinded caller
    const oldInstall = await ddl(OLD_BODY);
    const oldRead = await aging(app, APP_CTX());
    // and the shipped reader
    const newInstall = await ddl(NEW_BODY);
    const newRead = await aging(app, APP_CTX());
    const restoreErrors: (string | null)[] = [];
    for (const sql of a.restore) restoreErrors.push(await ddl(sql));
    const restored = await aging(app, APP_CTX());
    const restoredSeen = await visiblePlans(app, APP_CTX());
    attackLog.push({
      label: a.label,
      ddlErrors,
      plansVisibleWhileBlinded: seen.rows[0]?.['n'] ?? seen.error,
      oldInstall,
      oldReaderServed: oldRead,
      newInstall,
      newReaderRefused: newRead.error,
      restoreErrors,
      restoredReader: restored,
      restoredPlansVisible: restoredSeen.rows[0]?.['n'] ?? restoredSeen.error,
    });
  }
  M['E_attacks'] = attackLog;

  // ── §E4 THE SCHEDULE RELATION ALONE. plan readable, `installments` not.
  await ddl(`DROP POLICY business_isolation_read ON installments`);
  await ddl(`CREATE POLICY business_isolation_read ON installments AS RESTRICTIVE FOR SELECT USING (false)`);
  M['E4_schedule_hidden'] = await aging(app, APP_CTX());
  await ddl(`DROP POLICY business_isolation_read ON installments`);
  await ddl(
    `CREATE POLICY business_isolation_read ON installments AS RESTRICTIVE FOR SELECT
       USING (app_bypass() OR current_user IN ('daftar_inventory_internal','daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid)`,
  );
  M['E4_restored'] = await aging(app, APP_CTX());

  // ── §E5 THE MEASURED NEGATIVE THE DIRECTION RESTS ON: unset context blinds
  //    the caller to `invoices` BY THE SAME POLICIES, so there is nothing to
  //    serve and nothing to refuse.
  M['E5_no_context'] = await aging(app, {});
  M['E5_no_context_invoices'] = await inCtx(app, {}, [{ sql: `SELECT count(*)::text AS n FROM public.invoices WHERE id = $1`, params: [world.invoiceId] }]);

  // ── §C4/§C5 THE LIFECYCLE. completion and deletion both clear the column.
  M['C4_complete'] = (
    await inCtx(mig, APP_CTX(), [{ sql: `UPDATE installment_plans SET status = 'completed' WHERE id = $1`, params: [planned.planId] }])
  ).error;
  M['C4_flag'] = await flag();
  M['C4_aging'] = await aging(app, APP_CTX());
  M['C5_reactivate'] = (await inCtx(mig, APP_CTX(), [{ sql: `UPDATE installment_plans SET status = 'active' WHERE id = $1`, params: [planned.planId] }])).error;
  M['C5_flag'] = await flag();
  const del = await inCtx(mig, APP_CTX(), [
    { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [planned.planId] },
    { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [planned.planId] },
  ]);
  M['C6_delete'] = del.error;
  M['C6_flag'] = await flag();
  M['C6_aging'] = await aging(app, APP_CTX());

  // ── §D THE COMMIT-TIME REFUSAL, both directions.
  //    D1: the sync trigger disabled, so the column is never written.
  await ddl(`ALTER TABLE installment_plans DISABLE TRIGGER installment_plans_fact_sync`);
  const d1 = await commitPlan(APP_CTX(), { planId: randomUUID() });
  M['D1_desync_refused'] = d1.error;
  await ddl(`ALTER TABLE installment_plans ENABLE TRIGGER installment_plans_fact_sync`);
  // the control: the SAME write, with the trigger back
  const d2 = await commitPlan(APP_CTX(), { planId: randomUUID() });
  M['D2_control_commits'] = d2.error;
  M['D2_flag'] = await flag();
  if (d2.error === null) {
    // ONE TRANSACTION, and that is the verifier's design rather than a fixture
    // quirk: deleting the schedule alone drops its sum to zero against a live
    // invoice total, which section 3 obligation (a) refuses at COMMIT — my
    // first attempt did it in two transactions and was correctly refused with
    // `installment.schedule_incomplete`, which then left this plan active and
    // made §C7 collide with the one-active-plan index.
    M['D2_cleanup'] = (
      await inCtx(mig, APP_CTX(), [
        { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [d2.planId] },
        { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [d2.planId] },
      ])
    ).error;
    M['D2_cleanup_flag'] = await flag();
  }

  //    D3: the column written DIRECTLY to a value the plan relation does not support.
  M['D3_direct_write_refused'] = (
    await inCtx(sup, APP_CTX(), [
      { sql: `UPDATE invoices SET has_active_installment_plan = NOT has_active_installment_plan WHERE id = $1`, params: [world.invoiceId] },
    ])
  ).error;
  //    D4: the control — writing it to the value the plan relation DOES support.
  M['D4_direct_write_correct_commits'] = (
    await inCtx(sup, APP_CTX(), [
      {
        sql: `UPDATE invoices SET has_active_installment_plan = EXISTS (SELECT 1 FROM installment_plans p WHERE p.business_id = invoices.business_id AND p.invoice_id = invoices.id AND p.status = 'active') WHERE id = $1`,
        params: [world.invoiceId],
      },
    ])
  ).error;
  //    D5: an invoice BORN carrying the fact — the table-level GRANT INSERT route.
  const bornId = randomUUID();
  const BORN = (flagged: boolean): { sql: string; params: readonly unknown[] } => ({
    // `invoices_binding_identity_ck` demands `binding_source_id = id`, so the
    // id is generated here and used for both — my first attempt passed two
    // different `gen_random_uuid()` calls and was refused by that CHECK rather
    // than by the trigger under test.
    sql: `INSERT INTO invoices (tenant_id,business_id,id,sale_id,customer_id,branch_id,document_kind,document_number,number_seq,period,issue_date,due_date,
             currency_code,status,subtotal_txn_minor,discount_txn_minor,tax_minor,total_txn_minor,total_base_minor,source_to_base_rate,rate_source,
             rate_timestamp,customer_name_snapshot,issue_intent_sha256,business_transaction_id,created_by,binding_source_id,has_active_installment_plan)
          SELECT i.tenant_id,i.business_id,$2,$3,i.customer_id,i.branch_id,'invoice',$4,99,'2026',
                 i.issue_date,i.due_date,i.currency_code,'open',i.subtotal_txn_minor,0,0,i.total_txn_minor,i.total_base_minor,
                 i.source_to_base_rate,i.rate_source,i.rate_timestamp,i.customer_name_snapshot,i.issue_intent_sha256,gen_random_uuid(),
                 i.created_by,$2,$5
            FROM invoices i WHERE i.id = $1`,
    params: [world.invoiceId, flagged ? bornId : randomUUID(), world.saleId2, flagged ? 'INV-BORN-T' : 'INV-BORN-F', flagged],
  });
  M['D5_insert_born_flagged_refused'] = (await inCtx(sup, APP_CTX(), [BORN(true)])).error;
  //    AND THE CONTROL: the same INSERT, born carrying `false`, COMMITS. A law
  //    that refused every insert of an invoice would look identical without it.
  M['D5_control_born_false_commits'] = (await inCtx(sup, APP_CTX(), [BORN(false)])).error;

  // ── §C7 THE WRITE SIDE'S OWN SYMMETRY, and a CORRECTION OF MY OWN CLAIM.
  //
  //    I expected a context-less plan write to be refused by the sync
  //    trigger's ROW_COUNT check. IT IS NOT, and the measurement said so:
  //    `installment_plans`' own `business_isolation_insert` / `tenant_membership`
  //    WITH CHECK refuse it FIRST, upstream of any trigger of mine. So the
  //    context-less case never reaches the fact at all — recorded here as the
  //    upstream refusal it is.
  M['C7_no_context_write'] = (await commitPlan({})).error;
  //    THE STATE THAT DOES REACH IT is the one `installment_plans_invoice_fk`
  //    cannot pin: the key is (business_id, invoice_id) and carries NO
  //    `tenant_id`, so a plan may be inserted with a tenant of its own that
  //    differs from its invoice's. The plan's own policies accept it; the
  //    INVOICE's `tenant_membership` then refuses the flag write, the
  //    recomputation lands on zero rows, and the ROW_COUNT check turns that
  //    into a refusal instead of a silent no-op. This is the cross-tenant plan
  //    being refused BY the fact's maintenance.
  M['C7_cross_tenant_write'] = (
    await commitPlan({ 'app.tenant_id': world.otherTenantId, 'app.business_id': world.businessId }, { tenantId: world.otherTenantId })
  ).error;

  // ── §G THE SHAPE OF THE RESULT, from the catalogue.
  M['G_catalogue'] = (
    await mig.query(
      `SELECT (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname='public' AND p.proname='installment_plan_visibility_assert') AS retired_guard,
              (SELECT count(*)::text FROM pg_attribute a WHERE a.attrelid='public.invoices'::regclass
                AND a.attname='has_active_installment_plan' AND NOT a.attisdropped) AS column_present,
              has_column_privilege('daftar_accounting_internal','public.invoices','has_active_installment_plan','UPDATE') AS internal_writes,
              has_column_privilege('daftar_app','public.invoices','has_active_installment_plan','UPDATE') AS app_writes,
              has_column_privilege('daftar_app','public.invoices','has_active_installment_plan','SELECT') AS app_reads,
              has_table_privilege('daftar_accounting_internal','public.invoices','UPDATE') AS internal_table_update,
              (SELECT count(*)::text FROM pg_trigger t WHERE NOT t.tgisinternal
                AND t.tgfoid='public.installment_plan_fact_verify()'::regprocedure) AS verify_triggers,
              (SELECT count(*)::text FROM pg_trigger t WHERE NOT t.tgisinternal
                AND t.tgfoid='public.installment_plan_fact_sync()'::regprocedure) AS sync_triggers,
              (SELECT p.proargtypes::text FROM pg_proc p
                WHERE p.oid='public.installment_plan_fact_assert(bigint,bigint,bigint)'::regprocedure) AS assert_argtypes,
              (SELECT NOT p.prosecdef FROM pg_proc p
                WHERE p.oid='public.installment_plan_fact_assert(bigint,bigint,bigint)'::regprocedure) AS assert_is_invoker`,
    )
  ).rows[0] as Record<string, unknown>;

  writeFileSync('/tmp/claude-0/s7f1-fact.json', JSON.stringify(M, null, 2));
}, 1800000);

afterAll(async () => {
  await Promise.all([sup?.end(), mig?.end(), app?.end()].map((p) => (p ?? Promise.resolve()).catch(() => undefined)));
  await db?.drop().catch(() => undefined);
});

/**
 * `Outcome.rows` is `Record<string, unknown>[]` because every statement in this
 * file goes through one runner. Narrowing it to `AgingRow` needs the `unknown`
 * hop: a direct `as` is `TS2352` — which `vitest` transpiled away and ran GREEN
 * on, and only `tsc --noEmit` reported. A green suite is not a typecheck.
 */
const asAging = (rs: readonly Record<string, unknown>[]): readonly AgingRow[] => rs as unknown as readonly AgingRow[];
const rows = (o: unknown): readonly AgingRow[] => asAging((o as Outcome | undefined)?.rows ?? []);
const errOf = (o: unknown): string => String((o as Outcome | undefined)?.error ?? '');
const sum = (rs: readonly AgingRow[]): bigint => rs.reduce((a, r) => a + BigInt(r.txn_minor), 0n);

describe('P4-S7 §A the specification applies', () => {
  it('the fixture proves itself before anything is concluded from it', () => {
    expect(M['applied'] as number, 'the scratch database did not get the whole migration history').toBeGreaterThan(80);
    expect(M['world'], 'the fixture world did not build').toBeTruthy();
  });

  it('the whole specification creates, applied as daftar_migrator', () => {
    expect(specError, `the specification did not apply: ${specError ?? ''}`).toBeNull();
  });
});

describe('P4-S7 §B the base case of the induction', () => {
  it('the column is false for an invoice that existed before the plan relation did', () => {
    expect(M['B_flag_after_apply']).toBe('false');
  });

  it('and the caller that will be blinded can see its invoice to begin with', () => {
    expect(rows(M['B_app_sees_invoice'])[0]).toEqual({ n: '1' });
  });

  it('a no-plan invoice is aged at its own due date, exactly as before this slice', () => {
    const r = rows(M['B_aging_no_plan']);
    expect(errOf(M['B_aging_no_plan'])).toBe('');
    expect(r).toHaveLength(1);
    expect(sum(r)).toBe(TOTAL);
  });
});

describe('P4-S7 §C the inductive step, both directions', () => {
  it('a plan and its schedule commit, and the invoice row carries the fact', () => {
    expect((M['C1_plan_commits'] as Outcome).error).toBeNull();
    expect(M['C1_flag_after']).toBe('true');
  });

  it('and the aging then spreads the figure ACROSS the schedule instead of one band', () => {
    const r = rows(M['C2_aging_with_plan']);
    expect(errOf(M['C2_aging_with_plan'])).toBe('');
    // THE FIXTURE DISCRIMINATES: one band without a plan, SEVERAL with one, and
    // the authoritative total is unchanged either way (proofs 1 and 4).
    expect(r.length).toBeGreaterThan(1);
    expect(sum(r)).toBe(TOTAL);
    expect(rows(M['C2_app_sees_plan'])[0]).toEqual({ n: '1' });
  });

  it('completing the plan clears the column and returns the invoice to the single-band reading', () => {
    expect(M['C4_complete']).toBeNull();
    expect(M['C4_flag']).toBe('false');
    expect(rows(M['C4_aging'])).toHaveLength(1);
    expect(sum(rows(M['C4_aging']))).toBe(TOTAL);
  });

  it('re-activating it sets the column again, and deleting the plan clears it', () => {
    expect(M['C5_reactivate']).toBeNull();
    expect(M['C5_flag']).toBe('true');
    expect(M['C6_delete']).toBeNull();
    expect(M['C6_flag']).toBe('false');
    expect(rows(M['C6_aging'])).toHaveLength(1);
  });

  it("a plan written with no session context is refused UPSTREAM of the fact, by the plan relation's own WITH CHECK", () => {
    // A CORRECTION OF MY OWN EXPECTATION, recorded rather than quietly fixed.
    // I wrote this law expecting `installment.plan_fact_unwritable`. The
    // measurement said `new row violates row-level security policy for table
    // "installment_plans"` — the plan's own insert policies refuse first, and
    // the sync trigger is never reached. The context-less case is therefore
    // closed, but NOT by this repair, and a law that claimed otherwise would
    // have credited the wrong mechanism.
    expect(String(M['C7_no_context_write'])).toContain('row-level security policy for table "installment_plans"');
    expect(String(M['C7_no_context_write'])).not.toContain('installment.plan_fact_unwritable');
  });

  it("and the CROSS-TENANT plan — the one state the invoice foreign key cannot pin — is refused BY the fact's maintenance", () => {
    // `installment_plans_invoice_fk` is (business_id, invoice_id) and carries
    // no `tenant_id`, so a plan with a tenant of its own satisfies the plan's
    // policies and not the INVOICE's. The recomputation then lands on zero
    // rows and the ROW_COUNT check turns that into a refusal rather than a
    // silent no-op — which is why that check is the refusal and not noise.
    expect(String(M['C7_cross_tenant_write'])).toContain('installment.plan_fact_unwritable');
  });
});

describe('P4-S7 §D the fact is REFUSED at COMMIT when it disagrees', () => {
  it('with the sync trigger disabled the plan write is refused at COMMIT, by name', () => {
    expect(String(M['D1_desync_refused'])).toContain('installment.plan_fact_desynchronised');
  });

  it('and the SAME write commits with the trigger back — so the law is not refusing everything', () => {
    expect(M['D2_control_commits']).toBeNull();
    expect(M['D2_flag']).toBe('true');
    // and removing the plan again clears the column, in ONE transaction
    expect(M['D2_cleanup']).toBeNull();
    expect(M['D2_cleanup_flag']).toBe('false');
  });

  it('writing the column directly to a value the plan relation does not support is refused, by name', () => {
    expect(String(M['D3_direct_write_refused'])).toContain('installment.plan_fact_desynchronised');
  });

  it('and writing it to the value the plan relation DOES support commits', () => {
    expect(M['D4_direct_write_correct_commits']).toBeNull();
  });

  it('an invoice BORN carrying the fact is refused — the table-level GRANT INSERT route', () => {
    expect(String(M['D5_insert_born_flagged_refused'])).toContain('installment.plan_fact_desynchronised');
  });

  it('and the same INSERT born carrying false COMMITS, so the INSERT arm is not refusing every invoice', () => {
    expect(M['D5_control_born_false_commits']).toBeNull();
  });
});

describe('P4-S7 §E the three round-7 attacks, reproduced and then closed', () => {
  it('the counterfactual really is the pre-repair arm (c) and nothing else', () => {
    expect(M['E_counterfactual_rewrote'], 'the old-reader rewrite did not take, so §E measures nothing').toBe(true);
  });

  it.each([0, 1, 2])('attack %i blinds the caller to the plans while leaving its invoice visible', (i) => {
    const a = (M['E_attacks'] as Record<string, unknown>[])[i] as Record<string, unknown>;
    expect(a['ddlErrors'], `${String(a['label'])}: the mutation itself failed`).toEqual([null, null]);
    expect(a['plansVisibleWhileBlinded'], `${String(a['label'])}: the caller was not blinded, so nothing is being measured`).toBe('0');
  });

  it.each([0, 1, 2])('attack %i: the PRE-REPAIR reader served the whole outstanding at the single due date', (i) => {
    const a = (M['E_attacks'] as Record<string, unknown>[])[i] as Record<string, unknown>;
    expect(a['oldInstall'], 'the counterfactual reader did not install').toBeNull();
    const served = a['oldReaderServed'] as Outcome;
    // THE DEFECT, REPRODUCED END TO END — the step round 7 could only state.
    expect(served.error, `${String(a['label'])}: the old reader did not answer, so the defect is not reproduced`).toBeNull();
    expect(sum(asAging(served.rows))).toBe(TOTAL);
    expect(served.rows, 'the pre-S7 shape is ONE band at the invoice due date').toHaveLength(1);
  });

  it.each([0, 1, 2])('attack %i: the SHIPPED reader refuses, and names the reading that disagreed', (i) => {
    const a = (M['E_attacks'] as Record<string, unknown>[])[i] as Record<string, unknown>;
    expect(a['newInstall'], 'the shipped reader did not install').toBeNull();
    expect(String(a['newReaderRefused']), `${String(a['label'])}: the shipped reader did not refuse`).toContain('installment.plan_fact_unreadable');
  });

  it.each([0, 1, 2])('attack %i: restoring the policy restores the ANSWER — both directions on one fixture', (i) => {
    const a = (M['E_attacks'] as Record<string, unknown>[])[i] as Record<string, unknown>;
    expect(a['restoreErrors'], 'the restore itself failed, so the discrimination is unproven').toEqual([null, null]);
    expect(a['restoredPlansVisible']).toBe('1');
    const r = a['restoredReader'] as Outcome;
    expect(r.error, `${String(a['label'])}: the reader did not recover`).toBeNull();
    expect(asAging(r.rows).length).toBeGreaterThan(1);
    expect(sum(asAging(r.rows))).toBe(TOTAL);
  });

  it('hiding only the SCHEDULE relation is refused by its own name, and the restore answers again', () => {
    expect(errOf(M['E4_schedule_hidden'])).toContain('installment.plan_schedule_unreadable');
    expect(errOf(M['E4_restored'])).toBe('');
    expect(rows(M['E4_restored']).length).toBeGreaterThan(1);
  });

  it('MEASURED NEGATIVE: with no session context the caller is blind to its INVOICES too, so there is nothing to serve and nothing to refuse', () => {
    // This is the symmetry argument working, and it is the evidence direction
    // (d) rests on: the three attacks all had to break the symmetry between two
    // relations rather than break the context.
    expect(rows(M['E5_no_context_invoices'])[0]).toEqual({ n: '0' });
    expect(errOf(M['E5_no_context'])).toBe('');
    expect(rows(M['E5_no_context'])).toHaveLength(0);
  });
});

describe('P4-S7 §G the end state, from the catalogue', () => {
  it('the retired guard is GONE and the column is present', () => {
    const g = M['G_catalogue'] as Record<string, unknown>;
    expect(g['retired_guard']).toBe('0');
    expect(g['column_present']).toBe('1');
  });

  it('exactly one principal may write the column, column-level, and daftar_app may only read it', () => {
    const g = M['G_catalogue'] as Record<string, unknown>;
    expect(g['internal_writes']).toBe(true);
    expect(g['internal_table_update']).toBe(false);
    expect(g['app_writes']).toBe(false);
    expect(g['app_reads']).toBe(true);
  });

  it('three triggers hold the fact: one immediate writer, two deferred verifiers', () => {
    const g = M['G_catalogue'] as Record<string, unknown>;
    expect(g['sync_triggers']).toBe('1');
    expect(g['verify_triggers']).toBe('2');
  });

  it('and the read-time refusal can only ever be TOLD three numbers', () => {
    const g = M['G_catalogue'] as Record<string, unknown>;
    // `proargtypes` is an oidvector of three `bigint`s (oid 20). Three numbers
    // name no row, no business and no tenant, so the routine cannot be asked a
    // question about any of them — the structural replacement for round 6's
    // `pronargs = 0`.
    expect(g['assert_argtypes']).toBe('20 20 20');
    expect(g['assert_is_invoker']).toBe(true);
  });
});
