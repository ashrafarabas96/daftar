# DAFTAR — P3-S7 Acceptance / قبول الشريحة السابعة من المرحلة الثالثة

> **What this is.** The evidence page for slice **P3-S7: reads and merchant web UX** (`docs/PHASE_3_EXECUTION_PLAN.md` §9), built to `docs/PHASE_3_S7_CONTRACT.md` as amended by its rulings header and Annex R. It maps each "Must prove" item to its permanent test, records the independent security and UX reviews, the real-browser pass (T-18), the read budgets at contract volume (T-17), and lists the rulings and what stays open. The Phase 3 coordinator accepted and froze P3-S7 under the Tech Lead's 2026-09-26 directive to complete Phase 3. The Tech Lead's own verdict is reserved for the single Phase 3 final report.
>
> **ما هذه الوثيقة.** سجل أدلة الشريحة P3-S7، وتشمل:
> - إحدى عشرة قراءة حيّة للمخزون ولأرصدة الموردين وللمشتريات المفتوحة ولخيارات الإرجاع، تُحسب من السجل في كل طلب، بلا تخزين مؤقت ولا جداول ملخّصة؛
> - شاشات التاجر: المخزون، ونقل المخزون، وجرد المخزون، وتعديل المخزون، واستلام الشراء، والإرجاع للمورّد، والدفع للمورّد، بالعربية والإنجليزية والتركية، على عرض الهاتف؛
> - كل واجهة تستعملها الشاشات قابلة للاستدعاء مباشرة من تطبيق أندرويد لاحق.
>
> لا هجرة في هذه الشريحة.

## 0. Status: ACCEPTED (internal) / FROZEN

- **Candidate head:** `f64f3996644cd956a79ac08cc2346b889c7a3a92`. It is green on all five jobs of `DAFTAR CI` run `36328660397` (attempt 1), on that exact SHA.
- **Migrations:** none. `frozenThrough` stays `0068_supplier_settlement_commands.sql`, with 69 migrations frozen. The conditional index migration that A-02 allowed was not admitted, because T-17 passed without it (§2). P3-S8 therefore starts at `0069`.
- **Freeze:** the freeze commit sets `S7_ACCEPTED_MARK = 'P3-S7 accepted'` in `scripts/phase3-s7-gate.ts`. With `S7_MIGRATIONS` empty, the accepted tense checks `frozenThrough` as a floor at 0068 and leaves 0069 on to P3-S8.
- **CI:** runs `gate:phase3:s7`, which composes `gate:phase3:s6` and the chain back to Phase 1.

## 1. What P3-S7 delivers

**API: eleven live reads** (A-05 … A-09), each behind its Phase 3 permission and scope, with strict query DTOs and keyset paging:

| route | answers |
|---|---|
| `GET /v1/inventory/access` | the caller's own Phase 3 permission subset and warehouse reach |
| `GET /v1/inventory/warehouses` | the warehouses the caller reaches (no quantity, no value) |
| `GET /v1/inventory/items`, `GET /v1/inventory/units` | the item and unit pickers; the base variant never appears |
| `GET /v1/inventory/stock` | live on-hand per warehouse and variant, quantity only |
| `GET /v1/inventory/stocktakes`, `…/:stocktakeId` | counts, with expected quantities hidden while not finalized (R-S7-1) |
| `GET /v1/supplier-balances` | per supplier and currency: owed (the S6 payable) and in the merchant's favour |
| `GET /v1/suppliers/:id/open-purchases` | open purchases oldest first, with an advisory allocation proposal |
| `GET /v1/purchases/:id/return-options` | returnable quantity per line, `reversible` and its reason |
| `GET /v1/payment-method-defaults` | which payment-method types can be set up without an account choice |

The S5/S6 payable SQL moved into one builder, `payableSql`, in `supplier-balance-reads.ts`; every earlier call site returns the same rows (T-05).

