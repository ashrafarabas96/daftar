# DAFTAR — P3-S5 Acceptance / قبول الشريحة الخامسة من المرحلة الثالثة

> **What this is.** The evidence page for slice **P3-S5: supplier returns, PPV, supplier credit notes and purchase reversal** (`docs/PHASE_3_EXECUTION_PLAN.md` §7), built to `docs/PHASE_3_S5_CONTRACT.md`. It maps each "Must prove" item to its permanent test, records the independent security review, and lists the rulings and what stays open. The Phase 3 coordinator accepted and froze P3-S5 under the Tech Lead's 2026-09-26 directive to complete Phase 3. The Tech Lead's own verdict is reserved for the single Phase 3 final report.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P3-S5، وتشمل:
> - مرتجع المورّد بمتوسط التكلفة الحالي للمستودع الذي تغادره البضاعة؛
> - تجميد القيمة الدفترية الأصلية لسطر الشراء، وتحميل الفرق على فروق أسعار الشراء `6200`؛
> - تخفيض الذمم الدائنة أولًا، ثم إصدار إشعار دائن للمورّد على `1150` بالفائض؛
> - عكس الشراء بتكلفة الاستلام الأصلية (قرار قائد الفريق).
>
> جُمِّدَت هجرتاها `0065` و`0066`.

## 0. Status: ACCEPTED (internal) / FROZEN

- **Candidate head:** `bb091d906a6cbf82b691f79b00287ee5fbaf6f5c`. It is green on all five jobs of `DAFTAR CI` run `36292533165` (attempt 1), on that exact SHA.
- **Freeze:** the same commit does all of the following:
  - appends `0065` and `0066` to `MIGRATION_MANIFEST.json`, with `frozenThrough = 0066_supplier_return_reversal_commands.sql` and 67 migrations frozen;
  - fills `S5_ACCEPTED` in `scripts/phase3-s5-gate.ts`.
- **CI:** runs `gate:phase3:s5`, which composes `gate:phase3:s4` and the chain back to Phase 1.

| migration | SHA-256 | state |
|---|---|---|
| `0065_supplier_returns_reversals_sources.sql` | `fbf674d2663854da31024932df428ec9d16ccdbda15d3c83a10dbcf554b95e68` | FROZEN |
| `0066_supplier_return_reversal_commands.sql` | `a9d5e6175a99677db33ebbadfac6ac41310fbc97cbc8390ac669534679eeef9e` | FROZEN |

`gate:phase3:s5` was proven red before it was trusted (§5).

## 1. What P3-S5 delivers

| migration | delivers |
|---|---|
| `0065` | **Tables.** Five tables: `supplier_returns`, `supplier_return_lines`, `supplier_credit_notes`, `purchase_reversals` and `purchase_reversal_lines`. Two stock-source bridges. RLS (ENABLE + FORCE, with per-command restrictive business policies) and the A-18 grant matrix.<br><br>**Guards.** Header, line, quantity-bound, value and same-transaction guards, each judging INSERT as well as UPDATE and DELETE. The insert-only credit-note guard. The deferred completeness and value triggers. The replaced `inventory_stock_source_guard_gaps()`, which keeps every P3-S3 and P3-S4 digest verbatim and reports every P3-S5 guard, the credit-note immutability guard included (R-53).<br><br>**R-B1a.** The owner replacement of the stock primitive: a `purchase_reversal` movement takes exactly the negation of its paired `purchase` movement, with the residue guard.<br><br>**Accounting side.** The owner-replaced reversal guard, which names the purchase and supplier-return domain types; the `supplier_return` entry-completeness trigger; and `accounting_purchase_entry_id`, reachable by the internal principal only.<br><br>**Sources and end state.** Two stock source types and one accounting source type (`supplier_return`). End-state block 0065-E. |
| `0066` | **Entry routines.** Two, `purchase_return` and `purchase_reverse`. Each consumes its `invctl/1` assertion over a digest of all its arguments as its first statement. `daftar_app` holds `EXECUTE` on these two and on the two S6 extension points (`purchase_ap_outstanding`, `purchase_settlement_state`, which are INVOKER).<br><br>**Helpers.** Four, with no grantee: `purchase_lock_stock_keys`, `purchase_bridge_return`, `purchase_bridge_reversal`, and the credit-note writer `purchase_bridge_credit_note` (R-55).<br><br>**Registrations and end state.** Two operation kinds and two operation→movement mappings. End-state block 0066-E. |

