# DAFTAR — Phase 1 Protected Behaviors / السلوكيات المحمية

> Directive §5: كل Behavior يعمل حاليًا بشكل صحيح مسجّل هنا.
> Golden Change Rule §6: بعد كل Task إثباتان — NEW WORKS + PREVIOUS STILL WORKS.
> يُضاف كل سلوك جديد ينجح إلى هذا السجل.

## PB — domain-core (محمي بـ 41 unit test في packages/domain-core/test/domain-core.test.ts)

| ID | السلوك | Guard test |
|---|---|---|
| PB-01 | Money exact arithmetic (bigint minor، بدون float) | money tests |
| PB-02 | Large BigInt values فوق Number.MAX_SAFE_INTEGER | `9007199254740993n`, `999999999999999999n` |
| PB-03 | Currency mismatch rejection في add/subtract/compare | CURRENCY_MISMATCH tests |
| PB-04 | Unsafe number input rejection (UNSAFE_NUMBER عبر isSafeInteger) | `2 ** 53 + 1` rejected |
| PB-05 | Negative policy: افتراضي ممنوع، signed صريح يت propagate | NEGATIVE_NOT_ALLOWED tests |
| PB-06 | Money.times integer-only | fractional factor rejected |
| PB-07 | BigInt-safe formatting (لا Number(bigint)) — parts exact، سالب ar/en/tr، zero، JOD 3 | formatMoney tests |
| PB-08 | Country Packs readonly + recommendedCurrencies (توصية لا whitelist) | country-pack tests |
| PB-09 | Locale fallback + RTL/LTR + Turkish chars | locale tests |
| PB-10 | Currency display names عبر Intl.DisplayNames (CLDR SoT) | 'Türk lirası' test |
| PB-11 | Arabic slug suggestion (`متجر` → `mtjr`) | slug tests |
| PB-12 | Fallback slug `store-<random token>` (غير متكرر) | token uniqueness test |
| PB-13 | Reserved slugs مرفوضة | validateSlug tests |
| PB-14 | RBAC permission evaluation الصحيح (owner built-in system role، لا boolean bypass) | permissions tests |

## PB — toolchain (§116 regression دائم)

| ID | السلوك | Guard |
|---|---|---|
| PB-15 | typecheck يفحص Source + Tests فعليًا (لا TS6059) | npm run typecheck |
| PB-16 | Lockfile reproducibility (npm ci من fresh clone) | clean-env gate §117 |
| PB-17 | Workspace integrity (لا ghost workspaces في package.json) | reality audit §1 |

---

### إضافات بعد استعادة البناء (تُحدَّث مع كل Task)

_تُسجَّل هنا: migrations contract، RLS isolation، auth rotation/reuse، onboarding atomicity+idempotency+fallback-slug stability، slug race، last-owner race، catalog invariants، media security، outbox atomicity، pooled-connection safety، localization parity، …_

## PB — Phase 1 closure additions (guarded; a failing guard blocks release)

| ID | Behaviour | Guard test |
|---|---|---|
| PB-18 | Provisioning commands refuse a missing, malformed or non-owner actor context; idempotency records are actor-scoped | `tests/security/provisioner-boundary.test.ts` |
| PB-19 | Merchant, platform and worker runtimes boot with only their own pools/adapters; `PROCESS_MODE=all` refused in production | `tests/integration/runtime-isolation.test.ts`, `production-providers.test.ts` |
| PB-20 | DEV credential key impossible under `NODE_ENV=production`; HTTP runtimes hold no decrypt ring | `production-providers.test.ts` |
| PB-21 | Every merchant web client call matches method/path/body/wrapper/DTO of the API (44 rows) | golden `06-web-contract` |
| PB-22 | Every admin client call matches the API and uses shared DTOs (24 rows); no snake_case leaks | golden `07-admin-contract` |
| PB-23 | Money formatting never converts BigInt to Number; 18-digit minor units format exactly in ar/en/tr for ILS/JOD/TRY/USD | shared-contracts money tests, static guard 6b |
| PB-24 | Android retry replays the original request with the same Idempotency-Key | `RetryContractTest.kt` |
| PB-25 | Product/category translations are rows; a product cannot exist without a translation; JSONB columns are gone | `tests/security/catalog-identifiers.test.ts` |
| PB-26 | SKU/barcode uniqueness is business-wide across products and variants; archiving releases identifiers | `tests/security/catalog-identifiers.test.ts` |
| PB-27 | Audit/outbox rows with a business always carry the tenant | migration 0035 CHECK, `outbox.test.ts` |
| PB-28 | Rate limiter outage → 503 + Retry-After (fail closed) | `tests/security/auth-abuse.test.ts` |
| PB-29 | Platform-owner bootstrap runs only as the platform principal, exactly once under a race, never overwrites an existing password | `tests/integration/bootstrap-owner.test.ts`, `support-sessions.test.ts` |
| PB-30 | Same invitation accepted twice concurrently → one 200, one 404, one membership | `tests/integration/concurrency-matrix.test.ts` |
| PB-31 | Concurrent publish of one draft → one 200, one 409, one audit event | `concurrency-matrix.test.ts` |
| PB-32 | A removed member never keeps effective roles even when a role change races the removal | `concurrency-matrix.test.ts` |
| PB-33 | Concurrent onboarding with one Idempotency-Key → one 201 + one 200 replay (same payload) or one 409 (different payload), one business | `concurrency-matrix.test.ts` |
| PB-34 | Crashed worker lease is reclaimed after expiry and the job delivered once; a live lease is never stolen | `tests/integration/failure-injection.test.ts` |
| PB-35 | A migration failing mid-file rolls back atomically with no history row; runtime principals cannot migrate | `failure-injection.test.ts` |
| PB-36 | Frozen migrations 0000–0037 never change (SHA-256 manifest) | `npm run check:migrations`, CI tamper proof |
| PB-37 | Merchant web builds and prerenders all 16 pages × 3 locales; 187 keys present in every locale | `next build`, `check:localization` |
| PB-38 | Last-owner operations under concurrency never deadlock (business-level advisory lock) | `owner-authority.test.ts`, `isolation.test.ts` |
| PB-39 | `npm audit --audit-level=high` reports 0 high/critical | CI hygiene job, `gate:phase1:release` |
