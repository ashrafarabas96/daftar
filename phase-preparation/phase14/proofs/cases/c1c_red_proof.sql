-- owner: red proof — withdraw ONLY the lookup column and the arm that just
-- passed must turn red, proving the arm tests the grant and nothing else
REVOKE SELECT (secret_sha256) ON p14s.api_keys FROM p14_resolver;
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.column_privileges
   WHERE grantee='p14_resolver' AND table_name='api_keys' AND privilege_type='SELECT'
     AND column_name='secret_sha256';
  IF n <> 0 THEN RAISE EXCEPTION 'MUTATION DID NOT LAND: still granted'; END IF;
  RAISE NOTICE 'LANDED: secret_sha256 revoked for the red proof';
END $$;
