-- =====================================================================
-- Phase 8 — the invariant cases, run against the applied prototype by the
-- MIGRATOR role (NOSUPERUSER NOBYPASSRLS NOCREATEROLE). Roles and RLS have
-- their own files, because a policy must be proved as the role that holds it.
--
-- `app.bypass_rls` is set for FIXTURE SETUP only, mirroring the live
-- `app_bypass()` helper. Every ISOLATION case runs in the role files with no
-- bypass; a proof that sets bypass and then claims isolation proves nothing.
-- =====================================================================
SET search_path = p8, public;
SET app.bypass_rls = 'on';

-- Fixtures: two businesses in two tenants, each with its own customer.
INSERT INTO businesses VALUES
  ('b1111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111'),
  ('b2222222-2222-2222-2222-222222222222','a2222222-2222-2222-2222-222222222222'),
  ('b3333333-3333-3333-3333-333333333333','a3333333-3333-3333-3333-333333333333');
INSERT INTO customers VALUES
  ('b1111111-1111-1111-1111-111111111111','c1111111-1111-1111-1111-111111111111'),
  ('b2222222-2222-2222-2222-222222222222','c2222222-2222-2222-2222-222222222222');
INSERT INTO users VALUES
  ('b1111111-1111-1111-1111-111111111111','e1111111-1111-1111-1111-111111111111');
INSERT INTO notification_settings VALUES ('b1111111-1111-1111-1111-111111111111', 900);
-- b2 is deliberately left UNCONFIGURED, so the fail-closed direction of the
-- consent staleness bound is executable rather than asserted in prose.

\echo '=== §2 notifications ==='

-- I-1 once-only, per obligation.
SELECT case_permits('I1-a  first obligation row', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,source_event_id)
  VALUES ('f1000000-0000-0000-0000-000000000001','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'invoice_issued','transactional','c1111111-1111-1111-1111-111111111111','ar','{"invoiceId":"i1"}',
          'b1|event:e1|invoice_issued|customer:c1','e1000000-0000-0000-0000-000000000001')$$);
SELECT case_refuses('I1-b  the same obligation twice', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,source_event_id)
  VALUES ('f1000000-0000-0000-0000-000000000002','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'invoice_issued','transactional','c1111111-1111-1111-1111-111111111111','ar','{"invoiceId":"i1"}',
          'b1|event:e1|invoice_issued|customer:c1','e1000000-0000-0000-0000-000000000002')$$,
  'notifications_obligation_once');
-- and the point of keying on the obligation rather than the origin: a SECOND
-- recipient of the SAME event must get a row of their own.
SELECT case_permits('I1-c  a second recipient of the same event', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,user_id,locale,subject_refs,obligation_key,source_event_id)
  VALUES ('f1000000-0000-0000-0000-000000000003','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'invoice_issued','transactional','e1111111-1111-1111-1111-111111111111','ar','{"invoiceId":"i1"}',
          'b1|event:e1|invoice_issued|user:u1','e1000000-0000-0000-0000-000000000001')$$);

-- I-1b the occurrence key's character rule: ':' is canonical, four are refused.
SELECT case_permits('I1b-a  an ISO occurrence with colons', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,schedule_id,occurrence_key)
  VALUES ('f1000000-0000-0000-0000-000000000004','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'customer_statement','operational','c1111111-1111-1111-1111-111111111111','ar','{"customerId":"c1"}',
          'b1|schedule:s1:2026-10-12T00:00|customer_statement|customer:c1','s1','2026-10-12T00:00')$$);
DO $$ DECLARE bad TEXT; i INT := 0; BEGIN
  FOREACH bad IN ARRAY ARRAY['a|b','a::b','a#b','a@b'] LOOP
    i := i + 1;
    PERFORM case_refuses('I1b-' || (i+1) || '  occurrence containing ' || bad, format($f$
      INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,schedule_id,occurrence_key)
      VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
              'customer_statement','operational','c1111111-1111-1111-1111-111111111111','ar','{"customerId":"c1"}',
              %L,'s1',%L)$f$, 'b1|schedule:s1:'||bad||'|customer_statement|customer:c1', bad),
      'notifications_occurrence_key_chars');
  END LOOP;
