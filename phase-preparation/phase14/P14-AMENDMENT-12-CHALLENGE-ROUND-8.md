# P14-AMENDMENT-12 — CHALLENGE ROUND 8 AND ITS ADDENDUM, ANSWERED

Status: **PREPARED / NOT PROMOTED**. `READY_TO_PROMOTE = NO`. Nothing here is
signed; the reviewed head of round 8 is `7af6438` and this amendment is written
against the head that answers it, which no reviewer has seen.

Reviewed documents, committed unedited into this pack:

| report | sha256 | bytes |
|---|---|---|
| `P14-CHALLENGE-7af6438.md` | `2d853e577c51dfb4589b15c357fc1c509495fb14304dbe5c823a2ae7b04d2cf6` | 17,898 |
| `P14-CHALLENGE-7af6438-ADDENDUM-01.md` | `9e2e4367d7878a7308c57b59c2523228a7ec52cc68375b289a153aa22b8b81b2` | 5,249 |

Round 8's verdict: **PASS-WITH-SCOPE at `7af6438` only**, two P2 and five P3,
with `gate-sweep.sh` itself **unsigned** — because at that head it exits `1`.

---

## 1 — THE FINDING THAT MATTERS: MY GATE AND THE REVIEWER'S GATE BOTH TOLD THE TRUTH

My handoff records `tools/gate-sweep.sh` → **0** at `7af6438`. The reviewer
measured **1** at the same commit, from four directories, twice. Both
measurements are correct, and that is the finding:

> **An exit code recorded without the path it was measured from is not a
> property of the commit.**

`P14-GATE-035` is written as a property of the head — *"`tools/gate-sweep.sh`
exits 0", blocks any handoff* — and it was not one. It was a property of the
head **and** of the directory the pack happened to be cloned into. A handoff
reader who clones to a scratch path got `1` and had no way to tell it from a
real defect.

Two causes, both mine, both the same species as the defect each remedy was
written to close:

**R8-P2-01 — the red proof's mutation silently became a no-op.** The
`provenance-foreign-repo` proof passed `--repo /tmp`. `/tmp` is foreign only to
a pack that does not live under `/tmp`. In a reviewer's `mktemp -d` clone — or
any CI runner that checks out under `/tmp` — the mutation changed nothing, the
refusal could not fire, and the sweep reported this pack's own handoff gate RED.
Measured by the reviewer both ways: `--repo /home/user/daftar` → 2,
`--repo /tmp/p14fifth` → 2, `--repo /tmp` → 1, `--repo /` → 1.

**R8-P2-02 — the round-7 remedy tested path ancestry, not repository-ness.**
`os.path.relpath(pack, repo)` has no leading `..` when `--repo` is an *ancestor*
of the pack, so the round-7 refusal cannot fire; and `git()` never read
`returncode` on the `log`/`ls-tree` calls, so every git answer came back empty
and was read as data. I reproduced it in my own container without needing a
`/tmp` checkout at all: `--repo /home/user` and `--repo /` each exit **0** and
print **12 rows instead of 57** — every frozen migration gone, the one `.json`
whose difference changes a rule gone — and `--check` then calls the committed
block STALE and tells the reader to `--write`, which would commit the empty
table. Word for word the defect the round-7 comment in that same file says was
removed: **a LOCATION problem printed as a CONTENT verdict.**

### What is in this push

| remedy | where | measured |
|---|---|---|
| `--repo` must be a **git repository**, refused by name, `rc 2` | `tools/citation-provenance.py` | `--repo /tmp`, `/home/user`, `/` → **2** each (were 2, 0, 0) |
| both revisions must **exist** in `--repo`, refused by name, `rc 2` | same | a repository that is not this one → **2** (a decoy clone answers every `ls-tree` with nothing) |
| the table must be **non-empty**, refused by name, `rc 2` | same | `--base <root commit>` → **2** |
| a **floor derived from source, not typed**: every cited token that exists in `--repo`'s working tree must have resolved | same | the filesystem is an independent witness; "the file is on disk but git answered nothing" is the exact shape of the defect, and a typed expected row count would be the hand-kept list again |
| the foreign repository is **constructed** (`mktemp -d` + `git init`), not named | `tools/gate-sweep.sh` | the proof is now about the property, not about this host's layout |
| two new red proofs: a **non-repository ancestor** of the pack, and an **empty table** | same | both `rc 2` |
| every file mutation must have **changed its target** and been **restored** | same | `red()` now carries `arm()`'s own discipline; a no-op mutation fails the proof instead of passing it |
| the four-directory property is **asserted**, not reported (`R8-P3-03`) | same | outside a checkout `$REPO` is empty and the worktree is silenced, so three gates printed *"identical from 2 directories"* and nothing required four |
| **the absolute directory is printed beside every exit code** (coordinator relay) | same | so this class cannot be recorded away again |
| **a fifth lane in which the PACK ITSELF is under `/tmp`** (coordinator relay) | same | running the gates *from* `/tmp` was never the same property: every command named the pack by absolute path, so the pack stayed outside `/tmp` in all four lanes and the failing case could not appear |

