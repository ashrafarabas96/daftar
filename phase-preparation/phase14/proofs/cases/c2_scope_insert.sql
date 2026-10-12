-- owner: the fix — INSERT scoped to the columns the merchant may actually set
DELETE FROM p14s.api_keys WHERE name = 'FORGED-BY-MERCHANT';
REVOKE INSERT ON p14s.api_keys FROM p14_merchant;
GRANT INSERT (tenant_id, business_id, name, expires_at) ON p14s.api_keys TO p14_merchant;
DO $$
DECLARE ins TEXT;
BEGIN
  SELECT string_agg(column_name,',' ORDER BY column_name) INTO ins
    FROM information_schema.column_privileges
   WHERE grantee='p14_merchant' AND table_name='api_keys' AND privilege_type='INSERT';
  IF ins IS DISTINCT FROM 'business_id,expires_at,name,tenant_id' THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: INSERT = %', ins; END IF;
  RAISE NOTICE 'LANDED: merchant INSERT scoped to [%]', ins;
END $$;
