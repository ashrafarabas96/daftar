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
| **P3-S1** | Inventory & catalog primitives | units registry, product inventory columns, base variant, `branch_warehouses`, Phase 3 permissions, TD-09 trigger, the transaction seam, `business_transaction_id` | `gate:phase3:s1` |
| **P3-S2** | Immutable stock ledger | `stock_movements`, `stock_levels`, `stock_movement_kinds`, deficit entities, `@daftar/inventory`, rebuild | `gate:phase3:s2` |
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
| P3-S2 | stock ledger + cache + movement-kind registry + deficit entities + their trusted commands |
| P3-S3 | transfer/adjustment/stocktake/initialization sources, their commands, and the two new accounting source types |
| P3-S4 | suppliers, purchases, purchase items, landed cost, receive command, `purchase` + `negative_inventory_cost_adjustment` source types |
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

1. **Units registry** — `units`, `unit_names`, seeded (P3-AL-05).
2. **Product inventory columns** — `track_inventory` (default `false`), `unit_code`, `unit_decimals`, with the CHECK that a tracked product must carry canonical units. **No backfill guess** from `products.unit` (P3-AL-04).
3. **Base variant** — `product_variants.is_base` with `UNIQUE (business_id, product_id) WHERE is_base`, and the enable-tracking command that creates one when a product has no variants (P3-AL-03).
4. **`branch_warehouses`**, seeded from `warehouses.branch_id`; `warehouses.branch_id` unchanged (P3-AL-15).
5. **Phase 3 permissions** — eleven keys in `packages/domain-core/src/permissions.ts`, seeded to the owner system role only, on the `0041` pattern, with the completeness assertion and the "no non-owner role gained one" assertion (P3-AL-38).
6. **TD-09** — the `BEFORE INSERT` future-date trigger on `journal_entries`, business timezone, stable `accounting.entry_date_in_future` (P3-AL-36).
7. **The transaction seam** — `withBusinessTransaction`, the assertion/scope coherence check, and the accounting ports' client-accepting variants (P3-AL-32). The existing single-operation methods keep their signatures and are re-implemented in terms of the new one.
8. **The authorization seam** — domain permission + warehouse scope resolution, as a typed helper used by every later command (P3-AL-33, P3-AL-39).
9. **`business_transaction_id`** generation at the API boundary (P3-AL-35).

**Must prove.**

- A future-dated raw `INSERT` into `journal_entries` **by the schema owner** is refused by the trigger, and the three posting commands still refuse it too — both halves, as P2-S8's raw-SQL matrix asserts today.
- The trigger resolves the **business's** timezone: an entry dated "tomorrow" in UTC but "today" in the business's zone is accepted, and the reverse is refused.
- A tracked product cannot exist without `unit_code` and `unit_decimals`.
- Enabling tracking on a product with no variants creates exactly one base variant, with NULL sku/barcode, and a second call is idempotent.
- No existing product became tracked, and no stock row exists, after the migration.
- Every existing warehouse is associated with exactly its previous branch; no business's authorization changed on migration day.
- An `assigned`-scope actor with no branch association reaches no warehouse.
- `withBusinessTransaction` refuses to open when the assertion's business does not equal the scope's business.
- Every accepted Phase 2 posting path still works unchanged through the re-implemented ports (the whole Phase 2 suite is the test).

---

## 4. P3-S2 — The immutable stock ledger

**Delivers.**

1. `stock_movements` — append-only by trigger, `stock_seq`, the five-part identity tuple, `qty_delta` / `unit_cost_base_minor` / `value_delta_base_minor` with their CHECKs (P3-AL-01, P3-AL-02, P3-AL-09, P3-AL-11).
2. `stock_levels` — one row per stock key, `last_stock_seq`, never deleted (P3-AL-06).
3. `stock_movement_kinds` — the closed registry with `qty_sign` and `requires_reason` (P3-AL-10).
4. `negative_inventory_deficits` and `negative_deficit_coverages` — tables and `deficit_seq` allocation, **no producer** (P3-AL-12, P3-AL-13).
5. `@daftar/inventory` — fixed-point `BigInt` arithmetic, the weighted-average formulas, the HALF_EVEN persistence boundary, the shared vectors (P3-AL-08).
6. The trusted `SECURITY DEFINER` movement primitive, owned by a `NOLOGIN` internal role, with `daftar_app` holding `SELECT` only.
7. The rebuild algorithm and its verification mode (P3-AL-42).

**Must prove.**

