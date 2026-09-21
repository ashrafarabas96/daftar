# DAFTAR — PHASE 0 FINAL HARDENING REPORT (Pass #2)

> التاريخ: 2026-09-19 · النطاق: توثيق فقط — **لا Coding، لا Migrations، لا Phase 1.**
> المدخل: المراجعة المستقلة الثانية — 12 نقطة تحصين إلزامية + 13 اختبار Golden جديدًا + Review E (تحقق رياضي محاسبي صريح).

## 1. خلاصة تنفيذ النقاط الـ12

| # | النقطة | الحالة | أين عولجت |
|---|---|---|---|
| 1 | قيد المرتجع الجزئي متوازن سطرًا بسطر + اختبار أسطر حرفي | ✅ | Accounting §4.7: CN `Dr 4100 Sales Returns 500 + Dr 2100 Tax Payable 45 = 545` مقابل `Cr 4200 Discounts 50 + Cr 2200 Refund Liability 495 = 545` ✓؛ GOLD-28 يختبر **الأسطر المتوقعة حرفيًا** (الحساب/المبلغ/الاتجاه) وليس التوازن فقط |
| 2 | Refundable Source Model بلا Double Counting | ✅ | Accounting §5 + Data Model §7: `refund_source_type IN (credit_note|payment)` + `refund_source_id` إلزاميان؛ `remaining_refundable` على كل مصدر؛ قفل `SELECT…FOR UPDATE` داخل المعاملة؛ ممنوع تجميع paid+credit. Golden cap: **496 FAIL / 495 PASS / ثانية 1 FAIL** (GOLD-40) + منع التزامن (GOLD-41) |
| 3 | إعادة تصميم التسوية متعددة العملات | ✅ | Accounting §6 + Data Model §7 + Multi-Currency §5: نموذج ثلاثي العملات — `payment_to_base_rate NUMERIC(20,10)` → payment_base؛ `invoice_historical_to_base_rate` → `invoice_carrying_base_amount_released`؛ `realized_fx_gain_loss_minor = payment_base − carrying_released` على **4900/6900** (منفصلان تمامًا عن 6100 rounding). مطبَّق على AR وsupplier_payment_allocations والاستردادات. مثال محسوب: Base ILS، فاتورة USD 1000 @3.60، تسوية USD 400 بسعر 3.70 عبر 370 EUR @4.00: `Dr Bank 1480 / Cr AR 1440 / Cr FX Gain 40` (1480=1480 ✓) |
| 4 | إصلاح INV-ACC-09 | ✅ | Accounting §10: المقارنة دائمًا في العملة الأساسية: payment_base = carrying_released + realized_fx ± rounding موثّق — **ممنوع مقارنة عملتين مباشرة** |
| 5 | تناقض التحويل/متوسط التكلفة | ✅ | Inventory §5 + INV-INV-07 المحدّث: الكمية تُقيَّم بـavg المصدر؛ **avg المصدر لا يتغيّر**؛ **avg الوجهة يُعاد حسابه**؛ ΔValuation الكلي = 0. مثال GOLD-44: A عشرة@100، B عشرة@200، تحويل 5 → avg_A=100 ثابت، avg_B=2500/15، القيمة الكلية 3000 قبل وبعد ✓ |
| 6 | دقة تكلفة المخزون | ✅ | Data Model §10 + Inventory §5: `avg_unit_cost / movement_unit_cost / sale_item_unit_cost_snapshot = NUMERIC(28,10)`؛ ممنوع Float/Double وممنوع BIGINT minor داخليًا؛ التحويل إلى minor مرة واحدة عند القيد (HALF_EVEN) مع **توزيع فرق التقريب على الأسطر** بحيث Σ أسطر COGS = COGS المقيَّد تمامًا؛ المتبقي ≤ عدد الأسطر → 6100 (INV-INV-08, GOLD-45) |
| 7 | فرق إرجاع المورد → PPV | ✅ | Accounting §9 + CoA: حساب **6200 Purchase Price Variance** مستقل. المثال: شراء 10@100 ثم 10@80 (avg=90)، إرجاع 5 بسعر الشراء 100: `Dr AP 500 / Cr Inventory 450 / Cr PPV 50` (500=500 ✓) — ممنوع قيده على 6100 (INV-ACC-12) |
| 8 | ربط طريقة الدفع بحساب GL | ✅ | Data Model §13 + Accounting §8: `payment_methods.posting_account_id` (FK مركّب بـbusiness_id) **إلزامي للنشط ماليًا**؛ نقدي→1000، بطاقة→1020، محفظة→1030، شيك→1040؛ رفض الإنشاء/التفعيل بلا حساب (GOLD-47, INV-ACC-13) |
| 9 | نطاق ترقيم الفواتير | ✅ | Data Model §14أ: `invoice_sequences UNIQUE(business_id, sequence_key)` — **Business-level كحد أدنى إلزامي**؛ ممنوع تسلسل tenant-level؛ الـCountry Pack يقرر نوع التسلسل/البادئة فقط دون تغيير نطاق العزل. **OD-05 مغلق**. GOLD-48 |
| 10 | لغة Onboarding | ✅ | Product Spec §5.1 v3 + UX §1ب + SIM-15 + Design §6.1 + Localization: منتقي **لغة واجهة** فوري على الترحيب؛ **لغة المتجر** حقل ثالث في خطوة الدولة/العملة (3 حقول بالضبط — لا خطوة سادسة)؛ الثلاثة (واجهة/متجر/دولة) مستقلة؛ لغة المتجر قابلة للتعديل لاحقًا؛ العملة الأساسية تُقفل بعد أول معاملة. GOLD-36 محدّث + GOLD-49 |
| 11 | تصحيح عدّاد السيناريوهات | ✅ | Correction Report: GOLD-25..36 = **12 سيناريو** (وليس 13) — صُحّح في الموضعين |
| 12 | أمثلة Void صريحة | ✅ | Accounting §7: **A)** نقدية مدفوعة بالكامل 1000: CN `Dr 4100 1000 / Cr 2200 1000` + مخزون `Dr 1200 600 / Cr 5000 600` + Refund `Dr 2200 1000 / Cr Cash 1000`. **B)** آجلة 1000 دُفع 300: CN `Dr 4100 1000 / Cr AR 700 / Cr 2200 300` + Refund 300 من مصدر CN فقط. GOLD-42/43 |

