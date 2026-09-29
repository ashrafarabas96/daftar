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
 *   - OD-03: no Phase 3 table carries a tax column beyond the policy-held
 *     `tax_minor` and the supplier's text tax identifier (A-20);
 *   - NEGATIVE CONTROL: a scratch `GRANT INSERT ON supplier_payments TO
 *     daftar_app` is reported by the same comparison, and the real INSERT is
 *     then no longer refused for privilege.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { must, seedS3World, type S3Business } from '../helpers/inventory-commands';
import {
  phase3Columns,
  phase3Routines,
  phase3Tables,
  prefixCatalogue,
  runtimePrincipals,
  PREFIX_DB,
  INVENTORY_INTERNAL,
  ACCOUNTING_INTERNAL,
} from '../helpers/phase3-surface';
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

describe('T-04 — the discovered surface is the model’s (A-03, A-07, A-09)', () => {
  it('phase3Tables() equals the model’s Phase 3 tables', async () => {
    expect(await phase3Tables()).toEqual([...model.phase3Tables].sort());
  });

  it('runtimePrincipals() equals the seven of L:1660, and the model names the same seven', async () => {
    expect(await runtimePrincipals()).toEqual([...model.runtimePrincipals].sort());
    expect(model.runtimePrincipals).toHaveLength(7);
  });

  it('the Phase 3 columns on pre-Phase-3 tables are exactly the model’s', async () => {
    const want = Object.entries(model.phase3ColumnsOnPrePhase3Tables)
      .flatMap(([t, v]) => v.columns.map((c) => `${t}.${c}`))
      .sort();
    expect(await phase3Columns()).toEqual(want);
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
    expect(cases.map(([col]) => col).sort()).toEqual(await phase3Columns());
    for (const [col, sql, guard, code] of cases) {
      const table = col.slice(0, col.indexOf('.'));
      expect(model.phase3ColumnsOnPrePhase3Tables[table]?.guard, col).toBe(guard);
      expectRefused(await attempt('daftar_app', sql, 'daftar', scope), 'P0001', code, col);
    }
  });
});

describe('T-04 — OD-03 stays bounded: no invented tax column (A-20)', () => {
  it('the only tax-named columns are tax_minor (held at zero) and the supplier tax identifier text, with their types', async () => {
    const tables = await phase3Tables();
    const r = await ownerPool().query<{ c: string }>(
      `SELECT c.relname || '.' || a.attname AS c FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1::text[]) ORDER BY 1`,
      [tables],
    );
    const onTables = r.rows.map((x) => x.c).filter((c) => TAX_COLUMN.test(c.slice(c.indexOf('.') + 1)));
    const onColumns = (await phase3Columns()).filter((c) => TAX_COLUMN.test(c.slice(c.indexOf('.') + 1)));
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
});

describe('T-04 NEGATIVE CONTROL — a scratch runtime INSERT grant is reported, and the INSERT then passes the privilege check', () => {
  let scratch: ScratchDb;

  beforeAll(async () => {
    scratch = await createScratchDb('daftar_p3s8_t04_nc');
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
