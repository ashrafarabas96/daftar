# P11 — PACK A (APPAREL): THE EXECUTED SCRATCH PROOF, AND THE SIXTEEN DEFECTS IT FOUND

**What this is.** The Master Continuous Mission's §18 says, for Phase 11: *execute unnumbered DDL for a scratch proof, then the Owner's allocation at promotion*, and *do not drop any required part of the scope because it is currently design only*. §18 also fixes the build order — start with the cheapest independent end-to-end path, **apparel**. This document is the result of doing that, and the point of it is the part a design document cannot produce: **eight defects, six of them in this preparation's own specification or its own proof, found by execution and none of them findable by reading.** Two of the eight were found only after V2 of the Master Continuous Mission refused the sentence this document used to carry — *"no concurrency case here; apparel has none to prove"* — on the ground that **"no locks, therefore no concurrency" is not a proof**. Running the races it asked for found two real holes in Pack A.

**Status.** `PREPARED / NOT PROMOTED`, and now **`CHALLENGED` and REJECTED once**. An independent challenger read Pack A at `1a8ba15`, reproduced every claim three times from zero, and **rejected it** on five defects that single SQL statements expose (§7). Those five are fixed and red-proved here; the pack returns to the challenger unsigned. **An author does not sign their own work**, so nothing in this document is a signature. Nothing is promoted, **no migration number exists**, and the Migration Owner allocates at promotion from the live prefix.

**Evidence class.** What follows is `PROVEN BY TEST` and `PROVEN BY DATABASE CATALOGUE` on a scratch cluster in **this** container, and nothing more. It is **not CI**, it is **not release evidence**, and it carries **no timing or performance claim**. The container runs **Node 22.22.0 while the repository requires `>=24 <25`**, so no npm workspace suite was run at all and none is claimed; the proof uses PostgreSQL and `psql` only, which is why it was possible here.

---

## 1. What was executed, exactly

One script, `prep/phase11/harness/rebuild_and_prove.sh`, which does every step from zero on every run. Reported in the form it ran in:

| step | what | result |
|---|---|---|
| 0 | the cluster itself: `localedef -i en_US -f UTF-8 en_US.UTF-8`, then `initdb --locale=en_US.utf8 --encoding=UTF8` — **the script does this itself when the cluster is absent**, because `en_US.utf8` does not exist in this container until it is generated | created |
| 1 | `DROP DATABASE IF EXISTS daftar` / `CREATE DATABASE daftar` on that throw-away PostgreSQL **16.15** cluster, then **`datcollate` / `datctype` read off the database under test and compared with the settled target; the script exits `3` rather than produce an off-target green** | ok, `en_US.utf8 / en_US.utf8 / UTF8` |
| 2 | `infrastructure/database/bootstrap.sql`, rendered with scratch passwords, as the deployment administrator — six runtime roles, `btree_gist`, `citext`, `pgcrypto` | ok |
| 3 | migrations `0000` → `0086`, **87 files**, each in its own transaction with the ownership-handover bracket, **as `daftar_migrator` and not as a superuser** | **87/87 applied** |
| 4 | `prep/phase11/ddl/p11-pack-a-apparel.sql` — **unnumbered** — as `daftar_migrator` | applied; **end-state assertion passed** |
| 5 | a world of two tenants, two businesses, two products, two axes, five axis values (one archived), one two-axis matrix | built |
| 6 | the proof suite, `prep/phase11/harness/proofs.py` | **41 cases, 0 failed** (21 before the challenge round, 20 added by it) |
| 6b | **seven real-concurrency races**, `prep/phase11/harness/races.py` — two live backends, sentinel-awaited interleaving, **no `sleep()`** | **7 races, 0 findings** (after the fixes of §2, §3a and §7) |
| 7 | the frozen tree re-verified **after** the run | 0 tracked changes under `infrastructure/database`; `frozenThrough = 0079_phase4_pos_till_sessions_cart.sql`; **80 frozen entries, 0 digest mismatches** |

**Run repeatedly from zero, green each time.** Two raw logs are kept:

