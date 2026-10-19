# Phase 14 — amendment 31: challenge round 25 answered

**Subject reviewed:** `25d945d6b1eb1c1c7253b043295c33a465fed291`.
**Verdict received:** **PASS-WITH-SCOPE** — one **P2** and one **P3**, neither a fail-open.
**Reviewer's words:** `P14-CHALLENGE-25d945d.md` (10,856 bytes,
`cbaba779d9962976ee1cc3d390b7c2d3ce65bff873c7e244e856ab978115ad82`), committed unedited and
hashed from the file on disk.

Their scope is `25d945d` and five digests they took themselves from a clone — manifest
`757a4162…` 93,890 B; `manifest-digests.py` `53ed4559…` 67,511 B; `citation-provenance.py`
`b09d43d9…` 32,228 B; `gate-sweep.sh` `efc92780…` 97,854 B; `RETRACTED-CLAIMS.tsv` `9fd1d35b…`
11,423 B — and I re-verified all five from my own clone of that pushed head: all five match.
Their verdict **excludes one figure of mine by name**, the sweep figure of amendment 30 §5, and
§3 below is why they were right to. It is **NOT a promotion**, not completeness, not a statement
about CI. **This head is not that SHA and carries no part of its signature.** Phase 14 is
**PREPARED / NOT PROMOTED**.

## 1. Disclosed by me, unprompted and first: I wrote the shared folder while a review was running

I owe this section to both reviewers and it goes before their findings rather than after.

On 2026-10-19 I mirrored the then-held commit's pack into `/mnt/project-files/phase14` at
**08:45:53** and **08:46:21 UTC**, while the coordinator's diff review of `32017cf` was running —
it had started at **08:39**. For those minutes the shared folder described a **later head than
the one under review**, and a reviewer running `manifest-digests.py --check` on its default
`--dir` would have compared 70 manifest rows against 72 files and read a STALE refusal caused by
me and not by the commit they were reading.

* **Nobody's figure was spoiled, and I did not establish that myself.** The coordinator ran its
  lanes with `--dir` pointed at its own clone and told me no figure of its review needed
  striking. The round-25 reviewer answered the same question with timestamps in §7 of their
  report: every round-24 measurement of theirs finished by **08:36:16 UTC**, before the window,
  and their 70-row verification was against their clone, not the folder.
* **The rule I adopted and the coordinator accepted:** mirror the shared pack only **after** a
  push, never while a commit is held or a review is running.
* **§3 is the reader's side of the same hazard**, and it is the reviewer's finding, not mine.
  Moving my mirror after the push does not fix a lane whose subject anyone may write; that needed
  a change to the instrument.

## 2. `R25-P2-01` — the head carried no record of the third link for `32017cf`

**The reviewer's finding, measured by them.** `P14-COORD-DIFF-REVIEW-32017cf.md` existed in the
shared pack — 17,335 B, written at **09:08:24 UTC**, before the push — and `git cat-file -e
25d945d:phase-preparation/phase14/P14-COORD-DIFF-REVIEW-32017cf.md` answered *does not exist*.
The manifest gained exactly two rows that round, their report and amendment 30, where every
earlier round committed **both** reviewer reports with their rows. Their consequence, stated as
theirs: the SIGN of `32017cf` was asserted to them out of band and **a reader of that head could
not verify it from the pack**.

**Answered here by committing their counterpart's report, unedited.**
`P14-COORD-DIFF-REVIEW-32017cf.md`, 17,335 bytes,
`876afe4ab155a9cd196a1cbe6cd85d8421f8687d9950c3b07ea086c90f8de594` — the digest the coordinator
announced, re-taken here with `sha256sum` from the file on disk after `cmp` against the shared
copy came back clean. It is **not edited by this thread**, and its row in the handoff manifest is
hand-written because `--write` refuses to author a reviewer's row. With it, the tree at this head
carries **all three links for `32017cf`**: the author's commit, `P14-CHALLENGE-32017cf.md`
(PASS-WITH-SCOPE) and `P14-COORD-DIFF-REVIEW-32017cf.md` (SIGN) — a signature that **covers that
SHA alone** and reaches neither `25d945d` nor this head.

