-- owner: the 0014/0020 pattern, but the STRICTER variant Phase 14 recommends —
-- the role disjunct in USING ONLY, never in WITH CHECK
DROP POLICY business_isolation ON p14s.webhook_deliveries;
CREATE POLICY business_isolation ON p14s.webhook_deliveries AS RESTRICTIVE FOR ALL
  USING      (p14s.app_bypass() OR business_id::text = p14s.app_business()
              OR current_user = 'p14_worker')
  WITH CHECK (p14s.app_bypass() OR business_id::text = p14s.app_business());
DO $$
DECLARE u TEXT; c TEXT;
BEGIN
  SELECT qual, with_check INTO u, c FROM pg_policies
   WHERE tablename='webhook_deliveries' AND policyname='business_isolation';
  IF position('p14_worker' in u) = 0 THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: USING lacks the disjunct'; END IF;
  IF position('p14_worker' in c) > 0 THEN
    RAISE EXCEPTION 'MUTATION WENT TOO FAR: WITH CHECK carries the disjunct'; END IF;
  RAISE NOTICE 'LANDED: disjunct in USING only (WITH CHECK untouched)';
END $$;
