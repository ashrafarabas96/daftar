import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool } from '../../helpers/test-app';

/**
 * GOLDEN REGRESSION — GOLD-30 / G-03: CROSS-BUSINESS LINKAGE IS NOT
 * REPRESENTABLE (docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-09, P4-AL-43
 * scenario 8; the `composite-fk` check of scripts/phase4-s1-gate.ts).
 *
 * P4-AL-09: "Every reference between two commercial rows is a composite
 * foreign key that includes `business_id`, so cross-business linkage is not
 * representable in the database." This suite proves that sentence in the only
 * way it can be proved — BY TRYING IT. Every case below writes real rows and
 * then attempts the cross-business binding as the OWNER of the tables, the
 * most privileged principal that reaches them, and requires the database
 * itself to refuse.
 *
 * Why the owner and not `daftar_app`. `daftar_app` holds no DML on any Phase 4
 * relation (P4-AL-38), so a refusal in its hands would be a refusal by
 * PRIVILEGE and would say nothing about whether the link is expressible.
 * Asking as the owner removes privilege from the question and leaves only the
 * constraint. That is the whole difference between "nobody is allowed to do
 * this today" and "this cannot be written down", and only the second survives
 * a slice that adds a writer.
 *
 * Every case runs inside a transaction that is ALWAYS ROLLED BACK, so this
 * suite writes nothing and needs no `resetData()` — which also means it does
 * not disturb any suite running beside it.
 *
 * WHAT THIS SUITE DOES NOT DO. It asserts nothing about privilege, about RLS
 * (GOLD-20 owns that) or about the accounting binding. And it does not assert
 * the Phase 4 relation set: a later slice adds relations, and a suite that
 * pinned today's five would be a claim about the phase that follows it
 * (P4-AL-88).
 */

/** The five relations 0075 creates. Derived where it matters, listed only as this suite's own subject. */
const S1_RELATIONS: readonly string[] = ['customers', 'customer_contacts', 'invoices', 'invoice_items', 'invoice_sequences'];

interface Fixture {
  readonly tenantId: string;
  readonly businessId: string;
  readonly branchId: string;
  readonly productId: string;
  readonly userId: string;
  readonly customerId: string;
  readonly invoiceId: string;
}

const DIGEST = 'b'.repeat(64);

async function one<T extends Record<string, unknown>>(c: PoolClient, sql: string, params: unknown[] = []): Promise<T> {
  const r = await c.query<T>(sql, params);
  const row = r.rows[0];
  if (row === undefined) throw new Error(`fixture returned no row: ${sql}`);
  return row;
}

/** A tenant, a business, a branch, a product, a user, a customer and one invoice — all inside `c`'s transaction. */
async function seed(c: PoolClient, label: string): Promise<Fixture> {
  const tenantId = (await one<{ id: string }>(c, `INSERT INTO tenants DEFAULT VALUES RETURNING id`)).id;
  const userId = (
    await one<{ id: string }>(c, `INSERT INTO users (email, password_hash, display_name, preferred_locale) VALUES ($1, 'x', $2, 'en') RETURNING id`, [
      `gold30-${label}-${randomUUID().slice(0, 8)}@example.test`,
      `GOLD30 ${label}`,
    ])
  ).id;
  const businessId = (
    await one<{ id: string }>(
      c,
      `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
       VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
      [tenantId, `GOLD30 ${label}`, `gold30-${label}-${randomUUID().slice(0, 8)}`],
    )
  ).id;
  const branchId = (await one<{ id: string }>(c, `INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]))
    .id;
  const productId = randomUUID();
  await c.query(`INSERT INTO products (business_id, id, base_price_minor, price_currency) VALUES ($1, $2, 1000, 'ILS')`, [businessId, productId]);
  const customerId = randomUUID();
  await c.query(
    `INSERT INTO customers (tenant_id, business_id, id, name, status, revision, create_intent_sha256, last_intent_sha256,
                            business_transaction_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'active', 1, $5, $5, $6, $7, $7)`,
    [tenantId, businessId, customerId, `Customer ${label}`, DIGEST, randomUUID(), userId],
  );
  const invoiceId = randomUUID();
  await c.query(
    `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq,
                           period, issue_date, currency_code, status, subtotal_txn_minor, discount_txn_minor, tax_minor,
                           total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                           customer_name_snapshot, issue_intent_sha256, business_transaction_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'invoice', $7, 1, '2026', DATE '2026-03-14', 'ILS', 'draft', 1000, 0, 0, 1000, 1000, 1,
             'base', TIMESTAMPTZ '2026-03-14T09:15:00Z', $8, $9, $10, $11)`,
    [tenantId, businessId, invoiceId, randomUUID(), customerId, branchId, `INV-2026-${label}`, `Customer ${label}`, DIGEST, randomUUID(), userId],
  );
  return { tenantId, businessId, branchId, productId, userId, customerId, invoiceId };
}

