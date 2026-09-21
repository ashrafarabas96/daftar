# DAFTAR — Phase 1 Android Review / مراجعة تطبيق أندرويد

## 1. Scope (§32 — Phase 1 Android is online-only)

Kotlin + Jetpack Compose, `minSdk 26`, `targetSdk 35`, `compileSdk 35`, 16 Kotlin files / 1 405 lines. Screens: login, onboarding, home (business switch), product list, product edit (translations, price, identifiers, photo upload), team (read-only member list), plan, settings. No offline sync (Phase 4), no POS (Phase 2).

## 2. Contract discipline (§30–31)

- `data/ApiClient.kt` builds every call from a `RequestSpec` (method, path, headers, body, idempotency key). A retry **replays the original spec** — same body, same `Idempotency-Key`, same `X-Business-Id` — never a rebuilt request. Verified with MockWebServer in `RetryContractTest.kt` (13 JVM tests in total with `ApiContractTest.kt` and `MoneyTest.kt`).
- DTOs are declared with kotlinx.serialization and mirror `@daftar/shared-contracts` field names (`ApiContractTest.kt` decodes fixture JSON produced from the TypeScript DTOs: `ListDto`, `ProductDto`, `EntitlementDto`, `MemberDto`, `BusinessSettingsDto`, `ApiErrorBody`).
- Lists are `{ items, nextCursor }`; acknowledgements are DTOs, never `{ok:true}`.
- Errors: the stable `error.code` drives the UI message; `requestId` is shown in the error sheet for support.

## 3. Money (§34–36)

- `data/Money.kt` keeps minor units as `BigDecimal` with the currency's exponent from the same registry values as domain-core (ILS/JOD/TRY/USD tested at 18-digit magnitudes in `MoneyTest.kt`); no `Double`/`Float` anywhere in money paths (reviewed file by file; `MoneyTest.kt` covers parse/format/compare).
- Formatting uses `java.text.NumberFormat` with the app locale (ar/en/tr) and never `toDouble()`.

## 4. Security

- Tokens in `KeystoreTokenStore` (AndroidKeyStore-backed AES-GCM); the `TokenStore` interface allows the in-memory double in tests.
- Refresh on 401 once, then logout; refresh reuse detection on the server invalidates the lineage.
- `network_security_config.xml`: `cleartextTrafficPermitted="false"`; certificate pinning left to deployment (documented in `DAFTAR_AWS_REFERENCE_ARCHITECTURE.md`).
- No secrets in the APK; `BuildConfig.API_BASE_URL` per build type (debug → emulator host, release → production host).

## 5. Localization

`values`, `values-ar`, `values-tr` each carry the same 57 keys (counted at closure; Gradle lint's `MissingTranslation` check runs in the release matrix). RTL mirrored layouts (`android:supportsRtl="true"`), logical paddings in Compose.

## 6. Toolchain evidence

```
cd apps/android && gradle lint testDebugUnitTest assembleDebug
```
Result on the closure commit: lint 0 errors (4 informational warnings: unused resources in theme, `GradleDependency` newer versions), 13/13 JVM tests, `app-debug.apk` assembled. Instrumented UI tests are deferred to a device lab (`TECHNICAL_DEBT.md`).

## 7. Findings

| # | Finding | Resolution |
|---|---|---|
| A-1 | Retry rebuilt the request and generated a new idempotency key (duplicate business on flaky network) | `RequestSpec` replay (`7ef906c`), `RetryContractTest` |
| A-2 | Money parsed with `toDouble()` | `BigDecimal` + exponent registry, `MoneyTest` |
| A-3 | DTOs hand-written with snake_case remnants | Regenerated from shared contracts; `ApiContractTest` |

**Verdict: PASS for Phase 1 scope.**
