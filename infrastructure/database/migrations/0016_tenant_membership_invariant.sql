-- 0016 — TENANT MEMBERSHIP INVARIANT (Final Closure Mission WAVE 3).
-- Every business membership MUST belong to a user who is a member of the
-- tenant owning that business. Enforced at the DB level with composite
-- integrity — not by service convention:
--   memberships.tenant_id → (tenant_id, business_id) ∈ businesses
--   memberships.(tenant_id, user_id) ∈ tenant_memberships
-- Additionally, the merchant app role can NEVER grant tenant_owner via raw
-- SQL — tenant ownership mutation is a platform-managed domain boundary.

ALTER TABLE businesses ADD CONSTRAINT businesses_tenant_id_uq UNIQUE (tenant_id, id);

ALTER TABLE memberships ADD COLUMN tenant_id UUID;
UPDATE memberships m SET tenant_id = b.tenant_id FROM businesses b WHERE b.id = m.business_id;
ALTER TABLE memberships ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_tenant_business_fk
  FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_tenant_member_fk
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id);

-- tenant_owner authority is platform-managed: the merchant runtime (and any
-- non-bypass role) cannot mint or promote a tenant_owner via raw SQL.
CREATE OR REPLACE FUNCTION tenant_memberships_protect_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Platform bypass (provisioning) or the schema owner/migrator (superuser)
  -- may manage tenant_owner rows. Every non-superuser runtime role is blocked
  -- from minting/promoting tenant_owner.
  IF app_bypass() OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.role_key = 'tenant_owner' THEN
    RAISE EXCEPTION 'tenant_owner membership is platform-managed';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role_key = 'tenant_owner' AND OLD.role_key <> 'tenant_owner' THEN
    RAISE EXCEPTION 'tenant_owner membership is platform-managed';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenant_memberships_protect_owner
  BEFORE INSERT OR UPDATE OR DELETE ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION tenant_memberships_protect_owner();