**What the coordinator's review records, in its own words and recorded as theirs:** SIGN for
`32017cf` only, "not a promotion and says nothing about CI or the DB lanes"; no false measured
claim and no fail-open found; `R23-P2-01` and `R-COORD-1` closed by measurement at that head; and
six named residuals, among them `R24-P3-01`, `R24-P3-02`, `R24-P3-03` (all three now closed or
corrected), `R-COORD-2` — the DB lanes **unmeasured in its container**, which had no cluster, so
its 67-ok figure and this pack's are not comparable — and the shared lane's own refusal, which it
rated *environmental* and the round-25 reviewer has now re-measured as the instrument defect in
§3.

## 3. `R25-P3-02` — a gate whose subject is a directory outside this repository has no verdict about a commit

**The reviewer's finding, and their proof of cause, recorded as theirs.** `gate-sweep.sh` ran
`manifest-digests.py --dir /mnt/project-files/phase14 --check` as a **counted gate**. That folder
is written by every session in this project, so that lane's exit code is not a property of any
SHA: any session adding, removing or rewriting a file there flips it, for every head at once.
They proved the cause was exactly one file: on a copy of the shared folder, **as-is rc 1** with
`STALE: P14-COORD-DIFF-REVIEW-32017cf.md: ARTIFACT WITH NO ROW`; with **that single file removed
and nothing else changed, rc 0, 72 rows, 72 files**.

**What it did to a published figure of mine** — amendment 30 §5 said `gate-sweep.sh` rc 0, 79 ok,
0 not as required, *"at this head"*. It was true when I took it, before 09:08:24, and it stopped
being reproducible at that same head minutes later. Struck in place in amendment 30 §5 and
enforced as **retracted claim 28**, allowed only in that amendment and this one. The same strike
covers *"both lanes"* in the `--check` bullet beside it: 72 rows and 72 files are the
clone-pinned figures and they reproduce; the default-`--dir` lane answered 73 files from 09:08:24
onward.

**The instrument change, and what it is not.** A lane whose subject is a directory outside this
repository now runs through `offrepo` rather than `gate`:

* It **still runs**, from the **same four working directories**, with the same command, and every
  exit code is still printed with the absolute directory it was measured from.
* A difference **still moves this script's exit code**, so nothing can read a green `rc` off a
  sweep while the mirror is stale. Nothing is weakened: no question this sweep used to ask has
  stopped being asked, and no red has become a pass.
* What changes is the **arithmetic a reader may quote for a SHA**. The lane never touches `fail`
  and never prints `ok`; it prints `obs`, and above the outcome it prints **the directory it
  read, that directory's file count, its newest mtime and the instant it was read** — because an
  observation of a folder is a fact only with the time it was taken. The summary prints the two
  figures apart, and says in its own words which of them is reproducible from the commit alone.
* The subject is overridable (`P14_SHARED`) so that the separation can itself be measured. The
  override **hides nothing**: the directory actually read is printed on every run, beside the
  outcome.

**The separation, measured, not argued.** Two sweeps differing in nothing but the off-repository
subject:

| separation run | off-repository subject (`P14_SHARED`) | gate figure | off-repository figure | rc |
|---|---|---|---|---|
| 1 | the pack inside this tree, which the manifest describes | **78 ok**, `0 gate(s)/proof(s) not as required` | `0 off-repository lane(s) differ`, `obs` | **0** |
| 2 | a copy of that same pack with **one extra pack document** | **78 ok**, `0 gate(s)/proof(s) not as required` | `1 off-repository lane(s) differ`, first line `STALE: P14-EXTRA-FOR-R25-SEPARATION-MEASUREMENT.md: ARTIFACT WITH NO ROW` | **1** |

The gate figure and the `ok` count are **identical** across the two, so the off-repository lane
does not enter the figure quoted for a SHA; the exit code is **not** identical, so the lane still
fails closed. The commands are
`P14_SHARED=/home/user/daftar/phase-preparation/phase14 bash tools/gate-sweep.sh` and the same
with `P14_SHARED` pointed at a copy of that directory holding one more document.

