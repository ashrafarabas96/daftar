-- 0053_inventory_units_and_product_configuration.sql
-- P3-S1, part 1 — the unit registry, the product inventory columns, the base
-- variant shape, and the two INVOKER-rights column guards that make the
-- configuration columns writable by exactly one principal
-- (P3-AL-03, P3-AL-04, P3-AL-05, P3-AL-52, P3-AL-54 §C/§F/§G/§H).
--
-- ── What this file creates ──────────────────────────────────────────────
--
--   * `units` / `unit_names` — the canonical, migration-extensible unit
--     registry and its localized display names (P3-AL-05). Display text lives
--     outside inventory truth; persistence never depends on a translation.
--   * `products.track_inventory` / `unit_code` / `unit_decimals` — every
--     existing product starts UNTRACKED (P3-AL-04). `products.unit`, the free
--     Phase 1 label, is not read, parsed, mapped or inferred from. No stock
--     row, no base variant and no movement is created because this ran.
--   * `product_variants.is_base` — at most one hidden base variant per product,
--     physically unable to carry merchant identity (P3-AL-03, P3-AL-52).
--   * `products_10_inventory_config_authority` and
--     `product_variants_10_base_variant_authority` — the column guards
--     (P3-AL-54 §F). They are SECURITY INVOKER by design: their whole job is to
--     observe WHO is writing, and inside a SECURITY DEFINER function
--     `current_user` is always the owner. They are the only two functions owned
--     by `daftar_inventory_internal` that are not SECURITY DEFINER, and the
--     §D catalogue check names them as its only exceptions.
--
-- ── Why the guards are owned by the internal principal ──────────────────
--
-- An invoker-rights function gains nothing from its owner at run time, so
-- the ownership is not authority. It is classification: every routine that
-- belongs to the inventory authority model is discoverable from the catalogue
-- as "owned by daftar_inventory_internal", and the §D check can then assert
-- the complete set rather than a hand-kept list (P3-AL-54 §D, plan item 7).
-- The handover is bracketed by a same-file CREATE ON SCHEMA public grant and
-- revoke (P3-AL-54 §J), and section 7 refuses to commit if it survived.
--
-- ── Why a trigger and not column grants ─────────────────────────────────
--
-- `daftar_app` holds table-level UPDATE on `products` (0006:77-78). A
-- table-level privilege covers columns added later, and `REVOKE UPDATE (col)`
-- does not remove it. The trigger guards exactly the three new columns and
-- nothing else, with one stable refusal code (P3-AL-54 §F).
--
-- `ALTER TABLE ... ADD COLUMN ... DEFAULT false` fires no row trigger, so
-- nothing in this file trips its own guard.
--
-- Migrations 0000-0052 are FROZEN and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file
--    (0040:263 / 0040:471 pattern; P3-AL-54 §J).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The unit registry (P3-AL-05).
--
-- A migration-extensible table, not a closed CHECK and not a free string.
-- It carries NO conversion factor and NO base-unit column: a column that
-- exists is a column a later slice would populate and a later query would
-- trust, and Phase 3 converts nothing.
--
-- `default_decimals` is only the initial suggestion. The product persists its
-- own `unit_decimals` at selection time, so a later change to a default can
-- never reinterpret existing stock (P3-AL-05 §D, row 8).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE units (
  unit_code        TEXT PRIMARY KEY CHECK (unit_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  default_decimals SMALLINT NOT NULL CHECK (default_decimals BETWEEN 0 AND 4),
  sort_order       INTEGER NOT NULL UNIQUE
);
REVOKE ALL ON units FROM PUBLIC;

CREATE TABLE unit_names (
  unit_code    TEXT NOT NULL REFERENCES units (unit_code),
  locale       TEXT NOT NULL CHECK (locale IN ('ar', 'en', 'tr')),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  PRIMARY KEY (unit_code, locale)
);
REVOKE ALL ON unit_names FROM PUBLIC;

INSERT INTO units (unit_code, default_decimals, sort_order) VALUES
  ('piece',      0,  10),
  ('kg',         3,  20),
  ('gram',       0,  30),
  ('litre',      3,  40),
  ('millilitre', 0,  50),
  ('metre',      2,  60),
  ('centimetre', 0,  70),
  ('box',        0,  80),
  ('carton',     0,  90),
  ('dozen',      0, 100),
  ('hour',       2, 110);

INSERT INTO unit_names (unit_code, locale, display_name) VALUES
  ('piece',      'ar', 'قطعة'),      ('piece',      'en', 'Piece'),      ('piece',      'tr', 'Adet'),
  ('kg',         'ar', 'كيلوغرام'),  ('kg',         'en', 'Kilogram'),   ('kg',         'tr', 'Kilogram'),
  ('gram',       'ar', 'غرام'),      ('gram',       'en', 'Gram'),       ('gram',       'tr', 'Gram'),
  ('litre',      'ar', 'لتر'),       ('litre',      'en', 'Litre'),      ('litre',      'tr', 'Litre'),
  ('millilitre', 'ar', 'مليلتر'),    ('millilitre', 'en', 'Millilitre'), ('millilitre', 'tr', 'Mililitre'),
  ('metre',      'ar', 'متر'),       ('metre',      'en', 'Metre'),      ('metre',      'tr', 'Metre'),
  ('centimetre', 'ar', 'سنتيمتر'),   ('centimetre', 'en', 'Centimetre'), ('centimetre', 'tr', 'Santimetre'),
  ('box',        'ar', 'علبة'),      ('box',        'en', 'Box'),        ('box',        'tr', 'Kutu'),
  ('carton',     'ar', 'كرتونة'),    ('carton',     'en', 'Carton'),     ('carton',     'tr', 'Koli'),
  ('dozen',      'ar', 'دزينة'),     ('dozen',      'en', 'Dozen'),      ('dozen',      'tr', 'Düzine'),
  ('hour',       'ar', 'ساعة'),      ('hour',       'en', 'Hour'),       ('hour',       'tr', 'Saat');

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Product inventory configuration (P3-AL-04).
--
-- Every existing product becomes untracked. `unit_code` and `unit_decimals`
-- start NULL for every product: no backfill is guessed from `products.unit`.
-- A tracked product physically cannot exist without canonical units.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN track_inventory BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN unit_code       TEXT NULL,
  ADD COLUMN unit_decimals   SMALLINT NULL;

ALTER TABLE products
  ADD CONSTRAINT products_unit_code_fk FOREIGN KEY (unit_code) REFERENCES units (unit_code),
  ADD CONSTRAINT products_unit_decimals_ck CHECK (unit_decimals IS NULL OR unit_decimals BETWEEN 0 AND 4),
  ADD CONSTRAINT products_tracked_requires_unit_ck
    CHECK (track_inventory = false OR (unit_code IS NOT NULL AND unit_decimals IS NOT NULL));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The base variant shape (P3-AL-03, P3-AL-52).
--
-- `is_base` marks the one system-created stock identity of a simple product.
-- It can never hold merchant identity — no SKU, no barcode, no price of its
-- own, no attributes — so it cannot shadow the product's identifiers in the
-- partial unique indexes of 0005 and cannot become visibly merchant-like even
-- if a read somewhere forgets to hide it.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE product_variants
  ADD COLUMN is_base BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_base_shape_ck
    CHECK (is_base = false OR (sku IS NULL AND barcode IS NULL AND price_minor IS NULL AND attributes = '{}'::jsonb));

CREATE UNIQUE INDEX product_variants_one_base_uq ON product_variants (business_id, product_id) WHERE is_base;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The column guards (P3-AL-54 §F, §G).
--
-- PostgreSQL fires triggers of the same timing and event in NAME order, and
-- the names are part of the contract: `products_10_…` answers WHO may change
-- inventory configuration; P3-S2's `products_20_unit_history_lock` will
-- answer WHEN, and fires after it.
--
-- Both functions pin `pg_catalog, public, pg_temp` even though they resolve no
-- relation: G-5 and the effective-state audit require every routine that is
-- not a SQL-standard body to name pg_temp last, and neither guard needs the
-- caller's path for anything.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION products_10_inventory_config_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- The one principal that may write these columns is the owner of
  -- `inventory_configure_product`, and it is reachable only through that
  -- routine, which consumes a verified invctl/1 assertion first (P3-AL-55).
  IF current_user = 'daftar_inventory_internal' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.track_inventory OR NEW.unit_code IS NOT NULL OR NEW.unit_decimals IS NOT NULL THEN
      RAISE EXCEPTION 'inventory.configuration_authority_required: inventory configuration is written only by the inventory configuration command'
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.track_inventory IS DISTINCT FROM OLD.track_inventory
     OR NEW.unit_code IS DISTINCT FROM OLD.unit_code
     OR NEW.unit_decimals IS DISTINCT FROM OLD.unit_decimals THEN
    RAISE EXCEPTION 'inventory.configuration_authority_required: inventory configuration is written only by the inventory configuration command'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION products_10_inventory_config_authority() IS
  'P3-AL-54 §F. INVOKER-rights guard: refuses any INSERT that sets, and any UPDATE that changes, track_inventory, unit_code or unit_decimals unless current_user is daftar_inventory_internal. Every other products column is untouched by it. Must never be SECURITY DEFINER: inside a definer current_user is the owner, and the guard would admit every writer.';

CREATE OR REPLACE FUNCTION product_variants_10_base_variant_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'daftar_inventory_internal' THEN
    -- The converse: the internal principal writes base variants only. It
    -- holds no UPDATE and no DELETE on this table at all (§H), so a merchant
    -- variant is physically out of its reach.
    IF TG_OP = 'INSERT' AND NOT NEW.is_base THEN
      RAISE EXCEPTION 'catalog.base_variant_not_mutable: the inventory principal writes base variants only'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.is_base OR (TG_OP = 'UPDATE' AND OLD.is_base) THEN
    RAISE EXCEPTION 'catalog.base_variant_not_mutable: a base variant is system stock identity and is not a merchant object'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION product_variants_10_base_variant_authority() IS
  'P3-AL-52 / P3-AL-54 §F. INVOKER-rights guard: an INSERT or UPDATE touching a row with is_base = true (OLD or NEW) is refused unless current_user is daftar_inventory_internal, and that principal may only INSERT is_base = true rows. DELETE is closed by privilege, deliberately not here: a DELETE branch would also refuse the owner-level ON DELETE CASCADE from products and businesses.';

-- The ACL is set while the MIGRATOR still owns the functions, and before the
-- ownership transfer (0044:177-183): after it, a migrator that is a member
-- WITH INHERIT FALSE issues a REVOKE matching no grantor and PostgreSQL only
-- warns. Trigger functions get no EXECUTE grant at all — PostgreSQL does not
-- check EXECUTE when a trigger fires, so a grant would only enable a direct
-- call (P3-AL-54 §D.3).
REVOKE ALL ON FUNCTION products_10_inventory_config_authority() FROM PUBLIC;
REVOKE ALL ON FUNCTION product_variants_10_base_variant_authority() FROM PUBLIC;

-- Installed while the migrator still owns the functions, which is when a
-- non-superuser may legally do it: EXECUTE is checked when a trigger is
-- CREATED, never when it fires.
CREATE TRIGGER products_10_inventory_config_authority
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_10_inventory_config_authority();

CREATE TRIGGER product_variants_10_base_variant_authority
  BEFORE INSERT OR UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION product_variants_10_base_variant_authority();

ALTER FUNCTION products_10_inventory_config_authority() OWNER TO daftar_inventory_internal;
ALTER FUNCTION product_variants_10_base_variant_authority() OWNER TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Grants — default deny (P3-AL-54 §H).
--
--   units          daftar_app SELECT; daftar_inventory_internal SELECT.
--   unit_names     daftar_app SELECT; nobody else.
--   products       daftar_app keeps 0006's SELECT, INSERT, UPDATE (the three
--                  columns guarded by section 5). The internal principal gets
--                  SELECT and UPDATE of exactly the three columns.
--   product_variants
--                  daftar_app keeps 0006's SELECT, INSERT, UPDATE (base rows
--                  guarded by section 5). The internal principal gets SELECT
--                  and INSERT of exactly (business_id, id, product_id,
--                  is_base) — and NO UPDATE and NO DELETE.
--   businesses     SELECT for the internal principal: the RLS subquery of the
--                  business-scoped policies reads it, and the verifier's
--                  structural check needs it (0054).
--
-- No registry has runtime DML; it is extended only by migrations.
-- ─────────────────────────────────────────────────────────────────────────
GRANT SELECT ON units TO daftar_app;
GRANT SELECT ON unit_names TO daftar_app;

