# DAFTAR — PHASE 1 PREFLIGHT PATCH REPORT

**التاريخ:** 2026-09-19
**الغرض:** تصحيح بقايا Phase 0 قبل إنشاء أول Migration أو كتابة Domain Code (SECTION 0 من Phase 1 Directive).

---

## PATCH 1 — customer_credits.origin_type

**الملف:** `docs/DAFTAR_DATA_MODEL.md` — §7ب (السطر 134 سابقًا)

**السبب:** `payment_reversal` = المال نفسه أُبطل/سُحب ولا يولّد Customer Credit جديدًا. أما `reverse_payment_allocation` = المال ما زال لدى Business ويولّد Customer Credit.

**السطر القديم:**
```
origin_type IN (overpayment | payment_reversal | manual_opening),  -- manual بصلاحية مستقبلية موثقة
```

**السطر الجديد:**
```
origin_type IN (overpayment | reverse_payment_allocation | manual_opening),  -- reverse_payment_allocation: المال ما زال لدى Business؛ payment_reversal لا يولّد Credit (Accounting §5.2ب) — manual بصلاحية مستقبلية موثقة
```

---

## PATCH 2 — payment_allocations.reversal_id

**الملف:** `docs/DAFTAR_DATA_MODEL.md` — §7 payment_allocations (السطر 94 سابقًا)

**السبب:** اسم غامض بلا Target معلوم. ممنوع Generic Financial FK بلا هدف موثق.

**السطر القديم:**
```
reversal_id NULL                          -- مرجع قيد العكس
```

**السطر الجديد:**
```
reverse_allocation_journal_entry_id NULL  -- FK صريح → journal_entries(id) (قيد عكس التخصيص، Accounting §5.2) — لا Generic FK بلا Target
```

---

## الملفات المتأثرة

| الملف | التعديل |
|---|---|
| `docs/DAFTAR_DATA_MODEL.md` | PATCH 1 + PATCH 2 |

لا ملفات أخرى تحتوي الصيغتين القديمتين.

---

## شامل Stale Search — النتائج

| الاستعلام | النتيجة |
|---|---|
| `origin_type IN (overpayment \| payment_reversal` في كل docs/ | **0 occurrences** |
| `reversal_id` (باستثناء `payment_reversal_id` المشروع — FK → payment_reversals) | **0 occurrences** |
| `origin_type` خارج DATA_MODEL.md | لا يوجد (مصدر الحقيقة الوحيد) |
| ذكر `payment_reversal` كمنشئ Customer Credit في ACCOUNTING_RULES/GLOSSARY/TEST_STRATEGY | **0** — كل الذكر «عكس دفعة / عكس التخصيص» = reverse_payment_allocation |

`payment_reversal_id` المتبقي في §7د هو FK مركّب مشروع من `payment_reversal_allocations` → `payment_reversals` ولا علاقة له بـPATCH 2.

**الحكم: 0 stale occurrences. يسمح ببدء Coding.**
