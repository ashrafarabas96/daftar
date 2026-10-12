/**
 * P4-S7 — THE CONCURRENCY CLASS, THE RUNTIME GUARD, AND THE RED PROOFS OF
 * THE LAWS `TL-P4-COORD-R50` ORDERED.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * Eleven rounds of this slice were judged single-threaded. The round-11
 * challenger ran the first two-writer measurements and found C1's standing
 * defect alive: with `installment_plans_one_active_per_invoice_uq` present but
 * NOT ENFORCING — `indisvalid = false, indisready = false`, the state an
 * interrupted `CREATE UNIQUE INDEX CONCURRENTLY` leaves and one `pg_indexes`
 * renders identically to the correct one — two ORDINARY CONCURRENT plan
 * creations on one invoice both committed, and `customer_ar_aging` then served
 * the PRE-INSTALLMENT figure, byte-identical to the no-plan answer, with no
 * refusal of any kind. Single-threaded the same fault is refused. The
 * challenger's own sentence is the finding:
 *
 *   «The reader's arithmetic test is predicated on the same index as the
 *    writer's derivation, and neither has a runtime guard.»
 *
 * The specification's repair is a COUNT over the rows the transaction can see,
 * in the writer, in the deferred verifier and in the reader; an invoice-row
 * lock taken FIRST so the cross-transaction race is refused by name instead of
 * by the index; and apply-time laws that read the catalogue flags they name.
 * This suite is the measurement of all of it, and of the red half of every
 * law it adds.
 *
 * ── THE DISCIPLINE EVERY CASE HERE OBEYS ──────────────────────────────────
 *
 * 1. NO SLEEP ESTABLISHES ANYTHING. Blocking is ASSERTED from the catalogue —
 *    `pg_stat_activity.state = 'active' AND wait_event_type = 'Lock'`,
 *    `pg_blocking_pids()`, and the UNGRANTED rows of `pg_locks` for that pid.
 *    Polling is the sampling method; the assertion is on the observed wait.
 *    A NON-blocking outcome is proved the other way, by sampling across a
 *    window and recording that `Lock` was never observed. This is the bar the
 *    round-11 challenger set and `P4-AL-42` requires.
 * 2. EVERY ACTOR IS A REAL BACKEND. One `pg.Client` each, its own
 *    `pg_backend_pid()`. No JavaScript stands in for a transaction.
 * 3. EVERY LAW COMES IN TWO HALVES. The planted defect and the shipped
 *    control, in the same database, adjacent. A suite that only asserts
 *    refusals cannot tell a working guard from one that refuses everything.
 * 4. THE SPECIFICATION IS NOT IDEMPOTENT. It is applied ONCE to a scratch
 *    database built by the real runner, and the database is dropped. Nothing
 *    re-applies it; a body that must be restored is restored from
 *    `pg_get_functiondef`, read BEFORE it is replaced.
 *
 * ── THE TWO DISCLOSED FIXTURE DEPARTURES, THE SAME AS §F1's ───────────────
 *
 * `invoices_binding_fk` and `sales_binding_fk` dropped and the `sales` USER
 * triggers disabled for the seeding transaction — a real accounting binding
 * needs the whole posting path and the subject here is row security, a
 * denormalised flag and a lock order. And `GRANT EXECUTE ON
 * supplier_ap_release` TO `daftar_app` is PRE-APPLIED: that is patch request
 * PR-6, a declared blocker, and without it `daftar_app` cannot reach the
 * schedule arms at all. EVERY AGING FIGURE IN THIS FILE IS THEREFORE
 * CONDITIONAL ON AN UNAPPLIED PATCH REQUEST, which is a standing property of
 * this slice's evidence and not a property of this suite.
 *
 * Every policy and every trigger on `invoices`, `installment_plans` and
 * `installments` stays in place except where a case names its own mutation and
 * restores it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb, urlOf } from '../helpers/scratch-db';

const DB = 'daftar_s7r12_conc';
const SPEC_PATH = join(__dirname, '..', '..', 'infrastructure', 'database', 'specifications', 'p4s7-installment-aging.spec.sql');
const SPEC = readFileSync(SPEC_PATH, 'utf8');
const SHA = 'c'.repeat(64);
const STAMP = '2026-01-02T00:00:00Z';
const BUCKETS = [30, 60, 90];

/**
 * THE END-STATE BLOCK, SLICED ON A NEWLINE-ANCHORED MARKER.
 *
 * The round-11 challenger's own disclosed method defect: it sliced on the
 * first occurrence of the literal `DO $end$`, which appears inside the
 * specification's PROSE, and every ratchet call it took in that pass died on
 * `syntax error at or near "`"`. Its own non-vacuity control caught it, not
 * its reading. Anchoring on `\nDO $end$` and `\n$end$;` is what the fourth
 * pass used, and §A1 below is the non-vacuity control that makes the anchor
 * load-bearing rather than assumed.
 */
function endStateBlock(): string {
  const a = SPEC.indexOf('\nDO $end$');
  const b = SPEC.indexOf('\n$end$;', a);
  if (a < 0 || b < 0) throw new Error('the end-state block could not be sliced');
  return SPEC.slice(a + 1, b + '\n$end$;'.length);
}

interface Outcome {
  readonly error: string | null;
  readonly rows: readonly Record<string, unknown>[];
}
interface BlockedReading {
  readonly blocked: boolean;
  readonly samples: number;
  readonly state: string | null;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
  readonly blockers: string | null;
  readonly ungranted: readonly Record<string, unknown>[];
  readonly distinct: readonly string[];
}

const M: Record<string, unknown> = {};
let db: ScratchDb;
let sup: Pool;
let mig: Pool;
let app: Pool;
let world: {
  tenantId: string;
  businessId: string;
  customerId: string;
  customerId2: string;
  invoiceIds: readonly string[];
  f3InvoiceId: string;
  userId: string;
};
let specError: string | null = null;
let shippedSync = '';
let shippedAging = '';

function err(e: unknown): string {
  const x = e as { code?: string; message?: string };
  return `${x.code ?? '?'}: ${(x.message ?? String(e)).split('\n')[0]}`;
}

async function inCtx(pool: Pool, ctx: Record<string, string>, qs: readonly { sql: string; params?: readonly unknown[] }[]): Promise<Outcome> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(ctx)) await c.query(`SELECT set_config($1,$2,true)`, [k, v]);
    let rows: readonly Record<string, unknown>[] = [];
    for (const q of qs) rows = (await c.query(q.sql, [...(q.params ?? [])])).rows as Record<string, unknown>[];
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

/**
 * The aging, as `daftar_app`, for a customer. IT IS A PER-CUSTOMER READ, which
 * is why this file carries TWO customers: the F-3 construction in §C
 * deliberately commits a state that DOES NOT HEAL — `{flag: false, active
 * plan: 1}` — and a customer carrying that state refuses
 * `plan_fact_unflagged` on every later read. Putting it on its own customer is
 * what keeps §D's refusals attributable to §D's own fault instead of to §C's
 * leftovers. (The first pass of this file did not, and three §D readings were
 * measurements of §C. Disclosed, and re-taken.)
 */
async function aging(customerId?: string): Promise<Outcome> {
  return inCtx(app, APP_CTX(), [
    {
      sql: `SELECT * FROM public.customer_ar_aging($1,$2,$3::DATE,$4::INTEGER[]) ORDER BY bucket_no`,
      params: [world.businessId, customerId ?? world.customerId, '2026-06-30', BUCKETS],
    },
  ]);
}

/**
 * CANCEL THE ONE ACTIVE PLAN OF AN INVOICE THROUGH THE DOCUMENTED ROUTE, as
 * `daftar_migrator` with the session context the policies name.
 *
 * NOT as the superuser. The superuser bypasses row security on its own reads,
 * but `installment_plan_fact_sync()` is a SECURITY DEFINER owned by
 * `daftar_accounting_internal`, which is neither a superuser nor
 * `rolbypassrls` — so its `UPDATE public.invoices` runs under that relation's
 * `tenant_membership` and `business_isolation_update` policies and reaches
 * ZERO rows when the session carries no `app.tenant_id`. A superuser
 * `UPDATE installment_plans` is therefore refused
 * `installment.plan_fact_unwritable`, and the first pass of this file used one
 * — which left stale active plans behind and turned four concurrency readings
 * into measurements of a fixture that had not been cleared. Disclosed, and
 * re-taken through this helper.
 */
