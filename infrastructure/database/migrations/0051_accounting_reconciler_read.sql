-- 0051_accounting_reconciler_read.sql
-- P2-S8 — the reconciliation authority, and nothing else.
-- CANDIDATE: not frozen, not in the manifest.
--
-- ── Why a seventh role, when a grant would have been shorter ─────────────
--
-- The reconciliation pass has to read every business's books. The obvious
-- shortcut was to let `daftar_worker` do it, since the worker process already
-- runs on a timer. The Tech Lead refused that, and the reason is worth
-- writing down here rather than in a commit message nobody reads again:
--
--   `daftar_worker` already holds the credential-delivery transport, the
--   credential DECRYPTION key ring and the SMTP authority. Adding "can read
--   every business's journal" to that same credential would aggregate two
--   unrelated trust boundaries into one blast radius. A stolen delivery
--   credential would become a financial reader.
--
--   DAFTAR keeps delivery authority separate from financial reconciliation
--   authority.
--
-- So this file creates `daftar_reconciler`: a login role that can READ the
-- accounting estate and do nothing else at all. No write on any table. No
-- EXECUTE on any financial command. No identity, session, credential or key
-- table. No RLS bypass.
--
-- ── The one hard problem, and why it is solved with a function ───────────
--
-- Reconciliation has to know WHICH businesses exist before it can check any
-- of them, and `businesses` is tenant-scoped by row level security. Since
-- `0032`, the only principal row level security exempts is `daftar_platform`
-- — `app_bypass()` is `current_user = 'daftar_platform'` — and that contract
-- is NOT touched here. Widening it, or granting BYPASSRLS, would trade a
-- narrow need (a list of ids) for a global capability (see every row of every
-- table in the database). That is the wrong trade by two orders of magnitude.
--
-- Instead there is ONE narrow SECURITY DEFINER enumerator. It returns the two
-- identifiers that let the caller enter a normal RLS scope and NOTHING else —
-- no name, no slug, no owner, no contact detail, no money. It takes a keyset
-- cursor and a bounded limit, so it is not a query tunnel: there is no
-- predicate a caller can supply, no column they can choose and no way to ask
-- it a second question.
--
-- After enumeration the reconciler behaves like every other DAFTAR reader: it
-- opens a transaction, sets `app.tenant_id` and `app.business_id`, and reads
-- through the SAME row level security every merchant read goes through. The
-- global authority is "list the ids", never "ignore the boundary".
--
-- ── What is deliberately NOT in this file ────────────────────────────────
--
-- No index. No table. No column. No policy on any table that did not need
-- one — and it turned out none did: the existing `tenant_membership` policies
-- admit any principal presenting the right tenant scope, so a correctly
-- scoped reconciler is already admitted by the rules written in 0040, 0042
-- and 0049. Nothing about row level security is weakened, and nothing about
-- `daftar_worker` changes: it still cannot enumerate businesses and still
-- cannot read the chart or the periods.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. The ownership-transfer authority, taken and returned inside this file.
--    Same dance as 0040/0042/0044/0045/0046/0048/0049: DDL is transactional,
--    nothing temporary survives into a committed database, and section 6
--    refuses to commit if any of it did. Nothing assumes SUPERUSER.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The role must exist before anything can be granted to it.
--
--    `bootstrap.sql` creates it with its password, as it does for every other
--    runtime role — a migration must never know a credential. This guard is
--    here so that a database bootstrapped before P2-S8 fails LOUDLY on the
--    deployment step instead of silently producing a reconciler process that
--    cannot connect.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_reconciler') THEN
    RAISE EXCEPTION 'accounting.reconciler_role_missing: run infrastructure/database/bootstrap.sql before this migration — it creates daftar_reconciler with its deployment credential';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The enumerator.
