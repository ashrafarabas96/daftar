-- owner: §3's grant, VERBATIM — eight columns to the resolver
REVOKE ALL ON p14s.api_keys FROM p14_resolver;
GRANT SELECT (business_id, id, tenant_id, key_id, secret_sha256,
              subject_user_id, expires_at, revoked_at) ON p14s.api_keys TO p14_resolver;
DO $$
DECLARE cols TEXT;
BEGIN
  SELECT string_agg(column_name,',' ORDER BY column_name) INTO cols
    FROM information_schema.column_privileges
   WHERE grantee='p14_resolver' AND table_name='api_keys' AND privilege_type='SELECT';
  IF cols IS DISTINCT FROM 'business_id,expires_at,id,key_id,revoked_at,secret_sha256,subject_user_id,tenant_id' THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: granted [%]', cols; END IF;
  RAISE NOTICE 'LANDED: §3 verbatim, eight columns = [%]', cols;
END $$;
