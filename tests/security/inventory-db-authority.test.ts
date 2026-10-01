import { randomBytes, randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { phase4InheritedPrefixRelations } from '../../scripts/guards/no-authoritative-balance';
import {
  appDbUrl,
  ensurePostgres,
  identityDbUrl,
  ownerPool,
  platformDbUrl,
  provisionerDbUrl,
  resetData,
  resolverDbUrl,
  workerDbUrl,
} from '../helpers/test-app';

/**
 * P3-S1 — THE INVENTORY PRINCIPAL AND ITS GRANT MATRIX (P3-AL-54 §A-§H).
 *
 * Every fact here is read from the live catalogue — pg_roles,
 * pg_auth_members, information_schema and pg_policy — or proven by a raw
 * connection trying the thing and being refused. Nothing goes through the
 * application.
 *
 * The routines themselves (assertion consumption, the three entry commands,
 * the warehouse lifecycle and TD-09) are proven in
 * tests/integration/inventory-db-routines.test.ts; the §D definer contract in
 * tests/security/search-path-shadowing.test.ts.
 */

const INTERNAL = 'daftar_inventory_internal';
const RUNTIME_ROLES = [
  'daftar_app',
  'daftar_platform',
  'daftar_worker',
  'daftar_identity',
  'daftar_resolver',
  'daftar_provisioner',
  'daftar_reconciler',
] as const;
const NEW_TABLES = ['units', 'unit_names', 'inventory_operation_kinds', 'inventory_assertion_keys', 'inventory_assertion_uses', 'branch_warehouses'] as const;

interface Fixture {
  tenantA: string;
  businessA: string;
  branchA: string;
  warehouseA: string;
  productA: string;
  tenantB: string;
  businessB: string;
  branchB: string;
  warehouseB: string;
}
let fx: Fixture;

async function one(sql: string, params: unknown[] = []): Promise<string> {
  const r = await ownerPool().query<{ id: string }>(sql, params);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`fixture statement returned no id: ${sql}`);
  return id;
}

async function seedBusiness(slug: string): Promise<{ tenant: string; business: string; branch: string; warehouse: string }> {
  const tenant = await one(`INSERT INTO tenants DEFAULT VALUES RETURNING id`);
  const business = await one(
    `INSERT INTO businesses (tenant_id, name, store_slug, country_code, base_currency, timezone)
     VALUES ($1, $2, $3, 'PS', 'ILS', 'Asia/Hebron') RETURNING id`,
    [tenant, `Inventory ${slug}`, `inv-auth-${slug}-${Date.now()}`],
  );
  const branch = await one(`INSERT INTO branches (business_id, name, is_default) VALUES ($1, 'Main', true) RETURNING id`, [business]);
  const warehouse = await one(`INSERT INTO warehouses (business_id, branch_id, name, is_default) VALUES ($1, $2, 'Main WH', true) RETURNING id`, [
    business,
    branch,
  ]);
  return { tenant, business, branch, warehouse };
}

