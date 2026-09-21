# DAFTAR — Test Strategy / استراتيجية الاختبار

## 1. المبادئ

- كل Invariant موثّق = **اختبار آلي** (Master §146).
- أي Bug يُكتشف = Test رجوعي دائم (Master §65).
- اختبر ما يفترض أن يفشل، لا فقط ما يفترض أن ينجح (Master §144).
- لا حذف للاختبارات البطيئة — تُقسّم: Fast PR / Core merge / Nightly full / Release (Master §89).

## 2. المستويات

| المستوى | النطاق |
|---|---|
| Unit | Money VO، Posting Engine، حل الكيانات AI، State machines، حساب الذمم |
| Integration | Sale→Journal→Stock الذرّية، Idempotency، Outbox، Reconciliation jobs |
| Contract | API schemas، Event payloads، Country Pack structure |
| E2E | Core flows على Web/Android/Storefront |
| Visual regression | شاشات حرجة × 3 لغات × RTL/LTR |
| Performance/Load | حسب Scaling Plan §5 |

## 3. الاختبارات المتخصصة

### 3.1 Accounting (v2)
- كل حدث في Accounting Rules §4 له golden test (القيود المتوقعة حرفيًا)، بما فيها مثال المرتجع الجزئي الكامل §4.7.
- Invariants INV-ACC-01..11 كاختبارات دائمة.
- **Void invoice المركّب**: فاتورة مدفوعة/جزئية — المسار المباشر مرفوض، والمركّب ذرّي متوازن (GOLD-27).
- **لا double reversal**: Return ثم Refund — الإيراد يُعكس مرة واحدة (GOLD-28).
- فوضى: Partial payments متسلسلة، Refund بعد Return، إلغاء بعد تقسيط.

### 3.2 Inventory (v2)
- سباق آخر قطعة، حجوزات منتهية، rebuild من movements.
- **Offline oversell exception** كاملًا (GOLD-25).
- **التكلفة**: صيغ Moving Weighted Average لكل حدث في Inventory §5 (شراء بسعرين، بيع، مرتجع، إرجاع مورّد، تحويل، تسوية، شراء متعدد العملات) + INV-INV-06 GL=valuation (GOLD-33).
- **كميات كسرية** (GOLD-34).
- Invariants INV-INV-01..07.

### 3.3 Security / Tenancy (v2)
- Cross-tenant suite آلية على كل endpoint حساس (TH-01).
- **Cross-business**: مستخدم واحد مخوّل لـA وليس B (GOLD-29)؛ محاولات ربط FK عابرة للأنشطة تُرفض على مستوى DB (GOLD-30).
- **Two Businesses under one Tenant بعملتين مختلفتين** — استقلال الدفاتر والتقارير (GOLD-31).
- RBAC matrix كاملة (membership-scoped)، جلسات قديمة، webhooks مكررة، رفع ملفات خبيثة.

### 3.4 Concurrency (Master §98)
- آخر قطعة مخزون، دفعان متزامنان، duplicate webhook، duplicate sync، allocation race على نفس الفاتورة (قفل الصفوف).

### 3.5 Offline (v2)
- بيع Offline → مزامنة → نجاح/تعارض/needs_attention؛ قتل التطبيق أثناء pending (لا فقدان)؛ **oversell exception** (GOLD-25).

### 3.6 Currency (Master §87 + E) — v3
- سيناريوهات مالية كاملة على ILS/JOD/LBP/SYP/TRY/USD/EUR.
- **إلزامي إضافي:** USD→LBP، USD→JOD، EUR→TRY؛ دفعة بعملة مختلفة عن الفاتورة (GOLD-26)؛ Refund بعملة مختلفة (GOLD-35)؛ دقة NUMERIC(20,10).
- **التسوية ثلاثية العملات (v3):** GOLD-37/38/39 — مكوّنات التخصيص الثلاثة (payment_to_base_rate / invoice_historical_to_base_rate / invoice_carrying_base_released)؛ Realized FX Gain على 4900 وLoss على 6900 منفصلين تمامًا عن 6100 (6100 لا يتحرك في سيناريوهات FX النقية)؛ نفس النموذج على تخصيصات الموردين والاستردادات متعددة العملات.

