# Phase 14 — executed proofs

These are the scripts behind `P14-EVIDENCE-2026-10-12.md`. They create **scratch
objects in a scratch database** and are deliberately **not** migrations: no
migration number, no migration filename, and no frozen migration is read or
written by any of them. Phase 14 has no number and may not be given one before
Phase 13 seals.

Each case asserts its law and `RAISE`s when the law does not hold, so **the exit
code is the verdict**: `0` means the law held, `3` means `psql` aborted on a
failed assertion. The red-proof cases are the exception — for those, exit `3` is
the required outcome, because a law that stays green after its mutation is not
being tested.

## Reproducing

```
locale-gen en_US.UTF-8            # the image ships only C, C.utf8, POSIX
initdb -D <data> --locale=en_US.utf8 --encoding=UTF8 -U p14super
pg_ctl -D <data> -o "-p 54314 -c listen_addresses='' -k <sock> -c fsync=off" -w start
psql -U p14super -d postgres   -f bootstrap.sql    # non-superuser roles + database
psql -U p14_owner -d p14scratch -f fixture.sql     # scratch relations and rows
./run.sh <case-id> <role> cases/<case>.sql         # appends to evidence.psv
```

`initdb` refuses to run as root, and the socket directory must be traversable by
the uid serving the cluster — both are why the data and socket directories live
outside a root-only path.

Every role under test is `NOSUPERUSER` and `NOBYPASSRLS`. **No RLS or privilege
result here rests on a superuser session**, which is the point: a superuser
proves nothing about row-level security.

`evidence.psv` is `case|role|run_id|start_utc|end_utc|exit_code`, appended by
`run.sh` as each case runs. Re-runs are appended rather than overwritten, so a
case that was wrong the first time stays visible — two of them were, and both are
written up in §4 of the evidence document rather than deleted.
