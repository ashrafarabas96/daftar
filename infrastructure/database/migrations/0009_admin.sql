-- 0009 — Super Admin foundation (Wave 9): platform roles are a SEPARATE
-- namespace from merchant RBAC. One platform role per user (v1).
-- Platform roles NEVER touch merchant ledgers/financials/stock (§53).

CREATE TABLE platform_role_memberships (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_key   TEXT NOT NULL CHECK (role_key IN (
    'platform_owner', 'platform_admin', 'support_agent',
    'billing_admin', 'security_admin', 'read_only_analyst'
  )),
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE platform_role_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_role_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON platform_role_memberships
  USING (app_bypass()) WITH CHECK (app_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_role_memberships TO daftar_app;
