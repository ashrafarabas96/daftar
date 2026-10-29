-- 0076_phase4_permission_defaults_backfill.sql
-- Phase 4 / P4-S1 — the Phase 4 permission defaults, and the assertion that
-- refuses a sensitive key on a non-owner role (the Tech Lead's P4-S0 FINAL
-- CORRECTIVE SEAL DIRECTIVE §17-§20, step 4 of the hard order;
-- docs/PHASE_4_ARCHITECTURE_LOCK.md P4-AL-36, P4-AL-37, and the OD-P4-01
-- TECH LEAD RULING — OPTION A).
--
-- Migrations 0000-0073 are FROZEN and untouched.
--
-- ── Why this file exists at all ─────────────────────────────────────────
--
-- P4-AL-37 names this the FOURTH protection Phase 4 must BUILD rather than
-- inherit. The registry already carries the twelve Phase 4 keys and their
-- sensitivity, and `provision_create_business` already writes them for a
-- business created today, because it owns no permission list of its own and
-- inserts `BUILTIN_ROLE_PERMISSIONS` verbatim. What no writer anywhere does
-- is put a Phase 4 key on a role that ALREADY EXISTS: a cashier of a business
-- created before this slice cannot sell. So the backfill is needed, and it is
-- needed only for the pre-existing population.
--
-- And `role_permissions` carries no CHECK, no trigger and no exclusion
-- constraint, so nothing in the database refuses `cashier -> sales.void`
-- today. That is what the assertion below adds.
--
-- ── What this file does ─────────────────────────────────────────────────
--
--   1. The audited backfill OD-P4-01 OPTION A requires: the system owner
--      receives all twelve, `manager` the six ORDINARY keys, `cashier` four
--      of those six. Append only — `INSERT … ON CONFLICT DO NOTHING`, never a
--      DELETE and never an UPDATE — with one `audit_events` row per (business,
--      role) actually changed, so a second application writes no permission
--      row and therefore no audit row.
--   2. The P4-AL-37 assertion, the sibling of `0057:140-151`: no non-owner
--      role of any kind, built-in or custom, holds a SENSITIVE Phase 4 key.
--   3. Three exactness assertions and two byte-for-byte preservation
--      snapshots, so the file proves it granted what it meant to and nothing
--      else.
--   4. 0076-E: FORCE restored and asserted from pg_class.
--
-- ── What this file does NOT do ──────────────────────────────────────────
--
-- No table, no column, no index, no policy, no routine, no registry row. No
-- change to a custom role, ever — assertion 5 is a byte-for-byte digest of
-- every custom role's whole set, taken before the backfill and compared
-- after. No change to any built-in role's pre-Phase-4 permissions — assertion
-- 6 is the same digest over the non-Phase-4 keys. It grants no key to the
-- `clerk`-style roles a merchant made, because a default nobody chose is not
-- a default (OD-P4-01).
--
-- ── Header rules (P4-S1) ───────────────────────────────────────────────
--
--   R-P4-10 THE SENSITIVITY IS A PARALLEL VECTOR, NOT A SECOND LIST. `0041`
--        hand-copied its key list twice and `0057` stopped doing so for this
--        reason. The manager's default set is DERIVED from the vector here,
--        so it cannot drift from it, and the cashier's four — which are not
--        derivable, because `receivables.view` is ordinary and still not a
--        default — are proved to be ordinary and a strict subset of the
--        manager's by assertion 0, before anything is written.
--   R-P4-11 THE ASSERTION ORDER IS PART OF THE ASSERTION. The overreach check
--        runs FIRST. A sensitive key planted on the cashier also trips
--        cashier exactness, and the exception that reaches an operator must
--        be the one that names the role and the key, not the one that names a
--        business id.
--   R-P4-12 AUDITED MEANS THE RECORD EXISTS. The two counts taken before the
--        write are reconciled against what was written, so a silently
--        eliminated audit row raises instead of committing a green backfill
--        with no record. This is not theoretical: on a `daftar_migrator`
--        rehearsal, `businesses` under FORCE ROW LEVEL SECURITY made the
--        audit join return zero rows and the INSERT wrote NOTHING, with no
--        error. A superuser run never shows it, and CI applies as a
--        superuser — [[daftar-a-superuser-skips-the-questions-a-deployer-is-asked]].
--        Both the fourth NO FORCE and the reconciliation are load-bearing.
--
-- ── ONE FORK, SETTLED HERE ──────────────────────────────────────────────
--
-- Whether the owner arm grants the owner the SENSITIVE keys too. It does, and
-- the reason is the accepted precedent rather than a judgement of mine:
-- `0041:37-42` and `0057:104-109` both backfill the owner with their full key
-- set, sensitive keys included, and both then assert the owner holds all of
-- them (`0041:45-54`, `0057:118-125`); the overreach predicate in BOTH of
-- them exempts `is_system AND key = 'owner'` explicitly; and
-- `BUILTIN_ROLE_PERMISSIONS.owner = PERMISSIONS`, so a business provisioned
-- today already has all twelve on its owner role. Without the owner arm the
-- two populations would NOT end identical, which is the stated purpose of
-- `0057:7-11`. OD-P4-01's forbidden defaults — `sales.discount`, `sales.void`,
-- `refunds.approve`, `payments.reverse`, `installments.manage` — are forbidden
-- as CASHIER defaults; the owner's authority is role identity, not a grant
-- (`0041:19-22`).

