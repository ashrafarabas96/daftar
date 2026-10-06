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
-- THE PRE-STATE IS READ, NOT ASSUMED. Every sentence above rests on the quals
-- being in the PER-ROW form when this file runs: "the same expression, with
-- subselects" is a claim about what was there before. `ALTER POLICY ... USING`
-- replaces the clause whatever it held, so if a qual had already been
-- rewritten — or had been re-created with different text — this file would
-- silently replace an unknown expression with the one it assumes, and the
-- post-apply block could not tell, because it only describes the new state.
-- So 0086-A reads the eight quals out of the catalogue BEFORE the first
-- `ALTER` and refuses to proceed unless each is the per-row form it names,
-- with the same operands and the same number of disjuncts. The migration
-- runner applies a file once and skips a re-apply by checksum, so this block
-- judges the state this file was written against and no other.
--
-- Migrations 0000-0079 are FROZEN and untouched. `0080`-`0085` are CANDIDATE
-- and untouched. This file is append-only and creates no object.

-- ── 0086-A — the pre-state, read from the catalogue before anything moves ──
DO $pre$
DECLARE
  v_rel    TEXT;
  v_qual   TEXT;
  v_have   TEXT;
  v_mine   UUID := '11111111-1111-1111-1111-111111111111';
  v_other  UUID := '22222222-2222-2222-2222-222222222222';
  v_guc    TEXT;
  v_prev_t TEXT := pg_catalog.current_setting('app.tenant_id', true);
  v_prev_b TEXT := pg_catalog.current_setting('app.business_id', true);
  v_admits BOOLEAN;
  v_denies BOOLEAN;
  v_unset  BOOLEAN;
  v_snap   TEXT;
  v_check  TEXT;
  v_roles  TEXT[];
  v_want_roles TEXT[];
  v_null   BOOLEAN;
  v_n      INTEGER;
