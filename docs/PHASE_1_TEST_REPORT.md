# DAFTAR — Phase 1 Test Report / تقرير الاختبارات

> Actual results on the closure commit of branch `claude/new-session-2sxgo5`, Node v24.12.0, npm 11.6.2. Every suite below runs in CI (`.github/workflows/ci.yml`) and in `npm run gate:phase1:release`. Nothing is skipped: `grep -rnE "it\.skip|describe\.skip|xit\(|\.only\(" tests packages/*/test` → 0 matches.

## 1. Totals

| Suite | Command | Files | Cases | Result |
|---|---|---:|---:|---|
| Unit — domain-core | `npm test` | 1 | 45 | 45 passed |
| Unit — shared-contracts | `npm test` | 2 | 13 | 13 passed |
| Integration + security | `npm run test:integration` | 38 | 321 | 321 passed |
| Golden regression | `npm run test:golden` | 7 | 40 | 40 passed |
| Performance baseline | `npm run perf:baseline` | 1 | 8 | 8 passed |
| Android JVM | `gradle testDebugUnitTest` | 4 | 16 | 16 passed |
| **Total automated cases** | | **53** | **443** | **443 passed, 0 failed, 0 skipped** |

Counts come from `release/evidence.json` (schema v2), which the release gate writes from the executed commands.

Static checks on the same commit: `check:migrations` (40 frozen hashes OK, frozen through 0039), `check:db-from-zero` PASS (roles → 40 migrations → no-op → manifest + history verified → tamper rejected → role contract), `gate:phase1` PASS, `check:guards` PASS (14 rules), `check:localization` PASS (187 keys × 3), `format` clean, `lint` 0 errors / 0 warnings, `typecheck` clean in 6 workspaces, `npm audit --audit-level=high` 0 high/critical, Android `lint` 0 errors.

## 2. Integration suite (23 files, 182 cases)

| File | Cases | Covers |
|---|---:|---|
| admin.test.ts | 6 | platform console endpoints, audit rows, capability checks |
| auth.test.ts | 10 | register/login/refresh/logout-all, password reset, me |
| bootstrap-owner.test.ts | 3 | first-owner CLI, race, promote-existing |
| business-locale.test.ts | 6 | locales, base currency authority, timezone |
| catalog.test.ts | 16 | products/categories/variants, search, optimistic concurrency, pagination, adversarial inputs |
| concurrency-matrix.test.ts | 5 | §66 races |
| kms-encryptor.test.ts | 12 | Blocker 4: KMS config rejections, timeout, unreachable, 5xx/4xx, malformed, oversized, redirect, fail-closed enqueue |
| release-gate.test.ts | 4 | Blocker 5: the release gate refuses every mandatory skip; the plan lists every surface |
| delivery-outbox.test.ts | 3 | credential delivery retry/dead-letter/recovery |
| failure-injection.test.ts | 4 | §67 worker crash lease, migration failure, wrong principal |
| invitation-lifecycle.test.ts | 9 | expiry sweep, resend policy, direct add, delivery tracking |
| media.test.ts / media-compensation.test.ts | 7 + 2 | upload validation, keys, variants, compensation, orphan record |
| migration-upgrade.test.ts | 3 | 0024/0026/0035 checkpoints → latest (everything after the checkpoint applies), no-op rerun |
| onboarding.test.ts | 16 | atomic provisioning, idempotency semantics, slug race, fallback slug stability |
| outbox.test.ts | 4 | atomicity, exactly-once to healthy sink, retry/dead-letter, duplicate absorption |
| plan-lifecycle.test.ts | 12 | DRAFT→PUBLISHED→SUNSET, child immutability, overrides integrity |
| production-providers.test.ts | 12 | real adapters in production, per-process secret separation, provisioning-assertion key rules |
| quota-race.test.ts | 4 | MAX_USERS / MAX_PRODUCTS / MAX_BRANCHES under concurrency |
| runtime-isolation.test.ts | 5 | merchant/platform/worker boot shape, prod refusals |
| support-sessions.test.ts | 8 | scope, expiry, revoke race, audit, bootstrap CLI |
| team.test.ts | 12 | members, roles union, suspend/reactivate, downgrade behaviour |
| tenant-memberships.test.ts | 6 | multi-tenant identity |

## 3. Security suite (15 files, 139 cases)

auth-abuse (20), branch-scopes (10), catalog-identifiers (13), credential-keyring (7), credential-payload (7), db-privileges (18), delegation-ceiling (9), feature-gating (8), isolation (11), jwt-keyring (10), membership-lifecycle (5), owner-authority (9), provisioner-boundary (16), refresh-lineage (4), role-crud (5) — titles listed in `PHASE_1_SECURITY_REVIEW.md` and `PHASE_1_ASVS_MAPPING.md`.

## 4. Golden regression (P1-GOLD-01…40)

01 identity & access · 02 tenancy isolation · 03 catalog & commerce · 04 platform ops (incl. bootstrap under `BOOTSTRAP_DATABASE_URL`) · 05 artifact hygiene · 06 web contract (44 client calls) · 07 admin contract (24 client calls). Detail: `PHASE_1_REGRESSION_REPORT.md`.

## 5. Database from zero (CI backend job)

`CREATE DATABASE` → `bootstrap-db-roles` → `migrate` (40 applied) → `migrate` again (none) → `verify:history` → integration/security → golden → tampered-migration proof → `check:db-from-zero` (a throw-away embedded server repeats the whole contract and additionally proves `daftar_app` holds no DDL, cannot read the provisioning assertion keys and cannot write the identifier registry). Runs on stock PostgreSQL 16 in GitHub Actions with `max_connections=100`.

## 6. Known non-blocking observations

- `npm ls` prints `invalid` for `next > postcss` because the override (8.5.28) is outside Next's declared range (8.4.31); `npm ci` and the build accept it. Documented with the override in `package.json`.
- The performance suite is not part of `test:integration` (it is a measurement, run separately in the gate matrix).
