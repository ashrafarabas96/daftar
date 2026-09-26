# DAFTAR — Phase 3 Execution Plan / خطة تنفيذ المرحلة الثالثة

> **Companion to `docs/PHASE_3_ARCHITECTURE_LOCK.md`.** The lock says *what is true*; this page says *in what order it becomes true, and what each slice must prove before the next begins*. Where the two differ, the lock wins.
>
> **Baseline.** `main` at `0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f`. Branch `phase/3-inventory-purchases-suppliers`, cut from that exact commit. Migrations `0000`–`0052` frozen; 53 entries in the manifest; `frozenThrough = 0052_accounting_journal_lines_rls_performance.sql`.
>
> **P3-S0 is this document set and nothing else.** No migration, no table, no endpoint, no package, no UI.

---

## 1. Slice map

| Slice | Name | Creates | Gate |
|---|---|---|---|
| **P3-S0** | Architecture Lock | documentation only | predecessor gates green |
| **P3-S1** | Inventory & catalog primitives | the physical authority model (`daftar_inventory_internal`, named routines, column guards, grants, RLS, managed-PostgreSQL proof — P3-AL-54), the signed command authority (`invctl/1` key domain, verifier, operation registry — P3-AL-55), units registry, product inventory columns, base variant, `branch_warehouses`, Phase 3 permissions, TD-09 trigger, the transaction seam, `business_transaction_id` | `gate:phase3:s1` |
| **P3-S2** | Immutable stock ledger | `stock_movements`, `stock_levels`, `stock_movement_kinds`, deficit entities, fixed-point arithmetic in `@daftar/inventory`, the assertion-verifying movement primitive, rebuild | `gate:phase3:s2` |
| **P3-S3** | Transfers, adjustments, damage, stocktake, inventory initialization | the first Phase 3 commands that post | `gate:phase3:s3` |
| **P3-S4** | Suppliers, purchases, receiving, landed cost | AP posting, deficit coverage on receipt | `gate:phase3:s4` |
| **P3-S5** | Supplier returns, PPV, supplier credit notes, purchase reversal | `gate:phase3:s5` |
| **P3-S6** | Payment methods, supplier payments, allocations, credit allocations, refunds, realized FX | `gate:phase3:s6` |
| **P3-S7** | Financial and operational reads + merchant web UX | `gate:phase3:s7` |
| **P3-S8** | Security, failure injection, reconciliation, concurrency, performance, rebuild rehearsal | `gate:phase3:s8` |
| **P3-S9** | Release closure, release evidence, archive, deployment rehearsal | `gate:phase3:release` |

A slice boundary moves only when a real dependency requires it. Merging two large slices to go faster is forbidden: speed in DAFTAR comes from not doing the work twice.

---

## 2. Migration numbering — planning only

`0053` **does not exist** and P3-S0 does not create it. The plan reserves numbering conceptually, starting at `0053`, and does not promise an exact count: the count is whatever the design turns out to need, and committing to a number now would be a reason to split or merge a migration for arithmetic rather than for correctness.

Conceptual reservation, in slice order:

| Slice | Conceptual migrations |
|---|---|
| P3-S1 | units registry + product inventory columns + base variant shape; `branch_warehouses`; Phase 3 permissions; the `journal_entries` future-date trigger |
| P3-S2 | stock ledger + cache (incl. `valuation_base_minor`) + movement-kind registry + `stock_source_types` + `stock_source_bindings` + deficit entities + their trusted commands |
| P3-S3 | transfer/adjustment/stocktake/initialization sources, their commands, their stock source types and completeness guards, and the two new accounting source types |
| P3-S4 | suppliers, purchases, purchase items, landed cost, receive command, the negative-adjustment header/detail source, `purchase` + `negative_inventory_cost_adjustment` source types |
| P3-S5 | supplier returns, supplier credit notes, purchase reversal, two source types |
| P3-S6 | payment methods, supplier payments, allocations, credit allocations, refunds, three source types |
| P3-S7 | read indexes only, if measurement justifies any |
| P3-S8 | none expected |
| P3-S9 | none — release closure creates zero migrations |

**Frozen history stops at `0052` and every one of `0000`–`0052` stays byte-for-byte unchanged through all of Phase 3.**

---

## 3. P3-S1 — Inventory and catalog primitives

**Why first.** Every later slice needs a stock identity, a unit, a warehouse authority and a transaction seam. Building any of them inside a slice that also moves stock would mean shipping the foundation and the thing that stands on it in one reviewable unit.

**Delivers.**

