import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDb, type ScratchDb } from '../../helpers/scratch-db';
import { ensurePostgres, ownerPool } from '../../helpers/test-app';

/**
 * GOLDEN REGRESSION — G-07 / GOLD-48: INVOICE SEQUENCE ISOLATION
 * (`0075_phase4_customers_invoices_numbering.sql`;
 * docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-31, P4-AL-32, D-10, TL-P4-S1-C9).
 *
 * A legal document number is not a convenience key. It is the record: there is
 * no rebuild that can recompute it, so the shape that allocates it has to be
 * right the first time and has to stay right through every later slice. This
 * suite is the standing proof of three things that 0075 decided and that no
 * migration after it may quietly undo.
 *
 *   1. THE ALLOCATION FORM. The ordinal is `max + 1` taken under the
 *      `invoice_sequences` row's lock and backed by a real `UNIQUE`
 *      (P4-AL-31). There is therefore NO counter column anywhere on the
 *      sequence relation and NO PostgreSQL sequence behind any of it. The
 *      three reasons are the lock's own (R-P4-03, `0075:60-66`): a stored
 *      counter is a derived number and so a second truth; a PostgreSQL
 *      sequence is non-transactional and leaves gaps on rollback, which a
 *      legal document number may not have; and a counter column takes the
 *      SAME lock as `max + 1`, so it buys no concurrency whatever — it only
 *      adds a value that can disagree with the rows it claims to count.
 *      `D-10` records that `DATA_MODEL.md` §14أ once specified
 *      `invoice_sequences.current_value BIGINT`; that column is exactly what
 *      `counterColumns` below exists to find if anybody ever adds it back.
 *
 *   2. THE PERIOD GRANULARITY IS YEARLY (TL-P4-S1-C9). The ordinal restarts
 *      at 1 for each calendar year of the issue date, per business and per
 *      document kind, so the key is `(business_id, document_kind, period)`
 *      with `period` the four-digit year. Gaplessness holds WITHIN a period,
 *      and the year is part of the rendered number, so two documents in
 *      different years never collide. The suite proves both halves: that a
 *      re-used ordinal inside one period is refused, and that the same
 *      ordinal in the next period is accepted.
 *
 *   3. PER-BUSINESS ISOLATION IS STRUCTURAL, which is the whole point of
 *      GOLD-48. The sequence row's key includes `business_id` and so does
 *      every unique that carries a number, so two businesses of ONE tenant
 *      hold two independent series and no tenant-level mixing is expressible
 *      (P4-AL-31, `0075:283-287`). A series scoped to the tenant rather than
 *      to the business is not a stricter or looser policy — it is a different
 *      and wrong document register, and the two businesses would silently
 *      share one run of numbers.
 *
 * ── PERFORMED, NOT READ ────────────────────────────────────────────────────
 *
 * A catalogue read alone would prove that the constraints are spelled as
 * intended, not that they behave as intended. So the isolation, the
 * collision, the year restart and the period/issue-date agreement are all
 * carried out as real INSERTs against a throwaway database built from the
 * real migration files by `createScratchDb`. Two businesses of one tenant are
 * seeded and both are given `number_seq = 1` for the same kind and the same
 * period: that INSERT must SUCCEED, and its success is the proof the series
 * are independent. Only then is the duplicate inside one business attempted,
 * and required to be refused with SQLSTATE 23505 naming `invoices_number_uq`.
 *
 * ── WHY IT IS WORTH A SUITE OF ITS OWN ─────────────────────────────────────
 *
 * Every other Phase 4 suite can pass while the numbering is wrong. The RLS
 * suite reads policies, the authority suite reads grants, the money suites
 * read journals — none of them would notice a UNIQUE that had lost
 * `business_id`, because nothing in P4-S1 can write an invoice yet, so
 * nothing would collide and nothing would go red. The defect would surface in
 * P4-S2, in production, as two businesses of one tenant sharing one document
 * register. This suite is the only thing standing in front of that, and the
 * red proofs below are why it can be believed: a golden that is green because
 * the schema happens to be right proves nothing, so each law is exercised
 * against a relation planted to break it.
 *
 * ── WHAT THIS SUITE DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * It does not touch the shared `daftar` database with anything but SELECT: no
 * `resetData()`, no row written, because other suites run against that
 * database and a truncate would destroy their run. Every INSERT here lands in
 * a scratch database of this suite's own.
 *
 * It does not prove AUTHORITY. P4-S1 grants no DML to any runtime principal
 * on the five Phase 4 relations (`0075:494-495`: `daftar_app` and
 * `daftar_inventory_internal` hold SELECT and nothing else), so the inserts
 * below necessarily run as the scratch database's owner/superuser, which
 * bypasses row security altogether. That is stated plainly rather than worked
 * around: this suite proves the CONSTRAINTS — the keys, the uniques and the
 * CHECK — and says nothing about who may write. Who may write is the P4-S1
 * grant and RLS suite's subject, and it is not weakened by being absent here.
 *
 * It does not prove CONCURRENCY. That two transactions racing for `max + 1`
 * serialise correctly under the sequence row's lock is P4-AL-32's ordering
 * claim and belongs to the concurrency suite (execution-plan scenario 2). What
 * is proved here is the thing that makes such a race safe at all: the UNIQUE
 * that catches the loser.
 *
 * It does not read the migration file. The live catalogue is the policy
 * (R-P4-08): every claim below is read from `pg_index`, `pg_constraint`,
 * `pg_attribute`, `pg_attrdef`, `pg_class` or `pg_depend`, never from the SQL
 * that wrote them.
 */