type Outcome = { ok: true } | { ok: false; sqlstate: string; constraint: string; message: string };

/** One statement inside a savepoint, so a refusal does not poison the transaction. */
async function attempt(c: PoolClient, sql: string, params: unknown[]): Promise<Outcome> {
  await c.query('SAVEPOINT probe');
  try {
    await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT probe');
    return { ok: true };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    const err = e as { code?: unknown; constraint?: unknown; message?: unknown };
    return {
      ok: false,
      sqlstate: typeof err.code === 'string' ? err.code : '',
      constraint: typeof err.constraint === 'string' ? err.constraint : '',
      message: typeof err.message === 'string' ? err.message : String(e),
    };
  }
}

/** A refusal by the NAMED constraint, never merely "it failed". */
function refusedBy(o: Outcome, sqlstate: string, constraint: string): void {
  if (o.ok) throw new Error(`expected ${constraint} (${sqlstate}) to refuse this, but it succeeded`);
  expect({ sqlstate: o.sqlstate, constraint: o.constraint }, o.message).toEqual({ sqlstate, constraint });
}

/**
 * Every foreign key on `relations` whose PARENT is itself business-scoped and
 * which does NOT name `business_id` on both sides. Read from `pg_constraint`,
 * so it is a statement about the database and not about the migration text.
 */
export async function singleColumnSeams(c: PoolClient, relations: readonly string[]): Promise<string[]> {
  const r = await c.query<{ v: string }>(
    `SELECT c.conrelid::regclass::text || '.' || c.conname AS v
       FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest($1::text[]) x)
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'business_id' AND a.attnum > 0 AND NOT a.attisdropped)
        AND NOT (
              (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.conrelid  AND a.attname = 'business_id') = ANY (c.conkey)
          AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'business_id') = ANY (c.confkey)
        )
      ORDER BY 1`,
    [[...relations]],
  );
  return r.rows.map((x) => x.v);
}

/** Every foreign key on `relations` that nobody validated. */
export async function unvalidated(c: PoolClient, relations: readonly string[]): Promise<string[]> {
  const r = await c.query<{ v: string }>(
    `SELECT c.conrelid::regclass::text || '.' || c.conname AS v
       FROM pg_constraint c
      WHERE c.contype IN ('f', 'c')
        AND c.conrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest($1::text[]) x)
        AND NOT c.convalidated
      ORDER BY 1`,
    [[...relations]],
  );
  return r.rows.map((x) => x.v);
}

beforeAll(async () => {
  await ensurePostgres();
}, 120_000);

/** Runs `body` against two seeded businesses of two different tenants, then rolls everything back. */
async function withTwoBusinesses(body: (c: PoolClient, A: Fixture, B: Fixture) => Promise<void>): Promise<void> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    const A = await seed(c, 'a');
    const B = await seed(c, 'b');
    expect(A.tenantId).not.toBe(B.tenantId);
    await body(c, A, B);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

