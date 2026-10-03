import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Pool, QueryResultRow } from 'pg';
import { ensurePostgres, ownerPool } from '../../helpers/test-app';
import { createScratchDb, type ScratchDb } from '../../helpers/scratch-db';
import { DERIVED_SETTLEMENT_INSTANT, isAuthoritativeSalesColumn } from '../../../scripts/guards/no-authoritative-balance';

/**
 * GOLDEN REGRESSION — PHASE 4 SCHEMA LINT, THE LIVE HALF (G-19 / GOLD-74).
 *
 * `scripts/phase4-s1-gate.ts` already carries the STATIC half of this lint
 * (`schemaLintProblems`): it parses the Phase 4 migration SQL and checks that
 * every column named in every UNIQUE, CHECK and FOREIGN KEY exists, that no
 * constraint column list pins a literal, and that the financial core holds no
 * polymorphic reference. That half reads a FILE.
 *
 * This suite asserts the same law against the CATALOGUE of the database the
 * migrations actually built — `pg_class`, `pg_attribute`, `pg_constraint`,
 * `pg_index`, `pg_type` — and never against
 * `0075_phase4_customers_invoices_numbering.sql` itself. The migration's own
 * header calls that rule R-P4-08, "the live catalogue is the policy"
 * (`0075:98-101`), and 0075-E obeys it at apply time. A golden obeys it
 * FOREVER: 0075-E runs once, on the transaction that applies 0075, and says
 * nothing about migration 0091 quietly dropping `invoices_tax_policy_absent_ck`
 * or widening `invoice_items.quantity` to `double precision`.
 *
 * Why the live half is worth a suite of its own, given the static half exists:
 *
 *   — A SQL parser sees what the author WROTE. The catalogue holds what
 *     PostgreSQL BUILT, and the two part company the moment anything reaches
 *     the schema other than the text the gate reads: a later `ALTER TABLE`, an
 *     `ALTER TYPE`, a `DROP CONSTRAINT`, an operator-applied hotfix, a
 *     restore from a dump of a divergent database, or a hand-edited
 *     catalogue. Each of those is invisible to `schemaLintProblems` and plain
 *     to a `pg_constraint` read.
 *   — The static half's constraint-column check is inherently TRUE in the
 *     catalogue for a constraint PostgreSQL created, because `conkey` holds
 *     attribute numbers rather than names. So the live form of that law is not
 *     "the columns resolve" but the CONSTRAINT INVENTORY: every constraint a
 *     later migration could quietly drop is named here, by name and by type,
 *     and the comparison is exact in both directions — a dropped constraint
 *     and an unreviewed new one both turn this red. The resolution check is
 *     kept beside it anyway, because a catalogue CAN hold an unresolvable
 *     `conkey` (the first red proof plants one) and nothing else in the
 *     repository would notice.
 *
 * What this suite deliberately does NOT do:
 *
 *   — It does not read the migration file, or any file of SQL. The catalogue
 *     is the only witness (R-P4-08).
 *   — It does not write a single row to the shared `daftar` database, and it
 *     never calls `resetData()`. Every assertion here is a catalogue SELECT;
 *     P4-S1 grants no DML on these five relations to anybody and ships no
 *     writer (`0075:48-51`), so there is nothing to seed and nothing to clean.
 *     Every planted defect lives in a throwaway `createScratchDb` database.
 *   — It does not re-check row security, the policy inventory, the privilege
 *     model, the seven guards or the four read functions. Those are 0075-E's
 *     sections 2, 3, 6, 7 and 8 and other suites' subject; this one is the
 *     SHAPE of the five relations.
 *   — It does not re-type the derived-truth vocabulary as literals. The
 *     patterns are imported from `scripts/guards/no-authoritative-balance.ts`,
 *     because a second copy of a vocabulary drifts from the first and the
 *     drift is silent (that file's own header, `:248-259`, is the record of
 *     exactly that happening once already).
 */

/** Anything that can run a query: the shared owner pool, or a scratch database's pool. */
type Queryable = Pick<Pool, 'query'>;

/** The five relations 0075 creates — the first Phase 4 relations to exist (`0075:13-17`). */
const RELATIONS: readonly string[] = ['customers', 'customer_contacts', 'invoices', 'invoice_items', 'invoice_sequences'];

/** The financial core: the two relations that carry posted money (`0075:243`, `0075:336`). */
const FINANCIAL_CORE: readonly string[] = ['invoices', 'invoice_items'];

/**
 * THE SEAM ALLOWLIST (`0075:105-111`, seam S-P4-01) — NOW EMPTY, BECAUSE THE
 * SEAM IS CLOSED.
 *
 * `invoices.sale_id` carried no foreign key while `sales` was P4-S2's relation
 * and P4-AL-86 refused a later slice's table in `0075`. The seam was safe
 * rather than merely unenforced: P4-S1 granted no DML to any principal and
 * shipped no command, so no invoice row could exist, and `0077:353` added
 * `invoices_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales
 * (business_id, id)` over an empty table, validated.
 *
 * The entry is therefore REMOVED, which is exactly what this header said
 * closing the seam would mean. Leaving it would be worse than untidy: an
 * allowlisted column is skipped by `polymorphicReferenceProblems` BEFORE its
 * binding is looked at, so a later migration dropping `invoices_sale_fk` would
 * have been sheltered by a stale exemption and LAW 5 would have reported
 * nothing. With the list empty the law is strictly stronger, and the test
 * below asserts the closure POSITIVELY — the column is bound, by that
 * constraint, validated — so "the allowlist is empty" can never be satisfied
 * by the seam quietly reopening.
 *
 * An entry is never simply added here. A new unbound `*_id` column in the
 * financial core is a failure of LAW 5, and opening a seam means a Tech Lead
 * ruling and a migration header that declares it.
 */
