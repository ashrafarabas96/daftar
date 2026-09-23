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

## 9أ. Journal Entry (قيد اليومية) — P2-S4

```
posted
```

لا آلة حالات هنا، وهذا مقصود: للقيد حالة واحدة فقط هي `posted`. لا مسودة، ولا ملغى، ولا معكوس. العكس **قيد جديد** (`source_type='reversal'`) يُبنى من القيد الأصلي المحفوظ، والقيد الأصلي لا يُلمس ولا يحمل أي عمود يدل على أنه عُكِس. راجع AL-12.

## 9ب. Opening Balance (الرصيد الافتتاحي) — P2-S4, AL-13

```
draft → posted → superseded
  │
  └→ (discarded: حذف فعلي، مسموح فقط ما دام draft ولا يوجد قيد مرتبط)
```

- `posted` نهائي من حيث الأرقام: بعد الترحيل تُصبح السطور والتاريخ ومُعرِّف القيد غير قابلة للتعديل، و`status` هو العمود الوحيد القابل للتغيير.
- `posted → superseded` هو الانتقال الوحيد المسموح، ويُرفض إلا إذا كان قيد اليومية الخاص بالرصيد الافتتاحي قد **عُكِس** فعلًا (`accounting.supersede_without_reversal`). القاعدة مفروضة في قاعدة البيانات لا في الطبقة التطبيقية.
- `superseded` حالة نهائية: لا عودة إلى `posted` ولا إلى `draft`.
- الاستبدال = عكس ← إحلال ← مجموعة جديدة. لا تعديل ولا حذف لمجموعة مُرحَّلة.
- مجموعة واحدة فقط بحالة `posted` لكل نشاط تجاري، مفروضة بفهرس فريد جزئي.
- إعادة إرسال نفس `Idempotency-Key` على مجموعة مُرحَّلة **ليست انتقال حالة**: إن كانت الحمولة المالية نفسها يُعاد القيد نفسه بـ`created=false` دون أي كتابة جديدة، وإن اختلفت جوهريًا تُرفض بـ`accounting.idempotency_conflict`. لا يُعاد تشكيل المصدر المحفوظ ليطابق الطلب الأحدث في أي من الحالتين (P2-S4 §19).

## 9ج. Accounting Period (الفترة المحاسبية) — P2-S6, AL-14

```
(لا وجود) → open ⇄ closed
```

- الحالتان هما `open` و`closed` فقط. لا حالة ثالثة ولا مسودة ولا أرشفة؛ المفردات مغلقة بـ CHECK في قاعدة البيانات.
- **لا توجد فترات إلا إذا أنشأها التاجر.** الترحيل `0049` لا ينشئ أي فترة لأي منشأة، ولا يخترع تقويمًا ماليًا. المنشأة التي لا فترات لها تبقى على قواعد الترحيل نفسها تمامًا، وأول فترة ينشئها هي ما يُفعّل إدارة الفترات.
- `open → closed` يستلزم منفّذًا ولحظة، و`closed → open` يستلزم منفّذًا ولحظة **وسببًا نصيًا إلزاميًا** (من 1 إلى 500 حرفًا بعد التشذيب). السبب يُسجّل في أثر التدقيق ولا يُنشر في صندوق الصادر.
- **لا يوجد مسار حذف، ولا تتحرّك حدود الفترة أبدًا.** `start_date` و`end_date` والهوية غير قابلة للتعديل، و`status` ومرافقاته هي الوحيدة القابلة للتغيير. القاعدتان مفروضتان بمُشغّلات غير مشروطة **بلا استثناء لأي هوية**، فحتى مالك المخطط يُرفض.
- الفترات لا تتداخل: قيد `EXCLUDE USING gist` حقيقي في قاعدة البيانات، لا قاعدة يحرسها التطبيق. والفجوة تُرفض بـ `accounting.period_not_contiguous` ولا تُملأ تلقائيًا.
- إعادة إرسال نفس `Idempotency-Key` **ليست انتقال حالة**: سجل العمليات يُستشار قبل قراءة أي حالة، فيُعاد الناتج الأصلي بـ `changed=false` دون أي كتابة أو تدقيق أو نشر ثانٍ، وإن اختلفت الحمولة تُرفض بـ `accounting.idempotency_conflict`. وهذا تحديدًا ما يجعل إعادة فتح قديمة تصل بعد إغلاق لاحق لا تفتح الفترة من جديد.
- أثر الحالة على الترحيل: أي قيد جديد تاريخه داخل فترة `closed` يُرفض بـ `accounting.period_closed`، وخارج كل الفترات يُرفض بـ `accounting.period_missing_for_date` — والرفض في قاعدة البيانات عبر مُشغّل `BEFORE INSERT` على `journal_entries`، فيشمل كل كاتب بما في ذلك الإدراج المباشر.
- قاعدة منع التاريخ المستقبلي لم تُرخّص: `entry_date ≤ اليوم` بتوقيت المنشأة يبقى ساريًا **داخل الفترة المفتوحة** أيضًا. الفترة تضيّق ما يُرحّل ولا توسّعه أبدًا.
- **استثناء واحد فقط — الرصيد الافتتاحي السابق للدفاتر.** القيد من نوع `opening_balance` المؤرَّخ **قبل بداية أقدم فترة تمامًا** يُقبل بلا فترة تغطّيه، لأن الرصيد الافتتاحي سابق لبداية الدفاتر بطبيعته. لولا هذا الاستثناء لصار الحكم على الحقيقة المحاسبية نفسها مرهونًا بترتيب التهيئة: يُقبل الرصيد إن أُدخل قبل إنشاء أول فترة، ويُرفض إن أُدخل بعدها. والاستثناء محدود من كل جانب: المقارنة «أصغر من» تمامًا فتبقى بداية أقدم فترة خاضعة لقاعدة التغطية العادية؛ وإن وقع التاريخ داخل فترة **مغلقة** فالرفض `accounting.period_closed` كأي قيد آخر؛ وإن وقع بعد سلسلة الفترات فالرفض `accounting.period_missing_for_date`؛ وقاعدة منع المستقبل تبقى سارية؛ ولا يملك هذا الاستثناء أي مصدر آخر، فالتسوية اليدوية والعكس يُرفضان قبل أقدم فترة.

## 10. قواعد عامة

1. كل انتقال حالة يُسجَّل في AuditEvent (من → إلى، من نفّذ، متى، سبب عند اللزوم).
2. الانتقالات التي لها أثر مالي تتم داخل معاملة الحدث نفسها (انظر DAFTAR_TRANSACTION_MAP).
3. الواجهة تعرض الحالات بمصطلحات تاجر بسيطة ("مدفوع"، "متأخر"، "قيد التجهيز") — الترجمات المعتمدة في Localization Glossary.
