# DAFTAR — Phase 1 Acceptance Report / تقرير قبول المرحلة الأولى

> Directive §77–82 and the Final Release Blocker Patch: only PASS or FAIL, with evidence from a clean environment. Every number below is copied from a `release/evidence.json` (schema `daftar.release-evidence/2`) that `npm run gate:phase1:release` wrote from the commands it actually executed. `release/` is git-ignored: the evidence files, per-step logs, performance JSON and the archive itself are delivered as artifacts, not committed.

## Verdict

# PHASE 1: PASS

القرار: **نجاح المرحلة الأولى** — بوابة الإصدار 24/24 على المستودع و24/24 من داخل أرشيف الإصدار المستخرج وحده، 443 حالة اختبار آلية ناجحة، 0 عيوب مفتوحة من فئة P0/P1/أمان P2، ولم يبدأ أي عمل من المرحلة الثانية.

## 1. Two independent runs, same code

| | Run A — repository | Run B — extracted release archive |
|---|---|---|
| Source | git checkout, commit `9ad05db`, clean tree | `DAFTAR_PHASE_1_RC.zip` unpacked into an empty directory; **no `.git`**, original tree not referenced |
| Dependencies | existing `node_modules` | `npm ci` from the archive's own lockfile (419 packages) |
| Database | embedded PostgreSQL 18, throw-away data directory | separate data directory and port, created from nothing |
| Android | SDK platform 35, build-tools 35.0.0, Gradle 8.14.3, JDK 17 | same toolchain, `build/` absent at start |
| Node / npm | v24.12.0 / 11.6.2 | v24.12.0 / 11.6.2 |
| OS | linux 6.18.44 x64, 4 CPU, 15.7 GiB | identical host |
| Verdict | **PASS — 24 pass, 0 fail, 0 skipped, 4.9 min** | **PASS — 24 pass, 0 fail, 0 skipped, 5.2 min** |
| Evidence | `release/evidence.json` | `release/archive-evidence.json` (carries the archive's sha256 and the delivery manifest's tree hash) |

Run B is the Blocker 3 reproduction: it proves the archive installs, builds, migrates, tests and gates itself. It also found three defects invisible in a long-lived working copy (R-36 manifest newline, R-37 hard-coded database port, R-38 shared data-directory startup race); all three are fixed and re-proven.

## 2. Command matrix (§74) — Run B, inside the extracted archive

| # | Step | Status | Duration | Result |
|--:|---|---|---:|---|
| 1 | mandatory checks cannot be skipped (Blocker 5) | PASS | 0.0s | no `RELEASE_GATE_SKIP_*` present |
| 2 | toolchain: Node 24.x | PASS | 0.0s | v24.12.0 |
| 3 | self-contained source tree (Blocker 3) | PASS | 0.0s | every reproduction input present |
| 4 | clean build outputs | PASS | 0.0s | built from source |
| 5 | migration manifest | PASS | 0.3s | 40 frozen migrations verified, frozen through `0039`, nothing unmanifested |
| 6 | database contract from zero | PASS | 2.3s | roles 6 → 40 migrations → no-op rerun → manifest + history verified → tamper rejected → `daftar_app` denied DDL, assertion keys and registry writes |
| 7 | phase 1 machine gate | PASS | 0.3s | product tree, machine checks, workspace integrity, artifact hygiene, RC reports |
| 8 | static architecture guards | PASS | 0.4s | 14 rules |
| 9 | localization completeness | PASS | 0.3s | 187 keys × 3 locales |
| 10 | format | PASS | 4.4s | |
| 11 | build contract + design packages | PASS | 4.1s | |
| 12 | lint (zero warnings) | PASS | 22.4s | |
| 13 | typecheck (all workspaces) | PASS | 14.6s | |
| 14 | unit tests | PASS | 2.3s | 58/58 (domain-core 45, shared-contracts 13) |
| 15 | integration + security tests | PASS | 138.1s | 39 files, 323/323 |
| 16 | golden regression suite | PASS | 38.5s | 7 files, 40/40 |
| 17 | API build | PASS | 5.9s | |
| 18 | merchant web build | PASS | 28.4s | 16 pages × 3 locales |
| 19 | admin web build | PASS | 25.0s | 11 pages |
| 20 | Android lint + unit tests + assemble | PASS | 25.0s | lint 0 errors / 4 warnings, 16/16 JVM tests, `app-debug.apk` 18.5 MB |
| 21 | dependency audit (high/critical = 0) | PASS | 0.8s | 2 moderate remain, dev-only (TD-01) |
| 22 | forbidden artifact scan | PASS | 0.0s | |
| 23 | raw credential scan | PASS | 0.0s | |
| 24 | release documents (§76) | PASS | 0.0s | 21 documents, none a placeholder |

Total 5.2 min. Run A produced the same 24 PASS rows with the same test counts (`release/evidence.json`).

Outside the gate, on the same archive: `npm run perf:baseline` 8/8 — login p95 80.5 ms (argon2id), every other endpoint p95 ≤ 34.6 ms (`release/archive-perf-baseline.json`; table in `PHASE_1_PERFORMANCE_BASELINE.md`).

