-- =====================================================================
-- §6 isolation, proved AS THE ROLE THAT HOLDS IT (p8_app) and with NO
-- bypass: a suite that runs as the superuser cannot see an RLS defect at
-- all, and one that sets `app.bypass_rls` proves only that bypass works.
-- =====================================================================
SET search_path = p8, public;
\echo '=== as p8_app ==='
SET app.business_id = 'b1111111-1111-1111-1111-111111111111';
SELECT case_equals('A-1   its own business is visible',
  (SELECT count(*) > 0 FROM notifications), true);
SELECT case_equals('A-2   and NOTHING of another business is',
  (SELECT count(*) FROM notifications WHERE business_id <> 'b1111111-1111-1111-1111-111111111111'), 0::bigint);
SET app.business_id = 'b2222222-2222-2222-2222-222222222222';
SELECT case_equals('A-3   the other business sees its own one row',
  (SELECT count(*) FROM notifications), 1::bigint);
SET app.business_id = 'b3333333-3333-3333-3333-333333333333';
SELECT case_equals('A-4   an unrelated tenant sees nothing',
  (SELECT count(*) FROM notifications), 0::bigint);
SELECT case_equals('A-5   and nothing of the delivery ledger either',
  (SELECT count(*) FROM notification_deliveries), 0::bigint);
RESET app.business_id;
SELECT case_equals('A-6   a session with NO business set sees nothing — the policy fails closed',
  (SELECT count(*) FROM notifications), 0::bigint);

SET app.business_id = 'b1111111-1111-1111-1111-111111111111';
SELECT case_refuses('A-7   writing a row into ANOTHER business', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,source_event_id)
  VALUES (gen_random_uuid(),'a2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222',
          'invoice_issued','transactional','c2222222-2222-2222-2222-222222222222','en','{}','k-app-cross','e2000000-0000-0000-0000-00000000000f')$$,
  'row-level security');
SELECT case_refuses('A-8   deciding a status (the worker''s column, not the handler''s)',
  $$UPDATE notifications SET status='sent' WHERE business_id='b1111111-1111-1111-1111-111111111111'$$,
  'permission denied');
SELECT case_refuses('A-9   creating a delivery (a handler may read whether, never decide)', $$
  INSERT INTO notification_deliveries (id,tenant_id,business_id,notification_id,channel,provider,delivery_key,delivery_state)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'f1000000-0000-0000-0000-000000000004','sms','twilio','k-app-writes','queued')$$,
  'permission denied');
SELECT case_refuses('A-10  reading the attempt history it has no grant on',
  $$SELECT count(*) FROM notification_attempts$$, 'permission denied');
\echo '=== ALL p8_app CASES REACHED THEIR STATED OUTCOME ==='