- `prep/phase11/harness/RUN-EVIDENCE-2026-10-12.txt` — the first green run, before the concurrency work.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-d813de2.txt` — the first clean-tree run, kept because evidence is preserved rather than replaced.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-99dbbe7.txt` — the three-race run with **exit codes printed in the log itself**, which V3 §9 requires of every handoff.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-e27acaf.txt` — the authoritative log of the **pre-challenge** round: four races, both arrival orders of the axis race, exit codes all `0`. Kept, and **its collation is not stated because the cluster was at `C`** — see §7.3, defect 15.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-2da2000.txt` — **the authoritative log of the challenge round, and the current one**: 41 cases, 7 races, `EXIT_PROOFS_A`/`EXIT_RACES`/`EXIT_SCRIPT` all `0`, on `datcollate = datctype = en_US.utf8`, `SOURCE_TREE_DIRTY : no`.

**Run identity of the authoritative log**, printed by the script itself as its first lines, because V2 §18 says not to bind the proof to the remote head by guesswork:

| field | value |
|---|---|
| `RUN_ID` | **`p11-20261012T145825Z-6848`** — the real identifier printed by the run, not a pattern. (Finding P3-10: this table used to carry `p11-packA-20261012T125*Z` with a wildcard, which matched no run.) |
| `RUN_AT_UTC_START` / `RUN_AT_UTC_END` | `2026-10-12T14:58:25Z` / `2026-10-12T14:59:44Z` |
| `SOURCE_REPO` | `https://github.com/ashrafarabas96/daftar` |
| `SOURCE_BRANCH` | `claude/phase11-prep-re0epv` |
| `SOURCE_SHA` | **`2da200009e119e36ebde2eabdab9a14299f0a1a1`** — the challenge round. Earlier logs name `e27acaf…`, `99dbbe7…` and `d813de2…`, across which the Pack A DDL was byte-identical (`PACK_A_DDL_SHA256 7561f8f8…d3a8`); **at this SHA the DDL itself changed** and its digest is below, so no claim from an earlier log carries forward to it. |
| `SOURCE_TREE_DIRTY` | **`no`** — nothing uncommitted; the SHA is the whole input |
| `MIGRATIONS_SHA` (tree of `infrastructure/database/migrations`) | `b128c7033a3381bd2237d0a1405f0676ac509960` |
| `MANIFEST_SHA256` | `4b4dd6e9e1359eba6536a0c70c0f3cf056e62b47bfed833026541df5ffbe6804` |
| `PACK_A_DDL_SHA256` | **`9ff638d426ec396947dfd0d89d759d0510faf8bb5e9da62921eb97a419304052`** (was `7561f8f8…d3a8` through `1a8ba15`, which is the digest the challenge reviewed) |
| `BOOTSTRAP_SHA256` | `19df5cca37a6a887ede923e6f108163e579ac42f68cb0c8b48730eb2f2a3c507` |
| `HARNESS_SHA256` | `6cc552919e1e25029b2bc7d75a5dcd416abdb17850b9796fc2177e8a55900c79` — the seven harness files hashed together, so the whole executable input is named by one digest |
| `PACK_B_DDL_SHA256` | **absent at this SHA**: Pack B is not on the branch, and the script prints that rather than hashing a file it did not run |
| `DB_COLLATION` | **`en_US.utf8 / en_US.utf8 / UTF8`**, read off the database under test. The settled target (V3 §15/§26). Earlier runs of this proof were at `C` and did not say so |
| `PG_VERSION` | PostgreSQL **16.15** — the settled deploy family (`TL-P4-S3-R4`), now with the collation half measured too. It is still a scratch cluster in this container, not the deployment. |
| `PG_CLUSTER_DIR` | `/var/tmp/p11u/data`, port `55512` — created by the script itself, named in the log, and reachable by any re-runner through `P11_SOCK` / `P11_PORT` |
| `NODE_VERSION` | v22.22.0, against repository `engines.node >=24 <25` — **no npm suite was run** |
| `EXIT_PROOFS_A` / `EXIT_RACES` / `EXIT_SCRIPT` | **`0` / `0` / `0`** — read from the process statuses, not from the prose above them. `EXIT_PROOFS_B` reads `n/a (Pack B is not on the branch at this SHA)`, which is the honest value: there was nothing to run |

**The commands, verbatim, and they need nothing that is not in the repository:**

