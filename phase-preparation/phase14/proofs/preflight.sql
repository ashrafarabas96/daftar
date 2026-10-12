-- PREFLIGHT: the evidence's own run-identity claims, asserted by the cluster
-- instead of by prose. Round 3 found the P1-class defect twice in a row, one
-- layer up each time (ad-hoc mutations, then an ad-hoc driver). The next layer
-- up is the claims the evidence makes ABOUT the run: the PostgreSQL version,
-- the collation, and the roles' attributes were stated in a document and
-- verified by hand. A prose assertion is exactly the shape that failed twice.
-- If any claim here is false the replay stops, so the evidence cannot be
-- produced on a runtime it misdescribes.
DO $$
DECLARE v INT; enc TEXT; coll TEXT; ctype TEXT; r RECORD; bad INT := 0;
BEGIN
  SELECT current_setting('server_version_num')::INT INTO v;
  IF v < 160000 OR v >= 170000 THEN
    RAISE EXCEPTION 'RUNTIME CLAIM FALSE: server_version_num % is not PostgreSQL 16 — the settled deploy target', v;
  END IF;
  SELECT pg_encoding_to_char(encoding), datcollate, datctype INTO enc, coll, ctype
    FROM pg_database WHERE datname = current_database();
  IF enc <> 'UTF8' THEN
    RAISE EXCEPTION 'RUNTIME CLAIM FALSE: encoding is %, not UTF8', enc; END IF;
  IF coll <> 'en_US.utf8' OR ctype <> 'en_US.utf8' THEN
    RAISE EXCEPTION 'RUNTIME CLAIM FALSE: collation is %/% , not en_US.utf8 — a result measured on the wrong collation is OFF-TARGET', coll, ctype;
  END IF;
  RAISE NOTICE 'RUNTIME: PostgreSQL % , % , datcollate=% — the settled target', v, enc, coll;

  -- the roles under test: every privilege and RLS claim in the evidence depends
  -- on these four being neither superuser nor BYPASSRLS
  FOR r IN SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
            WHERE rolname IN ('p14_owner','p14_merchant','p14_resolver','p14_worker')
            ORDER BY rolname LOOP
    IF r.rolsuper THEN
      RAISE WARNING 'PRINCIPAL CLAIM FALSE: % is SUPERUSER', r.rolname; bad := bad + 1; END IF;
    IF r.rolbypassrls THEN
      RAISE WARNING 'PRINCIPAL CLAIM FALSE: % has BYPASSRLS', r.rolname; bad := bad + 1; END IF;
  END LOOP;
  SELECT count(*) INTO v FROM pg_roles
   WHERE rolname IN ('p14_owner','p14_merchant','p14_resolver','p14_worker');
  IF v <> 4 THEN
    RAISE EXCEPTION 'PRINCIPAL CLAIM FALSE: % of the 4 roles under test exist — run bootstrap.sql', v; END IF;
  IF bad > 0 THEN
    RAISE EXCEPTION 'PRINCIPAL CLAIM FALSE: % attribute(s) contradict the evidence — a superuser proves nothing about RLS', bad; END IF;
  RAISE NOTICE 'PRINCIPALS: all 4 roles under test exist, NOSUPERUSER and NOBYPASSRLS';

  -- and the session running the replay must not be a superuser session either
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE WARNING 'NOTE: preflight itself is running as a superuser (%); no CASE runs as one, which is what the evidence claims', current_user;
  END IF;
END $$;
