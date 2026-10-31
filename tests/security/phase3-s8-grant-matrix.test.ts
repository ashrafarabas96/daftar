/**
 * P3-S8 T-04 — THE RUNTIME GRANT MATRIX OVER THE DISCOVERED PHASE 3 SURFACE
 * (docs/PHASE_3_S8_CONTRACT.md A-07, A-09, A-20; PM-19, PM-42).
 *
 * `infrastructure/database/phase3-runtime-grant-model.json` is the INTENDED
 * model. This suite compares it with the live catalogue in BOTH directions —
 * a model entry the database lacks is a broken deployment, a live grant the
 * model lacks is an unreviewed privilege — over sets it DISCOVERS
 * (tests/helpers/phase3-surface.ts): the Phase 3 tables, columns and
 * routines, and the runtime principals. Then it proves the negative half by
 * USE: every runtime credential attempts real DML on every Phase 3 table and
 * is refused with 42501, and none can create a temporary or a public table.
 *
 * Also here:
 *   - the Phase 3 columns on pre-Phase-3 tables: the runtime DML on those
 *     tables is exactly the frozen Phase 1 set (the same at 0052 and now), and
 *     a raw `daftar_app` UPDATE of each Phase 3 column is refused by its named
 *     invoker guard with its stable code (L:1595);
 *   - no runtime principal is a member of an internal role (PM-42);
 *   - OD-03: the Phase 3 scope carries no tax column beyond the policy-held
 *     `tax_minor` and the supplier's text tax identifier (A-20), and every
 *     tax column anywhere else in `public` is held to OD-03's structural zero;
 *   - NEGATIVE CONTROL: a scratch `GRANT INSERT ON supplier_payments TO
 *     daftar_app` is reported by the same comparison, and the real INSERT is
 *     then no longer refused for privilege.
 *
 * ── P4-AL-88: which claims are scoped and which are not ──────────────────
 *
 * Three assertions here were exact equalities over `phase3Tables()` /
 * `phase3Columns()`, which are the complement of the accepted Phase 2 prefix
 * — Phase 3 AND every phase after it. An exact equality over that set is a
 * closure rule ("no later phase adds a relation"), not an invariant, and the
 * first Phase 4 relation makes it red for reasons that have nothing to do
 * with what P3-S8 bought (`[[daftar-a-closure-rule-is-not-an-invariant]]`).
 *
 * They are re-expressed over the Phase 3 SCOPE — the relations and columns
 * the accepted, digest-verified files `0053`–`0073` create, which a later
 * phase cannot enter because `0000`–`0073` is frozen byte for byte
 * (P4-AL-85) — and each keeps "and nothing more" about that scope by also
 * asserting that every relation those files create is LIVE and that the
 * scope and its complement PARTITION the discovered surface. So a missing
 * Phase 3 table, an edited Phase 3 migration and an unaccounted relation are
 * all still red.
 *
 * The three LAWS are deliberately NOT scoped, because Phase 4 wants them
 * applied to its own tables: the model/catalogue deviation sweep, the
 * forbidden-privilege sweep and the by-USE DML refusal sweep keep running
 * over the whole discovered surface. That is not a claim about the future —
 * it is a law over whatever exists, and the model is a file in the tree that
 * the migration adding a table amends in the same commit. §17.3's refused
 * shortcut is the opposite one: an ALLOWLIST of Phase 4 names, which would
 * assert nothing.
 *
 * OD-03 is the sharp one and is handled in its own section below.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { must, seedS3World, type S3Business } from '../helpers/inventory-commands';
import {
  beyondPhase3Columns,
  beyondPhase3Tables,
  phase3Columns,
  phase3PrefixColumns,
  phase3PrefixRelations,
  phase3Routines,
  phase3ScopeColumns,
  phase3ScopeTables,
  phase3Tables,
  prefixCatalogue,
  runtimePrincipals,
  PREFIX_DB,
  INVENTORY_INTERNAL,
  ACCOUNTING_INTERNAL,
} from '../helpers/phase3-surface';
import { PROBE_RELATIONS } from '../helpers/phase4-probe-relations';
import { createScratchDb, scratchPool, urlOf, type ScratchDb, type ScratchRole } from '../helpers/scratch-db';
import { expectRefused, settle, type Outcome, type Queryable } from '../helpers/stock-ledger';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';

interface GrantModel {
  phase3Tables: string[];
  runtimePrincipals: string[];
  forbiddenPrivileges: string[];
  select: Record<string, { tables: string[]; columns: Record<string, string[]> }>;
  execute: Record<string, string[]>;
  phase3ColumnsOnPrePhase3Tables: Record<string, { columns: string[]; guard: string }>;
  prePhase3TableRuntimePrivileges: Record<string, Record<string, string[]> | string>;
}

const model = JSON.parse(readFileSync(join(__dirname, '../../infrastructure/database/phase3-runtime-grant-model.json'), 'utf8')) as GrantModel;

/**
 * The columns A-20 admits: the S4 policy-held `tax_minor` (held at zero by
 * `purchases_tax_policy_absent_ck`) and the supplier's tax identifier — a
 * text, both on the supplier and as the purchase's snapshot of it — never an
 * amount. Their types are asserted too.
 */
const PINNED_TAX_COLUMNS = ['purchases.supplier_tax_identifier_snapshot', 'purchases.tax_minor', 'suppliers.tax_identifier'];
const PINNED_TAX_TYPES = { 'purchases.supplier_tax_identifier_snapshot': 'text', 'purchases.tax_minor': 'bigint', 'suppliers.tax_identifier': 'text' };
const TAX_COLUMN = /(^|_)tax(_|$)/;
/** The same predicate, for the catalogue to apply: `attname ~ '(^|_)tax(_|$)'`. */
const TAX_COLUMN_SQL = String.raw`(^|_)tax(_|$)`;

