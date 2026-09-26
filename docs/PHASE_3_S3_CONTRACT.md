# DAFTAR — P3-S3 Contract / عقد الشريحة P3-S3

> **Coordinator rulings on this contract (2026-09-26).** Adopted as the P3-S3 implementation contract. The Tech Lead notes of §9.2 are adopted as engineering rulings: TL-3 (cancel through `inventory.stocktake_finalize` with a signed `outcome`), TL-4 (reason bound as eight uint32 words of its SHA-256), TL-5 (no server retry on `inventory.valuation_changed`), TL-6 and TL-7 (the accounting-side refusals, which fire only on states that cannot exist before P3-S3), TL-8, TL-9, TL-10 (the additive typed refusal next to `NATIVE_SOURCE_TYPES`), TL-12 and TL-13. TL-1 and TL-2 are sequencing facts: every predecessor pin is evolved in the same commit as the migration that turns it red, and 0061 lands only after the P3-S2 freeze. **B-1** (superseding a posted opening) is a real blocker for that one transition only: P3-S3 ships the `superseded` state with the transition refused (`inventory.opening_state_invalid`), and the decision is carried to the Phase 3 final report. It is outside the plan's Delivers and Must-prove for P3-S3.
>
> **ملخص.** عقد تنفيذ الشريحة P3-S3: التحويلات والتسويات والتلف والجرد والرصيد الافتتاحي، وهي أول شريحة تُرحِّل قيودًا محاسبية عبر نواة المحاسبة القائمة. الانتقال الوحيد المعلَّق هو تصحيح رصيد افتتاحي مُرحَّل (B-1)، وهو مرفوض صراحةً حتى يُقرَّر.

> **Status.** This is the candidate contract for P3-S3. It was written by the S3 contract agent against branch `phase/3-inventory-purchases-suppliers` at tip `ac1382f`. It is analysis only: no repository file was changed.
>
> **Sources, in order of authority:**
> 1. Code and migrations `0000`–`0060`.
> 2. Tests.
> 3. `docs/PHASE_3_ARCHITECTURE_LOCK.md`. The lock wins over every other document.
> 4. `docs/PHASE_3_EXECUTION_PLAN.md`, §5 and §12–§14.
> 5. `PREMORTEM`, `SLICE_MAP`, `S1_ACCEPTANCE`, `TECHNICAL_DEBT.md` and `OPEN_DECISIONS`.
>
> **Shape.** It mirrors `docs/PHASE_3_S2_CONTRACT.md` (S2C):
> - §0 conventions
> - §1 rulings
> - §2 database contract
> - §3 error model
> - §4 packages
> - §5 harness
> - §6 test plan
> - §7 gate, guards and predecessor evolution
> - §8 file ownership
> - §9 Tech Lead notes and **real blockers**

---

## 0. Conventions

- **Citations.** `file:line` means a path relative to the repository root. The short prefixes are:

  | Prefix | Document |
  |---|---|
  | `L:` | `docs/PHASE_3_ARCHITECTURE_LOCK.md` |
  | `P:` | `docs/PHASE_3_EXECUTION_PLAN.md` |
  | `SM:` | `docs/PHASE_3_SLICE_MAP.md` |
  | `S2C:` | `docs/PHASE_3_S2_CONTRACT.md` |
  | `PM-nn` | `docs/PHASE_3_PREMORTEM.md` |
  | `TD-nn` | `TECHNICAL_DEBT.md` |

- **Ruling classes.**
  - **ENG** is an engineering ruling. It is taken here, with its justification, and binds the implementers.
  - **ENG+TL** is an engineering ruling that the Tech Lead should confirm (§9.2). Implementers follow it until the Tech Lead overrules it.
  - **BLOCKER** is used only for a product-constitution ambiguity, a legal or tax rule, a paid provider, a destructive data decision, an external credential, or an architectural contradiction (§9.1).
- **SQL refusals.** Every refusal is raised as `RAISE EXCEPTION '<domain>.<code>: <safe text>' USING ERRCODE = 'P0001'`, the 0059/0060 convention. The application maps the prefix and nothing else: `apps/api/src/modules/inventory/inventory-errors.ts:23-77` for inventory, and the accounting adapter's `refusedAs` at `apps/api/src/modules/accounting/accounting-posting.adapter.ts:94-109` for accounting.
- **The definer contract (P3-AL-54 §D, L:1685-1695; G-7 `scripts/guards/inventory-definer-contract.ts`).** Every new internal routine:
  - is `SECURITY DEFINER` with `SET search_path = pg_catalog, public, pg_temp`;
  - has `REVOKE ALL … FROM PUBLIC` in the same file;
  - contains no `EXECUTE` (dynamic SQL) in its body;
  - is handed over inside a `GRANT CREATE ON SCHEMA public TO <internal>` / `REVOKE CREATE …` bracket in the same file, using `ALTER … OWNER TO` or a `SET LOCAL ROLE <internal>` window.

  The ACL order is the S2 order, `REVOKE PUBLIC → CREATE TRIGGER → ALTER OWNER`, all inside the bracket (S2C §0). This applies to `daftar_accounting_internal` exactly as it does to `daftar_inventory_internal`. The accounting precedents are `0040:263-471` and `0058:40-71`.
- **The migration principal is never widened (P:285).** Nothing in S3 gives `daftar_migrator` `INHERIT`, `BYPASSRLS`, `SUPERUSER` or a new role membership. A function an internal role already owns is replaced under `SET LOCAL ROLE <owner>` (`0040:411-466`, `0060:774-936`).
- **Frozen history.** The files `0000`–`0060` are never edited. P3-S2 is accepted, and 0059–0060 are frozen in the manifest, **before** 0061 lands (§7.3, TL-2).
- **RLS shape.** Every new table has `ENABLE` + `FORCE` row-level security. Its policies are the UUID-style policies of 0052 and exactly the layering of `stock_movements` (`0059:311-359`):
  - a tenant policy through the `businesses` subquery;
  - an identity read policy for `daftar_app`;
  - a restrictive admission policy for `daftar_inventory_internal`.
- **Quantities and money.** A quantity is `NUMERIC(18,4)`, a cost `NUMERIC(28,10)`, a value `BIGINT` minor. There is no `FLOAT`, and a money column is never `NUMERIC(p,s)`, which is guard rule 6. No table is ever aliased `stock`, which is rule 7.
- **Rule 21 (inventory arithmetic).** No `round(`, no `scale(`, no `on_hand * avg`, no ordering of movements by `created_at`, and no `40P01`. HALF_EVEN is always `inventory_half_even` (0060 R1).

---

## 1. Rulings

### A-01 · Slice scope and object inventory (ENG)

S3 builds exactly what P:173-199 and L:1904-1930 name, and nothing else.

| Kind | Objects |
|---|---|
| Operation kinds (seven, `registered_by = 'P3-S3'`) | `inventory.transfer`, `inventory.adjust`, `inventory.damage`, `inventory.stocktake_open`, `inventory.stocktake_count`, `inventory.stocktake_finalize`, `inventory.opening` (L:1912-1922, P:175) |
| Stock source types (four) | `inventory_transfer`, `inventory_adjustment`, `stocktake`, `inventory_opening` (P:185, L:1424-1433) |
| Accounting source types (two) | `inventory_adjustment`, `inventory_opening` (L:1040-1041) |
| Source documents | transfers, adjustments/damages, stocktakes, openings (§2.2) |
| Commands | seven entry routines, one per operation kind (L:1926) |
| Owned side work | P3-AL-41 archival (L:1202-1210, index "P3-S3"); TD-13 (SM:71); the F-4 evolution and every other predecessor pin §7.3 lists (P:187, L:1060) |

**Out of scope.**
- Merchant reads and screens belong to S7 (P:253-259). S3 exposes no `GET` endpoint. Tests read the database directly.
- Supersession of an inventory opening is **BLOCKER B-1** (§9.1). S3 creates the `superseded` state but no path into it.
- Reconciliation jobs belong to S8 (L:1240-1255).
- Purchases, suppliers and deficit coverage belong to S4.

### A-02 · Migration plan: two migrations, 0061 then 0062 (ENG)

The next number is **0061**, since `ls infrastructure/database/migrations | tail` ends at `0060_inventory_stock_primitive.sql`. P:30-49 fixes no count.

| # | File | Content, in file order |
|---|---|---|
| 1 | `0061_inventory_movement_sources.sql` | §1 TD-13, both replacements (A-17). §2 strengthened `inventory_stock_source_guard_gaps()` (A-16), **before** any registration. §3 source documents and lines (A-04). §4 four bridges and the stock-side trigger set (A-15). §5 stock-source registration: four `stock_source_types` rows. §6 accounting side (A-14): two `accounting_source_types` rows, two `accounting_operation_kinds` rows, the journal completeness triggers, the opening-balance guard, the reversal guard and the opening-position read function. §7 P3-AL-41 archival triggers (A-19). §8 RLS, grants, owners and the CREATE brackets. §9 end state `0061-E` (§2.9). |
| 2 | `0062_inventory_movement_commands.sql` | §1 pure helpers (A-09, A-13). §2 the seven entry routines (A-06…A-13). §3 registration of the seven `inventory_operation_kinds` rows and the six op→movement mappings (A-03), in the same file as the routines, because a registry row exists only when its routine exists (L:1908). §4 `REVOKE`, `GRANT EXECUTE … TO daftar_app` on exactly the seven entry routines, owners and brackets. §5 end state `0062-E`. |

**Why two files.**
- 0061 is pure structure plus accepted-function replacement. Its end state proves the source registries cannot outrun their guards (L:1528-1530), and nothing yet can reach them. The op-kind table stays at the three S1 rows, and the mapping table stays empty.
- 0062 adds the only runtime reach. A reviewer can read "who can execute what" in one file.
- One file would pass the gate equally well; two keep each end-state block small enough to review.

**Why TD-13 sits in 0061 and not in a third file.** P:30-49 forbids splitting for arithmetic. TD-13 has no dependency on the S3 schema, and it runs first so a failure there aborts before any S3 object exists.

### A-03 · Operation → movement-kind mappings (ENG)

The table is `inventory_operation_movement_kinds` (`0059:66-72`), which is empty after S2 (0060-E(6) at `0060:1041`). 0062 inserts exactly these rows, all with `registered_by = 'P3-S3'`:

| op_code | movement_kind(s) | Why |
|---|---|---|
| `inventory.transfer` | `transfer_out`, `transfer_in` | L:524-535 |
| `inventory.adjust` | `adjustment` | L:680-684. `adjustment` is `either` and requires a reason (`0059:80`) |
| `inventory.damage` | `damage` | `negative`, requires a reason (`0059:81`) |
| `inventory.stocktake_finalize` | `stocktake` | L:666; `either` (`0059:84`) |
| `inventory.opening` | `inventory_opening` | L:695-725; `positive` (`0059:85`) |
| `inventory.stocktake_open`, `inventory.stocktake_count` | **none** | They move no stock. The primitive's `inventory_assertion_current(ARRAY(SELECT DISTINCT op_code FROM inventory_operation_movement_kinds …))` at `0060:186` therefore refuses them by construction (L:1990-1992) |

That makes seven rows (2+1+1+1+1+1 = 7) for five producing kinds. 0062-E asserts the exact set. It also proves least authority from the catalogue: the pair `(inventory.adjust, transfer_in)` does not exist (L:1992).

### A-04 · Source documents and their state machines (ENG)

`source_id` is always the document id and `source_line_id` is always a real line id (L:402-404, L:1449-1490).

| Document | Header / lines | States | Transitions |
|---|---|---|---|
| Transfer | `inventory_transfers` / `inventory_transfer_lines` | none: a transfer is created **complete** in one command | none. Header and lines are immutable after insert |
| Adjustment and damage | `inventory_adjustments` (`kind ∈ {adjustment, damage}`) / `inventory_adjustment_lines` | none: created complete | none |
| Stocktake | `stocktakes` / `stocktake_lines` | `draft`, `finalized`, `cancelled` | `draft → finalized` and `draft → cancelled` only (L:672). Terminal states are immutable. There is no reopen |
| Opening | `inventory_openings` / `inventory_opening_lines` | `posted`, `superseded` | S3 writes only `posted`. `posted → superseded` is refused by trigger with `inventory.opening_state_invalid` until B-1 is resolved; the state exists so the resolution needs no `ALTER TABLE` |

**Justification.**
- The lock describes transfers, adjustments and openings as single atomic commands (L:520-541, L:676-691, L:695-725). A draft that a later command posts would add an operation kind that L:1912-1922 does not register.
- The stocktake is the only document with a human interval (L:651-672), so it is the only one with a draft.

### A-05 · Accounting source mapping and journal shapes (ENG)

The lock registers two accounting sources and no third (L:1040-1041). The mapping is:

