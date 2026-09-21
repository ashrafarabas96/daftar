# DAFTAR — PHASE 0 CLOSURE REPORT (Pass #4)

> التاريخ: 2026-09-19 · النطاق: توثيق فقط — **لا Coding، لا Migrations، لا Phase 1.**
> المدخل: المراجعة الرابعة — 10 نقاط إغلاق محددة + 10 اختبارات Golden + Review H (Financial Source Semantics) + Review I (Pseudo-Schema Lint).

## 1. تنفيذ النقاط العشر

### 1. Refunds Schema قابل للتنفيذ فعليًا
`refunds` (Data Model §7 v5 / Accounting §5 v5) يعرّف الآن **`idempotency_key NOT NULL`** كعمود صريح قبل قيد `UNIQUE(business_id, idempotency_key)`. فُحص كل schema آخر (Review I): supplier_refunds/payments/supplier_payments/whatsapp_messages/offline operations كلها تملك عمود المفتاح معرّفًا صراحة قبل القيد.

### 2. لا Polymorphic FK مؤجل
حُذف خيار "نقرر في أول Migration". **محسوم الآن:** Typed FKs فعلية — `credit_note_id NULL` و`customer_credit_id NULL` مع `CHECK(واحد بالضبط NOT NULL)`، وكل FK **مركّب بنفس business_id**: `(business_id, credit_note_id) → credit_notes(business_id, id)` ومثله للآخر. لا Generic polymorphic FK في النواة المالية.

### 3+4. Payment Refund Semantics + مصادر الاسترداد الجديدة
- **Raw Payment ليس مصدر Refund إطلاقًا.** المصدران المسموحان فقط: **`credit_note`** (استحقاق من مرتجع/إلغاء → 2200) و**`customer_credit`** (overpayment/advance/رصيد عكس دفعة → 2210، حساب جديد في CoA).
- **الدفعة المخصّصة** تُعكس عبر Domain Command ذرّي **`reverse_payment_allocation`** (Accounting §5.2): قفل Payment+Allocations+Invoices → استهداف allocations بالمعرّف (لا مبلغ الدفعة الإجمالي) → إعادة فتح AR بالـSnapshot الأصلي → عكس FX الأصلي → **لا لمس Revenue** → توليد Customer Credit عند الحاجة → Audit/Outbox → `reversed` flag يمنع العكس المزدوج.
- **الدفعة غير المخصّصة/Overpayment** تولّد `customer_credits` تلقائيًا (كيان كامل في Data Model §7ب مع customer_credit_allocations).

### 5. أمثلة العكس الثلاثة — موثقة بقيود متوازنة
- **A (GOLD-65):** فاتورة 1000 + دفعة 300 خاطئة → `Dr AR 300 / Cr 2210 300`؛ AR يعود 1000؛ Revenue لم يُمسّ.
- **B (GOLD-66):** دفعة 500 (A=300، B=200)؛ عكس B فقط → A دون تغيير، B يُعاد فتحه 200، لا عكس مزدوج.
- **C (GOLD-67):** عكس التخصيص متعدد العملات بـSnapshots الأصلية: `Dr AR 1440، Dr 4900 40 / Cr 2210 1480` (1480=1480 ✓) — ممنوع إعادة الحساب بسعر اليوم؛ الرد اللاحق (350 EUR @4.20 = 1470) تسوية مستقلة `Dr 2210 1480 / Cr Bank 1470 / Cr 4900 10` — **Reversal FX وRefund settlement FX حدثان منفصلان**.

### 6. Customer Credit Model — مكتمل
يدعم: Overpayment تلقائي، رصيد من reversal، manual opening مستقبلي بصلاحية موثقة، allocation على فاتورة مستقبلية (`Dr 2210 / Cr AR`)، Refund، تعدد عملات (عملة المصدر + carrying base)، remaining بقفل FOR UPDATE، Audit، **ممنوع balance mutation يدوي** (INV-ACC-16).

