# P14 — INDEPENDENT CHALLENGE, narrow check at `03b3a0b`

**Round 13 (narrow check).** Reviewer: the independent Phase 14 challenger, own container, own
clones, own cluster. **Verdict: `PASS-WITH-SCOPE`.** Nothing blocking. Both of round 12's
findings are closed, each measured old-tool-against-new in one world, and every new red proof
reds when its own guard is deleted. One new P2 residual and three P3s below.

- **Head checked:** `03b3a0bd2ddfcb7d3e83a9625c909c27e0ec0934`, pinned with
  `git ls-remote origin claude/project-thread-1zqgj8` before anything was read, equal to the
  fetched ref. Delta `8f6c849..03b3a0b` = **9 files, 562 insertions, 18 deletions**.
- **My round-12 report is committed unedited:** `P14-CHALLENGE-8f6c849.md` hashes
  `34ccc01bc0423862d40bc93785b897536b80dcb406e4223012223f6814a9aef9` in the pack and in the
  shared folder — the same digest I announced.
- **Cluster:** PostgreSQL **160015**, `datcollate = en_US.utf8`, `initdb` and every `psql` as the
  unprivileged `claude` account, port 54314.
- Every exit code is recorded with the directory it was measured from.

---

## 1. `R12-P1-01` — closed, in a real `--filter=blob:none` clone with a dead promisor

The clone is genuine, not simulated: a scratch origin with `uploadpack.allowFilter`, cloned with
`--filter=blob:none` over `file://`, then `remote.origin.url` pointed at a path that does not
exist. **Premise asserted before any verdict:** `promisor=true`, `partialclonefilter=blob:none`,
`is-shallow-repository=false`; for the oldest revision of the manifest `git show` exits **128**
while `git ls-tree --name-only` prints the entry. The reviewer report is tampered and its row
hand-forged, **and the counterpart copy is made to agree**, so the two-directory witness cannot be
the refuser — the history is the only thing that can speak.

| code under test | rc | what it printed | measured from |
|---|---|---|---|
| **`8f6c849`** (extracted from the previous head) | **0** | *history **checked** over every revision … **ABSENT** in 2 of them* and *every artifact row matches* | `…/scratchpad/pc/blobless` |
| **`03b3a0b`** | **1** | `NOT CHECKED (revision 52394654f151 lists this manifest but its content could not be read — the object is missing, pruned, or in an unreachable promisor)` + `HISTORY NOT VERIFIED` | `…/scratchpad/pc/blobless` |

**Their controls, re-measured independently.** Two scratch repositories, three commits each:

| world | rc | result | from |
|---|---|---|---|
| deletion revision **and** a forged re-add, full clone | **1** | `REVIEWER ROW REWRITTEN IN HISTORY … recorded as f035b6b8f692 … (c5f5fbcdd0b6) records af12f9b3572f`, history line still records *ABSENT in 1 of them (4a5356329f26)* | `…/pc/full` |
| deletion revision, **no** forgery (the row re-added as received) | **0** | *every artifact row matches*, *ABSENT in 1 of them (b1c8b8144b33) — removed and re-added* | `…/pc/full2` |

So the genuine deletion is still skipped and recorded, and the drop/re-add forgery still reds.
The discrimination is real, not asserted.

An earlier run of mine answered **1** on the old tool too — because I had left the counterpart
copy holding the *received* bytes, so `REVIEWER COPIES DIFFER` was the refuser and the history
never spoke. The table above is the re-run with that corrected; I record the slip because an
exit code whose refusal is not the one you are testing is worth nothing.

## 2. `R12-P2-01` — closed: the counterpart directory is read now

Depth-1 clone of this head, counterpart intact, **every** reviewer row and file removed from the
pack copy:

| code under test | rc | result | from |
|---|---|---|---|
| **`8f6c849`** | **0** | *every artifact row matches the file on disk* | `…/scratchpad/sh19` |
| **`03b3a0b`** | **1** | `HISTORY NOT VERIFIED: … and 19 reviewer report(s) under <counterpart> have NO ROW here (…) — a manifest cannot erase the other directory` | `…/scratchpad/sh19` |

## 3. `R12-P2-02` — closed: the premise is asserted, and I broke it to see

I neutered the stop in a clone I control (`pg_ctl … stop` replaced by `:`, mutation asserted to
have landed) and ran the full sweep with the cluster deliberately left up:

```
FAIL  no-cluster   the stop did not take effect — the cluster still answers `select 1`, so
      this proof would have measured a DIFFERENT world than the one it names, and
      no verdict about the preflight is reported from here.
rc=1, and no-cluster is the ONLY failure   (measured from /tmp/mutrepo/phase-preparation/phase14)
```

That is the remedy I asked for, including the part that matters most: it reports **no** verdict
about the preflight rather than a wrong one. The author's own additional find — that with the
cluster genuinely down psql says `Connection refused` when the socket file survives, so the
`case` that names the cause was never reached — is in the code at `redproof-preflight.sh:120`,
covering `Connection refused` and `connection to server` as well as `No such file or directory`.

## 4. `R12-P3-01` — closed: the cluster is inside the trap

Measured by interrupting a real sweep. To make the window deterministic I added a 25-second
`sleep` immediately after the stop (a timing instrument; it changes when the signal lands, not
what the trap does) and sent **SIGTERM to the sweep's own pid**:

| what | result |
|---|---|
| sweep's output | `TERMINATED: restoring the pack and leaving.` |
| exit code | **143** |
| the cluster afterwards | answers `select 1` |
| `p14_merchant` | present, not `p14_merchant_x` |
| the pack's files | `git status --porcelain` 0 lines (excluding my own instrument) |

My first two attempts showed the cluster left down. Both were my instrument's fault: I signalled
the wrapper of a `cd … && bash …` compound, not the script, so no trap ever ran and the 143 was
bash's default. Recorded because the difference between *the trap failed* and *the signal never
arrived* is exactly the kind of thing that becomes a false finding.

## 5. Their self-found fix — one commit, two verdicts

A linked worktree's git dir holds no `shallow` file; it belongs to the common dir. Measured at
this head:

| tool | run from | history verdict |
|---|---|---|
| **`8f6c849`** | the linked worktree | **NOT CHECKED** (*revision 08d23da4e850 is the shallow boundary*) |
| **`03b3a0b`** | the linked worktree | **checked over every revision** |
| **`03b3a0b`** | the main checkout, same pack | **checked over every revision** |

The two now agree, and I checked that the agreed verdict is the **right** one rather than merely
consistent: `/home/user/daftar/.git/shallow` lists five commits, `08d23da4e850` is **not** among
them, its single parent `6fc505d` is present, and that parent does not carry the manifest — so
`08d23da4e850` really is the commit that added it and the history really is complete here. The
old tool's `NOT CHECKED` was the false verdict of the two.

## 6. Their figures, reproduced

From a world-readable clone (`/tmp/mutrepo`), with the cluster up:

| what | result | from |
|---|---|---|
| `tools/gate-sweep.sh` (full) | **0**, **44 ok**, 0 FAIL | `/tmp/mutrepo`, `/tmp/mutrepo/…/phase14`, `/tmp` — identical from all three |
| `proofs/replay.sh` | **0** — *46 case(s) replayed, 0 not at their required exit code* | `/tmp/mutrepo/…/phase14` |
| `proofs/redproof-preflight.sh` | **0** — *5 arm(s), 0 not red*, version arm **UNFENCED** | `/tmp/mutrepo/…/phase14` |
| `manifest-digests.py --check`, pack and shared folder | **0** / **0**, **44 rows / 44 files** each | `/tmp/mutrepo/…/phase14` |

In my own `/tmp/claude-0` scratchpad the sweep still answers **1** with `Permission denied`
failures, because that directory is `drwx------ root` and the unprivileged account cannot read a
pack inside it. That is my container's layout and not the pack's defect — third round running, so
it is written here to save the next reader the diagnosis.

## 7. Each new red proof, tested by deleting the guard it protects

Four mutations in a clone I control, each asserted to have landed, each run as the full
`--no-db` sweep. Baseline in that clone: **rc 0, 37 ok, 0 FAIL**.

