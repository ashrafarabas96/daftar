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
