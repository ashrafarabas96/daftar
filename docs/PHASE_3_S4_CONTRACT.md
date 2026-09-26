# DAFTAR — P3-S4 Contract / عقد الشريحة P3-S4

> **Coordinator rulings on this contract (2026-09-26).** Adopted as the P3-S4 implementation contract. The Tech Lead notes of §9.2 are adopted as engineering rulings: TL-3 (`supplier.reactivate` as its own kind), TL-4 (supplier mutations permission-only; the payable read needs business-wide scope, the F4 precedent), TL-5 (a zero catch-up writes no movement), TL-6 (the zero-crossing flush), TL-7 (one coverage header per receipt), TL-8 (`purchase.total_zero`), TL-9 (discounts per line only), TL-10, TL-11 and TL-12. TL-1 and TL-2 are sequencing facts: P3-S3 was frozen before 0063 (the P3-S3 freeze commit), and every predecessor pin is evolved in the same commit as the migration that turns it red. The FX instant is the last second of `document_date` in the business timezone (TL-2). **B-1** is disposed of by **R-B1** as the default: seam 2 takes a non-empty ordered tuple of accounting assertions, each coherence-checked before a connection is taken, each set for exactly one posting and each single-use, with a typed refusal for an unused or a missing assertion. The single-element form is today's seam, no SQL changes, and the lock's rule that one assertion authorizes one journal entry is kept. It is an amendment of the seam's signature (P3-AL-32 item 2), so the Tech Lead's confirmation is requested in the thread; if it is refused, a receipt whose coverage net is non-zero is refused with a typed error and the rest of P3-S4 ships unchanged. **OD-03** stays bounded: a non-zero purchase tax is refused with `purchase.tax_policy_absent`, and every tax element is marked BLOCKED BY OD-03 (A-12).
>
> **ملخص.** عقد تنفيذ الشريحة P3-S4: الموردون، والمشتريات من المسودة إلى الاستلام، والتكلفة المُحمَّلة، وقيد `Dr Inventory / Cr AP` عند الاستلام، ولقطة سعر الصرف، وتغطية العجز السالب بنموذج الرأس/التفاصيل، وقراءات الذمم الدائنة الحيّة من الدفتر. الضريبة غير الصفرية مرفوضة (OD-03). العائق الحقيقي الوحيد (B-1): بوابة المعاملة المحاسبية تحمل تأكيدًا محاسبيًا واحدًا، بينما الاستلام الذي يغطي عجزًا يُرحِّل قيدين في معاملة واحدة.

> **Status.** Candidate contract for P3-S4, written by the S4 contract agent against branch `phase/3-inventory-purchases-suppliers`, local tip `ed3e7b0`, re-checked at `69ba547` (15 later P3-S3 test-only commits, which only add new files, so every existing pin line holds; they add pin 23). At `ed3e7b0`, P3-S3 (0061/0062) is an **unfrozen candidate**: `MIGRATION_MANIFEST.json` `frozenThrough` is `0060_inventory_stock_primitive.sql` and `scripts/phase3-s3-gate.ts:58` has `S3_ACCEPTED = {}`. This contract is analysis only. No repository file was changed, and PostgreSQL was not started.
>
> **Sources, in order of authority:**
> 1. Code and migrations `0000`–`0062`. 0059–0062 were read in full.
> 2. Tests.
> 3. `docs/PHASE_3_ARCHITECTURE_LOCK.md`. The lock wins over every other document.
> 4. `docs/PHASE_3_EXECUTION_PLAN.md`, §6 and §12–§14.
> 5. `PREMORTEM`, `SLICE_MAP`, `TECHNICAL_DEBT.md` and `DAFTAR_OPEN_DECISIONS.md`.
>
> **Shape.** It mirrors `docs/PHASE_3_S3_CONTRACT.md` (S3C):
> - §0 conventions
> - §1 rulings
> - §2 database contract
> - §3 error model
> - §4 packages and application
> - §5 harness
> - §6 test plan
> - §7 gate, guards and predecessor evolution
> - §8 file ownership
> - §9 real blockers and Tech Lead notes

---

## 0. Conventions

- **Citations.** Every S3C prefix carries forward: `L:` lock, `P:` execution plan, `SM:` slice map, `PM-nn`, `TD-nn`. S4 adds two more:
  - `S3C:` means `docs/PHASE_3_S3_CONTRACT.md`.
  - `IR:` means `docs/DAFTAR_INVENTORY_RULES.md`.
- **Ruling classes.** These are exactly those of S3C §0:
  - **ENG** is an engineering ruling. It binds the implementers.
  - **ENG+TL** is an engineering ruling the Tech Lead should confirm (§9.2). Implementers follow it until overruled.
  - **BLOCKER** is used only for:
    - a product-constitution ambiguity;
    - a legal or tax rule;
    - a paid provider;
    - an external credential;
    - a destructive data decision;
    - an architectural contradiction.
- **Carried forward unchanged from S3C §0.**
  - **SQL refusals:** `'<domain>.<code>: <safe text>'`, `ERRCODE 'P0001'`, and the message carries no amounts.
  - **The definer contract (G-7):**
    - `SECURITY DEFINER`;
    - `SET search_path = pg_catalog, public, pg_temp`;
    - `REVOKE ALL … FROM PUBLIC` in the same file;
    - no dynamic `EXECUTE`;
    - the handover inside a `GRANT/REVOKE CREATE ON SCHEMA public` bracket.
  - **The migration principal** is never widened.
  - **RLS** follows the `stock_movements` layering (`0059:311-359`).
  - **Types:** quantity is `NUMERIC(18,4)`, cost `NUMERIC(28,10)`, and value `BIGINT` minor.
  - **Rule 21:** no `round(`, and HALF_EVEN is always `inventory_half_even` (`0060:83`).
- **New domain prefixes.** S4 raises refusals under `purchase.*` and `supplier.*`, next to `inventory.*` and `accounting.*`.
- **Frozen history.**
  - `0000`–`0060` are frozen.
  - 0061/0062 are frozen by the P3-S3 freeze commit **before** 0063 lands (§7.3, TL-2).
  - S4 edits no earlier migration. Every earlier function it changes is replaced by `CREATE OR REPLACE` in a new migration, by that function's owner:
    - the migrator for `inventory_stock_source_guard_gaps()` (`0061` §2);
    - `SET LOCAL ROLE daftar_accounting_internal` for `accounting_reversals_20_domain_source_guard()` (`0061:1444-1470`).
- **The global lock order is the 0061 R-13 header (`0061:47-80`), extended and never reordered (R-15, §2.2).**

---

## 1. Rulings

### A-01 · Slice scope and object inventory (ENG)

**In scope** (P:205, L:459-512, L:729-855):
- suppliers with the `active ⇄ inactive` lifecycle and receipt-time snapshots (L:1191-1200);
- purchases `draft → received | cancelled` (L:729-743);
- one line per variant (L:764-771);
- landed cost `by_value` | `manual` with largest remainder (L:775-791);
- the zero-tax bound (L:793-808);
- the receipt posting `Dr Inventory(1200) / Cr AP(2000)` (L:810-828);
- the purchase FX snapshot (L:830-841);
- deficit coverage inside the receipt through the header/detail model (L:476-512);
- live, ledger-derived AP reads (L:843-854, L:1256-1263);
- the registrations `purchase` and `negative_inventory_cost_adjustment` in **both** registries (L:1034-1060);
- seven `invctl/1` operation kinds (L:1926, A-03).

**Out of scope, each owned elsewhere:**

| Item | Owner |
|---|---|
| purchase reversal and `reversed` state (L:747-760) | S5 |
| supplier return, PPV `6200`, supplier credit `1150` | S5 |
| `payment_methods`, supplier payments, allocations, realized FX `4900/6900` | S6 |
| merchant UX, screens, statements, ageing | S7 |
| any cache or summary of AP (L:1260-1262) | never in Phase 3 |
| **non-zero purchase tax, any tax rate, inclusive/exclusive rule, tax posting** | **BLOCKED BY OD-03** (A-12) |
| a third-party landed-cost invoice, a cross-document freight allocation, a post-receipt landed-cost adjustment (L:790) | not Phase 3 |
| an FX revaluation of open AP | **OD-07**, not Phase 3 |
| a document-level (header) discount | not S4; see TL-9 |

### A-02 · Migration plan: exactly two migrations, 0063 then 0064 (ENG)

| # | File | Holds |
|---|---|---|
| 1 | `0063_purchases_suppliers_sources.sql` | all **structure**: the supplier, purchase, line, landed-cost and allocation tables; the adjustment header; the coverage and deficit additions; the two bridges and every stock-side guard; the replaced gaps function; the two stock source registrations; the accounting-side objects (FX read, completeness triggers, replaced reversal guard) and the two accounting registrations; grants and RLS; **0063-E** |
| 2 | `0064_purchase_commands.sql` | the seven signed entry routines and three internal helpers; EXECUTE grants and ownership transfer; the seven operation kinds and the two op→movement mappings, **last**; **0064-E** |

**Why two, and why not one or three.** Two is the S3 split (S3C A-02), and it keeps the same guarantees.
- **Sources before commands.** The registry is not allowed to outrun its guards (L:1514). So 0063 registers the two stock source types only after the bridges, triggers and replaced gaps function exist. 0063-E proves `inventory_stock_source_guard_gaps()` returns no row, including by rolled-back mutation, before any routine can produce a movement.
- **No kind before its routine.** A registry row claims that a routine exists to consume it (L:1926). So the operation kinds go last in 0064, after the routines they name.
- **One migration** would mix a structural review with a command review, and would put the guard proof and the command proof in one end-state block.
- **A third migration** (for example, accounting objects separately) buys nothing. The accounting objects must exist before the registrations of 0063, because 0046's rule requires a `post` kind per accounting source type (`0046:111-115`). The completeness triggers must also exist before any command can post.
- **No placeholder migration exists.**
- **Numbering.** 0063 lands only after P3-S3 is accepted and frozen (TL-2). Otherwise `gate:phase3:s3`'s candidate tense ("after 0060 exactly 0061, 0062", `phase3-s3-gate.ts:214-221`) goes red.

### A-03 · Operation kinds: seven, one per command (ENG; the supplier pair is ENG+TL, TL-3)

The kinds follow L:1926: "supplier create/update/archive, purchase draft/receive/cancel … one kind per command, named for the command". AL-40 adds reactivation ("Lifecycle is `active ⇄ inactive` … Reactivation requires `suppliers.manage`", L:1195-1197). Reactivation is a command, so it gets its own kind rather than a signed direction flag. TL-3 is the S3 alternative.

| `op_code` | Routine | Permission (L:1122-1140) | Scope (L:1174-1186) | Seam |
|---|---|---|---|---|
| `supplier.create` | `supplier_create` | `suppliers.manage` | none: suppliers are business data (TL-4) | 1 |
| `supplier.update` | `supplier_update` | `suppliers.manage` | none | 1 |
| `supplier.archive` | `supplier_archive` (`active → inactive`) | `suppliers.manage` | none | 1 |
| `supplier.reactivate` | `supplier_reactivate` (`inactive → active`) | `suppliers.manage` | none | 1 |
| `purchase.draft` | `purchase_save_draft` (create or replace a draft) | `purchases.manage` | the draft's warehouse, **and** the previous warehouse when a replace moves it | 1 |
| `purchase.cancel` | `purchase_cancel` (`draft → cancelled`) | `purchases.manage` | the draft's warehouse | 1 |
| `purchase.receive` | `purchase_receive` (`draft → received`) | `purchases.receive` | the draft's warehouse | 2, always (A-08) |

**Op→movement-kind mappings** (L:1992: "each mapping registered by the owning slice"):
- `('purchase.receive','purchase')`
- `('purchase.receive','negative_inventory_cost_adjustment')`

No other S4 kind maps to a movement kind. No new `stock_movement_kinds` row is added, because both kinds exist since P3-S2:
- `purchase` is `positive`;
- `negative_inventory_cost_adjustment` is `zero` (`0059:78-95`).

### A-04 · Documents and state machines (ENG)

**Supplier** (L:1191-1200). States are `active ⇄ inactive`.
- There is **no delete**. There is no command for it and no `DELETE` grant. A `BEFORE DELETE` trigger refuses it (`supplier.not_deletable`), and the purchases' FK is `ON DELETE RESTRICT`.
- An inactive supplier:
  - stays readable;
  - is refused by `purchase.draft`;
  - is refused by `purchase.receive` (`purchase.supplier_inactive`).
- `revision` starts at 1 and each update/archive/reactivate adds 1. The command binds `expected_revision` (optimistic; `supplier.revision_changed`, 409).
- The live row holds the current name and contacts. Documents hold snapshots (A-11).

**Purchase** (L:729-743):

```
(none) --purchase.draft (expected_revision 0)--> draft(revision 1)
draft(r) --purchase.draft (expected_revision r)--> draft(r+1)       -- replace: header, lines, landed costs, allocations
draft(r) --purchase.receive (draft_revision r)--> received            -- terminal in S4 (S5 adds received → reversed)
draft(r) --purchase.cancel (draft_revision r)--> cancelled            -- terminal
```

- **A draft** carries no movement, no journal entry and no AP (L:737). It is editable only by a full replace through `purchase.draft`: all lines, landed costs and allocations are deleted and re-inserted in one routine call.
- **Line and landed-cost ids** are client-supplied canonical UUIDs, so a line keeps its `id` across replaces (L:767).
- **`received`**: every financial field of the header, the lines, the landed costs, the allocations and the supplier snapshot refuses `UPDATE` and `DELETE` by trigger (L:738, §2.3).
- **`cancelled`** refuses every change.
- **No** `ordered`, `approved`, partial delivery, or GRNI (L:739-742).

**Negative-inventory cost adjustment (the coverage header).** It is written only inside a receipt, as an insert-only row, and it has no state machine (A-10).

### A-05 · Accounting source mapping and journal shapes (ENG)

