# DAFTAR — Phase 0 Final Architecture Snapshot / اللقطة المعمارية النهائية

> مرجع مختصر ملزم لـPhase 1 — **لا تُعاد فتح هذه القرارات**. التفاصيل الكاملة في الوثائق المرجعية بين أقواس.

## 1. Tenant / Business
Tenant = حساب SaaS (اشتراك/فوترة). **Business = الوحدة التشغيلية والقانونية**: يملك country / base_currency / timezone / default_locale / storefront / الدفاتر (CoA+Ledger). كل البيانات التجارية `business_id` إلزامي + `tenant_id` للعزل + Composite FKs. (DATA_MODEL §1، ARCHITECTURE)

## 2. Identity / Membership
users عالميون؛ tenant_memberships + business_memberships + membership_branch_access؛ business_roles+role_permissions هي SoT للصلاحيات. (DATA_MODEL §2، SECURITY_MODEL)

## 3. Financial Source Model
- Double Entry لكل Business؛ Posting Engine حتمي Idempotent `UNIQUE(business_id, source_type, source_id)`؛ Ledger append-only.
- **الأرصدة كلها مشتقة** (SOURCE_OF_TRUTH_MATRIX) — لا balance يدوي.
- CoA تتضمن: 1020/1030/1040 Clearing، 1150 Supplier Receivable، 2200 Customer Refund Liability، **2210 Customer Credit Liability**، 4900/6900 Realized FX، 6100 Rounding فقط، 6200 PPV. (ACCOUNTING §2)

## 4. Refund Model
مصدران Typed فقط: `credit_note` XOR `customer_credit` (FKs مركّبة + CHECK). جانبا المصدر/التسليم صريحان + realized FX + rounding. cap بعملة المصدر + قفل FOR UPDATE. Raw Payment ليس مصدرًا. (ACCOUNTING §5)

## 5. Reversal Model
- `reverse_payment_allocation`: المال باقٍ → إعادة فتح AR بالسنابشوت + Customer Credit (2210).
- `payment_reversal`: المال ذاهب (chargeback…) → كيان دائم `payment_reversals` + `payment_reversal_allocations`؛ يعكس أصل النقد ويعيد فتح AR؛ Idempotent بـidempotency_key + provider_reference (Partial Unique).
- `void_invoice`: مركّب ذرّي (عكس دفعات ← عكس فاتورة). جدول المقارنة الرسمي: ACCOUNTING §5.4.

## 6. Customer / Supplier Credits
`customer_credits` / `supplier_credit_notes` (+allocations/refunds) — كل مصدر يحمل remaining بعملته **+ remaining_carrying_base + rate snapshot**؛ استهلاك جزئي تناسبي، الأخير يصفّر الطرفين بالضبط (INV-ACC-17). Supplier Credit = مرآة كاملة على 1150. (DATA_MODEL §7ب/§12)

## 7. Multi-Currency
Money = BIGINT minor (لا Float)؛ FX NUMERIC(20,10)؛ تسوية **ثلاثية العملات** (payment_to_base / invoice carrying / realized FX)؛ تنسيق العرض عبر ICU/CLDR؛ مصفوفة الحالات التسع محسومة. (MULTI_CURRENCY §10)

## 8. Inventory Source Model
`stock_movements` append-only هي SoT؛ stock_levels Cache؛ MWAC لكل (variant×warehouse) بـNUMERIC(28,10) وتقريب HALF_EVEN عند القيد مع توزيع فرق الأسطر؛ كميات NUMERIC(18,4)+UoM؛ سياسة سالب موحّدة + **negative_inventory_deficits/coverages** (FIFO بـdeficit_seq، catch-up ذرّي) — GL=valuation دائمًا. (INVENTORY §5/§5أ، DATA_MODEL §10/§10ب)

## 9. Outbox / Async
كل أثر جانبي (واتساب، إشعارات، analytics) عبر Outbox + Workers — خارج المعاملة الحرجة؛ البيع ينجح ولو فشل الجانبي. (ARCHITECTURE، WHATSAPP)

## 10. Offline
عمليات Offline بـ`UNIQUE(business_id, offline_local_id)`؛ تعارضات المزامنة موثقة؛ oversell الاستثنائي سبب مميّز مدقّق. (INVENTORY §6، GOLD-18/25)

## 11. Design / Localization
هوية DAFTAR من الصور المرجعية (Tokens: #2563EB…، Tajawal)؛ مكوّنات Android أصيلة؛ RTL عربي أصيل + LTR؛ Onboarding خماسي (لغة واجهة فورية + دولة + عملة + لغة متجر)؛ العملة تُقفل بعد أول معاملة؛ `{store_slug}.{PLATFORM_ROOT_DOMAIN}`؛ Bottom Nav: الرئيسية/البيع/الطلبات/العملاء/المزيد. (DESIGN_SYSTEM، UX، LOCALIZATION)

## 12. Security Boundaries
RLS/عزل على مستوى DB (tenant+business)؛ صلاحيات membership-scoped؛ لا حذف مالي؛ Audit شامل؛ Idempotency scoped لكل عملية وويبهوك. (SECURITY_MODEL، THREAT_MODEL)
