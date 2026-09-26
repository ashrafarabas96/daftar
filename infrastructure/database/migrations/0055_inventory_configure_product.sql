-- 0055_inventory_configure_product.sql
-- P3-S1, part 3 — the ONE writer of inventory configuration and of base
-- variants: `inventory_configure_product` (P3-AL-04, P3-AL-05, P3-AL-03,
-- P3-AL-52; physically P3-AL-54 §E and P3-AL-55 §G).
--
-- ── What it is ───────────────────────────────────────────────────────────
--
-- A SECURITY DEFINER routine owned by `daftar_inventory_internal`. `daftar_app`
-- holds EXECUTE on it, and that is reachability, not authority: the routine's
-- FIRST decision is `inventory_assertion_consume('inventory.configure_product',
-- <digest of its own four arguments>)`. The application mints that assertion
-- only after `inventory.adjust` passed for the acting member, so a direct call
-- without one — or with one minted for another product, another tracking
-- flag, another unit or another business — is refused before anything is
-- read or written.
--
-- After that it is the only code path that may:
--
--   * write `products.track_inventory`, `unit_code` or `unit_decimals` — the
--     column guard of 0053 refuses every other writer;
--   * insert a row with `is_base = true` — the base-variant guard of 0053
--     refuses every other writer, and refuses this one a merchant variant.
--
-- ── The rules it enforces ────────────────────────────────────────────────
--
--   * the product is in the ASSERTED business (never an argument, never the
--     GUC alone — step 9 of the verifier already made the GUC equal it);
--   * a named unit exists in the `units` registry;
--   * `unit_decimals` is 0..4 and is only ever given together with a unit;
--   * tracked ⇒ a canonical unit is present (P3-AL-04);
--   * enabling tracking on a product with NO variants creates its hidden base
--     variant, idempotently (P3-AL-03, P3-AL-52);
--   * a unit is never cleared: omitting the unit keeps the current one, so
--     disabling tracking and re-enabling it reuses the historical unit
--     (P3-AL-05 §D).
--
-- The unit-history lock (`products_20_unit_history_lock`) and the
-- disable-at-non-zero-stock rule (P3-AL-41) are P3-S2's, because the tables
-- they read do not exist yet.
--
-- Audit is written HERE, with the actor taken from the verified assertion —
-- never from `app.actor_user_id` or an argument (P3-AL-54 §E) — and only when
-- something changed.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

-- The routine writes its own audit row (P3-AL-54 §H). INSERT only: an audit
-- row it wrote cannot be read back, changed or removed by it.
GRANT INSERT ON audit_events TO daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The business-transaction trace (P3-AL-35).
--
-- Every audit event an operation produces carries its business_transaction_id.
-- The routine signatures are locked, so the seam sets it transaction-locally
-- in `app.business_transaction_id`. It is OBSERVABILITY ONLY: never authority,
-- never part of the invpl/1 payload, never read for any decision. Absent is
-- NULL; present, it must be a canonical lowercase UUID or the command is
-- refused (inventory.trace_malformed) — a trace that cannot be joined on is
-- worse than none, and the application always sends a canonical one.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_business_transaction_id() RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_raw TEXT := nullif(current_setting('app.business_transaction_id', true), '');
BEGIN
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_raw !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'inventory.trace_malformed: app.business_transaction_id is not a canonical lowercase UUID' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_raw::uuid;
END;
$$;

COMMENT ON FUNCTION inventory_business_transaction_id() IS
  'P3-AL-35. The operation''s business_transaction_id from the transaction-local carrier app.business_transaction_id, for audit metadata only: NULL when absent, inventory.trace_malformed when present but not a canonical lowercase UUID. Never authority. No EXECUTE grant.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The routine.
