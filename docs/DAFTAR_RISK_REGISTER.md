# DAFTAR — Risk Register / سجل المخاطر

| # | المجال | الخطر | الاحتمال | الأثر | التخفيف | المالك/الحالة |
|---|---|---|---|---|---|---|
| R-01 | Accounting | قيود غير متوازنة أو إيراد مكرر من التحصيل | متوسط | حرج | Posting Engine مركزي حتمي + Invariants آلية + Reconciliation يومي | مفتوح — Phase 2 |
| R-02 | Accounting | تغيّر قواعد ضريبية قُطرية أو افتراضات خاطئة | متوسط | عالٍ | Country Packs بمصادر رسمية فقط؛ لا قواعد مخترعة؛ ضريبة اختيارية افتراضيًا | مفتوح — قرارات مفتوحة OD-03 |
| R-03 | Inventory | بيع متزامن لآخر قطعة يسبب مخزونًا سالبًا | عالٍ | عالٍ | خصم ذرّي مشروط في DB + اختبار سباق (GOLD-19) | مصمَّم — Phase 2 |
| R-04 | Inventory | انحراف cache الكميات عن الحركات | متوسط | عالٍ | Reconciliation دوري + rebuild capability + Alert دون تصحيح صامت | مصمَّم |
| R-05 | Tenant Isolation | تسرّب Cross-tenant عبر endpoint منسيّ | متوسط | حرج | فرض scope على طبقة البيانات + Suite آمنة آلية في CI | مصمَّم — كل Phase |
| R-06 | Offline Sync | فقدان/تكرار عمليات Offline أو تعارضات مخزون | عالٍ | عالٍ | idempotency scoped + لا حذف قبل التأكيد + سياسة offline_oversell_exception الموحّدة (M) + GOLD-25 | مصمَّم — Phase 4 |
| R-16 | Tenancy/Identity | خلط دفاتر/عملات Businesses تحت Tenant واحد أو وصول متجاوز للعضوية | متوسط | حرج | نموذج A/B المحسوم: business-scoped ledgers + memberships + Composite FKs + GOLD-29/30/31 | محسوم — v2 |
| R-17 | Multi-currency | غموض تخصيص الدفعات متعددة العملات (كم خُصم/كم أُغلق) | متوسط | عالٍ | Allocation صريحة بطرفي العملتين + base + fx NUMERIC(20,10) + rounding (D/E) + GOLD-26/35 | محسوم — v2 |
| R-18 | Accounting | Double reversal عند Return+Refund أو Void لفاتورة مدفوعة | متوسط | حرج | فصل المفاهيم (I) + void_invoice المركّب الذرّي (J) + GOLD-27/28 | محسوم — v2 |
| R-07 | Multi-currency | أخطاء تقريب/عرض في عملات كبيرة الأرقام (LBP/SYP) أو 3 خانات (JOD) | متوسط | عالٍ | Money VO + minor units + اختبارات العملات السبع + حساب فروقات تقريب | مصمَّم — Phase 2 |
| R-08 | AI | تنفيذ مالي خاطئ أو injection أو تخمين كيان | متوسط | حرج | Typed Tools + Confirmation إلزامي + لا SQL + صلاحيات المستخدم + اختبارات حقن | مصمَّم — Phase 7 |
| R-09 | WhatsApp | اعتمادية على مزوّد خارجي/تغيّر سياساته أو أسعاره | متوسط | متوسط | عزل كامل خلف Worker + فشله لا يفشل Core + قوالب معتمدة | مفتوح — OD-02 |
| R-10 | Scaling | تحمّل 10k+ حساب دون إثبات | متوسط | عالٍ | Load tests بأهداف قياسية + مراقبة p95 + خطة توسع موثقة | مفتوح — Phase 9 |
| R-11 | Localization | ترجمات مكسورة/ناقصة تصل الإنتاج | عالٍ | متوسط | فحص آلي للمفاتيح + Visual regression ثلاثي اللغات + Translation Freeze | مصمَّم — كل إصدار |
| R-12 | UX | زحام ميزات يقتل البساطة مع نمو المنتج | عالٍ | عالٍ | Simplicity Standard + Complexity Budget + SIMPLICITY AUDIT قبل الإطلاق | مستمر |
| R-13 | Data Integrity | تعديل مالي مباشر (admin/repair) بلا أثر | منخفض | حرج | Domain Commands فقط + Audit + Incident procedure + لا حذف | مصمَّم |
| R-14 | Storefront | بطء المتجر يقتل التحويل | متوسط | متوسط | SSR/CDN/صور محسّنة + مراقبة LCP كبوابة | Phase 5 |
| R-15 | Backups | نسخة غير قابلة للاستعادة فعليًا | منخفض | حرج | Restore drill دوري إلزامي + تحقق محاسبي بعد الاستعادة | مصمَّم |

## قواعد السجل
1. يُراجع عند كل Phase Gate ويُحدَّث.
2. أي خطر يتحقق فعليًا يدخل Incident Handling + Regression test.
3. المخاطر الحرجة لا تُرحَّل بين مراحل دون قرار موثّق في Acceptance Report.
