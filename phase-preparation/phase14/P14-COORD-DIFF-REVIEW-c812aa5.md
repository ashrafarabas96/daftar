# P14 — COORDINATOR ACTUAL-DIFF REVIEW AT `c812aa5`

| | |
|---|---|
| Head reviewed | `c812aa519737dec4310295377b149289f4577249` on `claude/project-thread-1zqgj8`. `git ls-remote` showed this SHA immediately before this file was written. The author has said the head will not move again |
| Range reviewed | `583a4a0..c812aa5`: 9 commits (`7af6438`, `8123830`, `2b5d19f`, `50b0341`, `7aba4cd`, `f7fe056`, `5c9ae3a`, `d19c2dc`, `c812aa5`), 32 files, +3,466/−142, 17 added and 15 modified |
| Against the merge-base | `git merge-base origin/main c812aa5` = `6fc505d`, which is also the current `origin/main`. `6fc505d..c812aa5` is 17 commits, 92 files, +13,026/−0 |
| How the range was set | The brief named `f7fe056`. The coordinator then extended it twice, to `5c9ae3a` and to `c812aa5`. The witness code, `tools/manifest-digests.py`, is byte-identical from `f7fe056` to `c812aa5` (`git diff --quiet` rc 0), so the measurements of it apply to all three heads |
| Reviewer | Coordinator worker. This reviewer wrote no part of the pack and edited no author file |
| Method | Static reading, plus the pure Python tools and the **`--no-db`** sweep in a scratch clone. **No database, cluster, `replay.sh`, `redproof-preflight.sh`, SQL case or `locale-gen` was run.** Node was not used |
| Inputs read first | `P14-COORD-DIFF-REVIEW-583a4a0.md`, `P14-CHALLENGE-50b0341.md`, `P14-CHALLENGE-50b0341-ADDENDUM-01.md`, `P14-AMENDMENT-14-CHALLENGE-ROUND-10.md` (both the `f7fe056` and the `c812aa5` edition) |

## 1. Verdict: **REJECT** (narrow). Three blocking findings, all cheap to fix, and none touches the design or authority

The stopping rule is `P14-TASK-DAG.md` `P14-RULE-TOOLING-STOP`, as the coordinator restated it. A
finding blocks only if it is a false measured claim (an exit code, a count, or a claim that something
was proved) or a fail-open. Everything else is a named residual.

On that bar, three findings block:

- **P2-01.** The "every revision" witness can be rewritten by one commit. The pack says the
  author's commits cannot rewrite it. That is a false proof claim, and in the no-counterpart world
  the refusal fails open. This is the R10-P2-01 species one step over: a forged digest is
  committed instead of `UNSIGNED`.
- **P2-02.** The generated provenance block says 12 files are "files this phase PROPOSES and that
  correctly do not exist yet". Three of them are the pack's own tools, and they exist. This is a
  false generated count.
- **P2-03.** The handoff manifest and the Arabic index again carry false typed counts on their
  first pages: "All **29**" (there are 37), "**SEVEN ROUNDS RUN**" (ten ran), "any of the eight
  commits" (17), and "thirteen commits" (17). This is a recurrence of R1 P2-03.

Scope, authority, the gate's verdicts and the `NO WITNESS` refusal are sound. R10-P2-01's committed
`UNSIGNED` route is closed, and I measured that. The `--no-db` sweep exits 0 at `c812aa5`. Every
refusal still exits non-zero. Nothing here changes `PREPARED / NOT PROMOTED`, and `READY_TO_PROMOTE`
stays NO.

## 2. Scope (check 1)

