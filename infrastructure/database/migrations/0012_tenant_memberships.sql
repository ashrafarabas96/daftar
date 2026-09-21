-- 0012 — Tenant membership foundation (§21–23). TENANT ≠ BUSINESS: a global
-- user may belong to MANY tenants and MANY businesses. tenant_memberships is
-- the tenant-level link (owner/member); memberships remains business-level.

CREATE TABLE tenant_memberships (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key   TEXT NOT NULL CHECK (role_key IN ('tenant_owner', 'tenant_member')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;
-- Tenant-scoped: members of the active tenant context can see its membership
-- rows; platform ops bypass. (No business_id — business_isolation doesn't apply.)
CREATE POLICY tenant_scope ON tenant_memberships
  USING (app_bypass() OR tenant_id::text = app_tenant())
  WITH CHECK (app_bypass() OR tenant_id::text = app_tenant());

GRANT SELECT, INSERT, UPDATE ON tenant_memberships TO daftar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_memberships TO daftar_platform;

-- Backfill: every business OWNER becomes a tenant_owner of that tenant.
INSERT INTO tenant_memberships (tenant_id, user_id, role_key)
SELECT DISTINCT b.tenant_id, mr.user_id, 'tenant_owner'
FROM membership_roles mr
JOIN business_roles r ON r.business_id = mr.business_id AND r.id = mr.role_id AND r.is_system AND r.key = 'owner'
JOIN businesses b ON b.id = mr.business_id
ON CONFLICT DO NOTHING;
