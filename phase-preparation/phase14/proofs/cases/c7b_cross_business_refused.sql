-- PREREQUISITE: cases/c7_fix.sql  (creates p14s.webhook_deliveries)
-- Declared and ASSERTED because round-3 CHALLENGE P2-02 found the C7 family is
-- a continuation of C3 and nothing in the pack said so: run in isolation it
-- failed with a bare "relation does not exist", and its own proof-of-proof
-- could not detect a missing base table because it only inspected the
-- constraint it adds. An ordering precondition that only ORDER's line numbers
-- encode is an undeclared dependency.
DO $$
BEGIN
  IF to_regclass('p14s.webhook_deliveries') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14s.webhook_deliveries does not exist — run cases/c7_fix.sql first';
  END IF;
END $$;

SET app.tenant_id   = 'aaaaaaaa-0000-0000-0000-000000000001';
SET app.business_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE st TEXT; msg TEXT;
BEGIN
  BEGIN
    INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id, outbox_event_id)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
            '0d000000-0000-0000-0000-00000000000a','0e000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'LAW VIOLATED: the cross-business parent link was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    RAISE NOTICE 'LAW HELD: refused with % / %', st, msg;
  END;
  -- CONTROL: the SAME-business parent is still accepted (the law does not over-reject)
  INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id, outbox_event_id)
  VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
          '0d000000-0000-0000-0000-00000000000b','0e000000-0000-0000-0000-000000000001');
  RAISE NOTICE 'CONTROL: the same-business parent link is accepted';
  -- the NULL-business platform event: refused, because NULL is not business 1
  BEGIN
    INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id, outbox_event_id)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
            '0d000000-0000-0000-0000-00000000000c','0e000000-0000-0000-0000-000000000003');
    RAISE EXCEPTION 'LAW VIOLATED: a NULL-business platform event was linked to a business delivery';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'LAW HELD: the NULL-business platform event is refused (IS NOT DISTINCT FROM handles NULL)';
  END;
END $$;