GRANT SELECT ON units TO daftar_inventory_internal;
GRANT SELECT ON businesses TO daftar_inventory_internal;
GRANT SELECT ON products TO daftar_inventory_internal;
GRANT UPDATE (track_inventory, unit_code, unit_decimals) ON products TO daftar_inventory_internal;
GRANT SELECT ON product_variants TO daftar_inventory_internal;
GRANT INSERT (business_id, id, product_id, is_base) ON product_variants TO daftar_inventory_internal;

-- Hand back the ownership-transfer authority from section 1.
REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Refuse to commit unless the end state is exactly right.
--
-- `has_*_privilege`, never `information_schema`: that view only shows grants
-- involving a role the CURRENT user can enable, so under a non-superuser
-- migrator it would hide exactly the rows this looks for (0044:224-229).
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role   TEXT;
  v_priv   TEXT;
  v_detail TEXT;
BEGIN
  -- (a) The internal principal itself (P3-AL-54 §C): exists, cannot log in,
  --     holds no attribute, does not inherit, and its only member is the
  --     deployment migrator WITH INHERIT FALSE.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_inventory_internal') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal does not exist — bootstrap.sql creates it';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_inventory_internal'
               AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal is no longer an unreachable NOLOGIN NOINHERIT principal';
  END IF;
  SELECT string_agg(m.rolname || CASE WHEN a.inherit_option THEN ' (INHERIT TRUE)' ELSE '' END, ', ' ORDER BY m.rolname) INTO v_detail
  FROM pg_auth_members a
  JOIN pg_roles g ON g.oid = a.roleid
  JOIN pg_roles m ON m.oid = a.member
  WHERE g.rolname = 'daftar_inventory_internal' AND (m.rolname <> 'daftar_migrator' OR a.inherit_option OR a.admin_option);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: unexpected membership in daftar_inventory_internal: %', v_detail;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
                  WHERE g.rolname = 'daftar_inventory_internal' AND m.rolname = 'daftar_migrator' AND NOT a.inherit_option AND a.set_option) THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_migrator must be a member of daftar_inventory_internal WITH INHERIT FALSE, SET TRUE';
  END IF;
  -- Transitively, too: no runtime role can reach it through any chain.
  FOREACH v_role IN ARRAY ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) AND pg_has_role(v_role, 'daftar_inventory_internal', 'MEMBER') THEN
      RAISE EXCEPTION 'inventory.authority_leak: runtime role % can reach daftar_inventory_internal', v_role;
    END IF;
  END LOOP;
  IF has_database_privilege('daftar_inventory_internal', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds TEMPORARY';
  END IF;
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal still holds CREATE on schema public';
  END IF;

  -- (b) The registries: readable by the merchant runtime (units, names) and
  --     writable by no runtime role and not by PUBLIC.
  FOR v_role IN SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','daftar_inventory_internal','public']) LOOP
    FOR v_priv IN SELECT unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) LOOP
      IF has_table_privilege(v_role, 'units', v_priv) OR has_table_privilege(v_role, 'unit_names', v_priv) THEN
        RAISE EXCEPTION 'inventory.authority_leak: % holds % on the unit registry', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  FOR v_role IN SELECT unnest(ARRAY['daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public']) LOOP
    IF has_table_privilege(v_role, 'units', 'SELECT') OR has_table_privilege(v_role, 'unit_names', 'SELECT') THEN
      RAISE EXCEPTION 'inventory.authority_leak: % may read the unit registry and has no requirement to', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('daftar_app', 'units', 'SELECT') OR NOT has_table_privilege('daftar_app', 'unit_names', 'SELECT') THEN
    RAISE EXCEPTION 'inventory.authority_leak: the merchant runtime cannot read the unit registry';
  END IF;

  -- (c) The internal principal: SELECT plus exactly the three columns on
  --     products, SELECT plus exactly four INSERT columns on variants, and no
  --     table-level UPDATE, no UPDATE and no DELETE on variants at all.
  IF has_table_privilege('daftar_inventory_internal', 'products', 'UPDATE')
     OR has_table_privilege('daftar_inventory_internal', 'products', 'INSERT')
     OR has_table_privilege('daftar_inventory_internal', 'products', 'DELETE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds table-level DML on products';
  END IF;
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO v_detail
  FROM pg_attribute a
  WHERE a.attrelid = 'products'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('daftar_inventory_internal', 'products', a.attname, 'UPDATE')
    AND a.attname NOT IN ('track_inventory', 'unit_code', 'unit_decimals');
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal may UPDATE products column(s) %', v_detail;
  END IF;
  IF has_any_column_privilege('daftar_inventory_internal', 'product_variants', 'UPDATE')
     OR has_table_privilege('daftar_inventory_internal', 'product_variants', 'DELETE')
     OR has_table_privilege('daftar_inventory_internal', 'product_variants', 'INSERT') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds UPDATE, DELETE or table-level INSERT on product_variants';
  END IF;
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO v_detail
  FROM pg_attribute a
  WHERE a.attrelid = 'product_variants'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('daftar_inventory_internal', 'product_variants', a.attname, 'INSERT')
    AND a.attname NOT IN ('business_id', 'id', 'product_id', 'is_base');
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal may INSERT product_variants column(s) %', v_detail;
  END IF;

  -- (d) Both guards exist by name on the right tables, are INVOKER, pin
  --     pg_temp last, are owned by the internal principal, and PUBLIC cannot
  --     execute them.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal
         AND ((t.tgrelid = 'products'::regclass AND t.tgname = 'products_10_inventory_config_authority'
               AND t.tgfoid = 'products_10_inventory_config_authority()'::regprocedure)
           OR (t.tgrelid = 'product_variants'::regclass AND t.tgname = 'product_variants_10_base_variant_authority'
               AND t.tgfoid = 'product_variants_10_base_variant_authority()'::regprocedure))) <> 2 THEN
    RAISE EXCEPTION 'inventory.authority_leak: a column guard trigger is missing from products or product_variants';
  END IF;
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.proname IN ('products_10_inventory_config_authority', 'product_variants_10_base_variant_authority')
    AND (p.prosecdef OR r.rolname <> 'daftar_inventory_internal'
         OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS c WHERE c = 'search_path=pg_catalog, public, pg_temp')
         OR has_function_privilege('public', p.oid, 'EXECUTE'));
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: column guard(s) not INVOKER, not owned by the internal principal, unpinned or PUBLIC-executable: %', v_detail;
  END IF;

  -- (e) No product became tracked, and no base variant exists, because a
  --     migration ran (P3-AL-04 §1). The guarantee is structural — ADD COLUMN
  --     with DEFAULT false / NULL fires no trigger and writes no value — and
  --     this reads only the rows the applying principal's row security
  --     admits (all of them for a superuser, none for a non-superuser
  --     migrator under FORCE). The P3-S1 integration suite reads the same
  --     fact with full visibility over a database that holds products.
  IF EXISTS (SELECT 1 FROM products WHERE track_inventory OR unit_code IS NOT NULL OR unit_decimals IS NOT NULL) THEN
    RAISE EXCEPTION 'inventory.authority_leak: a product carries inventory configuration after the migration that introduced it';
  END IF;
  IF EXISTS (SELECT 1 FROM product_variants WHERE is_base) THEN
    RAISE EXCEPTION 'inventory.authority_leak: a base variant exists after the migration that introduced the column';
  END IF;

  -- (f) The seed is exactly the eleven locked units, each named in all three
  --     locales.
  IF (SELECT count(*) FROM units) <> 11
     OR EXISTS (SELECT 1 FROM units u WHERE (SELECT count(*) FROM unit_names n WHERE n.unit_code = u.unit_code) <> 3) THEN
    RAISE EXCEPTION 'inventory.authority_leak: the unit registry seed is incomplete';
  END IF;
END $$;

COMMENT ON TABLE units IS
  'P3-AL-05 canonical unit registry. Migration-extensible; no conversion factor and no base unit exist in Phase 3. default_decimals is only the suggestion at selection time — products persist their own unit_decimals.';
COMMENT ON TABLE unit_names IS
  'P3-AL-05 localized display names for units. Outside inventory truth: persistence never depends on translated text.';
COMMENT ON COLUMN products.track_inventory IS
  'P3-AL-04. Written only by inventory_configure_product (P3-AL-54 §E, guarded by products_10_inventory_config_authority).';
COMMENT ON COLUMN product_variants.is_base IS
  'P3-AL-03 / P3-AL-52. The one hidden, system-created stock identity of a simple product. Never merchant-visible, never merchant-writable.';
