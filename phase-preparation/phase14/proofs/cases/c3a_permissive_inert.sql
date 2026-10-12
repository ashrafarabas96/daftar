-- LAW AL-31: a RESTRICTIVE policy is not bypassed by adding a PERMISSIVE one.
-- The worker has NO app.business_id and NO bypass, exactly withWorkerTransaction.
DO $$
DECLARE n INT;
BEGIN
  IF current_setting('app.business_id', true) IS NOT NULL
     AND current_setting('app.business_id', true) <> '' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: a business scope is set'; END IF;
  SELECT count(*) INTO n FROM p14s.webhook_deliveries;
  IF n <> 0 THEN
    RAISE EXCEPTION 'LAW VIOLATED: the PERMISSIVE policy admitted % row(s) past the RESTRICTIVE one', n;
  END IF;
  RAISE NOTICE 'LAW HELD: 0 rows — PERMISSIVE worker_delivery is inert against RESTRICTIVE business_isolation';
END $$;
