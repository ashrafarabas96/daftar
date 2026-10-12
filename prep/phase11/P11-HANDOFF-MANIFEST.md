# P11 — HANDOFF MANIFEST

**Required gate.** PART 13 of the 2026-10-12 per-phase directive makes a `P<N>-HANDOFF-MANIFEST.md` mandatory for every Phase 5–15 preparation; a missing artifact is **`HANDOFF INCOMPLETE`**, which the directive is explicit is *not* automatically product failure. The purpose is that the next reader — a successor agent, a challenger, the coordinator, or the Migration Owner at promotion — can tell what exists, where, and whether it is in Git, **without re-deriving any of it**. The directive's own instruction is to search before recreating: the current branch, the worktree, the previous report bundle, the shared project-files location, and the local commit history, in that order.

---

## 1. Identity

| field | value |
|---|---|
| **phase** | 11 — Apparel · Electronics · Repair · Lot/Expiry vertical packs (Master Part 31) |
| **status** | **`PREPARED / NOT PROMOTED`**, and on the Master Continuous Mission's ladder (`PREPARED → CHALLENGED → READY_TO_PROMOTE → PROMOTION_IN_PROGRESS → ACCEPTED / SEALED`) at **`PREPARED`** — no independent challenger has read it. **Pack A (apparel) now has an executed scratch proof, serial and concurrent** (see §3); everything else in the phase is `DESIGN / SPEC ONLY`. One subfeature is separately `BLOCKED` (repair-part accounting, PART 68) and two are `WAITING_FOR_INTEGRATED_SURFACE` (the preconsumed billing binding and the repair deposit, both on unsealed Phase 4 surfaces). PART 117 states the law this obeys: never call `PREPARED` complete, never call a local test CI, never call a spec a DB proof. |
| **base read** | `93084f8` on `phase/4-sales-pos-customers-receivables` (`fix(p4s1-gate): a delegator may not also compute`) |
| **own branch** | `claude/phase11-prep-re0epv`, cut from that head. Nothing has been pushed to `phase/4-sales-pos-customers-receivables` or to `main`, and no pull request exists. |
| **worktree** | the session's primary checkout at `/home/user/daftar`; no separate git worktree was created |
| **preparation SHA — the six documents of 2026-10-08** | `6958b886aba8fb918bf18e6e0eac451438910ec1` (parent `188dcb076c16035ab2db9a138b2b2c4dc84bcc2b`) |
| **preparation SHA — this revision (2026-10-12, the per-phase directive applied)** | the commit that adds this manifest and the seven revised documents under `prep/phase11/`. It is **`d45019fa231e8170dff9d5c17160ed752655ea34`**, the child of `6958b88` on this branch, recorded here by the commit that follows it — because a file cannot contain the hash of the commit that creates it, and inventing one would be exactly the kind of unverifiable number this project refuses. The push was a fast-forward `6958b88..d45019f`, **verified by `git ls-remote origin claude/phase11-prep-re0epv`**, not by the push log. |
| **preparation SHA — the concurrency revision (2026-10-12, V2 applied)** | the DDL and harness fixes for defects 7 and 8 are **`d813de2b76b8fdf4667686dd1f0de1a48436b222`**, and that is the SHA the authoritative evidence run names as its own input (`SOURCE_TREE_DIRTY : no`). The documentation of that round is **`466f44bd28a960187604e4609837f9f64c13335d`**, recorded here by the commit that follows it — as above, a file cannot contain the hash of the commit that creates it. Both pushes were fast-forwards on this prep branch only, **verified by `git ls-remote origin claude/phase11-prep-re0epv`**, not by the push log. |
| **push authority** | `TL-MASS-PRESERVE-01` (§9 of the 2026-10-08 directive): a PREPARED / NOT PROMOTED prep thread may fast-forward push **its own isolated prep branch** for preservation — non-canonical, not `main`, not the Phase 4 branch, no PR, no force, no rewrite, not integration, exact SHA recorded. **Preservation, not promotion.** This branch never merges itself. |
| **migration numbers** | **none allocated, none reserved, none examined, none exampled, none in a filename and none in a comment.** Every number appearing in any Phase 11 document is a citation to a file already on disk. One Migration Owner, at promotion (PART 6). |
| **frozen prefix** | `0000`–`0079` are byte-immutable and **were not modified, not even temporarily, and not by any test** — no Phase 11 proof targets them (see `P11-AL-25` and §0a of the laws document). `0080`–`0086` are Phase 4's unfrozen S4 candidates and were likewise not touched. |
| **timing / performance** | **no number measured and none claimed anywhere.** This container is not the authoritative box and a figure from it would not be comparable. A budget *lane* is owed from the Performance Owner. |