```
git checkout 2da2000
bash prep/phase11/harness/rebuild_and_prove.sh        # creates its own en_US.utf8 cluster if absent
# optional, to use a different scratch cluster:
P11_SCRATCH=/var/tmp/mine P11_PORT=55599 bash prep/phase11/harness/rebuild_and_prove.sh
```

A reader can therefore check out that exact SHA, hash those files, and get the same digests, or know at once that they are reading a different subject. The dirty-tree flag is part of the record on purpose: an earlier trial run printed `SOURCE_TREE_DIRTY : YES`, and that run is not reported here because its input had no name.

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

**Both arrival orders of the axis race are run**, and that is owed to a lead from the Phase 4 thread (`TL-P4-COORD-R62`, measured there on PG18.4): **a `BEFORE ROW DELETE` trigger cannot take a lock before the row being deleted**, because the executor produces `OLD` through `GetTupleForTrigger`, **which locks that tuple before the trigger body is called**. Phase 4 built an arm on that premise, measured it, and the `40P01` was unchanged; the arm was removed rather than left carrying a rationale it did not serve. Two consequences here, both now stated rather than assumed:

- **`product_matrix_axes_10_axis_in_use` is a refusal guard and never a lock-order device.** No Phase 11 document promises a DELETE-path lock order inside a trigger. The ordering in race B comes from the **insert** side's `FOR KEY SHARE` meeting that executor lock — caller-side, which is where R62 says the obligation lives.
- **Race B had only run DELETE-first, and that is half a proof.** The reverse order is the one where the trigger body matters at all, and R62's mechanism is exactly why it works: the deleter blocks on the key-share lock, and by the time the guard's body runs the variant is committed and visible. Measured on PG16.15 as race B2 — T2 blocked, refused `catalog.matrix_axis_in_use`, and the committed state keeps both the axis and its variant.

| race | T1 | T2 | observed | verdict |
|---|---|---|---|---|
| **A** duplicate combination | `INSERT {size:s,color:red}`, then `COMMIT` | the same combination, concurrently | T2 **blocked** while T1 held the speculative insert; rows after both: **1**; T2 refused on `product_variants_matrix_uq` | PASS — exactly one commits, and the loser **blocks** rather than racing |
| **B** axis removed vs variant inserted | `DELETE` the `color` axis, then `COMMIT` | `INSERT` a variant naming `color`, concurrently | T2 **blocked**; T2 refused `catalog.variant_axis_unregistered`; variants naming an unregistered axis after both commit: **0** | PASS — closure holds after both commit (**defect 7's fix**) |
| **B2** the same race in the **reverse arrival order** | `INSERT` a variant naming `color`, then `COMMIT` | `DELETE` the `color` axis, concurrently | T2 **blocked**; T2 refused `catalog.matrix_axis_in_use`; axis rows after both: **1**, variants naming it: **1** | PASS — the deleter waits on the inserter's key-share lock, and the guard then **sees** the committed variant |
| **C** attributes changed vs first stock movement | `UPDATE attributes` while no stock exists, then `COMMIT` | `INSERT` the variant's **first** `stock_levels` row, concurrently | T1 refused `catalog.variant_matrix_immutable`; T2 **not** blocked and committed; final combination unchanged, stock rows: **1** | PASS — the interleaving cannot produce a changed-combination-with-stock row (**defect 8's fix**) |

Race A's value is not that a unique index works; it is **that the second session blocks instead of both proceeding to a check** — a uniqueness guard implemented as a `SELECT` then an `INSERT` would have passed every serial test and failed this one.

**Race B2's first run reported a finding that was its own**, and it is recorded because it is the same lesson a third time. T1's variant named `color=green`, which `product_attribute_values` does not register, so T1 was refused `catalog.variant_axis_value_unregistered`, **never took the key-share lock**, and T2's delete sailed through — printed as *"the closure invariant depends on arrival order"*. The product was never at fault. What caught it is worth keeping: **the assertion reads the committed state** (axis rows, and variants naming the axis) **rather than an error string**, so a race that did not happen could not pass. The value is registered now, and T1's arm — which is this race's setup — aborts the harness loudly if it is ever refused, the law the setup helper already followed.

