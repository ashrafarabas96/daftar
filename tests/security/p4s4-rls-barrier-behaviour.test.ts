/**
 * P4-S4 — THE BARRIER ON THE FOUR RELATIONS, JUDGED BY BEHAVIOUR.
 * (`0075`, `0077`, `0081` policy surfaces; `0086`'s rewrite of the two read
 *  quals; P4-AL-31 and the §91 refusal of an unforced policy surface.)
 *
 * WHY THIS FILE EXISTS. An independent challenger took the four P4-S4
 * relations — `invoices`, `sales`, `payment_allocations`,
 * `customer_credit_applications` — and installed two policy surfaces that are
 * NOT the shipped boundary, and every law in the estate stayed green:
 *
 *   B1. `ALTER POLICY tenant_membership ON <rel> WITH CHECK (tenant_id IS NOT
 *       NULL)`. The tenant barrier on the WRITE side becomes a blanket
 *       predicate: a write carrying ANOTHER tenant's `tenant_id` is admitted.
 *       The laws that existed asked whether a WITH CHECK was present and
 *       whether it contained a subselect. A blanket predicate is present, and
 *       nothing about "contains a subselect" is a statement about which rows
 *       it admits.
 *
 *   B2. `DROP POLICY business_isolation_delete` and re-create it under the
 *       SAME name, with the SAME `USING`, but `AS PERMISSIVE`. The policy
 *       count stays seven and the qual is byte-identical, so every law that
 *       counts policies or compares their text is satisfied — and yet the
 *       barrier is gone, because PostgreSQL AND-s a RESTRICTIVE policy into
 *       the result and OR-s a PERMISSIVE one. Nothing in the estate read
 *       `pg_policy.polpermissive`.
 *
 * Both attacks are invisible to any law about policy TEXT: in B1 the text is
 * plausible, in B2 it is unchanged. What changes in both is WHICH ROWS THE
 * DATABASE HANDS BACK AND WHICH WRITES IT TAKES. So this file asserts that,
 * and nothing else: real rows in three scopes, counted by a connection that
 * holds no bypass, and writes that are either taken or refused.
 *
 * HOW A CASE IS RUN. One transaction per case, on one superuser connection,
 * ALWAYS rolled back:
 *
 *   - the world is seeded inside that transaction by the superuser, which
 *     bypasses row security, so the SEEDING is never the thing under test;
 *   - the reader is `daftar_app` through `SET LOCAL ROLE` — the idiom
 *     `tests/security/purchase-s4-isolation.test.ts` already uses for exactly
 *     this. `GetUserId()` after `SET ROLE` is `daftar_app`, which holds
 *     neither SUPERUSER nor BYPASSRLS (asserted below), and every policy here
 *     is written against `CURRENT_USER`, which `SET ROLE` changes. The
 *     relations are also FORCE ROW LEVEL SECURITY, so even the owner would be
 *     subject to them;
 *   - a policy PLANT is an `ALTER`/`DROP`/`CREATE POLICY` in that same
 *     transaction, which is why the reader has to be on the same connection:
 *     an uncommitted policy change is not visible to a second session, and a
 *     COMMITTED plant can be left behind by a crash. Nothing this file does
 *     survives its own case.
 *
 * WHICH ROLE DOES WHAT, AND WHY IT IS NOT ARBITRARY. The shipped grant model
 * gives the four relations ONLY `SELECT` to `daftar_app`; `INSERT` belongs to
 * the NOLOGIN writer principal `daftar_inventory_internal`, the narrow
 * `UPDATE (status, …)` on `invoices`/`sales` belongs to it too, and `DELETE`
 * is granted to NO principal at all. So:
 *
 *   - every VISIBILITY case runs as `daftar_app`, the ordinary application
 *     role;
 *   - every WRITE case runs as `daftar_inventory_internal`, because it is the
 *     only principal that may write at all — a write attempted as
 *     `daftar_app` is refused by the GRANT before any policy is consulted,
 *     and a law that read that refusal as "the barrier held" would be a law
 *     about the grant. The write cases assert the privilege boundary
 *     SEPARATELY, as itself.
 *
 * HOW EACH BARRIER IS ISOLATED. The relations carry a PERMISSIVE tenant
 * policy and a RESTRICTIVE per-command business policy, so a row in another
 * tenant's business is refused TWICE and tells us nothing about either
 * barrier on its own. Each case therefore chooses the scope that leaves
 * exactly ONE barrier standing:
 *
 *   - the BUSINESS barrier alone: scope = my tenant + my business, subject =
 *     a row of ANOTHER BUSINESS OF MY OWN TENANT. The tenant policy admits
 *     it; only the RESTRICTIVE business policy refuses it. This is the case
 *     B2 breaks.
 *   - the TENANT barrier alone: scope = MY tenant + the OTHER TENANT'S
 *     business, subject = a row of that other tenant's business. The business
 *     policy admits it; only the tenant policy refuses it. This is the case
 *     B1 breaks on the write side.
 *
 * Every visibility assertion COUNTS ROWS. None of them catches an error —
 * except the write cases, where a refusal IS the assertion, and there the
 * refusal is required to be the row-security one (SQLSTATE 42501, "violates
 * row-level security policy") and each case carries a positive control: the
 * same write, in scope, is TAKEN.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDb, urlOf, type ScratchDb } from '../helpers/scratch-db';
import { randomUUID } from 'node:crypto';

/** The four relations `0086` names, and this file's whole subject. */
const RELATIONS = ['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] as const;
type Relation = (typeof RELATIONS)[number];

/**
 * The seven policies each of the four relations carries, with the algebra
 * PostgreSQL applies to them. This is NOT the text of a qual: `polpermissive`
 * and `polcmd` are the OPERATORS the executor combines the quals with, and B2
 * changes exactly one of them while leaving every byte of text alone.
 *
 * `permissive: true` is OR-ed into the result; `permissive: false` is AND-ed.
 * `cmd` is `*` ALL, `r` SELECT, `a` INSERT, `w` UPDATE, `d` DELETE.
 */
const ALGEBRA: readonly {
  readonly polname: string;
  readonly permissive: boolean;
  readonly cmd: string;
  readonly roles: readonly string[];
  readonly using: boolean;
  readonly check: boolean;
}[] = [
  { polname: 'accounting_validator', permissive: true, cmd: 'r', roles: ['daftar_accounting_internal'], using: true, check: false },
  { polname: 'business_isolation_delete', permissive: false, cmd: 'd', roles: [], using: true, check: false },
  { polname: 'business_isolation_insert', permissive: false, cmd: 'a', roles: [], using: false, check: true },
  { polname: 'business_isolation_read', permissive: false, cmd: 'r', roles: [], using: true, check: false },
  { polname: 'business_isolation_update', permissive: false, cmd: 'w', roles: [], using: true, check: true },
  { polname: 'inventory_internal_read', permissive: true, cmd: 'r', roles: ['daftar_inventory_internal'], using: true, check: false },
  { polname: 'tenant_membership', permissive: true, cmd: '*', roles: [], using: true, check: true },
];

/** The reader: the ordinary application role, which holds SELECT and nothing else here. */
const READER = 'daftar_app';
/** The writer: the NOLOGIN principal the grant model gives INSERT to, reached by SET ROLE. */
const WRITER = 'daftar_inventory_internal';

/** A `(tenant, business)` scope, as `Database.applyScope` sets one. */
interface Scope {
  readonly tenantId: string | null;
  readonly businessId: string | null;
}

/** One seeded business, and the id of its row in each of the four relations. */
interface Biz {
  readonly label: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly branchId: string;
  readonly warehouseId: string;
  readonly customerId: string;
  readonly paymentId: string;
  readonly creditId: string;
  /** A sale with no invoice on it yet, and an invoice: what a probe INSERT needs to be legal but for its scope. */
  readonly freeSaleId: string;
  readonly probeInvoiceId: string;
  /** The seeded subject row of each relation. */
  readonly subject: Readonly<Record<Relation, string>>;
}

/** The world every case seeds: three businesses over two tenants, plus an empty one. */
interface World {
  readonly tenantA: string;
  readonly tenantB: string;
  /** Mine. */
  readonly A: Biz;
  /** My tenant, ANOTHER business — the subject the RESTRICTIVE business policy alone refuses. */
  readonly A2: Biz;
  /** Another tenant — the subject the tenant policy alone refuses, under the right scope. */
  readonly B: Biz;
  /** My tenant, a business with NO rows in any of the four relations. */
  readonly emptyBusinessId: string;
}

const SHA = 'a'.repeat(64);

let db: ScratchDb;
/**
 * Every red proof's real assertion text, printed as it happens so the
 * evidence a reviewer reads is the text the law actually produced and not a
 * paraphrase of it.
 */
const redProofs: string[] = [];

function record(line: string): void {
  redProofs.push(line);
  console.log(`  RED PROOF ${redProofs.length}: ${line}`);
}

function must<T>(v: T | undefined | null, what = 'value'): T {
  if (v === undefined || v === null) throw new Error(`expected a ${what}, found none`);
  return v;
}

/** A fresh superuser connection on the scratch database. */
async function connect(): Promise<Client> {
  const c = new Client({ connectionString: urlOf(db.name, 'postgres') });
  await c.connect();
  return c;
}

/**
 * One case: a connection, a transaction, a seeded world, and a ROLLBACK that
 * undoes the rows AND any policy this case planted. The deferred constraint
 * triggers of `0081` (`payment_allocations_value_complete` and its siblings)
 * fire at COMMIT and judge settlement VALUE, which is not this file's
 * subject; rolling back is what keeps a scope-isolation case from having to
 * carry a whole arithmetically-complete settlement.
 */
async function inCase(fn: (c: Client, w: World) => Promise<void>): Promise<void> {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const w = await seedWorld(c);
    await fn(c, w);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

/** The `business_transaction_id` the `0081` guards require a write to carry. */
let btid = '';

/** Seed one business and one row of each of the four relations in it. */
async function seedBusiness(c: Client, tenantId: string, label: string, userId: string): Promise<Biz> {
  const one = async (sql: string, params: unknown[] = []): Promise<string> => must((await c.query<{ id: string }>(sql, params)).rows[0], `${label} id`).id;
  const businessId = await one(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenantId, label, label],
  );
  // `payment_method_guard` judges the settlement account against the
  // TRANSACTION's business, so the seeding transaction is scoped to the
  // business it is seeding. This is the fixture's own scope, never the
  // scope a case reads under: every case sets both GUCs explicitly.
  await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [tenantId, businessId]);
  const branchId = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]);
  const warehouseId = await one(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'WH', true) RETURNING id`, [
    businessId,
    branchId,
  ]);
  const accountId = await one(`SELECT id FROM accounts WHERE business_id = $1 AND system_key = 'cash'`, [businessId]);

  const customerId = randomUUID();
  await c.query(
    `INSERT INTO customers (tenant_id, business_id, id, name, status, revision, create_intent_sha256, last_intent_sha256,
                            business_transaction_id, created_by, updated_by)
     VALUES ($1, $2, $3, 'Subject', 'active', 1, $4, $4, $5, $6, $6)`,
    [tenantId, businessId, customerId, SHA, btid, userId],
  );

  /** A draft sale: the one shape `sale_header_guard` admits on INSERT. */
  const sale = async (): Promise<string> => {
    const id = randomUUID();
    await c.query(
      `INSERT INTO sales (tenant_id, business_id, id, branch_id, warehouse_id, status, settlement_mode, document_date, currency_code,
                          subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor, source_to_base_rate, rate_source,
                          rate_timestamp, commit_intent_sha256, business_transaction_id, created_by)
       VALUES ($1, $2, $3, $4, $5, 'draft', 'cash', CURRENT_DATE, 'ILS', 1000, 0, 1000, 1000, 1, 'base',
               date_trunc('second', now()), $6, $7, $8)`,
      [tenantId, businessId, id, branchId, warehouseId, SHA, btid, userId],
    );
    return id;
  };
  /** A draft invoice on its own sale. */
  const invoice = async (saleId: string, n: number): Promise<string> => {
    const id = randomUUID();
    await c.query(
      `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq, period,
                             issue_date, currency_code, status, subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor,
                             source_to_base_rate, rate_source, rate_timestamp, customer_name_snapshot, issue_intent_sha256,
                             business_transaction_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'invoice', $7, $8, to_char(CURRENT_DATE, 'YYYY'), CURRENT_DATE, 'ILS', 'draft',
               1000, 0, 1000, 1000, 1, 'base', date_trunc('second', now()), 'Subject', $9, $10, $11)`,
      [tenantId, businessId, id, saleId, customerId, branchId, `INV-${n}`, n, SHA, btid, userId],
    );
    return id;
  };

  const subjectSaleId = await sale();
  const invoiceSaleId = await sale();
  const probeSaleId = await sale();
  const freeSaleId = await sale();
  const subjectInvoiceId = await invoice(invoiceSaleId, 1);
  const probeInvoiceId = await invoice(probeSaleId, 2);

  const methodId = randomUUID();
  await c.query(
    `INSERT INTO payment_methods (tenant_id, business_id, id, system_type, posting_account_id, is_active, requires_reference, sort_order,
                                  revision, create_intent_sha256, last_intent_sha256, business_transaction_id, created_by, updated_by)
     VALUES ($1, $2, $3, 'cash', $4, true, false, 1, 1, $5, $5, $6, $7, $7)`,
    [tenantId, businessId, methodId, accountId, SHA, btid, userId],
  );
  const paymentId = randomUUID();
  await c.query(
    `INSERT INTO payments (tenant_id, business_id, id, customer_id, payment_method_id, posting_account_id, currency_code, amount_minor,
                           payment_to_base_rate, rate_source, rate_timestamp, base_amount_minor, payment_date, allocation_count,
                           intent_sha256, business_transaction_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'ILS', 1000, 1, 'base', date_trunc('second', now()), 1000, CURRENT_DATE, 1, $7, $8, $9)`,
    [tenantId, businessId, paymentId, customerId, methodId, accountId, SHA, btid, userId],
  );
  const allocationId = randomUUID();
  await c.query(allocationInsert(), allocationParams({ tenantId, businessId, customerId, paymentId }, allocationId, subjectInvoiceId, 1, 0));
  const creditId = randomUUID();
  await c.query(
    `INSERT INTO customer_credits (tenant_id, business_id, id, customer_id, origin_payment_id, currency_code, original_amount_minor,
          original_carrying_base_amount_minor, credit_to_base_rate, rate_source, rate_timestamp, remaining_amount_minor,
          remaining_carrying_base_amount_minor, credit_date, intent_sha256, business_transaction_id, created_by, binding_source_id)
     VALUES ($1, $2, $3, $4, $5, 'ILS', 1000, 1000, 1, 'base', date_trunc('second', now()), 1000, 1000, CURRENT_DATE, $6, $7, $8, $3)`,
    [tenantId, businessId, creditId, customerId, paymentId, SHA, btid, userId],
  );
  const applicationId = randomUUID();
  await c.query(applicationInsert(), applicationParams({ tenantId, businessId, customerId, creditId }, applicationId, subjectInvoiceId, 1000, 0, userId));

  return {
    label,
    tenantId,
    businessId,
    branchId,
    warehouseId,
    customerId,
    paymentId,
    creditId,
    freeSaleId,
    probeInvoiceId,
    subject: {
      invoices: subjectInvoiceId,
      sales: subjectSaleId,
      payment_allocations: allocationId,
      customer_credit_applications: applicationId,
    },
  };
}

/** The allocation INSERT, used by both the fixture and the write probes. */
function allocationInsert(): string {
  return `INSERT INTO payment_allocations (tenant_id, business_id, id, payment_id, customer_id, invoice_id, line_no, payment_currency,
            payment_amount_minor, payment_to_base_rate, payment_base_amount_minor, invoice_currency, invoice_amount_applied_minor,
            invoice_historical_to_base_rate, ar_released_before_txn_minor, invoice_carrying_base_released_minor, ar_dust_base_minor,
            realized_fx_gain_loss_minor, binding_source_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'ILS', 500, 1, 500, 'ILS', 500, 1, $8, 500, 0, 0, $3)`;
}

function allocationParams(
  o: { tenantId: string; businessId: string; customerId: string; paymentId: string },
  id: string,
  invoiceId: string,
  lineNo: number,
  releasedBefore: number,
): unknown[] {
  return [o.tenantId, o.businessId, id, o.paymentId, o.customerId, invoiceId, lineNo, releasedBefore];
}

/** The credit-application INSERT, used by both the fixture and the write probes. */
function applicationInsert(): string {
  return `INSERT INTO customer_credit_applications (tenant_id, business_id, id, customer_id, credit_id, invoice_id, application_date,
            credit_currency, credit_amount_consumed_minor, credit_to_base_rate, credit_remaining_before_minor,
            credit_carrying_base_released_minor, credit_dust_base_minor, invoice_currency, invoice_amount_applied_minor,
            invoice_historical_to_base_rate, ar_released_before_txn_minor, invoice_carrying_base_released_minor, ar_dust_base_minor,
            realized_fx_gain_loss_minor, intent_sha256, business_transaction_id, created_by, binding_source_id)
          VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, 'ILS', 100, 1, $7, 100, 0, 'ILS', 100, 1, $8, 100, 0, 0, $9, $10, $11, $3)`;
}

function applicationParams(
  o: { tenantId: string; businessId: string; customerId: string; creditId: string },
  id: string,
  invoiceId: string,
  remainingBefore: number,
  releasedBefore: number,
  userId: string,
): unknown[] {
  return [o.tenantId, o.businessId, id, o.customerId, o.creditId, invoiceId, remainingBefore, releasedBefore, SHA, btid, userId];
}

let seedUserId = '';

/** Three businesses over two tenants, plus an empty business of my own tenant. */
async function seedWorld(c: Client): Promise<World> {
  btid = randomUUID();
  await c.query(`SELECT set_config('app.business_transaction_id', $1, true)`, [btid]);
  const one = async (sql: string, params: unknown[] = []): Promise<string> => must((await c.query<{ id: string }>(sql, params)).rows[0], 'id').id;
  const tenantA = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const tenantB = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  seedUserId = await one(`INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Seeder') RETURNING id`, [
    `p4s4-barrier-${randomUUID()}@test.daftar.local`,
  ]);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const A = await seedBusiness(c, tenantA, `p4s4b-a-${stamp}`, seedUserId);
  const A2 = await seedBusiness(c, tenantA, `p4s4b-a2-${stamp}`, seedUserId);
  const B = await seedBusiness(c, tenantB, `p4s4b-b-${stamp}`, seedUserId);
  const emptyBusinessId = await one(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenantA, `p4s4b-empty-${stamp}`, `p4s4b-empty-${stamp}`],
  );
  return { tenantA, tenantB, A, A2, B, emptyBusinessId };
}

