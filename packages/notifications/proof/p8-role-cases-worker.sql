SET search_path = p8, public;
\echo '=== as p8_worker ==='
SET app.business_id = 'b1111111-1111-1111-1111-111111111111';
SELECT case_permits('W-1   may set a status on its own business''s obligation',
  $$UPDATE notifications SET status='sent' WHERE id='f1000000-0000-0000-0000-000000000004'$$);
SELECT case_refuses('W-2   may NOT rewrite the obligation key (the UPDATE grant is column-scoped)',
  $$UPDATE notifications SET obligation_key='k-rewritten' WHERE id='f1000000-0000-0000-0000-000000000004'$$,
  'permission denied');
SELECT case_refuses('W-3   nor insert an obligation (it is not the worker''s to create)', $$
  INSERT INTO notifications (id,tenant_id,business_id,kind,consent_class,customer_id,locale,subject_refs,obligation_key,source_event_id)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'low_stock','operational','c1111111-1111-1111-1111-111111111111','ar','{}','k-worker-insert','e1000000-0000-0000-0000-00000000001f')$$,
  'permission denied');
-- An UPDATE that RLS filters out is not an error; it affects nothing. That is
-- the dangerous shape, so it is measured rather than assumed.
DO $$ DECLARE n INT; BEGIN
  UPDATE notifications SET status='sent' WHERE id='f2000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'W-4 FAIL: the worker updated % row(s) of another business', n; END IF;
  RAISE NOTICE 'W-4 PASS a status update aimed at another business touches 0 rows';
END $$;
SELECT case_permits('W-5   may append an attempt', $$
  INSERT INTO notification_attempts (id,tenant_id,business_id,delivery_id,notification_id,attempt_no,attempt_key,outcome,provider_message_id,consent_read_at,consent_source)
  VALUES (gen_random_uuid(),'a1111111-1111-1111-1111-111111111111','b1111111-1111-1111-1111-111111111111',
          'd1000000-0000-0000-0000-000000000005','f1000000-0000-0000-0000-000000000005',7,'k-worker-attempt','accepted','wamid.70',
          now() - interval '1 second','prefs:b1/customer/c1/whatsapp')$$);
-- Two independent defences, and the GRANT is the outer one: the worker is
-- refused before the append-only trigger is ever consulted. Measured rather
-- than predicted — the first run of this case expected the trigger's name and
-- got `permission denied`, which is the stronger refusal. The trigger is proved
-- separately at case I8-a as the table owner, which is the principal that holds
-- UPDATE and could otherwise edit a history.
SELECT case_refuses('W-6   and may not edit one afterwards — refused by the GRANT, before the trigger',
  $$UPDATE notification_attempts SET outcome='rejected' WHERE attempt_key='k-worker-attempt'$$,
  'permission denied');
-- I-9a1 fails CLOSED for a business with no configured consent-staleness bound.
SET app.business_id = 'b2222222-2222-2222-2222-222222222222';
SELECT case_refuses('W-7   an attempt for a business with NO configured bound is refused', $$
  INSERT INTO notification_attempts (id,tenant_id,business_id,delivery_id,notification_id,attempt_no,attempt_key,outcome,provider_message_id,consent_read_at,consent_source)
  VALUES (gen_random_uuid(),'a2222222-2222-2222-2222-222222222222','b2222222-2222-2222-2222-222222222222',
          'd2000000-0000-0000-0000-000000000001','f2000000-0000-0000-0000-000000000001',1,'k-b2-attempt','accepted','wamid.90',
          now(),'prefs:b2')$$,
  'notification.consent_staleness_bound_not_configured');
\echo '=== ALL p8_worker CASES REACHED THEIR STATED OUTCOME ==='
