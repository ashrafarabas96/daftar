-- 0057_inventory_permissions.sql
-- P3-S1, part 5 — the eleven Phase 3 permissions, persisted for every
-- existing business (P3-AL-38, P3-AL-53).
--
-- The closed permission registry is `PERMISSIONS` / `SENSITIVE_PERMISSIONS` in
-- packages/domain-core/src/permissions.ts, evolved in the same commit as this
-- file. This migration creates NO second registry (exactly as 0041 did not):
-- `role_permissions` is persistence for roles that already exist, and this
-- file brings them in line with what `BUILTIN_ROLE_PERMISSIONS` gives a
-- business provisioned from today on — so both populations end identical.
--
--   key                  sensitivity   owner   manager   cashier   custom
--   inventory.view       ordinary        ✓        ✓
--   inventory.adjust     SENSITIVE       ✓
--   inventory.transfer   SENSITIVE       ✓
--   inventory.stocktake  SENSITIVE       ✓
--   purchases.view       ordinary        ✓        ✓
--   purchases.manage     SENSITIVE       ✓
--   purchases.receive    SENSITIVE       ✓
--   purchases.return     SENSITIVE       ✓
--   suppliers.view       ordinary        ✓        ✓
--   suppliers.manage     SENSITIVE       ✓
--   suppliers.pay        SENSITIVE       ✓
--
-- APPEND ONLY: `INSERT … ON CONFLICT DO NOTHING`, never a DELETE. The
-- Manager's seventeen accepted Phase 1 permissions survive untouched; a
-- custom role gains nothing.
--
-- ── Which rows are "the owner", "the manager", "the cashier" ─────────────
--
-- The lock says "manager/cashier system role". The accepted provisioning
-- writer marks only the owner as a system role (`is_system = (key =
-- 'owner')`, 0033:137 and 0038:233), so the manager and the cashier are the
-- builtin TEMPLATE roles, identified by their UNIQUE (business_id, key)
-- (0003:32). Hence, per business:
--
--   owner    is_system AND key = 'owner'   (the 0041 identity)
--   manager  key = 'manager'
--   cashier  key = 'cashier'
--   custom   every other role
--
-- Caveat (accepted, Agent 0 ruling): the manager template is not a system
-- role, so a merchant may have edited it, or deleted it and created a role
-- keyed 'manager'. Either receives the three NON-sensitive view keys — the
-- lock's intent for "the manager role". No sensitive key can reach it.
--
-- ── Why the file lifts FORCE for its own length ───────────────────────────
--
-- `business_roles` and `role_permissions` carry FORCE row level security
-- (0006), the migrator — their owner — is not exempt from it, and
-- `app_bypass()` is true only for daftar_platform (0052:244-246). Applied by
-- a non-superuser deployment principal, a plain backfill sees ZERO roles,
-- inserts nothing, and every set-wise assertion below is then vacuously true.
-- (The frozen 0041 has exactly that property; see the P3-S1 report.) So the
-- owner lifts FORCE on the two tables, backfills and asserts, and restores
-- FORCE before the file ends — transactional DDL under ACCESS EXCLUSIVE, so
-- no other session observes the window. A superuser build runs the same
-- statements and is unaffected by them.

ALTER TABLE business_roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  -- The table above, as data. Assertion 3 reads the sensitivity column, not a
  -- second hand-copied list.
  v_keys      TEXT[]    := ARRAY['inventory.view', 'inventory.adjust', 'inventory.transfer', 'inventory.stocktake',
                                 'purchases.view', 'purchases.manage', 'purchases.receive', 'purchases.return',
                                 'suppliers.view', 'suppliers.manage', 'suppliers.pay'];
  v_sensitive BOOLEAN[] := ARRAY[false, true, true, true,
                                 false, true, true, true,
                                 false, true, true];
  v_ordinary  TEXT[];
  v_bad       TEXT;
  v_custom_before  TEXT;
  v_custom_after   TEXT;
  v_manager_before TEXT;
  v_manager_after  TEXT;
