# DAFTAR — Implementation Roadmap / خارطة الطريق التنفيذية

> وثيقة تخطيط فقط — **لا يبدأ التنفيذ الآن**. كل Phase لها Gate وفق `DAFTAR_RELEASE_GATES.md`، وتنتهي نظيفة (لا تراكم أخطاء).

## Phase 0 — Product, Architecture & Quality Foundation (الحالية)
كل وثائق `docs/` + Acceptance Report. **مخرجة: قرار PHASE 0 PASS.**

## Phase 1 — Core Platform Skeleton
- Tenancy + Identity/RBAC + إعدادات Business/Branch/Warehouse.
- Design System (packages) + هيكل apps (api/web/android) + CI/CD + Observability أساسية.
- Catalog (منتجات/تصنيفات/صور) + Localization infrastructure (ar/en/tr).
- **Gate:** tenant isolation مُثبت، CI أخضر، Design tokens معتمدة.

## Phase 2 — Money Core
- Accounting Engine (Posting + CoA seeding) + Inventory Ledger + Sales/Invoices/Payments/Receivables + POS (ويب أولًا).
- Cash/Credit/Partial + Dashboard الأساسي.
- **Gate:** Golden 01–08, 19–21 خضراء؛ Invariants آلية.

## Phase 3 — Debts, Installments, Returns
- Installments + Returns/Refunds/Credit Notes + كشوف الحساب + تقارير أساسية.
- **Gate:** Golden 09–12 + Reconciliation jobs تعمل.

## Phase 4 — Purchases, Suppliers, Expenses + Offline Android
- دورة الشراء والمخزون المتقدم (تحويلات/جرد) + Android مع Offline Sync مصمَّم.
- **Gate:** Golden 18 + اختبارات تعارض المزامنة.

## Phase 5 — Online Store & Orders
- Storefront عام + Cart/Checkout + دورة الطلبات + الحجوزات.
- **Gate:** Golden 13–14 + أداء Storefront (LCP).

## Phase 6 — WhatsApp
- الربط الرسمي + القوالب + الرسائل التلقائية + كشف الحساب + التقرير اليومي.
- **Gate:** Golden 15 + موثوقية الطابور.

## Phase 7 — AI Assistant
- STT + Intent + Drafts + Confirmation + تدقيق كامل.
- **Gate:** Golden 16–17 + اختبارات الحقن والغموض.

## Phase 8 — Subscriptions, Entitlements, Super Admin
- Entitlement Engine + الباقات + لوحة المنصة + الفوترة (حسب القرار التجاري).
- **Gate:** Golden 22 + حدود الباقات مفروضة على الخادم.

## Phase 9 — Hardening & Launch
- التدقيقات النهائية الأربعة (Simplicity/Premium/Financial Integrity/Regression) + Load tests + Restore drill + Country packs نهائية بمصادر رسمية.
- **Gate:** Launch Definition كامل (Master §166) → إطلاق تدريجي.

## قواعد
1. لا انتقال بين المراحل دون PASS موثّق.
2. داخل كل Phase: أمر البدء (Master §178) وأمر الانتهاء (§179) يلزمان كل مهمة.
3. الترتيب قابل لضبط طفيف بقرار موثّق؛ ترتيب الاعتماديات (Accounting قبل Sales الكاملة، Inventory قبل Storefront) غير قابل للكسر.
