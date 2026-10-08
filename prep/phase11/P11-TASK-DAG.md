# P11 — TASK DAG, FILE OWNERSHIP AND PARALLELISM MAP

**status** `PREPARED / NOT PROMOTED`. **revised 2026-10-08:** `ADJ-P11-01` is ruled (Option B, `TL-P11-R1`), so `P11-ADJ-001` is **CLOSED** and the DB tasks are no longer blocked on it — they are blocked on Phase 11's place in the promotion order (§88) and on two named gates: a sealed Phase 10 `SERVICE` capability (`TL-P11-R6`) and the Accounting Owner's verification of repair consumption posting (§62). Three tasks are added for the `TL-P11-R7` correction. Nothing here is scheduled by this document; it is the dependency statement a Captain would schedule from.

Task id shape: `P11-<AREA>-<NNN>`. Areas: `ADJ` adjudication · `CAP` capability/entitlement plumbing · `CAT` apparel/catalog · `LOT` lot/expiry · `SER` serial/IMEI · `REP` repair · `WAR` warranty · `GATE` gate and proofs · `SEC` security · `UX` web surfaces · `L10N` localization · `AND` android · `DOC` canonical docs.

---

## 1. The DAG

| id | task | depends on | owner role | files it may write | DB? | accounting risk | security risk | parallel? |
|---|---|---|---|---|---|---|---|---|
| ~~**P11-ADJ-001**~~ | **CLOSED 2026-10-08 — `TL-P11-R1`: Option B.** Lot/serial extend traceability identity, not the costing key; `TL-P11-R2` closes the costing question with it | — | Tech Lead | none | — | ruled | — | done |
| ~~P11-ADJ-002~~ | **CLOSED 2026-10-08** — `TL-P11-R2`…`R6` and §55/§63 answer OD-P11-01…06; OD-P11-07 stays with the owner as business/legal, and the system meanwhile records custody facts under the neutral `uncollected` | — | Owner | none | — | ruled | — | done |
| P11-CAP-001 | add a `repairs` capability definition; flip the three reserved keys to `implemented: true` **at promotion only** | P11-ADJ-002 | Authority Owner | `packages/domain-core/src/capabilities.ts` | no | none | none | yes |
| P11-CAP-002 | the capability ↔ entitlement **mapping** (`inventory.lot-expiry` ↔ `LOT_EXPIRY`, …), frozen, tested both ways, exhaustive over both registries | — | Authority Owner | `packages/domain-core/src/` (new file) + its test | no | none | **gating correctness** | **yes, now** |
| P11-CAP-003 | `repair` industry-profile key | P11-CAP-001 | Authority Owner | `packages/domain-core/src/industry-profiles.ts` | no | none | none | yes |
| P11-CAP-004 | feature-registry rows for the two missing keys (patch request §2.6, §5.5) | P11-ADJ-001 | **Migration Owner** | migrations | yes | none | none | no — one train |
| P11-CAP-005 | permission keys + the five declarations + defaults-backfill migration | P11-CAP-004 | Authority Owner + Migration Owner | `permissions.ts`, `shared-contracts`, migrations | yes | none | **high** — a wrong default grants a pack | no |
| P11-CAT-001 | axis registry DDL (patch request §2.1–2.3) | P11-ADJ-001 | Migration Owner | migrations | yes | none | medium | no |
| P11-CAT-002 | canonicalization function + trigger + unique index (§2.4), six refusals | P11-CAT-001 | Catalog author | migrations (same file) | yes | none | medium | no |
| P11-CAT-003 | `catalog_generate_variant_matrix` entry routine (§2.5) | P11-CAT-002 | Catalog author | migrations | yes | none | medium | no |
| P11-CAT-004 | API module `apps/api/src/modules/catalog-matrix/` — the full file set of §6a | P11-CAT-003 | Catalog author | that directory only | no | none | medium | yes |
| P11-CAT-005 | both process compositions + the composition test | P11-CAT-004 | API Owner | `app.module.ts`, `merchant-api.module.ts` | no | none | medium | no — shared file |
| P11-CAT-006 | `shared-contracts` DTOs for the matrix | P11-CAT-004 | Contracts Owner | `packages/shared-contracts/src/` | no | none | low | yes |
| P11-CAT-007 | red proofs for C-APP-01 (six refusals + the index case) | P11-CAT-002 | **Challenger** (not the author) | `tests/` | yes | none | — | yes |
| P11-LOT-001 | lot DDL: `stock_lots`, overlay, per-lot cache, append-only triggers (§3.2–3.4) | P11-ADJ-001 | Migration Owner | migrations | yes | **none by construction** — no value column | high | no |
| P11-LOT-002 | the deferred conservation triggers (§3.5), surviving `SET CONSTRAINTS … IMMEDIATE` | P11-LOT-001 | Inventory author | migrations | yes | none | high | no |
| P11-LOT-003 | **the writer change** (§3.6) — additive attribute, no return-shape change, lot locks as a suffix of the existing order | P11-LOT-002 | **Inventory Owner alone** | migrations | yes | **the highest-risk task of the phase** | high | **no** |
| P11-LOT-004 | `inventory_lot_fold` / `_verify` (§3.7) | P11-LOT-003 | Inventory author | migrations | yes | none | medium | no |
| P11-LOT-005 | `inventory_pick_lots` — FEFO/FIFO, supplied `as_of`, refusal not partial pick | P11-LOT-004 | Inventory author | migrations | yes | none | medium | no |
| P11-LOT-006 | `products.track_lot`, `expiry_policy`, history lock (§3.1) | P11-LOT-001 | Inventory author | migrations | yes | none | medium | no |
| P11-LOT-007 | C-LOT-04 value-neutrality proof **against the pre-Phase-11 oracle** | P11-LOT-003 | **Challenger** | `tests/` | yes | **the law that makes the shape safe** | — | yes |
| P11-LOT-008 | C-LOT-01/02/03 red proofs (incl. the `IMMEDIATE` variant) | P11-LOT-002 | **Challenger** | `tests/` | yes | none | — | yes |
| P11-LOT-009 | concurrency: per-lot negative refusal, deadlock in both lock orders, real connections and barriers | P11-LOT-003 | Concurrency author | `tests/` | yes | none | high | yes |
| P11-SER-001 | serial DDL: `stock_serials`, `stock_serial_events`, append-only (§4.2–4.3) | P11-ADJ-001 | Migration Owner | migrations | yes | none | high | no |
| P11-SER-002 | the three deferred triggers (§4.4) | P11-SER-001 | Inventory author | migrations | yes | none | high | no |
| P11-SER-003 | writer integration + the write-side `FOR UPDATE` availability refusal (§4.5) | P11-SER-002, P11-LOT-003 | **Inventory Owner alone** | migrations | yes | none | high | no |
| P11-SER-004 | `products.track_serial` + countability constraint + history lock (§4.1) | P11-SER-001 | Inventory author | migrations | yes | none | medium | no |
| P11-SER-005 | C-SER-03 red proof **enumerating the writer's branches**, not one happy path | P11-SER-002 | **Challenger** | `tests/` | yes | none | — | yes |
| P11-SER-006 | C-SER-04: two concurrent sales of one serial, exactly one commit; plus the lock-removal mutation | P11-SER-003 | Concurrency author | `tests/` | yes | none | high | yes |
| P11-SER-007 | C-SER-01/02 red proofs | P11-SER-002 | **Challenger** | `tests/` | yes | none | — | yes |
| P11-REP-001 | repair relations (§5.2) | P11-ADJ-001 | Migration Owner | migrations | yes | none | medium | no |
| P11-REP-002 | the parts bridge + registry rows + guard (§5.3) | P11-REP-001 | Inventory author | migrations | yes | **COGS path** | medium | no |
| P11-REP-003 | repair entry routines (open, diagnose, consume parts, change status, hand back), each consuming one assertion | P11-REP-002 | Repair author | migrations | yes | low | medium | no |
| P11-REP-004 | billing: issue a **Phase 4 sales invoice** from a ticket via the preconsumed binding (**never an ordinary sale line for a consumed part**); deposit as a Phase 4 customer payment — no repair money relation | P11-REP-007, **Phase 4 sealed** | Repair author | `apps/api/src/modules/repairs/` | no | **high — must add no financial truth and no second stock effect** | medium | no |
| **P11-REP-007** | **the preconsumed sale-line binding** (`P11-AL-21`, `TL-P11-R7`): relation keyed one-per-consumption, its three deferred triggers, server-derived only, **no schema property a client could supply** | P11-REP-002, **Phase 4 sealed** | Inventory Owner + Repair author | migrations, `apps/api/src/modules/repairs/` | yes | **the highest financial risk in the repair pack — its fail-open case is free inventory** | medium | no |
| **P11-REP-008** | **Accounting Owner verification** (§62) before `repair_part_consumption` goes live: debit account, inventory credit, valuation from the canonical average, correction/reversal path, no duplicate COGS at invoice time — becomes an **Accounting-owner Contract Diff** if the posting map cannot represent it safely | P11-REP-002 | **Accounting Owner** | none (a contract diff, not code) | no | **blocking** | — | no |
| **P11-REP-009** | C-REP-03 red proofs: the ordinary-sale-line mutation (counting movements before and after), the duplicate binding, the qty mismatch, the binding-without-consumption, and the schema-property arm | P11-REP-007 | **Challenger** | `tests/`, `scripts/` | yes | high | — | yes |
| **P11-REP-010** | labour as a service product — **`BLOCKED` on a sealed Phase 10 `SERVICE` stock-effect capability** (`TL-P11-R6`); registers nothing dead in Phase 10 | Phase 10 sealed | Repair author | `apps/api/src/modules/repairs/` | no | medium | low | no |
| P11-REP-005 | C-REP-01 executed absence proof (register an intake source type, require the end-state raise) | P11-REP-002 | **Challenger** | `tests/` | yes | none | — | yes |
| P11-REP-006 | C-REP-02 idempotent-replay + zero-direct-write arms | P11-REP-003 | **Challenger** | `tests/` | yes | high | — | yes |
| P11-WAR-001 | warranty + claim relations (§5.2) | P11-REP-001, Phase 4 sealed | Repair author | migrations | yes | **none — no provision, no accrual** | low | no |
| P11-GATE-001 | `scripts/phase11-s<N>-gate.ts` with the arms of the laws document §2, predecessor gates **imported** | P11-CAT-002 (first subject) | Harness Owner | `scripts/` | no | none | none | yes |
| P11-GATE-002 | the blanker fixture test including a **regex literal** before any text arm is trusted | — | Harness Owner | `tests/guards/` | no | none | none | **yes, now** |
| P11-GATE-003 | gate-of-the-gate suites: every arm shown red by a minimal mutation, each mutation diff-checked first | P11-GATE-001 | **Challenger** | `tests/guards/` | no | none | none | yes |
| P11-GATE-004 | required-CI law: the gate runs unconditionally in the `backend` job after its predecessor | P11-GATE-001 | CI Owner | `.github/workflows/ci.yml` | no | none | none | no — shared file |
| P11-SEC-001 | tenant/business isolation suites for every new relation, from a **non-superuser** session | P11-LOT-001, P11-SER-001, P11-REP-001 | Security author | `tests/security/` | yes | none | **high** | yes |
| P11-SEC-002 | RLS equivalence: a projection must not serve a pre-pack answer when rows are merely invisible | P11-SEC-001 | **Challenger** | `tests/security/` | yes | none | **high** | yes |
| P11-SEC-003 | direct-SQL protection: `daftar_app` cannot write any Phase 11 relation | P11-SEC-001 | Security author | `tests/security/` | yes | none | high | yes |
| P11-UX-001 | apparel matrix screens (route page + page kit + views + **registry** + `PAGE_AREAS` row) | P11-CAT-006 | Web author | `apps/web/src/app/[locale]/…`, `apps/web/src/views/…`, `apps/web/test/helpers/registries.ts` | no | none | low | yes |
| P11-UX-002 | lot/expiry screens; the tracking toggles attach to the existing `TrackingCard` | P11-LOT-005 | Web author | same shape | no | none | low | yes |
| P11-UX-003 | serial screens: capture, lookup, custody history | P11-SER-003 | Web author | same shape | no | none | low | yes |
| P11-UX-004 | repair workbench: intake, diagnosis, parts, status, hand-back | P11-REP-004 | Web author | same shape | no | none | low | yes |
| P11-UX-005 | locked-pack states via the existing `FeatureLockedState` / `PlanLimitState`; **gate on the feature key from the entitlement**, never on a plan name or `industry_profile_key` | P11-CAP-002 | Web author | per-area pages | no | none | medium | yes |
| P11-L10N-001 | ar/en/tr keys for every surface and **every refusal code** (`error.<code>`), identical key sets | each UX task | Localization Owner | `apps/web/src/messages/{ar,en,tr}.json` | no | none | none | no — shared files |
| P11-L10N-002 | the `details.<pack>Code` field names added to `DOMAIN_CODE_FIELDS` | P11-CAT-004 and siblings | Web Owner | `apps/web/src/lib/client.ts` | no | none | low | no — shared file |
| P11-AND-001 | Android serial/lot **capture only** — input, never authority; 3× `strings.xml` | P11-SER-003 | Android author | `apps/android/.../ui/<feature>/` | no | none | medium | yes |
| P11-DOC-001 | the Phase 11 architecture lock and slice contracts in `docs/`, plus the status page update **by its owner** | P11-ADJ-002 | Coordinator | `docs/` | no | none | none | yes |

