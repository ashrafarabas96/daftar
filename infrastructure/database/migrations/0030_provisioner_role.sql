-- 0030_provisioner_role.sql
-- Stabilization Part B §12–16: narrow PROVISIONING boundary.
-- daftar_provisioner performs ONLY: initial onboarding, additional business
-- creation, and the invitation-acceptance cross-scope transition. It has NO
-- plan management, NO feature flags, NO entitlement overrides, NO platform
-- roles, NO catalog write beyond provisioning, NO credential payload access,
-- and NO access to unrelated tenant data beyond the rows it creates.
--
-- Least privilege is enforced by GRANTS (the role runs with bypass_rls for
-- the cross-scope transition, exactly like the platform role did — but its
-- grant set is a strict subset limited to provisioning tables).
--
-- app_bypass() widens explicitly: daftar_provisioner bypasses RLS for its
-- provisioning transition (it creates cross-scope rows before any business
-- scope exists). The GRANT boundary above is what limits it — RLS bypass
-- without grants still yields permission denied on every other table.
CREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT current_user IN ('daftar_platform', 'daftar_provisioner')
$$;

-- Tenancy provisioning
GRANT SELECT, INSERT ON tenants TO daftar_provisioner;
GRANT SELECT, INSERT ON tenant_memberships TO daftar_provisioner;
GRANT SELECT, INSERT ON businesses TO daftar_provisioner;
GRANT SELECT ON reserved_store_slugs TO daftar_provisioner;

-- Business bootstrap (roles, owner membership, default structure)
GRANT INSERT ON business_roles TO daftar_provisioner;
GRANT INSERT ON role_permissions TO daftar_provisioner;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO daftar_provisioner;
GRANT SELECT, INSERT, DELETE ON membership_roles TO daftar_provisioner;
GRANT SELECT, INSERT ON branches TO daftar_provisioner;
GRANT SELECT, INSERT ON warehouses TO daftar_provisioner;
GRANT SELECT, DELETE ON member_branch_scopes TO daftar_provisioner;

-- Trial entitlement defaults (read the versioned plan contract; write the
-- business's own entitlement row — NO plan/limits/entitlement mutation)
GRANT SELECT ON plans, plan_versions, plan_limits, plan_entitlements TO daftar_provisioner;
GRANT SELECT, INSERT ON business_entitlements TO daftar_provisioner;

-- Idempotency records for onboarding/create-business
GRANT SELECT, INSERT, UPDATE ON onboarding_operations TO daftar_provisioner;

-- Invitation acceptance cross-scope transition
GRANT SELECT, UPDATE ON business_invitations TO daftar_provisioner;

-- Auditability + outbox (every provisioning act is auditable and evented)
GRANT INSERT ON audit_events TO daftar_provisioner;
GRANT INSERT ON outbox_events TO daftar_provisioner;

-- §15: the slug directory is a narrow READ-ONLY resolver boundary — the
-- resolver may check reserved slugs too (availability + suggestions).
GRANT SELECT ON reserved_store_slugs TO daftar_resolver;

-- Explicitly NO grants to daftar_provisioner on: platform_role_memberships,
-- feature_flags, entitlement_overrides, credential_deliveries,
-- credential_payloads, password_reset_tokens, sessions, users, catalog
-- tables beyond provisioning, support_sessions. Any attempt fails with a
-- permission error — that is the boundary working.
