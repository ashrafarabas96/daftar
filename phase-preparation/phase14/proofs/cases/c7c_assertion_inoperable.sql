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

-- FINDING against my own §7a: an INVOKER-RIGHTS assertion cannot read the
-- parent unless the WRITING role holds SELECT on outbox_events. As proposed,
-- the assertion is inoperable — it refuses every write, cross-business or not.
SET app.tenant_id   = 'aaaaaaaa-0000-0000-0000-000000000001';
SET app.business_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE st TEXT;
BEGIN
  BEGIN
    INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id, outbox_event_id)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
            '0d000000-0000-0000-0000-00000000000d','0e000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FINDING REFUTED: the SAME-business write succeeded without a SELECT grant';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'FINDING CONFIRMED: even the SAME-business write is refused with % — the assertion fails CLOSED but is unusable', st;
  END;
END $$;
