-- DEFECT (TL-P14-SEC-02): RLS says which rows you SEE, never which parent you
-- may NAME. A business-1 delivery can cite a business-2 outbox event and the
-- global FK accepts it.
SET app.tenant_id   = 'aaaaaaaa-0000-0000-0000-000000000001';
SET app.business_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE n INT;
BEGIN
  -- FENCE: the foreign parent must be INVISIBLE to this caller, so the write is
  -- genuinely naming a row it cannot read
  SELECT count(*) INTO n FROM p14s.outbox_events
   WHERE id='0e000000-0000-0000-0000-000000000002';
  RAISE NOTICE 'FENCE: the foreign parent is visible to this caller: % row(s) (outbox_events has NO RESTRICTIVE policy)', n;

  INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id, outbox_event_id)
  VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
          '0d000000-0000-0000-0000-00000000000a','0e000000-0000-0000-0000-000000000002');
  RAISE NOTICE 'DEFECT CONFIRMED: a business-1 delivery NAMED a business-2 outbox event and the FK accepted it';
END $$;
