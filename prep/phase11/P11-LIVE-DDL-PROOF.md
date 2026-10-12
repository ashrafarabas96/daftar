# P11 — PACK A (APPAREL): THE EXECUTED SCRATCH PROOF, AND THE TWENTY-SEVEN DEFECTS IT FOUND

**What this is.** The Master Continuous Mission's §18 says, for Phase 11: *execute unnumbered DDL for a scratch proof, then the Owner's allocation at promotion*, and *do not drop any required part of the scope because it is currently design only*. §18 also fixes the build order — start with the cheapest independent end-to-end path, **apparel**. This document is the result of doing that, and the point of it is the part a design document cannot produce: **eight defects, six of them in this preparation's own specification or its own proof, found by execution and none of them findable by reading.** Two of the eight were found only after V2 of the Master Continuous Mission refused the sentence this document used to carry — *"no concurrency case here; apparel has none to prove"* — on the ground that **"no locks, therefore no concurrency" is not a proof**. Running the races it asked for found two real holes in Pack A.

**Status.** `PREPARED / NOT PROMOTED`, and **`CHALLENGED` twice**. An independent challenger read Pack A at `1a8ba15`, reproduced every claim three times from zero, and **rejected it** on five defects that single SQL statements expose (§7). Those five were fixed and red-proved, and the **second round at `23a7139` returned `PASS-WITH-SCOPE`**: all five closed and each covered by a case that fails when its guard is dropped, the off-target refusal measured at exit `3`, and the challenger's own `SECURITY DEFINER` recommendation **withdrawn on measurement**. It also found **three new defects**, one of them the ADD direction of the very clause round 1's fixes were built for. Those three are answered in **§9**, and the pack returns to the challenger unsigned for a third round. **An author does not sign their own work**, so nothing in this document is a signature. Nothing is promoted, **no migration number exists**, and the Migration Owner allocates at promotion from the live prefix.

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
| 6 | the proof suite, `prep/phase11/harness/proofs.py` | **46 cases, 0 failed** (21 before the first challenge, 20 added by it, 5 by the second — §9) |
| 6a2 | the Pack B suite, `prep/phase11/harness/proofs_b.py` | **31 cases, 0 failed** (§8) |
| 6c | **both suites again, on the same database** — idempotence, which the second challenge measured was absent | **46 and 31, 0 failed**; see §9.4 |
| 6b | **nine real-concurrency races**, `prep/phase11/harness/races.py` — two live backends, sentinel-awaited interleaving, **no `sleep()`** | **9 races, 0 findings** (G and H added by §9.1, both arrival orders) |
| 7 | the frozen tree re-verified **after** the run | 0 tracked changes under `infrastructure/database`; `frozenThrough = 0079_phase4_pos_till_sessions_cart.sql`; **80 frozen entries, 0 digest mismatches** |

**Run repeatedly from zero, green each time.** Two raw logs are kept:

- `prep/phase11/harness/RUN-EVIDENCE-2026-10-12.txt` — the first green run, before the concurrency work.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-d813de2.txt` — the first clean-tree run, kept because evidence is preserved rather than replaced.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-99dbbe7.txt` — the three-race run with **exit codes printed in the log itself**, which V3 §9 requires of every handoff.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-e27acaf.txt` — the authoritative log of the **pre-challenge** round: four races, both arrival orders of the axis race, exit codes all `0`. Kept, and **its collation is not stated because the cluster was at `C`** — see §7.3, defect 15.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-2da2000.txt` — the authoritative log of the first challenge round: 41 cases, 7 races, exit codes all `0`, on `datcollate = datctype = en_US.utf8`, `SOURCE_TREE_DIRTY : no`.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-c2289ce.txt` — the authoritative log of the Pack B round: both packs on one cluster, 41 + 31 cases, 7 races.
- `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-0db9450.txt` — **the authoritative log of the SECOND challenge round, and the current one**: 46 + 31 cases **each run twice on the same database**, 9 races, every exit code `0`, `SOURCE_SHA 0db94504abdc6b9142564e655c8032613214c06d`, `SOURCE_TREE_DIRTY : no`, `DB_COLLATION en_US.utf8 / en_US.utf8 / UTF8`.
- `prep/phase11/harness/RUN-EVIDENCE-MUTATIONS-0db9450.txt` — the **mutation** log of the three new mechanisms: each one removed, one at a time, and the cases that go red named with their counts (§9.5).

**The run identity table below is the FIRST challenge round's log and is kept as it was.** The current round's identity is §9.3.

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

---

## 9. The SECOND independent challenge: `PASS-WITH-SCOPE`, and the three defects it found (defects 25–27)

The report is `/mnt/project-files/phase11/P11-CHALLENGE-23a7139.md`, with its
scripts and logs in `phase11/challenge-23a7139/`. It is a better round than
the first in one specific way: it measured **coverage** rather than counting
cases — rebuild from zero, drop exactly one guard, run the author's own
suite, read the exit code — and every one of the five new guards was reached
by a case that fails when it is gone. It also **re-measured the author's own
rejection** of its `SECURITY DEFINER` recommendation, implemented the variant
with the clause the author's version lacked, found that `app_bypass()`'s live
definition at this head is `RETURN (CURRENT_USER = 'daftar_platform')` — a
role identity, not a session setting — and concluded that the recommendation
was *"not merely weaker than INVOKER, it is unimplementable without a
privilege escalation"*, and withdrew it. The comment above the first guard in
the pack now carries that mechanism, because the author's own version of the
reason named `BYPASSRLS`, which is a different mechanism reaching the same row.

**What it did not sign:** `C-APP-01`'s clause *"exactly its registered axis
set"*, defeated by one `INSERT`; the archive lifecycle of an axis a matrix
registers; anything in Packs B, C or D; any CI, npm or TypeScript claim; any
performance claim; `SERIALIZABLE` or deadlock behaviour. That scope stands,
and this round narrows only the first two items of it.

### 9.1 Defect 25 (`P1-N01`, the one that held the scope back) — the ADD direction

| | |
|---|---|
| the law | `C-APP-01`: a matrix product's non-base variant `attributes` name **exactly** its product's registered axis set |
| what was guarded | the VARIANT insert (round 0), and since round 1 every REMOVAL path on both registries |
| what was not | **adding an axis to a matrix that already has variants** |
| measured at `23a7139` | on a product holding one committed `{size:m,color:blue}`: `INSERT INTO product_matrix_axes … 'material',3` → **rc=0, not refused**; the matrix then registered `[size,color,material]`; committed variants not naming exactly the registered set: **1** |
| the cost | not a duplicate cell this time — a variant **nothing can address through the matrix**, since no 2-axis cell exists on a 3-axis product, while it keeps its own stock key and its whole movement history. Under Option B the variant **is** the costing key, so this is the same split identity `P0-01` produced |
| why it matters more than its class | it is the door a merchant walks through **on purpose**: *"add a material axis to this shirt"* |

**The fix.** `product_matrix_axes_30_set_frozen`, `BEFORE INSERT` on
`product_matrix_axes`, refusing `catalog.matrix_axis_set_frozen` when the
product already carries a non-base variant. A populated matrix's axis set is
now as immutable as a variant's combination, and for the same reason. The
merchant's path is the one the pack already chose for a mistyped combination:
archive the variants at zero stock, which
`product_variants_30_archive_requires_zero_stock` already permits, and
regenerate the grid.

**One widening of the challenger's own fix, stated because it is a decision
and not a detail.** The guard refuses on **any** non-base variant, including
one whose `attributes` are `'{}'`. That is a plain product's single variant;
it holds the product's stock; registering a first axis under it would leave
it exactly as unaddressable as the 2-axis row above. So converting a plain
product into a matrix product while it has a variant is refused too. A
product with **no** non-base variants may be given, re-ordered and taken off
axes freely, which is the whole lifecycle a merchant building a grid needs,
and there is a case for that direction so the guard cannot quietly become a
ban.

**The concurrency half, which the challenger did not ask for and the fix
needs.** Row locks cannot order a variant insert against an axis INSERT: the
validator can lock every matrix row that **exists** and the row the other
transaction is about to add is not among them, while the freeze guard's read
of `product_variants` cannot see an uncommitted variant. Mutual invisibility,
so neither side's lock serializes them — the same shape as the registry
races, one relation up. Both paths now take a **transaction advisory lock**
on `(business_id, product_id)`: **shared** on the variant side, so generating
a grid of fifty cells in parallel is unaffected, and **exclusive** on the
matrix side, so an axis write waits for the variant writes in flight and then
reads a state it can conclude from. It is taken on the INSERT path only: a
DELETE-path lock order is a caller obligation (`TL-P4-COORD-R62`), and taking
a lock after the executor's own lock on `OLD` is how a deadlock is built.

Races **G** and **H** run both arrival orders, measured:

| race | T1 | T2 | observed |
|---|---|---|---|
| G | INSERT the product's first variant, then COMMIT | INSERT a third axis, concurrently | T2 **blocked**, then refused `catalog.matrix_axis_set_frozen`; axes after both: 2; variants not naming exactly the registered set: **0** |
| H | INSERT a third axis while the product has no variants, then COMMIT | INSERT a 2-axis variant, concurrently | T2 **blocked**, then refused `catalog.variant_axis_set_incomplete`; axes after both: 3; non-base variants: 0; not naming the registered set: **0** |

Race H is the interesting one: there the freeze guard is **lawfully silent**,
because when T1 adds the axis the product has no variants at all. The
invariant is held by the variant side instead — in `READ COMMITTED` a plpgsql
trigger's queries take a fresh snapshot per statement, so once T2 stops
waiting on the advisory lock its completeness count reads three registered
against two supplied. A guard being silent is not the same as a guard being
absent, and only running the reverse order shows which one you have.

### 9.2 Defects 26 and 27

**Defect 26 (`P2-N02`).** `product_attribute_axes_10_axis_in_use` read *"in
use"* as *"named by a variant"*. Its own comment gave the outcome it was
written to prevent — *"it leaves the row in place while the validator above
stops treating it as an axis, which would freeze every matrix product that
names it"* — and an axis a matrix **registers with no variants yet** was
exactly that case and was not refused: measured, the archive succeeded, the
product's first variant insert was then refused `catalog.variant_axis_archived`,
and the product could not get a variant at all. Recoverable, so a trap and
not a corruption. The guard now reads `product_matrix_axes` too, which is the
relation its comment was about. **A guard whose own comment states a case it
does not cover is a guard that was written from the right reason and stopped
early.**

A consequence worth stating rather than hiding: the validator's own
`catalog.variant_axis_archived` branch is now **unreachable from any
committed state**, because both writers of that state are refused — an
archived axis cannot be registered, and a registered axis cannot be archived.
It is kept as defence in depth, and its case is now **structural** (the
branch is present in the installed function body) rather than live, with the
evidence class written down as the weaker one. The alternative was to keep a
live case that passes for a different reason than its name claims.

**Defect 27 (`P3-N03`): four mechanisms that did not do what they said.**

1. **The inert check.** The in-file bootstrap renderer ended with
   `assert "__" not in re.sub(...).replace("__","") or True` — inert twice
   over: `X or True` is always true, and `.replace("__","")` deletes the very
   substring the test looks for. The challenger measured it on a bootstrap
   carrying a placeholder outside the `_DB_PASSWORD__` shape: *"the renderer
   printed 1 placeholders substituted, exited 0, and wrote
   `__NEWROLE_PASSWORD__` through unrendered."* It is the **third** inert
   mechanism in this pack's history, after the canonicalizer's `ORDER BY k`
   and race B2's unregistered axis value, so it is taken as a rule and not as
   a typo: **anything shaped like a check needs a case that fails it.** The
   renderer is now `prep/phase11/harness/render_bootstrap.py`, its check has
   `--selftest` — a synthetic bootstrap with an unmatched placeholder, which
   must exit `1` and write nothing, and a clean one, which must exit `0` —
   and the harness runs that selftest **before** it renders or applies
   anything, so an inert check stops the run before a cluster exists.
2. **Stale labels.** `races.py` still called the ordering lock *"the
   inserter's key-share lock"* after it became `FOR SHARE` a round earlier.
   Corrected in the verdict text and the comments. The mechanism changing and
   the label not is how a reader is taught the wrong thing by a green run.
3. **A narrow assertion stated broadly.** The PUBLIC-policy assertion fired
   only on a permissive policy whose qualifier is literally absent or `true`,
   so `1=1` passed it while the message claimed the general case. **The
   recommended replacement — pin on `polroles = '{0}' AND polpermissive`
   alone, since these relations own no legitimate PUBLIC policy — was
   implemented and MEASURED, and it is false:** every relation of this pack
   carries exactly such a policy by design, its own permissive
   `tenant_membership` with no `TO` clause, and the pack refused itself on its
   own schema (`product_attribute_axes carries a permissive policy applied to
   PUBLIC`). *"A qualifier true of every row"* is not decidable in SQL, so no
   form of the assertion is both sound and complete. What is decidable is the
   **policy SET**, so the pack now refuses to install unless each of its
   relations carries exactly the two policies it reasoned about — which
   catches an added PUBLIC policy whatever its qualifier, and a removed one
   too — with a **named list of tautology spellings** beside it for the one
   case the set pin cannot see: the two policies themselves rewritten to a
   tautology. The residual is `PR-SEC-P11-01`'s and is stated as a residual.
   This is the second recommendation of this challenger's that measurement
   has refused, and both refusals produced a better assertion than either
   side proposed.
4. **The split GRANT/REVOKE**, which left a privilege on another phase's
   relation if the first case failed, is one case now, whose last statement
   revokes whatever the reads said and which then asserts the grant is gone.
   And the DEFINER refusal in the end-state assertion read
   `pg_proc.proname` unqualified, so a same-named function in another schema
   would have answered for the one the trigger calls; it reads
   `pg_trigger.tgfoid` now.

### 9.3 Run identity of this round

| field | value |
|---|---|
| `RUN_ID` | **`p11-20261012T155328Z-18615`** |
| `SOURCE_SHA` | **`0db94504abdc6b9142564e655c8032613214c06d`**, `SOURCE_TREE_DIRTY : no` |
| `PACK_A_DDL_SHA256` | `36913f0d6f79d81488bc80a8e9b467b3f6c9622106b1f2f16632c6240c18a8c7` |
| `PACK_B_DDL_SHA256` | `27bca629dc4d0ed238204e0e0cc11828db53808868dbae5c0854118410c5f60a` |
| `HARNESS_SHA256` | `76425738a036fd42c7dd3fdadfa1a53c156a27b84a5173f095330d4098ce5639` |
| PostgreSQL | **16.15**, cluster built by the harness itself; `DB_COLLATION en_US.utf8 / en_US.utf8 / UTF8`, read off the database under test |
| migrations | `0000`–`0086`, **87/87**, as **non-superuser** `daftar_migrator`; each pack in ONE transaction, end-state assertion as its last statement |
| frozen tree after the run | 0 tracked changes under `infrastructure/database`; `frozenThrough = 0079`; 80 entries, **0 digest mismatches** |

Commands, verbatim:

```
bash prep/phase11/harness/rebuild_and_prove.sh
```

Exit codes, printed by the run itself:

```
EXIT_PROOFS_A     : 0     46 cases, 0 failed
EXIT_PROOFS_B     : 0     31 cases, 0 failed
EXIT_PROOFS_A_RUN2: 0     the same file, the same database — idempotence
EXIT_PROOFS_B_RUN2: 0     the same file, the same database — idempotence
EXIT_RACES        : 0     9 races, 0 findings
EXIT_SCRIPT       : 0
```

### 9.4 Idempotence, and the order dependence it uncovered

The challenger's disclosure of its own method's limits carried a finding
about this preparation: *"your suite is not idempotent — a second run on the
same database fails 7 cases with no mutation at all, because its own writes
persist. The harness always rebuilds, so it never bites you, but it cost me a
run and it would mislead any reviewer who re-runs for a quick check."* It is
also a correctness hazard in the direction that matters: **a mutation
measured on a dirty database measures the dirt**, which is why that
challenger discarded its own first coverage run.

Both suites are fixed — every write that outlives its case is
conflict-tolerant, and the cases assert the committed state rather than the
fact of an insert — and the claim is **measured, not asserted**: step 6c of
the harness runs each suite a second time on the database the first run just
wrote and requires `0` both times. `races.py` keeps its append-only design
within a run (`stock_levels_retain()` forbids deleting a stock key at all, so
a clean slate inside one database is not available) and takes a **per-run
namespace** instead — products, variants, SKUs, value codes and sort orders —
so a second run adds a generation beside the first and measures its own.

Then a **third** run, after the races, found one more case of the same class
that the second run could not: *"a value no variant names is still
archivable"* archived the world's size `l`, and race B2 names `l` in a
committed variant. The case was true only while `proofs.py` ran **before**
`races.py` — a verdict that depended on the order the harness happens to call
its files in. It registers its own probe value now. **Idempotence of a file
is not independence of a suite**, and both have to be measured.

### 9.5 The new mechanisms are mutation-covered

Measured on the database the clean run left, which the idempotence proof
above makes a legitimate baseline (`RUN-EVIDENCE-MUTATIONS-0db9450.txt`):

| mutation | `proofs.py` exit | cases failed | which |
|---|---|---|---|
| baseline (a third run on that database) | **0** | 0 | — |
| `DROP TRIGGER product_matrix_axes_30_set_frozen` | **1** | 2 | the `P1-N01` refusal (`no error`) and the committed-state count, which reads **1** non-conforming variant |
| the `P2-N02` branch removed from `product_attribute_axes_10_axis_in_use` | **1** | 1 | the archive of an axis a matrix registers (`no error`) |
| the renderer's completeness check made inert again (`if left and False`) | **1** (`--selftest`) | — | the RED case reports `rc=0, output written=True` → `SELFTEST FAILED: the check is inert` |

Each mutation was restored and the baseline re-measured at `0` before the
next, and the committed state the mutated run left behind was undone.

### 9.6 What remains unsigned after this round

- **A third challenge is OWED.** The answered head is not the reviewed head,
  and this round's new surface — the freeze guard, the advisory lock pair,
  races G and H, the renderer and its selftest, the policy-set pin — is
  **the least reviewed code in the pack**, which is where this project has
  repeatedly found its worst defects. Nothing here is signed by its author.
- `READY_TO_PROMOTE` = **NO**. No migration number exists. No CI has executed
  any of this, and the container's Node (22.22.0 against `engines >=24 <25`)
  means no npm suite was run or claimed.
- Packs C and D (serial, repair/warranty) remain `SPEC ONLY`.
- `OD-P11-07` is the owner's.
- `PR-SEC-P11-01` (the standing RLS invariant check pinning `product_variants`'
  policy set) is the Security Authority's, and `MPR-07` (trigger positions,
  now including `_30_` on `product_matrix_axes`) is the Migration Owner's.

---

## 10. The FIRST independent challenge of PACK B: `REJECT`, and the four defects it found (defects 28–31)

The report is `/mnt/project-files/phase11/P11-CHALLENGE-b43871b.md`, its probes
and logs in `challenge-b43871b/`. It reproduced the whole authoritative run
from zero at the head — bootstrap as the deployment administrator, 87/87
migrations as `daftar_migrator`, both packs in one transaction each with their
end-state assertions passing, both worlds, 41 + 31 cases with 0 failed, 7
races with 0 findings, every exit code `0`, on PG 16.15 at `en_US.utf8`, clean
frozen tree afterwards — **and rejected the pack on coverage**, in the same
shape as the Pack A rejection: *a conservation law was guarded on the side
that writes the thing being conserved, and not on the side that moves what it
is conserved against.* It also signed the proof-SHA tie, the tenant-isolation
fix, the single-writer bridge and the owner-binding append-only law, and
recorded that my own labels for `C-LOT-02`, `C-LOT-04` and `C-FEFO-01` are
honest. Two of its own first-pass probes were mis-aimed and it re-ran them
from a clean rebuild before writing — disclosed in its own §7, and the reason
its findings are worth answering line by line.

### 10.1 Defect 28 (`P1-01`) — the law was unreachable from the side that moves the key

`C-LOT-03` is *"`Σ stock_lot_levels.on_hand = stock_levels.on_hand` for every
lot-tracked key"*, and the only guard was
`CREATE CONSTRAINT TRIGGER stock_lot_levels_conservation AFTER INSERT OR
UPDATE ON stock_lot_levels` — so it fired **only when the cache was written**.
The quantity it compares against lives in `stock_levels`, and nothing fired
when that side moved.

**Measured** from a state every law in the pack accepts (key `8`, cache `8`,
both lots cached): one more lot-tracked movement through the **official
command**, with its allocation and no cache write, under `SET CONSTRAINTS ALL
IMMEDIATE` — `COMMIT rc=0`, **the key at 12.0000 against a cache summing to
8.0000**. `C-LOT-01` was satisfied, so the first trigger passed and the second
never ran. It is item **6** of this preparation's own *"what a challenger
should attack"* list, and it attacked successfully. The handoff's status
sentence — *"a per-lot cache that does not sum to the stock key's on-hand is
refused at COMMIT"* — **was false as written**, and is corrected rather than
reinterpreted.

**The fix.** The comparison is made in the movement-side trigger, which has
the key in hand and fires on every movement, and it raises the **same error
name** as the cache-side trigger: one law, two reachable sites, rather than a
second truth about the same rule. **Scope, stated rather than widened:** what
is enforced is *a per-lot cache that **exists** for a key folds to that key*.
A key with **no** cache row stays lawful, because the writer that maintains
the cache is the integration of patch request §3.6 and does not exist at this
SHA — `C-LOT-03`'s other half (*every lot-tracked key has a cache*) stays
`WAITING_FOR_INTEGRATED_SURFACE` and is not claimed. Enforcing it now would
make the pack demand a writer nothing has written yet, which is how a
preparation starts inventing the surface it is waiting for. A **second
warehouse key** is in the world so that case has a subject of its own rather
than resting on which section of the suite runs first.

### 10.2 Defect 29 (`P1-02`) — the deferred check failed OPEN, and its stated reason was measurably false

The trigger is `SECURITY INVOKER` and opened with an RLS-filtered read of the
movement, returning `NULL` on `NOT FOUND`. **Measured:** the official command
wrote a movement of 7 for a lot-tracked variant; the session dropped to
`daftar_app` and `RESET` both context settings before `COMMIT`; `rc=0`, and a
lot-tracked variant held **7 units belonging to no lot**.

The comment justified the arm as *"the movement was rolled back inside this
transaction"*. The challenger measured that this **cannot reach the arm**: a
`DEFERRABLE INITIALLY DEFERRED` `AFTER INSERT` constraint trigger that always
raises fires on `INSERT; COMMIT` and **never** fires when the insert is rolled
back to a savepoint, because PostgreSQL discards the queued after-trigger
events of an aborted subtransaction. So the arm was not a rollback
accommodation; it was an RLS escape hatch with a comment on it.

This is the project's twice-ruled class — Phase 5's *"a deferred check that
reads under RLS fails open"* and Phase 13's case 11 — and the remedy is the
settled one: **a fail-closed branch, not `SECURITY DEFINER`** (a definer could
not satisfy these relations' RESTRICTIVE `business_isolation` anyway, which
Pack A measured the same day). An unreadable movement now raises
`inventory.lot_conservation_unverifiable`, which says *the law could not be
evaluated* rather than *the law holds* — a different statement, and the
difference is the defect. The same rule is applied one join further, where an
invisible **product** would have read as *"not lot-tracked"* through
`coalesce(…, false)`: an absence used as a negative answer.

**And a measurement that changed the fix.** The first version of this read
took `FOR SHARE` on the movement. `SELECT … FOR SHARE` needs UPDATE-class
privilege, which every writer of an append-only ledger deliberately lacks, so
the refusal came back as `permission denied for table stock_movements` — a
refusal from the **grant** instead of from the **law**. Reverted to a plain
read, with the reason in the file: the row was inserted by this same
transaction and the relation is append-only, so there is no concurrent writer
to order against.

### 10.3 Defects 30 and 31 (the two `P2`s)

**Defect 30 (`P2-03`): a `SECURITY DEFINER` reader with PUBLIC `EXECUTE`.**
`inventory_lot_fold` is owned by `daftar_migrator`, which owns every relation
in the pack, and carried no grant — so `EXECUTE` was PUBLIC by default.
Measured as `daftar_reconciler`, a role with no privilege of any kind on the
overlay: a direct `SELECT` on `stock_lot_movements` was refused *permission
denied*, and **the same quantity came back through the function**. The frozen
twin does not have that shape (`inventory_stock_fold` is owned by
`daftar_inventory_internal` and its ACL names that role). Row-level security
still scoped the read, so this was a **grant** boundary and not a tenant
boundary — and a definer function owned by the tables' owner is exactly the
object whose reach must be stated. `REVOKE EXECUTE … FROM PUBLIC`, a grant to
the two principals that need it, and an end-state assertion over
`has_function_privilege` so it cannot drift back to the default.

**Defect 31 (`P2-04`): the fold answered `0` where it refuses on the
business.** With the right business and the tenant context dropped or foreign,
RLS filtered every row and the fold returned a confident `0` against a lot
that really held `3.0000`. For a picker or an availability page `0` means
*"this lot is empty"*, and this project's standing lesson is that an
RLS-hidden zero is never proof of absence. Both halves of the scope refuse
now, and an invisible lot is a refusal rather than a zero. The challenger
checked whether the behaviour was inherited and found it is not — the frozen
fold answers with the tenant dropped because the core relations carry a
permissive `*_internal_read` policy for the principal it is reached through —
and said that its own first draft of the finding had guessed the opposite.
Recorded because that is the standard this round is held to as well.

### 10.4 The three notes

- **A lot's facts were freely rewritable** — `UPDATE stock_lots SET
  expiry_date = '2099-01-01'` on an expired lot returned `rc=0`, which makes an
  `expiry_policy` that admits only `refuse` weaker than it reads, and
  `received_seq` (which the picker's index orders by) had the same gap. Nothing
  in the pack *claimed* immutability, so this was a gap in the law set rather
  than a broken law, and it is closed in the direction the pack already chose
  for a mistyped variant combination: **correctable while nothing depends on
  it, frozen once history does.** A receipt typo is real and must be fixable; a
  lot whose movements exist is a thing the ledger has already spoken about. The
  guard binds the **owner**, as the append-only law does — and a case records
  that no runtime role holds `UPDATE` on `stock_lots` at this SHA at all, so
  the merchant-facing correction path needs a grant that does not exist yet and
  the guard is what that grant will be safe against.
- **The manifest's run-identity table was the superseded run.** Corrected: the
  manifest now names the current run, and the identity table in §1 of this
  document says in the text that it is the first challenge round's log and that
  the current round's identity is §9.3 / §10.5 — a status header must be gated
  like everything else.
- **`PB-09`'s refusal site.** Stated plainly: the proof that a hand-written
  movement cannot be committed rests on **`inventory.assertion_missing` from
  the command path**, which is the authority's own refusal. The `null value in
  column "stock_seq"` the challenger saw is a column default the internal role
  cannot supply — real, but weaker, and it could be removed by an unrelated
  change, so nothing in this preparation relies on it.

### 10.5 Run identity, exit codes, and the mutation measurement

| field | value |
|---|---|
| `RUN_ID` | **`p11-20261012T162240Z-30238`** |
| `SOURCE_SHA` | **`b7ee445cbe9a3bfe811a60ce004235878cb9c291`**, `SOURCE_TREE_DIRTY : no` |
| `PACK_A_DDL_SHA256` | `36913f0d6f79d81488bc80a8e9b467b3f6c9622106b1f2f16632c6240c18a8c7` |
| `PACK_B_DDL_SHA256` | `f9fe8ccc1490ddd8f1d72e6d2de29bbd9bb85fcc1f12bd983d1bd4c45883db22` |
| `HARNESS_SHA256` | `932ea04eb1ad7f269b61068a59484e4f28d32fb463e46240ca998a5fabac3514` |
| PostgreSQL / collation | **16.15**, `DB_COLLATION en_US.utf8 / en_US.utf8 / UTF8` read off the database under test |
| migrations | `0000`–`0086`, 87/87, as **non-superuser** `daftar_migrator`; Pack B's end-state assertion now **17 checks** |
| frozen tree after the run | 0 tracked changes, `frozenThrough = 0079`, 80 entries, 0 digest mismatches |

```
bash prep/phase11/harness/rebuild_and_prove.sh