/**
 * Run `fn` as `role` under `scope`. A `null` in the scope sets the GUC to its
 * DEFAULT, which is what `app_tenant()` / `app_business()` read as absent —
 * not the empty string, which `nullif` only then turns into NULL.
 */
async function asRole<T>(c: Client, role: string, scope: Scope, fn: () => Promise<T>): Promise<T> {
  await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [scope.tenantId, scope.businessId]);
  await c.query(`SET LOCAL ROLE ${role}`);
  try {
    return await fn();
  } finally {
    await c.query('RESET ROLE');
  }
}

/** Which of `ids` the current reader can see in `rel`, counted by the database. */
async function visible(c: Client, rel: Relation, ids: readonly string[]): Promise<string[]> {
  const r = await c.query<{ id: string }>(`SELECT id::text AS id FROM ${rel} WHERE id = ANY ($1::uuid[]) ORDER BY 1`, [[...ids]]);
  return r.rows.map((x) => x.id);
}

/** How many rows of `rel` the current reader can see at all. */
async function total(c: Client, rel: Relation): Promise<number> {
  const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${rel}`);
  return Number(must(r.rows[0], 'count').n);
}

interface Attempt {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
  readonly rows: number;
}

/**
 * Run one statement inside a savepoint and report what happened, then undo
 * it. A refused statement aborts the transaction, so every write probe —
 * the ones expected to be taken as much as the ones expected to be refused —
 * runs in its own savepoint.
 */
async function attempt(c: Client, sql: string, params: unknown[] = []): Promise<Attempt> {
  const sp = `sp_${randomUUID().replace(/-/g, '')}`;
  await c.query(`SAVEPOINT ${sp}`);
  try {
    const r = await c.query(sql, params);
    return { ok: true, code: '', message: '', rows: r.rowCount ?? 0 };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? '', message: err.message ?? String(e), rows: 0 };
  } finally {
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
}

/**
 * What an attempt did, in four words a failure message can be read in:
 * `taken N row(s)` or `refused <sqlstate>`. The refusal's own text is
 * asserted separately, so a change of PostgreSQL's wording cannot quietly
 * turn a refusal into a pass.
 */
function summary(a: Attempt): string {
  return a.ok ? `taken ${a.rows} row(s)` : `refused ${a.code}`;
}

/** The INSERT a write probe runs on `rel`, written wholly in `target`'s scope. */
function writeProbe(rel: Relation, target: Biz, userId: string): { sql: string; params: unknown[] } {
  const id = randomUUID();
  switch (rel) {
    case 'invoices':
      return {
        sql: `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq, period,
                                    issue_date, currency_code, status, subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor,
                                    source_to_base_rate, rate_source, rate_timestamp, customer_name_snapshot, issue_intent_sha256,
                                    business_transaction_id, created_by)
              VALUES ($1, $2, $3, $4, $5, $6, 'invoice', 'INV-9', 9, to_char(CURRENT_DATE, 'YYYY'), CURRENT_DATE, 'ILS', 'draft',
                      1000, 0, 1000, 1000, 1, 'base', date_trunc('second', now()), 'Subject', $7, $8, $9)`,
        params: [target.tenantId, target.businessId, id, target.freeSaleId, target.customerId, target.branchId, SHA, btid, userId],
      };
    case 'sales':
      return {
        sql: `INSERT INTO sales (tenant_id, business_id, id, branch_id, warehouse_id, status, settlement_mode, document_date, currency_code,
                                 subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor, source_to_base_rate, rate_source,
                                 rate_timestamp, commit_intent_sha256, business_transaction_id, created_by)
              VALUES ($1, $2, $3, $4, $5, 'draft', 'cash', CURRENT_DATE, 'ILS', 1000, 0, 1000, 1000, 1, 'base',
                      date_trunc('second', now()), $6, $7, $8)`,
        params: [target.tenantId, target.businessId, id, target.branchId, target.warehouseId, SHA, btid, userId],
      };
    case 'payment_allocations':
      return {
        sql: allocationInsert(),
        params: allocationParams(target, id, target.probeInvoiceId, 2, 0),
      };
    case 'customer_credit_applications':
      return {
        sql: applicationInsert(),
        params: applicationParams(target, id, target.probeInvoiceId, 900, 0, userId),
      };
  }
}

/** Every policy on the four relations, as the catalogue holds it right now. */
async function policyState(c: Client): Promise<
  {
    relname: string;
    polname: string;
    polpermissive: boolean;
    polcmd: string;
    roles: string[];
    q: string | null;
    wc: string | null;
  }[]
> {
  const r = await c.query<{ relname: string; polname: string; polpermissive: boolean; polcmd: string; roles: string[]; q: string | null; wc: string | null }>(
    `SELECT c.relname, p.polname, p.polpermissive, p.polcmd::text AS polcmd,
            (SELECT coalesce(array_agg(r.rolname::text ORDER BY r.rolname), ARRAY[]::text[]) FROM pg_roles r WHERE r.oid = ANY (p.polroles)) AS roles,
            pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS wc
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) ORDER BY 1, 2`,
    [[...RELATIONS]],
  );
  return r.rows;
}

/**
 * Assert that `law` FAILS, and keep the real text it failed with.
 *
 * A red proof that accepted any failure would accept a typo, so the message
 * has to carry `expected`: the words of the law that was supposed to break.
 */
async function mustGoRed(what: string, expected: string, law: () => Promise<void>): Promise<string> {
  let message: string | null = null;
  try {
    await law();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  if (message === null) throw new Error(`RED PROOF FAILED: with ${what} installed, this file's own law still passed — it cannot see the attack`);
  expect(message, `the law that broke under ${what} is not the law this proof names`).toContain(expected);
  record(`${what}\n    → ${message.split('\n').slice(0, 6).join('\n      ')}`);
  return message;
}

