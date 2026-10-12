# P14 — AMENDMENT 19: the coordinator's actual-diff review at `03b3a0b`, answered

**Status: `PREPARED / NOT PROMOTED`. DOCS ONLY. ALL GATES UNMEASURED.**
**Base `93084f8`. Branch `claude/project-thread-1zqgj8`, cut from `6fc505d`; committed and
pushed on that branch only. No product code, no migration, no migration number.**
No timing or performance claim is made anywhere in this pack.
**Unsigned.** An author does not sign their own work.

| review | file, as received | verdict |
|---|---|---|
| **Coordinator actual-diff review** of `a725342..03b3a0b` | `P14-COORD-DIFF-REVIEW-03b3a0b.md`, sha256 `92bf93077f35…bfb6d4c6`, 24,751 bytes | **REJECT** — three blocking findings, six residuals, and a gap |

Committed unedited with a row in `P14-HANDOFF-MANIFEST.md` §2, and answered in the same commit as
the challenger's round 13 (`P14-AMENDMENT-18-CHALLENGE-ROUND-13.md`), as the coordinator asked.

All three blockers are the same shape, and it is the shape this pack keeps meeting: **a sentence
wider than the code under it.** Two of them are sentences *this very range added* while closing
the previous round.

---

## 1. `B1` (BLOCKING) — two red proofs and a flag that never existed, written into the gate definition

`P14-TASK-DAG.md`'s `P14-GATE-035` cell, `P14-AMENDMENT-15`'s §6a and `README-AR.md`'s item 12 all
named the red proofs `shallow-with-counterpart-passes` and `shallow-require-history-refuses` and
the flag `--require-history`. **None of the three has ever existed in any tool**, and the flag
exits **2** (`unrecognized arguments`), so a CI job following the gate definition's own
instruction would break the gate it runs. The same passages also said the shallow forgery
*"passes at 0"*; since `8f6c849` it refuses at **1**. They describe my first attempt at
`R11-P2-01`, which had the flag as an opt-**in**, before Amendment 16 reversed the default to
`--allow-unverified-history`.

**Closed as follows.** The **live** document — the gate definition — no longer contains any of
them: it now states the measured behaviour, names the real proof (`shallow-counterpart-refused`)
and the real flag. The two **superseded reviews** keep their text with a round-14 annotation
beside it, because a received review is the record of what was claimed. And all four strings carry
rows in `tools/RETRACTED-CLAIMS.tsv`, which fences them to exactly those documents, so they cannot
return to a live one. I grepped the whole pack: the only remaining occurrences are inside the
annotated passages and the TSV.

## 2. `B2` / `P2-01-ter` (BLOCKING) — move the pack and forge in one commit: rc 0, *"checked over every revision"*

The walk asked `git rev-list HEAD -- P14-HANDOFF-MANIFEST.md`, keyed to the manifest's **current
path**. One ordinary commit — a `git mv` of the pack directory, as a promotion would do, plus a
tampered reviewer report and its hand-forged row — made the forging commit the only revision at
the new path, and therefore the "oldest". Its parent holds no file *there*, which the completeness
test read as *"the commit that added it"*, so the forged digest became the witness and every
earlier received record was never read.

**This is the fourth round of one species: the witness anchored to something one commit can
change.** Round 10 it was HEAD; `P2-01-bis` it was a deletion; `R12-P1-01` it was an unreadable
blob; here it is the **path**.

**The fix.** The anchor is the manifest's **name anywhere in the tree**
(`git rev-list HEAD -- ':(top,glob)**/P14-HANDOFF-MANIFEST.md'`), and each revision is read at the
path **it** had, which `git ls-tree -r --full-tree` supplies. A move therefore keeps the file's
whole history. I did **not** use `--follow`, for the reason the review itself names: it finds a
move only when git scores the file as a rename, and a promotion commit that also rewrites the
manifest can fall below that score. (`ls-tree` does not accept `glob` pathspec magic — measured,
*"pathspec magic not supported by this command"* — so the tree is listed and filtered by basename
here; `rev-list` does accept it.)

