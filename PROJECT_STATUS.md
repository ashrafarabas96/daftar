# DAFTAR — Project Status / حالة المشروع

> Owned by the Lead Engineering Coordinator (Agent 0). Updated at each slice boundary. The source of truth remains the code, then the tests, then CI, then the migrations, then the documents.

## Where the project stands

| phase | state | evidence |
|---|---|---|
| Phase 1 | accepted, released | `docs/PHASE_1_ACCEPTANCE_REPORT.md` |
| Phase 2 — accounting core | **merged and closed** into `main` at `0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f` | `docs/PHASE_2_S9_RELEASE.md` |
| P3-S0 — architecture lock | accepted at `ec08307d95ab0a50f826624a4e848d2c53398e51` (55 decisions) | `docs/PHASE_3_ARCHITECTURE_LOCK.md` |
| **P3-S1 — inventory and catalog primitives** | **ACCEPTED (PASS)** at `f1cc4c47a43defa969d7beff7f1c795189eee1c1` (CI 36223470804); migrations `0053`–`0058` **frozen** in `39e4ebc59d488b3d59b2136a38538e6de0d7b3b9`. The seal was BLOCKED by `gate:phase2:release`'s stale "no migration after `0052`" check; on the Tech Lead's decision (2026-09-26) that one check was corrected to the Phase 2 prefix invariant (acceptance page §6, `docs/PHASE_2_S9_RELEASE.md` §5.3) | `docs/PHASE_3_S1_ACCEPTANCE.md` |
| **P3-S2 — immutable stock ledger** | **ACCEPTED (internal) / FROZEN** under the Tech Lead's 2026-09-26 directive to complete Phase 3 (candidate `4d0ed0b`, exact-SHA CI in PR #4); migrations `0059`–`0060` frozen; `gate:phase3:s2` permanent. Independent security review: 1 high, 2 medium, 3 low findings confirmed and closed | `docs/PHASE_3_S2_ACCEPTANCE.md` |
| P3-S3 — transfers, adjustments, stocktake, opening | **in progress** (contract, then implementation) | `docs/PHASE_3_SLICE_MAP.md` |

- Migrations: 61 frozen, `frozenThrough = 0060_inventory_stock_primitive.sql`.
- Tests at the corrected release gate (local, fresh PostgreSQL, inside `gate:phase2:release`): integration 2096/2096 (108 files; +18 for `tests/security/phase2-release-prefix.test.ts`), golden 73/73; `check:db-from-zero --release` 59 migrations applied, rerun applies 0, history clean, tamper refused. Locally the gate reaches the Android step, which needs the Android SDK and so runs only on GitHub; the full gate result on the exact head is the release-evidence run recorded in PR #4. After the freeze, at `648e1fb`: integration 2078/2078 (107 files), `gate:phase3:s1` PASS, budget A p95 6.63 ms against 15 ms.
- Work branch: `phase/3-inventory-purchases-suppliers`, draft PR #4 into `main`. The sealed head and its exact-SHA CI run are recorded in the PR.

## Open decisions and debt

- **OD-03 — purchase tax: OPEN.** Not a blocker for P3-S1, which was accepted without it. It is a hard dependency, with official-source evidence, before any slice that implements purchase-tax calculation, tax posting, tax-inclusive/exclusive purchases or jurisdiction-specific purchase tax. Until then a non-zero purchase tax is refused (P3-AL-23).
- TD-08 — `main` has no branch protection (external: repository settings).
- TD-10 — symmetric assertion signing, bounded to `merchant-api`.
- TD-12, TD-13, TD-14 — findings of the P3-S1 security review outside the inventory domain; open. TD-13 is owned by P3-S3, TD-12 by P3-S8, TD-14 stays outside Phase 3 unless P3-S8 absorbs it (`docs/PHASE_3_SLICE_MAP.md` §5). Full register: `TECHNICAL_DEBT.md`.

## Agent limit

`MAX_ACTIVE_AGENTS = 6` (Tech Lead, 2026-09-26). An analysis or preparation agent counts toward the six while active.

## Next allowed step

On 2026-09-26 the Tech Lead directed the completion of Phase 3, P3-S2 through P3-S9, slice by slice, stopping at the Phase 3 boundary with one final report; no Phase 4 work and no merge of PR #4. The next step is P3-S3. `gate:phase2:release` protects the Phase 2 prefix `0000`–`0052` and permits later migrations.

## ملخص

المرحلة الثانية مدموجة ومغلقة. الشريحة P3-S1 (أساسيات المخزون) مقبولة، وهجراتها `0053`–`0058` مجمّدة، وتوقّف الختم بسبب فحص قديم في بوابة `gate:phase2:release` كان يمنع أي هجرة بعد `0052`، فصُحِّح بقرار المالك إلى حماية بادئة المرحلة الثانية `0000`–`0052` مع السماح بالهجرات اللاحقة. الشريحة P3-S2 (دفتر المخزون) مقبولة داخليًا بموجب توجيه المالك بإكمال المرحلة الثالثة، وهجرتاها `0059`–`0060` مجمّدتان. العمل جارٍ على P3-S3. القرار OD-03 (ضريبة الشراء) مفتوح.