| Accounting source | `source_id` | Entry (all lines by `system_key`) | Dimensions | When |
|---|---|---|---|---|
| `purchase` | the purchase id | `Dr inventory` T/B and `Cr accounts_payable` T/B. One line each. Txn amount T in the purchase currency, base amount B | Inventory line: `warehouse_id` = the purchase warehouse, `branch_id` = its home branch. AP line: `branch_id` = the home branch, `warehouse_id` NULL | **every** receipt (T > 0, A-13) |
| `negative_inventory_cost_adjustment` | the coverage header id | N = Σ stored coverage movement values (signed). N < 0 posts `Dr cogs |N| / Cr inventory |N|`; N > 0 posts `Dr inventory N / Cr cogs N`. Domestic lines in base | both lines: the warehouse and its home branch (S3 `adjustmentPostingCommand` precedent, `inventory-posting.ts:81-102`) | only when N ≠ 0 |

- **One accounting model** for cash and credit purchases (L:814-828). "Paid immediately" is an S6 payment plus allocation, never a second path (PM-22).
- **No `6100`** (rounding) and **no `6200`** (PPV) line ever appears on an S4 entry (P:207, L:1384-1400).
- **No `tax_payable`** line ever appears (A-12).
- **`entry_date`** is the purchase's `document_date` for both entries.
- **Registrations (in 0063, after every guard):**

```sql
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('purchase',                           'none', 'not_after_today', 'A received supplier purchase: Dr Inventory / Cr Accounts Payable (P3-AL-24).', 6),
  ('negative_inventory_cost_adjustment', 'none', 'not_after_today', 'The catch-up of covered negative-inventory deficits against COGS (P3-AL-13).', 7);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'purchase',                           'Purchase receipt; derived by the purchase command.'),
  ('post', 'negative_inventory_cost_adjustment', 'Deficit catch-up; derived by the purchase receipt.');
INSERT INTO stock_source_types (source_type, registered_by) VALUES
  ('purchase', 'P3-S4'), ('negative_inventory_cost_adjustment', 'P3-S4');
```

The policies are the lock's (L:1038-1048): `none` / `not_after_today`, uniformly.

### A-06 · The posting route: the generic primitive, twice in one transaction (ENG; the seam change is **B-1**)

- Both entries post through the existing `AccountingPostingTransactionPort.postEntryInTransaction` (`apps/api/src/modules/accounting/accounting-posting.adapter.ts:56-84`) on seam 2's handle. That port calls `accounting_post_entry` (`0045:489-800`), the only journal writer.
- There is no new journal writer, no direct `journal_*` DML and no second signer (TD-10). Both accounting assertions are minted by `merchant-api`'s `AccountingAssertionMinterService`, via `mintDomainPostingAssertion` (`packages/accounting/src/domain-posting.ts`).
- `DOMAIN_SOURCE_TYPES` (`packages/accounting/src/post.ts:200`) becomes `['inventory_adjustment','inventory_opening','purchase','negative_inventory_cost_adjustment']` (S3 TL-10, additive).
- **Order inside the transaction:**
  1. the routine;
  2. the `purchase` entry;
  3. then, iff N ≠ 0, the `negative_inventory_cost_adjustment` entry;
  4. COMMIT.
- **Two entries need two accounting assertions.** An assertion names one `source_type`, one `source_id` and one `acctfp/1` fingerprint (`0061:120-200`, the replaced `accounting_actor`). Seam 2 carries exactly one (`apps/api/src/infra/database.ts:468-483`, L:976). That is **B-1**. The recommended resolution (R-B1, §9.1) changes only the application seam and the posting adapter, and no SQL.

### A-07 · Bound, pre-computed amounts; the optimistic receipt (ENG, S3C A-07 carried forward)

The accounting assertions are minted **before** seam 2 opens (S3C A-07). The receipt therefore binds into its `invpl/1` payload every amount the database will later store. The routine recomputes each from locked state and refuses on any difference.

| Bound value | Computed by the service from | Recomputed by the routine from | Refusal on difference |
|---|---|---|---|
| `draft_revision`, and each line's `line_id`, `variant_id`, `qty_q4` | the stored draft (RLS read) | the draft row `FOR UPDATE` | `purchase.draft_changed` (409, re-read) |
| `supplier_revision` | the supplier row | the supplier row `FOR SHARE` | `purchase.supplier_changed` (409) |
| `rate_id`, `rate_r10`, `rate_source`, `rate_at` | `accounting_fx_rate_lookup` through `daftar_app` (`0048:616-662`, `apps/api/src/modules/accounting/accounting-fx.adapter.ts:60-64`) | `accounting_purchase_fx_rate` (A-14(c)) | `purchase.fx_rate_changed` (409) |
| `total_txn_minor`, `total_base_minor`, each line's `base_share_minor` | the draft plus A-09/A-13 arithmetic | the same arithmetic in SQL | `inventory.valuation_changed` (409) |
| `coverage_adjustment_id`, and each line's `covered_q4` and `catch_up_minor` | open deficit layers and the `stock_levels` row, both read by `daftar_app` (A-18), with `@daftar/inventory` coverage arithmetic (A-10) | the layers `FOR UPDATE` under the stock-key lock | `inventory.valuation_changed` (409, same body) |

- **No server retry** (S3 TL-5).
- **A receipt that covers no deficit** depends on no stock state. Its purchase movement carries a supplied value (`0060:398-418`). A concurrent receipt on the same key can therefore only make it **wait**, never refuse.
- **Only a coverage** is optimistic. Only coverage can race, and the loser gets a clean 409 with nothing committed.

### A-08 · Seam choice (ENG)

| Command | Seam | Accounting assertions |
|---|---|---|
| `supplier.*`, `purchase.draft`, `purchase.cancel` | 1 (`withBusinessInventoryTransaction`) | none. Nothing is posted (L:981) |
| `purchase.receive` | 2 (`withBusinessInventoryAccountingTransaction`) | the `purchase` assertion always, since T > 0 (A-13); plus the catch-up assertion iff the bound N ≠ 0 (B-1) |

- The seam is chosen from the server-computed totals, never from a request field (L:984-985).
- **Replay.** A replay inside the routine commits no entry. Its minted assertions expire unused, as in S3C A-08 and T-11.4.

### A-09 · `invpl/1` field lists (ENG; text binding is S3 TL-4)

**Encoding.** Exactly S3C A-09. There are four types (`uuid`, `boolean`, `integer`, `code`; `0054:195-212`), and NULL is `0x00`. The formats are:
- **Q4:** quantity × 10⁴.
- **C10:** cost or price × 10¹⁰.
- **Integers** for minor amounts.
- **`YYYYMMDD`** dates.
- **Text:** eight uint32 SHA-256 words through `inventory_reason_words` (`0062:95-115`), eight NULLs for NULL text. Text is trimmed and empty text is NULL before binding.
- **Framing:** each `…_count` integer frames a fixed-width group.

S4 adds three encodings, all of them integers or codes:
- **currency** is `code`: the ISO code in **lowercase** (`usd`). The `code` grammar is `^[a-z][a-z0-9_]{0,31}$` (`0054:205`). The routine compares `upper(value)` with its `CHAR(3)` argument.
- **rate** is `integer` R10: the rate × 10¹⁰, exact, because `NUMERIC(20,10)` (`0048:87`).
- **rate instant** is `integer`: epoch seconds, exact, because `fx_rate_at` has second precision (`0045:57-58`).

**Field lists** (lines in `line_no` order; landed costs in `cost_no` order):