/**
 * ── OD-03, stated structurally (lock §13: P4-AL-44, P4-AL-45; A-20) ──────
 *
 * What A-20 bought was NOT "only these three names exist": it was "while
 * OD-03 is open, no tax column exists that nobody reviewed, and no tax
 * AMOUNT can be non-zero". The first half was written as an exact equality
 * over `phase3Tables()`, which is the complement of the Phase 2 prefix — so
 * `invoices.tax_minor`, which the lock §13 explicitly AUTHORISES, would have
 * turned an accepted Phase 3 gate red.
 *
 * The re-expression keeps both halves and adds the third one OD-03 actually
 * turns on:
 *
 *   (a) the three Phase 3 columns stay pinned BY NAME, with their types and
 *       with `purchases_tax_policy_absent_ck` read out of the catalogue —
 *       unchanged, over the Phase 3 SCOPE;
 *   (b) every other tax-named column ANYWHERE in `public` is held to OD-03's
 *       STRUCTURAL ZERO: it must be a `bigint` minor-units amount, NOT NULL,
 *       and covered by a CHECK on that column ALONE whose definition pins it
 *       to `= 0`. That is exactly the shape P4-AL-44 authorises for
 *       `invoices.tax_minor` and `invoice_items.tax_minor`, and exactly the
 *       shape Phase 3's own `purchases.tax_minor` already has, so the pinned
 *       column and the generic law agree;
 *   (c) so a tax column of any OTHER shape — a rate, a percentage, a
 *       jurisdiction text, a nullable amount, an amount with no CHECK, or an
 *       amount whose CHECK pins something else — is a PROBLEM wherever it
 *       appears, in any phase. It is NOT an allowlist: nothing is permitted
 *       by being named, only by being structurally zero.
 *
 * This is strictly stronger than an allowlist (§17.3 refuses those) and
 * strictly stronger than the old equality on everything except the one case
 * the lock decided: a reviewed, structurally-zero Phase 4 tax amount.
 */
interface TaxColumnRow {
  col: string;
  typ: string;
  notnull: boolean;
  checks: string[];
}

/** Every tax-named column of every relation in `public`, with the shape OD-03 judges. */
async function taxColumns(q: Queryable): Promise<TaxColumnRow[]> {
  const r = await q.query<TaxColumnRow>(
    `SELECT c.relname || '.' || a.attname AS col,
            format_type(a.atttypid, a.atttypmod) AS typ,
            a.attnotnull AS notnull,
            coalesce((SELECT array_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname)
                        FROM pg_constraint k
                       WHERE k.conrelid = c.oid AND k.contype = 'c' AND k.conkey = ARRAY[a.attnum]), '{}') AS checks
       FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attname ~ $1
      ORDER BY 1`,
    [TAX_COLUMN_SQL],
  );
  return r.rows;
}

/** Whether one of `checks` pins `column` to zero on its own: `CHECK ((<column> = 0))`. */
function pinnedToZero(column: string, checks: readonly string[]): boolean {
  const re = new RegExp(String.raw`^CHECK\s*\(+\s*${column}\s*=\s*0\s*\)+$`);
  return checks.some((d) => re.test(d));
}

/**
 * The OD-03 violations among the tax columns of `q`: every tax column that is
 * neither one of the three A-20 reviewed by name nor a structural zero.
 * An empty list is a pass.
 */
async function od03Problems(q: Queryable): Promise<string[]> {
  const pinned = new Set(PINNED_TAX_COLUMNS);
  const out: string[] = [];
  for (const row of await taxColumns(q)) {
    if (pinned.has(row.col)) continue;
    const column = row.col.slice(row.col.indexOf('.') + 1);
    if (row.typ !== 'bigint') out.push(`${row.col}: a tax column of type ${row.typ} — OD-03 admits a bigint minor-units amount held at zero, nothing else`);
    else if (!row.notnull) out.push(`${row.col}: a nullable tax amount — a NULL is not a structural zero`);
    else if (!pinnedToZero(column, row.checks))
      out.push(`${row.col}: a tax amount with no CHECK (${column} = 0) — OD-03 is open, so it must be structurally zero`);
  }
  return out;
}
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const;

function isRole(p: string): p is ScratchRole {
  return p.startsWith('daftar_');
}

/** `grantee → "PRIV table"` / `"PRIV table.column"` exactly as the ACLs hold them (PUBLIC as grantee 0). */
async function aclGrants(q: Queryable, tables: readonly string[], grantees: readonly string[]): Promise<string[]> {
  const r = await q.query<{ g: string }>(
    `WITH who AS (SELECT r.name, CASE WHEN r.name = 'public' THEN 0::oid ELSE to_regrole(r.name)::oid END AS oid FROM unnest($2::text[]) r(name))
     SELECT w.name || ' ' || x.privilege_type || ' ' || c.relname AS g
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x JOIN who w ON w.oid = x.grantee
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[])
     UNION ALL
     SELECT w.name || ' ' || x.privilege_type || ' ' || c.relname || '.' || a.attname
       FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            CROSS JOIN LATERAL aclexplode(a.attacl) x JOIN who w ON w.oid = x.grantee
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[])`,
    [tables, grantees],
  );
  return r.rows.map((x) => x.g).sort();
}

/** What the model says the ACLs hold for `grantees` on the Phase 3 tables. */
function modelGrants(grantees: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of grantees) {
    const s = model.select[g];
    if (s === undefined) throw new Error(`the model has no select entry for ${g}`);
    for (const t of s.tables) out.push(`${g} SELECT ${t}`);
    for (const [t, cols] of Object.entries(s.columns)) for (const c of cols) out.push(`${g} SELECT ${t}.${c}`);
  }
  return out.sort();
}

