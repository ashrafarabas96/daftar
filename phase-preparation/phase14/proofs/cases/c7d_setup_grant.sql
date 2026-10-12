-- PREREQUISITE: cases/c7_setup.sql  (creates p14s.outbox_events)
-- Declared and ASSERTED because round-3 CHALLENGE P2-02 found the C7 family is
-- a continuation of C3 and nothing in the pack said so: run in isolation it
-- failed with a bare "relation does not exist", and its own proof-of-proof
-- could not detect a missing base table because it only inspected the
-- constraint it adds. An ordering precondition that only ORDER's line numbers
-- encode is an undeclared dependency.
DO $$
BEGIN
  IF to_regclass('p14s.outbox_events') IS NULL THEN
    RAISE EXCEPTION 'PREREQUISITE NOT MET: p14s.outbox_events does not exist — run cases/c7_setup.sql first';
  END IF;
END $$;

-- owner: TL-P14-SEC-02 option (A)'s grant — the read that makes an
-- invoker-rights assertion operable at all. Scripted (CHALLENGE P2-03: C7d's
-- recorded exit 0 depended on a grant performed by hand, so it exited 3 on
-- re-run).
GRANT SELECT ON p14s.outbox_events TO p14_merchant;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                  WHERE grantee='p14_merchant' AND table_name='outbox_events'
                    AND privilege_type='SELECT') THEN
    RAISE EXCEPTION 'MUTATION DID NOT LAND: no SELECT on outbox_events'; END IF;
  RAISE NOTICE 'LANDED: option (A) grant in place — the writer can now read the global ledger';
END $$;
