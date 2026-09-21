# DAFTAR — Phase 1 Closure Tracker / متتبّع إغلاق المرحلة الأولى

> Handover directive: "CONTINUE THE EXISTING PROJECT — DO NOT RESTART — FINISH PHASE 1 COMPLETELY".
> Every directive section (§) is listed with its status, the commit that closed it and the test that guards it.
> Status vocabulary: **DONE** (implemented + guarded), **DONE (documented decision)**, **OUT OF PHASE** (explicitly deferred by the directive itself).

| § | Requirement | Status | Guard (test / script) | Commit |
|---|---|---|---|---|
| 1–9 | Take the archive as source of truth; no restart, no re-architecture, no stack change; Node 24.12.x; reality audit before code | DONE | `docs/PHASE_1_REALITY_AUDIT.md` (closure re-audit appended) | 53bbb50, 0c60b54 |
| 10–14 | Provisioner authority atomic with mutation; actor derived from the transaction GUC, never from arguments; direct-DB attack tests | DONE | `tests/security/provisioner-boundary.test.ts` (direct EXECUTE attacks) | 9c31276 |
| 15–20 | Real per-process runtimes (merchant-api / platform-api / worker); boot tests; `PROCESS_MODE=all` refused in production | DONE | `tests/integration/runtime-isolation.test.ts`, `production-providers.test.ts` | 148d397 |
| 21–24 | Credential enqueue in the request tx, delivery only in the worker; no DEV_TEST_KEY in production; KMS-style encrypt provider for HTTP runtimes | DONE | `production-providers.test.ts`, `credential-keyring.test.ts`, `delivery-outbox.test.ts` | 148d397 |
| 25–27 | Full web ↔ API contract audit; `{items}` lists; DTOs not `{ok:true}`; branch scope `mode/branchIds`; shared contracts only | DONE | golden `06-web-contract` (44/44 client calls audited, mechanical sync of exported functions and path templates) | 7ef906c |
| 28–29 | Admin DTOs; plan builder end-to-end (create → edit draft → publish → clone → diff → sunset) | DONE | golden `07-admin-contract` (24 calls), `plan-lifecycle.test.ts` | efa250a |
| 30–33 | Android DTOs from the same contract; retry replays the ORIGINAL request with the same Idempotency-Key; Phase-1 scope; ar/en/tr | DONE | `ApiContractTest.kt`, `RetryContractTest.kt`, `MoneyTest.kt` (13 JVM tests) | 7ef906c |
| 34–36 | Money: no BigInt→Number, one currency registry (domain-core), large-value tests | DONE | shared-contracts money tests (18-digit minor units × ILS/JOD/TRY/USD × ar/en/tr), static guard 6b | 7ef906c |
| 37–40 | Normalized translations (`product_translations`, `category_translations`); `catalog_identifiers` registry enforced in the DB | DONE | `tests/security/catalog-identifiers.test.ts`, `catalog.test.ts` | 0cc240e |
| 41 | Base currency is server authority (country pack default, validated registry) | DONE | `business-locale.test.ts`, `onboarding.test.ts` | archive + 7ef906c |
| 42–43 | Support sessions scoped to one tenant, time-boxed, every access audited, concurrent revoke safe | DONE | `support-sessions.test.ts` | archive (verified) |
| 44–46 | Platform owner bootstrap: no migration credentials, race → exactly one, `--promote-existing`, password never printed twice / never overwritten | DONE | `bootstrap-owner.test.ts`, `support-sessions.test.ts` (CLI) | 0cc240e |
| 47 | audit/outbox: business ⇒ tenant (CHECK) + FK; historical rows backfilled | DONE | migration 0035, `outbox.test.ts`, admin audit tests | efa250a |
| 48–50 | Private S3, signed access URLs, upload compensation, image validation (magic bytes, re-encode, metadata strip) | DONE | `media.test.ts`, `media-compensation.test.ts` | archive + 7ef906c |
| 51–54 | Frozen migrations; manifest with SHA-256; release check; upgrade matrix (0024, 0026, 0035 checkpoints → latest; latest → no-op) | DONE | `check:migrations`, `migration-upgrade.test.ts`, `failure-injection.test.ts` | 0cc240e, 96a076c |
| 55–56 | CI database from zero: roles → migrate → no-op re-migrate → history verify → tests → tamper proof | DONE | `.github/workflows/ci.yml` backend job, `bootstrap:db-roles` | efa250a |
| 57 | Static guards (14 rules incl. runtime-isolation and migration-credential rules) | DONE | `npm run check:guards` | efa250a |
| 58–61 | Localization: merchant web + Android ar/en/tr complete; admin console English-only by documented decision | DONE (documented decision) | `check:localization` (187 keys × 3), Android 57 strings × 3, `PHASE_1_DESIGN_REVIEW.md` §Localization | 8d0eff5 |
| 62 | Merchant web product completeness (business switch, create business, structure, roles, branch scope, product editor, invitations, settings) | DONE | golden 06, `next build` (16 pages) | 8d0eff5 |
| 63 | Admin console completeness (tenants, businesses, plans builder, overrides, flags, support sessions, users, audit, operations) | DONE | golden 07, `next build` (11 pages) | efa250a |
| 64 | Android Phase-1 completeness (login, onboarding, home + business switch, products list/edit + photo, team, plan, settings) | DONE | gradle `lint testDebugUnitTest assembleDebug` | 7ef906c |
| 65 | Golden for every defect found | DONE | see `PHASE_1_REGRESSION_REPORT.md` defect → test table | all |
| 66 | Concurrency review matrix | DONE | `concurrency-matrix.test.ts` + 9 pre-existing race tests | b6cfab5 |
| 67 | Failure injection (adapter outage, sink outage, worker crash, migration failure, wrong principal, limiter outage → 503) | DONE | `failure-injection.test.ts`, `delivery-outbox.test.ts`, `outbox.test.ts`, `media-compensation.test.ts`, `auth-abuse.test.ts` | b6cfab5, efa250a |
| 68 | Observability review (request id in every error, redacted structured logs, readiness per mode, worker counters) | DONE | `PHASE_1_SECURITY_REVIEW.md` §Observability | archive (verified) |
| 69 | Performance review + baseline numbers | DONE | `tests/perf/phase1-baseline.test.ts`, `PHASE_1_PERFORMANCE_BASELINE.md` | this closure |
| 70–73 | Release artifact hygiene, export with manifest + sibling SHA-256, `gate:phase1:release`, clean acceptance on Node 24.12.x | DONE | `scripts/phase1-release-gate.ts`, `scripts/export-release.ts`, golden 05 | 96a076c |
| 74 | Command matrix executed on a clean environment | DONE | `PHASE_1_ACCEPTANCE_REPORT.md` evidence table (real durations/exit codes) | this closure |
| 75 | Adversarial passes (auth abuse, RLS, privilege, delegation ceiling, mass assignment, cross-tenant) | DONE | `tests/security/*` (155 cases in 15 files) | archive + this closure |
| 76 | Final document set (21 documents) | DONE | `gate:phase1:release` step "release documents present and non-placeholder" | this closure |
| 77 | Evidence with actual numbers | DONE | `PHASE_1_TEST_REPORT.md`, `PHASE_1_ACCEPTANCE_REPORT.md` | this closure |
| 78 | Bug budget: P0 = P1 = security P2 = 0 | DONE | `PHASE_1_REGRESSION_REPORT.md` (open defects: 0) | — |
| 79–82 | Only PASS or FAIL; stop after PASS; nothing from Phase 2 started | DONE | acceptance verdict | — |