**Measured by me on a full clone of the real repository**, branched from `03b3a0b`, one commit
doing `git mv phase-preparation/phase14 phase-preparation/phase14-promoted` plus the forge, the
tool run with cwd `/tmp` and **no counterpart at all**:

| what | result |
|---|---|
| revisions of the manifest at the new path | **1** |
| revisions of a file by that name in the tree | **20** (`--follow` also sees 20) |
| the moved pack's own tool, from **`03b3a0b`** | **rc 0** — *reviewer-row history checked over every revision of the manifest, OLDEST first*, *every artifact row matches* |
| **this head** | **rc 1** — `REVIEWER ROW REWRITTEN IN HISTORY: P14-CHALLENGE-7af6438.md …` |

Fenced by `manifest-moved-and-forged` and `manifest-moved-and-forged-write`, built with the pack
nested one directory deep so the move is a real rename of a parent, with **no counterpart**, and
with the premise asserted first: one revision at the new path, two by name.

**The sentences this contradicted are all narrowed**, each beside the text it corrects:
`P14-AMENDMENT-16`'s table row (which said *"a deletion, **or a rename**"* — a rename revision was
never visited at all), `P14-TASK-DAG.md`'s *"what remains unguarded is rewriting the manifest's
history"*, `README-AR.md`'s «ما يُلغي الشاهد هو غياب العقد نفسه فقط», and the tool's own comment
block, which the coordinator had cited once before at `a725342` and which had survived because
`retracted-claims.py` does not scan `.py`.

## 3. `B3` (BLOCKING) — `NOT CHECKED` still exited 0 when every review was deleted and the counterpart could not be read

`R12-P2-01`'s remedy refused only while a reviewer row was still listed **or** a readable
counterpart report survived — and `os.listdir` raising was mapped to `[]`, so *"the counterpart
could not be read"* became *"the counterpart holds no reports"*. An exception resolved to the
permissive value.

**Measured by me**, a depth-1 clone with all reviewer rows and files removed, cwd `/tmp`:

| counterpart | `03b3a0b` | this head |
|---|---|---|
| **absent** (`/nonexistent`) — the CI shape: no shared folder, `actions/checkout` at depth 1 | **0** | **1** |
| a **regular file**, so `listdir` raises `NotADirectoryError` | **0** | **1** |
| an **empty directory** | **0** | **1** |
| absent, with `--allow-unverified-history` | 0 | **0**, and the limit still printed |

The third shape is the one the review's remedy did not reach, and chasing it gave the right rule:
with every reviewer row deleted there is nothing left to *name*, and *"this manifest never had a
review"* is exactly what deleting every review looks like. The only thing that could tell them
apart is the history, and the history is `NOT CHECKED`. **So an unverifiable history now certifies
nothing at all**: it refuses, and the sentence says which of the four states it is in.
`--allow-unverified-history` remains the deliberate opt-out and still prints the limit. Fenced by
`shallow-no-counterpart-refused`, `shallow-counterpart-is-a-file`, `shallow-counterpart-empty` and
`shallow-no-counterpart-optin`.

That change also makes four sentences the review listed **true** rather than needing narrowing —
`P14-TASK-DAG.md`'s *"`NOT CHECKED` no longer exits 0"*, the Amendment 16 manifest row, Amendment
17 §2, and `README-AR.md`'s «لا يُجيب أصلًا بل يرفض» — because the rule is now unscoped in the
code, which is where the review found the scope missing.

## 4. The gap, and each new guard tested by deleting it

The review's `Gap` row asked for a red proof for `B2` and for `B3`; both are above. Following the
challenger's method, each new guard was deleted in a separate clone, with the mutation asserted to
have landed and the baseline at rc 0:

| guard deleted | what reds | what stays green |
|---|---|---|
| the name-anchored walk (back to the current path) | `manifest-moved-and-forged`, `-write` | the rest |
| the `_wfail` / unverifiable-history refusal | `shallow-no-counterpart-refused`, `-is-a-file`, `-empty`, and `shallow-counterpart-refused`, `shallow-every-review-deleted`, `-names-them` with them — all at rc **0** | `shallow-no-counterpart-optin` (rc 0 is its required code) |
| the per-revision mode read | `symlink-manifest-refused` | — |
| the `NO RECORD IN ANY REVISION` branch | `no-record-in-any-revision` | — |

