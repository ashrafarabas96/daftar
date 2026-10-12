# P14 — COORDINATOR ACTUAL-DIFF REVIEW AT `583a4a0`

| | |
|---|---|
| Head reviewed | `583a4a00c09788b79b3306d8647958d6b08145a2` on `claude/project-thread-1zqgj8` (`git ls-remote` confirms that the remote head is this SHA) |
| Range | whole Phase 14 delta `6fc505d..583a4a0` (merge-base with `origin/main` = `origin/main` = `6fc505d`, 8 commits, 75 files, +9,702/−0), plus the unsigned latest round `2430504..583a4a0` (13 files, +621/−46) |
| Date | 2026-10-12 |
| Reviewer | coordinator worker. This is the third link (AUTHOR → INDEPENDENT CHALLENGER → COORDINATOR). This reviewer wrote no part of the pack |
| Method | **static only.** I ran no database, no `replay.sh`, no SQL case and no `locale-gen`. The only things executed were the two pure Python tools, in a scratch copy (see §6) |
| Inputs read first | `P14-CHALLENGE-{2026-10-12,08d23da,6f744c1,fcb85f8,23b24ca,2430504}.md`, `P14-CHALLENGE-2430504-ADDENDUM-01.md` |

## 1. Verdict — **COORDINATOR-ACCEPT-WITH-SCOPE-AND-RESIDUALS**

**Scope of the acceptance.** `583a4a0` is accepted as a DOCS-ONLY preparation pack in the state
`PREPARED / CHALLENGED / NOT PROMOTED`, with `READY_TO_PROMOTE = NO`. The acceptance is not a
signature on the design and is not a promotion. `583a4a0` itself has no challenger signature, so a
round-7 challenge is still owed.

**Why accept.** Scope and authority are clean: every one of the 75 changed files is under
`phase-preparation/phase14/`. No migration number is assigned, no shared root file is touched, and
every grant, role and policy is a scratch object (`p14s.*`, `p14_*`, `p14scratch`). Six of the nine
round-6 claims check out against the diff and the files: (a), (c), (e), (f), (h) and (i). Both
generators go red when I corrupt what they measure. I found no P0 or P1.

**Why not a plain accept.** Two claims are only partly true: (b), the locale revert, and (g), the
bucket fix. One more, (d), holds but leaves typed counts behind. Three status documents still carry
false identity or review-state lines that have survived since `08d23da`. One proof script fails
open. All of these are P2 or lower, and none changes the phase's status. They are residuals to close
in the next author round, not reasons to reject this one.

## 2. Per-claim table (author's claims for `583a4a0`)