| Check | Result | Evidence |
|---|---|---|
| Files touched in `583a4a0..c812aa5` | **All 32 are under `phase-preparation/phase14/`.** Modified: `P14-AMENDMENT-08`, `-09`, `P14-EVIDENCE-2026-10-12.md`, `P14-HANDOFF-MANIFEST.md`, `P14-MIGRATION-PATCH-REQUEST.md`, `P14-TASK-DAG.md`, `README-AR.md`, `proofs/{ORDER,README.md,preflight.sql,redproof-preflight.sh,replay.sh}`, `proofs/cases/c1a_restrict_column_refused.sql`, `tools/{citation-provenance.py,manifest-digests.py}`. Added: `P14-AMENDMENT-11…14`, `P14-CHALLENGE-{7af6438,7af6438-ADDENDUM-01,583a4a0,583a4a0-ADDENDUM-01,2b5d19f,50b0341,50b0341-ADDENDUM-01}.md`, `P14-COORD-DIFF-REVIEW-583a4a0.md`, `proofs/cases/c1_{rename,restore}_secret_col.sql`, `tools/{gate-sweep.sh,retracted-claims.py,RETRACTED-CLAIMS.tsv}` | `git diff --name-status 583a4a0 c812aa5` |
| Outside the pack (migrations, root `package.json`, CI workflows, `apps/`, `packages/`) | **None.** Nothing outside the pack has changed since the merge-base | `git diff --name-status 6fc505d c812aa5 \| grep -v phase-preparation/phase14/` → no lines (rc 1). `git diff --quiet 6fc505d c812aa5 -- infrastructure/ apps/ packages/ package.json .github/` → rc 0 |
| Frozen migrations | **Unchanged.** The tree's migrations end at `0073` (`6fc505d`), and none is touched | same |
| Shared folder against the commit | **38 files in `/mnt/project-files/phase14`, all 38 byte-identical** (`cmp`) to the `c812aa5` pack. The challenger's addendum is committed unedited (`f0137774834f…`, identical in both directories) | `cmp` loop |
| Side effect of the sweep on the repository | `gate-sweep.sh:26` runs `git worktree add` on the repository it is in, and `:379` removes it. In my scratch clone `worktree list` was clean after both runs | — |

## 3. Status of the 583a4a0 review's findings (check 2)

| Finding | State at `c812aa5` | Evidence |
|---|---|---|
| **P2-01** The locale-gen revert was only half done | **CLOSED** | `P14-EVIDENCE-2026-10-12.md:47` now records `locale-gen` and the withdrawal, with a pointer to the addendum. `P14-AMENDMENT-09-CHALLENGE-ROUNDS-4-5.md:116-128` marks both halves retracted. `tools/RETRACTED-CLAIMS.tsv:23-24` makes both phrasings gated prose |
| **P2-02** Deleted orphan in PROPOSES; buckets double-counted | **CLOSED as stated**, but see new **P2-02** below | `P14-MIGRATION-PATCH-REQUEST.md:1476` lists `cases/c7a_cross_business_accepted.sql` under DELETED only, with files and tokens counted separately. `citation-provenance.py:285-300` uses a strict priority and an asserted partition. Absolute tokens are no longer resolved against the host (`:256-258`) |
| **P2-03** Manifest identity and review-state rows were false | **PARTIAL, and it has re-staled** (new **P2-03**) | Fixed: `P14-HANDOFF-MANIFEST.md:29`, which names the real branch and base, and `:40`, which says the files are committed. Wrong again or still wrong: `:31`, `:39`, `:192`, `:257`. The headers `P14-AMENDMENT-03:4`, `-04:4` and `-05:4` still carry the `claude/phase14-prep-1zqgj8`/"no commits" line without an annotation |
| **P2-04** The Arabic index stopped at round 1 | **CLOSED in substance**. The new typed count is part of new P2-03 | `README-AR.md:7-12` corrects "nothing pushed", `:63-67` corrects 45 to 43, and `:70-145` covers rounds 2–10 |
| **P2-05** `redproof-preflight.sh` could exit 0 with the cluster down | **CLOSED in code** (not executed by me; the challenger confirmed it by execution in `P14-CHALLENGE-583a4a0-ADDENDUM-01.md`) | `proofs/redproof-preflight.sh:76-91` requires the mutation to apply. `:113-118` accepts only rc 1 or 3, never 2. `:119-124` requires the arm's own sentence. `tools/gate-sweep.sh:317-326` stops the cluster and requires a non-zero exit (but see R-05) |
| **P3-06** c1a's SQLSTATE assertion could not fail | **CLOSED**, with a new residual (R-06) | `c1a_restrict_column_refused.sql:32` is now `WHEN OTHERS`. Its red proof is `proofs/ORDER:12-14` (`c1_rename_secret_col.sql` → `c1a_lawunproved_expect_3` → `c1_restore_secret_col.sql`), each with a proof of proof (`c1_rename_secret_col.sql:23-36`) |
| **P3-07** Red proofs are judged by exit code 3 alone | **OPEN, carried by the author** | `P14-AMENDMENT-14:` §3 table. It is closed for the provenance and reviewer-row lanes (`gate-sweep.sh:179-190`, `named()`), but not for the SQL proofs or `reviewer-row-resign` (`gate-sweep.sh:241-243`, which checks rc only) |
| **P3-08** Generated prose credited `--check` with a detection it cannot make | **CLOSED** | `citation-provenance.py:331-341`; `P14-MIGRATION-PATCH-REQUEST.md:1480` ("`--check` cannot detect their arrival") |
| **P3-09** The provenance gate's answer depended on the host | **CLOSED for `citation-provenance.py`**, partial for the pack | `--repo` is derived from `--pack` (`:65-68`). Three refusals are by name (`:91-103`, `:265-271`), and the floor and empty-table refusals are at `:185-200`. `manifest-digests.py:34` and `:79` still hard-code `/mnt/project-files/phase14`. That fails closed: `--dir` absent gives rc 2 at `:45-50`. A new host-path defect is in `retracted-claims.py` (R-01) |
| **P3-10** Amendment 09 still carried the corrected sentence | **CLOSED** | `P14-AMENDMENT-09:188-194` |
| **P3-11** The manifest's self-disagreement was undisclosed | **CLOSED** | `P14-MIGRATION-PATCH-REQUEST.md:1514-1520` |
| **P3-12** `.md` was outside the scanned population | **CLOSED** | `citation-provenance.py:38` (EXTS includes `md`) and `:109-116` (a recursive walk). The population is printed at `P14-MIGRATION-PATCH-REQUEST.md:1469` |
| **P3-13** Typed copies of generated figures | **PARTIAL** | Fixed: `P14-EVIDENCE:45` and `README-AR.md:63`. Still present: `P14-AMENDMENT-03-CONTINUOUS-MISSION.md:160` ("differs … by 205 lines"). New typed counts: see P2-03 |
| **P3-14** Amendment 08 presented clean rounds as validation | **CLOSED** | `P14-AMENDMENT-08-CHALLENGE-ROUND-3.md:3-12` |
| **P3-15** A typo in a replay.sh comment | **CLOSED** | `proofs/replay.sh:16-17`. The 36 is right: `c7c_assertion_inoperable.sql` is the 36th entry of `ORDER`'s 46 |
| **P3-16** The challenger's P3-04 collision | **CLOSED by the challenger** | `P14-CHALLENGE-583a4a0-ADDENDUM-01.md:58-74` |