---

## 2. Artifacts

Each document exists in **two places**: the shared project-files location (the canonical working copy) and `prep/phase11/` in Git on the prep branch. The SHA256 is of the shared copy as of this revision (2026-10-12, after the Pack A proof run, after V2's concurrency round, **and after V3 was applied** — exit codes, PG16 settled, and the §7 fact correction); the Git copies are byte-identical, which is what the commit proves.

| artifact | shared location | in Git | SHA256 (shared copy) |
|---|---|---|---|
| `P11-S0-VERTICAL-PACK-ARCHITECTURE.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `f3dfa42cb4a8188493fda75d5587a3a99f34bcca4e6c80c4116befc02098cd53` |
| `P11-MIGRATION-PATCH-REQUEST.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `cb4260068a136cf6e05129745b053db1dbd975f2187f82f6663d675223a3a9f9` |
| `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `8631716c62210d6ee529f49ea1609c0d6ab1ad6c5d746a64725504daf543fef8` |
| `P11-TASK-DAG.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `2b732ec1523d07c0b6d5ce9a8b6473f77caf4a67253623e30b63d0f81b5a549b` |
| `P11-OPEN-DECISIONS.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `945cc6971ab8524ef7479c6c0ed69f824e83e3105607cbf5f3f89eaaf100c79c` |
| `P11-S0-REPORT-AR.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `3bbb3c05554cd2288452e274eff2f6cccd7c1a0b2879de826ec69d51fb2c6d2b` |
| `P11-LIVE-DDL-PROOF.md` | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | `c3db5022574f06a1ea774bd344a365d1e13f615c223fa995991d75a1959a0ad1`|
| `prep/phase11/ddl/` + `prep/phase11/harness/` | — (Git only) | **committed** | the applied DDL and the harness; in Git rather than off-Git because they are executable, not prose |
| `P11-HANDOFF-MANIFEST.md` (this file) | `/mnt/project-files/phase11/` | `prep/phase11/` — **committed** | self-referential; recompute with `sha256sum` |

**Nothing is uncommitted.** The working tree is clean at the preparation SHA, and the shared copies are the same bytes. Note that `/mnt/project-files/` is **not in Git**: the Git copies under `prep/phase11/` are the durable ones, and that duplication exists precisely because this container is ephemeral.

**Where to look first if an artifact appears to be missing** (PART 13's order, and its warning that a referenced companion document absent from an archive does **not** mean the work never existed): `git show <prep SHA>:prep/phase11/` on this branch; then `/mnt/project-files/phase11/`; then `git log --all --diff-filter=A -- 'prep/phase11/*'`. Do not recreate any of these until that search proves the file absent.

---

## 3. Evidence files

**Pack A (apparel) has executed evidence as of 2026-10-12; the other three packs have none.** The Master Continuous Mission's §18 required the unnumbered scratch proof, and it ran.

| artifact | what it is |
|---|---|
| `P11-LIVE-DDL-PROOF.md` | the proof's report, its run identity, and the **eight defects** it found — six of them in this preparation's own specification or its own proof, two of those found only after V2 refused the sentence *"apparel has no concurrency to prove"* |
| `prep/phase11/ddl/p11-pack-a-apparel.sql` | the **unnumbered** Pack A DDL, as applied |
| `prep/phase11/harness/rebuild_and_prove.sh` | the one script that does every step from zero on every run |
| `prep/phase11/harness/run_migrations.py` | a faithful reproduction of the house runner's contract (per-file transaction, ownership-handover bracket, checksum history) for a container with no `node_modules` |
| `prep/phase11/harness/world.sql`, `proofs.py` | the world and the **21** serial cases |
| `prep/phase11/harness/races.py` | **three real-concurrency races** — two live backends, sentinel-awaited interleaving, **no `sleep()`**; exits non-zero on any failed setup statement, because an earlier version failed its setup silently and invalidated two races |
| `prep/phase11/harness/RUN-EVIDENCE-2026-10-12.txt` | the first green run, **before** the concurrency work |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-d813de2.txt` | the first clean-tree raw log, kept rather than replaced |
| `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-99dbbe7.txt` | **the authoritative raw log** — the same run with **exit codes in the log** (V3 §9): `EXIT_PROOFS 0`, `EXIT_RACES 0`, `EXIT_SCRIPT 0` |

**Measured, in the form it ran in:** PostgreSQL 16.15 scratch cluster; `bootstrap.sql` as the deployment administrator; **migrations 0000→0086, 87/87, as `daftar_migrator` and not as a superuser**; Pack A applied unnumbered with its end-state assertion passing; **21 proof cases, 0 failed**; **3 real-concurrency races, 0 findings**; and after the run, **0 tracked changes under `infrastructure/database`, `frozenThrough = 0079`, 80 frozen entries, 0 digest mismatches**.

**Run identity of the authoritative log** — V2 §18 requires the exact source rather than a guess at the remote head:

| field | value |
|---|---|
| `RUN_ID` / `RUN_AT_UTC` | `p11-packA-20261012T115215Z-1834` / `2026-10-12T11:52:15Z` |
| `SOURCE_BRANCH` / `SOURCE_SHA` | `claude/phase11-prep-re0epv` / **`99dbbe729d65450d3b70c54dd2b1ad395f58891b`** (earlier log: `d813de2…`; identical DDL and proofs) |
| `SOURCE_TREE_DIRTY` | **`no`** |
| `MIGRATIONS_SHA` | `b128c7033a3381bd2237d0a1405f0676ac509960` |
| `MANIFEST_SHA256` | `4b4dd6e9e1359eba6536a0c70c0f3cf056e62b47bfed833026541df5ffbe6804` |
| `PACK_A_DDL_SHA256` | `7561f8f859d2007643c8ec78992d739d1aa137fa6733ba76bc5a8dcf7af1d3a8` |
| `PG_VERSION` / `NODE_VERSION` | PostgreSQL **16.15**, the PG16 family V3 settles as the deploy target / v22.22.0 against `engines.node >=24 <25`, so **no npm suite ran** |
| `EXIT_PROOFS` / `EXIT_RACES` / `EXIT_SCRIPT` | **0 / 0 / 0** |

A trial run that printed `SOURCE_TREE_DIRTY : YES` is deliberately **not** reported as evidence: its input had no name.

**What is NOT evidence, stated so no reader promotes it:** no npm workspace suite ran at all — this container has **Node 22.22.0 while the repository requires `>=24 <25`** and has no `node_modules`, so `format`, `lint`, `typecheck` and every Vitest suite are `UNMEASURED`. There is **no CI run** for any of this and a local green is never reported as CI. There is **no timing or performance number**, measured or claimed. Lot, serial and repair remain `SPEC ONLY`. There is **no challenger signature**.

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

**No challenger has reviewed this preparation.** An author does not sign their own work, and nothing here carries a second signature, let alone a third. PART 118 lists **Challenger on design** among the immediate Phase 11 items, and it is startable now because its subject is these seven documents rather than code: task `P11-REP-014`. The fail-open cases to attack, named in advance so the challenger need not find the list first:

1. a billing binding created **before** its consumption exists (`P11-AL-21` condition 7) — re-opens the §60 defect by another door;
2. a binding across **two customers**, which no single-customer fixture can expose (condition 3b, new on PART 67);
3. a warranty row **deleted** by a return path (`C-WAR-01` case d) — the first draft's shape;
4. a proof whose mutation lands in **frozen history** (`P11-AL-25`, §0a of the laws document);
5. `C-SER-03` satisfied by **zero** serial events on some writer branch — silent, permanent overlay drift;
6. `C-LOT-03`'s per-lot cache disagreeing with `stock_levels` — a second quantity truth wearing a cache's clothes.

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