EXIT_PROOFS_A     : 0     46 cases, 0 failed
EXIT_PROOFS_B     : 0     47 cases, 0 failed
EXIT_PROOFS_A_RUN2: 0     the same file, the same database
EXIT_PROOFS_B_RUN2: 0     the same file, the same database
EXIT_RACES        : 0     9 races, 0 findings
EXIT_SCRIPT       : 0
```

Raw logs: `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-b7ee445.txt` and
`prep/phase11/harness/RUN-EVIDENCE-MUTATIONS-PACKB-b7ee445.txt`.

**Every fix is red when its guard is removed**, each mutation measured on **its
own full rebuild from zero**:

| mutation | cases failed | which |
|---|---|---|
| the conservation trigger back to fail-OPEN with no cache-versus-key comparison | **3** | the movement-side cache refusal, the same refusal judged as `daftar_app`, and the unreadable-movement refusal — all three `no error` |
| `EXECUTE` on the definer fold granted back to PUBLIC | **2** | the no-privilege role reads through the fold; the catalogue assertion reads `true` |
| the lot-facts guard dropped | **2** | the expiry-date rewrite and the receipt-order rewrite, both `no error` |
| the fold's tenant half removed (the silent zero restored) | **2** | the dropped-tenant and foreign-tenant cases, both `no error` |

**Why a rebuild per mutation, which is itself a finding about method.** The
first attempt measured all four on one database, as the Pack A mutations
legitimately are. It cannot be done here: a Pack B mutation **commits** a state
the laws forbid, and a ledger is append-only and a stock key is retained — so
the restored baseline failed four cases from the mutant's own commits. The
challenger disclosed the same trap in its own §7. **A mutation is only
measurable on a state that can be restored.**

### 10.6 What remains unsigned for Pack B

- **Concurrency is `UNMEASURED` and is not claimed.** No race in this
  preparation attacks the overlay. The deferred checks read `stock_levels` and
  `stock_lot_levels` **without a row lock** — and `FOR SHARE` there is refused
  by the same privilege rule measured in §10.2 — so two concurrent lot-tracked
  movements on one key are an open question. In the official path nothing is
  lost today, because `inventory_adjust_stock` holds a stronger lock on that
  very row in the same transaction before the trigger fires; what is **not**
  proved is the case where one transaction writes the cache while another moves
  the key, and the cache writer is the integration that does not exist yet. No
  document may read this as cleared, and the lock order belongs with that
  writer when it lands.
- A **second challenge round for Pack B is owed**: the answered head is not
  the reviewed head, and the fail-closed arm, the movement-side comparison, the
  fold's two refusals and the lot-facts guard are the newest and least reviewed
  code in the pack.
- `READY_TO_PROMOTE` = **NO**, no migration number exists, and no CI has
  executed any of it.
