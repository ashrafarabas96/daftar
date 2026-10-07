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

// ═══════════════════════════════════════════════════════════════════════════
// PART TWO — REACHABILITY: THE BARRIER ON EVERY PATH, NOT ON ONE STATEMENT
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT PART ONE ABOVE ESTABLISHES, AND WHERE IT STOPS. Part one reads each
// relation with `SELECT id … WHERE id = ANY (…)` and with `count(*)`. That is
// ONE statement form. A row-level policy is not attached to a statement form
// — it is attached to the relation — but WHICH policy the executor applies,
// and AS WHOM, is decided by the path the relation is reached by:
//
//   — a VIEW's row security is evaluated as the VIEW'S OWNER, not as the
//     caller, unless the view carries `security_invoker`. A view over
//     `invoices` owned by a superuser hands every row to anybody who may
//     select from it, and no policy on `invoices` is consulted at all;
//   — a SECURITY DEFINER routine's row security is evaluated as the
//     ROUTINE'S OWNER. Four such routines over these relations are executable
//     by `daftar_app`, and every one of them is owned by a role that
//     `business_isolation_read` NAMES IN ITS ESCAPE LIST — so for those paths
//     the read barrier admits everything by construction;
//   — the five READERS OF RECORD (`invoice_outstanding`,
//     `customer_ar_outstanding`, `customer_ar_aging`,
//     `customer_open_invoices_page`, `invoice_settlement_state`) take the
//     business as an ARGUMENT. A caller scoped to one business may name
//     another business's id in the call, and nothing in the argument list
//     stops it;
//   — and the quals `0086` rewrote are now scalar subselects, which are
//     `InitPlan`s evaluated once per EXECUTION. A plan is cached and reused
//     across executions, so "once per query" has to mean once per execution
//     and not once per PLAN, or a prepared statement would carry the scope it
//     was first planned under.
//
// None of those five paths is a `SELECT … WHERE id = ANY (…)`, and none of
// them was asserted anywhere. The laws below assert them, and they assert
// them the only way that distinguishes a barrier from an accident: every
// probe is run FOUR times — as the owner, who is subject to no policy; as
// the reader in its own scope on its own row; as the same reader on the other
// business's row; and as the same reader on an id that does not exist at all.
//
// AN EMPTY RESULT SET IS NOT A REFUSAL. `owner = reached` says the row is
// there and the path reaches it. `mine = reached` says the reader's scope is
// live and the path works for the reader. `absent = not reached` says what
// absence looks like on this path. Only with those three in hand does
// `otherBusiness = not reached` mean the barrier refused, rather than the
// relation being empty, the scope being NULL or the statement being broken.

/** The three internal principals the four relations grant anything to, beside the application role. */
const ACCOUNTING_READER = 'daftar_accounting_internal';

/**
 * THE ESCAPE LIST, AS AN ENTITLEMENT AND NOT AS A DERIVATION.
 *
 * `0086` writes two literals into `business_isolation_read` and the pre- and
 * post-state blocks of the migration pin that TEXT. This is the same claim
 * made of BEHAVIOUR, and it is deliberately written down here rather than
 * read out of the catalogue: a law that derived its expectation from the
 * policy it is judging would move with an attack. A role added to the escape
 * list — the exact attack `0086-A`'s literal enumeration exists to catch —
 * must change what some principal can READ, and this is where that shows.
 */
const ENTITLED_PAST_THE_BUSINESS_BARRIER: readonly string[] = [ACCOUNTING_READER, WRITER];

/** One way of reaching a relation, asked whether it reveals one row. */
interface ReadPath {
  readonly name: string;
  /** Did this path reveal anything at all about the row `id` of `rel`? */
  reveals(c: Client, rel: Relation, id: string): Promise<boolean>;
}

const nonEmpty = async (c: Client, sql: string, params: unknown[]): Promise<boolean> => (await c.query(sql, params)).rows.length > 0;

/**
 * EVERY PATH A READER HOLDING `SELECT` CAN REACH ONE OF THESE RELATIONS BY.
 *
 * Each one answers the same question — "does this statement reveal the row
 * `id`?" — so the whole set can be run as one matrix and compared against one
 * expectation. They are not stylistic variations: each puts the relation in a
 * different place in the plan (a driving scan, an inner side, a subquery, a
 * CTE boundary, a grouping input, a cursor's portal, a locked row, an
 * ANTI-join), and the question is whether the policy follows the relation
 * into all of them.
 *
 * Three shapes are absent for a reason rather than by oversight, and the
 * reason is the same one each time — a path the reader cannot take is not a
 * path. `COPY … TO STDOUT` needs a protocol-level stream this repository
 * installs no package for; a temporary table needs `TEMPORARY` on the
 * database, which `bootstrap.sql` revokes from every runtime principal; and a
 * LOCKING clause (`FOR SHARE`, `FOR UPDATE`) needs a write privilege on the
 * relation, so `daftar_app` is refused it by the GRANT before any policy is
 * reached — measured here as `permission denied for table sales` on
 * `SELECT id FROM sales WHERE id = $1 FOR SHARE`.
 */
const READ_PATHS: readonly ReadPath[] = [
  {
    name: 'SELECT id … WHERE id = $1',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT id FROM ${rel} WHERE id = $1`, [id]),
  },
  {
    name: 'SELECT * — every column, not the key alone',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT * FROM ${rel} WHERE id = $1`, [id]),
  },
  {
    name: 'an UNFILTERED scan of the whole relation',
    reveals: async (c, rel, id) => (await c.query<{ id: string }>(`SELECT id::text AS id FROM ${rel}`)).rows.some((r) => r.id === id),
  },
  {
    name: 'count(*) as an existence oracle',
    reveals: async (c, rel, id) =>
      Number(must((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${rel} WHERE id = $1`, [id])).rows[0], 'n').n) > 0,
  },
  {
    name: 'EXISTS — a boolean that carries no row',
    reveals: async (c, rel, id) =>
      must((await c.query<{ yes: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${rel} WHERE id = $1) AS yes`, [id])).rows[0], 'exists').yes,
  },
  {
    name: 'NOT IN — the ANTI-join, where a refusal could leak as an absence',
    reveals: async (c, rel, id) =>
      (await c.query(`SELECT u.id FROM unnest(ARRAY[$1]::uuid[]) AS u(id) WHERE u.id NOT IN (SELECT id FROM ${rel})`, [id])).rows.length === 0,
  },
  {
    name: 'an AGGREGATE over a value column — the scope column itself',
    reveals: async (c, rel, id) =>
      must((await c.query<{ v: string | null }>(`SELECT max(business_id::text) AS v FROM ${rel} WHERE id = $1`, [id])).rows[0], 'max').v !== null,
  },
  {
    name: 'GROUP BY over the whole relation',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT g.id FROM (SELECT id FROM ${rel} GROUP BY id) AS g WHERE g.id = $1`, [id]),
  },
  {
    name: 'a WINDOW function over the whole relation',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT z.id FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ${rel}) AS z WHERE z.id = $1`, [id]),
  },
  {
    name: 'a JOIN driven from a source carrying no policy',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT r.id FROM unnest(ARRAY[$1]::uuid[]) AS u(id) JOIN ${rel} r ON r.id = u.id`, [id]),
  },
  {
    name: 'a SELF-JOIN — the relation on both sides',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT a.id FROM ${rel} a JOIN ${rel} b ON b.id = a.id WHERE a.id = $1`, [id]),
  },
  {
    name: 'IN (subquery)',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT u.id FROM unnest(ARRAY[$1]::uuid[]) AS u(id) WHERE u.id IN (SELECT id FROM ${rel})`, [id]),
  },
  {
    name: 'a CORRELATED EXISTS subquery',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT u.id FROM unnest(ARRAY[$1]::uuid[]) AS u(id) WHERE EXISTS (SELECT 1 FROM ${rel} r WHERE r.id = u.id)`, [id]),
  },
  {
    name: 'a LATERAL subquery',
    reveals: (c, rel, id) =>
      nonEmpty(c, `SELECT x.id FROM unnest(ARRAY[$1]::uuid[]) AS u(id), LATERAL (SELECT r.id FROM ${rel} r WHERE r.id = u.id) AS x`, [id]),
  },
  {
    name: 'a MATERIALIZED CTE — an optimisation fence',
    reveals: (c, rel, id) => nonEmpty(c, `WITH m AS MATERIALIZED (SELECT id FROM ${rel}) SELECT id FROM m WHERE id = $1`, [id]),
  },
  {
    name: 'a NOT MATERIALIZED CTE — inlined into the outer plan',
    reveals: (c, rel, id) => nonEmpty(c, `WITH m AS NOT MATERIALIZED (SELECT id FROM ${rel}) SELECT id FROM m WHERE id = $1`, [id]),
  },
  {
    name: 'UNION ALL — two scans of the relation in one statement',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT id FROM ${rel} WHERE id = $1 UNION ALL SELECT id FROM ${rel} WHERE id = $1`, [id]),
  },
  {
    name: 'INTERSECT against a source carrying no policy',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT id FROM ${rel} INTERSECT SELECT u.id FROM unnest(ARRAY[$1]::uuid[]) AS u(id)`, [id]),
  },
  {
    name: 'a SYSTEM column (ctid), which no policy names',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT ctid::text FROM ${rel} WHERE id = $1`, [id]),
  },
  {
    name: 'a SCALAR SUBQUERY in the target list, where no row is projected at all',
    reveals: async (c, rel, id) =>
      must((await c.query<{ n: string }>(`SELECT (SELECT count(*) FROM ${rel} WHERE id = $1)::text AS n`, [id])).rows[0], 'scalar subquery').n !== '0',
  },
  {
    name: 'a RECURSIVE CTE, whose working table is filled from the relation',
    reveals: (c, rel, id) =>
      nonEmpty(
        c,
        `WITH RECURSIVE walk(id) AS (SELECT id FROM ${rel} WHERE id = $1 UNION ALL SELECT r.id FROM walk w JOIN ${rel} r ON false) SELECT id FROM walk`,
        [id],
      ),
  },
  {
    name: 'EXCEPT — the relation as the SUBTRAHEND of a set difference',
    reveals: async (c, rel, id) => (await c.query(`SELECT u.id FROM unnest(ARRAY[$1]::uuid[]) AS u(id) EXCEPT SELECT id FROM ${rel}`, [id])).rows.length === 0,
  },
  {
    name: 'row_to_json over the whole row',
    reveals: (c, rel, id) => nonEmpty(c, `SELECT row_to_json(r.*) AS j FROM ${rel} r WHERE r.id = $1`, [id]),
  },
  {
    name: 'a CURSOR, fetched row by row out of a portal',
    reveals: async (c, rel, id) => {
      const cur = `cur_${randomUUID().replace(/-/g, '')}`;
      await c.query(`DECLARE ${cur} NO SCROLL CURSOR FOR SELECT id FROM ${rel} WHERE id = $1`, [id]);
      try {
        return (await c.query(`FETCH ALL FROM ${cur}`)).rows.length > 0;
      } finally {
        await c.query(`CLOSE ${cur}`);
      }
    },
  },
];

/** One row of the reachability matrix: what each of the four legs answered. */
interface MatrixRow {
  readonly path: string;
  readonly owner: boolean;
  readonly mine: boolean;
  readonly otherBusiness: boolean;
  readonly otherTenant: boolean;
  readonly absent: boolean;
}

/**
 * Run every path four times over, and report what each answered.
 *
 * The matrix is the evidence. A law that asserted only `otherBusiness =
 * false` could be satisfied by a broken statement, an empty relation or a
 * NULL scope; the other three legs are what make the `false` mean the barrier
 * refused, and they are carried into the failure message rather than checked
 * and thrown away.
 */
async function reachabilityMatrix(c: Client, w: World, rel: Relation): Promise<MatrixRow[]> {
  const mine = w.A.subject[rel];
  const otherBusiness = w.A2.subject[rel];
  const otherTenant = w.B.subject[rel];
  const absent = randomUUID();
  const inMyScope: Scope = { tenantId: w.A.tenantId, businessId: w.A.businessId };
  // The scope that leaves the TENANT barrier standing alone: the business GUC
  // names the other tenant's own business, so `business_isolation_read`
  // admits the row and only `tenant_membership` refuses it.
  const acrossTheTenant: Scope = { tenantId: w.A.tenantId, businessId: w.B.businessId };
  const out: MatrixRow[] = [];
  for (const p of READ_PATHS) {
    out.push({
      path: p.name,
      owner: await p.reveals(c, rel, otherBusiness),
      mine: await asRole(c, READER, inMyScope, () => p.reveals(c, rel, mine)),
      otherBusiness: await asRole(c, READER, inMyScope, () => p.reveals(c, rel, otherBusiness)),
      otherTenant: await asRole(c, READER, acrossTheTenant, () => p.reveals(c, rel, otherTenant)),
      absent: await asRole(c, READER, inMyScope, () => p.reveals(c, rel, absent)),
    });
  }
  return out;
}

const renderMatrix = (rows: readonly MatrixRow[]): string =>
  rows.map((r) => `${r.path} → owner=${r.owner} mine=${r.mine} otherBusiness=${r.otherBusiness} otherTenant=${r.otherTenant} absent=${r.absent}`).join('\n');

/**
 * LAW P (PATHS): on every path the relation is reachable by, the reader
 * scoped to one business reaches its own row and NOT the other business's,
 * and not the other tenant's — while the owner reaches all of them and an id
 * that does not exist is reached by nobody.
 */
async function lawPaths(c: Client, w: World, rel: Relation): Promise<void> {
  const rows = await reachabilityMatrix(c, w, rel);
  expect(rows, `${rel}: READ_PATHS is empty, so this matrix judged nothing`).not.toHaveLength(0);
  expect(renderMatrix(rows), `${rel}: the reachability matrix is not the barrier's`).toBe(
    READ_PATHS.map((p) => `${p.name} → owner=true mine=true otherBusiness=false otherTenant=false absent=false`).join('\n'),
  );
}