| # | Claim | Result | Evidence |
|---|---|---|---|
| a | §15 has the freeze-boundary table: `frozenThrough` is `0079` at `93084f8` and `0073` at `6fc505d` | **VERIFIED** (but see P3-11) | `git show 93084f8:infrastructure/database/MIGRATION_MANIFEST.json` → line 3 `"frozenThrough": "0079_phase4_pos_till_sessions_cart.sql"`. `git show 6fc505d:…MIGRATION_MANIFEST.json` → line 3 `"0073_default_warehouse_locale_name.sql"`. Table at `P14-MIGRATION-PATCH-REQUEST.md:1498-1516` |
| b | The withdrawn locale-gen finding is reverted, with a pointer to the addendum | **PARTIAL** → P2-01 | `proofs/README.md:18-19,32-51` is correct and points to `P14-CHALLENGE-2430504-ADDENDUM-01.md`. `P14-EVIDENCE-2026-10-12.md:47` still contains the retracted PATH inference and has no pointer to the addendum |
| c | The generator's extension set now includes `json`, and the block prints the population it scanned | **VERIFIED** (see P3-12) | `tools/citation-provenance.py:33-34` (EXTS includes `json`, `sh`, `py`) and `:135-138`. `P14-MIGRATION-PATCH-REQUEST.md:1440` (`MIGRATION_MANIFEST.json` **DIFFERS** +27/−3) and `:1466` |
| d | Four documents no longer carry typed counts and point to the generated block | **VERIFIED, WITH RESIDUALS** → P3-13 | `P14-AMENDMENT-05-MISSION-V3.md:123`, `P14-TASK-DAG.md:190`, `P14-HANDOFF-MANIFEST.md:32` and `:76`. `P14-AMENDMENT-09-CHALLENGE-ROUNDS-4-5.md:126` keeps 35/5/21/9 but labels it as a historical record (`:127-130`). Leftover typed figures: `P14-EVIDENCE-2026-10-12.md:45` and `P14-AMENDMENT-03-CONTINUOUS-MISSION.md:160` ("205 lines"), and `README-AR.md:51` ("45 runs") |
| e | The GATE-034 prose no longer credits a gate with an assertion that no gate makes | **VERIFIED** (see P3-08) | `git grep GATE-034` in non-challenge files matches only its real definition (`P14-AMENDMENT-05:125`, `P14-TASK-DAG:192`), the record in `P14-AMENDMENT-10:69-70` and a code comment (`citation-provenance.py:200-201`). The generated line `P14-MIGRATION-PATCH-REQUEST.md:1475` reads "No gate in this pack asserts their absence" |
| f | c1a runs its control BEFORE printing LAW HELD and asserts the SQLSTATE | **VERIFIED, WITH A NOTE** → P3-06 | `proofs/cases/c1a_restrict_column_refused.sql:16-25` (control first, raises `CONTROL FAILED`), then `:28-38` (law). The SQLSTATE comparison at `:34` cannot be reached with any value other than 42501. I did not reproduce the dirty-state exit 3 |
| g | Bucket classification resolves tokens instead of matching names, and a deleted script is its own category | **PARTIAL** → P2-02 | `citation-provenance.py:159-175` resolves tokens. But `P14-MIGRATION-PATCH-REQUEST.md:1474` still lists the deleted orphan (bare basename) under PROPOSES, while `:1473` lists it under DELETED |
| h | The replay filter's substring behaviour is documented, and a no-match exits 2 | **VERIFIED** (typo: P3-15) | `proofs/replay.sh:11-19` and `proofs/README.md:25-27` document the substring. `replay.sh:55-58` exits 2 before any database action. "33 cases" for `nope` matches `ORDER` lines 6–38 (33 case lines) |
| i | The manifest has 25 artifacts, and the round-6 report and addendum are committed unedited | **VERIFIED** | `manifest-digests.py --check` → exit 0 (default dir `/mnt/project-files/phase14`) and `--dir . --check` → exit 0 on the scratch copy of `583a4a0`, both reporting "25 artifact row(s)". The sha256 of `P14-CHALLENGE-2430504.md` is `eb7a0bd031fbc643c9eae92df554cc23075c53be4cc56aa54aefe6781b087fd1` and of the addendum is `2b92623339435550e21a33e1955a6c7c153dbc9b3ee61e2859a0932103f08101`, identical in `/mnt` and in `git show 583a4a0:…`. All 26 files in `/mnt/project-files/phase14/` are byte-identical (`cmp`) to the branch copies |

## 3. Scope and authority

| Check | Result | Evidence |
|---|---|---|
| Changed files by top-level path | **all 75 under `phase-preparation/phase14/`**: 26 top-level `.md`/`.yaml`, `proofs/` (ORDER, README.md, bootstrap/fixture/preflight `.sql`, 3 `.sh`, `evidence.psv`, 38 `cases/*.sql`), `tools/` (2 `.py`). All 75 are status `A`. Nothing is modified outside the pack | `git diff --name-status 6fc505d 583a4a0` |
| `infrastructure/database/migrations` | **untouched** | same |
| Migration number assigned | **none.** Every `NNNN_*.sql` token in the pack names an existing file between `0002` and `0086`. No token `0087` or above appears (the only numeric hits are the SSRF literals `0177.0.0.1`) | `git grep -o -E '\b[0-9]{4}_[a-z0-9_]+\.sql'` and `git grep -E '\b0(08[7-9]|09[0-9]|1[0-9]{2})'` |
| Shared root files (`package.json`, `tsconfig*`, `ci.yml`, workspaces) | **untouched** | name-status list above |
| Grants, roles and policies applied | **scratch only.** Every `CREATE/ALTER/DROP` in `proofs/` targets `p14s.*`, `p14_*` roles, `p14scratch`, or the throwaway databases `p14wrongcoll`/`p14wrongenc`. Grants in `cases/*.sql` are on `p14s.api_keys`/`p14s.outbox_events` only | `git grep -o -i -E '(CREATE|ALTER|DROP) …'` in `proofs/` |
| Status | `PREPARED`/`NOT PROMOTED` and `READY_TO_PROMOTE = NO` everywhere. No author document claims a signature | `git grep READY_TO_PROMOTE`, `git grep PROMOTED` |

