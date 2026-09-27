-- 0069_inventory_reconciliation_read_and_account_domain.sql
-- P3-S8 — the one S8 migration (docs/PHASE_3_S8_CONTRACT.md A-02, §2.1-§2.5,
-- Annex R §2). The lock requires that "the read side runs as
-- daftar_reconciler" (L:1252) over two integer comparisons of the stock
-- ledger, the stock cache and the GL balance of the Inventory system account
-- (L:1240-1250). Until this file the reconciler reads no stock table and not
-- `accounts.system_key`, the only stable identity of that account (0040:30,
-- 53), so the P2-S8 reader could only ever answer R-INV-01..05 "unavailable".
--
-- ── What this file does ─────────────────────────────────────────────────
--
--   1. Preconditions: the S7 head (0068; S7 shipped no migration) is applied
--      and the reconciler is still the 0051 principal.
--   2. Four column-level SELECT grants to daftar_reconciler, each column in
--      infrastructure/database/reconciler-privilege-model.json.
--   3. R-B1a (the working default while B-1 is with the Tech Lead), in ONE
--      delimited section: an inventory-owned boolean helper, an
--      accounting-owned guard and one deferred constraint trigger on
--      journal_entries, with that section's own end-state block.
--   4. 0069-E: the end state against the live catalogues.
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
-- No table, view, index or policy. No write privilege, no REVOKE of an
-- existing grant, no role attribute, no operation kind, no stock source type,
-- no accounting source type. No function outside the R-B1a section. The
-- existing row security admits a scoped reconciler read (tenant_membership
-- plus the restrictive business_isolation, 0059:322-339): the reconciler
-- reads inside the per-business scoped transaction of the P2-S8 reader. The
-- migration principal is never widened; every elevated step below is either
-- a statement by the owner of the object or a CREATE lend bracketed inside
-- this file's own transaction.
--
-- ── Header rules (S8) ───────────────────────────────────────────────────
--
--   R-90 THE RECONCILER READS COLUMNS, NEVER TABLES (A-02, A-11, P2-S8 §13).
--        stock_movements: the twelve columns R-INV-01/02/05 compare, not
--        `reason` (free text), `actor_user_id`, `unit_cost_base_minor` or
--        `created_at`. stock_levels: the seven cache columns, not
--        `avg_unit_cost_base_minor` (a derived quotient, never an input,
--        L:1225-1229). stock_source_bindings: every column (R-INV-05's
--        anti-join key plus ownership). accounts: `system_key` only.
--   R-91 R-B1a — THE INVENTORY ACCOUNT BELONGS TO THE INVENTORY DOMAIN ONCE
--        THE BUSINESS HAS A STOCK LEDGER (Annex R §2.1-§2.5). After a
--        business's first stock movement, a journal entry of source type
--        `manual_adjustment` or `opening_balance` that carries a line on the
--        business's Inventory system account (system_key = 'inventory',
--        never the code 1200) is refused at COMMIT:
--        `accounting.inventory_account_domain_owned` (P0001, no amount).
--        A `reversal` is admitted on purpose (it removes exactly one
--        pre-foundation contribution; R-INV-01 reports whatever remains),
--        and so is every inventory, purchasing and settlement type (they own
--        1200 by construction). A business with no movement keeps Phase 2
--        behaviour byte for byte.
--   R-92 "HAS STOCK MOVEMENTS" IS ASKED OF THE INVENTORY DOMAIN, FAIL-CLOSED
--        (Annex R §1 #17, §2.4). The accounting principal gains no read of
--        `stock_movements`: its row security exempts only the inventory
--        principal (0059:325-329), so an accounting-owned EXISTS would see
--        zero rows under unset or foreign GUCs, i.e. fail open. The question
--        is the boolean helper `inventory_business_has_stock_movements(uuid)`,
--        owned by daftar_inventory_internal (whose inventory_internal_read
--        policy and business-isolation admission make it GUC-independent),
--        STABLE, DEFINER, pinned, EXECUTE by daftar_accounting_internal
--        only. It returns a boolean and nothing else: no id, count or amount
--        crosses the domain boundary.
--   R-93 THE GUARD IS DEFERRED AND ADDS NO LOCK (Annex R §2.5, §2.6). The
--        lines follow the header, so the trigger is a constraint trigger
--        AFTER INSERT, DEFERRABLE INITIALLY DEFERRED, filtered by source
--        type (the 0046:324-327 / 0061:1639-1646 sibling shape); it counts
--        movements written earlier in the same transaction. A first
--        movement that commits after the guard's COMMIT-time read orders as
--        "manual entry first": pre-foundation residue R-INV-01 reports. A
--        lock would invert the existing opening-balance → account order
--        (0047, 0061 R-1) and is not taken.
--   R-94 FORCED EARLY, THE GUARD FAILS CLOSED (review H-1). SET CONSTRAINTS
--        needs no privilege, so a session may make the trigger IMMEDIATE.
--        It then fires at the end of the header INSERT, before the one
--        set-wise lines INSERT that follows it in accounting_post_entry
--        (0045:776-793), and never again. An entry with no visible line is
--        therefore refused like one with an Inventory line (a committed entry
--        always has at least two lines: 0043:172). No path fires it with SOME
--        lines visible: journal_lines is written only by the two INSERT …
--        SELECT statements of 0045 and 0046, each directly after its own
--        header INSERT, under a non-deferrable FK to the header
--        (journal_lines_entry_fk, 0042:206), and no stored routine issues
--        SET CONSTRAINTS. SET CONSTRAINTS issued after the posting fires the
--        pending event with every line visible.
--
-- ── The carried hardenings ──────────────────────────────────────────────
--
--   0063 R-37 (fail closed): the guard exempts nothing on a session GUC.
--   0063 R-40 (probes as a non-superuser): every 0069-E probe reads the
--        catalogue or runs as an internal principal the migrator may SET
--        ROLE to; nothing requires a superuser.
--   0063 R-41 (no unclassified code): the guard raises only
--        `accounting.inventory_account_domain_owned`.
--   GRANT BEFORE OWNER: PUBLIC's EXECUTE is revoked, the one EXECUTE grant
--        issued and the trigger created while the migrator still owns each
--        function; only then is ownership handed over. A GRANT by a
--        non-owner without grant option is a WARNING, not an error, so the
--        reverse order would silently grant nothing on a managed
--        deployment.
--   G-5 / G-7: both functions pin `search_path = pg_catalog, public,
--        pg_temp`, are SECURITY DEFINER, and are handed over inside the
--        CREATE bracket of their new owner.
-- ─────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────
-- 1. Preconditions (§2.1(2)). The S7 head is applied; the reconciler is the
--    0051 principal and reads nothing this file is about to grant; the four
--    target tables carry every named column; R-B1a is not already here.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_detail TEXT;
BEGIN
  IF to_regclass('public.supplier_payments') IS NULL OR to_regclass('public.supplier_refunds') IS NULL
     OR to_regclass('public.payment_methods') IS NULL
     OR to_regprocedure('public.supplier_credit_note_consume(uuid,bigint,bigint)') IS NULL
     OR (SELECT count(*) FROM inventory_operation_kinds) <> 26 THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: 0069 applies on the S7 head (0068 and its twenty-six operation kinds) only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'daftar_reconciler'
                   AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls) THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: daftar_reconciler must exist as a LOGIN role without SUPERUSER or BYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('daftar_inventory_internal', 'daftar_accounting_internal')
               AND (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls))
     OR (SELECT count(*) FROM pg_roles r WHERE r.rolname IN ('daftar_inventory_internal', 'daftar_accounting_internal')) <> 2 THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: both internal principals must exist as NOLOGIN roles';
  END IF;
  SELECT string_agg(x.t || '.' || x.c, ', ' ORDER BY x.t, x.c) INTO v_detail
  FROM (VALUES
          ('stock_movements', 'tenant_id'), ('stock_movements', 'business_id'), ('stock_movements', 'id'),
          ('stock_movements', 'warehouse_id'), ('stock_movements', 'variant_id'), ('stock_movements', 'stock_seq'),
          ('stock_movements', 'movement_kind'), ('stock_movements', 'source_type'), ('stock_movements', 'source_id'),
          ('stock_movements', 'source_line_id'), ('stock_movements', 'qty_delta'), ('stock_movements', 'value_delta_base_minor'),
          ('stock_levels', 'tenant_id'), ('stock_levels', 'business_id'), ('stock_levels', 'warehouse_id'),
          ('stock_levels', 'variant_id'), ('stock_levels', 'on_hand'), ('stock_levels', 'valuation_base_minor'),
          ('stock_levels', 'last_stock_seq'),
          ('stock_source_bindings', 'tenant_id'), ('stock_source_bindings', 'business_id'), ('stock_source_bindings', 'source_type'),
          ('stock_source_bindings', 'source_id'), ('stock_source_bindings', 'source_line_id'), ('stock_source_bindings', 'movement_kind'),
          ('accounts', 'system_key')) AS x(t, c)
  WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = to_regclass('public.' || x.t) AND a.attname = x.c AND a.attnum > 0 AND NOT a.attisdropped);
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: a column 0069 grants does not exist: %', v_detail;
  END IF;
  IF has_any_column_privilege('daftar_reconciler', 'public.stock_movements', 'SELECT')
     OR has_any_column_privilege('daftar_reconciler', 'public.stock_levels', 'SELECT')
     OR has_any_column_privilege('daftar_reconciler', 'public.stock_source_bindings', 'SELECT')
     OR has_column_privilege('daftar_reconciler', 'public.accounts', 'system_key', 'SELECT') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_reconciler already reads a column 0069 grants, so the widening is not reviewable';
  END IF;
  IF to_regprocedure('public.inventory_business_has_stock_movements(uuid)') IS NOT NULL
     OR to_regprocedure('public.accounting_inventory_account_domain_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'public.journal_entries'::regclass
                  AND g.tgname = 'journal_entries_inventory_account_domain') THEN
    RAISE EXCEPTION 'inventory.migration_end_state_invalid: an R-B1a object already exists before 0069';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────
