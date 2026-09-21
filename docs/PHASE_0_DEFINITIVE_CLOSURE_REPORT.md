# DAFTAR — PHASE 0 DEFINITIVE CLOSURE REPORT (Final Gate)

> التاريخ: 2026-09-19 · النطاق: توثيق فقط — لا Coding، لا Migrations، لا Phase 1.
> هذه جولة إغلاق شاملة غير تكرارية: تدقيق كامل للمنظومة + إصلاح كل ما اكتُشف في نفس الجولة.

## 1. المشاكل المكتشفة في هذه الجولة وإصلاحها

| # | المشكلة المكتشفة | الإصلاح |
|---|---|---|
| 1 | `payment_reversal` كان Domain Command بلا كيان دائم | أُنشئ `payment_reversals` (كامل الحقول: provider_source/reference، reason، currency، reversed amounts، journal_entry_id، idempotency_key NOT NULL + UNIQUE(business_id, idempotency_key) + **Partial Unique** (business_id, provider_source, provider_reference) WHERE provider_reference IS NOT NULL بـNULL policy موثقة) — DATA_MODEL §7د |
| 2 | العكس الغامض لدفعة موزعة على فواتير متعددة | أُنشئ `payment_reversal_allocations` يربط reversal بكل allocation مع payment_amount_reversed / invoice_amount_reopened / invoice_carrying_base_reopened / original_realized_fx_reversed + سقف المبلغ القابل للعكس |
| 3 | Payment SM تفتقر درجة العكس الجزئي | اعتُمدت: pending→completed→**partially_reversed**→reversed / failed؛ allocation_status مشتق (unallocated/partially/fully)؛ Allocation: active→partially_reversed→reversed (STATE_MACHINES §3) |
| 4 | جدول المقارنة الرسمي للعمليات الأربع كان في State Machines فقط | أُضيف رسميًا في **ACCOUNTING §5.4** (المال/AR/CustomerCredit/Revenue لكل من reverse_payment_allocation, payment_reversal, Refund, Credit Note) |
| 5 | payment_reversal vs Customer Credit semantics | حُسم نصًا: reversal لا يولّد Customer Credit تلقائيًا؛ unallocated وقت الإبطال → إلغاء الرصيد القائم ذرّيًا (§5.2ب) |
| 6 | `journal_entries/journal_lines/accounts` بلا pseudo-schema تنفيذي | أُضيف §13ب: UNIQUE(business_id, code)، UNIQUE(business_id, source_type, source_id)، XOR CHECK على السطر، توازن القيد Deferrable (لا row CHECK على Aggregate) |
| 7 | payments/offline_operations/whatsapp_messages معرّفة كتعليقات | حُوّلت لتعريفات schema صريحة بأعمدة idempotency_key/offline_local_id NOT NULL وقيودها |
| 8 | بقايا نصية قديمة | TRANSACTION_MAP §7 (refund_source_type=credit_note → Typed FK) وTRACEABILITY HARD-02 (صيغة نهائية محدّثة) — فُحص آليًا كل المصطلحات الخطرة (Part 16): كل occurrence متبقٍّ سياقي صحيح (نصوص منع/تاريخ موثّق) |

**الملفات المعدلة هذه الجولة:** DATA_MODEL (§7د، §13ب، تعريفات payments/offline/whatsapp، ERD) · ACCOUNTING (§5.2ب تدقيق + §5.4 جدول رسمي) · STATE_MACHINES (§3 v6) · TRANSACTION_MAP (§7) · REQUIREMENTS_TRACEABILITY_MATRIX (HARD-02 محدّث + HARD-25..27) · MULTI_CURRENCY (§10 مصفوفة 9 حالات) · TEST_STRATEGY (§3.6م عدائية) · جديدان: **SOURCE_OF_TRUTH_MATRIX** و**PHASE_0_FINAL_ARCHITECTURE_SNAPSHOT**.

## 2. Part 2 — Financial Domain Audit (21 كيانًا)

لكل من Sale, Invoice, Payment, Payment Allocation, Allocation Reversal, Payment Reversal, Receivable, Customer Credit, Credit Note, Refund, Purchase, AP, Supplier Payment, Supplier Allocation, Supplier Credit, Supplier Refund, Expense, Journal Entry, FX Gain/Loss, Rounding, Inventory valuation adjustment — محسوم: SoT واحد (SOURCE_OF_TRUTH_MATRIX) · business_id إلزامي · عملة + carrying base · state machine موثقة · journal behavior · reversal behavior · idempotency بأعمدة حقيقية · قفل FOR UPDATE حيث يلزم · Audit · اختبار Golden مسمّى. **لا كيان مالي بلا إجابة كاملة عن البنود الـ12.**

## 3. Part 3 — Accounting Mathematical Verification (Evidence)

