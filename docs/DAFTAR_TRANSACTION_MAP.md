# DAFTAR — Transaction Map / خريطة المعاملات

> ماذا يحدث بالضبط — ومتزامنًا أم غير متزامن — عند كل حدث تجاري. **SYNC** = داخل DB Transaction واحدة (ذرّية: الكل أو لا شيء). **ASYNC** = عبر Outbox → Queue → Workers (فشلها لا يفشل العملية).

## 1. بيع نقدي (Cash Sale)

| الخطوة | SYNC/ASYNC | الأثر |
|---|---|---|
| تحقق من المخزون وخصمه (movements sale) | SYNC | stock_levels − qty |
| إنشاء Sale + SaleItems (أسعار/تكاليف مجمّدة) | SYNC | — |
| إنشاء Invoice (status=paid) | SYNC | — |
| إنشاء Payment + Allocation كاملة | SYNC | cash ↑ |
| Posting: قيد إيراد + قيد COGS | SYNC | Journal متوازن |
| AuditEvent + Outbox rows | SYNC | — |
| إشعار/واتساب إيصال، Analytics، تحديث Dashboard cache | ASYNC | — |

## 2. بيع آجل (Credit Sale)

مثل (1) لكن: بدون Payment؛ Invoice status=open؛ ينشأ Receivable(outstanding=total)؛ القيد مدين AR بدل Cash. حالة واضحة للمستخدم: "تم البيع — عليه 700".

## 3. دفعة جزئية / تحصيل دين (Payment Collection) — v2 (D)

SYNC: Payment + Allocation(s) — **كل Allocation ثلاثية العملات صراحة (v3)**: payment_currency/amount + **payment_to_base_rate** NUMERIC(20,10) → payment_base_amount؛ invoice_currency/amount_applied + **invoice_historical_to_base_rate** → **invoice_carrying_base_released**؛ **realized_fx_gain_loss = payment_base − carrying_released** → 4900/6900 (منفصل عن 6100 rounding). طريقة الدفع تحدد حساب الترحيل (`posting_account_id`: نقدي 1000 / بطاقة 1020 / محفظة 1030 / شيك 1040) — مع قفل صفوف الدفعة/الفاتورة داخل المعاملة (Σallocations ≤ المبالغ كـApplication invariant) + تحديث Receivable مشتق + قيد Dr[posting_account] / Cr AR بمبالغ base + Audit + Outbox. إن تجاوزت الدفعة التخصيصات (Overpayment): الفائض يولّد **Customer Credit** (`Dr Cash / Cr 2210`) — لا Revenue ولا رصيد معلّق غير موثّق (Accounting §5.3, GOLD-68). عكس تخصيص: عبر `reverse_payment_allocation` الذرّي فقط (§5.2 — المال باقٍ → Customer Credit). إبطال التحصيل نفسه (chargeback/شيك مرتجع/تحويل معكوس): عبر **`payment_reversal`** الذرّي (§5.2ب — المال ذهب → يعكس أصل النقد ويعيد فتح AR، بلا لمس Revenue). ASYNC: واتساب "تم تسجيل دفعة X"، كشف الحساب، Analytics.

## 4. بيع بالتقسيط (Installment Sale)

SYNC: Sale + Invoice + Receivable + InstallmentPlan (مقدم = Payment فوري إن وُجد + أقساط مجدولة) + قيود البيع الآجل + Stock + Outbox. التحقق: Σ(مقدم+أقساط) = إجمالي الفاتورة (INV-ACC-04).
ASYNC: جدولة تذكيرات الأقساط.

## 5. طلب متجر إلكتروني (Online Order)

SYNC: Order(status=pending_review) + OrderItems (snapshots) + Reservations (TTL) + Outbox. **لا Sale ولا قيد ولا خصم مخزون فعلي بعد.**
ASYNC: إشعار طلب جديد + واتساب تأكيد للعميل.
عند **القبول/التجهيز**: تحويل إلى مسار Sale (قسم 1/2) مع استهلاك الحجوزات.

## 6. إلغاء طلب (Order Cancellation)

SYNC: Order status=cancelled بسبب موثّق + تحرير Reservations + (إن دُفع: Refund معلَّق) + Audit + Outbox. ASYNC: واتساب إشعار العميل.

## 7. مرتجع (Return) — v2 (I): فصل المفاهيم الأربعة

