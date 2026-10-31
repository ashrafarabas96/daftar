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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client, Pool } from 'pg';
import type { ScratchDb } from '../helpers/scratch-db';
import { createScratchDb, urlOf } from '../helpers/scratch-db';
import { apRelease } from '@daftar/inventory';

const DB = 'daftar_s7r12_conc';
/**
 * ── WHERE THIS SUITE WRITES ITS MEASUREMENTS, AND WHY NOT AT A FIXED PATH
 *    (`TL-P4-COORD-R55` ordered item 8, §9) ─────────────────────────────────
 *
 * This file used to write `/tmp/claude-0/r12/conc.json` on every run. The round-13 challenger ran
 * the shipped suites — which it must, to re-take the author's figures — and
 * OVERWROTE THE AUTHOR'S OWN MEASUREMENT ARTIFACTS at exactly that path. It
 * copied them aside first, so nothing was lost that time, and it disclosed the
 * hazard; the coordinator made it a standing rule: a test that writes a
 * measurement file writes it to a path DERIVED from the run, never a fixed
 * one, or two honest runs destroy each other's evidence.
 *
 * The path is derived from `PG_PORT` — which the runner exports once per run
 * and which is unique per cluster by the same rule — plus the process id, so
 * two runs on one cluster do not collide either. The directory is created if
 * it is absent, and a write failure is never allowed to fail a measurement:
 * the file is a report, not a law.
 */
const MEASUREMENTS = (() => {
  const port = process.env['PG_PORT'] ?? 'noport';
  return join('/tmp', 'claude-0', 'p4s7-runs', `conc-${port}-${String(process.pid)}.json`);
})();

function writeMeasurements(payload: unknown): void {
  try {
    mkdirSync(dirname(MEASUREMENTS), { recursive: true });
    writeFileSync(MEASUREMENTS, JSON.stringify(payload, null, 2));
  } catch {
    // A report that cannot be written is not a verdict. The assertions are the
    // verdict, and they have already run.
  }
}

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

/**
 * THE SHIPPED STATEMENT WHOSE TEXT BEGINS WITH `head`, SLICED OUT OF THE
 * SPECIFICATION RATHER THAN RETYPED, AND CERTIFIED NON-VACUOUS BY `mustMatch`.
 *
 * ROUND 16, FINISHING THE SWEEP ROUND 15 DECLARED COMPLETE
 * (`TL-P4-COORD-R63` item 6, F15-6). Round 15 repaired §B6, §E4 and §R3 and
 * said the sweep had found all of them; it had not. §B2 retyped the partial
 * unique index and §D4 retyped the fact-sync trigger, and the restrictive read
 * policies were retyped in this file and in the fact suite. Each retyped copy
 * MATCHED the spec, so nothing was downgraded -- the hazard was LATENT, and
 * latent is not absent: it is one spec edit away from being the §B6 failure
 * again, and that one cost nine reds none of which were about their own
 * subject.
 *
 * `mustMatch` is the non-vacuity of the SLICE and deliberately not a copy of
 * the statement: it pins the properties the case depends on and nothing else,
 * so a legitimate spec change travels into the fixture while a slice that
 * caught the wrong statement throws instead of restoring something weaker.
 */
function shippedStatement(head: string, mustMatch: readonly RegExp[]): string {
  const a = SPEC.indexOf(head);
  if (a < 0) throw new Error(`the shipped statement ${head} is not in the specification`);
  const b = SPEC.indexOf(';', a);
  if (b < 0) throw new Error(`the shipped statement ${head} is unterminated in the specification`);
  const stmt = SPEC.slice(a, b);
  for (const re of mustMatch) {
    if (!re.test(stmt)) throw new Error(`the sliced statement does not satisfy ${String(re)}: ${stmt}`);
  }
  return stmt;
}

/** The shipped partial unique index §B2 drops and must put back. */
function shippedActivePlanIndex(): string {
  return shippedStatement('CREATE UNIQUE INDEX installment_plans_one_active_per_invoice_uq', [
    /ON installment_plans \(business_id, invoice_id\)/,
    /WHERE status = 'active'/,
  ]);
}

/** The shipped fact-sync trigger §D4 drops and must put back. */
function shippedFactSyncTrigger(): string {
  return shippedStatement('CREATE TRIGGER installment_plans_fact_sync', [
    /AFTER [A-Z ]*ON installment_plans/,
    /FOR EACH ROW EXECUTE FUNCTION installment_plan_fact_sync\(\)/,
  ]);
}

/**
 * THE PROPERTIES THE PLAN READ POLICY'S SLICE MUST HAVE, AS A NAMED LIST SO
 * THE RED PROOF USES THE SHIPPED ONE (`TL-P4-COORD-R69` ordered item 4,
 * R16-4).
 *
 * THE RELATION IS PINNED HERE AND NOT ONLY IN THE HEAD. The other four
 * patterns are ALL TRUE of the `installments` read policy as well -- it is
 * restrictive FOR SELECT, it names `app_bypass()`, it names
 * `daftar_accounting_internal`, and it carries the same `business_id`
 * predicate -- so the helper's stated purpose, «a slice that caught the WRONG
 * STATEMENT throws instead of restoring something weaker», was satisfied by the
 * wrong statement. Non-vacuity that leans on the head cannot certify that the
 * head found the right thing, which is the one question it exists to answer.
 *
 * IT IS A CONSTANT RATHER THAN AN INLINE LITERAL BECAUSE §A3 APPLIES THIS VERY
 * LIST to the other relation and requires a throw. Round 16 declared its
 * `mustMatch` arms DESIGN ONLY; the round-16 challenger executed them and
 * found this gap. Now deleting the relation pattern from this list REDS §A3,
 * which is the difference between a certified property and a described one.
 */
const PLAN_READ_POLICY_MUST_MATCH: readonly RegExp[] = [
  /ON installment_plans\b/,
  /AS RESTRICTIVE FOR SELECT/,
  /app_bypass\(\)/,
  /daftar_accounting_internal/,
  /business_id = nullif\(app_business\(\), ''\)::uuid/,
];

/** The shipped restrictive read policy on `installment_plans`, for every §C restore. */
function shippedPlanReadPolicy(): string {
  return shippedStatement('CREATE POLICY business_isolation_read ON installment_plans', PLAN_READ_POLICY_MUST_MATCH);
}

/**
 * THE SHIPPED `CREATE TRIGGER` FOR `installment_plans_active_exclusive`, SLICED
 * OUT OF THE SPECIFICATION RATHER THAN RETYPED.
 *
 * §B6 drops that trigger and must put it back. Round 14's version of §B6 put
 * back a trigger it had typed into the test -- `BEFORE INSERT OR UPDATE` --
 * which was and still is the shipped shape (section 3a-bis of
 * `p4s7-installment-aging.spec.sql`; `tgtype = 23`, the DELETE bit absent).
 * Round 15 then DRAFTED an `OR DELETE` arm on that very trigger, measured that
 * no `BEFORE DELETE` arm can take the invoice row first
 * (`GetTupleForTrigger` locks `OLD` before the body runs) and REMOVED it again
 * in the same commit -- so the event list was one measurement away from
 * moving, and the retyped copy was one commit away from being a silent
 * DOWNGRADE that every later case in this file would have inherited. Reading
 * the statement out of `SPEC` makes the restore track the spec by
 * construction, so neither that near miss nor the next event actually added to
 * the trigger can produce one.
 *
 * THE NON-VACUITY DELIBERATELY DOES NOT PIN THE EVENT LIST. Whether the
 * trigger fires on DELETE is a decision of the specification, and a restore
 * that tracked a hard-coded event list is the defect this helper exists to
 * prevent. What is pinned is that the slice is the whole-row BEFORE trigger
 * running THIS function.
 */
function shippedExclusiveTrigger(): string {
  return shippedStatement('CREATE TRIGGER installment_plans_active_exclusive', [
    /BEFORE [A-Z ]*ON installment_plans/,
    /FOR EACH ROW EXECUTE FUNCTION installment_plan_active_exclusive\(\)/,
  ]);
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
  /** The customer of the ONE invoice whose base total is not its txn total (§G3). */
  customerId3: string;
  invoiceIds: readonly string[];
  f3InvoiceId: string;
  /** Three fresh invoices for §G, so no §G arm measures another arm's leftovers. */
  gInvoiceIds: readonly string[];
  /** `total_txn_minor` 900000, `total_base_minor` 760501 — base <> txn (§G3). */
  baseFxInvoiceId: string;
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

/**
 * WHAT A WAITING BACKEND HOLDS ON A PLAN ROW, ASKED FROM A THIRD BACKEND WITH
 * `NOWAIT`. `55P03` means the row is held by someone else; `null` means it is
 * free. This is how §G1 proves WHICH RANK the deleter holds while it waits,
 * instead of arguing it from the order of statements in a trigger body.
 */
async function invoiceRowProbe(invoiceId: string): Promise<string | null> {
  const c = await sup.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM invoices WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [invoiceId]);
    await c.query('ROLLBACK');
    return null;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    return err(e);
  } finally {
    c.release();
  }
}

