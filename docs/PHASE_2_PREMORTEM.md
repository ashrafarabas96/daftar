# DAFTAR — Phase 2 Pre-mortem / تشريح مسبق للمرحلة الثانية

> Written at Phase 1 closure, BEFORE any Phase 2 code exists. "Imagine Phase 2 failed — why?" Each failure names the Phase 1 asset that prevents it and the rule to keep.

## Scenario 1 — "The ledger doesn't balance and nobody noticed for weeks"

- Cause: journal posting done in application code with partial writes; reconciliation added late.
- Prevention: the outbox + audit patterns already commit business change and event atomically (`outbox.test.ts`); Phase 2 must post journals in the SAME transaction as the sale and add the balance invariant test on day one (Golden 01–08 in `DAFTAR_GOLDEN_REGRESSION_SUITE.md`). No silent reconciliation fixes (`DAFTAR_OBSERVABILITY.md` §3).

## Scenario 2 — "Two cashiers sold the last unit"

- Cause: stock read then written without a lock; RLS made people assume the DB "handles it".
- Prevention: the quota engine already shows the pattern (`assertCanConsume` under `FOR UPDATE` + advisory lock; `quota-race.test.ts`). Inventory movements must follow it and ship with a concurrency test from `concurrency-matrix.test.ts`'s template.

## Scenario 3 — "Money drifted by a fils"

- Cause: a `Number` sneaked into a total, or a client rounded.
- Prevention: `bigint` minor units end-to-end, `BigDecimal` on Android, static guard 6b, money tests at 18 digits. Rule: any new money field is `bigint` + currency, every total computed server-side, goldens with JOD (3 decimals).

## Scenario 4 — "Idempotency worked for onboarding but not for payments"

- Cause: each team invented its own key semantics.
- Prevention: `provision_replay_operation` / `persist_operation` define replay = 200 same result, mismatch = 409 `IDEMPOTENCY_KEY_REUSED`, incomplete = 409 `IDEMPOTENCY_CONFLICT`. Phase 2 financial POSTs must use a generalised `operations` table with the same three outcomes and the same tests.

## Scenario 5 — "A merchant saw another merchant's invoice"

- Cause: a reporting query bypassed RLS through a platform pool "for performance".
- Prevention: `db-privileges.test.ts` and static guard 13 fail if merchant runtime code touches the platform pool. Rule: reports run as `daftar_app` with tenant context; heavy reads get read replicas, never bypass.

## Scenario 6 — "Storefront launch took the API down"

- Cause: public traffic hit the merchant-api process.
- Prevention: runtime composition is per process; a `storefront` mode gets its own pool sizes, limiter buckets and readiness. Rule: no public route in `MerchantApiModule`.

## Scenario 7 — "Migration 0041 destroyed data on rollback"

- Cause: contract step without expand/migrate; app rolled back across a column drop.
- Prevention: `0036` is the worked example (validate copy → drop) and `PHASE_1_MIGRATION_HISTORY_DECISION.md` records the rollback boundary. Rule: every destructive step lands two releases after the expand step.

## Scenario 8 — "The Android app duplicated sales on retry"

- Cause: request rebuilt on retry.
- Prevention: `RequestSpec` replay with the same `Idempotency-Key` (`RetryContractTest.kt`). Rule: every Phase 2 mutation from Android carries a key generated once per user action, persisted before send (offline sync in Phase 4 builds on this).

## Scenario 9 — "The WhatsApp queue silently dropped statements"

- Cause: a job with retries but no dead-letter visibility.
- Prevention: delivery worker pattern (status/attempts/lease/dead-letter + operations page). Rule: no worker without a dead-letter view.

## Scenario 10 — "Phase 2 ran out of time on tooling"

- Cause: CI/DB/gate rebuilt per feature.
- Prevention: `gate:phase1:release` and CI DB-from-zero are feature-agnostic. Rule: Phase 2 adds tests and migrations; it does not touch the gate.

## Entry conditions for Phase 2 (all satisfied at this closure)

1. PHASE 1 PASS with evidence (`PHASE_1_ACCEPTANCE_REPORT.md`).
2. Open P0/P1/security P2 = 0.
3. Accounting rules, inventory rules, state machines and transaction map documents exist and are unchanged since Phase 0 (`docs/DAFTAR_*`).
4. Perf baseline recorded to compare after the money core lands.
