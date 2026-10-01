/**
 * P3-S7 T-01 — NO CACHE, NO PROJECTION, NO NEW GRANT (docs
 * PHASE_3_S7_CONTRACT §2(2), A-03, §6 T-01; Annex R #26).
 *
 * Against the migrated database, the catalogue end state S7 promises:
 *   - no materialized view in `public`;
 *   - the views of `public` are exactly `{credential_deliveries_safe}`;
 *   - no UNLOGGED table;
 *   - no table, view or materialized view named like a balance, summary,
 *     snapshot, cache or projection, but the named exceptions:
 *     `stock_levels` (`STOCK_CACHE_EXCEPTION`) and the Phase 2 opening-balance
 *     document tables, which the contract's list missed (they are source
 *     documents, not derived balances);
 *   - the `daftar_app` privilege matrix is the S6 end state: S7 adds no
 *     grant. The matrix (relation, column, routine, schema and default
 *     privileges, and role memberships) is pinned by digest as it stands on
 *     migrations 0000–0068, which S7 does not touch; the per-object S6 detail
 *     is `tests/security/settlement-s6-grants.test.ts` (and its S4/S5
 *     siblings). `MAINTAIN` is left out: PostgreSQL 17 added it, and the
 *     suite runs on 16 and 18.
 * Negative: a materialized view, a cache-named table, an UNLOGGED table, a
 * second view and one more `daftar_app` grant, all made inside a
 * rolled-back transaction, are each reported.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePostgres, ownerPool, resetData } from '../helpers/test-app';
import { rolledBack, type Queryable } from '../helpers/inventory-commands';
import { STOCK_CACHE_EXCEPTION, phase4InheritedPrefixRelations } from '../../scripts/guards/no-authoritative-balance';

const CACHE_NAME = /balance|summary|snapshot|cache|projection/;

/**
 * The relations the name rule meets that are not caches, as the S6 end state
 * holds them: `stock_levels`, the one cache the lock allows, and the Phase 2
 * opening-balance DOCUMENT and its lines — the merchant's stated opening
 * figures, posted to the journal like any source document, not a derived
 * balance. A closed list: any other name is a breach.
 */
const NAMED_EXCEPTIONS: readonly string[] = [STOCK_CACHE_EXCEPTION, 'accounting_opening_balance_lines', 'accounting_opening_balances'];

/** Every breach of the §2(2) catalogue end state, as readable lines; empty when there is none. */
async function catalogueViolations(q: Queryable): Promise<string[]> {
  const out: string[] = [];
  const matviews = await q.query<{ name: string }>("SELECT matviewname AS name FROM pg_matviews WHERE schemaname = 'public' ORDER BY 1");
  for (const r of matviews.rows) out.push(`materialized view ${r.name}`);
  const views = await q.query<{ name: string }>("SELECT viewname AS name FROM pg_views WHERE schemaname = 'public' ORDER BY 1");
  const viewNames = views.rows.map((r) => r.name);
  if (JSON.stringify(viewNames) !== JSON.stringify(['credential_deliveries_safe'])) out.push(`views ${viewNames.join(',')}`);
  const unlogged = await q.query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relpersistence = 'u' ORDER BY 1`,
  );
  for (const r of unlogged.rows) out.push(`unlogged ${r.name}`);
  const relations = await q.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY 1`,
  );
  for (const r of relations.rows) if (CACHE_NAME.test(r.name) && !NAMED_EXCEPTIONS.includes(r.name)) out.push(`cache-named ${r.name}`);
  return out;
}

