-- Pack B world: a LOT-TRACKED product and an untracked sibling, in business A.
--
-- WHY A FIXTURE DEFINER, STATED SO NOBODY READS MORE INTO THIS RUN THAN RAN.
-- `track_inventory` and now `track_lot` are inventory configuration, and the
-- frozen `products_10_inventory_config_authority` plus Pack B's own
-- `products_05_lot_config_authority` bind them to ONE principal:
-- `daftar_inventory_internal`, reachable in production only through the
-- inventory configuration command, which consumes a signed `invctl/1`
-- assertion first.
--
-- That command is `inventory_configure_product(uuid, boolean, text, smallint)`
-- and it CANNOT carry `track_lot`: its authority digest is computed from
-- exactly those four arguments in a fixed field order, so a new argument
-- changes the signature of a frozen definition — the shape P4-S7 was
-- rejected over. Phase 11 therefore owes the inventory authority a NEW
-- registered operation kind and its own command (see
-- `P11-MIGRATION-PATCH-REQUEST.md`); it is not Phase 11's to register.
--
-- So this world configures the two products through a SECURITY DEFINER
-- routine owned by the internal role — the same mechanism the real command
-- uses, WITHOUT the assertion, created here in the WORLD and not in the pack.
-- Consequence for the evidence: the overlay's laws below are `PROVEN BY TEST`;
-- the real configuration path for `track_lot` is `UNMEASURED`, and the
-- assertion-consuming command does not exist yet.
SET app.tenant_id='11111111-1111-1111-1111-111111111111';
SET app.business_id='aaaaaaaa-0000-0000-0000-00000000000a';
BEGIN;
INSERT INTO branches (business_id,id,name) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','7b000000-0000-0000-0000-00000000007b','BR-LOT') ON CONFLICT DO NOTHING;
INSERT INTO warehouses (business_id,id,branch_id,name) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','7c000000-0000-0000-0000-00000000007c','7b000000-0000-0000-0000-00000000007b','WH-LOT');
INSERT INTO products (business_id,id,sku,status,base_price_minor,price_currency) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','7d000000-0000-0000-0000-00000000007d','LOT-P','active',0,'ILS');
INSERT INTO product_translations (business_id,product_id,locale,name) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','7d000000-0000-0000-0000-00000000007d','ar','دواء');
INSERT INTO products (business_id,id,sku,status,base_price_minor,price_currency) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','7e000000-0000-0000-0000-00000000007e','NOLOT-P','active',0,'ILS');
INSERT INTO product_translations (business_id,product_id,locale,name) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','7e000000-0000-0000-0000-00000000007e','ar','صابون');
INSERT INTO products (business_id,id,sku,status,base_price_minor,price_currency) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','7f000000-0000-0000-0000-00000000007f','PLAIN-P','active',0,'ILS');
INSERT INTO product_translations (business_id,product_id,locale,name) VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','7f000000-0000-0000-0000-00000000007f','ar','قلم');
COMMIT;

