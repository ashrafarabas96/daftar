# DAFTAR — Project Status / حالة المشروع

> Owned by the Lead Engineering Coordinator (Agent 0). Updated at each slice boundary. The source of truth remains the code, then the tests, then CI, then the migrations, then the documents.

## Where the project stands

| phase | state | evidence |
|---|---|---|
| Phase 1 | accepted, released | `docs/PHASE_1_ACCEPTANCE_REPORT.md` |
| Phase 2 — accounting core | **merged and closed** into `main` at `0f2b09e7f2bd1015053ff2cb79ad1ceafc25bc6f`; 53 migrations frozen through `0052` | `docs/PHASE_2_S9_RELEASE.md` |
| P3-S0 — architecture lock | accepted at `ec08307d95ab0a50f826624a4e848d2c53398e51` (55 decisions) | `docs/PHASE_3_ARCHITECTURE_LOCK.md` |
| **P3-S1 — inventory and catalog primitives** | **READY FOR TECH LEAD REVIEW** — candidates `0053`–`0058`, not frozen | `docs/PHASE_3_S1_ACCEPTANCE.md` |
| P3-S2 — immutable stock ledger | **not authorized**; analysis only | `docs/PHASE_3_S2_PREPARATION.md` |

Work branch: `phase/3-inventory-purchases-suppliers`, draft PR #4 into `main`. The exact candidate head and its CI run are recorded in the PR.

## Open blockers and debt

- P3-AL-23 / OD-03 — purchase tax: bounded, non-zero tax refused until decided.
- TD-08 — `main` has no branch protection (external: repository settings).
- TD-10 — symmetric assertion signing, bounded to `merchant-api`.
- TD-12, TD-13, TD-14 — findings of the P3-S1 security review outside the inventory domain. Full register: `TECHNICAL_DEBT.md`.

## Next allowed step

The Tech Lead's decision on P3-S1. Nothing else: no freeze, no `0059`, no P3-S2 code.

## ملخص

المرحلة الثانية مدموجة ومغلقة. الشريحة P3-S1 (أساسيات المخزون) جاهزة لمراجعة القائد التقني، وهجراتها `0053`–`0058` مرشّحة غير مجمّدة. P3-S2 غير مصرّح بها. الخطوة التالية الوحيدة هي قرار القائد التقني.
