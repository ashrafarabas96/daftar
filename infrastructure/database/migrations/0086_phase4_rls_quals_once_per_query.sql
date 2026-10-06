-- 0086_phase4_rls_quals_once_per_query.sql
-- Phase 4 / P4-S4 CORRECTIVE — THE READ POLICIES' ROW-INVARIANT PARTS,
-- EVALUATED ONCE PER QUERY. NO POLICY MEANS ANYTHING DIFFERENT.
--
-- P4-AL-72's growth rule for the customer receivable read — p95(fat-tail) <=
-- 3 x p95(median) — is RED, measured twice on a quiet host at 3.09x and
-- 3.64x against 3. It is red for a reason that is not in the arithmetic.
-- Decomposed with EXPLAIN (ANALYZE, BUFFERS, VERBOSE) on PostgreSQL 16.13 as
-- `daftar_app` with row security applied, 200 samples per arm:
--
--   the whole read, fat customer (2 000 open invoices)   21.819 ms
--   the same read as the schema owner, RLS bypassed      10.620 ms
--   ------------------------------------------------------------
--   row-security predicate evaluation                    11.199 ms  (51.3 %)
--
-- Bigger than any plan node. Bigger than the whole reducer subquery. 58x the
-- `plpgsql` tuplestore. Every other suspect measured sub-millisecond: the
-- `unnest` 0.157 ms (and it is not in the body at all, only in the refusal
-- path), the `ROW_COUNT` non-vacuity check 0 ms on the passing path, the
-- outer `GROUP BY`/`HAVING` 0.061 ms, the second `UNION ALL` arm 0.128 ms.
--
-- WHY THE POLICY COSTS THAT. For `daftar_app` exactly two policies are
-- evaluated on each of these four relations: `tenant_membership` (permissive,
-- no `TO`, so PUBLIC) and `business_isolation_read` (RESTRICTIVE, FOR
-- SELECT). The other five per relation do not apply to it —
-- `inventory_internal_read` and `accounting_validator` are `TO
-- daftar_inventory_internal` / `TO daftar_accounting_internal`, and the
-- insert/update/delete restrictives are for other commands. Those two quals
-- name `app_bypass()`, `app_tenant()` and `app_business()`, which 0052
-- deliberately made SQL-standard-body, PARALLEL SAFE and free of a `SET`
-- clause SO THAT THEY INLINE (`policy-helper-inlining.test.ts` is the
-- standing proof of that exemption, and it stays true: this file does not
-- touch the helpers). But an inlined STABLE expression sitting in a `Filter`
-- is re-evaluated FOR EVERY ROW. Per read that is ~10 020 row-evaluations —
-- 2 000 `invoices` in the id subquery, 2 000 in the body's scan, 2 000
-- `sales` probes, 4 000 `payment_allocations`, 20
-- `customer_credit_applications` — each computing three `CURRENT_USER`
-- lookups, two `current_setting()` calls, two `NULLIF`s and two text->uuid
-- casts. Pure CPU: the buffer counts are IDENTICAL before and after this
-- file (19 986 either way), so there is no I/O here to remove.
--
-- WHAT THIS FILE DOES. It wraps each ROW-INVARIANT subexpression of those
-- two quals in a scalar subselect. An uncorrelated `SubLink` becomes an
-- `InitPlan`, which the executor evaluates ONCE PER QUERY instead of once
-- per row. Measured: ten InitPlans totalling 0.009 ms, and the per-row
-- `Filter` collapses to a handful of `Param` comparisons.
--
--   the route's own statements, fat customer, p95, 200 samples
--     as shipped          24.363 ms
--     after this file     12.630 ms      -48.2 %
--   marginal (fat - median), per invoice
--     as shipped          11.99 us
--     after this file      6.14 us       -48.8 %
--
-- It lands ON the schema-owner figure (10.620 ms owner, 10.735 ms here), so
-- it recovers ~99 % of the measured policy cost WHILE LEAVING THE POLICY IN
-- FORCE.
--
-- WHAT IT IS NOT. It changes WHEN a condition is computed, never WHAT it
-- means. `app_bypass()`, `CURRENT_USER` and the two GUCs cannot change in the
-- middle of a statement, so once-per-query and once-per-row are the same
-- value by construction. Nothing is cached across statements. No policy is
-- weakened, narrowed, disabled or unforced; no policy is dropped; no row
-- becomes visible that was not visible before, and none stops being visible.
-- Default-deny is preserved by the same mechanism it always rested on:
-- `nullif(app_business(), '')::uuid` is NULL when the GUC is unset, so
-- `business_id = NULL` is NULL, so the RESTRICTIVE policy denies — and
-- `(SELECT nullif(app_business(), '')::uuid)` is the same NULL.
--
-- SCOPE, deliberately narrow. The four relations the receivable read
-- actually scans, and only the two quals that actually run for `daftar_app`
-- on them. The same shape exists on ~40 other relations from `0006_rls.sql`
-- onward and is NOT touched here: this file closes a measured invariant on a
-- measured surface, and widening it to the estate is a separate change with
-- its own proof obligation.
--
-- THE WRITE PATH IS NOT TOUCHED. `ALTER POLICY ... USING (...)` alters only
-- the clause it names, so every `WITH CHECK` on these relations keeps the
-- per-row form byte for byte. 0086-E(2) reads that back from the catalogue
-- rather than asserting it in prose.
--
-- Migrations 0000-0079 are FROZEN and untouched. `0080`-`0085` are CANDIDATE
-- and untouched. This file is append-only and creates no object.