/**
 * Every deviation between the model and the catalogue read on `q`, both
 * directions, for the table grants (ACL and effective privilege) and the
 * Phase 3 EXECUTE grants. An empty list is agreement.
 */
async function deviations(q: Queryable): Promise<string[]> {
  const out: string[] = [];
  const tables = await phase3Tables(q);
  const grantees = [...model.runtimePrincipals, 'public'];
  const live = await aclGrants(q, tables, grantees);
  const want = modelGrants(grantees);
  for (const g of live) if (!want.includes(g)) out.push(`UNREVIEWED ${g}`);
  for (const g of want) if (!live.includes(g)) out.push(`MISSING ${g}`);
  // Effective privilege, table and column level, for every principal and PUBLIC.
  const eff = await q.query<{ p: string; t: string; priv: string; tbl: boolean; col: boolean }>(
    `SELECT p.name AS p, t.name AS t, v.priv,
            has_table_privilege(p.name, 'public.' || t.name, v.priv) AS tbl,
            CASE WHEN v.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') THEN has_any_column_privilege(p.name, 'public.' || t.name, v.priv) ELSE false END AS col
       FROM unnest($1::text[]) p(name), unnest($2::text[]) t(name), unnest($3::text[]) v(priv)`,
    [grantees, tables, [...TABLE_PRIVILEGES]],
  );
  for (const r of eff.rows) {
    const s = model.select[r.p];
    const tableSelect = s?.tables.includes(r.t) === true;
    const columnSelect = s !== undefined && Object.prototype.hasOwnProperty.call(s.columns, r.t);
    const expectTable = r.priv === 'SELECT' && tableSelect;
    const expectColumn = r.priv === 'SELECT' && (tableSelect || columnSelect);
    if (r.tbl !== expectTable) out.push(`EFFECTIVE ${r.p} ${r.priv} ${r.t} table=${r.tbl}`);
    if (r.col !== expectColumn && (COLUMN_PRIVILEGES as readonly string[]).includes(r.priv)) out.push(`EFFECTIVE ${r.p} ${r.priv} ${r.t} column=${r.col}`);
  }
  // EXECUTE on every Phase 3 routine, per principal and PUBLIC, both directions.
  const routines = await phase3Routines(q);
  const unresolved = await q.query<{ sig: string }>(`SELECT s.sig FROM unnest($1::text[]) s(sig) WHERE to_regprocedure('public.' || s.sig) IS NULL`, [
    routines.map((x) => x.sig),
  ]);
  for (const r of unresolved.rows) out.push(`UNRESOLVED ${r.sig}`);
  const ex = await q.query<{ p: string; sig: string }>(
    `SELECT p.name AS p, s.sig FROM unnest($1::text[]) p(name), unnest($2::text[]) s(sig)
      WHERE has_function_privilege(p.name, to_regprocedure('public.' || s.sig), 'EXECUTE')`,
    [grantees, routines.map((x) => x.sig)],
  );
  const liveExec = ex.rows.map((x) => `${x.p} EXECUTE ${x.sig}`).sort();
  const wantExec = grantees.flatMap((g) => (model.execute[g] ?? []).map((sig) => `${g} EXECUTE ${sig}`)).sort();
  for (const g of liveExec) if (!wantExec.includes(g)) out.push(`UNREVIEWED ${g}`);
  for (const g of wantExec) if (!liveExec.includes(g)) out.push(`MISSING ${g}`);
  return out.sort();
}

/** `sql` as `role` on `db`, inside a transaction that is always rolled back. */
async function attempt(role: ScratchRole, sql: string, db = 'daftar', gucs: Readonly<Record<string, string>> = {}): Promise<Outcome<unknown>> {
  const c = new Client({ connectionString: urlOf(db, role) });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(gucs)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    return await settle(() => c.query(sql));
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

let A: S3Business;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  A = (await seedS3World(ownerPool(), 't04')).A;
  await prefixCatalogue();
}, 300_000);

afterAll(async () => {
  await resetData();
});

describe('T-04 — the discovered surface is the model’s, over the Phase 3 scope (A-03, A-07, A-09; P4-AL-88)', () => {
  it('the Phase 3 scope of phase3Tables() is exactly the model’s tables, all of them live, and the scope partitions the surface', async () => {
    const surface = await phase3Tables();
    const scope = await phase3ScopeTables();
    const beyond = await beyondPhase3Tables();
    const want = [...model.phase3Tables].sort();
    const created = [...phase3PrefixRelations()].sort();
    // (1) EXACT, over a scope a later phase cannot enter: the relations the
    //     accepted, digest-verified files 0053-0073 create. An edited prefix
    //     file empties that reader, which empties the scope, which fails here.
    expect(scope).toEqual(want);
    // (2) "AND NOTHING MORE" about that scope, in the other direction: every
    //     relation those files create is LIVE. A dropped Phase 3 table fails
    //     here as well as at (1), and (1) + (2) together pin the accepted
    //     Phase 3 files to exactly the model's 48 names.
    expect(created.filter((t) => !surface.includes(t))).toEqual([]);
    expect(created).toEqual(want);
    // (3) The two halves PARTITION the surface — disjoint, and together all
    //     of it — so no relation escapes between the scoped claim and the
    //     laws below, which run over the whole surface.
    expect(scope.filter((t) => beyond.includes(t))).toEqual([]);
    expect([...scope, ...beyond].sort()).toEqual(surface);
  });

  it('runtimePrincipals() equals the seven of L:1660, and the model names the same seven', async () => {
    expect(await runtimePrincipals()).toEqual([...model.runtimePrincipals].sort());
    expect(model.runtimePrincipals).toHaveLength(7);
  });

  it('the Phase 3 scope of phase3Columns() is exactly the model’s, all of them live, and the scope partitions the set', async () => {
    const want = Object.entries(model.phase3ColumnsOnPrePhase3Tables)
      .flatMap(([t, v]) => v.columns.map((c) => `${t}.${c}`))
      .sort();
    const all = await phase3Columns();
    const scope = await phase3ScopeColumns();
    const beyond = await beyondPhase3Columns();
    // The same three halves as the relations above. The scope here is every
    // `table.column` an accepted 0053-0073 file ADDs, read from its
    // digest-verified text; the surface is what the live catalogue holds.
    expect(scope).toEqual(want);
    const declared = [...phase3PrefixColumns()].sort();
    expect(declared.filter((c) => !all.includes(c))).toEqual([]);
    expect(declared).toEqual(want);
    expect(scope.filter((c) => beyond.includes(c))).toEqual([]);
    expect([...scope, ...beyond].sort()).toEqual(all);
  });
});

