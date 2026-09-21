-- 0036_catalog_translations_normalized.sql
-- Completion Directive §37–38: product/category translations become
-- NORMALIZED tables and the JSONB columns are retired — ONE writable source.
--
-- Migration protocol (§38): create → BACKFILL → VALIDATE counts + content →
-- CUT OVER (drop the JSONB columns). The migration aborts (transaction rolls
-- back) if any product/category would lose a translation.

CREATE TABLE product_translations (
  business_id UUID NOT NULL,
  product_id  UUID NOT NULL,
  locale      TEXT NOT NULL CHECK (locale IN ('ar', 'en', 'tr')),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  PRIMARY KEY (business_id, product_id, locale),
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id) ON DELETE CASCADE
);

CREATE TABLE category_translations (
  business_id UUID NOT NULL,
  category_id UUID NOT NULL,
  locale      TEXT NOT NULL CHECK (locale IN ('ar', 'en', 'tr')),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  PRIMARY KEY (business_id, category_id, locale),
  FOREIGN KEY (business_id, category_id) REFERENCES categories (business_id, id) ON DELETE CASCADE
);

-- ── Backfill from the JSONB source ─────────────────────────────────────────
INSERT INTO product_translations (business_id, product_id, locale, name)
SELECT p.business_id, p.id, t.key, t.value
FROM products p, jsonb_each_text(p.translations) t
WHERE t.key IN ('ar', 'en', 'tr') AND t.value IS NOT NULL AND char_length(t.value) BETWEEN 1 AND 200;

INSERT INTO category_translations (business_id, category_id, locale, name)
SELECT c.business_id, c.id, t.key, t.value
FROM categories c, jsonb_each_text(c.translations) t
WHERE t.key IN ('ar', 'en', 'tr') AND t.value IS NOT NULL AND char_length(t.value) BETWEEN 1 AND 200;

-- ── Validate: every source entry has a row with identical content ──────────
DO $$
DECLARE
  v_source BIGINT;
  v_target BIGINT;
  v_missing BIGINT;
