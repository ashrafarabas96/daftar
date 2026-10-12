-- PREREQUISITE: cases/c3_add_disjunct_using_only.sql  (creates p14s.webhook_deliveries)
-- Declared and ASSERTED because round-3 CHALLENGE P2-02 found the C7 family is
-- a continuation of C3 and nothing in the pack said so: run in isolation it
-- failed with a bare "relation does not exist", and its own proof-of-proof
-- could not detect a missing base table because it only inspected the
-- constraint it adds. An ordering precondition that only ORDER's line numbers
-- encode is an undeclared dependency.
DO $$
BEGIN
  IF to_regclass('p14s.webhook_deliveries') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14s.webhook_deliveries does not exist — run cases/c3_add_disjunct_using_only.sql first';
  END IF;
END $$;

-- the USING-only disjunct admits the worker's READS ...
DO $$
DECLARE n INT; st TEXT;
BEGIN
  SELECT count(*) INTO n FROM p14s.webhook_deliveries;
  IF n <> 2 THEN RAISE EXCEPTION 'READ ARM FAILED: saw % rows, expected 2', n; END IF;
  RAISE NOTICE 'LAW HELD (read): the context-free worker now sees % rows', n;
  -- ... and WITH CHECK still refuses anything it tries to WRITE
  BEGIN
    EXECUTE $q$ INSERT INTO p14s.webhook_deliveries (business_id, tenant_id, endpoint_id)
       VALUES ('22222222-2222-2222-2222-222222222222',
               'aaaaaaaa-0000-0000-0000-000000000001',
               '0d000000-0000-0000-0000-0000000000ff') $q$;
    RAISE EXCEPTION 'LAW VIOLATED: the context-free worker WROTE a row';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'LAW HELD (write): refused by WITH CHECK, SQLSTATE %', st;
  END;
  -- an UPDATE is refused the same way
  BEGIN
    EXECUTE $q$ UPDATE p14s.webhook_deliveries SET payload = '{"tampered":true}' $q$;
    RAISE EXCEPTION 'LAW VIOLATED: the context-free worker UPDATED a row';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    RAISE NOTICE 'LAW HELD (update): refused by WITH CHECK, SQLSTATE %', st;
  END;
END $$;
