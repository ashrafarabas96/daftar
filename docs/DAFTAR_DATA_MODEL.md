# DAFTAR — Data Model / نموذج البيانات (v2 — بعد Correction & Hardening Pass)

> مرحلة تصميم فقط. **لا Migrations إنتاجية الآن.**
> **ملزم:** الأموال `BIGINT` minor units (ممنوع Float). أسعار الصرف `NUMERIC(20,10)` (انظر §FX). الكميات `NUMERIC(18,4)` (انظر §Quantities). السجلات المالية المكتملة: لا Hard Delete — Void/Cancel/Reversal/Credit Note.

## 1. نموذج الملكية (A): Tenant / Business — محسوم

- **Tenant** = حساب/Organization في الـSaaS (الاشتراك، الفوترة، الحد الأعلى للعزل).
- **Business** = النشاط التجاري الفعلي ويملك: `country_code`, `base_currency`, `timezone`, `default_locale`, إعدادات Storefront، و**الدفاتر المحاسبية الخاصة به**.
- **كل البيانات المالية والتجارية تحمل `business_id` إلزاميًا**، وتحمل أيضًا `tenant_id` (Denormalized) لتسريع Tenant Isolation/RLS.
- **Chart of Accounts وLedger لكل Business** — لا خلط محاسبي بين Businesses تحت Tenant واحد.
- كل Business يمكن أن يملك: دولة مختلفة، عملة أساسية مختلفة، فروعًا مختلفة، حسابات وتقارير مستقلة.
- `base_currency` على **Business فقط** (أُزيلت من Tenant). لا تتغير بعد أول معاملة مالية للـBusiness إلا بـMigration رسمية مدققة.

## 2. الهوية والعضوية (B) — محسومة

**Identity مستقلة عن الملكية.** المستخدم كيان عالمي؛ الوصول عبر Memberships:

```
users (identity عالمية: id, name, phone UNIQUE, email UNIQUE, password_hash, mfa, status)
tenant_memberships (user_id, tenant_id, tenant_role[owner|admin], status)
business_memberships (user_id, business_id, status)          — وصول لنشاط محدد
business_roles / role_permissions                              — أدوار على مستوى Business
membership_branch_access (membership_id, branch_id)            — تقييد بفروع (NULL = كل الفروع)
```

- User واحد قد يملك/يدير عدة Businesses (حتى تحت Tenants مختلفة) بأمان.
- **Source of Truth للصلاحيات:** `business_roles + role_permissions` مربوطة بـ`business_memberships` — الصلاحية تُقيَّم دائمًا في سياق (user × business × branch?). لا صلاحية بدون membership فعّالة.
- Tenant Isolation لا يضعف: كل استعلام يُقيَّد بـ(tenant_id + business_id) المتحقق من membership الجلسة.

## 3. الفروع والمستودعات (C) — مصحَّحة على التنفيذ الفعلي (P3-S0)

> **تصحيح:** النص السابق وصف `warehouses.business_id` وحده و`branches.default_warehouse_id` — والتنفيذ المجمّد في `0003_tenancy.sql` يقول غير ذلك. **التنفيذ المقبول هو المرجع.**

- **Warehouse يتبع Business ويتبع فرعًا واحدًا**: `warehouses (business_id, id)` مع `branch_id UUID NOT NULL` وقيد مركّب `(business_id, branch_id)` → `branches(business_id, id)`. الفرع المذكور هو **الفرع الأم (home branch)** للمستودع.
- **`branches.default_warehouse_id` غير موجود** ولم يُنشأ قط. الافتراضي على مستوى النشاط: `warehouses.is_default` مع `UNIQUE (business_id) WHERE is_default` — **مستودع افتراضي واحد لكل Business**.
- `is_default` **افتراض واجهة فقط ولا يمنح صلاحية** (P3-AL-15).
- **الربط المتعدد للصلاحية (المرحلة 3، P3-AL-15):** جدول ارتباط جديد

  ```
  branch_warehouses (business_id, branch_id, warehouse_id)
     PRIMARY KEY (business_id, branch_id, warehouse_id)
     FK (business_id, branch_id)    → branches   (business_id, id)
     FK (business_id, warehouse_id) → warehouses (business_id, id)
  ```

  يُزرع من `warehouses.branch_id` القائم، فلا تتغيّر صلاحية أي نشاط يوم الترحيل. مستودع مركزي يخدم عدة فروع، وفرع واحد يستخدم عدة مستودعات. **هذا الجدول وحده هو مرجع الصلاحية** في المرحلة 3؛ و`warehouses.branch_id` لا يُعدَّل ولا يُحذف.

## 4. استراتيجية العزل في الجداول (V) — محسومة

- **كل جدول تجاري — بما فيه الجداول الفرعية الحساسة — يحمل `tenant_id` و`business_id` مباشرة**: sale_items, invoice_items, payment_allocations, journal_lines, purchase_items, order_items, credit_note_lines, stock_movements, reservations… لا استثناءات.
- **Composite FKs** تمنع الربط العابر للأنشطة حتى مع Bug في طبقة التطبيق:
  - `sale_items (business_id, sale_id)` → `sales (business_id, id)` مع UNIQUE(business_id,id) على الأب.
  - نفس النمط: invoice_items→invoices، payment_allocations→payments وinvoices (بنفس business_id)، journal_lines→journal_entries، order_items→orders، installments→installment_plans.
  - المراجع التجارية داخل المعاملة (customer_id, variant_id على بند بيع) تُفرض بقيد Composite FK `(business_id, customer_id)` → `customers(business_id, id)` حيثما أمكن، وإلا بـApplication transaction invariant موثّق + اختبار Cross-business.
- هدف صريح: مستحيل ربط Sale من Business A بـCustomer/Invoice من Business B على مستوى قاعدة البيانات حيث تسمح PostgreSQL.

## 5. PostgreSQL Constraint Reality (G) — تصنيف ملزم لكل قيد

