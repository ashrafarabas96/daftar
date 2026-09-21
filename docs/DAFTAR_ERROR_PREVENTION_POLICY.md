# DAFTAR — Error Prevention Policy / سياسة منع الأخطاء

## 1. العقيدة

نمنع الأخطاء **قبل** وصولها للمستخدم، لا نكتفي بإصلاحها بعد الشكوى (Master §150). لا يوجد "تقريبًا انتهينا" — PASS أو FAIL (Master §74).

## 2. Bug Lifecycle الإلزامي (Master §63)

1. Reproduce
2. Document
3. Find root cause
4. **Add failing automated test**
5. Impact analysis (CHANGELOG_IMPACT)
6. Minimal safe fix
7. Targeted tests
8. Domain regression
9. Golden Regression
10. Security/data review
11. Review diff
12. Merge only when clean

## 3. قواعد صارمة

- **لا Patch بدون Root Cause** (Master §64): ممنوع Quick Fix لخطأ غير مفهوم السبب.
- **Regression forever** (Master §65): أي خطأ مرة = اختبار دائم.
- **لا تراكم أخطاء** (Master §66): كل Phase تنتهي نظيفة.
- **Bug Budget** (Master §67–69): نهاية كل Phase — P0=0، P1=0، وP2=0 للمحاسبة/المخزون/الأمان/عزل المستأجرين/سلامة البيانات/Core Flows. فقط P3/P4 تجميلية موثقة قد تُؤجَّل دون مساس بـUX الأساسي أو الوصولية أو البيانات.
- **No Silent Failure / No Swallowed Exceptions** (Master §70–71).
- **لا 90% Done** (Master §94): Feature لا تُقبل إلا باستيفاء Definition of Done كاملًا (Master §93).

## 4. التصنيف

| الأولوية | التعريف | القاعدة |
|---|---|---|
| P0 | فقدان/فساد بيانات، خرق أمني أو عزل مستأجرين، توقف Core Flow | إصلاح فوري؛ يوقف كل شيء |
| P1 | Core Flow مكسور دون فقدان بيانات | قبل أي شيء آخر |
| P2 | محاسبة/مخزون/أمان/عزل/سلامة بيانات/Core Flows | = 0 قبل نهاية Phase |
| P3/P4 | تجميلي ثانوي لا يمس UX الأساسي/الوصولية/البيانات | توثيق + جدولة |

## 5. Incident Handling (Master §149)

أي Incident بأثر مالي: تجميد العملية المتأثرة عند اللزوم → تحديد النطاق → حماية البيانات → Root cause → Repair بأدوات رسمية → Reconcile → Regression test → Postmortem موثّق.

## 6. Technical Debt

سجل `TECHNICAL_DEBT.md` في جذر المشروع. **ممنوع** تسجيل: فساد محاسبي، مشكلة أمنية، مشكلة سلامة بيانات كدَين لاحق — تُصلح فورًا (Master §137).
