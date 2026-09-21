-- 0019 — Authority integrity: tenant-owner demotion/removal protection,
-- last-active-owner invariant, and DB-level business-owner grant guard.
--
-- Final Closure Mission §2–9:
--  * An existing tenant_owner row cannot be demoted, status-removed or
--    deleted by any non-trusted role (previously only PROMOTION was blocked).
--  * A tenant must never be left without an active tenant_owner — enforced
--    for EVERY role (including platform bypass) with an advisory lock so
--    concurrent demotion/removal cannot race past the check.
--  * membership_roles rejects raw-SQL grants of the system 'owner' role
--    unless executed through the trusted ownership boundary (app_bypass()
--    or schema superuser).

-- 1) Tenant owner: full lifecycle protection + last-owner invariant.
CREATE OR REPLACE FUNCTION tenant_memberships_protect_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  remaining INTEGER;
  lock_key BIGINT;
  trusted BOOLEAN := app_bypass() OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  -- Promotion/minting of tenant_owner: trusted boundary only (from 0016).
  IF NOT trusted THEN
    IF TG_OP = 'INSERT' AND NEW.role_key = 'tenant_owner' THEN
      RAISE EXCEPTION 'tenant_owner membership is platform-managed';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.role_key = 'tenant_owner' AND OLD.role_key <> 'tenant_owner' THEN
      RAISE EXCEPTION 'tenant_owner membership is platform-managed';
    END IF;
    -- Demotion/deactivation of an EXISTING tenant_owner: trusted boundary only.
    IF TG_OP = 'UPDATE' AND OLD.role_key = 'tenant_owner'
       AND (NEW.role_key <> 'tenant_owner' OR NEW.status <> 'active') THEN
      RAISE EXCEPTION 'tenant_owner membership is platform-managed: demotion/deactivation requires the ownership boundary';
    END IF;
    IF TG_OP = 'DELETE' AND OLD.role_key = 'tenant_owner' THEN
      RAISE EXCEPTION 'tenant_owner membership is platform-managed: deletion requires the ownership boundary';
    END IF;
  END IF;

  -- Last-active-owner invariant: applies to EVERY role, trusted or not.
  -- An ownership transfer must add the successor in the same transaction.
  IF (TG_OP = 'DELETE' AND OLD.role_key = 'tenant_owner' AND OLD.status = 'active')
     OR (TG_OP = 'UPDATE' AND OLD.role_key = 'tenant_owner' AND OLD.status = 'active'
         AND (NEW.role_key <> 'tenant_owner' OR NEW.status <> 'active')) THEN
    lock_key := hashtextextended(OLD.tenant_id::text, 9182);
    PERFORM pg_advisory_xact_lock(lock_key);
    SELECT count(*) INTO remaining FROM tenant_memberships tm
      WHERE tm.tenant_id = OLD.tenant_id AND tm.user_id <> OLD.user_id
        AND tm.role_key = 'tenant_owner' AND tm.status = 'active';
    IF remaining = 0 THEN
      RAISE EXCEPTION 'tenant cannot be left without an active tenant_owner';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- 2) Business owner grant guard on membership_roles.
CREATE OR REPLACE FUNCTION membership_roles_protect_owner_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  is_owner_role BOOLEAN;
BEGIN
  IF app_bypass() OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT r.is_system AND r.key = 'owner' INTO is_owner_role
    FROM business_roles r
   WHERE r.business_id = NEW.business_id
     AND r.id = NEW.role_id;
  IF COALESCE(is_owner_role, FALSE) THEN
    RAISE EXCEPTION 'system owner role grant is platform-managed';
  END IF;
  RETURN NEW;
END $$;

-- INSERT/UPDATE only: DELETE stays allowed so the membership-lifecycle purge
-- (removeMember: owner -> removed -> re-added cashier = cashier only) keeps
-- working under the merchant role. Removal can never GRANT authority.
CREATE TRIGGER membership_roles_protect_owner_grant
  BEFORE INSERT OR UPDATE ON membership_roles
  FOR EACH ROW EXECUTE FUNCTION membership_roles_protect_owner_grant();