| القيد | الوسيلة الصحيحة (ليس CHECK وهميًا) |
|---|---|
| سطر قيد: مدين XOR دائن موجب | **Row CHECK** (انظر H) |
| توازن القيد Σdebit=Σcredit | **Deferrable constraint trigger** على journal_lines (يُقيَّم عند COMMIT) + Reconciliation job |
| Σpayment_allocations على دفعة ≤ مبلغ الدفعة | **Application transaction invariant** داخل معاملة التخصيص (SELECT … FOR UPDATE على payment) + Reconciliation job |
| Σallocations على فاتورة ≤ إجماليها | نفسه (قفل صف الفاتورة داخل المعاملة) + Reconciliation |
| Σinstallments + down_payment = invoice.total | **Application transaction invariant** عند إنشاء الخطة (معاملة واحدة) + Reconciliation job |
| Σrefunds ≤ refundable تراكميًا | **Application transaction invariant** (قفل الدفعة/الفاتورة داخل المعاملة) + Reconciliation |
| uniqueness العمليات | **UNIQUE(business_id, idempotency_key)** لكل جدول عمليات مستقل (نوع العملية من الجدول نفسه) — انظر §17 |
| توافق business_id بين الأبناء والآباء | **Composite FKs** (انظر V) |
| outstanding = total − paid (صف receivables) | **Row CHECK** صالح (نفس الصف) |
| مخزون غير سالب | **Conditional enforcement** في المعاملة + سياسة الاستثناء (M) — ليس CHECK لأنه يعتمد على مجموع حركات |

قاعدة عامة: أي قيد يعتمد على Aggregates أو Rows أخرى **لا يُوصف بأنه CHECK** — يُوثَّق بوسيلته الحقيقية أعلاه.

## 6. Journal Line Constraint (H) — مصحّح

```sql
CHECK (
  (debit_minor > 0 AND credit_minor = 0) OR
  (credit_minor > 0 AND debit_minor = 0)
)
```
- يمنع السطر الصفري والسطر ثنائي الجانب معًا. لا سطور صفرية إلا بسبب معماري صريح موثّق (لا يوجد حاليًا — ممنوعة).

## 7. تعدد العملات في التخصيصات والاستردادات (D) — محسوم

### payment_allocations (v3 — تسوية ثلاثية العملات)
```
payment_allocations(
  id, tenant_id, business_id,
  payment_id, invoice_id,
  -- طرف الدفع
  payment_currency, payment_amount_minor,
  payment_to_base_rate NUMERIC(20,10),      -- سعر عملة الدفع→الأساسية بتاريخ الدفع
  payment_base_amount_minor,                -- قيمة النقد الداخل بالأساسية
  -- طرف الفاتورة
  invoice_currency, invoice_amount_applied_minor,
  invoice_historical_to_base_rate NUMERIC(20,10),  -- من لقطة الفاتورة
  invoice_carrying_base_amount_released,    -- القيمة الدفترية المُطفأة من AR
  -- الفرق
  realized_fx_gain_loss_minor,              -- محقق → 4900/6900 حصرًا
  rounding_difference_minor DEFAULT 0,      -- تقريب حقيقي → 6100 فقط
  rate_source, rate_timestamp,
  reversed BOOLEAN DEFAULT FALSE,           -- تُعلَّم عبر reverse_payment_allocation (Accounting §5.2) — ممنوع عكسها مرتين
  reverse_allocation_journal_entry_id NULL  -- FK صريح → journal_entries(id) (قيد عكس التخصيص، Accounting §5.2) — لا Generic FK بلا Target
)
```
النظام يعرف بدقة: كم خُصم من Payment، كم أُغلق من Invoice بعملتها، كم أُطفئ من قيمتها الدفترية، وما الفرق المحقق. ممنوع مقارنة عملتين مباشرة (INV-ACC-09 v3).

### refunds (v5 — مصدران مسموحان فقط: credit_note | customer_credit)
```
refunds(
  id, tenant_id, business_id,
  -- Typed FKs فعلية — لا polymorphic (محسوم، لا قرار مؤجل):
  credit_note_id NULL,          -- FK مركّب (business_id, credit_note_id) → credit_notes(business_id, id)
  customer_credit_id NULL,      -- FK مركّب (business_id, customer_credit_id) → customer_credits(business_id, id)
  -- CHECK( (credit_note_id IS NOT NULL)::int + (customer_credit_id IS NOT NULL)::int = 1 )  -- مصدر واحد بالضبط
  -- جانب المصدر (بعملة المصدر نفسها):
  source_currency,                                 -- عملة المصدر (من سجل المصدر)
  source_amount_consumed_minor,                    -- المستهلك من المصدر بعملته
  source_carrying_base_amount_released,            -- القيمة الدفترية المُحرَّرة بالأساسية
  -- جانب الاسترداد الفعلي (بعملة تسليم العميل):
  refund_currency, refund_amount_minor,
  refund_to_base_rate NUMERIC(20,10),
  refund_base_amount_minor,                        -- النقد الخارج فعليًا بالأساسية
  -- الفروقات:
  realized_fx_gain_loss_minor,                     -- refund_base − carrying_released → 4900/6900
  rounding_difference_minor DEFAULT 0,             -- تقريب فقط → 6100
  rate_source, rate_timestamp,
  payment_method_id,                               -- FK مركّب → payment_methods (حساب الترحيل §13)
  idempotency_key NOT NULL,                        -- عمود حقيقي معرّف صراحة
  status, reason,
  UNIQUE(business_id, idempotency_key)
)
-- على المصادر (تُقفل FOR UPDATE عند الاسترداد):
credit_notes(..., refunded_amount_minor, remaining_refundable_minor)
customer_credits(..., refunded_amount_minor, remaining_amount_minor)
```
**الدفعة الخام ليست مصدر Refund.** الدفعة المخصّصة تُعكس عبر `reverse_payment_allocation` (Accounting §5.2) الذي يعيد فتح AR ويولّد Customer Credit عند الحاجة؛ الـRefund يحدث من `credit_note` أو `customer_credit` فقط. **السقف يُفحص بعملة المصدر:** `source_amount_consumed_minor ≤ source.remaining` — ممنوع مقارنة/طرح عبر عملتين. التحديث داخل `SELECT…FOR UPDATE` في نفس المعاملة. المثال: Accounting §5.1، GOLD-50.

