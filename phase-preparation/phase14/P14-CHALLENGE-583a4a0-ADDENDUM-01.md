# ADDENDUM 01 TO `P14-CHALLENGE-583a4a0.md`

**Issued by the same challenger session**, answering two items raised by the
coordinator's diff review of the same head. Kept separate so the round-7
report's digest (`1655d5ea02cbb6eaa5a3d1ce5a2b5f13c79d2128bd9cef14234bdf2a9e20125d`)
does not move. Head: `583a4a0`. Date: 2026-10-12.

## 1. `P2-05` CONFIRMED BY EXECUTION — THE PREFLIGHT RED PROOFS PASS WITH NO CLUSTER AT ALL

The coordinator found this by reading and asked for the exit code. **It is
right, and it is worse executed than read.** With **no PostgreSQL process
running anywhere** (`pgrep -x postgres` → 0) and only an empty socket
directory present:

```
$ ./redproof-preflight.sh
ok    collation    preflight exit=2
ok    encoding     preflight exit=2
ok    bypassrls    preflight exit=2
ok    superuser    preflight exit=2
ok    rolecount    preflight exit=2
== 5 arm(s), 0 not red.  The version arm is UNFENCED (needs a second cluster).
EXIT CODE 0
```

**Five arms, none red, nothing ran, exit 0.** `2` is `psql`'s *cannot connect*,
not a refusal. `redproof-preflight.sh:31-37` decides redness by `rc -ne 0`
alone, so a connection failure, a syntax error, a missing binary and a genuine
`PRINCIPAL CLAIM FALSE` are the same outcome to it. The arm's `setup` exit code
is discarded as well (`psql_as … >/dev/null` with no check), so an arm whose
`CREATE DATABASE` never ran still counts as proved — the no-cluster run
demonstrates both halves at once.

**Why this one matters more than its severity suggests.** `P14-GATE-035`
requires `redproof-preflight.sh` to exit `0`. The gate that fences the
run-identity assertions therefore **passes most reliably when nothing is
running**, which is the same shape as everything these seven rounds have found:
an assertion that cannot distinguish "the law failed" from "the question was
never asked". It is also, precisely, the unfenced-assertion law applied to the
fence itself.

**The fix is already half-written in the script.** `arm()` captures `$out` and
greps it for `CLAIM FALSE` to print as evidence — it just does not require it.
Note the evidence column above is **blank on every line**, which is the
observable symptom: the grep matched nothing and the arm passed anyway. Two
conditions close it, and both are one line:

- require `rc -eq 3` rather than `rc -ne 0` (a genuine arm exits exactly 3 — in
  my round-7 run every real arm printed `preflight exit=3`), and
- require the `CLAIM FALSE` match to be **non-empty**, failing the arm when the
  evidence it prints is absent.
- and check the `setup` command's exit code instead of discarding it.

A third, cheap and worth having: have the script connect once before the first
arm and refuse outright if it cannot, so "no cluster" reports itself rather than
being re-described as five proofs.

## 2. THE `P3-04` COLLISION IS MINE. I MEANT ROUND 5's.

The coordinator is right that my earlier addendum's heading *"`P3-04` IS
WITHDRAWN"* is ambiguous, because it sits on an addendum to the **round-6**
report while naming a finding from the **round-5** one:

| | |
|---|---|
| **`R5-P3-04`** — *"a reproduction step that does not work on this image"* (`locale-gen`) | **WITHDRAWN.** False, and never executed before I wrote it. |
| **`R6-P3-04`** — *"two misclassifications in the proposed-files bucket"* | **NOT withdrawn.** It was open at `2430504`, the author answered it at `583a4a0` by classifying buckets by measurement, and the coordinator's `P2-02` reports residue in that answer — which `P2-01` of my round-7 report independently shows is also where the cwd-dependent gate goes wrong. |

The author read it the way I meant it. The ambiguity is still my defect: I
numbered findings per round with no round prefix, so a cross-round retraction
collides with a live finding of the same number. **From here on every finding I
cite carries its round — `R5-P3-04`, `R7-P2-01` — including when I retract
one.** A reviewer who renumbers nothing has still created a second
`P3-04`.

## 3. UNCHANGED

The round-7 verdict stands at **PASS-WITH-SCOPE**, and its two open items are
unaffected: `R7-P2-01` (the provenance gate returns rc 0 only from inside the
pack's worktree and rc 1 from any neutral cwd, so `GATE-032`'s answer depends on
where CI stands) and `R7-P3-02` (the retracted *"cited only for Phase 4 surface
facts"* sentence surviving at `P14-HANDOFF-MANIFEST.md:32`, where no `--check`
can see it). `P2-05` above joins them: **three items, all three in gates rather
than in the design** — and the design is still unexecuted.

*This addendum signs nothing. `PREPARED` / `CHALLENGED` / `NOT PROMOTED`,
`READY_TO_PROMOTE` = NO.*
