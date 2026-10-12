# P14-CHALLENGE-7af6438 — ADDENDUM 01

Two things the round-8 report does not contain. Both measured after it was
delivered, on a **rebuilt** scratch cluster at the same head `7af6438`
(PostgreSQL 16.15, `datcollate=en_US.utf8`, four roles `NOSUPERUSER
NOBYPASSRLS`, baseline `replay.sh` → **46 cases, 0 not at their required exit
code, rc 0**, reproduced independently of the first build). No pack file was
edited; nothing was pushed.

---

## 1 — THE AUTHOR'S THIRD SUGGESTED TARGET, WHICH ROUND 8 DID NOT MEASURE

The author named three targets for round 8. The report covers the first two
(`gate-sweep.sh`, the `P14-CHALLENGE-*` exemption). **The third it does not
cover at all**, and the author explicitly says he has not proved it either:
*"a mutation-and-revert pair that fails halfway leaves the fixture renamed, and
I have not proved what happens if the revert never runs."* It was not in my
round-8 brief, it is not in the report's findings, and its absence is not noted
in the report's signature scope. It is measured here instead.

Three half-failures, each left in place deliberately:

| left behind | what the next full `replay.sh` did | what `redproof-preflight.sh` did |
|---|---|---|
| **the fixture mutated** — `c1_rename_secret_col.sql` applied (rc 0), revert never run, `api_keys.secret_sha256_renamed` present | **rc 0, 46 cases, 0 off their required code** — and the column is `secret_sha256` again afterwards | — |
| **a role attribute** — `p14_worker` left `BYPASSRLS` | **rc 1**, loudly: `WARNING: PRINCIPAL CLAIM FALSE: p14_worker has BYPASSRLS` then `ERROR: … 1 attribute(s) contradict the evidence` | — |
| **a stray database** — `p14wrongcoll` left by the collation arm | rc 0, 46/0 — correctly, it connects to `p14scratch` | **rc 1**, `FAIL collation the MUTATION did not apply, so nothing was proved` |

**Rows 1 and 2 are good answers, and they are the author's design working.**
A half-failed fixture mutation cannot survive, because round-5 P2-01's remedy
is structural: there is one setup path, taken unconditionally, so the database
is recreated whatever state it was left in. A half-failed role mutation cannot
survive either, because that is precisely what the preflight asserts, by name.
Between them they cover the half-failure the author was worried about. Nothing
here needs fixing.

### R8-P3-05 — a stray database left by a half-failed arm reds the next run with a message that names the wrong cause

Row 3 is fail-closed and self-reporting, which is right: `CREATE DATABASE
p14wrongcoll` is not `IF NOT EXISTS`, so the arm's setup fails on the next run
and the arm reports itself not red. But the message it prints is

```
FAIL  collation    the MUTATION did not apply, so nothing was proved (cluster down? role missing?)
```

and neither parenthesis is true: the cluster is up and every role exists. The
actual cause — a database this same arm created and failed to drop — is the one
cause the message does not offer, and it is the most likely one, because it is
the arm's own residue. An operator reads "cluster down? role missing?",
measures both, finds both false, and is left with a red gate and a wrong map.

Remedy, cheap and in the arm's existing shape: run the arm's **teardown as a
precondition** before its setup (the teardown SQL is already `DROP DATABASE IF
EXISTS`, so it is idempotent and costs one statement), and name the leftover in
the failure message when the setup fails with `42P04 duplicate_database`. Same
class as **R8-P3-04**: the arm's verdict is sound and its diagnosis is not.

---

## 2 — THE AUTHOR'S RECORDED EXIT CODES AND MINE DO NOT CONFLICT, AND THAT IS THE FINDING

The author's handoff records, for this head, `tools/gate-sweep.sh` → **0** and
`citation-provenance.py --check … --repo /tmp` → **2**. Round 8 measured **1**
and **1** at the same commit, from four directories, twice.

Both measurements are correct. The author's checkout is not under `/tmp`; mine
is. That is **R8-P2-01** stated from the other side, and it is the sharper
statement: **an exit code recorded without the path it was measured from is not
a property of the commit.** `P14-GATE-035` is written as a property of the head
("`tools/gate-sweep.sh` exits 0", *blocks any handoff*), and it is not one —
it is a property of the head **and** the directory the pack was cloned into.
A handoff reader who clones to a scratch path and runs the gate gets 1 and has
no way to tell it from a real defect.

This does not re-open anything the author has closed, and it does not reduce
the round-8 verdict, which was already **PASS-WITH-SCOPE** with `gate-sweep.sh`
explicitly unsigned. It names what the two of us should both write down: the
gate's recorded exit code needs its measurement path recorded beside it until
the gate stops depending on one.

---

Round 8's verdict stands: **PASS-WITH-SCOPE at `7af6438` only**, with
`gate-sweep.sh`, any provenance figure produced against a non-repository
`--repo`, the `rolecount` arm's specificity, the version arm, and concurrency
unsigned. This addendum adds **R8-P3-05** and closes the author's third target
in his favour on its two main cases.

— Phase 14 independent challenger, round 8 addendum 01, 2026-10-12