The harness itself had to be fixed twice before the first three results could be believed, and that is recorded rather than smoothed over: it first tried to reach a clean slate by deleting rows, and `inventory.stock_level_not_deletable: a stock key, once created, is retained with its history` refused it — **silently**, because the setup helper did not check return codes, which invalidated races B and C by leaving them running against an unprepared world. It is append-only now (a fresh product per race) and **exits non-zero on any failed setup statement**. The next error it caught was a non-hex UUID in its own fixtures, which is how the fix is known to work. **A race harness whose setup can fail quietly produces green that means nothing** — the same lesson, in a new place, as the Phase 5 clean-check that was narrower than its mutations.

---

## 4. Honest limits of this proof

- **No npm suite ran.** Node here is 22.22.0; the repository requires `>=24 <25`. Nothing about `format`, `lint`, `typecheck` or any Vitest suite is claimed, measured or implied. Those are `UNMEASURED`.
- **This is not CI.** No GitHub run exists for any of it, and a local green is never reported as CI.
- **No performance claim.** None measured; the authoritative box is not this container.
- **Pack A only.** Lot, serial and repair are untouched by this run and stay `SPEC ONLY`. Their laws are unchanged and unproved.
- **Concurrency: four races for apparel, and no more than that.** This document previously said apparel had *no concurrency case to prove* because it adds no deferred conservation trigger and no lock order. **V2 refused that reasoning — "no locks, therefore no concurrency" is not a proof — and it was wrong twice over** (defects 7 and 8). What is proved now is exactly the four interleavings of §3a on this cluster at this isolation level (`read committed`) — the axis race in **both** arrival orders; no claim is made about any other interleaving, about deadlock, or about `SERIALIZABLE`. The overlay packs' concurrency estate (`C-SER-04`, `C-LOT-02`, the deadlock test in both orders) is still **unproved** and belongs to lot and serial.
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

---

## 6. A conflict with V3 §7, recorded rather than absorbed

V3 adds a rule about how the migration history is applied, and **it contradicts this repository's live code.** It is recorded here, with citations, because the correct response to a directive that disagrees with the tree is a fact correction, not a silent edit to the evidence — and because this is not Phase 11's question to settle: it belongs to the Migration Owner and to Phase 15's deployment line.

**What V3 §7 says** (and repeats in its Phase 11 and Phase 15 sections): *the approved historical install exception is that `0000–0039` are applied under the **administrator** role and `0040+` under the **migrator** role; do not extend the exception to new migrations, and **do not describe running all 87 migrations as the migrator alone as the project's real path.***

**What the live code says.** `scripts/phase2-deployment-authority.ts` is the project's own deployment-authority proof, run by `npm run check:deployment-authority`:

- `const DEPLOYER = 'daftar_migrator';` (`scripts/phase2-deployment-authority.ts:124`)
- **Case A** — *"empty database → bootstrap → every migration on disk"* — asserts *"the deployment principal applied every migration"*, `applied.length === expected`, reported as *"N of N applied as `daftar_migrator`"* (`:860-865`).
- **Case B** — a database at the Phase 1 boundary — applies `0000–0039` and asserts **"4.1 Phase 1 applies as the deployment principal"** (`:868-879`).
- And the earlier contrary reading is explicitly **withdrawn** in the rollback rehearsal: *"The earlier reading recorded here — that the accepted history cannot be applied by `daftar_migrator` — is **WITHDRAWN**: `check:deployment-authority` applies 0000-0052 as `daftar_migrator` from an empty database, and carries 0039 and 0050 forward the same way (RB-P2-01, closed in P2-S9)"* (`scripts/phase2-rollback-rehearsal.ts:462`).

**Where the two can be reconciled, and where they cannot.** `0039` is real, but it is the **Phase 1 freeze boundary and the rollback checkpoint**, not a role boundary. The same rehearsal line names the one case where the administrator does own the objects: **a copy restored by the administrator with `--no-owner`**, where the refusal is that restored ownership and not the migration history. So the administrator appears on the **restore/recovery** path, not on the fresh-install path — and V3's §7 reads like that restore observation generalized into the install contract.

The handover privilege is the mechanism that makes the migrator-only path work, and it is in the runner rather than in the old files: `0032`, `0033` and `0038` do not grant themselves `CREATE ON SCHEMA public`, *"because nothing ever applied them as a non-superuser"*, so `apps/api/src/infra/migrate.ts` issues the grant and the revoke **from outside the file, inside the migration's own transaction** (`apps/api/src/infra/migrate.ts:28-37`). The runner takes **one** connection and applies every file through it; there is no role switch at `0040` anywhere in it.

