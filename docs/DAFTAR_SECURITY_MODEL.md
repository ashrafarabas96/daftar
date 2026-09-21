# DAFTAR — Security Model / نموذج الأمان

## 1. المبادئ

- **Zero Trust** بين Client وBackend (Master §115): لا ثقة بأي price/total/tenant_id/permission/inventory قادم من العميل — إعادة تحقق كاملة على الخادم.
- **Cross-Tenant leak = Release blocker** (Master §116).
- لا Secrets في الكود أو الواجهات؛ مدارة عبر Secret Manager.

## 2. المصادقة (Authentication)

- تسجيل دخول برقم الهاتف/البريد + كلمة مرور (hash بخوارزمية حديثة قوية)؛ OTP كخيار.
- **MFA** متاح وإلزامي لـSuper Admin ولعمليات الإدارة الحساسة.
- الجلسات: tokens قصيرة العمر + refresh مع إبطال عند الخروج/تغيير كلمة المرور/الاشتباه؛ "Old session" تُرفض (انظر Threat Model).
- Rate limiting على المصادقة (محاولات فاشلة → قفل مؤقت + تنبيه).

## 3. التخويل (Authorization / RBAC) — v2 (B)

- **Identity مستقلة عن الملكية**: `users` عالمية؛ الوصول عبر `tenant_memberships` / `business_memberships` / `membership_branch_access`.
- **Source of Truth للصلاحيات:** `business_roles + role_permissions` مربوطة بـbusiness_memberships — تُقيَّم دائمًا في سياق (user × business × branch?). لا صلاحية بدون membership فعّالة، ولا وصول لـBusiness لا يملك المستخدم عضوية فيه (يُختبر بـGOLD-29).
- أدوار جاهزة: Owner، Manager، Cashier (+ مخصصة لاحقًا — OD-10) بصلاحيات ذرّية: `sale.create`, `sale.void`, `refund.approve`, `purchase.create`, `reports.view`, `settings.manage`…
- الفرض على الخادم في كل endpoint؛ الواجهة تخفي فقط ولا تحمي.
- **AI يرث صلاحيات المستخدم في سياق الـBusiness الحالي** — لا تجاوز عبر المساعد.

## 4. عزل المستأجرين والأنشطة (Tenant/Business Isolation) — v2 (V)

- `tenant_id` + `business_id` في **كل** جدول تجاري بما فيه الجداول الفرعية (sale_items, journal_lines, payment_allocations…) + فلترة إلزامية على طبقة الوصول للبيانات.
- **Composite FKs** تمنع ربط كيانات من Businesses مختلفة على مستوى قاعدة البيانات حتى مع Bug تطبيقي (Data Model §4).
- اختبارات Cross-tenant **وCross-business** آمنة آلية في CI لكل endpoint حساس (GOLD-20, GOLD-29, GOLD-30).
- الملفات في Object Storage بمسارات تتضمن tenant/business + روابط موقّعة قصيرة العمر.

## 5. البيانات والملفات

- التشفير أثناء النقل (TLS) وفي التخزين (at-rest) لقاعدة البيانات والنسخ الاحتياطية والملفات.
- الملفات المرفوعة: فحص النوع/الحجم، إعادة معالجة الصور (تجريد metadata)، لا تنفيذ لمحتوى المستخدم؛ الأصل محفوظ والـvariants مُحسّنة (Master §105).
- بيانات الاعتماد (واتساب، مزوّدو الدفع) في Secret Manager مع دوران.

## 6. API والويبهوكس

- Input Validation مركزي على كل المدخلات (Schemas) — الرفض برسائل مفهومة.
- Rate limiting + Quotas لكل tenant/مفتاح.
- Webhooks: توقيع/تحقق مصدر + idempotency + حماية من Replay (انظر Threat Model).
- Backward Compatibility لإصدارات أندرويد المنشورة (Master §114) مع نطاقات صلاحية ثابتة.

## 7. التدقيق والمراقبة

- AuditEvent لكل عملية حساسة (مالية، صلاحيات، إعدادات، تصدير بيانات).
- **حتى Super Admin لا يعدّل أرقامًا مالية مباشرة** — Domain Commands رسمية فقط (Master §117).
- لا Manual DB correction في الإنتاج إلا عبر Incident Procedure موثّقة استثنائية (Master §147).
- Data Repair فقط بأدوات Dry Run + Backup + Audit + Verification (Master §148).

## 8. تخزين الموبايل

- التخزين المحلي الحساس (tokens، عمليات Offline) في Keystore/Encrypted storage.
- لا بيانات مالية حساسة بلا تشفير على الجهاز؛ مسح عند تسجيل الخروج.

## 9. سياسات تشغيلية

- Branch protection: لا Direct Push للإنتاج، Review إلزامي (Master §91).
- CI Gate: build/lint/typecheck/tests/security/migrations — فشل أيٍّ منها = لا Merge (Master §90).
- فحص Dependencies والأسرار آليًا في CI.
- أقل امتياز لكل Service Account وWorker.

## 10. الخصوصية

- مبادئ تقليل البيانات، حقوق الوصول/الحذف للمستخدم النهائي وفق سياسة موثّقة، وسجلات وصول Super Admin لبيانات التجار مدققة. الامتثال القُطري التفصيلي ضمن Country Packs/Open Decisions بمصادر رسمية.

## Session Revocation Strategy (Phase 1, §XLIII)

Access tokens are short-lived JWTs (key ring: one `active` signer, `previous`
keys verify during rotation; `kid` header; unknown kid rejected). **Every**
authenticated request re-validates the session against the identity database
(`AuthService.resolvePrincipal`): the session row must exist, be
`status='active'`, and be unexpired, and the user must be `active`. This makes
revocation **immediate** — logout, logout-all, password reset, and
refresh-token reuse detection (family revocation) all take effect on the very
next request, with no access-token grace window. The cost is one indexed
identity-DB read per request, accepted deliberately: correctness of revocation
outranks the marginal latency, and the query is a two-column primary-key join.