## 3. Final Release Blocker Patch — status

| Blocker | Verdict | Proof |
|---|---|---|
| 1 — provisioner actor spoofing | CLOSED | Migration `0038`: the actor is a server-minted HMAC assertion (kid, actor, operation kind, expiry, jti) verified inside `provision_actor()` against `provisioning_assertion_keys`, a table with **no grants at all** — no principal, `daftar_platform` included, can read a secret or mutate it directly. Key rotation runs ONLY through the narrow install/retire commands, whose EXECUTE belongs to `daftar_platform` alone. Assertions are kind-bound, expiring, single-transaction with cross-transaction replay protection. `provisioner-boundary.test.ts` (19 cases) proves GUC spoofing, forged/tampered/expired/replayed assertions, wrong kind, non-owner with a valid assertion and foreign-invitation acceptance all fail INSIDE the command; that key secrets are unreadable and the table unmutable for all six principals; that `daftar_platform` install/retire succeed while every other principal is denied; and that neither the commands nor the CLI ever emit key material. Onboarding, second-business creation, invitation acceptance and idempotency all still work. |
| 2 — identifier owner integrity | CLOSED | Migration `0039`: composite FKs to products/variants with an XOR CHECK, DML revoked from `daftar_app` and `daftar_platform`, SECURITY DEFINER sync routine. `catalog-identifiers.test.ts` (13 cases) proves fake owners, cross-business owners, every wrong XOR shape and direct registry DML are refused, and that the lifecycle (create → SKU change → archive → delete) leaves no orphans. |
| 3 — self-contained archive | CLOSED | Run B above. Export ships every git-tracked file and fails if any reproduction input is untracked; the gate runs without `.git`. |
| 4 — KMS transport | CLOSED | Production requires `https://` + `CREDENTIAL_KMS_TOKEN`; bearer auth, abort timeout, 64 KiB response cap, schema validation, no redirects, one retry on transport/502–504, classified errors that never carry plaintext or bodies; encrypt failure rolls the enqueue transaction back. `kms-encryptor.test.ts` (12 cases). |
| 5 — no PASS with mandatory skips | CLOSED | Any `RELEASE_GATE_SKIP_*` fails the release gate before step one; the dev helper is separate and cannot print a release verdict. `release-gate.test.ts` runs the gate itself (4 cases). |
| 6 — Android networking | CLOSED | Debug-only config permits cleartext for `10.0.2.2` alone; release denies cleartext everywhere with an https base URL. `NetworkSecurityConfigTest.kt` (3 cases) parses both configs and the build script. |
| 7 — raw evidence | CLOSED | `evidence.json` schema v2: toolchain, OS, source identity, migration/manifest facts, DB-from-zero results, parsed test counts, Android facts, builds, scans and every command with its exit code — generated, never hand-written. |

## 4. Bug budget (§78)

| Class | Open |
|---|---:|
| P0 | 0 |
| P1 | 0 |
| Security P2 | 0 |
| Tenant isolation / RBAC / data integrity P2 | 0 |
| Frontend/API and Android/API contract P2 | 0 |
| Release reproducibility blockers | 0 |
| Release gate failures | 0 |
| Registered technical debt (P3/P4, non-blocking) | 6 (TD-01…TD-06) |

38 defects were found and fixed with a guard test during the closure and this patch (`PHASE_1_REGRESSION_REPORT.md` R-01…R-38).

## 5. Independent reviews

| Review | Documents | Verdict |
|---|---|---|
| A — Functionality & data integrity | implementation report, test report, multi-user review, entitlement review, regression report | PASS |
| B — Security, architecture, rollback | security review (§9 covers this patch), ASVS mapping, RBAC review, super-admin review, migration history decision | PASS |
| C — UX, visual quality, localization | design review, Android review | PASS (TD-02 admin English-only and TD-06 no rendered viewport audit are documented decisions) |

## 6. Scope

Delivered: every row marked DONE in `PHASE_1_CLOSURE_TRACKER.md`, including the seven blockers above. Not started: any Phase 2 feature — there is no accounting, inventory, sales, POS, purchases, payments, orders, storefront, WhatsApp, AI or CRM code, table or screen. Migrations `0000`–`0039` are frozen; `0038` and `0039` were added by this patch and no frozen file was edited.

## 7. Reproducing this verdict

```
unzip DAFTAR_PHASE_1_RC.zip && cd DAFTAR          # or: git checkout <commit>
sha256sum -c ../DAFTAR_PHASE_1_RC.zip.sha256
nvm install 24.12.0 && npm ci
export ANDROID_HOME=<sdk: platform 35 + build-tools 35.0.0>   # Gradle 8.14.3 on PATH
npm run gate:phase1:release -- --evidence=release/evidence.json
npm run perf:baseline
```

Extract into a **world-traversable** directory: the embedded PostgreSQL drops privileges when running as root, so a root-private parent makes `initdb` fail with EACCES regardless of the archive's contents.

Any step printing FAIL turns this verdict into FAIL. There is no conditional pass.