## 2. اختبارات Golden الجديدة (13)

GOLD-37 (تسوية ثلاثية) · GOLD-38 (FX Gain ≠ rounding) · GOLD-39 (FX Loss) · GOLD-40 (سقف CN refundable) · GOLD-41 (منع استرداد مزدوج متزامن) · GOLD-42 (void مدفوع بالكامل) · GOLD-43 (void آجل جزئي) · GOLD-44 (تقييم التحويل) · GOLD-45 (MWAC عالي الدقة كسوري) · GOLD-46 (PPV إرجاع مورد) · GOLD-47 (payment method ↔ GL) · GOLD-48 (تسلسلات مستقلة لكل Business) · GOLD-49 (Onboarding ضمن ميزانية البساطة). + تحديث GOLD-28 بأسطر القيود الحرفية وGOLD-36 باللغة.

## 3. المراجعات الخمس

- **Review A — Master Prompt Compliance: PASS** — لا تعارض مع Master V3؛ العملة الأساسية Business-level ثابتة (§31)؛ Money BIGINT minor + NUMERIC FX (§30/32).
- **Review B — Security, Architecture & Regression: PASS** — عزل ثنائي المستوى + Composite FKs؛ idempotency scoped؛ قفل التزامن على مصادر الاسترداد؛ 25 سيناريو Golden إضافيًا (25..49) مربوطة بالمخاطر.
- **Review C — Data & Constraint Reality: PASS** — لا CHECK على مجاميع؛ NUMERIC(28,10)/NUMERIC(20,10) فقط؛ UNIQUE(business_id, sequence_key) ذرّي؛ FKs مركّبة بما فيها posting_account_id.
- **Review D — Cross-Document Consistency: PASS** — فُحصت مراجع §/الحسابات (6100/6200/4900/6900/2200/clearing 1020-1040) عبر Accounting ↔ Data Model ↔ Inventory ↔ Multi-Currency ↔ Transaction Map ↔ State Machines ↔ Golden Suite ↔ Test Strategy؛ صُحّحت مرجعية State Machines إلى Accounting §7؛ لا مصطلح متبقٍّ من النموذج القديم (fx_rate المفرد، refundable المجمّع).
- **Review E — Accounting Mathematical Verification: PASS** — كل مثال رقمي بمجاميع صريحة:
  - بيع 1000 بخصم: Dr 990+100=1090 = Cr 1000+90=1090 ✓
  - مرتجع جزئي CN: Dr 500+45=545 = Cr 50+495=545 ✓
  - مخزون المرتجع: 300=300 ✓ · الاسترداد: 495=495 ✓
  - تسوية ثلاثية: Dr 1480 = Cr 1440+40 ✓
  - FX Loss (GOLD-39): Dr 1400+40=1440 = Cr 1440 ✓
  - Void A: 1000=1000، 600=600، 1000=1000 ✓
  - Void B: Dr 1000 = Cr 700+300 ✓
  - PPV: Dr 500 = Cr 450+50 ✓
  - تحويل المستودعات: 1000+2000=3000 قبل؛ 500+2500=3000 بعد ✓

## 4. الوثائق المحدَّثة في هذا Pass

Accounting Rules (v3 إعادة كتابة) · Data Model (§7/10/13/14أ) · Inventory Rules (§5 + INV-INV-05/07/08) · Multi-Currency (v3) · Golden Suite (v3: GOLD-28/36..49) · Test Strategy (§3.6 v3 + أ/ب/و) · Transaction Map (§3/7/8/9) · State Machines (مرجعية §7) · Product Spec (§5.1 v3) · UX (§1ب) · Simplicity (SIM-15) · Design System (§6.1) · Localization (لغات Onboarding) · Open Decisions (OD-05 مغلق) · Correction Report (العدّاد 12) · Traceability Matrix (HARD-01..12 — الإجمالي 138 متطلبًا).

## 5. ما لم يُحسم (مفتوح بشفافية — لا يمنع PASS)

القرارات المفتوحة المتبقية فعليًا: OD-02، OD-03، OD-04، OD-06، OD-07، OD-08، OD-09، OD-10، OD-11 (مزوّد واتساب، الضرائب التفصيلية، بوابات الدفع، الخط اللاتيني، FX revaluation، التقويم الهجري، تعدد لغات storefront، RBAC المخصص، مزوّد أسعار الصرف) — لكلٍّ توصية هندسية موثّقة ولا يتطلب أيٌّ منها حسمًا قبل Phase 1. (OD-01/OD-05/OD-12 مغلقة.)

## 6. إيقاف

توقف كامل بعد هذا التقرير وتحديث Acceptance Report. **لا Phase 1، لا Coding، لا Migrations** حتى أمر جديد من المالك.
