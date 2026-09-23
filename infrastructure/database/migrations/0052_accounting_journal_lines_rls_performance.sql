-- ═══════════════════════════════════════════════════════════════════════════
-- 0052 — journal_lines tenant policy: the same boundary, a different shape.
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
-- them established. **The optimisation is a consequence of the FK, so the FK
-- is now load-bearing for isolation and not only for referential integrity.**
-- That dependency is asserted below at apply time, asserted again at run time
-- by `tests/security/journal-lines-rls-policy.test.ts`, and asserted a third
-- time, statically over the migration history, by `gate:phase2:s8` — because
-- a future migration that dropped or invalidated the FK would silently turn a
-- proof into an assumption.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ─────────────────────────
--
-- It does not touch `business_isolation` (still RESTRICTIVE, still the second
-- half of the boundary), `accounting_validator`, `accounting_writer`, FORCE
-- RLS, ENABLE RLS, `app_bypass()`, `app_tenant()` or `app_business()`. It adds
-- no bypass, no SECURITY DEFINER read path and no exemption for reports.
--
-- It does not change the corresponding policy on `journal_entries`,
-- `accounting_source_bindings`, `accounts`, `accounting_periods`,
-- `accounting_period_operations` or any Phase 1 table. Those carry the same
-- written shape, and changing them "for consistency" would be changing six
-- security boundaries on the strength of one measurement. Only what was
-- measured is changed; if another policy is ever proved independently
-- pathological, that is its own measured decision.
--
-- It creates no table, no column, no index, no routine and no grant. A
-- performance problem is not permission to widen anything.
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
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The one authorized change.
--
-- ALTER POLICY, not DROP and CREATE: the policy keeps its identity, its
-- PERMISSIVE nature and its command scope, and there is no instant inside the
-- transaction at which `journal_lines` has no tenant policy at all.
-- ─────────────────────────────────────────────────────────────────────────
ALTER POLICY tenant_membership ON journal_lines
  USING (app_bypass() OR tenant_id::text = app_tenant())
  WITH CHECK (app_bypass() OR tenant_id::text = app_tenant());

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The migration refuses to commit unless the database it produced is the
--    one this file describes (§19). Zero Silent Errors: every failure below
--    rolls the whole file back.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count   INTEGER;
  v_table   TEXT;
  v_expected INTEGER;
BEGIN
  -- (a) Row level security is still on, and still forced for the owner.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'journal_lines'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: RLS is not both ENABLED and FORCED on journal_lines';
  END IF;

  -- (b) The tenant policy still exists, is still PERMISSIVE and still covers
  --     every command. A policy narrowed to SELECT here would have quietly
  --     removed the WITH CHECK half of the boundary.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'journal_lines'::regclass AND polname = 'tenant_membership'
       AND polpermissive AND polcmd = '*' AND polqual IS NOT NULL AND polwithcheck IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: tenant_membership must remain a PERMISSIVE ALL policy with both USING and WITH CHECK';
  END IF;

  -- (c) The RESTRICTIVE half is untouched. The tenant policy was never the
  --     whole boundary: business scoping is a separate, restrictive rule, and
  --     making the permissive half cheaper must not have removed it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'journal_lines'::regclass AND polname = 'business_isolation'
       AND NOT polpermissive AND polcmd = '*'
  ) THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: the RESTRICTIVE business_isolation policy is missing or no longer restrictive';
  END IF;

  -- (d) THE SHAPE IS ACTUALLY GONE. Asked of pg_depend, which is what
  --     PostgreSQL itself records when a policy expression reads a table —
  --     not of a pattern over the rendered text, which would be a test of
  --     whitespace.
  SELECT count(*) INTO v_count
    FROM pg_depend d JOIN pg_policy p ON p.oid = d.objid
   WHERE d.classid = 'pg_policy'::regclass
     AND p.polrelid = 'journal_lines'::regclass AND p.polname = 'tenant_membership'
     AND d.refclassid = 'pg_class'::regclass AND d.refobjid = 'businesses'::regclass;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: the tenant policy still depends on businesses (% dependencies) — the correlated lookup was not removed', v_count;
  END IF;

  -- (e) …and the isolation now derives from the line's own tenant_id.
  SELECT count(*) INTO v_count
    FROM pg_depend d
    JOIN pg_policy p ON p.oid = d.objid
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.classid = 'pg_policy'::regclass
     AND p.polrelid = 'journal_lines'::regclass AND p.polname = 'tenant_membership'
     AND d.refclassid = 'pg_class'::regclass AND d.refobjid = 'journal_lines'::regclass
     AND a.attname = 'tenant_id';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: the tenant policy does not depend on journal_lines.tenant_id';
  END IF;

  -- (f) THE FOUNDATION. The equivalence above is a consequence of this
  --     constraint and of businesses.id being a single-column primary key.
  --     If either is not in force, this migration has not made the read
  --     cheaper — it has made it wrong, and must not commit.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'journal_lines'::regclass
       AND conname = 'journal_lines_tenant_business_fk'
       AND contype = 'f' AND convalidated
       AND confrelid = 'businesses'::regclass
  ) THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: journal_lines_tenant_business_fk is missing, is not a foreign key, or is NOT VALID — the optimised policy has no foundation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'businesses'::regclass AND contype = 'p' AND array_length(conkey, 1) = 1
       AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = conrelid AND a.attnum = conkey[1]) = 'id'
  ) THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: businesses.id is not a single-column PRIMARY KEY — one business_id would no longer name one tenant';
  END IF;

  -- (g) NOTHING ELSE WAS OPTIMISED (§5). The other tables keep the written
  --     shape. This assertion is the mechanical form of "change only what
  --     measurement justifies".
  FOREACH v_table IN ARRAY ARRAY['journal_entries', 'accounting_source_bindings', 'accounts', 'accounting_periods', 'accounting_period_operations'] LOOP
    SELECT count(*) INTO v_count
      FROM pg_depend d JOIN pg_policy p ON p.oid = d.objid
     WHERE d.classid = 'pg_policy'::regclass
       AND p.polrelid = v_table::regclass AND p.polname = 'tenant_membership'
       AND d.refclassid = 'pg_class'::regclass AND d.refobjid = 'businesses'::regclass;
    IF v_count = 0 THEN
      RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: the tenant policy on % was changed — only journal_lines was measured and only journal_lines is authorized', v_table;
    END IF;
  END LOOP;

  -- (h) The bypass contract is exactly what 0032 set, and nobody gained
  --     BYPASSRLS on the way past.
  IF pg_get_functiondef('app_bypass()'::regprocedure) NOT LIKE '%daftar_platform%' THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: app_bypass() no longer names daftar_platform as its only exempt principal';
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

  -- (j) NOTHING WAS ADDED. The counts taken before the ALTER, compared with
  --     the same counts now: no relation, no routine, no table grant, no
  --     column grant and no routine grant appeared or disappeared. A
  --     migration authorized to change one policy expression changed one
  --     policy expression.
  v_expected := current_setting('daftar.s8_pre_relations')::int;
  SELECT count(*) INTO v_count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public';
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: relation count changed from % to % — this migration must create and drop nothing', v_expected, v_count;
  END IF;

  v_expected := current_setting('daftar.s8_pre_routines')::int;
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public';
  IF v_count <> v_expected THEN
    RAISE EXCEPTION 'accounting.journal_lines_rls_invalid: routine count changed from % to % — no function is created or replaced here', v_expected, v_count;
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