END $$;

-- I-2 exactly one trigger.
SELECT case_refuses('I2-a  both origins', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,source_event_id,schedule_id,occurrence_key)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'invoice_issued','transactional','c1111111-1111-1111-1111-111111111111','ar','{}','k-both',
          'e1000000-0000-0000-0000-000000000009','s9','2026-10-12')$$,
  'notifications_exactly_one_origin');
SELECT case_refuses('I2-b  neither origin', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'invoice_issued','transactional','c1111111-1111-1111-1111-111111111111','ar','{}','k-neither')$$,
  'notifications_exactly_one_origin');

-- I-3 the ladder, from DIRECT SQL (spec §9 item 3).
SELECT case_permits('I3-a  queued -> sent',      $$UPDATE notifications SET status='sent'      WHERE id='f1000000-0000-0000-0000-000000000001'$$);
SELECT case_permits('I3-b  sent -> delivered',   $$UPDATE notifications SET status='delivered' WHERE id='f1000000-0000-0000-0000-000000000001'$$);
SELECT case_permits('I3-c  delivered -> read',   $$UPDATE notifications SET status='read'      WHERE id='f1000000-0000-0000-0000-000000000001'$$);
SELECT case_refuses('I3-d  read -> sent',        $$UPDATE notifications SET status='sent'      WHERE id='f1000000-0000-0000-0000-000000000001'$$, 'notification.status_regression');
SELECT case_refuses('I3-e  read -> failed',      $$UPDATE notifications SET status='failed'    WHERE id='f1000000-0000-0000-0000-000000000001'$$, 'notification.status_regression');
SELECT case_permits('I3-f  queued -> failed',    $$UPDATE notifications SET status='failed'    WHERE id='f1000000-0000-0000-0000-000000000003'$$);
SELECT case_permits('I3-g  failed -> delivered — a late arrival is EVIDENCE', $$UPDATE notifications SET status='delivered' WHERE id='f1000000-0000-0000-0000-000000000003'$$);
SELECT case_refuses('I3-h  delivered -> failed', $$UPDATE notifications SET status='failed'    WHERE id='f1000000-0000-0000-0000-000000000003'$$, 'notification.status_regression');
SELECT case_refuses('I3-i  an invented status',  $$UPDATE notifications SET status='bounced'   WHERE id='f1000000-0000-0000-0000-000000000004'$$, 'notifications_status_in');

-- I-4 / I-7b: invariants enforced by ABSENCE. Asserted against the catalogue,
-- because a column nobody added is exactly what a comment cannot prove.
SELECT case_equals('I4    no money and no rendered body on any P8 relation',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='p8' AND table_name LIKE 'notification%'
      AND (column_name ~ '(amount|currency|total|price|minor|body|rendered|message_text)')), 0::bigint);
SELECT case_equals('I7b   no consent column on the obligation ledger',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='p8' AND table_name='notifications' AND column_name ~ 'consent' AND column_name <> 'consent_class'), 0::bigint);

-- I-5 / I-5b typed recipient, and the §39 cross-tenant red proof from direct SQL.
SELECT case_refuses('I5-a  both recipient kinds', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,user_id,locale,subject_refs,obligation_key,source_event_id)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111','invoice_issued','transactional',
          'c1111111-1111-1111-1111-111111111111','e1111111-1111-1111-1111-111111111111','ar','{}','k-both-recip','e1000000-0000-0000-0000-00000000000a')$$,
  'notifications_recipient_xor');
SELECT case_refuses('I5-b  neither recipient kind', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,locale,subject_refs,obligation_key,source_event_id)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111','invoice_issued','transactional',
          'ar','{}','k-no-recip','e1000000-0000-0000-0000-00000000000b')$$,
  'notifications_recipient_xor');
SELECT case_refuses('I5b   a recipient belonging to ANOTHER tenant (§39, from direct SQL)', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,source_event_id)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111','invoice_issued','transactional',
          'c2222222-2222-2222-2222-222222222222','ar','{}','k-cross-tenant','e1000000-0000-0000-0000-00000000000c')$$,
  'notifications_customer_owned');

