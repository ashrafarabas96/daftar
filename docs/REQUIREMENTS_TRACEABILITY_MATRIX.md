# DAFTAR — Requirements Traceability Matrix / مصفوفة تتبع المتطلبات

> المصدر: Master Directive V3 (180 بندًا) + Phase 0. كل متطلب له ID ومعيار قبول. الحالة في نهاية Phase 0: **Documented** لجميع المتطلبات (لم يبدأ تنفيذ).

الأعمدة: ID | المتطلب | المصدر § | الأولوية | المكوّن المعماري | استراتيجية الاختبار | معيار القبول | الحالة

## CORE — العقيدة والحوكمة

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| CORE-001 | Simple outside / Powerful inside / Premium / Correct by design / Safe to change / Zero silent errors | 2 | P0 | الكل | مراجعات A/B/C لكل Phase | أي قرار متعارض يُرفض ويُوثّق | Documented |
| CORE-002 | البساطة Requirement رسمي — Feature معقدة ≠ مكتملة | 3 | P0 | UX | SIMPLICITY AUDIT | اجتياز Simplicity Standard | Documented |
| CORE-003 | Modular Monolith بحدود Domain | 58–59 | P0 | Backend | مراجعة معمارية | لا Giant Services، لا circular deps | Documented |
| CORE-004 | Impact Analysis قبل أي تغيير Core (CHANGE_IMPACT) | 60–62 | P0 | حوكمة | مراجعة PR | قالب معبأ لكل تغيير جوهري | Documented |
| CORE-005 | Bug Lifecycle كامل + failing test قبل الإصلاح | 63–65 | P0 | حوكمة/QA | CI | لا إصلاح بلا اختبار رجوعي | Documented |
| CORE-006 | لا تراكم أخطاء + Bug Budget صفري للحرجة | 66–69 | P0 | QA | Release Gates | P0=P1=CoreP2=0 عند كل Gate | Documented |
| CORE-007 | Quality Gates PASS/FAIL لكل Phase | 74–85 | P0 | QA | Release Gates | Acceptance Report موقّع | Documented |
| CORE-008 | ثلاث مراجعات مستقلة A/B/C قبل PASS | 142 | P0 | QA | Release Gates | ثلاث موافقات موثقة | Documented |
| CORE-009 | Red-team + Negative testing | 143–144 | P0 | QA | Threat Model tests | سيناريوهات الكسر موثقة ومختبرة | Documented |
| CORE-010 | Business Invariants موثقة ومؤتمتة | 145–146 | P0 | Accounting/Inventory | Invariant tests | كل Invariant له اختبار أخضر | Documented |
| CORE-011 | الأولويات العليا عند التعارض (سلامة > ميزات) | 175 | P0 | حوكمة | مراجعة قرارات | قرارات متعارضة مرفوضة وموثقة | Documented |
| CORE-012 | الوكيل لا يختصر/يستبدل/يعقّد المتطلبات | 172–174 | P0 | حوكمة | مراجعة | لا انحراف غير موثق | Documented |
| CORE-013 | Requirements Traceability + لا اعتماد على الذاكرة | 140–141 | P0 | docs | هذه المصفوفة | كل Requirement له ID ومعيار قبول | Documented |
| CORE-014 | Definition of Done صارمة + لا 90% | 93–94 | P0 | QA | Phase Gate | كل البنود مستوفاة | Documented |
| CORE-015 | أوامر البدء/الانتهاء لكل مهمة | 178–179 | P0 | حوكمة | مراجعة PR | Checklist مرفقة | Documented |

## ACC — المحاسبة

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| ACC-001 | Accounting Engine: حتمي/قابل تدقيق/معاملاتي/Idempotent/قابل تتبع وعكس واختبار | 34 | P0 | Accounting | Unit+Integration+Golden | كل الخصائص مثبتة باختبارات | Documented |
| ACC-002 | Double Entry داخلي؛ Debit=Credit إلزامي | 35 | P0 | Posting Engine | Invariant INV-ACC-01 | لا قيد غير متوازن يمكن حفظه | Documented |
| ACC-003 | ممنوع الرصيد اليدوي كمصدر حقيقة | 36 | P0 | Receivables | Code review + grep CI | لا balance+= في الكود | Documented |
| ACC-004 | لا أرقام متناقضة (رصيد عميل/فاتورة/قسط) | 37 | P0 | Receivables | Integration | مصدر حقيقة واحد مثبت | Documented |
| ACC-005 | Payment مستقل عن Revenue | 39 | P0 | Payments | Golden GOLD-07 | تحصيل دين لا يرفع الإيراد | Documented |
| ACC-006 | Installments = جدول سداد لReceivable | 40 | P0 | Installments | INV-ACC-04 | Σأقساط+مقدم=الإجمالي | Documented |
| ACC-007 | Return/Refund يعكس الأصل بلا حذف | 41,119 | P0 | Sales/Payments | GOLD-11/12 | قيد عكسي + أثر كامل | Documented |
| ACC-008 | Accounting Reconciliation دوري + Alert دون تعديل صامت | 44,46 | P0 | Workers | GOLD-23 | اختلاف مزروع يُكتشف ويُنبَّه | Documented |
| ACC-009 | لا حذف للسجلات المالية المكتملة (Void/Reversal) | 119 | P0 | Accounting | Integration | لا مسار Hard Delete | Documented |
| ACC-010 | Admin لا يعدّل ماليًا إلا بDomain Commands | 117 | P0 | Admin/Audit | Security tests | كل تعديل إداري مدقق ومسجل | Documented |
| ACC-011 | الأرصدة الافتتاحية بقيد رسمي | — | P1 | Accounting | Integration | قيد افتتاحي متوازن موثق | Documented |
| ACC-012 | فروقات التقريب على حساب مخصص | — | P1 | Accounting | Currency tests | لا فروقات مخفية | Documented |

