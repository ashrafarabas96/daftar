-- owner: RED-PROOF mutation for c3a_permissive_inert. Re-add the worker
-- disjunct to the RESTRICTIVE USING and the 0-row arm must turn red (exit 3).
-- CHALLENGE P2-03: previously an ad-hoc command; the recorded C3c-redproof
-- exit 3 could not be reproduced from the committed files.
DROP POLICY business_isolation ON p14s.webhook_deliveries;
CREATE POLICY business_isolation ON p14s.webhook_deliveries AS RESTRICTIVE FOR ALL
  USING      (p14s.app_bypass() OR business_id::text = p14s.app_business()
              OR current_user = 'p14_worker')
  WITH CHECK (p14s.app_bypass() OR business_id::text = p14s.app_business());
DO $$
DECLARE u TEXT;
BEGIN
  SELECT qual INTO u FROM pg_policies
   WHERE tablename='webhook_deliveries' AND policyname='business_isolation';
  IF position('p14_worker' in u) = 0 THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: USING lacks the disjunct'; END IF;
  RAISE NOTICE 'LANDED: disjunct re-added to USING — the next arm must turn RED';
END $$;
