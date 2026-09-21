# DAFTAR — Accounting Rules / قواعد المحاسبة (v3 — Final Hardening Pass #2)

> المحاسبة قلب المنصة: Deterministic, Auditable, Transactional, Idempotent, Traceable, Reversible, Testable. داخلية — لا تظهر في واجهة التاجر.
> **v3:** قيود مرتجع جزئي متوازنة رياضيًا سطرًا بسطر؛ Refundable Source Model بلا Double Counting؛ تسوية ثلاثية العملات بـRealized FX Gain/Loss؛ حسابات Clearing لطرق الدفع؛ أمثلة Void صريحة. **كل مثال رقمي في هذه الوثيقة محسوب بمجاميع مدين=دائن صريحة (Review E).**

## 1. النموذج

- Double Entry إلزامي لكل حدث مالي؛ Ledger وCoA **لكل Business**؛ لا خلط بين Businesses.
- لا أرصدة يدوية كمصدر حقيقة. Posting Engine حتمي، Idempotent: UNIQUE(business_id, source_type, source_id).
- الإلغاء/العكس بقيود عكسية موثقة فقط — لا حذف.

## 2. شجرة الحسابات (لكل Business) — v3 موسّعة

| الكود | الحساب | النوع | الاستخدام |
|---|---|---|---|
| 1000 | Cash on Hand | Asset | نقدي |
| 1010 | Bank | Asset | تحويل بنكي |
| 1020 | Card Clearing | Asset | مقاصة البطاقات |
| 1030 | Wallet Clearing | Asset | مقاصة المحافظ المحلية |
| 1040 | Cheques Clearing | Asset | مقاصة الشيكات |
| 1100 | Accounts Receivable | Asset | ذمم العملاء |
| 1150 | **Supplier Receivable (Supplier Credit)** | Asset | ذمم على المورّد — مرتجعات لم تُغطَّ بـAP، تُصفّى باسترداد نقدي أو تخصيص على شراء مستقبلي |
| 1200 | Inventory | Asset | المخزون |
| 2000 | Accounts Payable | Liability | ذمم الموردين |
| 2100 | Tax Payable | Liability | الضرائب |
| 2200 | Customer Refund Liability | Liability | التزام استرداد للعميل (من Credit Note) |
| 2210 | **Customer Credit Liability** | Liability | رصيد دائن للعميل: overpayment/advance/رصيد من عكس دفعة |
| 3000 | Equity / Opening | Equity | — |
| 4000 | Sales Revenue | Revenue | — |
| 4100 | Sales Returns (Contra-Revenue) | Revenue | مردودات |
| 4200 | Discounts (Contra-Revenue) | Revenue | خصومات ممنوحة وعكسها |
| 4900 | **Realized FX Gain** | Revenue | أرباح صرف محققة فقط |
| 5000 | COGS | Expense | — |
| 6100 | **Rounding Adjustment** | Expense | **فروقات تقريب حسابية صغيرة فقط** |
| 6200 | **Purchase Price Variance** | Expense | فرق حقيقي بين قيمة مرتجع المورّد والتكلفة الدفترية |
| 6900 | **Realized FX Loss** | Expense | خسائر صرف محققة فقط |

**قاعدة:** Realized FX Gain/Loss وRounding Adjustment وPurchase Price Variance **ثلاثة حسابات منفصلة لا تُخلط** — فرق السعر الحقيقي ليس تقريبًا، وفرق الصرف المحقق ليس تقريبًا.

## 3. قيود PostgreSQL الواقعية (G/H)

| القاعدة | الإنفاذ |
|---|---|
| سطر القيد: debit>0 XOR credit>0 | Row CHECK صارم |
| توازن القيد | Deferrable constraint trigger عند COMMIT + Reconciliation |
| Σallocations ≤ الدفعة/الفاتورة | Application invariant بقفل الصفوف + Reconciliation |
| Σأقساط+مقدم = إجمالي الفاتورة | Application invariant عند الإنشاء + Reconciliation |
| **source_refunded ≤ source_refundable** (لكل مصدر استرداد) | Application invariant بقفل صف المصدر داخل المعاملة + Reconciliation (§5) |
| receivables.outstanding = total − paid | Row CHECK (نفس الصف) |
| طريقة دفع فعّالة ماليًا لها posting_account صالح | Application invariant + FK + Integrity test (§8) |

## 4. قواعد الترحيل

