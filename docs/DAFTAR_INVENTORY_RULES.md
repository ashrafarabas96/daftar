# DAFTAR — Inventory Rules / قواعد المخزون (v2 — بعد Correction & Hardening Pass)

## 1. مصدر الحقيقة

**Stock Ledger (stock_movements)** Append-only — مصدر الحقيقة الوحيد. كل حركة: (tenant_id, business_id, variant_id, warehouse_id, qty_delta NUMERIC(18,4), unit_cost_minor?, reason, source_type, source_id, actor, created_at, idempotency composite).

`stock_levels(on_hand, reserved, avg_cost)` = **Cache/Read Model** قابل لإعادة البناء من الحركات في أي وقت.

## 2. الكميات والوحدات (O)

- الكميات NUMERIC(18,4). المنتج له `unit_code` (piece/kg/meter/liter…) و`unit_decimals`.
- منتج بوحدة piece (unit_decimals=0) لا يقبل كسورًا — يُفرض في التطبيق + Row CHECK على تعريف المنتج.
- Core يدعم fractional quantities منذ التصميم — لا إعادة بناء مستقبلية.

## 3. أنواع الحركات (reason)

purchase (+) · sale (−) · return (+) · supplier_return (−) · adjustment (±) · damage (−) · transfer_out/transfer_in (زوج مترابط) · stocktake (±) · **offline_oversell_exception (−)** — سبب صريح مميّز (انظر §6) · **negative_inventory_cost_adjustment (± قيمة، بلا تغيير كمية)** — تسوية التكلفة المؤقتة عند تغطية الرصيد السالب (§5أ).

## 4. قواعد العمليات

### 4.1 البيع والتزامن
- حركة sale سالبة ضمن معاملة البيع، بالتكلفة المجمّدة من avg_cost لحظتها.
- الخصم الذري المشروط على مستوى DB: `UPDATE stock_levels SET on_hand = on_hand - :q WHERE (variant,warehouse) AND on_hand - reserved >= :q` داخل المعاملة؛ فشل الصف → رفض واضح "الكمية غير متوفرة".
- المنتجات غير المتتبعة لا تنتج حركات.

### 4.2 الحجوزات
- Reservation(active, expires_at) لـ `cart | order | offline_sale` فقط (كيانات موجودة — Cart معرّف في Data Model §14).
- المتاح = on_hand − Σreserved(active). الحجز لا يلمس on_hand. consumed عند التنفيذ، released/expired عند الإلغاء/الانتهاء (Job دوري).

### 4.3 المرتجعات والمشتريات والتحويلات والجرد
- مرتجع عميل: حركة return موجبة + عكس COGS **بتكلفة snapshot البيع الأصلية** (متسقة مع Accounting §4.7).
- استلام شراء: حركة purchase بالتكلفة الفعلية للبند.
- تحويل: زوج مترابط ذرّي بنفس المرجع، الكمية المنقولة تُقيَّم بـ**avg المصدر لحظة التحويل**؛ متوسط المصدر **لا يتغيّر**، ومتوسط الوجهة **يُعاد حسابه** بالصيغة — والتقييم الكلي محفوظ (§5).
- تسوية/تلف/جرد: سبب إلزامي + Audit.

## 5. سياسة التكلفة (N) — Moving Weighted Average لكل (variant × warehouse)

**مصدر الحقيقة للتكلفة = الحركات.** `stock_levels.avg_cost` Cache؛ `products.cost_minor` مرجع عرض أولي فقط؛ `sale_items.unit_cost_minor_snapshot` مجمّد دائمًا.

**تمثيل التكلفة:** كل الحسابات الداخلية بـ**`NUMERIC(28,10)`** (avg وحركة وsnapshot — انظر DATA_MODEL §10). ممنوع Float/Double مطلقًا، وممنوع التقريب المبكر إلى minor داخل الصيغ. التحويل إلى BIGINT minor يحدث **مرة واحدة فقط عند توليد القيد المحاسبي** (HALF_EVEN)، ويُوزَّع فرق التقريب على أسطر القيد (السطر الأكبر أولًا) بحيث **Σ COGS الأسطر = COGS المقيَّد تمامًا**، وأي فرق متبقٍّ ≤ عدد الأسطر minor يُقيد على 6100 Rounding Adjustment.