-- 2. The reconciler's column reads (A-02, §2.2, R-90). Four statements, each
--    to daftar_reconciler, each column named. No table-level SELECT.
-- ─────────────────────────────────────────────────────────────────────────

-- stock_movements — R-INV-01 (Σ value_delta_base_minor), R-INV-02 (per-key
-- Σ qty_delta / value, a sequence gapless and duplicate-free from 1),
-- R-INV-05 (the five-part identity), and the ownership pair for the scoped read.
GRANT SELECT (tenant_id, business_id, id, warehouse_id, variant_id, stock_seq, movement_kind, source_type, source_id, source_line_id,
              qty_delta, value_delta_base_minor)
  ON stock_movements TO daftar_reconciler;

-- stock_levels — R-INV-02 (cache = ledger) and R-INV-03 (empty stock carries
-- no value). Not avg_unit_cost_base_minor.
GRANT SELECT (tenant_id, business_id, warehouse_id, variant_id, on_hand, valuation_base_minor, last_stock_seq)
  ON stock_levels TO daftar_reconciler;

-- stock_source_bindings — R-INV-05, both directions; every column.
GRANT SELECT (tenant_id, business_id, source_type, source_id, source_line_id, movement_kind)
  ON stock_source_bindings TO daftar_reconciler;

-- accounts — the identity of the Inventory (R-INV-01) and Rounding (R-INV-04)
-- system accounts. Not `code` or `name`: presentation, renamable.
GRANT SELECT (system_key) ON accounts TO daftar_reconciler;


