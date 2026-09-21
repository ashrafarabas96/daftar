# DAFTAR — Subscription & Entitlement Architecture / معمارية الاشتراكات

## 1. المبدأ

**Entitlement Engine مركزي** (Master §120): ممنوع تبعثر شروط الباقات داخل Core Business Logic. لا يوجد `if plan == PRO` داخل Domains — يوجد فقط `entitlements.check(tenant, feature_key)`.

## 2. الباقات

FREE · STARTER · PRO · BUSINESS — تُعرّف كبيانات (plans.limits_json) لا ككود:

| الاستحقاق (feature_key) | نوعه | أمثلة حدود |
|---|---|---|
| branches.max | عددي | 1 / 1 / 3 / ∞ |
| users.max | عددي | 1 / 2 / 5 / ∞ |
| products.max | عددي | 50 / 500 / ∞ / ∞ |
| whatsapp.enabled | منطقي | ✗ / ✓ / ✓ / ✓ |
| whatsapp.messages.monthly | عددي | — / 100 / 1000 / ∞ |
| ai.enabled | منطقي | ✗ / ✗ / ✓ / ✓ |
| ai.voice.enabled | منطقي | ✗ / ✗ / ✓ / ✓ |
| storefront.enabled | منطقي | ✗ / ✓ / ✓ / ✓ |
| reports.advanced | منطقي | ✗ / ✗ / ✓ / ✓ |
| offline.mode | منطقي | ✗ / ✗ / ✓ / ✓ |
| multi_currency.enabled | منطقي | ✗ / ✓ / ✓ / ✓ |

(الحدود النهائية قرار تجاري يُضبط كبيانات قبل الإطلاق — الجدول أعلاه للتصميم.)

## 3. Entitlement Engine

- واجهة واحدة: `check(feature_key) → {allowed, limit, used, remaining}`.
- التخزين: `entitlements` لكل tenant؛ تُحدَّث عند تغيّر الاشتراك عبر حدث `entitlement.changed`.
- الاستعلامات مكررة → cache قصير العمر مع invalidation عند التغيير.
- **قراءة الاستحقاق في حدّين فقط**: نقطة دخول API (فرض) + UI (إخفاء/إظهار تدريجي). الفرض دائمًا على الخادم.

## 4. Plan Limit UX (Master §121)

عند بلوغ حد: رسالة تشرح (السبب + الحد + الاستخدام الحالي) + زر Upgrade — **دون إتلاف بيانات**: تجاوز حد المنتجات لا يحذف منتجات موجودة؛ يمنع الإضافة الجديدة فقط.

## 5. دورة حياة الاشتراك

انظر State Machines §6: trialing → active → past_due → (active | suspended) → cancelled/expired.
- **Grace period** قبل التعليق، وسياسة تدرّج موثّقة: قراءة البيانات متاحة دائمًا؛ الإنشاء الجديد يتقيّد أولًا.
- الفوترة/التحصيل الخارجي (بوابات دفع الاشتراكات) قرار لاحق موثّق في Open Decisions.

## 6. قواعد

1. Super Admin يغيّر باقة عبر Domain Command موثّق (UpgradeToPlan/ExtendTrial) مع Audit — لا تعديل مباشر.
2. تغيير الباقة لا يمس البيانات التجارية إطلاقًا.
3. كل feature_key جديد يُسجَّل في هذا الملف قبل استخدامه.
4. الاختبارات: لكل حدّ — ما دونه، عنده، فوقه؛ ترقية وتخفيض أثناء وجود بيانات فوق الحد الجديد.
