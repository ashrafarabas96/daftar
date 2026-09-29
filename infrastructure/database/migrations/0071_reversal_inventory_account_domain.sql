-- 0071_reversal_inventory_account_domain.sql
-- Phase 3 corrective hardening — S8 I-1 (the Tech Lead's corrective
-- directive §4, BLOCKER B). Not a Phase 4 migration.
--
-- ── The defect ──────────────────────────────────────────────────────────
--
-- R-B1a (0069 R-91) refuses, after a business's first stock movement, a
-- manual adjustment or an opening balance that carries a line on the
-- Inventory system account. It admitted a `reversal` on purpose. So:
--
--   1. before the first movement, two offsetting manual Inventory lines are
--      lawful (GL Inventory nets to zero, R-INV-01 ok);
--   2. stock movements begin;
--   3. the merchant reverses one of the two entries — accepted;
--   4. GL Inventory moves with no stock movement: R-INV-01 is red.
--
-- A permitted merchant command knowingly turned a reconciled business red.
--
-- ── The policy (R-B1b): a reversal may not turn a reconciled business red ─
--
--   After a business's first stock movement, a generic reversal (the Phase 2
--   `accounting_post_reversal` of a `manual_adjustment` or `opening_balance`
--   entry) that changes the Inventory system account is refused at COMMIT
--   with `accounting.inventory_account_domain_owned` (P0001, no amount) and a
--   message pointing to the inventory adjustment workflow WHEN the business
--   is reconciled without it (Σ stock_movements.value_delta_base_minor =
--   GL Inventory, the exact R-INV-01 equality) and would not be with it.
--
--   Why this and not "refuse every Inventory reversal after stock": 0069
--   (R-91, and the P3-S8 upgrade matrix) made the reversal THE correction
--   path for pre-foundation residue — a manual Inventory line posted before
--   the first movement, which R-INV-01 reports. Refusing every Inventory
--   reversal would leave such a business red forever with no lawful way
--   back. The rule refuses exactly what the directive names — a permitted
--   command knowingly turning a reconciled business red — and nothing else:
--   a reversal on a business already reported by R-INV-01 (residue) is
--   admitted as before, and one that makes it reconciled is the point of it.
--
--   How it is judged. The guard is deferred (0069 R-93) and fires once per
--   reversal entry. It reads, as the accounting principal:
--     E  the reversed entry's net on the Inventory account (its committed
--        lines, visible however early the trigger fires);
--     R  the reversal's own net on the Inventory account; a generic
--        reversal mirrors its original, so R = −E. When the reversal's
--        lines are not yet visible (SET CONSTRAINTS … IMMEDIATE fired it at
--        the end of the header INSERT), R is taken as −E; when they are
--        visible and R ≠ −E, the entry is not a mirror and is refused;
--     G  GL Inventory as visible now, and G₀ = G − (R if visible, else 0),
--        GL Inventory without this reversal.
--   It then asks the inventory domain two booleans: is the stock ledger's
--   value equal to G₀ (reconciled without it), and equal to G₀ + R
--   (reconciled with it)? Refused iff the first is true and the second is
--   not. Several reversals in one transaction are judged at COMMIT, each
--   against the state all of them leave: reversing BOTH of two offsetting
--   entries together is admitted, and it leaves the business reconciled.
--
--   NOT judged: a reversal whose original has no Inventory effect (other
--   accounts are never refused); every reversal while the business has no
--   stock movement (Phase 2 behaviour byte for byte); a domain reversal
--   (`purchase.reverse`, whose original is a purchase entry and whose stock
--   side is written in the same transaction). No stock movement is ever
--   created from an accounting reversal: the correction path for stock and
--   its value is `inventory.adjust`. An original that is not visible to the
--   guard is refused (fail closed, the 0069 R-94 stance).
--
--   The inventory domain answers booleans only (0069 R-92): the new helper
--   `inventory_business_stock_value_equals(uuid, numeric)` is owned by
--   daftar_inventory_internal (GUC-independent through its
--   inventory_internal_read policy), STABLE, DEFINER, pinned, executable by
--   daftar_accounting_internal only. The accounting principal passes a GL
--   figure IN; nothing but true/false comes back, so no stock quantity,
--   value or count crosses to accounting.
--
-- ── Concurrency: the account domain lock (R-B1c) ────────────────────────
--
--   Without a lock, READ COMMITTED lets the COMMIT-time check miss a
--   concurrent first movement. T1 reverses one of two offsetting pre-stock
--   Inventory entries; T2 is the business's first stock movement. T1's
--   deferred check sees no committed movement and admits; T2's guards do not
--   judge reversals; both commit. The end state equals the serial order
--   "reversal, then movement" (lawful pre-foundation residue). But T2 can
--   commit FIRST, and a reversal committing after the first movement is
--   then admitted. The same window exists for R-B1a (0069): a manual
--   Inventory line whose check ran before a first movement committed.
--   0069 R-93 accepted it rather than invert the opening-balance →
--   business lock order with a lock in the body. The same READ COMMITTED
--   gap let the guard read GL Inventory in one statement and the stock
--   value in the next, so a commit between them skewed the comparison.
--
--   The fix is one business-scoped advisory key, taken ONLY by deferred
--   checks, at COMMIT (or when a session forces them early), after every
--   body lock of both transactions:
--
--     K = (hashtext('daftar.inventory_account_domain'), hashtext(business))
--
--     stock side      stock_movements_account_domain_lock: a deferred
--                     constraint trigger AFTER INSERT ON stock_movements
--                     that takes K SHARED. Stock writers never wait for
--                     each other.
--     accounting side the R-B1b guard below, and a serial re-check of R-B1a
--                     (accounting_inventory_account_domain_serial_guard on
--                     manual_adjustment / opening_balance entries). Each
--                     takes K EXCLUSIVE, only for an entry with an
--                     Inventory effect, and only then reads whether the
--                     business has movements. The rest of the read (GL
--                     Inventory and both equalities) is ONE statement, so
--                     one snapshot.
--
--   So when an accounting check waits for a movement transaction, it runs
--   after that transaction has committed and sees it. When a movement
--   transaction waits, the accounting transaction commits first. Either way
--   the later transaction is judged against the earlier one.
--
--   No deadlock. K is the LAST lock either side takes. A deferred check runs
--   after its transaction's body has taken every row and advisory lock it
--   needs (businesses FOR SHARE / FOR UPDATE, the opening-balance key and
--   row, account and source keys, stock keys). What a K holder does next is
--   read, so it never waits on anything a K waiter holds. This is why the
--   stock side is deferred and not a body lock. A body lock after the
--   movement would sit before its posting's businesses FOR SHARE, and would
--   invert against 0047's businesses FOR UPDATE held by an opening balance
--   waiting on K: exactly the inversion 0069 R-93 refused. A session that
--   forces the checks early with SET CONSTRAINTS moves K into its own body.
--   That is its own lock order, and no stored routine or API path does it
--   (0069 R-94).
--
-- 0069's objects are untouched: a separate helper, a separate guard and a
-- separate deferred constraint trigger, filtered to `reversal`, so the
-- accepted R-B1a bodies, their pinned digests and their tamper proofs stay
-- exactly as reviewed.
--
-- GRANT BEFORE OWNER and the CREATE bracket as in 0069: PUBLIC's EXECUTE is
-- revoked and the trigger created while the applier owns the function, then
-- the function is handed to daftar_accounting_internal.
--
-- Migrations 0000-0070 are FROZEN or accepted and untouched.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Preconditions: R-B1a is here, R-B1b is not.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('public.inventory_business_has_stock_movements(uuid)') IS NULL
     OR to_regprocedure('public.accounting_inventory_account_domain_guard()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.journal_entries'::regclass
                      AND tgname = 'journal_entries_inventory_account_domain' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'accounting.migration_precondition: 0071 needs the 0069 R-B1a objects';
  END IF;
  IF to_regprocedure('public.accounting_inventory_reversal_domain_guard()') IS NOT NULL
     OR to_regprocedure('public.inventory_business_stock_value_equals(uuid, numeric)') IS NOT NULL
     OR to_regprocedure('public.stock_movements_account_domain_lock()') IS NOT NULL
     OR to_regprocedure('public.accounting_inventory_account_domain_serial_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.journal_entries'::regclass
                  AND tgname = 'journal_entries_inventory_reversal_domain') THEN
    RAISE EXCEPTION 'accounting.migration_precondition: an R-B1b object already exists before 0071';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2a. The inventory side: the boolean helper (the 0069 3a pattern). Created
--     by the applier, PUBLIC revoked and its one EXECUTE grant issued while
--     the applier owns it, then handed over inside the CREATE bracket.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

CREATE FUNCTION inventory_business_stock_value_equals(p_business_id UUID, p_value NUMERIC) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_value IS NOT NULL
     AND (SELECT coalesce(pg_catalog.sum(m.value_delta_base_minor::numeric), 0)
            FROM public.stock_movements m WHERE m.business_id = p_business_id) = p_value
$$;

COMMENT ON FUNCTION inventory_business_stock_value_equals(UUID, NUMERIC) IS
  'Phase 3 corrective (directive §4; 0071 R-B1b). True when the business''s stock ledger value (Σ stock_movements.value_delta_base_minor, the R-INV-01 side) equals p_value; false otherwise and for NULL. Owned by daftar_inventory_internal (GUC-independent), STABLE, writes nothing, returns a boolean only. EXECUTE: daftar_accounting_internal only (the R-B1b guard).';

REVOKE ALL ON FUNCTION inventory_business_stock_value_equals(UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_business_stock_value_equals(UUID, NUMERIC) TO daftar_accounting_internal;

ALTER FUNCTION inventory_business_stock_value_equals(UUID, NUMERIC) OWNER TO daftar_inventory_internal;

-- R-B1c, the stock side: every movement's transaction holds the account
-- domain key SHARED from its checks to its end. Deferred, so it is the last
-- lock the transaction takes (see the header); SHARED, so stock writers never
-- wait for one another. Reads nothing, writes nothing.
CREATE FUNCTION stock_movements_account_domain_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext('daftar.inventory_account_domain'), pg_catalog.hashtext(NEW.business_id::text));
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION stock_movements_account_domain_lock() IS
  'Phase 3 corrective (directive §4 concurrency; 0071 R-B1c). Deferred AFTER INSERT on stock_movements: takes the business''s account domain key (daftar.inventory_account_domain) SHARED until the transaction ends, so an R-B1a/R-B1b check that takes it EXCLUSIVE is judged after every movement transaction that reached its checks first, and one that had not waits. Reads and writes nothing. Owned by daftar_inventory_internal; no EXECUTE grantee.';

REVOKE ALL ON FUNCTION stock_movements_account_domain_lock() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER stock_movements_account_domain_lock
  AFTER INSERT ON stock_movements DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_movements_account_domain_lock();

ALTER FUNCTION stock_movements_account_domain_lock() OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2b. The accounting side: the guard and its deferred constraint trigger.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE FUNCTION accounting_inventory_reversal_domain_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_orig_type TEXT;
  v_orig_net  NUMERIC;
  v_own_lines INTEGER;
  v_own_net   NUMERIC;
  v_effect    NUMERIC;
  v_moved     BOOLEAN;
  v_was       BOOLEAN;
  v_will      BOOLEAN;
BEGIN
  IF NEW.source_type IS DISTINCT FROM 'reversal' THEN
    RETURN NULL;
  END IF;

  SELECT e.source_type INTO v_orig_type
  FROM public.journal_entries e
  WHERE e.business_id = NEW.business_id AND e.id = NEW.source_id;

  -- A domain reversal (purchase.reverse) moves stock and Inventory together
  -- under its own inventory guards: not this rule's business.
  IF v_orig_type IS NOT NULL AND v_orig_type NOT IN ('manual_adjustment', 'opening_balance') THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(pg_catalog.sum(l.debit_minor::numeric - l.credit_minor::numeric), 0) INTO v_orig_net
  FROM public.journal_lines l
  JOIN public.accounts a ON a.business_id = l.business_id AND a.id = l.account_id
  WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.source_id AND a.system_key = 'inventory';

  SELECT pg_catalog.count(*)::int, coalesce(pg_catalog.sum(l.debit_minor::numeric - l.credit_minor::numeric) FILTER (WHERE a.system_key = 'inventory'), 0)
    INTO v_own_lines, v_own_net
  FROM public.journal_lines l
  JOIN public.accounts a ON a.business_id = l.business_id AND a.id = l.account_id
  WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id;

  -- No Inventory effect, as far as either entry shows: not judged.
  IF v_orig_type IS NOT NULL AND v_orig_net = 0 AND v_own_net = 0 THEN
    RETURN NULL;
  END IF;

  -- R-B1c: the account domain lock, EXCLUSIVE, before anything about the
  -- stock ledger is read. A movement transaction holding it SHARED commits
  -- first and is seen below; one that has not reached its checks waits
  -- until this transaction ends.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('daftar.inventory_account_domain'), pg_catalog.hashtext(NEW.business_id::text));

  -- One statement, one snapshot: has the business a stock ledger, and is it
  -- reconciled without this reversal (GL Inventory less the reversal's own
  -- lines when they are visible) and with it.
  v_effect := -v_orig_net;
  SELECT public.inventory_business_has_stock_movements(NEW.business_id),
         public.inventory_business_stock_value_equals(NEW.business_id, g.before),
         public.inventory_business_stock_value_equals(NEW.business_id, g.before + v_effect)
    INTO v_moved, v_was, v_will
  FROM (SELECT coalesce(pg_catalog.sum(l.debit_minor::numeric - l.credit_minor::numeric), 0)
               - CASE WHEN v_own_lines > 0 THEN v_effect ELSE 0 END AS before
          FROM public.journal_lines l
          JOIN public.accounts a ON a.business_id = l.business_id AND a.id = l.account_id
         WHERE l.business_id = NEW.business_id AND a.system_key = 'inventory') g;

  -- No stock ledger yet: Phase 2 behaviour.
  IF NOT v_moved THEN
    RETURN NULL;
  END IF;

  -- Fail closed: an original the guard cannot see, or a reversal that is not
  -- the mirror of its original.
  IF v_orig_type IS NULL OR (v_own_lines > 0 AND v_own_net <> -v_orig_net) THEN
    RAISE EXCEPTION 'accounting.inventory_account_domain_owned: after a business''s first stock movement, a reversal may not move the Inventory account away from the stock ledger; correct the stock and its value with an inventory adjustment'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_was AND v_will IS NOT TRUE THEN
    RAISE EXCEPTION 'accounting.inventory_account_domain_owned: after a business''s first stock movement, a reversal may not move the Inventory account away from the stock ledger; correct the stock and its value with an inventory adjustment'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION accounting_inventory_reversal_domain_guard() IS
  'Phase 3 corrective (directive §4, S8 I-1; 0071 R-B1b). Deferred AFTER INSERT on journal_entries for reversal entries of a manual_adjustment or opening_balance: after the business''s first stock movement, refuses with accounting.inventory_account_domain_owned (P0001, no amount) a reversal with an Inventory effect when the business is reconciled without it and would not be with it (the R-INV-01 equality, asked of the inventory domain as booleans). Fails closed on an invisible original or a non-mirror reversal. Domain reversals and reversals without an Inventory effect are not judged. Before reading the stock ledger it takes the business''s account domain key EXCLUSIVE (R-B1c), and it reads GL Inventory and both equalities in one statement. Owned by daftar_accounting_internal; no EXECUTE grantee.';

