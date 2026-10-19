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
| `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `c9b3e23e7a2af9048daa07184e622733aa211683e0cd475e3949fc866337d578` |
| `P11-TASK-DAG.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `6923f0add88d2a0bc31b89fa1b91be8ce20a7540fa6f95e20bf42ae2dd791979` |
| `P11-OPEN-DECISIONS.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `983e026a9bc6c7fe3b65cfc22fb7672ee33d30cd042e6f31ee176a1bb23055f1` |
| `P11-S0-REPORT-AR.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `25acaf2dcfdf9767b3aeaf2d956a3dc3df343cdd6bf66ae6c39edccbf9cb3faa` |
| `P11-LIVE-DDL-PROOF.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `180830b48401dc12323ce070b1c2256925f104d9f7028554914e70c21196bbf4`|
| `prep/phase11/ddl/` + `prep/phase11/harness/` | — (Git only) | **committed** | the applied DDL and the harness; in Git rather than off-Git because they are executable, not prose |
| `P11-HANDOFF-MANIFEST.md` (this file) | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | self-referential; recompute with `sha256sum` |

### 2a. The deciding files are read from the COMMIT

**There is no pin table here any more, and its absence is the fix.** The first
answer to the coordinator's `C21-F1` was a table of harness digests in this
section. Round 21 measured that whole class again one level up: the matcher's
constants were pinned by a literal in the file a plant edits, the refusal text
told the maintainer to re-run `--decision-constants` and commit the new digest,
and taking exactly that step reopened the escape with every gate at 0. **A pin
inside the thing it pins is not a pin, and a table a planter edits in the same
commit is the same mistake with one more file in it.**

So the authority is the commit. Every deciding file under
`prep/phase11/harness/` — every `.py`, `.sh` and `.sql`, by walking rather than
by a list, so a file added tomorrow is covered the day it is written — must equal
`git show <resolved anchored sha>:<path>`. It is read **twice**: once by
`check_fenced_figures.py` itself (`SELF-BYTES-UNCOMMITTED`,
`SELF-FILE-UNCOMMITTED`, `SELF-FILE-ABSENT`, `SELF-ANCHOR-UNRESOLVED`) and once
by `harness/check_harness_bytes.py` (`HARNESS-BYTES-UNCOMMITTED` and its
siblings), which imports nothing from the checker and is itself one of the
deciding files — because a file cannot be the authority on its own bytes. And
`_source_of` now takes the frame's source **from that blob** rather than from
`inspect.getsource`, so a working-tree edit cannot be measured as a rule at all.
The scan and `--check-blocks` refuse on both readings; `rebuild_and_prove.sh`
runs the second reader at step `0c-0`, fatally, before anything that reads those
bytes.

**What this does not do, stated at the law:** it does not stop a planter who
COMMITS. Nothing executable can. **Nor, round 22 measured, does it stop an
UNCOMMITTED edit to the file that invokes the law** — which is why a dirty work
tree is now refused by name wherever the run is entered (`SELF-TREE-DIRTY`,
`HARNESS-TREE-DIRTY`, `SOURCE-TREE-DIRTY`) and why the limit is stated for the
reader: a transcript is evidence only when it was produced from a CLEAN tree
whose `HEAD` is the committed sha, and reviewers run from fresh clones (§7.23).
What the law changes is that every escape from rounds 16 to 21 — the gitignored
artefact, the AST gaps, the receiver, the rebound attribute, the argument, the
re-pin, the added admit-list entry — has to be in the diff, under the digests
published below, in front of an independent challenger and the coordinator. That is the whole of the guarantee, and it is
why this phase's chain has three links and why no author signs their own work.

The digests below are **published for a reader**, not compared by the run: they
say which commit's bytes the reviews were issued against. Nothing in the harness
reads this list.

**They were taken at `868f25d`, the previously reviewed commit, and three of them
have moved in the commit that carries §7.23** — `check_fenced_figures.py`,
`check_harness_bytes.py` and `rebuild_and_prove.sh`. That is not an omission to
be tidied by editing the rows: a list inside a commit cannot carry its own
commit's digests, and the ruling that removed the self-pin is the reason this
list is published rather than compared. **The authority is the commit**, read with
`python3 -I harness/check_harness_bytes.py --digests`, which prints the rows for
whatever commit the reader is standing on; the rows for this head are published
beside the artefacts under `/mnt/project-files/phase11/`.

<!-- P11-DECIDING-BYTES-PUBLISHED-AT-THE-REVIEWED-COMMIT -->
```
28253d3b99a171e2d7ed22da0110931776f39ddbf52dc4250fe43a7d31d6f83e  check_fenced_figures.py
f7f759197c02df7f818934b221bbe883611b3a1e50e52fa7be87214770381fa5  check_harness_bytes.py
3555bc5947f567fc2ef67b512bafad49c7b0ab0baae1d0b59a7fca98d93324ad  mutations/M10-noop.sql
b6b715810b22883898e778cbcafac136517ca3bde7c1b0c3000cca2282c0ac37  mutations/M11-defeat-the-write-identity-comparison.sql
4481a3e78a4bdeec5b443a1395a5e24b12a75801b3c0270f0a45f61359c5b616  mutations/M13-column-acl-and-notnull.sql
bf055412f8c14c0071b3242760dc6638bbde81b2f75ad926804be9fc138844e9  mutations/M14-restore-the-ledgers-forgeability.sql
c4dc7ed65f839201706c89dc20863878e1f8f3e2e9cf83c5523b47b7676c55a2  mutations/M15-drop-the-own-transaction-write-policy.sql
1723aba93e06db2bc3ece4b30fa0a032bd4421f0675135253a1b3c0a20fe2099  mutations/M18-make-the-write-policy-permissive.sql
4f898a2565a3683d19feec16a082f195de83417cff807e099818913a04359cea  mutations/M20-re-add-the-xmin-filter.sql
d6d16fc4bcb4b29235a6a06d5606a5c61a980653a9ab057f66e6834141e998c0  mutations/M21-drop-force-on-the-ledger.sql
dec4091025a28e212e98d1dd1509a8522337ab4038c26b31a408279c4a64da91  mutations/M7-drop-deferred-grid-closure.sql
723fadf21fb9c534c88747daddbab2513360b8386ac251718a777fd59311ee99  mutations/M8-drop-per-verb-guards.sql
18db19d2bb80cf922133dd041752210c823dd716fd1b792522c305e341201930  mutations/M9-drop-both.sql
21cbd79cd3558f47dc43aa5d56003fe776b0a6f95cfc96bdcea939c724b8f08f  proofs.py
05b3eaddb18fe0db3af4b838abcd1f824eec4f97a9afafe6009762a861b7ace8  proofs_b.py
8aa0059c405295e4e289a20137ab9e6a19eeb8ee7c8c54cf5ee684fe8f11313c  races.py
4edd65bdad7544c30061a02d6e55a73e01a8efda6eaf88f138955edc06c49491  races_b.py
743950cf4e0dcf3c4e576a54a652531354725c891caefd4dfff452606c8d478f  rebuild_and_prove.sh
73720ff9da0caaf7eff624c34aaedb10ee70151c34b26e4c1b64d98e145bf73b  render_bootstrap.py
c558e5deed66856fb66ffc1b8eca38d6defdef1154156cdca8a0a7690ba7c422  run_migrations.py
10844c6f72090fb5aff606d7c839b71e144f0606d7065740917b7689b85e340f  world.sql
6ae8f159ca5e653c4cfd46c85816339257bddfbad4f076188db45f3fec89afcc  world_b.sql
```


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
| `HARNESS_SHA256` | `6cc552919e1e25029b2bc7d75a5dcd416abdb17850b9796fc2177e8a55900c79` (the seven harness files hashed together). Reproduce it, and every other `HARNESS_SHA256` row here, as `cat $(ls <files>) | sha256sum`: **`ls` sorts**, so the order hashed is alphabetical, not the order the script lists. The set grew to nine files and then to ten (§7.11) |
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

## 7.6 The SIXTH independent challenge round (2026-10-12) — Pack A `REJECT` on one fail-open, answered

The round **closed** round 5's `P1-01` (the write-identity remedy's content is
confirmed across four shapes the coordinator named), **closed both round-5
residuals**, settled `M13` and `M9`, and **reproduced this thread's rejection of
its own preferred read-back remedy** in its container. It then rejected Pack A on
one defect.

**The defect: the remedy's content was right and its STORAGE was forgeable.**
`p11.grid_ctx` was a custom GUC in an unreserved prefix — any role may `SET` one,
no grant, no check — and "first write wins" preserved a value that was already
there, so the comparison read the attacker's own string. Measured three ways,
`rc=0` **NOT REFUSED** each time; the one that matters needed **nothing beyond
`daftar_app`'s own rights**: one session-level `SET` covered **two successive
transactions** on one connection, which is what a pooled connection looks like.
Round 5's comment claimed `is_local => true` prevented exactly that; it is true of
the recorder's own write and says nothing about a session-level value that was
already there.

**The answer: a store the judged session cannot write, and unanimity instead of
first-write-wins.** The identity lives in `catalog_grid_ctx_ledger`, one row per
writing statement; `recorded_identity` is a server-evaluated column `DEFAULT` and
the writing roles hold `INSERT (txid)` only; no role holding `INSERT` holds
`UPDATE`, `DELETE` or `TRUNCATE`; RLS pins every row to its own transaction; and
the check refuses unless **every** recorded identity is the same **and** equals
the identity at `COMMIT`. Unanimity is what makes a forged row harmless rather
than decisive, and it refuses a transaction that wrote as A, wrote as B and came
back to A — which the old rule passed. `EXECUTE` on the identity function is
revoked from `PUBLIC` and granted to the roles enumerated from `relacl`/`attacl`,
and the DDL states that the integrity comes from the column ACL, not from the
function being private.

**Two of this thread's own errors inside the fix are on the record** (§14.1): an
end-state assertion that refused the pack's own install because it did not
exclude the table owner, and a claim that moving the generated grant block
changed the enumeration from 3 roles to 4 — it did not, measured both ways, and
the DDL now calls the move a precaution.

**The pair-drop's result is reported as asymmetric** (§14.2): of the two defences
against a planted row, only the RLS write policy has a reachable case. The `xmin`
filter is `UNMEASURED` defence in depth and is named as a residual. Two green
layers are not two tested layers.

**The repository's gates, two numbers per cell as the coordinator's rule
requires, measured on Node 24.21.0 (verified against its `SHASUMS256.txt`) with
`npm ci` from the lockfile, at this head and at `main`'s `6fc505d`** (§14.3):

| gate | head cold | head after build | `6fc505d` cold | after build |
|---|---|---|---|---|
| `typecheck` | **2** | **0** | **2** | **0** |
| `lint` | **1** (4,798 errors never-built; 2,793 with `dist` removed) | **0**, 0 errors | **1** (4,220; 2,400) | **0**, 0 errors |
| `build` | **1** first run, **0** second | — | **1** first run, **0** second | — |
| `format` | **0** (no build dependency) | 0 | **0** | 0 |

The order within each tree was `typecheck → lint → build → build → typecheck →
lint → format`, and it is stated because **two states both honestly called
"cold" gave two different lint figures at the same commit** (4,798 and 2,793) —
a bare cold number is underdetermined, not merely incomplete. So the lint
residual the round-5 challenger named is **`G6`, not a lint debt**: the first
build fails because `apps/api` compiles before its dependencies' `dist` exists,
and the second returns 0. The 578-error cold delta is attributed by path — 569
in `apps/`, 9 in `tests/`, 0 in `prep/` at either commit — and the range
`6fc505d..HEAD` is 335 commits, so it is not a Phase 11-only range. Raw logs:
`prep/phase11/harness/RUN-EVIDENCE-REPO-GATES-ROUND6.txt`.

**A method failure of this thread's own is on the record** (§14.4): I started a
second mutation loop while the first was still running, so two harness runs
were rebuilding one scratch cluster at once. Those segments were **discarded,
not reported**, and `M16`–`M19` were re-run strictly serially.

Evidence: `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND6.txt`,
`RUN-EVIDENCE-MUTATIONS-ROUND6.txt` (**twelve** mutations, each on its own full
rebuild) and `RUN-EVIDENCE-REPO-GATES-ROUND6.txt`. Run identity and exit codes in `P11-LIVE-DDL-PROOF.md` §14.4; what
stays open in §14.5.

**A SEVENTH round was run; see §7.7.** Nothing here is self-signed.

---

## 7.7 The SEVENTH independent challenge round (2026-10-13) — Pack A `REJECT` on one clause, both faces measured, answered

**The verdict confirmed everything the sixth round built** — the server-written
identity column, the `INSERT (txid)`-only grant, the immutability, the RLS, the
generated grants, a decoy ledger in a schema the app role owns and a `pg_temp`
decoy (both refused), the 48 `SECURITY DEFINER` functions none of which names
the ledger or the context, and all three round-6 forgeries now refused — and
rejected the head on **one clause**: `AND l.xmin = pg_current_xact_id()::xid`.

`pg_current_xact_id()` returns the TOP-LEVEL transaction id; a row written
inside a SUBtransaction carries the subtransaction's id in `xmin`. Probed here
directly before anything was changed: `20098` vs a current `20097` for the row
written after `SAVEPOINT s1`. A savepoint, a PL/pgSQL `BEGIN ... EXCEPTION`
block and an ORM's nested transaction all open one, so the clause discarded the
ledger rows of an ordinary application shape — and it was wrong in **both**
directions, reproduced in this container as `daftar_app`:

* **fail-open** — the round-4 door with the harmful chain inside a `RELEASE`d
  savepoint committed at **rc 0** with 1 live variant outside its grid, while
  the identical chain at top level was refused at rc 3;
* **refusal of lawful work** — a wholly lawful build inside a `RELEASE`d
  savepoint was refused at rc 3 on the `v_rows = 0` branch.

**Answer, in ONE commit:** the clause is DELETED (not repaired — PostgreSQL does
not expose the subtransaction-to-top-level mapping from SQL, and the `txid`
predicate plus the RLS `WITH CHECK` already carry everything it was meant to).
Nine permanent cases, `PA7-S1`…`PA7-S9`. **Eight of the nine run as
`daftar_app` with no superuser in the session. `PA7-S6` is the exception and
must be**: it is the read-back witness that asserts nothing committed, and a
witness has to be sighted — run under `daftar_app`, row-level security would
hide the very rows it exists to prove absent, so an empty read would be
indistinguishable from a clean state. It runs as the harness default, which is
`postgres`. The sentence that stood here claimed all nine ran as `daftar_app`,
which was **false as written** and is corrected rather than reinterpreted; the
instrument was right and the claim about it was wrong (finding `P3` of the
eighth round). The nine are: the savepoint exploit, its top-level isolating control, the zero-row
no-op variant of the same exploit, the lawful savepoint build, the
`BEGIN ... EXCEPTION` shape, the zero-row statement that records a consenting
row for free, the rolled-back write that correctly records none, `TRUNCATE`
refused by name (`R7-06`), and the committed-state assertion. `M20` restores the
clause and is the one mutation whose point is that it is **NOT green**; `M16`,
`M17` and `M19` are deleted, because with the clause gone all three target text
that is not there. `R7-06` also adds an end-state assertion that no non-owner
role holds `TRUNCATE` on the four relations. The sixth round's own wording is
corrected rather than reinterpreted: naming an unreached layer `UNMEASURED` was
right, reading its green as harmlessness was not — gate arms
`unmeasured-read-as-inert` and `write-that-no-trigger-covers`, architecture note
`P11-AL-42`.

Evidence: `RUN-EVIDENCE-AUTHORITATIVE-ROUND7.txt` and
`RUN-EVIDENCE-MUTATIONS-ROUND7.txt`. Run identity, both faces and the figures in
`P11-LIVE-DDL-PROOF.md` §15; what stays open in §15.5. **No cold lint or
typecheck figure is quoted as attribution anywhere** — the challenger retracted
its round-6 attribution and the two-number table is the only gate reference.

**The EIGHTH round was run; see §7.8.** Nothing here is self-signed.

---

## 7.8 The EIGHTH independent challenge round (2026-10-19) — `REJECT` on one documentation claim, answered

Narrow on `2bfb6d5..02befb6`. **One finding, documentation only, no code change
asked for and no re-measurement:** §7.7 above claimed all nine of
`PA7-S1`…`PA7-S9` ran "as `daftar_app` with no superuser". Eight do; `PA7-S6`
runs as the harness default and **must**, because it is the read-back witness
and under `daftar_app` row-level security would hide the rows it exists to
prove absent. The instrument was right and the sentence was wrong; §7.7 and
`P11-LIVE-DDL-PROOF.md` §15.2 are corrected in place.

**Answered with one addition of substance**, because the round also named the
leg §15.3's argument was missing: with the `xmin` filter gone, the RLS
`WITH CHECK` carries the plant defence alone, and a policy binds a table's
owner only under `FORCE ROW LEVEL SECURITY`. That leg is now `PA8-O1` in this
repository's own suite — the same plant refused as `daftar_migrator`, the
table's owner — so the claim rests on this tree's instrument rather than on a
report outside it. §16.1 has the three-arm table.

Confirmed by the challenger and recorded in §16.2: `PA7-S5`'s rolled-back
savepoint (no correct refusal turned into a correct-looking pass), `R7-06`
tested by **defeating** it (a prepack granting `TRUNCATE` makes the rebuild
exit 7 with `catalog.migration_end_state_invalid` by name, control exits 0),
and `M20`'s attribution with the limit as this phase states it. Two residuals
are named and were not attacked: reaching `COMMIT` with zero ledger rows and
real state to judge, and ledger growth / `UNLOGGED` / pruning as a denial path.
§16.3 records one compression of mine — a relay that dropped §15.3's "on the
unmutated schema" qualifier — which is the same defect as the finding, one
level down.

Figures: Pack A **116 cases 0 failed on both passes** (the one new case is
`PA8-O1`), Pack B 53 ×2 0 failed, 9 + 4 races 0 findings, every `EXIT_*` 0.
The challenger's own two-number gate table at `02befb6` is identical in every
cell to `2bfb6d5`; no cold figure is quoted as attribution.

**The NINTH round was run; see §7.9.** Nothing here is self-signed.

---

## 7.9 The NINTH independent challenge round (2026-10-19) — **PASS-WITH-SCOPE** at `9c23f17`, two `P3` asks, both answered

Narrow on `02befb6..9c23f17`. **`9c23f17` is the first head of this phase with
all three review links complete**: the challenger's `PASS-WITH-SCOPE`, and a
coordinator diff review that signs it after re-running the clean suite itself
(116 ×2 and 53 ×2). The signature covers `9c23f17` only, with
`f87a7ce0…` / `d5820ada…` / `02e31c35…`, and **does not transfer** — the follow-up
commit below changes the harness (`proofs.py`, a new mutation) and the
documents, so the head it creates carries no signature and a tenth round is
owed narrow on `9c23f17..HEAD`. It does **not** change either pack: Pack A
stays `f87a7ce0…` and Pack B `d5820ada…` across `9c23f17`, `51686d9` and the
head below. (An earlier draft of this paragraph said the follow-up changes
Pack A. It does not, and that is corrected here.)

Neither ask was a blocker and both are this phase's own standard applied to it:

**`R9-F1` — `PA8-O1`'s red proof was owed.** A passing case measures nothing
until something can make it fail, and the eighth round added `PA8-O1` with no
mutation behind it. `M21-drop-force-on-the-ledger.sql` is that mutation; the
three existing candidates were each measured and only `NO FORCE` with the
policy kept flips exactly one of the two arms (§16.4 has the table). The same
finding's smaller arm narrowed §16.1's third claim: the hand-supplied forgery
is refused **by privilege**, and the owner holds `recorded_identity`
implicitly, so that leg never covered the owner — measured as `PA9-O2`, where
it commits and the chosen string persists.

**`R9-F2` — the ledger cannot be pruned the way a retention job would prune
it.** As the owner, `DELETE` returns `deleted=0` and the owner's own
verification returns `0`, while a superuser immediately afterwards sees every
row: FORCE RLS binds the owner and no policy matches another transaction's
rows, so the job prunes nothing, reports success and confirms itself.
`MPR-10` therefore has exactly two implementations — all-or-nothing `TRUNCATE`
by the owner, or a superuser `DELETE` — and a time-windowed owner prune is not
one of them. `P11-MIGRATION-PATCH-REQUEST.md` §16.6 and `P11-LIVE-DDL-PROOF.md`
§16.6; `PA9-P1` and `PA9-P2` are the two reads.

**And the third item, recorded as a named residual rather than a finding**
(§16.5): what the owner's position buys is *nothing on the path the law
judges* — a chosen row beside a real write is refused for recording two
identities (`PA9-O3`) — with one honest narrowing, that a governed write
engaging **no live grid** commits with two identities recorded, because the
deferred check has nothing to judge. Nothing unlawful lands; **attribution** is
what is lost (`PA9-O4`).

Also closed by the challenger's own measurement, and recorded as mechanism
rather than absence: every door that changes governed state records an
identity — an `ON DELETE CASCADE` from a non-governed parent fires the
`FOR EACH STATEMENT` recorder and the deletion is attributed; no application
role holds `DELETE` on `products` or `businesses`; `COPY … FROM` is refused
outright under row-level security even for the owner; `MERGE` records even when
it matches nothing; and a session cannot delete its own ledger rows
mid-transaction. What remains is `TRUNCATE` (closed by `R7-06`) and a trigger
switched off (owner or superuser only, already named).

Still `UNMEASURED` and named: ledger growth run to an actual failure, `UNLOGGED`
as a choice, ledger concurrency, what a `businesses` cascade would record, and
PG18.

**A TENTH round is owed** on `9c23f17..HEAD`, and **nothing here is
self-signed.** `READY_TO_PROMOTE` = **NO**; **no migration number exists**; no
CI has executed any of it. `OD-P11-07` is the owner's.

---

## 7.10 The TENTH independent challenge round (2026-10-19) — `REJECT` on two sentences of prose, answered

Narrow on `9c23f17..51686d9`. The challenger reproduced every substantive claim
in that commit — `M15` 19 reds with `PA8-O1` **not** among them, `M18` exactly
two (`PA6-L2` and `PA8-O1`), `M21` exactly three with `PA6-L2` **staying red**,
the five new cases, the clean suite at 121 ×2 and 53 ×2, 13 race scenarios, 80
frozen entries with 0 mismatches, and the gate table identical in every cell to
`9c23f17`, `02befb6` and `2bfb6d5` — and **REJECTED the head on two sentences**.
Both are fixed here, in the documents only. No code changed, no pack digest
moved, and nothing was re-measured, because nothing in the fix touches an
instrument.

**`R10-F1` (`P3`) — a figure inside a fenced block that no instrument emits.**
§16.6 showed three lines as one observation at one moment, and the third,
`superuser_sees=130`, is not output: `PA9-P2` asserts the boolean
`present=true`, `grep -rn superuser_sees prep/phase11/harness/` returns
nothing, and the string appears in neither published evidence file. It is
withdrawn rather than replaced by a measured count, and §16.6 says why: the
suites run **twice on one database** and the ledger accumulates, so a row count
is a function of when it is read, while `PA9-P2` reads partway through pass 1.
The challenger measured 59 rows after a complete pass and 112 after a second —
**their figures, carried here and not re-measured by this author** — so a
number near 130 belongs to the end of a whole run, a different moment from the
one the block describes. This is the class of defect this phase's stopping rule
treats as blocking, and the challenger was right to reject on it over a correct
instrument: it is the same shape as `R8`'s single false sentence, and the rule
has to hold when the author is the one who got it nearly right.

**`R10-F2` (`P3`) — "`M21`'s third and fourth reds"** in §16.4, four lines under
a table cell reading 3 and four lines above "All three of `M21`'s flips". The
two meant are the **second and third**. One word, fixed.

**Recorded, not fixed:** the challenger looked for a hazard in `PA9-P1` and did
not find one — under `M21` that case really does empty the ledger mid-suite
(`deleted=53`), and it cannot corrupt the cases after it because every law in
this pack reads only `txid = pg_current_xact_id()` and nothing ever reads the
ledger's history. That is also why `TRUNCATE`-style pruning is safe at all
(§16.6). It is worth knowing and it is not a defect.

**An ELEVENTH round is owed** narrow on `51686d9..HEAD`. The challenger has
said this head is signable on the same evidence once those two sentences are
fixed, and that it will not re-run the suite unless a pack digest moves —
neither of which is a signature, and neither is mine to give.

---

## 7.11 The ELEVENTH round — **`PASS`** at `24f6ebe`, and the first head of this phase with ALL THREE LINKS COMPLETE

Narrow on `51686d9..24f6ebe`. **`PASS`, with no finding open** — the first head
here to pass with nothing owed to the challenger. Frozen at
`/mnt/project-files/phase11/P11-CHALLENGE-24f6ebe.md`, sha256
`34f0f80391c64294aea398dec646941a69a93e0a46f0963dd44b00659f38d75f`, 136 lines /
7,231 bytes — digest, line count and byte count re-verified on disk by this
author rather than taken from the verdict.

**The coordinator diff review then SIGNED the same SHA**, on a clone pinned to
the full 40 characters, with its report at
`/mnt/project-files/phase11/P11-COORD-DIFF-REVIEW-24f6ebe.md`, sha256
`7a5e0c14bc088dbd7b8ca380335e029c32cc09345363b3ea7503306f4c8d2275`, 171 lines.
It re-ran the clean suite itself on PG 16.15 at `en_US.utf8` over the real 87
migrations with both roles `NOSUPERUSER NOBYPASSRLS` (Pack A 121 / 0 failed,
Pack B 53 / 0 failed, two passes, on a rebuild) and confirmed that `M21` reds
exactly `PA8-O1`, `PA9-P1` and `PA9-P2` with the control holding. It carries
two residuals, **both `P3` and neither a fail-open**: `PA9-O4`, where
dual-identity rows persist and only the owner can write them, so only
attribution is lost; and `MPR-10`, where owner pruning is a no-op, so the cost
is growth only.

So `24f6ebe` is **author → independent challenger `PASS` → coordinator diff
review SIGNED**. That is the complete chain this phase requires, and it is the
first time this phase has had it. It remains **`PREPARED`, not promoted**:
`READY_TO_PROMOTE` = **NO**, no migration number exists, and the signature
covers `24f6ebe` alone with `f87a7ce0…` / `d5820ada…` / `f1e6775d…`.

**This commit is a new SHA and therefore carries NO signature.** It was held
until the review returned, on the coordinator's instruction, precisely so the
signed head stayed signed; the two things folded into it are:

**1. This section**, the record of the round, which could not be written at
`24f6ebe` without voiding the signature it records.

**2. `harness/check_fenced_figures.py` — the review arm made EXECUTABLE.** The
challenger's closing note on round 11 was that
`figure-that-no-instrument-emits` was a rule in a document with nothing
enforcing it, and offered an executable form without asking for it; the
coordinator adopted it. The check reads the FENCED blocks of this phase's
documents, takes the lines that are nothing but a lowercase `key=value` token,
and requires each token to appear somewhere under `prep/phase11/harness/` —
which holds both the instruments and the committed run evidence. It is now
**step `0c` of `rebuild_and_prove.sh`** — and the sentence that stood here
first, "step 0, before a cluster exists", was **wrong in both halves**; see
§7.12, which found it by running the plant rather than by reading the script.
Steps `0` and `0b` create and start the scratch cluster, so the number
collided with them and the check runs after the cluster is up. What the claim
was for is still true and is now stated as what was measured: it runs **before
the database is dropped and recreated, before the roles are bootstrapped and
before any migration or pack is applied**, so nothing under test has been
touched when it refuses. The run refuses on it: `EXIT_FENCED_FIGURES` is in the exit-code block, exit 1 is a
figure nothing emits and **exit 2 is the check having matched nothing at all**,
which it must not report as a pass.

Its own red proof is `--selftest`, three hermetic arms (a token nothing emits →
1, an emitted token → 0, no token at all → 2), run by the proof script before
the real scan. **And it was proved against the real defect, not only its
fixtures:** pointed at the documents and harness of `51686d9`, the head round
10 rejected, it reports both occurrences of `superuser_sees=130` by file and
line with exit 1; at `24f6ebe` it reports 6 candidate tokens, 0 not emitted,
exit 0. What it does NOT cover is named in the file: prose, UPPERCASE
assignments, a token inside a longer line, outcome transcripts of the shape
`-> rc=0`, and the arm's second direction — whether an emitted figure is a
quantity the moment decides, which is not mechanisable and stays a rule.

`check_fenced_figures.py` **joins the `HARNESS_SHA256` set** in the same
commit, because an instrument a run refuses on is part of what the run must
pin. That digest therefore moves here, by design, and a round is owed on this
SHA.

**Carried from the coordinator, for anyone reproducing a digest:**
`HARNESS_SHA256` is `cat $(ls <files>) | sha256sum`, and **`ls` sorts its
arguments**, so the bytes hashed are alphabetical, not the order the script
lists them. Concatenating as written gives a different number — a reader's
artefact, not a tree mismatch. The note is on the digest rows in §6 here and
in `P11-LIVE-DDL-PROOF.md` §1.

**A TWELFTH round is owed** narrow on `24f6ebe..HEAD`. Nothing here is
self-signed.

---

## 7.12 The TWELFTH round — **`PASS-WITH-SCOPE`** at `321e84c`: the instrument is real, and its net was thinner than its own header admitted

Narrow on `24f6ebe..321e84c`. Frozen at
`/mnt/project-files/phase11/P11-CHALLENGE-321e84c.md`, sha256
`bf5b1088077a5ca05b835cc5cf913fa40029d8ab29b5f1e6f64f806f06f3badc`, 198 lines /
10,999 bytes.

The challenger ran a full round rather than carrying anything forward, because
the moved `HARNESS_SHA256` is exactly the case its round-11 signature named as
voiding it. It recomputed the digest to `2aa31de7…`, reproduced every claim made
for the checker, and **defeated the wiring rather than reading it**: on its own
copy with one fabricated figure planted, the real script printed the finding
and `Refusing to run`, with no `=== 1.` line in the log.

**`R12-S1` (`P3`), five shapes, one control.** The same fabricated token each
time; only its position changed. A backtick fence was caught (the control).
Not seen: a `~~~` tilde fence; a four-space indented block; a block downstream
of an earlier UNCLOSED fence, where `inside = not inside` flipped parity while
the candidate count stayed plausible; markdown in a subdirectory, because the
scan was `os.listdir` of the phase directory; and — the one that mattered — a
figure written into `harness/mutations/README.md`, a real file that was
**outside the scan AND inside the haystack**, so it could hide a fabricated
figure and legitimise the identical token in a document that *was* scanned.
A document used as an instrument is the exact thing this check exists to stop.

**All five are closed here, and not with five patches.** A line that is nothing
but `key=value` is output-shaped **wherever it sits**, so the fence parsing is
deleted and every escape from it goes with it; the walk now covers `**/*.md`
under the phase directory; and **`.md` is excluded from the haystack**, so no
document can be its own evidence. The selftest is now **nine hermetic arms, one
per shape**, each with its expected exit, run before the real scan — and the
plant was driven through the real script again afterwards, where it is named by
file and line (`harness/mutations/README.md:94`) and the run stops without
reaching the database.

**Two limits are now disclosed in the file rather than closed**, at the
challenger's request: the haystack is a **substring match over one blob**, so a
token emitted anywhere for any reason passes everywhere (`identities=2` printed
by one case legitimises `identities=2` written about another) — narrowing it to
the emitting case is a convention, not a check; and the arm's second direction
stays a rule, because nothing in a token distinguishes a boolean that cannot go
stale from a count true only of an instant.

**AND A DEFECT OF MY OWN, found while re-proving the gate.** §7.11 above and
the checker's own header said it runs at "step 0, before a cluster exists".
**Both halves were false.** `rebuild_and_prove.sh` already had steps `0` and
`0b`, which create and start the scratch cluster, so the new step collided with
their number and ran after the cluster was up. It is renumbered **`0c`** and
the claim is restated as what is measured: it runs before the database is
dropped and recreated, before the roles are bootstrapped and before any
migration or pack is applied, so nothing under test has been touched when it
refuses. It was found by **running** the plant, not by reading the script — a
claim about an instrument, written beside the instrument, where only the
instrument had been checked. That is the same class as the sentence the tenth
round rejected and as the §7.9 sentence the eleventh round recorded as its own
miss, and it is corrected in place with the correction stated.

None of `R12-S1` is a blocker under the stopping rule, and the challenger said
so.

**BUT `321e84c` CARRIES NO SIGNATURE, AND THAT IS BECAUSE OF THE SENTENCE
ABOVE, NOT BECAUSE OF THE SCOPE.** The step-0 claim is a **false measured
claim**, which is the one thing this phase's stopping rule blocks on, so the
coordinator ruled **`NO-SIGN` on `321e84c`** and stopped its diff review of
that head, there being nothing left for it to decide. **`24f6ebe` remains the
last fully signed head of this phase.** The challenger's `PASS-WITH-SCOPE`
stands as its own verdict on the instrument and the figures, both of which
reproduce; it is the documentation that was false, and a head whose documents
carry a false measured claim does not get signed here even when its instrument
is sound. Round 10 was rejected on exactly this shape, and the rule holds when
the sentence is the author's own.

The measurement that settled it, **with the command corrected — the version
first printed here was wrong, and `R13-F1` of the thirteenth round rejected the
head for it.** The command as quoted was
`git show 321e84c:…/rebuild_and_prove.sh | grep -n '^echo "=== 0'`, and that
returns **ONE** line, line 80: the two cluster lines are **indented** inside
the `if [ ! -d "$S/data" ]` block, so the `^echo` anchor excludes precisely the
two lines the sentence enumerated. The evidence as written excluded its own
point. Unanchored it reads correctly:

    git show 321e84c:prep/phase11/harness/rebuild_and_prove.sh | grep -n '=== 0'
    35:  echo "=== 0. creating the scratch cluster at $S on en_US.utf8 ==="
    42:  echo "=== 0b. starting the cluster (it is reaped between turns in this container) ==="
    80:echo "=== 0. the documents' fenced figures (every quoted key=value must be emitted by something) ==="

**One line anchored, three unanchored**, and the substance the `NO-SIGN` rests
on is in the three: lines 35 and 42 create and start the cluster, and line 80
is this check's colliding `0`. The second half of the measurement stands as
written — a plant driven through the real script with `P11_REPO` pointed at a
clone shows the refusal happening after those two steps, which the thirteenth
round reproduced on its own clone.

**This commit is a new SHA and carries no signature either**, and a thirteenth
round is owed narrow on `321e84c..HEAD`, with the coordinator reviewing the same
range after it.

---

## 7.13 The THIRTEENTH round — `REJECT` at `cb19811` on one sentence, and the checker redesigned a third time

Frozen at `/mnt/project-files/phase11/P11-CHALLENGE-cb19811.md`, sha256
`1bacc58fcf7bf6ee566bb421cb1f1678cb8b5b6356f100897008d21607f73159`, 413 lines /
19,487 bytes. Everything else in `cb19811` reproduced, on a fresh
`git clone --no-hardlinks` with `P11_REPO` pointed at it: the clean suite, the
nine arms, the plant naming `harness/mutations/README.md:94` with zero
`=== 1.` lines, and every digest.

**`R13-F1` (BLOCKER) — the cited command excluded its own point.** §7.12 above
is corrected in place, with both forms and the real output. One line anchored,
three unanchored. The substance of the `NO-SIGN` is untouched; what was wrong
was the evidence offered for it, which is the same class as `R10-F1`, as the
§7.9 sentence, and as the step-0 sentence this very commit exists to correct.
**Three of the last four rounds have turned on a sentence about an instrument
rather than on an instrument**, and the cure is the one this round demonstrates
again: run the command you are about to quote, and paste what it prints.

**`R13-S1` (`P2`) — an unmeasured guard that opened an escape.** The previous
design skipped any line containing a backtick. The challenger deleted it: **no
arm red and the real tree was byte-identical**, so the guard was unmeasured;
the arm that read as covering it passed for an independent reason; and it
opened `N16` — a figure followed by a backticked `--` comment passed, in the
wrong direction. It is **deleted**, replaced by stripping **inline code spans**
before matching, which is narrower, keeps the named exclusion the §16.6
withdrawal note depends on, and **is measured**: deleting the strip reds `N16`
and nothing else.

**`R13-S2` (`P3`) — eleven escapes, all from the LINE ANCHOR.** Blockquote,
list item, bold, parentheses, trailing comma, semicolon, period, percent,
thousands separator, HTML comment, colon prefix, table cell. A list item is the
most idiomatic way these documents write a figure, and the repo's own gate
table writes `4,798`.

**`R13-S3` (`P3`) — the price of the previous design, measured: 7 of 14
realistic prose shapes red the gate.** `kind=refusal` and `role=postgres` are
`proofs.py`'s own `case()` parameters, so a future paragraph explaining the
harness would have stopped every proof in the phase. Fail-closed, so a cost
rather than a hole — but a cost that stops the work.

**BOTH DIRECTIONS ARE CLOSED BY ONE CHANGE, NOT BY ELEVEN PATCHES.** Patching
eleven prefixes would leave a twelfth, exactly as patching four fence syntaxes
left a fifth. So the design changes what a candidate **is**: the arm is about
FIGURES, and a figure is **a number or a boolean**. The value must now be
`[0-9][0-9,._]*` or `true`/`false`, and everything around the token is markdown
decoration that is stripped before matching. The eleven escapes are caught
because decoration no longer matters; the seven false positives stop being
candidates because `postgres`, `refusal`, `heads/main`, `catalog.foo_invalid`,
`PATCH-REQ-P8-08`, `agreement` and `/var/tmp/myclone` are not figures. And
`locale=en_US.utf8`, which the round got to PASS through the substring
weakness, is not a candidate either.

**WITHDRAWN IN ROUND 14, AND THE WITHDRAWAL IS THE POINT OF §7.14.** The
paragraph and table that follow claimed that EVERY guard in the matcher had
been deleted on its own and the arms it reds recorded, and closed with "no
guard reds nothing". That was **false of the matcher it described**:
`figure_on()` applied **fourteen** guards, the heading strip and the trailing
`--` strip among them, and those two were in no row and had never been deleted.
The twelve rows below each reproduce, row for row, and the challenger
re-measured them; what was wrong was the claim OVER the guards, which is the
previous round's finding one level up. The claim is not repaired here, because
a hand-written table cannot carry it: §7.14 replaces it with a table the
instrument computes. The rows below stand as the round-13 record only.

Each of these twelve was deleted on its own and the arms it reds recorded:

| guard deleted | arms that go red |
|---|---|
| inline code-span strip | `N16` backticked comment |
| blockquote / indent strip | blockquote, nested list item |
| list-marker strip | list item, nested list item |
| table-cell strip | table cell |
| bracket strip | parentheses |
| emphasis strip (leading) | bold |
| colon-label strip | colon prefix |
| trailing-punctuation strip | percent, trailing semicolon, parentheses |
| emphasis strip (trailing) | bold |
| trailing-pipe strip | table cell |
| HTML-comment strip | HTML comment |
| **the figure value class** | **all seven `R13-S3` false positives** |

The selftest at that head carried an arm for every shape either round planted, for the named exclusions, and for the seven
false positives that must now come back clean. **The counts are not written here**, and that is deliberate: a hand-written arm count in prose is the defect `R16-A1` names, and the live numbers are in the generated block of §7.14. The skip arms land on
exit **2** — no candidate at all — which is the inert refusal doing double duty
as the negative assertion.

**The challenger's own two corrections are recorded as its, not mine.** It
withdrew its round-12 sentence that the planted run "stopped at step 0 before a
cluster was touched" — false for the same reason mine was, inferred from the
absence of a `=== 1.` line, which bounds the wrong thing — and noted that its
round-12 plant ran on copied subtrees, so its evidence carried
`fatal: not a git repository` and an empty `SOURCE_SHA`. It found its own
version of the defect it had rejected me for, while rejecting me for it.

**Still disclosed, not closed:** the haystack is a substring match over one
blob; a non-numeric, non-boolean value shown as output is deliberately not a
candidate, which is the price of `R13-S3`; and the arm's second direction stays
a rule. `E4b`'s geometry note is accepted and written into the selftest: it
measures the haystack half, `E4a` measures the scan half, and the real tree's
one-file-in-both-roles geometry is exercised by the plant through the script.

**THE HISTORICAL RED PROOF WAS RE-RUN UNDER THE THIRD DESIGN, not inherited
from the first.** A redesigned instrument carries none of its predecessor's
evidence, so `prep/phase11` was exported from `51686d9` — the head round 10
rejected — the new matcher dropped in beside it, and the scan run from that
tree. It still names both occurrences by file and line and still exits 1:

```text
quoted figures: 9 documents, 6 candidate figures, 2 not emitted
  NOT EMITTED: P11-LIVE-DDL-PROOF.md:2234 reports `superuser_sees=130`, and no instrument or committed evidence file under the harness emits that string. ...
  NOT EMITTED: P11-MIGRATION-PATCH-REQUEST.md:746 reports `superuser_sees=130`, and no instrument or committed evidence file under the harness emits that string. ...
rc=1
```

At this head the same instrument reports `9 documents, 6 candidate figures, 0
not emitted` with `rc` 0, and the no-`-I` guard returns 4. The run is
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND13.txt`, run
`p11-20261019T081906Z-340`: Pack A 121 ×2 and Pack B 53 ×2 with 0 failed, 13
races with 0 findings, 80 frozen entries and 0 digest mismatches, every `EXIT_*`
0 including `EXIT_FENCED_FIGURES` at step `0c`, on PostgreSQL 16.15 at
`en_US.utf8`. That run's tree was dirty, because the evidence of a commit
cannot be committed before it; the clean-tree re-run at the pushed SHA is
published beside it.

**Round 14 ran and REJECTED this head**; see §7.14.

---

## 7.14 The FOURTEENTH round — `REJECT` at `3bce189`, and the completeness claim becomes an instrument

Frozen at `/mnt/project-files/phase11/P11-CHALLENGE-3bce189.md`, sha256
`d15315e19cb3b115d17c02c24c040602fefa873e3f08611fafa1bff90868c98b`, 404 lines /
19,973 bytes. Everything in `3bce189` reproduced on a fresh clone with
`P11_REPO` set — every digest with `ls` sorting, all three published evidence
files matching their claimed sha256 and line count, the 37 selftest arms, and
the historical re-run over `51686d9` **byte for byte** what §7.13 pastes.

**`R14-F1` (BLOCKER) — the claim over the guards had no red proof.** §7.13
said, in bold, that every guard in the matcher had been deleted on its own and
the arms it reds recorded, then gave twelve rows and closed with "no guard reds
nothing". `figure_on()` applied **fourteen**. The two missing ones were the
heading strip and the trailing `--` strip, and neither is dead code: measured
against a control the deletion does not move, each alone decides a shape that
is otherwise invisible. Delete either and the selftest still passed, the real
tree was unchanged, and the next round's escape was already written. The
challenger derived the guard list **from the code** where I had derived it from
my own table — which is §7.13's own new rule, run the thing you are about to
describe, applied one argument too narrowly: the thing to run was the guard
list.

**THE DISCHARGE IS NOT TWO ROWS.** A hand-written table cannot carry a claim
about the code it describes, because nothing reds when the two drift apart, and
that is exactly what happened. So:

1. `GUARDS` in `check_fenced_figures.py` is now **the authority**:
   `figure_on()` applies exactly the guards named in it.
2. `--selftest` **deletes each one in turn** and reports which arms stop giving
   their required answer. A guard that flips no arm **fails the selftest**,
   which the proof script refuses on — so a guard added without an arm stops
   the phase instead of silently widening the net.
3. The table below is **computed by that run**, not typed. The row count cannot
   disagree with the guard count because there are no rows.
4. And because the matrix can only prove every NAMED guard load-bearing, an
   **identity test** proves there is no unnamed one: every transformation sits
   behind a named guard, so with all of them skipped the stripper must be the
   **identity**. It is checked over 16 probe lines and 6 shapes. An
   unconditional transformation — a case fold, a strip, a rule added in a
   hurry — comes back as a difference.

**AND THAT CLAIM IS RUN, NOT ASSERTED,** because a counterfactual about an
instrument is still a claim about an instrument. §7.13's twelve rows are kept
in the file as a negative control, and the selftest skips exactly those twelve
and prints what the stripper still does:

```text
  control: with ONLY §7.13's twelve rows skipped, '### fabricated_count=999' still becomes 'fabricated_count=999' -- the two guards that table never named
  control: with ONLY §7.13's twelve rows skipped, 'fabricated_count=999 -- a plain comment' still becomes 'fabricated_count=999' -- the two guards that table never named
```

So the mechanism **does** catch `R14-F1`, demonstrated on the very table that
missed it, and it reds if a later head renames those two guards out of
existence.

**MY OWN INSTRUMENT THEN FOUND TWO THINGS IN ME**, which is the only evidence
worth having that it is an instrument. The matrix reported that a guard I had
just written — the final whitespace strip — **reds nothing**, because the
leading and trailing strippers already cover it; by this phase's own rule an
unmeasured guard goes, so it is **deleted**. And the identity test rejected one
of my probe shapes: with `nfkc` skipped a full-width separator is not an `=`,
so refusing that shape was correct and my expectation was wrong. The instrument
was right twice and I was wrong twice, before the round.

<!-- BEGIN GENERATED guard-matrix: python3 -I prep/phase11/harness/check_fenced_figures.py --emit guard-matrix -->

```text
each guard deleted on its own, and the arms that stop answering:

nfkc                       reds  1 arm(s): R14-S1 full-width equals
format characters          reds  1 arm(s): R14-S1 zero-width space
non-ascii digits           reds  5 arm(s): R14-S1 arabic-indic digits, R14-S1 extended arabic digits, R15-S3 devanagari digits +2 more
html comment markers       reds  1 arm(s): R13 HTML comment
inline code span           reds  1 arm(s): R13-S1 N16 backticked comment
blockquote and indent      reds  8 arm(s): R13 leading tab, R13 blockquote, R13 nested list item +5 more
list marker                reds  2 arm(s): R13 list item, R13 nested list item
heading marker             reds  1 arm(s): R14-F1 heading
table cell (leading)       reds  1 arm(s): R13 table cell
bracket                    reds  2 arm(s): R13 parentheses, R14-S3 percent inside brackets
emphasis (leading)         reds  1 arm(s): R13 bold
dash marker splits the line reds  4 arm(s): R14-F1 plain -- comment, R14-S1 behind a -- marker, R15-S2 text before the marker +1 more
label prefix               reds  1 arm(s): R13 colon prefix
trailing punctuation       reds  7 arm(s): R13 trailing semicolon, R13 parentheses, R13 HTML comment +4 more
emphasis (trailing)        reds  1 arm(s): R13 bold
table cell (trailing)      reds  1 arm(s): R13 table cell
figure value class         reds  8 arm(s): R13-S3 p11_repo=/var/tmp/myclone, R13-S3 ref=heads/main, R13-S3 expect=catalog.foo_invalid +5 more
boolean spellings          reds  2 arm(s): R14-S1 boolean t as psql prints, R14-S1 boolean f as psql prints
signed values              reds  2 arm(s): R14-S1 negative, R14-S1 positive sign
percent in the value       reds  3 arm(s): R13 percent, R14-S3 percent on a real figure, R14-S3 percent inside brackets
hyphen in the key          reds  1 arm(s): R14-S1 hyphen in the key
key class                  reds  1 arm(s): named: UPPERCASE key
boolean case folding       reds  1 arm(s): R14-S1 boolean True
named exemptions           reds  2 arm(s): R14-S2 exempt port=55512, R14-S2 exempt migrations=87
planted tokens             reds  1 arm(s): R15-S4 a planted token is not its own evidence
haystack from the commit   reds 17 arm(s): R16-F1 an untracked scratch file is not evidence, R16-F1 a gitignored .pyc is not evidence, R16-F1 a directory that is no repository is refused +14 more
no repository redirects the subject reds 10 arm(s): R17 a repository planted inside the haystack is refused, R18-F1 planted at the harness, run from the repository root, R18-F1 planted at the harness, run from the harness directory +7 more
markdown is not evidence   reds  1 arm(s): R12 E4b a doc is not its own evidence
the checker is not its own evidence reds  1 arm(s): R16-F1 the checker is not its own evidence

29 guards, every one of them deleted and measured
```

<!-- END GENERATED guard-matrix -->

**`R14-S1` (`P2`) — nine spellings, and NORMALISATION rather than nine
patches.** A fabricated row count in Arabic-Indic digits, a negative, an
explicit positive sign, `True`, `t`, a figure behind a `--` marker, a hyphen in
the key, a zero-width space before the value, and a full-width `＝`. The
sharpest were `t` and `True`, because the class CLAIMED booleans and admitted
one spelling of two, and **`t`/`f` is what `psql` prints**, which is what these
documents transcribe. The Arabic-Indic form is sharper still in consequence:
**that is the spelling the owner's own report uses for every figure he reads.**
The challenger drove it to the end — three fabricated figures planted in the
Arabic report produced a complete green proof run of this phase, with
`EXIT_SCRIPT` 0. On the coordinator's ruling the answer is one change at one
place, in four steps, each separately deletable and each with the challenger's
own plant as its arm: **NFKC**, then **delete format characters** (category
`Cf`, where U+200B lives, which NFKC does not remove), then **map Arabic-Indic
and Extended Arabic-Indic digits to ASCII** (which NFKC also does not do:
U+0669 has no compatibility decomposition), then **the boolean set, closed and
named**: `true`, `false`, `t`, `f`, in any case.

**This is the same cause as Phase 6's open `P1` `G-A`**, where a mistyped key,
U+200B and U+FF1A are all accepted. Two phases, one cause; the coordinator has
ruled once for both, and `OD-P6-09` stays with the owner. Raised, not solved
twice.

**`R14-S2` (`P3`) — the price moved rather than shrank, and it is now measured
by a command.** Narrowing the value narrowed the key space while widening the
context widened it back, so every numeric assignment in any decoration in any
document is a candidate: the round measured 13 of 16 realistic shapes redding
the gate, against 7 of 14 for the previous design. `--surface` now measures it
over a documented list against the REAL haystack and prints the count, so the
number in the header is reproducible rather than asserted:

    python3 -I prep/phase11/harness/check_fenced_figures.py --surface

The count is **generated into this document by the run**, not written here;
round 15's `R15-F1` is why, and §7.15 gives the reason the number was wrong.
The challenger's list of 16 is not this list, so those numbers are each true of
their own set and are not comparable.

<!-- BEGIN GENERATED surface: python3 -I prep/phase11/harness/check_fenced_figures.py --emit surface -->

```text
port=55512           not a candidate (exempted or not a figure)
migrations=87        not a candidate (exempted or not a figure)
rows=59              REDS THE GATE
axes=2               passes: something emits it
variants=6           REDS THE GATE
cases=121            REDS THE GATE
races=13             REDS THE GATE
entries=80           REDS THE GATE
copies=1             REDS THE GATE
attempts=3           REDS THE GATE
deleted=0            passes: something emits it
present=true         passes: something emits it
owner_sees=0         passes: something emits it
chosen=1             passes: something emits it
identities=2         passes: something emits it
ratio=0.5            REDS THE GATE
enabled=false        REDS THE GATE

9 of 17 realistic figure-shaped lines would red the gate if a document wrote them
```

<!-- END GENERATED surface --> On the coordinator's ruling the two
tokens exempted **by exact name** are this phase's own scratch port and its own
migration count. That exemption is a SHAPE fix and it carries the known cost of
one: **it cannot name a token not yet written, and a fabricated migration count
now passes.** It is two literals, it sits in `EXEMPT` where a reader finds it,
and deleting it reds an arm. No waiver list beyond those two, because an
enumerated exemption moves the hole from shape to time.

**`R14-S3` (`P3`) — the figure checked must be the figure shown.** The trailing
punctuation stripper took the percent sign with it, so a zero written as a
percentage was verified against the bare zero and passed on a figure nothing
emits; and because the haystack is a substring blob, that reached any
percentage whose bare figure appears anywhere. The percent sign is no longer
stripped and is part of the value, so the token checked is the token shown. The
remaining stripping is not total, and the bound is the one the round stated: a
figure with a trailing period still passes on the bare figure, a period being a
sentence ending, while the same figure with a thousands separator added reds.

**Still disclosed, not closed:** the haystack is a substring match over one
blob; a non-numeric, non-boolean value shown as output is deliberately not a
candidate; the two exempted literals; and the arm's second direction stays a
rule rather than an instrument.

**EVIDENCE AT THIS HEAD.** The run is
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND14.txt`, run
`p11-20261019T085632Z-24702`: Pack A 121 ×2 and Pack B 53 ×2 with 0 failed, 13
races with 0 findings, 80 frozen entries and 0 digest mismatches, every `EXIT_*`
0 including `EXIT_FENCED_FIGURES` at step `0c`, on PostgreSQL 16.15 at
`en_US.utf8` with both roles `NOSUPERUSER NOBYPASSRLS`. The harness digest moves
to `3a16daab…`; the pack digests do not move. That run's tree was dirty,
because the evidence of a commit cannot be committed before it; the clean-tree
re-run at the pushed SHA is published beside it. **The historical red proof was
re-run again under this fourth design** — a redesigned instrument inherits none
of its predecessor's evidence — and `51686d9` still names both occurrences of
the fabricated figure and exits 1.

**AND THE ROUND'S OWN ESCAPE IS REPRODUCED AS A COMMITTED BASELINE, which is
the stronger half of this evidence.** Before the fix, on `3bce189`, the
challenger's three plants driven through the real script on a clone produce a
**complete green proof run of this phase**: `EXIT_FENCED_FIGURES` 0,
`EXIT_SCRIPT` 0, step `0c` reporting 7 candidate figures and 0 not emitted
while three fabricated figures sat in the Arabic report. That log is committed
as `RUN-EVIDENCE-R14-S1-BASELINE-GREEN-WITH-THREE-FABRICATED-FIGURES.txt`, and
it contains none of the planted tokens, so committing it into the haystack
cannot legitimise them. The same three, driven the same way at this head, are
named and refused. A fixture proves a check can fail; the head that was green
with the defect in it proves this check fails on the thing it was rebuilt for.

**A FIFTEENTH round is owed** narrow on `3bce189..HEAD`, with the coordinator
diff review after it. **`24f6ebe` is still the last fully signed head**, and
nothing in this phase is self-signed.

---

## 7.15 The FIFTEENTH round — `REJECT` at `3838711` on one number, whose cause was a fail-open and not a typo

Frozen at `/mnt/project-files/phase11/P11-CHALLENGE-3838711.md`, sha256
`705965c0f828418017b6315248e7d53df3c6a7e4de109e39e6041a41c957437d`, 378 lines /
17,731 bytes. Everything else reproduced: every digest with `ls` sorting, all
six published evidence files matching their claimed sha256 and line counts, the
published checker byte-identical to the committed one, the computed guard
matrix re-run guard by guard, both negative-control lines printing exactly as
pasted, and eight of the nine spelling escapes closed — verified against a
token that appears nowhere in the tree, which matters below.

**`R15-F1` (BLOCKER) — the documents said 8 of 17 and the command prints 9 of
17.** The challenger ran it three ways to rule out its own copy: a pristine
checkout, a scratch copy, and an independent `git clone --no-hardlinks` at the
full SHA. All three printed 9. The sentence beside the command claimed the
number was "reproducible rather than asserted", and it was not.

**AND THE CAUSE WAS NOT A RETYPED NUMBER.** That matters, because the fix for a
retyped number is care and the fix for this is code. The number was measured —
on this tree, where `prep/phase11/harness/__pycache__/check_fenced_figures.cpython-313.pyc`
was sitting, **gitignored, so invisible to `git status`**. A `.pyc` carries its
module's string constants, so that file re-admitted **this checker's own prose**
into the haystack, including the token `rows=59` which the header quotes as an
example of a moment-dependent figure. The scan excludes the checker by name,
for exactly that reason — "a token quoted in this file's own prose proves
nothing" — and **the bytecode cache defeated the exclusion.** Measured both
ways on the committed tree: with the cache present, 8; with it removed, 9,
which is what three clean checkouts say.

**So this is a fail-open, and the more serious half of the finding.** The
gate's verdict depended on whether anyone had ever imported the module, and a
figure that reds for every reader passed for its author. `haystack_files()`
now excludes `__pycache__`, `.pyc`/`.pyo`/`.so`/`.o`, and this file by **stem**
rather than by basename, and the run prints the haystack's inventory so the
verdict names its own input. A number generated into the document would not
have caught this on its own: generation on this tree would have written 8.

**THE COORDINATOR'S RULING, IMPLEMENTED: a figure this instrument produces is
GENERATED INTO the document, or it is not written at all.** Each sits between
markers naming the generator and its command; `--regenerate` rewrites the
blocks; `--check-blocks` refuses if a block differs from a fresh run **or if
the generator's own sentence appears anywhere outside its block**; and the
proof script runs it at step `0c` beside the figure scan, reporting
`EXIT_GENERATED_BLOCKS`. Typing one of these numbers is now impossible rather
than discouraged, which is the only form of the rule that survives six rounds.
The counts in this section and the two blocks in §7.14 are generated:

<!-- BEGIN GENERATED arm-counts: python3 -I prep/phase11/harness/check_fenced_figures.py --emit arm-counts -->

```text
40 catch arms, 15 skip arms, 2 pass arms, 24 others
```

<!-- END GENERATED arm-counts -->

**What is enrolled, exactly**, because a net is read as covering the variants of
what it names: the three figures **this** instrument produces — the guard
matrix, the arm counts, the false-positive surface. The other instruments'
figures (`121 cases`, the race counts, the digests) are not enrolled; they are
pinned by the committed run evidence, and enrolling them is a change to those
instruments rather than to this one. **Two bounds are disclosed rather than
hidden:** a figure describing a PAST head cannot be generated by the present
instrument at all, so §7.13's historical counts stay in prose, pinned by that
head's committed evidence; and the enrolment check matches the generators' own
English sentences, so the Arabic report must not quote these figures
numerically, and §٢ش points at this block instead of restating it.

**`R15-S1` (`P2`) — the identity test was bounded by sixteen hand-written
lines, which is a hand-written completeness claim again.** The challenger added
ten unconditional transformations to `_strip`, one per copy. Two were caught; **eight
hid**: single quotes, double quotes, `+`, Devanagari digits, an en dash, a
curly apostrophe, a non-breaking space, and `s.replace(";", "")` — which came
back as no difference at all, because no probe line contains a semicolon. A
negative result from an attack set proves only the set, and that is this
project's own rule.

So the claim is no longer bounded by a list of lines. **The transformer's own
source is parsed**, and every statement that rebinds the subject must sit
inside an `if "<name>" not in skip:` branch; the only exception is the first
statement, which binds the subject to the untransformed input and is checked to
be exactly that. All ten planted transformations are refused. **The keys the
parse finds are compared with the string constants of the compiled function**,
so a source file that has drifted from what is running is a failure and not a
pass — deriving a subject set from a representation the subject can alter is a
mistake this phase has already made once.

**That check immediately rejected my own `_strip`.** Its leading and trailing
strippers were a loop over a table of (name, pattern) pairs, so the guard name
was a variable and the parse could not read it. **An indirection the parse
cannot see is an indirection something can hide in**, so they are written out
one statement per guard with the name as a literal, and the tables are gone.
**Its own bound, stated:** this proves every transformation is behind a NAMED
branch. It does not prove the name is the RIGHT one — a transformation
smuggled into an existing guard's branch is guarded, and nothing here compares
a transformation to the arm that is supposed to measure it. `PROVENANCE` is the
half of that which is mechanisable.

**`R15-S2` (`P2`) — the one structural gap the computed matrix could not see.**
The matrix reported the dash-marker guard measured, and it was: the arm named
for the finding flipped when the guard went. But the arm carried `-- figure`
with the marker first, while the finding was about `note -- figure` with text
BEFORE it — and that still escaped, because the comment strip **deleted** from
the marker to the end of the line, revealing a figure in the leading form and
deleting one in the trailing form. The matrix proves every guard load-bearing
and no guard unnamed; **nothing in it compares an arm to the finding it is
named for.**

The deletion is replaced by a **split**: a `--` marker splits the line and
whatever sits on either side is weighed on its own, which cannot be asymmetric.
And each arm that names a round's finding now records that finding's own quoted
line, with the selftest asserting the arm's body IS that line; an arm whose
label names a finding with no provenance entry **fails**. Where a finding
described a shape rather than quoting a line, the entry says so, so the gap is
visible rather than absent.

**`R15-S3` (`P3`) — Devanagari, Bengali and Thai digits escaped**, and naming
three more families would have left a fourth. `unicodedata.digit` answers for
every character Unicode calls a decimal digit, so the guard covers the category
and the three named families are arms rather than branches.

**`R15-S4` (`P3`), and the challenger's own near-miss, recorded as its.** The
run log committed by the previous commit contains the selftest's output, which
contains `fabricated_count=999` — the token every round has used for its
fabricated figure — so from that commit the token passed in any document. The
challenger's first attempt at two of its arms used that key, came back clean,
and it was one step from reporting two escapes that were not there; it caught
itself by reading what the stripper returned instead of trusting the exit code,
re-ran the battery against a token nothing emits, and reported the near-miss
rather than fixing it quietly. **A planted token is now never evidence of
itself**, derived by running the matcher over the arm bodies rather than by
keeping a second list beside them. The coordinator's ruling says to exclude the
selftest output by exact name; excluding the whole run log by filename would
throw away the real evidence in it, so the exclusion is by exact TOKEN name,
which is what the arms plant and all they plant.

**Also settled:** the `__pycache__` the challenger saw in its own haystack was
not its artefact alone, and it is now excluded for both of us.

**Still disclosed, not closed:** the substring haystack; a non-numeric,
non-boolean value shown as output is deliberately not a candidate; the two
exempted literals; the enrolment and historical bounds named above; a
transformation smuggled into an existing guard's branch; and the arm's second
direction stays a rule.

**EVIDENCE AT THIS HEAD.** The run is
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND15.txt`, run
`p11-20261019T093455Z-568`: Pack A 121 ×2 and Pack B 53 ×2 with 0 failed, 13
races with 0 findings, 80 frozen entries and 0 digest mismatches, every
`EXIT_*` 0 — including the new `EXIT_GENERATED_BLOCKS` beside
`EXIT_FENCED_FIGURES` at step `0c` — on PostgreSQL 16.15 at `en_US.utf8` with
both roles `NOSUPERUSER NOBYPASSRLS`. The harness digest moves to
`be61730f…`; the pack digests do not move. That run's tree was dirty, because
the evidence of a commit cannot be committed before it, and the clean-tree
re-run at the pushed SHA is published beside it. The historical red proof over
`51686d9` was re-run again under this design, and the challenger's own final
plants — a figure behind a marker with text before it, and a Devanagari
figure, which produced a green run with two fabricated figures in the owner's
document at `3838711` — are each named and refused here.

**A SIXTEENTH round was asked for** on `3838711..28659e7` and has been
answered; §7.16 below is that answer. **A SEVENTEENTH round was asked for** on
`28659e7..7bd9c09`, returned `REJECT`, and has been answered: §7.17 is that
answer. **An EIGHTEENTH round was asked for** on `7bd9c09..2dbce28`, returned
`REJECT`, and has been answered: §7.18 is that answer, and a NINETEENTH is owed
on `2dbce28..HEAD` with the coordinator diff review after it. **`24f6ebe` is still the last fully signed head**, and
nothing in this phase is self-signed.

## 7.16 The SIXTEENTH round — `REJECT` at `28659e7`: the haystack was read from the FILESYSTEM, the frame that DECIDES was unparsed, and the enrolment was a SENTINEL

Three findings, and each one is a hole of the same shape as the fix that
preceded it. The round reproduced everything else: the digests with `ls`
sorting, the published checker byte-identical to the committed one, the
computed guard matrix re-run guard by guard, and the four published plant
probes in both directions.

**`R16-F1` (BLOCKER) — "not committed, therefore not in the subject" was
never true, because the haystack was read from the filesystem.** Round 15's
answer excluded `__pycache__`, four compiled suffixes and this file by stem.
The round's objection is the one this phase has already learned once, in `P7`:
**an enumerated exemption fixes a SHAPE hole and opens a TIME hole**, because
no list can name the file nobody has written yet — a `scratch.log`, an editor
backup, a `.orig` from a merge, an archive unpacked in the wrong directory.
The verdict still depended on what happened to be lying in a directory.

**Implemented as ruled: the subject set is DERIVED FROM EXECUTION of git at a
resolved commit, and the content is read FROM THE OBJECT STORE.** `git ls-tree
-r -z --full-tree` at the commit `rev-parse --verify HEAD^{commit}` resolves,
then `git cat-file --batch` for the blobs; a file the commit does not carry
cannot legitimise a figure, whatever it is called, and **the artefact lists are
DELETED rather than extended** — `__pycache__` is out because it is not
committed, not because someone remembered to name it. The read is hardened as
Phase 14 hardened its own local reads, and for the same reason: every `GIT_*`
variable is scrubbed first, because `GIT_DIR` beats `-C`; replace objects are
disabled by flag **and** by environment; grafts point at the null device;
system and global configuration are ignored; `PATH` is pinned starting at
`/usr/bin`; the binary is resolved once from a fixed list of absolute paths.
Shallowness is not refused, and the reason is stated: one commit's tree and
blobs are complete in a shallow clone, which is all this reads, while `P8`'s
ruling is about a shallow graph's definite "no".

**It FAILS CLOSED, and that is measured, not promised.** An absent git, a
directory that is no repository, a commit that does not resolve, or a harness
path the commit does not hold is a **named refusal with its own exit (5)** —
never a silent fall back to the walk this round deleted, because a fallback
would make the whole derivation a preference. The arms: an untracked
`scratch.log` carrying the plant, a **gitignored `__pycache__/*.pyc` carrying
the plant** — round 15's own fail-open, planted deliberately — and a
directory that is no repository, which must refuse. **Deleting the git
derivation reds all three by name**, which is what makes "derived from the
commit" a claim with a red proof rather than a sentence in a header. Two more
haystack guards are now measured the same way: markdown is not evidence (round
12's `E4b`) and the checker is not its own evidence.

**What it costs, stated because it is a real cost.** Content that exists only
in the working tree does not count, so a figure whose evidence is written but
not yet committed REDS until the commit exists. The run therefore prints **the
commit it read** and **every file under the harness that differs from it** —
changed, untracked or ignored — so the one surprise this design can produce
names itself in the output. At this head that list names the gitignored
`.pyc` of `R15-F1` by path, in the ordinary output of the ordinary run, which
is exactly what no run said before.

**And round 17 found what this paragraph did not cover, so the sentence above
is bounded here rather than left standing:** "it fails closed" was measured
over an absent git, a non-repository and an unresolved commit, and **not** over
a repository PLANTED inside the subject, which resolved to a commit nobody was
reviewing and emptied the differs-from-that-commit report at the same time.
That is `R17-F2` in §7.17, and the four assertions that close it are stated
there.

**`R16-S1` (`P2`) — the structural parse covered every transformation and
nothing that DECIDES.** `figures_on` could rebind `line`, or return early
under a test nobody named, and every guard in `_strip` would stay pristine
while the gate decided nothing; the round planted
`line = line.replace(";", "")` one frame up from where the same statement is
refused. **So the decision frame is parsed too** — at that head on TWO rules,
which round 17 then measured insufficient and replaced, as §7.17 states: no
statement rebinds a parameter or a `for` target, and every test — statement or
expression — is a named guard or a call to a function. An inline predicate is
somewhere a narrowing hides; moved into a function of its own it is readable by
the parse and by the guard matrix, which is why the exemption check is now a
function and not a clause. Seven planted decisions are refused — two kinds of
rebinding, a narrowing early return, a silent truncation, an inline predicate
on the value, and a guard with a clause bolted on — and **the unplanted frame
is accepted**, so the parse is not refusing everything and measuring nothing.
`_is_figure` is the shape the arm is about, so the three tests that ARE the
shape are listed by their exact source; **a listed exception is itself a claim
and goes red when the source stops containing it.**

**Its own bound, and round 17 rewrote it.** This paragraph read: *“this proves
the frame takes no decision outside a named guard or a named function”*. That
sentence was **false of the instrument it described**, and false in the
direction that matters: the parse behind it read decisions out of `ast.If` and
`ast.IfExp` and rebindings out of `ast.Assign`, so a reader sent here audited
the named guards and the named calls — and a comprehension filter, a
`try/except/else`, a `match/case`, a boolean index, a walrus and a call to a
helper nothing parses each decided without being read, five of them measured
as taking the real scan from `rc 1` to `rc 0`. **What the parse covers now is
stated in §7.17, as the four rules it is actually written as, together with
what is still outside it.** It still does not prove a named guard's name is
honest — that is what the arms are for.

**`R16-S2` (`P2`) — the enrolment was a sentinel, and round 15's own figure
walked past it reworded by six words.** One regex per generator is a list of
spellings, which is the mistake this file has now made four times in four
designs. **The sentinels are deleted.** A figure is recognised BY AGREEMENT
WITH WHAT `--regenerate` WOULD WRITE: the generator is run, its claim line is
read from its output, and a line outside the blocks that shares both a number
and a word with that line is a restatement — ONE claim per generator at that
head, which is `R17-S2` below, and every row per clause now — — in whatever wording, and in
whatever digit family, because both sides are folded and lower-cased the way
the matcher folds a figure.

**Its price was measured, not estimated, and it is not nothing.** With every
number counted, the pack's own prose redded in seventeen places that restate
nothing: `2`, `3` and `9` carry no subject. With single digits excluded the
rule reds twice on this pack, both times on a long prose line sharing one weak
word with a claim — so **two words of prose were changed and nothing else**:
`would have refused` became `no longer refuse` in the mutation paragraph of the
conservation-laws pack, and `applies every file` became `applies each file` in
the live-DDL proof. Neither touches a figure or a finding. **The bound:** a
restatement sharing neither a multi-digit number nor a long word with the
generator's line still passes. The arms that measured the rule at that head: a correct block
beside other instruments' figures must pass; the claim typed verbatim, the
claim reworded as the round reworded it, the claim reworded in Arabic-Indic
digits, and a block edited by hand must each red. **Round 17 added three more
to that list**, and the count of them all is in the generated block, not here.

**`R16-A1`, found by the author while answering, and recorded because the
challenger would have found it: a figure typed in this instrument's own
header.** The header asserted a `--surface` count at `28659e7` that the
command did not print at that head — the `R15-F1` defect exactly, surviving
in the one file the gate does not read, because the scan and the enrolment read
markdown only. The header no longer states the number at all: it names the
command and points at the generated block. **The structural bound stays open
and is disclosed here:** a figure typed in a non-markdown file is checked by no
instrument of this phase.

**Also fixed, found by my own instruments:** `3 others` was a literal in the
arm-counts generator and in the selftest's own summary line, and round 16 adds
arms that are not in a table. A hand-written count of the arms outside the
tables is the same mistake as a hand-written table, so it is computed from the
list the selftest actually runs — which is why the generated block in §7.15
moves at this head.

**Still disclosed, not closed:** everything §7.15 lists, plus the two bounds
named above. **No signature is claimed here.** This is the author answering;
the round-17 challenge on `28659e7..HEAD` and the coordinator diff review
after it are owed, and `24f6ebe` is still the last fully signed head.

**EVIDENCE AT THE ROUND-16 HEAD (`7bd9c09`).** The run is
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND16.txt`, run
`p11-20261019T103931Z-5324`: Pack A 121 cases twice and Pack B 53 cases twice
with 0 failed, the Pack A races and the Pack B races with 0 findings, 80 frozen
entries and 0 digest mismatches, and **every `EXIT_*` 0** — including
`EXIT_GENERATED_BLOCKS` and `EXIT_FENCED_FIGURES` at step `0c`, which is where
this round's work is exercised — on PostgreSQL 16.15 at `en_US.utf8` with both
roles `NOSUPERUSER NOBYPASSRLS`. The harness digest moves to `d87adcee…`; the
pack digests do not move, and neither does the migrations tree. That run's tree
was dirty, because the evidence of a commit cannot be committed before it, and
the clean-tree re-run at the pushed SHA is published beside it together with
the plant probes for this round: an untracked scratch file, a gitignored `.pyc`,
a directory that is no repository, and the reworded figure. **The one output to
read first** is the scan's own inventory line, which now names the commit it
read and lists every file under the harness that differs from it — the
gitignored `.pyc` of `R15-F1` among them, by path, in an ordinary run.

## 7.17 The SEVENTEENTH round — `REJECT` at `7bd9c09`: a stated bound measured FALSE, and a repository planted inside the subject

Round 16 answered three findings by deleting three wrong ideas. Round 17 did
not attack any of the three designs: it attacked **a sentence written about
one of them**, measured the sentence false, and then walked six decision
shapes through the gap the sentence had papered over. It also found a live
fail-open in the derivation the same head had just introduced. The round
reproduced everything else at this head: the commit-derived haystack in both
directions, the guard-deletion control that restores the fail-open, the
computed guard matrix guard by guard, the digests with `ls` sorting, and the
published checker byte-identical to the committed one.

**`R17-F1` (BLOCKER) — the decision parse's stated bound was false of the
instrument, and false in the direction that misleads.** §7.15 said the parse
*“proves the frame takes no decision outside a named guard or a named
function”*. What the parse actually read was `ast.If`, `ast.IfExp` and
`ast.Assign`. A reader sent to that sentence audits the named guards and the
named calls and never looks anywhere else — so the round planted, in the real
`figures_on`, with a fabricated figure committed in the owner's Arabic report,
a comprehension filter (`ast.comprehension.ifs`, no `ast.If` at all), a
`try/except/else` whose branches carry no test, a `match/case`, a boolean index
(`s = ["", s][not s.startswith("zz_")]`) and a call to a helper beside the
frame. **Five of the six took the real scan from refusing to passing.** The
sixth, a walrus, is a hole in the rebinding rule rather than an escape, because
`ast.NamedExpr` is not an `ast.Assign`.

**The answer is not six more node types to inspect.** This file has now learned
the same lesson on fences, on line anchors, on value spellings, on probe lines,
on artefact name lists and on a decision-shape audit: **patching N escapes of
a wrong idea leaves escape N+1.** So the frame is written in a **CLOSED
SUB-LANGUAGE** and every node type outside it is **refused by type, with its
own name, whether or not anyone thought of it as a way to decide.** A
comprehension, a `match`, a `try`, a `while`, an `assert`, a walrus, a
subscript, a lambda, a dict and a statement-position `and` are all absent from
`FRAME_NODES`, so none of them has to be anticipated: they cannot appear. The
four rules are stated in the checker's own header, which is the authority, and
they are: every node type is in the admitted set, or refused by name at its
line; every decision — the `if` statement and the `if` expression being the
only decision forms the node set admits — is a named guard, a call the frame
admits, or one of the exact sources listed as being the SHAPE a review arm is
about; every call is classified and a call nothing parses is refused; and no
name is bound twice, nor any parameter or `for` target bound at all.
**Seventeen planted decisions are refused and the unplanted frame is
accepted**, so the rules are not refusing everything and measuring nothing.

**`R17-F2` — a repository planted inside the subject redirected the whole
derivation.** The challenger raised this *below* blocker, with its reasoning
on the record so it could be overruled, and **the coordinator overruled it: it
is ranked a blocker here.** `_toplevel` resolved **upward**, so a `git init`
inside the harness directory became the toplevel; the haystack commit, and the
“differs from that commit” report the design leans on to announce itself, then
both came from the redirected repository, and a fabricated figure passed. The
discharge is four assertions, each with its own refusal name: the toplevel is
resolved once from the repository the run was **invoked against** — which round
18 measured false, because it made the answer depend on the operator's working
directory and §7.18 replaces it — the subject
must be a strict subdirectory of it, any `.git` between the toplevel and the
subject or inside the subject is refused, and `HEAD` read from the subject must
equal `HEAD` read from the toplevel. The arm is the challenger's own nested
repository, and its **guard-deletion control is measured by value**: with the
guard deleted the planted repository is accepted and the arm passes, which is
the fail-open restored.

**`R17-S1` (`P2`) — rule 2's own remedy was where to hide.** “Move the
predicate into a function” makes a call permitted, and nothing parsed the
called function. So a call to a function **this file defines** is now descended
into recursively under the same four rules, and a call nothing parses is
refused.

**`R17-S2` (`P2`) — the enrolment compared one line per block, of forty-nine.**
Agreement replaced the sentinel in round 16, but only the first claim of each
generator was compared, so forty-eight rows were enrolled in name only. **Every
row is now compared**, as a structured (subject, claim) pair rather than as a
line of text: a row's figure contradicted by a document is a finding, and a
row's verdict written about a different row's subject is a finding — which is
exactly the plant the round asked for, a shape the row says reds the gate
described as passing because something emits it.

**Its price was measured on this pack, not estimated, and measuring it changed
the rule three times.** Comparing every row naively produced ninety-eight
findings on a pack that restates nothing; reducing a row's claim to what it
actually asserts, and requiring a subject to be NAMED rather than
word-overlapped, left thirty-seven; requiring two words of another row's
verdict rather than one left five. Three of those five were this pack's own
tables: **a table row here is two thousand characters long**, a dozen
sentences inside one cell, so a rule applied to the LINE read a subject named
in one sentence against a verdict word five sentences away. **The comparison is
therefore per clause**, and with that the rule reds nowhere on this pack
outside the two blocks this head regenerates. **No document sentence was
reworded to achieve that.** The bound is named and measured by an arm of its
own: a subject in one clause whose wrong figure sits in the next escapes this
check (`R17-S2-B1`, a `P3` residual), and the arm that records it expects
nothing caught — it is the size of the hole, and it reds the selftest the day
the window changes without this line changing with it.

**Named `P3` residuals, carried rather than closed.** A figure **spelled out in
words** — *thirty guards* — restates a count and is matched by neither the
scan nor the enrolment, both of which read digits. `R17-S3`: a figure typed in
a **non-markdown** file is checked by no instrument of this phase, which is
§7.16's disclosed bound now sized by the round. Both stay open and named; the
coordinator ruled both as residuals rather than blockers.

**Still disclosed, not closed:** everything §7.15 and §7.16 list, plus the
three residuals named above. **No signature is claimed here.** This is the
author answering; the round-18 challenge on `7bd9c09..HEAD` and the coordinator
diff review after it are owed, and **`24f6ebe` is still the last fully signed
head**. `READY_TO_PROMOTE = NO`.

**EVIDENCE AT THE ROUND-17 HEAD (`2dbce28`).** The run is
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND17.txt`, run
`p11-20261019T120040Z-18946`: Pack A 121 cases twice and Pack B 53 cases twice
with 0 failed, the Pack A races and the Pack B races with 0 findings, 80 frozen
entries and 0 digest mismatches, and **every `EXIT_*` 0** — including
`EXIT_GENERATED_BLOCKS` and `EXIT_FENCED_FIGURES` at step `0c`, which is where
this round's work is exercised — on PostgreSQL 16.15 at `en_US.utf8` with both
roles `NOSUPERUSER NOBYPASSRLS`. The harness digest moves to `5c67d5f9…`; the
pack digests do not move, and neither does the migrations tree. That run's tree
was dirty, because the evidence of a commit cannot be committed before it, and
the clean-tree re-run at the pushed SHA is published beside it together with
this round's two gate probes: **the challenger's own planted repository**, in
three directions — the fabricated figure alone must red, the planted
repository must REFUSE by name, and with the one guard deleted the planted
repository is accepted and the figure passes — and **the six decision shapes
driven through the real `figures_on`**, one at a time, in a clean clone, each
refused by name, with the unplanted file accepted as the control.

## 7.18 The EIGHTEENTH round — `REJECT` at `2dbce28`: the planted repository was closed AT the harness and open ONE LEVEL ABOVE

The round confirmed that `R17-S2` is fully closed — all three plants that
walked through at `7bd9c09` red here, including `rows=59 passes`, which is
`R15-F1`'s own shape written into a document — and that the closed sub-language
turned back four of its five frame plants. Then it defeated this instrument in
the same place twice: **a sentence I wrote about a guard, and a position one
directory outside the arm I built for it.**

**`R18-F1` (BLOCKER) — the anchor depended on the operator's working
directory.** §7.17 said the toplevel is "resolved once from the repository the
run was invoked against", and the checker's own docstring said it is "resolved
so a PLANTED repository cannot become it". It became it. `_subject_top`
anchored on `cwd` when the subject lay inside `cwd`, resolved the toplevel from
there, and then searched for a stray `.git` **from that toplevel down to the
subject** — so when the plant IS the toplevel there is nothing "between" it and
the subject, the subject is a strict subdirectory of it, and its `HEAD` agrees
with itself. All assertions passed. The round planted at `prep/phase11`, one
level above the harness, with the fabricated figure committed and the tree
clean: refused from the repository root, and **`rc 0` with `0 not emitted` when
run from the harness directory** — which is how the file is most naturally run,
and how the challenger had run it in every round since the thirteenth.

**Implemented as the coordinator ruled, and the working directory is now in
none of it.** The anchor is a CENSUS: every ancestor of the haystack up to `/`,
and the haystack itself, is examined for a `.git` entry — a directory, or the
file a worktree leaves. **None** is `GIT-NO-REPOSITORY`. **More than one** is
`GIT-NESTED-REPO`, and the refusal lists them all, because two repositories
contain the haystack, one of them is a plant, and **choosing between them is
exactly what let the subject pick the commit it was judged against**. The one
that is left must contain the subject strictly, hold no `.git` anywhere inside
the subject — the one position a census of ancestors cannot reach — and its
`HEAD` must equal `HEAD` resolved from the subject. The old downward walk is
deleted rather than kept beside the census: every directory it looked at is an
ancestor, so the census refuses there by name already.

**Measured at three positions and from three working directories**, because a
position is not a measurement unless the seat it is measured from is one of
several: a plant at the harness, one level above and two levels above, each run
from the repository root, from the harness directory and from a sibling that is
no ancestor of it, plus the unplanted control, whose figure is emitted by
nothing and must red. Deleting the one guard turns every planted position into
a pass, and the guard matrix reports that by arm name.

**`R18-S1` (`P1`) — the sub-language was closed over node TYPES and open over
which MODULE CALLS may decide.** `if re.match("zz_", s): continue` in the real
`figures_on` passed everything: selftest, `--check-blocks`, the scan, and the
frame parse was silent. **This was not a contradiction of the four rules; it is
what rule 2 and rule 3 say together** — rule 2 admits "a call the frame
admits", rule 3 admits an attribute call on a module in `FRAME_MODULES`, and
`re` is one. It could not be banned outright either, because `_is_figure`
decides on `re.fullmatch` legitimately, inside the `key class` guard the matrix
measures. **So the pairs that may decide are NAMED**, per function, in
`DECIDING_MODULE_CALLS`; every other attribute call in a test position is
refused by name; and each entry is checked to be live, for the reason
`FRAME_METHODS` is — a permissive entry nothing uses only widens the language.
The round's own plant is an arm. **What made this a `P1` rather than a note was
the paragraph meant to bound the design:** three exclusions were listed under
this project's own rule that a net is read as covering the variants of what it
names, and the one that worked was not among them. A fourth was stated
there, and it said what remains: a decision on a listed pair is trusted to the
named guard that wraps it and to the honesty of that guard's name. **ROUND 19
MEASURED THAT SENTENCE FALSE** — nothing in the parse required a wrapper, and a
listed pair reached through a helper that RETURNS it was outside the rule
altogether. It is kept here as the record of what this round claimed; what the
parse actually refuses is in §7.19, and the rule it now states is the fifth.

**`R18-S2` (`P3`) — the descent terminated by skipping, and then crashed.** I
had asked the challenger to check that the recursive descent terminates. The
parse did terminate, by skipping a name already on the path, which meant a
self-calling helper and a mutual pair were parsed as **admissible** — and then
recursed at RUN time until the interpreter raised `RecursionError`. It failed
closed, which is why this is a `P3`, but a traceback tells a reader the
instrument broke rather than that the frame is inadmissible. Re-entry is now a
NAMED refusal that prints the path, and the visited set is the names on the
CURRENT descent, copied at each level: a cumulative set would make two siblings
calling one helper look like re-entry. Both shapes are plants.

**`R18-S3` (`P3`) — the three carried residuals, measured rather than
accepted.** The challenger measured all three and reports them as disclosed. It
adds one thing worth keeping: the non-markdown bound is the one that has already
produced a real defect once, which I found myself at `7bd9c09`. They stay
carried and named.

**Recorded because the challenger was precise about it and a reader should not
credit it to the wrong instrument:** of the five frame plants round 18 tried,
**two were caught by the ARMS and not by the four rules** — the `.strip(<every
char>)` plant by a pass-arm returning `rc 1` where it wants 0, and a default
argument shadowing `_is_figure` by the catch arms returning `rc 2` where they
want 1. That is a real defence, and the one this project trusts most, but it is
not the parse. Two of the round's own arms were **invalid as run** and it says
so in its verdict: a symlink pointing the harness at a decoy, and a worktree of
the decoy, both put the process's physical directory inside the decoy, so the
decoy WAS the subject and reading its commit was correct behaviour.

**Still disclosed, not closed:** everything §7.15, §7.16 and §7.17 list, plus
the three carried residuals. **No signature is claimed here.** This is the
author answering; the round-19 challenge on `2dbce28..HEAD` and the coordinator
diff review after it are owed, and **`24f6ebe` is still the last fully signed
head**. `READY_TO_PROMOTE = NO`.

**EVIDENCE AT THIS HEAD.** The run is
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND18.txt`, run
`p11-20261019T125447Z-9610`: Pack A 121 cases twice and Pack B 53 cases twice
with 0 failed, the Pack A races and the Pack B races with 0 findings, 80 frozen
entries and 0 digest mismatches, and **every `EXIT_*` 0** — including
`EXIT_GENERATED_BLOCKS` and `EXIT_FENCED_FIGURES` at step `0c`, which is where
this round's work is exercised — on PostgreSQL 16.15 at `en_US.utf8` with both
roles `NOSUPERUSER NOBYPASSRLS`. The harness digest moves to `fdcc6572…`; the
pack digests do not move, and neither does the migrations tree. That run's tree
was dirty, because the evidence of a commit cannot be committed before it, and
the clean-tree re-run at the pushed SHA is published beside it with this
round's two gate probes: **the planted repository at three positions, each run
from three working directories**, with the unplanted control and the
guard-deletion run; and **round 18's three frame shapes driven through the real
`figures_on`**, where the number to read is the count of tracebacks, because
`R18-S2`'s whole point is that a named refusal is not a `RecursionError`.

**One ordering change the round forced, recorded because it changes what the
gate does and not only what it says:** `--selftest` now runs the structural
parse and the decision parse FIRST, and a frame the rules do not admit stops
the selftest there, by name, with the arms NOT run. A refusal earned by a
re-entrant frame is worth nothing if the arms execute that frame first and the
reader gets a traceback instead of the refusal.

## 7.19 The NINETEENTH round — `REJECT` at `e90bd70`: the allow-list's stated bound was false, and the shape outside it needed no guard at all

The round confirmed that `R18-F1` is closed — the repository planted at
`prep/phase11` is refused by name from all three seats, and the guard matrix
arms it — that `R18-S1` was addressed in the right place, that `R18-S2`'s
re-entry is refused rather than skipped, and that no entry of the new
allow-list was dead. **No arm of the round was invalid as run**, which is the
first time in three rounds that is true. Then it defeated this instrument in
the place it has now been defeated four rounds running: **the sentence I wrote
to bound my own fix.**

**`R19-F1` (BLOCKER) — a decision on a listed pair needed no guard, and a
listed pair reached through a helper was outside the rule entirely.** §7.18 and
the checker's header both said that what remains outside
`DECIDING_MODULE_CALLS` is "a decision on a listed pair is trusted to the named
guard that wraps it and to the honesty of that guard's name". That is a
measured-false claim by the agreed test — a reader sent to it would check the
names of the guards around `re.fullmatch` and conclude the hole was closed —
and the two shapes it fails to exclude are fail-opens, with the fabricated
figure committed and the suite reporting `selftest 0`, `--check-blocks 0`,
`scan 0`, no traceback:

- **`B1`**, three lines inserted after the `"=" not in s` test: a SECOND test on
  the listed pair `("_is_figure", "re", "fullmatch")`, **inside no guard at
  all**. The list admitted it, because the list said nothing about wrappers.
- **`B2`**, the question I had asked the challenger myself, answered against
  me: the listed pair reached through a helper that RETURNS it is **neither**
  the helper's decision nor the caller's. At the helper the call sits in a
  `return` position and the rule read only test positions; at the call site the
  test is on a local function rule 2 admits. **This escape does not need a
  listed entry to exist at all**, which makes it the wider of the two.
- **`B3`**, the same pair used in `figures_on` rather than in the listed
  function, was refused — by `--selftest`, which the suite runs. The round
  recorded that **the bare scan still returned 0 there**, which is `R19-S3`.

**Both halves of the discharge are implemented, and the rule is now stated in
POSITIONS.** `DECIDING_MODULE_CALLS` is five-part — `(function, module,
attribute, position, wrapping guard)` — and the parse walks **every position a
module call can occupy inside the frame**: `test` (anywhere inside an `if` or
`if`-expression condition), `return` (anywhere inside a returned value) and
`other`. A call in a `test` position is admitted only if the guard its entry
names **lexically wraps it**, which is the wrapper the old paragraph merely
presupposed. A call in a `return` position is admitted only from a function the
list names, and that entry records `None` where a guard would be, because the
value-class decision IS `_is_figure`'s purpose and there is no guard to name:
written down rather than implied. **Each entry admits exactly one site** — a
count stated as a law is tested as a function of its domain, and with "at least
one" the planted second test would simply have matched the entry the real one
matches. This is the FIFTH rule of the closed sub-language, stated as a rule
beside the other four rather than as a paragraph about them. **Round 17's
lesson, for the third time: a rule is only as wide as the positions it walks.**

**Both of the round's own shapes are arms, each planted with the challenger's
own lines verbatim, and each with the rule DELETED beside it.** The deletion is
by value and not by approximation: `decision_frame(enforce=False)` restores
round 18's behaviour exactly — a module call admitted in any position, with no
entry and no guard required — so the published probe reads `refused with the
rule, PASSES with the rule deleted` for each. An arm that fails both ways
measures nothing, and the selftest fails if either does.

**What is outside rule 5, and it is one thing: the honesty of a guard's NAME.**
The parse proves that `re.fullmatch` in `_is_figure` sits inside the branch
`"key class" not in skip` opens, that it is the only such call there, and that
nothing else in the frame calls a module at all. It cannot prove that the
branch deserves its name — that is the guard matrix's job, by deleting the
guard and reading which arms stop giving their verdict. This paragraph is now a
report of what the parse refuses rather than a promise about it, which is the
whole of the finding.

> **ROUND 20 MEASURED THE SENTENCE ABOVE FALSE, and the coordinator's review
> found a third thing outside it.** Every word of it is true and it bounded
> nothing: a decision does not have to be a module call to be a decision. Two
> more things were outside rule 5 — a whitelisted METHOD NAME on an object of
> the planter's own, and a module-level REBINDING of the listed attribute — and
> the coordinator added the ARGUMENTS of an admitted call. It is kept here as
> the record of what this round claimed; §7.20 carries what the parse refuses
> now, as a count with each line armed.

**`R19-S1` (`P2`) — a fail-closed regression, left closed on the coordinator's
ruling, with the accusation removed.** The census refuses `GIT-NESTED-REPO` for
an ORDINARY nested checkout: a clone inside a monorepo, under a versioned
dotfiles tree, or in a CI workspace that is itself a repository cannot run this
gate at all. The challenger proposed refusing only at or below the repository
being read. **The coordinator ruled it stays fail-closed and is a named
residual**, because an ancestor repository is exactly where round 18's plant
sat. Two things change rather than the shape: the refusal text now **lists the
repositories and names no intent** — a nested checkout is refused whether or
not anything was planted, and the likeliest cause is where the operator put the
clone, not an attack — and the consequence is recorded where it lands: **CI must
run this gate in a workspace that is not nested inside another repository.**

**`R19-S2` (`P2`) — a repository the census could not SEE, now refused by
name.** I had asked for this attack. The census reads a `.git` ENTRY, and a
BARE repository has none: `HEAD`, `objects` and `refs` sit directly in the
directory. The round planted one at `prep/phase11` and the census walked
straight past it. It did not become an escape — the run ended `rc 5`
`GIT-FAILED`, because git itself errors when asked to resolve an anchor from
inside a bare repository — and **a hole covered by another tool's error message
is not a hole this gate measured.** So the census is now made to AGREE with
git, both ways and each by name: `GIT-BARE-REPOSITORY` when git resolves the
subject inside a bare repository, and `GIT-TOPLEVEL-DISAGREES` when git's own
discovery names a repository the census did not. The arm is the round's own
plant, converted from a live nested plant so it carries a real commit, run from
all three seats — **and it is read by REFUSAL NAME and not by exit code**,
because the exit code was already 5: with the anchor it refuses as
`GIT-BARE-REPOSITORY`, and with the anchor deleted as `GIT-FAILED`, which is
git's accident. The `.git` symlink half of the question the round closed in my
favour.

**`R19-S3` (`P3`) — the bare scan had no parse gate, and now runs the parse
itself.** The decision parse gated the arms but not the scan or
`--check-blocks`, so anyone running the checker by hand, and any CI job that
invokes it directly, got no protection: `B3` is refused by `--selftest` and
scanned 0. Both entry points now run the frame parse first, cached once per
process, and refuse `FRAME-INADMISSIBLE` with the first refusal printed. The
scan also **says** it ran it, in the inventory line above its verdict, because
a reader told nothing has to take this header's word for it. The branch is
armed without editing the subject: the arm seeds the per-process cache with one
refusal for its own length and requires the same arm to give its own verdict
without the seed — **a red proof never edits a frozen or published file to
prove itself.**

**One thing added that no finding asked for, recorded as pre-emptive and not as
an answer.** The round said where it would look next: rule 5 matches a module
BY SPELLING, so attack the spelling — shadow `re`, alias it, reach `fullmatch`
through `getattr` or through `re.compile(...).fullmatch`. Of those four, three
are already refused by rules the frame has: an alias and an attribute chain are
attribute calls the method whitelist refuses by name, and `getattr` is not in
`FRAME_BUILTINS`. **The fourth would have been admitted** — a parameter named
`re`, which is round 18's shadowed-default shape, caught then by the arms and
not by the parse. So a parameter, loop target or binding that shadows a module
name rule 5 matches is refused by name, each listed module is checked in what
is RUNNING to BE the module it spells, and the parameter shape is an arm with
its own deletion control. **A triple matched by spelling does not match by
identity** — Phase 8 recorded it about path guards and Phase 15 about
`spawnSync`.

**Still disclosed, not closed:** everything §7.15, §7.16, §7.17 and §7.18 list,
the three carried residuals, `R19-S1` as a named fail-closed residual with its
CI consequence recorded, and the guard matrix's own bound, which the round
stated plainly and which I am not claiming to have closed: **deleting each
guard and finding it reds an arm proves every guard is load-bearing, not that
the set is complete.** **No signature is claimed here.** This is the author
answering; the round-20 challenge on `e90bd70..HEAD` and the coordinator diff
review after it are owed, and **`24f6ebe` is still the last fully signed
head**. `READY_TO_PROMOTE = NO`. `OD-P11-07` is the owner's.

**EVIDENCE AT THIS HEAD.** The run is
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND19.txt`, run
`p11-20261019T134755Z-9613`, and it was taken on a **clean tree**: the final
bytes of this commit were copied to a scratch directory and committed there, so
`SOURCE_TREE_DIRTY : no` and the figure gate derived its haystack from a commit
carrying every line of this round. Pack A 121 cases twice and Pack B 53 cases
twice with 0 failed, the Pack A and Pack B races with no findings, 80 frozen
entries and `digest mismatches: []`, and **every `EXIT_*` 0** — including
`EXIT_GENERATED_BLOCKS` and `EXIT_FENCED_FIGURES` at step `0c`, which is where
this round's work is exercised — on PostgreSQL 16.15 at `en_US.utf8` with both
roles `NOSUPERUSER NOBYPASSRLS`. The step-`0c` self-measurement is in §7.14's
generated blocks, where it is printed rather than typed; the arm counts and the
guard count moved, and nothing in this section repeats them. `HARNESS_SHA256`
moves to `5305b376…`; the pack digests do not move, and neither does the
migrations tree. **The scratch commit that run names is not this commit and was
never pushed** — the evidence of a commit cannot be inside the commit before it
exists — so the clean-clone re-run **at the pushed SHA** is published beside it,
with this round's two probes: **the two escapes, each planted with the
challenger's own lines and each run with the positions rule DELETED**, and **the
bare repository from three seats, read by refusal NAME rather than by exit
code.** `check_fenced_figures.py` is 3,539 lines at this head, sha256
`8270149d…`.

## 7.20 The TWENTIETH round — `REJECT` at `75a5952`, and the COORDINATOR DIFF REVIEW `NO-SIGN` on the same head: a whitelist of names is not a whitelist of behaviours

Two independent readings of one head, answered in one commit. The round
confirmed that round 19's two escapes are **closed, armed and measured with the
rule deleted beside each**, that `R19-S2` is closed BY NAME (and that reading
the refusal name rather than the exit code was the right call, since 5 was the
answer before and after), that `R19-S3` is closed and self-reporting, and that
`R19-S1`'s accusation is gone. It tested the `exactly one site` law **as a
function at both ends** — a second site matching the `test` entry reported
`matched 2 (line 15, line 17)`, the `return` site removed with its entry still
listed reported `matched 0 (none)` — and found both entries live. It then went
round the new rule three ways and all three were refused by name: the `other`
position, `getattr`, and a module alias. **No arm of the round was invalid as
run**, and it reported a reasoning error of its own rather than dropping it.

Then both readings defeated the instrument in the same place, which is the place
it has been defeated five rounds running: **the sentence drawn around the fix.**

**`R20-F1` (BLOCKER) — the bound said ONE thing was outside rule 5, and three
were.** Every word of the old paragraph was true: the parse did prove that the
admitted call sits inside its guard, and that nothing else in the frame calls a
module. **A decision does not have to be a module call to be a decision.**

- **`A4`, the wider escape.** `if _r20_shape.strip(key): return False`, with a
  small object at module level. `_r20_shape` is not in `FRAME_MODULES`, so rule
  5 was never consulted — no entry, no position, no guard. What admitted it was
  **rule 3**, whose method whitelist is a list of method NAMES with no
  constraint on the receiver. The round proved that was the admitting rule by
  running the same plant with `.match`, which is refused by name, and showed
  (`A4c`) that binding the object to a local inside the frame first does not
  change the answer.
- **`A1`, the narrower and more structural one.** Round 19's identity check tied
  the spelling `re` to the module OBJECT. The round rebound `re.fullmatch` at
  module level: `globals()["re"] is sys.modules["re"]` still held, `__name__`
  was still `"re"`, the call site still matched entry 1 in a `test` position
  inside the guard the matrix measures — and the decision that entry admits was
  the planter's. The lesson cited for the module check reaches **one level
  deeper than the fix did**: rule 5 pinned the module by identity and the
  attribute by name.
- **`C20-F1`, from the coordinator's review, the same shape a third time.** Rule
  5 pins which call may decide, in which position, inside which guard — and
  never looked at the **ARGUMENTS**. Adding `(?!4242$)` to the pattern inside
  the admitted `return re.fullmatch(...)`, or editing the guarded `keyre`, gave
  a clean run with a fabricated figure through.

**Implemented, all three, and each armed with the ONE rule that refuses it
deleted beside it.**

- **The receiver.** A whitelisted method is admitted only on a value the frame
  can ACCOUNT FOR: a parameter, a `for` target, or a name bound in the function
  from a value that is itself accounted. A module-level name is not accounted,
  and binding one to a local does not launder it, because the binding's own
  right-hand side is read. Independently of that, a name the frame reads from
  module level must be **DATA in what is RUNNING** — a string, or a tuple, set
  or frozenset of strings — because an OBJECT read from there decides through
  its own methods without calling a module at all. `A4` is refused by both
  rules, which is reported rather than hidden: the arm names both, and a third
  arm measures each rule alone.
- **The attribute.** The namespaces of the modules the frame may call are
  SNAPSHOTTED at import, on the line after the imports, and each entry's
  attribute is checked three ways, each its own refusal: **identity** against
  that snapshot (`MODULE-ATTR-REBOUND`), **provenance** (`__module__` must be
  the module the entry names — which is what catches a plant that rebinds
  BEFORE the snapshot), and **not defined in this file** (read off the code
  object, not a settable attribute). The arm performs the round's own rebinding
  in this process, reads the refusal by name, and measures round 19's
  module-only check beside it: it sees nothing wrong.
- **The arguments.** The CONSTANTS the matcher's decisions read are pinned by
  digest, and any edit to any of them reds by name — a law over argument edits
  rather than a list of the ones anyone has thought of. What is in the digest is
  derived, not listed: every literal in the six functions the parses cover
  (docstrings excluded, because prose decides nothing) and the module-level
  names those functions READ, by their value in what is RUNNING — a compiled
  pattern by its `.pattern`. `--decision-constants` prints the canonical text
  above the digest, so a deliberate change is one command away and the change
  itself is readable rather than only its hash.

**The coordinator's `P2`, which is the lesson of this round as much as the
blocker is: a fix is done only when deleting IT reds a gate.** Round 19's
deletion control deleted every new rule at once (`enforce=False`), so no single
rule was measured, and four checks had no arm at all. The rules now have KEYS
(`RULE_KEYS`) and a control deletes exactly one: the positions walk, the
`exactly one site` law, the receiver rule, the DATA rule, the module-name
shadow. Where two keys genuinely refuse one shape, the arm names both and
cannot pass with one deleted — stated rather than left for a reader to infer
from an arm that fails both ways. The `one-site` law also declares that it
counts the sites the POSITIONS walk collects, so deleting that walk zeroes the
count for a reason that has nothing to do with the law. And the four checks that
are about OBJECTS rather than shapes are armed by performing the move in this
process and restoring it: the attribute rebinding, the decorator, the argument
edit and the `--check-blocks` frame gate.

**`C20` `P2` — a decorator around a frame function.** `inspect.getsource`
follows `__wrapped__`, so the parse read the body underneath while the wrapper
decided: `--selftest` noticed by accident (its compiled-constants tie is not
part of the gate the scan runs) and `--check-blocks` and the scan returned 0.
The tie is now in the gate both run, as three named refusals: no `__wrapped__`,
the code object comes from this file, and the qualified name is the plain name.
**`R19-S3`'s sentence was false for this shape and is corrected rather than
defended.**

**`C20` `P3` — a module-level `lambda` crashed with a traceback.** A lambda has
a `__code__` and this module's `__module__`, so it resolved as a function, and
`inspect.getsource` returned the ASSIGNMENT it sits in, which parses to an
`Assign`: the descent died on `fn.name`. A traceback tells a reader the
instrument broke rather than that the frame is inadmissible. Refused by name,
with the shape as an arm.

**`R20-S1` (`P3`) — `realpath`, not `abspath`.** Reaching the harness through a
symlink refused `rc 5` with git's own *"outside repository"*, which is not what
had happened: the anchor was resolved and the subject's path kept the link's
spelling, so git rejected the pathspec. Identity versus spelling, on the path
this time. Measured after the fix: the symlinked spelling reports the figure at
`rc 1`, exactly as the real path does.

**`R20-S2` (`P3`) — the refusal nobody could reach is now reachable, and
armed.** Thirteen `GIT-*` refusals are registered and the round could not
construct a case reaching `GIT-TOPLEVEL-DISAGREES`: its two shapes — a linked
worktree and a `.git` file — both make git and the census AGREE. It asked for
the refusal to be recorded as UNMEASURED-at-runtime rather than described as
armed, and the coordinator ruled the same. **There is a shape:** a `.git` FILE
whose gitdir carries `core.worktree` pointing elsewhere. The directory holding
the `.git` is then the only repository an ancestor walk can see, and
`rev-parse --show-toplevel` names a different directory entirely. That is an arm
now, so the honest record is MEASURED and not UNMEASURED — found by taking the
residual seriously rather than by writing it down.

**One thing found in the instrument that enforces this phase's own lesson.** The
rule that an arm naming a finding must record the plant it measures was keyed on
`^R1\d`, so it stopped applying the moment the rounds reached twenty: an
exemption by SPELLING that could not name what had not been written yet, which
is this phase's `R16` lesson found inside the check that carries it. Any round
number now, and round 20's new arm records its plant.

**`C20`'s standing ruling, recorded because it changes what the documents may
say:** *`each entry is live` may never stand in for `the set is complete`.*
Every entry of `DECIDING_MODULE_CALLS` and every name in `FRAME_METHODS` is
checked to be live, and that is a check for DEAD entries, not for MISSING ones.
It does not have to be more here — anything the lists do not admit is refused BY
NAME, so the admit-lists are read through a refusal rather than through their
own completeness — and the documents now say only what is checked.

> **That middle clause is measured FALSE by round 21 and is deleted at the
> source (§7.22).** The planter's move is not to evade the list but to EXTEND
> it: one new entry, its call inside the guard the entry names, and the
> fabricated figure passed every gate. Reading a list through a refusal does not
> help when the entry exists. The sentence is gone from the instrument's own
> header rather than qualified there; the gap stays disclosed, and what it costs
> a planter is that the entry must be in the commit. The header's
bound is restated as a **count with four lines, each of them a thing the parse
does NOT do**: the honesty of a guard's name; what a transformer may do (round
20's own next-look, and not closed); the completeness of the admit-lists; and
the file's own bytes, since `HARNESS_SHA256` is printed and never compared with
a stored value, which is what the published digests are for.

> **Measured FALSE by the coordinator's review of this head, and §7.21 is the
> answer.** The fourth line read as a disclosure and worked as a hole: the
> review's escape was a DEFAULT ARGUMENT, which no rule above covers, and a
> residual that would have covered every escape in the list — `C20-F1`
> included, which was ruled a blocker — cannot discharge the next one. The
> harness's own bytes are a LAW now, pinned in §2a and read by a second
> reader that shares no code with the checker, and what is left on that line
> is one thing: an edit that moves a file and its pinned row together, which
> review bounds and no instrument here can.

**Still disclosed, not closed:** everything §7.15 to §7.19 list, the three
carried residuals, `R19-S1`'s fail-closed refusal of a nested checkout with its
CI consequence, the guard matrix's completeness question — which the round
raised again in a second place, since both admit-lists are checked for dead
entries and not for missing ones — and `R20-S3`, the pre-existing `G6` build
order, which is not this phase's. **No signature is claimed here.** This is the
author answering two reviews; the round-21 challenge on `75a5952..HEAD` and the
coordinator diff review after it are owed, and **`24f6ebe` is still the last
fully signed head**. `READY_TO_PROMOTE = NO`. `OD-P11-07` is the owner's.

**EVIDENCE AT THIS HEAD.** The run is
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND20.txt`, run
`p11-20261019T150206Z-14269`, taken on a **clean copy** of this commit's bytes
(`SOURCE_TREE_DIRTY : no`; the scratch commit it names was never pushed, because
the evidence of a commit cannot sit inside the commit before it exists). Pack A
121 cases twice and Pack B 53 cases twice with 0 failed, the races with no
findings, 80 frozen entries and `digest mismatches: []`, and **every `EXIT_*`
0** — including `EXIT_GENERATED_BLOCKS` and `EXIT_FENCED_FIGURES` at step `0c`,
which is where both reviews' work is exercised — on PostgreSQL 16.15 at
`en_US.utf8` with both roles `NOSUPERUSER NOBYPASSRLS`. The step-`0c`
self-measurement is in §7.14's generated blocks, printed rather than typed, and
nothing in this section repeats those numbers. `HARNESS_SHA256` moves to
`20558f29…`; the pack digests do not move, and neither does the migrations
tree. The clean-clone re-run **at the pushed SHA** is published beside it with
this round's probes: **the three escapes end to end**, each with the one rule
that refuses it deleted, and **`GIT-TOPLEVEL-DISAGREES` reached by name** for
the first time. `check_fenced_figures.py` is 4,251 lines at this head, sha256
`6779c399…`; the decision constants are pinned at
`96dde48abdaa78790e558068cd2bf341ada1a45038a4950a8272e62e3d7e6145`.

---

## 7.21 The COORDINATOR DIFF REVIEW of `142f88e` — `NO-SIGN`: the escape was a DEFAULT ARGUMENT, and the arm guarding the previous fix never ran the refusal

The review reproduced every one of round 20's and `C20`'s five escapes as closed
(`1/5/5`, each read by the refusal NAME), confirmed that no script or CI step
re-pins the constants digest, that `GIT-TOPLEVEL-DISAGREES` is reachable live,
and that the database suite at the full SHA is green on PG 16 — 121 cases twice,
Pack B 53 twice, `digest mismatches: []`, every `EXIT_*` 0. Then it found two
blockers, and both are about the same thing: **what the instrument is allowed not
to look at.**

**`C21-F1` (BLOCKER, fail-open) — one line, outside every rule and every
residual.**

```
-def scan(docs_dir, harness_dir, quiet=False, skip=()):
+def scan(docs_dir, harness_dir, quiet=False, skip=("hyphen in the key",)):
```

`_main` calls `scan()` with no `skip`, so the default switches a named guard off
for every real run, and the gates returned `0/0/0` with a fabricated figure
committed. It is outside the decision parse, because `scan` is not one of the
four functions the parse reads; outside the constants digest, because that hashes
body literals and not defaults; and outside every rule key. The same shape was
available through `"signed values"`, `"percent in the value"` and
`"boolean spellings"`, through `_fold_digits`, through a flag on a compiled
pattern, and through any line of the file nobody has thought of yet.

**The ruling, and it ends the class instead of chasing it:** stop pinning shapes
inside the file and pin **the file**. §2a of this manifest now carries a digest
for every executable file under `prep/phase11/harness/`, and
`harness/check_harness_bytes.py` reads the harness against it — a reader that
**shares no code** with `check_fenced_figures.py`, imports nothing from it, is
itself a pinned row of the same table, and refuses by name:
`HARNESS-BYTES-MOVED`, `HARNESS-FILE-UNPINNED`, `HARNESS-FILE-ABSENT`,
`HARNESS-PIN-UNREADABLE`, `HARNESS-UNREADABLE`, and
`HARNESS-BYTES-NOT-ISOLATED` if it is run without `-I`. `frame_admissible` runs
it as a **SUBPROCESS** — never an import, because an instrument that is part of
the set it measures must not be loaded into the process measuring it — so the
scan and `--check-blocks` refuse on it and it is not a `--selftest`-only
instrument; `rebuild_and_prove.sh` runs it at step **`0c-0`**, before anything
that reads these bytes, as `EXIT_HARNESS_BYTES`, and a refusal there is fatal,
because every figure printed below it is read out of the bytes it checks.

**The one limit, stated at the law rather than beside it:** an edit that changes a
harness file **and** its pinned row in the same commit is bounded only by REVIEW.
A pin inside the thing it pins is not a pin. That is why this phase's chain is
author, independent challenger, coordinator, with the diff read by someone who
did not write it.

**`C21-F2` (BLOCKER, measured-false claim) — the arm for the previous fix never
ran the refusal.** §7.20 said the argument-edit pin was "armed by performing the
move in this process". It was not. The arm digested the canonical text, digested
an edited copy, saw the two differ, and printed `the edit reds by name -> as
required`. The coordinator deleted the refusal itself
(`if got == DECISION_CONSTANTS_SHA256:` → `if True:`) and the arm went on
printing `as required`, with the plant passing the gates CI runs. **An arm that
compares two digests has measured arithmetic, not an instrument** — which is this
phase's own `R12` lesson, that a claim about an instrument is verified only by
RUNNING the instrument, found again inside the arm that carries it. The arm now
MOVES a pinned constant in this process, reads the refusal BY NAME, takes the
scan's exit code, and deletes the check by value beside it.

**Five registered refusals had no arm that reds when the check is deleted, and
the review named them.** Each is armed now, read by refusal name in both
directions, with the object checks keyed (`OBJECT_KEYS = ("attr-identity",
"fn-identity", "const-pin", "harness-bytes")`) so one is deleted per copy,
exactly as `RULE_KEYS` does for the shape rules:

- **`GIT-TOPLEVEL-DISAGREES`** — the arm read `rc=5`, and the same world refuses
  `rc=5` with the census deleted for an unrelated reason, while the arm printed
  `as required` and §7.20 called the refusal armed. **The exit code was never the
  measurement.** It reads the name now, and requires that deleting the census
  takes THAT name away.
- **the `shadow` key's second branch** — a BINDING inside the frame's own body
  that takes a frame module's name. Round 20 armed the parameter branch and left
  this one unarmed, so deleting half the rule red nothing.
- **`MODULE-ATTR-FOREIGN`** — the branch for a planter who rebinds BEFORE the
  import-time snapshot, where identity is satisfied and provenance refuses. The
  arm moves the snapshot WITH the attribute, which is that planter exactly.
- **`FRAME-FUNCTION-FOREIGN`** and **`FRAME-FUNCTION-NESTED`** — a body compiled
  under another file name, and a body defined inside another function. Neither
  carries `__wrapped__`, so neither was caught by the decorator arm.

Arming the last two found a fifth thing: with `fn-identity` deleted, a body that
is not in this file reaches the parse and `inspect.getsource` raises, so the
instrument broke rather than refusing. `FRAME-SOURCE-UNREADABLE` and
`DECISION-CONSTANTS-UNREADABLE` are named refusals now — the same correction
round 20 made for a module-level lambda, in the two places `C21`'s own arms
reach.

**`C21` `R-1` (`P3`), closed rather than carried:** the constants digest read a
compiled pattern by `.pattern` alone, so adding `re.I` left it unchanged. A flag
is part of what a pattern decides, so the flags go in with the pattern and
`DECISION_CONSTANTS_SHA256` moves to `9d67a25b20b0…`. **`R-2` (`_fold_digits`
outside the digest and the parse) is covered by the byte law**, which is what the
ruling said it would cover; it remains outside the PARSE, and residual 2 — what a
transformer may do — still says so. **`R-3`** is the pre-existing cold root
build, which is not this phase's.

**Still disclosed, not closed:** everything §7.15 to §7.20 list, the three
carried residuals, `R19-S1`'s fail-closed refusal of a nested checkout with its
CI consequence, the completeness of both admit-lists, what a transformer may do
under another name, and the byte law's one limit above. **No signature is claimed
here.** This is the author answering a review; the round-21 challenge on
`142f88e..HEAD` and the coordinator diff review after it are owed, and **`24f6ebe`
is still the last fully signed head**. `READY_TO_PROMOTE = NO`. `OD-P11-07` is the
owner's.

---

## 7.22 ROUND 21 (`REJECT` at `142f88e`) and the coordinator's diff review of `04f2db2` — the deciding code is read from the COMMIT

Round 21 and the coordinator's review of `142f88e` agreed, independently, on the
same blocker, and the coordinator's ruling for this round replaces rule-by-rule
work with one change of direction. Both reviews first confirmed a long list as
genuinely closed — round 20's `A1`, `A4`, `A4c`, `C20-F1`'s two shapes, the
decorator, the lambda, `R20-S1`, `R20-S2` now MEASURED rather than unmeasured,
the `^R1\d` exemption, the keyed deletion controls, and the DB suite green at the
full SHA (121 cases twice, Pack B 53 twice, every `EXIT_*` 0). The challenger also
reported two arms of its own as invalid as run and rebuilt them rather than
dropping them, which is the discipline this phase asks of itself.

**`R21-F1` (BLOCKER), both halves.** `C20-F1` was not closed. The matcher's
decision constants were pinned by a digest held as a **literal in the same file
whose constants it pins**, and the refusal text said:

> If the change was deliberate, run `--decision-constants` and commit the digest
> it prints.

So the challenger did exactly that. Two edits — the coordinator's own argument
narrowing, plus the one line the error message prescribes — and `selftest 0`,
`--check-blocks 0`, `scan 0`, no traceback, the fabricated figure through. It did
the same with the guarded `keyre` narrowing. **Half two:** the rule had no
deletion control. Forcing the comparison to pass (`if True:`) left the arm
printing `as required`, because the arm hashed two strings and compared them
itself — it measured arithmetic, not the instrument — and `RULE_KEYS` had no key
for it. By this phase's own law, *a fix is done only when deleting IT reds a
gate*, the fix was not done.

This is this phase's `P7 R11` law coming back: **a derived subject set must not be
derived from a representation the subject can alter.** A constant beside the
constants is such a representation. So is a table of digests in a document a
planter can edit in the same commit — which is what §2a held after the
coordinator's `C21-F1`, and why the first answer to that finding was the same
mistake with one more file in it.

**The ruling, and it subsumes six rounds of rules: the deciding code is read from
the COMMIT.**

- Every deciding file under `prep/phase11/harness/` — every `.py`, `.sh`, `.sql`,
  found by walking rather than by a list — must equal
  `git show <resolved anchored sha>:<path>`. Refused by name:
  `SELF-BYTES-UNCOMMITTED`, `SELF-FILE-UNCOMMITTED`, `SELF-FILE-ABSENT`,
  `SELF-ANCHOR-UNRESOLVED`.
- **`_source_of` takes the frame's source from that blob**, not from
  `inspect.getsource`. A name the commit does not define at module level is a
  named refusal and never a fallback to the running file, because falling back
  is exactly the hole.
- The law is read **twice**: once with the checker's own code, and once by
  `harness/check_harness_bytes.py`, which imports nothing from it and is itself
  one of the deciding files — a file cannot be the authority on its own bytes.
  The second reader runs as a SUBPROCESS, never an import.
- **No literal in the file pins anything.** `DECISION_CONSTANTS_SHA256` is gone;
  `--decision-constants` still prints the canonical text and its digest, marked
  informational, and the committed digests are published in §2a **for a reader**,
  with nothing in the harness reading them.
- **No refusal text instructs its reader how to satisfy it.** The old one
  prescribed the re-pin step that silenced it, which is a manual rather than a
  law. These name what moved and stop.
- The anchor is the same structural one the haystack already uses — every
  ancestor examined, more than one repository refused by name, `realpath` not
  `abspath`, bare repositories and `core.worktree` redirects refused — which is
  the most attacked and best armed machinery in this phase.

**And the sentence that used to stand here was measured false in round 22.** It
said an escape from any round between 16 and 21 "therefore has to be **committed**
to work". The challenger planted three uncommitted hunks in the checker — the
guard off at the call site, the byte comparison skipped for the live directory
only, the second reader never invoked — and got a fabricated figure through at
`selftest 0 / blocks 0 / scan 0`; one uncommitted line in `rebuild_and_prove.sh`
(`RC_HARNESS_BYTES=0`) did the same to the whole authoritative run. The
coordinator's review found the second half independently. **No check inside a
self-run entry point can stop that: the entry point is what would run the check.**

**THE CLEAN-TREE LAW, which is what can be true.** A dirty work tree is refused
BY NAME wherever the run is entered — `SELF-TREE-DIRTY` in the scan and
`--check-blocks`, `HARNESS-TREE-DIRTY` in the second reader, `SOURCE-TREE-DIRTY`
in `rebuild_and_prove.sh`, which refuses before the cluster, the identity block
and every gate. So the true sentence, and the one this manifest now carries
everywhere: **a transcript is evidence only when it was produced from a CLEAN
tree whose `HEAD` is the committed sha, and reviewers run from fresh clones.** An
uncommitted edit — one file or many — is therefore the **declared limit** and not
a measured escape: what it can no longer produce is a green run anyone is allowed
to read.

**What this does not do, stated at the law and not in a footnote:** it does not
stop a planter who commits. Nothing executable can. Nor does it stop an
uncommitted edit that deletes the clean-tree law in the same stroke — that is the
same sentence one level down, and it is why the second half of the limit is a
rule for the READER and not a check in the code: the reviewer runs from a fresh
clone of the commit, where no uncommitted edit exists to delete anything. What
the law changes is that the change has to be in the diff, under the published
digest, in front of an independent challenger and the coordinator. That is the
whole of the guarantee, and it is why this phase's chain has three links and why
no author signs their own work.

**`R21-S1`, and the coordinator ruled this sentence alone would block.** Item 3
of the bound disclosed that the admit-lists are checked for dead entries and not
for missing ones, and then argued the gap was harmless: *"it does not have to
here — anything the lists do not admit is refused BY NAME."* Round 21 measured
that false by **extending** the list rather than evading it — one new entry, its
call inside the guard the entry names, the figure through. Reading a list through
a refusal does not help when the entry exists. **The sentence is deleted at the
source**, in the instrument's own header and in this manifest; the gap stays
disclosed, and what it costs a planter now is a commit.

**`R21-S2` (selective transformer drop) stays a named residual** and shrinks on
its own under the ruling: the drop adds a literal, so it has to be committed, and
the re-pin that made it reachable no longer exists. **`R21-S3` is closed:** the
lambda refusal has a `RULE_KEYS` key (`lambda`), so no arm in the set names none.
**`R21-S4`** is the pre-existing cold root build, which is not this phase's.

**Folded into the same commit, per the ruling:** the coordinator's `C21-F1`
default-argument escape and the five refusals that had no deletion control
(`GIT-TOPLEVEL-DISAGREES`, whose arm read an exit code the hole also returns; the
`shadow` key's binding branch; `MODULE-ATTR-FOREIGN`; `FRAME-FUNCTION-FOREIGN`;
`FRAME-FUNCTION-NESTED`), which were answered in `04f2db2` and are carried here
with their arms now reading refusal names in both directions.

**No signature is claimed.** The round-22 challenge and the coordinator diff
review after it are owed; **`24f6ebe` is still the last fully signed head**.
`READY_TO_PROMOTE = NO`. `OD-P11-07` is the owner's.

**EVIDENCE AT THIS HEAD.** Authoritative run
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-08b4c6a.txt`, run
`p11-20261019T161149Z-23823`, on a **clean clone at the pushed SHA**
(`SOURCE_TREE_DIRTY : no`). Pack A 121 cases twice and Pack B 53 cases twice with
0 failed, the races with no findings, `digest mismatches: []`, and **every
`EXIT_*` 0** — including the new `EXIT_HARNESS_BYTES` at step `0c-0`, where the
second reader checks every deciding file against the commit before anything reads
those bytes — on PostgreSQL 16.15 at `en_US.utf8` with both roles `NOSUPERUSER
NOBYPASSRLS`. `HARNESS_SHA256` moves to `e6744fe54f70…`; the pack digests and the
migrations tree do not move. The run before it, at `04f2db2`, is kept as
`RUN-EVIDENCE-AUTHORITATIVE-04f2db2.txt` so each transcript names its own head.

**The probe is `RUN-EVIDENCE-PROBE-COMMIT-SOURCE-08b4c6a.txt`, and it measures
what the law does and what it does not, in both directions.** The plant is
`zz-c22-probe=4242`, committed in the owner's Arabic report inside a fenced
block; the control reds it at `scan 1`.

| at | arm | edit committed | selftest | blocks | scan |
|---|---|---|---|---|---|
| `08b4c6a` | control | — | 0 | 0 | **1** (`NOT EMITTED`) |
| `08b4c6a` | the review's `skip=` default | no | 1 | **5** | **5** (`SELF-BYTES-UNCOMMITTED`) |
| `08b4c6a` | `(?!4242$)` in `_is_figure`'s pattern | no | 1 | **5** | **5** (`SELF-BYTES-UNCOMMITTED`) |
| `08b4c6a` | the `skip=` default | **yes** | **1** | 0 | 0 |
| `08b4c6a` | the pattern narrowing | **yes** | 0 | 0 | 0 |
| `142f88e` | the `skip=` default | yes | 0 | 0 | 0 |

The last row is the coordinator's `C21-F1` as it stood. The two uncommitted rows
are the law: an edit in the working tree is refused BY NAME and never measured.
**The two committed rows are the limit, measured rather than asserted** — a
committed pattern narrowing passes every gate, and a committed `skip=` default
passes the scan while `--selftest` reds it, which matters because
`rebuild_and_prove.sh` runs the selftest first and refuses to trust a checker
that cannot fail. Nothing executable closes the committed direction. The diff,
the published digests and two reviewers do.

**One arm of mine did not measure what I intended, and is reported rather than
dropped.** At the parent I ran the pattern narrowing WITHOUT the second edit
round 21 used — the re-pin of the in-file literal — so it reds there as
`DECISION-CONSTANTS-MOVED` (`1/5/5`), which measures the old pin catching a
narrowing and not the escape. Round 21's escape needed both edits and is the
challenger's measurement, in its own report, not mine. **Two earlier corrections
to the same probe, for the same reason:** its first version planted the figure as
INLINE code, which is not a candidate at all, so the control returned `0` and no
arm below it measured anything; its second used a key with no hyphen, and the
escape under test switches the hyphen guard off, so the parent still red it. An
arm whose control does not red measures nothing.


---

## 7.23 ROUND 22 (`REJECT` at `868f25d`) and the coordinator's diff review of the same head (`NO-SIGN`) — the clean-tree law, and the limit stated for the READER

Both reviews, run independently, found the same thing from two directions: **the
byte law covered every deciding file and not the file that INVOKES it.** The
coordinator replaced an uncommitted `rebuild_and_prove.sh` line by line — `101`,
`117`, `118`, `142` set to `true` — and got the full suite, cluster and database
and all, at `rc 0` with every `EXIT_*` 0 and `EXIT_HARNESS_BYTES` 0 while the
reader never ran. The challenger did it in ONE file and without the shell: three
uncommitted hunks in `check_fenced_figures.py` — the guard off at the **call
site** (so no arm's anchor moves), the byte comparison skipped **for the live
directory only** (so every copy-based arm still printed `as required`), and
`harness_bytes_pinned` returning before the reader's path is built — plus an
uncommitted fabricated figure in a fenced block of this manifest. Measured:
`selftest 0 / blocks 0 / scan 0`, the figure through, and the second reader
refusing correctly when run on its own and run by nothing.

**Both reviews first re-measured the head's own claims and found them true**: the
nine published digests equal the committed bytes (recomputed from `git archive`,
not from the author's tree), the authoritative suite green from zero on both
clones, an uncommitted `skip=` default and an uncommitted `(?!4242$)` narrowing
each refused BY NAME by both readers, textconv through `.git/config`, a
tree-deleted file, a symlink to an untracked file and `git show`'s lack of smudge
filters all fail-closed, and each of the two comparison copies load-bearing.
Four of the five refusals the previous review found unarmed were confirmed armed
by renaming each refusal's own literal on a committed copy.

**THE RULING, and it is a change of what the claim is about.** No check inside a
self-run entry point can stop an uncommitted edit to that entry point: the entry
point is what would run the check. What can be true is that such a tree produces
**no admissible transcript**. So:

1. **A dirty work tree is FATAL and refused BY NAME, wherever the run is
   entered.** `SELF-TREE-DIRTY` in the scan and in `--check-blocks`,
   `HARNESS-TREE-DIRTY` in the second reader — which is where deleting it from
   the script does not reach — and `SOURCE-TREE-DIRTY` in
   `rebuild_and_prove.sh`, refused **before the cluster, the identity block and
   every gate**. The bare scan a reader or CI runs alone therefore carries a
   refusal rather than a green.
2. **The limit is stated at the law, in the terms that are true:** a transcript
   is evidence only when it was produced from a CLEAN tree whose `HEAD` is the
   committed sha, and reviewers run from fresh clones. An uncommitted edit — one
   file or many — is the **declared limit**. The sentence this head carried in
   three places (`an escape therefore has to be COMMITTED to work`, and `a
   reader who runs them alone is not outside it`) is **measured false and
   deleted at every copy**: the instrument's header, this manifest, the shell
   step, the conservation-laws row and the Arabic report, in the OUTCOME
   sentences and in the DISCIPLINE sentences alike.

**`R22-F1(b)` (BLOCKER): the two keys that carry this law had no deletion
control.** Of the four object checks, `attr-identity` and `fn-identity` had key
arms; `self-bytes` and `harness-bytes` did not, and deleting either from the live
consultation — committed, on a throwaway clone — red nothing. The three byte arms
ran the instruments **on a copy**, in another directory, which measures the
instrument and never that THIS run consults it. *An arm on a copy of the
instrument is not a control on the run.* So the live consultation is bound to a
prepared world the way the identity arms rebind `re.fullmatch` — one deciding
file drifted on disk after the commit — and the deletion is applied to the call
the run makes: with both keys consulted the run names both refusals; with one key
deleted THAT name is gone and the other stands. The scan is run in the same bound
world, so what is read is the verdict and not a return value.

**`R22-S1` is closed rather than carried:** `HARNESS-BYTES-READER-ABSENT` and
`SELF-FILE-ABSENT` are armed in one world (the reader deleted from the tree), and
both sites of `FRAME-SOURCE-NOT-IN-COMMIT` in two more — this file committed
nowhere, and a commit whose copy of this file defines no function under the name
that is running. **`R22-S2` is closed:** the shell step no longer tells its reader
to run `--decision-constants` and commit what it prints, after the pin that step
existed to move was deleted. **`R22-S3` is closed:** the second reader's `_git`
now also clears `GIT_CONFIG_GLOBAL` and `XDG_CONFIG_HOME`, which are not `GIT_*`
keys and survived the scrub — the challenger measured the content route closed,
so this is the older reader's own hardening brought across rather than an escape
patched. **`F2` is closed:** the second reader derived its commit by asking git
for the toplevel from the harness directory, so an untracked nested `.git` with
the plant committed into it answered for the subject and the reader returned 0.
It now derives the anchor **structurally and independently** — its own ancestor
census, written twice rather than imported, with `HARNESS-NO-REPOSITORY`,
`HARNESS-NESTED-REPO`, `HARNESS-SUBJECT-IS-A-REPO`, `HARNESS-BARE-REPOSITORY`,
`HARNESS-TOPLEVEL-DISAGREES` and `HARNESS-HEAD-DISAGREES` each a named refusal
that picks nothing.

**`R22-S4` and `R22-S5` stay named residuals.** `S4`: step `0c-0` runs `python3`
from `PATH` and `-I` does not disable a `.pth` in system site-packages — an
operator who controls the interpreter controls the run, which is scope and not a
hole in the law, recorded because the law's authority is one subprocess. `S5` is
the standing `G6` cold root build, red on `main` too.

**EVIDENCE, and it includes what the law still does not stop.** All four worlds
are throwaway clones of the candidate tree, committed before the gates run;
nothing was edited in the working tree used for the project and no frozen
migration was touched. The transcripts are
`harness/RUN-EVIDENCE-AUTHORITATIVE-ROUND22.txt` (the four gates on the committed
clone, the probe, and the authoritative suite from zero on PG 16 at `en_US.utf8`
with `NOSUPERUSER NOBYPASSRLS` roles: `SOURCE_TREE_DIRTY : no`, 121 cases twice
and Pack B 53 twice at 0 failed, every `EXIT_*` 0 including `EXIT_HARNESS_BYTES`)
and `harness/RUN-EVIDENCE-PROBE-CLEAN-TREE-ROUND22.txt` (the four plant worlds
side by side). Both say in their own headers which tree they measured: a scratch
commit whose tree is this commit's minus those two `.txt` files, which are not
deciding files — the law walks `.py`, `.sh` and `.sql` — so the deciding bytes
they cover are the bytes this commit carries.

| world | selftest / blocks / scan / reader | what refused |
|---|---|---|
| control: the candidate tree, committed | 0 / 0 / 0 / 0, 0 failed arms | nothing |
| the challenger's three hunks + the figure, UNCOMMITTED | 1 / 5 / 5 / 5 | `SELF-TREE-DIRTY` first in the scan and in `--check-blocks`, `HARNESS-TREE-DIRTY` in the reader |
| the same, plus the clean-tree law deleted in the same uncommitted file | 1 / 0 / 0 / 5, **3 failed arms** | nothing in the scan — **the declared limit** |
| the same plant COMMITTED | 1 / 0 / 0 / 0, **3 failed arms** | nothing in the scan; `--selftest` reds |
| `rebuild_and_prove.sh` in the dirty clone | `rc 5`, no cluster built | `SOURCE-TREE-DIRTY`, before anything ran |

Three things are worth reading in that table rather than skimming. **`R22-F1(a)`
as the challenger built it is closed:** the scan a reader runs alone reds by name.
**The law does not stop an uncommitted edit that deletes the law too** — that is
the same sentence one level down, and it is why the second half of the limit is a
rule for the READER: a reviewer runs from a fresh clone of the commit, where
there is no uncommitted edit to delete anything with. **And the plant's third
hunk is caught by the new arms:** in both the `nolaw` and the COMMITTED world
three arms fail, naming exactly what is missing — `HARNESS-BYTES-UNCOMMITTED`
never appears, because the second reader is never invoked. A committed version of
this plant therefore survives the bare scan and reds `--selftest`, which is the
first time this class has been caught by anything in the harness.

**No signature is claimed.** Round 23 of the independent challenge and the
coordinator diff review after it are owed on this range; **`24f6ebe` is still the
last fully signed head**, `READY_TO_PROMOTE = NO`, no migration number exists,
and `OD-P11-07` is the owner's alone.

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
