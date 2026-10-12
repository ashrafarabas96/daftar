-- owner: RED-PROOF mutation for c2b_forgery_refused. Re-widen INSERT to the
-- whole table and the refusal arm must turn red (exit 3), proving that arm
-- tests the column scoping and not something else.
-- CHALLENGE P2-03: this mutation was previously an ad-hoc psql command, so the
-- recorded C2c-redproof exit 3 could not be reproduced from the committed files.
DELETE FROM p14s.api_keys WHERE name IN ('FORGED-BY-MERCHANT','merchant-legitimate','merchant-minimal');
GRANT INSERT ON p14s.api_keys TO p14_merchant;
DO $$
DECLARE ins TEXT;
BEGIN
  SELECT string_agg(column_name,',' ORDER BY column_name) INTO ins
    FROM information_schema.column_privileges
   WHERE grantee='p14_merchant' AND table_name='api_keys' AND privilege_type='INSERT';
  IF position('secret_sha256' in ins) = 0 THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: INSERT = %', ins; END IF;
  RAISE NOTICE 'LANDED: INSERT re-widened to [%] — the next arm must turn RED', ins;
END $$;