\echo '=== §3 notification_preferences ==='
SELECT case_refuses('I6    in-app opted out', $$
  INSERT INTO notification_preferences (tenant_id,business_id,subject_kind,subject_id,channel,state,effective_from)
  VALUES ('a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111','customer',
          'c1111111-1111-1111-1111-111111111111','inapp','opted_out',now())$$,
  'prefs_inapp_not_opted_out');
SELECT case_refuses('I6-b  one half of a quiet-hours pair', $$
  INSERT INTO notification_preferences (tenant_id,business_id,subject_kind,subject_id,channel,state,effective_from,quiet_start_minute)
  VALUES ('a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111','customer',
          'c1111111-1111-1111-1111-111111111111','sms','opted_in',now(),1320)$$,
  'prefs_quiet_hours_paired');

\echo '=== §4a notification_deliveries ==='
SELECT case_permits('I8a-a  a delivery for the obligation', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state,provider_message_id)
  VALUES ('d1000000-0000-0000-0000-000000000001','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000001','whatsapp','whatsapp_cloud','b1|event:e1|invoice_issued|customer:c1::whatsapp','accepted','wamid.1')$$);
SELECT case_refuses('I8a-b  the same delivery key twice', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000001','whatsapp','whatsapp_cloud','b1|event:e1|invoice_issued|customer:c1::whatsapp','queued')$$,
  'deliveries_delivery_key_once');

-- I-8f INCLUDING `accepted` — the state V3 found outside the old predicate and
-- the one where a second message is most harmful.
SELECT case_refuses('I8f-a  a second channel while the first is ACCEPTED', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000001','sms','twilio','b1|event:e1|invoice_issued|customer:c1::sms','queued')$$,
  'deliveries_one_live_channel');
SELECT case_permits('I8f-b  a withheld channel is recorded beside a live one', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state,withheld_reason)
  VALUES ('d1000000-0000-0000-0000-000000000002','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000001','email','ses','b1|event:e1|invoice_issued|customer:c1::email','withheld','quiet_hours')$$);
SELECT case_refuses('I8f-c  and two live channels are still refused with a withheld one present', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000001','inapp','inapp','b1|event:e1|invoice_issued|customer:c1::inapp','queued')$$,
  'deliveries_one_live_channel');

-- I-8b / I-8c / I-8e
SELECT case_refuses('I8b-a  accepted with no provider id', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000004','whatsapp','whatsapp_cloud','k-acc-noid','accepted')$$,
  'deliveries_accepted_has_provider_message_id');
SELECT case_refuses('I8b-b  a blank provider id', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state,provider_message_id)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000004','whatsapp','whatsapp_cloud','k-acc-blank','accepted','   ')$$,
  'deliveries_provider_message_id_nonblank');
SELECT case_refuses('I8c-a  an ambiguous delivery scheduled for a blind retry', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state,unknown_reason,next_attempt_after)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000004','whatsapp','whatsapp_cloud','k-unk-retry','unknown','timeout_after_send',now())$$,
  'deliveries_unknown_not_blindly_retried');
SELECT case_permits('I8c-b  unless the ADAPTER declares server-side idempotency', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state,unknown_reason,next_attempt_after,provider_server_side_idempotency)
  VALUES ('d1000000-0000-0000-0000-000000000003','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000004','whatsapp','idem_provider','k-unk-idem','unknown','timeout_after_send',now(),true)$$);
SELECT case_refuses('I8c-c  unknown with no reason', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000004','sms','twilio','k-unk-noreason','unknown')$$,
  'deliveries_unknown_reason_exactly_when_unknown');
SELECT case_refuses('I8e-a  unknown -> accepted with no provider id',
  $$UPDATE notification_deliveries SET delivery_state='accepted' WHERE id='d1000000-0000-0000-0000-000000000003'$$,
  'notification.acceptance_without_provider_message_id');
SELECT case_permits('I8e-b  unknown -> accepted WITH one',
  $$UPDATE notification_deliveries SET delivery_state='accepted', provider_message_id='wamid.3', unknown_reason=NULL, next_attempt_after=NULL WHERE id='d1000000-0000-0000-0000-000000000003'$$);
