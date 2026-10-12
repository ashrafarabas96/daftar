# P11 — HANDOFF MANIFEST

**Required gate.** PART 13 of the 2026-10-12 per-phase directive makes a `P<N>-HANDOFF-MANIFEST.md` mandatory for every Phase 5–15 preparation; a missing artifact is **`HANDOFF INCOMPLETE`**, which the directive is explicit is *not* automatically product failure. The purpose is that the next reader — a successor agent, a challenger, the coordinator, or the Migration Owner at promotion — can tell what exists, where, and whether it is in Git, **without re-deriving any of it**. The directive's own instruction is to search before recreating: the current branch, the worktree, the previous report bundle, the shared project-files location, and the local commit history, in that order.

---

## 1. Identity

| field | value |
|---|---|
| **phase** | 11 — Apparel · Electronics · Repair · Lot/Expiry vertical packs (Master Part 31) |
| **status** | **`PREPARED / NOT PROMOTED`**, on the ladder (`PREPARED → CHALLENGED → READY_TO_PROMOTE → PROMOTION_IN_PROGRESS → ACCEPTED / SEALED`) at **`CHALLENGED`** for Pack A and **`PREPARED`** for everything else. **`READY_TO_PROMOTE` = NO.** **Pack B (lot/expiry) has now been CHALLENGED too, and the verdict was `REJECT`** at `b43871b`: the challenger reproduced every count and exit code and then defeated `C-LOT-03` from the side that moves the key, and found the deferred check failing open under row-level security, a definer fold executable by PUBLIC, and a fold answering a silent `0` where it refuses on the business. All four are answered at **`b7ee445`** — 47 Pack B cases, each fix red when its guard is removed, each mutation on its own full rebuild — and Pack B returns to the challenger **unsigned**. **Its concurrency is `UNMEASURED` and is not claimed** (`P11-LIVE-DDL-PROOF.md` §10). An independent challenger read Pack A at `1a8ba15` and **rejected it** on five defects of the removal direction; all five were fixed and red-proved at `2da2000`. Its **second round at `23a7139` returned `PASS-WITH-SCOPE`**: the five closed and each covered by a case that fails when its guard is dropped, the off-target refusal measured at exit `3`, and its own `SECURITY DEFINER` recommendation **withdrawn on measurement** — with **three new findings**, one of them the ADD direction of the same clause (one `INSERT` into `product_matrix_axes` under a populated matrix). All three are answered at **`0db9450`**: 46 Pack A cases and 31 Pack B cases, **each run twice on the same database**, 9 races, every exit code `0`, on `en_US.utf8` — see `P11-LIVE-DDL-PROOF.md` §9. The pack is back with the challenger **unsigned**; a third round is owed. **Pack A (apparel) now has an executed scratch proof, serial and concurrent** (see §3); everything else in the phase is `DESIGN / SPEC ONLY`. One subfeature is separately `BLOCKED` (repair-part accounting, PART 68) and two are `WAITING_FOR_INTEGRATED_SURFACE` (the preconsumed billing binding and the repair deposit, both on unsealed Phase 4 surfaces). **THIRD ROUND (2026-10-12): Pack A `REJECT` at `0db9450`, Pack B `PASS-WITH-SCOPE` at `b7ee445`.** Pack A fell for the third time on one clause of `C-APP-01`, through a third door — a non-base variant with `attributes = '{}'` accepted on a populated matrix, taking its own stock key — and on a second finding that is its twin: the recovery path the freeze guard's own message offers was inoperable, because the guard counted archived variants as part of the grid. Both are answered at **`22e8e2d`**, with the clause now derived from the forbidden STATE and every statement that can reach it enumerated with its named refusal; plus the two `P3`s of the end-state assertion (an unqualified catalogue lookup, closed as a class; and the tautology list, which the challenge got `2 > 1` and `business_id IS NOT NULL` through, now a three-form function the proof calls directly). Pack B's one new finding is answered as the scope sentence and the case it asked for — a direct write to the stock key fires neither trigger, and no trigger is added to a frozen relation — its lot-code case now moves both columns so a CHECK no longer masks the guard, and **one defect found here, not reported: the cache-side conservation trigger had the same fail-open arm as its twin.** **Pack B's concurrency is no longer `UNMEASURED` for the writers that exist**: four races, both arrival orders, 0 findings, carried into this pack's own harness. **58 Pack A cases and 53 Pack B cases, each run twice on one database, 9 + 4 races, every exit code `0`.** Both packs are back with the challenger **unsigned, and a FOURTH round is owed.** PART 117 states the law this obeys: never call `PREPARED` complete, never call a local test CI, never call a spec a DB proof. |
| **base read** | `93084f8` on `phase/4-sales-pos-customers-receivables` (`fix(p4s1-gate): a delegator may not also compute`) |
| **own branch** | `claude/phase11-prep-re0epv`, cut from that head. Nothing has been pushed to `phase/4-sales-pos-customers-receivables` or to `main`, and no pull request exists. |
| **worktree** | the session's primary checkout at `/home/user/daftar`; no separate git worktree was created |
| **preparation SHA — the six documents of 2026-10-08** | `6958b886aba8fb918bf18e6e0eac451438910ec1` (parent `188dcb076c16035ab2db9a138b2b2c4dc84bcc2b`) |
| **preparation SHA — this revision (2026-10-12, the per-phase directive applied)** | the commit that adds this manifest and the seven revised documents under `prep/phase11/`. It is **`d45019fa231e8170dff9d5c17160ed752655ea34`**, the child of `6958b88` on this branch, recorded here by the commit that follows it — because a file cannot contain the hash of the commit that creates it, and inventing one would be exactly the kind of unverifiable number this project refuses. The push was a fast-forward `6958b88..d45019f`, **verified by `git ls-remote origin claude/phase11-prep-re0epv`**, not by the push log. |
| **preparation SHA — Pack B executed (2026-10-12)** | **`c2289ce7974a17d1e3509caf077e4fd5e8c26c26`**, the SHA the current authoritative run names as its own input (`SOURCE_TREE_DIRTY : no`, `RUN_ID p11-20261012T151906Z-10772`, all exit codes `0`). It carries the lot/expiry DDL (`PACK_B_DDL_SHA256 27bca629…f60a`), its 31-case suite and the official-command fixture. Its documentation is `c1eac207b443192dc711f528d18a7b467f518960`, recorded here by the commit that follows it. Fast-forward on this prep branch only, **verified by `git ls-remote`**. |
| **preparation SHA — the challenge round (2026-10-12, the independent challenge at `1a8ba15` answered)** | the five fixes are **`2da200009e119e36ebde2eabdab9a14299f0a1a1`**, and that is the SHA the current authoritative evidence run names as its own input (`SOURCE_TREE_DIRTY : no`, `EXIT_SCRIPT 0`). The run identity and the raw log are **`93dcd4d002298db189a4ba797797b6a1fa6ce70c`**, recorded here by the commit that follows it — a file cannot contain the hash of the commit that creates it. Fast-forward `1a8ba15..93dcd4d` on this prep branch only, **verified by `git ls-remote origin claude/phase11-prep-re0epv`**, not by the push log. |
| **preparation SHA — the concurrency revision (2026-10-12, V2 applied)** | the DDL and harness fixes for defects 7 and 8 are **`d813de2b76b8fdf4667686dd1f0de1a48436b222`**, and that is the SHA the authoritative evidence run names as its own input (`SOURCE_TREE_DIRTY : no`). The documentation of that round is **`466f44bd28a960187604e4609837f9f64c13335d`**, recorded here by the commit that follows it — as above, a file cannot contain the hash of the commit that creates it. Both pushes were fast-forwards on this prep branch only, **verified by `git ls-remote origin claude/phase11-prep-re0epv`**, not by the push log. |
| **preparation SHA — the second challenge round (2026-10-12, the re-challenge at `23a7139` answered)** | the three fixes, the two new races and the renderer are **`0db94504abdc6b9142564e655c8032613214c06d`**, and that is the SHA the current authoritative run names as its own input (`RUN_ID p11-20261012T155328Z-18615`, `SOURCE_TREE_DIRTY : no`, every exit code `0`, `PACK_A_DDL_SHA256 36913f0d…a8c7`, `HARNESS_SHA256 76425738…5639`). Its documentation and raw logs are recorded by the commit that follows it — a file cannot contain the hash of the commit that creates it. Fast-forward `b43871b..` on this prep branch only, **verified by `git ls-remote origin claude/phase11-prep-re0epv`**, not by the push log. |
| **preparation SHA — the first challenge of PACK B (2026-10-12, the REJECT at `b43871b` answered)** | the four fixes are **`b7ee445cbe9a3bfe811a60ce004235878cb9c291`**, and that is the SHA the current authoritative run names as its own input (`RUN_ID p11-20261012T162240Z-30238`, `SOURCE_TREE_DIRTY : no`, every exit code `0`, `PACK_B_DDL_SHA256 f9fe8ccc…db22`, `HARNESS_SHA256 932ea04e…3514`, Pack B's end-state assertion at **17 checks**). **46 Pack A cases and 47 Pack B cases, each suite run twice on the same database, 9 races.** Its documentation is recorded by the commit that follows it. Fast-forward on this prep branch only, **verified by `git ls-remote`**. See `P11-LIVE-DDL-PROOF.md` §10. |
| **preparation SHA — the third challenge round (2026-10-12: Pack A's `REJECT` at `0db9450` and Pack B's `PASS-WITH-SCOPE` at `b7ee445` answered)** | the code answers are **`da106b750b1899fed346365f36a4df41f946c0ce`** (the two DDL files, both suites, the third fixture product), **`8865015749…`** (`P11_MUTATION_SQL`, the mutation hook) and **`22e8e2dce8ee0456f103f82ec436bf6d4b11309e`** (`races_b.py` and its exit-code line), and the last is the SHA the current authoritative run names as its own input: `RUN_ID p11-20261012T173927Z-20219`, `SOURCE_TREE_DIRTY : no`, every exit code `0`, `PACK_A_DDL_SHA256 53e18ed6…bd96`, `PACK_B_DDL_SHA256 a94b2549…6092`, `HARNESS_SHA256 ebe99285…cf20`, Pack B's end-state assertion at **19 checks**. **58 Pack A cases and 53 Pack B cases, each suite run twice on the same database, 9 Pack A races and 4 Pack B races.** The five mutation runs are at `da106b7`, which is **byte-identical to the head in both DDL files, both proof suites and both worlds** (`git diff --stat da106b7 22e8e2d` over those paths is empty). Its documentation is recorded by the commit that follows it — a file cannot contain the hash of the commit that creates it. Fast-forward on this prep branch only, **verified by `git ls-remote`**. See `P11-LIVE-DDL-PROOF.md` §11. |
| **push authority** | `TL-MASS-PRESERVE-01` (§9 of the 2026-10-08 directive): a PREPARED / NOT PROMOTED prep thread may fast-forward push **its own isolated prep branch** for preservation — non-canonical, not `main`, not the Phase 4 branch, no PR, no force, no rewrite, not integration, exact SHA recorded. **Preservation, not promotion.** This branch never merges itself. |
| **migration numbers** | **none allocated, none reserved, none examined, none exampled, none in a filename and none in a comment.** Every number appearing in any Phase 11 document is a citation to a file already on disk. One Migration Owner, at promotion (PART 6). |
| **frozen prefix** | `0000`–`0079` are byte-immutable and **were not modified, not even temporarily, and not by any test** — no Phase 11 proof targets them (see `P11-AL-25` and §0a of the laws document). `0080`–`0086` are Phase 4's unfrozen S4 candidates and were likewise not touched. |
| **timing / performance** | **no number measured and none claimed anywhere.** This container is not the authoritative box and a figure from it would not be comparable. A budget *lane* is owed from the Performance Owner. |

---

## 2. Artifacts

Each document exists in **two places**: the shared project-files location (the canonical working copy) and `prep/phase11/` in Git on the prep branch. The SHA256 is of the shared copy as of this revision (2026-10-12, after the Pack A proof run, after V2's concurrency round, **and after V3 was applied** — exit codes, PG16 settled, and the §7 fact correction); the Git copies are byte-identical, which is what the commit proves.

| artifact | shared location | in Git | SHA256 (shared copy) |
|---|---|---|---|
| `P11-S0-VERTICAL-PACK-ARCHITECTURE.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `8be8503e62d4e280eb3918fb0d01ca20482135b0d7193eb0fd0ce46080230759` |
| `P11-MIGRATION-PATCH-REQUEST.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `b38f81c3d6ece206bd819b8f89bb2617c763fb7d66c307810edad88939976b36` |
| `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `157f818eea0ca456d80ad669ac857c97d53b65b2cdc4bfda068d5e96dbb7da20` |
| `P11-TASK-DAG.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `6923f0add88d2a0bc31b89fa1b91be8ce20a7540fa6f95e20bf42ae2dd791979` |
| `P11-OPEN-DECISIONS.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `983e026a9bc6c7fe3b65cfc22fb7672ee33d30cd042e6f31ee176a1bb23055f1` |
| `P11-S0-REPORT-AR.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `c35b6cd031596bdd94b64c9debf8e07fc3bf6153d632ec37d72de988ffbf94fb` |
| `P11-LIVE-DDL-PROOF.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `9f6bb9e868160e05353634bee4d4330093fde9178f6578a67b8e3a052b20bd16`|
| `prep/phase11/ddl/` + `prep/phase11/harness/` | — (Git only) | **committed** | the applied DDL and the harness; in Git rather than off-Git because they are executable, not prose |
| `P11-HANDOFF-MANIFEST.md` (this file) | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | self-referential; recompute with `sha256sum` |

**Nothing is uncommitted.** The working tree is clean at the preparation SHA, and the shared copies are the same bytes. Note that `/mnt/project-files/` is **not in Git**: the Git copies under `prep/phase11/` are the durable ones, and that duplication exists precisely because this container is ephemeral.

**Where to look first if an artifact appears to be missing** (PART 13's order, and its warning that a referenced companion document absent from an archive does **not** mean the work never existed): `git show <prep SHA>:prep/phase11/` on this branch; then `/mnt/project-files/phase11/`; then `git log --all --diff-filter=A -- 'prep/phase11/*'`. Do not recreate any of these until that search proves the file absent.

---

## 3. Evidence files

**Pack A (apparel) has executed evidence as of 2026-10-12; the other three packs have none.** The Master Continuous Mission's §18 required the unnumbered scratch proof, and it ran.

| artifact | what it is |
|---|---|
| `P11-LIVE-DDL-PROOF.md` | the proof's report, its run identity, the independent challenge of `1a8ba15` and its answer (§7), and the **sixteen defects** found so far — six of them in this preparation's own specification or its own proof, two of those found only after V2 refused the sentence *"apparel has no concurrency to prove"* |
| `prep/phase11/ddl/p11-pack-a-apparel.sql` | the **unnumbered** Pack A DDL, as applied |
| `prep/phase11/harness/rebuild_and_prove.sh` | the one script that does every step from zero on every run |
| `prep/phase11/harness/run_migrations.py` | a faithful reproduction of the house runner's contract (per-file transaction, ownership-handover bracket, checksum history) for a container with no `node_modules` |
| `prep/phase11/harness/world.sql`, `proofs.py` | the world and the **58** serial cases (21 original, 20 from the first challenge round, 5 from the second, 12 from the third) over **three** apparel products — the third exists because the archive-recovery path has to be proved end to end on a grid that is populated, archived and then extended |
| `prep/phase11/harness/render_bootstrap.py` | the bootstrap renderer, out of the harness script and given a check with a case that **fails** it (`--selftest`), after the second challenge found its in-script check inert twice over |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-0db9450.txt` | **the current authoritative log**: both packs on one cluster, each suite run twice, 9 races, every exit code `0` |
| `prep/phase11/harness/RUN-EVIDENCE-MUTATIONS-0db9450.txt` | the mutation log of Pack A's three new mechanisms: each removed one at a time, with the cases that go red and their counts |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-b7ee445.txt` | **the current authoritative log**: 46 + 47 cases each run twice, 9 races, every exit code `0`, Pack B's end-state assertion at 17 checks |
| `prep/phase11/harness/RUN-EVIDENCE-MUTATIONS-PACKB-b7ee445.txt` | Pack B's mutation log — four mutations, **one full rebuild each**, because a Pack B mutation commits a state the laws forbid and a ledger cannot be restored |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-22e8e2d.txt` | **the current authoritative log** — the third round's answers: **58 + 53 cases, each suite twice on one database**, **9 Pack A races and 4 Pack B races**, every exit code `0` (`EXIT_RACES_B` is new), Pack B's end-state assertion at **19 checks**, `en_US.utf8`, `SOURCE_TREE_DIRTY : no`, frozen prefix intact. The three logs above it are kept, not replaced |
| `prep/phase11/harness/RUN-EVIDENCE-MUTATIONS-ROUND3-da106b7.txt` | the third round's five mutations, **each on its own rebuild with the mutation applied BEFORE any proof runs** (`P11_MUTATION_SQL`), each printed in full: the `'{}'` early return restored (4 Pack A cases red), the archived filter removed (1), the tautology test reduced to its list (2, and the pack's own end-state assertion then refuses the install), the cache-side `RETURN NULL` restored (1 Pack B case), and a widened `UPDATE` grant on `stock_levels` (1). **Every mutation reds only its own pack's cases** |
| `prep/phase11/harness/races_b.py` | **the lot overlay's four races**, carried here from the third challenge's `pb3race.py` and credited to it, because a law whose concurrency is proved by somebody else's script is a law this pack cannot re-prove when §3.6's writer lands. A key-mover against a cache-writer, each unlawful alone, refused in **both** arrival orders; two lawful movements on one key, both committing with key = cache in both orders |
| `prep/phase11/harness/races.py` | **four real-concurrency races** (the axis race in **both** arrival orders — `TL-P4-COORD-R62`: a `BEFORE DELETE` trigger cannot order a lock, so the reverse order is the only one that exercises the refusal guard's body) — two live backends, sentinel-awaited interleaving, **no `sleep()`**; exits non-zero on any failed setup statement, because an earlier version failed its setup silently and invalidated two races |
| `prep/phase11/harness/RUN-EVIDENCE-2026-10-12.txt` | the first green run, **before** the concurrency work |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-d813de2.txt` | the first clean-tree raw log, kept rather than replaced |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-99dbbe7.txt` | the three-race run with **exit codes in the log** (V3 §9) |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-e27acaf.txt` | the pre-challenge authoritative log — 21 cases, 4 races, exit codes `0`. Kept. Its cluster was at `datcollate = C`, which the log did not state — defect 15 |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-2da2000.txt` | the challenge round's log, Pack A only — 41 cases, 7 races, exit codes `0`, on `en_US.utf8`. `EXIT_PROOFS_B` reads `n/a`: Pack B was not on the branch at that SHA and the harness named it as skipped |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-c2289ce.txt` | **the authoritative raw log, and the current one** — Pack A **41 cases / 7 races** AND Pack B **31 cases**, on one cluster in one run, **every exit code `0`**, `en_US.utf8`, `SOURCE_TREE_DIRTY : no`. The two packs are proved together, so neither is claimed from a run the other was absent from |

**Measured, in the form it ran in:** PostgreSQL 16.15 scratch cluster **at `datcollate = datctype = en_US.utf8`, read off the database under test** (the settled target; the harness exits `3` rather than run off it); `bootstrap.sql` as the deployment administrator; **migrations 0000→0086, 87/87, as `daftar_migrator` and not as a superuser**; Pack A applied unnumbered, **in one transaction**, with its end-state assertion passing; **41 proof cases, 0 failed** — 20 of them the removal direction, two of those as **`daftar_app` where RLS is live**; **7 real-concurrency races, 0 findings**; and after the run, **0 tracked changes under `infrastructure/database`, `frozenThrough = 0079`, 80 frozen entries, 0 digest mismatches**.

**Run identity of the authoritative log** — V2 §18 requires the exact source rather than a guess at the remote head:

| field | value |
|---|---|
| `RUN_ID` / `RUN_AT_UTC` | **`p11-20261012T145825Z-6848`** / start `2026-10-12T14:58:25Z`, end `2026-10-12T14:59:44Z` |
| `DB_COLLATION` | **`en_US.utf8 / en_US.utf8 / UTF8`** — of the database under test |
| `HARNESS_SHA256` | `6cc552919e1e25029b2bc7d75a5dcd416abdb17850b9796fc2177e8a55900c79` (the seven harness files hashed together) |
| `BOOTSTRAP_SHA256` | `19df5cca37a6a887ede923e6f108163e579ac42f68cb0c8b48730eb2f2a3c507` |
| re-run command | `git checkout 2da2000 && bash prep/phase11/harness/rebuild_and_prove.sh` — it creates its own `en_US.utf8` cluster and reads nothing outside the repository |
| `SOURCE_BRANCH` / `SOURCE_SHA` | `claude/phase11-prep-re0epv` / **`2da200009e119e36ebde2eabdab9a14299f0a1a1`** (earlier logs: `e27acaf…`, `99dbbe7…`, `d813de2…`, across which the Pack A DDL was byte-identical at `7561f8f8…d3a8` — the digest the challenge reviewed; **at this SHA the DDL itself changed**, so no earlier claim carries forward) |
| `SOURCE_TREE_DIRTY` | **`no`** |
| `MIGRATIONS_SHA` | `b128c7033a3381bd2237d0a1405f0676ac509960` |
| `MANIFEST_SHA256` | `4b4dd6e9e1359eba6536a0c70c0f3cf056e62b47bfed833026541df5ffbe6804` |
| `PACK_A_DDL_SHA256` | **`9ff638d426ec396947dfd0d89d759d0510faf8bb5e9da62921eb97a419304052`** |
| `PG_VERSION` / `NODE_VERSION` | PostgreSQL **16.15**, the PG16 family V3 settles as the deploy target / v22.22.0 against `engines.node >=24 <25`, so **no npm suite ran** |
| `EXIT_PROOFS_A` / `EXIT_RACES` / `EXIT_SCRIPT` | **0 / 0 / 0** (`EXIT_PROOFS_B`: `n/a`, Pack B not on the branch) |

A trial run that printed `SOURCE_TREE_DIRTY : YES` is deliberately **not** reported as evidence: its input had no name.

**Round 4 (this round):** `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND4.txt` — the full run, `RUN_ID p11-20261012T204838Z-6398`, 88 + 53 cases twice, 9 + 4 races, `EXIT_SCRIPT 0`; and `RUN-EVIDENCE-MUTATIONS-ROUND4.txt` — the pair-drop (`M7`/`M8`/`M9`) and the hook's own red proof (`M10`, exit 4). The mutation files themselves are in `prep/phase11/harness/mutations/`, so a mutation run is reproducible by name rather than from the author's shell.

**What is NOT evidence, stated so no reader promotes it:** no npm workspace suite ran at all — this container has **Node 22.22.0 while the repository requires `>=24 <25`** and has no `node_modules`, so `format`, `lint`, `typecheck` and every Vitest suite are `UNMEASURED`. There is **no CI run** for any of this and a local green is never reported as CI. There is **no timing or performance number**, measured or claimed. Lot, serial and repair remain `SPEC ONLY`. There is **no challenger signature**.

**And two notes about npm gates that this phase does not cite but a later reader
will, relayed by the round-5 challenger as a correction against its OWN
evidence (`P11-CHALLENGE-5bad734.md` §0.1) and recorded here as `RELAYED,
NOT MEASURED HERE`:**

- **A fresh clone in these containers has no `node_modules` at all**, so
  `npx prettier --check .` resolves whatever version the npx cache holds — the
  challenger measured **3.9.10** where the repository pins **3.7.1** in
  `devDependencies` and `package-lock.json`. **Any figure citing `npm run
  format`, `lint` or `typecheck` therefore needs an `npm ci` beside it**, or it
  is a claim about a tool the repository does not install. No figure in any
  Phase 11 document cites an npm gate — every one of them is `UNMEASURED` above
  — and this line exists so no later round quietly adds one.
- **Node 24 is fetchable in these containers after all** (the challenger put
  `node-v24.21.0-linux-x64.tar.xz` on PATH, verified against that release's
  `SHASUMS256.txt`), and re-ran the repository's own gate under it with
  `npm ci` from the lockfile: `prettier 3.7.1`, `All matched files use Prettier
  code style!`, exit `0`. That is **its** measurement, not this thread's: the
  runs reported in this manifest were taken under **Node 22.22.0 with no
  `node_modules`**, and their headers say so, which is what made the version
  mismatch visible at all. An exit code belongs to the tree AND the engine it
  ran on.

Every other verdict in every Phase 11 document remains labelled `SPEC ONLY`, `DESIGN ONLY`, `UNMEASURED`, `BLOCKED` or `WAITING_FOR_INTEGRATED_SURFACE`, never two classes in one sentence (§82).

What is owed, and by whom, is in `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md` §3 as a T0–T7 estate. The first execution step is fixed by §12 of the master directive and by `P11-AL-19`: apply the Phase 11 DDL **as `daftar_migrator`, the application role and the internal roles — never superuser-only** — on a scratch cluster and read the earliest error, *before* any TypeScript. The nearby precedent is the one that justifies the order: eight of twelve defects in a comparable slice were found that way, two of them exactly the shapes this DDL invites (a constraint trigger created above its function, and RLS forced with no policy so the validator refuses everything rather than only the incomplete cases).

---

## 4. Migration patch request

`P11-MIGRATION-PATCH-REQUEST.md` — numberless by law. It specifies four packs (apparel axes and the canonicalization trigger; lot/expiry relations, deferred conservation triggers, fold/verify/pick; serial registry and the append-only custody chain; repair tickets, the parts bridge, the preconsumed billing binding, warranty and its lifecycle chain), the RLS and grants shape copied verbatim rather than reinvented, the ownership bracket, and a **17-item end-state assertion** that refuses the migration rather than warning.

Six questions for the Migration Owner, `MPR-01` … `MPR-06` (§10). `MPR-05` and `MPR-06` are new on 2026-10-12: respectively, confirmation that Phase 11 creates **no** money relation for the deposit (PART 69), and whether the warranty pack is allocated **after** the Phase 4 sale-line seal so its anchor FK is to frozen columns (recommended) rather than added by a follow-up, which would leave a window in which an unanchored warranty is representable.

**One core routine must be re-created** (`CREATE OR REPLACE`) rather than extended from outside: the single stock writer, so it can accept lot assignments and serial events. The patch request specifies the request type's extension **without any change to the return shape**, states its predecessor as "the live effective definition at allocation time" rather than a number, and names every routine it re-creates with the reason.

---

## 5. Shared-file patch requests

Phase 11 writes nothing outside its own prefix. Four changes it needs in files other threads own are stated as **patch requests to the owner**, per §78/§80 — never applied here, and a result resting on one is `CONDITIONAL`:

| file | owner | what Phase 11 needs |
|---|---|---|
| `.github/workflows/ci.yml` | CI Owner | the Phase 11 gate as an **unconditional** step of the required `backend` job, after its predecessor; no `if:`, no `continue-on-error` (task `P11-GATE-004`) |
| `packages/domain-core/src/capabilities.ts` | Domain-core owner | a `repairs` capability definition — named in that file's header comment but absent from `DEFINITIONS` — and the capability↔feature mapping that **nothing in the repository currently provides** |
| `packages/domain-core/src/industry-profiles.ts` | Domain-core owner | a `repair` industry profile key |
| the `features` registry (a migration row, not code) | Migration Owner | a repair feature key, and `VARIANT_MATRIX`, which is unregistered while the registry is an FK target — so an unregistered key is refused by the database itself |

---

## 6. Open decisions

**One is with the owner** and it is business/legal by nature: **`OD-P11-07`** — what the business owes if a customer's device in custody is lost, damaged or never collected, and after how long an uncollected device may be treated as abandoned. PART 116 names `customer-device liability` among the only classes an owner is interrupted for, and names nothing else in Phase 11's scope. **Nothing in Phase 11 is blocked on the answer:** custody states, timestamps and actors are recorded faithfully and append-only, the terminal state is the neutral `uncollected` rather than the legal conclusion `abandoned`, and no liability amount is computed. The day the answer arrives it is a policy value and possibly one new state, not a redesign.

**Everything else is ruled:** `ADJ-P11-01` (Option B) and `OD-P11-01` … `OD-P11-06` by `TL-P11-R1` … `TL-P11-R6`, plus `TL-P11-R7` and §55/§60/§62/§63, plus PARTs 62–71 of 2026-10-12. The full record, including the defects returned with each ruling, is `P11-OPEN-DECISIONS.md`.

**One is with the Accounting Owner, not the Tech Lead:** the repair-part posting map (PART 68) — the inventory credit, the expense/COGS/WIP debit per the accepted model, the moving-average valuation source, the correction/reversal path, and no invoice-time duplicate COGS. Phase 11 does not guess the debit. Per `P11-AL-24` this blocks **that subfeature only**, not the phase.

---

## 7. Challenger state

**Pack A has been challenged once, at `1a8ba15`, and REJECTED.** The report is
`/mnt/project-files/phase11/P11-CHALLENGE-1a8ba15.md`, its probes and raw logs in
`phase11/challenge-1a8ba15/`. The challenger reproduced every claim three times from
zero — 87/87 as `daftar_migrator`, 21 cases, 4 races, the frozen prefix intact, the
proof-SHA tie real — and found **no overclaim of evidence class**. It then defeated three
clauses of `C-APP-01` with one SQL statement each, because every case tested its clause
in the **insert direction only**.

**Answered at `2da2000`:** five defects fixed, each with its own red proof; 41 cases and 7
races, 0 failures, on the settled target. One of the challenger's recommended fixes
(`SECURITY DEFINER` guards) was **rejected by measurement** — it disabled all three
guards for a principal with no session context. One item is owed to the Security
Authority (`PR-SEC-P11-01`, §12.2 of the patch request): pin `product_variants`' policy
set in the **standing** RLS invariant check.

**Three rounds have now been run on Pack A (`REJECT`, `PASS-WITH-SCOPE`, `REJECT`) and
two on Pack B (`REJECT`, `PASS-WITH-SCOPE`), and the third round's verdicts are answered
at `22e8e2d`.** Reports: `P11-CHALLENGE-1a8ba15.md`, `-23a7139.md`, `-0db9450.md` (Pack A)
and `-b43871b.md`, `-b7ee445.md` (Pack B), evidence in `challenge-<sha>/`. One run proves
both packs, so a `REJECT` on either makes nothing in the phase promotable at that head.
**What the third round is worth recording for the next one:** the same clause of
`C-APP-01` fell three times through three different statements, and the fix only stopped
being an attack list when it was derived from the forbidden STATE (`P11-AL-32`); a remedy
offered in an error message turned out to be inoperable, which is now a law of its own
(`P11-AL-33`); a mutation applied after the suite had already run measured the re-run and
red nothing (`P11-AL-34`); and the concurrency this phase handed over as `UNMEASURED` was
measurable all along, through a principal named in the pack's own end-state grants
(`P11-AL-35`). Two of the five defects of this round were in the end-state assertion
rather than in a guard — an assertion is code, and it gets attacked like code.

**Still unsigned, and the author does not sign it.** Both packs go back to the
independent challenger; a FOURTH round is owed, and the newest and least reviewed code in
the phase is exactly what this round added. Packs B, C and D have **no subject on the branch** and are
therefore unsigned by anyone: the challenger explicitly declined to sign `C-SER-*`,
`C-LOT-*`, `C-FEFO-01` and `C-REP-*` for that reason, which is the correct refusal.

**The fail-open cases named in advance for the next round** (the earlier list, kept
because none of them has been attacked yet): An author does not sign their own work, and nothing here carries a second signature, let alone a third. PART 118 lists **Challenger on design** among the immediate Phase 11 items, and it is startable now because its subject is these seven documents rather than code: task `P11-REP-014`. The fail-open cases to attack, named in advance so the challenger need not find the list first:

1. a billing binding created **before** its consumption exists (`P11-AL-21` condition 7) — re-opens the §60 defect by another door;
2. a binding across **two customers**, which no single-customer fixture can expose (condition 3b, new on PART 67);
3. a warranty row **deleted** by a return path (`C-WAR-01` case d) — the first draft's shape;
4. a proof whose mutation lands in **frozen history** (`P11-AL-25`, §0a of the laws document);
5. `C-SER-03` satisfied by **zero** serial events on some writer branch — silent, permanent overlay drift;
6. `C-LOT-03`'s per-lot cache disagreeing with `stock_levels` — a second quantity truth wearing a cache's clothes.

### 7.x The FOURTH round, answered

**Pack A `REJECT`, Pack B `PASS-WITH-SCOPE` at `04d87b3`** — reports
`P11-CHALLENGE-04d87b3-PACK-A.md` and `-PACK-B.md`. Answered in ONE commit, as
the coordinator asked. Six findings, and the two sentences a reader should take
from the round:

1. **The door that rejected Pack A was opened by round 3's own correct
   remedy.** `C-APP-01` is therefore no longer enforced as a list of verbs: a
   state check recomputes the forbidden state at COMMIT, through four
   `DEFERRABLE INITIALLY DEFERRED` constraint triggers on every relation the
   state can be written from. The per-verb guards are kept and **pair-dropped**
   so a reviewer can see which layer answers which door (re-measured in round 5 with each
   count naming its pass: `M7` 14 red on pass 1 / 18 on pass 2, all of them the
   new door; `M8` 17 / 17; `M9` 39 / 43).
2. **Three of the six findings are in the WITNESSES, not in the laws** — a race
   verdict satisfied by nothing happening, a mutation hook blind to its own
   mutation, and a text pin over `pg_get_functiondef`, which includes comments.
   All three are fixed with red proofs of their own, in both packs wherever the
   shape appeared, including where no challenger had yet looked.

Numbers, this round: **88 Pack A cases and 53 Pack B cases, each twice on the
same database; 9 and 4 races, every one of them now also proving its two
backends overlapped; every exit code 0**; the mutation set is in the repository
under `prep/phase11/harness/mutations/` with a README naming the invocation; the
frozen tree is clean. Evidence:
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND4.txt` and
`RUN-EVIDENCE-MUTATIONS-ROUND4.txt`. Run identity and exit codes in
`P11-LIVE-DDL-PROOF.md` §12.8.

**A FIFTH round is owed on both packs.** The newest code in the phase is what
this round added, and **nothing here is self-signed.** Still open: `MPR-09`
(restated and narrower), `MPR-10` (now three routines to fold),
`PR-SEC-P11-01` (four named spellings), `MPR-07`, `MPR-08`, the Pack B grants
and the registered op code, `OD-P11-07` (the owner's), Packs C and D as
`SPEC ONLY`. `READY_TO_PROMOTE` = **NO**; **no migration number exists**.

---

## 7.5 The FIFTH independent challenge round (2026-10-12) — Pack A `REJECT` on one fail-open, answered

The round reproduced every figure of round 4, credited the grant-generated
write-path sweep, accepted this pack's correction of the challenger's own
round-3 sentence, and then rejected Pack A on **one** defect plus two `P3`s.
Answered in ONE commit, as the coordinator asked.

1. **Privilege is not visibility.** Round 4's blindness arm asked
   `has_table_privilege` — a question about the GRANT — while what defeats a
   deferred check is VISIBILITY: under `FORCE ROW LEVEL SECURITY` with a
   role-based `app_bypass()`, a principal holds all four privileges and reads
   zero rows. Measured at `rc 0 NOT REFUSED` with one live variant outside its
   grid. **The fourth door, re-opened by the arm added to close it.** What
   closes it is a **write-identity comparison**: four `AFTER … FOR EACH
   STATEMENT` recorders write `current_user|app.business_id|app.tenant_id` into
   a transaction-local setting on the first write, and the deferred check
   refuses when it is empty or has changed by `COMMIT`. The remedy both the
   challenger and the coordinator preferred — a **read-back** of the row that
   queued the check — was implemented in exactly that form, measured, and
   **REJECTED BY MEASUREMENT** (it refuses a lawful `INSERT`-then-`DELETE`
   transaction, and has no answer at all for `DELETE`); the rejection is
   recorded in the DDL where the remedy would have been written.
2. **Every count now names its pass.** The suites are run twice on one database
   on purpose, and the second pass starts from the state the first left behind,
   so a bare number is an ambiguous cell (the P10 R7 lesson, applied to prose).
3. **The digest was blind to `pg_attribute`.** Two real mutations produced
   byte-identical digests, one of them changing `attnotnull` — the single
   catalogue fact two forms of the tautology test rest on. Closed with a
   `UNION ALL` arm over `pg_attribute`; proved by `M13`, whose own first draft
   over-claimed and is corrected in the file.

Numbers, this round, **each naming its pass**: **93 Pack A cases, 0 failed on
pass 1 and 0 on pass 2**, and **53 Pack B cases, 0 and 0**, on one database; **9
and 4 races, overlap `2/2` on every one, 0 findings**; every exit code `0`; the
frozen tree clean (`digest mismatches: []`). Six mutations, each on its own full
rebuild: `M7` 14/18, `M8` 17/17, `M9` 39/43 (race fixture unbuildable, exit 2),
`M10` refused at exit 4 with an identical digest, `M11` 5/15 (this round's
finding red-proved), `M13` 0/0 in Pack A with the digest changed.

Evidence: `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND5.txt` and
`RUN-EVIDENCE-MUTATIONS-ROUND5.txt` (`M7`, `M8`, `M9`, `M10`, `M11`, `M13`, each
on its own full rebuild). Run identity, exit codes and the mutation table are in
`P11-LIVE-DDL-PROOF.md` §13.4; the two residuals this round NAMES rather than
closes — a superuser's `session_replication_role = replica`, which `daftar_app`
cannot set, and an unreachable `RAISE` satisfying a comment-stripped pin — are
in §13.5.

**A SIXTH round is owed on both packs**, and **nothing here is self-signed.**
`MPR-10` now carries five items. Everything listed above as open stays open.
`READY_TO_PROMOTE` = **NO**; **no migration number exists**; no CI has executed
any of it.

---

## 8. Coordinator state

**No coordinator signature.** Phase 11 cannot promote: Phase 4 is not sealed and Phases 5–10 have not started, and §88's promotion order is serial even though preparation is parallel. The coordinator's involvement so far has been to relay the two directives and to ask that the per-phase one be applied here; no verdict has been signed on this phase by anyone.

---

## 9. Unresolved blockers

| blocker | class | owner | blocks |
|---|---|---|---|
| Phase 4 not sealed | sequencing | Phase 4 thread | all promotion. The billing binding's FK and the warranty anchor both point at Phase 4 sale lines |
| Phase 4 payment / customer-credit contract not sealed | `WAITING_FOR_INTEGRATED_SURFACE` | Phase 4 | the repair deposit flow (`P11-REP-012`). The design is settled; the surface is not |
| Phase 10 `SERVICE` stock-effect capability not sealed | `BLOCKED` | Phase 10 | repair labour as a service product (`P11-REP-010`). Phase 11 registers nothing dead in Phase 10 for it |
| repair-part posting map unruled | `BLOCKED` (one subfeature) | **Accounting Owner** | registering `repair_part_consumption` and anything posting through it. Explicitly **not** the rest of the phase (PART 68, `P11-AL-24`) |
| `OD-P11-07` customer-device liability | owner-only | **Tech Lead / legal** | nothing. Recorded so it is not mistaken for an engineering gap |
| capability↔feature vocabulary unmapped | shared-file patch request | Domain-core owner | every pack screen's gating. Startable now (`P11-CAP-002`) |
| the Phase 11 gate is not a required CI step | shared-file patch request | CI Owner | the gate's own authority. A gate CI does not run is `UNMEASURED`, never green |
| **V3 §7's install contract contradicts `check:deployment-authority`** — **confirmed by Phase 4 and ruled `TL-P4-COORD-R61`: the deployment path is `daftar_migrator` over all migrations**; only "was §7 meant as a new contract" is still with the owner, asked in the Phase 4 thread | fact correction / contract question | **Migration Owner** (with Phase 15's deployment line) | nothing in Phase 11 today, and it is raised rather than answered: §7 says `0000–0039` apply as the **administrator** and `0040+` as the migrator, while `DEPLOYER = 'daftar_migrator'`, Case A applies **every** migration as it from an empty database, Case B applies `0000–0039` as it, and `phase2-rollback-rehearsal.ts:462` **withdraws** the contrary reading (RB-P2-01, closed in P2-S9). The administrator appears only on the **restore** path (`--no-owner`). `0039` is the Phase 1 freeze boundary, not a role boundary. Phase 11's proof measured Case A's configuration and claims no admin/migrator rehearsal. Citations: `P11-LIVE-DDL-PROOF.md` §6 |

**Not a blocker, recorded so it is not silently corrected by the wrong hand:** the canonical status page at this head still describes the S4 candidates as three while the tree carries seven. The live code is the fact; that page belongs to the coordinator.