### 4.1 بيع نقدي 1000: Dr Cash 1000 / Cr Revenue 1000 (D=1000=C) + Dr COGS 600 / Cr Inventory 600 (D=C=600)
### 4.2 بيع آجل: Dr AR / Cr Revenue + COGS/Inventory
### 4.3 دفعة: Dr Cash/Bank/Clearing / Cr AR — مستقلة عن الإيراد
### 4.4 تقسيط: بيع آجل كامل + مقدم دفعة؛ الأقساط جدول سداد
### 4.5 شراء آجل 5000: Dr Inventory / Cr AP؛ سداد جزئي: Dr AP / Cr Cash
### 4.6 مصروف 200: Dr Expense / Cr Cash

### 4.7 مرتجع جزئي — المثال المُصحّح (مع Golden expected journal lines)

**الأصل:** 2 × 500 = 1000؛ خصم 100؛ ضريبة 90؛ مدفوع نقدًا 990؛ COGS 600.

قيود البيع الأصلية:
```
(1) Dr Cash 990 / Dr Discounts(4200) 100 / Cr Revenue(4000) 1000 / Cr Tax Payable(2100) 90
    Total Debits = 1090 = Total Credits ✓
(2) Dr COGS(5000) 600 / Cr Inventory(1200) 600      D=C=600 ✓
```

**إرجاع صنف واحد:** gross 500، نصيب الخصم 50، عكس الضريبة 45، التزام الاسترداد 495، تكلفة snapshot 300.

```
(3) Credit Note — متوازن:
    Dr Sales Returns(4100)             500
    Dr Tax Payable(2100)                45
    Cr Discounts(4200) — عكس الخصم      50
    Cr Customer Refund Liability(2200) 495
    Total Debits = 545 = Total Credits = 545 ✓
(4) Inventory: Dr Inventory(1200) 300 / Cr COGS(5000) 300      D=C=300 ✓
(5) Refund:   Dr Customer Refund Liability(2200) 495 / Cr Cash(1000) 495      D=C=495 ✓
```

- الإيراد عُكس **مرة واحدة** (في Credit Note)؛ الـRefund تسوية نقدية فقط.
- GOLD-28 يختبر **أسطر القيود المتوقعة حرفيًا** (الحسابات والمبالغ أعلاه سطرًا بسطر) — لا مجرد فحص التوازن.

## 5. Refundable Source Model (v5) — بلا Double Counting ولا Raw Payment

**ممنوع** صيغة `refundable = paid + credit − refunds`. كل Refund يرتبط بـ**مصدر واحد صريح**، ومصادر الاسترداد المسموحة **فقط**:

- **`credit_note`** — استحقاق استرداد ناتج من مرتجع/إلغاء (قيده الأصلي Cr 2200).
- **`customer_credit`** — رصيد دائن للعميل (overpayment / advance / رصيد ناتج من عكس دفعة — §5.2؛ قيده الأصلي Cr 2210).

**الدفعة الخام (Raw Payment) ليست مصدر Refund إطلاقًا.** الدفعة المخصّصة (Allocated) تُعكس عبر Domain Command منفصل `reverse_payment_allocation` (§5.2) الذي يعيد فتح AR ويولّد — عند الحاجة لرد المال — **Customer Credit**؛ ثم يحدث الـRefund من ذلك الرصيد. هذا يمنع كسر AR (ممنوع Refund يلمس AR مباشرة).

```
refunds(
  id, tenant_id, business_id,
  -- مصدر واحد صريح — Typed FKs (لا polymorphic):
  credit_note_id  NULL,                    -- FK مركّب: (business_id, credit_note_id) → credit_notes(business_id, id)
  customer_credit_id NULL,                 -- FK مركّب: (business_id, customer_credit_id) → customer_credits(business_id, id)
  CHECK ( (credit_note_id IS NOT NULL)::int + (customer_credit_id IS NOT NULL)::int = 1 ),  -- مصدر واحد بالضبط
  -- جانب المصدر (بعملة المصدر نفسها):
  source_currency,
  source_amount_consumed_minor,            -- المبلغ المستهلك من المصدر بعملته
  source_carrying_base_amount_released,    -- القيمة الدفترية المُحرَّرة من الالتزام بالأساسية
  -- جانب الاسترداد الفعلي (بعملة الدفع للعميل):
  refund_currency,
  refund_amount_minor,
  refund_to_base_rate NUMERIC(20,10),
  refund_base_amount_minor,                -- النقد الخارج فعليًا بالأساسية
  -- الفروقات:
  realized_fx_gain_loss_minor,             -- refund_base − carrying_released (→ 4900/6900)
  rounding_difference_minor,               -- تقريب فقط (→ 6100)
  rate_source / rate_timestamp,
  payment_method_id,                       -- يحدد حساب الترحيل (§8)
  idempotency_key NOT NULL,
  status, reason,
  UNIQUE(business_id, idempotency_key)     -- عمود حقيقي معرّف أعلاه
)
credit_notes(..., refunded_amount_minor, remaining_refundable_minor)     -- يُحدَّث بقفل المعاملة
customer_credits(..., refunded_amount_minor, remaining_amount_minor)     -- يُحدَّث بقفل المعاملة
```

