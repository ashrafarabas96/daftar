-- =====================================================================
-- Phase 8 — the WORKER's grants and the status ladder, on the REAL schema
-- RUN AS daftar_worker.
-- =====================================================================
-- WHY THIS FILE EXISTS (round 15, O-4, P2). The retired prototype gate held a
-- `W-*` family that exercised the worker's grants and an `I3-*` family that
-- exercised the status ladder as a DATABASE rule. Round 22 retired that gate
-- after porting the `I-8f`/`N-6` family, and the challenger measured what the
-- record did not say: `daftar_worker` was never a case principal here, so the
-- column-scoped `UPDATE (status, last_error_code, updated_at)`, the append-only
-- `INSERT` on `notification_attempts` and the quarantine `INSERT` were granted
-- in the live schema and exercised by nothing, and the ladder was exercised
-- only in TypeScript, where no `UPDATE` ever reaches a trigger.
--
-- The rule the port follows is round 22's own: coverage is made real BEFORE a
-- claim of coverage is written down. Two mutants red cases in this file by
-- name — 14 drops the monotonic trigger and must red `I3-d`, 15 widens the
-- worker's column-scoped grant to the whole relation and must red `W-2` — so a
-- reader is not asked to take the file's word for what it constrains.
--
-- WHAT COULD NOT BE PORTED, and it is not a silence. The prototype's `H-1`,
-- `H-2` and `H-4` are about a WEBHOOK principal: that it cannot read tenant
-- notifications, cannot read the delivery ledger, and cannot move a
-- notification out of the quarantine. **The frozen role set contains no webhook
-- role**, which the overlay's §6 states as an open owner item, and the real
-- worker both reads notifications and holds `UPDATE (status, …)`, so those
-- three rules have no live analogue to measure. They are recorded as
-- UNMEASURED-at-runtime in the manifest's retirement record, against the
-- administrator's role-creation step, rather than being approximated here with
-- a principal that is not the one the rule is about.
--
-- Rows come from `p8-real-fixtures-worker.sql`, committed by the owner after
-- the rolled-back case files and removed again by its teardown.
-- =====================================================================
SET search_path = p8, public;

BEGIN;

SET LOCAL app.tenant_id   = '11111111-1111-4111-8111-111111111111';
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------
-- W-*: the worker's grants, read as refusals and permissions
-- ---------------------------------------------------------------------
SELECT p8.case_permits('W-1 the worker may set a status on its own business''s obligation', $q$
  UPDATE notifications SET status = 'sent'
   WHERE id = '0fffffff-0000-4000-8000-0000000000a1'
$q$);
-- `case_permits` does not read ROW_COUNT, and an UPDATE that RLS filters to
-- nothing raises no error. So the permission is only established by reading the
-- value back: W-1 without W-1b would also pass if the row had never moved.
SELECT p8.case_equals('W-1b and the status actually moved',
  (SELECT status FROM notifications WHERE id = '0fffffff-0000-4000-8000-0000000000a1'), 'sent');

SELECT p8.case_refuses('W-2 may NOT rewrite the obligation key — the UPDATE grant is column-scoped', $q$
  UPDATE notifications SET obligation_key = 'B1|rewritten'
   WHERE id = '0fffffff-0000-4000-8000-0000000000a1'
$q$, 'permission denied');

SELECT p8.case_refuses('W-3 nor create an obligation — that is not the worker''s to write', $q$
  INSERT INTO notifications (tenant_id, business_id, kind, consent_class, customer_id,
                             locale, subject_refs, obligation_key, source_event_id)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          'low_stock', 'operational', 'cccccccc-0000-4000-8000-000000000001',
          'ar', '{}'::jsonb, 'B1|event:w-insert|low_stock|customer:1',
          '0eeeeeee-0000-4000-8000-0000000000a9')
$q$, 'permission denied');

-- W-4 is the dangerous shape and the reason W-1b exists: an UPDATE that the
-- policy filters out is not an error, it simply touches nothing. Measured, not
-- assumed. B1B is in the SAME tenant as B1, so a 0 here cannot come from the
-- tenant policy; only `business_isolation` separates them.
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000002';
DO $$
DECLARE n INT;
BEGIN
  UPDATE notifications SET status = 'delivered'
   WHERE id = '0fffffff-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'W-4 FAIL: the worker updated % row(s) of a sibling business', n;
  END IF;
  RAISE NOTICE 'W-4 PASS a status update aimed at a sibling business touches 0 rows';
END $$;
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';

SELECT p8.case_permits('W-5 may append an attempt', $q$
  INSERT INTO notification_attempts (tenant_id, business_id, delivery_id, notification_id,
                                     attempt_no, attempt_key, outcome, provider_message_id,
                                     consent_read_at, consent_source)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000001',
          '0ddddddd-0000-4000-8000-0000000000a1', '0fffffff-0000-4000-8000-0000000000a1',
          1, 'B1|event:w1|invoice_issued|customer:1::whatsapp#1', 'accepted', 'wamid.w1',
          now() - interval '1 second', 'prefs:b1/customer/1/whatsapp')
$q$);
SELECT p8.case_equals('W-5b and the appended attempt is readable by the worker',
  (SELECT count(*) FROM notification_attempts
    WHERE attempt_key = 'B1|event:w1|invoice_issued|customer:1::whatsapp#1'), 1::bigint);