**What this means for this proof, stated exactly.** `prep/phase11/harness/run_migrations.py` reproduces that runner contract — per-file transaction, the ownership-handover bracket around each file, checksum history — and applied **`0000`–`0086`, 87/87, as `daftar_migrator`** on a fresh database. That measurement stands, and it is the same configuration `check:deployment-authority` Case A asserts. What this document does **not** claim is that it rehearsed an administrator-then-migrator split, because it did not, and it does not claim to settle which contract is correct.

**Confirmed independently, 2026-10-12.** The Phase 4 thread reached the same reading from its own measurements, and the coordinator ruled it as **`TL-P4-COORD-R61`: the deployment path is `daftar_migrator` over all migrations** — which is this proof's configuration. So the citations above are no longer one thread's lead. What remains with the owner is only whether V3 §7 was *meant* as a new contract rather than a description of the existing one, and Phase 4 has put that question to him in its own thread. **Nothing in Phase 11 waits on the answer**, and nothing in this document was changed to match §7.

**Owed to the Migration Owner and the coordinator** — a one-line question, not a Phase 11 decision: **is V3 §7's admin/migrator split the install contract, or is `check:deployment-authority` Case A?** They cannot both be the real path. If §7 is right, `check:deployment-authority`, `phase2-rollback-rehearsal`'s withdrawal of RB-P2-01, and the runner's own header comment are all describing something that is not the deployment, and every phase that cited them is affected — which is why this is raised rather than answered here.

---

## 7. The independent challenge at `1a8ba15`, and what it found

The challenger's report is `/mnt/project-files/phase11/P11-CHALLENGE-1a8ba15.md`, with its
probes and raw logs in `phase11/challenge-1a8ba15/`. **Verdict: `REJECT`.** It is a
good rejection and this section records it in its own terms before answering it.

**What it reproduced.** Everything this document claimed: `bootstrap.sql` as the
administrator, **87/87** migrations as `daftar_migrator`, the unnumbered pack with its
end-state assertion, **21 cases and 4 races green, three times from zero**, the frozen
prefix untouched after the run, and the proof-SHA tie (`d813de2`, `99dbbe7`,
`e27acaf`, `1a8ba15` carry byte-identical executable inputs). It found **no overclaim
of evidence class**. The rejection is not about any of that.

**What it rejected.** The 21 cases test every clause of `C-APP-01` **in the insert
direction only**, and three of those clauses fall to one UPDATE or DELETE statement
with no concurrency at all. A suite can be green, three times from zero, against a law
it never reaches.

### 7.1 The five defects, and the fix for each

| # | finding | what was measured at `1a8ba15` | fix in this round | red proof |
|---|---|---|---|---|
| **9** | **P0-01** the immutability law was bypassed by the one value the trigger returned early on | `UPDATE … SET attributes='{}'` committed on a variant holding `on_hand 5.0000`; the partial unique index excludes a blanked row, so a **second** variant for the same cell was then accepted — **one matrix cell with two stock identities** | the immutability check moved **above** the early return and stated over the TRANSITION: a non-base variant's attributes never change, to anything, `'{}'` included | `P0-01 the combination cannot be BLANKED either`, plus the cell's identity count |
| **10** | **P0-02** the value registry had no guard on any removal path | `DELETE FROM product_attribute_values … 'blue'` committed, leaving **2** variants naming a value code that no longer existed | new `product_attribute_values_10_value_in_use`, `BEFORE DELETE OR UPDATE OF business_id, axis_code, value_code, status` | three cases: deleted, archived, repointed |
| **11** | **P1-03** the `FOR KEY SHARE` lock the concurrency law credited was **inert** against the archive path | `UPDATE … SET status='archived'` committed with 2 variants naming it; concurrently, T2 **did not block** on the key-share lock | the registry reads take **`FOR SHARE`**, which conflicts with every write to the row while two validators still share it | race **D**, and the serial archive case |
| **12** | **P1-04** the axis in-use guard was `BEFORE DELETE` only, so an UPDATE achieved the removal it refuses | `UPDATE product_matrix_axes SET axis_code='material'` committed; the matrix registered `[size, material]` with **1** variant naming an unregistered axis | the trigger is `BEFORE DELETE OR UPDATE OF axis_code`, reading `OLD`; the same guard added to the axis REGISTRY for rename and archive | two cases, plus the matrix's axis list |
| **13** | **P2-06** an archived AXIS still accepted new matrix cells: `status` was a lifecycle on one registry and decoration on the other | with `product_attribute_axes.status='archived'`, a matrix accepted the axis and a variant committed | the validator reads the axis registry's status too, and `product_matrix_axes_20_axis_active` refuses an archived axis at the matrix write | two cases, the second ordered so the matrix guard does not hide the validator's own read |