**API.**
- A return posts `Dr AP / Cr Inventory / ±PPV (6200)` through the existing Accounting Core generic primitive. Any excess over the purchase's outstanding AP goes to `Dr 1150` and a supplier credit note.
- A reversal posts through the accepted Phase 2 reversal workflow (`accounting_post_reversal`, R-B2a).
- The API adds the return, reversal, credit-note and payable routes under `/v1/purchases` and `/v1/suppliers`, each behind its Phase 3 permission, with strict DTOs.

## 2. Must-prove → test

| plan bullet (§7) | test |
|---|---|
| cumulative returned quantity may not exceed the purchased quantity of the line | `integration/purchase-s5-quantity-bound.test.ts` (T-04: sequential, concurrent, `CUMULATIVE-THIRDS`, and the deferred guard against a tampered owner insert) |
| a return that would drive the source key negative is refused | `integration/purchase-s5-stock-bound.test.ts` (T-05: nothing written; an exact flush to valuation 0) |
| returning from a warehouse other than the original destination succeeds when authorized, and is refused when not | `integration/purchase-s5-stock-bound.test.ts` (T-06), `security/purchase-s5-http.test.ts` (403 `inventory.warehouse_out_of_scope` with no assertion minted) |
| a return whose value exceeds outstanding AP debits AP by exactly the outstanding amount and puts the excess on `1150`, never negative AP and never revenue | `integration/purchase-s5-ap-first.test.ts` (T-07, including `AP-EXHAUSTED` and SQL/TS parity) |
| each of the four purchase-reversal preconditions refuses independently, with its own stable code | `integration/purchase-s5-reversal-preconditions.test.ts` (T-08 (a)–(f); each refusal leaves no row) |
| a purchase reversal removes exactly the value the receipt added, at the original receipt cost | `integration/purchase-s5-reversal-exact.test.ts` (T-09, including an intervening receipt at another cost on the same key) |

**Also covered:**

| area | suite |
|---|---|
| return posting shape (T-03) | `purchase-s5-return-posting` |
| concurrency (T-10) | `purchase-s5-concurrency` |
| idempotency (T-11) | `purchase-s5-idempotency` |
| reads (T-12) | `purchase-s5-reads` |
| atomicity (T-13) | `purchase-s5-atomicity` |
| FX and dust (T-14) | `purchase-s5-fx` |
| tamper (T-15) | `purchase-s5-tamper` |
| guard-gap report for all fifteen S5 rows (T-16) | `purchase-s5-gaps` |
| upgrade from a frozen 0064 checkpoint (T-17) | `purchase-s5-upgrade`; `migration-upgrade` |
| grants and ACL (T-01) | `security/purchase-s5-grants` |
| signed authority, including R-54 and R-55 (T-02) | `security/purchase-s5-signed-authority` |
| HTTP authority (T-18) | `security/purchase-s5-http` |
| another tenant and a second business of the same owner | `security/purchase-s5-isolation` |
| the OD-03 boundary | `security/purchase-s5-tax` |
| the race-lost unique key (L3) | `integration/purchasing-errors.test.ts` |

In total, 19 P3-S5 suites with 183 tests.

## 3. Independent security review

The review ran on the integrated candidate with its own probes. It found **no High and no Medium finding**. Every integrity identity it probed held exactly:
- GL Inventory = Σ movement values = Σ cache;
- the PPV identity;
- AP clears to 0 in txn and base;
- credit notes are insert-only.

