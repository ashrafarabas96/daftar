# DAFTAR — Phase 3 Architecture Lock / قفل معمارية المرحلة الثالثة

> **Status: DECISION RECORD. No schema, no code, no migration.** This document resolves the architectural ambiguity that would otherwise cause rework during Phase 3 (Inventory, Purchases, Suppliers). It is binding on the Phase 3 implementation. Where an older planning page conflicts with it, this page wins; where it conflicts with an **accepted Phase 2 contract or a frozen migration**, the accepted implementation wins and this page records the contradiction rather than overriding it.
>
> **Baseline.** Accepted Phase 2 merge commit `0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f` on `main` (accepted source head `bf2eeda1494b0333cfef26123d55bcf54134e402`), post-merge CI run `36028186854` SUCCESS on all five required jobs. Migrations `0000`–`0052` are frozen forever; the manifest holds 53 entries with `frozenThrough = 0052_accounting_journal_lines_rls_performance.sql`. Phase 3 begins at `0053`, which **does not exist yet and is not authorized by this document**.
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

**Decision: the tolerance is zero** (P3-AL-43). Every journal amount for an inventory movement is produced from the same movement, by the same command, in the same transaction, through the same HALF_EVEN conversion. An exact match is therefore achievable by construction, and a tolerance would be exactly where a real divergence hides. The older "within tolerance" wording is superseded for Phase 3 by this document; `DAFTAR_ACCOUNTING_RULES.md` is an accepted Phase 2 page and is **not** rewritten here, because rewriting a prior decision record is not how a later phase changes a rule — naming the supersession is.

### F-8 — There is no Purchase or Stocktake state machine yet

`docs/DAFTAR_STATE_MACHINES.md` carries Order, Invoice, Payment, Installment, Subscription, Sync, Sale, Journal Entry, Opening Balance and Accounting Period. It carries **no** Purchase and **no** Stocktake. Both are defined in this lock (P3-AL-19, P3-AL-16) and are added to that page by the slice that implements each — P3-S4 and P3-S3 respectively — rather than by P3-S0, which would be documenting a state machine no code can enter.

### F-6 — The 21-account system registry already contains every account Phase 3 needs

`0040_accounting_chart.sql` seeds exactly 21 system identities and asserts the count. Phase 3 needs `inventory` (1200), `accounts_payable` (2000), `supplier_receivable` (1150), `cogs` (5000), `purchase_price_variance` (6200), `rounding` (6100), `fx_gain`/`fx_loss` (4900/6900) and `opening_equity` (3000) — **all present**. No system account #22 is required by any decision in this document (P3-AL-17).

---

## P3-AL-01 — Inventory source of truth

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Decision.** `stock_movements` is append-only operational truth. `stock_levels` is a **cache** of `(on_hand, avg_unit_cost_base_minor)` per stock key, and nothing else is truth about quantity or cost.

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

**UI consequence.** A simple product keeps looking simple: the merchant never sees the base variant. Product identity stays catalog/presentation identity; stock identity is always variant identity (P3-AL-48).

**Forbidden.** `product_id OR variant_id` polymorphism in `stock_movements`; a second "simple stock" table; making `product_variants.sku` carry the product's SKU for a base variant.

---

## P3-AL-04 — Existing-product transition, with no silent backfill guess

**Status: TO BE ENFORCED IN P3 · P3-S1.**

**Facts.** `products.unit` is free text and nullable. There is no `track_inventory`, no `unit_code`, no `unit_decimals`. Existing rows carry whatever the merchant typed.

**Decision.**

1. The migration adds `products.track_inventory BOOLEAN NOT NULL DEFAULT false`, `products.unit_code TEXT NULL`, `products.unit_decimals SMALLINT NULL`. **Every existing product becomes inventory-untracked.** No stock row, no base variant and no movement is created because a migration ran.
2. `products.unit` is **not** parsed, mapped, normalized or inferred. "kg", "كغم", "Kg." and "kilo" are a human label; guessing from it would be Zero Silent Errors violated in the one place where the guess becomes financial truth.
3. Enabling tracking is an explicit merchant action requiring `inventory.adjust`, and it requires a canonical unit selection (P3-AL-05). The command creates the base variant (P3-AL-03) when the product has no variants.
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
- **Fractional refusal is physical.** Every quantity that enters a movement passes the trusted command, which resolves the product's `unit_decimals` and refuses a quantity with more decimals than that: `scale(qty) > unit_decimals` → `inventory.quantity_precision_invalid`. A `piece` product with `unit_decimals = 0` therefore cannot receive `0.5`, at the database, not in a form validator.
- **No conversions in Phase 3.** 1 kg is never silently 1000 g. `units` carries no conversion factor and no base-unit column, because a column that exists is a column a later slice will populate and a later query will trust. UoM conversion is a future capability with its own decision.