### 7.2 One recommended fix REJECTED, with the measurement that rejects it

Finding **P2-07** is right about the mechanism: the in-use guards *allow* when they see
no variant, and under `SECURITY INVOKER` that read is filtered by the deleting
principal's row-level security — a zero read used as proof of absence. Its recommended
fix was `SECURITY DEFINER` owned by `daftar_catalog_internal`, with the column-scoped
grant and role-scoped policy that `0070` already uses.

**It was implemented and measured, and it created the bypass it was meant to prevent.**
`product_variants` carries a RESTRICTIVE `business_isolation` policy
(`app_bypass() OR business_id = app_business()`) for all commands. Restrictive policies
AND with everything, so a definer's own `USING (true)` cannot satisfy it:

```
SET ROLE daftar_catalog_internal;                       -- no session context
SELECT count(*) FROM product_variants;              ->  0
SET app.tenant_id=…; SET app.business_id=…;             -- same role, with context
SELECT count(*) FROM product_variants;              ->  3
```

With the definer in place, **five removal cases that had been refusals reported "no
error"** — including the axis-delete case that was green before the change. Under
`SECURITY INVOKER` the three principals that can reach these rows all behave correctly,
because FORCE row-level security makes visibility of the registry row and visibility of
the variants the **same scope**: a bypassrls principal sees both; `daftar_app` with its
own context sees its business's variants (**measured as `daftar_app`**, which the
challenge rightly noted no case did); a principal with no context cannot see or delete
the registry row at all. The definer variant breaks the first of those three.

So the guards stay `SECURITY INVOKER`, the briefly-added grant and policy on
`product_variants` are **gone** (this pack changes no privilege outside its own five
relations), and the end-state assertion now **refuses a definer variant by name** so the
fix cannot be re-applied without the assertion stopping it. The finding's real content —
a FUTURE policy narrowing `product_variants` would convert each refusal into a silent
allow — is answered by a tripwire instead: the assertion **pins the policy set** on
`product_variants` to exactly `{business_isolation, tenant_membership}`, so the pack
refuses to install over a set it did not reason about. That cannot catch a policy added
*after* this pack, which is why `P11-MIGRATION-PATCH-REQUEST.md` §12.2 (`PR-SEC-P11-01`) asks the Security
Authority for the same pin in the standing RLS invariant check. Stated as a limit, not as
cover.

### 7.3 Three defects of the EVIDENCE, two of them this harness's own

| # | defect | answer |
|---|---|---|
| **14** | **this harness exited `0` over a failing race.** `races.py` ended in `sys.exit(0)` unconditionally, so a race that printed `**FINDING**` in its own matrix still returned success and `EXIT_RACES` would have read `0`. No race had failed, so nothing exposed it — the exact class of defect V3 §9 asks for exit codes to prevent, **in the harness that prints them**. Found by re-reading my own harness for this round, not by the challenge. | `sys.exit(1 if findings else 0)` |
| **15** | **P2-08, and worse than reported: every earlier run of mine was at `datcollate = C`, not the settled `en_US.utf8`.** The challenger supplied the on-target measurement from their own cluster and all 21 cases were green there; mine was off-target and the log did not say so, because it printed `PG_VERSION` and nothing about locale. Every code validator in this pack is a bracket-range regex, and bracket ranges are the collation-sensitive part of POSIX regular expressions. | a new cluster at `en_US.utf8`, created **by the script**; the collation is read **off the database under test** and printed in the identity block; **a cluster off the settled target makes the script exit `3` instead of producing a green** |
| **16** | **P2-09, the harness could not be re-run from the repository it lives in.** It read `$S/sql/bootstrap.rendered.sql`, `$S/apply_a.sql` and staged copies of itself — none in the repository, none described. The challenger had to reconstruct the locale, the port, the password rendering and whether the pack is applied in one transaction. "A proof whose setup is not in its own repository is reproducible by its author only." | every one of those steps is **in the script**: `localedef` + `initdb`, the password rendering inline, one transaction per pack via a named `apply_pack` function, the cluster named by `P11_SOCK` / `P11_PORT` so every script agrees on which cluster ran, and a pack that is **not on the branch is skipped BY NAME** rather than silently |

