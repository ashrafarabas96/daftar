# DAFTAR — PHASE 0 CORRECTION REPORT / تقرير التصحيح والتحصين

التاريخ: 2026-09-19 · النطاق: Correction & Hardening Pass داخل Phase 0 فقط — بدون أي كود.

## ملخص تنفيذي

عولجت النقاط A–X الـ24 كاملة. أُعيدت كتابة 3 وثائق جوهرية (Data Model, Accounting Rules, Inventory Rules)، وحُدّثت 15 وثيقة أخرى، وأُضيفت 12 سيناريو Golden جديدًا (GOLD-25..36) و4 Invariants جديدة، وأُغلق OD-01.

## سجل المشكلات والتصحيحات

| # | المشكلة | السبب الجذري | القرار الجديد | الوثائق المعدّلة | اختبارات جديدة |
|---|---|---|---|---|---|
| A | غموض ملكية Tenant/Business: base_currency على Tenant بينما المعمارية تعاملها كخاصية Business؛ دفاتر غير محسومة النطاق | نموذج ملكية غير محسوم | Business يملك country/base_currency/timezone/locale/storefront/الدفاتر؛ البيانات التجارية business_id إلزامي + tenant_id للعزل؛ CoA/Ledger لكل Business | DATA_MODEL, DOMAIN_MAP, ARCHITECTURE, PRODUCT_SPEC | GOLD-31 |
| B | users محصورة بـtenant_id تمنع إدارة عدة أنشطة | دمج الهوية بالملكية | Identity عالمية + tenant_memberships + business_memberships + branch_access؛ SoT الصلاحيات = business_roles على العضويات | DATA_MODEL, DOMAIN_MAP, SECURITY_MODEL | GOLD-29 |
| C | تعارض Warehouse (تابع Branch في ERD / Business في الجدول) | صياغة غير محسومة | Warehouse يتبع Business؛ Branch.default_warehouse اختياري بـComposite FK لنفس النشاط | DATA_MODEL, DOMAIN_MAP | Contract tests |
| D | payment_allocations بمبلغ واحد غامض لا يدعم دفع USD لفاتورة LBP | نموذج أحادي العملة | Allocation بطرفي العملتين + base + fx snapshot + rounding؛ Refund بنفس البنية | DATA_MODEL, ACCOUNTING, TRANSACTION_MAP | GOLD-26, GOLD-35 |
| E | نوع fx_rate غير محدد بدقة | — | NUMERIC(20,10) موثّق في كل الحقول؛ ممنوع Float/Double | DATA_MODEL, MULTI_CURRENCY, ACCOUNTING | Currency suite (USD→LBP/JOD, EUR→TRY…) |
| F | decimal_separator/symbol_position مخزّنة كخصائص عملة | خلط Currency بـLocale | سجل العملة مالي فقط (ISO/minor_units/أسماء)؛ التنسيق عبر ICU/Intl/CLDR | MULTI_CURRENCY, LOCALIZATION, COUNTRY_PACKS | Localization tests |
| G | CHECK constraints موصوفة على Aggregates (مستحيلة في PostgreSQL) | توصيف نظري | جدول إنفاذ واقعي: Row CHECK / UNIQUE / Composite FK / Application transaction invariant بقفل / Deferrable trigger / Reconciliation | DATA_MODEL, ACCOUNTING | مراجعة معمارية + اختبارات |
| H | CHECK(debit=0 OR credit=0) يسمح بسطر صفري | شرط غير صارم | CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0)) | DATA_MODEL, ACCOUNTING | Unit |
| I | خطر Double Reversal بين Return/Refund | مفاهيم مدمجة | فصل كامل: Return(تجاري) / CreditNote(عكس إيراد+خصم+ضريبة) / Inventory return(كمية+COGS بسنابشوت) / Refund(تسوية نقدية فقط) + CreditNote/CreditNoteLine في النموذج + مثال رقمي كامل متوازن (990→495) | DATA_MODEL, ACCOUNTING §4.7, TRANSACTION_MAP | GOLD-28, INV-ACC-08/09 |
| J | Void مباشر لفاتورة مدفوعة في State Machine | انتقال حالة غير آمن | ممنوع مباشرة؛ void_invoice مركّب ذرّي: عكس دفعات ثم فاتورة | STATE_MACHINES, ACCOUNTING §5, TRANSACTION_MAP | GOLD-27, INV-ACC-10 |
| K | نموذج AP ناقص | اكتمال غير متحقق | supplier_payments + supplier_payment_allocations متعددة العملات؛ دفعات جزئية؛ رصيد مورّد مشتق؛ Purchase بكل الحقول (وجهة مستودع/عملة/FX/ضريبة/خصم/total/paid/outstanding) | DATA_MODEL, DOMAIN_MAP, TRANSACTION_MAP | GOLD-32 |
| L | Enum مغلق لطرق الدفع | — | payment_methods بيانات Business-level (system_type مغلق للسلوك المحاسبي + أسماء معرّبة + تفعيل + requires_reference) | DATA_MODEL | Integration |
| M | تناقض: مخزون سالب ممنوع ↔ حركة سالبة عند Offline | سياسة غير موحّدة | سياسة واحدة: ممنوع إلا (إعداد Business صريح) أو (offline_oversell_exception: حفظ حقيقة البيع + Audit + needs_attention + Alert + منع بيع لاحق حتى التسوية)؛ INV-INV-01 محدّث | INVENTORY_RULES, TRANSACTION_MAP, GOLDEN | GOLD-25 |
| N | صيغ Moving Weighted Average غير مفصلة | — | صيغ موثقة لكل حدث (شراء/بيع/مرتجع/إرجاع مورّد/تحويل/تسوية/شراء أجنبي) لكل variant×warehouse؛ cost_minor مرجع عرض؛ INV-INV-06/INV-ACC-11 GL=valuation | INVENTORY_RULES, ACCOUNTING, DATA_MODEL | GOLD-33 |
| O | qty INT يمنع الكسور | — | NUMERIC(18,4) + UoM (unit_code/unit_decimals)؛ piece يرفض الكسور | DATA_MODEL, INVENTORY_RULES | GOLD-34 |
| P | غموض عملة سعر المنتج | currency_code على المنتج | سعر المنتج بالعملة الأساسية للـBusiness دائمًا؛ أُزيل currency_code؛ Price Lists محجوزة | DATA_MODEL, MULTI_CURRENCY | Unit |
| Q | ترجمات المحتوى ناقصة (تصنيفات/متجر/إشعارات) | — | category_translations + business_public_texts + نصوص حالات العميل كبيانات | DATA_MODEL, LOCALIZATION | Localization audit |
| R | لغة المنصة مربوطة بالبلد ضمنيًا | — | platform_supported_locales(ar/en/tr) ثابتة للجميع؛ الحزمة توصي فقط | LOCALIZATION, COUNTRY_PACKS | E2E |
| S | tax.enabled=true/mode=exclusive كافتراض دون مصدر | افتراض قانوني غير موثّق | tax=unconfigured في كل الحزم؛ البنية فقط حتى مصدر رسمي (OD-03) | COUNTRY_PACKS | مراجعة |
| T | reservations.ref_type='cart' بلا كيان Cart | مرجع معلّق | Cart/CartItem رسمية (active/converted/abandoned/expired)؛ ref_type يشير لكيانات موجودة فقط | DATA_MODEL | Contract test |
| U | idempotency_key UNIQUE عالمي | نطاق غير محدد | UNIQUE(business_id, operation_type, key) + نفسه لأحداث الويبهوك | DATA_MODEL, WHATSAPP | Duplicate tests |
| V | جداول فرعية بلا tenant_id رغم ادعاء شموله | عدم تطابق وصف/مخطط | tenant_id+business_id في كل الجداول الفرعية + Composite FKs مانعة للربط العابر على مستوى DB | DATA_MODEL, ARCHITECTURE, SECURITY_MODEL | GOLD-30 |
| W | "iOS-like toggle" → استنساخ iOS على Android | مرجع بصري فُهم كسلوك | DAFTAR premium components بسلوك Android أصيل (Compose semantics)؛ Apple-level craftsmanship لا cloning | DESIGN_SYSTEM | Design review |
| X | افتراضات Onboarding بسبب غياب الصورة | الصورة كانت مفقودة | زوّدنا المالك بـ02_Onboarding.png؛ اعتُمدت الخطوات الخمس في Design/UX/Simplicity/Product Spec؛ OD-01 مغلق | DESIGN_SYSTEM, UX_ARCHITECTURE, SIMPLICITY, PRODUCT_SPEC, OPEN_DECISIONS | GOLD-36 |

