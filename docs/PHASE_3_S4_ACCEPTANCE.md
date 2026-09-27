# DAFTAR — P3-S4 Acceptance / قبول الشريحة الرابعة من المرحلة الثالثة

> **What this is.** The evidence page for slice **P3-S4 — suppliers, purchases, receiving, landed cost and deficit coverage** (`docs/PHASE_3_EXECUTION_PLAN.md` §6), built to `docs/PHASE_3_S4_CONTRACT.md`. It maps each "Must prove" item to its permanent test, records the independent security review, and lists the rulings and what stays open. P3-S4 was accepted and frozen by the Phase 3 coordinator under the Tech Lead's 2026-09-26 directive to complete Phase 3; the Tech Lead's own verdict is reserved for the single Phase 3 final report.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P3-S4: الموردون، والمشتريات من المسودة إلى الاستلام، والتكلفة المُحمَّلة، وقيد المخزون مقابل الذمم الدائنة عند الاستلام، وتغطية العجز السالب في معاملة الاستلام نفسها. جُمِّدَت هجرتاها `0063` و`0064`.

## 0. Status: ACCEPTED (internal) / FROZEN

- Candidate head: `d0bed50` (full SHA and its `DAFTAR CI` run in PR #4), green on all five jobs on that exact SHA.
- Freeze: `0063` and `0064` appended to `MIGRATION_MANIFEST.json` (`frozenThrough = 0064_purchase_commands.sql`, 65 frozen) and `S4_ACCEPTED` filled in `scripts/phase3-s4-gate.ts` in the same commit. CI runs `gate:phase3:s4`, which composes `gate:phase3:s3` and the chain back to Phase 1.

| migration | SHA-256 | state |
|---|---|---|
| `0063_purchases_suppliers_sources.sql` | `bf505fbad5ac4b32d1de2dba729fcd61f7a0651b3b99c8f38e5c2c4980c0a5fe` | FROZEN |
| `0064_purchase_commands.sql` | `b82e01810568390d21156ae555a7fbd35a990e33d8b280361bc85eaa6c7074ad` | FROZEN |

`gate:phase3:s4` was proven red before it was trusted (§5).

## 1. What P3-S4 delivers

| migration | delivers |
|---|---|
| `0063` | six tables (`suppliers`, `purchases`, `purchase_lines`, `purchase_landed_costs`, `purchase_landed_cost_allocations`, `negative_inventory_cost_adjustments`) and two bridges, with RLS (ENABLE + FORCE; per-command restrictive business policies, R-35) and the A-18 grant matrix; the supplier, header, line, landed-cost and allocation guards, each judging INSERT as well as UPDATE and DELETE (R-34, R-39); the deferred line, header, value and allocation completeness triggers; the coverage header/detail model with its same-transaction guard (R-36); the replaced `inventory_stock_source_guard_gaps()` keeping all sixteen P3-S3 digests verbatim and reporting every P3-S4 guard (R-38); two stock source types; the accounting side (the purchase and catch-up entry-completeness triggers, the owner-replaced reversal guard naming four domain types, the `accounting_purchase_fx_rate` snapshot read reachable by the internal principal only) and two accounting source types; end-state block 0063-E |
| `0064` | seven entry routines (`supplier_create`, `_update`, `_archive`, `_reactivate`, `purchase_save_draft`, `purchase_cancel`, `purchase_receive`), each consuming its `invctl/1` assertion over a digest of all its arguments as its first statement; `daftar_app` `EXECUTE` on those seven only; three helpers with no grantee; seven operation kinds and two operation→movement mappings; end-state block 0064-E |

The API adds thirteen routes under `/v1/suppliers` and `/v1/purchases`, each behind its Phase 3 permission, with strict DTOs and money and quantities as strings. A receipt posts `Dr Inventory / Cr AP` through the existing Accounting Core's generic primitive, and, when it covers a deficit, the catch-up entry in the same transaction (R-B1, §4).

## 2. Must-prove → test

| plan bullet (§6) | test |
|---|---|
| one line covering three deficit layers writes three coverage movements with distinct `source_line_id`s; the one catch-up entry equals Σ stored values; a replay writes nothing | `integration/purchase-s4-coverage.test.ts` (T-08.2), `integration/purchase-s4-idempotency.test.ts` |
| receipt atomicity: purchase, lines, movements, cache, coverage, journal, binding, audit and outbox in one commit; a failure injected after each step leaves nothing | `integration/purchase-s4-atomicity.test.ts` |
| per-line integer shares sum exactly to the base total; `Dr Inventory = Cr AP`, no plug, no `6100` line | `integration/purchase-s4-receipt.test.ts` |
| a cash-labelled and a credit purchase produce the same entry shape | `integration/purchase-s4-receipt.test.ts` |
| `by_value` with a zero denominator refuses; `manual` off by one minor unit refuses | `integration/purchase-s4-landed-cost.test.ts` |
| Σ allocations = landed-cost total exactly, with the `line_no` tie-break | `integration/purchase-s4-landed-cost.test.ts` (package vectors) |
| a received purchase refuses `UPDATE`/`DELETE` (and `INSERT`) on header, lines and allocations, as owner too | `integration/purchase-s4-immutability.test.ts` |
| a retried receive creates no second movement or entry | `integration/purchase-s4-idempotency.test.ts` |
| coverage oldest-first; GOLD-72 reproduces; two concurrent receipts cover disjoint quantities | `integration/purchase-s4-coverage.test.ts`, `integration/purchase-s4-concurrency.test.ts` |
| non-zero purchase tax refused with `purchase.tax_policy_absent` | `security/purchase-s4-tax.test.ts` (HTTP before minting, the signed routine, the table CHECK) |
| a foreign purchase keeps its own FX snapshot after the rate changes | `integration/purchase-s4-fx.test.ts` |

Also: signed authority and tamper matrix (`security/purchase-s4-signed-authority.test.ts`); grants and ACL (`security/purchase-s4-grants.test.ts`); another tenant and a second business of the same owner for every routine and route (`security/purchase-s4-isolation.test.ts`); the HTTP authority matrix (`security/purchase-s4-http.test.ts`); the R-B1 seam (`integration/purchase-s4-seam.test.ts`); supplier lifecycle, draft, reads, deferred tamper guards and the guard-gap report for all seventeen S4 guard rows (`integration/purchase-s4-{supplier,draft,reads,tamper,gaps}.test.ts`); the upgrade from a frozen 0062 checkpoint with books and stock (`integration/purchase-s4-upgrade.test.ts`, `integration/migration-upgrade.test.ts`); the error mapping table (`integration/purchasing-errors.test.ts`). 20 P3-S4 suites, 224 tests.

## 3. Independent security review

The review ran on the integrated candidate before the suites were written, with its own probes. It found no High finding.

| id | finding | closure |
|---|---|---|
| M1 (Medium) | received and cancelled purchases accepted INSERTs of lines, landed costs and allocations | the freeze triggers and the header guard judge INSERT; a purchase is born a draft (R-34, R-39) |
| M2 (Medium) | `purchase.not_found` / `state_invalid` answered 400 through a suffix heuristic | an explicit code→status table from contract §3; an unknown code is a typed failure |
| L1 (Low) | the internal principal's DELETE was not isolated by business | per-command restrictive policies; only reads admit the internal principal (R-35) |
| L2 (Low) | a coverage detail could be appended to a committed header | same-transaction guard; the covering line must exist; the header value check fires on coverage insert (R-36, R-41) |
| L3 (Low) | two separate pre-reads let a legitimate race surface as a defect code | one snapshot; a concurrent change is `inventory.valuation_changed` |
| I1–I3 (Info) | the gaps report missed some guards; the flush exemption depended on scope settings; a COMMIT refusal surfaced as a generic 400 | all guards reported (R-38); fail-closed on scope (R-37); typed `accounting.inventory_detail_missing` |

The fixer also found and closed one gap outside the report: `purchases` accepted an owner INSERT of a row already `received` (R-39). The suites found no product defect.

## 4. Rulings and deviations for the Tech Lead

- **B-1 → R-B1 (Tech Lead confirmation requested, 2026-09-26).** Seam 2 takes a non-empty ordered tuple of accounting assertions, each coherence-checked before a connection is taken, each set for exactly one posting and single-use; an unused or missing assertion is refused. A one-element tuple is the previous seam. No SQL change: each accounting assertion still authorizes one journal entry.
- TL-3 … TL-12 adopted as engineering rulings (the contract's header): `supplier.reactivate` as its own kind; supplier mutations permission-only and the payable read business-wide; a zero catch-up writes no movement; the zero-crossing flush; one coverage header per receipt; `purchase.total_zero`; discounts per line only.
- **OD-03 stays bounded.** A non-zero purchase tax is refused at the DTO, the service, the routine and the table CHECK. Tax rates, inclusive/exclusive rules and tax posting are **BLOCKED BY OD-03**.
- The migration headers record R-15 … R-41 where the implementation differs from the contract's first text, among them R-25 (the receipt calls the stock primitive twice and does not pre-lock stock levels; the concurrency suites and the review found no deadlock or lost update) and the INSERT-judging trigger types (31 where the contract said 27).

## 5. Regression

On the candidate `d0bed50`, locally on a fresh embedded PostgreSQL: `npm run gate:phase3:s4` PASS, composing P3-S3, P3-S2, P3-S1, P2-S8 … P2-S1 and Phase 1, the two package suites, every P3-S4 suite and Budget A in isolation (p95 ≤ 15 ms, unchanged). `tests/integration` + `tests/security` 2877/2877 (153 files). Format, typecheck, lint, the static guards and the migration manifest check are clean. The gate was proven red on a wrong accepted digest and on a one-line change to `0064` in its accepted tense.

## ملخص

صار بإمكان التاجر إدارة الموردين، وإنشاء مسودات الشراء مع التكلفة المُحمَّلة، واستلام البضاعة. كل استلام يُرحِّل قيد المخزون مقابل الذمم الدائنة في المعاملة نفسها، ويغطي أي عجز سابق في المخزون بقيد تسوية ثانٍ في المعاملة ذاتها، أو لا يحدث شيء. الضريبة غير الصفرية مرفوضة حتى يُحسم القرار OD-03. راجعها مراجع أمني مستقل ولم يجد خللًا عاليًا، وأُغلقت كل النتائج المتوسطة والمنخفضة، ولم تكشف الاختبارات أي خلل في المنتج.
