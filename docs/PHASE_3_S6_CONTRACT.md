# DAFTAR — P3-S6 Contract / عقد الشريحة P3-S6

> **Coordinator rulings on this contract (2026-09-27).** Adopted as the P3-S6 implementation contract after P3-S5 was accepted and frozen (TL-1).
>
> **D-1 holds in frozen 0065/0066.**
> - `supplier_returns.ap_released_before_txn_minor` exists.
> - `supplier_return_value_complete()` verifies `ap_base` from that column.
> - `purchase_return` reads `O` through `purchase_ap_outstanding`.
>
> **P3-S5 changes S6 must honour.**
> - **0065 R-54** adds a COMMIT check to the value guard:
>   - `X ≥ Σ ap_txn` of the purchase's other-transaction returns;
>   - `Σ ap_txn ≤ T`.
>
>   Both hold when X also counts settlements, so D-1 stands and S6 changes no S5 value-guard body.
> - **0065 R-53** makes the gaps function report `supplier_credit_note_guard()` by digest. S6's owner replacement of that guard (A-12) must therefore re-record its digest in the same migration.
> - **0066 R-55** moved the credit-note INSERT into `purchase_bridge_credit_note`, the only writer rule 22 admits for `supplier_credit_notes`. Any S6 writer of `supplier_credit_notes` must open with the inventory assertion in the same shape.
>
> **Adopted as engineering rulings:** TL-2 … TL-17 of §9.2. TL-2 (no payment, allocation or refund reversal in Phase 3) is recorded as **TD-15**.
>
> **Added from the P3-S5 review (L2).** Under S5 TL-3, the last units of a very small foreign purchase line can convert to 0 base and be refused, which leaves a txn-only AP residue (txn > 0, base 0) on the purchase. The S6 D and M agents must state how an allocation meets such a residue under the base > 0 journal law and the 0043 rate law. Two outcomes are acceptable: a final allocation that absorbs it (the DM §7ج "the final consumption releases the entire residue" rule), or a stable refusal. Either way it is proven by a test, and if it cannot be cleared it is recorded as debt with its exact boundary. It is not left implicit.
>
> **R-numbers.** S6 headers use R-60 onward (TL-15). The S5 headers cite the S4 carry-forward rules as 0063 R-34 … R-41 and their own as R-42 … R-55.
>
> **Other rulings.**
> - **TL-11** (the inventory-assertion sequence) is a sibling of the S4 R-B1 seam. Like R-B1, it was recorded for the Tech Lead's confirmation; **CONFIRMED** by the Phase 3 corrective directive §12 (2026-09-28), with its seam suites green at the corrected candidate.
> - **OD-03** stays bounded: every tax element is BLOCKED BY OD-03.

> **Summary (Arabic).** عقد تنفيذ الشريحة P3-S6:
> - أساس طرق الدفع المشترك `payment_methods` و`payment_method_names`. حساب الترحيل أصلٌ نشط من نفس النشاط، وسياسة الأمر: حساب بلا مفتاح نظام، أو أحد مفاتيح التسوية الخمسة (1000–1040).
> - دفعات الموردين تُخصَّص بالكامل عند إنشائها على مشترياتٍ مستلمة، ويُنشأ قيدٌ واحد لكل تخصيص.
> - إطفاء القيمة الدفترية للذمة تراكمي ودقيق عند التصفية. الفرق المحقق يذهب إلى `4900`/`6900` فقط.
> - تخصيص رصيد المورّد على شراء، واسترداده نقدًا. يُقفل صف الإشعار مرة واحدة، ويتحرك الباقيان معًا، والاستهلاك الأخير يحرّر الباقي الدفتري كله.
> - أمر "استلام ودفع" واحد (P3-AL-24) في معاملة واحدة، بتوكيدَي مخزون متتاليين.
>
> لا عائق حقيقي. هناك اعتماد تسلسلي واحد (D-1): يجب أن تُبقي S5 العمود `supplier_returns.ap_released_before_txn_minor` كما في مسودتها. لا ضريبة (OD-03).

> **Status.** Candidate contract for P3-S6, written by the S6 contract agent. It is analysis only: no repository file was changed and PostgreSQL was not started.
> - **Tree.** Worktree reset to `e56d5e3` ("feat(p3-s5): the purchase and supplier payable include return and reversal AP lines").
> - **What the tree holds:**
>   - migrations `0000`–`0064` (frozen);
>   - `docs/PHASE_3_S5_CONTRACT.md` (S5C), adopted;
>   - the S5 packages and services under `packages/inventory/src/supplier-return*.ts` and `apps/api/src/modules/purchasing/purchase-return*.ts`.
> - **What it does not hold:** S5 migrations. 0065/0066 are being written in parallel. Their shape is taken from S5C §2, cross-checked against the in-progress 0065 draft of the S5 migration writer (read only; it is cited as `0065d:`).
> - **How this contract treats S5.** Every S5 object is stated **as S5C and 0065d define it**. S6 lands only after S5 is accepted and frozen (TL-1).
>
> **Sources, in order of authority:**
> 1. Code and migrations `0000`–`0064`, and 0065d where cited.
> 2. Tests.
> 3. `docs/PHASE_3_ARCHITECTURE_LOCK.md` (L). The lock wins over every other document.
> 4. `docs/PHASE_3_EXECUTION_PLAN.md` §8 and §12–§14 (P).
> 5. `docs/PHASE_3_PREMORTEM.md` (PM), `docs/PHASE_3_SLICE_MAP.md` (SM), `TECHNICAL_DEBT.md` (TD), the open-decision list (OD), `docs/DAFTAR_DATA_MODEL.md` (DM), `docs/DAFTAR_ACCOUNTING_RULES.md` (AR) and `docs/DAFTAR_GOLDEN_REGRESSION_SUITE.md` (GOLD).
>
> **Shape.** It mirrors S5C and `docs/PHASE_3_S4_CONTRACT.md` (S4C):
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

- **Citations.** Every S5C prefix carries forward: `L:`, `P:`, `SM:`, `PM-nn`, `TD-nn`, `DM:`, `S4C:`. S6 adds `S5C:`, `0065d:`, `AR:` and `GOLD-nn`.
- **Ruling classes.** Exactly those of S5C §0:
  - **ENG** binds the implementers.
  - **ENG+TL** binds the implementers until the Tech Lead overrules it (§9.2).
  - **BLOCKER** is used only for:
    - a product-constitution ambiguity;
    - a legal or tax rule;
    - a paid provider;
    - an external credential;
    - a destructive data decision;
    - an architectural contradiction.
- **Carried forward unchanged from S4C/S5C §0:**
  - **SQL refusals** are `'<domain>.<code>: <safe text>'` with `ERRCODE 'P0001'`. They carry no amounts.
  - **The definer contract (G-7):**
    - `SECURITY DEFINER`;
    - `SET search_path = pg_catalog, public, pg_temp`;
    - `REVOKE ALL … FROM PUBLIC` in the same file;
    - no dynamic `EXECUTE`;
    - handover inside a `GRANT/REVOKE CREATE ON SCHEMA public` bracket (P:275-287).
  - **Types:** money is `BIGINT` minor, bounded `±10^18` (0065d R-47). Rates are `NUMERIC(20,10)` with `trunc(rate,10) = rate`.
  - **Encoding.** The `invpl/1` encoding is S4C A-09:
    - `uuid`, `boolean`, signed base-10 `integer`, and `code` (currency lowercase);
    - rate as `inventory_fixed_text(rate, 10)`, `rate_at` as epoch seconds, dates as `YYYYMMDD`;
    - text as eight `inventory_reason_words`, and NULL as `0x00`;
    - framing by `…_count`.
- **The 0063 review hardenings (0063 R-34..R-41), binding on every S6 object (ENG).**
  - **R-34, guards judge INSERT.** Every S6 table has a `BEFORE INSERT OR UPDATE OR DELETE` guard (tgtype 31) that judges the insert as well as refusing change. Its deferred value guard is `AFTER INSERT` (tgtype 5).
  - **R-35, per-command restrictive RLS.** `business_isolation_read` / `_insert` / `_update` / `_delete` are four RESTRICTIVE policies. Only `_read` admits an internal principal by name.
  - **R-36, same-transaction details.** A detail row is inserted only by the transaction that created its header. The header's `created_at = now()` and its `business_transaction_id = inventory_business_transaction_id()`.
  - **R-37, fail closed.** No S6 guard exempts anything on a session GUC. A GUC may only be a further condition that must also hold.
  - **R-38, discovery sees every guard.** `supplier_settlement_guard_gaps()` (§2.3) is the S6 twin of the stock gaps function.
  - **R-40, probes as a non-superuser.** Every 0067-E/0068-E check reads the catalogue (`pg_proc`, `pg_trigger`, `pg_policy`, `pg_class`, `has_*_privilege`). Every mutation probe runs inside a rolled-back block. A probe that re-creates an internal body lends CREATE on `public` inside the block, as 0065d R-40 does.
  - **R-41, no unclassified code.** Every S6 refusal is in §3's table. An unknown code is a typed 500 (`UnclassifiedRefusalError`).
- **Design lessons, binding on every S6 object (ENG), as S5C §0:**
  - **Registry after guards.** Accounting source types are registered after their completeness triggers. Operation kinds are registered last in 0068, after their routines.
  - **Proof before state.** An entry routine does these first, before any purchase, credit, supplier, FX or ledger read:
    - consumes its assertion;
    - takes its document advisory key;
    - decides replay or conflict from the document row.
  - **No clock in a fingerprinted command.** `payment_date`, `allocation_date` and `refund_date` are required, bound client inputs. Every FX instant is derived from them (R-17).
    - `now()` appears only in the "not in the future" comparison, in `created_at`, and in the R-36 same-transaction test.
  - **INVOKER when `current_user` decides**, or when the function must see only what its caller sees. Only the two S5 extension points and the S6 gaps function are INVOKER.
  - **Rule 21: no `round(`.** HALF_EVEN is always `inventory_half_even` (`0060:83`).
- **Header rule numbering.** 0063 used R-15..R-41; S5C and 0065d use R-34..R-38 and R-42..R-47. Those collide with 0063's R-34..R-41, and 0065d disambiguates by prefix ("0063 R-34").
  - **S6 rules start at R-60** and are always cited with their file (`0067 R-60`).
  - The coordinator should ask S5 to cite its own R-34..R-38 as `0065 R-34..` in its acceptance page (TL-15).
- **New refusal domains.** `payment_method.*`, `supplier_payment.*`, `supplier_credit_allocation.*` and `supplier_refund.*`. S6 also adds new codes under `supplier_credit_note.*` and `seam.*`.
- **Frozen history.**
  - `0000`–`0064` are frozen now. 0065/0066 are frozen by the S5 freeze commit **before** 0067 lands (TL-1).
  - S6 edits no earlier migration. Each earlier function it changes is `CREATE OR REPLACE`d in 0067, by its owner:
    - the migrator for `purchase_ap_outstanding(uuid,uuid)` and `purchase_settlement_state(uuid,uuid)` (S5 A-16);
    - `SET LOCAL ROLE daftar_inventory_internal` for `supplier_credit_note_guard()` (S5 TL-13);
    - `SET LOCAL ROLE daftar_accounting_internal` for `accounting_reversals_20_domain_source_guard()`.
  - **Not replaced:** `inventory_stock_source_guard_gaps()`. S6 adds no stock source, so all thirty-five of its S3/S4/S5 digests stay untouched by construction.

---

## 1. Rulings

### A-01 · Slice scope and object inventory (ENG)

**S6 delivers (P:237-251):**
- the payment-method foundation (L:856-879, AL-27);
- supplier payments with allocations across one or more purchases (AL-28);
- supplier credit allocations and supplier refunds, which consume S5 credit notes under AL-31;
- the three accounting source types `supplier_payment`, `supplier_credit_allocation` and `supplier_refund` (L:1048-1050);
- seven `invctl/1` operation kinds (L:1926);
- AL-24's "purchase + payment + allocation in one transaction" as one merchant command.

**Objects:**
- **six tables:** `payment_methods`, `payment_method_names`, `supplier_payments`, `supplier_payment_allocations`, `supplier_credit_allocations`, `supplier_refunds`;
- **one candidate key** on an S5 table;
- **three replaced S5 functions:** two extension points and the credit-note guard;
- **one replaced accounting guard:** the reversal domain guard;
- **inventory-owned guards and helpers** (§2.3);
- **accounting-owned objects:** three completeness triggers and the account-eligibility function (A-14);
- **seven entry routines** (§2.6);
- **one seam extension:** `InventoryAssertionSequence` (A-19).

**S6 does not create:**
- a stock source type, a movement kind, an op→movement mapping, or a bridge. **No S6 command moves stock.**
- any customer-payment object: `payments`, `payment_allocations`, `payment_reversals`, `refunds`, `customer_credits` (MP-7, L:878);
- a payment or allocation reversal command (TL-2);
- an unallocated supplier payment or advance (TL-3);
- a stored balance, outstanding, paid or credit column (AL-26; G-3 as extended, §7.2).

### A-02 · Migration plan: exactly two migrations, 0067 then 0068 (ENG)

| File | Contents, in order |
|---|---|
| `0067_payment_methods_supplier_settlement_sources.sql` | header rules R-60..R-68; the S5 candidate key; the six tables, RLS and grants; the inventory-owned arithmetic, verification functions, guards and triggers; the replaced credit-note guard; the replaced S5 extension points; `supplier_settlement_guard_gaps()`; the accounting objects and the replaced reversal guard; the three accounting registrations (last); 0067-E |
| `0068_supplier_settlement_commands.sql` | the seven entry routines; grants; the seven `inventory_operation_kinds` rows (last); 0068-E |

**Why two, and why this split** (the S4/S5 precedent):
- 0067 makes every S6 table, guard and accounting claim true before any command can write.
- 0068 adds only the writers and their registry rows. So "registry after guards" holds within each file.

**Why the extension points are replaced in 0067, not 0068.** Their new bodies read S6 tables, and the 0067 guards call them. The S5 routines (`purchase_return`, `purchase_reverse`) read them at run time, and both are already live.

### A-03 · Operation kinds: seven, one per command (ENG; the payment-method kinds under `invctl/1` are ENG+TL, TL-4)

| `op_code` | Routine | Permission + scope (application, before minting) |
|---|---|---|
| `payment.create_method` | `payment_method_create` | `accounting.chart.manage`, permission-only (no warehouse) |
| `payment.update_method` | `payment_method_update` | `accounting.chart.manage`, permission-only |
| `payment.deactivate_method` | `payment_method_deactivate` | `accounting.chart.manage`, permission-only |
| `payment.activate_method` | `payment_method_activate` | `accounting.chart.manage`, permission-only |
| `supplier.pay` | `supplier_pay` | `suppliers.pay` + scope over **each allocated purchase's warehouse** (AL-39: every affected warehouse) |
| `supplier.allocate_credit` | `supplier_allocate_credit` | `suppliers.pay` + **business-wide** scope (TL-5) |
| `supplier.receive_refund` | `supplier_receive_refund` | `suppliers.pay` + **business-wide** scope (TL-5) |

- **Grammar.** Each code matches `^[a-z]+(\.[a-z_]+)+$` (`0054:53`). `payment_method.create` would not: the first segment admits no underscore. Hence `payment.<verb>_method`, which is L:1926's `domain.verb[_object]`.
- **Totals.** After S6 the registry holds 26 kinds: S1 3, S3 7, S4 7, S5 2, S6 7.
- **`OPERATION_AUTHORITY`** (`apps/api/src/modules/inventory/inventory-authorization.ts:24`) gains seven rows:
  - the four method kinds are `scope: 'warehouses'` with no warehouse passed (the S4 supplier precedent, TL-4 of S4C);
  - `supplier.pay` is `'warehouses'`;
  - the two credit kinds are `'business_wide'`.

### A-04 · Documents and lifecycles (ENG; no reversal is ENG+TL, TL-2)

| Document | Lifecycle |
|---|---|
| `payment_methods` | `is_active` true ⇄ false. `revision` increments on every change. **Never deleted.** `system_type` is immutable. `posting_account_id` is changeable **only while unused** (A-06) |
| `payment_method_names` | changed only together with a method revision (R-36) |
| `supplier_payments` + allocations | insert-only; fully allocated at creation; immutable |
| `supplier_credit_allocations` | insert-only; immutable |
| `supplier_refunds` | insert-only; immutable |
| `supplier_credit_notes` (S5) | the remaining pair decreases only as a backed AL-31 decrement (A-12). It reaches 0/0 together. It is never deleted |

- **No stored status anywhere.** DM §12 lists `status` on payments and refunds. S6 has no reversal, so a status column would be a constant.
- **No stored `direction`.** The table is the direction: payments go out, refunds come in.
- **No DM `number`.** Display numbering is an S7 concern (S5C A-11(f) precedent).

### A-05 · Accounting source mapping and journal shapes (ENG)

**One entry per allocation.** A payment of k allocations posts k entries. A credit allocation posts one; a refund posts one.
- The `source_id` of each entry is that row's `id`.
- Why one per allocation: per-purchase ledger AP stays joinable through `source_id → purchase_id`. The S5 read (`purchasing-reads.ts`, "ledger AP = `purchase_ap_outstanding`") depends on that. One entry per payment would put several purchases' AP lines under one source.