-- ═════════════════════════════════════════════════════════════════════════
-- ══ BEGIN R-B1a (B-1 working default; Annex R §2) ════════════════════════
-- ══ An R-B1b/c ruling before freeze deletes everything from this line to
-- ══ the matching END line, and sets the S8 gate's B1_RULING constant.
-- ═════════════════════════════════════════════════════════════════════════

-- 3a. The inventory side (R-92, Annex R §2.4): the boolean helper. Created by
--     the migrator, PUBLIC revoked and its one EXECUTE grant issued while the
--     migrator owns it, then handed to the inventory principal inside the
--     inventory CREATE bracket (the 0067:665 pattern).
GRANT CREATE ON SCHEMA public TO daftar_inventory_internal;

CREATE FUNCTION inventory_business_has_stock_movements(p_business_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.stock_movements m WHERE m.business_id = p_business_id)
$$;

COMMENT ON FUNCTION inventory_business_has_stock_movements(UUID) IS
  'P3-S8 R-B1a (Annex R §2.4, 0069 R-92). True when the business has at least one stock movement of any kind, including one written earlier in the calling transaction; false otherwise (and for NULL). Owned by daftar_inventory_internal, whose inventory_internal_read policy and business-isolation admission make the answer independent of session GUCs (fail-closed). STABLE, writes nothing, returns a boolean only. EXECUTE: daftar_accounting_internal only (the R-B1a guard).';