SELECT case_permits('I8e-c  accepted -> closed',
  $$UPDATE notification_deliveries SET delivery_state='closed', final_status='delivered', final_status_verified=true WHERE id='d1000000-0000-0000-0000-000000000003'$$);
SELECT case_refuses('I8e-d  and nothing leaves a terminal state',
  $$UPDATE notification_deliveries SET delivery_state='queued' WHERE id='d1000000-0000-0000-0000-000000000003'$$,
  'notification.delivery_state_terminal');

\echo '=== N-6 / I-8h the arrival fact (the round-3 blocker) ==='
-- The delivery of n-1: the customer READ it, recorded as a verified landing.
SELECT case_permits('N6-a  a verified arrival sets the fact', $$
  UPDATE notification_deliveries SET delivery_state='closed', final_status='read', final_status_verified=true
   WHERE id='d1000000-0000-0000-0000-000000000001'$$);
SELECT case_equals('N6-b  and the fact is derived, not supplied by the caller',
  (SELECT arrival_ever_recorded FROM notification_deliveries WHERE id='d1000000-0000-0000-0000-000000000001'), true);
SELECT case_refuses('N6-c  clearing the arrival fact',
  $$UPDATE notification_deliveries SET arrival_ever_recorded=false WHERE id='d1000000-0000-0000-0000-000000000001'$$,
  'notification.arrival_fact_cleared');
-- The N-6 write itself: a direct-SQL demotion to a verified `failed`.
SELECT case_permits('N6-d  the demotion to a verified failure still lands', $$
  UPDATE notification_deliveries SET final_status='failed', final_status_verified=true
   WHERE id='d1000000-0000-0000-0000-000000000001'$$);
SELECT case_refuses('N6-e  but the obligation is NOT released: no second channel', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000001','sms','twilio','k-n6-second','queued')$$,
  'deliveries_one_live_channel');
SELECT case_refuses('N6-f  an arrival recorded with the fact unset', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state,final_status,final_status_verified,arrival_ever_recorded)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000004','email','ses','k-n6-unset','closed','delivered',true,false)$$,
  'deliveries_arrival_fact_agrees');
-- And the other direction: a GENUINE pre-arrival failure must still release,
-- or the fix would withhold a notification that is honestly still owed.
SELECT case_permits('N6-g  fixture: an obligation that failed before any arrival', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,source_event_id)
  VALUES ('f1000000-0000-0000-0000-000000000005','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'payment_overdue','transactional','c1111111-1111-1111-1111-111111111111','ar','{"invoiceId":"i5"}','k-n6-prearrival','e1000000-0000-0000-0000-000000000005')$$);
SELECT case_permits('N6-h  closed on a verified pre-arrival failure', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state,final_status,final_status_verified)
  VALUES ('d1000000-0000-0000-0000-000000000005','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000005','whatsapp','whatsapp_cloud','k-n6-pre::whatsapp','closed','failed',true)$$);
SELECT case_permits('N6-i  the fallback channel IS permitted — the fix forbids the second message, not the first', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
  VALUES ('d1000000-0000-0000-0000-000000000006','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000005','sms','twilio','k-n6-pre::sms','queued')$$);
SELECT case_refuses('N6-j  and only one fallback at a time', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000005','email','ses','k-n6-pre::email','queued')$$,
  'deliveries_one_live_channel');

\echo '=== §4 notification_attempts ==='
SELECT case_permits('I9a1-a  an attempt whose consent read is bound to it in time', $$
  INSERT INTO notification_attempts (id,tenant_id,business_id,delivery_id,notification_id,attempt_no,attempt_key,outcome,provider_message_id,consent_read_at,consent_source,attempted_at)
  VALUES ('a1000000-0000-0000-0000-000000000001','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000005',1,'k-n6-pre::whatsapp#1','accepted','wamid.5',
          now() - interval '2 seconds','prefs:b1/customer/c1/whatsapp',now())$$);
SELECT case_refuses('I9a1-b  a consent read AFTER the attempt', $$
  INSERT INTO notification_attempts (id,tenant_id,business_id,delivery_id,notification_id,attempt_no,attempt_key,outcome,provider_message_id,consent_read_at,consent_source,attempted_at)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000005',2,'k-after','accepted','wamid.6',
          now() + interval '1 minute','prefs:b1',now())$$,
  'attempts_consent_read_before_attempt');