---

## 2 — THE SMALLER FINDINGS

**R8-P3-01 — a population figure that counted what it exempted.**
`retracted-claims.py` printed *"enforced across 32 pack document(s)"* while 32
included the challenge reports it had just skipped. This is round 6's finding
about the provenance generator, reappearing in the tool written to fence prose.
Enforced and exempt are now counted separately: *7 retracted claim(s) enforced
across 22 pack document(s); 9 challenge report(s) exempt in code.*

**R8-P3-02 — an absent `--dir` refused by traceback.** The shared folder is the
input most likely to be missing in CI, where a `FileNotFoundError` reads as a
broken tool rather than a failed gate. `--manifest` and `--dir` are now checked
first and refused by name with `rc 2`: *"This is not a stale manifest and must
not be read as one."*

**R8-P3-03** — see the table above.

**R8-P3-04 — the `rolecount` arm asserted a count, not a name.** The reviewer
renamed `p14_merchant` instead of `p14_resolver` and the arm still printed `ok`,
because the required message was *"3 of the 4 roles under test exist"*. The law
was never affected — `preflight.sql` counts a hard-coded four-name list, so any
absence aborts — but the proof did not discriminate and the operator was not
told which role to create. `preflight.sql` now names the absent roles
(*"1 of the 4 roles under test are ABSENT (p14_resolver)"*) and the arm requires
its own role by name. **Proved both ways:** renaming `p14_resolver` → `ok`,
rc 0; renaming `p14_merchant` instead → `FAIL … the required message is absent`,
rc 1. The discrimination is now a committed proof in `gate-sweep.sh`.

**R8-P3-05 (addendum) — the arm's own residue diagnosed as two wrong causes.**
A stray `p14wrongcoll` left by an interrupted run made the next run red —
correctly — with *"the MUTATION did not apply, so nothing was proved (cluster
down? role missing?)"*, when the cluster was up and every role existed. The one
cause the message did not offer was the arm's own leftover. Now: the cluster's
own error is printed, `42P04` is named with the command that clears it, and an
**idempotent teardown runs as a precondition**, so the arm is re-runnable rather
than merely self-reporting. Measured: with `p14wrongcoll` planted,
`./redproof-preflight.sh collation` → `ok`, rc 0.

---

## 3 — WHAT THE REVIEWER'S FOUR PLANTED ATTACKS ESTABLISHED, AND THE ONE THING THEY DID NOT

Held: a stopped cluster fails the preflight (`5 arm(s)` reporting *the MUTATION
did not apply*, rc 1); a mutation replaced by `SELECT 1` is caught
(*"preflight exit=0 — not an assertion failure"*); a fifth working directory
carrying a decoy `citation-provenance.py` that exits 0 produces byte-identical
output, because `python3 -I` and the `$HERE`/`$PACK`/`$REPO` derivation defeat
both decoys.

**Not held, and the credit was mine wrongly taken.** Tampering with a committed
reviewer's report and re-running `--write` to re-sign its row turned both prose
gates green. What caught it was neither of them: `--manifest` is pinned to the
pack while `--dir` is not, so one manifest is checked against **two
directories** and the shared folder contradicted the re-signed row
(`3eab4bbf`/10,433 against `1655d5ea`/10,369). `P14-GATE-035` credited
`retracted-claims.py`. The wording is corrected, and `--write` now **refuses to
re-sign a `P14-CHALLENGE-*` row** — a reviewer's digest is evidence, and a digest
that no longer matches means the FILE changed.

---

## 4 — THE STANDING CAVEAT, UNCHANGED AND CARRIED

Eight rounds, and no finding has landed against the architecture. That is not
because the architecture is sound: it is because the architecture is
**unexecuted** — no API, no DDL, no routes, no CI. Every finding of these eight
rounds has landed on documents, instruments and proofs. **None of them is credit
against the first round run on an executed Phase 14, and that round should be
expected to be the worst yet.**

— Phase 14 author, round 8 answered, 2026-10-12
