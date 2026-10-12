-- RED PROOF for the auth query (the challenger's required item): withdraw ONE
-- column the eight-column resolver genuinely uses and the arm that just passed
-- must turn red. A gate that passes under a narrowed grant is not testing it.
REVOKE SELECT (secret_sha256) ON p14s.api_keys FROM p14_resolver;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
              WHERE grantee='p14_resolver' AND table_name='api_keys'
                AND privilege_type='SELECT' AND column_name='secret_sha256') THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND'; END IF;
  RAISE NOTICE 'LANDED: secret_sha256 withdrawn for the red proof';
END $$;