SELECT case_refuses('I9a1-c  a consent read older than the configured bound', $$
  INSERT INTO notification_attempts (id,tenant_id,business_id,delivery_id,notification_id,attempt_no,attempt_key,outcome,provider_message_id,consent_read_at,consent_source,attempted_at)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000005',3,'k-stale','accepted','wamid.7',
          now() - interval '2 hours','prefs:b1',now())$$,
  'notification.consent_read_too_old');
SELECT case_refuses('I9b-a  rejected without the retryable fact', $$
  INSERT INTO notification_attempts (id,tenant_id,business_id,delivery_id,notification_id,attempt_no,attempt_key,outcome,consent_read_at,consent_source)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000005',4,'k-rej','rejected',now(),'prefs:b1')$$,
  'attempts_rejected_iff_retryable');
SELECT case_refuses('I9b-b  unknown without a reason', $$
  INSERT INTO notification_attempts (id,tenant_id,business_id,delivery_id,notification_id,attempt_no,attempt_key,outcome,consent_read_at,consent_source)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000005',5,'k-unk','unknown',now(),'prefs:b1')$$,
  'attempts_unknown_iff_reason');
SELECT case_refuses('I9b-c  accepted with no provider id', $$
  INSERT INTO notification_attempts (id,tenant_id,business_id,delivery_id,notification_id,attempt_no,attempt_key,outcome,consent_read_at,consent_source)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000005',6,'k-acc','accepted',now(),'prefs:b1')$$,
  'attempts_accepted_has_provider_message_id');
SELECT case_refuses('I9-a   two attempts numbered the same on one delivery', $$
  INSERT INTO notification_attempts (id,tenant_id,business_id,delivery_id,notification_id,attempt_no,attempt_key,outcome,provider_message_id,consent_read_at,consent_source)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000005',1,'k-dup-no','accepted','wamid.8',now(),'prefs:b1')$$,
  'attempts_dense_per_delivery');
SELECT case_refuses('I8-a   an attempt history that can be EDITED is not a history',
  $$UPDATE notification_attempts SET outcome='rejected' WHERE id='a1000000-0000-0000-0000-000000000001'$$,
  'notification.attempt_history_is_append_only');
SELECT case_refuses('I8-b   nor one that can be deleted',
  $$DELETE FROM notification_attempts WHERE id='a1000000-0000-0000-0000-000000000001'$$,
  'notification.attempt_history_is_append_only');

\echo '=== §5 notification_provider_statuses ==='
SELECT case_permits('I10b-a a verified landing, correlated to its delivery', $$
  INSERT INTO notification_provider_statuses (id,tenant_id,business_id,delivery_id,provider,provider_message_id,provider_event_id,status,verification)
  VALUES ('b1000000-0000-0000-0000-000000000001','a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','whatsapp_cloud','wamid.5','evt-1','delivered','verified')$$);
SELECT case_refuses('I11   the same provider event replayed',  $$
  INSERT INTO notification_provider_statuses (id,tenant_id,business_id,delivery_id,provider,provider_message_id,provider_event_id,status,verification)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','whatsapp_cloud','wamid.5','evt-1','read','verified')$$,
  'provider_statuses_event_once');
SELECT case_refuses('I10b-b verified with no provider message id', $$
  INSERT INTO notification_provider_statuses (id,tenant_id,business_id,delivery_id,provider,provider_event_id,status,verification)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','whatsapp_cloud','evt-2','delivered','verified')$$,
  'provider_statuses_verified_has_message_id');
SELECT case_refuses('I10b-c a verification verdict nobody computed', $$
  INSERT INTO notification_provider_statuses (id,tenant_id,business_id,delivery_id,provider,provider_message_id,provider_event_id,status,verification)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','whatsapp_cloud','wamid.5','evt-3','delivered','trust_me')$$,
  'provider_statuses_verification_in');
SELECT case_refuses('I9c3  a status token the provider invented', $$
  INSERT INTO notification_provider_statuses (id,tenant_id,business_id,delivery_id,provider,provider_message_id,provider_event_id,status,verification)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','whatsapp_cloud','wamid.5','evt-4','bounced','verified')$$,
  'provider_statuses_status_in');