/** Every privilege `daftar_app` holds by grant, one sorted line each (`MAINTAIN` excluded, see the header). */
async function appPrivilegeMatrix(q: Queryable): Promise<string[]> {
  const r = await q.query<{ line: string }>(
    `WITH app AS (SELECT oid FROM pg_roles WHERE rolname = 'daftar_app')
     SELECT line FROM (
       SELECT 'relation ' || n.nspname || '.' || c.relname || ' ' || a.privilege_type || CASE WHEN a.is_grantable THEN ' +grant' ELSE '' END AS line
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE a.grantee = (SELECT oid FROM app) AND a.privilege_type <> 'MAINTAIN'
       UNION ALL
       SELECT 'column ' || n.nspname || '.' || c.relname || '.' || at.attname || ' ' || a.privilege_type
         FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(at.attacl) a
        WHERE a.grantee = (SELECT oid FROM app)
       UNION ALL
       SELECT 'routine ' || p.oid::regprocedure::text || ' ' || a.privilege_type
         FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE a.grantee = (SELECT oid FROM app)
       UNION ALL
       SELECT 'schema ' || n.nspname || ' ' || a.privilege_type
         FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
        WHERE a.grantee = (SELECT oid FROM app)
       UNION ALL
       SELECT 'default ' || d.defaclobjtype::text || ' ' || a.privilege_type
         FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE a.grantee = (SELECT oid FROM app) AND a.privilege_type <> 'MAINTAIN'
       UNION ALL
       SELECT 'member of ' || g.rolname
         FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
        WHERE m.member = (SELECT oid FROM app)
     ) x ORDER BY line COLLATE "C"`,
  );
  return r.rows.map((x) => x.line);
}

function digest(lines: readonly string[]): { readonly lines: number; readonly sha256: string } {
  return { lines: lines.length, sha256: createHash('sha256').update(lines.join('\n')).digest('hex') };
}

/**
 * The `daftar_app` matrix at the S6 freeze (migrations 0000–0068 as frozen at
 * 59ddc5b; S7 changes none of them).
 */
const S6_END_STATE = { lines: 174, sha256: '3a93790f2cdf58aec4bc286a2639e14513bf8ef04642e3efb59f8791f534c1c4' } as const;

/**
 * Phase 3 corrective (0072, TD-16): the two grants the residue write-off adds
 * to `daftar_app` — read its rows, execute its one signed routine. Named
 * line for line, so the S6 end state stays pinned by its digest and nothing
 * else may appear.
 */
const P3C_APP_GRANTS = [
  'relation public.purchase_residue_write_offs SELECT',
  'routine purchase_write_off_residue(uuid,date,text,bigint,bigint,bigint) EXECUTE',
] as const;

/**
 * P4-S1 (0075): the nine grants the first Phase 4 migration adds to
 * `daftar_app` — SELECT on the five relations and EXECUTE on the four read
 * functions. Named line for line, by the SAME mechanism `P3C_APP_GRANTS`
 * above already uses, and for the same reason: the S6 digest stays pinned
 * byte for byte and nothing that is not named here may appear.
 *
 * This is the re-expression the digest needed, not a loosening of it. Had the
 * digest been widened, or recomputed to today's value, a tenth grant would
 * have slipped in silently; as it is, the S6 end state is still absolute and
 * every grant after it is enumerated. Note what is NOT here: no INSERT, no
 * UPDATE, no DELETE. `daftar_app` reads the Phase 4 surface and writes none of
 * it, and the absence of those lines from this list is the assertion.
 */
const P4_S1_APP_GRANTS = [
  'relation public.customer_contacts SELECT',
  'relation public.customers SELECT',
  'relation public.invoice_items SELECT',
  'relation public.invoice_sequences SELECT',
  'relation public.invoices SELECT',
  'routine customer_ar_aging(uuid,uuid,date,integer[]) EXECUTE',
  'routine customer_ar_outstanding(uuid,uuid) EXECUTE',
  'routine invoice_outstanding(uuid,uuid) EXECUTE',
  'routine invoice_settlement_state(uuid,uuid) EXECUTE',
] as const;

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
});

afterAll(async () => {
  await resetData();
});