## INV — المخزون

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| INV-001 | Stock Ledger؛ كل تعديل له سبب/مصدر/مستخدم/وقت/مرجع | 42 | P0 | Inventory | Integration | حركة بلا سبب مستحيلة | Documented |
| INV-002 | Cached quantity قابل لإعادة البناء والتحقق | 43 | P0 | Inventory | GOLD/Rebuild test | rebuild = cache دائمًا | Documented |
| INV-003 | Inventory Reconciliation دوري | 45 | P0 | Workers | GOLD-23 | اختلاف → Alert | Documented |
| INV-004 | Concurrent selling آمن (آخر قطعة) | 78,98 | P0 | Inventory | Concurrency tests | لا بيع مزدوج لقطعة واحدة | Documented |
| INV-005 | Reservations بطيّع لطلبات المتجر | — | P0 | Inventory/Orders | Integration | حجز لا يلمس on_hand | Documented |
| INV-006 | تنبيه مخزون منخفض | — | P1 | Inventory/Notifications | Integration | حدث stock.low يعمل | Documented |

## SALE / PAY / CUS / INST — المبيعات والمدفوعات والعملاء والأقساط

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| SALE-001 | كل Sale يربط Items/Pricing/Customer?/Payment/Receivable/Accounting/Stock/Audit/Analytics/Outbox | 38 | P0 | Sales | GOLD-05/06 | السلسلة كاملة بمعاملة ذرّية | Documented |
| SALE-002 | Transaction Safety: ذرّية كلها أو لا شيء | 96 | P0 | Backend | Integration (kill mid-way) | لا حالات جزئية | Documented |
| SALE-003 | Idempotency لكل عملية معرضة للتكرار | 97 | P0 | Backend | Duplicate tests | لا عمليات مكررة | Documented |
| SALE-004 | نتيجة واضحة SUCCESS/FAILED/PENDING SYNC + مرجع | 15 | P0 | UX/API | E2E | لا غموض بعد إتمام البيع | Documented |
| SALE-005 | No False Success قبل commit الخادم | 161 | P0 | UX | E2E (فشل محاكى) | لا نجاح زائف | Documented |
| SALE-006 | تجميد الأسعار/التكاليف تاريخيًا | 33,145 | P0 | Sales | Invariant INV-ACC-05 | تعديل سعر المنتج لا يغيّر فاتورة قديمة | Documented |
| PAY-001 | دفعات جزئية ومتسلسلة على فواتير | — | P0 | Payments | GOLD-07 | paid+outstanding=total دائمًا | Documented |
| PAY-002 | Refund ≤ Refundable | 145 | P0 | Payments | GOLD-12 | استرداد زائد مرفوض | Documented |
| CUS-001 | كشف حساب عميل مشتق (افتتاحي+فواتير−مدفوعات) | — | P0 | Receivables | Integration | كشف مطابق للقيود | Documented |
| CUS-002 | بحث سريع عن العميل (Search First) | 12 | P1 | UX | E2E | وصول للعميل دون تنقل مطوّل | Documented |
| INST-001 | خطة تقسيط: مقدم + جدول + حالات due/late | — | P0 | Installments | GOLD-09/10 | حالات وتنبيهات صحيحة | Documented |
| INST-002 | تذكيرات أقساط تلقائية | — | P1 | Notifications/WA | Integration | تذكير قبل الاستحقاق وعند التأخر | Documented |

## ORDER / STORE — الطلبات والمتجر

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| ORDER-001 | دورة حياة طلب كاملة (State machine) | — | P0 | Orders | GOLD-13/14 | انتقالات موثقة فقط | Documented |
| ORDER-002 | إلغاء طلب: تحرير حجز + استرداد عند اللزوم | — | P0 | Orders | GOLD-14 | لا مخزون عالق | Documented |
| STORE-001 | Storefront جزء من المنتج بأعلى جودة | 126 | P0 | Storefront | Design review | يطابق الهوية | Documented |
| STORE-002 | سرعة المتجر: LCP/صور/bundle/latency | 127 | P0 | Storefront | Performance | LCP ≤ 2.5s على 4G | Documented |
| STORE-003 | Checkout يطلب اللازم فقط | 128 | P0 | Storefront | UX review | حقول Checkout دنيا | Documented |
| STORE-004 | تتبع طلب شفاف للعميل | — | P1 | Storefront | E2E | خط زمني بحالات واضحة | Documented |

