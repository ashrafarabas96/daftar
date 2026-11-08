/**
 * P4S7-BUILD — THE TWO AGING LAWS, ON THE SAME DATA, IN THE SAME DATABASE.
 *
 * Owner decision DR-106 clause 3 requires that the installment-aware aging
 * projection be COMPARED AGAINST THE LIVE LAW ON THE SAME DATA before any
 * replacement. Migration `0089` makes that comparison possible by shipping the
 * projection under a name of its own — `customer_ar_aging_installments` —
 * instead of replacing `customer_ar_aging`, so both bodies exist in one
 * cluster and can be asked the same question in the same transaction, about
 * the same rows, as the same role.
 *
 * WHAT IS ASSERTED, AND WHAT IS ONLY REPORTED:
 *
 *   §1 FOR A CUSTOMER WITH NO INSTALMENT PLAN THE TWO LAWS MUST AGREE, row for
 *      row and figure for figure. This is an ASSERTION. It is the one claim
 *      that decides whether the new body is a SUPERSET of the old one or a
 *      different answer to the old question, and the brief that opened this
 *      lane named it as mandatory.
 *   §2 FOR A CUSTOMER WITH NOTHING OPEN both return nothing. An assertion, and
 *      it carries its own positive control: §1 proves the probe can return
 *      rows at all, so an empty result here is a measurement.
 *   §3 WITH AN ACTIVE PLAN THEY DIFFER, and the difference is REPORTED rather
 *      than approved: the buckets are printed in full. What is ASSERTED here
 *      is the invariant that must survive the difference — the two laws report
 *      the SAME TOTAL receivable, in the transaction currency and in the base
 *      currency, because the new law redistributes a figure across dates and
 *      does not recompute it.
 *   §4 PR-6 IS NOT GRANTED BY THE MIGRATION, and the state that leaves is
 *      measured rather than described: `daftar_app` reaching a schedule arm is
 *      REFUSED (`42501`), never served a figure. The grant is then applied HERE,
 *      in this scratch database only, and disclosed, because without it §3
 *      cannot be measured at all.
 *   §5 THE AGREEMENT OF §1 IS NOT AN ARTEFACT OF THE PROBE: cancelling the plan
 *      returns the two laws to agreement on the very invoice that made them
 *      differ. A comparison that could only ever find agreement would be
 *      decoration.
 *
 * THE CLUSTER IS THE ONE THE HELPERS BUILD, and no figure here is attributed
 * to any other engine or to CI.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createScratchDb, urlOf, type ScratchDb } from '../helpers/scratch-db';

const DB = 'daftar_p4s7_two_laws';
const SEALED = 'public.customer_ar_aging';
const SHIPPED = 'public.customer_ar_aging_installments';
const BUCKETS = [30, 60, 90];
const AS_OF = '2026-06-30';
const STAMP = '2026-01-02T08:00:00Z';
const SHA = 'a'.repeat(64);

interface Bucket {
  readonly bucket_no: number;
  readonly currency_code: string;
  readonly txn_minor: string;
  readonly base_minor: string;
  readonly invoice_count: number;
}

interface World {
  readonly tenantId: string;
  readonly businessId: string;
  readonly customerId: string;
  readonly emptyCustomerId: string;
  readonly userId: string;
  readonly invoiceDated: string;
  readonly invoiceTermless: string;
  readonly invoiceThird: string;
}

let db: ScratchDb | undefined;
let sup: Pool;
let mig: Pool;
let app: Pool;
let world: World;
let planId: string;

/** Everything this file measured, printed once so the evidence is the run. */
const M: Record<string, unknown> = {};

const err = (e: unknown): string => {
  const o = e as { code?: string; message?: string };
  return `${o.code ?? 'NO_CODE'}: ${String(o.message ?? e)}`;
};

/** Run `sql` on `pool` with the tenant context the policies read. */
async function withCtx<T>(
  pool: Pool,
  ctx: Record<string, string>,
  fn: (q: (sql: string, params?: readonly unknown[]) => Promise<T[]>) => Promise<T[]>,
): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(ctx)) await c.query(`SELECT set_config($1,$2,true)`, [k, v]);
    const out = await fn(async (sql, params = []) => (await c.query(sql, [...params])).rows as T[]);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const APP_CTX = (): Record<string, string> => ({ 'app.tenant_id': world.tenantId, 'app.business_id': world.businessId });

/**
 * BOTH LAWS, ONE TRANSACTION, ONE SNAPSHOT.
 *
 * The two calls share a transaction deliberately: `STABLE` routines read the
 * transaction's snapshot, so a difference between them cannot be a difference
 * between two moments. Comparing across two transactions would leave that
 * reading available and the comparison would not be one.
 */
async function bothLaws(pool: Pool, customerId: string): Promise<{ sealed: Bucket[]; shipped: Bucket[] }> {
  const rows = await withCtx<{ which: string; b: Bucket }>(pool, APP_CTX(), async (q) => {
    const a = await q(`SELECT * FROM ${SEALED}($1,$2,$3::DATE,$4::INTEGER[]) ORDER BY bucket_no, currency_code`, [
      world.businessId,
      customerId,
      AS_OF,
      BUCKETS,
    ]);
    const b = await q(`SELECT * FROM ${SHIPPED}($1,$2,$3::DATE,$4::INTEGER[]) ORDER BY bucket_no, currency_code`, [
      world.businessId,
      customerId,
      AS_OF,
      BUCKETS,
    ]);
    return [...(a as unknown as Bucket[]).map((x) => ({ which: 'sealed', b: x })), ...(b as unknown as Bucket[]).map((x) => ({ which: 'shipped', b: x }))];
  });
  return {
    sealed: rows.filter((r) => r.which === 'sealed').map((r) => r.b),
    shipped: rows.filter((r) => r.which === 'shipped').map((r) => r.b),
  };
}

