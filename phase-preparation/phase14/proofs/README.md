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
psql -U p14super -d postgres -f bootstrap.sql      # non-superuser roles + database
./replay.sh                                        # recreates the DB, loads the
                                                   # fixture, runs every case
./replay.sh c7                                     # one family only
```

**`replay.sh` IS the recipe.** It is committed, and the README points at it
rather than restating it. Round-3 `CHALLENGE P2-01` found that the one-line
`while read role script; do ./run.sh ...; done < ORDER` loop this file used to
document **exits 127 on every red proof**: a plain `read` cannot parse the
red-proof field, the pipes in it were executed as a command, and nothing in the
pack ever set the environment variable `run.sh` reads the alias from — so the
published `evidence.psv` could only have come from an **uncommitted** wrapper.
That is round-2 `P1-02`'s species living inside the harness built to close it:
**a recipe that lives in prose drifts from the driver actually used.** The fix
is to commit the driver, not to correct the prose.

`replay.sh` also **enforces the verdict**: a normal case must exit 0 and a red
proof must exit 3, and it exits non-zero if any case missed its required code,
so a replay cannot look successful while a red proof fails to turn red.

`ORDER` is whitespace-separated — `<role> <script> [redproof-alias]` — so the
third field no longer needs parsing that `read` cannot do. A line with an alias
re-runs an earlier green arm after its mutation and is recorded under that
alias, so a red proof is never confused with its green twin.

`initdb` refuses to run as root, and the socket directory must be traversable by
the uid serving the cluster — both are why the data and socket directories live
outside a root-only path.

Every role under test is `NOSUPERUSER` and `NOBYPASSRLS`. **No RLS or privilege
result here rests on a superuser session**, which is the point: a superuser
proves nothing about row-level security.

`evidence.psv` has **seven** columns, appended by `run.sh` as each case runs:

```
script | role | recorded_case | run_id | start_utc | end_utc | exit_code
```

Column 1 is the script that ran; column 3 is the recorded case id, differing
from it only for a red proof. (`CHALLENGE R3 P3-03`: this file documented six
columns after the seventh was added, so a reader parsing by position misread
every row.)

**Cross-family prerequisites are declared AND asserted.** `CHALLENGE R3 P2-02`
found that the C7 family is a **continuation of C3** — `c7_setup.sql` extends the
relation `c3_setup.sql` creates — and that nothing in the pack said so: `ORDER`
encoded the dependency only by line position, so the whole family (all of
`TL-P14-SEC-02`'s evidence) collapsed in isolation with a bare *"relation does
not exist"*, and its own proof-of-proof could not detect it because it inspected
only the constraint it adds. Every script that depends on another family's
relation now names that script in its header and opens with a `to_regclass`
assertion, so an isolated run reports `PREREQUISITE NOT MET: ... run
cases/c3_setup.sql first` instead of failing obscurely. **A precondition that
only an order file's line numbers encode is an undeclared dependency.**

**Every mutation a case depends on is performed by a committed script, and each
such script ends in a proof-of-proof** that reads the catalogue
(`information_schema`, `pg_policies`, `pg_get_constraintdef`, `prosecdef`) and
refuses to proceed unless the mutation landed. This was not true of the first
edition: four mutations were ad-hoc commands, so `c8_rotation`'s recorded exit 0
could not be regenerated and two of the four red proofs had no script. An
unfenced PRESENT result settles no more than an unfenced ABSENT one — a refusal
arm whose constraint is never proved to exist can pass for the wrong reason, or
fail for one.
