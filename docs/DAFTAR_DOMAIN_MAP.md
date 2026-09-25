# DAFTAR — Domain Map / خريطة النطاقات

## 1. المبدأ

Modular Monolith بحدود Domain واضحة. كل Module يملك بياناته ومنطقه، ويتواصل مع الآخرين عبر **واجهات رسمية** (Application Services) أو **Domain Events** عبر Outbox. ممنوع: Giant Services، ممنوع الوصول المباشر لجداول Module آخر، وممنوع Circular Dependencies.

## 2. النطاقات وحدودها ومصدر الحقيقة

| # | Domain | المسؤولية | يملك (Source of Truth) | يعتمد على | يُصدِر أحداثًا |
|---|---|---|---|---|---|
| 1 | Identity & Access | هوية عالمية للمستخدم + عضويات | User(identity), memberships, membership_roles, business_roles, role_permissions, **`member_branch_scopes`** + `memberships.branch_scope_mode`, Session, MFA | Tenancy | user.created |
| 2 | Tenancy | الحسابات والأنشطة والفروع والمستودعات | Tenant (اشتراك/عزل), **Business (country, base_currency, timezone, default_locale, storefront)**، Branch، Warehouse (يتبع Business؛ للفرع default_warehouse اختياري) | — | tenant.provisioned |
| 3 | Catalog | المنتجات، المتغيرات، التصنيفات، الترجمات، الصور، الأسعار الحالية | Product, ProductVariant, ProductTranslation, Category, Media | Tenancy | product.created/updated |
| 4 | Inventory | حركات المخزون، الجرد، التسويات، التحويلات، التنبيهات (والحجوزات لاحقًا) | StockMovement, Stocktake, cached quantity **+ valuation** (كلاهما قابل لإعادة البناء من الحركات وحدها)، سجل مصادر الحركة وربطها، كيانات العجز | Catalog, Tenancy | stock.low, stock.movement.recorded |
| 5 | Sales | عمليات البيع، الفواتير، البنود، الخصومات، المرتجعات | Sale, SaleItem, Invoice, Return, CreditNote | Catalog, Inventory, Customers, Accounting | sale.completed, sale.returned |
| 6 | Payments | الدفعات، طرق الدفع، التسويات | Payment, PaymentMethod | Sales (Receivable view), Accounting | payment.recorded, refund.completed |
| 7 | Receivables & Debts | الذمم، الأرصدة المشتقة، كشوف الحساب | Receivable (مشتق: Invoice − Payments) | Sales, Payments | receivable.overdue |
| 8 | Installments | خطط التقسيط والأقساط والتذكيرات | InstallmentPlan, Installment | Receivables, Payments | installment.due, installment.late |
| 9 | Purchases & Suppliers | الموردون، فواتير الشراء، الذمم الدائنة (المرحلة 3) | Supplier, Purchase, PurchaseItem, **supplier_payments, supplier_payment_allocations**، Payable (مشتق: Purchases − Allocations) | Inventory, Accounting | purchase.received |
| 10 | Expenses | المصروفات التشغيلية | Expense | Accounting | expense.recorded |
| 11 | Accounting | دفاتر وحسابات **لكل Business** + Posting Engine + تسويات | Account, JournalEntry, JournalLine (كلها business-scoped؛ لا خلط بين Businesses) | (يستقبل أحداثًا من كل النطاقات المالية) | journal.posted, reconciliation.alert |
| 12 | Orders (Storefront) | طلبات المتجر الإلكتروني ودورة حياتها | Order, OrderItem | Catalog, Inventory (reservation), Payments | order.placed, order.shipped, order.cancelled |
| 13 | Storefront | واجهة المتجر العامة، السلة، Checkout، تتبع الطلب | (قراءة من Catalog/Orders؛ لا ملكية مالية) | Catalog, Orders | cart.abandoned (تحليلي) |
| 14 | Customers | العملاء، بياناتهم، ملاحظاتهم، تصنيفهم | Customer | Tenancy | customer.created |
| 15 | WhatsApp | الربط، القوالب، الرسائل، الحالات، التفضيلات | WhatsAppAccount, WhatsAppTemplate, WhatsAppMessage | Customers, (أحداث كل النطاقات) | whatsapp.message.sent/failed |
| 16 | AI Assistant | STT، تحليل النية، حل الكيانات، المسودات، التأكيد | AIInteraction, AIDraft | Customers, Catalog (قراءة + Draft فقط) | ai.draft.created |
| 17 | Notifications | الإشعارات الداخلية والتنبيهات | Notification | (أحداث كل النطاقات) | notification.delivered |
| 18 | Analytics | لوحات ومؤشرات قراءة فقط | Read models / projections | (أحداث كل النطاقات) | — |
| 19 | Subscriptions & Entitlements | الباقات، الاستحقاقات، الحدود، الفوترة | Plan, Subscription, Entitlement | Tenancy | entitlement.changed |
| 20 | Audit | سجل التدقيق الشامل | AuditEvent | (كل النطاقات تكتب إليه) | — |
| 21 | Platform Admin | لوحة Super Admin، صحة المنصة | (قراءة عبر النطاقات) | جميعها (قراءة) | — |

## 3. قواعد الاعتمادية