**What my first attempt at run 2 measured, and it was not what I expected.** I planted a `.txt`
file in the copy and the lane stayed **rc 0**: `--check` enumerates files it ends in `.md` and
`.yaml` only, so a file of any other extension dropped into a pack directory has no row and reds
nothing. The run is published because it is the honest history of this measurement, and the shape
it exposes — pre-existing, not introduced here, and about `manifest-digests.py` rather than about
the separation — is named in §6. Run 2 above plants a `.md`, and it reds.

**No permanent arm asserts this separation** — the proof above is two runs of the whole sweep,
published with their commands, not an arm inside it; that is named as a residual in §6 rather
than claimed as covered.

## 4. What the reviewer measured that this pack had not, recorded as theirs

* **`R24-P3-01` is closed by measurement, theirs.** Their fourth guard-deletion copy — the
  `try/except` around the sibling's git calls, **both sites**, deleted and nothing else — reds
  **`sibling-unrunnable-refused` alone**, and that row red **nothing** at `32017cf`. They also
  checked the **keying** rather than assuming it: the sibling's absent-git refusal does not
  contain `could not be run`, the digest tool's says "no **history** could be read", so neither
  arm can pass on the other's refusal and the two sibling arms cannot pass on each other. They
  note this is the first arm in the sweep that relies on `grep` BRE treating `(` and `)` as
  literal and `.*` as any run of characters, and that it relies on it correctly.
* **Their guard-deletion table, four copies, one deletion each, read by NAME**: no deletion reds
  a second arm, so the three arms are keyed on three different refusals and none is a tautology.
  The baseline reds `manifest-shared` only, which is `R25-P2-01` and is present in every copy.
* **The diff of `32017cf..25d945d`, measured by them**: six files; `git diff --stat … --
  . ':!phase-preparation'` **empty**; both tool files I signed at `32017cf` **byte-identical**
  here, `53ed4559…` and `b09d43d9…`, so nothing in the code signed last round moved and nothing
  in that diff deleted or weakened an existing arm.
* **All 72 rows verified against disk by their own script** — digest *and* byte size — **0
  mismatches**; 32 revisions of the manifest path with **1** found by the marker ERE, and it is
  `08d23da4e850b7498d03eefd893283d39309c712`; not shallow, 0 replace refs, no graft file.
* **They declined to imply a cold repository-gate column they had not taken at that head**, and
  said so rather than carrying one forward. The cold column they did take at `32017cf` — format
  0, lint 1 / 4,220 problems, typecheck 2 / 286 errors, build 1 then 0 — is the `G6` ordering
  artefact that is present on `main` too.

## 5. Exit codes at this head

Taken after the last write to any document of this round, which is the manifest itself. Per round
18's rule, **no count of the manifest's own revisions is quoted here**; that figure is measured in
a fresh clone of the pushed head and reported to the reviewers. Per `R25-P3-02`, the sweep figure
below is the one reproducible from this commit alone, and the shared folder is reported apart
from it.

* `tools/gate-sweep.sh` — the figure reproducible from this commit alone: **78 ok, `0
  gate(s)/proof(s) not as required`**, from four working directories, with the cluster up. At
  `25d945d` the same set of lanes printed 79 ok because `manifest-shared` printed `ok`; here it
  prints `obs` and is counted apart, so 78 ok plus one `obs` is the same number of lanes, one of
  them no longer inside a figure quoted for a SHA. No lane was removed.
