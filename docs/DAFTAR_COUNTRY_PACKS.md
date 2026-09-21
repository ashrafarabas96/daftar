# DAFTAR — Country Packs / الحزم القُطرية (v2)

## 1. المبدأ

القواعد القُطرية **بيانات إعداد لا كود** — ممنوع Hard-code داخل Domains (Master §129). إضافة بلد = حزمة بيانات + ترجمات.

## 2. بنية الحزمة (v2)

```yaml
country_pack:
  code: PS
  name: { ar: فلسطين, en: Palestine, tr: Filistin }
  default_currency: ILS
  supported_currencies: [ILS, USD, JOD]
  # R: لغات البلد "موصى بها" فقط — لغات المنصة (ar/en/tr) متاحة دائمًا للجميع
  recommended_locale: ar
  recommended_storefront_locales: [ar]
  phone:
    country_code: "+970"
    national_length: [9]
  address:
    fields: [city, street, building, notes]
    required: [city]
  # S: الضريبة غير مهيأة افتراضيًا — لا نسب ولا أوضاع دون مصدر قانوني موثّق
  tax:
    status: unconfigured        # unconfigured | configured(with legal_source + effective_date)
    legal_source: null
  invoice:
    numbering_prefix: "INV"
  chart_of_accounts_template: standard
```

## 3. الحزم الأولى (Master §17)

| البلد | العملة الافتراضية | عملات شائعة | اللغة الموصى بها | ملاحظات |
|---|---|---|---|---|
| PS فلسطين | ILS | USD, JOD | ar | تعدد عملات يومي |
| JO الأردن | JOD | USD | ar | minor_units=3 |
| LB لبنان | LBP | USD | ar | التعامل بالدولار واسع |
| SY سوريا | SYP | USD | ar | أرقام كبيرة — اختبار عرض إلزامي |
| TR تركيا | TRY | USD, EUR | tr | واجهة تركية أصلية LTR |

## 4. فصل لغة المنصة عن لغة البلد (R) — محسوم

- **platform_supported_locales = [ar, en, tr]** ثابتة على مستوى المنصة — متاحة لكل مستخدم في أي بلد.
- **country_recommended_locales** في الحزمة = اقتراح افتراضي فقط في Onboarding.
- تاجر فلسطيني يمكنه اختيار Türkçe لواجهته — لا قيد قُطري على اللغة.

## 5. الضرائب (S) — محسومة

- **Tax Configuration = unconfigured في كل الحزم حاليًا.** لا `enabled=true` ولا `mode` ولا نسبة لأي دولة دون مصدر قانوني موثّق بتاريخ سريان (OD-03).
- الحزمة توفر **البنية فقط**؛ عند توثيق المصدر تُهيَّأ الحزمة وتُفعَّل الضريبة للتاجر كاختيار (Progressive Disclosure).

## 6. التنسيقات (F)

- لا فواصل/رموز عملة داخل الحزمة أو سجل العملة — العرض عبر **ICU/Intl/CLDR** حسب locale الواجهة (Multi-Currency §2).
- الحزمة تحمل فقط: بنية الهاتف والعنوان، العملة الافتراضية، اللغة الموصى بها، قالب الحسابات، بادئة الترقيم.

## 7. قواعد واختبارات

1. لا قواعد ضريبية/قانونية مخترعة (Phase 0 §43).
2. نماذج العنوان/الهاتف تُبنى من الحزمة — لا Form جامد.
3. Contract test على بنية الحزمة + اختبار إنشاء Business وبيع كامل لكل بلد.
4. التوسع الخليجي = حزم جديدة بنفس البنية.