--
-- Returns one row describing the product's configuration AFTER the call:
--   product_id, track_inventory, unit_code, unit_decimals,
--   base_variant_id  the product's hidden base variant, or NULL when it has
--                    none (a product with merchant variants never gets one),
--   changed          false when the call was an idempotent no-op.
--
-- Argument semantics:
--   p_track          required; the tracking flag the product must end with.
--   p_unit_code      NULL keeps the current unit; otherwise a `units` code.
--   p_unit_decimals  NULL: the unit's registry default when the unit changes,
--                    otherwise the current precision; non-NULL requires
--                    p_unit_code.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_configure_product(
  p_product_id    UUID,
  p_track         BOOLEAN,
  p_unit_code     TEXT,
  p_unit_decimals SMALLINT
) RETURNS TABLE (
  product_id      UUID,
  track_inventory BOOLEAN,
  unit_code       TEXT,
  unit_decimals   SMALLINT,
  base_variant_id UUID,
  changed         BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_actor      inventory_verified_actor;
  v_business   UUID;
  v_old_track  BOOLEAN;
  v_old_unit   TEXT;
  v_old_dec    SMALLINT;
  v_new_unit   TEXT;
  v_new_dec    SMALLINT;
  v_default    SMALLINT;
  v_merchant   BOOLEAN;
  v_base       UUID;
  v_created    BOOLEAN := false;
  v_changed    BOOLEAN;
  v_trace      UUID;
BEGIN
  -- 1. Authority first. The digest is computed from this routine's OWN
  --    arguments, in the P3-AL-55 §F field order, so an assertion minted for
  --    any other value of any of them is refused here.
  v_actor := inventory_assertion_consume(
    'inventory.configure_product',
    inventory_claimed_payload_digest(
      'inventory.configure_product',
      ARRAY['uuid', 'boolean', 'code', 'integer'],
      ARRAY[p_product_id::text, p_track::text, p_unit_code, p_unit_decimals::text]
    )
  );
  v_business := v_actor.business_id;
  v_trace    := inventory_business_transaction_id();

  -- 2. Shape. A signed NULL product or flag cannot occur (the minter refuses
  --    it), so these are programming errors surfaced with a stable code.
  IF p_product_id IS NULL OR p_track IS NULL THEN
    RAISE EXCEPTION 'inventory.payload_invalid: a product configuration names its product and its tracking flag' USING ERRCODE = 'P0001';
  END IF;
  IF p_unit_decimals IS NOT NULL AND p_unit_code IS NULL THEN
    RAISE EXCEPTION 'inventory.unit_required: a unit precision is given only together with its unit' USING ERRCODE = 'P0001';
  END IF;
  IF p_unit_decimals IS NOT NULL AND (p_unit_decimals < 0 OR p_unit_decimals > 4) THEN
    RAISE EXCEPTION 'inventory.unit_decimals_invalid: a unit precision is between 0 and 4 decimal places' USING ERRCODE = 'P0001';
  END IF;

  -- 3. The product, in the asserted business only, locked for the decision.
  SELECT p.track_inventory, p.unit_code, p.unit_decimals
    INTO v_old_track, v_old_unit, v_old_dec
  FROM products p
  WHERE p.business_id = v_business AND p.id = p_product_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory.product_not_found: the product does not exist in this business' USING ERRCODE = 'P0001';
  END IF;

  -- 4. The resulting unit. Never cleared: NULL keeps what is there.
  IF p_unit_code IS NULL THEN
    v_new_unit := v_old_unit;
    v_new_dec  := v_old_dec;
  ELSE
    SELECT u.default_decimals INTO v_default FROM units u WHERE u.unit_code = p_unit_code;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'inventory.unit_unknown: the unit is not a canonical unit' USING ERRCODE = 'P0001';
    END IF;
    v_new_unit := p_unit_code;
    v_new_dec  := coalesce(p_unit_decimals,
                           CASE WHEN p_unit_code = v_old_unit THEN v_old_dec END,
                           v_default);
  END IF;

  -- 5. Tracked ⇒ a canonical unit (P3-AL-04).
  IF p_track AND v_new_unit IS NULL THEN
    RAISE EXCEPTION 'inventory.unit_required: tracking inventory requires a canonical unit' USING ERRCODE = 'P0001';
  END IF;

  -- 6. Write only what changes. The UPDATE fires the column guard, which
  --    admits it because this routine runs as daftar_inventory_internal.
  v_changed := v_old_track IS DISTINCT FROM p_track
            OR v_old_unit  IS DISTINCT FROM v_new_unit
            OR v_old_dec   IS DISTINCT FROM v_new_dec;
  IF v_changed THEN
    UPDATE products p
       SET track_inventory = p_track, unit_code = v_new_unit, unit_decimals = v_new_dec
     WHERE p.business_id = v_business AND p.id = p_product_id;
  END IF;

  -- 7. The hidden base variant (P3-AL-03). Only when the product ends
  --    tracked and has no merchant variant in any status: a product with
  --    variants tracks them, and an archived merchant variant is still a
  --    variant. The partial unique index makes a second base variant
  --    impossible, so a concurrent or repeated call is a no-op.
  IF p_track THEN
    SELECT EXISTS (SELECT 1 FROM product_variants v
                    WHERE v.business_id = v_business AND v.product_id = p_product_id AND NOT v.is_base)
      INTO v_merchant;
    IF NOT v_merchant THEN
      INSERT INTO product_variants (business_id, id, product_id, is_base)
      VALUES (v_business, gen_random_uuid(), p_product_id, true)
      ON CONFLICT (business_id, product_id) WHERE is_base DO NOTHING;
      v_created := FOUND;
    END IF;
  END IF;

  SELECT v.id INTO v_base
  FROM product_variants v
  WHERE v.business_id = v_business AND v.product_id = p_product_id AND v.is_base;

  -- 8. Audit, with the SIGNED actor, only when something happened.
  IF v_changed OR v_created THEN
    INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
    VALUES (v_actor.tenant_id, v_business, v_actor.actor_user_id, 'inventory.product_configured', 'product', p_product_id::text,
            jsonb_build_object(
              'trackInventory', p_track,
              'unitCode', v_new_unit,
              'unitDecimals', v_new_dec,
              'previous', jsonb_build_object('trackInventory', v_old_track, 'unitCode', v_old_unit, 'unitDecimals', v_old_dec),
              'baseVariantId', v_base,
              'baseVariantCreated', v_created,
              'assertionJti', v_actor.jti,
              'business_transaction_id', v_trace));
  END IF;

  product_id      := p_product_id;
  track_inventory := p_track;
  unit_code       := v_new_unit;
  unit_decimals   := v_new_dec;
  base_variant_id := v_base;
  changed         := v_changed OR v_created;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT) IS
  'P3-AL-54 §E, P3-AL-55 §G. The only writer of products.track_inventory/unit_code/unit_decimals and of base variants. First consumes an invctl/1 assertion of kind inventory.configure_product over the digest of its own arguments; the business is the asserted one. Then: product in that business (inventory.product_not_found), unit in the registry (inventory.unit_unknown), precision 0..4 given only with a unit (inventory.unit_decimals_invalid, inventory.unit_required), tracked => unit (inventory.unit_required); a NULL unit keeps the current one. Creates the hidden base variant when the product ends tracked and has no merchant variant, idempotently. Audits inventory.product_configured with the signed actor when anything changed. EXECUTE: daftar_app only — reachability, not authority.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. ACL while the migrator still owns them, then the ownership transfer.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION inventory_business_transaction_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT) TO daftar_app;
