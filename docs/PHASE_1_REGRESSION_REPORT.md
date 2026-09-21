# DAFTAR — Phase 1 Regression Report / تقرير الانحدار

> Golden Change Rule (§6 / §65): every defect found gets a test that fails without the fix and passes with it; every previously working behaviour stays green. This report lists the defects of the closure, their guards, and the golden suite state.

## 1. Golden suite state

| Golden file | IDs | Result |
|---|---|---|
| 01-identity-access | P1-GOLD-01…07 | pass |
| 02-tenancy-isolation | P1-GOLD-08…14 | pass |
| 03-catalog-commerce | P1-GOLD-15…24 | pass |
| 04-platform-ops | P1-GOLD-25…32 | pass |
| 05-artifact-hygiene | P1-GOLD-33…34 | pass |
| 06-web-contract | P1-GOLD-35…38 | pass |
| 07-admin-contract | P1-GOLD-39…40 | pass |

40/40 on the closure commit (`npm run test:golden`). The suite ran green after every commit of the closure (the harness fix 0c60b54 was the first commit to make it runnable on a stock connection budget).

## 2. Defect → guard table (§65)

| # | Defect (found during the closure) | Root cause | Fix | Guard that fails without the fix |
|---|---|---|---|---|
| R-01 | `npm ci` failed ("Invalid Version") | Versionless stub + mirror URLs in the lockfile | Lockfile repaired | CI `npm ci` on every job |
| R-02 | 130 integration failures: connection slots exhausted | Test apps leaked per test | setup-file lifecycle guard | whole suite on `max_connections=100` |
| R-03 | Last-owner race returned 500 (40P01 deadlock) | Two row-lock orders | Business-level advisory lock first | `owner-authority` / `isolation` concurrent cases |
| R-04 | Provisioner accepted a caller-chosen actor id | Authorization outside the SECURITY DEFINER command | `0033`: actor from GUC, checks inside | `provisioner-boundary` "direct EXECUTE attacks" (5) |
| R-05 | Process isolation only by env validation | One `AppModule` | Per-process modules; pools by mode | `runtime-isolation` (5) |
| R-06 | DEV credential key reachable in production | Fallback in factory | Throw under `NODE_ENV=production` | `production-providers`, `runtime-isolation` |
| R-07 | Web client shapes drifted from API (19 of 44 calls) | No contract audit | Shared DTOs + rewritten client | golden 06 (mechanical sync) |
| R-08 | Admin pages read raw proxy JSON | No DTOs | Admin DTOs + typed client | golden 07 |
| R-09 | Android retry rebuilt the request with a new key | Retry rebuilt from screen state | `RequestSpec` replay | `RetryContractTest.kt` |
| R-10 | Android money parsed as `Double` | — | `BigDecimal` + exponent registry | `MoneyTest.kt` |
| R-11 | Two currency tables (minor units diverged) | Copy in shared-contracts | Delegate to domain-core registry | shared-contracts money tests; static guard 6b |
| R-12 | Rate limiter outage failed open | Catch-all in limiter | `RateLimiterUnavailableError` → 503 + Retry-After | `auth-abuse` outage case |
| R-13 | Audit rows with business but no tenant | Admin overrides audited without tenant | `0035` CHECK + backfill; `AuditService` resolves tenant | `0035` applied on real data in `migration-upgrade`; `outbox.test.ts` |
| R-14 | JSONB translations, per-table SKU uniqueness | Original schema | `0036` normalized tables, `0037` registry | `catalog-identifiers` (6), `catalog` |
| R-15 | PL/pgSQL trigger read `NEW.product_id` on a table without it | Shared trigger function across tables | `to_jsonb(NEW)` extraction | `migration-upgrade` 0035 checkpoint, `catalog-identifiers` |
| R-16 | Bootstrap CLI ran with migration credentials | Env name reuse | `BOOTSTRAP_DATABASE_URL` must be the platform principal; refuses `MIGRATION_DATABASE_URL` | `bootstrap-owner`, `support-sessions` CLI case |
| R-17 | Concurrent bootstrap could create two owners | No lock | Advisory lock | `bootstrap-owner` race case |
| R-18 | `verify:history` crashed under tsx CJS (top-level await) | — | Wrapped in async main | CI "Migration history verify" step |
| R-19 | Static guard false positives from comments | Naive regex | Comments stripped before matching | `check:guards` |
| R-20 | `node:crypto` in domain-core broke the Next client bundle | Slug token used Node API | Web Crypto (`globalThis.crypto`) | `next build` (web), `onboarding` slug tests |
| R-21 | Invitation accept page failed prerender (`useSearchParams`) | Missing Suspense boundary | Suspense wrapper | `next build` (web) |
| R-22 | Locale layout rejected by Next 15.5 typed routes | Narrow param type | `isLocale` narrowing + 404 | `typecheck` / `next build` |
| R-23 | 12 npm advisories (1 critical) | Stale versions | Bumps within majors + 2 overrides | `npm audit --audit-level=high` in CI and gate |
| R-24 | Perf baseline seed hit `MAX_PRODUCTS`; login hit the limiter | Product behaviour, not defects | Test raises the limit explicitly and measures 8 logins | `perf:baseline` |
| R-25 | Release export zipped the Android `build/` directory (1 547 files, ~100 MB) although the inventory skipped it | Forbidden directories were pruned from the inventory only | Pruned from the staging tree; export fails if zip entries ≠ inventory + manifest | `export:release` self-check |
| R-26 | Release gate flagged its own build outputs as stale artifacts; lint rejected Next-generated `next-env.d.ts` | Scan walked the filesystem; Next 15.5 regenerates the file | Scan uses git's shipped-file list; `next-env.d.ts` excluded from lint | `gate:phase1:release` |

Open defects at closure: **P0 = 0, P1 = 0, security P2 = 0, other P2 = 0**. Non-defect items are in `TECHNICAL_DEBT.md` (TD-01…TD-06).

## 3. Previously protected behaviours

`docs/PHASE_1_PROTECTED_BEHAVIORS.md` PB-01…PB-17 (Phase 0 / archive) remained green throughout; PB-18…PB-39 were added by this closure. No protected behaviour was removed or weakened.