async function clearActive(invoiceId: string): Promise<string | null> {
  return (
    await inCtx(mig, APP_CTX(), [{ sql: `UPDATE installment_plans SET status = 'cancelled' WHERE invoice_id = $1 AND status = 'active'`, params: [invoiceId] }])
  ).error;
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

/** DDL as the superuser — only for the catalogue states no principal can reach. */
async function sudo(sql: string): Promise<string | null> {
  try {
    await sup.query(sql);
    return null;
  } catch (e) {
    return err(e);
  }
}

/**
 * Several statements as the superuser in ONE transaction. A plant that must be
 * removed again has to be removed ATOMICALLY: D1's first pass deleted the
 * planted schedule and the planted plan as two autocommitted statements, and
 * the first of them is refused at its own COMMIT by the DEFERRED constraint
 * trigger `installments_schedule_complete` -- a plan whose schedule has just
 * been emptied does not sum to its total. So the plant survived its own
 * removal, the invoice ended the case carrying two plans, and D1's
 * end-state comparison measured that instead of the subject. Disclosed, and
 * re-taken through this helper, which also disables the USER triggers on BOTH
 * relations: `DISABLE TRIGGER USER` on `installment_plans` never reached the
 * constraint trigger on `installments`, which is where the refusal came from.
 */
async function sudoTx(sqls: readonly string[]): Promise<string | null> {
  const c = await sup.connect();
  try {
    await c.query('BEGIN');
    for (const q of sqls) await c.query(q);
    await c.query('COMMIT');
    return null;
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch {
      /* the connection is already unusable; the error below is the report */
    }
    return err(e);
  } finally {
    c.release();
  }
}

/** Run the sliced end-state block as `daftar_migrator`: `null` is OK. */
async function ratchet(): Promise<string | null> {
  return ddl(endStateBlock());
}

async function state(invoiceId: string): Promise<Record<string, unknown>> {
  const r = await sup.query(
    `SELECT (SELECT has_active_installment_plan::text FROM invoices WHERE id = $1) AS flag,
            (SELECT count(*)::int FROM installment_plans WHERE invoice_id = $1 AND status = 'active') AS active_plans,
            (SELECT count(*)::int FROM installment_plans WHERE invoice_id = $1) AS plans`,
    [invoiceId],
  );
  return r.rows[0] as Record<string, unknown>;
}

/**
 * A dedicated backend with its own transaction. Every concurrency actor below
 * is one of these; `pid` is its real `pg_backend_pid()`.
 */
class Actor {
  readonly client: Client;
  pid = 0;
  constructor(
    readonly name: string,
    role: 'daftar_migrator' | 'daftar_app' | 'postgres',
  ) {
    this.client = new Client({ connectionString: urlOf(DB, role) });
  }
  async open(iso: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED'): Promise<void> {
    await this.client.connect();
    this.pid = Number((await this.client.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]?.p);
    await this.client.query(`BEGIN ISOLATION LEVEL ${iso}`);
    await this.client.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.business_id',$2,true)`, [world.tenantId, world.businessId]);
  }
  async q(sql: string, params: readonly unknown[] = []): Promise<string | null> {
    try {
      await this.client.query(sql, [...params]);
      return null;
    } catch (e) {
      return err(e);
    }
  }
  /** Fire a statement WITHOUT awaiting it, so the caller can observe the block. */
  fire(sql: string, params: readonly unknown[] = []): { promise: Promise<string | null>; settled: () => boolean } {
    let done = false;
    const promise = this.client
      .query(sql, [...params])
      .then(() => {
        done = true;
        return null;
      })
      .catch((e: unknown) => {
        done = true;
        return err(e);
      });
    return { promise, settled: () => done };
  }
  async end(): Promise<void> {
    await this.client.query('ROLLBACK').catch(() => undefined);
    await this.client.end().catch(() => undefined);
  }
}

/**
 * ASSERT A LOCK WAIT FROM THE CATALOGUE. Samples `pg_stat_activity` until the
 * pid is `active` and waiting on a `Lock`, then reads the UNGRANTED `pg_locks`
 * rows for it. Returns `blocked: false` with the distinct states observed when
 * it never waits, which is how a NON-blocking outcome is proved.
 */
async function awaitLock(pid: number, ms = 2500): Promise<BlockedReading> {
  const seen = new Set<string>();
  let samples = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    samples += 1;
    const r = await sup.query<{ state: string | null; wait_event_type: string | null; wait_event: string | null; blockers: string }>(
      `SELECT state, wait_event_type, wait_event, pg_blocking_pids(pid)::text AS blockers FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    const row = r.rows[0];
    if (row === undefined) break;
    seen.add(`${row.state}/${row.wait_event_type}`);
    if (row.state === 'active' && row.wait_event_type === 'Lock') {
      const l = await sup.query(`SELECT locktype, mode, relation::regclass::text AS rel FROM pg_locks WHERE pid = $1 AND NOT granted`, [pid]);
      return {
        blocked: true,
        samples,
        state: row.state,
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event,
        blockers: row.blockers,
        ungranted: l.rows as Record<string, unknown>[],
        distinct: [...seen],
      };
    }
    await new Promise<void>((res) => {
      setTimeout(res, 25);
    });
  }
  return { blocked: false, samples, state: null, waitEventType: null, waitEvent: null, blockers: null, ungranted: [], distinct: [...seen] };
}

/** The seven triggers this slice installs, read from the catalogue and never from a list in this file. */
async function sevenTriggers(): Promise<readonly { readonly tgname: string; readonly rel: string }[]> {
  return (
    await sup.query<{ tgname: string; rel: string }>(
      `SELECT t.tgname, t.tgrelid::regclass::text AS rel
         FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid JOIN pg_namespace n ON n.oid = f.pronamespace
        WHERE NOT t.tgisinternal AND n.nspname = 'public'
          AND f.proname IN ('installment_plan_fact_sync','installment_plan_fact_verify',
                            'installment_plan_active_exclusive','installment_schedule_verify')
        ORDER BY t.tgrelid::regclass::text, t.tgname`,
    )
  ).rows;
}

const PLAN_INSERT = `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
   VALUES ($1,$2,$3,$4,$5,$6,100000,'2026-01-02'::DATE,$7,gen_random_uuid())`;
const SCHED_INSERT = `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
   VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-02-02'::DATE,400000),
          ($1,$2,gen_random_uuid(),$3,2,'2026-06-02'::DATE,400000)`;

function planArgs(planId: string, invoiceId: string, status = 'active'): readonly unknown[] {
  return [world.tenantId, world.businessId, planId, invoiceId, world.customerId, status, world.userId];
}

/** Write one lawful active plan with its schedule, in one transaction, as `daftar_migrator`. */
async function commitPlan(invoiceId: string, status = 'active'): Promise<{ error: string | null; planId: string }> {
  const planId = randomUUID();
  const r = await inCtx(mig, APP_CTX(), [
    { sql: PLAN_INSERT, params: planArgs(planId, invoiceId, status) },
    { sql: SCHED_INSERT, params: [world.tenantId, world.businessId, planId] },
  ]);
  return { error: r.error, planId };
}

beforeAll(async () => {
  db = await createScratchDb(DB, { migratorOwned: true });
  sup = new Pool({ connectionString: urlOf(DB, 'postgres'), max: 4 });
  mig = new Pool({ connectionString: urlOf(DB, 'daftar_migrator'), max: 3 });
  app = new Pool({ connectionString: urlOf(DB, 'daftar_app'), max: 3 });
  M['applied'] = db.applied.length;
  M['head'] = db.applied[db.applied.length - 1];

  const c = await sup.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_binding_fk');
    await c.query('ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_binding_fk');
    await c.query('ALTER TABLE sales DISABLE TRIGGER USER');
    const one = async (sql: string, p: readonly unknown[] = []): Promise<string> => String((await c.query<{ id: string }>(sql, [...p])).rows[0]?.id);
    const tenantId = await one('INSERT INTO tenants DEFAULT VALUES RETURNING id');
    const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','S7 R12') RETURNING id`, [
      `s7r12-${process.pid}@test.daftar.local`,
    ]);
    const businessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1,'R12 Books',$2,'PS','ILS','Asia/Hebron') RETURNING id`,
      [tenantId, `s7r12-${process.pid}`],
    );
    const branchId = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1,'Main',true) RETURNING id`, [businessId]);
    const warehouseId = await one(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1,$2,'WH',true) RETURNING id`, [
      businessId,
      branchId,
    ]);
    const customerId = randomUUID();
    const customerId2 = randomUUID();
    for (const [id, name] of [
      [customerId, 'R12 Customer'],
      [customerId2, 'R12 F3 Customer'],
    ] as const) {
      await c.query(
        `INSERT INTO customers (tenant_id,business_id,id,name,status,revision,create_intent_sha256,last_intent_sha256,business_transaction_id,created_by,updated_by)
         VALUES ($1,$2,$3,$6,'active',1,$4,$4,gen_random_uuid(),$5,$5)`,
        [tenantId, businessId, id, SHA, userId, name],
      );
    }
    // FIVE INVOICES: four for the main customer, one for the F-3 customer.
    // Each §E case gets an invoice of its own, because a plan write that is
    // refused still leaves the invoice in whatever state the previous case
    // left it, and a concurrency reading taken on a dirty invoice measures the
    // previous case.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const owner = i === 4 ? customerId2 : customerId;
      const saleId = randomUUID();
      await c.query(
        `INSERT INTO sales (tenant_id,business_id,id,customer_id,branch_id,warehouse_id,status,settlement_mode,document_date,currency_code,
                            subtotal_txn_minor,discount_txn_minor,total_txn_minor,total_base_minor,source_to_base_rate,rate_source,rate_timestamp,
                            customer_name_snapshot,commit_intent_sha256,confirmed_by,confirmed_at,business_transaction_id,created_by,binding_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed','credit','2026-01-02','ILS',900000,0,900000,900000,1,'base',$7::timestamptz,'R12 Customer',$8,$9,$7::timestamptz,gen_random_uuid(),$9,$3)`,
        [tenantId, businessId, saleId, owner, branchId, warehouseId, STAMP, SHA, userId],
      );
      const invoiceId = randomUUID();
      await c.query(
        `INSERT INTO invoices (tenant_id,business_id,id,sale_id,customer_id,branch_id,document_kind,document_number,number_seq,period,issue_date,due_date,
                               currency_code,status,subtotal_txn_minor,discount_txn_minor,tax_minor,total_txn_minor,total_base_minor,source_to_base_rate,
                               rate_source,rate_timestamp,customer_name_snapshot,issue_intent_sha256,business_transaction_id,created_by,binding_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'invoice',$10,$11,'2026','2026-01-02','2026-01-02','ILS','open',900000,0,0,900000,900000,1,'base',$7::timestamptz,
                 'R12 Customer',$8,gen_random_uuid(),$9,$3)`,
        [tenantId, businessId, invoiceId, saleId, owner, branchId, STAMP, SHA, userId, `INV-${i + 1}`, i + 1],
      );
      ids.push(invoiceId);
    }
    // PR-6, PRE-APPLIED AND DISCLOSED (module header).
    await c.query(`GRANT EXECUTE ON FUNCTION public.supplier_ap_release(BIGINT,BIGINT,BIGINT,BIGINT) TO daftar_app`);
    await c.query('COMMIT');
    await c.query('ALTER TABLE sales ENABLE TRIGGER USER');
    world = {
      tenantId,
      businessId,
      customerId,
      customerId2,
      invoiceIds: ids.slice(0, 4),
      f3InvoiceId: ids[4] as string,
      userId,
    };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw new Error(`the fixture world did not build: ${err(e)}`);
  } finally {
    c.release();
  }
  M['world'] = world;

  try {
    await mig.query(SPEC);
  } catch (e) {
    specError = err(e);
  }
  M['specError'] = specError;
  if (specError !== null) {
    writeFileSync('/tmp/claude-0/r12/conc.json', JSON.stringify(M, null, 2));
    return;
  }
  shippedSync = (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.installment_plan_fact_sync()'::regprocedure) AS d`)).rows[0]?.d as string;
  shippedAging = (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure) AS d`)).rows[0]
    ?.d as string;
}, 900_000);

afterAll(async () => {
  writeFileSync('/tmp/claude-0/r12/conc.json', JSON.stringify(M, null, 2));
  for (const p of [sup, mig, app]) await p?.end().catch(() => undefined);
  await db?.drop();
});

describe('P4-S7 §A the parser, and the end-state block is NOT VACUOUS', () => {
  it('A0 the specification applies to a fresh database as daftar_migrator', () => {
    expect(specError).toBeNull();
  });

  it('A1 the sliced end-state block passes on the state the specification just built', async () => {
    M['A1_ratchet'] = await ratchet();
    // THE NON-VACUITY CONTROL FOR THE SLICER ITSELF. A block sliced out of the
    // file's prose fails with a syntax error, which would make every "the
    // ratchet refuses" case below pass for the wrong reason — the round-11
    // challenger lost a whole pass to exactly that.
    expect(M['A1_ratchet']).toBeNull();
  });

  it('A2 the block is the real one: it names the laws this round added', () => {
    const b = endStateBlock();
    for (const token of ['indisvalid', 'indisready', 'indislive', 'tgenabled', 'c_bodies', 'sha256']) {
      expect(b, `the sliced block does not contain ${token}`).toContain(token);
    }
  });
});

describe('P4-S7 §B the apply-time laws, each with its planted defect', () => {
  it('B1 part 9 refuses an index that is present and NOT ENFORCING (F-1b)', async () => {
    // The state is written straight into `pg_index` as the superuser. It is a
    // SIMULATION of what an interrupted concurrent build leaves behind and is
    // declared as one: this case proves the law reads the flags, not that a
    // failed `CREATE INDEX CONCURRENTLY` is what sets them.
    M['B1_before'] = await ratchet();
    M['B1_set_flags'] = await sudo(
      `UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
    );
    M['B1_pg_indexes_still_shows_it'] = (
      await sup.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'installment_plans_one_active_per_invoice_uq'`)
    ).rows;
    M['B1_ratchet'] = await ratchet();
    M['B1_restore'] = await sudo(
      `UPDATE pg_index SET indisvalid = true, indisready = true WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
    );
    M['B1_after_restore'] = await ratchet();
    expect(M['B1_before']).toBeNull();
    expect(String(M['B1_ratchet'])).toContain('installment.migration_end_state_invalid');
    expect(String(M['B1_ratchet'])).toContain('indisvalid');
    expect(M['B1_after_restore']).toBeNull();
  });

  it('B2 part 9 still refuses the index being GONE, and the dropped index is restored', async () => {
    M['B2_drop'] = await ddl(`DROP INDEX installment_plans_one_active_per_invoice_uq`);
    M['B2_ratchet'] = await ratchet();
    M['B2_recreate'] = await ddl(
      `CREATE UNIQUE INDEX installment_plans_one_active_per_invoice_uq ON installment_plans (business_id, invoice_id) WHERE status = 'active'`,
    );
    M['B2_after'] = await ratchet();
    expect(String(M['B2_ratchet'])).toContain('installment_plans_one_active_per_invoice_uq');
    expect(M['B2_after']).toBeNull();
  });

  it('B3 part 9b refuses EACH of the seven triggers disabled, one at a time (F-2)', async () => {
    const seven = await sevenTriggers();
    M['B3_seven'] = seven;
    const log: unknown[] = [];
    for (const t of seven) {
      const off = await ddl(`ALTER TABLE ${t.rel} DISABLE TRIGGER ${t.tgname}`);
      const verdict = await ratchet();
      const on = await ddl(`ALTER TABLE ${t.rel} ENABLE TRIGGER ${t.tgname}`);
      const back = await ratchet();
      log.push({ trigger: t.tgname, rel: t.rel, off, verdict, on, back });
      expect(String(verdict), `the ratchet did not refuse with ${t.tgname} disabled`).toContain('tgenabled');
      expect(back, `the ratchet did not recover after re-enabling ${t.tgname}`).toBeNull();
    }
    M['B3_log'] = log;
    // SEVEN, counted from the catalogue and not from a list in this file.
    expect(seven).toHaveLength(7);
  });

  it('B4 part 9b refuses DISABLE TRIGGER USER — the single statement of F-2', async () => {
    M['B4_off'] = await ddl(`ALTER TABLE installment_plans DISABLE TRIGGER USER`);
    M['B4_tgenabled'] = (
      await sup.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'installment_plans'::regclass AND NOT tgisinternal ORDER BY tgname`)
    ).rows;
    M['B4_ratchet'] = await ratchet();
    M['B4_on'] = await ddl(`ALTER TABLE installment_plans ENABLE TRIGGER USER`);
    M['B4_after'] = await ratchet();
    expect(String(M['B4_ratchet'])).toContain('installment.migration_end_state_invalid');
    expect(M['B4_after']).toBeNull();
  });

  it('B5 part 9b refuses a trigger set to REPLICA-only, which is the harm with a different letter', async () => {
    M['B5_off'] = await ddl(`ALTER TABLE installment_plans ENABLE REPLICA TRIGGER installment_plans_fact_sync`);
    M['B5_ratchet'] = await ratchet();
    M['B5_on'] = await ddl(`ALTER TABLE installment_plans ENABLE ALWAYS TRIGGER installment_plans_fact_sync`);
    M['B5_ratchet_always'] = await ratchet();
    M['B5_restore'] = await ddl(`ALTER TABLE installment_plans ENABLE TRIGGER installment_plans_fact_sync`);
    M['B5_after'] = await ratchet();
    expect(String(M['B5_ratchet'])).toContain('tgenabled');
    // `A` is STRICTLY STRONGER than `O` and is refused anyway: the end state is
    // a ratchet on THIS file's statements, not a search for the best setting.
    expect(String(M['B5_ratchet_always'])).toContain('tgenabled');
    expect(M['B5_after']).toBeNull();
  });

  it('B6 part 9b refuses a MISSING trigger as well as a disabled one', async () => {
    M['B6_drop'] = await ddl(`DROP TRIGGER installment_plans_active_exclusive ON installment_plans`);
    M['B6_ratchet'] = await ratchet();
    M['B6_recreate'] = await sudo(
      `CREATE TRIGGER installment_plans_active_exclusive BEFORE INSERT OR UPDATE ON installment_plans
         FOR EACH ROW EXECUTE FUNCTION installment_plan_active_exclusive()`,
    );
    M['B6_after'] = await ratchet();
    expect(String(M['B6_ratchet'])).toContain('seven');
    expect(M['B6_after']).toBeNull();
  });
});

/**
 * ── §C F-3 ANSWERED BY EXECUTION AND BY A DIGEST, NEVER BY A SUBSTRING ────
 *
 * `TL-P4-COORD-R50` §5: «a `prosrc LIKE` test cannot establish a property of
 * code … nor can a `prosrc NOT LIKE` test establish the ABSENCE of a property,
 * because an identifier is also a string. Any round-12 answer to F-3 that is
 * another substring pattern will be rejected on sight.»
 *
 * The counterfactual is the round-11 challenger's: round 9's body with
 * `v_asserted` renamed `v_floor` and ONE LIVE `OLD.status` assignment added —
 * no comment, no dead code. It defeated the comment-stripping ratchet. Two
 * things are measured about it here: that the DIGEST law refuses it (the
 * apply-time instrument, catalogue data) and that it COMMITS THE WRONG FACT
 * while the shipped body refuses the identical construction (the behavioural
 * instrument, execution).
 */
const SYNC_R9_RENAMED = `CREATE OR REPLACE FUNCTION public.installment_plan_fact_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_business UUID;
  v_invoices UUID[];
  v_invoice  UUID;
  v_state    BOOLEAN;
  v_rows     INTEGER;
  v_floor    BOOLEAN;
  v_old_active BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
    v_floor := (NEW.status = 'active');
  ELSIF TG_OP = 'DELETE' THEN
    v_business := OLD.business_id;
    v_invoices := ARRAY[OLD.invoice_id];
  ELSE
    v_business := NEW.business_id;
    v_invoices := ARRAY[NEW.invoice_id];
    v_old_active := (OLD.status = 'active');
    v_floor := (NEW.status = 'active');
    IF OLD.invoice_id IS DISTINCT FROM NEW.invoice_id THEN
      v_invoices := v_invoices || OLD.invoice_id;
    END IF;
  END IF;
  FOREACH v_invoice IN ARRAY v_invoices LOOP
    SELECT EXISTS (SELECT 1 FROM public.installment_plans p
                    WHERE p.business_id = v_business AND p.invoice_id = v_invoice
                      AND p.status = 'active')
      INTO v_state;
    IF v_floor AND NOT v_state THEN
      RAISE EXCEPTION 'installment.plan_fact_blind: the handed row asserts an active plan on invoice %/% and this routine cannot read one',
        v_business, v_invoice USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.invoices i SET has_active_installment_plan = v_state
     WHERE i.business_id = v_business AND i.id = v_invoice;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'installment.plan_fact_unwritable: % rows', v_rows USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$fn$;`;

const BLIND_STATUS_POLICY = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
   USING (app_bypass() OR status <> 'active')`;
const RESTORE_PLAN_READ = `CREATE POLICY business_isolation_read ON installment_plans AS RESTRICTIVE FOR SELECT
   USING (app_bypass() OR current_user IN ('daftar_inventory_internal','daftar_accounting_internal') OR business_id = nullif(app_business(), '')::uuid)`;

describe('P4-S7 §C F-3, answered by EXECUTION and by catalogue DATA', () => {
  it('C0 the planted body is the renamed one and carries no comment and no dead code', () => {
    expect(SYNC_R9_RENAMED).not.toContain('--');
    expect(SYNC_R9_RENAMED).not.toContain('v_asserted');
    expect(SYNC_R9_RENAMED).toContain('v_floor');
    expect(SYNC_R9_RENAMED).toContain('OLD.status');
    expect(SYNC_R9_RENAMED).toContain('NEW.status');
    expect(SYNC_R9_RENAMED).toContain('plan_fact_blind');
    // AND the comment-stripping substring ratchet of round 11 would have
    // PASSED it: every token that law required is present and the token it
    // forbade is absent. That is the whole of F-3, asserted on the subject.
    const code = SYNC_R9_RENAMED.replace(/--[^\n]*/g, ' ');
    expect(code).toContain('plan_fact_blind');
    expect(code).toContain('NEW.status');
    expect(code).toContain('OLD.status');
    expect(code).not.toContain('v_asserted');
  });

  it('C1 the DIGEST law refuses the renamed body, and the specification has no prosrc LIKE left', async () => {
    expect(M['A1_ratchet']).toBeNull();
    // AS THE SUPERUSER, and not as `daftar_migrator`. The specification
    // REVOKEs ALL on these three routines and grants EXECUTE to their owner
    // alone, so `daftar_migrator` is refused `42501 must be owner of
    // function` on a replacement and `42501 permission denied for function`
    // on a `CREATE TRIGGER`. A planted body is a state no ordinary principal
    // can reach, which is the point: the harm is owner-only and the law is
    // what notices it.
    M['C1_install'] = await sudo(SYNC_R9_RENAMED);
    M['C1_installed_is_r9'] = (
      await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.installment_plan_fact_sync()'::regprocedure) AS d`)
    ).rows[0]?.d.includes('SET has_active_installment_plan = v_state');
    M['C1_ratchet'] = await ratchet();
    expect(M['C1_install']).toBeNull();
    expect(M['C1_installed_is_r9']).toBe(true);
    expect(String(M['C1_ratchet'])).toContain('installment.migration_end_state_invalid');
    expect(String(M['C1_ratchet'])).toContain('sha256');
  });

  it('C2 the renamed body COMMITS the wrong fact, and the shipped body refuses the identical construction', async () => {
    // ON ITS OWN CUSTOMER AND ITS OWN INVOICE. The state the planted body
    // commits DOES NOT HEAL, and `customer_ar_aging` is a PER-CUSTOMER read,
    // so a customer carrying it refuses `plan_fact_unflagged` on every later
    // read. §D's refusals have to be attributable to §D.
    const inv = world.f3InvoiceId;
    M['C2_restore_shipped'] = await sudo(shippedSync);
    const first = await commitPlan(inv);
    M['C2_first_plan'] = first.error;
    M['C2_pre'] = await state(inv);

    // THE BLINDING. A restrictive read policy predicated on
    // `status <> 'active'` hides exactly the ACTIVE rows, so the handed row of
    // a NON-active transition stays visible to the writer's by-PK probe while
    // the recomputation is blind — `TL-P4-COORD-R46` F-3's construction, and
    // the one the specification names as the limit of that probe.
    M['C2_policy'] = await ddl(`DROP POLICY business_isolation_read ON installment_plans`);
    M['C2_policy2'] = await ddl(BLIND_STATUS_POLICY);

    // ── THE SHIPPED BODY FIRST, while the flag is still `true`. This is the
    //    ORDER THAT MATTERS and the first pass of this file had it backwards:
    //    the planted body sets the flag `false`, and with the flag already
    //    `false` the deferred verifier's blinded `EXISTS` reads `false` too
    //    and AGREES — the one quiet direction the specification declares. A
    //    control taken after the plant is therefore a measurement of the
    //    plant. Disclosed, and re-taken in this order.
    M['C2_installed_is_shipped'] =
      (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.installment_plan_fact_sync()'::regprocedure) AS d`)).rows[0]?.d === shippedSync;
    const ctl = randomUUID();
    M['C2_shipped_insert_cancelled'] = (await inCtx(mig, APP_CTX(), [{ sql: PLAN_INSERT, params: planArgs(ctl, inv, 'cancelled') }])).error;
    M['C2_state_after_shipped'] = await state(inv);

    // ── THEN THE PLANTED BODY, identical construction, same database.
    M['C2_install_renamed'] = await sudo(SYNC_R9_RENAMED);
    const bad = randomUUID();
    M['C2_renamed_insert_cancelled'] = (await inCtx(mig, APP_CTX(), [{ sql: PLAN_INSERT, params: planArgs(bad, inv, 'cancelled') }])).error;
    M['C2_state_while_renamed'] = await state(inv);

    // the policy restored, and the state measured again: IT DOES NOT HEAL.
    M['C2_policy_restore'] = await ddl(`DROP POLICY business_isolation_read ON installment_plans`);
    M['C2_policy_restore2'] = await ddl(RESTORE_PLAN_READ);
    M['C2_state_after_restore'] = await state(inv);
    M['C2_f3_customer_aging'] = await aging(world.customerId2);
    M['C2_reinstall_shipped'] = await sudo(shippedSync);
    M['C2_ratchet_after'] = await ratchet();

    expect(M['C2_first_plan']).toBeNull();
    expect((M['C2_pre'] as Record<string, unknown>)['flag']).toBe('true');
    // THE SHIPPED BODY REFUSES, and the state is preserved.
    expect(String(M['C2_shipped_insert_cancelled'])).toContain('installment.plan_fact_desynchronised');
    expect((M['C2_state_after_shipped'] as Record<string, unknown>)['flag']).toBe('true');
    expect((M['C2_state_after_shipped'] as Record<string, unknown>)['active_plans']).toBe(1);
    // THE PLANTED BODY COMMITS IT, and restoring the policy does not heal it.
    expect(M['C2_renamed_insert_cancelled']).toBeNull();
    expect((M['C2_state_while_renamed'] as Record<string, unknown>)['flag']).toBe('false');
    expect((M['C2_state_while_renamed'] as Record<string, unknown>)['active_plans']).toBe(1);
    expect((M['C2_state_after_restore'] as Record<string, unknown>)['flag']).toBe('false');
    expect((M['C2_state_after_restore'] as Record<string, unknown>)['active_plans']).toBe(1);
    // AND THE READER REFUSES THE COMMITTED STATE rather than serving it.
    expect(String((M['C2_f3_customer_aging'] as Outcome).error)).toContain('installment.plan_fact_unflagged');
    expect(M['C2_installed_is_shipped']).toBe(true);
    expect(M['C2_ratchet_after']).toBeNull();
  });

  it('C3 no prosrc substring test remains in the specification', () => {
    const block = endStateBlock();
    // The ruling is about INSTRUMENTS, so the subject is the SQL, not the
    // prose: a line that is a comment is not a law. Comments are stripped
    // line-wise before the search, and the refusal MESSAGES that quote the
    // ruling are string literals on `RAISE` lines, which is why the search is
    // for the test syntax `prosrc LIKE` / `code LIKE` and not for the words.
    const sql = block
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .filter((l) => !l.includes('RAISE EXCEPTION') && !l.trimStart().startsWith("'"))
      .join('\n');
    expect(sql).not.toMatch(/prosrc\s+(NOT\s+)?LIKE/i);
    expect(sql).not.toMatch(/\bcode\s+(NOT\s+)?LIKE/i);
  });
});

describe('P4-S7 §D the runtime guard at READ time — the premises the arithmetic names', () => {
  it('D1 two active plans on one invoice: the reader REFUSES instead of serving the no-plan figure (F-1)', async () => {
    const inv = world.invoiceIds[0] as string;
    const first = await commitPlan(inv);
    M['D1_first_plan'] = first.error;
    M['D1_state_pre'] = await state(inv);
    // THE ONE-PLAN CONTROL: the invoice is aged ACROSS ITS SCHEDULE.
    M['D1_aging_one_plan'] = await aging();

    // THE FAULT: the index stops enforcing. One superuser statement, writing
    // only the catalogue flags — a SIMULATION of what an interrupted
    // concurrent build leaves, declared as one.
    M['D1_unenforce'] = await sudo(
      `UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
    );
    // AND THE SECOND ACTIVE PLAN. The subject of this case is THE READER, and
    // every write path now refuses this state (§E measures each of them), so
    // the state is PLANTED with the slice's own triggers disabled for the
    // length of the plant and REMOVED the same way. A reader law whose fixture
    // cannot be built is a reader law nobody measures.
    const second = randomUUID();
    M['D1_triggers_off'] = await sudo(`ALTER TABLE installment_plans DISABLE TRIGGER USER`);
    const c = await sup.connect();
    try {
      await c.query(PLAN_INSERT, [...planArgs(second, inv, 'active')]);
      await c.query(SCHED_INSERT, [world.tenantId, world.businessId, second]);
      M['D1_plant'] = null;
    } catch (e) {
      M['D1_plant'] = err(e);
    } finally {
      c.release();
    }
    M['D1_triggers_on'] = await sudo(`ALTER TABLE installment_plans ENABLE TRIGGER USER`);
    M['D1_state'] = await state(inv);
    M['D1_aging_two_plans'] = await aging();

    // THE STATE IS REMOVED THE WAY IT WAS PLANTED. Cancelling the planted row
    // through the ordinary route would be REFUSED, correctly: the derivation
    // «this row lost active, so no active plan remains» is false while the
    // other one is still active, and the sync's own count says so. So the row
    // is deleted with the triggers off, which is the exact inverse of the
    // plant and leaves the flag agreeing with the ONE plan that remains.
    M['D1_unplant'] = await sudoTx([
      `ALTER TABLE installment_plans DISABLE TRIGGER USER`,
      `ALTER TABLE installments DISABLE TRIGGER USER`,
      `DELETE FROM installments WHERE plan_id = '${second}'`,
      `DELETE FROM installment_plans WHERE id = '${second}'`,
      `ALTER TABLE installments ENABLE TRIGGER USER`,
      `ALTER TABLE installment_plans ENABLE TRIGGER USER`,
    ]);
    M['D1_reenforce'] = await sudo(
      `UPDATE pg_index SET indisvalid = true, indisready = true WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
    );
    M['D1_state_after'] = await state(inv);
    M['D1_aging_after'] = await aging();

    expect(M['D1_first_plan']).toBeNull();
    expect(M['D1_plant']).toBeNull();
    expect(M['D1_unplant'], 'the plant must be removable, or the end-state reading below is about the plant').toBeNull();
    expect((M['D1_state'] as Record<string, unknown>)['active_plans']).toBe(2);
    // ROUND 11 MEASURED `[{bucket_no: 4, txn_minor: "900000"}]` HERE —
    // byte-identical to the no-plan control, with no refusal at all.
    expect(String((M['D1_aging_two_plans'] as Outcome).error)).toContain('installment.plan_active_unbounded');
    // AND BOTH CONTROLS ANSWER. A guard that refuses everything is not a
    // guard, and the one-plan answer is the SCHEDULE answer: more than one
    // bucket, which the no-plan answer never has.
    expect((M['D1_aging_one_plan'] as Outcome).error).toBeNull();
    expect((M['D1_aging_one_plan'] as Outcome).rows.length).toBeGreaterThan(1);
    expect((M['D1_aging_after'] as Outcome).error).toBeNull();
    expect((M['D1_aging_after'] as Outcome).rows.length).toBeGreaterThan(1);
    expect(M['D1_state_after']).toStrictEqual(M['D1_state_pre']);
  });

  it('D2 a disabled fact trigger: the reader REFUSES plan_fact_untrusted, each of the seven (F-2 at read time)', async () => {
    M['D2_aging_pre'] = await aging();
    expect((M['D2_aging_pre'] as Outcome).error).toBeNull();
    const log: unknown[] = [];
    const seven = await sevenTriggers();
    for (const tg of seven) {
      const off = await ddl(`ALTER TABLE ${tg.rel} DISABLE TRIGGER ${tg.tgname}`);
      const read = await aging();
      const on = await ddl(`ALTER TABLE ${tg.rel} ENABLE TRIGGER ${tg.tgname}`);
      const back = await aging();
      log.push({ trigger: tg.tgname, off, refused: read.error, on, backError: back.error });
      expect(String(read.error), `the reader served a figure with ${tg.tgname} disabled`).toContain('installment.plan_fact_untrusted');
      expect(back.error, `the reader did not recover after re-enabling ${tg.tgname}`).toBeNull();
    }
    M['D2_log'] = log;
    expect(seven).toHaveLength(7);
  });

  it('D3 DISABLE TRIGGER USER on installment_plans: the reader refuses, and recovers', async () => {
    M['D3_off'] = await ddl(`ALTER TABLE installment_plans DISABLE TRIGGER USER`);
    M['D3_read'] = await aging();
    M['D3_on'] = await ddl(`ALTER TABLE installment_plans ENABLE TRIGGER USER`);
    M['D3_read_after'] = await aging();
    expect(String((M['D3_read'] as Outcome).error)).toContain('installment.plan_fact_untrusted');
    // FOUR of the seven, which is the single-statement reach of F-2.
    expect(String((M['D3_read'] as Outcome).error)).toContain('4 of the seven');
    expect((M['D3_read_after'] as Outcome).error).toBeNull();
  });

  it('D4 a DROPPED trigger refuses at read time too, not only a disabled one', async () => {
    M['D4_drop'] = await sudo(`DROP TRIGGER installment_plans_fact_sync ON installment_plans`);
    M['D4_read'] = await aging();
    M['D4_recreate'] = await sudo(
      `CREATE TRIGGER installment_plans_fact_sync AFTER INSERT OR UPDATE OR DELETE ON installment_plans
         FOR EACH ROW EXECUTE FUNCTION installment_plan_fact_sync()`,
    );
    M['D4_read_after'] = await aging();
    expect(String((M['D4_read'] as Outcome).error)).toContain('installment.plan_fact_untrusted');
    expect((M['D4_read_after'] as Outcome).error).toBeNull();
  });
});

describe('P4-S7 §E the runtime guard at WRITE time, and the lock order (F-1, F-4, F-6)', () => {
  it('E1 the exclusion trigger takes the INVOICE ROW first — asserted from pg_locks', async () => {
    const inv = world.invoiceIds[1] as string;
    const a = new Actor('E1A', 'daftar_migrator');
    try {
      await a.open();
      M['E1_insert'] = await a.q(PLAN_INSERT, planArgs(randomUUID(), inv, 'active'));
      const locks = (
        await sup.query(
          `SELECT l.locktype, l.mode, l.granted, c.relname
             FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = $1 AND c.relname IN ('invoices','installment_plans')
            ORDER BY c.relname, l.mode`,
          [a.pid],
        )
      ).rows;
      M['E1_locks'] = locks;
      // A ROW LOCK LIVES IN THE TUPLE HEADER AND NOT IN `pg_locks`, so what IS
      // observable from the catalogue is that this backend holds
      // `RowExclusiveLock` on `invoices` — a lock only the invoice WRITE path
      // takes — while it has written no invoice row of its own. The ordering
      // itself is then measured behaviourally by E2: the loser blocks and is
      // refused by name instead of meeting the index.
      M['E1_invoice_row_exclusive'] = locks.some(
        (r) => (r as Record<string, unknown>)['relname'] === 'invoices' && (r as Record<string, unknown>)['mode'] === 'RowExclusiveLock',
      );
      expect(M['E1_insert']).toBeNull();
      expect(M['E1_invoice_row_exclusive']).toBe(true);
    } finally {
      await a.end();
    }
  });

  it('E2 two concurrent plan creations on ONE invoice, index ENFORCING: the loser is refused BY NAME, not 23505 (F-4)', async () => {
    const inv = world.invoiceIds[1] as string;
    M['E2_clear'] = await clearActive(inv);
    const A = new Actor('E2A', 'daftar_migrator');
    const B = new Actor('E2B', 'daftar_migrator');
    try {
      await A.open();
      await B.open();
      const pa = randomUUID();
      const pb = randomUUID();
      M['E2_pre'] = await state(inv);
      M['E2_A_plan'] = await A.q(PLAN_INSERT, planArgs(pa, inv, 'active'));
      M['E2_A_sched'] = await A.q(SCHED_INSERT, [world.tenantId, world.businessId, pa]);
      const fired = B.fire(PLAN_INSERT, planArgs(pb, inv, 'active'));
      M['E2_B_blocked'] = await awaitLock(B.pid);
      M['E2_B_still_pending_while_blocked'] = !fired.settled();
      M['E2_A_commit'] = await A.q('COMMIT');
      M['E2_B_outcome'] = await fired.promise;
      M['E2_B_commit'] = await B.q('COMMIT');
      M['E2_post'] = await state(inv);
      expect(M['E2_A_plan']).toBeNull();
      // BLOCKING IS ASSERTED FROM THE CATALOGUE, NEVER SLEPT FOR.
      expect((M['E2_B_blocked'] as BlockedReading).blocked).toBe(true);
      expect((M['E2_B_blocked'] as BlockedReading).waitEventType).toBe('Lock');
      expect(String((M['E2_B_blocked'] as BlockedReading).blockers)).toContain(String(A.pid));
      expect(M['E2_B_still_pending_while_blocked']).toBe(true);
      // ROUND 11 MEASURED `23505` HERE. The invoice row lock makes it a name.
      expect(String(M['E2_B_outcome'])).toContain('installment.plan_active_conflict');
      expect(String(M['E2_B_outcome'])).not.toContain('23505');
      expect((M['E2_post'] as Record<string, unknown>)['active_plans']).toBe(1);
      expect((M['E2_post'] as Record<string, unknown>)['flag']).toBe('true');
    } finally {
      await A.end();
      await B.end();
    }
  });

  it('E3 the same race with the index NOT ENFORCING: still refused, and the index is not what refuses (F-1)', async () => {
    const inv = world.invoiceIds[2] as string;
    M['E3_unenforce'] = await sudo(
      `UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
    );
    const A = new Actor('E3A', 'daftar_migrator');
    const B = new Actor('E3B', 'daftar_migrator');
    try {
      await A.open();
      await B.open();
      const pa = randomUUID();
      const pb = randomUUID();
      M['E3_pre'] = await state(inv);
      M['E3_A_plan'] = await A.q(PLAN_INSERT, planArgs(pa, inv, 'active'));
      M['E3_A_sched'] = await A.q(SCHED_INSERT, [world.tenantId, world.businessId, pa]);
      const fired = B.fire(PLAN_INSERT, planArgs(pb, inv, 'active'));
      M['E3_B_blocked'] = await awaitLock(B.pid);
      M['E3_A_commit'] = await A.q('COMMIT');
      M['E3_B_outcome'] = await fired.promise;
      M['E3_B_commit'] = await B.q('COMMIT');
      M['E3_post'] = await state(inv);
      expect((M['E3_pre'] as Record<string, unknown>)['active_plans']).toBe(0);
      expect(M['E3_A_plan']).toBeNull();
      expect((M['E3_B_blocked'] as BlockedReading).blocked).toBe(true);
      // THIS IS THE WHOLE OF F-1 ON THE WRITE PATH. Round 11 measured `null`
      // here — no refusal — and two active plans committed, after which the
      // reader served the pre-installment figure silently.
      expect(String(M['E3_B_outcome'])).toContain('installment.plan_active_conflict');
      expect((M['E3_post'] as Record<string, unknown>)['active_plans']).toBe(1);
    } finally {
      await A.end();
      await B.end();
      M['E3_reenforce'] = await sudo(
        `UPDATE pg_index SET indisvalid = true, indisready = true WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
      );
    }
  });

  it('E4 with the exclusion trigger GONE and the index not enforcing, the AFTER-trigger count refuses — and the writers STILL serialise', async () => {
    // WHAT THIS CASE WAS WRITTEN TO MEASURE, AND WHAT IT MEASURED INSTEAD.
    //
    // It was written for the arm the DEFERRED verifier owns: with no BEFORE
    // trigger there is no invoice row lock, so — the reasoning went — neither
    // writer blocks, neither sync sees the other's uncommitted row, and the
    // transaction that commits SECOND meets the count at COMMIT, where a
    // deferred constraint trigger's query at `READ COMMITTED` takes a FRESH
    // snapshot and therefore holds the first one's committed plan.
    //
    // THE PREMISE IS FALSE, and it was the hang that said so: with B's
    // `INSERT` AWAITED this case ran to the 120s test timeout, because
    // `installment_plan_fact_sync` is an AFTER ... FOR EACH ROW trigger that
    // writes `public.invoices`, so B's own statement takes a row lock on the
    // same invoice row A's statement already holds. DROPPING the BEFORE
    // trigger does not remove the serialisation; it only moves it later in
    // B's statement, from an explicit `FOR NO KEY UPDATE` to the sync's
    // `UPDATE`. (That is also why §E1's lock reading matters: the BEFORE
    // trigger takes the SAME row the sync was going to take anyway, in the
    // declared order, instead of taking it halfway through the statement.)
    //
    // So this case now measures what is actually there: B blocks, and once A
    // commits, B's INSERT is refused BY THE SYNC's count — `READ COMMITTED`
    // gives the trigger's count query a fresh snapshot that holds A's row.
    // The guard holds with the BEFORE trigger GONE and the index NOT
    // ENFORCING, which is the property obligation (1) asks for, and it is the
    // AFTER arm rather than the deferred arm that supplies it.
    //
    // THE DEFERRED ARM IS THEREFORE UNMEASURED UNDER CONCURRENCY, and this
    // file says so rather than dressing this reading up as it: no ordinary
    // interleaving of two plan writes on ONE invoice reaches COMMIT with two
    // active plans, because the sync's invoice write serialises them first.
    // It is retained as the belt to the AFTER arm's braces, and it is
    // measured single-threaded by the fact suite.
    const inv = world.invoiceIds[3] as string;
    M['E4_unenforce'] = await sudo(
      `UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
    );
    M['E4_drop_excl'] = await sudo(`DROP TRIGGER installment_plans_active_exclusive ON installment_plans`);
    const A = new Actor('E4A', 'daftar_migrator');
    const B = new Actor('E4B', 'daftar_migrator');
    try {
      await A.open();
      await B.open();
      const pa = randomUUID();
      const pb = randomUUID();
      M['E4_pre'] = await state(inv);
      M['E4_A_plan'] = await A.q(PLAN_INSERT, planArgs(pa, inv, 'active'));
      M['E4_A_sched'] = await A.q(SCHED_INSERT, [world.tenantId, world.businessId, pa]);
      const fired = B.fire(PLAN_INSERT, planArgs(pb, inv, 'active'));
      // B BLOCKS WITH NO BEFORE TRIGGER IN THE DATABASE. The blocking is
      // ASSERTED from `pg_stat_activity` and `pg_locks`, never timed.
      M['E4_B_blocked'] = await awaitLock(B.pid);
      M['E4_A_commit'] = await A.q('COMMIT');
      M['E4_B_outcome'] = await fired.promise;
      M['E4_B_commit'] = await B.q('COMMIT');
      M['E4_post'] = await state(inv);
      expect(M['E4_drop_excl']).toBeNull();
      expect(M['E4_A_plan']).toBeNull();
      expect((M['E4_B_blocked'] as BlockedReading).blocked).toBe(true);
      expect(M['E4_A_commit']).toBeNull();
      // THE COUNT IS WHAT REFUSES, with no BEFORE trigger and a
      // non-enforcing index: not `23505`, and not silence.
      expect(String(M['E4_B_outcome'])).toContain('installment.plan_active_unbounded');
      expect(String(M['E4_B_outcome'])).not.toContain('23505');
      expect((M['E4_post'] as Record<string, unknown>)['active_plans']).toBe(1);
    } finally {
      await A.end();
      await B.end();
      M['E4_recreate'] = await sudo(
        `CREATE TRIGGER installment_plans_active_exclusive BEFORE INSERT OR UPDATE ON installment_plans
           FOR EACH ROW EXECUTE FUNCTION installment_plan_active_exclusive()`,
      );
      M['E4_reenforce'] = await sudo(
        `UPDATE pg_index SET indisvalid = true, indisready = true WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
      );
      M['E4_ratchet'] = await ratchet();
      expect(M['E4_ratchet']).toBeNull();
    }
  });

  it('E5 REPEATABLE READ and SERIALIZABLE: 40001, and NOT this slice\u2019s name — the scoped claim, measured', async () => {
    const log: Record<string, unknown> = {};
    for (const [i, iso] of (['REPEATABLE READ', 'SERIALIZABLE'] as const).entries()) {
      const inv = world.invoiceIds[2 + (i % 2)] as string;
      const cleared = await clearActive(inv);
      const A = new Actor('A', 'daftar_migrator');
      const B = new Actor('B', 'daftar_migrator');
      try {
        await A.open(iso);
        await B.open(iso);
        const pa = randomUUID();
        const pb = randomUUID();
        const pre = await state(inv);
        const aPlan = await A.q(PLAN_INSERT, planArgs(pa, inv, 'active'));
        const aSched = await A.q(SCHED_INSERT, [world.tenantId, world.businessId, pa]);
        const fired = B.fire(PLAN_INSERT, planArgs(pb, inv, 'active'));
        const blocked = await awaitLock(B.pid);
        const aCommit = await A.q('COMMIT');
        const bOutcome = await fired.promise;
        const bCommit = await B.q('COMMIT');
        log[iso] = { cleared, pre, aPlan, aSched, blocked, aCommit, bOutcome, bCommit, post: await state(inv) };
        expect(aPlan, `${iso}: A's own plan write`).toBeNull();
        expect(blocked.blocked, `${iso}: B did not block`).toBe(true);
        // `40001` IS THE CORRECT ANSWER AT THESE LEVELS and is not dressed up
        // as this slice's refusal: the loser's lock on an invoice row a
        // concurrent transaction changed is refused by the snapshot rules
        // BEFORE the recheck runs. Section 3a-ter's table says so, and the
        // determinism claim is scoped to `READ COMMITTED` accordingly.
        expect(String(bOutcome), `${iso}: B's outcome`).toContain('40001');
        expect(String(bOutcome), `${iso}: B's outcome`).not.toContain('installment.');
      } finally {
        await A.end();
        await B.end();
      }
    }
    M['E5'] = log;
  });

  it('E6 the single-threaded control is unchanged: a second active plan in ONE session is refused by name', async () => {
    const inv = world.invoiceIds[3] as string;
    M['E6_clear'] = await clearActive(inv);
    const first = await commitPlan(inv);
    M['E6_first'] = first.error;
    M['E6_second'] = (await inCtx(mig, APP_CTX(), [{ sql: PLAN_INSERT, params: planArgs(randomUUID(), inv, 'active') }])).error;
    M['E6_post'] = await state(inv);
    expect(M['E6_clear']).toBeNull();
    expect(M['E6_first']).toBeNull();
    expect(String(M['E6_second'])).toContain('installment.plan_active_conflict');
    expect((M['E6_post'] as Record<string, unknown>)['active_plans']).toBe(1);
  });

  it('E7 cancel-then-activate in two statements still COMMITS — the documented route is not broken by the lock', async () => {
    const inv = world.invoiceIds[3] as string;
    // WITH A LAWFUL SCHEDULE. Without one, obligation (a) refuses at COMMIT
    // for a reason unrelated to the subject — the contamination the round-11
    // challenger had to discard two readings over (its K5 and K6).
    const planId = randomUUID();
    const r = await inCtx(mig, APP_CTX(), [
      { sql: `UPDATE installment_plans SET status = 'cancelled' WHERE invoice_id = $1 AND status = 'active'`, params: [inv] },
      { sql: PLAN_INSERT, params: planArgs(planId, inv, 'active') },
      { sql: SCHED_INSERT, params: [world.tenantId, world.businessId, planId] },
    ]);
    M['E7_lawful'] = r.error;
    M['E7_lawful_post'] = await state(inv);
    expect(M['E7_lawful']).toBeNull();
    expect((M['E7_lawful_post'] as Record<string, unknown>)['active_plans']).toBe(1);
    expect((M['E7_lawful_post'] as Record<string, unknown>)['flag']).toBe('true');
  });

  it('E8 the empty write set still contends with nothing — the round-11 reading re-taken on the new body', async () => {
    const inv = world.invoiceIds[3] as string;
    const A = new Actor('E8A', 'daftar_migrator');
    const B = new Actor('E8B', 'daftar_migrator');
    try {
      await A.open();
      await B.open();
      M['E8_A_cancel'] = await A.q(`UPDATE installment_plans SET status = 'cancelled' WHERE invoice_id = $1 AND status = 'active'`, [inv]);
      M['E8_B_insert'] = await B.q(PLAN_INSERT, planArgs(randomUUID(), inv, 'cancelled'));
      M['E8_B_activity'] = await awaitLock(B.pid, 800);
      M['E8_A_commit'] = await A.q('COMMIT');
      M['E8_B_commit'] = await B.q('COMMIT');
      M['E8_post'] = await state(inv);
      expect(M['E8_A_cancel']).toBeNull();
      // THE EMPTY WRITE SET TAKES NEITHER THE INDEX ENTRY NOR THE INVOICE
      // ROW, so the new lock changes nothing for it. Proved the other way:
      // sampled across a window and never observed waiting on a `Lock`.
      expect((M['E8_B_activity'] as BlockedReading).blocked).toBe(false);
      expect(M['E8_B_commit']).toBeNull();
      expect((M['E8_post'] as Record<string, unknown>)['active_plans']).toBe(0);
      expect((M['E8_post'] as Record<string, unknown>)['flag']).toBe('false');
    } finally {
      await A.end();
      await B.end();
    }
  });

  it('E9 two invoices in OPPOSITE order still deadlock 40P01 — the caller obligation the declaration names (F-6)', async () => {
    // `P4-AL-41` rank 3's qualifier — «`invoices` — ascending by `id` where
    // several are touched» — is a CALLER obligation and no per-row trigger can
    // discharge it. Section 3a-ter declares it rather than leaving a twelfth
    // challenger to re-measure it, and this is the measurement that the
    // declaration is about a real outcome.
    const i1 = world.invoiceIds[1] as string;
    const i2 = world.invoiceIds[2] as string;
    for (const inv of [i1, i2]) await clearActive(inv);
    const A = new Actor('E9A', 'daftar_migrator');
    const B = new Actor('E9B', 'daftar_migrator');
    try {
      await A.open();
      await B.open();
      const [a1, a2, b1, b2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      M['E9_A1'] = await A.q(PLAN_INSERT, planArgs(a1, i1, 'active'));
      M['E9_A1s'] = await A.q(SCHED_INSERT, [world.tenantId, world.businessId, a1]);
      M['E9_B1'] = await B.q(PLAN_INSERT, planArgs(b1, i2, 'active'));
      M['E9_B1s'] = await B.q(SCHED_INSERT, [world.tenantId, world.businessId, b1]);
      const fa = A.fire(PLAN_INSERT, planArgs(a2, i2, 'active'));
      M['E9_A2_blocked'] = await awaitLock(A.pid);
      const fb = B.fire(PLAN_INSERT, planArgs(b2, i1, 'active'));
      M['E9_A2'] = await fa.promise;
      M['E9_B2'] = await fb.promise;
      M['E9_A_commit'] = await A.q('COMMIT');
      M['E9_B_commit'] = await B.q('COMMIT');
      M['E9_post_i1'] = await state(i1);
      M['E9_post_i2'] = await state(i2);
      const outcomes = `${M['E9_A2']} ${M['E9_B2']}`;
      M['E9_outcomes'] = outcomes;
      // ONE victim, `40P01`, and no state corrupted — the victim rolled back.
      expect(outcomes).toContain('40P01');
      for (const k of ['E9_post_i1', 'E9_post_i2']) {
        const s = M[k] as Record<string, unknown>;
        expect(Number(s['active_plans']), `${k} active plans`).toBeLessThanOrEqual(1);
        expect(s['flag'], `${k} flag`).toBe(Number(s['active_plans']) === 1 ? 'true' : 'false');
      }
    } finally {
      await A.end();
      await B.end();
    }
  });
});

describe('P4-S7 §F the end state is intact after every mutation this file made', () => {
  it('F1 the ratchet passes, the shipped bodies are installed, and the index is enforcing', async () => {
    M['F1_ratchet'] = await ratchet();
    const got = (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.installment_plan_fact_sync()'::regprocedure) AS d`)).rows[0]?.d;
    M['F1_sync_is_shipped'] = got === shippedSync;
    const got2 = (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure) AS d`)).rows[0]
      ?.d;
    M['F1_aging_is_shipped'] = got2 === shippedAging;
    M['F1_index_flags'] = (
      await sup.query(
        `SELECT indisunique, indisvalid, indisready, indislive FROM pg_index WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
      )
    ).rows;
    M['F1_tgenabled'] = (
      await sup.query(
        `SELECT t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid JOIN pg_namespace n ON n.oid = f.pronamespace
          WHERE NOT t.tgisinternal AND n.nspname = 'public'
            AND f.proname IN ('installment_plan_fact_sync','installment_plan_fact_verify',
                              'installment_plan_active_exclusive','installment_schedule_verify')
          ORDER BY t.tgname`,
      )
    ).rows;
    expect(M['F1_ratchet']).toBeNull();
    expect(M['F1_sync_is_shipped']).toBe(true);
    expect(M['F1_aging_is_shipped']).toBe(true);
    expect(M['F1_tgenabled']).toHaveLength(7);
  });
});
