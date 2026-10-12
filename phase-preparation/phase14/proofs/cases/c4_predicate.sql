-- LAW: the resolver usability predicate must be parenthesised.
-- V2 FINDING 1 defect form:  A OR B AND C OR D
-- corrected form:           (A OR B) AND (C OR D)
DO $$
DECLARE bad INT; good INT; nm TEXT;
BEGIN
  -- FENCE: the expired-never-revoked key must exist, or neither arm means anything
  SELECT count(*) INTO bad FROM p14s.api_keys WHERE name='expired-never-revoked';
  IF bad <> 1 THEN RAISE EXCEPTION 'FENCE FAILED: the expired key is absent'; END IF;

  -- the DEFECT: unparenthesised. AND binds tighter, so the whole expression is
  -- (revoked_at IS NULL) OR (revoked_at > now() AND expires_at IS NULL) OR (expires_at > now())
  SELECT count(*) INTO bad FROM p14s.api_keys
   WHERE name='expired-never-revoked'
     AND (revoked_at IS NULL OR revoked_at > now() AND expires_at IS NULL OR expires_at > now());
  IF bad <> 1 THEN
    RAISE EXCEPTION 'DEFECT NOT REPRODUCED: the unparenthesised predicate rejected the expired key';
  END IF;
  RAISE NOTICE 'DEFECT CONFIRMED: unparenthesised predicate ACCEPTS a key that expired 365 days ago';

  -- the FIX: parenthesised
  SELECT count(*) INTO good FROM p14s.api_keys
   WHERE name='expired-never-revoked'
     AND ((revoked_at IS NULL OR revoked_at > now()) AND (expires_at IS NULL OR expires_at > now()));
  IF good <> 0 THEN RAISE EXCEPTION 'LAW VIOLATED: the parenthesised predicate still accepted it'; END IF;
  RAISE NOTICE 'LAW HELD: parenthesised predicate REFUSES it (0 rows)';

  -- and the fix must not over-reject: the live key is still accepted, the revoked one is not
  SELECT string_agg(name, ',' ORDER BY name) INTO nm FROM p14s.api_keys
   WHERE (revoked_at IS NULL OR revoked_at > now()) AND (expires_at IS NULL OR expires_at > now());
  IF nm IS DISTINCT FROM 'live-never-expires' THEN
    RAISE EXCEPTION 'LAW VIOLATED: usable set is [%], expected exactly live-never-expires', nm; END IF;
  RAISE NOTICE 'LAW HELD: the usable set is exactly [%]', nm;
END $$;
