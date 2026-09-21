-- 0007 — Entitlement foundation (Wave 8): features, plans, plan versions,
-- plan entitlements, plan limits, business entitlement state, overrides,
-- feature flags. Foundation only — NO billing gateway, NO Stripe processing.
-- Plan versions are immutable: contract history is never modified.

CREATE TABLE features (
  key         TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plan_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key       TEXT NOT NULL REFERENCES plans(key),
  version        INT NOT NULL CHECK (version >= 1),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_key, version)
);
-- Immutability: no UPDATE/DELETE on plan_versions (enforced by grants + trigger).
CREATE OR REPLACE FUNCTION plan_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plan versions are immutable' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER plan_versions_immutable_trg
  BEFORE UPDATE OR DELETE ON plan_versions
  FOR EACH ROW EXECUTE FUNCTION plan_versions_immutable();

CREATE TABLE plan_entitlements (
  plan_version_id UUID NOT NULL REFERENCES plan_versions(id),
  feature_key     TEXT NOT NULL REFERENCES features(key),
  enabled         BOOLEAN NOT NULL,
  PRIMARY KEY (plan_version_id, feature_key)
);

CREATE TABLE plan_limits (
  plan_version_id UUID NOT NULL REFERENCES plan_versions(id),
  limit_key       TEXT NOT NULL,
  limit_value     BIGINT NOT NULL, -- -1 = unlimited
  PRIMARY KEY (plan_version_id, limit_key)
);

CREATE TABLE business_entitlements (
  business_id     UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  plan_version_id UUID NOT NULL REFERENCES plan_versions(id),
  state           TEXT NOT NULL CHECK (state IN ('trial','active','past_due','cancelled')),
  trial_ends_at   TIMESTAMPTZ,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Overrides: super-admin grants. Every override requires reason + actor + window.
CREATE TABLE entitlement_overrides (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  feature_key  TEXT REFERENCES features(key),
  limit_key    TEXT,
  enabled_value BOOLEAN,
  limit_value   BIGINT,
  reason       TEXT NOT NULL CHECK (length(reason) >= 3),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (feature_key IS NOT NULL OR limit_key IS NOT NULL),
  CHECK (feature_key IS NULL OR enabled_value IS NOT NULL),
  CHECK (limit_key IS NULL OR limit_value IS NOT NULL)
);
CREATE INDEX entitlement_overrides_business_idx ON entitlement_overrides (business_id);

-- Feature flags: technical enablement, SEPARATE from customer entitlement.
CREATE TABLE feature_flags (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  description TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seeds: feature registry (features are NOT implemented by this registry).
INSERT INTO features (key, description) VALUES
  ('MULTI_BRANCH','Multiple branches per business'),
  ('CUSTOM_ROLES','Custom business roles'),
  ('ADVANCED_REPORTS','Advanced reporting (future)'),
  ('ONLINE_STORE','Online storefront (future)'),
  ('WHATSAPP_AUTOMATION','WhatsApp automation (future)'),
  ('AI_ASSISTANT','AI assistant (future)'),
  ('APPOINTMENTS','Appointments module (future)'),
  ('RESTAURANT_PACK','Restaurant pack (future)'),
  ('SERIAL_TRACKING','Serial/IMEI tracking (future)'),
  ('LOT_EXPIRY','Lot/expiry tracking (future)'),
  ('API_ACCESS','Public API access (future)');

INSERT INTO plans (key, name) VALUES
  ('free','Free'), ('starter','Starter'), ('pro','Pro'), ('business','Business');

-- Version 1 of every plan.
INSERT INTO plan_versions (plan_key, version)
  SELECT key, 1 FROM plans;

INSERT INTO plan_limits (plan_version_id, limit_key, limit_value)
  SELECT pv.id, x.limit_key, x.limit_value
  FROM plan_versions pv
  JOIN (VALUES
    ('free','MAX_USERS',2),      ('free','MAX_BRANCHES',1),  ('free','MAX_PRODUCTS',100),
    ('starter','MAX_USERS',5),   ('starter','MAX_BRANCHES',3),('starter','MAX_PRODUCTS',1000),
    ('pro','MAX_USERS',25),      ('pro','MAX_BRANCHES',10),  ('pro','MAX_PRODUCTS',100000),
    ('business','MAX_USERS',100),('business','MAX_BRANCHES',50),('business','MAX_PRODUCTS',-1)
  ) AS x(plan_key, limit_key, limit_value) ON pv.plan_key = x.plan_key AND pv.version = 1;

INSERT INTO plan_entitlements (plan_version_id, feature_key, enabled)
  SELECT pv.id, f.key,
    CASE
      WHEN pv.plan_key = 'business' THEN true
      WHEN pv.plan_key = 'pro' AND f.key IN ('MULTI_BRANCH','CUSTOM_ROLES','ADVANCED_REPORTS') THEN true
      WHEN pv.plan_key = 'starter' AND f.key = 'MULTI_BRANCH' THEN true
      ELSE false
    END
  FROM plan_versions pv CROSS JOIN features f
  WHERE pv.version = 1;

-- RLS: business-scoped state tables get the standard two-policy layering.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_entitlements','entitlement_overrides'] LOOP
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

-- Platform catalog tables: read-only for the app role (no RLS needed — no tenant data).
GRANT SELECT ON features, plans, plan_versions, plan_entitlements, plan_limits, feature_flags TO daftar_app;
GRANT SELECT, INSERT, UPDATE ON business_entitlements TO daftar_app;
GRANT SELECT, INSERT ON entitlement_overrides TO daftar_app;