### 3.6أ Accounting v3 — مطابقة الأسطر حرفيًا
- GOLD-28/42/43/46/47: تطابق **أسطر القيود المتوقعة حرفيًا** (حساب/مبلغ/اتجاه) — فحص التوازن وحده ممنوع كمعيار نجاح.
- سقف refundable للمصدر: 496 FAIL / 495 PASS / ثانية 1 FAIL (GOLD-40)؛ استرداد مزدوج متزامن ممنوع بالقفل (GOLD-41).

### 3.6ب Inventory v3 — دقة وتقييم
- GOLD-44 تحويل المستودعات: avg المصدر ثابت، الوجهة يُعاد حسابه، ΔValuation=0.
- GOLD-45 دقة NUMERIC(28,10): ممنوع Float/Double؛ تقريب HALF_EVEN عند القيد فقط مع توزيع فرق الأسطر بحيث Σ أسطر COGS = COGS المقيَّد.
- GOLD-46: فرق إرجاع المورد → 6200 PPV وليس 6100.

### 3.6و Numbering & Payment Methods (v3)
- GOLD-47: رفض طريقة دفع نشطة بلا posting_account_id؛ القيد يستخدم حساب الترحيل المكوَّن.
- GOLD-48: تسلسلات فواتير مستقلة لكل Business تحت التزامن.
- GOLD-49 + GOLD-36 المحدّث: منتقي لغة الواجهة على الترحيب، لغة المتجر حقل ثالث في خطوة الدولة/العملة، قفل العملة بعد أول معاملة — ضمن ميزانية البساطة.

### 3.6ز Cross-Currency Refunds (Pass#3)
- GOLD-50..53: السقف يُفحص **بعملة المصدر** فقط (source_amount_consumed ≤ remaining_refundable)؛ الالتزام يُحرَّر بقيمته الدفترية والفرق → 4900/6900؛ ممنوع طرح عبر عملتين؛ التزامن مغطى بالقفل.

### 3.6ح Negative Inventory Catch-up (Pass#3)
- GOLD-54/55/56: catch-up إلزامي عند تغطية رصيد سالب؛ حالة provisional=0؛ GL Inventory = valuation بعد الاستلام مباشرة؛ ممنوع "if on_hand≤0 → avg=cost" وحدها.

### 3.6ط Supplier Credit (Pass#3)
- GOLD-57..61: مرتجع مورد غير مدفوع / مدفوع بالكامل / جزئيًا؛ Supplier Receivable(1150)؛ استرداد نقدي من المورد؛ تخصيص رصيد على شراء مستقبلي؛ ممنوع لمس Revenue.

### 3.6ي Idempotency Executability (Pass#3)
- GOLD-62/63/64: مفاتيح UNIQUE فعلية قابلة للتنفيذ (لا Literal داخل قيد) — استرداد/بيع Offline/رسالة واتساب مكررة تُرفض على مستوى DB.

### 3.6ك Payment Reversal & Customer Credit (Pass#4)
- GOLD-65/66/67: `reverse_payment_allocation` يستهدف allocations بالمعرّف؛ إعادة فتح AR بالـSnapshots الأصلية؛ عكس FX الأصلي؛ منع العكس المزدوج؛ ممنوع Refund من Raw Payment.
- GOLD-68..71: overpayment → customer_credits (2210) لا Revenue؛ تخصيص على فاتورة مستقبلية؛ استرداد؛ استرداد عابر العملات.
- GOLD-72: Deficit Layers FIFO باستلامين بسعرين — COGS الكلي = التكلفة الفعلية، GL=0=valuation.
- GOLD-73: supplier refund عابر العملات بنفس فصل الجانبين.
- GOLD-74: Schema Lint آلي — كل UNIQUE/CHECK/FK بأعمدة موجودة فعلًا.

### 3.7 Localization (Master §88)
- Critical UI flows بالعربية/الإنجليزية/التركية؛ فحص آلي للمفاتيح الناقصة؛ لقطات بصرية للاتجاهين.

