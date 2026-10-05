/**
 * BEFORE / AFTER: THE ANSWER AND THE PLAN, FOR THE SET-BASED AR SUM
 * (`0083_phase4_ar_outstanding_set_based.sql`; P4-AL-05, P4-AL-07, P4-AL-74).
 *
 * ── WHAT IS BEING CHANGED, AND WHAT THEREFORE NEEDS PROVING ────────────────
 *
 * `0083` reshapes the receivable read for speed. `customer_ar_outstanding`
 * called `invoice_outstanding` ONCE PER OPEN INVOICE through a `LATERAL`
 * (`0075:783`), which measured 56.3 microseconds per invoice over a 12.858 ms
 * fixed cost and put P4-D's fat-tail read at a p95 of 125.469 ms against a
 * 100 ms ceiling. After `0083` the sum is ONE pass over
 * `payment_allocations UNION ALL customer_credit_applications` grouped by
 * invoice, and the single-invoice reader is a thin wrapper over that one
 * definition, so P4-AL-07 still has exactly one copy of the arithmetic.
 *
 * The budgets measure the speed (`receivables-s4-budgets.test.ts`). The claim
 * this file exists to settle is the other one, and it is the one that matters
 * more, because the subject is financial arithmetic:
 *
 *   THE ANSWER DID NOT MOVE. On ONE database, with ONE population already in
 *   it, every reader of record is asked every question it answers — once at
 *   `0082`, once after `0083` has been applied to that very database, in the
 *   SAME transaction, over the SAME rows. The two answers are compared byte
 *   for byte, as `daftar_app` under row security and as the owner with row
 *   security bypassed. No changed paid amount, no changed outstanding, no
 *   changed base figure, no changed settlement state, no changed aging
 *   bucket, and no refusal that used to be raised and now is not.
 *
 *   THE PER-INVOICE FUNCTION CALL IS GONE. `EXPLAIN (ANALYZE, BUFFERS)` of
 *   the AR read, before and after, recorded in full. The assertion is the
 *   narrow, durable one — not "the planner must choose algorithm X forever":
 *   at `0082` the plan's `invoice_outstanding` scan is entered once per
 *   invoice, and after `0083` the reducer relations are scanned ONCE.
 *
 * This is the shape `tests/performance/accounting-rls-equivalence.test.ts`
 * established for `0052` and it is followed deliberately: its own subject was
 * also "the same answer, expressed faster", and the estate has accepted that
 * evidence once already.
 *
 * ── THE POPULATION, AND WHY IT IS WRITTEN DIRECTLY ─────────────────────────
 *
 * The question is whether TWO READINGS OF THE SAME ROWS AGREE. So the rows
 * are written directly, with the reducer relations' own triggers and
 * referential checks disabled FOR THE LENGTH OF ONE TRANSACTION THAT IS
 * ALWAYS ROLLED BACK — never through a committed state, never on the shared
 * database, and never on a relation any other suite reads. That is not a
 * shortcut past the writers' laws; it is the only way to ask the reader about
 * the awkward cases, because some of them are exactly the rows the writers
 * REFUSE (an over-allocated invoice, an allocation against a void document, a
 * dangling sale). A reader must not disagree with itself on a row it is handed,
 * whether or not a writer would ever have written it.
 *
 * Every CHECK constraint still holds on every row — `DISABLE TRIGGER` does not
 * reach them — so no row here is malformed in its own columns, and the
 * carrying released figures are computed by the product's own
 * `supplier_ap_release` (`0067:683`), never by a second copy of that
 * arithmetic here (P4-AL-07, R-81).
 *
 * THE CASES COVERED, each one named by `label` in the population below:
 * zero reducers; partial allocation; exact settlement to zero;
 * over-allocation; a credit application with no payment; a payment and a
 * credit application on one invoice; a chain of two allocations plus a credit
 * application; two currencies (base and foreign, with a historical rate);
 * the walk-in invoice whose `customer_id` IS NULL; a draft invoice; a void
 * invoice that nevertheless carries an allocation; a cash-settled invoice that
 * nevertheless carries an allocation; an invoice whose `sale_id` dangles; a
 * second customer in the same business; and a second BUSINESS whose
 * identically shaped rows must never reach the first one's answers.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../apps/api/src/infra/migrate';
import { PG_PASSWORD, PG_PORT, PG_USER, applyBootstrap, ensureDatabase, startOrReuse } from '../helpers/embedded-cluster';

/** The migration under test, and the state measured BEFORE it. */
const BEFORE_HEAD = '0082';
const UNDER_TEST = '0083_phase4_ar_outstanding_set_based.sql';

/** A scratch database of this suite's own. Created here, dropped here. */
const DB = `daftar_ar_setbased_${process.pid}`;
const ownerUrl = (db: string): string => `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${db}`;