ALTER FUNCTION inventory_business_transaction_id() OWNER TO daftar_inventory_internal;
ALTER FUNCTION inventory_configure_product(UUID, BOOLEAN, TEXT, SMALLINT) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Refuse to commit unless the end state is exactly right.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role TEXT;
  v_proc REGPROCEDURE := 'inventory_configure_product(uuid,boolean,text,smallint)'::regprocedure;
BEGIN
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal still holds CREATE on schema public';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = v_proc AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                    AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'inventory.authority_leak: inventory_configure_product is not an internal-owned SECURITY DEFINER routine with a pinned search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = 'inventory_business_transaction_id()'::regprocedure AND r.rolname = 'daftar_inventory_internal' AND p.prosecdef
                    AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp'])
     OR has_function_privilege('public', 'inventory_business_transaction_id()', 'EXECUTE')
     OR has_function_privilege('daftar_app', 'inventory_business_transaction_id()', 'EXECUTE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: inventory_business_transaction_id is not an internal-only routine';
  END IF;
  IF NOT has_function_privilege('daftar_app', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_app cannot reach inventory_configure_product';
  END IF;
  FOR v_role IN SELECT unnest(ARRAY['daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','public']) LOOP
    IF has_function_privilege(v_role, v_proc, 'EXECUTE') THEN
      RAISE EXCEPTION 'inventory.authority_leak: % may execute inventory_configure_product', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('daftar_inventory_internal', 'audit_events', 'INSERT')
     OR has_table_privilege('daftar_inventory_internal', 'audit_events', 'SELECT')
     OR has_table_privilege('daftar_inventory_internal', 'audit_events', 'UPDATE')
     OR has_table_privilege('daftar_inventory_internal', 'audit_events', 'DELETE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal must hold INSERT on audit_events and nothing else';
  END IF;
  IF has_table_privilege('daftar_inventory_internal', 'journal_entries', 'SELECT')
     OR has_table_privilege('daftar_inventory_internal', 'journal_entries', 'INSERT') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal holds a privilege on journal_entries';
  END IF;
END $$;