- `UPDATE` and `DELETE` on `stock_movements` are refused for every principal including the schema owner's ordinary DML path.
- No runtime role holds DML on either table — the live grant matrix, not the migration text.
- Two concurrent first-touches of the same stock key produce one row and two correctly ordered movements.
- Two opposite multi-key commands do not deadlock, with two real connections.
- The shared vectors produce byte-identical results in TypeScript and in SQL, including the HALF_EVEN tie cases that `round()` would get wrong.
- A rebuild of a key with hundreds of movements, including value-only ones, reproduces the cache exactly.
- A quantity movement with `qty_delta = 0` is refused; a value-only movement with a non-NULL unit cost is refused.

---

## 5. P3-S3 — Transfers, adjustments, damage, stocktake, initialization

**First slice that posts.** It therefore owns the two seams' first real use and the predecessor-assertion evolution.

**Delivers.**

1. Transfer command — the atomic movement pair, no journal entry, cross-business impossible (P3-AL-14).
2. Adjustment and damage commands — `Dr/Cr COGS(5000)` against Inventory (P3-AL-17).
3. Stocktake — capture with `expected_qty_at_capture` and `captured_at_stock_seq`, `draft → finalized | cancelled`, variance applied once, valuation at finalization, explicit unit cost required when there is none (P3-AL-16).
4. Inventory initialization — Case A posts `Dr Inventory / Cr Opening Equity`; Case B posts nothing and requires exact equality (P3-AL-18).
5. Registers `inventory_adjustment` and `inventory_opening` in `accounting_source_types`, each with its source table, completeness guard, deletion protection and binding (P3-AL-34).
6. **Evolves the two permanent predecessor assertions** named in the lock's F-4, in the smallest honest way, losing no evidence (P3-AL-34).

**Must prove.**

- Transfer: total business valuation delta is exactly zero; source average unchanged; destination average recomputed; GOLD-44's numbers reproduce.
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

**Delivers.** Suppliers with lifecycle and snapshots (P3-AL-40); purchases `draft → received | cancelled` with immutable received content (P3-AL-19); one line per variant (P3-AL-21); landed cost `by_value` / `manual` with largest-remainder distribution (P3-AL-22); the receive command posting `Dr Inventory / Cr AP` always (P3-AL-24); the purchase FX snapshot (P3-AL-25); deficit coverage inside the receipt transaction (P3-AL-13); live derived AP reads (P3-AL-26); registers `purchase` and `negative_inventory_cost_adjustment`.

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

**Delivers.** Supplier return at current average from the warehouse the goods leave, with the original purchase carrying value frozen and the difference to `6200` (P3-AL-29); AP first, excess to `1150` through a supplier credit note (P3-AL-30); purchase reversal under its four preconditions (P3-AL-20); registers `supplier_return` and `purchase_reversal`.

**Must prove.**

- Cumulative returned quantity may not exceed the purchased quantity of the line.
- A return that would drive the source key negative is refused.
- Returning from a warehouse other than the original destination succeeds when authorized, and is refused when not.
- A return whose value exceeds outstanding AP debits AP by exactly the outstanding amount and puts the excess on `1150` — never a negative AP, never revenue.
- Each of the four purchase-reversal preconditions refuses independently, with its own stable code.
- A purchase reversal removes exactly the value the receipt added, at the original receipt cost.

---

## 8. P3-S6 — Payment methods and supplier settlement

**Delivers.** The minimal shared `payment_methods` / `payment_method_names` foundation (P3-AL-27); supplier payments settling AP with partial support (P3-AL-28); allocations with the full tri-currency shape and realized FX to `4900`/`6900`; supplier credit allocations and refunds with the two-value locking rule (P3-AL-31); registers `supplier_payment`, `supplier_credit_allocation`, `supplier_refund`.

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

**Must prove.** Every premortem scenario has a test that fails when its invariant is removed. Reconciliation is exact with zero tolerance. No runtime principal holds DML on any Phase 3 truth table. No Phase 3 routine violates the SECURITY DEFINER law (safe `search_path`, `pg_temp` explicit and last, PUBLIC EXECUTE revoked, `NOLOGIN` owner, no temporary relation). Runtime `TEMP` and runtime `CREATE` on `public` both remain zero.

---

## 11. P3-S9 — Release closure

Zero migrations. Release evidence, archive, deployment rehearsal as the deployment principal with `SUPERUSER = FALSE` and `BYPASSRLS = FALSE`, on the P2-S9 pattern.

---

## 12. Managed PostgreSQL contract (every slice that ships a migration)

Each slice proves, as the **deployment principal** `daftar_migrator` and not as a superuser:

- fresh database `0000 → <slice head>`;
- upgrade from the previous accepted head to the slice head;
- rerun is a no-op;
- the resulting catalogue is equivalent to a superuser build (`check:deployment-authority`, the matrix P2-S9 established).

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