SELECT case_refuses('I9c1  a landing against a delivery of ANOTHER business', $$
  INSERT INTO notification_provider_statuses (id,tenant_id,business_id,delivery_id,provider,provider_message_id,provider_event_id,status,verification)
  VALUES (gen_random_uuid(),'a2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222',
          'd1000000-0000-0000-0000-000000000005','whatsapp_cloud','wamid.5','evt-5','delivered','verified')$$,
  'notification_provider_statuses_delivery_id_business_id_fkey');
SELECT case_equals('I9c2-a the quarantine relation carries NO tenant column',
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='p8' AND table_name='notification_provider_quarantine'
      AND column_name IN ('business_id','tenant_id')), 0::bigint);
SELECT case_equals('I9c2-b and no foreign key, so a row there can never move a notification',
  (SELECT count(*) FROM information_schema.table_constraints
    WHERE table_schema='p8' AND table_name='notification_provider_quarantine' AND constraint_type='FOREIGN KEY'), 0::bigint);

\echo '=== §6 grants and isolation, read from the catalogue ==='
SELECT case_equals('G-1   the app role has NO update on the obligation ledger',
  has_table_privilege('p8_app','p8.notifications','UPDATE'), false);
SELECT case_equals('G-2   nor any write on the delivery ledger (it may read whether, never decide)',
  has_table_privilege('p8_app','p8.notification_deliveries','INSERT')
   OR has_table_privilege('p8_app','p8.notification_deliveries','UPDATE'), false);
SELECT case_equals('G-3   the worker may set a status',
  has_column_privilege('p8_worker','p8.notifications','status','UPDATE'), true);
SELECT case_equals('G-4   and may NOT rewrite the obligation key',
  has_column_privilege('p8_worker','p8.notifications','obligation_key','UPDATE'), false);
SELECT case_equals('G-5   the webhook role cannot read tenant notifications',
  has_table_privilege('p8_webhook','p8.notifications','SELECT'), false);
SELECT case_equals('G-6   no PUBLIC grant on any P8 relation',
  (SELECT count(*) FROM information_schema.role_table_grants
    WHERE table_schema='p8' AND grantee='PUBLIC'), 0::bigint);
SELECT case_equals('G-7   no SECURITY DEFINER routine',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='p8' AND p.prosecdef), 0::bigint);
SELECT case_equals('R-1   RLS is enabled AND forced on all five tenant relations',
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='p8' AND c.relrowsecurity AND c.relforcerowsecurity
      AND c.relname IN ('notifications','notification_preferences','notification_deliveries',
                        'notification_attempts','notification_provider_statuses')), 5::bigint);
SELECT case_equals('R-2   and the isolation policy is RESTRICTIVE, not permissive',
  (SELECT count(*) FROM pg_policies WHERE schemaname='p8' AND policyname LIKE '%_business_isolation'
     AND permissive = 'RESTRICTIVE'), 5::bigint);

\echo '=== ALL MIGRATOR-ROLE CASES REACHED THEIR STATED OUTCOME ==='

-- ---------------------------------------------------------------------
-- Fixtures for the ROLE files: a second business with one obligation of its
-- own, so "sees nothing of another tenant" is a count of something that exists
-- rather than of an empty table.
-- ---------------------------------------------------------------------
INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,source_event_id)
VALUES ('f2000000-0000-0000-0000-000000000001','a2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222',
        'invoice_issued','transactional','c2222222-2222-2222-2222-222222222222','en','{"invoiceId":"i9"}',
        'b2|event:e9|invoice_issued|customer:c2','e2000000-0000-0000-0000-000000000001');
INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
VALUES ('d2000000-0000-0000-0000-000000000001','a2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222',
        'f2000000-0000-0000-0000-000000000001','whatsapp','whatsapp_cloud','b2|event:e9|invoice_issued|customer:c2::whatsapp','queued');
GRANT EXECUTE ON FUNCTION p8.case_refuses(TEXT,TEXT,TEXT), p8.case_permits(TEXT,TEXT) TO p8_app, p8_worker, p8_webhook;