describe('T-01 the catalogue end state', () => {
  it('no materialized view, the one view, no UNLOGGED table, no cache-named relation but stock_levels', async () => {
    expect(await catalogueViolations(ownerPool())).toEqual([]);
    const stock = await ownerPool().query("SELECT 1 FROM pg_class WHERE relname = 'stock_levels' AND relkind = 'r'");
    expect(stock.rowCount, 'the named exception exists and is a plain table').toBe(1);
  });

  it('the daftar_app privilege matrix is the S6 end state: S7 adds no grant (the corrective pass adds exactly its two)', async () => {
    const all = await appPrivilegeMatrix(ownerPool());
    for (const g of [...P3C_APP_GRANTS, ...P4_S1_APP_GRANTS]) expect(all, g).toContain(g);
    /**
     * No DML on ANY relation beyond the accepted inherited prefix, asserted
     * over the whole matrix rather than by the absence of a line from the list
     * above — and with the relations DISCOVERED rather than named, so this
     * covers every later Phase 4 relation without being edited, and names none
     * of them. A literal alternation of Phase 4 relation names beside an
     * equality is itself the P4-AL-88 shape, and
     * `tests/security/phase4-forward-evolution.test.ts` is right to refuse it
     * — it refused the first form of this very assertion.
     *
     * The right-hand side is empty, which makes this a LAW rather than an
     * inventory: it grows to cover each new relation the moment its migration
     * exists.
     */
    const inherited = phase4InheritedPrefixRelations();
    expect(inherited.size, 'the prefix reader is empty — the law below would be vacuous').toBeGreaterThan(0);
    expect(
      all.filter((l) => {
        if (!/ (INSERT|UPDATE|DELETE|TRUNCATE)$/.test(l)) return false;
        const relation = /^relation (?:public\.)?([a-z_][a-z0-9_]*) /.exec(l)?.[1];
        return relation !== undefined && !inherited.has(relation);
      }),
      'daftar_app writes a relation the accepted inherited prefix did not create',
    ).toEqual([]);
    const named = new Set<string>([...P3C_APP_GRANTS, ...P4_S1_APP_GRANTS]);
    const matrix = all.filter((l) => !named.has(l));
    expect(
      matrix.some((l) => l.startsWith('relation public.stock_levels SELECT')),
      'the matrix reads real grants',
    ).toBe(true);
    expect(
      matrix.filter((l) => / (INSERT|UPDATE|DELETE|TRUNCATE)$/.test(l) && l.startsWith('relation public.stock_')),
      'no stock DML',
    ).toEqual([]);
    expect(digest(matrix)).toEqual(S6_END_STATE);
  });

  it('negative: a matview, a cache-named table, an UNLOGGED table, a view and a new grant made in a rolled-back transaction are each reported', async () => {
    const before = digest(await appPrivilegeMatrix(ownerPool()));
    const seen = await rolledBack(async (c) => {
      await c.query('CREATE MATERIALIZED VIEW s7_probe_mv AS SELECT 1 AS one');
      await c.query('CREATE TABLE supplier_balance_probe (id int)');
      await c.query('CREATE UNLOGGED TABLE s7_probe_unlogged (id int)');
      await c.query('CREATE VIEW s7_probe_view AS SELECT 1 AS one');
      await c.query('GRANT SELECT ON supplier_balance_probe TO daftar_app');
      return { violations: await catalogueViolations(c), matrix: digest(await appPrivilegeMatrix(c)) };
    });
    expect(seen.violations).toEqual([
      'materialized view s7_probe_mv',
      'views credential_deliveries_safe,s7_probe_view',
      'unlogged public.s7_probe_unlogged',
      'cache-named supplier_balance_probe',
    ]);
    expect(seen.matrix.lines, 'one more grant').toBe(before.lines + 1);
    expect(seen.matrix.sha256).not.toBe(before.sha256);
    expect(await catalogueViolations(ownerPool()), 'rolled back').toEqual([]);
  });
});