---

## 2. File ownership (Master Part 41)

| file / area | owner | everyone else |
|---|---|---|
| `infrastructure/database/migrations/**` | **Migration Owner** | `MIGRATION PATCH REQUEST` only |
| `inventory_apply_stock_movements` and anything in the inventory authority | **Inventory Owner**, alone | patch request |
| `packages/domain-core/src/permissions.ts` | Authority Owner | `PATCH-REQ-*` |
| `packages/domain-core/src/capabilities.ts`, `industry-profiles.ts` | Authority Owner | `PATCH-REQ-*` |
| `packages/shared-contracts/src/index.ts` | Contracts Owner | one `export *` line per pack, requested |
| `apps/api/src/app/app.module.ts`, `merchant-api.module.ts` | API Owner | requested; **both or neither** |
| `apps/web/src/messages/{ar,en,tr}.json` | Localization Owner | requested |
| `apps/web/src/lib/client.ts` | Web Owner | requested |
| `apps/web/test/helpers/registries.ts` | Web Owner | requested |
| `.github/workflows/ci.yml` | CI Owner | requested |
| `scripts/phase11-*` and the shared harness | Harness Owner | own files only |
| `PROJECT_STATUS.md`, `TECHNICAL_DEBT.md`, `docs/DAFTAR_*` | Coordinator | never edited by a pack worker |
| `/mnt/project-files/phase11/**` | this preparation thread | one writer per file |

