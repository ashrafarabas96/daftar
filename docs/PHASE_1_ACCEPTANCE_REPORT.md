# DAFTAR — Phase 1 Acceptance Report / تقرير قبول المرحلة الأولى

> Directive §77–82: only PASS or FAIL, with evidence from a clean environment. The numbers below are copied from `release/evidence.json`, written by `npm run gate:phase1:release -- --evidence=release/evidence.json` (the gate stops at the first failure, so a PASS means every step ran). `release/` is git-ignored; the evidence file, per-step logs, perf JSON and export zip are produced on the acceptance machine and attached to the release, not committed.

## Verdict

# PHASE 1: PASS

القرار: **نجاح المرحلة الأولى** — 21/21 خطوة في بوابة الإصدار، 410 حالة اختبار آلية ناجحة، 0 عيوب مفتوحة من فئة P0/P1/أمان P2، لا شيء من المرحلة الثانية بدأ.

## 1. Environment of the accepted run

| Item | Value |
|---|---|
| Branch | `claude/new-session-2sxgo5` (pushed to `origin`) |
| Gate commit | see §2 header (the commit the gate ran on; this report is committed immediately after it with no code change) |
| Node / npm | v24.12.0 / 11.6.2 (`nvm install 24.12.0`) |
| PostgreSQL | embedded PostgreSQL 18 started from an empty data directory by the test harness; roles from `bootstrap.sql`; schema 0000–0037 applied by the migration runner |
| Android toolchain | SDK platform 35, build-tools 35.0.0, Gradle 8.14.3, JDK 17, `ANDROID_HOME=/opt/android-sdk` |
| Checkout state | build outputs removed by the gate's first step (API dist, `.next`, package dists, Android build), then everything rebuilt from source |
| Network | npm registry reachable (needed by `npm audit`) |

## 2. Command matrix (§74) — evidence from `release/evidence.json`

Gate verdict: **PASS** · generated 2026-09-21T13:19:36Z · node 24.12.0 · linux/x64 · commit `c0b3be5`

| # | Step | Status | Duration | Summary |
|--:|---|---|---:|---|
| 1 | toolchain: Node 24.x | PASS | 0.0s | ok |
| 2 | clean build outputs (build from source, like a fresh checkout) | PASS | 0.1s | ok |
| 3 | migration manifest (frozen files unchanged) | PASS | 0.3s | 38 frozen migrations verified (frozen through 0037) |
| 4 | phase 1 machine gate | PASS | 0.3s | product tree, machine checks, workspace integrity, artifact hygiene, RC reports: PASS |
| 5 | static architecture guards | PASS | 0.4s | STATIC GUARDS: PASS (14 rules) |
| 6 | localization completeness | PASS | 0.3s | LOCALIZATION CHECK: PASS (187 keys × 3 locales) |
| 7 | format (`prettier --check .`) | PASS | 3.9s | |
| 8 | build contract + design packages | PASS | 4.0s | |
| 9 | lint (zero warnings) | PASS | 18.1s | |
| 10 | typecheck (all workspaces) | PASS | 14.2s | |
| 11 | unit tests | PASS | 2.3s | domain-core 45/45 · shared-contracts 13/13 |
| 12 | integration + security tests | PASS | 107.0s | 36 files · 291/291 |
| 13 | golden regression suite | PASS | 25.4s | 7 files · 40/40 |
| 14 | API build | PASS | 5.8s | |
| 15 | merchant web build (`next build`, 16 pages × 3 locales) | PASS | 29.4s | |
| 16 | admin web build (`next build`, 11 pages) | PASS | 23.2s | |
| 17 | Android lint + unit tests + assemble | PASS | 18.0s | lint 0 errors / 4 warnings · 13/13 JVM tests · `app-debug.apk` 18.5 MB |
| 18 | dependency audit (`npm audit --audit-level=high`) | PASS | 0.7s | 0 high/critical (2 moderate, dev-only, TD-01) |
| 19 | forbidden artifact scan (files git would ship) | PASS | 0.0s | ok |
| 20 | raw credential scan | PASS | 0.0s | ok |
| 21 | release documents (§76) present and non-placeholder | PASS | 0.0s | 21 documents |

