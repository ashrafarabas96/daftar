-- owner: the V2 FINDING 3 defect — table-wide INSERT with a narrowed SELECT
REVOKE ALL ON p14s.api_keys FROM p14_merchant;
GRANT SELECT (id, name, expires_at, revoked_at) ON p14s.api_keys TO p14_merchant;
GRANT INSERT ON p14s.api_keys TO p14_merchant;          -- unqualified "INSERT: yes"
DO $$
DECLARE sel TEXT; ins TEXT;
BEGIN
  SELECT string_agg(column_name,',' ORDER BY column_name) INTO sel
    FROM information_schema.column_privileges
   WHERE grantee='p14_merchant' AND table_name='api_keys' AND privilege_type='SELECT';
  SELECT string_agg(column_name,',' ORDER BY column_name) INTO ins
    FROM information_schema.column_privileges
   WHERE grantee='p14_merchant' AND table_name='api_keys' AND privilege_type='INSERT';
  IF sel IS DISTINCT FROM 'expires_at,id,name,revoked_at' THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: SELECT = %', sel; END IF;
  IF position('secret_sha256' in ins) = 0 THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: INSERT = %', ins; END IF;
  RAISE NOTICE 'LANDED: merchant SELECT=[%] INSERT=[%]', sel, ins;
  RAISE NOTICE 'NOTE: secret_sha256 is NOT in SELECT but IS in INSERT';
END $$;