-- Two independent defences, and the GRANT is the outer one: the worker is
-- refused before the append-only trigger is ever consulted. The trigger itself
-- is proved against the OWNER at case X1, which is the principal that holds
-- UPDATE and could otherwise edit a history.
SELECT p8.case_refuses('W-6 and may not edit one afterwards — refused by the GRANT, before the trigger', $q$
  UPDATE notification_attempts SET outcome = 'rejected'
   WHERE attempt_key = 'B1|event:w1|invoice_issued|customer:1::whatsapp#1'
$q$, 'permission denied');

-- I-9a1: the staleness bound is configuration and it FAILS CLOSED. B1B's
-- settings row exists with `max_consent_age_seconds` NULL, so this is the
-- not-configured arm and not a missing-row arm.
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000002';
SELECT p8.case_refuses('W-7 an attempt for a business with NO configured bound is refused', $q$
  INSERT INTO notification_attempts (tenant_id, business_id, delivery_id, notification_id,
                                     attempt_no, attempt_key, outcome, provider_message_id,
                                     consent_read_at, consent_source)
  VALUES ('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-0000-4000-8000-000000000002',
          '0ddddddd-0000-4000-8000-0000000000b1', '0fffffff-0000-4000-8000-0000000000b1',
          1, 'B1B|event:w4|invoice_issued|customer:2::sms#1', 'accepted', 'wamid.w4',
          now(), 'prefs:b1b')
$q$, 'notification.consent_staleness_bound_not_configured');
SET LOCAL app.business_id = 'bbbbbbbb-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------
-- H-3: the quarantine, which is the one half of the webhook family that has a
-- live principal — the worker holds its INSERT
-- ---------------------------------------------------------------------
SELECT p8.case_permits('H-3 an unattributable landing goes to the quarantine, which is not tenant data', $q$
  INSERT INTO notification_provider_quarantine (provider, provider_event_id, status_token, verification)
  VALUES ('meta_cloud', 'evt-unmatched-w1', 'delivered', 'signature_missing')
$q$);
SELECT p8.case_refuses('H-3b and the worker cannot read the quarantine back', $q$
  SELECT count(*) FROM notification_provider_quarantine
$q$, 'permission denied');
SELECT p8.case_refuses('H-3c a VERIFIED event may not be quarantined — it belongs in the attributed relation', $q$
  INSERT INTO notification_provider_quarantine (provider, provider_event_id, status_token, verification)
  VALUES ('meta_cloud', 'evt-verified-w1', 'delivered', 'verified')
$q$, 'quarantine_verification_in');

-- ---------------------------------------------------------------------
-- I3-*: the status ladder as a DATABASE rule, not an application convention
-- ---------------------------------------------------------------------
-- The ranks are queued 0, sent 1, failed 2, delivered 3, read 4, and the
-- trigger admits only a STRICT increase. `failed` sitting below the arrivals is
-- the whole point: a failure is not terminal, an arrival is.
SELECT p8.case_permits('I3-a queued -> sent', $q$
  UPDATE notifications SET status = 'sent' WHERE id = '0fffffff-0000-4000-8000-0000000000a2'
$q$);
SELECT p8.case_permits('I3-b sent -> delivered', $q$
  UPDATE notifications SET status = 'delivered' WHERE id = '0fffffff-0000-4000-8000-0000000000a2'
$q$);
SELECT p8.case_permits('I3-c delivered -> read', $q$
  UPDATE notifications SET status = 'read' WHERE id = '0fffffff-0000-4000-8000-0000000000a2'
$q$);
SELECT p8.case_refuses('I3-d read -> sent is a regression', $q$
  UPDATE notifications SET status = 'sent' WHERE id = '0fffffff-0000-4000-8000-0000000000a2'
$q$, 'notification.status_regression');
SELECT p8.case_refuses('I3-e read -> failed is a regression too, because the arrival already happened', $q$
  UPDATE notifications SET status = 'failed' WHERE id = '0fffffff-0000-4000-8000-0000000000a2'
$q$, 'notification.status_regression');
SELECT p8.case_refuses('I3-i an invented status is refused by the ladder itself, before the CHECK', $q$
  UPDATE notifications SET status = 'archived' WHERE id = '0fffffff-0000-4000-8000-0000000000a2'
$q$, 'notification.status_not_on_the_ladder');

SELECT p8.case_permits('I3-f queued -> failed', $q$
  UPDATE notifications SET status = 'failed' WHERE id = '0fffffff-0000-4000-8000-0000000000a3'
$q$);
SELECT p8.case_permits('I3-g failed -> delivered — a late arrival is EVIDENCE, not a regression', $q$
  UPDATE notifications SET status = 'delivered' WHERE id = '0fffffff-0000-4000-8000-0000000000a3'
$q$);
SELECT p8.case_refuses('I3-h delivered -> failed is refused: the arrival is terminal', $q$
  UPDATE notifications SET status = 'failed' WHERE id = '0fffffff-0000-4000-8000-0000000000a3'
$q$, 'notification.status_regression');
-- The ladder's own domain, read out of the catalogue rather than trusted: a
-- token added to the CHECK and nowhere else is case D3a's subject, and this is
-- its worker-side companion — the rank function RAISES on a token it does not
-- know, which is what makes I3-i a named refusal instead of a silent no-op.
SELECT p8.case_equals('I3-j the strict rank function refuses an unknown token by name', (
  SELECT count(*) FROM pg_proc WHERE proname = 'p8_status_rank_strict'
    AND prosrc LIKE '%notification.status_not_on_the_ladder%'), 1::bigint);

ROLLBACK;