-- `business_roles`, `role_permissions` AND `audit_events` all carry FORCE row
-- level security; the migrator owns them and is NOT exempt, and `app_bypass()`
-- is true only for `daftar_platform` (`0052:244-246`). Verified on the scratch
-- database: as the table owner, the audit INSERT below is silently refused by
-- `audit_scope`'s WITH CHECK, and the backfill sees zero roles — which would
-- make every assertion below vacuously true. 0057 lifted FORCE on two tables
-- for exactly this reason (`0057:49-60`); this file lifts it on three, because
-- it is the first permission migration that also WRITES AN AUDIT ROW.
-- Transactional DDL under ACCESS EXCLUSIVE, so no other session observes it.
ALTER TABLE business_roles   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events     NO FORCE ROW LEVEL SECURITY;
-- `businesses` is lifted too, and it is NOT decoration: `audit_events` carries
-- `audit_events_business_implies_tenant` and the composite FK
-- `(tenant_id, business_id) -> businesses(tenant_id, id)`, so the audit row's
-- `tenant_id` can only come from `businesses`. Under FORCE, that join returned
-- ZERO rows for `daftar_migrator` and the audit INSERT wrote NOTHING, with no
-- error — a green migration and a missing audit record. Observed on a scratch
-- database migrated as `daftar_migrator` before this line existed.
ALTER TABLE businesses       NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  -- P4-AL-36's twelve, in the registry's order, with P4-AL-37's sensitivity as
  -- a PARALLEL VECTOR. Assertion 4 reads this vector; no second list of
  -- sensitive keys is hand-copied anywhere in this file.
  v_keys      TEXT[]    := ARRAY['sales.view', 'sales.create', 'sales.void', 'sales.return', 'sales.discount',
                                 'customers.view', 'customers.manage',
                                 'payments.collect', 'payments.reverse',
                                 'refunds.approve', 'receivables.view', 'installments.manage'];
  v_sensitive BOOLEAN[] := ARRAY[false, false, true, true, true,
                                 false, false,
                                 false, true,
                                 true, false, true];
  -- The manager's Phase 4 default set: exactly the six ORDINARY keys
  -- (P4-AL-35 + the OD-P4-01 ruling; `permissions.ts:195-201`). DERIVED from
  -- the vector, so it cannot drift from it.
  v_manager   TEXT[];
  -- The cashier's Phase 4 default set: four of the six ordinary keys.
  -- `receivables.view` is ORDINARY but is the second half of a CREDIT sale
  -- (P4-AL-35), which the ruling makes a delegation, not a default
  -- (`permissions.ts:212`). Not derivable from sensitivity, so it is written
  -- out — and assertion 0 proves every member of it is ordinary and that it is
  -- a strict subset of the manager's set.
  v_cashier   TEXT[]    := ARRAY['sales.view', 'sales.create', 'customers.view', 'payments.collect'];
  v_bad             TEXT;
  v_expect_rows     BIGINT;
  v_expect_roles    BIGINT;
  v_before_rows     BIGINT;
  v_after_rows      BIGINT;
  v_audited         BIGINT;
  v_custom_before   TEXT;
  v_custom_after    TEXT;
  v_preserve_before TEXT;
  v_preserve_after  TEXT;
