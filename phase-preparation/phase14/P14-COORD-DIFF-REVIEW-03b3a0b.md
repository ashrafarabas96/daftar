# P14 — COORDINATOR ACTUAL-DIFF RE-REVIEW AT `03b3a0b`

| | |
|---|---|
| Head reviewed | `03b3a0bd2ddfcb7d3e83a9625c909c27e0ec0934` on `claude/project-thread-1zqgj8`. `git rev-parse HEAD` in a fresh clone gave this SHA, and `git ls-remote origin` gave the same SHA again at 2026-10-12T21:37:47Z, just before this file was written |
| Range reviewed | `a725342..03b3a0b`: two commits (`8f6c849`, `03b3a0b`), 15 files, +1432/−65, all under `phase-preparation/phase14/` |
| Inputs | `P14-COORD-DIFF-REVIEW-a725342.md` (my earlier REJECT), `P14-CHALLENGE-8f6c849.md` (REJECT), `P14-CHALLENGE-03b3a0b.md` (PASS-WITH-SCOPE), and the pack's `P14-AMENDMENT-17-CHALLENGE-ROUND-12.md` and `tools/RETRACTED-CLAIMS.tsv` |
| Reviewer | A coordinator worker that wrote no part of the pack. I edited nothing in the repository, and committed and pushed nothing |
| Runtimes | Python 3.13.16, git 2.43.0, GNU bash 5.2.21, PostgreSQL 16.15 (`server_version_num` 160015, `initdb --locale=en_US.utf8`, run as the unprivileged `claude` account). **Node was not used** |
| Method | Fresh clone at `/tmp/claude-0/p14-coord-03b3a0b/repo`. Plants are under `…/plants`. A world-readable second clone at `/var/tmp/p14c/repo` was used for the database lane, with the scratch cluster at `/tmp/p14pg`, the path the scripts hard-code. Both are removed now (§7) |

## 1. Verdict: **REJECT**. Three blocking findings, all of them sentences added in this range that the code contradicts

| ID | Short form | Kind |
|---|---|---|
| **B1** | A gate definition names two red proofs and a flag that have never existed, and states an exit code that is now false | false proof claim + false exit-code claim |
| **B2** | One ordinary commit that **moves the pack directory** and forges a reviewer row gives rc **0** with *"checked over every revision of the manifest"*, **even with no counterpart**. Measured on a full clone of the real repository | fail-open with a "checked" message, contradicting an in-range claim |
| **B3** | In a shallow clone, deleting every reviewer row and file still gives rc **0** when the counterpart directory is absent, empty or unreadable, which is the CI shape. The pack says *"NOT CHECKED no longer exits 0"* without scope | fail-open (an `OSError` is read as "no reports") + false exit-code claim |

**What the round did close is real. I measured it:**

- the drop/re-add route (P2-01-bis);
- the blobless route (R12-P1-01);
- the worktree `--git-common-dir` fix;
- the preflight's "unclassified" branch;
- the trap's exit codes.

**Every figure I was asked to check reproduces:**

| Figure | Result |
|---|---|
| gate-sweep | **44 ok**, rc 0 |
| replay | **46 cases**, rc 0 |
| redproof-preflight | **5 arms**, rc 0 |
| manifest | **44 rows / 44 files**, rc 0 |
| RETRACTED-CLAIMS | **13 claims across 27 documents**, rc 0 |

The scope is clean. `PREPARED / NOT PROMOTED`; `READY_TO_PROMOTE` = NO.

## 2. Scope

| Check | Result | Command → rc |
|---|---|---|
| Files outside the pack, in the range | **0** | `git diff --name-status a725342 03b3a0b \| grep -vc phase-preparation/phase14/` → 0 lines |
| Files outside the pack, merge-base `6fc505d` to head | **0** | `git diff --name-only 6fc505d 03b3a0b \| grep -v …` → 0 lines |
| Frozen paths (`infrastructure/ apps/ packages/ package.json .github/`) | untouched | `git diff --quiet 6fc505d 03b3a0b -- …` → **0** |
| My a725342 review, committed unedited | sha256 `5cc8305d561c…`, the same in the pack and in `/mnt` | `sha256sum` |
| Challenger round 12, committed unedited | sha256 `34ccc01bc042…`, the same in both | `sha256sum` |
| Shared folder during this review | **Moved after the commit.** It now holds `P14-CHALLENGE-03b3a0b.md` and an uncommitted `P14-AMENDMENT-18-CHALLENGE-ROUND-13.md`. `P14-AMENDMENT-17…`, `P14-HANDOFF-MANIFEST.md` and `P14-MIGRATION-PATCH-REQUEST.md` differ from the commit (all with mtime 21:30:29Z). **I reviewed `03b3a0b` only**, and none of that work in progress | `ls -la`, `cmp` |

