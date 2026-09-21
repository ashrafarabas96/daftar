-- 0001 — platform reference data (tenant-independent)
CREATE TABLE currencies (
  code TEXT PRIMARY KEY,               -- ISO 4217 alpha
  numeric_code TEXT NOT NULL UNIQUE,   -- ISO 4217 numeric
  minor_units SMALLINT NOT NULL CHECK (minor_units BETWEEN 0 AND 3)
);
INSERT INTO currencies (code, numeric_code, minor_units) VALUES
  ('ILS','376',2), ('JOD','400',3), ('LBP','422',2), ('SYP','760',2),
  ('TRY','949',2), ('USD','840',2), ('EUR','978',2);

CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reserved_store_slugs (
  slug TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
INSERT INTO reserved_store_slugs (slug) VALUES
  ('www'),('api'),('app'),('admin'),('support'),('help'),('blog'),('status'),
  ('mail'),('static'),('assets'),('cdn'),('dashboard'),('login'),('signup'),
  ('register'),('billing'),('docs'),('legal'),('security'),('auth'),
  ('platform'),('daftar'),('store'),('shop'),('null'),('undefined');
