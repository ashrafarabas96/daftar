-- the COST of making the invoker-rights assertion operable: the writer must be
-- granted SELECT on a GLOBAL ledger that carries NO RESTRICTIVE policy.
SET app.tenant_id   = 'aaaaaaaa-0000-0000-0000-000000000001';
SET app.business_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE mine INT; foreign_rows INT; st TEXT;
BEGIN
  -- the assertion now works: cross-business refused ...
  BEGIN
    INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id, outbox_event_id)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
            '0d000000-0000-0000-0000-00000000000e','0e000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'LAW VIOLATED: cross-business still accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'LAW HELD: cross-business refused with % once the grant exists', st;
  END;
  -- ... and the SAME-business write works
  INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id, outbox_event_id)
  VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
          '0d000000-0000-0000-0000-00000000000f','0e000000-0000-0000-0000-000000000001');
  RAISE NOTICE 'CONTROL: the same-business write now succeeds';
  -- THE COST, measured
  SELECT count(*) INTO mine FROM p14s.outbox_events
    WHERE business_id = '11111111-1111-1111-1111-111111111111';
  SELECT count(*) INTO foreign_rows FROM p14s.outbox_events
    WHERE business_id IS DISTINCT FROM '11111111-1111-1111-1111-111111111111'::uuid;
  IF foreign_rows = 0 THEN RAISE EXCEPTION 'COST NOT REPRODUCED: no foreign rows visible'; END IF;
  RAISE NOTICE 'COST MEASURED: the merchant now reads % of its own outbox rows AND % rows belonging to other businesses or to the platform', mine, foreign_rows;
END $$;
