-- 0008 — Multi-user & production RBAC (Waves 5–6):
-- membership lifecycle states, multi-role memberships (effective permissions
-- = union of grants), branch scopes (design-ready), business invitations.
-- Removed memberships are NEVER deleted — history is preserved (status='removed').

-- 1) Membership lifecycle states: invited/active/suspended/removed.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_status_check;
UPDATE memberships SET status = 'removed' WHERE status = 'revoked';
ALTER TABLE memberships ADD CONSTRAINT memberships_status_check
  CHECK (status IN ('invited','active','suspended','removed'));
ALTER TABLE memberships ADD COLUMN invited_by UUID REFERENCES users(id);
ALTER TABLE memberships ADD COLUMN joined_at TIMESTAMPTZ;
ALTER TABLE memberships ADD COLUMN disabled_at TIMESTAMPTZ;

-- 2) Branch scope mode (design-ready: ALL_BUSINESS now, ASSIGNED_BRANCHES seam).
ALTER TABLE memberships ADD COLUMN branch_scope_mode TEXT NOT NULL DEFAULT 'all'
  CHECK (branch_scope_mode IN ('all','assigned'));
CREATE TABLE member_branch_scopes (
  business_id UUID NOT NULL,
  user_id     UUID NOT NULL,
  branch_id   UUID NOT NULL,
  PRIMARY KEY (business_id, user_id, branch_id),
  FOREIGN KEY (business_id, user_id) REFERENCES memberships (business_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id) ON DELETE CASCADE
);

-- 3) Multi-role memberships: effective permissions = union across roles.
CREATE TABLE membership_roles (
  business_id UUID NOT NULL,
  user_id     UUID NOT NULL,
  role_id     UUID NOT NULL,
  assigned_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id, role_id),
  FOREIGN KEY (business_id, user_id) REFERENCES memberships (business_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, role_id) REFERENCES business_roles (business_id, id)
);
INSERT INTO membership_roles (business_id, user_id, role_id)
  SELECT business_id, user_id, role_id FROM memberships WHERE role_id IS NOT NULL;
ALTER TABLE memberships DROP COLUMN role_id;

-- 4) Invitations: hashed token, expiry, lifecycle, duplicate-safe.
CREATE TABLE business_invitations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email        CITEXT NOT NULL,
  role_id      UUID NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','cancelled','expired')),
  invited_by   UUID NOT NULL REFERENCES users(id),
  accepted_by  UUID REFERENCES users(id),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, role_id) REFERENCES business_roles (business_id, id)
);
-- One pending invitation per (business, email).
CREATE UNIQUE INDEX business_invitations_pending_uq
  ON business_invitations (business_id, email) WHERE status = 'pending';

-- 5) RLS for the new business-scoped tables (standard two-policy layering).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['membership_roles','member_branch_scopes','business_invitations'] LOOP
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

GRANT SELECT, INSERT, UPDATE, DELETE ON membership_roles TO daftar_app;
GRANT SELECT, INSERT, UPDATE ON member_branch_scopes, business_invitations TO daftar_app;