BEGIN
  SELECT array_agg(k.permission ORDER BY k.permission) INTO v_manager
  FROM unnest(v_keys, v_sensitive) AS k(permission, sensitive)
  WHERE NOT k.sensitive;

  -- 0. The two default sets are internally consistent with the sensitivity
  --    vector before anything is written: six ordinary, six sensitive, the
  --    cashier's four all ordinary and all inside the manager's set.
  IF array_length(v_keys, 1) <> 12 OR array_length(v_sensitive, 1) <> 12 THEN
    RAISE EXCEPTION 'phase4.permission_key_set_malformed: the Phase 4 key set is not twelve keys with twelve sensitivities';
  END IF;
  IF array_length(v_manager, 1) <> 6 THEN
    RAISE EXCEPTION 'phase4.permission_key_set_malformed: the ordinary Phase 4 keys are not six';
  END IF;
  SELECT string_agg(c, ', ') INTO v_bad
  FROM unnest(v_cashier) AS c
  WHERE NOT (c = ANY (v_manager));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phase4.permission_key_set_malformed: cashier default(s) are not ordinary Phase 4 keys: %', v_bad;
  END IF;

  -- Snapshots for assertions 5 and 6, taken BEFORE anything is written:
  -- every custom role's whole set, and every built-in role's NON-Phase-4 set.
  SELECT md5(coalesce(string_agg(r.business_id::text || '/' || r.id::text || '=' || coalesce(p.perms, ''), ';'
                                 ORDER BY r.business_id::text, r.id::text), ''))
    INTO v_custom_before
  FROM business_roles r
  LEFT JOIN LATERAL (SELECT string_agg(rp.permission, ',' ORDER BY rp.permission) AS perms
                       FROM role_permissions rp WHERE rp.business_id = r.business_id AND rp.role_id = r.id) p ON true
  WHERE NOT (r.is_system AND r.key = 'owner') AND r.key NOT IN ('manager', 'cashier');

  SELECT md5(coalesce(string_agg(r.business_id::text || '/' || r.id::text || '=' || coalesce(p.perms, ''), ';'
                                 ORDER BY r.business_id::text, r.id::text), ''))
    INTO v_preserve_before
  FROM business_roles r
  LEFT JOIN LATERAL (SELECT string_agg(rp.permission, ',' ORDER BY rp.permission) AS perms
                       FROM role_permissions rp
                      WHERE rp.business_id = r.business_id AND rp.role_id = r.id
                        AND NOT (rp.permission = ANY (v_keys))) p ON true
  WHERE (r.is_system AND r.key = 'owner') OR r.key IN ('manager', 'cashier');

  -- ── B. THE AUDITED BACKFILL ────────────────────────────────────────────────
  --
  -- What this run will write, counted BEFORE it writes: the desired rows that
  -- are not already present, and how many distinct roles they touch. These two
  -- numbers are what make the audit non-vacuous — see the reconciliation
  -- immediately after the two INSERTs.
  SELECT count(*), count(DISTINCT (m.business_id, m.role_id)) INTO v_expect_rows, v_expect_roles
  FROM (
    SELECT r.business_id, r.id AS role_id, k.permission
    FROM business_roles r
    CROSS JOIN LATERAL unnest(
      CASE
        WHEN r.is_system AND r.key = 'owner' THEN v_keys      -- all twelve (the FORK, settled in the header)
        WHEN r.key = 'manager'               THEN v_manager   -- the six ordinary
        WHEN r.key = 'cashier'               THEN v_cashier   -- the four till keys
      END
    ) AS k(permission)
    WHERE ((r.is_system AND r.key = 'owner') OR r.key IN ('manager', 'cashier'))
      AND NOT EXISTS (SELECT 1 FROM role_permissions rp
                       WHERE rp.business_id = r.business_id AND rp.role_id = r.id AND rp.permission = k.permission)
  ) m;

  SELECT count(*) INTO v_before_rows FROM role_permissions WHERE permission = ANY (v_keys);

  -- APPEND ONLY: `INSERT … ON CONFLICT DO NOTHING`, never a DELETE, never an
  -- UPDATE. `RETURNING` therefore yields exactly the rows this run actually
  -- created, which is what makes the audit idempotent: a second application
  -- inserts no permission row, so it inserts no audit row either.
  --
  -- The audit relation is `audit_events` — the estate's only audit relation,
  -- append-only by the `audit_no_update` / `audit_no_delete` triggers. One row
  -- per (business, role) actually changed; `actor_user_id` is NULL because a
  -- migration has no actor; the granted keys go in `metadata` so the record
  -- says WHAT was granted and not merely that something was.
  WITH ins AS (
    INSERT INTO role_permissions (business_id, role_id, permission)
    SELECT r.business_id, r.id, k.permission
    FROM business_roles r
    CROSS JOIN LATERAL unnest(
      CASE
        WHEN r.is_system AND r.key = 'owner' THEN v_keys
        WHEN r.key = 'manager'               THEN v_manager
        WHEN r.key = 'cashier'               THEN v_cashier
      END
    ) AS k(permission)
    WHERE (r.is_system AND r.key = 'owner') OR r.key IN ('manager', 'cashier')
    ON CONFLICT (business_id, role_id, permission) DO NOTHING
    RETURNING business_id, role_id, permission
  )
  INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, metadata)
  SELECT b.tenant_id, i.business_id, NULL, 'structure.permission_backfilled', 'role', i.role_id::text,
         jsonb_build_object(
           'phase', 4,
           'migration', '0076_phase4_permission_defaults_backfill',
           'decision', 'OD-P4-01 OPTION A',
           'roleKey', r.key,
           'permissions', to_jsonb(array_agg(i.permission ORDER BY i.permission)))
  FROM ins i
  JOIN businesses b ON b.id = i.business_id
  JOIN business_roles r ON r.business_id = i.business_id AND r.id = i.role_id
  GROUP BY b.tenant_id, i.business_id, i.role_id, r.key;
  GET DIAGNOSTICS v_audited = ROW_COUNT;

  SELECT count(*) INTO v_after_rows FROM role_permissions WHERE permission = ANY (v_keys);

  -- The audit reconciliation. "Audited" has to mean the record exists, not
  -- that an INSERT statement was written: if RLS, a join or a policy silently
  -- eliminates the audit rows, the counts disagree and the migration raises
  -- rather than committing a green backfill with no record. This assertion
  -- caught exactly that defect on a `daftar_migrator` rehearsal, where
  -- `businesses` under FORCE made the audit join return zero rows.
  IF v_after_rows - v_before_rows <> v_expect_rows THEN
    RAISE EXCEPTION 'phase4.permission_backfill_incomplete: expected % new permission row(s), wrote %',
      v_expect_rows, v_after_rows - v_before_rows;
  END IF;
  IF v_audited <> v_expect_roles THEN
    RAISE EXCEPTION 'phase4.permission_backfill_unaudited: % role(s) changed but % audit row(s) written',
      v_expect_roles, v_audited;
  END IF;

  -- ── A. THE ASSERTIONS ──────────────────────────────────────────────────────

  -- 1. THE P4-AL-37 ASSERTION — FIRST, deliberately.
  --    No non-owner role of ANY kind — built-in or
  --    custom — holds a SENSITIVE Phase 4 key. This is the sibling of
  --    `0057:140-151`. It runs BEFORE the three exactness assertions on
  --    purpose: a sensitive key planted on the cashier trips the cashier
  --    exactness check too, and the exception that reaches the operator should
  --    be the one that names the ROLE AND THE KEY, not the one that names a
  --    business id. It is the assertion the red proof plants against:
  --    `tests/security/phase4-permission-backfill-assertion.test.ts` inserts
  --    `cashier -> sales.void` and requires this to RAISE.
  SELECT string_agg(DISTINCT r.key || ':' || rp.permission, ', ') INTO v_bad
  FROM role_permissions rp
  JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
  JOIN unnest(v_keys, v_sensitive) AS k(permission, sensitive) ON k.permission = rp.permission
  WHERE k.sensitive AND NOT (r.is_system AND r.key = 'owner');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phase4.permission_backfill_overreach: non-owner role(s) hold sensitive Phase 4 permissions: %', v_bad;
  END IF;

  -- 2. Completeness: every system owner holds all twelve.
  --    (Deleted with the owner arm if the narrow reading is taken.)
  SELECT string_agg(r.business_id::text, ', ' ORDER BY r.business_id::text) INTO v_bad
  FROM business_roles r
  WHERE r.is_system AND r.key = 'owner'
    AND (SELECT count(*) FROM role_permissions rp
          WHERE rp.business_id = r.business_id AND rp.role_id = r.id
            AND rp.permission = ANY (v_keys)) <> array_length(v_keys, 1);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phase4.permission_backfill_incomplete: owner role incomplete for business(es) %', v_bad;
  END IF;

  -- 3. Manager exactness, restricted to the Phase 4 keys: exactly the six
  --    ordinary keys, no more and no fewer.
  SELECT string_agg(r.business_id::text, ', ' ORDER BY r.business_id::text) INTO v_bad
  FROM business_roles r
  WHERE r.key = 'manager'
    AND (SELECT coalesce(array_agg(rp.permission ORDER BY rp.permission), ARRAY[]::text[])
           FROM role_permissions rp
          WHERE rp.business_id = r.business_id AND rp.role_id = r.id
            AND rp.permission = ANY (v_keys)) IS DISTINCT FROM v_manager;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phase4.permission_backfill_manager_mismatch: the manager''s Phase 4 set is not exactly the six ordinary keys in business(es) %', v_bad;
  END IF;

  -- 4. Cashier exactness, restricted to the Phase 4 keys: exactly the four
  --    till keys. This is the OD-P4-01 OPTION A default set, stated positively
  --    as well as negatively — assertion 4 refuses the sensitive five, this
  --    one refuses a fifth ordinary key (`receivables.view`) being slipped in
  --    as a default for a credit-selling till.
  SELECT string_agg(r.business_id::text, ', ' ORDER BY r.business_id::text) INTO v_bad
  FROM business_roles r
  WHERE r.key = 'cashier'
    AND (SELECT coalesce(array_agg(rp.permission ORDER BY rp.permission), ARRAY[]::text[])
           FROM role_permissions rp
          WHERE rp.business_id = r.business_id AND rp.role_id = r.id
            AND rp.permission = ANY (v_keys)) IS DISTINCT FROM (SELECT array_agg(c ORDER BY c) FROM unnest(v_cashier) AS c);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phase4.permission_backfill_cashier_mismatch: the cashier''s Phase 4 set is not exactly the four till keys in business(es) %', v_bad;
  END IF;

  -- 5. Custom roles unchanged, byte for byte.
  SELECT md5(coalesce(string_agg(r.business_id::text || '/' || r.id::text || '=' || coalesce(p.perms, ''), ';'
                                 ORDER BY r.business_id::text, r.id::text), ''))
    INTO v_custom_after
  FROM business_roles r
  LEFT JOIN LATERAL (SELECT string_agg(rp.permission, ',' ORDER BY rp.permission) AS perms
                       FROM role_permissions rp WHERE rp.business_id = r.business_id AND rp.role_id = r.id) p ON true
  WHERE NOT (r.is_system AND r.key = 'owner') AND r.key NOT IN ('manager', 'cashier');
  IF v_custom_after IS DISTINCT FROM v_custom_before THEN
    RAISE EXCEPTION 'phase4.permission_backfill_overreach: a custom role''s permission set changed';
  END IF;

  -- 6. Preservation: every built-in role's NON-Phase-4 set, byte for byte. The
  --    accepted Phase 1 / Phase 2 / Phase 3 sets are not altered, reordered or
  --    trimmed by this file.
  SELECT md5(coalesce(string_agg(r.business_id::text || '/' || r.id::text || '=' || coalesce(p.perms, ''), ';'
                                 ORDER BY r.business_id::text, r.id::text), ''))
    INTO v_preserve_after
  FROM business_roles r
  LEFT JOIN LATERAL (SELECT string_agg(rp.permission, ',' ORDER BY rp.permission) AS perms
                       FROM role_permissions rp
                      WHERE rp.business_id = r.business_id AND rp.role_id = r.id
                        AND NOT (rp.permission = ANY (v_keys))) p ON true
  WHERE (r.is_system AND r.key = 'owner') OR r.key IN ('manager', 'cashier');
  IF v_preserve_after IS DISTINCT FROM v_preserve_before THEN
    RAISE EXCEPTION 'phase4.permission_backfill_preexisting_mismatch: a built-in role''s pre-Phase-4 permissions changed';
  END IF;
END $$;

ALTER TABLE business_roles   FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events     FORCE ROW LEVEL SECURITY;
ALTER TABLE businesses       FORCE ROW LEVEL SECURITY;

-- 0076-E: the window closed. [[daftar-the-live-catalogue-is-the-policy]] — the
-- file asserts its own model against pg_class rather than trusting the ALTERs.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_class
       WHERE relname IN ('business_roles', 'role_permissions', 'audit_events', 'businesses')
         AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity) <> 4 THEN
    RAISE EXCEPTION 'phase4.authority_leak: businesses, business_roles, role_permissions and audit_events must ENABLE and FORCE row level security';
  END IF;
END $$;