### 7. Negative Inventory — Partial Replenishment
**Negative Deficit Layers** (Inventory §5أ): كل بيع سالب = Deficit Layer موثّق بـprovisional snapshot؛ الاستلامات تغطي العجز **FIFO حتمي** بربط صريح (`negative_deficit_coverages`)، وكل تغطية لها catch-up الخاص بها، والعجز المتبقي يحتفظ بسنابشوته. المثال الملزم (GOLD-72): ‎−10@100 → استلام 4@120 (catch-up 80) ثم 6@130 (catch-up 180) → qty=0، GL=0=valuation، COGS الكلي = 1260 = 4×120+6×130 ✓.

### 8+9. تنظيف التوثيق
- CORR-U في المصفوفة يطابق الآن المعمارية النهائية (per-table UNIQUE بأعمدة حقيقية) — لا تناقض مع HARD-16/19.
- Data Model §19 وتقارير الجولات السابقة: قائمة القرارات المفتوحة دقيقة حرفيًا (OD-01/05/12 مغلقة ولا تُذكر كمفتوحة).

### 10. Supplier Multi-Currency Mirror — مثال محسوب (Accounting §9.3)
`supplier_refunds` بنفس فصل الجانبين صراحة. Base ILS، Supplier Credit 100 USD (دفتري 360)، استلام 90 EUR @4.10: `Dr Bank 369 / Cr 1150 360 / Cr 4900 9` (369=369 ✓)؛ remaining_credit = **0 USD** (GOLD-73).

## 2. Review H — Financial Source Semantics: **PASS**

| الكيان | SoT | الحالة | القيد | العملة | العكس | Idempotency |
|---|---|---|---|---|---|---|
| Payment | payments + allocations | active/reversed جزئيًا | Dr posting_account / Cr AR أو Cr 2210 (فائض) | ثلاثية العملات بسنابشوت | عبر reverse_payment_allocation فقط | UNIQUE(business_id, idempotency_key) |
| Payment Allocation | payment_allocations | active/reversed (flag) | جزء من قيد الدفعة | سنابشوت تاريخي مجمّد | يُعكس بسنابشوته الأصلي مرة واحدة | ضمن الدفعة |
| Payment Reversal | قيد عكسي + customer_credit | — | Dr AR، Dr 4900/6900 / Cr 2210 | بسنابشوت الأصل — ممنوع سعر اليوم | لا يُعكس (حدث نهائي؛ التصحيح بأمر جديد) | قيد مصدري append-only |
| Customer Credit | customer_credits.remaining | open/partially_used/exhausted/cancelled | توليد: Cr 2210؛ تخصيص: Dr 2210/Cr AR | عملة مصدر + carrying base | إلغاء بأمر مجال موثّق | FOR UPDATE على remaining |
| Credit Note | credit_notes.remaining_refundable | open/partially_refunded/exhausted | Dr Returns/Tax / Cr 2200 (+Cr AR آجل) | عملة الفاتورة + دفتري | لا عكس — مستند مالي نهائي | FOR UPDATE |
| Refund | refunds (مصدر Typed واحد) | pending/completed/failed | Dr 2200/2210 بالدفتري / Cr النقد؛ فرق → 4900/6900 | جانبا مصدر/تسليم صريحان | لا عكس مباشر — تصحيح بكيان جديد | UNIQUE(business_id, idempotency_key) |
| Supplier Credit | supplier_credit_notes.remaining_credit | نفس دورة Customer Credit | Dr 1150 | نفس فصل الجانبين | كـCustomer Credit | FOR UPDATE |
| Supplier Refund | supplier_refunds | كـRefund | Dr نقد / Cr 1150 بالدفتري؛ فرق → 4900/6900 | نفس فصل الجانبين | كـRefund | UNIQUE(business_id, idempotency_key) |

