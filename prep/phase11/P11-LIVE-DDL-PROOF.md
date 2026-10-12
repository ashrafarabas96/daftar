# P11 — PACK A (APPAREL): THE EXECUTED SCRATCH PROOF, AND THE EIGHT DEFECTS IT FOUND

**What this is.** The Master Continuous Mission's §18 says, for Phase 11: *execute unnumbered DDL for a scratch proof, then the Owner's allocation at promotion*, and *do not drop any required part of the scope because it is currently design only*. §18 also fixes the build order — start with the cheapest independent end-to-end path, **apparel**. This document is the result of doing that, and the point of it is the part a design document cannot produce: **eight defects, six of them in this preparation's own specification or its own proof, found by execution and none of them findable by reading.** Two of the eight were found only after V2 of the Master Continuous Mission refused the sentence this document used to carry — *"no concurrency case here; apparel has none to prove"* — on the ground that **"no locks, therefore no concurrency" is not a proof**. Running the races it asked for found two real holes in Pack A.

**Status.** `PREPARED / NOT PROMOTED`. On the directive's ladder: **`PREPARED`**, not `CHALLENGED` — no independent challenger has read any of this. Nothing is promoted, **no migration number exists**, and the Migration Owner allocates at promotion from the live prefix.

**Evidence class.** What follows is `PROVEN BY TEST` and `PROVEN BY DATABASE CATALOGUE` on a scratch cluster in **this** container, and nothing more. It is **not CI**, it is **not release evidence**, and it carries **no timing or performance claim**. The container runs **Node 22.22.0 while the repository requires `>=24 <25`**, so no npm workspace suite was run at all and none is claimed; the proof uses PostgreSQL and `psql` only, which is why it was possible here.

---

## 1. What was executed, exactly

One script, `prep/phase11/harness/rebuild_and_prove.sh`, which does every step from zero on every run. Reported in the form it ran in:

| step | what | result |
|---|---|---|
| 1 | `DROP DATABASE IF EXISTS daftar` / `CREATE DATABASE daftar` on a throw-away PostgreSQL **16.15** cluster | ok |
| 2 | `infrastructure/database/bootstrap.sql`, rendered with scratch passwords, as the deployment administrator — six runtime roles, `btree_gist`, `citext`, `pgcrypto` | ok |
| 3 | migrations `0000` → `0086`, **87 files**, each in its own transaction with the ownership-handover bracket, **as `daftar_migrator` and not as a superuser** | **87/87 applied** |
| 4 | `prep/phase11/ddl/p11-pack-a-apparel.sql` — **unnumbered** — as `daftar_migrator` | applied; **end-state assertion passed** |
| 5 | a world of two tenants, two businesses, two products, two axes, five axis values (one archived), one two-axis matrix | built |
| 6 | the proof suite, `prep/phase11/harness/proofs.py` | **21 cases, 0 failed** |
| 6b | three **real-concurrency races**, `prep/phase11/harness/races.py` — two live backends, sentinel-awaited interleaving, **no `sleep()`** | **3 races, 0 findings** (after the two fixes of §2) |
| 7 | the frozen tree re-verified **after** the run | 0 tracked changes under `infrastructure/database`; `frozenThrough = 0079_phase4_pos_till_sessions_cart.sql`; **80 frozen entries, 0 digest mismatches** |

**Run repeatedly from zero, green each time.** Two raw logs are kept:

- `prep/phase11/harness/RUN-EVIDENCE-2026-10-12.txt` — the first green run, before the concurrency work.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-d813de2.txt` — **the authoritative log**, the one this document reports, run on a clean working tree so the evidence names its own subject.

**Run identity of the authoritative log**, printed by the script itself as its first lines, because V2 §18 says not to bind the proof to the remote head by guesswork:

| field | value |
|---|---|
| `RUN_ID` | `p11-packA-20261012T115215Z-1834` |
| `RUN_AT_UTC` | `2026-10-12T11:52:15Z` |
| `SOURCE_REPO` | `https://github.com/ashrafarabas96/daftar` |
| `SOURCE_BRANCH` | `claude/phase11-prep-re0epv` |
| `SOURCE_SHA` | **`d813de2b76b8fdf4667686dd1f0de1a48436b222`** |
| `SOURCE_TREE_DIRTY` | **`no`** — nothing uncommitted; the SHA is the whole input |
| `MIGRATIONS_SHA` (tree of `infrastructure/database/migrations`) | `b128c7033a3381bd2237d0a1405f0676ac509960` |
| `MANIFEST_SHA256` | `4b4dd6e9e1359eba6536a0c70c0f3cf056e62b47bfed833026541df5ffbe6804` |
| `PACK_A_DDL_SHA256` | `7561f8f859d2007643c8ec78992d739d1aa137fa6733ba76bc5a8dcf7af1d3a8` |
| `PG_VERSION` | PostgreSQL 16.15 |
| `NODE_VERSION` | v22.22.0, against repository `engines.node >=24 <25` — **no npm suite was run** |

