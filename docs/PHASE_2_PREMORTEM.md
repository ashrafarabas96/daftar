# DAFTAR — Phase 2 Pre-mortem / تشريح مسبق للمرحلة الثانية

> Written before any Phase 2 code exists. "Imagine Phase 2 failed — why?" Each failure names the Phase 1 asset that prevents it and the rule to keep.
>
> **Scope note (normalized 2026-09-21).** Phase 2 is **Accounting & Financial Core only**, per `DAFTAR_IMPLEMENTATION_ROADMAP.md`. Inventory, purchases and suppliers are Phase 3; sales, POS, customers, debts and installments are Phase 4. Scenarios below that concern those domains are kept because they shape the *interfaces* Phase 2 must expose, and each is labelled with the phase that will exercise it.

## Scenario 1 — "The ledger doesn't balance and nobody noticed for weeks" (Phase 2)

- Cause: posting done in application code with partial writes; reconciliation added late.
- Prevention: debit = credit is enforced at the database boundary (deferred constraint trigger over the entry's lines), not only in the service. The journal is append-only. Every posting writes its lines and its outbox event in ONE transaction, exactly as `outbox.test.ts` already proves for business events. Trial balance is a read model derived from the journal, never an independent writable total.

## Scenario 2 — "Two operations posted the same source twice" (Phase 2)

- Cause: a retry, a duplicated queue message or a double click produced two journal entries for one business fact.
- Prevention: `(business_id, source_type, source_id)` is unique on posted entries; posting is idempotent by construction and returns the existing entry on replay. This mirrors the onboarding idempotency contract (`provision_replay_operation`) that Phase 1 already ships and tests.

## Scenario 3 — "Money drifted by a fils" (Phase 2)

- Cause: a `Number` sneaked into a total, or a client rounded.
- Prevention: `bigint` minor units end-to-end, `BigDecimal` on Android, static guard 6b, money tests at 18 digits. Rule: every new money column is `bigint` + currency, every total is computed server-side, goldens include JOD (3 decimals).

## Scenario 4 — "Foreign-currency numbers could not be explained months later" (Phase 2)

- Cause: the rate used at posting time was not stored, so restating the entry became guesswork.
- Prevention: every foreign-currency line stores the transaction amount, the base-currency amount, the rate, the rate source and the rate timestamp. Manual rate is the default; an automatic provider is optional and must not become a dependency (`DAFTAR_MULTI_CURRENCY.md`, OD-11).

## Scenario 5 — "A merchant saw another merchant's journal" (Phase 2)

- Cause: a reporting query bypassed RLS through a platform pool "for performance".
- Prevention: `db-privileges.test.ts` and static guard 13 fail if merchant runtime code touches the platform pool. Accounting tables carry `business_id` with the same RLS policy shape as catalog, and cross-business posting is impossible by FK + policy.

## Scenario 6 — "A posted entry was edited to fix a mistake" (Phase 2)

- Cause: an "edit" endpoint looked harmless.
- Prevention: posted entries are immutable at trigger level (the same pattern that freezes published plan versions). Corrections are reversal entries or new correcting entries, both auditable and both pointing at the original.

## Scenario 7 — "Migration 0041 destroyed data on rollback" (Phase 2)

- Cause: a contract step without expand/migrate; the app rolled back across a column drop.
- Prevention: `0036` is the worked example (validate copy → drop) and `PHASE_1_MIGRATION_HISTORY_DECISION.md` records the rollback boundaries. Rule: every destructive step lands two releases after the expand step.

## Scenario 8 — "Sales shipped before accounting could carry it" (Phase 4, shaped now)

- Cause: the operational domain grew its own money tables because the engine was not ready.
- Prevention: Phase 2 must ship a posting API that a later domain can call without modification: `post(sourceType, sourceId, lines[], date, currency, rate?)`. Phase 4 writes no financial truth of its own.

## Scenario 9 — "Inventory valuation and the ledger disagreed" (Phase 3, shaped now)

- Cause: stock value maintained separately from the accounts.
- Prevention: inventory movements post through the accounting engine; the ledger is the authority, inventory keeps quantities. Reconciliation compares, it does not correct silently.

## Scenario 10 — "Phase 2 ran out of time on tooling" (Phase 2)

- Cause: CI/DB/gate rebuilt per feature.
- Prevention: `gate:phase1:release`, `check:db-from-zero` and CI-from-zero are feature-agnostic. Phase 2 adds tests and migrations; it does not touch the gate.

## Scenario 11 — "The Android app duplicated a financial action on retry" (Phase 4/7, shaped now)

- Cause: request rebuilt on retry.
- Prevention: `RequestSpec` replay with the same `Idempotency-Key` (`RetryContractTest.kt`). Rule: every money-moving request carries a key generated once per user action and persisted before send.

## Entry conditions for Phase 2

1. Phase 1 PASS with evidence (`PHASE_1_ACCEPTANCE_REPORT.md`) **and the Tech Lead's explicit approval of the Phase 1 pull request**.
2. Open P0/P1/security P2 = 0.
3. Accounting rules, multi-currency, transaction map, data model, source-of-truth matrix, state machines and golden-suite documents exist and are unchanged since Phase 0.
4. Performance baseline recorded, so the money core can be compared against it.
5. `PHASE_2_ACCOUNTING_EXECUTION_PLAN.md` reviewed and accepted as the execution contract.
6. **`PHASE_2_ARCHITECTURE_LOCK.md` approved by the Tech Lead.** It resolves AL-01…AL-18 — the eighteen decisions that must be settled before migration `0040` exists — and wins over the execution plan wherever the two differ. Implementation starts at slice P2-S1, not before.
