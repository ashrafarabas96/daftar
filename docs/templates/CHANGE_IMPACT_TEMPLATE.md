# CHANGE IMPACT — [عنوان التغيير]

> يُستخدم لكل تعديل جوهري على Core Feature (Master §61). يُملأ **قبل** أي كود. لا يسمح بإصلاح شاشة وكسر ثلاث عمليات خلفها (Master §62).

## 1. المعلومات

- التاريخ: 
- المقدّم: 
- مرجع الـPR/المهمة: 
- الأولوية: 

## 2. سبب التغيير

(لماذا الآن؟ ما المشكلة أو الفرصة؟)

## 3. الوحدات المتأثرة (Modules)

- [ ] Sales  - [ ] Payments  - [ ] Receivables  - [ ] Installments
- [ ] Inventory  - [ ] Accounting  - [ ] Catalog  - [ ] Customers
- [ ] Orders/Storefront  - [ ] Purchases  - [ ] Expenses
- [ ] WhatsApp  - [ ] AI  - [ ] Notifications  - [ ] Analytics
- [ ] Subscriptions/Entitlements  - [ ] Identity/Security  - [ ] Audit

## 4. تحليل الأثر

| البُعد | الأثر | التفاصيل |
|---|---|---|
| Accounting | ☐ نعم ☐ لا | هل تتغير قيود؟ Invariants متأثرة؟ |
| Inventory | ☐ نعم ☐ لا | حركات/حجوزات/تكلفة؟ |
| Data/Database | ☐ نعم ☐ لا | Migration؟ Expand/Migrate/Contract؟ Constraints؟ |
| API | ☐ نعم ☐ لا | كسر Backward Compatibility لأندرويد المنشور؟ |
| AI | ☐ نعم ☐ لا | نية/أداة/Schema جديد؟ |
| WhatsApp | ☐ نعم ☐ لا | قالب/حدث جديد؟ |
| Store | ☐ نعم ☐ لا | واجهة عامة/Checkout؟ |
| Subscription | ☐ نعم ☐ لا | Entitlement جديد؟ حدود؟ |
| Mobile | ☐ نعم ☐ لا | Offline sync؟ تخزين محلي؟ |
| Web | ☐ نعم ☐ لا | — |
| Security | ☐ نعم ☐ لا | صلاحيات/عزل/مدخلات جديدة؟ Threats جديدة؟ |
| Localization | ☐ نعم ☐ لا | مفاتيح جديدة باللغات الثلاث؟ RTL/LTR؟ |
| Design System | ☐ نعم ☐ لا | Tokens جديدة؟ خروج عن النظام (يحتاج Design Review)؟ |
| Performance | ☐ نعم ☐ لا | استعلامات/N+1/حجم payload؟ |

## 5. الاختبارات المطلوبة

- Unit: 
- Integration: 
- Golden Regression متأثرة: GOLD-…
- Security/Tenant: 
- Localization/Visual: 

## 6. خطة التراجع (Rollback)

(كيف نرجع بأمان؟ هل التراجع يحتاج Migration عكسية؟)

## 7. الوثائق المتأثرة (تحدَّث في نفس الـPR — Master §139)

- [ ] Data Model  - [ ] Accounting Rules  - [ ] Transaction Map  - [ ] State Machines
- [ ] Design System  - [ ] Localization Glossary  - [ ] Test Strategy  - [ ] أخرى: 

## 8. القرار

☐ معتمد  ☐ مرفوض  — المراجع: ____  التاريخ: ____