A reader can therefore check out that exact SHA, hash those two files, and get the same digests, or know at once that they are reading a different subject. The dirty-tree flag is part of the record on purpose: an earlier trial run printed `SOURCE_TREE_DIRTY : YES`, and that run is not reported here because its input had no name.

**Why step 3 is the load-bearing one.** CI applies migrations as a superuser. A superuser is not subject to RLS and is not checked for the two privileges an ownership handover needs, so a superuser run cannot tell you whether a real deployment would work. Applying the whole frozen prefix as `daftar_migrator` is the only version of this measurement that means anything, and it is the version the nearby Phase 4 slice learned to run after a deployment died halfway where CI had been green.

**Why step 7 is not decoration.** The Phase 5 contamination was a harness whose clean-check was narrower than its mutations: it printed "tree clean" while a frozen migration was dirty. Step 7 therefore re-reads **the whole manifest against disk** and `git status` over the whole `infrastructure/database` subtree, **after** the proofs rather than before them.

---

## 2. The eight defects execution found

### Defect 1 — business-authored names: the specification cited a column that does not exist
`P11-MIGRATION-PATCH-REQUEST.md` §2.1 gave axes a `translations JSONB` column, "validated by `CHECK` on key set, **like `products.translations`**".

**`products` has no `translations` column.** The live catalogue stores business-authored names in **per-entity translation row tables** keyed `(business_id, <entity>_id, locale)` — `product_translations`, `category_translations` — each with `locale IN ('ar','en','tr')`, a 1–200 character name check, a composite FK `ON DELETE CASCADE`, and a **deferred `*_keep_one` trigger** (`category_requires_translation`) that refuses leaving an entity with no name in any locale.

So the spec would have introduced **a second pattern for one truth** — the thing this phase exists to avoid — and would have lost the keep-one guarantee, leaving an axis that renders as a blank label. Pack A now has `product_attribute_axis_translations` and `product_attribute_value_translations` in the catalogue's own shape. **The cited precedent was the whole justification, and it was not real.**

### Defect 2 — `tenant_id` denormalization: the right convention, applied to the wrong family
`P11-AL-14` requires `tenant_id` denormalized onto **every** new relation with `FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)`, and policies in the `0086` scalar-subselect form.

Measured: that is the **inventory and Phase-4** convention (`stock_levels`, `pos_till_sessions` both carry `tenant_id`). **Catalog relations carry none** — `products`, `product_variants` and `category_translations` all use the `EXISTS (SELECT 1 FROM businesses b WHERE b.id = …)` form, and `0086` did not rewrite them. Applying `P11-AL-14` literally would have made apparel the only catalog relation shaped unlike its neighbours, which is divergence dressed as rigour. Pack A follows the catalog's shape, and `P11-AL-14` is now read as **per-family** rather than universal.

### Defect 3 — the trigger position was already occupied
The spec named the canonicalizer `product_variants_30_matrix_canonical()`. `product_variants` already carries **`product_variants_30_archive_requires_zero_stock`** at position 30, and PostgreSQL fires same-event triggers in **name order**, so the spec's name would have created a silent ordering coin-flip between two guards. It is `_40_` now, which also states the intended order: the existing base-variant authority (10) and the stock-identity and archive guards (20, 30) decide first.

### Defect 4 — the entry routine borrowed the wrong authority
§2.5 of the patch request specified `catalog_generate_variant_matrix` as `SECURITY DEFINER` owned by `daftar_catalog_internal`, "consuming one assertion through `inventory_assertion_consume` **exactly as every entry routine does**".