REVOKE ALL ON FUNCTION accounting_inventory_reversal_domain_guard() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER journal_entries_inventory_reversal_domain
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'reversal')
  EXECUTE FUNCTION accounting_inventory_reversal_domain_guard();

ALTER FUNCTION accounting_inventory_reversal_domain_guard() OWNER TO daftar_accounting_internal;

-- R-B1c, R-B1a's serial re-check. 0069's guard (frozen) reads "has stock
-- movements" without a lock, so a first movement committing after that read
-- is missed. This one runs the same predicate AFTER taking the account
-- domain key EXCLUSIVE: a manual adjustment or opening balance with a line
-- on the Inventory system account (or, fired before its lines, with no line
-- visible — fail closed, 0069 R-94) is refused when the business has a
-- movement. 0069's trigger and body are untouched.
CREATE FUNCTION accounting_inventory_account_domain_serial_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.source_type NOT IN ('manual_adjustment', 'opening_balance')
     OR NOT (EXISTS (SELECT 1 FROM public.journal_lines l
                       JOIN public.accounts a ON a.business_id = l.business_id AND a.id = l.account_id
                      WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id AND a.system_key = 'inventory')
             OR NOT EXISTS (SELECT 1 FROM public.journal_lines l
                             WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id)) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('daftar.inventory_account_domain'), pg_catalog.hashtext(NEW.business_id::text));
  IF public.inventory_business_has_stock_movements(NEW.business_id) THEN
    RAISE EXCEPTION 'accounting.inventory_account_domain_owned: after a business''s first stock movement, the Inventory account changes only through an inventory or purchasing operation'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION accounting_inventory_account_domain_serial_guard() IS
  'Phase 3 corrective (directive §4 concurrency; 0071 R-B1c). Deferred AFTER INSERT on journal_entries for manual_adjustment and opening_balance entries: R-B1a''s predicate (a line on the Inventory system account, or no line visible) judged AFTER taking the business''s account domain key EXCLUSIVE, so a first stock movement that committed while the entry was open is seen: accounting.inventory_account_domain_owned (P0001, no amount). 0069''s guard is unchanged. Owned by daftar_accounting_internal; no EXECUTE grantee.';