Total wall time of the matrix: 4.2 min · 21 pass · 0 fail · 0 skipped.

Measurement outside the gate, same commit: `npm run perf:baseline` 8/8 (table in `PHASE_1_PERFORMANCE_BASELINE.md`, p95 ≤ 58 ms for every read/write endpoint, login p95 79 ms).

## 3. Release artifact (§70–72)

`npm run export:release` on the report commit → `release/DAFTAR_PHASE_1_RC.zip` (324 source files + `DELIVERY_MANIFEST.json`, ~0.8 MB) with a sibling `DAFTAR_PHASE_1_RC.zip.sha256`. The export is allowlist-based, removes build debris from the staging tree, fails on forbidden files or raw credential material, and fails if the zip's entry count differs from the hashed inventory. The zip hash is deliberately NOT reproduced in this document (the document is inside the zip; the sibling `.sha256` and the manifest's `treeHash` are the authoritative values).

## 4. Bug budget (§78)

| Class | Open |
|---|---:|
| P0 | 0 |
| P1 | 0 |
| Security P2 | 0 |
| Other P2 | 0 |
| Registered technical debt (not defects) | 6 (TD-01…TD-06 in `TECHNICAL_DEBT.md`) |

26 defects found during the closure, all fixed with a guard test (`PHASE_1_REGRESSION_REPORT.md` R-01…R-26).

## 5. Independent reviews (three lenses, `DAFTAR_RELEASE_GATES.md`)

| Review | Documents | Verdict |
|---|---|---|
| A — Functionality & data integrity | `PHASE_1_IMPLEMENTATION_REPORT.md`, `PHASE_1_TEST_REPORT.md`, `PHASE_1_MULTI_USER_REVIEW.md`, `PHASE_1_ENTITLEMENT_REVIEW.md`, `PHASE_1_REGRESSION_REPORT.md` | PASS |
| B — Security, architecture, rollback | `PHASE_1_SECURITY_REVIEW.md`, `PHASE_1_ASVS_MAPPING.md`, `PHASE_1_RBAC_REVIEW.md`, `PHASE_1_SUPER_ADMIN_REVIEW.md`, `PHASE_1_MIGRATION_HISTORY_DECISION.md` | PASS |
| C — UX, visual quality, localization | `PHASE_1_DESIGN_REVIEW.md`, `PHASE_1_ANDROID_REVIEW.md` | PASS (with TD-02 admin English-only and TD-06 no rendered viewport audit, both documented decisions) |

## 6. Directive compliance (§1–82)

- Continued the existing project: 11 closure commits on top of the imported archive; stack unchanged; no restart.
- Frozen migrations untouched (0000–0027 from the archive freeze, 0028–0037 frozen at this release); every schema correction is a new migration.
- No test disabled, no RLS weakened, no broad grant, no `@ts-ignore`, no float money, no BigInt→Number, no fake adapter reachable in production, no swallowed error (spot checks listed in `PHASE_1_IMPLEMENTATION_REPORT.md` §3).
- Section-by-section status: `PHASE_1_CLOSURE_TRACKER.md`.
- Phase 2 not started; entry conditions recorded in `PHASE_2_PREMORTEM.md`.

## 7. How to reproduce this verdict

```
git clone <repo> && cd daftar && git checkout claude/new-session-2sxgo5
nvm install 24.12.0 && npm ci
export ANDROID_HOME=<sdk with platform 35 + build-tools 35.0.0>   # Gradle 8.14.3 on PATH
npm run gate:phase1:release -- --evidence=release/evidence.json
npm run perf:baseline
npm run export:release
```

Any step printing FAIL turns this verdict into FAIL; there is no partial pass.
