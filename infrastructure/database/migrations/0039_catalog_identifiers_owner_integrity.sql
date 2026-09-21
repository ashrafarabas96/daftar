-- 0039_catalog_identifiers_owner_integrity.sql
-- Final Release Blocker 2 — CATALOG IDENTIFIER OWNER INTEGRITY.
--
-- 0037 made SKU/barcode uniqueness business-wide across products and
-- variants, but the registry row only carried (owner_type, owner_id) with no
-- referential proof: a row could name a product that does not exist, a
-- variant of another business, or be inserted directly by daftar_app to
-- "reserve" an identifier nobody owns.
--
-- After this migration:
--   * every registry row references exactly ONE real owner through a
--     composite foreign key in the same business — product XOR variant —
--     and disappears with it (ON DELETE CASCADE);
--   * the registry is INTERNAL: no runtime role holds INSERT/UPDATE/DELETE on
--     it. The only writer is the sync trigger, which now runs as a SECURITY
--     DEFINER routine owned by the schema owner, driven by real product /
--     variant mutations;
--   * reads stay RLS-scoped (the 0037 policies are unchanged).
-- Frozen migrations are untouched (Directive §51).

-- ── Owner columns + backfill from the 0037 rows ────────────────────────────
ALTER TABLE catalog_identifiers
  ADD COLUMN product_id UUID,
  ADD COLUMN variant_id UUID;

UPDATE catalog_identifiers SET product_id = owner_id WHERE owner_type = 'product';
UPDATE catalog_identifiers SET variant_id = owner_id WHERE owner_type = 'variant';

-- Validation before the constraints: an orphan row would prove the 0037
-- registry drifted, and the migration must stop rather than hide it.
DO $$
DECLARE v_orphans BIGINT;
BEGIN
  SELECT count(*) INTO v_orphans
  FROM catalog_identifiers ci
  WHERE (ci.owner_type = 'product' AND NOT EXISTS (SELECT 1 FROM products p WHERE p.business_id = ci.business_id AND p.id = ci.product_id))
     OR (ci.owner_type = 'variant' AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.business_id = ci.business_id AND v.id = ci.variant_id));
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'catalog_identifiers holds % orphan row(s) — refusing to add owner constraints over a drifted registry', v_orphans;
  END IF;
END $$;

ALTER TABLE catalog_identifiers
  ADD CONSTRAINT catalog_identifiers_owner_xor CHECK (
    (owner_type = 'product' AND product_id IS NOT NULL AND product_id = owner_id AND variant_id IS NULL) OR
    (owner_type = 'variant' AND variant_id IS NOT NULL AND variant_id = owner_id AND product_id IS NULL)
  ),
  ADD CONSTRAINT catalog_identifiers_product_fk
    FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT catalog_identifiers_variant_fk
    FOREIGN KEY (business_id, variant_id) REFERENCES product_variants (business_id, id) ON DELETE CASCADE;

-- ── The registry is internal: no runtime role may write it directly ────────
REVOKE INSERT, UPDATE, DELETE ON catalog_identifiers FROM daftar_app;
REVOKE INSERT, UPDATE, DELETE ON catalog_identifiers FROM daftar_platform;

-- ── Sync routine: SECURITY DEFINER, owner-run, fed only by owner-row mutations ──
CREATE OR REPLACE FUNCTION catalog_identifiers_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_new        JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_old        JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_owner_type TEXT := CASE WHEN TG_TABLE_NAME = 'products' THEN 'product' ELSE 'variant' END;
  v_owner_id   UUID := COALESCE((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid);
  v_business   UUID := COALESCE((v_new ->> 'business_id')::uuid, (v_old ->> 'business_id')::uuid);
  v_live       BOOLEAN := TG_OP <> 'DELETE' AND (v_new ->> 'status') <> 'archived';
  v_sku        TEXT := v_new ->> 'sku';
  v_barcode    TEXT := v_new ->> 'barcode';
  v_product    UUID := CASE WHEN v_owner_type = 'product' THEN v_owner_id END;
  v_variant    UUID := CASE WHEN v_owner_type = 'variant' THEN v_owner_id END;
BEGIN
  -- Release everything this owner held, then re-register the live values.
  DELETE FROM catalog_identifiers
   WHERE business_id = v_business AND owner_type = v_owner_type AND owner_id = v_owner_id;
  IF v_live THEN
    IF v_sku IS NOT NULL AND btrim(v_sku) <> '' THEN
      INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id, product_id, variant_id)
      VALUES (v_business, 'sku', catalog_identifier_norm('sku', v_sku), v_owner_type, v_owner_id, v_product, v_variant);
    END IF;
    IF v_barcode IS NOT NULL AND btrim(v_barcode) <> '' THEN
      INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id, product_id, variant_id)
      VALUES (v_business, 'barcode', catalog_identifier_norm('barcode', v_barcode), v_owner_type, v_owner_id, v_product, v_variant);
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION catalog_identifiers_sync() FROM PUBLIC;
-- Triggers (0037) keep pointing at this function; nothing else may call it.