**Web (`apps/web`).**
- The screens of P3-AL-48: Stock, Move Stock, Count Stock, Adjust Stock (with "Starting stock", TL-4(a)), Receive (with "Paid now", receive-and-pay), Return to Supplier, Pay Supplier, the supplier and purchase pages (with "Undo receipt", TL-4(b)), and product tracking and warehouse reach on the existing product and structure pages.
- The platform fixes the contract ruled (A-12): the BFF proxy forwards `PUT`, `accept-language` and `cache-control`, answers `no-store`, and refuses path-escaping segments; the idempotency key is owned by the caller and survives the 401 retry; error `details` reach the screen.
- One typed client, `apps/web/src/lib/phase3-api.ts`, whose every call is audited as Android-callable (T-14).
- Catalog keys in ar, en and tr for the `nav.`, `common.`, `error.`, `stock.`, `purchasing.`, `suppliers.` and `payments.` namespaces.

**Guards.** Rule 23 (the responsive law) and the merchant-jargon pass are static guards; G-6 (no reporting-time lookups) is widened to the two S7 read modules.

## 2. Must-prove → test

| plan bullet (§9) | test |
|---|---|
| no cache, projection or materialized view was created | T-01 `integration/read-s7-no-cache.test.ts` (the catalogue end state on a migrated database, proven red on a planted materialized view); T-02 `integration/read-s7-static.test.ts` (no module-level cache in the read modules, no browser storage in the web, `no-store` on every GET); T-03 `integration/read-s7-freshness.test.ts` (each command is visible to the very next read, with no sleep); the gate's own "no cache after 0068" check |
| no accounting jargon appears in a merchant-facing string | T-09 `apps/web/test/jargon.test.ts` and the jargon guard in `gate:phase3:s7` (per-locale denylist over the S7 namespaces, proven red on a planted `"stock.x": "Journal"`); T-08 `apps/web/test/invisible.test.tsx` (no id, sequence or account id is ever rendered); T-10 `apps/web/test/error-keys.test.ts` (every reachable refusal has a plain-language key in all three locales) |
| every screen works at phone width | T-15 `apps/web/test/phone-width.test.tsx` and T-16 `apps/web/test/rtl-mirror.test.tsx` in CI (SSR at 360 px, ar/en/tr, widths, touch targets, direction); Rule 23 in the static guards; T-18, the real-browser pass (§4) |
| every API used is one a later Android client could call | T-14 `integration/web-s7-client-contract.test.ts`: every export of `phase3-api.ts` has an audit row, and each row is called directly on the API with Bearer, `X-Business-Id` and `Accept-Language` and no cookie; every mutation replays idempotently |

**Also covered:**

| area | suite |
|---|---|
| the live stock read (T-04), including a page boundary between two variants of one product | `read-s7-stock` |
| supplier balances equal the S6 payable (T-05) | `read-s7-supplier-balances` |
| open purchases and the proposal (T-06), bounded work | `read-s7-open-purchases` |
| return options and every block reason (T-07) | `read-s7-return-options` |
| authority and isolation of every read, single-permission roles, a second business of the same owner (T-11) | `read-s7-authority` |
| OD-03 and no customer payments in the web (T-12) | `apps/web/test/od03.test.ts` |
| the item and unit pickers (T-13) | `read-s7-items-units` |
| the S7 static guards and their red proofs | `static-guards-s7` |
| the web platform, CSP and the review fixes | `apps/web/test/{platform,csp,ux-review-fixes,real-browser-fixes}.test.ts(x)` and the three screen suites |

In total, 11 P3-S7 integration suites with 118 tests, and 14 web files with 184 tests.

**T-17, the read budgets** (`tests/performance/phase3-s7-read-budgets.test.ts`, p95 of 20 warm runs, local embedded PostgreSQL 18):

| read | budget | Tier 1 (scale 0.1, in the gate) | Tier 2 (scale 1, the contract volume) |
|---|---|---|---|
| stock page (50) | 150 ms | 29.5 ms | 73.6 ms |
| supplier-balances page (20) | 250 ms | 49.5 ms | 78.4 ms |
| open-purchases (one supplier, 500 open) | 200 ms | 65.7 ms | 65.5 ms |
| return-options | 50 ms | 16.7 ms | 21.5 ms |