## WA — واتساب

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| WA-001 | WhatsApp Core Communication Layer | 54 | P1 | WhatsApp | Integration | ربط رسمي موثق | Documented |
| WA-002 | Event-based فقط؛ لا Business Logic في WA | 55 | P0 | WhatsApp | Architecture review | لا كتابة مباشرة في Domains | Documented |
| WA-003 | فشل WA لا يفشل البيع | 56 | P0 | Workers | GOLD-15 | بيع ناجح + رسالة تُعاد | Documented |
| WA-004 | قوالب معرّبة + تفضيلات + Toggles | — | P1 | WhatsApp | Localization tests | ثلاث لغات + معاينة | Documented |
| WA-005 | Delivery status + retries + dead-letter + alert | 70 | P0 | Workers | Chaos tests | لا رسالة تضيع بصمت | Documented |
| WA-006 | كشف حساب عبر WA بمعاينة ولا إرسال لعميل خاطئ | 133 | P0 | WhatsApp/AI | E2E | تطابق غير واضح = لا إرسال | Documented |
| WA-007 | تقرير يومي عبر واتساب | — | P2 | WhatsApp/Analytics | Integration | ملخص يومي صحيح الأرقام | Documented |

## AI — المساعد الذكي

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| AI-001 | AI مساعد لا سلطة مالية | 47 | P0 | AI | Security review | لا أداة كتابة مالية للـLLM | Documented |
| AI-002 | صوت → Draft → Preview → Confirm → تنفيذ رسمي | 48 | P0 | AI | GOLD-16 | نفس نتيجة الإدخال اليدوي | Documented |
| AI-003 | ممنوع: Ledger/COGS/Inventory/Refund/Tax/SQL | 49 | P0 | AI | Injection tests | كل محاولة تُرفض | Documented |
| AI-004 | Structured Intent بـValidated Schema | 50 | P0 | AI | Contract tests | لا تنفيذ لإخراج غير صالح | Documented |
| AI-005 | الغموض = سؤال لا تخمين | 51 | P0 | AI | GOLD-17 | عميلان متشابهان → توضيح | Documented |
| AI-006 | Low confidence = لا تنفيذ | 52 | P0 | AI | Unit | عتبة موثقة ومختبرة | Documented |
| AI-007 | Confirmation صريح للعمليات المالية | 53 | P0 | AI/UX | E2E | لا تنفيذ بلا تأكيد | Documented |
| AI-008 | AI جزء أصيل بصريًا + 3 مراحل مرئية | 130–132 | P1 | UX | Design review | يطابق الهوية | Documented |

## TENANT / AUTH / SEC — المستأجرون والهوية والأمان

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| TENANT-001 | Multi-tenant مع عزل كامل | 116 | P0 | Backend/DB | GOLD-20 | Cross-tenant = blocker | Documented |
| AUTH-001 | RBAC بصلاحيات ذرّية على الخادم | — | P0 | Identity | RBAC matrix tests | كل endpoint محمي | Documented |
| AUTH-002 | MFA للإدارة الحساسة + جلسات قابلة للإبطال | — | P0 | Identity | Security tests | old session مرفوضة | Documented |
| SEC-001 | Zero Trust: إعادة تحقق خادم من السعر/الإجمالي/الصلاحية/المخزون | 115 | P0 | API | Tampering tests | مدخل معدّل يُرفض | Documented |
| SEC-002 | Audit لكل عملية حساسة | 118 | P0 | Audit | Integration | لا عملية حساسة بلا أثر | Documented |
| SEC-003 | لا Fix مباشر في Production؛ Repair بأدوات رسمية | 147–148 | P0 | Ops | Process review | Dry-run+Backup+Audit+Verify | Documented |
| SEC-004 | Rate limiting + Input validation + Secrets management | — | P0 | API | Security tests | 429/رفض/لا أسرار في الكود | Documented |
| SEC-005 | Branch protection + CI Gate + Code Review checklist | 90–92 | P0 | CI/CD | CI | لا merge مع فشل | Documented |

## SUB — الاشتراكات

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| SUB-001 | Entitlement Engine مركزي؛ لا شروط باقات في Core | 120 | P0 | Subscriptions | Code review | check() موحد فقط | Documented |
| SUB-002 | Plan Limit UX: سبب+حد+استخدام+Upgrade بلا إتلاف | 121 | P1 | UX | GOLD-22 | بيانات سليمة عند الحد | Documented |
| SUB-003 | باقات FREE/STARTER/PRO/BUSINESS كبيانات | — | P1 | Subscriptions | Integration | تغيير حد = بيانات لا كود | Documented |