describe('the catalogue: no single-column seam, and nothing left unvalidated', () => {
  it('every FK to a business-scoped parent names business_id on BOTH sides', async () => {
    const c = await ownerPool().connect();
    try {
      const seams = await singleColumnSeams(c, S1_RELATIONS);
      expect(seams, 'a single-column seam can bind one business’s row to another business’s parent').toEqual([]);
      // The emptiness is not the emptiness of an empty subject: there really
      // are composite FKs here to have found.
      const composite = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint c
          WHERE c.contype = 'f' AND c.conrelid = ANY (SELECT ('public.' || x)::regclass FROM unnest($1::text[]) x)
            AND (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'business_id') = ANY (c.conkey)`,
        [[...S1_RELATIONS]],
      );
      expect(Number(composite.rows[0]?.n ?? '0')).toBeGreaterThanOrEqual(8);
    } finally {
      c.release();
    }
  });

  it('no constraint on any of the five is NOT VALID — a constraint nobody validated protects none of the rows already there', async () => {
    const c = await ownerPool().connect();
    try {
      expect(await unvalidated(c, S1_RELATIONS)).toEqual([]);
    } finally {
      c.release();
    }
  });
});

describe('performed: the database refuses every cross-business binding, asked as the table owner', () => {
  it('an invoice cannot name another business’s customer', async () => {
    await withTwoBusinesses(async (c, A, B) => {
      // ALLOW: A's own customer. The same statement, one id changed, is the
      // DENY — so the refusal is the composite seam and not a broken insert.
      const own = await attempt(
        c,
        `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq,
                               period, issue_date, currency_code, status, subtotal_txn_minor, discount_txn_minor, tax_minor,
                               total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                               customer_name_snapshot, issue_intent_sha256, business_transaction_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'invoice', 'INV-2026-OWN', 2, '2026', DATE '2026-03-15', 'ILS', 'draft', 1000, 0, 0, 1000, 1000, 1,
                 'base', TIMESTAMPTZ '2026-03-15T09:15:00Z', 'Snapshot', $7, $8, $9)`,
        [A.tenantId, A.businessId, randomUUID(), randomUUID(), A.customerId, A.branchId, DIGEST, randomUUID(), A.userId],
      );
      expect(own.ok, own.ok ? '' : own.message).toBe(true);

      const foreign = await attempt(
        c,
        `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq,
                               period, issue_date, currency_code, status, subtotal_txn_minor, discount_txn_minor, tax_minor,
                               total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                               customer_name_snapshot, issue_intent_sha256, business_transaction_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'invoice', 'INV-2026-FOREIGN', 3, '2026', DATE '2026-03-15', 'ILS', 'draft', 1000, 0, 0, 1000, 1000, 1,
                 'base', TIMESTAMPTZ '2026-03-15T09:15:00Z', 'Snapshot', $7, $8, $9)`,
        [A.tenantId, A.businessId, randomUUID(), randomUUID(), B.customerId, A.branchId, DIGEST, randomUUID(), A.userId],
      );
      refusedBy(foreign, '23503', 'invoices_customer_fk');
    });
  });

  it('an invoice cannot name another business’s branch', async () => {
    await withTwoBusinesses(async (c, A, B) => {
      const foreign = await attempt(
        c,
        `INSERT INTO invoices (tenant_id, business_id, id, sale_id, customer_id, branch_id, document_kind, document_number, number_seq,
                               period, issue_date, currency_code, status, subtotal_txn_minor, discount_txn_minor, tax_minor,
                               total_txn_minor, total_base_minor, source_to_base_rate, rate_source, rate_timestamp,
                               customer_name_snapshot, issue_intent_sha256, business_transaction_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'invoice', 'INV-2026-BRANCH', 4, '2026', DATE '2026-03-15', 'ILS', 'draft', 1000, 0, 0, 1000, 1000, 1,
                 'base', TIMESTAMPTZ '2026-03-15T09:15:00Z', 'Snapshot', $7, $8, $9)`,
        [A.tenantId, A.businessId, randomUUID(), randomUUID(), A.customerId, B.branchId, DIGEST, randomUUID(), A.userId],
      );
      refusedBy(foreign, '23503', 'invoices_branch_fk');
    });
  });

  it('an invoice line cannot hang from another business’s invoice, nor name another business’s product', async () => {
    await withTwoBusinesses(async (c, A, B) => {
      const line = (invoiceId: string, productId: string, businessId: string, tenantId: string): [string, unknown[]] => [
        `INSERT INTO invoice_items (tenant_id, business_id, invoice_id, id, line_no, product_id, name_snapshot, quantity,
                                    unit_price_txn_minor, gross_txn_minor, discount_txn_minor, net_txn_minor, tax_minor, base_share_minor)
         VALUES ($1, $2, $3, $4, $5, $6, 'Snapshot', 1.0000, 1000, 1000, 0, 1000, 0, 1000)`,
        [tenantId, businessId, invoiceId, randomUUID(), Math.floor(Math.random() * 100000) + 1, productId],
      ];

      const own = await attempt(c, ...line(A.invoiceId, A.productId, A.businessId, A.tenantId));
      expect(own.ok, own.ok ? '' : own.message).toBe(true);

      // B's invoice under A's business: the parent key (business_id, invoice_id)
      // does not exist, which is exactly what the composite seam buys.
      refusedBy(await attempt(c, ...line(B.invoiceId, A.productId, A.businessId, A.tenantId)), '23503', 'invoice_items_invoice_fk');
      refusedBy(await attempt(c, ...line(A.invoiceId, B.productId, A.businessId, A.tenantId)), '23503', 'invoice_items_product_fk');
    });
  });

  it('a contact cannot hang from another business’s customer', async () => {
    await withTwoBusinesses(async (c, A, B) => {
      const contact = (customerId: string): [string, unknown[]] => [
        `INSERT INTO customer_contacts (tenant_id, business_id, customer_id, id, contact_no, name, business_transaction_id, created_by)
         VALUES ($1, $2, $3, $4, $5, 'Contact', $6, $7)`,
        [A.tenantId, A.businessId, customerId, randomUUID(), Math.floor(Math.random() * 100000) + 1, randomUUID(), A.userId],
      ];
      const own = await attempt(c, ...contact(A.customerId));
      expect(own.ok, own.ok ? '' : own.message).toBe(true);
      refusedBy(await attempt(c, ...contact(B.customerId)), '23503', 'customer_contacts_customer_fk');
    });
  });

  it('no relation of the five can claim a business of another tenant — the mandatory tenant seam', async () => {
    await withTwoBusinesses(async (c, A, B) => {
      // A's tenant with B's business: the (tenant_id, business_id) pair names
      // no row of `businesses`, which is why P4-AL-09 can call MATCH SIMPLE
      // safe — business_id is INDEPENDENTLY constrained on every one of these
      // relations over two NOT NULL columns.
      const mismatched = await attempt(
        c,
        `INSERT INTO customers (tenant_id, business_id, id, name, status, revision, create_intent_sha256, last_intent_sha256,
                                business_transaction_id, created_by, updated_by)
         VALUES ($1, $2, $3, 'Mismatched', 'active', 1, $4, $4, $5, $6, $6)`,
        [A.tenantId, B.businessId, randomUUID(), DIGEST, randomUUID(), A.userId],
      );
      refusedBy(mismatched, '23503', 'customers_tenant_fk');

      const seqMismatch = await attempt(
        c,
        `INSERT INTO invoice_sequences (tenant_id, business_id, document_kind, period, number_format)
         VALUES ($1, $2, 'invoice', '2026', 'INV-{YYYY}-{SEQ:5}')`,
        [A.tenantId, B.businessId],
      );
      refusedBy(seqMismatch, '23503', 'invoice_sequences_tenant_fk');
    });
  });

  it('the composite parent cannot be pulled out from under a child: ON DELETE RESTRICT holds', async () => {
    await withTwoBusinesses(async (c, A) => {
      await attempt(
        c,
        `INSERT INTO invoice_items (tenant_id, business_id, invoice_id, id, line_no, product_id, name_snapshot, quantity,
                                    unit_price_txn_minor, gross_txn_minor, discount_txn_minor, net_txn_minor, tax_minor, base_share_minor)
         VALUES ($1, $2, $3, $4, 1, $5, 'Snapshot', 1.0000, 1000, 1000, 0, 1000, 0, 1000)`,
        [A.tenantId, A.businessId, A.invoiceId, randomUUID(), A.productId],
      );
      // An invoice is not deletable at all (P4-AL-10), so the guard answers
      // before the FK does. Both refusals are the point: the link cannot be
      // broken from either end.
      const del = await attempt(c, `DELETE FROM invoices WHERE business_id = $1 AND id = $2`, [A.businessId, A.invoiceId]);
      expect(del.ok).toBe(false);
      if (!del.ok) expect(del.message).toMatch(/invoice\.not_deletable/);

      const delCustomer = await attempt(c, `DELETE FROM customers WHERE business_id = $1 AND id = $2`, [A.businessId, A.customerId]);
      expect(delCustomer.ok).toBe(false);
      if (!delCustomer.ok) expect(delCustomer.message).toMatch(/customer\.not_deletable/);
    });
  });
});

/**
 * The red proofs for both halves of this law live in
 * `tests/guards/phase4-composite-seam-guard.test.ts` (RP-FK), because a
 * planted defect belongs with the other planted defects and because the live
 * half's plant needs a relation this suite must not create. That file imports
 * `singleColumnSeams` and `unvalidated` from HERE, so the function it plants
 * against is the same function this suite asserts with — a red proof against a
 * copy of the rule proves the copy.
 */