## 3. The figures, regenerated (item 1)

| Figure claimed | Measured at `03b3a0b` | Command → rc | Does the check fail on ABSENCE? |
|---|---|---|---|
| gate-sweep **44 ok** | **44 `ok`, 0 FAIL, rc 0**. The shared-folder lane was pointed at a copy of the pack's 45 `.md`/`.yaml` files, which is the shared folder as it stood at the commit. Against the live `/mnt` it gives 43 ok and 1 FAIL (`manifest-shared`: `P14-CHALLENGE-03b3a0b.md: ARTIFACT WITH NO ROW`). That FAIL is the gate working, not a defect | `bash tools/gate-sweep.sh` (the only change was `SHARED=` in a temporary copy, deleted afterwards) → **0**; unmodified → **1**; `--no-db` → **1** (36 ok + that same FAIL) | **No.** The sweep counts failures, not `ok` lines, so a deleted proof lowers the count and the sweep stays 0 |
| replay **46 cases** | `== 46 case(s) replayed, 0 not at their required exit code` | `proofs/replay.sh` (as root) → **0** | **No.** With the last `ORDER` line removed it prints `45 case(s) …` → **0**. An empty selection → 2 |
| redproof-preflight **5 arms** | `== 5 arm(s), 0 not red`, version arm UNFENCED | `proofs/redproof-preflight.sh` → **0** | Partly: `n=0` → 2. Nothing fixes the floor at 5 (code read) |
| manifest **44 rows** | `44 artifact row(s) … 44 file(s)`, `checked over every revision` | `manifest-digests.py --dir . --check` → **0** | Yes in a full history (`SIGNED ROW REMOVED`). **No** in the B3 world |
| RETRACTED-CLAIMS **13 / 27** | `13 retracted claim(s) enforced across 27 pack document(s)` | `retracted-claims.py --pack . --check` → **0** | An empty TSV → **2**. **One row deleted → 0** (`12 …`); the 13 is not asserted |

None of the "absence" gaps is a false claim, because no committed sentence says those counts are fenced. They are listed as R-1 in §5.

## 4. Blocking findings

### B1 — two red proofs and a flag that do not exist, written into the gate definition

**Added in `8f6c849`** (`git log -S'shallow-with-counterpart-passes'` returns only `8f6c849`). It is present at `03b3a0b` in three places:

- **`P14-TASK-DAG.md:193`** (`P14-GATE-035`, the gate definition itself), quoted:

  > in a truncated clone WITH a matching counterpart the committed forgery passes at `0` … That case is red-proofed **as it is** (`shallow-with-counterpart-passes` requires `0` together with `NOT CHECKED` in one output), and `--require-history` refuses instead … (`shallow-require-history-refuses`). A CI job running this gate needs `fetch-depth: 0` AND `--require-history`

- **`P14-AMENDMENT-15-COORD-DIFF-REVIEW-c812aa5.md:54-67`**: the same three claims. No annotation follows them; the annotation at `:71` is about P2-01-bis.
- **`README-AR.md:175-182`** (item 12): «صار للحالة برهان أحمر يشترط الصفر … وأُضيف خيار `--require-history` … أي تكامل مستمر … يحتاج … هذا الخيار» ("the case now has a red proof requiring zero … and a `--require-history` option was added … any CI … needs this option"). Item 13 changes the default, but it retracts neither the proof nor the flag.

**Measured:**

| Claim | Fact at `03b3a0b` | Command → rc |
|---|---|---|
| proof `shallow-with-counterpart-passes` | **does not exist** in any tool at `a725342`, `8f6c849` or `03b3a0b` | `git grep -c … <rev> -- tools proofs` → no hits at any of the three |
| proof `shallow-require-history-refuses` | **does not exist** | same |
| flag `--require-history` | **does not exist.** Following the gate definition's CI instruction breaks the gate | `manifest-digests.py --dir . --check --require-history` → **2** (`unrecognized arguments`) |
| "the committed forgery passes at `0`" (shallow clone, counterpart in step) | **refuses, rc 1** | sweep line `ok shallow-counterpart-refused rc=1, refused with HISTORY NOT VERIFIED` |