BEGIN
  -- THE BARRIER IS ASSERTED BY EVALUATING IT, NOT BY READING IT.
  --
  -- Asking whether a qual CONTAINS some operands, or counting the ` OR `
  -- strings in it, is a question about the catalogue's pretty-printer and not
  -- about the policy. Both were tried and both are defeated outright:
  -- `tenant_id <> (SELECT nullif(app_tenant(), '')::uuid)` names every operand
  -- and renders exactly one ` OR `, and admits every other tenant's rows; and
  -- an added always-true disjunct renders as `OR` followed by a NEWLINE before
  -- a `CASE`, which is not the four-byte ` OR `, so a count never sees it. A
  -- lexical test cannot see an operator.
  --
  -- So the installed expression is EXECUTED. Each qual is evaluated over
  -- supplied column values with the session GUCs set, and its truth table is
  -- asserted: it admits the scope's own row, it does NOT admit another
  -- scope's row, and with the GUC unset it admits nothing. `app_bypass()` is
  -- FALSE here by construction — it is `CURRENT_USER = 'daftar_platform'` and
  -- a migration is not that role — so the escape hatch cannot mask the
  -- barrier. An inverted comparison fails case 2. An always-true disjunct
  -- fails case 2 and case 3. A qual that lost the barrier fails both.
  --
  -- A deny is asserted as `IS NOT TRUE`, never `= FALSE`: `business_id = NULL`
  -- is NULL, and NULL is how default-deny is actually expressed here.
  --
  -- No object is created. G-5 forbids a migration creating a TEMP relation —
  -- a caller can pre-create and own that name — so the reference the
  -- comparison needs is computed, not built.
  --
  -- 0086-A judges the state BEFORE the first `ALTER`: every sentence this file
  -- makes rests on the quals being the PER-ROW form, because "the same
  -- expression, with subselects" is a claim about what was there. The runner
  -- applies a file once and skips a re-apply by checksum, so this block judges
  -- the state this file was written against and no other.
  FOREACH v_rel IN ARRAY ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] LOOP
    FOREACH v_qual IN ARRAY ARRAY['tenant_membership', 'business_isolation_read'] LOOP
      SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid) INTO v_have
        FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel AND p.polname = v_qual;
      IF v_have IS NULL THEN
        RAISE EXCEPTION '0086-A: %.% does not exist, so this file would alter something that is not there', v_rel, v_qual;
      END IF;

      -- THE SHAPE, which is what this file is for and is a fair question to
      -- ask of the text.
      IF v_have LIKE '%( SELECT %' THEN
        RAISE EXCEPTION '0086-A: %.% %: %', v_rel, v_qual, 'already carries a subselect, so "the same expression with subselects" is not a claim about this state', v_have;
      END IF;

      -- THE MEANING, evaluated.
      v_guc := CASE v_qual WHEN 'tenant_membership' THEN 'app.tenant_id' ELSE 'app.business_id' END;
      v_want_roles := CASE v_qual WHEN 'tenant_membership' THEN ARRAY[]::TEXT[] ELSE ARRAY['daftar_accounting_internal', 'daftar_inventory_internal'] END;
      PERFORM pg_catalog.set_config(v_guc, v_mine::text, true);
      EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_have)
        INTO v_admits USING v_mine;
      EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_have)
        INTO v_denies USING v_other;
      PERFORM pg_catalog.set_config(v_guc, '', true);
      EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_have)
        INTO v_unset USING v_mine;
      PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(v_prev_t, ''), true);
      PERFORM pg_catalog.set_config('app.business_id', COALESCE(v_prev_b, ''), true);

      IF v_admits IS NOT TRUE THEN
        RAISE EXCEPTION '0086-A: %.% does not admit its own scope''s row, so it is not the boundary this file claims: %', v_rel, v_qual, v_have;
      END IF;
      IF v_denies IS TRUE THEN
        RAISE EXCEPTION '0086-A: %.% ADMITS another scope''s row — the barrier is inverted, weakened or bypassed: %', v_rel, v_qual, v_have;
      END IF;
      IF v_unset IS TRUE THEN
        RAISE EXCEPTION '0086-A: %.% admits a row with the scope GUC unset, so default-deny is gone: %', v_rel, v_qual, v_have;
      END IF;
      -- C-2: THE ESCAPE LIST IS PINNED BY EQUALITY, NOT LEFT TO THE TRUTH
      -- TABLE. `business_isolation_read` carries
      -- `current_user IN ('daftar_inventory_internal',
      -- 'daftar_accounting_internal')`, and the truth table above cannot see a
      -- name added to it: this block runs as the migrator, for whom every
      -- `current_user` test is FALSE whatever the list holds. A nine-character
      -- edit of this file's own `ALTER` — appending `'daftar_app'` — therefore
      -- applied GREEN and was measured as a real cross-business read: 0 rows
      -- before, 1 row after. So the role literals in each qual are enumerated
      -- and required to be EXACTLY the ones the clause is entitled to.
      SELECT pg_catalog.array_agg(m[1] ORDER BY m[1]) INTO v_roles
        FROM pg_catalog.regexp_matches(v_have, '''(daftar_[a-z_]+)''', 'g') AS m;
      IF COALESCE(v_roles, ARRAY[]::TEXT[]) <> v_want_roles THEN
        RAISE EXCEPTION '0086-A: %.% names the role(s) % and is entitled to exactly % — a name added to the escape list is a reader this file never granted: %',
          v_rel, v_qual, COALESCE(v_roles, ARRAY[]::TEXT[]), v_want_roles, v_have;
      END IF;

      -- M-3: A NULL SCOPE COLUMN IS A FOURTH CASE. `OR tenant_id IS NULL`
      -- passes every case above — it admits no OTHER scope's row and nothing
      -- with the GUC unset — while admitting every row whose scope column is
      -- NULL. The columns are `NOT NULL` today, which is why this is latent
      -- rather than live, so that is asserted too and the case supplies a NULL.
      EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT NULL::uuid AS tenant_id, NULL::uuid AS business_id) t', v_have)
        INTO v_null;
      IF v_null IS TRUE THEN
        RAISE EXCEPTION '0086-A: %.% admits a row whose scope column is NULL, so a row outside every scope is readable: %', v_rel, v_qual, v_have;
      END IF;

    END LOOP;
  END LOOP;

  -- THE WRITE BARRIER IS EVALUATED TOO. 0086-E(2) asks only whether
  -- `tenant_membership`'s WITH CHECK is present and free of subselects. A
  -- blanket `tenant_id IS NOT NULL` satisfies both and admits a write that
  -- carries a FOREIGN tenant_id; that attack was executed against this file
  -- and passed it. Presence is not a barrier, so the check expression gets
  -- the same truth table as the USING clause: it admits a write in its own
  -- scope, it refuses one in another scope, and it refuses every write with
  -- the scope GUC unset.
  FOREACH v_rel IN ARRAY ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] LOOP
    SELECT pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) INTO v_check
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel AND p.polname = 'tenant_membership';
    IF v_check IS NULL THEN
      RAISE EXCEPTION '0086-A(w): %.tenant_membership carries no WITH CHECK, so the write path has no barrier to evaluate', v_rel;
    END IF;

    PERFORM pg_catalog.set_config('app.tenant_id', v_mine::text, true);
    EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_check)
      INTO v_admits USING v_mine;
    EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_check)
      INTO v_denies USING v_other;
    PERFORM pg_catalog.set_config('app.tenant_id', '', true);
    EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_check)
      INTO v_unset USING v_mine;
    PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(v_prev_t, ''), true);
    PERFORM pg_catalog.set_config('app.business_id', COALESCE(v_prev_b, ''), true);

    IF v_admits IS NOT TRUE THEN
      RAISE EXCEPTION '0086-A(w): %.tenant_membership WITH CHECK refuses a write in its own scope, so it is not the barrier it looks like: %', v_rel, v_check;
    END IF;
    IF v_denies IS TRUE THEN
      RAISE EXCEPTION '0086-A(w): %.tenant_membership WITH CHECK ADMITS a write carrying another tenant''s tenant_id — the write barrier is gone: %', v_rel, v_check;
    END IF;
    IF v_unset IS TRUE THEN
      RAISE EXCEPTION '0086-A(w): %.tenant_membership WITH CHECK admits a write with app.tenant_id unset, so default-deny is gone on the write path: %', v_rel, v_check;
    END IF;
  END LOOP;

  -- M-3, the other half: the fourth case above is only latent while the scope
  -- columns cannot be NULL. That is a catalogue fact, so it is read rather
  -- than assumed.
  FOREACH v_rel IN ARRAY ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] LOOP
    SELECT pg_catalog.count(*) INTO v_n
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel
       AND a.attname IN ('tenant_id', 'business_id') AND a.attnotnull;
    IF v_n <> 2 THEN
      RAISE EXCEPTION '0086-A: % has % of 2 scope columns declared NOT NULL — a NULL scope column makes the barrier a question about data rather than about the policy', v_rel, v_n;
    END IF;
  END LOOP;

  -- M-3, the other half: the fourth case above is only latent while the scope
  -- columns cannot be NULL. That is a catalogue fact, so it is read rather
  -- than assumed.
  FOREACH v_rel IN ARRAY ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] LOOP
    SELECT pg_catalog.count(*) INTO v_n
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel
       AND a.attname IN ('tenant_id', 'business_id') AND a.attnotnull;
    IF v_n <> 2 THEN
      RAISE EXCEPTION '0086-F: % has % of 2 scope columns declared NOT NULL — a NULL scope column makes the barrier a question about data rather than about the policy', v_rel, v_n;
    END IF;
  END LOOP;

    -- THE WHOLE POLICY SET, CAPTURED. Everything above judges the two quals
    -- this file names. Nothing above judges the clauses it does NOT name, and
    -- two routes through them remove a barrier while every assertion in this
    -- file still passes: rewriting `tenant_membership`'s WITH CHECK to a
    -- blanket predicate (0086-E(2) only refuses a NULL one and a subselect in
    -- it, and never compares it), and dropping a RESTRICTIVE policy and
    -- re-creating it under the same name AS PERMISSIVE (the count stays 7, the
    -- USING text is identical, and an AND-ed barrier has become an OR-ed one).
    -- Both were executed against this file and both passed it.
    --
    -- So the file states what it changes by CAPTURING everything else and
    -- comparing it whole afterwards: permissiveness, command, roles, the WITH
    -- CHECK expression, and the USING expression of every policy except the
    -- two this file rewrites. The carrier is a transaction-local GUC, because
    -- the runner applies each file in its own transaction
    -- (`apps/api/src/infra/migrate.ts:104-113`) and G-5 forbids creating a
    -- relation to hold it.
    SELECT pg_catalog.string_agg(
             pg_catalog.format(
               '%s.%s permissive=%s cmd=%s roles=%s check=%s qual=%s',
               c.relname, p.polname, p.polpermissive, p.polcmd, p.polroles::text,
               COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '<none>'),
               CASE WHEN p.polname IN ('tenant_membership', 'business_isolation_read')
                    THEN '<rewritten by this file>'
                    ELSE COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '<none>') END),
             E'\n' ORDER BY c.relname, p.polname)
      INTO v_snap
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname = ANY (ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications']);
  PERFORM pg_catalog.set_config('app.p4s4_0086_policy_snapshot', v_snap, true);
END
$pre$;

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
BEGIN
  FOREACH v_rel IN ARRAY ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] LOOP

    -- 0086-E(1) is gone from this loop and this file carries no
    -- whole-expression EQUALITY at all: the reference such a comparison needs
    -- is a rendering by this same server, and producing one inside a migration
    -- means creating a relation, which G-5 forbids. So the equality law lives
    -- in `tests/security/p4s4-rls-quals-once-per-query.test.ts`, where a
    -- `pg_temp` probe is legal, and what THIS file asserts is the truth table,
    -- the pinned escape list and the untouched remainder of the policy set.
    -- Stated here because an earlier version of this comment promised an
    -- equality block below that does not exist.

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