/**
 * LAW G (GENERIC PLAN): the rewritten quals are evaluated once per
 * EXECUTION, never once per PLAN.
 *
 * `0086` turned the row-invariant parts of both read quals into scalar
 * subselects so the executor runs them as an `InitPlan`. A prepared statement
 * is PLANNED once and EXECUTED many times, and after five executions
 * PostgreSQL may switch to a generic plan it keeps. If the scope were folded
 * into that plan, the sixth and every later execution would answer with the
 * scope the statement was first planned under — which is a cross-business
 * disclosure that no single-statement test can see, because it needs a
 * statement to be executed twice under two scopes.
 *
 * So: the same prepared statement, executed past the generic-plan threshold
 * in one business's scope and then again in another's, must answer each
 * execution with the scope THAT execution holds. Both plan-cache modes are
 * forced, because leaving the choice to the planner would leave which plan
 * was actually used unknown.
 */
async function lawGenericPlan(c: Client, w: World, rel: Relation): Promise<void> {
  const mine = w.A.subject[rel];
  const theirs = w.A2.subject[rel];
  for (const mode of ['force_custom_plan', 'force_generic_plan'] as const) {
    const name = `p4s4_${randomUUID().replace(/-/g, '')}`;
    const answers: string[] = [];
    await asRole(c, READER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, async () => {
      await c.query(`SET LOCAL plan_cache_mode = ${mode}`);
      await c.query(`PREPARE ${name} AS SELECT id::text AS id FROM ${rel} WHERE id = ANY ($1::uuid[]) ORDER BY 1`);
      try {
        // `EXECUTE` is a utility statement, and PostgreSQL takes no bind
        // parameters on one — `EXECUTE … ($1)` is refused with "prepared
        // statement \"\" requires 0 parameters". The two ids are
        // `randomUUID()` values from the fixture, so they go into the text.
        const run = async (): Promise<string> =>
          (await c.query<{ id: string }>(`EXECUTE ${name} (ARRAY['${mine}', '${theirs}']::uuid[])`)).rows
            .map((r) => (r.id === mine ? 'mine' : r.id === theirs ? 'THEIRS' : 'other'))
            .join(',') || 'nothing';
        // Past the five-execution threshold at which PostgreSQL may adopt a
        // generic plan and keep it.
        for (let i = 0; i < 7; i += 1) answers.push(`exec${i + 1} ${await run()}`);
        // The same statement, the same plan, the OTHER business's scope.
        await c.query(`SELECT set_config('app.business_id', $1, true)`, [w.A2.businessId]);
        answers.push(`after the scope moved to the other business: ${await run()}`);
        await c.query(`SELECT set_config('app.business_id', $1, true)`, [w.A.businessId]);
        answers.push(`and back: ${await run()}`);
      } finally {
        await c.query(`DEALLOCATE ${name}`);
        await c.query(`SET LOCAL plan_cache_mode = auto`);
      }
    });
    expect(answers.join('\n'), `${rel} [${mode}]: a prepared statement answered with a scope it no longer holds`).toBe(
      [...Array.from({ length: 7 }, (_unused, i) => `exec${i + 1} mine`), 'after the scope moved to the other business: THEIRS', 'and back: mine'].join('\n'),
    );
  }
}

// ── THE READERS OF RECORD, CALLED WITH ANOTHER BUSINESS'S ID ──────────────

/**
 * The value, and the cast, each reader-of-record parameter takes — keyed on
 * the PARAMETER NAME, so the call is synthesised for whatever routines the
 * catalogue holds rather than written out per routine. A reader carrying a
 * parameter this map does not name is a FINDING: it is a new path into one of
 * these relations that this law would otherwise skip in silence.
 */
interface ReaderArgs {
  readonly businessId: string;
  readonly customerId: string;
  readonly invoiceId: string;
}
function readerArgument(param: string, a: ReaderArgs): { cast: string; value: unknown } {
  switch (param) {
    case 'p_business_id':
      return { cast: 'uuid', value: a.businessId };
    case 'p_customer_id':
      return { cast: 'uuid', value: a.customerId };
    case 'p_invoice_id':
      return { cast: 'uuid', value: a.invoiceId };
    case 'p_invoice_ids':
      return { cast: 'uuid[]', value: [a.invoiceId] };
    case 'p_as_of':
      return { cast: 'date', value: null };
    case 'p_after_issue_date':
      return { cast: 'date', value: null };
    case 'p_after_id':
      return { cast: 'uuid', value: null };
    case 'p_bucket_days':
      return { cast: 'integer[]', value: [30, 60, 90] };
    case 'p_limit':
      return { cast: 'integer', value: 50 };
    default:
      throw new Error(
        `the reader of record carries a parameter this law cannot supply: ${param}. A NEW reader over one of the four relations is a NEW path into them, and it has to be given an argument here before this law covers it`,
      );
  }
}

interface ReaderOfRecord {
  readonly proname: string;
  readonly params: readonly string[];
}

/**
 * THE READERS OF RECORD, DERIVED FROM THE CATALOGUE.
 *
 * A routine in `public` that `daftar_app` may execute, that is SECURITY
 * INVOKER — so the policies are evaluated as the CALLER and the barrier is
 * the one this file is about — whose body names one of the four relations,
 * and that takes the business as a parameter. That last condition is what
 * makes it a path worth probing: the caller names the business it is asking
 * about, and no argument list can tell whether that business is its own.
 */
async function readersOfRecord(c: Client): Promise<ReaderOfRecord[]> {
  const r = await c.query<{ proname: string; params: string[] }>(
    `SELECT p.proname::text AS proname,
            (SELECT coalesce(array_agg(n ORDER BY ord), ARRAY[]::text[])
               FROM unnest(p.proargnames) WITH ORDINALITY AS u(n, ord)
              WHERE ord <= p.pronargs) AS params
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND NOT p.prosecdef
        AND has_function_privilege('daftar_app', p.oid, 'EXECUTE')
        AND 'p_business_id' = ANY (p.proargnames)
        AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS t(rel) WHERE coalesce(p.prosrc, '') ~ ('\\m' || t.rel || '\\M'))
      ORDER BY 1`,
    [[...RELATIONS]],
  );
  return r.rows;
}

const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * One reader's WHOLE answer, as a comparable string: its rows as JSON, or the
 * refusal it raised instead.
 *
 * These readers do not answer an unknown document with an empty set — they
 * RAISE (`invoice.not_found: the invoice does not exist in this business`),
 * which is this estate's Zero Silent Errors rule and which makes the
 * comparison below sharper rather than weaker: the question becomes whether a
 * foreign business is refused IN THE SAME WORDS as a business that does not
 * exist. If it were refused differently, the reader would be an existence
 * oracle for other businesses' documents even while handing over no row.
 *
 * Ids are normalised out of the refusal text. A message that quoted the id it
 * was asked about would differ between two calls for the trivial reason that
 * they asked about different ids, and that difference carries no information
 * about what was disclosed.
 */