**Cause.** Amendment 16 §2 (`:86-88`) records that the author's first attempt had `--require-history` as an opt-in and then reversed the default. These three passages describe that first attempt. The same TASK-DAG cell also says the opposite ("NOT CHECKED no longer exits 0"), so the gate definition now contradicts itself. `retracted-claims.py` cannot see this, because it has no row for these strings.

**Remedy (small):**

1. Delete or annotate the three passages.
2. Add a `RETRACTED-CLAIMS.tsv` row for `shallow-with-counterpart-passes` and one for `--require-history`, so they cannot return.

### B2 (P2-01-ter) — move the pack directory and forge in the same commit: rc 0, "checked over every revision"

**The defect.** The walk asks `git rev-list HEAD -- P14-HANDOFF-MANIFEST.md` (`tools/manifest-digests.py:118`), which is keyed to the manifest's **current** path and does not follow renames.

- **One ordinary commit** can `git mv` the pack directory (for example at promotion) while appending to a reviewer report and hand-forging its row.
- At the new path, that commit is the only revision, and it is the "oldest".
- Its parent has no file at the new path, so the completeness test (`:161-169`) calls it "the commit that added it".
- The forged digest becomes the witness. Every received record at the old path is never read.

**Measured on a full clone of the real repository** (`plants/realrename`):

- **Setup.**
  - Branch `plant` from `03b3a0b`, not shallow.
  - **One** commit `promote: move the pack`, which does `git mv phase-preparation/phase14 phase-preparation/phase14-promoted` and runs `forge` on `P14-CHALLENGE-7af6438.md`.
  - A scratch shared copy was edited in step.
  - The tool run is the moved pack's own `tools/manifest-digests.py`, with cwd `/tmp`.
- **What git can see.** `git log --follow` sees **20** revisions of the manifest. The tool walks **1**.

| Lane | rc | What it printed |
|---|---|---|
| `--dir <moved pack> --witness <shared copy> --check` | **0** | `reviewer-row history checked over every revision of the manifest, OLDEST first` / `every artifact row matches` |
| `--dir <shared copy> --witness <moved pack> --check` | **0** | same |
| `--dir <moved pack> --witness /nonexistent --check` (the CI shape: no counterpart) | **0** | same |

**The same route in a constructed repository** (`plants/rename`: pack at `a/phase14`, one commit moves it to `b` and forges):

| Run | `03b3a0b` | `8f6c849` | `a725342` |
|---|---|---|---|
| counterpart in step, `--check` | **0** | 0 | 0 |
| counterpart in step, `--write` | **0** | — | — |
| no counterpart, `--check` | **0** | 0 | 0 |
| counterpart untouched | 1 (`REVIEWER COPIES DIFFER`) | — | — |
| **control:** the same forgery **without** the move | **1** (`REVIEWER ROW REWRITTEN IN HISTORY`) | — | — |

**Why it blocks.** The hole predates this range, but this range adds the sentences that say it is closed:

- `P14-AMENDMENT-16-COORD-RE-REVIEW-a725342.md:47`: *"the manifest is absent in it (**a deletion, or a rename**) → the revision is **skipped and recorded** … A deletion erases nothing."* A rename revision is never visited, and the records before it are erased from the witness.
- `P14-TASK-DAG.md:193`: *"What remains unguarded is rewriting the manifest's history itself."* An ordinary commit is a second route.
- `README-AR.md:195`: «وما يُلغي الشاهد هو غياب العقد نفسه فقط» ("only the absence of the commit object discards the witness").
- `tools/manifest-digests.py:100-104` still says *"which no later commit can erase … What a commit can still do is rewrite history"*. My a725342 review cited this same sentence (then at `:85-89`). It survived, and the TSV does not scan `.py`.
- The printed line itself says *"checked over every revision of the manifest"* when 19 of 20 were not read.

**This is the fourth round of one species:** the witness is anchored to something the same hand can change in one commit. This time the anchor is the path. It is the same kind of finding that blocked in the last two coordinator reviews.

**Remedy:**

- **(a) Fix the walk.**
  - Walk the manifest's history across renames: `git log --follow --format=%H --name-only -- <path>`, reading each revision at **its own** path. Note that `--follow` only finds the move when the file stays similar enough to be detected as a rename.
  - For something sturdier, collect every revision of any path whose basename is `P14-HANDOFF-MANIFEST.md`, with `git rev-list HEAD -- ':(glob)**/P14-HANDOFF-MANIFEST.md'`, and read each revision at the path it had.
  - Add a red proof: move plus forge in one commit, no counterpart, rc 1.
