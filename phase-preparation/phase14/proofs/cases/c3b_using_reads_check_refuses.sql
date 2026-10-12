-- the USING-only disjunct admits the worker's READS ...
DO $$
DECLARE n INT; st TEXT;
BEGIN
  SELECT count(*) INTO n FROM p14s.webhook_deliveries;
  IF n <> 2 THEN RAISE EXCEPTION 'READ ARM FAILED: saw % rows, expected 2', n; END IF;
  RAISE NOTICE 'LAW HELD (read): the context-free worker now sees % rows', n;
  -- ... and WITH CHECK still refuses anything it tries to WRITE
  BEGIN
    EXECUTE $q$ INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id)
       VALUES ('22222222-2222-2222-2222-222222222222',
               'aaaaaaaa-0000-0000-0000-000000000001',
               '0d000000-0000-0000-0000-0000000000ff') $q$;
    RAISE EXCEPTION 'LAW VIOLATED: the context-free worker WROTE a row';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'LAW HELD (write): refused by WITH CHECK, SQLSTATE %', st;
  END;
  -- an UPDATE is refused the same way
  BEGIN
    EXECUTE $q$ UPDATE p14s.webhook_deliveries SET payload = '{"tampered":true}' $q$;
    RAISE EXCEPTION 'LAW VIOLATED: the context-free worker UPDATED a row';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'LAW HELD (update): refused by WITH CHECK, SQLSTATE %', st;
  END;
END $$;
