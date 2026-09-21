# DAFTAR — Domain Map / خريطة النطاقات

## 1. المبدأ

Modular Monolith بحدود Domain واضحة. كل Module يملك بياناته ومنطقه، ويتواصل مع الآخرين عبر **واجهات رسمية** (Application Services) أو **Domain Events** عبر Outbox. ممنوع: Giant Services، ممنوع الوصول المباشر لجداول Module آخر، وممنوع Circular Dependencies.

## 2. النطاقات وحدودها ومصدر الحقيقة

| # | Domain | المسؤولية | يملك (Source of Truth) | يعتمد على | يُصدِر أحداثًا |
|---|---|---|---|---|---|
| 1 | Identity & Access | هوية عالمية للمستخدم + عضويات | User(identity), tenant_memberships, business_memberships, business_roles, role_permissions, membership_branch_access, Session, MFA | Tenancy | user.created |
| 2 | Tenancy | الحسابات والأنشطة والفروع والمستودعات | Tenant (اشتراك/عزل), **Business (country, base_currency, timezone, default_locale, storefront)**، Branch، Warehouse (يتبع Business؛ للفرع default_warehouse اختياري) | — | tenant.provisioned |
| 3 | Catalog | المنتجات، المتغيرات، التصنيفات، الترجمات، الصور، الأسعار الحالية | Product, ProductVariant, ProductTranslation, Category, Media | Tenancy | product.created/updated |
| 4 | Inventory | حركات المخزون، الحجوزات، الجرد، التسويات، التنبيهات | StockMovement, Reservation, Stocktake, cached quantity (قابل لإعادة البناء) | Catalog, Tenancy | stock.low, stock.movement.recorded |
| 5 | Sales | عمليات البيع، الفواتير، البنود، الخصومات، المرتجعات | Sale, SaleItem, Invoice, Return, CreditNote | Catalog, Inventory, Customers, Accounting | sale.completed, sale.returned |
| 6 | Payments | الدفعات، طرق الدفع، التسويات | Payment, PaymentMethod | Sales (Receivable view), Accounting | payment.recorded, refund.completed |
| 7 | Receivables & Debts | الذمم، الأرصدة المشتقة، كشوف الحساب | Receivable (مشتق: Invoice − Payments) | Sales, Payments | receivable.overdue |
| 8 | Installments | خطط التقسيط والأقساط والتذكيرات | InstallmentPlan, Installment | Receivables, Payments | installment.due, installment.late |
| 9 | Purchases & Suppliers | الموردون، فواتير الشراء، الذمم الدائنة | Supplier, Purchase, PurchaseItem, **supplier_payments, supplier_payment_allocations**، Payable (مشتق: Purchases − Allocations) | Inventory, Accounting | purchase.received |
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
2. **Inventory لا يعرف شيئًا عن المال**؛ يعرف كميات وأسباب ومراجع فقط.
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
