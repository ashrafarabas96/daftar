# P14 — AMENDMENT 17: the challenger's round-12 narrow check at `8f6c849`, answered

**Status: `PREPARED / NOT PROMOTED`. DOCS ONLY. ALL GATES UNMEASURED.**
**Base `93084f8`. Branch `claude/project-thread-1zqgj8`, cut from `6fc505d`; committed and
pushed on that branch only. No product code, no migration, no migration number.**
No timing or performance claim is made anywhere in this pack.
**Unsigned.** An author does not sign their own work.

| review | file, as received | verdict |
|---|---|---|
| **Independent challenger**, round 12, narrow check at `8f6c849` | `P14-CHALLENGE-8f6c849.md`, sha256 `34ccc01bc042…14a9aef9`, 12,292 bytes | **REJECT (scoped)** — one blocking finding, one fail-open, two P3s |

Committed unedited, with a row in `P14-HANDOFF-MANIFEST.md` §2. The coordinator relayed the
same blocker independently, with the same remedy (*ask the tree, not the blob*); both are
answered here in one commit, as asked.

The report also records what it closed by execution at this head, and I do not restate those
measurements as mine: `P2-01-bis` **1** against the previous tool's **0** on an identical plant,
the shallow opt-in that cannot hide its limit, `R11-P2-02` and `R11-P3-01`. Those are the
challenger's runs in the challenger's container.

---

## 1. `R12-P1-01` (BLOCKING) — a missing blob is not a deletion

**The defect, in one sentence.** Amendment 16 split "cannot read a revision" into *a deletion,
which erases nothing* and *a missing object, which is `NOT CHECKED`* — and then asked git a
question that cannot tell them apart. `git cat-file -e <rev>:<path>` fails both when the path is
absent from that tree and when the path is **there** with its blob unavailable, and the code read
the second as the first: the revision was recorded as a gap, the walk continued, and the line
printed was

> reviewer-row history **checked** over every revision of the manifest, OLDEST first, and the
> manifest is **ABSENT** in 1 of them … removed and re-added, which does not erase the records
> before it

with a forged reviewer row passing at **0**, no flag passed and no limit announced. Two sentences
there are false as measured — the manifest is not absent in that revision, and the records before
it *were* erased from the witness — which is this pack's own doctrine inverted and the fourth
appearance of the class **a sentence wider than the measurement under it**.

**Who can cause it.** Not a forger reaching into the verifier's machine: object *unavailability*.
A `--filter=blob:none` partial clone whose promisor is unreachable, which is an ordinary CI shape
for a large repository; a pruned or corrupt object. The gate's promise is that it cannot be made
to say *checked* when it has not checked, and that promise was breakable without any forgery at
all.

**The fix.** Ask the **tree**, which needs no blob:

| what git is asked | genuine deletion revision | tree entry whose blob is gone |
|---|---|---|
| `git ls-tree --name-only <rev> -- P14-HANDOFF-MANIFEST.md` | prints nothing | prints `P14-HANDOFF-MANIFEST.md` |