| `op_code` | Fields, in order |
|---|---|
| `supplier.create` | `supplier_id` uuid · `name_w1..w8` · `phone_w1..w8` · `email_w1..w8` · `tax_identifier_w1..w8` · `notes_w1..w8` |
| `supplier.update` | `supplier_id` uuid · `expected_revision` int · the same five word groups |
| `supplier.archive` | `supplier_id` uuid · `expected_revision` int |
| `supplier.reactivate` | `supplier_id` uuid · `expected_revision` int |
| `purchase.draft` | `purchase_id` uuid · `expected_revision` int (0 = create) · `supplier_id` uuid · `warehouse_id` uuid · `previous_warehouse_id` uuid or NULL (NULL on create or when unchanged) · `currency` code · `document_date` int · `supplier_reference_w1..w8` · `notes_w1..w8` · `tax_minor` int · `line_count` int · per line: `line_id` uuid, `variant_id` uuid, `qty_q4` int (> 0), `unit_price_c10` int (≥ 0, txn minor units), `discount_minor` int (≥ 0) · `landed_count` int · per landed cost: `landed_cost_id` uuid, `mode` code (`by_value`/`manual`), `amount_minor` int (> 0), `description_w1..w8`, then **`line_count`** allocation ints (manual: the amounts in line order; `by_value`: all NULL) |
| `purchase.cancel` | `purchase_id` uuid · `warehouse_id` uuid · `draft_revision` int |
| `purchase.receive` | `purchase_id` uuid · `warehouse_id` uuid · `draft_revision` int · `supplier_id` uuid · `supplier_revision` int · `document_date` int · `currency` code · `rate_id` uuid or NULL (NULL iff domestic) · `rate_r10` int · `rate_source` code (`base`/`manual`) · `rate_at` int · `total_txn_minor` int · `total_base_minor` int · `coverage_adjustment_id` uuid or NULL (NULL iff Σ `covered_q4` = 0) · `line_count` int · per line: `line_id` uuid, `variant_id` uuid, `qty_q4` int, `base_share_minor` int, `covered_q4` int (≥ 0), `catch_up_minor` int (signed Σ of that line's stored coverage movement values) |

- **What this binds** (L:1962-1964):
  - every warehouse whose scope was checked (both, when a replace moves the draft);
  - every line's variant and quantity;
  - every financial input: price, discount, landed amount and allocation, tax (always 0), rate and date;
  - every stored amount the receipt writes.
- **`tax_minor` is bound deliberately.** A non-zero value is refused before the payload is minted (A-12), and the database refuses it again (CHECK plus routine). The field exists so that the day OD-03 closes, the tax amount is already a signed input rather than an unsigned one.
- **`coverage_adjustment_id`** is a fresh UUID minted by the **service**, not the client. The catch-up accounting assertion names it as its `source_id` (A-06), so it must exist before the seam opens. It is not part of the intent (A-10(b)).

### A-10 · Idempotency: prove the replayed command before reading any state (ENG, S3C A-10 carried forward)

**(a) Identity.**
- Suppliers are keyed by `supplier_id`, and purchases by `purchase_id`. Both are client-supplied canonical UUIDs.
- The purchase id is the stock `source_id` of its lines and the accounting `source_id` of its entry.
- The coverage header id is the stock `source_id` of its coverages and the accounting `source_id` of the catch-up.

**(b) Intent digests** (`inventory_payload_digest`, `0054:214-262`, over the **client-intent** fields only):

| Command | Intent fields | Stored in |
|---|---|---|
| `supplier.create` | all A-09 fields | `suppliers.create_intent_sha256` |
| `supplier.update` / `archive` / `reactivate` | all A-09 fields | `suppliers.last_intent_sha256` (with the revision it produced) |
| `purchase.draft` | all A-09 fields | `purchases.draft_intent_sha256` (with the revision it produced) |
| `purchase.cancel` | all A-09 fields | `purchases.cancel_intent_sha256` |
| `purchase.receive` | `purchase_id`, `warehouse_id`, `draft_revision` only. Everything else is server-derived | `purchases.receive_intent_sha256` |

**(c) Application order.** This is S3C A-10(c), with one step moved and one added.
- **Step 4 (scope) needs the draft's warehouse.** For `purchase.receive` and `purchase.cancel`, the service first reads the purchase header (`id`, `warehouse_id`, `status`, intents) through `daftar_app` under RLS. That is a document read, not a state read, and it mints nothing. Only then does step 4 check scope.
- **The proof comes before any stock or deficit read:**
  - **receive:** `received` with an equal `receive_intent_sha256` → replay; `received` with a different intent, or `cancelled` → `purchase.state_invalid`.
  - **draft:** the stored revision = `expected_revision + 1` with an equal `draft_intent_sha256` → replay; otherwise a revision mismatch → `purchase.draft_changed`.
  - **supplier ops:** the same rule on `last_intent_sha256` or `create_intent_sha256`.

**(d) Database order inside every entry routine.** This extends S3C A-10(d) and 0062 R-14.
1. `inventory_assertion_consume(...)` is the first statement.
2. The isolation check and the trace.
3. The per-document advisory key:
   - `pg_advisory_xact_lock(hashtext('daftar.purchase_id'), hashtext(p_purchase_id::text))`;
   - `…'daftar.supplier_id'…` for the supplier kinds.
4. The row `FOR UPDATE` and the intent comparison, which gives replay or refusal.
5. Only then any other read.

A concurrent identical command waits on the key and replays (T-11).

**(e) The stored result.** A replay answers from stored rows only (S3C A-10(f)):
- the header and lines;
- the movements through the bridges;
- the coverages;
- both entry ids through `accounting_source_bindings`.

### A-11 · Supplier semantics and receipt snapshots (ENG; scope is ENG+TL, TL-4)

- **Fields:**
  - `name` is required, 1..200 characters, trimmed;
  - `phone` is 1..40;
  - `email` is 3..254 and must look like an address (DTO);
  - `tax_identifier` is 1..64;
  - `notes` is 1..1000.
- **Uniqueness.** None is imposed on names or tax identifiers. Two suppliers may legitimately share either (branches of one firm). S7 may warn.
- **Snapshots at receipt** (L:1196): `supplier_name_snapshot`, `supplier_tax_identifier_snapshot` and `supplier_phone_snapshot` are copied from the supplier row read `FOR SHARE` at the bound `supplier_revision`. They are immutable thereafter. A supplier update never touches a document.
- **Scope (TL-4).** Supplier commands check `suppliers.manage` and no warehouse. A supplier is shared by every branch, and the permission is sensitive and assigned deliberately by the owner (L:1142-1144).

### A-12 · The tax boundary — OD-03 (ENG, **BLOCKED BY OD-03 beyond the zero case**)

- **Column.** `purchases.tax_minor BIGINT NOT NULL DEFAULT 0 CONSTRAINT purchases_tax_policy_absent_ck CHECK (tax_minor = 0)`. This is the "tax snapshot field" L:802 permits, physically bounded to zero.
- **DTO.** An optional `taxAmount` (decimal string, default `"0"`). Any non-zero value is refused `purchase.tax_policy_absent` (422) **before anything is minted**.
- **Routine.** `purchase_save_draft` refuses `p_tax_minor <> 0` with `purchase.tax_policy_absent` immediately after the consume. It is the first check after the isolation check, so a signed non-zero tax still never writes. The CHECK is the last line of defence.
- **Designed nowhere:**
  - no tax rate;
  - no inclusive/exclusive rule;
  - no recoverable/non-recoverable choice;
  - no `tax_payable` or tax-in-cost posting;
  - no Country Pack read.

  Each is **BLOCKED BY OD-03** (`DAFTAR_OPEN_DECISIONS.md:11`, L:793-808, SM:70).
- **Import VAT and duties entered as a landed cost** would be exactly the silent capitalization choice L:802-803 forbids. S4 therefore offers no tax-like landed-cost kind. The landed cost's `description` is free text, and S7's UI must not present a tax/duty preset. Any tax/duty landed-cost category is **BLOCKED BY OD-03**.
- **Discounts** reduce cost that enters inventory and are fully supported per line (L:807). A header discount is TL-9.

### A-13 · Purchase arithmetic (ENG)

All amounts are integers in **txn minor units** of the purchase currency until the single conversion.

1. **Line gross.** `gross_i = HALF_EVEN(qty_i × unit_price_i, 0)` (`inventory_half_even(qty*price, 1, 0)`).
2. **Line net.** `net_i = gross_i − discount_i`, with `0 ≤ discount_i ≤ gross_i`, else `purchase.discount_invalid`.
3. **Landed costs**, each allocated separately (L:780-788):
   - **`by_value`:** `alloc_{k,i} = LR(amount_k; weights net_i)` with the tie-break `line_no ASC`. If `Σ net_i = 0`, it refuses `purchase.landed_cost_denominator_zero`. There is no equal split.
   - **`manual`:** the supplied per-line amounts must satisfy `Σ_i alloc_{k,i} = amount_k` exactly, else `purchase.landed_cost_allocation_mismatch`. A one-minor-unit difference refuses (P:212). Each amount must be ≥ 0.
   - LR is the existing `inventory_largest_remainder(numeric[], bigint)` (`0061:769`) and its twin `packages/inventory/src/allocation.ts`. Index order is `line_no` order.
4. **Line txn total.** `t_i = net_i + Σ_k alloc_{k,i}`.
5. **Purchase total.** `T = Σ t_i + tax_minor (= 0)`. If `T = 0`, it refuses `purchase.total_zero` (TL-8), because a journal amount must be > 0 (`0042`).
6. **Base.** `B = HALF_EVEN(T × rate × 10^max(0, e_b − e_t) ÷ 10^max(0, e_t − e_b), 0)`.
   - This is the exact 0043 per-line law (`0043`, and `packages/accounting/src/fx.ts` `convertToBaseMinor`), where `e` are the `currencies.minor_units` (`0001`: JOD 3, the rest 2 or 0).
   - Domestic: `rate = 1`, so `B = T`.
   - SQL computes it with `inventory_half_even`. The application computes it with `convertToBaseMinor`, in the service and not in `@daftar/inventory` (A-19).
7. **Line base shares.** `s_i = LR(B; weights t_i)`, tie-break `line_no`. So `Σ s_i = B` exactly, with no plug and no `6100` (P:207, L:1384).
8. **Movement.** The movement is one `purchase` movement per line:
   - `qty = qty_i`;
   - `value_delta_base_minor = s_i`, a supplied priced-document value (`0060:398-418`);
   - `unit_cost_base_minor = HALF_EVEN(s_i / qty_i, 10)`, the snapshot, exact at 10 dp as R3 requires.
9. **Journal.** Both lines carry `txn = T` and `base = B`. The two lines convert identically, so the entry balances in base by construction, and each line satisfies 0043.

**Why convert the total and split in base, rather than convert per line.** Converting per line and summing would make `Σ s_i ≠ convert(T)` by rounding. Then either the AP line or the Inventory line would need a plug. L:1384 and P:207 forbid a plug.

### A-14 · Accounting-side objects in 0063 (ENG; (b) is ENG+TL, S3 TL-7)

All functions are owned by `daftar_accounting_internal`, are definer and pinned, and have PUBLIC revoked, inside the accounting CREATE bracket (`0058:40-71`).

**(a) Detail completeness, re-proving AL-01 (L:1054-1056).** There is one function and one deferred constraint trigger per source:
- `accounting_purchase_entry_complete()` with `journal_entries_purchase_complete`;
- `accounting_negative_inventory_cost_adjustment_entry_complete()` with `journal_entries_negative_inventory_cost_adjustment_complete`.

Both are `AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type = '<st>')`. The `WHEN` keeps Budget A (S3C A-26). At COMMIT each requires:

- **For `purchase`:**
  - exactly one `purchases` row with `binding_source_id = NEW.source_id`, `status = 'received'` and `document_date = NEW.entry_date`;
  - exactly two lines:
    - `inventory` D with `base = total_base_minor`, `txn = total_txn_minor`, `txn_currency = currency_code`, `fx_rate = source_to_base_rate`, `fx_rate_source = rate_source`, `fx_rate_at = rate_timestamp`, `warehouse_id` = the purchase warehouse, and `branch_id` = its home branch;
    - `accounts_payable` C with the same amounts and FX, `branch_id` = the home branch, and `warehouse_id` NULL.
- **For `negative_inventory_cost_adjustment`:**
  - exactly one header with `binding_source_id = NEW.source_id` and `occurred_on = NEW.entry_date`;
  - exactly two domestic lines, `inventory`/`cogs`, whose sides follow `sign(total_value_base_minor)`, with amount `|total_value_base_minor|` and the header's warehouse and home branch.

The refusals reuse the S3 codes `accounting.inventory_detail_missing` and `accounting.inventory_entry_mismatch`. The reverse direction is each header's deferred FK to `accounting_source_bindings` (A-15, the `0047:102-106` shape).

**(b) Reversal guard.** `accounting_reversals_20_domain_source_guard()` is replaced under `SET LOCAL ROLE daftar_accounting_internal`.
- The body is byte-identical except the list becomes `('inventory_adjustment','inventory_opening','purchase','negative_inventory_cost_adjustment')`.
- The generic reversal workflow could otherwise reverse a purchase entry without inverse movements. That would make GL Inventory ≠ Σ movement values and leave AP with no document (PM-16).
- S5's `purchase_reversal` is paired with inverse movements. It is S5's to admit, by its own replacement.
- No accepted behaviour changes, because no such entry exists before S4.

**(c) FX snapshot read.** `accounting_purchase_fx_rate(p_business_id UUID, p_currency CHAR(3), p_at TIMESTAMPTZ) RETURNS accounting_fx_rate_snapshot`.
- It is `STABLE`. It raises `accounting.scope_mismatch` unless `p_business_id` is the transaction's business. Otherwise it runs exactly the `accounting_fx_rate_lookup` query (`0048:648-661`).
- **EXECUTE:** `daftar_inventory_internal` only. It is reachable for a signed routine, not by any runtime role (the S3C A-14(d) pattern).
- A function rather than a table grant keeps G-1 and the accounting grant matrix unchanged (`scripts/guards/journal-privilege-model.ts`).

**(d) Grants to `daftar_accounting_internal`.**
- `SELECT` on `purchases` and `negative_inventory_cost_adjustments`, with a `FOR SELECT TO daftar_accounting_internal USING (true)` policy on each (the 0061 layering), for (a).
- `SELECT` on `warehouses` exists already (0061).
- Nothing else.

### A-15 · Stock-side guards: two bridges and their triggers (ENG)

**(a) Bridges.** These follow the exact template of S3C A-15(a) and L:1501-1519.

| `<st>` | Line FK target (`ON DELETE RESTRICT`) | New candidate key it needs |
|---|---|---|
| `purchase` | `purchase_lines (business_id, purchase_id, id)` | `purchase_lines_bridge_uq UNIQUE (business_id, purchase_id, id)` |
| `negative_inventory_cost_adjustment` | `negative_deficit_coverages (business_id, adjustment_id, id)` | `negative_deficit_coverages_bridge_uq UNIQUE (business_id, adjustment_id, id)` (ALTER on the S2 table) |

**(b)–(c) Binding and immutability triggers.** `stock_binding_requires_<st>` (deferred, `tgtype 5`, `WHEN (NEW.source_type='<st>')`, internal definer) and `stock_bridge_immutable_<st>` (`tgtype 27`, `stock_ledger_append_only()`), exactly as S3C A-15(b)(c).

**(d) Line-side completeness (L:1532-1544)**, deferred.

- **`stock_source_complete_purchase`** on `purchase_lines`: `AFTER INSERT OR UPDATE`, `tgtype 21`.
  - A line of a **received** purchase has exactly one `purchase` movement through the bridge, at the header's warehouse and the line's variant, with:
    - `qty_delta = qty`;
    - `value_delta_base_minor = base_share_minor`;
    - `unit_cost_base_minor` = the line's `unit_cost_base_minor`.
  - A draft line requires nothing (L:1544).
  - A header twin, **`purchases_received_complete`** (`AFTER UPDATE` on `purchases`, deferred, `tgtype 17`, function `stock_source_complete_purchase_header()`), re-checks every line of a purchase that became `received`. It is the S3 `stocktakes_finalized_complete` precedent.
- **`stock_source_complete_negative_inventory_cost_adjustment`** on `negative_deficit_coverages`: `AFTER INSERT`, `tgtype 5`.
  - Each coverage has **exactly one** `negative_inventory_cost_adjustment` movement (qty 0, at the header's warehouse and the coverage's variant) **iff its catch-up value is non-zero**, and none otherwise (A-16(d)).
  - The value equals the coverage formula (A-16(c)), except for the single flush-eligible coverage defined in A-16(e).

**(e) Freeze (L:1546-1548).**

| Trigger | Table | Allows | Refusal |
|---|---|---|---|
| `stock_source_freeze_purchase` (`BEFORE UPDATE OR DELETE`, `tgtype 27`) | `purchase_lines` | while the parent is `draft`: `DELETE` (a replace), and `UPDATE` setting `base_share_minor`/`unit_cost_base_minor` from NULL (the receipt, which updates lines **before** the header, §2.4 step 12). Nothing else | `inventory.source_line_frozen` |
| `purchase_landed_costs_freeze`, `purchase_landed_cost_allocations_freeze` (27) | the landed-cost tables | `DELETE` while the parent is `draft`; never `UPDATE` | `inventory.source_line_frozen` |
| `purchases_immutable` (the header guard, 27) | `purchases` | `draft → draft` (revision + 1, the draft columns); `draft → received`; `draft → cancelled`. `DELETE` is never allowed; a received or cancelled row allows nothing | `inventory.source_document_immutable` |
| `negative_inventory_cost_adjustments_immutable` (27, `stock_ledger_append_only()`) | the coverage header | nothing (insert-only) | `inventory.ledger_immutable` |
| the existing `negative_deficit_coverages_append_only` (`0059:293-295`) | coverages | nothing | `inventory.ledger_immutable` |

**(f) Header value completeness**, deferred:
- `purchases_value_complete` (`AFTER UPDATE`, 17): a received purchase has `Σ` bridged movement values `= total_base_minor = Σ base_share_minor`.
- `negative_inventory_cost_adjustments_value_complete` (`AFTER INSERT`, 5): `total_value_base_minor = Σ` bridged coverage movement values.
- Both use one new function, `purchase_source_value_complete()`. The S3 `inventory_source_value_complete()` is **not** replaced, so its recorded digest stays true.

**(g) Supplier guards.**
- `suppliers_no_delete` (`BEFORE DELETE`) → `supplier.not_deletable`.
- `suppliers_revision_guard` (`BEFORE UPDATE`): the identity and creation columns are immutable, and `NEW.revision = OLD.revision + 1`.

**(h) Allocation consistency.** `purchase_allocations_consistent` is deferred, on `purchase_landed_cost_allocations` `AFTER INSERT`. It requires:
- `Σ` allocations per landed cost = its amount;
- each line's `landed_cost_txn_minor` = `Σ` of its allocations;
- the header's `landed_cost_txn_minor` = `Σ` amounts;
- `total_txn_minor = subtotal + landed + tax`.

The refusal is `purchase.landed_cost_allocation_mismatch`. This physical twin makes P:212's "Σ allocations = total exactly" a database fact.

### A-16 · Deficit coverage — specified exactly (ENG; (d) and (e) are ENG+TL, TL-5 and TL-6)

S4 is the **first producer** of coverage (L:470). Every rule below is enforced in the routine under lock, and re-proved at COMMIT.

**(a) Header grain (L:494-496; DM:259; PM-30).** There is **one** `negative_inventory_cost_adjustments` header per receipt that covers anything.
- `origin_source_type = 'purchase'`.
- `origin_source_id = purchase_id`.
- `origin_source_line_id` is carried, as the lock lists it, and is **NULL** for a receipt-grain header (`CHECK (origin_source_line_id IS NULL)` in S4). The covering line is still exact. A purchase has one warehouse and one line per variant (L:767), so the line is `(origin_source_id, coverage.variant_id)`, and the completeness trigger resolves it that way. ENG+TL, TL-7.
- `UNIQUE (business_id, origin_source_type, origin_source_id)`: at most one header per receipt.
- The header id is the service-minted `coverage_adjustment_id` (A-09).

**(b) Order and locks.** This implements L:482-488.
1. Inside `purchase_receive`, after step 6 of R-15 (stock targets, products `FOR SHARE`, and every stock key of the purchase `FOR UPDATE`), the helper `purchase_cover_deficits` runs.
2. For each line in `line_no` order, it takes the open layers of `(warehouse, variant)` `FOR UPDATE` in `(deficit_seq ASC, id ASC)` (L:478). That is step 6b of the lock order.
3. It first asserts `Σ uncovered_qty = max(0, −on_hand)` at the locked row, else `inventory.deficit_state_invalid`, a defect class.
4. It covers `c_j = min(uncovered_j, remaining)` per layer until the line's quantity or the layers run out. The two-stage `stock_levels` lock serializes two receipts before FIFO is consulted (L:510), so concurrent coverage is disjoint (T-09).

**(c) Actual cost and the per-coverage value** (L:1384, S2 precedent `packages/inventory/src/valuation.ts:129-141`).
- `actual = HALF_EVEN(s_i / qty_i, 10)`. This is the same value as the purchase movement's `unit_cost_base_minor`.
- `value_j = −HALF_EVEN(c_j × (actual − provisional_j), 0)`.
- The sign follows AL-13 step 4 and IR §5أ: actual > provisional takes value **out** of Inventory (`Dr COGS / Cr Inventory`). HALF_EVEN is odd-symmetric, so this is L:1384's formula with the lock's direction applied.
- Each value is computed per coverage and never split from an aggregate.

**(d) A zero catch-up (TL-5).**
- When `value_j = 0` (actual = provisional), the coverage row is written, because the deficit's decrement must be recorded, but **no movement** is written.
- `stock_movements_value_only_ck` (`0059:150`, frozen) refuses a zero-value value-only movement. L:1541's "exactly one" is therefore read with the qualifier L:1543 already applies to stocktake lines ("with a non-zero variance").
- The code order, frozen schema before the lock (sources of truth, item 1), decides this.

**(e) The zero-crossing flush (TL-6).**
- When a line's receipt closes **every** open layer at its key exactly (`qty_i = Σ covered_i`, so `on_hand` after the purchase movement is 0), the **last** coverage of that line (the greatest `(deficit_seq, id)`) carries `value = −valuation` of the locked row immediately before it. That is the valuation after the purchase movement and the earlier coverages of the line.
- Every other coverage uses (c).
- This is AL-49's own full-depletion definition ("a definition, not a correction", L:1386) applied to the one other path that reaches `on_hand = 0`. Without it, the per-coverage roundings plus the deficit's stored outbound values can leave a ±residue at zero stock. The deferred `stock_levels_zero_on_hand_zero_value` (`0060:655-741`) would then refuse the whole receipt.
- In every case without residue, the flush equals the formula. GOLD-72's second receipt is −180 either way (`packages/inventory/vectors/valuation-vectors.json`, `AL08-CATCHUP-GOLD72`).
- A flush of 0 falls under (d).
- **Verifiable at COMMIT.** A coverage is flush-eligible iff all three hold:
  - it is the last of its variant in its header;
  - the covering line's `qty = Σ qty_covered` of that variant in the header;
  - no layer of `(warehouse, variant)` is open at COMMIT.

  The completeness trigger exempts only that coverage from the formula. `stock_levels_zero_on_hand_zero_value` pins its value physically.

**(f) Movement order** (the S2 vector order, `valuation.ts:19-21`). For each line in `line_no` order:
1. the `purchase` movement;
2. then its coverages' value-only movements in FIFO order.

The intermediate state "zero stock with value" is legal until COMMIT (GOLD-72).

**(g) Deficit updates.**
- `uncovered_qty -= c_j`.
- `status` becomes `partially_covered` or `closed` per the 0059 CHECK (`0059:219-222`).
- Guards:
  - `negative_inventory_deficits_coverage_guard` (`BEFORE UPDATE OR DELETE`, a new internal definer function): refuses `DELETE`, any change except `uncovered_qty` (only decreasing) and `status`, with `inventory.deficit_immutable`.
  - `negative_inventory_deficits_coverage_consistent` (deferred, `AFTER UPDATE`): `original_deficit_qty − uncovered_qty = Σ qty_covered` over its coverages, else `inventory.deficit_coverage_mismatch`.
- `INSERT` stays unguarded, because the owner seeds deficits in tests (L:470).

**(h) Coverage rows.**
- New coverage keys: `UNIQUE (business_id, adjustment_id, deficit_id)`, so a layer is covered at most once per receipt (PM-20).
- New FK `(business_id, adjustment_id) → negative_inventory_cost_adjustments (business_id, id) ON DELETE RESTRICT`, **immediate**. The S2 comment "added by P3-S4" (`0059:236-251`) is thereby discharged.
- 0063 adds both constraints. The FK validates existing rows, and production has none, because nothing produced a coverage before S4.

**(i) The single catch-up entry.**
- `N = Σ` stored coverage movement values of the header.
- If `N ≠ 0`, the header's `binding_source_id = id` and one entry is posted (A-05). If `N = 0`, no entry is posted.
- The amount is the sum of the **stored** integers (L:487, P:207, equation (3)).
- One line covering three layers gives three coverage rows, three movements with three distinct `source_line_id`s, and one entry of their sum (T-08.2).

**(j) Reaching the path in Phase 3.** No Phase 3 merchant command creates a deficit (L:463-467). Tests seed deficits as the schema owner (L:470, §5). The path is live code with no Phase 3 production trigger, and the contract says so plainly (L:474).

### A-17 · FX snapshot (ENG; the instant is ENG+TL, TL-2)

- **Columns** (L:834): `currency_code CHAR(3)`, `source_to_base_rate NUMERIC(20,10)`, `rate_source TEXT CHECK IN ('base','manual')`, `rate_timestamp TIMESTAMPTZ` (second precision). There is also `fx_rate_id UUID` with FK `(business_id, fx_rate_id) → accounting_fx_rates (business_id, id) ON DELETE RESTRICT`. The migrator owns the table; 0048 transfers only functions (`0048:697-702`).
- **Draft.** A draft stores `currency_code` only. The snapshot is taken **at receipt** and is frozen forever (L:836-837).
- **Domestic** (`currency_code = businesses.base_currency`):
  - `rate = 1`, `rate_source = 'base'`, `fx_rate_id` NULL;
  - `rate_timestamp = <document_date>T00:00:00Z`, the S3 domestic line shape (`apps/api/src/modules/inventory/inventory-posting.ts:68`);
  - the registry is never consulted.
- **Foreign.**
  - The lookup instant is `((document_date + 1)::timestamp AT TIME ZONE businesses.timezone) − interval '1 second'`: the last second of the document date in the business's timezone.
  - The snapshot is the registry row `accounting_fx_rate_lookup` returns for `(currency → base, that instant)`.
  - `rate_timestamp` = that row's `effective_at`. The registry states it is directly usable as `fx_rate_at` (`0048:124`, "a future domain … looks one up and copies it").
  - With no rate, the refusal is `purchase.fx_rate_missing` (422; the accounting code is `accounting.fx_rate_missing`).
  - The instant uses no `now()`, so the service and the routine compute the same instant.
- **Landed costs** use the same snapshot, because they are in the purchase currency (L:838). A third currency is out of scope.
- **A foreign purchase after a registry rate change** keeps its own stored snapshot (P:217, T-10).

### A-18 · Grant and ACL matrix produced by S4 (ENG)

| Principal | Gains |
|---|---|
| `daftar_app` | `SELECT` on `suppliers`, `purchases`, `purchase_lines`, `purchase_landed_costs`, `purchase_landed_cost_allocations`, `negative_inventory_cost_adjustments`, **and on `negative_inventory_deficits` and `negative_deficit_coverages`** (the A-07 bound read and the replay/read models). The RLS tenant and business policies on both S2 tables exist already (`0059:347-359`). `EXECUTE` on the seven entry routines. No DML anywhere |
| `daftar_inventory_internal` | `SELECT, INSERT` on the six S4 tables and the two bridges. `DELETE` on `purchase_lines`, `purchase_landed_costs`, `purchase_landed_cost_allocations` (draft replace only; freeze triggers). Column `UPDATE`: `suppliers (name, phone, email, tax_identifier, notes, status, revision, last_intent_sha256, business_transaction_id, updated_by, updated_at)`; `purchases` (the draft columns and the receive/cancel columns of §2.2); `purchase_lines (base_share_minor, unit_cost_base_minor)`; `negative_inventory_deficits (uncovered_qty, status)`. `INSERT, SELECT` on `negative_deficit_coverages`. `SELECT` on `currencies` (minor units). `EXECUTE` on `accounting_purchase_fx_rate`. **No** `UPDATE` on the coverage header (inserted complete, A-16(i)) |
| `daftar_accounting_internal` | A-14(d) |
| every other runtime role and PUBLIC | nothing |

### A-19 · Permissions, routes and DTOs (ENG)

The permissions exist since P3-S1 (`packages/domain-core/src/permissions.ts`, L:1122-1140). S4 adds none. `OPERATION_AUTHORITY` (`apps/api/src/modules/inventory/inventory-authorization.ts:24-41`) gains the seven A-03 rows.

| Route | Guard | op_code / read | Success |
|---|---|---|---|
| `POST /v1/suppliers` | `suppliers.manage` | `supplier.create` | 201; 200 replay |
| `PUT /v1/suppliers/:supplierId` (body has `expectedRevision`) | `suppliers.manage` | `supplier.update` | 200 |
| `POST /v1/suppliers/:supplierId/archive` · `/reactivate` | `suppliers.manage` | `supplier.archive` · `supplier.reactivate` | 200 |
| `GET /v1/suppliers` · `/:supplierId` | `suppliers.view` | read | 200 |
| `GET /v1/suppliers/:supplierId/payable` | `suppliers.view` **and** business-wide scope (TL-4) | live AP read (A-20) | 200 |
| `PUT /v1/purchases/:purchaseId` (body has `expectedRevision`) | `purchases.manage` | `purchase.draft` | 201 on create, 200 on replace or replay |
| `POST /v1/purchases/:purchaseId/receive` (body has `draftRevision`) | `purchases.receive` | `purchase.receive` | 200 (`replayed`) |
| `POST /v1/purchases/:purchaseId/cancel` (body has `draftRevision`) | `purchases.manage` | `purchase.cancel` | 200 |
| `GET /v1/purchases` · `/:purchaseId` · `/:purchaseId/payable` | `purchases.view`, warehouse scope (an assigned-scope actor sees purchases of in-scope warehouses only) | read | 200 |

- **DTOs.** Strict zod schemas, as in S3C A-21:
  - decimal strings for quantity (`^\d{1,14}(\.\d{1,4})?$`), unit price (`^\d{1,18}(\.\d{1,10})?$`, txn **major** units, converted to C10 minor by the currency's minor units in the service), discount, landed amounts and `taxAmount` (major units, exact at the currency's minor units, else `purchase.amount_precision_invalid`);
  - `currency` is `^[A-Z]{3}$` and must be registered;
  - `documentDate` is `YYYY-MM-DD`;
  - 1..200 lines (S3 TL-8) and 0..10 landed costs;
  - a line is `{ lineId, productId, variantId?, quantity, unitPrice, discount? }`, resolved by S3C A-23 unchanged;
  - no duplicate variant (`purchase.duplicate_variant`, L:768).
- **Responses** carry money as strings. The receipt returns `{ purchaseId, replayed, businessTransactionId, totalTxnMinor, totalBaseMinor, rate{…}, lines[{lineId, variantId, qty, baseShareMinor, unitCostBaseMinor, movementId}], coverage: null | { adjustmentId, totalValueBaseMinor, coverages[{ coverageId, deficitId, qtyCovered, provisional, actual, valueDeltaBaseMinor | null }] }, purchaseEntryId, catchUpEntryId | null }`.
- **Wiring.** A new `apps/api/src/modules/purchasing/` module, registered in both `app.module.ts` and `merchant-api.module.ts`. `tests/integration/process-composition.test.ts:36-53` stays green only if both compositions carry the controllers.

### A-20 · Live AP reads, derived from the ledger (ENG)

There is no stored balance, cache, projection or summary (L:847-853, L:1260-1262).

- **Purchase payable** (`GET /v1/purchases/:id/payable`):
  - Take the `accounts_payable` journal lines of the entries bound through `accounting_source_bindings` to `('purchase', purchase_id)`.
  - `outstanding_base_minor = Σ credit_minor − Σ debit_minor`.
  - `outstanding_txn_minor = Σ` signed `txn_amount_minor` in `txn_currency`.
  - In S4 this equals the purchase's `total_base_minor`/`total_txn_minor`. S5 and S6 extend the source-type set of the same query (returns, reversals, allocations) and change nothing else.
- **Supplier payable** (`GET /v1/suppliers/:id/payable`): the same sum over the supplier's `received` purchases (in S4, all bound to `purchase`), returned as `{ baseMinor, byCurrency: [{ currency, txnMinor }] }`.
- Both are computed on read through `daftar_app` `SELECT` (`0042:436-437`), with `journal_lines_business_account_idx` (`0050:57`).
- **Reconciliation proof (T-12).** For every received purchase, the document total (`total_base_minor`) equals the ledger-derived outstanding in S4. This is AL-26's document formula, "Σ purchases (received, not reversed)", checked against the ledger read. Any divergence is a defect.
- **Guard.** `scripts/guards/no-authoritative-balance.ts` is extended to the supplier and purchase tables (L:853, §7.2).

### A-21 · Audit and outbox (ENG)

Each command writes one `audit_events` row and one `outbox_events` row in the routine, carrying `business_transaction_id` (S3C A-25). The events are:
- `supplier.created`, `supplier.updated`, `supplier.archived`, `supplier.reactivated`;
- `purchase.draft_saved`, `purchase.cancelled`, `purchase.received`;
- `inventory.deficit_covered`, only when a header was written.

The payloads carry ids, not amounts.

---

## 2. Database contract

### 2.1 Migration 0063 order (normative)

1. **Header rules.** R-15 (lock order), R-16 (coverage), R-17 (FX instant), R-18 (tax bound).
2. **The six tables** (§2.2), RLS and grants on them.
3. **The coverage and deficit additions** (A-16(g)(h)) and the `purchases (business_id, id, warehouse_id)` candidate key.
4. **The two bridges** (A-15(a)).
5. **The guard functions and triggers** (A-15(b)–(h), A-16(g)), each inside the inventory CREATE bracket.
6. **The replaced `inventory_stock_source_guard_gaps()`** (§2.3). It is replaced **before** the registrations.
7. **`INSERT INTO stock_source_types`**, the two rows (A-05).
8. **The accounting objects** (A-14), inside the accounting CREATE bracket, then the two accounting registrations (A-05).
9. **0063-E** (§2.8).

### 2.2 Tables

All tables:
- start with `tenant_id, business_id`;
- have the composite tenant FK `(tenant_id, business_id) → businesses (tenant_id, id)`;
- have `PRIMARY KEY (business_id, id)` unless stated;
- have `ENABLE` + `FORCE` RLS with the §0 layering;
- have `REVOKE ALL … FROM PUBLIC`.

**Suppliers and purchases:**

| Table | Columns beyond the common ones (all `NOT NULL` unless marked `?`) | Keys / checks |
|---|---|---|
| `suppliers` | `id`, `name`, `phone?`, `email?`, `tax_identifier?`, `notes?`, `status` (`active`/`inactive`), `revision` (≥ 1), `create_intent_sha256`, `last_intent_sha256`, `business_transaction_id`, `created_by`, `created_at`, `updated_by`, `updated_at` | length/trim CHECKs (A-11); intents `~ '^[0-9a-f]{64}$'` |
| `purchases` | `id`, `supplier_id`, `warehouse_id`, `currency_code CHAR(3)`, `document_date DATE`, `supplier_reference?`, `notes?`, `status` (`draft`/`received`/`cancelled`), `revision`, `draft_intent_sha256`, `receive_intent_sha256?`, `cancel_intent_sha256?`, `subtotal_txn_minor`, `landed_cost_txn_minor`, `tax_minor` (0), `total_txn_minor`, `source_to_base_rate?`, `rate_source?`, `rate_timestamp?`, `fx_rate_id?`, `total_base_minor?`, `supplier_name_snapshot?`, `supplier_tax_identifier_snapshot?`, `supplier_phone_snapshot?`, `received_by?`, `received_at?`, `cancelled_by?`, `cancelled_at?`, `business_transaction_id`, `created_by`, `created_at`, `updated_at`, `accounting_source_type GENERATED ALWAYS AS ('purchase') STORED`, `binding_source_id?` | FK supplier (RESTRICT); FK `(business_id, warehouse_id) → warehouses`; FK `currency_code → currencies`; FK `fx_rate_id` (A-17); `UNIQUE (business_id, id, warehouse_id)`; `purchases_tax_policy_absent_ck`; `total = subtotal + landed + tax`; `rate_timestamp` second precision; a status-shape CHECK (draft ⇒ every receive/cancel column NULL; received ⇒ rate, total base, snapshot name, `received_*` and `receive_intent` NOT NULL; `rate_source = 'base'` ⇔ `fx_rate_id IS NULL AND source_to_base_rate = 1`; cancelled ⇒ `cancelled_*` NOT NULL, receive columns NULL); `binding_source_id IS NULL OR binding_source_id = id`; `(status = 'received') = (binding_source_id IS NOT NULL)`; deferred FK `(business_id, accounting_source_type, binding_source_id) → accounting_source_bindings (business_id, source_type, source_id)` |
| `purchase_lines` | `purchase_id`, `id`, `line_no` (> 0), `variant_id`, `qty NUMERIC(18,4)` (> 0), `unit_price_txn_minor NUMERIC(28,10)` (≥ 0), `gross_txn_minor`, `discount_txn_minor` (0..gross), `net_txn_minor` (= gross − discount), `landed_cost_txn_minor` (≥ 0), `base_share_minor?` (≥ 0), `unit_cost_base_minor?` (≥ 0) | FK purchase (RESTRICT); FK `(business_id, variant_id) → product_variants`; `UNIQUE (business_id, purchase_id, id)`; `UNIQUE (business_id, purchase_id, line_no)`; `UNIQUE (business_id, purchase_id, variant_id)` (L:767-768); `(base_share_minor IS NULL) = (unit_cost_base_minor IS NULL)` |
| `purchase_landed_costs` | `purchase_id`, `id`, `cost_no` (> 0), `mode` (`by_value`/`manual`), `amount_txn_minor` (> 0), `description?` (1..200) | `UNIQUE (business_id, purchase_id, cost_no)`; `UNIQUE (business_id, purchase_id, id)` |
| `purchase_landed_cost_allocations` | `purchase_id`, `landed_cost_id`, `purchase_line_id`, `amount_txn_minor` (≥ 0) | PK `(business_id, landed_cost_id, purchase_line_id)`; FKs `(business_id, purchase_id, landed_cost_id)` and `(business_id, purchase_id, purchase_line_id)` (RESTRICT) |
| `negative_inventory_cost_adjustments` | `id`, `warehouse_id`, `origin_source_type` (= `purchase`), `origin_source_id`, `origin_source_line_id?` (NULL in S4), `occurred_on DATE`, `total_value_base_minor` (signed), `actor_user_id`, `business_transaction_id`, `created_at`, `accounting_source_type GENERATED ALWAYS AS ('negative_inventory_cost_adjustment') STORED`, `binding_source_id?` | `UNIQUE (business_id, origin_source_type, origin_source_id)`; FK `(business_id, origin_source_id, warehouse_id) → purchases (business_id, id, warehouse_id)`; `(total_value_base_minor <> 0) = (binding_source_id IS NOT NULL)`; `binding_source_id IS NULL OR binding_source_id = id`; deferred FK to `accounting_source_bindings` |

- **Money columns.** Every money column is `BIGINT` and every rate is `NUMERIC(20,10)` (rule 6).
- **Balance-like names.** No column is named `balance`, `outstanding`, `paid`, `due`, `owed` or `payable`, and none uses `on_hand`/`valuation` (G-3 as extended, §7.2).

**R-15, the global lock order extended** (every S4 path; a path skips steps and never reorders them):

```
1  assertion consume / verify                        (no lock)
2  the per-document advisory key                      ('daftar.purchase_id' | 'daftar.supplier_id')
2a the document row FOR UPDATE                        (purchases | suppliers)
2b the supplier row FOR SHARE                         (purchase.draft, purchase.receive)
3–5 (not used by S4: no opening-balance step)
6  stock targets (shared advisory), products FOR SHARE (id order), stock keys FOR UPDATE ((warehouse, variant) order)
6b deficit layers FOR UPDATE                          ((deficit_seq, id) per key, keys in (warehouse, variant) order)
7  accounting_post_entry, twice, in this order: 'purchase', then 'negative_inventory_cost_adjustment'
```

- No S4 path takes a purchase row after a supplier row, and no supplier path touches purchases. So 2a/2b introduce no cycle.
- 6b is only ever taken while holding 6 for the same key (L:510).

### 2.3 The replaced `inventory_stock_source_guard_gaps()` (ENG)

- **What does not change.** It is `CREATE OR REPLACE` by the migrator. It stays `SECURITY INVOKER`, `STABLE` and pinned, and keeps the same signature.
- **The S3 part is kept byte-for-byte:**
  - the `v_s3` branch;
  - the line-table map;
  - the per-type extra set;
  - **every one of the thirteen `c_digest` entries** (`0061:302-318`), unchanged.

  This makes review F3 (`tests/integration/inventory-s3-review-fixes.test.ts:407-470`) pass unchanged.
- **The additions:**
  - a `v_s4` branch for `purchase` → `purchase_lines (business_id, purchase_id, id)` and for `negative_inventory_cost_adjustment` → `negative_deficit_coverages (business_id, adjustment_id, id)`, applied to `bridge_line_fk` exactly as `v_s3`;
  - the per-type extra set below;
  - `c_digest` entries (the SHA-256 of `prosrc`) for every new guard function, recorded at migration time.

| type | `missing` | table | trigger | `tgtype` | deferred | function |
|---|---|---|---|---|---|---|
| purchase | `source_complete` | `purchase_lines` | `stock_source_complete_purchase` | 21 | yes | `stock_source_complete_purchase()` |
| purchase | `header_complete` | `purchases` | `purchases_received_complete` | 17 | yes | `stock_source_complete_purchase_header()` |
| purchase | `source_freeze` | `purchase_lines` | `stock_source_freeze_purchase` | 27 | no | `stock_source_freeze_purchase()` |
| purchase | `header_immutable` | `purchases` | `purchases_immutable` | 27 | no | `purchase_header_guard()` |
| purchase | `value_complete` | `purchases` | `purchases_value_complete` | 17 | yes | `purchase_source_value_complete()` |
| negative_inventory_cost_adjustment | `source_complete` | `negative_deficit_coverages` | `stock_source_complete_negative_inventory_cost_adjustment` | 5 | yes | `stock_source_complete_negative_inventory_cost_adjustment()` |
| negative_inventory_cost_adjustment | `source_freeze` | `negative_deficit_coverages` | `negative_deficit_coverages_append_only` | 27 | no | `stock_ledger_append_only()` |
| negative_inventory_cost_adjustment | `header_immutable` | `negative_inventory_cost_adjustments` | `negative_inventory_cost_adjustments_immutable` | 27 | no | `stock_ledger_append_only()` |
| negative_inventory_cost_adjustment | `value_complete` | `negative_inventory_cost_adjustments` | `negative_inventory_cost_adjustments_value_complete` | 5 | yes | `purchase_source_value_complete()` |

- The recorded digest set gains:
  - `stock_binding_requires_purchase()`;
  - `stock_binding_requires_negative_inventory_cost_adjustment()`;
  - the six new functions above.
- The comment is extended to name S4.
- **0063-E probes the replacement by mutation inside rolled-back blocks**, as 0061-E does. Each of these makes the function report the gap:
  - disabling `stock_bridge_immutable_purchase`;
  - replacing `stock_source_complete_negative_inventory_cost_adjustment()` with a no-op body (the digest);
  - re-creating `purchases_immutable` on another function.

### 2.4 0064 routines (ENG)

**Entry routines.** All are internal-owned definer with the pinned path and PUBLIC revoked. `EXECUTE` goes to `daftar_app` only. The first statement is `v_actor := inventory_assertion_consume('<op>', inventory_claimed_payload_digest('<op>', types[], values[]))` built from the routine's own arguments (A-09).

| Routine | Signature |
|---|---|
| `supplier_create` | `(p_supplier_id UUID, p_name TEXT, p_phone TEXT, p_email TEXT, p_tax_identifier TEXT, p_notes TEXT)` |
| `supplier_update` | `(p_supplier_id UUID, p_expected_revision INTEGER, p_name TEXT, p_phone TEXT, p_email TEXT, p_tax_identifier TEXT, p_notes TEXT)` |
| `supplier_archive` / `supplier_reactivate` | `(p_supplier_id UUID, p_expected_revision INTEGER)` |
| `purchase_save_draft` | `(p_purchase_id UUID, p_expected_revision INTEGER, p_supplier_id UUID, p_warehouse_id UUID, p_previous_warehouse_id UUID, p_currency_code CHAR(3), p_document_date DATE, p_supplier_reference TEXT, p_notes TEXT, p_tax_minor BIGINT, p_line_ids UUID[], p_variant_ids UUID[], p_qtys NUMERIC[], p_unit_prices NUMERIC[], p_discounts BIGINT[], p_lc_ids UUID[], p_lc_modes TEXT[], p_lc_amounts BIGINT[], p_lc_descriptions TEXT[], p_lc_allocations BIGINT[])`, where `p_lc_allocations` is `landed_count × line_count`, row-major, NULL rows for `by_value` |
| `purchase_cancel` | `(p_purchase_id UUID, p_warehouse_id UUID, p_draft_revision INTEGER)` |
| `purchase_receive` | `(p_purchase_id UUID, p_warehouse_id UUID, p_draft_revision INTEGER, p_supplier_id UUID, p_supplier_revision INTEGER, p_document_date DATE, p_currency_code CHAR(3), p_rate_id UUID, p_rate NUMERIC, p_rate_source TEXT, p_rate_at TIMESTAMPTZ, p_total_txn_minor BIGINT, p_total_base_minor BIGINT, p_coverage_adjustment_id UUID, p_line_ids UUID[], p_variant_ids UUID[], p_qtys NUMERIC[], p_base_shares BIGINT[], p_covered_qtys NUMERIC[], p_catch_ups BIGINT[])` |

**Helpers.** These are internal-owned definer with **no grantee**. Each first statement is `v_actor := inventory_assertion_current(ARRAY['purchase.receive'])` (0062 R-5; rule 22).
- **`purchase_lock_receipt_targets(p_warehouse UUID, p_variants UUID[])`** takes lock steps 6:
  - the shared `daftar.stock_target` advisory keys;
  - the A-19 archive re-checks (`inventory.warehouse_archived` / `variant_archived` / `product_not_tracked`);
  - products `FOR SHARE`;
  - existing `stock_levels` `FOR UPDATE`.
- **`purchase_cover_deficits(p_purchase_id UUID, p_adjustment_id UUID) RETURNS TABLE (...)`** does A-16(b)–(i): the header insert, the coverage inserts and the deficit updates. It returns the coverage movement requests.
- **`purchase_bridge_receipt(p_purchase_id UUID, p_adjustment_id UUID)`** writes both bridges.

The S3 helpers `inventory_lock_stock_targets` and `inventory_bridge_source_lines` are **not** replaced. Their `inventory_assertion_current` lists are 0062's R-5 fact.

**`purchase_receive` statement order** (normative; the S3 transfer/adjust pattern of `0062`):
1. The consume.
2. The isolation check. The trace (`inventory_business_transaction_id()`, `inventory.trace_missing`).
3. The receive intent digest. The key `hashtext('daftar.purchase_id')`.
4. The purchase `FOR UPDATE`. Then:
   - not found → `purchase.not_found`;
   - `received` with an equal intent → **return the stored rows**, `replayed = true`;
   - otherwise not `draft` → `purchase.state_invalid`;
   - `revision ≠ p_draft_revision`, or `warehouse ≠ p_warehouse_id`, or the stored `(line_id, variant_id, qty)` list ≠ the arguments → `purchase.draft_changed`.
5. The supplier `FOR SHARE`. Then:
   - `id ≠ p_supplier_id` or `revision ≠ p_supplier_revision` → `purchase.supplier_changed`;
   - `inactive` → `purchase.supplier_inactive`.
6. `document_date` after today in the business timezone → `purchase.document_date_in_future` (the 0058 rule, early).
7. The FX:
   - domestic ⇒ the arguments are `(NULL, 1, 'base', <date>T00:00:00Z)`;
   - foreign ⇒ `accounting_purchase_fx_rate` at the R-17 instant; any difference → `purchase.fx_rate_changed`.
8. Recompute A-13 (landed `by_value` allocations re-derived from stored nets must equal the stored allocations; T, B, s_i). A difference → `inventory.valuation_changed`.
9. `purchase_lock_receipt_targets` (step 6).
10. `purchase_cover_deficits` when `p_coverage_adjustment_id IS NOT NULL`, or when any layer is open. Any open layer with a NULL id, or a covered/catch-up mismatch → `inventory.valuation_changed`.
11. `inventory_apply_stock_movements` with the A-16(f) request order. Any stored value ≠ the computed value → `inventory.valuation_changed`.
12. `UPDATE purchase_lines` (shares and costs). **Then** `UPDATE purchases` to `received`: snapshots, FX, `total_base_minor`, `binding_source_id = id`, `receive_intent_sha256`, `received_*`, trace.
13. `purchase_bridge_receipt`.
14. The audit and outbox (A-21).
15. `RETURN` the stored rows: purchase, lines with movement ids and values, header and coverages.

**`purchase_save_draft` order:**
1. The consume.
2. **`p_tax_minor <> 0` → `purchase.tax_policy_absent`.**
3. The isolation check and trace.
4. The draft intent digest and the key.
5. The row `FOR UPDATE`, then the proof:
   - create when the row is absent and `expected_revision = 0`;
   - replay when the revision is `expected+1` with an equal intent;
   - `purchase.draft_changed` when the revision differs;
   - `purchase.state_invalid` when the row is not a draft.
6. The supplier `FOR SHARE`, which must be active.
7. Warehouse, variant and currency validation, and `previous_warehouse_id` = the stored warehouse when it changes.
8. A-13 steps 1–5 (refusals as listed).
9. Delete the old lines, allocations and costs (draft only), then insert the new ones and upsert the header (revision + 1).
10. The audit and outbox.

### 2.5 Registrations in 0064 (last)

```sql
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('supplier.create','P3-S4'), ('supplier.update','P3-S4'), ('supplier.archive','P3-S4'), ('supplier.reactivate','P3-S4'),
  ('purchase.draft','P3-S4'), ('purchase.cancel','P3-S4'), ('purchase.receive','P3-S4');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES
  ('purchase.receive','purchase','P3-S4'), ('purchase.receive','negative_inventory_cost_adjustment','P3-S4');
```

### 2.6 RLS

Every S4 table follows the §0 layering:
- tenant membership;
- restrictive business isolation, **without** an internal admission in the restrictive `WITH CHECK`;
- `FOR SELECT TO daftar_inventory_internal USING (true)` on the six tables and two bridges;
- plus A-14(d) for the two accounting-read headers.

`daftar_app` reads under the tenant/business policies only.

### 2.7 What S4 does not change

- `inventory_apply_stock_movements`, `stock_movement_kinds`, every S3 routine and guard function body, and `inventory_source_value_complete()`.
- The accounting journal, `accounting_post_entry`, the FX registry and its lookup, the accepted permissions and roles.
- `bootstrap.sql` (nothing expected).
- S4 creates no role, no membership and no `BYPASSRLS`.

### 2.8 End-state blocks

**0063-E refuses the migration unless:**
1. `stock_source_types` is exactly the four S3 rows plus `purchase:P3-S4` and `negative_inventory_cost_adjustment:P3-S4`.
2. `inventory_stock_source_guard_gaps()` returns no row. Each §2.3 mutation probe, inside a rolled-back block, makes it report its gap.
3. `accounting_source_types` holds the five earlier rows unchanged plus the two S4 rows at `sort_order` 6/7. Every registered source type has a `post` or `reverse` kind (`0046:111-115`).
4. The coverage FK and the three new candidate keys exist and are validated.
5. `purchases_tax_policy_absent_ck` exists with the definition `CHECK ((tax_minor = 0))`.
6. No runtime role holds DML on any S4 table. `daftar_app` holds `SELECT` exactly on the A-18 set.
7. Every new function is owned per A-14/A-15, definer and pinned, and no runtime role may execute it.
8. `accounting_purchase_fx_rate` is executable by `daftar_inventory_internal` only.
9. The reversal guard's `prosrc` names the four domain source types.
10. Neither internal principal holds `CREATE` on `public`.

**0064-E refuses the migration unless:**
1. `inventory_operation_kinds` is the three S1, seven S3 and seven S4 kinds exactly.
2. The mappings are the six S3 pairs plus the two S4 pairs exactly.
3. The seven entry routines and three helpers are internal definer and pinned, and there are exactly ten of them.
4. `daftar_app` reaches each entry routine, and no other role or PUBLIC does. No runtime role, `daftar_app` or `daftar_accounting_internal` reaches a helper.
5. Each entry routine's first statement matches `^v_actor := inventory_assertion_consume\(`. Each helper's first statement matches `^v_actor := inventory_assertion_current\(ARRAY\[`.
6. In `purchase_receive` and `purchase_save_draft`, the document advisory key precedes the intent read (the R-14 analogue).
7. `stock_source_types` is unchanged since 0063, and the gaps function still returns no row.
8. No `CREATE` is left on `public`.

---

## 3. Error model

**Rule.** Every refusal is a stable `<domain>.<code>`, as in S3C §3.
- A new `purchasingRefusal` in `apps/api/src/modules/purchasing/purchasing-errors.ts` maps `purchase.*` and `supplier.*`, and delegates `inventory.*` to `inventoryRefusal` (`apps/api/src/modules/inventory/inventory-errors.ts`).
- Accounting refusals keep the accepted accounting mapping.

| Code | Raised by | HTTP | Retry? |
|---|---|---|---|
| `purchase.tax_policy_absent` | DTO/service (before minting); `purchase_save_draft`; CHECK | 422 | no — **BLOCKED BY OD-03** |
| `purchase.not_found` / `supplier.not_found` | routines (RLS-invisible counts as not found) | 404 | no |
| `purchase.state_invalid` | receive/cancel/draft on a non-draft | 409 | no |
| `purchase.draft_changed` | draft revision or line set moved | 409 | yes, after re-read |
| `purchase.supplier_changed` | supplier revision moved | 409 | yes, after re-read |
| `purchase.supplier_inactive` | draft, receive | 409 | no |
| `purchase.fx_rate_changed` | receive | 409 | yes |
| `purchase.fx_rate_missing` | service / FX read | 422 | no (enter a rate) |
| `purchase.currency_unknown` | DTO / routine | 400 | no |
| `purchase.document_date_in_future` | receive | 422 | no |
| `purchase.duplicate_variant` / `purchase.lines_required` / `purchase.amount_precision_invalid` / `purchase.discount_invalid` / `purchase.landed_cost_invalid` | DTO, service, routine | 400 | no |
| `purchase.landed_cost_denominator_zero` | draft (`by_value`, Σ net = 0) | 422 | no (use `manual`) |
| `purchase.landed_cost_allocation_mismatch` | draft (`manual` off by any amount); deferred allocation trigger | 422 | no |
| `purchase.total_zero` | draft / receive | 422 | no |
| `purchase.idempotency_conflict` / `supplier.idempotency_conflict` | service pre-check; routine | 409 | no |
| `supplier.revision_changed` | update/archive/reactivate | 409 | yes, after re-read |
| `supplier.state_invalid` | archive an inactive, reactivate an active | 409 | no |
| `supplier.not_deletable` | trigger | 409-class (no route deletes) | no |
| `inventory.valuation_changed` | receive (A-07: totals, shares, coverage) | 409 | **yes**, same body |
| `inventory.deficit_state_invalid` · `inventory.deficit_immutable` · `inventory.deficit_coverage_mismatch` | A-16 guards | 500-class if ever seen from a routine | no |
| `inventory.source_*`, `inventory.ledger_immutable`, `inventory.stock_source_line_missing` | S3/S4 triggers; tamper tests | 500-class from a routine | no |
| `accounting.inventory_detail_missing` / `accounting.inventory_entry_mismatch` | A-14(a) at COMMIT | accepted mapping | no |
| `accounting.reversal_source_domain_owned` | A-14(b) | 409 | no |
| `accounting.period_*`, `accounting.entry_date_in_future` | accepted accounting | accepted mapping | no |

The package `packages/inventory/src/errors.ts` gains the codes the arithmetic can raise:
- `purchase.landed_cost_denominator_zero`;
- `purchase.landed_cost_allocation_mismatch`;
- `purchase.discount_invalid`;
- `purchase.total_zero`;
- `inventory.deficit_state_invalid`.

Messages carry no amounts.

---

## 4. Packages and application

### 4.1 `@daftar/inventory` (framework-free; `phase3-s3-gate.ts:370-381` keeps enforcing it)

- **`payload.ts`.** It gains the seven codes in `INVENTORY_OPERATION_CODES` and their schemas in `INVENTORY_PAYLOAD_SCHEMAS`. This is additive, with coordinator sign-off: it is an S1 file.
- **`supplier-payloads.ts` and `purchase-payloads.ts`.** Payload builders and intent digests for the seven kinds (A-09, A-10(b)).
- **`landed-cost.ts`.** `allocateByValue`, `validateManual` and `lineTotals` (A-13 steps 1–4), on top of `allocation.ts` LR.
- **`purchase-shares.ts`.** `baseShares(B, t[])` (A-13 step 7) and `unitCostC10(s, qtyQ4)`. It takes B as an **input**, because the conversion belongs to `@daftar/accounting` and the package may import nothing else.
- **`deficit-coverage.ts`.** `planCoverage(layers, keyState, lines)` gives, per line, the coverages, values, flush eligibility and zero-catch-up rows (A-16(b)–(f)), reusing `valuation.ts` `catchUpValue`.
- **Vectors:**
  - `vectors/invpl-s4-vectors.json` has one vector per kind, and one per NULL-able field.
  - `vectors/landed-cost-vectors.json` covers an uneven `by_value` split with the `line_no` tie-break, a zero denominator, and manual off by +1 and −1.
  - `vectors/coverage-vectors.json` covers:
    - GOLD-54, GOLD-55 and GOLD-72, reusing the numbers of `valuation-vectors.json` (L:390: "not restated with different numbers");
    - one line × three layers;
    - a zero catch-up;
    - a flush with a residue (the A-16(e) worked case: layers 1 @ 10.5 and 1 @ 10.5 stored at 10 each, receipt 2 for 30: formula −4, −4; the flush makes the last −6, so the valuation is 0);
    - mixed signs netting to N = 0.
- **Parity.** Every vector is asserted identically in TypeScript and in SQL (L:390).

### 4.2 `@daftar/accounting`

- `post.ts:200`: `DOMAIN_SOURCE_TYPES` gains the two S4 types (additive, S3 TL-10).
- No other change. `convertToBaseMinor` (`src/fx.ts`) is used unchanged.

### 4.3 `apps/api/src/modules/purchasing/`

| File | Contents |
|---|---|
| `supplier.service.ts` | the four supplier commands |
| `purchase-draft.service.ts` | draft and cancel |
| `purchase-receipt.service.ts` | receive: A-10(c) order → reads (draft, supplier, FX, `stock_levels`, deficits) → `@daftar/inventory` plans → B via `convertToBaseMinor` → mint the inventory assertion + 1 or 2 accounting assertions → seam 2 → routine → post `purchase` → post catch-up iff N ≠ 0 → commit |
| `purchase-posting.ts` | the two `PostingCommand` builders, following the pattern of `inventory-posting.ts` |
| `purchasing-reads.ts` | A-20 |
| `purchasing-errors.ts` | §3 |
| `suppliers.controller.ts`, `purchases.controller.ts`, `purchasing.schemas.ts` | the API layer |

- `packages/shared-contracts/src/purchasing.ts` holds the response types.
- **The seam change for B-1 (R-B1):**
  - `apps/api/src/infra/database.ts`, `withBusinessInventoryAccountingTransaction`;
  - `apps/api/src/modules/accounting/accounting-posting.adapter.ts`, `postEntryInTransaction`.

---

## 5. Harness

**Deficit seeding (L:470; the S2 vector precedent `"seededByOwner": true`).** A new `tests/helpers/purchase-deficits.ts`, run as the schema owner, inside the test database only:
1. It installs the S2 committed fixture source (`tests/helpers/stock-ledger.ts`: `installCommittedFixture`, `FIXTURE_SOURCE_TYPE`).
2. It writes the negative fixture movements and a consistent `stock_levels` row.
3. It inserts `negative_inventory_deficits` rows (`deficit_seq` through `inventory_next_deficit_seq`, `0060`) so that `Σ uncovered = −on_hand` and the stored valuation matches the chosen numbers. For GOLD-72 that is `on_hand −10`, valuation `−1000`, and one layer of 10 @ 100.
4. It removes everything afterwards through `removeCommittedFixture`, **evolved** (§7.3) to truncate the S4 bridges, the coverage header and the S4 document tables that reference the bindings.

Every other suite uses the S3 harness (`tests/helpers/inventory-commands.ts`, `inventory-posting.ts`) with S4 builders added in a new `tests/helpers/purchase-commands.ts`. Embedded PostgreSQL runs on its own `PG_DIR`/`PG_PORT` per agent (SM:36).

---

## 6. Test plan

The files are `tests/integration/purchase-s4-*.test.ts` and `tests/security/purchase-s4-*.test.ts`, plus the package tests. Each Must-prove item of P:205-217 is named.

| # | Proves | Must-prove |
|---|---|---|
| T-01 | Grants and ACL: every runtime role is refused DML on the S4 tables (42501); `daftar_app` reads exactly A-18; the EXECUTE matrix | — |
| T-02 | Signed authority: each of the seven routines refuses a missing, forged, replayed or wrong-kind assertion, and a payload with any one field changed (`inventory.assertion_payload_mismatch`), before writing anything | P3-AL-55 |
| T-03 | Supplier lifecycle: create, update, archive, reactivate; revision races; no delete (trigger and FK); an inactive supplier is refused by draft and receive; the snapshot is taken at receipt and unchanged by a later update | L:1191-1200 |
| T-04 | Draft: create, replace (revision + 1, line ids kept), 200-line bound, duplicate variant, discount bounds; a draft writes no movement, entry or AP | L:737, L:767 |
| T-05 | Landed cost: an uneven `by_value` split with the `line_no` tie-break; Σ = total exactly; a zero denominator refuses; `manual` off by ±1 refuses; the deferred allocation trigger refuses a tampered allocation | P:212-213 |
| T-06 | Receipt posting: `Dr inventory B / Cr accounts_payable B`; `Σ s_i = B`; no `6100`/`6200`/`tax_payable` line; a **cash-labelled and a credit purchase produce byte-identical entry shapes** | P:207, P:211, PM-22 |
| T-07 | Immutability: `UPDATE`/`DELETE` on a received header, lines, landed costs, allocations and snapshots is refused, as owner too; a cancelled purchase refuses everything | P:214 |
| T-08 | Coverage: T-08.1 GOLD-72 end to end (80, then 180; GL Inventory 0; COGS 1260); T-08.2 one line × three layers gives three coverage rows, three movements with distinct `source_line_id`s and one entry = Σ stored values; T-08.3 GOLD-54 and GOLD-55; T-08.4 a zero catch-up (row, no movement); T-08.5 the flush-residue vector; T-08.6 mixed signs with N = 0 (no entry, header binding NULL) | P:207, P:216 |
| T-09 | Concurrency: two concurrent receipts on one key cover disjoint quantities (Σ ≤ original per layer; the loser 409s or waits and covers the rest after retry); two concurrent identical receives give one commit and one replay; draft vs receive on one purchase | P:216 |
| T-10 | FX: a foreign purchase snapshots the registry row at the R-17 instant; after a newer rate is entered, the purchase and its entry keep the old snapshot; JOD (3 dp) vs a 2 dp base; a missing rate refuses | P:217 |
| T-11 | Idempotency: a retried receive creates no second movement or entry; a replay succeeds after the draft's variant was archived (proof before state); a draft replay; the assertions of a replayed seam-2 transaction expire unused | P:215 |
| T-12 | AP reads: the purchase and supplier payable derived from the ledger equal the document totals; no stored balance column exists (catalogue); an assigned-scope actor is refused the supplier payable | L:843-854 |
| T-13 | Atomicity: a failure injected **after** each §2.4 step (routine, first post, second post, deferred triggers) leaves no purchase change, movement, coverage, deficit change, binding, entry, audit or outbox row, as a named test failpoint in the harness only | P:207 |
| T-14 | Tax: a non-zero `taxAmount` is refused before minting (no `inventory_assertion_uses` row); a signed non-zero `p_tax_minor` is refused by the routine; the owner's direct `UPDATE … tax_minor = 1` hits `purchases_tax_policy_absent_ck` | P:216 |
| T-15 | Tamper (deferred guards, one per mechanism): a received line without a movement; a coverage without its movement; a header total ≠ Σ; a deficit updated without coverage; an entry with a third line; a reversal of a purchase entry (`accounting.reversal_source_domain_owned`) | L:1550-1568 |
| T-16 | Gaps function: every §2.3 row is reported when disabled, replica-only, re-created on another function or body-changed; the S3 rows unchanged | A-16 |
| T-17 | The upgrade matrix: a frozen 0062 checkpoint plus an existing business goes to 0063/0064 with books, ledger and catalogue untouched, registries exactly S3 + S4, and a rerun no-op | — |
| T-18 | HTTP authority: every route refuses without its permission; `purchases.receive` without scope over the warehouse gets 403; the manager (view keys only) reads but cannot mutate | L:1174-1186 |

The package unit tests cover `landed-cost`, `purchase-shares`, `deficit-coverage`, `purchase-payloads` and `supplier-payloads`, each against its vectors, with SQL parity in T-08/T-05.

---

## 7. Gate, guards and predecessor evolution

### 7.1 `scripts/phase3-s4-gate.ts` (two tenses, the form of `scripts/phase3-s3-gate.ts:1-476`)

**Constants.**
- `S3_BOUNDARY = '0062_inventory_movement_commands.sql'`
- `S4_MIGRATIONS = ['0063_purchases_suppliers_sources.sql', '0064_purchase_commands.sql']`
- `S4_ACCEPTED: Record<string,string> = {}`, filled in the freeze commit only
- `ACCEPTED = Object.keys(S4_ACCEPTED).length > 0`

**1. Boundary.**

| Tense | Checks |
|---|---|
| Candidate | `frozenThrough === S3_BOUNDARY`; neither S4 file is in the manifest; the files after 0062 are exactly `S4_MIGRATIONS` |
| Accepted | `frozenThrough ≥ '0064…'`; each file hashes to `S4_ACCEPTED` on disk and in the manifest; the range `0063–0064` holds exactly the two files |

**2. Scope** (S4 files only, `stripComments`, the `insertedTuples` scanner of `phase3-s3-gate.ts:236-270`):
- **`REGISTRATIONS`**, exactly:
  - `stock_source_types`: `'purchase'`, `'negative_inventory_cost_adjustment'`;
  - `inventory_operation_kinds`: the seven;
  - `inventory_operation_movement_kinds`: the two pairs;
  - `accounting_source_types`: the two;
  - `accounting_operation_kinds`: `'post','purchase'` and `'post','negative_inventory_cost_adjustment'`.
- No `INSERT INTO stock_movement_kinds`.
- **`LATER_TABLES`** (S5+): `CREATE TABLE (supplier_return\w*|supplier_credit\w*|supplier_payment\w*|supplier_refund\w*|supplier_allocation\w*|payment_method\w*|purchase_reversal\w*|reservation\w*)`.
- No `reserved`/`available` column.
- **OD-03:** no `tax_payable` token, and no tax rate, percentage or `inclusive` column in either file. `purchases_tax_policy_absent_ck` with `CHECK (tax_minor = 0)` is present.
- No `rounding` or `purchase_price_variance` system key token (no `6100`/`6200` line).
- **`ALLOWED_EXECUTE`** is exactly the seven `…:daftar_app` grants plus `accounting_purchase_fx_rate:daftar_inventory_internal`, and there are exactly 8 `GRANT EXECUTE` statements.
- No role or membership change.

**3. Required objects:**
- the six tables and two bridges, created by 0063;
- every A-15/A-16 trigger by name;
- the seven routines and three helpers, created by 0064;
- the four accounting objects;
- `CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps(` in 0063, containing each of the thirteen S3 digests of `0061:302-318` **verbatim** and a digest for each §2.3 function;
- `SET LOCAL ROLE daftar_accounting_internal;[\s\S]*?CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard\(` naming all four types;
- both CREATE brackets.

**4. Packages:**
- `supplier-payloads.ts`, `purchase-payloads.ts`, `landed-cost.ts`, `purchase-shares.ts` and `deficit-coverage.ts`;
- the three vector files, with the case ids `GOLD54`, `GOLD55`, `GOLD72`, `THREE-LAYERS`, `ZERO-CATCHUP` and `FLUSH-RESIDUE` present;
- `DOMAIN_SOURCE_TYPES` naming both S4 types;
- `packages/inventory/src` still imports only itself and `node:`.

**5. Suites.**
- `SUITE_PATTERN = /^purchase-s4-.*\.test\.ts$/` in `tests/integration` and `tests/security`.
- `REQUIRED_SUITES` include `purchase-s4-coverage`, `purchase-s4-atomicity`, `purchase-s4-signed-authority` and `purchase-s4-upgrade`.
- At least 8 suites are required.

**6. Runner canary**, exactly `phase3-s3-gate.ts:411-426`.

**7. Composition.**
- Run `npm run gate:phase3:s3`, which composes S2, S1, P2-S8…P2-S1 and Phase 1.
- It must be in its **accepted** tense (TL-2).

**8. Run:**
- `npm run test -w @daftar/inventory`;
- `npm run test -w @daftar/accounting`;
- every discovered S4 suite;
- then `tests/performance/accounting-budgets.test.ts` in isolation. S4 adds two `WHEN`-filtered deferred triggers on `journal_entries`, and Budget A must stay at its accepted bound (S3C A-26).

**`package.json`:** `"gate:phase3:s4": "tsx scripts/phase3-s4-gate.ts"`, next to `package.json:55-57`.

### 7.2 Guards

| Guard | Change |
|---|---|
| G-3 `scripts/guards/no-authoritative-balance.ts` | **Extended (L:853).** A `SUPPLIER_TABLE_NAME = /^(suppliers\|supplier_[a-z0-9_]+\|purchases\|purchase_[a-z0-9_]+)$/` joins discovery, like `INVENTORY_TABLE_NAME` (`:202`), with the forbidden column patterns of `:123` plus `/(^\|_)(outstanding\|paid\|unpaid\|due\|owed\|payable)($\|_)/`. Its guard test gains positive and negative cases |
| Rule 22 `scripts/guards/inventory-writer-authority.ts:39-40` | **Strengthened (ENG+TL, as S3C §7.2 offered).** `STOCK_WRITE_TABLES` gains `negative_inventory_cost_adjustments`. The writers become the primitive, `inventory_bridge_source_lines`, `purchase_cover_deficits` and `purchase_bridge_receipt` |
| G-7 `inventory-definer-contract.ts` | no code change; it discovers the ten new routines and the new guard functions |
| G-4 `posting-surface.ts`, G-1 `journal-privilege-model.ts` | no change: no journal writer, no accounting-table grant |
| Rules 6, 7, 21; `no-float-rate.ts` | satisfied: BIGINT money, `NUMERIC(20,10)` rate, `inventory_half_even` only |

### 7.3 Predecessor pins that 0063/0064 turn red, and their evolution (ENG, the P2-S4 §45 form)

**Sequencing precondition (TL-2).** P3-S3 is accepted and frozen **before** the commit adding 0063:
- `S3_ACCEPTED` is filled;
- `frozenThrough ≥ 0062`;
- `gate:phase3:s3` is green in its accepted tense.

Otherwise `phase3-s3-gate.ts:214-221` (candidate: "after 0060 exactly 0061, 0062") fails. `phase3-s3-gate.ts:104` (the `purchase\w*|supplier\w*|…` scope regex) reads S3 files only and is **not** affected.

Every pin below evolves **in the same commit** as the migration that turns it red, by the coordinator:
- the accepted rows stay, verbatim and in order;
- the S4 rows are **appended** with a `// P3-S4 (0063/0064)` comment;
- nothing is deleted except where stated.

| # | Pin (file:line) | Today | Evolves to | Turned red by |
|---|---|---|---|---|
| 1 | `tests/integration/migration-upgrade.test.ts:459-465` | `accounting_source_types` by `sort_order` = the five | + `purchase`, `negative_inventory_cost_adjustment` | 0063 |
| 2 | `migration-upgrade.test.ts:766` (P2-S6 case) | protected rows + `src:inventory_adjustment:4`, `src:inventory_opening:5` | + `src:purchase:6`, `src:negative_inventory_cost_adjustment:7` | 0063 |
| 3 | `migration-upgrade.test.ts:1180-1227` (P3-S2 case) | registries exactly the S3 rows; `stock_source_types: 4`, `inventory_operation_movement_kinds: 6` | + the S4 rows; counts 6 and 8; the ledger counts stay 0 | 0063 (types), 0064 (mappings) |
| 4 | `migration-upgrade.test.ts:1402` and `:1422-1440` (P3-S3 case) | `after` = before + the two S3 `src:` rows; registries exactly checkpoint + S3 | + the two S4 `src:` rows; + the S4 type, map and op rows. `:1406` (`applied.slice(0,2)`) stays true. **Plus a new P3-S4 case (T-17)** | 0063/0064 |
| 5 | `tests/golden-regression/phase2/01-engine-shapes.golden.test.ts:549-556` | source types exactly native three + the two S3 | + the two S4, in order | 0063 |
| 6 | **`01-engine-shapes.golden.test.ts:525-545`** | the `forbidden` list includes **`'suppliers'`** | remove `'suppliers'` only, with the `accounting_periods` precedent comment (`:515-522`): an authorized slice created it on purpose. `supplier_credit_notes` and `supplier_refunds` stay forbidden until S5/S6 | 0063 |
| 7 | `tests/security/accounting-sources-authority.test.ts:106-120` | exactly five `accounting_operation_kinds` pairs | + `('post','negative_inventory_cost_adjustment')`, `('post','purchase')` in sort position | 0063 |
| 8 | `tests/security/journal-privilege-matrix.test.ts:335-356` | `accounting_validator` policy tables exactly 11; `S3_HEADERS` | + `negative_inventory_cost_adjustments`, `purchases`; the headers list gains both | 0063 |
| 9 | `tests/security/inventory-db-authority.test.ts:217-259` | the internal principal's exact table privileges | + the A-18 S4 tables, bridges, `currencies: SELECT`, `negative_deficit_coverages: INSERT,SELECT` | 0063 |
| 10 | `inventory-db-authority.test.ts:262-290` | the exact column privileges | + the `suppliers`, `purchases` and `purchase_lines` UPDATE columns, `negative_inventory_deficits UPDATE (status, uncovered_qty)` | 0063 |
| 11 | `inventory-db-authority.test.ts:332-356` | the exact routine EXECUTE matrix | + the seven S4 entry routines, `daftar_app` | 0064 |
| 12 | `tests/security/stock-ledger-authority.test.ts:74` (`APP_READABLE`) and `:98-108` (`A01`) | `daftar_app` reads only movements/levels; internal: deficits `SELECT`, coverages none | `APP_READABLE` + deficits, coverages; `A01` deficits `SELECT` + UPDATE (2 cols), coverages `INSERT, SELECT` | 0063 |
| 13 | `stock-ledger-authority.test.ts:145-156` (T-02.1 discovery) | `S2_RELATIONS + S3_BRIDGES` | + the two S4 bridges + `negative_inventory_cost_adjustments` (it matches `negative\_%`) | 0063 |
| 14 | `stock-ledger-authority.test.ts:724-805` (trigger matrix) | S2 triggers + four S3 binding guards | + two S4 binding guards on `stock_source_bindings`, the two deficit triggers | 0063 |
| 15 | `stock-ledger-authority.test.ts:273-315` and `:806` (0059-E/0060-E replayed at the P3-S2 checkpoint via `rewindToP3S2Checkpoint`) | the rewind undoes S3 only | **the rewind helper evolves** (row 17); the tests are then unchanged | 0063/0064 |
| 16 | `tests/security/stock-ledger-structure.test.ts:219-238` (`seedAll`) and `:826-840` (T-20.4) | coverage inserted with a random `adjustment_id` | seed a coverage header first (owner insert of a purchase fixture and a header), or evolve T-20.4's valid-row case the same way. The CHECK-refusal cases keep their codes, because CHECK fires before the FK. `:436-447` (registries) follows row 17's constants. `:876-878` (PM-44 "the only stock writer is R3") + `purchase_cover_deficits` (it writes deficits/coverages) | 0063/0064 |
| 17 | `tests/helpers/stock-ledger.ts:108-137` (constants), `:547-570` (`assertMigrationState`), `:586-600` (`rewindToP3S2Checkpoint`), `:617` (TRUNCATE list) | the S3 sets exactly | add `S4_SOURCE_TYPES`, `S4_OPERATION_KINDS`, `S4_OPERATION_MOVEMENT_KINDS`, `S4_BRIDGES`; the migration state = S1 + S3 + S4. The rewind also deletes `registered_by='P3-S4'` (mappings, then types) and revokes the S4 grants that 0059-E (6) inspects (internal deficit UPDATE and coverage INSERT/SELECT, `daftar_app` SELECT on both), each counted, then asserts the checkpoint. The TRUNCATE adds the S4 bridges | 0063/0064 |
| 18 | `tests/integration/inventory-db-guard.test.ts:47-76` (G-7 transferred) and `:122-130` (rule-22 writers) | exact S3 lists | + the ten S4 routines and the new guard functions; writers + `0064: purchase_cover_deficits`, `0064: purchase_bridge_receipt` | 0063/0064 |
| 19 | `tests/security/search-path-shadowing.test.ts:475-489` (`EXECUTE_MATRIX`) | exact S1 + S3 | + seven `…: ['daftar_app']` | 0064 |
| 20 | `tests/integration/migration-portability.test.ts:1095-1188` (named owners) | exact S1–S3 set | + every S4 internal routine and guard; + the four accounting-owned S4 functions in the `IN` list | 0063/0064 |
| 21 | `packages/inventory/test/payload.test.ts:219-233` | exactly S1 three + S3 seven | + the seven S4 kinds (schemas keyed by codes stay true) | package change |
| 22 | `packages/accounting/test/domain-posting.test.ts:114` | `DOMAIN_SOURCE_TYPES` = the two S3 | + the two S4 | package change |
| 23 | `tests/security/inventory-s3-authority.test.ts:379-405` ("registries are exactly S1 + S3"; new since `ed3e7b0`) | `inventory_operation_kinds` = S3 seven + S1 three; `inventory_operation_movement_kinds` = the six S3 mappings; guard gaps empty | + the seven S4 op codes; + `purchase.receive→purchase`, `purchase.receive→negative_inventory_cost_adjustment`; the gaps assertion stays `[]` | 0064 |

- **Not affected:**
  - `0061-E`/`0062-E` are apply-time blocks and run before 0063 exists. 0062-E's "exactly S3" checks are never replayed by a test.
  - `tests/integration/inventory-s3-review-fixes.test.ts:407-470` and `tests/security/inventory-s3-source-guards.test.ts` (T-13; mutates only the four S3 types, and its "installed catalogue reports no gap" ALLOW holds while the S4 guards are complete), because §2.3 keeps the S3 part byte-identical.
  - `tests/integration/process-composition.test.ts`, if both modules register the controllers.
  - `phase3-s1-gate`, `phase3-s2-gate` and `phase3-s3-gate` scope checks, which are scoped to their own files.
  - `gate:phase2:release`, which covers `0000`–`0052`.
- **Negative proof.** Each evolved predicate stays exact. A rolled-back injection of an unauthorized row (`accounting_source_types … 'sale'`, `stock_source_types … 'fixture_rogue'`, an op kind `purchase.approve`) fails it (S3C A-20).

---

## 8. File ownership (SAFE_CONCURRENCY = 5, SM:41-42)

| Agent | Owns (writes) | Must not touch |
|---|---|---|
| **C: coordinator** | this contract; the S3 freeze (TL-2) and later `MIGRATION_MANIFEST.json` for S4 (freeze commit only); **every §7.3 pin** (rows 1–23, including `tests/helpers/stock-ledger.ts` and the two package test files); `scripts/phase3-s4-gate.ts` and the `package.json` line; the G-3 and rule-22 guard extensions with their guard tests; `docs/DAFTAR_STATE_MACHINES.md` (the Purchase machine, L:137); `PROJECT_STATUS.md`; `docs/PHASE_3_S4_ACCEPTANCE.md` | migrations; `src/**` |
| **M: migration writer** (the only schema writer, SM:36) | `infrastructure/database/migrations/0063_purchases_suppliers_sources.sql`, `0064_purchase_commands.sql` | everything else |
| **D: domain/application and packages** | `packages/inventory/src/{supplier-payloads,purchase-payloads,landed-cost,purchase-shares,deficit-coverage}.ts`, the additive edits of `payload.ts`, `errors.ts`, `index.ts` (coordinator sign-off: S1 files), `packages/inventory/vectors/{invpl-s4,landed-cost,coverage}-vectors.json`, their `packages/inventory/test/*.test.ts`; `packages/accounting/src/post.ts:200` (additive); `apps/api/src/modules/purchasing/{supplier.service,purchase-draft.service,purchase-receipt.service,purchase-posting,purchasing-reads,purchasing-errors}.ts`; the `OPERATION_AUTHORITY` rows in `inventory-authorization.ts`; **the R-B1 seam change** in `apps/api/src/infra/database.ts` and `accounting-posting.adapter.ts`, only after B-1 is decided | controllers, DTOs, module wiring, tests outside `packages/*/test` |
| **A: API** | `apps/api/src/modules/purchasing/{suppliers.controller,purchases.controller,purchasing.schemas,purchasing.module}.ts`; the wiring in `apps/api/src/app/app.module.ts` and `merchant-api.module.ts`; `packages/shared-contracts/src/purchasing.ts` and its `index.ts` export | services, migrations, tests |
| **T: tests** | `tests/helpers/purchase-commands.ts`, `tests/helpers/purchase-deficits.ts`; every §6 T-file (`tests/integration/purchase-s4-*.test.ts`, `tests/security/purchase-s4-*.test.ts`), including the seam test of R-B1 | predecessor tests (they belong to C), `src/**`, migrations |

**Merge order** (SM:64):
1. **C:** contract; S3 freeze; B-1 decision recorded.
2. **M:** 0063 with C's rows 1, 2, 3 (types), 5–10, 12–17 (one green commit). Then 0064 with rows 3 (mappings), 4, 11, 18–20.
3. **D:** packages (with rows 21–22), then services and the seam.
4. **A:** controllers and DTOs.
5. **T:** suites. T may start once step 2 lands.
6. **C:** gate, guards, acceptance page, the independent security review (SM:49), then the S4 freeze commit.

---

## 9. Real blockers and Tech Lead notes

### 9.1 Real blockers

**B-1 · Two postings in one receipt transaction, but the accounting seam carries one assertion. This is an architectural contradiction.**

- **The contradiction, exactly:**
  - L:976 and `apps/api/src/infra/database.ts:468-483` define seam 2 as `withBusinessInventoryAccountingTransaction(scope, inventoryAssertion, accountingAssertion, fn)`. It takes **one** accounting assertion and sets `app.accounting_assertion` once (`database.ts:346`).
  - An accounting assertion names exactly one `source_type`, one `source_id` and one posting fingerprint (`0061:120-200`, the owner-replaced `accounting_actor`, claims 7-9). One assertion therefore authorizes one journal entry.
  - L:487 (AL-13 step 4) requires the catch-up entry, bound to the **header** source `negative_inventory_cost_adjustment` (L:506), to post "in the **same** transaction, through the accounting-aware seam of P3-AL-32" as the purchase entry (L:1012, P:207).
  - L:824 (AL-24) will need the same for S6's purchase + payment in one command.
  - No lock text says how one seam carries two assertions. Setting the GUC from inside the callback would bypass the seam's pre-connection coherence check (L:992) and the "type, never a flag" rule (L:988).
- **Scope of the block.** Only receipts whose coverage net N ≠ 0. That is a Must-additionally-prove item (P:207, T-08) and therefore blocks S4 **acceptance**, not S4 start. Everything else (suppliers, drafts, landed cost, receipts without coverage, FX, AP reads) is unaffected.
- **Recommended resolution (R-B1), which needs a Tech Lead lock amendment to P3-AL-32 item 2:**
  - Seam 2's third parameter becomes a non-empty ordered tuple, `accountingAssertions: readonly [string, ...string[]]`, one per posting the operation implies. Every element is coherence-checked (tenant and business) **before** a connection is taken.
  - The handle's posting capability presents them in order. Before each `postEntryInTransaction`, the adapter checks that the command's `(sourceType, sourceId)` equals the next assertion's claims, sets `app.accounting_assertion` for that entry with `set_config(…, true)`, and refuses `seam.accounting_assertion_unused` if any assertion is left unpresented at a successful commit, or `seam.accounting_assertion_exhausted` if one is missing.
  - **No SQL changes.** `accounting_actor`'s per-jti first-transaction rule (`0061:200-215`) and the fingerprint already make each assertion single-entry.
  - The single-element form is exactly today's seam, so every S3 caller is untouched.
- **If R-B1 is refused**, the only lock-conformant alternative is a different single-entry model. That contradicts L:506 (entry bound to the header) and L:1034-1048 (the separate source type). The coverage path then cannot ship, and P:207 must be re-scoped by the Tech Lead.

**Not blockers** (checked against the six categories):
- **OD-03** is bounded by P3-AL-23. S4 refuses non-zero tax and designs no tax, and every tax element is marked **BLOCKED BY OD-03** (A-12). That is the lock's own scoping (SM:70). Phase 3 is not blocked.
- **The FX instant** is an engineering choice inside the accepted registry contract (TL-2).
- **No paid provider**, because the FX source is manual only (OD-11).
- **No external credential**, and TD-10 is unchanged: no second signer, and `ACCOUNTING_ASSERTION_KEY` stays in `merchant-api`.
- **No destructive data decision.** 0063's new FK and keys validate against empty tables.
- **TD-12 and TD-14** are outside S4.

### 9.2 Tech Lead notes (engineering rulings to confirm)

- **TL-1 · Pins.** P:205 names no predecessor pin. The tree holds 23 that 0063/0064 turn red (§7.3). Two are easy to miss:
  - golden `01-engine-shapes:525-545` forbids a `suppliers` table;
  - `stock-ledger-structure:876-878` pins "the only stock writer is R3".
- **TL-2 · Sequencing and the FX instant.**
  - S3 must be accepted and frozen before 0063 (S3 gate candidate tense).
  - The FX snapshot instant is the last second of `document_date` in the business timezone, with no `now()`. It is deterministic for the service and the routine alike, and it honours "snapshot at document date" (L:834-837). An alternative (the first second, or the receipt instant) is a one-expression change.
- **TL-3 · Supplier kinds.** L:1926 lists "create/update/archive". AL-40 (L:1195-1197) requires reactivation, so S4 registers `supplier.reactivate` as a fourth supplier kind, one per command, rather than a signed direction flag.
- **TL-4 · Scope.**
  - Supplier mutations are permission-only, because suppliers are business-wide master data.
  - The supplier payable read requires business-wide scope, because it aggregates AP across all warehouses. This is the F4 opening precedent, `inventory-authorization.ts:36-40`.
- **TL-5 · Zero catch-up.** A coverage with `actual = provisional` records the coverage row and writes **no** movement, because frozen `0059:150` forbids a zero value-only movement. L:1541's "exactly one" is read as "iff non-zero", L:1543's own qualifier for stocktake.
- **TL-6 · Zero-crossing flush.** When a receipt closes every layer at its key exactly, the last coverage takes `−valuation`. Otherwise AL-49's per-coverage formula (L:1384) and its `on_hand = 0 ⇒ valuation = 0` invariant (L:1386) can conflict by a residue, and the whole receipt would be refused at COMMIT. It is identical to the formula whenever no residue exists (GOLD-72). The alternative is to refuse such a receipt with `inventory.deficit_residue`.
- **TL-7 · Header grain.** One header per receipt (L:495, DM:259, PM-30). `origin_source_line_id` is carried and NULL, and the covering line is derived from `(origin_source_id, variant_id)`, which is exact by L:767. A per-line header would contradict "one per receipt operation" in three documents.
- **TL-8 · Zero-total purchase refused** (`purchase.total_zero`). A free-goods receipt would be an inbound with no journal. It is not in the plan, and a journal amount must be > 0.
- **TL-9 · Discounts per line only.** L:807 says "fully supported". A document-level discount can be expressed per line by the merchant or the S7 UI. Adding it later is one allocation, like `by_value` landed cost, with no model change.
- **TL-10 · New `daftar_app` reads of the S2 deficit tables** (A-18). They are needed to bind the catch-up amounts before the seam opens (A-07). They are read-only under the existing S2 RLS policies.
- **TL-11 · Rule 22 strengthened** to include the coverage header table (§7.2).
- **TL-12 · One seam per receipt.** A receipt always opens seam 2, since T > 0. Its catch-up assertion is minted only when the bound N ≠ 0 (under R-B1).
