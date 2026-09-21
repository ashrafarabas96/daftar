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