/** The catalogue state of one relation's policies, for a restore comparison. */
function stateOf(rows: Awaited<ReturnType<typeof policyState>>, rel: Relation): string {
  return JSON.stringify(rows.filter((r) => r.relname === rel));
}

// ── THE LAWS, each one callable on its own so a red proof can break it ────

/**
 * LAW R (READ): with real rows in three scopes, the reader sees its own
 * business's row and nothing else — and each denial is isolated to ONE
 * barrier by the scope it is read under.
 */
async function lawRead(c: Client, w: World, rel: Relation): Promise<void> {
  const mine = w.A.subject[rel];
  const sameTenantOtherBusiness = w.A2.subject[rel];
  const otherTenant = w.B.subject[rel];
  const all = [mine, sameTenantOtherBusiness, otherTenant];

  // Non-vacuity: the three subjects exist and are three distinct rows. A
  // visibility law over rows that are not there is a law about nothing.
  const asOwner = await visible(c, rel, all);
  expect(asOwner, `${rel}: the three seeded subject rows must exist before visibility means anything`).toEqual([...all].sort());

  await asRole(c, READER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, async () => {
    expect(await visible(c, rel, [mine]), `${rel}: my own tenant's and my own business's row IS visible`).toEqual([mine]);
    expect(
      await visible(c, rel, [sameTenantOtherBusiness]),
      `${rel}: a row of ANOTHER BUSINESS OF MY OWN TENANT is not visible — the RESTRICTIVE business_isolation_read is the only policy refusing it`,
    ).toEqual([]);
    expect(await visible(c, rel, [otherTenant]), `${rel}: a row of ANOTHER TENANT is not visible`).toEqual([]);
    expect(await total(c, rel), `${rel}: the reader scoped to my business sees exactly its own rows and no others`).toBe(
      rel === 'invoices' ? 2 : rel === 'sales' ? 4 : 1,
    );
  });

  // The TENANT barrier, alone: the business GUC names the other tenant's
  // business, so business_isolation_read ADMITS the row and only
  // tenant_membership stands between the reader and another tenant's data.
  await asRole(c, READER, { tenantId: w.A.tenantId, businessId: w.B.businessId }, async () => {
    expect(
      await visible(c, rel, [otherTenant]),
      `${rel}: with the business GUC naming the OTHER TENANT's business, the row is still not visible — tenant_membership is the only policy refusing it`,
    ).toEqual([]);
    expect(await total(c, rel), `${rel}: a scope that crosses the tenant boundary sees nothing at all`).toBe(0);
  });
}

