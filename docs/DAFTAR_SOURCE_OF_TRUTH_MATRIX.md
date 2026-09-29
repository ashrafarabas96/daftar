# DAFTAR — Source of Truth Matrix / مصفوفة مصادر الحقيقة (Phase 0 Final)

> قاعدة ملزمة: **كل رصيد مشتق** من مصادره — ممنوع `customer.balance +=` / `supplier.balance +=` / `stock -=` كمصدر حقيقة. أي Cache (stock_levels, Dashboard) قابل لإعادة البناء ويُتحقق منه بـReconciliation.

## 1. المصفوفة

| المفهوم | مصدر الحقيقة الوحيد | المعادلة المشتقة | Read Model/Cache |
|---|---|---|---|
| **ذمة العميل (AR)** | `invoices` + `payment_allocations`(active) + `credit_notes` + عكسياتها | outstanding = invoice.total − Σallocations(active, بعملة الفاتورة) − Σcredit_notes المطبقة + Σallocations المعكوسة (reopened) | receivables (مشتق محفوظ، يُتحقق يوميًا) |
| **رصيد العميل الدائن** | `customer_credits` + `customer_credit_allocations` + `refunds` | remaining = original − Σallocations.consumed − Σrefunds.consumed (بعملة المصدر) — ومعه remaining_carrying_base بالأساسية (§7ج) | لا يدوي — يتحرك بأوامر المجال فقط |
| **ذمة المورّد (AP)** | `purchases` + `supplier_payment_allocations`(active) + `supplier_credit_allocations` | outstanding = purchase.total − Σsupplier_payment_allocations(active) − Σsupplier_credit_allocations | لا `supplier.balance` يدوي |
| **رصيد المورّد الدائن (Supplier Credit)** | `supplier_credit_notes` + `supplier_credit_allocations` + `supplier_refunds` | remaining = original − Σallocations − Σrefunds (بعملة المصدر) + remaining_carrying_base | — |
| **الشراء** (P3-S4) | `purchases` + `purchase_items` + `purchase_landed_costs` | القيد `Dr Inventory / Cr AP` دائمًا؛ المستحق مشتق — **لا مسار نقدي موازٍ** (P3-AL-24) | لا Cache: قراءة حية (P3-AL-26) |
| **تهيئة المخزون الافتتاحي** (P3-S3) | مصدر `inventory_opening` + حركاته | الحالة A: قيد `Dr Inventory / Cr Opening Equity`. الحالة B: **لا قيد** — ربط بالمركز الافتتاحي القائم واشتراط المساواة التامة | — |
| **الجرد** (P3-S3) | `stocktakes` + `stocktake_lines` | variance = counted − expected_at_capture؛ يُطبَّق مرة واحدة عند الإنهاء ويُقيَّم بمتوسط اللحظة | — |
| **كمية المخزون** | `stock_movements` (append-only) | on_hand = Σ`qty_delta` لكل (business × warehouse × variant) بترتيب `stock_seq` | stock_levels (Cache، INV-INV-03) — **الاستثناء الوحيد المسمّى** من استراتيجية «القراءة الحية»، مُبرَّر بالتزامن التشغيلي لا بسرعة التقارير (P3-AL-44) |
| **تكلفة المخزون** | تقييم الحركات: `value_delta_base_minor` **BIGINT** (وحدات صغرى صحيحة) لكل حركة (بما فيها حركات القيمة الصرفة) + `negative_deficit_coverages` | valuation = Σ`value_delta_base_minor` (جمع أعداد صحيحة مخزَّنة، بلا ضرب ولا قسمة ولا تقريب)؛ avg = `HALF_EVEN(valuation ÷ on_hand, 10)` حيث on_hand ≠ 0؛ **وسطر القيد المحاسبي هو نفس العدد المخزَّن، فالمطابقة مقارنة أعداد صحيحة بلا أي تقريب** (P3-AL-49) | `stock_levels.valuation_base_minor BIGINT` (Cache) و`stock_levels.avg_unit_cost_base_minor` (مشتقّ) — **وممنوع اشتقاق التقييم من `on_hand × avg` في أي مسار** |
| **GL** | `journal_entries` + `journal_lines` (append-only) | أرصدة الحسابات = Σ أسطر القيود | **لا Read Model على الإطلاق (P2-S7)**: كل رقم يُحسب لحظة السؤال من القيود نفسها. لا رصيد مخزَّن، ولا Cache، ولا Materialized View. INV-ACC-11 GL Inventory = valuation |
| **التسوية اليدوية** (P2-S4) | `accounting_manual_adjustments` + القيد المرتبط بها عبر `accounting_source_bindings` | القيد هو الواقعة؛ صف التفصيل يحمل السبب والفاعل فقط | — |
| **عكس قيد** (P2-S4) | `accounting_reversals` + القيد الجديد `source_type='reversal'` | سطور العكس **مشتقة** من `journal_lines` للقيد الأصلي: مبادلة مدين/دائن وكل ما عداه منسوخ حرفيًا بما فيه سعر الصرف ووقته ومصدره | — |
| **الرصيد الافتتاحي** (P2-S4) | `accounting_opening_balances` + `accounting_opening_balance_lines` | سطر حقوق الملكية الموازن (`opening_equity`) **مشتق** من مراكز التاجر ولا يُصرَّح به؛ مجموعة واحدة فقط بحالة `posted` لكل نشاط | — |
| **التقارير المالية** (P2-S7) | `journal_entries` + `journal_lines` وحدهما | ميزان المراجعة ودفتر الأستاذ والأرصدة كلها Σ لأسطر القيود عند القراءة؛ اتجاه كل حساب من نوعه (أصل/مصروف مدين، التزام/حقوق/إيراد دائن) | — لا شيء يُخزَّن. `0050` فهرسان فقط: طريق أسرع إلى القيود، لا نسخة منها |
| **النقد/البنك/Clearing** | أسطر القيود على حسابات 1000/1010/1020/1030/1040 | رصيد الحساب = Σdebit − Σcredit | — |
| **المتاح للبيع** | on_hand − Σreservations(active) | مشتق لحظي | — |
| **حالة الفاتورة** | `invoices` + allocations + void | open/partially_paid/paid/voided — مشتقة من المعادلة لا تُحرَّر يدويًا | — |
| **حالة الدفعة** | `payments` + `payment_reversals` | pending/failed/completed/partially_reversed/reversed — reversed مشتقة من Σreversals | حالة العرض "تم الاسترداد" مشتقة من refunds/credits |
| **Idempotency** | مفاتيح UNIQUE لكل جدول عمليات | — | — |

