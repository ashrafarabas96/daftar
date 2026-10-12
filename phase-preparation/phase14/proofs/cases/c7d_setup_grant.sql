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