| Command | Accounting `source_type` | `source_id` | Entry, when the net value V ≠ 0 |
|---|---|---|---|
| adjustment | `inventory_adjustment` | `inventory_adjustments.id` | V > 0: `Dr inventory(1200) V` / `Cr cogs(5000) V`. V < 0: `Dr cogs \|V\|` / `Cr inventory \|V\|` (L:680-684) |
| damage | `inventory_adjustment` | `inventory_adjustments.id` | V < 0 always: `Dr cogs` / `Cr inventory` |
| stocktake finalization | `inventory_adjustment` | `stocktakes.id` | as for an adjustment (L:676-684) |
| opening, Case A | `inventory_opening` | `inventory_openings.id` | one `Dr inventory` line per warehouse (that warehouse's Σ line values, only when > 0) / `Cr opening_equity(3000)` Σ (L:701-708) |
| opening, Case B | none | none | **no journal entry** (L:720-722) |
| transfer | none | none | **no journal entry** (L:537) |

- **V** is Σ `value_delta_base_minor` over the document's movements. The journal's inventory amount **is** that integer (L:1344-1356, equation (3)). When V = 0 there is no entry, because a journal amount must be greater than 0 (`0042:221-225`).
- System accounts are referenced by `{kind:'system', systemKey:…}`: `inventory` at `0040:53`, `opening_equity` at `0040:58`, `cogs` at `0040:63`.
- `rounding` 6100 and `purchase_price_variance` 6200 never appear (L:688, L:1358). A test asserts they are absent (T-06).
- An entry carries exactly two lines for adjustments and stocktakes, or N+1 lines for an opening across N warehouses.

**Why stocktake uses `inventory_adjustment`.** A stocktake variance is "inventory loss/gain" in the lock's own table (L:680-684). Registering a third accounting source (`stocktake`) would contradict "Phase 3 registers exactly …" (L:1038-1052). The id collision this sharing could cause is closed by A-10(e).

### A-06 · The posting route: the generic primitive, no new journal writer (ENG)

- **The primitive.** Every S3 journal entry is written by the accepted generic primitive `accounting_post_entry` (`0045:489-790`). It is reached through `AccountingPostingTransactionPort.postEntryInTransaction` (`packages/accounting/src/ports.ts:277-279`, adapter `accounting-posting.adapter.ts:58-88`) on the `accounting` handle of `withBusinessInventoryAccountingTransaction` (`apps/api/src/infra/database.ts:466-483`). This satisfies L:1003 ("no new journal writer"): G-4 discovers writers from the schema text (`scripts/guards/posting-surface.ts:66-68`), and S3 adds none.
- **Why the generic primitive accepts an S3 source safely.** `accounting_post_entry` accepts any registered source whose signed assertion has operation `post` (`0045:707-796`). Forgery is closed the way 0046 closed it for native sources (`0046:311-327`): by a deferred completeness trigger on `journal_entries` per new source (A-14(a)). An entry of source `inventory_adjustment` cannot commit without its inventory header, and vice versa.
- **Minting the accounting assertion (P3-AL-33, L:1026).** A new framework-free module, `packages/accounting/src/domain-posting.ts`, exports:

  ```ts
  mintDomainPostingAssertion(minter: AccountingAssertionMinter, command: PostingCommand, actorUserId: string): string
  ```

  - It refuses `NATIVE_SOURCE_TYPES` (`post.ts:191`).
  - It runs `validatePostingCommand` (`post.ts:96`) and `computeCommandFingerprint` (`post.ts:75`).
  - It mints `operationKind: 'post'` with the command's source identity.
  - It does **not** run `validateBranchScope` (`post.ts:147-160`). The domain authority is the warehouse scope of P3-AL-39 (L:1178-1187), already checked and bound in the inventory assertion. Merchant accounting branch scope governs merchant-authored entries, and these are not merchant-authored (L:1024).
  - It has no flag, no boolean and no "trusted" parameter (L:1030).
  - It is reachable only from the inventory services (§8 ownership). G-4 and the completeness triggers remain the physical guarantee.
- **Line construction.** Posting lines are built from the server's pre-computed values (A-07), never from request input.
  - `baseCurrency = txnCurrency =` the business base currency, with `fxRate '1'` and `fxRateSource 'base'`. This is the domestic shape of `0042:233-250`.
  - `fxRateAt =` the UTC instant `<occurred_on>T00:00:00Z`. It is derived from the command's date, not from a clock.
  - Inventory and COGS lines carry `warehouseId` = the document warehouse and `branchId` = that warehouse's **home** branch (`warehouses.branch_id`, immutable by L:595-596). The equity line of an opening carries NULL branch and NULL warehouse.
  - `description = null`, `memo = null`, and `requestId` = the business transaction id (P3-AL-35).
- **No server clock in a fingerprint.** `acctfp/1` covers the entry date and the lines (`packages/accounting/src/fingerprint.ts:195-218`).
  - `entryDate` is the request's required `occurredOn`. There is **no default to "today"**: that would be a server-clock read inside the fingerprint.
  - `fxRateAt` is derived from `occurredOn`.
  - The not-after-today rule is the database's, in the business timezone (`0058`, `accounting_source_types.upper_bound_policy`).
- **Defence in depth in TypeScript (ENG+TL, TL-10).** `AccountingEngine.post` gains a refusal for `DOMAIN_SOURCE_TYPES = ['inventory_adjustment','inventory_opening']` with `accounting.assertion_wrong_source`. This is an additive edit next to `post.ts:218`: a merchant `accounting.post` call cannot even attempt one. The database trigger stays the invariant.

### A-07 · Posted amounts are pre-computed and bound; `inventory.valuation_changed` (ENG+TL, TL-5)

**The problem.** Seam 2 takes the accounting assertion **when it opens** (`database.ts:466-483`, L:994). The assertion signs `acctfp/1` over the lines, including the inventory amount. That amount is decided by the primitive under the stock-key lock (outbound HALF_EVEN of qty × average, or the flush; `0060:376-393`). So the application must know the amount **before** the transaction opens.

**The ruling: an optimistic, bound valuation.**
1. After authorization and the idempotency check (A-10), the service reads the current `stock_levels` rows of the affected keys through `daftar_app` `SELECT` under RLS (`0059:372`).
2. It computes each line's value with `@daftar/inventory` `simulateMovement` / `outboundValue` / `inboundValue` (`packages/inventory/src/valuation.ts:95-176`). These are the same arithmetic as the SQL, proven by the shared `invval/1` vectors (P3-S2).
3. Each line's `expected_value` is a field of the `invpl/1` payload (A-09). V (Σ expected) builds the posting lines, and the accounting assertion is minted over them.
4. Inside the routine, the stored value of every movement the primitive returns (`0060:133-147`, column `value_delta_base_minor`) is compared with the bound `expected_value`. Any difference raises `inventory.valuation_changed` and the whole transaction rolls back, taking with it the inventory-assertion use (L:2004).
5. Commit-time triggers then prove equation (3) physically:
   - Σ movement values = header total (inventory side, A-15(f));
   - header total = the entry's net inventory amount (accounting side, A-14(a)).

   A defect in step 4 therefore still cannot commit a mismatch.

**No server retry.** `inventory.valuation_changed` is a 409 that the client may resubmit with the **same** document id, because nothing was committed. S3 does not loop, following PM-03's warning against retries that hide defects. The race only happens when another command commits on the same key between the read and the lock. An outbound movement leaves the average unchanged except on a flush, so two concurrent outbounds usually both succeed.

### A-08 · Choosing the seam: typed, by the computed total (ENG)

| Command | Seam | Accounting assertion |
|---|---|---|
| transfer | `withBusinessInventoryTransaction` (seam 1) | **none minted** (L:1033, P:193) |
| adjust / damage / stocktake finalize with expected V ≠ 0; opening Case A with total > 0 | `withBusinessInventoryAccountingTransaction` (seam 2) | minted over the posting (L:1022-1026) |
| the same commands with expected V = 0; opening Case B; stocktake open, count and cancel | seam 1 | none. No posting is implied, and an assertion is never minted to satisfy a boundary (L:1026) |

The seam is chosen from the server-computed V, never from a request field or flag (L:990-991). If a concurrent change would make the real V differ, A-07 refuses. So a seam-1 command can never owe a posting, and a seam-2 command can never have nothing to post. Replay inside the routine (A-10(d)) is the one case where a seam-2 transaction commits no entry. Its accounting assertion then expires unused, and that is recorded as a test (T-11.4).

### A-09 · `invpl/1` field lists for the seven kinds (ENG, fields of type integer only; TL-4 for the reason)

**Encoding rules.**
- The grammar is locked at four types: `uuid`, `boolean`, `integer`, `code`. NULL is encoded `0x00` (`0054:200-209`, L:1945-1954). S3 introduces **no new type**. Every non-integer quantity is carried as its exact fixed-point integer:
  - **Q4:** a quantity × 10⁴ as a base-10 integer. The routine refuses a value that is not exact at 4 places (with `inventory.quantity_precision_invalid`) before hashing.
  - **C10:** a cost × 10¹⁰ as an integer.
  - **Value:** a signed `BIGINT` minor amount.
  - **Date:** the integer `YYYYMMDD`.
  - **Reason:** the SHA-256 of the exact UTF-8 bytes of the stored reason, as **eight unsigned 32-bit big-endian words** (w1…w8), each a base-10 integer. This binds the free-text reason under the locked grammar (TL-4).
- A variable number of lines is framed by a `line_count` integer that precedes the repeating group. Every group has a fixed width, so the stream is unambiguous.
- Line order is canonical:
  - transfer, adjustment, damage and opening lines in `line_no` order (1..n, the request order);
  - stocktake lines in ascending `variant_id` order.

**Field lists.**

| op_code | Fields, in order |
|---|---|
| `inventory.transfer` | `transfer_id` uuid · `source_warehouse_id` uuid · `destination_warehouse_id` uuid · `line_count` int · per line: `variant_id` uuid, `qty_q4` int (> 0) |
| `inventory.adjust` | `adjustment_id` uuid · `warehouse_id` uuid · `occurred_on` int · `reason_w1..w8` int×8 · `line_count` int · per line: `variant_id` uuid, `qty_delta_q4` int (≠ 0, signed), `unit_cost_c10` int or NULL (non-NULL **iff** qty > 0), `expected_value` int (signed) |
| `inventory.damage` | `adjustment_id` uuid · `warehouse_id` uuid · `occurred_on` int · `reason_w1..w8` int×8 · `line_count` int · per line: `variant_id` uuid, `qty_q4` int (> 0; the magnitude written off), `expected_value` int (≤ 0) |
| `inventory.stocktake_open` | `stocktake_id` uuid · `warehouse_id` uuid |
| `inventory.stocktake_count` | `stocktake_id` uuid · `warehouse_id` uuid · `line_count` int · per line (variant order): `variant_id` uuid, `counted_q4` int (≥ 0) |
| `inventory.stocktake_finalize` | `stocktake_id` uuid · `warehouse_id` uuid · `outcome` code (`finalized` or `cancelled`) · `occurred_on` int or NULL (NULL iff cancelled) · `line_count` int (0 iff cancelled) · per line (variant order, **every** line of the stocktake): `variant_id` uuid, `variance_q4` int (as stored), `unit_cost_c10` int or NULL, `expected_value` int |
| `inventory.opening` | `opening_id` uuid · `occurred_on` int · `opening_balance_id` uuid or NULL · `position_minor` int or NULL (both NULL = Case A) · `line_count` int · per line: `warehouse_id` uuid, `variant_id` uuid, `qty_q4` int (> 0), `unit_cost_c10` int (≥ 0) |

**What this binds (L:1962-1964, L:1186).** Every warehouse whose scope was checked is a field: a transfer binds both, and an opening binds each line's warehouse. So are every line's variant, warehouse (by the header or by the line) and quantity. Every financial input is bound too: cost, expected value and date. The stocktake finalize binds the exact line set it saw. If a count is recorded after the service's read, the stored set differs, and the routine refuses with `inventory.stocktake_changed` (409, retryable).

**The SQL side.** Each routine builds its `types[]`/`values[]` from **its own arguments** and passes them to `inventory_claimed_payload_digest` (`0054:285-314`) as the argument of its first statement, `inventory_assertion_consume` (the pattern of `0060:809-816`). The fixed-point text uses one new pure helper, `inventory_fixed_text(p NUMERIC, p_scale INTEGER) RETURNS TEXT`, which raises when `p × 10^scale` is not an integer. The reason words use `inventory_reason_words(p_reason TEXT) RETURNS TEXT[]`. Both are definer, pinned, PUBLIC revoked, internal-owned and contain no `EXECUTE`, like R1/R2 (`0060:83-131`).

### A-10 · Idempotency: prove the replayed command before reading any state (ENG)

**(a) Identity.** The client supplies the document id (`transferId`, `adjustmentId`, `stocktakeId`, `openingId`) as a canonical UUID. It is the idempotency key and the stock `source_id`, and for posting documents also the accounting `source_id`. Stocktake count and finalize are keyed by the stocktake id and by their own intent digest (below).

**(b) Intent digest.** `intent_sha256` is the `invpl/1` digest (same encoder, same op code, tenant and business) of the **client-intent fields only**. That is the A-09 list without the server-derived fields: `expected_value`, `opening_balance_id`, `position_minor`, `variance_q4`. It contains no clock value. The header stores it in `intent_sha256 TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$')`, and stocktakes also store `finalize_intent_sha256`. In SQL it is `inventory_payload_digest(op, tenant, business, types[], values[])` (`0054:214-262`). It is never used as an assertion digest.

**(c) Application order (extends L:2013-2021).**
1. authentication
2. membership
3. permission
4. scope over every affected warehouse
5. DTO validation and variant resolution (A-23)
6. **the idempotency proof**: compute `intent_sha256`, then `SELECT` the header by `(business_id, id)` through `daftar_app` under RLS:
   - **Found with an equal digest:** return the stored result (A-10(f)) with `replayed: true`. There is no stock read, no mint and no seam.
   - **Found with a different digest:** refuse with `inventory.idempotency_conflict` (409).
   - **Not found:** continue.
7. only now read stock state (A-07)
8. mint the inventory assertion, and the accounting assertion if one is implied
9. open the seam
10. call the routine
11. post if needed
12. commit

The proof is consulted **before** any current-state read, so a replay succeeds even when the same command would now be refused on its merits (for example because stock has since fallen). T-11.2 tests exactly that.

**(d) Database order inside every entry routine.**
1. First statement: consume.
2. `INSERT` the header `ON CONFLICT (business_id, id) DO NOTHING`.
   - If no row was inserted, compare the stored `intent_sha256` with the one recomputed from the routine's own arguments.
   - Equal: return the stored result with `replayed = true`, writing nothing else.
   - Different: raise `inventory.idempotency_conflict`.
3. Only then read warehouses, variants and stock.

A concurrent identical request waits on the unique index, then sees the committed header and replays. The service skips posting when `replayed` is true.

**(e) Accounting-id collision.** Adjustments and stocktakes share the accounting source `inventory_adjustment`. Both routines therefore refuse an id already present in the **other** table (`inventory.document_id_conflict`, 409). The accounting completeness trigger (A-14(a)) requires **exactly one** matching header across the two tables. `journal_entries UNIQUE (business_id, source_type, source_id)` (`0042:129-160`) closes any remaining race.

**(f) The stored result.** A replay answers from stored rows only:
- the header and lines;
- the movements joined through the bridge (`stock_seq`, `value_delta_base_minor`);
- the journal entry id, through `accounting_source_bindings`.

It never recomputes a value (L:1370).

**(g) Stocktake.**
- **Open** is keyed by the stocktake id.
- **Count** is an idempotent upsert per `(stocktake_id, variant_id)`. Recording the same counted quantity again leaves the existing capture untouched and reports `changed: false`. A different counted quantity re-captures (A-11).
- **Finalize.** A second finalize whose `finalize_intent_sha256` equals the stored one returns the stored result (L:672, P:196). A different one refuses with `inventory.stocktake_state_invalid`.

### A-11 · Stocktake semantics (ENG; the cancel reading is ENG+TL, TL-3)

- **Open.**
  - The warehouse must belong to the business and be active.
  - At most one draft per warehouse: `UNIQUE (business_id, warehouse_id) WHERE status = 'draft'`, refused with `inventory.stocktake_already_open`. Two open drafts counting one key would apply the same physical correction twice. The lock's snapshot-delta (L:655-666) is only correct for a single applier.
- **Count (capture).**
  - For each line, the routine reads `stock_levels.on_hand` and `last_stock_seq` for the key in **one** statement (no lock, following L:655). A key with no row counts as `0` and `0`.
  - It writes `expected_qty_at_capture`, `captured_at_stock_seq` and `counted_qty`. `variance_qty` is a `GENERATED ALWAYS AS (counted_qty - expected_qty_at_capture) STORED` column (L:661).
  - A recount of a line replaces all three atomically. The capture belongs to the count it measured.
  - The variant must be tracked and active, with an existing, active product.
- **Finalize (`outcome = finalized`).**
  1. First statement: consume.
  2. The idempotency proof (A-10(g)).
  3. The stocktake must be `draft` and non-empty (`inventory.stocktake_empty`).
  4. The bound line set must equal the stored line set, both variants and variances (`inventory.stocktake_changed`).
  5. **Pre-lock**, in the primitive's own order: products `FOR SHARE` in id order, then stock keys `FOR UPDATE` in `(warehouse_id, variant_id)` order (`0060:270-310`, PM-03). Pre-locking is needed because a positive variance is valued at the **current** average (L:664), which must be read under the lock.
  6. For each line with variance ≠ 0:
     - **Negative:** an outbound request. The primitive values it and refuses with `inventory.insufficient_stock` when the variance exceeds on_hand (`0060:376-393`, L:463).
     - **Positive, key has an average:** an inbound request with `unit_cost_base_minor` = the average read under the lock. A supplied explicit cost is refused with `inventory.unit_cost_not_applicable`.
     - **Positive, no average** (`avg_unit_cost_base_minor IS NULL`, meaning the key never held valued stock; L:1381 keeps the last average at zero): the bound explicit cost is required, else `inventory.unit_cost_required`. A zero is never invented; an explicit merchant-stated zero is the audited statement L:666 asks for. The cost is stored on the line (`stocktake_lines.unit_cost_base_minor`) and audited.
  7. `UPDATE` every line's `applied_value_base_minor`; zero-variance lines keep NULL. This fires the line-side completeness trigger.
  8. Call the primitive, compare against the bound values (A-07), and insert the bridge rows.
  9. `UPDATE` the header: `status = 'finalized'`, `occurred_on`, `total_value_base_minor`, `binding_source_id` (= id iff V ≠ 0), `finalized_at`, `closed_by`.
  10. Write the audit and outbox rows.
- **Cancel (`outcome = cancelled`)** is performed by the same `inventory.stocktake_finalize` routine. The draft moves to `cancelled` and nothing else changes.
  - L:672 locks `draft → cancelled`, and L:1912-1922 registers **no** cancel operation kind. "Registers exactly its own operation kinds" (P:175) forbids adding an eighth.
  - Cancel is the other terminal decision of the same command, "close the count". It needs the same permission and the same warehouse scope, and its outcome is a signed payload field, so an assertion minted for `finalized` cannot cancel.
  - It uses exactly one operation kind in exactly one routine, which satisfies L:1926.
- **Terminal immutability.** `stocktakes_freeze` and `stocktake_lines_freeze` refuse every `UPDATE`/`DELETE` of a non-draft stocktake or its lines. The line fields they cover are `counted_qty`, `expected_qty_at_capture`, `captured_at_stock_seq`, `variant_id`, `unit_cost_base_minor` and `applied_value_base_minor`. The refusals are `inventory.source_line_frozen` for lines and `inventory.stocktake_state_invalid` for the header (L:672, L:1546-1548).

### A-12 · Adjustment and damage semantics (ENG)

- **Document scope.** A document has one warehouse and 1…200 lines (A-24). No variant may repeat within a document: `UNIQUE (business_id, adjustment_id, variant_id)`, refused with `inventory.duplicate_line` (PM-09). The reason is required at document level, 1..500 characters (the primitive's rule at `0060:195-206`), and copied to every movement's `reason`. The reason's digest words are bound (A-09).
- **Adjustment, qty < 0.** An outbound request, valued by the primitive (HALF_EVEN of qty × average, or the flush). `inventory.insufficient_stock` when it exceeds on_hand (L:463).
- **Adjustment, qty > 0.** An inbound request with an **explicit** unit cost, as the accepted S2 vector `AL08-ADJ-POS` states (cost `110.5` on an average of `100`, in `packages/inventory/vectors/valuation-vectors.json`). The value is `HALF_EVEN(qty × cost)` (`0060:394-414`). A missing cost is refused with `inventory.unit_cost_required`.
- **Damage.** Each line states a positive magnitude. The routine writes `qty_delta = −qty` with kind `damage` (negative, reason required; `0059:81`).
- **Journal.** See A-05. The entry's inventory line is the **net** V of the document (L:1352), so gains and losses in one document net to one pair of lines.

### A-13 · Opening semantics: Case A and Case B (ENG; the accounting guard is ENG+TL, TL-6)

- **One document spans every warehouse it names (L:714).** Each line carries `warehouse_id`, `variant_id`, `qty > 0` and `unit_cost ≥ 0`, and `(warehouse_id, variant_id)` is unique per document. The scope check covers the set of warehouses (L:1182-1186). There is **at most one posted opening per business**: `CREATE UNIQUE INDEX inventory_openings_posted_uq ON inventory_openings (business_id) WHERE status = 'posted'` (L:724), refused with `inventory.opening_already_posted`.
- **Valuation (L:1382, L:715).**
  - The weight of each line is `w_i = qty_i × cost_i`, exact, never rounded.
  - The document total is `T = inventory_half_even(Σ w_i, 1, 0)`.
  - Shares are allocated by **largest remainder** with the tie-break `line_no ASC`, the allocator L:785 names: `s_i = floor(T·w_i/W)`, then the residue `T − Σ s_i` goes one unit at a time to the largest fractional parts.
  - When W = 0, every share is 0.
  - Σ s_i = T exactly. Each movement is an inbound `inventory_opening` request carrying its unit cost and **supplied value** `s_i`, which the primitive allows for `inventory_opening` only (`0060:399-400`).
  - The allocator is new, with a TypeScript twin and shared vectors (A-09, §4).
- **Case decision, serialized.**
  - After the idempotency proof, the routine takes `pg_advisory_xact_lock(hashtext('daftar.opening_position'), hashtext(v_business::text))`.
  - It then calls the accounting-owned read `accounting_inventory_opening_position(v_business)` (A-14(d)). That returns the **posted** opening balance's id and the net `Σ debit − Σ credit` over its lines that resolve to the business's `inventory` system account, whether referenced by `system` key or by the `code` of that account (`0047:131-196`). It returns zero rows when there is no posted row or no such line.
  - The result must equal the bound `(opening_balance_id, position_minor)`, else `inventory.opening_case_changed` (409, retryable).
- **Case A** (no position): the opening posts `Dr inventory` per warehouse / `Cr opening_equity` through seam 2 when T > 0 (A-05), or through seam 1 with no entry when T = 0. `binding_source_id = id` iff T > 0.
- **Case B** (a position P exists): T must equal P, else `inventory.opening_valuation_mismatch`.
  - The message carries both totals, and the service pre-check returns them as typed details `{ stockTotalMinor, openingPositionMinor }` (L:716-719).
  - Movements are written only after equality holds (L:719).
  - No entry is written (L:720). `opening_balance_id` and `matched_amount_base_minor = P` are recorded on the header and in the audit row (L:720).
  - The header has an FK `(business_id, opening_balance_id) → accounting_opening_balances (business_id, id)`, because a posted row is never deleted (`0047:205-220`).
- **Correction** (`posted → superseded`) is **BLOCKER B-1**.

### A-14 · Accounting-side objects in 0061 (ENG; (b) and (c) are ENG+TL, TL-6)

All functions are owned by `daftar_accounting_internal`, are `SECURITY DEFINER`, pinned, and have PUBLIC revoked. They are created inside `GRANT`/`REVOKE CREATE ON SCHEMA public TO daftar_accounting_internal` (`0058:40-71`).

**(a) Detail completeness, the AL-01 contract re-proved (L:1054-1056).** One function and deferred constraint trigger per source:
- `accounting_inventory_adjustment_entry_complete()` with `journal_entries_inventory_adjustment_complete`;
- `accounting_inventory_opening_entry_complete()` with `journal_entries_inventory_opening_complete`.

Each is `AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type = '<st>')`. The `WHEN` keeps Budget A untouched (A-26), and adding triggers here is precedented by F-5 (L:125-127). Each one requires, at COMMIT:
- exactly one header (across `inventory_adjustments` and finalized `stocktakes` for `inventory_adjustment`, or `inventory_openings` with `case_kind = 'ledger_posting'`) with `binding_source_id = NEW.source_id` and `occurred_on = NEW.entry_date`;
- the entry's lines are exactly the A-05 shape: accounts by `system_key`, sides, count, `warehouse_id` = the header's warehouse(s), `branch_id` = each warehouse's home branch, and NULL dims on the equity line;
- net `Dr − Cr` on `inventory` = the header's `total_value_base_minor`.

Refusals: `accounting.inventory_detail_missing` and `accounting.inventory_entry_mismatch`. The reverse direction (header → entry) is the header's deferred FK `(business_id, accounting_source_type, binding_source_id) → accounting_source_bindings (business_id, source_type, source_id) DEFERRABLE INITIALLY DEFERRED`, the shape of `0047:102-106`. The two together leave no orphan on either side (L:1054).

**(b) Reversal guard.** `accounting_reversals_20_domain_source_guard` is `BEFORE INSERT ON accounting_reversals`. It refuses when the original entry's `source_type ∈ ('inventory_adjustment','inventory_opening')`, with `accounting.reversal_source_domain_owned`.
- Without it, a merchant holding `accounting.reverse` could reverse an inventory entry through the accepted generic workflow (`0046:376+`). GL Inventory would then diverge from Σ movement values with no stock change, breaking L:1350-1356 and PM-16.
- AL-18's only sanctioned reversal is the one paired with inverse movements (L:724), which is B-1.
- No accepted behaviour changes: no such entry exists before S3.

**(c) Opening-balance guard.** `accounting_opening_balances_30_inventory_opening_guard` is `BEFORE UPDATE OF status ON accounting_opening_balances`. It takes the same advisory lock as A-13, then:
- on `draft → posted`, when the new position has an `inventory` line **and** a posted Case A inventory opening exists, it refuses with `accounting.opening_balance_inventory_conflict`. Otherwise Inventory would be counted twice: once by the Case A entry and once by the opening balance.
- on `posted → superseded`, when a posted Case B inventory opening is bound to this row, it refuses with `accounting.opening_balance_inventory_bound`. Otherwise the stock would stay decomposed against an amount the ledger no longer holds.

No state it guards can exist before S3.

**(d) Opening-position read.** `accounting_inventory_opening_position(p_business_id UUID) RETURNS TABLE (opening_balance_id UUID, inventory_net_minor BIGINT)` is `STABLE`. The only `EXECUTE` grant is to `daftar_inventory_internal`, a NOLOGIN role reachable only from inventory routines that have already consumed a signed assertion.
- This is **reachability for a signed routine, not runtime reach**. No runtime role may execute it (0061-E).
- Why a function and not a table grant: G-1 pins the grantees of `accounting_opening_balances` and its lines (`scripts/guards/journal-privilege-model.ts:104-130`). A function leaves that pin, and every Phase 2 gate that reads it (`phase2-s2-gate.ts:326-357` and others), unchanged.

**(e) Registries.**

```sql
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('inventory_adjustment', 'none', 'not_after_today', 'Inventory loss, gain, damage or stocktake variance valued against COGS (P3-AL-17).', 4),
  ('inventory_opening',    'none', 'not_after_today', 'Opening stock posted against opening equity when no opening position holds Inventory (P3-AL-18).', 5);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'inventory_adjustment', 'Inventory adjustment, damage or stocktake variance; derived by the inventory command.'),
  ('post', 'inventory_opening',    'Opening stock, Case A; derived by the inventory command.');
```

- The policies follow L:1038-1052, where `lower none` and `upper not_after_today` are uniform.
- The `accounting_operation_kinds` rows are required by the 0046 rule "every registered source type has an owning operation kind" (`0046:111-115`). 0061-E re-asserts that rule.
- **Grants to `daftar_accounting_internal`:** `SELECT` on `inventory_adjustments`, `stocktakes`, `inventory_openings` and `warehouses`, for (a) and (c). Nothing else.

### A-15 · Stock-side guards: four bridges and their triggers (ENG)

**(a) Bridges.** For each `<st>` there is `stock_source_bridge_<st>`, exactly the L:1501-1519 / S2C:1049 template:
- `business_id`, `source_id`, `source_line_id`, `movement_kind`, and `source_type TEXT NOT NULL GENERATED ALWAYS AS ('<st>') STORED`;
- `PRIMARY KEY (business_id, source_id, source_line_id, movement_kind)`;
- a line FK `ON DELETE RESTRICT` to the domain line;
- a binding FK `(business_id, source_type, source_id, source_line_id, movement_kind) → stock_source_bindings … ON DELETE RESTRICT`.

| `<st>` | Line FK target |
|---|---|
| `inventory_transfer` | `inventory_transfer_lines (business_id, transfer_id, id)` |
| `inventory_adjustment` | `inventory_adjustment_lines (business_id, adjustment_id, id)` |
| `stocktake` | `stocktake_lines (business_id, stocktake_id, id)` |
| `inventory_opening` | `inventory_opening_lines (business_id, opening_id, id)` |

RLS is the `stock_movements` layering. The internal role gets `SELECT, INSERT`. `daftar_app` gets nothing.

**(b) Binding trigger.** `stock_binding_requires_<st>()` is plpgsql, definer, pinned, internal-owned and PUBLIC-revoked. It raises `inventory.stock_source_line_missing` when no bridge row exists for `NEW`'s identity. It is installed as:

```sql
CREATE CONSTRAINT TRIGGER stock_binding_requires_<st>
  AFTER INSERT ON stock_source_bindings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = '<st>')
  EXECUTE FUNCTION stock_binding_requires_<st>();
```

**(c) Bridge immutability.** `CREATE TRIGGER stock_bridge_immutable_<st> BEFORE UPDATE OR DELETE ON stock_source_bridge_<st> FOR EACH ROW EXECUTE FUNCTION stock_ledger_append_only()` (`0059:264-298`).

**(d) Line-side completeness (§C, L:1532-1544).** A deferred constraint trigger `stock_source_complete_<st>` on the line table checks that each **finalized** line has exactly its required movement set:
- Transfer line: exactly one `transfer_out` at the source warehouse with `qty_delta = −qty`, and exactly one `transfer_in` at the destination with `+qty`, for the same variant.
- Adjustment/damage line: exactly one movement of the header's kind with `qty_delta` equal to the line's signed quantity, at the header's warehouse.
- Stocktake line: when the parent is finalized and `variance_qty ≠ 0`, exactly one `stocktake` movement with `qty_delta = variance_qty` and value = `applied_value_base_minor`; when `variance_qty = 0`, none.
- Opening line: exactly one `inventory_opening` movement with `qty_delta = qty`.

Every movement is found through the bridge and matched by warehouse and variant. The refusal is `inventory.source_movement_set_incomplete`. The trigger fires `AFTER INSERT` (all four) and `AFTER UPDATE` (stocktake lines, A-11 step 7). A header-level twin, `stocktakes_finalized_complete` (`AFTER UPDATE`, deferred), re-checks every line of a stocktake that became `finalized`, so a finalize that touched no line cannot escape.

**(e) Freeze (§D, L:1546-1548).** A `BEFORE UPDATE OR DELETE` trigger `stock_source_freeze_<st>` on each line table raises `inventory.source_line_frozen`:
- transfer, adjustment and opening lines are finalized at insert, so every update or delete is refused;
- stocktake lines are refused as A-11 states.

Every header has a `BEFORE UPDATE OR DELETE` immutability trigger raising `inventory.source_document_immutable`. The exceptions are the stocktake transitions of A-11 and none others; the opening's `posted → superseded` is refused (A-04).

**(f) Header value completeness.** A deferred trigger on each posting header (`inventory_adjustments`, `stocktakes` at finalize, `inventory_openings`) checks that `total_value_base_minor` = Σ `value_delta_base_minor` of the movements bound to its lines. For an opening it also checks that every line's movement value is its allocated share. The refusal is `inventory.source_value_mismatch`. This is the inventory half of equation (3), and A-14(a) is the accounting half.

**(g) Order of writes in every routine.** header → lines → primitive (movements, cache and bindings in one statement per movement; `0060:441-460`) → bridges.
- The bridge's binding FK is not deferrable, so the binding must exist first.
- The line FK needs the line first.
- The deferred FKs between movements and bindings (`0059:193-202`) close at COMMIT.

**(h) The §E nine states (L:1550-1568)** are refused by exactly the mechanisms L:1556-1566 names. T-05 tests each one independently.

### A-16 · Strengthening `inventory_stock_source_guard_gaps()` (ENG)

S2C:493 and the current body (`0059:390-430`) check names only:
- a trigger with the right name on the wrong event, or disabled for origin sessions (`tgenabled = 'R'`), passes;
- so does a trigger with the right name but the wrong function.

0061 §2 replaces it **before any registration**, using `CREATE OR REPLACE` by its owner, the migrator. The function stays `SECURITY INVOKER`, `STABLE` and pinned, with the same signature `RETURNS TABLE (source_type TEXT, missing TEXT)`. For each `stock_source_types` row, the `missing` values are:

| `missing` | Condition (all must hold, else reported) |
|---|---|
| `bridge` | `to_regclass('public.stock_source_bridge_'||st)` exists **and** `relkind = 'r'` |
| `bridge_rls` | `relrowsecurity AND relforcerowsecurity` |
| `bridge_pk` | the primary key's columns are exactly `(business_id, source_id, source_line_id, movement_kind)` in order |
| `bridge_source_type` | column `source_type` has `attgenerated = 's'` and its generation expression deparses to `'<st>'::text` |
| `bridge_binding_fk` | an FK with `confrelid = stock_source_bindings`, `confdeltype = 'r'`, whose `conkey`/`confkey` map to `(business_id, source_type, source_id, source_line_id, movement_kind)` in order |
| `bridge_line_fk` | an FK to a relation other than the bindings table and the bridge itself, with `confdeltype = 'r'`, whose `conkey` maps to `(business_id, source_id, source_line_id)` |
| `bridge_immutable` | a trigger `stock_bridge_immutable_<st>` on the bridge with `tgtype = 27` (ROW, BEFORE, UPDATE and DELETE, and nothing else), `tgenabled IN ('O','A')`, and `tgfoid = 'public.stock_ledger_append_only()'::regprocedure` |
| `binding_trigger` | a trigger `stock_binding_requires_<st>` with `tgrelid = stock_source_bindings`, `tgtype = 5` (ROW, AFTER, INSERT only), `tgconstraint <> 0`, `tgdeferrable`, `tginitdeferred`, `tgenabled IN ('O','A')`, `tgfoid = to_regprocedure('public.stock_binding_requires_'||st||'()')`, a function owned by `daftar_inventory_internal` with `prosecdef` and `proconfig = '{"search_path=pg_catalog, public, pg_temp"}'`, and `pg_get_triggerdef(oid)` containing `WHEN ((new.source_type = '<st>'::text))` |

- `tgenabled IN ('O','A')` replaces `<> 'D'` because `'R'` fires only under `session_replication_role = replica`.
- The S2 fixture (S2C:1040-1060) follows the same template, so the accepted S2 gaps tests stay green. If one does not, the coordinator evolves it truthfully (§7.3).
- The line-side triggers (A-15(d)/(e)) are asserted by name in 0061-E rather than discovered here. That keeps the function's contract the one S2 accepted, only strictly stronger.

**Usage.** 0061-E requires `SELECT count(*) FROM inventory_stock_source_guard_gaps()` = 0 after the four registrations, else `inventory.source_guard_missing`. The same end state proves, by mutation inside a `SAVEPOINT` that is rolled back, that disabling `stock_bridge_immutable_inventory_transfer` (`ALTER TABLE … DISABLE TRIGGER`) makes the function report it. That turns the strengthening into a proof carried inside the migration.

### A-17 · TD-13: replace the plain-`DELETE` prunes (ENG; the provisioning path is ENG+TL, TL-9)

**Reproduced from code first.**

| Site | Location | Owner |
|---|---|---|
| Accounting | `accounting_actor(TEXT[])` at `0045:162-237`; the prune is `0045:233`, `DELETE FROM accounting_assertion_uses WHERE used_at < now() - interval '1 hour';` | `daftar_accounting_internal` (`0045:878`), path `pg_catalog, public, pg_temp` (`0045:163`), `REVOKE` at `0045:852` |
| Provisioning | `provision_actor(TEXT[])` at `0038:80-138`; the prune is `0038:135` | the migrator; `GRANT EXECUTE … TO daftar_platform` (`0038:141`); declared path `public, pg_catalog`, made effectively `public, pg_catalog, pg_temp` by 0045 §9b (`0045:925-985`) |

**The mechanism.** A consumer inserts its `jti`, then runs the `DELETE`, which **row-locks every expired row**. A second consumer in any tenant then reaches the same `DELETE` and waits on those row locks until the first transaction ends (TD-13 at `TECHNICAL_DEBT.md:22`). The control verifier at `0048:310` reuses `accounting_assertion_uses` but has **no** prune, so it needs no change.

**The fix, as proven in 0054.** It is the pattern of `0054:455-470`:

```sql
-- in accounting_actor, replacing 0045:233
IF pg_try_advisory_xact_lock(hashtext('daftar.accounting_assertion_uses'), hashtext('hygiene')) THEN
  DELETE FROM accounting_assertion_uses WHERE used_at < now() - interval '1 hour';
END IF;
-- in provision_actor, replacing 0038:135
IF pg_try_advisory_xact_lock(hashtext('daftar.provisioning_assertion_uses'), hashtext('hygiene')) THEN
  DELETE FROM provisioning_assertion_uses WHERE used_at < now() - interval '1 hour';
END IF;
```

**The replacement.**
- **Accounting.** The body is byte-identical to `0045:163-236` except for the prune. Inside 0061 §1:

  ```
  GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;
  SET LOCAL ROLE daftar_accounting_internal;
  CREATE OR REPLACE FUNCTION accounting_actor(p_allowed_kinds TEXT[]) … SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp …;
  RESET ROLE;
  REVOKE CREATE ON SCHEMA public FROM daftar_accounting_internal;
  ```

  This follows the precedent of `0040:411-471`. `CREATE OR REPLACE` keeps the owner and the ACL.
- **Provisioning.** The owner, the migrator, replaces it directly with `SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp`. That is the **effective** configuration 0045 §9b left, byte-for-byte. The ACL, meaning the grant to `daftar_platform`, is kept by `CREATE OR REPLACE`. Only the `TEXT[]` overload is touched; `provision_actor()` from 0033 is not.

**End state (0061-E).** For both functions, the migration refuses unless:
- the owner, `prosecdef`, `proconfig` and `proacl` equal their pre-migration values, captured at the top of 0061 into a temp-free `DO` block variable. This is compared in the same transaction, so no table is needed;
- `pg_get_functiondef` contains `pg_try_advisory_xact_lock(` before its only `DELETE FROM`;
- `daftar_accounting_internal` holds no `CREATE` on `public` afterwards;
- no role gained `EXECUTE` on either function.

**The test** is T-15, modelled on `tests/integration/inventory-db-routines.test.ts:488-583`. The guards it must keep green are:
- `scripts/guards/posting-surface.ts:83`, which requires `CREATE … FUNCTION accounting_actor` text: still present;
- `search-path-shadowing.test.ts:329-340` and `:397-411`, which require `pg_temp` last: still satisfied.

### A-18 · Grant and ACL matrix produced by S3 (ENG)

| Principal | Gains |
|---|---|
| `daftar_app` | `SELECT` on the eight document tables (for the A-10 proof and replay). `EXECUTE` on exactly the seven entry routines (0062), each of which **verifies the signed server decision as its first statement** (rule 22, L:1978). **No** DML on any S3 table, bridge or accounting table. |
| `daftar_inventory_internal` | `SELECT, INSERT` on the eight document tables and four bridges. Column `UPDATE` on `stocktakes (status, occurred_on, total_value_base_minor, binding_source_id, finalize_intent_sha256, finalized_at, cancelled_at, closed_by)` and on `stocktake_lines (counted_qty, expected_qty_at_capture, captured_at_stock_seq, captured_at, unit_cost_base_minor, applied_value_base_minor)`. `SELECT` on `stock_source_bindings`, which it held `INSERT` on only (`0059:377`), for the completeness triggers. `INSERT` on `outbox_events`. `EXECUTE` on `accounting_inventory_opening_position(uuid)`. |
| `daftar_accounting_internal` | `SELECT` on `inventory_adjustments`, `stocktakes`, `inventory_openings` and `warehouses`, and nothing else. A-14(a) compares the entry against header totals only; the movement ↔ header half is inventory's own trigger (A-15(f)), so accounting never reads `stock_movements` or a bridge. 0061-E enumerates it. |
| `daftar_platform`, `daftar_worker`, `daftar_identity`, `daftar_resolver`, `daftar_provisioner`, PUBLIC | nothing |
| `daftar_migrator` | nothing new: no membership, no `INHERIT`, no attribute |

0061-E and 0062-E enumerate every grant on every S3 object from `information_schema.role_table_grants`, `column_privileges` and `has_function_privilege`, and refuse any difference. This is the pattern of `0059-E` (`0059:442-637`).

### A-19 · P3-AL-41 archival (ENG)

S3 owns P3-AL-41 (L:1202-1210). There is no warehouse- or variant-archive command today. The only archive writer is `CatalogService.archiveProduct`, a plain `UPDATE products SET status='archived'` (`apps/api/src/modules/catalog/catalog.service.ts:359-369`).

**The physical rule** covers every present and future writer, as L:596 argues for physical enforcement:

| Trigger (definer, internal-owned, pinned) | Event | Refusal |
|---|---|---|
| `warehouses_30_archive_requires_zero_stock` | `BEFORE UPDATE OF status ON warehouses`, when `NEW.status = 'archived'` and the old status was not | `inventory.warehouse_has_stock` when any key of the warehouse has `on_hand <> 0` in `stock_levels`, **or** Σ `qty_delta` over its movements ≠ 0 ("re-checked against the movement ledger", L:1206) |
| `product_variants_30_archive_requires_zero_stock` | the same on `product_variants` | `inventory.variant_has_stock` |
| `products_30_archive_requires_zero_stock` | the same on `products`, over all its variants | `inventory.product_has_stock` |

- **Serialization.** The archive trigger takes `pg_advisory_xact_lock(hashtext('daftar.stock_target'), hashtext(<warehouse or product id>))`. Every S3 entry routine takes `pg_advisory_xact_lock_shared` on the same keys (each warehouse, and each product of its variants) before the primitive. So an inbound movement cannot slip in between the check and the archive. Shared locks do not contend with each other.
- **Status checks in the routines.** Every S3 routine refuses `inventory.warehouse_archived` and `inventory.variant_archived` for movements into archived targets.
- **Catalog.** `archiveProduct` gains a pre-check through a small inventory read, so the refusal is typed. Following L:1209, it calls the inventory check rather than duplicating it. The trigger stays the invariant.
- **Tracking disable.** Disabling tracking at non-zero stock is already refused (`0060:774-936`, `inventory.tracking_disable_requires_zero_stock`), and is unchanged.
- **The frozen provisioning writer.** No trigger fires on insert, so onboarding (`0033:160-164`) is untouched.

### A-20 · Predecessor-assertion evolution: F-4 and every other pin (ENG; TL-1 lists them)

F-4 names two pins (L:116-121). Reading the tree finds more, and **all** of them turn red at 0061/0062. Each evolves to the P2-S4 §45 form, "the accepted rows present, in order, and every other row is one an authorized successor added", losing no evidence (L:1060).

| # | Pin | Today | Evolves to |
|---|---|---|---|
| 1 | `tests/integration/migration-upgrade.test.ts:457-461` | the source registry equals the three native types | the first three by `sort_order` are exactly `opening_balance, manual_adjustment, reversal`; every further row is in `AUTHORIZED_PHASE3_SOURCE_TYPES` (the lock's nine, L:1038-1048) with `sort_order > 3`; nothing else |
| 2 | `tests/golden-regression/phase2/01-engine-shapes.golden.test.ts:549-556` | "still holds exactly three" | the same predicate. The rest of the case, that the golden entries used only `manual_adjustment`, is unchanged |
| 3 | `tests/security/accounting-sources-authority.test.ts:106-116` | exactly three `accounting_operation_kinds` pairs | the three native pairs are present; every other pair is `('post', s)` with `s ∈ AUTHORIZED_PHASE3_SOURCE_TYPES` (P3-S5's `purchase_reversal` may need `reverse`, and it evolves this list in its own slice) |
| 4 | `tests/integration/migration-upgrade.test.ts:1175-1185` (the S2 upgrade case) | `stock_source_types: 0` and `inventory_operation_movement_kinds: 0` after the full path | no row `registered_by IN ('P3-S1','P3-S2')`; every row is registered by an authorized successor slice. The S2-era claim "S2 registered nothing" is kept exactly |
| 5 | `tests/security/inventory-db-authority.test.ts:217-243` and `:245-262` | the internal principal's exact table and column grants | the S1+S2 entries stay verbatim, plus exactly the A-18 S3 entries, **appended** with a `// P3-S3 (0061/0062)` comment (the S2 precedent at `:235-242`) |
| 6 | `tests/integration/inventory-db-guard.test.ts:47-76` (G-7 transferred list) and `:91` (rule-22 writers) | exact lists | append the S3 routines. The writers list becomes the primitive plus the seven entry routines, since each writes a header/line/bridge. The first-statement rule is unchanged |
| 7 | `packages/inventory/test/payload.test.ts:219` | exactly three op codes | the three S1 codes with unchanged schemas plus exactly the seven S3 codes (§4). `:224` (schemas keyed by codes) stays true as written |
| 8 | `scripts/phase3-s2-gate.ts` candidate tense (`:202-214`: "after 0058 exactly 0059, 0060") | fails the moment 0061 exists | **not edited.** The S2 gate must be in its **accepted** tense (S2_ACCEPTED filled, manifest frozen through 0060), whose range check is `0059–0060` only (`:236-241`). This is a sequencing precondition (TL-2), not an evolution |

- **Not affected.** `scripts/phase2-s5-gate.ts:308` (scoped to 0048 text), `phase3-s1-gate.ts:210-222` (scoped to S1 files), the `phase3-s2-gate.ts` scope checks (`:242-255`, S2 files only), `migration-portability.test.ts:1120-1150` (a closed `IN` list; S3 **appends** its functions there for coverage), and `stock-ledger-guards.test.ts:230-243` (`arrayContaining`).
- **Negative proof (P:198).** Each evolved predicate is a named, exported function in the test file. A case injects an unauthorized row inside a transaction that is rolled back (`INSERT INTO accounting_source_types … 'sale'`, `INSERT INTO stock_source_types … 'fixture_rogue'`, an `accounting_operation_kinds` pair `('post','sale')`), and asserts each predicate returns false (T-14).
- **Landing.** Each evolution lands **in the same commit** as the migration that turns it red, so every push stays green (P:291).

### A-21 · Permissions, routes and DTOs (ENG)

Permissions come from the one registry, `packages/domain-core/src/permissions.ts:58-61`. All three S3 keys are sensitive (`:102-104`). S3 adds none.

| Route (controller `InventoryMovementsController`, prefix `/v1/inventory`) | `@RequiresPermission` | op_code | Seam | Success |
|---|---|---|---|---|
| `POST transfers` | `inventory.transfer` | `inventory.transfer` | 1 | 201; 200 `replayed:true` |
| `POST adjustments` | `inventory.adjust` | `inventory.adjust` | 2 or 1 (A-08) | 201; 200 replay |
| `POST damages` | `inventory.adjust` | `inventory.damage` | 2 or 1 | 201; 200 replay |
| `POST stocktakes` | `inventory.stocktake` | `inventory.stocktake_open` | 1 | 201; 200 replay |
| `PUT stocktakes/:stocktakeId/counts` | `inventory.stocktake` | `inventory.stocktake_count` | 1 | 200 |
| `POST stocktakes/:stocktakeId/finalize` | `inventory.stocktake` | `inventory.stocktake_finalize` (`outcome: finalized`) | 2 or 1 | 200 |
| `POST stocktakes/:stocktakeId/cancel` | `inventory.stocktake` | `inventory.stocktake_finalize` (`outcome: cancelled`) | 1 | 200 |
| `POST openings` | `inventory.adjust` | `inventory.opening` | Case A (T > 0): 2; else 1 | 201; 200 replay |

- **The route guard** refuses before the body is parsed, as in `inventory-configuration.controller.ts:22-31`. The service then runs `InventoryAuthorizationService.authorize` (`inventory-authorization.ts:89-116`) with the op code and **every** affected warehouse. `OPERATION_AUTHORITY` (`:24-28`) gains the seven entries, all `scope: 'warehouses'`.
- **The trace id** is minted once at the controller (`newBusinessTransactionId()`, P3-AL-35).
- **DTOs** are strict zod schemas (`ZodValidationPipe`):
  - Unknown keys are refused.
  - Ids are canonical lowercase UUIDs.
  - Quantities and costs are **decimal strings** (`^\d{1,14}(\.\d{1,4})?$` and `^\d{1,18}(\.\d{1,10})?$`), never JSON numbers, following the accounting-adapter reasoning (`accounting-posting.adapter.ts:24-27`).
  - `occurredOn` is `YYYY-MM-DD` and **required** on posting commands.
  - `reason` is 1..500 characters after `trim` and is required on adjust and damage.
  - Each document has 1..200 lines.
  - A line is `{ productId, variantId? , quantity, unitCost? }` (A-23).
- **Responses** carry `{ id, replayed, businessTransactionId, lines: [{ lineId, variantId, warehouseId, qtyDelta, valueDeltaBaseMinor (string) }], journalEntryId | null }`. Openings add `case: 'ledger_posting' | 'opening_balance_bound'` and, for Case B, `openingBalanceId` and `matchedAmountMinor`. Money values are strings.
- **The UI** holds no business logic, because there is no UI in S3 (P3-AL-47/48 belong to S7).
- **Wiring.** Both `apps/api/src/app/app.module.ts` and `merchant-api.module.ts` register the controller and services, following the configuration precedent (`app.module.ts:30,65`, `merchant-api.module.ts:28`).

### A-22 · Error model (ENG): see §3

### A-23 · Variant resolution and the hidden base variant (ENG)

A request line names `productId` and an optional `variantId`. The service resolves the stock identity under RLS:
- With a `variantId`: it must be a **non-base** variant of `productId` (`is_base = false`).
- Without one: the product must have no active merchant variant, and its base variant (`is_base = true`) is the identity.

The resolved `variant_id` is what the payload binds. The base variant never appears in a request or a response: responses carry `productId` and, for merchant variants, `variantId` (P3-AL-52, L:1579-1591). The routines re-check that the variant belongs to the business and is active, and that its product is `track_inventory = true` (`inventory.product_not_tracked`). The unit's decimals must represent the quantity; the primitive checks this through R2 (`0060:118-131`).

### A-24 · Document size (ENG+TL, TL-8)

At most 200 lines per document, and at most 200 counted lines per count request. A stocktake may hold up to 2000 lines across requests. This bounds a transaction's lock set and duration, because the primitive locks every key it touches (`0060:290-310`). It is an engineering bound, not a product rule, and raising it is a one-constant change.

### A-25 · Audit and outbox (ENG)

**Audit.** Every entry routine writes one `audit_events` row with the **signed** actor (`v_actor.actor_user_id`, L:1976), `metadata.assertionJti` and `metadata.business_transaction_id`, following the pattern of `0060:909-920`. It writes that row only when something happened; a replay writes none. The actions are:
- `inventory.transfer_completed`
- `inventory.stock_adjusted`
- `inventory.stock_damaged`
- `inventory.stocktake_opened`
- `inventory.stocktake_counted`
- `inventory.stocktake_finalized`
- `inventory.stocktake_cancelled`
- `inventory.opening_posted`, with case, `opening_balance_id` and matched amount (L:720)

**Outbox.** One `outbox_events` row per completed document (type = the action with a `.v1` suffix). The payload holds `{ businessId, documentId, businessTransactionId }` only, with no amounts, the same discipline as `0045:803-810`. The accounting entry writes its own audit and outbox rows (`0045:796-810`), so a posting command has two of each, both in the one transaction (L:959-968).

### A-26 · Tier-1 Budget A stays at 15 ms (ENG)

Budget A is `A_POST_P95: 15` (`tests/performance/accounting-budgets.test.ts:54`). S3 touches the posting path in exactly two ways:
- TD-13 adds one `pg_try_advisory_xact_lock` call;
- two constraint triggers on `journal_entries` are filtered by `WHEN (NEW.source_type = …)`, so they are not even queued for other sources.

The budget test runs unchanged in the gate, with no parallel load (SM:36). A regression is a failure, not a re-baseline.

---

## 2. Database contract

### 2.1 Migration 0061 order (normative)

1. **TD-13** (A-17).
2. **Gaps** `CREATE OR REPLACE` (A-16).
3. `GRANT CREATE ON SCHEMA public TO daftar_inventory_internal; GRANT CREATE ON SCHEMA public TO daftar_accounting_internal;`
4. Tables (§2.2), with `REVOKE ALL … FROM PUBLIC` on each.
5. Bridges (A-15(a)).
6. Stock-side functions and triggers (A-15(b)–(f)), then A-19.
7. `INSERT INTO stock_source_types … ('inventory_adjustment','P3-S3'), ('inventory_opening','P3-S3'), ('inventory_transfer','P3-S3'), ('stocktake','P3-S3')`.
8. Accounting side (A-14), including the registrations.
9. RLS policies, grants (A-18), and `ALTER … OWNER`.
10. `REVOKE CREATE ON SCHEMA public FROM daftar_inventory_internal, daftar_accounting_internal;`
11. **0061-E** (§2.9).

### 2.2 Tables

Every table has `tenant_id UUID NOT NULL`, `business_id UUID NOT NULL`, `FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)`, and a composite PK beginning with `business_id`. Other composite FKs are same-business: `(business_id, warehouse_id) → warehouses (business_id, id)` and `(business_id, variant_id) → product_variants (business_id, id)`.

| Table | Columns beyond the common ones | Constraints |
|---|---|---|
| `inventory_transfers` | `id`, `source_warehouse_id`, `destination_warehouse_id`, `intent_sha256`, `actor_user_id → users`, `business_transaction_id UUID NOT NULL`, `created_at` | PK `(business_id, id)`; `CHECK (source_warehouse_id <> destination_warehouse_id)`; both warehouse FKs |
| `inventory_transfer_lines` | `transfer_id`, `id`, `line_no INT CHECK (> 0)`, `variant_id`, `qty NUMERIC(18,4) CHECK (qty > 0)` | PK `(business_id, transfer_id, id)`; `UNIQUE (business_id, transfer_id, line_no)`; `UNIQUE (business_id, transfer_id, variant_id)` (PM-09); FK to header |
| `inventory_adjustments` | `id`, `kind CHECK IN ('adjustment','damage')`, `warehouse_id`, `occurred_on DATE`, `reason TEXT CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500)`, `intent_sha256`, `total_value_base_minor BIGINT CHECK (\|v\| ≤ 10^18)`, `accounting_source_type TEXT GENERATED ALWAYS AS ('inventory_adjustment') STORED`, `binding_source_id UUID`, `actor_user_id`, `business_transaction_id`, `created_at` | `CHECK (binding_source_id IS NULL OR binding_source_id = id)`; `CHECK ((total_value_base_minor = 0) = (binding_source_id IS NULL))`; `CHECK (kind <> 'damage' OR total_value_base_minor <= 0)`; the deferred binding FK (A-14(a)) |
| `inventory_adjustment_lines` | `adjustment_id`, `id`, `line_no`, `variant_id`, `qty_delta NUMERIC(18,4) CHECK (<> 0)`, `unit_cost_base_minor NUMERIC(28,10) CHECK (IS NULL OR ≥ 0)` | `CHECK ((qty_delta > 0) = (unit_cost_base_minor IS NOT NULL))`; `UNIQUE (business_id, adjustment_id, line_no)`; `UNIQUE (business_id, adjustment_id, variant_id)` |
| `stocktakes` | `id`, `warehouse_id`, `status CHECK IN ('draft','finalized','cancelled')`, `intent_sha256`, `finalize_intent_sha256`, `occurred_on DATE`, `total_value_base_minor BIGINT`, `accounting_source_type GENERATED … ('inventory_adjustment')`, `binding_source_id`, `opened_by`, `closed_by`, `created_at`, `finalized_at`, `cancelled_at` | the state CHECK as a physical shape (the 0047 pattern at `0047:88-97`): draft has all closing fields NULL; finalized has `occurred_on`, `total`, `finalize_intent`, `finalized_at` and `closed_by` NOT NULL, and binding iff total ≠ 0; cancelled has `finalize_intent`, `cancelled_at` and `closed_by` NOT NULL, total NULL and binding NULL; `UNIQUE (business_id, warehouse_id) WHERE status = 'draft'`; deferred binding FK |
| `stocktake_lines` | `stocktake_id`, `id`, `variant_id`, `expected_qty_at_capture NUMERIC(18,4) CHECK (≥ 0)`, `captured_at_stock_seq BIGINT CHECK (≥ 0)`, `counted_qty NUMERIC(18,4) CHECK (≥ 0)`, `variance_qty NUMERIC(18,4) GENERATED ALWAYS AS (counted_qty - expected_qty_at_capture) STORED`, `unit_cost_base_minor NUMERIC(28,10)`, `applied_value_base_minor BIGINT`, `captured_at TIMESTAMPTZ` | `UNIQUE (business_id, stocktake_id, variant_id)`; `CHECK (variance_qty <> 0 OR applied_value_base_minor IS NULL)` (L:661) |
| `inventory_openings` | `id`, `status CHECK IN ('posted','superseded')`, `case_kind CHECK IN ('ledger_posting','opening_balance_bound')`, `occurred_on`, `opening_balance_id`, `matched_amount_base_minor BIGINT`, `total_value_base_minor BIGINT CHECK (≥ 0)`, `accounting_source_type GENERATED … ('inventory_opening')`, `binding_source_id`, `intent_sha256`, `actor_user_id`, `business_transaction_id`, `created_at` | Case A: `opening_balance_id IS NULL AND matched_amount_base_minor IS NULL AND (binding_source_id IS NOT NULL) = (total_value_base_minor > 0)`. Case B: `opening_balance_id IS NOT NULL AND matched_amount_base_minor = total_value_base_minor AND binding_source_id IS NULL`. Partial unique `(business_id) WHERE status = 'posted'` (L:724); FK to `accounting_opening_balances (business_id, id)`; deferred binding FK |
| `inventory_opening_lines` | `opening_id`, `id`, `line_no`, `warehouse_id`, `variant_id`, `qty NUMERIC(18,4) CHECK (> 0)`, `unit_cost_base_minor NUMERIC(28,10) CHECK (≥ 0)` | `UNIQUE (business_id, opening_id, line_no)`; `UNIQUE (business_id, opening_id, warehouse_id, variant_id)` |

- **Deliberately absent.** Lines carry no copy of the movement value except `stocktake_lines.applied_value_base_minor`, which the completeness trigger checks equal to the stored movement, and the header totals, which both halves of equation (3) check. The movement stays the only authority (L:1370).
- **The G-3 guard** (`stock-ledger-guards.test.ts:228-243`) must accept these tables. None has `reserved`/`available`, and none is a second stock cache.

### 2.3 Bridges and stock-side triggers

See A-15. The complete S3 trigger set, which 0061-E asserts by `pg_trigger` name, table, `tgtype`, function and enabled state:

| Trigger | Table | Timing | Function (owner, security) | Refusal |
|---|---|---|---|---|
| `stock_binding_requires_<st>` ×4 | `stock_source_bindings` | AFTER INSERT, deferred, `WHEN` | `stock_binding_requires_<st>()` (internal, DEFINER) | `inventory.stock_source_line_missing` |
| `stock_bridge_immutable_<st>` ×4 | the bridge | BEFORE UPDATE OR DELETE | `stock_ledger_append_only()` (migrator, INVOKER; `0059:264`) | its S2 code |
| `stock_source_complete_<st>` ×4 | the line table | AFTER INSERT (plus UPDATE for stocktake), deferred | `stock_source_complete_<st>()` (internal, DEFINER) | `inventory.source_movement_set_incomplete` |
| `stock_source_freeze_<st>` ×4 | the line table | BEFORE UPDATE OR DELETE | `stock_source_freeze_<st>()` (internal, DEFINER) | `inventory.source_line_frozen` |
| `<header>_immutable` ×4 | each header | BEFORE UPDATE OR DELETE | `inventory_source_header_guard()` (internal, DEFINER) | `inventory.source_document_immutable` / `inventory.stocktake_state_invalid` / `inventory.opening_state_invalid` |
| `<header>_value_complete` ×3 | adjustments, stocktakes, openings | AFTER INSERT OR UPDATE, deferred | `inventory_source_value_complete()` (internal, DEFINER) | `inventory.source_value_mismatch` |
| `stocktakes_finalized_complete` | `stocktakes` | AFTER UPDATE, deferred | `stock_source_complete_stocktake_header()` | `inventory.source_movement_set_incomplete` |
| `warehouses_30_…`, `product_variants_30_…`, `products_30_…` | A-19 | BEFORE UPDATE OF status | internal, DEFINER | `inventory.*_has_stock` |
| `journal_entries_inventory_adjustment_complete`, `journal_entries_inventory_opening_complete` | `journal_entries` | AFTER INSERT, deferred, `WHEN` | accounting, DEFINER | `accounting.inventory_detail_missing` / `accounting.inventory_entry_mismatch` |
| `accounting_reversals_20_domain_source_guard` | `accounting_reversals` | BEFORE INSERT | accounting, DEFINER | `accounting.reversal_source_domain_owned` |
| `accounting_opening_balances_30_inventory_opening_guard` | `accounting_opening_balances` | BEFORE UPDATE OF status | accounting, DEFINER | `accounting.opening_balance_inventory_conflict` / `_bound` |

**Trigger ordering on `products` and `product_variants`.** The names `products_30_…` and `product_variants_30_…` sort after the existing `_10_`/`_20_` triggers (`0053`, `0060:631-709`). The invoker guards keep running first, as P3-AL-54 §G composes them (L:1739-1758).

### 2.4 0062 routines

All are internal-owned, `SECURITY DEFINER`, pinned, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO daftar_app` only, and contain no `EXECUTE`. The first statement of each is `v_actor := inventory_assertion_consume('<op>', inventory_claimed_payload_digest('<op>', <types>, <values>));`. Each reads `v_trace := inventory_business_transaction_id()`. Each runs in READ COMMITTED; the primitive refuses other isolation levels (S2).

| Routine | op_code | Returns |
|---|---|---|
| `inventory_transfer_stock(p_transfer_id uuid, p_source_warehouse_id uuid, p_destination_warehouse_id uuid, p_variant_ids uuid[], p_qtys numeric[])` | `inventory.transfer` | `TABLE (document_id uuid, replayed boolean, line_id uuid, variant_id uuid, value_moved_base_minor bigint)` |
| `inventory_adjust_stock(p_adjustment_id uuid, p_warehouse_id uuid, p_occurred_on date, p_reason text, p_variant_ids uuid[], p_qty_deltas numeric[], p_unit_costs numeric[], p_expected_values bigint[])` | `inventory.adjust` | `TABLE (document_id, replayed, total_value_base_minor bigint, line_id, variant_id, value_delta_base_minor)` |
| `inventory_record_damage(p_adjustment_id uuid, p_warehouse_id uuid, p_occurred_on date, p_reason text, p_variant_ids uuid[], p_qtys numeric[], p_expected_values bigint[])` | `inventory.damage` | as for adjust |
| `inventory_stocktake_open(p_stocktake_id uuid, p_warehouse_id uuid)` | `inventory.stocktake_open` | `TABLE (stocktake_id, replayed)` |
| `inventory_stocktake_count(p_stocktake_id uuid, p_warehouse_id uuid, p_variant_ids uuid[], p_counted_qtys numeric[])` | `inventory.stocktake_count` | `TABLE (line_id, variant_id, expected_qty_at_capture, captured_at_stock_seq, counted_qty, variance_qty, changed boolean)` |
| `inventory_stocktake_finalize(p_stocktake_id uuid, p_warehouse_id uuid, p_outcome text, p_occurred_on date, p_variant_ids uuid[], p_variances numeric[], p_unit_costs numeric[], p_expected_values bigint[])` | `inventory.stocktake_finalize` | `TABLE (stocktake_id, replayed, status, total_value_base_minor, line_id, variant_id, value_delta_base_minor)` |
| `inventory_record_opening(p_opening_id uuid, p_occurred_on date, p_opening_balance_id uuid, p_position_minor bigint, p_warehouse_ids uuid[], p_variant_ids uuid[], p_qtys numeric[], p_unit_costs numeric[])` | `inventory.opening` | `TABLE (document_id, replayed, case_kind, total_value_base_minor, line_id, warehouse_id, variant_id, value_delta_base_minor)` |

- **Common step order (A-10(d)):**
  1. consume
  2. the header insert-or-prove
  3. array-shape checks: equal lengths, 1..200 (`inventory.payload_invalid`)
  4. shared advisory locks (A-19)
  5. validation reads
  6. lines
  7. primitive
  8. expected-value comparison (`inventory.valuation_changed`)
  9. bridges
  10. audit and outbox
  11. return
- **The transfer** calls the primitive once with 2n requests. For each line it passes a `transfer_out` (source key, `−qty`, cost NULL, value NULL) and a `transfer_in` (destination key, `+qty`, same `(source_type, source_id, source_line_id)`). The primitive pairs them and copies the negated value (`0060:356-375`). The transfer routine binds no expected values: there is no posting to agree with.
- **Pure helpers** (internal, DEFINER, IMMUTABLE, pinned, no grant):
  - `inventory_fixed_text(numeric, integer)`
  - `inventory_reason_words(text)`
  - `inventory_largest_remainder(p_weights numeric[], p_total bigint) RETURNS bigint[]`, with the tie-break on array index, i.e. `line_no`

### 2.5 Registrations in 0062

```sql
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('inventory.transfer','P3-S3'), ('inventory.adjust','P3-S3'), ('inventory.damage','P3-S3'),
  ('inventory.stocktake_open','P3-S3'), ('inventory.stocktake_count','P3-S3'),
  ('inventory.stocktake_finalize','P3-S3'), ('inventory.opening','P3-S3');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES
  ('inventory.transfer','transfer_out','P3-S3'), ('inventory.transfer','transfer_in','P3-S3'),
  ('inventory.adjust','adjustment','P3-S3'), ('inventory.damage','damage','P3-S3'),
  ('inventory.stocktake_finalize','stocktake','P3-S3'), ('inventory.opening','inventory_opening','P3-S3');
```

Every op code matches the registry pattern `^[a-z]+(\.[a-z_]+)+$` (`0054:53`).

### 2.6 RLS

Each of the eight tables and four bridges gets `ENABLE` + `FORCE` and the `stock_movements` policy set (`0059:311-359`), keyed on `business_id` and `app.business_id` in 0052 UUID style. A test (T-02) proves that `daftar_app` sees nothing of another business, including another business of the **same owner**.

### 2.7 Accounting objects

See A-14. Every accounting function carries the pinned path, which `search-path-shadowing.test.ts:329-340` requires to end with `pg_temp`. The two journal completeness functions are added to the closed `IN` lists of `tests/integration/accounting-source-completeness.test.ts:326-328` and `scripts/phase2-s4-gate.ts:717-719` **only if** those lists are exhaustive. They are named lists, so S3 adds its own test and edits neither.

### 2.8 What S3 does not change

- No frozen byte in `0000`–`0060`.
- No change to `stock_movements`, `stock_levels`, `stock_source_bindings` or the primitive's body (L:1566).
- No new movement kind: `stock_movement_kinds` stays at ten (0059-E E-1).
- No new system account (L:686).
- No change to `accounting_post_entry`, `accounting_post_manual_adjustment`, `accounting_post_reversal` or the opening-balance routines.
- No runtime role gains any table DML.

### 2.9 End-state blocks

**0061-E refuses (`RAISE EXCEPTION 'inventory.migration_end_state_invalid: …'`, or `inventory.source_guard_missing` for gaps) unless:**
1. `stock_source_types` is exactly the four S3 rows, all `registered_by = 'P3-S3'`.
2. `inventory_stock_source_guard_gaps()` is empty, and the rolled-back savepoint mutation (A-16) makes it non-empty.
3. `accounting_source_types` is the three native rows, unchanged, plus exactly `inventory_adjustment` (sort 4) and `inventory_opening` (sort 5), both `none`/`not_after_today`.
4. `accounting_operation_kinds` is the three native pairs plus the two S3 pairs, and every source type has an owning kind (the 0046 rule).
5. Every trigger in §2.3 exists on its table with the stated `tgtype`, function, owner, `prosecdef` and `proconfig`, and `tgenabled = 'O'`.
6. Every new function is `prosecdef` (except the migrator-owned gaps function and `stock_ledger_append_only`), pinned, and has no `EXECUTE` for PUBLIC or any runtime role. The accounting read function is executable by `daftar_inventory_internal` only.
7. The A-18 grant matrix holds exactly: `daftar_app` holds `SELECT` only on the eight tables and nothing on the bridges.
8. Neither internal role holds `CREATE` on `public`.
9. `inventory_operation_kinds` still has the three S1 rows only, and `inventory_operation_movement_kinds` is empty. Nothing can reach the new tables yet.
10. The TD-13 checks of A-17 hold.

**0062-E refuses unless:**
1. `inventory_operation_kinds` = 3 S1 + 7 S3 rows, with the 7 `registered_by = 'P3-S3'`.
2. `inventory_operation_movement_kinds` = exactly the seven rows of §2.5, and `(inventory.adjust, transfer_in)` is absent.
3. Each of the seven routines exists, is internal-owned, `prosecdef`, pinned, `has_function_privilege('daftar_app', …, 'EXECUTE')`, and is **not** executable by any other runtime role or PUBLIC.
4. The helpers have no `EXECUTE` grantee.
5. `pg_get_functiondef` of each entry routine has `inventory_assertion_consume(` in its first statement. This duplicates rule 22 at deploy time.
6. No `CREATE` on `public` is left.

---

## 3. Error model

**Rule.** Every refusal is a stable `<domain>.<code>`. The API maps it through `inventoryRefusal` (`apps/api/src/modules/inventory/inventory-errors.ts:42-64`). Accounting refusals from the posting come out of `refusedAs` (`accounting-posting.adapter.ts:94-109`) as `AccountingError` and are translated by the **existing** accounting error mapping the accounting controller uses; S3 adds no second mapping.

**Evolution of `inventoryRefusal` (additive, ENG).** A new 409 rule is placed **after** the 403 rule, so `.assertion_payload_mismatch` stays 403. It matches codes ending in:
- `_conflict`, `_changed`, `_state_invalid`, `_already_open`, `_already_posted`, `_has_stock`;
- `.insufficient_stock`, `.opening_valuation_mismatch`, `.source_line_frozen`, `.source_document_immutable`.

Everything else keeps its current class.

| Code | Raised by | HTTP | Retry? |
|---|---|---|---|
| `inventory.assertion_*` (S1 set) | consume/current | 403 | no |
| `inventory.warehouse_out_of_scope` | authorization service (each warehouse, both for a transfer) | 403 | no |
| `inventory.idempotency_conflict` | service pre-check; routine | 409 | no |
| `inventory.document_id_conflict` | adjust/damage/stocktake routines (A-10(e)) | 409 | no |
| `inventory.valuation_changed` | posting routines (A-07) | 409 | **yes**, same body |
| `inventory.stocktake_changed` | finalize | 409 | **yes**, after re-read |
| `inventory.opening_case_changed` | opening | 409 | **yes** |
| `inventory.insufficient_stock` | primitive (`0060:376-393`) | 409 | no |
| `inventory.unit_cost_required` | adjust (qty > 0), finalize (no average); the service pre-check lists `variantId`s | 400 | no |
| `inventory.unit_cost_not_applicable` | finalize (an average exists) | 400 | no |
| `inventory.opening_valuation_mismatch` | opening Case B; the service pre-check adds `{stockTotalMinor, openingPositionMinor}` | 409 | no |
| `inventory.opening_already_posted` | opening; partial unique index | 409 | no |
| `inventory.opening_state_invalid` | header guard (supersede, B-1) | 409 | no |
| `inventory.stocktake_already_open` / `_state_invalid` / `_empty` / `_not_found` | stocktake routines | 409/409/400/404 | no |
| `inventory.transfer_same_warehouse` | service; `CHECK` | 400 | no |
| `inventory.warehouse_not_found` / `inventory.variant_not_found` / `inventory.product_not_found` | routines (RLS-invisible counts as not found) | 404 | no |
| `inventory.warehouse_archived` / `inventory.variant_archived` / `inventory.product_not_tracked` | routines | 409/409/400 | no |
| `inventory.duplicate_line` / `inventory.lines_required` / `inventory.payload_invalid` / `inventory.quantity_precision_invalid` / `inventory.reason_required` | DTO, service, routine, primitive | 400 | no |
| `inventory.warehouse_has_stock` / `variant_has_stock` / `product_has_stock` | A-19 triggers; catalog pre-check | 409 | no |
| `inventory.stock_source_line_missing` · `inventory.source_movement_set_incomplete` · `inventory.source_value_mismatch` · `inventory.source_line_frozen` · `inventory.source_document_immutable` | deferred/row triggers; unreachable through a correct routine; tamper tests | 500-class if ever seen from a routine (an invariant defect); tests read the SQL code | no |
| `inventory.source_guard_missing` | 0061-E | migration fails | n/a |
| `accounting.inventory_detail_missing` / `accounting.inventory_entry_mismatch` | A-14(a) at COMMIT | 409 through the accounting mapping | no |
| `accounting.reversal_source_domain_owned` | A-14(b) | 409 | no |
| `accounting.opening_balance_inventory_conflict` / `_bound` | A-14(c) | 409 | no |
| `accounting.entry_date_in_future`, `accounting.period_*` | accepted accounting (`0058`, `0049`) | their accepted mapping | no |

**Packages.**
- `packages/inventory/src/errors.ts:24-37` gains the S3 arithmetic and payload codes the package can raise: `inventory.duplicate_line`, `inventory.lines_required`, `inventory.unit_cost_required`, `inventory.opening_valuation_mismatch`, `inventory.allocation_invalid`.
- Messages never carry a quantity, cost or value (`errors.ts:17-22`). Totals travel in typed `details` only.

---

## 4. Packages

### 4.1 `@daftar/inventory` (framework-free; no Nest or driver import, per P3-AL-08)

| Module | New or evolved | Content |
|---|---|---|
| `src/payload.ts` | **evolved additively** | `INVENTORY_OPERATION_CODES` gains the seven S3 codes. `INVENTORY_PAYLOAD_SCHEMAS` gains their schemas, expressed as a fixed header field list plus a `repeat: { countField, fields }` group. The S1 schemas, encoders and bytes are **unchanged**. The existing encoders are exported as `encodeInventoryField` for the new module. Pin 7 of A-20 evolves. |
| `src/movement-payloads.ts` | new | Builders for the seven kinds: `transferPayload`, `adjustPayload`, `damagePayload`, `stocktakeOpenPayload`, `stocktakeCountPayload`, `stocktakeFinalizePayload`, `openingPayload`. Each returns `{ payload: InventoryPayload, intentSha256 }`. Helpers `toQ4`, `toC10` and `yyyymmdd` reuse `fixed-point.ts`/`quantity.ts`. |
| `src/reason-digest.ts` | new | `reasonWords(reason: string): readonly bigint[]` gives 8 × uint32 of SHA-256 over the UTF-8 bytes (TL-4). |
| `src/allocation.ts` | new | `largestRemainder(weights: readonly ExactDecimal[], total: bigint): bigint[]` with tie-break by index (`line_no ASC`, L:785), and `openingDocumentTotal(lines) = roundHalfEven(Σ qty×cost)`. BigInt only. |
| `src/assertion.ts` | **untouched** | `wireOperationCode` validates through `isInventoryOperationCode` (`assertion.ts:168-180`), which covers the new codes once the registry grows. |
| `vectors/invpl-s3-vectors.json` | new | ≥ 3 cases per S3 kind, including: NULL `unit_cost_c10`; negative `qty_delta_q4`; `expected_value` 0 and negative; a 1-line and a 3-line group; transfer vs adjust over identical ids (different digests); stocktake `cancelled` with `line_count 0`; opening Case A vs Case B; a reason with multi-byte UTF-8. **The S1 file `invpl-vectors.json` is not edited** (its pin is `inventory-payload-parity.test.ts:139-147`). |
| `vectors/allocation-vectors.json` | new | Ties, zero weights, all-zero W, a single line, a residue of n−1, a total ≥ 2^53 (BigInt proof), and GOLD vectors for Case B exact and off-by-one. |

### 4.2 `@daftar/accounting`

`src/domain-posting.ts` is new (A-06), with an export from `src/index.ts`. `src/post.ts` receives the additive `DOMAIN_SOURCE_TYPES` refusal only (TL-10). There is no other change.

### 4.3 `apps/api/src/modules/inventory` (domain and application)

- **New services:**
  - `inventory-transfer.service.ts`
  - `inventory-adjustment.service.ts` (adjust and damage)
  - `inventory-stocktake.service.ts`
  - `inventory-opening.service.ts`
  - `inventory-stock-read.ts`: the pre-read (A-07), the variant resolution (A-23), the idempotency lookup (A-10) and the opening-position read. Openings read `accounting_opening_balances` through `daftar_app`'s accepted `SELECT` (`journal-privilege-model.ts:120-130`).
  - `inventory-posting.ts`: builds the `PostingCommand` from the expected values (A-05, A-06).
- **Evolved:**
  - `inventory-authorization.ts:24-28`: seven `OPERATION_AUTHORITY` entries.
  - `inventory-errors.ts:42-64`: the 409 rule of §3.
  - `apps/api/src/modules/catalog/catalog.service.ts:359-369`: the A-19 pre-check.
- **The pattern** is `inventory-configuration.service.ts:60-123`. The service writes nothing itself: every write is the routine's or the accounting primitive's (L:1003, G-4).

---

## 5. Harness

This is modelled on S2C §5. None of it runs here: this contract starts no PostgreSQL.

- **H-1 `tests/helpers/inventory-commands.ts`** (new). It mints real `invctl/1` assertions with the test key for any S3 kind over package-built payloads. It opens seams exactly as the services do, and calls each routine as `daftar_app`. It exposes `runCommand(opts)` with explicit overrides for negative tests: `wrongOp`, `tamperField(i)`, `scopeBusiness`, `replayJti`.
- **H-2 `tests/helpers/inventory-posting.ts`** (new). It builds and mints the accounting assertion through `mintDomainPostingAssertion`, and can post a **forged** entry (a valid `post` assertion for `inventory_adjustment` with no header) through `postAs` (`tests/helpers/accounting-posting.ts:149-192`) for the A-14 negative tests.
- **H-3 fixtures.** Two businesses A and A′ with the **same owner**, plus B of a different tenant. Each has two warehouses (W1 home of branch X, W2 of branch Y), an assigned-scope member reaching W1 only, tracked products (a simple product with its base variant, and a product with two merchant variants), and units with decimals 0 and 2. They are built with the S1 isolation fixture (`tests/security/inventory-tenant-isolation.test.ts`) and the real configure command.
- **H-4 stock seeding** goes **only** through real S3 commands (opening Case A, then adjustments). No owner-level ledger inserts are made, except in H-6.
- **H-5 two connections** (`pg.Client` × 2) with `SET lock_timeout = '2s'` and `statement_timeout = '5s'`, the S1/TD-13 settings (`inventory-db-routines.test.ts:488-583`). Committed fixtures are cleaned in `afterAll` (S2C A-11).
- **H-6 tamper harness** runs as the schema owner, inside a transaction that is always rolled back, with `SET CONSTRAINTS ALL IMMEDIATE` to surface deferred refusals synchronously. It is used only for the §E vector and guard mutation tests (S2C A-11).
- **H-7 counters.** `counts(business)` returns the row counts of `stock_movements`, `stock_source_bindings`, the four bridges, the eight tables, `journal_entries`, `journal_lines`, `accounting_source_bindings`, `audit_events`, `outbox_events` and `inventory_assertion_uses`. It is used before and after every atomicity and "no entry" assertion (P:193, P:197-198).

---

## 6. Test plan

All test files are **new**. The only exceptions are the evolved predecessor tests (§7.3), which the coordinator owns. The IDs are the acceptance checklist.

- **T-01 · Authority, `tests/security/inventory-movement-authority.test.ts`.**
  1. A direct `SELECT inventory_*()` as `daftar_app` with no carrier gives `assertion_missing`.
  2. An assertion of another S3 kind gives `wrong_operation`, one case per pair among the seven.
  3. Each bound field is tampered, one at a time (warehouse, second warehouse, variant, qty, cost, expected value, date, reason, outcome, `opening_balance_id`), giving `payload_mismatch` (PM-45).
  4. Replay in the same transaction and in another transaction gives `assertion_replayed`. A rolled-back first use followed by the identical payload is accepted (L:2004).
  5. Least authority from the catalogue: an `inventory.adjust` assertion cannot make the primitive write `transfer_in`. A fixture routine, installed in a rolled-back transaction as owner, calls the primitive after consuming `inventory.adjust`, and gets the primitive's mapping refusal.
  6. Raw `INSERT/UPDATE/DELETE` on each of the 12 tables as `daftar_app` gives `42501`.
  7. The grant matrix of A-18 is read from the catalogue.
  8. `stocktake_open`/`count` cannot reach the primitive.
  9. `daftar_platform`, `daftar_worker` and `daftar_provisioner` cannot execute any routine.
- **T-02 · Isolation, `tests/security/inventory-movement-isolation.test.ts`** (P:195, PM-18). For each of the seven routines:
  - **ALLOW:** the owner in A succeeds.
  - **DENY (same owner, other business):** an assertion for A with the scope GUCs of A′ gives `assertion_scope_mismatch`. An assertion for A naming A′'s warehouse or variant gives `*_not_found`, with A′'s counts unchanged.
  - **DENY (another tenant)** similarly.
  - **HTTP:** the same owner switches business and sees only the target business's result.
  - **Transfer:** W1 in scope and W2 not, as an assigned member, is refused `warehouse_out_of_scope` **before minting** (the minter is spied: zero calls). The reverse direction is also refused. A cross-business pair (A.W1 → A′.W1) is refused, with no movement and no entry (L:541).
- **T-03 · Transfer, `tests/integration/inventory-transfer.test.ts`.**
  1. GOLD-44's numbers reproduce (the `AL08-TRANSFER-GOLD44` vector).
  2. The business valuation delta is exactly 0.
  3. The source average is unchanged and the destination average is recomputed (P:190).
  4. Vector H (L:1405): emptying the source moves the flush, −7/+7.
  5. The minter spy shows **no accounting assertion minted**. `journal_entries` counts are equal before and after (P:193, P:197). Exactly one inventory assertion was consumed (the `inventory_assertion_uses` count +1).
  6. There is one audit and one outbox row.
  7. `source == destination` is refused.
  8. An archived destination is refused.
- **T-04 · Seam composition.** Covered inside T-03, T-06, T-07 and T-08. For each financial command, stock, journal, binding, audit and outbox appear in **one** commit, observed as one `xact` over every row via `pg_xact_commit_timestamp`-free means, i.e. the same `inventory_assertion_uses.xact` and `business_transaction_id` (P:192).
- **T-05 · The §E nine-state vector, `tests/integration/inventory-transfer-completeness.test.ts`.** Each state is refused **independently** by its named mechanism (L:1556-1566), using H-6: only out; only in; duplicate out; duplicate in; binding with no movement; movement with no binding; movement plus binding with no line; deleting a finalized line; editing a line's qty or warehouse. The SQL code is asserted for each.
- **T-06 · Adjustment and damage, `tests/integration/inventory-adjustment.test.ts`.**
  1. `AL08-ADJ-POS` and `AL08-ADJ-NEG` through the **real** commands.
  2. Entries: V > 0 posts `Dr 1200/Cr 5000`, V < 0 the reverse, the amount equals the stored integer, and there are zero 6100/6200 lines (L:688).
  3. GL Inventory = Σ `stock_levels.valuation_base_minor` = Σ movement values, re-proving S2C A-10/TL-4 with the real source (P:161/P:163).
  4. A zero-value quantity movement (vector C/D) posts **no** entry and goes through seam 1.
  5. Damage writes a negative kind and requires a reason. A missing reason is refused in the DTO, and in the primitive when called directly.
  6. A duplicate variant is refused.
  7. A positive line without a cost is refused.
  8. Over-issue gives `insufficient_stock`.
  9. The forged entry (H-2), `post inventory_adjustment` with no header, is refused at COMMIT with `accounting.inventory_detail_missing`. A header whose total differs from the entry gives `accounting.inventory_entry_mismatch`.
  10. `AccountingEngine.post` with `inventory_adjustment` gives `assertion_wrong_source`.
  11. The reversal guard: `POST /v1/accounting/…/reverse` of an inventory entry gives `accounting.reversal_source_domain_owned`.
- **T-07 · Stocktake, `tests/integration/inventory-stocktake.test.ts`.**
  1. Strict state machine: every `(from, to)` pair outside `draft→finalized` and `draft→cancelled` is refused, through commands **and** raw owner-level `UPDATE` under H-6.
  2. A second draft on the same warehouse is refused.
  3. PM-07: capture, then adjust **and** transfer on the same key, then finalize. The on-hand equals counted plus the intervening movements, exactly (P:196).
  4. Finalizing twice applies once: one movement per line, and the second response is `replayed`.
  5. A different finalize intent is refused.
  6. A positive variance on a key never valued gives `unit_cost_required` (P:196). With an explicit cost it is applied and audited. An explicit cost when an average exists gives `unit_cost_not_applicable`.
  7. A positive variance is valued at the **current** average: change the average between capture and finalize and assert the new one is used (L:664).
  8. A negative variance exceeding on_hand gives `insufficient_stock`.
  9. Finalized and cancelled lines refuse updates and deletes.
  10. Zero-variance lines produce no movement.
  11. An all-zero variance posts no entry.
  12. A count recorded after the finalize read gives `stocktake_changed`.
  13. Cancel produces no movement and no entry, and a cancelled stocktake cannot be finalized.
- **T-08 · Opening, `tests/integration/inventory-opening.test.ts`.**
  1. **Case A:** entry `Dr 1200` per warehouse / `Cr 3000`, and shares Σ = T. The allocation vectors are reproduced in SQL.
  2. **Case B exact:** no entry (**counted before and after**, P:198), `opening_balance_id` and the matched amount recorded in the header and audit.
  3. **Case B off by ±1 minor:** `opening_valuation_mismatch` with both totals in the details, and **no** movement, header or entry (counted, P:197).
  4. A second posted opening is refused.
  5. A race: the opening balance is posted with an inventory line between the service read and the routine, giving `opening_case_changed`.
  6. The A-14(c) guard: an opening balance with an inventory line posted after Case A gives `accounting.opening_balance_inventory_conflict`. Superseding a Case-B-bound opening balance gives `accounting.opening_balance_inventory_bound`.
  7. `posted → superseded` by raw update is refused (B-1 placeholder).
  8. Case A with T = 0 has no entry and goes through seam 1.
- **T-09 · Atomicity and crash injection, `tests/integration/inventory-movement-atomicity.test.ts`.** For each of the five financial paths, inject a throw (a) after the routine, before posting, and (b) after posting, before COMMIT. H-7 counts are then all equal to before: no movement, entry, binding, audit, outbox or assertion use (P:197, PM-10, PM-11). For the transfer, a throw after the routine leaves nothing.
- **T-10 · Concurrency, `tests/integration/inventory-movement-concurrency.test.ts`** (H-5).
  1. PM-03: opposite transfers A→B and B→A on the same variant both complete with no `40P01`.
  2. Two adjustments on one key: each succeeds or refuses `valuation_changed`/`insufficient_stock`. The cache equals the fold (`inventory_stock_verify`), and GL = Σ values.
  3. The same document id raced with an identical body: one 201 and one replay. With different bodies: one 201 and one `idempotency_conflict`.
  4. Two finalizes race: applied once.
  5. Opening vs opening-balance post: serialized, with exactly the A-14(c) outcome.
  6. Archive vs inbound movement on the same warehouse: serialized. Either the archive is refused, or the movement is refused `warehouse_archived`. There is never an archived warehouse with stock.
- **T-11 · Idempotency, `tests/integration/inventory-idempotency.test.ts`.**
  1. A replay returns byte-identical stored values, even after later movements change the average.
  2. **Proof before state:** drain the stock after an adjustment, then replay. The replay succeeds (a stock read would have refused), and the pre-read spy shows **zero** stock reads and zero mints.
  3. A conflict with a different intent.
  4. A replay caught inside the routine under seam 2 commits no entry, and its accounting assertion is unused (A-08).
  5. `document_id_conflict` between an adjustment and a stocktake id.
- **T-12 · Archival, `tests/integration/inventory-archival.test.ts`** (A-19). Archiving a warehouse, variant or product with stock gives `*_has_stock`, both via the command and via raw `UPDATE` as `daftar_app`. At zero it succeeds. A movement into an archived target is refused. Onboarding (`provision_create_business`) is still green.
- **T-13 · Source guards, `tests/integration/inventory-source-guards.test.ts`.** Under H-6, each strengthened check of A-16 is mutated in turn (disable a trigger, set `ENABLE REPLICA`, swap the function, move the trigger to `BEFORE`, drop the `WHEN`, drop the generated column, drop an FK, change the PK), and `inventory_stock_source_guard_gaps()` must report exactly the corresponding `missing` value.
- **T-14 · Predecessor predicates, `tests/integration/phase3-registry-evolution.test.ts`.** Each A-20 predicate accepts the real tree and rejects the injected unauthorized row (P:198).
- **T-15 · TD-13, `tests/integration/assertion-prune-nonblocking.test.ts`.** For **accounting**:
  1. Seed expired `accounting_assertion_uses` rows (owner).
  2. Connection 1 opens seam 2 for business A, posts (consumes, prunes, holds its row locks) and stays open.
  3. Connection 2, for business B of another tenant, posts within `lock_timeout 2s` and succeeds.
  4. After both commit, a third post removes the expired rows (the later prune happens).
  5. **Negative control:** as owner, restore the plain `DELETE` body in a transaction, run the same pair, get `lock_timeout` (55P03), then roll back the body.

  The same four cases run for **provisioning** with `provision_actor` via `provision_create_business` as `daftar_platform`. The catalogue asserts that owner, ACL and `proconfig` are unchanged, and that no privilege was added.
- **T-16 · Payload parity, `tests/security/inventory-payload-parity-s3.test.ts`.** TypeScript and SQL digests agree on every case of `invpl-s3-vectors.json`, intent digests included. `largestRemainder` equals `inventory_largest_remainder` on every allocation vector. `reasonWords` equals `inventory_reason_words`. `inventory_fixed_text` refuses inexact inputs.
- **T-17 · HTTP, `tests/security/inventory-movement-http.test.ts`.**
  1. Each route without its permission gives 403 before the service runs.
  2. A manager with only `inventory.view` gets 403 on all eight routes.
  3. The cashier gets 403.
  4. The owner succeeds.
  5. DTO strictness: JSON numbers, unknown keys, 201 lines, a missing `occurredOn` and a non-canonical UUID each give 400.
  6. Status codes and error classes match §3.
  7. The base variant never appears in a response.
  8. The trace id is propagated to audit rows.
- **T-18 · Budget A.** `tests/performance/accounting-budgets.test.ts` runs unchanged, with no parallel load (A-26).
- **T-19 · Upgrade and portability.** A new case is appended to `migration-upgrade.test.ts`, owned by the coordinator: frozen 0060 checkpoint plus an existing business with S2 state, upgraded to 0062. It checks books and catalog digests unchanged, the registries equal to exactly §2.5 and A-14(e), and a rerun is a no-op (P:279-283). `check:deployment-authority` is green, and `migration-portability.test.ts` appends the S3 functions to its owner and path list.
- **Package tests** (`packages/inventory/test/`): `movement-payloads.test.ts`, `allocation.test.ts` and `reason-digest.test.ts`, which cover the vectors, BigInt-only arithmetic and refusals. `packages/accounting` gets a `domain-posting` unit test covering the native-source refusal, the fingerprint equality with `computeCommandFingerprint`, and the absence of any branch-scope call.

---

## 7. Gate, guards and predecessor evolution

### 7.1 `scripts/phase3-s3-gate.ts` (two tenses, the form of `phase3-s2-gate.ts:1-260`)

**Constants.**
- `S2_BOUNDARY = '0060_inventory_stock_primitive.sql'`
- `S3_MIGRATIONS = ['0061_inventory_movement_sources.sql', '0062_inventory_movement_commands.sql']`
- `S3_ACCEPTED: Record<string,string> = {}`, filled only in the freeze commit
- `ACCEPTED = Object.keys(S3_ACCEPTED).length > 0`

**1. Migration boundary.**

| Tense | Checks |
|---|---|
| Candidate | `frozenThrough === S2_BOUNDARY`; neither S3 file is in the manifest ("premature freeze"); the files after 0060 are exactly `S3_MIGRATIONS` |
| Accepted | `frozenThrough ≥ '0062…'`; each file hashes to `S3_ACCEPTED` on disk **and** in the manifest; the range `0061–0062` holds exactly the two files. A successor after 0062 is not this gate's business |

**2. Scope, over the S3 files only, with comments stripped via `stripComments`.**
- `INSERT INTO stock_source_types` names exactly the four S3 types.
- `INSERT INTO inventory_operation_kinds` names exactly the seven S3 kinds.
- `INSERT INTO inventory_operation_movement_kinds` is exactly the §2.5 set.
- `INSERT INTO accounting_source_types` is exactly the two, and `accounting_operation_kinds` exactly the two pairs.
- No `INSERT INTO stock_movement_kinds`.
- No S4+ table: `purchase\w*`, `supplier\w*`, `negative_inventory_cost_adjustments`, `payment_methods`, `landed_cost\w*`.
- No `reserved`/`available` column.
- `GRANT EXECUTE` appears only as `TO daftar_app` on the seven entry routines, and `TO daftar_inventory_internal` on `accounting_inventory_opening_position(uuid)`.
- No `INHERIT`, `BYPASSRLS`, `ALTER ROLE` or `GRANT daftar_` role membership.
- No `EXECUTE` inside any function body in either file (G-7 also enforces this).

**3. Required objects** (a `REQUIRED_OBJECTS` table as in `phase3-s2-gate.ts:88-122`):
- the eight tables and four bridges;
- every §2.3 trigger by name;
- the seven routines and three helpers;
- the TD-13 pattern: both `pg_try_advisory_xact_lock(hashtext('daftar.accounting_assertion_uses'` and `…provisioning_assertion_uses` present in 0061, and no unguarded `DELETE FROM (accounting|provisioning)_assertion_uses` outside an `IF pg_try_advisory_xact_lock` block;
- `SET LOCAL ROLE daftar_accounting_internal;[\s\S]*?CREATE OR REPLACE FUNCTION accounting_actor\(`;
- the strengthened gaps function, found by the presence of `tgtype`, `tgfoid` and `attgenerated`;
- both CREATE brackets (`GRANT CREATE ON SCHEMA public TO daftar_(inventory|accounting)_internal` … `REVOKE`).

**4. Packages.** The existence of `movement-payloads.ts`, `allocation.ts`, `reason-digest.ts`, `vectors/invpl-s3-vectors.json` with their exact case ids, `vectors/allocation-vectors.json`, and `packages/accounting/src/domain-posting.ts`. There is no framework or driver import in `packages/inventory/src/**`.

**5. Suites.** Every T-file of §6 exists. Also discovered: every `inventory-movement-*`, `inventory-transfer*`, `inventory-adjustment*`, `inventory-stocktake*`, `inventory-opening*` and `assertion-prune-*` suite.

**6. The runner can still fail.** The same probe as S2.

**7. Composition.** Run `npm run gate:phase3:s2`, which composes `gate:phase3:s1` and back to Phase 1 (SM:79). S2 must be in its **accepted** tense (TL-2).

**8. Run** every S3 suite, then `tests/performance/accounting-budgets.test.ts` in isolation.

- **`package.json`:** `"gate:phase3:s3": "tsx scripts/phase3-s3-gate.ts"`, added next to the two existing lines (`package.json:55-56`).
- **Failing conditions of P:293** that map to checks here: missing migrations (§1), a migration beyond the boundary (§1), a premature freeze (§1), a changed `0000`–`0052` (via the composed Phase 2 release protection), a missing required object (§3), runtime DML on a truth table (0061-E and T-01), an absent physical refusal (T-05, T-13), and a predecessor regression (§7).

### 7.2 Guards

No guard is weakened. S3 needs **no guard code change**, because each guard discovers from the schema.

| Guard | Effect of S3 |
|---|---|
| G-7 `inventory-definer-contract.ts` | Discovers the new internal routines. Requirements: definer (the two invoker exceptions stay two), pinned path, PUBLIC revoke in the same file, no `EXECUTE`, and the handover bracket. |
| Rule 22 `inventory-writer-authority.ts:25` | Its table regex already includes `stock_source_bridge_\w+`. Every S3 routine that writes a bridge (all producing routines) has consume as its first statement. The document tables are **not** in the regex. **ENG+TL:** the S3 guards agent may extend the regex to the eight tables, which strengthens it. |
| G-5 `definer-search-path.ts` | `pg_temp` is last everywhere, including the preserved provisioning path. |
| G-4 `posting-surface.ts` | No new journal writer. `accounting_actor` text is still present (`:83`). |
| G-1 `journal-privilege-model.ts` | No change to `INTENDED_TABLE_GRANTS`, because S3 grants nothing on accounting tables (A-14(d)). |
| Rules 6, 7, 21 | Money columns are `BIGINT`/`NUMERIC(28,10)` cost only, there is no `stock` alias, and HALF_EVEN is `inventory_half_even` only. |
| `no-float-rate.ts` | No float anywhere. |

### 7.3 Predecessor evolution and sequencing

- **Precondition (TL-2).** P3-S2 is accepted and frozen. That means `S2_ACCEPTED` is filled, the manifest's `frozenThrough ≥ 0060`, and `gate:phase3:s2` is green in its accepted tense, before the commit that adds 0061. At `ac1382f` the S2 gate is still a candidate (`phase3-s2-gate.ts:67`, `S2_ACCEPTED = {}`) and the S2 ledger test agent is still running. S3 migrations must not land before that.
- **Evolutions.** A-20 rows 1–7, all by the coordinator, each in the same commit as the migration that turns it red:
  - rows 1–4 with 0061 (or with 0062 for row 4's movement-kind half);
  - rows 5–6 with whichever migration adds the grant or routine;
  - row 7 with the package change.
- **The upgrade test** gains the new S3 case (T-19). The S2 case's counts become the row-4 predicate.
- **Phase 2 release protection** (`gate:phase2:release`) covers `0000`–`0052` and permits later migrations (SM:79). It is unaffected.

---

## 8. File ownership (SAFE_CONCURRENCY = 5, SM:41)

| Agent | Owns (writes) | Must not touch |
|---|---|---|
| **C: coordinator** | this contract; `infrastructure/database/MIGRATION_MANIFEST.json` (the freeze commit only); `bootstrap.sql` if needed (nothing expected); every A-20 predecessor evolution (`tests/integration/migration-upgrade.test.ts`, `tests/golden-regression/phase2/01-engine-shapes.golden.test.ts`, `tests/security/accounting-sources-authority.test.ts`, `tests/security/inventory-db-authority.test.ts`, `tests/integration/inventory-db-guard.test.ts`, `packages/inventory/test/payload.test.ts`, the appended rows in `tests/integration/migration-portability.test.ts`); `scripts/phase3-s3-gate.ts` and the `package.json` script line; `TECHNICAL_DEBT.md` (TD-13 → closed with evidence); `PROJECT_STATUS.md`; `docs/PHASE_3_S3_ACCEPTANCE.md` | migrations; `src/**` |
| **M: migration writer** (the only schema writer, SM:36) | `infrastructure/database/migrations/0061_inventory_movement_sources.sql`, `0062_inventory_movement_commands.sql` | everything else |
| **D: domain/application and packages** | `packages/inventory/src/{movement-payloads,allocation,reason-digest}.ts`; the additive edit of `packages/inventory/src/payload.ts` and `src/errors.ts` (coordinator sign-off: S1 files); `packages/inventory/vectors/{invpl-s3-vectors,allocation-vectors}.json`; `packages/inventory/test/{movement-payloads,allocation,reason-digest}.test.ts`; `packages/accounting/src/domain-posting.ts` with its index export and unit test, and the additive `post.ts` refusal (TL-10); `apps/api/src/modules/inventory/{inventory-transfer,inventory-adjustment,inventory-stocktake,inventory-opening}.service.ts`, `inventory-stock-read.ts`, `inventory-posting.ts`; the evolutions of `inventory-authorization.ts` and `inventory-errors.ts`; the `catalog.service.ts` archive pre-check | controllers, DTOs, module wiring, tests outside `packages/*/test` |
| **A: API** | `apps/api/src/modules/inventory/inventory-movements.controller.ts`, `inventory-movements.schemas.ts` (zod DTOs); wiring in `apps/api/src/app/app.module.ts` and `merchant-api.module.ts`; `packages/shared-contracts/src/inventory.ts` (response types, money as string) with its `index.ts` export | services, migrations, tests |
| **T: tests** | `tests/helpers/inventory-commands.ts`, `tests/helpers/inventory-posting.ts`; every new T-file of §6 (T-01…T-17, T-19's new files except the coordinator-owned evolutions) | predecessor tests (they belong to C), `src/**`, migrations |

**Merge order** (SM:64: contracts, schema, domain, application, infrastructure, API, UI, adversarial tests, docs):
1. **C:** this contract, and the S2 freeze (TL-2).
2. **M:** 0061, together with C's A-20 rows 1–5 (one commit, green). Then 0062 with rows 4 (mappings half) and 6.
3. **D:** packages (with row 7), then services.
4. **A:** controllers and DTOs.
5. **T:** adversarial and integration suites. T may start writing against the contract after step 2, and runs embedded PostgreSQL alone on its `PG_DIR`/`PG_PORT` (SM:36).
6. **C:** gate, acceptance page, TD-13 closure, then the independent security review (SM:49), then the freeze commit (manifest and `S3_ACCEPTED`).

---

## 9. Tech Lead notes and blockers

### 9.1 Real blockers

**B-1 · Correcting a posted inventory opening (`posted → superseded`, L:724) is an architectural contradiction plus a product ambiguity.** It does **not** block S3 acceptance: it is absent from P:181-198's Delivers and Must-prove lists.

The exact reasons:
1. **No operation kind exists for it.** L:1912-1922 is a closed list of seven S3 kinds, and P:175 says S3 "registers exactly its own operation kinds". Each routine accepts exactly one kind (L:1926). Supersession is a distinct command, and there is no kind to sign it.
2. **No movement kind can express it under the registries as locked.** The inverse of `inventory_opening`, which is `positive` (`0059:85`), needs a negative kind mapped to the opening operation (for example `adjustment` under `inventory_opening`). The lock names no such mapping (L:1992 requires each mapping to be registered by the owning slice), and the opening line's required movement set (L:1541-1542 by analogy) would change.
3. **The lock does not say what happens when stock has moved since the opening.** "Stock detail removed by inverse movements" plus "Case A's journal reversed" (L:724) only agree when the inverse movements' values equal the original values. After any sale-free movement (a transfer, adjustment or stocktake), the outbound HALF_EVEN of the inverse at the current average ≠ the opening share, so the reversal amount ≠ Σ inverse values, which breaks L:1350-1356 (equation (3)) and PM-16. Choosing between these is a product decision about whether a merchant who has already operated may ever correct opening stock:
   - (a) refuse unless every opening key is untouched since its opening movement;
   - (b) post the difference to COGS;
   - (c) forbid supersession after any movement.

**Interim effect.**
- S3 ships the `superseded` state and the physical refusal (`inventory.opening_state_invalid`).
- It refuses to supersede an accounting opening balance that a Case B inventory opening is bound to (A-14(c)).
- A wrong opening can still be corrected operationally with a reasoned adjustment (PM-07's recovery).

**Needed.** A lock amendment that registers an eighth kind (for example `inventory.opening_supersede`), its movement mapping, and precondition (a), (b) or (c).

No other blocker exists:
- OD-03 (tax) is bounded to S4 (SM:70).
- TD-12 belongs to S8.
- TD-14 is outside Phase 3.
- No paid provider, external credential, legal or tax rule, or destructive data decision is involved.

### 9.2 Tech Lead notes (engineering rulings that should be confirmed)

- **TL-1 · F-4 undercounts.** F-4 names two pins (L:116-121). The tree holds at least seven that 0061/0062 turn red (A-20 rows 1–7), and one sequencing constraint (row 8). The third accounting pin, `accounting-sources-authority.test.ts:106-116`, follows necessarily from `0046:111-115`: registering a source type forces an operation-kind row. All are evolved by the same P2-S4 §45 rule.
- **TL-2 · Sequencing.** S2 is not yet accepted at `ac1382f`: `S2_ACCEPTED = {}` at `phase3-s2-gate.ts:67`, and the S2 ledger test agent is still running. S3 migrations wait for the S2 freeze. Otherwise `gate:phase3:s2`'s candidate boundary (`:202-214`) goes red on 0061.
- **TL-3 · Stocktake cancel uses `inventory.stocktake_finalize` with a signed `outcome` (A-11).** The alternative, an eighth kind `inventory.stocktake_cancel`, contradicts P:175 and L:1912-1922. If the Tech Lead prefers the eighth kind, it is a lock amendment and a one-routine change.
- **TL-4 · Reason binding as eight uint32 words of SHA-256 (A-09).** This keeps the locked four-type grammar. A lock amendment adding a `text` field type would be cleaner, and would change only the S3 reason fields.
- **TL-5 · Optimistic valuation (A-07).** Under contention on one key, posting commands may return 409 `inventory.valuation_changed`. A bounded server-side retry (re-read, re-mint, same document id) is possible later without schema change. It was not added, following PM-03's warning against retry loops hiding defects.
- **TL-6 · Accounting-side guards (A-14(b), (c)).** These add refusals to accepted Phase 2 workflows (reversal; posting and superseding an opening balance). Each fires only on states that cannot exist before S3, so no accepted behaviour or test changes. They are what keeps GL Inventory = Σ movement values (L:1354-1356).
- **TL-7 · Domain-owned accounting sources are a hard-coded list** in the reversal-guard function. S4–S6 extend it by `CREATE OR REPLACE` in their own migrations. A data column on `accounting_source_types` would be cleaner but alters a Phase 2 table.
- **TL-8 · 200 lines per document (A-24)** is an engineering bound, not product law.
- **TL-9 · `provision_actor` keeps its effective path `public, pg_catalog, pg_temp`** rather than being normalized to `pg_catalog, public, pg_temp`. TD-13 changes only the prune, and normalizing would change name resolution in an accepted security function. G-5 is satisfied either way.
- **TL-10 · The additive `DOMAIN_SOURCE_TYPES` refusal in `AccountingEngine.post`** (`post.ts:218` neighbourhood) touches an accepted Phase 2 file. It is optional, since the database triggers are the invariant. It turns a COMMIT-time failure into an immediate typed refusal, exactly as `NATIVE_SOURCE_TYPES` does.
- **TL-11 · S2's TL-4 re-proof** (S2C:1442) is discharged by T-06.3 with the real `inventory_adjustment` source.
- **TL-12 · Net journal lines.** A mixed-sign adjustment or stocktake posts one net Inventory/COGS pair (A-05, A-12), as L:1352 states literally. A report that needs gross gain/loss reads the movements, not the journal.
- **TL-13 · Openings read `accounting_opening_balances` twice.** The application reads through `daftar_app`'s accepted `SELECT` to pre-compute and bind. The routine reads through the accounting-owned function, under an advisory lock shared with the opening-balance guard, to verify. The bound pair makes a stale read a refusal, never a double count.
