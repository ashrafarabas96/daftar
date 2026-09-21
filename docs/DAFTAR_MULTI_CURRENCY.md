# DAFTAR — Multi-Currency Architecture / تعدد العملات (v3)

## 1. النطاق

- الأساسية: ILS, JOD, LBP, SYP, TRY, USD, EUR — معمارية مفتوحة للخليج والعالم العربي (إضافة = بيانات).

## 2. Currency Registry (F) — مصحّح

سجل العملات يحتفظ **فقط** بما هو مالي ثابت للعملة:

```
currencies(code ISO4217 PK, minor_units, name_ar, name_en, name_tr, is_active)
```

- **أُزيلت** `decimal_separator` و`thousands_separator` و`symbol_position` من سجل العملة — هذه خصائص **Locale وليست Currency**.
- **Presentation Formatting** يتم عبر **ICU / Intl / Unicode CLDR** حسب locale الواجهة (ar, ar-TR…, en, tr) — رمز العملة وموضعه والفواصل تأتي من CLDR، لا من حقول مخزّنة.

## 3. Money Value Object

`{ amount_minor: BIGINT, currency: ISO4217 }` — ممنوع Float نهائيًا (Master §30). التقريب HALF_EVEN موثّق عند التحويل فقط.

## 4. Base Currency = Business-level (A)

- العملة الأساسية خاصية **Business** (لا Tenant) — كل Business بدولته وعملته ودفاتره المستقلة.
- ثابتة بعد أول معاملة إلا بـMigration رسمية مدققة (Master §31).

## 5. المعاملة متعددة العملة — الحقول الإلزامية (Master §32 + D)

```
transaction_currency / transaction_amount_minor
exchange_rate NUMERIC(20,10)   ← قرار E: دقة عالية، لا Float/Double
exchange_rate_source / exchange_rate_time
base_amount_minor
```

- **Payment Allocation — نموذج التسوية ثلاثي العملات (محسوم):** كل تخصيص يحمل **ثلاثة جوانب** (Data Model §7، Accounting §6):
  1. **عملة الدفعة:** payment_currency + payment_amount_minor + **payment_to_base_rate** NUMERIC(20,10) → payment_base_amount_minor.
  2. **عملة الفاتورة:** invoice_currency + invoice_amount_applied_minor.
  3. **القيمة الدفترية للفاتورة:** **invoice_historical_to_base_rate** NUMERIC(20,10) + **invoice_carrying_base_amount_released** (ما تُحرِّره التسوية من AR بالعملة الأساسية بسعر الفاتورة التاريخي).
  - **realized_fx_gain_loss_minor = payment_base − invoice_carrying_released** → يُقيد على **4900 Realized FX Gain / 6900 Realized FX Loss** — حسابان مستقلان تمامًا عن 6100 Rounding Adjustment (التقريب فقط).
  - ممنوع نموذج "سعر واحد لكل تخصيص"؛ ممنوع مقارنة عملتين مباشرة (INV-ACC-09 المحدّث: المقارنة دائمًا في العملة الأساسية).
- **يطبَّق النموذج نفسه على:** supplier_payment_allocations (باتجاه AP المعاكس)، و**الاستردادات متعددة العملات (v4):** refunds تحمل جانب المصدر بعملته (source_amount_consumed + source_carrying_base_released) وجانب التسليم (refund_to_base_rate + refund_base_amount)؛ السقف يُفحص بعملة المصدر حصرًا؛ فرق التحقّق → 4900/6900 (المثال الكامل CN 100 USD → 90 EUR: Accounting §5.1). وكذلك supplier_refunds عند اختلاف العملة.
- **المثال الرقمي الكامل** (Base ILS، فاتورة USD 1000 @3.60، تسوية USD 400 بسعر USD→ILS 3.70 عبر EUR→ILS 4.00 = 370 EUR؛ القيد Dr Bank 1480 / Cr AR 1440 / Cr Realized FX Gain 40 — متوازن 1480=1480) في Accounting §6.
- مثال مدعوم تصميمًا: فاتورة LBP بدفعة USD.

## 6. FX Precision (E) — قرار موثّق

- نوع سعر الصرف في قاعدة البيانات: **`NUMERIC(20,10)`** في كل الحقول (allocations, refunds, journal_lines, purchases, sales fx snapshots).
- مبرر: أزواج مثل USD/LBP (مقام كبير) وJOD (3 خانات) تتطلب دقة عشرية عالية مع حتمية كاملة؛ NUMERIC في PostgreSQL دقيق وغير تقريبي بعكس float/double.
- كل الحسابات النهائية على minor units بأعداد صحيحة؛ السعر يُستخدم للتحويل ثم يُجمَّد.