Worth recording about the first row: with the walk mutated back to the current path, the move world
still exits **1**, by a *different* refusal — so this proof discriminates on its **message**, not
on its exit code alone. A red proof that asserted only "non-zero" would have passed on the mutant,
which is `R-05` of the `c812aa5` review restated. The guard-deletion test is what showed it.

## 5. Residuals: five fixed, one named

- **`R-2` fixed.** *"The manifest is not in a git repository here"* covered two different facts. The
  refusal now asks `--is-inside-work-tree` and distinguishes no repository, a repository that
  could not list the revisions (with git's own first line), and a repository where no file of that
  name is reachable.
- **`R-3` fixed in both places.** A connection-time `FATAL` from a cluster that **is** listening
  (pg_hba reject, authentication, a missing role) was classified as *"no cluster is listening"* —
  the eighth instance of the wrong-cause class — and the sweep's own premise accepted it as proof
  that the stop had taken effect. A `FATAL` means something answered: the preflight now says so in
  its own branch, and the sweep refuses to judge the preflight at all in that state.
- **`R-4` fixed.** `rev-parse ^@` and `--is-shallow-repository` had their return codes unread, each
  defaulting to the permissive reading (*a root commit*, *not shallow*); both are now `NOT CHECKED`
  when git refuses to answer. An **empty** `--git-common-dir` made `os.path.join` produce the bare
  name `shallow`, read relative to this process's cwd — a file in an unrelated directory deciding a
  boundary; that is now `<unreadable>`. The `cat-file -e` ambiguity at the parent test is gone with
  `B2`'s rewrite, which asks the tree.
- **`R-5` fixed.** Every `mktemp -d` the sweep makes is registered in `SCRATCH` as it is created and
  removed by `cleanup`, which runs on `EXIT`, `INT`, `TERM` and `HUP`. **Measured:** `SIGTERM` to
  the sweep at 12 s → *"TERMINATED: restoring the pack and leaving."*, exit **143**, **zero**
  `/tmp/tmp.*` directories left (0 before, 0 after), and the pack's own file count unchanged.
- **`R-6` fixed** — it is the challenger's `R13-P3-01`; see `P14-AMENDMENT-18` §2.
- **`R-1` NAMED, not fixed.** The headline counts (46 cases, 5 arms, 44 rows, 13 claims) are not
  fenced against partial absence: delete one `ORDER` line or one TSV row and the gate still exits
  0. It is a real hole and it is **not** closed here. The reason is that this pack's own rule
  forbids the obvious fix — a count typed into a document is one commit stale by construction, and
  `R13-P3-01` is the third time that has bitten. A sound fence needs a **generated** baseline the
  tools write and check, with its own red proof, which is work of its own rather than a line in
  this commit. It is recorded as a residual in `P14-TASK-DAG.md`.

## 6. The review's disagreement, accepted

The review notes that `B2` refutes one argument behind the challenger's `R13-P2-01`: I had called
the symlinked-manifest state unreachable *"without rewriting history"*. `B2` shows one ordinary
commit can start a fresh first revision, so that reasoning was wrong — which is why `R13-P2-01` was
closed on the **sentence** and not on the reachability argument, and why the mode is now read for
every revision regardless.

## 7. What is still open at this head

`R-1` above. `COORD P3-07` on the SQL proofs; `R10-ADD-01`; the PROPOSES-new-directory property,
still unfenced; the preflight **version arm UNFENCED**; **concurrency and performance UNMEASURED**
in this container, by the owner's rule; Node and CI not run; `TL-P14-SEC-01/-02/-03`, §7a and §11a
with the Security and Migration Owners, no migration number named; and `OD-P14-09`, `OD-P14-10`,
`OD-P14-11` with the owner.

**Nothing in this pack is signed by its author**, and the challenger's signature on `03b3a0b` does
not transfer to this commit.