/** Copy the migrations at or before `upTo` into a directory of their own. */
function migrationsUpTo(upTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'daftar-ar-setbased-'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (file <= `${upTo}_zzz`) cpSync(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  return dir;
}

// ───── the population ─────────────────────────────────────────────────────

/** Deterministic ids: the comparison is of two captures, and a diff must be readable. */
let idSeq = 0;
const nextId = (): string => {
  idSeq += 1;
  return `00000000-0000-4000-8000-${idSeq.toString(16).padStart(12, '0')}`;
};
const SHA = 'a'.repeat(64);
const STAMP = "'2026-03-01 09:00:00+00'";

interface InvoiceSpec {
  readonly label: string;
  readonly id: string;
  readonly customerId: string | null;
  readonly status: 'draft' | 'open' | 'void';
  readonly settlement: 'cash' | 'credit';
  readonly currency: 'ILS' | 'USD';
  readonly rate: string;
  readonly totalTxn: number;
  readonly dueDate: string | null;
  /** Allocation amounts in invoice currency, in chain order. */
  readonly allocations: readonly number[];
  /** Credit application amounts in invoice currency, in chain order after the allocations. */
  readonly creditApplications: readonly number[];
  /** `sale_id` points at no sale row. */
  readonly danglingSale?: boolean;
}

interface Seeded {
  readonly tenantId: string;
  readonly businesses: { readonly id: string; readonly customers: readonly string[]; readonly invoices: readonly InvoiceSpec[] }[];
}

/**
 * One business's worth of cases, over the first two of its three customers.
 *
 * The THIRD customer carries no case at all: it is the fat-tail arm of the
 * PLAN half, and it is kept clean on purpose. One of the cases below — the
 * invoice whose `sale_id` dangles — makes its customer's whole AR read REFUSE
 * (the reader joins the sale and a missing one is `invoice.not_found`, before
 * `0083` and after it alike, which the capture records), and a plan cannot be
 * taken of a read that refuses.
 */
function invoicesFor(customers: readonly string[], offsetLabel: string): InvoiceSpec[] {
  const c1 = customers[0] as string;
  const c2 = customers[1] as string;
  const spec = (
    label: string,
    customerId: string | null,
    status: 'draft' | 'open' | 'void',
    settlement: 'cash' | 'credit',
    currency: 'ILS' | 'USD',
    rate: string,
    totalTxn: number,
    dueDate: string | null,
    allocations: readonly number[],
    creditApplications: readonly number[],
    danglingSale = false,
  ): InvoiceSpec => ({
    label: `${offsetLabel}/${label}`,
    id: nextId(),
    customerId,
    status,
    settlement,
    currency,
    rate,
    totalTxn,
    dueDate,
    allocations,
    creditApplications,
    danglingSale,
  });
  return [
    spec('zero reducers', c1, 'open', 'credit', 'ILS', '1.0000000000', 100_00, '2026-01-15', [], []),
    spec('partial allocation', c1, 'open', 'credit', 'ILS', '1.0000000000', 250_00, '2026-02-15', [100_00], []),
    spec('exact settlement', c1, 'open', 'credit', 'ILS', '1.0000000000', 300_00, '2026-03-15', [300_00], []),
    spec('over-allocation', c1, 'open', 'credit', 'ILS', '1.0000000000', 120_00, null, [120_00, 5_00], []),
    spec('credit application only', c1, 'open', 'credit', 'ILS', '1.0000000000', 400_00, '2026-01-03', [], [150_00]),
    spec('payment and credit', c2, 'open', 'credit', 'ILS', '1.0000000000', 500_00, '2026-01-10', [200_00], [50_00]),
    spec('chain of three', c2, 'open', 'credit', 'ILS', '1.0000000000', 900_00, '2026-04-01', [100_00, 250_00], [75_00]),
    spec('foreign currency, partial', c2, 'open', 'credit', 'USD', '3.6500000000', 80_00, '2026-02-01', [30_00], []),
    spec('foreign currency, settled', c2, 'open', 'credit', 'USD', '3.6500000000', 60_00, '2026-02-01', [60_00], []),
    spec('walk-in, cash, no reducer', null, 'open', 'cash', 'ILS', '1.0000000000', 45_00, null, [], []),
    spec('draft', c1, 'draft', 'credit', 'ILS', '1.0000000000', 700_00, '2026-05-01', [], []),
    spec('void with an allocation', c1, 'void', 'credit', 'ILS', '1.0000000000', 800_00, '2026-05-01', [800_00], []),
    spec('cash-settled with an allocation', c2, 'open', 'cash', 'ILS', '1.0000000000', 150_00, '2026-01-04', [150_00], []),
    spec('dangling sale', c1, 'open', 'credit', 'ILS', '1.0000000000', 90_00, '2026-01-04', [], [], true),
  ];
}

/**
 * The release of a chain step, computed BY THE PRODUCT (`0067:683`,
 * `supplier_ap_release`), never by a second copy of that arithmetic here.
 */
async function release(c: Client, baseTotal: number, txnTotal: number, releasedBefore: number, amount: number): Promise<number> {
  // The one step the primitive will not answer for: an OVER-ALLOCATION is
  // beyond the chain `supplier_ap_release` accepts (it refuses a
  // released-before plus applied amount outside the total, which is exactly
  // the writer's law). The reader is being asked to SUM the row, not to
  // validate it, so that step is seeded only on a BASE-CURRENCY invoice,
  // where the carrying released of an amount is that amount and no
  // arithmetic is being chosen here.
  if (releasedBefore + amount > txnTotal) {
    if (baseTotal !== txnTotal) throw new Error('an over-allocated step is seeded only on a base-currency invoice');
    return amount;
  }
  const r = await c.query<{ rel: string }>('SELECT supplier_ap_release($1::bigint, $2::bigint, $3::bigint, $4::bigint)::text AS rel', [
    baseTotal,
    txnTotal,
    releasedBefore,
    amount,
  ]);
  return Number((r.rows[0] as { rel: string }).rel);
}

const TABLES_WITHOUT_TRIGGERS = [
  'customers',
  'sales',
  'invoices',
  'payments',
  'payment_allocations',
  'customer_credits',
  'customer_credit_applications',
] as const;

async function seed(c: Client): Promise<Seeded> {
  const one = async (sql: string, params: unknown[] = []): Promise<string> => {
    const r = await c.query<{ id: string }>(sql, params);
    return (r.rows[0] as { id: string }).id;
  };
  const tenantId = await one('INSERT INTO tenants DEFAULT VALUES RETURNING id');
  const userId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Equivalence') RETURNING id`, [
    `ar-setbased-${process.pid}@test.daftar.local`,
  ]);
  const businesses: { id: string; customers: string[]; invoices: InvoiceSpec[] }[] = [];
  for (const [n, slug] of [
    ['First Books', `ar-setbased-a-${process.pid}`],
    ['Second Books', `ar-setbased-b-${process.pid}`],
  ] as const) {
    const businessId = await one(
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
      [tenantId, n, slug],
    );
    const branchId = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]);
    businesses.push({ id: businessId, customers: [branchId], invoices: [] });
  }

  // From here the rows are written directly. Every CHECK still holds; only
  // the guards and the referential triggers are out of the way, and the whole
  // transaction is rolled back.
  for (const t of TABLES_WITHOUT_TRIGGERS) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER ALL`);

  for (const [bi, b] of businesses.entries()) {
    const branchId = b.customers[0] as string;
    const customers: string[] = [];
    for (const name of ['Customer One', 'Customer Two', 'Customer Three']) {
      const id = nextId();
      await c.query(
        `INSERT INTO customers (tenant_id, business_id, id, name, status, revision, create_intent_sha256, last_intent_sha256,
                                business_transaction_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'active', 1, $5, $5, $6, $7, $7)`,
        [tenantId, b.id, id, `${name} ${bi}`, SHA, nextId(), userId],
      );
      customers.push(id);
    }
    b.customers = customers;
    b.invoices = invoicesFor(customers, `b${bi}`);

    for (const inv of b.invoices) {
      const totalBase = inv.currency === 'ILS' ? inv.totalTxn : Math.round(inv.totalTxn * Number(inv.rate));
      const saleId = nextId();
      if (!inv.danglingSale) {
        await c.query(
          `INSERT INTO sales (tenant_id, business_id, id, customer_id, branch_id, warehouse_id, status, settlement_mode, document_date,
                              currency_code, subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor,
                              source_to_base_rate, rate_source, rate_timestamp, customer_name_snapshot, commit_intent_sha256,
                              confirmed_by, confirmed_at, business_transaction_id, created_by, binding_source_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, DATE '2026-01-02', $8, $9, 0, $9, $10, $11, $12, ${STAMP}::timestamptz,
                   $13, $14, $15, ${STAMP}::timestamptz, $16, $15, $3)`,
          [
            tenantId,
            b.id,
            saleId,
            inv.customerId,
            branchId,
            nextId(),
            inv.settlement,
            inv.currency,
            inv.totalTxn,
            totalBase,
            inv.rate,
            inv.currency === 'ILS' ? 'base' : 'manual',
            inv.customerId === null ? null : 'Snapshot Name',
            SHA,
            userId,
            nextId(),
          ],
        );
      }
      await c.query(
        `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq,
                               period, issue_date, due_date, currency_code, status, subtotal_txn_minor, discount_txn_minor,
                               total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                               customer_name_snapshot, issue_intent_sha256, void_intent_sha256, voided_by, voided_at,
                               business_transaction_id, created_by, binding_source_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'invoice', $7, $8, '2026', DATE '2026-01-02', $9, $10, $11, $12, 0, $12, $13, $14, $15,
                 ${STAMP}::timestamptz, $16, $17, $18, $19, $20, $21, $22, $23)`,
        [
          tenantId,
          b.id,
          inv.id,
          saleId,
          inv.customerId,
          branchId,
          `INV-${idSeq}`,
          idSeq,
          inv.dueDate,
          inv.currency,
          inv.status,
          inv.totalTxn,
          totalBase,
          inv.rate,
          inv.currency === 'ILS' ? 'base' : 'manual',
          inv.customerId === null ? null : 'Snapshot Name',
          SHA,
          inv.status === 'void' ? SHA : null,
          inv.status === 'void' ? userId : null,
          inv.status === 'void' ? '2026-03-02 09:00:00+00' : null,
          nextId(),
          userId,
          inv.status === 'draft' ? null : inv.id,
        ],
      );

      // The chain, in order: the allocations first, then the credit
      // applications, each step's `released before` the sum of the amounts
      // ordered before it (R-83's shape, so the rows look like real ones).
      let releasedBefore = 0;
      for (const amount of inv.allocations) {
        const paymentId = nextId();
        const allocationId = nextId();
        const rel = await release(c, totalBase, inv.totalTxn, releasedBefore, amount);
        const paymentBase = inv.currency === 'ILS' ? amount : Math.round(amount * 3.7);
        await c.query(
          `INSERT INTO payments (tenant_id, business_id, id, customer_id, payment_method_id, posting_account_id, currency_code,
                                 amount_minor, payment_to_base_rate, rate_source, rate_timestamp, base_amount_minor, payment_date,
                                 allocation_count, intent_sha256, business_transaction_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${STAMP}::timestamptz, $11, DATE '2026-03-01', 1, $12, $13, $14)`,
          [
            tenantId,
            b.id,
            paymentId,
            inv.customerId ?? (b.customers[0] as string),
            nextId(),
            nextId(),
            inv.currency,
            amount,
            inv.currency === 'ILS' ? '1.0000000000' : '3.7000000000',
            inv.currency === 'ILS' ? 'base' : 'manual',
            paymentBase,
            SHA,
            nextId(),
            userId,
          ],
        );
        await c.query(
          `INSERT INTO payment_allocations (tenant_id, business_id, id, payment_id, customer_id, invoice_id, line_no,
                                            payment_currency, payment_amount_minor, payment_to_base_rate, payment_base_amount_minor,
                                            invoice_currency, invoice_amount_applied_minor, invoice_historical_to_base_rate,
                                            ar_released_before_txn_minor, invoice_carrying_base_released_minor, ar_dust_base_minor,
                                            realized_fx_gain_loss_minor, binding_source_id)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $7, $8, $11, $12, $13, 0, $14, $3)`,
          [
            tenantId,
            b.id,
            allocationId,
            paymentId,
            inv.customerId ?? (b.customers[0] as string),
            inv.id,
            inv.currency,
            amount,
            inv.currency === 'ILS' ? '1.0000000000' : '3.7000000000',
            paymentBase,
            inv.rate,
            releasedBefore,
            rel,
            paymentBase - rel,
          ],
        );
        releasedBefore += amount;
      }
      for (const amount of inv.creditApplications) {
        const creditId = nextId();
        const applicationId = nextId();
        const rel = await release(c, totalBase, inv.totalTxn, releasedBefore, amount);
        const creditBase = inv.currency === 'ILS' ? amount : Math.round(amount * 3.55);
        await c.query(
          `INSERT INTO customer_credits (tenant_id, business_id, id, customer_id, origin_payment_id, currency_code,
                                         original_amount_minor, original_carrying_base_amount_minor, credit_to_base_rate,
                                         rate_source, rate_timestamp, remaining_amount_minor, remaining_carrying_base_amount_minor,
                                         credit_date, intent_sha256, business_transaction_id, created_by, binding_source_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${STAMP}::timestamptz, 0, 0, DATE '2026-02-01', $11, $12, $13, $3)`,
          [
            tenantId,
            b.id,
            creditId,
            inv.customerId ?? (b.customers[0] as string),
            nextId(),
            inv.currency,
            amount,
            creditBase,
            inv.currency === 'ILS' ? '1.0000000000' : '3.5500000000',
            inv.currency === 'ILS' ? 'base' : 'manual',
            SHA,
            nextId(),
            userId,
          ],
        );
        await c.query(
          `INSERT INTO customer_credit_applications (tenant_id, business_id, id, customer_id, credit_id, invoice_id, application_date,
                                                     credit_currency, credit_amount_consumed_minor, credit_to_base_rate,
                                                     credit_remaining_before_minor, credit_carrying_base_released_minor,
                                                     credit_dust_base_minor, invoice_currency, invoice_amount_applied_minor,
                                                     invoice_historical_to_base_rate, ar_released_before_txn_minor,
                                                     invoice_carrying_base_released_minor, ar_dust_base_minor,
                                                     realized_fx_gain_loss_minor, intent_sha256, business_transaction_id,
                                                     created_by, binding_source_id)
           VALUES ($1, $2, $3, $4, $5, $6, DATE '2026-03-05', $7, $8, $9, $8, $10, 0, $7, $8, $11, $12, $13, 0, $14, $15, $16, $17, $3)`,
          [
            tenantId,
            b.id,
            applicationId,
            inv.customerId ?? (b.customers[0] as string),
            creditId,
            inv.id,
            inv.currency,
            amount,
            inv.currency === 'ILS' ? '1.0000000000' : '3.5500000000',
            creditBase,
            inv.rate,
            releasedBefore,
            rel,
            creditBase - rel,
            SHA,
            nextId(),
            userId,
          ],
        );
        releasedBefore += amount;
      }
    }
  }
  return { tenantId, businesses };
}

// ───── the capture ────────────────────────────────────────────────────────

interface Capture {
  /** One row per invoice of every business, as both roles see it. */
  readonly invoices: unknown[];
  /** One row per customer: the AR sum and the aging, as both roles see it. */
  readonly customers: unknown[];
  /** The refusals: an id that names no invoice, and one in another business. */
  readonly refusals: Record<string, string>;
}

/**
 * A read that may REFUSE, taken inside a savepoint.
 *
 * The population is seeded inside one transaction that is never committed, and
 * a refusal is part of the answer being compared — so every call that can
 * raise is wrapped, or the first `invoice.not_found` would abort the
 * transaction and take the rest of the capture with it.
 */
async function answer(c: Client, sql: string, params: unknown[]): Promise<unknown> {
  await c.query('SAVEPOINT ar_equivalence');
  try {
    const r = await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT ar_equivalence');
    return { rows: r.rows };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT ar_equivalence');
    await c.query('RELEASE SAVEPOINT ar_equivalence');
    return { error: (e as Error).message };
  }
}

/** Every question the readers of record answer, over the whole population. */
async function capture(c: Client, seeded: Seeded, asApp: boolean): Promise<Capture> {
  if (asApp) await c.query('SET LOCAL ROLE daftar_app');
  const invoices: unknown[] = [];
  const customers: unknown[] = [];
  const refusals: Record<string, string> = {};
  try {
    for (const b of seeded.businesses) {
      if (asApp) {
        await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [seeded.tenantId, b.id]);
      }
      for (const inv of b.invoices) {
        const row = await answer(
          c,
          `SELECT o.paid_txn_minor::text AS paid_txn, o.paid_base_minor::text AS paid_base,
                  o.outstanding_txn_minor::text AS out_txn, o.outstanding_base_minor::text AS out_base,
                  invoice_settlement_state($1::uuid, $2::uuid) AS state
             FROM invoice_outstanding($1::uuid, $2::uuid) o`,
          [b.id, inv.id],
        );
        invoices.push({ label: inv.label, answer: row });
      }
      for (const customerId of b.customers) {
        const ar = await answer(
          c,
          `SELECT r.currency_code, r.txn_minor::text AS txn_minor, r.base_minor::text AS base_minor
             FROM customer_ar_outstanding($1::uuid, $2::uuid) r ORDER BY r.currency_code NULLS FIRST`,
          [b.id, customerId],
        );
        const aging = await answer(
          c,
          `SELECT g.bucket_no, g.currency_code, g.txn_minor::text AS txn_minor, g.base_minor::text AS base_minor, g.invoice_count
             FROM customer_ar_aging($1::uuid, $2::uuid, DATE '2026-03-10', ARRAY[30, 60, 90]) g
            ORDER BY g.bucket_no, g.currency_code`,
          [b.id, customerId],
        );
        customers.push({ business: b.id, customer: customerId, ar, aging });
      }
    }
    // The refusal, which is part of the answer: an id that names no invoice,
    // and the first business asking about the second business's invoice.
    const first = seeded.businesses[0] as Seeded['businesses'][number];
    const second = seeded.businesses[1] as Seeded['businesses'][number];
    if (asApp) {
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [seeded.tenantId, first.id]);
    }
    for (const [name, invoiceId] of [
      ['unknown id', '00000000-0000-4000-8000-ffffffffffff'],
      ['another business’s invoice', (second.invoices[0] as InvoiceSpec).id],
    ] as const) {
      const got = (await answer(c, `SELECT * FROM invoice_outstanding($1::uuid, $2::uuid)`, [first.id, invoiceId])) as {
        rows?: unknown[];
        error?: string;
      };
      refusals[name] = got.error ?? `returned ${(got.rows ?? []).length} row(s): ${JSON.stringify(got.rows)}`;
    }
  } finally {
    if (asApp) await c.query('RESET ROLE');
  }
  return { invoices, customers, refusals };
}

/**
 * The live definition of a routine, from the catalogue.
 *
 * The per-invoice call cannot be seen in the PLAN of the AR read, and that is
 * not a limitation of this instrument — it is the defect. A routine carrying a
 * `SET search_path` clause cannot be inlined, so `EXPLAIN` of
 * `SELECT * FROM customer_ar_outstanding(...)` reports one `Function Scan` and
 * nothing of what happens inside it. That is exactly the plan the budget
 * measurement recorded (`Sort -> Function Scan on customer_ar_outstanding`,
 * with no `invoices` node at all), and it is why the shape of the read is
 * asserted from the CATALOGUE and the cost from the CLOCK.
 */
async function liveDefinition(c: Client, signature: string): Promise<string> {
  const r = await c.query<{ def: string }>(`SELECT pg_get_functiondef(to_regprocedure($1))::text AS def`, [signature]);
  return r.rows[0]?.def ?? '';
}

/**
 * The AR read, timed in this same transaction over the fat-tail arm.
 *
 * This is NOT the P4-D budget and is not compared to any ceiling: it is one
 * read of one customer, repeated, inside the transaction the population lives
 * in, and its only job is to say which DIRECTION the reshaping moved the cost
 * in on a known row count. The budget is measured by
 * `receivables-s4-budgets.test.ts` through the real route, on committed rows,
 * with 200 samples.
 */
async function medianReadMs(c: Client, businessId: string, customerId: string, iterations: number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    await c.query(`SELECT * FROM customer_ar_outstanding($1::uuid, $2::uuid)`, [businessId, customerId]);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}

/** The AR read's plan, with every relation its scans name and how many times each was entered. */
async function planOf(c: Client, businessId: string, customerId: string): Promise<{ loops: Record<string, number>; plan: unknown }> {
  const r = await c.query<Record<string, unknown>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT * FROM customer_ar_outstanding($1::uuid, $2::uuid)`,
    [businessId, customerId],
  );
  const plan = (r.rows[0] as Record<string, unknown>)['QUERY PLAN'] as unknown[];
  const loops: Record<string, number> = {};
  const walk = (node: Record<string, unknown>): void => {
    const name = typeof node['Relation Name'] === 'string' ? (node['Relation Name'] as string) : (node['Function Name'] as string | undefined);
    if (typeof name === 'string') loops[name] = (loops[name] ?? 0) + Number(node['Actual Loops'] ?? 0);
    for (const key of ['Plans', 'Plan']) {
      const children = node[key];
      if (Array.isArray(children)) for (const child of children) walk(child as Record<string, unknown>);
      else if (children !== undefined && children !== null) walk(children as Record<string, unknown>);
    }
  };
  walk((plan[0] as Record<string, unknown>) ?? {});
  return { loops, plan };
}

