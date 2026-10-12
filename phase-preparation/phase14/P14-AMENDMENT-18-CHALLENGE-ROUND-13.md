# P14 — AMENDMENT 18: the challenger's round-13 check at `03b3a0b`, answered

**Status: `PREPARED / NOT PROMOTED`. DOCS ONLY. ALL GATES UNMEASURED.**
**Base `93084f8`. Branch `claude/project-thread-1zqgj8`, cut from `6fc505d`; committed and
pushed on that branch only. No product code, no migration, no migration number.**
No timing or performance claim is made anywhere in this pack.
**Unsigned.** An author does not sign their own work.

| review | file, as received | verdict |
|---|---|---|
| **Independent challenger**, round 13, narrow check at `03b3a0b` | `P14-CHALLENGE-03b3a0b.md`, sha256 `3d5af8cb7e81…ed3a259e`, 13,113 bytes | **PASS-WITH-SCOPE**, nothing blocking; it signs `03b3a0b` and no other commit |

Committed unedited, with a row in `P14-HANDOFF-MANIFEST.md` §2. The report records that the four
round-12 findings are closed **by execution** in its own container — the blobless clone with the
premise asserted (`promisor=true`, `filter=blob:none`, `is-shallow=false`), the depth-1 clone with
every review removed, a deliberately neutered `pg_ctl stop` that made the sweep print *the stop did
not take effect … no verdict about the preflight is reported from here*, and a real `SIGTERM` to
the sweep's own pid returning exit 143 with the cluster answering and the pack clean. Those are
the challenger's runs, not mine, and I do not restate them as mine.

Two of its notes correct my own text, and both corrections are taken:

- It reports that each of the six new red proofs was tested **by deleting the guard it protects**,
  and that every mutation was asserted to have landed. That is the test I had not run.
- It checked my worktree fix independently and found the agreed verdict is the **right** one, not
  merely the consistent one: `.git/shallow` lists five commits, `08d23da` is not among them, and
  its parent `6fc505d` does not carry the manifest — so the old `NOT CHECKED` was the false verdict.

---

## 1. `R13-P2-01` — a manifest that is not a regular blob was walked, found nothing, and reported *checked*

The walk assumed the tracked path was a regular file. Committed as a **symlink** (mode `120000`)
every revision reads as the link text, no row parses, the witness stays empty — and the printed
line was still *"reviewer-row history **checked** over every revision of the manifest, OLDEST
first"*, rc **0** on a tampered report whose counterpart agrees. The challenger filed it as a
residual because the state needs a history rewrite here (all revisions of this manifest are mode
`100644`) and because one honest revision defeats it. **What was wrong is the sentence**, and that
is the fourth member of this pack's first defect class: a walk that parsed **zero** rows said the
same words as a walk that verified nineteen.

**Closed twice over, because the mode is the instance and the empty record is the class.**

1. **The mode.** `ls-tree` already runs in that loop and prints the mode when it is not asked for
   names only, so the mode is now read for **every** revision and anything that is not `100644` or
   `100755` is `NOT CHECKED` — *"revision … records this manifest with mode 120000, not a regular
   file, so what it holds is not the manifest's rows and no digest in it can be read"*.
2. **The class.** When this manifest lists reviewer reports and **no** revision recorded a digest
   for any of them, the history is no longer *checked*: it is
   **`NO RECORD IN ANY REVISION`**, and it refuses. That is also the honest sentence for a history
   that is complete and simply empty.

**Measured, by me, in two scratch worlds.** The symlink points **outside** the pack directory,
because a copy inside it is refused as an artifact with no row and the proof would then pass for a
reason that is not the one named — my first attempt did exactly that and I rebuilt it.