**P3-10's three label mismatches** are also fixed: the race-count literal is now computed
from the matrix it prints, the run identity is printed with its real `RUN_ID` and both a
start and an end timestamp, and the two absence laws are no longer name-shaped — the
no-money law asserts on the column's **type** against an allow-list of exactly the pack's
two ordering columns, and the no-inventory-registration law compares the three inventory
registries' **row counts** against a baseline taken before the pack's first statement.
That baseline is held in session settings and not in a temporary table, because
`daftar_migrator` has no TEMP privilege and **an absence law is not worth widening the
migration principal's rights for**.

### 7.4 What the challenge did NOT sign, and still does not

Packs B, C and D (lot/expiry, serial, repair, warranty): **no subject existed on the
branch**, so `C-SER-*`, `C-LOT-*`, `C-FEFO-01` and `C-REP-*` remain `SPEC ONLY` and
nobody has signed them. Pack B (lot/expiry) is being built in its own round and **is not
on the branch at this SHA**; the harness names it as skipped rather than running a
different set of packs than the SHA carries. No CI claim, no npm or TypeScript suite
(this container is Node 22.22.0 against `engines >=24 <25`), no timing claim, no
`SERIALIZABLE` or deadlock property.

**`READY_TO_PROMOTE` = NO.** Five defects were fixed and red-proved in this round; the
pack goes back to the independent challenger, and the author does not sign it.

---

## 8. Pack B (lot / expiry), executed: eight more defects, two of them about authority

Pack B is the lot/expiry overlay of `TL-P11-R1`'s Option B: lot and serial extend the
**traceability** identity and never the costing key, so **no overlay relation carries a
monetary column** and the costing key stays `(business_id, warehouse_id, variant_id)`.
It was applied unnumbered as `daftar_migrator` and proved the same way Pack A was.

**Result: 31 cases, 0 failed** — `EXIT_PROOFS_B 0`, in the clean-tree run at
**`c2289ce7974a17d1e3509caf077e4fd5e8c26c26`** (`RUN_ID p11-20261012T151906Z-10772`,
`2026-10-12T15:19:06Z` → `15:20:27Z`, `SOURCE_TREE_DIRTY : no`,
`DB_COLLATION en_US.utf8 / en_US.utf8 / UTF8`,
`PACK_B_DDL_SHA256 27bca629dc4d0ed238204e0e0cc11828db53808868dbae5c0854118410c5f60a`,
`HARNESS_SHA256 07ce536a632569a7c9f74754d5362387c26192f088e034c9980205d46fc5e4aa`), raw log
`prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-c2289ce.txt`. That same run carries Pack
A's 41 cases and 7 races, all green, with `EXIT_SCRIPT 0`: **the two packs are proved
together on one cluster**, so neither is claimed from a run the other was absent from. Applied in one transaction with its
own end-state assertion (12 checks). The writer change of
`P11-MIGRATION-PATCH-REQUEST.md` §3.6 is **not** in this round, so `C-LOT-01`'s
integration with `inventory_apply_stock_movements` stays
`WAITING_FOR_INTEGRATED_SURFACE`; what is proved here is the overlay's structure and its
deferred conservation triggers.

### 8.1 The defects execution found