## Final Release Blocker Patch (directive "FIX ONLY THE VERIFIED FINAL BLOCKERS")

| Blocker | Requirement | Status | Guard | Migration |
|---|---|---|---|---|
| 1 | Provisioner actor cannot be spoofed through a GUC; authorization + mutation stay atomic | DONE | `provisioner-boundary` Blocker 1 suite | `0038` |
| 2 | Every identifier belongs to one real product XOR variant; registry internal-only | DONE | `catalog-identifiers` owner-integrity suite | `0039` |
| 3 | Release zip self-contained; acceptance reproduced from the extracted archive | DONE | `export:release` audit, gate "self-contained source tree", full 24-step gate + performance baseline executed inside the extracted archive (fresh `npm ci`, fresh PostgreSQL, no `.git`); the run found and fixed R-36…R-38 | — |
| 4 | KMS: HTTPS-only, authenticated, timeout/abort, bounded response, sanitized errors, fail-closed enqueue | DONE | `kms-encryptor` | — |
| 5 | Release gate fails on any mandatory skip; the gate itself is tested | DONE | `release-gate` | — |
| 6 | Android debug cleartext scoped to the emulator host; release TLS-only | DONE | `NetworkSecurityConfigTest.kt` | — |
| 7 | Raw structured evidence from the final tree | DONE | `release/evidence.json` v2 | — |

## Out of Phase (per the directive, not deferred by us)

- Money core (accounting, inventory ledger, sales, POS), installments, storefront, WhatsApp, AI assistant: Phase 2+ (`DAFTAR_IMPLEMENTATION_ROADMAP.md`). No table, endpoint or screen for them was started.
- Android offline sync: Phase 4 by roadmap; Phase 1 Android is online-only by design (§32).

## Open items carried as technical debt (none blocking)

See `TECHNICAL_DEBT.md`: vitest moderate advisory (dev-only), admin console English-only, Android instrumentation tests deferred to a device lab.
