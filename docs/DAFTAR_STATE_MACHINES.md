# DAFTAR — State Machines / آلات الحالات

> **قاعدة:** ممنوع Status Strings عشوائية. كل كيان له قائمة حالات مغلقة وانتقالات موثّقة. أي انتقال غير مدرج هنا **مرفوع تلقائيًا**.

## 1. Order (طلب المتجر الإلكتروني)

```
pending_review → confirmed → preparing → shipped → delivered → completed
      │              │
      ▼              ▼
   cancelled      cancelled (قبل الشحن)
delivered → return_requested → returned (جزئي/كلي عبر Return منفصل)
```
- cancelled يتطلب سببًا. لا رجوع من completed/returned إلا عبر عمليات Return/Refund الرسمية.

## 2. Invoice (الفاتورة) — v2 (J)

```
open → partially_paid → paid
  │
  └──→ voided   ← من open فقط (لا مدفوعات فعّالة)، بقيد عكسي + سبب
```
- **ممنوع الانتقال المباشر paid/partially_paid → voided.** الفاتورة التي عليها Allocations فعّالة لا تُلغى إلا عبر **Compound Domain Command ذرّي `void_invoice`**: عكس/استرداد الدفعات أولًا → ثم قيد عكسي للفاتورة + حركات مخزون عكسية — كلها في معاملة واحدة (Accounting Rules §7). النتيجة: لا أرصدة عملاء ولا نقدية غير متسقة.
- الانتقالات العادية مدفوعة فقط بـAllocations الدفعات — لا تعديل يدوي للحالة.

## 3. Payment (الدفعة) — v5 (محسوم مع Refund Source Model)

**الدفعة تمثل حقيقة استلام المال. حالات التنفيذ فقط:**

```
pending → completed → partially_reversed → reversed
   │
   ▼
 failed
```
- الانتقال إلى `partially_reversed`/`reversed` يحدث **فقط عبر `payment_reversal`** (المال ذهب: chargeback/شيك مرتجع/تحويل معكوس — §3أ) ويُشتق من Σ payment_reversals مقابل مبلغ الدفعة: عكس جزئي → partially_reversed؛ كامل → reversed.
- completed فقط (وما لم يُعكس منها) تؤثر على الذمم. failed لا تلمس أي رصيد.
- **ممنوع** الانتقالان `completed → refunded_partially | refunded` — **Raw Payment ليس مصدر Refund** (Accounting §5). الاسترداد كيان مستقل (Refund) مصدره `credit_note` أو `customer_credit` فقط.
- **حالة التخصيص مشتقة ومنفصلة عن حالة الدفعة:** Payment يبقى `completed` بينما تُشتق حالته التخصيصية: `unallocated | partially_allocated | fully_allocated` (من Σallocations النشطة) — ليست حالة مالية على Payment.
- **Payment Allocation:** `active → partially_reversed → reversed` (تُشتق من Σ reverse_payment_allocation + payment_reversal_allocations؛ ممنوع تجاوز المبلغ الأصلي).
- **حالة العرض للواجهة:** "تم استرداد المبلغ" حالة **مشتقة للعرض** من علاقات Refund/Customer Credit — ليست Financial State Transition على Payment.

## 3أ. payment_reversal مقابل reverse_payment_allocation — الفرق الجوهري (Pass#5)

| | reverse_payment_allocation | payment_reversal |
|---|---|---|
| **المال** | ما زال لدى النشاط → يتحول **Customer Credit (2210)** | ذهب/أُبطل التحصيل (chargeback، شيك مرتجع، تحويل معكوس) |
| **القيد** | Dr AR (+عكس FX) / Cr 2210 | يعكس أصل النقد نفسه: Dr AR (+عكس FX) / Cr Cash/Bank/Clearing |
| **الأصل النقدي** | لا يُلمس | **يُعكس** |
| **السبب** | خطأ تخصيص/قرار تجاري | فشل/إبطال من Provider بمرجع |

`payment_reversal` (Domain Command ذرّي، Idempotent بـprovider_reference، Audited بسبب إلزامي): قفل Payment+Allocations → إن كانت allocated يعكسها ذرّيًا ويعيد فتح AR بالـSnapshots الأصلية ويعكس FX المحقق الأصلي → يعكس أصل النقد (Cash/Bank/Clearing حسب posting_account) → **لا يلمس Revenue** → Payment.status = reversed. إن كانت الدفعة غير مخصّصة (Customer Credit قائم): يُستهلك/يُلغى الرصيد ذرّيًا ضمن نفس المعاملة. لا تنفيذ Integrations الآن — المفهوم محسوم معماريًا.

## 4. Installment (القسط)

```
pending → due → partially_paid → paid
            └────────→ late (يوميًا عبر Job عند تجاوز due_date)
late → partially_paid → paid
```
- `due` = تاريخ الاستحقاق وصل ولم يُسدَّد بالكامل. التنبيهات تُبنى على due/late.

## 5. InstallmentPlan

```
active → completed   (كل الأقساط paid)
active → cancelled   (مع عكس الذمة المتبقية عبر Credit Note عند اللزوم)
```

## 6. Subscription (الاشتراك)

```
trialing → active → past_due → active
   │          │        │
   │          ▼        ▼
   │       cancelled  suspended (بعد grace period)
   ▼
 expired
```
- suspended يقيّد الاستحقاقات تدريجيًا دون فقدان بيانات (Master §121).

## 7. WhatsAppMessage

```
queued → sending → sent → delivered → read
   │         │
   │         └→ failed (retry ≤ N مع backoff) → dead_lettered (+Alert)
   └→ cancelled
```
- كل رسالة لها idempotency_key؛ الويبهوكات المكررة تُتجاهل بأمان.

## 8. Sync Operation (مزامنة Offline)

```
local_pending → syncing → synced
     │             │
     │             └→ failed → needs_attention (تدخل المستخدم: تعارض/مخزون نافد)
     └→ cancelled_by_user (قبل الإرسال فقط)
```
- لا حذف للعملية المحلية قبل synced مؤكد من الخادم.

## 9. Sale

```
draft → completed → voided (عكسي موثّق)
completed → (returned_partially | returned_fully) — عبر كيان Return منفصل، حالة Sale الأصلية مشتقة للعرض فقط
```

## 10. قواعد عامة

1. كل انتقال حالة يُسجَّل في AuditEvent (من → إلى، من نفّذ، متى، سبب عند اللزوم).
2. الانتقالات التي لها أثر مالي تتم داخل معاملة الحدث نفسها (انظر DAFTAR_TRANSACTION_MAP).
3. الواجهة تعرض الحالات بمصطلحات تاجر بسيطة ("مدفوع"، "متأخر"، "قيد التجهيز") — الترجمات المعتمدة في Localization Glossary.
