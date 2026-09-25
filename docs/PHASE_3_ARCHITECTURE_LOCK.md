# DAFTAR — Phase 3 Architecture Lock / قفل معمارية المرحلة الثالثة

> **Status: DECISION RECORD. No schema, no code, no migration.** This document resolves the architectural ambiguity that would otherwise cause rework during Phase 3 (Inventory, Purchases, Suppliers). It is binding on the Phase 3 implementation. Where an older planning page conflicts with it, this page wins; where it conflicts with an **accepted Phase 2 contract or a frozen migration**, the accepted implementation wins and this page records the contradiction rather than overriding it.
>
> **Baseline.** Accepted Phase 2 merge commit `0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f` on `main` (accepted source head `bf2eeda1494b0333cfef26123d55bcf54134e402`), post-merge CI run `36028186854` SUCCESS on all five required jobs. Migrations `0000`–`0052` are frozen forever; the manifest holds 53 entries with `frozenThrough = 0052_accounting_journal_lines_rls_performance.sql`. Phase 3 begins at `0053`, which **does not exist yet and is not authorized by this document**.
>
> **Correction pass, Round 4 — 2026-09-25.** The Tech Lead reviewed head `fd963c130a0bf51a14b09e1de483bd3d69ab15be` (CI `36195847316`), accepted Round 3's resolutions, and returned CHANGES REQUIRED on one cross-layer **authority** defect found by reading the lock against the accepted Phase 1 privilege model: `0006_rls.sql:78` grants `daftar_app` table-level `SELECT, INSERT, UPDATE` on `products` and `product_variants`, and a table-level grant covers every column added later — so the day P3-S1 adds `track_inventory`, `unit_code` and `unit_decimals`, the merchant runtime could set them with a plain `UPDATE`, bypassing `inventory.adjust`, the configuration command and the unit rules. A `CHECK` that a tracked product has a unit proves shape, not authority. `daftar_inventory_internal` was also only a name. **P3-AL-54 (new)** is the complete physical authority model beneath P3-AL-04, -05, -15, -36, -52 and -53: the three kinds of authority, the internal role's full contract and its one deployment membership, the safe `SECURITY DEFINER` discipline, the three named runtime routines, the column guards and why they must run with **invoker** rights, trigger ordering against the P3-S2 history lock, the home-association maintainer's authority through the frozen onboarding writer, the `branch_warehouses` RLS and grant model, the live grant matrix and the managed-PostgreSQL proof. Repository inspection while closing it established two facts the review did not state and that decide the design: the frozen onboarding writer runs as **`daftar_platform`** (`0033_provisioner_atomic_authority.sql:308`), not as `daftar_provisioner`; and roles are created in `infrastructure/database/bootstrap.sql`, not in migrations. No Round 3 decision is reopened or weakened. Premortem extended to **PM-43**.
>
> **Correction pass, Round 3 — 2026-09-25.** The Tech Lead reviewed the closed lock at head `2ced8c1d2bed4f54e007ab6aac6d958436c11918` (CI `36190820912`), **accepted** the Round 2 corrections to P3-AL-49, P3-AL-51, P3-AL-32, P3-AL-38 and P3-AL-36, and returned CHANGES REQUIRED on two blockers found by cross-reading this lock against the **accepted Phase 1/2 implementation** rather than against itself. **(A)** `branch_warehouses` had a backfill but no lifecycle: a warehouse created *after* the migration would have had no authorization row, so an existing Phase 1 workflow would have produced a warehouse no assigned-scope actor could reach — a regression Phase 3 would have caused. Repository inspection while closing it found a **third** warehouse writer the review did not name, inside the frozen `provision_create_business`, which decides the mechanism (P3-AL-15, rewritten). **(B)** `products.unit_code` / `unit_decimals` were "frozen on the product" with no historical lifecycle, so changing them after movements exist would have silently reinterpreted every historical `qty_delta` — closed by a history lock that current zero stock does not unlock (P3-AL-05 §D). Two execution-closure requirements are also resolved: the hidden base variant must not leak through the catalog API that exists today, and may not be mutated by ordinary variant commands (**P3-AL-52**, new); and role seeding must be proved for businesses created **after** the migration, not only backfilled ones (**P3-AL-53**, new). P3-AL-38's "exactly three" is restated precisely: exactly three *Phase 3* permissions, **appended**, with the Manager's accepted Phase 1 authority untouched. Premortem extended to **PM-38**.
>
> **Correction pass, Round 2 — 2026-09-25.** The Tech Lead reviewed the corrected lock at head `fd7fceb99fc9550640973341ab56d746aa00b4a5` and returned CHANGES REQUIRED again, on four blockers found by **cross-reading the decisions against each other** rather than reading each alone. All four were real. **(A)** Movement valuation at `NUMERIC(28,10)` against a `BIGINT` journal meant two roundings, and rounding is not additive, so zero-tolerance reconciliation was arithmetically unreachable — resolved by making the movement value itself integer base minor units and the journal line that same integer (P3-AL-49, rewritten, with the equation and nine acceptance vectors). **(B)** A line-grained `stock_source_bindings` could not carry a reverse FK, because one transfer line has two movements, and the promised `ON DELETE RESTRICT` to a polymorphic source line cannot exist — resolved by a movement-grained binding and per-source bridge tables with real FKs, plus the binding-side trigger the first draft was missing (P3-AL-51, rewritten). **(C)** P3-S1's acceptance matrix required entities owned by P3-S2/S3/S4 — re-scoped to the transaction primitive, with the end-to-end proofs assigned to P3-S3 and P3-S4 (P3-AL-32). **(D)** The lock and the execution plan disagreed about Manager's permissions — the lock wins, and the assertions now separate ordinary visibility from sensitive authority (P3-AL-38). Two wordings were also corrected: "the average is never an input to a later write" was too absolute, and the claim that PostgreSQL refuses `CURRENT_DATE` in a `CHECK` was **factually wrong** (P3-AL-36). Premortem extended to **PM-35**.
>
> **Correction pass, Round 1 — 2026-09-25.** This page was reviewed by the Tech Lead at head `5d28f18c3bad4d692fff0c41424d82fec8075fcd` and returned as CHANGES REQUIRED. Four architectural defects were proved against the real repository and against a live PostgreSQL 16, and are corrected here: the quantity-precision rule tested the storage scale instead of the value (P3-AL-05); an average-only cache could not be exactly rebuilt (P3-AL-01, P3-AL-49); a single assertion-requiring transaction seam contradicted the no-journal transfer (P3-AL-32); and stock source identity proved no-duplicates only (P3-AL-50, P3-AL-51). Multi-layer deficit coverage collided on the movement identity tuple and is re-modelled (P3-AL-13). Every withdrawn rule is named where it stood, so a reader who remembers the old wording finds the retraction rather than silence. Three decisions were added: **P3-AL-49**, **P3-AL-50**, **P3-AL-51**. The page remains DOCUMENTATION ONLY.
>
> **Why this exists.** Inventory is the first domain in DAFTAR that owns an *operational* ledger of its own and must stay exactly consistent with an *accounting* ledger it does not own. Two ledgers that can disagree are worse than one ledger that is wrong, because nobody can tell which half to believe. Every decision below is therefore written as what the database physically refuses, or as the exact seam that makes the refusal possible.

---

## 0. How to read a status

Per the directive's §59, every decision carries exactly one status:

| Status | Meaning |
|---|---|
| **ENFORCED PRECEDENT** | The rule already holds, enforced by an accepted earlier phase. Phase 3 reuses it and may not weaken it. The evidence is named. |
| **TO BE ENFORCED IN P3** | The rule does not hold yet. The owning slice is named, and the enforcement mechanism is stated concretely enough that two engineers would build the same thing. |
| **DEFERRED BY SCOPE** | Deliberately not Phase 3. The owning future phase is named, and what Phase 3 must NOT do about it is stated. |
| **OPEN / BLOCKED** | An external decision genuinely prevents resolution. Used exactly once in this document. |

---

## Decision index

