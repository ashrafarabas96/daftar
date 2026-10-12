-- owner: the corrected grant (the lookup column included)
GRANT SELECT (secret_sha256, expires_at, revoked_at, tenant_id, subject_user_id, revoke_scheduled)
  ON p14s.api_keys TO p14_resolver;
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM information_schema.column_privileges
   WHERE grantee='p14_resolver' AND table_name='api_keys' AND privilege_type='SELECT'
     AND column_name='secret_sha256';
  IF n <> 1 THEN RAISE EXCEPTION 'MUTATION DID NOT LAND: secret_sha256 grant rows = %', n; END IF;
  RAISE NOTICE 'LANDED: secret_sha256 now granted';
END $$;