0. **The physical authority model (P3-AL-54)** — owned by P3-S1 explicitly; none of it is an implementation detail:
   - 0أ **`daftar_inventory_internal`** created in `infrastructure/database/bootstrap.sql` (not in a migration), `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, `PASSWORD NULL` on re-run, `USAGE` on `public`, added to the `REVOKE TEMPORARY` list, and its **one** membership `GRANT daftar_inventory_internal TO daftar_migrator WITH INHERIT FALSE, SET TRUE`; `scripts/phase2-deployment-authority.ts` updated in the same commit (§C).
   - 0ب **The safe `SECURITY DEFINER` contract** as a permanent, catalogue-discovered check in `tests/security/search-path-shadowing.test.ts` and the static guards (§D).
   - 0ج **The three named routines** `inventory_configure_product`, `structure_associate_warehouse_branch`, `structure_dissociate_warehouse_branch`, owned by the internal role, `EXECUTE` to `daftar_app` only — **reachability, not authority** — each consuming an `invctl/1` assertion as its first act, called inside `withBusinessInventoryTransaction` after the application's permission check and minting (P3-AL-54 §E, P3-AL-55). The routines write the audit row with the asserted actor.
   - 0ح **The signed command authority (P3-AL-55)**: `inventory_assertion_keys`, `inventory_assertion_uses`, `inventory_operation_kinds` seeded with exactly `inventory.configure_product`, `structure.associate_warehouse_branch`, `structure.dissociate_warehouse_branch`; `inventory_assertion_key_install` / `_retire` (`EXECUTE` to `daftar_platform` only, cannot read); the internal verifiers `inventory_assertion_consume` and `inventory_assertion_current` (no `EXECUTE` grant); the package `@daftar/inventory` with `assertion.ts` (mint and split, never verify) and `payload.ts` (`invpl/1`), and `vectors/invpl-vectors.json` shared with the SQL canonicalizer; the merchant-API minter service; `INVENTORY_ASSERTION_KEY` / `INVENTORY_ASSERTION_KID` in `config.ts` — required for `merchant-api` in production, forbidden in `platform-api`, `worker` and `reconciler`, and refused when its decoded bytes equal the provisioning or accounting key's; `scripts/install-inventory-key.ts`; the carrier `app.inventory_assertion` in `applyScope`.
   - 0د **The two invoker-rights column guards** `products_10_inventory_config_authority` (`inventory.configuration_authority_required`) and `product_variants_10_base_variant_authority` (`catalog.base_variant_not_mutable`); `daftar_app` keeps its table-level `UPDATE` on `products` (§F).
   - 0هـ **The home-association objects' authority**: maintainer, completeness proof and keep-one `SECURITY DEFINER` owned by the internal role; `branch_warehouses` with `ENABLE` + `FORCE` RLS in the `0006` two-policy layering; `daftar_app` `SELECT` only; nothing for `daftar_platform` or `daftar_provisioner` (§I).
   - 0و **The live grant matrix** of §H, and the migration's own `inventory.authority_leak` assertions from the catalogues, including the membership shape.
   - 0ز **The managed-PostgreSQL proof** of §J: `0052 → P3-S1` applied as a real `daftar_migrator` with `rolsuper = false`, `rolbypassrls = false`, ownership transfers bracketed by a `CREATE ON SCHEMA public` grant revoked in the same file, and the catalogue diffed against a superuser build. **If any P3-S1 object works only as a superuser, P3-S1 fails.**
1. **Units registry** — `units`, `unit_names`, seeded (P3-AL-05).
2. **Product inventory columns** — `track_inventory` (default `false`), `unit_code`, `unit_decimals`, with the CHECK that a tracked product must carry canonical units. **No backfill guess** from `products.unit` (P3-AL-04).
3. **Base variant** — `product_variants.is_base` with `UNIQUE (business_id, product_id) WHERE is_base`, the enable-tracking command that creates one when a product has no variants (P3-AL-03), **and the boundary that keeps it hidden (P3-AL-52)**: `is_base = false` added to every merchant-facing variant read in `CatalogService`, a `CHECK` keeping a base variant's `sku`, `barcode`, `price_minor` and `attributes` empty, and the invoker-rights trigger `product_variants_10_base_variant_authority` admitting inserts and updates of such a row only as `daftar_inventory_internal` — which in turn may insert only `is_base = true` rows and holds no `UPDATE` or `DELETE` on the table (P3-AL-54 §F/§H). This is P3-S1's work, not P3-S7's — P3-S7 adds inventory UX, P3-S1 preserves the catalog UX that already exists.
4. **`branch_warehouses`**, seeded from `warehouses.branch_id`; `warehouses.branch_id` unchanged (P3-AL-15).
   - 4أ **The home-association lifecycle (P3-AL-15 §A)** — four schema objects, because there are **three** warehouse writers and the third, `provision_create_business` at `0033_provisioner_atomic_authority.sql:160–164`, is a `SECURITY DEFINER` routine in a **frozen** migration that no service-level rule can reach: a non-deferred `AFTER INSERT` maintainer on `warehouses`; the deferred constraint trigger `warehouses_require_home_branch`; the deferred `branch_warehouses_keep_home`; and a `BEFORE UPDATE` refusal of any change to `warehouses.branch_id`. The migration asserts all four from `pg_trigger` by name.
   - 4ب **The association commands (P3-AL-15 §B)** — `structure.addWarehouseBranch` / `structure.removeWarehouseBranch` on the existing Structure domain, with their controller routes, requiring `warehouse.manage` **and** `branch_scope_mode = 'all'`, idempotent, audited, refusing archived targets and refusing removal of the home association. The application checks permission and scope, then calls `structure_associate_warehouse_branch` / `structure_dissociate_warehouse_branch`; `daftar_app` has no DML on `branch_warehouses` (P3-AL-54 §E). **P3-S1 creates the real callable path; P3-S7 adds only the UI** — no later slice's authorization may depend on a capability with no caller.
5. **Phase 3 permissions** — eleven keys in `packages/domain-core/src/permissions.ts`, seeded on the `0041` pattern exactly as **P3-AL-38** states and nowhere otherwise: **Owner** all eleven; **Manager** exactly `inventory.view`, `purchases.view`, `suppliers.view` **appended** to its accepted Phase 1 set; **Cashier** none; **existing custom roles** untouched. (An earlier draft of this plan said "seeded to the owner system role only" with a "no non-owner role gained one" assertion; that contradicted P3-AL-38 and is **withdrawn** — the lock wins.) Five migration assertions: owner completeness; manager set equality **restricted to the Phase 3 keys**; **no non-owner role of any kind holds any of the eight sensitive keys**, expressed over the sensitivity column rather than a copied list; every pre-existing custom role's permission set unchanged; and **manager preservation** — the Manager's seventeen accepted Phase 1 keys byte-identical before and after, which is what stops an implementation replacing the set instead of appending to it.
   - 5أ **Future businesses (P3-AL-53)** — `BUILTIN_ROLE_PERMISSIONS` is evolved in the **same commit** as the migration, because onboarding seeds from that registry through `provision_create_business` and not from the migration at all. Acceptance **provisions a real business through the accepted flow after applying the candidate migration** and reads the persisted `business_roles` / `role_permissions` rows; the five assertions run again there, plus a direct comparison proving a backfilled business and a freshly provisioned one hold the same Phase 3 set per system role key.
6. **TD-09** — the `BEFORE INSERT` future-date trigger on `journal_entries`, business timezone, stable `accounting.entry_date_in_future` (P3-AL-36); its function `SECURITY DEFINER` owned by **`daftar_accounting_internal`**, never by the inventory principal (P3-AL-54 §H).
7. **The two transaction seams** — `withBusinessInventoryTransaction(scope, inventoryAssertion, fn)` (no posting capability reachable) and `withBusinessInventoryAccountingTransaction(scope, inventoryAssertion, accountingAssertion, fn)` (posting capability; assertion/scope coherence checked before any domain mutation), plus the accounting ports' client-accepting variants (P3-AL-32, renamed in Round 5). The distinction is carried by the handle type; **no boolean, option or string may turn one into the other or open either without its inventory assertion.** The existing single-operation methods keep their signatures and are re-implemented in terms of the new ones.
8. **The authorization seam** — domain permission + warehouse scope resolution, as a typed helper used by every later command (P3-AL-33, P3-AL-39).
9. **`business_transaction_id`** generation at the API boundary (P3-AL-35).

**Must prove.**

- **The authority acceptance of P3-AL-54**, each a permanent test that is shown to fail when its guard is removed:
  1. raw SQL as `daftar_app`: `UPDATE products SET track_inventory = …`, `SET unit_code = …`, `SET unit_decimals = …` → each **REFUSED**, `inventory.configuration_authority_required`; the same for a raw `INSERT` that sets any of them;
  2. `CatalogService` price, category, SKU, barcode and `products.unit` updates **still work**, and the accepted catalog suites pass unchanged;
  3. `inventory_configure_product` succeeds only after the application's `inventory.adjust` check and a consumed `inventory.configure_product` assertion; a member without the permission is refused before the minter is reached, and no argument, option or flag skips either;
  4. base-variant `INSERT`/`UPDATE` as `daftar_app` → **REFUSED**, `catalog.base_variant_not_mutable`; base-variant `DELETE` as `daftar_app` → refused by privilege (`42501`); the internal role inserting `is_base = false` → **REFUSED**;
  5. runtime membership in `daftar_inventory_internal` is **zero**, transitively, for `daftar_app`, `daftar_platform`, `daftar_worker`, `daftar_provisioner`, `daftar_identity`, `daftar_resolver` and `daftar_reconciler`; its only member is `daftar_migrator` with `inherit_option = false`;
  6. the internal role's `rolcanlogin`, `rolbypassrls`, `rolsuper`, `rolcreaterole`, `rolcreatedb`, `rolreplication`, `rolinherit` are all **false**, and it holds neither `TEMPORARY` nor, after the migration, `CREATE` on `public`;
  7. `PUBLIC` holds `EXECUTE` on **none** of the Phase 3 routines; every function owned by the internal role passes the §D catalogue check, and the two column guards are the only `prosecdef = false` exceptions;
  8. raw `INSERT`/`DELETE` on `branch_warehouses` as `daftar_app` → refused by privilege; `daftar_platform` and `daftar_provisioner` hold no privilege on it;
  9. `provision_create_business` creates the first warehouse **and** its home association atomically on a database built by the non-superuser migrator; with the maintainer forced to fail, the **whole onboarding** rolls back (warehouse matrix row L);
  10. the managed-PostgreSQL run of P3-AL-54 §J **passes**, and its catalogue equals the superuser build's;
  11. no Phase 1 or Phase 2 regression — every accepted suite, golden fixture and gate passes unchanged.
- **The signed-authority matrix of P3-AL-55** (Round 5), each run over a **raw connection as `daftar_app`** with no application in the path unless the row says otherwise, and each shown to fail when assertion verification is removed (the PM-44 negative control):
  - **A.** raw `UPDATE` of `track_inventory`, `unit_code` or `unit_decimals` → **REFUSED**, `inventory.configuration_authority_required`;
  - **B.** direct `inventory_configure_product` with no assertion → **REFUSED**, `inventory.assertion_missing`;
  - **C.** victim `app.tenant_id`, `app.business_id` and `app.actor_user_id` (an owner's UUID) set, no assertion → **REFUSED**, `inventory.assertion_missing`; and with a genuine assertion for another business → `inventory.assertion_scope_mismatch`;
  - **D.** forged assertion — wrong key, MAC altered, any one claim altered under the original MAC, non-canonical case → **REFUSED** (`inventory.assertion_invalid_signature` / `inventory.assertion_malformed`);
  - **E.** expired assertion, and one whose expiry is more than 65 s ahead → **REFUSED** (`inventory.assertion_expired` / `inventory.assertion_ttl_exceeded`);
  - **F.** wrong operation kind → **REFUSED**, `inventory.assertion_wrong_operation`;
  - **G.** valid assertion, each of `product_id`, `track_inventory`, `unit_code`, `unit_decimals` altered in turn → **REFUSED**, `inventory.assertion_payload_mismatch`;
  - **H.** replay in a second transaction after a committed use, and a second call in the same transaction → **REFUSED**, `inventory.assertion_replayed`; a rolled-back first use retried with the identical payload inside the TTL → accepted (documented as a retry);
  - **I.** a configuration assertion presented to either association routine, and an association assertion to the dissociation routine → **REFUSED**;
  - **J.** direct `structure_associate_warehouse_branch` / `structure_dissociate_warehouse_branch` with no assertion → **REFUSED**;
  - **K.** valid assertion for warehouse A + branch B used for A + C and for D + B → **REFUSED**, `inventory.assertion_payload_mismatch`;
  - **L.** through the HTTP command, an **assigned-scope** actor holding `warehouse.manage` cannot obtain an association assertion — the command refuses before the minter is called, asserted by a minter call counter of zero;
  - **M.** through the HTTP command, an authorized all-scope actor succeeds, the association exists, and the routine-written audit row names that actor;
  - **N.** `daftar_platform`, `daftar_worker`, `daftar_provisioner`, `daftar_reconciler`, `daftar_identity` and `daftar_resolver` cannot `EXECUTE` any of the three routines (`42501`), nor the two verifiers;
  - **O.** no runtime role can `SELECT` (or `INSERT`, `UPDATE`, `DELETE`) `inventory_assertion_keys` or `inventory_assertion_uses`; `daftar_platform` installs and retires a key and cannot read it back; same `kid` + different secret → `inventory.assertion_key_conflict`;
  - **P.** `config.ts` refuses production start when the decoded inventory key equals the accounting or the provisioning key, including under a different base64 spelling; the key is refused in platform, worker and reconciler modes;
  - **Q.** the `invpl/1` vectors produce byte-identical digests in TypeScript and SQL, including NULL fields, `unit_decimals = 0`, and associate/dissociate over identical ids (which must differ);
  - **R.** the managed-PostgreSQL run of P3-AL-54 §J also creates the three key-domain tables and five functions as a non-superuser migrator, with ownership transfers bracketed in the same file, and the catalogue diff against a superuser build is empty.
- A future-dated raw `INSERT` into `journal_entries` **by the schema owner** is refused by the trigger, and the three posting commands still refuse it too — both halves, as P2-S8's raw-SQL matrix asserts today.
- The trigger resolves the **business's** timezone: an entry dated "tomorrow" in UTC but "today" in the business's zone is accepted, and the reverse is refused.
- A tracked product cannot exist without `unit_code` and `unit_decimals`.
- Enabling tracking on a product with no variants creates exactly one base variant, with NULL sku/barcode, and a second call is idempotent.
- No existing product became tracked, and no stock row exists, after the migration.
- **The full warehouse matrix of P3-AL-15 §C, rows A–M**, as permanent tests: the pre-migration warehouse ends with exactly its home association; `createBranch()`, `createWarehouse()` and the accepted provisioning flow each commit warehouse and home association atomically; a forced home-association failure **rolls the warehouse creation back** (row D, which is what proves the completeness trigger is load-bearing rather than decorative); an `assigned`-scope actor with no association reaches no warehouse; an `assigned`-scope actor is **refused** when adding an association that would widen their own reach; a business-wide actor with `warehouse.manage` may add one, idempotently; a cross-business association is refused **by the database**; deleting the home association is refused, in raw SQL as well as through the command; deleting a non-home association is allowed and leaves the home mapping intact; the accepted Phase 1 warehouse suites still pass unchanged; a forced maintainer failure inside onboarding rolls the whole onboarding back (row L); and raw association DML as `daftar_app` is refused by privilege (row M).
- **The base-variant proofs of P3-AL-52, rows 1–8**: `getProduct()` still renders a simple product as simple, the base variant is absent from `VariantDto[]`, search by name/SKU/barcode is byte-identical, the NULL identifiers are asserted against the partial unique indexes rather than assumed, repeated enablement makes exactly one base variant, the accepted golden catalog fixtures render identically, and an ordinary variant mutation aimed at `is_base = true` is refused through the command **and** as raw SQL as `daftar_app`.
- **The unit lifecycle of P3-AL-05 §D that P3-S1 owns**: a tracked product with no movement may still have its canonical unit changed deliberately (row 2), and `products.unit`, the free label, may change at any time without moving an inventory number (row 7). Rows 3–6 and 8 belong to P3-S2, which installs the physical trigger.
- **The P3-AL-32 seam matrix, in full — the primitive only, with no Phase 3 entity:**
  1. `withBusinessInventoryTransaction` issues exactly one `BEGIN` and one `COMMIT` for the whole callback, observed from the server.
  2. A failure anywhere in the callback rolls back **every** mutation made through it, including in a **test-owned fixture table**.
  3. The callback's handle exposes **no** accounting posting port — a compile-time property, asserted additionally at runtime.
  4. The raw transaction object cannot be passed into the accounting posting port: no signature accepts it, and the runtime port refuses a handle that did not come from the accounting seam.
  5. Opening either seam inside either seam is rejected or unreachable through the public typed ports.
  6. Either seam refuses when the inventory or accounting assertion's tenant/business claims differ from the scope's, **before the callback executes** — proved by asserting the fixture table is empty after the refusal; and neither can be opened without an inventory assertion.
  7. Inside `withBusinessInventoryAccountingTransaction`, with a real `inventory.configure_product` assertion and an accounting assertion, an **existing accepted Phase 2 accounting operation** runs on the same transaction handle and commits once with the P3-S1 command.
  8. A failure injected **after** that accepted posting rolls back the posting **and** the companion fixture mutation.
- **P3-S1 creates no production transfer, purchase or stock table**, and proves no transfer, adjustment or purchase-receipt path: those entities belong to P3-S2/S3/S4, and proving them here would mean implementing a future slice early or testing a stand-in that proves nothing about the real path. The real end-to-end proofs are owned by **P3-S3** (transfer, adjustment, damage, stocktake, opening) and **P3-S4** (purchase receipt), and are listed there.
- Every accepted Phase 2 posting path still works unchanged through the re-implemented ports (the whole Phase 2 suite is the test).

---

## 4. P3-S2 — The immutable stock ledger

**Delivers.**

1. `stock_movements` — append-only by trigger, `stock_seq`, the five-part identity tuple, `qty_delta NUMERIC(18,4)` / `unit_cost_base_minor NUMERIC(28,10)` (snapshot) / **`value_delta_base_minor BIGINT`** (authoritative, integer base minor units) with their CHECKs (P3-AL-01, P3-AL-02, P3-AL-09, P3-AL-11, P3-AL-49).
2. `stock_levels` — one row per stock key: `on_hand NUMERIC(18,4)`, **`valuation_base_minor BIGINT`**, `avg_unit_cost_base_minor NUMERIC(28,10)` (derived, nullable), `last_stock_seq`; never deleted (P3-AL-01, P3-AL-06, P3-AL-49).
3. `stock_movement_kinds` — the closed registry with `qty_sign` and `requires_reason` (P3-AL-10).
4. `negative_inventory_deficits` and `negative_deficit_coverages` — tables and `deficit_seq` allocation, **no producer** (P3-AL-12, P3-AL-13).
4ب. `stock_source_types` — the closed source registry, created and seeded with **nothing** (P3-AL-50).
4ج. `stock_source_bindings` — **movement-grained**: primary key `(business_id, source_type, source_id, source_line_id, movement_kind)`, with `DEFERRABLE INITIALLY DEFERRED` composite FKs in **both** directions against the identical five-part key on `stock_movements`, so one transfer line's two movements each have their own binding (P3-AL-51 §A).
4د. The **per-source bridge** pattern and the binding-side constraint-trigger mechanism that together prove a binding's source line really exists, plus the catalogue assertion that no registered source type may lack its bridge or its trigger (P3-AL-51 §B).
5. `@daftar/inventory` — fixed-point `BigInt` arithmetic, the weighted-average formulas, the single HALF_EVEN persistence boundary, the exact-representability quantity test, the full-depletion flush and the five valuation vectors (P3-AL-05, P3-AL-08, P3-AL-49).
6. The trusted `SECURITY DEFINER` movement primitive, owned by **`daftar_inventory_internal`** (the role P3-S1 created — no second inventory principal), under the P3-AL-54 §D contract, with `daftar_app` holding `SELECT` only on the tables and **no runtime `EXECUTE`** on the primitive. **It requires and verifies an inventory assertion** (P3-AL-55 §G): `inventory_assertion_current` re-verifies the carrier's signature, kind and scope and requires that the entry routine of **this** transaction consumed it; and the primitive refuses a movement kind the assertion's operation kind does not map to (`inventory_operation_movement_kinds`, created empty here and filled by each producing slice). No operation kind maps to any movement kind at the end of P3-S2, so the primitive has no reachable producer — tests register a fixture kind inside a rolled-back transaction, as for the source registry.
7. The rebuild algorithm and its verification mode (P3-AL-42).
8. **The canonical unit history guard (P3-AL-05 §D)** — `products_20_unit_history_lock`, `SECURITY DEFINER` owned by `daftar_inventory_internal`, declared `WHEN (OLD.unit_code IS DISTINCT FROM NEW.unit_code OR OLD.unit_decimals IS DISTINCT FROM NEW.unit_decimals)` and firing after P3-S1's `products_10_inventory_config_authority` (P3-AL-54 §G), with a `FOR SELECT` policy on `stock_movements` admitting the internal role — the `BEFORE UPDATE ON products` trigger refusing a change to `unit_code` or `unit_decimals` once any movement exists for any variant, raising `inventory.unit_identity_locked`. It lands here and not in P3-S1 because a trigger body cannot reference `stock_movements` before this slice creates it; the intervening window is empty rather than short, since with no movements table no product has history, and it closes **before** P3-S3, the first slice authorized to produce a real movement.

**Must prove.**

- `UPDATE` and `DELETE` on `stock_movements` are refused for every principal including the schema owner's ordinary DML path.
- No runtime role holds DML on either table — the live grant matrix, not the migration text.
- Two concurrent first-touches of the same stock key produce one row and two correctly ordered movements.
- Two opposite multi-key commands do not deadlock, with two real connections.
- The shared vectors produce byte-identical results in TypeScript and in SQL, including the HALF_EVEN tie cases that `round()` would get wrong.
- A rebuild of a key with hundreds of movements — including value-only movements, repeating averages, full depletions and transfers — reproduces `on_hand`, `valuation_base_minor` and the derived average **exactly**, to the tenth decimal, with no tolerance (P3-AL-49 §D vector E).
- A quantity movement with `qty_delta = 0` is refused; a value-only movement with a non-NULL unit cost is refused.
- **Quantity precision (P3-AL-05):** all ten bound vectors, through every command. In particular a `unit_decimals = 0` product **accepts** `1`, `1.0000` and `-3.0000` where the kind allows a negative quantity, and **refuses** `0.5` and `1.0001` with `inventory.quantity_precision_invalid`; a `unit_decimals = 2` product accepts `1.2300` and refuses `0.0001`.
- **The nine rounding and valuation vectors of P3-AL-49 §D**, asserted identically in TypeScript and in SQL, each showing the stored movement value, the cache valuation, the Inventory journal line, the rounding treatment, the GL total and the reconciliation equation. Vectors **B** and **C** are the ones that disprove the withdrawn model (`+0.6, +0.6` → GL `2` but aggregate rounding `1`; `+0.4, +0.4` → GL `0` but aggregate rounding `1`), and the suite keeps them as negative controls.
- **Full depletion (P3-AL-49 §C):** emptying a key whose average does not terminate leaves `valuation_base_minor` exactly `0`; the invariant `on_hand = 0 ⇒ valuation = 0` is asserted for every key a command touched, before COMMIT. Over a receive-then-fully-deplete cycle, total outbound value equals total inbound value **to the minor unit** (vector G).
- **No second conversion:** an inventory movement's journal amount **is** the stored `value_delta_base_minor`, so no inventory posting carries a `6100 Rounding Adjustment` line — asserted by querying the entries, not by reading the code.
- **No path derives valuation from `on_hand × avg`** — a static guard over the inventory package and the migration SQL, so the prohibition is enforced in CI rather than remembered.
- **Source registry (P3-AL-50):** an unregistered `source_type` string is refused by the foreign key; the registry is empty at the end of P3-S2, and the structural tests use a rolled-back fixture identity rather than a seeded one.
- **Source completeness (P3-AL-51):** a movement without its binding does not survive COMMIT; a binding without its movement does not survive COMMIT; **a binding + movement pair whose source line does not exist does not survive COMMIT** (the binding-side trigger and the bridge's real FK, not a source-side trigger that would never fire); a bound source line cannot be deleted; a finalized source line's quantity, cost, variant and warehouse cannot be updated.
- **Binding cardinality:** the movement-grained key admits **two** bindings for one transfer line and refuses a third, and both directional FKs resolve — the property the line-grained draft could not have had.
- **The primitive's authority (P3-AL-55 §G):** no runtime role can `EXECUTE` it; called with no consumed assertion in the transaction → `inventory.assertion_not_consumed`; with a consumed assertion whose operation kind does not map to the movement kind → refused; with a consumed assertion for another business → refused.
- **The unit history lock (P3-AL-05 §D, rows 3–6 and 8):** after the first movement, changing `unit_code` or `unit_decimals` is refused through the configuration command **and** as raw SQL; bringing stock back to zero does **not** unlock them; disabling tracking at zero and re-enabling it reuses the historical unit without re-asking; and a later change to `units.default_decimals` leaves every existing product's persisted `unit_decimals` untouched. The trigger's presence is asserted from `pg_trigger` by name, so a later migration cannot drop it silently, and so is its **order** after `products_10_inventory_config_authority`: a raw `UPDATE` of the unit as `daftar_app` on a product with history is refused with `inventory.configuration_authority_required` (who, first), and the same change through `inventory_configure_product` with `inventory.unit_identity_locked` (when).

---

## 5. P3-S3 — Transfers, adjustments, damage, stocktake, initialization

**First slice that posts.** It therefore owns the two seams' first real use and the predecessor-assertion evolution. **It registers exactly its own operation kinds** (P3-AL-55 §E): `inventory.transfer`, `inventory.adjust`, `inventory.damage`, `inventory.stocktake_open`, `inventory.stocktake_count`, `inventory.stocktake_finalize`, `inventory.opening`, with their movement-kind mappings and their `invpl/1` field lists (every line's variant, warehouse and quantity; a transfer binds **both** warehouses). Every command consumes one inventory assertion; every financial one also carries its accounting assertion through `withBusinessInventoryAccountingTransaction`.

**Delivers.**

1. Transfer command — the atomic movement pair through the **non-posting** seam, no journal entry, cross-business impossible; the destination's value is the exact negation of the stored source value (P3-AL-14, P3-AL-32).
2. Adjustment and damage commands — `Dr/Cr COGS(5000)` against Inventory (P3-AL-17).
3. Stocktake — capture with `expected_qty_at_capture` and `captured_at_stock_seq`, `draft → finalized | cancelled`, variance applied once, valuation at finalization, explicit unit cost required when there is none (P3-AL-16).
4. Inventory initialization — Case A posts `Dr Inventory / Cr Opening Equity`; Case B posts nothing and requires exact equality (P3-AL-18).
5. Registers `inventory_adjustment` and `inventory_opening` in `accounting_source_types`, and `inventory_opening`, `inventory_adjustment`, `stocktake` and `inventory_transfer` in `stock_source_types`, each with its source table, both completeness guards, deletion protection and bindings (P3-AL-34, P3-AL-50, P3-AL-51).
6. **Evolves the two permanent predecessor assertions** named in the lock's F-4, in the smallest honest way, losing no evidence (P3-AL-34).

**Must prove.**

- Transfer: total business valuation delta is exactly zero **by construction**, including when the transfer empties the source key (P3-AL-49 §D vector C); source average unchanged; destination average recomputed; GOLD-44's numbers reproduce.
- Transfer opens the **non-posting** seam and mints no accounting assertion at all — asserted, not assumed.
- **The bound transfer completeness vector (P3-AL-51 §E)**, with each of its nine states refused **independently** and by the named mechanism: only `transfer_out`; only `transfer_in`; duplicate `transfer_out`; duplicate `transfer_in`; binding with no movement; movement with no binding; movement + binding with no transfer line; deleting the finalized line; editing the finalized line's quantity or warehouse.
- **P3-S3 owns the first real end-to-end atomicity proofs** the seam was built for (P3-AL-32): transfer through the non-posting seam, and adjustment / damage / stocktake / opening through the accounting seam — stock + journal + binding + audit + outbox in one commit. P3-S1 proved the primitive; this slice proves the path.
- Transfer creates no journal entry, and a test asserts the absence rather than assuming it.
- A transfer whose destination the actor cannot reach is refused, even when the source is reachable.
- Stocktake: movements between capture and finalization do not corrupt the variance; finalizing twice applies it once.
- A positive variance on a zero-cost key is refused with `inventory.unit_cost_required`.
- Case B with a valuation that differs by one minor unit is refused, with both totals reported and no journal entry written.
- Case B writes **no** journal entry at all — asserted by counting entries before and after.
- A crash injected between the movement and the posting leaves **nothing**: no movement, no entry, no binding, no audit row, no outbox row.
- The two evolved assertions still fail if an *unauthorized* source type appears.

---

## 6. P3-S4 — Suppliers, purchases, receiving, landed cost

**Delivers.** Suppliers with lifecycle and snapshots (P3-AL-40); purchases `draft → received | cancelled` with immutable received content (P3-AL-19); one line per variant (P3-AL-21); landed cost `by_value` / `manual` with largest-remainder distribution (P3-AL-22); the receive command posting `Dr Inventory / Cr AP` always (P3-AL-24); the purchase FX snapshot (P3-AL-25); deficit coverage inside the receipt transaction through the **header/detail** identity model, so one receipt line may cover many layers without colliding on the movement identity tuple (P3-AL-13); live derived AP reads (P3-AL-26); registers `purchase` and `negative_inventory_cost_adjustment` in both registries; registers its own `invctl/1` operation kinds — supplier create/update/archive and purchase draft/receive/cancel, one per command — with their permission, scope and `invpl/1` field lists (P3-AL-55 §E).

**Must additionally prove.** One purchase line covering **three** deficit layers writes three distinct coverage movements, each with its own `source_line_id`, none refused and none dropped; the single catch-up journal entry's amount equals the sum of the three **stored** movement values; a replay of the same receipt writes nothing further. **P3-S4 owns the real purchase-receipt atomicity proof** (P3-AL-32): purchase + lines + movements + cache + coverage + journal + binding + audit + outbox in one commit, and a crash injected anywhere inside it leaves nothing. The receipt's per-line integer shares sum **exactly** to the purchase's integer base-currency total, so `Dr Inventory = Cr AP` with no plug and no `6100` line (P3-AL-49 §C).

**Must prove.**

- A cash purchase and a credit purchase produce the **same** accounting model; there is no second path.
- `by_value` with a zero denominator refuses; `manual` whose sum differs by one minor unit refuses.
- Σ allocations = landed-cost total exactly, with the `line_no` tie-break, for a distribution that does not divide evenly.
- A received purchase refuses `UPDATE` and `DELETE` on its header, lines and allocations.
- A retried receive creates no second movement and no second journal entry.
- Deficit coverage: deficits seeded by the schema owner in the test database are covered oldest-first; GOLD-72's numbers reproduce; two concurrent receipts cover disjoint quantities.
- Non-zero purchase tax is refused with `purchase.tax_policy_absent` (P3-AL-23).
- A purchase in a foreign currency uses its own snapshot after the registry's current rate has changed.

---

## 7. P3-S5 — Supplier returns, PPV, credit notes, purchase reversal

**Delivers.** Supplier return at current average from the warehouse the goods leave, with the original purchase carrying value frozen and the difference to `6200` (P3-AL-29); AP first, excess to `1150` through a supplier credit note (P3-AL-30); purchase reversal under its four preconditions (P3-AL-20); registers `supplier_return` and `purchase_reversal`, and the `invctl/1` operation kinds of exactly those commands (P3-AL-55 §E).

**Must prove.**

- Cumulative returned quantity may not exceed the purchased quantity of the line.
- A return that would drive the source key negative is refused.
- Returning from a warehouse other than the original destination succeeds when authorized, and is refused when not.
- A return whose value exceeds outstanding AP debits AP by exactly the outstanding amount and puts the excess on `1150` — never a negative AP, never revenue.
- Each of the four purchase-reversal preconditions refuses independently, with its own stable code.
- A purchase reversal removes exactly the value the receipt added, at the original receipt cost.

---

## 8. P3-S6 — Payment methods and supplier settlement

**Delivers.** The minimal shared `payment_methods` / `payment_method_names` foundation (P3-AL-27); supplier payments settling AP with partial support (P3-AL-28); allocations with the full tri-currency shape and realized FX to `4900`/`6900`; supplier credit allocations and refunds with the two-value locking rule (P3-AL-31); registers `supplier_payment`, `supplier_credit_allocation`, `supplier_refund`, and the `invctl/1` operation kinds of exactly those commands (P3-AL-55 §E).

**Must prove.**

- A payment method cannot be created or activated without a valid, same-business, active posting account of an acceptable type.
- A used payment method cannot be deleted, and deactivating it does not change any posted entry.
- Over-allocation is impossible under concurrency: two concurrent allocations against one purchase cannot exceed its outstanding amount.
- Realized FX lands on `4900`/`6900` and never on `6100` or `6200`.
- Partial consumption releases carrying base proportionally; the final consumption releases the entire residue, leaving no dust.
- Two concurrent consumers of one supplier credit cannot overconsume it.
- **No Customer Payments exist** — asserted by the absence of the tables and routes.

---

## 9. P3-S7 — Reads and merchant web UX

**Delivers.** Live derived reads for stock, supplier balances and purchase outstanding (P3-AL-26, P3-AL-44); the six merchant screens of P3-AL-48, responsive, in the web application only (P3-AL-47).

**Must prove.** No cache, projection or materialized view was created; no accounting jargon appears in a merchant-facing string; every screen works at phone width; every API used is one a later Android client could call.

---

## 10. P3-S8 — Security, failure injection, reconciliation, concurrency, performance

**Delivers.** The full adversarial pass: the premortem scenarios of `docs/PHASE_3_PREMORTEM.md` as executable tests, the inventory↔GL reconciliation of P3-AL-43, a rebuild rehearsal at scale, the runtime grant matrix for every Phase 3 table, and the extension of guards G-4/G-5/no-float/no-authoritative-balance to the Phase 3 surface.

**Must prove.** Every premortem scenario has a test that fails when its invariant is removed — PM-44 to PM-46 included, re-run against every operation kind registered by P3-S1…S6. No Phase 3 routine that mutates inventory, purchase or supplier truth runs without consuming or re-verifying an `invctl/1` assertion, discovered from the catalogue rather than listed. Every registered operation kind has exactly one consuming routine, and none is generic. Reconciliation is exact with zero tolerance. No runtime principal holds DML on any Phase 3 truth table. No Phase 3 routine violates the SECURITY DEFINER law (safe `search_path`, `pg_temp` explicit and last, PUBLIC EXECUTE revoked, `NOLOGIN` owner, no temporary relation). Runtime `TEMP` and runtime `CREATE` on `public` both remain zero.

---

## 11. P3-S9 — Release closure

Zero migrations. Release evidence, archive, deployment rehearsal as the deployment principal with `SUPERUSER = FALSE` and `BYPASSRLS = FALSE`, on the P2-S9 pattern.

---

## 12. Managed PostgreSQL contract (every slice that ships a migration)

Each slice proves, as the **deployment principal** `daftar_migrator` and not as a superuser:

- fresh database `0000 → <slice head>`;
- upgrade from the previous accepted head to the slice head;
- rerun is a no-op;
- the resulting catalogue is equivalent to a superuser build (`check:deployment-authority`, the matrix P2-S9 established);
- from P3-S1 onward, every ownership transfer to `daftar_inventory_internal` is bracketed by `GRANT`/`REVOKE CREATE ON SCHEMA public` in the same file, and any replacement of a function it already owns runs under `SET LOCAL ROLE daftar_inventory_internal`, never by giving the migrator `INHERIT TRUE` (P3-AL-54 §J).

The migration principal is **never widened** to make a migration apply. A missing extension or a missing privilege is answered in bootstrap by the deployment administrator.

---

## 13. CI

Every predecessor gate is kept and none is removed: `gate:phase1`, `gate:phase1:release`, `gate:phase2:s1` … `gate:phase2:s8`, `gate:phase2:release`. Each Phase 3 slice adds its own gate, which **composes** its predecessors. Every push remains independently reviewable, and the five required jobs — `workspaces`, `backend`, `web-admin`, `android`, `hygiene` — stay required.

`gate:phase3:s<n>` fails when: the slice's migrations are missing; a migration beyond the slice's boundary exists; the slice's candidates were frozen prematurely; any of `0000`–`0052` changed; a required table, registry entry or command is missing; a runtime principal holds DML on a Phase 3 truth table; a required physical refusal is absent; or any predecessor regression fails.

---

## 14. Full regression before any handoff

```
npm ci
npm run check:migrations
npm run check:guards
npm run check:localization
npm run format
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:golden
npm run build
npm run gate:phase1
npm run gate:phase2:s1 … s8
npm run gate:phase2:release
npm run gate:phase3:s1 … <current slice>
```

No `RELEASE_GATE_SKIP_*`. No mandatory skip. Generated release evidence is never edited to make a documentation check pass; if a consistency rule needs an authorized Phase 3 evolution, it is updated truthfully instead of weakened.

---

## 15. GitHub

Push only `phase/3-inventory-purchases-suppliers`. One **Draft** PR into `main`, kept draft for the whole phase so CI runs on every push. **PR #2 is closed Phase 2 history and is never reused or reopened.** Every slice waits for a workflow whose head SHA is exactly the slice's final commit; without an exact-SHA run there is no CI-success claim.

`main` has no branch protection and repository-settings writes are refused in this environment. That is recorded as `MAIN_PROTECTION_EXTERNAL_BLOCKER` (TD-08) and is never described as configured. It does not block Phase 3.

---

## 16. What Phase 3 does not build

Sales · POS · Customers · AR · Customer Payments · Installments · Orders · Storefront · Offline sync · Reservations · WhatsApp · AI · CRM · Lot, expiry and serial tracking · Repair workflows · GRNI · UoM conversion · a second money engine, FX authority, outbox, audit system or chart of accounts.
