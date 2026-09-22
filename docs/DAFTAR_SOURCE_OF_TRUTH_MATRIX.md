# DAFTAR — Source of Truth Matrix / مصفوفة مصادر الحقيقة (Phase 0 Final)

> قاعدة ملزمة: **كل رصيد مشتق** من مصادره — ممنوع `customer.balance +=` / `supplier.balance +=` / `stock -=` كمصدر حقيقة. أي Cache (stock_levels, Dashboard) قابل لإعادة البناء ويُتحقق منه بـReconciliation.

## 1. المصفوفة

| المفهوم | مصدر الحقيقة الوحيد | المعادلة المشتقة | Read Model/Cache |
|---|---|---|---|
| **ذمة العميل (AR)** | `invoices` + `payment_allocations`(active) + `credit_notes` + عكسياتها | outstanding = invoice.total − Σallocations(active, بعملة الفاتورة) − Σcredit_notes المطبقة + Σallocations المعكوسة (reopened) | receivables (مشتق محفوظ، يُتحقق يوميًا) |
| **رصيد العميل الدائن** | `customer_credits` + `customer_credit_allocations` + `refunds` | remaining = original − Σallocations.consumed − Σrefunds.consumed (بعملة المصدر) — ومعه remaining_carrying_base بالأساسية (§7ج) | لا يدوي — يتحرك بأوامر المجال فقط |
| **ذمة المورّد (AP)** | `purchases` + `supplier_payment_allocations`(active) + `supplier_credit_allocations` | outstanding = purchase.total − Σsupplier_payment_allocations(active) − Σsupplier_credit_allocations | لا `supplier.balance` يدوي |
| **رصيد المورّد الدائن (Supplier Credit)** | `supplier_credit_notes` + `supplier_credit_allocations` + `supplier_refunds` | remaining = original − Σallocations − Σrefunds (بعملة المصدر) + remaining_carrying_base | — |
| **كمية المخزون** | `stock_movements` (append-only) | on_hand = Σqty حسب (variant × warehouse) | stock_levels (Cache، INV-INV-03) |
| **تكلفة المخزون** | تقييم الحركات (`movement_unit_cost_base_minor` NUMERIC(28,10)) + `negative_deficit_coverages` | avg مرجّح متحرك لكل (variant × warehouse) وفق Inventory §5/§5أ | stock_levels.avg (Cache) |
| **GL** | `journal_entries` + `journal_lines` (append-only) | أرصدة الحسابات = Σ أسطر القيود | لا رصيد يدوي؛ INV-ACC-11 GL Inventory = valuation |
| **التسوية اليدوية** (P2-S4) | `accounting_manual_adjustments` + القيد المرتبط بها عبر `accounting_source_bindings` | القيد هو الواقعة؛ صف التفصيل يحمل السبب والفاعل فقط | — |
| **عكس قيد** (P2-S4) | `accounting_reversals` + القيد الجديد `source_type='reversal'` | سطور العكس **مشتقة** من `journal_lines` للقيد الأصلي: مبادلة مدين/دائن وكل ما عداه منسوخ حرفيًا بما فيه سعر الصرف ووقته ومصدره | — |
| **الرصيد الافتتاحي** (P2-S4) | `accounting_opening_balances` + `accounting_opening_balance_lines` | سطر حقوق الملكية الموازن (`opening_equity`) **مشتق** من مراكز التاجر ولا يُصرَّح به؛ مجموعة واحدة فقط بحالة `posted` لكل نشاط | — |
| **النقد/البنك/Clearing** | أسطر القيود على حسابات 1000/1010/1020/1030/1040 | رصيد الحساب = Σdebit − Σcredit | — |
| **المتاح للبيع** | on_hand − Σreservations(active) | مشتق لحظي | — |
| **حالة الفاتورة** | `invoices` + allocations + void | open/partially_paid/paid/voided — مشتقة من المعادلة لا تُحرَّر يدويًا | — |
| **حالة الدفعة** | `payments` + `payment_reversals` | pending/failed/completed/partially_reversed/reversed — reversed مشتقة من Σreversals | حالة العرض "تم الاسترداد" مشتقة من refunds/credits |
| **Idempotency** | مفاتيح UNIQUE لكل جدول عمليات | — | — |

## 2. محظورات صريحة

1. ممنوع أي عمود `balance` قابل للكتابة اليدوية على customer/supplier/product.
2. ممنوع تحديث `stock_levels` مباشرة من الواجهة — يُبنى من الحركات فقط.
3. ممنوع قيد محاسبي بلا مصدر (source_type/source_id) — Posting Engine Idempotent بـUNIQUE(business_id, source_type, source_id). الهوية المالية هي هذه الثلاثية وحدها؛ مفتاح `Idempotency-Key` في HTTP وسيلة نقل فقط ولا يُخزَّن كهوية مالية (P2-S4 §11).
4. ممنوع أي "تصحيح صامت" — كل Reconciliation discrepancy → Alert.
5. ممنوع تعديل أو حذف قيد مُرحَّل، وممنوع وضع علامة "معكوس" عليه — التصحيح واقعة محاسبية جديدة (P2-S4 §61).

## 3. الارتباط بالاختبارات

INV-ACC-01..18 · INV-INV-01..09 · GOLD-01..88 — كل صف في هذه المصفوفة مغطى باختبار Golden و/أو Reconciliation يومي مسمّى.