Measured: `daftar_catalog_internal` owns **exactly one routine in the entire database**, and it is a trigger function. There is **no catalog entry-routine precedent at all**, so "exactly as every entry routine does" describes a pattern that does not exist for catalog. Worse, `inventory_operation_kinds` is an **inventory** registry (34 ops; the only catalog-adjacent one is `inventory.configure_product`), so a catalog write consuming an inventory assertion would **borrow the inventory authority for a catalog operation** — precisely the one-authority-per-truth violation this phase is organized against.

**Matrix generation needs no assertion and no new authority.** It is catalog writes with no stock effect, so it is an ordinary permission-checked application command over the existing authorized catalog writes — the same path every product and variant write uses today, none of which consumes an assertion either. The database keeps what only the database can keep: closure, canonicality and uniqueness. An invented dependency, and the routine that carried it, are both gone.

### Defect 5 — a refusal with no reachable caller
The spec listed `catalog.variant_matrix_base_conflict` for "`is_base` is true and `attributes <> '{}'`". Execution refused that insert with **`catalog.base_variant_not_mutable`** instead — from `product_variants_10_base_variant_authority`, which fires first and refuses **any** base-variant write from every principal but `daftar_inventory_internal`, while refusing a non-base insert *from* that principal. And `product_variants_base_shape_ck` already makes `is_base AND attributes <> '{}'` structurally impossible.

So the specified refusal was **dead code**: unreachable from any merchant path, and redundant where it was reachable. This project has already paid to learn that dead code cannot be mutation-tested and that the honest answer is structural rather than another test case. Pack A therefore adds **no** refusal here, and the proof suite asserts the **existing** guard refuses it — which is a stronger statement than the spec's, because it holds whether or not Phase 11 ships.

### Defect 6 — in the proof, not the product: the canonicalizer's stated mechanism was inert
`catalog_attributes_canonical` aggregated the map with `jsonb_object_agg(k, v ORDER BY k)` so that "two equal maps have one text form". The happy-path case asserted the stored value would be `{"color": "red", "size": "s"}`. It came back **`{"size": "s", "color": "red"}`** — unsorted — **while the reversed-key uniqueness case still hit the index.**

**jsonb canonicalizes object key order itself**, by key length then bytewise. The `ORDER BY` was doing nothing, and the property the index depends on held for a reason the function did not supply. The function now validates shape and returns its input, which is smaller, honest, and still `IMMUTABLE` and index-usable; and the suite carries an explicit case proving jsonb's own normalization (`'{"size":…,"color":…}'::jsonb = '{"color":…,"size":…}'::jsonb` → `t`), so the property is proved where it actually lives. The test expectation was wrong, not the code — **and a passing test would have recorded a false mechanism as verified.**

### Defect 7 — a race the design said could not exist: the axis-removal closure hole
V2 refused this document's own sentence that apparel had no concurrency to prove. The second race it forced ran: **T1 deletes the `color` axis of a product while T2, concurrently, inserts a variant naming `color`.** Both read a consistent snapshot; neither sees the other; both would commit — leaving a variant naming an axis that no longer exists, which is the closure invariant `C-APP-01` broken while every single-transaction test stays green.

The cause is that the canonicalizer's closure check was an ordinary unlocked `SELECT`. **A row that is read but not locked is not protected.** The validator now reads the axis row `FOR KEY SHARE`, so a concurrent `DELETE` of that axis must wait for the variant's transaction, and the loser is refused with `catalog.variant_axis_unregistered` rather than committing. The race is now `PASS` with *"variants naming an unregistered axis after both commit: 0"*.

**This is the defect the pre-V2 document would have shipped**, and it was invisible to reading: the single-transaction case for an unregistered axis was already green.

### Defect 8 — `catalog.variant_matrix_locked`: a guard conditional on a row that may not exist yet
The spec and the first Pack A refused an `attributes` change **only when the variant already had stock history**. The third race ran that boundary: **T1 changes `attributes` while no stock exists; T2, concurrently, inserts the variant's first `stock_levels` row.** T1's guard reads *"is there stock?"* and sees none; T2's insert is unaware of T1. Both commit, and the result is a variant whose combination changed **and** carries stock — the exact state the guard exists to forbid.

A cross-table read of an **absent** row cannot be locked: there is no row to lock, and only `SERIALIZABLE` would give a predicate lock, which is not this database's isolation level. So no lock order fixes this one.