const sum = (rows: readonly Bucket[], f: 'txn_minor' | 'base_minor'): bigint => rows.reduce((t, r) => t + BigInt(r[f]), 0n);

beforeAll(async () => {
  db = await createScratchDb(DB, { migratorOwned: true });
  sup = new Pool({ connectionString: urlOf(DB, 'postgres'), max: 3 });
  mig = new Pool({ connectionString: urlOf(DB, 'daftar_migrator'), max: 2 });
  app = new Pool({ connectionString: urlOf(DB, 'daftar_app'), max: 2 });
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
    const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','S7 TWO') RETURNING id`, [
      `s7two-${process.pid}@test.daftar.local`,
    ]);
    const businessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1,'Two Laws Books',$2,'PS','ILS','Asia/Hebron') RETURNING id`,
      [tenantId, `s7two-${process.pid}`],
    );
    const branchId = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1,'Main',true) RETURNING id`, [businessId]);
    const warehouseId = await one(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1,$2,'WH',true) RETURNING id`, [
      businessId,
      branchId,
    ]);
    const customer = async (name: string): Promise<string> => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO customers (tenant_id,business_id,id,name,status,revision,create_intent_sha256,last_intent_sha256,business_transaction_id,created_by,updated_by)
         VALUES ($1,$2,$3,$4,'active',1,$5,$5,gen_random_uuid(),$6,$6)`,
        [tenantId, businessId, id, name, SHA, userId],
      );
      return id;
    };
    const customerId = await customer('Two Laws Customer');
    const emptyCustomerId = await customer('Customer With Nothing Open');

    /** A confirmed credit sale, which an invoice needs: `invoices_sale_uq` is one invoice per sale. */
    const sale = async (totalMinor: number): Promise<string> => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO sales (tenant_id,business_id,id,customer_id,branch_id,warehouse_id,status,settlement_mode,document_date,currency_code,
                            subtotal_txn_minor,discount_txn_minor,total_txn_minor,total_base_minor,source_to_base_rate,rate_source,rate_timestamp,
                            customer_name_snapshot,commit_intent_sha256,confirmed_by,confirmed_at,business_transaction_id,created_by,binding_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed','credit','2026-01-02','ILS',$7,0,$7,$7,1,'base',$8::timestamptz,'Two Laws Customer',$9,$10,$8::timestamptz,gen_random_uuid(),$10,$3)`,
        [tenantId, businessId, id, customerId, branchId, warehouseId, totalMinor, STAMP, SHA, userId],
      );
      return id;
    };

    /**
     * An OPEN invoice. `dueDate` may be null: DR-13 rules that an invoice
     * stating no term is due from its own issue date and ages like any other,
     * and both laws take `coalesce(due_date, issue_date)` — so a termless
     * invoice is in this fixture on purpose, as the arm where the two bodies
     * could most easily have drifted apart.
     */
    const invoice = async (seq: number, dueDate: string | null, totalMinor: number): Promise<string> => {
      const id = randomUUID();
      const saleId = await sale(totalMinor);
      await c.query(
        `INSERT INTO invoices (tenant_id,business_id,id,sale_id,customer_id,branch_id,document_kind,document_number,number_seq,period,issue_date,due_date,
                               currency_code,status,subtotal_txn_minor,discount_txn_minor,tax_minor,total_txn_minor,total_base_minor,source_to_base_rate,
                               rate_source,rate_timestamp,customer_name_snapshot,issue_intent_sha256,business_transaction_id,created_by,binding_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'invoice',$7,$8,'2026','2026-01-02',$9::DATE,'ILS','open',$10,0,0,$10,$10,1,'base',$11::timestamptz,
                 'Two Laws Customer',$12,gen_random_uuid(),$13,$3)`,
        [tenantId, businessId, id, saleId, customerId, branchId, `INV-${seq}`, seq, dueDate, totalMinor, STAMP, SHA, userId],
      );
      return id;
    };

    const invoiceDated = await invoice(1, '2026-01-02', 900_000);
    const invoiceTermless = await invoice(2, null, 500_000);
    const invoiceThird = await invoice(3, '2026-06-02', 300_000);
    await c.query('COMMIT');
    await c.query('ALTER TABLE sales ENABLE TRIGGER USER');
    world = { tenantId, businessId, customerId, emptyCustomerId, userId, invoiceDated, invoiceTermless, invoiceThird };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw new Error(`the fixture world did not build: ${err(e)}`);
  } finally {
    c.release();
  }
  M['world'] = world;
}, 900_000);

afterAll(async () => {
  // THE EVIDENCE IS THE RUN. Written to a file rather than to the console
  // because a reporter may drop what a hook prints, and a measurement that
  // depends on a reporter's choice is not one. `P4S7_EVIDENCE_OUT` names the
  // file; with no such variable it goes to the system temporary directory and
  // nothing in the repository is touched.
  const out = process.env['P4S7_EVIDENCE_OUT'] ?? join(tmpdir(), 'p4s7-two-laws-measurement.json');
  try {
    writeFileSync(out, `${JSON.stringify(M, null, 2)}\n`, 'utf8');
  } catch {
    // A measurement that cannot be written is still a test that ran; the
    // assertions above are the verdict and this file is the transcript.
  }
  await app?.end().catch(() => undefined);
  await mig?.end().catch(() => undefined);
  await sup?.end().catch(() => undefined);
  await db?.drop();
});

