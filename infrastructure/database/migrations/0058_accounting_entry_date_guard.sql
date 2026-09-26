-- 0058_accounting_entry_date_guard.sql
-- P3-S1, part 6 — TD-09 repaid: no journal entry is dated in the future, in
-- the business's own timezone, whoever inserts it (P3-AL-36, P3-AL-54 §H).
--
-- The three posting commands already refuse a future `entry_date`
-- (0045:757-760, 0046:629, 0047:579/652/909). TD-09 was that NOTHING beneath
-- them did: a raw INSERT by the schema owner, or any future writer that
-- forgot the check, could date an entry tomorrow. This is the database-level
-- rule under all of them. The command-level checks remain; this is defence in
-- depth, not a replacement.
--
-- Why a BEFORE INSERT trigger and not a CHECK (P3-AL-36): "not in the future"
-- is a statement about the moment of insertion, not a timeless row invariant
-- — a CHECK's truth would change under committed rows and could make a
-- revalidation or a dump reload reject data the database itself accepted —
-- and it needs `businesses.timezone`, which a CHECK cannot read.
--
-- ── Authority ────────────────────────────────────────────────────────────
--
-- An ACCOUNTING guard, so it belongs to accounting authority and never to the
-- inventory principal: SECURITY DEFINER, owned by daftar_accounting_internal,
-- `pg_temp` last, no EXECUTE grant. It must read the business's timezone
-- whatever principal inserts, and `accounting_seeder_read` (0040:213-214)
-- already admits exactly that principal on `businesses`.
--
-- ── Order ────────────────────────────────────────────────────────────────
--
-- `accounting_entry_date_guard` sorts before `accounting_period_guard`
-- (0049), so a future-dated entry is refused as future-dated rather than as
-- out-of-period.
--
-- "Today" is `(now() AT TIME ZONE <business timezone>)::date` — the same
-- expression the posting commands use (0045:757), so no caller sees a
-- different day or a new error identity.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file
--    (0040:247-263 / 0040:471).
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_entry_date_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_tz TEXT;
BEGIN
  SELECT b.timezone INTO v_tz FROM businesses b WHERE b.id = NEW.business_id;
  IF v_tz IS NULL THEN
    -- Fail closed: a date that cannot be judged is not admitted. The row's
    -- business is invisible to this principal only if it does not exist,
    -- which the tenant/business foreign key would refuse anyway.
    RAISE EXCEPTION 'accounting.entry_date_unverifiable: the business of this journal entry has no resolvable timezone' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.entry_date > (now() AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'accounting.entry_date_in_future: an entry may not be dated after today in the business timezone' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION accounting_entry_date_guard() IS
  'P3-AL-36 (TD-09). BEFORE INSERT on journal_entries: refuses an entry_date after today in the business''s own timezone (accounting.entry_date_in_future, the code the posting commands already raise), whoever inserts. SECURITY DEFINER owned by daftar_accounting_internal so it can read businesses.timezone for every writer; no EXECUTE grant. The message carries no financial values.';

CREATE TRIGGER accounting_entry_date_guard
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION accounting_entry_date_guard();

REVOKE ALL ON FUNCTION accounting_entry_date_guard() FROM PUBLIC;
ALTER FUNCTION accounting_entry_date_guard() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Refuse to commit unless the end state is exactly right.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role TEXT;
BEGIN
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.authority_leak: daftar_accounting_internal still holds CREATE on schema public';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE t.tgname = 'accounting_entry_date_guard' AND c.relname = 'journal_entries'
      AND p.proname = 'accounting_entry_date_guard' AND t.tgenabled = 'O'
      AND t.tgtype = (1 + 2 + 4)            -- ROW, BEFORE, INSERT
      AND r.rolname = 'daftar_accounting_internal' AND p.prosecdef
      AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'accounting.authority_leak: accounting_entry_date_guard is missing, reshaped, or not an accounting-owned SECURITY DEFINER guard';
  END IF;
  FOR v_role IN SELECT unnest(ARRAY['daftar_app','daftar_platform','daftar_worker','daftar_identity','daftar_resolver','daftar_provisioner','daftar_reconciler','daftar_inventory_internal','public']) LOOP
    IF has_function_privilege(v_role, 'accounting_entry_date_guard()', 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.authority_leak: % may execute accounting_entry_date_guard', v_role;
    END IF;
  END LOOP;
END $$;