// ───────────────────────────────────────────────────────────────────────────
// The laws, as functions over a Queryable.
//
// Each law is a function and not SQL inlined in an `it()` body ON PURPOSE:
// the same function has to be pointable at a planted relation in a scratch
// database, or the red proofs below could not exist and the law would be
// unfalsifiable.
// ───────────────────────────────────────────────────────────────────────────

/** Anything that can run a parameterised query: a pool on any database. */
export interface Queryable {
  readonly query: Pool['query'];
}

/**
 * The primary-key columns of `relation`, in key order, read by joining
 * `pg_constraint` to `pg_index` — the constraint names the key, the index is
 * the thing that enforces it, and a claim about one that is not true of the
 * other is not a key at all.
 */
async function primaryKeyColumns(q: Queryable, relation: string): Promise<string[]> {
  const { rows } = await q.query<{ attname: string }>(
    `SELECT a.attname
       FROM pg_constraint c
       JOIN pg_index i ON i.indexrelid = c.conindid AND i.indrelid = c.conrelid
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(att, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att
      WHERE c.conrelid = $1::regclass AND c.contype = 'p' AND i.indisunique AND i.indisprimary
      ORDER BY k.ord`,
    [relation],
  );
  return rows.map((r) => r.attname);
}

/** Every live column of `relation`, in attribute order, from `pg_attribute`. */
async function columnNames(q: Queryable, relation: string): Promise<string[]> {
  const { rows } = await q.query<{ attname: string }>(
    `SELECT a.attname
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [relation],
  );
  return rows.map((r) => r.attname);
}

/**
 * The name tokens that mark a stored count. `seq` is listed as a token rather
 * than a substring on purpose: `number_seq` on `invoices` is the ordinal OF a
 * document and belongs there, while a bare `seq`, `next_seq` or `seq_value` on
 * the SEQUENCE relation would be the count of documents — the second truth
 * P4-AL-31 refuses. `current` is here because `current_value` is the exact
 * column `DATA_MODEL.md` §14أ once specified and `D-10` struck out.
 */
const COUNTER_TOKENS: readonly string[] = ['next', 'current', 'counter', 'last', 'seq'];

/** Whether a column name suggests a stored counter, by whole name token. */
function looksLikeCounter(column: string): boolean {
  return column.split('_').some((token) => COUNTER_TOKENS.includes(token));
}

/**
 * Every column of `relation` whose name suggests a counter. The column list is
 * DERIVED from `pg_attribute` rather than compared against a written-out
 * expectation, so a counter added under a name nobody thought of today is
 * still caught tomorrow as long as it reads like a counter.
 */
async function counterColumns(q: Queryable, relation: string): Promise<string[]> {
  return (await columnNames(q, relation)).filter(looksLikeCounter);
}

/** A breach of the no-sequence law (R-P4-03), named so a failure is diagnosable. */
interface SequenceViolation {
  readonly kind: 'sequence_relation' | 'nextval_default';
  readonly detail: string;
}

/**
 * Every way a PostgreSQL sequence could be standing behind `relations`:
 *
 *   - a relation of kind `S` in `pg_class` that DEPENDS on one of them
 *     (`pg_depend`), which is what `serial`, `bigserial` and an identity
 *     column all leave behind; and
 *   - a column default that calls `nextval(`, read out of `pg_attrdef` with
 *     `pg_get_expr` — which catches a hand-made sequence wired to a column
 *     without any ownership dependency at all.
 *
 * Both halves are needed: the first alone misses a detached sequence, the
 * second alone misses a sequence attached but not yet defaulted.
 */
async function sequenceLawViolations(q: Queryable, relations: readonly string[]): Promise<SequenceViolation[]> {
  const owned = await q.query<{ seq: string; rel: string; col: string | null }>(
    `SELECT s.relname AS seq, t.relname AS rel, a.attname AS col
       FROM pg_class s
       JOIN pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid
       JOIN pg_class t ON t.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
       LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE s.relkind = 'S' AND sn.nspname = 'public' AND t.relname = ANY($1::text[])`,
    [relations as string[]],
  );
  const defaults = await q.query<{ rel: string; col: string; def: string }>(
    `SELECT c.relname AS rel, a.attname AS col, pg_get_expr(ad.adbin, ad.adrelid) AS def
       FROM pg_attrdef ad
       JOIN pg_class c ON c.oid = ad.adrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%nextval(%'`,
    [relations as string[]],
  );
  return [
    ...owned.rows.map((r): SequenceViolation => ({ kind: 'sequence_relation', detail: `${r.seq} -> ${r.rel}.${r.col ?? '(table)'}` })),
    ...defaults.rows.map((r): SequenceViolation => ({ kind: 'nextval_default', detail: `${r.rel}.${r.col} DEFAULT ${r.def}` })),
  ];
}

/** A unique key as the catalogue holds it: the backing index is the truth. */
interface UniqueKey {
  /** The index's name. */
  readonly index: string;
  /** The constraint's name, when the index backs a declared constraint. */
  readonly constraint: string | null;
  /** The KEY columns, in key order (INCLUDEd payload columns excluded — they do not constrain). */
  readonly columns: readonly string[];
  /** The partial-index predicate, if any: a partial unique constrains less than it appears to. */
  readonly predicate: string | null;
}

/**
 * Every unique key on `relation` — declared constraint or bare
 * `CREATE UNIQUE INDEX` alike — read from `pg_index` with `pg_constraint`
 * joined on for the constraint name. `pg_index` is the ground truth because a
 * UNIQUE constraint is an index with a name on it, while a bare unique index
 * is an index with no constraint at all: reading only `pg_constraint` would
 * make the second kind invisible, and a document-number uniqueness declared
 * as a bare index is exactly as load-bearing as one declared as a constraint.
 */
async function uniqueKeys(q: Queryable, relation: string): Promise<UniqueKey[]> {
  const { rows } = await q.query<{
    index: string;
    constraint: string | null;
    columns: string[] | null;
    predicate: string | null;
  }>(
    `SELECT ic.relname AS index,
            con.conname AS constraint,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            -- ::text so the client parses the array: array_agg over
            -- pg_attribute.attname yields name[], an OID pg has no parser for.
            (SELECT array_agg(COALESCE(a.attname::text, '(expression)') ORDER BY k.ord)::text[]
               FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(att, ord)
               LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.att
              WHERE k.ord <= i.indnkeyatts) AS columns
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid AND con.contype IN ('p', 'u')
      WHERE i.indrelid = $1::regclass AND i.indisunique
      ORDER BY ic.relname`,
    [relation],
  );
  return rows.map((r) => ({ index: r.index, constraint: r.constraint, columns: r.columns ?? [], predicate: r.predicate }));
}

/** The columns that make a row a document in a numbered series. */
const SERIES_COLUMNS: readonly string[] = ['number_seq', 'document_number'];

/**
 * THE LAW OF GOLD-48: every unique on `relation` that carries a series column
 * must also carry `scope`.
 *
 * Returned, not asserted, so the caller can name the offender. A unique over
 * `(document_kind, period, number_seq)` looks perfectly reasonable and is a
 * shared register: the first business to issue invoice 1 of 2026 takes that
 * number away from every other business of the tenant. The scope column is
 * therefore not decoration on the key — it IS the key's meaning.
 */
async function seriesUniquesMissingScope(
  q: Queryable,
  relation: string,
  scope = 'business_id',
  series: readonly string[] = SERIES_COLUMNS,
): Promise<UniqueKey[]> {
  const keys = await uniqueKeys(q, relation);
  return keys.filter((k) => k.columns.some((c) => series.includes(c)) && !k.columns.includes(scope));
}

/**
 * The name of the CHECK on `relation` that ties the period to the calendar
 * year of `dateColumn` (TL-P4-S1-C9). Discovered from `pg_constraint` by its
 * EXPRESSION rather than hardcoded, so the performed refusal below can be
 * attributed to the constraint the catalogue actually holds.
 */
async function periodYearCheckName(q: Queryable, relation: string, dateColumn = 'issue_date'): Promise<string | null> {
  const { rows } = await q.query<{ conname: string }>(
    `SELECT c.conname
       FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%' || $2 || '%'
        AND pg_get_constraintdef(c.oid) LIKE '%make_date%'
        AND pg_get_constraintdef(c.oid) LIKE '%period%'
      ORDER BY c.conname`,
    [relation, dateColumn],
  );
  return rows[0]?.conname ?? null;
}

// ───────────────────────────────────────────────────────────────────────────
// Performing the operations: the seed and the insert.
// ───────────────────────────────────────────────────────────────────────────

/** A PostgreSQL error as `pg` surfaces it, with the two fields a refusal is judged by. */
interface PgFailure {
  readonly code: string;
  readonly constraint: string | null;
}

/** Run `run` and return the SQLSTATE and constraint of its refusal, or null if it succeeded. */
async function refusal(run: () => Promise<unknown>): Promise<PgFailure | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const err = e as { code?: unknown; constraint?: unknown };
    return { code: typeof err.code === 'string' ? err.code : 'NO_SQLSTATE', constraint: typeof err.constraint === 'string' ? err.constraint : null };
  }
}