| guard deleted | rc | which proofs went red |
|---|---|---|
| the `ls-tree` discrimination (`if _lt.returncode == 0 and not _lt.stdout.strip()` → `if True`) | 1 | `blobless-clone-refused`, `blobless-clone-write-refused`, `blobless-optin-prints-the-limit` |
| the deletion path (`gaps.append(rev); continue` → `pass`) | 1 | `manifest-dropped-and-readded`, `…-write`, `deletion-revision-still-skipped` |
| the counterpart clause (`or _wreports` removed) | 1 | `shallow-every-review-deleted`, `shallow-every-review-deleted-names-them` |
| the printed limit (`history` → the literal `'checked'`) | 1 | `shallow-optin-prints-the-limit`, `deletion-revision-still-skipped`, `blobless-optin-prints-the-limit` |

Each of the six new proofs reds for its own guard, and only related proofs red with it.

---

## 8. Findings

### `R13-P2-01` — a manifest that is not a regular blob is walked, finds nothing, and is reported as *checked*

The walk assumes the tracked path is a regular file. If it is a **symlink** (mode `120000`), every
revision's content is the link text, no row ever parses, `signed_history` stays empty — and the
printed line is still *“reviewer-row history **checked** over every revision of the manifest,
OLDEST first”*. Measured in a scratch repository where the manifest is a symlink from the first
commit, with a tampered report whose counterpart agrees:

```
reviewer-row history checked over every revision of the manifest, OLDEST first
every artifact row matches the file on disk, and every file has a row.
rc=0        (measured from /…/scratchpad/pc/sym2)
```

**Why this is a residual and not a blocker.** For this pack the state is not reachable without
rewriting history, which is the standing stated limit: I checked all **19** revisions of
`P14-HANDOFF-MANIFEST.md` and every one is mode **100644**. And the attack fails outright if even
one revision recorded the row as a regular file — I built that world too and it refused at **1**
(*a signed reviewer row does not move*). What is wrong is the sentence: a walk that parsed **zero**
rows from every revision reports the same words as a walk that verified nineteen.

**Remedy, one line.** `ls-tree` is already called in this loop and prints the mode when asked, so
either treat a non-blob entry as `NOT CHECKED`, or — simpler and wider — when reviewer rows exist
now and the walk recorded **no** digest in any revision, say *NO RECORD IN ANY REVISION* instead
of *checked*. That sentence is also the honest one for an empty-but-complete history.

### `R13-P3-01` — a count measured against the previous head

Amendment 17 §2 reports the shallow-strip world as *“all **18** reviewer rows and their 18 files
removed”*. At this head the same strip removes **19**, because this commit adds a row for
`P14-CHALLENGE-8f6c849.md`; my run prints *19 reviewer report(s) … have NO ROW here*. The figure
is the previous head's. Also: the refusal names the **count** and up to **three** examples, not
every file — which is right for a message, and the amendment quotes it accurately with an
ellipsis, so this is only about the 18/19.

### `R13-P3-02` — one diagnosis I cannot reproduce

§4 states that the sweep opening this round answered 1 on `replay` and `redproof-preflight`
because the cluster was already down, left so by the interrupted run at `20:24:17Z`. That is a
claim about a past moment in the author's container; it is consistent with everything I measured
and I have no way to reproduce it. Recorded as the author's claim, not as verified.

### `R13-P3-03` — carried, unchanged

The version arm is still **UNFENCED** (it needs a second cluster), concurrency and performance
remain **UNMEASURED** in this container, and `COORD P3-07`, `R10-ADD-01` and the owner's
`OD-P14-09/10/11` are open. The author lists all of these at §6; I confirm none of them is
touched by this commit.

---

## 9. Signature and its scope

**I sign `03b3a0bd2ddfcb7d3e83a9625c909c27e0ec0934` and no other commit**, for this narrow check
only: `R12-P1-01`, `R12-P2-01`, `R12-P2-02`, `R12-P3-01`, the worktree verdict, the six new red
proofs tested by guard deletion, and the figures in §6. A signature covers one SHA and does not
transfer.

**Restated, unchanged since round 4:** no finding in this lane has ever landed on Phase 14's
**architecture**, because the architecture is unexecuted — no API, no DDL, no route, no CI job.
Thirteen rounds have measured the pack's own tooling and prose. None of it is credit against the
first review of an executed Phase 14.

**What I did not do:** no file of the author's was edited, in the pack or in the shared folder;
nothing was pushed; no migration was numbered; the cluster was a scratch cluster on `/tmp/p14pg`
and no frozen migration was read or written. This report has no manifest row yet, so the
shared-folder lane will read `ARTIFACT WITH NO ROW` until the author writes one.
