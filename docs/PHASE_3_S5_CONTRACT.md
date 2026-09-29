# DAFTAR — P3-S5 Contract / عقد الشريحة P3-S5

> **Coordinator rulings on this contract (2026-09-26).** Adopted as the P3-S5 implementation contract. **B-1 and B-2 were decided by the Tech Lead** on a decision card in the Phase 3 thread (2026-09-26 21:58Z, "at the original cost"): R-B1a — a new migration replaces the S2 stock primitive by its owner so that a `purchase_reversal` movement takes the exact negation of its paired `purchase` movement, with the residue guard, and P3-AL-49 §C gains that one row; R-B2a — the reversal posts through the accepted Phase 2 reversal workflow (`accounting_post_reversal`) and `purchase_reversal` is registered as a stock source type only. No frozen migration is edited. The Tech Lead notes of §9.2 are adopted as engineering rulings: TL-2 (derived `reversed`), TL-3 (FX dust and `supplier_return.amount_below_base_unit`), TL-4 (reversal under `purchases.receive` plus warehouse scope), TL-5, TL-6, TL-7 (a covering receipt is not reversible), TL-8 (`purchase_reversal.valuation_residue`), TL-9, TL-10, TL-11 (landed cost is carrying value), TL-12 (`supplier_return.value_zero`), TL-13 (credit notes insert-only in S5) and TL-14. TL-1 is a sequencing fact: P3-S4 is frozen before 0065 lands. **OD-03** stays bounded; every tax element is BLOCKED BY OD-03.

> **Summary (Arabic).** عقد تنفيذ الشريحة P3-S5:
> - مرتجع المورّد بمتوسط التكلفة الحالي للمستودع الذي تغادره البضاعة.
> - القيمة الدفترية الأصلية لسطر الشراء مجمَّدة على سطر المرتجع، والفرق يذهب إلى فروق أسعار الشراء `6200`.
> - الذمم الدائنة أولًا، والفائض إشعار دائن للمورّد على `1150`.
> - عكس الشراء بشروطه الأربعة، وتسجيل نوعَي المصدر.
>
> لا ضريبة غير صفرية (OD-03).
>
> العائقان الحقيقيان:
> - **B-1:** P3-AL-20 تطلب حركات عكسية بتكلفة الاستلام الأصلية. P3-AL-11 وP3-AL-49 §C والبدائية المجمَّدة 0060 تفرض أن كل حركة خارجة تُقيَّم بالمتوسط الحالي.
> - **B-2:** P3-AL-20 تطلب القيد العكسي "عبر سير عمل العكس المعتمد في المرحلة الثانية". P3-AL-34 تسجّل `purchase_reversal` نوعَ مصدر محاسبيًا مستقلًا.

> **Status.** Candidate contract for P3-S5, written by the S5 contract agent. It is analysis only: no repository file was changed and PostgreSQL was not started.
> - **Tree.** Branch `phase/3-inventory-purchases-suppliers`, worktree reset to `201d7bd` ("fix(gate): gate:phase3:s4 reads spaced-or-compact tuples…").
> - **S4 is an unfrozen candidate** at `201d7bd`:
>   - `MIGRATION_MANIFEST.json` has `frozenThrough = 0062_inventory_movement_commands.sql`;
>   - `scripts/phase3-s4-gate.ts` has `S4_ACCEPTED = {}`;
>   - 0063/0064 exist, and so do the S4 services under `apps/api/src/modules/purchasing/`;
>   - the S4 test suites (`purchase-s4-*`) and the S4 §7.3 pin evolutions do not exist yet.
> - **How this contract treats S4.** Every predecessor pin below is therefore stated **as S4 §7.3 will leave it**. S5 lands only after S4 is accepted and frozen (TL-1).
>
> **Sources, in order of authority:**
> 1. Code and migrations `0000`–`0064`. 0059–0064 were read in full where cited.
> 2. Tests.
> 3. `docs/PHASE_3_ARCHITECTURE_LOCK.md` (L). The lock wins over every other document.
> 4. `docs/PHASE_3_EXECUTION_PLAN.md` §7 and §12–§14 (P).
> 5. `docs/PHASE_3_PREMORTEM.md` (PM), `docs/PHASE_3_SLICE_MAP.md` (SM), `TECHNICAL_DEBT.md` (TD), `DAFTAR_OPEN_DECISIONS.md` (OD) and `docs/DAFTAR_DATA_MODEL.md` (DM).
>
> **Shape.** It mirrors `docs/PHASE_3_S4_CONTRACT.md` (S4C) and `docs/PHASE_3_S3_CONTRACT.md` (S3C):
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

