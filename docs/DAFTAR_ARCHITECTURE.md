# DAFTAR — System Architecture / المعمارية العامة

## 1. القرار المعماري الأعلى

**Modular Monolith** في البداية (Master §58) — Backend واحد منظم بحدود Domain صارمة، قابل للتفكيك لاحقًا إلى Services عند الحاجة دون إعادة بناء الـ Core. ليس Microservices عشوائية.

## 2. المكونات

| المكوّن | الدور | ملاحظات |
|---|---|---|
| Backend (Modular Monolith) | كل Domains التجارية | Stateless، قابل للتوسع الأفقي |
| Web App | لوحة التاجر + Super Admin + Storefront | SPA/SSR، نفس Design System |
| Android App | تجربة الموبايل الأصلية + Offline | Offline-first مصمَّم لا مرتجل |
| PostgreSQL | قاعدة البيانات الرئيسية | Constraints قوية، PITR |
| Redis | Cache، Sessions، Rate limiting، Queue backend | لا يُستخدم كمصدر حقيقة مالية |
| Queue/Workers | Jobs غير متزامنة: Outbox publisher، WhatsApp، تنبيهات، Reconciliation | Retry + Dead-letter + Alerts |
| Object Storage | صور المنتجات والملفات | الأصل محفوظ + Variants مُحسّنة، CDN أمامها |
| WhatsApp Gateway | تكامل واتساب الرسمي | Event-driven فقط |
| AI Gateway | STT + LLM عبر Typed Tools | ليس سلطة مالية |
| Analytics | Read models من الأحداث | فشله لا يفشل المعاملات |
| Observability | Logs/Metrics/Traces + Correlation IDs | إلزامي منذ اليوم الأول |

## 3. الحد الحاسم: متزامن vs غير متزامن

**Critical synchronous (ضمن DB Transaction واحدة + Outbox):**
- إتمام بيع: Sale + Items + Invoice + Payment + Stock movements + Journal + Outbox rows — **ذرّية: كلها أو لا شيء**.
- تسجيل دفعة، مرتجع، استرداد، قبول طلب، شراء، مصروف.

**Asynchronous side effects (عبر Outbox → Queue → Workers):**
- رسائل واتساب، الإشعارات، التحليلات، تحديث Search index، تقارير، webhooks للمتجر.

قاعدة: فشل WhatsApp لا يفشل البيع؛ فشل Analytics لا يفشل الدفع (Master §56–57).

## 4. أنماط ملزمة

1. **Outbox Pattern**: الأحداث تُكتب في نفس معاملة الحدث التجاري، ثم Publisher ينشرها (at-least-once) — المستهلكون Idempotent.
2. **Idempotency**: كل عملية معرضة للتكرار تحمل `idempotency_key`؛ الويبهوكس والمزامنة تُعالج التكرار.
3. **CQRS خفيف للقراءة الثقيلة**: Dashboards والتقارير من Read models، لا من استعلامات Ledger مباشرة.
4. **Money Value Object** مركزي: ممنوع Float؛ مبلغ + عملة + دقة ثابتة.
5. **Tenant/Business Isolation**: كل جدول تجاري — بما فيه الجداول الفرعية — يحمل `tenant_id` + `business_id`، مع **Composite FKs** تمنع الربط العابر للأنشطة على مستوى قاعدة البيانات، وفلترة إلزامية على طبقة الوصول، واختبارات Cross-tenant/Cross-business في CI.
5ب. **Identity مستقلة عن الملكية**: users عالمية + tenant_memberships/business_memberships/branch_access — المستخدم قد يدير عدة Businesses بأمان؛ الصلاحيات تُقيَّم في سياق (user × business × branch). الدفاتر المحاسبية والعملة الأساسية لكل Business.
6. **Audit**: كل عملية حساسة تكتب AuditEvent (من، ماذا، متى، قبل/بعد، request_id).
7. **Traceability**: كل Request له `request_id` و`correlation_id`، والمعاملات المالية لها `business_transaction_id` تربط الصوت→API→Sale→Journal→Stock→WhatsApp.

## 5. هيكل المستودع (Repository Structure)

```
daftar/
├── apps/
│   ├── api/                  # Modular Monolith (entrypoint)
│   ├── web/                  # تطبيق الويب (تاجر + admin)
│   ├── storefront/           # المتجر الإلكتروني العام
│   ├── android/              # تطبيق أندرويد
│   └── admin/                # لوحة Super Admin (أو module داخل web)
├── services/
│   ├── whatsapp-worker/
│   ├── outbox-publisher/
│   ├── reconciliation-worker/
│   └── ai-gateway/
├── packages/
│   ├── domain-core/          # Money, IDs, Errors, Result types
│   ├── design-system/        # Tokens + components مشتركة للويب
│   └── shared-contracts/     # API contracts, event schemas
├── modules/ (داخل api)
│   ├── identity/ tenancy/ catalog/ inventory/ sales/
│   ├── payments/ receivables/ installments/ purchases/
│   ├── expenses/ accounting/ orders/ customers/
│   ├── whatsapp/ ai/ notifications/ analytics/
│   └── subscriptions/ audit/ platform-admin/
├── infrastructure/
│   ├── database/ (migrations)
│   ├── terraform أو ما يعادلها
│   └── ci-cd/
├── tests/
│   ├── golden-regression/
│   ├── load/
│   └── security/
└── docs/                     # هذا المجلد (وثائق Phase 0)
```

مبدأ: لا تعقيد شكلي؛ البنية تخدم الحدود الفعلية فقط.

## 6. قواعد التكامل بين الواجهات

- API واحد موحّد للويب وأندرويد، مع **Backward Compatibility** إلزامية لإصدارات أندرويد المنشورة (Master §114).
- Storefront يستخدم Public API منفصل الصلاحيات.
- Zero Trust: الخادم يعيد التحقق من السعر/الإجمالي/الصلاحية/المخزون ولا يثق بالعميل (Master §115).

## 7. البيئات وسلسلة الإصدار

Development → Automated checks → Staging → QA → Regression → Security → Release Candidate → Production، مع Smoke Tests بعد كل نشر وRollback Plan لكل إصدار مهم.

## 8. قرارات معمارية مسجلة (ADR مبدئية)

| # | القرار | البدائل المرفوضة | السبب |
|---|---|---|---|
| ADR-001 | Modular Monolith | Microservices من اليوم الأول | بساطة التشغيل، سلامة المعاملات، فريق صغير (Master §58) |
| ADR-002 | PostgreSQL مصدر حقيقة واحد | قواعد متعددة لكل module | Atomicity للمعاملات المالية |
| ADR-003 | Outbox + Workers | استدعاءات متزامنة للـ side effects | عزل الفشل (Master §56–57) |
| ADR-004 | Money VO + BIGINT minor units | Float/Decimal حر | Money Safety (Master §30) |
| ADR-005 | Stock Ledger | تحديث كمية مباشر | تتبع وإعادة بناء (Master §42–43) |
| ADR-006 | Internal Double-Entry Ledger | أرصدة يدوية | دقة وقابلية تدقيق (Master §34–36) |
| ADR-007 | Redis للـ cache/queue فقط | Redis كمصدر حقيقة | المتانة |
| ADR-008 | API موحّد + Public storefront API | APIs منفصلة لكل عميل | اتساق وتكلفة صيانة أقل |