/** LAW U (UNSET): with either scope GUC absent, nothing is visible. */
async function lawUnset(c: Client, w: World, rel: Relation): Promise<void> {
  const all = [w.A.subject[rel], w.A2.subject[rel], w.B.subject[rel]];
  for (const [what, scope] of [
    ['app.tenant_id at its default', { tenantId: null, businessId: w.A.businessId }],
    ['app.tenant_id empty', { tenantId: '', businessId: w.A.businessId }],
    ['app.business_id at its default', { tenantId: w.A.tenantId, businessId: null }],
    ['app.business_id empty', { tenantId: w.A.tenantId, businessId: '' }],
    ['both at their default', { tenantId: null, businessId: null }],
  ] as const) {
    await asRole(c, READER, scope, async () => {
      expect(await visible(c, rel, all), `${rel}: with ${what}, no row of any business is visible`).toEqual([]);
      expect(await total(c, rel), `${rel}: with ${what}, the relation is empty to the reader`).toBe(0);
    });
  }
}

/**
 * LAW W (WRITE): a write carrying a foreign `tenant_id`, and a write carrying
 * a foreign `business_id`, are both REFUSED BY ROW SECURITY — while the same
 * write in scope is TAKEN.
 */
async function lawWrite(c: Client, w: World, rel: Relation): Promise<void> {
  // The positive control first: in scope, this exact write commits. Without
  // it, a refusal below could be the row being malformed rather than the
  // barrier holding.
  const inScope = writeProbe(rel, w.A, seedUserId);
  const taken = await asRole(c, WRITER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, () => attempt(c, inScope.sql, inScope.params));
  expect(
    summary(taken),
    `${rel}: POSITIVE CONTROL — the same write, in scope, must be TAKEN, or every refusal below is about the row and not about the barrier. Got: ${taken.message}`,
  ).toBe('taken 1 row(s)');

  // THE TENANT BARRIER ON THE WRITE SIDE (the case B1 breaks). The business
  // GUC names the other tenant's business, so business_isolation_insert
  // ADMITS this row: only tenant_membership's WITH CHECK refuses it.
  const foreignTenant = writeProbe(rel, w.B, seedUserId);
  const t = await asRole(c, WRITER, { tenantId: w.A.tenantId, businessId: w.B.businessId }, () => attempt(c, foreignTenant.sql, foreignTenant.params));
  expect(
    summary(t),
    `${rel}: a write carrying ANOTHER TENANT's tenant_id is refused by row security (SQLSTATE 42501), not taken — this is the write tenant_membership's WITH CHECK exists to refuse. Got: ${t.message}`,
  ).toBe('refused 42501');
  expect(t.message, `${rel}: the refusal of a foreign tenant_id must be the ROW SECURITY refusal and not a constraint, a trigger or a privilege`).toContain(
    'violates row-level security policy',
  );

  // THE BUSINESS BARRIER ON THE WRITE SIDE. Same tenant, another business:
  // tenant_membership admits it, business_isolation_insert refuses it.
  const foreignBusiness = writeProbe(rel, w.A2, seedUserId);
  const b = await asRole(c, WRITER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, () => attempt(c, foreignBusiness.sql, foreignBusiness.params));
  expect(summary(b), `${rel}: a write carrying ANOTHER BUSINESS OF MY OWN TENANT is refused by row security (SQLSTATE 42501). Got: ${b.message}`).toBe(
    'refused 42501',
  );
  expect(b.message, `${rel}: the refusal of a foreign business_id must be the ROW SECURITY refusal`).toContain('violates row-level security policy');
}