| # | Decision | Status | Owning slice / phase |
|---|---|---|---|
| P3-AL-01 | Inventory source of truth | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-02 | Movement ordering authority | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-03 | Canonical stock identity | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-04 | Existing-product transition | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-05 | Unit / quantity contract | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-06 | Stock-key first-row concurrency | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-07 | Multi-key lock ordering | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-08 | Exact inventory cost arithmetic | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-09 | Stock movement source identity | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-10 | Movement reason registry | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-11 | Value-only cost movement | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-12 | Negative-inventory boundary | TO BE ENFORCED IN P3 | P3-S2 / P3-S4 |
| P3-AL-13 | Deficit FIFO | TO BE ENFORCED IN P3 | P3-S2 / P3-S4 |
| P3-AL-14 | Transfers | TO BE ENFORCED IN P3 | P3-S3 |
| P3-AL-15 | Warehouse authorization | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-16 | Stocktake concurrency | TO BE ENFORCED IN P3 | P3-S3 |
| P3-AL-17 | Adjustment / damage accounting | TO BE ENFORCED IN P3 | P3-S3 |
| P3-AL-18 | Opening stock | TO BE ENFORCED IN P3 | P3-S3 |
| P3-AL-19 | Purchase lifecycle | TO BE ENFORCED IN P3 | P3-S4 |
| P3-AL-20 | Purchase correction | TO BE ENFORCED IN P3 | P3-S5 |
| P3-AL-21 | Purchase line identity | TO BE ENFORCED IN P3 | P3-S4 |
| P3-AL-22 | Landed cost | TO BE ENFORCED IN P3 | P3-S4 |
| P3-AL-23 | Tax boundary | OPEN / BLOCKED (OD-03) | bounded by P3-S4 |
| P3-AL-24 | Purchase accounting shape | TO BE ENFORCED IN P3 | P3-S4 |
| P3-AL-25 | Purchase FX | TO BE ENFORCED IN P3 | P3-S4 |
| P3-AL-26 | Supplier source of truth | TO BE ENFORCED IN P3 | P3-S4 |
| P3-AL-27 | Payment-method foundation | TO BE ENFORCED IN P3 | P3-S6 |
| P3-AL-28 | Supplier payments | TO BE ENFORCED IN P3 | P3-S6 |
| P3-AL-29 | Supplier return / PPV | TO BE ENFORCED IN P3 | P3-S5 |
| P3-AL-30 | AP first, supplier receivable second | TO BE ENFORCED IN P3 | P3-S5 |
| P3-AL-31 | Supplier-credit concurrency | TO BE ENFORCED IN P3 | P3-S6 |
| P3-AL-32 | Shared transaction composition | TO BE ENFORCED IN P3 | P3-S1 (seam), used from P3-S3 |
| P3-AL-33 | Domain authorization | TO BE ENFORCED IN P3 | P3-S1 (seam), used from P3-S3 |
| P3-AL-34 | Accounting source types | TO BE ENFORCED IN P3 | P3-S3 / P3-S4 / P3-S5 / P3-S6 |
| P3-AL-35 | Business transaction trace | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-36 | TD-09 future-date defence | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-37 | TD-10 assertion signer | ENFORCED PRECEDENT (kept) | — |
| P3-AL-38 | Phase 3 permissions | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-39 | Warehouse scope + permission | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-40 | Supplier lifecycle | TO BE ENFORCED IN P3 | P3-S4 |
| P3-AL-41 | Warehouse / variant archival | TO BE ENFORCED IN P3 | P3-S3 |
| P3-AL-42 | Stock-level rebuild | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-43 | Inventory ↔ GL reconciliation | TO BE ENFORCED IN P3 | P3-S8 |
| P3-AL-44 | Read models | TO BE ENFORCED IN P3 | P3-S2 / P3-S7 |
| P3-AL-45 | Reservations | DEFERRED BY SCOPE | Phase 4 / Phase 6 |
| P3-AL-46 | Lot / serial / expiry | DEFERRED BY SCOPE | Phase 11 |
| P3-AL-47 | Web / Android boundary | DEFERRED BY SCOPE | Phase 7 |
| P3-AL-48 | UX law | TO BE ENFORCED IN P3 | P3-S7 |
| P3-AL-49 | Stock valuation exactness law (integer minor, one rounding) | TO BE ENFORCED IN P3 | P3-S2 |
| P3-AL-50 | Stock source-type registry | TO BE ENFORCED IN P3 | P3-S2 (registry), registered per slice |
| P3-AL-51 | Physical stock source completeness (movement-grained binding + per-source bridge) | TO BE ENFORCED IN P3 | P3-S2 (mechanism), per source thereafter |
| P3-AL-52 | Hidden base variant boundary (catalog invisibility + mutation refusal) | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-53 | Role permission seeding for businesses created after the migration | TO BE ENFORCED IN P3 | P3-S1 |
| P3-AL-54 | Physical database authority model for Phase 3 (internal role, routines, column guards, grants, RLS, managed PostgreSQL) | TO BE ENFORCED IN P3 | P3-S1 (P3-S2 for the history guard's placement) |

---

## 1. What repository inspection found that the documents did not say

These are not opinions. Each was read out of the accepted tree at `0f2b09e` and each changes a Phase 3 decision. They are recorded here because a lock that silently assumed the documented shape would have produced a plan that does not compile against the real schema.

### F-1 — A warehouse belongs to exactly one branch, and `branches.default_warehouse_id` does not exist

`docs/DAFTAR_DATA_MODEL.md` §3 states that a warehouse "follows the Business", that `branches.default_warehouse_id` exists and is nullable, and that the composite FK runs from the branch to the warehouse. The frozen migration `0003_tenancy.sql` says the opposite: `warehouses.branch_id UUID NOT NULL` with a composite FK to `branches (business_id, id)`, plus `warehouses_one_default ON warehouses (business_id) WHERE is_default` — one default warehouse per **business**, and no column on `branches` at all.

The implementation wins. The data model page is corrected by this slice (§7 of the directive authorizes that update). The consequence for Phase 3 is direct: the "central warehouse serving several branches" the directive asks for **cannot** be expressed by the existing column, because `branch_id` is NOT NULL and singular. It is expressed by the new association table in P3-AL-15, and `warehouses.branch_id` is reinterpreted — without being altered — as the warehouse's **home branch**, which is where the association table is seeded from.

### F-2 — The branch-scope table is `member_branch_scopes`

`docs/DAFTAR_DOMAIN_MAP.md` names `membership_branch_access`. The frozen `0008_multiuser_rbac.sql` creates `member_branch_scopes (business_id, user_id, branch_id)` alongside `memberships.branch_scope_mode ∈ {all, assigned}`. Phase 3 authorization reads the real table. The domain map is corrected by this slice.

### F-3 — Every accounting adapter opens and commits its own transaction

`apps/api/src/infra/database.ts` exposes `run()`, which always issues `BEGIN`, applies the scope GUCs and issues `COMMIT`. `withAccountingTransaction(assertion, fn)` is `run(appPool, { accountingAssertion }, false, fn)` — and it deliberately leaves `app.tenant_id` and `app.business_id` **empty**, because the posting primitive takes every identity from the verified assertion and setting the GUCs would suggest they were load-bearing.

This is correct for Phase 2, where a posting is the whole operation. It makes the Phase 3 composition in P3-AL-32 **impossible as written today**: a purchase receipt that called `postEntry()` would commit its stock movements in one transaction and its journal entry in another. The seam is specified in P3-AL-32 and is the first thing P3-S1 builds.

### F-4 — Two permanent predecessor assertions pin the accounting source registry to exactly three types

`accounting_source_types` is a closed registry seeded by the frozen `0042` with `opening_balance`, `manual_adjustment`, `reversal`, and `0042` itself asserts `count(*) = 3` **at its own apply time**, which is correct and does not constrain a later migration. But two *permanent* assertions do:

- `tests/integration/migration-upgrade.test.ts:457` asserts the registry equals those three after the **full** upgrade path, and
- `tests/golden-regression/phase2/01-engine-shapes.golden.test.ts:549` — "the source registry still holds exactly three".

The first Phase 3 migration that registers `inventory_adjustment` turns both red. This is precisely the situation P2-S4 §45 legislated for: **a permanent predecessor gate must evolve safely with an authorized successor, and must neither forbid the successor nor lose its own evidence.** The resolution is in P3-AL-34 and is a named work item of P3-S3, not a surprise for whoever runs the suite first.

### F-5 — Adding a trigger to `journal_entries` is already precedented

TD-09's repayment (P3-AL-36) needs a `BEFORE INSERT` trigger on a table created by a frozen migration. `0049_accounting_periods.sql` already attaches `accounting_period_guard` to `journal_entries` in exactly that way, and the upgrade test queries triggers with `tgname IN (…)` rather than asserting an exhaustive set. Adding a second guard therefore breaks nothing and modifies no frozen byte.

### F-7 — INV-ACC-11 is written with a tolerance, and Phase 3 removes it

`docs/DAFTAR_ACCOUNTING_RULES.md` §invariants states INV-ACC-11 as "GL Inventory(1200) = valuation **within tolerance**, then exact posted reconciliation". `docs/PHASE_2_ACCOUNTING_EXECUTION_PLAN.md` §69 records that the invariant is designed as a reconciliation check and **activated in Phase 3** — so Phase 3 is the phase that decides what it means.

**Decision: the tolerance is zero** (P3-AL-43). An inventory journal amount is not *converted* from the movement at posting time; it **is** the movement's stored `value_delta_base_minor` integer, summed over the operation (P3-AL-49 §A equation (3)). The reconciliation therefore compares two integers that were produced by one rounding, at the movement, in the same command and the same transaction, and it performs no arithmetic of its own that could round. An exact match is achievable by construction, and a tolerance would be exactly where a real divergence hides. The older "within tolerance" wording is superseded for Phase 3 by this document; `DAFTAR_ACCOUNTING_RULES.md` is an accepted Phase 2 page and is **not** rewritten here, because rewriting a prior decision record is not how a later phase changes a rule — naming the supersession is.

### F-8 — There is no Purchase or Stocktake state machine yet

`docs/DAFTAR_STATE_MACHINES.md` carries Order, Invoice, Payment, Installment, Subscription, Sync, Sale, Journal Entry, Opening Balance and Accounting Period. It carries **no** Purchase and **no** Stocktake. Both are defined in this lock (P3-AL-19, P3-AL-16) and are added to that page by the slice that implements each — P3-S4 and P3-S3 respectively — rather than by P3-S0, which would be documenting a state machine no code can enter.

### F-6 — The 21-account system registry already contains every account Phase 3 needs

`0040_accounting_chart.sql` seeds exactly 21 system identities and asserts the count. Phase 3 needs `inventory` (1200), `accounts_payable` (2000), `supplier_receivable` (1150), `cogs` (5000), `purchase_price_variance` (6200), `rounding` (6100), `fx_gain`/`fx_loss` (4900/6900) and `opening_equity` (3000) — **all present**. No system account #22 is required by any decision in this document (P3-AL-17).

### F-9 — There is no `payment_methods` table

`docs/DAFTAR_DATA_MODEL.md` §13 specifies `payment_methods` and `payment_method_names`, and `DAFTAR_ACCOUNTING_RULES.md` §291 binds `payment_methods.posting_account_id` to the settlement accounts, but **no migration creates either table** — the whole of §13 is still a specification. Supplier payments need it, so P3-S6 creates the minimal shared foundation and nothing beyond it (P3-AL-27). This finding is **F-9**; an earlier hand-off narrative called it "F-8", which is this document's *Purchase/Stocktake state machine* finding. Evidence identifiers are deterministic and are never reused: F-8 is the state-machine finding, here and everywhere.

---

## P3-AL-01 — Inventory source of truth

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Decision.** `stock_movements` is append-only operational truth. `stock_levels` is a **cache** per stock key, and nothing else is truth about quantity, valuation or cost.

The cache carries, at minimum:

```
on_hand                  NUMERIC(18,4)  NOT NULL   -- = Σ stock_movements.qty_delta
valuation_base_minor     BIGINT         NOT NULL   -- = Σ stock_movements.value_delta_base_minor
avg_unit_cost_base_minor NUMERIC(28,10) NULL       -- DERIVED from the two above
last_stock_seq           BIGINT         NOT NULL
```

`valuation_base_minor` is a **cache column, not a second source of truth** — the same status `on_hand` has. Truth for valuation remains `Σ stock_movements.value_delta_base_minor`, and the exactness law that makes the cache reconstructible byte-for-byte is **P3-AL-49**, which every writer and every rebuild obeys.

**Why valuation is cached rather than re-derived from `on_hand × avg`.** `avg_unit_cost_base_minor` is a rounded quotient. Measured on PostgreSQL 16: with `valuation = 1` and `on_hand = 3`, the average at `NUMERIC(28,10)` is `0.3333333333`, and `3 × 0.3333333333 = 0.9999999999` — not `1`. A live command that reconstructed its opening valuation from `on_hand × avg` would lose at that step and keep losing on every subsequent one, so the cache would drift from the movement ledger and P3-AL-42's exact rebuild and P3-AL-43's zero tolerance would both become unachievable. Caching the exact sum removes the quotient from the write path entirely.

**Why the cached valuation is `BIGINT`, not `NUMERIC(28,10)`.** Because the journal is `BIGINT` minor and **rounding is not additive**: two movements each worth an exact `0.6` minor round to `1` apiece but their sum rounds to `1`, so a fractional operational valuation and an integer GL can never agree at zero tolerance. The movement's financial value is therefore itself an integer number of base minor units and the journal line **is** that integer. The full contract, the equation and the nine acceptance vectors are **P3-AL-49**.

**What the database refuses.**

- `stock_movements` carries a `BEFORE UPDATE OR DELETE` trigger that raises unconditionally, on the pattern `audit_append_only()` already uses (`0004_infra.sql`). Append-only is proved by the trigger, not by an ACL, because an ACL is a statement about today's grantees.
- No runtime role holds `INSERT`, `UPDATE` or `DELETE` on `stock_movements` or `stock_levels`. `daftar_app` holds `SELECT` only. Every mutation is a `SECURITY DEFINER` command owned by a `NOLOGIN` internal role, exactly as `accounting_post_entry` is (P2-S3 G-4/G-5).
- `stock_levels` rows are written **only** by those commands, and every write is accompanied in the same statement by the movement that justifies it.

**What is forbidden, permanently.** `stock_levels.on_hand += …` as independent truth; a merchant-facing endpoint that writes `stock_levels`; any "repair" command that sets a cache value to a number the movements do not produce. A divergence is an alert and an investigation (P3-AL-43), never a silent correction.

**Rebuildability is a test, not a promise.** See P3-AL-42.

---

## P3-AL-02 — Movement ordering authority

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Problem.** Moving weighted average is order-dependent. `created_at` is not an ordering authority: two movements can share a timestamp, and `now()` is transaction-start time in PostgreSQL, so two concurrent receipts can carry the *same* value by construction.

**Decision.** Every movement carries `stock_seq BIGINT NOT NULL`, allocated **per stock key** `(business_id, warehouse_id, variant_id)` while that key's `stock_levels` row is held under `SELECT … FOR UPDATE`. The allocation is `stock_levels.last_stock_seq + 1`, written back in the same statement, so the sequence is gapless and strictly increasing per key and no two movements on one key can share a value.

- `UNIQUE (business_id, warehouse_id, variant_id, stock_seq)`.
- A rebuild (P3-AL-42), a stocktake boundary (P3-AL-16) and deficit FIFO (P3-AL-13) all order by `stock_seq`, never by `created_at`.
- `created_at` remains, for humans and for reports. It carries no ordering authority and no invariant depends on it.

**Why per-key and not global.** A global sequence would serialize every inventory write in the business against every other one. Weighted average is computed per stock key and never across keys, so per-key monotonicity is exactly the ordering the arithmetic needs — and it is the ordering the lock already provides for free.

---

## P3-AL-03 — Canonical stock identity

**Status: TO BE ENFORCED IN P3 · P3-S1.**

**Contradiction, stated.** `product_variants` exists since `0005` and a product may legitimately have **zero** variants today. Inventory documentation identifies stock by `variant_id`.

**Decision — binding.** Inventory operates on `product_variants` **only**. There is one stock identity model and no polymorphism: `stock_movements` and `stock_levels` reference `(business_id, variant_id)` and nothing else.

For a simple product with no merchant-defined variants, **enabling inventory tracking creates one base variant**, in the same transaction as the enablement:

- a stable UUID, generated once and never regenerated;
- `attributes = '{}'::jsonb` — the shape `0005` already gives every variant;
- `sku` and `barcode` left **NULL**, so the partial unique indexes `variants_sku_uq` / `variants_barcode_uq` cannot be shadowed by a base variant duplicating its product's identifiers;
- `is_base BOOLEAN NOT NULL DEFAULT false` with `UNIQUE (business_id, product_id) WHERE is_base` — at most one base variant per product, physically;
- price inherited (`price_minor IS NULL`), which `0005` already defines as "inherit product price".

**UI consequence.** A simple product keeps looking simple: the merchant never sees the base variant. Product identity stays catalog/presentation identity; stock identity is always variant identity (P3-AL-48). **This is a promise about the catalog API that exists today, not about a future screen** — the accepted `CatalogService.getProduct()` returns every non-archived variant row and knows nothing about `is_base`, so adding the column without changing that read would publish the hidden variant the day P3-S1 ships. The reads, the mutation boundary and their proofs are **P3-AL-52**.

**Forbidden.** `product_id OR variant_id` polymorphism in `stock_movements`; a second "simple stock" table; making `product_variants.sku` carry the product's SKU for a base variant.

---

## P3-AL-04 — Existing-product transition, with no silent backfill guess

**Status: TO BE ENFORCED IN P3 · P3-S1.**

**Facts.** `products.unit` is free text and nullable. There is no `track_inventory`, no `unit_code`, no `unit_decimals`. Existing rows carry whatever the merchant typed.

**Decision.**

1. The migration adds `products.track_inventory BOOLEAN NOT NULL DEFAULT false`, `products.unit_code TEXT NULL`, `products.unit_decimals SMALLINT NULL`. **Every existing product becomes inventory-untracked.** No stock row, no base variant and no movement is created because a migration ran.
2. `products.unit` is **not** parsed, mapped, normalized or inferred. "kg", "كغم", "Kg." and "kilo" are a human label; guessing from it would be Zero Silent Errors violated in the one place where the guess becomes financial truth.
3. Enabling tracking is an explicit merchant action requiring `inventory.adjust`, and it requires a canonical unit selection (P3-AL-05). The command creates the base variant (P3-AL-03) when the product has no variants. **Physically (Round 4):** the three columns have exactly one writer, the routine `inventory_configure_product`, owned by `daftar_inventory_internal`; ordinary `daftar_app` DML that sets or changes any of them is refused with `inventory.configuration_authority_required` even though `daftar_app` keeps its table-level `UPDATE` on `products` (P3-AL-54 §E–§F).
4. `CHECK (track_inventory = false OR (unit_code IS NOT NULL AND unit_decimals IS NOT NULL))` — a tracked product physically cannot exist without canonical units.
5. `products.unit` is retained and shown as the merchant's own free label. It is never read by inventory.

---

## P3-AL-05 — Unit / quantity contract

**Status: TO BE ENFORCED IN P3 · P3-S1.**

- Canonical quantity type: **`NUMERIC(18,4)`** everywhere (movements, levels, source lines, stocktake counts). This matches `DAFTAR_DATA_MODEL.md` §9 and is not re-litigated.
- `unit_decimals SMALLINT CHECK (unit_decimals BETWEEN 0 AND 4)`.
- A **canonical unit registry** is created as a migration-extensible table, not a closed CHECK and not a free-form string:

  ```
  units (unit_code TEXT PRIMARY KEY CHECK (unit_code ~ '^[a-z][a-z0-9_]{0,31}$'),
         default_decimals SMALLINT NOT NULL CHECK (default_decimals BETWEEN 0 AND 4),
         sort_order INTEGER NOT NULL UNIQUE)
  ```

  Seeded with the units DAFTAR actually needs now (`piece`, `kg`, `gram`, `litre`, `millilitre`, `metre`, `centimetre`, `box`, `carton`, `dozen`, `hour`). Localized display names live **outside** inventory truth, in a `unit_names (unit_code, locale, display_name)` table, on the exact pattern `payment_method_names` uses in `DAFTAR_DATA_MODEL.md` §13 and `accounting.account.<system_key>` uses in AL-06. Persistence never depends on translated text.
  `products.unit_code` is a composite-free FK to `units(unit_code)`; `unit_decimals` defaults from the registry at selection time and is then **frozen on the product**, so changing a registry default never silently reinterprets existing stock.
- **Fractional refusal is physical, and it tests the VALUE, not the storage scale.**

  **The withdrawn rule.** An earlier draft of this decision wrote the refusal as `scale(qty) > unit_decimals`. That rule is **mathematically wrong and is withdrawn**; no Phase 3 artefact may reintroduce it. `scale()` reports a value's *declared* scale, and the canonical quantity type is `NUMERIC(18,4)`, so PostgreSQL pads every stored quantity to four decimals whatever the caller wrote. Measured on PostgreSQL 16, inserting into a `NUMERIC(18,4)` column:

  | inserted | stored | `scale(q)` | `q = trunc(q,0)` | `q = trunc(q,2)` |
  |---|---|---|---|---|
  | `1` | `1.0000` | `4` | `t` | `t` |
  | `1.0` | `1.0000` | `4` | `t` | `t` |
  | `1.00` | `1.0000` | `4` | `t` | `t` |
  | `1.0000` | `1.0000` | `4` | `t` | `t` |
  | `-3.0000` | `-3.0000` | `4` | `t` | `t` |
  | `0.5` | `0.5000` | `4` | `f` | `t` |
  | `1.0001` | `1.0001` | `4` | `f` | `f` |

  `scale(q)` is `4` on every row, including exactly one piece. The withdrawn rule would therefore have refused **every** quantity on a `piece` product with `unit_decimals = 0` — not just fractional ones — and would have refused nothing at all when `unit_decimals = 4`. It tests the column, not the number.

  **The rule.** Quantity precision is **exact representability at the product's `unit_decimals`**, on the numeric value itself:

  ```
  abs(qty) = trunc(abs(qty), unit_decimals)
  ```

  — equivalently, `abs(qty) * 10^unit_decimals` is an exact integer. It is stated on the absolute value so that no implementer has to reason about which way `trunc` breaks for a negative movement quantity: the identical law governs `+3.0000` and `-3.0000`. `unit_decimals` is the value **frozen on the product** (P3-AL-04), never the registry's current default.

  **Forbidden, permanently:** `scale(qty)` as the authority; any `FLOAT`, `REAL` or `DOUBLE PRECISION` step in the test; any `::text` / `to_char` / trailing-zero-stripping formatting test; any client-side-only check. The test is exact fixed-point arithmetic in `NUMERIC` in the database and exact `BigInt` arithmetic in `@daftar/inventory`, and the two are asserted against the same vectors (P3-AL-08).

  **Bound vectors.** These are the locked acceptance vectors, not examples:

  | `unit_decimals` | quantity | verdict |
  |---|---|---|
  | 0 | `1` | VALID |
  | 0 | `1.0000` | VALID |
  | 0 | `-3.0000` | VALID wherever a negative quantity is allowed by the movement's `qty_sign` (P3-AL-10) |
  | 0 | `0.5` | INVALID |
  | 0 | `1.0001` | INVALID |
  | 2 | `1.23` | VALID |
  | 2 | `1.2300` | VALID |
  | 2 | `1.234` | INVALID |
  | 2 | `0.0001` | INVALID |
  | 4 | `1.2345` | VALID |

  **Refusal:** `inventory.quantity_precision_invalid`, stable, carrying no financial values.

  **Where it lives, and why not a row CHECK.** The refusal is in the trusted `SECURITY DEFINER` command, under the stock key's lock, alongside every other quantity law. It cannot be a row `CHECK` on `stock_movements`, because the permitted precision is a property of a **different row** — the product — and a `CHECK` may not read another table. The command is still the database: no application-layer or form validator is the authority, and a movement that reaches the command with an unrepresentable quantity is refused before any row is written. This is a real limit of the mechanism, stated rather than papered over, and it is exactly the class of gap P3-AL-51's completeness guards exist to close for source identity.
- **No conversions in Phase 3.** 1 kg is never silently 1000 g. `units` carries no conversion factor and no base-unit column, because a column that exists is a column a later slice will populate and a later query will trust. UoM conversion is a future capability with its own decision.

### §D — The canonical unit history lock (Round 3)

**The defect.** "Frozen on the product" was a statement with no lifecycle behind it. `stock_movements` stores `qty_delta` and deliberately does **not** snapshot `unit_code` or `unit_decimals` (P3-AL-11), so a historical quantity takes its meaning from the product's *current* canonical unit. If a product with movement history is changed from `piece` to `kg`, or `unit_decimals` from `0` to `3`, then every historical row silently means something else — the same number, a different fact. No row is edited and no guard fires. That is historical corruption, and it is worse than an error because it leaves no trace.

**Why snapshotting the unit is not the answer.** Copying `unit_code`/`unit_decimals` onto every movement would let two movements of one variant disagree about what a quantity *is*, and `on_hand = Σ qty_delta` would then be a sum over incommensurable units. The ledger must have one unit per stock identity, forever. So the unit is locked, not versioned.

**The law — binding.**

- **Before a product has any stock movement, for any of its variants**, its canonical unit configuration may be changed through the authorized inventory configuration command. This includes a product that is already `track_inventory = true`: enabling tracking is configuration, and nothing has been measured yet, so a merchant who picked the wrong unit a minute ago may fix it.
- **From the first stock movement of any variant of that product onward**, `products.unit_code` and `products.unit_decimals` are **IMMUTABLE FOREVER**.
- Current `on_hand` reaching zero does **not** unlock them. Disabling tracking does **not** unlock them. Re-enabling tracking reuses the same historical canonical unit and offers no choice.
- `products.unit` — the Phase 1 free-text label at `0005_catalog.sql:23` — stays presentation-only and may keep changing, because inventory never reads it (P3-AL-04 §2/§5).
- **Changing a historical product from `piece` to `kg` is not a conversion. It is forbidden.** Phase 3 invents no unit conversion (see the bullet above). The merchant's route is a new product.

**Refusal:** `inventory.unit_identity_locked`, stable, carrying no quantities.

**The mechanism and its owning slice.** A `BEFORE UPDATE ON products FOR EACH ROW` trigger that raises when `unit_code` or `unit_decimals` changes and any `stock_movements` row exists for any variant of that product. **Name, rights and order are fixed by P3-AL-54 §G (Round 4):** `products_20_unit_history_lock`, `SECURITY DEFINER` owned by `daftar_inventory_internal` so that it sees every movement of the product whoever asks, firing **after** P3-S1's `products_10_inventory_config_authority`. The authority guard answers *who*; this lock answers *when*; neither replaces the other.

- **P3-S1** creates `unit_code` / `unit_decimals`, the tracking-enablement and unit-configuration command, and the command-level refusal.
- **P3-S2** installs the physical trigger, because a trigger body cannot reference `stock_movements` before that table exists, and P3-S2 is the slice that creates it.
- The window between them is provably empty, not merely short: before P3-S2 there is no `stock_movements` table, so the set of products with history is empty and there is nothing the guard could have refused. The window closes **before** P3-S3, which is the first slice authorized to produce a real movement, and P3-S2's acceptance asserts the trigger's presence from `pg_trigger` by name.
- **Not the UI.** Hiding the field is not the mechanism; a runtime SQL defect, a future admin path or a later service must meet the same refusal.

**Lifecycle, stated case by case so no implementer has to infer it.**

| Situation | Canonical unit | Tracking flag |
|---|---|---|
| Untracked, no history | selectable when tracking is enabled | may be enabled |
| Tracked, **no** movement yet | **may still be changed** deliberately, through the configuration command | may be disabled freely |
| Tracked, movements exist, `on_hand > 0` | **locked** | cannot be disabled (P3-AL-41) |
| Tracked, movements exist, `on_hand = 0` | **locked** — history is history | may be disabled (P3-AL-41 allows it at zero) |
| Re-enabled after being disabled | the historical `unit_code` / `unit_decimals` are reused; no choice is offered | may be re-enabled |
| `units.default_decimals` changed by a later migration | **no effect** — `unit_decimals` is persisted on the product at selection, and the registry default is only the initial suggestion | unaffected |

**The permanent unit regression matrix.**

| # | Case | Required outcome | Owning slice |
|---|---|---|---|
| 1 | Untracked, no history: select a canonical unit | allowed | P3-S1 |
| 2 | Tracked, no movement: change `unit_code` | **allowed** — the chosen rule, tested so it is a decision and not an accident | P3-S1 |
| 3 | After the first movement: change `unit_code` | **REFUSED**, `inventory.unit_identity_locked`, through the command **and** as raw SQL | P3-S2 |
| 4 | After the first movement: change `unit_decimals` | **REFUSED**, same code, both paths | P3-S2 |
| 5 | Stock returns to zero, movements remain: change either | **REFUSED** | P3-S2 |
| 6 | Tracking disabled at zero, then re-enabled | the historical canonical unit is unchanged and is not re-asked | P3-S2 |
| 7 | Change `products.unit` (free label) on a product with history | **allowed**, and no inventory number changes | P3-S1 |
| 8 | A later migration changes `units.default_decimals` | existing products keep their persisted `unit_decimals` | P3-S2 |

---

## P3-AL-06 — Stock-key first-row concurrency

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Decision.** Exactly one `stock_levels` row per `(business_id, warehouse_id, variant_id)`, enforced by the primary key. Every command that touches a stock key runs the same three steps, in this order, inside the caller's transaction:

1. `INSERT INTO stock_levels (…) VALUES (…, 0, 0, NULL, 0) ON CONFLICT (business_id, warehouse_id, variant_id) DO NOTHING;` — `on_hand = 0`, `valuation_base_minor = 0`, `avg_unit_cost_base_minor = NULL`, `last_stock_seq = 0`;
2. `SELECT … FROM stock_levels WHERE … FOR UPDATE;` — always, even when step 1 inserted the row;
3. compute → append movement → update cache.

`ON CONFLICT DO NOTHING` followed by an unconditional locking read is what makes the missing-row race safe: the loser of the insert race blocks on the winner's row lock and then reads the winner's state. A check-then-insert is forbidden, and so is `ON CONFLICT DO UPDATE` with a computed value, because that would perform arithmetic outside the lock.

`stock_levels` rows are **never deleted**. A key that reaches zero keeps its row, its `last_stock_seq` and its `avg_unit_cost_base_minor`, because deleting it would restart the sequence and lose the cost reference a later movement may need. A zero-quantity key's `valuation_base_minor` is **exactly `0`** — the retained average is a cost reference, never remaining asset value (P3-AL-49).

---

## P3-AL-07 — Multi-key lock ordering

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Decision.** One canonical lock order for the whole system: the affected stock keys are sorted ascending by the tuple `(warehouse_id, variant_id)` compared as `uuid`, and locked in that order. `business_id` is constant within a command, so it does not participate in the comparison.

- Every command sorts — transfers, multi-line purchases, multi-line adjustments, stocktake finalization, supplier returns.
- A caller's payload order is **never** the lock order. The sort happens after the payload is parsed and before any lock is taken.
- Transfers `A → B` and `B → A` running concurrently therefore acquire the same two rows in the same order and one waits; they cannot deadlock.
- A deadlock is a lock-order defect, never a business outcome and never a retry policy. Phase 2 established this (`daftar-lock-order-not-retry`); Phase 3 does not re-open it.

**Proof obligation.** Two real connections, in the same test, performing opposite transfers — not a mocked scheduler.

---

## P3-AL-08 — Exact inventory cost arithmetic

**Status: TO BE ENFORCED IN P3 · P3-S2.**

- Authoritative cost: **`NUMERIC(28,10)`**. Authoritative quantity: **`NUMERIC(18,4)`**. `FLOAT`, `REAL` and `DOUBLE PRECISION` appear nowhere, and the existing guard `scripts/guards/no-float-rate.ts` is extended to the inventory tables.
- A new framework-agnostic package **`@daftar/inventory`** owns the arithmetic, exactly as `@daftar/accounting` owns money and FX. It imports no web framework, no Nest symbol and no configuration. It owns: the weighted-average formulas, the landed-cost allocator, the deficit catch-up computation and the canonical rounding boundary.
- **TypeScript arithmetic is fixed-point `BigInt`**, never binary floating point: cost is carried as an integer number of `10^-10` units and quantity as an integer number of `10^-4` units. A `number` never holds an authoritative cost or quantity anywhere in the package.
- **One rounding boundary, one mode.** All arithmetic *before* a value is persisted is exact. When an exact result must be persisted to `NUMERIC(28,10)`, it is rounded **HALF_EVEN at that persistence boundary and nowhere else**. There is no intermediate rounding, at any step, for any reason.
- **“Exact” does not mean “unrounded on the way into the row.”** Quantity carries 4 decimals and unit cost 10, so the raw product `qty × unit_cost` can carry 14 — an exact product is not representable at any fixed scale in the general case, and an earlier draft's “the exact `qty × unit_cost` product” was, read literally, impossible. The persistence boundary for a movement's value is named exactly, once, in **P3-AL-49 §A/§C**: `value_delta_base_minor` is an **integer number of base minor units**, produced by one HALF_EVEN at that movement (or by a document's largest-remainder share, or by the depletion flush, or by copying a transfer's paired value). After that row exists, the **stored** value is the authority and is never recomputed.
- PostgreSQL agrees by construction: the trusted commands compute in `NUMERIC` and the one `round(x, 10)` call sits at the same boundary. PostgreSQL's `round(numeric, int)` is HALF_UP, not HALF_EVEN, so the commands use an explicit HALF_EVEN helper rather than `round()` — this is the exact tie-breaking trap the directive names, and it is closed by writing the helper, not by assuming.
- Conversion to `BIGINT` minor units for a journal line remains the **accepted Phase 2 contract**: HALF_EVEN, once, at posting time, with the residue distributed largest-line-first and any remainder to `6100 Rounding Adjustment`. Phase 3 does not re-implement it and does not add a second money rounding.
- **An inventory movement's journal amount performs no conversion at all**, because `value_delta_base_minor` is already `BIGINT` minor (P3-AL-49). There is therefore no residue on an inventory leg and **no `6100` line on an inventory posting**. That is not an exception to the Phase 2 contract; it is that contract with nothing left to convert, which is exactly why Inventory ↔ GL can be zero-tolerance.
- **Shared vectors.** `@daftar/inventory` ships exact worked vectors, asserted identically in TypeScript and in SQL, for: moving weighted average on receipt; transfer (source average unchanged, destination recomputed, total valuation delta exactly zero); positive adjustment; negative adjustment; supplier-return PPV; negative-deficit catch-up. The bound examples already in `DAFTAR_INVENTORY_RULES.md` (GOLD-44, GOLD-54, GOLD-55, GOLD-72) are the first four vectors and are not restated with different numbers here.

---

## P3-AL-09 — Stock movement source identity

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Problem.** `UNIQUE (business_id, source_type, source_id)` is the *accounting* identity and is wrong for inventory: one purchase has many items, and one transfer line produces two movements.

**Decision.** Inventory movement identity is the five-part tuple

```
UNIQUE (business_id, source_type, source_id, source_line_id, movement_kind)
```

where `source_type` is the source document kind, `source_id` the document, `source_line_id` the document's own line (`NOT NULL`, always a real line — purchases, adjustments, transfers, stocktakes and supplier returns all have lines), and `movement_kind` the reason from the closed registry (P3-AL-10), which is what separates `transfer_out` from `transfer_in` for one logical line.

**No polymorphic FK.** `stock_movements` holds **no** foreign key into any domain table. A future domain therefore adds a `source_type` value and its own line table and needs no change in `stock_movements`.

**Idempotency.** A retried command cannot produce a second movement for one source line: the unique tuple refuses it. This is physical, not a cache lookup.

**What this tuple does NOT prove, and where that is closed.** The unique tuple proves *at most one* movement per source line. It proves nothing about whether the movement's source is real. “The same command creates both rows in one transaction” is a statement about today's code, not a physical invariant — it is exactly the class of claim the withdrawn wording above made, and the class this document exists to replace with a refusal. Three properties are therefore **not** established here and are established by their own decisions:

- `source_type` is an authorized identity → **P3-AL-50** (a closed `stock_source_types` registry; `source_type` is an FK into it and free-form text is physically impossible).
- the source document and the source line exist, and the finalized source line has every movement it is required to have → **P3-AL-51** (generic source binding plus deferred completeness guards, on the AL-01 pattern, with no polymorphic FK).
- the source's financial and stock identity is immutable after posting, and the source line cannot be deleted out from under its movement → **P3-AL-51**.

---

## P3-AL-10 — Movement reason registry

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Decision.** `movement_kind` is a **closed registry table**, `stock_movement_kinds`, not a CHECK list and not free text — the same shape as `accounting_source_types`, for the same reason: adding one is a migration, never a string.

Registered by Phase 3, because Phase 3 implements them:

`purchase` · `supplier_return` · `adjustment` · `damage` · `transfer_out` · `transfer_in` · `stocktake` · `inventory_opening` · `negative_inventory_cost_adjustment` · `purchase_reversal`

**Not registered by Phase 3:** `sale`, `return`, `offline_oversell_exception`. Those belong to the phases that own the workflows (Phase 4, Phase 7) and pre-registering them would advertise a capability that does not exist. The schema reserves nothing for them beyond the registry's own extensibility.

Each registered kind carries its physical semantics as data: `qty_sign ∈ {positive, negative, zero, either}` and `requires_reason BOOLEAN`, checked by the trusted command. `damage` is negative and requires a reason; `adjustment` is either and requires a reason; `negative_inventory_cost_adjustment` is `zero` (P3-AL-11).

---

## P3-AL-11 — Value-only cost movement

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Problem.** `qty_delta + unit_cost` cannot express a movement that changes valuation and not quantity, which is exactly what `negative_inventory_cost_adjustment` is. Encoding it as a fake quantity would corrupt the quantity ledger to fix the value ledger.

**Decision.** A movement carries **both** components explicitly:

```
qty_delta               NUMERIC(18,4)  NOT NULL             -- may be exactly 0
unit_cost_base_minor    NUMERIC(28,10) NULL                 -- SNAPSHOT for trace; NULL for value-only
value_delta_base_minor  BIGINT         NOT NULL             -- AUTHORITATIVE; signed; may be 0 only if qty_delta <> 0
CHECK (NOT (qty_delta = 0 AND value_delta_base_minor = 0))
CHECK ((qty_delta = 0) = (unit_cost_base_minor IS NULL))
```

- A **quantity movement** states `qty_delta <> 0` and `unit_cost_base_minor`, and its integer `value_delta_base_minor` is computed and stored by the command (never by the caller) by the rule for its kind in **P3-AL-49 §C** — a priced document's largest-remainder share, one HALF_EVEN at this movement, the full-depletion flush, or the exact negation of a paired `transfer_out`. An outbound movement's `unit_cost_base_minor` snapshot is the key's current average, an inbound movement's its own cost — that asymmetry is the weighted-average rule and is stated once, here. The average **may** be that costing input; what it may never be is a way to reconstruct total valuation (P3-AL-49 §B). The `unit_cost_base_minor` column is a **snapshot for trace and reporting**; `value_delta_base_minor` is the **authoritative valuation amount**, and the two are not interchangeable, and need not satisfy `value = qty × unit_cost` after rounding.
- A **value-only movement** states `qty_delta = 0`, `unit_cost_base_minor IS NULL` and a signed `value_delta_base_minor`.

**Rebuild is defined for both ledgers.** For a stock key, `on_hand = Σ qty_delta` and `valuation_base_minor = Σ value_delta_base_minor`, both ordered by `stock_seq`, and `avg_unit_cost_base_minor = HALF_EVEN(valuation_base_minor / on_hand, 10)` where `on_hand <> 0`. Both sums are over **stored** values and involve no multiplication and no rounding, which is why they are exact; the average is the only rounded quantity and is never used to reconstruct valuation (P3-AL-49 §B). Quantity and valuation are therefore each reconstructable from the movements alone, which is what makes `stock_levels` a cache rather than a second truth.

---

## P3-AL-12 — Negative-inventory boundary

**Status: TO BE ENFORCED IN P3 · P3-S2 (entities) and P3-S4 (coverage).**

**Decision.** **No Phase 3 command may drive a stock key negative.** `supplier_return`, `transfer_out`, `damage` and negative `adjustment` each refuse when the requested quantity exceeds `on_hand` at the locked row, with a stable `inventory.insufficient_stock`. The refusal is in the trusted command, under the lock, not in a service.

Phase 3 registers **no negative producer at all**: `sale` and `offline_oversell_exception` are not in the movement registry (P3-AL-10), and the explicit "allow negative stock" business policy is a Phase 4 sales decision that Phase 3 does not create, does not read and does not store.

**But the deficit entities belong to the inventory core**, because purchase receipt — a Phase 3 operation — is what eventually covers a deficit, and retrofitting coverage into the receipt command later would be the inventory-core rewrite this decision exists to prevent. Therefore:

- **P3-S2** creates `negative_inventory_deficits` and `negative_deficit_coverages` exactly as `DAFTAR_DATA_MODEL.md` §10ب already specifies them, including `deficit_seq`, and allocates `deficit_seq` under the same stock-key lock as `stock_seq`.
- **P3-S4** implements coverage inside the receipt command (P3-AL-13), registers `negative_inventory_cost_adjustment` as an accounting source type, and proves the path with deficits seeded **by the schema owner in the test database** — a legitimate test mechanism (§55 forbids a production failpoint, not a test fixture), and the only honest way to test a path no Phase 3 merchant command can reach.

This is stated plainly so nobody later reads the dead branch as evidence that Phase 3 sells short.

---

## P3-AL-13 — Deficit FIFO

**Status: TO BE ENFORCED IN P3 · P3-S2 (ordering) and P3-S4 (coverage).**

**Decision.** Open deficits are covered oldest-first by `(deficit_seq ASC, id ASC)` per `(business_id, warehouse_id, variant_id)`. `created_at` is never the FIFO key, and the tie-break is the primary key rather than anything a clock produces.

Coverage runs inside the purchase-receipt transaction, in this order, under the stock key's row lock:

1. lock the open deficit layers `FOR UPDATE` in FIFO order;
2. cover `min(uncovered_qty, remaining receipt qty)` per layer, writing a `negative_deficit_coverages` row that snapshots the layer's `provisional_unit_cost_base_minor` and the receipt's `actual_unit_cost_base_minor`;
3. append one value-only `negative_inventory_cost_adjustment` movement per coverage, with `value_delta_base_minor = HALF_EVEN(exact(qty_covered × (actual − provisional)), 10)`, signed — the P3-AL-49 persistence boundary, applied per coverage and never to an aggregate that is then split;
4. post **one** catch-up journal entry for the whole adjustment (`Dr COGS / Cr Inventory` when actual > provisional, reversed when actual < provisional) whose amount is the sum of the **stored** coverage movement values, in the **same** transaction, through the accounting-aware seam of P3-AL-32;
5. apply the normal weighted average to whatever receipt quantity remains after the deficit reaches zero.

**Coverage identity — corrected, because one purchase line can cover many layers.** A single receipt line may cover two, three or twenty deficit layers, and every coverage is its own value-only movement (step 3). If all of them carried `source_id = purchase`, `source_line_id = purchase_line` and `movement_kind = negative_inventory_cost_adjustment`, then P3-AL-09's unique tuple would admit **exactly one** of them and refuse the rest — the identity that exists to prevent duplicates would silently cap a real financial correction. That collision is real and is closed here, not left to the implementer.

**The model.** A receipt that covers deficits creates its own source document, with a header and one immutable detail row per coverage:

```
negative_inventory_cost_adjustments         -- header: one per receipt operation that covers anything
  (business_id, id, warehouse_id, origin_source_type, origin_source_id, origin_source_line_id, …)

negative_deficit_coverages                  -- detail: one per (deficit layer × covering line), immutable
  (business_id, id, adjustment_id, deficit_id, variant_id, qty_covered,
   provisional_unit_cost_base_minor, actual_unit_cost_base_minor, …)
```

Every coverage movement therefore carries:

| component | value |
|---|---|
| `source_type` | `negative_inventory_cost_adjustment` (registered in `stock_source_types`, P3-AL-50) |
| `source_id` | the **adjustment header** id |
| `source_line_id` | the **coverage detail** id — the coverage *is* the line identity |
| `movement_kind` | `negative_inventory_cost_adjustment` |

Each coverage now has a distinct physical movement identity, so no coverage can collide with another and none can be dropped. Retry stays physical and idempotent: a replayed receipt reproduces the same header and the same detail ids from its own idempotency contract, and the unique tuple refuses the second movement per coverage.

**The two completeness guards apply at different grains, deliberately.** The **accounting** source binding (AL-01) binds the one catch-up journal entry to the **header**, so the ledger has one comprehensible economic source for one economic event. The **stock** source completeness guard (P3-AL-51) binds **every detail** to **its** movement, so the operational trace is exact per deficit layer. One journal entry, N movements, both physically complete — and neither guard is weakened to accommodate the other.

**Concurrency.** Two concurrent receipts cannot cover the same quantity: both must hold the stock key's `stock_levels` row before they may read a deficit layer, so they are serialized by P3-AL-06's lock before FIFO is even consulted. The `FOR UPDATE` on the layers is the second line of defence, not the first.

---

## P3-AL-14 — Transfers

**Status: TO BE ENFORCED IN P3 · P3-S3.**

**Decision.** A transfer line produces an **atomic pair** of movements sharing one `source_id` and one `source_line_id`, distinguished by `movement_kind`:

- `transfer_out` at the **source** key: `on_hand -= qty`; its `value_delta_base_minor` is computed **once**, by the ordinary outbound rule of P3-AL-49 — which means the residual flush when the transfer empties the source key. The source average is **unchanged** — an outbound quantity carries value away but creates no new cost.
- `transfer_in` at the **destination** key: `on_hand += qty`; its `value_delta_base_minor` is **defined as the exact negation of the stored `transfer_out` value**, not recomputed. `unit_cost_base_minor` carries the source-average snapshot for trace only. The destination then recomputes its own average from its new cached valuation (P3-AL-49 §A).

**The value is computed once and copied, never computed twice.** Computing `qty × avg_source` independently at both ends and rounding each would give two values that need not be negatives of each other, and the difference would be inventory created or destroyed by a warehouse move. So:

```
transfer_out.value_delta_base_minor  = V        (V < 0, by P3-AL-49)
transfer_in.value_delta_base_minor   = -V       (exactly, by definition)
Σ over the pair                      = 0        (exactly, by construction)
```

Total business inventory valuation is therefore provably unchanged — **by construction rather than by luck of rounding** — which is the invariant the test asserts (GOLD-44 is the bound vector, and P3-AL-49 §D vector C is the full-source-depletion case).

**Accounting decision — locked.** A same-business warehouse-to-warehouse transfer creates **no journal entry**. `Inventory(1200) → Inventory(1200)` within one business at identical total valuation is a movement of a physical thing, not an economic event; a zero-effect entry would be noise in every report forever. The transfer still creates stock movements, an audit event and an outbox event, all in one transaction.

**Cross-business transfer is forbidden**, physically: both keys carry `business_id` and the command resolves both warehouses within the caller's single business scope. A transfer between businesses is a sale and a purchase between two legal entities, and inventing it as a warehouse move would create inventory from nothing in one set of books and destroy it in another.

---

## P3-AL-15 — Warehouse authorization, and the lifecycle that keeps it true

**Status: TO BE ENFORCED IN P3 · P3-S1.**

**Decision.** A new business-scoped association table:

```
branch_warehouses (business_id, branch_id, warehouse_id,
                   PRIMARY KEY (business_id, branch_id, warehouse_id),
                   FOREIGN KEY (business_id, branch_id)    REFERENCES branches   (business_id, id) ON DELETE CASCADE,
                   FOREIGN KEY (business_id, warehouse_id) REFERENCES warehouses (business_id, id) ON DELETE CASCADE)
```

- A central warehouse may serve many branches; a branch may use many warehouses.
- **Seeded** from `warehouses.branch_id`, which F-1 establishes is NOT NULL: every existing warehouse starts associated with its home branch and nothing changes for any existing business on the day the migration runs.
- `warehouses.branch_id` is **not** altered, dropped or nullable-ised. It keeps its meaning as the warehouse's home branch and its composite FK; `branch_warehouses` is the **authorization** relation and the only one Phase 3 reads for authority.
- `warehouses.is_default` (one per business) remains a **UX default only**. It is not authority, and no command infers permission from it. `branches.default_warehouse_id` does not exist and Phase 3 does not create it.

**The rule.** For an actor whose membership is `branch_scope_mode = 'assigned'`, an inventory action on a warehouse is allowed only when that warehouse is associated, through `branch_warehouses`, with **at least one** branch in the actor's `member_branch_scopes` set. For `branch_scope_mode = 'all'`, any warehouse of the business is allowed.

### §A — The home-branch association invariant, and why a backfill alone is a regression

**The defect (Round 3).** The first draft specified only the backfill. A backfill is a statement about the day the migration runs; it says nothing about tomorrow. A warehouse created **after** P3-S1 would carry no `branch_warehouses` row, and the authority rule above reads that table and nothing else — so an assigned-scope actor would be unable to reach a warehouse that an existing, unchanged, successful Phase 1 workflow had just created for them. Phase 3 would have *caused* that. A capability that silently narrows on the next row written is not an authorization model.

**What repository inspection found — there are three warehouse writers, not two.** The review named two. There is a third, and it is the one that decides the mechanism:

| # | Writer | Evidence | Can a Phase 3 service `INSERT` be added to it? |
|---|---|---|---|
| 1 | `StructureService.createBranch()` — branch **plus** its default warehouse | `apps/api/src/modules/tenancy/structure.service.ts:54–61` | Yes |
| 2 | `StructureService.createWarehouse()` | `apps/api/src/modules/tenancy/structure.service.ts:96` | Yes |
| 3 | **`provision_create_business(...)`** — the business's first branch **and** `'Main warehouse'` | `infrastructure/database/migrations/0033_provisioner_atomic_authority.sql:160–164` | **No.** It is a `SECURITY DEFINER` routine inside a **frozen** migration, and it runs as the provisioning principal during onboarding, before any Phase 3 service code is on the call path. |

Writer 3 settles the argument the review left open ("prefer physical database enforcement"). It is not a preference here, it is the only option that covers every writer: **every business ever created runs writer 3**, so a rule enforced in Phase 3 service code would be violated by the very first warehouse of every new business.

**The invariant — binding.** For every row of `warehouses`, a row

```
(warehouses.business_id, warehouses.branch_id, warehouses.id)
```

MUST exist in `branch_warehouses`. This holds while the warehouse row exists, **whatever its `status`** — an archived warehouse keeps its history and its reports, so it keeps its authorization row. It is released only by deleting the warehouse itself, which today happens only through `ON DELETE CASCADE` from `businesses`; no command deletes a warehouse (`P3-AL-41`).

**The mechanism — four objects, all in the P3-S1 migration, on the precedent already in the tree.**

1. **Maintainer** — `AFTER INSERT ON warehouses FOR EACH ROW`, ordinary (non-deferred) trigger:
   `INSERT INTO branch_warehouses (business_id, branch_id, warehouse_id) VALUES (NEW.business_id, NEW.branch_id, NEW.id) ON CONFLICT DO NOTHING`.
   The home association is **derived data, not input**: it is `warehouses.branch_id` restated in the authorization relation, and no human decides it. So maintaining it in the schema is not "silent repair" of an error — it is keeping a projection true for every writer, present and future, including writer 3 and including any writer added after this document is forgotten. This is the same reasoning as G-4: discover the writers from the schema rather than naming them.
2. **Completeness proof** — `CREATE CONSTRAINT TRIGGER warehouses_require_home_branch AFTER INSERT ON warehouses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW`, raising when the home row is absent at `COMMIT`. This is what makes the invariant an invariant rather than a convenience: it still fails loudly if the maintainer is ever dropped, disabled or bypassed. Exact shape of `products_require_translation` in `0036_catalog_translations_normalized.sql:107–109`.
3. **Keep-one** — `CREATE CONSTRAINT TRIGGER branch_warehouses_keep_home AFTER DELETE OR UPDATE ON branch_warehouses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW`, raising when the row removed or changed was the home association of a warehouse that still exists. Exact shape of `product_translations_keep_one` in the same file, lines 110–112. Stable refusal: `inventory.home_branch_association_required`.
4. **Home immutability** — `BEFORE UPDATE ON warehouses`, raising when `branch_id` changes. Stable refusal: `inventory.warehouse_home_branch_immutable`. A home-branch move would silently re-authorize the warehouse's whole history to a different branch, and Phase 3 offers no command that needs it. Moving authority is done by **adding** an association (§B), never by rewriting the home one.

The P3-S1 migration asserts its own model from the catalogues — `pg_trigger` must show all four by name on the expected tables — in the same way `0040`/`0042` assert their privilege model, so a future migration cannot quietly drop one.

**Why not a `CHECK`, an FK, or a service-level `INSERT`.** A `CHECK` cannot read another table. An FK from `warehouses` to `branch_warehouses` would invert the dependency and still could not express "the row whose `branch_id` equals mine". A service-level `INSERT` cannot reach writer 3 at all.

**Who these objects run as (Round 4).** Fixed in P3-AL-54 §I. The maintainer, the completeness proof and the keep-one trigger are `SECURITY DEFINER`, owned by `daftar_inventory_internal`; the immutability trigger is `SECURITY INVOKER`. Writer 3 runs as `daftar_platform`, so an invoker-rights maintainer would have required a platform grant on `branch_warehouses`; definer rights mean **neither `daftar_platform` nor `daftar_provisioner` receives any privilege on `branch_warehouses`**. The table has `ENABLE` + `FORCE` row-level security with the same two-policy layering as `warehouses` (`0006_rls.sql:28–49`), and `daftar_app` holds `SELECT` on it and nothing else.

### §B — Who may add or remove the other associations

**The gap.** "One warehouse may serve many branches" was schema-only: nothing said who writes those extra rows, so the first implementer would have invented an authorization rule for an authorization table.

**The contract — binding.** Adding or removing a **non-home** association requires **both**:

- the existing `warehouse.manage` permission; **and**
- `branch_scope_mode = 'all'` on the acting membership.

**Why the scope condition is not redundant.** The tempting rule — "allow it if the actor can already reach both sides" — is a **self-escalation primitive**. An assigned-scope actor who holds `warehouse.manage` and is assigned to branch B could associate any warehouse of the business with B and thereby grant *themselves* reach over stock they were never scoped to. The check that would have to stop that is a check about the actor's own future authority, which is exactly the kind of reasoning that goes wrong once. Requiring business-wide scope removes the question: an actor who can already reach every warehouse gains nothing by writing an association. This mirrors `createBranch`, which already refuses an assigned-scope actor for the same reason (`structure.service.ts:45–47`).

**The command contract.**

- Both targets are resolved inside one business; the composite FKs make a cross-business pair physically impossible, and the command fails clean rather than relying on the constraint's message.
- Adding refuses an **archived** branch or warehouse (`branch_archived` / `warehouse_archived`), the same way `createWarehouse` already refuses an archived branch (`structure.service.ts:91–94`).
- Adding is **idempotent**: an association that already exists is a success with no second row and no second audit event (`ON CONFLICT DO NOTHING`, then report "already associated").
- Removing refuses the home association while the warehouse exists — refused twice, by the command and by the keep-one trigger of §A. A command-level refusal alone would be a convention (a rule only the wrapper enforces is not an invariant while a trusted primitive can still write the row).
- Both are **audited** through the existing `AuditService.recordTx` in the same transaction, actions `structure.warehouse_branch_associated` / `structure.warehouse_branch_dissociated`.

**The physical path (Round 4).** The two commands do their permission and scope checks in the application, then call `structure_associate_warehouse_branch` / `structure_dissociate_warehouse_branch` inside `withBusinessTransaction` (P3-AL-54 §E). `daftar_app` has no `INSERT` or `DELETE` on `branch_warehouses`, so raw DML cannot add or remove an association; the routines re-enforce every structural rule above (one business, both rows exist, neither archived, home not removable, idempotent) and take the business from `app.business_id`, never from an argument.

**Ownership — stated, because "schema-only theory" was the review's objection.** **P3-S1 creates the real callable domain path**: the two commands on the existing Structure domain, their controller routes, their permission checks and their tests. **P3-S7 adds only the UI.** No later slice's authorization may depend on a capability that has no caller — and P3-S2 onward read `branch_warehouses` for authority, so the write path must exist before they do.

*This does not conflict with P3-AL-32's Round 2 re-scoping of P3-S1.* That re-scoping removed **inventory** entities (transfer, purchase, stock tables) from P3-S1's acceptance. `branch_warehouses` is a tenancy/authorization table that P3-S1 has owned since the first draft of the execution plan, and the transaction-seam proofs stay exactly as P3-AL-32 leaves them.

### §C — The permanent warehouse regression matrix (P3-S1 acceptance)

Each row is a permanent test, not a one-off check.

| # | Case | Required outcome |
|---|---|---|
| A | A warehouse existing before the migration | after the migration it has **exactly** its home association and no other |
| B | `createBranch()` | branch + default warehouse + the home association commit **atomically**; a failure anywhere leaves none of the three |
| C | `createWarehouse()` | warehouse + home association commit atomically |
| D | Home-association creation forced to fail (maintainer removed in the test transaction) | warehouse creation **rolls back** — this is the test that proves object 2 of §A is load-bearing rather than decorative |
| E | Assigned-scope actor with no association to the warehouse | cannot reach it; stable `inventory.warehouse_out_of_scope` |
| F | Assigned-scope actor with `warehouse.manage` attempts to associate a warehouse with a branch they are assigned to | **REFUSED** — the self-expansion case |
| G | Business-wide actor with `warehouse.manage` adds a valid extra association | allowed, audited, idempotent on repeat |
| H | Association naming a branch of business X and a warehouse of business Y | **refused by the database**, not only by the command |
| I | Deleting the home association while the warehouse exists | **REFUSED** by the keep-one trigger, tested as raw SQL as well as through the command |
| J | Deleting a non-home association, authorized | allowed, and the home mapping is still present afterwards |
| K | Existing Phase 1 warehouse list / create / archive behaviour | **no regression** — the accepted golden and integration suites still pass unchanged |
| L | Maintainer forced to fail inside `provision_create_business` | the **whole onboarding** rolls back — no tenant, business, branch or warehouse survives (Round 4) |
| M | `INSERT` or `DELETE` on `branch_warehouses` as raw SQL as `daftar_app` | **REFUSED** by privilege (`42501`), whatever the row (Round 4) |

A new business created through the accepted provisioning flow **after** the migration is covered by B and C through writer 3, and is asserted explicitly: `provision_create_business` still succeeds, and its `'Main warehouse'` has its home association without that frozen routine being modified.

---

## P3-AL-16 — Stocktake concurrency

**Status: TO BE ENFORCED IN P3 · P3-S3.**

**Decision — snapshot-delta.** No database transaction is held open while a human counts, and no warehouse is frozen by row locks.

Per counted line, at **capture**:

```
expected_qty_at_capture NUMERIC(18,4)   -- on_hand read at capture
captured_at_stock_seq   BIGINT          -- stock_levels.last_stock_seq at capture
counted_qty             NUMERIC(18,4)
variance_qty            NUMERIC(18,4) GENERATED ALWAYS AS (counted_qty - expected_qty_at_capture) STORED
```

Movements continue freely between capture and finalization. At **finalization**, in one transaction, under the stock-key locks in canonical order, the recorded `variance_qty` is applied **once** against current state. This is correct for quantity because any movement after the capture point changes the counted world and the system world identically.

**Valuation is recognized at finalization**, at the key's current average cost then — never by rewriting historical average cost, which would change the cost of sales that already happened.

**Positive variance with no current cost.** When a positive variance lands on a key with `on_hand = 0` and no `avg_unit_cost_base_minor`, there is no cost to value it at. The command **refuses** with `inventory.unit_cost_required` and the merchant must supply an explicit unit cost, which is audited. Zero is never invented: a zero-cost unit silently poisons every later weighted average on that key.

**State machine — minimal.** `draft → finalized`, and `draft → cancelled`. There is no `reopened`, no `partially_finalized` and no `approved`. A finalized stocktake is immutable: its lines refuse `UPDATE` and `DELETE` by trigger, its variance movements exist, and a retry of the finalize command returns the existing result rather than applying the variance twice (identity per P3-AL-09: `source_line_id` is the stocktake line).

---

## P3-AL-17 — Inventory adjustment, damage and stocktake accounting

**Status: TO BE ENFORCED IN P3 · P3-S3.**

**Decision.** The Phase 3 valuation offset for inventory shrinkage, gain, damage and stocktake variance is the **existing `cogs` system account (5000)**:

| Event | Entry |
|---|---|
| Inventory loss / damage / negative variance | `Dr COGS(5000)` · `Cr Inventory(1200)` |
| Inventory gain / positive variance | `Dr Inventory(1200)` · `Cr COGS(5000)` |

**No system account #22.** `0040` seeds exactly 21 identities and asserts the count; P2-S1's accepted historical gate pins that registry, and adding an account as a side effect of an inventory slice would be a chart-evolution decision taken by accident. If the product later wants a distinct "Inventory Adjustment" expense account, that is an explicit chart decision with its own directive, and it does not change any entry already posted.

**Forbidden.** `6100 Rounding Adjustment` and `6200 Purchase Price Variance` for this purpose. Both identities already have precise meanings — rounding residue and purchase-price variance respectively — and overloading either makes two different facts indistinguishable in the one report where the distinction matters.

**Correction of the older prose.** `DAFTAR_TRANSACTION_MAP.md` §11 said the adjustment entry posts "against a documented adjustments account", ASYNC. Both halves are wrong for Phase 3 and are corrected by this slice: the account is 5000, and the entry is SYNC in the same transaction as the movement (P3-AL-32).

---

## P3-AL-18 — Opening stock

**Status: TO BE ENFORCED IN P3 · P3-S3.**

Using an ordinary adjustment for initial inventory would book real opening stock against COGS and corrupt the merchant's first income statement. Inventory initialization is therefore a **distinct workflow** with its own source type, `inventory_opening`, and its own source table. Two cases, both resolved:

### Case A — the business has no accounting opening position for Inventory

There is no posted `accounting_opening_balances` row carrying an `inventory` (1200) position. The initialization command creates the stock detail **and** posts, in one transaction:

```
Dr Inventory(1200)   Σ(qty × unit_cost)
Cr Opening Equity(3000)   same amount
```

through the Phase 2 posting engine with `source_type = 'inventory_opening'`. This does **not** collide with the one-posted-opening-balance rule (`accounting_opening_balances_posted_uq`), because it is a different source identity and a different table; the accounting opening balance remains whatever it is, including absent.

### Case B — a posted accounting opening balance already includes Inventory(1200)

The merchant is **decomposing an amount that is already in the ledger** into variants, warehouses, quantities and unit costs. Posting a second journal entry would double the opening inventory. Therefore the command:

1. binds to the **current posted** `accounting_opening_balances` row and to its `inventory` position;
2. values the supplied stock detail **exactly as any priced document is valued** (P3-AL-49 §C): each line's `value_delta_base_minor` is its integer share, distributed by the largest-remainder allocator, so `Σ` line values is an integer and equals the document total by construction — there is no separate "sum then convert" step, and none is permitted;
3. **requires exact equality** with the Inventory carrying amount in that opening position;
4. refuses with `inventory.opening_valuation_mismatch` when they differ, reporting both totals and no plug;
5. creates the operational stock detail and the movements **only after** equality is proved;
6. posts **no journal entry at all**, and records the linkage (`opening_balance_id`, the matched amount) in the initialization source row and in the audit event.

**No silent plug. No "make it balance".** An equality that fails is a merchant data problem with a named error, not a rounding to be absorbed.

**One-time.** At most one initialization per business inventory foundation: `UNIQUE (business_id) WHERE status = 'posted'` on the initialization table, the same physical shape `accounting_opening_balances` already uses. **Correction semantics:** a posted initialization is corrected by reversing it — Case A's journal is reversed through the accepted Phase 2 reversal workflow and the stock detail is removed by inverse movements in the same transaction, moving the initialization to `superseded`; Case B, having posted no journal, is superseded by inverse movements alone. A new initialization may then be posted. `posted → superseded` is physically refused unless the required precondition holds, on the pattern `accounting_opening_balances` already enforces.

---

## P3-AL-19 — Purchase lifecycle

**Status: TO BE ENFORCED IN P3 · P3-S4.**

**Decision.** A Purchase is a **supplier bill/receipt that becomes stock and AP when received**. Phase 3 implements no procurement system.

```
draft → received
draft → cancelled
```

- No financial or inventory mutation happens while `draft`. A draft is editable; a draft carries no movement, no journal entry and no AP.
- `received` content is immutable: financial fields, lines, landed-cost allocations and the supplier identity snapshot all refuse `UPDATE` and `DELETE` by trigger.
- **No** `ordered`, `approved`, `shipped`, or partial-delivery state. A supplier who delivers in parts produces **one Purchase per delivered supplier document**.
- **GRNI is not invented.** DAFTAR has no Goods-Received-Not-Invoiced system account and no authoritative rules for one; a state between "ordered" and "received" would require one. Phase 3 therefore has no such state, and no slice may add one without a chart decision.

---

## P3-AL-20 — Purchase correction

**Status: TO BE ENFORCED IN P3 · P3-S5.**

A received Purchase is never edited and never deleted. A physical return of goods is a **Supplier Return** (P3-AL-29). A clerical reversal of a wrongly-posted Purchase is an explicit atomic domain operation, `purchase_reversal`, allowed **only** when all four preconditions hold, each checked under lock:

1. no supplier-payment allocation exists against the purchase;
2. no supplier-credit allocation exists against it;
3. no supplier return references any of its lines;
4. reversing the stock would not drive any affected key negative (P3-AL-12).

Then, in one transaction: inverse stock movements for every line (at the **original receipt cost**, so the reversal removes exactly the value the receipt added), an accounting reversal of the purchase's journal entry through the accepted Phase 2 reversal workflow, audit, outbox, and the purchase's lifecycle moving to `reversed` — a terminal state, never back to `draft`.

When any precondition fails, the correction proceeds through the real downstream operations (pay less, return goods, issue a credit note). The command refuses with a stable code naming which precondition failed, and never partially unwinds.

---

## P3-AL-21 — Purchase line identity

**Status: TO BE ENFORCED IN P3 · P3-S4.**

- Each purchase line has a stable UUID `id`, and `(business_id, purchase_id, line_no)` is unique with `line_no > 0`.
- **One line per variant within a Purchase**: `UNIQUE (business_id, purchase_id, variant_id)`. Two supplier lines for the same variant are combined before posting, by the merchant in the UI or by the caller — never by the server guessing which order to average them in.
- This removes the whole class of "weighted average depends on UI line order" defects at the schema, rather than by defining a tie-break for an ambiguity that need not exist.
- Landed-cost allocation, deficit coverage and movement identity all use `line_no` as the deterministic tie-break, never array arrival order.

---

## P3-AL-22 — Landed cost

**Status: TO BE ENFORCED IN P3 · P3-S4.**

Phase 3 scope, exactly:

- A landed cost belongs to the **same Purchase document** and is denominated in the **same Purchase currency**.
- Landed costs are known **before** `receive`. Once received, allocations are immutable and there is **no retroactive revaluation**.
- Two allocation modes, and only two:
  - **`by_value`** — proportional to each line's net purchase value (after line discount, before landed cost). If the denominator is zero, the command **refuses** and requires `manual`; it does not fall back to an equal split, because an equal split is a different financial answer silently substituted.
  - **`manual`** — per-line amounts supplied by the merchant, whose exact sum **must equal** the landed-cost total. Any difference is a refusal, not an absorbed residue.
- **Distribution is largest-remainder** when an integer amount of source minor units must be split, with the tie-break `line_no ASC`. Σ allocations = the landed-cost total, exactly, by construction.
- The allocated amount raises each line's inventory unit cost before the weighted average is applied, so landed cost enters `Inventory(1200)` and never an expense account.

**Not in Phase 3:** a third-party landed-cost invoice, freight allocated across documents, or a post-receipt landed-cost adjustment. Each needs a procurement/expense model that does not exist.

---

## P3-AL-23 — Tax boundary

**Status: OPEN / BLOCKED — OD-03, bounded by P3-S4.**

This is the one decision this document does not resolve, and it is blocked by an external input rather than by design: **OD-03 (per-country tax rules) is open**, and no approved Country Pack exists.

What Phase 3 does, precisely:

- Purchase tax is **zero** unless an explicitly approved tax policy exists for the business's country. There is no such policy today, so in practice Phase 3 purchases carry `tax_minor = 0`.
- The schema **may** carry a tax snapshot field, because a snapshot is a record of what the supplier document said. A non-zero value **must not** silently select a financial treatment: recoverable input tax (an asset) and non-recoverable tax (capitalized into inventory cost) are different entries, and choosing one without a Country Pack is inventing tax law.
- The command therefore **refuses** a non-zero purchase tax with `purchase.tax_policy_absent` until a Country Pack supplies the treatment.
- Discounts are independent of tax, fully supported, and reduce the purchase cost that enters inventory.

**To resolve:** official per-country sources and an approved Country Pack (OD-03's own condition). Phase 3 is not blocked as a whole by this; only non-zero purchase tax is.

---

## P3-AL-24 — Purchase accounting shape

**Status: TO BE ENFORCED IN P3 · P3-S4.**

**Decision — one model.** **Every received Purchase posts `Dr Inventory(1200) / Cr Accounts Payable(2000)`**, including when the merchant says "paid immediately".

Immediate settlement is represented as three facts, which may all happen inside one outer user command and one transaction:

```
Purchase (Dr Inventory / Cr AP)
Supplier Payment (Dr AP / Cr <payment method's posting account>)
Allocation binding the payment to the purchase
```

**Why this and not a cash path.** Two accounting paths for one commercial event means supplier statements, outstanding balances and AP ageing are each computed from a union of two models, and every later question ("what do I owe this supplier?") has to know which path was taken. One model means AP is the single source of truth for what is owed, always.

**Contradiction found and corrected.** `DAFTAR_TRANSACTION_MAP.md` §9 currently reads "قيد Inventory/AP أو Cash" — the two-path model. Nothing in the frozen schema or the accepted Phase 2 contracts requires it; it is planning prose that predates this decision. It is corrected by this slice. No repository contract makes this decision impossible.

---

## P3-AL-25 — Purchase FX

**Status: TO BE ENFORCED IN P3 · P3-S4.**

- A Purchase stores **one frozen source-currency snapshot**: `currency_code`, `source_to_base_rate NUMERIC(20,10)`, `rate_source`, `rate_timestamp` — the exact shape Phase 2 uses everywhere.
- Inventory cost is converted to the business base currency using the **accepted Phase 2 FX contract** and the Phase 2 rate registry (`accounting_fx_rates`, P2-S5), with manual entry as the default and only implemented source (OD-11).
- A historical Purchase **never** uses today's rate: the snapshot is the rate, forever.
- Landed-cost amounts follow the **same** Purchase snapshot in Phase 3. A landed cost in a third currency is out of scope.
- Domestic purchase: rate exactly 1, source `base`, txn amount equal to base amount — the shape `journal_lines` already enforces.
- No provider dependency is introduced.

---

## P3-AL-26 — Supplier source of truth

**Status: TO BE ENFORCED IN P3 · P3-S4.**

**`suppliers.balance` does not exist and may never be added.** This is the matrix rule (`DAFTAR_SOURCE_OF_TRUTH_MATRIX.md` §2.1) and Phase 3 does not make an exception for itself.

- **Supplier AP** = `Σ purchases (received, not reversed)` − `Σ active supplier-payment allocations` − `Σ active supplier-credit allocations` − valid supplier-return effects.
- **Supplier credit** = `Σ supplier credit notes` − `Σ allocations` − `Σ refunds`.
- Phase 3 ships **live derived reads only**. No cache, no projection, no summary table.
- A cache may be added later **only** after measurement shows it is needed, and only if it is rebuildable and reconciled. The guard that forbids authoritative balance columns (`scripts/guards/no-authoritative-balance.ts`) is extended to the supplier tables so the rule is enforced in CI rather than remembered.

---

## P3-AL-27 — Payment-method foundation

**Status: TO BE ENFORCED IN P3 · P3-S6.**

The repository has **no** `payment_methods` table; supplier payments need one. Phase 3 introduces the **minimal shared** foundation already specified in `DAFTAR_DATA_MODEL.md` §13, and nothing beyond it:

```
payment_methods (business_id, id, system_type ∈ {cash,card,bank_transfer,wallet,cheque,other},
                 posting_account_id NOT NULL, is_active, requires_reference, sort_order)
payment_method_names (business_id, payment_method_id, locale, display_name)
```

- `posting_account_id` is a **composite FK** `(business_id, posting_account_id) → accounts (business_id, id)`, `NOT NULL`.
- The posting account must satisfy all three, checked by the command and not by a name:
  1. **same business** — guaranteed physically by the composite FK above;
  2. **`accounts.is_active = true`** for a NEW settlement — a historical settlement keeps the account it was posted to;
  3. **`accounts.type = 'asset'`**.

  The column is **`accounts.type`** (`0040_accounting_chart.sql:98`), whose closed CHECK admits exactly `asset`, `liability`, `equity`, `revenue`, `expense`. `account_type` is the column name on **`accounting_system_account_keys`** (`0040:31`), a different table; an earlier draft wrote `accounts.account_type`, which does not exist, and that wording is withdrawn. **“Clearing” is not an account type.** `card_clearing` (1020), `wallet_clearing` (1030) and `cheque_clearing` (1040) are *system keys* whose `account_type` is `asset`, exactly like `cash` (1000) and `bank` (1010) — so `accounts.type = 'asset'` already admits every one of them and the word “clearing” adds no rule.
- Any narrower restriction — for example admitting only accounts whose `system_key` is one of the five settlement identities — is an **explicit command policy**, stated in the slice that implements it and tested, never an implied consequence of the account type. P3-S6 states which it implements; it may not leave the choice open.
- **Historical identity is preserved**: a method that has been used is never deleted and its posting account never silently changes. Deactivation is a lifecycle flag; entries already posted keep the account they were posted to.
- This is **infrastructure**, used by Supplier Payments now and Customer Payments in Phase 4. There is no one-off `supplier_payment.cash_account_id`, which is exactly the shape Phase 4 would have had to rip out.
- Phase 3 implements **no** Customer Payments, and creates no `payments` table.
- The accounting account registry is not duplicated: `payment_methods` points at `accounts`, it does not restate them.

---

## P3-AL-28 — Supplier payments

**Status: TO BE ENFORCED IN P3 · P3-S6.**

- A Supplier Payment **settles AP**; it is never a cost and never touches inventory. `Dr Accounts Payable(2000) / Cr <method posting account>`.
- **Partial payments** are supported; one payment may allocate across several purchases.
- Multi-currency uses the **accepted Phase 2 carrying-value model** (`DAFTAR_DATA_MODEL.md` §7, §7ج) with no new arithmetic. Every allocation carries, explicitly:

  ```
  payment_currency, payment_amount_minor
  payment_to_base_rate NUMERIC(20,10), payment_base_amount_minor
  purchase_currency, purchase_amount_applied_minor
  purchase_historical_to_base_rate, purchase_carrying_base_released_minor
  realized_fx_gain_loss_minor
  ```

- `realized_fx_gain_loss = payment_base_amount − purchase_carrying_base_released`, posted to **`fx_gain`(4900)** or **`fx_loss`(6900)**. Never `6100 Rounding` and never `6200 PPV`: those are different facts.
- Two amounts in different currencies are **never** compared directly. Every comparison happens in base, through the carrying value.
- Over-allocation is physically impossible: the purchase row and the payment row are both locked `FOR UPDATE` in canonical order, and `Σ allocations ≤ amount` is checked under that lock.

---

## P3-AL-29 — Supplier return and purchase price variance

**Status: TO BE ENFORCED IN P3 · P3-S5.**

A Supplier Return references the **original purchase line** for its economic value, but removes stock at the **current average cost of the warehouse the goods physically leave**.

- Returning from a warehouse other than the original destination is **allowed and authorized normally** (P3-AL-39), because stock may legitimately have been transferred.
- Refusals, each under lock: cumulative returned quantity may not exceed the purchased quantity of that line; the source warehouse must hold enough stock; the return may not drive the key negative (P3-AL-12).
- Both values are frozen on the return line: the **current average snapshot** (what leaves inventory) and the **original purchase carrying value** (what is owed back).
- The difference is **Purchase Price Variance → `purchase_price_variance`(6200)**. Never `6100`, never a revenue account.

```
Dr Accounts Payable(2000)        original purchase carrying value
Cr Inventory(1200)               qty × current avg
Dr/Cr Purchase Price Variance    the difference, either direction
```

subject to P3-AL-30 when the AP side does not exist.

---

## P3-AL-30 — AP first, supplier receivable second

**Status: TO BE ENFORCED IN P3 · P3-S5.**

**Fixed rule.** A return's value reduces **outstanding AP first**. If it exceeds the outstanding AP for that supplier, the excess becomes a **Supplier Credit Note** posted to **`supplier_receivable`(1150)**.

- **Never** debit AP beyond what exists — the ledger would show the merchant owing a negative amount, which is a receivable wearing a payable's name.
- **Never** touch revenue. A supplier return is not a sale.
- A Supplier Credit is cleared **only** by `supplier_credit_allocations` against a future purchase, or by a `supplier_refund` actually received. Both paths already have their shapes in `DAFTAR_DATA_MODEL.md` §12 and the accepted accounting rules; Phase 3 implements them and invents nothing.

---

## P3-AL-31 — Supplier-credit concurrency

**Status: TO BE ENFORCED IN P3 · P3-S6.**

Every source carrying a remaining amount carries **two** remaining values that must move together: `remaining_amount_minor` in the source currency and `remaining_carrying_base_amount_minor` in base. The rules:

- Both are on the **same row** and the row is locked `FOR UPDATE` once; there is no path that updates one without the other.
- **Partial** consumption releases carrying base **proportionally**, computed in exact arithmetic and rounded once at persistence.
- The **final** consumption releases the **entire remaining** carrying-base residue, not a proportional share. This is what prevents accumulated rounding dust from being stranded on a fully consumed credit forever.
- Concurrent allocations and refunds cannot overconsume: every consumer takes the same row lock before reading the remaining amount, so the check and the decrement are inside one lock.

---

## P3-AL-32 — Domain → accounting transaction composition

**Status: TO BE ENFORCED IN P3 · P3-S1 builds the seam; first used in P3-S3.**

**This is the decision the rest of Phase 3 rests on.** F-3 establishes the problem precisely: `Database.run()` always `BEGIN`s and `COMMIT`s, and `withAccountingTransaction()` opens its own transaction with the isolation GUCs deliberately empty. A purchase receipt written against today's ports would commit stock and post accounting in **two** transactions, so a crash between them leaves operational truth with no financial truth — the exact failure this phase exists to make impossible.

**Required atomic scope** for any financial inventory operation — all of it, or none of it:

```
domain source document + lines
stock movements
stock_levels cache update
negative-deficit coverage (when applicable)
accounting posting
accounting source binding
audit event
outbox event
```

**Not every atomic domain operation implies a posting.** An earlier draft wrote the seam as a single boundary that “carries an assertion or it does not open.” That is incompatible with two decisions of this same document: P3-AL-14 locks that a same-business warehouse transfer creates **no journal entry**, and P3-AL-33 locks that an assertion is minted for the posting a domain operation implies. A transfer implies no posting, so a single assertion-requiring seam would force its implementer to choose between minting a **fake assertion for a posting that never happens** and **opening a second transaction** for the stock half — the exact split-commit this decision exists to prevent. Two competent engineers would have chosen differently. The seam is therefore **two typed operations**, and the distinction is carried by the type, not by a value.

**The seams — specified, not implemented in P3-S0.**

```
withBusinessTransaction(scope, fn)                        -- no posting is possible
withBusinessAccountingTransaction(scope, assertion, fn)   -- posting is possible
```

1. **`withBusinessTransaction(scope, fn)`** — `BEGIN`s once, sets the RLS scope GUCs (`app.tenant_id`, `app.business_id`, `app.actor_user_id`), leaves `app.accounting_assertion` unset, runs `fn`, `COMMIT`s once. **No accounting posting capability is reachable from inside it**: the callback receives a handle type that carries no posting port and no raw client that a posting port would accept. Used by operations that create stock, audit and outbox facts and no journal — same-business transfer (P3-AL-14) is the Phase 3 example.
2. **`withBusinessAccountingTransaction(scope, assertion, fn)`** — the same single `BEGIN`/`COMMIT` and the same scope GUCs, **plus** `app.accounting_assertion`, and the callback receives a handle that **does** expose the transaction-bound accounting port. Used by every financial inventory operation: adjustment, damage, stocktake, opening stock, purchase receipt, deficit catch-up, supplier return, supplier payment.
3. **The distinction is a type, never a flag.** Forbidden permanently, in any spelling: `skipAccounting`, `requiresAccounting: false`, `trusted: true`, `postTrusted()`, `rawJournalInsert()`, or any boolean, option bag or string a caller could pass to turn one seam into the other. There is exactly one way to obtain posting capability, and it is to call the second function and supply an assertion. A code path that needs no posting cannot acquire one by argument.
4. **A coherence check at the accounting boundary**: `withBusinessAccountingTransaction` refuses to open if the assertion's `tenant_id`/`business_id` claims do not equal the scope's, **before any domain mutation runs**. Without it, a defect could write stock in one business under an assertion for another — two isolation systems that disagree, which is worse than either alone.
5. **The accounting ports accept an existing transaction handle.** `AccountingPostingPort.postEntry()` and its siblings gain a variant that takes the caller's client instead of opening a connection. The existing single-operation methods remain, implemented in terms of the new one, so every accepted Phase 2 call site keeps working unchanged and no accepted behaviour is re-tested.
6. **No nested independent commit anywhere.** Neither seam may be opened inside the other, and neither issues a second `BEGIN`. No saga, no compensating transaction, no outbox-driven "eventually post". This is one local PostgreSQL database; distributed-transaction patterns here would buy nothing and lose atomicity.
7. **No new bypass, and no new journal writer.** `accounting_post_entry` (with its P2-S4 siblings) remains the one physical journal writer. G-4 discovers journal writers from the schema, so a new one would have to satisfy the entire protection set on the same commit. `withBusinessTransaction` weakens nothing: it grants strictly **less** than the accounting seam, and the database's own refusals are unchanged — `daftar_app` still holds no journal DML, so even a defect inside the non-posting seam cannot write a journal row.

**The required seam matrix — re-scoped in Round 2 so it does not require future slices.** The first draft asked P3-S1 to prove *transfer*, *adjustment* and *purchase receipt* atomicity. None of those entities exists in P3-S1: `stock_movements` and `stock_levels` arrive in P3-S2, transfers and adjustments in P3-S3, purchases in P3-S4. Proving them at S1 would have required implementing future slices early, creating production tables the slice does not own, or writing tests against stand-ins that prove nothing about the real path — all three break slice independence. **P3-S1 owns the transaction primitive and only the primitive**, and the end-to-end proofs belong to the slices that own the entities.

**What P3-S1 must prove, using existing accepted Phase 2 primitives and test-owned fixture tables — and no production Phase 3 entity:**

| # | case | must prove |
|---|---|---|
| 1 | `withBusinessTransaction` | exactly one `BEGIN` and one `COMMIT` for the whole callback, observed from the server |
| 2 | rollback | a failure anywhere in the callback removes **every** mutation made through it, including in a test-owned fixture table |
| 3 | capability by type | the callback's handle exposes **no** accounting posting port — a compile-time property, asserted additionally at runtime |
| 4 | no accidental escape | the raw transaction object cannot be passed into the accounting posting port: there is no signature that accepts it, and the runtime port refuses a handle that did not come from the accounting seam |
| 5 | nesting | opening either seam inside either seam is rejected or unreachable through the public typed ports |
| 6 | `withBusinessAccountingTransaction` coherence | an assertion whose tenant/business claims differ from the scope's refuses **before the callback executes**, proved by asserting the fixture table is empty afterwards |
| 7 | composition with accepted Phase 2 | an **existing, accepted Phase 2 accounting operation** runs on the same transaction handle and commits once |
| 8 | joint atomicity | a failure injected **after** that accepted posting rolls back the posting **and** the companion fixture mutation — the real property the seam exists for, proved without any Phase 3 entity |
| 9 | backward compatibility | every existing Phase 2 single-operation method keeps its signature and behaviour; the whole accepted Phase 2 suite is the test |

**The real end-to-end proofs, assigned to their owning slices:**

| proof | owning slice |
|---|---|
| real transfer: stock pair + audit + outbox in one commit, through the **non-posting** seam, with **no** journal entry and **no** assertion minted | **P3-S3** |
| real adjustment / damage / stocktake / opening: stock + journal + binding + audit + outbox in one commit | **P3-S3** |
| real purchase receipt: purchase + lines + movements + cache + deficit coverage + journal + binding + audit + outbox in one commit | **P3-S4** |

`docs/PHASE_3_EXECUTION_PLAN.md` states the same split, and the two pages are read together as one contract.

**P3-S0 specifies this seam and implements none of it.**

---

## P3-AL-33 — Domain authorization, not `accounting.post`

**Status: TO BE ENFORCED IN P3 · P3-S1 defines the seam; used from P3-S3.**

A merchant who receives stock or pays a supplier does **not** need `accounting.post`. Accounting is a **consequence** of an authorized domain operation, not a second permission the merchant must hold.

**How, exactly.** Authority is proven once, in the domain layer: the command checks its own permission (`purchases.receive`, `inventory.adjust`, `suppliers.pay` …) **and** the warehouse/branch scope (P3-AL-39). Only then does it mint the accounting assertion for the posting that its own success implies — and a command whose success implies **no** posting, such as a transfer, mints **nothing** and opens the non-posting seam of P3-AL-32 instead. An assertion is never minted to satisfy a transaction boundary. The assertion minter is already a port that the engine never touches, so the typed internal seam is "a domain command that has proven its own authority may mint"; it is not a flag, not a boolean and not a parameter that could be passed `true`.

**Forbidden permanently:** `skipAuthorization=true`, `postTrusted()`, `bypassAccountingPermission()`, or any variant that could be reached with a literal. Accounting remains the financial authority; Inventory and Purchases own business authorization.

---

## P3-AL-34 — Accounting source types

**Status: TO BE ENFORCED IN P3 · registered by the slice that implements each.**

`accounting_source_types` is a closed registry, extended only by authorized migrations. Phase 3 registers exactly what Phase 3 implements:

| Source type | Registered by | `lower_bound_policy` |
|---|---|---|
| `inventory_adjustment` | P3-S3 | `none` |
| `inventory_opening` | P3-S3 | `none` |
| `purchase` | P3-S4 | `none` |
| `negative_inventory_cost_adjustment` | P3-S4 | `none` |
| `purchase_reversal` | P3-S5 | `not_before_origin` |
| `supplier_return` | P3-S5 | `none` |
| `supplier_payment` | P3-S6 | `none` |
| `supplier_credit_allocation` | P3-S6 | `none` |
| `supplier_refund` | P3-S6 | `none` |

`upper_bound_policy` is `not_after_today` for every one of them, uniformly, as `0042` requires of every source.

**Not registered:** any identity Phase 3 does not implement — `sale`, `invoice`, `payment`, `credit_note`, `period_close`. A registry entry is a claim that the ledger can receive that fact.

`stock_source_types` (P3-AL-50) is the inventory-side twin of this registry and obeys the same predecessor law: the foundation is created by one slice, and each identity is registered by the slice that implements the workflow behind it. The two registries are **separate** and are not merged — they answer different questions (“what may post to the ledger” versus “what may move stock”), their memberships differ, and a shared table would force every future stock source to justify itself to the accounting engine.

**For every new financial source type**, without exception, the P2 AL-01 contract holds and is re-proved by the slice that adds it: a real domain detail row, an immutable financial identity after posting, a **source-completeness guard at COMMIT** (the binding cannot exist without its source detail and vice versa), deletion protection, `accounting_source_bindings` integration, no polymorphic FK, idempotency, and audit plus outbox in the same transaction.

**The predecessor-assertion work item (F-4).** The first Phase 3 migration that registers a source type turns two permanent Phase 2 assertions red. **P3-S3 owns this**, and the resolution follows P2-S4 §45 exactly: the assertions are changed in the smallest honest way so they still prove what they proved — that Phase 2's slices registered exactly their own identities and that no unauthorized identity appeared — while admitting an authorized successor. Concretely, each assertion becomes "the three Phase-2-native identities are present, in this order, and every other registered identity is one an authorized Phase 3 migration added", rather than "the registry has exactly three rows". **No assertion is deleted, no evidence is reduced, and the successor is not forbidden.**

---

## P3-AL-35 — Business transaction trace

**Status: TO BE ENFORCED IN P3 · P3-S1.**

One user operation may produce a Purchase, its items, stock movements, a supplier payment, a journal entry, audit events and outbox events. `business_transaction_id UUID` ties them together.

- It is carried on every Phase 3 source document and written into the `metadata` of every audit event and the `payload` of every outbox event the operation produces. (`audit_events` and `outbox_events` are frozen tables with a JSONB column each; no frozen table is altered.)
- It is generated **once per user operation**, at the API boundary, and never derived from a request id that a client controls.
- **It is not financial authority.** It is observability. No invariant, no idempotency check and no balance depends on it, and no command may resolve a financial fact by it. This is stated as a prohibition, because a trace id that becomes load-bearing is an identity nobody validated.
- The property it buys: one operation is reconstructable across domains **without relying on timestamps**.

---

## P3-AL-36 — TD-09, the future-date defence

**Status: TO BE ENFORCED IN P3 · P3-S1.**

**Decision.** TD-09 is repaid by a **`BEFORE INSERT` trigger on `journal_entries`** in a new migration, not by a CHECK constraint.

**Why a trigger is correct and a CHECK is not — corrected in Round 2.** An earlier draft argued that PostgreSQL *refuses* `CURRENT_DATE` in a CHECK. **That is factually wrong and is withdrawn.** Measured on PostgreSQL 16:

```sql
CREATE TABLE chk_probe (d DATE, CONSTRAINT no_future CHECK (d <= CURRENT_DATE));
-- CREATE TABLE
```

It is accepted. PostgreSQL *assumes* CHECK expressions are immutable and documents that a non-immutable one may later become inconsistent with the rows it admitted and can break dump and restore — but it does not reject it at parse time. A decision must not rest on a restriction that does not exist, so the real reasons stand on their own and are sufficient:

1. **It is the wrong semantics.** A CHECK states a *timeless row invariant*; "not dated in the future" is a statement about the **moment of insertion**. A row that was legal when written stays legal forever, which is exactly what a CHECK cannot express — and the constraint's truth value would silently change underneath committed rows, so `ALTER TABLE … VALIDATE CONSTRAINT`, a `pg_dump` reload or any later revalidation could reject data the database itself accepted.
2. **It needs another table.** The rule is "not in the future **in the business's own timezone**", which requires reading `businesses.timezone`. A CHECK may not read another table, at all. That alone settles the mechanism.
3. **A `BEFORE INSERT` trigger is the one-time enforcement mechanism** the rule actually calls for: it runs exactly once, at the moment the rule is about, and may read whatever it needs.

The debt register's suggestion of a CHECK is therefore declined on semantics and on the cross-table dependency, not on a parser restriction.

**Shape.**

- `BEFORE INSERT ON journal_entries FOR EACH ROW`, resolving the **business's timezone** (`businesses.timezone`) and computing the current civil date there — never the server's timezone.
- Refuses a future `entry_date` with the stable code **`accounting.entry_date_in_future`**, the same code the three posting commands already raise, so no caller sees a new error identity.
- The error message carries **no financial values**.
- Precedent: `0049_accounting_periods.sql` already attaches `accounting_period_guard` to `journal_entries` the same way, and the permanent upgrade assertions query triggers by name rather than exhaustively (F-5), so nothing breaks and no frozen byte changes.
- **The command-level checks remain.** This is defence in depth beneath every posting command, not a replacement for any of them.
- **Authority (Round 4, P3-AL-54 §H).** The trigger function is `SECURITY DEFINER`, owned by **`daftar_accounting_internal`** — an accounting guard belongs to accounting authority, never to the inventory principal — with `SET search_path = pg_catalog, public, pg_temp` and no `EXECUTE` grant. It must read `businesses.timezone` whoever inserts, and `accounting_seeder_read` (`0040:213–214`) already admits that principal. The ownership transfer uses the same `GRANT CREATE ON SCHEMA public` bracket as `0040:247–263`/`0040:471`, and P3-S1 extends the named-owner assertions in `tests/integration/migration-portability.test.ts:232–252` with it.

---

## P3-AL-37 — TD-10, assertion signing

**Status: ENFORCED PRECEDENT — kept unchanged by Tech Lead decision.**

- The accepted **symmetric HMAC** design stays.
- **`ACCOUNTING_ASSERTION_KEY` remains exclusive to `merchant-api`.** Not the worker. Not `platform-api`. No second signer, no second process.
- All Phase 3 financial posting happens inside `merchant-api`'s accepted trust boundary, which is why Phase 3 introduces no second signing process and therefore no new exposure.
- The accepted database verifier is **not redesigned** during Phase 3.
- TD-10 stays **open** as documented debt and a design boundary. It is **not** marked closed, because nothing about it was solved. Any future phase that would expose assertion signing to a second process must escalate TD-10 for architectural review **before** doing so.

---

## P3-AL-38 — Phase 3 permissions

**Status: TO BE ENFORCED IN P3 · P3-S1.**

Closed set, added to `PERMISSIONS` in `packages/domain-core/src/permissions.ts` — the one registry; the migration creates no second one, exactly as `0041` did not:

| Permission | Sensitivity |
|---|---|
| `inventory.view` | ordinary |
| `inventory.adjust` | **sensitive** |
| `inventory.transfer` | **sensitive** |
| `inventory.stocktake` | **sensitive** |
| `purchases.view` | ordinary |
| `purchases.manage` | **sensitive** |
| `purchases.receive` | **sensitive** |
| `purchases.return` | **sensitive** |
| `suppliers.view` | ordinary |
| `suppliers.manage` | **sensitive** |
| `suppliers.pay` | **sensitive** |

Reading never corrupts anything, so the three `view` keys are ordinary. Everything that moves stock, receives or returns goods, or settles a supplier moves real value and is sensitive.

**Role seeding — deliberate, not convenient.**

- **Owner**: all eleven, seeded by the migration for every existing business, on the exact `0041` pattern (set-wise, with a completeness assertion).
- **Manager**: exactly `inventory.view`, `purchases.view`, `suppliers.view` — the three ordinary keys, and no fourth **Phase 3** key. See the precision note below: this is a statement about the Phase 3 subset, **appended** to the Manager's accepted authority, never a replacement of it.
- **Cashier**: none.
- **Existing custom roles**: untouched. Not one of them gains a Phase 3 permission.

Sensitive operational authority is assigned by the Owner, deliberately. A migration that turned every existing manager into a purchasing and stock authority would be a silent privilege grant across every business in production.

**This is the single contract, and Round 2 removed a contradiction in it.** `docs/PHASE_3_EXECUTION_PLAN.md` previously said P3-S1 seeds "to the owner system role only" and must assert that "no non-owner role gained one". Both cannot be true alongside the Manager row above, and an implementer had to pick. **This decision wins**: Manager receives the three ordinary view keys, deliberately, and the execution plan now states the same thing.

**What the migration must assert**, in terms that distinguish ordinary visibility from sensitive authority:

1. **completeness** — the owner system role holds all eleven, for every business;
2. **manager exactness, restricted to the Phase 3 keys** — `manager_permissions ∩ PHASE_3_KEYS = {inventory.view, purchases.view, suppliers.view}` exactly, so a fourth Phase 3 key is a failure and a missing one is a failure. The intersection is what is compared: the assertion says nothing about, and may not disturb, the rest of the Manager's set;
3. **no sensitive leak** — **no non-owner role of any kind**, system or custom, holds any of the eight **sensitive** keys. This is the assertion that protects production, and it is stated over the sensitivity column of the table above rather than over a hand-copied list;
4. **custom roles unchanged** — the set of permissions on every pre-existing custom role is byte-identical before and after the migration.

Assertion 3 is the one that would have failed silently under the old "no non-owner role gained one" wording: that wording is both too strong (it forbids the intended Manager view keys) and, once relaxed by an implementer, too vague to stop a sensitive key being included in the relaxation.

**Precision note (Round 3) — "exactly three" means exactly three *Phase 3* permissions.** It does **not** mean the Manager role ends with three permissions. The accepted Manager set at `packages/domain-core/src/permissions.ts:98–116` holds seventeen Phase 1 keys — `business.view`, `branch.manage`, `warehouse.manage`, `catalog.*`, `member.invite`, `role.assign` and the rest — and **every one of them survives untouched**. P3-S1 **appends**; it never rewrites the row set. The accepted `0041` migration already demonstrates the only correct shape: `INSERT … ON CONFLICT (business_id, role_id, permission) DO NOTHING`, never a `DELETE` followed by an `INSERT`.

So a fifth assertion is required, and it is the one that catches the dangerous implementation:

5. **manager preservation** — for every manager system role, the set of permissions that are **not** Phase 3 keys is byte-identical before and after the migration. An implementation that replaced the Manager's whole set with three rows would satisfy assertions 1–4 and destroy seventeen accepted permissions in every business in production. This assertion is what makes that impossible.

The same five assertions are re-run against a business provisioned **after** the migration (**P3-AL-53**), because the backfill and the provisioning registry are two different writers and only testing both proves they agree.

---

## P3-AL-39 — Warehouse scope and permission together

**Status: TO BE ENFORCED IN P3 · P3-S1.**

**Every inventory mutation passes BOTH checks.** A permission alone is never sufficient.

1. the domain permission (P3-AL-38), and
2. the warehouse/branch scope (P3-AL-15): for `branch_scope_mode = 'assigned'`, **every affected warehouse** must be reachable through `branch_warehouses` from a branch in the actor's `member_branch_scopes`.

**A transfer has two warehouses and both must pass.** There is no "authorized source, unauthorized destination" transfer — the check runs over the set of affected warehouses, not over a single "the" warehouse, so a command that later grows a third warehouse inherits the rule instead of forgetting it.

Default deny: an actor with `assigned` scope and no branch association reaches no warehouse at all.

---

## P3-AL-40 — Supplier lifecycle

**Status: TO BE ENFORCED IN P3 · P3-S4.**

- A supplier with any Purchase, Payment or Credit history **cannot be hard-deleted**. Enforced by `ON DELETE RESTRICT` from the child documents plus a command that offers no delete at all.
- Lifecycle is `active ⇄ inactive`. An inactive supplier remains fully visible in history and is **not selectable** for a new purchase, payment or credit. Reactivation requires `suppliers.manage`.
- **Snapshotted onto every Purchase at `received`**, and immutable thereafter: `supplier_name_snapshot`, `supplier_tax_identifier_snapshot`, `supplier_phone_snapshot`. These are what the document said at the time; editing the supplier record afterwards updates the supplier, never the documents.
- The live `suppliers` row keeps the current name and contact details, and every screen that is about *now* reads it.

---

## P3-AL-41 — Warehouse and variant archival

**Status: TO BE ENFORCED IN P3 · P3-S3.**

- A warehouse or variant with stock history is **never** hard-deleted; its movements are business history and reports depend on them. `warehouses.status` and `product_variants.status` already carry `active|archived` from Phase 1 and are reused.
- **A warehouse with non-zero `on_hand` on any key cannot be archived.** Stock must first be transferred out or adjusted to zero, deliberately and with an audit trail. Enforced by the archival command against the live cache, and re-checked against the movement ledger.
- **A tracked variant with non-zero stock cannot have inventory tracking disabled**, and cannot be archived.
- **Historical stock locks the canonical unit even when current stock is zero.** Disabling tracking at zero is allowed and does *not* unlock `unit_code` / `unit_decimals`; re-enabling reuses the historical unit. The archival and disable rules are about *current* quantity, the unit lock is about *history*, and the two are deliberately not the same test (P3-AL-05 §D).
- Catalog lifecycle may not destroy stock truth: the archive path in Catalog calls the inventory check rather than duplicating it.

---

## P3-AL-42 — Stock-level rebuild

**Status: TO BE ENFORCED IN P3 · P3-S2.**

"`stock_levels` is a cache" is meaningful only if reconstruction is real and tested.

**Algorithm.** For a stock key: read all movements ordered by `stock_seq ASC`; fold

```
on_hand              += qty_delta                 -- exact NUMERIC(18,4) addition
valuation_base_minor += value_delta_base_minor    -- exact BIGINT addition of STORED integers
```

then derive `avg_unit_cost_base_minor = HALF_EVEN(valuation_base_minor / on_hand, 10)` when `on_hand <> 0`, carrying the last known average when `on_hand = 0` (so a key that empties and refills does not lose its cost reference). `last_stock_seq` is the final movement's sequence.

**Both folds are additions of stored values, so the rebuild is exact.** No multiplication, no division and no rounding occurs anywhere in the fold; the only rounded quantity is the derived average, and the average is never an input to the fold. That is precisely why P3-AL-49 forbids the live path from deriving valuation through `on_hand × avg`: a rebuild that adds stored values and a live path that multiplies a rounded quotient would diverge, and the rebuild's verdict would be meaningless. Rebuilt `on_hand` must equal the live cache to the last of its four decimals and rebuilt `valuation_base_minor` must equal it **to the unit**, with no tolerance — including for a key whose history contains repeating averages and full depletions (P3-AL-49 §D vector E).

- **Ordering source:** `stock_seq`. Never `created_at`, never `id`.
- **Concurrency:** a rebuild takes the stock key's row lock for the swap, so it cannot interleave with a live command on that key.
- **Verification:** a rebuild **compares** and reports before it writes; the comparison result is the reconciliation signal of P3-AL-43.
- **Swap:** the rebuilt values replace the cache row in one statement, per key, inside the lock.
- **No arbitrary manual correction exists.** There is no endpoint, no admin command and no script that sets a cache value to a supplied number. The only way a cache value changes is a movement or a rebuild from movements.
- A reconciliation mismatch **alerts and refuses**; it never writes the GL's opinion into the cache. The movement ledger is truth.

---

## P3-AL-43 — Inventory ↔ GL reconciliation

**Status: TO BE ENFORCED IN P3 · P3-S8.**

Phase 3 owns INV-INV-06 / INV-ACC-11: **`Inventory(1200)` GL balance = inventory valuation under the accepted policy.**

- **Valuation formula:** `Σ value_delta_base_minor` over all movements of the business, as a **`BIGINT` sum of stored integers** — **never** `Σ(qty × avg)`, which is forbidden outright by P3-AL-49 §B, and **never** `Σ stock_levels.valuation_base_minor`, which reads the cache and would compare the cache against the GL rather than the ledger against the GL.
- **The reconciliation performs no rounding, at any aggregation level.** The earlier rule — sum the business's valuation in `NUMERIC(28,10)` and "convert it to base minor units once, HALF_EVEN" — is **withdrawn**. It was the defect: the GL had already accumulated one rounding *per posting*, and rounding is not additive, so two movements of an exact `0.6` minor gave the GL `2` and the reconciliation `round(1.2) = 1`. Under P3-AL-49 every movement's value is already `BIGINT` minor and the journal line is that same integer, so both sides of the comparison are integers that were never rounded twice. **This is what makes zero tolerance reachable rather than merely required.**
- **Two comparisons, not one.** The reconciliation asserts `Σ movements = GL(1200)` **and** `Σ movements = Σ stock_levels.valuation_base_minor`, both integer equalities at zero tolerance. The first catches a ledger/GL divergence; the second catches cache drift, which is the failure P3-AL-49 exists to make impossible and which must therefore be observed rather than assumed.
- **Aggregation boundary:** per business, summed over every stock key.
- **Tolerance: zero.** Every journal amount **is** a stored movement integer (P3-AL-49 §A equation (3)), so an exact match is achievable and anything else is a defect. A tolerance would be a place for real divergence to hide. This **supersedes** the older "within tolerance" wording of INV-ACC-11 in `docs/DAFTAR_ACCOUNTING_RULES.md` (see F-7), which Phase 2 explicitly left for Phase 3 to activate.
- A mismatch raises a **reconciliation alert** and the check fails. There is **no correcting entry**, silent or otherwise. Repair means investigation and an explicit domain correction with its own source identity.
- The read side runs as `daftar_reconciler`, the read-only principal P2-S8 already established, which physically cannot write financial truth however it is called.

---

## P3-AL-44 — Read models

**Status: TO BE ENFORCED IN P3 · P3-S2 (stock) and P3-S7 (reads).**

- **`stock_levels` is an explicit, named exception** to the accounting live-only strategy (AL-15). Stock availability is operational concurrency state: the row is what commands lock, and "compute it from the movements each time" would mean locking the whole movement history of a key on every sale. The exception is justified by concurrency, not by reporting speed, and the guard that forbids authoritative balance storage is amended to name this one table explicitly rather than being weakened.
- **Supplier balance and purchase outstanding get no cache.** They are derived live from their sources (P3-AL-26).
- A cache is added later only after **measurement**, and only if rebuildable and reconciled.
- **No speculative dashboard materialization.** No summary table, no materialized view, no Redis balance is created by Phase 3.

---

## P3-AL-45 — Reservations

**Status: DEFERRED BY SCOPE — Phase 4 (sales/POS) and Phase 6 (storefront orders).**

`DAFTAR_INVENTORY_RULES.md` §4.2 describes reservations for `cart`, `order` and `offline_sale`. **None of those owning workflows is in Phase 3.**

- Phase 3 implements **no** reservation workflow.
- Phase 3 introduces **no** authoritative `reserved` quantity — not a column, not a default of zero. A `reserved` number with no reservation entity behind it is a value every later query would trust and nothing would maintain.
- When reservations arrive, `reserved` becomes a **rebuildable cache** derived from reservation truth, exactly as `on_hand` is derived from movements, and `available = on_hand − Σ active reservations` is computed then.
- Phase 3's `stock_levels` shape does not block this: adding a derived column later is a migration, and the rebuild algorithm already folds from a ledger.

---

## P3-AL-46 — Lot, serial and expiry

**Status: DEFERRED BY SCOPE — Phase 11.**

Phase 3 adds **no** `lot_id`, **no** serial array, **no** expiry column and no hidden vertical-pack complexity anywhere.

What makes the future possible without a core rewrite is already decided: the stock key is `(business_id, warehouse_id, variant_id)` and movement identity is the five-part tuple of P3-AL-09. A future lot dimension extends the key and the tuple; it does not require `stock_movements` to change shape or the weighted-average engine to be re-derived. That is the whole preparation, and it is deliberately nothing more.

---

## P3-AL-47 — Web and Android boundary

**Status: DEFERRED BY SCOPE — Phase 7 owns mobile/offline production workflows.**

- Phase 3 merchant UX is the **Web merchant application**, responsive from phone to desktop.
- **No Android production inventory workflow** is built in Phase 3, and no domain logic is duplicated into the Android app.
- Every Phase 3 API is designed to be consumable by a later Android client: idempotency keys on every mutation, stable error codes, no server-side session state in a command.

---

## P3-AL-48 — UX law

**Status: TO BE ENFORCED IN P3 · P3-S7.**

The merchant never needs to understand journal entries, weighted-average equations, carrying base, PPV, source bindings or deficit layers. The screens say:

**Receive Purchase · Move Stock · Count Stock · Adjust Stock · Return to Supplier · Pay Supplier**

- Progressive disclosure: FX and landed-cost details appear only when they are relevant — a domestic purchase with no extra costs shows neither.
- The accounting consequence of an operation is never a form the merchant fills in. It is a consequence.
- No cockpit of accounting jargon, and no screen that asks the merchant to choose an account.
- Simple Outside — Powerful Inside: the base variant of P3-AL-03 is invisible, the stock sequence is invisible, and the source binding is invisible.

---

## P3-AL-49 — Stock valuation exactness law

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Why this decision exists, restated after Round 2.** P3-AL-42 promises an exact rebuild and P3-AL-43 a **zero-tolerance** Inventory ↔ GL reconciliation. The first draft of this decision closed the *cache* drift but left a second, larger hole open: it kept the authoritative movement value at `NUMERIC(28,10)` — a **fractional** number of base minor units — while the journal carries `BIGINT` minor. Two roundings then existed, and **rounding is not additive**. Measured on PostgreSQL 16:

| operations | rounded per operation (what the GL got) | rounded in aggregate (what reconciliation computed) |
|---|---|---|
| `+0.6` then `+0.6` | `1 + 1 = 2` | `round(1.2) = 1` |
| `+0.4` then `+0.4` | `0 + 0 = 0` | `round(0.8) = 1` |

`2 ≠ 1` and `0 ≠ 1`, with every command having followed the document exactly. A zero-tolerance reconciliation was **arithmetically unreachable**, and the defect was in the write semantics, not in the reconciliation query.

### §A — The model: one rounding, at the movement, and the journal carries that same integer

**Decision.** A movement's financial value is an **integer number of base minor units**, and the journal line for that movement **is that same integer**. There is no second conversion, so there is nothing for a second rounding to disagree with.

```
stock_movements
  qty_delta                NUMERIC(18,4)  NOT NULL     -- may be exactly 0
  unit_cost_base_minor     NUMERIC(28,10) NULL         -- SNAPSHOT for trace; NULL for value-only
  value_delta_base_minor   BIGINT         NOT NULL     -- AUTHORITATIVE, signed, exact minor units

stock_levels
  on_hand                  NUMERIC(18,4)  NOT NULL     -- = Σ qty_delta
  valuation_base_minor     BIGINT         NOT NULL     -- = Σ value_delta_base_minor   (exact integer sum)
  avg_unit_cost_base_minor NUMERIC(28,10) NULL         -- DERIVED, never stored as truth
  last_stock_seq           BIGINT         NOT NULL
```

**Cost precision is not lost; it is moved to where it belongs.** `unit_cost_base_minor` and `avg_unit_cost_base_minor` keep the full `NUMERIC(28,10)` precision that `DAFTAR_DATA_MODEL.md` §10 requires — a moving weighted average computed on integer values is not a coarser average, because its **numerator is exact**. Only the one number that must agree with the journal is integer, and that is the whole point.

**The equation.** For a business `B`, with `M` the set of its stock movements and `J` the set of `Inventory(1200)` journal lines:

```
(1)  stock_levels.valuation_base_minor(k)  =  Σ_{m ∈ M, key(m)=k}  value_delta_base_minor(m)          -- per stock key, exact BIGINT addition
(2)  Σ_{k ∈ B} valuation_base_minor(k)     =  Σ_{m ∈ M}            value_delta_base_minor(m)           -- per business
(3)  journal_line_amount(entry(m), 1200)   =  Σ_{m' ∈ operation(m)} value_delta_base_minor(m')         -- the entry's Inventory line IS the sum of its own movements' stored integers
(4)  GL_Inventory(B)                       =  Σ_{J}  signed amount  =  Σ_{m ∈ M} value_delta_base_minor(m)
∴    GL_Inventory(B)  =  Σ_{k ∈ B} stock_levels.valuation_base_minor(k)  =  Σ_{m ∈ M} value_delta_base_minor(m)
```

Every term is a `BIGINT`. **The reconciliation performs no rounding at all** — it compares integers to integers, which is why zero tolerance is achievable rather than merely demanded. Line (3) is the load-bearing one: the journal amount is not *derived from* the movement value, it **is** the movement value.

**Forbidden, permanently:**

- converting a movement's valuation a second time anywhere, in either direction;
- rounding inside the reconciliation, at any aggregation level (the old "convert the business-wide sum once" rule is **withdrawn** — it is what created the contradiction);
- deriving a key's current valuation as `on_hand × avg_unit_cost_base_minor` (§B);
- `6100 Rounding Adjustment` on an inventory movement posting: there is no residue to carry, so an entry that touches `6100` for inventory is a defect, not a rounding (§C covers where a receipt's own distribution residue goes, and it is not here).

### §B — What the average may and may not be used for

An earlier draft wrote that the average is "never an input to a later write". Taken literally that contradicts the weighted-average policy itself, which prices an outbound movement at the current average. The law is **two distinct prohibitions**, and only the first is absolute:

1. **The average may NEVER be used to reconstruct total valuation.** Not in a command, not in a rebuild, not in a report, not in reconciliation, not in a read model. Valuation is `Σ` of stored integers, always. This is the absolute one, and it is what makes (1)–(4) hold.
2. **The average MAY be the costing input for a future outbound movement**, read under the stock key's row lock, exactly as the moving-weighted-average policy requires. The value it produces is then rounded **once**, at that movement, and the stored integer becomes historical truth.
3. **A stored movement value is never recomputed.** Not from `qty × avg`, not from `qty × unit_cost`, not at any later date, for any reason. `unit_cost_base_minor` is a snapshot for trace and reporting; `value_delta_base_minor` is the authoritative amount. After rounding they need not satisfy `value = qty × unit_cost`, and a test that asserts they do is asserting the wrong thing.

**Why the rounding error does not accumulate.** Because `valuation_base_minor` is the exact integer sum, each movement's rounding is absorbed into the *next* average automatically: the key's remaining valuation is always exactly what was put in minus exactly what was taken out. Over a full cycle — receive then fully deplete — total outbound equals total inbound to the minor unit, by §C.

### §C — How each movement's integer is produced

| movement | `value_delta_base_minor` |
|---|---|
| **inbound from a priced document** (purchase receipt, supplier-return reversal, opening stock) | the line's **integer share** of the document's own integer base-currency total, distributed by the accepted largest-remainder allocator (P3-AL-22). `Σ` line shares `=` the document total **exactly**, so `Dr Inventory = Cr AP` with no plug and no `6100` |
| **outbound, partial** (`abs(qty_delta) < on_hand`) | `HALF_EVEN(qty × avg_unit_cost_base_minor, 0)` — the one rounding, at this movement |
| **outbound, full depletion** (`abs(qty_delta) = on_hand`) | `−valuation_base_minor` at the locked row: the entire remaining valuation, exactly |
| **`transfer_in`** | the exact negation of its paired stored `transfer_out` value (P3-AL-14) — copied, never recomputed |
| **value-only** (`qty_delta = 0`, e.g. deficit catch-up) | `HALF_EVEN(qty_covered × (actual − provisional), 0)`, per coverage (P3-AL-13), never an aggregate that is then split |
| **inbound with no priced document** (positive stocktake variance) | `HALF_EVEN(qty × explicit_unit_cost, 0)`; a zero cost is never invented (P3-AL-16) |

**The full-depletion flush stays, and it is a definition, not a correction.** Emptying a key sets its valuation to `0` because the movement removes exactly what was there — so `on_hand = 0 ⇒ valuation_base_minor = 0` holds unconditionally, asserted inside the command under the lock before `COMMIT`, without any argument about how large a quantity can get before `HALF_EVEN(qty × avg)` would stop landing on the remaining integer. The flush is **not** a plug: the journal receives that same integer, so the GL is told exactly what the ledger recorded. A key at zero keeps its last average as a **cost reference** and carries no value.

**PostgreSQL's `round()` is HALF_UP** — measured: `round(0.5) = 1`, `round(1.5) = 2`. HALF_EVEN gives `0` and `2`. The trusted commands therefore use the explicit HALF_EVEN helper of P3-AL-08, never `round()`.

### §D — The locked rounding and valuation vectors

Acceptance vectors, not illustrations. P3-S2 does not pass without all nine, asserted identically in TypeScript and in SQL, each showing stored movement valuation, cache valuation, the Inventory journal line, the rounding treatment, the GL total and the reconciliation equation. "Exact computed" below is the pre-rounding value in minor units.

| # | scenario | stored movement value(s) | `stock_levels.valuation_base_minor` | Inventory journal line(s) | rounding / residual | GL Inventory | reconciliation |
|---|---|---|---|---|---|---|---|
| **A** | one operation, exact computed `+0.6` | `+1` | `1` | `+1` | one HALF_EVEN at the movement | `1` | `1 = 1` ✓ |
| **B** | two operations, each exact computed `+0.6` | `+1`, `+1` | `2` | `+1`, `+1` | one per movement; **the sum is never rounded** | `2` | `2 = 2` ✓ — the old model gave `round(1.2) = 1 ≠ 2` |
| **C** | two operations, each exact computed `+0.4` | `0`, `0` | `0` | `0`, `0` | as above; a zero-value quantity movement is legal (`CHECK` forbids only `qty = 0 AND value = 0`) | `0` | `0 = 0` ✓ — the old model gave `round(0.8) = 1 ≠ 0` |
| **D** | HALF_EVEN tie, exact computed `+0.5` | `0` | `0` | `0` | ties to even → `0`; `round()` would have given `1` | `0` | `0 = 0` ✓ |
| **E** | HALF_EVEN tie, exact computed `+1.5` | `+2` | `2` | `+2` | ties to even → `2` | `2` | `2 = 2` ✓ |
| **F** | receive 3 @ total `10`, then issue 1 | `+10`, then `HALF_EVEN(1 × 3.3333333333) = −3` | `10` → `7` | `+10`, `−3` | one per movement | `7` | `7 = 7` ✓; `avg` becomes `3.5000000000` |
| **G** | continue F: issue 1, then issue the last 1 | `HALF_EVEN(1 × 3.5) = −4` (ties to even), then flush `−3` | `7` → `3` → `0` | `−4`, `−3` | final movement is the flush | `0` | `0 = 0` ✓; **total outbound `3+4+3 = 10` = total inbound**, so COGS over the cycle is exactly the cost received |
| **H** | transfer of a source key's last 2 units, source valuation `7` | `transfer_out = −7` (flush), `transfer_in = +7` (exact negation) | source `0`, destination `+7` | none — a transfer posts no journal entry (P3-AL-14) | no rounding occurs on either leg | unchanged | business valuation delta `= 0` exactly ✓ |
| **I** | four operations, exact computed `+0.6, +0.6, +0.4, +0.4` | `+1, +1, 0, 0` | `2` | `+1, +1, 0, 0` | per-movement rounding **deliberately differs** from rounding the aggregate (`round(2.0) = 2` coincides here; B and C are the cases where it does not) | `2` | `2 = 2` ✓ — the reconciliation never rounds, so the difference cannot appear |

**What vectors B, C and I prove together:** per-operation rounding and aggregate rounding genuinely disagree, and the model is sound **because the aggregate is never rounded**, not because the two were made to agree. Zero tolerance is demonstrated by integer equality at every step, not asserted.

### §E — Rebuild under this model

For a stock key: fold `on_hand += qty_delta` and `valuation_base_minor += value_delta_base_minor` over movements ordered by `stock_seq ASC`. Both folds are **additions of stored values** — `NUMERIC(18,4)` and `BIGINT` respectively — with no multiplication, no division and no rounding anywhere, so the rebuild is exact by construction. The average is derived afterwards and is never an input to the fold. A rebuilt key must equal the live cache to the unit, with no tolerance, including for a history containing repeating averages, full depletions, transfers and value-only movements (P3-AL-42).


## P3-AL-50 — Stock source-type registry

**Status: TO BE ENFORCED IN P3 · P3-S2 creates the registry; each identity is registered by the slice that implements it.**

**Problem.** P3-AL-09's identity tuple contains `source_type`. If that column is free text, then "an authorized domain wrote this movement" is a convention, and a defect or a future careless migration can invent `'purchase '`, `'Purchase'` or `'sale'` and the database will accept all three.

**Decision.** `source_type` is an FK into a **closed registry table**, `stock_source_types`, on exactly the pattern `accounting_source_types` established in `0042` and `stock_movement_kinds` uses in P3-AL-10. Free-form `source_type` text is **physically impossible**: an unregistered string is refused by the foreign key, not by a CHECK list a later migration could widen without review and not by application code.

**The predecessor law applies, unchanged.** A registry entry is a claim that the domain implementation exists. Therefore:

| Source type | Registered by |
|---|---|
| `inventory_opening` | P3-S3 |
| `inventory_adjustment` | P3-S3 |
| `stocktake` | P3-S3 |
| `inventory_transfer` | P3-S3 |
| `purchase` | P3-S4 |
| `negative_inventory_cost_adjustment` | P3-S4 |
| `purchase_reversal` | P3-S5 |
| `supplier_return` | P3-S5 |

**Not registered by Phase 3, and not reserved:** `sale`, `sales_return`, `pos_session`, `offline_oversell_exception`, or any other identity belonging to a phase that does not exist yet. Pre-registering them would advertise a capability that has no code, which is the mistake P2-S4 §45 named.

**P3-S2 creates the registry foundation and registers nothing.** Its structural tests prove the FK refuses an unregistered string and that the completeness mechanism (P3-AL-51) works, using a source type inserted **by the deployment/test authority inside a rolled-back fixture** — never a permanently seeded fake identity. That is the same mechanism P3-AL-12 uses to test deficit coverage, and it is a test fixture, not a production failpoint.

**Naming is fixed here, once.** The names in the table above are the final spellings, used identically in `stock_source_types`, in `accounting_source_types` where the same fact also posts, in every document and in every test. Note deliberately that the *stock* identity for a transfer is `inventory_transfer` while `stock_movement_kinds` distinguishes `transfer_out` from `transfer_in`: the source is one document, the kinds are the two legs, and P3-AL-09's tuple carries both.

---

## P3-AL-51 — Physical stock source completeness

**Status: TO BE ENFORCED IN P3 · P3-S2 builds the mechanism; every later slice applies it to its own source.**

**Problem.** P3-AL-09's unique tuple prevents duplicates and nothing else. Neither it nor "the same command creates both rows" prevents a movement whose source line does not exist, a finalized source line whose required movement is missing, or a source line deleted after its movement was written. Phase 2 met the identical problem on the accounting side and answered it with AL-01's `accounting_source_bindings` and deferred COMMIT-time guards — **not** with a polymorphic FK, and **not** with a promise about command code. Phase 3 answers it the same way, and Round 2 corrects two things the first draft got wrong.

### §A — The binding is movement-grained, not line-grained

**The defect.** The first draft wrote `stock_source_bindings` as one row per `(business_id, source_type, source_id, source_line_id)` and promised FKs in both directions against the five-part movement identity. That is **relationally impossible**: P3-AL-14 gives one transfer line **two** movements — same business, source type, source document and source line, differing only in `movement_kind` — so the four-part tuple is deliberately not unique on `stock_movements`, and a reverse FK to it cannot exist. A promise the schema cannot keep is worse than no promise, so the grain is corrected rather than the wording.

**The grain.** The binding carries **exactly the movement's five-part identity**, so both directions reference the same declared candidate key:

```
stock_source_bindings (
  tenant_id      UUID NOT NULL,
  business_id    UUID NOT NULL,
  source_type    TEXT NOT NULL REFERENCES stock_source_types (source_type),
  source_id      UUID NOT NULL,
  source_line_id UUID NOT NULL,
  movement_kind  TEXT NOT NULL REFERENCES stock_movement_kinds (movement_kind),
  PRIMARY KEY (business_id, source_type, source_id, source_line_id, movement_kind)
)

-- stock_movements already declares the same tuple UNIQUE (P3-AL-09):
--   UNIQUE (business_id, source_type, source_id, source_line_id, movement_kind)

-- movement -> binding
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_binding_fk
  FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
  REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind)
  DEFERRABLE INITIALLY DEFERRED;

-- binding -> movement
ALTER TABLE stock_source_bindings ADD CONSTRAINT stock_source_bindings_movement_fk
  FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
  REFERENCES stock_movements (business_id, source_type, source_id, source_line_id, movement_kind)
  DEFERRABLE INITIALLY DEFERRED;
```

Both are ordinary composite foreign keys against declared unique keys, deferred to `COMMIT`, exactly as AL-01 does between `journal_entries` and `accounting_source_bindings`. Neither ordering inside the transaction is privileged, and a half-written pair cannot survive a commit.

**Cardinality under this grain:**

| source line | bindings | movements |
|---|---|---|
| purchase line | 1 (`purchase`) | 1 |
| adjustment / damage line | 1 | 1 |
| stocktake line with a variance | 1 (`stocktake`) | 1 |
| coverage detail | 1 (`negative_inventory_cost_adjustment`) | 1 |
| **transfer line** | **2** (`transfer_out`, `transfer_in`) | **2** |

### §B — Proving the source is real, in both directions

**The second defect.** The first draft claimed "no movement without a real source detail" and an `ON DELETE RESTRICT` FK from the binding to the source line, while also forbidding a polymorphic FK. Both cannot hold: a generic table cannot carry a real FK that targets `purchase_items` or `inventory_transfer_lines` depending on a string column. And a completeness trigger installed only on the **source** table never fires when there is no source row, so an erroneous trusted command could commit a **fake binding plus fake movement with no source at all** — precisely the state the architecture claimed impossible.

**The mechanism — a per-source relational bridge with real foreign keys.** For every registered `source_type`, the slice that implements it creates a bridge table carrying real FKs to **both** sides:

```
stock_source_bridge_purchase (
  business_id    UUID NOT NULL,
  source_id      UUID NOT NULL,                       -- the purchase
  source_line_id UUID NOT NULL,                       -- the purchase item
  movement_kind  TEXT NOT NULL,
  source_type    TEXT NOT NULL GENERATED ALWAYS AS ('purchase') STORED,
  PRIMARY KEY (business_id, source_id, source_line_id, movement_kind),

  -- real FK to the DOMAIN line: existence and deletion protection, both physical
  CONSTRAINT bridge_purchase_line_fk
    FOREIGN KEY (business_id, source_id, source_line_id)
    REFERENCES purchase_items (business_id, purchase_id, id) ON DELETE RESTRICT,

  -- real FK to the generic BINDING
  CONSTRAINT bridge_purchase_binding_fk
    FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
    REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind)
    ON DELETE RESTRICT
)
```

and the **reverse check that the first draft was missing**: a `DEFERRABLE INITIALLY DEFERRED` constraint trigger installed on **`stock_source_bindings` itself**, one per registered source type, which fires for every binding row and, when `NEW.source_type` is its own, requires the matching bridge row at `COMMIT`. Because the bridge's FK to the domain line is a **real** FK, a bridge row cannot exist without its line — so a binding cannot exist without a real source line, and the chain

```
movement  ⇄  binding  →  bridge  →  real domain source line
```

is closed at `COMMIT` by ordinary constraints in every link. `ON DELETE RESTRICT` is now a claim the schema can actually keep, because it sits on the bridge, which is source-specific, rather than on the generic table, which cannot target a polymorphic parent.

**The registry is not allowed to outrun its guards.** Every migration that registers a `stock_source_types` row asserts, against `pg_trigger` and `pg_constraint` in the same transaction, that its source type has (a) its bridge table with both FKs and (b) its binding-side constraint trigger, and that **no registered source type lacks either**. A registered identity with no guard is therefore impossible, and the assertion is discovered from the catalogues rather than from a hand-written list — the same discipline G-4 applies to journal writers.

### §C — Source → stock completeness

Each source-owning slice also adds a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on **its own line table**, asserting at `COMMIT` that every **finalized** line has exactly the movement set its kind requires:

| source line, finalized | required movement set |
|---|---|
| purchase line (received) | exactly one `purchase` |
| transfer line | exactly one `transfer_out` **and** exactly one `transfer_in` |
| adjustment / damage line | exactly one movement of its kind |
| coverage detail | exactly one `negative_inventory_cost_adjustment` |
| stocktake line with a non-zero variance | exactly one `stocktake` |

A **draft** line requires nothing: completeness is a property of finalization, not of existence.

### §D — Immutability, stated separately from deletion

Deletion protection is the bridge's `ON DELETE RESTRICT` (§B). **Immutability is a different mechanism and is specified on its own**: once a source line is received, posted or otherwise finalized, its stock-bearing and financial fields — quantity, unit cost, variant, warehouse — are frozen by a `BEFORE UPDATE` trigger on the line table that raises when any of them changes and the row is finalized. A correction is a **new** document with its own source identity (P3-AL-20), never an edit. The same `BEFORE UPDATE OR DELETE` append-only trigger that protects `stock_movements` (P3-AL-01) also protects `stock_source_bindings` and every bridge table, so the chain cannot be edited out from under a movement either.

### §E — The bound transfer completeness vector

One `inventory_transfer_lines` row must produce at `COMMIT` exactly one `transfer_out` and one `transfer_in`, sharing the source document and source line, differing in `movement_kind`, on two different warehouse keys of one business. Each of the following must be refused **independently**, and each is its own test:

| attempted state | refused by |
|---|---|
| only `transfer_out` | §C line-side trigger (required set incomplete) |
| only `transfer_in` | §C line-side trigger |
| duplicate `transfer_out` | P3-AL-09's unique tuple |
| duplicate `transfer_in` | P3-AL-09's unique tuple |
| binding with no movement | §A `stock_source_bindings → stock_movements` deferred FK |
| movement with no binding | §A `stock_movements → stock_source_bindings` deferred FK |
| movement + binding with no transfer source line | §B binding-side constraint trigger, then the bridge's real FK to the line |
| deleting the finalized transfer line afterwards | §B bridge `ON DELETE RESTRICT` |
| editing the finalized transfer line's quantity or warehouse | §D `BEFORE UPDATE` freeze trigger |

**Required properties, restated as what the database refuses at `COMMIT`:** no movement without a real, registered source line; no finalized source line missing a movement it owes; no deletion of a bound source line; no mutation of a finalized line's stock or financial identity; no polymorphic FK anywhere; no change to `stock_movements`' core schema when a future domain adds a source.

**Why deferred constraint triggers and not `CHECK`s.** A `CHECK` states a single-row invariant and cannot read another table; completeness is a statement about a *set* of rows at the moment a transaction commits. `0049_accounting_periods.sql` already attaches a constraint trigger to `journal_entries`, so the pattern is precedented in the accepted codebase.

---


## P3-AL-52 — The hidden base variant may not appear, and may not be touched

**Status: TO BE ENFORCED IN P3 · P3-S1.**

**The defect (Round 3).** P3-AL-03 said the merchant never sees the base variant. The accepted code makes that a claim P3-S1 must actively keep, not one it inherits:

| Accepted read | What it does today | Effect of adding `is_base` alone |
|---|---|---|
| `CatalogService.getProduct()` variant list — `apps/api/src/modules/catalog/catalog.service.ts:148` | `SELECT … FROM product_variants WHERE business_id = $1 AND product_id = $2 AND status <> 'archived'` | **leaks**: enabling inventory on a simple product would make it render as a product with one variant |
| `CatalogService.listProducts()` search — `catalog.service.ts:96` | `EXISTS (… v.sku ILIKE … OR v.barcode ILIKE …)` | does not leak *by accident*, because a base variant's `sku` and `barcode` are NULL and `NULL ILIKE …` is NULL |
| `variants_sku_uq` / `variants_barcode_uq` — `0005_catalog.sql:51–52` | partial unique indexes `WHERE sku IS NOT NULL` / `WHERE barcode IS NOT NULL` | a NULL-identifier base variant **cannot** shadow a product identifier, by construction |

Two of those three are already safe. Relying on that is the mistake: "safe because the column happens to be NULL" is a fact about today's shape, and the first person to give a base variant a SKU would silently turn three facts into one bug. So the rule is stated once and applied to **every** merchant-facing variant read, including the two that do not need it yet.

**Decision — visibility.** Every merchant-facing catalog read excludes `is_base = true` from the **visible variant list** and from variant-identifier matching: `AND is_base = false` in `getProduct()`'s variant query and inside the `listProducts()` search `EXISTS`. The merchant-facing `VariantDto[]` never contains it. This is **P3-S1's** work, not P3-S7's: P3-S7 adds inventory UX, while P3-S1 must preserve the catalog UX that already exists.

**Decision — mutation boundary.** The base variant is **system-created stock identity**, not a merchant object. Ordinary variant commands may **not** create, archive, delete, edit attributes on, or assign a SKU, barcode or price to a row with `is_base = true`. Answer to the review's question: **NO**, for all six.

**The mechanism.**

1. `CHECK (is_base = false OR (sku IS NULL AND barcode IS NULL AND price_minor IS NULL AND attributes = '{}'::jsonb))` — a base variant physically cannot hold merchant identity, so it can never become visibly merchant-like even if a read is forgotten.
2. `UNIQUE (business_id, product_id) WHERE is_base` (already in P3-AL-03) — repeated enablement cannot create a second base variant; the enablement command is idempotent against it.
3. A `BEFORE INSERT OR UPDATE OR DELETE ON product_variants FOR EACH ROW` trigger that refuses any write touching a row with `is_base = true`, and any insert setting `is_base = true`, unless `current_user = 'daftar_inventory_internal'` — the Phase 3 twin of the accepted `daftar_accounting_internal` boundary (`0040_accounting_chart.sql:204–214`, `0045_accounting_post_entry.sql:373`). The tracking-enablement routine is the only writer that runs as that principal. Stable refusal: `catalog.base_variant_not_mutable`. **Round 4 (P3-AL-54 §F):** the trigger is `product_variants_10_base_variant_authority`, it runs with **invoker** rights (a definer-rights guard would always see its own owner as `current_user`), it also refuses the converse — the internal principal inserting a row with `is_base = false` — and it fires on `INSERT OR UPDATE` only. **Deletion is closed by privilege, not by the trigger:** no runtime role holds `DELETE` on `product_variants` (`0006_rls.sql:77–78`, `0013_security_boundary.sql:48`) and the internal role is given none, while a trigger on `DELETE` would also refuse the owner-level `ON DELETE CASCADE` from `products`/`businesses`, which is not a merchant write.
4. The catalog archive path already defers to the inventory check rather than duplicating it (P3-AL-41), so archiving a product cannot orphan a base variant that still has stock.

**The permanent proofs (P3-S1 acceptance).**

| # | Case | Required outcome |
|---|---|---|
| 1 | `getProduct()` on a simple product after enabling tracking | still renders as a **simple** product — no variant section appears |
| 2 | The hidden base variant | is **not** present in `VariantDto[]` |
| 3 | Search by name, SKU and barcode | byte-identical results to before enablement |
| 4 | A base variant's NULL `sku`/`barcode` | cannot shadow the product's identifiers — asserted against the partial unique indexes, not assumed |
| 5 | Enabling tracking twice on the same product | exactly one base variant, no error |
| 6 | Every existing product in the accepted golden catalog fixtures | none becomes visibly multi-variant because inventory was enabled |
| 7 | Ordinary variant update/archive/delete aimed at `is_base = true`, through the command **and** as raw SQL as `daftar_app` | **REFUSED**: `catalog.base_variant_not_mutable` for the command and for raw `UPDATE`; raw `DELETE` by privilege (`42501`), since `daftar_app` holds no `DELETE` (Round 4) |
| 8 | `INSERT` of a second `is_base = true` row, or of one carrying a SKU | refused by the unique index and the CHECK respectively |

---

## P3-AL-53 — A business created after the migration gets the same authority as one created before it

**Status: TO BE ENFORCED IN P3 · P3-S1.**

**The defect (Round 3).** P3-AL-38 defined the backfill of existing roles. A migration backfill says nothing about the next business. The accepted onboarding path passes `BUILTIN_ROLE_PERMISSIONS` from `packages/domain-core/src/permissions.ts:96–118` into `provision_create_business(...)` (`apps/api/src/modules/tenancy/tenancy.service.ts`), so a business created **after** the migration is seeded from that TypeScript registry and not from the migration at all. Backfilling only the migration would have produced two populations of businesses with different Phase 3 authority, diverging silently from the day P3-S1 shipped.

**Decision.** `BUILTIN_ROLE_PERMISSIONS` is the canonical registry and P3-S1 evolves it in the same commit as the migration, so both populations end identical:

| Role | Phase 3 result for a business created after the migration |
|---|---|
| `owner` | all **11** Phase 3 permissions. Structural: the registry is `owner: PERMISSIONS` (`permissions.ts:97`), so registering the 11 keys grants them by construction — the test asserts it rather than trusting it |
| `manager` | **exactly** `inventory.view`, `purchases.view`, `suppliers.view` — **appended** to the accepted Phase 1 list at `permissions.ts:98–116`, which is not altered, reordered or trimmed |
| `cashier` | **none** |
| a custom role created afterwards | **no automatic Phase 3 authority** |
| sensitive delegation ceiling | **unchanged** |

**The proof, and why reading the registry is not the proof.** P3-S1's acceptance **creates a real Business through the accepted provisioning flow after applying the candidate migration** and reads the rows actually persisted in `business_roles` / `role_permissions`. A test that asserts the constant equals itself proves nothing about `provision_create_business`, which is the frozen routine that actually writes the rows.

**Both populations, one assertion set.** The four migration assertions of P3-AL-38 are run again against the newly provisioned business, and a fifth compares the two populations directly: for every system role key, the Phase 3 permission set of a backfilled business equals that of a freshly provisioned one.

---


## P3-AL-54 — The physical database authority model for Phase 3

**Status: TO BE ENFORCED IN P3 · P3-S1** (the unit-history guard's *placement* is P3-S2, per P3-AL-05 §D).

This decision adds no rule. It fixes **who physically can** perform what P3-AL-04, -05, -15, -36, -52 and -53 already say **may** happen, so that no implementer chooses between direct table DML, a service-level transaction, an ad-hoc grant and a routine. Every mechanism named here has an accepted Phase 1/2 precedent, cited at the point it is used.

### §A — The defect, proved against the accepted tree

| Fact | Evidence | Consequence without this decision |
|---|---|---|
| `daftar_app` holds table-level `SELECT, INSERT, UPDATE` on `products` and `product_variants` | `infrastructure/database/migrations/0006_rls.sql:77–78` | A table-level privilege covers columns added later. `UPDATE products SET track_inventory = true, unit_code = 'kg'` as `daftar_app` would succeed the day P3-S1 ships, with no `inventory.adjust`, no base variant, and no unit rule. |
| `daftar_app` holds **no** `DELETE` on either table | same line — the grant is `SELECT, INSERT, UPDATE` | Deleting a base variant as `daftar_app` is already impossible by grant; only insert and update need guarding. |
| The frozen onboarding writer runs as **`daftar_platform`** | `0033_provisioner_atomic_authority.sql:308` — `ALTER FUNCTION … OWNER TO daftar_platform` on every provisioning function, including `provision_create_business` | An invoker-rights home-association maintainer would run as `daftar_platform` during onboarding and need `INSERT` on `branch_warehouses` — accidental **platform** mutation authority over inventory authorization. |
| Onboarding runs with `app.bypass_rls = 'true'` and no business scope | `apps/api/src/infra/database.ts:143–160`, `withProvisionerTransaction` passes `bypass = true` | `app_bypass()` is true inside onboarding for every principal except `daftar_app` (`0010_db_roles.sql:8–11`). |
| Roles are cluster objects created by **`bootstrap.sql`**, not by migrations | `infrastructure/database/bootstrap.sql:130–136` creates `daftar_accounting_internal`; `:237` grants the one membership | `daftar_inventory_internal` is created there too, never by `0053`+. |
| A non-superuser may transfer function ownership only if it owns the function, can `SET ROLE` to the new owner, **and** the new owner has `CREATE` on the schema | `0040_accounting_chart.sql:247–263`, taken at the top of each accounting migration and revoked at the end (`0040:471`, `0042:471/499`, … `0051:64/206`) | The same bracket is required in every Phase 3 migration that hands ownership to `daftar_inventory_internal`. |
| A migration that `CREATE OR REPLACE`s a function the internal role already owns is an **ownership** check that ignores `SET` | `bootstrap.sql:218–230` — the RB-P2-01 finding for `0038` | A later Phase 3 migration must replace such a function inside `SET LOCAL ROLE daftar_inventory_internal … RESET ROLE` (`0040:411–466`), never by widening the membership to `INHERIT TRUE`. |
| `TEMPORARY` is revoked from every named role and a `SECURITY DEFINER` path that omits `pg_temp` still searches it **first** | `bootstrap.sql:240–283`; `tests/security/search-path-shadowing.test.ts` forged a journal entry from `daftar_app` before P2-S3 | The internal role must be added to that `REVOKE TEMPORARY` list, and every Phase 3 routine must name `pg_temp` last. |

### §B — Three kinds of authority, never mixed

| Kind | Principals | May it log in? | What it is for in Phase 3 |
|---|---|---|---|
| **Deployment** | `daftar_migrator` | Yes — but no service loads its credential and it appears in no runtime connection URL (`bootstrap.sql:71–76`) | Applies migrations; owns tables; hands routine ownership to the internal role. `rolsuper = false`, `rolbypassrls = false`. |
| **Runtime** | `daftar_app`, `daftar_platform`, `daftar_worker`, `daftar_provisioner`, `daftar_identity`, `daftar_resolver`, `daftar_reconciler` | Yes | Hold `EXECUTE` on named routines and the `SELECT`s they need. **No runtime role receives any Phase 3 table DML that this decision does not list in §H, and no runtime role is a member of any internal role.** |
| **Internal, NOLOGIN** | `daftar_accounting_internal` (Phase 2, unchanged), **`daftar_inventory_internal`** (new) | **No** — no password can exist | Owns `SECURITY DEFINER` routines and holds the narrow table privileges they need. Reachable only by calling a routine it owns. The two are **separate**: inventory never runs as the accounting principal and accounting never as the inventory one. |

### §C — `daftar_inventory_internal`, completely

**Created in `infrastructure/database/bootstrap.sql` by P3-S1**, idempotently, in exactly the shape of `daftar_accounting_internal` (`bootstrap.sql:130–136`):

```
CREATE ROLE daftar_inventory_internal
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- and on re-run:
ALTER ROLE daftar_inventory_internal
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL;
GRANT USAGE ON SCHEMA public TO daftar_inventory_internal;
-- added to the existing REVOKE TEMPORARY list (bootstrap.sql:274–282):
REVOKE TEMPORARY ON DATABASE <current_database()> FROM daftar_inventory_internal;
GRANT daftar_inventory_internal TO daftar_migrator WITH INHERIT FALSE, SET TRUE;
```

- **Its one membership.** `daftar_migrator`, `INHERIT FALSE, SET TRUE`. It is required, not optional: P3-S1 transfers routine ownership to this role, and PostgreSQL lets a non-superuser do that only when it can `SET ROLE` to the new owner. `INHERIT FALSE` means the migrator does not *hold* inventory authority passively; it can only assume it deliberately, and only a deployment credential can. **No runtime principal is a member**, directly or transitively.
- **It is not** `daftar_app`, `daftar_platform`, `daftar_worker`, `daftar_provisioner` or `daftar_accounting_internal`, and holds no membership in any of them.
- **What it may read and write** is exactly the §H column for it, and nothing else. In particular it has **no `UPDATE` and no `DELETE` on `product_variants`**, so it physically cannot mutate a merchant variant; and no privilege at all on any accounting table.
- **`scripts/phase2-deployment-authority.ts`** re-derives the set of roles the history hands ownership to (`bootstrap.sql:185–192`). Adding a third owner turns that gate red until bootstrap grants the membership — which is the design; P3-S1 updates both in the same commit.
- **Asserted by the P3-S1 migration from the catalogues**, on the `0040:510–534` pattern, prefix `inventory.authority_leak`: the role exists; `rolcanlogin`, `rolsuper`, `rolbypassrls`, `rolcreaterole`, `rolcreatedb`, `rolreplication` are all false; `rolinherit` is false; its only member is `daftar_migrator` with `inherit_option = false`; it does not hold `CREATE` on `public` at commit; it does not hold `TEMPORARY`.

### §D — The safe `SECURITY DEFINER` contract (permanent)

Every function owned by `daftar_inventory_internal` — trigger functions included — satisfies all of the following, and P3-S1 adds a **catalogue-discovered** check (every `pg_proc` row whose owner is that role, not a hand-written list) to `tests/security/search-path-shadowing.test.ts` and to the permanent static guards:

1. `SECURITY DEFINER` with `SET search_path = pg_catalog, public, pg_temp` — the accepted form (`0045_accounting_post_entry.sql:163`), with **`pg_temp` named and last**. Omitting it does not exclude it; it puts it first.
2. No caller-writable schema appears before a trusted one; `public` is not caller-writable (`bootstrap.sql:284` onward revokes `CREATE` from `PUBLIC`).
3. `REVOKE EXECUTE … FROM PUBLIC` on every one; `EXECUTE` granted only as §H lists. Trigger functions get **no** `EXECUTE` grant at all — PostgreSQL does not check `EXECUTE` when a trigger fires, so a grant would only enable a direct call.
4. No dependency on `TEMPORARY` objects; the role holds no `TEMPORARY`.
5. No runtime role holds `CREATE` on `public`; the internal role holds it only inside the migration that transfers ownership, taken at the top and revoked at the end of the same file, and the file refuses to commit if it survived (`0040:514` pattern).
6. No dynamic SQL built from caller input. Identifiers are fixed at authoring time; any `format()` uses `%I`/`%L` over constants only. No routine resolves a table, schema or function name from an argument or a GUC.
7. The owner is `NOLOGIN` — asserted, not assumed (§C).

### §E — The three runtime entry points, named

The application **keeps** everything it does today: authentication, `MembershipContext` resolution, and the permission check. It then calls **one named routine** inside the non-posting seam `withBusinessTransaction` (P3-AL-32), so business scope comes from the `app.business_id` GUC the seam sets — never from an argument. There is no `trusted` flag, option or bypass parameter anywhere.

| Routine | Owner | `EXECUTE` | Checked by the application first | Enforced by the routine |
|---|---|---|---|---|
| `inventory_configure_product(p_product_id uuid, p_track boolean, p_unit_code text, p_unit_decimals smallint)` | `daftar_inventory_internal` | `daftar_app` only | `inventory.adjust` | Product is in `app_business()`; `unit_code` exists in `units`; tracked ⇒ unit present (P3-AL-04); unit change refused after history (P3-AL-05 §D, by the P3-S2 trigger); disable refused at non-zero stock (P3-AL-41, from P3-S2); **creates the base variant** when enabling tracking on a product with no variants (P3-AL-03), idempotently. The **only** writer of `track_inventory`, `unit_code`, `unit_decimals` and of any `is_base = true` row. |
| `structure_associate_warehouse_branch(p_warehouse_id uuid, p_branch_id uuid)` | `daftar_inventory_internal` | `daftar_app` only | `warehouse.manage` **and** `branch_scope_mode = 'all'` (P3-AL-15 §B) | Both rows exist in `app_business()`; neither is archived; duplicate is an idempotent success; the composite FKs make a cross-business pair impossible regardless. |
| `structure_dissociate_warehouse_branch(p_warehouse_id uuid, p_branch_id uuid)` | `daftar_inventory_internal` | `daftar_app` only | same | Both in `app_business()`; the home association is refused (and refused again by `branch_warehouses_keep_home`); an absent association is an idempotent success. |

The routines enforce **structure**, not scope mode. Branch authority in DAFTAR is application-resolved today (`member_branch_scopes` is read by `StructureService`), and this decision does **not** introduce a signed domain assertion for it — the accepted threat model does not require one. The honest boundary statement: a stolen `daftar_app` credential can already `INSERT`/`UPDATE` `branches` and `warehouses` for the business it scopes itself to (`0006:78`), so these routines give it no reach it lacked. What they remove is the ability to write the three configuration columns, the base variant, or an association **as raw DML** — which is the defect. Audit rows are written by the application through `AuditService.recordTx` in the same transaction, as every Phase 1 structure command does.

**How RLS admits the routines.** They run as `daftar_inventory_internal` inside the transaction `daftar_app` opened, so `app.tenant_id` and `app.business_id` are already set and `app.bypass_rls` is false. The existing `tenant_membership` / `business_isolation` policies (`0006_rls.sql:28–49`) therefore admit the internal role to exactly that business's rows — the same rows `daftar_app` could see — with no new policy and no bypass. A call made without business scope sees zero rows and fails as "not found".

### §F — The column guards, and why they must run with invoker rights

**`products_10_inventory_config_authority`** — `BEFORE INSERT OR UPDATE ON products FOR EACH ROW`, function **`SECURITY INVOKER`**:

- **INSERT**: if `current_user <> 'daftar_inventory_internal'` and (`NEW.track_inventory` or `NEW.unit_code IS NOT NULL` or `NEW.unit_decimals IS NOT NULL`) → raise.
- **UPDATE**: if `current_user <> 'daftar_inventory_internal'` and any of the three is `IS DISTINCT FROM` its old value → raise.
- Every other column — price, category, SKU, barcode, the free-text `products.unit`, status, version — is untouched by this guard. Translations keep their own path (`0036`).
- Refusal: **`inventory.configuration_authority_required`**, one stable code for all three columns and both operations.

**`product_variants_10_base_variant_authority`** — `BEFORE INSERT OR UPDATE ON product_variants FOR EACH ROW`, **`SECURITY INVOKER`**:

- any operation touching a row with `is_base = true` (`OLD` or `NEW`) by a `current_user` other than `daftar_inventory_internal` → raise **`catalog.base_variant_not_mutable`** (P3-AL-52);
- **and the converse**: an `INSERT` by `daftar_inventory_internal` with `is_base = false` → raise the same code. The internal role writes base variants only; the merchant runtime writes merchant variants only. With no `UPDATE`/`DELETE` grant (§H), the internal role cannot touch a merchant variant at all.
- **`DELETE` is closed by privilege, deliberately not by this trigger.** No runtime role holds `DELETE` on `product_variants` (§A), and the internal role receives none (§H). A `DELETE` branch would also fire on the owner-level `ON DELETE CASCADE` from `products` and `businesses`, which runs as the table owner, and refuse a removal that is not a merchant write. Once stock history exists, the movement FK refuses the deletion anyway.
- The P3-AL-52 `CHECK` (`is_base = false OR (sku IS NULL AND barcode IS NULL AND price_minor IS NULL AND attributes = '{}'::jsonb)`) stays exactly as written. No relaxation.

**Why invoker rights are mandatory here, and definer rights would be a hole.** Inside a `SECURITY DEFINER` function, `current_user` **is the function's owner**. A definer-rights guard owned by `daftar_inventory_internal` would therefore see `current_user = 'daftar_inventory_internal'` on **every** call and admit every writer; one owned by anyone else would refuse the legitimate routine. The guard's whole job is to observe *who is writing*, so it must run as the writer. It needs no privilege of its own: it reads `current_user`, `OLD` and `NEW`. The static guard in §D therefore carries an explicit exception list containing exactly these two functions, each asserted to be `prosecdef = false`.

**Why not column-level grants instead.** `REVOKE UPDATE (col)` does not remove a table-level `UPDATE`, so the only grant-based fix is to revoke table-level `UPDATE`/`INSERT` on `products` from `daftar_app` and re-grant them per column. That is a column list every future migration must remember to extend, where forgetting silently breaks the catalog or silently grants the wrong column; and it still produces a permission-denied error rather than a stable refusal code. The Tech Lead also ruled out revoking `UPDATE` on `products` outright. The trigger guards exactly the three new columns and nothing else, and is the single mechanism for both `INSERT` and `UPDATE`.

`ALTER TABLE … ADD COLUMN … DEFAULT false` fires no row trigger, so the migration that adds the columns is unaffected, and every existing product starts untracked (P3-AL-04).

### §G — Two guards on `products`, composed, never merged

PostgreSQL fires triggers of the same timing and event **in name order**. The names are part of the contract:

| Order | Trigger | Slice | Question it answers | Runs as | Refusal |
|---|---|---|---|---|---|
| 1 | `products_10_inventory_config_authority` | P3-S1 | **WHO** may change inventory configuration | `SECURITY INVOKER` (§F) | `inventory.configuration_authority_required` |
| 2 | `products_20_unit_history_lock` | P3-S2 | **WHEN** the unit may no longer change | `SECURITY DEFINER`, owner `daftar_inventory_internal` | `inventory.unit_identity_locked` |

The history lock is definer-rights for the opposite reason the authority guard is invoker-rights: it must **not** depend on who is asking. Its `EXISTS (SELECT 1 FROM stock_movements …)` for the product must see every movement of that product, not only those the caller's RLS scope admits; so it reads through a `FOR SELECT` policy on `stock_movements` admitting `current_user = 'daftar_inventory_internal'` — the pattern of `0042_accounting_journal.sql:390` for the accounting principal. It never inspects `current_user` to decide.

| Writer | Stock history? | Change | Guard 1 | Guard 2 | Outcome |
|---|---|---|---|---|---|
| Ordinary catalog SQL as `daftar_app` | any | `track_inventory`, `unit_code` or `unit_decimals` | **refuses** | — | `inventory.configuration_authority_required` |
| Ordinary catalog SQL | any | price, category, SKU, barcode, `products.unit` | passes | not fired (`WHEN` clause on unit columns) | **allowed** |
| `inventory_configure_product` | none | unit | passes | passes | **allowed** |
| `inventory_configure_product` | exists (any `on_hand`, including 0) | unit | passes | **refuses** | `inventory.unit_identity_locked` |
| `inventory_configure_product` | exists | tracking only, unit unchanged | passes | not fired | governed by P3-AL-41 in the routine |

Guard 2 is declared `WHEN (OLD.unit_code IS DISTINCT FROM NEW.unit_code OR OLD.unit_decimals IS DISTINCT FROM NEW.unit_decimals)`, so it costs nothing on ordinary catalog updates.

### §H — The live grant matrix P3-S1 must produce

Default deny. This is the **intended catalogue state**, and P3-S1's tests read `information_schema.role_table_grants`, `role_column_grants`, `role_routine_grants`, `pg_auth_members` and `pg_policy` — never the migration text. "—" means no privilege.

| Object | `daftar_app` | `daftar_platform` | `daftar_worker` | `daftar_provisioner` | `daftar_identity` / `resolver` / `reconciler` | `daftar_inventory_internal` |
|---|---|---|---|---|---|---|
| `units` (registry) | `SELECT` | — | — | — | — | `SELECT` |
| `unit_names` (registry) | `SELECT` | — | — | — | — | — |
| `branch_warehouses` | `SELECT` | — | — | — | — | `SELECT, INSERT, DELETE` |
| `products` | unchanged `SELECT, INSERT, UPDATE` (0006), three columns guarded by §F | unchanged | unchanged | unchanged | unchanged | `SELECT`; `UPDATE (track_inventory, unit_code, unit_decimals)` only |
| `product_variants` | unchanged `SELECT, INSERT, UPDATE`, `is_base` rows guarded by §F | unchanged | unchanged | unchanged | unchanged | `SELECT`; `INSERT (business_id, id, product_id, is_base)` only; **no `UPDATE`, no `DELETE`** |
| `businesses`, `branches`, `warehouses` | unchanged | unchanged | unchanged | unchanged | unchanged | `SELECT` (the RLS subquery and the structural checks need it) |
| `journal_entries` | unchanged | unchanged | unchanged | unchanged | unchanged | **—** |
| `inventory_configure_product`, `structure_associate_warehouse_branch`, `structure_dissociate_warehouse_branch` | `EXECUTE` | — | — | — | — | owner |
| every Phase 3 trigger function | — | — | — | — | — | owner (definer ones) |
| membership in `daftar_inventory_internal` | **none** | **none** | **none** | **none** | **none** | — (only `daftar_migrator`, `INHERIT FALSE`) |

"Unchanged" is the accepted state and is itself asserted: `daftar_platform` holds only `SELECT` on `products` and `product_variants` (`0010_db_roles.sql:20–22` narrowed by `0013_security_boundary.sql:48`) and `SELECT, INSERT, UPDATE` on `warehouses` (`0010:20–22`, which is how the platform-owned `provision_create_business` writes its warehouse); `daftar_provisioner` holds no table privilege on any of these (`0032_provisioner_narrow_functions.sql:22–27`) and reaches them only through platform-owned routines. **From P3-S2** the internal role additionally holds `SELECT` on `stock_movements` (through a `FOR SELECT` policy admitting it, §G) and on `stock_levels` (for the P3-AL-41 disable rule); nothing else is added.

No registry has runtime DML. The platform, worker and provisioner receive no inventory mutation authority; the only inventory row that onboarding produces is the home association, and it is produced by the internal role's maintainer (§I), not by the provisioner or the platform.

**`journal_entries` and TD-09 (P3-AL-36).** P3-S1's future-date trigger on `journal_entries` is an **accounting** guard, so it belongs to **accounting** authority: its function is `SECURITY DEFINER`, owned by `daftar_accounting_internal`, with the §D discipline, because it must read `businesses.timezone` whatever principal inserts — the accounting routine, or the schema owner in the raw insert TD-09 exists to catch — and `accounting_seeder_read` (`0040:213–214`) already admits exactly that principal. No inventory principal touches `journal_entries`, and no grant on it changes.

### §I — The home-association maintainer's authority, through all three writers

P3-AL-15 §A's objects, with their authority fixed:

| Object | Function rights | Owner | Why |
|---|---|---|---|
| `warehouses_home_branch_maintain` — `AFTER INSERT ON warehouses` | `SECURITY DEFINER` | `daftar_inventory_internal` | The three writers run as `daftar_app` (two Structure paths) and **`daftar_platform`** (frozen onboarding). Invoker rights would require `INSERT` on `branch_warehouses` for both, including the platform. Definer rights need it for the internal role only. |
| `warehouses_require_home_branch` — deferred, `AFTER INSERT ON warehouses` | `SECURITY DEFINER` | `daftar_inventory_internal` | Must see `branch_warehouses` whatever the writer's grants. Remains **load-bearing**: it proves the maintainer did not silently fail, was not dropped, and was not bypassed. |
| `branch_warehouses_keep_home` — deferred, `AFTER DELETE OR UPDATE ON branch_warehouses` | `SECURITY DEFINER` | `daftar_inventory_internal` | Must see `warehouses` whatever the writer's grants. |
| `warehouses_home_branch_immutable` — `BEFORE UPDATE ON warehouses` | `SECURITY INVOKER` | migrator | Reads only `OLD`/`NEW`; needs no privilege. |

**How RLS admits the maintainer, precisely.** `branch_warehouses` gets the accepted two-policy layering of `warehouses` itself (`0006_rls.sql:28–49`): `ENABLE` and **`FORCE`** row-level security, a permissive `tenant_membership` policy and a `RESTRICTIVE` `business_isolation` policy, both honouring `app_bypass()`. **No new policy names the internal role.** The maintainer is admitted by **exactly the predicate that admitted the warehouse row it derives from**: `app_business()` in the two Structure paths, and `app_bypass()` in onboarding — which is true there for every principal except `daftar_app` (`0010_db_roles.sql:8–11`), and is precisely what already admits `provision_create_business`'s own `INSERT INTO warehouses`. The maintainer writes only `(NEW.business_id, NEW.branch_id, NEW.id)`, and the composite FKs make any other pair impossible. **`daftar_provisioner` and `daftar_platform` receive no privilege on `branch_warehouses`.**

### §J — Managed PostgreSQL: the P3-S1 portability proof

P3-S1 **fails** if any of its objects work only because CI applies migrations as a superuser. Carrying forward RB-P2-01, the acceptance includes a real run:

- `bootstrap.sql` (with the P3-S1 additions) applied by the deployment administrator;
- migrations `0000 → 0052 → every P3-S1 candidate` applied as **`daftar_migrator` with `rolsuper = false` and `rolbypassrls = false`**, through the existing `tests/integration/migration-portability.test.ts` and `scripts/phase2-deployment-authority.ts`;
- every ownership transfer to `daftar_inventory_internal` bracketed by `GRANT CREATE ON SCHEMA public TO daftar_inventory_internal` / `REVOKE …` in the same file, with the end-state asserted;
- any later replacement of a function the internal role already owns done under `SET LOCAL ROLE daftar_inventory_internal` (`0040:411–466`), never by changing the membership to `INHERIT TRUE`;
- the resulting catalogue — owners, `prosecdef`, `proconfig`, grants, policies, memberships — **diffed against a superuser build**, so a difference the superuser hid is a failure rather than a surprise in production.

---


## 2. The self-review question

> *Could two competent engineers implement materially different financial or data semantics while both claiming to follow this document?*

The places where the answer was "yes" on the first pass, and what closed each:

| Ambiguity found | Closed by |
|---|---|
| "Order movements deterministically" — by what? | P3-AL-02 names `stock_seq`, its allocation point and its uniqueness. |
| "Value-only movement" with `qty + unit_cost` only | P3-AL-11 adds an explicit signed `value_delta_base_minor` with CHECKs that make the two forms mutually exclusive. |
| Rounding mode left to the implementer | P3-AL-08 fixes HALF_EVEN at one boundary and names PostgreSQL's `round()` as the wrong primitive. |
| "The warehouse" in an authorization check | P3-AL-39 checks the **set** of affected warehouses. |
| Transfer journal entry — yes or no | P3-AL-14 says no, and why. |
| Immediate-cash purchase | P3-AL-24 says one model, always `Dr Inventory / Cr AP`. |
| Zero-denominator `by_value` landed cost | P3-AL-22 refuses; it does not fall back to an equal split. |
| Positive stocktake variance with no cost | P3-AL-16 refuses and requires an explicit cost; zero is never invented. |
| Case B opening inventory when the GL already has 1200 | P3-AL-18 posts nothing and requires exact equality. |
| Where the accounting transaction begins | P3-AL-32 specifies one unit-of-work boundary and forbids nested commits. |
| What happens to the "exactly three source types" assertions | P3-AL-34 makes it a named P3-S3 work item with the exact evolution. |

**Second pass — the Tech Lead's named attack surfaces.** Each was re-attacked directly, and each is now closed by a rule rather than by a convention:

| Attack surface | Was it ambiguous? | Closed by |
|---|---|---|
| Quantity precision | **Yes — and the rule was wrong.** `scale(qty) > unit_decimals` refuses exactly one piece on a `unit_decimals = 0` product, measured. | P3-AL-05: exact representability `abs(qty) = trunc(abs(qty), unit_decimals)`, with ten bound vectors and `scale()` withdrawn by name. |
| Movement rounding | **Yes.** "All intermediate arithmetic is exact" and "the exact `qty × unit_cost` product" contradicted each other at 14 decimals against a 10-decimal column. | P3-AL-49 §A/§C: one boundary, `HALF_EVEN(exact(qty × unit_cost), 10)`, and the stored value is authoritative forever. |
| Valuation cache | **Yes.** An `avg`-only cache forces `on_hand × avg`, which drifts on every operation. | P3-AL-01 + P3-AL-49 §A: `valuation_base_minor` cached as an exact sum; deriving valuation from the quotient is forbidden by name. |
| Valuation ↔ GL rounding *(found in Round 2, by cross-reading)* | **Yes, fatally.** A fractional movement value against a `BIGINT` journal meant two roundings, and rounding is not additive, so zero tolerance was unreachable. | P3-AL-49 §A: the movement value **is** integer minor and the journal line **is** that integer — one rounding in the system, none in the reconciliation, with the equation and nine vectors written out. |
| Binding cardinality *(Round 2)* | **Yes.** One transfer line has two movements, so a line-grained binding could not carry a reverse FK at all. | P3-AL-51 §A: movement-grained binding on the same five-part key, both FKs ordinary and deferred. |
| Real source existence *(Round 2)* | **Yes.** A source-side trigger never fires when there is no source row, so a fake binding + movement could commit. | P3-AL-51 §B: a binding-side deferred trigger plus a per-source bridge whose FK to the domain line is real. |
| Slice independence *(Round 2)* | **Yes.** P3-S1's matrix required P3-S2/S3/S4 entities. | P3-AL-32: re-scoped to the primitive with accepted Phase 2 operations and fixtures; end-to-end proofs assigned to P3-S3 and P3-S4. |
| Permission seeding *(Round 2)* | **Yes.** The lock and the plan disagreed about Manager. | P3-AL-38 wins; the plan restates it, and a separate assertion forbids any non-owner role holding a **sensitive** key. |
| Zero-stock residual | **Yes.** `on_hand = 0` with `valuation = ±0.0000000001` was reachable and unaddressed. | P3-AL-49 §C: the full-depletion flush, and `on_hand = 0 ⇒ valuation = 0` asserted under the lock before COMMIT. |
| Transfer valuation | **Yes.** "Σ = 0 with no intermediate rounding" was unachievable if both legs computed `qty × avg` independently. | P3-AL-14: the destination's value is the exact negation of the stored source value; the pair sums to zero by construction. |
| Transaction composition | **Yes.** One assertion-requiring seam contradicted the no-journal transfer; two engineers would have split the commit or minted a fake assertion. | P3-AL-32: two typed seams, the distinction carried by the type, every boolean bypass forbidden by name, and a six-case proof matrix. |
| Source completeness | **Yes.** The unique tuple proved no-duplicates only; the rest rested on "the same command writes both rows". | P3-AL-50 (closed registry) + P3-AL-51 (generic binding, deferred COMMIT guards, deletion protection, post-finalization immutability). |
| Multiple deficit coverages | **Yes — a real collision.** One purchase line covering N layers produced N movements with one identity; the unique tuple would have admitted one and refused the rest. | P3-AL-13: an adjustment **header** per operation and an immutable **detail** per coverage; `source_line_id` is the coverage id, so every coverage has its own identity. |
| Tax boundary | No, and it stays open **bounded**. | P3-AL-23: `tax_minor = 0` only, `purchase.tax_policy_absent` otherwise; OD-03 is not resolved here and does not block P3-S1/S2/S3. |
| Warehouse authority | No. | P3-AL-15 + P3-AL-39: the **set** of affected warehouses, permission and scope together, refused in the command. |
| Accounting source identity | No, and the stock twin now matches it. | P3-AL-34 (accounting registry, per-slice registration) and P3-AL-50 (stock registry, same law, separate table with the reason stated). |

**Third pass — the Round 2 questions, answered against the corrected document.** These are the five the Tech Lead named, and each is answered by a mechanism, not by an intention:

| Question | Answer |
|---|---|
| **Can zero-tolerance Inventory ↔ GL reconciliation be disproved with two legitimate fractional-minor operations?** | **No, not any more.** Under P3-AL-49 a movement's value is already `BIGINT` minor and the journal line **is** that integer, so there is one rounding in the system and the reconciliation performs none. Vectors B and C keep the disproof of the *old* model as permanent negative controls. |
| **Can one source line that creates two movements be represented by the binding cardinality without violating any declared UNIQUE or FK?** | **Yes.** P3-AL-51 §A makes the binding movement-grained on the same five-part key `stock_movements` declares `UNIQUE`, so a transfer line has two bindings and both directional FKs are ordinary composite FKs. The four-part draft could not have had a reverse FK at all. |
| **Can a movement + binding commit while the alleged source row does not exist?** | **No.** P3-AL-51 §B adds the check the first draft was missing: a constraint trigger on `stock_source_bindings` itself, plus a per-source bridge whose FK to the domain line is real. A source-side trigger alone never fires when there is no source row — that was the hole. |
| **Does P3-S1 require a table or command owned by P3-S2/S3/S4?** | **No.** P3-AL-32's matrix is re-scoped to the primitive, proved with accepted Phase 2 operations and test-owned fixtures; the real transfer, adjustment and purchase-receipt proofs are assigned to P3-S3 and P3-S4 in both pages. |
| **Does every document give Manager the same exact permissions?** | **Yes.** `inventory.view`, `purchases.view`, `suppliers.view` and nothing else, in P3-AL-38 and in the execution plan, with set equality asserted and a separate assertion that no non-owner role holds any of the eight sensitive keys. |


**Fourth pass — the Round 3 questions, answered against the accepted implementation.** These eight are the Tech Lead's, and each is answered by a mechanism in the tree, not by an intention in this page.

| Question | Answer |
|---|---|
| **How does a warehouse created tomorrow get authorized?** | By the same schema object that authorizes one created today. P3-AL-15 §A: a non-deferred `AFTER INSERT` maintainer writes the home association for **every** writer, and a deferred constraint trigger refuses the commit if it is missing. There are three writers and the third is inside a frozen `SECURITY DEFINER` migration, so nothing short of a schema rule reaches all of them. |
| **Can the home branch relation disappear?** | **No.** `branch_warehouses_keep_home` refuses the delete or update while the warehouse row exists, whatever its status, and `warehouses.branch_id` itself is refused any update. Row I of the matrix attempts it as raw SQL, not only through the command. |
| **Who may add a second branch to a warehouse?** | An actor with `warehouse.manage` **and** `branch_scope_mode = 'all'`, through `structure.addWarehouseBranch`, which **P3-S1** creates — not P3-S7, which adds only the UI. |
| **Can an assigned manager expand their own warehouse reach?** | **No**, and this is why the scope condition is not redundant. The "both sides reachable" rule would have been exactly that primitive. Row F of the matrix is the permanent proof. |
| **Can a product's unit change after stock history exists?** | **No.** P3-AL-05 §D: from the first movement of any variant, `unit_code` and `unit_decimals` are immutable forever, refused by a `BEFORE UPDATE ON products` trigger installed by P3-S2 — before P3-S3 authorizes the first real movement producer — and by the configuration command. Rows 3 and 4 test both paths. |
| **Does zero stock unlock a historical unit?** | **No**, and row 5 exists because that is the branch a reasonable implementer would allow. Archival and tracking-disable rules are about *current* quantity; the unit lock is about *history*, and P3-AL-41 now says so where the two meet. |
| **Does the hidden base variant appear in today's Catalog API?** | **No** — but only because P3-S1 changes the read. `CatalogService.getProduct()` at `catalog.service.ts:148` returns every non-archived variant and knows nothing about `is_base`; P3-AL-52 excludes it there and in the search predicate, keeps its merchant fields empty by `CHECK`, and admits writes to it only as `daftar_inventory_internal`. |
| **Does a Business created after P3-S1 get the same Phase 3 permissions as an older one?** | **Yes**, and it is proved rather than assumed. Onboarding seeds from `BUILTIN_ROLE_PERMISSIONS`, not from the migration, so P3-AL-53 evolves the registry in the same commit and acceptance **provisions a real business after the migration** and reads the persisted rows. A sixth check compares the two populations directly. |


**Fifth pass — the Round 4 questions, answered by the physical model.** The Tech Lead's ten. If any answer were "implementation choice", P3-S0 would not be closed; none is.

| Question | Answer |
|---|---|
| **Who owns the inventory trusted routines?** | **`daftar_inventory_internal`**, and nothing else. The three runtime entry points (`inventory_configure_product`, `structure_associate_warehouse_branch`, `structure_dissociate_warehouse_branch`), the home-association maintainer, completeness proof and keep-one trigger, P3-S2's movement primitive and `products_20_unit_history_lock`. The TD-09 guard is accounting's and is owned by `daftar_accounting_internal`. The two column guards are invoker-rights by design and own nothing. P3-AL-54 §C, §E, §G, §I. |
| **Can that owner log in?** | **No.** `NOLOGIN`, `PASSWORD NULL`, and the P3-S1 migration refuses to commit unless `rolcanlogin`, `rolsuper`, `rolbypassrls`, `rolcreaterole`, `rolcreatedb`, `rolreplication` and `rolinherit` are all false. §C. |
| **Who may `SET ROLE` to it?** | **Only `daftar_migrator`**, through `GRANT … WITH INHERIT FALSE, SET TRUE` in `bootstrap.sql` — required because PostgreSQL lets a non-superuser transfer ownership only to a role it can become. No runtime role, directly or transitively; asserted from `pg_auth_members` and `pg_has_role`. PM-42. |
| **What may it read and write?** | Exactly the §H column: `SELECT` on `units`, `products`, `product_variants`, `businesses`, `branches`, `warehouses`; `UPDATE (track_inventory, unit_code, unit_decimals)` on `products`; `INSERT (business_id, id, product_id, is_base)` on `product_variants` with no `UPDATE`/`DELETE`; `SELECT, INSERT, DELETE` on `branch_warehouses`; from P3-S2, `SELECT` on `stock_movements` and `stock_levels`. Nothing on any accounting table. RLS admits it only to the rows the calling scope already admits. |
| **Which runtime role has table DML?** | **None**, on any table Phase 3 creates. On the accepted tables the accepted grants are **unchanged** — `daftar_app` keeps `SELECT, INSERT, UPDATE` on `products` and `product_variants` (`0006:77–78`) and the three new columns and base rows are guarded by trigger instead; `daftar_platform` keeps `SELECT` only on them (`0013:48`); `daftar_app` holds `SELECT` only on `branch_warehouses`. §H. |
| **How does the frozen onboarding writer produce the home association?** | `provision_create_business` (owned by `daftar_platform`, `0033:308`) inserts its warehouse unchanged; the `AFTER INSERT` maintainer, `SECURITY DEFINER` owned by the internal role, writes the home row; RLS admits it by `app_bypass()`, the same predicate that admitted the warehouse; the deferred completeness trigger refuses the commit if it is missing, so a failure rolls back the whole onboarding. Neither the platform nor the provisioner receives a grant. §I, matrix rows B, C, L. |
| **Can `daftar_app` mutate the three inventory identity columns directly?** | **No.** `products_10_inventory_config_authority` refuses any `INSERT` setting them and any `UPDATE` changing them unless `current_user = 'daftar_inventory_internal'`, with `inventory.configuration_authority_required`. It is invoker-rights because a definer-rights guard would always see its own owner. §F, PM-39, PM-40. |
| **Can the ordinary Catalog touch the base variant?** | **No.** Reads exclude it (P3-AL-52); `product_variants_10_base_variant_authority` refuses `INSERT`/`UPDATE` of an `is_base = true` row by anyone but the internal role; `DELETE` is refused by privilege, since no runtime role holds it; and the internal role cannot touch a merchant variant, having no `UPDATE`/`DELETE` and being refused any `is_base = false` insert. §F. |
| **What RLS applies to `branch_warehouses`?** | `ENABLE` and `FORCE`, with the accepted two-policy layering of `warehouses` (`0006:28–49`): permissive `tenant_membership` and restrictive `business_isolation`, both honouring `app_bypass()`. No policy names a role. A `daftar_app` connection sees only its business's rows and can write none. §I. |
| **Does a managed non-superuser migrator succeed?** | **It must, or P3-S1 fails.** The acceptance is a real `0052 → P3-S1` run as `daftar_migrator` with `rolsuper = false` and `rolbypassrls = false`, every ownership transfer bracketed by a same-file `CREATE ON SCHEMA public` grant and revoke, later replacements under `SET LOCAL ROLE`, and the resulting catalogue diffed against a superuser build. Every mechanism used has already run this way in Phase 2 (`0040`–`0051`). §J, PM-43. |

---

## 3. What this document does not authorize

`0053` does not exist. No Phase 3 table, endpoint, package or UI exists. P3-S0 is documentation only, and the next step is the Tech Lead's review of this lock — not P3-S1.