- مرتجع: max refund = `credit_notes.remaining_refundable` (495 — لا 990+495).
- رصيد دائن: max = `customer_credits.remaining_amount` لذلك الرصيد.
- القيد: الالتزام (2200 أو 2210 حسب المصدر) يُحرَّر بقيمته الدفترية؛ الفرق عن النقد الخارج → 4900/6900.
- **قاعدة السقف بعملة المصدر (إلزامية):** يُفحص `source_amount_consumed_minor ≤ source.remaining_refundable_minor` **بعملة المصدر نفسها** — **ممنوع تمامًا** مقارنة `refund_amount_minor` (EUR) مع `remaining_refundable_minor` (USD) مباشرة. عند اختلاف العملتين يُشتق المستهلك من المصدر عبر سعر التاريخ أو يُدخل بعملة المصدر ثم يُحوَّل للعميل.
- **Concurrency:** `SELECT … FOR UPDATE` على صف المصدر داخل معاملة الاسترداد؛ فحص السقف بعملة المصدر ثم `remaining_refundable_minor −= source_amount_consumed_minor` ذرّيًا **في نفس المعاملة** — Refund مزدوج متزامن مستحيل.
- **القيد المحاسبي:** الالتزام (2200) يُحرَّر بـ**قيمته الدفترية** `source_carrying_base_amount_released`، والنقد الخارج بـ`refund_base_amount_minor`، والفرق = Realized FX Gain/Loss (4900/6900) — لا يُقيد على 6100.
- **Golden cap test:** بيع نقدي 990 → Credit Note 495 → محاولة refund 496 **FAIL** → refund 495 **PASS** → refund ثانٍ بـ1 **FAIL** (GOLD-40).

### 5.1 مثال الاسترداد عابر العملات — إلزامي (GOLD-50)

Base = ILS. Credit Note بقيمة **100 USD** (سعر تاريخي USD→ILS = 3.60) → قيمته الدفترية في 2200 = **360 ILS**، و`remaining_refundable = 100 USD`.
استرداد كامل للمصدر لكن العميل يستلم **90 EUR** بسعر EUR→ILS = 4.10 وقت الاسترداد → النقد الخارج = 90 × 4.10 = **369 ILS**.

```
Dr Customer Refund Liability(2200)  360   (source_carrying_base_amount_released — القيمة الدفترية)
Dr Realized FX Loss(6900)             9   (369 − 360: دفعنا أكثر من القيمة الدفترية)
  Cr Cash/Bank(1000/1010)           369   (refund_base_amount = 90 EUR × 4.10)
Total Debits = 369 = Total Credits = 369 ✓
```

- الحقول: source_currency=USD، source_amount_consumed=100 → **remaining_refundable = 0 USD** (وليس 100 USD − 90 EUR — مقارنة/طرح عبر عملتين **ممنوع**)؛ refund_currency=EUR، refund_amount=90، refund_to_base_rate=4.10، refund_base=369، realized_fx=−9.
- الاتجاه المعاكس (لو كان النقد الخارج 350 مثلًا): `Dr 2200 360 / Cr Cash 350 / Cr Realized FX Gain(4900) 10`.

### 5.2 عكس الدفعة: `reverse_payment_allocation` — Domain Command ذرّي (Pass#4)

الدفعة المخصّصة **لا تُسترد مباشرة**. العكس يتم بأمر مجال مركّب ذرّي **يستهدف Allocation(s) محددة بالمعرّف — لا مبلغ الدفعة الإجمالي**:

1. قفل Payment + الـAllocations المستهدفة + الفواتير المرتبطة (`FOR UPDATE`) داخل معاملة واحدة.
2. تحديد الـallocations المعكوسة بدقة (دفعة موزعة على فواتير متعددة: يُعكس المحدد فقط).
3. إعادة فتح AR لكل فاتورة بـ`invoice_carrying_base_amount_released` **من Snapshot الأصلي للتخصيص** (لا إعادة حساب بسعر اليوم).
4. عكس أثر FX المحقق الأصلي للتخصيص (4900/6900) بنفس المبالغ الأصلية.
5. **لا لمس لـRevenue إطلاقًا.**
6. إن كان المال سيرد للعميل: توليد **Customer Credit** (2210) بالقيمة الدفترية للنقد المعكوس — والـRefund لاحقًا منه (§5).
7. Audit + Outbox؛ الـAllocation المعكوسة تُعلَّم `reversed` و**ممنوع عكسها مرة ثانية** (منع العكس المزدوج بقيد حالة + اختبار).