## المراجعات المُعادة

- **Review A — Functional & Data Integrity: PASS** — مصدر حقيقة واحد لكل من: الذمم (AR/AP مشتقة)، التكلفة (الحركات)، العملة الأساسية (Business)، الصلاحيات (العضويات). كل Invariant له وسيلة إنفاذ PostgreSQL واقعية.
- **Review B — Security, Architecture & Regression: PASS** — العزل على مستويين (tenant/business) بـComposite FKs واختبارات GOLD-29/30؛ idempotency scoped؛ 12 سيناريو Golden جديدًا مربوطة بالمخاطر R-16/17/18.
- **Review C — UX, Visual & Localization: PASS** — لا مراجع iOS-sلوكية؛ Onboarding معتمد من المرجع الرسمي؛ لغة المنصة مستقلة عن البلد؛ التنسيق CLDR.
- **Review D — Cross-Document Consistency (جديدة): PASS** — فحص آلي + يدوي تحقق: نفس مالك Base Currency (Business) في 5 وثائق؛ نفس Offline policy في 4 وثائق؛ نفس Return/Refund policy في 4 وثائق؛ نفس Tenant/Business model في 6 وثائق؛ NUMERIC(20,10) موحّد في 8 وثائق؛ void_invoice موحّد في 6 وثائق. لا تعارض متبقٍ.

## القرارات المفتوحة المتبقية

OD-02 (مزوّد واتساب)، OD-03 (مصادر ضريبية رسمية)، OD-04 (بوابات دفع)، OD-06 (الخط اللاتيني)، OD-07 (FX revaluation)، OD-08..OD-11 — كلها قرارات تنفيذية/تجارية لا تحمل تعارضًا معماريًا. (OD-05 ترقيم الفواتير أُغلق لاحقًا في Pass#2: Business-level؛ وOD-12 أُغلق في Pass#3.)

## الحكم

لا يوجد أي تعارض معروف متبقٍ يمس Accounting / Inventory / Tenancy / Identity / Multi-Currency / Security / Data Integrity → **لا مانع من PASS** (القرار النهائي في PHASE_0_ACCEPTANCE_REPORT).
