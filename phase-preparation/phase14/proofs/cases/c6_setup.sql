-- owner: the V2 FINDING 4 defect — a guard derived from now() on EVERY update
CREATE OR REPLACE FUNCTION p14s.guard_now_broken() RETURNS TRIGGER LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND NEW.revoked_at <= now() THEN
    RAISE EXCEPTION 'KEY_ALREADY_REVOKED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER t_guard_broken BEFORE UPDATE ON p14s.api_keys
  FOR EACH ROW EXECUTE FUNCTION p14s.guard_now_broken();
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='t_guard_broken' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: trigger absent'; END IF;
  RAISE NOTICE 'LANDED: the now()-derived trigger fires on every UPDATE';
END $$;