const SEAM_ALLOWLIST: readonly string[] = [];

interface AttRow {
  readonly relation: string;
  readonly column: string;
  readonly typname: string;
  readonly notnull: boolean;
  readonly typmod: number;
}

async function query<T extends QueryResultRow>(q: Queryable, sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await q.query<T>(sql, params as unknown[]);
  return result.rows;
}

/** Every live, non-dropped column of `relations`, with its base type name, NOT NULL flag and type modifier. */
async function columnsOf(q: Queryable, relations: readonly string[]): Promise<AttRow[]> {
  return query<AttRow>(
    q,
    `SELECT c.relname::text AS relation, a.attname::text AS column, t.typname::text AS typname,
            a.attnotnull AS notnull, a.atttypmod AS typmod
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      ORDER BY c.relname, a.attnum`,
    [relations],
  );
}

// ── LAW 1 — the five relations exist, are ordinary tables, and carry the tenancy ──

/**
 * LAW 1 (P4-AL-08, `0075:14-15`). Each relation exists, is `relkind = 'r'` —
 * an ordinary table, not a view, a foreign table or a partitioned parent that
 * enforces nothing itself — and carries `tenant_id` and `business_id` as real
 * `uuid` columns that are `NOT NULL`. A nullable `business_id` is a row that
 * belongs to no business, which is the one row every isolation policy below
 * it cannot judge.
 */
