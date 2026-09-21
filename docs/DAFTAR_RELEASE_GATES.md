# DAFTAR — Release & Phase Gates / بوابات المراحل والإصدارات

> PASS أو FAIL — لا يوجد "تقريبًا" (Master §74). كل Phase تمر بـ**ثلاث مراجعات مستقلة** (Master §142): A — الوظائف وسلامة البيانات، B — الأمان والمعمارية والرجوع، C — UX والجودة البصرية والتعريب. فشل أي مراجعة = Phase FAIL.

## 1. بوابة كل Phase (Checklist موحّدة)

| البوابة | معيار PASS |
|---|---|
| Functional (§75) | كل المتطلبات المخططة تعمل؛ 0 أزرار بلا وظيفة؛ 0 placeholders؛ لا حالات ناقصة |
| Data (§76) | علاقات وConstraints صحيحة؛ Migrations آمنة (Expand/Migrate/Contract)؛ 0 Data loss |
| Accounting (§77) | قيود متوازنة؛ أرصدة صحيحة؛ Payment/Refund صحيحان؛ Invariants خضراء |
| Inventory (§78) | Movements صحيحة؛ Reservations سليمة؛ البيع المتزامن آمن |
| Security (§79) | Tenant isolation مُثبت؛ صلاحيات صحيحة؛ لا secrets؛ Input validation شامل |
| UX (§80) | المهام سهلة؛ خطوات منطقية (Simplicity Standard)؛ رسائل واضحة؛ لا ازدحام |
| Design (§81) | التزام كامل بـDesign System والهوية المرجعية |
| Localization (§82) | ar/en/tr سليمة؛ لا مفاتيح ناقصة؛ RTL/LTR مختبران |
| Responsive (§83) | Phone/Tablet/Desktop |
| Performance (§84) | لا استعلامات بطيئة جديدة؛ لا N+1؛ لا API calls زائدة |
| Regression (§85) | Golden Suite خضراء كاملة |

## 2. Bug Budget عند البوابة (Master §67–69)

P0=0 · P1=0 · P2=0 لـ(Accounting/Inventory/Security/Tenant isolation/Data integrity/Core Flows). فقط P3/P4 تجميلية موثقة قد تبقى.

## 3. بوابة الإصدار (Release Checklist — Master §109)

قبل Production: P0/P1/Core-P2 = 0؛ Migrations مفحوصة؛ Backup مؤكد؛ Rollback جاهز؛ Monitoring حي؛ Regression ناجح؛ Localization ناجح؛ Storefront/Android/Web ناجحة.

## 4. بوابات ما قبل الإطلاق النهائي

1. **SIMPLICITY AUDIT** (Master §167).
2. **PREMIUM EXPERIENCE AUDIT** مقابل الصور المرجعية (§168).
3. **FINANCIAL & DATA INTEGRITY AUDIT**: Ledger/Invoices/Payments/Receivables/Installments/Inventory/Returns/Refunds/FX/Reports (§169).
4. **Final Golden Regression** (§170).
5. **Known Defects = 0** للحرجة/العالية-الأساسية/المالية/العزل/فقدان البيانات (§171).

## 5. قرارات البوابة

- القرار موثّق في Acceptance Report لكل Phase: PASS/FAIL + أدلة (روابط نتائج اختبارات، تقارير مراجعات A/B/C).
- عند FAIL: تُصلح المشكلات ثم يُعاد التقرير — لا انتقال بأعذار.
