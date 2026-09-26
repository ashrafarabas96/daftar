import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVENTORY_INVOKER_EXCEPTIONS, checkInventoryDefinerContract, inventoryRoutineDefinitions } from '../../scripts/guards/inventory-definer-contract';
import { checkInventoryWriterAuthority, stockTablesWritten } from '../../scripts/guards/inventory-writer-authority';

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
const F60 = '0060_inventory_stock_primitive.sql';

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
      'inventory_apply_stock_movements',
      'inventory_assertion_consume',
      'inventory_assertion_current',
      'inventory_assertion_key_install',
      'inventory_assertion_key_retire',
      'inventory_business_transaction_id',
      'inventory_claimed_payload_digest',
      'inventory_configure_product',
      'inventory_half_even',
      'inventory_next_deficit_seq',
      'inventory_payload_digest',
      'inventory_payload_field_is_canonical',
      'inventory_quantity_is_representable',
      'inventory_stock_fold',
      'inventory_stock_verify',
      'product_variants_10_base_variant_authority',
      'product_variants_20_stock_identity_lock',
      'products_10_inventory_config_authority',
      'products_20_unit_history_lock',
      'stock_levels_zero_on_hand_zero_value',
      'structure_associate_warehouse_branch',
      'structure_dissociate_warehouse_branch',
      'warehouses_home_branch_maintain',
      'warehouses_require_home_branch',
    ]);
    expect([...INVENTORY_INVOKER_EXCEPTIONS].sort()).toEqual(['product_variants_10_base_variant_authority', 'products_10_inventory_config_authority']);
  });

  it('reads EVERY definition of a transferred routine: inventory_configure_product is defined in 0055 and replaced in 0060 as the principal', () => {
    const defs = inventoryRoutineDefinitions(real()).filter((d) => d.name === 'inventory_configure_product');
    expect(defs.map((d) => [d.file, d.createdAsInternal, d.securityDefiner])).toEqual([
      [F55, false, true],
      [F60, true, true],
    ]);
  });

  it('rule 22: the only stock writer is the primitive, and its first statement verifies the assertion', () => {
    const report = checkInventoryWriterAuthority(real());
    expect(report.violations).toEqual([]);
    expect(report.writers).toEqual([`${F60}: inventory_apply_stock_movements`]);
  });
});

