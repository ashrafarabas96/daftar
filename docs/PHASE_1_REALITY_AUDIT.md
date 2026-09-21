# DAFTAR — Phase 1 Reality Audit / تدقيق الواقع

> Directive §4: هذا الملف هو الـ Baseline الإلزامي قبل أي تعديل Code.
> تاريخ التدقيق: 2026-09-19 · Node v24.12.0 · npm 11.6.2

## 1. Repository tree (الواقع الفعلي)

```
daftar/
├── package.json            # workspaces: api, web, domain-core, design-system, shared-contracts
├── package-lock.json       # أُعيد إنشاؤه (npm install على Node 24) — موجود الآن
├── tsconfig.base.json      # strict + noUncheckedIndexedAccess + decorators
├── tsconfig.json           # root solution file (files: [])
├── eslint.config.mjs       # real lint (typed rules) — يعمل
├── .nvmrc / .node-version  # 24.12.0
├── TECHNICAL_DEBT.md       # Phase 0 register (فارغ من الديون)
├── docs/                   # Phase 0 docs كاملة + PHASE_1_PREFLIGHT_PATCH.md
├── infrastructure/         # فارغ — migrations مفقودة
├── packages/
│   ├── domain-core/        # ✅ موجود وفعّال (src + test + configs)
│   ├── design-system/      # ⚠️ مجلد شبح (src فارغ)
│   └── shared-contracts/   # ⚠️ مجلد شبح (src فارغ)
├── apps/
│   ├── api/                # ⚠️ ghost (src فارغ)
│   ├── web/                # ⚠️ ghost (فارغ)
│   └── android/            # ⚠️ ghost (فارغ)
└── tests/                  # مجلدات فارغة (integration/security/golden/visual/load)
```

## 2. Status matrix

| البند | الحالة | الدليل |
|---|---|---|
| Actual workspaces | domain-core فقط فعّال | §1 |
| Missing workspaces | api, web, design-system, shared-contracts, android (محتوى) | ghost folders |
| Build | domain-core PASS (`tsc -p tsconfig.build.json`) | تم التحقق |
| Typecheck | domain-core PASS بعد إصلاح §9 (TS6059: فصل build/typecheck configs) | تم التحقق |
| Lint | PASS (eslint flat config + typed rules، 0 errors) | تم التحقق |
| Unit tests | domain-core 41/41 PASS | vitest run |
| Package installation | PASS (181 packages, Node 24.12.0) | npm install |
| Lockfile | ✅ موجود الآن (أُعيد إنشاؤه — كان مفقودًا) | package-lock.json |
| API | ❌ غير موجود (src فارغ) | — |
| Web | ❌ غير موجود | — |
| Android | ❌ غير موجود | — |
| Database | ❌ لا migrations، لا runner | infrastructure فارغ |
| Migrations | ❌ مفقودة كليًا | — |
| CI | ❌ غير موجود | — |
| Security tests | ❌ غير موجودة | tests/security فارغ |
| Golden tests | ❌ غير موجودة | tests/golden-regression/phase1 فارغ |
| Visual tests | ❌ غير موجودة | tests/visual فارغ |

## 3. Known errors (أخطاء معروفة وقت التدقيق)

1. ~~TS6059 في domain-core typecheck~~ → **أُصلح**: فصل `tsconfig.json` (typecheck: src+test+config بدون rootDir) عن `tsconfig.build.json` (emit: src فقط) — مطابق لحرفية §9 من الموجّه.
2. ~~eslint.config.mjs خارج projectService~~ → **أُصلح**: `allowDefaultProject: ['eslint.config.mjs']`.
3. كل ما عدا domain-core غير منفَّذ — ليس "معطوبًا" بل "غير موجود" (لا نثق بأسماء المجلدات §3 من الموجّه).

## 4. Known working behaviors (سلوكيات تعمل — تحت الحماية §5)

- Money exact arithmetic عبر BigInt (بما فيه قيم > Number.MAX_SAFE_INTEGER: 9007199254740993، 999999999999999999 minor).
- رفض number غير الآمن في `ofMinor` (UNSAFE_NUMBER) — الالتزام بـ `Number.isSafeInteger` إلزاميًا.
- Negative money policy: ممنوع افتراضيًا، `signed` صريح عبر add/subtract/negate.
- `Money.times` integer-only (Phase 1).
- BigInt-safe formatting (formatToParts skeleton، بدون Number(bigint)) بما فيه JOD 3 decimals والسالب بثلاث لغات.
- Currency/Country display names عبر Intl.DisplayNames (CLDR SoT، لا transliteration يدوي).
- Country Packs readonly + `recommendedCurrencies` (توصية UX لا whitelist أمنية).
- Arabic slug transliteration (`متجر` → `mtjr`) + fallback `store-<token>` + reserved slugs.
- Locale fallback + RTL/LTR + Turkish characters + plural rules.

Baseline مثبت — لا يبدأ تنفيذ ما بعده إلا على هذا الواقع.

## 5. Closure-time re-audit (2026-09-21 · Node v24.12.0 · npm 11.6.2 · branch `claude/new-session-2sxgo5`)

The handover archive (Kimi agent export) was imported as-is (commit 53bbb50) and re-audited before any change. Reality then:

| Item | Archive state | Evidence |
|---|---|---|
| `npm ci` | FAIL — lockfile carried a versionless stub and 531 URLs to a private mirror | fixed in 0c60b54 |
| Integration suite | 130 failures: connection slots exhausted (apps leaked per test) | fixed in 0c60b54 (harness lifecycle guard) |
| Lint / typecheck | 800 lint errors, TS2307: design-system `dist` never built before typecheck | build order fixed in CI + local |
| Prettier | 209 unformatted files | config + one reformat |
| Provisioner | authorization outside the mutation; actor id passed by caller | `0033` |
| Runtimes | one `AppModule`; isolation only by env validation | per-process modules |
| Web ↔ API contract | 44 client calls, 19 with mismatched shapes (`{ok:true}`, snake_case, missing `{items}`) | golden 06 |
| Admin ↔ API | pages read raw proxy JSON | golden 07 |
| Android | retry rebuilt requests; `Double` money; hand-written DTOs | 7ef906c |
| Migrations | 0000–0032 present; manifest frozen through 0027 | now 0000–0037 frozen |
| Docs | Phase 0 set + reality audit + protected behaviours; no Phase 1 closure documents | 21 documents at closure |

Reality at the FIRST closure (historical snapshot, commit `db24f70`, superseded by the Final Release Blocker Patch and the Final Phase 1 Closure): 74 routes, 38 migrations, 33 RLS policies, 16 SECURITY DEFINER commands, 291 integration/security cases, 40 goldens, 58 unit tests, 13 Android JVM tests, 16 web pages, 11 admin pages, 187 × 3 i18n keys.

Current evidence (not this historical snapshot) is in `PHASE_1_TEST_REPORT.md`: 40 migrations, 326 integration/security cases in 39 files, 40 goldens, 58 unit tests, 16 Android JVM tests — 440 release-gate automated tests, plus 8 performance benchmarks reported separately.

Current measured reality is recorded in `PHASE_1_ACCEPTANCE_REPORT.md` and regenerated into `release/evidence.json` by every release-gate run; the migration set is now 0000–0039.
