-- FINDING (AL-31, the other direction): app.bypass_rls relaxes only the
-- RESTRICTIVE half. A caller still needs a PERMISSIVE policy to admit it, so
-- bypass alone is NOT a god-mode read on this idiom.
SET app.bypass_rls = 'on';
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM p14s.webhook_deliveries;
  IF n <> 0 THEN RAISE EXCEPTION 'FINDING REFUTED: bypass alone read % rows', n; END IF;
  RAISE NOTICE 'FINDING CONFIRMED: bypass alone reads 0 rows (no PERMISSIVE policy admits this caller)';
END $$;
-- FENCE proper: satisfy the PERMISSIVE tenant_membership policy as well
SET app.tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001';
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM p14s.webhook_deliveries;
  IF n <> 2 THEN RAISE EXCEPTION 'FENCE FAILED: % rows, expected 2', n; END IF;
  RAISE NOTICE 'FENCE: % rows provably exist — a 0-row worker read is a refusal, not an empty table', n;
END $$;
