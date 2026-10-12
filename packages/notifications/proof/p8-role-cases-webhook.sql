SET search_path = p8, public;
\echo '=== as p8_webhook ==='
SELECT case_refuses('H-1   the webhook role cannot read tenant notifications',
  $$SELECT count(*) FROM notifications$$, 'permission denied');
SELECT case_refuses('H-2   nor the delivery ledger',
  $$SELECT count(*) FROM notification_deliveries$$, 'permission denied');
SELECT case_permits('H-3   an unmatched landing goes to quarantine, which is not tenant data', $$
  INSERT INTO notification_provider_quarantine (id,provider,provider_event_id,status_token,verification)
  VALUES (gen_random_uuid(),'whatsapp_cloud','evt-unmatched','delivered','verified')$$);
SELECT case_refuses('H-4   and quarantine cannot reach a notification: no grant to move one',
  $$UPDATE notifications SET status='delivered' WHERE true$$, 'permission denied');
\echo '=== ALL p8_webhook CASES REACHED THEIR STATED OUTCOME ==='