- **Two tiers, the P2-S8 §35 precedent.** Seeding the contract volume (5,000 variants × 3 warehouses, 2,000 suppliers, 50,000 purchases, 200,000 AP lines) takes about two hours, too long for every CI run. The gate runs Tier 1 at scale 0.1 on every run; Tier 2 at scale 1 is the acceptance evidence above, run once at 14:15Z on `27b046d`, whose API, packages and tests equal the candidate's (every later commit touches only `apps/web` and `packages/design-system`). It seeded exactly 5,005 variants, 15,000 stock keys, 2,000 suppliers, 50,000 purchases and 200,000 AP lines, and passed 3/3. `P3S7_PERF_SCALE` selects the tier.
- Each tier also asserts the plans: index access on `stock_levels`, `purchases_supplier_idx` and `journal_lines_business_account_idx`, and no sequential scan on `journal_lines`.
- The owner signs in again after the seed, because the seed outlives an access token.
- Every budget passed without an index, so the conditional `0069_…_read_indexes.sql` was not admitted (A-02).

## 3. Independent reviews

### 3.1 Security

The review ran on the integrated candidate with its own probes. It found **no High finding and one Medium**. It found sound: the authority and scope of all eleven reads and of the S6 settlement reads, business isolation, the payable builder's equality with the S6 payable, the proxy's header allowlist, and the client.

| id | finding | closure |
|---|---|---|
| M-1 (Medium) | blind counting (TL-8) was UI-only: `PUT …/counts` returned the expected quantity to any `inventory.stocktake` holder | **R-S7-1**: the server nulls `expectedQtyAtCapture`, `varianceQty` and `capturedAtStockSeq` unless the caller holds `inventory.view`, and the stocktake detail hides them while not finalized unless the caller holds `inventory.adjust`. The fields stay in the shape, nullable (`91f46ae`) |
| L-1 | the BFF proxy accepted path-escaping or `?`/`#`-carrying catch-all segments | segments are re-encoded, and the target must stay under `/v1/` (`a5323b2`, `43e27e4`); P1-GOLD-37 still holds |
| L-2 | a NUL byte in `search` answered 500 on four reads | every search parameter refuses it with 400 `VALIDATION_FAILED` (`5385648`) |
| L-3 | `open-purchases` read the supplier's whole history on every page | settled purchases are filtered in SQL, and `purchase_ap_outstanding` runs only for the page and a proposal window of the 500 oldest open purchases; `owedOnly` examines at most 500 suppliers per page (`d6fd32b`) |
| L-4 | the form-lifetime exchange-rate idempotency key blocked a second, different rate | keyed per currency and time, re-minted after a save (`135e220`) |
| item 6 | single-permission roles could not reach the pickers | warehouses, items and supplier detail widened as the rulings header states; stock is **not** widened; `holdsStock` is `null` without `inventory.adjust` or `inventory.view` (`62dd32a`) |
| I-1 … I-9 | information | I-3 (return options show `reversalReason` to `purchases.view`) is accepted per Annex R #21 and asserted in T-11. I-4 (S3 command answers carry value to non-cost roles) predates S7 and is recorded in §5. I-6 is hardened: `payableSql` takes a closed union, not SQL text (`72d9bcd`) |

### 3.2 UX, localization and simplicity

The review rendered all 260 fixture × locale combinations and loaded them in headless Chromium at 360 px. It found **1 Blocker, 7 Major, 21 Minor and 9 Nit; all 38 are closed** (`fb4fe58` … `135e220`, `100eb67`), each with a regression test in `apps/web/test/ux-review-fixes.test.tsx` or the screen suites. The Blocker: Arabic dates rendered scrambled (`142026/08/`) on every purchasing and supplier screen, because the RLM marks from `Intl` reordered inside `<bdi dir="ltr">`. One date formatter now serves every S7 screen, without the marks.

## 4. T-18, the real-browser pass

T-18 exercised the screens in headless Chromium, at 360×640 and 1280×800, in ar and en, through the real Next application against the real API: Move, Count (list and sheet), Adjust, Receive, Receive and pay, Return, Pay, and the header. The pass recorded 70 screenshots over 32 runs. **Every run completed, and none showed a page wider than its viewport, a clipped or over-wide element, a raw catalog key, a replacement character or an API error.** The screenshots and `t18b-results.json` are kept with the coordinator's evidence; the repository holds no binary evidence files.