It was closed by **removing the class of failure instead of guarding it**: a variant's combination is now **unconditionally immutable**, refused with **`catalog.variant_matrix_immutable`** whether or not stock exists. The merchant path for a wrong combination is to archive the variant and create the right one, which is what `P11-AL-04` says a combination is — an identity, not an attribute. The refusal is now entirely inside Pack A's own table and needs nothing from the inventory authority, so it requires no patch request and no lock contract with another owner. The race is `PASS`: T1 is refused, T2 commits its stock row, and the final combination is the original one.

**The cheaper fix would have been to ask the inventory authority for a lock on a row that does not exist. The correct fix was to make the question unaskable.**

**Three further corrections were to the proof's own shape, and are listed because a test that is wrong about the world is a defect too:** a product cannot be inserted with `track_inventory` by any principal but the inventory configuration command's owner (`products_10_inventory_config_authority`), so the apparel world uses untracked products and the one case needing stock inserts its `stock_levels` row as the internal principal; `products.base_price_minor` is `NOT NULL`; and a warehouse needs a branch. None is a pack defect; all three would have been "the DDL is wrong" if read rather than run.

---

## 3. What is now proved, and in which words

| case | verdict |
|---|---|
| a registered combination is accepted and stored | GREEN |
| jsonb itself canonicalizes key order (the real source of index correctness) | GREEN |
| `attributes` an array / a nested value / a non-text value | RED — `catalog.variant_attributes_shape_invalid` ×3 |
| an axis the product's matrix does not register | RED — `catalog.variant_axis_unregistered` |
| a value that exists but is **archived** | RED — `catalog.variant_axis_value_unregistered` |
| a value that does not exist at all | RED — `catalog.variant_axis_value_unregistered` |
| a **partial** combination (one of two registered axes) | RED — `catalog.variant_axis_set_incomplete` |
| a product with **no** registered axes carrying attributes | RED — `catalog.variant_axis_unregistered` |
| a base-variant write | RED — `catalog.base_variant_not_mutable`, **the pre-existing guard** |
| the same combination twice | RED — `product_variants_matrix_uq` |
| the same combination with the keys in the **other order** | RED — `product_variants_matrix_uq` |
| `attributes` changed **at all** (the combination is the identity; see defect 8) | RED — `catalog.variant_matrix_immutable` |
| an axis **named by existing variants** cannot be removed | RED — `catalog.matrix_axis_in_use` |
| as `daftar_app` in business B: business A's axes invisible | GREEN — 0 rows |
| as `daftar_app` in business B: inserting an axis **for** business A | RED — row-level security |
| as `daftar_app` in business B: business A's matrix rows invisible | GREEN — 0 rows |
| with business A's **own** context the same rows are visible | GREEN — 2 rows (the read is scoped, not broken) |
| business A's context with the **wrong tenant** | GREEN — 0 rows (`tenant_membership`, not only `business_isolation`) |
| `daftar_app` does not bypass RLS | GREEN — `rolbypassrls = f` |

Every refusal names **its own** string. None is satisfied by a non-empty error list, and the RLS cases are run **from the application role with a real session context**, never as a superuser — because a superuser bypasses RLS and therefore proves nothing about it.

**One live-design fact confirmed rather than asserted:** on `stock_levels`, the restrictive `business_isolation` carries the internal principal in its **USING** expression and **not** in its `WITH CHECK`. So `daftar_inventory_internal` may read across businesses but may only write rows matching the session's business — exactly the law `P11-AL-14` states, now `PROVEN BY DATABASE CATALOGUE`.

### 3a. The three races, as they ran

Two live backends per race, interleaved by sentinel (each side announces where it is and waits for the other), **no `sleep()` anywhere** — a `sleep` proves only that one ordering happened once.

| race | T1 | T2 | observed | verdict |
|---|---|---|---|---|
| **A** duplicate combination | `INSERT {size:s,color:red}`, then `COMMIT` | the same combination, concurrently | T2 **blocked** while T1 held the speculative insert; rows after both: **1**; T2 refused on `product_variants_matrix_uq` | PASS — exactly one commits, and the loser **blocks** rather than racing |
| **B** axis removed vs variant inserted | `DELETE` the `color` axis, then `COMMIT` | `INSERT` a variant naming `color`, concurrently | T2 **blocked**; T2 refused `catalog.variant_axis_unregistered`; variants naming an unregistered axis after both commit: **0** | PASS — closure holds after both commit (**defect 7's fix**) |
| **C** attributes changed vs first stock movement | `UPDATE attributes` while no stock exists, then `COMMIT` | `INSERT` the variant's **first** `stock_levels` row, concurrently | T1 refused `catalog.variant_matrix_immutable`; T2 **not** blocked and committed; final combination unchanged, stock rows: **1** | PASS — the interleaving cannot produce a changed-combination-with-stock row (**defect 8's fix**) |