### 7ب. customer_credits (Pass#4) — رصيد العميل الدائن
```
customer_credits(
  id, tenant_id, business_id, customer_id,
  origin_type IN (overpayment | reverse_payment_allocation | manual_opening),  -- reverse_payment_allocation: المال ما زال لدى Business؛ payment_reversal لا يولّد Credit (Accounting §5.2ب) — manual بصلاحية مستقبلية موثقة
  source_payment_id NULL,         -- FK مركّب → payments — للتتبع عند الوجود
  currency_code,                  -- عملة الرصيد (عملة المصدر)
  original_amount_minor,
  remaining_amount_minor,         -- بقفل FOR UPDATE — ممنوع تعديل يدوي
  refunded_amount_minor,
  original_carrying_base_amount_minor,     -- القيمة الدفترية الأصلية بالأساسية (snapshot)
  remaining_carrying_base_amount_minor,    -- القيمة الدفترية المتبقية — تُقفل مع remaining_amount في نفس المعاملة
  source_to_base_rate NUMERIC(20,10), rate_source, rate_timestamp,
  status [open | partially_used | exhausted | cancelled]
)
customer_credit_allocations(    -- تخصيص الرصيد على فاتورة مستقبلية: Dr 2210 / Cr AR
  id, tenant_id, business_id, customer_credit_id, invoice_id,
  credit_amount_consumed_minor, credit_carrying_base_released,
  invoice_currency, invoice_amount_applied_minor,
  invoice_historical_to_base_rate NUMERIC(20,10),
  realized_fx_gain_loss_minor, rounding_difference_minor DEFAULT 0,
  rate_source, rate_timestamp
)
```
- التوليد: تلقائي عند overpayment (دفعة > تخصيصاتها)، أو من `reverse_payment_allocation`، أو رصيد افتتاحي يدوي مستقبلي بصلاحية موثقة.
- التصفية مساران فقط: `customer_credit_allocations` على فاتورة، أو `refunds` (§7). **ممنوع لمس Revenue وممنوع balance mutation يدوي** — يتحرك فقط عبر أوامر المجال (INV-ACC-16).
- القيود المحاسبية والأمثلة: Accounting §5.3.

### 7د. payment_reversals (Pass#6) — كيان دائم لإبطال التحصيل

```
payment_reversals(
  id, tenant_id, business_id,
  payment_id,                                -- FK مركّب (business_id, payment_id) → payments(business_id, id)
  provider_source,                           -- card_processor | bank | cheque | wallet | manual
  provider_reference NULL,                   -- مرجع المزوّد
  reason,                                    -- إلزامي
  currency_code,
  reversed_amount_minor,                     -- بعملة الدفعة
  reversed_base_amount_minor,                -- بالأساسية من سنابشوت الدفعة الأصلي
  status [completed],                        -- حدث نهائي append-only
  journal_entry_id,                          -- FK مركّب → journal_entries
  idempotency_key NOT NULL,
  occurred_at, created_at,
  UNIQUE(business_id, idempotency_key),
  UNIQUE(business_id, provider_source, provider_reference)   -- WHERE provider_reference IS NOT NULL (Partial Unique Index — NULL policy موثقة: مزوّد بلا مرجع يعتمد idempotency_key فقط)
)

payment_reversal_allocations(
  id, tenant_id, business_id,
  payment_reversal_id,                       -- FK مركّب → payment_reversals
  payment_allocation_id,                     -- FK مركّب → payment_allocations(business_id, id)
  payment_amount_reversed_minor,             -- بعملة الدفعة
  invoice_amount_reopened_minor,             -- بعملة الفاتورة
  invoice_carrying_base_reopened,            -- من سنابشوت التخصيص الأصلي
  original_realized_fx_reversed_minor,       -- عكس FX المحقق الأصلي (4900/6900)
  CHECK (payment_amount_reversed_minor > 0)
  -- Σ reversals على allocation ≤ مبلغها الأصلي − المنعكوس سابقًا (Application invariant + قفل FOR UPDATE + حالة reversed)
)
```

- السلوك الكامل: Accounting §5.2ب. `payment_allocations` تكتسب حالة `active | partially_reversed | reversed` (تُشتق من Σ payment_reversal_allocations + reverse_payment_allocation).
- إن كانت الدفعة غير مخصّصة وقت الإبطال (Customer Credit قائم): يُستهلك/يُلغى الرصيد ذرّيًا ضمن نفس المعاملة (قيد `Dr 2210 / Cr Clearing`).

### 7ج. Carrying Value على كل مصدر مالي (Pass#5) — محسوم

**كل مصدر مالي يملك `remaining` بعملة المصدر يجب أن يملك `remaining_carrying_base` بالأساسية معه** — لا مصدر بلا قيمة دفترية متبقية:
- `customer_credits`: original/remaining_amount + **original/remaining_carrying_base** + rate snapshot (أعلاه).
- `credit_notes`: original/remaining_refundable + **original/remaining_carrying_base** (القيمة الدفترية في 2200) + rate snapshot من الفاتورة/الإشعار.
- `supplier_credit_notes`: original/remaining_amount + **original/remaining_carrying_base** (القيمة الدفترية في 1150) + source_to_base_rate NUMERIC(20,10) + rate_source + rate_timestamp.