لا كيانان يؤديان الوظيفة نفسها: Credit Note = عكس إيراد/استحقاق مرتجع؛ Customer Credit = التزام نقدي دائن؛ Payment Reversal ≠ Refund (يفصل AR عن النقد)؛ Supplier Credit = مرآة العميل باتجاه معاكس.

## 3. Review I — Pseudo-Schema Lint: **PASS**

فُحصت كل الـblocks في DATA_MODEL/ACCOUNTING/INVENTORY/WHATSAPP/TRANSACTION_MAP:
- كل عمود داخل UNIQUE موجود في تعريف جدوله (idempotency_key/offline_local_id/sequence_key/event_source/external_event_id — كلها معرّفة، وبـNOT NULL حيث تلزم).
- كل FK بأعمدة موجودة، وكل FK في النواة المالية مركّب بـbusiness_id.
- كل CHECK على أعمدة نفس الصف (XOR القيد، outstanding=total−paid، مصدر الاسترداد الواحد).
- **لا قرار Schema مهم مؤجلًا إلى Migration** — Typed FKs محسومة.
- الحقول المستخدمة في اختبارات GOLD-50..74 كلها معرّفة في الـModel.

## 4. المجالات الحاكمة بعد الإغلاق

Refunds ✓ (مصدران Typed بلا غموض) · Payment Reversal ✓ (AR/FX/Isolation محسومة) · Customer/Supplier Credit ✓ · Negative Inventory ✓ (Deficit Layers FIFO) · Schema Executability ✓ · Data Integrity ✓.

**لا تعارض معروف متبقٍ.**

## 5. إيقاف

توقف كامل بعد هذا التقرير وتحديث Acceptance Report. **لا Phase 1، لا Coding، لا Migrations** حتى أمر جديد من المالك.

---

# ملحق — TRUE FINAL CLOSURE (Pass #5)

> خمس نقاط إغلاق نهائية + 14 اختبارًا (GOLD-75..88) + Review J/K. بلا توسع Scope.

## 1. كيانات العجز في Data Model — أُضيفت فعليًا
`negative_inventory_deficits` (CHECKs الثلاثة: original>0، uncovered≥0، uncovered≤original) + `negative_deficit_coverages` (CHECK qty>0) مع Composite FKs بـbusiness_id، **FIFO حتمي بـ`deficit_seq` الرسمي ثم id** (لا timestamp وحده)، ذرّية كاملة داخل معاملة الاستلام (uncovered_qty + coverage + حركة + قيد catch-up معًا بـFOR UPDATE)، وIndex `(business_id, warehouse_id, variant_id, status, deficit_seq)` (§10ب).

## 2. Carrying Value على كل مصدر مالي — محسوم (§7ج)
`customer_credits` / `credit_notes` / `supplier_credit_notes` كلها تحمل الآن: original/remaining بعملة المصدر **+ original/remaining_carrying_base + rate snapshot**. **قاعدة الاستهلاك الجزئي:** تحرير تناسبي من السنابشوت الأصلي للعمليات غير الأخيرة؛ **الأخير يحرّر remaining_carrying_base بالكامل** — بلا rounding drift. **INV-ACC-17:** استنفاد المصدر ⇒ الطرفان = 0 بالضبط معًا؛ يُقفلان ويُحدَّثان معًا في نفس المعاملة.

## 3. GOLD-67 FX — صُحّح
الخطأ السابق (370 EUR تُرد كـ350) أُزيل. الصحيح: **A)** رد كامل بنفس العملة: 370 EUR @4.20 = نقد 1554 → `Dr 2210 1480، Dr 6900 74 / Cr Bank 1554` (1554=1554 ✓) — مبلغ المصدر بعملته ثابت. **B)** جزئي 350 EUR: تحرير تناسبي 1400 → يتبقى **20 EUR + 80 ILS**. **C)** عابر العملات بـUSD بسعر الاسترداد. حُدّثت Accounting §5.2-C وGOLD-67/70/71 وGOLD-81/82/83.