## 4. Findings

### P0 / P1 — none.

### P2-01 — The locale-gen revert is only half done, and the evidence document still asserts the retracted inference
`P14-EVIDENCE-2026-10-12.md:47` was edited in `583a4a0`. It still says `locale-gen` is "at
`/usr/sbin/locale-gen` and therefore **not on a non-root `PATH`**". That is the exact inference
`proofs/README.md:37-38,42-51` and `P14-AMENDMENT-10:120-127` call wrong. The row cites the withdrawn
`CHALLENGE R5 P3-04` as its authority and gives no pointer to the addendum. It also adds a new claim
that nobody measured: "which an unprivileged replayer can actually run". The addendum ran
`locale-gen` as root (it began with `localedef --delete-from-archive`). The harness itself needs root
in any case (`replay.sh:61-67`, `run.sh:21` use `su claude`). `P14-HANDOFF-MANIFEST.md:78` says "the
two documents changed on its word are reverted"; only one of them is reverted cleanly.

### P2-02 — Round-6 P3-04 is not closed: the deleted orphan is still in the PROPOSES bucket, and the in-pack bucket double-counts
The committed generated block lists the deleted script twice. `P14-MIGRATION-PATCH-REQUEST.md:1473`
puts `cases/c7a_cross_business_accepted.sql` under DELETED. `:1474` lists the bare
`c7a_cross_business_accepted.sql` (cited at `P14-HANDOFF-MANIFEST.md:76`) among the 10 files "this
phase PROPOSES". The `--check` gate passes on this block (exit 0), so the generator really does
produce it.

- **Cause** (`tools/citation-provenance.py:175-181`): `deleted` is folded at `:178`, which removes the
  basename because `cases/…` ends with it. `future` is then built as "not in `deleted`", so the
  folded-out basename falls into PROPOSES. The deleted category handles one spelling only.
- **Same species, in the other buckets:**
  - The in-pack line says "47 resolve to real files INSIDE this pack" (`:1471`), but it counts
    tokens, not files. It includes both `replay.sh` and `proofs/replay.sh`, both
    `redproof-preflight.sh` and `proofs/redproof-preflight.sh`, and two spellings of the skeleton
    yaml. One of those spellings is the absolute `/mnt/project-files/phase14/P14-OPENAPI-SKELETON.yaml`,
    which is resolved against the host filesystem and not against the pack (`:159-161`).
  - The `packown` bucket (`:179`) is still a name pattern (`.yaml` and `'P14-' in x`), and it overlaps
    the in-pack bucket. The listed buckets add up to 60 (47 + 2 + 1 + 10) against 59 unresolved tokens.

I listed the buckets with an instrumented copy of the generator in scratch. The headline (37 / 6 / 22 / 9) is not affected.

### P2-03 — The handoff manifest's identity and review-state rows are false, and have been since `08d23da`
`P14-HANDOFF-MANIFEST.md` has been regenerated in all eight commits, but these lines were never updated:

- `:29` names the prep branch as `claude/phase14-prep-1zqgj8`, "cut from the base above". That branch
  does not exist on the remote (`git ls-remote origin 'refs/heads/claude/*1zqgj8*'` returns only
  `project-thread-1zqgj8`). The pack lives on `claude/project-thread-1zqgj8`, which was cut from
  `6fc505d`, as `P14-MIGRATION-PATCH-REQUEST.md:1520-1528` itself says.
- `:30` says "Commits on it: **none**", and `:31` says "no commit, no push". There are 8 commits, and
  they are pushed.
- `:40` says "All are **uncommitted / off-Git**". All 25 are committed.
- `:180` says "Independent Challenger | **NOT DISPATCHED**". Six rounds have run, and all six reports
  are rows in the same table.
- `:245-246` says "Manifest regenerated 2026-10-12 after Amendment 03".

No author-written document in the pack names the branch the pack is actually on; only the challenger
reports do. The same "Branch `claude/phase14-prep-1zqgj8`, no commits" header appears in
`P14-AMENDMENT-03:4`, `-04:4` and `-05:4`. Those headers are historical but carry no annotation.

### P2-04 — The Arabic index the owner reads stops at round 1, and says nothing was pushed
`README-AR.md` has not been touched since `08d23da`.

- `:5-6` says no code was written and "nothing was pushed to any branch" (لم يُدفع شيء إلى أي فرع).
  This is false: the pack is pushed, and it contains executable shell, Python and SQL harness code.
