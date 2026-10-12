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
                                  # (localedef -i en_US -f UTF-8 en_US.UTF-8 also works)
initdb -D <data> --locale=en_US.utf8 --encoding=UTF8 -U p14super
pg_ctl -D <data> -o "-p 54314 -c listen_addresses='' -k <sock> -c fsync=off" -w start
psql -U p14super -d postgres -f bootstrap.sql      # non-superuser roles + database
./replay.sh                                        # recreates the DB, loads the
                                                   # fixture, runs every case
./replay.sh c7                                     # same, stopping after the
                                                   # last ORDER line whose
                                                   # script path CONTAINS c7
./redproof-preflight.sh                            # red-proofs the preflight's
                                                   # own arms (5 of 6)
```

**`locale-gen` is the step, and the finding against it was WITHDRAWN by its
author (`CHALLENGE R5 P3-04`, retracted in
`P14-CHALLENGE-2430504-ADDENDUM-01.md`).** The reviewer reported that
`locale-gen` *"is not present in this container"*; both this file and the
evidence document were switched to `localedef` on that word. It was a false
finding: `locale-gen` is at `/usr/sbin/locale-gen`, `/usr/sbin` **is** on the
unprivileged `claude` account's `PATH`, and the command runs and generates
`en_US.utf8`. The step is restored to what was actually executed, with
`localedef` documented as the correct alternative the reviewer used.

**This thread's own re-diagnosis was wrong too, and in the same way.** Having
measured that the binary lives in `/usr/sbin`, it wrote *"the binary is present,
the path is not"* — and never ran `command -v locale-gen` as the `claude`
account, which prints `/usr/sbin/locale-gen`. The reviewer asserted an absence
it had not executed; this thread asserted a `PATH` consequence it had not
executed. **A measurement of one fact does not license an inference about the
next one**, and the whole correction is reverted rather than kept on a second
unmeasured claim. The withdrawal is recorded here rather than silently undone,
because a reader of the earlier revision needs to know which of the two
commands was ever in doubt: neither.

**A filter chooses how far down `ORDER` the replay goes, never whether the
database is clean (`CHALLENGE R5 P2-01`).** The filtered form used to skip the
recreation, the fixture **and** the preflight, so it could not exit 0 in any
state of the database: on a fresh one the prerequisite assertions refused, and
straight after a full replay — the state a reader is actually in, because the
full run is the first documented command — `c7d_setup_grant`'s `GRANT` survived
and made `c7c_assertion_inoperable` print **`FINDING REFUTED`** about the live
`TL-P14-SEC-02` ruling. The round-3 prerequisite assertions could not catch it
because they fence the **absence** of a relation a case needs and never the
**presence** of state it needs to be absent: one direction only, which is the
shape Phase 11 paid for in its closure law. Both halves are now closed:

- there is **one setup path**, taken unconditionally, and a filter selects the
  `ORDER` prefix up to and including the last matching line — its prerequisites
  included, since `ORDER` is topologically sorted. A filter matching nothing
  exits `2`, because an empty replay is an error and not a pass;
- and `c7c_assertion_inoperable` now **asserts the absence it requires** —
  `has_table_privilege('p14_merchant','p14s.outbox_events','SELECT')` must be
  false — so if it is ever reached in the granted state it refuses with
  `PREREQUISITE NOT MET` instead of ruling on a world it is not in. Measured
  both ways: through `replay.sh` it is 43/43 and `./replay.sh c7` is 36/36 exit
  0 twice in a row; called directly on the dirty database it now exits 3 with
  the refusal rather than the false verdict.

**A leftover grant must never be able to print a verdict**, and the structural
fix alone would not have been enough: `run.sh` can still be called by hand, so
the case had to stop ruling as well as the driver had to stop allowing it.

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

`replay.sh` first runs **`preflight.sql`**, which asserts the evidence's own
run-identity claims **against the cluster** and aborts the replay if any is
false: PostgreSQL 16, `UTF8`, `datcollate = datctype = en_US.utf8`, and all four
roles under test present, `NOSUPERUSER` and `NOBYPASSRLS`. Those claims used to
live only in the evidence document's prose, verified by hand — **which is
exactly the shape that failed twice**, as ad-hoc mutations and then an ad-hoc
driver. The evidence can no longer be produced on a runtime it misdescribes.

**The preflight is itself red-proofed, by a committed script, on five of its
six arms** (`CHALLENGE R5 P3-03`). The first edition red-proofed the `BYPASSRLS`
arm only, in prose — so by this pack's own law, *an assertion that has never
failed is an unfenced assertion*, the encoding, collation, superuser and
role-count arms were unproved, and the recipe lived in prose again.
`./redproof-preflight.sh` mutates, requires the preflight to abort, and
reverts:

```
ok    collation    preflight exit=3  RUNTIME CLAIM FALSE: collation is C/C , not en_US.utf8 — a result measured on the wrong collation is OFF-TARGET
ok    encoding     preflight exit=3  RUNTIME CLAIM FALSE: encoding is SQL_ASCII, not UTF8
ok    bypassrls    preflight exit=3  PRINCIPAL CLAIM FALSE: p14_worker has BYPASSRLS
ok    superuser    preflight exit=3  PRINCIPAL CLAIM FALSE: p14_merchant is SUPERUSER
ok    rolecount    preflight exit=3  PRINCIPAL CLAIM FALSE: 3 of the 4 roles under test exist
== 5 arm(s), 0 not red.  The version arm is UNFENCED (needs a second cluster).
```

The **collation** arm is the one that matters most, because it guards the
settled deploy target: Phase 9 lost a 75-case base to a result measured on the
wrong collation. The **version** arm is **UNFENCED** and is recorded as such
rather than described as proved — proving it needs a second cluster of a
different major version, which this container does not have.

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