### 3.8 AI
- نيات صحيحة/مكسورة، كيانات مكررة (لا تخمين)، ثقة منخفضة (لا تنفيذ)، injection، رفض بلا تأكيد، انتهاء مسودة.

### 3.9 WhatsApp
- retries/backoff/dead-letter، ويبهوك مكرر، انقطاع المزوّد أثناء البيع (البيع ينجح)، قوالب ثلاث لغات، حدود الباقة.

## 4. Golden Regression Suite

انظر `DAFTAR_GOLDEN_REGRESSION_SUITE.md` — تُشغَّل إلزاميًا عند كل Phase Gate (Master §85–86).

## 5. Final QA Matrix (Master §165)

قبل الإطلاق: كل Core Feature × كل لغة × كل عملة ذات صلة × كل فئة جهاز — مصفوفة Risk-Based موثّقة مع أتمتة حيث أمكن.

## 6. أدوات البوابة

- CI Gate: build / lint / typecheck / core tests / security checks / migration checks — فشل = لا Merge (Master §90).
- تقارير تغطية للـCore المالي (هدف: تغطية عالية جدًا على Posting/Inventory/Receivables).

### 3.6م Adversarial Domain Scenarios (Part 14) — نتائج حتمية موثقة

| # | السيناريو | النتيجة الحتمية الآمنة |
|---|---|---|
| 1 | Duplicate payment | UNIQUE(business_id, idempotency_key) يرفض الثانية على DB |
| 2 | Duplicate refund | نفس القيد على refunds (GOLD-62) |
| 3 | Duplicate payment reversal | UNIQUE(business_id, idempotency_key) + Partial Unique(business_id, provider_source, provider_reference) |
| 4 | Two simultaneous refunds | FOR UPDATE على المصدر؛ واحد ينجح (GOLD-41/53) |
| 5 | Two receipts covering same deficit | FOR UPDATE على negative_inventory_deficits؛ لا تغطية مزدوجة (GOLD-76) |
| 6 | Credit consumed + refunded simultaneously | قفل واحد على الصفين المنطقيين (remaining + carrying) — عملية واحدة تسبق (INV-ACC-17) |
| 7 | Pay while voiding | قفل صف الفاتورة؛ void_invoice مركّب ذرّي؛ أحدهما يسبق والثاني يقرأ الحالة النهائية |
| 8 | Reversal while allocating | نفس قفل Payment+Allocations؛ تسلسل ذرّي؛ لا عكس لتخصيص غير مكتمل |
| 9 | Wrong business_id | Composite FKs ترفض على DB (GOLD-30) |
| 10 | Wrong currency | فحص عملة المصدر/الفاتورة مقابل سجلاتها + CHECK عملات مسجلة في currencies |
| 11 | Zero FX rate | CHECK rate > 0 على كل حقول *_to_base_rate |
| 12 | Negative amount | CHECK amount > 0 على الحركات/الدفعات/الاستردادات/التغطيات |
| 13 | Excess refund | cap بعملة المصدر داخل القفل (GOLD-40) |
| 14 | Excess reversal | Σ reversals ≤ أصل allocation (§7د) + حالة reversed تمنع التكرار |
| 15 | Excess supplier credit use | cap remaining_amount على supplier_credit_notes بقفل |
| 16 | Offline duplicate sync | UNIQUE(business_id, offline_local_id) (GOLD-63) |
| 17 | Stock oversell | ممنوع افتراضيًا؛ استثناء موثّق فقط (GOLD-25) |
| 18 | Double return | كل Return بـidempotency_key + مرجع Sale واحد؛ المرتجع الثاني المكرر مرفوض |
| 19 | Double credit note | تسلسل Business ذرّي + UNIQUE مصدر Posting (business_id, source_type, source_id) |
| 20 | Deleted/deactivated payment method | لا حذف — is_active=false فقط؛ القيود التاريخية محفوظة بحسابها الأصلي؛ الاستخدام الجديد مرفوض (GOLD-47) |