SYNC في معاملة واحدة:
1. **Return + ReturnItems** (حدث تجاري بسنابشوتات البند الأصلية: سعر/خصم/ضريبة/تكلفة).
2. **CreditNote + CreditNoteLines**: عكس الإيراد/الخصم/الضريبة للجزء المرتجع فقط؛ على فاتورة آجلة يخفض Receivable، وعلى مدفوعة يخلق رصيدًا دائنًا للعميل.
3. **حركة مخزون `return`** + عكس COGS بتكلفة الـsnapshot الأصلية.
4. إن لزم مال: **Refund** مصدره الـCredit Note الحاصل (`credit_note_id` — Typed FK) — تسوية نقدية فقط **لا تلمس Revenue**؛ السقف = `remaining_refundable` للمصدر نفسه بقفل المعاملة.
Audit + Outbox. الأصل لا يُحذف أبدًا. المثال الرقمي الكامل: Accounting §4.7.

## 8. استرداد (Refund) — v3 (D/I/HARD-02)

SYNC: Refund بـ**مصدر واحد صريح إلزامي — Typed FK: `credit_note_id` XOR `customer_credit_id`** (الدفعة الخام ليست مصدرًا؛ الدفعة المخصّصة تُعكس أولًا عبر `reverse_payment_allocation` — Accounting §5.2)؛ السقف = `remaining` **للمصدر نفسه فقط وبعملته** — ممنوع تجميع مصادر أو مقارنة عبر عملتين. القفل: `SELECT…FOR UPDATE` على سطر المصدر داخل معاملة الاسترداد (GOLD-41 للتزامن). بنية عملة/FX كاملة (v4: source_amount_consumed **بعملة المصدر** + source_carrying_base_released + refund_to_base_rate NUMERIC(20,10) + refund_base_amount؛ فرق الصرف المحقق → 4900/6900 — Accounting §5.1) + قيد تسوية نقدية فقط (Dr 2200 لمصدر CN / Dr 2210 لمصدر Customer Credit — بالقيمة الدفترية) + Audit + Outbox. Idempotent: `UNIQUE(business_id, idempotency_key)` على جدول refunds (نوع العملية معروف من الجدول — Data Model §17). **لا double revenue reversal إطلاقًا.**

## 9. شراء (Purchase) — v2 (K)

SYNC: Purchase (business_id, destination_warehouse, currency + fx snapshot عند الحاجة, tax/discount snapshot, total) + Items + حركات `purchase` بالتكلفة الفعلية (تحديث avg_cost وفق Inventory §5) + قيد Inventory/AP أو Cash + Outbox.
سداد مورّد: **supplier_payments + supplier_payment_allocations** (نفس بنية التخصيص **ثلاثية العملات** v3 — payment_to_base_rate + invoice carrying + realized_fx_gain_loss، اتجاه معاكس AP) — دفعات جزئية مدعومة والرصيد المستحق مشتق دائمًا. إرجاع بضاعة لمورّد: يخرج بـavg الحالي وفرق سعر الشراء → **6200 Purchase Price Variance** (Accounting §9, GOLD-46). **Pass#3:** إن لم يكفِ AP القائم يولّد الفائض **Supplier Credit Note** على 1150 (Case B)؛ التصفية بـsupplier_refund نقدي/بنكي أو supplier_credit_allocation على شراء مستقبلي — لا Revenue إطلاقًا (GOLD-57..61). ASYNC: كشف المورّد، Analytics.

## 9ب. Void فاتورة مدفوعة (J)

SYNC عبر `void_invoice` المركّب الذرّي فقط: قفل الفاتورة والدفعات → عكس/استرداد الدفعات → قيد عكسي كامل + حركات مخزون عكسية → سبب + Audit. لا مسار Void مباشر لفاتورة عليها مدفوعات.

## 10. مصروف (Expense)

SYNC: Expense + قيد Expense/Cash + مرفق اختياري + Audit + Outbox. ASYNC: Analytics.

## 11. تسوية مخزون / تلف (Stock Adjustment)

SYNC: حركة adjustment/damage بسبب إلزامي + تحديث cache + Audit + Outbox. ASYNC: إن عُدّلت التكلفة الدفترية للمخزون، قيد تسوية مقابل حساب تسويات موثّق.

## 12. أحكام عامة لكل المعاملات

1. **Atomicity**: أي معاملة بعدة تغييرات مترابطة — الكل أو لا شيء (Master §96).
2. **Idempotency**: كل معاملة معرضة للتكرار تحمل مفتاح عدم تكرار (بيع Offline، دفع، ويبهوك).
3. **Traceability**: `business_transaction_id` واحد يربط السلسلة كاملة (Master §73).
4. **No False Success**: العميل لا يرى نجاحًا قبل commit الخادم (Master §161).
5. **عزل الفشل**: كل ما بعد commit (واتساب/تحليلات/إشعارات) قابل لإعادة المحاولة مع Dead-letter + Alert (Master §70).