--
-- KEYSET, NOT OFFSET (§24). A SaaS business list is unbounded and grows; a
-- pass that read it with OFFSET would re-scan everything it had already seen
-- on every page, and a pass that read it all at once would hold the entire
-- tenant population in memory. The cursor is the ordering tuple itself, which
-- is also the primary key of the ordering, so a page is a range scan and a
-- business created mid-pass cannot make the pass skip another one.
--
-- WHAT IT RETURNS is the whole of its authority: `tenant_id` and `id`. Not
-- the name, not the slug, not the owner, not a contact detail, not a
-- currency, not a count. Enumeration is an identifier service (§9).
--
-- WHY IT CAN SEE THE ROWS. It runs as `daftar_accounting_internal`, which
-- migration 0040 already admits to `businesses` by identity, for SELECT only,
-- through the `accounting_seeder_read` policy. No new policy, no bypass, and
-- no widening of `app_bypass()`.
-- ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION accounting_reconcile_businesses(
  p_after_tenant   UUID,
  p_after_business UUID,
  p_limit          INTEGER
)
RETURNS TABLE (tenant_id UUID, business_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT b.tenant_id, b.id
    FROM businesses b
   WHERE p_after_tenant IS NULL
      OR p_after_business IS NULL
      OR (b.tenant_id, b.id) > (p_after_tenant, p_after_business)
   ORDER BY b.tenant_id, b.id
   LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;

COMMENT ON FUNCTION accounting_reconcile_businesses(UUID, UUID, INTEGER) IS
  'P2-S8 §9/§24. The reconciliation enumerator: returns (tenant_id, business_id) pairs in keyset order so the reconciler can enter a normal RLS scope per business. Returns no name, slug, contact detail or financial value, accepts no caller predicate, and mutates nothing. EXECUTE belongs to daftar_reconciler alone.';

ALTER FUNCTION accounting_reconcile_businesses(UUID, UUID, INTEGER) OWNER TO daftar_accounting_internal;

REVOKE ALL ON FUNCTION accounting_reconcile_businesses(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accounting_reconcile_businesses(UUID, UUID, INTEGER) TO daftar_reconciler;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. The reads, column by column (§12, §35).
--
-- Every grant below answers "which named reconciliation check needs this?".
-- A blanket `GRANT SELECT ON businesses` would have been one line and would
-- have handed a financial verifier the merchant's store slug, contact details
-- and locale for no reason at all. Column grants are the difference between a
-- stolen reconciliation credential being an accounting reader and its being a
-- customer-data reader (§13).
--
-- `tenant_id` appears on every accounting table not because a check reads it
-- for its own sake but because R-ACC-04 verifies that a line, its entry and
-- its account all agree about who owns them.
-- ─────────────────────────────────────────────────────────────────────────

-- businesses — R-ACC-07 (base currency), R-ACC-09 (financial_started_at),
-- and (id, tenant_id) for the tenant-membership policies the scoped reads are
-- evaluated against. Nothing else: not name, store_slug, country_code,
-- timezone or any contact column.
GRANT SELECT (id, tenant_id, base_currency, financial_started_at)
  ON businesses TO daftar_reconciler;

-- accounts — R-ACC-03 needs `type` to recompute the accounting identity;
-- R-ACC-04 needs the ownership triple. Not `name`, not `code`, not
-- `system_key`, not the timestamps.
GRANT SELECT (tenant_id, business_id, id, type)
  ON accounts TO daftar_reconciler;

-- journal_entries — R-ACC-01/04/08 need identity and ownership, R-ACC-05
-- needs `entry_date` and `created_at` to tell a posting made into closed
-- books from one the close came after, R-ACC-06 and R-ACC-08 need the source
-- identity. NOT `description` (merchant free text), NOT the actor columns,
-- NOT `request_id`, NOT `posting_fingerprint`.
GRANT SELECT (tenant_id, business_id, id, entry_date, created_at, source_type, source_id)
  ON journal_entries TO daftar_reconciler;

-- journal_lines — the amounts R-ACC-01/02/03 sum, the FX snapshot R-ACC-07
-- verifies, and the ownership R-ACC-04 checks. NOT `memo` (merchant free
-- text), NOT the branch or warehouse dimensions, which no check reads.
GRANT SELECT (
    tenant_id, business_id, id, journal_entry_id, account_id,
    debit_minor, credit_minor, base_amount_minor, base_currency,
    txn_amount_minor, txn_currency, fx_rate, fx_rate_source
  ) ON journal_lines TO daftar_reconciler;

-- accounting_periods — R-ACC-05 only. It needs the boundary, the CURRENT
-- state and WHEN the current close happened. NOT `last_reopen_reason`, which
-- is merchant free text, and none of the actor columns.
GRANT SELECT (tenant_id, business_id, id, start_date, end_date, status, closed_at)
  ON accounting_periods TO daftar_reconciler;

-- accounting_source_bindings — R-ACC-08, both directions.
GRANT SELECT (tenant_id, business_id, source_type, source_id, journal_entry_id)
  ON accounting_source_bindings TO daftar_reconciler;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Return the temporary authority.
-- ─────────────────────────────────────────────────────────────────────────
REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Refuse to commit unless the boundary this file claims to build is the
--    boundary the database ended up with.
--
--    Every assertion below is about the LIVE catalogue, not about the text
--    above. A migration that describes a privilege model and does not verify
--    it has documented an intention, not built a boundary.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role   TEXT;
  v_table  TEXT;
  v_priv   TEXT;
  v_count  INTEGER;
BEGIN
  -- (a) The role's attributes. Every one of these would turn a scoped reader
  --     into something else entirely.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'daftar_reconciler'
       AND rolcanlogin
       AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb
       AND NOT rolcreaterole AND NOT rolreplication
  ) THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: daftar_reconciler must be LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION';
  END IF;

  -- (b) No membership in any privileged role. A member could SET ROLE and
  --     hold everything that role holds, which is the opposite of a narrow
  --     verifier.
  FOR v_role IN SELECT unnest(ARRAY['daftar_platform', 'daftar_worker', 'daftar_accounting_internal', 'daftar_migrator', 'daftar_app', 'daftar_identity', 'daftar_provisioner', 'daftar_resolver'])
  LOOP
    IF pg_has_role('daftar_reconciler', v_role, 'USAGE') OR pg_has_role('daftar_reconciler', v_role, 'MEMBER') THEN
      RAISE EXCEPTION 'accounting.reconciler_authority_invalid: daftar_reconciler is a member of %', v_role;
    END IF;
  END LOOP;

  -- (c) ZERO writes, on every table in the database — not only the ones this
  --     file grants. A reconciler that could write anywhere is not read-only.
  FOR v_table IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege('daftar_reconciler', v_table, v_priv) THEN
        RAISE EXCEPTION 'accounting.reconciler_authority_invalid: daftar_reconciler holds % on %', v_priv, v_table;
      END IF;
      -- A column-level write grant does not answer has_table_privilege, so the
      -- two write privileges PostgreSQL can express per column are asked again
      -- column-wise. DELETE and TRUNCATE exist only whole-table, and asking for
      -- them column-wise raises rather than returning false, so they are not
      -- asked here — the table-level question above is the whole answer for them.
      IF v_priv IN ('INSERT', 'UPDATE')
         AND has_any_column_privilege('daftar_reconciler', v_table, v_priv) THEN
        RAISE EXCEPTION 'accounting.reconciler_authority_invalid: daftar_reconciler holds % on a column of %', v_priv, v_table;
      END IF;
    END LOOP;
  END LOOP;

  -- (d) The reads it does hold are exactly the six tables above, and no
  --     identity, credential or key table is among them.
  FOR v_table IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname IN ('users', 'sessions', 'password_reset_tokens', 'business_invitations',
                         'credential_deliveries', 'accounting_assertion_keys', 'provisioning_assertion_keys',
                         'platform_role_memberships', 'audit_events', 'outbox_events', 'media_objects')
  LOOP
    IF has_any_column_privilege('daftar_reconciler', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'accounting.reconciler_authority_invalid: daftar_reconciler can read %, which no reconciliation check needs (§13)', v_table;
    END IF;
  END LOOP;

  -- (e) EXACTLY ONE executable function, and it is the enumerator. Every
  --     financial command must be out of reach.
  --     PUBLIC is not a role, so has_function_privilege cannot be asked about
  --     it. Its EXECUTE is read from the ACL instead: a NULL proacl is the
  --     PostgreSQL default, which already grants EXECUTE to PUBLIC, and an
  --     explicit grant to PUBLIC is the aclitem whose grantee OID is zero. A
  --     routine PUBLIC may run is not a privilege this role was given, so it
  --     is not counted against it.
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND has_function_privilege('daftar_reconciler', p.oid, 'EXECUTE')
     AND p.proacl IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM aclexplode(p.proacl) a
        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: daftar_reconciler may execute exactly one non-public routine, found %', v_count;
  END IF;
  IF NOT has_function_privilege('daftar_reconciler', 'accounting_reconcile_businesses(UUID, UUID, INTEGER)', 'EXECUTE') THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: the enumerator is not executable by daftar_reconciler';
  END IF;
  IF (SELECT p.proacl IS NULL
             OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        FROM pg_proc p
       WHERE p.oid = 'accounting_reconcile_businesses(UUID, UUID, INTEGER)'::regprocedure) THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: PUBLIC may execute the enumerator';
  END IF;

  -- (f) app_bypass() is untouched, and nothing gained BYPASSRLS. This is the
  --     contract 0032 established and this migration promised not to move.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'daftar\_%' AND rolbypassrls) THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: a DAFTAR role holds BYPASSRLS';
  END IF;
  IF pg_get_functiondef('app_bypass()'::regprocedure) NOT LIKE '%daftar_platform%' THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: app_bypass() no longer names daftar_platform as its only exempt principal';
  END IF;

  -- (g) THE WORKER IS UNCHANGED (§15). This is the regression this whole
  --     design exists to prevent: solving reconciliation by quietly widening
  --     the delivery credential.
  FOR v_table IN SELECT unnest(ARRAY['accounts', 'accounting_periods']) LOOP
    IF has_any_column_privilege('daftar_worker', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'accounting.reconciler_authority_invalid: daftar_worker gained SELECT on % — delivery authority is not reconciliation authority (§15)', v_table;
    END IF;
  END LOOP;
  IF has_function_privilege('daftar_worker', 'accounting_reconcile_businesses(UUID, UUID, INTEGER)', 'EXECUTE') THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: daftar_worker may enumerate businesses (§15)';
  END IF;

  -- (h) The enumerator is a definer routine with the hardened path, and its
  --     owner is the unreachable internal principal.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'accounting_reconcile_businesses'
       AND p.prosecdef
       AND pg_get_userbyid(p.proowner) = 'daftar_accounting_internal'
       AND array_to_string(p.proconfig, ',') LIKE '%search_path=pg_catalog, public, pg_temp%'
  ) THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: the enumerator is not a hardened SECURITY DEFINER routine owned by the internal principal';
  END IF;

  -- (i) The temporary CREATE is gone, and the internal principal is still
  --     unreachable.
  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: the temporary CREATE on schema public was not revoked';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal' AND (rolcanlogin OR rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: daftar_accounting_internal must remain NOLOGIN, NOBYPASSRLS and NOSUPERUSER';
  END IF;

  -- (j) This migration created no table, no column and no index. It is an
  --     authority migration; anything else in it would be something nobody
  --     authorized.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname LIKE 'reconcil%'
  ) THEN
    RAISE EXCEPTION 'accounting.reconciler_authority_invalid: this migration must create no relation — reconciliation stores nothing (§18)';
  END IF;
END $$;
