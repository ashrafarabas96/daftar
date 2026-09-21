-- 0006 — Row-Level Security: FORCE RLS + transaction-local context (§37–38).
-- Context is set per-transaction via set_config(..., true) (SET LOCAL semantics).
-- No global SET on pooled connections — stale context is impossible by construction.

CREATE OR REPLACE FUNCTION app_tenant() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.tenant_id', true)
$$;
CREATE OR REPLACE FUNCTION app_business() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.business_id', true)
$$;
CREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
$$;

-- Tenant-scoped tables: businesses carry tenant_id directly.
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON businesses
  USING (app_bypass() OR tenant_id::text = app_tenant())
  WITH CHECK (app_bypass() OR tenant_id::text = app_tenant());

-- Business-scoped tables: defense in depth = PERMISSIVE tenant-membership
-- policy (business must belong to the active tenant context) + RESTRICTIVE
-- business-scoping policy (row must match the active business context).
-- Default-deny: without app.business_id set, the app role sees ZERO rows.
-- (RESTRICTIVE policies only narrow what permissive policies allow — a
-- permissive grant must exist for DML to be possible at all.)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'business_roles','role_permissions','memberships','branches','warehouses',
    'categories','products','product_variants','media','product_media'
  ] LOOP
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

-- audit/outbox: business-scoped when business_id present; bypass for platform ops.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_scope ON audit_events
  USING (app_bypass() OR business_id::text = app_business() OR (business_id IS NULL AND tenant_id::text = app_tenant()))
  WITH CHECK (app_bypass() OR business_id::text = app_business() OR (business_id IS NULL AND tenant_id::text = app_tenant()));

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_scope ON outbox_events
  USING (app_bypass() OR business_id::text = app_business())
  WITH CHECK (app_bypass() OR business_id::text = app_business());

-- Identity tables: no direct app access (services use bypass transactions).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_platform_only ON users USING (app_bypass()) WITH CHECK (app_bypass());
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_platform_only ON sessions USING (app_bypass()) WITH CHECK (app_bypass());
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY prt_platform_only ON password_reset_tokens USING (app_bypass()) WITH CHECK (app_bypass());

-- Grants to the application role (created by bootstrap.sql). No UPDATE/DELETE on audit.
GRANT SELECT ON currencies, platform_settings, reserved_store_slugs TO daftar_app;
GRANT INSERT ON tenants TO daftar_app;
GRANT SELECT, INSERT, UPDATE ON businesses, business_roles, role_permissions, memberships,
  branches, warehouses, categories, products, product_variants, media, product_media TO daftar_app;
GRANT INSERT ON audit_events TO daftar_app;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO daftar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, password_reset_tokens TO daftar_app;

-- System role protection (§26): non-bypass transactions cannot create/modify/delete
-- system roles or their identity. Owner authority is system-managed and immutable.
CREATE OR REPLACE FUNCTION business_roles_protect_system() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_bypass() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.is_system THEN
    RAISE EXCEPTION 'system roles are system-managed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.is_system OR NEW.is_system
      OR (OLD.is_system IS DISTINCT FROM NEW.is_system)
      OR (OLD.is_system AND NEW.key IS DISTINCT FROM OLD.key)) THEN
    RAISE EXCEPTION 'system roles are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.is_system THEN
    RAISE EXCEPTION 'system roles cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_roles_system_guard
  BEFORE INSERT OR UPDATE OR DELETE ON business_roles
  FOR EACH ROW EXECUTE FUNCTION business_roles_protect_system();