- `:51` says "45 runs"; the evidence document and the manifest say 43.
- `:22` describes the manifest as having "seven classified blockers"; `P14-HANDOFF-MANIFEST.md:189-201` lists 11.
- The file table (`:10-23`) and "what's new" (`:49-67`) end at the round-1 REJECT. Amendments 06–10,
  the evidence document, challenge rounds 2–6, `proofs/` and `tools/` are not mentioned.

The final status line `:69` is correct. It claims less than is true rather than more, but it is the
owner's entry point.

### P2-05 — `redproof-preflight.sh` can exit 0 without any arm turning red for the right reason
`proofs/redproof-preflight.sh:28-36`:

- The setup statement's exit status is discarded (`>/dev/null`, no check).
- Any non-zero preflight exit counts as `ok`, including psql's exit 2 for a connection or
  missing-database failure.
- The `CLAIM FALSE` line it prints is never required.

So if the cluster is down, or a setup `CREATE DATABASE`/`ALTER ROLE` fails, every arm prints `ok` and
the script ends with "5 arm(s), 0 not red", exit 0. This contradicts its own header (`:13-14`:
"REQUIRES exit 1 (or 3…)") and the pack's law that a red proof must not pass for the wrong reason.
This finding comes from reading the code; I did not execute it. It does not touch `583a4a0`'s
delta, but it is in the branch range.

### P3-06 — c1a's SQLSTATE assertion cannot fail
`c1a_restrict_column_refused.sql:32-36`: the handler is `EXCEPTION WHEN insufficient_privilege`, which
catches only SQLSTATE 42501, so `IF st <> '42501'` can never fire. `P14-AMENDMENT-10:88-90` says that
"a refusal with another code is `LAW UNPROVED`". In fact another code is not caught at all and aborts
under its own message, with exit 3. The outcome is correct; the description of the mechanism is not.
The control-first fix itself is sound.

### P3-07 — Red proofs are judged by exit code 3 alone
`replay.sh:79-82` and `proofs/README.md:9-13`: under `ON_ERROR_STOP` any SQL error exits 3, so a
red-proof arm can turn red for an unrelated reason. The driver never checks for the expected SQLSTATE
or message. The proof-of-proof blocks in the mutation scripts reduce the risk but do not remove it.
This is round-6 P3-03's species at the driver level.

### P3-08 — The new generated prose credits `--check` with a detection it cannot make
`P14-MIGRATION-PATCH-REQUEST.md:1475` (from `citation-provenance.py:206-210`) says that "an entry here
that later RESOLVES means … the phase has been built …, and `--check` turns that into drift". But
resolution is against the pinned, immutable `--base 93084f8` (`:56`). Building the phase can never
make a proposed file resolve at `93084f8`, so with the gate's defaults this detection can never fire.

### P3-09 — The provenance gate's answer depends on the host, not only on the trees and the pack
- `--repo` defaults to the git top level of the current directory (`citation-provenance.py:53-55`).
  Run from a directory outside any repo, `--check` on a current block exits **1**; I measured this.
- `was_in_pack` (`:167-174`) relies on `os.path.relpath(pack, repo)` and `git log --all`. With the pack
  outside the repo (a `git archive` export), the deleted bucket silently comes back empty and the orphan
  moves to PROPOSES, so `--check` exits **1**; I measured this too. After a squash merge, `git log --all`
  could stop seeing the deleted file.
- `in_pack` resolves an absolute `/mnt/…` token against the host filesystem (`:159-161`).
- `manifest-digests.py:26` defaults `--dir` to `/mnt/project-files/phase14`, so a bare `--check` checks
  the shared folder, not the tree.

Every one of these failed closed (red) in my runs. But `P14-GATE-032` would go red on a host without
`/mnt`, or from the wrong working directory.

### P3-10 — Amendment 09 still carries the sentence round 6 corrected
`P14-AMENDMENT-09-CHALLENGE-ROUNDS-4-5.md:174-178` still says "a reader on `6fc505d` **cannot verify
the freeze boundary at all** … and §15 now says so". The challenger located this sentence in both §15
and Amendment 09. It was corrected in §15 only. Amendment 09 was edited in the same commit (the
annotation at `:127-130`), but this sentence got no pointer to Amendment 10.

