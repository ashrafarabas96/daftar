-- STRONGER FORM of the SEC-02 defect: the writer has NO SELECT on outbox_events
-- at all, yet the global FK still accepts a cross-business parent. FK
-- enforcement does not consult the writer's privileges.
SET app.tenant_id   = 'aaaaaaaa-0000-0000-0000-000000000001';
SET app.business_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE st TEXT;
BEGIN
  -- FENCE: the writer provably cannot READ the parent it is about to NAME
  BEGIN
    PERFORM 1 FROM p14s.outbox_events WHERE id='0e000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'FENCE FAILED: the writer CAN read outbox_events';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'FENCE: the writer cannot read outbox_events (SQLSTATE %)', st;
  END;
  INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id, outbox_event_id)
  VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
          '0d000000-0000-0000-0000-00000000000a','0e000000-0000-0000-0000-000000000002');
  RAISE NOTICE 'DEFECT CONFIRMED (stronger): the cross-business parent was accepted by a writer that cannot even READ the parent table';
END $$;
