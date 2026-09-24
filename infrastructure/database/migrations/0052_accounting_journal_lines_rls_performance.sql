-- ═══════════════════════════════════════════════════════════════════════════
-- 0052 — the accounting read path: the same boundary, a different shape.
--
-- Three policy helpers the planner could not see through, and six policies
-- across `journal_lines`, `journal_entries` and `accounts` that compared a
-- cast column instead of the column. Nothing else.
--
-- P2-S8 measured the whole-business trial balance missing its 500 ms budget
-- and diagnosed the cause to the SHAPE of one row-level security policy
-- rather than to the query, the data or the join order. Same SQL, same rows,
-- same machine: 437.7 ms and 67,866 shared blocks with the policy evaluated,
-- 12.9 ms and 724 blocks without it — 34x the time and 94x the reads. Five
-- query-level rewrites were measured; every one returned byte-identical rows
-- and every one read exactly the same 67,866 blocks.
--
-- THE CAUSE. `tenant_membership` on `journal_lines` was written in 0042 as
--
--     EXISTS (SELECT 1 FROM businesses b
--              WHERE b.id = journal_lines.business_id
--                AND b.tenant_id::text = app_tenant())
--
-- and PostgreSQL plans that correlated EXISTS as a subplan evaluated ONCE PER
-- JOURNAL LINE. On `journal_entries` the planner hashes the same expression
-- once; on `journal_lines`, where the row count is an order of magnitude
-- larger, it does not. That difference is the whole defect.
--
-- ── WHY THE REPLACEMENT IS THE SAME BOUNDARY, NOT A WEAKER ONE ────────────
--
-- This is not "it looks equivalent". It is a consequence of two invariants
-- the database already enforces, and it holds only because BOTH of them do:
--
--   (1) `journal_lines_tenant_business_fk` (0042):
--           FOREIGN KEY (tenant_id, business_id)
--           REFERENCES businesses (tenant_id, id)
--       Every journal line that exists therefore PROVES that a `businesses`
--       row with exactly its `(tenant_id, business_id)` pair exists. The
--       EXISTS above can never fail to find a row for a valid line; it can
--       only report whether the row it finds belongs to `app_tenant()`.
--
--   (2) `businesses.id` is a single-column PRIMARY KEY (0003). There is
--       therefore at most ONE `businesses` row for a given `business_id`, so
--       "the business with this id" is unambiguous: the row the FK points at
--       is the only row the EXISTS could ever match.
--
-- Together: for any row of `journal_lines`, the unique business named by
-- `business_id` has `tenant_id = journal_lines.tenant_id`. So
--
--     EXISTS (… b.id = journal_lines.business_id
--               AND b.tenant_id::text = app_tenant())
--   ≡ journal_lines.tenant_id::text = app_tenant()
--
-- The membership and the pairing do not need to be looked up again per row;
-- they were established when the row was written, and the FK is what keeps
-- them established.
--
-- The same argument, and only that argument, extends to the other two tables
-- section 2 corrects, because each carries the same composite foreign key:
-- `journal_entries_tenant_business_fk` (0042) and `accounts_tenant_business_fk`
-- (0040). Three tables, three foreign keys, one proof repeated — not one proof
-- generalised. Section 3 asserts each of the three by name against the live
-- catalogue, and `gate:phase2:s8` asserts, over the whole migration history,
-- that no later file drops, disables or un-validates any of them. **The optimisation is a consequence of the FK, so the FK
-- is now load-bearing for isolation and not only for referential integrity.**
-- That dependency is asserted below at apply time, asserted again at run time
-- by `tests/security/journal-lines-rls-policy.test.ts`, and asserted a third
-- time, statically over the migration history, by `gate:phase2:s8` — because
-- a future migration that dropped or invalidated the FK would silently turn a
-- proof into an assumption.
--
-- ── THAT DIAGNOSIS WAS INCOMPLETE, AND THE MEASUREMENT SAYS SO ───────────
--
-- The paragraphs above are the original P2-S8 finding, and they are kept
-- because they are true: the correlated subplan is real and this file removes
-- it. But re-measuring at the ACCEPTANCE scale — 104,478 lines rather than
-- the 21,614 the first diagnosis used — refuted it as THE cause. With the
-- subplan gone the report was no faster at all: 1,048 ms before, 1,285 ms
-- after, 118,828 shared blocks against 118,827. The same read as a superuser,
-- where PostgreSQL applies no policy whatsoever, took 56.7 ms and 3,492
-- blocks. Row-level security, not the subplan, was costing thirty-four times
-- the query.
--
-- Two further causes were then isolated, each with its own measurement, and
-- they are what sections 1 and 2 address. Neither is the subplan, and neither
-- could be seen by reading the policy: one is a function attribute, the other
-- is a cast. Sections 1 and 2 state each one with the numbers that found it.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ─────────────────────────
--
-- It does not weaken a boundary. `business_isolation` stays RESTRICTIVE on
-- every table it touches, ENABLE and FORCE RLS are untouched,
-- `accounting_validator`, `accounting_writer` and `accounting_seeder` are
-- untouched, and `app_bypass()` still exempts exactly one principal. It adds
-- no bypass, no SECURITY DEFINER read path and no exemption for reports.
--
-- It does not touch `accounting_source_bindings`, `accounting_periods`,
-- `accounting_period_operations` or any Phase 1 table. They carry the same
-- written shape as the three corrected here, and changing them "for
-- consistency" would be changing security boundaries on no measurement at
-- all. The trial balance reads `accounts`, `journal_entries` and
-- `journal_lines`; those three are corrected because the measurement in
-- section 2 shows the correction is worthless — literally worse than doing
-- nothing — unless all three are corrected together.
--
-- It creates no table, no column, no index, no policy, no role and no grant,
-- and it creates no routine: the three helpers are REPLACED, keeping their
-- owner, their privileges, their signatures and their SECURITY INVOKER
-- status, all of which section 3 compares against the values captured before
-- section 1 runs. A performance problem is not permission to widen anything.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────
-- 0. What the catalogue looks like BEFORE this migration touches it.
--
-- Recorded in transaction-local settings rather than a temporary table: a
-- temp table would need a privilege the migration principal is not required
-- to hold, and asking for one to run an assertion would be exactly the kind
-- of convenience-driven widening P2-S1 forbade. These three numbers are
-- compared against the same three at the end, which is how this file proves
-- it added no relation, no routine and no privilege of any kind.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM set_config('daftar.s8_pre_relations',
    (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'), true);
  PERFORM set_config('daftar.s8_pre_routines',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'), true);
  -- `cardinality` counts the entries of each ACL directly. A NULL acl is the
  -- default (no explicit grant at all) and `sum` skips it, which is why this
  -- is written as a sum of lengths rather than as a row count over
  -- `aclexplode`: that function refuses a zero-dimensional array, and the
  -- default ACL is exactly that.
  PERFORM set_config('daftar.s8_pre_table_acl',
    (SELECT coalesce(sum(cardinality(c.relacl)), 0)::text
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'), true);
  PERFORM set_config('daftar.s8_pre_column_acl',
    (SELECT coalesce(sum(cardinality(att.attacl)), 0)::text
       FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'), true);
  PERFORM set_config('daftar.s8_pre_routine_acl',
    (SELECT coalesce(sum(cardinality(p.proacl)), 0)::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'), true);
  -- The three policy helpers, in the one respect this file is NOT allowed to
  -- change them: who owns them, who may execute them, whether they run as
  -- their definer, and what they are called with and return. Section 3
  -- compares this string against the same string afterwards, so a
  -- `CREATE OR REPLACE` that quietly reset an ACL or changed a signature
  -- cannot commit.
  -- The six policies this file reshapes, in the one respect it is NOT allowed
  -- to change them: WHICH PRINCIPALS each half admits.
  --
  -- This exists because the first draft of this migration got it wrong. It was
  -- written from `0042`, which created these policies — and `0045` had since
  -- ALTERed two of them, adding the writer clause to their WITH CHECK so the
  -- posting authority could insert at all. Rewriting them from the creating
  -- migration silently removed that clause and the ledger became unwritable.
  -- The live catalogue is the authority on what a policy says; a migration
  -- that reshapes one asserts that it read the live catalogue, and this is
  -- that assertion. A term dropped or a term added fails the apply.
  PERFORM set_config('daftar.s8_pre_policies',
    (SELECT string_agg(
              format('%s.%s|%s|%s|bypass:%s%s|internal:%s%s',
                     c.relname, p.polname,
                     CASE WHEN p.polpermissive THEN 'P' ELSE 'R' END, p.polcmd,
                     position('app_bypass()' in coalesce(pg_get_expr(p.polqual, p.polrelid), '')) > 0,
                     position('app_bypass()' in coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0,
                     position('daftar_accounting_internal' in coalesce(pg_get_expr(p.polqual, p.polrelid), '')) > 0,
                     position('daftar_accounting_internal' in coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0),
              E'\n' ORDER BY c.relname, p.polname)
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      WHERE c.relname IN ('journal_lines', 'journal_entries', 'accounts')
        AND p.polname IN ('tenant_membership', 'business_isolation')), true);
  PERFORM set_config('daftar.s8_pre_helpers',
    (SELECT string_agg(
              format('%s|%s|%s|%s|%s|%s', p.proname, p.proowner::regrole,
                     coalesce(p.proacl::text, '-'), p.prosecdef, p.pronargs, p.prorettype::regtype),
              E'\n' ORDER BY p.proname)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('app_bypass', 'app_tenant', 'app_business')), true);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. THE HELPERS THE PLANNER COULD NOT SEE THROUGH.
--
-- Measured, not assumed. On 104,478 journal lines, as a superuser so that no
-- policy is applied and the clause under test is the ONLY difference between
-- one reading and the next:
--
--     no predicate                                          10.4 ms
--     tenant_id::text = <bound parameter>                    26.7 ms
--     tenant_id::text = current_setting('app.tenant_id')     45.8 ms
--     tenant_id::text = app_tenant()                        215.3 ms
--
-- The third and fourth lines run THE SAME `current_setting` call. Wrapping it
-- in `app_tenant()` costs 1.56 microseconds per row more, ten times what the
-- call itself costs, because PostgreSQL never inlines the wrapper: all three
-- helpers carry `proconfig = {search_path=…}`, and `inline_function()`
-- refuses outright to inline ANY function with a SET clause. `EXPLAIN
-- (VERBOSE)` shows the filter still naming `app_bypass()`, `app_tenant()` and
-- `app_business()` rather than their bodies. Four such calls per journal line
-- — the permissive tenant policy and the restrictive business one — is where
-- the report's second was going.
--
-- ── THE CORRECTION REMOVES THE NEED FOR THE CLAUSE, NOT THE PROTECTION ───
--
-- `SET search_path` is there so a caller cannot make a name inside these
-- bodies resolve somewhere of their choosing. Deleting it and leaving the
-- bodies as they are would be a real weakening. So the bodies stop containing
-- a name that could be captured at all:
--
--   * the SQL-standard body form (`RETURN …` rather than `AS $$ … $$`) is
--     parsed and RESOLVED WHEN THE FUNCTION IS CREATED and stored as a parse
--     tree in `pg_proc.prosqlbody`. There is no name resolution left to do at
--     call time, so there is nothing for any `search_path` to influence;
--   * and every name is schema-qualified anyway — `pg_catalog.current_setting`,
--     `OPERATOR(pg_catalog.=)`, `pg_catalog.name` — so the same holds even for
--     a reader who does not want to rely on the first point.
--
-- That is strictly stronger than pinning a path, which only fixes the order
-- names are looked up in. `tests/security/policy-helper-inlining.test.ts`
-- asserts the whole set against the live catalogue, permanently.
--
-- PARALLEL SAFE is the second half. An unmarked function is PARALLEL UNSAFE,
-- and a parallel-unsafe function inside a row-level security expression makes
-- the WHOLE plan parallel-unsafe: with these three unmarked, no query any
-- runtime role issues against an RLS-protected table can ever use a worker.
-- What they read is the session's own GUCs and its authenticated role, both
-- of which PostgreSQL copies into every parallel worker, so SAFE is a
-- statement of fact about them and not a relaxation.
--
-- Behaviour, volatility, argument list, return type, owner, ACL and
-- SECURITY INVOKER status are all unchanged, and section 3 asserts each of
-- those against the values captured before this runs.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_tenant() RETURNS TEXT
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN pg_catalog.current_setting('app.tenant_id', true);

CREATE OR REPLACE FUNCTION app_business() RETURNS TEXT
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN pg_catalog.current_setting('app.business_id', true);

CREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN CURRENT_USER OPERATOR(pg_catalog.=) 'daftar_platform'::pg_catalog.name;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. THE POLICIES: THE SAME BOUNDARY, COMPARED AS UUID.
--
-- Two changes per table, and the second one is the reason the first is not
-- enough on its own.
--
--   THE TENANT POLICY drops the correlated `businesses` lookup for the
--   line's own `tenant_id`, which is sound for the reason proved above and
--   asserted below: the composite foreign key means the pair was checked when
--   the row was written, and `businesses.id` being a single-column primary
--   key means one `business_id` names exactly one tenant.
--
--   BOTH POLICIES STOP CASTING THE COLUMN. `tenant_id::text = app_tenant()`
--   compares an expression, and PostgreSQL has no statistics for an
--   expression, so it falls back to a blind default: it estimated 522 rows
--   out of 104,478. Comparing uuid to uuid — casting the SETTING once instead
--   of every row — keeps the column's real statistics and estimated 104,464.
--   That estimate is what decides the join, and a wrong one by two orders of
--   magnitude is what produced a nested loop over 29,000 entries reading
--   118,827 blocks where 4,379 were needed.
--
--   `nullif(…, '')` preserves the accepted behaviour for an unscoped caller:
--   `current_setting(…, true)` answers the empty string when nothing is set,
--   `nullif` turns that into NULL, and `tenant_id = NULL` is NULL, so the row
--   stays invisible — the same answer the text comparison gave, by the same
--   reasoning. A scope that is set to something that is not a uuid at all now
--   RAISES instead of quietly matching nothing; that is a refusal, not a
--   disclosure, and it is the Zero Silent Errors answer to a caller sending a
--   malformed scope.
--
-- ── WHY THREE TABLES AND NOT ONE ─────────────────────────────────────────
--
-- Because the partial corrections were measured, and they are WORSE than
-- doing nothing. Whole-business trial balance, 104,478 lines, one machine,
-- one dataset, identical rows returned at every stage:
--
--     as shipped                                   1,289.9 ms  118,827 blocks
--     + journal_lines tenant as uuid               1,226.3 ms  118,827
--     + inlinable helpers                          3,503.9 ms  171,633
--     + journal_lines business as uuid               484.2 ms  118,827
--     + journal_entries                            2,896.6 ms   74,340
--     + accounts                                     152.0 ms    4,379
--
-- Every intermediate state leaves one table estimating correctly beside
-- another estimating blindly, and the planner's answer to that mixture is a
-- plan worse than either. The correction is not divisible: the trial balance
-- reads `accounts`, `journal_entries` and `journal_lines` in one statement,
-- and the estimate has to be right on all three or the join it chooses is
-- wrong. `accounting_source_bindings`, `accounting_periods` and
-- `accounting_period_operations` are NOT touched: they are not in this read,
-- nothing measured says they cost anything, and section 3 asserts they still
-- carry the original shape.
--
-- ALTER POLICY, not DROP and CREATE: each policy keeps its identity, its
-- permissive or restrictive nature and its command scope, and there is no
-- instant inside the transaction at which a table is unprotected.
-- ─────────────────────────────────────────────────────────────────────────
ALTER POLICY tenant_membership ON journal_lines
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);

ALTER POLICY business_isolation ON journal_lines
  USING      (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid);

ALTER POLICY tenant_membership ON journal_entries
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);

ALTER POLICY business_isolation ON journal_entries
  USING      (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid);

ALTER POLICY tenant_membership ON accounts
  USING      (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)
  WITH CHECK (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid);

ALTER POLICY business_isolation ON accounts
  USING      (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid)
  WITH CHECK (app_bypass() OR current_user = 'daftar_accounting_internal' OR business_id = nullif(app_business(), '')::uuid);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The migration refuses to commit unless the database it produced is the
--    one this file describes (§19). Zero Silent Errors: every failure below
--    rolls the whole file back.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count   INTEGER;
  v_table   TEXT;
  v_expected INTEGER;
  v_text    TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['journal_lines', 'journal_entries', 'accounts'] LOOP
    -- (a) Row level security is still on, and still forced for the owner.
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = v_table::regclass AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: RLS is not both ENABLED and FORCED on %', v_table;
    END IF;

    -- (b) The tenant policy still exists, is still PERMISSIVE and still covers
    --     every command. A policy narrowed to SELECT here would have quietly
    --     removed the WITH CHECK half of the boundary.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
       WHERE polrelid = v_table::regclass AND polname = 'tenant_membership'
         AND polpermissive AND polcmd = '*' AND polqual IS NOT NULL AND polwithcheck IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: tenant_membership on % must remain a PERMISSIVE ALL policy with both USING and WITH CHECK', v_table;
    END IF;

    -- (c) The RESTRICTIVE half is still restrictive. The tenant policy was
    --     never the whole boundary: business scoping is a separate rule, and
    --     making both halves cheaper must not have turned one permissive.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
       WHERE polrelid = v_table::regclass AND polname = 'business_isolation'
         AND NOT polpermissive AND polcmd = '*' AND polqual IS NOT NULL AND polwithcheck IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: business_isolation on % is missing, no longer restrictive, or lost a half', v_table;
    END IF;
  END LOOP;

  -- (a2) THE HELPERS ARE CHEAP NOW, AND NOTHING ELSE ABOUT THEM MOVED.
  --      `prosqlbody` is the property that matters and the one a reader
  --      cannot see in the file: it is only non-null for the SQL-standard
  --      body form, whose names are resolved when the function is created,
  --      which is what makes the SET clause unnecessary rather than merely
  --      absent. `proconfig IS NULL` is what lets PostgreSQL inline it.
  FOR v_text IN SELECT unnest(ARRAY['app_bypass', 'app_tenant', 'app_business']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_text
         AND p.proconfig IS NULL AND p.prosqlbody IS NOT NULL
         AND p.proparallel = 's' AND p.provolatile = 's' AND NOT p.prosecdef
    ) THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: % is not the inlinable, parallel-safe, STABLE, SECURITY INVOKER helper this migration installs', v_text;
    END IF;
  END LOOP;
  -- And the bodies still say what they always said. Read from the catalogue,
  -- not from this file's own text.
  IF pg_get_function_sqlbody('app_tenant()'::regprocedure) NOT LIKE '%app.tenant_id%'
     OR pg_get_function_sqlbody('app_business()'::regprocedure) NOT LIKE '%app.business_id%' THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: a scope helper no longer reads its own setting';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['journal_lines', 'journal_entries', 'accounts'] LOOP
    -- (d) THE SHAPE IS ACTUALLY GONE. Asked of pg_depend, which is what
    --     PostgreSQL itself records when a policy expression reads a table —
    --     not of a pattern over the rendered text, which would be a test of
    --     whitespace.
    SELECT count(*) INTO v_count
      FROM pg_depend d JOIN pg_policy p ON p.oid = d.objid
     WHERE d.classid = 'pg_policy'::regclass
       AND p.polrelid = v_table::regclass AND p.polname = 'tenant_membership'
       AND d.refclassid = 'pg_class'::regclass AND d.refobjid = 'businesses'::regclass;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: the tenant policy on % still depends on businesses (% dependencies) — the correlated lookup was not removed', v_table, v_count;
    END IF;

    -- (e) …and the isolation now derives from the row's own tenant_id.
    SELECT count(*) INTO v_count
      FROM pg_depend d
      JOIN pg_policy p ON p.oid = d.objid
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE d.classid = 'pg_policy'::regclass
       AND p.polrelid = v_table::regclass AND p.polname = 'tenant_membership'
       AND d.refclassid = 'pg_class'::regclass AND d.refobjid = v_table::regclass
       AND a.attname = 'tenant_id';
    IF v_count = 0 THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: the tenant policy on % does not depend on its own tenant_id', v_table;
    END IF;

    -- (f) THE FOUNDATION. The equivalence above is a consequence of this
    --     constraint and of businesses.id being a single-column primary key.
    --     If either is not in force, this migration has not made the read
    --     cheaper — it has made it wrong, and must not commit.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = v_table::regclass
         AND conname = v_table || '_tenant_business_fk'
         AND contype = 'f' AND convalidated
         AND confrelid = 'businesses'::regclass
    ) THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: %_tenant_business_fk is missing, is not a foreign key, or is NOT VALID — the optimised policy has no foundation', v_table;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'businesses'::regclass AND contype = 'p' AND array_length(conkey, 1) = 1
       AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = conrelid AND a.attnum = conkey[1]) = 'id'
  ) THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: businesses.id is not a single-column PRIMARY KEY — one business_id would no longer name one tenant';
  END IF;

  -- (g) NOTHING ELSE WAS OPTIMISED. Only the three tables the trial balance
  --     actually reads were measured, so only those three are changed; the
  --     rest keep the written shape. This assertion is the mechanical form of
  --     "change only what measurement justifies".
  FOREACH v_table IN ARRAY ARRAY['accounting_source_bindings', 'accounting_periods', 'accounting_period_operations'] LOOP
    SELECT count(*) INTO v_count
      FROM pg_depend d JOIN pg_policy p ON p.oid = d.objid
     WHERE d.classid = 'pg_policy'::regclass
       AND p.polrelid = v_table::regclass AND p.polname = 'tenant_membership'
       AND d.refclassid = 'pg_class'::regclass AND d.refobjid = 'businesses'::regclass;
    IF v_count = 0 THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: the tenant policy on % was changed — it was never measured and is not part of this correction', v_table;
    END IF;
  END LOOP;

  -- (h) The bypass contract is exactly what 0032 set: one principal, named,
  --     and nobody gained BYPASSRLS on the way past. The body is read from
  --     the catalogue, so a replacement that widened it cannot pass by being
  --     spelled differently in this file.
  IF pg_get_function_sqlbody('app_bypass()'::regprocedure) NOT LIKE '%daftar_platform%' THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: app_bypass() no longer names daftar_platform as its exempt principal';
  END IF;
  SELECT count(*) INTO v_count
    FROM regexp_matches(pg_get_function_sqlbody('app_bypass()'::regprocedure), 'daftar_[a-z_]+', 'g') AS m
   WHERE m[1] <> 'daftar_platform';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: app_bypass() names % principal(s) besides daftar_platform', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'daftar\_%' AND rolbypassrls) THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: a DAFTAR role holds BYPASSRLS';
  END IF;

  -- (i) THE JOURNAL STILL HAS NO WRITER BY CREDENTIAL (AL-03). The end state
  --     0045 established, restated here as an equality rather than a floor:
  --     apart from the table's own owner — which is the deployment principal,
  --     not a runtime credential — the ONLY write privilege anywhere on the
  --     three journal tables is the INSERT that `daftar_accounting_internal`
  --     holds, and that principal is NOLOGIN and passwordless, so no
  --     credential reaches it. No UPDATE, no DELETE and no TRUNCATE exists
  --     for anyone: a posted line is never revised, it is reversed.
  FOR v_table IN SELECT unnest(ARRAY['journal_entries', 'journal_lines', 'accounting_source_bindings']) LOOP
    SELECT CASE
             WHEN c.relacl IS NULL THEN 0
             ELSE (SELECT count(*) FROM aclexplode(c.relacl) a
                    WHERE a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
                      AND a.grantee <> c.relowner
                      AND NOT (a.grantee = to_regrole('daftar_accounting_internal')::oid AND a.privilege_type = 'INSERT'))
           END
      INTO v_count
      FROM pg_class c
     WHERE c.oid = v_table::regclass;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: % carries % unexpected write grant(s) — the journal has no writer by credential (AL-03)', v_table, v_count;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal' AND rolcanlogin) THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: daftar_accounting_internal can log in — the one INSERT grant would become reachable by credential';
  END IF;

  -- (j) NOTHING WAS ADDED. The counts taken before the first statement,
  --     compared with the same counts now: no relation, no routine, no table
  --     grant, no column grant and no routine grant appeared or disappeared.
  --     This file rewrites six policy expressions and replaces three function
  --     bodies. That is the whole of it: every other property of the schema,
  --     including who owns what and who may do what, is asserted below to be
  --     exactly what it was a moment ago.
  v_expected := current_setting('daftar.s8_pre_relations')::int;
  SELECT count(*) INTO v_count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public';
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: relation count changed from % to % — this migration must create and drop nothing', v_expected, v_count;
  END IF;

  v_expected := current_setting('daftar.s8_pre_routines')::int;
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: routine count changed from % to % — the three helpers are REPLACED, so no routine may appear or disappear', v_expected, v_count;
  END IF;

  -- …and replacing them changed nothing a reader would care about apart from
  -- how they are planned: same owner, same ACL, same SECURITY INVOKER, same
  -- signature, same return type, for all three.
  SELECT string_agg(
           format('%s|%s|%s|%s|%s|%s', p.proname, p.proowner::regrole,
                  coalesce(p.proacl::text, '-'), p.prosecdef, p.pronargs, p.prorettype::regtype),
           E'\n' ORDER BY p.proname)
    INTO v_text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('app_bypass', 'app_tenant', 'app_business');
  IF v_text IS DISTINCT FROM current_setting('daftar.s8_pre_helpers') THEN
    RAISE EXCEPTION E'accounting.journal_lines_rls_invalid: a policy helper''s owner, privileges, definer status or signature changed.\nbefore:\n%\nafter:\n%',
      current_setting('daftar.s8_pre_helpers'), v_text;
  END IF;

  -- …and the six policies still admit exactly the principals they admitted.
  -- Same permissive/restrictive nature, same command scope, same `app_bypass()`
  -- term in the same halves, same `daftar_accounting_internal` term in the same
  -- halves. Only the comparison changed.
  SELECT string_agg(
           format('%s.%s|%s|%s|bypass:%s%s|internal:%s%s',
                  c.relname, p.polname,
                  CASE WHEN p.polpermissive THEN 'P' ELSE 'R' END, p.polcmd,
                  position('app_bypass()' in coalesce(pg_get_expr(p.polqual, p.polrelid), '')) > 0,
                  position('app_bypass()' in coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0,
                  position('daftar_accounting_internal' in coalesce(pg_get_expr(p.polqual, p.polrelid), '')) > 0,
                  position('daftar_accounting_internal' in coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0),
           E'\n' ORDER BY c.relname, p.polname)
    INTO v_text
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname IN ('journal_lines', 'journal_entries', 'accounts')
     AND p.polname IN ('tenant_membership', 'business_isolation');
  IF v_text IS DISTINCT FROM current_setting('daftar.s8_pre_policies') THEN
    RAISE EXCEPTION E'accounting.journal_lines_rls_invalid: a reshaped policy admits a different set of principals than it did before this file ran.\nbefore:\n%\nafter:\n%',
      current_setting('daftar.s8_pre_policies'), v_text;
  END IF;

  v_expected := current_setting('daftar.s8_pre_table_acl')::int;
  SELECT coalesce(sum(cardinality(c.relacl)), 0) INTO v_count
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public';
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: table privilege count changed from % to % — no grant is issued or revoked here', v_expected, v_count;
  END IF;

  v_expected := current_setting('daftar.s8_pre_column_acl')::int;
  SELECT coalesce(sum(cardinality(att.attacl)), 0) INTO v_count
    FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public';
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: column privilege count changed from % to % — the reconciler''s column grants are 0051''s business, not this file''s', v_expected, v_count;
  END IF;

  v_expected := current_setting('daftar.s8_pre_routine_acl')::int;
  SELECT coalesce(sum(cardinality(p.proacl)), 0) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public';
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: routine EXECUTE count changed from % to % — no new function EXECUTE is introduced here', v_expected, v_count;
  END IF;
END $$;