No two tasks share a mutable working tree; each independent task takes its own worktree/branch, and no Phase 11 worker touches the Phase 4 integration tree.

---

## 3. Parallelism map

**Startable now, with the ruling in hand and no DB impact:** `P11-CAP-002` (the vocabulary mapping), `P11-GATE-002` (the blanker fixture), and the design/contract parts of `P11-CAT-004`, `P11-CAT-006`, `P11-UX-001`. `P11-REP-008` — the Accounting Owner's verification — is also startable now as a contract question and should be, because it can turn into a Contract Diff that changes the repair pack's shape.

**No longer blocked on a ruling:** `ADJ-P11-01` is closed (Option B), so the DDL of patch-request §3 and §4 stands. What remains blocking is the promotion order (§88 — Phase 11 is eleventh), Phase 4's seal, the Phase 10 `SERVICE` capability for labour alone, and §62's accounting verification before repair consumption goes live.

**Wave shape once ruled** — four packs, three of them genuinely independent:
- apparel (catalog only) ‖ repair-document relations ‖ gate/harness ‖ localization scaffolding;
- lot then serial, **serialized through the Inventory Owner**, because both change the single writer and two agents may not. This is the phase's real critical path: `P11-LOT-003` → `P11-SER-003`, with everything else fanning out around it;
- challenger tasks (`-007`, `-008`, `P11-SER-005/007`, `P11-REP-005/006`, `P11-SEC-002`) run in parallel with their authors' work but **never by the same agent**; an author does not sign their own work.

**WIP control.** The bottleneck here is review of financial-adjacent DB work, not implementation throughput: one writer, one migration train, one financial truth. Adding implementers past that does not make the phase finish sooner — it makes the review queue the schedule. Spare capacity goes to challengers, red proofs, security suites and localization, which are genuinely parallel.

---

## 4. Promotion pipeline for this phase

`PREPARED` (now) → **ADJ-P11-01 ruled (done)** → `REVIEWED` → `READY_TO_PROMOTE` (blocked until Phase 4 seals and the roadmap reaches Phase 11) → contract diff → **migration allocation by the Migration Owner** → integration → targeted tests → full required estate → security review → performance lane on the authoritative box → browser/UX/localization → independent challenger → acceptance → freeze. No status is skipped, and `WAITING_FOR_INTEGRATED_SURFACE` is the honest value for anything that binds to unsealed Phase 4 — never `PASS`.
