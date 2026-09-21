# DAFTAR — PHASE 0 FINAL CONSISTENCY REPORT (Pass #3)

> التاريخ: 2026-09-19 · النطاق: توثيق فقط — **لا Coding، لا Migrations، لا Phase 1.**
> المدخل: المراجعة المستقلة الثالثة — 6 نقاط محددة + 15 اختبار Golden + Review F (Schema Executability) + Review G (Negative Inventory Accounting).

## 1. تنفيذ النقاط الست

### P3-1. Cross-Currency Refund Model — مكتمل
- `refunds` (Data Model §7 v4 / Accounting §5 v4) يحمل صراحة: `refund_source_type/id`، جانب المصدر (`source_currency`, `source_amount_consumed_minor`, `source_carrying_base_amount_released`)، جانب التسليم (`refund_currency`, `refund_amount_minor`, `refund_to_base_rate NUMERIC(20,10)`, `refund_base_amount_minor`)، الفروقات (`realized_fx_gain_loss_minor`, `rounding_difference_minor`)، `rate_source/timestamp`، `payment_method_id`.
- **القاعدة الملزمة:** السقف `source_amount_consumed_minor ≤ source.remaining_refundable_minor` يُفحص **بعملة المصدر نفسها**؛ التحديث `remaining_refundable −= consumed` داخل `SELECT…FOR UPDATE` في نفس المعاملة. مقارنة/طرح عبر عملتين (100 USD − 90 EUR) **ممنوع نصًا صريحًا**.
- **المثال الإلزامي (§5.1):** Base ILS، CN=100 USD دفتري 360، استرداد 90 EUR @4.10 → نقد خارج 369: `Dr 2200 360، Dr 6900 Realized FX Loss 9 / Cr Cash 369` (369=369 ✓)؛ remaining_refundable = **0 USD**. الاتجاه المعاكس موثّق (ربح → 4900).
- Golden: GOLD-50/51/52/53.

### P3-2. Negative Inventory Cost Catch-up Policy — معتمدة
- Inventory §5أ + INV-INV-09: عند استلام يغطي رصيدًا سالبًا — تحديد covered_qty، مقارنة provisional مقابل actual، حركة **`negative_inventory_cost_adjustment`** مدقّقة (بلا تغيير كمية) بقيد `Dr COGS / Cr Inventory` (أو معكوس). **حُذفت** قاعدة "if on_hand≤0 → avg = cost" المنفردة من جدول الصيغ.
- تغطي الحالتين: `offline_oversell_exception` والسماح الصريح بالسالب.
- Golden: GOLD-54 (provisional 100 → actual 120) وGOLD-55 (provisional=0 → catch-up كامل 600) وGOLD-56 (GL=valuation بعدها).

### P3-3. Supplier Credit Model — مكتمل
- مفهوم معتمد: **Supplier Receivable / Supplier Credit (حساب 1150 جديد في CoA)** — مرآة AR بالاتجاه المعاكس، ليست إيرادًا.
- كيانات (Data Model §12): `supplier_credit_notes` + `supplier_credit_allocations` + `supplier_refunds` (direction=in).
- **Case A** (غير مدفوع): `Dr AP / Cr Inventory / Cr 6200 PPV`. **Case B** (مدفوع): الفائض فوق AP يولّد Supplier Credit — المثال الإلزامي (شراء 1000 مدفوع، avg=90، إرجاع 5): `Dr 1150 500 / Cr Inventory 450 / Cr 6200 50` (500=500 ✓)؛ ثم عند وصول 500: `Dr Cash/Bank 500 / Cr 1150 500` (500=500 ✓). Case B الجزئي موثّق (Dr AP 300 + Dr 1150 200). التصفية مساران فقط: تخصيص على شراء مستقبلي أو استرداد نقدي. INV-ACC-14.
- Golden: GOLD-57/58/59/60/61.

### P3-4. Idempotency UNIQUE — مصحّحة وقابلة للتنفيذ
- **المعمارية المعتمدة (Data Model §17):** جدول مستقل لكل عملية → `UNIQUE(business_id, idempotency_key)` / `UNIQUE(business_id, offline_local_id)` — نوع العملية من الجدول نفسه. **ممنوع Literal داخل UNIQUE** (نص المنع موثّق). لو ظهر Registry مشترك مستقبلًا: عمود `operation_type` فعلي إلزامي.
- صُحّحت: DATA_MODEL (§5، §7 refunds، §12 supplier_refunds، §17)، TRANSACTION_MAP (§8)، INVENTORY_RULES (offline)، WHATSAPP_ARCHITECTURE. لم يتبقَّ أي نمط `UNIQUE(business_id, '...', ...)` (فُحص آليًا).
- Golden: GOLD-62/63/64.