BEGIN
  SELECT count(*) INTO v_source FROM products p, jsonb_each_text(p.translations) t
   WHERE t.key IN ('ar','en','tr') AND t.value IS NOT NULL AND char_length(t.value) BETWEEN 1 AND 200;
  SELECT count(*) INTO v_target FROM product_translations;
  IF v_source <> v_target THEN
    RAISE EXCEPTION 'product_translations backfill count mismatch: source % vs target %', v_source, v_target;
  END IF;
  SELECT count(*) INTO v_missing FROM products p, jsonb_each_text(p.translations) t
   WHERE t.key IN ('ar','en','tr') AND t.value IS NOT NULL AND char_length(t.value) BETWEEN 1 AND 200
     AND NOT EXISTS (SELECT 1 FROM product_translations x
                     WHERE x.business_id = p.business_id AND x.product_id = p.id AND x.locale = t.key AND x.name = t.value);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'product_translations backfill content mismatch for % entries', v_missing;
  END IF;
  -- Every product must still have at least one translation.
  SELECT count(*) INTO v_missing FROM products p
   WHERE NOT EXISTS (SELECT 1 FROM product_translations x WHERE x.business_id = p.business_id AND x.product_id = p.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% products would have no translation after cut-over', v_missing;
  END IF;

  SELECT count(*) INTO v_source FROM categories c, jsonb_each_text(c.translations) t
   WHERE t.key IN ('ar','en','tr') AND t.value IS NOT NULL AND char_length(t.value) BETWEEN 1 AND 200;
  SELECT count(*) INTO v_target FROM category_translations;
  IF v_source <> v_target THEN
    RAISE EXCEPTION 'category_translations backfill count mismatch: source % vs target %', v_source, v_target;
  END IF;
  SELECT count(*) INTO v_missing FROM categories c, jsonb_each_text(c.translations) t
   WHERE t.key IN ('ar','en','tr') AND t.value IS NOT NULL AND char_length(t.value) BETWEEN 1 AND 200
     AND NOT EXISTS (SELECT 1 FROM category_translations x
                     WHERE x.business_id = c.business_id AND x.category_id = c.id AND x.locale = t.key AND x.name = t.value);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'category_translations backfill content mismatch for % entries', v_missing;
  END IF;
  SELECT count(*) INTO v_missing FROM categories c
   WHERE NOT EXISTS (SELECT 1 FROM category_translations x WHERE x.business_id = c.business_id AND x.category_id = c.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% categories would have no translation after cut-over', v_missing;
  END IF;
END $$;

-- ── Cut over: the JSONB columns are retired — no dual writable source ──────
ALTER TABLE products DROP COLUMN translations;
ALTER TABLE categories DROP COLUMN translations;

-- ── Invariant: every product/category keeps at least one translation ───────
-- Enforced at COMMIT (deferred constraint triggers) so a create can insert
-- the parent row and its translations in any order within one transaction.
CREATE OR REPLACE FUNCTION product_requires_translation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- The same function serves products (id) and product_translations
  -- (product_id): read the row generically so PL/pgSQL never binds a field
  -- that the other table lacks.
  v_row      JSONB := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_business UUID  := (v_row->>'business_id')::uuid;
  v_product  UUID  := CASE WHEN TG_TABLE_NAME = 'products' THEN (v_row->>'id')::uuid ELSE (v_row->>'product_id')::uuid END;
BEGIN
  IF EXISTS (SELECT 1 FROM products p WHERE p.business_id = v_business AND p.id = v_product)
     AND NOT EXISTS (SELECT 1 FROM product_translations t WHERE t.business_id = v_business AND t.product_id = v_product) THEN
    RAISE EXCEPTION 'product % requires at least one translation', v_product USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER products_require_translation
  AFTER INSERT ON products DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION product_requires_translation();
CREATE CONSTRAINT TRIGGER product_translations_keep_one
  AFTER DELETE OR UPDATE ON product_translations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION product_requires_translation();

CREATE OR REPLACE FUNCTION category_requires_translation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_row      JSONB := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_business UUID  := (v_row->>'business_id')::uuid;
  v_category UUID  := CASE WHEN TG_TABLE_NAME = 'categories' THEN (v_row->>'id')::uuid ELSE (v_row->>'category_id')::uuid END;
BEGIN
  IF EXISTS (SELECT 1 FROM categories c WHERE c.business_id = v_business AND c.id = v_category)
     AND NOT EXISTS (SELECT 1 FROM category_translations t WHERE t.business_id = v_business AND t.category_id = v_category) THEN
    RAISE EXCEPTION 'category % requires at least one translation', v_category USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER categories_require_translation
  AFTER INSERT ON categories DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION category_requires_translation();
CREATE CONSTRAINT TRIGGER category_translations_keep_one
  AFTER DELETE OR UPDATE ON category_translations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION category_requires_translation();

-- ── RLS (standard two-policy layering) + grants ────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_translations', 'category_translations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_membership ON %I
      USING (app_bypass() OR EXISTS (
        SELECT 1 FROM businesses b
        WHERE b.id = %I.business_id AND b.tenant_id::text = app_tenant()))
      WITH CHECK (app_bypass() OR EXISTS (
        SELECT 1 FROM businesses b
        WHERE b.id = %I.business_id AND b.tenant_id::text = app_tenant()))', t, t, t);
    EXECUTE format('CREATE POLICY business_isolation ON %I AS RESTRICTIVE
      USING (app_bypass() OR business_id::text = app_business())
      WITH CHECK (app_bypass() OR business_id::text = app_business())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_translations, category_translations TO daftar_app;
GRANT SELECT, INSERT, UPDATE ON product_translations, category_translations TO daftar_platform;

-- Search support: name lookups per business.
CREATE INDEX product_translations_name_idx ON product_translations (business_id, lower(name));
