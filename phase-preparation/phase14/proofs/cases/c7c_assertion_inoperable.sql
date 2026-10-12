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
  -- Round-5 CHALLENGE P2-01: the prerequisite assertions fenced only the
  -- ABSENCE of a relation this case needs, never the PRESENCE of state it
  -- needs to be absent. This case's whole law is what happens WITHOUT a SELECT
  -- grant, so c7d's GRANT surviving from an earlier run made it print
  -- "FINDING REFUTED" about the live TL-P14-SEC-02 ruling when the real cause
  -- was leftover state. A leftover grant must never be able to print a
  -- verdict, so the absence is now asserted as explicitly as the presence and
  -- the case refuses instead of ruling.
  IF has_table_privilege('p14_merchant', 'p14s.outbox_events', 'SELECT') THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14_merchant ALREADY holds SELECT on p14s.outbox_events — this case measures the ungranted state, and a leftover grant (cases/c7d_setup_grant.sql) would make it rule on a world it is not in. Replay from a clean database: ./replay.sh';
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