### P3-5. الدومين — مجَرَّد
- `PRODUCT_SPECIFICATION` و`DESIGN_SYSTEM`: `{store_slug}.{PLATFORM_ROOT_DOMAIN}` — إعداد على مستوى المنصة؛ ".daftr.sa" موثّق كمحتوى Mockup بصري فقط؛ تغيير الدومين لاحقًا لا يمس Business Logic. لا مواضع أخرى (فُحص آليًا).

### P3-6. OD-12 — مغلق
- CLOSED: Master V3 مرجع ملزم (الرئيسية/البيع/الطلبات/العملاء/المزيد)؛ الصور مرجع بصري لا مواصفة تنقّل.

## 2. Review F — PostgreSQL Schema Executability: **PASS**

فُحصت كل pseudo-schemas وconstraints في الوثائق:
- **UNIQUE:** كلها بأعمدة فعلية (بعد تصحيح P3-4) — لا Literals. مركّبات (business_id, sequence_key) و(business_id, id) للآباء صالحة.
- **CHECK:** كلها Row-level على نفس الصف (XOR مدين/دائن، outstanding=total−paid) — لا CHECK على Aggregates (موثّق في DATA_MODEL §5 "الوسيلة الصحيحة").
- **FK/Composite FK:** كلها `(business_id, …)` → `(business_id, id)` مع UNIQUE على الأب — قابلة للتنفيذ. **المرجع polymorphic الوحيد** (`refund_source_id`) وُثّقت وسيلة تنفيذه الصريحة (عمودان FK nullable + CHECK/Trigger).
- **NUMERIC precision:** أموال BIGINT minor، FX NUMERIC(20,10)، تكاليف NUMERIC(28,10)، كميات NUMERIC(18,4) — كلها أنواع PostgreSQL حقيقية؛ ممنوع Float/Double نصًا.
- **NULLability/Deferrable/Indexes/Idempotency:** posting_account_id إلزامي للنشط؛ توازن القيود Deferrable trigger + Reconciliation (موثّق)؛ فهارس العزل جزء من الـComposite FKs؛ قيود Idempotency نهائية قابلة للتحويل إلى Migration كما هي.

## 3. Review G — Negative Inventory Accounting Verification: **PASS**

المثال يدويًا:
- بداية: 0؛ oversell ‎−5 @ مؤقت 100 → COGS 500، قيمة دفترية ‎500−.
- استلام 10 @ 120 → Dr Inventory 1200.
- Catch-up: 5 × (120−100) = 100 → `Dr COGS 100 / Cr Inventory 100` (100=100 ✓ Debit=Credit).
- **Closing qty = 5 ✓ · Closing avg = 120 ✓ · Valuation = 5×120 = 600 ✓ · GL Inventory = ‎−500+1200−100 = 600 ✓ · Catch-up COGS = 100 ✓** — INV-INV-06 محفوظ.

## 4. Cross-Document Consistency (Pass#3)

فُحصت الوثائق الـ12 المطلوبة: الحساب 1150 وكيانات Supplier Credit متسقة (Accounting §9.2 ↔ Data Model §12 ↔ Transaction Map §9)؛ حقول refunds v4 متطابقة (Accounting §5 ↔ Data Model §7 ↔ Multi-Currency §5 ↔ Transaction Map §8)؛ سياسة Catch-up متطابقة (Inventory §5أ ↔ Accounting §9ب ↔ Golden 54/55/56 ↔ Test Strategy §3.6ح)؛ Idempotency v4 موحّد (Data Model §17 ↔ Transaction Map ↔ Inventory ↔ WhatsApp)؛ الدومين المجرّد موحّد؛ OD-12 مغلق في Open Decisions. لا تعارض متبقٍّ.

## 5. التحكم بالمجالات الحاكمة

Refunds: بلا double counting، cap بعملة المصدر، قفل ذرّي · Multi-Currency Refunds: نموذج v4 كامل بمثال محسوب · Negative Inventory Costing: سياسة Catch-up محسومة وGL=valuation · Supplier Returns: Case A/B + تصفية بلا Revenue · Schema Executability: Review F PASS · Data Integrity: بلا حذف مالي ولا تصحيح صامت.

**لا تعارض معروف متبقٍ في أي منها.**

## 6. إيقاف

توقف كامل بعد هذا التقرير وتحديث Acceptance Report. **لا Phase 1، لا Coding، لا Migrations** حتى أمر جديد من المالك.