/** One seeded business of a tenant: everything an invoice row needs to exist. */
interface SeededBusiness {
  readonly tenantId: string;
  readonly businessId: string;
  readonly branchId: string;
  /** The business's own default warehouse — `sales.warehouse_id` is NOT NULL and composite-bound to it. */
  readonly warehouseId: string;
}

async function one(q: Queryable, sql: string, params: readonly unknown[] = []): Promise<string> {
  const { rows } = await q.query<{ id: string }>(sql, params as unknown[]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`no id from ${sql}`);
  return id;
}

/**
 * A business of `tenantId`, with the default branch an invoice's
 * `invoices_branch_fk` needs. The shape follows the existing scratch-database
 * seeds (`tests/helpers/accounting-posting.ts:229-239`,
 * `tests/helpers/stock-ledger.ts:1545-1555`) rather than inventing a new one.
 */
async function seedBusiness(q: Queryable, tenantId: string, slug: string): Promise<SeededBusiness> {
  const businessId = await one(
    q,
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenantId, `GOLD-48 ${slug}`, slug],
  );
  const branchId = await one(q, `INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [businessId]);
  const warehouseId = await one(q, `INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'Main WH', true) RETURNING id`, [
    businessId,
    branchId,
  ]);
  return { tenantId, businessId, branchId, warehouseId };
}

/** What varies between the invoices this suite writes; everything else is fixed below. */
interface InvoiceSpec {
  readonly period: string;
  readonly numberSeq: number;
  readonly documentNumber: string;
  /** Defaults to 15 June of `period` — the agreeing date. A disagreeing one is passed explicitly. */
  readonly issueDate?: string;
  readonly documentKind?: string;
}

/**
 * ONE DRAFT SALE, FOR ONE INVOICE TO HANG FROM.
 *
 * `0077:353` closed seam S-P4-01 with `invoices_sale_fk FOREIGN KEY
 * (business_id, sale_id) REFERENCES sales (business_id, id)`, so the fresh
 * `randomUUID()` `insertInvoice` passed as `sale_id` is now refused by THAT
 * edge — and a numbering suite whose inserts die on a foreign key proves
 * nothing about numbering. A FRESH parent per invoice, because
 * `invoices_sale_uq UNIQUE (business_id, sale_id, document_kind)`
 * (`0075:288`) admits one invoice of a kind per sale, and this suite writes
 * many invoices of one kind per business on purpose.
 *
 * The sale is a WALK-IN draft: no `customer_id`, so no `customer_name_snapshot`
 * (`sales_customer_snapshot_ck`) and settlement in cash
 * (`sales_credit_customer_ck`) — which matches the invoices this suite writes,
 * none of which names a customer either. A draft is the only sale shape a
 * fixture may write by hand: `sale_header_guard()` admits one carrying no
 * binding, `sales_cogs_owed()` returns early for it, and no `sale_items` row is
 * written, so the deferred `stock_source_complete_sale` has no subject. A
 * CONFIRMED sale is the commit primitive's alone.
 */
async function insertDraftSale(q: Queryable, biz: SeededBusiness): Promise<string> {
  const saleId = randomUUID();
  await q.query(
    `INSERT INTO sales (
       tenant_id, business_id, id, branch_id, warehouse_id, status, settlement_mode,
       document_date, currency_code,
       subtotal_txn_minor, discount_txn_minor, tax_minor, total_txn_minor, total_base_minor,
       source_to_base_rate, rate_source, rate_timestamp,
       commit_intent_sha256, business_transaction_id, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, 'draft', 'cash',
       DATE '2026-03-14', 'ILS',
       1000, 0, 0, 1000, 1000,
       1, 'base', date_trunc('second', now()),
       $6, $7, $8
     )`,
    [biz.tenantId, biz.businessId, saleId, biz.branchId, biz.warehouseId, 'a'.repeat(64), randomUUID(), USER_ID],
  );
  return saleId;
}

/**
 * Insert one invoice. `status = 'draft'` is deliberate: a draft owes no
 * accounting binding (`invoices_binding_owed_ck`, `0075:300`), and P4-S1 does
 * not register the `invoice` accounting source type at all (S-P4-02), so a
 * posted document could not satisfy `invoices_binding_fk` here. The numbering
 * constraints under test do not read `status`, so the draft is the smallest
 * row that exercises them honestly.
 *
 * This runs as the scratch database's OWNER/SUPERUSER, which bypasses the
 * FORCEd row security on `invoices`. It has to: P4-S1 grants no DML on these
 * relations to any runtime principal (`0075:494-495`), so there is no
 * non-owner that could perform this insert at all. See the header — this
 * suite proves the constraints, not the authority.
 */
async function insertInvoice(q: Queryable, biz: SeededBusiness, spec: InvoiceSpec): Promise<void> {
  await q.query(
    `INSERT INTO invoices (
       tenant_id, business_id, id, sale_id, branch_id,
       document_kind, document_number, number_seq, period, issue_date,
       currency_code, status,
       subtotal_txn_minor, discount_txn_minor, total_txn_minor, total_base_minor,
       source_to_base_rate, rate_source, rate_timestamp,
       issue_intent_sha256, business_transaction_id, created_by
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10::date,
       'ILS', 'draft',
       1000, 0, 1000, 1000,
       1, 'base', date_trunc('second', now()),
       $11, $12, $13
     )`,
    [
      biz.tenantId,
      biz.businessId,
      randomUUID(),
      await insertDraftSale(q, biz),
      biz.branchId,
      spec.documentKind ?? 'invoice',
      spec.documentNumber,
      spec.numberSeq,
      spec.period,
      spec.issueDate ?? `${spec.period}-06-15`,
      'a'.repeat(64),
      randomUUID(),
      USER_ID,
    ],
  );
}

/** The sequence row: the lock and the format, never the count (P4-AL-31). */
async function insertSequenceRow(q: Queryable, biz: SeededBusiness, period: string): Promise<void> {
  await q.query(
    `INSERT INTO invoice_sequences (tenant_id, business_id, document_kind, period, number_format)
     VALUES ($1, $2, 'invoice', $3, 'INV-{YYYY}-{SEQ:5}')`,
    [biz.tenantId, biz.businessId, period],
  );
}

// ───────────────────────────────────────────────────────────────────────────

/** The one user every invoice below is created by; filled in by the scratch seed. */
let USER_ID = '';

describe('GOLD-48 — invoice numbering: no counter, no sequence, and a series per business', () => {
  let shared: Pool;
  let scratch: ScratchDb;
  /** Two businesses of ONE tenant — the pair the whole isolation claim is about. */
  let bizA: SeededBusiness;
  let bizB: SeededBusiness;

  beforeAll(async () => {
    await ensurePostgres();
    // READ-ONLY on the shared database. No resetData(), no INSERT: other
    // suites run against `daftar` concurrently and a truncate would destroy
    // their run.
    shared = ownerPool();

    scratch = await createScratchDb('daftar_gold48_sequence_isolation');
    USER_ID = await one(scratch.pool, `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'GOLD-48') RETURNING id`, [
      `gold48-${randomUUID()}@test.dev`,
    ]);
    const tenantId = await one(scratch.pool, `INSERT INTO tenants DEFAULT VALUES RETURNING id`);
    bizA = await seedBusiness(scratch.pool, tenantId, `gold48-a-${randomUUID().slice(0, 8)}`);
    bizB = await seedBusiness(scratch.pool, tenantId, `gold48-b-${randomUUID().slice(0, 8)}`);
    expect(bizA.tenantId).toBe(bizB.tenantId);
    expect(bizA.businessId).not.toBe(bizB.businessId);
  }, 600_000);

  afterAll(async () => {
    await scratch?.drop();
  }, 120_000);

  // ── Law 1: the key of the series, and the absence of a count ────────────

  it('invoice_sequences is keyed on exactly (business_id, document_kind, period)', async () => {
    // The order matters as much as the membership: business_id leads because
    // the row is reached, and locked, per business (P4-AL-32).
    expect(await primaryKeyColumns(shared, 'invoice_sequences')).toEqual(['business_id', 'document_kind', 'period']);
  });

  it('invoice_sequences carries no counter column', async () => {
    // Derived from pg_attribute, not compared against a written-out list: the
    // point is to catch `current_value` (D-10) or anything else that reads
    // like a count, whatever it ends up being called.
    const columns = await columnNames(shared, 'invoice_sequences');
    expect(columns).toContain('number_format'); // the row does hold the FORMAT ...
    expect(await counterColumns(shared, 'invoice_sequences')).toEqual([]); // ... and never the COUNT (P4-AL-31).
  });

  // ── Law 2: no PostgreSQL sequence behind any of it ──────────────────────

  it('no PostgreSQL sequence stands behind invoices or invoice_sequences', async () => {
    // A sequence is non-transactional: it would leave gaps on rollback, and a
    // legal document number may not have gaps (R-P4-03, `0075:60-66`).
    expect(await sequenceLawViolations(shared, ['invoices', 'invoice_sequences'])).toEqual([]);
  });

  // ── Law 3: the uniques, and the scope every one of them must carry ──────

  it('invoices carries the two document uniques, by column list', async () => {
    const keys = await uniqueKeys(shared, 'invoices');
    const byConstraint = new Map(keys.filter((k) => k.constraint !== null).map((k) => [k.constraint as string, k]));

    // The series: the ordinal is unique within (business, kind, period), which
    // is what makes `max + 1` safe under the sequence row's lock (P4-AL-31).
    const series = byConstraint.get('invoices_number_uq');
    expect(series?.columns).toEqual(['business_id', 'document_kind', 'period', 'number_seq']);
    expect(series?.predicate).toBeNull(); // a partial unique would constrain only some rows

    // The rendered number: unique within (business, kind). It is not scoped to
    // the period, because the period is already inside the rendered string
    // (TL-P4-S1-C9) — scoping it again would permit the same printed number
    // twice.
    const rendered = byConstraint.get('invoices_document_number_uq');
    expect(rendered?.columns).toEqual(['business_id', 'document_kind', 'document_number']);
    expect(rendered?.predicate).toBeNull();
  });

  it('every unique on invoices that carries a number also carries business_id', async () => {
    // THE law (GOLD-48). Not "the two uniques above are right" — EVERY unique,
    // including one a later migration adds as a bare CREATE UNIQUE INDEX,
    // because a series not scoped to a business is a register shared between
    // businesses.
    const offenders = await seriesUniquesMissingScope(shared, 'invoices');
    expect(offenders.map((k) => k.index)).toEqual([]);

    // And the law is not vacuous: there ARE numbered uniques for it to judge.
    const keys = await uniqueKeys(shared, 'invoices');
    const numbered = keys.filter((k) => k.columns.some((c) => SERIES_COLUMNS.includes(c)));
    expect(numbered.length).toBeGreaterThanOrEqual(2);
  });

  it('a CHECK ties the period to the calendar year of the issue date', async () => {
    // Discovered by expression, so the performed refusal below can be
    // attributed to the constraint the catalogue holds (TL-P4-S1-C9).
    expect(await periodYearCheckName(shared, 'invoices')).toBe('invoices_period_ck');
  });

  // ── Performed: the isolation itself ─────────────────────────────────────

  it('PERFORMED: two businesses of one tenant both hold number_seq = 1 for the same kind and period', async () => {
    // This INSERT SUCCEEDING is the proof. If the series were scoped to the
    // tenant, the second business could not have ordinal 1 of 2026 at all,
    // and the first business to open its till would have taken it.
    await insertSequenceRow(scratch.pool, bizA, '2026');
    await insertSequenceRow(scratch.pool, bizB, '2026');

    await insertInvoice(scratch.pool, bizA, { period: '2026', numberSeq: 1, documentNumber: 'INV-2026-00001' });
    await insertInvoice(scratch.pool, bizB, { period: '2026', numberSeq: 1, documentNumber: 'INV-2026-00001' });

    // Both rows are there, and they are the SAME ordinal and the same rendered
    // number under two different businesses of one tenant.
    const { rows } = await scratch.pool.query<{ business_id: string; number_seq: string; document_number: string }>(
      `SELECT business_id, number_seq::text AS number_seq, document_number
         FROM invoices WHERE tenant_id = $1 AND period = '2026' ORDER BY business_id`,
      [bizA.tenantId],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.business_id))).toEqual(new Set([bizA.businessId, bizB.businessId]));
    expect(rows.every((r) => r.number_seq === '1' && r.document_number === 'INV-2026-00001')).toBe(true);
  });

  it('PERFORMED: the same number_seq twice in one business, kind and period is refused (23505)', async () => {
    // A different document_number, so the refusal can only be the series
    // unique and not the rendered-number unique.
    const failed = await refusal(() => insertInvoice(scratch.pool, bizA, { period: '2026', numberSeq: 1, documentNumber: 'INV-2026-00001-DUP' }));
    expect(failed).not.toBeNull();
    expect(failed?.code).toBe('23505');
    expect(failed?.constraint).toBe('invoices_number_uq');
  });

  it('PERFORMED: the ordinal restarts — number_seq = 1 is accepted again in a different period', async () => {
    // YEARLY granularity (TL-P4-S1-C9): the same business, the same kind, the
    // same ordinal, the next calendar year. Accepted, and the rendered number
    // differs because the year is inside it.
    await insertSequenceRow(scratch.pool, bizA, '2027');
    await insertInvoice(scratch.pool, bizA, { period: '2027', numberSeq: 1, documentNumber: 'INV-2027-00001' });

    const { rows } = await scratch.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoices WHERE business_id = $1 AND document_kind = 'invoice' AND number_seq = 1`,
      [bizA.businessId],
    );
    expect(rows[0]?.n).toBe('2'); // ordinal 1 of 2026 and ordinal 1 of 2027
  });

  it('PERFORMED: a period that disagrees with the issue date is refused (23514)', async () => {
    // The period IS the calendar year of the issue date. Without this, the
    // restart above would be a convention the command layer keeps rather than
    // a fact the database holds, and a 2025 invoice could be filed into the
    // 2026 register and take that register's ordinal 2.
    const checkName = await periodYearCheckName(scratch.pool, 'invoices');
    expect(checkName).not.toBeNull();

    const failed = await refusal(() =>
      insertInvoice(scratch.pool, bizA, { period: '2026', numberSeq: 900, documentNumber: 'INV-2026-00900', issueDate: '2025-06-15' }),
    );
    expect(failed).not.toBeNull();
    expect(failed?.code).toBe('23514');
    expect(failed?.constraint).toBe(checkName);

    // The other side of the boundary too: the first instant of the next year
    // is not in this period.
    const overrun = await refusal(() =>
      insertInvoice(scratch.pool, bizA, { period: '2026', numberSeq: 901, documentNumber: 'INV-2026-00901', issueDate: '2027-01-01' }),
    );
    expect(overrun?.code).toBe('23514');
    expect(overrun?.constraint).toBe(checkName);
  });

  // ── RED PROOFS ─────────────────────────────────────────────────────────
  //
  // Each plants the defect its law exists to catch, in the scratch database,
  // and requires the SAME function used above to name it. Without these, a
  // green run above would only mean "the schema happens to be right today"
  // and could equally mean "the law reads nothing at all".

  it('RED: a document-number UNIQUE that omits business_id is caught', async () => {
    // The register shared between businesses, planted. The key looks entirely
    // reasonable — kind, period, ordinal, and the rendered number — and is
    // precisely the defect GOLD-48 exists for.
    await scratch.pool.query(`DROP TABLE IF EXISTS red_unscoped_register`);
    await scratch.pool.query(`
      CREATE TABLE red_unscoped_register (
        business_id     UUID NOT NULL,
        document_kind   TEXT NOT NULL,
        period          TEXT NOT NULL,
        number_seq      BIGINT NOT NULL,
        document_number TEXT NOT NULL,
        CONSTRAINT red_unscoped_series_uq UNIQUE (document_kind, period, number_seq),
        CONSTRAINT red_unscoped_rendered_uq UNIQUE (document_kind, document_number),
        CONSTRAINT red_unscoped_scoped_uq UNIQUE (business_id, document_kind, period, number_seq, document_number)
      )`);
    try {
      const offenders = await seriesUniquesMissingScope(scratch.pool, 'red_unscoped_register');
      // Both unscoped keys named, and the correctly scoped one NOT named — a
      // law that flagged everything would be no law.
      expect(offenders.map((k) => k.constraint).sort()).toEqual(['red_unscoped_rendered_uq', 'red_unscoped_series_uq']);

      // And the planted breach is real, not merely mis-shaped: two businesses
      // cannot both hold ordinal 1 here.
      await scratch.pool.query(`INSERT INTO red_unscoped_register VALUES ($1, 'invoice', '2026', 1, 'X-1')`, [bizA.businessId]);
      const clash = await refusal(() => scratch.pool.query(`INSERT INTO red_unscoped_register VALUES ($1, 'invoice', '2026', 1, 'X-2')`, [bizB.businessId]));
      expect(clash?.code).toBe('23505');
      expect(clash?.constraint).toBe('red_unscoped_series_uq');
    } finally {
      await scratch.pool.query(`DROP TABLE IF EXISTS red_unscoped_register`);
    }
  });

  it('RED: a CREATE SEQUENCE backing a number column is caught', async () => {
    // Both halves of the no-sequence law, planted separately: `bigserial`
    // leaves an owned relation of kind S AND a nextval default, while the
    // hand-made sequence below is wired into a default with no ownership
    // dependency at all — which the pg_depend half alone would miss.
    await scratch.pool.query(`DROP TABLE IF EXISTS red_serial_numbers`);
    await scratch.pool.query(`DROP TABLE IF EXISTS red_detached_numbers`);
    await scratch.pool.query(`DROP SEQUENCE IF EXISTS red_detached_seq`);
    await scratch.pool.query(`CREATE TABLE red_serial_numbers (business_id UUID NOT NULL, number_seq BIGSERIAL NOT NULL)`);
    await scratch.pool.query(`CREATE SEQUENCE red_detached_seq`);
    await scratch.pool.query(`CREATE TABLE red_detached_numbers (business_id UUID NOT NULL, number_seq BIGINT NOT NULL DEFAULT nextval('red_detached_seq'))`);
    try {
      const serial = await sequenceLawViolations(scratch.pool, ['red_serial_numbers']);
      expect(serial.map((v) => v.kind).sort()).toEqual(['nextval_default', 'sequence_relation']);
      expect(serial.some((v) => v.detail.includes('red_serial_numbers.number_seq'))).toBe(true);

      const detached = await sequenceLawViolations(scratch.pool, ['red_detached_numbers']);
      expect(detached.map((v) => v.kind)).toEqual(['nextval_default']);
      expect(detached[0]?.detail).toContain(`nextval('red_detached_seq'`);

      // The law is not blanket: a relation with neither is clean.
      expect(await sequenceLawViolations(scratch.pool, ['invoice_sequences'])).toEqual([]);
    } finally {
      await scratch.pool.query(`DROP TABLE IF EXISTS red_serial_numbers`);
      await scratch.pool.query(`DROP TABLE IF EXISTS red_detached_numbers`);
      await scratch.pool.query(`DROP SEQUENCE IF EXISTS red_detached_seq`);
    }
  });

  it('RED: a counter column on a sequence-like relation is caught', async () => {
    // `current_value BIGINT` is not a hypothetical: it is what
    // `DATA_MODEL.md` §14أ specified and `D-10` struck out. Planted here,
    // under the real key, so the law is shown to find the exact column the
    // decision refuses — and the three other spellings with it.
    await scratch.pool.query(`DROP TABLE IF EXISTS red_counter_sequences`);
    await scratch.pool.query(`
      CREATE TABLE red_counter_sequences (
        tenant_id     UUID NOT NULL,
        business_id   UUID NOT NULL,
        document_kind TEXT NOT NULL,
        period        TEXT NOT NULL,
        number_format TEXT NOT NULL,
        current_value BIGINT NOT NULL DEFAULT 0,
        next_number   BIGINT NOT NULL DEFAULT 1,
        last_issued   BIGINT,
        seq           BIGINT,
        PRIMARY KEY (business_id, document_kind, period)
      )`);
    try {
      // The key is right, so a key-only law would call this relation correct.
      expect(await primaryKeyColumns(scratch.pool, 'red_counter_sequences')).toEqual(['business_id', 'document_kind', 'period']);
      // The counter law is what catches it.
      expect(await counterColumns(scratch.pool, 'red_counter_sequences')).toEqual(['current_value', 'next_number', 'last_issued', 'seq']);
      // And it leaves the legitimate columns alone: `number_format` holds the
      // rendering, not the count.
      expect(looksLikeCounter('number_format')).toBe(false);
      expect(looksLikeCounter('period')).toBe(false);
    } finally {
      await scratch.pool.query(`DROP TABLE IF EXISTS red_counter_sequences`);
    }
  });
});
