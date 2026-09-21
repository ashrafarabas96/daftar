-- 0027_plan_version_immutability_hardening.sql — Terminal Closure §19–21.
--
-- The 0022 lifecycle trigger listed individual columns when validating the
-- PUBLISHED → SUNSET transition, which (a) silently allowed mutating any
-- unlisted column (e.g. trial_days) during a sunset, and (b) would forget
-- every FUTURE column. Replace it with a future-safe rule:
--
--   DRAFT      → DRAFT | PUBLISHED        (content editable)
--   PUBLISHED  → SUNSET only, and the row must be IDENTICAL in every other
--                column (whole-row comparison, no column list)
--   everything else → rejected
--
-- Managed-PostgreSQL-safe: CREATE OR REPLACE FUNCTION needs only ownership.

CREATE OR REPLACE FUNCTION plan_versions_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  desired_state TEXT;
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
  -- Mask the state change, then compare the WHOLE row: any other mutation
  -- (trial_days, contract fields, future columns) rejects the sunset.
  IF OLD.state = 'PUBLISHED' AND NEW.state = 'SUNSET' THEN
    desired_state := NEW.state;
    NEW.state := OLD.state;
    IF NEW IS NOT DISTINCT FROM OLD THEN
      NEW.state := desired_state;
      RETURN NEW;
    END IF;
    NEW.state := desired_state;
  END IF;
  RAISE EXCEPTION 'published plan versions are immutable' USING ERRCODE = 'P0001';
END $$;

-- §69: platform admins manage trial_days on DRAFT versions (the lifecycle
-- trigger is the enforcement; the grant enables the column).
GRANT UPDATE (trial_days) ON plan_versions TO daftar_platform;