---

## P3-AL-06 — Stock-key first-row concurrency

**Status: TO BE ENFORCED IN P3 · P3-S2.**

**Decision.** Exactly one `stock_levels` row per `(business_id, warehouse_id, variant_id)`, enforced by the primary key. Every command that touches a stock key runs the same three steps, in this order, inside the caller's transaction:

1. `INSERT INTO stock_levels (…) VALUES (…, 0, NULL, 0) ON CONFLICT (business_id, warehouse_id, variant_id) DO NOTHING;`
2. `SELECT … FROM stock_levels WHERE … FOR UPDATE;` — always, even when step 1 inserted the row;
3. compute → append movement → update cache.

`ON CONFLICT DO NOTHING` followed by an unconditional locking read is what makes the missing-row race safe: the loser of the insert race blocks on the winner's row lock and then reads the winner's state. A check-then-insert is forbidden, and so is `ON CONFLICT DO UPDATE` with a computed value, because that would perform arithmetic outside the lock.

`stock_levels` rows are **never deleted**. A key that reaches zero keeps its row, its `last_stock_seq` and its `avg_unit_cost_base_minor`, because deleting it would restart the sequence and lose the cost that a later receipt's weighted average needs.

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
- **One rounding boundary, one mode.** All intermediate arithmetic is exact. When an exact weighted-average result must be persisted to `NUMERIC(28,10)`, it is rounded **HALF_EVEN at that persistence boundary and nowhere else**. There is no intermediate rounding, at any step, for any reason.
- PostgreSQL agrees by construction: the trusted commands compute in `NUMERIC` and the one `round(x, 10)` call sits at the same boundary. PostgreSQL's `round(numeric, int)` is HALF_UP, not HALF_EVEN, so the commands use an explicit HALF_EVEN helper rather than `round()` — this is the exact tie-breaking trap the directive names, and it is closed by writing the helper, not by assuming.
- Conversion to `BIGINT` minor units for a journal line remains the **accepted Phase 2 contract**: HALF_EVEN, once, at posting time, with the residue distributed largest-line-first and any remainder to `6100 Rounding Adjustment`. Phase 3 does not re-implement it and does not add a second money rounding.
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

**No polymorphic FK.** `stock_movements` holds **no** foreign key into any domain table. The relationship is proved in the other direction, exactly as AL-01 proved it for the journal: the domain command that creates the movement is the same command that creates the line, in one transaction, and the movement's identity tuple is derived from the line's own primary key. A future domain therefore adds a `source_type` value and its own line table and needs no change in `stock_movements`.