الصيغ (الحساب بدقة NUMERIC(28,10)؛ التحويل إلى minor عند القيد فقط):

| الحدث | الصيغة |
|---|---|
| استلام شراء (on_hand>0) | avg_new = (on_hand×avg + q×cost) / (on_hand+q) |
| استلام شراء يغطي رصيدًا سالبًا | **Negative Inventory Cost Catch-up Policy (§5أ)** — ممنوع "if on_hand≤0 → avg = cost" وحدها؛ تسوية التكلفة المؤقتة إلزامية أولًا |
| شراء ثانٍ بسعر مختلف | نفس الصيغة تراكميًا |
| بيع | COGS = q × avg لحظة البيع (يُجمَّد snapshot)؛ avg لا يتغير بالبيع |
| مرتجع عميل | يدخل بـ**تكلفة snapshot البيع الأصلي**: avg_new = (on_hand×avg + q×cost_snapshot)/(on_hand+q) |
| إرجاع لمورّد | يخرج بـavg الحالي (Cr Inventory = q×avg)؛ مدين AP **بقيمة الشراء الأصلية**؛ الفرق بين قيمة الشراء وavg الحالي = **Purchase Price Variance → حساب 6200** (وليس 6100 — 6100 للتقريب فقط). المثال الرقمي في Accounting §9 |
| تحويل بين مستودعات | المصدر: on_hand−=q بـavg المصدر، **avg المصدر لا يتغيّر** (إخراج كمية بلا تكلفة جديدة). الوجهة: avg_dest_new = (on_hand_dest×avg_dest + q×avg_source)/(on_hand_dest+q) — **قد يتغيّر ويجب أن يُعاد حسابه**. القيمة الكلية محفوظة: ΔValuation الكلي = 0 بالضبط (بتمثيل NUMERIC(28,10) بلا تقريب وسيط) |
| تسوية/جرد | تغيير الكمية بـavg الحالي (قيمة التسوية = Δq × avg) — قيد Inventory مقابل حساب تسويات |
| شراء بعملة أجنبية | cost يُحوَّل للعملة الأساسية بـfx snapshot لحظة الاستلام، ثم الصيغة بالعملة الأساسية |

**INV-INV-06 (جديد):** GL Inventory(1200) = Σ(qty × avg_cost) لكل (variant,warehouse) — Reconciliation يومي، اختلاف → Alert بلا تصحيح صامت.

### 5أ. Negative Inventory Cost Catch-up Policy — محسومة (Pass#3)

الرصيد السالب ممكن فقط عبر (إعداد Business الصريح) أو (`offline_oversell_exception`). عندها تُسجَّل حركة البيع بـ**تكلفة مؤقتة (provisional)** = آخر avg معروف، أو 0 إن لم يوجد. القيمة الدفترية تصبح سالبة (on_hand سالب × تكلفة مؤقتة).

**عند وصول استلام شراء يغطي الكمية السالبة — إلزاميًا وبالترتيب الذرّي داخل معاملة الاستلام:**

1. تحديد `covered_qty = min(|on_hand السالب|, qty المستلمة)`.
2. `catch_up_amount = covered_qty × (actual_cost − provisional_cost)` (بالـNUMERIC(28,10)).
3. إنشاء حركة **`negative_inventory_cost_adjustment`** (سبب مميّز مدقّق — Audit كامل) بقيمة catch-up، **تُعدّل COGS** لا المخزون الافتتاحي:
   - actual > provisional: `Dr COGS(5000) catch_up / Cr Inventory(1200) catch_up`
   - actual < provisional: القيد معكوس.