**قاعدة الاستهلاك الجزئي الحتمية (Partial Carrying Release):**
- العمليات غير الأخيرة: تحرير **تناسبي** وفق سنابشوت المصدر الأصلي: `carrying_released = round(consumed × original_carrying_base / original_amount)` بتراكم محسوب من السنابشوت — ممنوع إعادة الحساب بسعر جديد.
- **الاستهلاك الأخير:** `carrying_released = remaining_carrying_base` **بالكامل** — يمنع تراكم rounding drift.
- **INV-ACC-17 (جديد):** مصدر مستهلك بالكامل ⇒ `remaining_amount = 0` **و** `remaining_carrying_base = 0` **بالضبط معًا**.
- **Concurrency:** `SELECT…FOR UPDATE` يقفل الصفين المنطقيين معًا — `remaining_amount` و`remaining_carrying_base` يُحدَّثان ذرّيًا في نفس المعاملة (لا تحديث لأحدهما دون الآخر).

## 8. أسعار الصرف (E)

- النوع: **`NUMERIC(20,10)`** في كل حقول fx_rate (قرار موثّق: دقة 10 خانات عشرية تكفي لأزواج مثل USD/LBP ذات المقام الكبير، مع حتمية الحساب على minor units وعدم استخدام float نهائيًا).
- كل لقطة FX تحمل: rate + source + timestamp. التاريخ لا يُعاد تقييمه.
- اختبارات إلزامية: USD→LBP، USD→JOD، EUR→TRY، دفعة جزئية متعددة العملات، استرداد متعدد العملات، فروقات التقريب (تُقيَّد على حساب 6100).

## 9. الكميات (O) — محسومة

- **كل الكميات `NUMERIC(18,4)`** مع **UoM** على المنتج: `unit_code` (piece/kg/meter/liter…) + `unit_decimals` (0 للقطعة، 3 للكيلو…) من سجل وحدات CLDR-متوافق.
- الواجهة تفرض `unit_decimals` (منتج بالقطعة لا يقبل كسورًا)؛ القاعدة تُفرض Row CHECK على المنتج وتُتحقق في التطبيق على الحركات.
- الـCore لا يمنع fractional quantities مستقبلًا.
- **المرحلة 3 (P3-AL-04/P3-AL-05):** `products.unit` الحرّ **ليس** مرجعًا دلاليًا للكمية ولا يُفسَّر ولا يُستنتج منه شيء. تُضاف `products.track_inventory` (افتراضيًا `false` لكل منتج قائم)، و`unit_code`، و`unit_decimals`، مع `CHECK (track_inventory = false OR (unit_code IS NOT NULL AND unit_decimals IS NOT NULL))`. سجل الوحدات `units(unit_code, default_decimals, sort_order)` قابل للتوسّع بترحيل، وأسماؤه المترجمة في `unit_names(unit_code, locale, display_name)` خارج حقيقة المخزون. `unit_decimals` يُجمَّد على المنتج عند الاختيار. **لا تحويل وحدات في المرحلة 3** — لا عمود معامل تحويل ولا وحدة أساس.
- **دقة الكمية — قاعدة القيمة لا قاعدة المقياس المخزَّن (P3-AL-05، تصحيح ملزم):** العمود القانوني `NUMERIC(18,4)`، وPostgreSQL يملأ كل قيمة إلى أربع خانات، فـ`scale(qty)` تساوي 4 لكل من `1` و`1.0` و`1.00` و`1.0000` و`-3.0000` — مقيسًا على PostgreSQL 16. لذلك **صيغة `scale(qty) > unit_decimals` خاطئة رياضيًا ومسحوبة**؛ لو طُبِّقت لرفضت *كل* كمية على منتج `unit_decimals = 0` بما فيها قطعة واحدة. القاعدة الملزمة هي قابلية التمثيل الدقيق على القيمة نفسها: `abs(qty) = trunc(abs(qty), unit_decimals)` — أي أن `abs(qty) × 10^unit_decimals` عدد صحيح تمامًا. بلا `FLOAT`، وبلا اختبار تنسيق نصّي، وبلا `scale()`. الرفض الثابت: `inventory.quantity_precision_invalid`. المتجهات الملزمة في `docs/PHASE_3_ARCHITECTURE_LOCK.md` P3-AL-05.

## 10. تكلفة المخزون (N) — دقة عالية محسومة

- **متوسط التكلفة المرجّح المتحرك لكل (variant × warehouse)** — ليس لكل Business ولا لكل variant فقط.
- **تمثيل التكلفة (قرار ملزم):** كل حقول التكلفة الداخلية **`NUMERIC(28,10)`** — ممنوع Float/Double مطلقًا (Master §30)، وممنوع BIGINT minor لأن التقريب المبكر يُفسد المتوسط المرجّح على الكميات الكبيرة:
  - `stock_levels.valuation_base_minor NUMERIC(28,10)` — **Cache** لمجموع قيم الحركات، وليس مصدر حقيقة ثانيًا (المرحلة 3، P3-AL-01/P3-AL-49)
  - `stock_levels.avg_unit_cost_base_minor NUMERIC(28,10)` — **مشتقّ** من الاثنين أعلاه، ولا يدخل أبدًا كمُدخل في أي كتابة
  - `stock_movements.movement_unit_cost_base_minor NUMERIC(28,10)`
  - `sale_items.unit_cost_snapshot NUMERIC(28,10)` — مجمّد لحظة البيع من avg لحظتها.