BEGIN
  SELECT array_agg(k.permission ORDER BY k.permission) INTO v_ordinary
  FROM unnest(v_keys, v_sensitive) AS k(permission, sensitive)
  WHERE NOT k.sensitive;

  -- Snapshots for assertions 4 and 5, taken before anything is written:
  -- every custom role's whole set, and every manager's NON-Phase-3 set.
  SELECT md5(coalesce(string_agg(r.business_id::text || '/' || r.id::text || '=' || coalesce(p.perms, ''), ';'
                                 ORDER BY r.business_id::text, r.id::text), ''))
    INTO v_custom_before
  FROM business_roles r
  LEFT JOIN LATERAL (SELECT string_agg(rp.permission, ',' ORDER BY rp.permission) AS perms
                       FROM role_permissions rp WHERE rp.business_id = r.business_id AND rp.role_id = r.id) p ON true
  WHERE NOT (r.is_system AND r.key = 'owner') AND r.key NOT IN ('manager', 'cashier');

  SELECT md5(coalesce(string_agg(r.business_id::text || '/' || r.id::text || '=' || coalesce(p.perms, ''), ';'
                                 ORDER BY r.business_id::text, r.id::text), ''))
    INTO v_manager_before
  FROM business_roles r
  LEFT JOIN LATERAL (SELECT string_agg(rp.permission, ',' ORDER BY rp.permission) AS perms
                       FROM role_permissions rp
                      WHERE rp.business_id = r.business_id AND rp.role_id = r.id AND NOT (rp.permission = ANY (v_keys))) p ON true
  WHERE r.key = 'manager';

  -- Owner: all eleven.
  INSERT INTO role_permissions (business_id, role_id, permission)
  SELECT r.business_id, r.id, k.permission
  FROM business_roles r
  CROSS JOIN unnest(v_keys) AS k(permission)
  WHERE r.is_system AND r.key = 'owner'
  ON CONFLICT (business_id, role_id, permission) DO NOTHING;

  -- Manager: the three ordinary view keys, appended.
  INSERT INTO role_permissions (business_id, role_id, permission)
  SELECT r.business_id, r.id, k.permission
  FROM business_roles r
  CROSS JOIN unnest(v_ordinary) AS k(permission)
  WHERE r.key = 'manager'
  ON CONFLICT (business_id, role_id, permission) DO NOTHING;

  -- 1. Completeness: every system owner holds all eleven.
  SELECT string_agg(r.business_id::text, ', ' ORDER BY r.business_id::text) INTO v_bad
  FROM business_roles r
  WHERE r.is_system AND r.key = 'owner'
    AND (SELECT count(*) FROM role_permissions rp
          WHERE rp.business_id = r.business_id AND rp.role_id = r.id AND rp.permission = ANY (v_keys)) <> array_length(v_keys, 1);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.permission_backfill_incomplete: owner role incomplete for business(es) %', v_bad;
  END IF;

  -- 2. Manager exactness, restricted to the Phase 3 keys.
  SELECT string_agg(r.business_id::text, ', ' ORDER BY r.business_id::text) INTO v_bad
  FROM business_roles r
  WHERE r.key = 'manager'
    AND (SELECT coalesce(array_agg(rp.permission ORDER BY rp.permission), ARRAY[]::text[])
           FROM role_permissions rp
          WHERE rp.business_id = r.business_id AND rp.role_id = r.id AND rp.permission = ANY (v_keys)) IS DISTINCT FROM v_ordinary;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.permission_backfill_manager_mismatch: the manager''s Phase 3 set is not exactly the three view keys in business(es) %', v_bad;
  END IF;

  -- 3. No sensitive leak: no non-owner role of any kind holds a sensitive key.
  SELECT string_agg(DISTINCT r.key || ':' || rp.permission, ', ') INTO v_bad
  FROM role_permissions rp
  JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
  JOIN unnest(v_keys, v_sensitive) AS k(permission, sensitive) ON k.permission = rp.permission
  WHERE k.sensitive AND NOT (r.is_system AND r.key = 'owner');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.permission_backfill_overreach: non-owner role(s) hold sensitive Phase 3 permissions: %', v_bad;
  END IF;

  -- The cashier holds no Phase 3 key at all.
  SELECT string_agg(DISTINCT rp.permission, ', ') INTO v_bad
  FROM role_permissions rp
  JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
  WHERE r.key = 'cashier' AND rp.permission = ANY (v_keys);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.permission_backfill_overreach: the cashier holds Phase 3 permissions: %', v_bad;
  END IF;

  -- 4. Custom roles unchanged, byte for byte.
  SELECT md5(coalesce(string_agg(r.business_id::text || '/' || r.id::text || '=' || coalesce(p.perms, ''), ';'
                                 ORDER BY r.business_id::text, r.id::text), ''))
    INTO v_custom_after
  FROM business_roles r
  LEFT JOIN LATERAL (SELECT string_agg(rp.permission, ',' ORDER BY rp.permission) AS perms
                       FROM role_permissions rp WHERE rp.business_id = r.business_id AND rp.role_id = r.id) p ON true
  WHERE NOT (r.is_system AND r.key = 'owner') AND r.key NOT IN ('manager', 'cashier');
  IF v_custom_after IS DISTINCT FROM v_custom_before THEN
    RAISE EXCEPTION 'inventory.permission_backfill_overreach: a custom role''s permission set changed';
  END IF;

  -- 5. Manager preservation: every manager's non-Phase-3 set, byte for byte.
  SELECT md5(coalesce(string_agg(r.business_id::text || '/' || r.id::text || '=' || coalesce(p.perms, ''), ';'
                                 ORDER BY r.business_id::text, r.id::text), ''))
    INTO v_manager_after
  FROM business_roles r
  LEFT JOIN LATERAL (SELECT string_agg(rp.permission, ',' ORDER BY rp.permission) AS perms
                       FROM role_permissions rp
                      WHERE rp.business_id = r.business_id AND rp.role_id = r.id AND NOT (rp.permission = ANY (v_keys))) p ON true
  WHERE r.key = 'manager';
  IF v_manager_after IS DISTINCT FROM v_manager_before THEN
    RAISE EXCEPTION 'inventory.permission_backfill_manager_mismatch: a manager''s accepted Phase 1 permissions changed';
  END IF;
END $$;

ALTER TABLE business_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_class WHERE relname IN ('business_roles', 'role_permissions') AND relkind = 'r'
        AND relrowsecurity AND relforcerowsecurity) <> 2 THEN
    RAISE EXCEPTION 'inventory.authority_leak: business_roles and role_permissions must ENABLE and FORCE row level security';
  END IF;
END $$;
