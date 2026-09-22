-- 0043 — DEFERRED JOURNAL INVARIANTS (Phase 2, slice P2-S2).
--
-- 0042 created the journal and armed everything a column CHECK can express.
-- What a CHECK cannot express is a property of an ENTRY rather than of a row:
-- balance, line count, the source binding, and the FX equality that needs both
-- currencies' minor-unit exponents (a CHECK may not read another table). Those
-- are asserted here by two DEFERRABLE INITIALLY DEFERRED constraint triggers,
-- evaluated at COMMIT.
--
-- WHY BOTH TRIGGERS ARE MANDATORY (AL-02). A trigger on journal_lines never
-- fires for a transaction that inserts an entry and no lines, so a line-only
-- validator would let a phantom entry commit. The ENTRY-side trigger is the
-- one that closes that hole; the LINE-side trigger is the one that notices a
-- line added, changed or removed under an entry that was written earlier. One
-- without the other is not a validator, it is half of one.
--
-- WHY THESE ROUTINES RUN AS THE INTERNAL PRINCIPAL. journal_entries,
-- journal_lines and accounting_source_bindings all FORCE row level security.
-- A validator that inherits the writing session's row visibility can be shown
-- a subset of an entry's lines and pronounce it balanced — a check that RLS
-- can blind passes VACUOUSLY, which for a ledger is worse than no check at
-- all. Running as daftar_accounting_internal, which 0042's SELECT policies
-- admit by identity, makes the validator see the whole entry no matter who
-- wrote it. The principal is NOLOGIN and passwordless and holds SELECT only,
-- so this buys visibility and not authority.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: it adds no writer. Every
-- routine below reads and raises. accounting_post_entry, the assertion keys,
-- the fingerprint recomputation and the posting service are P2-S3.
--
-- ERROR CONTRACT (§30, AL-02). Every failure raises a stable
-- `accounting.<code>` identifier plus SAFE STRUCTURAL identifiers only — an
-- entry id and, where it helps, a line number. No message on this page
-- contains a debit sum, a credit sum, an amount, a rate or a balance: a
-- database exception reaches driver logs and generic error handlers where
-- DAFTAR_OBSERVABILITY's redaction rule can no longer be applied, so the
-- redaction has to exist at the source.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Temporary ownership-transfer authority — managed PostgreSQL (§41).
--
-- Same three-condition dance 0040 and 0042 proved: a non-superuser may hand a
-- function to a new owner only if it owns the function, can SET ROLE to the
-- new owner, and the new owner holds CREATE on the schema. Taken here, given
-- back at the end of this same file, inside one transaction, so it never
-- exists in a committed state. Nothing below assumes SUPERUSER.
-- ─────────────────────────────────────────────────────────────────────────
GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Exact powers of ten, without floating point.
--
-- PostgreSQL's power()/^ operators return double precision for the common
-- signatures, and a double is exactly the thing this slice may not use for
-- financial arithmetic. Building the literal as text and casting to NUMERIC
-- is exact for every exponent. The routine reads no table and holds no
-- authority; it is owned by the internal principal purely so that every
-- routine this slice adds has one story.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_pow10(p_exp INTEGER) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE STRICT SET search_path = public, pg_catalog AS $$
  SELECT ('1' || repeat('0', GREATEST(p_exp, 0)))::numeric
$$;

-- Checked HERE, while the migration principal still owns the routine and can
-- still call it. Doing it in the closing assertion block instead would fail
-- under a managed, non-superuser migrator, because by then PUBLIC EXECUTE has
-- been revoked and only the internal principal may call it — a superuser
-- would never have noticed, which is exactly why the non-superuser migration
-- test exists.
DO $$
BEGIN
  IF accounting_pow10(0) <> 1 OR accounting_pow10(3) <> 1000 OR accounting_pow10(-2) <> 1 THEN
    RAISE EXCEPTION 'accounting.pow10_wrong: the exact power-of-ten helper is incorrect';
  END IF;
END $$;

