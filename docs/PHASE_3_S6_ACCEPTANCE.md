# DAFTAR — P3-S6 Acceptance / قبول الشريحة السادسة من المرحلة الثالثة

> **What this is.** The evidence page for slice **P3-S6: payment methods and supplier settlement** (`docs/PHASE_3_EXECUTION_PLAN.md` §8), built to `docs/PHASE_3_S6_CONTRACT.md`. It maps each "Must prove" item to its permanent test, records the independent security review, and lists the rulings and what stays open. The Phase 3 coordinator accepted and froze P3-S6 under the Tech Lead's 2026-09-26 directive to complete Phase 3. The Tech Lead's own verdict is reserved for the single Phase 3 final report.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P3-S6، وتشمل:
> - أساس طرق الدفع المشترك (`payment_methods` و`payment_method_names`) وحساب ترحيل نشط من نفس النشاط؛
> - دفعات الموردين مخصَّصة بالكامل على مشتريات مستلمة، بقيد واحد لكل تخصيص؛
> - فروق الصرف المحققة على `4900`/`6900` فقط؛
> - تخصيص رصيد المورّد (الإشعار الدائن) على شراء، واسترداده نقدًا، دون استهلاك زائد؛
> - أمر "استلام ودفع" واحد في معاملة واحدة.
>
> جُمِّدَت هجرتاها `0067` و`0068`.

## 0. Status: ACCEPTED (internal) / FROZEN

- **Candidate head:** `59ddc5b52d2c285692a7e6f1d510234212969320`. It is green on all five jobs of `DAFTAR CI` run `36307397970` (attempt 1), on that exact SHA.
- **Freeze:** the same commit does all of the following:
  - appends `0067` and `0068` to `MIGRATION_MANIFEST.json`, with `frozenThrough = 0068_supplier_settlement_commands.sql` and 69 migrations frozen;
  - fills `S6_ACCEPTED` in `scripts/phase3-s6-gate.ts`.
- **CI:** runs `gate:phase3:s6`, which composes `gate:phase3:s5` and the chain back to Phase 1.

| migration | SHA-256 | state |
|---|---|---|
| `0067_payment_methods_supplier_settlement_sources.sql` | `81363f1adf8a296b94690baee4766bcacfa72520477b26f8044cccda398fe660` | FROZEN |
| `0068_supplier_settlement_commands.sql` | `dafad8c698b8668eef24b38315117b3813ceeeaad7cc84b9089ab66b3be89a04` | FROZEN |

`gate:phase3:s6` was proven red before it was trusted (§5).

## 1. What P3-S6 delivers

