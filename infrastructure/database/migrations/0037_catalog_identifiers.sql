-- 0037_catalog_identifiers.sql
-- Completion Directive §39–40: IDENTIFIER REGISTRY. Business-wide uniqueness
-- of SKU and barcode ACROSS products and variants, enforced by the database
-- itself — even raw SQL cannot create a collision.
--
-- The per-table partial unique indexes (0005) only prevent product↔product
-- and variant↔variant duplicates; a product SKU equal to another product's
-- variant SKU was only caught by application code. The registry below owns
-- one row per live identifier per business; row-level triggers on products
-- and product_variants keep it in sync, so any collision — across tables,
-- from any client — fails on the registry's primary key.

CREATE TABLE catalog_identifiers (
  business_id UUID NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('sku', 'barcode')),
  value_norm  TEXT NOT NULL CHECK (char_length(value_norm) BETWEEN 1 AND 64),
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('product', 'variant')),
  owner_id    UUID NOT NULL,
  PRIMARY KEY (business_id, kind, value_norm)
);
CREATE INDEX catalog_identifiers_owner_idx ON catalog_identifiers (business_id, owner_type, owner_id);

-- Normalization: SKUs are case-insensitive (matches the 0005 lower(sku)
-- indexes); barcodes are exact.
CREATE OR REPLACE FUNCTION catalog_identifier_norm(p_kind TEXT, p_value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_kind = 'sku' THEN lower(btrim(p_value)) ELSE btrim(p_value) END
$$;

-- One maintenance routine for both owner tables. Live = status <> 'archived'.
CREATE OR REPLACE FUNCTION catalog_identifiers_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_owner_type TEXT := CASE WHEN TG_TABLE_NAME = 'products' THEN 'product' ELSE 'variant' END;
  v_owner_id   UUID := COALESCE(NEW.id, OLD.id);
  v_business   UUID := COALESCE(NEW.business_id, OLD.business_id);
  v_live       BOOLEAN := TG_OP <> 'DELETE' AND NEW.status <> 'archived';
BEGIN
  -- Release everything this owner held, then re-register the live values.
  DELETE FROM catalog_identifiers
   WHERE business_id = v_business AND owner_type = v_owner_type AND owner_id = v_owner_id;
  IF v_live THEN
    IF NEW.sku IS NOT NULL AND btrim(NEW.sku) <> '' THEN
      INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id)
      VALUES (v_business, 'sku', catalog_identifier_norm('sku', NEW.sku), v_owner_type, v_owner_id);
    END IF;
    IF NEW.barcode IS NOT NULL AND btrim(NEW.barcode) <> '' THEN
      INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id)
      VALUES (v_business, 'barcode', catalog_identifier_norm('barcode', NEW.barcode), v_owner_type, v_owner_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER products_identifiers_sync
  AFTER INSERT OR UPDATE OF sku, barcode, status OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION catalog_identifiers_sync();
CREATE TRIGGER product_variants_identifiers_sync
  AFTER INSERT OR UPDATE OF sku, barcode, status OR DELETE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION catalog_identifiers_sync();

-- ── Backfill the registry from live rows (a collision here aborts the migration) ──
INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id)
SELECT business_id, 'sku', catalog_identifier_norm('sku', sku), 'product', id
  FROM products WHERE sku IS NOT NULL AND btrim(sku) <> '' AND status <> 'archived';
INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id)
SELECT business_id, 'barcode', catalog_identifier_norm('barcode', barcode), 'product', id
  FROM products WHERE barcode IS NOT NULL AND btrim(barcode) <> '' AND status <> 'archived';
INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id)
SELECT business_id, 'sku', catalog_identifier_norm('sku', sku), 'variant', id
  FROM product_variants WHERE sku IS NOT NULL AND btrim(sku) <> '' AND status <> 'archived';
INSERT INTO catalog_identifiers (business_id, kind, value_norm, owner_type, owner_id)
SELECT business_id, 'barcode', catalog_identifier_norm('barcode', barcode), 'variant', id
  FROM product_variants WHERE barcode IS NOT NULL AND btrim(barcode) <> '' AND status <> 'archived';

-- ── RLS + grants: the trigger runs with the invoker's privileges ───────────
ALTER TABLE catalog_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_identifiers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_membership ON catalog_identifiers
  USING (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = catalog_identifiers.business_id AND b.tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = catalog_identifiers.business_id AND b.tenant_id::text = app_tenant()));
CREATE POLICY business_isolation ON catalog_identifiers AS RESTRICTIVE
  USING (app_bypass() OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_identifiers TO daftar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_identifiers TO daftar_platform;
