-- =====================================================================
-- Phase 8 — the other side of §6: the bypass identity, and only it
-- RUN AS daftar_platform.
-- =====================================================================
-- An isolation claim has two halves. The app file shows that no session setting
-- lifts the policy. This file shows that the one principal the repo DOES exempt
-- is exempt — because if nothing could see across businesses, the cases in the
-- app file would pass on a relation nobody can read at all, and §6 would be
-- evidence about an empty table.
SET search_path = p8, public;
BEGIN;

-- Rows to look across. Written here, with no GUC set at all, which is itself
-- the point: `app_bypass()` is `CURRENT_USER = 'daftar_platform'`, so the
-- platform needs no scope. The platform has INSERT on `notifications` only
-- through the grant below; if the grant is missing the case reds, which is the
-- honest outcome.
SELECT p8.case_equals('P1 app_bypass() is true for this identity', app_bypass(), true);
SELECT p8.case_equals('P2 and it holds no scope at all',
  coalesce(nullif(app_business(), ''), '<unset>'), '<unset>');

-- The platform may read `users`, which the owner cannot — the claim M3b in the
-- owner file deferred to this file.
SELECT p8.case_equals('P3 the outsider exists, so the owner file''s M2 was the verifier''s refusal',
  (SELECT count(*) FROM users WHERE id = 'aaaaaaaa-0000-4000-8000-00000000000b'), 1::bigint);

-- Across BOTH tenants and all three businesses, with no scope set. The first
-- version of P4 read `customers` and was refused on PRIVILEGE: `customers`
-- grants `daftar_platform` nothing at all. So the cross-business read is shown
-- on `businesses` and `memberships`, which the platform may read, and the
-- refusal on `customers` becomes a case of its own below — it is an owner item,
-- not something to work around here.
SELECT p8.case_equals('P4a the platform sees both tenants'' businesses',
  (SELECT count(*) FROM businesses WHERE id IN
     ('bbbbbbbb-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000002',
      'bbbbbbbb-0000-4000-8000-000000000003')), 3::bigint);
SELECT p8.case_equals('P4b and every membership, with no business scope',
  (SELECT count(*) FROM memberships
    WHERE business_id = 'bbbbbbbb-0000-4000-8000-000000000001'), 3::bigint);
-- ROUND 29: a RELATION case. `customers` is frozen and this pack does not
-- create it, so the derived witness reads the catalogue for it.
SELECT p8.case_refuses_relation('P4c but it may not read a customer at all',
  'SELECT count(*) FROM @REL@', 'permission denied for table customers',
  'customers');

-- The Phase 8 worker needs the customer's phone and locale, and the customer's
-- row is the only place they are. It has no grant for them, and neither has the
-- platform. Both are measured, because both are owner items (see the handoff's
-- patch request).
SELECT p8.case_equals('P5 the worker cannot read a customer at all today',
  has_table_privilege('daftar_worker', 'customers', 'SELECT'), false);
SELECT p8.case_equals('P6 nor a user',
  has_table_privilege('daftar_worker', 'users', 'SELECT'), false);

-- The quarantine: unreadable by the business tier, and the platform has no
-- grant on it either, so today NOBODY can read it. That is deliberate and
-- fail-closed, and it is an owner item, not a defect to patch here.
SELECT p8.case_equals('P7 no principal can read the quarantine today', (
  SELECT count(*) FROM (SELECT unnest(ARRAY['daftar_app','daftar_worker','daftar_platform']) r) x
   WHERE has_table_privilege(r, 'notification_provider_quarantine', 'SELECT')), 0::bigint);

ROLLBACK;