### P3-11 — At the declared base, the manifest file disagrees with itself, and the pack does not say so
At `93084f8`, `MIGRATION_MANIFEST.json:3` has `frozenThrough = 0079`, but the `policy` text on `:4`
says "Migrations 0000–0078 are FROZEN … appended after 0078". The §15 table
(`P14-MIGRATION-PATCH-REQUEST.md:1504-1507`) says the file "was read at both [trees]", but it reports
only the field. Fixing this is not Phase 14's job; disclosing it is.

### P3-12 — The scanned population still excludes `.md`, and does not say which documents are scanned
The pack cites `docs/DAFTAR_DATA_MODEL.md:433-435`, `docs/DAFTAR_SECURITY_MODEL.md:41` and
`docs/DAFTAR_THREAT_MODEL.md:14`. All three are identical at both trees (I measured this), so no row is
lost today. The printed population line (`:1466`) does not say that only top-level pack `.md`/`.yaml`
files are scanned. `proofs/README.md` and the case headers are not scanned. This is round-6 P2-01's
species, currently harmless.

### P3-13 — Typed copies of generated figures remain
`P14-EVIDENCE-2026-10-12.md:45` and `P14-AMENDMENT-03-CONTINUOUS-MISSION.md:160` say "database.ts
differs by 205 lines", which is the generated +190/−15 typed out by hand. `README-AR.md:51` says
"45 runs". `P14-AMENDMENT-09:126` keeps 35/5/21/9 but labels it as historical, which is acceptable.