describe('T-04 — model ↔ catalogue, both directions (A-07)', () => {
  it('no deviation: every ACL entry, every effective table and column privilege, and every Phase 3 EXECUTE is the model’s', async () => {
    expect(await deviations(ownerPool())).toEqual([]);
  });

  it('no runtime principal or PUBLIC holds any forbidden privilege on any Phase 3 table, at table or column level', async () => {
    const tables = await phase3Tables();
    const r = await ownerPool().query<{ v: string }>(
      `SELECT p.name || ' ' || v.priv || ' ' || t.name AS v
         FROM unnest($1::text[]) p(name), unnest($2::text[]) t(name), unnest($3::text[]) v(priv)
        WHERE has_table_privilege(p.name, 'public.' || t.name, v.priv)
           OR (v.priv IN ('INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(p.name, 'public.' || t.name, v.priv))`,
      [[...model.runtimePrincipals, 'public'], tables, model.forbiddenPrivileges],
    );
    expect(r.rows.map((x) => x.v)).toEqual([]);
    expect([...model.forbiddenPrivileges].sort()).toEqual(['DELETE', 'INSERT', 'REFERENCES', 'TRIGGER', 'TRUNCATE', 'UPDATE']);
  });

  it('no runtime principal is a member of either internal principal (PM-42, over runtimePrincipals())', async () => {
    const r = await ownerPool().query<{ m: string }>(
      `SELECT p.name || ' ∈ ' || i.name AS m FROM unnest($1::text[]) p(name), unnest($2::text[]) i(name) WHERE pg_has_role(p.name, i.name, 'MEMBER')`,
      [await runtimePrincipals(), [INVENTORY_INTERNAL, ACCOUNTING_INTERNAL]],
    );
    expect(r.rows.map((x) => x.m)).toEqual([]);
  });
});

describe('T-04 — the negative half by USE: real DML from every runtime credential on every Phase 3 table (A-07)', () => {
  it('INSERT, UPDATE, DELETE and TRUNCATE are each refused with 42501, for every principal on every table', async () => {
    const tables = await phase3Tables();
    const firstColumn = new Map(
      (
        await ownerPool().query<{ t: string; c: string }>(
          `SELECT DISTINCT ON (c.relname) c.relname::text AS t, a.attname::text AS c
             FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) ORDER BY c.relname, a.attnum`,
          [tables],
        )
      ).rows.map((x) => [x.t, x.c] as const),
    );
    const accepted: string[] = [];
    for (const role of model.runtimePrincipals) {
      if (!isRole(role)) throw new Error(`${role} is not a daftar role`);
      const c = new Client({ connectionString: urlOf('daftar', role) });
      await c.connect();
      try {
        for (const t of tables) {
          const col = must(firstColumn.get(t), `a column of ${t}`);
          for (const sql of [`INSERT INTO ${t} DEFAULT VALUES`, `UPDATE ${t} SET ${col} = ${col}`, `DELETE FROM ${t}`, `TRUNCATE ${t}`]) {
            await c.query('BEGIN');
            const o = await settle(() => c.query(sql));
            await c.query('ROLLBACK');
            if (o.ok || o.sqlstate !== '42501') accepted.push(`${role}: ${sql} → ${o.ok ? 'ACCEPTED' : o.sqlstate}`);
          }
        }
      } finally {
        await c.end();
      }
    }
    expect(accepted).toEqual([]);
  });
});

describe('T-04 — TEMP and CREATE on public stay zero for all seven (A-09)', () => {
  it('no TEMPORARY on the database, no CREATE on public, by the catalogue', async () => {
    const r = await ownerPool().query<{ p: string; temp: boolean; create: boolean }>(
      `SELECT p.name AS p, has_database_privilege(p.name, current_database(), 'TEMPORARY') AS temp, has_schema_privilege(p.name, 'public', 'CREATE') AS create
         FROM unnest($1::text[]) p(name) ORDER BY 1`,
      [await runtimePrincipals()],
    );
    expect(r.rows.filter((x) => x.temp || x.create)).toEqual([]);
    expect(r.rows).toHaveLength(7);
  });

  for (const role of model.runtimePrincipals) {
    it(`${role}: a real CREATE TEMP TABLE and CREATE TABLE public.x are refused with 42501`, async () => {
      if (!isRole(role)) throw new Error(`${role} is not a daftar role`);
      expectRefused(await attempt(role, `CREATE TEMP TABLE t04_probe (x int)`), '42501', null, `${role}: TEMP`);
      expectRefused(await attempt(role, `CREATE TABLE public.t04_probe (x int)`), '42501', null, `${role}: public`);
    });
  }
});