let client: Client;
let seeded: Seeded;
let beforeOwner: Capture;
let afterOwner: Capture;
let beforeApp: Capture;
let afterApp: Capture;
let beforePlan: { loops: Record<string, number>; plan: unknown };
let afterPlan: { loops: Record<string, number>; plan: unknown };
let boundaryBefore = '';
let appliedUnderTest = '';
let fatTailInvoices = 0;
let fatTailPlanBefore: { loops: Record<string, number>; plan: unknown };
let fatTailPlanAfter: { loops: Record<string, number>; plan: unknown };
let definitionBefore: Record<string, string> = {};
let definitionAfter: Record<string, string> = {};
let fatTailMsBefore = 0;
let fatTailMsAfter = 0;
const READ_ITERATIONS = 25;
const SIGNATURES = [
  'public.customer_ar_outstanding(uuid,uuid)',
  'public.customer_ar_aging(uuid,uuid,date,integer[])',
  'public.invoice_outstanding(uuid,uuid)',
  'public.invoice_outstanding(uuid,uuid[])',
] as const;

/** Every live definition this file compares, keyed by signature. */
async function definitions(c: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const sig of SIGNATURES) out[sig] = await liveDefinition(c, sig);
  return out;
}

beforeAll(async () => {
  await startOrReuse();
  // `bootstrap.sql` grants CONNECT on the database named `daftar`, so that
  // database has to exist before the file can be run anywhere.
  await ensureDatabase('daftar');
  const admin = new Pool({ connectionString: ownerUrl('postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
  await applyBootstrap(DB);

  const upToBefore = migrationsUpTo(BEFORE_HEAD);
  try {
    await runMigrations(ownerUrl(DB), upToBefore);
  } finally {
    rmSync(upToBefore, { recursive: true, force: true });
  }

  client = new Client({ connectionString: ownerUrl(DB) });
  await client.connect();
  boundaryBefore = (await client.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`)).rows[0]?.name ?? '';

  await client.query('BEGIN');
  seeded = await seed(client);
  // A fat-tail arm for the PLAN half: enough open invoices that one function
  // call per invoice is visible as loops in the plan rather than as noise.
  const fat = seeded.businesses[0] as Seeded['businesses'][number];
  const fatCustomer = fat.customers[2] as string;
  await client.query(
    `WITH n AS (SELECT g, gen_random_uuid() AS sid, gen_random_uuid() AS iid FROM generate_series(1, 300) g),
          tmpl AS (SELECT y.branch_id, y.warehouse_id, y.created_by FROM sales y WHERE y.business_id = $2 LIMIT 1),
          s AS (
            INSERT INTO sales (tenant_id, business_id, id, customer_id, branch_id, warehouse_id, status, settlement_mode,
                               document_date, currency_code, subtotal_txn_minor, discount_txn_minor, total_txn_minor,
                               total_base_minor, source_to_base_rate, rate_source, rate_timestamp, customer_name_snapshot,
                               commit_intent_sha256, confirmed_by, confirmed_at, business_transaction_id, created_by, binding_source_id)
            SELECT $1, $2, n.sid, $3, tmpl.branch_id, tmpl.warehouse_id, 'confirmed', 'credit', DATE '2026-01-02', 'ILS',
                   1000, 0, 1000, 1000, 1, 'base', ${STAMP}::timestamptz, 'Snapshot Name', $4, tmpl.created_by,
                   ${STAMP}::timestamptz, gen_random_uuid(), tmpl.created_by, n.sid
              FROM n, tmpl
            RETURNING 1
          )
     INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq,
                           period, issue_date, due_date, currency_code, status, subtotal_txn_minor, discount_txn_minor,
                           total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                           customer_name_snapshot, issue_intent_sha256, business_transaction_id, created_by, binding_source_id)
     SELECT $1, $2, n.iid, n.sid, $3, tmpl.branch_id, 'invoice', 'FAT-' || n.g, 100000 + n.g, '2026', DATE '2026-01-02',
            DATE '2026-02-02', 'ILS', 'open', 1000, 0, 1000, 1000, 1, 'base', ${STAMP}::timestamptz,
            'Snapshot Name', $4, gen_random_uuid(), tmpl.created_by, n.iid
       FROM n, tmpl`,
    [seeded.tenantId, fat.id, fatCustomer, SHA],
  );
  fatTailInvoices = Number(
    (
      await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices WHERE business_id = $1 AND customer_id = $2 AND status = 'open'`, [
        fat.id,
        fatCustomer,
      ])
    ).rows[0]?.n ?? 0,
  );
  await client.query('ANALYZE invoices, sales, payment_allocations, customer_credit_applications');

  beforeOwner = await capture(client, seeded, false);
  beforeApp = await capture(client, seeded, true);
  beforePlan = await planOf(client, fat.id, fat.customers[1] as string);
  fatTailPlanBefore = await planOf(client, fat.id, fatCustomer);
  definitionBefore = await definitions(client);
  fatTailMsBefore = await medianReadMs(client, fat.id, fatCustomer, READ_ITERATIONS);

  // THE ONE CHANGE UNDER TEST, applied to the SAME database inside the SAME
  // transaction, with the SAME rows already in it. Nothing is reset,
  // reseeded or re-ANALYZEd, so the rows the second capture sees are exactly
  // the rows the first capture saw.
  const sql = readFileSync(join(MIGRATIONS_DIR, UNDER_TEST), 'utf8');
  await client.query(sql);
  appliedUnderTest = UNDER_TEST;

  afterOwner = await capture(client, seeded, false);
  afterApp = await capture(client, seeded, true);
  afterPlan = await planOf(client, fat.id, fat.customers[1] as string);
  fatTailPlanAfter = await planOf(client, fat.id, fatCustomer);
  definitionAfter = await definitions(client);
  fatTailMsAfter = await medianReadMs(client, fat.id, fatCustomer, READ_ITERATIONS);
}, 1_800_000);