ALTER FUNCTION accounting_pow10(integer) OWNER TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. The single validation authority (§28: "one coherent validation
--    authority"). Both constraint triggers delegate here, so the entry-side
--    and line-side paths can never drift into judging an entry differently.
--
-- Every statement below addresses the entry's lines by the COMPLETE identity
-- `(business_id, id)`. `journal_entries` has no global UNIQUE on `id`, so
-- reading lines by `journal_entry_id` alone can reach another business's
-- independent entry that happens to share the UUID component.
--
-- Checked for every touched entry, in this order (§29):
--   * the entry exists and its status is `posted`
--   * every line of THIS entry names the same tenant as the entry
--   * every line's account belongs to that same business
--   * at least two lines
--   * every line's base_currency is the owning business's base currency
--   * Σ base debit = Σ base credit, and Σ base debit > 0, summed in NUMERIC
--   * every line's base_amount_minor is the exact HALF_EVEN conversion of
--     txn_amount_minor at fx_rate, using both currencies' real exponents
--   * a source binding exists for this entry, in the same business, naming
--     the same source identity and the same tenant
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_assert_entry_valid(p_business_id UUID, p_entry_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  e          RECORD;
  l          RECORD;
  v_lines    INTEGER;
  v_debit    NUMERIC;
  v_credit   NUMERIC;
  v_base     TEXT;
  v_num      NUMERIC;
  v_den      NUMERIC;
  v_q        NUMERIC;
  v_r        NUMERIC;
  v_expected NUMERIC;
BEGIN
  SELECT je.tenant_id, je.business_id, je.id, je.status, je.source_type, je.source_id
    INTO e
  FROM journal_entries je
  WHERE je.business_id = p_business_id AND je.id = p_entry_id;

  IF NOT FOUND THEN
    -- Unreachable while the immutability triggers stand: a posted entry
    -- cannot be deleted. An unreachable check that raises still costs less
    -- than a silent pass, and it is the honest answer if a future slice ever
    -- weakens deletion.
    RAISE EXCEPTION 'accounting.entry_missing: journal entry % does not exist', p_entry_id USING ERRCODE = 'P0001';
  END IF;

  IF e.status <> 'posted' THEN
    RAISE EXCEPTION 'accounting.entry_status_invalid: journal entry % is not posted', p_entry_id USING ERRCODE = 'P0001';
  END IF;

  -- Ownership, over the target entry's own rows and nothing else.
  --
  -- An earlier version gathered lines by entry id alone so that the business
  -- comparison would not be tautological. That was wrong, and it was wrong in
  -- the direction that matters: `journal_entries` is keyed on
  -- `(business_id, id)` with no global UNIQUE on `id`, so two businesses may
  -- legitimately hold entries whose UUID component is identical. Reading by
  -- id alone pulled the OTHER business's independent entry into this one's
  -- validation and reported `entry_business_mismatch` for data that was
  -- perfectly correct. A validator must never manufacture cross-business
  -- visibility to double-check a constraint.
  --
  -- What is left to check is the tenant. The business half is now guaranteed
  -- by the scope predicate itself rather than by a comparison that can never
  -- be false, and by `journal_lines_entry_fk (business_id, journal_entry_id)`
  -- → `journal_entries (business_id, id)`, which is what physically stops a
  -- line claiming one business while pointing at another's entry.
  IF EXISTS (
    SELECT 1 FROM journal_lines jl
    WHERE jl.business_id = e.business_id
      AND jl.journal_entry_id = e.id
      AND jl.tenant_id <> e.tenant_id
  ) THEN
    RAISE EXCEPTION 'accounting.entry_business_mismatch: journal entry % has a line owned by a different tenant', p_entry_id
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM journal_lines jl
    LEFT JOIN accounts a ON a.business_id = jl.business_id AND a.id = jl.account_id
    WHERE jl.business_id = e.business_id AND jl.journal_entry_id = e.id AND a.id IS NULL
  ) THEN
    RAISE EXCEPTION 'accounting.entry_account_foreign: journal entry % references an account outside its business', p_entry_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_lines FROM journal_lines jl
  WHERE jl.business_id = e.business_id AND jl.journal_entry_id = e.id;
  IF v_lines < 2 THEN
    -- Covers the zero-line phantom entry and the one-line entry alike.
    RAISE EXCEPTION 'accounting.entry_too_few_lines: journal entry % has fewer than two lines', p_entry_id USING ERRCODE = 'P0001';
  END IF;

  -- Base currency. Numerically balanced lines that disagree about what "base"
  -- means are not a balanced entry.
  SELECT b.base_currency INTO v_base FROM businesses b WHERE b.id = e.business_id;
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'accounting.entry_business_mismatch: journal entry % names a business that cannot be read', p_entry_id
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines jl
    WHERE jl.business_id = e.business_id AND jl.journal_entry_id = e.id AND jl.base_currency <> v_base
  ) THEN
    RAISE EXCEPTION 'accounting.entry_base_currency_mismatch: journal entry % has a line whose base currency is not the business base currency', p_entry_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Balance. Summed in NUMERIC, never in BIGINT: every line is capped at
  -- 10^18, but a sum of them is not, and an overflowing checker would be a
  -- checker that lies.
  SELECT coalesce(sum(jl.base_amount_minor::numeric) FILTER (WHERE jl.debit_minor > 0), 0),
         coalesce(sum(jl.base_amount_minor::numeric) FILTER (WHERE jl.credit_minor > 0), 0)
    INTO v_debit, v_credit
  FROM journal_lines jl
  WHERE jl.business_id = e.business_id AND jl.journal_entry_id = e.id;

  IF v_debit <= 0 THEN
    RAISE EXCEPTION 'accounting.entry_unbalanced: journal entry % has no positive debit total', p_entry_id USING ERRCODE = 'P0001';
  END IF;
  IF v_debit <> v_credit THEN
    -- Deliberately no sums in this message (§30).
    RAISE EXCEPTION 'accounting.entry_unbalanced: journal entry % does not balance', p_entry_id USING ERRCODE = 'P0001';
  END IF;

  -- FX arithmetic, exactly as AL-09 defines it.
  --
  --   base_minor = HALF_EVEN( txn_minor × rate_scaled × 10^max(0, eb−et)
  --                           ÷ (10^10 × 10^max(0, et−eb)) )
  --
  -- rate_scaled = fx_rate × 10^10 is an exact integer because fx_rate is
  -- NUMERIC(20,10). div()/remainder is used rather than `/` because NUMERIC
  -- division rounds at a bounded scale, and a quotient that rounds UP across
  -- an integer boundary would silently change the result. ROUND() is not used
  -- either: PostgreSQL rounds half away from zero and would disagree with the
  -- engine on exact ties, which is precisely where HALF_EVEN differs.
  FOR l IN
    SELECT jl.line_no, jl.base_amount_minor, jl.txn_amount_minor, jl.fx_rate,
           ct.minor_units AS et, cb.minor_units AS eb
    FROM journal_lines jl
    JOIN currencies ct ON ct.code = jl.txn_currency
    JOIN currencies cb ON cb.code = jl.base_currency
    WHERE jl.business_id = e.business_id AND jl.journal_entry_id = e.id
    ORDER BY jl.line_no
  LOOP
    v_num := l.txn_amount_minor::numeric * (l.fx_rate * 10000000000::numeric) * accounting_pow10(l.eb - l.et);
    v_den := 10000000000::numeric * accounting_pow10(l.et - l.eb);
    v_q := div(v_num, v_den);
    v_r := v_num - v_q * v_den;
    IF 2 * v_r > v_den THEN
      v_expected := v_q + 1;
    ELSIF 2 * v_r < v_den THEN
      v_expected := v_q;
    ELSE
      v_expected := CASE WHEN mod(v_q, 2::numeric) = 0 THEN v_q ELSE v_q + 1 END;
    END IF;

    IF v_expected <> l.base_amount_minor::numeric THEN
      RAISE EXCEPTION 'accounting.entry_fx_arithmetic: journal entry %, line % — the stored base amount is not the exact conversion of the transaction amount', p_entry_id, l.line_no
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- Source identity (AL-01). The deferred foreign keys prove that the two
  -- rows reference each other; this proves the binding is the one that names
  -- THIS entry, in the same business and tenant.
  IF NOT EXISTS (
    SELECT 1 FROM accounting_source_bindings sb
    WHERE sb.business_id = e.business_id
      AND sb.journal_entry_id = e.id
      AND sb.source_type = e.source_type
      AND sb.source_id = e.source_id
      AND sb.tenant_id = e.tenant_id
  ) THEN
    RAISE EXCEPTION 'accounting.entry_binding_missing: journal entry % has no matching source binding', p_entry_id USING ERRCODE = 'P0001';
  END IF;