So a gap is recorded **only** when `ls-tree` is empty; an entry that cannot be read is
`NOT CHECKED` (*"revision … lists this manifest but its content could not be read — the object is
missing, pruned, or in an unreachable promisor"*), and an `ls-tree` that itself fails is
`NOT CHECKED` with its own sentence. Both discard `signed_history` and `moved`, and under
Amendment 16's rule `NOT CHECKED` refuses. `git rev-parse <rev>:<path>` was **not** used: the
challenger measured that it exits 0 and echoes the string for a deleted path.

**Measured, by me, in a real partial clone** — pack copied to a scratch origin with
`uploadpack.allowFilter`, one reviewer report tampered and its row hand-forged, cloned with
`--filter=blob:none`, then the promisor pointed at a path that does not exist. The premise was
asserted before any verdict: the oldest revision's tree **lists** the manifest and
`git show` of it exits **128**.

| code under test | rc | what it printed |
|---|---|---|
| **`8f6c849`** (the tool extracted from the previous head) | **0** | *history **checked** over every revision … **ABSENT** in 1 of them (81a2b9dc17e2)* and *every artifact row matches* |
| **this head** | **1** | `HISTORY NOT VERIFIED: … revision 81a2b9dc17e2 lists this manifest but its content could not be read — the object is missing, pruned, or in an unreachable promisor` |

Same world, two tools, **0** against **1**. Fenced by three red proofs —
`blobless-clone-refused`, `blobless-clone-write-refused` and
`blobless-optin-prints-the-limit` (rc **0**, the limit still printed, so the opt-in cannot be
used to make the tool say *checked*) — and the other half of the discrimination is fenced too:
`deletion-revision-still-skipped` requires the genuine deletion revision to still produce
*ABSENT in 1 of them* in the drop/re-add world, at rc 1. If the transport ignores the filter or
the promisor is still reachable, the proof **says the world was not built** instead of reporting
a verdict.

## 2. `R12-P2-01` (FAIL-OPEN) — in a truncated clone, deleting every review passed at 0

`HISTORY NOT VERIFIED` fired only while a reviewer row **survived** in the manifest, and the
detector that would have caught the deletion, `SIGNED REVIEWER ROW REMOVED`, reads the history
that `NOT CHECKED` empties. One condition switched off both protections, so *this manifest never
had a reviewer row* and *every one was just deleted* were indistinguishable and the permissive
reading won.

**The fix.** The refusal's own sentence names the counterpart directory as the only witness left;
it now **reads** it. When the history is `NOT CHECKED`, the gate refuses if that directory holds
reviewer reports at all, and names how many of them have no row here.

**Measured, by me**, on the challenger's world — a depth-1 clone with **every** reviewer row and
its file removed, counterpart intact. The number the strip removes is not written here: it is
whatever `tools/gate-sweep.sh`'s `shallow-every-review-deleted` proof strips at the head being
measured, and it rises with each review this pack receives. (`R13-P3-01`: the figure first typed
here was **18**, the count at the previous head, and this commit's own row for the round-12 report
made it **19** before the sentence was read. A count committed into a document is one commit
stale by construction.)

| code under test | rc | what it printed |
|---|---|---|
| **`8f6c849`** | **0** | *every artifact row matches the file on disk*, **24** rows / 24 files |
| **this head** | **1** | `HISTORY NOT VERIFIED: … and N reviewer report(s) under <counterpart> have NO ROW here (P14-CHALLENGE-08d23da…) — a manifest cannot erase the other directory`, where N is every reviewer report the pack holds at the head measured |

The challenger's figures on the old tool (rc **0**, *every artifact row matches*, **24** rows)
reproduced exactly. Fenced by
`shallow-every-review-deleted` and `shallow-every-review-deleted-names-them`.

## 3. `R12-P2-02` — the `no-cluster` proof never asserted its own premise

The sweep stopped the cluster with `pg_ctl … stop >/dev/null 2>&1`, read neither its exit code
nor anything afterwards, and then required the preflight to exit 1 **and** to say *no cluster is
listening* — while the restart two lines below **was** verified with `select 1`. The asymmetry is
the defect: with the stop not in force the proof measures a different world, and its FAIL line
can then report only a code and a missing sentence with no cause. That is the shape of the red
disclosed at `20:24:17Z`, which Amendment 16 recorded with **no cause claimed**.

The premise is now asserted first. If the cluster still answers `select 1` the sweep prints
**the stop did not take effect**, counts a failure, and **reports no verdict about the preflight**.

**And asserting it found the rest of that red, by execution.** With the premise satisfied — the
cluster genuinely down — the preflight still did not print its cause, because the `case` that
names it covered the text psql prints when the socket **file** is gone
(`No such file or directory`) and not the text it prints when the file is still there with
nothing behind it:

```
psql: error: connection to server on socket "/tmp/p14pg/sock/.s.PGSQL.54314" failed: Connection refused
```

So with the cluster stopped the script fell through the `case` and named **no cause at all** —
the seventh instance of *a refusal naming a cause that is measurably not the cause*, in its
degenerate form: no cause named where one was asked and answered. `Connection refused` and
`connection to server` now reach that branch, and an unmatched text now says so in words
(*"not classified by this script … no cause is claimed for it here"*) rather than leaving the
reader to infer one from the exit code.

## 4. `R12-P3-01` — the cluster is world state, and it was outside the trap

`rolecount-discriminates` renames `p14_merchant`; `no-cluster` stops the cluster. Neither was
inside the `trap` that restores the pack's **files**, so an interrupted sweep left the cluster
stopped or a role renamed and the next sweep measured the residue. Both are now marked while they
are in force (`PGSTOPPED`, `PGRENAMED`) and restored by `cleanup`, which runs on `EXIT`, `INT`,
`TERM` and `HUP`.

**This is not theoretical here.** The sweep run that opens this round answered **1** on `replay`
and `redproof-preflight` for one reason: the cluster was **already down** when it started,
left there by the interrupted run of `20:24:17Z`. That is the residue class this fix removes.

## 5. Found by execution while fencing the above — the gate's verdict depended on where the pack lived

The sweep's pack-under-`/tmp` lane answered **1** where the main checkout answered **0**, on the
same commit. Cause: a **linked worktree**'s git dir is `.git/worktrees/<name>`, which holds no
`shallow` file — that file belongs to the **common** git dir and is shared by every worktree. The
read raised `OSError`, the code's own fail-closed branch marked the boundary `<unreadable>`, every
revision became a boundary, and the history was `NOT CHECKED`. It is fail-**closed**, so nothing
unverified was ever accepted; it is still a gate giving two verdicts for one commit, which
`P14-GATE-035` forbids. Fixed by asking for `--git-common-dir`, which is the same path from both,
and fenced by that lane: `ok manifest-digests rc=0 with the pack at …/wt/phase-preparation/phase14`.

---

## 6. What is still open at this head

Carried forward unchanged, and none of it is closed by this commit: `COORD P3-07` on the SQL
proofs; `R10-ADD-01`; the unfenced property that a pack file in a new directory must stay out of
the PROPOSES bucket; the preflight's **version arm UNFENCED**; **concurrency and performance
UNMEASURED** in this container, by the owner's rule; `TL-P14-SEC-01/-02/-03`, §7a and §11a with
the Security and Migration Owners, no migration number named; and `OD-P14-09`, `OD-P14-10`,
`OD-P14-11` with the owner.

**Nothing in this pack is signed.** The signature that matters covers one SHA and does not
transfer to the next commit.