describe('P4S7-BUILD section 0 — there is a subject, and it is the migration', () => {
  it('the scratch database was built through 0089 and carries BOTH readers', async () => {
    expect(M['head'], 'the scratch database was not built to the migration this lane ships').toBe('0089_phase4_s7_installment_plans_and_aging.sql');
    const rows = await withCtx<{ proname: string; args: string }>(sup, {}, async (q) =>
      q(
        `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname LIKE 'customer_ar_aging%' ORDER BY 1`,
      ),
    );
    expect(
      rows.map((r) => `${r.proname}(${r.args})`),
      'the two readers are not both installed under their own names',
    ).toEqual([
      'customer_ar_aging(p_business_id uuid, p_customer_id uuid, p_as_of date, p_bucket_days integer[])',
      'customer_ar_aging_installments(p_business_id uuid, p_customer_id uuid, p_as_of date, p_bucket_days integer[])',
    ]);
    M['readers'] = rows;
  });

  it('the seven triggers the new reader requires are installed and enabled, so its refusals are about data and not about itself', async () => {
    const rows = await withCtx<{ n: string }>(sup, {}, async (q) =>
      q(
        `SELECT count(*)::text AS n FROM pg_trigger t
            JOIN pg_proc f ON f.oid = t.tgfoid
            JOIN pg_namespace fn ON fn.oid = f.pronamespace
           WHERE NOT t.tgisinternal AND fn.nspname = 'public' AND t.tgenabled = 'O'
             AND f.proname IN ('installment_plan_fact_sync','installment_plan_fact_verify',
                               'installment_plan_active_exclusive','installment_schedule_verify')`,
      ),
    );
    expect(rows[0]?.n, 'the seven P4-S7 triggers are not all installed and enabled').toBe('7');
    M['triggersEnabled'] = rows[0]?.n;
  });
});

describe('P4S7-BUILD section 1 — the authority the migration withholds, and what it actually costs', () => {
  it('without PR-6 daftar_app cannot call the new reader AT ALL — not even for a customer with no plan', async () => {
    // MEASURED, AND IT CORRECTS WHAT THIS FILE FIRST ASSUMED. The schedule arms
    // are the only arms that CALL `supplier_ap_release`, so the first version of
    // this file expected a customer with no plan to be answered without PR-6 and
    // only the planned arms to be refused. PostgreSQL checks EXECUTE on a
    // routine named in the body when the query is set up, not when a row reaches
    // the expression, so the refusal arrives with ZERO schedule rows in play.
    // The withheld grant therefore makes the new reader wholly uncallable by
    // `daftar_app`, which is a STRONGER fail-closed state than intended and not
    // a weaker one — but it is a different fact and it is recorded as the
    // measurement it is, not as the prediction it replaced.
    let refusal = 'NO REFUSAL — a figure was served';
    try {
      await withCtx<Bucket>(app, APP_CTX(), async (q) =>
        q(`SELECT * FROM ${SHIPPED}($1,$2,$3::DATE,$4::INTEGER[])`, [world.businessId, world.customerId, AS_OF, BUCKETS]),
      );
    } catch (e) {
      refusal = err(e);
    }
    M['s1_refusalWithoutPr6'] = refusal;
    expect(refusal, 'the new reader answered without EXECUTE on supplier_ap_release, so the withheld grant is not fail-closed').toContain('42501');
  });

  it('and the LIVE law is untouched by the migration: it answers exactly as it did before 0089', async () => {
    const live = await withCtx<Bucket>(app, APP_CTX(), async (q) =>
      q(`SELECT * FROM ${SEALED}($1,$2,$3::DATE,$4::INTEGER[]) ORDER BY bucket_no, currency_code`, [world.businessId, world.customerId, AS_OF, BUCKETS]),
    );
    expect(live.length, 'NO SUBJECT — the live law returned no buckets for the fixture receivable').toBeGreaterThan(0);
    expect(sum(live, 'txn_minor'), 'the live law does not total the three open invoices this fixture states').toBe(1_700_000n);
    M['s1_live'] = live;
  });
});

describe('P4S7-BUILD section 2 — PR-6 is applied HERE ONLY, and disclosed', () => {
  it('the grant is made in this scratch database so the new reader can be measured at all', async () => {
    // DISCLOSED. The migration does not make this grant — see
    // `.local-context/OWNER_QUEUE_AR.md`, P4S7-BUILD temporary decision (1).
    // Nothing below may be read as a property of a deployed cluster: every
    // figure the new reader produces in this file is CONDITIONAL on this line.
    const before = await withCtx<{ ok: boolean }>(sup, {}, async (q) =>
      q(`SELECT has_function_privilege('daftar_app','public.supplier_ap_release(bigint,bigint,bigint,bigint)','EXECUTE') AS ok`),
    );
    expect(before[0]?.ok, 'PR-6 was already granted, so section 1 measured nothing').toBe(false);
    await sup.query(`GRANT EXECUTE ON FUNCTION public.supplier_ap_release(BIGINT,BIGINT,BIGINT,BIGINT) TO daftar_app`);
    const after = await withCtx<{ ok: boolean }>(sup, {}, async (q) =>
      q(`SELECT has_function_privilege('daftar_app','public.supplier_ap_release(bigint,bigint,bigint,bigint)','EXECUTE') AS ok`),
    );
    expect(after[0]?.ok, 'the grant did not arrive, so every measurement below would be measuring its absence').toBe(true);
    M['s2_pr6GrantedInFixture'] = true;
  });
});