**Tally:** of the 5 P2 findings, 4 are closed and 1 is partial and re-staled (P2-03). Of the 10 author
P3s (P3-06 to P3-15), 7 are closed, 2 are partial (P3-09, P3-13) and 1 is open by the author's
choice (P3-07). P3-16 is closed by the challenger.

## 4. Findings

### P0 / P1: none.

### P2-01 (BLOCKING: a false proof claim, and the refusal fails open) — a single commit can rewrite the "every revision" witness

**The code.** `tools/manifest-digests.py:85-95` walks `git rev-list HEAD -- <manifest>` newest-first,
with `signed_history.setdefault(name, digest)`. So the witness is the **newest** committed
non-placeholder digest. Whenever HEAD carries a digest, that is HEAD's digest. The check at `:150`
(`elif sig and h != sig`) then compares the file against whatever the author committed last.

**Measured** in a scratch repository holding a copy of the `c812aa5` pack, against
`P14-CHALLENGE-50b0341.md` (the same results at `f7fe056`):

| step | `--check` / `--write` |
|---|---|
| one line appended to the report; row hand-edited to the new sha256 and bytes; **uncommitted**; empty `--witness` | `--check` **1**, refused: "a signed reviewer row does not move. Some revision … recorded e89fcb1c90ea" |
| the same, after **`git commit -am`**; empty `--witness` (the shape the pack tested for `UNSIGNED`, at `P14-AMENDMENT-14:62`) | `--check` **0**, `--write` **0**. The tool prints "reviewer-row history checked over every revision of the manifest". The first revision still holds `e89fcb1c90ea` |
| the same commit, with the counterpart edited in step, **inside a repository with that history** | `--check` **0**, `--write` **0** |
| the same commit, with the counterpart left untouched | `--check` **1** (`REVIEWER COPIES DIFFER`) |

**The sentences this falsifies:**

- `P14-HANDOFF-MANIFEST.md:89`: "rebuilt on **two witnesses the author's commits cannot rewrite** —
  … and **every revision** of the manifest".