export async function relationShapeProblems(q: Queryable, relations: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  const kinds = await query<{ relation: string; relkind: string }>(
    q,
    `SELECT c.relname::text AS relation, c.relkind::text AS relkind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [relations],
  );
  const kindOf = new Map(kinds.map((r) => [r.relation, r.relkind]));
  const columns = await columnsOf(q, relations);
  for (const relation of relations) {
    const kind = kindOf.get(relation);
    if (kind === undefined) {
      problems.push(`${relation}: no such relation in schema public — GOLD-74`);
      continue;
    }
    if (kind !== 'r') {
      problems.push(`${relation}: relkind is ${JSON.stringify(kind)}, not 'r' — a Phase 4 relation is an ordinary table (GOLD-74)`);
    }
    for (const required of ['tenant_id', 'business_id']) {
      const column = columns.find((a) => a.relation === relation && a.column === required);
      if (column === undefined) {
        problems.push(`${relation}: does not carry ${required} as a real column — P4-AL-08 (GOLD-74)`);
        continue;
      }
      if (column.typname !== 'uuid') problems.push(`${relation}.${required} is ${column.typname}, not uuid — P4-AL-08 (GOLD-74)`);
      if (!column.notnull)
        problems.push(`${relation}.${required} is nullable — a row that belongs to no business is not judgeable by any policy (P4-AL-08, GOLD-74)`);
    }
  }
  return problems;
}

// ── LAW 2 — the constraint inventory, and its columns resolving ──

/** One expected constraint, written as `"<contype> <conname>"` so a CHECK silently becoming a UNIQUE is caught too. */
type ConstraintEntry = string;

/**
 * LAW 2, the live form (GOLD-74). The static gate checks that every column a
 * constraint names exists; in the catalogue that is true by construction,
 * because `conkey` holds attribute numbers. So the live assertion is the
 * INVENTORY: exactly these constraints, by name and by type, on exactly these
 * relations. The comparison is two-directional on purpose — a `DROP
 * CONSTRAINT` in a later migration and an unreviewed `ADD CONSTRAINT` are
 * both defects, and only an exact set catches both.
 *
 * `contype` letters are PostgreSQL's own: `p` primary key, `u` unique,
 * `f` foreign key, `c` check. Row-level NOT NULL is asserted by LAW 1 through
 * `pg_attribute.attnotnull`; on PostgreSQL 16 it is not a `pg_constraint` row
 * at all, so it cannot be spelled here.
 */
export async function constraintInventoryProblems(q: Queryable, expected: ReadonlyMap<string, readonly ConstraintEntry[]>): Promise<string[]> {
  const problems: string[] = [];
  const found = await query<{ relation: string; entry: string }>(
    q,
    `SELECT c.conrelid::regclass::text AS relation, (c.contype::text || ' ' || c.conname::text) AS entry
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' AND r.relname = ANY($1::text[]) AND c.contype = ANY (ARRAY['p', 'u', 'f', 'c'])
      ORDER BY 1, 2`,
    [[...expected.keys()]],
  );
  for (const [relation, want] of expected) {
    const have = found
      .filter((r) => r.relation === relation)
      .map((r) => r.entry)
      .sort();
    const wanted = [...want].sort();
    for (const entry of wanted) if (!have.includes(entry)) problems.push(`${relation}: the constraint "${entry}" is gone from the live catalogue — GOLD-74`);
    for (const entry of have)
      if (!wanted.includes(entry)) problems.push(`${relation}: the live catalogue carries the unreviewed constraint "${entry}" — GOLD-74`);
  }
  return problems;
}

/**
 * LAW 2's resolution half. Every attribute number a constraint names — its own
 * `conkey` against `conrelid`, and a foreign key's `confkey` against
 * `confrelid` — must resolve to a live, non-dropped column. PostgreSQL will
 * not build such a constraint wrong, which is exactly why this is here: an
 * unresolvable `conkey` can only arrive by a route no SQL parser reads, and
 * the first red proof plants one to prove this function sees it.
 */
export async function unresolvedConstraintColumnProblems(q: Queryable, relations: readonly string[]): Promise<string[]> {
  const rows = await query<{ relation: string; conname: string; contype: string; side: string; attnum: number; attname: string | null }>(
    q,
    `SELECT c.conrelid::regclass::text AS relation, c.conname::text AS conname, c.contype::text AS contype,
            k.side AS side, k.attnum AS attnum, a.attname::text AS attname
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       CROSS JOIN LATERAL (
         SELECT 'conkey' AS side, c.conrelid AS owner, x AS attnum FROM unnest(coalesce(c.conkey, '{}'::smallint[])) AS x
         UNION ALL
         SELECT 'confkey' AS side, c.confrelid AS owner, x AS attnum FROM unnest(coalesce(c.confkey, '{}'::smallint[])) AS x
       ) AS k
       LEFT JOIN pg_attribute a ON a.attrelid = k.owner AND a.attnum = k.attnum AND NOT a.attisdropped AND a.attnum > 0
      WHERE n.nspname = 'public' AND r.relname = ANY($1::text[]) AND c.contype = ANY (ARRAY['p', 'u', 'f', 'c'])
      ORDER BY 1, 2, 4, 5`,
    [relations],
  );
  return rows
    .filter((r) => r.attname === null)
    .map(
      (r) =>
        `${r.relation}: the constraint ${r.conname} (contype ${r.contype}) names attribute ${r.attnum} in its ${r.side}, ` +
        `which is not a live column of the relation it is attached to — GOLD-74`,
    );
}

/**
 * LAW 2's index half (`pg_index`). Every primary key and unique constraint is
 * backed by an index that is itself unique, valid and unconditional: a partial
 * or invalid index behind a UNIQUE is a uniqueness claim the catalogue does not
 * keep. The named non-constraint indexes are inventoried in the same breath,
 * because `customer_contacts_one_primary` (`0075:238`) is the one uniqueness
 * rule of this slice that is an index and not a constraint, so nothing else
 * here would miss it.
 */
export async function indexInventoryProblems(q: Queryable, relations: readonly string[], expected: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  const indexes = await query<{ relation: string; index: string; unique: boolean; valid: boolean; partial: boolean }>(
    q,
    `SELECT c.relname::text AS relation, i.relname::text AS index, x.indisunique AS unique, x.indisvalid AS valid,
            (x.indpred IS NOT NULL) AS partial
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      ORDER BY 1, 2`,
    [relations],
  );
  const have = indexes.map((r) => `${r.relation}.${r.index}`).sort();
  const wanted = [...expected].sort();
  for (const name of wanted) if (!have.includes(name)) problems.push(`the index ${name} is gone from the live catalogue — GOLD-74`);
  for (const name of have) if (!wanted.includes(name)) problems.push(`the live catalogue carries the unreviewed index ${name} — GOLD-74`);

  const backing = await query<{ relation: string; conname: string; index: string; unique: boolean; valid: boolean; partial: boolean }>(
    q,
    `SELECT c.conrelid::regclass::text AS relation, c.conname::text AS conname, i.relname::text AS index,
            x.indisunique AS unique, x.indisvalid AS valid, (x.indpred IS NOT NULL) AS partial
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       LEFT JOIN pg_class i ON i.oid = c.conindid
       LEFT JOIN pg_index x ON x.indexrelid = c.conindid
      WHERE n.nspname = 'public' AND r.relname = ANY($1::text[]) AND c.contype = ANY (ARRAY['p', 'u'])`,
    [relations],
  );
  for (const row of backing) {
    if (!row.unique || !row.valid || row.partial) {
      problems.push(
        `${row.relation}: the ${row.conname} constraint is backed by ${row.index ?? 'no index'} ` +
          `(unique=${String(row.unique)}, valid=${String(row.valid)}, partial=${String(row.partial)}) — GOLD-74`,
      );
    }
  }
  return problems;
}

// ── LAW 3 — money is BIGINT minor units, quantity is NUMERIC(18,4), nothing floats ──

/**
 * LAW 3a (P4-AL-15b). No column of the five is `real` or `double precision`.
 * Binary floating point cannot represent a tenth of a currency unit, so a
 * money column that floats loses money by construction — and the loss is
 * silent, which is why this is a schema law and not a review note.
 */
export async function floatingPointProblems(q: Queryable, relations: readonly string[]): Promise<string[]> {
  const columns = await columnsOf(q, relations);
  return columns
    .filter((a) => a.typname === 'float4' || a.typname === 'float8')
    .map((a) => `${a.relation}.${a.column} is ${a.typname === 'float4' ? 'real' : 'double precision'} — Phase 4 money does not float (P4-AL-15b, GOLD-74)`);
}

/**
 * LAW 3b (P4-AL-15b). The DECLARED type of every money and quantity column:
 *
 *   — every `*_minor` column is `bigint`. Minor units are integers, and
 *     `integer` would overflow the `1000000000000000000` ceiling the CHECKs
 *     name (`0075:259`) long before the ceiling did.
 *   — `invoice_items.quantity` is `numeric` with precision 18 and scale 4,
 *     read out of `atttypmod` rather than trusted from `format_type`, so a
 *     widening to `numeric` (unconstrained) or a narrowing of the scale is a
 *     failure and not a passing "still numeric".
 */
export async function moneyAndQuantityTypeProblems(q: Queryable, relations: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  const columns = await columnsOf(q, relations);
  const minor = columns.filter((a) => a.column.endsWith('_minor'));
  if (minor.length === 0) problems.push(`none of ${relations.join(', ')} carries a *_minor column — Phase 4 money is minor units (P4-AL-15b, GOLD-74)`);
  for (const a of minor)
    if (a.typname !== 'int8') problems.push(`${a.relation}.${a.column} is ${a.typname}, not bigint — money in minor units is a BIGINT (P4-AL-15b, GOLD-74)`);

  for (const a of columns.filter((c) => c.column === 'quantity')) {
    if (a.typname !== 'numeric') {
      problems.push(`${a.relation}.quantity is ${a.typname}, not numeric — a Phase 4 quantity is NUMERIC(18,4) (P4-AL-15b, GOLD-74)`);
      continue;
    }
    // A numeric's atttypmod is ((precision << 16) | scale) + VARHDRSZ; -1 is
    // an unconstrained numeric, which pins neither precision nor scale.
    if (a.typmod === -1) {
      problems.push(`${a.relation}.quantity is an unconstrained numeric — a Phase 4 quantity is NUMERIC(18,4) (P4-AL-15b, GOLD-74)`);
      continue;
    }
    const precision = ((a.typmod - 4) >> 16) & 0xffff;
    const scale = (a.typmod - 4) & 0xffff;
    if (precision !== 18 || scale !== 4) {
      problems.push(`${a.relation}.quantity is numeric(${precision},${scale}), not numeric(18,4) — P4-AL-15b (GOLD-74)`);
    }
  }
  return problems;
}

// ── LAW 4 — no stored derived truth ──

/**
 * LAW 4 (P4-AL-05, P4-AL-06; R-P4-02 at `0075:64-69`). No relation of the five
 * carries a column of the forbidden derived-truth vocabulary: no balance,
 * paid, outstanding, due, owed, receivable, settled, collected, allocated,
 * refunded, debt, overdue, aging or stored-COGS column, and no derived
 * settlement instant either.
 *
 * The vocabulary is IMPORTED — `isAuthoritativeSalesColumn` and
 * `DERIVED_SETTLEMENT_INSTANT` from `scripts/guards/no-authoritative-balance.ts`
 * — and never re-typed here. That file's header records what a second copy
 * costs: `AP_BALANCE_COLUMN` was wired to supplier table NAMES, and
 * `invoices.paid_minor`, `invoices.outstanding_minor` and four more passed CI
 * for a whole phase. One vocabulary, one place, both halves of the guard.
 */
export async function derivedTruthColumnProblems(q: Queryable, relations: readonly string[]): Promise<string[]> {
  const columns = await columnsOf(q, relations);
  return columns
    .filter((a) => isAuthoritativeSalesColumn(a.column))
    .map(
      (a) =>
        `${a.relation}.${a.column} is a column of the derived-truth vocabulary P4-AL-06 refuses` +
        `${DERIVED_SETTLEMENT_INSTANT.test(a.column.toLowerCase()) ? ' (a derived settlement instant)' : ''}` +
        ` — the readers-of-record are invoice_outstanding, invoice_settlement_state, customer_ar_outstanding and customer_ar_aging (GOLD-74)`,
    );
}

// ── LAW 5 — no polymorphic reference in the financial core ──

/**
 * A `*_id` column name that is a CORRELATION identifier and not a reference,
 * DISCOVERED from the catalogue rather than exempted by opinion: a name that
 * appears on at least two ordinary relations OUTSIDE the relations under test
 * and carries a foreign key on NONE of them, anywhere in the database.
 *
 * On the real schema this finds `business_transaction_id` (15 relations from
 * Phase 2 and Phase 3 onward) and `request_id`. Neither names a relation —
 * there is no `business_transactions` table in the catalogue at all — so
 * neither is a reference that could go polymorphic; treating them as
 * references would indict the whole schema rather than 0075. Because the
 * predicate is derived, a name stops being exempt the day something binds it,
 * and a NEW unbound `*_id` invented by one Phase 4 migration is never exempt:
 * it appears on one relation, inside the set under test.
 */
export async function discoverCorrelationIdColumns(q: Queryable, underTest: readonly string[]): Promise<ReadonlySet<string>> {
  const rows = await query<{ attname: string }>(
    q,
    `WITH fk_bound AS (
       SELECT DISTINCT a.attname::text AS attname
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(coalesce(c.conkey, '{}'::smallint[])) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'f'
     ), candidates AS (
       SELECT a.attname::text AS attname, count(DISTINCT c.oid) AS n
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relname = ANY($1::text[]))
          AND a.attname LIKE '%\\_id'
        GROUP BY a.attname
     )
     SELECT attname FROM candidates WHERE n >= 2 AND attname NOT IN (SELECT attname FROM fk_bound) ORDER BY 1`,
    [underTest],
  );
  return new Set(rows.map((r) => r.attname));
}

/**
 * LAW 5 (P4-AL-29; the static gate's own financial-core arm). In the financial
 * core, every `*_id` column either carries a foreign key — read from
 * `pg_constraint`, so the binding is the catalogue's and not the author's
 * intention — or is one of two things and nothing else: an entry of
 * `SEAM_ALLOWLIST`, the seams 0075's header declares by name, or a
 * correlation identifier the catalogue itself shows to be one.
 *
 * An unbound `*_id` is how a polymorphic reference is spelled. The static gate
 * only flags one when a `*_type` or `*_kind` sibling makes the polymorphism
 * explicit; the live half asks the stricter question, because
 * `invoices.accounting_source_type` already sits beside `binding_source_id`
 * and the only thing that keeps that pair from being polymorphic is
 * `invoices_binding_fk` actually existing in the catalogue (`0075:323-326`).
 */
export async function polymorphicReferenceProblems(
  q: Queryable,
  relations: readonly string[],
  seams: readonly string[],
  correlation: ReadonlySet<string>,
): Promise<string[]> {
  const problems: string[] = [];
  const columns = await columnsOf(q, relations);
  const bound = await query<{ relation: string; column: string }>(
    q,
    `SELECT c.conrelid::regclass::text AS relation, a.attname::text AS column
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
       CROSS JOIN LATERAL unnest(coalesce(c.conkey, '{}'::smallint[])) AS k(attnum)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND r.relname = ANY($1::text[]) AND c.contype = 'f'`,
    [relations],
  );
  const isBound = new Set(bound.map((r) => `${r.relation}.${r.column}`));
  for (const a of columns) {
    if (!/_id$/.test(a.column)) continue;
    const qualified = `${a.relation}.${a.column}`;
    if (isBound.has(qualified) || seams.includes(qualified) || correlation.has(a.column)) continue;
    problems.push(
      `${qualified} carries no foreign key, is not a declared seam and is not a catalogue-wide correlation id — ` +
        `an unbound *_id in the financial core is a polymorphic reference, and the composite bridge of P4-AL-29 is how a source is bound (GOLD-74)`,
    );
  }
  return problems;
}

// ── LAW 6 — the tax CHECK, by exact text ──

/**
 * LAW 6 (P4-AL-44, OD-03 open; `0075:52-54`). `CHECK (tax_minor = 0)` is on
 * BOTH money-bearing relations, asserted by the exact text
 * `pg_get_constraintdef` renders. Phase 4 ships no tax policy, and the shape
 * of that decision is a constraint that makes a non-zero tax unrepresentable
 * rather than a convention the command layer keeps. The day OD-03 closes, one
 * migration drops these two constraints and this golden turns red — which is
 * the point: the widening is a ruling, not a refactor.
 */
export async function constraintTextProblems(q: Queryable, expected: ReadonlyMap<string, string>): Promise<string[]> {
  const problems: string[] = [];
  const rows = await query<{ key: string; def: string }>(
    q,
    `SELECT (c.conrelid::regclass::text || '.' || c.conname::text) AS key, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' AND (c.conrelid::regclass::text || '.' || c.conname::text) = ANY ($1::text[])`,
    [[...expected.keys()]],
  );
  const defOf = new Map(rows.map((r) => [r.key, r.def]));
  for (const [key, want] of expected) {
    const def = defOf.get(key);
    if (def === undefined) {
      problems.push(`${key} does not exist in the live catalogue — GOLD-74`);
      continue;
    }
    if (def !== want) problems.push(`${key} is ${JSON.stringify(def)}, not ${JSON.stringify(want)} — GOLD-74`);
  }
  return problems;
}