describe('P4S7-BUILD section 3 — DR-106 clause 3: with no instalment plan, the two laws agree', () => {
  it('row for row and figure for figure, on three open invoices including a termless one', async () => {
    const { sealed, shipped } = await bothLaws(app, world.customerId);
    M['s3_sealed'] = sealed;
    M['s3_shipped'] = shipped;
    // THE POSITIVE CONTROL. Two empty result sets are equal and prove nothing;
    // the comparison is only a comparison if there is something to compare.
    expect(
      sealed.length,
      'NO SUBJECT — the live law returned no buckets at all, so the agreement below would be the agreement of two empty sets',
    ).toBeGreaterThan(0);
    expect(shipped, 'the two aging laws disagree for a customer who has no instalment plan').toEqual(sealed);
    expect(sum(shipped, 'txn_minor'), 'the transaction totals differ').toBe(sum(sealed, 'txn_minor'));
    expect(sum(shipped, 'base_minor'), 'the base totals differ').toBe(sum(sealed, 'base_minor'));
    // And the figure is the receivable the three invoices state, so the
    // agreement is an agreement about the RIGHT number and not merely with
    // each other.
    expect(sum(sealed, 'txn_minor'), 'the live law does not total the three open invoices').toBe(1_700_000n);
    expect(shipped, 'the new law disagrees with the answer the live law gave before PR-6 was applied').toEqual(M['s1_live']);
  });
});

describe('P4S7-BUILD section 4 — a customer with nothing open', () => {
  it('both laws return nothing, and the probe is known to be able to return rows', async () => {
    const { sealed, shipped } = await bothLaws(app, world.emptyCustomerId);
    expect(sealed, 'the live law invented a bucket for a customer with no open invoice').toEqual([]);
    expect(shipped, 'the new law invented a bucket for a customer with no open invoice').toEqual([]);
    expect(
      (M['s3_sealed'] as Bucket[]).length,
      'the emptiness above is only a measurement because section 3 returned rows with the same probe',
    ).toBeGreaterThan(0);
  });
});

describe('P4S7-BUILD section 5 — with an active plan the laws differ, and the difference is reported', () => {
  it('an instalment plan commits, and the invoice-borne fact is written by the trigger and not by hand', async () => {
    planId = randomUUID();
    await withCtx(mig, APP_CTX(), async (q) => {
      await q(
        `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
         VALUES ($1,$2,$3,$4,$5,'active',100000,'2026-01-02'::DATE,$6,gen_random_uuid())`,
        [world.tenantId, world.businessId, planId, world.invoiceDated, world.customerId, world.userId],
      );
      return q(
        `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
         VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-02-02'::DATE,400000),
                ($1,$2,gen_random_uuid(),$3,2,'2026-06-02'::DATE,400000)`,
        [world.tenantId, world.businessId, planId],
      );
    });
    const rows = await withCtx<{ f: boolean }>(sup, {}, async (q) =>
      q(`SELECT has_active_installment_plan AS f FROM invoices WHERE id = $1`, [world.invoiceDated]),
    );
    expect(rows[0]?.f, 'the fact trigger did not write the invoice-borne flag, so no schedule arm would be reached at all').toBe(true);
    M['s5_flag'] = rows[0]?.f;
  });

  it('both laws answer, and THE INVARIANT holds: the same total receivable, redistributed and not recomputed', async () => {
    const { sealed, shipped } = await bothLaws(app, world.customerId);
    M['s5_sealed'] = sealed;
    M['s5_shipped'] = shipped;
    expect(sealed.length, 'NO SUBJECT — the live law returned nothing with a plan in place').toBeGreaterThan(0);
    expect(shipped.length, 'NO SUBJECT — the new law returned nothing with a plan in place').toBeGreaterThan(0);
    expect(sum(shipped, 'txn_minor'), 'the new law reports a different TOTAL receivable, which no redistribution across dates may do').toBe(
      sum(sealed, 'txn_minor'),
    );
    expect(sum(shipped, 'base_minor'), 'the new law reports a different base TOTAL, so the carrying-value law was not merely differenced').toBe(
      sum(sealed, 'base_minor'),
    );
    expect(sum(sealed, 'txn_minor'), 'the fixture receivable is not what this file set up').toBe(1_700_000n);
    // The live law must not have moved because a plan exists: 0089 does not
    // touch it, and this is the measurement of that.
    expect(sealed, 'the LIVE law changed its answer because a plan exists, which it must not').toEqual(M['s1_live']);
  });

  it('THE DIFFERENCE: the planned invoice is aged across its schedule instead of at one date', () => {
    const sealed = M['s5_sealed'] as Bucket[];
    const shipped = M['s5_shipped'] as Bucket[];
    const byBucket = (rows: readonly Bucket[]): Record<string, string> =>
      Object.fromEntries(rows.map((r) => [`${r.bucket_no}:${r.currency_code}`, `${r.txn_minor}/${r.base_minor}/${r.invoice_count}`]));
    const a = byBucket(sealed);
    const b = byBucket(shipped);
    const differences = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .filter((k) => a[k] !== b[k])
      .map((k) => `${k}: live=${a[k] ?? '(none)'} new=${b[k] ?? '(none)'}`);
    M['s5_differences'] = differences;
    // This is the claim DR-106 clause 3 wanted measured: the two laws are NOT
    // the same answer once a plan exists.
    expect(
      differences.length,
      'the two laws agree even with an active plan, so the new body is not installment-aware in this fixture and this section measured nothing',
    ).toBeGreaterThan(0);
    // AND THE DISTRIBUTION IS PINNED, NOT MERELY NON-EMPTY. «A difference
    // exists» is satisfied by a WRONG difference: swap the two instalment
    // dates and the total is still conserved, a difference is still reported,
    // and the test would pass on a reader that aged each instalment at the
    // other one's date. So the exact vector is asserted. 400 000 moves from
    // band 4 to band 1 because the instalment due 2026-06-02 is 28 days past
    // due at the as-of date and 28 is under the first threshold of 30, while
    // the invoice itself (2026-01-02, 179 days) stays in band 4 with the
    // termless one.
    expect(
      Object.entries(b)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, v]) => `${k} ${v}`),
      'the new law distributes the schedule differently than the dates and thresholds of this fixture require',
    ).toEqual(['1:ILS 700000/700000/2', '4:ILS 1000000/1000000/2']);
    expect(
      Object.entries(a)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, v]) => `${k} ${v}`),
      'the live law moved, and 0089 does not touch it',
    ).toEqual(['1:ILS 300000/300000/1', '4:ILS 1400000/1400000/2']);
  });
});