**Example A — دفعة مخصّصة خاطئة (GOLD-65):** Invoice 1000 آجلة؛ Payment 300 مخصّصة (AR=700). القيد الأصلي: `Dr Cash 300 / Cr AR 300`. العكس:
```
Dr AR(1100)                          300   (إعادة فتح الذمة)
  Cr Customer Credit Liability(2210) 300   (المال المعكوس مستحق للعميل)
D = 300 = C = 300 ✓
```
AR يعود **1000**؛ Revenue لم يُمسّ. عند رد المال: Refund من customer_credit → `Dr 2210 300 / Cr Cash 300`.

**Example B — عكس جزئي لدفعة موزعة (GOLD-66):** Payment 500: Allocation A=300 على Invoice A، Allocation B=200 على Invoice B. عكس Allocation B فقط:
```
Dr AR(1100) — Invoice B              200
  Cr Customer Credit Liability(2210) 200
D = 200 = C = 200 ✓
```
Invoice A **لم يتغيّر** (allocation A سليمة)؛ Invoice B أُعيد فتحه بـ200؛ محاولة عكس B ثانية **مرفوضة**.

**Example C — عكس تخصيص متعدد العملات (GOLD-67):** نفس تسوية §6: فاتورة USD 1000 @3.60، تخصيص USD 400 عبر 370 EUR @4.00 — القيد الأصلي `Dr Bank 1480 / Cr AR 1440 / Cr FX Gain 40`. العكس بـ**Snapshots الأصلية**:
```
Dr AR(1100)                         1440   (invoice_carrying_base_released الأصلي)
Dr Realized FX Gain(4900)             40   (عكس الربح المحقق الأصلي)
  Cr Customer Credit Liability(2210) 1480   (القيمة الدفترية للنقد المعكوس)
D = 1480 = C = 1480 ✓
```
**ممنوع إعادة الحساب بسعر اليوم.** الـCustomer Credit الناتج: **source 370 EUR، carrying base 1480 ILS**.

عند الرد الفعلي لاحقًا — **الحالة A (نفس العملة، GOLD-81):** استرداد كامل 370 EUR بسعر EUR→ILS = 4.20 وقت الاسترداد → النقد الخارج = 370 × 4.20 = **1554 ILS**:
```
Dr Customer Credit Liability(2210)  1480   (remaining_carrying_base بالكامل — استهلاك أخير)
Dr Realized FX Loss(6900)             74   (1554 − 1480)
  Cr Bank(1010)                     1554
Total Debits = 1554 = Total Credits = 1554 ✓
```
remaining = **0 EUR** و remaining_carrying_base = **0 ILS** بالضبط (INV-ACC-17). **370 EUR لا تصبح 350 EUR بتغيّر السعر** — مبلغ المصدر بعملته ثابت؛ الذي يتغيّر هو المعادل بالأساسية.

**الحالة B (جزئي بنفس العملة، GOLD-82):** رد 350 EUR فقط @4.20 = 1470 ILS: تحرير تناسبي من السنابشوت: carrying_released = 350 × 1480/370 = **1400**؛ `Dr 2210 1400، Dr 6900 70 / Cr Bank 1470` (1470=1470 ✓)؛ يتبقى **20 EUR مع carrying base 80 ILS** — لا تصفير.

**الحالة C (عابر العملات، GOLD-83):** العميل يختار الرد بـUSD: source_consumed = 370 EUR؛ refund_currency = USD؛ refund_amount = القيمة المتفق عليها بسعر وقت الاسترداد؛ النقد بالأساسية يُحسب من السعر الجديد والفرق عن 1480 → 4900/6900.

**Reversal FX وRefund settlement FX حدثان مستقلان لا يُخلطان.**

### 5.2ب. payment_reversal — المال ذهب (Pass#5)

حالة مختلفة جوهريًا عن §5.2: **chargeback / شيك مرتجع / تحويل بنكي معكوس** — المال نفسه لم يعد لدى النشاط. Domain Command ذرّي Idempotent (بـprovider_reference) ومُدقَّق بسبب إلزامي:

1. قفل Payment + Allocations + (Customer Credit الناتج عنها إن وجد).
2. إن كانت **allocated**: عكس الـAllocations ذرّيًا بـSnapshotsها الأصلية (إعادة فتح AR + عكس FX المحقق الأصلي) **ثم عكس أصل النقد**: `Dr AR / Cr Cash|Bank|Clearing` حسب posting_account الأصلي.
3. إن كانت **غير مخصّصة** (Customer Credit قائم): إلغاء/استهلاك الرصيد ذرّيًا: `Dr 2210 / Cr Cash|Bank|Clearing` بنفس المعاملة.
4. **لا لمس Revenue إطلاقًا**؛ Payment.status = reversed؛ reason + provider_reference إلزاميان.

**مثال (GOLD-87):** دفعة بطاقة 300 مخصّصة (`Dr 1020 Card Clearing 300 / Cr AR 300`) ثم chargeback:
```
Dr AR(1100) 300        (إعادة فتح الذمة بالسنابشوت الأصلي)
  Cr Card Clearing(1020) 300   (أصل النقد يُعكس — المال ذهب)
D = 300 = C = 300 ✓
```
**الفرق الحاسم:** `reverse_payment_allocation` = المال باقٍ عندنا (يصبح Customer Credit)؛ `payment_reversal` = المال ذهب (الأصل النقدي يُعكس). الخلط بينهما ممنوع (INV-ACC-18).

### 5.4 جدول المقارنة الرسمي — عمليات المال الأربع (محسوم نهائيًا)

| Operation | هل يغادر مال فعلي النشاط؟ | AR يتغيّر؟ | Customer Credit يُنشأ؟ | Revenue يتغيّر؟ | الكيان الدائم |
|---|---|---|---|---|---|
| **reverse_payment_allocation** | لا — المال باقٍ | نعم — يُعاد فتحه بالسنابشوت الأصلي | نعم (2210) | لا | payment_allocations(reversed) + customer_credits + قيد |
| **payment_reversal** | نعم — الأصل النقدي يُعكس | نعم إن كانت الدفعة allocated (عبر payment_reversal_allocations) | لا تلقائيًا — يلغي الرصيد القائم إن كانت unallocated | لا | payment_reversals + payment_reversal_allocations + قيد |
| **Refund** | نعم — نقد يخرج للعميل | لا — لا لمس مباشر لـAR | لا — يستهلك Credit Note/Customer Credit قائمًا | لا | refunds + قيد |
| **Credit Note** | لا | قد يخفض AR (فاتورة آجلة) أو ينشئ استحقاق استرداد (2200) | لا — هو نفسه مصدر الاستحقاق | **نعم — يعكسه** (الوحيد مع Sale) | credit_notes + قيد |

- الكيانات الدائمة: `payment_reversals` + `payment_reversal_allocations` معرّفتان في Data Model §7د (UNIQUE(business_id, idempotency_key) + Partial Unique على provider_reference بـNULL policy موثقة).
- عكس جزئي: Payment → `partially_reversed`؛ Allocation → `active | partially_reversed | reversed` (State Machines §3).

### 5.3 Customer Credit Model (Pass#4)

Overpayment / advance / رصيد من عكس دفعة = **Customer Credit** (الحساب 2210)، ليس إيرادًا وليس AR. الكيان والحقول في Data Model §7ب. يدعم: overpayment تلقائي عند تخصيص أقل من الدفعة، رصيد من `reverse_payment_allocation`، allocation على فاتورة مستقبلية (`Dr 2210 / Cr AR` بقيمة دفترية)، Refund (§5)، تعدد عملات (carrying base + عملة المصدر)، `remaining_amount` بقفل FOR UPDATE، Audit كامل، **ممنوع تعديل الرصيد يدويًا** (يتحرك فقط عبر أوامر المجال).

- **Overpayment (GOLD-68):** فاتورة 1000، دفعة 1200: تخصيص 1000 (`Dr Cash 1000 / Cr AR 1000`) + `Dr Cash 200 / Cr 2210 Customer Credit 200` — الإيراد كان 1000 عند البيع ولم يتغيّر.
- **تخصيص على فاتورة مستقبلية (GOLD-69):** `Dr 2210 200 / Cr AR 200`.
- **استرداده (GOLD-70):** Refund من customer_credit وفق §5. وعابر العملات (GOLD-71) بنفس بنية §5.1.

عندما تختلف العملات الثلاث (مثال: Base=ILS، Invoice=USD، Payment=EUR) **لا توجد FX واحدة تصف الطرفين**. كل Allocation يحمل:

```
payment_currency / payment_amount_minor
payment_to_base_rate NUMERIC(20,10)      -- سعر عملة الدفع→الأساسية في تاريخ الدفع
payment_base_amount_minor                -- قيمة النقد الداخل بالأساسية
invoice_currency / invoice_amount_applied_minor
invoice_historical_to_base_rate          -- من لقطة الفاتورة التاريخية
invoice_carrying_base_amount_released    -- القيمة الدفترية المُطفأة من AR
realized_fx_gain_loss_minor              -- الفرق المحقق (+gain / −loss)
rate_source / rate_timestamp / rounding_difference_minor
```

### مثال رقمي محسوب (Base ILS / Invoice USD / Payment EUR)

فاتورة USD 1000 عند USD→ILS = 3.60 → AR دفتري 3600 ILS. تسوية جزئية USD 400. بتاريخ الدفع: USD→ILS = 3.70، EUR→ILS = 4.00.
قيمة التسوية بالأساسية بسعر اليوم: 400 × 3.70 = 1480 ILS → الدفعة = 1480 / 4.00 = **370 EUR**.

```
Dr Bank/Clearing(1010/1020)      1480   (payment_base_amount)
  Cr AR(1100)                    1440   (carrying released = 400×3.60)
  Cr Realized FX Gain(4900)        40
Total Debits = 1480 = Total Credits ✓
```

- نفس المنطق لـAP والموردين والـRefunds حيث ينطبق.
- فرق الصرف المحقق → 4900/6900 حصرًا؛ Rounding(6100) للفروق الحسابية الصغيرة فقط.

## 7. Void الفاتورة المدفوعة (J/12) — أمثلة صريحة

المسار الوحيد: `void_invoice` المركّب الذرّي (قفل → عكس → سبب + Audit). يستهلك استحقاقًا واحدًا — **لا Refund مكرر ولا رصيد عميل مزدوج**.

### A. فاتورة نقدية مدفوعة بالكامل 1000 (COGS 600)
```
(1) عكس الإيراد: Dr Sales Returns(4100) 1000 / Cr Customer Refund Liability(2200) 1000   D=C=1000 ✓
(2) عكس المخزون: Dr Inventory(1200) 600 / Cr COGS(5000) 600                                D=C=600 ✓
(3) الاسترداد (مصدره credit_note الحاصل من الخطوة 1): Dr 2200 1000 / Cr Cash 1000          D=C=1000 ✓
النتيجة: Cash صافي 0، Revenue صافي 0، Liability 0، Inventory كما قبل البيع.
```

### B. فاتورة آجلة 1000 دُفع منها 300 (AR متبقٍ 700)
```
(1) Credit Note: Dr Sales Returns(4100) 1000
      Cr AR(1100) 700                        ← إطفاء الذمة المتبقية فقط
      Cr Customer Refund Liability(2200) 300 ← الجزء المدفوع المستحق رده
    D = 1000 = C = 700+300 ✓
(2) عكس المخزون: Dr Inventory 600 / Cr COGS 600   ✓
(3) Refund 300 من مصدر Credit Note: Dr 2200 300 / Cr Cash 300   ✓
النتيجة: AR=0 بالضبط، Liability=0، لا double refund (المصدر استُنفد: remaining=0).
```

## 8. Payment Method → GL Mapping (8)

- `payment_methods.posting_account_id` (FK → accounts, NOT NULL لأي طريقة فعّالة ماليًا): Cash→1000، Bank Transfer→1010، Card→1020، محفظة محلية→1030، شيك→1040.
- `system_type` للسلوك العام/UX؛ **الحساب المحاسبي من الـMapping** — قابل للضبط لكل Business (وفرعيًا Override لاحقًا).
- **Integrity test:** تفعيل/استخدام طريقة بلا posting_account صالح (حساب نشط من نفس Business) = مرفوض (GOLD-47).

## 9. مرتجع المورّد / Purchase Price Variance + Supplier Credit (7 / Pass#3)

فرق حقيقي بين قيمة اعتماد المورّد والتكلفة الدفترية → **6200 Purchase Price Variance** (ليس Rounding).

### 9.1 Case A — شراء غير مدفوع (AP قائم)

إرجاع يُطفئ الذمة مباشرة: `Dr AP / Cr Inventory (بـavg) / Cr 6200 PPV`.
**مثال:** شراء 10@100؛ ثم 10@80 → avg=90. إرجاع 5 بقيمته الأصلية 100/وحدة = 500:
```
Dr AP(2000) 500
  Cr Inventory(1200) 450   (5 × 90 التكلفة الدفترية)
  Cr Purchase Price Variance(6200) 50
D = 500 = C = 500 ✓
```

