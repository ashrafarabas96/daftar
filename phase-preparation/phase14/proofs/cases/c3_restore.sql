DROP POLICY business_isolation ON p14s.webhook_deliveries;
CREATE POLICY business_isolation ON p14s.webhook_deliveries AS RESTRICTIVE FOR ALL
  USING      (p14s.app_bypass() OR business_id::text = p14s.app_business())
  WITH CHECK (p14s.app_bypass() OR business_id::text = p14s.app_business());
DO $$
DECLARE u TEXT;
BEGIN
  SELECT qual INTO u FROM pg_policies WHERE tablename='webhook_deliveries' AND policyname='business_isolation';
  IF position('p14_worker' in u) > 0 THEN RAISE EXCEPTION 'MUTATION DID NOT LAND: disjunct still present'; END IF;
  RAISE NOTICE 'LANDED: restored to USING without the worker disjunct';
END $$;