* `tools/gate-sweep.sh`, the off-repository lane — `manifest-shared` **differs**, `1 off-repository lane(s) differ`,
  identically from all four directories, and the script's exit code is therefore **1** — the lane
  still fails closed. Read line as printed: `/mnt/project-files/phase14 — 76 file(s), newest
  2026-10-19T09:30:26Z, read at 2026-10-19T09:45:45Z`; first line `STALE:
  P14-MIGRATION-PATCH-REQUEST.md: row says 14f06a749e02/114,156 bytes, file is
  75fb818fceeb/114156 bytes`. That folder is the **pre-push mirror of `25d945d`'s pack**: by the
  rule in §1 it is written only after a push, so while this commit is being prepared it describes
  the previous head and not this one. That is the state the separation exists to report rather
  than to fold into a commit's figure. The re-read after the mirror is written is reported to the
  reviewers with its own timestamp and is **not** part of this head's figure.

  *Which run these two bullets are, exactly.* The lines above are from the run at **09:45:45
  UTC**. A further run **after the last document write of this round** answered identically —
  **78 ok**, `0 gate(s)/proof(s) not as required`, the same off-repository difference with the
  same first line, rc 1 — at **09:48:14 UTC**; only the instant differs, which is the point of
  printing it. The only writes after that run are this paragraph and the manifest-row refresh it
  forces, and both `--check` lanes below were re-run after them.
* `tools/manifest-digests.py --check` — rc 0, byte-identical from the pack directory and the repository root:
  **75 artifact rows + the manifest itself, 75 files**, and *"reviewer-row history checked over
  all 32 revisions of this manifest reachable from HEAD — 1 of them found by the marker it
  carries"*. The revision count is quoted here only as the number this working tree reports; the
  figure for the **pushed** head is re-measured in a fresh clone and reported to the reviewers,
  per round 18's rule.
* `tools/citation-provenance.py` — rc 0, and `--check P14-MIGRATION-PATCH-REQUEST.md` rc 0 after the
  generated block was regenerated for this round's three new documents (`--write`, 62 lines).
* `tools/retracted-claims.py` — rc 0: **28 retracted claims enforced across 41 pack documents; 36
  challenge reports exempt in code.** Claim 28 is this round's, and `P14-AMENDMENT-31` had to
  exist before the exemption naming it could be enforced — an exemption list may not name a file
  that is not there.
* repository `npm run format` — rc 0, *"All matched files use Prettier code style!"*, npm 10.9.4, warm,
  and reported as a statement **about the repository**: by `R24-P3-03` this diff's
  repository-gate set is **empty**, re-measured here with prettier's own `--file-info` over all
  eight files of the diff — the six `.md` files `{"ignored":true,"inferredParser":null}`,
  `tools/gate-sweep.sh` and `tools/RETRACTED-CLAIMS.tsv`
  `{"ignored":false,"inferredParser":null}` — so no repository gate reads any file this commit
  changes, and `git diff --stat -- . ':!phase-preparation'` is empty.

## 6. Residuals at this head, signed by neither reviewer

* **`manifest-digests.py --check` enumerates `.md` and `.yaml` only**, measured in §3 while
  building the separation proof: a file of any other extension dropped into a pack directory has
  no row and reds nothing, so *"every file has a row"* is a statement about those two extensions.
  Pre-existing, not introduced by this commit, and no arm covers the shape. It is not fixed here
  because this commit's reason is the reviewer's two findings; it is named rather than carried
  quietly.
* **This head's sweep exits 1**, and the exit code is honest: the gate figure is `0` and the
  off-repository lane reports the pre-push mirror. A reader who wants rc 0 from this sweep runs it
  after the mirror is written, or points `P14_SHARED` at a directory that describes the commit —
  and the directory it actually read is printed either way.
* **No permanent arm asserts the off-repository separation of §3.** It is proved by two published
  runs of the whole sweep, not by an arm inside it. A later round can build one; this one did
  not.
* The **in-pinned-set `git` arm is absent and named** — a `git` planted inside the pinned set
  itself, which the coordinator did not build either, by instruction.
* `parents-unknown` **unwitnessed**; `GIT_EXEC_PATH` and the translated-git leg **UNMEASURED**
  here.
* **`R-COORD-2`:** the DB lanes are unmeasured in the coordinator's container, so its sweep
  figure and this pack's are not comparable.
* **CI has never run a Phase 14 SHA**, and no workflow in this tree runs this pack's gates.
* `OD-P14-09`, `-10`, `-11` **open with Ashraf**.
* Phase 14 remains **PREPARED / NOT PROMOTED**. No signature in this pack covers this head.