describe('T-04 — Phase 3 columns on pre-Phase-3 tables (A-07, L:1595)', () => {
  it('the runtime table-level DML on those tables is exactly the frozen Phase 1 set, the same at 0052 and now', async () => {
    const pre = scratchPool(urlOf(PREFIX_DB), 1);
    const read = async (q: Queryable): Promise<Record<string, Record<string, string[]>>> => {
      const out: Record<string, Record<string, string[]>> = {};
      for (const t of Object.keys(model.phase3ColumnsOnPrePhase3Tables)) {
        const r = await q.query<{ p: string; priv: string }>(
          `SELECT p.name AS p, v.priv FROM unnest($1::text[]) p(name), unnest($2::text[]) v(priv)
            WHERE has_table_privilege(p.name, 'public.' || $3, v.priv) ORDER BY 1, 2`,
          [model.runtimePrincipals, [...TABLE_PRIVILEGES], t],
        );
        const perTable: Record<string, string[]> = {};
        for (const x of r.rows) (perTable[x.p] ??= []).push(x.priv);
        out[t] = perTable;
      }
      return out;
    };
    try {
      const now = await read(ownerPool());
      expect(now).toEqual(await read(pre));
      const want: Record<string, Record<string, string[]>> = {};
      for (const t of Object.keys(model.phase3ColumnsOnPrePhase3Tables)) {
        const v = model.prePhase3TableRuntimePrivileges[t];
        if (v === undefined || typeof v === 'string') throw new Error(`no runtime privileges stated for ${t}`);
        want[t] = Object.fromEntries(Object.entries(v).map(([p, privs]) => [p, [...privs].sort()]));
      }
      expect(now).toEqual(want);
    } finally {
      await pre.end();
    }
  });

  it('a raw daftar_app UPDATE of each Phase 3 column is refused by its named guard with its stable code', async () => {
    const scope = { 'app.tenant_id': A.tenantId, 'app.business_id': A.businessId };
    const base = must(
      (await ownerPool().query<{ id: string }>(`SELECT id FROM product_variants WHERE product_id = $1 AND is_base`, [A.piece.productId])).rows[0],
      'the base variant',
    ).id;
    const cases: readonly (readonly [string, string, string, string])[] = [
      [
        'products.track_inventory',
        `UPDATE products SET track_inventory = false WHERE id = '${A.piece.productId}'`,
        'products_10_inventory_config_authority',
        'inventory.configuration_authority_required',
      ],
      [
        'products.unit_code',
        `UPDATE products SET unit_code = 'metre' WHERE id = '${A.piece.productId}'`,
        'products_10_inventory_config_authority',
        'inventory.configuration_authority_required',
      ],
      [
        'products.unit_decimals',
        `UPDATE products SET unit_decimals = 2 WHERE id = '${A.piece.productId}'`,
        'products_10_inventory_config_authority',
        'inventory.configuration_authority_required',
      ],
      [
        'product_variants.is_base',
        `UPDATE product_variants SET is_base = false WHERE id = '${base}'`,
        'product_variants_10_base_variant_authority',
        'catalog.base_variant_not_mutable',
      ],
    ];
    // Every Phase 3 column is covered, and each case names the model's guard.
    // Scoped to the Phase 3 columns (P4-AL-88): a column a later phase adds to
    // a pre-Phase-3 table gets its own slice's guard case, and its absence
    // here is not a Phase 3 defect. The scope's own "and nothing more" is
    // asserted above.
    expect(cases.map(([col]) => col).sort()).toEqual(await phase3ScopeColumns());
    for (const [col, sql, guard, code] of cases) {
      const table = col.slice(0, col.indexOf('.'));
      expect(model.phase3ColumnsOnPrePhase3Tables[table]?.guard, col).toBe(guard);
      expectRefused(await attempt('daftar_app', sql, 'daftar', scope), 'P0001', code, col);
    }
  });
});

