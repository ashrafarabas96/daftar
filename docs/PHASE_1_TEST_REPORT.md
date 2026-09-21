# DAFTAR — Phase 1 Test Report / تقرير الاختبارات

> Actual results on the closure commit of branch `claude/new-session-2sxgo5`, Node v24.12.0, npm 11.6.2. Every suite below runs in CI (`.github/workflows/ci.yml`) and in `npm run gate:phase1:release`. Nothing is skipped: `grep -rnE "it\.skip|describe\.skip|xit\(|\.only\(" tests packages/*/test` → 0 matches.

## 1. Totals

Every number below is read from `release/evidence.json` (schema `daftar.release-evidence/2`), which `npm run gate:phase1:release` writes from the output of the commands it actually executed. Nothing here is counted by hand.

| Suite | Command | Files | Cases | Result |
|---|---|---:|---:|---|
| Unit — domain-core | `npm test` | 1 | 45 | 45 passed |
| Unit — shared-contracts | `npm test` | 2 | 13 | 13 passed |
| Integration + security | `npm run test:integration` | 39 | 326 | 326 passed |
| Golden regression | `npm run test:golden` | 7 | 40 | 40 passed |
| Android JVM | `gradle testDebugUnitTest` | 4 | 16 | 16 passed |
| **Release-gate automated tests** | | **53** | **440** | **440 passed, 0 failed, 0 skipped** |

The performance baseline is a **measurement, not a release-gate test**: `npm run perf:baseline` runs **8 benchmark cases** outside the gate and is reported separately in `PHASE_1_PERFORMANCE_BASELINE.md`.

**440 + 8 = 448 executions in total, where that figure is explicitly stated to include the performance benchmarks.** The unqualified test count for Phase 1 is **440**.

> Earlier revisions of this report carried 321, 323 and 443. Those were evidence from earlier commits and are superseded: the Final Phase 1 Closure added three regression tests to `provisioner-boundary.test.ts` (key-custody authority, 16 → 19 cases), which moved the integration + security count from 323 to 326 and the release-gate total from 437 to 440. Historical figures are kept in `PHASE_1_REALITY_AUDIT.md`, labelled as historical.

Static checks on the same commit: `check:migrations` (40 frozen hashes OK, frozen through 0039), `check:db-from-zero` PASS (roles → 40 migrations → no-op → manifest + history verified → tamper rejected → role contract), `gate:phase1` PASS, `check:guards` PASS (14 rules), `check:localization` PASS (187 keys × 3), `format` clean, `lint` 0 errors / 0 warnings, `typecheck` clean in 6 workspaces, `npm audit --audit-level=high` 0 high/critical, Android `lint` 0 errors.

## 2. Integration suite (24 files, 171 cases)

| File | Cases | Covers |
|---|---:|---|
| admin.test.ts | 6 | platform console endpoints, audit rows, capability checks |
| auth.test.ts | 10 | register/login/refresh/logout-all, password reset, me |
| bootstrap-owner.test.ts | 3 | first-owner CLI, race, promote-existing |
| business-locale.test.ts | 6 | locales, base currency authority, timezone |
| catalog.test.ts | 16 | products/categories/variants, search, optimistic concurrency, pagination, adversarial inputs |
| concurrency-matrix.test.ts | 5 | §66 races |
| delivery-outbox.test.ts | 3 | credential delivery retry/dead-letter/recovery |
| embedded-pg-binaries.test.ts | 2 | the archive's PostgreSQL binaries are executable before a test server starts |
| failure-injection.test.ts | 4 | §67 worker crash lease, migration failure, wrong principal |
| invitation-lifecycle.test.ts | 9 | expiry sweep, resend policy, direct add, delivery tracking |
| kms-encryptor.test.ts | 12 | Blocker 4: KMS config rejections, timeout, unreachable, 5xx/4xx, malformed, oversized, redirect, fail-closed enqueue |
| media-compensation.test.ts | 2 | upload compensation, orphan record |
| media.test.ts | 7 | upload validation, keys, variants |
| migration-upgrade.test.ts | 3 | 0024/0026/0035 checkpoints → latest (everything after the checkpoint applies), no-op rerun |
| onboarding.test.ts | 16 | atomic provisioning, idempotency semantics, slug race, fallback slug stability |
| outbox.test.ts | 4 | atomicity, exactly-once to healthy sink, retry/dead-letter, duplicate absorption |
| plan-lifecycle.test.ts | 12 | DRAFT→PUBLISHED→SUNSET, child immutability, overrides integrity |
| production-providers.test.ts | 12 | real adapters in production, per-process secret separation, provisioning-assertion key rules |
| quota-race.test.ts | 4 | MAX_USERS / MAX_PRODUCTS / MAX_BRANCHES under concurrency |
| release-gate.test.ts | 4 | Blocker 5: the release gate refuses every mandatory skip; the plan lists every surface |
| runtime-isolation.test.ts | 5 | merchant/platform/worker boot shape, prod refusals |
| support-sessions.test.ts | 8 | scope, expiry, revoke race, audit, bootstrap CLI |
| team.test.ts | 12 | members, roles union, suspend/reactivate, downgrade behaviour |
| tenant-memberships.test.ts | 6 | multi-tenant identity |

## 3. Security suite (15 files, 155 cases)

auth-abuse (20), branch-scopes (10), catalog-identifiers (13), credential-keyring (7), credential-payload (7), db-privileges (18), delegation-ceiling (9), feature-gating (8), isolation (11), jwt-keyring (10), membership-lifecycle (5), owner-authority (9), provisioner-boundary (19), refresh-lineage (4), role-crud (5) — titles listed in `PHASE_1_SECURITY_REVIEW.md` and `PHASE_1_ASVS_MAPPING.md`.

## 4. Golden regression (P1-GOLD-01…40)

01 identity & access · 02 tenancy isolation · 03 catalog & commerce · 04 platform ops (incl. bootstrap under `BOOTSTRAP_DATABASE_URL`) · 05 artifact hygiene · 06 web contract (44 client calls) · 07 admin contract (24 client calls). Detail: `PHASE_1_REGRESSION_REPORT.md`.

## 5. Database from zero (CI backend job)

`CREATE DATABASE` → `bootstrap-db-roles` → `migrate` (40 applied) → `migrate` again (none) → `verify:history` → integration/security → golden → tampered-migration proof → `check:db-from-zero` (a throw-away embedded server repeats the whole contract and additionally proves `daftar_app` holds no DDL, cannot read the provisioning assertion keys and cannot write the identifier registry). Runs on stock PostgreSQL 16 in GitHub Actions with `max_connections=100`.

## 6. Known non-blocking observations

- `npm ls` prints `invalid` for `next > postcss` because the override (8.5.28) is outside Next's declared range (8.4.31); `npm ci` and the build accept it. Documented with the override in `package.json`.
- The performance suite is not part of `test:integration` (it is a measurement, run separately in the gate matrix).