0. **نموذج الملكية محسوم (A/B):** Business هو المالك التجاري (دولة/عملة أساسية/دفاتر)؛ Identity عالمية منفصلة عن الملكية عبر Memberships — **Source of Truth للصلاحيات = business_roles + role_permissions على business_memberships**، تُقيَّم في سياق (user × business × branch?) بلا أي إضعاف لعزل tenant_id+business_id.
1. **Accounting لا يعتمد على أحد** — النطاقات المالية تنشر أحداثًا، وPosting Engine يترجمها لقيود عبر Transaction Map موثّق.
2. **Inventory يعرف الكمية والتكلفة، ولا يعرف الحسابات.** تصحيح دقيق ضروري للمرحلة 3: دفتر الحركات يحمل مكوّن قيمة (`value_delta_base_minor`) لأن المتوسط المرجّح لا يُحسب بلا تكلفة — لكنه **لا يعرف أي حساب في دليل الحسابات ولا يكتب في دفتر القيود**. اختيار الحساب وتوليد القيد يبقيان في Accounting وحده، ويُستدعيان من أمر المجال داخل **نفس المعاملة** (P3-AL-32). و**ليست كل عملية مجال ذرّية عمليةً مُرحِّلة**: التحويل بين المستودعات لا يُنشئ قيدًا، فيُفتح بدرزٍ لا يتيح قدرة الترحيل أصلًا ولا يطلب تأكيدًا محاسبيًا — التمييز بين الدرزين يحمله **النوع**، لا راية ولا خيار يمرّره المستدعي.
3. **Payments مستقل عن Revenue**: تسجيل دفعة على فاتورة قديمة يخفض Receivable ولا يرفع الإيراد.
4. **Installments** مجدول سداد فوق Receivable واحد — ليس رصيدًا موازيًا.
5. **AI وWhatsApp وAnalytics** نطاقات طرفية: تستهلك أحداثًا ولا تُكتب إليها الحقيقة المالية. فشلها لا يفشل العملية الأساسية.
6. الاتجاه العام للاعتماد: Tenancy ← Identity ← Catalog/Customers ← Inventory/Sales ← Payments/Receivables/Installments ← Accounting؛ وOrders/Storefront/AI/WhatsApp/Analytics طرفية.

## 4. منع التعارضات المكتشفة مسبقًا

- **لا ثلاث حقائق**: رصيد العميل، متبقي الفاتورة، متبقي القسط — كلها مشتقة من نفس السلسلة (Invoice → Payments → Receivable).
- **لا رصيد يدوي**: يُمنع `customer.balance += x`؛ الرصيد مشتق دائمًا.
- **الأرصدة المخزنة للأداء** (cached) يجب أن تكون قابلة لإعادة البناء من الأحداث، مع Job مطابقة دوري يُنبّه عند اختلاف دون تعديل صامت.

## 5. مخطط نصي للتدفق

```
[Clients: Android / Web / Storefront]
        │  (API موحّد، Zero Trust)
        ▼
┌────────────────────────────────────────────┐
│ API Layer → Application Services (Domains) │
│ Sales ─ Inventory ─ Payments ─ Orders ...  │
│        │                                    │
│        ├─ same DB transaction ─► Outbox     │
│        ▼                                    │
│ Accounting Posting Engine (Journal)         │
└────────────────────────────────────────────┘
        │ events (async, at-least-once, idempotent)
        ▼
 WhatsApp ─ Notifications ─ Analytics ─ Search
```

## 6. حدود المرحلة 3 (P3-S0)

- النطاقات المُنفَّذة في المرحلة 3: **Inventory (4)** و**Purchases & Suppliers (9)**، بالإضافة إلى الحد الأدنى المشترك من **Payments (6)**: جدول `payment_methods` وحده، لأن مدفوعات الموردين تحتاجه ومدفوعات العملاء في المرحلة 4 ستستخدمه نفسه (P3-AL-27). المرحلة 3 **لا تنفّذ** Sales ولا Customers ولا Receivables ولا Orders ولا Storefront.
- **Accounting لا يُفتح ولا يُستنسخ**: لا `AccountingV2`، ولا محرك مال ثانٍ، ولا سلطة صرف ثانية، ولا Outbox ثانٍ، ولا نظام تدقيق ثانٍ، ولا دليل حسابات ثانٍ. المرحلة 3 تبني **عبر** عقود المرحلة 2 المقبولة.
- **صلاحية المستودع ليست صلاحية الفرع تلقائيًا**: الربط عبر `branch_warehouses`، والتحقق يجمع **الصلاحية + النطاق** معًا على **مجموعة** المستودعات المتأثرة (P3-AL-15، P3-AL-39).
- **وصف الصلاحية لا يكفي بلا دورة حياة**: كل مستودع — قائم أو مُنشأ غدًا، بما في ذلك مستودع النشاط الأول الذي يكتبه `provision_create_business` المجمَّد — يحمل ارتباط فرعه الأم إلزاميًّا، مفروضًا بمُشغِّلات القاعدة لا بشيفرة الخدمة، لأن أحد كُتّاب المستودعات الثلاثة لا تمرّ عليه شيفرة المرحلة 3 أصلًا. وإضافة ارتباط إضافي تتطلب `warehouse.manage` **مع** نطاق `all` حتى لا تصير أداة توسيع صلاحية ذاتية (P3-AL-15 §A/§B).
- **السلطة المادية للمخزون (P3-AL-54)**: ثلاثة أنواع من السلطة لا تختلط — النشر (`daftar_migrator`)، والتشغيل (`daftar_app` وأخواته)، والداخلية بلا دخول (`daftar_inventory_internal` الجديد، منفصلًا عن `daftar_accounting_internal`). أعمدة تهيئة المخزون والمتغيّر الأساس وارتباطات المستودعات لا تُكتب إلا عبر روتينات مسمّاة يملكها الدور الداخلي، ولا عضوية لأي دور تشغيل فيه.