- `README-AR.md:118`: «أُصلح بشاهدين لا تستطيع دفعاتي تغييرهما» ("fixed with two witnesses that my
  commits cannot change").
- `P14-AMENDMENT-14-CHALLENGE-ROUND-10.md:51`: the column header "why the author cannot rewrite it",
  over the "every revision" row at `:54`.
- `P14-TASK-DAG.md:193` (`P14-GATE-035`): "**every revision** of the manifest — not HEAD, because
  HEAD is written by the same hand as the row". With a committed digest the witness *is* HEAD.
- `P14-HANDOFF-MANIFEST.md:88`: "two identical edits to both copies are still caught by the revision
  walk". This holds only when the newest committed digest is still the original. The challenger's
  world (a) used a committed placeholder.
- `P14-HANDOFF-MANIFEST.md:90` still describes Amendment 13 as "**any transition of a signed reviewer
  row is refused in either direction**", with no annotation. This is the sentence R10-P2-01 corrected.
- The code comment at `manifest-digests.py:55-57` ("the manifest's own history says what digest was
  recorded **when the report was received**") describes the oldest digest, but the code takes the
  newest.

**Grade.** This is the bar R10-P2-01 was blocked on: a stated guarantee that is wider than what is
enforced, defeated by one ordinary commit. It is **not** a fail-open of `P14-GATE-035` as a whole.
The shared lane still reds whenever `/mnt` holds the untouched report, and with `/mnt` absent the
lane exits 2. R10-ADD-01 (the fifth row, `P14-AMENDMENT-14:64`) discloses the no-repository case
only. This case is inside a repository with full history.

**Remedy, small.** Either change the walk or narrow the sentences:

- **The walk.** Refuse when *any* non-placeholder digest in *any* revision differs from the file.
  That treats the receipt digest as the witness, and no later commit can erase it. Rewriting history
  remains as a limit to name.
- **The sentences.** Narrow them to what holds: "a committed placeholder does not erase a recorded
  digest; a committed forged digest does, and only the other directory witnesses that".

### P2-02 (BLOCKING: a false generated count) — the PROPOSES bucket lists three of the pack's own tools

`P14-MIGRATION-PATCH-REQUEST.md:1479` (generated) reads: "**12 file(s)** (13 tokens) are files this
phase PROPOSES and that correctly do not exist yet". The list includes `citation-provenance.py`,
`gate-sweep.sh` and `retracted-claims.py`. All three exist at `phase-preparation/phase14/tools/`.

**Cause.** `in_pack` (`citation-provenance.py:259-260`) and `was_in_pack` (`:275`) search only
`''`, `proofs` and `proofs/cases`, not `tools`. The bare tokens come from `P14-AMENDMENT-12:107,130,149,159`,
`README-AR.md:83` and `P14-TASK-DAG.md:193`.

The comment at `:242-244` says this exact species ("the pack's own driver and tools were classified as
files the phase proposes") was fixed. It was introduced at `8123830` and has survived six commits and
two challenge rounds. Both `--check` and the sweep stay green, because the block is consistent with
its generator. The correct figure is 9 PROPOSES and 86 in-pack. Same block, `:1475`: "the generator
asserts **the four** add up", but there are five buckets (`:285-300`).

**Remedy.** Add `'tools'` to both tuples, regenerate the block, and change "four" to "five".

### P2-03 (BLOCKING: false counts on the pages read first) — R1 P2-03 has recurred

- `P14-HANDOFF-MANIFEST.md:31`: "nothing outside `phase-preparation/phase14/` touched in any of
  **the eight commits**". There are 17. The claim itself is true (§2), but the count is not.
- `P14-HANDOFF-MANIFEST.md:39`: "All **29** live at `/mnt/project-files/phase14/`". There are 37
  rows plus the manifest, which is 38 files, and the tool itself prints 37 rows.
- `P14-HANDOFF-MANIFEST.md:192`: "Independent Challenger | **SEVEN ROUNDS RUN**", with seven
  verdicts listed. Ten rounds ran, plus four addenda. `README-AR.md:70` itself says ten.
- `README-AR.md:9`: «ثلاث عشرة دفعة» ("thirteen commits"). There are 17. The same line says "this
  commit answers its tenth round", which is stale for `d19c2dc` and `c812aa5`.
- Still unchanged from R1: `P14-HANDOFF-MANIFEST.md:257` ("regenerated 2026-10-12 after Amendment
  03"), and the headers `P14-AMENDMENT-03/04/05:4`.

`:30` ("eight, pushed, head `583a4a0` **at the time of this row**") is dated, and I accept it as
dated. **Remedy:** generate these figures, or date every one of them.

### Named residuals (do not block)

- **R-01 (P3; a contained fail-open in a gate component) — `retracted-claims.py --check` checks
  nothing when the pack's path contains `/tools`.**
  - `tools/retracted-claims.py:48` reads `if os.sep + 'tools' in root + os.sep: continue`, which is
    a substring test on the absolute path. It is not a test against `<pack>/tools`.
  - Measured with a planted retracted sentence: pack at `…/w/plain/phase14` → **1**; pack at
    `…/w/tools/phase14` → **0**, "enforced across **0** pack document(s)". Any checkout under
    `…/tools/…` or `…/toolsX/…` reproduces it.
  - There is no floor on the document count.
  - **Contained.** A full `--no-db` sweep from a clone at `…/w/tools/clone` exits **1**, because
    `retracted-claim-planted` reports `rc=0, required 1`. The gate stays closed, but the tool alone
    fails open.
  - Remedy: compare `os.path.relpath(root, a.pack)` against `tools`, and refuse when zero documents
    were scanned.
- **R-02 (P3) — a whole reviewer report can be deleted, with its row, and the pack lane stays
  green.**
  - Measured: report and row removed from `--dir`, with the history and an untouched `--witness`
    present → `--check` **0**. The shared-lane shape → **1** (`ARTIFACT WITH NO ROW`).
  - `signed_history` knows the name, but nothing requires a signed name to keep its row
    (`manifest-digests.py:98-172`). The two-directory construction protects again, not the refusal.
- **R-03 (P3) — coordinator reviews are not reviewer rows.**
  - Only names starting `P14-CHALLENGE-` are protected (`manifest-digests.py:138`).
  - Measured: `P14-COORD-DIFF-REVIEW-583a4a0.md` tampered, then `--write` → **0**, and the pack lane
    `--check` → **0**. The shared lane → **1**.
  - Remedy: extend the prefix to cover `P14-COORD-DIFF-REVIEW-`.
- **R-04 (P3; the fifth instance of the "wrong cause" class) — the lock path fails closed but
  misnames the cause** (`redproof-preflight.sh:35-42`).
  - `mkdir … 2>/dev/null` discards its error.
  - If `exec 9>"$LOCK"` fails, bash prints the error and continues. `flock -n 9` then fails on a
    bad file descriptor.
  - If `flock` is missing, the result is "command not found".
  - Either way the script prints "**another red-proof run holds** $LOCK" and exits **4**. I measured
    both shapes with an equivalent `bash -c` snippet (rc 4, rc 4).
  - Not a fail-open: 4 is non-zero, and `gate()` treats only 0 as a pass (`gate-sweep.sh:78-96`).
  - With `flock` missing, `concurrent-run-refused` (`gate-sweep.sh:362-371`) would pass for the wrong
    reason, while the `redproof-preflight` gate lane reds.
- **R-05 (P3; a red proof can fail open, but only under concurrency) — exit 4 satisfies two red
  proofs.**
  - `no-cluster` (`gate-sweep.sh:320-326`) and `rolecount-discriminates` (`:332-339`) require only
    "non-zero", so a lock refusal satisfies both without measuring anything.
  - Reaching that needs a second `redproof-preflight.sh` run that holds the lock during those two
    proofs and releases it before `no-cluster-revert`. The sweep cannot create that run itself. The
    pack declares concurrency UNMEASURED.
  - Remedy: require rc 1 and that arm's own sentence in each proof.
  - Answer to the coordinator's question: **no gate lane treats 4 as a pass; these two red proofs do.**
- **R-06 (P3) — c1a's `WHEN OTHERS` also catches its own `LAW VIOLATED` raise.**
  - `c1a_restrict_column_refused.sql:31-35`: a successful lookup raises P0001, which the handler
    catches, so the output reads "LAW UNPROVED … SQLSTATE P0001".
  - The exit code is still 3, so it fails closed, but a law violation is labelled as unproved.
- **R-07 (P3; a false sentence about diagnostics only) — "no filter prints … an empty payload" is
  false.**
  - `P14-AMENDMENT-14:107-110` says the pattern is "written the same way in **every** filter" and
    that no diagnosis line prints with an empty payload.
  - `gate-sweep.sh:351` (no-cluster-revert) uses the unified pattern with **no fallback**. With an
    exit-4 refusal as output, the payload is empty.
  - The filters at `:187`, `:263`, `:370` and `:388` are first-line filters and not the unified one.
  - `gate-sweep.sh:58` contains the pattern twice, joined by a stray `''`. That is harmless.
- **R-08 (P3) — cases where the history label overstates.**
  - In a shallow clone, `rev-list` sees only the fetched commits, yet the tool prints "checked over
    every revision".
  - A `git` failure such as `safe.directory` prints "not in a git repository here".
  - `manifest-digests.py:91` skips any failed `git show` silently.
  - All of these narrow the witness without a refusal. None changes an exit code by itself.
- **R-09 (P3) — `redproof-preflight.sh <unknown-arm>` exits 0** with "0 arm(s), 0 not red"
  (`:26`, `:178-179`). This contradicts the pack's own no-match law (`replay.sh` exits 2). The gate
  never passes an arm name, and `rolecount` is spelled correctly at `gate-sweep.sh:332`.
- **R-10 (P3) — `RETRACTED-CLAIMS.tsv:19`'s allow-list names a file that does not exist.**
  `P14-AMENDMENT-11-CHALLENGE-ROUND-7.md` should be `…-ROUND-7-AND-COORD-REVIEW.md`. It fails
  closed.
- **R-11 (P3) — the sweep mutates the live pack without a `trap`** (`gate-sweep.sh:164-307`,
  `:239-265`). An interrupted sweep leaves a reviewer report tampered. The next run reds, so it
  fails closed.
- **Carried and confirmed:**
  - The coordinator's named residual at `redproof-preflight.sh:55` (`f7fe056`/`5c9ae3a`): the inner
    grep `'ERROR|FATAL|could not'` misses `psql: error: … failed` and printed "psql said:" with an
    empty payload. **Confirmed by reading; fixed at `c812aa5`** (`:86-88` and `:121-123`, with
    fallbacks).
  - COORD P3-07 for the SQL proofs, the version arm, and concurrency and performance (all UNMEASURED).
  - R10-ADD-01 (`P14-AMENDMENT-14:64`, now disclosed).

## 5. The witness logic, the walk and NO WITNESS (check 3)

- **Two-directory comparison** (`manifest-digests.py:139-149`). The default witness is the other
  directory (`:77-80`). It refuses whenever both copies exist and differ.
  - If a path to `/mnt` is spelled through a symlink, `abspath` is not `realpath`, so the default
    witness is the same directory and trivially agrees.
  - An explicit `--witness` equal to `--dir` is also accepted.
  - Neither is used by the sweep, and both are named here as limits.
- **The revision walk** (`:82-97`). It is newest-first with `setdefault`, which is **P2-01**.
  `git` errors become "NOT CHECKED" (`:96-97`), and a failed `show` is skipped (`:91`).
- **NO WITNESS** (`:155-159`). It fires only when the counterpart is absent *and* no revision has a
  digest. That is correct and fail-closed (I reproduced it via the sweep's
  `reviewer-row-no-witness`). It cannot fire once any digest, including a forged one, is committed.
- **Returns 0 when a witness is missing?** Yes, in exactly one case: a committed digest exists (so
  `sig` is set), the counterpart is absent, and the file matches the committed digest. That is the
  P2-01 path. Otherwise a missing witness either refuses or falls through to the history check.
- **Swallowed exceptions.** None in Python: every `open` and `git` call either raises (a non-zero
  traceback) or has its return code checked. The silent `continue` at `:91` is noted in R-08.
- **Glob or cwd dependence.** `manifest-digests.py` is cwd-free apart from relative `--dir`/`--witness`.
  The path dependence is in **`retracted-claims.py:48`** (R-01).

## 6. Gate-sweep cause-line logic (check 4)

`gate-sweep.sh:53-61` only chooses the line to **display**. The exit path is independent of it:

- any inconsistent rc → `fail++` (`:68-72`);
- any consistent non-zero rc → `fail++` (`:81-95`);
- every `red`/`named` mismatch → `fail++`;
- the script ends `[ "$fail" -eq 0 ] || exit 1`.

**Every refusal still exits non-zero.** Measured with `--no-db`:

- `c812aa5` from the pack directory → **0**: 21 `ok` lines, four directories, and the pack-under-`/tmp`
  lane.
- `5c9ae3a` → **1**. The only failure was `manifest-shared`, because `/mnt` already held the
  `d19c2dc` files: a skew while the push was in progress, not a defect.
- The `/tools/`-path clone → **1** (R-01).

The one place a refusal code is accepted as a pass is R-05 (exit 4 in two red proofs).

## 7. Sentences claiming more than the code enforces (check 5)

| file:line | sentence | status |
|---|---|---|
| `P14-HANDOFF-MANIFEST.md:89`, `README-AR.md:118`, `P14-AMENDMENT-14:51`, `P14-TASK-DAG.md:193` | "two witnesses the author's commits cannot rewrite"; "not HEAD, because HEAD is written by the same hand" | **false**: P2-01 |
| `P14-HANDOFF-MANIFEST.md:88` | "two identical edits to both copies are still caught by the revision walk" | true only for an uncommitted or placeholder edit: P2-01 |
| `P14-HANDOFF-MANIFEST.md:90` | "any transition of a signed reviewer row is refused in either direction" | **false and unannotated**: P2-01 |
| `P14-MIGRATION-PATCH-REQUEST.md:1479`, `:1475` | "12 file(s) … PROPOSES … correctly do not exist yet"; "the four add up" | **false**: P2-02 |
| `P14-HANDOFF-MANIFEST.md:31`, `:39`, `:192`; `README-AR.md:9` | eight commits; All 29; SEVEN ROUNDS RUN; thirteen commits | **false**: P2-03 |
| `P14-AMENDMENT-14:107-110` | "every filter … no filter prints … an empty payload" | **false** (diagnostics only): R-07 |
| `P14-AMENDMENT-14:169` | "It hid no fail-open … a connect failure cannot read as a red" | true for the arms. Exit 4 can read as a red in two sweep proofs: R-05 |
| `P14-HANDOFF-MANIFEST.md:25` | "DOCS ONLY · ALL GATES UNMEASURED" | consistent: the pack has no product code, and the sweep is tooling |

## 8. Authority (check 6)

- **No self-signature.**
  - Every amendment says "unsigned". `P14-HANDOFF-MANIFEST.md:196` says "An author does not sign
    their own work".
  - The only "ACCEPT" strings are quotations of the 583a4a0 coordinator verdict, at
    `P14-AMENDMENT-11:9`, `P14-HANDOFF-MANIFEST.md:82,192` and `README-AR.md:77`.
- **No promotion.**
  - `READY_TO_PROMOTE` = NO appears in 21 places, and no other value appears anywhere.
  - Every other "promoted" hit is either the status ladder (`P14-AMENDMENT-03:185`) or conditional
    language ("promoted only after Phase 13 is sealed").
- **No migration number allocated.** Checked by grep in four ways:
  - `NNNN_*.sql` tokens: exactly {0002, 0003, 0004, 0006, 0010, 0014, 0020, 0025, 0045, 0054, 0073,
    0076, 0079, 0086}. All are existing files: Phase 4's at `93084f8`, and the rest at `6fc505d`.
  - Bare `00NN` tokens: 0000 (UUID fixtures and the manifest's policy quote), the ranges
    0053–0073/0074–0076/0077–0078 (`P14-AMENDMENT-01:56-58`, which are sealed contracts), and
    0080–0086 (named as "candidates nobody here edits").
  - The highest bare token is the previous coordinator review's own negative statement (`:51`).
  - Every 4-digit hit above the highest existing migration is a commit-SHA fragment, a digest
    fragment or the SSRF literal `0177.0.0.1`.
  - **Judgement: no number is allocated, proposed or exemplified.**

## 9. Commands (every cwd and rc)

`$SP` = `/tmp/claude-0/-home-user/5043869c-4f0c-5535-aa30-efb4cbbf59d5/scratchpad`, `$R` = `/home/user/ashrafarabas96/daftar`, `$P` = `$SP/p14-review/phase-preparation/phase14`.

| # | cwd | command | rc / result |
|---|---|---|---|
| 1 | `$R` | `git fetch origin claude/project-thread-1zqgj8 main` (three times) | 0, 0, 0. The head moved `583a4a0→5c9ae3a→c812aa5` |
| 2 | `$R` | `git ls-remote origin claude/project-thread-1zqgj8` (last run just before writing) | 0 → `c812aa5…` |
| 3 | `$R` | `git merge-base origin/main c812aa5`; `git rev-parse origin/main` | 0 → `6fc505d` / `6fc505d` |
| 4 | `$SP` | `git clone -q --no-hardlinks $R p14-review`; `git checkout -q f7fe056`, then `5c9ae3a`, then `c812aa5` (fetched from `$R`'s remote-tracking ref) | 0 each |
| 5 | `$SP/p14-review` | `git diff --name-status/--shortstat 583a4a0 c812aa5` and `6fc505d c812aa5`; `… \| grep -v phase-preparation/phase14/` | 0; grep rc **1** (nothing outside the pack) |
| 6 | `$SP/p14-review` | `git diff --quiet 6fc505d c812aa5 -- infrastructure/ apps/ packages/ package.json .github/` | **0** |
| 7 | `$SP/p14-review` | `git diff --quiet f7fe056 5c9ae3a -- …/tools/manifest-digests.py` | **0** (and it is unchanged at `c812aa5`) |
| 8 | `$P` @`5c9ae3a` | `TMPDIR=$SP/tmpdir bash tools/gate-sweep.sh --no-db` | **1** (only `manifest-shared`: `/mnt` was ahead of the commit) |
| 9 | `$P` @`c812aa5` | same | **0**, 0 not as required |
| 10 | `$SP` | `python3 -I $P/tools/manifest-digests.py --dir $P --check`; `… --dir /mnt/project-files/phase14 --check` | **0** (37 rows); **0** (37 rows) |
| 11 | `$SP` | `python3 -I $P/tools/citation-provenance.py` | 0 → `resolved=41 differ=6 identical=26 absent=9 ambiguous=0 unresolved=110` |
| 12 | `$SP` | `cmp` of each `/mnt/project-files/phase14/*` against `$P` | 38 files, 0 differing |
| 13 | python cwd `$SP` (scratch world `$SP/w/forge`) | `$SP/scripts/forge.sh`: commit the pack, tamper one report, hand-forge its row, run `--check` uncommitted, then commit and run `--check`/`--write` with an empty witness, an untouched witness, and an in-step witness | 1; 0 / 0; 1; 0 / 0 (P2-01) |
| 14 | python cwd `$SP` (`$SP/w/del`) | `$SP/scripts/delete.sh`: delete the report and its row, then `--check` with an untouched witness, with an empty witness, and in the shared-lane shape | 0; 0; 1 (R-02) |
| 15 | `$SP` | `python3 -I …/retracted-claims.py --pack <copy> --check` with a planted retracted sentence, pack at `$SP/w/plain/phase14` and at `$SP/w/tools/phase14` | **1** / **0**, "across 0 pack document(s)" (R-01) |
| 16 | `$SP/w/tools/clone/phase-preparation/phase14` @`c812aa5` | `TMPDIR=$SP/tmpdir bash tools/gate-sweep.sh --no-db` | **1** (`retracted-claim-planted rc=0, required 1`) |
| 17 | python cwd `$SP` (`$SP/w/coord`) | tamper `P14-COORD-DIFF-REVIEW-583a4a0.md`, then `--write`, then pack-lane `--check`, then shared-lane `--check` | 0; 0; 1 (R-03) |
| 18 | `$SP` | `bash -c 'exec 9>/nonexistent-dir/x.lock; … flock -n 9 … exit 4'`; `bash -c 'PATH=/nonexistent; … flock -n 9 … exit 4'` | 4; 4 (R-04) |
| 19 | `$SP/p14-review` | `git grep` for `NNNN_*.sql` tokens, for 4-digit tokens above the highest migration, and for `READY_TO_PROMOTE`, `promoted` and signature phrases, at `c812aa5` | see §8 |

No command touched a PostgreSQL cluster or database. I did not stash, reset, clean or push. The
reviewed clone `$R` was only fetched. All scratch material is deleted after this file is written.

## 10. Not verified

- **Anything that needs the database.** That covers:
  - the author's run `P14-R10-20261012T173539Z` (the full sweep at 0, and `concurrent-run-refused`
    at exit 4);
  - `replay.sh` at 46 cases, and `redproof-preflight.sh` at 5 arms;
  - the measured `psql said: psql: error: …` line at `P14-AMENDMENT-14:111-113`;
  - the per-run database names in a live collision;
  - the `CAUSE:` split between 42P04 and `pg_database_datname_index`;
  - `no-cluster`, `rolecount-discriminates`, `version-arm-fires` and `no-cluster-revert`;
  - c1a's `LAW UNPROVED` red proof (`c1a_lawunproved_expect_3`).

  These are the author's and the challenger's figures, not mine.
- How `flock` behaves under a real concurrent sweep (R-05 is from reading the code), and on an
  NFS or overlay `/tmp`.
- Test pass counts under Node. Node 22 is below `engines >= 24`, and no Node run was made.
- The design itself: the 39 laws, the grants matrix, RLS, SSRF, the webhook design, the OpenAPI
  skeleton, and the open rulings `TL-P14-SEC-01/-02/-03`, §11a and `OD-P14-09/-10/-11`.
- The Arabic text beyond status lines, counts and the witness sentence.
- Whether the round-1 to round-9 findings stay closed, beyond what bears on this range.
- GitHub PR and CI state, and the state of Phases 4 and 13.

**Note for the author.** Placing this file in `/mnt/project-files/phase14` turns `manifest-shared` red
(`ARTIFACT WITH NO ROW`) until a row is added. That is the gate working.

*This review signs nothing on the author's behalf and does not promote the phase. `PREPARED` /
`CHALLENGED` / `NOT PROMOTED`, and `READY_TO_PROMOTE` = NO.*