### 9.2 Case B — شراء مدفوع بالكامل/جزئيًا: Supplier Credit (محسوم)

ممنوع `Dr AP` بصمت عندما AP = 0 (يولّد رصيدًا مدينًا مبهَمًا). المفهوم المعتمد: **Supplier Receivable / Supplier Credit (الحساب 1150)** — ذمة لنا على المورّد، مرآة AR للعملاء بالاتجاه المعاكس، **ليست إيرادًا إطلاقًا**.

- **الكيانات (Data Model §12):** `supplier_credit_notes` (الالتزام المستحق من المورّد) + `supplier_credit_allocations` (تخصيص الرصيد على مشتريات مستقبلية) + `supplier_refunds` (استرداد نقدي/بنكي فعلي من المورّد).
- **التوليد:** مرتجع مورّد يُغطّي أولًا AP القائم للشراء المعني، وأي فائض يولّد Supplier Credit Note على 1150.
- **التصفية — مساران فقط:** (1) **تخصيص على شراء مستقبلي**: `Dr AP(2000) / Cr Supplier Receivable(1150)`؛ (2) **استرداد نقدي/بنكي**: `Dr Cash/Bank(1000/1010) / Cr Supplier Receivable(1150)`. ممنوع لمس Revenue.

**المثال الإلزامي (GOLD-58):** شراء 10×100 = 1000 مدفوع بالكامل (AP=0). avg المخزون لاحقًا = 90. إرجاع 5 وحدات — المورّد يديننا بـ500:
```
(1) Supplier Credit Note:
Dr Supplier Receivable(1150)        500   (المورّد مدين لنا)
  Cr Inventory(1200)                450   (5 × 90 التكلفة الدفترية)
  Cr Purchase Price Variance(6200)   50
D = 500 = C = 500 ✓

(2) عند وصول 500 نقدًا/بنكيًا من المورّد (supplier_refund):
Dr Cash/Bank(1000/1010) 500
  Cr Supplier Receivable(1150) 500
D = 500 = C = 500 ✓  → رصيد 1150 للمورّد = 0
```
- **Case B الجزئي (GOLD-59):** شراء 1000 دُفع منه 700 (AP=300)؛ مرتجع 500 → `Dr AP 300` (إطفاء الذمة) + `Dr Supplier Receivable 200` (الفائض) مقابل `Cr Inventory/PPV` — نفس المبدأ بتقسيم المدين.
- **تخصيص على شراء مستقبلي (GOLD-61):** شراء جديد 800 آجل؛ تخصيص رصيد 500: `Dr AP(2000) 500 / Cr Supplier Receivable(1150) 500` ثم السداد النقدي 300 فقط.
- تعدد العملات يطبَّق بالنموذج الثلاثي نفسه (§6) على supplier_credit/refund عند اختلاف العملة.

### 9.3 Supplier Refund عابر العملات — مثال محسوب إلزامي (GOLD-73)

`supplier_refunds` يحمل نفس فصل الجانبين المعتمد للاستردادات (§5): source_currency + source_amount_consumed_minor + source_carrying_base_amount_released + receipt_currency + receipt_amount_minor + receipt_to_base_rate NUMERIC(20,10) + receipt_base_amount_minor + realized_fx_gain_loss_minor + remaining على المصدر **بعملة المصدر**.

Base = ILS. Supplier Credit Note بقيمة **100 USD** (سعر تاريخي USD→ILS = 3.60) → قيمته الدفترية في 1150 = **360 ILS**، و`remaining_credit = 100 USD`. استلمنا من المورّد **90 EUR** بسعر EUR→ILS = 4.10 → النقد الداخل = 90 × 4.10 = **369 ILS**:

```
Dr Bank(1010)                     369   (receipt_base_amount = 90 EUR × 4.10)
  Cr Supplier Receivable(1150)    360   (القيمة الدفترية المُحرَّرة)
  Cr Realized FX Gain(4900)         9   (369 − 360: استلمنا أكثر من القيمة الدفترية)
Total Debits = 369 = Total Credits = 369 ✓
```

remaining_credit = **0 USD** (مستهلك 100 USD بعملة المصدر — ممنوع 100 USD − 90 EUR). الاتجاه المعاكس (استلام أقل من الدفتري) → خسارة على 6900.

## 9ب. Negative Inventory Cost Catch-up (Pass#3)