| id | finding | closure |
|---|---|---|
| L1 (Low) | the gaps function did not see the credit-note immutability guard | the row is added with its digest, and 0065-E probes it disabled and body-replaced (R-53, per 0063 R-38 "the discovery sees every guard"; this overrides the contract's §2.3 exclusion) |
| L2 (Low) | under TL-3, the last units of a very small foreign line can convert to 0 base and are refused (`supplier_return.amount_below_base_unit`), leaving a txn-only AP residue with base 0 | unavoidable under the base-> 0 journal law and the 0043 rate law; recorded as a consequence of TL-3. **P3-S6's settlement must be able to clear a txn-only AP residue**, which is carried into the P3-S6 contract rulings |
| L3 (Low) | a client line id shared by two racing returns answered a raw 409 naming the constraint | a 23505 on `supplier_return_lines_pkey` or `supplier_credit_notes_pkey` is mapped through the explicit table to the routine's own refusal, and a real concurrent HTTP test proves it |
| I1 (Info) | the accounting-side S5 objects are pinned by 0065-E, not rediscovered at runtime | the S4 precedent (0063:2123); accepted |
| I2 (Info) | `accounting_purchase_entry_id` (R-45) has no scope check | its ACL is the internal principal only, and both callers pass a verified business; no leak |
| I3 (Info) | an actor scoped to the return warehouse can read the carrying/AP split of the purchase | sanctioned by TL-5 and A-18 |
| I4 (Info) | the reversal answers 403 for an out-of-scope purchase and 404 for an unknown one | same as the S4 receipt; accepted |
| I5 (Info) | `ap_released_before_txn_minor` was never cross-checked | at COMMIT, the value guard now requires it to be ≥ Σ AP released by the purchase's other-transaction returns, and Σ ≤ T (R-54); a forged value is refused and nothing is written |

**Additional changes.**
- **Credit-note writer (R-55).** The rule-22 writer-authority guard now counts `supplier_credit_notes` as a stock write table, as contract §7.2 required. For that to pass without weakening the rule's "arguments call nothing" check, the credit-note INSERT moved into its own asserted helper.
- **S4 guard work landed late.** Two guard extensions required by the S4 contract §7.2 were not implemented in P3-S4 and landed here:
  - G-3 now also discovers supplier and purchase storage and refuses AP-balance words;
  - rule 22 now watches `negative_inventory_cost_adjustments`.

  Both were found by the P3-S6 contract analysis. Both are clean on 0000–0066 and proven red on planted violations.

**The suites found no product defect.**

## 4. Rulings and deviations for the Tech Lead

- **B-1 / B-2 were decided by the Tech Lead** (2026-09-26, "at the original cost").
  - **R-B1a:** the primitive's owner replacement removes exactly the paired receipt value.
  - **R-B2a:** the reversal goes through `accounting_post_reversal`; `purchase_reversal` is a stock source only.
- **TL-2 … TL-14 were adopted as engineering rulings** (the contract's header):
  - "reversed" is derived;
  - FX dust and `amount_below_base_unit`;
  - the reversal needs `purchases.receive` plus warehouse scope;
  - return scope is the return warehouse, with one warehouse per return;
  - a covering receipt is not reversible;
  - `valuation_residue`;
  - AP-first at purchase level;
  - landed cost is carrying value;
  - `value_zero`;
  - credit notes are insert-only in S5;
  - an inactive supplier may only reduce AP.
- **OD-03 stays bounded.** A return or reversal carries no tax. Tax rates and tax posting are **BLOCKED BY OD-03**.
- **R-54 limitation.** R-54 recognises "this transaction" by `(created_at, business_transaction_id)`, the 0063 R-36 rule. A caller that set two traces inside one database transaction would get a false refusal. The API cannot do that, since each request is one transaction with one trace.
- **`purchaseSettlement` read has no route yet.** It exists for P3-S6.
- **R-numbers.** The migration headers record R-42 … R-55 wherever the implementation differs from the contract's first text.

## 5. Regression

The candidate `bb091d9` was checked locally on a fresh embedded PostgreSQL.

- **`npm run gate:phase3:s5`: PASS.** It composes the following, and was proven red before it was trusted:
  - P3-S4, P3-S3, P3-S2, P3-S1, P2-S8 … P2-S1 and Phase 1;
  - the two package suites;
  - every P3-S5 suite;
  - Budget A in isolation (p95 ≤ 15 ms, unchanged).
- **`tests/integration` + `tests/security`:** 3074/3074 (172 files).
- **Static checks:** format, typecheck, lint, the 22 static guards and the migration manifest check are all clean.

**The accepted tense.** It was proven red on:
- a wrong accepted digest for `0065`;
- a one-line change to `0066`.

**Harness fix.** The full run first aborted after its first file with vitest's `Timeout calling "onTaskUpdate"`. The cause was `inventory-db-guard`, whose synchronous guard cases now take more than 60 s in one fork, so its event loop never ran and the fork could not answer the runner. `tests/helpers/setup.ts` now yields one macrotask after each test. The timeout was proven with the yield removed and gone with it. No test budget or timeout changed.

## ملخص

صار بإمكان التاجر:
- إرجاع البضاعة إلى المورّد من أي مستودع مصرّح له به، بمتوسط تكلفة ذلك المستودع؛
- عكس عملية شراء كاملة بتكلفة استلامها الأصلية.

عند الإرجاع:
- تنخفض الذمم الدائنة أولًا؛
- إذا زادت قيمة المرتجع على المستحق للمورّد، يُسجَّل الفائض إشعارًا دائنًا لصالح التاجر؛
- يذهب فرق السعر إلى فروق أسعار الشراء.

كل عملية ذرّية: إمّا أن تكتمل كلها أو لا يحدث شيء.

راجعها مراجع أمني مستقل ولم يجد خللًا عاليًا ولا متوسطًا، وأُغلقت الملاحظات المنخفضة الثلاث. ولم تكشف اختبارات الشريحة أي خلل في المنتج.