- **Citations.** Every S4C prefix carries forward: `L:`, `P:`, `SM:`, `PM-nn`, `TD-nn`, `S3C:`, `IR:`. S5 adds `S4C:` (this contract's predecessor) and `DM:`.
- **Ruling classes.** Exactly those of S4C §0:
  - **ENG** binds the implementers.
  - **ENG+TL** binds the implementers until the Tech Lead overrules it (§9.2).
  - **BLOCKER** is used only for:
    - a product-constitution ambiguity;
    - a legal or tax rule;
    - a paid provider;
    - an external credential;
    - a destructive data decision;
    - an architectural contradiction.
- **Carried forward unchanged from S4C §0:**
  - **SQL refusals** are `'<domain>.<code>: <safe text>'` with `ERRCODE 'P0001'`, and no amounts.
  - **The definer contract (G-7):**
    - `SECURITY DEFINER`;
    - `SET search_path = pg_catalog, public, pg_temp`;
    - `REVOKE ALL … FROM PUBLIC` in the same file;
    - no dynamic `EXECUTE`;
    - handover inside a `GRANT/REVOKE CREATE ON SCHEMA public` bracket (P:275-287).
  - **RLS** follows the `stock_movements` layering (`0059:311-359`).
  - **Types:** quantity is `NUMERIC(18,4)`, cost `NUMERIC(28,10)`, money `BIGINT` minor, rate `NUMERIC(20,10)`.
- **Design lessons, binding on every S5 object (ENG):**
  - **Registry after guards.** A registry row claims its guards and routine exist. So:
    - stock and accounting source types are registered after their bridges, triggers, completeness functions and the replaced gaps function;
    - operation kinds and mappings are registered after their routines.
  - **Proof before state.** An entry routine consumes its assertion, takes its document key, and decides replay or refusal from the document row **before** any stock, supplier, FX or ledger read (S4C A-10(d), 0064 R-26).
  - **No clock in a fingerprinted command.**
    - Every date the database stores or posts (`document_date`, `reversal_date`) is a required, bound client input.
    - The FX of a return is the purchase's stored snapshot, never a new lookup.
    - Neither the service nor the routine derives a date or a rate from `now()`. `now()` appears only in the 0058-style "not in the future" comparison and in `created_at`.
  - **INVOKER when `current_user` decides.** A guard that decides by `current_user`, or that must see only what its caller sees, is `SECURITY INVOKER`.
    - The two S5 read functions (A-16) are INVOKER, owned by the migrator.
    - The gaps function stays migrator-owned INVOKER.
  - **Lock order.** R-34 (§2.2) extends S4's R-15 and never reorders it.
  - **Rule 21:** no `round(`. HALF_EVEN is always `inventory_half_even` (`0060:83`), and exactness checks use `trunc(x, n) = x`.
- **New refusal domains.** S5 raises refusals under `supplier_return.*` and `purchase_reversal.*`, next to `purchase.*`, `supplier.*`, `inventory.*` and `accounting.*`.
- **Frozen history.**
  - `0000`–`0062` are frozen.
  - 0063/0064 are frozen by the P3-S4 freeze commit **before** 0065 lands (TL-1).
  - S5 edits no earlier migration. Each earlier function it changes is `CREATE OR REPLACE`d in a new migration, by the function's owner:
    - the migrator for `inventory_stock_source_guard_gaps()`;
    - `SET LOCAL ROLE daftar_accounting_internal` for `accounting_reversals_20_domain_source_guard()`;
    - `SET LOCAL ROLE daftar_inventory_internal` for `inventory_apply_stock_movements(inventory_movement_request[])`. This one only under R-B1a (B-1), on the 0060 precedent for `inventory_configure_product`: `scripts/guards/inventory-definer-contract.ts:44-57`.

---

## 1. Rulings

### A-01 · Slice scope and object inventory (ENG)

**In scope** (P:222-235, L:747-760, L:905-936, L:1034-1060, L:1415-1440, L:1926):
- the supplier return, at the current average of the warehouse the goods leave, with the original carrying value frozen per line and the difference to `purchase_price_variance` (6200);
- AP first; any excess becomes a **supplier credit note** on `supplier_receivable` (1150);
- purchase reversal under its four preconditions, at the original receipt cost, through the Phase 2 reversal workflow (B-2);
- registrations:
  - `supplier_return` in **both** registries;
  - `purchase_reversal` in `stock_source_types` (B-2 decides whether also in `accounting_source_types`);
  - two `invctl/1` operation kinds and their two movement mappings.

**Out of scope, each owned elsewhere:**

| Item | Owner |
|---|---|
| supplier payments, payment/credit allocations, supplier refunds, `payment_methods`, realized FX `4900/6900` on 1150 | S6 |
| any decrement of a credit note's remaining values (AL-31) | S6 (A-11(e)) |
| merchant UX, return/credit screens, statements | S7 |
| **tax on a return or a credit note, a tax reversal on purchase reversal** | **BLOCKED BY OD-03** (A-14) |
| revaluation of open AP or of 1150 | **OD-07**, not Phase 3 |
| a return with no purchase reference (a "free" return) | not Phase 3 (L:907: a return references the original purchase line) |
| an edit or a delete of a return, a credit note or a reversal | never: all three are insert-only |

### A-02 · Migration plan: exactly two migrations, 0065 then 0066 (ENG)

| # | File | Holds |
|---|---|---|
| 1 | `0065_supplier_returns_reversals_sources.sql` | All **structure**: the two candidate keys on S4 tables; the five tables and two bridges; every stock-side guard; the replaced primitive (R-B1a); the replaced gaps function; the two stock source registrations; the accounting-side objects (the `supplier_return` completeness trigger, the replaced reversal guard, `accounting_purchase_entry_id`); the accounting registration; grants and RLS; **0065-E** |
| 2 | `0066_supplier_return_reversal_commands.sql` | The two INVOKER read functions; three internal helpers; the two signed entry routines; EXECUTE grants and the ownership transfer; the two operation kinds and the two mappings, **last**; **0066-E** |

**Why these are needed (the brief: "only if truly needed").**
- S5 creates five tables, two bridges and their guards. No earlier migration can hold them, because 0063/0064 are frozen before 0065.
- The split is S4C A-02's, for the same reasons:
  - **Sources before commands.** 0065-E proves the gaps function returns no row, including by rolled-back mutation, before any routine exists that could write a `supplier_return` or `purchase_reversal` movement.
  - **No kind before its routine.** 0066 registers the kinds last.
- A third migration buys nothing:
  - the primitive's replacement must precede the stock registration of `purchase_reversal`, since the registry must not outrun its value rule;
  - the accounting objects must precede the `supplier_return` accounting registration (`0046:111-115`).
- **Numbering.** 0065 lands only after P3-S4 is accepted and frozen (TL-1). Otherwise `gate:phase3:s4`'s candidate tense ("after 0062 exactly 0063, 0064") goes red.

### A-03 · Operation kinds: two, one per command (ENG; the reversal permission is ENG+TL, TL-4)

The kinds follow L:1926: "supplier return, purchase reversal … one kind per command, named for the command, checked against that command's permission and scope". The grammar is `^[a-z]+(\.[a-z_]+)+$` (`0054:53`).

| `op_code` | Routine | Permission (L:1128-1140) | Scope (L:1174-1186) | Seam |
|---|---|---|---|---|
| `purchase.return` | `purchase_return` | `purchases.return` | the **return** warehouse, the one the goods leave (TL-5) | 2, always |
| `purchase.reverse` | `purchase_reverse` | `purchases.receive` (TL-4) | the purchase's warehouse | 2, always |

**Op→movement-kind mappings** (L:1992):
- `('purchase.return','supplier_return')`
- `('purchase.reverse','purchase_reversal')`

No `stock_movement_kinds` row is added. Both kinds exist since P3-S2 and are `negative` with `requires_reason = false` (`0059:78-95`; `tests/helpers/stock-ledger.ts:91-93`).

`OPERATION_AUTHORITY` in `apps/api/src/modules/inventory/inventory-authorization.ts:44-52` gains two rows:
- `'purchase.return': { permission: 'purchases.return', scope: 'warehouses' }`
- `'purchase.reverse': { permission: 'purchases.receive', scope: 'warehouses' }`

### A-04 · Documents and state machines (ENG; the derived `reversed` state is ENG+TL, TL-2)

**Supplier return.**
- It is insert-only: one command writes the header, its lines, its credit note if any, its movements, its bridges and its entry.
- There is no draft, no edit, no cancel and no delete. A mistaken return is corrected by a new purchase (L:751).
- **One warehouse per return** (TL-6). A multi-warehouse return is several returns.
- **One purchase per return.** The carrying value, the AP and the FX are all the purchase's (L:907).

**Supplier credit note.**
- It exists iff a return's value exceeds the purchase's outstanding AP (A-10).
- It is written only inside that return, insert-only in S5 (A-11(e)).

**Purchase: `received → reversed`**, as a **derived** state (TL-2).

```
draft(r) --purchase.receive--> received --purchase.reverse--> reversed     -- terminal; never back to draft (L:757)
```

- **`reversed` ⇔** a `purchase_reversals` row exists for the purchase (`purchase_reversals.id = purchase_id`, CHECK). It is answered by a join, exactly as Phase 2 answers "is this entry reversed?" (`0046:151-165`, AL-12).
- `purchases.status` stays `'received'`. **S5 never updates `purchases`**, so:
  - every S4 guard function is kept byte-for-byte:
    - `purchase_header_guard()` refuses every change to a non-draft header;
    - `purchases_binding_owed_ck`;
    - `purchase_source_value_complete()`;
  - every one of the eight S4 digests of the gaps function stays verbatim (§2.3).
- **Reads** (`purchasing-reads.ts`) and the API report `status: 'reversed'` from the join. `DAFTAR_STATE_MACHINES.md` records the derived state (§8, C).
- **After reversal:**
  - a return is refused (`supplier_return.purchase_reversed`);
  - a second reversal replays or is refused (A-09).

### A-05 · Accounting source mapping and journal shapes (ENG; the route of the reversal entry is **B-2**)

| Accounting source | `source_id` | Entry (lines by `system_key`) | Dimensions | When |
|---|---|---|---|---|
| `supplier_return` | the return id | the A-10 lines: `Dr accounts_payable` (1 or 2 lines), `Dr supplier_receivable` iff credit, `Cr inventory` iff I > 0, `Dr/Cr purchase_price_variance` iff PPV ≠ 0 | AP and 1150 lines: `branch_id` = the **purchase** warehouse's home branch, `warehouse_id` NULL (S4C A-05 AP precedent). Inventory and PPV lines: `warehouse_id` = the **return** warehouse, `branch_id` = its home branch (S4C A-05 NICA precedent) | every return (A-10(g)) |
| `reversal` (B-2, R-B2a) | the purchase's journal entry id | the Phase 2 mirror of the purchase entry, derived from persistence by `accounting_post_reversal` (`0046:449-…`): `Dr accounts_payable T/B`, `Cr inventory T/B` | the mirror's, i.e. the purchase entry's | every reversal |

- **No `6100` line** ever appears on an S5 entry (L:1364, L:389).
- **No revenue line** ever appears (L:934), and **no `tax_payable` line** (A-14).
- **Entry dates:**
  - the return entry is dated at the bound `document_date`;
  - the reversal entry is dated at the bound `reversal_date`, which `accounting_post_reversal` checks against the original entry date and today.
- **Registrations (0065, after every guard):**

```sql
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('supplier_return', 'none', 'not_after_today',
   'A supplier return: AP first, excess to supplier receivable, inventory at current average, PPV (P3-AL-29/30).', 8);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'supplier_return', 'Supplier return; derived by the supplier return command.');
INSERT INTO stock_source_types (source_type, registered_by) VALUES
  ('purchase_reversal', 'P3-S5'), ('supplier_return', 'P3-S5');
```

- **`purchase_reversal` in `accounting_source_types`.** Under R-B2a (recommended), it is **not** registered there, because its entry is a `reversal`. Under R-B2b it is registered as `('purchase_reversal','not_before_origin','not_after_today',…,9)` with `('post','purchase_reversal')`. §9.1 B-2 decides.

### A-06 · The posting route (ENG; the reversal half is **B-2**)

**Return.** One entry, through `AccountingPostingTransactionPort.postEntryInTransaction` on seam 2's handle, which reaches `accounting_post_entry`.
- The assertion is minted by `mintDomainPostingAssertion` (`packages/accounting/src/domain-posting.ts:52`).
- `DOMAIN_SOURCE_TYPES` (`packages/accounting/src/post.ts:200`) gains `'supplier_return'`, additively.

**Reversal (R-B2a).** One entry, through `AccountingSourcesTransactionPort.postReversalInTransaction` (`apps/api/src/modules/accounting/accounting-sources.adapter.ts:89-102`), which calls `accounting_post_reversal($1,$2,$3,$4)` on seam 2's handle.
- Its assertion (`operationKind 'reverse'`, `sourceType 'reversal'`, `sourceId` = the original entry id, fingerprint `computeReversalFingerprint(original, entryDate, mirrorReversalLines(original))`, `packages/accounting/src/sources.ts:143,201`) is minted by a new **`mintDomainReversalAssertion(minter, original, entryDate, actorUserId)`** in `packages/accounting/src/domain-posting.ts`. It:
  - refuses unless `original.sourceType ∈ DOMAIN_REVERSIBLE_SOURCE_TYPES = ['purchase']` (`accounting.assertion_wrong_source`);
  - refuses `entryDate < original.entryDate` (`accounting.entry_date_before_original`);
  - does **not** run `validateBranchScope`, because domain authority is the warehouse scope bound in the inventory assertion (the `mintDomainPostingAssertion` rule, `domain-posting.ts:26-29`).
- **No new journal writer.**
  - no direct `journal_*` DML;
  - no second signer (TD-10);
  - the R-B1 seam (`apps/api/src/infra/database.ts`, `AccountingAssertionSequence`) is used with a **one-element** tuple by both commands.

**Order inside the transaction** (both commands):
1. the routine;
2. the one entry;
3. COMMIT, with the deferred guards (§2.8).

### A-07 · Bound, pre-computed amounts; optimistic commands (ENG, S4C A-07 carried forward)

The accounting assertion is minted **before** seam 2 opens. Each command therefore binds into its `invpl/1` payload every amount the database will store, and the routine recomputes each from locked state.

| Bound value | Computed by the service from | Recomputed by the routine from | Refusal on difference |
|---|---|---|---|
| return: each line's `carrying_txn`; header `carrying_txn`, `ap_txn`, `ap_base`, `credit_txn`, `credit_base`, `credit_note_id` NULL-ness | the received purchase and its lines (RLS read), prior returns, `purchase_ap_outstanding` (A-16) | the same, under the purchase row lock | `inventory.valuation_changed` (409, same body) |
| return: each line's `value_out`; header `inventory_value`, `ppv` | `stock_levels` of the return warehouse (the S3 `daftar_app` read), `@daftar/inventory` `valuation.ts` outbound rule | the stored movement values the primitive returns | `inventory.valuation_changed` (409) |
| reversal: `original_entry_id` | the purchase's binding (`purchasing-reads.ts`, S4 A-20 join) | `accounting_purchase_entry_id` (A-15(c)) | `purchase_reversal.purchase_changed` (409) |
| reversal: each line's `(line_id, variant_id, qty_q4, value)`, `total_value` | the stored purchase lines and their `purchase` movements | the same rows, under the purchase row lock | `purchase_reversal.purchase_changed` (409) |

- **No server retry** (S3 TL-5).
- A return can race only a concurrent movement on its key (the average moves). The loser gets a clean 409 with nothing committed.
- A reversal's values are fixed at receipt and cannot race. Only its preconditions can change, and each refuses with its own code (A-09).

### A-08 · Seam choice (ENG)

| Command | Seam | Accounting assertions (R-B1 tuple) |
|---|---|---|
| `purchase.return` | 2 | exactly one: `post` / `supplier_return` / return id |
| `purchase.reverse` | 2 | exactly one: `reverse` / `reversal` / original entry id (R-B2a) |

- The seam is fixed per kind, never chosen from a request field (L:984-985).
- **Replay.** A replay inside the routine commits no entry. Its assertion expires unused, and the R-B1 sequence does not refuse `seam.accounting_assertion_unused` on a replayed routine result (the S4 T-11 rule).

### A-09 · Purchase reversal: preconditions, order and codes (ENG; (e) and (f) are ENG+TL, TL-7 and TL-8)

L:751-760: "allowed only when all four preconditions hold, each checked under lock … refuses with a stable code naming which precondition failed, and never partially unwinds."

The routine checks, **in this order**, after the purchase row `FOR UPDATE` (lock step 2a). Each failure is a distinct code, and the first failure refuses the whole command before any write.

| # | Precondition (L:752-756) | Check | Code |
|---|---|---|---|
| (a) | no supplier-payment allocation | `(purchase_settlement_state(business, purchase)).payment_allocated` (A-16) | `purchase_reversal.payment_allocated` |
| (b) | no supplier-credit allocation | `(purchase_settlement_state(business, purchase)).credit_allocated` | `purchase_reversal.credit_allocated` |
| (c) | no supplier return references any of its lines | `EXISTS (SELECT 1 FROM supplier_return_lines WHERE business_id = … AND purchase_id = …)` | `purchase_reversal.returned` |
| (d) | reversing would not drive any affected key negative | after lock step 6, for every line: `stock_levels.on_hand ≥ qty` (a missing key counts as 0) | `purchase_reversal.insufficient_stock` |
| (e) | *(ENG+TL, TL-7)* the receipt covered no deficit | `NOT EXISTS negative_inventory_cost_adjustments WHERE origin_source_type = 'purchase' AND origin_source_id = …` | `purchase_reversal.deficit_coverage_present` |
| (f) | *(ENG+TL, TL-8)* removing the receipt's value leaves a lawful key | for every line: `on_hand − qty = 0 ⇒ valuation − s_i = 0`, and `on_hand − qty > 0 ⇒ valuation − s_i ≥ 0` | `purchase_reversal.valuation_residue` |

- **Order.** (a)–(c) and (e) run under the purchase row lock. (d) and (f) run under the stock-key locks, after step 6.
- **S6 obligation (TL-9).** S6's allocation writers must take the purchase row `FOR SHARE`, or stronger, before inserting an allocation against it. That makes (a) and (b) race-free.
- **Also refused, under the same lock:**

| Condition | Code |
|---|---|
| the purchase is not found (RLS-invisible counts as not found) | `purchase.not_found` |
| `status ≠ 'received'` (draft or cancelled) | `purchase.state_invalid` |
| already reversed, with a different intent | `purchase_reversal.already_reversed` |
| already reversed, with an equal intent | **replay**: the stored rows are returned |
| a bound warehouse, line set, value or entry id ≠ the stored one | `purchase_reversal.purchase_changed` |
| `reversal_date < document_date` | `purchase_reversal.date_before_purchase` |
| `reversal_date` after today in the business timezone | `purchase_reversal.date_in_future` |
| an empty reason | `purchase_reversal.reason_required`, because `accounting_post_reversal` needs one (`0046:173`) |

- **Never partially unwinds.** Every check precedes the first write, and every write is in one transaction with the entry. T-13 injects a failure after each write.

**Inverse movements (L:757, the primitive rule is B-1).**
- There is one `purchase_reversal` movement per purchase line: `qty = −qty_i`, `value = −s_i`, where `s_i` is the stored value of that line's `purchase` movement, and `unit_cost` = that movement's snapshot.
- Σ values = `−Σ s_i = −B`. The reversal removes exactly what the receipt added (P:233, Must-prove 6).
- The accounting reversal mirrors the purchase entry: `Dr AP B / Cr Inventory B`. So GL Inventory moves by exactly −B, which equals the stock-side total (PM-16).

### A-10 · Supplier-return arithmetic (ENG; the dust line and purchase-level AP are ENG+TL, TL-3 and TL-10)

All txn amounts are in the purchase currency and all base amounts in base minor units. HALF_EVEN is `inventory_half_even(num, den, 0)`.

Let the purchase have `T` (`total_txn_minor`), `B` (`total_base_minor`) and rate `R` (`source_to_base_rate`). Let line `i` have `qty_i`, `t_i = net_txn_minor + landed_cost_txn_minor` and `s_i = base_share_minor`. Let `Q_i` be the quantity returned from line `i` by earlier returns.

**(a) Carrying value per line: cumulative, never a proportional-plus-flush.**
```
carrying_txn_i = HALF_EVEN(t_i × (Q_i + q_i), qty_i) − HALF_EVEN(t_i × Q_i, qty_i)
```
- It is never negative, because the cumulative term is monotone in the returned quantity.
- It is exact at a full return: `Σ over all returns = t_i` when `Q_i + q_i = qty_i`.
- The naive `HALF_EVEN(t_i × q_i / qty_i)` plus a last-return flush can go negative after earlier upward roundings. This form cannot.
- Landed cost is part of the carrying value (TL-11).

**(b) Header carrying.** `C = Σ_i carrying_txn_i`.

**(c) AP first, at purchase level (TL-10).**
- `O = purchase_ap_outstanding(business, purchase)`. In S5 this is `T − Σ ap_txn` of the purchase's earlier returns (A-16).
- `ap_txn = min(C, O)`.
- `credit_txn = C − ap_txn`.

**(d) Base.**
- `X_prev = T − O` and `X_new = X_prev + ap_txn`, the AP released so far in txn.
- `ap_base = HALF_EVEN(B × X_new, T) − HALF_EVEN(B × X_prev, T)`. This is the DM §7ج cumulative proportional release. It is exact at clearing: `X_new = T ⇒` the whole remaining `B` is released.
- `convert(x) = HALF_EVEN(x × R × 10^max(0, e_b − e_t), 10^max(0, e_t − e_b))`, the 0043 law, as S4C A-13(6).
- `ap_dust = ap_base − convert(ap_txn)`. It is **0 for a domestic purchase**, where `R = 1` and `B = T`.
- `credit_base = convert(credit_txn)`.

**(e) Inventory.** `I = −Σ` of the stored `supplier_return` movement values. The primitive values each movement at the current average of the return warehouse, or flushes exactly at depletion (`0060:376-393`, L:907).

**(f) PPV.** `ppv = ap_base + credit_base − I`. Positive ⇒ `Cr purchase_price_variance`; negative ⇒ `Dr`; 0 ⇒ no line (L:915-921).

**(g) The entry `supplier_return`,** with lines in this order and each present only when its amount ≠ 0:

| # | Account | Side | Txn currency / amount | Rate | Base |
|---|---|---|---|---|---|
| 1 | `accounts_payable` | Dr | purchase currency / `ap_txn` | `R` (the purchase snapshot, its `rate_source`, `rate_timestamp`) | `convert(ap_txn)` |
| 2 | `accounts_payable` (dust) | Dr if `ap_dust > 0`, Cr if `< 0` | base / `abs(ap_dust)` | 1 (`base`) | `abs(ap_dust)` |
| 3 | `supplier_receivable` | Dr | purchase currency / `credit_txn` | `R` | `credit_base` |
| 4 | `inventory` | Cr | base / `I` | 1 | `I` |
| 5 | `purchase_price_variance` | Cr if `ppv > 0`, Dr if `< 0` | base / `abs(ppv)` | 1 | `abs(ppv)` |

- **Balance holds by construction:** Dr − Cr = `convert(ap_txn) + ap_dust + credit_base − I − ppv = 0`.
- **Each line satisfies 0043** (`0043:208-243`): lines 1 and 3 by `convert`, the rest at rate 1.
- **Refusals:**
  - `C = 0 AND I = 0` ⇒ `supplier_return.value_zero` (TL-12). An entry needs a positive debit.
  - `ap_txn > 0 AND convert(ap_txn) = 0`, or `credit_txn > 0 AND credit_base = 0` ⇒ `supplier_return.amount_below_base_unit` (TL-3). A journal line needs `base_amount_minor > 0` (`0042`).
- **In S5 production, `credit_txn` is always 0.** Σ over returns of `C ≤ Σ_i t_i = T`, and no S5 command reduces AP otherwise. So `ap_txn = C` for every S5 return. The 1150 path is exercised through the A-16 extension point with a test fixture (§5, T-07), exactly as S4 exercised deficit coverage (L:470).

**(h) Precision.** No `round(`. Every division is `inventory_half_even`. The per-line unit snapshot is the primitive's. `carrying_txn_i` is an integer by construction, and `q_i` passes `inventory_quantity_is_representable` in the primitive.

### A-11 · Supplier credit notes (ENG; (e) is ENG+TL, TL-13)

- **(a) When.** Exactly one per return with `credit_txn > 0`, written by `purchase_return` in the same statement group as the return.
- **(b) Identity.**
  - `id` is minted by the **service**, like S4's `coverage_adjustment_id`, and is bound in the payload. It is not part of the intent (A-17).
  - `UNIQUE (business_id, supplier_return_id)`.
- **(c) Values (DM §7ج, L:938-945):**
  - `original_amount_minor = remaining_amount_minor = credit_txn`;
  - `original_carrying_base_amount_minor = remaining_carrying_base_amount_minor = credit_base`;
  - `currency_code`, `source_to_base_rate`, `rate_source` and `rate_timestamp` copied from the purchase snapshot;
  - `issued_on = document_date`.
- **(d) CHECKs:**
  - `0 ≤ remaining ≤ original` for both pairs;
  - `original_amount_minor > 0`, `original_carrying_base_amount_minor > 0`;
  - `(remaining_amount_minor = 0) = (remaining_carrying_base_amount_minor = 0)` (INV-ACC-17: both reach 0 together).
- **(e) Immutability in S5.**
  - `supplier_credit_notes_guard()` refuses every `UPDATE` and `DELETE`, including by the owner (`supplier_credit_note.immutable`).
  - No role holds `UPDATE`.
  - S6 replaces the guard, as its owner, to admit exactly the AL-31 decrement: both remaining values, one row lock, cumulative proportional release. It adds the internal column grant. That is S6's contract (TL-13).
- **(f) Not created:**
  - DM §12's `number`, which is an S7 display concern;
  - DM §12's `status`, which is derived from `remaining_amount_minor = 0`. A stored status would be a second truth (L:1260).

### A-12 · Return quantity and stock bounds (ENG)

- **Must-prove 1 (PM-13).** `Q_i + q_i ≤ qty_i` for every line, checked under the purchase row `FOR UPDATE`. Every return of one purchase serializes on that row. Otherwise `supplier_return.quantity_exceeds_purchased`.
  - A deferred guard, `supplier_return_quantity_bound()` on `supplier_return_lines`, re-checks it at COMMIT.
  - PM-13 says "under the purchase line's lock". The header row is the coarser, equivalent lock, since every line change goes through it.
- **Must-prove 2 (PM-14, L:463).** `q_i ≤ on_hand` of the return key under the key lock ⇒ `inventory.insufficient_stock`. That is the lock's own code, raised by the routine after lock step 6 and again by the primitive (`0060:382-384`).
- **One line per purchase line per return:** `UNIQUE (business_id, return_id, purchase_line_id)`. The variant is the purchase line's (composite FK, §2.2).

### A-13 · The warehouse the goods leave (ENG; scope is ENG+TL, TL-5)

- The return names `warehouse_id`, which may differ from the purchase's warehouse (L:911).
- The stock leaves that key, at that key's average.
- Scope is checked over **that** warehouse only (Must-prove 3).
- The purchase's warehouse is not a scope target. It is touched only through the AP dimension, which is accounting data derived from the purchase.
- A branch-scoped actor without scope over the return warehouse gets 403 `inventory.warehouse_out_of_scope` (`inventory-authorization.ts:192`) before anything is minted.

### A-14 · The tax boundary — OD-03 (ENG, **BLOCKED BY OD-03 beyond the zero case**)

- Every S5 document descends from a purchase with `tax_minor = 0` (`purchases_tax_policy_absent_ck`). So:
  - no return, credit note or reversal carries tax;
  - no S5 table has a tax column;
  - no S5 DTO accepts one.
- **Designed nowhere, each BLOCKED BY OD-03:**
  - a tax reversal on a return;
  - a tax component in a credit note;
  - recoverable input-tax reversal;
  - a `tax_payable` line on any S5 entry.
- The gate refuses a `tax_payable` token or any tax column in 0065/0066 (§7.1).
- OD-03 is the lock's own bounded scoping (SM:70). It is not an S5 blocker (§9.1).

### A-15 · Accounting-side objects in 0065 (ENG)

Every function below is owned by `daftar_accounting_internal`, definer, pinned and PUBLIC-revoked, inside the accounting CREATE bracket.

**(a) `accounting_supplier_return_entry_complete()`** with `journal_entries_supplier_return_complete`.
- The trigger is `AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type = 'supplier_return')`. The `WHEN` keeps Budget A (S3C A-26).
- At COMMIT it requires:
  - exactly one `supplier_returns` row with `binding_source_id = NEW.source_id` and `document_date = NEW.entry_date`;
  - exactly the A-10(g) lines for that row's stored amounts: count, `system_key`, side, txn currency and amount, rate, base amount and dimensions;
  - no other line.
- Otherwise it raises `accounting.inventory_detail_missing` / `accounting.inventory_entry_mismatch` (the S4 codes).

**(b) `accounting_reversals_20_domain_source_guard()`, replaced by its owner** under `SET LOCAL ROLE daftar_accounting_internal`. It is byte-identical to 0063's except for the domain test, which becomes:

```sql
IF EXISTS (SELECT 1 FROM journal_entries je
            WHERE je.business_id = NEW.business_id AND je.id = NEW.original_entry_id
              AND (je.source_type IN ('inventory_adjustment', 'inventory_opening', 'negative_inventory_cost_adjustment', 'supplier_return')
                   OR (je.source_type = 'purchase'
                       AND NOT EXISTS (SELECT 1 FROM purchase_reversals r
                                        WHERE r.business_id = NEW.business_id AND r.id = je.source_id
                                          AND r.original_entry_id = NEW.original_entry_id)))) THEN
  RAISE EXCEPTION 'accounting.reversal_source_domain_owned: …' USING ERRCODE = 'P0001';
END IF;
```

- The R-13 opening-balance block (`0063:1278-1290`) is kept verbatim.
- **Effect:**
  - a generic reversal of any domain entry is still refused. That includes a purchase entry without its `purchase_reversals` row, i.e. without its inverse movements (PM-16);
  - `supplier_return` is added to the always-refused set;
  - a purchase entry is admitted only when `purchase_reverse` has already written the paired row **in the same transaction**. The trigger is `BEFORE INSERT` (tgtype 7, `0063:1769`), and the routine runs before the post (A-06).
- The deferred binding FK of `purchase_reversals` (§2.2) closes the pairing in the other direction: the row cannot commit without the reversal binding.
- **Why this does not decide by `current_user`.** The guard admits by **data**, the paired row, not by role, so it stays definer. The rule of §0 does not apply.

**(c) `accounting_purchase_entry_id(p_business_id UUID, p_purchase_id UUID) RETURNS UUID`.**
- `STABLE`. It returns `journal_entries.id` for `(business, 'purchase', purchase)`, or NULL.
- `EXECUTE` goes to `daftar_inventory_internal` only, on the pattern of `accounting_purchase_fx_rate` (0063).
- The inventory principal holds no `SELECT` on `journal_entries`, and gains none.

**(d) Accounting reads of the S5 documents.**
- `GRANT SELECT ON supplier_returns, purchase_reversals TO daftar_accounting_internal`.
- Plus `accounting_validator` policies `FOR SELECT TO daftar_accounting_internal USING (true)`, on the S4 A-14(d) pattern.
- No other accounting grant is added.

### A-16 · Extension points for S6 — the two INVOKER read functions (ENG; TL-9)

Both functions:
- are migrator-owned, `SECURITY INVOKER`, `STABLE` and pinned;
- have PUBLIC revoked;
- grant `EXECUTE` to `daftar_app` **and** `daftar_inventory_internal`;
- read only through the caller's RLS.

That lets the service (binding, A-07) and the routine (re-check under lock) use **one** definition. The service therefore never computes AP in TypeScript.

| Function | S5 body | S6 replaces it to |
|---|---|---|
| `purchase_ap_outstanding(p_business_id UUID, p_purchase_id UUID) RETURNS BIGINT` | `T − Σ supplier_returns.ap_txn_minor` of the purchase (0 if not received; the purchase must be visible) | also subtract supplier-payment and supplier-credit allocations against the purchase |
| `purchase_settlement_state(p_business_id UUID, p_purchase_id UUID, OUT payment_allocated BOOLEAN, OUT credit_allocated BOOLEAN)` | `false, false`: no allocation table exists in S5 | `EXISTS` over its allocation tables |

- **The S5 proofs of the paths that depend on them:**
  - A-09(a)/(b) (Must-prove 5);
  - A-10's 1150 branch (Must-prove 4).

  Both use an **owner-installed replacement inside the test database** (§5). S6 re-proves them against real allocations (TL-9).
- **Why INVOKER, and why this is not a bypass.** Neither function writes, neither decides by role, and each returns only what the caller could `SELECT` itself.

### A-17 · `invpl/1` field lists and idempotency (ENG; the encoding is S4C A-09)

The encoding is exactly S4C A-09:
- `uuid`, `boolean`, `integer`, `code`, with NULL = `0x00`;
- Q4 quantities, `YYYYMMDD` dates, integer minor amounts (signed allowed);
- text as eight `inventory_reason_words` words, eight NULLs for NULL text;
- framing by `…_count`.

Lines are in `line_no` order.

| `op_code` | Fields, in order |
|---|---|
| `purchase.return` | `return_id` uuid · `purchase_id` uuid · `warehouse_id` uuid · `document_date` int · `reason_w1..w8` · `credit_note_id` uuid or NULL (NULL iff `credit_txn = 0`) · `carrying_txn` int · `ap_txn` int · `ap_base` int · `credit_txn` int · `credit_base` int · `inventory_value` int · `ppv` int (signed) · `line_count` int · per line: `return_line_id` uuid, `purchase_line_id` uuid, `variant_id` uuid, `qty_q4` int (> 0), `carrying_txn` int, `value_out` int (≥ 0) |
| `purchase.reverse` | `purchase_id` uuid · `warehouse_id` uuid · `reversal_date` int · `reason_w1..w8` · `original_entry_id` uuid · `total_value` int · `line_count` int · per line: `line_id` uuid, `variant_id` uuid, `qty_q4` int, `value` int (≥ 0, = `s_i`) |

- **What this binds** (L:1962-1964):
  - the one warehouse whose scope was checked;
  - every line's variant and quantity;
  - every stored amount;
  - the date and the reason.
- **Intent digests** (`inventory_payload_digest`, over the **client-intent** fields only):

| Command | Intent fields | Stored in |
|---|---|---|
| `purchase.return` | `return_id`, `purchase_id`, `warehouse_id`, `document_date`, `reason_w1..w8`, `line_count`, per line `return_line_id`, `purchase_line_id`, `qty_q4` | `supplier_returns.intent_sha256` |
| `purchase.reverse` | `purchase_id`, `warehouse_id`, `reversal_date`, `reason_w1..w8` | `purchase_reversals.intent_sha256` |

- **Identity.**
  - `return_id` and `return_line_id` are client-supplied canonical UUIDs. The return id is the stock `source_id` of its movements and the accounting `source_id` of its entry.
  - The reversal's identity **is** the purchase id (`purchase_reversals.id = purchase_id`, CHECK), so a second reversal is impossible without a check (the AL-12 precedent). Its lines' ids **are** the purchase line ids (`purchase_reversal_lines.id = purchase_line_id`, CHECK).
- **Application order** (S4C A-10(c)).
  - The service first reads the document through `daftar_app` under RLS:
    - the return row by `return_id` (replay ⇒ stored result; a different intent ⇒ `supplier_return.idempotency_conflict`);
    - or the reversal row by `purchase_id` (replay / `purchase_reversal.already_reversed`).
  - Only then does it check scope and read state (A-07), mint, and open the seam.
- **A replay answers from stored rows only:**
  - the header and lines;
  - the credit note;
  - the movements through the bridges;
  - the entry id through `accounting_source_bindings`, or through `accounting_reversals` for a reversal.

### A-18 · Grant and ACL matrix produced by S5 (ENG)

| Principal | Gains |
|---|---|
| `daftar_app` | `SELECT` on `supplier_returns`, `supplier_return_lines`, `supplier_credit_notes`, `purchase_reversals`, `purchase_reversal_lines`; `EXECUTE` on `purchase_return(…)`, `purchase_reverse(…)`, `purchase_ap_outstanding(uuid,uuid)`, `purchase_settlement_state(uuid,uuid)`. **No DML anywhere.** |
| `daftar_inventory_internal` | `INSERT, SELECT` on the five tables and the two bridges; `SELECT` on `accounts`, as S4 already holds it for the entry checks, only if S4 did not grant it; `EXECUTE` on `accounting_purchase_entry_id(uuid,uuid)` and the two read functions. **No `UPDATE`, no `DELETE`.** |
| `daftar_accounting_internal` | `SELECT` on `supplier_returns`, `purchase_reversals` (A-15(d)) |
| any other role | nothing |

### A-19 · Routes, DTOs and reads (ENG)

| Route | Permission + scope | Body / result |
|---|---|---|
| `POST /purchases/:purchaseId/returns` | `purchases.return` + the body's `warehouseId` | `{ returnId, warehouseId, documentDate, reason?, lines: [{ lineId, purchaseLineId, quantity }] }` (1..200 lines) → the stored return, lines, credit note, entry id, `replayed` |
| `POST /purchases/:purchaseId/reversal` | `purchases.receive` + the purchase warehouse | `{ reversalDate, reason }` → the stored reversal, lines, reversal entry id, `replayed` |
| `GET /purchases/:purchaseId/returns` · `GET /supplier-returns/:returnId` | `purchases.view` + the return (or purchase) warehouse | stored rows |
| `GET /suppliers/:supplierId/credit-notes` | `suppliers.view` + **business-wide scope** (S4 TL-4 precedent) | stored rows, remaining values as stored |

- **Reads (extend S4 A-20).** The ledger-derived AP of a purchase adds:
  - the AP lines of the purchase's `supplier_return` entries, joined through `supplier_returns.purchase_id`;
  - the AP lines of the `reversal` entry whose `accounting_reversals.original_entry_id` is the purchase entry.
- **The txn-currency outstanding** reads only AP lines in the purchase currency. That excludes the base-currency dust lines, which move base only (A-10(g)).
- **`purchasing-reads.ts` asserts, per purchase:** ledger AP = `purchase_ap_outstanding`, and ledger base AP = `B − Σ ap_base` (T-12).
- **No stored AP, credit or supplier balance** (L:1260-1262; the extended G-3, §7.2).

### A-20 · Audit and outbox (ENG, S4C A-21 pattern)

Each command writes one audit row and one outbox event in its transaction, named for the command:
- `purchase.returned`, carrying the return id, the purchase id, the warehouse and the credit note id;
- `purchase.reversed`, carrying the purchase id and the reversal entry id.

Amounts stay out of messages and are present in the payload only as stored ids, the S4 rule.

---

## 2. Database contract

### 2.1 Migration 0065 order (normative)

1. **Header rules.**
   - R-34 (lock order, §2.2);
   - R-35 (carrying and AP arithmetic, A-10);
   - R-36 (derived reversed state, A-04);
   - R-37 (the reversal value rule, B-1);
   - R-38 (the reversal guard, A-15(b)).
2. **Two candidate keys on S4 tables.** They validate against existing rows, and add no guard and no column:
   - `ALTER TABLE purchases ADD CONSTRAINT purchases_supplier_uq UNIQUE (business_id, id, supplier_id)`;
   - `ALTER TABLE purchase_lines ADD CONSTRAINT purchase_lines_variant_uq UNIQUE (business_id, purchase_id, id, variant_id)`.
3. **The five tables** (§2.2), with RLS and grants.
4. **The two bridges.**
5. **The guard functions and triggers** (§2.3), inside the inventory CREATE bracket, plus the migrator-owned `stock_ledger_append_only()` triggers.
6. **R-B1a only:** `inventory_apply_stock_movements` replaced by its owner (§2.4).
7. **The replaced `inventory_stock_source_guard_gaps()`** (§2.3), **before** the registrations.
8. **`INSERT INTO stock_source_types`**, the two rows (A-05).
9. **The accounting objects** (A-15), inside the accounting CREATE bracket, then the accounting registration (A-05).
10. **0065-E** (§2.8).

### 2.2 Tables

All tables:
- start with `tenant_id, business_id`;
- have the composite tenant FK;
- have `PRIMARY KEY (business_id, id)` unless stated;
- have `ENABLE` + `FORCE` RLS with the §0 layering;
- have `REVOKE ALL … FROM PUBLIC`.

Every column is `NOT NULL` unless marked `?`.

| Table | Columns beyond the common ones | Keys / checks |
|---|---|---|
| `supplier_returns` | `id`, `purchase_id`, `supplier_id`, `warehouse_id` (the return warehouse), `currency_code CHAR(3)`, `source_to_base_rate NUMERIC(20,10)`, `document_date DATE`, `reason?` (1..500, trimmed), `credit_note_id?`, `carrying_txn_minor` (≥ 0), `ap_txn_minor` (≥ 0), `ap_base_minor` (≥ 0), `ap_dust_base_minor` (signed), `credit_txn_minor` (≥ 0), `credit_base_minor` (≥ 0), `inventory_value_base_minor` (≥ 0), `ppv_base_minor` (signed), `intent_sha256` (`~ '^[0-9a-f]{64}$'`), `business_transaction_id`, `created_by`, `created_at`, `accounting_source_type GENERATED ALWAYS AS ('supplier_return') STORED`, `binding_source_id` | FK `(business_id, purchase_id, supplier_id) → purchases (business_id, id, supplier_id)` RESTRICT; FK `(business_id, warehouse_id) → warehouses`; FK `currency_code → currencies`; `UNIQUE (business_id, id, purchase_id)`; `UNIQUE (business_id, id, credit_note_id)`; `carrying = ap_txn + credit_txn`; `(credit_txn = 0) = (credit_base = 0)`; `(credit_txn = 0) = (credit_note_id IS NULL)`; `ppv = ap_base + credit_base − inventory_value`; `NOT (carrying = 0 AND inventory_value = 0)`; `source_to_base_rate > 0 AND source_to_base_rate = trunc(source_to_base_rate, 10)`; `binding_source_id = id`; deferred FK `(business_id, accounting_source_type, binding_source_id) → accounting_source_bindings (business_id, source_type, source_id)`; deferred FK `(business_id, credit_note_id) → supplier_credit_notes (business_id, id)` |
| `supplier_return_lines` | `return_id`, `id`, `line_no` (> 0), `purchase_id`, `purchase_line_id`, `variant_id`, `qty NUMERIC(18,4)` (> 0), `carrying_txn_minor` (≥ 0), `unit_cost_base_minor NUMERIC(28,10)` (≥ 0, the average snapshot of its movement), `value_out_base_minor` (≥ 0) | FK `(business_id, return_id, purchase_id) → supplier_returns (business_id, id, purchase_id)` RESTRICT; FK `(business_id, purchase_id, purchase_line_id, variant_id) → purchase_lines (business_id, purchase_id, id, variant_id)` RESTRICT; `UNIQUE (business_id, return_id, id)`; `UNIQUE (business_id, return_id, line_no)`; `UNIQUE (business_id, return_id, purchase_line_id)` |
| `supplier_credit_notes` | `id`, `supplier_id`, `supplier_return_id`, `currency_code CHAR(3)`, `original_amount_minor` (> 0), `remaining_amount_minor`, `original_carrying_base_amount_minor` (> 0), `remaining_carrying_base_amount_minor`, `source_to_base_rate NUMERIC(20,10)`, `rate_source` (`base`/`manual`), `rate_timestamp`, `issued_on DATE`, `business_transaction_id`, `created_by`, `created_at` | FK `(business_id, supplier_return_id, id) → supplier_returns (business_id, id, credit_note_id)` RESTRICT; FK `(business_id, supplier_id) → suppliers` RESTRICT; `UNIQUE (business_id, supplier_return_id)`; `0 ≤ remaining_amount_minor ≤ original_amount_minor`; `0 ≤ remaining_carrying_base_amount_minor ≤ original_carrying_base_amount_minor`; `(remaining_amount_minor = 0) = (remaining_carrying_base_amount_minor = 0)`; `rate_timestamp = date_trunc('second', rate_timestamp)` |
| `purchase_reversals` | `id`, `purchase_id`, `warehouse_id`, `original_entry_id`, `reversal_date DATE`, `reason` (1..500, trimmed), `total_value_base_minor` (> 0), `intent_sha256`, `business_transaction_id`, `created_by`, `created_at`, `accounting_source_type GENERATED ALWAYS AS ('reversal') STORED`, `binding_source_id` | `purchase_reversals_identity_ck CHECK (id = purchase_id)`; FK `(business_id, purchase_id, warehouse_id) → purchases (business_id, id, warehouse_id)` RESTRICT; `UNIQUE (business_id, original_entry_id)`; `binding_source_id = original_entry_id`; deferred FK `(business_id, accounting_source_type, binding_source_id) → accounting_source_bindings (business_id, source_type, source_id)` |
| `purchase_reversal_lines` | `reversal_id`, `id`, `purchase_id`, `variant_id`, `qty NUMERIC(18,4)` (> 0), `unit_cost_base_minor NUMERIC(28,10)` (≥ 0), `value_base_minor` (≥ 0) | `purchase_reversal_lines_identity_ck CHECK (reversal_id = purchase_id)`; FK `(business_id, reversal_id) → purchase_reversals` RESTRICT; FK `(business_id, purchase_id, id, variant_id) → purchase_lines (business_id, purchase_id, id, variant_id)` RESTRICT, so a reversal line **is** its purchase line; `UNIQUE (business_id, reversal_id, id)` |

**Bridges** (the S4C A-15(a) shape, exactly):
- `stock_source_bridge_supplier_return` and `stock_source_bridge_purchase_reversal`;
- `PRIMARY KEY (business_id, source_id, source_line_id, movement_kind)`;
- `source_type GENERATED ALWAYS AS ('<type>') STORED`;
- a validated RESTRICT FK of the five identity columns to `stock_source_bindings`;
- a validated RESTRICT line FK `(business_id, source_id, source_line_id)` to `supplier_return_lines (business_id, return_id, id)` / `purchase_reversal_lines (business_id, reversal_id, id)`.

**Naming (G-3 as extended by S4).**
- No column is named `balance`, `outstanding`, `paid`, `unpaid`, `due`, `owed` or `payable`, and none uses `on_hand`/`valuation`.
- `remaining_*` is the DM §7ج name and is not forbidden (`scripts/guards/no-authoritative-balance.ts`, the S4 extension).
- `ap_*` is not forbidden.

**R-34, the global lock order extended** (every S5 path; a path skips steps and never reorders them):

```
1  assertion consume                                   (no lock)
2  the per-document advisory key                        ('daftar.supplier_return_id' | 'daftar.purchase_id')
2a the purchase row FOR UPDATE                          (both commands)
2b the supplier row FOR SHARE                           (purchase.return only)
3–5 (not used by S5)
6  stock targets (shared 'daftar.stock_target' advisory), products FOR SHARE (id order),
   stock keys FOR UPDATE ((warehouse, variant) order)
7  accounting_post_entry ('supplier_return')  |  accounting_post_reversal (the purchase entry)
```

- A return takes its own key and then the purchase row. A reversal and a receipt take the purchase key and then the row.
- No path takes a return key after the purchase row. So 2/2a introduce no cycle with S4's R-15.
- Step 7's `accounting_post_reversal` holds `businesses FOR SHARE` before the reversal guard's R-13 row lock (`0063:1278-1280`), unchanged.

### 2.3 Guards and the replaced `inventory_stock_source_guard_gaps()` (ENG)

**Guard functions** (internal definer, pinned, PUBLIC revoked, inside the inventory bracket, unless marked *append-only*):

| type | `missing` | table | trigger | `tgtype` | deferred | function | what it enforces at COMMIT / on write |
|---|---|---|---|---|---|---|---|
| supplier_return | `source_complete` | `supplier_return_lines` | `stock_source_complete_supplier_return` | 5 | yes | `stock_source_complete_supplier_return()` | each line has exactly its `supplier_return` movement: header warehouse, line variant, `qty = −qty`, `value = −value_out`, `unit_cost = unit_cost_base_minor` |
| supplier_return | `header_complete` | `supplier_returns` | `supplier_returns_complete` | 5 | yes | `stock_source_complete_supplier_return_header()` | ≥ 1 line; the credit note exists iff `credit_txn > 0`, with the A-11(c) values; the purchase is `received` and **not reversed**; `supplier_id` is the purchase's |
| supplier_return | `source_freeze` | `supplier_return_lines` | `stock_source_freeze_supplier_return` | 27 | no | `stock_ledger_append_only()` *append-only* | no UPDATE/DELETE |
| supplier_return | `header_immutable` | `supplier_returns` | `supplier_returns_immutable` | 27 | no | `stock_ledger_append_only()` *append-only* | no UPDATE/DELETE |
| supplier_return | `value_complete` | `supplier_returns` | `supplier_returns_value_complete` | 5 | yes | `supplier_return_value_complete()` | `carrying = Σ line carrying`; `inventory_value = Σ line value_out = −Σ movement values`; the A-10 identities for `ap_base`, `ap_dust`, `credit_base`, recomputed from the purchase |
| supplier_return | `quantity_bound` | `supplier_return_lines` | `supplier_return_lines_quantity_bound` | 5 | yes | `supplier_return_quantity_bound()` | for the line's purchase line, Σ returned `qty` over all returns ≤ purchased `qty` (PM-13) |
| purchase_reversal | `source_complete` | `purchase_reversal_lines` | `stock_source_complete_purchase_reversal` | 5 | yes | `stock_source_complete_purchase_reversal()` | each line has exactly its `purchase_reversal` movement, and its value = **−(the paired `purchase` movement's value)**; `qty` and `unit_cost` equal that movement's, negated / copied |
| purchase_reversal | `header_complete` | `purchase_reversals` | `purchase_reversals_complete` | 5 | yes | `stock_source_complete_purchase_reversal_header()` | the line set **equals** the purchase's full line set; no `supplier_return_lines` for the purchase; no NICA header for it (A-09(c)(e)); the purchase is `received` |
| purchase_reversal | `source_freeze` | `purchase_reversal_lines` | `stock_source_freeze_purchase_reversal` | 27 | no | `stock_ledger_append_only()` *append-only* | no UPDATE/DELETE |
| purchase_reversal | `header_immutable` | `purchase_reversals` | `purchase_reversals_immutable` | 27 | no | `stock_ledger_append_only()` *append-only* | no UPDATE/DELETE |
| purchase_reversal | `value_complete` | `purchase_reversals` | `purchase_reversals_value_complete` | 5 | yes | `purchase_reversal_value_complete()` | `total_value = Σ line value = −Σ movement values = Σ_i s_i = purchases.total_base_minor` |

**Also:**
- `stock_binding_requires_supplier_return()` and `stock_binding_requires_purchase_reversal()`: deferred, tgtype 5, `WHEN (NEW.source_type = '<type>')`, internal definer, on `stock_source_bindings`.
- `stock_bridge_immutable_<type>` on each bridge: tgtype 27, on `stock_ledger_append_only()`.
- `supplier_credit_notes_immutable` (27) on `supplier_credit_notes`, calling `supplier_credit_note_guard()` (internal definer, A-11(e)). It is **not** a stock-source guard and is not in the gaps function. Its body is pinned by 0065-E(9) and T-15.

**The replaced gaps function.**
- **What does not change.** It is `CREATE OR REPLACE` by the migrator: `SECURITY INVOKER`, `STABLE`, pinned, same signature.
- **Kept byte-for-byte:**
  - the `v_s3` and `v_s4` branches and their VALUES lists;
  - the line-table map's six rows;
  - **all twenty-four `c_digest` entries** of `0063:1030-1055`: the sixteen S3 entries from `"stock_ledger_append_only()"` to `"inventory_source_value_complete()"`, and the eight S4 entries from `"stock_binding_requires_purchase()"` to `"purchase_source_value_complete()"`, verbatim.
- **The additions:**
  - `v_s5 := v_type IN ('purchase_reversal', 'supplier_return')`;
  - the `NOT (v_s3 OR v_s4)` tests become `NOT (v_s3 OR v_s4 OR v_s5)` in the four places at `0063:1108, 1113, 1128, 1147`;
  - two map rows: `('supplier_return','supplier_return_lines', ARRAY['business_id','return_id','id'])` and `('purchase_reversal','purchase_reversal_lines', ARRAY['business_id','reversal_id','id'])`;
  - an `IF v_s5 THEN` loop with the eleven rows above, with the S4 loop's shape exactly: the `internal` column is `false` for the four `stock_ledger_append_only()` rows;
  - `c_digest` entries for the nine new functions, recorded at migration time:
    - `stock_binding_requires_supplier_return()`, `stock_binding_requires_purchase_reversal()`;
    - `stock_source_complete_supplier_return()`, `stock_source_complete_supplier_return_header()`, `supplier_return_value_complete()`, `supplier_return_quantity_bound()`;
    - `stock_source_complete_purchase_reversal()`, `stock_source_complete_purchase_reversal_header()`, `purchase_reversal_value_complete()`.
- The comment is extended to name S5.
- **Review F3 and the S4 T-16 suite stay green unchanged**, because the S3 and S4 parts are byte-identical.
- **0065-E mutation probes**, each inside a rolled-back block, each of which must make the function report its gap:
  - `ALTER TABLE stock_source_bridge_supplier_return DISABLE TRIGGER stock_bridge_immutable_supplier_return`;
  - `CREATE OR REPLACE` of `stock_source_complete_purchase_reversal()` with a no-op body (the digest);
  - re-creating `supplier_return_lines_quantity_bound` on `supplier_return_value_complete()`;
  - `ALTER TABLE supplier_returns ENABLE REPLICA TRIGGER supplier_returns_value_complete`.

### 2.4 The primitive's owner replacement — R-B1a (ENG, **only if B-1 is decided R-B1a**)

`inventory_apply_stock_movements(inventory_movement_request[])` is replaced inside the inventory CREATE bracket, under `SET LOCAL ROLE daftar_inventory_internal` … `RESET ROLE`. It keeps its signature, owner and ACL (`scripts/guards/inventory-definer-contract.ts:52-57`). It is byte-identical to `0060:133-484` except for **one new branch**, inserted in step 6c **between** the `transfer_in` branch (`0060:356-375`) and the outbound branch (`0060:376`):

```sql
ELSIF v_req.movement_kind = 'purchase_reversal' THEN
  -- The inverse of a receipt carries exactly what the receipt added (P3-AL-20),
  -- the transfer_in precedent: a paired stored value, never recomputed.
  IF v_req.unit_cost_base_minor IS NOT NULL OR v_req.value_delta_base_minor IS NOT NULL THEN
    RAISE EXCEPTION 'inventory.movement_shape_invalid: a purchase_reversal movement takes its cost and value from its purchase movement' USING ERRCODE = 'P0001';
  END IF;
  IF abs(v_qty) > v_level_qty THEN
    RAISE EXCEPTION 'inventory.insufficient_stock: the warehouse does not hold enough of this variant' USING ERRCODE = 'P0001';
  END IF;
  IF v_req.source_type <> 'purchase_reversal' THEN
    RAISE EXCEPTION 'inventory.movement_shape_invalid: a purchase_reversal movement belongs to a purchase reversal' USING ERRCODE = 'P0001';
  END IF;
  SELECT m.warehouse_id AS wh, m.variant_id AS va, m.qty_delta AS qty, m.unit_cost_base_minor AS snap,
         m.value_delta_base_minor AS val
    INTO v_pair
  FROM stock_movements m
  WHERE m.business_id = v_business AND m.source_type = 'purchase'
    AND m.source_id = v_req.source_id AND m.source_line_id = v_req.source_line_id
    AND m.movement_kind = 'purchase';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'inventory.reversal_pair_missing: a purchase_reversal needs the purchase movement of the same line' USING ERRCODE = 'P0001';
  END IF;
  IF v_pair.va <> v_req.variant_id OR v_pair.wh <> v_req.warehouse_id OR v_pair.qty <> -v_qty THEN
    RAISE EXCEPTION 'inventory.reversal_pair_mismatch: a reversal removes the same variant and quantity from the same warehouse' USING ERRCODE = 'P0001';
  END IF;
  v_value    := -v_pair.val;
  v_snapshot := v_pair.snap;
  IF (v_level_qty + v_qty = 0 AND v_level_value + v_value <> 0)
     OR (v_level_qty + v_qty > 0 AND v_level_value + v_value < 0) THEN
    RAISE EXCEPTION 'inventory.reversal_valuation_residue: removing the receipt value would leave an unlawful key valuation' USING ERRCODE = 'P0001';
  END IF;
```

- **The check order is chosen so that S2's T-21.1 stays green:** shape, then insufficiency, then source type, then pair.
- **Consequences:**
  - The comment gains the rule: "purchase_reversal: the exact negation of its paired purchase movement".
  - **L:1376 (AL-49 §C) gains one row by lock amendment (B-1):** "the exact negation of the paired `purchase` movement of the same source line".
  - The PM-44 sweep (`stock-ledger-structure.test.ts:859-900`) still finds the primitive with its assertion first. No new STOCK_DML writer appears.

### 2.5 0066 routines (ENG)

**The two read functions** (A-16). They are migrator-owned INVOKER and created first in 0066.

**Helpers.** These are internal-owned definer with **no grantee**. Each first statement is `v_actor := inventory_assertion_current(ARRAY[…])` (0062 R-5; rule 22).
- **`purchase_lock_stock_keys(p_warehouse UUID, p_variants UUID[])`**, with `ARRAY['purchase.return','purchase.reverse']`. It takes lock step 6:
  - the shared `daftar.stock_target` advisory keys;
  - the S3 A-19 archive re-checks (`inventory.warehouse_archived` / `variant_archived` / `product_not_tracked`);
  - products `FOR SHARE` in id order;
  - existing `stock_levels` `FOR UPDATE` in `(warehouse, variant)` order.
  - It returns nothing. The caller reads the locked rows.
- **`purchase_bridge_return(p_return_id UUID) RETURNS INTEGER`**, with `ARRAY['purchase.return']`, writes the return bridge rows.
- **`purchase_bridge_reversal(p_purchase_id UUID) RETURNS INTEGER`**, with `ARRAY['purchase.reverse']`, writes the reversal bridge rows.

**Entry routines.** Both are internal-owned definer, pinned, PUBLIC revoked, `EXECUTE` to `daftar_app` only. The first statement is `v_actor := inventory_assertion_consume('<op>', inventory_claimed_payload_digest('<op>', types[], values[]))`, built from the routine's own arguments (A-17).

| Routine | Signature |
|---|---|
| `purchase_return` | `(p_return_id UUID, p_purchase_id UUID, p_warehouse_id UUID, p_document_date DATE, p_reason TEXT, p_credit_note_id UUID, p_carrying_txn_minor BIGINT, p_ap_txn_minor BIGINT, p_ap_base_minor BIGINT, p_credit_txn_minor BIGINT, p_credit_base_minor BIGINT, p_inventory_value_base_minor BIGINT, p_ppv_base_minor BIGINT, p_line_ids UUID[], p_purchase_line_ids UUID[], p_variant_ids UUID[], p_qtys NUMERIC[], p_carrying_txns BIGINT[], p_values_out BIGINT[])` |
| `purchase_reverse` | `(p_purchase_id UUID, p_warehouse_id UUID, p_reversal_date DATE, p_reason TEXT, p_original_entry_id UUID, p_total_value_base_minor BIGINT, p_line_ids UUID[], p_variant_ids UUID[], p_qtys NUMERIC[], p_values BIGINT[])` |

Both `RETURNS TABLE (...)`: the stored header, lines with movement ids and stored values, the credit note (return only), and `replayed BOOLEAN`.

**`purchase_return` statement order** (normative):
1. **The consume.**
2. **The isolation check** (`read committed`, `inventory.isolation_unsupported`) and the trace (`inventory_business_transaction_id()`, `inventory.trace_missing`).
3. **The intent digest.** Then `pg_advisory_xact_lock(hashtext('daftar.supplier_return_id'), hashtext(p_return_id::text))`.
4. **`supplier_returns` by `(business, p_return_id)`:**
   - found with an equal intent → **return the stored rows**, `replayed = true`;
   - found with a different intent → `supplier_return.idempotency_conflict`.
5. **Shape**, before any state read:
   - 1..200 lines, equal array lengths, distinct `purchase_line_id`s, `qty > 0` → else `supplier_return.lines_invalid`;
   - a reason, when given, trimmed to 1..500 → else `supplier_return.lines_invalid`.
6. **The purchase `FOR UPDATE`** (2a):
   - not found → `purchase.not_found`;
   - `status ≠ 'received'` → `supplier_return.purchase_state_invalid`;
   - `EXISTS purchase_reversals` → `supplier_return.purchase_reversed`.
7. **The supplier `FOR SHARE`** (2b). `inactive` **and** `p_credit_txn_minor > 0` → `supplier_return.supplier_inactive` (AL-40: no new credit for an inactive supplier; TL-14).
8. **Dates:**
   - `p_document_date < purchases.document_date` → `supplier_return.date_before_purchase`;
   - after today in the business timezone → `supplier_return.document_date_in_future`.
9. **Lines against the purchase:** each `purchase_line_id` must belong to the purchase with the bound `variant_id`, else `supplier_return.lines_invalid`. Then, for each, `Q_i + q_i ≤ qty_i`, else `supplier_return.quantity_exceeds_purchased`.
10. **A-10(a)–(d) recomputed** (`purchase_ap_outstanding` for `O`, the purchase's snapshot rate and currencies).
    - Any bound difference, including `p_credit_note_id IS NULL ≠ (credit_txn = 0)`, → `inventory.valuation_changed`.
    - `amount_below_base_unit` as A-10(g).
11. **`purchase_lock_stock_keys(p_warehouse_id, p_variant_ids)`** (step 6). Then each `q_i ≤ on_hand` (absent key = 0), else `inventory.insufficient_stock`.
12. **The inserts:**
    - `INSERT supplier_returns` (bound values, `binding_source_id = id`, the purchase's currency and rate, trace, intent);
    - `INSERT supplier_return_lines` (bound `carrying_txn` and `value_out`; `unit_cost_base_minor` = the locked key's `avg_unit_cost_base_minor` read in step 11, because lines are insert-only);
    - `INSERT supplier_credit_notes` iff `credit_txn > 0`.
13. **`inventory_apply_stock_movements`**, one request per line: `(warehouse, variant, 'supplier_return', 'supplier_return', p_return_id, line_id, −qty, NULL, NULL, NULL)`.
    - For each result, `−value_delta_base_minor = p_values_out[i]`, and `Σ = p_inventory_value_base_minor`, and `ppv = ap_base + credit_base − I`. Else `inventory.valuation_changed`.
    - Each returned `unit_cost_base_minor` must equal the line's stored snapshot, which holds under the key lock; otherwise `inventory.valuation_changed`. The `source_complete` guard re-checks it at COMMIT.
14. **`purchase_bridge_return(p_return_id)`.**
15. **The audit and outbox** (A-20).
16. **`RETURN QUERY`** of the stored rows.

**`purchase_reverse` statement order** (normative):
1. **The consume.**
2. **The isolation check and the trace.**
3. **The intent digest.** Then `pg_advisory_xact_lock(hashtext('daftar.purchase_id'), hashtext(p_purchase_id::text))`, the S4 key: a reversal and a receipt of one purchase serialize.
4. **The purchase `FOR UPDATE`.** Then:
   - not found → `purchase.not_found`;
   - `purchase_reversals` row found with an equal intent → **stored rows**, `replayed = true`;
   - found with a different intent → `purchase_reversal.already_reversed`;
   - `status ≠ 'received'` → `purchase.state_invalid`.
5. **Shape:**
   - trimmed reason 1..500, else `purchase_reversal.reason_required`;
   - `reversal_date` checks (A-09).
6. **The A-09 preconditions (a), (b), (c), (e)**, in that order.
7. **Bound versus stored**, else `purchase_reversal.purchase_changed`:
   - `p_warehouse_id = purchases.warehouse_id`;
   - `p_original_entry_id = accounting_purchase_entry_id(business, purchase)`;
   - the `(line_id, variant_id, qty, value)` list = the purchase lines with their stored `purchase` movement values, in `line_no` order;
   - `p_total_value_base_minor = purchases.total_base_minor`.
8. **`purchase_lock_stock_keys(warehouse, variants)`** (step 6). Then A-09 (d), then (f), per line in `line_no` order.
9. **The inserts:**
   - `INSERT purchase_reversals` (`id = purchase_id`, `binding_source_id = p_original_entry_id`);
   - `INSERT purchase_reversal_lines` (`id = purchase_line_id`, value and snapshot copied from the stored `purchase` movement).
10. **`inventory_apply_stock_movements`**, one request per line: `(warehouse, variant, 'purchase_reversal', 'purchase_reversal', p_purchase_id, line_id, −qty, NULL, NULL, NULL)`. Each stored value must equal `−p_values[i]` (defence in depth; B-1 guarantees it).
11. **`purchase_bridge_reversal(p_purchase_id)`.**
12. **The audit and outbox.**
13. **`RETURN QUERY`** of the stored rows.

The service then posts via `postReversalInTransaction(original_entry_id, reversal_date, reason, request_id)`. The reversal guard (A-15(b)) admits it because step 9 wrote the paired row.

### 2.6 Registrations in 0066 (last)

```sql
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('purchase.return', 'P3-S5'), ('purchase.reverse', 'P3-S5');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by) VALUES
  ('purchase.return', 'supplier_return', 'P3-S5'), ('purchase.reverse', 'purchase_reversal', 'P3-S5');
```

### 2.7 RLS; and what S5 does not change

**RLS.** Every S5 table and bridge follows the §0 layering:
- tenant membership;
- restrictive business isolation, with no internal admission in the restrictive `WITH CHECK`;
- `FOR SELECT TO daftar_inventory_internal USING (true)`;
- `FOR INSERT TO daftar_inventory_internal` (the S4 pattern);
- plus A-15(d) for the two accounting-read headers.

**S5 does not change:**
- any S3 or S4 routine or guard body;
- `purchases`/`purchase_lines` data, and every S4 CHECK;
- `stock_movement_kinds`;
- the accounting journal, `accounting_post_entry`, `accounting_post_reversal`, the FX registry, the permissions and roles, and `bootstrap.sql`.

S5 creates no role, no membership and no `BYPASSRLS`. The only replaced functions are:
- the gaps function (§2.3);
- the reversal guard (A-15(b));
- the primitive, under R-B1a only (§2.4).

### 2.8 End-state blocks

**0065-E refuses the migration unless:**
1. `stock_source_types` is exactly the S3 four, the S4 two, and `purchase_reversal:P3-S5`, `supplier_return:P3-S5`.
2. `inventory_stock_source_guard_gaps()` returns no row. Each §2.3 mutation probe, inside a rolled-back block, makes it report its gap. The function's `prosrc` contains each of the twenty-four S3/S4 digests verbatim.
3. `accounting_source_types` holds the seven earlier rows unchanged plus `supplier_return` at `sort_order` 8 (R-B2a: and no `purchase_reversal`). Every registered source type has a `post` or `reverse` kind (`0046:111-115`).
4. The two candidate keys, and every S5 FK, are validated. `purchase_reversals_identity_ck` and `purchase_reversal_lines_identity_ck` exist.
5. No runtime role holds DML on any S5 table. `daftar_app` holds `SELECT` exactly on the A-18 set. `daftar_inventory_internal` holds exactly `INSERT, SELECT` on the five tables and two bridges.
6. Every new function is owned per §2.3/A-15, definer and pinned, and no runtime role may execute it. `accounting_purchase_entry_id` is executable by `daftar_inventory_internal` only.
7. The reversal guard's `prosrc` names `'supplier_return'`, `'negative_inventory_cost_adjustment'`, `'inventory_opening'`, `'inventory_adjustment'` and `purchase_reversals`, and still contains `accounting.opening_balance_inventory_bound`.
8. **Under R-B1a:** the primitive's `prosrc` contains `movement_kind = 'purchase_reversal'` and `inventory.reversal_valuation_residue`. It is still owned by `daftar_inventory_internal` with no `EXECUTE` grantee.
9. `supplier_credit_notes_immutable` exists (tgtype 27, enabled, no `WHEN`) on `supplier_credit_note_guard()`, internal definer pinned.
10. Neither internal principal holds `CREATE` on `public`.

**0066-E refuses the migration unless:**
1. `inventory_operation_kinds` is the S1 three, S3 seven, S4 seven and S5 two, exactly.
2. The mappings are the six S3 pairs, the two S4 pairs and the two S5 pairs, exactly.
3. The two entry routines and three helpers are internal definer and pinned. There are exactly five S5 internal routines.
4. `daftar_app` reaches each entry routine, and no other role or PUBLIC does. No role reaches a helper. The two read functions are INVOKER, migrator-owned, executable by exactly `daftar_app` and `daftar_inventory_internal`.
5. Each entry routine's first statement matches `^v_actor := inventory_assertion_consume\(`. Each helper's matches `^v_actor := inventory_assertion_current\(ARRAY\[`.
6. In both routines the document advisory key precedes the intent read (R-26). In `purchase_return`, the `supplier_returns` replay read precedes `FROM purchases`.
7. `stock_source_types` is unchanged since 0065, and the gaps function still returns no row.
8. No `CREATE` is left on `public`.

---

## 3. Error model

**Rule.** Every refusal is a stable `<domain>.<code>`.
- `purchasingRefusal` (`apps/api/src/modules/purchasing/purchasing-errors.ts`) gains the `supplier_return.*` and `purchase_reversal.*` codes, and keeps delegating `inventory.*` to `inventoryRefusal`.
- Accounting refusals keep the accepted mapping.

| Code | Raised by | HTTP | Retry? |
|---|---|---|---|
| `supplier_return.lines_invalid` | DTO, service, routine (shape, foreign line, variant ≠ line's) | 400 | no |
| `supplier_return.quantity_exceeds_purchased` | service pre-check; routine under the purchase lock; deferred guard | 422 | no — **Must-prove 1** |
| `inventory.insufficient_stock` | service pre-check; routine after step 6; primitive | 409 | no — **Must-prove 2** |
| `inventory.warehouse_out_of_scope` | application authority (before minting) | 403 | no — **Must-prove 3** |
| `supplier_return.purchase_state_invalid` · `supplier_return.purchase_reversed` | routine | 409 | no |
| `supplier_return.supplier_inactive` | routine (only when a credit would be issued) | 409 | no |
| `supplier_return.date_before_purchase` · `supplier_return.document_date_in_future` | DTO/service; routine | 422 | no |
| `supplier_return.value_zero` · `supplier_return.amount_below_base_unit` | service; routine | 422 | no |
| `supplier_return.idempotency_conflict` | service pre-check; routine | 409 | no |
| `supplier_credit_note.immutable` | guard | 500-class from a routine (no route edits) | no |
| `inventory.valuation_changed` | return (A-07: the average or AP moved) | 409 | **yes**, same body |
| `purchase_reversal.payment_allocated` | service pre-check; routine | 409 | no — **Must-prove 5 (a)** |
| `purchase_reversal.credit_allocated` | service pre-check; routine | 409 | no — **Must-prove 5 (b)** |
| `purchase_reversal.returned` | service pre-check; routine; deferred header guard | 409 | no — **Must-prove 5 (c)** |
| `purchase_reversal.insufficient_stock` | routine after step 6 | 409 | no — **Must-prove 5 (d)** |
| `purchase_reversal.deficit_coverage_present` | routine; deferred header guard | 409 | no (TL-7) |
| `purchase_reversal.valuation_residue` | routine after step 6; primitive (`inventory.reversal_valuation_residue`) | 409 | no (TL-8) |
| `purchase_reversal.already_reversed` | service pre-check; routine | 409 | no |
| `purchase_reversal.purchase_changed` | routine | 409 | yes, after re-read |
| `purchase_reversal.reason_required` · `purchase_reversal.date_before_purchase` · `purchase_reversal.date_in_future` | DTO; routine | 422 | no |
| `purchase.not_found` · `purchase.state_invalid` | routines | 404 / 409 | no |
| `inventory.reversal_pair_missing` · `inventory.reversal_pair_mismatch` | primitive (R-B1a) | 500-class from a routine | no |
| `inventory.source_*`, `inventory.ledger_immutable`, `inventory.stock_source_line_missing` | S5 deferred guards; tamper tests | 500-class from a routine | no |
| `accounting.inventory_detail_missing` / `accounting.inventory_entry_mismatch` | A-15(a) at COMMIT | accepted mapping | no |
| `accounting.reversal_source_domain_owned` | A-15(b) (generic reversal of a domain entry) | 409 | no |
| `accounting.period_*`, `accounting.entry_date_in_future`, `accounting.entry_date_before_original` | accepted accounting | accepted mapping | no |

`packages/inventory/src/errors.ts` gains the codes the arithmetic can raise:
- `supplier_return.quantity_exceeds_purchased`;
- `supplier_return.value_zero`;
- `supplier_return.amount_below_base_unit`.

Messages carry no amounts.

---

## 4. Packages and application

### 4.1 `@daftar/inventory` (framework-free; the S3 gate keeps enforcing it)

- **`payload.ts`.** It gains the two codes in `INVENTORY_OPERATION_CODES` and their schemas. This is additive, with coordinator sign-off, because it is an S1 file.
- **`supplier-return-payloads.ts` and `purchase-reversal-payloads.ts`.** Payload builders and intent digests (A-17).
- **`supplier-return.ts`:**
  - `carryingTxn(t, qty, returnedBefore, q)`, per A-10(a);
  - `apSplit(C, O)`, per A-10(c);
  - `apBaseRelease(B, T, O, apTxn)`, per A-10(d);
  - `ppv(apBase, creditBase, I)`, per A-10(f).

  `convert` is an **input** function. The conversion belongs to `@daftar/accounting` (S4C §4.1).
- **Vectors:**
  - `vectors/invpl-s5-vectors.json`: one vector per kind and one per NULL-able field.
  - `vectors/supplier-return-vectors.json`, with cases:
    - `CUMULATIVE-THIRDS`: t = 100, qty = 3, three returns of 1 → 33, 34, 33; Σ = 100. The naive-plus-flush form is shown to differ;
    - `FULL-RETURN-EXACT`;
    - `LANDED-INCLUDED`;
    - `FOREIGN-DUST`: JOD 3 dp on a 2 dp base, with the dust line non-zero;
    - `AP-FIRST-EXCESS`: O < C ⇒ `ap_txn = O`, credit = C − O;
    - `AP-EXHAUSTED`: O = 0 ⇒ all to credit, `ap_base = 0`;
    - `PPV-POSITIVE` and `PPV-NEGATIVE`;
    - `VALUE-ZERO`;
    - `BELOW-BASE-UNIT`.
- **Parity.** Every vector is asserted identically in TypeScript and SQL (L:390), in T-07.

### 4.2 `@daftar/accounting`

- `post.ts:200`: `DOMAIN_SOURCE_TYPES` gains `'supplier_return'`, additively.
- `post.ts`: a new `DOMAIN_REVERSIBLE_SOURCE_TYPES = ['purchase'] as const` (R-B2a).
- `domain-posting.ts`: `mintDomainReversalAssertion` (A-06). `index.ts` exports it.
- `AccountingEngine.reverse` is **unchanged**. It is the merchant path, and the DB guard still refuses a generic reversal of a purchase entry.

### 4.3 `apps/api/src/modules/purchasing/`

| File | Contents |
|---|---|
| `purchase-return.service.ts` | Order: A-17 (replay pre-read) → authority (`purchases.return`, the return warehouse) → reads (purchase, lines, earlier returns, `purchase_ap_outstanding`, `stock_levels`) → `@daftar/inventory` arithmetic + `convertToBaseMinor` → mint the inventory assertion + one accounting assertion → seam 2 → routine → `postEntryInTransaction` → commit |
| `purchase-reversal.service.ts` | Order: A-17 → authority (`purchases.receive`, the purchase warehouse) → pre-checks (settlement, returns, coverage, stock) for clean refusals → read the original entry (`AccountingLedgerReader.readEntry`) → `mintDomainReversalAssertion` → seam 2 → routine → `postReversalInTransaction` → commit |
| `purchase-return-posting.ts` | the `PostingCommand` builder for A-10(g) |
| `purchasing-reads.ts` | A-19 extensions: derived `reversed`, returns, credit notes, AP |
| `purchasing-errors.ts` | §3 |
| `purchases.controller.ts`, `supplier-returns.controller.ts`, `purchasing.schemas.ts` | the API layer (A-19) |

- `packages/shared-contracts/src/purchasing.ts` gains the response types.
- `apps/api/src/modules/inventory/inventory-authorization.ts` gains the two `OPERATION_AUTHORITY` rows (A-03).
- `apps/api/src/modules/accounting/accounting-sources.adapter.ts` is **unchanged**. `postReversalInTransaction` already exists (`:89-102`).

---

## 5. Harness

- **Builders.** A new `tests/helpers/purchase-returns.ts` has builders for received purchases (via the S4 harness `tests/helpers/purchase-commands.ts`), returns and reversals, and ledger/stock readers.
- **Settlement fixture (the L:470 precedent: a test fixture, not a production failpoint).** A new `tests/helpers/purchase-settlement-fixture.ts`, run as the **schema owner in the test database only**:
  1. It saves `pg_get_functiondef` of `purchase_ap_outstanding(uuid,uuid)` and `purchase_settlement_state(uuid,uuid)`.
  2. It `CREATE OR REPLACE`s them with fixture bodies driven by a test-only table `test_settlement_fixture(business_id, purchase_id, outstanding_txn, payment_allocated, credit_allocated)`. That table is created and dropped by the helper, **never** by a migration.
  3. It restores the saved definitions and asserts their `prosrc` SHA-256 equals the pre-install value. The suites that use it run serially (`describe.sequential`, one file).
  4. Both functions are INVOKER. The fixture table carries `GRANT SELECT` to `daftar_app` and `daftar_inventory_internal` for the test's life.
- **Deficit seeding.** The TL-7 case reuses S4's `tests/helpers/purchase-deficits.ts`.
- **Mixed-cost keys** for TL-8 are built with S3 commands (opening, damage) and S4 receipts only. No owner seeding.
- **Isolation.** Embedded PostgreSQL runs on its own `PG_DIR`/`PG_PORT` per agent (SM:36).

---

## 6. Test plan

The files are `tests/integration/purchase-s5-*.test.ts` and `tests/security/purchase-s5-*.test.ts`, plus the package tests. Each Must-prove item of P:228-233 is named.

| # | Proves | Must-prove |
|---|---|---|
| T-01 | **Grants and ACL:** every runtime role is refused DML on the S5 tables (42501); `daftar_app` reads exactly A-18; the EXECUTE matrix; the two read functions are INVOKER and return only RLS-visible data | — |
| T-02 | **Signed authority:** both routines refuse a missing, forged, replayed or wrong-kind assertion, and a payload with any one field changed (`inventory.assertion_payload_mismatch`), before writing anything. A `purchase.return` assertion cannot write a `purchase_reversal` movement (`inventory.movement_kind_not_authorized`) | P3-AL-55 |
| T-03 | **Return posting shape:** domestic, `Dr AP C / Cr Inventory I / ±PPV`; PPV positive and negative; no `6100`, no revenue, no `tax_payable`; the entry equals the stored header; `Σ` movement values = `−I` | P:226, L:915-921 |
| T-04 | **Cumulative quantity:** T-04.1 sequential partial returns up to `qty_i` succeed and the crossing one is refused `supplier_return.quantity_exceeds_purchased`; T-04.2 two concurrent returns that jointly cross it leave exactly one committed; T-04.3 `CUMULATIVE-THIRDS` end to end (Σ carrying = `t_i`); T-04.4 a tampered owner insert crossing the bound fails at COMMIT (deferred guard) | **MP-1**, PM-13 |
| T-05 | **Stock bound:** a return of more than the return key holds → `inventory.insufficient_stock`, with nothing written; `|q| = on_hand` flushes exactly (valuation 0); the same return from a warehouse that holds the stock succeeds | **MP-2**, PM-14 |
| T-06 | **Other warehouse:** after an S3 transfer W1→W2, a return from W2 by an actor scoped to W2 succeeds, at W2's average, with PPV against the W1 purchase's carrying value; an actor scoped to W1 only gets 403 `inventory.warehouse_out_of_scope` with no assertion minted (no `inventory_assertion_uses` row); a signed payload naming W1 cannot be replayed for W2 (`assertion_payload_mismatch`) | **MP-3**, L:911 |
| T-07 | **AP first, then 1150** (settlement fixture sets `outstanding_txn < C`): AP is debited by exactly `O` in txn and by `ap_base` in base; `Dr supplier_receivable credit_base`; the credit note has original = remaining (both pairs); ledger AP of the purchase afterwards is exactly 0 in txn and base, never negative; no revenue account touched; `AP-EXHAUSTED` (O = 0) posts no AP line; SQL/TS parity on every `supplier-return-vectors` case | **MP-4**, L:930-936 |
| T-08 | **Reversal preconditions, each independently** (for each, only that one precondition fails): (a) fixture `payment_allocated` → `.payment_allocated`; (b) fixture `credit_allocated` → `.credit_allocated`; (c) one return exists → `.returned`; (d) stock moved out (S3 transfer) → `.insufficient_stock`; plus (e) a covering receipt (S4 deficit helper) → `.deficit_coverage_present` and (f) a mixed-cost key drained to exactly `qty` → `.valuation_residue`. Each refusal leaves no reversal row, movement, entry, audit or outbox row | **MP-5**, L:751-760 |
| T-09 | **Exact removal:** after a reversal, each line's `purchase_reversal` movement value = −its `purchase` movement value; the key's valuation drops by exactly `Σ s_i = B`; GL Inventory drops by exactly B; AP by exactly T/B; `accounting_reversals` names the purchase entry; the purchase reads `reversed`; with an intervening receipt at another cost on the same key, the reversal still removes exactly `s_i` (not the average) and the remaining average is re-derived | **MP-6**, L:757 |
| T-10 | **Concurrency:** return vs reversal of one purchase (exactly one wins; the other refuses `.returned` or `.purchase_reversed`); two identical reversals (one commit, one replay); return vs a concurrent damage on the key (the loser 409s `inventory.valuation_changed` or waits, with no partial state) | PM-13 |
| T-11 | **Idempotency:** a retried return or reversal creates no second movement or entry; a replay succeeds after the variant was archived (proof before state); the replayed seam-2 assertion expires unused | P:215 analogue |
| T-12 | **Reads:** ledger-derived AP after partial returns equals `purchase_ap_outstanding`; base AP = `B − Σ ap_base`; the credit-note list is supplier-scoped and business-wide; no stored balance column (catalogue, G-3) | L:843-854 |
| T-13 | **Atomicity:** a failure injected after each §2.5 step (routine, post, deferred triggers) leaves nothing, as a named test failpoint in the harness only | L:760 |
| T-14 | **FX:** a foreign purchase returned in three parts; each AP line satisfies 0043; `FOREIGN-DUST` posts the dust line; total AP base released = B exactly after the full return; the snapshot rate is used although a newer rate exists (no lookup) | DM §7ج |
| T-15 | **Tamper / guards:** UPDATE/DELETE on every S5 table (owner too) refused; a credit note decrement refused (`supplier_credit_note.immutable`); a generic `AccountingEngine.reverse` of a purchase entry → `accounting.reversal_source_domain_owned`; a generic reversal of a `supplier_return` entry → the same; a `purchase_reversals` row without its reversal binding fails at COMMIT; an entry with an extra line fails A-15(a); **under R-B1a**, a direct primitive call with a caller-supplied `purchase_reversal` value → `movement_shape_invalid`, an unpaired line → `reversal_pair_missing` | L:1550-1568 |
| T-16 | **Gaps function:** every §2.3 S5 row is reported when disabled, replica-only, re-created on another function or body-changed; the S3 and S4 rows are unchanged | A-16 (S4C) |
| T-17 | **Upgrade matrix:** a frozen 0064 checkpoint plus an existing business with received purchases goes to 0065/0066 with books, ledger and catalogue untouched, registries exactly S3 + S4 + S5, and a rerun no-op | — |
| T-18 | **HTTP authority:** each route refuses without its permission; the manager (view keys only) reads but cannot return or reverse; `purchases.return` alone cannot reverse | L:1174-1186 |

The package unit tests cover `supplier-return`, `supplier-return-payloads` and `purchase-reversal-payloads`, each against its vectors, with SQL parity in T-07/T-14.

---

## 7. Gate, guards and predecessor evolution

### 7.1 `scripts/phase3-s5-gate.ts` (two tenses, the form of `scripts/phase3-s4-gate.ts`)

**Constants.**
- `S4_BOUNDARY = '0064_purchase_commands.sql'`
- `S5_MIGRATIONS = ['0065_supplier_returns_reversals_sources.sql', '0066_supplier_return_reversal_commands.sql']`
- `S5_ACCEPTED: Record<string,string> = {}`, filled in the freeze commit only
- `ACCEPTED = Object.keys(S5_ACCEPTED).length > 0`

**1. Boundary.**

| Tense | Checks |
|---|---|
| Candidate | `frozenThrough === S4_BOUNDARY`; neither S5 file is in the manifest; the files after 0064 are exactly `S5_MIGRATIONS` |
| Accepted | `frozenThrough ≥ '0066…'`; each file hashes to `S5_ACCEPTED` on disk and in the manifest; the range `0065–0066` holds exactly the two files; a successor is not this gate's business |

**2. Scope** (S5 files only, `stripComments`, the `insertedTuples` scanner as fixed at `201d7bd`, spaced or compact tuples):
- **`REGISTRATIONS`**, exactly:
  - `stock_source_types`: `'purchase_reversal'`, `'supplier_return'`;
  - `inventory_operation_kinds`: `'purchase.return'`, `'purchase.reverse'`;
  - `inventory_operation_movement_kinds`: the two pairs;
  - `accounting_source_types`: `'supplier_return'` (R-B2b: + `'purchase_reversal'`);
  - `accounting_operation_kinds`: `'post','supplier_return'` (R-B2b: + `'post','purchase_reversal'`).
- No `INSERT INTO stock_movement_kinds`.
- **`LATER_TABLES`** (S6+): `CREATE TABLE (supplier_payment\w*|supplier_allocation\w*|supplier_credit_allocation\w*|supplier_refund\w*|payment_method\w*|reservation\w*)`.
- No `reserved`/`available` column.
- **OD-03:** no `tax_payable` token; no column matching `tax` in either file.
- **No `rounding` system key token.** `purchase_price_variance` and `supplier_receivable` are **required** tokens in 0065 (A-15(a)).
- **`ALLOWED_EXECUTE`** is exactly these 7 `GRANT EXECUTE` statements:
  - `purchase_return:daftar_app`, `purchase_reverse:daftar_app`;
  - `purchase_ap_outstanding:daftar_app`, `purchase_ap_outstanding:daftar_inventory_internal`;
  - `purchase_settlement_state:daftar_app`, `purchase_settlement_state:daftar_inventory_internal`;
  - `accounting_purchase_entry_id:daftar_inventory_internal`.
- No role or membership change. No `UPDATE` or `DELETE` grant on any S5 table.
- **No `ALTER TABLE` on an S3/S4 table** other than the two `ADD CONSTRAINT … UNIQUE` of §2.1(2).

**3. Required objects:**
- the five tables and two bridges, created by 0065;
- every §2.3 trigger by name;
- the two routines, three helpers and two read functions, created by 0066;
- the three accounting objects;
- `CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps(` in 0065, containing each of the **twenty-four** S3/S4 digests of `0063:1031-1054` **verbatim** and a digest for each of the nine S5 functions;
- `SET LOCAL ROLE daftar_accounting_internal;[\s\S]*?CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard\(\)[\s\S]*?\$\$;`, containing `purchase_reversals` and all four always-refused types;
- **under R-B1a:** `SET LOCAL ROLE daftar_inventory_internal;[\s\S]*?CREATE OR REPLACE FUNCTION inventory_apply_stock_movements\(`, containing `'purchase_reversal'`;
- both CREATE brackets.

**4. Packages:**
- `supplier-return.ts`, `supplier-return-payloads.ts`, `purchase-reversal-payloads.ts`;
- the two vector files, with case ids `CUMULATIVE-THIRDS`, `FOREIGN-DUST`, `AP-FIRST-EXCESS`, `AP-EXHAUSTED`, `PPV-NEGATIVE` and `VALUE-ZERO`;
- `DOMAIN_SOURCE_TYPES` naming `supplier_return`;
- `DOMAIN_REVERSIBLE_SOURCE_TYPES` equal to `['purchase']`;
- `mintDomainReversalAssertion` exported;
- `packages/inventory/src` still imports only itself and `node:`.

**5. Suites.**
- `SUITE_PATTERN = /^purchase-s5-.*\.test\.ts$/` in `tests/integration` and `tests/security`.
- `REQUIRED_SUITES` include:
  - `purchase-s5-quantity-bound` (T-04);
  - `purchase-s5-ap-first` (T-07);
  - `purchase-s5-reversal-preconditions` (T-08);
  - `purchase-s5-reversal-exact` (T-09);
  - `purchase-s5-signed-authority` (T-02);
  - `purchase-s5-upgrade` (T-17).
- At least 8 suites.

**6. Runner canary**, exactly as `phase3-s4-gate.ts`.

**7. Composition.** `npm run gate:phase3:s4` must run in its **accepted** tense. It composes S3, S2, S1, P2-S8…P2-S1 and Phase 1.

**8. Run:**
- `npm run test -w @daftar/inventory`;
- `npm run test -w @daftar/accounting`;
- every discovered S5 suite;
- then `tests/performance/accounting-budgets.test.ts` in isolation. S5 adds one `WHEN`-filtered deferred trigger on `journal_entries` and one `EXISTS` to a `BEFORE INSERT` trigger on `accounting_reversals`, and Budget A must stay at its accepted bound.

**`package.json`:** `"gate:phase3:s5": "tsx scripts/phase3-s5-gate.ts"`, next to the S4 line.

### 7.2 Guards

| Guard | Change |
|---|---|
| G-3 `scripts/guards/no-authoritative-balance.ts` | **No code change.** The S4 `SUPPLIER_TABLE_NAME` discovery already covers `supplier_returns`, `supplier_return_lines`, `supplier_credit_notes`, `purchase_reversals` and `purchase_reversal_lines`. Its guard test gains a positive case (`supplier_credit_notes.remaining_amount_minor` allowed) and a negative case (`supplier_credit_notes.outstanding_minor` refused) |
| Rule 22 `scripts/guards/inventory-writer-authority.ts` | **Extended.** The writer list gains `0066: purchase_bridge_return` and `0066: purchase_bridge_reversal` (bridge writers, as S3's `inventory_bridge_source_lines`). `STOCK_WRITE_TABLES` gains `supplier_credit_notes` (TL-13; its only writer is `purchase_return`, whose first statement is the consume) |
| G-7 `inventory-definer-contract.ts` | no code change. It discovers the five new internal routines, the new guard functions and (R-B1a) the owner replacement of the primitive, which keeps its ACL (`:52-57`) |
| G-4 `posting-surface.ts`, G-1 `journal-privilege-model.ts` | no change: no journal writer and no journal grant. `accounting_purchase_entry_id` reads `journal_entries` as its owner |
| Rules 6, 7, 21; `no-float-rate.ts` | satisfied: BIGINT money, `NUMERIC(20,10)` rate, `inventory_half_even` only |

### 7.3 Predecessor pins that 0065/0066 turn red, and their evolution (ENG, the P2-S4 §45 form)

**Sequencing precondition (TL-1).** P3-S4 is accepted and frozen **before** the commit adding 0065:
- `S4_ACCEPTED` is filled;
- `frozenThrough ≥ 0064`;
- `gate:phase3:s4` is green in its accepted tense.

Otherwise the S4 candidate tense ("after 0062 exactly 0063, 0064") fails. The S4 gate's scope checks read S4 files only and are **not** affected.

**Line numbers.** Every row below is stated **as S4 §7.3 leaves it**, with the file:line of `201d7bd` for location. Exact lines shift by S4's own evolution, and the coordinator re-locates them in the S4-frozen tree.

Every pin evolves **in the same commit** as the migration that turns it red, by the coordinator:
- the accepted and S4 rows stay, verbatim and in order;
- the S5 rows are **appended** with a `// P3-S5 (0065/0066)` comment;
- nothing is deleted except where stated.

| # | Pin (file:line at `201d7bd`) | As S4 leaves it | Evolves to | Turned red by |
|---|---|---|---|---|
| 1 | `tests/integration/migration-upgrade.test.ts:459-465` | `accounting_source_types` by `sort_order` = native three + S3 two + S4 two | + `supplier_return` (R-B2b: + `purchase_reversal`) | 0065 |
| 2 | `migration-upgrade.test.ts:766` (P2-S6 case) | protected rows + `src:…:4…7` | + `src:supplier_return:8` | 0065 |
| 3 | `migration-upgrade.test.ts:1180-1227` (P3-S2 case) | registries = S3 + S4; `stock_source_types: 6`, mappings `8` | + the S5 rows; counts 8 and 10; ledger counts stay 0 | 0065 (types), 0066 (mappings) |
| 4 | `migration-upgrade.test.ts:1402`, `:1422-1440` (P3-S3 case) **and the S4 T-17 case** in `purchase-s4-upgrade` | `after` = before + S3 (+ S4) `src:` rows; registries exactly checkpoint + S3 (+ S4) | + `src:supplier_return:8`; + the S5 type, map and op rows. **Plus a new P3-S5 case (T-17)** | 0065/0066 |
| 5 | `tests/golden-regression/phase2/01-engine-shapes.golden.test.ts:549-556` | source types = native three + S3 two + S4 two | + `supplier_return` | 0065 |
| 6 | **`01-engine-shapes.golden.test.ts:525-545`** | the `forbidden` list still includes **`'supplier_credit_notes'`** (S4 removed `'suppliers'`) | remove `'supplier_credit_notes'` only, with the `accounting_periods` precedent comment (`:515-522`); `supplier_refunds` stays forbidden until S6 | 0065 |
| 7 | `tests/security/accounting-sources-authority.test.ts:106-120` | exactly seven `accounting_operation_kinds` pairs | + `('post','supplier_return')` in sort position | 0065 |
| 8 | `tests/security/journal-privilege-matrix.test.ts:335-356` | `accounting_validator` policy tables = 11 + S4 two; `S3_HEADERS` + S4 | + `purchase_reversals`, `supplier_returns`; the headers list gains both | 0065 |
| 9 | `tests/security/inventory-db-authority.test.ts:217-259` | internal table privileges exactly S1–S4 | + the five S5 tables and two bridges, `INSERT,SELECT` each | 0065 |
| 10 | `inventory-db-authority.test.ts:262-290` | column privileges exactly S1–S4 | **not turned red** (S5 grants no column `UPDATE`); re-run unchanged | — |
| 11 | `inventory-db-authority.test.ts:332-356` | internal-routine EXECUTE matrix S1–S4 | + `purchase_return`, `purchase_reverse` → `daftar_app` | 0066 |
| 12 | `tests/security/stock-ledger-authority.test.ts:145-156` (T-02.1 discovery) | `S2_RELATIONS + S3_BRIDGES + S4 bridges + NICA header` | + `stock_source_bridge_purchase_reversal`, `stock_source_bridge_supplier_return` | 0065 |
| 13 | `stock-ledger-authority.test.ts:724-805` (trigger matrix on `stock_source_bindings`) | S2 + four S3 + two S4 binding guards + deficit triggers | + `stock_binding_requires_purchase_reversal`, `stock_binding_requires_supplier_return` | 0065 |
| 14 | `stock-ledger-authority.test.ts:273-315`, `:806` (0059-E/0060-E at the P3-S2 checkpoint via `rewindToP3S2Checkpoint`) | the rewind undoes S3 and S4 | **the rewind helper evolves** (row 16); the tests are then unchanged | 0065/0066 |
| 15 | **`stock-ledger-authority.test.ts:580-588` (T-16.4)** and **`tests/integration/stock-ledger-primitive.test.ts:505-520` (T-21.2)**: **R-B1a only** | a fixture `purchase_reversal` of −1 / −7 on a fixture source is valued at the average | the fixture request uses `source_type 'purchase_reversal'` and is preceded by a paired `purchase` movement (`source_type 'purchase'`, same `source_id`/`source_line_id`). T-16.4's assertion (kind authorized, row written) and T-21.2's (exact flush to 0) keep their meaning. **T-21.1 (`:489-499`) stays green by the §2.4 check order.** A new negative control: the fixture `purchase_reversal` without a pair → `inventory.reversal_pair_missing` | 0065 |
| 16 | `tests/helpers/stock-ledger.ts:108-137` (constants), `:547-570` (`assertMigrationState`), `:586-600` (`rewindToP3S2Checkpoint`), `:617` (TRUNCATE list) | S3 + S4 sets | add `S5_SOURCE_TYPES`, `S5_OPERATION_KINDS`, `S5_OPERATION_MOVEMENT_KINDS`, `S5_BRIDGES`; migration state = S1 + S3 + S4 + S5. The rewind also deletes `registered_by='P3-S5'` (mappings, then types); S5 grants nothing 0059-E inspects. The TRUNCATE adds the S5 bridges, `purchase_reversal_lines`, `purchase_reversals`, `supplier_credit_notes`, `supplier_return_lines` and `supplier_returns`, children first | 0065/0066 |
| 17 | `tests/security/stock-ledger-structure.test.ts:436-447` (registries) | follows row 16's constants | unchanged code; green once row 16 lands | 0065/0066 |
| 18 | `tests/integration/inventory-db-guard.test.ts:47-76` (G-7) and `:122-130` (rule-22 writers) | exact S3 + S4 lists | + the five S5 routines and the S5 guard functions; writers + `0066: purchase_bridge_return`, `0066: purchase_bridge_reversal`, and (R-B1a) the primitive's second definition in 0065 | 0065/0066 |
| 19 | `tests/security/search-path-shadowing.test.ts:475-489` (`EXECUTE_MATRIX`) | S1 + S3 + S4 | + the two `purchase_return(…)` / `purchase_reverse(…)` signatures → `['daftar_app']` | 0066 |
| 20 | `tests/integration/migration-portability.test.ts:1095-1188` (named owners) | S1–S4 set | + every S5 internal routine and guard; + `accounting_supplier_return_entry_complete`, `accounting_purchase_entry_id` in the accounting-owned `IN` list; + `purchase_ap_outstanding`, `purchase_settlement_state` as migrator-owned | 0065/0066 |
| 21 | `packages/inventory/test/payload.test.ts:219-233` | S1 three + S3 seven + S4 seven | + `purchase.return`, `purchase.reverse` | package change |
| 22 | `packages/accounting/test/domain-posting.test.ts:114` | `DOMAIN_SOURCE_TYPES` = S3 two + S4 two | + `supplier_return`; a new case for `DOMAIN_REVERSIBLE_SOURCE_TYPES` | package change |
| 23 | `tests/security/inventory-s3-authority.test.ts:379-405` ("registries are exactly S1 + S3", S4-evolved) | op kinds S1 + S3 + S4; mappings S3 + S4; gaps `[]` | + the two S5 kinds; + the two S5 mappings; the gaps assertion stays `[]` | 0066 |
| 24 | **S4 suites' exact-set pins** (created by S4's agent T; names per S4C §6): T-01 `purchase-s4-*` ACL ("`daftar_app` reads exactly A-18"), where the query discovers by `supplier_%`/`purchase_%`; T-17 `purchase-s4-upgrade` ("registries exactly S3 + S4"); T-15 (reversal guard) | exact S4 sets | T-01: scope the discovery to the S4 table list, or append the five S5 tables; T-17: + the S5 rows (as row 4). **T-15's "reversal of a purchase entry refused" stays green**: the generic path has no `purchase_reversals` row | 0065/0066 |

**Not affected:**
- `0063-E`/`0064-E`, which are apply-time.
- `tests/integration/inventory-s3-review-fixes.test.ts:407-470` (F3) and S4's T-16, because §2.3 keeps the S3/S4 parts byte-identical.
- `stock-ledger-structure.test.ts:876-878` (PM-44 writers as S4 leaves it). S5 adds no STOCK_DML writer; the primitive stays the first-asserted writer.
- `tests/security/stock-ledger-same-owner.test.ts`. The owner replacement keeps the owner.
- `phase3-s1`/`s2`/`s3`/`s4` gate scope checks, which read their own files.
- `gate:phase2:release`.

**Negative proof.** Each evolved predicate stays exact. A rolled-back injection of an unauthorized row fails it:
- `accounting_source_types … 'supplier_refund'`;
- `stock_source_types … 'fixture_rogue'`;
- an op kind `purchase.approve`.

---

## 8. File ownership (SAFE_CONCURRENCY = 5, SM:41-42)

| Agent | Owns (writes) | Must not touch |
|---|---|---|
| **C: coordinator** | this contract; the S4 freeze (TL-1), and later `MIGRATION_MANIFEST.json` for S5 (freeze commit only); the B-1/B-2 decisions recorded, and the lock amendments they need (L:1376 row; L:757 or L:1046); **every §7.3 pin** (rows 1–24, including `tests/helpers/stock-ledger.ts` and the two package test files); `scripts/phase3-s5-gate.ts` and the `package.json` line; the rule-22 and G-3 guard-test extensions; `docs/DAFTAR_STATE_MACHINES.md` (derived `reversed`, the return and the credit note); `PROJECT_STATUS.md`; `docs/PHASE_3_S5_ACCEPTANCE.md` | migrations; `src/**` |
| **M: migration writer** (the only schema writer, SM:36) | `infrastructure/database/migrations/0065_supplier_returns_reversals_sources.sql`, `0066_supplier_return_reversal_commands.sql` | everything else |
| **D: domain/application and packages** | `packages/inventory/src/{supplier-return,supplier-return-payloads,purchase-reversal-payloads}.ts`; the additive edits of `payload.ts`, `errors.ts`, `index.ts` (coordinator sign-off: S1 files); `packages/inventory/vectors/{invpl-s5,supplier-return}-vectors.json` and their `packages/inventory/test/*.test.ts`; `packages/accounting/src/{post.ts (DOMAIN_* lists),domain-posting.ts,index.ts}`; `apps/api/src/modules/purchasing/{purchase-return.service,purchase-reversal.service,purchase-return-posting,purchasing-reads,purchasing-errors}.ts`; the two `OPERATION_AUTHORITY` rows | controllers, DTOs, module wiring, tests outside `packages/*/test` |
| **A: API** | `apps/api/src/modules/purchasing/{purchases.controller,supplier-returns.controller,purchasing.schemas,purchasing.module}.ts`; `packages/shared-contracts/src/purchasing.ts` and its export | services, migrations, tests |
| **T: tests** | `tests/helpers/purchase-returns.ts`, `tests/helpers/purchase-settlement-fixture.ts`; every §6 T-file (`tests/integration/purchase-s5-*.test.ts`, `tests/security/purchase-s5-*.test.ts`) | predecessor tests (they belong to C), `src/**`, migrations |

**Merge order** (SM:64):
1. **C:** contract; S4 freeze; B-1 and B-2 decided and recorded.
2. **M:** 0065 with C's rows 1, 2, 3 (types), 5–9, 12–17, 20 (accounting part), 24 (one green commit). Then 0066 with rows 3 (mappings), 4, 11, 18–20, 23.
3. **D:** packages (with rows 21–22), then services.
4. **A:** controllers and DTOs.
5. **T:** suites. T may start once step 2 lands.
6. **C:** gate, guards, acceptance page, the independent security review (SM:49), then the S5 freeze commit.

---

## 9. Real blockers and Tech Lead notes

### 9.1 Real blockers

**B-1 · "At the original receipt cost" contradicts "an outbound movement is valued at the current average". This is an architectural contradiction.**

- **The contradiction, exactly:**
  - L:757 (AL-20): the reversal writes "inverse stock movements for every line (at the **original receipt cost**, so the reversal removes exactly the value the receipt added)". P:233 makes it a Must-prove.
  - L:452 (AL-11): "An outbound movement's `unit_cost_base_minor` snapshot is the key's current average … stated once, here". L:1376 (AL-49 §C) enumerates a **closed** set of value rules (priced-document share, one HALF_EVEN, the depletion flush, the negation of a paired `transfer_out`). None is "the negation of a paired `purchase`".
  - The frozen primitive enforces both: a `qty < 0` request with a caller value is refused (`0060:379-381`, "an outbound movement is valued at the current average, not by its caller"). `purchase_reversal` is `negative` (`0059`), so it can only be valued at the average.
  - Whenever the key's average ≠ the receipt's unit cost (any later receipt at another price, or rounding), an average-valued reversal does **not** remove "exactly the value the receipt added". Must-prove 6 then fails, and GL (the Phase 2 mirror removes B exactly) diverges from stock by the difference (PM-16).
- **Scope of the block.** The purchase reversal only (Must-prove 6, and PM-16 for reversals). Returns, credit notes and every other S5 object are unaffected. It blocks S5 **acceptance**, not S5 start.
- **Recommended resolution (R-B1a).** It needs a lock amendment adding one row to AL-49 §C and one sentence to AL-11:
  - `purchase_reversal` is valued as the **exact negation of its paired `purchase` movement** (same `source_id`/`source_line_id`). It is the `transfer_in` precedent (L:527) applied to the undo of a priced document.
  - It is implemented as one branch in an owner replacement of the primitive (§2.4), plus the residue guard: `on_hand = 0 ⇒ valuation = 0` (L:359) and no negative valuation on a positive key. Where the guard refuses, AL-20's own fallback applies ("the correction proceeds through the real downstream operations": return the goods).
  - The value is still produced by one stored integer copied, never recomputed. Zero tolerance holds, because GL and stock both move by `−Σ s_i = −B`.
  - It turns two S2 pins red (§7.3 row 15), which evolve with the same meaning.
- **Rejected alternatives:**
  - **(b)** An average-valued reversal plus a `negative_inventory_cost_adjustment` value-only correction of the difference. That misuses a kind whose meaning is "deficit catch-up" (L:476-512), and needs a third entry.
  - **(c)** A new zero-quantity kind. That amends the closed AL-10 list, which is a larger amendment than (a).
- **If R-B1a is refused.** The only lock-conformant S5 behaviour is to value at the average and **refuse** unless every line's primitive value equals `−s_i` (`purchase_reversal.cost_changed`). That is correct but narrow: it refuses most reversals after any restock at a different price. The Tech Lead must then re-scope P:233.

**B-2 · "Through the accepted Phase 2 reversal workflow" contradicts "`purchase_reversal` is an accounting source type". This is an architectural contradiction.**

- **The contradiction, exactly:**
  - L:757 requires "an accounting reversal of the purchase's journal entry **through the accepted Phase 2 reversal workflow**". That workflow is `accounting_post_reversal` (`0046:449`). It writes an entry of `source_type 'reversal'`, `source_id` = the original entry id, an `accounting_reversals` row (`id = original_entry_id`, `0046:166-185`), and derives the mirror from persistence. It is the only way Phase 2 answers "is this entry reversed?" (a join, `0046:151-165`).
  - L:1046 (AL-34) registers **`purchase_reversal`** as an **accounting** source type (`not_before_origin`). L:1432 and L:1437-1440 ("the names … used identically … in `accounting_source_types` where the same fact also posts") say the same fact posts under that name.
  - One entry cannot be both. A `reversal` entry cannot carry `source_type 'purchase_reversal'`. A `purchase_reversal` entry posted by `accounting_post_entry` is not an `accounting_reversals` row: the Phase 2 "is reversed?" join would say the purchase entry is **not** reversed, and the Phase 2 reversal protections (no second reversal, no reversal of a reversal, mirror from persistence) would not apply.
  - Registering `purchase_reversal` without ever posting it would violate L:1052 ("a registry entry is a claim that the ledger can receive that fact") and 0046's owning-kind rule.
- **Recommended resolution (R-B2a).** It needs a lock amendment of L:1046, moving `purchase_reversal` to the stock-only table (L:1432), with a note: its accounting fact is a Phase 2 `reversal`.
  - Post through `accounting_post_reversal`, i.e. `postReversalInTransaction`, which exists.
  - Admit it by the owner-replaced reversal guard **only** when the paired `purchase_reversals` row exists in the same transaction (A-15(b)). Pair it back by the deferred binding FK `('reversal', original_entry_id)`.
  - Register `purchase_reversal` in `stock_source_types` only.
  - This honours L:757 literally, keeps AL-12's join correct, and adds no journal writer.
- **Alternative (R-B2b).** If the Tech Lead prefers the AL-34 registry:
  - register `('purchase_reversal','not_before_origin',…,9)` with `('post','purchase_reversal')`, `source_id` = the original entry id, so `not_before_origin` resolves through `journal_entries.id = source_id` (`0045`);
  - post with `accounting_post_entry` and the service-built mirror (`mirrorReversalLines`);
  - add a completeness trigger proving the mirror line-for-line;
  - add `purchase_reversal` to the always-refused reversal list.

  Phase 2's "is reversed?" join must then be amended to also read `purchase_reversal` entries, and that is an amendment to an accepted Phase 2 contract. This contract is written for R-B2a. The R-B2b deltas are marked where they differ (A-05, §2.8(3), §7.1, §7.3 row 1).

**Not blockers** (checked against the six categories):
- **OD-03** is bounded. S5 carries no tax and designs none, and every tax element is marked **BLOCKED BY OD-03** (A-14).
- **OD-07** (revaluation) is out of Phase 3. The credit note's carrying base is fixed at the purchase snapshot.
- **No paid provider** and **no external credential.** TD-10 is unchanged.
- **No destructive data decision.** The two new candidate keys are on existing keys and cannot fail on valid data. No row is changed.
- **The unreachable production paths** (1150 excess, and preconditions (a)/(b)) are the lock's own situation in S4 (L:470). They are proven by fixture, not blocked.

### 9.2 Tech Lead notes (engineering rulings to confirm)

- **TL-1 · Sequencing.** S4 must be accepted and frozen before 0065 (S4 gate candidate tense). The S4 §7.3 pins and S4 suites must exist, since S5 evolves them (§7.3 rows 1–24 are stated as S4 leaves them).
- **TL-2 · Derived `reversed`.** `purchases.status` stays `received`, and "reversed" is the existence of `purchase_reversals` (the AL-12 join precedent).
  - This keeps every S4 guard and all eight S4 digests verbatim, and needs no UPDATE grant on `purchases`.
  - The alternative adds `'reversed'` to the status CHECK and replaces `purchase_header_guard()`, `stock_source_complete_purchase_header()`, `purchase_source_value_complete()` and the shape CHECKs, changing four S4 digests.
- **TL-3 · FX dust and sub-unit amounts.** A foreign return's AP base release follows DM §7ج (cumulative proportional, exact at clearing). Where the 0043 per-line law makes `convert(ap_txn) ≠ ap_base`, a base-currency AP dust line carries the difference, so AP base reaches exactly 0 with AP txn. A txn amount that converts to 0 base is refused (`supplier_return.amount_below_base_unit`). Domestic purchases never produce either.
- **TL-4 · Reversal permission.** The closed AL-38 set has no `purchases.reverse`. The reversal requires **`purchases.receive`** (undoing a receipt is receipt authority), plus the purchase warehouse scope. The alternative is `purchases.manage`, or both.
- **TL-5 · Return scope.** Scope over the **return** warehouse only (L:911, AL-39: "every affected warehouse"; stock leaves one key). The purchase's warehouse branch appears only as the AP line's dimension, derived from the purchase.
- **TL-6 · One warehouse per return.** It keeps one average source, one inventory line and one scope target. A multi-warehouse return is several returns.
- **TL-7 · A covering receipt is not reversible** (`purchase_reversal.deficit_coverage_present`). Its receipt posted a NICA catch-up that a purchase reversal cannot unwind. It is unreachable in production while Phase 3 has no negative producer (L:465).
- **TL-8 · The residue refusal** (`purchase_reversal.valuation_residue`). Removing exactly `s_i` from a key whose other stock was partly consumed at a rounded average can leave `on_hand = 0` with valuation ≠ 0, or a negative valuation. L:359 forbids both. The alternative, a flush, would not remove "exactly the value the receipt added".
- **TL-9 · S6 extension points.**
  - `purchase_ap_outstanding` and `purchase_settlement_state` are the only places S6 must change for AP-first and preconditions (a)/(b).
  - S6's allocation writers must lock the purchase row `FOR SHARE` or stronger.
  - The S6 gate must require both functions' replacement and re-prove T-07/T-08(a)(b) against real allocations.
- **TL-10 · AP first at purchase level.** L:930 says "outstanding AP for that supplier". S5 measures the **purchase's** outstanding. The carrying value, the currency and the base belong to the purchase, and cross-purchase AP attribution is an S6 allocation question. In S5 both readings give identical results, since Σ C ≤ T per purchase and no other AP reducer exists. S6 may widen the helper.
- **TL-11 · Landed cost is carrying value.** `t_i = net + landed`. The supplier's invoice (AP) included the landed amount (S4C A-13). The alternative, net only, would push the landed share into PPV.
- **TL-12 · A zero-value return is refused** (`supplier_return.value_zero`: C = 0 and I = 0). The alternative is to allow it with no entry and a NULL binding, the S4 N = 0 precedent.
- **TL-13 · Credit notes are insert-only in S5.** S6 replaces `supplier_credit_note_guard()` by its owner to admit exactly the AL-31 decrement. DM §12's `number` and `status` are not created (A-11(f)).
- **TL-14 · Inactive supplier.** A return to an inactive supplier is allowed when it only reduces AP. It is refused only when it would issue a new credit (AL-40: "not selectable for a new … credit").
