# DAFTAR — Phase 1 Entitlement Review / مراجعة الاستحقاقات

## 1. Model

- Plans `free | starter | pro | business`, each with immutable **plan versions** (`DRAFT → PUBLISHED → SUNSET`). Children (`plan_entitlements`, `plan_limits`) freeze at publish by DB trigger.
- Feature registry (11 keys: `CUSTOM_ROLES`, `MULTI_BRANCH`, `ONLINE_STORE`, `WHATSAPP_AUTOMATION`, `AI_ASSISTANT`, `ADVANCED_REPORTS`, `API_ACCESS`, `LOT_EXPIRY`, `SERIAL_TRACKING`, `RESTAURANT_PACK`, `APPOINTMENTS`) and limit registry (`MAX_USERS`, `MAX_BRANCHES`, `MAX_PRODUCTS`) are FK targets: arbitrary keys are rejected at the DB.
- `business_entitlements` carries the subscription state (`trial | active | cancel_at_period_end | cancelled`) with time-computed transitions (no scheduler needed); `entitlement_overrides` are strict XOR (feature or limit), windowed, non-overlapping, audited.

## 2. Evaluation rules (server-side only)

| Rule | Guard |
|---|---|
| Feature false + high limit → denied (capabilities gate first) | `feature-gating.test.ts` |
| Feature true + quota exhausted → `PLAN_LIMIT_EXCEEDED` | `feature-gating.test.ts` |
| Override windows: after the TRUE window closes the plan value applies | `feature-gating.test.ts`, `plan-lifecycle.test.ts` |
| Expired trial loses features; `cancel_at_period_end` flips when the period passes | `feature-gating.test.ts` |
| Trial length comes from the published version's `trial_days` | `feature-gating.test.ts` |
| A DRAFT version is never assigned to a business | `plan-lifecycle.test.ts` |
| Limits under concurrency: one slot + two requests → exactly one (users, products, branches) | `quota-race.test.ts` |
| Downgrade (OVER_LIMIT): data preserved, additions blocked | `team.test.ts` |
| `daftar_app` cannot write overrides, subscription state or published versions | `db-privileges.test.ts` |

## 3. Surfaces

- Merchant web: plan page (state, trial end, limits with usage, features), `FeatureLockedState` / `PlanLimitState` components on structure and roles pages.
- Android: plan screen with the same DTO (`EntitlementDto`).
- Admin: plan builder (create plan, edit DRAFT with full replace, publish, clone, diff, sunset), overrides list/create/revoke, business subscription detail.

## 4. Findings

- Closure fix: the plan builder needed DELETE on `plan_entitlements` / `plan_limits` for DRAFT full-replace; granted narrowly in `0034` (published rows stay trigger-protected).
- Concurrent publish of the same draft → exactly one 200, one 409, one audit event (`concurrency-matrix.test.ts`).

**Verdict: PASS.**