// ── the expected inventories, written out ──

/**
 * The constraint inventory, written out by hand on purpose. A golden that asks
 * the catalogue what it holds and then asserts the answer proves nothing; GOLD-74
 * wants the NAMES. Every entry here is a constraint a later migration could
 * drop, and dropping one without amending this list is the failure.
 */
const EXPECTED_CONSTRAINTS: ReadonlyMap<string, readonly ConstraintEntry[]> = new Map<string, readonly ConstraintEntry[]>([
  [
    'customers',
    [
      'p customers_pkey',
      'f customers_tenant_fk',
      'f customers_created_by_fkey',
      'f customers_updated_by_fkey',
      'c customers_name_check',
      'c customers_phone_check',
      'c customers_email_check',
      'c customers_notes_check',
      'c customers_status_check',
      'c customers_revision_check',
      'c customers_create_intent_sha256_check',
      'c customers_last_intent_sha256_check',
    ],
  ],
  [
    'customer_contacts',
    [
      'p customer_contacts_pkey',
      'u customer_contacts_no_uq',
      'f customer_contacts_tenant_fk',
      'f customer_contacts_customer_fk',
      'f customer_contacts_created_by_fkey',
      'c customer_contacts_contact_no_check',
      'c customer_contacts_name_check',
      'c customer_contacts_phone_check',
      'c customer_contacts_email_check',
      'c customer_contacts_notes_check',
    ],
  ],
  [
    'invoices',
    [
      'p invoices_pkey',
      // The series and the rendered number, each unique WITHIN the business
      // (P4-AL-31, GOLD-48; `0075:286-288`).
      'u invoices_number_uq',
      'u invoices_document_number_uq',
      'u invoices_sale_uq',
      'f invoices_tenant_fk',
      'f invoices_customer_fk',
      'f invoices_branch_fk',
      'f invoices_currency_fk',
      'f invoices_fx_rate_fk',
      'f invoices_binding_fk',
      // Seam S-P4-01, closed by `0077:353` once `sales` existed.
      'f invoices_sale_fk',
      'f invoices_created_by_fkey',
      'f invoices_voided_by_fkey',
      // The document's own shape.
      'c invoices_document_kind_ck',
      'c invoices_document_number_check',
      'c invoices_number_seq_check',
      'c invoices_period_check',
      'c invoices_period_ck',
      'c invoices_status_check',
      'c invoices_notes_check',
      'c invoices_issue_intent_sha256_check',
      'c invoices_void_intent_sha256_check',
      'c invoices_due_date_ck',
      // The money, and the arithmetic between the money columns.
      'c invoices_subtotal_txn_minor_check',
      'c invoices_discount_txn_minor_check',
      'c invoices_total_txn_minor_check',
      'c invoices_total_base_minor_check',
      'c invoices_total_ck',
      'c invoices_discount_ck',
      'c invoices_tax_policy_absent_ck',
      // The FX snapshot.
      'c invoices_source_to_base_rate_check',
      'c invoices_rate_source_check',
      'c invoices_rate_timestamp_check',
      'c invoices_rate_shape_ck',
      // The accounting binding, and the lifecycle as a physical shape (R-P4-04).
      'c invoices_binding_identity_ck',
      'c invoices_binding_owed_ck',
      'c invoices_state_ck',
      // The walk-in invariant's static half (P4-AL-11).
      'c invoices_customer_name_snapshot_check',
      'c invoices_customer_phone_snapshot_check',
      'c invoices_customer_snapshot_ck',
      'c invoices_walkin_terms_ck',
    ],
  ],
  [
    'invoice_items',
    [
      'p invoice_items_pkey',
      'u invoice_items_line_uq',
      'f invoice_items_tenant_fk',
      'f invoice_items_invoice_fk',
      'f invoice_items_product_fk',
      'f invoice_items_variant_fk',
      'c invoice_items_line_no_check',
      'c invoice_items_name_snapshot_check',
      'c invoice_items_quantity_check',
      'c invoice_items_unit_price_txn_minor_check',
      'c invoice_items_gross_txn_minor_check',
      'c invoice_items_discount_txn_minor_check',
      'c invoice_items_net_txn_minor_check',
      'c invoice_items_base_share_minor_check',
      'c invoice_items_net_ck',
      'c invoice_items_discount_ck',
      'c invoice_items_tax_policy_absent_ck',
    ],
  ],
  [
    'invoice_sequences',
    [
      // The numbering row's key IS the lock (R-P4-03, `0075:367-370`): there is
      // no counter column and no sequence, so the primary key is the whole of
      // the series' identity.
      'p invoice_sequences_pkey',
      'f invoice_sequences_tenant_fk',
      'c invoice_sequences_document_kind_ck',
      'c invoice_sequences_period_check',
      'c invoice_sequences_format_ck',
    ],
  ],
]);