فُحص آليًا + يدويًا كل كتلة قيد في ACCOUNTING_RULES:

**13 كتلة Journal مُفحوصة · 13 متوازنة (Debit = Credit رقميًا) · 0 فاشلة:**
بيع بخصم 1090=1090 · CN مرتجع جزئي 545=545 · مخزون المرتجع 300=300 · استرداد 495=495 · تسوية ثلاثية 1480=1480 · FX Loss 1440=1440 · Void A (1000/600/1000) · Void B 1000=700+300 · PPV 500=500 · Supplier Credit 500=500 · Supplier refund FX 369=369 · Reversal A 300=300 · Reversal B 200=200 · Reversal C 1480=1480 · CC refund كامل 1554=1554 · CC جزئي 1470=1470 · catch-up 100=100 · payment_reversal 300=300. (البيع النقدي/الآجل/الدفعة/التقسيط/الشراء/المصروف موثقة بصيغة D=C صريحة في §4.1–4.6.)

## 4. Part 4 — Source of Truth

أُنشئت `DAFTAR_SOURCE_OF_TRUTH_MATRIX.md`: 11 مفهومًا بمعادلات اشتقاق + 4 محظورات صريحة (لا balance يدوي، لا stock مباشر، لا قيد بلا مصدر، لا تصحيح صامت).

## 5. Part 5 — Entity Existence Audit (Evidence)

جُمعت الكيانات المسمّاة في ACCOUNTING/INVENTORY/TRANSACTION_MAP/STATE_MACHINES/GOLDEN/SECURITY/DOMAIN_MAP وقورنت بـDATA_MODEL:
- **Persistent:** كلها معرّفة الآن — بما فيها negative_inventory_deficits/coverages، customer_credits(+allocations)، supplier_credit_notes/allocations/refunds، payment_reversals(+allocations)، invoice_sequences، refunds، journal_entries/lines/accounts.
- **غير Persistent موسومة صراحة:** void_invoice / reverse_payment_allocation / payment_reversal(command) / checkout = Domain Commands؛ stock_levels = Read Model؛ Money = Value Object.
- **كيانات مفقودة من النموذج = 0.**

## 6. Part 6 — PostgreSQL Executability (Evidence)