| # | defect | what it was |
|---|---|---|
| **17** | trigger position `_30_` on `products` was already taken by `products_30_archive_requires_zero_stock`, so the lot history lock had to be `_40_`. **Name order decides firing order for the same event** — the same defect Pack A hit at `product_variants._30_` |
| **18** | `track_lot` had **no configuration authority at all**: `daftar_app` could switch lot tracking on. Closed by `products_05_lot_config_authority`, which fires FIRST in name order and raises the same `inventory.configuration_authority_required` the existing inventory-configuration guard does |
| **19** | **the frozen configuration command cannot carry the new column.** `inventory_configure_product`'s authority digest pins its four arguments in a fixed field order, so `track_lot` cannot be passed through it. A **new registered op code is owed to the inventory authority**; the proof uses a fixture definer meanwhile and says so |
| **20** | `daftar_inventory_internal` held no UPDATE on the new `products` columns, so even the authority could not write them. A **column-level grant** is owed |
| **21** | `stock_lots_code_canonical_ck` calls `catalog_identifier_norm`, and **a CHECK expression is evaluated with the WRITING principal's privileges** — so every writer needs EXECUTE on it. An **EXECUTE grant** is owed |
| **22** | **the overlay's read policy was PERMISSIVE and applied to PUBLIC**, which ORs with `tenant_membership` and silently switched tenant isolation OFF for SELECT: a wrong-tenant read returned **2** rows instead of 0. Closed by `FOR SELECT TO daftar_inventory_internal`, and by an end-state assertion that forbids a blanket permissive policy on PUBLIC. **No positive test could have found this** — only a wrong-tenant negative case did |
| **23** | **a hand-written movement is a forgery, and the database said so.** The first version of these cases wrote `stock_source_bindings` and `stock_movements` directly as the internal principal; eight cases failed on `inventory.stock_source_line_missing`, because an adjustment binding requires a row in `stock_source_bridge_inventory_adjustment` whose **one writer** (`inventory_bridge_source_lines`, 0062) refuses unless this transaction's entry routine consumed an assertion for an operation that owns that source type. The fixture now calls **`inventory_adjust_stock`, the official command**, minting the assertion it demands and calling it as `daftar_app` — so every overlay case is an overlay over a movement written by the **real writer**, with its real binding and its real bridge row. That is also what PART 7.8 requires: consume the official services, create no second inventory |
| **24** | **a valued document owes an accounting binding, and that is not this phase's to write.** With a non-zero unit cost the five conservation cases failed at COMMIT on `inventory_adjustments_binding_fk`: `inventory_adjustments_binding_owed_ck` makes a non-zero total owe a row in `accounting_source_bindings`, which only the **accounting authority** may write. A fixture that wrote one would be answering an accounting question, which this phase may state and may not answer. The cases therefore use a **zero-value receipt**, which owes no binding — and which is the right fixture regardless, because the lot overlay is **value-neutral by law** (`C-LOT-04`), so no case here needs money to exist |

Defects 17–22 are in Pack B's own DDL or its spec; **23 and 24 are not defects of the
pack at all** — they are the authorities refusing a fixture that had taken a shortcut,
and they are recorded here because the shortcut would have produced green cases over a
movement no production path can create.

### 8.2 What Pack B proves, in which words

`PROVEN BY TEST` on the scratch cluster, 31 cases: the lot code is the catalogue's
canonical form and not a second normalization; one lot code per variant; expiry cannot
precede production; the status set is closed (a quarantine is a status, not a value
change); an overlay row cannot name a lot of another variant or a movement of another
stock key; a zero allocation is refused; the allocation **sums to the movement** at
COMMIT, and `SET CONSTRAINTS ALL IMMEDIATE` does not switch that off; a lot-tracked
movement with no allocation is refused; a sign that disagrees with the movement is
refused; the overlay is append-only **even for the principal that owns the table**; the
per-lot cache cannot disagree with the stock key's on-hand and cannot go negative; the
fold reads the movements rather than the cache and refuses a key outside the
transaction's business; lot tracking is inventory configuration and `daftar_app` cannot
set it, at insert or update, and it cannot change once the product has stock history;
the expiry policy admits exactly one value in this phase (`TL-P11-R4`); tenant and
business isolation hold from the application role, including the wrong-tenant case; and
**no monetary column exists on any overlay relation**, asserted from the catalogue
rather than from the text, with `stock_levels` still carrying no column below the
variant.

`SPEC ONLY` and unsigned: the writer change (§3.6), FEFO picking (`C-FEFO-01`), serial
(`C-SER-*`) and repair (`C-REP-*`). **No challenger has read Pack B.**
