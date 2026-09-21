-- 0041 — ACCOUNTING PERMISSIONS (Phase 2, slice P2-S1).
--
-- The closed permission registry lives in packages/domain-core/src/permissions.ts
-- (PERMISSIONS / SENSITIVE_PERMISSIONS). This migration creates NO second
-- registry: role_permissions is display/persistence consistency for roles that
-- already exist, and this file brings the persisted OWNER role of every
-- existing business in line with the five newly registered keys.
--
-- Registered here (non-period only):
--   accounting.view          ordinary
--   accounting.post          sensitive
--   accounting.reverse       sensitive
--   accounting.chart.manage  sensitive
--   accounting.fx.manage     sensitive
--
-- NOT registered: accounting.period.manage / accounting.period.reopen — those
-- belong to P2-S6 and must stay absent until periods are confirmed (AL-14).
--
-- C-12 decision (docs/DAFTAR_OPEN_DECISIONS.md): P2-S1 adds NO built-in
-- "accountant" role. No existing member gains financial authority here except
-- the already-authoritative system owner, whose authority is role IDENTITY
-- (business_roles.is_system AND key = 'owner'), not a row in this table.

DO $$
DECLARE
  v_new   TEXT[] := ARRAY[
    'accounting.view',
    'accounting.post',
    'accounting.reverse',
    'accounting.chart.manage',
    'accounting.fx.manage'
  ];
  v_period TEXT[] := ARRAY['accounting.period.manage', 'accounting.period.reopen'];
  v_bad   TEXT;
BEGIN
  -- Owner roles only, set-wise. Manager, cashier and every custom role are
  -- deliberately untouched.
  INSERT INTO role_permissions (business_id, role_id, permission)
  SELECT r.business_id, r.id, p.permission
  FROM business_roles r
  CROSS JOIN unnest(v_new) AS p(permission)
  WHERE r.is_system AND r.key = 'owner'
  ON CONFLICT (business_id, role_id, permission) DO NOTHING;

  -- Completeness: every system owner role now persists all five keys.
  SELECT string_agg(r.business_id::text, ', ' ORDER BY r.business_id::text) INTO v_bad
  FROM business_roles r
  WHERE r.is_system AND r.key = 'owner'
    AND (SELECT count(*) FROM role_permissions rp
         WHERE rp.business_id = r.business_id AND rp.role_id = r.id
           AND rp.permission = ANY (v_new)) <> array_length(v_new, 1);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.permission_backfill_incomplete: owner role incomplete for business(es) %', v_bad;
  END IF;

  -- No non-owner role may have picked up an accounting permission.
  SELECT string_agg(DISTINCT r.key, ', ') INTO v_bad
  FROM role_permissions rp
  JOIN business_roles r ON r.business_id = rp.business_id AND r.id = rp.role_id
  WHERE rp.permission = ANY (v_new)
    AND NOT (r.is_system AND r.key = 'owner');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'accounting.permission_backfill_overreach: non-owner role(s) hold accounting permissions: %', v_bad;
  END IF;

  -- Period permissions belong to P2-S6 and must not exist yet anywhere.
  IF EXISTS (SELECT 1 FROM role_permissions WHERE permission = ANY (v_period)) THEN
    RAISE EXCEPTION 'accounting.period_permissions_premature: period permissions are P2-S6 and must not be persisted yet';
  END IF;
END $$;
