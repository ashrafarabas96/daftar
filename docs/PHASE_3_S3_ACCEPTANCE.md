# DAFTAR — P3-S3 Acceptance / قبول الشريحة الثالثة من المرحلة الثالثة

> **What this is.** The evidence page for slice **P3-S3 — transfers, adjustments, damage, stocktake and inventory opening** (`docs/PHASE_3_EXECUTION_PLAN.md` §5), built to `docs/PHASE_3_S3_CONTRACT.md`. It maps each "Must prove" item to its permanent test, records the independent security review and the bugs the suites found, and lists what stays open. P3-S3 was accepted and frozen by the Phase 3 coordinator under the Tech Lead's 2026-09-26 directive to complete Phase 3; the Tech Lead's own verdict is reserved for the single Phase 3 final report.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P3-S3: التحويل بين المستودعات، والتسوية، والتلف، والجرد، والرصيد الافتتاحي للمخزون. هي أول شريحة تُرحِّل قيودًا محاسبية عبر نواة المحاسبة القائمة. جُمِّدَت هجرتاها `0061` و`0062`.

## 0. Status: ACCEPTED (internal) / FROZEN

- Candidate head: `344ae38` (full SHA and its `DAFTAR CI` run in PR #4), green on all five jobs on that exact SHA.
- Freeze: `0061` and `0062` appended to `MIGRATION_MANIFEST.json` (`frozenThrough = 0062_inventory_movement_commands.sql`, 63 frozen) and `S3_ACCEPTED` filled in `scripts/phase3-s3-gate.ts` in the same commit. CI runs `gate:phase3:s3`, which composes `gate:phase3:s2` and the chain back to Phase 1.

| migration | SHA-256 | state |
|---|---|---|
| `0061_inventory_movement_sources.sql` | `7b785537a866606990ab2cfab2a783eb05fe7fb362a67f9ea127119d569f57ff` | FROZEN |
| `0062_inventory_movement_commands.sql` | `dc47df235cc563606705de2a3a991992e573486bfa8d6a8493eb744129bb4b91` | FROZEN |

`gate:phase3:s3` was proven red before it was trusted: a planted source type, an extra `EXECUTE` grant and a supplier table are each refused.

## 1. What P3-S3 delivers

| migration | delivers |
|---|---|
| `0061` | TD-13 (the accounting and provisioning prunes run only under `pg_try_advisory_xact_lock`); the strengthened `inventory_stock_source_guard_gaps()` (table, timing, events, enabled state, function by name and by a recorded `prosrc` digest, FK target table and columns, `WHEN` and `UPDATE OF`); eight document tables and four bridges with binding, completeness, freeze, header-immutability and value-completeness guards; four stock source types; the accounting sources `inventory_adjustment` and `inventory_opening` with their `post` kinds, entry-completeness triggers (Case A checks each warehouse's Dr amount against that warehouse's stored split), the reversal guard and the opening-balance guard; the zero-stock archival triggers; RLS (ENABLE + FORCE, restrictive business policy) and the A-18 grant matrix; end-state block 0061-E |
| `0062` | seven entry routines (`inventory_transfer_stock`, `inventory_adjust_stock`, `inventory_record_damage`, `inventory_stocktake_open`, `_count`, `_finalize`, `inventory_record_opening`), each consuming its `invctl/1` assertion over a digest of all of its arguments as its first statement; `daftar_app` `EXECUTE` on those seven only; four helpers with no grantee; seven operation kinds and six operation→movement mappings; end-state block 0062-E |

The API adds eight routes under `/v1/inventory` (transfers, adjustments, damages, stocktakes open/count/finalize/cancel, openings), each behind its Phase 3 permission, with strict DTOs and money and quantities as strings. Postings go through the existing Accounting Core's generic primitive; there is no new journal writer.

## 2. Must-prove → test

| plan bullet (§5) | test |
|---|---|
| transfer: valuation delta exactly zero, including an emptied source; GOLD-44 | `integration/inventory-s3-transfer.test.ts` |
| transfer opens the non-posting seam and mints no accounting assertion | same; `integration/inventory-s3-atomicity.test.ts` |
| the nine-state transfer completeness vector, each by its own mechanism | `integration/inventory-s3-transfer.test.ts` |
| end-to-end atomicity: stock, journal, binding, audit and outbox in one commit | `integration/inventory-s3-atomicity.test.ts` (failures injected after the routine and after the posting leave nothing; the same request then commits) |
| transfer creates no journal entry, by count | `integration/inventory-s3-transfer.test.ts` |
| an unreachable destination is refused even with a reachable source | `security/inventory-s3-isolation.test.ts`, `security/inventory-s3-http.test.ts` |
| stocktake: intervening movements do not corrupt the variance; finalizing twice applies once | `integration/inventory-s3-stocktake.test.ts`, `integration/inventory-s3-concurrency.test.ts` |
| positive variance on a zero-cost key → `inventory.unit_cost_required` | `integration/inventory-s3-stocktake.test.ts` |
| Case B off by one minor unit is refused with no journal entry | `integration/inventory-s3-opening.test.ts`, `security/inventory-s3-http.test.ts` (see §4 on "both totals reported") |
| Case B writes no journal entry, by count | `integration/inventory-s3-opening.test.ts` |
| a crash between movement and posting leaves nothing | `integration/inventory-s3-atomicity.test.ts` |
| the evolved source-type assertions fail on an unauthorized source type | `security/accounting-sources-authority.test.ts`, `golden-regression/phase2/01-engine-shapes.golden.test.ts` (exact sets) |

Also: authority and tamper matrix, replay, and the bridge helper out of reach (`security/inventory-s3-authority.test.ts`); another tenant and a second business of the same owner for every routine and route (`security/inventory-s3-isolation.test.ts`); idempotency proven before any stock read, a stored replay after the average moves, and a replay that consumes no accounting assertion (`integration/inventory-s3-idempotency.test.ts`); two-connection races (`integration/inventory-s3-concurrency.test.ts`); archival against cache and ledger (`integration/inventory-s3-archival.test.ts`); all 28 guard sabotages per source type reported (`security/inventory-s3-source-guards.test.ts`); TD-13 (`integration/inventory-s3-prune.test.ts`); the review fixes (`integration/inventory-s3-review-fixes.test.ts`, `integration/inventory-opening-authority.test.ts`).

## 3. Independent security review and bugs found by the suites

| id | finding | closure |
|---|---|---|
| F1 (High) | a Case B inventory opening could stay bound to an opening balance whose entry was reversed (either order), leaving GL Inventory ≠ Σ movement values with no repair path | the reversal guard refuses reversing a bound balance's entry (`accounting.opening_balance_inventory_bound`); a reversed balance has no position, so Case B cannot bind it; both orders proven with two connections; the global lock order is in the 0061 R-13 header |
| F2 (Low) | a concurrent identical opening was refused instead of replayed | a per-id advisory key before the header read |
| F3 (Low) | the guard discovery missed disabled per-type triggers, a re-pointed bridge FK and a replaced function body | the discovery checks the whole per-type set, FK targets and a `prosrc` digest |
| F4 (Info) | an opening revealed an accounting position to a warehouse-limited actor | openings require business-wide scope; the mismatch carries the code only |
| T-1 | the Case A entry check did not bind each warehouse's debit to the opening | `inventory_openings` stores its per-warehouse split; the entry must match it exactly (R-15) |
| T-2 | stocktake replays answered the replaying request's trace | `stocktakes` stores its open and close traces (R-16) |
| T-3 | `inventory.stocktake_empty` was unreachable | the empty check runs before the intent digest |
| T-4 | a variant-only product without a variant gave 404; an upper-case stocktake path id was lower-cased | `variant_required` (400); strict lowercase path ids |

## 4. Rulings and deviations for the Tech Lead

- **B-1 (open).** Superseding a posted inventory opening is refused (`inventory.opening_state_invalid`). The lock has no operation kind or movement mapping for it and does not say what happens once stock has moved; a wrong opening is corrected with a reasoned adjustment. Carried to the Phase 3 final report.
- **Plan §5 "both totals reported".** Security review F4 removed the two totals from the Case B mismatch response, because they disclose an accounting position; the refusal is still counted and writes nothing.
- Stocktake cancel is signed under `inventory.stocktake_finalize` with an `outcome` field (TL-3); the reason is bound as eight uint32 words of its SHA-256 (TL-4); no server retry on `inventory.valuation_changed` (TL-5).
- The migration headers record R-1 … R-16 where the implementation differs from the contract's first text; the contract was amended for F1–F4.

## 5. Regression

`npm run gate:phase3:s3` PASS locally, composing P3-S2, P3-S1, P2-S8 … P2-S1 and Phase 1; `tests/integration` + `tests/security` 2598/2598 (132 files); format, typecheck and lint clean; Tier 1 budget A p50 5.96 ms, p95 9.75 ms against 15 ms.

## ملخص

صار بإمكان التاجر تحويل المخزون بين المستودعات، وتسجيل التسويات والتلف، وإجراء الجرد، وإدخال الرصيد الافتتاحي، وكل عملية تُرحِّل قيدها المحاسبي في المعاملة نفسها أو لا يحدث شيء. راجعها مراجع أمني مستقل ووجد خللًا عاليًا واحدًا أُغلق، ووجدت الاختبارات ثلاثة أخطاء أُصلحت. قرار واحد معلَّق للمالك: تصحيح رصيد افتتاحي مُرحَّل (B-1)، وهو مرفوض صراحةً حتى يُقرَّر.