/**
 * LAW M (MUTATION): an UPDATE or a DELETE that names a foreign-scope row
 * affects ZERO rows, and the ordinary application role may not attempt either
 * at all.
 *
 * The shipped grant model gives `daftar_app` SELECT and nothing else, and
 * gives DELETE to NO principal. So the mutation side of the boundary is
 * asserted where it actually lives: the privilege refusal as the privilege
 * refusal, and the policy barrier as zero rows under the ONE principal that
 * holds the narrow UPDATE.
 */
async function lawMutation(c: Client, w: World, rel: Relation): Promise<void> {
  const foreign = w.A2.subject[rel];
  const otherTenant = w.B.subject[rel];
  const mine = w.A.subject[rel];

  // (a) The ordinary application role may not mutate these relations at all.
  await asRole(c, READER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, async () => {
    const u = await attempt(c, `UPDATE ${rel} SET tenant_id = tenant_id WHERE id = $1`, [foreign]);
    expect(summary(u), `${rel}: ${READER} holds no UPDATE on this relation, so the attempt is refused outright. Got: ${u.message}`).toBe('refused 42501');
    expect(u.message, `${rel}: and the refusal is the PRIVILEGE refusal`).toContain('permission denied');
    const d = await attempt(c, `DELETE FROM ${rel} WHERE id = $1`, [foreign]);
    expect(summary(d), `${rel}: ${READER} holds no DELETE on this relation either. Got: ${d.message}`).toBe('refused 42501');
    expect(d.message, `${rel}: and that refusal is the PRIVILEGE refusal too`).toContain('permission denied');
  });

  // (b) DELETE is granted to no principal in the shipped model, so even the
  // writer cannot reach a row of its own business with it.
  await asRole(c, WRITER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, async () => {
    const d = await attempt(c, `DELETE FROM ${rel} WHERE id = $1`, [mine]);
    expect(summary(d), `${rel}: no DELETE privilege exists for ${WRITER} either. Got: ${d.message}`).toBe('refused 42501');
    expect(d.message, `${rel}: the DELETE refusal is the privilege refusal`).toContain('permission denied');
  });

  // (c) The one UPDATE the model grants is on `invoices` and `sales`, as
  // `daftar_inventory_internal`, over a narrow column list. That is the only
  // place the UPDATE barrier can be reached by behaviour at all, and reaching
  // a foreign-scope row with it affects ZERO rows. The read policies admit
  // every row to this principal (`inventory_internal_read USING (true)`), so
  // what refuses the row here IS `business_isolation_update` / the tenant
  // policy and not the read barrier standing in for them.
  if (rel === 'invoices' || rel === 'sales') {
    await asRole(c, WRITER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, async () => {
      const u = await attempt(c, `UPDATE ${rel} SET status = status WHERE id = $1`, [foreign]);
      expect(summary(u), `${rel}: an UPDATE naming a row of another business of my own tenant affects ZERO rows. Got: ${u.message}`).toBe('taken 0 row(s)');
      const own = await attempt(c, `UPDATE ${rel} SET status = status WHERE id = $1`, [mine]);
      expect(
        summary(own),
        `${rel}: POSITIVE CONTROL — the same UPDATE reaches my own row, so the zero above is the barrier and not the statement. Got: ${own.message}`,
      ).toBe('taken 1 row(s)');
    });
    await asRole(c, WRITER, { tenantId: w.A.tenantId, businessId: w.B.businessId }, async () => {
      const u = await attempt(c, `UPDATE ${rel} SET status = status WHERE id = $1`, [otherTenant]);
      expect(
        summary(u),
        `${rel}: with the business GUC naming the other tenant's business, an UPDATE of that tenant's row still affects ZERO rows — tenant_membership's USING is the only policy refusing it. Got: ${u.message}`,
      ).toBe('taken 0 row(s)');
    });
  } else {
    await asRole(c, WRITER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, async () => {
      const u = await attempt(c, `UPDATE ${rel} SET tenant_id = tenant_id WHERE id = $1`, [mine]);
      expect(summary(u), `${rel}: this relation is append-only: no principal holds UPDATE on it. Got: ${u.message}`).toBe('refused 42501');
      expect(u.message, `${rel}: and that refusal is the privilege refusal`).toContain('permission denied');
    });
  }
}

