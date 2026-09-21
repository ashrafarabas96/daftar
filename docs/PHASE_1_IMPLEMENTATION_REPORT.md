# DAFTAR — Phase 1 Implementation Report / تقرير التنفيذ

> What was built in the closure, on top of the archive, in the order the directive demanded: REPRODUCE → FAILING TEST → ROOT CAUSE → SMALLEST FIX → TARGETED TEST → REGRESSION. Nothing was restarted; the stack (NestJS 11, Next 15, Kotlin/Compose, PostgreSQL 18, Node 24.12) is unchanged.

## 1. Inventory at closure (measured, not estimated)

| Area | Count |
|---|---:|
| API source files / lines (`apps/api/src`) | 42 / 6 991 |
| HTTP routes / controllers | 74 / 6 |
| Permissions in the registry | 38 |
| SQL migrations (all frozen, SHA-256 in manifest) | 38 (0000–0037) |
| RLS policies / indexes / SECURITY DEFINER functions | 33 / 31 / 16 |
| Database principals | 6 (`daftar_app`, `daftar_platform`, `daftar_identity`, `daftar_resolver`, `daftar_worker`, `daftar_provisioner`) |
| Merchant web pages / admin pages | 16 / 11 |
| i18n keys (merchant web) | 187 × 3 locales (ar/en/tr) |
| Android Kotlin files / lines; string resources | 16 / 1 405; 57 × 3 locales |
| Design-system components | 34 exported components + token sets |
| Unit tests (domain-core + shared-contracts) | 58 |
| Integration + security tests | 291 cases in 36 files |
| Golden regression cases | 40 (P1-GOLD-01…40) |
| Android JVM tests | 13 |
| Static guard rules | 14 |

## 2. Work delivered per commit (branch `claude/new-session-2sxgo5`)

| Commit | Scope | Root cause fixed |
|---|---|---|
| 53bbb50 | Import of the handover archive (no `dist`, no `node_modules`) | — |
| 0c60b54 | Toolchain + harness: repaired lockfile (mirror URLs, versionless stub), design-system build order, Prettier config, per-test app lifecycle guard, business-level advisory lock in `lockMembership` | 130 test failures from connection exhaustion; 40P01 deadlock on last-owner race |
| 9c31276 | Provisioner atomic authority (`0033`): actor from `app.actor_user_id`, authorization inside the SECURITY DEFINER command, actor-scoped idempotency | A caller could pass any user id to `provision_create_business` |
| 148d397 | Real runtimes: `MerchantApiModule`, `PlatformApiModule`, `WorkerModule`; pools opened strictly by mode; `PROCESS_MODE=all` refused in prod; DEV key impossible in prod | "Isolation" existed only as env validation, not as process composition |
| 7ef906c | Contract alignment: shared DTOs for every response, `{items}` lists, product media signed URLs, web client rewritten and audited by golden 06, Android client (RequestSpec replay, BigDecimal money), money formatting delegated to domain-core, static guard 6b | Web called undocumented shapes; Android retry rebuilt requests with new keys; two currency tables |
| efa250a | Admin DTOs + plan builder, `0034`/`0035` (grants, business ⇒ tenant CHECK + backfill, indexes), fail-closed limiter (503 + Retry-After), CI DB from zero, static guards 13–14, `verify:history` fix | Admin pages used raw proxy shapes; audit rows without tenant; limiter outage failed open; CI never built a DB from nothing |
| 0cc240e | `0036` normalized translations, `0037` identifier registry, catalog service rewrite, platform-owner bootstrap (platform principal, advisory lock, promote-existing) | JSONB translations unqueryable; SKU uniqueness per table only; bootstrap ran with migration credentials |
| 8d0eff5 | Merchant web completeness (§62): 8 new/rebuilt pages, +89 keys per locale, isomorphic slug token, Suspense for `useSearchParams` | Missing screens; `node:crypto` broke the client bundle |
| b6cfab5 | Concurrency matrix + failure-injection suites (§66–67) | Races and faults were asserted in prose only |
| da2f995 | Dependency audit: next 15.5.25, nest 11.2.5, sharp 0.35.4, image-size 2.0.4, overrides multer 2.4.0 / postcss 8.5.28 | 12 advisories (1 critical) |
| 96a076c | `gate:phase1:release`, manifest frozen through 0037, checker derives policy from `frozenThrough` | No single command produced release evidence |

## 3. Rules honoured (spot-checkable)

- **No test was disabled, skipped or quarantined.** `grep -rn "it.skip\|describe.skip\|xit(" tests` returns nothing.
- **No RLS was disabled and no broad privilege was granted.** Grants added in `0034` are the two DELETE grants the plan builder needs on `plan_entitlements` / `plan_limits` for DRAFT versions only (published rows are frozen by trigger).
- **No `@ts-ignore`, no float money, no BigInt→Number for money.** Guarded by static guards 6/6b and lint (`--max-warnings 0`).
- **No frozen migration modified.** `npm run check:migrations` verifies 38 SHA-256 hashes; every schema correction is `0033`–`0037`.
- **No swallowed errors.** Every `catch` in `apps/api/src` re-throws, classifies (`classifyDeliveryError`) or logs structured with `requestId`; drain failures are counted.
- **No fake adapters in production.** `loadConfig` refuses `MEDIA_STORAGE=local`, `CREDENTIAL_DELIVERY_KIND=log`, missing `REDIS_URL`, missing `CREDENTIAL_KMS_ENDPOINT` under `NODE_ENV=production`.

## 4. Verification commands (all pass on the closure commit)

```
npm ci
npm run check:migrations && npm run gate:phase1 && npm run check:guards && npm run check:localization
npm run format && npm run lint && npm run typecheck && npm test
npm run test:integration && npm run test:golden
npm run build -w @daftar/api && npm run build -w @daftar/web && npm run build -w @daftar/admin
npm audit --audit-level=high
cd apps/android && gradle lint testDebugUnitTest assembleDebug
npm run gate:phase1:release -- --evidence=release/evidence.json
```

Real durations and exit codes are in `PHASE_1_ACCEPTANCE_REPORT.md`.