describe('T-04 — OD-03 stays bounded: no invented tax column, and no tax amount that is not structurally zero (A-20, P4-AL-44)', () => {
  it('the Phase 3 scope carries exactly the three pinned tax columns, with their types', async () => {
    const tables = await phase3ScopeTables();
    const r = await ownerPool().query<{ c: string }>(
      `SELECT c.relname || '.' || a.attname AS c FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) ORDER BY 1`,
      [tables],
    );
    const onTables = r.rows.map((x) => x.c).filter((c) => TAX_COLUMN.test(c.slice(c.indexOf('.') + 1)));
    const onColumns = (await phase3ScopeColumns()).filter((c) => TAX_COLUMN.test(c.slice(c.indexOf('.') + 1)));
    expect([...onTables, ...onColumns].sort()).toEqual(PINNED_TAX_COLUMNS);
    const types = await ownerPool().query<{ c: string; t: string }>(
      `SELECT c.relname || '.' || a.attname AS c, format_type(a.atttypid, a.atttypmod) AS t
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relnamespace = 'public'::regnamespace AND (c.relname || '.' || a.attname) = ANY ($1::text[])`,
      [PINNED_TAX_COLUMNS],
    );
    expect(Object.fromEntries(types.rows.map((x) => [x.c, x.t]))).toEqual(PINNED_TAX_TYPES);
    expect(
      must(
        (await ownerPool().query<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'purchases_tax_policy_absent_ck'`))
          .rows[0],
      ).d,
    ).toMatch(/tax_minor = 0/);
  });

  it('every tax column anywhere in public is either one of the three or a structural zero — bigint, NOT NULL, CHECK (… = 0)', async () => {
    expect(await od03Problems(ownerPool())).toEqual([]);
    // The law and the pin agree on Phase 3's own amount column: drop it from
    // the pinned set and `purchases.tax_minor` still passes the generic rule,
    // which is what makes (b) a re-expression of (a) rather than a hole
    // beside it.
    const purchases = (await taxColumns(ownerPool())).find((x) => x.col === 'purchases.tax_minor');
    expect(purchases?.typ).toBe('bigint');
    expect(purchases?.notnull).toBe(true);
    expect(pinnedToZero('tax_minor', purchases?.checks ?? [])).toBe(true);
  });

  it('the recogniser: a rate, a nullable amount, an unconstrained amount and a wrongly-pinned amount are each a problem', () => {
    // Pure unit cases for `pinnedToZero`, so the shape the law admits is
    // pinned independently of what any database happens to hold.
    expect(pinnedToZero('tax_minor', ['CHECK ((tax_minor = 0))'])).toBe(true);
    expect(pinnedToZero('tax_minor', ['CHECK (tax_minor = 0)'])).toBe(true);
    expect(pinnedToZero('tax_minor', [])).toBe(false);
    expect(pinnedToZero('tax_minor', ['CHECK ((tax_minor >= 0))'])).toBe(false);
    expect(pinnedToZero('tax_minor', ['CHECK ((tax_minor = 0) OR (tax_minor = 1))'])).toBe(false);
    expect(pinnedToZero('tax_minor', ['CHECK ((total_minor = 0))'])).toBe(false);
  });
});

describe('T-04 NEGATIVE CONTROL — a scratch runtime INSERT grant is reported, and the INSERT then passes the privilege check', () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p3s8_t04_nc');
    // The comparison below is model-vs-catalogue in BOTH directions, so the
    // scratch database has to present the surface the model describes — and it
    // must present it because THIS CHECKOUT'S MIGRATIONS BUILT IT, never
    // because a fixture supplied what they failed to build. A fixture that
    // creates a relation the grant model records is a fixture that can hide
    // the one failure this comparison exists to catch: migrations that never
    // built the relation at all, for which `deviations()` would then report no
    // MISSING entry. So the requirement is stated positively and a tree that
    // does not satisfy it is refused here rather than quietly repaired.
    const built = new Set(await phase3Tables(scratch.pool));
    expect(
      PROBE_RELATIONS.filter((r) => !built.has(r)),
      "this checkout's migrations did not build the relations the grant model records beyond the Phase 3 scope",
    ).toEqual([]);
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  it('as shipped the scratch database agrees with the model; after GRANT INSERT ON supplier_payments TO daftar_app exactly that grant is reported', async () => {
    expect(await deviations(scratch.pool)).toEqual([]);
    const shipped = await attempt('daftar_app', `INSERT INTO supplier_payments DEFAULT VALUES`, scratch.name);
    expectRefused(shipped, '42501', null, 'as shipped');
    expect(shipped.ok ? '' : shipped.message).toMatch(/permission denied for table supplier_payments/);
    await scratch.pool.query(`GRANT INSERT ON supplier_payments TO daftar_app`);
    expect(await deviations(scratch.pool)).toEqual([
      'EFFECTIVE daftar_app INSERT supplier_payments column=true',
      'EFFECTIVE daftar_app INSERT supplier_payments table=true',
      'UNREVIEWED daftar_app INSERT supplier_payments',
    ]);
    // Row security still stands behind the grant (it answers 42501 too), so the
    // privilege refusal is told apart by what refused: before the grant the
    // table's privilege, after it no longer.
    const o = await attempt('daftar_app', `INSERT INTO supplier_payments DEFAULT VALUES`, scratch.name);
    expect(o.ok ? 'ACCEPTED' : o.message, 'the table privilege no longer refuses').not.toMatch(/permission denied for table supplier_payments/);
  });
});

/**
 * ── The P4-AL-88 proof, on the REAL relations of the phase that follows ──
 *
 * The re-expressions above are proved, not asserted, and in both directions —
 * one direction alone would be a claim. The subjects are the actual relations
 * and routines the first Phase 4 migration created in the database these
 * suites run on, discovered here (`beyondPhase3Tables()`) rather than named,
 * so this block carries no Phase 4 name and cannot rot into an allowlist
 * (§17.3).
 *
 *   GREEN, read-only: they are inside the discovered surface and outside the
 *   Phase 3 scope; the three UNSCOPED laws reach them and are satisfied by
 *   them, the DML refusal proved by USE with real credentials.
 *
 *   RED, inside a transaction that is always rolled back: a missing Phase 3
 *   relation, an unreviewed grant (on a relation beyond the scope AND on a
 *   Phase 3 one), a tax amount whose CHECK is gone, a tax column of the wrong
 *   shape, and an unreviewed tax column on a Phase 3 relation. Each is named
 *   by the assertion that is supposed to name it.
 *
 * Every plant is DDL inside `BEGIN … ROLLBACK` on one dedicated connection —
 * the estate's rule for the shared database — so nothing is left behind.
 */
describe('T-04 P4-AL-88 — the re-expressed claims, proved on the relations of the phase that follows', () => {
  /** One dedicated owner connection: a plant must be visible to the law that judges it. */
  let owner: PoolClient;

  beforeAll(async () => {
    owner = await ownerPool().connect();
  });

  afterAll(() => {
    owner.release();
  });

  /** Run `body` with `plant` applied, always rolled back. */
  const planted = async (plant: readonly string[], body: () => Promise<void>): Promise<void> => {
    await owner.query('BEGIN');
    try {
      for (const sql of plant) await owner.query(sql);
      await body();
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  };

  /** The forbidden-privilege sweep of `:200`, as a function of the surface it is given. */
  const forbidden = async (q: Queryable, tables: readonly string[]): Promise<string[]> =>
    (
      await q.query<{ v: string }>(
        `SELECT p.name || ' ' || v.priv || ' ' || t.name AS v
           FROM unnest($1::text[]) p(name), unnest($2::text[]) t(name), unnest($3::text[]) v(priv)
          WHERE has_table_privilege(p.name, 'public.' || t.name, v.priv)
             OR (v.priv IN ('INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege(p.name, 'public.' || t.name, v.priv))`,
        [[...model.runtimePrincipals, 'public'], tables, model.forbiddenPrivileges],
      )
    ).rows.map((x) => x.v);

  it('the surface really did grow: the laws below are not running over Phase 3 alone', async () => {
    const surface = await phase3Tables();
    const scope = await phase3ScopeTables();
    const beyond = await beyondPhase3Tables();
    // Discovered, never named: this is the whole reason the laws need no edit.
    expect(beyond.length, 'no relation beyond the Phase 3 scope exists, so nothing below proves anything').toBeGreaterThan(0);
    for (const t of beyond) {
      expect(surface, t).toContain(t);
      expect(scope, t).not.toContain(t);
    }
    expect(surface.length).toBe(scope.length + beyond.length);
    expect(scope).toEqual([...model.phase3Tables].sort());
  });

  it('GREEN: the three unscoped laws reach those relations and are satisfied by them', async () => {
    const beyond = await beyondPhase3Tables();
    // (a) model <-> catalogue, both directions, over the WHOLE surface: their
    //     SELECT and EXECUTE grants are recorded in the model and match.
    expect(await deviations(ownerPool())).toEqual([]);
    // (b) no forbidden privilege for any principal or PUBLIC, on them.
    expect(await forbidden(ownerPool(), beyond)).toEqual([]);
    // (c) by USE: real DML from every runtime credential on every one of them
    //     is refused with 42501. This is the protection Phase 4 wants applied
    //     to its own tables, and it is why the sweep is NOT scoped.
    const firstColumn = new Map(
      (
        await ownerPool().query<{ t: string; c: string }>(
          `SELECT DISTINCT ON (c.relname) c.relname::text AS t, a.attname::text AS c
             FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) ORDER BY c.relname, a.attnum`,
          [beyond],
        )
      ).rows.map((x) => [x.t, x.c] as const),
    );
    const accepted: string[] = [];
    for (const role of model.runtimePrincipals) {
      if (!isRole(role)) throw new Error(`${role} is not a daftar role`);
      for (const t of beyond) {
        const col = must(firstColumn.get(t), `a column of ${t}`);
        for (const sql of [`INSERT INTO ${t} DEFAULT VALUES`, `UPDATE ${t} SET ${col} = ${col}`, `DELETE FROM ${t}`, `TRUNCATE ${t}`]) {
          const o = await attempt(role, sql);
          if (o.ok || o.sqlstate !== '42501') accepted.push(`${role}: ${sql} -> ${o.ok ? 'ACCEPTED' : o.sqlstate}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  }, 300_000);

  it('RED: a missing Phase 3 relation is named, although the later phase’s relations are present', async () => {
    await planted([`ALTER TABLE unit_names RENAME TO unit_names_moved_away`], async () => {
      const surface = await phase3Tables(owner);
      const scope = await phase3ScopeTables(owner);
      // Both halves of the re-expression fail, and the second names the
      // relation the accepted Phase 3 files create and the catalogue lost.
      expect(scope).not.toEqual([...model.phase3Tables].sort());
      expect([...phase3PrefixRelations()].sort().filter((t) => !surface.includes(t))).toEqual(['unit_names']);
      // And the later phase's relations are still there, so this is a Phase 3
      // failure and not an artefact of the scope being empty.
      expect((await beyondPhase3Tables(owner)).length).toBeGreaterThan(0);
    });
    expect(await phase3ScopeTables()).toEqual([...model.phase3Tables].sort());
  });

  it('RED: an unreviewed grant is named — on a Phase 3 relation AND on one beyond the scope', async () => {
    // The PHASE 3 half: a forbidden privilege on a Phase 3 relation.
    await planted([`GRANT INSERT ON suppliers TO daftar_app`], async () => {
      expect(await forbidden(owner, await phase3Tables(owner))).toEqual(['daftar_app INSERT suppliers']);
      expect((await deviations(owner)).filter((d) => d.includes('suppliers'))).toEqual([
        'EFFECTIVE daftar_app INSERT suppliers column=true',
        'EFFECTIVE daftar_app INSERT suppliers table=true',
        'UNREVIEWED daftar_app INSERT suppliers',
      ]);
    });
    // The half beyond the scope, which is why the law is not scoped: a grant
    // to a principal the model does not record it for is reported there too.
    const target = must((await beyondPhase3Tables())[0], 'a relation beyond the Phase 3 scope');
    await planted([`GRANT SELECT ON ${target} TO daftar_worker`], async () => {
      expect(await deviations(owner)).toEqual([
        `EFFECTIVE daftar_worker SELECT ${target} column=true`,
        `EFFECTIVE daftar_worker SELECT ${target} table=true`,
        `UNREVIEWED daftar_worker SELECT ${target}`,
      ]);
    });
    // And a WRITE privilege on one of them is refused by the forbidden sweep.
    await planted([`GRANT UPDATE ON ${target} TO daftar_app`], async () => {
      expect(await forbidden(owner, await beyondPhase3Tables(owner))).toEqual([`daftar_app UPDATE ${target}`]);
    });
    expect(await deviations(ownerPool())).toEqual([]);
  }, 120_000);

  it('GREEN then RED: OD-03 admits the reviewed structural zero and refuses every other tax column, in either phase', async () => {
    // GREEN. The later phase's tax amounts exist, and they are HELD to the
    // rule rather than permitted by being named.
    expect(await od03Problems(ownerPool())).toEqual([]);
    const beyondScope = new Set(await beyondPhase3Tables());
    const cols = await taxColumns(ownerPool());
    const beyondTax = cols.filter((x) => beyondScope.has(x.col.slice(0, x.col.indexOf('.'))));
    expect(beyondTax.length, 'no tax column beyond the Phase 3 scope exists, so the law below is untested').toBeGreaterThan(0);
    for (const row of beyondTax) {
      expect(row.typ, row.col).toBe('bigint');
      expect(row.notnull, row.col).toBe(true);
      expect(pinnedToZero(row.col.slice(row.col.indexOf('.') + 1), row.checks), row.col).toBe(true);
    }
    // And the Phase 3 pin is unmoved.
    const scopeTables = await phase3ScopeTables();
    expect(
      cols
        .filter((x) => scopeTables.includes(x.col.slice(0, x.col.indexOf('.'))))
        .map((x) => x.col)
        .sort(),
    ).toEqual(PINNED_TAX_COLUMNS);

    // RED (1): the CHECK removed from an authorised tax amount beyond the
    // scope. This is the whole difference between "held to the OD-03 rule"
    // and "permitted".
    const victim = must(beyondTax[0], 'a tax amount beyond the Phase 3 scope');
    const table = victim.col.slice(0, victim.col.indexOf('.'));
    const column = victim.col.slice(victim.col.indexOf('.') + 1);
    const conname = must(
      (
        await ownerPool().query<{ n: string }>(
          `SELECT k.conname::text AS n FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
            WHERE c.relnamespace = 'public'::regnamespace AND c.relname = $1 AND k.contype = 'c'
              AND pg_get_constraintdef(k.oid) ~ ('^CHECK \\(+' || $2 || ' = 0\\)+$')`,
          [table, column],
        )
      ).rows[0],
      `the zero CHECK on ${victim.col}`,
    ).n;
    await planted([`ALTER TABLE ${table} DROP CONSTRAINT ${conname}`], async () => {
      expect(await od03Problems(owner)).toEqual([`${victim.col}: a tax amount with no CHECK (${column} = 0) — OD-03 is open, so it must be structurally zero`]);
    });

    // RED (2): a tax column nobody reviewed, beyond the scope — a RATE, which
    // no CHECK could make into a structural zero amount.
    await planted([`ALTER TABLE ${table} ADD COLUMN tax_rate NUMERIC(6,4)`], async () => {
      expect(await od03Problems(owner)).toEqual([
        `${table}.tax_rate: a tax column of type numeric(6,4) — OD-03 admits a bigint minor-units amount held at zero, nothing else`,
      ]);
    });

    // RED (3): a nullable amount — a NULL is not a zero.
    await planted([`ALTER TABLE ${table} ADD COLUMN withholding_tax_minor BIGINT`], async () => {
      expect(await od03Problems(owner)).toEqual([`${table}.withholding_tax_minor: a nullable tax amount — a NULL is not a structural zero`]);
    });

    // RED (4): the PHASE 3 half — an unreviewed tax column on a Phase 3
    // relation fails the scoped pin AND the structural law.
    await planted([`ALTER TABLE purchases ADD COLUMN tax_jurisdiction TEXT`], async () => {
      const after = await taxColumns(owner);
      const inScope = after.filter((x) => scopeTables.includes(x.col.slice(0, x.col.indexOf('.')))).map((x) => x.col);
      expect(inScope.sort()).not.toEqual(PINNED_TAX_COLUMNS);
      expect(await od03Problems(owner)).toEqual([
        'purchases.tax_jurisdiction: a tax column of type text — OD-03 admits a bigint minor-units amount held at zero, nothing else',
      ]);
    });
    expect(await od03Problems(ownerPool())).toEqual([]);
  }, 120_000);
});

/**
 * ── The grant model's beyond-scope entries are exactly what a successor grants ──
 *
 * `deviations()` compares the model with the catalogue in BOTH directions, so
 * an entry recorded here for a relation the tree's migrations do not build is
 * reported as MISSING — a broken deployment, which is the correct reading and
 * must not be weakened. That makes the model and the migration set one
 * reviewable unit: they land together or the suite is red, deliberately.
 *
 * This is the proof that the recorded entries ARE what a successor grants,
 * independently of which migrations a given checkout happens to carry: a
 * scratch database is built from the real files, brought to the model's
 * surface by the fixture where the files do not already build it, and
 * `deviations()` must then be EMPTY — and must still report a planted grant.
 */
describe('T-04 P4-AL-88 — the model’s beyond-scope entries match what a successor grants', () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p4s1_t04_model', { keys: false });
    // Built by this checkout's own migrations, never supplied by a fixture —
    // see the T-04 negative control above for why that distinction is the
    // whole point of a two-directional comparison.
    for (const relation of PROBE_RELATIONS) expect(await phase3Tables(scratch.pool), relation).toContain(relation);
  }, 300_000);

  afterAll(async () => {
    await scratch.drop();
  });

  it('with the successor’s relations and grants present, the model and the catalogue agree in both directions', async () => {
    expect(await deviations(scratch.pool)).toEqual([]);
    // And the scoped inventory is untouched by them.
    expect(await phase3ScopeTables(scratch.pool)).toEqual([...model.phase3Tables].sort());
    expect((await beyondPhase3Tables(scratch.pool)).length).toBeGreaterThanOrEqual(PROBE_RELATIONS.length);
    // OD-03 admits the successor's tax amounts because they are structurally
    // zero, and for no other reason.
    expect(await od03Problems(scratch.pool)).toEqual([]);
  }, 120_000);

  it('a grant the model does not record is still reported on one of the successor’s relations', async () => {
    await scratch.pool.query(`GRANT SELECT ON invoices TO daftar_worker`);
    try {
      expect(await deviations(scratch.pool)).toEqual([
        'EFFECTIVE daftar_worker SELECT invoices column=true',
        'EFFECTIVE daftar_worker SELECT invoices table=true',
        'UNREVIEWED daftar_worker SELECT invoices',
      ]);
    } finally {
      await scratch.pool.query(`REVOKE SELECT ON invoices FROM daftar_worker`);
    }
    expect(await deviations(scratch.pool)).toEqual([]);
  }, 120_000);
});