**Registrations (0067, last in the accounting bracket):**

```sql
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('supplier_payment',           'none', 'not_after_today', 'One allocation of a supplier payment: Dr Accounts Payable / Cr the method''s posting account, realized FX to 4900/6900 (P3-AL-28).', 9),
  ('supplier_credit_allocation', 'none', 'not_after_today', 'A supplier credit applied to a purchase: Dr Accounts Payable / Cr Supplier Receivable, realized FX to 4900/6900 (P3-AL-30/31).', 10),
  ('supplier_refund',            'none', 'not_after_today', 'A supplier credit refunded in money: Dr the method''s posting account / Cr Supplier Receivable, realized FX to 4900/6900 (P3-AL-30/31).', 11);
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'supplier_payment',           'Supplier payment allocation; derived by the payment command.'),
  ('post', 'supplier_credit_allocation', 'Supplier credit allocation; derived by the allocation command.'),
  ('post', 'supplier_refund',            'Supplier refund; derived by the refund command.');
```

- `sort_order` 9–11 follows S5's `supplier_return` at 8 (R-B2a: `purchase_reversal` is not an accounting type).
- `DOMAIN_SOURCE_TYPES` (`packages/accounting/src/post.ts:203`) gains the three. `DOMAIN_REVERSIBLE_SOURCE_TYPES` stays `['purchase']` (TL-2).

**Journal shapes.**
- Every line satisfies the 0043 per-line law. A base-currency line is `rate 1`, `rate_source 'base'`, `txn = base`, `rate_at = entry_date 00:00 UTC` (0065d R-46).
- A line is present only when its amount ≠ 0.
- **Dimensions:** `warehouse_id` is NULL on every line. `branch_id` is taken from the stated purchase's warehouse (`warehouses.branch_id`, possibly NULL; the 0063 AP-line rule at `0063:1576-1585`).

