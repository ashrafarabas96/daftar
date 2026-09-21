-- 0022 — Plan version lifecycle + override DB integrity (Final Closure §34–44).

-- 1) Plan version lifecycle (§35–37): DRAFT editable → PUBLISHED immutable → SUNSET.
DROP TRIGGER plan_versions_immutable_trg ON plan_versions;
DROP FUNCTION plan_versions_immutable();

ALTER TABLE plan_versions ADD COLUMN state TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (state IN ('DRAFT', 'PUBLISHED', 'SUNSET'));
-- All existing versions are live truth.
UPDATE plan_versions SET state = 'PUBLISHED';

CREATE OR REPLACE FUNCTION plan_versions_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'plan versions are never deleted' USING ERRCODE = 'P0001';
  END IF;
  -- DRAFT rows are editable (content + publish transition).
  IF OLD.state = 'DRAFT' THEN
    IF NEW.state NOT IN ('DRAFT', 'PUBLISHED') THEN
      RAISE EXCEPTION 'invalid plan version transition % → %', OLD.state, NEW.state USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- PUBLISHED → SUNSET is the ONLY allowed change; every other column frozen.
  IF OLD.state = 'PUBLISHED' AND NEW.state = 'SUNSET'
     AND NEW.plan_key = OLD.plan_key AND NEW.version = OLD.version
     AND NEW.effective_from = OLD.effective_from THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published plan versions are immutable' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER plan_versions_lifecycle_trg
  BEFORE UPDATE OR DELETE ON plan_versions
  FOR EACH ROW EXECUTE FUNCTION plan_versions_lifecycle();

-- 2) Published children are immutable (§37/§39): plan_entitlements + plan_limits
--    rows may change only while the parent version is DRAFT.
CREATE OR REPLACE FUNCTION plan_children_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pv_state TEXT;
BEGIN
  SELECT state INTO pv_state FROM plan_versions
   WHERE id = COALESCE(NEW.plan_version_id, OLD.plan_version_id);
  IF pv_state IS NULL OR pv_state <> 'DRAFT' THEN
    RAISE EXCEPTION 'plan children are immutable once the version is published' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER plan_entitlements_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON plan_entitlements
  FOR EACH ROW EXECUTE FUNCTION plan_children_draft_only();
CREATE TRIGGER plan_limits_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON plan_limits
  FOR EACH ROW EXECUTE FUNCTION plan_children_draft_only();

-- 3) business_entitlements may only reference PUBLISHED versions.
CREATE OR REPLACE FUNCTION business_entitlements_published_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pv_state TEXT;
BEGIN
  SELECT state INTO pv_state FROM plan_versions WHERE id = NEW.plan_version_id;
  IF pv_state IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION 'business entitlements reference PUBLISHED plan versions only' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER business_entitlements_published_only
  BEFORE INSERT OR UPDATE OF plan_version_id ON business_entitlements
  FOR EACH ROW EXECUTE FUNCTION business_entitlements_published_only();

-- 4) Override integrity (§40–43): STRICT XOR, sane window, no overlapping
--    ACTIVE overrides for the same (business, key), auditable revoke.
ALTER TABLE entitlement_overrides DROP CONSTRAINT IF EXISTS entitlement_overrides_check;
ALTER TABLE entitlement_overrides DROP CONSTRAINT IF EXISTS entitlement_overrides_check1;
ALTER TABLE entitlement_overrides DROP CONSTRAINT IF EXISTS entitlement_overrides_check2;
ALTER TABLE entitlement_overrides ADD CONSTRAINT entitlement_overrides_strict_xor
    CHECK ((feature_key IS NOT NULL)::int + (limit_key IS NOT NULL)::int = 1);
ALTER TABLE entitlement_overrides ADD CONSTRAINT entitlement_overrides_window
    CHECK (ends_at IS NULL OR ends_at > starts_at);
ALTER TABLE entitlement_overrides ADD COLUMN revoked_at TIMESTAMPTZ;
ALTER TABLE entitlement_overrides ADD COLUMN revoked_by UUID REFERENCES users(id);

CREATE OR REPLACE FUNCTION entitlement_overrides_no_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  -- Serialize per (business, key) so concurrent grants cannot race past.
  PERFORM pg_advisory_xact_lock(hashtextextended(
      NEW.business_id::text || ':' || COALESCE(NEW.feature_key, NEW.limit_key), 4401));
  IF EXISTS (
    SELECT 1 FROM entitlement_overrides o
    WHERE o.business_id = NEW.business_id
      AND o.id IS DISTINCT FROM NEW.id
      AND o.revoked_at IS NULL
      AND ((NEW.feature_key IS NOT NULL AND o.feature_key = NEW.feature_key)
        OR (NEW.limit_key IS NOT NULL AND o.limit_key = NEW.limit_key))
      AND o.starts_at < COALESCE(NEW.ends_at, TIMESTAMPTZ 'infinity')
      AND NEW.starts_at < COALESCE(o.ends_at, TIMESTAMPTZ 'infinity')
  ) THEN
    RAISE EXCEPTION 'overlapping active override for the same key' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER entitlement_overrides_no_overlap_trg
  BEFORE INSERT OR UPDATE ON entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION entitlement_overrides_no_overlap();

-- Least-privilege column grants for the platform admin boundary:
-- state transitions only on plan_versions; revoke columns only on overrides.
GRANT UPDATE (state) ON plan_versions TO daftar_platform;
GRANT UPDATE (revoked_at, revoked_by) ON entitlement_overrides TO daftar_platform;