## 7. قواعد حاكمة

1. التاريخ لا يتغير (Master §33) — التقارير التاريخية بالسعر المحفوظ.
2. مصدر السعر: يدوي افتراضيًا أو مزوّد اختياري لاحقًا (OD-11)؛ المصدر والوقت يُخزَّنان دائمًا.
3. التوازن المحاسبي على مبالغ base لكل قيد.
4. فروقات **التقريب** وحدها → 6100 Rounding Adjustment؛ فروقات **الصرف المحققة** → 4900/6900؛ فروقات **سعر الشراء عند الإرجاع للمورد** → 6200 Purchase Price Variance. ثلاثة مفاهيم مستقلة — ممنوع الخلط (INV-ACC-12). مقاصة عملة → 1099 بقيد إقفال صريح.
5. **أسعار المنتجات بالعملة الأساسية للـBusiness دائمًا** (P) — البيع بعملة أخرى عبر FX snapshot. Price Lists مستقبلية محجوزة دون تخريب Catalog.
6. المخزون والتكاليف بالعملة الأساسية؛ شراء بعملة أجنبية يُحوَّل بـfx لحظة الاستلام (Inventory §5).

## 8. ملاحظات السوق

لبنان/سوريا: تعدد عملات يومي فعلي (محلية+USD) — مدعوم من التصميم الأول على مستوى الدفعة والتخصيص.

## 9. اختبارات إلزامية (Master §87 + E)

سيناريوهات كاملة على العملات السبع + المحدد: **USD→LBP، USD→JOD، EUR→TRY، دفعة جزئية متعددة العملات، Refund متعدد العملات، rounding** — بما فيها minor_units=3 وأرقام كبيرة (LBP/SYP) لكشف مشاكل العرض والدقة.

## 10. مصفوفة الحالات الشاملة (Part 7 — محسومة)

| الحالة | Base/Invoice/Payment | النموذج | realized FX | rounding |
|---|---|---|---|---|
| 1 | ILS / ILS / ILS | عملة واحدة: لا FX؛ الحقول الثلاثية تُملأ بسعر 1 | 0 | 0 |
| 2 | ILS / USD / USD | طرفان: invoice_historical + payment_to_base؛ الفرق = realized على 4900/6900 | payment_base − carrying_released | ≤ minor → 6100 |
| 3 | ILS / USD / EUR | ثلاثية كاملة (المثال §5 Accounting: gain 40) | محسوب من الطرفين | موثّق |
| 4 | TRY / USD / EUR | نفس نموذج Case 3 — Base مختلف فقط؛ الدقة NUMERIC(20,10) تغطي أرقام TRY الكبيرة | نفسه | نفسه |
| 5 | دفعات جزئية بأسعار مختلفة | كل Allocation بسنابشوتها؛ carrying_released تناسبي من سنابشوت الفاتورة؛ الأخير يحرّر الباقي (INV-ACC-17) | لكل allocation على حدة | لكل allocation |
| 6 | Payment reversal لاحقًا | يعكس بالسنابشوتات الأصلية (payment_reversal_allocations.invoice_carrying_base_reopened + original_realized_fx_reversed) — ممنوع سعر اليوم | يُعكس الأصلي حرفيًا | يُعكس الأصلي |
| 7 | Customer Credit ثم Refund بعملة مختلفة | الرصيد: عملة مصدر + carrying؛ الرد: source_consumed بعملة المصدر + تسوية مستقلة بسعر الرد (GOLD-83) | refund_base − carrying_released | موثّق |
| 8 | Supplier invoice USD ثم Payment EUR | نفس النموذج الثلاثي باتجاه AP (supplier_payment_allocations) | نفسه بإشارة معكوسة | موثّق |
| 9 | Supplier Credit USD ثم Refund EUR | Accounting §9.3 (GOLD-73): `Dr Bank 369 / Cr 1150 360 / Cr 4900 9` | receipt_base − carrying_released | موثّق |

لكل حالة: transaction_amount (بعملتها) + source_amount (بعملة المصدر) + base carrying (بالأساسية) + FX snapshot (rate/source/timestamp) + realized gain/loss (4900/6900) + rounding (6100) — كلها حقول صريحة في الجداول المعنية. **ممنوع مقارنة أو طرح مبالغ بعملتين مباشرة في أي حالة.**