| migration | delivers |
|---|---|
| `0067` | **Tables.** `payment_methods`, `payment_method_names`, `supplier_payments`, `supplier_payment_allocations`, `supplier_credit_allocations` and `supplier_refunds`, with RLS (ENABLE + FORCE, per-command restrictive business policies) and the A-18 grant matrix.<br><br>**Guards.** Header, line, value and same-transaction guards, each judging INSERT as well as UPDATE and DELETE; the settlement-account policy (R-65); the purchase chain (R-62) verified at COMMIT; credit consumption and its chain (R-63); realized FX on `4900`/`6900` only (R-64).<br><br>**Owner replacements.** The credit-note guard (R-66, which now admits one backed decrement of both remaining values), the reversal guard (R-68) and the two S5 extension points `purchase_ap_outstanding` / `purchase_settlement_state` (R-67), which now count both allocation tables.<br><br>**R-80.** A deferred constraint trigger on the S5 table `supplier_returns` proves a return's AP position against the S6 chain at COMMIT (§3).<br><br>**Discovery.** The replaced `inventory_stock_source_guard_gaps()`, keeping every 0065 digest except the credit-note guard's (which changed), and the new `supplier_settlement_guard_gaps()` (R-70). |
| `0068` | **Entry routines.** Seven: `payment_method_create`, `payment_method_update`, `payment_method_deactivate`, `payment_method_activate`, `supplier_pay`, `supplier_allocate_credit` and `supplier_receive_refund`. Each consumes its `invctl/1` assertion over a digest of all its arguments as its first statement.<br><br>**Helpers.** The credit-note consumer `supplier_credit_note_consume` (R-73, 0066 R-55's shape), with no grantee.<br><br>**Rules.** Allocation ids are idempotency keys and accounting source ids (R-74); a missing scalar argument is a stable refusal (R-75); the payment and refund currency rule (R-76); S6 never creates a sub-unit residue (R-77, R-78).<br><br>**Discovery and end state.** `supplier_settlement_guard_gaps()` re-created with sha256 digests of the extension points and the consumer, and reporting any that is not INVOKER (R-79). Seven operation kinds and three accounting source types (`supplier_payment`, `supplier_credit_allocation`, `supplier_refund`). End-state block 0068-E. |

**API.**
- `/v1/payment-methods` (create, update, deactivate, activate, list, read); `POST /v1/supplier-payments`, `/v1/supplier-credit-allocations` and `/v1/supplier-refunds`; the reads `GET /v1/supplier-payments/:id`, `/v1/suppliers/:id/payments` and `/v1/purchases/:id/settlements`; and receive-and-pay under `/v1/purchases` (P3-AL-24). Each is behind its Phase 3 permission, with strict DTOs.
- Every posting goes through the existing Accounting Core generic primitive, one entry per allocation.
- The A-19 inventory-assertion sequence (`InventoryAssertionSequence` in `apps/api/src/infra/database.ts`) lets receive-and-pay carry two ordered single-use inventory assertions in one transaction.

## 2. Must-prove → test

| plan bullet (§8) | test |
|---|---|
| a payment method cannot be created or activated without a valid, same-business, active posting account of an acceptable type | `integration/settlement-s6-payment-method.test.ts` |
| a used payment method cannot be deleted, and deactivating it does not change any posted entry | `integration/settlement-s6-payment-method-history.test.ts` |
| over-allocation is impossible under concurrency | `integration/settlement-s6-over-allocation.test.ts` |
| realized FX lands on `4900`/`6900` and never on `6100` or `6200` | `integration/settlement-s6-realized-fx.test.ts` |
| partial consumption releases carrying base proportionally; the final consumption releases the entire residue | `integration/settlement-s6-carrying-release.test.ts`, `integration/settlement-s6-residue.test.ts` |
| two concurrent consumers of one supplier credit cannot overconsume it | `integration/settlement-s6-credit-concurrency.test.ts` |
| no Customer Payments exist | `security/settlement-s6-no-customer-payments.test.ts` |

**Also covered:**

| area | suite |
|---|---|
| entry shapes | `settlement-s6-entries`, `settlement-s6-gold` |
| atomicity under the three failpoints | `settlement-s6-atomicity` |
| idempotency | `settlement-s6-idempotency` |
| reads | `settlement-s6-reads` |
| receive-and-pay (P3-AL-24) | `settlement-s6-receive-and-pay` |
| S5 re-proved under S6, R-80 included | `settlement-s6-s5-reproof` |
| the A-19 seam | `settlement-s6-seam` |
| upgrade from a frozen 0066 checkpoint | `settlement-s6-upgrade` |
| the replaced credit-note and reversal guards | `security/settlement-s6-credit-note-guard`, `security/settlement-s6-reversal-guard` |
| grants and ACL | `security/settlement-s6-grants` |
| guard-gap discovery | `security/settlement-s6-guard-gaps` |
| another tenant and a second business of the same owner | `security/settlement-s6-isolation` |
| warehouse and branch scope | `security/settlement-s6-scope` |
| signed authority for all seven routines | `security/settlement-s6-signed-authority` |
| the OD-03 boundary | `security/settlement-s6-tax` |

In total, 25 P3-S6 suites with 221 tests.

## 3. Independent security review

The review ran on the integrated candidate with its own probes. It found **no High finding and one Medium**. It found sound:
- signed authority on all seven routines, and the A-19 seam (no deadlock);
- A-17 exact, FORCE RLS with per-command restrictive policies, settlement-account eligibility;
- isolation from another tenant and from a second business of the same owner; branch scope;
- no overpayment and no overconsumption under concurrency; half-even money;
- realized FX only on `4900`/`6900`; the S5 interplay; no leaks; OD-03; no customer payments.

| id | finding | closure |
|---|---|---|
| M1 (Medium) | a sub-unit AP residue was reachable with the seeded pilot currencies (TRY in an ILS business at 0.11: paying 4999 of 5000 leaves 1 kurus that converts to 0 agora), after which the purchase could be neither paid, returned nor reversed | S6 never creates one (R-77, R-78): pay, allocate and refund refuse `supplier_payment.residue_below_base_unit`, `supplier_credit_allocation.residue_below_base_unit` and `supplier_refund.residue_below_base_unit`, and the COMMIT guards mirror the rule. A residue that frozen S5 can still leave is **TD-16** (§4) |
| I1 (Info) | runtime discovery did not see the INVOKER extension points or the credit-note consumer | `supplier_settlement_guard_gaps()` now digests `purchase_ap_outstanding`, `purchase_settlement_state` and `supplier_credit_note_consume`, and reports `function_not_invoker` (R-79). Accounting-side objects and policies stay pinned by 0067-E, the S4/S5 precedent |
| I2 (Info) | 0067 replaces `inventory_stock_source_guard_gaps()` | the coordinator's ruling, a consequence of 0065 R-53; the S6 gate requires every 0065 digest kept except the credit-note guard's, which must change; sound |
| I3 (Info) | the payment-method GET routes carry `@Membership` only | the service's any-of reader check enforces the permission; probed 403 / 404 / 200 correctly |

**The suites found one product defect (R-62 → R-80).** A return whose AP position `X` forgot a committed payment passed every S5 guard, because 0065 R-54 only compares a return with other returns. R-80 adds the deferred trigger `supplier_returns_value_settled` on `supplier_returns`, which proves the return against the full S6 chain at COMMIT and refuses `supplier_payment.settlement_inconsistent`. It verifies only when the purchase carries an S6 allocation, so every frozen S5 behaviour and fixture is unchanged. No 0065 or 0066 byte changed.

**Guard extension.** G-3 (`no-authoritative-balance`) now also discovers the payment-method tables and refuses stored settlement words (`outstanding`, `paid`, `unpaid`, `due`, `owed`, `payable`, `settled`) on supplier, purchase and payment-method storage (contract §7.2). It is clean on 0000–0068 and was proven red on a planted `payment_methods.settled_minor`.

## 4. Rulings and deviations for the Tech Lead

- **TL-2 … TL-17 were adopted as engineering rulings** (the contract's header). TL-2, no payment, allocation or refund reversal in Phase 3, is **TD-15**.
- **TL-11**, the inventory-assertion sequence (A-19), is a sibling of the S4 R-B1 seam. **CONFIRMED** (Tech Lead corrective directive §12, 2026-09-28): the seam, atomicity and concurrency suites (`purchase-s4-seam`, the S4 atomicity suite, `settlement-s6-seam`, the S6 atomicity suite, receive-and-pay concurrency) stay green at the corrected candidate of the Phase 3 corrective pass.
- **The S5 L2 residue.** A txn-only AP residue that converts to ≥ 1 base unit is absorbed by the final allocation, and AP reaches exactly 0 in txn and base (R-69 (a)). A sub-unit residue cannot be cleared by any allocation under the base > 0 journal law. S6 never creates one (R-77); one left by a frozen S5 partial return is recorded as **TD-16** with its exact boundary.
- **R-80 is conditional.** It verifies a return only when its purchase carries an S6 allocation. An unconditional check would re-judge S5 fixtures that are lawful in S5's own terms.
- **OD-03 stays bounded.** No settlement carries tax; tax rates and tax posting are **BLOCKED BY OD-03**.
- **Deviations recorded by the implementers.**
  - The payment-method GET routes use service-level any-of authorization (I3).
  - The golden vectors are generated by committed scripts, and include a JOD/LBP vector.
  - receive-and-pay answers the receipt's and the payment's own refusal codes.
  - The gaps discovery uses sha256 digests and discovers 18+ functions.
  - The rewind helper keeps the S6 operation kinds; `accounting_settlement_account_eligibility` stays out of `EXECUTE_MATRIX`, since its only grantee is the internal principal.
- **R-numbers.** The migration headers record R-60 … R-80.

## 5. Regression

The candidate `59ddc5b` was checked locally on a fresh embedded PostgreSQL.

- **`npm run gate:phase3:s6`: PASS.** It composes the following, and was proven red before it was trusted:
  - P3-S5 … P3-S1, P2-S8 … P2-S1 and Phase 1;
  - the two package suites and the seam unit tests;
  - every P3-S6 suite;
  - Budget A in isolation (p95 ≤ 15 ms, unchanged).
- **`tests/integration` + `tests/security`:** 3308/3308 (198 files).
- **Static checks:** format, typecheck, lint, the static guards and the migration manifest check are all clean.

**The accepted tense.** It was proven red on:
- a wrong accepted digest for `0067`;
- a one-line change to `0068`.

## ملخص

صار بإمكان التاجر:
- تعريف طرق الدفع وربط كل منها بحساب نقدية أو بنك نشط من نفس النشاط؛
- دفع مستحقات المورّد جزئيًا أو كليًا على مشتريات مستلمة؛
- استعمال رصيده لدى المورّد (الإشعار الدائن) لسداد شراء آخر، أو استرداده نقدًا؛
- الاستلام والدفع في أمر واحد.

فروق الصرف المحققة تذهب إلى حسابَي أرباح وخسائر الصرف فقط. لا يمكن الدفع بأكثر من المستحق، ولا استهلاك الرصيد مرتين، حتى مع الطلبات المتزامنة. كل عملية ذرّية.

راجعها مراجع أمني مستقل: لا خلل عاليًا، وملاحظة متوسطة واحدة (بقايا صرف أقل من وحدة) أُغلقت، وبقي أثرها من مرتجعات S5 دَينًا تقنيًا مسجلًا (TD-16). وكشفت الاختبارات خللًا واحدًا (مرتجع يتجاهل دفعة سابقة) وأُصلح.
