-- 0023 — Country registry, business timezone, locale separation,
-- default warehouse per branch (Final Closure §63–68).

-- 1) Country registry (§65–66): the ONLY valid country codes live here.
CREATE TABLE country_registry (
    code                 TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
    name                 JSONB NOT NULL,
    default_currency     TEXT NOT NULL,
    recommended_locale   TEXT NOT NULL CHECK (recommended_locale IN ('ar','en','tr')),
    recommended_timezone TEXT NOT NULL,
    active               BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO country_registry (code, name, default_currency, recommended_locale, recommended_timezone) VALUES
  ('PS', '{"ar":"فلسطين","en":"Palestine","tr":"Filistin"}',  'ILS', 'ar', 'Asia/Hebron'),
  ('JO', '{"ar":"الأردن","en":"Jordan","tr":"Ürdün"}',        'JOD', 'ar', 'Asia/Amman'),
  ('LB', '{"ar":"لبنان","en":"Lebanon","tr":"Lübnan"}',       'LBP', 'ar', 'Asia/Beirut'),
  ('SY', '{"ar":"سوريا","en":"Syria","tr":"Suriye"}',         'SYP', 'ar', 'Asia/Damascus'),
  ('TR', '{"ar":"تركيا","en":"Türkiye","tr":"Türkiye"}',      'TRY', 'tr', 'Europe/Istanbul');

-- Registry is platform-managed; merchant roles read only.
GRANT SELECT ON country_registry TO daftar_app;
GRANT SELECT ON country_registry TO daftar_resolver;

-- No arbitrary country codes (§66): businesses reference the registry.
ALTER TABLE businesses
    ADD CONSTRAINT businesses_country_fk FOREIGN KEY (country_code) REFERENCES country_registry (code);

-- 2) Business timezone (§63): IANA name, validated at the DB boundary.
ALTER TABLE businesses ADD COLUMN timezone TEXT;
UPDATE businesses b SET timezone = cr.recommended_timezone
  FROM country_registry cr WHERE cr.code = b.country_code;
ALTER TABLE businesses ALTER COLUMN timezone SET NOT NULL;

CREATE OR REPLACE FUNCTION is_valid_iana_timezone(t TEXT) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = t) $$;

CREATE OR REPLACE FUNCTION businesses_timezone_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT is_valid_iana_timezone(NEW.timezone) THEN
    RAISE EXCEPTION 'invalid IANA timezone: %', NEW.timezone USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_timezone_check
  BEFORE INSERT OR UPDATE OF timezone ON businesses
  FOR EACH ROW EXECUTE FUNCTION businesses_timezone_check();

-- 3) Locale separation (§64): user UI locale = users.preferred_locale (exists);
--    business operational locale = businesses.default_locale (exists);
--    storefront primary locale = NEW businesses.storefront_locale.
ALTER TABLE businesses ADD COLUMN storefront_locale TEXT NOT NULL DEFAULT 'ar'
    CHECK (storefront_locale IN ('ar','en','tr'));

-- 4) Default warehouse PER BRANCH (§68): the one-default uniqueness is scoped
--    to (business, branch), not the whole business.
DROP INDEX warehouses_one_default;
CREATE UNIQUE INDEX warehouses_one_default_per_branch
    ON warehouses (business_id, branch_id) WHERE is_default;