/** Every index on the five, constraint-backed or not. The read-path indexes are named so a dropped one is a visible regression, not a silent sequential scan. */
const EXPECTED_INDEXES: readonly string[] = [
  'customers.customers_pkey',
  'customers.customers_name_idx',
  'customer_contacts.customer_contacts_pkey',
  'customer_contacts.customer_contacts_no_uq',
  // At most one primary contact per customer — the one uniqueness rule of this
  // slice that is a partial index and not a constraint (`0075:238`).
  'customer_contacts.customer_contacts_one_primary',
  'invoices.invoices_pkey',
  'invoices.invoices_number_uq',
  'invoices.invoices_document_number_uq',
  'invoices.invoices_sale_uq',
  'invoices.invoices_customer_idx',
  'invoices.invoices_issue_idx',
  'invoice_items.invoice_items_pkey',
  'invoice_items.invoice_items_line_uq',
  'invoice_items.invoice_items_invoice_idx',
  'invoice_sequences.invoice_sequences_pkey',
];

/** LAW 6's exact texts, as `pg_get_constraintdef` renders them. */
const EXPECTED_TAX_CHECKS: ReadonlyMap<string, string> = new Map([
  ['invoices.invoices_tax_policy_absent_ck', 'CHECK ((tax_minor = 0))'],
  ['invoice_items.invoice_items_tax_policy_absent_ck', 'CHECK ((tax_minor = 0))'],
]);