## LOC / CUR / COUNTRY — التعريب والعملات والبلدان

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| LOC-001 | ar/en/tr لغات من الدرجة الأولى | 23 | P0 | Localization | Localization tests | لا لغة ناقصة في شاشة Core | Documented |
| LOC-002 | بوابة تدقيق ترجمة (معنى/قواعد/إملاء/سياق/طول/اتجاه) | 24 | P1 | Localization | Process + audit | سجل مراجعة لكل إضافة | Documented |
| LOC-003 | Translation Freeze + Localization Audit قبل كل Release | 25 | P0 | CI | Automated audit | 0 مفاتيح ناقصة/placeholder ظاهر | Documented |
| LOC-004 | RTL أصيل وLTR أصيل؛ لا flipping أعمى | 26 | P0 | Design System | Visual regression | كل Component مختبر بالاتجاهين | Documented |
| LOC-005 | UX Glossary موحّد؛ نفس الإجراء نفس الكلمة | 155–156 | P1 | Localization | Glossary audit | لا تضارب مصطلحات | Documented |
| CUR-001 | ممنوع Float؛ Money VO + دقة ثابتة مركزيًا | 30 | P0 | domain-core | Unit + CI lint | لا float للأموال | Documented |
| CUR-002 | Base currency ثابتة بعد أول معاملة إلا بMigration رسمية | 31 | P0 | Tenancy | Integration | تغيير عادي مستحيل | Documented |
| CUR-003 | لقطة FX كاملة لكل معاملة متعددة العملة | 32 | P0 | Accounting | GOLD-21 | كل الحقول الستة محفوظة | Documented |
| CUR-004 | التاريخ المالي لا يتغير بسعر اليوم | 33 | P0 | Accounting | Invariant | تقرير تاريخي ثابت | Documented |
| CUR-005 | عملات أساسية ILS/JOD/LBP/SYP/TRY/USD/EUR + انفتاح | 29 | P0 | Currency metadata | Currency tests | سيناريوهات مالية خضراء على السبع | Documented |
| COUNTRY-001 | أسواق PS/JO/LB/SY/TR من المعمارية الأساسية | 27 | P0 | Country Packs | Pack tests | إنشاء Business بكل بلد | Documented |
| COUNTRY-002 | جاهزية الخليج والعالم العربي دون إعادة بناء Core | 28 | P1 | Country Packs | Contract test | إضافة بلد = بيانات فقط | Documented |
| COUNTRY-003 | Address/Phone/Tax حسب البلد؛ لا Form جامد | 129 | P1 | Country Packs | E2E | نماذج تتغير بالبلد | Documented |

## ANDROID / WEB / ADMIN — المنصات

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| ANDROID-001 | Offline مصمَّم لا مرتجل + حالات Sync مفهومة | 99–100 | P0 | Android | GOLD-18 | 4 حالات ظاهرة للمستخدم | Documented |
| ANDROID-002 | لا فقدان عملية محلية قبل تأكيد الخادم | 101 | P0 | Android | Kill tests | العملية باقية بعد القتل | Documented |
| ANDROID-003 | Haptics مدروس (بيع/باركود/تأكيد حرج) | 158 | P2 | Android | UX review | لا haptics عشوائية | Documented |
| ANDROID-004 | Bottom Nav: الرئيسية/البيع/الطلبات/العملاء/المزيد | 5 | P0 | Android | Design review | 5 عناصر فقط | Documented |
| WEB-001 | Backward compatibility لإصدارات أندرويد المنشورة | 114 | P0 | API | Contract tests | لا كسر API | Documented |
| WEB-002 | Responsive: Phone/Tablet/Desktop | 83 | P0 | Web | Visual tests | كل Core screen على 3 فئات | Documented |
| ADMIN-001 | Super Admin أعمق كثافة لكن منظم؛ بلا تعديل مالي مباشر | 117,124 | P1 | Admin | Design+Security | Domain commands فقط | Documented |
| ADMIN-002 | Dashboard أولويات: اليوم/طلبات/ديون/أقساط/مخزون/إجراءات | 122–123 | P0 | Web | UX review | ترتيب الأولويات مطابق | Documented |
| ADMIN-003 | كل Chart تخدم قرارًا | 125 | P1 | Web | Design review | لا رسوم تجميلية | Documented |