REVOKE ALL ON FUNCTION inventory_business_has_stock_movements(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_business_has_stock_movements(UUID) TO daftar_accounting_internal;

ALTER FUNCTION inventory_business_has_stock_movements(UUID) OWNER TO daftar_inventory_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal;

-- 3b. The accounting side (R-91, R-93, Annex R §2.5): the guard and its
--     deferred constraint trigger. The trigger is created while the
--     migrator still owns the function (a non-superuser must hold EXECUTE on
--     it to create the trigger); then the function is handed to the
--     accounting principal inside the accounting CREATE bracket (0058:40-71).
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

CREATE FUNCTION accounting_inventory_account_domain_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- R-94: no line visible means the trigger was forced to fire early (SET
  -- CONSTRAINTS … IMMEDIATE, before the lines statement); refuse, never pass.
  IF NEW.source_type IN ('manual_adjustment', 'opening_balance')
     AND (EXISTS (SELECT 1 FROM journal_lines l
                    JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
                   WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id
                     AND a.system_key = 'inventory')
          OR NOT EXISTS (SELECT 1 FROM journal_lines l
                          WHERE l.business_id = NEW.business_id AND l.journal_entry_id = NEW.id))
     AND inventory_business_has_stock_movements(NEW.business_id) THEN
    RAISE EXCEPTION 'accounting.inventory_account_domain_owned: after a business''s first stock movement, the Inventory account changes only through an inventory or purchasing operation'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION accounting_inventory_account_domain_guard() IS
  'P3-S8 R-B1a (Annex R §2.1-§2.5, 0069 R-91/R-93). Deferred AFTER INSERT on journal_entries for manual_adjustment and opening_balance entries: when the entry has a line on the business''s Inventory system account (system_key = inventory; opening lines stated by code resolve to the same account) and inventory_business_has_stock_movements is true, refuses with accounting.inventory_account_domain_owned (P0001, no amount). Fired before any line is visible (SET CONSTRAINTS … IMMEDIATE), it refuses too: fail closed (R-94). Reversals and every inventory, purchasing and settlement type are not judged. Owned by daftar_accounting_internal (reads lines and accounts through the 0045 identity policies); no EXECUTE grantee.';

REVOKE ALL ON FUNCTION accounting_inventory_account_domain_guard() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER journal_entries_inventory_account_domain
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type IN ('manual_adjustment', 'opening_balance'))
  EXECUTE FUNCTION accounting_inventory_account_domain_guard();

ALTER FUNCTION accounting_inventory_account_domain_guard() OWNER TO daftar_accounting_internal;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- 3c. 0069-E (R-B1a part): the section's own end state, so deleting the
--     section deletes its assertions with it.
DO $$
DECLARE
  v_role    TEXT;
  v_actual  TEXT[];
  v_bid     UUID;
  v_has     BOOLEAN;
  c_helper  CONSTANT REGPROCEDURE := 'inventory_business_has_stock_movements(uuid)'::regprocedure;
  c_guard   CONSTANT REGPROCEDURE := 'accounting_inventory_account_domain_guard()'::regprocedure;
  c_runtime CONSTANT TEXT[] := ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver',
                                     'daftar_provisioner', 'daftar_reconciler', 'public'];