describe('P4S7-BUILD section 6 — the comparison can find agreement AND difference', () => {
  it('cancelling the plan returns the two laws to agreement on the same invoice', async () => {
    await withCtx(mig, APP_CTX(), async (q) =>
      q(`UPDATE installment_plans SET status = 'cancelled' WHERE business_id = $1 AND id = $2`, [world.businessId, planId]),
    );
    const flag = await withCtx<{ f: boolean }>(sup, {}, async (q) =>
      q(`SELECT has_active_installment_plan AS f FROM invoices WHERE id = $1`, [world.invoiceDated]),
    );
    expect(flag[0]?.f, 'the fact trigger did not clear the flag when the plan stopped being active').toBe(false);
    const { sealed, shipped } = await bothLaws(app, world.customerId);
    M['s6_sealed'] = sealed;
    M['s6_shipped'] = shipped;
    expect(shipped, 'with no ACTIVE plan the two laws must agree again, and they do not').toEqual(sealed);
    expect(shipped, 'the agreement after cancelling is not the agreement section 3 measured').toEqual(M['s3_sealed']);
  });
});

/**
 * P4S7-BUILD section 7 — THE ARM THE OTHER SECTIONS CANNOT REACH:
 * a foreign currency and a PART-PAID invoice.
 *
 * `daftar-finance` refused this file's first version, and the refusal was
 * right. Every invoice in sections 1 to 6 carries `source_to_base_rate = 1`
 * and `total_base_minor = total_txn_minor`, and not one of them is paid, so
 * `paid_txn_minor = 0` throughout. On that data the two most delicate parts of
 * the new law are INERT BY CONSTRUCTION:
 *
 *   * `supplier_ap_release(B, T, b, a)` is the IDENTITY when `B = T`, so the
 *     carrying-value distribution across the schedule performs no rounding and
 *     cannot be wrong;
 *   * the settlement clamp `L(c) = least(greatest(c, paid), T)` never clamps,
 *     because `paid = 0` makes `greatest(c, 0) = c` for every level.
 *
 * So `sum(base) == sum(base)` was green BY NECESSITY and not by measurement.
 *
 * WHAT THIS SECTION ADDS, AND WHY IT IS THE REAL TEST. One invoice in USD at
 * `3.6512`, part-paid, under a plan whose down payment is SMALLER than the
 * amount already collected:
 *
 *     total_txn  =  80 000   total_base = 292 096   paid = 30 001
 *     schedule   =  down 10 000  +  30 000  +  40 000   ( = 80 000 )
 *
 * The level boundaries are `0, 10 000, 40 000, 80 000`; the clamp lifts the
 * first two to `30 001`, so the DOWN PAYMENT's share collapses to zero and the
 * first instalment carries `9 999` instead of `30 000`. THE CLAMP IS DOING
 * WORK HERE — on the data of sections 1 to 6 it does none. And every base
 * share is a difference of two ROUNDED cumulative values, so the telescoping
 * has to survive real rounding rather than exact division.
 *
 * THE FIXTURE'S LAWFULNESS IS ENFORCED, NOT ASSERTED. The payment and its
 * allocation are inserted in ONE transaction with EVERY TRIGGER ENABLED, so
 * `payment_allocations_guard` (`0081:1279`) and the deferred
 * `payment_allocations_value_complete` (`0081:1282`) both run at COMMIT — and
 * the second one REFUSES any row whose
 * `invoice_carrying_base_released_minor` is not exactly
 * `supplier_ap_release(total_base, total_txn, before, applied)` (`0081:1035`,
 * `:1053`). The value is therefore computed by calling that very routine in
 * the INSERT and then certified by the database's own verifier. A fixture
 * written with `DISABLE TRIGGER` would be a number this file chose; this one
 * is a number the estate's law admits.
 *
 * AND THAT IS WHY THE TOTALS MAY BE COMPARED AT ALL. The live law reports
 * `total_base − Σ invoice_carrying_base_released_minor`; the new law reports
 * `total_base − F(paid)` where `F` is the same cumulative carrying law. The
 * two agree exactly when the stored releases sum to `F(paid)` — which is
 * R-81, and which `0081`'s verifier enforces row by row rather than leaving to
 * trust. So a disagreement here would be a real finding about either the
 * telescoping or R-81, and an agreement is a measurement of both.
 */
