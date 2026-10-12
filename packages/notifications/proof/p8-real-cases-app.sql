-- =====================================================================
-- Phase 8 — D-1: isolation, measured against the LIVE bypass
-- RUN AS daftar_app.
-- =====================================================================
-- THE DEFECT THIS FILE REPLACES. Round 10 ran its isolation cases against a
-- prototype whose `app_bypass()` read a session setting. The real one is
--
--     CREATE FUNCTION public.app_bypass() RETURNS boolean
--       LANGUAGE sql STABLE PARALLEL SAFE
--       RETURN (CURRENT_USER = 'daftar_platform'::name)
--
-- read here out of `pg_get_functiondef` and asserted by the overlay's §7, not
-- transcribed. The difference is the whole of §6: a GUC bypass is something a
-- tenant can set, an identity bypass is not. Round 10's §6 results are
-- SUPERSEDED by this file, and are marked so in the handoff.
--
-- WHAT MAKES EACH REFUSAL ATTRIBUTABLE. I expected PostgreSQL not to name the
-- policy, and planned to attribute the refusal by construction instead. The
-- run said otherwise: a RESTRICTIVE violation reports `new row violates
-- row-level security policy "business_isolation" for table "notifications"`,
-- so the policy IS asserted by its own name below. The construction is kept as
-- well, because it is the stronger claim of the two: B1 and B1B are in the
-- SAME tenant, so a refusal that separates them cannot come from
-- `tenant_membership`, which is satisfied on both sides.
-- =====================================================================
SET search_path = p8, public;

-- Each case file is its own transaction and ENDS IN A ROLLBACK, so a case
-- cannot leave a row behind for the next file to trip over, and `SET LOCAL`
-- has the block it requires. `ON_ERROR_STOP` aborts the block on the first
-- failure, which rolls back for the same reason.
BEGIN;

-- ---- A1: the app may write inside its own scope ----
SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';

SELECT p8.case_permits('A1 insert in own scope', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, customer_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'invoice_issued', 'transactional', 'cccccccc-0000-4000-8000-000000000001',
          'ar', '{"invoice_id":"x"}'::jsonb, 'B1|event:1|invoice_issued|customer:1',
          '0eeeeeee-0000-4000-8000-000000000001')
$q$);

SELECT p8.case_equals('A2 sees its own row', (SELECT count(*) FROM notifications), 1::bigint);

-- ---- A3: a SIBLING business in the SAME tenant sees nothing ----
-- This is the case that only `business_isolation` can pass. If it ever reads 1,
-- the RESTRICTIVE policy is doing nothing and `tenant_membership` was carrying
-- the whole claim.
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000002';
SELECT p8.case_equals('A3 sibling business sees nothing', (SELECT count(*) FROM notifications), 0::bigint);

SELECT p8.case_refuses('A4 sibling may not write another business''s row', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, customer_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'invoice_issued', 'transactional', 'cccccccc-0000-4000-8000-000000000001',
          'ar', '{}'::jsonb, 'B1|event:2|invoice_issued|customer:1',
          '0eeeeeee-0000-4000-8000-000000000002')
$q$, 'row-level security policy "business_isolation" for table "notifications"');

-- ---- A5: another TENANT sees nothing ----
SET LOCAL app.tenant_id   = '22222222-2222-4222-8222-222222222222';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000003';
SELECT p8.case_equals('A5 other tenant sees nothing', (SELECT count(*) FROM notifications), 0::bigint);

-- ---- A6: THE INVERSE CASE — the bypass is not a setting ----
-- Named by the fourth challenge: "as the app role, SET app.bypass_rls='on' and
-- assert the row count is UNCHANGED. It reds on today's prototype, and it has
-- to red for §6 to mean what it says." Three spellings of the same idea are
-- tried, because guessing one GUC name and finding nothing proves nothing: the
-- claim is that NO session setting lifts the policy, and the reason is that the
-- live predicate reads CURRENT_USER and never reads a setting at all.
SET LOCAL app.bypass_rls = 'on';
SELECT p8.case_equals('A6a app.bypass_rls does not lift the policy',
                      (SELECT count(*) FROM notifications), 0::bigint);
SET LOCAL app.bypass = 'true';
SELECT p8.case_equals('A6b app.bypass does not lift the policy',
                      (SELECT count(*) FROM notifications), 0::bigint);
SET LOCAL app.platform = 'daftar_platform';
SELECT p8.case_equals('A6c app.platform does not lift the policy',
                      (SELECT count(*) FROM notifications), 0::bigint);
SELECT p8.case_equals('A6d and app_bypass() itself still says no', app_bypass(), false);

-- ---- A7: claiming to BE the platform in a setting changes nothing ----
-- `CURRENT_USER` is not settable by a GRANTed role here: `SET ROLE
-- daftar_platform` must be refused, since daftar_app is not a member of it.
-- That refusal is the mechanism §6 rests on, so it is asserted, not assumed.
SELECT p8.case_refuses('A7 the app may not become the platform',
                       'SET ROLE daftar_platform', 'permission denied to set role');

-- ---- A8: back in scope, the row is still there ----
-- A guard against the shape of failure where an isolation suite passes because
-- everything reads zero.
SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';
SELECT p8.case_equals('A8 the row is still visible in its own scope',
                      (SELECT count(*) FROM notifications), 1::bigint);

-- ---- A9: no GUC at all is a refusal to show anything, not a free pass ----
SET LOCAL app.tenant_id   = '';
SET LOCAL app.business_id = '';
SELECT p8.case_equals('A9 an empty scope sees nothing', (SELECT count(*) FROM notifications), 0::bigint);

-- ---- A10: the quarantine is unreadable to the app tier ----
SELECT p8.case_refuses('A10 the app may not read unattributed events',
                       'SELECT count(*) FROM notification_provider_quarantine',
                       'permission denied for table notification_provider_quarantine');

ROLLBACK;