**The first pass found a Phase 1 defect.** The web app's Phase 1 Content Security Policy (`script-src 'self'`) refused Next's inline bootstrap, so no page hydrated in a real browser: every client-side action, including Phase 1's, was dead. SSR tests cannot see this. It is fixed with a per-request nonce (`script-src 'self' 'nonce-…' 'strict-dynamic'`) set by the middleware, a dynamic layout, and `apps/web/test/csp.test.ts` (`45d1f36`). The same pass fixed a refresh race (one refresh per page, `1348e26`), header navigation on phones (`f4611b8`), quantity and unit-price formatting (`5ba1482`), keyboard operation of list rows (`100eb67`) and one English plural (`f64f399`).

T-18 narrows **TD-06** but does not close it (TL-2): CI still has no browser job.

## 5. Rulings and deviations for the Tech Lead

- **TL-2 … TL-12 were adopted as engineering rulings** (the contract's header), with TL-3 as amended. Recorded for the final report: TL-5 (no statements or ageing), TL-6 (no document numbers; S6 A-04's deferral answered), TL-7 (no stock value on screens), TL-9 (header navigation, collapsed behind a menu button below 1024 px, instead of bottom navigation), TL-11 (`GET /v1/inventory/access` stays inventory-scoped).
- **R-S7-1, single-permission pickers and the bounded work** are review rulings in the contract header (§3.1).
- **Cost visibility has no permission of its own.** S3 command answers (transfer, adjust, damage, finalize) carry `valueDeltaBaseMinor` and `journalEntryId` to their callers (review I-4). The web never renders them. This predates S7 and is recorded for a later permission design.
- **Deviations recorded by the implementers.**
  - `GET /v1/inventory/access` and `GET /v1/inventory/units` answer any member of the business: the first returns only the caller's own subset, and units are master data with no quantity or value.
  - A stocktake list filtered to a warehouse the caller does not reach answers 200 with no rows, not 403.
  - The Phase 1 default warehouse name is English in every locale, because frozen `0038` seeds it; renaming is the merchant's.
  - Next still serves its static `/_not-found` page without the nonce, so a 404 page shows but never hydrates. It has no action to take.
- **OD-03 stays bounded.** No screen shows a tax field or option; T-12 proves it. Tax rates and tax posting are **BLOCKED BY OD-03**.

## 6. Regression

The candidate `f64f399` was checked locally on a fresh embedded PostgreSQL.

- **`npm run gate:phase3:s7`: PASS.** It composes `gate:phase3:s6` and the chain back to Phase 1 (Budget A in isolation included, p95 ≤ 15 ms, unchanged), then localization with the jargon pass, the static guards, the shared-contracts and web suites, every P3-S7 suite with the guard proofs, the Phase 1 web-contract golden, and T-17 Tier 1 last. It was proven red before it was trusted (both runner canaries).
- **Static checks:** format, typecheck, lint, the static guards and the migration manifest check are all clean.
- **The accepted tense.** It was proven red on a one-line change to frozen `0068` and on a `frozenThrough` moved below 0068.

## ملخص

صار بإمكان التاجر، من المتصفح وعلى شاشة الهاتف، وبالعربية أو الإنجليزية أو التركية:
- رؤية الكميات الحالية في كل مستودع، ونقل المخزون، وجرده دون رؤية الكمية المتوقعة قبل الانتهاء، وتعديله أو إدخال الرصيد الافتتاحي؛
- استلام الشراء والدفع معه في خطوة واحدة، وإرجاع البضاعة للمورّد، والدفع للمورّد على مشترياته المفتوحة؛
- رؤية ما عليه لكل مورّد وما له عنده.

كل رقم يُحسب من السجل لحظة الطلب؛ لا تخزين مؤقت ولا جداول ملخّصة. لا تظهر للتاجر أي كلمة محاسبية. كل واجهة تستعملها الشاشات يمكن لتطبيق أندرويد لاحق أن يستدعيها كما هي.

راجعها مراجع أمني مستقل: لا خلل عاليًا، وملاحظة متوسطة واحدة (الجرد الأعمى كان في الواجهة فقط) أُغلقت في الخادم. وراجعها مراجع تجربة استخدام: 38 ملاحظة أُغلقت كلها. وكشف التشغيل في متصفح حقيقي خللًا من المرحلة الأولى (سياسة أمان المحتوى كانت تمنع تشغيل الصفحات) وأُصلح.