- **سياسة التقريب عند القيد المحاسبي:** يُحوَّل NUMERIC(28,10) → BIGINT minor بتقريب HALF_EVEN **عند توليد القيد فقط**، ثم يُوزَّع فرق التقريب على أسطر القيد (السطر الأكبر أولًا) بحيث **Σ COGS الأسطر = COGS المقيَّد تمامًا** — الفرق المتبقّي إن وجد يُقيد على 6100 Rounding Adjustment. الصيغ الكاملة في `DAFTAR_INVENTORY_RULES.md` §N و`DAFTAR_ACCOUNTING_RULES.md`.
- `products.cost_minor` = **تكلفة مرجعية للعرض فقط** (تُستخدم أول مرة قبل أي شراء)، **ليست مصدر حقيقة**.
- **Invariant جديد (INV-INV-06):** رصيد حساب المخزون في GL = **Σ`value_delta_base_minor`** على كل حركات الـBusiness — يُتحقق بـReconciliation job. صيغة `Σ(qty × avg_cost)` القديمة **مسحوبة** (P3-AL-43/P3-AL-49): المتوسط خارج قسمةٍ مقرَّبة، فضربه مرة أخرى يعيد إدخال انحراف التقريب في مطابقة مطلوب فيها صفر هامش، وهو يقرأ الـCache بدل الدفتر.
- **المرحلة 3 (P3-AL-11):** لكل حركة مكوّنان صريحان — `qty_delta NUMERIC(18,4)` و`value_delta_base_minor NUMERIC(28,10)` — مع `unit_cost_base_minor NUMERIC(28,10)` يكون `NULL` في حركة القيمة الصرفة. `CHECK (NOT (qty_delta = 0 AND value_delta_base_minor = 0))` و`CHECK ((qty_delta = 0) = (unit_cost_base_minor IS NULL))`. بذلك تُعاد الكمية والتقييم كلاهما من الحركات وحدها: `on_hand = Σ qty_delta` و`valuation_base_minor = Σ value_delta_base_minor` بترتيب `stock_seq` — **جمعُ قيمٍ مخزَّنة، بلا ضرب وبلا قسمة وبلا تقريب**، وهذا ما يجعل إعادة البناء دقيقة.
- **المرحلة 3 (P3-AL-49) — قانون دقة التقييم:**
  - **حدّ التقريب الوحيد للحركة:** `value_delta_base_minor = HALF_EVEN(exact(qty_delta × unit_cost_base_minor), 10)`. الكمية 4 خانات والتكلفة 10، فحاصل الضرب قد يبلغ 14 خانة، ولذلك «الحاصل الدقيق مخزَّنًا بعشر خانات» مستحيل في الحالة العامة. بعد الكتابة تصبح **القيمة المخزَّنة** هي المرجع إلى الأبد، ولا يُعاد حسابها من `qty × avg` في أي تقرير ولا إعادة بناء.
  - `unit_cost_base_minor` **لقطة للأثر والتقارير**؛ `value_delta_base_minor` هو **مبلغ التقييم المرجعي**. ليسا مترادفين.
  - **ممنوع اشتقاق التقييم من `on_hand × avg`** في أي مسار. مقيسًا: `on_hand = 3` و`valuation = 1.0000000000` يعطي متوسطًا `0.3333333333` وحاصل ضرب `0.9999999999` — انحراف `10^-10` يتراكم في اتجاه واحد.
  - **تفريغ الرصيد:** حركة خارجة تُفرِّغ المفتاح (`abs(qty_delta) = on_hand`) قيمتها معرَّفة بأنها سالب التقييم المخزَّن المتبقي كاملًا، فيتحقق `on_hand = 0 ⇒ valuation_base_minor = 0` تمامًا وبلا أي هامش.
  - **النقل بين المخازن:** قيمة `transfer_in` معرَّفة بأنها سالب قيمة `transfer_out` المخزَّنة، فمجموع الزوج صفر **بالبناء** لا بحظّ التقريب.
- **المرحلة 3 (P3-AL-02/P3-AL-09):** مفتاح المخزون `(business_id, warehouse_id, variant_id)`؛ لكل حركة `stock_seq BIGINT` يُخصَّص تحت قفل صف `stock_levels` مع `UNIQUE (business_id, warehouse_id, variant_id, stock_seq)` — **الترتيب المرجعي، وليس `created_at`**. وهوية الحركة خماسية: `UNIQUE (business_id, source_type, source_id, source_line_id, movement_kind)` بلا أي FK متعدد الأشكال من `stock_movements` إلى جداول النطاقات. وأنواع الحركة سجل مغلق `stock_movement_kinds` يُوسَّع بترحيل.
- **المرحلة 3 (P3-AL-50/P3-AL-51) — هوية المصدر واكتماله فيزيائيًا:** الهوية الخماسية تمنع التكرار **فقط**، ولا تثبت أن المصدر حقيقي. لذلك: `source_type` مفتاح أجنبي إلى سجل مغلق `stock_source_types` (فالنص الحرّ مستحيل فيزيائيًا)، ويُضاف ربط عام `stock_source_bindings` بمفاتيح أجنبية **مؤجَّلة في الاتجاهين** تُتحقَّق عند `COMMIT` على نمط `accounting_source_bindings` نفسه — فلا حركة بلا سطر مصدر حقيقي، ولا سطر مصدر منتهٍ بلا حركاته المطلوبة، مع منع الحذف وتجميد الهوية المالية والمخزنية بعد الإنهاء. ولا يزال `stock_movements` بلا أي FK متعدد الأشكال.
- **المرحلة 3 (P3-AL-13) — هوية تغطية العجز:** سطر شراء واحد قد يغطّي عدة طبقات عجز، فلو حملت كل حركات التغطية `source_id = purchase` و`source_line_id = purchase_line` لقبلت الهوية الخماسية **واحدة** ورفضت الباقي. لذلك: رأس `negative_inventory_cost_adjustments` واحد لكل عملية استلام، وسطر تغطية غير قابل للتعديل لكل طبقة، فتحمل كل حركة `source_id = رأس التسوية` و`source_line_id = سطر التغطية`. قيدٌ محاسبي واحد للرأس، وحركة قيمة واحدة لكل تغطية.

## 10ب. Negative Inventory Deficit Entities (Pass#5) — كيانات فعلية

دعمًا لسياسة §5أ في Inventory Rules وGOLD-72 — الكيانان معرّفان فعليًا:

```
negative_inventory_deficits(
  id, tenant_id, business_id, warehouse_id, variant_id,
  source_stock_movement_id,                    -- حركة البيع السالبة الأصلية
  deficit_seq BIGINT,                          -- تسلسل رسمي لكل (business,warehouse,variant) — FIFO حتمي
  original_deficit_qty NUMERIC(18,4),
  uncovered_qty NUMERIC(18,4),
  provisional_unit_cost_base_minor NUMERIC(28,10),
  status [open | partially_covered | closed],
  created_at,
  CHECK (original_deficit_qty > 0),
  CHECK (uncovered_qty >= 0),
  CHECK (uncovered_qty <= original_deficit_qty),
  UNIQUE (business_id, warehouse_id, variant_id, deficit_seq)
)

negative_deficit_coverages(
  id, tenant_id, business_id,
  deficit_id,                                  -- FK مركّب (business_id, deficit_id) → negative_inventory_deficits(business_id, id)
  receipt_stock_movement_id,                   -- FK مركّب → stock_movements
  qty_covered NUMERIC(18,4),
  provisional_unit_cost_base_minor NUMERIC(28,10),   -- سنابشوت من الـdeficit
  actual_unit_cost_base_minor NUMERIC(28,10),        -- من الاستلام
  catch_up_amount_base_minor NUMERIC(28,10),         -- qty_covered × (actual − provisional)
  journal_entry_id,                            -- قيد catch-up المصاحب
  created_at,
  CHECK (qty_covered > 0)
)
```

- **FIFO حتمي:** الترتيب بـ`deficit_seq` (تسلسل رسمي لكل business+warehouse+variant) ثم `id` — **لا يعتمد على timestamp وحده** (التعادل ممكن). الاستلام يغطي الأقدم `open/partially_covered` أولًا.
- **الذرّية:** تحديث `uncovered_qty` + سطر التغطية + حركة المخزون + قيد catch-up المحاسبي — **كلها داخل معاملة الاستلام الواحدة** مع `SELECT…FOR UPDATE` على الـdeficit (استلامان متزامنان لا يغطيان نفس العجز مرتين).
- **Index:** `(business_id, warehouse_id, variant_id, status, deficit_seq)` للبحث عن العجوزات المفتوحة بترتيب FIFO.

## 11. المرتجعات والإشعارات الدائنة (I) — فصل المفاهيم

```
returns (tenant_id, business_id, sale_id, invoice_id, reason, status, actor, business_transaction_id)
return_items (tenant_id, business_id, return_id, sale_item_id, qty NUMERIC(18,4), unit_price_snapshot, tax_snapshot, discount_snapshot, unit_cost_snapshot)
credit_notes (tenant_id, business_id, invoice_id, return_id?, number, status, subtotal/discount/tax/total_minor, currency_code,
              refunded_amount_minor, remaining_refundable_minor,
              original_carrying_base_amount_minor, remaining_carrying_base_amount_minor,  -- §7ج
              source_to_base_rate NUMERIC(20,10), rate_source, rate_timestamp,
              business_transaction_id)
credit_note_lines (tenant_id, business_id, credit_note_id, account/line refs, amounts)
```

- **Return** = الحدث التجاري لعودة المنتج.
- **CreditNote** = عكس الإيراد/الخصم/الضريبة والذمة للجزء المرتجع فقط.
- **Inventory return** = إعادة الكمية وعكس COGS بتكلفة الـSnapshot الأصلية.
- **Refund** = تسوية نقدية/بنكية لإرجاع المال — **لا يعكس الإيراد مرة ثانية** إذا عكسه Credit Note.
- المثال الرقمي الكامل في `DAFTAR_ACCOUNTING_RULES.md` §4.7.

## 12. الموردون والذمم الدائنة (K) — مكتمل

