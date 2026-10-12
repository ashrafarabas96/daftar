# P14-AMENDMENT-13 — CHALLENGE ROUND 9, AND THE TOOLING STOPPING RULE

Status: **PREPARED / NOT PROMOTED**. `READY_TO_PROMOTE = NO`, unsigned. Round
9's reviewed head is `2b5d19f`; this amendment is written against the head that
answers it, which no reviewer has seen.

| report | sha256 | bytes |
|---|---|---|
| `P14-CHALLENGE-2b5d19f.md` | `187a719a03c6ca76cc898ecfb736b95c4cc5a0dc67b80a4d315c1e5620045e9a` | 13,392 |

Verdict: **PASS-WITH-SCOPE at `2b5d19f` only**. Both round-8 P2s confirmed
closed **in the checkout that produced them** — a pack under `/tmp`, which is
the measurement I could not make myself. Two new P2s, two P3s.

---

## 1 — R9-P2-02: THE ESCAPE HATCH WAS REACHABLE BY CORRUPTING THE THING IT PROTECTED

Round 8 added a refusal: `--write` will not re-sign a `P14-CHALLENGE-*` row
whose file has drifted, because a reviewer's digest is evidence. To keep a
newly added row signable I made the unsigned placeholder **sixty-four zeros** —
which is a well-formed digest. One `sed` defeated the refusal:

```
append a retracted sentence to P14-CHALLENGE-7af6438.md
  --check 1    --write 1 (REFUSING to re-sign)    --check 1
set that row's digest to sixty-four zeros
  --write 0    --check 0    retracted-claims 0        ← the tampered report now has a valid row
```

Two remedies, both taken, and the coordinator's wording is the stronger rule:
**any transition of an already-signed reviewer row is a refusal, in either
direction.**

> **CORRECTED BY `CHALLENGE R10 P2-01` (BLOCKING).** That sentence, and point 2
> below — *"a **committed** reviewer digest may not move"* — were **wider than
> what was enforced**. The guard compared the row against **HEAD** only, so one
> ordinary `git commit -am` of the `UNSIGNED` row made HEAD carry the
> placeholder and the rule **disabled itself**, while still printing
> *"reviewer-row history checked"*; and outside a repository the two-step bypass
> survived as a disclosed-but-open limit. Both round-9 red proofs covered only
> **uncommitted** transitions, which is why the gap was invisible from here. The
> rule as now enforced, and as measured, is in
> `P14-AMENDMENT-14-CHALLENGE-ROUND-10.md`: a reviewer's report is held to the
> copy in the **other directory** and to **every revision** of the manifest, and
> with neither witness available nothing may be signed at all.

1. The placeholder is now the literal `UNSIGNED`, in **both** cells, which
   corrupting a digest cannot produce. A row with one placeholder cell and one
   real one is not a placeholder — the tell the reviewer measured was exactly
   that: `000000000000` beside `17,898 bytes` while the file was 17,962.
2. A **committed** reviewer digest may not move. The manifest's own history
   answers it: `git show HEAD:P14-HANDOFF-MANIFEST.md`. When the manifest is not
   in a repository this cannot be asked, and the tool now prints
   *"reviewer-row history NOT CHECKED (the manifest is not in a git repository
   here)"* — a **stated limit**, because a verdict that changes silently with
   the location is round 8's defect.

Both halves are committed red proofs (`reviewer-row-resign`,
`reviewer-row-unsign`), and the second asserts the refusal's own sentence, not
just its exit code.

**And the reviewer's framing is accepted:** this is the second round where a
protection I credited to a mechanism was in fact being carried by the
**two-directory construction** — the manifest pinned to the pack, checked
against both the pack and the shared folder, so a forged row in one is
contradicted by the other. That construction is named as the protection it is,
in `P14-GATE-035`.

---

## 2 — R9-P2-01: A PROOF NAMED FOR A REFUSAL IT DOES NOT FIRE

`citation-provenance.py` has **five** reachable refusals, and all five answer
`2`:

| refusal | message |
|---|---|
| `--repo` is not a repository | *is not a git repository* |
| it is a repository without the declared base | *does not contain `93084f8`* |
| the pack is outside `--repo` (the round-7 remedy) | *is not inside `--repo`* |
| the table is empty | `MEASUREMENT EMPTY` |
| a cited file is on disk and unresolved | `MEASUREMENT INCOMPLETE` |

I had applied message assertions to the last two only. So, measured by the
reviewer: my `provenance-foreign-repo` proof — `mktemp -d` + `git init`, named
and commented for the escaping-pathspec refusal — actually fired *does not
contain `93084f8`*, and **deleting the `git init` left the proof passing while
it fired a different refusal again**. Worse, the round-7 remedy itself, the
ancestry refusal, **had no red proof anywhere**.

All five are now `named()` proofs, each with its own world and its own required
sentence, and each named for what it fires:
`provenance-not-a-repo`, `provenance-repo-without-base`,
**`provenance-pack-outside-repo`** (new: a repository that carries the
revisions, with the pack outside it), `provenance-empty-table`,
`provenance-floor`. That closes `COORD P3-07` for the whole provenance lane. It
stays OPEN for the SQL proofs, where an expected SQLSTATE or law name per
`ORDER` line changes every red-proof line.

---

## 3 — R9-P3-01 AND R9-P3-02

**A gate that could not run read exactly like a gate that failed.** In the
reviewer's container `/tmp/claude-0` is `drwx------ root`, so the unprivileged
account could not read the pack and `replay` and `redproof-preflight` reported
`rc=1` from all four directories; they nearly filed a container permission
problem as a pack defect. `gate()` discarded stdout and stderr, so the line
carried no diagnosis — and the revert line named *"the sweep left the box
broken"* when the cluster was up and answering `select 1`. Now: the first line
of output is printed beside every failure, an unrunnable gate is reported as
**`UNRUNNABLE … this gate never asked its question`** (still a failure —
fail-closed — but a different state), and the revert check **asks the cluster**
before naming it. This paid for itself within the hour: the first run after the
change reported `FAIL replay … == recreating p14scratch` and
`FAIL redproof-preflight … the MUTATION did not apply`, which showed me at once
that my own earlier interactive plants had left the cluster dirty rather than
that anything in the pack was wrong.

**The version arm is now fenced most of the way** (`R9-P3-02`, offered as a
remedy rather than raised as a defect). Its purpose is to prove the assertion
fires: the `160000/170000` bound is mutated in a **copy** of `preflight.sql`,
the specific abort *“is not PostgreSQL 16”* is required, exit `3`. It is still
**UNFENCED** for the narrower claim that a real PostgreSQL 17 cluster is
refused, and that note stays in `redproof-preflight.sh`.

---

## 4 — THE TOOLING STOPPING RULE

Recorded as a **coordinator ruling** (relayed 2026-10-12T17:00Z), matching what
Phase 4 adopted at `S7 C1`. It is not the owner's word, and the owner can
override it:

> **The next round is the last tooling round for Phase 14.** After it, any
> finding that is neither a **false sentence** nor a **fail-open on a gate** is
> recorded as a named residual and does not open another round.

The reason is the standing caveat, which nine rounds have not changed: the
architecture is **unexecuted** — no API, no DDL, no routes, no CI — so every
finding lands on documents, instruments and proofs, and more rounds on the proof
tooling no longer buy correctness. **None of these nine rounds is credit against
the first round run on an executed Phase 14, and that round should be expected
to be the worst yet.**

Also recorded in `P14-TASK-DAG.md` beside `P14-GATE-035`.

— Phase 14 author, round 9 answered, 2026-10-12