## 4+5. Payment State Machine + payment_reversal
- أُزيل `completed → refunded_partially | refunded` — Raw Payment ليس مصدر Refund. حالات التنفيذ: pending→completed/failed، وcompleted→reversed عبر `payment_reversal` فقط. **حالة التخصيص مشتقة منفصلة** (unallocated/partially/fully_allocated)؛ Allocation: active→reversed؛ "تم الاسترداد" حالة عرض مشتقة فقط (GOLD-88).
- **`payment_reversal` ≠ `reverse_payment_allocation`:** الأول للمال الذاهب (chargeback/شيك مرتجع/تحويل معكوس): يعكس Allocations ذرّيًا بالسنابشوتات + يعيد فتح AR + **يعكس أصل النقد** (Cash/Bank/Clearing) + reason/provider_reference + Idempotent — بلا لمس Revenue (§5.2ب، GOLD-87). الثاني: المال باقٍ → Customer Credit (GOLD-86). INV-ACC-18.

## Review J — Cross-Document Entity Existence: **PASS**
كل جدول مذكور في Accounting/Inventory/TransactionMap/StateMachines/Golden موجود في DATA_MODEL (بما فيها negative_inventory_deficits/coverages وcustomer_credits وsupplier_credit_notes وinvoice_sequences) أو موسوم صراحة: Domain Commands (void_invoice, reverse_payment_allocation, payment_reversal, checkout) / Read Model (stock_levels) / Value Object (Money). لا جدول persistent في النثر فقط. وُحّدت تسمية accounts/journal_entries/journal_lines.

## Review K — Money Movement Semantics: **PASS**

| الحدث | مال فعلي تحرّك؟ | AR؟ | Revenue؟ | Customer Credit؟ | FX المستخدم | قابل للعكس؟ | Idempotent؟ |
|---|---|---|---|---|---|---|---|
| Payment (تخصيص) | داخل (Cash/Bank/Clearing) | يخفض | لا | فائض فقط → 2210 | سنابشوت التخصيص الثلاثي | عبر reverse_payment_allocation فقط | UNIQUE(business_id, idempotency_key) |
| Payment Allocation | لا (جزء من قيد الدفعة) | يخفض بالحصة | لا | لا | سنابشوت تاريخي مجمّد | نعم — مرة واحدة (reversed flag) | ضمن الدفعة |
| reverse_payment_allocation | **لا — المال باقٍ** | يعيد فتحه | لا | ينشئ رصيدًا | سنابشوت التخصيص الأصلي | نهائي (التصحيح بأمر جديد) | قيد مصدري append-only |
| payment_reversal | **خارج — الأصل يُعكس** | يعيد فتحه عند التخصيص | لا | يلغي الرصيد القائم | سنابشوت أصلي | نهائي | provider_reference |
| Customer Credit | لا (التزام) | يخفض عند التخصيص على فاتورة | لا | هو نفسه | سنابشوت التوليد + تسوية مستقلة عند الرد | إلغاء بأمر موثّق | FOR UPDATE |
| Credit Note | لا (عكس إيراد/التزام) | يخفض (آجلة) | **يعكسه — الوحيد مع Sale** | قد يولّد 2200 | سنابشوت الفاتورة | نهائي | UNIQUE على الترقيم |
| Refund | خارج (نقد للعميل) | **لا يلمسه** | لا | يستهلك 2210 (إن مصدره) | تسوية مستقلة وقت الرد | نهائي | UNIQUE(business_id, idempotency_key) |

لا تداخل غامض: Sale/CreditNote وحدهما يلمسان Revenue؛ Refund وحده يُخرج المال للعميل؛ payment_reversal وحده يعكس أصل التحصيل؛ reverse_payment_allocation وحده يحوّل دفعة إلى رصيد.

## النتيجة
المجالات الحاكمة كلها متطابقة عبر Data Model ↔ Inventory ↔ Accounting ↔ State Machines ↔ Golden Suite. **لا تعارض معروف متبقٍ.**