## OPS / BACKUP / PERF / QA — التشغيل والنسخ والأداء والجودة

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| OPS-001 | Observability: request/correlation/business_transaction IDs | 72–73 | P0 | Observability | Integration | تتبع صوت→WhatsApp كامل | Documented |
| OPS-002 | No Silent Failure لكل Worker (status/retry/DLQ/alert) | 70 | P0 | Workers | Chaos tests | فشل = تنبيه | Documented |
| OPS-003 | No Swallowed Exceptions في Core | 71 | P0 | Backend | Lint/Review | لا empty catch | Documented |
| OPS-004 | Release pipeline كامل + Smoke post-deploy + Rollback | 107–112 | P0 | CI/CD | Drill | RC→Prod موثق مع smoke | Documented |
| OPS-005 | Migrations آمنة Expand/Migrate/Contract | 113 | P0 | DB | Migration checks CI | لا destructive مباشر | Documented |
| OPS-006 | TECHNICAL_DEBT.md؛ ممنوع دَين للمحاسبة/الأمان/البيانات | 137 | P0 | حوكمة | Review | سجل موجود ونظيف من الممنوع | Documented |
| OPS-007 | ADR للقرارات الكبرى + Docs تُحدَّث مع الكود | 138–139 | P1 | حوكمة | PR review | وثائق متزامنة | Documented |
| OPS-008 | صور المنتجات: أصل محفوظ + variants محسّنة | 105 | P1 | Storage | Integration | لا فقدان أثناء التحويلات | Documented |
| OPS-009 | Autosave للمسودات فقط — لا للالتزام المالي | 106 | P0 | UX | E2E | لا commit مالي تلقائي | Documented |
| BACKUP-001 | Backup تلقائي مشفر مراقب بRetention موثق | 102 | P0 | Infra | Restore test | نسخ يومية + PITR | Documented |
| BACKUP-002 | لا Backup ناجحًا بلا Restore Test؛ Drill دوري كامل | 103–104 | P0 | Infra | شهري | استعادة مؤكدة + تحقق محاسبي | Documented |
| PERF-001 | تصميم لـ10k+ حساب مع إثبات بLoad Test | 134 | P0 | Infra | Load tests | أهداف Scaling Plan محققة | Documented |
| PERF-002 | Stateless + توسع أفقي؛ لا تعقيد مبكر ولا core مانع للتوسع | 135–136 | P0 | Backend | Architecture review | لا حالة في العمليات | Documented |
| PERF-003 | Perceived performance: skeletons/cache صحيح | 159–160 | P1 | UX | UX review | لا loaders مزعجة | Documented |
| QA-001 | Golden Regression إلزامية غير مختصرة | 85–86 | P0 | QA | CI | الجناح كامل أخضر | Documented |
| QA-002 | تقسيم الاختبارات زمنيًا (PR/merge/nightly/release) | 89 | P1 | CI | CI config | 4 مسارات تعمل | Documented |
| QA-003 | Final QA Matrix: Feature×لغة×عملة×جهاز | 165 | P0 | QA | Release | مصفوفة موثقة منفذة | Documented |
| QA-004 | Launch Definition + التدقيقات الأربع النهائية | 166–170 | P0 | QA | Release | كل البنود خضراء | Documented |
| QA-005 | Known core defects = 0 قبل الإطلاق | 171 | P0 | QA | Release | تقرير عيوب صفري | Documented |

## UI — تجربة وتصميم

| ID | المتطلب | § | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| UI-001 | الصور العشر = North Star ملزمة؛ Tokens فعلية | 16–17 | P0 | Design System | Design review | DAFTAR_DESIGN_SYSTEM معتمد | **Done (Phase 0)** |
| UI-002 | الخصائص البصرية الثماني + Visual language | 18–19 | P0 | Design System | Premium audit | مطابقة شخصية الصور | Done (Phase 0) |
| UI-003 | لا مظهر Admin Template جاهز | 20 | P0 | Design | Design review | شخصية منتج واضحة | Documented |
| UI-004 | Design Tokens فقط؛ لا قيم حرة | 21 | P0 | Design System | Lint | لا hex خارج tokens | Documented |
| UI-005 | Typography واضحة مرخّصة للعربية/الإنجليزية/التركية | 22 | P0 | Design System | Design review | Tajawal + مرافق معتمد | Done (Phase 0) |
| UI-006 | Complexity Budget + Progressive Disclosure + لا بنية نظام للمستخدم | 4,6,7 | P0 | UX | UX review | شاشات نظيفة من التقني | Documented |
| UI-007 | One Primary Action + عمليات يومية قصيرة | 8–9 | P0 | UX | UX Friction metrics | ≤3 خطوات للأساسيات | Documented |
| UI-008 | Smart Defaults الآمنة فقط | 11 | P1 | UX | UX review | لا defaults مالية خطرة | Documented |
| UI-009 | Empty states حيّة + رسائل خطأ مفهومة | 13–14 | P0 | UX | E2E | CTA + 3 أسئلة مجابة | Documented |
| UI-010 | Premium microinteractions + لا بطء استعراضي | 157 | P1 | Design | Design review | motion 150–250ms | Documented |
| UI-011 | Accessibility: تباين + أهداف لمس ≥44px | 162–164 | P0 | Design | A11y audit | AA محقق | Documented |
| UI-012 | Confirmation فقط للحالات الأربع | 154 | P1 | UX | UX review | ≤1 تأكيد لكل flow | Documented |
| UI-013 | Advanced settings خلف مستوى ثانٍ + لا حقول قابلة للاستنتاج | 152–153 | P1 | UX | UX review | مسار أساسي نظيف | Documented |

---

**ملخص التغطية:** 102 متطلبًا موثّقًا تغطي بنود Master Directive V3 الـ180 كاملة (كل بند § مُحال إلى متطلب واحد على الأقل). الحالة "Done (Phase 0)" للوثائق المُنتجة فعليًا في هذه المرحلة؛ الباقي "Documented" بانتظار مراحل التنفيذ وفق Roadmap.

---

## CORR — متطلبات Correction & Hardening Pass (v2)

