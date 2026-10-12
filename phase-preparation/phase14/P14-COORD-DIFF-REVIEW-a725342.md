# P14 — COORDINATOR ACTUAL-DIFF RE-REVIEW AT `a725342`

| | |
|---|---|
| Head reviewed | `a7253421fd7d52cce58862ddc22b33ecc515909b` on `claude/project-thread-1zqgj8`. `git ls-remote origin` showed this SHA at the start of the review and again at 2026-10-12T20:12:51Z, immediately before this file was written |
| Range reviewed | `c812aa5..a725342`: one commit, 17 files, +981/−73. Two added (`P14-AMENDMENT-15-COORD-DIFF-REVIEW-c812aa5.md`, `P14-COORD-DIFF-REVIEW-c812aa5.md`) and 15 modified |
| Against the merge-base | `git merge-base origin/main a725342` = `6fc505d`, which is also the current `origin/main` |
| Inputs | `P14-COORD-DIFF-REVIEW-c812aa5.md` (the earlier review) and `P14-AMENDMENT-15-COORD-DIFF-REVIEW-c812aa5.md` (the author's answer). I did not read `P14-CHALLENGE-a725342.md`, which appeared in the shared folder during this review |
| Reviewer | A coordinator worker that wrote no part of the pack. It edited no file in the repository, and committed and pushed nothing |
| Method | A fresh clone at `/tmp/claude-0/p14-coord-a725342`, checked out at the pinned SHA. I ran plants in scratch repositories under `/tmp/claude-0/p14-plants` and ran the `--no-db` sweep. **I ran no database, cluster, `replay.sh` arm, SQL case or `locale-gen`.** |
| Runtimes | **`node --version` = v22.22.0.** Node was **not used**, and no Node test was run. No result here is a Node 24 result. Python 3.13.16, git 2.43.0. `npm ci` was not needed, and nothing was installed |

## 1. Verdict: **REJECT** (narrow). One blocking finding. Blockers 2 and 3 are closed

**Blocking: one.** **P2-01-bis** is the same species as `R10-P2-01` and c812aa5's `P2-01`, one step further on.

- The oldest-digest witness and the `REWRITTEN IN HISTORY` refusal both work. I measured them, and they are red against the old code.
- **The amendment says that only history rewriting can defeat the witness.** Two ordinary commits defeat it: delete `P14-HANDOFF-MANIFEST.md`, then re-add it with the forged row. Nothing is force-pushed or filtered.
- **How it opens.** The deletion commit is an unreadable revision. The code treats any unreadable revision as `NOT CHECKED` and **discards** the whole history witness, including the older records that are still fully readable.
- **The result.** In the "counterpart edited in step" world, both `--check` and `--write` return **0**. The amendment claims that world is closed and red-proofs it as `reviewer-row-forged-both-dirs`.
- **What the sweep shows.** It prints `ok … rc=0`, and the `NOT CHECKED` sentence is not surfaced.
- **Narrower than P2-01.** With no counterpart, or with an untouched one, the refusal still fires (rc 1).

**Closed by measurement:**

- **Blocker 1** is closed, except for the route above. Both of the coordinator's c812aa5 worlds now exit 1, and the old code and two mutants exit 0 on them.
- **Blocker 2** is closed. The block lists 9 real, absent files. On the same pack the old tool lists 13, four of them the pack's own tools.
- **Blocker 3** is closed. No live count of commits, rows or rounds is left on the first pages.
- **Residuals.** I measured R-01, R-02, R-03, R-04, R-08, R-09 and R-10 as closed, and R-11 as partially closed. Six new P3 residuals are listed in §4.

The scope is clean: every file is under `phase-preparation/phase14/`, nothing frozen is touched and no migration number appears. `PREPARED / NOT PROMOTED` is unchanged, and `READY_TO_PROMOTE` stays **NO**.

## 2. Scope

| Check | Result | Command → rc |
|---|---|---|
| Files in range | **17**, all under `phase-preparation/phase14/`. Modified: `P14-AMENDMENT-03/04/05/14`, `P14-HANDOFF-MANIFEST.md`, `P14-MIGRATION-PATCH-REQUEST.md`, `P14-TASK-DAG.md`, `README-AR.md`, `proofs/cases/c1a_restrict_column_refused.sql`, `proofs/redproof-preflight.sh`, `tools/{RETRACTED-CLAIMS.tsv,citation-provenance.py,gate-sweep.sh,manifest-digests.py,retracted-claims.py}` | `git diff --name-status c812aa5 a725342` → 0 |
| Outside the pack, merge-base to head | **none** | `git diff --name-status 6fc505d a725342 \| grep -v phase-preparation/phase14/` → grep rc **1** (no lines) |
| Frozen paths | **untouched** | `git diff --quiet 6fc505d a725342 -- infrastructure/ apps/ packages/ package.json .github/` → **0** |
| The c812aa5 review committed unedited | sha256 `62269c4d16a4…70cb6229` in both directories | `sha256sum` of the committed copy and the `/mnt` copy |
| Shared folder against the commit | **40 files, 0 differing** (before this file was written) | `cmp` loop over `/mnt/project-files/phase14/*` |
| Manifest rows | **39 rows** in each directory, `checked over every revision of the manifest, OLDEST first` | `manifest-digests.py --dir <pack> --check` → **0**; `--dir /mnt/project-files/phase14 --check` → **0** |

## 3. The three blockers, re-measured

### Blocker 1 (P2-01) — the witness: CLOSED for the measured worlds, REOPENED by a new route (P2-01-bis)

**Plants.**

- **Scripts.** `/tmp/claude-0/p14-plants/plants.sh` and `plants2.sh`.
- **Worlds.** Each world is a fresh `git init` copy of the a725342 pack with one "received" commit. The report is `P14-CHALLENGE-50b0341.md` unless a row says otherwise. Every forgery appends one line to the report and hand-forges its row to the new sha256 and byte count.
- **Code under test.** "new" is a725342 `tools/manifest-digests.py`. "old" is `git show c812aa5:…/manifest-digests.py`. `mut-A` restores newest-first only. `mut-B` restores newest-first and disables the `moved` refusal.
- **Working directory.** The tool's cwd was `/tmp` in every row.

| # | World | new | old | mut-A | mut-B | Refusal named (new) |
|---|---|---|---|---|---|---|
| 1 | forged row **committed**, empty `--witness`, `--check` | **1** | 0 | 1 | 0 | `REVIEWER ROW REWRITTEN IN HISTORY: … recorded as e89fcb1c90ea when it was received` |
| 1w | same, `--write` | **1** | 0 | 1 | 0 | same |
| 2 | forged row committed, counterpart **edited in step** | **1** | 0 | 1 | 0 | same |
| 3 | a **coordinator** review (`P14-COORD-DIFF-REVIEW-583a4a0.md`) forged and committed, counterpart in step | **1** | 0 | 1 | 0 | same, naming `018a56a446be` |
| 4 | signed reviewer row **and** report deleted and committed; counterpart also deleted; `--check` | **1** | 0 | 1 | 1 | `SIGNED REVIEWER ROW REMOVED … (e89fcb1c90ea)` |
| 4w | same, **`--write`** | **0** | 0 | 0 | 0 | flagged but exits 0 (R-NEW-2) |
| 4b | a non-reviewer row (`P14-AMENDMENT-01-…`) deleted | 1 | 0 | 1 | 1 | **`SIGNED REVIEWER ROW REMOVED … A received review is not deleted`**: wrong cause (R-NEW-3) |
| 5 | `--depth 1`, `--depth 2`, `--depth 4` clones, forged, empty witness | **1** each | 0 each | 1 | 1 | `NO WITNESS`; history line `NOT CHECKED (revision … is the shallow boundary of this clone …)` |
| 5w | the same shallow clones, counterpart in step | 0 each | 0 each | — | — | `NOT CHECKED (… shallow boundary …)`, **declared**. This is the stated limit: no history exists to ask |
| 5f | the same repository, full history (`--depth 9`, not shallow), counterpart in step | **1** | 0 | — | — | `REWRITTEN IN HISTORY` |
| 2b | forgery committed, then `git revert`; report and row both back to what was received | 1 | 0 | — | — | `REWRITTEN IN HISTORY` forever (R-NEW-4) |
| **6** | **two ordinary commits: `git rm` the manifest, then re-add it with the forged row**; counterpart in step; `--check` | **0** | 0 | 0 | 0 | none. History line `NOT CHECKED (revision d46f89de5cd4 of this manifest could not be read: fatal: path 'P14-H…` |
| **6w** | same, **`--write`** | **0** | 0 | 0 | 0 | none |
| 6e | same, **empty** witness | 1 | 0 | 1 | 1 | `NO WITNESS` |
| 6u | same, **untouched** witness | 1 | 1 | 1 | 1 | `REVIEWER COPIES DIFFER` |
| 6r | same route, report **deleted** with its row in both directories | **0** | — | — | — | none: R-02's refusal is also disabled by this route (`/tmp/claude-0/p14-plants/del2`) |

**Red against the old code: yes.**

- Rows 1, 1w, 2 and 3 exit 0 under c812aa5's code and under `mut-B`, and exit 1 under a725342.
- `mut-A` stays red because the `moved` refusal does not depend on walk order. There are two independent guards, which is good.
- Rows 5 (all three depths) are 0 under the old code and 1 under the new one.

**P2-01-bis, measured on a full clone of the real repository.**

- **Setup.** `/tmp/claude-0/p14-plants/real/repo`, on branch `plant` from a725342, not shallow. The shared folder was replaced by a scratch copy at `…/real/shared`. Nothing was written to `/mnt`.
- **Commands.** The sweep's two manifest lanes, with the counterpart swapped for that scratch copy:

| step | `--dir <pack> --witness <shared-copy> --check` | `--dir <shared-copy> --witness <pack> --check` |
|---|---|---|
| baseline at a725342 | **0** | **0** |
| one commit: forged report and row, shared copy edited in step | **1** (`REWRITTEN IN HISTORY`) | **1** |
| two more ordinary commits: `git rm` the manifest, then re-add the same file | **0** (`NOT CHECKED (revision 20fd86e97789 … could not be read`) | **0** |

**Where the sentence is wider than the code:**

- `P14-AMENDMENT-15-COORD-DIFF-REVIEW-c812aa5.md:54-56`: "**A commit cannot move the witness; `git filter-branch` or a force-push can.**" A delete commit followed by a re-add commit does not move the witness. It **discards** it, and the forgery passes. No history is rewritten.
- `tools/manifest-digests.py:85-89`: "the OLDEST recorded digest … **which no later commit can erase** … What a commit can still do is rewrite history".
- `P14-TASK-DAG.md:193` (`P14-GATE-035`): "What a commit still can do is rewrite the manifest's history; that is named, not guarded". The same cell lists `reviewer-row-forged-both-dirs` as a red proof of the closed world.
- `README-AR.md` §6 (the new paragraph): «وأي مراجعة لاحقة تخالفها تُرفض بذاتها» ("any later revision that disagrees with it is refused in its own right"). After a drop and re-add, no revision is compared at all.

**Cause.**

- `tools/manifest-digests.py:150-158`: any `git show <rev>:./manifest` failure resets `signed_history, moved = {}, {}` and breaks out of the walk.
- A **deletion** revision in a complete history is not a truncation. The revisions before it are readable, and so is the receipt digest.
- The rule "NOT CHECKED discards" is right for the graft boundary, where the history is genuinely gone. It is wrong for a gap the author can create with a commit.
- The sweep line `gate-sweep.sh:80` prints `ok … rc=0`, and the history line is never shown to the reader of the gate.

**Grade.** This is blocking under the coordinator's bar. It is a false proof claim, and the refusal fails open in a world the amendment says is closed. It is the same route-one-step-over pattern as the last two rounds, and it is narrower than c812aa5's P2-01, because the no-counterpart and untouched-counterpart worlds still refuse.

**Remedy (small).** Do either one:

- **(a) Fix the walk.**
  - A revision whose *commit* is readable but which does not contain the manifest should be skipped, not discarded, because a deletion does not erase the older records.
  - Alternatively, refuse it by name (`MANIFEST REMOVED IN HISTORY`).
  - Keep `NOT CHECKED` only for a missing object or a graft boundary.
  - Add a red proof: drop and re-add, both directories in step, required rc 1.
- **(b) Narrow the sentences.** Say that a commit that deletes or renames the manifest makes the history `NOT CHECKED`, and that the other directory is then the only witness.

### Blocker 2 (P2-02) — the PROPOSES bucket: CLOSED

| Check | Result | Command → rc |
|---|---|---|
| The committed generated block | `P14-MIGRATION-PATCH-REQUEST.md:1479`: **9 file(s) (10 tokens)** PROPOSES: `apps/api/src/modules/integrations/key-material.ts`, `packages/domain-core/src/api-scopes.ts`, `packages/shared-contracts/src/public-api.ts`, `scripts/phase14-{event-catalogue-gate,gate,openapi,registry-gate}.ts`, `webhooks/egress-guard.ts`, `webhooks/signature.ts`. No `tools/*` file is in it. `:1474` now says "all **five** add up to the 115" | `citation-provenance.py --check …/P14-MIGRATION-PATCH-REQUEST.md` → **0** ("block is current") |
| The 9 are truly absent | All 7 path tokens are absent at `93084f8`, `6fc505d` and `a725342`. Neither `egress-guard.ts` nor `signature.ts` exists in either tree or in the pack | `git cat-file -e <rev>:<path>` → non-zero ×21; `git ls-tree -r --name-only <rev> \| grep -c /<name>` → 0; `find <pack> -name …` → 0 |
| Red against the old code | **The c812aa5 generator on the a725342 pack lists 13 PROPOSES**, including `citation-provenance.py`, `gate-sweep.sh`, `manifest-digests.py` and `retracted-claims.py`. The a725342 generator lists 9 | `python3 -I old-citation-provenance.py --pack <pack> --repo <clone> --markdown` → 0, compared with `tools/citation-provenance.py --markdown` → 0 |
| The tools directory exists | `RETRACTED-CLAIMS.tsv citation-provenance.py gate-sweep.sh manifest-digests.py retracted-claims.py` | `ls tools` |

The tuple is gone (`citation-provenance.py:267-280` walks the pack, and `:292-308` uses a `:(glob)<pack>/**/<tok>` pathspec that refuses with rc 2 when git rejects it). There is no red proof that plants a pack file in a *new* directory and requires it to stay out of PROPOSES. `--check` still only detects that the block has drifted from its generator. I note this as a gap, not a blocker.

### Blocker 3 (P2-03) — typed counts on the first pages: CLOSED

| Where | At a725342 |
|---|---|
| `P14-HANDOFF-MANIFEST.md:30` "Commits on it" | "**pushed; not counted here**". It cites `git rev-list 6fc505d..HEAD`, and *eight* is recorded as the historical figure |
| `:31` Worktree | "any commit on this branch", citing the coordinator's measured range |
| `:39` §2 lead | "**Every row below** … the number of rows is generated, not typed". *29* is recorded as a retraction |
| `:194` Independent Challenger | "the rounds are **not counted or re-listed here**". *SEVEN ROUNDS RUN* is recorded as a retraction |
| `:259` footer | no amendment is named |
| `README-AR.md:9-12` | «عدد الدفعات غير مكتوب هنا» ("the number of commits is not written here") |
| `P14-AMENDMENT-03/04/05` headers | annotated, not edited |
| `P14-AMENDMENT-03:162` | "205 lines" is replaced by a pointer to the generated table |
| `tools/RETRACTED-CLAIMS.tsv` | three new rows: the witness claim, `SEVEN ROUNDS RUN`, and the exact old PROPOSES string. `retracted-claims.py --check` → **0** in the sweep |

**Grep.** I searched the manifest for a number word or digit within 12 characters of commit, row, round, amendment, addenda or review:

```
grep -n -iE '\b(one|…|seventeen|[0-9]+)\b[^|]{0,12}\b(commits?|rows?|rounds?|amendments?|addenda|reviews?)\b' P14-HANDOFF-MANIFEST.md
```

Every hit is a historical quotation of a retracted figure or a dated description in an artifact row. **No live count of commits, rows or rounds remains on §1, §2-lead, §9 or the footer.**

The Arabic index's «أحد عشر» ("eleven") classified blockers is correct: `P14-HANDOFF-MANIFEST.md` §10 has 11 rows (`awk '/^## 10\./,0' … | grep -cE '^\| *[0-9]+ *\|'` → 11).

## 4. Findings table

| ID | Sev | Blocks | file:line | Finding | Command → rc |
|---|---|---|---|---|---|
| **P2-01-bis** | P2 | **YES** | `tools/manifest-digests.py:150-158`; sentences at `P14-AMENDMENT-15-…:54-56`, `manifest-digests.py:85-89`, `P14-TASK-DAG.md:193`, `README-AR.md` §6 | Two ordinary commits (drop the manifest, re-add it) discard the oldest-digest witness and the `moved` refusal. With the counterpart in step, a forged reviewer report passes `--check` and `--write`, and a deleted review passes too. The amendment says only history rewriting can do this | §3 table rows 6, 6w, 6r and the real-clone table: **0 / 0 / 0**, and lanes **0 / 0** |
| R-NEW-1 | P3 | no | `tools/manifest-digests.py:274` | `--write` exits **0** when `SIGNED REVIEWER ROW REMOVED` fires, because it is in `stale` but not in `refused`. `--check` exits 1, and that is what the gate runs | row 4w → **0**; row 4 `--check` → **1** |
| R-NEW-2 | P3 | no | `tools/manifest-digests.py:262-266` | A wrong cause, sixth instance of the class. `signed_history` holds **every** signed row, so deleting an *amendment* row prints "SIGNED **REVIEWER** ROW REMOVED … A received **review** is not deleted". The refusal is right (fail-closed), but the cause it names is wrong. It also means no pack document can ever be retired without rewriting history, which is not stated | row 4b → **1** |
| R-NEW-3 | P3 | no | `tools/manifest-digests.py:221-226` | After a forgery is committed and then **reverted**, the pack is red permanently (`REWRITTEN IN HISTORY`). The refusal's remedy, "Restore the row to the digest the report arrived with", has already been done, so the remedy it names is unreachable. Only a history rewrite clears it, and `P14-HANDOFF-MANIFEST.md:31` forbids that. Fail-closed | row 2b → **1** |
| R-NEW-4 | P3 | no | `tools/gate-sweep.sh:26` and `:185` | R-11 is closed only in part. The pack files are restored, and the plant measured that (`git status --porcelain` → 0 lines after every interrupted run). But **(i)** the `trap` is installed at `:185`, after the worktree is created at `:26`, so an interrupt in the first ≈9 s **leaked a git worktree every time**: the count grew 2→7 over six interrupted runs. **(ii)** `cleanup` returns 0, so `INT`/`TERM` do **not stop** the sweep. It continues and prints a verdict: `kill -TERM` at 11 s and at 13 s → sweep rc **0**, "0 not as required". An `INT` at 12 s gave 1 proof not as required. Every observed outcome was fail-closed or a true pass. I cleaned up the leaked worktrees in my clone | `timeout -s {TERM,INT} {3,6,9,12} bash tools/gate-sweep.sh --no-db` → 124 each; `kill -TERM` → **0**, **0** |
| R-NEW-5 | P3 | no | `P14-MIGRATION-PATCH-REQUEST.md:1478` (generated) | The "documents that live OUTSIDE this pack" bucket now holds `P14-AMENDMENT-11-CHALLENGE-ROUND-7.md`, a misname that exists nowhere. It is quoted at `P14-AMENDMENT-15-…:127`. This is the P2-02 species with low impact: a generated bucket describes a token wrongly | `git grep -n 'P14-AMENDMENT-11-CHALLENGE-ROUND-7\.md' a725342` |
| R-NEW-6 | P3 | no | `P14-AMENDMENT-15-…:84-86`; `P14-TASK-DAG.md:194`; `P14-HANDOFF-MANIFEST.md:90`; `README-AR.md:163` | Typed counts again, off the first pages. **(i)** Amendment §2 says "Measured after the fix … in-pack **84 files / 89 tokens** … other documents **1** … **110** unresolved tokens", but the committed generated block in the same commit says **86/93**, **2**, **115**. The amendment's own new citations moved them. **(ii)** "**ten** of the eleven residuals closed", in three documents, while Amendment §4 marks all **eleven** `CLOSED`. The one closed *without* a measurement (apparently R-07) is not named. The PROPOSES 9 is right | `citation-provenance.py --markdown` → 0 (86/93, 2, 115) |
| Gap | — | no | `tools/gate-sweep.sh` | There is no red proof for Blocker 2's species: a cited file under a new pack directory being classified as PROPOSES | reading |

**Residuals from c812aa5, re-measured (cwd `/tmp`):**

| ID | State | Evidence → rc |
|---|---|---|
| R-01 | **CLOSED** | planted retracted sentence, pack at `…/rc/plain/phase14` → **1**, at `…/rc/tools/phase14` → **1**, "25 pack document(s)" each; a pack with no documents → **2** |
| R-02 | **CLOSED** for `--check`. `--write` exits 0 (R-NEW-1), and the P2-01-bis route bypasses it | row 4 → **1** |
| R-03 | **CLOSED** | row 3 → **1**; sweep `coord-review-protected` ok |
| R-04 | **CLOSED** | `env PATH=/nonexistent bash proofs/redproof-preflight.sh` → **5** (names `flock`); `/tmp/p14pg` made a regular file → **5**, quoting `mkdir: cannot create directory '/tmp/p14pg': File exists`. I removed the file afterwards |
| R-05 | Code read only; needs the cluster | `gate-sweep.sh:413-439` require rc 1 and the arm's sentence |
| R-06 | **NOT VERIFIED**; needs the cluster | `c1a_restrict_column_refused.sql:40` `IF st = 'P0001' THEN RAISE; END IF;` (read) |
| R-07 | Code read | `gate-sweep.sh:454-457` has a fallback and `<no output at all>`, and the stray `''` is gone at `:58` |
| R-08 | **CLOSED** for shallow clones | rows 5 → **1** with an empty witness; rows 5w → **0** with `NOT CHECKED` declared. But see P2-01-bis for the unreadable-revision half |
| R-09 | **CLOSED** | `bash proofs/redproof-preflight.sh nosucharm` → **2** |
| R-10 | **CLOSED** | the allow-list is corrected; a pack holding only reviewer reports → **2** (ghost allow-list names) |
| R-11 | **PARTIAL** | R-NEW-4 |

## 5. Gate sweep (`--no-db`), the exact runs

All runs used the pack at `/tmp/claude-0/p14-coord-a725342/phase-preparation/phase14` at `a725342`. The shared folder held 40 files, all byte-identical to the commit, while these ran.

| cwd | command | rc | `ok` lines |
|---|---|---|---|
| `<pack>` | `bash tools/gate-sweep.sh --no-db` | **0** | 26, "0 gate(s)/proof(s) not as required" |
| `/tmp` | `bash <pack>/tools/gate-sweep.sh --no-db` | **0** | 26 |
| `/` | `bash <pack>/tools/gate-sweep.sh --no-db` | **0** | 26 |
| (one further uninterrupted run, `time`d) | same | ran 18 s | — |

**What each run covered:**

- **Every gate from four directories.** Each one gives identical codes from `<pack>`, the repository root, `/tmp` and `/tmp/tmp.*/wt`.
- **The pack-under-`/tmp` lane.** Three gates, each **0**.
- **19 red proofs**, all at their required codes. They include the five new ones: `reviewer-row-committed-forgery`, `reviewer-row-forged-both-dirs`, `reviewer-row-deleted`, `coord-review-protected` and `history-truncated-not-checked`.

**How this compares with the author's run.**

- The author's 33 `ok` lines equal my 26 plus the two database gates plus five database proofs. Those seven are **not reproduced** here: there is no cluster at `/tmp/p14pg`, and I ran no `locale-gen`.
- So the author's claims of **46 replay cases rc 0** and **five arms rc 0** are **NOT VERIFIED** by me.
- The sweep was run from three cwds, and its worktree lane is itself a copy under `/tmp`.

**Note for the author.** This file and `P14-CHALLENGE-a725342.md` (which appeared during this review) are now in the shared folder. Each one turns `manifest-shared` red (`ARTIFACT WITH NO ROW`) until it has a row. That is the gate working.

## 6. Not verified

- **The database lane:**
  - `replay.sh` (46 cases);
  - `redproof-preflight.sh` (5 arms);
  - `no-cluster`, `rolecount-discriminates`, `no-cluster-revert`, `concurrent-run-refused` and `version-arm-fires`;
  - the R-06 handler on the cluster.
- **Node:** v22.22.0 is below the repository's `engines >= 24`, and no Node command was run.
- **Beyond the brief:** the design, the Arabic prose beyond the changed paragraphs and status lines, GitHub PR and CI state, and Phases 4 and 13.

## 7. Scratch

- **Where.** Everything is under `/tmp/claude-0/`:
  - the clone, `p14-coord-a725342`;
  - the plants, worlds and old and mutant tools, under `p14-plants`;
  - the sweep logs, under `p14-logs`.
- **The clone was only fetched.** Every sweep restored the pack (`git status --porcelain` → 0 lines). I removed the worktrees leaked by the interrupted runs (R-NEW-4) and pruned them.
- **`/tmp/p14pg`.** It was created by the `nosucharm` run and as the R-04 plant, and removed after each; it does not exist now.
- **The shared folder.** Nothing was written to `/mnt/project-files` except this file.

*This review signs nothing on the author's behalf and does not promote the phase. `PREPARED` / `CHALLENGED` / `NOT PROMOTED`; `READY_TO_PROMOTE` = NO.*