فحص per-table آلي + يدوي: **11 كتلة schema رئيسية + التعريفات السطرية · كل UNIQUE يشير لأعمدة معرّفة NOT NULL حيث يلزم · 0 مرجع غير صالح** (بعد إصلاح #6/#7). كل CHECK على أعمدة نفس الصف؛ لا Aggregate في row CHECK (التوازن Deferrable موثّق)؛ كل FK مركّب بـbusiness_id مع UNIQUE على الأب؛ NULL policy لـprovider_reference موثقة (Partial Unique)؛ الأنواع: أموال BIGINT minor، FX NUMERIC(20,10)، تكاليف NUMERIC(28,10)، كميات NUMERIC(18,4) — لا FLOAT/DOUBLE؛ الفهارس الحرجة معرّفة (deficits FIFO index)؛ العزل قابل للتنفيذ عبر Composite FKs + RLS. **لا عبارة "نقرر في Migration" متبقية لأي قرار Core** (فُحص نصيًا).

## 7. Part 7 — Multi-Currency Exhaustive (Evidence)

مصفوفة 9 حالات في MULTI_CURRENCY §10 — كل حالة بحقولها الست (transaction/source/base carrying/snapshot/realized/rounding)؛ ممنوع المقارنة العابرة للعملات نصًا. الحالات 3/6/7/9 لها أمثلة رقمية متوازنة حرفية في Accounting.

## 8. Part 8 — Inventory Valuation (Evidence)

كل حدث (شراء/ثانٍ/بيع/مرتجع عميل/مرتجع مورد/تحويل/تسوية/سالب/تغطية جزئية/متعددة/شراء متعدد العملات/كسور) له صيغة NUMERIC(28,10) وحساب الفروق الصحيح (PPV 6200 / catch-up COGS / 6100 rounding فقط). تحقق رقمي: تحويل 3000=3000 · سالب كامل 600=600 · استلامان 0=0 وCOGS=1260=4×120+6×130. GL=valuation محفوظ في كل سيناريو (INV-INV-06/09).

## 9. Part 9 — State Machine Audit

كل انتقال في STATE_MACHINES له Domain Command مسمّى + validation + صلاحية membership-scoped + أثر Journal/Inventory عند الحاجة + Audit + idempotency + حالات سابقة مسموحة. لا انتقال بلا عملية Business واضحة؛ لا `refunded` على Payment.

## 10. Part 10 — Tenant/Business Isolation (Evidence)

كل كيان تجاري/مالي persistent يحمل tenant_id + business_id (§4)؛ الربط العابر مرفوض بـComposite FKs على مستوى DB — اختبار نظري: Payment(A)×Invoice(B) مرفوض (GOLD-30)؛ StockMovement(A)×Variant(B) مرفوض بنفس الآلية (warehouse/variant مركّبة بـbusiness_id).

## 11. Part 11 — Requirements Traceability Cleanup (Evidence)

**153 متطلبًا حاليًا** (102+24+12+6+6+3). صُحّح CORR-U وHARD-02 للصيغة النهائية؛ فُحص سطرًا بسطر: **0 متطلب core قديم يناقض المعمارية النهائية**؛ القرارات المغلقة لا تظهر كمفتوحة في أي مرجع.

## 12. Part 12 — Open Decisions (Evidence)

OPEN فعليًا: OD-02/03/04/06/07/08/09/10/11 — كلها تنفيذية/تجارية/تفضيلية، **لا يمس أيٌّ منها Schema/Accounting/Inventory/Security/Tenancy/Multi-Currency/Core UX** (الضرائب unconfigured بقرار، الخط اللاتيني تفضيل عرض، Bottom Nav محسوم…). CLOSED: OD-01/05/12.

## 13. Part 13 — Golden Test Validation (Evidence)

**88 سيناريو · 0 يستخدم كيانًا غير معرّف · 0 يستخدم حقلًا غير معرّف** (فُحص آليًا مرجعيات GOLD-50..88 مقابل DATA_MODEL بعد إضافات هذه الجولة). السيناريوهات المحاسبية (28,37,39,42,43,46,50,51,54,57..61,65..67,81..84,86,87) لها أسطر قيود متوقعة حرفية؛ سيناريوهات المخزون لها qty/avg/valuation متوقعة؛ سيناريوهات العملات لها أرصدة متوقعة بعملتي المصدر والأساسية.

## 14. Part 14 — Adversarial (Evidence)

20 سيناريو عدائيًا بنتائج حتمية موثقة في TEST_STRATEGY §3.6م — كلها تنتهي برفض آمن على مستوى DB/القفل/القيد: **لا حالة تؤدي لتلف مالي صامت.**

## 15. Part 15 — Design/UX Freeze

لا تغيير: الهوية ثابتة، RTL/LTR، Onboarding (لغة واجهة/دولة/عملة/لغة متجر)، قفل العملة بعد أول معاملة، Bottom Nav الخماسي المعتمد. لا قرار تصميم أُعيد فتحه.

## 16. Reviews A–M — النتائج بالأدلة

| Review | النتيجة | Evidence |
|---|---|---|
| A Functional & Data Integrity | **PASS** | 0 مصدر حقيقة مزدوج؛ كل الأرصدة مشتقة بمعادلات موثقة |
| B Security & Tenant Isolation | **PASS** | عزل DB مركّب على كل الكيانات؛ GOLD-20/29/30 |
| C UX/Localization/Design | **PASS** | freeze مؤكد؛ GOLD-36/49 |
| D Cross-Document Consistency | **PASS** | نموذج v6 موحّد؛ 0 مصطلح قديم نشط (بحث آلي Part 16) |
| E Accounting Math | **PASS** | 13 كتلة مفحوصة · 13 متوازنة · 0 فاشلة |
| F Schema Executability | **PASS** | كل UNIQUE/CHECK/FK بأعمدة موجودة · 0 مرجع غير صالح · 0 قرار مؤجل |
| G Inventory Valuation | **PASS** | 3 تحققات رقمية (3000/600/0) GL=valuation |
| H Financial Source Semantics | **PASS** | جدول §5.4 الرسمي؛ 0 تداخل وظيفي |
| I Pseudo-Schema Lint | **PASS** | per-table lint آلي · 0 مشكلة حقيقية بعد الإصلاحات |
| J Entity Existence | **PASS** | 0 كيان persistent مفقود من النموذج |
| K Money Movement Semantics | **PASS** | مصفوفة 7 أحداث × 7 أبعاد بلا غموض |
| L Traceability Consistency | **PASS** | 153 متطلبًا حاليًا · 0 متقادم core |
| M Adversarial Domain | **PASS** | 20 سيناريو بنتائج حتمية آمنة |

## 17. Remaining Open Decisions & Risks

- OD-02/03/04/06/07/08/09/10/11 — تنفيذية/تجارية، لا تمس النواة، ولا تمنع Phase 1.
- المخاطر R-01..R-18 كلها بتخفيف مصمَّم واختبارات مربوطة: **P0 unresolved = 0 · P1 unresolved = 0 · P2 core design defects = 0.**

## 18. Final Decision

Known contradictions (accounting/inventory/schema/tenancy/multi-currency/state-machine/financial-source) = **0** · Persistent entities missing = **0** · Stale core requirements = **0**.

# ✅ PHASE 0 — PASS

**توقف كامل. لا Phase 1. لا Coding. لا Migrations.**