REVOKE ALL ON FUNCTION accounting_inventory_account_domain_serial_guard() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER journal_entries_inventory_account_domain_serial
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type IN ('manual_adjustment', 'opening_balance'))
  EXECUTE FUNCTION accounting_inventory_account_domain_serial_guard();

ALTER FUNCTION accounting_inventory_account_domain_serial_guard() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. 0071-E: refuse to commit unless the end state is exactly right.
--    Catalogue reads only, so a non-superuser migrator runs it unchanged.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role    TEXT;
  v_actual  TEXT[];
  c_guard   CONSTANT REGPROCEDURE := 'accounting_inventory_reversal_domain_guard()'::regprocedure;
  c_value   CONSTANT REGPROCEDURE := 'inventory_business_stock_value_equals(uuid, numeric)'::regprocedure;
  c_runtime CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                     'daftar_provisioner', 'daftar_reconciler', 'daftar_inventory_internal', 'public'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_language lg ON lg.oid = p.prolang
                  WHERE p.oid = c_guard AND r.rolname = 'daftar_accounting_internal' AND lg.lanname = 'plpgsql'
                    AND p.prosecdef AND p.prorettype = 'trigger'::regtype
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'accounting.authority_leak: accounting_inventory_reversal_domain_guard is not the accounting-owned DEFINER trigger function with the pinned path';
  END IF;
  IF (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = c_guard AND x.grantee <> p.proowner) <> 0 THEN
    RAISE EXCEPTION 'accounting.authority_leak: accounting_inventory_reversal_domain_guard has an EXECUTE grantee';
  END IF;
  FOREACH v_role IN ARRAY c_runtime LOOP
    IF has_function_privilege(v_role, c_guard, 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.authority_leak: % may run the R-B1b guard', v_role;
    END IF;
  END LOOP;
  -- The value helper: inventory-owned SQL STABLE DEFINER boolean, pinned,
  -- EXECUTE held by the accounting principal only.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_language lg ON lg.oid = p.prolang
                  WHERE p.oid = c_value AND r.rolname = 'daftar_inventory_internal' AND lg.lanname = 'sql'
                    AND p.prosecdef AND p.provolatile = 's' AND NOT p.proretset AND p.prorettype = 'boolean'::regtype
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'accounting.authority_leak: inventory_business_stock_value_equals is not the inventory-owned STABLE DEFINER boolean with the pinned path';
  END IF;
  SELECT array_agg(x.grantee::regrole::text || ':' || x.privilege_type || ':' || x.is_grantable::text ORDER BY 1) INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = c_value AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_accounting_internal:EXECUTE:false'] THEN
    RAISE EXCEPTION 'accounting.authority_leak: inventory_business_stock_value_equals must be executable by daftar_accounting_internal only, found %', v_actual;
  END IF;
  FOREACH v_role IN ARRAY c_runtime LOOP
    IF v_role <> 'daftar_inventory_internal' AND has_function_privilege(v_role, c_value, 'EXECUTE') THEN
      RAISE EXCEPTION 'accounting.authority_leak: % may run the R-B1b value helper', v_role;
    END IF;
  END LOOP;

  -- The helpers stay the accounting principal's only way to the ledger.
  IF NOT has_function_privilege('daftar_accounting_internal', 'inventory_business_has_stock_movements(uuid)'::regprocedure, 'EXECUTE')
     OR has_table_privilege('daftar_accounting_internal', 'public.stock_movements', 'SELECT')
     OR has_any_column_privilege('daftar_accounting_internal', 'public.stock_movements', 'SELECT') THEN
    RAISE EXCEPTION 'accounting.authority_leak: the R-B1b guard must reach the stock ledger through the R-B1a helper only';
  END IF;

  -- Exactly one trigger on the guard: the deferred constraint trigger AFTER
  -- INSERT FOR EACH ROW (tgtype 5) on journal_entries, enabled, filtered on
  -- reversals. The R-B1a trigger is still the one 0069 created.
  SELECT array_agg(g.tgname::text ORDER BY g.tgname) INTO v_actual
  FROM pg_trigger g WHERE g.tgfoid = c_guard AND NOT g.tgisinternal;
  IF v_actual IS DISTINCT FROM ARRAY['journal_entries_inventory_reversal_domain']
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g
                     WHERE g.tgrelid = 'public.journal_entries'::regclass AND g.tgname = 'journal_entries_inventory_reversal_domain'
                       AND g.tgfoid = c_guard AND g.tgenabled = 'O' AND g.tgtype = 5
                       AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred AND cardinality(g.tgattr::int2[]) = 0
                       AND position('WHEN ((new.source_type = ''reversal''::text))' IN pg_get_triggerdef(g.oid)) > 0) THEN
    RAISE EXCEPTION 'accounting.authority_leak: journal_entries_inventory_reversal_domain is not the deferred R-B1b constraint trigger, found %', v_actual;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.journal_entries'::regclass AND g.tgname = 'journal_entries_inventory_account_domain'
                    AND g.tgfoid = 'accounting_inventory_account_domain_guard()'::regprocedure AND g.tgenabled = 'O'
                    AND g.tgdeferrable AND g.tginitdeferred) THEN
    RAISE EXCEPTION 'accounting.authority_leak: the R-B1a trigger is not the one 0069 created';
  END IF;

  -- R-B1c: the two lock-taking checks, each the internal-owned DEFINER
  -- trigger function with the pinned path, no EXECUTE grantee, and exactly
  -- one deferred constraint trigger AFTER INSERT FOR EACH ROW.
  FOR v_actual IN SELECT ARRAY[x.fn::text, x.owner, x.rel, x.tg, x.cond] FROM (VALUES
      ('stock_movements_account_domain_lock()'::regprocedure, 'daftar_inventory_internal', 'public.stock_movements',
       'stock_movements_account_domain_lock', ''),
      ('accounting_inventory_account_domain_serial_guard()'::regprocedure, 'daftar_accounting_internal', 'public.journal_entries',
       'journal_entries_inventory_account_domain_serial',
       'WHEN ((new.source_type = ANY (ARRAY[''manual_adjustment''::text, ''opening_balance''::text])))')) AS x(fn, owner, rel, tg, cond)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_language lg ON lg.oid = p.prolang
                    WHERE p.oid = v_actual[1]::regprocedure AND r.rolname = v_actual[2] AND lg.lanname = 'plpgsql'
                      AND p.prosecdef AND p.prorettype = 'trigger'::regtype AND p.proacl IS NOT NULL
                      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'])
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = v_actual[1]::regprocedure AND x.grantee <> p.proowner)
       OR (SELECT array_agg(g.tgname::text) FROM pg_trigger g WHERE g.tgfoid = v_actual[1]::regprocedure AND NOT g.tgisinternal)
          IS DISTINCT FROM ARRAY[v_actual[4]]
       OR NOT EXISTS (SELECT 1 FROM pg_trigger g
                       WHERE g.tgrelid = v_actual[3]::regclass AND g.tgname = v_actual[4] AND g.tgfoid = v_actual[1]::regprocedure
                         AND g.tgenabled = 'O' AND g.tgtype = 5 AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred
                         AND position(v_actual[5] IN pg_get_triggerdef(g.oid)) > 0) THEN
      RAISE EXCEPTION 'accounting.authority_leak: % is not the R-B1c lock-taking check of 0071', v_actual[1];
    END IF;
  END LOOP;

  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.authority_leak: an internal principal still holds CREATE on schema public';
  END IF;
END $$;