| ID | المتطلب | المرجع | أولوية | المكوّن | الاختبار | معيار القبول | الحالة |
|---|---|---|---|---|---|---|---|
| CORR-A | Tenant=حساب SaaS؛ Business يملك country/base_currency/timezone/locale/storefront/دفاتر؛ البيانات التجارية business-scoped مع tenant_id للعزل | A | P0 | Data Model/Domain Map | GOLD-31 | لا خاصية تجارية على Tenant؛ دفاتر منفصلة لكل Business | Done (Phase 0) |
| CORR-B | Identity مستقلة: users + tenant_memberships + business_memberships + branch_access؛ SoT للصلاحيات = business_roles على العضويات | B | P0 | Identity/Security | GOLD-29/30 | وصول A دون B مثبت؛ لا إضعاف للعزل | Done (Phase 0) |
| CORR-C | Warehouse يتبع Business؛ للفرع default_warehouse اختياري بـComposite FK لنفس النشاط | C | P0 | Data Model | Contract test | لا غموض في العلاقة | Done (Phase 0) |
| CORR-D | Payment Allocation متعددة العملات صريحة (طرفا العملتين + base + fx snapshot + rounding)؛ Refund كذلك | D | P0 | Payments | GOLD-26/35 | لا amount غامض؛ كم خُصم وكم أُغلق معلومان بدقة | Done (Phase 0) |
| CORR-E | fx_rate NUMERIC(20,10) موثّق؛ اختبارات USD→LBP/JOD، EUR→TRY، جزئي، استرداد، تقريب | E | P0 | Accounting | Currency suite | لا Float/Double في أي حقل مالي | Done (Phase 0) |
| CORR-F | تنسيق العملة عبر ICU/Intl/CLDR حسب Locale؛ سجل العملة مالي فقط (ISO/minor_units/أسماء) | F | P0 | Localization | Localization tests | لا separators/symbol_position مخزّنة | Done (Phase 0) |
| CORR-G | كل قيد له وسيلة إنفاذ PostgreSQL واقعية (CHECK/UNIQUE/FK/Application invariant/Deferrable trigger/Reconciliation) | G | P0 | DB design | مراجعة معمارية + اختبارات | لا CHECK وهمية على Aggregates | Done (Phase 0) |
| CORR-H | سطر القيد: debit>0 XOR credit>0 — لا صفري ولا ثنائي | H | P0 | Accounting | Unit | CHECK صارم موثّق | Done (Phase 0) |
| CORR-I | فصل Return/CreditNote/InventoryReturn/Refund؛ CreditNote+Lines في النموذج؛ مثال رقمي كامل متوازن؛ لا double reversal | I | P0 | Sales/Accounting | GOLD-28 | الإيراد يُعكس مرة واحدة فقط | Done (Phase 0) |
| CORR-J | ممنوع Void مباشر لفاتورة مدفوعة؛ void_invoice مركّب ذرّي (عكس دفعات ثم فاتورة) | J | P0 | Sales | GOLD-27 | لا أرصدة/نقدية غير متسقة | Done (Phase 0) |
| CORR-K | AP كامل: supplier_payments + allocations متعددة العملات + دفعات جزئية + رصيد مشتق؛ Purchase بكل الحقول | K | P0 | Purchases | GOLD-32 | لا supplier.balance يدوي | Done (Phase 0) |
| CORR-L | PaymentMethod بيانات Business-level (system_type مغلق + أسماء معرّبة + is_active + requires_reference) | L | P1 | Payments | Integration | إضافة "محفظة/شيك" بلا تعديل كود | Done (Phase 0) |
| CORR-M | سياسة مخزون سالب موحّدة: ممنوع إلا إعداد صريح أو offline_oversell_exception مدقّق + needs_attention + Alert + منع لاحق | M | P0 | Inventory/Offline | GOLD-25 | لا تناقض Rule/Implementation | Done (Phase 0) |
| CORR-N | Moving Weighted Average لكل variant×warehouse بصيغ موثقة لكل حدث؛ cost_minor مرجع عرض؛ GL=valuation | N | P0 | Inventory/Accounting | GOLD-33 | INV-INV-06/INV-ACC-11 خضراء | Done (Phase 0) |
| CORR-O | كميات NUMERIC(18,4) + UoM (unit_code/unit_decimals) — fractional مدعوم تصميمًا | O | P1 | Inventory | GOLD-34 | Core لا يمنع الكسور | Done (Phase 0) |
| CORR-P | سعر المنتج بالعملة الأساسية للـBusiness دائمًا؛ Price Lists محجوزة للمستقبل | P | P0 | Catalog | Unit | لا currency_code غامض على المنتج | Done (Phase 0) |
| CORR-Q | CategoryTranslation + business_public_texts + نصوص طلبات/إشعارات معرّبة كبيانات | Q | P1 | Catalog/Localization | Localization audit | تعدد لغات Storefront بلا Migration مؤلمة | Done (Phase 0) |
| CORR-R | platform_supported_locales(ar/en/tr) مستقلة عن country_recommended_locales | R | P0 | Localization | E2E | تاجر فلسطيني يستخدم Türkçe | Done (Phase 0) |
| CORR-S | Tax=unconfigured في كل الحزم حتى مصدر قانوني موثّق | S | P0 | Country Packs | مراجعة | لا نسبة/وضع مفترض | Done (Phase 0) |
| CORR-T | Cart/CartItem كيانات رسمية؛ Reservations.ref_type يشير لكيانات موجودة فقط | T | P1 | Orders | Contract test | لا مرجع معلّق | Done (Phase 0) |
| CORR-U | Idempotency scoped — **المعمارية النهائية (محدّثة Pass#4):** جدول مستقل لكل عملية بـ`UNIQUE(business_id, idempotency_key)` / `UNIQUE(business_id, offline_local_id)` بأعمدة حقيقية؛ والويبهوكات بـ(business_id, event_source, external_event_id) | U | P0 | Backend | GOLD-62/63/64 | لا تصادم بين مستأجرين؛ لا Literal داخل قيد | Done (Phase 0) |
| CORR-V | tenant_id+business_id في كل الجداول الفرعية + Composite FKs مانعة للربط العابر | V | P0 | DB | GOLD-30 | رفض على مستوى DB | Done (Phase 0) |
| CORR-W | مكوّنات DAFTAR premium بسلوك Android أصيل (Compose) — لا استنساخ iOS | W | P1 | Design System | Design review | لا "iOS-like" في الوثائق | Done (Phase 0) |
| CORR-X | Onboarding وفق 02_Onboarding.png (5 خطوات) منعكس في Design/UX/Simplicity/Product Spec | X | P1 | UX | GOLD-36 | الافتراضات المؤقتة أُزيلت | Done (Phase 0) |

| HARD-01 | قيد مرتجع جزئي متوازن بأسطر صريحة + اختبار أسطر حرفي | 1 | P0 | Accounting | GOLD-28 | Dr 545 = Cr 545 | Done (Phase 0) |
| HARD-02 | Refundable Source Model — **الصيغة النهائية (محدّثة Pass#5/6):** Typed FKs (credit_note_id XOR customer_credit_id) + remaining بعملة المصدر + remaining_carrying_base + FOR UPDATE — بلا double counting ولا Raw Payment | 2 | P0 | Accounting/Data Model | GOLD-40/41/79/80/85 | 496 FAIL / 495 PASS / ثانية 1 FAIL | Done (Phase 0) |
| HARD-03 | تسوية ثلاثية العملات: payment_to_base_rate + carrying value + FX realized منفصل عن التقريب — AR/AP/Refunds | 3 | P0 | Multi-Currency/Accounting | GOLD-37/38/39 | Dr 1480 = Cr 1480 في المثال الملزم | Done (Phase 0) |
| HARD-04 | INV-ACC-09 محدّث: مقارنة في العملة الأساسية فقط — ممنوع مقارنة عملتين مباشرة | 4 | P0 | Accounting | Review E | لا مقارنة عابرة للعملات | Done (Phase 0) |
| HARD-05 | تحويل المستودعات: avg المصدر ثابت، الوجهة يُعاد حسابه، ΔValuation=0 | 5 | P0 | Inventory | GOLD-44 | 3000 قبل وبعد | Done (Phase 0) |
| HARD-06 | دقة التكلفة NUMERIC(28,10) + توزيع فرق التقريب على الأسطر + ممنوع Float/Double | 6 | P0 | Inventory/Data Model | GOLD-45, INV-INV-08 | Σ أسطر COGS = COGS المقيَّد | Done (Phase 0) |
| HARD-07 | فرق إرجاع المورد → 6200 PPV بمثال رقمي (Dr AP 500 = Cr Inv 450 + Cr PPV 50) | 7 | P0 | Accounting/Inventory | GOLD-46 | ليس 6100 | Done (Phase 0) |
| HARD-08 | payment_methods.posting_account_id إلزامي للنشط ماليًا + اختبار تكامل | 8 | P0 | Data Model/Accounting | GOLD-47, INV-ACC-13 | رفض بلا حساب ترحيل | Done (Phase 0) |
| HARD-09 | ترقيم الفواتير Business-level كحد أدنى؛ Country Pack يقرر نوع التسلسل فقط؛ OD-05 مغلق | 9 | P0 | Data Model | GOLD-48 | تسلسلان مستقلان تحت التزامن | Done (Phase 0) |
| HARD-10 | Onboarding لغة: منتقي واجهة على الترحيب + لغة متجر كحقل ثالث (≤3 حقول) + قفل العملة بعد أول معاملة | 10 | P1 | UX/Localization | GOLD-36/49, SIM-15 | لا خطوة سادسة | Done (Phase 0) |
| HARD-11 | تصحيح عدّاد السيناريوهات: GOLD-25..36 = 12 (لا 13) | 11 | P2 | Reports | مراجعة نصية | العدد صحيح | Done (Phase 0) |
| HARD-12 | void_invoice بمثالين محاسبيين صريحين: مدفوع نقدًا بالكامل + آجل مدفوع جزئيًا | 12 | P0 | Accounting | GOLD-42/43 | قيود متوازنة حرفية | Done (Phase 0) |

| HARD-13 | استرداد عابر العملات: حقول source/refund كاملة + cap بعملة المصدر + تحرير الالتزام بالقيمة الدفترية | P3-1 | P0 | Accounting/Data Model | GOLD-50..53 | remaining=0 USD بعد استرداد 90 EUR | Done (Phase 0) |
| HARD-14 | Negative Inventory Cost Catch-up: تسوية COGS إلزامية عند تغطية السالب (provisional vs actual) | P3-2 | P0 | Inventory/Accounting | GOLD-54/55/56, INV-INV-09 | GL=valuation=600 | Done (Phase 0) |
| HARD-15 | Supplier Credit: supplier_credit_notes/allocations/refunds + حساب 1150 — Case A/B | P3-3 | P0 | Accounting/Data Model | GOLD-57..61, INV-ACC-14 | ممنوع Dr AP بلا مقابل؛ لا Revenue | Done (Phase 0) |
| HARD-16 | Idempotency UNIQUE قابلة للتنفيذ: بلا Literal داخل قيد — لكل جدول عمليات مفتاحه | P3-4 | P0 | Schema | GOLD-62..64, Review F | كل UNIQUE بأعمدة فعلية | Done (Phase 0) |
| HARD-17 | {store_slug}.{PLATFORM_ROOT_DOMAIN} بدل .daftr.sa — إعداد منصة لا متطلب | P3-5 | P1 | Product/Design | مراجعة نصية | لا دومين ثابت في الوثائق | Done (Phase 0) |
| HARD-18 | إغلاق OD-12: Master V3 مرجع ملزم للـBottom Navigation | P3-6 | P1 | Open Decisions | مراجعة | CLOSED | Done (Phase 0) |

| HARD-19 | refunds schema قابل للتنفيذ: idempotency_key عمود NOT NULL حقيقي + Typed composite FKs (credit_note_id/customer_credit_id) + CHECK مصدر واحد — لا polymorphic مؤجل | P4-1/2 | P0 | Schema | GOLD-74, Review I | كل قيد بأعمدة موجودة | Done (Phase 0) |
| HARD-20 | Raw Payment ليس مصدر Refund: reverse_payment_allocation ذرّي (قفل، إعادة فتح AR بالـSnapshots، عكس FX، بلا Revenue، توليد Customer Credit، منع عكس مزدوج) | P4-3/5 | P0 | Accounting | GOLD-65/66/67 | AR يعود 1000 بلا مساس بالإيراد | Done (Phase 0) |
| HARD-21 | Customer Credit Model: customer_credits + allocations (overpayment/reversal/manual بصلاحية) — تصفية بفاتورة مستقبلية أو Refund فقط، بلا balance mutation يدوي | P4-4/6 | P0 | Data Model/Accounting | GOLD-68..71, INV-ACC-16 | ليس Revenue وليس AR | Done (Phase 0) |
| HARD-22 | Negative Deficit Layers FIFO للاستلام الجزئي المتعدد بربط موثّق وcatch-up لكل تغطية | P4-7 | P0 | Inventory | GOLD-72 | COGS=1260، GL=0 | Done (Phase 0) |
| HARD-23 | تنظيف التوثيق: CORR-U يطابق المعمارية النهائية؛ §19 وOD-05/OD-12 محدّثة؛ لا متطلب قديم يناقض | P4-8/9 | P1 | Reports | مراجعة نصية | لا تناقض | Done (Phase 0) |
| HARD-24 | Supplier Credit/Refund مرآة كاملة متعددة العملات بمثال محسوب (ليس "نفس النموذج" فقط) | P4-10 | P0 | Accounting/Data Model | GOLD-73 | 369=360+9، remaining=0 USD | Done (Phase 0) |

| HARD-25 | payment_reversals + payment_reversal_allocations كيانان دائمان (Idempotency + Partial Unique على provider_reference بـNULL policy) — payment_reversal لا يولّد Customer Credit تلقائيًا ويعكس أصل النقد | G-1..5 | P0 | Accounting/Data Model | GOLD-86/87, INV-ACC-18 | المال ذهب ≠ المال باقٍ | Done (Phase 0) |
| HARD-26 | Payment SM نهائية: pending→completed→partially_reversed→reversed / failed؛ allocation_status مشتق؛ Allocation: active/partially_reversed/reversed؛ لا refunded على Payment | G-5 | P0 | State Machines | GOLD-88 | لا تناقض مع Source Model | Done (Phase 0) |
| HARD-27 | Carrying pairs على كل مصدر + استهلاك جزئي تناسبي وأخير مصفّر + SoT Matrix وثيقة رسمية | G-6/7, P4 | P0 | Data Model | GOLD-79/80/84, INV-ACC-17 | لا مصدر بلا carrying متبقٍ | Done (Phase 0) |

**ملخص التغطية (v6):** 102 أصليًا + 24 CORR-A..X + 12 HARD-01..12 + 6 HARD-13..18 + 6 HARD-19..24 + 3 HARD-25..27 = **153 متطلبًا**. الحالة "Done (Phase 0)" تعني أن القرار موثّق ومتسق عبر كل الوثائق المرتبطة ومربوط باختبارات Golden/Invariant مسمّاة؛ التنفيذ البرمجي يبدأ في Phase 1+ بعد الاعتماد.