describe('G-7 — each protection, removed in turn, is noticed', () => {
  it('a definer turned invoker', () => {
    const v = violations(mutate(F55, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?)SECURITY DEFINER/, '$1SECURITY INVOKER'));
    expect(v.some((m) => m.startsWith(F55) && m.includes('inventory_configure_product') && m.includes('not SECURITY DEFINER'))).toBe(true);
  });

  it('a 0060 replacement turned invoker (the principal replaces its own routine — every definition is checked)', () => {
    const v = violations(mutate(F60, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?)SECURITY DEFINER/, '$1SECURITY INVOKER'));
    expect(v.some((m) => m.startsWith(F60) && m.includes('inventory_configure_product') && m.includes('not SECURITY DEFINER'))).toBe(true);
    // …and the 0055 definition, which is still correct, is not blamed.
    expect(v.some((m) => m.startsWith(F55))).toBe(false);
  });

  it('a 0060 replacement with a reordered path, and a new S2 routine turned invoker', () => {
    const v = violations(
      mutate(
        F60,
        /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?)SET search_path = pg_catalog, public, pg_temp/,
        '$1SET search_path = public, pg_catalog, pg_temp',
      ),
    );
    expect(v.some((m) => m.startsWith(F60) && m.includes('inventory_configure_product') && m.includes('search_path'))).toBe(true);
    const w = violations(mutate(F60, /(CREATE OR REPLACE FUNCTION inventory_stock_verify\([\s\S]*?)SECURITY DEFINER/, '$1SECURITY INVOKER'));
    expect(w.some((m) => m.startsWith(F60) && m.includes('inventory_stock_verify') && m.includes('not SECURITY DEFINER'))).toBe(true);
  });

  it('dynamic SQL in the 0060 replacement', () => {
    const v = violations(mutate(F60, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?\bBEGIN\b)/, "$1\n  EXECUTE 'SELECT 1';"));
    expect(v.some((m) => m.startsWith(F60) && m.includes('inventory_configure_product') && m.includes('dynamic SQL'))).toBe(true);
  });

  it('the 0060 replacement left outside the CREATE bracket', () => {
    // The CREATE revoke moved up to just after the ownership transfers: the
    // replacement issued as the principal now runs after the bracket closed.
    const tree = mutate(
      F60,
      /REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;(?![\s\S]*REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;)/,
      '',
    );
    const moved = tree[F60] ?? '';
    tree[F60] = moved.replace(
      'ALTER FUNCTION stock_levels_zero_on_hand_zero_value() OWNER TO daftar_inventory_internal;',
      'ALTER FUNCTION stock_levels_zero_on_hand_zero_value() OWNER TO daftar_inventory_internal;\nREVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    );
    expect(tree[F60]).not.toBe(moved);
    const v = violations(tree);
    expect(v.some((m) => m.startsWith(F60) && m.includes('without revoking'))).toBe(true);
  });

  it('a routine CREATED as the principal is a handover: it needs its own REVOKE unless it replaces an earlier one', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
      'SET LOCAL ROLE daftar_inventory_internal;',
      'CREATE FUNCTION inventory_role_made() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN 1; END; $$;',
      'RESET ROLE;',
      'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    ].join('\n');
    const report = checkInventoryDefinerContract({ migrations: tree });
    expect(report.transferred).toContain('inventory_role_made');
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain('inventory_role_made');
    expect(report.violations[0]).toContain('FROM PUBLIC');
  });

  it('a replacement as the principal that is DROPped first loses its ACL, so it needs its own REVOKE', () => {
    const v = violations(
      mutate(
        F60,
        /SET LOCAL ROLE daftar_inventory_internal;\s*CREATE OR REPLACE FUNCTION inventory_configure_product\(/,
        'SET LOCAL ROLE daftar_inventory_internal;\nDROP FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT);\nCREATE OR REPLACE FUNCTION inventory_configure_product(',
      ),
    );
    expect(v.some((m) => m.startsWith(F60) && m.includes('inventory_configure_product') && m.includes('FROM PUBLIC'))).toBe(true);
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
    expect(v.some((m) => m.startsWith(F55) && m.includes('inventory_configure_product') && m.includes('dynamic SQL'))).toBe(true);
  });

  it('a session relation created in a body', () => {
    const v = violations(mutate(F55, /(CREATE OR REPLACE FUNCTION inventory_configure_product\([\s\S]*?\bBEGIN\b)/, '$1\n  CREATE TEMP TABLE t (x int);'));
    expect(v.some((m) => m.startsWith(F55) && m.includes('inventory_configure_product') && m.includes('session relation'))).toBe(true);
  });

  it('a later ALTER that resets the path or flips the security mode', () => {
    const tree = real();
    tree['9999_regression.sql'] =
      'ALTER FUNCTION inventory_assertion_consume(TEXT, TEXT) RESET search_path;\nALTER FUNCTION inventory_assertion_current(TEXT[]) SECURITY INVOKER;\n';
    const v = violations(tree);
    expect(v.some((m) => m.includes('inventory_assertion_consume') && m.includes('search_path after the fact'))).toBe(true);
    expect(v.some((m) => m.includes('inventory_assertion_current') && m.includes('security mode after the fact'))).toBe(true);
  });

  it('L-1: a grant to PUBLIC hidden in a list, in ALL FUNCTIONS IN SCHEMA, or under ALTER ROUTINE', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT EXECUTE ON FUNCTION products_touch(), "public"."inventory_stock_verify"(UUID, UUID, UUID) TO daftar_app, PUBLIC;',
      'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC;',
      'ALTER ROUTINE inventory_assertion_consume RESET search_path;',
    ].join('\n');
    const v = violations(tree);
    expect(v.some((m) => m.includes('grants inventory_stock_verify to PUBLIC'))).toBe(true);
    expect(v.some((m) => m.includes('grants ALL routines in a schema to PUBLIC'))).toBe(true);
    expect(v.some((m) => m.includes('inventory_assertion_consume') && m.includes('search_path after the fact'))).toBe(true);
  });

  it('L-1: REASSIGN OWNED … TO the principal hands over routines no statement names', () => {
    const tree = real();
    tree['9999_regression.sql'] = 'REASSIGN OWNED BY daftar_migrator TO "daftar_inventory_internal";\n';
    expect(violations(tree).some((m) => m.includes('REASSIGN OWNED'))).toBe(true);
  });

  it('L-1: SET SESSION AUTHORIZATION, a literal role and set_config(role) all make a routine created as the principal', () => {
    for (const [open, close] of [
      ['SET SESSION AUTHORIZATION daftar_inventory_internal;', 'RESET SESSION AUTHORIZATION;'],
      ["SET ROLE 'daftar_inventory_internal';", 'RESET ROLE;'],
      ["SELECT set_config('role', 'daftar_inventory_internal', true);", 'RESET ROLE;'],
    ] as const) {
      const tree = real();
      tree['9999_regression.sql'] = [
        'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
        open,
        'CREATE FUNCTION inventory_session_made() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN 1; END; $$;',
        close,
        'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
      ].join('\n');
      const report = checkInventoryDefinerContract({ migrations: tree });
      expect(report.transferred, open).toContain('inventory_session_made');
      expect(
        report.violations.some((m) => m.includes('inventory_session_made') && m.includes('FROM PUBLIC')),
        open,
      ).toBe(true);
    }
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

describe('rule 22 — a stock writer verifies invctl/1 first (PM-44 static half)', () => {
  const writer = (migrations: Record<string, string>): string[] => checkInventoryWriterAuthority(migrations).violations;
  const ASSERT = 'v_actor := inventory_assertion_current(ARRAY(SELECT DISTINCT m.op_code FROM inventory_operation_movement_kinds m ORDER BY 1));';

  it('the primitive with its assertion moved below another statement', () => {
    const v = writer(mutate(F60, ASSERT, `v_rows := 0;\n  ${ASSERT}`));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(F60);
    expect(v[0]).toContain('inventory_apply_stock_movements');
  });

  it('the primitive with its assertion removed', () => {
    const v = writer(mutate(F60, ASSERT, 'v_business := NULL;'));
    expect(v.some((m) => m.includes('inventory_apply_stock_movements') && m.includes('first statement'))).toBe(true);
  });

  it('a new internal routine that writes the ledger without any assertion', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
      'CREATE FUNCTION inventory_sneaky_writer() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$',
      'BEGIN',
      '  DELETE FROM negative_deficit_coverages WHERE false;',
      'END; $$;',
      'REVOKE ALL ON FUNCTION inventory_sneaky_writer() FROM PUBLIC;',
      'ALTER FUNCTION inventory_sneaky_writer() OWNER TO daftar_inventory_internal;',
      'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    ].join('\n');
    // G-7 alone is satisfied: the shape is right. Only rule 22 sees the missing authority.
    expect(checkInventoryDefinerContract({ migrations: tree }).violations).toEqual([]);
    const v = writer(tree);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('inventory_sneaky_writer');
    expect(v[0]).toContain('negative_deficit_coverages');
  });

  describe('L-1: writer evasions', () => {
    const PATH = 'SET search_path = pg_catalog, public, pg_temp';
    /** The real tree plus one file that creates `name` with `body` and hands it over with `handover`. */
    const planted = (name: string, body: string, handover = `ALTER FUNCTION ${name}() OWNER TO daftar_inventory_internal;`, kind = 'FUNCTION') => {
      const tree = real();
      tree['9999_regression.sql'] = [
        'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
        `CREATE ${kind} ${name}() ${kind === 'FUNCTION' ? 'RETURNS void ' : ''}LANGUAGE plpgsql SECURITY DEFINER ${PATH} AS $$`,
        body,
        '$$;',
        `REVOKE ALL ON ${kind} ${name.replace(/^(?:"?public"?\s*\.\s*)/, '')}() FROM PUBLIC;`,
        handover,
        'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
      ].join('\n');
      return tree;
    };
    const CHECK = "v_actor := inventory_assertion_current(ARRAY['op']);";

    it('MERGE INTO, TRUNCATE and COPY … FROM are writes', () => {
      expect(stockTablesWritten('MERGE INTO stock_levels l USING (SELECT 1 AS k) s ON false WHEN NOT MATCHED THEN DO NOTHING;')).toEqual(['stock_levels']);
      expect(stockTablesWritten('MERGE INTO ONLY public.stock_movements m USING x ON false WHEN MATCHED THEN DELETE;')).toEqual(['stock_movements']);
      expect(stockTablesWritten('TRUNCATE TABLE products, ONLY "stock_source_bindings", public.negative_deficit_coverages;')).toEqual([
        'negative_deficit_coverages',
        'stock_source_bindings',
      ]);
      expect(stockTablesWritten("COPY stock_movements (id) FROM '/tmp/x';")).toEqual(['stock_movements']);
      const v = writer(
        planted('inventory_merge_writer', 'BEGIN\n  MERGE INTO stock_levels l USING (SELECT 1 AS k) s ON false WHEN NOT MATCHED THEN DO NOTHING;\nEND;'),
      );
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('inventory_merge_writer writes stock_levels');
    });

    it('a quoted or schema-qualified stock table is still that table', () => {
      expect(stockTablesWritten('INSERT INTO "stock_movements" DEFAULT VALUES;')).toEqual(['stock_movements']);
      expect(stockTablesWritten('UPDATE "public"."stock_levels" SET on_hand = 0;')).toEqual(['stock_levels']);
      expect(stockTablesWritten('DELETE FROM public . "negative_inventory_deficits" WHERE false;')).toEqual(['negative_inventory_deficits']);
      expect(stockTablesWritten('UPDATE ONLY "public".stock_source_bridge_purchase SET x = 1;')).toEqual(['stock_source_bridge_purchase']);
      const v = writer(planted('inventory_quoted_writer', 'BEGIN\n  UPDATE "public"."stock_levels" SET on_hand = 0 WHERE false;\nEND;'));
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('inventory_quoted_writer writes stock_levels');
    });

    it('a PROCEDURE handed over is a writer like a function', () => {
      const tree = planted(
        'inventory_proc_writer',
        'BEGIN\n  DELETE FROM stock_levels WHERE false;\nEND;',
        'ALTER PROCEDURE inventory_proc_writer() OWNER TO daftar_inventory_internal;',
        'PROCEDURE',
      );
      expect(checkInventoryDefinerContract({ migrations: tree }).transferred).toContain('inventory_proc_writer');
      expect(checkInventoryDefinerContract({ migrations: tree }).violations).toEqual([]);
      const v = writer(tree);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('inventory_proc_writer writes stock_levels');
    });

    it('ALTER ROUTINE, an ALTER without its argument list, a quoted owner and a quoted, qualified name all hand a writer over', () => {
      const body = 'BEGIN\n  INSERT INTO stock_movements DEFAULT VALUES;\nEND;';
      for (const [name, handover] of [
        ['inventory_routine_writer', 'ALTER ROUTINE inventory_routine_writer() OWNER TO daftar_inventory_internal;'],
        ['inventory_bare_writer', 'ALTER FUNCTION inventory_bare_writer OWNER TO daftar_inventory_internal;'],
        ['inventory_owner_writer', 'ALTER FUNCTION inventory_owner_writer() OWNER TO "daftar_inventory_internal";'],
        ['"public"."inventory_named_writer"', 'ALTER FUNCTION "public"."inventory_named_writer"() OWNER TO daftar_inventory_internal;'],
      ] as const) {
        const tree = planted(name, body, handover);
        const bare = name.replace(/"/g, '').replace(/^public\./, '');
        expect(checkInventoryDefinerContract({ migrations: tree }).transferred, handover).toContain(bare);
        const v = writer(tree);
        expect(v, handover).toHaveLength(1);
        expect(v[0], handover).toContain(`${bare} writes stock_movements`);
      }
    });

    it('a DECLARE initialiser that calls a writer (or anything) runs before the assertion', () => {
      const v = writer(mutate(F60, /v_rows {10}BIGINT;/, 'v_rows          BIGINT := inventory_next_deficit_seq(NULL, NULL, NULL);'));
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('inventory_apply_stock_movements');
      expect(v[0]).toContain('DECLARE initialiser calls inventory_next_deficit_seq');
      const w = writer(
        planted(
          'inventory_declare_writer',
          `DECLARE\n  v_actor inventory_verified_actor;\n  v_seen BIGINT := (SELECT count(1) FROM stock_levels);\nBEGIN\n  ${CHECK}\n  INSERT INTO stock_levels DEFAULT VALUES;\nEND;`,
        ),
      );
      expect(w.some((m) => m.includes('inventory_declare_writer') && m.includes('DECLARE initialiser calls count'))).toBe(true);
      expect(w.some((m) => m.includes('inventory_declare_writer') && m.includes('DECLARE initialiser runs a query'))).toBe(true);
    });

    it('the first statement is the assertion call and nothing else: no call in its arguments, nothing after it', () => {
      const v = writer(mutate(F60, ASSERT, ASSERT.replace('ORDER BY 1)', 'ORDER BY 1) || inventory_evil()')));
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("assertion call's arguments call inventory_evil");
      for (const first of [
        "PERFORM inventory_assertion_current(ARRAY['op']), inventory_apply_stock_movements(NULL);",
        "SELECT inventory_assertion_current(ARRAY['op']) INTO v_actor FROM inventory_evil();",
        "v_actor := inventory_assertion_current(ARRAY['op']) OR inventory_evil();",
      ]) {
        const w = writer(
          planted(
            'inventory_trailing_writer',
            `DECLARE\n  v_actor inventory_verified_actor;\nBEGIN\n  ${first}\n  INSERT INTO stock_levels DEFAULT VALUES;\nEND;`,
          ),
        );
        expect(w, first).toHaveLength(1);
        expect(w[0], first).toMatch(/does more than call the assertion|arguments call/);
      }
      // The shapes the rule accepts: an assignment, PERFORM, SELECT … INTO, a quoted or qualified name.
      for (const first of [
        CHECK,
        "PERFORM inventory_assertion_current(ARRAY['op']);",
        "SELECT inventory_assertion_current(ARRAY['op']) INTO v_actor;",
        'v_actor := public."inventory_assertion_current"(ARRAY(SELECT DISTINCT m.op_code FROM inventory_operation_movement_kinds m ORDER BY 1));',
      ]) {
        expect(
          writer(
            planted(
              'inventory_good_writer',
              `DECLARE\n  v_actor inventory_verified_actor;\nBEGIN\n  ${first}\n  INSERT INTO stock_levels DEFAULT VALUES;\nEND;`,
            ),
          ),
          first,
        ).toEqual([]);
      }
    });

    it('an EXCEPTION WHEN handler could swallow the refusal and write anyway', () => {
      const v = writer(
        planted(
          'inventory_handler_writer',
          `DECLARE\n  v_actor inventory_verified_actor;\nBEGIN\n  ${CHECK}\nEXCEPTION WHEN others THEN\n  INSERT INTO stock_levels DEFAULT VALUES;\nEND;`,
        ),
      );
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('EXCEPTION WHEN handler');
    });
  });

  it('a read, a FOR UPDATE lock or a table named in a message is not a write', () => {
    const tree = real();
    tree['9999_regression.sql'] = [
      'GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;',
      'CREATE FUNCTION inventory_reader() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$',
      'BEGIN',
      '  PERFORM 1 FROM stock_levels WHERE false FOR UPDATE;',
      "  RAISE NOTICE 'never INSERT INTO stock_movements here';",
      'END; $$;',
      'REVOKE ALL ON FUNCTION inventory_reader() FROM PUBLIC;',
      'ALTER FUNCTION inventory_reader() OWNER TO daftar_inventory_internal;',
      'REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;',
    ].join('\n');
    expect(writer(tree)).toEqual([]);
  });
});
