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
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb, urlOf } from '../helpers/scratch-db';
import {
  INSTALLMENT_INTERNAL_INVARIANT_CODES,
  isInstallmentInternalInvariant,
  parseDatabaseInstallmentInternalCode,
  parseDatabaseSellingCode,
} from '../../apps/api/src/modules/selling/selling-errors';

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

/**
 * THE TWO PRE-REPAIR WRITERS, QUOTED VERBATIM RATHER THAN DERIVED BY REGEX.
 *
 * A counterfactual produced by rewriting the shipped body with a regular
 * expression is only a counterfactual while the regex still matches, and a
 * regex that stops matching produces a measurement of the SHIPPED routine
 * labelled as a measurement of the old one. That happened to this file once
 * (`F1b_counterfactual_rewrote` is the check that caught it), so the two
 * pre-repair constructions are written out here, in full, and the only thing
 * asserted about them is that they DIFFER from the shipped body and carry (or
 * lack) the markers of their own round.
 *
 * `SYNC_R8` — round 8. The fact is decided by a recomputation over
 * `installment_plans` and there is no floor of any kind. Blinded, it writes
 * `false`.
 *
 * `SYNC_R9` — round 9, which is commit `d5e9035`, the construction this round
 * repairs. Same recomputation, same unconditional write, plus `v_asserted`:
 * a floor scoped to «the handed row asserts an ACTIVE plan on this invoice».
 * A write of a NON-ACTIVE plan row sets `v_asserted` to NULL, so the floor is
 * absent and the blindable recomputation still decides the value — which is
 * `TL-P4-COORD-R43` F1-c.
 */
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