## 2. محظورات صريحة

1. ممنوع أي عمود `balance` قابل للكتابة اليدوية على customer/supplier/product.
2. ممنوع تحديث `stock_levels` مباشرة من الواجهة — يُبنى من الحركات فقط.
3. ممنوع قيد محاسبي بلا مصدر (source_type/source_id) — Posting Engine Idempotent بـUNIQUE(business_id, source_type, source_id). الهوية المالية هي هذه الثلاثية وحدها؛ مفتاح `Idempotency-Key` في HTTP وسيلة نقل فقط ولا يُخزَّن كهوية مالية (P2-S4 §11).
4. ممنوع أي "تصحيح صامت" — كل Reconciliation discrepancy → Alert.
5. ممنوع تعديل أو حذف قيد مُرحَّل، وممنوع وضع علامة "معكوس" عليه — التصحيح واقعة محاسبية جديدة (P2-S4 §61).
6. ممنوع تخزين أي رصيد محاسبي أو تجميعه مسبقًا: لا عمود رصيد، ولا جدول مُلخَّص (`accounting_balances`, `trial_balance_cache`, `ledger_cache`, `balance_snapshots`)، ولا Materialized View، ولا رصيد في Redis. الحارسان G-3 وG-6 يرفضان ذلك في الـCI (P2-S7 / AL-15).
7. ممنوع أن تكتب أي قراءة مالية أي شيء: لا إصلاح متأخر، ولا ختم «آخر اطّلاع»، ولا إعادة حساب سعر صرف قديم، ولا إخفاء حساب أُوقف عن التاريخ. الحارس G-6 يرفض ذلك في الـCI (P2-S7).
9. **(P3)** ممنوع أي عمود رصيد مرجعي على المورّد، وممنوع Cache لرصيد المورّد أو لمستحق الشراء في المرحلة 3 — قراءة حية مشتقة فقط. الحارس `scripts/guards/no-authoritative-balance.ts` يُوسَّع ليشمل جداول الموردين.
10. **(P3)** ممنوع تصحيح يدوي لـ`stock_levels`: لا نقطة نهاية، ولا أمر إداري، ولا سكربت يضبط قيمة الـcache إلى رقم مُعطى. القيمة تتغيّر بحركة أو بإعادة بناء من الحركات فقط، واختلاف المطابقة **ينبّه ويرفض** ولا يكتب رأي الـGL في الـcache.
11. **(P3)** ممنوع ترتيب أي شيء ماليّ الأثر بـ`created_at`: ترتيب الحركات `stock_seq`، وترتيب تغطية العجز `(deficit_seq, id)`.
12. **(P3)** ممنوع حساب تقييم مخزون من `on_hand × avg_unit_cost` في أي أمر أو إعادة بناء أو تقرير أو مطابقة أو نموذج قراءة — المتوسط خارج قسمةٍ مقرَّبة، والتقييم مجموع قيمٍ مخزَّنة (P3-AL-49).
13. **(P3)** ممنوع إعادة حساب قيمة حركة تاريخية بعد كتابتها: `value_delta_base_minor` يُقرَّب مرة واحدة عند الحركة ثم يصبح هو المرجع (P3-AL-49 §B). و**مسموح** للمتوسط أن يكون مُدخل التكلفة لحركة خارجة لاحقة؛ الممنوع المطلق هو إعادة بناء التقييم الكلي منه.
13ب. **(P3)** ممنوع أي تقريب داخل المطابقة، عند أي مستوى تجميع. القاعدة القديمة «اجمع بـNUMERIC(28,10) ثم حوّل مرة واحدة» **مسحوبة**: التقريب ليس تجميعيًا — عمليتان بـ`0.6` تعطيان الدفتر العام `2` بينما تقريب المجموع `1`، وعمليتان بـ`0.4` تعطيانه `0` بينما تقريب المجموع `1` (مقيسًا على PostgreSQL 16).
13ج. **(P3)** ممنوع سطر `6100 Rounding Adjustment` على قيد مخزون: لا يوجد فرق تقريب أصلًا لأن القيمة صحيحة قبل الترحيل.
14. **(P3)** ممنوع `source_type` نصًّا حرًّا في `stock_movements` — مفتاح أجنبي إلى سجل مغلق `stock_source_types`، واكتمال المصدر يُتحقَّق عند `COMMIT` لا بالاتفاق على أن الأمر يكتب الصفّين معًا (P3-AL-50/P3-AL-51).
8. ممنوع أن يُعاد قيد موجود كـ"نجاح" لطلب مالي مختلف: نفس هوية المصدر مع **حمولة مالية مختلفة جوهريًا** (أي حقل من حقول `acctfp/1`) تُرفض بـ`accounting.idempotency_conflict`. الاختلاف السردي وحده (الوصف، معرّف الطلب) هو نفس الواقعة ويُعاد بـ`created=false`، والسرد المحفوظ لا يُعاد كتابته. أول واقعة مالية مُرحَّلة هي التي تفوز (P2-S4 §29).

## 3. الارتباط بالاختبارات

INV-ACC-01..18 · INV-INV-01..09 · GOLD-01..88 — كل صف في هذه المصفوفة مغطى باختبار Golden و/أو Reconciliation يومي مسمّى.