afterAll(async () => {
  const evidence = {
    slice: 'P4-S4',
    what: 'the set-based AR sum (0083): answer equivalence over the whole population, and the per-invoice call in the plan',
    producedAt: new Date().toISOString(),
    boundaryBefore,
    appliedUnderTest,
    population: {
      businesses: seeded?.businesses.length ?? 0,
      invoices: (seeded?.businesses ?? []).reduce((n, b) => n + b.invoices.length, 0),
      cases: (seeded?.businesses[0]?.invoices ?? []).map((i) => i.label.replace(/^b0\//, '')),
      fatTailOpenInvoices: fatTailInvoices,
    },
    answerIdentical: {
      owner: JSON.stringify(beforeOwner) === JSON.stringify(afterOwner),
      app: JSON.stringify(beforeApp) === JSON.stringify(afterApp),
    },
    plan: { before: beforePlan ?? null, after: afterPlan ?? null, fatTailBefore: fatTailPlanBefore ?? null, fatTailAfter: fatTailPlanAfter ?? null },
    liveDefinitions: { before: definitionBefore, after: definitionAfter },
    fatTailArmReadMedianMs: { before: fatTailMsBefore, after: fatTailMsAfter, iterations: READ_ITERATIONS, openInvoices: fatTailInvoices },
  };
  const dir = join(__dirname, '../../release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'phase4-s4-ar-setbased-equivalence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  if (client !== undefined) {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
  const admin = new Pool({ connectionString: ownerUrl('postgres'), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  } catch {
    // a connection may still be draining; the name carries the pid, so the
    // next run of this suite drops it before it creates its own
  } finally {
    await admin.end().catch(() => undefined);
  }
});

describe('the two schema states this evidence compares', () => {
  it(`measured BEFORE at ${BEFORE_HEAD} and AFTER applying ${UNDER_TEST}, on one database and in one transaction`, () => {
    expect(boundaryBefore.startsWith(BEFORE_HEAD), `before: ${boundaryBefore}`).toBe(true);
    expect(appliedUnderTest).toBe(UNDER_TEST);
    // And the file applied really is the one under test: nothing between
    // 0082 and it, so the AFTER state is 0083's and no later file's.
    const between = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && f > `${BEFORE_HEAD}_zzz` && f < UNDER_TEST);
    expect(between, 'a migration sits between the BEFORE head and the file under test').toEqual([]);
  });

  it('over a population that carries every awkward case, in two businesses', () => {
    expect(seeded.businesses).toHaveLength(2);
    const labels = (seeded.businesses[0] as Seeded['businesses'][number]).invoices.map((i) => i.label);
    for (const needed of [
      'zero reducers',
      'partial allocation',
      'exact settlement',
      'over-allocation',
      'credit application only',
      'payment and credit',
      'chain of three',
      'foreign currency, partial',
      'walk-in, cash, no reducer',
      'draft',
      'void with an allocation',
      'cash-settled with an allocation',
      'dangling sale',
    ])
      expect(
        labels.some((l) => l.endsWith(needed)),
        `the population is missing the case: ${needed}`,
      ).toBe(true);
    // Non-vacuity: the readers actually answered, and both reducer arms carry
    // rows. A capture of refusals only would compare nothing.
    expect(beforeOwner.invoices.length).toBe(labels.length * 2);
    expect(Object.keys(beforeOwner.refusals)).toHaveLength(2);
  });

  it('and both arms of the reducer UNION ALL carry rows, so half the reader is not being measured', async () => {
    for (const relation of ['payment_allocations', 'customer_credit_applications']) {
      const n = (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${relation}`)).rows[0]?.n;
      expect(Number(n), `${relation} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('THE ANSWER DID NOT MOVE — the reshaping changes work, never the answer', () => {
  it('every invoice reports the same paid, outstanding and settlement state, as the owner', () => {
    expect(JSON.stringify(afterOwner.invoices, null, 1)).toBe(JSON.stringify(beforeOwner.invoices, null, 1));
  });

  it('every customer reports the same AR sum and the same aging buckets, as the owner', () => {
    expect(JSON.stringify(afterOwner.customers, null, 1)).toBe(JSON.stringify(beforeOwner.customers, null, 1));
  });

  it('and the same again as `daftar_app`, under row security, with the request scope set', () => {
    expect(JSON.stringify(afterApp.invoices, null, 1)).toBe(JSON.stringify(beforeApp.invoices, null, 1));
    expect(JSON.stringify(afterApp.customers, null, 1)).toBe(JSON.stringify(beforeApp.customers, null, 1));
  });

  it('the refusals are the same refusals: an unknown id and another business’s invoice both still answer not_found', () => {
    expect(afterOwner.refusals).toEqual(beforeOwner.refusals);
    expect(afterApp.refusals).toEqual(beforeApp.refusals);
    for (const capture of [beforeApp, afterApp]) for (const message of Object.values(capture.refusals)) expect(message).toContain('invoice.not_found');
  });

  it('the whole capture, byte for byte, in both roles at once', () => {
    expect(JSON.stringify(afterOwner)).toBe(JSON.stringify(beforeOwner));
    expect(JSON.stringify(afterApp)).toBe(JSON.stringify(beforeApp));
  });
});

describe('THE PER-INVOICE CALL IS GONE — the shape from the catalogue, the cost from the clock', () => {
  it('at 0082 both AR readers call the reader-of-record once per invoice through a LATERAL', () => {
    for (const sig of ['public.customer_ar_outstanding(uuid,uuid)', 'public.customer_ar_aging(uuid,uuid,date,integer[])'])
      expect(definitionBefore[sig] ?? '', sig).toContain('JOIN LATERAL public.invoice_outstanding(i.business_id, i.id)');
    // And there was no set-based definition to call instead.
    expect(definitionBefore['public.invoice_outstanding(uuid,uuid[])']).toBe('');
  });

  it('after 0083 neither does, each makes ONE call, and the one definition reads both reducers', () => {
    for (const sig of ['public.customer_ar_outstanding(uuid,uuid)', 'public.customer_ar_aging(uuid,uuid,date,integer[])']) {
      expect(definitionAfter[sig] ?? '', sig).not.toContain('JOIN LATERAL public.invoice_outstanding(i.business_id, i.id)');
      expect(definitionAfter[sig] ?? '', sig).toContain('public.invoice_outstanding(');
      // …and neither grew a copy of the settlement sum of its own (P4-AL-07).
      for (const reducer of ['payment_allocations', 'customer_credit_applications']) expect(definitionAfter[sig] ?? '', sig).not.toContain(reducer);
    }
    const one = definitionAfter['public.invoice_outstanding(uuid,uuid[])'] ?? '';
    for (const reducer of ['payment_allocations', 'customer_credit_applications']) expect(one).toContain(reducer);
    // The single-invoice reader is a WRAPPER: it holds no arithmetic at all,
    // so there is exactly one copy of it in the catalogue.
    const wrapper = definitionAfter['public.invoice_outstanding(uuid,uuid)'] ?? '';
    expect(wrapper).toContain('ARRAY[p_invoice_id]');
    for (const reducer of ['payment_allocations', 'customer_credit_applications']) expect(wrapper).not.toContain(reducer);
  });

  it(`and the cost of the fat-tail arm's read fell, measured on the clock in this same transaction`, () => {
    expect(fatTailInvoices, 'the fat-tail arm has no invoices, so the figures below are about nothing').toBeGreaterThan(100);
    expect(
      fatTailMsAfter,
      `${fatTailInvoices} open invoices: median of ${READ_ITERATIONS} reads ${fatTailMsBefore.toFixed(3)} ms → ${fatTailMsAfter.toFixed(3)} ms. ` +
        `This is a direction, not a budget: the P4-D ceiling is measured through the real route by receivables-s4-budgets.test.ts.`,
    ).toBeLessThan(fatTailMsBefore);
  });

  it('and the plan of the read is recorded on both sides, opaque Function Scan and all', () => {
    // Recorded rather than asserted on: `customer_ar_outstanding` carries a
    // pinned `search_path`, so it cannot be inlined and EXPLAIN sees one
    // Function Scan on either side. The evidence file carries both plans; the
    // claims above are the ones the plan cannot make.
    expect(Object.keys(fatTailPlanBefore.loops)).toContain('customer_ar_outstanding');
    expect(Object.keys(fatTailPlanAfter.loops)).toContain('customer_ar_outstanding');
    expect(Object.keys(beforePlan.loops).length).toBeGreaterThan(0);
    expect(Object.keys(afterPlan.loops).length).toBeGreaterThan(0);
  });
});
