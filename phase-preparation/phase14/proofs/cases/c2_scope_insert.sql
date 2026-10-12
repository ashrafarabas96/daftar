-- owner: the fix — INSERT scoped to columns the merchant may actually set.
-- CHALLENGE P3-08: this set is ILLUSTRATIVE and is deliberately NOT quoted as
-- §11.1's, because §11.1's daftar_app INSERT cell reads "see below" and the
-- prose below it never enumerates a set — it says only what is NOT in it. That
-- gap is recorded in §11.1 itself and routed with TL-P14-SEC-01, since "which
-- principal may write a key digest" is the same question as "which principal
-- holds the plaintext". What this case proves is scope-independent: narrowing
-- INSERT by column refuses the forgery that an unqualified grant permits.
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