/**
 * LAW A (ALGEBRA): each relation carries exactly the seven policies, each
 * with the COMMAND it applies to and the OPERATOR — PERMISSIVE (OR-ed) or
 * RESTRICTIVE (AND-ed) — the boundary is built from.
 *
 * This is the law B2 cannot survive, and it reads no qual text: it reads the
 * operators the executor combines the quals with. A policy re-created under
 * its own name with its own qual and the other operator is a different
 * boundary, and this is where that shows.
 */
async function lawAlgebra(c: Client, rel: Relation): Promise<void> {
  const rows = (await policyState(c)).filter((r) => r.relname === rel);
  // The AND-ed barriers, named and counted first, because this is the single
  // fact B2 destroys and a short assertion is a readable one. A policy that
  // moved from RESTRICTIVE to PERMISSIVE leaves this list.
  expect(
    rows
      .filter((r) => !r.polpermissive)
      .map((r) => `${r.polname}/${r.polcmd}`)
      .join(' '),
    `${rel}: the four RESTRICTIVE policies — the AND-ed barriers, one per command`,
  ).toBe('business_isolation_delete/d business_isolation_insert/a business_isolation_read/r business_isolation_update/w');
  expect(
    rows
      .filter((r) => r.polpermissive)
      .map((r) => `${r.polname}/${r.polcmd}`)
      .join(' '),
    `${rel}: the three PERMISSIVE policies — the OR-ed admissions`,
  ).toBe('accounting_validator/r inventory_internal_read/r tenant_membership/*');
  expect(
    rows
      .map(
        (r) => `${r.polname} ${r.polpermissive ? 'PERMISSIVE' : 'RESTRICTIVE'} ${r.polcmd} [${r.roles.join(',')}] using=${r.q !== null} check=${r.wc !== null}`,
      )
      .join('\n'),
    `${rel}: the seven policies, their commands, their PERMISSIVE/RESTRICTIVE algebra and which halves they carry`,
  ).toBe(
    ALGEBRA.map((p) => `${p.polname} ${p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} ${p.cmd} [${p.roles.join(',')}] using=${p.using} check=${p.check}`).join(
      '\n',
    ),
  );
}

