# DAFTAR — AI Architecture / معمارية المساعد الذكي

## 1. المبدأ الأعلى

**AI مساعد ومفسِّر — ليس سلطة مالية** (Master §47, §49). AI لا يكتب Ledger، لا يحدد COGS، لا يغيّر Inventory، لا ينفذ Refund، لا يحدد Tax نهائيًا، لا يكتب SQL. كل تنفيذ يمر عبر **Domain Services الرسمية** فقط.

## 2. خط المعالجة (Pipeline)

```
صوت المستخدم → STT → نص (transcript محفوظ)
  → Intent Parsing (LLM، Typed Tools فقط)
  → Entity Resolution (بحث فعلي في Customers/Products داخل tenant المستخدم)
  → Confidence Scoring
  → Draft Transaction (AIDraft — ليس سجلًا ماليًا)
  → Preview للمستخدم (ما فهمه AI كاملًا)
  → Confirmation صريح
  → Domain Engine ينفذ (نفس مسار الإدخال اليدوي تمامًا)
  → نتيجة + مرجع
```

## 3. Typed Tools والمخططات

- LLM لا يُخرج نصًا حرًا للتنفيذ — فقط **Structured Intent** وفق Validated Schema (Master §50):
  ```json
  { "intent": "sale.create", "entities": { "customer_ref": "...", "items": [{"product_ref":"...","qty":3,"unit_price":120}], "paid": 300 }, "confidence": 0.0-1.0 }
  ```
- الـSchema يُتحقق آليًا؛ أي حقل ناقص/غير صالح → clarification أو رفض.
- الأدوات المسموحة للـAI: بحث عملاء/منتجات، إنشاء Drafts، قراءة أرصدة/تقارير (عرض). الأدوات الممنوعة: أي كتابة مالية مباشرة.

## 4. حل الكيانات والغموض

- "بعت أحمد…" مع وجود أحمدين → **يسأل المستخدم ولا يخمّن** (Master §51).
- Low confidence → لا تنفيذ، طلب توضيح (Master §52).
- تطابق العميل غير الواضح = ممنوع إرسال كشوف/رسائل (Master §133).

## 5. التأكيد والأمان

- كل Financial mutation عبر AI تتطلب **Confirmation صريحًا** (Master §53) — شاشة "مراجعة العملية" تعرض: العميل، المنتج، الكمية، السعر، الإجمالي، المدفوع، المتبقي.
- AI يعمل ضمن صلاحيات المستخدم نفسه — موظف بلا صلاحية استرداد لا يستطيع عبر AI ما لا يستطيعه يدويًا.
- حدود الأمان: Prompt-injection filtering، عدم تمرير أدوات حساسة، تسجيل كل AIInteraction وAIDraft (من، ماذا فُهم، ماذا تأكد).
- نطاق الصلاحية: نفس tenant المستخدم فقط، ولا وصول للبيانات الخام خارج أدوات القراءة المعتمدة.

## 6. الحالات (AI Draft State Machine)

```
created → awaiting_confirmation → confirmed → executed
   │              │
   │              └→ edited (يعيد التأكيد)
   └→ expired / rejected
```

## 7. UX

ثلاث مراحل مرئية (Master §131): تحدّث الآن (استماع + waveform) → مراجعة العملية → تم التنفيذ (نجاح + رقم العملية). المساعد بنفس الهوية البصرية (Master §130).

## 8. التتبع

`business_transaction_id` للعملية المنفذة يرتبط بالـAIInteraction الأصلية — تتبع كامل: صوت → نية → مسودة → تأكيد → Sale → Journal → Stock → WhatsApp (Master §73).

## 9. الاختبارات

- نيات صحيحة/مكسورة، كيانات مكررة، ثقة منخفضة، محاولات injection، رفض بدون تأكيد، انتهاء صلاحية مسودة، وقياس دقة STT عربي/تركي/إنجليزي. انظر Test Strategy.
