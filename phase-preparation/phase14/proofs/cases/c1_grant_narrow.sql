-- owner: the narrowed grant from the V2 FINDING 2 defect (lookup column omitted)
REVOKE ALL ON p14s.api_keys FROM p14_resolver;
GRANT SELECT (key_id, id, business_id, name) ON p14s.api_keys TO p14_resolver;
-- proof-of-proof: the mutation must be shown to have landed before any arm is read
DO $$
DECLARE cols TEXT;
BEGIN
  SELECT string_agg(column_name, ',' ORDER BY column_name) INTO cols
    FROM information_schema.column_privileges
   WHERE grantee='p14_resolver' AND table_schema='p14s' AND table_name='api_keys'
     AND privilege_type='SELECT';
  IF cols IS DISTINCT FROM 'business_id,id,key_id,name' THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: SELECT columns are %', cols;
  END IF;
  RAISE NOTICE 'LANDED: resolver SELECT columns = %', cols;
END $$;