/** A plant, and the exact catalogue state it must be restored to. */
async function withPlant(c: Client, rel: Relation, plant: readonly string[], fn: () => Promise<void>): Promise<void> {
  const before = await policyState(c);
  const sp = `plant_${randomUUID().replace(/-/g, '')}`;
  await c.query(`SAVEPOINT ${sp}`);
  try {
    for (const sql of plant) await c.query(sql);
    const after = await policyState(c);
    if (stateOf(after, rel) === stateOf(before, rel))
      throw new Error(`the plant on ${rel} changed nothing in the catalogue, so it proves nothing: ${plant.join('; ')}`);
    await fn();
  } finally {
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
  // The restore is asserted against what was READ BEFORE the plant, never
  // against a literal written here: a literal would restore this file's
  // opinion of the boundary over whatever the migration actually installed.
  expect(stateOf(await policyState(c), rel), `the policy surface of ${rel} is back to the state captured before the plant`).toBe(stateOf(before, rel));
}

// ── THE SUITE ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  db = await createScratchDb('daftar_p4s4_barrier');
  const head = db.applied[db.applied.length - 1];
  if (head === undefined || !head.startsWith('0086_')) throw new Error(`the scratch database was not built to 0086 but to ${String(head)}`);
}, 900_000);

afterAll(async () => {
  await db?.drop();
});

describe('P4-S4 — the policy surface the behavioural laws rest on', () => {
  it('row security is enabled AND forced on all four relations, and neither probing role can bypass it', async () => {
    const r = await db.pool.query<{ relname: string; on: boolean; forced: boolean }>(
      `SELECT relname::text AS relname, relrowsecurity AS on, relforcerowsecurity AS forced
         FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY ($1::text[]) ORDER BY 1`,
      [[...RELATIONS]],
    );
    expect(r.rows.map((x) => `${x.relname} ${x.on} ${x.forced}`)).toEqual([...RELATIONS].sort().map((rel) => `${rel} true true`));
    const roles = await db.pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname::text AS rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY ($1::text[]) ORDER BY 1`,
      [[READER, WRITER]],
    );
    expect(
      roles.rows.map((x) => `${x.rolname} super=${x.rolsuper} bypassrls=${x.rolbypassrls}`),
      'a probing role that could bypass row security would make every case below vacuous',
    ).toEqual([`${READER} super=false bypassrls=false`, `${WRITER} super=false bypassrls=false`]);
  }, 120_000);

  it('app_bypass() is the platform principal and nobody else, evaluated rather than read', async () => {
    const c = await connect();
    try {
      await c.query('BEGIN');
      const answers: string[] = [];
      for (const role of ['daftar_platform', READER, WRITER]) {
        await c.query(`SET LOCAL ROLE ${role}`);
        const r = await c.query<{ u: string; b: boolean }>(`SELECT current_user::text AS u, app_bypass() AS b`);
        const row = must(r.rows[0], 'app_bypass answer');
        answers.push(`${row.u} ${row.b}`);
        await c.query('RESET ROLE');
      }
      expect(answers, 'app_bypass() answers true for daftar_platform and false for the two principals this file probes with').toEqual([
        'daftar_platform true',
        `${READER} false`,
        `${WRITER} false`,
      ]);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }, 120_000);

  for (const rel of RELATIONS) {
    it(`${rel}: the seven policies, with the command and the PERMISSIVE/RESTRICTIVE operator of each`, async () => {
      const c = await connect();
      try {
        await lawAlgebra(c, rel);
      } finally {
        await c.end();
      }
    }, 120_000);
  }
});

describe('P4-S4 — what the ordinary application role can SEE', () => {
  for (const rel of RELATIONS) {
    it(`${rel}: my own row is visible; another tenant's is not; another business of my own tenant is not`, async () => {
      await inCase(async (c, w) => {
        await lawRead(c, w, rel);
      });
    }, 300_000);

    it(`${rel}: with either scope GUC absent, nothing is visible`, async () => {
      await inCase(async (c, w) => {
        await lawUnset(c, w, rel);
      });
    }, 300_000);
  }
});

describe('P4-S4 — what the writer principal can WRITE', () => {
  for (const rel of RELATIONS) {
    it(`${rel}: a write carrying a foreign tenant_id is refused, a foreign business_id is refused, the same write in scope is taken`, async () => {
      await inCase(async (c, w) => {
        await lawWrite(c, w, rel);
      });
    }, 300_000);

    it(`${rel}: an UPDATE or DELETE reaching a foreign-scope row affects zero rows, where the privilege to attempt it exists at all`, async () => {
      await inCase(async (c, w) => {
        await lawMutation(c, w, rel);
      });
    }, 300_000);
  }
});