describe('P4S7-BUILD section 7 — a foreign currency, part-paid, with the clamp doing work', () => {
  const FX = {
    totalTxn: 80_000,
    totalBase: 292_096,
    rate: '3.6512000000',
    paid: 30_001,
    down: 10_000,
    first: 30_000,
    second: 40_000,
  } as const;
  let fxCustomerId: string;
  let fxInvoiceId: string;
  let fxPlanId: string;

  it('the world builds, and the database itself certifies the allocation is lawful', async () => {
    const c = await sup.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_binding_fk');
      await c.query('ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_binding_fk');
      await c.query('ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_binding_fk');
      await c.query('ALTER TABLE payment_allocations DROP CONSTRAINT IF EXISTS payment_allocations_binding_fk');
      await c.query('ALTER TABLE sales DISABLE TRIGGER USER');
      // DISCLOSED, AND NARROW ON PURPOSE. `payment_methods` carries its own
      // creation guard — `payment_method.field_immutable: a payment method is
      // created active at revision 1 by its own command's transaction`, measured
      // by this fixture's first attempt — which only a signed command satisfies.
      // The method is SCAFFOLDING here, not the measurement, so its guard alone
      // is silenced. The two triggers that judge THE ALLOCATION stay enabled:
      // `payment_allocations_guard` and the deferred
      // `payment_allocations_value_complete`, which is the one that certifies
      // the carrying release this section exists to test.
      await c.query('ALTER TABLE payment_methods DISABLE TRIGGER USER');
      const one = async (sql: string, p: readonly unknown[] = []): Promise<string> => String((await c.query<{ id: string }>(sql, [...p])).rows[0]?.id);
      fxCustomerId = randomUUID();
      await c.query(
        `INSERT INTO customers (tenant_id,business_id,id,name,status,revision,create_intent_sha256,last_intent_sha256,business_transaction_id,created_by,updated_by)
         VALUES ($1,$2,$3,'FX Customer','active',1,$4,$4,gen_random_uuid(),$5,$5)`,
        [world.tenantId, world.businessId, fxCustomerId, SHA, world.userId],
      );
      const branchId = await one(`SELECT id FROM branches WHERE business_id = $1 LIMIT 1`, [world.businessId]);
      const warehouseId = await one(`SELECT id FROM warehouses WHERE business_id = $1 LIMIT 1`, [world.businessId]);
      const saleId = randomUUID();
      await c.query(
        `INSERT INTO sales (tenant_id,business_id,id,customer_id,branch_id,warehouse_id,status,settlement_mode,document_date,currency_code,
                            subtotal_txn_minor,discount_txn_minor,total_txn_minor,total_base_minor,source_to_base_rate,rate_source,rate_timestamp,
                            customer_name_snapshot,commit_intent_sha256,confirmed_by,confirmed_at,business_transaction_id,created_by,binding_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'confirmed','credit','2026-01-02','USD',$7,0,$7,$8,$9,'manual',$10::timestamptz,'FX Customer',$11,$12,$10::timestamptz,gen_random_uuid(),$12,$3)`,
        [world.tenantId, world.businessId, saleId, fxCustomerId, branchId, warehouseId, FX.totalTxn, FX.totalBase, FX.rate, STAMP, SHA, world.userId],
      );
      fxInvoiceId = randomUUID();
      await c.query(
        `INSERT INTO invoices (tenant_id,business_id,id,sale_id,customer_id,branch_id,document_kind,document_number,number_seq,period,issue_date,due_date,
                               currency_code,status,subtotal_txn_minor,discount_txn_minor,tax_minor,total_txn_minor,total_base_minor,source_to_base_rate,
                               rate_source,rate_timestamp,customer_name_snapshot,issue_intent_sha256,business_transaction_id,created_by,binding_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'invoice','INV-FX',9,'2026','2026-01-02','2026-01-02','USD','open',$7,0,0,$7,$8,$9,'manual',$10::timestamptz,
                 'FX Customer',$11,gen_random_uuid(),$12,$3)`,
        [world.tenantId, world.businessId, fxInvoiceId, saleId, fxCustomerId, branchId, FX.totalTxn, FX.totalBase, FX.rate, STAMP, SHA, world.userId],
      );
      // The chart of accounts is seeded for every business by
      // `accounting_seed_chart_trg()` (`0040:378`), so an account to post a
      // payment method against already exists and is not invented here.
      const accountId = await one(`SELECT id FROM accounts WHERE business_id = $1 ORDER BY code LIMIT 1`, [world.businessId]);
      const methodId = randomUUID();
      await c.query(
        `INSERT INTO payment_methods (tenant_id,business_id,id,system_type,posting_account_id,is_active,requires_reference,sort_order,revision,
                                      create_intent_sha256,last_intent_sha256,business_transaction_id,created_by,updated_by)
         VALUES ($1,$2,$3,'cash',$4,true,false,1,1,$5,$5,gen_random_uuid(),$6,$6)`,
        [world.tenantId, world.businessId, methodId, accountId, SHA, world.userId],
      );
      // THE PAYMENT AND ITS ALLOCATION, IN THIS TRANSACTION AND WITH TRIGGERS
      // ENABLED. `payment_allocation_guard` (`0081:993`) requires the payment
      // to have been created in the same transaction, and the deferred
      // verifier judges the carrying release at COMMIT.
      const paymentId = randomUUID();
      // `payment_allocation_guard` (`0081:982`) requires the allocation to join a
      // payment whose `business_transaction_id` equals
      // `inventory_business_transaction_id()` — the transaction-local carrier
      // `app.business_transaction_id`, which `0055:80` documents as «audit
      // metadata only … Never authority». Setting it is how an ordinary
      // transaction presents the same trace a command would, and it buys no
      // privilege: the carrying release is still judged by the deferred
      // verifier below.
      const traceId = randomUUID();
      const allocationId = randomUUID();
      await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [traceId]);
      // And the scope the settlement guard judges the posting account in —
      // `accounting.scope_mismatch: a settlement account is judged only for the
      // transaction's business`, measured by this fixture's third attempt. These
      // are the same two carriers every read in this file sets; as the cluster
      // owner they buy no privilege, they only say WHICH business this
      // transaction is about.
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [world.tenantId]);
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [world.businessId]);
      // EVERY DERIVED FIGURE IS COMPUTED BY THE ESTATE'S OWN ROUTINES, in the
      // INSERT itself, so not one of them is a number this file chose:
      //   `invoice_carrying_base_released_minor` = `supplier_ap_release(B,T,0,a)`
      //   `payment_base_amount_minor`            = `supplier_convert_base(a,r,2,2)`
      //   `ar_dust_base_minor`                   = release - conversion (`0081:1054`)
      //   `realized_fx_gain_loss_minor`          = payment base - release (`0081:335`)
      // The deferred verifier recomputes all four at COMMIT and refuses any
      // disagreement, so the fixture is certified rather than asserted.
      await c.query(
        `INSERT INTO payments (tenant_id,business_id,id,customer_id,payment_method_id,posting_account_id,currency_code,amount_minor,
                               payment_to_base_rate,rate_source,rate_timestamp,base_amount_minor,payment_date,allocation_count,
                               intent_sha256,business_transaction_id,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,'manual',$9::timestamptz,
                 public.supplier_convert_base($7::BIGINT,$8::NUMERIC,2,2),
                 '2026-03-01',1,$10,$11,$12)`,
        [world.tenantId, world.businessId, paymentId, fxCustomerId, methodId, accountId, FX.paid, FX.rate, STAMP, SHA, traceId, world.userId],
      );
      await c.query(
        `INSERT INTO payment_allocations (tenant_id,business_id,id,payment_id,customer_id,invoice_id,line_no,payment_currency,payment_amount_minor,
                                          payment_to_base_rate,payment_base_amount_minor,invoice_currency,invoice_amount_applied_minor,
                                          invoice_historical_to_base_rate,ar_released_before_txn_minor,invoice_carrying_base_released_minor,
                                          ar_dust_base_minor,realized_fx_gain_loss_minor,binding_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,'USD',$7,$8,
                 public.supplier_convert_base($7::BIGINT,$8::NUMERIC,2,2),
                 'USD',$7,$8,0,
                 public.supplier_ap_release($9::BIGINT,$10::BIGINT,0::BIGINT,$7::BIGINT),
                 public.supplier_ap_release($9::BIGINT,$10::BIGINT,0::BIGINT,$7::BIGINT)
                   - public.supplier_convert_base($7::BIGINT,$8::NUMERIC,2,2),
                 public.supplier_convert_base($7::BIGINT,$8::NUMERIC,2,2)
                   - public.supplier_ap_release($9::BIGINT,$10::BIGINT,0::BIGINT,$7::BIGINT),
                 $3)`,
        [world.tenantId, world.businessId, allocationId, paymentId, fxCustomerId, fxInvoiceId, FX.paid, FX.rate, FX.totalBase, FX.totalTxn],
      );
      // COMMIT is the assertion: the deferred verifier runs here, and a
      // carrying release that is not exactly the law's own figure is refused.
      await c.query('COMMIT');
      await c.query('ALTER TABLE sales ENABLE TRIGGER USER');
      await c.query('ALTER TABLE payment_methods ENABLE TRIGGER USER');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.query('ALTER TABLE sales ENABLE TRIGGER USER').catch(() => undefined);
      await c.query('ALTER TABLE payment_methods ENABLE TRIGGER USER').catch(() => undefined);
      throw new Error(`the FX fixture did not build, and the database refused it: ${err(e)}`);
    } finally {
      c.release();
    }

    const out = await withCtx<{ paid_txn_minor: string; paid_base_minor: string; outstanding_txn_minor: string; outstanding_base_minor: string }>(
      sup,
      {},
      async (q) => q(`SELECT * FROM public.invoice_outstanding($1, ARRAY[$2]::UUID[])`, [world.businessId, fxInvoiceId]),
    );
    const row = out[0];
    expect(row, 'NO SUBJECT — the reader of record returned no row for the FX invoice').toBeDefined();
    // THE CLAMP AND THE ROUNDING ARE BOTH LIVE, and these two numbers are what
    // makes them so. A `paid` of zero or a base equal to the transaction total
    // would make this section measure nothing.
    expect(row?.paid_txn_minor, 'the invoice is not part-paid, so the settlement clamp would be inert here too').toBe(String(FX.paid));
    expect(BigInt(row?.paid_base_minor ?? '0') > 0n, 'no carrying value was released, so the distribution would be inert').toBe(true);
    expect(row?.outstanding_txn_minor).toBe(String(FX.totalTxn - FX.paid));
    M['s7_outstanding'] = row;
  });

  it('with no plan, the two laws agree on a foreign-currency part-paid invoice too', async () => {
    const { sealed, shipped } = await bothLaws(app, fxCustomerId);
    M['s7_noPlan_sealed'] = sealed;
    M['s7_noPlan_shipped'] = shipped;
    expect(sealed.length, 'NO SUBJECT — the live law returned nothing for the FX invoice').toBeGreaterThan(0);
    expect(shipped, 'the two laws disagree on a part-paid foreign-currency invoice with no plan').toEqual(sealed);
    expect(sum(sealed, 'txn_minor'), 'the live law does not report the FX outstanding').toBe(BigInt(FX.totalTxn - FX.paid));
  });

  it('a plan commits whose DOWN PAYMENT is smaller than what is already paid, so the clamp binds', async () => {
    fxPlanId = randomUUID();
    const ctx = { 'app.tenant_id': world.tenantId, 'app.business_id': world.businessId };
    await withCtx(mig, ctx, async (q) => {
      await q(
        `INSERT INTO installment_plans (tenant_id,business_id,id,invoice_id,customer_id,status,down_payment_minor,down_payment_due_date,created_by,business_transaction_id)
         VALUES ($1,$2,$3,$4,$5,'active',$6,'2026-01-02'::DATE,$7,gen_random_uuid())`,
        [world.tenantId, world.businessId, fxPlanId, fxInvoiceId, fxCustomerId, FX.down, world.userId],
      );
      return q(
        `INSERT INTO installments (tenant_id,business_id,id,plan_id,seq_no,due_date,amount_txn_minor)
         VALUES ($1,$2,gen_random_uuid(),$3,1,'2026-02-02'::DATE,$4),
                ($1,$2,gen_random_uuid(),$3,2,'2026-06-02'::DATE,$5)`,
        [world.tenantId, world.businessId, fxPlanId, FX.first, FX.second],
      );
    });
    const flag = await withCtx<{ f: boolean }>(sup, {}, async (q) => q(`SELECT has_active_installment_plan AS f FROM invoices WHERE id = $1`, [fxInvoiceId]));
    expect(flag[0]?.f, 'the fact trigger did not write the flag on the FX invoice').toBe(true);
  });

  it('THE MEASUREMENT: the carrying value telescopes EXACTLY under real rounding, and the clamp is doing work', async () => {
    const { sealed, shipped } = await bothLaws(app, fxCustomerId);
    M['s7_plan_sealed'] = sealed;
    M['s7_plan_shipped'] = shipped;
    expect(shipped.length, 'NO SUBJECT — the new law returned nothing with the FX plan in place').toBeGreaterThan(0);

    // (1) THE INVARIANT, and now it is not green by necessity. The live law
    //     reports `total_base − Σ invoice_carrying_base_released_minor`; the
    //     new law reports `total_base − F(paid)` summed over the schedule's
    //     rounded levels. Equality is R-81 plus exact telescoping, and neither
    //     is reachable on the data of sections 1 to 6.
    expect(sum(shipped, 'base_minor'), 'the base shares do not total the authoritative outstanding base — the telescoping lost or gained a minor unit').toBe(
      sum(sealed, 'base_minor'),
    );
    expect(sum(shipped, 'txn_minor'), 'the transaction shares do not total the authoritative outstanding').toBe(sum(sealed, 'txn_minor'));

    // (2) AND THE BASE TOTAL IS NOT THE TRANSACTION TOTAL, which is the
    //     control proving the rate really is not 1 in this arm. Without it,
    //     (1) could still be the identity case in disguise.
    expect(sum(sealed, 'base_minor') === sum(sealed, 'txn_minor'), 'base equals transaction here, so this section is the identity case again').toBe(false);

    // (3) THE CLAMP BOUND. The down payment of 10 000 sits entirely below the
    //     30 001 already paid, so its share must be ZERO and the first
    //     instalment must carry 9 999 — not 30 000. If the clamp were absent
    //     the schedule would re-age money the customer has already paid, and
    //     the bands would not total the outstanding at all. The test of that
    //     is the TOTAL above; what is asserted here is that the state was
    //     actually reached, so (1) is not a measurement of an easier case.
    expect(BigInt(FX.down) < BigInt(FX.paid), 'the fixture no longer has a down payment below the paid figure, so the clamp is not exercised').toBe(true);
    const differences = (() => {
      const key = (r: Bucket): string => `${r.bucket_no}:${r.currency_code}`;
      const a = Object.fromEntries(sealed.map((r) => [key(r), `${r.txn_minor}/${r.base_minor}/${r.invoice_count}`]));
      const b = Object.fromEntries(shipped.map((r) => [key(r), `${r.txn_minor}/${r.base_minor}/${r.invoice_count}`]));
      return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .sort()
        .filter((k) => a[k] !== b[k])
        .map((k) => `${k}: live=${a[k] ?? '(none)'} new=${b[k] ?? '(none)'}`);
    })();
    M['s7_differences'] = differences;
    expect(differences.length, 'the two laws agree bucket by bucket even with an active plan, so the FX arm measured nothing new').toBeGreaterThan(0);
    // (4) AND THE VECTOR IS PINNED, because conservation plus «a difference
    //     exists» is satisfied by a WRONG distribution: swapping the two
    //     instalment dates conserves the total and still reports a
    //     difference. These five figures are the ones the dates, the
    //     thresholds and the clamp require, and the base pair is what the
    //     rounded carrying levels require:
    //       b1 = the instalment due 2026-06-02, clamped level 40 000,
    //            F(80 000) - F(40 000) = 292 096 - 146 048 = 146 048
    //       b4 = the first instalment's remainder above the paid figure,
    //            40 000 - 30 001 = 9 999, and F(40 000) - F(30 001) = 36 508
    //       the down payment contributes NOTHING and is absent entirely.
    const vector = [...shipped]
      .sort((x, y) => x.bucket_no - y.bucket_no)
      .map((r) => `${r.bucket_no}:${r.currency_code} ${r.txn_minor}/${r.base_minor}/${r.invoice_count}`);
    expect(vector, 'the FX schedule is not distributed as the dates, the thresholds and the clamp require').toEqual([
      '1:USD 40000/146048/1',
      '4:USD 9999/36508/1',
    ]);
  });
});