4. بعد التغطية: الوحدات المتبقية تُقيَّم بـactual cost، وavg الجديد للرصيد الموجب المتبقي = **actual_cost** (الصيغة العادية تُطبَّق على الجزء الذي يتجاوز التغطية إن وجد).

**المثال الملزم (Review G / GOLD-54):** مخزون 0، آخر تكلفة 100. Oversell ‎−5 (COGS مؤقت 500، قيمة دفترية ‎−500). استلام 10 @ 120 (Dr Inventory 1200):
- covered = 5؛ catch_up = 5 × (120−100) = **100** → `Dr COGS 100 / Cr Inventory 100`.
- GL Inventory = ‎−500 + 1200 − 100 = **600**؛ المتبقي الفعلي 5 × 120 = **600** → **GL = valuation ✓ (INV-INV-06 محفوظ)**؛ avg = 120.
- بدون هذه السياسة: GL 700 ≠ valuation 600 — ممنوع.

**حالة provisional = 0 (GOLD-55):** بيع سالب بلا تكلفة معروفة → COGS مؤقت 0؛ الاستلام @120 يولّد catch_up = 5 × 120 = 600 كاملة `Dr COGS 600 / Cr Inventory 600`، وGL = valuation بعدها.

**قاعدة الاستلام الجزئي المتعدد — Negative Deficit Layers (محسومة، Pass#4):**
- كل حركة بيع سالبة تنشئ **Deficit Layer** موثّقًا: `(movement_id الأصلية, qty السالبة, provisional_cost_snapshot, qty_uncovered)`.
- كل استلام شراء يُخصَّم أولًا لتغطية أقدم Deficit Layers المفتوحة **بترتيب FIFO حتمي** (الأقدم زمنيًا أولًا) — الربط يُسجَّل صراحة (`negative_deficit_coverages: receipt_movement_id, deficit_movement_id, qty_covered, catch_up_amount`).
- كل تغطية تولّد catch-up الخاص بها: `qty_covered × (actual_cost − provisional_cost)`؛ الرصيد السالب المتبقي يحتفظ بـprovisional snapshot الأصلي حتى يُغطى لاحقًا — **لا إعادة تقييم للمتبقي**.
- بعد صفر العجز، أي فائض استلام يدخل بالصيغة العادية.

**المثال الملزم (GOLD-72):** on_hand = ‎−10 @ provisional 100. استلام 4 @120 ثم 6 @130:
- الاستلام الأول: يغطي 4 → catch_up = 4 × (120−100) = **80**؛ العجز المتبقي 6 @ provisional 100.
- الاستلام الثاني: يغطي 6 → catch_up = 6 × (130−100) = **180**؛ العجز = 0.
- Total catch-up = 260؛ Final qty = 0؛ GL Inventory = ‎−1000 + (4×120) + (6×130) − 260 = ‎−1000 + 480 + 780 − 260 = **0** = valuation (صفر مخزون) ✓.
- إجمالي COGS = provisional الأصلي 1000 + 260 = **1260** = 4×120 + 6×130 = **1260** ✓ — التكلفة الفعلية الكاملة وصلت COGS دون فقدان.

السياسة واحدة وتغطي الحالتين (offline_oversell_exception والسماح الصريح بالسالب)، وهي Deterministic وتحقق INV-INV-06 دائمًا.

**مثال التحويل الرقمي الملزم (GOLD-44):** مستودع A: 10 وحدات @ avg=100؛ مستودع B: 10 وحدات @ avg=200. تحويل 5 من A→B:
- A: on_hand=5، avg_A = 100 (**لم يتغيّر**) → قيمة A = 500.
- B: avg_B = (10×200 + 5×100)/15 = 2500/15 = 166.6666666667 (NUMERIC(28,10)) → قيمة B = 2500.
- التقييم الكلي قبل = 1000+2000 = **3000**؛ بعد = 500+2500 = **3000** ✓ محفوظ تمامًا.
- ممنوع أن يبقى avg_B = 200 (تجاهل إعادة الحساب)، وممنوع أن يتغيّر avg_A.

## 6. سياسة المخزون السالب وOffline Oversell (M) — موحّدة ومحسومة

**سياسة واحدة:** Negative stock **ممنوع** افتراضيًا، ولا يحدث إلا في حالتين موثقتين:
1. Business فعّل صراحة "السماح بالبيع بالسالب" (إعداد افتراضيًا مغلق).
2. **`offline_oversell_exception`**: بيع Offline **حدث فعليًا** (التاجر سلّم البضاعة للعميل) ثم اكتشف الخادم عند المزامنة أن المخزون لم يعد كافيًا.

عند الاستثناء (2):
- **حقيقة البيع الفعلية تُحفظ ولا تُفقد** — لا رفض لعملية تمّت في الواقع.
- تُنشأ حركة بالسبب الصريح `offline_oversell_exception` حتى لو جعلت الرصيد سالبًا مؤقتًا.
- تُسجَّل AuditEvent كاملة + العملية تُعلَّم **needs_attention**.
- **Alert واضح للمالك** (إشعار + بند في لوحة "يحتاج انتباهك").
- يُمنع أي بيع جديد للصنف (إن كان السالب غير مسموح) حتى التسوية (شراء/تسوية جرد).
- القيد المحاسبي للـCOGS يتم بـavg الحالي أو صفر مع قيد تسوية موثّق عند عدم وجود تكلفة.

**INV-INV-01 (محدّث):** on_hand − reserved ≥ 0 لكل بيع، **إلا** بـ(إعداد Business الصريح) أو (استثناء offline_oversell_exception مدقّق). لا تناقض بين القاعدة والتنفيذ — والسيناريو مغطى بـGOLD-25.

## 7. Offline Sync

- العملية المحلية Pending ولا تُحذف قبل تأكيد الخادم (Master §101).
- Idempotency: `UNIQUE(business_id, offline_local_id)` على جدول العمليات المستقل — نوع العملية معروف من الجدول نفسه (لا Literal داخل UNIQUE).
- التعارضات: مخزون → §6؛ سعر/صلاحية متغيّرة → needs_attention بلا تنفيذ صامت.

## 8. Reconciliation

يومي: cache مقابل Σmovements (INV-INV-03)، وGL مقابل valuation (INV-INV-06). اختلاف → Alert فقط.

## 9. Invariants (v2)

| # | Invariant |
|---|---|
| INV-INV-01 | لا مخزون سالب إلا (إعداد صريح) أو (offline_oversell_exception مدقّق) |
| INV-INV-02 | كل حركة لها سبب ومصدر ومستخدم ووقت |
| INV-INV-03 | stock_levels قابل لإعادة البناء من movements |
| INV-INV-04 | الحجز لا يغيّر on_hand |
| INV-INV-05 | التحويلات زوج ذرّي متطابق الكمية والمرجع، وقيمة الزوج = q × avg_المصدر |
| INV-INV-06 | GL Inventory = valuation وفق السياسة (مع INV-ACC-11) |
| INV-INV-07 | البيع لا يغيّر avg. التحويل: **avg المصدر لا يتغيّر، avg الوجهة يُعاد حسابه بالصيغة، والتقييم الكلي محفوظ** (ΔValuation = 0). avg يتغيّر فقط بالإدخالات المُكلفة (شراء/مرتجع/تحويل وارد لدى الوجهة) |
| INV-INV-08 | كل التكاليف NUMERIC(28,10) داخليًا؛ التقريب إلى minor مرة واحدة عند القيد مع توزيع الفرق على الأسطر؛ ممنوع Float/Double |
| INV-INV-09 | أي رصيد سالب يُغطَّى باستلام يمر إلزامًا عبر Cost Catch-up (§5أ) — ممنوع "if on_hand≤0 → avg=cost" دون تسوية؛ GL=valuation يبقى صحيحًا دائمًا (GOLD-54/55) |