عند تغطية رصيد سالب باستلام شراء (Inventory §5أ):
```
actual > provisional:  Dr COGS(5000) catch_up / Cr Inventory(1200) catch_up
actual < provisional:  قيد معكوس
```
المثال الرقمي الكامل (oversell 5@100 ثم استلام 10@120 → catch_up=100، GL=valuation=600) في Inventory §5أ وGOLD-54/55. حركة `negative_inventory_cost_adjustment` مدقّقة (Audit) ولا تغيّر الكمية.

## 10. Invariants (v3)

| # | Invariant | الإنفاذ |
|---|---|---|
| INV-ACC-01 | Σdebit=Σcredit لكل قيد (base) | Deferrable trigger + Reconciliation |
| INV-ACC-02 | paid + outstanding = invoice.total | Application + Row CHECK + Reconciliation |
| INV-ACC-03 | Σrefunds(source) ≤ source.original، لكل مصدر على حدة — **لا تجميع عبر مصادر** | قفل FOR UPDATE + Reconciliation |
| INV-ACC-04 | down + Σinstallments = invoice.total | Application + Reconciliation |
| INV-ACC-05 | تجميد snapshots (price/cost/fx) | Append-only + اختبار |
| INV-ACC-06 | كل تغيير AR/AP له قيد مقابل | Reconciliation |
| INV-ACC-07 | لا قيدان لنفس المصدر | UNIQUE scoped |
| INV-ACC-08 | الإيراد يُنشأ/يُعكس مرة واحدة (Sale/CreditNote فقط؛ Payment/Refund لا يلمسان Revenue) | GOLD-28/40 |
| INV-ACC-09 **(مُصحّح)** | لكل تسوية: **payment_base_amount = invoice_carrying_base_released + realized_fx_gain_loss ± rounding موثّق** — ممنوع مقارنة عملتين مختلفتين مباشرة | Unit + Reconciliation |
| INV-ACC-10 | Void لفاتورة مدفوعة فقط عبر void_invoice المركّب الذرّي | GOLD-41/42 |
| INV-ACC-11 | GL Inventory(1200) = valuation ضمن tolerance ثم exact posted reconciliation | Reconciliation |
| INV-ACC-12 **(جديد)** | Realized FX Gain/Loss ≠ Rounding ≠ PPV — كل فرق له حسابه الصحيح | Golden settlement tests |
| INV-ACC-13 **(جديد)** | كل طريقة دفع فعّالة لها posting_account صالح من نفس Business | Integrity test GOLD-47 |
| INV-ACC-14 **(Pass#3)** | مرتجع مورّد يتجاوز AP القائم يولّد Supplier Receivable(1150) — ممنوع Dr AP بلا مقابل وممنوع لمس Revenue؛ 1150 يُصفّى فقط باسترداد نقدي/بنكي أو تخصيص على شراء مستقبلي | GOLD-57..61 |
| INV-ACC-15 **(Pass#3)** | تغطية الرصيد السالب تولّد catch-up COGS بحيث GL Inventory = valuation بعد الاستلام مباشرة | GOLD-54/55/56 |
| INV-ACC-16 **(Pass#4)** | مصدر Refund ∈ {credit_note, customer_credit} فقط (Typed FK + CHECK)؛ الدفعة المخصّصة تُعكس عبر reverse_payment_allocation فقط؛ Customer Credit يتحرك بأوامر المجال فقط — لا mutation يدوي ولا لمس Revenue | GOLD-62/65..71 |
| INV-ACC-17 **(Pass#5)** | كل مصدر مالي يحمل remaining بعملة المصدر **و** remaining_carrying_base معًا؛ الاستهلاك الجزئي تناسبي من السنابشوت الأصلي، والأخير يحرّر الباقي كاملًا؛ مصدر مستنفد ⇒ كلاهما = 0 بالضبط؛ يُقفلان ويُحدَّثان معًا | GOLD-79/80/84 |
| INV-ACC-18 **(Pass#5)** | `reverse_payment_allocation` (المال باقٍ → Customer Credit) ≠ `payment_reversal` (المال ذاهب → عكس أصل النقد) — مفهومان منفصلان بقيدين مختلفين | GOLD-86/87 |

## 11. Reconciliation

يومي: توازن القيود، فواتير/تخصيصات، أرصدة مشتقة (AR/AP)، خطط أقساط، GL↔valuation، مصادر الاسترداد (remaining ≥ 0)، مقاصات Clearing غير المقفلة، فروقات FX محققة مقابل سجلها. اختلاف → Alert — لا تصحيح صامت.