// ── the suite ──

describe('GOLD-74 / G-19 — the Phase 4 schema lint, against the live catalogue', () => {
  let owner: Pool;

  beforeAll(async () => {
    await ensurePostgres();
    owner = ownerPool();
  });

  it('LAW 1: the five relations exist, are ordinary tables, and carry tenant_id and business_id as NOT NULL uuid', async () => {
    expect(await relationShapeProblems(owner, RELATIONS)).toEqual([]);
  });

  it('LAW 2: the constraint inventory of each relation is exactly the reviewed set', async () => {
    expect(await constraintInventoryProblems(owner, EXPECTED_CONSTRAINTS)).toEqual([]);
  });

  it('LAW 2: every column every constraint names resolves to a live column of the relation it is attached to', async () => {
    expect(await unresolvedConstraintColumnProblems(owner, RELATIONS)).toEqual([]);
  });

  it('LAW 2: the index inventory is exact, and every key constraint is backed by a unique, valid, unconditional index', async () => {
    expect(await indexInventoryProblems(owner, RELATIONS, EXPECTED_INDEXES)).toEqual([]);
  });

  it('LAW 3: no column of the five is real or double precision', async () => {
    expect(await floatingPointProblems(owner, RELATIONS)).toEqual([]);
  });

  it('LAW 3: every *_minor column is bigint and invoice_items.quantity is numeric(18,4)', async () => {
    expect(await moneyAndQuantityTypeProblems(owner, RELATIONS)).toEqual([]);
  });

  it('LAW 4: no relation of the five carries a column of the forbidden derived-truth vocabulary', async () => {
    expect(await derivedTruthColumnProblems(owner, RELATIONS)).toEqual([]);
  });

  it('LAW 5: the seam allowlist is empty, and S-P4-01 is closed by a VALIDATED invoices_sale_fk rather than exempted', async () => {
    // An entry here would be an unbound reference smuggled in as a list edit.
    // S-P4-01 was the one seam `0075:105-111` declared and `0077:353` closed
    // it, so there is nothing left to exempt.
    expect(SEAM_ALLOWLIST).toEqual([]);
    // And the closure, positively: the exemption is gone because the EDGE is
    // there, not because somebody tidied an array. Read from `pg_constraint`,
    // with `convalidated` asserted — a NOT VALID constraint protects none of
    // the rows already present, which is the whole reason this file has a
    // separate `unvalidated` law.
    const closure = await query<{ conname: string; validated: boolean; def: string }>(
      owner,
      `SELECT c.conname::text AS conname, c.convalidated AS validated, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = r.relnamespace
         CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND r.relname = 'invoices' AND c.contype = 'f' AND a.attname = 'sale_id'`,
      [],
    );
    expect(
      closure.map((r) => r.conname),
      'invoices.sale_id is bound by exactly one foreign key, and it is invoices_sale_fk',
    ).toEqual(['invoices_sale_fk']);
    expect(closure[0]?.validated, 'invoices_sale_fk is VALIDATED — a NOT VALID edge would protect none of the rows already there').toBe(true);
    expect(closure[0]?.def, 'and it is the COMPOSITE edge to sales, so a sale of another business cannot be named').toMatch(
      /FOREIGN KEY \(business_id, sale_id\) REFERENCES sales\(business_id, id\)/,
    );
  });

  it('LAW 5: every *_id column of the financial core is bound, a declared seam, or a catalogue-wide correlation id', async () => {
    const correlation = await discoverCorrelationIdColumns(owner, RELATIONS);
    // The predicate is derived, not asserted: it must actually have found the
    // repository's correlation names, or the exemption is vacuous and the law
    // below would pass for the wrong reason.
    expect([...correlation].sort()).toContain('business_transaction_id');
    expect(await polymorphicReferenceProblems(owner, FINANCIAL_CORE, SEAM_ALLOWLIST, correlation)).toEqual([]);
  });

  it('LAW 6: CHECK (tax_minor = 0) is on both invoices and invoice_items, by exact constraint text', async () => {
    expect(await constraintTextProblems(owner, EXPECTED_TAX_CHECKS)).toEqual([]);
  });
});

