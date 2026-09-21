-- 0005 — catalog (industry-neutral Phase 1). NO stock/quantity fields anywhere (§56).
CREATE TABLE categories (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  parent_id UUID,
  translations JSONB NOT NULL,   -- {"ar":"...","en":"...","tr":"..."} at least one non-empty
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  FOREIGN KEY (business_id, parent_id) REFERENCES categories(business_id, id),
  CHECK (jsonb_typeof(translations) = 'object' AND translations <> '{}'::jsonb)
);

CREATE TABLE products (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  category_id UUID,
  translations JSONB NOT NULL,   -- {"ar"|"en"|"tr": name}
  sku TEXT,                      -- NULL allowed; unique per business when present (partial index below)
  barcode TEXT,                  -- same scope rule
  base_price_minor BIGINT NOT NULL CHECK (base_price_minor >= 0),  -- money = BIGINT minor, never float
  price_currency TEXT NOT NULL REFERENCES currencies(code),
  unit TEXT,                     -- free unit label Phase 1 (piece/kg/...), optional
  version INT NOT NULL DEFAULT 1, -- optimistic concurrency (§98)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  FOREIGN KEY (business_id, category_id) REFERENCES categories(business_id, id),
  CHECK (char_length(sku) <= 64 AND char_length(barcode) <= 64),
  CHECK (jsonb_typeof(translations) = 'object' AND translations <> '{}'::jsonb)
);
CREATE UNIQUE INDEX products_sku_uq ON products (business_id, lower(sku)) WHERE sku IS NOT NULL AND status <> 'archived';
CREATE UNIQUE INDEX products_barcode_uq ON products (business_id, barcode) WHERE barcode IS NOT NULL AND status <> 'archived';
CREATE INDEX products_list_idx ON products (business_id, created_at, id) WHERE status <> 'archived';

CREATE TABLE product_variants (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,  -- future size/color matrix (§59) without core change
  sku TEXT,
  barcode TEXT,
  price_minor BIGINT CHECK (price_minor IS NULL OR price_minor >= 0), -- NULL = inherit product price
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES products(business_id, id) ON DELETE CASCADE,
  CHECK (char_length(sku) <= 64 AND char_length(barcode) <= 64)
);
CREATE UNIQUE INDEX variants_sku_uq ON product_variants (business_id, lower(sku)) WHERE sku IS NOT NULL AND status <> 'archived';
CREATE UNIQUE INDEX variants_barcode_uq ON product_variants (business_id, barcode) WHERE barcode IS NOT NULL AND status <> 'archived';
CREATE INDEX variants_product_idx ON product_variants (business_id, product_id);

CREATE TABLE media (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  storage_key TEXT NOT NULL UNIQUE,   -- server-generated: tenants/{t}/businesses/{b}/media/{id}/...
  original_mime TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  width INT,
  height INT,
  variants JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{size, storage_key, width, height}]
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id)
);

CREATE TABLE product_media (
  business_id UUID NOT NULL,
  product_id UUID NOT NULL,
  media_id UUID NOT NULL,
  position INT NOT NULL DEFAULT 0,
  id UUID NOT NULL DEFAULT gen_random_uuid(),  -- surrogate PK (UNIQUE NULLS NOT DISTINCT substitute)
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, product_id, media_id),
  FOREIGN KEY (business_id, product_id) REFERENCES products(business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, media_id) REFERENCES media(business_id, id) ON DELETE CASCADE
);