**(a) `supplier_payment`** (one allocation; `entry_date = payment_date`; every line on the purchase's branch):

| # | Account | Side | Txn currency / amount | Rate | Base |
|---|---|---|---|---|---|
| 1 | `accounts_payable` | Dr | purchase currency / `a` (applied) | the purchase snapshot `R` (its source and timestamp) | `conv_R(a)` |
| 2 | `accounts_payable` (dust) | Dr if `ap_dust > 0`, Cr if `< 0` | base / `abs(ap_dust)` | 1 | `abs(ap_dust)` |
| 3 | the payment's `posting_account_id` | Cr | payment currency / `p` (payment amount) | the payment snapshot `Rp` | `pb = conv_Rp(p)` |
| 4 | `fx_loss` if `fx > 0` · `fx_gain` if `fx < 0` | Dr (loss) / Cr (gain) | base / `abs(fx)` | 1 | `abs(fx)` |

The definitions:
- `rel = ap_release(B, T, X, a)`;
- `ap_dust = rel − conv_R(a)`;
- `fx = pb − rel` (AL-28: `payment_base − carrying_released`).

**Balance.** Dr − Cr = `rel + max(fx,0) − pb − max(−fx,0) = rel + fx − pb = 0`.

**(b) `supplier_credit_allocation`** (`entry_date = allocation_date`):
- lines 1, 2 and 5 are on the **target purchase's** branch;
- lines 3 and 4 are on the **note's origin purchase's** branch (`supplier_credit_notes.supplier_return_id → supplier_returns.purchase_id`). That way 1150 nets to 0 per branch at full consumption.

| # | Account | Side | Txn currency / amount | Rate | Base |
|---|---|---|---|---|---|
| 1 | `accounts_payable` | Dr | purchase currency / `a` | purchase `R` | `conv_R(a)` |
| 2 | `accounts_payable` (dust) | Dr if `ap_dust > 0`, Cr if `< 0` | base | 1 | `abs(ap_dust)` |
| 3 | `supplier_receivable` | Cr | note currency / `c` (consumed) | the note snapshot `Rn` | `conv_Rn(c)` |
| 4 | `supplier_receivable` (dust) | Cr if `cr_dust > 0`, Dr if `< 0` | base | 1 | `abs(cr_dust)` |
| 5 | `fx_loss` if `fx > 0` · `fx_gain` if `fx < 0` | Dr / Cr | base | 1 | `abs(fx)` |

The definitions:
- `cr_rel = credit_release(OA, OB, rb, c)`;
- `cr_dust = cr_rel − conv_Rn(c)`;
- `fx = cr_rel − rel`. A positive `fx` means the credit given up was carried above the AP extinguished: a loss.

**Balance.** `rel + max(fx,0) − cr_rel − max(−fx,0) = rel + fx − cr_rel = 0`.

**(c) `supplier_refund`** (`entry_date = refund_date`; every line on the note's origin purchase's branch):

| # | Account | Side | Txn currency / amount | Rate | Base |
|---|---|---|---|---|---|
| 1 | the refund's `posting_account_id` | Dr | receipt currency / `m` | the receipt snapshot `Rr` | `mb = conv_Rr(m)` |
| 2 | `supplier_receivable` | Cr | note currency / `c` | `Rn` | `conv_Rn(c)` |
| 3 | `supplier_receivable` (dust) | Cr if `cr_dust > 0`, Dr if `< 0` | base | 1 | `abs(cr_dust)` |
| 4 | `fx_gain` if `fx > 0` · `fx_loss` if `fx < 0` | Cr (gain) / Dr (loss) | base | 1 | `abs(fx)` |

`fx = mb − cr_rel` (DM §7 refunds: `refund_base − carrying_released`). GOLD-73: CN 100 USD carried at 360, receipt 90 EUR @ 4.10 gives `Dr Bank 369 / Cr 1150 360 / Cr 4900 9`.

**Never** `rounding` (6100) and never `purchase_price_variance` (6200) (AL-28, MP-4). The gate refuses both tokens in 0067/0068 (§7.1), and each completeness trigger admits exactly the lines above.

### A-06 · Payment-method foundation and the account policy (ENG; the policy is ENG+TL, TL-6)

- **Shape.** Exactly L:862-866 and DM §13, plus the S4 master-data bookkeeping (revision, intents, trace, who/when).
- **The account rule, checked by the command and physically:**
  1. **Same business.** The composite FK `(business_id, posting_account_id) → accounts (business_id, id)` enforces it, `ON DELETE RESTRICT`.
  2. **Active, for a new settlement.** Checked at create, at activate, at an account change, and on every payment or refund.
  3. **`accounts.type = 'asset'`** (`0040:98`).
  4. **The explicit command policy AL-27 demands:** `system_key IS NULL` or `system_key ∈ {cash, bank, card_clearing, wallet_clearing, cheque_clearing}`.
     - This admits a merchant's own asset accounts, such as a second bank account.
     - It refuses the engine's non-settlement asset identities: `accounts_receivable` 1100, `supplier_receivable` 1150, `inventory` 1200, and any other asset system key.
     - It is implemented once, in `accounting_settlement_account_eligibility` (A-14(b)), and tested (T-03).
- **Historical identity (L:876):**
  - **No delete, for any role.** There is no route or grant, and `payment_method_guard()` refuses DELETE with `payment_method.not_deletable`.
  - **No silent account change.** `posting_account_id` changes only through `payment.update_method` and only while no `supplier_payments` or `supplier_refunds` row names the method; otherwise `payment_method.posting_account_locked`.
    - The composite FK from `supplier_payments` / `supplier_refunds` to `payment_methods (business_id, id, posting_account_id)` makes a used method's account physically unchangeable.
    - Every payment and refund row also stores the `posting_account_id` it posted to.
  - **Deactivation** changes `is_active` only. Posted entries never reference the method (T-04 proves them byte-identical).
- **`system_type` is immutable.** It states the method's general accounting behaviour (DM §13). A different type is a different method.
- **Names.** At least one of `ar`, `en`, `tr`, each trimmed to 1..100 characters. A missing locale falls back in the read, never in storage.
- **Not seeded.** No business gets a default method from a migration or from provisioning (TL-7).

### A-07 · Supplier payments: fully allocated, one currency, 1..50 purchases (ENG; no advance is ENG+TL, TL-3)

- A payment names:
  - one supplier;
  - one active method;
  - one payment currency `P`;
  - `amount_minor > 0`;
  - `payment_date`;
  - a `reference` when the method `requires_reference`;
  - **1..50 allocations**, each to a distinct received, unreversed purchase **of that supplier**.
- **Fully allocated.** `Σ allocation payment_amount = amount_minor`, checked by the routine and by `supplier_payment_complete()` at COMMIT. There is no unallocated remainder and no supplier advance (TL-3).
- **Two amounts per allocation, never compared across currencies (L:899):**
  - `p` is the payment amount in `P`;
  - `a` is the applied amount in the purchase currency `C`, bounded by the purchase's outstanding `O` in `C`;
  - when `P = C`, `p = a` is required (`supplier_payment.amount_mismatch`);
  - when `P ≠ C`, both are stated by the merchant, and their base difference is realized FX (TL-8).
- **Header base.** `base_amount_minor = Σ pb_i`, never `conv(Σ p_i)`. Each allocation's line 3 must satisfy 0043 on its own.
- **Inactive supplier.** Refused, `supplier_payment.supplier_inactive` (L:1196).

### A-08 · The AP carrying arithmetic, shared with S5 (ENG)

Notation for a purchase: `T = total_txn_minor`, `B = total_base_minor`, `R = source_to_base_rate`. `O = purchase_ap_outstanding(business, purchase)`, with `X = T − O`.

- **AP reducers.** Three kinds of row reduce a purchase's AP:
  - S5 `supplier_returns` (`ap_txn_minor`);
  - S6 `supplier_payment_allocations` (`purchase_amount_applied_minor`);
  - S6 `supplier_credit_allocations` (`purchase_amount_applied_minor`).

  Each stores the `ap_released_before_txn_minor` (X) it was computed from (0065d R-43 for returns).
- **Release.** `ap_release(B, T, X, a) = HALF_EVEN(B·(X+a), T) − HALF_EVEN(B·X, T)`. This is 0065d R-35 exactly (DM §7ج, cumulative proportional).
  - It is ≥ 0.
  - At `X + a = T` the remaining `B` is released **exactly**. So at clearing, AP base is 0 when AP txn is 0 ("realized FX exact at clearing").
- **Conversion.** `conv_R(x) = HALF_EVEN(x·R·10^max(0,e_b−e_t), 10^max(0,e_t−e_b))`, the 0043 law.
- **Dust.** `ap_dust = rel − conv_R(a)`. It is 0 for a domestic purchase (R = 1, B = T).
- **The chain invariant (new, R-62).** Over all reducers of a purchase with amount > 0, ordered by X:
  - each row's X equals the sum of the amounts of the rows before it;
  - `Σ amount ≤ T`.

  It follows that `Σ rel = HALF_EVEN(B·Σ amount, T)`. `purchase_settlement_verify()` (§2.3) proves it at COMMIT on every S6 reducer insert.
  - Two writers that computed from the same O would overlap and are refused at COMMIT, even if a lock were missing.
  - This is the physical half of MP-3/PM-12.
- **S5 compatibility (D-1).** S5 computes a return's X from `purchase_ap_outstanding`, which S6 replaces. So a return after a payment chains correctly with no S5 change. 0065d's value guard reads X from its own column and does not re-derive it from returns (0065d R-43, `0065d:636-651`), so S6 replaces no S5 guard.
- **S5's 1150 path becomes reachable in production.** A return after a payment can exceed O. GOLD-58/59 are re-proved end to end (T-11), not by fixture.
- **Refusals:**
  - `a > O` → `supplier_payment.amount_exceeds_outstanding` / `supplier_credit_allocation.amount_exceeds_outstanding`;
  - `a > 0 ∧ conv_R(a) = 0`, or `p > 0 ∧ pb = 0` → `…amount_below_base_unit` (S5 TL-3 precedent: a line needs base > 0).

### A-09 · Realized FX (ENG; the same-rate sub-unit case is ENG+TL, TL-8)

- Every allocation, credit allocation and refund stores `realized_fx_gain_loss_minor`, signed.
  - Its formula is the table's own: A-05(a) `pb − rel`, (b) `cr_rel − rel`, (c) `mb − cr_rel`.
  - Its account is fixed by table and sign, as the A-05 tables state.
- **It is exact.** It is the difference of two stored integers, each computed once at persistence, with no further rounding.
- **Same currency, same rate** (for example a USD purchase paid in USD on the receipt day). `rel` (cumulative) and `conv_R(a)` may differ by one minor unit.
  - That difference is AP dust (line 2), not FX.
  - `pb = conv_Rp(p)`, and `p = a`, `Rp = R`, give `pb = conv_R(a)`. So `fx = conv_R(a) − rel = −ap_dust`, of absolute value ≤ 1.
  - AL-28 names every `payment_base − carrying_released` difference realized FX, so it posts to 4900/6900 and never to 6100. TL-8 records the sub-unit reading.

### A-10 · Supplier-credit consumption (AL-31) (ENG)

A credit note has `OA = original_amount_minor`, `OB = original_carrying_base_amount_minor`, `r = remaining_amount_minor` and `Rn` (S5 A-11).

- **Remaining carrying, as a function of remaining amount (R-63):**
  ```
  g(r) = 0                                               if r = 0
  g(r) = max(1, OB − HALF_EVEN(OB·(OA − r), OA))         if r > 0
  ```
  - `g(OA) = OB` and `g(0) = 0`, and `g` is non-increasing as `r` falls.
  - The stored `remaining_carrying_base_amount_minor` always equals `g(remaining_amount_minor)`.
  - The `max(1, …)` keeps S5's CHECK `(remaining = 0) = (remaining_carrying = 0)` true for a strong base currency. There, `OB < OA` can make the proportional remainder 0 while `r > 0`.
- **Release.** `credit_release(OA, OB, rb, c) = g(rb) − g(rb − c)`, where `rb` is the remaining amount before the consumer.
  - **Partial:** a cumulative proportional share, rounded once (L:944, DM §7ج).
  - **Final** (`rb = c`): `g(rb)`, i.e. the entire remaining residue (L:945). No dust is ever stranded (INV-ACC-17).
- **GOLD-84:** `OA = 10000` (100.00 USD), `OB = 36000` (360.00). Consuming 6000 gives `g(4000) = 36000 − HE(36000·6000/10000) = 14400`, so the release is 21600 (216.00) and 144.00 remains. The final 4000 releases 14400.
- **Line dust.** `cr_dust = cr_rel − conv_Rn(c)`, a base-currency 1150 line (A-05). `c > 0 ∧ conv_Rn(c) = 0` → `…amount_below_base_unit` (TL-9 records the stranding case this can create).
- **Same currency.** For an allocation, when the note currency = the purchase currency, `c = a` (`supplier_credit_allocation.amount_mismatch`). For a refund, when the receipt currency = the note currency, `m = c` (`supplier_refund.amount_mismatch`).
- **Chain invariant (R-63).** Over all consumers of a note (credit allocations ∪ refunds), ordered by `rb` descending:
  - each `rb` equals `OA − Σ` of the earlier consumptions;
  - the note's stored remaining equals `OA − Σ c`;
  - the stored remaining carrying equals `g(OA − Σ c)`;
  - `Σ cr_rel = OB − g(remaining)`.

  `supplier_credit_note_verify()` proves it at COMMIT. It is PM-15's detection query made a guard.

### A-11 · Concurrency and the lock order R-60 (ENG)

**R-60, the global lock order extended** (never reordered). Every S6 path skips the steps it does not use:

```
1   assertion consume                                       (no lock)
2   the per-document advisory key                           ('daftar.payment_method_id' | 'daftar.supplier_payment_id' |
                                                             'daftar.supplier_credit_allocation_id' | 'daftar.supplier_refund_id')
2a  purchases FOR UPDATE, in id order                        (supplier.pay: every allocated purchase; allocate_credit: the target)
2a' supplier_credit_notes FOR UPDATE                         (allocate_credit, receive_refund)
2b  the supplier FOR SHARE                                   (the three settlement commands)
2c  the payment method FOR SHARE                             (supplier.pay, receive_refund)   |  FOR UPDATE (the four method commands, at step 2's row)
3-6 (not used by S6)
7   accounting_post_entry, one per allocation / credit allocation / refund, in line order
```

- **Against S4/S5.** A receipt, return or reversal takes its own key, then the purchase row (S4 R-15, S5 R-34). S6 takes its own key, then purchase rows in id order. No S4/S5 path locks a credit note or a payment method, so 2a'/2c add no cycle.
- **MP-3 / PM-12 (L:900).** Every S6 AP reducer and every S5 return lock the purchase row `FOR UPDATE` before reading `O`. So "`a ≤ O`" and the insert happen inside one lock.
  - The payment row needs no second lock: it is created by this very command and fully allocated before COMMIT.
  - The chain guard (A-08) is the physical proof at COMMIT.
- **MP-6 / PM-15 (L:944-947).** Every consumer locks the note `FOR UPDATE` once. It then reads `r`, checks `c ≤ r`, inserts its row and decrements both values in one `UPDATE`.
- **AL-24 ordering.** The combined command takes a receipt key and then a payment key, which would invert 2 → 2. So the seam callback's **first statement** takes `pg_advisory_xact_lock(hashtext('daftar.supplier_payment_id'), hashtext(payment_id))`, before `purchase_receive` takes `'daftar.purchase_id'`.
  - A concurrent standalone `supplier.pay` with the same payment id then waits on the payment key before touching the purchase row.
  - Re-taking the key inside `supplier_pay` is re-entrant.

### A-12 · The credit-note guard, replaced by its owner (ENG; S5 TL-13)

`supplier_credit_note_guard()` is replaced under `SET LOCAL ROLE daftar_inventory_internal`. Its trigger `supplier_credit_notes_immutable` (tgtype 27, no `WHEN`, `0065d:892`) is unchanged.

- **DELETE** is refused with `supplier_credit_note.immutable`, as in S5.
- **UPDATE is admitted only when every one of these holds.** Otherwise it raises `supplier_credit_note.immutable`, the S5 code, so S5 T-15's naked-update cases stay green:
  1. Every column except `remaining_amount_minor` and `remaining_carrying_base_amount_minor` `IS NOT DISTINCT FROM` its old value.
  2. `NEW.remaining_amount_minor < OLD.remaining_amount_minor`.
  3. `NEW.remaining_carrying_base_amount_minor = g(NEW.remaining_amount_minor)` (A-10).
  4. **The backing consumer exists already.** Exactly one `supplier_credit_allocations` or `supplier_refunds` row has:
     - `credit_note_id = OLD.id`;
     - `credit_remaining_before_minor = OLD.remaining_amount_minor`;
     - consumed `= OLD.remaining − NEW.remaining`;
     - carrying released `= OLD.remaining_carrying − NEW.remaining_carrying`;
     - `created_at = now()`;
     - `business_transaction_id = inventory_business_transaction_id()` (R-36).

     The routine therefore inserts the consumer **before** the `UPDATE` (§2.6).
- **Why definer is correct here.** The guard admits by **data**, the backing row, not by role (S5C A-15(b) reasoning).
- **Column privilege.** Only `daftar_inventory_internal` holds `UPDATE (remaining_amount_minor, remaining_carrying_base_amount_minor)` (§2.8). `daftar_app` holds none.
- **The deferred aggregate check.** It is `supplier_credit_note_verify()`, called by both consumers' value guards (A-10).

### A-13 · The two S5 extension points, replaced (ENG; S5 A-16, TL-9)

Both are replaced by the migrator in 0067. Each stays migrator-owned, `SECURITY INVOKER`, `STABLE` and pinned, with the same signature and the same ACL (EXECUTE to `daftar_app` and `daftar_inventory_internal`).

| Function | S6 body |
|---|---|
| `purchase_ap_outstanding(p_business_id UUID, p_purchase_id UUID) RETURNS BIGINT` | **The S5 body with exactly two more subtraction terms:** `− coalesce(Σ supplier_payment_allocations.purchase_amount_applied_minor, 0) − coalesce(Σ supplier_credit_allocations.purchase_amount_applied_minor, 0)` over the purchase. Every other clause (not received ⇒ 0, visibility) is kept byte-for-byte |
| `purchase_settlement_state(p_business_id UUID, p_purchase_id UUID, OUT payment_allocated BOOLEAN, OUT credit_allocated BOOLEAN)` | `payment_allocated := EXISTS (supplier_payment_allocations of the purchase)`; `credit_allocated := EXISTS (supplier_credit_allocations of the purchase)` |

- **Effect on S5 without touching S5:**
  - `purchase_return` measures AP-first against settled AP;
  - `purchase_reverse` refuses a settled purchase with `purchase_reversal.payment_allocated` / `purchase_reversal.credit_allocated` (S5 A-09(a)(b)).
- **Physical twin of S5 A-09(a)(b).** `purchase_reversals_unsettled` is a new deferred AFTER INSERT trigger (tgtype 5) on the S5 table `purchase_reversals`, calling `purchase_reversal_unsettled()` (internal definer). It raises the same two S5 codes at COMMIT.
  - In the other direction, each S6 value guard refuses a reducer for a reversed purchase (`supplier_payment.purchase_reversed`, `supplier_credit_allocation.purchase_reversed`).
- The S6 gate requires both replacements (S5 TL-9).

### A-14 · Accounting-side objects in 0067 (ENG)

Every function below is owned by `daftar_accounting_internal`: definer, pinned, PUBLIC revoked, inside the accounting CREATE bracket.

**(a) Three completeness functions and triggers:**
- `accounting_supplier_payment_entry_complete()` on `journal_entries_supplier_payment_complete`;
- `accounting_supplier_credit_allocation_entry_complete()` on `journal_entries_supplier_credit_allocation_complete`;
- `accounting_supplier_refund_entry_complete()` on `journal_entries_supplier_refund_complete`.

Each trigger is `AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type = '<type>')`. The `WHEN` keeps Budget A (S3C A-26).

At COMMIT each requires:
- exactly one source row with `binding_source_id = NEW.source_id`;
- `entry_date` = that row's date;
- **exactly** the A-05 lines for that row's stored amounts, and no other line. Each line is checked for account (the stored `posting_account_id`, or the system key), side, txn currency and amount, rate, `rate_source`, `rate_at`, base amount and dimensions.

Otherwise it raises `accounting.inventory_detail_missing` or `accounting.inventory_entry_mismatch` (the S4 codes).

**(b) `accounting_settlement_account_eligibility(p_business_id UUID, p_account_id UUID) RETURNS TEXT`.**
- `STABLE`.
- It refuses unless `p_business_id = app.business_id` (`accounting.scope_mismatch`, the `accounting_purchase_fx_rate` precedent).
- It returns one of `'eligible'`, `'not_found'`, `'inactive'`, `'not_asset'`, `'not_settlement'` for the A-06 policy, checked in that order.
- `EXECUTE` goes to `daftar_inventory_internal` only. The inventory principal has no `SELECT` on `accounts` and gains none.

**(c) `accounting_reversals_20_domain_source_guard()`, replaced by its owner** under `SET LOCAL ROLE daftar_accounting_internal`.
- It is byte-identical to 0065's body except for the always-refused `IN` list, which becomes `('inventory_adjustment', 'inventory_opening', 'negative_inventory_cost_adjustment', 'supplier_return', 'supplier_payment', 'supplier_credit_allocation', 'supplier_refund')`.
- The `purchase` pairing clause and the R-13 opening-balance block are kept verbatim.
- **Effect.** No S6 entry can be undone by a generic Phase 2 reversal (PM-16's rule for domain-owned entries; TL-2).

**(d) Accounting reads of S6 documents.**
- `GRANT SELECT ON supplier_payments, supplier_payment_allocations, supplier_credit_allocations, supplier_refunds, supplier_credit_notes TO daftar_accounting_internal`.
- Each table gets `accounting_validator FOR SELECT TO daftar_accounting_internal USING (true)`, and its `business_isolation_read` admits `'daftar_accounting_internal'`.
- For the S5 table `supplier_credit_notes` this is an `ALTER POLICY business_isolation_read … USING (app_bypass() OR current_user IN ('daftar_inventory_internal','daftar_accounting_internal') OR business_id = …)`, plus the new `accounting_validator` policy. It is needed for the 1150 lines' rate snapshot and branch.

### A-15 · Bound, pre-computed amounts; optimistic commands (ENG, S4C A-07 / S5C A-07 carried forward)

**The service computes every derived value before minting.** It reads through `daftar_app` under RLS and calls:
- `purchase_ap_outstanding` (the one definition, A-13);
- the purchase snapshot;
- the note;
- `accounting_fx_rate_lookup`, through the accepted accounting read path.

It computes with `@daftar/inventory`'s `supplier-settlement.ts`, which is byte-equivalent to the SQL through shared vectors (§4.1). It binds the results into the payload:
- the rate, source, `rate_at` and rate id;
- the bases, X and releases;
- the dust and FX.

**The routine recomputes each value under its locks.** Any difference raises one of:
- `supplier_payment.settlement_changed`;
- `supplier_credit_allocation.settlement_changed`;
- `supplier_refund.settlement_changed`;
- `….fx_rate_changed`.

Each is 409 and retryable. A concurrent settlement moved `O` or `r`, or a rate was stated in the meantime.

**The FX snapshot of a payment or refund.**
- **Foreign:** `accounting_purchase_fx_rate(business, currency, ((date + 1)::timestamp AT TIME ZONE businesses.timezone) − interval '1 second')` (R-17). `rate_at` is the rate's `effective_at`.
- **Domestic:** rate 1, `'base'`, `rate_at = date 00:00 UTC`, `fx_rate_id` NULL. This is exactly `0064:1262-1278`.
- The function is generic in currency, so S6 reuses it unchanged.

**The credit side uses the note's stored snapshot** (`Rn`, its source and timestamp) and never a new lookup (L:830-841: a historical rate is never re-read).

### A-16 · `invpl/1` field lists and idempotency (ENG; the encoding is S4C A-09)

Allocations are in `line_no` order. `w1..w8` are the eight `inventory_reason_words` of a text, or eight NULLs for NULL.

| `op_code` | Fields, in order |
|---|---|
| `payment.create_method` | `payment_method_id` uuid · `system_type` code · `posting_account_id` uuid · `requires_reference` boolean · `sort_order` int · `name_ar_w1..w8` · `name_en_w1..w8` · `name_tr_w1..w8` |
| `payment.update_method` | `payment_method_id` uuid · `expected_revision` int · `posting_account_id` uuid · `requires_reference` boolean · `sort_order` int · `name_ar_w1..w8` · `name_en_w1..w8` · `name_tr_w1..w8` |
| `payment.deactivate_method` · `payment.activate_method` | `payment_method_id` uuid · `expected_revision` int |
| `supplier.pay` | `payment_id` uuid · `supplier_id` uuid · `payment_method_id` uuid · `posting_account_id` uuid · `payment_date` int · `currency` code · `amount` int · `rate_id` uuid or NULL · `rate` R10 · `rate_source` code · `rate_at` int · `base_amount` int · `reference_w1..w8` · `allocation_count` int · per allocation: `allocation_id` uuid, `purchase_id` uuid, `warehouse_id` uuid (the scope target, AL-39), `purchase_currency` code, `payment_amount` int, `payment_base` int, `applied` int, `released_before` int, `carrying_released` int, `ap_dust` int (signed), `realized` int (signed) |
| `supplier.allocate_credit` | `allocation_id` uuid · `credit_note_id` uuid · `purchase_id` uuid · `warehouse_id` uuid · `allocation_date` int · `credit_currency` code · `consumed` int · `remaining_before` int · `credit_released` int · `credit_dust` int (signed) · `purchase_currency` code · `applied` int · `ap_released_before` int · `ap_released` int · `ap_dust` int (signed) · `realized` int (signed) |
| `supplier.receive_refund` | `refund_id` uuid · `credit_note_id` uuid · `payment_method_id` uuid · `posting_account_id` uuid · `refund_date` int · `source_currency` code · `consumed` int · `remaining_before` int · `source_released` int · `source_dust` int (signed) · `receipt_currency` code · `receipt_amount` int · `rate_id` uuid or NULL · `rate` R10 · `rate_source` code · `rate_at` int · `receipt_base` int · `realized` int (signed) · `reference_w1..w8` |

**Intent digests.**
- **The four method kinds** use the payload digest itself (component 7) as the intent, stored in `create_intent_sha256` / `last_intent_sha256`. This is the S4 supplier pattern (`0064:384`). Every field is client intent.
- **The three settlement kinds** use `inventory_payload_digest('<op>', tenant, business, types, values)` over the client-intent fields only:

| Command | Intent fields | Stored in |
|---|---|---|
| `supplier.pay` | `payment_id`, `supplier_id`, `payment_method_id`, `payment_date`, `currency`, `amount`, `reference_w1..w8`, `allocation_count`, per allocation `allocation_id`, `purchase_id`, `payment_amount`, `applied` | `supplier_payments.intent_sha256` |
| `supplier.allocate_credit` | `allocation_id`, `credit_note_id`, `purchase_id`, `allocation_date`, `consumed`, `applied` | `supplier_credit_allocations.intent_sha256` |
| `supplier.receive_refund` | `refund_id`, `credit_note_id`, `payment_method_id`, `refund_date`, `consumed`, `receipt_currency`, `receipt_amount`, `reference_w1..w8` | `supplier_refunds.intent_sha256` |

**Identity.**
- Every id (`payment_id`, `allocation_id`, `refund_id`, `payment_method_id`) is a client-supplied canonical UUID. It is the idempotency key: `PRIMARY KEY (business_id, id)` is DM §12's `UNIQUE (business_id, idempotency_key)`, per the S4/S5 precedent (TL-10).
- The allocation id is the accounting `source_id` of its entry.

**Application order** (S4C A-10(c)):
- The service first reads the document by id through `daftar_app`:
  - replay ⇒ the stored result;
  - a different intent ⇒ `….idempotency_conflict`.
- Only then does it authorize, read state, compute, mint and open the seam.

**A replay answers from stored rows only:** the header, the allocations, and the entry ids through `accounting_source_bindings`.

### A-17 · Grant and ACL matrix produced by S6 (ENG)

| Principal | Gains |
|---|---|
| `daftar_app` | `SELECT` on the six S6 tables; `EXECUTE` on the seven entry routines. **No DML anywhere** |
| `daftar_inventory_internal` | `INSERT, SELECT` on the six tables; `UPDATE (posting_account_id, is_active, requires_reference, sort_order, revision, last_intent_sha256, business_transaction_id, updated_by, updated_at)` on `payment_methods`; `UPDATE (display_name)` and `DELETE` on `payment_method_names`; `UPDATE (remaining_amount_minor, remaining_carrying_base_amount_minor)` on `supplier_credit_notes`; `EXECUTE` on `accounting_settlement_account_eligibility(uuid,uuid)` |
| `daftar_accounting_internal` | `SELECT` on `supplier_payments`, `supplier_payment_allocations`, `supplier_credit_allocations`, `supplier_refunds`, `supplier_credit_notes` (A-14(d)) |
| any other role | nothing |

- Every `UPDATE`/`DELETE` the internal principal holds is judged by a tgtype-31 or tgtype-27 guard.
- No role holds `UPDATE` or `DELETE` on the four settlement tables.

### A-18 · Routes, DTOs and reads (ENG)

| Route | Permission + scope | Body / result |
|---|---|---|
| `POST /v1/payment-methods` | `accounting.chart.manage` | `{ paymentMethodId, systemType, postingAccountId, requiresReference, sortOrder, names: { ar?, en?, tr? } }` → the method, `replayed` |
| `PUT /v1/payment-methods/:paymentMethodId` | same | `{ expectedRevision, postingAccountId, requiresReference, sortOrder, names }` |
| `POST /v1/payment-methods/:paymentMethodId/deactivate` · `/activate` | same | `{ expectedRevision }` |
| `GET /v1/payment-methods` · `GET /v1/payment-methods/:id` | `suppliers.pay` **or** `accounting.view` **or** `accounting.chart.manage` | stored rows and names. `postingAccountId` is present only for `accounting.view` / `accounting.chart.manage` |
| `POST /v1/supplier-payments` | `suppliers.pay` + each allocated purchase's warehouse | `{ paymentId, supplierId, paymentMethodId, currencyCode, amountMinor, paymentDate, reference?, allocations: [{ allocationId, purchaseId, paymentAmountMinor, purchaseAmountAppliedMinor }] }` (1..50) → the stored payment, allocations, entry ids, `replayed` |
| `POST /v1/supplier-credit-allocations` | `suppliers.pay` + business-wide | `{ allocationId, creditNoteId, purchaseId, allocationDate, creditAmountMinor, purchaseAmountAppliedMinor }` |
| `POST /v1/supplier-refunds` | `suppliers.pay` + business-wide | `{ refundId, creditNoteId, paymentMethodId, refundDate, creditAmountMinor, receiptCurrencyCode, receiptAmountMinor, reference? }` |
| `POST /v1/purchases/:purchaseId/receive-and-pay` | `purchases.receive` **and** `suppliers.pay`, each + the purchase warehouse | the S4 receive body + `payment: { paymentId, allocationId, paymentMethodId, currencyCode, amountMinor, purchaseAmountAppliedMinor?, reference? }`; `payment_date = documentDate` (A-19) |
| `GET /v1/supplier-payments/:paymentId` · `GET /v1/suppliers/:supplierId/payments` · `GET /v1/purchases/:purchaseId/settlements` | `suppliers.view` + the purchases' warehouses (or business-wide for the supplier list, the S5 A-19 precedent) | stored rows |

**Reads extend S4/S5 A-19 and stay live-derived** (AL-26, L:851):
- **The ledger-derived AP of a purchase** (`purchasing-reads.ts`, `GET …/payable`) adds the AP lines of `supplier_payment` and `supplier_credit_allocation` entries, joined through their row's `purchase_id`.
  - The txn outstanding reads only AP lines in the purchase currency. The base-currency dust lines move base only.
  - The read asserts ledger AP = `purchase_ap_outstanding` and ledger base AP = `B − Σ rel` (T-19).
- **The derived supplier credit** (`GET /v1/suppliers/:id/credit-notes`, S5) reads `remaining_*` as stored. Equivalently, `Σ notes − Σ credit allocations − Σ refunds` (L:849), and T-19 asserts the two agree.
- **Supplier AP** is L:848's derivation, read live. There is no cache and no summary table.

### A-19 · AL-24: receive and pay in one command, and the inventory-assertion sequence (ENG+TL, TL-11)

**The command.**
- `POST /v1/purchases/:purchaseId/receive-and-pay` is one merchant operation, with one `business_transaction_id` and one transaction.
- It performs three facts (L:817-821):
  - the S4 receipt, **unchanged**: `purchase_receive`, which posts `purchase` and, when present, `negative_inventory_cost_adjustment`;
  - a supplier payment with **one** allocation to this purchase, through `supplier_pay`, which posts `supplier_payment`.
- **Identical purchase entry.** The purchase entry is identical to a credit purchase's (PM-22).

**The binding of the payment half.**
- `payment_date = document_date`. `X = 0`, and `O = T` of the receipt plan.
- `PurchaseReceiptService` is split into `plan(…)` and `execute(tx, plan)`. The combined service binds `T`, `B` and `R` from the receipt plan without a second read.
- `a ≤ T`: a partial immediate payment is allowed.

**Authority.**
- Two authorities are established: `purchase.receive` and `supplier.pay`, each over the purchase warehouse.
- Two inventory assertions are minted, and `k` accounting assertions: `purchase`, (`negative_inventory_cost_adjustment`), `supplier_payment`.

**The seam extension (sibling of R-B1, in `apps/api/src/infra/database.ts`):**
- `withBusinessInventoryAccountingTransaction(scope, inventoryAssertions: InventoryAssertions, accountingAssertions, fn)`, where `InventoryAssertions = string | readonly [string, ...string[]]`. A string, or a one-element tuple, is exactly today's seam.
- **`InventoryAssertionSequence.plan(scope, inventoryAssertions)`** checks every element for coherence (tenant/business claims, `assertInventoryAssertionCoheres`) before any connection is taken. It refuses:
  - a duplicate (`seam.inventory_assertion_malformed`);
  - an empty tuple (`seam.inventory_assertion_missing`).

  With two or more, `app.inventory_assertion` starts **empty**.
- **`presentInventoryAssertion(tx, opCode)`** sets `app.inventory_assertion` (transaction-locally) to the next element. That element's operation claim (component 6, `:` → `.`) must equal `opCode`. Otherwise:
  - `seam.inventory_assertion_operation_mismatch`;
  - `seam.inventory_assertion_exhausted` after the last.
- **`assertComplete()` at commit is strict.** Every element must have been presented, else `seam.inventory_assertion_unused` and rollback.
  - Unlike accounting postings, every entry routine consumes its assertion even on replay, so presenting none is never legitimate.
- **Fail-closed.** A routine called without presenting sees an empty or foreign GUC and is refused by the database: `inventory.assertion_missing` / `inventory.assertion_wrong_operation`.
- **Why the swap is safe.** `inventory_assertion_current` is called only by helpers **inside** an entry routine (`0064:89,178,308`). No deferred guard reads `app.inventory_assertion`. So swapping it between routines cannot weaken a check.
- **Replay.** If the purchase is `received` and the payment row exists with an equal intent, it is a full replay without opening the seam. If the purchase is received and no such payment exists, it is refused `purchase.state_invalid` (409): the receipt belongs to another command.

### A-20 · Audit and outbox (ENG, S4C A-21 pattern)

Each routine writes one audit row and one outbox event in its transaction, carrying ids only and never an amount:
- `payment_method.created`, `.updated`, `.deactivated`, `.activated`;
- `supplier.paid` (payment id, supplier id, allocation ids);
- `supplier.credit_allocated` (allocation id, note id, purchase id);
- `supplier.refund_received` (refund id, note id).

The `business_transaction_id` is in `metadata` / `payload` (L:1060).

### A-21 · The tax boundary — OD-03 (ENG, **BLOCKED BY OD-03 beyond the zero case**)

- Every purchase has `tax_minor = 0` (`purchases_tax_policy_absent_ck`). No S6 table has a tax column, no DTO accepts one, and no entry has a `tax_payable` line.
- **Designed nowhere, and each BLOCKED BY OD-03:**
  - withholding tax on a supplier payment;
  - tax on a refund;
  - tax-inclusive settlement.
- The gate refuses a `tax_payable` token and any column matching `tax` in 0067/0068 (§7.1).

### A-22 · What S6 does not change (ENG)

**Untouched:**
- every S3/S4 routine and guard body;
- every S5 routine and every S5 guard body except `supplier_credit_note_guard()` (A-12);
- `stock_*` tables and registries;
- `inventory_stock_source_guard_gaps()`;
- `accounting_post_entry`, `accounting_post_reversal`, the FX registry, `accounts`, the permissions and roles, and `bootstrap.sql`.

**S6 creates** no role, no membership and no `BYPASSRLS`.

**The only replaced functions** are the four of §0 (Frozen history). The only altered S5 objects are:
- one candidate key: `supplier_credit_notes_supplier_uq UNIQUE (business_id, id, supplier_id)`, which cannot fail on valid data because it contains the PK;
- one policy: `supplier_credit_notes.business_isolation_read`;
- one new trigger on `purchase_reversals` (A-13).

`supplier_credit_notes` gains no trigger: the replaced guard keeps its S5 trigger.

---

## 2. Database contract

### 2.1 Migration 0067 order (normative)

1. **Header rules:**
   - R-60 the lock order (A-11);
   - R-61 AP carrying (A-08);
   - R-62 the purchase chain (A-08);
   - R-63 credit consumption and its chain (A-10);
   - R-64 realized FX (A-05, A-09);
   - R-65 the account policy (A-06);
   - R-66 the credit-note guard (A-12);
   - R-67 the extension points (A-13);
   - R-68 the reversal guard (A-14(c)).

   Then the 0063 R-34..R-41 carry-forward block, as 0065d does.
2. **The S5 candidate key:** `ALTER TABLE supplier_credit_notes ADD CONSTRAINT supplier_credit_notes_supplier_uq UNIQUE (business_id, id, supplier_id)`.
3. **The six tables** (§2.2), with ENABLE + FORCE RLS, the policies (§2.7) and the grants (A-17).
4. **The inventory bracket** (`GRANT CREATE ON SCHEMA public TO daftar_inventory_internal` … `REVOKE`):
   - (a) the arithmetic functions;
   - (b) the two verify helpers;
   - (c) the guard functions;
   - (d) `ALTER FUNCTION … OWNER TO daftar_inventory_internal` for each;
   - (e) under `SET LOCAL ROLE daftar_inventory_internal`, `CREATE OR REPLACE FUNCTION supplier_credit_note_guard()` (A-12), then `RESET ROLE`.
5. **The triggers** (§2.3).
6. **The replaced extension points** (A-13), migrator-owned, ACL unchanged. **Then `supplier_settlement_guard_gaps()`.**
7. **The accounting bracket:**
   - `accounting_settlement_account_eligibility`;
   - the three completeness functions and triggers;
   - `ALTER POLICY` plus the `accounting_validator` policies and grants (A-14(d));
   - under `SET LOCAL ROLE daftar_accounting_internal`, the replaced reversal guard.

   **Then the three accounting registrations** (A-05, last).
8. **0067-E** (§2.9).

### 2.2 Tables

**Common to every table:**
- it starts with `tenant_id, business_id`;
- the composite tenant FK `(tenant_id, business_id) → businesses (tenant_id, id)`;
- `PRIMARY KEY (business_id, id)` unless stated;
- `REVOKE ALL … FROM PUBLIC`.

**Every column is `NOT NULL` unless marked `?`.** Amount bounds are as §0.

**Naming (G-3 as extended, §7.2):**
- no column is named or contains `balance`, `outstanding`, `paid`, `unpaid`, `due`, `owed`, `payable` or `settled`;
- `remaining_*`, `ap_*`, `*_applied_*` and `*_released_*` are allowed.

**`payment_methods`**

| Column | Type / rule |
|---|---|
| `id` | UUID |
| `system_type` | TEXT, `CHECK (system_type IN ('cash','card','bank_transfer','wallet','cheque','other'))` |
| `posting_account_id` | UUID |
| `is_active` | BOOLEAN |
| `requires_reference` | BOOLEAN |
| `sort_order` | INTEGER, `CHECK (sort_order BETWEEN 0 AND 10000)` |
| `revision` | INTEGER, ≥ 1 |
| `create_intent_sha256`, `last_intent_sha256` | TEXT, `~ '^[0-9a-f]{64}$'` |
| `business_transaction_id` | UUID |
| `created_by`, `updated_by` | UUID → `users` |
| `created_at`, `updated_at` | TIMESTAMPTZ, `DEFAULT now()` |

Keys and constraints:
- `payment_methods_account_fk FOREIGN KEY (business_id, posting_account_id) REFERENCES accounts (business_id, id) ON DELETE RESTRICT`;
- `payment_methods_account_uq UNIQUE (business_id, id, posting_account_id)`;
- index `(business_id, sort_order)`.

**`payment_method_names`**
- **Columns:**
  - `payment_method_id` UUID;
  - `locale` TEXT `CHECK (locale IN ('ar','en','tr'))`;
  - `display_name` TEXT `CHECK (char_length BETWEEN 1 AND 100 AND display_name = btrim(display_name))`.
- **Keys:**
  - `PRIMARY KEY (business_id, payment_method_id, locale)`;
  - FK `(business_id, payment_method_id) → payment_methods (business_id, id) ON DELETE RESTRICT`.

**`supplier_payments`** (the header; it posts nothing itself)

| Column | Type / rule |
|---|---|
| `id`, `supplier_id`, `payment_method_id`, `posting_account_id` | UUID |
| `currency_code` | CHAR(3) → `currencies` |
| `amount_minor` | BIGINT 1..10^18 |
| `payment_to_base_rate` | NUMERIC(20,10), > 0, `trunc(·,10) = ·` |
| `rate_source` | TEXT `IN ('base','manual')` |
| `rate_timestamp` | TIMESTAMPTZ, `= date_trunc('second', ·)` |
| `fx_rate_id?` | UUID |
| `base_amount_minor` | BIGINT 1..10^18 |
| `payment_date` | DATE |
| `reference?` | TEXT, 1..100, trimmed |
| `allocation_count` | INTEGER 1..50 |
| `intent_sha256` | TEXT hex64 |
| `business_transaction_id`, `created_by`, `created_at` | as S5 |

Keys and constraints:
- `supplier_payments_rate_ck CHECK ((rate_source = 'base') = (fx_rate_id IS NULL AND payment_to_base_rate = 1))`;
- FK `(business_id, supplier_id) → suppliers` RESTRICT;
- FK `(business_id, payment_method_id, posting_account_id) → payment_methods (business_id, id, posting_account_id)` RESTRICT;
- FK `(business_id, fx_rate_id) → accounting_fx_rates (business_id, id)` RESTRICT;
- `supplier_payments_identity_uq UNIQUE (business_id, id, supplier_id, currency_code)`;
- index `(business_id, supplier_id)`.

**`supplier_payment_allocations`** (the `supplier_payment` accounting source)

| Column | Type / rule |
|---|---|
| `id`, `payment_id`, `supplier_id`, `purchase_id` | UUID |
| `line_no` | INTEGER 1..50 |
| `payment_currency` | CHAR(3) |
| `payment_amount_minor` | 1..10^18 |
| `payment_to_base_rate` | NUMERIC(20,10) |
| `payment_base_amount_minor` | 1..10^18 |
| `purchase_currency` | CHAR(3) |
| `purchase_amount_applied_minor` | 1..10^18 |
| `purchase_historical_to_base_rate` | NUMERIC(20,10) |
| `ap_released_before_txn_minor` | 0..10^18 |
| `purchase_carrying_base_released_minor` | 0..10^18 |
| `ap_dust_base_minor` | signed |
| `realized_fx_gain_loss_minor` | signed |
| `created_at` | TIMESTAMPTZ `DEFAULT now()` |
| `accounting_source_type` | `GENERATED ALWAYS AS ('supplier_payment') STORED` |
| `binding_source_id` | UUID |

Keys and constraints:
- FK `(business_id, payment_id, supplier_id, payment_currency) → supplier_payments (business_id, id, supplier_id, currency_code)` RESTRICT;
- FK `(business_id, purchase_id, supplier_id) → purchases (business_id, id, supplier_id)` (S5's `purchases_supplier_uq`) RESTRICT;
- `UNIQUE (business_id, payment_id, line_no)` and `UNIQUE (business_id, payment_id, purchase_id)`;
- `CHECK (realized_fx_gain_loss_minor = payment_base_amount_minor − purchase_carrying_base_released_minor)`;
- `CHECK (payment_currency <> purchase_currency OR payment_amount_minor = purchase_amount_applied_minor)`;
- `CHECK (binding_source_id = id)`;
- deferred FK `(business_id, accounting_source_type, binding_source_id) → accounting_source_bindings (business_id, source_type, source_id)`;
- index `(business_id, purchase_id)`.

**`supplier_credit_allocations`** (the `supplier_credit_allocation` accounting source)

| Column | Type / rule |
|---|---|
| `id`, `supplier_id`, `credit_note_id`, `purchase_id` | UUID |
| `allocation_date` | DATE |
| `credit_currency` | CHAR(3) |
| `credit_amount_consumed_minor` | 1..10^18 |
| `credit_to_base_rate` | NUMERIC(20,10) |
| `credit_remaining_before_minor` | 1..10^18 |
| `credit_carrying_base_released_minor` | 0..10^18 |
| `credit_dust_base_minor` | signed |
| `purchase_currency` | CHAR(3) |
| `purchase_amount_applied_minor` | 1..10^18 |
| `purchase_historical_to_base_rate` | NUMERIC(20,10) |
| `ap_released_before_txn_minor` | 0..10^18 |
| `purchase_carrying_base_released_minor` | 0..10^18 |
| `ap_dust_base_minor` | signed |
| `realized_fx_gain_loss_minor` | signed |
| `intent_sha256`, `business_transaction_id`, `created_by`, `created_at` | as S5 |
| `accounting_source_type` | `GENERATED ALWAYS AS ('supplier_credit_allocation') STORED` |
| `binding_source_id` | UUID |

Keys and constraints:
- FK `(business_id, credit_note_id, supplier_id) → supplier_credit_notes (business_id, id, supplier_id)` (the new key) RESTRICT;
- FK `(business_id, purchase_id, supplier_id) → purchases (business_id, id, supplier_id)` RESTRICT;
- `CHECK (credit_amount_consumed_minor <= credit_remaining_before_minor)`;
- `CHECK (realized_fx_gain_loss_minor = credit_carrying_base_released_minor − purchase_carrying_base_released_minor)`;
- `CHECK (credit_currency <> purchase_currency OR credit_amount_consumed_minor = purchase_amount_applied_minor)`;
- `CHECK (binding_source_id = id)` and the deferred binding FK;
- `UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)`: one consumer per remaining level of a note, among allocations;
- indexes `(business_id, purchase_id)` and `(business_id, credit_note_id)`.

**`supplier_refunds`** (the `supplier_refund` accounting source; the DM §12 two-sided shape)

| Column | Type / rule |
|---|---|
| `id`, `supplier_id`, `credit_note_id`, `payment_method_id`, `posting_account_id` | UUID |
| `refund_date` | DATE |
| `reference?` | TEXT 1..100 trimmed |
| `source_currency` | CHAR(3) |
| `source_amount_consumed_minor` | 1..10^18 |
| `source_to_base_rate` | NUMERIC(20,10) |
| `credit_remaining_before_minor` | 1..10^18 |
| `source_carrying_base_released_minor` | 0..10^18 |
| `source_dust_base_minor` | signed |
| `receipt_currency` | CHAR(3) |
| `receipt_amount_minor` | 1..10^18 |
| `receipt_to_base_rate` | NUMERIC(20,10) |
| `receipt_base_amount_minor` | 1..10^18 |
| `rate_source` | TEXT `IN ('base','manual')` |
| `rate_timestamp` | TIMESTAMPTZ |
| `fx_rate_id?` | UUID |
| `realized_fx_gain_loss_minor` | signed |
| `intent_sha256`, `business_transaction_id`, `created_by`, `created_at` | as S5 |
| `accounting_source_type` | `GENERATED ALWAYS AS ('supplier_refund') STORED` |
| `binding_source_id` | UUID |

Keys and constraints:
- FK `(business_id, credit_note_id, supplier_id) → supplier_credit_notes (business_id, id, supplier_id)` RESTRICT;
- FK `(business_id, payment_method_id, posting_account_id) → payment_methods (business_id, id, posting_account_id)` RESTRICT;
- FK `(business_id, fx_rate_id) → accounting_fx_rates` RESTRICT;
- `CHECK (source_amount_consumed_minor <= credit_remaining_before_minor)`;
- `CHECK (realized_fx_gain_loss_minor = receipt_base_amount_minor − source_carrying_base_released_minor)`;
- `CHECK (receipt_currency <> source_currency OR receipt_amount_minor = source_amount_consumed_minor)`;
- the rate CHECK as `supplier_payments`;
- `CHECK (binding_source_id = id)` and the deferred binding FK;
- `UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)`;
- index `(business_id, credit_note_id)`.

**Not created** (TL-12): DM's `rounding_difference_minor` (AL-28: never 6100), `direction`, `status` and `idempotency_key`.

### 2.3 Guards, helpers and `supplier_settlement_guard_gaps()` (ENG)

**Pure arithmetic.** These are internal-owned, `IMMUTABLE SECURITY DEFINER`, pinned, no grantee: the `inventory_half_even` pattern (`0060:83`). None reads a table.

| Function | Returns |
|---|---|
| `supplier_convert_base(p_txn BIGINT, p_rate NUMERIC, p_txn_exp INTEGER, p_base_exp INTEGER) RETURNS BIGINT` | `conv` (A-08) |
| `supplier_ap_release(p_total_base BIGINT, p_total_txn BIGINT, p_before BIGINT, p_applied BIGINT) RETURNS BIGINT` | `rel` (A-08) |
| `supplier_credit_remaining_carrying(p_original BIGINT, p_original_carrying BIGINT, p_remaining BIGINT) RETURNS BIGINT` | `g(r)` (A-10) |

**Verification helpers.** These are internal-owned definer, no grantee, and not triggers. They are called only by the guards below.
- **`purchase_settlement_verify(p_business_id UUID, p_purchase_id UUID) RETURNS void`**
  - It checks R-62 over `supplier_returns` (`ap_released_before_txn_minor`, `ap_txn_minor`, `ap_base_minor`) ∪ both allocation tables.
  - It orders the rows with a window `sum(amount) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`.
  - It checks `Σ amount ≤ T` and `Σ rel = HALF_EVEN(B·Σ amount, T)`.
  - Otherwise it raises `supplier_payment.settlement_inconsistent`.
- **`supplier_credit_note_verify(p_business_id UUID, p_credit_note_id UUID) RETURNS void`**
  - It checks R-63 over both consumer tables and the note row.
  - Otherwise it raises `supplier_credit_note.consumption_inconsistent`.

**Guards.** These are internal definer and pinned, inside the inventory bracket. **Every row's function is new in S6** except `supplier_credit_note_guard()` (replaced).

| table | trigger | tgtype | deferred | function | enforces |
|---|---|---|---|---|---|
| `payment_methods` | `payment_methods_guard` | 31 | no | `payment_method_guard()` | **INSERT:** `revision = 1`, `is_active`, created/updated now and trace (R-36), eligibility `= 'eligible'` (A-14(b)), else `payment_method.posting_account_ineligible`. **UPDATE:** immutable columns (`id`, tenant, business, `system_type`, `create_intent_sha256`, `created_*`), else `payment_method.field_immutable`; `revision = OLD+1`; an account change requires no `supplier_payments`/`supplier_refunds` row for the method (`payment_method.posting_account_locked`) and an eligible account; `is_active` false→true, or true with a new account, requires eligibility. **DELETE:** `payment_method.not_deletable` |
| `payment_methods` | `payment_methods_named` | 21 (AFTER INSERT OR UPDATE) | yes | `payment_method_named()` | ≥ 1 `payment_method_names` row at COMMIT, else `payment_method.name_required` |
| `payment_method_names` | `payment_method_names_guard` | 31 | no | `payment_method_name_guard()` | every insert, update or delete requires the parent method's `updated_at = now()` and trace (R-36): names change only with a method revision, else `payment_method.field_immutable`. UPDATE changes `display_name` only |
| `supplier_payments` | `supplier_payments_guard` | 31 | no | `supplier_payment_guard()` | **INSERT:** trace (R-36); the method row is active and its `posting_account_id` equals `NEW.posting_account_id`; the supplier is active. **UPDATE/DELETE:** `supplier_payment.immutable` |
| `supplier_payments` | `supplier_payments_complete` | 5 | yes | `supplier_payment_complete()` | `count(allocations) = allocation_count ≥ 1`; `Σ payment_amount = amount_minor`; `Σ payment_base = base_amount_minor`; every allocation's currency and rate = the header's, else `supplier_payment.allocations_invalid` |
| `supplier_payment_allocations` | `supplier_payment_allocations_guard` | 31 | no | `supplier_payment_allocation_guard()` | **INSERT:** the header was created by this transaction (R-36), else `supplier_payment.immutable`. **UPDATE/DELETE:** `supplier_payment.immutable` |
| `supplier_payment_allocations` | `supplier_payment_allocations_value_complete` | 5 | yes | `supplier_payment_allocation_value_complete()` | the purchase is `received` and not reversed; `purchase_currency`/`purchase_historical_to_base_rate` = the purchase snapshot; `rel`, `ap_dust`, `pb = conv(p, header rate)` and `realized` recomputed; `conv_R(a) > 0`; then `PERFORM purchase_settlement_verify(…)`. Codes: `supplier_payment.purchase_reversed`, `.purchase_state_invalid`, `.settlement_inconsistent` |
| `supplier_credit_allocations` | `supplier_credit_allocations_guard` | 31 | no | `supplier_credit_allocation_guard()` | **INSERT:** `created_at = now()` and trace. **UPDATE/DELETE:** `supplier_credit_allocation.immutable` |
| `supplier_credit_allocations` | `supplier_credit_allocations_value_complete` | 5 | yes | `supplier_credit_allocation_value_complete()` | AP side as above; credit side: currency and rate = the note's, `cr_rel = credit_release(…)`, `cr_dust`, `realized`; `PERFORM purchase_settlement_verify(…)`, `PERFORM supplier_credit_note_verify(…)` |
| `supplier_refunds` | `supplier_refunds_guard` | 31 | no | `supplier_refund_guard()` | **INSERT:** trace; the method is active with a matching account. **UPDATE/DELETE:** `supplier_refund.immutable` |
| `supplier_refunds` | `supplier_refunds_value_complete` | 5 | yes | `supplier_refund_value_complete()` | credit side as above; `mb = conv(m, Rr)`; `realized`; `PERFORM supplier_credit_note_verify(…)` |
| `supplier_credit_notes` (S5) | `supplier_credit_notes_immutable` (S5, unchanged) | 27 | no | `supplier_credit_note_guard()` **replaced** | A-12 |
| `purchase_reversals` (S5) | `purchase_reversals_unsettled` | 5 | yes | `purchase_reversal_unsettled()` | no allocation of either kind for the purchase, else `purchase_reversal.payment_allocated` / `.credit_allocated` |

**No same-transaction guard is needed on the credit-allocation and refund headers.** Each is a single-row document: its "detail" is the note decrement, which A-12(4) already ties to this transaction.

**`supplier_settlement_guard_gaps() RETURNS TABLE (table_name TEXT, trigger_name TEXT, missing TEXT)`.** It is migrator-owned, `SECURITY INVOKER`, `STABLE`, pinned, with no grantee (tests run it as the owner).

- It holds a VALUES list of the thirteen rows above: `(table, trigger, tgtype, function, owner, deferred, enabled 'O')`.
- It holds a `c_digest` map of `md5(prosrc)` for the fifteen S6 functions:
  - the thirteen guard and trigger functions (the replaced `supplier_credit_note_guard()` included);
  - the two verify helpers.

  These digests are recorded at migration time.
- **It reports:**
  - `trigger_missing`;
  - `trigger_disabled` (`tgenabled <> 'O'`);
  - `trigger_shape` (tgtype, deferrable, function);
  - `function_owner`;
  - `function_not_definer`;
  - `function_search_path`;
  - `function_body` (a digest mismatch).
- **0067-E mutation probes**, each in a rolled-back block, each of which must make the function report its gap:
  - `ALTER TABLE supplier_refunds DISABLE TRIGGER supplier_refunds_value_complete`;
  - `CREATE OR REPLACE` of `purchase_settlement_verify(uuid,uuid)` with a no-op body. This runs under `SET LOCAL ROLE daftar_inventory_internal`, with CREATE lent inside the block (R-40);
  - `ALTER TABLE supplier_payments ENABLE REPLICA TRIGGER supplier_payments_complete`.

### 2.4 The replaced credit-note guard (normative text)

```sql
SET LOCAL ROLE daftar_inventory_internal;
CREATE OR REPLACE FUNCTION supplier_credit_note_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_n INTEGER;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.tenant_id, NEW.business_id, NEW.id, NEW.supplier_id, NEW.supplier_return_id, NEW.currency_code,
          NEW.original_amount_minor, NEW.original_carrying_base_amount_minor, NEW.source_to_base_rate, NEW.rate_source,
          NEW.rate_timestamp, NEW.issued_on, NEW.business_transaction_id, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.tenant_id, OLD.business_id, OLD.id, OLD.supplier_id, OLD.supplier_return_id, OLD.currency_code,
          OLD.original_amount_minor, OLD.original_carrying_base_amount_minor, OLD.source_to_base_rate, OLD.rate_source,
          OLD.rate_timestamp, OLD.issued_on, OLD.business_transaction_id, OLD.created_by, OLD.created_at)
     AND NEW.remaining_amount_minor < OLD.remaining_amount_minor
     AND NEW.remaining_carrying_base_amount_minor
         = supplier_credit_remaining_carrying(OLD.original_amount_minor, OLD.original_carrying_base_amount_minor, NEW.remaining_amount_minor)
  THEN
    SELECT count(*) INTO v_n FROM (
      SELECT 1 FROM supplier_credit_allocations a
       WHERE a.business_id = OLD.business_id AND a.credit_note_id = OLD.id
         AND a.credit_remaining_before_minor = OLD.remaining_amount_minor
         AND a.credit_amount_consumed_minor = OLD.remaining_amount_minor - NEW.remaining_amount_minor
         AND a.credit_carrying_base_released_minor = OLD.remaining_carrying_base_amount_minor - NEW.remaining_carrying_base_amount_minor
         AND a.created_at = now() AND a.business_transaction_id = inventory_business_transaction_id()
      UNION ALL
      SELECT 1 FROM supplier_refunds f
       WHERE f.business_id = OLD.business_id AND f.credit_note_id = OLD.id
         AND f.credit_remaining_before_minor = OLD.remaining_amount_minor
         AND f.source_amount_consumed_minor = OLD.remaining_amount_minor - NEW.remaining_amount_minor
         AND f.source_carrying_base_released_minor = OLD.remaining_carrying_base_amount_minor - NEW.remaining_carrying_base_amount_minor
         AND f.created_at = now() AND f.business_transaction_id = inventory_business_transaction_id()) c;
    IF v_n = 1 THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'supplier_credit_note.immutable: a supplier credit note changes only by one backed consumption of both remaining values' USING ERRCODE = 'P0001';
END;
$$;
RESET ROLE;
```

- The column list must be the full S5 column list at freeze. The coordinator re-checks it against frozen 0065 (TL-1). A missing column must fail the gate, not be admitted: 0067-E(8) compares the list to `pg_attribute`.
- The owner and ACL are unchanged (no grantee).
- The internal principal reads both consumer tables through `inventory_internal_read`.

### 2.5 The replaced reversal guard (A-14(c))

It is 0065's body with the single `IN` list extended by the three S6 types. The `purchase` clause with `purchase_reversals` and the R-13 block are verbatim. The gate matches it by regex (§7.1(3)).

### 2.6 0068 routines (ENG)

**Common to all seven:**
- internal-owned definer, pinned, PUBLIC revoked, `EXECUTE` to `daftar_app` only;
- `#variable_conflict use_column`;
- the first statement is `v_actor := inventory_assertion_consume('<op>', inventory_claimed_payload_digest('<op>', types[], values[]))`, built from the routine's own arguments in A-16 order.

**No helpers:** S6 moves no stock and writes no bridge. Rule 22's writer list is therefore unchanged except for the credit-note writers (§7.2).

| Routine | Signature |
|---|---|
| `payment_method_create` | `(p_payment_method_id UUID, p_system_type TEXT, p_posting_account_id UUID, p_requires_reference BOOLEAN, p_sort_order INTEGER, p_name_ar TEXT, p_name_en TEXT, p_name_tr TEXT) RETURNS TABLE (payment_method_id UUID, replayed BOOLEAN, revision INTEGER, is_active BOOLEAN)` |
| `payment_method_update` | `(p_payment_method_id UUID, p_expected_revision INTEGER, p_posting_account_id UUID, p_requires_reference BOOLEAN, p_sort_order INTEGER, p_name_ar TEXT, p_name_en TEXT, p_name_tr TEXT) RETURNS TABLE (…same…)` |
| `payment_method_deactivate` · `payment_method_activate` | `(p_payment_method_id UUID, p_expected_revision INTEGER) RETURNS TABLE (…same…)` |
| `supplier_pay` | `(p_payment_id UUID, p_supplier_id UUID, p_payment_method_id UUID, p_posting_account_id UUID, p_payment_date DATE, p_currency_code CHAR(3), p_amount_minor BIGINT, p_rate_id UUID, p_rate NUMERIC, p_rate_source TEXT, p_rate_at TIMESTAMPTZ, p_base_amount_minor BIGINT, p_reference TEXT, p_allocation_ids UUID[], p_purchase_ids UUID[], p_warehouse_ids UUID[], p_purchase_currencies TEXT[], p_payment_amounts BIGINT[], p_payment_bases BIGINT[], p_applied BIGINT[], p_released_before BIGINT[], p_carrying_released BIGINT[], p_ap_dusts BIGINT[], p_realized BIGINT[]) RETURNS TABLE (payment_id UUID, allocation_id UUID, line_no INTEGER, purchase_id UUID, replayed BOOLEAN)` |
| `supplier_allocate_credit` | `(p_allocation_id UUID, p_credit_note_id UUID, p_purchase_id UUID, p_warehouse_id UUID, p_allocation_date DATE, p_credit_currency CHAR(3), p_consumed_minor BIGINT, p_remaining_before_minor BIGINT, p_credit_released_minor BIGINT, p_credit_dust_minor BIGINT, p_purchase_currency CHAR(3), p_applied_minor BIGINT, p_ap_released_before_minor BIGINT, p_ap_released_minor BIGINT, p_ap_dust_minor BIGINT, p_realized_minor BIGINT) RETURNS TABLE (allocation_id UUID, replayed BOOLEAN)` |
| `supplier_receive_refund` | `(p_refund_id UUID, p_credit_note_id UUID, p_payment_method_id UUID, p_posting_account_id UUID, p_refund_date DATE, p_source_currency CHAR(3), p_consumed_minor BIGINT, p_remaining_before_minor BIGINT, p_source_released_minor BIGINT, p_source_dust_minor BIGINT, p_receipt_currency CHAR(3), p_receipt_amount_minor BIGINT, p_rate_id UUID, p_rate NUMERIC, p_rate_source TEXT, p_rate_at TIMESTAMPTZ, p_receipt_base_minor BIGINT, p_realized_minor BIGINT, p_reference TEXT) RETURNS TABLE (refund_id UUID, replayed BOOLEAN)` |

**`payment_method_create` statement order** (normative; the S4 `supplier_create` pattern, `0064:341-420`):
1. **The consume.**
2. **Isolation and trace:** `read committed`, else `inventory.isolation_unsupported`; the trace, else `inventory.trace_missing`.
3. **The key and the intent.** `pg_advisory_xact_lock(hashtext('daftar.payment_method_id'), hashtext(p_payment_method_id::text))`. Then `v_intent := split_part(current_setting('app.inventory_assertion', true), '.', 7)`.
4. **The method `FOR UPDATE` by id:**
   - found with `create_intent_sha256 = v_intent` → stored row, `replayed`;
   - found otherwise → `payment_method.idempotency_conflict`.
5. **Shape:**
   - `system_type` is in the set;
   - every non-NULL name is trimmed 1..100, else `payment_method.name_invalid`;
   - at least one name, else `payment_method.name_required`;
   - `sort_order` is 0..10000, else `inventory.payload_invalid`.
6. **Eligibility.** `accounting_settlement_account_eligibility(v_business, p_posting_account_id)`:
   - `'not_found'` → `payment_method.posting_account_not_found`;
   - any other non-eligible result → `payment_method.posting_account_ineligible`.
7. **`INSERT payment_methods`** (`is_active = true`, `revision = 1`, intents = `v_intent`). Then the `INSERT payment_method_names` rows.
8. **Audit and outbox.**
9. **`RETURN QUERY`.**

**`payment_method_update` / `_deactivate` / `_activate`** follow the S4 `supplier_update`/`archive`/`reactivate` order (`0064:421-650`):
1. The consume, isolation and trace, key, intent.
2. **The row `FOR UPDATE`:**
   - not found → `payment_method.not_found`;
   - `revision = expected + 1 AND last_intent_sha256 = v_intent` → replay;
   - `revision ≠ expected` → `payment_method.revision_changed`.
3. **Shape.**
4. **State:**
   - deactivate needs `is_active`, and activate needs `NOT is_active`; otherwise `payment_method.state_invalid`;
   - activate re-checks eligibility (MP-1);
   - an update with an account change checks "unused" (`payment_method.posting_account_locked`) and then eligibility.
5. **`UPDATE payment_methods`.** Then, for update only, the name set:
   - `DELETE` the locales passed as NULL;
   - `INSERT … ON CONFLICT (business_id, payment_method_id, locale) DO UPDATE SET display_name` for the others.
6. **Audit, outbox, `RETURN QUERY`.**

**`supplier_pay` statement order** (normative):
1. **The consume.**
2. **Isolation and trace.**
3. **The key and the intent.** `pg_advisory_xact_lock(hashtext('daftar.supplier_payment_id'), hashtext(p_payment_id::text))`. Then `v_intent := inventory_payload_digest('supplier.pay', v_tenant, v_business, <A-16 intent types>, <values>)`.
4. **`supplier_payments` by `(business, p_payment_id)`:**
   - equal intent → the stored rows, `replayed = true`;
   - otherwise → `supplier_payment.idempotency_conflict`.

   This precedes every other read (R-26).
5. **Shape**, before any state read:
   - 1..50 allocations, all arrays of equal length, no NULL element, distinct allocation and purchase ids;
   - every amount > 0; `Σ p_payment_amounts = p_amount_minor`;
   - `reference` NULL or trimmed 1..100.

   Otherwise `supplier_payment.allocations_invalid`.
6. **2a: the purchases.** `SELECT … FROM purchases WHERE business_id = v_business AND id = ANY(p_purchase_ids) ORDER BY id FOR UPDATE`. For each purchase:
   - missing → `purchase.not_found`;
   - `supplier_id ≠ p_supplier_id` → `supplier_payment.purchase_supplier_mismatch`;
   - `status ≠ 'received'` → `supplier_payment.purchase_state_invalid`;
   - `EXISTS purchase_reversals` → `supplier_payment.purchase_reversed`;
   - `warehouse_id ≠` the bound one, or currency ≠ the bound one → `supplier_payment.settlement_changed`.
7. **2b: the supplier `FOR SHARE`.** Not `active` → `supplier_payment.supplier_inactive`.
8. **2c: the method `FOR SHARE`:**
   - missing → `payment_method.not_found`;
   - not active → `payment_method.inactive`;
   - `posting_account_id ≠ p_posting_account_id` → `supplier_payment.settlement_changed`;
   - eligibility ≠ `'eligible'` → `payment_method.posting_account_ineligible`;
   - `requires_reference AND p_reference IS NULL` → `supplier_payment.reference_required`.
9. **Dates:**
   - `p_payment_date < purchases.document_date` of any allocation → `supplier_payment.date_before_purchase`;
   - after today in the business timezone → `supplier_payment.date_in_future`.
10. **FX** (A-15). The currency must be registered, else `purchase.currency_unknown`. Any bound difference → `supplier_payment.fx_rate_changed`.
11. **Per allocation, in array order:**
    - `O := purchase_ap_outstanding(v_business, purchase)`;
    - `applied > O` → `supplier_payment.amount_exceeds_outstanding`;
    - `P = C AND p ≠ a` → `supplier_payment.amount_mismatch`;
    - recompute `X = T − O`, `rel`, `ap_dust`, `pb`, `realized`;
    - `conv_R(a) = 0 OR pb = 0` → `supplier_payment.amount_below_base_unit`;
    - any bound difference, including `Σ pb ≠ p_base_amount_minor` → `supplier_payment.settlement_changed`.
12. **The inserts.** `INSERT supplier_payments` (`allocation_count = n`), then `INSERT supplier_payment_allocations` (`line_no` = ordinal, `binding_source_id = id`).
13. **Audit and outbox.**
14. **`RETURN QUERY`** of the stored rows.

The service then posts the `n` entries in `line_no` order, each through `presentAccountingAssertion(tx, {sourceType:'supplier_payment', sourceId: allocation_id})`.

**`supplier_allocate_credit` statement order** (normative):
1. **The consume.**
2. **Isolation and trace.**
3. **The key** `'daftar.supplier_credit_allocation_id'`. Then the intent.
4. **The replay read**: `supplier_credit_allocation.idempotency_conflict` on a different intent.
5. **Shape.**
6. **2a: the target purchase `FOR UPDATE`.** The purchase checks of `supplier_pay` step 6, under `supplier_credit_allocation.*` codes, with the purchase's `supplier_id` as the supplier.
7. **2a': the note `FOR UPDATE`:**
   - missing → `supplier_credit_note.not_found`;
   - `supplier_id ≠ purchase.supplier_id` → `supplier_credit_allocation.supplier_mismatch`;
   - `remaining_amount_minor = 0` → `supplier_credit_allocation.credit_exhausted`;
   - `p_consumed_minor > remaining` → `supplier_credit_allocation.amount_exceeds_credit`;
   - `p_remaining_before_minor ≠ remaining` → `supplier_credit_allocation.settlement_changed`.
8. **2b: the supplier `FOR SHARE`.** It must exist. **Inactive is allowed** (TL-13).
9. **Dates.** `allocation_date < max(purchase.document_date, note.issued_on)` → `supplier_credit_allocation.date_before_source`. After today → `supplier_credit_allocation.date_in_future`.
10. **The AP side** as `supplier_pay` step 11. **The credit side** by A-10 with the note's snapshot. `amount_mismatch`, `amount_below_base_unit` and `settlement_changed` as applicable.
11. **`INSERT supplier_credit_allocations`.**
12. **The note.** `UPDATE supplier_credit_notes SET remaining_amount_minor = rb − c, remaining_carrying_base_amount_minor = g(rb − c)`, which is judged by A-12.
13. **Audit, outbox, `RETURN QUERY`.**

**`supplier_receive_refund` statement order** (normative):
1. **The consume.**
2. **Isolation and trace.**
3. **The key** `'daftar.supplier_refund_id'`. Then the intent.
4. **The replay read.**
5. **Shape.**
6. **2a': the note `FOR UPDATE`.** Checks as above under `supplier_refund.*`.
7. **2b: the note's supplier `FOR SHARE`.** Inactive is allowed.
8. **2c: the method `FOR SHARE`.** Checks as `supplier_pay` step 8, with `supplier_refund.reference_required`.
9. **Dates.** `refund_date < note.issued_on` → `supplier_refund.date_before_credit`. Future → `supplier_refund.date_in_future`.
10. **The receipt FX** (A-15, at `refund_date`) → `supplier_refund.fx_rate_changed`.
11. **The credit side**, `mb` and `realized` recomputed. `amount_mismatch`, `amount_below_base_unit` and `settlement_changed` as applicable.
12. **`INSERT supplier_refunds`.**
13. **The note `UPDATE`.**
14. **Audit, outbox, `RETURN QUERY`.**

### 2.7 RLS

Every S6 table follows the 0063 layering exactly (`0063:433-590`):
- `tenant_membership`, permissive, through the `businesses` subquery;
- `business_isolation_read AS RESTRICTIVE FOR SELECT`, admitting:
  - `'daftar_inventory_internal'` on all six tables;
  - `'daftar_accounting_internal'` as well on the four settlement tables;
- `business_isolation_insert` / `_update` / `_delete AS RESTRICTIVE`, with **no** principal admission (0063 R-35);
- `inventory_internal_read FOR SELECT TO daftar_inventory_internal USING (true)`;
- `accounting_validator FOR SELECT TO daftar_accounting_internal USING (true)` on the four settlement tables.

On the S5 table `supplier_credit_notes` there are two changes:
- `ALTER POLICY business_isolation_read` to add `'daftar_accounting_internal'`;
- `CREATE POLICY accounting_validator`.

### 2.8 Registrations in 0068 (last)

```sql
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES
  ('payment.create_method','P3-S6'), ('payment.update_method','P3-S6'), ('payment.deactivate_method','P3-S6'),
  ('payment.activate_method','P3-S6'), ('supplier.pay','P3-S6'), ('supplier.allocate_credit','P3-S6'),
  ('supplier.receive_refund','P3-S6');
```

There are no `inventory_operation_movement_kinds` rows: no S6 kind moves stock.

### 2.9 End-state blocks

**0067-E refuses the migration unless:**
1. `accounting_source_types` holds the eight earlier rows unchanged, plus `supplier_payment` 9, `supplier_credit_allocation` 10 and `supplier_refund` 11. Each has exactly one `('post', type)` kind.
2. `stock_source_types` is unchanged (the S3 four, the S4 two and the S5 two), and `inventory_stock_source_guard_gaps()` returns no row.
3. The six tables exist with RLS enabled and forced. For each, `pg_policy` holds exactly the §2.7 set. None of the `_insert`, `_update` and `_delete` expressions mention `current_user` (`pg_get_expr` text).
4. `supplier_credit_notes_supplier_uq` and every S6 FK are validated. Every binding FK is `DEFERRABLE INITIALLY DEFERRED`.
5. **The privileges are exactly A-17.**
   - Checked with `has_table_privilege` / `has_column_privilege` for `daftar_app`, `daftar_inventory_internal`, `daftar_accounting_internal`, and one arbitrary non-member probe role that the block creates and drops.
   - No runtime role holds DML on an S6 table.
6. **Every §2.3 function except `supplier_settlement_guard_gaps()`** (migrator-owned INVOKER, no grantee):
   - is owned by `daftar_inventory_internal`;
   - is definer and pinned;
   - is executable by no role.

   `accounting_settlement_account_eligibility` and the three completeness functions are owned by `daftar_accounting_internal`. Only the former is executable, by `daftar_inventory_internal` only.
7. `supplier_settlement_guard_gaps()` returns no row, and each of its three §2.3 probes reports its gap.
8. **The credit-note guard:**
   - `supplier_credit_note_guard()` is owned by `daftar_inventory_internal` with no grantee;
   - its `prosrc` contains `supplier_credit_remaining_carrying`, `supplier_refunds`, `supplier_credit_allocations` and `supplier_credit_note.immutable`;
   - every non-remaining column of `supplier_credit_notes` in `pg_attribute` (not dropped, `attnum > 0`) is named in its `prosrc`;
   - `supplier_credit_notes_immutable` is still tgtype 27, enabled, with no `WHEN`.
9. **The reversal guard's `prosrc`:**
   - names all seven always-refused types and `purchase_reversals`;
   - contains `accounting.opening_balance_inventory_bound`;
   - is owned by `daftar_accounting_internal`.
10. **The two extension points:**
    - are migrator-owned INVOKER;
    - are executable by exactly `daftar_app` and `daftar_inventory_internal`;
    - `purchase_ap_outstanding`'s `prosrc` names `supplier_payment_allocations` and `supplier_credit_allocations`;
    - `purchase_settlement_state`'s `prosrc` names both.
11. The three completeness triggers exist: deferred, with `WHEN (NEW.source_type = '<type>')`, on their functions.
12. No internal principal holds `CREATE` on `public`.

**0068-E refuses the migration unless:**
1. `inventory_operation_kinds` is exactly the S1 three, S3 seven, S4 seven, S5 two and S6 seven (26).
2. `inventory_operation_movement_kinds` is unchanged since 0066.
3. The seven entry routines are internal definer and pinned. `daftar_app` executes each of them, and no other role or PUBLIC does.
4. Each routine's first statement matches `^v_actor := inventory_assertion_consume\(`.
5. In every routine, the advisory key precedes the intent read (R-26). In the three settlement routines, the document replay read precedes `FROM purchases` and `FROM supplier_credit_notes`.
6. In `supplier_allocate_credit` and `supplier_receive_refund`, `INSERT INTO supplier_credit_allocations` / `supplier_refunds` precedes `UPDATE supplier_credit_notes` (A-12(4)).
7. `supplier_settlement_guard_gaps()` and `inventory_stock_source_guard_gaps()` both return no row.
8. No `CREATE` is left on `public`.

---

## 3. Error model

**Rule.** Every refusal is a stable `<domain>.<code>` in an **explicit code → HTTP table** (0063 R-41). A code in no table is an `UnclassifiedRefusalError`: a typed 500, logged, never a guessed status.
- `purchasingRefusal` (`purchasing-errors.ts`) gains the `supplier_payment.*`, `supplier_credit_allocation.*`, `supplier_refund.*` and new `supplier_credit_note.*` codes.
- It delegates `payment_method.*` to `paymentMethodRefusal` (`apps/api/src/modules/payment-methods/payment-method-errors.ts`, new), which owns that table.
- `inventory.*` and `accounting.*` keep their accepted mappings.

| Code | Raised by | HTTP | Retry? |
|---|---|---|---|
| `payment_method.not_found` | service, routine | 404 | no |
| `payment_method.posting_account_not_found` | service, routine | 422 | no |
| `payment_method.posting_account_ineligible` | service, routine, guard — **MP-1** | 422 | no |
| `payment_method.posting_account_locked` | routine, guard — **MP-2** | 409 | no |
| `payment_method.inactive` · `payment_method.state_invalid` | routine | 409 | no |
| `payment_method.revision_changed` · `payment_method.idempotency_conflict` | service, routine | 409 | no |
| `payment_method.name_required` · `payment_method.name_invalid` | DTO, routine, guard | 400 | no |
| `payment_method.field_immutable` | guard (no route edits it) | 500 | no |
| `payment_method.not_deletable` | guard (no route deletes) — **MP-2** | 409 | no |
| `supplier_payment.allocations_invalid` · `supplier_payment.amount_mismatch` | DTO, service, routine | 400 | no |
| `supplier_payment.amount_exceeds_outstanding` | service, routine under 2a — **MP-3** | 422 | no |
| `supplier_payment.purchase_supplier_mismatch` · `.purchase_state_invalid` · `.purchase_reversed` | routine, guard | 409 | no |
| `supplier_payment.supplier_inactive` · `supplier_payment.reference_required` | routine | 409 / 422 | no |
| `supplier_payment.date_before_purchase` · `supplier_payment.date_in_future` | DTO, service, routine | 422 | no |
| `supplier_payment.amount_below_base_unit` | service, routine | 422 | no |
| `supplier_payment.settlement_changed` · `supplier_payment.fx_rate_changed` | routine (bound ≠ recomputed) | 409 | **yes** |
| `supplier_payment.idempotency_conflict` | service, routine | 409 | no |
| `supplier_payment.settlement_inconsistent` · `supplier_payment.immutable` | COMMIT guard; guard | 500 | no |
| `supplier_credit_allocation.*` | the parallel codes: `amount_exceeds_outstanding` (422), `amount_exceeds_credit` (422, **MP-6**), `credit_exhausted` (409), `supplier_mismatch` (409), `purchase_state_invalid` / `purchase_reversed` (409), `amount_mismatch` (400), `date_before_source` / `date_in_future` (422), `amount_below_base_unit` (422), `settlement_changed` (409, **retry**), `idempotency_conflict` (409), `immutable` (500) | — | — |
| `supplier_refund.*` | the parallel codes: `amount_exceeds_credit` (422, **MP-6**), `credit_exhausted` (409), `amount_mismatch` (400), `reference_required` (422), `date_before_credit` / `date_in_future` (422), `amount_below_base_unit` (422), `settlement_changed` / `fx_rate_changed` (409, **retry**), `idempotency_conflict` (409), `immutable` (500) | — | — |
| `supplier_credit_note.not_found` | service, routine | 404 | no |
| `supplier_credit_note.immutable` (S5) · `supplier_credit_note.consumption_inconsistent` | guard; COMMIT guard | 500 | no |
| `purchase_reversal.payment_allocated` · `.credit_allocated` (S5 codes) | S5 routine via A-13; the new deferred guard | 409 | no |
| `inventory.warehouse_out_of_scope` · `inventory.business_wide_scope_required` | application authority, before minting | 403 | no |
| `seam.inventory_assertion_missing` · `_malformed` · `_scope_mismatch` · `_operation_mismatch` · `_exhausted` · `_unused` | the seam (A-19) | 500 (a defect) | no |
| `accounting.*` | posting, including `accounting.account_inactive`, `accounting.period_closed` and `accounting.fx_rate_missing` | accepted mapping | per mapping |

**Message rule.** No refusal text carries an amount, a rate or a name. The database text after the colon is never forwarded (`purchasing-errors.ts` header).

---

## 4. Packages and application

### 4.1 `@daftar/inventory` (framework-free; the S3 gate keeps enforcing it)

- **`src/supplier-settlement.ts`** (new). Pure `bigint`, no `number` for money:
  - `convertToBase`, `apRelease`, `creditRemainingCarrying`, `creditRelease`;
  - `planPaymentAllocation`, `planCreditAllocation`, `planRefund`, each returning the full bound record (dust and FX included).

  It is the byte-equivalent of §2.3's functions.
- **Payload modules** (new). Builders for the seven kinds in A-16 order:
  - `src/payment-method-payloads.ts`;
  - `src/supplier-settlement-payloads.ts`.

  Additive edits go in `payload.ts` (the `InventoryOperationCode` union gains seven), `errors.ts` and `index.ts`, with coordinator sign-off because these are S1 files.
- **Vectors:**
  - `vectors/invpl-s6-vectors.json`: each kind, including NULL `rate_id`, a NULL reference and a negative `realized`;
  - `vectors/supplier-settlement-vectors.json`, with case ids:
    - `GOLD-84-PARTIAL-FINAL`, `GOLD-73-REFUND-EUR`, `GOLD-61-CREDIT-ALLOC`;
    - `AP-THIRDS-EXACT-CLEARING`, `FOREIGN-AP-DUST`, `SAME-RATE-SUBUNIT-FX`;
    - `STRONG-BASE-MIN1`, `BELOW-BASE-UNIT`.

  They are consumed by `test/*.test.ts` and by T-07's SQL run.

### 4.2 `@daftar/accounting`

- `post.ts:203`: `DOMAIN_SOURCE_TYPES` gains `'supplier_payment'`, `'supplier_credit_allocation'`, `'supplier_refund'`.
- `DOMAIN_REVERSIBLE_SOURCE_TYPES` is unchanged.
- There is no new minter. `mintDomainPostingAssertion` serves all three.

### 4.3 Application

- **`apps/api/src/modules/payment-methods/`** (new module; shared infrastructure for Phase 4):
  - `payment-method.service.ts`;
  - `payment-methods.controller.ts`;
  - `payment-methods.schemas.ts`;
  - `payment-method-errors.ts`;
  - `payment-methods.module.ts`.

  The service uses `withBusinessInventoryTransaction`: no posting.
- **`apps/api/src/modules/purchasing/`**, new files:
  - `supplier-payment.service.ts`;
  - `supplier-credit-allocation.service.ts`;
  - `supplier-refund.service.ts`;
  - `supplier-settlement-posting.ts`: the A-05 line builders. It posts only through `presentAccountingAssertion`.
  - `purchase-receive-and-pay.service.ts`;
  - `supplier-settlements.controller.ts`.
- **`apps/api/src/modules/purchasing/`**, edits:
  - `purchase-receipt.service.ts`, split into `plan`/`execute` (A-19) with **no behaviour change**. The S4 suites must stay green unchanged;
  - `purchasing-reads.ts` (A-18);
  - `purchasing-errors.ts`;
  - `purchases.controller.ts` (the receive-and-pay route);
  - `purchasing.schemas.ts`;
  - `purchasing.module.ts`.
- **`apps/api/src/infra/database.ts`:**
  - `InventoryAssertions`, `InventoryAssertionSequence` and `presentInventoryAssertion` (A-19);
  - the `inventoryAssertion` parameter of seam 2 widened to `InventoryAssertions`.

  Seam 1 is unchanged, and the single-string form is byte-for-byte today's behaviour.
- **`inventory-authorization.ts`:** the seven `OPERATION_AUTHORITY` rows (A-03).
- **`packages/shared-contracts/src/`:** `payment-methods.ts` and `supplier-settlement.ts` DTO types, with their exports.

---

## 5. Harness

- **`tests/helpers/supplier-settlement.ts`** (new) provides:
  - `seedSettlementAccounts(business)`: the five settlement system accounts active; a custom asset account; an expense account; an inactive asset account;
  - `makePaymentMethod(...)`;
  - `receivePurchase(...)`, from the S4 helper;
  - `returnToCredit(...)`: an S5 return after a full payment, which in S6 produces a real credit note, no fixture;
  - `settleConcurrently(n, fn)`: the `tests/helpers/concurrency` barrier.
- **FX fixtures.** Rates for USD, EUR and JOD against an ILS base, and one strong-base business (KWD base, IDR purchase) for `STRONG-BASE-MIN1`.
- **The S5 fixture replacement** (S5C §5: an owner-installed `purchase_ap_outstanding` inside the test database) is **retired** by S6.
  - S5's T-07/T-08 fixture paths are re-proved against real allocations in T-12.
  - The S5 suites keep their fixture, which the coordinator scopes to restore the S6 body after each case (§7.3 row 22).
- **`gaps()` probes** run as the migration owner inside rolled-back transactions, per R-40.

---

## 6. Test plan

**Must-prove map** (P:243-251): MP-1 method validity · MP-2 method history · MP-3 no over-allocation · MP-4 FX only on 4900/6900 · MP-5 proportional release and final flush · MP-6 no credit over-consumption · MP-7 no customer payments.

| # | Suite | Proves | MP / PM / GOLD |
|---|---|---|---|
| T-01 | `tests/security/settlement-s6-grants.test.ts` | A-17 exactly; §2.7 policies exactly; restrictive `_insert/_update/_delete` admit no principal; a non-member role reads nothing; `daftar_app` DML on every S6 table refused | R-35 |
| T-02 | `tests/security/settlement-s6-signed-authority.test.ts` | each routine: no assertion, wrong op, tampered payload field (every field of A-16 in turn), replayed `jti`, other business → refused before any read; direct `EXECUTE` with a forged GUC refused | PM-44, PM-45 |
| T-03 | `tests/integration/settlement-s6-payment-method.test.ts` | create/activate refused for inactive, `liability`/`expense`, 1100/1150/1200, and another business's account (FK); admitted for 1000–1040 and a custom asset; activation of a method whose account was since deactivated refused | **MP-1**, GOLD-47 |
| T-04 | `tests/integration/settlement-s6-payment-method-history.test.ts` | DELETE refused for owner, migrator and internal; a used method's account change refused (guard code, then FK); deactivation leaves every posted line byte-identical (hash of `journal_lines` before/after); an inactive method cannot pay; an unused method's account change allowed | **MP-2**, GOLD-47 |
| T-05 | `tests/integration/settlement-s6-over-allocation.test.ts` | two concurrent payments of 60 against 100 outstanding → exactly one succeeds, the other `amount_exceeds_outstanding`; payment + credit allocation concurrently; a forged overlapping allocation (owner insert, triggers on) refused at COMMIT `settlement_inconsistent`; PM-12 detection query returns 0 rows | **MP-3**, PM-12 |
| T-06 | `tests/integration/settlement-s6-realized-fx.test.ts` | USD purchase @3.60 paid USD @3.70 → `Dr 6900`; @3.50 → `Cr 4900`; cross-currency payment; `SAME-RATE-SUBUNIT-FX`; across **every** S6 entry, no line on `rounding` or `purchase_price_variance` | **MP-4**, GOLD-38/39 |
| T-07 | `tests/integration/settlement-s6-carrying-release.test.ts` | GOLD-84 exactly (216 / 144 / 144); AP thirds clear to base 0 exactly; INV-ACC-17 after the final consumer; `STRONG-BASE-MIN1`; SQL functions = package vectors | **MP-5**, GOLD-84 |
| T-08 | `tests/integration/settlement-s6-credit-concurrency.test.ts` | concurrent allocation + refund, and two refunds, on one note → exactly one, or disjoint amounts ≤ remaining; forged note UPDATE refused `immutable`; PM-15 detection query returns 0 rows | **MP-6**, PM-15 |
| T-09 | `tests/security/settlement-s6-no-customer-payments.test.ts` | tables `payments`, `payment_allocations`, `payment_reversals`, `refunds`, `customer_credits`, `credit_notes` absent; routes `/v1/payments`, `/v1/customer-payments`, `/v1/refunds` → 404; no `payment`/`sale`/`invoice` source type or op kind | **MP-7** |
| T-10 | `tests/integration/settlement-s6-entries.test.ts` | A-05 (a)(b)(c) line for line, with dimensions; each completeness trigger refuses a tampered entry (missing FX line, wrong account, wrong branch) at COMMIT | A-14(a) |
| T-11 | `tests/integration/settlement-s6-gold.test.ts` | GOLD-58 (paid in full, return → 1150), GOLD-59 (paid 700 of 1000, return 500 → AP 300 + 1150 200), GOLD-61 (credit 500 on a new 800 purchase, then cash 300), GOLD-73, end to end through the API | GOLD |
| T-12 | `tests/integration/settlement-s6-s5-reproof.test.ts` | S5 T-07 (AP first) and T-08 (a)(b) (reversal refused when paid or credited) against real allocations; a return after a payment chains (R-62) | S5 TL-9 |
| T-13 | `tests/integration/settlement-s6-receive-and-pay.test.ts` | one transaction; the purchase entry equals a credit purchase's; a failure in the payment half rolls back the receipt (no movement, no entry); replay; `purchase.state_invalid` for an already received purchase | PM-22, AL-24 |
| T-14 | `tests/integration/settlement-s6-seam.test.ts` | `InventoryAssertionSequence` rules (pure, then live): unused / exhausted / mismatch / duplicate / scope; single-string form unchanged; the combined command's payment key is taken first (no deadlock with a racing `supplier.pay` of the same id) | A-19 |
| T-15 | `tests/security/settlement-s6-credit-note-guard.test.ts` | naked UPDATE of the pair → `immutable`; UPDATE of a non-remaining column → `immutable`; backed UPDATE with a wrong carrying → `immutable`; DELETE → `immutable`; `daftar_app` holds no UPDATE | A-12 |
| T-16 | `tests/security/settlement-s6-reversal-guard.test.ts` | a generic Phase 2 reversal of each S6 entry → `accounting.reversal_source_domain_owned`; S5's paired purchase reversal still admitted | A-14(c) |
| T-17 | `tests/integration/settlement-s6-upgrade.test.ts` | from the S5-frozen checkpoint: 0067/0068 apply; registries exactly S1…S6; S1–S5 data untouched; both gaps functions empty | upgrade |
| T-18 | `tests/integration/settlement-s6-idempotency.test.ts` | replay returns stored rows only; a different intent → conflict; a rate stated between bind and execute → `fx_rate_changed` 409; a concurrent settlement → `settlement_changed` 409, and the retry succeeds | A-15, A-16 |
| T-19 | `tests/integration/settlement-s6-reads.test.ts` | ledger AP = `purchase_ap_outstanding`, and base AP = `B − Σ rel`, after every step of a mixed scenario; supplier credit = `Σ notes − Σ allocations − Σ refunds` = stored remaining; no stored balance column (G-3 run) | AL-26 |
| T-20 | `tests/security/settlement-s6-scope.test.ts` | an assigned-scope actor: a payment over an out-of-scope purchase → 403 before minting; allocate and refund → `business_wide_scope_required`; permission matrix per A-03 | AL-39 |
| T-21 | `tests/security/settlement-s6-guard-gaps.test.ts` | `supplier_settlement_guard_gaps()` reports each of: dropped trigger, disabled, replica, replaced body, owner change, `search_path` change | R-38 |
| T-22 | `tests/performance/accounting-budgets.test.ts` (unchanged file, run in isolation) | Budget A holds with the three new `WHEN`-filtered deferred triggers | Budget A |

**Package tests:**
- `packages/inventory/test/supplier-settlement.test.ts`, `payment-method-payloads.test.ts` and `supplier-settlement-payloads.test.ts`, against the vectors;
- `packages/accounting/test/domain-posting.test.ts`, as the §7.3 row;
- `apps/api` unit tests for `InventoryAssertionSequence` (pure, no database).

---

## 7. Gate, guards and predecessor evolution

### 7.1 `scripts/phase3-s6-gate.ts` (two tenses, the form of `scripts/phase3-s4-gate.ts`)

**Constants.**
- `S5_BOUNDARY = '0066_supplier_return_reversal_commands.sql'`
- `S6_MIGRATIONS = ['0067_payment_methods_supplier_settlement_sources.sql', '0068_supplier_settlement_commands.sql']`
- `S6_ACCEPTED: Record<string,string> = {}`, filled in the freeze commit only
- `ACCEPTED = Object.keys(S6_ACCEPTED).length > 0`

**1. Boundary.**

| Tense | Checks |
|---|---|
| Candidate | `frozenThrough === S5_BOUNDARY`; neither S6 file is in the manifest; the files after 0066 are exactly `S6_MIGRATIONS` |
| Accepted | `frozenThrough ≥ '0068…'`; each file hashes to `S6_ACCEPTED` on disk and in the manifest; the range 0067–0068 holds exactly the two files |

**2. Scope** (S6 files only; `stripComments`; the `insertedTuples` scanner in its spaced-or-compact form):
- **`REGISTRATIONS`**, exactly:
  - `accounting_source_types`: `'supplier_payment'`, `'supplier_credit_allocation'`, `'supplier_refund'`;
  - `accounting_operation_kinds`: the three `('post', …)` pairs;
  - `inventory_operation_kinds`: the seven A-03 codes.
- **No insert into:**
  - `stock_source_types`, `stock_movement_kinds` or `inventory_operation_movement_kinds`;
  - `accounting_system_account_keys`, `permissions`, `role_permissions`.
- **No `CREATE OR REPLACE FUNCTION inventory_stock_source_guard_gaps`.**
- **`LATER_TABLES`:** `CREATE TABLE (payments|payment_allocations|payment_reversals|refunds|customer_\w*|credit_notes|invoice\w*|sale\w*|reservation\w*)` is refused (MP-7).
- **OD-03:** no `tax_payable` token and no column matching `tax`.
- **Tokens.** No `rounding` system-key token, no `purchase_price_variance` token, and no `round(`. `fx_gain`, `fx_loss`, `accounts_payable` and `supplier_receivable` are **required** tokens in 0067 (A-14(a)).
- **`ALLOWED_EXECUTE`** is exactly these 8 `GRANT EXECUTE` statements:
  - the seven routines `:daftar_app`;
  - `accounting_settlement_account_eligibility:daftar_inventory_internal`.
- **No role or membership change.** No `UPDATE`/`DELETE` grant except the three of A-17.
- **`ALTER TABLE` on a predecessor table only as:** `supplier_credit_notes ADD CONSTRAINT supplier_credit_notes_supplier_uq`. `ALTER POLICY` only on `supplier_credit_notes.business_isolation_read`.

**3. Required objects:**
- the six tables;
- every §2.3 trigger by name and the thirteen guard and trigger functions;
- the three arithmetic functions and two verify helpers;
- `supplier_settlement_guard_gaps(` in 0067;
- the seven routines in 0068;
- `SET LOCAL ROLE daftar_inventory_internal;[\s\S]*?CREATE OR REPLACE FUNCTION supplier_credit_note_guard\(\)[\s\S]*?\$\$;`, containing `supplier_credit_remaining_carrying`;
- `SET LOCAL ROLE daftar_accounting_internal;[\s\S]*?CREATE OR REPLACE FUNCTION accounting_reversals_20_domain_source_guard\(\)[\s\S]*?\$\$;`, containing `purchase_reversals` and all seven always-refused types;
- `CREATE OR REPLACE FUNCTION purchase_ap_outstanding(` and `purchase_settlement_state(`, each naming both allocation tables (S5 TL-9);
- the three completeness triggers;
- both CREATE brackets.

**4. Packages:**
- `supplier-settlement.ts`, `supplier-settlement-payloads.ts`, `payment-method-payloads.ts`;
- the two vector files with the §4.1 case ids;
- `DOMAIN_SOURCE_TYPES` naming the three;
- `DOMAIN_REVERSIBLE_SOURCE_TYPES` equal to `['purchase']`;
- `InventoryAssertionSequence` and `presentInventoryAssertion` exported from `apps/api/src/infra/database.ts`;
- `packages/inventory/src` still imports only itself and `node:`.

**5. Suites.**
- `SUITE_PATTERN = /^settlement-s6-.*\.test\.ts$/` in `tests/integration` and `tests/security`.
- `REQUIRED_SUITES` include:
  - `settlement-s6-payment-method` (T-03), `-payment-method-history` (T-04);
  - `-over-allocation` (T-05), `-realized-fx` (T-06), `-carrying-release` (T-07), `-credit-concurrency` (T-08);
  - `-no-customer-payments` (T-09), `-receive-and-pay` (T-13), `-upgrade` (T-17).
- At least 18 suites.

**6. Runner canary**, exactly as `phase3-s4-gate.ts`.

**7. Composition.** `npm run gate:phase3:s5` must run in its **accepted** tense. It composes S4, S3, S2, S1, P2-S8…P2-S1 and Phase 1.

**8. Run:**
- `npm run test -w @daftar/inventory`;
- `npm run test -w @daftar/accounting`;
- the `apps/api` seam unit tests;
- every discovered S6 suite;
- then `tests/performance/accounting-budgets.test.ts` in isolation. S6 adds three `WHEN`-filtered deferred triggers on `journal_entries` and extends one `IN` list in a `BEFORE INSERT` guard on `accounting_reversals`. Budget A must stay at its accepted bound.

**`package.json`:** `"gate:phase3:s6": "tsx scripts/phase3-s6-gate.ts"`, next to the S5 line.

### 7.2 Guards

| Guard | Change |
|---|---|
| **G-3 `scripts/guards/no-authoritative-balance.ts`** | **Extended; this is a finding.** At `e56d5e3` it has **no** supplier or purchase discovery: `ACCOUNTING_TABLE_NAME` and `INVENTORY_TABLE_NAME` only (`:57`, `:202`). S4C promised the AL-26 extension (L:852) and S5C §7.2 assumes it exists. If S5 does not land it, S6 does. It needs: `SUPPLIER_TABLE_NAME = /^(suppliers|supplier_[a-z0-9_]+|purchases|purchase_[a-z0-9_]+|payment_methods|payment_method_[a-z0-9_]+)$/` with forbidden columns `/(^|_)(balances?|outstanding|paid|unpaid|due|owed|payable|settled)($|_)/`, and `remaining_*` allowed (DM §7ج). Verified against 0063 and 0065d: no current column collides. Guard test: positive `supplier_credit_notes.remaining_amount_minor`, `supplier_payment_allocations.purchase_amount_applied_minor`; negative `suppliers.balance_minor`, `purchases.paid_minor`, `supplier_credit_notes.outstanding_minor` |
| Rule 22 `scripts/guards/inventory-writer-authority.ts` | `STOCK_WRITE_TABLES` holds `supplier_credit_notes` from S5. Its writers gain `0068: supplier_allocate_credit` and `0068: supplier_receive_refund`, whose first statement is the consume. No new bridge writer |
| G-7 `inventory-definer-contract.ts` | no code change. It discovers the seven routines, the helpers, the arithmetic functions and the guards, and the owner-replaced `supplier_credit_note_guard()` keeps its owner |
| G-4 `posting-surface.ts`, G-1 `journal-privilege-model.ts` | no change: no journal writer and no journal grant. The completeness functions read `journal_lines` as their owner |
| Rules 6, 7, 21; `no-float-rate.ts` | satisfied: BIGINT money, `NUMERIC(20,10)` rates, `inventory_half_even` only, `bigint` in TypeScript |

### 7.3 Predecessor pins that 0067/0068 turn red, and their evolution (ENG, the P2-S4 §45 form)

**Sequencing precondition (TL-1).** P3-S5 is accepted and frozen **before** the commit adding 0067:
- `S5_ACCEPTED` is filled;
- `frozenThrough ≥ 0066`;
- `gate:phase3:s5` is green in its accepted tense.

**Line numbers** are those of `e56d5e3`. S5's own §7.3 evolution shifts them, and the coordinator re-locates each row in the S5-frozen tree.

Every pin evolves **in the same commit** as the migration that turns it red, by the coordinator:
- earlier rows stay, verbatim and in order;
- S6 rows are **appended** with `// P3-S6 (0067/0068)`;
- nothing is deleted except where stated.

| # | Pin (file:line at `e56d5e3`) | Evolves to | Red by |
|---|---|---|---|
| 1 | `tests/integration/migration-upgrade.test.ts:467-476` (accounting types by `sort_order`) | + `supplier_payment`, `supplier_credit_allocation`, `supplier_refund` | 0067 |
| 2 | `migration-upgrade.test.ts:777-780` (P2-S6 case, `src:` rows) | + `src:supplier_payment:9`, `src:supplier_credit_allocation:10`, `src:supplier_refund:11` | 0067 |
| 3 | `migration-upgrade.test.ts:1431-1432`, `:1474-1492` (P3-S3 case: `after` and the `op:`/`acct:` registries) | + the three `src:`/`acct:` rows; + the seven `op:` rows | 0067/0068 |
| 4 | `migration-upgrade.test.ts:~1705-1760` (P3-S4 T-17: `applied = migrationsAfter(FROZEN)`, registries = checkpoint + S4, S5-evolved) | + the S6 rows; the applied list gains the two S6 files | 0067/0068 |
| 5 | `tests/integration/purchase-s4-upgrade.test.ts:175-190`, `:254` | + the S6 rows, as row 4 | 0067/0068 |
| 6 | `tests/golden-regression/phase2/01-engine-shapes.golden.test.ts:531-541` (`forbidden`) | remove **`'supplier_refunds'`** only, extending the `:524-527` comment on the `suppliers` precedent. **`payments`, `payment_allocations`, `payment_reversals`, `refunds`, `credit_notes`, `customer_credits` stay forbidden**: that is MP-7's permanent half | 0067 |
| 7 | `01-engine-shapes.golden.test.ts:549-560` (source types) | + the three, in order | 0067 |
| 8 | `tests/security/accounting-sources-authority.test.ts:107-126` | + the three `('post', …)` pairs in sort position | 0067 |
| 9 | `tests/security/journal-privilege-matrix.test.ts:325-366` (`accounting_validator` tables; `S3_HEADERS`) | + `supplier_credit_notes`, `supplier_payments`, `supplier_payment_allocations`, `supplier_credit_allocations`, `supplier_refunds`; headers + the three posting tables | 0067 |
| 10 | `tests/security/inventory-db-authority.test.ts:217-275` (internal table privileges) | + the six S6 tables with A-17's privileges | 0067 |
| 11 | `inventory-db-authority.test.ts:277-320` (column privileges) | + the `payment_methods` columns, `payment_method_names.display_name`, and the two `supplier_credit_notes.remaining_*` columns | 0067 |
| 12 | `inventory-db-authority.test.ts:~380-410` (internal-routine EXECUTE matrix) | + the seven routines → `daftar_app`; the S6 helpers and arithmetic → none | 0067/0068 |
| 13 | `tests/security/search-path-shadowing.test.ts:475-500` (`EXECUTE_MATRIX`) | + the seven signatures → `['daftar_app']`; + `accounting_settlement_account_eligibility(uuid,uuid)` → `['daftar_inventory_internal']` | 0067/0068 |
| 14 | `tests/integration/migration-portability.test.ts:1095-1230` (named owners; the accounting-owned `IN` list) | + every §2.3 function and the seven routines (inventory-owned); + the four accounting functions; `supplier_settlement_guard_gaps` migrator-owned | 0067/0068 |
| 15 | `tests/integration/inventory-db-guard.test.ts:47-140` (G-7 list; rule-22 writers) | + the S6 functions; writers + `0068: supplier_allocate_credit`, `0068: supplier_receive_refund` | 0067/0068 |
| 16 | `tests/security/inventory-s3-authority.test.ts:379-420` (registries, S4- and S5-evolved) | + the seven op kinds; mappings unchanged; gaps `[]` | 0068 |
| 17 | `tests/helpers/stock-ledger.ts:89-170` (constants, `assertMigrationState`, the rewind, the TRUNCATE list) | + `S6_OPERATION_KINDS`; migration state = S1…S6; the rewind deletes `registered_by='P3-S6'` op kinds; TRUNCATE adds, children first, `supplier_refunds`, `supplier_credit_allocations`, `supplier_payment_allocations`, `supplier_payments`, `payment_method_names`, `payment_methods`, all before S5's `supplier_credit_notes` | 0067/0068 |
| 18 | `tests/security/stock-ledger-structure.test.ts:436-447` | unchanged code; green once row 17 lands | — |
| 19 | `packages/inventory/test/payload.test.ts:219-240` | + the seven kinds | package |
| 20 | `packages/accounting/test/domain-posting.test.ts:117`, `:288-300` | + the three types; `DOMAIN_REVERSIBLE_SOURCE_TYPES` case unchanged | package |
| 21 | **S5 suites' exact-set pins** (created by S5's T agent; names per S5C §6): T-01 ACL (`daftar_app` / internal privileges exact, discovery by `supplier_%`); T-17 `purchase-s5-upgrade` (registries exactly S1…S5) | T-01: scope the discovery to the S5 table list, or append the S6 tables and the credit-note column UPDATE; T-17: + the S6 rows | 0067/0068 |
| 22 | **S5 T-07/T-08** (fixture-replaced `purchase_ap_outstanding` / `purchase_settlement_state`) | the fixture must re-install the **S6** body after each case, not S5's; the paths themselves are re-proved for real by T-12 | 0067 |
| 23 | Any S5 test asserting the **exact trigger set** of `purchase_reversals` or the **policy text** of `supplier_credit_notes` (to be confirmed in the S5-frozen tree) | + `purchase_reversals_unsettled`; + the accounting admission and `accounting_validator` | 0067 |

**Not affected:**
- `0063-E`–`0066-E`, which are apply-time.
- `migration-upgrade.test.ts:1200-1245` (P3-S2 stock registries): S6 adds no stock type or mapping.
- `stock-ledger-authority.test.ts` T-02.1 (discovery of `stock_`/`negative_` relations) and its trigger matrix: S6 adds no stock relation or binding guard.
- The S4 suites `purchase-s4-grants` and `purchase-s4-reads` (fixed lists), and `purchase-s4-tamper` T-6.
- **S5 T-15** (credit-note guard): a naked UPDATE still raises `supplier_credit_note.immutable` (A-12).
- `inventory-s3-review-fixes` F3 and S4 T-16: the stock gaps function is not replaced.
- `phase3-s1`…`s5` gate scope checks, which read their own files.
- `gate:phase2:release`.
- `tests/integration/purchasing-errors.test.ts`, which reads 0063/0064 only. S6 adds its own twin over 0067/0068, inside T-02.

**Negative proof.** Each evolved predicate stays exact. A rolled-back injection of an unauthorized row fails it:
- `accounting_source_types … 'payment'`;
- an op kind `payment.void_method`;
- a table `payments`.

---

## 8. File ownership (SAFE_CONCURRENCY = 4, SM:44)

| Agent | Owns (writes) | Must not touch |
|---|---|---|
| **C: coordinator** | this contract; the S5 freeze (TL-1) and later the S6 `MIGRATION_MANIFEST.json` entries (freeze commit only); **every §7.3 pin** (rows 1–23, including `tests/helpers/stock-ledger.ts` and the two package test files); `scripts/phase3-s6-gate.ts` and the `package.json` line; the G-3 extension (if S5 did not land it) and its test; the rule-22 writer rows; `docs/DAFTAR_STATE_MACHINES.md` (method lifecycle; credit note remaining); `docs/DAFTAR_TRANSACTION_MAP.md` §9 (AL-24 correction, if not yet made); `TECHNICAL_DEBT.md` (TL-2, TL-3 entries); `PROJECT_STATUS.md`; `docs/PHASE_3_S6_ACCEPTANCE.md` | migrations; `src/**` |
| **M: migration writer** (the only schema writer, SM:36) | `infrastructure/database/migrations/0067_payment_methods_supplier_settlement_sources.sql`, `0068_supplier_settlement_commands.sql` | everything else |
| **D: domain/application, API and packages** (SM:44 merges D and A for S6) | `packages/inventory/src/{supplier-settlement,supplier-settlement-payloads,payment-method-payloads}.ts`; the additive edits of `payload.ts`, `errors.ts`, `index.ts` (coordinator sign-off); `packages/inventory/vectors/{invpl-s6,supplier-settlement}-vectors.json` and their `packages/inventory/test/*.test.ts`; `packages/accounting/src/post.ts` (`DOMAIN_*`) and `index.ts`; `apps/api/src/infra/database.ts` (A-19) and its unit test; `apps/api/src/modules/payment-methods/**`; the §4.3 purchasing files; `inventory-authorization.ts` (seven rows); `packages/shared-contracts/src/{payment-methods,supplier-settlement}.ts` | migrations; tests outside `packages/*/test` and the seam unit test; predecessor tests |
| **T: tests** | `tests/helpers/supplier-settlement.ts`; every §6 T-file (`tests/integration/settlement-s6-*.test.ts`, `tests/security/settlement-s6-*.test.ts`) | predecessor tests (they belong to C), `src/**`, migrations |

**Merge order** (SM:64):
1. **C:** contract adopted; S5 frozen; D-1 confirmed against frozen 0065.
2. **M:** 0067 with C's rows 1, 2, 3 (`src`), 6–11, 14, 17, 21, 22, 23 (one green commit). Then 0068 with rows 3 (`op`), 4, 5, 12, 13, 15, 16.
3. **D:** packages (with rows 19–20), the seam, then services and controllers.
4. **T:** suites. T may start once step 2 lands.
5. **C:** gate, guards, acceptance page, the independent security review (SM:49), then the S6 freeze commit.

---

## 9. Real blockers and Tech Lead notes

### 9.1 Real blockers

**None.** Each candidate was checked against the six categories:
- **Product-constitution ambiguity:** none. AL-27 left one choice open (the account policy), and AL-27 itself requires this slice to take it (A-06, TL-6).
- **Legal or tax rule:** **OD-03** is bounded. S6 carries no tax, and every tax element is marked BLOCKED BY OD-03 (A-21).
- **Paid provider / external credential:** none. Payment methods are ledger routing, not gateways, so OD-04 is untouched. There is no FX provider (OD-11 manual). TD-10 is unchanged.
- **Destructive data decision:** none. The one new constraint on an S5 table contains its PK. No row is changed by a migration.
- **Architectural contradiction:** none, **subject to D-1.**

**D-1 · A sequencing dependency on S5, which becomes a blocker only if broken.**
- S6 relies on three S5 facts:
  1. `supplier_returns.ap_released_before_txn_minor` exists (0065d R-43, `0065d:161`);
  2. S5's `supplier_return_value_complete()` verifies `ap_base` from **that column**, not from a re-derivation over earlier returns (`0065d:636-651`);
  3. `purchase_return` computes `O` through `purchase_ap_outstanding` (S5C A-10(c)).
- **Why they matter.** With these, S5 returns and S6 settlements chain through one definition, and S6 changes no S5 digest.
- **If S5 is frozen otherwise** (for example, a guard summing earlier returns' `ap_txn` to obtain X), every return after a payment would be refused at COMMIT. S6 would then have to replace an S5 guard, changing an S5 body after its acceptance. That is an architectural contradiction between AL-30 (AP first against outstanding AP) and the frozen S5 guard.
- **Action (coordinator, now):** confirm 1–3 in 0065/0066 before the S5 freeze.

### 9.2 Tech Lead notes (engineering rulings to confirm)

- **TL-1 · Sequencing.** S5 must be accepted and frozen before 0067 (the S6 gate's candidate tense). The S5 §7.3 pins and S5 suites must exist, because S6 evolves them. The credit-note column list in A-12/§2.4 must be re-checked against frozen 0065.
- **TL-2 · No payment, allocation or refund reversal in S6.**
  - The lock does not ask for one (AL-28/31). The generic Phase 2 reversal of an S6 entry is refused (A-14(c)), because it would leave the allocation row standing and AP double-counted.
  - **Consequence:** PM-12's stated recovery ("reverse the offending allocation through the atomic reversal path") has no path in Phase 3. A mistaken payment is correctable only by a later slice.
  - **Recommendation:** record it in `TECHNICAL_DEBT.md` and schedule `supplier.reverse_payment` (DM §7 `reverse_payment_allocation` shape) no later than Phase 4, when customer payments bring the twin.
- **TL-3 · Fully allocated payments; no supplier advance.** DM §12 has no advance entity, and AL-28 speaks only of payments that settle AP. An advance would need a new asset source (supplier prepayments) and a sixth accounting identity. A merchant who pays before receiving records the payment at receipt (AL-24).
- **TL-4 · Payment-method commands under `invctl/1`.** They are the S4 supplier pattern: signed, with a payload digest and routine-owned writes. The alternative is plain `daftar_app` DML with RLS and a guard, which would make payment methods the only Phase 3 master data writable without an assertion. The permission is `accounting.chart.manage`, because the command binds a GL account. The alternatives are `settings.manage` or `suppliers.pay`.
- **TL-5 · Credit consumption is business-wide.** A credit note is a supplier-level asset, readable only business-wide (S5C A-19). A refund brings money into a business-level account. The alternative is scope over the target and origin purchases' warehouses.
- **TL-6 · The account policy** is asset, active, and `system_key` NULL or one of the five settlement keys (A-06). The alternative is the five keys only, which refuses a merchant's second bank account.
- **TL-7 · No default payment methods are seeded.** Seeding would touch provisioning (AL-53) and the backfill of every business. S7's UX creates the first method on demand.
- **TL-8 · Realized-FX readings.**
  - **(a)** A same-rate, same-currency payment can show a ±1 minor-unit realized FX (A-09). AL-28 classifies every carrying difference as realized FX and forbids 6100.
  - **(b)** When the payment and purchase currencies differ, the merchant states both amounts. Any commercial discount they embed appears as FX. A discount is not modelled in Phase 3.
- **TL-9 · Sub-unit stranding.** When one minor unit of a note's currency converts to 0 base minor units (a very strong base), a remaining amount `r` with `conv(r) = 0` cannot be consumed (`…amount_below_base_unit`). It is stranded until a larger consumption covers it. This is the S5 TL-3 rule applied to consumption. It is unreachable for the pilot currencies.
- **TL-10 · Ids are the idempotency keys** (DM §12's `idempotency_key` column is not created), per the S4/S5 precedent.
- **TL-11 · AL-24 via an inventory-assertion sequence.** It is a seam change and a sibling of R-B1. The alternative is two transactions, which AL-24/AL-32 forbid, or one combined routine and op kind, which violates "each routine accepts exactly one `op_code`" (L:1928).
- **TL-12 · DM columns not created on refunds:** `rounding_difference_minor` (AL-28 forbids 6100), `direction`, `status`.
- **TL-13 · Inactive supplier.** A payment is refused (AL-40: "not selectable for a new payment"). Credit allocation and refund are allowed: they consume existing value and create no new credit (the S5 TL-14 reading).
- **TL-14 · Purchase-level AP first, carried from S5 TL-10.** The chain and every allocation are per purchase. "Supplier AP" (L:848) is their sum, read live.
- **TL-15 · Header rule numbering.** S5C's R-34..R-38 collide with 0063's R-34..R-41. Recommend S5's acceptance page cite them as `0065 R-34…`. S6 uses R-60.. to stay clear.
- **TL-16 · Stored `remaining_*` versus AL-26 derivation.** AL-26 says supplier credit is derived. S5 stores `remaining_*` because DM §7ج and AL-31 require the locked pair on the row. S6 keeps it and **proves** it equal to the derivation at every COMMIT (`supplier_credit_note_verify`), so it is a verified lock target, not a second truth.
- **TL-17 · OD-07 (revaluation)** is out of Phase 3. Open foreign AP and credit notes stay at their historical carrying value until settled, when the difference is realized.
