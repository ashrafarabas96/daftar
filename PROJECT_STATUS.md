# DAFTAR — Project Status / حالة المشروع

> Owned by the Lead Engineering Coordinator (Agent 0). Updated at each slice boundary. The source of truth remains the code, then the tests, then CI, then the migrations, then the documents.

## Where the project stands

| phase | state | evidence |
|---|---|---|
| Phase 1 | accepted, released | `docs/PHASE_1_ACCEPTANCE_REPORT.md` |
| Phase 2 — accounting core | **merged and closed** into `main` at `0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f` | `docs/PHASE_2_S9_RELEASE.md` |
| P3-S0 — architecture lock | accepted at `ec08307d95ab0a50f826624a4e848d2c53398e51` (55 decisions) | `docs/PHASE_3_ARCHITECTURE_LOCK.md` |
| **P3-S1 — inventory and catalog primitives** | **PASS / CLOSED**: accepted at `f1cc4c47a43defa969d7beff7f1c795189eee1c1` (CI 36223470804); migrations `0053`–`0058` **frozen** in `39e4ebc59d488b3d59b2136a38538e6de0d7b3b9` | `docs/PHASE_3_S1_ACCEPTANCE.md` |
| P3-S2 — immutable stock ledger | **next unopened slice**: not started, not authorized; analysis only | `docs/PHASE_3_S2_PREPARATION.md` |

- Migrations: 59 frozen, `frozenThrough = 0058_accounting_entry_date_guard.sql`. No `0059` exists.
- Tests at P3-S1 acceptance: integration 2011/2011 (105 files), golden 73/73; `gate:phase3:s1` PASS, composing the Phase 1 gate and P2-S1…P2-S8.
- Work branch: `phase/3-inventory-purchases-suppliers`, draft PR #4 into `main`. The sealed head and its exact-SHA CI run are recorded in the PR.

## Open decisions and debt

- **OD-03 — purchase tax: OPEN.** Not a blocker for P3-S1, which was accepted without it. It is a hard dependency, with official-source evidence, before any slice that implements purchase-tax calculation, tax posting, tax-inclusive/exclusive purchases or jurisdiction-specific purchase tax. Until then a non-zero purchase tax is refused (P3-AL-23).
- TD-08 — `main` has no branch protection (external: repository settings).
- TD-10 — symmetric assertion signing, bounded to `merchant-api`.
- TD-12, TD-13, TD-14 — findings of the P3-S1 security review outside the inventory domain; open and non-blocking for P3-S1. Full register: `TECHNICAL_DEBT.md`.

## Agent limit

`MAX_ACTIVE_AGENTS = 6` (Tech Lead, 2026-09-26). An analysis or preparation agent counts toward the six while active.

## Next allowed step

Submit P3-S2 to the owner for authorization. Nothing else: no `0059`, no P3-S2 code.

## ملخص

المرحلة الثانية مدموجة ومغلقة. الشريحة P3-S1 (أساسيات المخزون) مقبولة ومغلقة، وهجراتها `0053`–`0058` مجمّدة. الشريحة التالية P3-S2 لم تبدأ وتنتظر تصريح المالك. القرار OD-03 (ضريبة الشراء) مفتوح.
