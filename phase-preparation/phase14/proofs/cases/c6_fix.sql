-- owner: the fix — the guard asserts INTENT, scoped to the fields it is about,
-- and revoked_at is append-once and may only move EARLIER
DROP TRIGGER t_guard_broken ON p14s.api_keys;
CREATE OR REPLACE FUNCTION p14s.guard_intent() RETURNS TRIGGER LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NULL OR NEW.revoked_at > OLD.revoked_at) THEN
      RAISE EXCEPTION 'REVOCATION_MAY_ONLY_MOVE_EARLIER' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER t_guard_intent BEFORE UPDATE ON p14s.api_keys
  FOR EACH ROW EXECUTE FUNCTION p14s.guard_intent();
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='t_guard_broken' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: broken trigger still present'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='t_guard_intent' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: intent trigger absent'; END IF;
  RAISE NOTICE 'LANDED: guard scoped to revoked_at changes only';
END $$;