ALTER POLICY tenant_membership ON invoices
  USING ((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid));
ALTER POLICY business_isolation_read ON invoices
  USING ((SELECT app_bypass())
         OR (SELECT current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal'))
         OR business_id = (SELECT nullif(app_business(), '')::uuid));

ALTER POLICY tenant_membership ON sales
  USING ((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid));
ALTER POLICY business_isolation_read ON sales
  USING ((SELECT app_bypass())
         OR (SELECT current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal'))
         OR business_id = (SELECT nullif(app_business(), '')::uuid));

ALTER POLICY tenant_membership ON payment_allocations
  USING ((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid));
ALTER POLICY business_isolation_read ON payment_allocations
  USING ((SELECT app_bypass())
         OR (SELECT current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal'))
         OR business_id = (SELECT nullif(app_business(), '')::uuid));

ALTER POLICY tenant_membership ON customer_credit_applications
  USING ((SELECT app_bypass()) OR tenant_id = (SELECT nullif(app_tenant(), '')::uuid));
ALTER POLICY business_isolation_read ON customer_credit_applications
  USING ((SELECT app_bypass())
         OR (SELECT current_user IN ('daftar_inventory_internal', 'daftar_accounting_internal'))
         OR business_id = (SELECT nullif(app_business(), '')::uuid));

-- ── 0086-E — read back from the catalogue, never asserted in prose ────────
DO $post$
DECLARE
  v_rel      TEXT;
  v_qual     TEXT;
  v_check    TEXT;
  v_n        INTEGER;
  v_operands TEXT[];
  v_operand  TEXT;
  v_ors      INTEGER;
  v_want_ors INTEGER;
BEGIN
  FOREACH v_rel IN ARRAY ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] LOOP

    -- 0086-E(1). Both read quals now compute their row-invariant parts in a
    -- subselect. Asserted on the catalogue's own rendering of the expression,
    -- so a future edit that reverts the shape turns this red.
    FOREACH v_qual IN ARRAY ARRAY['tenant_membership', 'business_isolation_read'] LOOP
      SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid) INTO v_check
        FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel AND p.polname = v_qual;
      IF v_check IS NULL THEN
        RAISE EXCEPTION '0086-E(1): % has no % policy, so this file altered something that is not there', v_rel, v_qual;
      END IF;
      IF v_check NOT LIKE '%( SELECT %' THEN
        RAISE EXCEPTION '0086-E(1): %.% still evaluates its row-invariant parts per row: %', v_rel, v_qual, v_check;
      END IF;

      -- THE MEANING, NOT ONLY THE SHAPE. Asking only for a subselect and for
      -- `app_bypass()` is not a barrier: `USING ((SELECT app_bypass()) OR
      -- (SELECT true))` satisfies both and admits every row of every tenant.
      -- The barrier is the TENANT disjunct on `tenant_membership` and the
      -- BUSINESS disjunct on `business_isolation_read` — the two operands the
      -- weaker form never named — so each qual is read back against its whole
      -- operand set AND against the number of disjuncts it is allowed to have.
      -- Presence alone would still admit an ADDED `OR (SELECT true)`; the
      -- count alone would still admit a SWAPPED disjunct. Together they admit
      -- neither.
      v_operands := CASE v_qual
        WHEN 'tenant_membership' THEN ARRAY['app_bypass()', 'app_tenant()', 'tenant_id']
        WHEN 'business_isolation_read' THEN ARRAY['app_bypass()', 'app_business()', 'business_id',
                                                  'daftar_inventory_internal', 'daftar_accounting_internal']
      END;
      v_want_ors := CASE v_qual WHEN 'tenant_membership' THEN 1 WHEN 'business_isolation_read' THEN 2 END;
      IF v_operands IS NULL OR v_want_ors IS NULL THEN
        RAISE EXCEPTION '0086-E(1): % is not one of the two quals this file rewrites, so its operand set is unstated', v_qual;
      END IF;
      FOREACH v_operand IN ARRAY v_operands LOOP
        IF pg_catalog.strpos(v_check, v_operand) = 0 THEN
          RAISE EXCEPTION '0086-E(1): %.% no longer names %, so a barrier the per-row form carried is gone: %', v_rel, v_qual, v_operand, v_check;
        END IF;
      END LOOP;
      v_ors := (pg_catalog.length(v_check) - pg_catalog.length(pg_catalog.replace(v_check, ' OR ', ''))) / 4;
      IF v_ors <> v_want_ors THEN
        RAISE EXCEPTION '0086-E(1): %.% carries % disjunct(s) and the per-row form carried % — a disjunct was added or lost: %', v_rel, v_qual, v_ors + 1, v_want_ors + 1, v_check;
      END IF;
    END LOOP;

    -- 0086-E(2). THE WRITE PATH IS UNTOUCHED. `tenant_membership` carries a
    -- WITH CHECK and this file named only USING, so the check expression must
    -- still be the per-row form — no subselect anywhere in it.
    SELECT pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) INTO v_check
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel AND p.polname = 'tenant_membership';
    IF v_check IS NULL THEN
      RAISE EXCEPTION '0086-E(2): %.tenant_membership lost its WITH CHECK — ALTER POLICY altered a clause this file never named', v_rel;
    END IF;
    IF v_check LIKE '%( SELECT %' THEN
      RAISE EXCEPTION '0086-E(2): %.tenant_membership WITH CHECK was rewritten too, and the write path was not measured: %', v_rel, v_check;
    END IF;

    -- 0086-E(3). The policy SET is unchanged: still the same seven, by name.
    SELECT pg_catalog.count(*) INTO v_n
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel;
    IF v_n <> 7 THEN
      RAISE EXCEPTION '0086-E(3): % carries % policies and carried 7 — this file drops and creates none', v_rel, v_n;
    END IF;

    -- 0086-E(4). The four write restrictives keep the per-row form, so the
    -- narrowness of this change is a catalogue fact and not a claim.
    SELECT pg_catalog.count(*) INTO v_n
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel
       AND p.polname IN ('business_isolation_insert', 'business_isolation_update', 'business_isolation_delete')
       AND (pg_catalog.pg_get_expr(p.polqual, p.polrelid) LIKE '%( SELECT %'
            OR pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%( SELECT %');
    IF v_n <> 0 THEN
      RAISE EXCEPTION '0086-E(4): % has % write restrictive(s) rewritten by a file that names none of them', v_rel, v_n;
    END IF;

    -- 0086-E(5). ROW SECURITY IS STILL ON AND STILL FORCED. §91 forbids a
    -- disabled or unforced policy surface, and a performance change is
    -- exactly the kind of file that could reach for one.
    SELECT pg_catalog.count(*) INTO v_n
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel
       AND c.relrowsecurity AND c.relforcerowsecurity;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '0086-E(5): % no longer has row security both ENABLED and FORCED', v_rel;
    END IF;

    -- 0086-E(6). The two internal read policies still belong to their roles.
    -- If one lost its `TO`, it would become a PUBLIC `USING (true)` — every
    -- row visible to everyone — and nothing else in this file would notice.
    SELECT pg_catalog.count(*) INTO v_n
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel
       AND p.polname IN ('inventory_internal_read', 'accounting_validator')
       AND p.polroles <> '{0}'::oid[];
    IF v_n <> 2 THEN
      RAISE EXCEPTION '0086-E(6): % has % of 2 internal read policies still restricted TO a role', v_rel, v_n;
    END IF;

  END LOOP;

  -- 0086-E(7). The three helpers keep the properties 0052 gave them. This
  -- file changes the POLICIES, not the helpers, and the exemption
  -- `policy-helper-inlining.test.ts` stands on must still hold.
  SELECT pg_catalog.count(*) INTO v_n
    FROM pg_catalog.pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('app_bypass', 'app_tenant', 'app_business')
     AND prosqlbody IS NOT NULL AND proparallel = 's' AND NOT prosecdef AND proconfig IS NULL;
  IF v_n <> 3 THEN
    RAISE EXCEPTION '0086-E(7): % of 3 policy helpers still carry 0052''s properties (sql body, parallel safe, invoker, no SET)', v_n;
  END IF;
END
$post$;