/** A committed, unconfigured product with its one required translation (the translation check is deferred). */
async function createProduct(business: string): Promise<string> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    const id = randomUUID();
    await c.query(`INSERT INTO products (business_id, id, base_price_minor, price_currency) VALUES ($1, $2, 1000, 'ILS')`, [business, id]);
    await c.query(`INSERT INTO product_translations (business_id, product_id, locale, name) VALUES ($1, $2, 'en', 'Inventory test product')`, [business, id]);
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** A raw connection as a runtime role, in one transaction with the given transaction-local GUCs, always rolled back. */
async function asRole<T>(url: string, gucs: Record<string, string>, run: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(gucs)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    return await run(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

/** The superuser, `SET LOCAL ROLE` to the internal principal — how every entry routine's body runs — always rolled back. */
async function asInternal<T>(gucs: Record<string, string>, run: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await ownerPool().connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(gucs)) await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    await c.query(`SET LOCAL ROLE ${INTERNAL}`);
    return await run(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** The error message of `run`, or null when it succeeded. */
async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const scopeA = (): Record<string, string> => ({ 'app.tenant_id': fx.tenantA, 'app.business_id': fx.businessA });

beforeAll(async () => {
  await ensurePostgres();
  await resetData();
  const a = await seedBusiness('a');
  const b = await seedBusiness('b');
  const productA = await createProduct(a.business);
  fx = {
    tenantA: a.tenant,
    businessA: a.business,
    branchA: a.branch,
    warehouseA: a.warehouse,
    productA,
    tenantB: b.tenant,
    businessB: b.business,
    branchB: b.branch,
    warehouseB: b.warehouse,
  };
});

describe('the inventory principal (P3-AL-54 §A, must-prove 5-7)', () => {
  it('is NOLOGIN NOINHERIT, has no password, and holds no role attribute', async () => {
    const r = await ownerPool().query(
      `SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolpassword IS NULL AS no_password
       FROM pg_authid WHERE rolname = $1`,
      [INTERNAL],
    );
    expect(r.rows).toEqual([
      {
        rolcanlogin: false,
        rolinherit: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        no_password: true,
      },
    ]);
  });

  it('has exactly one member — the migrator, WITH INHERIT FALSE, SET TRUE, no ADMIN — and is a member of nothing', async () => {
    const members = await ownerPool().query(
      `SELECT m.rolname AS member, a.inherit_option, a.set_option, a.admin_option
       FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
       WHERE r.rolname = $1`,
      [INTERNAL],
    );
    expect(members.rows).toEqual([{ member: 'daftar_migrator', inherit_option: false, set_option: true, admin_option: false }]);

    const memberOf = await ownerPool().query(
      `SELECT r.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE m.rolname = $1`,
      [INTERNAL],
    );
    expect(memberOf.rows).toEqual([]);
  });

  it.each(RUNTIME_ROLES)('%s cannot reach the principal by membership, inheritance or SET ROLE', async (role) => {
    const r = await ownerPool().query<{ member: boolean; usage: boolean; set: boolean }>(
      `SELECT pg_has_role($1, $2, 'MEMBER') AS member, pg_has_role($1, $2, 'USAGE') AS usage, pg_has_role($1, $2, 'SET') AS set`,
      [role, INTERNAL],
    );
    expect(r.rows[0]).toEqual({ member: false, usage: false, set: false });
  });

  it('a stolen daftar_app credential cannot SET ROLE to it', async () => {
    const message = await asRole(appDbUrl, {}, (c) => refusal(() => c.query(`SET ROLE ${INTERNAL}`)));
    expect(message).toMatch(/permission denied to set role/i);
  });

  it('holds no TEMPORARY and no CREATE on schema public, and USAGE only', async () => {
    const r = await ownerPool().query(
      `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS temp,
              has_database_privilege($1, current_database(), 'CREATE') AS dbcreate,
              has_schema_privilege($1, 'public', 'CREATE') AS create,
              has_schema_privilege($1, 'public', 'USAGE') AS usage`,
      [INTERNAL],
    );
    expect(r.rows[0]).toEqual({ temp: false, dbcreate: false, create: false, usage: true });
  });
});

describe('the §H grant matrix, from information_schema and pg_policy (P3-AL-54 §H)', () => {
  it('the internal principal holds exactly these table privileges on the accepted prefix’s relations, and SELECT and nothing else beyond them', async () => {
    const r = await ownerPool().query<{ t: string; p: string }>(
      `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
       FROM information_schema.role_table_grants WHERE grantee = $1 GROUP BY table_name ORDER BY table_name`,
      [INTERNAL],
    );
    /**
     * P4-AL-88. This map was asserted over EVERY table the principal holds a
     * privilege on, which made it a claim about the phase that follows: the
     * first later-phase relation granted SELECT to this principal turns an
     * accepted Phase 3 suite red although nothing about the Phase 3 authority
     * changed (`[[daftar-a-closure-rule-is-not-an-invariant]]`).
     *
     * It is scoped by POSITION — which accepted prefix created the relation,
     * read from the digest-verified files by
     * `phase4InheritedPrefixRelations()`; `0000`-`0073` is frozen byte for
     * byte (P4-AL-85), so a later phase cannot enter that scope — and the map
     * below is unchanged, entry for entry.
     *
     * "And nothing more" is kept by a PARTITION plus a POSITIVE claim about
     * the rest: on a relation no accepted prefix created, this principal holds
     * SELECT and nothing else. That is not an allowlist — it is the same
     * authority contract this file exists for, stated for the relations it
     * cannot name: the writes belong to the signed routines, so a later
     * migration that hands this principal INSERT, UPDATE or DELETE on its own
     * relation is RED here and must be reviewed, exactly as every Phase 3
     * write in the map below was.
     *
     * An emptied (tampered) prefix reader makes the scope empty, which makes
     * the map assertion red rather than vacuous.
     */
    const prefixRelations = phase4InheritedPrefixRelations();
    expect(prefixRelations.size, 'the digest-verified prefix reader came back empty').toBeGreaterThan(0);
    const live = Object.fromEntries(r.rows.map((x) => [x.t, x.p] as const));
    const inScope = Object.fromEntries(Object.entries(live).filter(([t]) => prefixRelations.has(t)));
    const beyond = Object.fromEntries(Object.entries(live).filter(([t]) => !prefixRelations.has(t)));
    expect(
      Object.keys(inScope).filter((t) => t in beyond),
      'the two scopes are disjoint',
    ).toEqual([]);
    expect([...Object.keys(inScope), ...Object.keys(beyond)].sort(), 'and together they are every table').toEqual(Object.keys(live).sort());
    expect(
      Object.entries(beyond).filter(([, p]) => p !== 'SELECT'),
      'beyond the accepted prefix this principal reads and never writes: the writes belong to the signed routines',
    ).toEqual([]);
    expect(inScope).toEqual({
      audit_events: 'INSERT',
      branch_warehouses: 'DELETE,INSERT,SELECT',
      branches: 'SELECT',
      businesses: 'SELECT',
      inventory_assertion_keys: 'INSERT,SELECT,UPDATE',
      inventory_assertion_uses: 'DELETE,INSERT,SELECT',
      inventory_operation_kinds: 'SELECT',
      product_variants: 'SELECT',
      products: 'SELECT',
      units: 'SELECT',
      warehouses: 'SELECT',
      // P3-S2 (0059, contract ruling A-01): the owner of the movement primitive
      // holds exactly the writes that primitive performs, and reads the rest.
      inventory_operation_movement_kinds: 'SELECT',
      negative_inventory_deficits: 'SELECT',
      stock_levels: 'INSERT,SELECT',
      stock_movement_kinds: 'SELECT',
      stock_movements: 'INSERT,SELECT',
      // P3-S3 (0061/0062, contract A-18): the eight source documents and the
      // four bridges are written by the signed routines only; SELECT on the
      // bindings for the completeness triggers; INSERT on the outbox.
      stock_source_bindings: 'INSERT,SELECT',
      inventory_adjustment_lines: 'INSERT,SELECT',
      inventory_adjustments: 'INSERT,SELECT',
      inventory_opening_lines: 'INSERT,SELECT',
      inventory_openings: 'INSERT,SELECT',
      inventory_transfer_lines: 'INSERT,SELECT',
      inventory_transfers: 'INSERT,SELECT',
      stocktake_lines: 'INSERT,SELECT',
      stocktakes: 'INSERT,SELECT',
      stock_source_bridge_inventory_adjustment: 'INSERT,SELECT',
      stock_source_bridge_inventory_opening: 'INSERT,SELECT',
      stock_source_bridge_inventory_transfer: 'INSERT,SELECT',
      stock_source_bridge_stocktake: 'INSERT,SELECT',
      outbox_events: 'INSERT',
      // P3-S4 (0063/0064, contract A-18): the six S4 tables and the two
      // bridges are written by the signed routines only; DELETE on the three
      // draft-replaced children (the freeze triggers refuse it past a draft);
      // INSERT on the coverage detail; SELECT on currencies (minor units).
      suppliers: 'INSERT,SELECT',
      purchases: 'INSERT,SELECT',
      purchase_lines: 'DELETE,INSERT,SELECT',
      purchase_landed_costs: 'DELETE,INSERT,SELECT',
      purchase_landed_cost_allocations: 'DELETE,INSERT,SELECT',
      negative_inventory_cost_adjustments: 'INSERT,SELECT',
      stock_source_bridge_purchase: 'INSERT,SELECT',
      stock_source_bridge_negative_inventory_cost_adjustment: 'INSERT,SELECT',
      negative_deficit_coverages: 'INSERT,SELECT',
      currencies: 'SELECT',
      // P3-S5 (0065/0066, contract A-18): the five S5 documents and the two
      // bridges are written by the signed routines only, insert-only: no
      // UPDATE and no DELETE anywhere.
      supplier_returns: 'INSERT,SELECT',
      supplier_return_lines: 'INSERT,SELECT',
      supplier_credit_notes: 'INSERT,SELECT',
      purchase_reversals: 'INSERT,SELECT',
      purchase_reversal_lines: 'INSERT,SELECT',
      stock_source_bridge_supplier_return: 'INSERT,SELECT',
      stock_source_bridge_purchase_reversal: 'INSERT,SELECT',
      // P3-S6 (0067/0068, contract A-17): the six S6 tables are written by the
      // signed routines only, insert-only, except DELETE on the method names
      // (a name removed by an update); the column UPDATEs follow below.
      payment_methods: 'INSERT,SELECT',
      payment_method_names: 'DELETE,INSERT,SELECT',
      supplier_payments: 'INSERT,SELECT',
      supplier_payment_allocations: 'INSERT,SELECT',
      supplier_credit_allocations: 'INSERT,SELECT',
      supplier_refunds: 'INSERT,SELECT',
      // Phase 3 corrective (0072, TD-16 R-96): the residue write-off is written
      // by its signed routine only, insert-only: no UPDATE and no DELETE.
      purchase_residue_write_offs: 'INSERT,SELECT',
    });
  });

  it('and exactly these column privileges beyond them: three products columns to UPDATE, four product_variants columns to INSERT, four stock_levels columns to UPDATE (P3-S2), six stocktake_lines and nine stocktakes columns to UPDATE (P3-S3), two negative_inventory_deficits, two purchase_lines, thirty purchases and eleven suppliers columns to UPDATE (P3-S4), nine payment_methods, one payment_method_names and two supplier_credit_notes columns to UPDATE (P3-S6)', async () => {
    const r = await ownerPool().query<{ t: string; p: string; cols: string }>(
      `SELECT c.table_name AS t, c.privilege_type AS p, string_agg(c.column_name, ',' ORDER BY c.column_name) AS cols
       FROM information_schema.column_privileges c
       WHERE c.grantee = $1
         AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                          WHERE g.grantee = c.grantee AND g.table_name = c.table_name AND g.privilege_type = c.privilege_type)
       GROUP BY 1, 2 ORDER BY 1, 2`,
      [INTERNAL],
    );
    expect(r.rows).toEqual([
      // P3-S4 (0063, contract A-18): the coverage decrements a deficit layer.
      { t: 'negative_inventory_deficits', p: 'UPDATE', cols: 'status,uncovered_qty' },
      // P3-S6 (0067, contract A-17): a method's mutable fields and its names'
      // display text, rewritten by the update/deactivate/activate routines.
      { t: 'payment_method_names', p: 'UPDATE', cols: 'display_name' },
      {
        t: 'payment_methods',
        p: 'UPDATE',
        cols: 'business_transaction_id,is_active,last_intent_sha256,posting_account_id,requires_reference,revision,sort_order,updated_at,updated_by',
      },
      { t: 'product_variants', p: 'INSERT', cols: 'business_id,id,is_base,product_id' },
      { t: 'products', p: 'UPDATE', cols: 'track_inventory,unit_code,unit_decimals' },
      // P3-S4 (0063, contract A-18): a line's share and unit cost, set once by
      // its receipt; the draft columns and the receive/cancel columns (§2.2).
      { t: 'purchase_lines', p: 'UPDATE', cols: 'base_share_minor,unit_cost_base_minor' },
      {
        t: 'purchases',
        p: 'UPDATE',
        cols:
          'binding_source_id,business_transaction_id,cancel_intent_sha256,cancelled_at,cancelled_by,currency_code,document_date,draft_intent_sha256,' +
          'fx_rate_id,landed_cost_txn_minor,notes,rate_source,rate_timestamp,receive_intent_sha256,received_at,received_by,revision,source_to_base_rate,' +
          'status,subtotal_txn_minor,supplier_id,supplier_name_snapshot,supplier_phone_snapshot,supplier_reference,supplier_tax_identifier_snapshot,' +
          'tax_minor,total_base_minor,total_txn_minor,updated_at,warehouse_id',
      },
      { t: 'stock_levels', p: 'UPDATE', cols: 'avg_unit_cost_base_minor,last_stock_seq,on_hand,valuation_base_minor' },
      // P3-S3 (0061, contract A-18): the one document with a human interval —
      // the count columns of a draft line, and the closing fields of its header.
      {
        t: 'stocktake_lines',
        p: 'UPDATE',
        cols: 'applied_value_base_minor,captured_at,captured_at_stock_seq,counted_qty,expected_qty_at_capture,unit_cost_base_minor',
      },
      {
        t: 'stocktakes',
        p: 'UPDATE',
        // 0061 R-16: the closing routine also records the trace of the close.
        cols: 'binding_source_id,cancelled_at,closed_business_transaction_id,closed_by,finalize_intent_sha256,finalized_at,occurred_on,status,total_value_base_minor',
      },
      // P3-S6 (0067, contract A-12, A-17): the credit note's two remaining
      // values, decremented by supplier_credit_note_consume only (R-73).
      { t: 'supplier_credit_notes', p: 'UPDATE', cols: 'remaining_amount_minor,remaining_carrying_base_amount_minor' },
      // P3-S4 (0063, contract A-18): identity and creation columns stay final (R-23).
      {
        t: 'suppliers',
        p: 'UPDATE',
        cols: 'business_transaction_id,email,last_intent_sha256,name,notes,phone,revision,status,tax_identifier,updated_at,updated_by',
      },
    ]);
  });

  it('on the six new tables, every grantee and privilege is exactly the matrix', async () => {
    const r = await ownerPool().query<{ g: string; t: string; p: string }>(
      `SELECT grantee AS g, table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
       FROM information_schema.role_table_grants
       WHERE table_name = ANY ($1::text[])
         AND grantee <> (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = ('public.' || table_name)::regclass)
       GROUP BY 1, 2 ORDER BY 2, 1`,
      [NEW_TABLES],
    );
    expect(r.rows).toEqual([
      { g: 'daftar_app', t: 'branch_warehouses', p: 'SELECT' },
      { g: INTERNAL, t: 'branch_warehouses', p: 'DELETE,INSERT,SELECT' },
      { g: INTERNAL, t: 'inventory_assertion_keys', p: 'INSERT,SELECT,UPDATE' },
      { g: INTERNAL, t: 'inventory_assertion_uses', p: 'DELETE,INSERT,SELECT' },
      { g: INTERNAL, t: 'inventory_operation_kinds', p: 'SELECT' },
      { g: 'daftar_app', t: 'unit_names', p: 'SELECT' },
      { g: 'daftar_app', t: 'units', p: 'SELECT' },
      { g: INTERNAL, t: 'units', p: 'SELECT' },
    ]);
  });

  it('no runtime role holds any privilege on the key store or the replay registry', async () => {
    const r = await ownerPool().query<{ g: string; t: string }>(
      `SELECT grantee AS g, table_name AS t FROM information_schema.role_table_grants
       WHERE table_name IN ('inventory_assertion_keys', 'inventory_assertion_uses', 'inventory_operation_kinds') AND grantee = ANY ($1::text[])`,
      [[...RUNTIME_ROLES, 'PUBLIC']],
    );
    expect(r.rows).toEqual([]);
  });

  it('daftar_app keeps SELECT, INSERT, UPDATE on products and product_variants and gains no DELETE', async () => {
    const r = await ownerPool().query<{ t: string; p: string }>(
      `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants
       WHERE grantee = 'daftar_app' AND table_name IN ('products', 'product_variants') GROUP BY 1 ORDER BY 1`,
    );
    expect(r.rows).toEqual([
      { t: 'product_variants', p: 'INSERT,SELECT,UPDATE' },
      { t: 'products', p: 'INSERT,SELECT,UPDATE' },
    ]);
  });

  it('routine EXECUTE grants on the internal routines are exactly the matrix', async () => {
    const r = await ownerPool().query<{ g: string; r: string }>(
      `SELECT g.grantee AS g, g.routine_name AS r
       FROM information_schema.role_routine_grants g
       JOIN pg_proc p ON p.proname = g.routine_name
       JOIN pg_roles o ON o.oid = p.proowner
       WHERE o.rolname = $1 AND g.privilege_type = 'EXECUTE' AND g.grantee <> $1
       ORDER BY 2, 1`,
      [INTERNAL],
    );
    expect(r.rows).toEqual([
      // P3-S3 (0062, contract §2.4): the seven signed entry routines, daftar_app only.
      { g: 'daftar_app', r: 'inventory_adjust_stock' },
      { g: 'daftar_platform', r: 'inventory_assertion_key_install' },
      { g: 'daftar_platform', r: 'inventory_assertion_key_retire' },
      // P3-S8 (0069, R-B1a, Annex R §2.4): the "has stock movements" boolean,
      // asked by the accounting domain guard only — no runtime role.
      { g: 'daftar_accounting_internal', r: 'inventory_business_has_stock_movements' },
      // Phase 3 corrective (0071 R-B1b): the stock-value equality boolean, asked
      // by the accounting reversal guard only — no runtime role.
      { g: 'daftar_accounting_internal', r: 'inventory_business_stock_value_equals' },
      { g: 'daftar_app', r: 'inventory_configure_product' },
      { g: 'daftar_app', r: 'inventory_record_damage' },
      { g: 'daftar_app', r: 'inventory_record_opening' },
      { g: 'daftar_app', r: 'inventory_stocktake_count' },
      { g: 'daftar_app', r: 'inventory_stocktake_finalize' },
      { g: 'daftar_app', r: 'inventory_stocktake_open' },
      { g: 'daftar_app', r: 'inventory_transfer_stock' },
      // P3-S6 (0068, contract §2.6, A-17): the seven signed entry routines,
      // daftar_app only; the credit-note writer, the §2.3 helpers and the
      // arithmetic have no grantee.
      { g: 'daftar_app', r: 'payment_method_activate' },
      { g: 'daftar_app', r: 'payment_method_create' },
      { g: 'daftar_app', r: 'payment_method_deactivate' },
      { g: 'daftar_app', r: 'payment_method_update' },
      // P3-S4 (0064, contract §2.4): the seven signed entry routines, daftar_app only.
      { g: 'daftar_app', r: 'purchase_cancel' },
      { g: 'daftar_app', r: 'purchase_receive' },
      // P3-S5 (0066, contract §2.5, A-18): the two signed entry routines, daftar_app only.
      { g: 'daftar_app', r: 'purchase_return' },
      { g: 'daftar_app', r: 'purchase_reverse' },
      // P3-S4 (0064, contract §2.4)
      { g: 'daftar_app', r: 'purchase_save_draft' },
      // Phase 3 corrective (0072, TD-16 R-96): the one signed entry routine, daftar_app only.
      { g: 'daftar_app', r: 'purchase_write_off_residue' },
      { g: 'daftar_app', r: 'structure_associate_warehouse_branch' },
      { g: 'daftar_app', r: 'structure_dissociate_warehouse_branch' },
      // P3-S6 (0068)
      { g: 'daftar_app', r: 'supplier_allocate_credit' },
      // P3-S4 (0064, contract §2.4)
      { g: 'daftar_app', r: 'supplier_archive' },
      { g: 'daftar_app', r: 'supplier_create' },
      // P3-S6 (0068)
      { g: 'daftar_app', r: 'supplier_pay' },
      // P3-S4 (0064, contract §2.4)
      { g: 'daftar_app', r: 'supplier_reactivate' },
      // P3-S6 (0068)
      { g: 'daftar_app', r: 'supplier_receive_refund' },
      // P3-S4 (0064, contract §2.4)
      { g: 'daftar_app', r: 'supplier_update' },
    ]);
  });

  it('branch_warehouses and warehouses ENABLE and FORCE row level security', async () => {
    const r = await ownerPool().query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('branch_warehouses', 'warehouses') AND relkind = 'r' ORDER BY 1`,
    );
    expect(r.rows).toEqual([
      { relname: 'branch_warehouses', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'warehouses', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('branch_warehouses carries exactly the accepted pair plus the internal read/insert admission', async () => {
    const r = await ownerPool().query(
      `SELECT polname, polpermissive, polcmd::text AS cmd,
              ARRAY(SELECT CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x)::text END FROM unnest(polroles) AS x ORDER BY 1)::text[] AS roles,
              pg_get_expr(polqual, polrelid) AS using, pg_get_expr(polwithcheck, polrelid) AS check
       FROM pg_policy WHERE polrelid = 'branch_warehouses'::regclass ORDER BY polname`,
    );
    const isolation = `(app_bypass() OR ((business_id)::text = app_business()) OR ((CURRENT_USER = '${INTERNAL}'::name) AND (COALESCE(app_business(), ''::text) = ''::text)))`;
    expect(r.rows.map((p: { polname: string }) => p.polname)).toEqual([
      'business_isolation',
      'inventory_internal_insert',
      'inventory_internal_read',
      'tenant_membership',
    ]);
    expect(r.rows[0]).toMatchObject({ polname: 'business_isolation', polpermissive: false, cmd: '*', roles: ['public'], using: isolation, check: isolation });
    expect(r.rows[1]).toMatchObject({ polname: 'inventory_internal_insert', polpermissive: true, cmd: 'a', roles: [INTERNAL], using: null, check: 'true' });
    expect(r.rows[2]).toMatchObject({ polname: 'inventory_internal_read', polpermissive: true, cmd: 'r', roles: [INTERNAL], using: 'true', check: null });
    expect(r.rows[3]).toMatchObject({ polname: 'tenant_membership', polpermissive: true, cmd: '*', roles: ['public'] });
    expect(String(r.rows[3]?.using)).toContain('app_tenant()');
  });
});

describe('branch_warehouses isolation of the internal principal (Agent 0 ruling on 0032:17 / 0052:244)', () => {
  const countRows = async (c: PoolClient, business: string): Promise<number> =>
    Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses WHERE business_id = $1`, [business])).rows[0]?.n);

  it('inside an entry-routine scope of business A, it sees A and cannot see B', async () => {
    const [a, b] = await asInternal(scopeA(), async (c) => [await countRows(c, fx.businessA), await countRows(c, fx.businessB)]);
    expect(a).toBe(1);
    expect(b).toBe(0);
  });

  it('inside a scope of business A, it cannot insert a row for business B', async () => {
    const message = await asInternal(scopeA(), (c) =>
      refusal(() =>
        c.query(`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3)`, [fx.businessB, fx.branchB, fx.warehouseB]),
      ),
    );
    expect(message).toMatch(/row-level security policy/i);
  });

  it('inside a scope of business A, it cannot delete business B rows — they are not there to delete', async () => {
    const deleted = await asInternal(scopeA(), async (c) => (await c.query(`DELETE FROM branch_warehouses WHERE business_id = $1`, [fx.businessB])).rowCount);
    expect(deleted).toBe(0);
    const still = await ownerPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses WHERE business_id = $1`, [fx.businessB]);
    expect(still.rows[0]?.n).toBe('1');
  });

  it('a scope that names the tenant of B but the business of A still cannot reach B', async () => {
    const [b, message] = await asInternal({ 'app.tenant_id': fx.tenantB, 'app.business_id': fx.businessA }, async (c) => [
      await countRows(c, fx.businessB),
      await refusal(() =>
        c.query(`INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
          fx.businessB,
          fx.branchB,
          fx.warehouseB,
        ]),
      ),
    ]);
    expect(b).toBe(0);
    expect(message).toMatch(/row-level security policy/i);
  });

  it('only with NO business scope is it admitted across businesses — the approved onboarding admission, and only for this principal', async () => {
    const [a, b] = await asInternal({}, async (c) => [await countRows(c, fx.businessA), await countRows(c, fx.businessB)]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    // The same empty scope admits nothing to the merchant runtime.
    const app = await asRole(appDbUrl, {}, async (c) => Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses`)).rows[0]?.n));
    expect(app).toBe(0);
  });

  it('daftar_app scoped to A reads A only and cannot write at all', async () => {
    const [a, b, ins, del] = await asRole(appDbUrl, scopeA(), async (c) => [
      Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses WHERE business_id = $1`, [fx.businessA])).rows[0]?.n),
      Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM branch_warehouses WHERE business_id = $1`, [fx.businessB])).rows[0]?.n),
      await c
        .query('SAVEPOINT s')
        .then(() => refusal(() => c.query(`INSERT INTO branch_warehouses VALUES ($1, $2, $3)`, [fx.businessA, fx.branchA, fx.warehouseA]))),
      await c.query('ROLLBACK TO SAVEPOINT s').then(() => refusal(() => c.query(`DELETE FROM branch_warehouses WHERE business_id = $1`, [fx.businessA]))),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(0);
    expect(ins).toMatch(/permission denied/i);
    expect(del).toMatch(/permission denied/i);
  });
});

describe('the column guards (P3-AL-54 §F, P3-AL-52)', () => {
  const app = <T>(run: (c: Client) => Promise<T>): Promise<T> => asRole(appDbUrl, scopeA(), run);

  it('daftar_app cannot turn tracking on, set a unit or set a precision on an existing product', async () => {
    for (const set of [`track_inventory = true`, `unit_code = 'piece'`, `unit_decimals = 0`]) {
      const message = await app((c) => refusal(() => c.query(`UPDATE products SET ${set} WHERE id = $1`, [fx.productA])));
      expect(message, set).toMatch(/inventory\.configuration_authority_required/);
    }
  });

  it('daftar_app cannot insert a product that is already configured', async () => {
    const message = await app((c) =>
      refusal(() => c.query(`INSERT INTO products (business_id, base_price_minor, price_currency, unit_code) VALUES ($1, 1, 'ILS', 'piece')`, [fx.businessA])),
    );
    expect(message).toMatch(/inventory\.configuration_authority_required/);
  });

  it('daftar_app still edits every other products column, and inserts an unconfigured product', async () => {
    const updated = await app(async (c) => (await c.query(`UPDATE products SET base_price_minor = 2000 WHERE id = $1`, [fx.productA])).rowCount);
    expect(updated).toBe(1);
    const inserted = await app(
      async (c) => (await c.query(`INSERT INTO products (business_id, base_price_minor, price_currency) VALUES ($1, 1, 'ILS')`, [fx.businessA])).rowCount,
    );
    expect(inserted).toBe(1);
  });

  it('the schema owner is held to the same rule — the guard is not an ACL', async () => {
    const message = await refusal(() =>
      ownerPool().query(`UPDATE products SET track_inventory = true, unit_code = 'piece', unit_decimals = 0 WHERE id = $1`, [fx.productA]),
    );
    expect(message).toMatch(/inventory\.configuration_authority_required/);
  });

  it('daftar_app cannot insert a base variant', async () => {
    const message = await app((c) =>
      refusal(() => c.query(`INSERT INTO product_variants (business_id, product_id, is_base) VALUES ($1, $2, true)`, [fx.businessA, fx.productA])),
    );
    expect(message).toMatch(/catalog\.base_variant_not_mutable/);
  });

  it('daftar_app cannot update a base variant, nor turn a merchant variant into one', async () => {
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.business_id', $2, true)`, [fx.tenantA, fx.businessA]);
      await c.query(`SET LOCAL ROLE ${INTERNAL}`);
      const base = randomUUID();
      await c.query(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, $2, $3, true)`, [fx.businessA, base, fx.productA]);
      await c.query(`RESET ROLE`);
      // Now as daftar_app itself, with the same scope: the guard decides by
      // current_user, and anyone but the internal principal is refused.
      await c.query(`SET LOCAL ROLE daftar_app`);
      await c.query('SAVEPOINT s');
      await expect(c.query(`UPDATE product_variants SET sku = sku WHERE id = $1`, [base])).rejects.toThrow(/catalog\.base_variant_not_mutable/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      const merchant = randomUUID();
      await c.query(`INSERT INTO product_variants (business_id, id, product_id) VALUES ($1, $2, $3)`, [fx.businessA, merchant, fx.productA]);
      await expect(c.query(`UPDATE product_variants SET is_base = true WHERE id = $1`, [merchant])).rejects.toThrow(/catalog\.base_variant_not_mutable/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('daftar_app still inserts and updates merchant variants', async () => {
    const n = await app(async (c) => {
      const id = randomUUID();
      await c.query(`INSERT INTO product_variants (business_id, id, product_id, sku) VALUES ($1, $2, $3, $4)`, [
        fx.businessA,
        id,
        fx.productA,
        `SKU-${id.slice(0, 8)}`,
      ]);
      return (await c.query(`UPDATE product_variants SET sku = $2 WHERE id = $1`, [id, `SKU2-${id.slice(0, 8)}`])).rowCount;
    });
    expect(n).toBe(1);
  });

  it('the internal principal writes base variants only, never a merchant one', async () => {
    const message = await asInternal(scopeA(), (c) =>
      refusal(() =>
        c.query(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, $2, $3, false)`, [fx.businessA, randomUUID(), fx.productA]),
      ),
    );
    expect(message).toMatch(/catalog\.base_variant_not_mutable: the inventory principal writes base variants only/);
  });

  it('the internal principal holds no UPDATE or DELETE on variants and no UPDATE of any other products column', async () => {
    for (const sql of [
      `UPDATE product_variants SET sku = NULL WHERE product_id = '${fx.productA}'`,
      `DELETE FROM product_variants WHERE product_id = '${fx.productA}'`,
      `UPDATE products SET base_price_minor = 1 WHERE id = '${fx.productA}'`,
      `DELETE FROM products WHERE id = '${fx.productA}'`,
      `INSERT INTO products (business_id, base_price_minor, price_currency) VALUES ('${fx.businessA}', 1, 'ILS')`,
    ]) {
      const message = await asInternal(scopeA(), (c) => refusal(() => c.query(sql)));
      expect(message, sql).toMatch(/permission denied/i);
    }
  });

  it('a tracked product needs a unit, even for the principal allowed to write the columns', async () => {
    const message = await asInternal(scopeA(), (c) => refusal(() => c.query(`UPDATE products SET track_inventory = true WHERE id = $1`, [fx.productA])));
    expect(message).toMatch(/products_tracked_requires_unit_ck/);
  });

  it('a base variant can hold no merchant identity — the CHECK holds even with the guard trigger switched off', async () => {
    // No writer can reach this CHECK with the guard in place (daftar_app is
    // refused by the guard, the internal principal cannot name sku at all),
    // so the guard is disabled inside a rolled-back transaction to prove the
    // constraint underneath it is real, not decorative.
    const c = await ownerPool().connect();
    try {
      await c.query('BEGIN');
      await c.query(`ALTER TABLE product_variants DISABLE TRIGGER product_variants_10_base_variant_authority`);
      const message = await refusal(() =>
        c.query(`INSERT INTO product_variants (business_id, product_id, is_base, sku) VALUES ($1, $2, true, 'MERCHANT-SKU')`, [fx.businessA, fx.productA]),
      );
      expect(message).toMatch(/product_variants_base_shape_ck/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('a product has at most one base variant', async () => {
    const message = await asInternal(scopeA(), async (c) => {
      await c.query(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, $2, $3, true)`, [fx.businessA, randomUUID(), fx.productA]);
      return refusal(() =>
        c.query(`INSERT INTO product_variants (business_id, id, product_id, is_base) VALUES ($1, $2, $3, true)`, [fx.businessA, randomUUID(), fx.productA]),
      );
    });
    expect(message).toMatch(/product_variants_one_base_uq/);
  });
});

describe('invctl/1 key management through daftar_platform (P3-AL-55 §C)', () => {
  const platform = async <T>(run: (c: Client) => Promise<T>): Promise<T> => {
    const c = new Client({ connectionString: platformDbUrl });
    await c.connect();
    try {
      return await run(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  };
  const kid = `authz-${randomUUID().slice(0, 8)}`;
  const secret = randomBytes(32);

  it('installs a key, and the same kid with the same secret is idempotent', async () => {
    await platform(async (c) => {
      await c.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, secret]);
      await c.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, secret]);
    });
    const r = await ownerPool().query(`SELECT status, secret = $2 AS same FROM inventory_assertion_keys WHERE kid = $1`, [kid, secret]);
    expect(r.rows).toEqual([{ status: 'active', same: true }]);
  });

  it('the same kid with a different secret raises inventory.assertion_key_conflict and changes nothing', async () => {
    const message = await platform((c) => refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, randomBytes(32)])));
    expect(message).toMatch(/inventory\.assertion_key_conflict/);
    expect(message).not.toContain(secret.toString('hex'));
    const r = await ownerPool().query(`SELECT secret = $2 AS same FROM inventory_assertion_keys WHERE kid = $1`, [kid, secret]);
    expect(r.rows).toEqual([{ same: true }]);
  });

  it('refuses a short secret or a malformed kid', async () => {
    expect(await platform((c) => refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, [`${kid}x`, randomBytes(31)])))).toMatch(
      /inventory\.assertion_key_invalid/,
    );
    expect(await platform((c) => refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, ['bad kid!', randomBytes(32)])))).toMatch(
      /inventory\.assertion_key_invalid/,
    );
  });

  it('the platform cannot read the keys back, nor write them directly', async () => {
    for (const sql of [
      `SELECT secret FROM inventory_assertion_keys`,
      `SELECT count(*) FROM inventory_assertion_keys`,
      `SELECT * FROM inventory_assertion_uses`,
      `INSERT INTO inventory_assertion_keys (kid, secret) VALUES ('direct', decode(repeat('00', 32), 'hex'))`,
      `UPDATE inventory_assertion_keys SET status = 'retired'`,
      `DELETE FROM inventory_assertion_keys`,
    ]) {
      const message = await platform((c) => refusal(() => c.query(sql)));
      expect(message, sql).toMatch(/permission denied/i);
    }
  });

  it.each([
    ['daftar_app', appDbUrl],
    ['daftar_worker', workerDbUrl],
    ['daftar_identity', identityDbUrl],
    ['daftar_resolver', resolverDbUrl],
    ['daftar_provisioner', provisionerDbUrl],
  ])('%s cannot install or retire a key', async (_role, url) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      expect(await refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, [`${kid}y`, randomBytes(32)]))).toMatch(/permission denied/i);
      expect(await refusal(() => c.query(`SELECT inventory_assertion_key_retire($1)`, [kid]))).toMatch(/permission denied/i);
    } finally {
      await c.end().catch(() => undefined);
    }
  });

  it('retire is terminal and idempotent, and a retired kid is never reinstated', async () => {
    await platform(async (c) => {
      await c.query(`SELECT inventory_assertion_key_retire($1)`, [kid]);
      await c.query(`SELECT inventory_assertion_key_retire($1)`, [kid]);
    });
    const r = await ownerPool().query(`SELECT status, retired_at IS NOT NULL AS stamped FROM inventory_assertion_keys WHERE kid = $1`, [kid]);
    expect(r.rows).toEqual([{ status: 'retired', stamped: true }]);
    const message = await platform((c) => refusal(() => c.query(`SELECT inventory_assertion_key_install($1, $2)`, [kid, secret])));
    expect(message).toMatch(/inventory\.assertion_key_conflict/);
  });
});

/**
 * ── P4-AL-88 proof: the scoped privilege map, both directions ────────────
 *
 * Scoping the map must not have dropped what the unscoped map bought. So:
 * the in-scope equality is still RED when a Phase 3 privilege is wrong, and
 * the positive beyond-scope claim is RED when this principal is handed a
 * write on a relation no accepted prefix created. Both planted on the real
 * catalogue inside a transaction that is always rolled back; the relation is
 * DISCOVERED, never named.
 */
describe('P4-AL-88 — the scoped internal privilege map is red where it must be', () => {
  let owner: PoolClient;

  beforeAll(async () => {
    owner = await ownerPool().connect();
  });

  const privileges = async (q: Client | PoolClient): Promise<Readonly<Record<string, string>>> =>
    Object.fromEntries(
      (
        await q.query<{ t: string; p: string }>(
          `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
             FROM information_schema.role_table_grants WHERE grantee = $1 GROUP BY table_name ORDER BY table_name`,
          [INTERNAL],
        )
      ).rows.map((x) => [x.t, x.p] as const),
    );

  const planted = async (plant: readonly string[], body: () => Promise<void>): Promise<void> => {
    await owner.query('BEGIN');
    try {
      for (const sql of plant) await owner.query(sql);
      await body();
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  };

  it('RED: a write handed to the internal principal beyond the accepted prefix is named', async () => {
    const prefixRelations = phase4InheritedPrefixRelations();
    const live = await privileges(owner);
    const beyond = Object.keys(live).filter((t) => !prefixRelations.has(t));
    if (beyond.length === 0) return; // nothing beyond the prefix in this tree: the claim below has no subject
    const target = beyond[0] ?? '';
    await planted([`GRANT INSERT ON ${target} TO ${INTERNAL}`], async () => {
      const after = await privileges(owner);
      const problems = Object.entries(after)
        .filter(([t]) => !prefixRelations.has(t))
        .filter(([, p]) => p !== 'SELECT');
      expect(problems).toEqual([[target, 'INSERT,SELECT']]);
    });
    expect(
      Object.entries(await privileges(owner))
        .filter(([t]) => !prefixRelations.has(t))
        .filter(([, p]) => p !== 'SELECT'),
    ).toEqual([]);
  });

  it('RED: a Phase 3 privilege removed is still named by the in-scope map', async () => {
    const prefixRelations = phase4InheritedPrefixRelations();
    const before = await privileges(owner);
    expect(before['units']).toBe('SELECT');
    await planted([`REVOKE SELECT ON units FROM ${INTERNAL}`], async () => {
      const after = await privileges(owner);
      const inScope = Object.fromEntries(Object.entries(after).filter(([t]) => prefixRelations.has(t)));
      expect(Object.keys(inScope)).not.toContain('units');
      expect(inScope).not.toEqual(Object.fromEntries(Object.entries(before).filter(([t]) => prefixRelations.has(t))));
    });
    expect((await privileges(owner))['units']).toBe('SELECT');
  });
});
