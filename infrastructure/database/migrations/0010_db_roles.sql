-- 0010 — SECURITY GATE ZERO: DB privilege separation (Final Directive §7–12).
-- Roles: daftar_migrator (schema owner runs migrations), daftar_app (normal
-- business runtime — NO RLS bypass), daftar_platform (identity/platform/admin
-- ops — bypass allowed), daftar_worker (outbox worker — own access, no bypass
-- boolean).
-- The normal app role can NEVER bypass RLS, even if it sets the flag.

CREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
     AND current_user <> 'daftar_app'
$$;

-- Identity & platform tables: removed from the normal app role.
REVOKE ALL ON users, sessions, password_reset_tokens, platform_role_memberships FROM daftar_app;
REVOKE INSERT ON tenants FROM daftar_app;

-- Platform role: identity + onboarding + admin operations (bypass-gated).
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, password_reset_tokens, platform_role_memberships TO daftar_platform;
GRANT SELECT, INSERT, UPDATE ON tenants TO daftar_platform;
GRANT SELECT, INSERT, UPDATE ON businesses, business_roles, role_permissions, memberships,
  business_invitations, branches, warehouses, categories, products, product_variants,
  media, product_media, business_entitlements TO daftar_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON membership_roles TO daftar_platform;
GRANT SELECT, INSERT, UPDATE ON member_branch_scopes TO daftar_platform;
GRANT SELECT, INSERT ON entitlement_overrides TO daftar_platform;
GRANT SELECT, INSERT ON audit_events TO daftar_platform;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO daftar_platform;
GRANT SELECT ON currencies, platform_settings, reserved_store_slugs, features, plans,
  plan_versions, plan_entitlements, plan_limits, feature_flags TO daftar_platform;
-- Platform plan/flag management (Super Admin writes).
GRANT INSERT ON plans, plan_versions TO daftar_platform;
GRANT INSERT, UPDATE ON plan_entitlements, plan_limits TO daftar_platform;
GRANT INSERT, UPDATE ON feature_flags TO daftar_platform;

-- Worker role: outbox consumption WITHOUT the bypass boolean (§79).
CREATE POLICY outbox_worker ON outbox_events
  USING (current_user = 'daftar_worker')
  WITH CHECK (current_user = 'daftar_worker');
GRANT SELECT, UPDATE ON outbox_events TO daftar_worker;