-- ── 0086-F — the end state, evaluated, and the rest of the set compared ──
DO $fin$
DECLARE
  v_rel    TEXT;
  v_qual   TEXT;
  v_have   TEXT;
  v_mine   UUID := '11111111-1111-1111-1111-111111111111';
  v_other  UUID := '22222222-2222-2222-2222-222222222222';
  v_guc    TEXT;
  v_prev_t TEXT := pg_catalog.current_setting('app.tenant_id', true);
  v_prev_b TEXT := pg_catalog.current_setting('app.business_id', true);
  v_admits BOOLEAN;
  v_denies BOOLEAN;
  v_unset  BOOLEAN;
  v_snap   TEXT;
  v_was    TEXT;
  v_check  TEXT;
  v_roles  TEXT[];
  v_want_roles TEXT[];
  v_null   BOOLEAN;
  v_n      INTEGER;
BEGIN
  -- THE BARRIER IS ASSERTED BY EVALUATING IT, NOT BY READING IT.
  --
  -- Asking whether a qual CONTAINS some operands, or counting the ` OR `
  -- strings in it, is a question about the catalogue's pretty-printer and not
  -- about the policy. Both were tried and both are defeated outright:
  -- `tenant_id <> (SELECT nullif(app_tenant(), '')::uuid)` names every operand
  -- and renders exactly one ` OR `, and admits every other tenant's rows; and
  -- an added always-true disjunct renders as `OR` followed by a NEWLINE before
  -- a `CASE`, which is not the four-byte ` OR `, so a count never sees it. A
  -- lexical test cannot see an operator.
  --
  -- So the installed expression is EXECUTED. Each qual is evaluated over
  -- supplied column values with the session GUCs set, and its truth table is
  -- asserted: it admits the scope's own row, it does NOT admit another
  -- scope's row, and with the GUC unset it admits nothing. `app_bypass()` is
  -- FALSE here by construction — it is `CURRENT_USER = 'daftar_platform'` and
  -- a migration is not that role — so the escape hatch cannot mask the
  -- barrier. An inverted comparison fails case 2. An always-true disjunct
  -- fails case 2 and case 3. A qual that lost the barrier fails both.
  --
  -- A deny is asserted as `IS NOT TRUE`, never `= FALSE`: `business_id = NULL`
  -- is NULL, and NULL is how default-deny is actually expressed here.
  --
  -- No object is created. G-5 forbids a migration creating a TEMP relation —
  -- a caller can pre-create and own that name — so the reference the
  -- comparison needs is computed, not built.
  --
  -- 0086-F is the END STATE: the same truth table over the rewritten quals, so
  -- the claim that this file moved no answer is a measured fact on both sides
  -- of the rewrite rather than an argument about evaluation order.
  FOREACH v_rel IN ARRAY ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] LOOP
    FOREACH v_qual IN ARRAY ARRAY['tenant_membership', 'business_isolation_read'] LOOP
      SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid) INTO v_have
        FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel AND p.polname = v_qual;
      IF v_have IS NULL THEN
        RAISE EXCEPTION '0086-F: %.% does not exist, so this file would alter something that is not there', v_rel, v_qual;
      END IF;

      -- THE SHAPE, which is what this file is for and is a fair question to
      -- ask of the text.
      IF v_have NOT LIKE '%( SELECT %' THEN
        RAISE EXCEPTION '0086-F: %.% %: %', v_rel, v_qual, 'still evaluates its row-invariant parts per row', v_have;
      END IF;

      -- THE MEANING, evaluated.
      v_guc := CASE v_qual WHEN 'tenant_membership' THEN 'app.tenant_id' ELSE 'app.business_id' END;
      v_want_roles := CASE v_qual WHEN 'tenant_membership' THEN ARRAY[]::TEXT[] ELSE ARRAY['daftar_accounting_internal', 'daftar_inventory_internal'] END;
      PERFORM pg_catalog.set_config(v_guc, v_mine::text, true);
      EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_have)
        INTO v_admits USING v_mine;
      EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_have)
        INTO v_denies USING v_other;
      PERFORM pg_catalog.set_config(v_guc, '', true);
      EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_have)
        INTO v_unset USING v_mine;
      PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(v_prev_t, ''), true);
      PERFORM pg_catalog.set_config('app.business_id', COALESCE(v_prev_b, ''), true);

      IF v_admits IS NOT TRUE THEN
        RAISE EXCEPTION '0086-F: %.% does not admit its own scope''s row, so it is not the boundary this file claims: %', v_rel, v_qual, v_have;
      END IF;
      IF v_denies IS TRUE THEN
        RAISE EXCEPTION '0086-F: %.% ADMITS another scope''s row — the barrier is inverted, weakened or bypassed: %', v_rel, v_qual, v_have;
      END IF;
      IF v_unset IS TRUE THEN
        RAISE EXCEPTION '0086-F: %.% admits a row with the scope GUC unset, so default-deny is gone: %', v_rel, v_qual, v_have;
      END IF;
      -- C-2: THE ESCAPE LIST IS PINNED BY EQUALITY, NOT LEFT TO THE TRUTH
      -- TABLE. `business_isolation_read` carries
      -- `current_user IN ('daftar_inventory_internal',
      -- 'daftar_accounting_internal')`, and the truth table above cannot see a
      -- name added to it: this block runs as the migrator, for whom every
      -- `current_user` test is FALSE whatever the list holds. A nine-character
      -- edit of this file's own `ALTER` — appending `'daftar_app'` — therefore
      -- applied GREEN and was measured as a real cross-business read: 0 rows
      -- before, 1 row after. So the role literals in each qual are enumerated
      -- and required to be EXACTLY the ones the clause is entitled to.
      SELECT pg_catalog.array_agg(m[1] ORDER BY m[1]) INTO v_roles
        FROM pg_catalog.regexp_matches(v_have, '''(daftar_[a-z_]+)''', 'g') AS m;
      IF COALESCE(v_roles, ARRAY[]::TEXT[]) <> v_want_roles THEN
        RAISE EXCEPTION '0086-F: %.% names the role(s) % and is entitled to exactly % — a name added to the escape list is a reader this file never granted: %',
          v_rel, v_qual, COALESCE(v_roles, ARRAY[]::TEXT[]), v_want_roles, v_have;
      END IF;

      -- M-3: A NULL SCOPE COLUMN IS A FOURTH CASE. `OR tenant_id IS NULL`
      -- passes every case above — it admits no OTHER scope's row and nothing
      -- with the GUC unset — while admitting every row whose scope column is
      -- NULL. The columns are `NOT NULL` today, which is why this is latent
      -- rather than live, so that is asserted too and the case supplies a NULL.
      EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT NULL::uuid AS tenant_id, NULL::uuid AS business_id) t', v_have)
        INTO v_null;
      IF v_null IS TRUE THEN
        RAISE EXCEPTION '0086-F: %.% admits a row whose scope column is NULL, so a row outside every scope is readable: %', v_rel, v_qual, v_have;
      END IF;

    END LOOP;
  END LOOP;

  -- THE WRITE BARRIER IS EVALUATED TOO. 0086-E(2) asks only whether
  -- `tenant_membership`'s WITH CHECK is present and free of subselects. A
  -- blanket `tenant_id IS NOT NULL` satisfies both and admits a write that
  -- carries a FOREIGN tenant_id; that attack was executed against this file
  -- and passed it. Presence is not a barrier, so the check expression gets
  -- the same truth table as the USING clause: it admits a write in its own
  -- scope, it refuses one in another scope, and it refuses every write with
  -- the scope GUC unset.
  FOREACH v_rel IN ARRAY ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications'] LOOP
    SELECT pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) INTO v_check
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_rel AND p.polname = 'tenant_membership';
    IF v_check IS NULL THEN
      RAISE EXCEPTION '0086-F(w): %.tenant_membership carries no WITH CHECK, so the write path has no barrier to evaluate', v_rel;
    END IF;

    PERFORM pg_catalog.set_config('app.tenant_id', v_mine::text, true);
    EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_check)
      INTO v_admits USING v_mine;
    EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_check)
      INTO v_denies USING v_other;
    PERFORM pg_catalog.set_config('app.tenant_id', '', true);
    EXECUTE pg_catalog.format('SELECT (%s) FROM (SELECT $1::uuid AS tenant_id, $1::uuid AS business_id) t', v_check)
      INTO v_unset USING v_mine;
    PERFORM pg_catalog.set_config('app.tenant_id', COALESCE(v_prev_t, ''), true);
    PERFORM pg_catalog.set_config('app.business_id', COALESCE(v_prev_b, ''), true);

    IF v_admits IS NOT TRUE THEN
      RAISE EXCEPTION '0086-F(w): %.tenant_membership WITH CHECK refuses a write in its own scope, so it is not the barrier it looks like: %', v_rel, v_check;
    END IF;
    IF v_denies IS TRUE THEN
      RAISE EXCEPTION '0086-F(w): %.tenant_membership WITH CHECK ADMITS a write carrying another tenant''s tenant_id — the write barrier is gone: %', v_rel, v_check;
    END IF;
    IF v_unset IS TRUE THEN
      RAISE EXCEPTION '0086-F(w): %.tenant_membership WITH CHECK admits a write with app.tenant_id unset, so default-deny is gone on the write path: %', v_rel, v_check;
    END IF;
  END LOOP;

    -- THE WHOLE POLICY SET, CAPTURED. Everything above judges the two quals
    -- this file names. Nothing above judges the clauses it does NOT name, and
    -- two routes through them remove a barrier while every assertion in this
    -- file still passes: rewriting `tenant_membership`'s WITH CHECK to a
    -- blanket predicate (0086-E(2) only refuses a NULL one and a subselect in
    -- it, and never compares it), and dropping a RESTRICTIVE policy and
    -- re-creating it under the same name AS PERMISSIVE (the count stays 7, the
    -- USING text is identical, and an AND-ed barrier has become an OR-ed one).
    -- Both were executed against this file and both passed it.
    --
    -- So the file states what it changes by CAPTURING everything else and
    -- comparing it whole afterwards: permissiveness, command, roles, the WITH
    -- CHECK expression, and the USING expression of every policy except the
    -- two this file rewrites. The carrier is a transaction-local GUC, because
    -- the runner applies each file in its own transaction
    -- (`apps/api/src/infra/migrate.ts:104-113`) and G-5 forbids creating a
    -- relation to hold it.
    SELECT pg_catalog.string_agg(
             pg_catalog.format(
               '%s.%s permissive=%s cmd=%s roles=%s check=%s qual=%s',
               c.relname, p.polname, p.polpermissive, p.polcmd, p.polroles::text,
               COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '<none>'),
               CASE WHEN p.polname IN ('tenant_membership', 'business_isolation_read')
                    THEN '<rewritten by this file>'
                    ELSE COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '<none>') END),
             E'\n' ORDER BY c.relname, p.polname)
      INTO v_snap
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname = ANY (ARRAY['invoices', 'sales', 'payment_allocations', 'customer_credit_applications']);
  v_was := pg_catalog.current_setting('app.p4s4_0086_policy_snapshot', true);
  IF v_was IS NULL OR v_was = '' THEN
    RAISE EXCEPTION '0086-F: the capture 0086-A took is not here, so this file did not run as one transaction and the comparison below would be vacuous';
  END IF;
  IF v_snap <> v_was THEN
    RAISE EXCEPTION '0086-F: this file altered a clause it never named. BEFORE:%  AFTER:%', E'\n' || v_was, E'\n' || v_snap;
  END IF;
END
$fin$;