Race A's value is not that a unique index works; it is **that the second session blocks instead of both proceeding to a check** — a uniqueness guard implemented as a `SELECT` then an `INSERT` would have passed every serial test and failed this one.

The harness itself had to be fixed twice before these results could be believed, and that is recorded rather than smoothed over: it first tried to reach a clean slate by deleting rows, and `inventory.stock_level_not_deletable: a stock key, once created, is retained with its history` refused it — **silently**, because the setup helper did not check return codes, which invalidated races B and C by leaving them running against an unprepared world. It is append-only now (a fresh product per race) and **exits non-zero on any failed setup statement**. The next error it caught was a non-hex UUID in its own fixtures, which is how the fix is known to work. **A race harness whose setup can fail quietly produces green that means nothing** — the same lesson, in a new place, as the Phase 5 clean-check that was narrower than its mutations.

---

## 4. Honest limits of this proof

- **No npm suite ran.** Node here is 22.22.0; the repository requires `>=24 <25`. Nothing about `format`, `lint`, `typecheck` or any Vitest suite is claimed, measured or implied. Those are `UNMEASURED`.
- **This is not CI.** No GitHub run exists for any of it, and a local green is never reported as CI.
- **No performance claim.** None measured; the authoritative box is not this container.
- **Pack A only.** Lot, serial and repair are untouched by this run and stay `SPEC ONLY`. Their laws are unchanged and unproved.
- **Concurrency: three races for apparel, and no more than that.** This document previously said apparel had *no concurrency case to prove* because it adds no deferred conservation trigger and no lock order. **V2 refused that reasoning — "no locks, therefore no concurrency" is not a proof — and it was wrong twice over** (defects 7 and 8). What is proved now is exactly the three interleavings of §3a on this cluster at this isolation level (`read committed`); no claim is made about any other interleaving, about deadlock, or about `SERIALIZABLE`. The overlay packs' concurrency estate (`C-SER-04`, `C-LOT-02`, the deadlock test in both orders) is still **unproved** and belongs to lot and serial.
- **No API, no UI, no localization, no browser, no gate yet.** §18's order puts them after the DDL proof, and this is the DDL proof. The gate script, `scripts/phase11-s<N>-gate.ts`, does not exist.
- **No challenger.** An author does not sign their own work. Everything above was written and run by the same hand, which is why its status is `PREPARED` and not `CHALLENGED`.
- **The scratch cluster lived at `/var/tmp/p11s`**, not in the session scratchpad, for one mechanical reason worth recording so the next run does not rediscover it: a PostgreSQL unix socket path cannot exceed 107 bytes, and the scratchpad path is longer than that. The cluster is throw-away and holds no project data.

---

## 5. What this changes in the other documents

- `P11-MIGRATION-PATCH-REQUEST.md` §2 is superseded for Pack A by `prep/phase11/ddl/p11-pack-a-apparel.sql`, which is the applied text. §2.1's `translations JSONB`, §2.4's trigger name and `catalog.variant_matrix_base_conflict`, and §2.5's entry routine are **withdrawn** for the reasons above.
- `P11-AL-14` is read **per family**: the inventory/Phase-4 relations take `tenant_id` and the composite FK; catalog relations take the catalog's `EXISTS` form.
- `P11-AL-26` (build order, apparel first, scratch proof before TypeScript) is what produced this document, and `P11-AL-25`'s mutation-target law held: **nothing in the frozen tree was written, and step 7 proves it rather than assuming it.**
- `P11-MIGRATION-PATCH-REQUEST.md` §2.4 is superseded again by defects 7 and 8: the variant validator reads its axis row `FOR KEY SHARE`, the stock-conditional lock guard is replaced by **unconditional immutability**, and a new `BEFORE DELETE` guard on the axis table (`catalog.matrix_axis_in_use`) refuses removing an axis that existing variants name.
- `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md`: **apparel now carries concurrency cases.** `C-APP-01` (matrix closure) gains race B, and `C-APP-02` (one combination per product) gains race A; the immutability law is unconditional and gains race C.
- The sentence *"apparel has no concurrency to prove"* is **withdrawn** wherever it appears, and is kept here only as the record of a refuted claim.
