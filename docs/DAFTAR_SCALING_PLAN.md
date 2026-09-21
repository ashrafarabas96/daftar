# DAFTAR — Performance & Scaling Plan / خطة الأداء والتوسع

## 1. الهدف

**10,000+ حساب/مستخدم خلال السنة الأولى** (Master §134) — مع إثبات بالأرقام عبر Load Test، لا بالافتراض.

## 2. مبادئ

1. **Stateless Backend** قابل للتوسع الأفقي (Master §135).
2. **لا تعقيد مبكر، ولا Core يمنع التوسع غدًا** (Master §136): Modular Monolith بوحدات قابلة للفصل، وطوابير/Outbox جاهزة للفصل إلى خدمات عند الحاجة.
3. لا Microservices مبالغ فيها (Phase 0 §30).

## 3. الخطة حسب المكوّن

| المكوّن | الخطة |
|---|---|
| API | نسخ متعددة خلف Load Balancer؛ جلسات في Redis/DB لا في الذاكرة |
| PostgreSQL | Connection pool (PgBouncer أو ما يعادلها)، فهارس مركّبة على tenant_id، مراجعة Query plans للاستعلامات الثقيلة، Read replicas عند الحاجة، Partitioning للجداول الأحداثية الضخمة (outbox, audit, movements) عند بلوغ عتبات موثّقة |
| Redis | Cache (entitlements، sessions، read models) + Queue backend؛ TTLs موثّقة |
| Workers | أسرع قابل للتوسع أفقيًا؛ عزل طوابير الحرجة (مالية) عن الثانوية (واتساب/تحليلات) |
| Object Storage + CDN | صور الأصل + variants مُحسّنة (WebP/أحجام)، CDN أمام المتجر والصور |
| Storefront | SSR/Static حيث ممكن، Cache عام، مراقبة LCP/bundle/API latency (Master §127) |
| Analytics | Read models/projection من الأحداث — لا استعلامات تقارير ثقيلة على OLTP |

## 4. أهداف أداء قابلة للقياس (تُثبت بالاختبار)

- POS إتمام بيع (API): p95 ≤ 500ms.
- تحميل Dashboard الأول: محتوى مفيد خلال ≤ 2s (skeletons فورًا).
- Storefront: LCP ≤ 2.5s على 4G.
- لا N+1 في أي شاشة قائمة (Master §84) — فحص آلي في الاختبارات.

## 5. Load Testing

- سيناريوهات: 10k tenants نشطة، ذروة POS متزامنة، عاصفة مزامنة Offline بعد انقطاع، حمل Storefront موسمي.
- التقسيم الزمني (Master §89): Fast PR checks / Core merge checks / Nightly full regression / Release suite.

## 6. نقاط التوسع المستقبلية (مسجّلة، غير مبنية الآن)

- فصل WhatsApp Worker وAI Gateway كخدمات مستقلة عند الحمل.
- Read replicas + تقارير على نسخ القراءة.
- Sharding على tenant_id إن تجاوز الحجم الأهداف بكثير.