BEGIN
  -- (1) The helper: inventory-owned, SQL, STABLE, DEFINER, pinned, boolean
  --     of one uuid; EXECUTE held by the accounting principal only.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_language lg ON lg.oid = p.prolang
                  WHERE p.oid = c_helper AND r.rolname = 'daftar_inventory_internal' AND lg.lanname = 'sql'
                    AND p.prosecdef AND p.provolatile = 's' AND NOT p.proretset AND p.prorettype = 'boolean'::regtype
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'inventory.authority_leak: inventory_business_has_stock_movements is not the inventory-owned STABLE DEFINER boolean with the pinned path';
  END IF;
  SELECT array_agg(x.grantee::regrole::text || ':' || x.privilege_type || ':' || x.is_grantable::text ORDER BY x.grantee::regrole::text)
    INTO v_actual
  FROM pg_proc p, aclexplode(p.proacl) x
  WHERE p.oid = c_helper AND x.grantee <> p.proowner;
  IF v_actual IS DISTINCT FROM ARRAY['daftar_accounting_internal:EXECUTE:false'] THEN
    RAISE EXCEPTION 'inventory.authority_leak: inventory_business_has_stock_movements must be executable by daftar_accounting_internal only, found %', v_actual;
  END IF;

  -- (2) The guard: accounting-owned, plpgsql, DEFINER, pinned, a trigger
  --     function with no grantee at all.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_language lg ON lg.oid = p.prolang
                  WHERE p.oid = c_guard AND r.rolname = 'daftar_accounting_internal' AND lg.lanname = 'plpgsql'
                    AND p.prosecdef AND p.prorettype = 'trigger'::regtype
                    AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'inventory.authority_leak: accounting_inventory_account_domain_guard is not the accounting-owned DEFINER trigger function with the pinned path';
  END IF;
  IF (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = c_guard AND x.grantee <> p.proowner) <> 0 THEN
    RAISE EXCEPTION 'inventory.authority_leak: accounting_inventory_account_domain_guard has an EXECUTE grantee';
  END IF;
  FOREACH v_role IN ARRAY c_runtime LOOP
    IF has_function_privilege(v_role, c_guard, 'EXECUTE') OR has_function_privilege(v_role, c_helper, 'EXECUTE') THEN
      RAISE EXCEPTION 'inventory.authority_leak: % may run an R-B1a function', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('daftar_inventory_internal', c_guard, 'EXECUTE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_inventory_internal may run the accounting guard';
  END IF;

  -- (3) The trigger: exactly one, on journal_entries, enabled, a constraint
  --     trigger AFTER INSERT FOR EACH ROW (tgtype 5), DEFERRABLE INITIALLY
  --     DEFERRED, filtered on the two merchant-stated types, on the guard.
  SELECT array_agg(g.tgname::text ORDER BY g.tgname) INTO v_actual
  FROM pg_trigger g
  WHERE g.tgfoid = c_guard AND NOT g.tgisinternal;
  IF v_actual IS DISTINCT FROM ARRAY['journal_entries_inventory_account_domain']
     OR NOT EXISTS (SELECT 1 FROM pg_trigger g
                     WHERE g.tgrelid = 'public.journal_entries'::regclass AND g.tgname = 'journal_entries_inventory_account_domain'
                       AND g.tgfoid = c_guard AND NOT g.tgisinternal AND g.tgenabled = 'O' AND g.tgtype = 5
                       AND g.tgconstraint <> 0 AND g.tgdeferrable AND g.tginitdeferred AND cardinality(g.tgattr::int2[]) = 0
                       AND position('WHEN ((new.source_type = ANY (ARRAY[''manual_adjustment''::text, ''opening_balance''::text])))'
                                    IN pg_get_triggerdef(g.oid)) > 0) THEN
    RAISE EXCEPTION 'inventory.authority_leak: journal_entries_inventory_account_domain is not the deferred R-B1a constraint trigger, found %', v_actual;
  END IF;

  -- (4) No grant on stock_movements to the accounting principal: the helper
  --     is its only way to the ledger (Annex R §1 #17).
  IF has_table_privilege('daftar_accounting_internal', 'public.stock_movements', 'SELECT')
     OR has_any_column_privilege('daftar_accounting_internal', 'public.stock_movements', 'SELECT') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_accounting_internal reads stock_movements directly';
  END IF;

  -- (5) Fail-closed, probed as the guard's own principal with this
  --     session's GUCs (unset in a deployment): no business answers true for
  --     an unknown id, and a business that has movements answers true
  --     whatever scope the session carries.
  SET LOCAL ROLE daftar_inventory_internal;
  SELECT m.business_id INTO v_bid FROM stock_movements m LIMIT 1;
  RESET ROLE;
  SET LOCAL ROLE daftar_accounting_internal;
  v_has := inventory_business_has_stock_movements('00000000-0000-4000-8000-000000000000'::uuid);
  IF v_has IS DISTINCT FROM false OR inventory_business_has_stock_movements(NULL) IS DISTINCT FROM false THEN
    RESET ROLE;
    RAISE EXCEPTION 'inventory.authority_leak: inventory_business_has_stock_movements answers true for a business without movements';
  END IF;
  IF v_bid IS NOT NULL THEN
    v_has := inventory_business_has_stock_movements(v_bid);
    IF v_has IS DISTINCT FROM true THEN
      RESET ROLE;
      RAISE EXCEPTION 'inventory.authority_leak: inventory_business_has_stock_movements does not see an existing movement from the accounting principal (fail-open)';
    END IF;
  END IF;
  RESET ROLE;

  -- (6) Neither internal principal keeps CREATE on public.
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: an internal principal still holds CREATE on schema public';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- ══ END R-B1a ════════════════════════════════════════════════════════════
-- ═════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────
-- 4. Refuse to commit unless the end state is exactly right (0069-E, §2.3).
--    Catalogue reads and has_*_privilege only, so a non-superuser migrator
--    runs it unchanged (0063 R-40). The accepted code is 0059's
--    `inventory.authority_leak`.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role    TEXT;
  v_table   TEXT;
  v_actual  TEXT[];
  v_detail  TEXT;
  c_stock   CONSTANT TEXT[] := ARRAY['stock_levels', 'stock_movements', 'stock_source_bindings'];
  c_others  CONSTANT TEXT[] := ARRAY['daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner', 'public'];
  c_writes  CONSTANT TEXT[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
BEGIN
  -- (1) The reconciler's whole read surface in public is exactly the 0051
  --     columns plus the 0069 columns (the model file, both directions),
  --     with no table-level SELECT anywhere.
  SELECT array_agg(c.relname || '.' || a.attname ORDER BY c.relname, a.attname) INTO v_actual
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
    AND has_column_privilege('daftar_reconciler', c.oid, a.attname, 'SELECT');
  IF v_actual IS DISTINCT FROM ARRAY[
       'accounting_periods.business_id', 'accounting_periods.closed_at', 'accounting_periods.end_date', 'accounting_periods.id',
       'accounting_periods.start_date', 'accounting_periods.status', 'accounting_periods.tenant_id',
       'accounting_source_bindings.business_id', 'accounting_source_bindings.journal_entry_id', 'accounting_source_bindings.source_id',
       'accounting_source_bindings.source_type', 'accounting_source_bindings.tenant_id',
       'accounts.business_id', 'accounts.id', 'accounts.system_key', 'accounts.tenant_id', 'accounts.type',
       'businesses.base_currency', 'businesses.financial_started_at', 'businesses.id', 'businesses.tenant_id',
       'journal_entries.business_id', 'journal_entries.created_at', 'journal_entries.entry_date', 'journal_entries.id',
       'journal_entries.source_id', 'journal_entries.source_type', 'journal_entries.tenant_id',
       'journal_lines.account_id', 'journal_lines.base_amount_minor', 'journal_lines.base_currency', 'journal_lines.business_id',
       'journal_lines.credit_minor', 'journal_lines.debit_minor', 'journal_lines.fx_rate', 'journal_lines.fx_rate_source',
       'journal_lines.id', 'journal_lines.journal_entry_id', 'journal_lines.tenant_id', 'journal_lines.txn_amount_minor',
       'journal_lines.txn_currency',
       'stock_levels.business_id', 'stock_levels.last_stock_seq', 'stock_levels.on_hand', 'stock_levels.tenant_id',
       'stock_levels.valuation_base_minor', 'stock_levels.variant_id', 'stock_levels.warehouse_id',
       'stock_movements.business_id', 'stock_movements.id', 'stock_movements.movement_kind', 'stock_movements.qty_delta',
       'stock_movements.source_id', 'stock_movements.source_line_id', 'stock_movements.source_type', 'stock_movements.stock_seq',
       'stock_movements.tenant_id', 'stock_movements.value_delta_base_minor', 'stock_movements.variant_id',
       'stock_movements.warehouse_id',
       'stock_source_bindings.business_id', 'stock_source_bindings.movement_kind', 'stock_source_bindings.source_id',
       'stock_source_bindings.source_line_id', 'stock_source_bindings.source_type', 'stock_source_bindings.tenant_id'] THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_reconciler does not read exactly the 0051 and 0069 columns, found %', v_actual;
  END IF;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND has_table_privilege('daftar_reconciler', c.oid, 'SELECT');
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_reconciler holds table-level SELECT on %', v_detail;
  END IF;

  -- (2) The reconciler writes nothing, references nothing, creates nothing,
  --     and executes exactly its one 0051 routine by grant.
  SELECT string_agg(c.relname || ':' || p, ', ' ORDER BY c.relname, p) INTO v_detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  CROSS JOIN unnest(c_writes) AS p
  WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
    AND (has_table_privilege('daftar_reconciler', c.oid, p)
         OR (p IN ('INSERT', 'UPDATE', 'REFERENCES') AND has_any_column_privilege('daftar_reconciler', c.oid, p)));
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_reconciler holds a write privilege: %', v_detail;
  END IF;
  IF has_database_privilege('daftar_reconciler', current_database(), 'TEMPORARY')
     OR has_schema_privilege('daftar_reconciler', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_reconciler may create a temporary or public relation';
  END IF;
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) INTO v_actual
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE EXISTS (SELECT 1 FROM aclexplode(p.proacl) x
                 WHERE x.grantee = 'daftar_reconciler'::regrole AND x.privilege_type = 'EXECUTE');
  IF v_actual IS DISTINCT FROM ARRAY['accounting_reconcile_businesses(uuid,uuid,integer)'] THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_reconciler must execute exactly accounting_reconcile_businesses, found %', v_actual;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'daftar_reconciler'
               AND (NOT r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)) THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_reconciler gained a role attribute';
  END IF;

  -- (3) The daftar_app read set on the stock tables is unchanged (0059:372):
  --     both tables at table level, no binding read; no other runtime role
  --     and not PUBLIC reads a stock table at any level.
  SELECT array_agg(t ORDER BY t) INTO v_actual
  FROM unnest(c_stock) AS t
  WHERE has_table_privilege('daftar_app', t, 'SELECT') OR has_any_column_privilege('daftar_app', t, 'SELECT');
  IF v_actual IS DISTINCT FROM ARRAY['stock_levels', 'stock_movements']
     OR NOT has_table_privilege('daftar_app', 'stock_levels', 'SELECT') OR NOT has_table_privilege('daftar_app', 'stock_movements', 'SELECT') THEN
    RAISE EXCEPTION 'inventory.authority_leak: daftar_app must read exactly stock_levels and stock_movements, found %', v_actual;
  END IF;
  FOREACH v_role IN ARRAY c_others LOOP
    FOREACH v_table IN ARRAY c_stock LOOP
      IF has_table_privilege(v_role, v_table, 'SELECT') OR has_any_column_privilege(v_role, v_table, 'SELECT') THEN
        RAISE EXCEPTION 'inventory.authority_leak: % may read % and has no requirement to', v_role, v_table;
      END IF;
    END LOOP;
  END LOOP;

  -- (4) The row security of the three stock tables is exactly 0059's: the
  --     reconciler reads through the scoped policies, no new admission.
  SELECT array_agg(c.relname || ':' || p.polname || ':' || p.polcmd::text || ':' || p.polpermissive::text ORDER BY c.relname, p.polname)
    INTO v_actual
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.oid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_stock) AS t));
  IF v_actual IS DISTINCT FROM ARRAY[
       'stock_levels:business_isolation:*:false', 'stock_levels:inventory_internal_read:r:true', 'stock_levels:tenant_membership:*:true',
       'stock_movements:business_isolation:*:false', 'stock_movements:inventory_internal_read:r:true',
       'stock_movements:tenant_membership:*:true',
       'stock_source_bindings:business_isolation:*:false', 'stock_source_bindings:tenant_membership:*:true']
     OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = ANY (ARRAY(SELECT ('public.' || t)::regclass FROM unnest(c_stock) AS t))
                  AND NOT (c.relrowsecurity AND c.relforcerowsecurity)) THEN
    RAISE EXCEPTION 'inventory.authority_leak: the stock tables'' row security is not exactly 0059''s, found %', v_actual;
  END IF;

  -- (5) S8 registers nothing: the twenty-six S7-head kinds, none by P3-S8.
  IF (SELECT count(*) FROM inventory_operation_kinds) <> 26
     OR EXISTS (SELECT 1 FROM inventory_operation_kinds k WHERE k.registered_by NOT IN ('P3-S1', 'P3-S3', 'P3-S4', 'P3-S5', 'P3-S6')) THEN
    RAISE EXCEPTION 'inventory.authority_leak: inventory_operation_kinds is not the twenty-six kinds of the S7 head';
  END IF;

  -- (6) No role gained an attribute, and neither internal principal keeps
  --     CREATE on public.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('daftar_inventory_internal', 'daftar_accounting_internal')
               AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'inventory.authority_leak: an internal principal is no longer an unreachable NOLOGIN NOINHERIT role';
  END IF;
  IF has_schema_privilege('daftar_inventory_internal', 'public', 'CREATE')
     OR has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'inventory.authority_leak: an internal principal still holds CREATE on schema public';
  END IF;
END $$;