/** The restrictive read policy as the specification ships it. */
const RESTORE_PLANS_READ_SQL = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
     USING (app_bypass() OR current_user IN ('daftar_inventory_internal','daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid)`;
/** Hidden from EVERYBODY, which is what §F1-b and §F1-c use. */
const BLIND_PLANS_SQL = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT USING (false)`;
/**
 * HIDDEN FROM THE WRITER AND FROM NOBODY ELSE — `TL-P4-COORD-R43` F1-c prime.
 * The shipped text with `AND current_user <> 'daftar_accounting_internal'`
 * folded in: `daftar_app` still reads every plan row, `daftar_migrator` still
 * reads them by `business_id`, and the one principal that cannot is the owner
 * of the two DEFINER trigger functions — the only principal whose blindness
 * round 9's floor could not detect.
 */
const BLIND_WRITER_ONLY_SQL = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
     USING (app_bypass()
            OR (current_user <> 'daftar_accounting_internal'
                AND (current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)))`;

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
  ).replace(/WHERE \(SELECT public\.installment_plan_fact_assert\([\s\S]*?FROM fact f\)\n/, 'WHERE true\n');
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

  // ── §F1-a PARTIAL SCHEDULE INVISIBILITY (`TL-P4-COORD-R41`, F1-a).
  //    §E4 above hides EVERY `installments` row, which the round-8 existence
  //    test already caught. This hides SOME of them — the challenger's
  //    `AND seq_no < 2` shape — which that test passed 0/0/0 while the reader
  //    served the pre-S7 figure in one coarse band.
  //
  //    THE COUNTERFACTUAL HERE IS THE ROUND-8 READER, NOT THE ROUND-7 ONE.
  //    `OLD_BODY` above removes arm (c)'s whole repair; that is the wrong
  //    control for this finding. `R8_BODY` changes exactly one thing: the
  //    arithmetic comparison goes back to the existence test it replaced, and
  //    nothing else in the body moves.
  const R8_BODY = NEW_BODY.replace(
    /AND \(s\.visible_rows = 0\n\s*OR s\.visible_total <> i\.declared_total\)/,
    'AND NOT EXISTS (SELECT 1 FROM public.installments n WHERE n.business_id = p_business_id AND n.plan_id = v.id)',
  );
  M['F1a_counterfactual_rewrote'] =
    R8_BODY !== NEW_BODY && !R8_BODY.includes('visible_total <>') && R8_BODY.includes('NOT EXISTS (SELECT 1 FROM public.installments');

  const RESTORE_INSTALLMENTS_READ = `CREATE POLICY business_isolation_read ON installments AS RESTRICTIVE FOR SELECT
       USING (app_bypass() OR current_user IN ('daftar_inventory_internal','daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid)`;

  //    BOTH HALVES OF THE SCHEDULE, SEPARATELY. The challenger disclosed that
  //    under the existence test hiding the OTHER instalment changed nothing
  //    either, so the harm was value-dependent. Both are measured here and
  //    both must refuse, which is the claim that the arithmetic test is
  //    COMPLETE rather than lucky.
  const PARTIALS: readonly { label: string; hide: string }[] = [
    { label: 'F1a-1 seq_no < 2 visible, so instalment 2 of 2 is hidden', hide: 'seq_no < 2' },
    { label: 'F1a-2 seq_no > 1 visible, so instalment 1 of 2 is hidden', hide: 'seq_no > 1' },
  ];
  const partialLog: unknown[] = [];
  for (const p of PARTIALS) {
    const ddlErrors: (string | null)[] = [];
    ddlErrors.push(await ddl(`DROP POLICY business_isolation_read ON installments`));
    ddlErrors.push(
      await ddl(`CREATE POLICY business_isolation_read ON installments AS RESTRICTIVE FOR SELECT
                   USING (app_bypass() OR current_user IN ('daftar_inventory_internal','daftar_accounting_internal')
                          OR (business_id = nullif(app_business(), '')::uuid AND ${p.hide}))`),
    );
    const rowsSeen = await inCtx(app, APP_CTX(), [
      { sql: `SELECT count(*)::text AS n, coalesce(sum(amount_txn_minor),0)::text AS s FROM public.installments WHERE plan_id = $1`, params: [planned.planId] },
    ]);
    const plansSeen = await visiblePlans(app, APP_CTX());
    const r8Install = await ddl(R8_BODY);
    const r8Read = await aging(app, APP_CTX());
    const newInstall = await ddl(NEW_BODY);
    const newRead = await aging(app, APP_CTX());
    const restoreErrors: (string | null)[] = [];
    restoreErrors.push(await ddl(`DROP POLICY business_isolation_read ON installments`));
    restoreErrors.push(await ddl(RESTORE_INSTALLMENTS_READ));
    const restored = await aging(app, APP_CTX());
    partialLog.push({
      label: p.label,
      ddlErrors,
      instalmentsVisible: rowsSeen.rows[0] ?? rowsSeen.error,
      plansVisible: plansSeen.rows[0]?.['n'] ?? plansSeen.error,
      flag: await flag(),
      r8Install,
      r8ReaderServed: r8Read,
      newInstall,
      newReaderRefused: newRead.error,
      restoreErrors,
      restoredReader: restored,
    });
  }
  M['F1a_partials'] = partialLog;

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

  // ── §F1-b THE FACT'S WRITER, BLINDED (`TL-P4-COORD-R41`, F1-b).
  //    `installment_plans` carries FORCE ROW LEVEL SECURITY, so a RESTRICTIVE
  //    `FOR SELECT USING (false)` blinds the sync's own SECURITY DEFINER read
  //    as well as every caller's. Before the repair the sync wrote `false`,
  //    the plan COMMITTED, and restoring the policy did not restore the flag.
  //
  //    DISCLOSED FIXTURE DEPARTURE: the pre-repair sync is installed AS THE
  //    SUPERUSER. The function's owner is `daftar_accounting_internal`, a
  //    NOLOGIN role, so `daftar_migrator` cannot replace it; §D's trigger
  //    disabling is not a substitute because this measurement needs the
  //    trigger to RUN and to decide wrongly. Only the one `CREATE OR REPLACE`
  //    uses `sup`; every reading below is taken as the role the policy names.
  const SYNC_NEW = (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.installment_plan_fact_sync()'::regprocedure) AS d`)).rows[0]?.d as string;
  M['F1b_counterfactual_rewrote'] =
    SYNC_NEW !== SYNC_R8 &&
    SYNC_NEW !== SYNC_R9 &&
    !SYNC_R8.includes('plan_fact_blind') &&
    SYNC_R9.includes('plan_fact_blind') &&
    SYNC_R9.includes('v_asserted') &&
    !SYNC_NEW.includes('v_asserted') &&
    SYNC_NEW.includes('plan_fact_blind');

  const BLIND_PLANS = BLIND_PLANS_SQL;
  const RESTORE_PLANS_READ = RESTORE_PLANS_READ_SQL;

  const blindDdl: (string | null)[] = [];
  blindDdl.push(await ddl(`DROP POLICY business_isolation_read ON installment_plans`));
  blindDdl.push(await ddl(BLIND_PLANS));
  M['F1b_blind_ddl'] = blindDdl;

  // (i) THE PRE-REPAIR WRITER, under blindness.
  let r: string | null = null;
  try {
    await sup.query(SYNC_R8);
  } catch (e) {
    r = err(e);
  }
  M['F1b_r8_install'] = r;
  const r8Plan = await commitPlan(APP_CTX());
  M['F1b_r8_commit_error'] = r8Plan.error;
  M['F1b_r8_flag'] = await flag();
  M['F1b_r8_aging_while_blind'] = await aging(app, APP_CTX());
  //    AND IT DOES NOT HEAL: restore the policy and re-read the SAME row.
  await ddl(`DROP POLICY business_isolation_read ON installment_plans`);
  await ddl(RESTORE_PLANS_READ);
  M['F1b_r8_flag_after_restore'] = await flag();
  M['F1b_r8_plans_visible_after_restore'] = (await visiblePlans(app, APP_CTX())).rows[0]?.['n'] ?? null;
  M['F1b_r8_aging_after_restore'] = await aging(app, APP_CTX());
  //    Clean up that row — both relations in ONE transaction, because
  //    `installment_schedule_verify` refuses a half-deleted schedule.
  M['F1b_r8_cleanup'] = (
    await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [r8Plan.planId] },
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [r8Plan.planId] },
    ])
  ).error;
  M['F1b_r8_cleanup_flag'] = await flag();

  // (ii) THE SHIPPED WRITER, the same blindness, the same write.
  let r2: string | null = null;
  try {
    await sup.query(SYNC_NEW);
  } catch (e) {
    r2 = err(e);
  }
  M['F1b_new_install'] = r2;
  await ddl(`DROP POLICY business_isolation_read ON installment_plans`);
  await ddl(BLIND_PLANS);
  const blindPlan = await commitPlan(APP_CTX());
  M['F1b_new_commit_error'] = blindPlan.error;
  M['F1b_new_flag'] = await flag();
  M['F1b_new_plans_rows_after'] =
    (await inCtx(sup, {}, [{ sql: `SELECT count(*)::text AS n FROM installment_plans WHERE invoice_id = $1`, params: [world.invoiceId] }])).rows[0]?.['n'] ??
    null;

  // (iii) THE CONTROL. Policy restored, same write, and it must COMMIT —
  //       otherwise the law above refuses every plan and proves nothing.
  await ddl(`DROP POLICY business_isolation_read ON installment_plans`);
  await ddl(RESTORE_PLANS_READ);
  const sighted = await commitPlan(APP_CTX());
  M['F1b_control_commit_error'] = sighted.error;
  M['F1b_control_flag'] = await flag();
  M['F1b_control_aging'] = await aging(app, APP_CTX());
  M['F1b_control_cleanup'] = (
    await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [sighted.planId] },
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [sighted.planId] },
    ])
  ).error;
  M['F1b_control_cleanup_flag'] = await flag();

  // ══════════════════════════════════════════════════════════════════════
  // §F1-c THE FLOOR'S SCOPE — `TL-P4-COORD-R43`, F1-c, CRITICAL
  //
  // Round 9's floor was scoped to «the handed row asserts an ACTIVE plan on
  // this invoice» and the write it guarded was scoped to «this invoice». A
  // write of a NON-ACTIVE plan row therefore carried NO floor and still
  // overwrote the invoice's fact from the blindable recomputation.
  //
  // THE STATE IS ORDINARY. `installment_plans_one_active_per_invoice_uq` is a
  // PARTIAL index on `WHERE status = 'active'`, so one `active` plan beside one
  // `cancelled` plan on the same invoice is legal and is what a re-planned
  // receivable looks like.
  //
  // BOTH DIRECTIONS ARE MEASURED, because they are closed by DIFFERENT parts of
  // the repair and a suite that measured only one would not know which:
  //   (i)  the INSERT of a non-active plan — closed by the writer's own
  //        blindness probe, which round 9 had on no transition at all;
  //   (ii) the DELETE of a non-active plan — closed by the DERIVATION, which
  //        gives that transition an EMPTY write set. There is no probe on the
  //        DELETE path, so (ii) measures direction 1 and nothing else.
  // ══════════════════════════════════════════════════════════════════════
  const truth = async (): Promise<string> =>
    String(
      (
        await inCtx(sup, {}, [
          {
            sql: `SELECT EXISTS (SELECT 1 FROM installment_plans p WHERE p.invoice_id = $1 AND p.status = 'active')::text AS t`,
            params: [world.invoiceId],
          },
        ])
      ).rows[0]?.['t'] ?? 'MISSING',
    );
  const planCount = async (): Promise<string> =>
    String(
      (await inCtx(sup, {}, [{ sql: `SELECT count(*)::text AS n FROM installment_plans WHERE invoice_id = $1`, params: [world.invoiceId] }])).rows[0]?.['n'] ??
        'MISSING',
    );
  /** A plan row with NO schedule. Only an ACTIVE plan is bound by obligation (a). */
  const commitBarePlan = async (status: string, planId: string): Promise<string | null> =>
    (
      await inCtx(mig, APP_CTX(), [
        {
          sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
                VALUES ($1,$2,$3,$4,$5,$6,0,'2026-01-02'::DATE,$7,gen_random_uuid())`,
          params: [world.tenantId, world.businessId, planId, world.invoiceId, world.customerId, status, world.userId],
        },
      ])
    ).error;
  const dropBarePlan = async (planId: string): Promise<string | null> =>
    (await inCtx(mig, APP_CTX(), [{ sql: `DELETE FROM installment_plans WHERE id = $1`, params: [planId] }])).error;
  const installSync = async (body: string): Promise<string | null> => {
    try {
      await sup.query(body);
      return null;
    } catch (e) {
      return err(e);
    }
  };
  const rePolicy = async (create: string): Promise<(string | null)[]> => [
    await ddl(`DROP POLICY business_isolation_read ON installment_plans`),
    await ddl(create),
  ];

  // ── (i) THE INSERT DIRECTION, ROUND 9, BLINDED TO EVERYBODY.
  M['F1c_r9_install'] = await installSync(SYNC_R9);
  const r9Active = await commitPlan(APP_CTX());
  M['F1c_pre_commit'] = r9Active.error;
  M['F1c_pre_flag'] = await flag();
  M['F1c_blind_ddl'] = await rePolicy(BLIND_PLANS_SQL);
  const cancelledA = randomUUID();
  M['F1c_r9_insert_cancelled_error'] = await commitBarePlan('cancelled', cancelledA);
  //    THE CHALLENGER'S MEASURED BAD STATE, read as the superuser so the
  //    reading is of the DATA and not of anybody's visibility.
  M['F1c_r9_bad_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  //    AND THE READ, WHILE STILL BLIND: the pre-S7 answer, byte for byte.
  M['F1c_r9_aging_while_blind'] = await aging(app, APP_CTX());
  //    IT DOES NOT HEAL.
  M['F1c_r9_restore_ddl'] = await rePolicy(RESTORE_PLANS_READ_SQL);
  M['F1c_r9_flag_after_restore'] = await flag();
  M['F1c_r9_aging_after_restore'] = await aging(app, APP_CTX());

  // ── (ii) THE DELETE DIRECTION, ROUND 9, BLINDED TO EVERYBODY. The cancelled
  //        plan written above is still there; deleting it changes nothing about
  //        whether an active plan exists, and round 9 writes `false` anyway.
  //        THE BLINDING HERE IS THE WRITER-ONLY ONE, and that is a MECHANICAL
  //        necessity rather than a choice: PostgreSQL applies SELECT policies
  //        to the row-finding of a `DELETE ... WHERE id = $1`, so hiding the
  //        relation from everybody would hide the row from the DELETE itself
  //        and nothing would reach the trigger. Blinding only
  //        `daftar_accounting_internal` leaves `daftar_migrator` able to delete
  //        the row and leaves the sync's recomputation blind — which is the
  //        state under test.
  M['F1c_r9_delete_blind_ddl'] = await rePolicy(BLIND_WRITER_ONLY_SQL);
  M['F1c_r9_delete_error'] = await dropBarePlan(cancelledA);
  M['F1c_r9_delete_bad_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['F1c_r9_delete_restore_ddl'] = await rePolicy(RESTORE_PLANS_READ_SQL);

  //    Put the fixture back: the active plan and its schedule go, in ONE
  //    transaction, and the flag returns to the base case.
  M['F1c_r9_cleanup'] = (
    await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [r9Active.planId] },
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [r9Active.planId] },
    ])
  ).error;
  M['F1c_r9_cleanup_flag'] = await flag();

  // ── (iii) THE SHIPPED WRITER, the same two writes, the same blindness.
  M['F1c_new_install'] = await installSync(SYNC_NEW);
  const newActive = await commitPlan(APP_CTX());
  M['F1c_new_pre_commit'] = newActive.error;
  M['F1c_new_pre_flag'] = await flag();
  await rePolicy(BLIND_PLANS_SQL);
  const cancelledB = randomUUID();
  M['F1c_new_insert_cancelled_error'] = await commitBarePlan('cancelled', cancelledB);
  M['F1c_new_insert_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(RESTORE_PLANS_READ_SQL);

  //    THE DELETE DIRECTION, SHIPPED. The cancelled plan has to exist to be
  //    deleted, so it is written SIGHTED first — the subject is the DELETE.
  M['F1c_new_cancelled_sighted_error'] = await commitBarePlan('cancelled', cancelledB);
  M['F1c_new_cancelled_sighted_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(BLIND_WRITER_ONLY_SQL);
  M['F1c_new_delete_error'] = await dropBarePlan(cancelledB);
  M['F1c_new_delete_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(RESTORE_PLANS_READ_SQL);
  //    AND THE SIGHTED DELETE, which is the control for the one above: the
  //    same transition, nothing blinded, and the fact must be left alone.
  M['F1c_new_delete_sighted_error'] = await dropBarePlan(cancelledB);
  M['F1c_new_delete_sighted_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['F1c_new_aging_after'] = await aging(app, APP_CTX());

  //    AND THE CONTROL THAT STOPS THIS BEING "NEVER WRITE": cancelling the
  //    ACTIVE plan must still clear the flag, sighted, through the derivation.
  M['F1c_new_cancel_active_error'] = (
    await inCtx(mig, APP_CTX(), [{ sql: `UPDATE installment_plans SET status = 'cancelled' WHERE id = $1`, params: [newActive.planId] }])
  ).error;
  M['F1c_new_cancel_active_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['F1c_new_cleanup'] = (
    await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [newActive.planId] },
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [newActive.planId] },
    ])
  ).error;
  M['F1c_new_cleanup_flag'] = await flag();

  // ══════════════════════════════════════════════════════════════════════
  // §F1-c′ THE WRITER IS THE PRINCIPAL THE PREDICATE EXEMPTS — F1-c prime
  //
  // The shipped restrictive read policy plus
  // `AND current_user <> 'daftar_accounting_internal'` blinds EXACTLY the owner
  // of the two DEFINER trigger functions. `daftar_app` keeps reading every plan
  // row, so this is NOT the blindness §F1-b and §F1-c measure: the reader is
  // SIGHTED throughout, and the harm is that a healthy receivable becomes
  // permanently unreadable.
  // ══════════════════════════════════════════════════════════════════════
  M['F1cp_r9_install'] = await installSync(SYNC_R9);
  const cpActive = await commitPlan(APP_CTX());
  M['F1cp_pre_commit'] = cpActive.error;
  M['F1cp_pre_flag'] = await flag();
  M['F1cp_blind_ddl'] = await rePolicy(BLIND_WRITER_ONLY_SQL);
  //    THE BLINDING IS ASYMMETRIC, AND THAT IS ASSERTED BEFORE ANYTHING IS
  //    CONCLUDED FROM IT: the caller still sees the plan.
  M['F1cp_app_still_sees'] = (await visiblePlans(app, APP_CTX())).rows[0]?.['n'] ?? null;
  const cpCancelled = randomUUID();
  M['F1cp_r9_insert_error'] = await commitBarePlan('cancelled', cpCancelled);
  M['F1cp_r9_bad_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['F1cp_r9_restore_ddl'] = await rePolicy(RESTORE_PLANS_READ_SQL);
  M['F1cp_r9_flag_after_restore'] = await flag();
  M['F1cp_r9_aging_after_restore'] = await aging(app, APP_CTX());
  M['F1cp_r9_cleanup'] = (
    await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [cpCancelled] },
      { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [cpActive.planId] },
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [cpActive.planId] },
    ])
  ).error;
  M['F1cp_r9_cleanup_flag'] = await flag();

  M['F1cp_new_install'] = await installSync(SYNC_NEW);
  const cpActive2 = await commitPlan(APP_CTX());
  M['F1cp_new_pre_commit'] = cpActive2.error;
  await rePolicy(BLIND_WRITER_ONLY_SQL);
  M['F1cp_new_insert_error'] = await commitBarePlan('cancelled', randomUUID());
  M['F1cp_new_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(RESTORE_PLANS_READ_SQL);
  //    THE CONTROL: the same write, sighted, COMMITS and leaves the fact alone.
  const cpControl = randomUUID();
  M['F1cp_new_control_error'] = await commitBarePlan('cancelled', cpControl);
  M['F1cp_new_control_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['F1cp_new_control_aging'] = await aging(app, APP_CTX());
  M['F1cp_new_cleanup'] = (
    await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [cpControl] },
      { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [cpActive2.planId] },
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [cpActive2.planId] },
    ])
  ).error;
  M['F1cp_new_cleanup_flag'] = await flag();

  // ══════════════════════════════════════════════════════════════════════
  // §F1-d THE RIGHT-HAND SIDE OF OBLIGATION (a) — `TL-P4-COORD-R43`, F1-d
  //
  // `0075:561` gates `invoice.posted_amount_immutable` on
  // `OLD.status <> 'draft'`, so a DRAFT invoice's money IS mutable, and until
  // this round the two schedule-completeness triggers were on the PLAN side
  // only. Build a plan and a LAWFUL schedule against a draft invoice, bump the
  // invoice's total, promote `draft -> open`: obligation (a) is never
  // re-judged and the reader refuses `plan_schedule_unreadable` FOR EVER.
  //
  // NO ROW SECURITY IS TOUCHED ANYWHERE IN THIS SECTION, and no trigger is
  // dropped: the counterfactual is the ABSENCE of the new `invoices` trigger,
  // reproduced by DISABLING exactly it. Its own customer, so the aging read is
  // of this fixture and of nothing else.
  // ══════════════════════════════════════════════════════════════════════
  const draftWorld = await (async (): Promise<{ customerId: string; a: string; b: string }> => {
    const c = await sup.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE sales DISABLE TRIGGER USER');
      const dCustomer = randomUUID();
      await c.query(
        `INSERT INTO customers (tenant_id,business_id,id,name,status,revision,create_intent_sha256,last_intent_sha256,business_transaction_id,created_by,updated_by)
         VALUES ($1,$2,$3,'F1d Customer','active',1,$4,$4,gen_random_uuid(),$5,$5)`,
        [world.tenantId, world.businessId, dCustomer, SHA, world.userId],
      );
      const ids: string[] = [];
      for (const n of [1, 2]) {
        const saleId = randomUUID();
        await c.query(
          `INSERT INTO sales (tenant_id,business_id,id,customer_id,branch_id,warehouse_id,status,settlement_mode,document_date,currency_code,
                              subtotal_txn_minor,discount_txn_minor,total_txn_minor,total_base_minor,source_to_base_rate,rate_source,rate_timestamp,
                              customer_name_snapshot,commit_intent_sha256,confirmed_by,confirmed_at,business_transaction_id,created_by,binding_source_id)
           SELECT $1,$2,$3,$4,s.branch_id,s.warehouse_id,'confirmed','credit','2026-01-02','ILS',900000,0,900000,900000,1,'base',$5::timestamptz,
                  'F1d Customer',$6,$7,$5::timestamptz,gen_random_uuid(),$7,$3
             FROM sales s WHERE s.id = $8`,
          [world.tenantId, world.businessId, saleId, dCustomer, STAMP, SHA, world.userId, world.saleId2],
        );
        const invoiceId = randomUUID();
        // A DRAFT, so `invoices_binding_owed_ck` demands a NULL binding.
        await c.query(
          `INSERT INTO invoices (tenant_id,business_id,id,sale_id,customer_id,branch_id,document_kind,document_number,number_seq,period,issue_date,due_date,
                                 currency_code,status,subtotal_txn_minor,discount_txn_minor,tax_minor,total_txn_minor,total_base_minor,source_to_base_rate,
                                 rate_source,rate_timestamp,customer_name_snapshot,issue_intent_sha256,business_transaction_id,created_by,binding_source_id)
           SELECT $1,$2,$3,$4,$5,i.branch_id,'invoice',$6,$7,'2026','2026-01-02','2026-01-02','ILS','draft',900000,0,0,900000,900000,1,'base',$8::timestamptz,
                  'F1d Customer',$9,gen_random_uuid(),$10,NULL
             FROM invoices i WHERE i.id = $11`,
          [world.tenantId, world.businessId, invoiceId, saleId, dCustomer, `INV-DRAFT-${String(n)}`, 500 + n, STAMP, SHA, world.userId, world.invoiceId],
        );
        ids.push(invoiceId);
      }
      await c.query('COMMIT');
      await c.query('ALTER TABLE sales ENABLE TRIGGER USER');
      return { customerId: dCustomer, a: ids[0] as string, b: ids[1] as string };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw new Error(`the §F1-d draft fixture did not build: ${err(e)}`);
    } finally {
      c.release();
    }
  })();
  M['F1d_world'] = draftWorld;

  /** A plan and a schedule summing EXACTLY to 900000 against one draft invoice. */
  const planOnDraft = async (invoiceId: string): Promise<{ error: string | null; planId: string }> => {
    const planId = randomUUID();
    const r = await inCtx(mig, APP_CTX(), [
      {
        sql: `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
              VALUES ($1,$2,$3,$4,$5,'active',100000,'2026-01-02'::DATE,$6,gen_random_uuid())`,
        params: [world.tenantId, world.businessId, planId, invoiceId, draftWorld.customerId, world.userId],
      },
      {
        sql: `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
              VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-02-02'::DATE,400000),
                     ($1,$2,gen_random_uuid(),$3,2,'2026-06-02'::DATE,400000)`,
        params: [world.tenantId, world.businessId, planId],
      },
    ]);
    return { error: r.error, planId };
  };
  const bumpMoney = async (invoiceId: string, total: number): Promise<string | null> =>
    (
      await inCtx(sup, APP_CTX(), [
        {
          sql: `UPDATE invoices SET subtotal_txn_minor = $2, total_txn_minor = $2, total_base_minor = $2 WHERE id = $1`,
          params: [invoiceId, total],
        },
      ])
    ).error;
  const promote = async (invoiceId: string): Promise<string | null> =>
    (await inCtx(sup, APP_CTX(), [{ sql: `UPDATE invoices SET status = 'open', binding_source_id = id WHERE id = $1`, params: [invoiceId] }])).error;
  const draftAging = async (): Promise<Outcome> =>
    inCtx(app, APP_CTX(), [
      {
        sql: `SELECT * FROM public.customer_ar_aging($1,$2,$3::DATE,$4::INTEGER[]) ORDER BY bucket_no`,
        params: [world.businessId, draftWorld.customerId, '2026-06-30', BUCKETS],
      },
    ]);

  // NON-VACUITY FIRST: the draft really is a draft and its money really is
  // mutable, which is the whole premise. Measured, not cited.
  M['F1d_draft_status'] = (await inCtx(sup, {}, [{ sql: `SELECT status FROM invoices WHERE id = $1`, params: [draftWorld.a] }])).rows[0]?.['status'];

  // ── (i) THE DEFECT, with the new trigger DISABLED — the pre-repair tree.
  M['F1d_disable_ddl'] = await ddl(`ALTER TABLE invoices DISABLE TRIGGER invoices_installment_schedule_complete`);
  const dPlanA = await planOnDraft(draftWorld.a);
  M['F1d_plan_on_draft_commits'] = dPlanA.error;
  M['F1d_pre_bump_aging'] = await draftAging();
  M['F1d_bump_without_trigger'] = await bumpMoney(draftWorld.a, 1000000);
  M['F1d_promote'] = await promote(draftWorld.a);
  M['F1d_state_after'] = (
    await inCtx(sup, {}, [
      {
        sql: `SELECT i.status, i.total_txn_minor::text AS total,
                     (p.down_payment_minor + (SELECT coalesce(sum(n.amount_txn_minor),0) FROM installments n WHERE n.plan_id = p.id))::text AS schedule
                FROM invoices i JOIN installment_plans p ON p.invoice_id = i.id AND p.status = 'active'
               WHERE i.id = $1`,
        params: [draftWorld.a],
      },
    ])
  ).rows[0];
  M['F1d_aging_refused_forever'] = await draftAging();
  //    AND IT IS UNHEALABLE WITHOUT A WRITE: re-enabling the trigger changes
  //    nothing about the row that is already there.
  M['F1d_enable_ddl'] = await ddl(`ALTER TABLE invoices ENABLE TRIGGER invoices_installment_schedule_complete`);
  M['F1d_aging_still_refused'] = await draftAging();

  // ── (ii) THE REPAIR, on the SECOND draft invoice, trigger ENABLED.
  const dPlanB = await planOnDraft(draftWorld.b);
  M['F1d_plan_b_commits'] = dPlanB.error;
  M['F1d_bump_with_trigger'] = await bumpMoney(draftWorld.b, 1000000);
  M['F1d_b_total_after_refusal'] = (
    await inCtx(sup, {}, [{ sql: `SELECT total_txn_minor::text AS t FROM invoices WHERE id = $1`, params: [draftWorld.b] }])
  ).rows[0]?.['t'];
  //    THE CONTROL THAT MAKES IT A DISCRIMINATION: the SAME bump, with the
  //    schedule corrected in the SAME transaction, COMMITS.
  M['F1d_bump_with_fix_commits'] = (
    await inCtx(sup, APP_CTX(), [
      {
        sql: `UPDATE invoices SET subtotal_txn_minor = 1000000, total_txn_minor = 1000000, total_base_minor = 1000000 WHERE id = $1`,
        params: [draftWorld.b],
      },
      { sql: `UPDATE installments SET amount_txn_minor = 450000 WHERE plan_id = $1`, params: [dPlanB.planId] },
    ])
  ).error;
  M['F1d_b_state_after_fix'] = (
    await inCtx(sup, {}, [
      {
        sql: `SELECT i.total_txn_minor::text AS total,
                     (p.down_payment_minor + (SELECT coalesce(sum(n.amount_txn_minor),0) FROM installments n WHERE n.plan_id = p.id))::text AS schedule
                FROM invoices i JOIN installment_plans p ON p.invoice_id = i.id AND p.status = 'active'
               WHERE i.id = $1`,
        params: [draftWorld.b],
      },
    ])
  ).rows[0];
  //    AND A SECOND CONTROL: a money bump on a draft invoice with NO plan is
  //    untouched by the new trigger, so it does not refuse every invoice write.
  M['F1d_bump_unplanned_commits'] = await (async (): Promise<string | null> => {
    const r = await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [dPlanB.planId] },
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [dPlanB.planId] },
    ]);
    if (r.error !== null) return `cleanup: ${r.error}`;
    return bumpMoney(draftWorld.b, 1100000);
  })();
  M['F1d_b_flag_after'] = (
    await inCtx(sup, {}, [{ sql: `SELECT has_active_installment_plan::text AS f FROM invoices WHERE id = $1`, params: [draftWorld.b] }])
  ).rows[0]?.['f'];
  //    AND THE FIXTURE IS READABLE WHEN OBLIGATION (a) IS NOT IN QUESTION:
  //    promote the second invoice and the aging ANSWERS. Without this the
  //    refusals above could be a reader that refuses this customer always.
  //    Invoice `a` is the BROKEN one and it is permanently unreadable, so it
  //    has to leave the picture first — its plan is removed, which is the only
  //    repair available once the total has moved under a committed schedule.
  M['F1d_a_plan_removed'] = (
    await inCtx(mig, APP_CTX(), [
      { sql: `DELETE FROM installments WHERE plan_id = $1`, params: [dPlanA.planId] },
      { sql: `DELETE FROM installment_plans WHERE id = $1`, params: [dPlanA.planId] },
    ])
  ).error;
  M['F1d_promote_b'] = await promote(draftWorld.b);
  M['F1d_aging_answers'] = await draftAging();

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

  // ══════════════════════════════════════════════════════════════════════
  // §Z ROUND 11 STEP ZERO — THE `status`-PREDICATED BLINDING, TAKEN AGAINST
  //    AN INVOICE WHOSE FLAG IS ALREADY `false`
  //
  // The round-10 challenger's own first limitation named this as an UNMEASURED
  // route that could be a Critical, and the coordinator ordered it executed
  // before anything else. The construction: a RESTRICTIVE read policy
  // predicated on `status <> 'active'`, which hides exactly the ACTIVE rows.
  // The writer's by-primary-key probe then PASSES for a NON-ACTIVE handed row
  // — the row is visible — while the cross-check's `EXISTS` is blind, and a
  // non-active transition derives an EMPTY write set so the cross-check never
  // runs at all. Against an invoice whose flag is already `false`, the
  // deferred verifier's two readings then AGREE, which the specification
  // itself admits «degrades to a pass».
  //
  // SO THE QUESTION IS WHETHER A WRONG FACT COMMITS THERE, and the answer is
  // measured in both directions and in both blinding shapes.
  // ══════════════════════════════════════════════════════════════════════
  /** The shipped text with `status <> 'active'` folded in for EVERY principal. */
  const STATUS_BLIND_ALL_SQL = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
     USING (status <> 'active'
            AND (app_bypass() OR current_user IN ('daftar_inventory_internal','daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid))`;
  /**
   * And for the DEFINER ALONE, which is the sharper shape: `daftar_app` and
   * `daftar_migrator` keep reading every plan row, so the reader is SIGHTED
   * throughout and nothing about the caller is in question.
   */
  const STATUS_BLIND_WRITER_SQL = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
     USING (app_bypass()
            OR (current_user = 'daftar_accounting_internal' AND status <> 'active')
            OR (current_user <> 'daftar_accounting_internal'
                AND (current_user = 'daftar_inventory_internal' OR business_id = nullif(app_business(), '')::uuid)))`;

  /**
   * THE FIXTURE INVOICE, BACK TO THE BASE CASE OF THE INDUCTION: no plan, no
   * schedule, flag `false`. Both relations in ONE transaction and the
   * schedule first, because `installments_plan_fk` refuses a plan whose rows
   * are still there and `installment_schedule_verify` refuses a half-deleted
   * schedule at COMMIT. Each section below starts from this rather than from
   * whatever the section above left, because a count that depends on the
   * section above is a count nobody can check.
   */
  const resetInvoice = async (): Promise<string | null> =>
    (
      await inCtx(mig, APP_CTX(), [
        { sql: `DELETE FROM installments WHERE plan_id IN (SELECT id FROM installment_plans WHERE invoice_id = $1)`, params: [world.invoiceId] },
        { sql: `DELETE FROM installment_plans WHERE invoice_id = $1`, params: [world.invoiceId] },
      ])
    ).error;

  // THE SUBJECT IS THE BODY THIS FILE'S SPECIFICATION INSTALLED, re-read from
  // the catalogue rather than assumed, because §F1-c and §F1-c′ above have been
  // replacing it. A probe that trusts the body is a probe of nothing.
  M['Z_installed_body_is_shipped'] =
    (await sup.query<{ h: string }>(`SELECT md5(pg_get_functiondef('public.installment_plan_fact_sync()'::regprocedure)) AS h`)).rows[0]?.h ===
    createHash('md5').update(SYNC_NEW).digest('hex');

  // NON-VACUITY: the fixture starts where the step-zero question needs it —
  // flag `false`, and no plan at all on the invoice.
  M['Z_pre'] = { flag: await flag(), truth: await truth(), plans: await planCount() };

  // ── Z1 THE DIRECTION ITSELF. Flag already `false`, nothing active, and the
  //    status-blinded INSERT of a cancelled plan: empty write set, probe
  //    passes, cross-check never runs, deferred verifier compares `false`
  //    against a blinded `false` and AGREES.
  M['Z1_blind_ddl'] = await rePolicy(STATUS_BLIND_ALL_SQL);
  const z1 = randomUUID();
  M['Z1_insert_cancelled'] = await commitBarePlan('cancelled', z1);
  M['Z1_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['Z1_restore_ddl'] = await rePolicy(RESTORE_PLANS_READ_SQL);
  M['Z1_state_after_restore'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['Z1_aging'] = await aging(app, APP_CTX());

  // ── Z2 AND WHY NO WRONG FACT CAN BE WRITTEN THAT WAY: every transition that
  //    would write `true` carries an ACTIVE `NEW` row, and an ACTIVE row is
  //    exactly what this policy hides — so the probe REFUSES it. Measured
  //    under both blinding shapes, because the definer-only one leaves the
  //    writing principal able to see the row and is the one that could have
  //    been different.
  await rePolicy(STATUS_BLIND_ALL_SQL);
  M['Z2_insert_active_all_blind'] = await commitBarePlan('active', randomUUID());
  await rePolicy(STATUS_BLIND_WRITER_SQL);
  M['Z3_mig_still_sees'] = (await visiblePlans(mig, APP_CTX())).rows[0]?.['n'] ?? null;
  M['Z3_insert_active_writer_blind'] = await commitBarePlan('active', randomUUID());
  M['Z3_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(RESTORE_PLANS_READ_SQL);

  // ── Z4 THE FLAG-TRUE MIRROR, which is `TL-P4-COORD-R46` F-3's own case: a
  //    real active plan, then the status-blinded DELETE of a cancelled plan
  //    beside it. Empty write set, no probe on a DELETE, and the deferred
  //    verifier catches it — under the WRONG NAME, which is the whole of F-3.
  const zActive = await commitPlan(APP_CTX());
  M['Z4_active_commits'] = zActive.error;
  M['Z4_pre'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(STATUS_BLIND_WRITER_SQL);
  M['Z4_blinded_delete_cancelled'] = await dropBarePlan(z1);
  M['Z4_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(RESTORE_PLANS_READ_SQL);

  // ══════════════════════════════════════════════════════════════════════
  // §F5 THE INSERT-BRANCH DERIVATION IS LOAD-BEARING, AND THE CASE IS NOT THE
  //     PROBE (`TL-P4-COORD-R46`, F-5)
  //
  // Round 10 reported, unprompted, that an INSERT-branch reversion left all
  // 198 cases GREEN — so on INSERT the only load-bearing thing was the probe,
  // which F-3 shows is defeatable. THIS is the case that is not the probe: with
  // the status-predicated policy the probe PASSES for a non-active row, so
  // round 9's INSERT branch — write set «this invoice», value from the blinded
  // recomputation — writes `false` beside a live active plan, and the deferred
  // verifier, blinded the same way, AGREES with it and the transaction COMMITS.
  // The shipped derivation refuses the identical construction because the
  // transition determines NOTHING and no UPDATE is issued at all.
  // ══════════════════════════════════════════════════════════════════════
  M['F5_r9_install'] = await installSync(SYNC_R9);
  await rePolicy(STATUS_BLIND_WRITER_SQL);
  const f5r9 = randomUUID();
  M['F5_r9_insert_cancelled'] = await commitBarePlan('cancelled', f5r9);
  M['F5_r9_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(RESTORE_PLANS_READ_SQL);
  M['F5_r9_state_after_restore'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['F5_r9_aging_after_restore'] = await aging(app, APP_CTX());
  //    THE SHIPPED BODY, THE SAME CONSTRUCTION. The planted row goes and the
  //    flag is put back to what the plan relation supports, so the two bodies
  //    are asked the same question from the same state.
  M['F5_cleanup'] = (await inCtx(mig, APP_CTX(), [{ sql: `DELETE FROM installment_plans WHERE id = $1`, params: [f5r9] }])).error;
  M['F5_new_install'] = await installSync(SYNC_NEW);
  M['F5_repair_flag'] = (
    await inCtx(sup, APP_CTX(), [
      {
        sql: `UPDATE invoices SET has_active_installment_plan = EXISTS (SELECT 1 FROM installment_plans p WHERE p.business_id = invoices.business_id AND p.invoice_id = invoices.id AND p.status = 'active') WHERE id = $1`,
        params: [world.invoiceId],
      },
    ])
  ).error;
  M['F5_pre_new'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(STATUS_BLIND_WRITER_SQL);
  M['F5_new_insert_cancelled'] = await commitBarePlan('cancelled', randomUUID());
  M['F5_new_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(RESTORE_PLANS_READ_SQL);
  M['F5_new_aging'] = await aging(app, APP_CTX());

  // ══════════════════════════════════════════════════════════════════════
  // §F4 THE ONE-ACTIVE EXCLUSION: ONE NAME, BOTH HEAP ORDERS
  //     (`TL-P4-COORD-R46`, F-4)
  //
  // The declared over-strictness was ROW-ORDER DEPENDENT and its message was a
  // false diagnosis. Fixtures differing only in HEAP ORDER are built here, with
  // the `ctid`s recorded so the order is a MEASUREMENT and not an intention,
  // and three repeats of each — because a split that is reported once is a
  // coincidence.
  // ══════════════════════════════════════════════════════════════════════
  M['F4_reset'] = await resetInvoice();
  M['F4_pre'] = { flag: await flag(), truth: await truth(), plans: await planCount() };

  /** One move attempt, in the given heap order. Returns everything the claim needs. */
  const movePair = async (activeFirst: boolean): Promise<Record<string, unknown>> => {
    const a = randomUUID();
    const b = randomUUID();
    const first = activeFirst ? { id: a, status: 'active' } : { id: b, status: 'cancelled' };
    const second = activeFirst ? { id: b, status: 'cancelled' } : { id: a, status: 'active' };
    // Both plans carry a LAWFUL schedule: obligation (b) refuses an active plan
    // with none, and the `cancel, then activate` control has to be able to
    // COMMIT with the incoming plan's schedule already correct.
    const build1 = await commitPlan(APP_CTX(), { planId: first.id, status: first.status });
    const build2 = await commitPlan(APP_CTX(), { planId: second.id, status: second.status });
    const heap = (
      await inCtx(sup, {}, [
        { sql: `SELECT id::text AS id, status, ctid::text AS ctid FROM installment_plans WHERE invoice_id = $1 ORDER BY ctid`, params: [world.invoiceId] },
      ])
    ).rows;
    const move = await inCtx(mig, APP_CTX(), [
      {
        sql: `UPDATE installment_plans SET status = CASE WHEN id = $1 THEN 'cancelled' ELSE 'active' END WHERE invoice_id = $2 AND id IN ($1, $3)`,
        params: [a, world.invoiceId, b],
      },
    ]);
    const after = { flag: await flag(), truth: await truth(), plans: await planCount() };
    const clean = (
      await inCtx(mig, APP_CTX(), [
        { sql: `DELETE FROM installments WHERE plan_id = ANY ($1::uuid[])`, params: [[a, b]] },
        { sql: `DELETE FROM installment_plans WHERE id = ANY ($1::uuid[])`, params: [[a, b]] },
      ])
    ).error;
    return { activeFirst, build: build1.error ?? build2.error, heap, moveError: move.error, after, clean, flagAfterClean: await flag() };
  };
  const moves: unknown[] = [];
  for (const activeFirst of [true, false]) for (const _n of [1, 2, 3]) moves.push(await movePair(activeFirst));
  M['F4_single_statement_moves'] = moves;

  // ── AND HALF TWO OF THE DECLARATION, in both orders. «The same change in two
  //    statements commits» held in ONE of them and the COMMENT did not say
  //    which.
  const twoStatement = async (cancelFirst: boolean): Promise<Record<string, unknown>> => {
    const a = randomUUID();
    const b = randomUUID();
    const build1 = await commitPlan(APP_CTX(), { planId: a, status: 'active' });
    const build2 = await commitPlan(APP_CTX(), { planId: b, status: 'cancelled' });
    const cancel = { sql: `UPDATE installment_plans SET status = 'cancelled' WHERE id = $1`, params: [a] };
    const activate = { sql: `UPDATE installment_plans SET status = 'active' WHERE id = $1`, params: [b] };
    const move = await inCtx(mig, APP_CTX(), cancelFirst ? [cancel, activate] : [activate, cancel]);
    const after = { flag: await flag(), truth: await truth(), plans: await planCount() };
    const clean = (
      await inCtx(mig, APP_CTX(), [
        { sql: `DELETE FROM installments WHERE plan_id = ANY ($1::uuid[])`, params: [[a, b]] },
        { sql: `DELETE FROM installment_plans WHERE id = ANY ($1::uuid[])`, params: [[a, b]] },
      ])
    ).error;
    return { build: build1.error ?? build2.error, moveError: move.error, after, clean };
  };
  M['F4_cancel_then_activate'] = await twoStatement(true);
  M['F4_activate_then_cancel'] = await twoStatement(false);

  // ── AND THE EXCLUSION IS NOT THE MECHANISM, which has to be measured or the
  //    section reads as a claim that a blindable read bounds the active count.
  //    Blinded, the BEFORE trigger reads nothing and PASSES, and the PARTIAL
  //    UNIQUE INDEX — which is physical — refuses instead.
  const f4Live = await commitPlan(APP_CTX(), { planId: randomUUID(), status: 'active' });
  M['F4_live_active_commits'] = f4Live.error;
  M['F4_second_active_sighted'] = await commitBarePlan('active', randomUUID());
  await rePolicy(STATUS_BLIND_WRITER_SQL);
  M['F4_second_active_blinded'] = await commitBarePlan('active', randomUUID());
  await rePolicy(RESTORE_PLANS_READ_SQL);
  M['F4_state_after'] = { flag: await flag(), truth: await truth(), plans: await planCount() };

  // ══════════════════════════════════════════════════════════════════════
  // §Z6 THE TWO-FAULT COMPOSITE, with its one-fault controls on both sides
  //     (round 11 step zero, second half)
  //
  // The deferred verifier is what catches a DISABLED sync trigger (§D1 above).
  // Under this policy its `EXISTS` reads `false`, so against a flag that is
  // already `false` the two readings AGREE. Either fault alone is refused;
  // together they COMMIT. It still FAILS CLOSED one layer out, at the READ, and
  // that is measured rather than asserted.
  // ══════════════════════════════════════════════════════════════════════
  M['Z6_cleanup'] = await resetInvoice();
  M['Z6_pre'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['Z6_disable_sync'] = await ddl(`ALTER TABLE installment_plans DISABLE TRIGGER installment_plans_fact_sync`);
  const z6a = await commitPlan(APP_CTX(), { planId: randomUUID(), status: 'active' });
  M['Z6_control_trigger_only'] = z6a.error;
  M['Z6_control_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(STATUS_BLIND_WRITER_SQL);
  const z6b = await commitPlan(APP_CTX(), { planId: randomUUID(), status: 'active' });
  M['Z6_two_faults'] = z6b.error;
  M['Z6_two_faults_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  await rePolicy(RESTORE_PLANS_READ_SQL);
  M['Z6_enable_sync'] = await ddl(`ALTER TABLE installment_plans ENABLE TRIGGER installment_plans_fact_sync`);
  //    EVERY FAULT REMOVED, and the READ is the layer that refuses.
  M['Z6_state_all_restored'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['Z6_aging_all_restored'] = await aging(app, APP_CTX());

  // ══════════════════════════════════════════════════════════════════════
  // §F6 THE TWO ADVERTISED SYNC REFUSALS, MEASURED AS THE PRINCIPAL THAT
  //     WRITES (`TL-P4-COORD-R46`, F-6)
  // ══════════════════════════════════════════════════════════════════════
  M['F6_business_change_migrator'] = (
    await inCtx(mig, APP_CTX(), [{ sql: `UPDATE installment_plans SET business_id = gen_random_uuid() WHERE id = $1`, params: [z6b.planId] }])
  ).error;
  //    AND AS THE SUPERUSER, which row security does not apply to at all —
  //    so if `plan_fact_unwritable` were reachable anywhere it would be here.
  M['F6_business_change_superuser'] = (
    await inCtx(sup, APP_CTX(), [{ sql: `UPDATE installment_plans SET business_id = gen_random_uuid() WHERE id = $1`, params: [z6b.planId] }])
  ).error;
  //    THE CROSS-TENANT PLAN, in both of its constructions: with the session
  //    context set to the divergent tenant, and with it left at the invoice's.
  M['F6_cross_tenant_divergent_ctx'] = (
    await commitPlan({ 'app.tenant_id': world.otherTenantId, 'app.business_id': world.businessId }, { tenantId: world.otherTenantId, status: 'cancelled' })
  ).error;
  M['F6_cross_tenant_own_ctx'] = (await commitPlan(APP_CTX(), { tenantId: world.otherTenantId, status: 'cancelled' })).error;
  //    AND THE FIXTURE IS LEFT AS §Z FOUND IT, so this block's own state is not
  //    a conclusion anybody draws from the ones above.
  M['F6_teardown'] = await resetInvoice();
  M['F6_teardown_state'] = { flag: await flag(), truth: await truth(), plans: await planCount() };
  M['F6_policies'] = (
    await mig.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policy WHERE polrelid = 'public.installment_plans'::regclass AND polname = 'business_isolation_read'`,
    )
  ).rows[0]?.n;

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

  it('and the CROSS-TENANT plan is now refused STRUCTURALLY, by the tenant edge that F2 found had been left off', () => {
    // `TL-P4-COORD-R43`, F2. Round 9 refused this state LATE — the invoice's
    // own `tenant_membership` refused the flag write, the recomputation landed
    // on zero rows and the sync's ROW_COUNT check turned that into
    // `installment.plan_fact_unwritable` — and justified the missing edge by
    // asserting that no composite key existed to name. The key does exist
    // (`0016:10`, `businesses (tenant_id, id) UNIQUE`, named by 62 foreign keys
    // in the frozen estate including `invoices_tenant_fk` at `0075:318`), so
    // the edge is carried now and the state is UNREACHABLE rather than caught.
    expect(String(M['C7_cross_tenant_write'])).toContain('installment_plans_tenant_fk');
    expect(String(M['C7_cross_tenant_write'])).toContain('foreign key constraint');
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

describe('P4-S7 §F1-a partial schedule invisibility, judged by arithmetic', () => {
  it('the counterfactual really is the ROUND-8 reader and nothing else', () => {
    expect(M['F1a_counterfactual_rewrote'], 'the existence-test rewrite did not take, so §F1-a measures nothing').toBe(true);
  });

  interface Partial {
    readonly label: string;
    readonly instalmentsVisible: Record<string, string> | string;
    readonly plansVisible: string | null;
    readonly flag: string;
    readonly r8Install: string | null;
    readonly r8ReaderServed: Outcome;
    readonly newInstall: string | null;
    readonly newReaderRefused: string | null;
    readonly restoredReader: Outcome;
  }
  const partials = (): readonly Partial[] => (M['F1a_partials'] as readonly Partial[] | undefined) ?? [];

  it('both halves of the schedule were actually hidden, one at a time, with the plan still readable and the flag still true', () => {
    const ps = partials();
    expect(ps).toHaveLength(2);
    for (const p of ps) {
      // THE ATTACK LANDED: one of two instalments readable, the PLAN readable,
      // the flag correct. Without these three the refusal below could be
      // coming from anywhere.
      expect(p.instalmentsVisible, p.label).toEqual({ n: '1', s: '400000' });
      expect(p.plansVisible, p.label).toBe('1');
      expect(p.flag, p.label).toBe('true');
      expect(p.r8Install, p.label).toBeNull();
      expect(p.newInstall, p.label).toBeNull();
    }
  });

  it('the ROUND-8 reader serves a SILENTLY COARSENED figure — the defect, reproduced in this database', () => {
    // A CORRECTION OF MY OWN LAW, recorded rather than quietly weakened. I
    // first asserted this of BOTH halves, with "fewer bands than the fully
    // visible reading" as the discriminator. IT MEASURED FALSE for F1a-2 and
    // the measurement is right: see the next law. The defect is reproduced by
    // hiding the LATER instalment, and that is what this law is about.
    const p = partials()[0];
    expect(p?.label).toContain('F1a-1');
    expect(p?.r8ReaderServed.error, 'the round-8 reader must SERVE, not refuse — that is the defect').toBeNull();
    const r = rows(p?.r8ReaderServed);
    // ONE band where the truth is two, the whole figure parked at the invoice
    // due date, and the authoritative total intact so nothing looks wrong.
    expect(r).toEqual([{ bucket_no: 4, currency_code: 'ILS', txn_minor: '900000', base_minor: '900000', invoice_count: 1 }]);
    expect(sum(r)).toBe(TOTAL);
    expect(rows(M['C2_aging_with_plan'])).toHaveLength(2);
  });

  it('MEASURED NEGATIVE, and it is the reason an existence test is not enough: hiding the OTHER instalment leaves the round-8 answer BYTE-IDENTICAL to the correct one', () => {
    // Hiding instalment 1 of 2 — the EARLIER one — and the round-8 reader
    // returns exactly what a fully sighted caller gets. The paid-anchored
    // levels absorb it: the missing early amount was already below `paid`, so
    // no bucket moves. THE HARM IS VALUE-DEPENDENT, which is precisely what
    // made it silent, and it is why a test that fires only when the answer
    // visibly changes is not a test. The reader cannot know it got lucky.
    const p = partials()[1];
    expect(p?.label).toContain('F1a-2');
    expect(p?.r8ReaderServed.error).toBeNull();
    expect(rows(p?.r8ReaderServed)).toEqual(rows(M['C2_aging_with_plan']));
  });

  it('the SHIPPED reader refuses BOTH halves by its own name — including the one whose answer was accidentally right', () => {
    // THE COMPLETENESS CLAIM, and the whole of F1-a's repair. The arithmetic
    // signature does not ask whether the coincidence above happened to be
    // benign: `amount_txn_minor >= 1` means every hidden row moves the visible
    // sum away from `invoices.total_txn_minor`, so the test fires on the
    // harmless case too. That is OVER-STRICT IN THE SAFE DIRECTION and it is
    // deliberate — a caller that cannot read the whole schedule has no way to
    // know which case it is in, so it must not answer at all.
    const ps = partials();
    expect(ps).toHaveLength(2);
    for (const p of ps) {
      expect(String(p.newReaderRefused), p.label).toContain('installment.plan_schedule_unreadable');
    }
  });

  it('and restoring the policy restores the ANSWER, not merely the absence of an error', () => {
    for (const p of partials()) {
      expect(p.restoredReader.error, p.label).toBeNull();
      const r = rows(p.restoredReader);
      expect(sum(r), p.label).toBe(TOTAL);
      expect(r, p.label).toEqual(rows(M['C2_aging_with_plan']));
    }
  });
});

describe("P4-S7 §F1-b the fact's writer, blinded", () => {
  it('the counterfactual really is the ROUND-8 sync and nothing else', () => {
    expect(M['F1b_counterfactual_rewrote'], 'the floor-removal rewrite did not take, so §F1-b measures nothing').toBe(true);
    expect(M['F1b_r8_install'], 'the pre-repair sync did not install').toBeNull();
    expect(M['F1b_new_install'], 'the shipped sync did not reinstall').toBeNull();
    expect(M['F1b_blind_ddl']).toEqual([null, null]);
  });

  it('the ROUND-8 writer COMMITS a plan while recording that there is none', () => {
    // The defect, reproduced: the write succeeds, and the column that governs
    // the aging says `false` while an active plan exists.
    expect(M['F1b_r8_commit_error']).toBeNull();
    expect(M['F1b_r8_flag']).toBe('false');
  });

  it('and it DOES NOT HEAL: restoring the policy leaves the row wrong, and every sighted caller is then refused FOREVER', () => {
    expect(M['F1b_r8_flag_after_restore']).toBe('false');
    // The plan is now visible again and the flag still says there is none, so
    // the read's `unflagged_plan` count fires. A silent wrong answer that has
    // turned into a permanent refusal — worse than either.
    expect(M['F1b_r8_plans_visible_after_restore']).toBe('1');
    expect(String(errOf(M['F1b_r8_aging_after_restore']))).toContain('installment.plan_fact_unflagged');
    expect(M['F1b_r8_cleanup']).toBeNull();
    expect(M['F1b_r8_cleanup_flag']).toBe('false');
  });

  it('the SHIPPED writer refuses the same write at WRITE time, by name, and no plan row survives', () => {
    expect(String(M['F1b_new_commit_error'])).toContain('installment.plan_fact_blind');
    // NOT a read-time refusal and NOT a COMMIT-time one: the transaction never
    // lands, so there is no desynchronised row to heal.
    expect(M['F1b_new_flag']).toBe('false');
    expect(M['F1b_new_plans_rows_after']).toBe('0');
  });

  it('and the CONTROL commits — the law refuses blindness, not plan writes', () => {
    expect(M['F1b_control_commit_error']).toBeNull();
    expect(M['F1b_control_flag']).toBe('true');
    expect(errOf(M['F1b_control_aging'])).toBe('');
    expect(sum(rows(M['F1b_control_aging']))).toBe(TOTAL);
    expect(M['F1b_control_cleanup']).toBeNull();
    expect(M['F1b_control_cleanup_flag']).toBe('false');
  });
});

describe("P4-S7 §F1-c the floor's SCOPE — a non-active plan write carried none (TL-P4-COORD-R43, F1-c)", () => {
  it('the two counterfactuals are the ROUND-8 and ROUND-9 writers, quoted and not derived', () => {
    expect(M['F1b_counterfactual_rewrote'], 'the quoted counterfactuals are not distinguishable from the shipped body').toBe(true);
    expect(M['F1c_r9_install'], 'the round-9 sync did not install').toBeNull();
    expect(M['F1c_new_install'], 'the shipped sync did not reinstall').toBeNull();
    expect(M['F1c_blind_ddl']).toEqual([null, null]);
    expect(M['F1c_pre_commit'], 'the active plan the whole section is about did not commit').toBeNull();
    expect(M['F1c_pre_flag'], 'the fixture did not start from a correctly flagged invoice').toBe('true');
  });

  it("the ROUND-9 writer commits the challenger's EXACT bad state from an ORDINARY cancelled plan", () => {
    // `installment_plans_one_active_per_invoice_uq` is PARTIAL, so one active
    // plan beside one cancelled plan on one invoice is legal — the re-planned
    // receivable. `v_asserted` is NULL on that write, so round 9's floor is
    // absent and the blinded recomputation decides.
    expect(M['F1c_r9_insert_cancelled_error'], 'the cancelled plan did not commit, so the bad state was never reached').toBeNull();
    expect(M['F1c_r9_bad_state']).toEqual({ flag: 'false', truth: 'true', plans: '2' });
  });

  it('and the read then serves the pre-S7 figure BYTE-IDENTICALLY — one coarse band at the invoice due date', () => {
    const served = rows(M['F1c_r9_aging_while_blind']);
    expect(errOf(M['F1c_r9_aging_while_blind']), 'the read refused instead of serving, so the defect was not reproduced').toBe('');
    expect(served).toEqual([{ bucket_no: 4, currency_code: 'ILS', txn_minor: '900000', base_minor: '900000', invoice_count: 1 }]);
    // AND IT IS THE PRE-S7 ANSWER, compared against the reading §B took of
    // this same invoice before any plan existed, rather than against a
    // literal somebody typed.
    expect(served).toEqual(rows(M['B_aging_no_plan']));
  });

  it('and it DOES NOT HEAL: the flag stays false and every sighted caller is refused for ever', () => {
    expect(M['F1c_r9_restore_ddl']).toEqual([null, null]);
    expect(M['F1c_r9_flag_after_restore']).toBe('false');
    expect(errOf(M['F1c_r9_aging_after_restore'])).toContain('installment.plan_fact_unflagged');
  });

  it('the ROUND-9 writer commits the same bad state from a non-active plan DELETE, with the reader never blinded', () => {
    // The DELETE direction of the same defect, and the one that measures
    // DERIVATION rather than probing: deleting a CANCELLED plan cannot change
    // whether an active plan exists, and round 9 recomputes and writes anyway.
    expect(M['F1c_r9_delete_blind_ddl']).toEqual([null, null]);
    expect(M['F1c_r9_delete_error'], 'the DELETE did not happen, so the arm measures nothing').toBeNull();
    expect(M['F1c_r9_delete_bad_state']).toEqual({ flag: 'false', truth: 'true', plans: '1' });
    expect(M['F1c_r9_delete_restore_ddl']).toEqual([null, null]);
    expect(M['F1c_r9_cleanup']).toBeNull();
    expect(M['F1c_r9_cleanup_flag']).toBe('false');
  });

  it('the SHIPPED writer REFUSES the blinded non-active INSERT by name, and no row survives', () => {
    expect(M['F1c_new_pre_commit']).toBeNull();
    expect(M['F1c_new_pre_flag']).toBe('true');
    expect(String(M['F1c_new_insert_cancelled_error'])).toContain('installment.plan_fact_blind');
    // The transaction never lands, so there is no desynchronised row to heal.
    expect(M['F1c_new_insert_state']).toEqual({ flag: 'true', truth: 'true', plans: '1' });
  });

  it('and the SHIPPED writer never commits a wrong fact on a non-active DELETE: it writes nothing, so the transaction is REFUSED instead', () => {
    // THERE IS NO PROBE ON THE DELETE PATH, so this arm measures the
    // DERIVATION and nothing else: the write set for «delete a plan that was
    // not active» is EMPTY, so the blinded recomputation has nothing to
    // decide and the flag is LEFT at `true`.
    //
    // THE TRANSACTION IS THEN REFUSED, AND THAT IS THE MEASUREMENT RATHER
    // THAN A DISAPPOINTMENT. The deferred verifier is blinded by the same
    // policy, so its own `EXISTS` reads `false` against a flag of `true` and
    // it refuses `plan_fact_desynchronised` — the degradation-to-refusal that
    // section 6a entry 8 claims for it, here measured. Round 9 under the
    // IDENTICAL blinding COMMITTED `{flag: false, truth: true}` because its
    // sync had already written the verifier's blinded reading into the column,
    // so the two agreed. One commits a fact that can never heal; the other
    // refuses the transaction. Nothing is lost: restoring the policy lets the
    // same DELETE through, which the sighted control below measures.
    expect(M['F1c_new_cancelled_sighted_error'], 'the cancelled plan to be deleted did not commit').toBeNull();
    expect(M['F1c_new_cancelled_sighted_state']).toEqual({ flag: 'true', truth: 'true', plans: '2' });
    expect(String(M['F1c_new_delete_error'])).toContain('installment.plan_fact_desynchronised');
    expect(M['F1c_new_delete_state'], 'the refused DELETE still moved the fact').toEqual({ flag: 'true', truth: 'true', plans: '2' });
    // THE SIGHTED CONTROL: the same DELETE, nothing blinded, commits and
    // leaves the fact exactly where the derivation says it belongs.
    expect(M['F1c_new_delete_sighted_error']).toBeNull();
    expect(M['F1c_new_delete_sighted_state']).toEqual({ flag: 'true', truth: 'true', plans: '1' });
    expect(errOf(M['F1c_new_aging_after']), 'the read refuses after a transition the writer correctly ignored').toBe('');
    expect(sum(rows(M['F1c_new_aging_after']))).toBe(TOTAL);
  });

  it('and the CONTROL: cancelling the ACTIVE plan still clears the flag, so this is a derivation and not a refusal to write', () => {
    expect(M['F1c_new_cancel_active_error']).toBeNull();
    expect(M['F1c_new_cancel_active_state']).toEqual({ flag: 'false', truth: 'false', plans: '1' });
    expect(M['F1c_new_cleanup']).toBeNull();
    expect(M['F1c_new_cleanup_flag']).toBe('false');
  });
});

describe('P4-S7 §F1-c′ the WRITER is the principal the predicate exempts (TL-P4-COORD-R43, F1-c prime)', () => {
  it('the blinding is ASYMMETRIC, and that is measured before anything is concluded from it', () => {
    expect(M['F1cp_r9_install']).toBeNull();
    expect(M['F1cp_pre_commit']).toBeNull();
    expect(M['F1cp_pre_flag']).toBe('true');
    expect(M['F1cp_blind_ddl']).toEqual([null, null]);
    // The CALLER still reads the plan. This is not §F1-b's blindness: only the
    // owner of the two DEFINER trigger functions has been blinded.
    expect(M['F1cp_app_still_sees'], 'the caller was blinded too, so this is not the writer-only case').toBe('1');
  });

  it('the ROUND-9 writer commits the bad state against a FULLY SIGHTED reader — the blindness its floor could not see', () => {
    expect(M['F1cp_r9_insert_error'], 'the write did not commit, so the state was never reached').toBeNull();
    expect(M['F1cp_r9_bad_state']).toEqual({ flag: 'false', truth: 'true', plans: '2' });
  });

  it('and the harm is a PERMANENT refusal of a healthy receivable, not a silent number', () => {
    expect(M['F1cp_r9_restore_ddl']).toEqual([null, null]);
    expect(M['F1cp_r9_flag_after_restore']).toBe('false');
    expect(errOf(M['F1cp_r9_aging_after_restore'])).toContain('installment.plan_fact_unflagged');
    expect(M['F1cp_r9_cleanup']).toBeNull();
    expect(M['F1cp_r9_cleanup_flag']).toBe('false');
  });

  it('the SHIPPED writer refuses it, because it now asks one question whose answer it already knows', () => {
    expect(M['F1cp_new_install']).toBeNull();
    expect(M['F1cp_new_pre_commit']).toBeNull();
    expect(String(M['F1cp_new_insert_error'])).toContain('installment.plan_fact_blind');
    expect(String(M['F1cp_new_insert_error'])).toContain('by primary key');
    expect(M['F1cp_new_state']).toEqual({ flag: 'true', truth: 'true', plans: '1' });
  });

  it('and the CONTROL commits — the probe refuses blindness, not non-active plan writes', () => {
    expect(M['F1cp_new_control_error']).toBeNull();
    expect(M['F1cp_new_control_state']).toEqual({ flag: 'true', truth: 'true', plans: '2' });
    expect(errOf(M['F1cp_new_control_aging'])).toBe('');
    expect(sum(rows(M['F1cp_new_control_aging']))).toBe(TOTAL);
    expect(M['F1cp_new_cleanup']).toBeNull();
    expect(M['F1cp_new_cleanup_flag']).toBe('false');
  });
});

describe("P4-S7 §F1-d obligation (a)'s RIGHT-HAND SIDE (TL-P4-COORD-R43, F1-d)", () => {
  it('the fixture is a DRAFT invoice with a LAWFUL schedule, and no row security is touched anywhere here', () => {
    expect(M['F1d_world'], 'the draft fixture did not build').toBeTruthy();
    expect(M['F1d_draft_status'], 'the fixture invoice is not a draft, so its money is not mutable and the premise is false').toBe('draft');
    expect(M['F1d_disable_ddl'], 'the new invoices trigger could not be disabled, so the counterfactual is not the pre-repair tree').toBeNull();
    expect(M['F1d_plan_on_draft_commits'], 'a plan against a draft invoice was refused, so the exploit has no subject').toBeNull();
    // A draft is invisible to the reader — which is why the PROMOTION is what
    // makes the broken state visible, and why the bump alone looks harmless.
    expect(errOf(M['F1d_pre_bump_aging'])).toBe('');
    expect(rows(M['F1d_pre_bump_aging'])).toEqual([]);
  });

  it('WITHOUT the invoices trigger the money bump COMMITS and the promotion carries a broken obligation (a)', () => {
    expect(M['F1d_bump_without_trigger'], "0075:561 should leave a draft invoice's money mutable").toBeNull();
    expect(M['F1d_promote'], 'the draft -> open promotion was refused').toBeNull();
    expect(M['F1d_state_after']).toEqual({ status: 'open', total: '1000000', schedule: '900000' });
  });

  it('and the reader then refuses that receivable FOR EVER — no DDL fault, no blinding, nothing to restore', () => {
    expect(errOf(M['F1d_aging_refused_forever'])).toContain('installment.plan_schedule_unreadable');
    // THE MESSAGE NOW NAMES THE STATE IT IS IN (`TL-P4-COORD-R43`, F3): this
    // is not «no readable installments row», and until this round it said so.
    expect(errOf(M['F1d_aging_refused_forever'])).toContain('does not equal');
    expect(M['F1d_enable_ddl']).toBeNull();
    // Re-enabling the trigger does not revisit a row that is already there.
    expect(errOf(M['F1d_aging_still_refused'])).toContain('installment.plan_schedule_unreadable');
  });

  it('WITH the invoices trigger the SAME money bump is REFUSED at COMMIT, by name, and the total does not move', () => {
    expect(M['F1d_plan_b_commits'], 'the second plan did not commit, so there is nothing to protect').toBeNull();
    expect(String(M['F1d_bump_with_trigger'])).toContain('installment.schedule_incomplete');
    expect(String(M['F1d_bump_with_trigger'])).toContain('(a) the schedule sums to 900000 and the invoice total is 1000000');
    expect(M['F1d_b_total_after_refusal'], 'the refused bump still landed').toBe('900000');
  });

  it('and BOTH CONTROLS commit, so the trigger discriminates instead of refusing every invoice write', () => {
    // (1) the same bump with the schedule corrected in the SAME transaction.
    expect(M['F1d_bump_with_fix_commits']).toBeNull();
    expect(M['F1d_b_state_after_fix']).toEqual({ total: '1000000', schedule: '1000000' });
    // (2) a money bump on a draft invoice with NO active plan.
    expect(M['F1d_bump_unplanned_commits']).toBeNull();
    expect(M['F1d_b_flag_after']).toBe('false');
    // (3) and the fixture is READABLE when obligation (a) is not in question.
    expect(M['F1d_a_plan_removed'], "the broken invoice's plan could not be removed").toBeNull();
    expect(M['F1d_promote_b']).toBeNull();
    expect(errOf(M['F1d_aging_answers'])).toBe('');
    // 1 000 000 for the invoice whose total moved and whose plan is now gone,
    // plus 1 100 000 for the one the trigger protected.
    expect(sum(rows(M['F1d_aging_answers']))).toBe(2100000n);
  });
});

interface MoveRow {
  readonly activeFirst: boolean;
  readonly build: string | null;
  readonly heap: readonly { id: string; status: string; ctid: string }[];
  readonly moveError: string | null;
  readonly after: { flag: string; truth: string; plans: string };
  readonly clean: string | null;
  readonly flagAfterClean: string;
}
const moveRows = (): readonly MoveRow[] => (M['F4_single_statement_moves'] as readonly MoveRow[] | undefined) ?? [];
const twoRow = (k: string): { build: string | null; moveError: string | null; after: { flag: string; truth: string; plans: string } } =>
  M[k] as { build: string | null; moveError: string | null; after: { flag: string; truth: string; plans: string } };

describe('P4-S7 §Z ROUND 11 STEP ZERO — the status-predicated blinding against a flag that is already false', () => {
  it('the subject is the body the SPECIFICATION installed, and the fixture starts where the question needs it', () => {
    expect(M['Z_installed_body_is_shipped'], 'the sync body under test is not the one the specification installs').toBe(true);
    expect(M['Z_pre']).toEqual({ flag: 'false', truth: 'false', plans: '0' });
  });

  it('THE ANSWER: the blinded non-active INSERT COMMITS, and the fact it leaves behind is CORRECT', () => {
    // This is the direction the specification admits «degrades to a pass», and
    // it does pass — with the right answer. The EMPTY write set wrote nothing,
    // so there was nothing for a blinded read to decide.
    expect(M['Z1_blind_ddl']).toEqual([null, null]);
    expect(M['Z1_insert_cancelled'], 'the blinded non-active INSERT was refused, which is not what was measured').toBeNull();
    expect(M['Z1_state']).toEqual({ flag: 'false', truth: 'false', plans: '1' });
    expect(M['Z1_state_after_restore']).toEqual({ flag: 'false', truth: 'false', plans: '1' });
  });

  it('and the reader ANSWERS over it — no refusal, because nothing is wrong', () => {
    expect(errOf(M['Z1_aging'])).toBe('');
    expect(rows(M['Z1_aging']).length).toBeGreaterThan(0);
  });

  it('NO WRONG FACT CAN BE WRITTEN THAT WAY: every transition that would write true is REFUSED by the probe, under both blinding shapes', () => {
    // A transition that writes `true` carries an ACTIVE `NEW` row, and an
    // ACTIVE row is exactly what this policy hides — so the one case where the
    // probe still bites is the one that matters.
    expect(String(M['Z2_insert_active_all_blind'])).toContain('installment.plan_fact_blind');
    expect(String(M['Z3_insert_active_writer_blind'])).toContain('installment.plan_fact_blind');
    expect(M['Z3_state']).toEqual({ flag: 'false', truth: 'false', plans: '1' });
  });

  it('NON-VACUITY: under the definer-only shape the WRITING principal still sees the plan, so the blinding really is asymmetric', () => {
    expect(M['Z3_mig_still_sees']).toBe('1');
  });

  it("F-3's own case, flag TRUE: the empty write set passes the probe and the DEFERRED VERIFIER refuses — by the wrong name, which is F-3", () => {
    expect(M['Z4_active_commits']).toBeNull();
    expect(M['Z4_pre']).toEqual({ flag: 'true', truth: 'true', plans: '2' });
    expect(String(M['Z4_blinded_delete_cancelled'])).toContain('installment.plan_fact_desynchronised');
    expect(M['Z4_state'], 'the refused transaction changed the fact').toEqual({ flag: 'true', truth: 'true', plans: '2' });
  });
});

describe('P4-S7 §F5 the INSERT-branch derivation is load-bearing, and the case is NOT the probe', () => {
  it('the counterfactual is the ROUND-9 writer and the shipped body is not it', () => {
    expect(M['F5_r9_install']).toBeNull();
    expect(M['F1b_counterfactual_rewrote']).toBe(true);
  });

  it('the ROUND-9 INSERT branch COMMITS {flag: false, active plan: 1} with the probe PASSING — the mutation round 10 reported staying green', () => {
    expect(M['F5_r9_insert_cancelled'], 'round 9 was refused here, so this is not the case F-5 names').toBeNull();
    expect(M['F5_r9_state']).toEqual({ flag: 'false', truth: 'true', plans: '3' });
  });

  it('and it DOES NOT HEAL: the flag stays false and the sighted reader is refused for ever, by name', () => {
    expect(M['F5_r9_state_after_restore']).toEqual({ flag: 'false', truth: 'true', plans: '3' });
    expect(errOf(M['F5_r9_aging_after_restore'])).toContain('installment.plan_fact_unflagged');
  });

  it('the SHIPPED derivation refuses the identical construction and leaves the fact ALONE', () => {
    expect(M['F5_new_install']).toBeNull();
    expect(M['F5_pre_new']).toEqual({ flag: 'true', truth: 'true', plans: '2' });
    expect(String(M['F5_new_insert_cancelled'])).toContain('installment.plan_fact_desynchronised');
    expect(M['F5_new_state'], 'the shipped writer moved the fact').toEqual({ flag: 'true', truth: 'true', plans: '2' });
  });

  it('and the CONTROL: with everything restored the reader ANSWERS, so this is a discrimination and not a reader that refuses this customer', () => {
    expect(errOf(M['F5_new_aging'])).toBe('');
    expect(rows(M['F5_new_aging']).length).toBeGreaterThan(0);
  });
});

describe('P4-S7 §F4 the one-active exclusion: ONE NAME, BOTH HEAP ORDERS', () => {
  it('the fixture is back to the base case before the orders are built, so the counts below depend on nothing above', () => {
    expect(M['F4_reset']).toBeNull();
    expect(M['F4_pre']).toEqual({ flag: 'false', truth: 'false', plans: '0' });
  });

  it('both heap orders were really built, three times each, and the order is MEASURED from ctid and not intended', () => {
    const rs = moveRows();
    expect(rs.length).toBe(6);
    for (const r of rs) {
      expect(r.build, 'the move fixture did not build').toBeNull();
      expect(r.heap.length, 'the pair is not two rows').toBe(2);
      expect(r.heap[0]?.status, `heap order disagrees with the intent activeFirst=${r.activeFirst}`).toBe(r.activeFirst ? 'active' : 'cancelled');
      expect(r.clean).toBeNull();
      expect(r.flagAfterClean).toBe('false');
    }
    expect(rs.filter((r) => r.activeFirst).length).toBe(3);
    expect(rs.filter((r) => !r.activeFirst).length).toBe(3);
  });

  it('EVERY order is refused installment.plan_active_conflict — the split into plan_fact_blind and 23505 is gone', () => {
    for (const r of moveRows()) {
      expect(String(r.moveError), `activeFirst=${r.activeFirst}`).toContain('installment.plan_active_conflict');
      expect(String(r.moveError), 'the false diagnosis is back').not.toContain('plan_fact_blind');
      // The INDEX is named inside the message as one of the two causes, which
      // is correct; what must be gone is the raw `23505` the cancelled-first
      // order used to produce instead of a named refusal.
      expect(String(r.moveError), 'the raw unique violation is back').not.toContain('duplicate key value');
    }
  });

  it('and the message is TRUE of the state it refuses: another plan of this invoice IS active, and it says which escape to take', () => {
    const m = String(moveRows()[0]?.moveError);
    expect(m).toMatch(/another plan of this invoice is active|already that invoice's active plan/);
    expect(m, 'the writer is not told the two-statement route').toMatch(/cancel the outgoing plan in one statement/);
  });

  it('the refused statement changed NOTHING — the state is the one the fixture built', () => {
    for (const r of moveRows()) expect(r.after).toEqual({ flag: 'true', truth: 'true', plans: '2' });
  });

  it('HALF TWO, both orders: `cancel, then activate` COMMITS and `activate, then cancel` meets the SAME name at the FIRST statement', () => {
    expect(twoRow('F4_cancel_then_activate').build).toBeNull();
    expect(twoRow('F4_cancel_then_activate').moveError, 'the documented escape no longer commits').toBeNull();
    expect(twoRow('F4_cancel_then_activate').after).toEqual({ flag: 'true', truth: 'true', plans: '2' });
    expect(twoRow('F4_activate_then_cancel').build).toBeNull();
    expect(String(twoRow('F4_activate_then_cancel').moveError)).toContain('installment.plan_active_conflict');
  });

  it('AND THE EXCLUSION IS NOT THE MECHANISM: blinded, it passes and the PARTIAL UNIQUE INDEX refuses instead', () => {
    expect(M['F4_live_active_commits']).toBeNull();
    expect(String(M['F4_second_active_sighted'])).toContain('installment.plan_active_conflict');
    expect(String(M['F4_second_active_blinded']), 'the physical index did not refuse the second active plan').toContain(
      'installment_plans_one_active_per_invoice_uq',
    );
    expect(M['F4_state_after']).toEqual({ flag: 'true', truth: 'true', plans: '1' });
  });
});

describe('P4-S7 §Z6 the two-fault composite — and both one-fault controls', () => {
  it('the fixture is back to the base case before the composite is built', () => {
    expect(M['Z6_cleanup']).toBeNull();
    expect(M['Z6_pre']).toEqual({ flag: 'false', truth: 'false', plans: '0' });
  });

  it('CONTROL — the disabled trigger ALONE is refused at COMMIT by the deferred verifier, by name', () => {
    expect(M['Z6_disable_sync']).toBeNull();
    expect(String(M['Z6_control_trigger_only'])).toContain('installment.plan_fact_desynchronised');
    expect(M['Z6_control_state']).toEqual({ flag: 'false', truth: 'false', plans: '0' });
  });

  it('TOGETHER THEY COMMIT a false flag beside a live active plan — the verifier is not a backstop while that policy is installed', () => {
    expect(M['Z6_two_faults'], 'the composite was refused, so this claim has no subject').toBeNull();
    expect(M['Z6_two_faults_state']).toEqual({ flag: 'false', truth: 'true', plans: '1' });
  });

  it('and it FAILS CLOSED one layer out: with every fault removed the READ refuses that receivable BY NAME rather than serving a number', () => {
    expect(M['Z6_enable_sync']).toBeNull();
    expect(M['Z6_state_all_restored']).toEqual({ flag: 'false', truth: 'true', plans: '1' });
    expect(errOf(M['Z6_aging_all_restored'])).toContain('installment.plan_fact_unflagged');
    expect(rows(M['Z6_aging_all_restored']).length).toBe(0);
  });
});

describe('P4-S7 §F6 the two advertised sync refusals, measured as the principal that writes', () => {
  it('a business change is refused 42501 by business_isolation_update, and NEVER installment.plan_fact_unwritable', () => {
    expect(String(M['F6_business_change_migrator'])).toContain('business_isolation_update');
    expect(String(M['F6_business_change_migrator'])).not.toContain('plan_fact_unwritable');
  });

  it('and not even the SUPERUSER reaches that raise — a foreign key answers first, so its reachability is OPEN and is claimed nowhere', () => {
    expect(String(M['F6_business_change_superuser'])).toMatch(/installment_plans_invoice_fk|installments_plan_fk/);
    expect(String(M['F6_business_change_superuser'])).not.toContain('plan_fact_unwritable');
  });

  it('the CROSS-TENANT plan is refused STRUCTURALLY in both constructions, and by neither the ROW_COUNT check nor its name', () => {
    expect(String(M['F6_cross_tenant_divergent_ctx'])).toContain('installment_plans_tenant_fk');
    expect(String(M['F6_cross_tenant_own_ctx'])).toContain('row-level security policy');
    for (const k of ['F6_cross_tenant_divergent_ctx', 'F6_cross_tenant_own_ctx']) expect(String(M[k])).not.toContain('plan_fact_unwritable');
  });

  it('and every policy this file replaced is back, exactly one of it', () => {
    expect(M['F6_teardown']).toBeNull();
    expect(M['F6_teardown_state']).toEqual({ flag: 'false', truth: 'false', plans: '0' });
    expect(M['F6_policies']).toBe('1');
  });
});

/**
 * EVERY `installment.*` NAME THIS SPECIFICATION RAISES FROM A FUNCTION BODY,
 * discovered from the text rather than listed by hand. A plpgsql body in this
 * file is delimited by `$fn$`, so the bodies are the odd segments of a split on
 * that tag, and a `RAISE EXCEPTION 'installment.x'` inside one is reachable by
 * whatever calls it. The `DO` block at the end of the file is NOT a function
 * body and its 35 raises are therefore not in this set.
 */
const RAISED_FROM_A_BODY: readonly string[] = (() => {
  const segments = SPEC.split('$fn$');
  const found = new Set<string>();
  for (let i = 1; i < segments.length; i += 2) {
    for (const m of (segments[i] ?? '').matchAll(/RAISE EXCEPTION '(installment\.[a-z_]+)/g)) found.add(m[1] as string);
  }
  return [...found].sort();
})();

/**
 * The names raised from a body and DELIBERATELY not registered, each with the
 * reason the registry states. A name that is neither registered nor here fails
 * the law below — which is the whole point: the next person to add a refusal to
 * this specification has to say which it is.
 */
const DELIBERATELY_UNREGISTERED: Readonly<Record<string, string>> = {
  'installment.plan_fact_unwritable':
    'TL-P4-COORD-R46 F-6: both raises are pre-empted — business_isolation_update (42501) / installment_plans_invoice_fk (23503) for the business-change arm, installment_plans_tenant_fk or the plan relation WITH CHECK for the ROW_COUNT arm. Reachability OPEN; §F6 measures it.',
};

describe('P4-S7 §T the refusal names are in the TypeScript catalogue (TL-P4-COORD-R46, F-4)', () => {
  it('NON-VACUITY: the specification really does raise these names from function bodies, and the migration-time ones are NOT in the set', () => {
    expect(RAISED_FROM_A_BODY.length, 'no installment.* raise was found inside a function body — the discovery is broken').toBeGreaterThan(5);
    expect(RAISED_FROM_A_BODY).not.toContain('installment.migration_end_state_invalid');
    expect(RAISED_FROM_A_BODY).not.toContain('installment.authority_leak');
    expect(RAISED_FROM_A_BODY).not.toContain('installment.derived_truth_stored');
  });

  it('EVERY one of them is either REGISTERED or deliberately excluded with a reason — no name falls through silently', () => {
    const unaccounted = RAISED_FROM_A_BODY.filter((c) => !isInstallmentInternalInvariant(c) && !Object.hasOwn(DELIBERATELY_UNREGISTERED, c));
    expect(unaccounted, 'a refusal this specification raises is in no catalogue and in no exclusion list').toEqual([]);
  });

  it('and the registry holds NOTHING the specification does not raise from a body', () => {
    const phantom = INSTALLMENT_INTERNAL_INVARIANT_CODES.filter((c) => !RAISED_FROM_A_BODY.includes(c));
    expect(phantom, 'the catalogue classifies a refusal nobody raises').toEqual([]);
  });

  it('the four names the round-10 ruling found NOWHERE in the TypeScript tree are all registered now', () => {
    for (const c of [
      'installment.plan_fact_blind',
      'installment.plan_fact_unflagged',
      'installment.schedule_incomplete',
      'installment.plan_schedule_unreadable',
    ]) {
      expect(isInstallmentInternalInvariant(c), c).toBe(true);
    }
    // And F-4's own name, which is the refusal a plan writer meets.
    expect(isInstallmentInternalInvariant('installment.plan_active_conflict')).toBe(true);
  });

  it('the recognizer takes the CODE out of the real message and nothing after it', () => {
    // The messages are the ones measured above, not invented ones.
    for (const raw of [
      String(M['Z2_insert_active_all_blind']),
      String(M['Z4_blinded_delete_cancelled']),
      String(errOf(M['Z6_aging_all_restored'])),
      String((M['F4_single_statement_moves'] as readonly MoveRow[])[0]?.moveError),
      String(M['F1d_bump_with_trigger']),
    ]) {
      const code = parseDatabaseInstallmentInternalCode(new Error(raw));
      expect(code, raw.slice(0, 60)).not.toBeNull();
      expect(isInstallmentInternalInvariant(code as string), raw.slice(0, 60)).toBe(true);
      expect(raw.startsWith(`${code as string}:`), 'the recognizer took more or less than the code').toBe(true);
    }
  });

  it('and the MERCHANT recognizer does not match them, so none can be rendered as a business outcome', () => {
    for (const c of INSTALLMENT_INTERNAL_INVARIANT_CODES) expect(parseDatabaseSellingCode(new Error(`${c}: something`)), c).toBeNull();
  });

  it('an UNREGISTERED installment name is not treated as an invariant — the registry is closed, not a prefix test', () => {
    expect(parseDatabaseInstallmentInternalCode(new Error('installment.migration_end_state_invalid: x'))).toBe('installment.migration_end_state_invalid');
    expect(isInstallmentInternalInvariant('installment.migration_end_state_invalid')).toBe(false);
    expect(isInstallmentInternalInvariant('installment.plan_fact_unwritable')).toBe(false);
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
