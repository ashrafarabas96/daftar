# DAFTAR — Observability / قابلية المراقبة

## 1. الركائز

- **Logs**: structured (JSON) مع request_id / correlation_id / tenant_id / user_id؛ لا أسرار ولا بيانات حساسة في السجلات (redaction).
- **Metrics**: معدلات الطلبات، الأخطاء، زمن الاستجابة (p50/p95/p99)، عمق الطوابير، فشل Jobs، استخدام DB/Redis.
- **Traces**: تتبع موزّع للعمليات الحرجة؛ المسار الذهبي: Voice → API → Sale → Journal → Stock → Notification → WhatsApp (Master §73).

## 2. المعرّفات الإلزامية (Master §72)

| المعرف | النطاق |
|---|---|
| request_id | كل طلب HTTP |
| correlation_id | عبر الخدمات/الطوابير لنفس العملية |
| business_transaction_id | كل معاملة مالية (يربط Sale/Invoice/Payment/Journal/Stock/WhatsApp) |
| idempotency_key | العمليات القابلة للتكرار |

## 3. التنبيهات (Alerts)

| الشرط | الإجراء |
|---|---|
| فشل Job حرج بعد استنفاد retries | Alert فوري + dead-letter queue مرئي |
| Reconciliation يجد اختلافًا (محاسبة/مخزون) | Alert + سجل — **لا تصحيح صامت** (Master §46) |
| فشل Backup | Alert فوري |
| معدل أخطاء API/زمن استجابة فوق العتبة | Alert |
| محاولات Cross-tenant مرفوضة متكررة | Alert أمني |
| WhatsApp provider down | Alert + حالة واضحة في إعدادات التاجر |

## 4. لوحات المراقبة الداخلية

- صحة النظام (لـSuper Admin — كما في الهوية: "حالة النظام: ممتازة، وقت التشغيل 99.98%").
- قائمة Failed/Dead-lettered Jobs مع إعادة تشغيل آمنة.
- تقارير Reconciliation الدورية.

## 5. قواعد

1. **No Silent Failure**: أي Worker/Job مهم له status/retry/dead-letter/alert (Master §70).
2. **No Swallowed Exceptions**: ممنوع Empty Catch في Core Logic (Master §71).
3. كل تنبيه قابل للفعل: ماذا حدث، أين، وما الخطوة التالية.

## 6. مقاييس المطابقة المحاسبية (P2-S8)

دورة المطابقة اليومية تُصدر خمسة مقاييس، وكلها تصف **نوعًا** لا **قيمة**:

| المقياس | النوع | الوسوم (labels) |
|---|---|---|
| `accounting_reconciliation_run_total` | عدّاد | `outcome`: `complete` أو `incomplete` |
| `accounting_reconciliation_duration_ms` | قياس | بلا وسوم |
| `accounting_reconciliation_discrepancy_total` | عدّاد | `check`: معرّف الفحص (`R-ACC-01` … `R-ACC-09`) |
| `accounting_reconciliation_unavailable_total` | عدّاد | `check`: معرّف الفحص |
| `accounting_outbox_lag_seconds` | قياس | بلا وسوم — تأخّر أقدم رسالة غير مُسلَّمة |

**القاعدة التي يفرضها الكود لا العُرف.** `assertSafeLabels` في `apps/api/src/infra/metrics.ts` ترفض — وقت التشغيل — أي وسم اسمه معرّف أو قيمة مالية (`business_id`، `tenant_id`، `entry_id`، `account_id`، `user_id`، `amount`، `balance`، `debit`، `credit`، `rate`، `fingerprint`، `secret`، …)، وترفض أي قيمة وسم لا تبدو كنوع محدود. السبب شقّان: وسم بمعرّف عمل يعني عدد سلاسل زمنية غير محدود، ويعني أيضًا أن نقطة المقاييس تكشف أي أعمال موجودة.

**التنقيح يُختبر بالقيم لا بالمفاتيح.** `tests/security/accounting-observability-redaction.test.ts` يزرع قيمًا خافرة (sentinels) — مبلغًا، ورصيدًا، ومعرّف عمل، وسرًّا — ثم يبحث عنها في كل سطر سجلّ وكل مقياس صادر. البحث عن أسماء المفاتيح وحده يمرّ على سجلّ يطبع القيمة بمفتاح آخر.

**`unavailable` ليست نجاحًا.** دورة لم تستطع أن تنظر تُعدّ `incomplete`، ويُزاد لها `accounting_reconciliation_unavailable_total`، ولا تُحسب أبدًا كدورة نظيفة. التنبيه على هذا المقياس إلزامي: صمته يعني أن أحدًا لم ينظر، لا أن كل شيء سليم.

**ما لا يُصلَح تلقائيًا.** المطابقة **تكتشف ولا تُصلح** (Master §46): المبدأ الذي يشغّلها لا يملك أي صلاحية كتابة في أي جدول، فالتصحيح الصامت مرفوض في قاعدة البيانات قبل أن يكون مرفوضًا في الكود.