describe('P4-S4 — THE RED PROOFS: each law above, broken by the attack it exists for', () => {
  it('B1 — tenant_membership WITH CHECK (tenant_id IS NOT NULL) admits a foreign tenant_id, and LAW W refuses it on all four relations', async () => {
    await inCase(async (c, w) => {
      for (const rel of RELATIONS) {
        await withPlant(c, rel, [`ALTER POLICY tenant_membership ON ${rel} WITH CHECK (tenant_id IS NOT NULL)`], async () => {
          await mustGoRed(
            `B1 on ${rel}: ALTER POLICY tenant_membership ON ${rel} WITH CHECK (tenant_id IS NOT NULL)`,
            `${rel}: a write carrying ANOTHER TENANT's tenant_id is refused by row security`,
            () => lawWrite(c, w, rel),
          );
        });
      }
    });
  }, 600_000);

  it('B2 — business_isolation_delete re-created AS PERMISSIVE with a byte-identical USING, and LAW A refuses it on all four relations', async () => {
    await inCase(async (c, w) => {
      for (const rel of RELATIONS) {
        const before = (await policyState(c)).find((r) => r.relname === rel && r.polname === 'business_isolation_delete');
        const using = must(before?.q, `${rel}.business_isolation_delete USING`);
        // The control, under the SHIPPED policy: with the missing DELETE
        // privilege granted inside this case, an unqualified DELETE scoped to
        // a business that holds no rows reaches nothing at all.
        expect(
          await deleteReach(c, w, rel),
          `${rel}: CONTROL — under the shipped RESTRICTIVE delete policy an unqualified DELETE in an empty business reaches no row`,
        ).toBe('taken 0 row(s)');
        await withPlant(
          c,
          rel,
          [`DROP POLICY business_isolation_delete ON ${rel}`, `CREATE POLICY business_isolation_delete ON ${rel} AS PERMISSIVE FOR DELETE USING (${using})`],
          async () => {
            // The attack's own claim first: the count is unchanged and the
            // qual is byte-identical, so a law that counts or compares text
            // sees nothing.
            const after = await policyState(c);
            expect(
              after.filter((r) => r.relname === rel),
              `${rel}: the plant leaves seven policies standing`,
            ).toHaveLength(7);
            const planted = must(
              after.find((r) => r.relname === rel && r.polname === 'business_isolation_delete'),
              'the planted delete policy',
            );
            expect(planted.q, `${rel}: the planted policy's USING is byte-identical to the shipped one`).toBe(using);
            expect(planted.polpermissive, `${rel}: and it is now OR-ed into the result instead of AND-ed`).toBe(true);
            await mustGoRed(
              `B2 on ${rel}: DROP POLICY business_isolation_delete + CREATE POLICY business_isolation_delete AS PERMISSIVE FOR DELETE with the same USING`,
              `${rel}: the four RESTRICTIVE policies — the AND-ed barriers, one per command`,
              () => lawAlgebra(c, rel),
            );
            await lawB2Consequence(c, w, rel);
          },
        );
      }
    });
  }, 600_000);

  it('a blanket read barrier — business_isolation_read USING (true) — shows another business of my own tenant, and LAW R refuses it on all four relations', async () => {
    await inCase(async (c, w) => {
      for (const rel of RELATIONS) {
        await withPlant(c, rel, [`ALTER POLICY business_isolation_read ON ${rel} USING (true)`], async () => {
          await mustGoRed(
            `ALTER POLICY business_isolation_read ON ${rel} USING (true)`,
            `${rel}: a row of ANOTHER BUSINESS OF MY OWN TENANT is not visible`,
            () => lawRead(c, w, rel),
          );
        });
      }
    });
  }, 600_000);

  it('a blanket tenant barrier — tenant_membership USING (tenant_id IS NOT NULL) — shows another tenant, and LAW R refuses it on all four relations', async () => {
    await inCase(async (c, w) => {
      for (const rel of RELATIONS) {
        await withPlant(c, rel, [`ALTER POLICY tenant_membership ON ${rel} USING (tenant_id IS NOT NULL)`], async () => {
          await mustGoRed(
            `ALTER POLICY tenant_membership ON ${rel} USING (tenant_id IS NOT NULL)`,
            `${rel}: with the business GUC naming the OTHER TENANT's business, the row is still not visible`,
            () => lawRead(c, w, rel),
          );
        });
      }
    });
  }, 600_000);
});

/**
 * WHAT B2 ACTUALLY COSTS, SHOWN BY EXECUTION.
 *
 * `DELETE` is granted to NO principal on these four relations, so with the
 * shipped grants the delete barrier cannot be reached by any behaviour at
 * all: every attempt dies at the privilege check, and the policy is defence
 * in depth BEHIND that grant. That is why LAW A — the algebra — is the law
 * that catches B2, and it is also why this function exists: to show that the
 * RESTRICTIVE operator is load-bearing and not decorative, by granting the
 * missing privilege INSIDE the rolled-back case and watching what the
 * permissive policy then admits.
 *
 * Under the shipped RESTRICTIVE policy, an unqualified DELETE scoped to a
 * business that holds no rows reaches nothing. Under the planted PERMISSIVE
 * one it reaches the rows of every business of my tenant — where the
 * relation's own append-only trigger is what finally refuses, which is the
 * last line of defence and not the boundary.
 */
async function lawB2Consequence(c: Client, w: World, rel: Relation): Promise<void> {
  const reached = await deleteReach(c, w, rel);
  expect(reached, `${rel}: with business_isolation_delete made PERMISSIVE, an unqualified DELETE in an EMPTY business reached rows it must never see`).not.toBe(
    'taken 0 row(s)',
  );
  record(`B2 consequence on ${rel}: with DELETE granted inside the case, an unqualified DELETE scoped to an empty business → ${reached}`);
}

/**
 * What an unqualified DELETE, run by the ordinary role under a scope that
 * owns no rows, reaches — with the missing DELETE privilege granted inside a
 * savepoint that is always rolled back.
 *
 * An unqualified DELETE references no column, so the SELECT policies are not
 * applied to it and the DELETE policies alone decide what it reaches. The
 * answer is reported as a string so the caller can compare the shipped
 * surface against the planted one.
 */
async function deleteReach(c: Client, w: World, rel: Relation): Promise<string> {
  const sp = `b2_${randomUUID().replace(/-/g, '')}`;
  await c.query(`SAVEPOINT ${sp}`);
  try {
    await c.query(`GRANT DELETE ON ${rel} TO ${READER}`);
    const r = await asRole(c, READER, { tenantId: w.A.tenantId, businessId: w.emptyBusinessId }, () => attempt(c, `DELETE FROM ${rel}`));
    return r.ok ? summary(r) : `${summary(r)}: ${r.message.split('\n')[0] ?? ''}`;
  } finally {
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
}