### P3-14 — Design honesty: Amendment 08 still presents clean rounds as validating the design
`P14-AMENDMENT-08-CHALLENGE-ROUND-3.md:5-8` and `:108-113` say that "no finding … has landed against
the architecture" and that "All 39 laws … have been re-measured by an independent session and are
sound", calling this "the useful signal". The executed evidence covers 9 case families (C1–C9), not 39
laws. `P14-AMENDMENT-10:129-137` states the correct framing plainly ("the architecture is not
vindicated, it is unexecuted … no API, no DDL, no route and no CI"), and so does the manifest status
(`P14-HANDOFF-MANIFEST.md:25`, "DOCS ONLY · ALL GATES UNMEASURED"). But Amendment 08 is not annotated.

### P3-15 — The replay.sh comment misspells the file in its own example
`proofs/replay.sh:17` writes `c7c_assertio[nope]rable.sql`. The file is `c7c_assertion_inoperable.sql`,
and the match is `i[nope]rable`. The count (33) is right.

### P3-16 — (challenger record, not the author) The addendum's "P3-04" collides with round 6's P3-04
`P14-CHALLENGE-2430504-ADDENDUM-01.md:8` is headed "`P3-04` IS WITHDRAWN", and `:56` says "the
required-for-PASS list loses item 4". In the round-6 report, P3-04 and item 4 (`:185`, `:218`) are the
bucket misclassification, not locale-gen (which was R5 P3-04). The author read it as R5
(`P14-AMENDMENT-10` table, `P14-HANDOFF-MANIFEST.md:78`), which is the sensible reading, and worked
on R6 P3-04 anyway. But as written, the addendum can be read as withdrawing R6 P3-04, which P2-02
shows is still open. The round-7 challenger should state which one it meant.

## 5. Status and design honesty

- **Status:** the pack is `PREPARED / NOT PROMOTED`, `READY_TO_PROMOTE = NO` and unsigned by the
  author (`P14-AMENDMENT-10:3`; no self-signature anywhere). No document claims more than the code and
  tests show **about the phase**. The stale lines (P2-03, P2-04) understate or misstate the repository
  state rather than overclaiming quality.
- **Design honesty:** the "unexecuted, not vindicated" framing is now in the pack
  (`P14-AMENDMENT-10:129-137`). The phase has no API, DDL, route or CI, and every gate is `UNMEASURED`
  (`P14-HANDOFF-MANIFEST.md:25,108-112`). The one place that still presents clean rounds as validation
  is Amendment 08 (P3-14).

## 6. Commands run (exact) and exit codes

`$SP` = `/tmp/claude-0/-home-user/5043869c-4f0c-5535-aa30-efb4cbbf59d5/scratchpad`, `$R` = `/home/user/ashrafarabas96/daftar`.

| # | Command | Exit / result |
|---|---|---|
| 1 | `git -C $R fetch origin claude/project-thread-1zqgj8` | 0 (08d23da..583a4a0) |
| 2 | `git -C $R fetch origin main` | 0 |
| 3 | `git -C $R ls-remote origin claude/project-thread-1zqgj8` | 0 → `583a4a00c09788b79b3306d8647958d6b08145a2` |
| 4 | `git merge-base origin/main 583a4a0` | `6fc505d…` (= `origin/main`) |
| 5 | `git merge-base --is-ancestor 93084f8 583a4a0` / `… 6fc505d 93084f8` | 1 / 0 |
| 6 | `git show {93084f8,6fc505d}:infrastructure/database/MIGRATION_MANIFEST.json` | 0 / 0 |
| 7 | `sha256sum` of the two round-6 files in `/mnt` and of `git show 583a4a0:…`; `cmp` of all 26 `/mnt` files against the scratch copy | identical, 0 differences |
| 8 | `git archive 583a4a0 phase-preparation/phase14 \| tar -x -C $SP/p14export` | 0 |
| 9 | `python3 -I $SP/p14export/…/tools/citation-provenance.py --pack <export> --repo $R --check <export>/P14-MIGRATION-PATCH-REQUEST.md` | **1** (STALE: export is outside the repo; see P3-09) |
| 10 | `git clone -q --no-hardlinks $R $SP/clone && git -C $SP/clone checkout -q 583a4a0` (scratch clone; the original clone was not checked out or modified) | 0, 0 |
| 11 | from `$SP`: `python3 -I $SP/clone/phase-preparation/phase14/tools/citation-provenance.py --check …/P14-MIGRATION-PATCH-REQUEST.md` | **1** (STALE; cwd outside the repo) |
| 12 | from the pack dir: `python3 -I tools/citation-provenance.py --check P14-MIGRATION-PATCH-REQUEST.md` | **0** |
| 13 | from the clone root: `python3 -I phase-preparation/phase14/tools/citation-provenance.py --check phase-preparation/phase14/P14-MIGRATION-PATCH-REQUEST.md` | **0** |
| 14 | from the pack dir: `python3 -I tools/citation-provenance.py` (summary) | 0 → `resolved=37 differ=6 identical=22 absent=9 ambiguous=0 unresolved=59` |
| 15 | from the pack dir: `python3 -I tools/manifest-digests.py --check` (default `--dir /mnt/project-files/phase14`) | **0**, 25 rows |
| 16 | from the pack dir: `python3 -I tools/manifest-digests.py --dir . --check` | **0**, 25 rows |
| 17 | mutation on the scratch copy: headline `6 DIFFER`→`5 DIFFER`, then `--check`; restored, `--check` again | **1**, then **0** |
| 18 | mutation on the scratch copy: append a line to `P14-AMENDMENT-10…md`, then `manifest-digests.py --dir . --check`; restored, again | **1**, then **0** |
| 19 | an instrumented copy of the generator in `$SP/tools-instr/` (adds a stderr print of the in-pack and packown buckets) | bucket listing used in P2-02; not an exit-code claim |

Deviation from the suggested method: the provenance generator cannot run correctly from a
`git archive` export (row 9), so I also used a scratch local clone (row 10). This is not a `git
worktree` of the reviewed clone, and the reviewed clone was only fetched. All scratch material was
deleted after the run.

## 7. What this review does NOT cover

- **Nothing was executed against a database.** I did not run `replay.sh`, `run.sh`,
  `redproof-preflight.sh`, `preflight.sql` or any case. The 43/43 result, the `c7` 36/36 result, the
  `nosuchfamily` exit 2, and c1a's dirty-state exit 3 are the author's and challenger's figures, not mine.
- `locale-gen`/`localedef` behaviour and PATH, in any container.
- The soundness of the design: the 39 laws, the grants matrix, RLS/RESTRICTIVE policies, the SSRF
  law, the webhook and signature design, the OpenAPI skeleton's content, and the open rulings
  `TL-P14-SEC-01/-02/-03`, `§11a` and `OD-P14-09/-10/-11`.
- Whether the round-1 to round-5 findings were closed, beyond what bears on `583a4a0`'s claims.
- Whether `93084f8` is still the head of the Phase 4 branch, the state of Phase 13, and PR or CI state on GitHub.
- The Arabic documents beyond status lines, counts and dates.

*This review signs nothing on the author's behalf and does not promote the phase. `PREPARED` /
`CHALLENGED` / `NOT PROMOTED`, `READY_TO_PROMOTE` = NO.*