/**
 * THE RED PROOFS.
 *
 * A golden that is green because the schema happens to be right proves
 * nothing about the golden. Each test below plants ONE defect in a throwaway
 * database built by `createScratchDb` from the real migrations, points the
 * SAME checking function at it, and requires the function to name the defect.
 * Nothing here touches the shared `daftar` database.
 *
 * The scratch database is built to `0000_extensions.sql` only: these proofs
 * need an empty database with the deployment's roles, not a copy of the
 * schema, and a defect planted beside 75 migrations is a defect nobody can
 * see in the failure message.
 */
describe('GOLD-74 — the red proofs: each law, shown catching its own defect', () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_gold74_schema_lint', { upTo: '0000_extensions.sql', keys: false });
  }, 300_000);

  afterAll(async () => {
    if (scratch !== undefined) await scratch.drop();
  }, 120_000);

  it('RED: a relation whose CHECK names a column it does not have is caught', async () => {
    // PostgreSQL will not BUILD such a constraint — `conkey` holds attribute
    // numbers, so the columns of a constraint it created always resolve. That
    // is precisely the defect class the static SQL parser cannot see and a
    // catalogue read can: a `conkey` entry naming an attribute the relation
    // does not have, however it got there (a hand-edited catalogue, a restore
    // from a divergent dump, an extension). So the proof plants it directly.
    await scratch.pool.query(`
      CREATE TABLE red_check_probe (
        tenant_id   UUID NOT NULL,
        business_id UUID NOT NULL,
        id          UUID NOT NULL,
        amount      BIGINT NOT NULL,
        CONSTRAINT red_check_probe_pkey PRIMARY KEY (business_id, id),
        CONSTRAINT red_check_probe_amount_ck CHECK (amount >= 0)
      )
    `);
    // Sound first: the relation as built passes.
    expect(await unresolvedConstraintColumnProblems(scratch.pool, ['red_check_probe'])).toEqual([]);

    // Attribute 9 is past the end of a four-column relation.
    await scratch.pool.query(`UPDATE pg_constraint SET conkey = '{9}'::smallint[] WHERE conname = 'red_check_probe_amount_ck'`);

    const problems = await unresolvedConstraintColumnProblems(scratch.pool, ['red_check_probe']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('red_check_probe_amount_ck');
    expect(problems[0]).toContain('names attribute 9');
    expect(problems[0]).toContain('not a live column');

    // And the constraint inventory of the same relation is still exact, which
    // is what makes the two halves of LAW 2 different laws: a name-and-type
    // inventory cannot see this at all.
    expect(await constraintInventoryProblems(scratch.pool, new Map([['red_check_probe', ['p red_check_probe_pkey', 'c red_check_probe_amount_ck']]]))).toEqual(
      [],
    );

    // Both directions of the inventory comparison, on the same relation: a
    // constraint the reviewed set names and the catalogue lacks, and a
    // constraint the catalogue holds and the reviewed set does not.
    const drifted = await constraintInventoryProblems(
      scratch.pool,
      new Map([['red_check_probe', ['p red_check_probe_pkey', 'c red_check_probe_amount_never_dropped_ck']]]),
    );
    expect(drifted.join('\n')).toContain('the constraint "c red_check_probe_amount_never_dropped_ck" is gone from the live catalogue');
    expect(drifted.join('\n')).toContain('the unreviewed constraint "c red_check_probe_amount_ck"');
  });

  it('RED: a money column declared double precision is caught, and so is a widened quantity', async () => {
    await scratch.pool.query(`
      CREATE TABLE red_float_probe (
        tenant_id    UUID NOT NULL,
        business_id  UUID NOT NULL,
        id           UUID NOT NULL,
        total_minor  DOUBLE PRECISION NOT NULL,
        rate_minor   REAL NOT NULL,
        quantity     NUMERIC(10,2) NOT NULL,
        CONSTRAINT red_float_probe_pkey PRIMARY KEY (business_id, id)
      )
    `);

    const floats = await floatingPointProblems(scratch.pool, ['red_float_probe']);
    expect(floats).toHaveLength(2);
    expect(floats.join('\n')).toContain('red_float_probe.total_minor is double precision');
    expect(floats.join('\n')).toContain('red_float_probe.rate_minor is real');

    const types = await moneyAndQuantityTypeProblems(scratch.pool, ['red_float_probe']);
    expect(types.join('\n')).toContain('red_float_probe.total_minor is float8, not bigint');
    expect(types.join('\n')).toContain('red_float_probe.rate_minor is float4, not bigint');
    expect(types.join('\n')).toContain('red_float_probe.quantity is numeric(10,2), not numeric(18,4)');

    // The derived-truth vocabulary is a different law and stays quiet here:
    // a float is not a stored balance.
    expect(await derivedTruthColumnProblems(scratch.pool, ['red_float_probe'])).toEqual([]);
  });

  it('RED: an unbound *_id column outside the declared seams is caught as a polymorphic reference', async () => {
    await scratch.pool.query(`
      CREATE TABLE red_poly_probe (
        tenant_id    UUID NOT NULL,
        business_id  UUID NOT NULL,
        id           UUID NOT NULL,
        parent_id    UUID,
        source_id    UUID,
        source_type  TEXT NOT NULL,
        CONSTRAINT red_poly_probe_pkey PRIMARY KEY (business_id, id),
        CONSTRAINT red_poly_probe_parent_fk FOREIGN KEY (business_id, parent_id) REFERENCES red_poly_probe (business_id, id)
      )
    `);
    const correlation = await discoverCorrelationIdColumns(scratch.pool, ['red_poly_probe']);

    const problems = await polymorphicReferenceProblems(scratch.pool, ['red_poly_probe'], [], correlation);
    // tenant_id and business_id are bound by nothing here either, so the law
    // names all three unbound *_id columns and NOT parent_id, which the
    // catalogue shows bound by red_poly_probe_parent_fk.
    expect(problems.join('\n')).toContain('red_poly_probe.source_id carries no foreign key');
    expect(problems.some((p) => p.includes('red_poly_probe.parent_id'))).toBe(false);

    // And the seam allowlist is what makes a declared seam pass: naming
    // source_id as a seam silences exactly that one column and nothing else.
    const withSeam = await polymorphicReferenceProblems(scratch.pool, ['red_poly_probe'], ['red_poly_probe.source_id'], correlation);
    expect(withSeam.some((p) => p.includes('red_poly_probe.source_id'))).toBe(false);
    expect(withSeam.length).toBe(problems.length - 1);
  });
});
