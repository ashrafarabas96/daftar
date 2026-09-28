-- 0073_default_warehouse_locale_name.sql
-- Phase 3 corrective hardening — TD-20, default warehouse localization (the
-- Tech Lead's corrective directive §10). Not a Phase 4 migration.
--
-- ── The defect ──────────────────────────────────────────────────────────
--
-- `provision_create_business` (0038) names the default warehouse it creates
-- with every business the English literal 'Main warehouse', whatever the
-- business's locale — and a business onboarded without a locale is 'ar'. The
-- API's createBranch() names the default warehouse of each further branch
-- `<branch> — default warehouse`, English again (that half is fixed in the
-- API: apps/api/src/modules/tenancy/default-warehouse-name.ts).
--
-- ── Why the onboarding routine is not re-created ────────────────────────
--
-- Re-creating provision_create_business with another body makes it a Phase 3
-- routine (the definition differs from the 0052 prefix), and the P3-S8
-- definer law then requires of it an INTERNAL NOLOGIN owner and the pinned
-- path `pg_catalog, public, pg_temp` (T-05 clauses 1, 2). It is owned by the
-- login role daftar_platform with the path `public, pg_catalog`; handing it
-- to an internal owner would need that owner to be granted every table the
-- onboarding writes, and admitted by each table's row security — a widening
-- far beyond TD-20. The routine therefore stays byte-for-byte as 0038 left
-- it, and the name is given AT ONBOARDING, by the row it inserts:
--
-- ── What this file does ─────────────────────────────────────────────────
--
--   1. warehouses_default_name_locale: BEFORE INSERT ON warehouses FOR EACH
--      ROW WHEN (NEW.is_default AND NEW.name = 'Main warehouse'), on
--      warehouse_default_name_localize(), an INVOKER function with the pinned
--      path, executable by nobody. It renames the row into the business's
--      locale
--        ar  'المستودع الرئيسي'
--        en  'Main warehouse'      (unchanged)
--        tr  'Ana depo'
--      ONLY when the row is the onboarding default: its branch is the
--      business's default branch and both the business and that branch were
--      created in THIS transaction (`created_at = now()`: provision_create_
--      business is the one writer that creates a business, its default branch
--      and its default warehouse together). Any other insert keeps its name:
--      createWarehouse() inserts non-default rows only, and createBranch()
--      names its default itself. As an INVOKER it reads with the privileges
--      and row security of the writer (daftar_platform inside the definer).
--
--   2. Existing default warehouses whose name the SYSTEM wrote, and nobody
--      since, are renamed into the business's current default locale. A row
--      qualifies only on proof, never on a name match alone:
--
--      (a) the onboarding default: `is_default`, on the business's default
--          branch, created in the SAME transaction as the business
--          (`warehouses.created_at = branches.created_at =
--          businesses.created_at`), and still named exactly 'Main warehouse';
--      (b) a further branch's default: `is_default`, NOT on the default
--          branch, created in the same transaction as its branch
--          (createBranch() is the only writer of such a row), and still named
--          exactly `<branch name> — default warehouse`.
--
--      "Nobody since" holds because no product path has ever renamed a
--      warehouse or a branch: there is no rename endpoint, no routine and no
--      migration that UPDATEs warehouses.name or branches.name, and
--      createWarehouse() only ever inserts NON-default rows. A merchant's own
--      warehouse named 'Main warehouse' (is_default false) never qualifies.
--      Businesses whose default locale is 'en' keep their names (they are
--      already the locale's name).
--
--      A branch default is renamed only when `<branch> — <suffix>` fits the
--      column WHOLE (char_length ≤ 120, as this server counts it): the
--      migration never cuts a merchant's branch name. DAFTAR does not require
--      a UTF8 server encoding (0049), and on a byte-counting one `left()`
--      could split a character; a name that does not fit keeps its English
--      text (a branch name of 99 or 100 characters on a UTF8 server).
--
--      The three tables are FORCE row security and the deployment principal
--      is their owner but not exempt (the 0056 §3 finding): a plain UPDATE
--      would see no row and rename nothing in production. The owner lifts
--      FORCE for the length of the backfill and restores it before anything
--      else happens; the statements are transactional under ACCESS EXCLUSIVE
--      locks, so no session can observe the window. A superuser build runs
--      the same statements unaffected. The rename is checked complete while
--      FORCE is still lifted.
--
--   3. 0073-E: the end state — the trigger and its function in exactly that
--      shape, FORCE restored.
--
-- What is NOT changed: the default BRANCH is still created as 'Main' (TD-20
-- names the warehouse; reported as open). No audit event is written for the
-- rename (it is the system correcting its own text, not a merchant act).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The onboarding default, named in the business locale as it is inserted
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION warehouse_default_name_localize() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_locale TEXT;
BEGIN
  SELECT b.default_locale INTO v_locale
    FROM public.businesses b
    JOIN public.branches br ON br.business_id = b.id AND br.id = NEW.branch_id
   WHERE b.id = NEW.business_id
     AND b.created_at = now()
     AND br.is_default AND br.created_at = now();
  IF v_locale = 'ar' THEN
    NEW.name := 'المستودع الرئيسي';
  ELSIF v_locale = 'tr' THEN
    NEW.name := 'Ana depo';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION warehouse_default_name_localize() IS
  'Phase 3 corrective (TD-20, 0073). BEFORE INSERT on warehouses, for a default row named ''Main warehouse'': when its branch is the business''s default branch and both were created in this transaction (the onboarding of provision_create_business), the name becomes the business locale''s (ar المستودع الرئيسي, tr Ana depo; en unchanged). INVOKER, pinned path, executable by nobody.';

REVOKE ALL ON FUNCTION warehouse_default_name_localize() FROM PUBLIC;

CREATE TRIGGER warehouses_default_name_locale
  BEFORE INSERT ON warehouses
  FOR EACH ROW WHEN (NEW.is_default AND NEW.name = 'Main warehouse')
  EXECUTE FUNCTION warehouse_default_name_localize();

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The provably system-written default warehouse names, localized
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE businesses NO FORCE ROW LEVEL SECURITY;
ALTER TABLE branches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE warehouses NO FORCE ROW LEVEL SECURITY;

-- (a) the onboarding default.
UPDATE warehouses w
   SET name = CASE biz.default_locale WHEN 'ar' THEN 'المستودع الرئيسي' ELSE 'Ana depo' END
  FROM branches br, businesses biz
 WHERE br.business_id = w.business_id AND br.id = w.branch_id
   AND biz.id = w.business_id
   AND biz.default_locale IN ('ar', 'tr')
   AND w.is_default AND br.is_default
   AND w.created_at = biz.created_at AND br.created_at = biz.created_at
   AND w.name = 'Main warehouse';

-- (b) a further branch's default.
UPDATE warehouses w
   SET name = br.name || ' — ' || s.suffix
  FROM branches br, businesses biz,
       LATERAL (SELECT CASE biz.default_locale WHEN 'ar' THEN 'المستودع الافتراضي' ELSE 'varsayılan depo' END AS suffix) s
 WHERE br.business_id = w.business_id AND br.id = w.branch_id
   AND biz.id = w.business_id
   AND biz.default_locale IN ('ar', 'tr')
   AND w.is_default AND NOT br.is_default
   AND w.created_at = br.created_at
   AND w.name = br.name || ' — default warehouse'
   AND char_length(br.name || ' — ' || s.suffix) <= 120;

-- Checked while FORCE is still lifted: under FORCE a non-superuser applier
-- would see no row and the count would pass vacuously.
DO $$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n
    FROM warehouses w
    JOIN branches br ON br.business_id = w.business_id AND br.id = w.branch_id
    JOIN businesses biz ON biz.id = w.business_id
   WHERE biz.default_locale IN ('ar', 'tr') AND w.is_default
     AND ((br.is_default AND w.created_at = biz.created_at AND br.created_at = biz.created_at AND w.name = 'Main warehouse')
       OR (NOT br.is_default AND w.created_at = br.created_at AND w.name = br.name || ' — default warehouse'
           AND char_length(br.name || ' — ' || CASE biz.default_locale WHEN 'ar' THEN 'المستودع الافتراضي' ELSE 'varsayılan depo' END) <= 120));
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'tenancy.migration_invariant: % system-written default warehouse name(s) left in English', v_n;
  END IF;
END $$;

ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 0073-E — the end state
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn regprocedure := 'warehouse_default_name_localize()'::regprocedure;
  v_n  bigint;
BEGIN
  PERFORM 1 FROM pg_proc p
   WHERE p.oid = v_fn AND NOT p.prosecdef
     AND p.proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
     AND p.proacl IS NOT NULL
     AND NOT has_function_privilege('public', p.oid, 'EXECUTE');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenancy.migration_invariant: warehouse_default_name_localize is not an INVOKER with the pinned path that PUBLIC cannot execute';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p, LATERAL aclexplode(p.proacl) a
   WHERE p.oid = v_fn AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'tenancy.migration_invariant: warehouse_default_name_localize has an EXECUTE grantee';
  END IF;

  PERFORM 1 FROM pg_trigger t
   WHERE t.tgrelid = 'warehouses'::regclass AND t.tgname = 'warehouses_default_name_locale'
     AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = v_fn
     AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER warehouses_default_name_locale BEFORE INSERT ON public.warehouses FOR EACH ROW WHEN ((new.is_default AND (new.name = ''Main warehouse''::text))) EXECUTE FUNCTION warehouse_default_name_localize()';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenancy.migration_invariant: warehouses_default_name_locale is not the BEFORE INSERT trigger of 0073';
  END IF;

  SELECT count(*) INTO v_n FROM pg_class
   WHERE oid IN ('businesses'::regclass, 'branches'::regclass, 'warehouses'::regclass)
     AND relrowsecurity AND relforcerowsecurity;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'tenancy.migration_invariant: row security is not forced again on businesses, branches and warehouses';
  END IF;
END $$;