```
suppliers (tenant_id, business_id, name, phone, ...)
purchases (tenant_id, business_id, supplier_id, destination_warehouse_id, branch_id?,
           status, currency_code, fx snapshot fields?, subtotal/discount/tax/total_minor,
           paid_minor مشتق, outstanding مشتق, received_at)
purchase_items (tenant_id, business_id, purchase_id, variant_id, qty NUMERIC(18,4), unit_cost_minor)
supplier_payments (tenant_id, business_id, supplier_id, payment_method_id, direction=out,
                   amount_minor, currency_code, fx snapshot,
                   idempotency_key NOT NULL, UNIQUE(business_id, idempotency_key), status)
payments (id, tenant_id, business_id, customer_id?, invoice context, payment_method_id,
          amount_minor, currency_code, fx snapshot ثلاثي البنية, status, reason,
          idempotency_key NOT NULL, UNIQUE(business_id, idempotency_key))
offline_operations (id, tenant_id, business_id, device_id, operation payload ref,
          offline_local_id NOT NULL, UNIQUE(business_id, offline_local_id), sync_status)
whatsapp_messages (id, tenant_id, business_id, template_id, to, payload, status,
          idempotency_key NOT NULL, UNIQUE(business_id, idempotency_key))
supplier_payment_allocations (نفس بنية payment_allocations متعددة العملات لكن على purchase)
supplier_credit_notes (tenant_id, business_id, supplier_id, supplier_return_id?, number,
                       currency_code, original_amount_minor, remaining_amount_minor,
                       original_carrying_base_amount_minor, remaining_carrying_base_amount_minor,  -- §7ج
                       source_to_base_rate NUMERIC(20,10), rate_source, rate_timestamp,
                       status, business_transaction_id)
supplier_credit_allocations (tenant_id, business_id, supplier_credit_note_id, purchase_id,
                             amount_minor + بنية ثلاثية العملات كاملة عند الحاجة)
supplier_refunds (tenant_id, business_id, supplier_id, supplier_credit_note_id,
                  -- نفس فصل الجانبين المعتمد للاستردادات (مرآة §7):
                  source_currency, source_amount_consumed_minor,        -- بعملة Supplier Credit
                  source_carrying_base_amount_released,                 -- القيمة الدفترية المُحرَّرة من 1150
                  receipt_currency, receipt_amount_minor,
                  receipt_to_base_rate NUMERIC(20,10), receipt_base_amount_minor,
                  realized_fx_gain_loss_minor,                          -- → 4900/6900
                  rounding_difference_minor DEFAULT 0, rate_source, rate_timestamp,
                  payment_method_id, direction=in,
                  idempotency_key NOT NULL,
                  UNIQUE(business_id, idempotency_key), status)
-- supplier_credit_notes: remaining_amount_minor بعملة المصدر + remaining_carrying_base — يُقفلان معًا FOR UPDATE (§7ج)
```
- الرصيد المستحق للمورّد **مشتق** (Purchases − Allocations) — لا `supplier.balance` يدوي.
- دفعات مورّد جزئية مدعومة بنفس محرك AR لكن باتجاه معاكس (AP).
- **Supplier Credit (Pass#3):** مرتجع مورّد يُغطّي أولًا AP القائم؛ الفائض يولّد `supplier_credit_note` (قيد على 1150 Supplier Receivable). يُصفّى فقط بـ: (1) `supplier_credit_allocations` على شراء مستقبلي، أو (2) `supplier_refunds` استرداد نقدي/بنكي مستلم (direction=in). ممنوع Dr AP بلا مقابل وممنوع لمس Revenue (INV-ACC-14؛ Accounting §9.2).

## 13. طرق الدفع المخصصة (L)

```
payment_methods (id, tenant_id, business_id, system_type[cash|card|bank_transfer|wallet|cheque|other],
                 posting_account_id,     -- FK مركّب (business_id, posting_account_id) → accounts(business_id, id)
                 is_active, requires_reference, sort_order)
payment_method_names (payment_method_id, locale, display_name)   -- ترجمة الاسم
```
- `system_type` مغلق (يحدد السلوك المحاسبي العام)، لكن **الاسم والتفعيل بيانات Business-level**: التاجر يضيف "محفظة محلية/حوالة/شيك" دون تعديل كود.
- **`posting_account_id` إلزامي (NOT NULL فعليًا) لكل طريقة دفع نشطة ماليًا**: يحدد حساب الترحيل في GL (نقدي→1000، بنك→1010، بطاقة→1020 Card Clearing، محفظة→1030 Wallet Clearing، شيك→1040 Cheques Clearing). **ممنوع إنشاء/تفعيل طريقة دفع دون حساب ترحيل صالح** — قاعدة التطبيق + اختبار تكامل GOLD-47 (Accounting §8). القيد يصبح: `Dr [posting_account] / Cr AR` — المحفظة تُقيَّد على حساب تسوية خاص بها وليس Cash.
- payments.payment_method_id → payment_methods (composite بـbusiness_id).
- **المرحلة 3 (P3-AL-27):** هذا الأساس المشترك **لم يُنشأ بعد** في المستودع، ويُنشئه P3-S6 بالحد الأدنى أعلاه ليخدم **مدفوعات الموردين الآن** ومدفوعات العملاء في المرحلة 4 لاحقًا. ممنوع حلّ مدفوعات المورّد بعمود `supplier_payment.cash_account_id` خاص. المرحلة 3 **لا تنفّذ مدفوعات العملاء** ولا تنشئ جدول `payments`.

## 14أ. ترقيم الفواتير — نطاق Business كحد أدنى (محسوم)

```
invoice_sequences (tenant_id, business_id, sequence_key, current_value BIGINT, prefix?, padding)
   UNIQUE(business_id, sequence_key)
```

- **نطاق الترقيم = Business-level كحد أدنى إلزامي** — ممنوع تسلسل مشترك على مستوى Tenant يخلط فواتير Businesses مختلفة، وممنوع تداخل النطاقات.
- كل Business له عدّادات مستقلة لكل نوع مستند (invoice, credit_note, purchase…) — التخصيص الذرّي داخل معاملة الإنشاء (`SELECT…FOR UPDATE` على سطر التسلسل).
- **الـCountry Pack يقرر نوع التسلسل** (سنوي/شهري/مستمر) والبادئة إن فرضتها اللائحة — لكنه لا يغيّر نطاق العزل: Business دائمًا. يحسم OD-05.
- تسلسلان لنفس النوع داخل Business واحد (لفرعين مثلًا) **قرار Business-level اختياري** (`sequence_key` يتضمن الفرع) — لكن الافتراضي تسلسل واحد لكل Business لكل نوع.

## 13ب. الدفتر المحاسبي — pseudo-schema تنفيذي

```
accounts (id, tenant_id, business_id, code, name, type, is_active,
          UNIQUE(business_id, code))
journal_entries (id, tenant_id, business_id, entry_date, description,
          source_type, source_id,                       -- أعمدة حقيقية
          status [posted],                              -- append-only: لا تعديل/حذف
          UNIQUE(business_id, source_type, source_id))  -- Posting Engine idempotent
journal_lines (id, tenant_id, business_id, journal_entry_id, account_id,
          debit_minor BIGINT DEFAULT 0, credit_minor BIGINT DEFAULT 0,
          CHECK ( (debit_minor > 0)::int + (credit_minor > 0)::int = 1 ),   -- XOR صارم
          CHECK (debit_minor >= 0 AND credit_minor >= 0))
-- FKs مركّبة: journal_lines(business_id, journal_entry_id) → journal_entries(business_id, id)
--             journal_lines(business_id, account_id) → accounts(business_id, id)
-- توازن القيد (Σdebit=Σcredit لكل entry): Deferrable constraint/trigger + Reconciliation يومي (ليس row CHECK — Aggregate)
```

## 14. السلة (T) — محسومة

```
carts (tenant_id, business_id, customer_id?, session_id?, status[active|converted|abandoned|expired], currency_code, expires_at)
cart_items (tenant_id, business_id, cart_id, variant_id, qty NUMERIC(18,4), unit_price_snapshot)
```
- Reservations.ref_type يشير فقط لكيانات موجودة: `cart | order | offline_sale` — **لا مراجع معلّقة**.
- Checkout = تحويل cart → order في معاملة واحدة مع تثبيت الأسعار.

## 15. الترجمات (Q)

- `product_translations` (موجودة) + **`category_translations`** + **`business_public_texts`** (business_id, key, locale, value: اسم المتجر العام، وصف، سياسات، تذييل فاتورة) + قوالب إشعارات/واتساب لكل locale (whatsapp_templates موجودة) + **نصوص حالة الطلب للعميل** من Localization Glossary (لا نصوص ثابتة).
- تفعيل تعدد لغات Storefront لاحقًا = بيانات لا Migration مؤلمة.

## 16. الأسعار ومصدر الحقيقة (P) — محسوم

- سعر المنتج (`products.price_minor` / variant override) **دائمًا بالعملة الأساسية للـBusiness** — أُزيل `product.currency_code` (كان مصدر غموض).
- البيع بعملة معاملة مختلفة يتم عبر FX snapshot فقط.
- **قابلية التوسع:** جدول `price_lists` / `price_list_items` (business_id, name, currency_code?, rules) محجوز في التصميم — يُفعَّل لاحقًا دون تخريب Catalog (أسعار POS تقرأ من price list الافتراضية = سعر المنتج).

## 17. Idempotency Scope (U) — محسوم (Pass#3 — Schema Executable)

**المعمارية المعتمدة: جدول مستقل لكل عملية → مفتاح لكل جدول، بلا Literal داخل UNIQUE.**

- كل جدول عمليات مستقل يحمل: **`UNIQUE(business_id, idempotency_key)`** — نوع العملية معروف من الجدول نفسه:
  - `refunds`: `UNIQUE(business_id, idempotency_key)`
  - `payments` / `supplier_payments` / `supplier_refunds`: `UNIQUE(business_id, idempotency_key)`
  - العمليات Offline: `UNIQUE(business_id, offline_local_id)` (المعرّف المحلي هو المفتاح)
  - `whatsapp_messages`: `UNIQUE(business_id, idempotency_key)`
- **ممنوع** `UNIQUE(business_id, 'refund', idempotency_key)` — الـliteral string ليس عمودًا ولا يمكن تحويله إلى Migration.
- إن ظهر مستقبلًا **جدول Idempotency Registry مشترك** فيجب أن يحمل عمودًا فعليًا `operation_type` ويصبح `UNIQUE(business_id, operation_type, idempotency_key)` — حاليًا لا نستخدمه.
- لمستهلكي Webhooks/الأحداث: أعمدة فعلية `(business_id, event_source, external_event_id)` — المكرر يُتجاهل بأمان.

## 18. ERD v2 (المخطط النصي المحدّث)

```
Tenant 1───* tenant_memberships *───1 users (identity عالمية)
Tenant 1───* Business (country, base_currency, timezone, default_locale, storefront)
Business 1───* Branch (default_warehouse_id؟)
Business 1───* Warehouse (مركزي أو مرتبط بفروع)
Business 1───* business_memberships 1───* membership_branch_access
Business 1───* business_roles 1───* role_permissions
Business 1───* Product ──* ProductTranslation / ProductVariant / Category(──*CategoryTranslation) / Media
Business 1───* payment_methods ──* payment_method_names
Business 1───* StockMovement / Reservation(ref: cart|order|offline_sale) / Stocktake / stock_levels(cache+avg_cost)
Business 1───* Cart ──* CartItem
Business 1───* Customer / Supplier
Business 1───* Sale ──* SaleItem ──1 Invoice ──* InvoiceItem
Invoice 1───* payment_allocations *───1 Payment  (متعدد العملات بالكامل)
Invoice 1───1 Receivable(مشتق) 1───* InstallmentPlan 1───* Installment
Sale 1───* Return ──* ReturnItem ──► CreditNote ──* CreditNoteLine
Customer 1───* customer_credits ──* customer_credit_allocations ──► Invoice
CreditNote / CustomerCredit 1───* Refund (متعدد العملات، مصدر واحد Typed FK)
Payment 1───* payment_allocations (active/partially_reversed/reversed؛ العكس عبر reverse_payment_allocation)
Payment 1───* payment_reversals ──* payment_reversal_allocations  -- §7د
Supplier 1───* Purchase ──* PurchaseItem; Purchase *───* supplier_payment_allocations *───1 supplier_payments
Supplier 1───* supplier_credit_notes ──* supplier_credit_allocations ──► Purchase; supplier_credit_notes 1───* supplier_refunds
Business 1───* Expense
Business 1───* Order ──* OrderItem (storefront)
Business 1───* accounts (CoA لكل Business) ──* journal_entries ──* journal_lines  -- Posting Engine idempotent: UNIQUE(business_id, source_type, source_id) على journal_entries (أعمدة حقيقية)
Business 1───* negative_inventory_deficits ──* negative_deficit_coverages  -- §10ب
Tenant 1───* Subscription/Entitlement
Business 1───* Notification / WhatsAppAccount/Template/Message / AIInteraction/AIDraft / AuditEvent / OutboxEvent / business_public_texts
```

**الجداول الفرعية كلها تحمل (tenant_id, business_id) — انظر §4.**

**كيانات غير مخزّنة (Review J — تسمية صريحة):** `void_invoice`، `reverse_payment_allocation`، `payment_reversal`، `checkout` = **Domain Commands ذرّية** (آثارها تُخزَّن في journal_entries/stock_movements/customer_credits؛ ليست جداول). `stock_levels` = **Read Model/Cache** قابل لإعادة البناء. `products.cost_minor` = قيمة عرض مرجعية. Money = **Value Object** غير مخزّن. لا جدول persistent يوجد في النثر فقط.

## 19. ما لم يُحسم

انظر `DAFTAR_OPEN_DECISIONS.md` — القرارات المفتوحة المتبقية فعليًا: OD-02 واتساب، OD-03 ضرائب، OD-04 بوابات دفع، OD-06 الخط اللاتيني، OD-07 FX revaluation، OD-08 التقويم الهجري، OD-09 تعدد لغات storefront، OD-10 RBAC المخصص، OD-11 مزوّد أسعار الصرف. (OD-01/OD-05/OD-12 **مغلقة** — لا تُذكر كمفتوحة.)