async function planRowProbe(planId: string): Promise<string | null> {
  const c = await sup.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM installment_plans WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [planId]);
    await c.query('ROLLBACK');
    return null;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
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
  /**
   * `timeoutMs` BOUNDS EVERY STATEMENT OF THIS ACTOR, and it is a GUARD AGAINST
   * A DEFECTIVE ARM rather than an instrument of any measurement.
   *
   * §G1's first version of its DELETE-arm plant made the arm RAISE instead of
   * wait; no cycle could form, the counterparty blocked on a row the aborted
   * statement had already locked, and the case HUNG until vitest timed it out --
   * after which every later case in the file queued behind two abandoned
   * transactions and the whole file's verdict was lost. A bounded statement
   * turns that into one named failure (`57014`) in one case.
   *
   * IT IS SET WELL ABOVE `deadlock_timeout` (1s by default), so the deadlock
   * detector always fires first and no `40P01` of this file can be turned into
   * a `57014` by this guard. Where a case MEASURES a wait, it asserts the wait
   * from `pg_stat_activity` and `pg_locks` -- never from this timeout.
   */
  async open(iso: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED', timeoutMs = 0): Promise<void> {
    await this.client.connect();
    this.pid = Number((await this.client.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]?.p);
    await this.client.query(`BEGIN ISOLATION LEVEL ${iso}`);
    if (timeoutMs > 0) await this.client.query(`SET LOCAL statement_timeout = ${String(timeoutMs)}`);
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

/**
 * §G3's OWN PLAN, WITH A SCHEDULE WHOSE DUE DATES STRADDLE THE BUCKET
 * BOUNDARIES AT THE `as_of` §G3 READS.
 *
 * `commitPlan` above dates the down payment 2026-01-02 and the two instalments
 * 2026-02-02 and 2026-06-02. §G3 reads `as_of = 2026-10-07` with buckets
 * `[30, 60, 90]`, and EVERY ONE of those three dates is more than 90 days old
 * at that date -- so the shipped projection, correctly, puts all three schedule
 * rows in the SAME (oldest) band. §G3's first pass used `commitPlan` and then
 * asserted that more than one band carries base, which that fixture cannot
 * satisfy: the red was the FIXTURE and not the law. Disclosed, and re-taken on
 * this schedule, whose three rows land in three DIFFERENT bands at that
 * `as_of`:
 *
 *     2026-06-20  down payment 100000   age 109  > 90        -> bucket 4
 *     2026-08-20  instalment 1 400000   age  48  > 30        -> bucket 2
 *     2026-10-05  instalment 2 400000   age   2  no threshold -> bucket 1
 *
 * The amounts are unchanged, so obligation (a) still holds exactly:
 * 100000 + 400000 + 400000 = 900000 = `invoices.total_txn_minor` of `INV-9`.
 * The ordering is `(due_date, seq_no)` and the two instalments are written in
 * ascending date order, so the prefix sums the projection takes are the
 * settlement order the design declares.
 */
const G3_PLAN_INSERT = `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
   VALUES ($1,$2,$3,$4,$5,'active',100000,'2026-06-20'::DATE,$6,gen_random_uuid())`;
const G3_SCHED_INSERT = `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
   VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-08-20'::DATE,400000),
          ($1,$2,gen_random_uuid(),$3,2,'2026-10-05'::DATE,400000)`;

async function commitG3Plan(invoiceId: string): Promise<{ error: string | null; planId: string }> {
  const planId = randomUUID();
  const r = await inCtx(mig, APP_CTX(), [
    { sql: G3_PLAN_INSERT, params: [world.tenantId, world.businessId, planId, invoiceId, world.customerId3, world.userId] },
    { sql: G3_SCHED_INSERT, params: [world.tenantId, world.businessId, planId] },
  ]);
  return { error: r.error, planId };
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
    const customerId3 = randomUUID();
    for (const [id, name] of [
      [customerId, 'R12 Customer'],
      [customerId2, 'R12 F3 Customer'],
      [customerId3, 'R15 FX Customer'],
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
    // ...AND FIVE MORE FOR §G, for the same reason (`TL-P4-COORD-R59`
    // ordered items 2, 3 and 8): §G1 runs the lock-order race THREE times (bare,
    // with the DELETE arm that does not help, and with the caller's remedy) and
    // each run leaves a cancelled plan behind; §G2 and §G4 each assert that the
    // invoice they use carries NO plan at all, so neither may share an invoice
    // with §G1. The first pass of §G let §G1's remedy arm and §G2 share
    // `gInvoiceIds[2]` and let §G4 share `gInvoiceIds[0]`, and both read the
    // OTHER case's leftover plan: `expected 1 to be +0`. Disclosed, and
    // re-taken on five invoices nothing else touches.
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
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
        // NUMBERED FROM 11 so that nothing here can collide with `INV-9`, the
        // FX invoice written below with its own `number_seq`.
        [tenantId, businessId, invoiceId, saleId, owner, branchId, STAMP, SHA, userId, `INV-${i + 11}`, i + 11],
      );
      ids.push(invoiceId);
    }
    // ── THE ONE INVOICE WHOSE BASE TOTAL IS NOT ITS TXN TOTAL
    //    (`TL-P4-COORD-R59` ordered item 7, §6).
    //
    // The live suite's §E base-conservation arm is DEGENERATE and both the
    // round-14 author and its challenger said so: its business is ILS, its
    // invoice is ILS, `source_to_base_rate` is 1, so `base === txn` and the
    // base law there has the same arithmetic content as the txn law. There was
    // therefore NO live, in-PostgreSQL measurement of base conservation where
    // base <> txn anywhere in this slice — the non-degenerate case existed only
    // in TypeScript against the reference model.
    //
    // This is that measurement's fixture, and it is a LAWFUL foreign-currency
    // invoice rather than an inconsistent row: `0075`'s
    // `invoices_rate_shape_ck` requires `rate_source = 'base'` to coincide
    // EXACTLY with `fx_rate_id IS NULL AND source_to_base_rate = 1`, so a row
    // with a real rate needs a real `accounting_fx_rates` row behind it, and
    // `invoices_fx_rate_fk` enforces that. Both are written here. USD 9000.00
    // at 0.8450011111 ILS/USD gives a base total of 760501 agurot, which is the
    // same pair of figures the domain-core fixture uses — deliberately, so the
    // live reading and the pure model can be compared on one arithmetic.
    const fxRateId = randomUUID();
    await c.query(
      `INSERT INTO accounting_fx_rates (tenant_id,business_id,id,from_currency,to_currency,rate,source,effective_at,entered_by_user_id)
       VALUES ($1,$2,$3,'USD','ILS',0.8450011111,'manual',$4::timestamptz,$5)`,
      [tenantId, businessId, fxRateId, STAMP, userId],
    );
    const fxSaleId = randomUUID();
    const baseFxInvoiceId = randomUUID();
    await c.query(
      `INSERT INTO sales (tenant_id,business_id,id,customer_id,branch_id,warehouse_id,status,settlement_mode,document_date,currency_code,
                          subtotal_txn_minor,discount_txn_minor,total_txn_minor,total_base_minor,source_to_base_rate,rate_source,rate_timestamp,
                          customer_name_snapshot,commit_intent_sha256,confirmed_by,confirmed_at,business_transaction_id,created_by,binding_source_id)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed','credit','2026-01-02','USD',900000,0,900000,760501,0.8450011111,'manual',$7::timestamptz,'R15 FX Customer',$8,$9,$7::timestamptz,gen_random_uuid(),$9,$3)`,
      [tenantId, businessId, fxSaleId, customerId3, branchId, warehouseId, STAMP, SHA, userId],
    );
    await c.query(
      `INSERT INTO invoices (tenant_id,business_id,id,sale_id,customer_id,branch_id,document_kind,document_number,number_seq,period,issue_date,due_date,
                             currency_code,status,subtotal_txn_minor,discount_txn_minor,tax_minor,total_txn_minor,total_base_minor,source_to_base_rate,
                             rate_source,rate_timestamp,fx_rate_id,customer_name_snapshot,issue_intent_sha256,business_transaction_id,created_by,binding_source_id)
       VALUES ($1,$2,$3,$4,$5,$6,'invoice','INV-9',9,'2026','2026-01-02','2026-01-02','USD','open',900000,0,0,900000,760501,0.8450011111,'manual',$7::timestamptz,$10,
               'R15 FX Customer',$8,gen_random_uuid(),$9,$3)`,
      [tenantId, businessId, baseFxInvoiceId, fxSaleId, customerId3, branchId, STAMP, SHA, userId, fxRateId],
    );
    // PR-6, PRE-APPLIED AND DISCLOSED (module header).
    await c.query(`GRANT EXECUTE ON FUNCTION public.supplier_ap_release(BIGINT,BIGINT,BIGINT,BIGINT) TO daftar_app`);
    await c.query('COMMIT');
    await c.query('ALTER TABLE sales ENABLE TRIGGER USER');
    world = {
      tenantId,
      businessId,
      customerId,
      customerId2,
      customerId3,
      invoiceIds: ids.slice(0, 4),
      f3InvoiceId: ids[4] as string,
      gInvoiceIds: ids.slice(5, 10),
      baseFxInvoiceId,
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
    writeMeasurements(M);
    return;
  }
  shippedSync = (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.installment_plan_fact_sync()'::regprocedure) AS d`)).rows[0]?.d as string;
  shippedAging = (await mig.query<{ d: string }>(`SELECT pg_get_functiondef('public.customer_ar_aging(uuid,uuid,date,integer[])'::regprocedure) AS d`)).rows[0]
    ?.d as string;
}, 900_000);

afterAll(async () => {
  writeMeasurements(M);
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

  /**
   * A3 — `mustMatch` IS LOAD-BEARING, AND THE PROOF IS EXECUTED RATHER THAN
   * DECLARED (`TL-P4-COORD-R69` ordered item 4, R16-4).
   *
   * Round 16 shipped `shippedStatement(head, mustMatch)` and said plainly that
   * its non-vacuity arms had NO EXECUTED RED PROOF — DESIGN ONLY. The round-16
   * challenger built the proof and three of its four results were in the
   * round's favour; the fourth was not: `shippedPlanReadPolicy`'s four
   * patterns were all true of the `installments` policy, so a slice that
   * caught the WRONG RELATION threw nothing. «DESIGN ONLY is a disclosure and
   * not a pass» — so the proof lives here now, in the shipped suite, and it
   * runs every time this file runs.
   *
   * Four arms, and the first is the one that was open:
   *   (a) the wrong-relation slice THROWS, now that the relation is pinned;
   *   (b) an unsatisfiable pattern THROWS, for each of the four heads this
   *       file slices, so the mechanism is not decorative on any of them;
   *   (c) an absent head THROWS rather than returning an empty string;
   *   (d) and the four shipped helpers do NOT throw, which is the control that
   *       stops (a) to (c) passing for want of a working slicer.
   */
  it('A3 mustMatch is load-bearing: the wrong relation, an unsatisfiable pattern and an absent head each THROW', () => {
    // (a) THE ROUND-16 GAP, EXECUTED. The `installments` read policy satisfies
    //     every property the plan policy's old patterns pinned, so this slice
    //     is the one the helper promised to refuse and did not.
    expect(() => shippedStatement('CREATE POLICY business_isolation_read ON installments', PLAN_READ_POLICY_MUST_MATCH)).toThrow(/does not satisfy/);
    // ...and it is THE SHIPPED LIST that refuses it, not a list written here:
    // delete the relation pattern from `PLAN_READ_POLICY_MUST_MATCH` and the
    // assertion above goes red. That is what makes this a certification of the
    // helper rather than a demonstration beside it.
    // ...and the thing that makes (a) a REAL gap rather than a contrived one:
    // the four patterns round 16 shipped are each TRUE of that other policy,
    // measured here and not argued.
    const other = shippedStatement('CREATE POLICY business_isolation_read ON installments', []);
    for (const re of [/AS RESTRICTIVE FOR SELECT/, /app_bypass\(\)/, /daftar_accounting_internal/, /business_id = nullif\(app_business\(\), ''\)::uuid/]) {
      expect(re.test(other), `round 16's pattern ${String(re)} is NOT true of the installments policy`).toBe(true);
    }
    // (b) AN UNSATISFIABLE PATTERN THROWS, on every head this file slices.
    for (const head of [
      'CREATE UNIQUE INDEX installment_plans_one_active_per_invoice_uq',
      'CREATE TRIGGER installment_plans_fact_sync',
      'CREATE POLICY business_isolation_read ON installment_plans',
      'CREATE TRIGGER installment_plans_active_exclusive',
    ]) {
      expect(() => shippedStatement(head, [/__NO_SUCH_TEXT_IN_THE_SPECIFICATION__/]), head).toThrow(/does not satisfy/);
      // and each head occurs EXACTLY ONCE, so the slice cannot land on prose.
      expect(SPEC.split(head).length - 1, `${head} is not unique in the specification`).toBe(1);
    }
    // (c) AN ABSENT HEAD THROWS.
    expect(() => shippedStatement('CREATE POLICY no_such_policy ON installment_plans', [])).toThrow(/is not in the specification/);
    // (d) THE CONTROL: the four shipped helpers slice and certify.
    expect(() => shippedActivePlanIndex()).not.toThrow();
    expect(() => shippedFactSyncTrigger()).not.toThrow();
    expect(() => shippedPlanReadPolicy()).not.toThrow();
    expect(() => shippedExclusiveTrigger()).not.toThrow();
    expect(shippedPlanReadPolicy(), 'the plan read policy sliced the wrong relation').toContain('ON installment_plans');
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
    // ROUND 16 (`TL-P4-COORD-R63` item 6): the re-creation was RETYPED and
    // outside a `finally`, which is §B6's defect in a second place. It now
    // reads the shipped statement out of `SPEC` and runs in a `finally`, so a
    // failed assertion in this arm cannot leave every later case in this file
    // without the partial unique index the one-active exclusion rests on.
    try {
      M['B2_drop'] = await ddl(`DROP INDEX installment_plans_one_active_per_invoice_uq`);
      M['B2_ratchet'] = await ratchet();
    } finally {
      M['B2_recreate'] = await ddl(shippedActivePlanIndex());
    }
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
    // ROUND 15, ordered item 4's sweep, found IN THIS FILE: the re-creation below
    // RETYPED the trigger statement. Round 15 then changed that trigger's event
    // list (it added a DELETE arm, measured that the arm cannot fix the lock
    // order, and removed it again) and the retyped copy became a SILENT
    // DOWNGRADE that stripped the arm from the fixture for every later case in
    // the file -- nine reds, none of them about their own subject. Two repairs,
    // both of them the sweep's lesson:
    //   (1) the re-creation reads the SHIPPED statement out of the spec instead
    //       of retyping it -- see `shippedExclusiveTrigger` above; and
    //   (2) it runs in a `finally`, so a failed assertion inside the arm cannot
    //       leave the fixture without the trigger (R56 section 5).
    try {
      M['B6_drop'] = await ddl(`DROP TRIGGER installment_plans_active_exclusive ON installment_plans`);
      M['B6_ratchet'] = await ratchet();
    } finally {
      M['B6_recreate'] = await sudo(shippedExclusiveTrigger());
    }
    M['B6_after'] = await ratchet();
    expect(String(M['B6_ratchet'])).toContain('seven');
    expect(M['B6_after']).toBeNull();
    // NON-VACUITY OF THE RESTORE, read from the catalogue and compared against
    // THE SPEC rather than against a number typed here: the restored trigger's
    // event bits are exactly the ones the shipped statement names.
    const back = await sup.query<{ ins: number; upd: number; del: number }>(
      `SELECT (tgtype & 4) AS ins, (tgtype & 16) AS upd, (tgtype & 8) AS del FROM pg_trigger
        WHERE tgrelid = 'public.installment_plans'::regclass AND tgname = 'installment_plans_active_exclusive'`,
    );
    const stmt = shippedExclusiveTrigger();
    M['B6_restored_bits'] = back.rows[0];
    M['B6_shipped_statement'] = stmt;
    expect(back.rows[0]).toStrictEqual({
      ins: /\bINSERT\b/.test(stmt) ? 4 : 0,
      upd: /\bUPDATE\b/.test(stmt) ? 16 : 0,
      del: /\bDELETE\b/.test(stmt) ? 8 : 0,
    });
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
  v_seq      BIGINT;
BEGIN
  v_seq := coalesce(nullif(pg_catalog.current_setting('installment.plan_fact_sync_events', true), '')::BIGINT, 0) + 1;
  PERFORM pg_catalog.set_config('installment.plan_fact_sync_events', v_seq::TEXT, true);
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
/**
 * THE RESTRICTIVE READ POLICY AS THE SPECIFICATION SHIPS IT -- SLICED, NOT
 * RETYPED (`TL-P4-COORD-R63` item 6). The retyped literal that stood here
 * matched the spec semantically and differed from it in whitespace, so it was
 * latent rather than live; the next edit to the shipped policy is what made it
 * live, which is the whole lesson of §B6.
 */
const RESTORE_PLAN_READ = shippedPlanReadPolicy();

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
    // ROUND 16 (`TL-P4-COORD-R63` item 6): retyped and outside a `finally`,
    // the same shape as §B2 and §B6. Sliced and bracketed now.
    try {
      M['D4_drop'] = await sudo(`DROP TRIGGER installment_plans_fact_sync ON installment_plans`);
      M['D4_read'] = await aging();
    } finally {
      M['D4_recreate'] = await sudo(shippedFactSyncTrigger());
    }
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

  /**
   * ── WHAT THIS CASE MEASURED UNTIL ROUND 27, AND WHY IT MEASURES SOMETHING
   *    ELSE NOW (FINDING C's repair in the specification) ─────────────────
   *
   * It raced two plan creations on one invoice with
   * `installment_plans_one_active_per_invoice_uq` NOT ENFORCING, and asserted
   * that the FIRST writer COMMITTED and the second was refused by name — the
   * point being that the invoice-row lock refuses the loser, not the index.
   *
   * THE FIRST WRITER ONLY COMMITTED BECAUSE THE SHIPPED GUARD FAILED OPEN.
   * `installment_plan_fact_sync` detected an unenforcing index only from
   * inside its own by-primary-key probe's failure path, so with `indisvalid`
   * false the planner could not use that index at all, the probe read the row
   * out of the heap and NOTHING refused. Round 27 takes that `pg_index`
   * reading UNCONDITIONALLY on every non-DELETE plan event, so NO plan write
   * is admitted while any index of the relation is unenforcing — including
   * the first one. This case therefore cannot construct its old subject any
   * more, and it is re-aimed at the law that is actually there rather than
   * left asserting the fail-open.
   *
   * WHAT IS NO LONGER CLAIMED HERE, AND IS NOW **UNMEASURED**: that in the
   * unenforcing state the LOSER of the race is refused by
   * `installment.plan_active_conflict`. No writer is admitted in that state
   * at all, so the claim has no construction. The same claim with the index
   * ENFORCING is §E2's subject and is untouched.
   *
   * AND THE SERIALISATION IS NOT MEASURABLE IN THIS STATE EITHER, WHICH IS
   * MEASURED RATHER THAN ASSUMED. A's refusal is raised inside A's OWN
   * statement, so A's transaction is already ABORTED — `RecordTransactionAbort`
   * has run and its locks are released — by the time B's write arrives, and B
   * never waits for it. The reading is kept and RECORDED: it reports
   * `blocked: false` with the two session states `active` and
   * `idle in transaction (aborted)`, and the aborted state is what is
   * asserted, because it is the mechanism. The lock-order and serialisation
   * laws with the index ENFORCING are §E1's and §E2's subjects and are
   * untouched.
   *
   * WHAT IS STILL MEASURED HERE: that the refusal reaches BOTH writers by
   * name, that A is aborted rather than silently committed, and that NOTHING
   * commits — a strictly stronger end state than the one this case used to
   * assert, since the old one left one plan behind.
   */
  it('E3 the same race with the index NOT ENFORCING: NO writer is admitted and both are refused BY NAME (F-1)', async () => {
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
      // THE FIRST WRITER IS NOW REFUSED TOO, BY THE UNCONDITIONAL CATALOGUE
      // READING. Until round 27 this read `toBeNull()` — it COMMITTED — and
      // that was the fail-open, not a property of the guard.
      expect(String(M['E3_A_plan']), 'a plan write was admitted while an index of the relation is unenforcing').toContain('installment.plan_index_unenforcing');
      // RECORDED AND NOT ASSERTED: whether B blocked. It does not, and the
      // reason is asserted instead — A's transaction is ABORTED by its own
      // refusal before B's write arrives, so there is no lock to wait for.
      expect((M['E3_B_blocked'] as BlockedReading).samples, 'the lock reading was never taken').toBeGreaterThan(0);
      expect(
        JSON.stringify((M['E3_B_blocked'] as BlockedReading).distinct),
        "A's session is not in the aborted state, so the reason B did not wait is unread",
      ).toContain('aborted');
      // THIS IS THE WHOLE OF F-1 ON THE WRITE PATH. Round 11 measured `null`
      // here — no refusal — and two active plans committed, after which the
      // reader served the pre-installment figure silently.
      expect(String(M['E3_B_outcome'])).toContain('installment.plan_index_unenforcing');
      expect((M['E3_post'] as Record<string, unknown>)['active_plans']).toBe(0);
    } finally {
      await A.end();
      await B.end();
      M['E3_reenforce'] = await sudo(
        `UPDATE pg_index SET indisvalid = true, indisready = true WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
      );
      // UNTIL ROUND 27 A's plan row was written while the index was NOT
      // MAINTAINED, so it was absent from the index and flipping the flags
      // back did not put it there. No plan row is written in this state any
      // more, so that fixture debt is gone; the paragraph is kept because the
      // SHAPE it describes is still the one §R17 of the fact suite builds by
      // other means, and because the `REINDEX` reading below is retained for
      // the reason it states. Round
      // 12's suite did not notice because its count was index-served and so
      // agreed with the index by construction; the figures below were
      // therefore taken on a fixture whose index did not describe its own
      // heap, and the later cases on invoice 2 and 3 inherited it. Disclosed.
      //
      // The repair is the one the refusal's own message names. `REINDEX`
      // SUCCEEDING is itself a measurement: it would raise `23505` if two
      // active plans had actually committed, so a null here says the write
      // path held while the index was blind.
      M['E3_reindex'] = await sudo(`REINDEX INDEX public.installment_plans_one_active_per_invoice_uq`);
      expect(M['E3_reindex']).toBeNull();
      M['E3_ratchet'] = await ratchet();
      expect(M['E3_ratchet']).toBeNull();
    }
  });

  it('E4 with the exclusion trigger GONE and the index not enforcing, the UNCONDITIONAL INDEX READING refuses BOTH writers', async () => {
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
      // ── AND FROM ROUND 27 THE INDEX READING REFUSES BEFORE THE COUNT DOES
      //    (FINDING C's repair). `installment_plan_fact_sync` reads
      //    `pg_index` unconditionally on every non-DELETE plan event, so with
      //    the index not enforcing NEITHER writer is admitted: A is refused
      //    by `installment.plan_index_unenforcing` where it used to commit,
      //    and B is refused by the same name where it used to meet the
      //    AFTER-trigger count. A's write used to be admitted ONLY because
      //    that detection was conditional on its own probe missing the row,
      //    which `indisvalid = false` made impossible — the fail-open.
      //
      //    WHAT IS THEREBY **UNMEASURED** HERE, stated and not dropped: that
      //    `installment.plan_active_unbounded` is the arm that refuses the
      //    second writer under concurrency with the BEFORE trigger gone and
      //    the index not enforcing. That state admits no write at all now, so
      //    the claim has no construction in this suite. The AFTER arm's count
      //    is still measured single-threaded by the fact suite, and the
      //    DEFERRED arm remains unmeasured under concurrency exactly as the
      //    paragraph above already declares.
      //
      //    AND THE SERIALISATION IS NOT MEASURABLE HERE ANY MORE, for two
      //    measured reasons rather than one: the sync now raises BEFORE it
      //    reaches the `UPDATE` of `invoices` that used to take the row, and
      //    A's transaction is ABORTED by its own refusal before B's write
      //    arrives. The lock reading is RECORDED, not asserted, and what is
      //    asserted is the aborted state that explains it. §E1 and §E2 own
      //    the serialisation laws with the index enforcing.
      //
      //    WHAT IS STILL MEASURED: that neither writer is admitted, by name,
      //    and that nothing commits.
      expect(String(M['E4_A_plan']), 'a plan write was admitted while an index of the relation is unenforcing').toContain('installment.plan_index_unenforcing');
      expect((M['E4_B_blocked'] as BlockedReading).samples, 'the lock reading was never taken').toBeGreaterThan(0);
      expect(
        JSON.stringify((M['E4_B_blocked'] as BlockedReading).distinct),
        "A's session is not in the aborted state, so the reason B did not wait is unread",
      ).toContain('aborted');
      expect(M['E4_A_commit']).toBeNull();
      expect(String(M['E4_B_outcome'])).toContain('installment.plan_index_unenforcing');
      expect(String(M['E4_B_outcome'])).not.toContain('23505');
      expect((M['E4_post'] as Record<string, unknown>)['active_plans']).toBe(0);
    } finally {
      await A.end();
      await B.end();
      // Sliced from the spec, never retyped -- see `shippedExclusiveTrigger`.
      M['E4_recreate'] = await sudo(shippedExclusiveTrigger());
      M['E4_reenforce'] = await sudo(
        `UPDATE pg_index SET indisvalid = true, indisready = true WHERE indexrelid = 'public.installment_plans_one_active_per_invoice_uq'::regclass`,
      );
      // Same disclosure as §E3: A's row was written into an unmaintained
      // index and `REINDEX` is both the repair and the proof that only one
      // active plan committed.
      M['E4_reindex'] = await sudo(`REINDEX INDEX public.installment_plans_one_active_per_invoice_uq`);
      expect(M['E4_reindex']).toBeNull();
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
      // ── THE FIXTURE DEFECT THIS CASE SHIPPED, FIXED (`TL-P4-COORD-R55` §9;
      //    the round-13 challenger's §3.1 reading, which is the round-12
      //    challenger's own WITHDRAWN method defect found alive in this file).
      //
      //    Each actor's FIRST plan got a schedule and its SECOND did not, so
      //    the survivor of the deadlock was refused AT COMMIT by obligation
      //    (a) — `installment.schedule_incomplete`, schedule 100000 against a
      //    total of 900000 — and the case's own title («two invoices in
      //    opposite order still deadlock») was measuring ONE actor reaching
      //    the lock-order question while the other never got there. The
      //    `40P01` was real; the «nothing committed» end state was partly the
      //    fixture's doing. The survivor's second plan now gets its schedule,
      //    so BOTH actors reach the question and the surviving transaction is
      //    a LAWFUL one that must commit.
      if (M['E9_A2'] === null) M['E9_A2s'] = await A.q(SCHED_INSERT, [world.tenantId, world.businessId, a2]);
      if (M['E9_B2'] === null) M['E9_B2s'] = await B.q(SCHED_INSERT, [world.tenantId, world.businessId, b2]);
      M['E9_A_commit'] = await A.q('COMMIT');
      M['E9_B_commit'] = await B.q('COMMIT');
      M['E9_post_i1'] = await state(i1);
      M['E9_post_i2'] = await state(i2);
      const outcomes = `${M['E9_A2']} ${M['E9_B2']}`;
      M['E9_outcomes'] = outcomes;
      // ONE victim, `40P01`, and no state corrupted — the victim rolled back.
      expect(outcomes).toContain('40P01');
      // EXACTLY ONE victim: the other actor's second write succeeded, which is
      // what «reached the lock-order question» means.
      expect(
        [M['E9_A2'], M['E9_B2']].filter((x) => x === null),
        'both actors were refused, so neither reached the question',
      ).toHaveLength(1);
      // AND THE SURVIVOR COMMITS, which is the arm the fixture defect hid: no
      // `schedule_incomplete` from either side any more.
      const commits = `${String(M['E9_A_commit'])} ${String(M['E9_B_commit'])}`;
      expect(commits, 'the surviving transaction is still refused at COMMIT by the fixture').not.toContain('schedule_incomplete');
      M['E9_survivor_committed'] = M['E9_A2'] === null ? M['E9_A_commit'] : M['E9_B_commit'];
      expect(M['E9_survivor_committed'], 'the actor that reached the question did not commit').toBeNull();
      // ...so the survivor's TWO plans are the state, one per invoice.
      for (const k of ['E9_post_i1', 'E9_post_i2']) {
        const s = M[k] as Record<string, unknown>;
        expect(Number(s['active_plans']), `${k} active plans`).toBe(1);
        expect(s['flag'], `${k} flag`).toBe('true');
      }
    } finally {
      await A.end();
      await B.end();
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 * §G ROUND 15 — THE DELETE LOCK ORDER MEASURED AND REMEDIED IN THE CALLER,
 *    THE `SET CONSTRAINTS` REMEDY, AND BASE CONSERVATION WHERE BASE <> TXN
 *    (`TL-P4-COORD-R59` ordered items 2, 3 and 7)
 * ══════════════════════════════════════════════════════════════════════════
 */
describe('P4-S7 §G round 15 — the DELETE inversion, the SET CONSTRAINTS remedy, and base <> txn', () => {
  /**
   * G1. THE MEASURED ONE-INVOICE `40P01`, THE TRIGGER THAT CANNOT FIX IT, AND
   *     THE CALLER STATEMENT THAT DOES (`TL-P4-COORD-R59` ordered item 2,
   *     F14-2).
   *
   * The round-14 challenger measured a deadlock on ONE invoice from TWO
   * ORDINARY operations, one statement each: an ordinary invoice write holds
   * the invoice row, a deleter of the active plan takes the plan row and
   * blocks on the invoice row, and the invoice writer then cancels that plan
   * through the DOCUMENTED route. Section 3a-ter listed `40P01` for «two
   * invoices, opposite order» only, and its stated remedy — one invoice per
   * statement, ascending `invoices.id` — could not reach this case at all.
   *
   * THIS CASE HAS THREE ARMS AND THE SECOND IS THE ONE THIS ROUND LEARNED
   * FROM.
   *
   *   (1) BARE: the challenger's race, reproduced. `40P01`, and `55P03` from a
   *       third backend proving the deleter held rank 6 while awaiting rank 3.
   *   (2) THE TRIGGER THAT WAS SUPPOSED TO FIX IT: a `BEFORE INSERT OR UPDATE
   *       OR DELETE` trigger whose DELETE arm takes the invoice row first.
   *       MEASURED TO CHANGE NOTHING — still `55P03`, still `40P01` — because
   *       for a `BEFORE ROW DELETE` trigger the executor produces `OLD`
   *       through `GetTupleForTrigger`, which LOCKS that tuple before the
   *       trigger function is called. This arm is the evidence for section
   *       3a-ter's claim that no trigger of this slice can close the case, and
   *       it is a RED PROOF of the shipped trigger shape at the same time: the
   *       planted trigger is restored in a `finally`.
   *   (3) THE REMEDY THAT DOES REACH IT: the deleter takes the invoice row
   *       `FOR NO KEY UPDATE` ITSELF, as its own first statement, before it
   *       deletes anything. It then holds NOTHING while it waits (`null` from
   *       the third-backend probe on the plan row), and when the invoice
   *       writer commits, the deleter completes.
   */
  it('G1 the one-invoice DELETE cycle is MEASURED, no BEFORE DELETE arm can fix it, and the caller statement that does is measured too', async () => {
    const round14 = `CREATE TRIGGER installment_plans_active_exclusive
                       BEFORE INSERT OR UPDATE OR DELETE ON installment_plans
                       FOR EACH ROW EXECUTE FUNCTION installment_plan_active_exclusive()`;
    /**
     * ARM 2's PLANT IS A BODY AS WELL AS A TRIGGER, and that is not a detail.
     *
     * The first version of arm 2 planted ONLY the trigger. The shipped body has
     * no `DELETE` branch, so on a `DELETE` it falls through to
     * `v_was_active := (TG_OP = 'UPDATE' ...)` and then reads `NEW.status` --
     * and `NEW` is UNASSIGNED in a `DELETE` trigger. The arm therefore RAISED
     * instead of waiting, no cycle could form, `B`'s cancel blocked on the row
     * `GetTupleForTrigger` had already locked for the aborted statement, and the
     * CASE ITSELF HUNG until vitest timed it out -- after which every later case
     * in the file queued behind the two abandoned transactions. Measured, in
     * this file, from `pg_stat_activity` and `pg_locks`.
     *
     * So the plant is the SHIPPED body plus the arm: `pg_get_functiondef` gives
     * the exact shipped definition, the arm is inserted after its first `BEGIN`,
     * and the restore re-applies the definition that was read. The end-state
     * block's digest law is what certifies the restore was exact -- a restored
     * body that differs by one byte reds `M['G1_restore_ratchet']`.
     */
    const plantDeleteArm = async (): Promise<{ planted: string | null; shipped: string }> => {
      const shipped = String(
        (await sup.query<{ d: string }>(`SELECT pg_get_functiondef('public.installment_plan_active_exclusive()'::regprocedure) AS d`)).rows[0]?.d ?? '',
      );
      const at = shipped.indexOf('\nBEGIN\n', shipped.indexOf('$function$'));
      if (at < 0) throw new Error('the shipped definition has no BEGIN to plant after');
      const arm = [
        '',
        "IF TG_OP = 'DELETE' THEN",
        "  IF OLD.status = 'active' THEN",
        '    PERFORM 1 FROM public.invoices i',
        '      WHERE i.business_id = OLD.business_id AND i.id = OLD.invoice_id',
        '      FOR NO KEY UPDATE;',
        '  END IF;',
        '  RETURN OLD;',
        'END IF;',
      ].join('\n');
      const planted = shipped.slice(0, at + '\nBEGIN'.length) + arm + shipped.slice(at + '\nBEGIN'.length);
      return { planted: await sudo(planted), shipped };
    };
    // THE SHIPPED TRIGGER'S SHAPE IS READ FROM THE CATALOGUE FIRST, so «there
    // is no DELETE arm» is a reading and not an assumption about the file that
    // was applied.
    M['G1_tgtype_shipped'] = (
      await sup.query<{ t: number }>(
        `SELECT t.tgtype::int AS t FROM pg_trigger t WHERE t.tgrelid = 'public.installment_plans'::regclass AND t.tgname = 'installment_plans_active_exclusive'`,
      )
    ).rows[0]?.t;
    // bit 1 BEFORE (2), bit 2 INSERT (4), bit 3 DELETE (8), bit 4 UPDATE (16)
    expect(Number(M['G1_tgtype_shipped']) & 2, 'the shipped trigger is not BEFORE').toBe(2);
    expect(Number(M['G1_tgtype_shipped']) & 8, 'the shipped trigger fires on DELETE, which was measured not to help').toBe(0);

    /**
     * One run of the race, on its own invoice. `lockFirst` is the REMEDY: the
     * deleter takes the invoice row itself, as its own first statement.
     */
    const race = async (label: string, invoiceId: string, lockFirst: boolean): Promise<void> => {
      const seeded = await commitPlan(invoiceId);
      M[`${label}_seed`] = seeded.error;
      expect(M[`${label}_seed`], `${label}: the active plan this race is about was refused`).toBeNull();
      const A = new Actor(`${label}A`, 'daftar_migrator'); // the deleter
      const B = new Actor(`${label}B`, 'daftar_migrator'); // the ordinary invoice writer
      try {
        // 20 seconds, which is 20x `deadlock_timeout`: a real `40P01` always
        // arrives first, and a DEFECTIVE arm fails under its own name instead
        // of hanging the file. See `Actor.open`.
        await A.open('READ COMMITTED', 20000);
        await B.open('READ COMMITTED', 20000);
        // B takes the invoice row the way an ORDINARY invoice write of a
        // non-key column takes it. Nothing exotic is needed for B's half.
        M[`${label}_B_invoice_row`] = await B.q('SELECT 1 FROM invoices WHERE id = $1 FOR NO KEY UPDATE', [invoiceId]);
        expect(M[`${label}_B_invoice_row`], `${label}: the ordinary invoice write could not take the invoice row`).toBeNull();
        // NON-VACUITY OF B'S HALF, and it is here because its absence is what
        // broke this case once: a `SELECT ... FOR NO KEY UPDATE` that matches
        // NO ROW returns success and holds nothing, after which the race has no
        // counterparty and the whole arm measures nothing. A third backend
        // asks with `NOWAIT`: `55P03` is proof that B holds that row.
        M[`${label}_B_holds_invoice`] = await invoiceRowProbe(invoiceId);
        expect(String(M[`${label}_B_holds_invoice`]), `${label}: B does not hold the invoice row, so there is no race`).toContain('55P03');
        if (lockFirst) {
          // THE REMEDY, AND IT IS THE FIRST THING A DOES: rank 3 before rank
          // 6. This statement is what blocks, and A holds nothing while it
          // does.
          const firstLock = A.fire('SELECT 1 FROM invoices WHERE business_id = $1 AND id = $2 FOR NO KEY UPDATE', [world.businessId, invoiceId]);
          M[`${label}_A_blocked`] = await awaitLock(A.pid);
          M[`${label}_plan_row_probe`] = await planRowProbe(seeded.planId);
          M[`${label}_B_cancel`] = await B.q(`UPDATE installment_plans SET status = 'cancelled' WHERE id = $1`, [seeded.planId]);
          M[`${label}_B_commit`] = await B.q('COMMIT');
          M[`${label}_A_first_lock`] = await firstLock.promise;
          // ...and then the deleter does its work, which no longer waits for
          // anything: it already holds the invoice row.
          M[`${label}_A_sched`] = await A.q('DELETE FROM installments WHERE plan_id = $1', [seeded.planId]);
          M[`${label}_A_outcome`] = await A.q('DELETE FROM installment_plans WHERE id = $1', [seeded.planId]);
          if (M[`${label}_A_outcome`] === null) M[`${label}_A_commit`] = await A.q('COMMIT');
        } else {
          M[`${label}_A_sched`] = await A.q('DELETE FROM installments WHERE plan_id = $1', [seeded.planId]);
          const fired = A.fire('DELETE FROM installment_plans WHERE id = $1', [seeded.planId]);
          M[`${label}_A_blocked`] = await awaitLock(A.pid);
          // WHAT THE DELETER HOLDS WHILE IT WAITS, asked from a THIRD backend
          // with `NOWAIT`: `55P03` means it holds the plan row (rank 6) while
          // awaiting the invoice row (rank 3) — the inversion itself.
          M[`${label}_plan_row_probe`] = await planRowProbe(seeded.planId);
          // B closes the cycle: it cancels that plan through the documented
          // route, from the transaction that holds the invoice row.
          M[`${label}_B_cancel`] = await B.q(`UPDATE installment_plans SET status = 'cancelled' WHERE id = $1`, [seeded.planId]);
          M[`${label}_A_outcome`] = await fired.promise;
          M[`${label}_B_commit`] = await B.q('COMMIT');
          if (M[`${label}_A_outcome`] === null) M[`${label}_A_commit`] = await A.q('COMMIT');
        }
        M[`${label}_post`] = await state(invoiceId);
      } finally {
        await A.end();
        await B.end();
      }
    };

    // ── ARM 1: THE CHALLENGER'S RACE, AS SHIPPED. The cycle is REAL.
    await race('G1_bare', world.gInvoiceIds[0] as string, false);
    expect((M['G1_bare_A_blocked'] as BlockedReading).blocked, 'the deleter never waited, so this race measured nothing').toBe(true);
    expect(String(M['G1_bare_plan_row_probe']), 'the inversion is not reproducible, so this arm measures nothing').toContain('55P03');
    expect(String(M['G1_bare_A_outcome']), 'the one-invoice deadlock did not reproduce').toContain('40P01');
    expect(M['G1_bare_B_commit'], 'the ordinary invoice writer did not commit').toBeNull();

    // ── ARM 2: WITH THE `BEFORE DELETE` ARM ROUND 15 BUILT FOR THIS. It
    //    changes NOTHING, and that is the measurement section 3a-ter rests on.
    let shippedBody = '';
    try {
      const plant = await plantDeleteArm();
      shippedBody = plant.shipped;
      M['G1_arm_body'] = plant.planted;
      expect(M['G1_arm_body'], `the DELETE arm could not be planted into the body: ${String(M['G1_arm_body'])}`).toBeNull();
      M['G1_arm_drop'] = await ddl('DROP TRIGGER installment_plans_active_exclusive ON installment_plans');
      M['G1_arm_create'] = await sudo(round14);
      expect(M['G1_arm_create'], `the DELETE-arm trigger shape could not be planted: ${String(M['G1_arm_create'])}`).toBeNull();
      // ...and the end-state block REFUSES that shape, which is part 12's
      //    half of this finding: an arm whose rationale is false is refused
      //    by the migration rather than carried.
      M['G1_arm_ratchet'] = await ratchet();
      expect(String(M['G1_arm_ratchet']), 'part 12 accepts a trigger with a DELETE arm it was measured not to need').toContain(
        'installment.migration_end_state_invalid',
      );
      await race('G1_arm', world.gInvoiceIds[1] as string, false);
      expect((M['G1_arm_A_blocked'] as BlockedReading).blocked).toBe(true);
      // THE WHOLE POINT: the arm takes the invoice row FIRST in its own text,
      // and the deleter STILL holds the plan row while it waits — because
      // `GetTupleForTrigger` locked that row before the arm's first statement
      // ran. Two readings, identical to arm 1.
      expect(String(M['G1_arm_plan_row_probe']), 'with the DELETE arm the deleter no longer holds rank 6, so the arm DOES help').toContain('55P03');
      expect(String(M['G1_arm_A_outcome']), 'with the DELETE arm the cycle is gone, so the arm DOES help').toContain('40P01');
    } finally {
      M['G1_restore_body'] = shippedBody === '' ? 'the shipped body was never read' : await sudo(shippedBody);
      M['G1_restore_drop'] = await sudo('DROP TRIGGER IF EXISTS installment_plans_active_exclusive ON installment_plans');
      M['G1_restore'] = await sudo(shippedExclusiveTrigger());
      M['G1_restore_ratchet'] = await ratchet();
    }
    expect(M['G1_restore_body'], `the shipped body was not restored: ${String(M['G1_restore_body'])}`).toBeNull();
    expect(M['G1_restore'], `the shipped trigger was not restored: ${String(M['G1_restore'])}`).toBeNull();
    expect(M['G1_restore_ratchet'], `the block refuses the restored trigger: ${String(M['G1_restore_ratchet'])}`).toBeNull();

    // ── ARM 3: THE REMEDY SECTION 3a-ter STATES. One extra statement in the
    //    caller, and the cycle is gone.
    await race('G1_remedy', world.gInvoiceIds[2] as string, true);
    expect((M['G1_remedy_A_blocked'] as BlockedReading).blocked, 'the deleter never waited, so the remedy arm measures nothing').toBe(true);
    // IT HOLDS NO PLAN ROW WHILE IT WAITS — which is the whole remedy, read
    // from a third backend rather than argued from the statement order.
    expect(String(M['G1_remedy_plan_row_probe'] ?? ''), 'the deleter still holds the plan row while awaiting the invoice row').not.toContain('55P03');
    expect(M['G1_remedy_plan_row_probe'], 'the plan-row probe failed for some other reason').toBeNull();
    expect(M['G1_remedy_B_cancel'], 'the documented cancel route was refused').toBeNull();
    expect(M['G1_remedy_B_commit']).toBeNull();
    expect(String(M['G1_remedy_A_outcome'] ?? 'null'), 'the remedy does not remove the cycle').not.toContain('40P01');
    // AND THE DELETE ITSELF IS LAWFUL AFTERWARDS: B cancelled the plan, so A
    // deletes a NON-ACTIVE plan and the fact needs no write. Whatever the
    // outcome, it is not a deadlock and the end state satisfies the block.
    M['G1_remedy_ratchet'] = await ratchet();
    expect(M['G1_remedy_ratchet'], `the block refuses the state §G1 left: ${String(M['G1_remedy_ratchet'])}`).toBeNull();
    expect((M['G1_remedy_post'] as Record<string, unknown>)['active_plans']).toBe(0);
  });

  /**
   * G2. `SET CONSTRAINTS ALL IMMEDIATE`: THE REFUSAL, THE MESSAGE THAT NAMES
   *     BOTH CAUSES, AND THE ONE-STATEMENT REMEDY THAT REACHES IT
   *     (`TL-P4-COORD-R59` ordered item 3, F14-5; section 3a-quater).
   *
   * Elimination is shown impossible for this obligation — the sum is over rows
   * a LATER statement writes, and they must be later because
   * `installments_plan_fk` references the plan — so what is owed is a remedy a
   * reader can act on. There is one, and it is measured here: write the plan
   * and its whole schedule IN ONE STATEMENT, and the removed deferral is
   * harmless because both relations' AFTER-ROW events then belong to that one
   * statement.
   */
  it('G2 under SET CONSTRAINTS ALL IMMEDIATE the two-statement plan write is refused and the ONE-statement write COMMITS', async () => {
    const inv = world.gInvoiceIds[3] as string;
    const planA = randomUUID();
    const planB = randomUUID();
    // (a) THE REFUSAL, and the message now names BOTH causes and the remedy.
    M['G2_two_statement'] = (
      await inCtx(mig, APP_CTX(), [
        { sql: 'SET CONSTRAINTS ALL IMMEDIATE' },
        { sql: PLAN_INSERT, params: planArgs(planA, inv, 'active') },
        { sql: SCHED_INSERT, params: [world.tenantId, world.businessId, planA] },
      ])
    ).error;
    M['G2_after_refusal'] = await state(inv);
    expect(String(M['G2_two_statement']), 'the forced-early write is no longer refused by the schedule law').toContain('installment.schedule_incomplete: (a)');
    // THE MESSAGE IS THE REPAIR: it names the removed deferral, says nothing
    // is wrong with the schedule in that case, and gives the one-statement
    // remedy — instead of sending its reader to a schedule that was fine.
    for (const token of ['SET CONSTRAINTS ALL IMMEDIATE', 'NO instalment row at all', 'ONE statement', 'data-modifying CTE', 'TWO STATES REACH THIS']) {
      expect(String(M['G2_two_statement']), `the refusal does not say ${token}`).toContain(token);
    }
    // ...and it FAILS CLOSED: nothing committed.
    expect((M['G2_after_refusal'] as Record<string, unknown>)['plans']).toBe(0);
    expect((M['G2_after_refusal'] as Record<string, unknown>)['flag']).toBe('false');

    // (b) THE REMEDY, in the same transaction shape and the same fixture: the
    //     plan and its whole schedule in ONE data-modifying statement.
    M['G2_one_statement'] = (
      await inCtx(mig, APP_CTX(), [
        { sql: 'SET CONSTRAINTS ALL IMMEDIATE' },
        {
          sql: `WITH p AS (
                  INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
                  VALUES ($1,$2,$3,$4,$5,'active',100000,'2026-01-02'::DATE,$6,gen_random_uuid())
                  RETURNING id
                )
                INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
                SELECT $1,$2,gen_random_uuid(),p.id,v.seq,v.due::DATE,v.amt
                  FROM p, (VALUES (1,'2026-02-02',400000::BIGINT),(2,'2026-06-02',400000::BIGINT)) AS v(seq,due,amt)`,
          params: [world.tenantId, world.businessId, planB, inv, world.customerId, world.userId],
        },
      ])
    ).error;
    M['G2_after_remedy'] = await state(inv);
    expect(M['G2_one_statement'], `the one-statement remedy does not work: ${String(M['G2_one_statement'])}`).toBeNull();
    expect((M['G2_after_remedy'] as Record<string, unknown>)['active_plans']).toBe(1);
    expect((M['G2_after_remedy'] as Record<string, unknown>)['flag']).toBe('true');
    // AND THE REMEDY IS NOT A WEAKENING: the SAME one statement with a
    // schedule that genuinely does not sum is still refused.
    const planC = randomUUID();
    M['G2_one_statement_short'] = (
      await inCtx(mig, APP_CTX(), [
        { sql: 'SET CONSTRAINTS ALL IMMEDIATE' },
        {
          sql: `WITH p AS (
                  INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
                  VALUES ($1,$2,$3,$4,$5,'cancelled',100000,'2026-01-02'::DATE,$6,gen_random_uuid())
                  RETURNING id
                )
                INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
                SELECT $1,$2,gen_random_uuid(),p.id,1,'2026-02-02'::DATE,1::BIGINT FROM p`,
          params: [world.tenantId, world.businessId, planC, inv, world.customerId, world.userId],
        },
      ])
    ).error;
    // A cancelled plan is out of the schedule law's scope, so the control that
    // the law still bites must be an ACTIVE plan: it is taken on a fresh
    // active plan whose single instalment does not reach the total.
    const planD = randomUUID();
    M['G2_one_statement_short_active'] = (
      await inCtx(mig, APP_CTX(), [
        { sql: 'SET CONSTRAINTS ALL IMMEDIATE' },
        { sql: `UPDATE installment_plans SET status = 'cancelled' WHERE id = $1`, params: [planB] },
        {
          sql: `WITH p AS (
                  INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
                  VALUES ($1,$2,$3,$4,$5,'active',100000,'2026-01-02'::DATE,$6,gen_random_uuid())
                  RETURNING id
                )
                INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
                SELECT $1,$2,gen_random_uuid(),p.id,1,'2026-02-02'::DATE,1::BIGINT FROM p`,
          params: [world.tenantId, world.businessId, planD, inv, world.customerId, world.userId],
        },
      ])
    ).error;
    expect(String(M['G2_one_statement_short_active']), 'one statement is enough to get a short schedule past the sum law').toContain(
      'installment.schedule_incomplete: (a)',
    );
    // ...and that refusal is the ORDINARY (a) message, not the forced-early
    //    one, because the plan DOES carry an instalment row.
    expect(String(M['G2_one_statement_short_active']), 'the forced-early message is used for a schedule that really is short').not.toContain(
      'NO instalment row at all',
    );
    // THE END STATE, cleaned up through the documented route so §F reads a
    // sound fixture.
    M['G2_cleanup'] = await clearActive(inv);
    M['G2_ratchet'] = await ratchet();
    expect(M['G2_ratchet'], `the block refuses the state §G2 left: ${String(M['G2_ratchet'])}`).toBeNull();
  });

  /**
   * G3. BASE CONSERVATION WHERE BASE <> TXN, IN POSTGRESQL
   *     (`TL-P4-COORD-R59` ordered item 7, §6).
   *
   * The live suite's §E base law is DEGENERATE — ILS business, ILS invoice,
   * rate 1, so `base === txn` and it has the same arithmetic content as the
   * txn law — and the only non-degenerate base measurement in this slice was
   * in TypeScript against the reference model. This is the live one: a LAWFUL
   * USD invoice with an `accounting_fx_rates` row behind it, `total_txn_minor`
   * 900000 and `total_base_minor` 760501, read through the shipped
   * `customer_ar_aging` as `daftar_app`.
   *
   * The law has three parts and the third is the one with content: the bands
   * sum EXACTLY to the authoritative outstanding base; base is NOT txn
   * (asserted, not assumed); and each band's base is the CANONICAL cumulative
   * HALF_EVEN release `apRelease(B, T, releasedBefore, bandTxn)` — consumed
   * from `@daftar/inventory` and never re-implemented here.
   */
  it('G3 the base bands sum to the outstanding BASE and each band is the canonical cumulative release, with base <> txn', async () => {
    const inv = world.baseFxInvoiceId;
    const seeded = await commitG3Plan(inv);
    M['G3_seed'] = seeded.error;
    expect(M['G3_seed'], `the plan on the FX invoice was refused: ${String(M['G3_seed'])}`).toBeNull();
    M['G3_totals'] = (
      await sup.query(
        `SELECT total_txn_minor::text AS txn, total_base_minor::text AS base, currency_code, source_to_base_rate::text AS rate,
                (fx_rate_id IS NOT NULL) AS has_rate_row
           FROM invoices WHERE id = $1`,
        [inv],
      )
    ).rows[0];
    M['G3_outstanding'] = (
      await sup.query(
        `SELECT o.outstanding_txn_minor::text AS txn, o.outstanding_base_minor::text AS base
           FROM invoice_outstanding($1, ARRAY[$2::UUID]) o`,
        [world.businessId, inv],
      )
    ).rows[0];
    const reading = (
      await inCtx(app, { 'app.tenant_id': world.tenantId, 'app.business_id': world.businessId }, [
        {
          sql: `SELECT bucket_no, currency_code, txn_minor::text AS txn, base_minor::text AS base
                  FROM public.customer_ar_aging($1,$2,$3::DATE,$4::INTEGER[]) ORDER BY bucket_no`,
          params: [world.businessId, world.customerId3, '2026-10-07', BUCKETS],
        },
      ])
    ).rows as readonly Record<string, string>[];
    M['G3_reading'] = reading;
    // ── THE FIXTURE IS THE NON-DEGENERATE ONE, ASSERTED AND NOT ASSUMED.
    const T = BigInt(String((M['G3_outstanding'] as Record<string, string>)['txn']));
    const B = BigInt(String((M['G3_outstanding'] as Record<string, string>)['base']));
    expect(B, 'the FX invoice carries no outstanding base, so there is nothing to conserve').toBeGreaterThan(0n);
    expect(B, 'THE FIXTURE IS DEGENERATE AGAIN: base equals txn, so this law has the txn law content').not.toBe(T);
    expect((M['G3_totals'] as Record<string, unknown>)['has_rate_row'], 'the invoice carries no fx_rate_id, so it is not a lawful FX row').toBe(true);
    expect(String((M['G3_totals'] as Record<string, unknown>)['currency_code'])).toBe('USD');
    // ── (1) THE BANDS SUM EXACTLY TO THE AUTHORITATIVE OUTSTANDING BASE.
    const sumBase = reading.reduce((a, r) => a + BigInt(r['base'] as string), 0n);
    const sumTxn = reading.reduce((a, r) => a + BigInt(r['txn'] as string), 0n);
    expect(sumTxn, 'the txn bands do not conserve, so the base reading is on a broken fixture').toBe(T);
    expect(sumBase, 'the base bands do not sum to the outstanding base — the allocation leaks or duplicates a minor unit').toBe(B);
    // ── (2) THE SPLIT IS REAL: more than one band carries base.
    expect(
      reading.filter((r) => BigInt(r['base'] as string) > 0n).length,
      'only one band carries base, so this says nothing about an allocation',
    ).toBeGreaterThan(1);
    // ...and the split is the one the fixture's dates predict, which is what
    //    makes it a reading of the projection rather than of whatever came out:
    //    2026-06-20 -> 4, 2026-08-20 -> 2, 2026-10-05 -> 1 at as_of 2026-10-07.
    expect(
      reading.map((r) => Number(r['bucket_no'])),
      'the bands are not the ones this schedule dates',
    ).toStrictEqual([1, 2, 4]);
    // ── (3) AND EACH BAND IS THE CANONICAL CUMULATIVE HALF_EVEN RELEASE,
    //        consumed from the shipped model rather than re-implemented.
    let before = 0n;
    const perBand: { bucket: number; txn: string; base: string; expected: string }[] = [];
    for (const r of reading) {
      const txn = BigInt(r['txn'] as string);
      const expected = apRelease(B, T, before, txn);
      perBand.push({ bucket: Number(r['bucket_no']), txn: String(txn), base: String(r['base']), expected: String(expected) });
      before += txn;
    }
    M['G3_per_band'] = perBand;
    for (const b of perBand) {
      expect(b.base, `bucket ${b.bucket} base is not apRelease(B,T,before,bandTxn)`).toBe(b.expected);
    }
    // ...and the endpoints of the identity, which is what makes (3) more than
    //    a restatement of (1): the whole txn releases the whole base.
    expect(apRelease(B, T, 0n, T), 'apRelease(B,T,0,T) is not B, so the identity this law rests on does not hold').toBe(B);
    expect(before, 'the bands do not cover the whole outstanding txn').toBe(T);
    // ── CLEANUP through the documented route, so §F reads a sound fixture.
    M['G3_cleanup'] = await clearActive(inv);
    M['G3_ratchet'] = await ratchet();
    expect(M['G3_ratchet'], `the block refuses the state §G3 left: ${String(M['G3_ratchet'])}`).toBeNull();
  });

  /**
   * G4. THE SCHEDULE-SIDE RUNTIME INDEX GAP, CLOSED ON THE HALF A CATALOGUE
   *     READ CAN CLOSE (`TL-P4-COORD-R59` ordered item 8, F14-9).
   *
   * All three runtime `pg_index` readings of this slice covered
   * `installment_plans`; `installments` was read at APPLY TIME only. The
   * schedule sum is taken on the leading pair of
   * `installments_plan_schedule_idx` and is MEASURED index-served with the
   * planner free, so `schedule_incomplete: (a) the schedule sums to X` could
   * state an X that an unenforcing `installments` index produced, with nothing
   * reading to exclude it.
   *
   * `installment_schedule_verify()` now reads the three flags of every index
   * of BOTH relations before any obligation states a figure. Both halves are
   * here: the SHIPPED state refuses the short schedule by its own name, and
   * the UNENFORCING state refuses it as `plan_index_unenforcing` and names the
   * index. `indislive = false` is taken as well, which is the state the
   * round-14 challenger's two failed attempts did not reach.
   */
  it('G4 a schedule refusal reads the indexes of installments before stating a figure, and names an unenforcing one', async () => {
    const inv = world.gInvoiceIds[4] as string;
    await clearActive(inv);
    /** A plan whose single instalment genuinely does NOT reach the invoice total. */
    const shortPlan = async (): Promise<string | null> => {
      const planId = randomUUID();
      return (
        await inCtx(mig, APP_CTX(), [
          { sql: PLAN_INSERT, params: planArgs(planId, inv, 'active') },
          {
            sql: `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
                  VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-02-02'::DATE,400000)`,
            params: [world.tenantId, world.businessId, planId],
          },
        ])
      ).error;
    };
    // ── THE SHIPPED CONTROL: the flags are all true, so the refusal is the
    //    schedule's own name and states the figures.
    M['G4_flags_before'] = (
      await sup.query(
        `SELECT ic.relname::text AS ix, x.indrelid::regclass::text AS rel, x.indisvalid, x.indisready, x.indislive
           FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid
          WHERE x.indrelid IN ('public.installments'::regclass, 'public.installment_plans'::regclass) ORDER BY 1`,
      )
    ).rows;
    M['G4_short_shipped'] = await shortPlan();
    expect(String(M['G4_short_shipped']), 'a short schedule is no longer refused at all').toContain('installment.schedule_incomplete: (a)');
    expect(String(M['G4_short_shipped']), 'the index name is blamed while every flag is true').not.toContain('plan_index_unenforcing');

    // ── THE RED ARMS, one per unenforcing shape, each restored in `finally`.
    for (const [label, flags] of [
      ['G4_unready', `indisvalid = false, indisready = false`],
      ['G4_notlive', `indislive = false`],
    ] as const) {
      try {
        M[`${label}_set`] = await sudo(`UPDATE pg_index SET ${flags} WHERE indexrelid = 'public.installments_plan_schedule_idx'::regclass`);
        expect(M[`${label}_set`], `${label}: the state could not be built: ${String(M[`${label}_set`])}`).toBeNull();
        M[`${label}_outcome`] = await shortPlan();
        M[`${label}_post`] = await state(inv);
        // THE REFUSAL NAMES WHAT IT READ, AND NAMES THE INDEX.
        expect(String(M[`${label}_outcome`]), `${label}: the schedule refusal still states a figure with no index reading`).toContain(
          'installment.plan_index_unenforcing',
        );
        expect(String(M[`${label}_outcome`]), `${label}: the refusal does not name the index it read`).toContain(
          'installments_plan_schedule_idx on installments',
        );
        expect(String(M[`${label}_outcome`]), `${label}: the refusal does not say which relation`).toContain('indisvalid=');
        // AND IT FAILS CLOSED: nothing committed.
        expect((M[`${label}_post`] as Record<string, unknown>)['plans'], `${label}: a plan committed over an unenforcing index`).toBe(0);
      } finally {
        M[`${label}_restore`] = await sudo(
          `UPDATE pg_index SET indisvalid = true, indisready = true, indislive = true WHERE indexrelid = 'public.installments_plan_schedule_idx'::regclass`,
        );
        // `REINDEX` IS ITSELF A MEASUREMENT: it would raise if the heap did not
        // satisfy the index, so a null here says nothing was written past it.
        M[`${label}_reindex`] = await sudo('REINDEX INDEX public.installments_plan_schedule_idx');
      }
      expect(M[`${label}_restore`], `${label}: the flags were not restored`).toBeNull();
      expect(M[`${label}_reindex`], `${label}: the index could not be rebuilt afterwards`).toBeNull();
    }
    // ── AND THE SHIPPED BEHAVIOUR IS BACK, byte for byte: the same short
    //    schedule is refused by the schedule's own name again, which is the
    //    control that stops the repair being a refusal of everything.
    M['G4_short_after'] = await shortPlan();
    expect(String(M['G4_short_after'])).toContain('installment.schedule_incomplete: (a)');
    expect(String(M['G4_short_after'])).not.toContain('plan_index_unenforcing');
    // ...and a LAWFUL plan on the same invoice still commits.
    const lawful = await commitPlan(inv);
    M['G4_lawful_after'] = lawful.error;
    expect(M['G4_lawful_after'], `a lawful plan is refused after §G4: ${String(M['G4_lawful_after'])}`).toBeNull();
    M['G4_cleanup'] = await clearActive(inv);
    M['G4_ratchet'] = await ratchet();
    expect(M['G4_ratchet'], `the block refuses the state §G4 left: ${String(M['G4_ratchet'])}`).toBeNull();
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

  it('F2 EVERY INDEX OF BOTH RELATIONS PHYSICALLY DESCRIBES ITS OWN HEAP, and the writer trigger still sorts first', async () => {
    // ── `TL-P4-COORD-R55` ordered items 1 and 7 (F13-1, F13-9).
    //
    // THERE WAS NO SUCH LAW ANYWHERE IN THIS SLICE. The round-12 corruption —
    // a row committed while `indisready` was false, leaving the flags perfect
    // and the index missing an entry for ever — was repaired with two
    // executable `REINDEX` statements in two `finally` blocks of this file,
    // and a measurement in a teardown is a fixture habit and not an
    // invariant. `R53` §1 called the `REINDEX` «itself a measurement», which
    // is exactly why it had to become a law.
    //
    // THIS FIXTURE IS POPULATED, which is what makes the reading non-vacuous:
    // the apply-time copy of it in part 9d runs on two empty relations.
    const rows = await sup.query<{ n: string }>(`SELECT count(*)::text AS n FROM installment_plans`);
    M['F2_plan_rows'] = rows.rows[0]?.n ?? '0';
    expect(Number(M['F2_plan_rows']), 'the fixture is empty, so this reading establishes nothing').toBeGreaterThan(0);
    // (1) THE TWO ACCESS PATHS AGREE OVER EVERY ROW OF THE RELATION. The
    //     `FILTER` spelling cannot be served by the partial unique index, by
    //     the predicate-implication rule; the `WHERE` spelling can. A
    //     disagreement is an index that holds no entry for a row qualifying
    //     for it.
    const two = await sup.query<{ heap: string; served: string }>(
      `SELECT (SELECT count(*) FILTER (WHERE p.status = 'active') FROM installment_plans p)::text AS heap,
              (SELECT count(*) FROM installment_plans p WHERE p.status = 'active')::text AS served`,
    );
    M['F2_two_paths'] = two.rows[0];
    expect(two.rows[0]?.heap, 'the two access paths disagree: an index does not describe its own heap').toBe(two.rows[0]?.served);
    // (2) AND EVERY INDEX OF BOTH RELATIONS REBUILDS FROM THE HEAP, which is
    //     the physical instrument: `REINDEX` refuses `23505` when the heap
    //     does not satisfy a unique index.
    const ixs = await sup.query<{ ix: string }>(
      `SELECT ic.relname AS ix FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid
        WHERE x.indrelid IN ('public.installment_plans'::regclass, 'public.installments'::regclass) ORDER BY ic.relname`,
    );
    const reindexed: Record<string, string | null> = {};
    for (const r of ixs.rows) reindexed[r.ix] = await ddl(`REINDEX INDEX public.${r.ix}`);
    M['F2_reindex'] = reindexed;
    expect(Object.keys(reindexed).length, 'no index was found to rebuild').toBeGreaterThan(1);
    for (const [ix, e] of Object.entries(reindexed)) expect(e, `REINDEX ${ix}`).toBeNull();
    // (3) AND THE FLAGS OF EVERY INDEX — not only the partial unique one,
    //     which was the only index any law here read before this round.
    M['F2_all_flags'] = (
      await sup.query(
        `SELECT ic.relname AS ix, x.indisvalid, x.indisready, x.indislive
           FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid
          WHERE x.indrelid IN ('public.installment_plans'::regclass, 'public.installments'::regclass) ORDER BY ic.relname`,
      )
    ).rows;
    for (const f of M['F2_all_flags'] as readonly Record<string, unknown>[]) {
      expect([f['indisvalid'], f['indisready'], f['indislive']], `${String(f['ix'])} is not enforcing`).toEqual([true, true, true]);
    }
    // (4) AND THE TRIGGER-NAME ORDER THE DEFERRED VERIFIER'S CORRECTNESS
    //     RESTS ON IS STILL WHAT THE SPECIFICATION INSTALLED.
    const names = await sup.query<{ w: string; v: string }>(
      `SELECT (SELECT min(t.tgname) FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
                WHERE t.tgrelid = 'public.installment_plans'::regclass AND NOT t.tgisinternal
                  AND f.proname = 'installment_plan_fact_sync') AS w,
              (SELECT min(t.tgname) FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
                WHERE t.tgrelid = 'public.installment_plans'::regclass AND NOT t.tgisinternal
                  AND f.proname = 'installment_plan_fact_verify') AS v`,
    );
    M['F2_trigger_order'] = names.rows[0];
    expect(names.rows[0]?.w).toBe('installment_plans_fact_sync');
    expect(names.rows[0]?.v).toBe('installment_plans_fact_verified');
    expect((names.rows[0]?.w ?? 'z') < (names.rows[0]?.v ?? 'a'), 'the writer no longer sorts before the verifier').toBe(true);
  });
});