**Idempotency.** A retried command cannot produce a second movement for one source line: the unique tuple refuses it. This is physical, not a cache lookup.

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
qty_delta               NUMERIC(18,4) NOT NULL              -- may be exactly 0
unit_cost_base_minor    NUMERIC(28,10) NULL                 -- NULL for value-only
value_delta_base_minor  NUMERIC(28,10) NOT NULL             -- signed, may be 0 only if qty_delta <> 0
CHECK (NOT (qty_delta = 0 AND value_delta_base_minor = 0))
CHECK ((qty_delta = 0) = (unit_cost_base_minor IS NULL))
```

- A **quantity movement** states `qty_delta <> 0` and `unit_cost_base_minor`, and its `value_delta_base_minor` is the exact product, computed and stored by the command (never by the caller). An outbound movement's value uses the key's current average, an inbound movement's its own cost — that asymmetry is the weighted-average rule and is stated once, here.
- A **value-only movement** states `qty_delta = 0`, `unit_cost_base_minor IS NULL` and a signed `value_delta_base_minor`.

**Rebuild is defined for both ledgers.** For a stock key, `on_hand = Σ qty_delta` and `valuation = Σ value_delta_base_minor`, both ordered by `stock_seq`, and `avg_unit_cost = valuation / on_hand` where `on_hand > 0`. Quantity and valuation are therefore each reconstructable from the movements alone, which is what makes `stock_levels` a cache rather than a second truth.

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
3. append one value-only `negative_inventory_cost_adjustment` movement per coverage with `value_delta = qty_covered × (actual − provisional)`, signed;
4. post the catch-up journal entry (`Dr COGS / Cr Inventory` when actual > provisional, reversed when actual < provisional) in the **same** transaction, through the composition seam of P3-AL-32;
5. apply the normal weighted average to whatever receipt quantity remains after the deficit reaches zero.

Two concurrent receipts cannot cover the same quantity: both must hold the stock key's `stock_levels` row before they may read a deficit layer, so they are serialized by P3-AL-06's lock before FIFO is even consulted. The `FOR UPDATE` on the layers is the second line of defence, not the first.

---

## P3-AL-14 — Transfers

**Status: TO BE ENFORCED IN P3 · P3-S3.**

**Decision.** A transfer line produces an **atomic pair** of movements sharing one `source_id` and one `source_line_id`, distinguished by `movement_kind`:

- `transfer_out` at the **source** key: `on_hand -= qty`, `value_delta = -(qty × avg_source)`, and the source average is **unchanged** — an outbound quantity carries value away but creates no new cost.
- `transfer_in` at the **destination** key: `on_hand += qty`, `unit_cost = avg_source snapshot`, destination average recomputed by the standard formula.

`Σ value_delta` over the pair is **exactly zero**, in `NUMERIC(28,10)`, with no intermediate rounding. Total business inventory valuation is therefore provably unchanged, which is the invariant the test asserts (GOLD-44 is the bound vector).

**Accounting decision — locked.** A same-business warehouse-to-warehouse transfer creates **no journal entry**. `Inventory(1200) → Inventory(1200)` within one business at identical total valuation is a movement of a physical thing, not an economic event; a zero-effect entry would be noise in every report forever. The transfer still creates stock movements, an audit event and an outbox event, all in one transaction.

**Cross-business transfer is forbidden**, physically: both keys carry `business_id` and the command resolves both warehouses within the caller's single business scope. A transfer between businesses is a sale and a purchase between two legal entities, and inventing it as a warehouse move would create inventory from nothing in one set of books and destroy it in another.

---

## P3-AL-15 — Warehouse authorization and branch scope

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
2. computes `Σ(qty × unit_cost)` over the supplied stock detail in `NUMERIC(28,10)`, then converts once, HALF_EVEN, to base minor units;
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
- The posting account must belong to the same business, must be **active** for a NEW settlement, and must be an asset or clearing account — checked by the command against `accounts.account_type` and the system-key registry, not by a name.
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

**The seam — specified, not implemented in P3-S0.**

1. **A unit-of-work boundary on `Database`**: `withBusinessTransaction(scope, fn)` which `BEGIN`s once, sets **both** the RLS scope GUCs (`app.tenant_id`, `app.business_id`, `app.actor_user_id`) **and** `app.accounting_assertion`, runs `fn(client)`, and `COMMIT`s once. Inventory tables need the scope GUCs for row-level security; the posting primitive ignores them and takes every identity from the verified assertion. Both are therefore set, and neither weakens the other.
2. **A coherence check at the boundary**: the seam refuses to open if the assertion's `tenant_id`/`business_id` claims do not equal the scope's. Without it, a defect could write stock in one business under an assertion for another — two isolation systems that disagree, which is worse than either alone.
3. **The accounting ports accept an existing transaction handle.** `AccountingPostingPort.postEntry()` and its siblings gain a variant that takes the caller's client instead of opening a connection. The existing single-operation methods remain, implemented in terms of the new one, so every accepted Phase 2 call site keeps working unchanged and no accepted behaviour is re-tested.
4. **No nested independent commit anywhere.** No saga, no compensating transaction, no outbox-driven "eventually post". This is one local PostgreSQL database; distributed-transaction patterns here would buy nothing and lose atomicity.
5. **No new bypass.** The seam carries an assertion or it does not open. There is no `skipAuthorization`, no `postTrusted()` and no `rawJournalInsert()`, and `accounting_post_entry` (with its P2-S4 siblings) remains the one physical journal writer. G-4 discovers journal writers from the schema, so a new one would have to satisfy the entire protection set on the same commit.

**P3-S0 specifies this seam and implements none of it.**

---

## P3-AL-33 — Domain authorization, not `accounting.post`

**Status: TO BE ENFORCED IN P3 · P3-S1 defines the seam; used from P3-S3.**

A merchant who receives stock or pays a supplier does **not** need `accounting.post`. Accounting is a **consequence** of an authorized domain operation, not a second permission the merchant must hold.

**How, exactly.** Authority is proven once, in the domain layer: the command checks its own permission (`purchases.receive`, `inventory.adjust`, `suppliers.pay` …) **and** the warehouse/branch scope (P3-AL-39). Only then does it mint the accounting assertion for the posting that its own success implies. The assertion minter is already a port that the engine never touches, so the typed internal seam is "a domain command that has proven its own authority may mint"; it is not a flag, not a boolean and not a parameter that could be passed `true`.

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

**Why a trigger is correct and a CHECK is not.** A CHECK constraint states a **timeless row invariant**: PostgreSQL evaluates it when the row is written and never again, and it is also re-evaluated by operations such as `ALTER TABLE … VALIDATE`. `entry_date <= CURRENT_DATE` is not timeless — it is a statement about the moment of insertion. Worse, `CURRENT_DATE` is **not immutable**, so PostgreSQL will not accept it in a CHECK at all; forcing it in through a wrapper function would produce a constraint whose truth value changes underneath committed rows, which is exactly the kind of "true when written, false forever after" invariant that makes a table impossible to dump and restore. The debt register's own suggestion is therefore not implementable as written, and this document says so rather than passing the problem to the implementer.

**Shape.**

- `BEFORE INSERT ON journal_entries FOR EACH ROW`, resolving the **business's timezone** (`businesses.timezone`) and computing the current civil date there — never the server's timezone.
- Refuses a future `entry_date` with the stable code **`accounting.entry_date_in_future`**, the same code the three posting commands already raise, so no caller sees a new error identity.
- The error message carries **no financial values**.
- Precedent: `0049_accounting_periods.sql` already attaches `accounting_period_guard` to `journal_entries` the same way, and the permanent upgrade assertions query triggers by name rather than exhaustively (F-5), so nothing breaks and no frozen byte changes.
- **The command-level checks remain.** This is defence in depth beneath every posting command, not a replacement for any of them.

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

- **Owner**: all eleven, seeded by the migration for every existing business, on the exact `0041` pattern (owner system role only, set-wise, with a completeness assertion).
- **Manager**: the three `view` keys **only**.
- **Cashier**: none.
- **Existing custom roles**: untouched. Not one of them gains a Phase 3 permission.

Sensitive operational authority is assigned by the Owner, deliberately. A migration that turned every existing manager into a purchasing and stock authority would be a silent privilege grant across every business in production.

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
- Catalog lifecycle may not destroy stock truth: the archive path in Catalog calls the inventory check rather than duplicating it.

---

## P3-AL-42 — Stock-level rebuild

**Status: TO BE ENFORCED IN P3 · P3-S2.**

"`stock_levels` is a cache" is meaningful only if reconstruction is real and tested.

**Algorithm.** For a stock key: read all movements ordered by `stock_seq ASC`; fold `on_hand += qty_delta` and `valuation += value_delta_base_minor` in exact `NUMERIC(28,10)`; derive `avg_unit_cost = valuation / on_hand` when `on_hand > 0`, carrying the last known average when `on_hand = 0` (so a key that empties and refills does not lose its history). `last_stock_seq` is the final movement's sequence.

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

- **Valuation formula:** `Σ value_delta_base_minor` over all movements of the business, in `NUMERIC(28,10)` — not `Σ(qty × avg)`, which re-derives from the cache and would compare the cache against the GL rather than the ledger against the GL. (The two agree whenever the cache is correct; using the movements makes the check independent of the thing it is checking.)
- **Aggregation boundary:** per business, summed over every stock key.
- **Rounding boundary:** the valuation is converted to base minor units **once**, HALF_EVEN, the same contract that produced the journal amounts.
- **Tolerance: zero.** Every journal amount was produced from the same movements by the same rounding contract, so an exact match is achievable and anything else is a defect. A tolerance would be a place for real divergence to hide. This **supersedes** the older "within tolerance" wording of INV-ACC-11 in `docs/DAFTAR_ACCOUNTING_RULES.md` (see F-7), which Phase 2 explicitly left for Phase 3 to activate.
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

---

## 3. What this document does not authorize

`0053` does not exist. No Phase 3 table, endpoint, package or UI exists. P3-S0 is documentation only, and the next step is the Tech Lead's review of this lock — not P3-S1.