END $$;

ALTER FUNCTION accounting_assert_entry_valid(uuid, uuid) OWNER TO daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. The two mutation paths.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION accounting_validate_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  PERFORM accounting_assert_entry_valid(NEW.business_id, NEW.id);
  RETURN NULL;
END $$;

ALTER FUNCTION accounting_validate_entry() OWNER TO daftar_accounting_internal;

CREATE OR REPLACE FUNCTION accounting_validate_entry_of_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM accounting_assert_entry_valid(OLD.business_id, OLD.journal_entry_id);
  ELSE
    PERFORM accounting_assert_entry_valid(NEW.business_id, NEW.journal_entry_id);
  END IF;
  RETURN NULL;
END $$;

ALTER FUNCTION accounting_validate_entry_of_line() OWNER TO daftar_accounting_internal;

-- Both triggers are installed while PUBLIC EXECUTE is still open, which is
-- the legal route for a non-superuser migrator; PostgreSQL checks EXECUTE on
-- a trigger function when the trigger is CREATED, never when it fires.
CREATE CONSTRAINT TRIGGER journal_entry_validate
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_validate_entry();

CREATE CONSTRAINT TRIGGER journal_line_validate
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_validate_entry_of_line();

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Close the door. Only the owner may revoke, so assume that identity.
-- ─────────────────────────────────────────────────────────────────────────
SET LOCAL ROLE daftar_accounting_internal;
REVOKE ALL ON FUNCTION accounting_pow10(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_assert_entry_valid(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_validate_entry() FROM PUBLIC;
REVOKE ALL ON FUNCTION accounting_validate_entry_of_line() FROM PUBLIC;
RESET ROLE;

REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Prove the end state, or refuse to commit.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role   TEXT;
  v_detail TEXT;
  v_n      INTEGER;
BEGIN
  -- (a) Both constraint triggers exist, on the right tables, deferred.
  SELECT count(*) INTO v_n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal
    AND t.tgdeferrable AND t.tginitdeferred
    AND ((t.tgname = 'journal_entry_validate' AND c.relname = 'journal_entries')
      OR (t.tgname = 'journal_line_validate' AND c.relname = 'journal_lines'));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'accounting.validator_missing: both deferred constraint triggers are required, found %', v_n;
  END IF;

  -- (b) Every routine this slice added is owned by the unreachable principal
  --     and callable by nobody else.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_detail
  FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('accounting_pow10', 'accounting_assert_entry_valid', 'accounting_validate_entry', 'accounting_validate_entry_of_line')
    AND r.rolname <> 'daftar_accounting_internal';
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.validator_owner_wrong: routine(s) not owned by daftar_accounting_internal: %', v_detail;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_detail
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('accounting_pow10', 'accounting_assert_entry_valid', 'accounting_validate_entry', 'accounting_validate_entry_of_line')
    AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proacl, '{}'::aclitem[])) acl WHERE acl::text LIKE '=%');
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.validator_execute_public: PUBLIC still holds EXECUTE on: %', v_detail;
  END IF;

  FOREACH v_role IN ARRAY ARRAY['daftar_app', 'daftar_platform', 'daftar_worker', 'daftar_identity', 'daftar_resolver', 'daftar_provisioner'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      IF has_function_privilege(v_role, 'accounting_assert_entry_valid(uuid, uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'accounting.validator_reachable: runtime role % can execute the journal validator', v_role;
      END IF;
    END IF;
  END LOOP;

  -- (c) Still no writer (§40), and no assertion machinery.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname IN ('accounting_post_entry', 'accounting_actor')) THEN
    RAISE EXCEPTION 'accounting.writer_exists: accounting_post_entry/accounting_actor belong to P2-S3 and must not exist after 0043';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'accounting_assertion_keys') THEN
    RAISE EXCEPTION 'accounting.assertion_keys_exist: accounting_assertion_keys belongs to P2-S3';
  END IF;

  -- (d) Still nobody holds journal DML, and the temporary CREATE is gone.
  SELECT string_agg(format('%s:%s on %s', coalesce(r.rolname, 'PUBLIC'), a.privilege_type, c.relname), ', '
                    ORDER BY coalesce(r.rolname, 'PUBLIC'), c.relname) INTO v_detail
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND c.relname IN ('journal_entries', 'journal_lines', 'accounting_source_bindings', 'accounting_source_types', 'accounting_system_actors')
    AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    AND a.grantee <> c.relowner;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.journal_writer_exists: refusing to finish 0043 — journal DML is granted: %', v_detail;
  END IF;

  IF has_schema_privilege('daftar_accounting_internal', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'accounting.temporary_create_survived: daftar_accounting_internal still holds CREATE on schema public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'daftar_accounting_internal'
             AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'accounting.internal_principal_reachable: daftar_accounting_internal is no longer an unreachable, unelevated principal';
  END IF;

END $$;