async function readerAnswer(c: Client, reader: ReaderOfRecord, a: ReaderArgs): Promise<string> {
  const args = reader.params.map((p) => readerArgument(p, a));
  const placeholders = args.map((x, i) => `$${i + 1}::${x.cast}`).join(', ');
  const sql = `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS j FROM ${reader.proname}(${placeholders}) AS t`;
  const sp = `rd_${randomUUID().replace(/-/g, '')}`;
  await c.query(`SAVEPOINT ${sp}`);
  try {
    const r = await c.query<{ j: unknown }>(
      sql,
      args.map((x) => x.value),
    );
    return `rows ${JSON.stringify(must(r.rows[0], `${reader.proname} answer`).j)}`;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return `refused ${err.code ?? ''} ${(err.message ?? String(e)).replace(UUID_SHAPED, '<uuid>')}`;
  } finally {
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
}

/**
 * AN OPEN CREDIT INVOICE, SO THE CUSTOMER-LEVEL READERS HAVE SOMETHING TO
 * READ.
 *
 * `invoice_outstanding` reports ZERO for an invoice that is not `open` and
 * zero for one whose sale settled in CASH (`0084:605`, the `0080` rule), and
 * `customer_ar_outstanding` and `customer_ar_aging` then drop the row on
 * their own `HAVING sum(…) <> 0`. The part-one fixture seeds DRAFT invoices
 * on CASH sales deliberately — it is a scope fixture and the value arithmetic
 * is not its subject — so those three readers answer a real customer exactly
 * as they answer a customer who does not exist, and the discrimination this
 * law rests on would be an equality between two empty answers.
 *
 * Measured, before this existed: `customer_ar_aging`,
 * `customer_ar_outstanding` and `customer_open_invoices_page` each reported
 * `the owner's answer about the other business differs from absence: false`.
 * The non-vacuity leg caught it. Seeding the subject is the fix, not dropping
 * the leg.
 *
 * So one credit sale and one OPEN invoice on it, for the business's own
 * customer, inserted by the owner inside the caller's savepoint. The deferred
 * constraint triggers that judge settlement VALUE fire at COMMIT, and no case
 * in this file commits.
 */
async function openCreditInvoice(c: Client, b: Biz): Promise<string> {
  const saleId = randomUUID();
  await c.query(
    `INSERT INTO sales (tenant_id, business_id, id, customer_id, customer_name_snapshot, branch_id, warehouse_id, status, settlement_mode,
                        document_date, currency_code, subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor,
                        source_to_base_rate, rate_source, rate_timestamp, commit_intent_sha256, business_transaction_id, created_by)
     VALUES ($1, $2, $3, $4, 'Subject', $5, $6, 'draft', 'credit', CURRENT_DATE, 'ILS', 1000, 0, 1000, 1000, 1, 'base',
             date_trunc('second', now()), $7, $8, $9)`,
    [b.tenantId, b.businessId, saleId, b.customerId, b.branchId, b.warehouseId, SHA, btid, seedUserId],
  );
  const invoiceId = randomUUID();
  await c.query(
    `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq, period,
                           issue_date, due_date, currency_code, status, subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor,
                           source_to_base_rate, rate_source, rate_timestamp, customer_name_snapshot, issue_intent_sha256,
                           business_transaction_id, created_by, binding_source_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'invoice', $7, 7, to_char(CURRENT_DATE, 'YYYY'), CURRENT_DATE, CURRENT_DATE + 1, 'ILS', 'open',
             1000, 0, 1000, 1000, 1, 'base', date_trunc('second', now()), 'Subject', $8, $9, $10, $3)`,
    [b.tenantId, b.businessId, invoiceId, saleId, b.customerId, b.branchId, `INV-OPEN-${b.label}`, SHA, btid, seedUserId],
  );
  return invoiceId;
}

/**
 * LAW X (THE READERS OF RECORD): a reader scoped to one business, calling a
 * reader of record with ANOTHER business's id, gets the answer it would get
 * for a business that does not exist — and the proof that this is a refusal
 * and not an absence is that the OWNER's answer to the same call is
 * different, and that the same reader's answer in its OWN scope is different
 * too.
 *
 * No figure is written down here. The law is three inequalities and one
 * equality between answers the database produced, which is what lets it hold
 * over a fixture whose amounts nobody has to maintain.
 */
async function lawReadersOfRecord(c: Client, w: World): Promise<void> {
  const readers = await readersOfRecord(c);
  expect(
    readers.map((x) => x.proname),
    'the reader-of-record set is derived from the catalogue and came back empty, so this law judged nothing',
  ).not.toEqual([]);
  const sp = `rr_${randomUUID().replace(/-/g, '')}`;
  await c.query(`SAVEPOINT ${sp}`);
  try {
    await lawReadersOfRecordBody(c, w, readers);
  } finally {
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
}

async function lawReadersOfRecordBody(c: Client, w: World, readers: readonly ReaderOfRecord[]): Promise<void> {
  const mineArgs: ReaderArgs = { businessId: w.A.businessId, customerId: w.A.customerId, invoiceId: await openCreditInvoice(c, w.A) };
  const theirArgs: ReaderArgs = { businessId: w.A2.businessId, customerId: w.A2.customerId, invoiceId: await openCreditInvoice(c, w.A2) };
  const nowhere: ReaderArgs = { businessId: randomUUID(), customerId: randomUUID(), invoiceId: randomUUID() };
  const inMyScope: Scope = { tenantId: w.A.tenantId, businessId: w.A.businessId };
  const verdicts: string[] = [];
  for (const reader of readers) {
    // What ABSENCE looks like on this path: the same call, about a business
    // that is not there, made by the same reader under the same scope.
    const absent = await asRole(c, READER, inMyScope, () => readerAnswer(c, reader, nowhere));
    // The row IS there and the path DOES reach it — established by the owner,
    // who is subject to no policy. Without this leg the equality below could
    // be the equality of two empty answers.
    const byOwner = await readerAnswer(c, reader, theirArgs);
    // The path is LIVE for this reader under this scope, on its own business.
    const own = await asRole(c, READER, inMyScope, () => readerAnswer(c, reader, mineArgs));
    // And the same call, same reader, same scope, the OTHER business's id.
    const cross = await asRole(c, READER, inMyScope, () => readerAnswer(c, reader, theirArgs));
    verdicts.push(
      [
        `${reader.proname}(${reader.params.join(', ')})`,
        `  the owner's answer about the other business differs from absence: ${byOwner !== absent}`,
        `  my own answer about my own business differs from absence: ${own !== absent}`,
        `  my answer about the OTHER business is exactly absence: ${cross === absent}`,
      ].join('\n'),
    );
  }
  expect(verdicts.join('\n'), 'a reader of record answered a cross-business call with something, or answered an in-scope call with nothing').toBe(
    readers
      .map((reader) =>
        [
          `${reader.proname}(${reader.params.join(', ')})`,
          `  the owner's answer about the other business differs from absence: true`,
          `  my own answer about my own business differs from absence: true`,
          `  my answer about the OTHER business is exactly absence: true`,
        ].join('\n'),
      )
      .join('\n'),
  );
}

// ── WHO IS ADMITTED, AND WHERE ────────────────────────────────────────────

/** What one principal's attempt to read a foreign-scope row actually did. */
type Verdict = 'ADMITTED' | 'refused by the barrier' | 'refused by the grant';

async function readVerdict(c: Client, role: string, scope: Scope, rel: Relation, id: string): Promise<Verdict> {
  const r = await asRole(c, role, scope, () => attempt(c, `SELECT id FROM ${rel} WHERE id = $1`, [id]));
  if (!r.ok) {
    if (r.code === '42501') return 'refused by the grant';
    throw new Error(`${role} reading ${rel} failed in a way this law cannot classify (${r.code}): ${r.message}`);
  }
  return r.rows > 0 ? 'ADMITTED' : 'refused by the barrier';
}

/**
 * LAW E (THE ESCAPE LIST, BY BEHAVIOUR): of every principal in the cluster,
 * exactly the two `0086` names reach past the business barrier — and the
 * principal `app_bypass()` names reaches nothing at all, because it holds no
 * `SELECT` on any of these four relations.
 *
 * The roster is DERIVED: every non-superuser role in `pg_roles` that is not
 * one of PostgreSQL's own predefined `pg_*` roles. A role added to the
 * cluster is probed without this law being edited, and a role added to the
 * escape list changes its verdict here.
 *
 * `daftar_platform` is the interesting row and the reason a presence law
 * cannot answer this question. `app_bypass()` is true for it — part one
 * asserts that by execution — and the first disjunct of BOTH read quals is
 * therefore satisfied for it on all four relations. It still reaches no row,
 * because the bypass is only half of a path: the other half is a `GRANT`
 * nobody ever made. That is a fact about the shipped system that no reading
 * of the policy text can produce.
 */
async function lawEscapeList(c: Client, w: World, rel: Relation): Promise<void> {
  const roles = (
    await c.query<{ rolname: string }>(`SELECT rolname::text AS rolname FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\\_%' ORDER BY 1`)
  ).rows.map((r) => r.rolname);
  expect(roles, 'the role roster is derived from pg_roles and came back empty').not.toEqual([]);
  expect(roles, 'the two principals this law is about must be in the derived roster').toEqual(expect.arrayContaining([...ENTITLED_PAST_THE_BUSINESS_BARRIER]));

  const inMyScope: Scope = { tenantId: w.A.tenantId, businessId: w.A.businessId };
  const acrossTheTenant: Scope = { tenantId: w.A.tenantId, businessId: w.B.businessId };
  const lines: string[] = [];
  for (const role of roles) {
    const business = await readVerdict(c, role, inMyScope, rel, w.A2.subject[rel]);
    const tenant = await readVerdict(c, role, acrossTheTenant, rel, w.B.subject[rel]);
    lines.push(`${role}: another business of my tenant → ${business}; another tenant → ${tenant}`);
  }
  // THE ENTITLEMENT. The two internal readers carry `USING (true)` PERMISSIVE
  // read policies of their own (`inventory_internal_read`,
  // `accounting_validator`), and PostgreSQL OR-s permissive policies — so
  // their escape is a TOTAL read escape and reaches across the tenant
  // boundary as well. That is the shipped design, and writing it down as
  // "ADMITTED to both" is the only honest expectation: a law that expected
  // them to be refused across tenants would be red on a correct database.
  expect(lines.join('\n'), `${rel}: some principal is admitted past the business barrier that 0086 does not name, or one it names is not`).toBe(
    roles
      .map((role) =>
        ENTITLED_PAST_THE_BUSINESS_BARRIER.includes(role)
          ? `${role}: another business of my tenant → ADMITTED; another tenant → ADMITTED`
          : `${role}: another business of my tenant → ${role === READER ? 'refused by the barrier' : 'refused by the grant'}; another tenant → ${
              role === READER ? 'refused by the barrier' : 'refused by the grant'
            }`,
      )
      .join('\n'),
  );
}

/**
 * LAW E(w) (THE ESCAPE IS A READ ESCAPE): the two principals the escape list
 * names are admitted past the BUSINESS barrier ON `SELECT` AND NOWHERE ELSE.
 *
 * `business_isolation_read` is `FOR SELECT`. The insert, update and delete
 * restrictives name no role at all, and `tenant_membership`'s `WITH CHECK`
 * carries no escape either — so an escaping reader is still refused every
 * write outside its scope. This asserts that by execution, and it separates
 * the two reasons a write can be refused: `daftar_accounting_internal` holds
 * no `INSERT` at all and is stopped by the grant, `daftar_inventory_internal`
 * holds it and is stopped by the policy.
 */
async function lawEscapeIsReadOnly(c: Client, w: World, rel: Relation): Promise<void> {
  const lines: string[] = [];
  for (const role of ENTITLED_PAST_THE_BUSINESS_BARRIER) {
    // The row it may READ: another business of its own tenant — admitted, and
    // asserted here so the refusals below are known to be about the WRITE.
    const canRead = await readVerdict(c, role, { tenantId: w.A.tenantId, businessId: w.A.businessId }, rel, w.A2.subject[rel]);
    const probe = writeProbe(rel, w.A2, seedUserId);
    const wrote = await asRole(c, role, { tenantId: w.A.tenantId, businessId: w.A.businessId }, () => attempt(c, probe.sql, probe.params));
    const why = wrote.ok ? 'TAKEN' : wrote.message.includes('violates row-level security policy') ? 'refused by the barrier' : 'refused by the grant';
    lines.push(`${role}: reads the other business's row → ${canRead}; writes a row into it → ${why}`);
  }
  expect(lines.join('\n'), `${rel}: a principal on the read escape list used it to WRITE outside its scope`).toBe(
    [
      `${ACCOUNTING_READER}: reads the other business's row → ADMITTED; writes a row into it → refused by the grant`,
      `${WRITER}: reads the other business's row → ADMITTED; writes a row into it → refused by the barrier`,
    ].join('\n'),
  );
}

// ── THE PATHS WHOSE ROW SECURITY IS NOT THE CALLER'S ──────────────────────

/**
 * Every VIEW and MATERIALIZED VIEW in `public` that depends on one of the
 * four relations, with its owner and whether it carries `security_invoker`.
 *
 * A view's row security is evaluated as the view's OWNER unless
 * `security_invoker = true`. A view over `invoices` owned by the schema owner
 * is therefore a path on which NO policy of `invoices` is consulted for the
 * caller at all — and it is a path no law about the policies of `invoices`
 * can see, because there is nothing wrong with those policies.
 */
async function viewSurface(c: Client): Promise<{ relname: string; owner: string; invoker: boolean; appSelect: boolean }[]> {
  const r = await c.query<{ relname: string; owner: string; invoker: boolean; appselect: boolean }>(
    `SELECT c.relname::text AS relname, pg_get_userbyid(c.relowner)::text AS owner,
            coalesce((SELECT o = 'security_invoker=true' FROM unnest(coalesce(c.reloptions, ARRAY[]::text[])) AS t(o) WHERE o LIKE 'security_invoker=%'), false)
              AS invoker,
            has_table_privilege('daftar_app', c.oid, 'SELECT') AS appselect
       FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
        AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class t ON t.oid = d.refobjid
                     WHERE rw.ev_class = c.oid AND d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
                       AND t.relname = ANY ($1::text[]))
      ORDER BY 1`,
    [[...RELATIONS]],
  );
  return r.rows.map((x) => ({ relname: x.relname, owner: x.owner, invoker: x.invoker, appSelect: x.appselect }));
}

/** Every SECURITY DEFINER routine `daftar_app` may execute whose body names one of the four relations. */
async function definerSurface(c: Client): Promise<{ proname: string; owner: string; args: string }[]> {
  const r = await c.query<{ proname: string; owner: string; args: string }>(
    `SELECT p.proname::text AS proname, pg_get_userbyid(p.proowner)::text AS owner,
            (SELECT coalesce(string_agg(format('NULL::%s', format_type(t, NULL)), ', ' ORDER BY ord), '')
               FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)) AS args
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.prosecdef
        AND has_function_privilege('daftar_app', p.oid, 'EXECUTE')
        AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS t(rel) WHERE coalesce(p.prosrc, '') ~ ('\\m' || t.rel || '\\M'))
      ORDER BY 1`,
    [[...RELATIONS]],
  );
  return r.rows;
}

/**
 * THE FOUR COMMANDS, AND WHY THIS SET HAS TO BE CLOSED.
 *
 * Each is SECURITY DEFINER, each is executable by `daftar_app`, and each is
 * owned by a role that `business_isolation_read` NAMES IN ITS ESCAPE LIST. So
 * on these four paths the read barrier admits every row of every business by
 * construction, and what keeps a caller inside its own business is the
 * routine's own gate — a signed assertion, whose business the routine reads
 * out of the assertion and never out of its arguments or the scope GUCs.
 *
 * That is a sound design and it is proved elsewhere. What is NOT proved
 * anywhere is that this set is CLOSED: a fifth routine, SECURITY DEFINER,
 * owned by either internal role, granted to `daftar_app` and carrying no
 * assertion gate, is a complete read bypass of all four relations that no law
 * about the POLICIES could ever see — the policies would be perfect and the
 * data would still be out. The red proof below plants exactly that.
 */
const DEFINER_SURFACE: readonly string[] = [
  'accounting_post_entry owned by daftar_accounting_internal',
  'customer_apply_credit owned by daftar_inventory_internal',
  'customer_collect_payment owned by daftar_inventory_internal',
  'sale_commit owned by daftar_inventory_internal',
];

/**
 * LAW V (THE VIEW SURFACE): no view over any of the four relations exists, so
 * no reader reaches them as somebody else.
 */
async function lawViewSurface(c: Client): Promise<void> {
  const views = await viewSurface(c);
  expect(
    views.map((v) => `${v.relname} owned by ${v.owner} security_invoker=${v.invoker} daftar_app may select=${v.appSelect}`),
    "a view over one of the four relations exists. A view's row security is evaluated as the VIEW'S OWNER unless it carries security_invoker=true, so unless this view is security_invoker AND the owner is subject to the same policies, it is a path on which no policy of the underlying relation is consulted for the caller",
  ).toEqual([]);
}

/**
 * LAW S (THE DEFINER SURFACE IS CLOSED): exactly the four commands are
 * SECURITY DEFINER, executable by the application role and over these
 * relations — and each of them refuses an ungated caller at its own gate,
 * which is where the barrier for those paths actually is.
 */
async function lawDefinerSurface(c: Client, w: World): Promise<void> {
  const fns = await definerSurface(c);
  expect(
    fns.map((f) => `${f.proname} owned by ${f.owner}`),
    'the set of SECURITY DEFINER routines the application role may execute over these four relations has changed. Each one runs as a role the read barrier admits everything to, so a new member is a new read path with no policy behind it',
  ).toEqual([...DEFINER_SURFACE]);

  // AND EACH ONE IS GATED. Called with no assertion at all, every one of them
  // refuses — and the refusal is the ROUTINE's, not the signature's and not
  // the grant's, which is what says the call was admitted and the gate is
  // what stopped it. `42883` would mean the call never resolved and `42501`
  // that the grant stopped it; either would make this leg vacuous.
  const lines: string[] = [];
  for (const f of fns) {
    const r = await asRole(c, READER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, () => attempt(c, `SELECT * FROM ${f.proname}(${f.args})`));
    lines.push(`${f.proname}: ${r.ok ? 'TAKEN' : `refused ${r.code}`}`);
    if (!r.ok) {
      expect(r.code, `${f.proname}: the call never resolved, so its refusal says nothing about the routine's gate`).not.toBe('42883');
      expect(r.code, `${f.proname}: the GRANT refused the call, so its refusal says nothing about the routine's gate`).not.toBe('42501');
    }
  }
  expect(
    lines.filter((l) => l.includes('TAKEN')),
    'a SECURITY DEFINER routine over these relations took an ungated call',
  ).toEqual([]);
}

// ── THE SUITE: PART TWO ───────────────────────────────────────────────────

describe('P4-S4 — the barrier on EVERY path the relation is reachable by', () => {
  for (const rel of RELATIONS) {
    it(`${rel}: on all ${READ_PATHS.length} read paths, another business's row is refused and my own is not — and the owner reaches both`, async () => {
      await inCase(async (c, w) => {
        await lawPaths(c, w, rel);
      });
    }, 600_000);

    it(`${rel}: a PREPARED statement answers with the scope each execution holds, under a forced generic plan as well as a custom one`, async () => {
      await inCase(async (c, w) => {
        await lawGenericPlan(c, w, rel);
      });
    }, 300_000);
  }

  it('the readers of record refuse a cross-business call, and the refusal is told apart from an absence', async () => {
    await inCase(async (c, w) => {
      await lawReadersOfRecord(c, w);
    });
  }, 600_000);

  it('no VIEW over any of the four relations exists, so no reader reaches them as somebody else', async () => {
    const c = await connect();
    try {
      await lawViewSurface(c);
    } finally {
      await c.end();
    }
  }, 120_000);

  it('the SECURITY DEFINER surface over these relations is exactly the four commands, and each refuses an ungated caller at its own gate', async () => {
    await inCase(async (c, w) => {
      await lawDefinerSurface(c, w);
    });
  }, 300_000);
});

describe('P4-S4 — WHO is admitted past the barrier, and WHERE', () => {
  for (const rel of RELATIONS) {
    it(`${rel}: of every principal in the cluster, exactly the two the escape list names read past the business barrier`, async () => {
      await inCase(async (c, w) => {
        await lawEscapeList(c, w, rel);
      });
    }, 300_000);

    it(`${rel}: and their escape is a READ escape — neither may write outside its own business`, async () => {
      await inCase(async (c, w) => {
        await lawEscapeIsReadOnly(c, w, rel);
      });
    }, 300_000);
  }
});

describe('P4-S4 — THE RED PROOFS for the reachability half', () => {
  it('a blanket read barrier leaks on EVERY ONE of the read paths, so no path in the matrix is decorative', async () => {
    await inCase(async (c, w) => {
      for (const rel of RELATIONS) {
        await withPlant(c, rel, [`ALTER POLICY business_isolation_read ON ${rel} USING (true)`], async () => {
          await mustGoRed(`ALTER POLICY business_isolation_read ON ${rel} USING (true)`, `${rel}: the reachability matrix is not the barrier's`, () =>
            lawPaths(c, w, rel),
          );
          // AND EVERY PATH FLIPPED. A law that goes red because ONE of its
          // twenty-one paths saw the attack would leave the other twenty
          // unproven — each of them could be reading nothing for a reason of
          // its own and nobody would know. So the matrix is taken again under
          // the plant and every row is required to have turned.
          const leaked = await reachabilityMatrix(c, w, rel);
          const blind = leaked.filter((r) => !r.otherBusiness).map((r) => r.path);
          expect(blind, `${rel}: these read paths did NOT see the other business's row even with the read barrier removed, so they prove nothing`).toEqual([]);
          record(`a blanket business_isolation_read on ${rel} leaked the other business's row on all ${leaked.length} read paths`);
        });
      }
    });
  }, 900_000);

  it('BOTH read barriers blanket leaks the other TENANT too, on every read path', async () => {
    // The whole read surface lifted at once, which is what `ALTER TABLE …
    // DISABLE ROW LEVEL SECURITY` would be — and that statement cannot be
    // used here: the seeding transaction holds deferred constraint trigger
    // events and PostgreSQL refuses `ALTER TABLE` on a relation with pending
    // ones ("cannot ALTER TABLE \"invoices\" because it has pending trigger
    // events"). Two `ALTER POLICY` statements reach the same state without
    // touching the relation, and `§91`'s ENABLED/FORCED flags have their own
    // law in part one.
    await inCase(async (c, w) => {
      for (const rel of RELATIONS) {
        await withPlant(
          c,
          rel,
          [`ALTER POLICY business_isolation_read ON ${rel} USING (true)`, `ALTER POLICY tenant_membership ON ${rel} USING (true)`],
          async () => {
            await mustGoRed(
              `ALTER POLICY business_isolation_read ON ${rel} USING (true) + ALTER POLICY tenant_membership ON ${rel} USING (true)`,
              `${rel}: the reachability matrix is not the barrier's`,
              () => lawPaths(c, w, rel),
            );
            const leaked = await reachabilityMatrix(c, w, rel);
            const held = leaked.filter((r) => !r.otherBusiness || !r.otherTenant).map((r) => r.path);
            expect(held, `${rel}: these read paths refused a row with BOTH read barriers blanket, which no path should`).toEqual([]);
            record(`both read barriers blanket on ${rel}: all ${leaked.length} read paths leaked the other business AND the other tenant`);
          },
        );
      }
    });
  }, 900_000);

  it('a blanket read barrier makes the readers of record answer a cross-business call, and LAW X refuses it', async () => {
    await inCase(async (c, w) => {
      for (const rel of RELATIONS) await c.query(`ALTER POLICY business_isolation_read ON ${rel} USING (true)`);
      await mustGoRed(
        'ALTER POLICY business_isolation_read ON all four relations USING (true)',
        'a reader of record answered a cross-business call with something',
        () => lawReadersOfRecord(c, w),
      );
    });
  }, 600_000);

  it('a VIEW over the relation hands another business’s rows to the application role, and LAW V names it', async () => {
    await inCase(async (c, w) => {
      const view = `p4s4_view_${randomUUID().replace(/-/g, '')}`;
      const sp = `v_${randomUUID().replace(/-/g, '')}`;
      await c.query(`SAVEPOINT ${sp}`);
      try {
        // A view owned by the schema owner, with no `security_invoker`: the
        // policies of `invoices` are evaluated as the OWNER, who is subject to
        // none of them.
        await c.query(`CREATE VIEW ${view} AS SELECT id, business_id FROM invoices`);
        await c.query(`GRANT SELECT ON ${view} TO ${READER}`);
        const seen = await asRole(c, READER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, async () =>
          (await c.query<{ id: string }>(`SELECT id::text AS id FROM ${view} WHERE id = $1`, [w.A2.subject.invoices])).rows.map((r) => r.id),
        );
        // THE CONSEQUENCE, FIRST: this is not a presence finding dressed up.
        // The row of another business really is handed over.
        expect(seen, 'the planted view did NOT leak, so this red proof would be about nothing').toEqual([w.A2.subject.invoices]);
        // And the reader scoped to its own business sees the OTHER TENANT's
        // rows through it as well, which is the whole relation.
        const everything = await asRole(c, READER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, async () =>
          (await c.query<{ id: string }>(`SELECT id::text AS id FROM ${view} WHERE id = $1`, [w.B.subject.invoices])).rows.map((r) => r.id),
        );
        expect(everything, 'and the planted view reaches across the tenant boundary too').toEqual([w.B.subject.invoices]);
        await mustGoRed(
          `CREATE VIEW ${view} AS SELECT id, business_id FROM invoices (owned by the schema owner, no security_invoker)`,
          'a view over one of the four relations exists',
          () => lawViewSurface(c),
        );
      } finally {
        await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      }
      // And the surface is empty again, so the plant left nothing behind.
      expect(await viewSurface(c), 'the planted view outlived its savepoint').toEqual([]);
    });
  }, 300_000);

  it('a SECURITY DEFINER routine owned by a role on the escape list reads every business, and LAW S names it', async () => {
    await inCase(async (c, w) => {
      const fn = `p4s4_leak_${randomUUID().replace(/-/g, '')}`;
      const sp = `s_${randomUUID().replace(/-/g, '')}`;
      await c.query(`SAVEPOINT ${sp}`);
      try {
        await c.query(
          `CREATE FUNCTION ${fn}(p_business_id uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER
             SET search_path = pg_catalog, public AS $body$ SELECT id FROM invoices WHERE business_id = p_business_id $body$`,
        );
        await c.query(`ALTER FUNCTION ${fn}(uuid) OWNER TO ${WRITER}`);
        await c.query(`GRANT EXECUTE ON FUNCTION ${fn}(uuid) TO ${READER}`);
        // WHAT THE OWNER SEES, so the leak is compared against the whole
        // truth of that business rather than against one id this proof
        // happened to remember.
        const allOf = async (businessId: string): Promise<string[]> =>
          (await c.query<{ id: string }>(`SELECT id::text AS id FROM invoices WHERE business_id = $1 ORDER BY 1`, [businessId])).rows.map((r) => r.id);
        const through = async (businessId: string): Promise<string[]> =>
          asRole(c, READER, { tenantId: w.A.tenantId, businessId: w.A.businessId }, async () =>
            (await c.query<{ id: string }>(`SELECT ${fn}($1)::text AS id`, [businessId])).rows.map((r) => r.id).sort(),
          );
        const theirs = await allOf(w.A2.businessId);
        expect(theirs, 'the other business holds no invoice, so this red proof would be about nothing').not.toEqual([]);
        expect(await through(w.A2.businessId), 'the planted definer routine did NOT leak the other business').toEqual(theirs);
        expect(
          await through(w.B.businessId),
          'and it reaches the other TENANT as well, because its owner is on the escape list and no tenant policy applies to a routine running as that owner',
        ).toEqual(await allOf(w.B.businessId));
        await mustGoRed(
          `CREATE FUNCTION ${fn}(uuid) … SECURITY DEFINER owned by ${WRITER}, granted to ${READER}`,
          'the set of SECURITY DEFINER routines the application role may execute over these four relations has changed',
          () => lawDefinerSurface(c, w),
        );
      } finally {
        await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      }
      expect(
        (await definerSurface(c)).map((f) => `${f.proname} owned by ${f.owner}`),
        'the planted routine outlived its savepoint',
      ).toEqual([...DEFINER_SURFACE]);
    });
  }, 300_000);

  it('a THIRD name on the escape list is admitted, and LAW E names it — but only once the GRANT is there too', async () => {
    await inCase(async (c, w) => {
      const rel: Relation = 'invoices';
      const intruder = 'daftar_worker';
      // The widened qual is WRITTEN, not patched out of the catalogue's own
      // rendering: `current_user IN (…)` renders as `CURRENT_USER = ANY
      // (ARRAY[…::name])`, so a textual substitution of the source spelling
      // finds nothing and plants nothing. `withPlant` asserts the catalogue
      // actually moved, which is what catches a plant that did not land.
      const widened = `(SELECT app_bypass()) OR (SELECT current_user IN ('${WRITER}', '${ACCOUNTING_READER}', '${intruder}')) OR business_id = (SELECT nullif(app_business(), '')::uuid)`;

      // THE POLICY ALONE IS NOT ENOUGH, AND SAYING SO IS PART OF THE
      // EVIDENCE. `daftar_worker` holds no SELECT on these relations, so a
      // name added to the escape list reaches no row until a GRANT is added
      // beside it — and LAW E is therefore SILENT on the policy-only plant.
      // A reviewer who did not know that would read the silence as the law
      // failing to see the attack.
      await withPlant(c, rel, [`ALTER POLICY business_isolation_read ON ${rel} USING (${widened})`], async () => {
        await lawEscapeList(c, w, rel);
        record(
          `the escape list of ${rel}.business_isolation_read widened with '${intruder}' and NO grant: LAW E is silent, because ${intruder} holds no SELECT on ${rel} — the escape is half a path`,
        );
        const sp = `g_${randomUUID().replace(/-/g, '')}`;
        await c.query(`SAVEPOINT ${sp}`);
        try {
          await c.query(`GRANT SELECT ON ${rel} TO ${intruder}`);
          await mustGoRed(
            `ALTER POLICY business_isolation_read ON ${rel} with '${intruder}' on the escape list + GRANT SELECT ON ${rel} TO ${intruder}`,
            `${rel}: some principal is admitted past the business barrier that 0086 does not name`,
            () => lawEscapeList(c, w, rel),
          );
        } finally {
          await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        }
      });
    });
  }, 600_000);

  it('a TENANT escape for the internal reader is admitted on the write side, and LAW E(w) names it', async () => {
    await inCase(async (c, w) => {
      for (const rel of RELATIONS) {
        const check = must(
          (await policyState(c)).find((r) => r.relname === rel && r.polname === 'tenant_membership')?.wc,
          `${rel}.tenant_membership WITH CHECK`,
        );
        // The business restrictive is what refuses the escaping reader's
        // write; lift it and the escape becomes a write escape.
        await withPlant(c, rel, [`ALTER POLICY business_isolation_insert ON ${rel} WITH CHECK (true)`], async () => {
          expect(check, 'the tenant WITH CHECK is untouched by this plant').toBe(
            must((await policyState(c)).find((r) => r.relname === rel && r.polname === 'tenant_membership')?.wc, 'check'),
          );
          await mustGoRed(
            `ALTER POLICY business_isolation_insert ON ${rel} WITH CHECK (true)`,
            `${rel}: a principal on the read escape list used it to WRITE outside its scope`,
            () => lawEscapeIsReadOnly(c, w, rel),
          );
        });
      }
    });
  }, 600_000);
});

// ── THE PERMANENT FOUR-WAY AUTHORITY MATRIX (TL-P4-RLS-INT-01) ────────────

/**
 * THE RULING THIS MATRIX IS THE PERMANENT HOME OF.
 *
 * `TL-P4-RLS-INT-01` holds that the four P4-S4 relations carry FOUR DIFFERENT
 * AUTHORITY MODELS, and that stating them as one sentence — "the relations are
 * tenant-isolated" — is false of three of the four. The matrix below keeps them
 * apart, names each one, and refuses to let any two be restated as each other.
 *
 * THE TWO SEPARATIONS THE MATRIX IS BUILT ON (§13). A principal reaching a row
 * has to pass TWO INDEPENDENT GATES, and they refuse with different voices:
 *
 *   1. THE RLS POLICY — the DISJUNCTION of every applicable PERMISSIVE qual,
 *      AND-ed with every applicable RESTRICTIVE one. Its refusal is SILENT: a
 *      `SELECT` succeeds and hands back zero rows.
 *   2. THE SQL TABLE PRIVILEGE (the ACL) — `has_table_privilege(role, rel,
 *      'SELECT')`. Its refusal is LOUD: SQLSTATE 42501, "permission denied for
 *      table".
 *
 * The ACL is checked FIRST, so when it refuses, the policy's verdict is never
 * observable through a `SELECT` at all. That is the precise trap the Tech Lead
 * named: `daftar_platform` satisfies the FIRST DISJUNCT of both read quals on
 * all four relations, because `app_bypass()` is literally `CURRENT_USER =
 * 'daftar_platform'` — and it still reaches no row, because it holds no
 * privilege on any of them. A POLICY EXPRESSION ALONE DOES NOT GRANT TABLE
 * ACCESS, so a theoretical policy bypass is NOT a usable data path, and this
 * matrix reports it as what it is: REFUSED BY ACL.
 *
 * To say that honestly the matrix measures BOTH HALVES SEPARATELY, per
 * principal and per relation:
 *
 *   - `rlsAdmits*` is computed by EVALUATING THE LIVE QUALS — the exact
 *     expressions `pg_get_expr(polqual, polrelid)` renders, assembled with
 *     PostgreSQL's own PERMISSIVE/RESTRICTIVE algebra and executed AS THE
 *     PRINCIPAL over the subject row's `(tenant_id, business_id)`. It needs no
 *     table privilege, so it answers for a principal the ACL would stop;
 *   - `aclSelect` is the privilege itself;
 *   - the CELL is what a real `SELECT` of a real row did, in a vocabulary that
 *     cannot blur the two refusals (`REFUSED BY RLS POLICY` vs `REFUSED BY
 *     ACL`).
 *
 * THE FOUR CASES, AND WHY THEY CANNOT BE COLLAPSED (§16).
 *
 *   CASE A — the internal NOLOGIN identities `daftar_inventory_internal` and
 *     `daftar_accounting_internal` read EVERY business of EVERY tenant.
 *     This is EXPECTED AND INTENTIONAL. It is the ruling itself. It is not a
 *     defect, not a tolerated exception, and not technical debt: these are
 *     passwordless identities with no login path, reached only by `SET ROLE`
 *     from a principal that already owns the schema, and their cross-tenant
 *     read is granted by a PERMISSIVE policy that is written down in
 *     `pg_policy` and auditable there (`inventory_internal_read` and
 *     `accounting_validator`, both `USING (true)`). PostgreSQL OR-s PERMISSIVE
 *     policies, so a relation's read barrier is the DISJUNCTION of all of them
 *     and these two identities are admitted past both barriers by construction.
 *     The matrix asserts this AS THE INTENDED OUTCOME.
 *   CASE B — `daftar_app`, the runtime login credential the application holds,
 *     in a Tenant A context reading a Tenant B row: DENIED / INVISIBLE, and
 *     denied BY THE POLICY — the `SELECT` succeeds and returns nothing.
 *   CASE C — a Tenant A merchant attempting an operation on a Tenant B object
 *     through a product command. NOT THIS MATRIX'S CASE. It is a different
 *     authority model (an application-level command gate, not a database
 *     barrier), it is owned by another law, and `assertCaseCIsNotOurs` below
 *     asserts this matrix never claims it.
 *   CASE D — `daftar_platform`, where the SELECT privilege DOES NOT EXIST:
 *     REFUSED BY ACL. Specifically by the ACL and NOT by the policy, which
 *     admits it. This is the one row of the matrix where the two gates
 *     disagree, and it is the whole reason the two have to be told apart.
 *
 * A and D are not the same statement; B and D are not the same statement. A is
 * admitted past both barriers; B is refused by the policy with the privilege in
 * hand; D is refused by the privilege with the policy in its favour. The
 * signature arm below asserts those three shapes are PAIRWISE DISTINCT, so no
 * future edit can restate one case in another's words and still pass.
 *
 * WHY THE EXPECTATION IS HAND-WRITTEN AND THE ROSTER IS NOT. The admission set
 * is typed out below by hand. A law that read its expectation out of the policy
 * it judges would move with the attack. The ROSTER, by contrast, is derived
 * from `pg_roles`, so a principal added to the cluster is judged without this
 * law being edited — and every principal the matrix does not name must be
 * refused, with the matrix saying by WHICH gate.
 */
const RULING = 'TL-P4-RLS-INT-01';

/** The platform credential `app_bypass()` names, and CASE D's whole subject. */
const PLATFORM = 'daftar_platform';

/**
 * CASE C, written down so this file's silence about it is DELIBERATE and
 * visible rather than an omission a reader has to notice.
 */
const CASE_C_NOT_OURS =
  'CASE C — a Tenant A merchant attempting an operation on a Tenant B object through a product command — is a COMMAND-GATE authority model, not a database barrier; it is owned by another law and this matrix must never assert it';

/**
 * What one principal's attempt on one relation actually did, in a vocabulary
 * that keeps the two refusals apart. `REFUSED BY RLS POLICY` is a successful
 * `SELECT` that returned nothing; `REFUSED BY ACL` is SQLSTATE 42501 whose text
 * is PostgreSQL's privilege diagnostic.
 */
type Cell = 'ADMITTED' | 'REFUSED BY RLS POLICY' | 'REFUSED BY ACL';

/** One hand-written row of the matrix: a case, a principal, and both gates. */
interface AuthorityRow {
  readonly caseId: 'A' | 'B' | 'D';
  readonly principal: string;
  /** The authority MODEL, which is the thing §16 forbids collapsing. */
  readonly authority: string;
  /** Whether the principal can log in at all — part of why CASE A is intentional. */
  readonly canLogin: boolean;
  /** The TENANT barrier, alone: scope = my tenant + the other tenant's business, subject = that other tenant's row. */
  readonly tenant: Cell;
  /** The BUSINESS barrier, alone: scope = my tenant + my business, subject = another business of my own tenant. */
  readonly business: Cell;
  /** The RLS POLICY's own verdict on each barrier's subject, evaluated from the live quals and NOT inferred from the cell. */
  readonly rlsAdmitsAcrossTheTenant: boolean;
  readonly rlsAdmitsPastTheBusiness: boolean;
  /** The SQL TABLE PRIVILEGE, which is the other half of every path. */
  readonly aclSelect: boolean;
  /** The ruling's verdict on this row, in the words §16 requires. */
  readonly verdict: string;
}

/**
 * THE MATRIX. Written by hand, per barrier, per gate. Changing a cell here is
 * changing the ruling, which is the point: there is one place to do it.
 */
const AUTHORITY_MATRIX: readonly AuthorityRow[] = [
  {
    caseId: 'A',
    principal: WRITER,
    authority: 'internal NOLOGIN identity — no password, no login path, reached only by SET ROLE from the schema owner',
    canLogin: false,
    tenant: 'ADMITTED',
    business: 'ADMITTED',
    rlsAdmitsAcrossTheTenant: true,
    rlsAdmitsPastTheBusiness: true,
    aclSelect: true,
    verdict: `EXPECTED / INTENTIONAL (${RULING}) — admitted by the PERMISSIVE policy inventory_internal_read USING (true), which PostgreSQL OR-s into the read barrier`,
  },
  {
    caseId: 'A',
    principal: ACCOUNTING_READER,
    authority: 'internal NOLOGIN identity — no password, no login path, reached only by SET ROLE from the schema owner',
    canLogin: false,
    tenant: 'ADMITTED',
    business: 'ADMITTED',
    rlsAdmitsAcrossTheTenant: true,
    rlsAdmitsPastTheBusiness: true,
    aclSelect: true,
    verdict: `EXPECTED / INTENTIONAL (${RULING}) — admitted by the PERMISSIVE policy accounting_validator USING (true), which PostgreSQL OR-s into the read barrier`,
  },
  {
    caseId: 'B',
    principal: READER,
    authority: 'runtime login credential — the password the application process holds and a request is served under',
    canLogin: true,
    tenant: 'REFUSED BY RLS POLICY',
    business: 'REFUSED BY RLS POLICY',
    rlsAdmitsAcrossTheTenant: false,
    rlsAdmitsPastTheBusiness: false,
    aclSelect: true,
    verdict: 'DENIED / INVISIBLE — the privilege IS held, the policy refuses, and the refusal is silent: the SELECT succeeds and hands back nothing',
  },
  {
    caseId: 'D',
    principal: PLATFORM,
    authority: 'platform login credential — the one principal app_bypass() names, so the first disjunct of BOTH read quals is satisfied for it',
    canLogin: true,
    tenant: 'REFUSED BY ACL',
    business: 'REFUSED BY ACL',
    rlsAdmitsAcrossTheTenant: true,
    rlsAdmitsPastTheBusiness: true,
    aclSelect: false,
    verdict:
      'REFUSED BY ACL — and specifically by the ACL, not by the policy: the policy ADMITS it and the SQL table privilege does not exist, so the app_bypass() escape is half a path and reaches no row. NOT a usable data path',
  },
];

/** Every principal the matrix names, for the coverage arm. */
const MATRIX_PRINCIPALS: readonly string[] = AUTHORITY_MATRIX.map((r) => r.principal);

/**
 * The derived roster: every non-superuser role in the cluster that is not one
 * of PostgreSQL's own predefined `pg_*` roles. DERIVED, never typed out, so a
 * role added to the cluster is judged here without this law being edited.
 */
async function derivedRoster(c: Client): Promise<string[]> {
  const r = await c.query<{ rolname: string }>(`SELECT rolname::text AS rolname FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\\_%' ORDER BY 1`);
  const roles = r.rows.map((x) => x.rolname);
  expect(roles, 'the role roster is derived from pg_roles and came back empty, so every verdict below would be vacuous').not.toEqual([]);
  expect(roles, 'every principal the hand-written matrix names must be in the DERIVED roster, or the matrix judges a role that does not exist').toEqual(
    expect.arrayContaining([...MATRIX_PRINCIPALS]),
  );
  return roles;
}

/** `rolbypassrls` / `rolcanlogin` for the whole derived roster, as the catalogue holds them now. */
async function roleAttributes(c: Client): Promise<Map<string, { bypassrls: boolean; canLogin: boolean }>> {
  const r = await c.query<{ rolname: string; b: boolean; l: boolean }>(
    `SELECT rolname::text AS rolname, rolbypassrls AS b, rolcanlogin AS l FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\\_%'`,
  );
  return new Map(r.rows.map((x) => [x.rolname, { bypassrls: x.b, canLogin: x.l }]));
}

/**
 * THE RLS HALF, EVALUATED AND NOT READ.
 *
 * PostgreSQL's read decision for `role` on `rel` is
 *
 *     (OR of every applicable PERMISSIVE qual) AND (every applicable
 *     RESTRICTIVE qual)
 *
 * where "applicable" means the policy's command covers `SELECT` (`polcmd` is
 * `*` or `r`) and its role list is either empty — `TO PUBLIC` — or names a role
 * the principal is a member of. This assembles exactly that expression out of
 * the LIVE `pg_get_expr` renderings and executes it AS THE PRINCIPAL over the
 * subject row's two scope columns, supplied by a derived table.
 *
 * It therefore needs NO privilege on the relation, which is the entire reason
 * it exists: it is the only way to observe the policy's verdict for a principal
 * the ACL stops before the policy is ever consulted.
 */
async function rlsAdmits(c: Client, role: string, rel: Relation, scope: Scope, row: { tenantId: string; businessId: string }): Promise<boolean> {
  const policies = (await policyState(c)).filter((p) => p.relname === rel && (p.polcmd === '*' || p.polcmd === 'r') && p.q !== null);
  const membership = new Map(
    (await c.query<{ r: string; m: boolean }>(`SELECT r.rolname::text AS r, pg_has_role($1, r.oid, 'USAGE') AS m FROM pg_roles r`, [role])).rows.map((x) => [
      x.r,
      x.m,
    ]),
  );
  const applies = (roles: readonly string[]): boolean => roles.length === 0 || roles.some((r) => membership.get(r) === true);
  const permissive = policies.filter((p) => p.polpermissive && applies(p.roles)).map((p) => `(${String(p.q)})`);
  const restrictive = policies.filter((p) => !p.polpermissive && applies(p.roles)).map((p) => `(${String(p.q)})`);
  // No applicable PERMISSIVE policy means no row is admitted at all, and
  // asserting that here rather than letting an empty `OR` render as SQL keeps
  // the expression from becoming a syntax error that reads like a refusal.
  if (permissive.length === 0) return false;
  const expr = `(${permissive.join(' OR ')})${restrictive.length > 0 ? ` AND ${restrictive.join(' AND ')}` : ''}`;
  return await asRole(c, role, scope, async () => {
    const r = await c.query<{ admits: boolean | null }>(`SELECT (${expr}) AS admits FROM (SELECT $1::uuid AS tenant_id, $2::uuid AS business_id) AS t`, [
      row.tenantId,
      row.businessId,
    ]);
    // A NULL is not an admission: PostgreSQL treats a qual that is not TRUE as
    // a refusal, so `coalesce(..., false)` is the executor's own rule.
    return must(r.rows[0], `${role}'s policy verdict on ${rel}`).admits === true;
  });
}

/**
 * THE ACL HALF AND THE OBSERVED CELL, told apart by WHICH GATE SPOKE.
 *
 * A `SELECT` that succeeds and returns nothing is the POLICY refusing — RLS
 * filters, it never raises. SQLSTATE 42501 on a `SELECT` is the ACL refusing,
 * and the diagnostic text is required to say so, so a future SQLSTATE reuse
 * cannot be read as a policy refusal.
 */
async function observedCell(c: Client, role: string, scope: Scope, rel: Relation, id: string): Promise<Cell> {
  const r = await asRole(c, role, scope, () => attempt(c, `SELECT id FROM ${rel} WHERE id = $1`, [id]));
  if (r.ok) return r.rows > 0 ? 'ADMITTED' : 'REFUSED BY RLS POLICY';
  if (r.code === '42501' && /permission denied for (table|relation|view)/.test(r.message)) return 'REFUSED BY ACL';
  throw new Error(`${role} reading ${rel} failed in a way the matrix cannot classify as either gate (${r.code}): ${r.message}`);
}

/**
 * THE THREE REOPENING CONDITIONS OF §17, detected from the live cluster rather
 * than from this file's expectations — so the message a failure carries NAMES
 * the condition and the ruling, instead of leaving a reader to work out which
 * of the three moved.
 */
async function reopeningConditions(c: Client, rel: Relation): Promise<string[]> {
  const found: string[] = [];
  const attrs = await roleAttributes(c);
  const internal = [WRITER, ACCOUNTING_READER];
  for (const role of internal) {
    const bypass = attrs.get(role)?.bypassrls === true;
    const active = await asRole(c, role, { tenantId: null, businessId: null }, async () => {
      const r = await c.query<{ a: boolean }>(`SELECT row_security_active($1::regclass) AS a`, [rel]);
      return must(r.rows[0], 'row_security_active').a;
    });
    if (bypass || !active)
      found.push(
        `REOPENING CONDITION 1 — the internal NOLOGIN identity ${role} now bypasses row security altogether (rolbypassrls=${String(bypass)}, row_security_active(${rel})=${String(active)}). CASE A's cross-tenant read is INTENTIONAL only while it is granted by a PERMISSIVE policy that is written down in pg_policy and auditable there; a role attribute is invisible to every policy audit. The ruling ${RULING} is REOPENED`,
      );
  }
  const admittedSomewhere = (await c.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2::regclass, 'SELECT') AS ok`, [PLATFORM, rel])).rows[0];
  if (must(admittedSomewhere, 'platform privilege').ok)
    found.push(
      `REOPENING CONDITION 3 — ${PLATFORM} has acquired the SELECT privilege on ${rel} that it must not hold. app_bypass() already satisfies the first disjunct of BOTH read quals for it, so the half-path of CASE D is now a WHOLE path and the policy escape has become a usable cross-tenant data path. The ruling ${RULING} is REOPENED`,
    );
  return found;
}

/**
 * CONDITION 2 is a BEHAVIOURAL fact about the runtime credential, so it is
 * detected from the cells rather than from the catalogue: if `daftar_app` was
 * admitted past either barrier, a runtime credential can read cross-tenant.
 */
function condition2(cells: { readonly tenant: Cell; readonly business: Cell }): string[] {
  if (cells.tenant === 'ADMITTED' || cells.business === 'ADMITTED')
    return [
      `REOPENING CONDITION 2 — the runtime login credential ${READER} is ADMITTED past a barrier (tenant → ${cells.tenant}; business → ${cells.business}). A credential a request is served under can now read another tenant's rows, which is CASE B inverted and the one outcome ${RULING} never licensed. The ruling ${RULING} is REOPENED`,
    ];
  return [];
}

/** How one row of the matrix renders, so expectation and observation are compared as text a human can read. */
function renderRow(r: {
  caseId: string;
  principal: string;
  authority: string;
  canLogin: boolean;
  tenant: Cell;
  business: Cell;
  rlsAdmitsAcrossTheTenant: boolean;
  rlsAdmitsPastTheBusiness: boolean;
  aclSelect: boolean;
  verdict: string;
}): string {
  return [
    `CASE ${r.caseId} — ${r.principal} (${r.authority}, canLogin=${String(r.canLogin)})`,
    `  TENANT barrier:   cell=${r.tenant} | RLS policy admits=${String(r.rlsAdmitsAcrossTheTenant)} | ACL SELECT=${String(r.aclSelect)}`,
    `  BUSINESS barrier: cell=${r.business} | RLS policy admits=${String(r.rlsAdmitsPastTheBusiness)} | ACL SELECT=${String(r.aclSelect)}`,
    `  verdict: ${r.verdict}`,
  ].join('\n');
}

/**
 * The SIGNATURE of a case: the shape of its authority, with the principal's
 * name and prose stripped out. Two cases with the same signature are the same
 * statement, which is exactly what §16 forbids.
 */
function signature(r: AuthorityRow): string {
  return `tenant=${r.tenant} business=${r.business} rlsT=${String(r.rlsAdmitsAcrossTheTenant)} rlsB=${String(r.rlsAdmitsPastTheBusiness)} acl=${String(r.aclSelect)}`;
}

/**
 * THE NON-COLLAPSE ARM: the three cases this matrix owns are three different
 * statements, and CASE C is not among them.
 *
 * This is a law about the hand-written matrix itself and needs no database: a
 * reviewer who merged CASE B and CASE D into "the other tenant is invisible"
 * would be writing a true sentence and losing the only fact that matters —
 * that B is refused with the privilege in hand and D is refused for want of it.
 */
function assertCasesDoNotCollapse(): void {
  const ids = [...new Set(AUTHORITY_MATRIX.map((r) => r.caseId))].sort();
  expect(ids, `this matrix owns exactly CASES A, B and D. ${CASE_C_NOT_OURS}`).toEqual(['A', 'B', 'D']);
  expect(
    AUTHORITY_MATRIX.map((r) => r.caseId),
    `no row of this matrix may claim CASE C. ${CASE_C_NOT_OURS}`,
  ).not.toContain('C');

  const byCase = new Map<string, Set<string>>();
  for (const r of AUTHORITY_MATRIX) {
    const s = byCase.get(r.caseId) ?? new Set<string>();
    s.add(signature(r));
    byCase.set(r.caseId, s);
  }
  // Within a case the signature is ONE shape: the two internal identities of
  // CASE A hold the same authority, and a day on which they diverge is a day
  // CASE A has become two cases.
  for (const [id, shapes] of byCase)
    expect([...shapes], `CASE ${id} must be ONE authority shape; it now holds more than one, so it is no longer one case (${RULING})`).toHaveLength(1);
  // Across cases the shapes are PAIRWISE DISTINCT.
  const shapes = [...byCase.entries()].map(([id, s]) => `${id}: ${[...s][0] ?? ''}`);
  expect(
    new Set(shapes.map((s) => s.slice(s.indexOf(': ') + 2))).size,
    `CASES A, B and D must be three DIFFERENT statements, and two of them now have the same authority shape, so one has been restated in the other's words (${RULING}):\n${shapes.join('\n')}`,
  ).toBe(3);

  // AND THE TWO SEPARATIONS OF §13, as claims about the matrix's own content:
  // there is a case refused by the POLICY while holding the PRIVILEGE, and a
  // case refused by the PRIVILEGE while the POLICY admits it. If either row
  // disappears, the matrix has stopped proving ACL and RLS separately.
  const b = must(
    AUTHORITY_MATRIX.find((r) => r.caseId === 'B'),
    'CASE B row',
  );
  expect(
    `${b.tenant} acl=${String(b.aclSelect)} rls=${String(b.rlsAdmitsAcrossTheTenant)}`,
    `CASE B is the POLICY refusal: the privilege is held and the policy refuses. Losing that shape loses half of §13's separation (${RULING})`,
  ).toBe('REFUSED BY RLS POLICY acl=true rls=false');
  const d = must(
    AUTHORITY_MATRIX.find((r) => r.caseId === 'D'),
    'CASE D row',
  );
  expect(
    `${d.tenant} acl=${String(d.aclSelect)} rls=${String(d.rlsAdmitsAcrossTheTenant)}`,
    `CASE D is the ACL refusal: the POLICY ADMITS ${PLATFORM} and the SQL table privilege does not exist. A matrix that recorded this as a policy refusal — or as a usable bypass — would be wrong in both directions (${RULING})`,
  ).toBe('REFUSED BY ACL acl=false rls=true');
  const a = AUTHORITY_MATRIX.filter((r) => r.caseId === 'A');
  expect(a.length, `CASE A must name the internal identities it is about (${RULING})`).toBeGreaterThan(1);
  for (const row of a) {
    expect(row.verdict, `CASE A is INTENTIONAL and must be asserted as the intended outcome, never as a tolerated one (${RULING})`).toContain(
      'EXPECTED / INTENTIONAL',
    );
    expect(row.canLogin, `CASE A is intentional partly BECAUSE the identity has no login path; ${row.principal} must be NOLOGIN (${RULING})`).toBe(false);
  }
}

/**
 * THE MATRIX LAW: for one relation, every principal in the DERIVED roster is
 * probed on BOTH barriers and at BOTH gates, and the result must be the
 * hand-written matrix — with every principal the matrix does not name refused,
 * and the matrix saying which gate refused it.
 */
async function lawAuthorityMatrix(c: Client, w: World, rel: Relation): Promise<void> {
  assertCasesDoNotCollapse();
  const roster = await derivedRoster(c);
  const attrs = await roleAttributes(c);

  const inMyScope: Scope = { tenantId: w.A.tenantId, businessId: w.A.businessId };
  const acrossTheTenant: Scope = { tenantId: w.A.tenantId, businessId: w.B.businessId };
  const businessSubject = { tenantId: w.A.tenantId, businessId: w.A2.businessId };
  const tenantSubject = { tenantId: w.tenantB, businessId: w.B.businessId };

  // Non-vacuity: the two subject rows exist, as the owner, before any verdict
  // about seeing them means anything.
  expect(
    await visible(c, rel, [w.A2.subject[rel], w.B.subject[rel]]),
    `${rel}: the matrix's two subject rows must exist, or every refusal below is a refusal about nothing`,
  ).toEqual([w.A2.subject[rel], w.B.subject[rel]].sort());

  const observed: string[] = [];
  const unnamed: string[] = [];
  let readerCells: { tenant: Cell; business: Cell } = { tenant: 'REFUSED BY RLS POLICY', business: 'REFUSED BY RLS POLICY' };

  for (const role of roster) {
    const aclSelect = must(
      (await c.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2::regclass, 'SELECT') AS ok`, [role, rel])).rows[0],
      'acl answer',
    ).ok;
    const tenant = await observedCell(c, role, acrossTheTenant, rel, w.B.subject[rel]);
    const business = await observedCell(c, role, inMyScope, rel, w.A2.subject[rel]);
    const rlsT = await rlsAdmits(c, role, rel, acrossTheTenant, tenantSubject);
    const rlsB = await rlsAdmits(c, role, rel, inMyScope, businessSubject);
    if (role === READER) readerCells = { tenant, business };

    const named = AUTHORITY_MATRIX.find((r) => r.principal === role);
    if (named !== undefined) {
      observed.push(
        renderRow({
          caseId: named.caseId,
          principal: role,
          authority: named.authority,
          canLogin: attrs.get(role)?.canLogin === true,
          tenant,
          business,
          rlsAdmitsAcrossTheTenant: rlsT,
          rlsAdmitsPastTheBusiness: rlsB,
          aclSelect,
          verdict: named.verdict,
        }),
      );
    } else {
      // A principal the matrix does not name. It must be refused on both
      // barriers — and the matrix states WHICH gate did it, because "refused
      // by the ACL while the policy would also refuse" is a different fact
      // from CASE D, where the policy ADMITS and only the ACL refuses.
      unnamed.push(
        `${role}: tenant=${tenant} business=${business} | RLS policy admits tenant=${String(rlsT)} business=${String(rlsB)} | ACL SELECT=${String(aclSelect)}`,
      );
    }
  }

  const diagnosis = [...(await reopeningConditions(c, rel)), ...condition2(readerCells)];
  const why =
    diagnosis.length > 0
      ? `\n\nTHE REOPENING CONDITIONS §17 NAMES, AS THE LIVE CLUSTER NOW STANDS:\n${diagnosis.join('\n')}`
      : `\n\n(None of §17's three reopening conditions is detected, so this is a movement the ruling ${RULING} did not anticipate and it needs a ruling of its own.)`;

  expect(
    observed.join('\n'),
    `THE FOUR-WAY AUTHORITY MATRIX of ${RULING} has MOVED on ${rel}. The four authority models it keeps apart — CASE A the internal NOLOGIN identities (intentional), CASE B the runtime credential (denied by the policy), CASE D ${PLATFORM} (refused by the ACL, not by the policy), and CASE C which is not this matrix's — are no longer as the ruling states them.${why}`,
    // The expectation is rendered in the DERIVED ROSTER's order, not in the
    // order the matrix happens to be typed in: the roster is `pg_roles`
    // alphabetical, and a law that compared two orderings would be red on a
    // correct database for a reason that is not about authority at all.
  ).toBe(
    roster
      .map((role) => AUTHORITY_MATRIX.find((r) => r.principal === role))
      .filter((r): r is AuthorityRow => r !== undefined)
      .map((r) =>
        renderRow({
          caseId: r.caseId,
          principal: r.principal,
          authority: r.authority,
          canLogin: r.canLogin,
          tenant: r.tenant,
          business: r.business,
          rlsAdmitsAcrossTheTenant: r.rlsAdmitsAcrossTheTenant,
          rlsAdmitsPastTheBusiness: r.rlsAdmitsPastTheBusiness,
          aclSelect: r.aclSelect,
          verdict: r.verdict,
        }),
      )
      .join('\n'),
  );

  // THE CLOSURE ARM. Every principal the matrix does not name is refused on
  // both barriers, by the ACL, with the policy refusing it too — which is the
  // row shape that distinguishes an ordinary unprivileged principal from CASE
  // D. A principal that drifts into any other shape joins the matrix or ends
  // the ruling.
  expect(
    unnamed.join('\n'),
    `${rel}: a principal the four-way matrix does not name reached a row, or was refused by a gate the matrix did not expect. ${RULING} names FOUR authority models and this is a fifth.${why}`,
  ).toBe(
    roster
      .filter((role) => !MATRIX_PRINCIPALS.includes(role))
      .map((role) => `${role}: tenant=REFUSED BY ACL business=REFUSED BY ACL | RLS policy admits tenant=false business=false | ACL SELECT=false`)
      .join('\n'),
  );

  // AND THE MECHANISM OF CASE A, asserted as itself: the admission is a POLICY
  // admission. Row security is ACTIVE for both internal identities and neither
  // holds BYPASSRLS, so their cross-tenant read is the auditable PERMISSIVE
  // policy the ruling licenses and not a role attribute no policy audit sees.
  const mechanism: string[] = [];
  for (const role of [ACCOUNTING_READER, WRITER]) {
    const active = await asRole(c, role, inMyScope, async () => {
      const r = await c.query<{ a: boolean }>(`SELECT row_security_active($1::regclass) AS a`, [rel]);
      return must(r.rows[0], 'row_security_active').a;
    });
    mechanism.push(`${role}: rolbypassrls=${String(attrs.get(role)?.bypassrls === true)} row_security_active(${rel})=${String(active)}`);
  }
  expect(mechanism.join('\n'), `${rel}: CASE A is INTENTIONAL only while the internal identities read across tenants BY POLICY. ${why}`).toBe(
    [ACCOUNTING_READER, WRITER].map((role) => `${role}: rolbypassrls=false row_security_active(${rel})=true`).join('\n'),
  );
}

/** A plant on a ROLE attribute, with the catalogue state it must be restored to. */
async function withRolePlant(c: Client, plant: readonly string[], fn: () => Promise<void>): Promise<void> {
  const render = async (): Promise<string> => JSON.stringify([...(await roleAttributes(c))].sort((a, b) => a[0].localeCompare(b[0])));
  const before = await render();
  const sp = `rp_${randomUUID().replace(/-/g, '')}`;
  await c.query(`SAVEPOINT ${sp}`);
  try {
    for (const sql of plant) await c.query(sql);
    if ((await render()) === before) throw new Error(`the role plant changed nothing in pg_authid, so it proves nothing: ${plant.join('; ')}`);
    await fn();
  } finally {
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
  expect(await render(), 'the role attributes are back to the state captured before the plant').toBe(before);
}

/** A plant on a table ACL, with the privilege state it must be restored to. */
async function withGrantPlant(c: Client, rel: Relation, plant: readonly string[], fn: () => Promise<void>): Promise<void> {
  const render = async (): Promise<string> =>
    JSON.stringify(
      (
        await c.query<{ rolname: string; ok: boolean }>(
          `SELECT rolname::text AS rolname, has_table_privilege(oid, $1::regclass, 'SELECT') AS ok
             FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\\_%' ORDER BY 1`,
          [rel],
        )
      ).rows,
    );
  const before = await render();
  const sp = `gp_${randomUUID().replace(/-/g, '')}`;
  await c.query(`SAVEPOINT ${sp}`);
  try {
    for (const sql of plant) await c.query(sql);
    if ((await render()) === before) throw new Error(`the grant plant changed no privilege on ${rel}, so it proves nothing: ${plant.join('; ')}`);
    await fn();
  } finally {
    await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
  expect(await render(), `the SELECT privileges on ${rel} are back to the state captured before the plant`).toBe(before);
}

describe(`P4-S4 — THE PERMANENT FOUR-WAY AUTHORITY MATRIX (${RULING})`, () => {
  it('CASES A, B and D are three DIFFERENT statements, and CASE C is not this matrix to make', () => {
    assertCasesDoNotCollapse();
  });

  for (const rel of RELATIONS) {
    it(`${rel}: of every principal in the cluster, CASE A is INTENTIONAL, CASE B is DENIED by the policy, CASE D is REFUSED BY ACL`, async () => {
      await inCase(async (c, w) => {
        await lawAuthorityMatrix(c, w, rel);
      });
    }, 600_000);
  }
});

describe(`P4-S4 — THE RED PROOFS for the four-way matrix: §17's three reopening conditions (${RULING})`, () => {
  it(`REOPENING CONDITION 1 — an internal NOLOGIN identity gains BYPASSRLS, and the matrix names the condition and ${RULING}`, async () => {
    await inCase(async (c, w) => {
      const rel: Relation = 'invoices';
      // THE REAL CASE, PLANTED. `daftar_inventory_internal` is a principal of
      // the shipped cluster and CASE A is about it; granting it BYPASSRLS is
      // exactly the change §17 says reopens the ruling, because the admission
      // stops being a PERMISSIVE policy a reviewer can read in `pg_policy` and
      // becomes a role attribute no policy audit can see.
      await withRolePlant(c, [`ALTER ROLE ${WRITER} BYPASSRLS`], async () => {
        await mustGoRed(
          `ALTER ROLE ${WRITER} BYPASSRLS (§17 reopening condition 1)`,
          `REOPENING CONDITION 1 — the internal NOLOGIN identity ${WRITER} now bypasses row security altogether`,
          () => lawAuthorityMatrix(c, w, rel),
        );
      });
    });
  }, 600_000);

  it(`REOPENING CONDITION 2 — the runtime credential becomes able to read cross-tenant, and the matrix names the condition and ${RULING}`, async () => {
    await inCase(async (c, w) => {
      const rel: Relation = 'invoices';
      // The TENANT barrier alone, blanketed. Under the scope the matrix reads
      // the tenant cell under — my tenant, the other tenant's business — the
      // RESTRICTIVE business policy already admits the row, so `tenant_membership`
      // is the only thing refusing it and this plant is the minimal change that
      // makes `daftar_app` read another tenant's row. The business barrier is
      // untouched, which is why the two barriers are stated separately.
      await withPlant(c, rel, [`ALTER POLICY tenant_membership ON ${rel} USING ((SELECT app_bypass()) OR tenant_id IS NOT NULL)`], async () => {
        await mustGoRed(
          `ALTER POLICY tenant_membership ON ${rel} USING ((SELECT app_bypass()) OR tenant_id IS NOT NULL) (§17 reopening condition 2)`,
          `REOPENING CONDITION 2 — the runtime login credential ${READER} is ADMITTED past a barrier`,
          () => lawAuthorityMatrix(c, w, rel),
        );
      });
    });
  }, 600_000);

  it(`REOPENING CONDITION 3 — ${PLATFORM} acquires the SELECT it must not hold, and the half-path of CASE D becomes a whole one`, async () => {
    await inCase(async (c, w) => {
      const rel: Relation = 'invoices';
      // THE §13 TRAP, MADE REAL. Nothing about the POLICY changes here: every
      // qual on `invoices` is byte-identical before and after, and
      // `app_bypass()` was already true for `daftar_platform`. The ONLY change
      // is the SQL table privilege — the other half of the path — and the
      // matrix flips CASE D from REFUSED BY ACL to ADMITTED on BOTH barriers.
      // That is the proof that the matrix's CASE D row is a claim about the
      // ACL and not a restatement of the policy.
      const qualsBefore = JSON.stringify((await policyState(c)).filter((p) => p.relname === rel));
      await withGrantPlant(c, rel, [`GRANT SELECT ON ${rel} TO ${PLATFORM}`], async () => {
        expect(
          JSON.stringify((await policyState(c)).filter((p) => p.relname === rel)),
          'this plant must change the ACL and NOTHING about the policy, or it is not a proof about the ACL',
        ).toBe(qualsBefore);
        await mustGoRed(
          `GRANT SELECT ON ${rel} TO ${PLATFORM} — the policy untouched (§17 reopening condition 3)`,
          `REOPENING CONDITION 3 — ${PLATFORM} has acquired the SELECT privilege on ${rel} that it must not hold`,
          () => lawAuthorityMatrix(c, w, rel),
        );
      });
    });
  }, 600_000);

  it('the matrix cannot be satisfied by collapsing CASE B and CASE D into one statement', async () => {
    // A LAW ABOUT THE LAW. §16 forbids restating one case in another's words,
    // and the way that happens in practice is a reviewer noticing that both
    // CASE B and CASE D "cannot see the other tenant" and writing one row for
    // both. This plants that edit on a copy of the matrix and shows the
    // non-collapse arm refusing it.
    const collapsed: AuthorityRow[] = AUTHORITY_MATRIX.map((r) =>
      r.caseId === 'D'
        ? {
            ...r,
            tenant: 'REFUSED BY RLS POLICY',
            business: 'REFUSED BY RLS POLICY',
            aclSelect: true,
            rlsAdmitsAcrossTheTenant: false,
            rlsAdmitsPastTheBusiness: false,
          }
        : r,
    );
    const shapes = new Set(collapsed.filter((r) => r.caseId === 'B' || r.caseId === 'D').map((r) => signature(r)));
    expect(shapes.size, 'CASE D restated in CASE B’s words must become indistinguishable from it — that is what makes the non-collapse arm necessary').toBe(1);
    const live = new Set(AUTHORITY_MATRIX.filter((r) => r.caseId === 'B' || r.caseId === 'D').map((r) => signature(r)));
    expect(live.size, `as shipped, CASE B and CASE D are two different statements (${RULING})`).toBe(2);
    record(
      `CASE D restated as CASE B ("the other tenant is invisible", privilege held, policy refusing) collapses the two signatures to one; the shipped matrix keeps them at two, and the non-collapse arm of ${RULING} refuses the collapsed form`,
    );
  });
});

/** Every red proof this file executed, printed once at the end so the evidence is in one place. */
afterAll(() => {
  if (redProofs.length > 0) console.log(`\n  ${redProofs.length} RED PROOF(S) EXECUTED:\n${redProofs.map((l, i) => `   ${i + 1}. ${l}`).join('\n')}\n`);
});