CREATE FUNCTION fixture_configure_lot_product(p_product UUID, p_track_lot BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fx$
BEGIN
  UPDATE products
     SET track_inventory = true, unit_code = 'piece', unit_decimals = 0, track_lot = p_track_lot
   WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid
     AND id = p_product;
  -- The base variant, exactly as the real command creates it (its step 7):
  -- the internal principal holds column INSERT on (business_id, id,
  -- product_id, is_base) and nothing else, which is why only those four
  -- appear here.
  INSERT INTO product_variants (business_id, id, product_id, is_base)
  VALUES (nullif(current_setting('app.business_id', true), '')::uuid, gen_random_uuid(), p_product, true)
  ON CONFLICT (business_id, product_id) WHERE is_base DO NOTHING;
END; $fx$;
ALTER FUNCTION fixture_configure_lot_product(UUID, BOOLEAN) OWNER TO daftar_inventory_internal;

CREATE FUNCTION fixture_force_lot_flag(p_product UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fx$
BEGIN
  -- ONLY the lot flag, so `products_lot_requires_tracking_ck` is reachable:
  -- a lot of something that holds no stock at all.
  UPDATE products SET track_lot = true
   WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid AND id = p_product;
END; $fx$;
ALTER FUNCTION fixture_force_lot_flag(UUID) OWNER TO daftar_inventory_internal;

SELECT fixture_configure_lot_product('7d000000-0000-0000-0000-00000000007d', true);
SELECT fixture_configure_lot_product('7e000000-0000-0000-0000-00000000007e', false);

SELECT 'PACK B WORLD BUILT' AS step,
       (SELECT count(*) FROM products WHERE business_id='aaaaaaaa-0000-0000-0000-00000000000a' AND track_inventory) AS tracked,
       (SELECT count(*) FROM products WHERE business_id='aaaaaaaa-0000-0000-0000-00000000000a' AND track_lot) AS lot_tracked,
       (SELECT count(*) FROM product_variants WHERE business_id='aaaaaaaa-0000-0000-0000-00000000000a' AND product_id IN ('7d000000-0000-0000-0000-00000000007d','7e000000-0000-0000-0000-00000000007e')) AS base_variants;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE OFFICIAL COMMAND PATH, and why the fixture now goes through it.
--
-- The first version of the Pack B proof wrote `stock_source_bindings` and
-- `stock_movements` by hand as the internal principal. Eight cases failed on
-- `inventory.stock_source_line_missing`, and the refusal was right: a binding
-- of source type `inventory_adjustment` requires a row in
-- `stock_source_bridge_inventory_adjustment`, whose ONE writer
-- (`inventory_bridge_source_lines`, 0062) refuses unless THIS transaction's
-- entry routine consumed an inventory assertion for an operation that owns
-- that source type. There is no way to satisfy that by hand that is not a
-- forgery of the authority.
--
-- So the fixture stops writing movements and calls `inventory_adjust_stock`,
-- the official command, which is also what PART 7.8 requires of a
-- specialized unit: consume the official services, create no second
-- inventory. Every lot-overlay case below is therefore an overlay over a
-- movement written by the REAL writer, with its real binding and its real
-- bridge row.
--
-- What that costs, stated rather than hidden: a scratch assertion KEY is
-- installed in this throw-away database so the fixture can mint the
-- assertion the command demands. The key is 32 bytes of `ab`, it exists only
-- in this scratch cluster, and minting is exactly what the production seam
-- does. The minter is NOT part of Pack A or Pack B: it is fixture code, it
-- is never proposed for a migration, and the DDL under test does not read it.
-- The assertion machinery itself is 0054's and is not being tested here --
-- it is being USED, as a caller.
INSERT INTO inventory_assertion_keys (kid, secret)
  VALUES ('p11scratch', decode(repeat('ab', 32), 'hex')) ON CONFLICT (kid) DO NOTHING;

-- The document's actor. `inventory_adjustments.actor_user_id` references
-- `users`, which this world had no row in -- found by applying it.
INSERT INTO users (id, email, password_hash, display_name, preferred_locale)
  VALUES ('99999999-0000-0000-0000-000000000099', 'p11-fixture@scratch.invalid', 'x', 'P11 fixture actor', 'ar')
  ON CONFLICT (id) DO NOTHING;

CREATE FUNCTION fixture_mint(p_wire_op TEXT, p_digest TEXT, p_actor UUID, p_tenant UUID, p_business UUID)
RETURNS TEXT LANGUAGE plpgsql AS $fx$
DECLARE v_c TEXT[]; v_secret BYTEA;
BEGIN
  SELECT secret INTO v_secret FROM inventory_assertion_keys WHERE kid = 'p11scratch';
  -- invctl1 . kid . actor . tenant . business . op . payload_sha256 . exp . jti,
  -- then the MAC over the domain-prefixed preimage of those nine (0054 §G).
  -- The expiry is 50 s out: inside the 60+5 s ceiling the verifier enforces,
  -- so a fixture cannot mint a long-lived assertion either.
  v_c := ARRAY['invctl1', 'p11scratch', p_actor::text, p_tenant::text, p_business::text, p_wire_op, p_digest,
               (floor(extract(epoch FROM clock_timestamp())) + 50)::bigint::text, gen_random_uuid()::text];
  RETURN array_to_string(v_c, '.') || '.' ||
         encode(hmac(convert_to('invctl/1' || E'\n' || array_to_string(v_c, '.'), 'UTF8'), v_secret, 'sha256'), 'hex');
END; $fx$;

-- The digest of the command's own arguments, in the command's own field
-- order. `inventory_claimed_payload_digest` cannot be used here: it reads the
-- claimed tenant and business OUT OF the carrier, which does not exist yet
-- when the digest is being computed -- so the fixture calls the underlying
-- `inventory_payload_digest` with them stated.
CREATE FUNCTION fixture_adjust_digest(p_adj UUID, p_wh UUID, p_on DATE, p_reason TEXT,
    p_vids UUID[], p_qtys NUMERIC[], p_costs NUMERIC[], p_exp BIGINT[], p_tenant UUID, p_business UUID)
RETURNS TEXT LANGUAGE sql AS $fx$
  SELECT inventory_payload_digest('inventory.adjust', p_tenant, p_business,
    ARRAY['uuid','uuid','integer','integer','integer','integer','integer','integer','integer','integer','integer','integer']
      || ARRAY(SELECT f.t FROM unnest(p_vids, p_qtys, p_costs, p_exp) WITH ORDINALITY AS l(v, q, c, e, i)
               CROSS JOIN LATERAL unnest(ARRAY['uuid','integer','integer','integer']) WITH ORDINALITY AS f(t, j) ORDER BY l.i, f.j),
    ARRAY[p_adj::text, p_wh::text, to_char(p_on, 'YYYYMMDD')]
      || inventory_reason_words(p_reason)
      || ARRAY[coalesce(cardinality(p_vids), 0)::text]
      || ARRAY(SELECT f.x FROM unnest(p_vids, p_qtys, p_costs, p_exp) WITH ORDINALITY AS l(v, q, c, e, i)
               CROSS JOIN LATERAL unnest(ARRAY[l.v::text, inventory_fixed_text(l.q, 4), inventory_fixed_text(l.c, 10), l.e::text])
                 WITH ORDINALITY AS f(x, j) ORDER BY l.i, f.j));
$fx$;

-- One official inbound adjustment, returning the id of the movement the real
-- writer created. The COMMAND is called as `daftar_app`, the principal that
-- holds its EXECUTE grant in production, so the grant is exercised by the
-- caller it was granted to and not by a superuser.
CREATE FUNCTION fixture_adjust(p_doc UUID, p_wh UUID, p_variant UUID, p_qty NUMERIC, p_cost NUMERIC DEFAULT 0)
RETURNS UUID LANGUAGE plpgsql AS $fx$
DECLARE
  v_tenant   UUID := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_business UUID := nullif(current_setting('app.business_id', true), '')::uuid;
  v_actor    UUID := '99999999-0000-0000-0000-000000000099';
  v_on       DATE := DATE '2026-10-12';
  v_reason   TEXT := 'p11 lot overlay proof';
  v_exp      BIGINT;
  v_dig      TEXT;
  v_line     UUID;
  v_mv       UUID;
  v_role     TEXT := current_setting('role');
BEGIN
  -- For an inbound adjustment the value the server derives is the quantity at
  -- the stated unit cost; the command refuses any other expected value, so a
  -- wrong guess here fails loudly rather than silently.
  --
  -- The default cost is ZERO, and that is a deliberate boundary rather than
  -- laziness. `inventory_adjustments_binding_owed_ck` makes a NON-zero total
  -- owe a row in `accounting_source_bindings`, which only the ACCOUNTING
  -- authority may write: a fixture that wrote one would be answering an
  -- accounting question, which this phase may state and may not answer. A
  -- zero-value receipt owes no binding, and it is the right fixture for this
  -- pack in any case -- the lot overlay is value-neutral by law (C-LOT-04),
  -- so no case here needs money to exist. Measured the other way first: with
  -- cost 1 the five conservation cases failed at COMMIT on
  -- `inventory_adjustments_binding_fk`, which is the accounting authority
  -- correctly refusing an unbound valued document.
  v_exp := (p_qty * p_cost)::bigint;
  v_dig := fixture_adjust_digest(p_doc, p_wh, v_on, v_reason,
             ARRAY[p_variant], ARRAY[p_qty], ARRAY[p_cost], ARRAY[v_exp], v_tenant, v_business);
  PERFORM set_config('app.inventory_assertion', fixture_mint('inventory:adjust', v_dig, v_actor, v_tenant, v_business), true);
  PERFORM set_config('app.business_transaction_id', gen_random_uuid()::text, true);
  PERFORM set_config('role', 'daftar_app', true);
  SELECT line_id INTO v_line FROM inventory_adjust_stock(p_doc, p_wh, v_on, v_reason,
            ARRAY[p_variant], ARRAY[p_qty], ARRAY[p_cost], ARRAY[v_exp]);
  PERFORM set_config('role', CASE WHEN v_role IN ('none', '') THEN 'none' ELSE v_role END, true);
  IF v_line IS NULL THEN
    RAISE EXCEPTION 'fixture.adjust_produced_no_line: the official command returned no line, so no overlay can name a movement';
  END IF;
  SELECT id INTO v_mv FROM stock_movements WHERE business_id = v_business AND source_line_id = v_line;
  IF v_mv IS NULL THEN
    RAISE EXCEPTION 'fixture.adjust_produced_no_movement: the command wrote a line with no movement';
  END IF;
  RETURN v_mv;
END; $fx$;
SELECT 'PACK B COMMAND FIXTURE READY' AS step;
