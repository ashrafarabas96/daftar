import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVENTORY_INVOKER_EXCEPTIONS, checkInventoryDefinerContract } from '../../scripts/guards/inventory-definer-contract';

/**
 * GUARD G-7 — the §D definer contract for daftar_inventory_internal
 * (P3-AL-54 §D), tested by breaking it: each case removes exactly one
 * protection from a real migration and requires the guard to notice. A case
 * that goes green while the text is broken means a check went vacuous.
 */

const MIGRATIONS = join(__dirname, '../../infrastructure/database/migrations');

const real = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    out[f] = readFileSync(join(MIGRATIONS, f), 'utf8');
  }
  return out;
};

const F53 = '0053_inventory_units_and_product_configuration.sql';
const F54 = '0054_inventory_assertion_authority.sql';
const F55 = '0055_inventory_configure_product.sql';

/** The real tree with one file's text rewritten; the rewrite must change something. */
function mutate(file: string, from: string | RegExp, to: string): Record<string, string> {
  const tree = real();
  const before = tree[file] ?? '';
  const after = before.replace(from, to);
  expect(after, `mutation of ${file} did not apply`).not.toBe(before);
  tree[file] = after;
  return tree;
}

const violations = (migrations: Record<string, string>): string[] => checkInventoryDefinerContract({ migrations }).violations;

describe('G-7 — the tree as it stands', () => {
  it('accepts the real migrations', () => {
    expect(violations(real())).toEqual([]);
  });

  it('sees every routine the migrations hand to the inventory principal, including the two asserted exceptions', () => {
    const { transferred } = checkInventoryDefinerContract({ migrations: real() });
    expect(transferred).toEqual([
      'branch_warehouses_keep_home',
      'inventory_assertion_consume',
      'inventory_assertion_current',
      'inventory_assertion_key_install',
      'inventory_assertion_key_retire',
      'inventory_business_transaction_id',
      'inventory_claimed_payload_digest',
      'inventory_configure_product',
      'inventory_payload_digest',
      'inventory_payload_field_is_canonical',
      'product_variants_10_base_variant_authority',
      'products_10_inventory_config_authority',
      'structure_associate_warehouse_branch',
      'structure_dissociate_warehouse_branch',
      'warehouses_home_branch_maintain',
      'warehouses_require_home_branch',
    ]);
    expect([...INVENTORY_INVOKER_EXCEPTIONS].sort()).toEqual(['product_variants_10_base_variant_authority', 'products_10_inventory_config_authority']);
  });
});

describe('G-7 — each protection, removed in turn, is noticed', () => {
  it('a definer turned invoker', () => {
    const v = violations(mutate(F55, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?)SECURITY DEFINER/, '$1SECURITY INVOKER'));
    expect(v.some((m) => m.includes('inventory_configure_product') && m.includes('not SECURITY DEFINER'))).toBe(true);
  });

  it('an asserted invoker exception turned definer', () => {
    const v = violations(mutate(F53, /(CREATE OR REPLACE FUNCTION products_10_inventory_config_authority\([\s\S]*?)SECURITY INVOKER/, '$1SECURITY DEFINER'));
    expect(v.some((m) => m.includes('products_10_inventory_config_authority') && m.includes('must not be SECURITY DEFINER'))).toBe(true);
  });

  it('a reordered search_path', () => {
    const v = violations(
      mutate(
        F54,
        /(CREATE OR REPLACE FUNCTION inventory_assertion_consume\([\s\S]*?)SET search_path = pg_catalog, public, pg_temp/,
        '$1SET search_path = public, pg_catalog, pg_temp',
      ),
    );
    expect(v.some((m) => m.includes('inventory_assertion_consume') && m.includes('search_path'))).toBe(true);
  });

  it('a missing REVOKE … FROM PUBLIC', () => {
    const v = violations(mutate(F54, 'REVOKE ALL ON FUNCTION inventory_assertion_current(TEXT[]) FROM PUBLIC;', ''));
    expect(v.some((m) => m.includes('inventory_assertion_current') && m.includes('FROM PUBLIC'))).toBe(true);
  });

  it('a grant to PUBLIC', () => {
    const v = violations(
      mutate(
        F55,
        'GRANT EXECUTE ON FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT) TO daftar_app;',
        'GRANT EXECUTE ON FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT) TO daftar_app, PUBLIC;',
      ),
    );
    expect(v.some((m) => m.includes('inventory_configure_product') && m.includes('PUBLIC'))).toBe(true);
  });

  it('a missing CREATE grant before the transfer', () => {
    const v = violations(mutate(F55, 'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;', ''));
    expect(v.some((m) => m.startsWith(F55) && m.includes('without first granting'))).toBe(true);
  });

  it('a missing CREATE revoke after the transfer', () => {
    const v = violations(mutate(F55, 'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;', ''));
    expect(v.some((m) => m.startsWith(F55) && m.includes('without revoking'))).toBe(true);
  });

  it('dynamic SQL in a body', () => {
    const v = violations(mutate(F55, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?\bBEGIN\b)/, "$1\n  EXECUTE 'SELECT 1';"));
    expect(v.some((m) => m.includes('inventory_configure_product') && m.includes('dynamic SQL'))).toBe(true);
  });

  it('a session relation created in a body', () => {
    const v = violations(mutate(F55, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?\bBEGIN\b)/, '$1\n  CREATE TEMP TABLE t (x int);'));
    expect(v.some((m) => m.includes('inventory_configure_product') && m.includes('session relation'))).toBe(true);
  });

  it('a later ALTER that resets the path or flips the security mode', () => {
    const tree = real();
    tree['9999_regression.sql'] =
      'ALTER FUNCTION inventory_assertion_consume(TEXT, TEXT) RESET search_path;\nALTER FUNCTION inventory_assertion_current(TEXT[]) SECURITY INVOKER;\n';
    const v = violations(tree);
    expect(v.some((m) => m.includes('inventory_assertion_consume') && m.includes('search_path after the fact'))).toBe(true);
    expect(v.some((m) => m.includes('inventory_assertion_current') && m.includes('security mode after the fact'))).toBe(true);
  });

  it('an asserted exception that has disappeared', () => {
    const v = violations(mutate(F53, 'ALTER FUNCTION products_10_inventory_config_authority() OWNER TO daftar_inventory_internal;', ''));
    expect(v.some((m) => m.includes('asserted INVOKER exception products_10_inventory_config_authority'))).toBe(true);
  });

  it('a third invoker routine handed to the principal', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
      'CREATE FUNCTION inventory_sneaky() RETURNS int LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN 1; END; $$;',
      'REVOKE ALL ON FUNCTION inventory_sneaky() FROM PUBLIC;',
      'ALTER FUNCTION inventory_sneaky() OWNER TO daftar_inventory_internal;',
      'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    ].join('\n');
    const v = violations(tree);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('inventory_sneaky');
    expect(v[0]).toContain('not SECURITY DEFINER');
  });
});