- **(b) Narrow the sentences.** Say that a commit which moves the pack makes the history start at that commit.

### B3 — `NOT CHECKED` still exits 0 when every review is deleted and the counterpart cannot be read

**The defect.** R12-P2-01's remedy (`tools/manifest-digests.py:356-365`) refuses only when a reviewer row is still listed **or** `_wreports` is non-empty. `_wreports` comes from `os.listdir(_wdir)`, and **any `OSError` becomes `[]`** (`:358-361`). So "the counterpart could not be read" is treated as "the counterpart holds no reports", and the tool prints success.

**Measured** (`plants/shdel`): a `--depth 1` clone of a copy of the pack, with **all 19** reviewer rows and files removed. cwd `/tmp`.

| Counterpart | rc | What it printed |
|---|---|---|
| the pack (holds the reports) | **1** | `HISTORY NOT VERIFIED … 19 reviewer report(s) … have NO ROW here` (R12-P2-01's fix works) |
| **`/nonexistent`**: the CI shape (no `/mnt` folder, `actions/checkout` depth 1) | **0** | `reviewer-row history NOT CHECKED (… shallow boundary …)` / `every artifact row matches the file on disk` |
| a regular file (`/etc/hostname`), so `listdir` raises `NotADirectoryError` | **0** | same |
| an empty directory | **0** | same |
| control: the same removal in a full history, no counterpart | **1** | `SIGNED REVIEWER ROW REMOVED` ×19 |

**Sentences this contradicts, all added in this range:**

- `P14-TASK-DAG.md:193`: *"**`NOT CHECKED` no longer exits 0** — it refuses unless the caller passes `--allow-unverified-history`"*. This is unscoped, and the run above is NOT CHECKED, no flag, rc 0.
- `P14-HANDOFF-MANIFEST.md:94` (the Amendment 16 row): *"`NOT CHECKED` no longer exits 0"*.
- `P14-AMENDMENT-17-CHALLENGE-ROUND-12.md:57-58`: *"under Amendment 16's rule `NOT CHECKED` refuses"*.
- `README-AR.md:129`: «لا يُجيب أصلًا بل **يرفض**» ("does not answer at all, it **refuses**").
- The title of `8f6c849`: *"NOT CHECKED is not a pass"*.

Amendment 16 §2 (`:81-83`) and Amendment 17 §2 scope the rule correctly ("a reviewer row present", "if that directory holds reviewer reports"). The four sentences above do not.

**Why it blocks.** The world is the one R12-P2-01 was filed on, *"never had a review"* versus *"every review just deleted"*, with the counterpart missing instead of present. That is exactly CI. And an exception is mapped to the permissive value.

**Remedy:**

- Under `NOT CHECKED`, treat a missing or unreadable counterpart as a refusal (`HISTORY NOT VERIFIED … and no counterpart could be read at <wdir>`). The `--allow-unverified-history` opt-out remains.
- Add a red proof: depth 1, every review deleted, `--witness /nonexistent`, rc 1.
- Or narrow the four sentences.

## 5. The seven questions

### 1. Counts, exit codes and proofs

See §3 for the figures. In-range counts I also checked:

- **"Six new red proofs"** (`P14-HANDOFF-MANIFEST.md:95`): true. There are six names, all present and all `ok`.
- **"Five new red proofs"** (`8f6c849`): true.

The false proof claims are B1, B2 and B3.

### 2. `manifest-digests.py` branches and subprocess exit codes

The `ls-tree` branch itself (`:211-224`) is correct:

- an empty result **with rc 0** records a gap;
- rc ≠ 0 gives `NOT CHECKED`;
- an entry whose content cannot be read gives `NOT CHECKED`;
- all three discard the witness and `moved`.

The sweep's blobless proofs were rc 1/1/0 with the premise asserted, in my run.

**What I measured beyond the challenger:**

- **Treeless clone** (`--filter=tree:0`, promisor pointed at a missing path; `plants/treeless`):
  - `ls-tree` → 128 and `rev-list -- path` → 128;
  - the tool gives rc **1** (fail-closed), **but it names the wrong cause**: *"NOT CHECKED (the manifest is not in a git repository here)"*. `:170-171` maps every `rev-list` failure to that sentence. P3, the wrong-cause class.
- **Exit codes that are read, line by line:**
  - `:118` rev-list: read. Wrong cause, as above.
  - `:134` `rev-parse X^@`: read, but **rc ≠ 0 is treated as "no parents"** (a root). This is fail-open in shape. I could not reach it, because a commit `rev-list` just listed always yields its parents. P3.
  - `:135` `--is-shallow-repository`: **not read.** A failure means "not shallow". It is supported from git 2.15. P3.
  - `:150-152`: if **both** `rev-parse` calls print nothing, `os.path.join('', 'shallow')` opens **`./shallow` relative to the caller's cwd**. I could not reach this with git 2.43 (code read). P3.
  - `:166` `cat-file -e <parent>:./<path>` keeps the one-question ambiguity that R12-P1-01 removed from the walk: a missing blob there reads as "the parent did not have the file". It only matters when the oldest listed revision is not the adding commit, which I could not construct without grafts or replace refs (code read). P3.
- **Not covered:** `rev-list` uses default (date) order and not `--topo-order`, so the "OLDEST" revision can be wrong under skewed dates. By reading, the `moved` refusal does not depend on order, so a backdated forgery still meets a disagreeing revision. Not measured.

### 3. `--git-common-dir`

It is the **only** place a git dir is read for `shallow`. Citation-provenance's `--git-dir` call (`citation-provenance.py:91`) checks only that the path is a repository.

| World | rc | Result |
|---|---|---|
| linked worktree of a **shallow** clone (`plants/shwt`) | **1** | `NOT CHECKED (… shallow boundary …)`, the same as its main checkout |
| linked worktree of a full clone | **0** | `checked` |

The fix holds in both directions.

### 4. The preflight's `case` and the `select 1` premise

**The unclassified branch** (`redproof-preflight.sh:131-135`) prints its sentence and then `fail++`, and the script ends `exit 1`. It is **never green**.

- Measured: `p14_resolver` renamed away, then `redproof-preflight.sh rolecount` → rc **1**, `psql said: ERROR: role "p14_resolver" does not exist` / `CAUSE: not classified by this script`.

**P3, wrong cause.** The new pattern `*"connection to server"*` (`:120`) also matches every connection-time FATAL from a **running** cluster.

- Measured: with a `local postgres p14super reject` rule in `pg_hba.conf` and the server running (`pg_ctl status`: running), `redproof-preflight.sh collation` → rc **1**, with `CAUSE: no cluster is listening on /tmp/p14pg/sock:54314`. That cause is false.
- In the same state, the sweep's premise check (`gate-sweep.sh:582`) is satisfied, because `select 1` as `p14super` fails.
- So by composition (each half measured, the combination not run end to end), `no-cluster` would print `ok … rc=1 with the cluster STOPPED` (`:590`) while the cluster is up.
- **Fail-closed overall:** in that world `replay` and `redproof-preflight` are red, so the sweep is red. The premise being asserted is "`p14super` cannot run `select 1`", not "nothing is listening"; `pg_ctl status` would assert the latter.

### 5. The traps

`cleanup` ends `return 0`, and **bash 5.2 keeps the script's own exit status through an `EXIT` trap**, even one that returns 1. Measured with stand-alone scripts:

- `fail=0` → **0**; `fail=1` → **1**;
- `TERM` → **143**.

On the real sweep (`--no-db`), `kill -TERM <sweep pid>` at 2 s, 8 s and 15 s:

- each gave **143** and `TERMINATED: restoring the pack and leaving.`;
- `git status --porcelain` showed 0 lines, and `git worktree list` showed 1 entry (none leaked);
- at 22 s the sweep had already finished, with rc 1 (the live-`/mnt` FAIL).

The double `cleanup` after `exit 130/143` is idempotent by reading.

**P3:** `cleanup` does not remove the proof scratch directories. The 15 s interrupt left **8** `/tmp/tmp.*` directories (`FW`, `DW`, `NR`, `ER`, `OP`, …). They hold no pack state and are fail-closed; I removed them.

**Not measured by me:** the restore of `PGSTOPPED` and `PGRENAMED` on a signal. The window is about a second wide. The challenger measured it with a timing instrument (`P14-CHALLENGE-03b3a0b.md` §4).

### 6. Fail-open anywhere

- B2 and B3, as above.
- I found none in `gate()`, `red()`, `named()` or the worktree lane: each requires rc 0, or the exact required code **and** its sentence.
- The DB block has no `else` when `/tmp/p14pg/data` is absent. The five DB proofs are then silently skipped, but the `replay` and `redproof-preflight` gate lanes still go red, so the sweep is not a pass (code read).

### 7. The challenger's R13-P2-01 (symlinked manifest)

**I agree it is non-blocking on its own.** B2 reaches the same outcome more simply: rc 0 and "checked" with **no** counterpart, where the symlink variant needs the counterpart in step, or it gets `NO WITNESS`.

**But its reachability argument does not hold.** *"Not reachable without rewriting history"* assumes the manifest's first revision is fixed. B2 shows an ordinary commit can start a new first revision at a new path, and that revision can be a symlink.

The fix for B2 (walking across paths) and the challenger's *"NO RECORD IN ANY REVISION"* sentence should land together.

**The challenger's other items:**

- R13-P3-01 (the 18/19 figure): agreed, P3.
- R13-P3-02 (the 20:24:17Z diagnosis): agreed it cannot be reproduced.
- R13-P3-03 (carried items): agreed.

## 6. Residuals (non-blocking)

| ID | Sev | file:line | Finding | Evidence |
|---|---|---|---|---|
| R-1 | P3 | `proofs/replay.sh`, `redproof-preflight.sh`, `tools/gate-sweep.sh`, `retracted-claims.py` | The headline counts (46, 5, 44, 13) are **not fenced against partial absence**: one case, arm, proof or TSV row can go missing and the gates stay 0 | replay with one `ORDER` line removed → **0**, 45 cases; TSV with one row removed → **0**, 12 claims |
| R-2 | P3 | `tools/manifest-digests.py:170-171` | Treeless or unfetchable-tree clone is reported as *"not in a git repository"*. Fail-closed, wrong cause | `plants/treeless` → **1** |
| R-3 | P3 | `proofs/redproof-preflight.sh:120`; `tools/gate-sweep.sh:582,590` | A connection-time FATAL from a running cluster is classified as "no cluster is listening", and the sweep's premise accepts it. Fail-closed overall | pg_hba reject → preflight **1** with a false CAUSE; premise grep **1** |
| R-4 | P3 | `tools/manifest-digests.py:134,135,150-154,166` | Unread or permissively read return codes (`^@` → root; `--is-shallow-repository` unread; empty git dir → cwd-relative `shallow`; `cat-file -e` blob ambiguity at the parent test). None reachable in my worlds | code read |
| R-5 | P3 | `tools/gate-sweep.sh` `cleanup()` | Proof scratch directories are leaked on interrupt | TERM at 15 s → 8 directories |
| R-6 | P3 | `P14-AMENDMENT-17…:93-101` | "18 reviewer rows" is the previous head's figure (19 now). This is the challenger's R13-P3-01 | sweep `shallow-every-review-deleted-names-them` |
| Gap | — | `tools/gate-sweep.sh` | No red proof for B2 (move plus forge) or B3 (depth 1, every review deleted, no counterpart). The PROPOSES-new-directory gap from my a725342 review is still open (Amendment 17 §6 says so) | reading |

## 7. Not covered, and housekeeping

**Not covered:**

- R12-P3-01's cluster and role restore on a signal: only the challenger measured it.
- The version arm (UNFENCED).
- Concurrency and performance.
- Node, which was not run at all.
- GitHub PR and CI state.
- The design and the Arabic prose beyond the paragraphs cited.
- The uncommitted Amendment 18 in the shared folder.
- The `rev-list` ordering question (§5, question 2).
- The `PGRENAMED` window.

**Scratch** (everything is removed now):

- `/tmp/claude-0/p14-coord-03b3a0b`: the clone, plants and logs.
- `/var/tmp/p14c`: the world-readable clone and the shared-copy.
- `/tmp/p14pg`: the cluster. It was stopped with `pg_ctl -m fast stop` before removal.
- My temporary `tools/gs-local.sh` was deleted, and the edits to `ORDER`, the TSV and `pg_hba.conf` were restored before removal.
- The `/tmp/tmp.*` directories leaked by my interrupt test were removed.

The postgres on port 54377 (`/var/tmp/p5coord-…`) belongs to another session and was not touched. **Nothing was written to `/mnt/project-files` except this file.**

*This review signs nothing on the author's behalf and does not promote the phase. `PREPARED` / `CHALLENGED` / `NOT PROMOTED`; `READY_TO_PROMOTE` = NO.*
