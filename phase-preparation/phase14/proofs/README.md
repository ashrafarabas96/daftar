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
psql -U p14super  -d postgres   -f bootstrap.sql   # non-superuser roles + database
psql -U p14_owner -d p14scratch -f fixture.sql     # scratch relations and rows
while read role script; do ./run.sh "$role" "$script"; done < ORDER
```

`ORDER` is the documented order, one `<role> <script>` per line; a line tagged
`|REDPROOF|<alias>` re-runs an earlier green arm after its mutation and is
recorded under the alias, so a red proof is never confused with its green twin.
`run.sh` takes the **script path** and derives the case id from it, so every row
of `evidence.psv` names the file that produced it.

`initdb` refuses to run as root, and the socket directory must be traversable by
the uid serving the cluster — both are why the data and socket directories live
outside a root-only path.

Every role under test is `NOSUPERUSER` and `NOBYPASSRLS`. **No RLS or privilege
result here rests on a superuser session**, which is the point: a superuser
proves nothing about row-level security.

`evidence.psv` is `case|role|run_id|start_utc|end_utc|exit_code`, appended by
`run.sh` as each case runs.

**Every mutation a case depends on is performed by a committed script, and each
such script ends in a proof-of-proof** that reads the catalogue
(`information_schema`, `pg_policies`, `pg_get_constraintdef`, `prosecdef`) and
refuses to proceed unless the mutation landed. This was not true of the first
edition: four mutations were ad-hoc commands, so `c8_rotation`'s recorded exit 0
could not be regenerated and two of the four red proofs had no script. An
unfenced PRESENT result settles no more than an unfenced ABSENT one — a refusal
arm whose constraint is never proved to exist can pass for the wrong reason, or
fail for one.
