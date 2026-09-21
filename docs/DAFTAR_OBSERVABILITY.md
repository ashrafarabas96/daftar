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