| world | tool | rc | what it printed |
|---|---|---|---|
| manifest committed as a symlink from the first revision, report tampered, row forged in the real file, counterpart agreeing | **`03b3a0b`** | **0** | *history **checked** over every revision … OLDEST first* and *every artifact row matches* |
| the same world | **this head** | **1** | `NOT CHECKED (revision 7c2e6f6bb24f records this manifest with mode 120000, not a regular file …)` |
| every reviewer row `UNSIGNED` in the one revision, signed on disk, history read in full | **`03b3a0b`** | **0** | *every artifact row matches the file on disk, and every file has a row* |
| the same world | **this head** | **1** | `NO RECORD IN ANY REVISION (1 revision(s) of this manifest were read and not one of them carries a digest for any reviewer report …)` |

Fenced by `symlink-manifest-refused` and `no-record-in-any-revision`. The first asserts **both**
halves of its premise before judging — the mode **and** that the forged row landed — because
without the second it would be a proof about a symlink and not about a forgery surviving one.

**And a correction of my own, found while fencing this.** My first condition for the wider half
read *"the walk recorded no digest at all"*. That is never true here: `signed_history` carries
**every** row a revision recorded, amendments included, so the test had to be *no digest for any
**reviewer** report*. The first version was a refusal that could not fire, measured as rc 0 on the
world it was written for.

## 2. `R13-P3-01` — a count measured against the previous head

Amendment 17 §2 said the depth-1 strip removed **18** reviewer rows and files. At `03b3a0b` the
same strip removes **19**, because that commit added the row for the round-12 report: the figure
was one commit stale by construction, the third time this pack has typed a live count into a
document. The sentence now names no number and points at the proof that produces it. The lesson is
already carried in `P14-TASK-DAG.md`; what this round adds is that it applies to a count a
**reviewer's** arrival changes, not only to counts of commits and rounds.

## 3. `R13-P3-02` and `R13-P3-03` — accepted as recorded, not re-argued

`R13-P3-02`: my §4 diagnosis that the round-opening sweep's two DB reds came from a cluster left
down at `20:24:17Z` is a claim about a past moment in my container, consistent with everything the
challenger measured and not reproducible by them. It stays **my claim, not verified** — and this
commit removes the need to make such a claim again, below.

`R13-P3-03`: the version arm **UNFENCED**, concurrency and performance **UNMEASURED**, `COORD
P3-07`, `R10-ADD-01` and `OD-P14-09/-10/-11` are untouched by this commit, as §6 of Amendment 17
said and as §5 here repeats.

## 4. Found by execution this round — two reds with no attribution, and the premise nobody asserted

Two sweeps this round answered **1** on `replay` and `redproof-preflight` with
`Connection refused` and **no cause**, because the cluster was not listening when the run started.
`R12-P2-02` taught this pack to assert the premise of the `no-cluster` **proof**; the **run's own
entry condition** was still unasserted. So the sweep now asks `select 1` **before** any database
lane, and says which of three things happened: the cluster answers; or it was down and this run
started it; or it cannot be started, in which case the lanes are declared **BLOCKED** and nothing
below is reported as a measurement of the pack.

And the postmaster's stderr went to `/dev/null`, so no stop could be read back from anything —
which is why `R13-P3-02` had to be a claim rather than a record. Every start this sweep performs
now passes `-l /tmp/p14pg/data/pg_ctl.log`, so the next unexplained stop is attributable to
something other than memory.

## 5. What is still open at this head

Unchanged and not closed by this commit: `COORD P3-07` on the SQL proofs; `R10-ADD-01`; the
unfenced property that a pack file in a new directory must stay out of the PROPOSES bucket; the
preflight **version arm UNFENCED**; **concurrency and performance UNMEASURED** in this container,
by the owner's rule; `TL-P14-SEC-01/-02/-03`, §7a and §11a with the Security and Migration Owners,
no migration number named; and `OD-P14-09`, `OD-P14-10`, `OD-P14-11` with the owner.

**The challenger's standing caveat is recorded unchanged:** nothing in thirteen rounds has landed
on Phase 14's architecture, which is unexecuted — no API, no DDL, no routes, no CI — so none of it
is credit against the first review of an executed Phase 14.

**Nothing in this pack is signed by its author.** The challenger's signature covers
`03b3a0bd2ddfcb7d3e83a9625c909c27e0ec0934` and does not transfer to this commit.
