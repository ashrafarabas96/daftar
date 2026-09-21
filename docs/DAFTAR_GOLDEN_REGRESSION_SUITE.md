# DAFTAR — Golden Regression Suite / جناح الرجوع الذهبي (v3)

> يُشغَّل **إلزاميًا** عند كل Phase Gate وقبل كل Release (Master §85–86). لا يُختصَر. الفشل في أي سيناريو = Gate FAIL.

## السيناريوهات الذهبية (GOLD-*)

| ID | السيناريو | التحقق الجوهري |
|---|---|---|
| GOLD-01 | Onboarding كامل: حساب → نشاط → دولة/عملة → رابط متجر | Tenant معزول + شجرة حسابات مزروعة + عملة أساسية ثابتة |
| GOLD-02 | Login (ويب + أندرويد) وجلسة وإبطال | Old session تُرفض بعد reset |
| GOLD-03 | إنشاء منتج (صورة، SKU، باركود، حد تنبيه) | ترجمات + media أصل محفوظ |
| GOLD-04 | شراء → استلام → مخزون ↑ | حركة purchase + قيد Inventory/AP + متوسط تكلفة محدّث |
| GOLD-05 | بيع نقدي POS | قيود متوازنة + مخزون ↓ + Invoice paid + إيصال |
| GOLD-06 | بيع آجل | Receivable صحيح + Invoice open + قيد AR |
| GOLD-07 | دفعة جزئية ثم دفعة | paid+outstanding=total في كل خطوة + لا إيراد مكرر |
| GOLD-08 | تحصيل دين قديم كامل | status=paid + كشف حساب صحيح |
| GOLD-09 | بيع بالتقسيط: مقدم + أقساط | Σأقساط+مقدم=الإجمالي + تذكيرات مجدولة |
| GOLD-10 | تحصيل قسط مستحق + قسط متأخر | حالات due/late صحيحة + تنبيهات |
| GOLD-11 | مرتجع جزئي على بيع نقدي | قيد عكسي + مخزون + Refund ≤ refundable + الأصل محفوظ |
| GOLD-12 | Refund مرتين (محاولة) | الثانية مرفوضة |
| GOLD-13 | طلب متجر إلكتروني: حجز → قبول → تنفيذ | Reservation consumed + Sale كامل + لا خصم مزدوج |
| GOLD-14 | إلغاء طلب بعد دفع | تحرير حجز + Refund + إشعار عميل |
| GOLD-15 | رسالة واتساب تلقائية بعد بيع | Sale تنجح حتى لو فشلت الرسالة؛ retry يعمل |
| GOLD-16 | أمر صوتي: "بعت أحمد 3 سماعات بسعر 120، دفع 300" | Draft صحيح → مراجعة → تأكيد → نفس نتيجة GOLD-05/06 تمامًا |
| GOLD-17 | الغموض الصوتي (عميلان "أحمد") | سؤال توضيحي، لا تخمين |
| GOLD-18 | بيع Offline ثم مزامنة | idempotency (لا تكرار) + حالة Synced واضحة |
| GOLD-19 | سباق آخر قطعة | ناجح واحد؛ الآخر رسالة واضحة |
| GOLD-20 | Cross-tenant | كل محاولة وصول تُرفض |
| GOLD-21 | بيع بعملة أجنبية | FX snapshot محفوظ؛ التقرير التاريخي لا يتغير |
| GOLD-22 | بلوغ حد الباقة | رسالة واضحة + Upgrade + لا فقدان بيانات |
| GOLD-23 | Reconciliation jobs | تعمل وتنبّه على اختلاف مزروع عمدًا |
| GOLD-24 | Smoke post-deploy (Master §111) | Login/Dashboard/Product/POS/Payment/Order/Storefront/WhatsApp queue/AI |
| GOLD-25 | **Offline oversell exception (M)** | بيع Offline حقيقي يتزامن مع نفاد المخزون → العملية تُحفظ، حركة `offline_oversell_exception`، needs_attention، Alert للمالك، منع بيع لاحق حتى التسوية، Audit كامل |
| GOLD-26 | **دفعة بعملة مختلفة عن الفاتورة (D/E)** | فاتورة LBP + دفعة USD جزئية: التخصيص يسجل الطرفين + base + fx NUMERIC(20,10) + rounding؛ paid+outstanding=total بعملة الفاتورة |
| GOLD-27 | **محاولة Void لفاتورة مدفوعة (J)** | Void مباشر مرفوض؛ void_invoice المركّب يعكس الدفعات ثم الفاتورة ذرّيًا؛ لا أرصدة/نقدية غير متسقة |
| GOLD-28 | **Return ثم Refund بلا double reversal (I)** | مرتجع جزئي بخصم+ضريبة (Accounting §4.7). **يجب مطابقة أسطر القيود المتوقعة حرفيًا — وليس مجرد فحص توازن:** قيد Credit Note: `Dr 4100 Sales Returns 500، Dr 2100 Tax Payable 45، Cr 4200 Discounts 50، Cr 2200 Customer Refund Liability 495` (مجموع مدين 545 = مجموع دائن 545)؛ قيد المخزون: `Dr 1200 Inventory 300 / Cr 5000 COGS 300`؛ قيد الاسترداد: `Dr 2200 495 / Cr 1000 Cash 495`. الإيراد يُعكس مرة واحدة فقط؛ الـRefund تسوية نقدية لا تلمس الإيراد |
| GOLD-29 | **User مخوّل لـBusiness A وليس B (B)** | وصول A يعمل؛ كل وصول لبيانات B مرفوض (API + استعلامات) رغم نفس الحساب |
| GOLD-30 | **Cross-business FK manipulation (V)** | محاولة ربط Sale(A) بـCustomer/Invoice(B) → ترفض على مستوى DB (Composite FK) حتى بتجاوز طبقة التطبيق |
| GOLD-31 | **دفعتان تحت Tenant واحد بعملتين (A)** | Tenant واحد + Business A (ILS) + Business B (JOD): دفاتر وتقارير وعملات مستقلة تمامًا؛ لا خلط في أي تقرير |
| GOLD-32 | **دفعة مورّد جزئية (K)** | شراء آجل 5000 + سداد 2000: outstanding مورّد مشتق = 3000؛ قيد AP/Cash متوازن |
| GOLD-33 | **Inventory valuation reconciliation (N)** | GL(1200) = Σ(qty×avg_cost) بعد سلسلة شراء بسعرين/بيع/مرتجع/تحويل/تسوية — اختلاف مزروع يُكتشف |
| GOLD-34 | **كمية كسرية (O)** | منتج بالكيلو (unit_decimals=3): بيع 0.750 kg → حركة وCOGS وإجمالي صحيحة؛ منتج بالقطعة يرفض 1.5 |
| GOLD-35 | **Refund بعملة مختلفة (D/E)** | استرداد بعملة ≠ عملة الدفعة بلقطة FX خاصة + rounding موثّق + سقف refundable |
| GOLD-36 | **Onboarding (X + لغة)** | الخطوات الخمس بالمرجع البصري: ترحيب (مع **منتقي لغة واجهة ظاهر فورًا**) / حساب / نشاط / **دولة + عملة + لغة المتجر** (≤3 حقول) / رابط متجر بفحص توفر. لغة الواجهة ≠ لغة المتجر ≠ دولة العمل — كلها مستقلة. لغة المتجر قابلة للتعديل لاحقًا؛ العملة الأساسية **تُقفل بعد أول معاملة مالية** ومحاولة تغييرها تُرفض. كل ذلك ضمن ميزانية البساطة (SIM-*) — باللغات الثلاث والاتجاهين |
| GOLD-37 | **تسوية ثلاثية العملات (FX pass#2)** | المثال الملزم (Accounting §6): Base ILS، فاتورة USD 1000 @3.60 (AR=3600)، تسوية USD 400 عبر دفعة 370 EUR بسعر EUR→ILS 4.00 وUSD→ILS 3.70. القيد حرفيًا: `Dr 1010 Bank 1480 / Cr 1100 AR 1440 / Cr 4900 Realized FX Gain 40` — مجموع مدين 1480 = دائن 1480. التخصيص يحمل payment_to_base_rate=4.00 وinvoice_historical_to_base_rate=3.60 وinvoice_carrying_base_released=1440 وrealized_fx_gain_loss=+40 |
| GOLD-38 | **Realized FX Gain منفصل عن التقريب** | سيناريو GOLD-37: الـ40 تُقيد على 4900 حصرًا — رصيد 6100 Rounding Adjustment **لا يتغيّر** إطلاقًا في هذا السيناريو |
| GOLD-39 | **Realized FX Loss** | نفس البنية مع سعر معاكس: فاتورة USD 1000 @3.60، تسوية USD 400 بسعر USD→ILS 3.50 → `Dr Cash 1400، Dr 6900 Realized FX Loss 40 / Cr AR 1440` (مدين 1440 = دائن 1440). الخسارة على 6900 وليس 6100 |
| GOLD-40 | **سقف refundable للمصدر (Credit Note)** | CN بقيمة 495 (Accounting §5): محاولة Refund 496 منه → **FAIL**؛ Refund 495 → **PASS** وremaining=0؛ محاولة Refund 1 ثانية من نفس المصدر → **FAIL**. والمصدر الآخر (الدفعة النقدية الأصلية 505) غير متأثر إطلاقًا |
| GOLD-41 | **منع الاسترداد المزدوج المتزامن** | طلبا Refund متزامنان على نفس المصدر بـremaining=495: واحد فقط ينجح (SELECT…FOR UPDATE داخل معاملة)؛ الثاني يفشل برسالة واضحة. المجموع الكلي للاستردادات ≤ 495 مهما تكرّرت المحاولات |
| GOLD-42 | **void_invoice — فاتورة مدفوعة نقدًا بالكامل** | Accounting §7-A: فاتورة 1000 مدفوعة نقدًا: CN `Dr 4100 1000 / Cr 2200 1000`؛ مخزون `Dr 1200 600 / Cr 5000 600`؛ Refund `Dr 2200 1000 / Cr 1000 Cash 1000`. الحالة النهائية: الفاتورة void، cash لم يتغيّر صافيًا، الإيراد معكوس مرة واحدة |
| GOLD-43 | **void_invoice — فاتورة آجلة مدفوعة جزئيًا** | Accounting §7-B: فاتورة 1000 مدفوع منها 300: CN `Dr 4100 1000 / Cr 1100 AR 700 / Cr 2200 300`؛ Refund 300 من مصدر CN فقط. AR يصفر، لا double reversal |
| GOLD-44 | **تقييم التحويل بين المستودعات** | Inventory §5: A عشرة @100، B عشرة @200، تحويل 5 → avg_A=100 (ثابت)، avg_B=2500/15=166.6666666667 (NUMERIC(28,10))، التقييم الكلي 3000 قبل وبعد (Δ=0) |
| GOLD-45 | **MWAC عالي الدقة مع كسور** | سلسلة: شراء 3 @ 1000/3 (تكلفة كسرية)، بيع 1، شراء 2 @ 500.5، بيع 0.750 kg: avg يبقى NUMERIC(28,10) بلا تقريب وسيط؛ COGS المقيَّد BIGINT minor بتقريب HALF_EVEN مع توزيع الفرق على الأسطر بحيث Σ أسطر COGS = COGS المقيَّد تمامًا؛ فرق ≤ عدد الأسطر يُقيد على 6100 |
| GOLD-46 | **فرق إرجاع المورد → PPV** | Accounting §9: شراء 10@100 ثم 10@80 (avg=90)، إرجاع 5 للمورد بسعر الشراء الأصلي 100: `Dr 2000 AP 500 / Cr 1200 Inventory 450 / Cr 6200 Purchase Price Variance 50` (مدين 500 = دائن 500). ممنوع قيد الفرق على 6100 |
| GOLD-47 | **تكامل طريقة الدفع ↔ حساب الترحيل** | ممنوع إنشاء/تفعيل payment_method بلا posting_account_id صالح (رفض على مستوى التطبيق وFK مركّب على مستوى DB). دفعة "محفظة" تُنتج `Dr 1030 Wallet Clearing / Cr 1100 AR` — وليس Cash. تغيير حساب الترحيل لا يؤثر على القيود التاريخية |
| GOLD-48 | **استقلال ترقيم الفواتير لكل Business** | Tenant واحد + Business A وB: فاتورة في A ثم فاتورة في B ثم فاتورة في A → تسلسلا A وB مستقلان تمامًا (لا خلط tenant-level)، كل تخصيص ذرّي تحت التزامن، وترقيم credit_notes مستقل لكل Business أيضًا |
| GOLD-49 | **Onboarding ضمن ميزانية البساطة** | خطوة الدولة/العملة تحمل بالضبط: الدولة + العملة + لغة المتجر (3 حقول بحد أقصى)؛ منتقي لغة الواجهة على شاشة الترحيب لا يضيف خطوة سادسة؛ SIM-* لا تُنتهك (SIM-15) |
| GOLD-50 | **Credit Note USD → Refund EUR (cap بعملة المصدر)** | Accounting §5.1: Base ILS، CN=100 USD (دفتري 360 ILS)، استرداد 90 EUR @4.10. القيد حرفيًا: `Dr 2200 360، Dr 6900 9 / Cr Cash 369` (369=369). remaining_refundable = **0 USD** — ممنوع 100 USD − 90 EUR. الحقول: source_consumed=100 USD، carrying_released=360، refund_base=369، realized_fx=−9 |
| GOLD-51 | **Refund FX Gain** | CN دفتري 360 ILS، استرداد بنقد خارج 350 ILS معادلًا: `Dr 2200 360 / Cr Cash 350 / Cr 4900 10` (360=360) — الربح على 4900 وليس 6100 |
| GOLD-52 | **Refund FX Loss** | GOLD-50 ذاته: الخسارة 9 على 6900 حصرًا؛ رصيد 6100 لا يتغيّر |
| GOLD-53 | **تزامن استرداد عابر العملات** | طلبان متزامنان على CN بـremaining=100 USD: واحد فقط ينجح (FOR UPDATE على المصدر)؛ Σ consumed ≤ 100 USD بعملة المصدر مهما كانت عملتا الاسترداد |
| GOLD-54 | **مخزون سالب → cost catch-up** | Inventory §5أ: 0 بداية، oversell ‎−5 @ مؤقت 100 (COGS 500، دفتري ‎−500)، استلام 10 @120: catch_up=100 `Dr COGS 100 / Cr Inventory 100`؛ النهائي: on_hand=5، avg=120، valuation=600، GL Inventory=600 |
| GOLD-55 | **مخزون سالب بتكلفة مؤقتة صفر** | oversell ‎−5 @ مؤقت 0 (COGS=0)؛ استلام @120 → catch_up=5×120=600 كاملة `Dr COGS 600 / Cr Inventory 600`؛ GL=valuation بعدها |
| GOLD-56 | **GL Inventory = valuation بعد تسوية السالب** | بعد GOLD-54: Reconciliation يومي يؤكد GL(1200)=Σ(qty×avg)=600 بلا فرق؛ اختلاف مزروع يُكتشف |
| GOLD-57 | **مرتجع مورد — شراء غير مدفوع** | Case A (Accounting §9.1): `Dr AP 500 / Cr Inventory 450 / Cr PPV 50` (500=500) — AP ينخفض مباشرة |
| GOLD-58 | **مرتجع مورد — شراء مدفوع بالكامل** | Case B (§9.2): شراء 1000 مدفوع (AP=0)، avg=90، إرجاع 5: Supplier Credit Note `Dr 1150 500 / Cr Inventory 450 / Cr 6200 50` — ممنوع Dr AP بلا مقابل؛ لا Revenue |
| GOLD-59 | **مرتجع مورد — شراء مدفوع جزئيًا** | شراء 1000 دُفع 700 (AP=300)، مرتجع 500: `Dr AP 300 + Dr 1150 200 / Cr Inventory/PPV` — تقسيم المدين بين إطفاء الذمة والرصيد الدائن |
| GOLD-60 | **استرداد نقدي من المورد** | supplier_refund: `Dr Cash/Bank 500 / Cr 1150 500` (500=500) → رصيد Supplier Receivable يصفر |
| GOLD-61 | **رصيد مورد على شراء مستقبلي** | supplier_credit_allocation: شراء جديد 800 آجل + رصيد 500: `Dr AP 500 / Cr 1150 500`؛ السداد النقدي اللاحق 300 فقط؛ outstanding مشتق صحيح |
| GOLD-62 | **Idempotency — استرداد مكرر** | إعادة نفس Refund بنفس idempotency_key → تُرفض بـ`UNIQUE(business_id, idempotency_key)` على refunds؛ لا قيد ثانٍ ولا نقص مزدوج في remaining |
| GOLD-63 | **Idempotency — بيع Offline مكرر** | إعادة مزامنة نفس offline_local_id → تُرفض بـ`UNIQUE(business_id, offline_local_id)`؛ لا Sale ولا حركة مخزون مكررة |
| GOLD-64 | **Idempotency — رسالة واتساب مكررة** | إعادة إرسال بنفس idempotency_key → تُرفض بـ`UNIQUE(business_id, idempotency_key)` على whatsapp_messages؛ ويبهوك مكرر يُطابَق بـ(business_id, event_source, external_event_id) ويُتجاهل |
| GOLD-65 | **عكس دفعة مخصّصة يعيد فتح AR** | Accounting §5.2-A: فاتورة 1000 + دفعة 300 خاطئة → reverse_payment_allocation: `Dr AR 300 / Cr 2210 300` (300=300)؛ AR يعود 1000؛ Revenue لم يُمسّ؛ Allocation تُعلَّم reversed وإعادة عكسها مرفوضة |
| GOLD-66 | **عكس تخصيص جزئي من دفعة موزعة** | §5.2-B: دفعة 500 (A=300، B=200)؛ عكس B فقط → Invoice A دون تغيير، Invoice B AR +200، بلا عكس مزدوج |
| GOLD-67 | **عكس تخصيص متعدد العملات بالـSnapshots الأصلية** | §5.2-C: `Dr AR 1440، Dr 4900 40 / Cr 2210 1480` (1480=1480) — ممنوع إعادة الحساب بسعر اليوم؛ Customer Credit الناتج: source 370 EUR + carrying 1480 ILS؛ الرد اللاحق تسوية مستقلة (GOLD-81/82/83) — Reversal FX ≠ Refund FX |
| GOLD-68 | **Overpayment → Customer Credit لا Revenue** | فاتورة 1000 + دفعة 1200: تخصيص 1000 + `Dr Cash 200 / Cr 2210 200`؛ الإيراد يبقى 1000؛ الرصيد remaining=200 |
| GOLD-69 | **Customer Credit على فاتورة مستقبلية** | customer_credit_allocation: `Dr 2210 200 / Cr AR 200`؛ remaining يصفر بقفل؛ outstanding الفاتورة مشتق صحيح |
| GOLD-70 | **استرداد Customer Credit** | Refund مصدره customer_credit: `Dr 2210 / Cr Cash` بالقيمة الدفترية؛ cap بعملة المصدر؛ ثانية مرفوضة؛ الاستهلاك الأخير يصفّر remaining_amount وremaining_carrying_base معًا بالضبط (INV-ACC-17) |
| GOLD-71 | **استرداد Customer Credit عابر العملات** | نفس بنية §5.1 على customer_credit: source_consumed بعملة المصدر، تحرير بالقيمة الدفترية، فرق → 4900/6900؛ مبلغ المصدر بعملته ثابت لا يتغيّر بتغيّر السعر (انظر GOLD-81/82/83 للأمثلة الرقمية) |
| GOLD-72 | **مخزون سالب باستلامين بسعرين (Deficit Layers FIFO)** | Inventory §5أ: ‎−10 @100؛ استلام 4@120 (catch-up 80) ثم 6@130 (catch-up 180)؛ Final qty=0؛ GL Inventory=0؛ إجمالي COGS=1260=4×120+6×130 |
| GOLD-73 | **Supplier Credit Refund عابر العملات** | Accounting §9.3: CN مورد 100 USD (دفتري 360) ← استلام 90 EUR @4.10: `Dr Bank 369 / Cr 1150 360 / Cr 4900 9` (369=369)؛ remaining_credit = 0 USD |
| GOLD-74 | **Schema Lint: كل UNIQUE بأعمدة حقيقية** | اختبار آلي على الـMigrations الأولى: كل عمود في كل UNIQUE/CHECK/FK موجود فعلًا في تعريف جدوله؛ لا Literal؛ لا polymorphic FK في النواة المالية |
| GOLD-75 | **كيانات العجز موجودة في النموذج** | negative_inventory_deficits + negative_deficit_coverages معرّفتان فعليًا في Data Model §10ب بكل الأعمدة والـCHECKs والـFKs المركّبة — Review J |
| GOLD-76 | **استلامان متزامنان لا يغطّيان نفس العجز مرتين** | FOR UPDATE على الـdeficit داخل معاملة الاستلام: سباق تغطية على deficit واحد → واحد فقط يغطيه؛ uncovered_qty لا ينزل تحت الصفر |
| GOLD-77 | **FIFO حتمي عند تعادل التوقيت** | deficitان بنفس created_at: الترتيب بـdeficit_seq ثم id — الاستلام يغطي الأقدم تسلسليًا دائمًا؛ لا اعتماد على timestamp وحده |
| GOLD-78 | **تغطية جزئية تترك uncovered صحيحًا** | deficit 10؛ استلام يغطي 4 → uncovered=6، status=partially_covered، provisional snapshot للمتبقي دون تغيير |
| GOLD-79 | **استرداد جزئي من Customer Credit يترك الطرفين** | رصيد 370 EUR / carrying 1480؛ رد جزئي → يتبقى remaining_amount بعملة المصدر **و** remaining_carrying_base متناسبان معًا (تناسب السنابشوت الأصلي) |
| GOLD-80 | **الاستهلاك الأخير يصفّر الطرفين بالضبط** | بعد استهلاك المصدر كاملًا: remaining_amount=0 **و** remaining_carrying_base=0 تمامًا — بلا rounding drift (INV-ACC-17) |
| GOLD-81 | **Customer Credit بنفس العملة — رد كامل بسعر مغيّر** | §5.2-C الحالة A: رصيد 370 EUR / 1480 ILS؛ رد كامل 370 EUR @4.20: `Dr 2210 1480، Dr 6900 74 / Cr Bank 1554` (1554=1554)؛ المصدر 370 EUR لا يتغيّر بتغيّر السعر |
| GOLD-82 | **رد جزئي بنفس العملة 350/370 EUR** | الحالة B: `Dr 2210 1400، Dr 6900 70 / Cr Bank 1470` (1470=1470)؛ يتبقى **20 EUR مع carrying 80 ILS** — لا تصفير |
| GOLD-83 | **رد Customer Credit عابر العملات** | الحالة C: source_consumed=370 EUR، refund_currency=USD بسعر وقت الاسترداد؛ الفرق عن 1480 → 4900/6900؛ remaining=0 EUR/0 ILS عند الاستهلاك الكامل |
| GOLD-84 | **Supplier Credit جزئي عابر العملات مع باقٍ دفتري** | Credit 100 USD/360 ILS؛ استلام جزئي يستهلك 60 USD → تحرير تناسبي 216؛ يتبقى 40 USD مع 144 ILS؛ الأخير يحرّر 144 بالكامل |
| GOLD-85 | **Raw Payment مرفوض كمصدر Refund** | محاولة إنشاء Refund بلا credit_note_id/customer_credit_id → ترفض بالـCHECK (مصدر واحد بالضبط)؛ ومحاولة بمعرّف payment → غير ممكنة بنيويًا (لا عمود له) |
| GOLD-86 | **reverse_payment_allocation يبقي الأصل النقدي** | عكس تخصيص 300: `Dr AR 300 / Cr 2210 300` — رصيد Cash/Bank/Clearing **لا يتغيّر**؛ Customer Credit ينشأ؛ العكس المزدوج مرفوض |
| GOLD-87 | **payment_reversal يعكس الأصل النقدي** | §5.2ب: chargeback لدفعة بطاقة 300 مخصّصة: `Dr AR 300 / Cr 1020 300`؛ غير مخصّصة: `Dr 2210 / Cr Clearing` وإلغاء الرصيد؛ Revenue سليم؛ Idempotent بـprovider_reference |
| GOLD-88 | **State Machine بلا انتقال يناقض Source Model** | فحص آلي/يدوي: لا انتقال completed→refunded على Payment؛ حالة التخصيص مشتقة منفصلة؛ "تم الاسترداد" حالة عرض مشتقة فقط |

## قواعد التشغيل

1. كل Bug جديد يضيف سيناريو GOLD جديدًا إن كان يمس Core Flow (Master §65).
2. تُشغَّل السيناريوهات الحرجة (01,05,06,07,11,18,19,20,21,25,26,27,28,29,30,31,37..48,50..64) باللغات الثلاث والعملات السبع على دورات مجدولة.
3أ. سيناريوهات القيود (28,37,39,42,43,46,50,51,54,57,58,59,60,61) يجب أن تطابق **أسطر القيود المتوقعة حرفيًا** (الحساب والمبلغ والاتجاه) — فحص التوازن وحده غير كافٍ.
3. نتيجة الجناح تُرفق بكل Acceptance Report.
