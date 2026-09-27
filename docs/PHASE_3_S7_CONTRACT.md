# DAFTAR — P3-S7 Contract / عقد الشريحة P3-S7

> **Coordinator rulings on this contract (2026-09-27).** Adopted as the P3-S7 implementation contract after P3-S6 was accepted and frozen (TL-1). Every "S6C" citation is replaced by `docs/PHASE_3_S6_CONTRACT.md` and the frozen code. Line numbers are re-based to the S6 freeze commit.
>
> **Migrations.** S7 plans none. The only admissible file is a conditional, index-only `0069_…_read_indexes.sql` (A-02), admitted only with T-17's EXPLAIN attached. If it lands, P3-S8's first migration is 0070; otherwise S8 starts at 0069. The S7 gate's accepted tense checks nothing after 0068 when `S7_MIGRATIONS` is empty. It checks S6 digests through the manifest and step 1, never by importing `phase3-s6-gate.ts`.
>
> **S6 facts S7 must honour.**
> - **The payable SQL is `S5_PAYABLE_SQL` (`purchasing-reads.ts:840-885`), with three call sites.** The `payableSql` builder serves all three, and T-05 proves identical rows for each.
> - **Credit in the merchant's favour is `Σ supplier_credit_notes.remaining_amount_minor`.**
> - **Settlement reads need `suppliers.view`.** `GET …/purchases/:id/settlements` needs it plus warehouse scope. `GET …/suppliers/:id/payments` needs it plus business-wide scope.
> - **Receive-and-pay needs both permissions.** It needs `purchases.receive` and `suppliers.pay`, and the payment date is the document date.
> - **Payments.** A payment holds at most 50 allocations and never leaves a sub-unit AP residue (R-77). The open-purchases proposal obeys both rules.
> - **Retryable 409s** add `supplier_credit_allocation.settlement_changed` and `supplier_refund.settlement_changed`/`fx_rate_changed`.
> - **Error keys.** `error.supplier_credit_note.*` and the `*.residue_below_base_unit` codes get keys. T-10 enumerates codes from exported code lists: R may add `PURCHASING_CODES`/`PAYMENT_METHOD_CODES` exports, an additive change and the only permitted edit to S6 files besides the payable-SQL move.
> - **Payment methods are read unresolved and unfiltered.** The web filters on `isActive` and applies the locale fallback itself. `GET /v1/payment-method-defaults` is permission-only, matching S6 A-03.
> - **"Undo receipt" visibility** comes from an S7 read using `purchase_settlement_state()`, not from the `suppliers.view` route.
>
> **Guard G-6 is widened to `inventory-reads.ts` and `supplier-balance-reads.ts` only.** `purchasing-reads.ts` holds S6's command-side `accounting_fx_rate_lookup` (`readSettlementFx`) and stays outside the reporting surface.
>
> **Web.** The four platform fixes stand as verified: proxy PUT, `accept-language` and `cache-control`; a caller-owned idempotency key, which also covers the 401 retry; and error `details` kept. `domainCode` reads `details.code` only for `ACCOUNTING_REFUSED`. There is no `accountingCode` on the wire.
>
> **TL-6 answers S6 A-04's deferral.** S6 A-04 defers display numbering to S7. S7 ships no stored or derived document number, and the matter is recorded for the Tech Lead (numbering policy, possible legal rule) as a Phase 3 closure item.
>
> **Review rulings (2026-09-27, after the independent security and UX reviews).** These amend the body.
> - **R-S7-1, blind counting is enforced by the server (TL-8, review M-1).** The `PUT …/counts` answer carries `expectedQtyAtCapture`, `varianceQty` and `capturedAtStockSeq` as `null` unless the caller holds `inventory.view`. The stocktake detail (A-08) hides them for every stocktake that is not finalized (draft or cancelled) unless the caller holds `inventory.adjust`. The fields stay in the shape and are nullable.
> - **Single-permission pickers (review item 6).** The warehouses read (A-05) also admits `inventory.transfer`, `inventory.stocktake`, `inventory.adjust`, `purchases.manage` and `purchases.receive`; it still lists only warehouses the caller reaches, with no quantity or value. The items read (A-06) also admits `inventory.transfer`, `inventory.stocktake` and `purchases.receive`; its `holdsStock` is `boolean | null`, computed only for `inventory.adjust` or `inventory.view` holders. `GET /v1/suppliers/:id` also admits `suppliers.pay`. The stock read is not widened.
> - **Bounded work (review L-3).** `open-purchases` pre-filters settled purchases in SQL and calls `purchase_ap_outstanding` only for the page and for a proposal window of the 500 oldest open purchases; `supplier-balances?owedOnly=true` examines at most 500 suppliers per page. Past the window a purchase proposes 0 and the remainder shows as unallocated.
> - **Search (review L-2).** A NUL byte in any `search` parameter is `VALIDATION_FAILED`.
> - **Web platform (review L-1, L-4, I-7).** The BFF proxy refuses a decoded path segment containing `/`, `\`, `?`, `#`, a control character, or equal to `.`/`..`, re-encodes every segment and keeps the target under `/v1/`; page ids taken from the URL must be UUIDs. Every proxied response is `cache-control: no-store`. A new exchange-rate idempotency key is minted after each successful rate entry.
> - **Stable order.** The stock read orders a product's variants by display name, then id.
>
> **Adopted as engineering rulings:** TL-2 … TL-12, with TL-3 (defaults read) as amended above. OD-03 stays bounded: every tax element is BLOCKED BY OD-03.

> **Summary (Arabic).** عقد تنفيذ الشريحة P3-S7 (القراءات وتجربة التاجر على الويب):
> - **لا ترحيل (migration) في هذه الشريحة.** لا جدول ولا عرض ولا عرض مُجسَّد ولا فهرس ولا دالة ولا منحة جديدة. يُسمح بترحيل فهارس فقط (0069) إذا فشل اختبار الميزانية T-17، ولا يُكتب مسبقًا.
> - قراءات حيّة: المخزون من `stock_levels` (الاستثناء الوحيد المسمّى، P3-AL-44)، وذمم المورّد والمتبقي على المشترى من سطور دفتر الأستاذ ومن `purchase_ap_outstanding` لحظة الطلب (P3-AL-26). لا ذاكرة مؤقتة ولا Redis ولا تخزين في المتصفح.
> - إحدى عشرة نقطة قراءة GET جديدة فقط، ولا أمر جديد. كل ما تستعمله الشاشات يمكن لتطبيق أندرويد لاحق أن يستدعيه مباشرة: مفتاح تكرار آمن لكل أمر، ورموز أخطاء ثابتة، ولا حالة جلسة على الخادم.
> - الشاشات الست: استلام مشتريات · نقل مخزون · جرد المخزون · تعديل المخزون · إرجاع إلى المورّد · الدفع للمورّد. تعمل بعرض الهاتف (360px)، وبالعربية من اليمين إلى اليسار، وبالإنجليزية والتركية.
> - لا مصطلح محاسبي في أي نص يراه التاجر، ويُفرض ذلك آليًا. لا شاشة تطلب من التاجر اختيار حساب. المتغيّر الأساسي وتسلسل المخزون وربط المصدر كلها مخفية.
> - الضريبة: لا حقل ولا خيار — BLOCKED BY OD-03. لا مدفوعات عملاء.
>
> لا عائق حقيقي. توجد ملاحظات لقائد الفريق (§9.2).

> **Status.** This is the candidate contract for P3-S7, written by the S7 contract agent. It is analysis only: no repository file was changed, nothing was committed and PostgreSQL was not started.
>
> **Tree.** The worktree is reset to `bc08f5f` ("test(p3-s5): the OD-03 boundary…").
> - `MIGRATION_MANIFEST.json` holds `frozenThrough = 0064_purchase_commands.sql` (`infrastructure/database/MIGRATION_MANIFEST.json:3`).
> - 0065 and 0066 exist.
> - S6 is not in the tree. It is known only from its adopted candidate contract, cited as **S6C** (`scratchpad/PHASE_3_S6_CONTRACT.adopted.md`), which adds 0067/0068, the `payment-methods` module and the settlement routes (S6C A-18, §4.3).
>
> **Sequencing (TL-1).** S7 lands only after S5 and S6 are accepted and frozen. Every predecessor pin and route below is stated **as S6 will leave it**. Where S7 depends on an S6 name, the name is S6C's, and §9.2 TL-1 lists what must be re-checked against the frozen S6.
>
> **Sources, in order of authority:**
> 1. Code and migrations `0000`–`0066` at `bc08f5f`.
> 2. Tests.
> 3. `docs/PHASE_3_ARCHITECTURE_LOCK.md` (L).
> 4. `docs/PHASE_3_EXECUTION_PLAN.md` (P).
> 5. S6C.
> 6. `docs/PHASE_3_SLICE_MAP.md` (SM), `docs/PHASE_3_PREMORTEM.md` (PM), `TECHNICAL_DEBT.md` (TD), `docs/DAFTAR_LOCALIZATION_GLOSSARY.md` (GL), `docs/DAFTAR_SIMPLICITY_STANDARD.md` (SIM) and `docs/DAFTAR_DESIGN_SYSTEM.md` (DS).
>
> **Shape.** It mirrors `docs/PHASE_3_S5_CONTRACT.md` (S5C):
> - §0 conventions
> - §1 rulings
> - §2 database contract
> - §3 error model
> - §4 packages and application
> - §5 harness
> - §6 test plan
> - §7 gate, guards and predecessor evolution
> - §8 file ownership
> - §9 real blockers and Tech Lead notes

---

## 0. Conventions

- **Citations.**
  - `path:line` cites code at `bc08f5f`.
  - `L:n` cites the lock, `P:n` the execution plan, `SM:n` the slice map, `S5C:n` the S5 contract and `S6C Ann` a ruling of S6C.
  - Migrations are cited by number, as `0059:98`.
- **Ruling classes** are those of S5C §0:
  - **ENG** binds the implementers.
  - **ENG+TL** binds them until the Tech Lead overrules it (§9.2).
  - **BLOCKER** is reserved for the six classes the brief names:
    - a product-constitution ambiguity;
    - a legal or tax rule;
    - a paid provider;
    - a destructive data decision;
    - an external credential;
    - an architectural contradiction.
- **Must-prove IDs** (P:257):
  - **MP-1** no cache, projection or materialized view was created;
  - **MP-2** no accounting jargon in a merchant-facing string;
  - **MP-3** every screen works at phone width;
  - **MP-4** every API used is one a later Android client could call.
  - **MP-0** is the "Delivers" line (P:255): the reads are live, derived and correct.
- **Phone width** means a 360 CSS-pixel viewport. That is the narrowest common Android width, and the one the SSR tests assert (§6).
- **"S7 web files"** are the files matching both of the following. Every static rule in §7.2 is scoped to them, so Phase 1 pages are not re-litigated:
  - under `apps/web/src/app/[locale]/{stock,purchases,suppliers}/**` or `apps/web/src/views/**`;
  - `apps/web/src/lib/phase3-*.ts`.
- **"S7 read modules"** are:
  - `apps/api/src/modules/inventory/inventory-reads.ts`;
  - `apps/api/src/modules/purchasing/supplier-balance-reads.ts`;
  - the existing `apps/api/src/modules/purchasing/purchasing-reads.ts`.
- **Money in the web.** A money value is a minor-unit integer string end to end.
  - The web never adds, subtracts, multiplies or divides money.
  - Every total it shows is a server figure.
  - It only parses input with `parseMajorToMinor` and formats output with `formatMinor` (`packages/shared-contracts/src/money.ts`, re-exported at `packages/shared-contracts/src/index.ts:386`). This is the rule already enforced for web money names by static-guards Rule 6b (`scripts/static-guards.ts:116-140`).

---

## 1. Rulings

### A-01 · Slice scope and object inventory (ENG)

**S7 delivers:**
1. **Eleven live read routes** (A-05 … A-09). All are GET. No command is added and no existing command changes behaviour.
2. **Two read-only additions to existing routes:**
   - a `search` query on `GET /v1/suppliers` (A-09);
   - an `ids` filter shared by the item read (A-06).
3. **The six P3-AL-48 screens** (L:1300-1311), plus the four supporting screens they cannot work without:
   - the stock list;
   - the purchase list and detail;
   - the supplier list and detail;
   - two additions to Phase 1 pages: the tracking card on `catalog/[id]`, and the warehouse–branch association on `structure`. The lock gives the association UI to S7 at L:623 and L:2125; see also P:72.
4. **Web platform fixes the screens need:**
   - PUT through the BFF proxy;
   - `Accept-Language` forwarded;
   - a caller-owned idempotency key;
   - the error `details` kept.
5. **Enforcement:**
   - a jargon lint;
   - a responsive lint;
   - SSR phone-width tests;
   - an Android-callability audit;
   - the gate `scripts/phase3-s7-gate.ts`.

**Out of S7:**
- **Statements, ageing buckets and supplier statements of account.** S4C deferred them to "S7" as a possibility. S7 does not build them (TL-5).
- **Stored document numbers** (TL-6).
- **Stock valuation reports.**
- **Tax of any kind.** BLOCKED BY OD-03 (A-19).
- **Customer payments**, which belong to Phase 4.
- **Any Android code** (L:1294).
- **Offline.**

### A-02 · Migration plan: zero migrations (ENG)

- **S7 adds no migration.** The tree after S7 has exactly the files through `0068_supplier_settlement_commands.sql` (S6C A-02).
- **Why no migration is needed.** Every S7 read uses only relations and functions that `daftar_app` can already SELECT or EXECUTE:

  | Relation or function | Grant |
  |---|---|
  | `stock_levels`, `stock_movements` | `0059:372` |
  | `units`, `unit_names` | `0053:249-250` |
  | `stocktakes`, `stocktake_lines` and the movement document tables | `0061:1812-1813` |
  | `suppliers`, `purchases` and their lines | `0063:588-591` |
  | the S5 tables | `0065:520-521` |
  | `purchase_ap_outstanding` | `0066:108-113`; S6 replaces the body, not the grant (S6C A-13) |
  | `accounts` | `0040:239` |
  | the journal tables | `0042:436` |
  | the S6 settlement and payment-method tables | S6C A-17 |
  | `branch_warehouses`, `branches`, `warehouses`, `products`, `product_variants` and their translations | Phase 1 and `0056` grants, as used today by `reachableWarehouses` (`purchasing-reads.ts:83-97`) and `resolveVariants` (`inventory-stock-read.ts:78-114`) |

- **Indexes.** The plan allows S7 "read indexes only, if measurement justifies any" (P:44). S7 ships none up front. The indexes it relies on already exist:

  | Index | Location |
  |---|---|
  | `stock_levels` PK `(business_id, warehouse_id, variant_id)` | `0059:108` |
  | `stock_levels_variant_idx` | `0059:118` |
  | `purchases_supplier_idx` | `0063:294` |
  | the S5 indexes | `0065:224`, `0065:289` |
  | `journal_lines_business_account_idx` | `0050:57` (S4C A-20) |
  | S6's `(business_id, supplier_id)` index on `supplier_payments` and `(business_id, purchase_id)` index on `supplier_payment_allocations` | S6C §2.2 |

- **The only permitted exception is a conditional 0069.**
  - It exists only if T-17 fails its budget on the seeded volume.
  - It may contain only `CREATE INDEX` statements on existing tables. There is no grant, table, view or function, and no `INCLUDE` of a money column.
  - An index is not a cache or a projection: it holds no figure the reads return that is not recomputed from the rows at query time, and G-3's discovery of stored relations (`scripts/guards/sql-schema.ts:257-268`) does not count it as one.
  - It needs no grant: an index is used through the table's own SELECT grant, which the A-18-style matrix (S6C A-17) does not change.
  - The coordinator must approve it with T-17's EXPLAIN output attached. The gate's `S7_MIGRATIONS` then becomes `['0069_…']`.

### A-03 · No cache, projection or materialized view (ENG)

1. **Stock reads.**
   - They read `stock_levels` directly. It is the one named cache (L:1256-1263), is updated in the same transaction as every movement, and is the row commands lock.
   - S7 creates no second copy of it, no per-product aggregate and no warehouse total.
   - No read computes value as quantity × average.
2. **Supplier AP and purchase outstanding** are computed per request from the ledger AP lines (`purchasing-reads.ts:813-838`, as S6 extends it; S6C A-18) and from `purchase_ap_outstanding` (`0066:70-90`, as S6 replaces it).
3. **Supplier credit** reads the S5/S6 `remaining_*` columns. They are verified against the derivation at every COMMIT (S6C TL-16), so this is the single stored figure the lock tolerates, not an S7 addition.
4. **No application cache.**
   - The S7 read modules hold no module-level `Map`, `Set`, `WeakMap` or LRU of results.
   - They import nothing from `redis`, `ioredis` or `lru-cache`.
   - They use no memoization decorator.
5. **No browser cache.**
   - S7 web files use no `localStorage`, `sessionStorage`, IndexedDB or Cache API.
   - The existing business-id key (`apps/web/src/lib/client.ts:61-65`) is Phase 1 and untouched.
   - The API sets `Cache-Control: no-store` on every response (`apps/api/src/app/request-context.middleware.ts:18`). The BFF proxy today drops it: it returns only `content-type` (`apps/web/src/app/api/proxy/[...path]/route.ts:26`). S7 forwards it (A-12).
6. **No SQL-side cache.**
   - There is no materialized view.
   - There is no view beyond the one that exists today, `credential_deliveries_safe` (`0028:22`).
   - There is no `UNLOGGED` or temporary table and no summary table.
7. **Proofs:** T-01 (catalogue), T-02 (static), T-03 (freshness) and the gate's boundary check (§7.1).

### A-04 · Read authority: permissions and scope (ENG)

Every S7 read re-checks its permission in the service, as `purchasing-reads.ts:105-107` does, and applies one of three scope rules. The rules are those of P3-AL-15/39 and the S4 TL-4 precedent:

- **`warehouse`.** The read is restricted to the warehouses returned by `reachableWarehouses(db, m)` (`purchasing-reads.ts:83-97`). An unreachable row reads as absent: it is filtered out of a list and is `…not_found` for a single item. A read that names an unreachable warehouse explicitly is refused with `inventory.warehouse_out_of_scope` (403). That is the code the command authority already uses (`inventory-authorization.ts:131-133`).
- **`business-wide`.** The read requires `m.branchScopeMode === 'all'`, or it is refused with `inventory.business_wide_scope_required` (403) (`purchasing-reads.ts:99-103`). This covers every supplier-level money figure: AP summed over warehouses discloses unreachable purchases.
- **`master`.** The read requires membership plus one of the listed permissions. It returns business-wide master data (products, units, suppliers).

The permissions used are the eleven of P3-AL-38 (L:1122-1170) plus the accounting ones S6 already uses. A **cashier holds none of them**, so every S7 screen shows `common.noPermission` to a cashier (T-11).

### A-05 · `GET /v1/inventory/access` and `GET /v1/inventory/warehouses` (ENG)

**`GET /v1/inventory/access`**
- **Who may call it:** any member of the current business. No permission is needed; it discloses only the caller's own grants.
- **Response:** `InventoryAccessDto { businessWide: boolean; permissions: Phase3Permission[] }`.
  - `permissions` is the caller's effective subset of this closed list:
    - the eleven P3-AL-38 permissions;
    - `warehouse.view`, `warehouse.manage`;
    - `accounting.view`, `accounting.fx.manage`, `accounting.chart.manage`.
  - It is computed with `hasPermission(m.roles, p)`, the check the reads already use (`purchasing-reads.ts:105-107`).
- **Why it exists:**
  - The web must hide actions a member cannot take (SIM-13: an error must say what to do; an always-refused button is not that).
  - No such read exists today. `BusinessSummaryDto` carries only `roleKey`, and `tenancy.controller.ts:127-131` returns the business, not the grants.
  - It is advisory only: every command still enforces its own authority.

**`GET /v1/inventory/warehouses`**
- **Permission:** any one of `warehouse.view`, `inventory.view` or `purchases.view`.
- **Scope:** `warehouse`.
- **Response:** `{ items: InventoryWarehouseDto[] }`, where `InventoryWarehouseDto = { warehouseId, name, status, homeBranchId, branchIds: string[] }`, ordered by name then id.
- **Why it is needed.** The existing `GET /v1/businesses/current/warehouses` (`tenancy.controller.ts:163-167`, `structure.service.ts:84-97`) filters by home branch, not by `branch_warehouses`. It therefore answers a different question from the P3-AL-15 reach the commands enforce. S7 screens need the reach, and the association UI needs `branchIds`. The Phase 1 route is left unchanged.
- **Status.** Archived warehouses are returned with their status. Pickers offer only `active` ones.

### A-06 · `GET /v1/inventory/items`, `GET /v1/inventory/units` (ENG)

**`GET /v1/inventory/items?search=&ids=&trackedOnly=&cursor=&limit=`**
- **Permission:** any one of `inventory.view`, `purchases.view`, `purchases.manage` or `inventory.adjust`.
- **Scope:** `master`.
- **Query:**
  - `search`: 1..100 characters after trimming. It is matched case-insensitively as a substring of the resolved name, with `%`, `_` and `\` escaped, and also as an exact match on a merchant variant's SKU or barcode. The base variant is never matched; this is the rule of `catalog.service.ts:92-93`.
  - `ids`: 1..200 canonical product UUIDs. It resolves display names for a purchase or stocktake detail.
  - `ids` and `search` are mutually exclusive: supplying both is a 400 validation error.
  - `trackedOnly` defaults to `true` for the movement screens.
  - Paging is keyset on `(resolved name, id)`, with a default of 20 and a maximum of 50. There is never OFFSET.
- **Item:** `InventoryItemDto = { productId, name, status, trackInventory, unitCode, unitDecimals, holdsStock, variants: { variantId, name, status }[] }`.
  - `variants` lists **merchant variants only**; the base variant is never in it (P3-AL-52, PM-38 at `docs/PHASE_3_PREMORTEM.md:533-545`).
  - A simple product has `variants: []`. A request line for it sends `variantId: null`, which is exactly the command contract (`packages/shared-contracts/src/inventory.ts:25-30`).
  - `name` is resolved with the Phase 1 rule: requested locale, then `ar`, then any (`catalog.service.ts:15-17`). The locale comes from `Accept-Language`, parsed as `catalog.controller.ts:29-33` parses it.
  - `holdsStock` is `productHoldsStock` (`inventory-stock-read.ts:560-566`: a non-zero on-hand or a non-zero movement sum in any warehouse). The tracking card uses it only to explain a refusal ahead of time: while it is true, the card says that turning tracking off or changing the unit needs zero stock. The configuration command stays the authority and its refusal is still mapped (A-15(d)).
- **Why this is not the catalog list.** `ProductListItemDto`/`ProductDto` (`packages/shared-contracts/src/index.ts:164-196`) do not carry `trackInventory`, the unit or the merchant variants. Widening them would change P1-GOLD-38's audited shapes. S7 therefore adds a separate read and leaves `catalog.*` untouched.

**`GET /v1/inventory/units`**
- **Who may call it:** any member.
- **Response:** `{ items: { unitCode, name, defaultDecimals }[] }`.
  - It reads `units`/`unit_names` (`0053:66-94`).
  - `name` is resolved as above.
- It feeds the tracking card's unit picker.

### A-07 · `GET /v1/inventory/stock` (ENG) — the live stock read

**Query.** `warehouseId` (required), `search?`, `status?=in_stock|out_of_stock|negative`, `cursor?`, `limit?` (default 20, maximum 50).

**Permission and scope.** `inventory.view`, with scope `warehouse`. An unreachable `warehouseId` is 403 `inventory.warehouse_out_of_scope`.

**What it reads.** Every **tracked, non-archived** product of the business with its variants, LEFT JOINed to `stock_levels` on `(business_id, warehouseId, variant_id)`.
- A key without a row reads as zero (`EMPTY_STOCK_STATE`; `inventory-stock-read.ts:216`).
- The base variant is joined but **never exposed as a variant**:
  - a simple product's row carries `variantId: null`;
  - a product with merchant variants returns one row per merchant variant;
  - its base-variant row appears **only if its on-hand quantity is non-zero**, as `variantId: null`. Pre-variant stock is a real quantity, and hiding it would hide stock. The UI labels it with the product name alone.

**Row.** `InventoryStockRowDto = { productId, variantId: string|null, name, variantName: string|null, unitCode, unitDecimals, onHand: string }`.
- `onHand` is a decimal string at the product's `unitDecimals`.
- **Absent from the row:**
  - `valuation_base_minor` and `avg_unit_cost_base_minor`, because cost is not a merchant screen in S7 (TL-7);
  - `last_stock_seq`, because the stock sequence is invisible (L:1311);
  - reserved and available quantities, which do not exist (L:1274).

**Paging.** Keyset on `(name, productId, variantId)`.

**Status filter.**
- `in_stock` is `on_hand > 0`.
- `out_of_stock` is `on_hand = 0`.
- `negative` is `on_hand < 0`. This is a deficit (P3-AL-42) and is labelled "Short by {qty}" / «ناقص {qty}» / "{qty} eksik". The word "deficit" is never used.

**Freshness.** The read runs in its own statement under `db.scoped` and returns the committed state at statement start (T-03).

### A-08 · `GET /v1/inventory/stocktakes`, `GET /v1/inventory/stocktakes/:stocktakeId` (ENG; blind counting is ENG+TL, TL-8)

**List.** `?warehouseId=&status=draft|finalized|cancelled&cursor=&limit=`
- **Permission:** `inventory.view` or `inventory.stocktake`.
- **Scope:** `warehouse`.
- Keyset on `(created_at DESC, id DESC)`, as in `purchasing-reads.ts:895-914`.
- **Item:** `{ stocktakeId, warehouseId, status, createdAt, closedAt|null, lineCount }`.

**Detail.** It uses `findStocktake` and `readStocktakeLines` (`inventory-stock-read.ts:324-343`, `366-397`), plus names.
- **Line:** `{ lineId, productId, variantId|null, name, variantName|null, countedQty, expectedQty|null, varianceQty|null }`.
  - `variantId` is null for a base-variant line (`isBase`).
  - `capturedAtStockSeq` is **not returned**: the sequence is invisible (L:1311).
- **Blind count (TL-8).** While the stocktake is `draft`, `expectedQty` and `varianceQty` are **null** unless the caller holds `inventory.adjust`. Once the stocktake is finalized they are returned to every caller who may read it.
- **Why this read is needed.** The Count Stock screen must resume an open draft: a warehouse holds at most one (`inventory-stock-read.ts:346-351`, `inventory.stocktake_already_open`). Today there is no GET in the inventory module at all: the only routes are the POSTs and PUTs at `inventory-movements.controller.ts:59` onward and `inventory-configuration.controller.ts:22`.

### A-09 · Supplier-side reads (ENG; business-wide balances follow S4 TL-4)

**(a) `GET /v1/supplier-balances?status=&search=&cursor=&limit=`**
- **Permission:** `suppliers.view`. **Scope:** business-wide.
- **Path.** It is a separate top-level path because `@Get(':supplierId')` at `suppliers.controller.ts:107` would capture `/v1/suppliers/balances` and refuse it as a non-UUID.
- **Row:** `SupplierBalanceRowDto = { supplierId, name, status, owed: { currency, amountMinor }[], inYourFavour: { currency, amountMinor }[] }`.
- **`owed`** is the ledger AP per purchase currency.
  - It uses **the same SQL text** as the per-supplier payable read, as S6 extends it (S6C A-18) to include the `supplier_payment` and `supplier_credit_allocation` AP lines.
  - That text is refactored into one builder, `payableSql({ groupBy: 'currency' | 'supplier_currency', filter })`, so the list and `GET /v1/suppliers/:id/payable` (`suppliers.controller.ts:119`) cannot diverge (T-05).
  - The `txn_minor` rule is unchanged: only AP lines in the purchase currency are counted (`purchasing-reads.ts:807-811`).
  - Rows where `txn_minor = 0` are omitted.
- **`inYourFavour`** is `Σ remaining_txn_minor` of the supplier's credit notes, grouped by note currency, with zero rows omitted.
- **Paging.** The page is chosen by the supplier keyset first: `(created_at DESC, id DESC)`, as `purchasing-reads.ts:855-871` does. The two aggregates are then computed for **those ≤ 50 suppliers only**, with `p.supplier_id = ANY($2)`.
- **No sorting by amount.** Sorting by a derived amount would force a whole-business aggregate on every page. A merchant who wants "who do I owe most" is served by the `owedOnly=true` filter instead: it restricts the page to suppliers with a received, unreversed purchase whose outstanding is non-zero, using `EXISTS` over `purchase_ap_outstanding`.

**(b) `GET /v1/suppliers/:supplierId/open-purchases?currency=&amount=&cursor=&limit=`**
- **Permission:** `suppliers.view` or `suppliers.pay`. **Scope:** `warehouse`.
- **Rows.** Received, unreversed purchases of the supplier with `purchase_ap_outstanding(business, id) > 0` (`0066:70-90`, S6 body). They are ordered **oldest first** on `(document_date, created_at, id)`.
- **Row:** `{ purchaseId, documentDate, supplierReference|null, warehouseId, currency, totalTxnMinor, outstandingTxnMinor }`.
- **Payment proposal.** When `currency` and `amount` (a minor-unit integer string > 0) are supplied, each row whose currency equals `currency` gains `proposedMinor`.
  - It is the oldest-first allocation, computed on the server in BigInt: `min(remaining, outstanding)`.
  - The response gains `unallocatedMinor`, the part of `amount` that no reachable open purchase can take.
  - Rows in another currency get `proposedMinor: null`.
- **Why the server proposes.** The web must not do money arithmetic (§0), and an Android client must not re-implement the rule (L:1293).
- **The proposal is advisory.**
  - The payment command re-validates every allocation (S6C A-07).
  - `unallocatedMinor > 0` blocks submission in the UI, because there are no advances (S6C TL-3).

**(c) `GET /v1/purchases/:purchaseId/return-options`**
- **Permission:** `purchases.view`. **Scope:** `warehouse`, using the purchase's warehouse.
- **Line:** `{ lineId, productId, variantId|null, name, variantName|null, purchasedQty, returnedQty, returnableQty, onHandQty }`.
  - `returnedQty` is `Σ supplier_return_lines.qty` for the line. It is derived live and never stored.
  - `returnableQty` is `max(0, min(purchasedQty − returnedQty, onHandQty))`, computed in SQL numeric. These are the two S5 bounds (S5C A-12): `supplier_return.quantity_exceeds_purchased` and the stock bound.
  - `onHandQty` is read from `stock_levels` for the purchase's warehouse.
- **Header:** `{ purchaseId, status, reversed, supplierActive, returnable: boolean, reason: null | 'not_received' | 'reversed' | 'supplier_inactive' | 'nothing_left' }`. The `reason` values mirror the S5 refusals (`supplier_return.purchase_state_invalid`, `.purchase_reversed`, `.supplier_inactive`), so the screen can say why before the merchant fills anything in.
- **Quantities are decimals, not money.** The minimum is taken in SQL so that the web does no decimal arithmetic either.

**(d) `GET /v1/suppliers?search=`**
- It extends `listSuppliers` (`purchasing-reads.ts:855-871`) with an optional `search`, matched with escaped `ILIKE` on `name`.
- Keyset paging is unchanged.
- It serves both the supplier picker and the duplicate-name hint S4C allowed S7 to show (A-15(c)).

**(e) `GET /v1/payment-method-defaults`**
- **Permission:** `accounting.chart.manage`. **Scope:** business-wide.
- **Response:** `{ items: { systemType, available: boolean }[] }` for `cash`, `card`, `bank_transfer`, `wallet` and `cheque`.
- **Why it exists.** It lets the Pay Supplier screen create the business's first payment method (S6C TL-7) **without the merchant choosing an account** (L:1309).
- **The mapping lives on the server:**

  | `systemType` | Account `system_key` (`0040:45-50`) |
  |---|---|
  | `cash` | `cash` |
  | `card` | `card_clearing` |
  | `bank_transfer` | `bank` |
  | `wallet` | `wallet_clearing` |
  | `cheque` | `cheque_clearing` |

- `available` is true when that account exists and is active.
- **The account id is not returned.** Instead, `POST /v1/payment-methods` is called by the web with a `postingAccountId` obtained as follows (TL-3):
  - the web calls `GET /v1/businesses/:id/accounting/accounts` (`accounting.controller.ts:265-274`; it requires `accounting.view`);
  - it picks the account whose `systemKey` matches, a field present on `AccountingAccountDto` (`packages/shared-contracts/src/index.ts:608-620`).
- `other` is never offered by the UI.

### A-10 · The Android-callable surface (ENG) — MP-4

Every route any S7 screen calls is listed in the **S7 client audit** (`tests/integration/web-s7-client-contract.test.ts`, §6 T-14). For each route the audit records:
- **method and path**;
- **permission and scope**;
- **how a retry is made safe**, one of:

  | Kind | Meaning | Example |
  |---|---|---|
  | `document-id` | the body's client-chosen id; a replay answers 200 with `replayed: true` | the S3/S4/S5/S6 commands (`inventory-movements.controller.ts`, S6C TL-10) |
  | `header` | an `Idempotency-Key` header | `POST …/accounting/fx-rates` (`accounting.controller.ts:136-148`) |
  | `revision` | `expectedRevision` or `draftRevision` | the purchase draft PUT, supplier and payment-method updates |
  | `state` | the command states the end state and answers `changed: false` when it already holds | `PUT …/configuration` (`inventory-configuration.service.ts:11-20`), the association POST/DELETE (`tenancy.controller.ts:183-205`) |
  | `read` | a GET | the S7 reads |

- **its DTO type**, taken from `@daftar/shared-contracts`.

The audit then calls every route **directly on the API**. It sends only `Authorization: Bearer`, `X-Business-Id`, `Accept-Language` and the idempotency material, with no cookie and no BFF. It asserts:
- the status;
- the DTO shape;
- a replay of every mutation;
- that a refusal carries a stable domain code in `details` (§3).

"No server session state in a command" (L:1294) is proved by this cookie-less direct call.

### A-11 · Screen map (ENG; items marked TL are ENG+TL)

Every screen is a client page under `apps/web/src/app/[locale]/`, in the Phase 1 page pattern: `'use client'`, `refreshSession()` on mount, then load.
- Each page is a thin container: it fetches, holds state and calls into a **pure presentational view** in `apps/web/src/views/<area>/`.
- A view receives `t`, `locale` and data props only. It never imports `next/*` or the client, so it can be server-rendered in tests (§5).

| Route | Merchant name (en) | Calls | Permission to see the action |
|---|---|---|---|
| `stock/` | Stock | access, warehouses, stock | `inventory.view` |
| `stock/move` | **Move Stock** | warehouses, items, stock, `POST /v1/inventory/transfers` | `inventory.transfer` |
| `stock/count` · `stock/count/[stocktakeId]` | **Count Stock** | stocktakes list/detail, items, `POST stocktakes`, `PUT …/counts`, `POST …/finalize`, `POST …/cancel` | `inventory.stocktake` |
| `stock/adjust` | **Adjust Stock** | items, stock, `POST adjustments`, `POST damages`; `POST openings` behind "Starting stock" (TL-4) | `inventory.adjust` |
| `purchases/` | Purchases | purchases list (`purchases.controller.ts:172`) | `purchases.view` |
| `purchases/receive` · `purchases/receive?draft=` | **Receive Purchase** | suppliers (search), `POST /v1/suppliers`, warehouses, items, currencies (`platform.controller.ts:34`), `PUT /v1/purchases/:id`, `POST …/receive` or S6's `POST …/receive-and-pay`, `POST …/cancel`; fx-rates on demand (A-14) | `purchases.manage` (draft), `purchases.receive` (receive) |
| `purchases/[purchaseId]` | Purchase | `GET purchase`, `…/payable`, `…/returns` (`purchases.controller.ts:165,178,185`), S6's `…/settlements`, items `ids=`; the "Undo receipt" action (TL-4) calls `POST …/reversal` | `purchases.view` |
| `purchases/[purchaseId]/return` | **Return to Supplier** | `…/return-options`, `POST …/returns` | `purchases.return` |
| `suppliers/` | Suppliers | `GET /v1/suppliers`; `GET /v1/supplier-balances` only when `businessWide` | `suppliers.view` |
| `suppliers/[supplierId]` | Supplier | supplier, `…/payable` and `…/credit-notes` (business-wide only), `…/open-purchases`, S6's `…/payments` | `suppliers.view` |
| `suppliers/[supplierId]/pay` | **Pay Supplier** | open-purchases with proposal, S6's `GET /v1/payment-methods`, `POST /v1/supplier-payments`; "use balance in your favour" via S6's `POST /v1/supplier-credit-allocations` (business-wide only); first-method setup (A-09(e)) | `suppliers.pay` |
| `catalog/[id]` (existing) | "Track stock" card | items `ids=`, units, `PUT /v1/inventory/products/:id/configuration` | `inventory.adjust` |
| `structure` (existing) | "Also serves branches" on each warehouse | inventory warehouses, `POST`/`DELETE …/warehouses/:id/branches` | `warehouse.manage` + business-wide |

**Navigation.**
- `AppHeader.tsx:11-18` gains three items: `stock`, `purchases` and `suppliers`.
- Each item is shown only when `access.permissions` includes the matching view permission.
- The header already wraps (`AppHeader.tsx`), and on a phone it stays one wrapping row; bottom navigation is not introduced in S7 (TL-9).
- "Record supplier refund" (S6's `POST /v1/supplier-refunds`) appears on the supplier detail, under "Balance in your favour", as "Get money back" (business-wide + `suppliers.pay`).

### A-12 · Web platform changes (ENG)

1. **BFF proxy** (`apps/web/src/app/api/proxy/[...path]/route.ts`):
   - Export `PUT`. Today only GET, POST, PATCH and DELETE are exported (`route.ts:30-33`), and every Phase 3 PUT would 405: the draft, counts, supplier update, configuration and payment-method update.
   - Forward `accept-language` in addition to the four headers of `route.ts:16`.
   - Return `cache-control` from the upstream response, falling back to `no-store`, beside `content-type` (`route.ts:26`).
2. **`apiFetch`** (`apps/web/src/lib/client.ts:68-89`):
   - Set `idempotency-key` only when the caller did not. Today `client.ts:75-77` overwrites any caller key with a fresh random one, so the fx-rate retry of A-14 would not be idempotent.
   - Send `accept-language: <html lang>`.
   - `ApiError` (`client.ts:48-55`) gains `details?: Record<string, unknown>` and a getter `domainCode`. It is the first present of:
     - `details.inventoryCode` (`inventory-errors.ts:57`);
     - `details.purchasingCode`;
     - `details.paymentMethodCode` (S6C §3);
     - `details.accountingCode`, falling back to `details.code` for `ACCOUNTING_REFUSED` (`apps/api/src/common/error.filter.ts:38-40`);
     - `details.catalogCode` (`catalog.service.ts:30`).

   Phase 1 callers read only `status` and `code`, so the change is additive.
3. **New typed client** `apps/web/src/lib/phase3-api.ts`, in the `merchant-api.ts` style (`BFF='/api/proxy'`, `{items}` lists, shared-contracts types).
   - It is **a separate file** so that P1-GOLD-38's mechanical sync (`tests/golden-regression/phase1/06-web-contract.golden.test.ts:436-457`, which reads `lib/merchant-api.ts` only, line 21) stays green. It gets its own audit (A-10).
4. **Document ids.**
   - Each form mints its document id once, with `crypto.randomUUID()`, when the form opens. It keeps that id across retries, and after a network error, until the command succeeds or the merchant starts a new form.
   - Line ids are minted per added line.
   - This is what makes a double submission or a retried request a replay (A-10).

### A-13 · Progressive disclosure and "no account" (ENG) — L:1306-1311

**Receive Purchase**
- **Default form:** supplier, warehouse (pre-selected when only one is reachable), date (today), lines (item, quantity, unit price), optional supplier reference and note.
- **Currency.** The currency defaults to the base currency and is hidden behind "Different currency".
- **Discount.** It is per line, behind "Add discount" on the line. A document-level discount is not offered (S4C).
- **Extra costs.** Landed cost is behind "Add extra cost" (shipping, customs clearance fees, other). The label never says "landed cost". The spread defaults to "by value" (`mode: 'by_value'`). "Split manually" is a second level.
- **No tax or duty preset** (BLOCKED BY OD-03; S4C, `purchasing.ts:127-134`).
- **Review.** "Review" saves the draft (`PUT`) and shows the **server's** totals from `PurchaseCommandResultDto` (`purchasing.ts:260-263`). "Receive" then posts. That is one confirmation step (SIM-10).
- **Pay now.** A "Paid now" toggle on the review switches the final call to S6's receive-and-pay. It pre-fills the amount with the server total, as a string pass-through, not arithmetic.
- **Foreign currency.** The FX rate is shown on the result **only** for a foreign-currency purchase, as "1 {C} = {rate} {base}" (`PurchaseRateDto`, `purchasing.ts:180-187`).

**Move Stock:** from, to, lines.

**Adjust Stock**
- The reason is one of four: "Found extra", "Missing", "Damaged", and "Starting stock" (TL-4). The first two map to a signed adjustment, and "Damaged" to a damage.
- "Cost per unit" is asked **only** for a gain on a key that has never held valued stock, that is, only when the server refuses with `inventory.unit_cost_required`. The screen then reveals the field for the named lines (`inventory-errors.ts:51-54`, `extra` variants).

**Count Stock**
- Open (or resume), enter counted quantities, finish.
- The variance is shown after finishing, as "{n} more than expected" / "{n} fewer than expected".
- The unit-cost prompt follows the same rule as Adjust Stock.

**Return to Supplier**
- The merchant picks quantities up to `returnableQty`. There is no amount field: S5 computes every amount (`purchasing.ts:320-325`).
- The result says either "The supplier now owes you {amount}" (a credit note was created), or "Your balance with this supplier went down by {amount}". Both figures come from the server.

**Pay Supplier**
- Method, amount, date, and a reference when the method requires one.
- The allocation list is pre-filled by the proposal (A-09(b)) and can be edited per row.
- **Different currency** reveals a second amount per purchase, "Amount this settles in {C}" (S6C A-07).
- **No account picker exists anywhere.**
  - A payment method's account is chosen by the system (A-09(e)).
  - `postingAccountId` is shown to nobody on an S7 screen, even though S6's GET returns it to accounting roles (S6C A-18).
- **Invisible everywhere:**
  - the base variant (A-06/A-07);
  - the stock sequence (A-07, A-08);
  - source bindings, entry ids, `businessTransactionId`, `movementId` and `catchUpEntryId`. They are never rendered, and T-08 asserts it on the view props.
  - Deficit coverage after a receipt is rendered only as "Covered {qty} that was short" when `coverage` is present (`purchasing.ts:297-305`).

### A-14 · Missing exchange rate (ENG)

When a receive or payment is refused with `purchase.fx_rate_missing` or `accounting.fx_rate_missing`:
- **If the caller holds `accounting.fx.manage` and is business-wide** (`accounting.controller.ts:132-135`), the screen shows an inline "Exchange rate on {date}: 1 {C} = [ ] {base}".
  - It is posted to `POST /v1/businesses/:businessId/accounting/fx-rates`, with a form-stable `Idempotency-Key` (A-12(2)).
  - The original command is then retried **with the same document id**.
- **Otherwise** the screen says: "The exchange rate for {date} is missing. Ask the business owner to add it. Nothing was saved."

The word "rate" is allowed. "Base currency" is rendered as the currency code, never as "base".

### A-15 · Merchant-facing vocabulary (ENG; the glossary additions pass the linguistic gate, GL:3)

**(a) The six screen names** are added to GL §1 in ar/en/tr as the binding terms:

| en | ar | tr |
|---|---|---|
| Receive Purchase | استلام مشتريات | Satın Alma Teslim Al |
| Move Stock | نقل مخزون | Stok Taşı |
| Count Stock | جرد المخزون | Stok Say |
| Adjust Stock | تعديل المخزون | Stoğu Düzelt |
| Return to Supplier | إرجاع إلى المورّد | Tedarikçiye İade |
| Pay Supplier | الدفع للمورّد | Tedarikçiye Öde |

The existing GL terms are reused unchanged:
- supplier, purchase, return, refund and payment (GL:17-27);
- outstanding balance, «الرصيد المستحق» / "Kalan bakiye" (GL:74);
- in stock and out of stock (GL:58-60).

**(b) "Supplier credit"** is never called "credit" (GL:82 bans it). It is:
- "Balance in your favour";
- «رصيد لك عند المورّد»;
- "Lehinize bakiye".

**(c) The duplicate-name hint** is "A supplier with this name already exists: {name}". It is shown before create and does not block.

**(d) Every refusal text answers three questions** (SIM-13): what happened, whether my data is safe, what to do. S7 error keys are `error.<domain>.<code>` with the code's dots kept, for example `error.inventory.insufficient_stock`. Every code in the three explicit tables S7 screens can hit must have a key in all three locales (T-10):
- the `purchasing-errors.ts` table (`purchasing-errors.ts:41` onward);
- the S6 `payment-method-errors.ts` table;
- the `inventory-errors.ts` classes.

An unknown code falls back to the GL "data safe error" (GL:77).

**(e) A server `message` is never rendered.** `purchasing-errors.ts` and `inventory-errors.ts:17-18` already keep the database text out of the envelope. S7 additionally forbids rendering `ApiError.message` or `.code` text (T-09).

### A-16 · Responsive law (ENG) — MP-3

These rules apply to S7 web files. They follow DS:113 (one column on mobile, touch target ≥ 44px) and the design system's own tokens: `TOUCH_TARGET = '2.75rem'` (`packages/design-system/src/tokens.ts:96`) and the `logical` helpers (`tokens.ts:102-110`). The design system is inline-style only with no media queries, so the rules are about layout primitives, not CSS files.
1. **One column by default.**
   - Multi-column layouts use `display: grid` with `gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))'`. At 360px this collapses to one column without a media query.
   - No fixed `width`, `minWidth` or `flexBasis` above `20rem` (320px).
   - No `100vw`.
2. **No `Table` from the design system.**
   - The design-system `Table` scrolls sideways (`overflowX: 'auto'`, `packages/design-system/src/components/layout.tsx:97`) and is a desktop pattern. S7 uses `List` and `Card` rows with a primary line and a secondary line.
   - Horizontal scrolling is never the phone layout.
3. **Logical properties only.** Use `marginInlineStart` and similar, or the `logical` helpers. No `marginLeft`, `paddingRight`, `left:`, `right:`, `textAlign: 'left'|'right'` or `float`. The RTL rules are those of `DAFTAR_LOCALIZATION.md` §4.
4. **Touch targets.** Every clickable element is a design-system `Button`, `Select`, `Combobox`, `TextField` or a `List` row, and these already meet `TOUCH_TARGET` at their default size. The one exception is `Button size="sm"`, which is `calc(2.75rem - 0.5rem)` (`packages/design-system/src/components/buttons.tsx:9`) and is **forbidden in S7 web files**. There is no raw `<button>` or `<a onClick>` with custom sizing.
5. **Numbers and codes.** Quantities, amounts, dates and currency codes are wrapped in `<bdi>` with Western digits (`DAFTAR_LOCALIZATION.md` §4). The formatting helper `formatQty(value, decimals)` / `formatMinor` returns a string that the view places in `<bdi dir="ltr">`.
6. **Forms.** One field per row. Line editors are stacked cards, not grid rows. The primary action is full-width at the bottom.

### A-17 · Money and quantity input (ENG)

- **Amounts** are typed as major-unit decimal strings.
  - They are validated with `parseMajorToMinor(value, minorUnitsOf(currency))`, which already exists (catalog pages import it, e.g. `apps/web/src/app/[locale]/catalog/page.tsx:5`).
  - They are sent in the unit each command expects, as the DTO comments state: `unitPrice` as a major-unit string, and `amountMinor` as a minor-unit string.
- **Quantities** are decimal strings, checked against `unitDecimals`. Commas are normalised: the Arabic decimal separator `٫` becomes `.`, and Arabic-Indic digits become Western.
- **No `Number()` or `parseFloat` on a money or quantity name** in S7 web files (Rule 6b, extended in §7.2).

### A-18 · Deactivated and archived targets (ENG)

- **Inactive suppliers** are filtered out of the pickers for a new purchase and a new payment (L:1191-1198). They remain visible in lists, with an "Inactive" badge.
- **Returns to an inactive supplier** are refused by the server (`supplier_return.supplier_inactive`). The return-options header says so first (A-09(c)).
- **Archived warehouses and products** are not offered in pickers.
- **Payment methods** that are inactive are not offered (S6C A-06).

### A-19 · The tax boundary — OD-03 (ENG, **BLOCKED BY OD-03**)

No S7 screen, view, message key or client function carries a tax element:
- The draft PUT never sends `taxAmount` (`purchasing.ts:156-157`).
- `taxMinor` is never rendered.
- There is no tax or duty extra-cost preset.

T-12 asserts all three: no `tax` identifier in S7 web files, no key matching `/tax|vat|duty/i` in the S7 namespaces, and no `taxAmount` in `phase3-api.ts`. The only tax text anywhere in S7 is the code comment `BLOCKED BY OD-03`.

### A-20 · What S7 does not change (ENG)

- **No change to the database:** migrations, manifest, grants, RLS, routines.
- **No change to any command's body, response or refusal table.** The additions are:
  - read-only query parameters (A-09(d));
  - the `payableSql` builder refactor, which is text-identical in output for the existing two call sites (T-05).
- **No Phase 1 client function changes** (`merchant-api.ts` is untouched).
- **No Android change.**
- **No change to `stock_levels` usage by commands.**

---

## 2. Database contract

1. **Migrations.** None (A-02). At S7 acceptance the gate asserts that the files after `0068_supplier_settlement_commands.sql` are exactly `S7_MIGRATIONS = []`. A conditional `0069_*_read_indexes.sql` is admitted only under A-02's exception.
2. **Catalogue end state**, asserted by T-01 against a migrated database:
   - `SELECT count(*) FROM pg_matviews WHERE schemaname = 'public'` = 0;
   - the set of `pg_views` in `public` is exactly `{credential_deliveries_safe}` (`0028:22`);
   - no relation named `/balance|summary|snapshot|cache|projection/` exists, except `stock_levels`, the named exception (`scripts/guards/no-authoritative-balance.ts:205`, `STOCK_CACHE_EXCEPTION`);
   - no `UNLOGGED` table exists: `relpersistence = 'u'` is 0;
   - the `daftar_app` privilege matrix equals the S6 end-state matrix byte for byte (the S6C §2.9 end-state blocks). S7 adds no grant.
3. **Read SQL rules** for the S7 read modules, enforced by G-6 (§7.2):
   - no OFFSET;
   - no write;
   - no `accounting_fx_rate_lookup`;
   - no historical `is_active` filter;
   - no `Number()` on an amount;
   - every query runs through `db.scoped` (tenant and business), so RLS applies (`inventory-stock-read.ts:34-36`, `purchasing-reads.ts:47`).
4. **Consistency of a read.** Every read is one statement, or one `db.scoped` read transaction at the default `READ COMMITTED` isolation. Two reads on one screen may observe different commits; screens therefore re-read after every command they issue (A-03(7)).

---

## 3. Error model

S7 adds **no refusal code**. Its reads raise only existing codes, under their accepted mappings:

| Code | Raised by | HTTP |
|---|---|---|
| `inventory.warehouse_out_of_scope` | stock, stocktakes, warehouse-named reads | 403 (`inventory-errors.ts:58-66`) |
| `inventory.business_wide_scope_required` | supplier-balances, payable, credit-notes, payment-method-defaults | 403 (`purchasing-reads.ts:99-103`) |
| `inventory.product_not_found` · `inventory.stocktake_not_found` | items `ids=`, stocktake detail | 404 (the inventory classifier's not-found rule) |
| `supplier.not_found` · `purchase.not_found` | open-purchases, return-options | 404 (`PURCHASING_STATUS`, `purchasing-errors.ts:41` onward) |
| `FORBIDDEN` (no domain code) | a missing permission | 403 (`purchasing-reads.ts:105-107`) |
| `VALIDATION` | a bad query: cursor, `limit` > 50, `search` length, `ids` + `search`, a non-integer `amount` | 400 (`purchasing-reads.ts:109-113`) |

**Envelope.** It is unchanged: `{ error: { code, message, requestId, details? } }` (`error.filter.ts:25-28`). The domain code travels in `details.<domain>Code`.

**Web-side rules:**
- **(a)** The screen maps `ApiError.domainCode ?? ApiError.code` to `error.<code>` (A-15(d)).
- **(b)** A 403 on a page load renders `PermissionDeniedState`. A 403 on an action renders the mapped text.
- **(c)** A 409 carrying a code the S5C/S6C tables mark **retry: yes** is retried once, automatically, with the same document id: `purchase.fx_rate_changed`, `supplier_payment.settlement_changed`, `supplier_payment.fx_rate_changed`, `inventory.valuation_changed`. Only if it fails again is it shown.
- **(d)** A 5xx or a network failure renders GL "data safe error" (GL:77) and keeps the form and its document id, so "Try again" is a replay.

---

## 4. Packages and application

### 4.1 `@daftar/shared-contracts`

New file `packages/shared-contracts/src/merchant-reads.ts`, re-exported from `index.ts` beside `./inventory` and `./purchasing` (`index.ts:387-388`). It holds the DTOs of A-05 … A-09:
- `InventoryAccessDto`, `Phase3Permission`;
- `InventoryWarehouseDto`, `InventoryItemDto`, `InventoryUnitDto`, `InventoryStockRowDto`;
- `InventoryStocktakeSummaryDto`, `InventoryStocktakeDetailDto`;
- `SupplierBalanceRowDto`, `SupplierOpenPurchaseDto`, `SupplierOpenPurchasesDto`;
- `PurchaseReturnOptionsDto`, `PaymentMethodDefaultDto`;
- the query types.

Every money field is a `string` ending in `Minor`, and every quantity is a `string`. P1-GOLD-35 already forbids number-typed money in shared contracts (`tests/golden-regression/phase1/05-artifact-hygiene.golden.test.ts:48`).

### 4.2 API

**`apps/api/src/modules/inventory/`**
- `inventory-reads.ts` (new): the read service for A-05 … A-08. It reuses `reachableWarehouses`, which moves to a shared `apps/api/src/modules/inventory/read-scope.ts` and is re-exported from `purchasing-reads.ts`, so the S4/S5 imports keep working.
- `inventory-reads.controller.ts` (new): `@Controller('/v1/inventory')`, GET only.

  Route order in Nest: `stocktakes` before `stocktakes/:stocktakeId`. `:stocktakeId` uses `canonicalUuidParam` (`inventory/canonical-id.ts`).

**`apps/api/src/modules/purchasing/`**
- `supplier-balance-reads.ts` (new): A-09(a) and (b), plus the `payableSql` builder. The builder moves S6's extended payable SQL text out of `purchasing-reads.ts:813-838` unchanged. `purchasing-reads.ts` imports it back.
- `supplier-balances.controller.ts` (new): `@Controller('/v1/supplier-balances')`.
- `suppliers.controller.ts`: `@Get(':supplierId/open-purchases')`, and a `search` param on the list.
- `purchases.controller.ts`: `@Get(':purchaseId/return-options')`.
- `purchasing-reads.ts`:
  - `returnOptions`;
  - `search` in `listSuppliers`;
  - `purchaseSettlement` stays unrouted (`purchasing-reads.ts:1012-1048`), because S6 routes settlements.

**`apps/api/src/modules/payment-methods/`** (S6's module): `payment-method-defaults.controller.ts` (new), `@Controller('/v1/payment-method-defaults')`, plus a read method on S6's service.

**Composition.** Both `apps/api/src/app/merchant-api.module.ts:57-69` and `apps/api/src/app/app.module.ts:66` onward gain the three new controllers:
- `InventoryReadsController`;
- `SupplierBalancesController`;
- `PaymentMethodDefaultsController`.

`tests/integration/process-composition.test.ts:42-52` then stays green: single ⊇ merchant, with `AdminController` the only extra.

**Locale.** The item, stock, stocktake-detail, return-options and warehouse reads take the locale from `Accept-Language`. The parser is copied into `apps/api/src/common/locale.ts` from `catalog.controller.ts:29-33`, and catalog switches to it with no behaviour change.

### 4.3 Web (`apps/web`)

**New files:**
- `src/lib/phase3-api.ts`: the typed client.
- `src/lib/phase3-errors.ts`: `refusalKey(err)` → `error.<code>`.
- `src/lib/phase3-format.ts`:
  - `formatQty`;
  - `normaliseDigits`;
  - `bdi` helpers;
  - `useFormDocumentId()`: a `useRef(crypto.randomUUID())` plus a reset.
- `src/views/{stock,purchases,suppliers,common}/*.tsx`: pure views. Each area exports a `VIEW_REGISTRY` of `{ name, component, fixtures }` for T-15 and T-16.
- `src/app/[locale]/stock/page.tsx`, `stock/move/page.tsx`, `stock/count/page.tsx`, `stock/count/[stocktakeId]/page.tsx` and `stock/adjust/page.tsx`.
- `src/app/[locale]/purchases/page.tsx`, `purchases/receive/page.tsx`, `purchases/[purchaseId]/page.tsx` and `purchases/[purchaseId]/return/page.tsx`.
- `src/app/[locale]/suppliers/page.tsx`, `suppliers/[supplierId]/page.tsx` and `suppliers/[supplierId]/pay/page.tsx`.

**Edited files:**
- `src/app/api/proxy/[...path]/route.ts`
- `src/lib/client.ts`
- `src/app/[locale]/AppHeader.tsx`
- `src/app/[locale]/catalog/[id]/page.tsx`: the tracking card, as a view in `src/views/catalog/TrackingCard.tsx`.
- `src/app/[locale]/structure/page.tsx`: the association control, as a view in `src/views/structure/WarehouseBranches.tsx`. The existing `Table` on that Phase 1 page stays. The new control is a `List` below each warehouse.
- `src/messages/{ar,en,tr}.json`

**Views live under `src/views`, not `src/app`,** so that Next does not treat them as routes. `check-localization`'s `t()` scan is widened to `src` (§7.2).

**Message namespaces**, all in ar, en and tr:
- `nav.stock`, `nav.purchases`, `nav.suppliers`
- `stock.*`
- `purchasing.*`
- `suppliers.*`
- `payments.*`
- `error.inventory.*`, `error.purchase.*`, `error.purchase_reversal.*`, `error.supplier.*`, `error.supplier_return.*`, `error.supplier_payment.*`, `error.supplier_credit_allocation.*`, `error.supplier_refund.*`, `error.payment_method.*`, `error.accounting.*`, and `error.fallback`

The existing 208 keys, including the 21 `accounting.account.*` keys pinned by `tests/integration/accounting-guards.test.ts:390-420`, are untouched. **No S7 view renders an `accounting.*` key** (T-09).

---

## 5. Harness

1. **API read fixtures:** `tests/helpers/merchant-reads.ts` (new). It composes the S4/S5/S6 helpers (S6C §5) into one seeded business with:
   - two branches and three warehouses, one of them associated with both branches;
   - an assigned-scope manager, a business-wide owner and a cashier;
   - tracked products: simple, variant, and one with pre-variant base stock;
   - purchases: draft, received, partly returned, reversed, paid, part-paid, and foreign-currency;
   - a credit note with remaining value.
2. **Web unit and SSR runner.** A new config, `apps/web/vitest.config.mts`:
   - `test.environment: 'node'` and `include: ['test/**/*.test.{ts,tsx}']`;
   - `esbuild: { jsx: 'automatic' }`;
   - `resolve.alias: { '@': 'apps/web/src' }`;
   - a `globalSetup` that calls `protectFailingExitCode()` from `tests/helpers/exit-code.ts`. That is the first line of `tests/helpers/global-setup.ts:4-8`, without `ensurePostgres`.

   It adds **no new dependency**: vitest 3.2.7 is at the root (`package.json:83`), and `react-dom/server` ships with `react-dom`. `apps/web/package.json` gains `"test": "vitest run --config vitest.config.mts"`, and root `npm test` (`package.json:19`) appends `&& npm run test -w @daftar/web`.
   - Tests live in `apps/web/test/`, outside `src`. P1-GOLD-34's import rule (`05-artifact-hygiene.golden.test.ts:33-46`) scans only `src` and is unaffected.
   - `@daftar/shared-contracts` runtime helpers resolve from its built `dist`. The web job already builds it first (`.github/workflows/ci.yml:301-304`), and the backend job builds it at `ci.yml:82`.
3. **Phone-width render helper:** `apps/web/test/helpers/render.tsx`.
   - It renders a view with `renderToStaticMarkup` inside `<div dir=… lang=… style="width:360px">` and a `DaftarProvider` for the locale.
   - It returns the HTML and a light parsed tree, built with a small tag and attribute walker written in the helper. No jsdom is added: it appears only as an optional peer in `package-lock.json` (lines 5262, 7061), and adding it would be a new dependency.
4. **Timing isolation.** T-17 runs alone, after the other S7 suites, and never beside another `PG_DIR` user (SM:36).

---

## 6. Test plan

**Must-prove map:**
- MP-0: T-04 … T-07, T-13
- MP-1: T-01, T-02, T-03
- MP-2: T-08, T-09, T-10, T-12
- MP-3: T-15, T-16, T-18
- MP-4: T-11, T-14

Every invariant has a test that goes red when the invariant is removed (`docs/PHASE_3_PREMORTEM.md:675-681`).

| # | Suite | Proves | MP |
|---|---|---|---|
| T-01 | `tests/integration/read-s7-no-cache.test.ts` | §2(2) catalogue end state on a migrated database: no matview, views = `{credential_deliveries_safe}`, no unlogged table, no cache-named relation except `stock_levels`, `daftar_app` privileges = S6 end state. **Negative:** creating a matview inside a rolled-back transaction makes the assertion function report it. | 1 |
| T-02 | `tests/integration/read-s7-static.test.ts` | The S7 read modules have no module-level `Map`/`Set`/`WeakMap`/`lru`/`redis` and no memoize decorator. S7 web files have no `localStorage`/`sessionStorage`/`indexedDB`/`caches.`. `phase3-api.ts` issues every GET with `cache: 'no-store'`. **Negative:** a fixture string with `const cache = new Map()` at module scope is flagged. | 1 |
| T-03 | `tests/integration/read-s7-freshness.test.ts` | For each command, run it through the API and **immediately** read, with no sleep. The read reflects it: transfer → stock in both warehouses; receive → stock and supplier balance; return → returnable and balance; payment → open-purchases, supplier balance and purchase payable; credit allocation → in-your-favour; stocktake finalize → stock. The BFF proxy returns `cache-control: no-store` (a unit test of the route handler with a stubbed upstream). | 1, 0 |
| T-04 | `tests/integration/read-s7-stock.test.ts` | Zero for a key without a row. A simple product → `variantId: null`. Merchant variants → one row each, and the base variant never appears (PM-38). Pre-variant base stock ≠ 0 → one `variantId: null` row. Negative → `status=negative`. Keyset paging is stable under a concurrent insert. Scope: an assigned manager reaches only associated warehouses (`branch_warehouses`), and another warehouse is 403. The row has no `valuation`, `avg` or `lastStockSeq` key. | 0 |
| T-05 | `tests/integration/read-s7-supplier-balances.test.ts` | Per supplier and currency, `owed` = `GET /v1/suppliers/:id/payable` `byCurrency` = Σ `purchase_ap_outstanding` over its received purchases (the S6 T-19 equality lifted to the list). `inYourFavour` = Σ `remaining_txn_minor`. Business-wide only (the assigned manager gets 403). The `payableSql` refactor returns byte-identical rows for the two S4/S5 call sites. Paging never OFFSETs. `owedOnly` is correct. | 0 |
| T-06 | `tests/integration/read-s7-open-purchases.test.ts` | Oldest-first order. Reversed, draft and fully settled purchases are excluded. Proposal: with amount = Σ outstanding + 1, `unallocatedMinor = 1`; with an amount inside the second purchase, the first is full and the second partial. Other-currency rows get `proposedMinor: null`. Unreachable purchases are absent. BigInt at 10^17 has no float drift. | 0 |
| T-07 | `tests/integration/read-s7-return-options.test.ts` | `returnable = min(purchased − returned, onHand)` after two partial returns and after a transfer out. Each `reason` value for draft, reversed, inactive supplier and fully returned. Scope: another warehouse's purchase is 404. | 0 |
| T-08 | `apps/web/test/invisible.test.tsx` | Rendering every view fixture in `VIEW_REGISTRY` in all locales never emits a variant id equal to a fixture base-variant id, a `lastStockSeq`/`capturedAtStockSeq` value, a `businessTransactionId`, an entry id, a movement id or a `postingAccountId`. The fixtures contain these values deliberately. | 2 |
| T-09 | `apps/web/test/jargon.test.ts` + `scripts/check-localization.ts` (§7.2) | The per-locale denylist over the S7 namespaces fails on any hit. S7 web files contain no JSX text literal outside `t(…)` (except `<bdi>` data), do not render `.message`, and use no `accounting.*` key. **Negative:** a fixture catalog with `"stock.x": "Journal"` fails. | 2 |
| T-10 | `apps/web/test/error-keys.test.ts` | Every code in `PURCHASING_STATUS`, S6's `payment_method` table and the inventory codes S7 screens can hit (a list exported from `inventory-errors.ts`, or enumerated from `grep`ped `inventoryRefusal('…')` literals) has `error.<code>` in ar, en and tr. Each value is non-empty and contains no code-like token. | 2 |
| T-11 | `tests/integration/read-s7-authority.test.ts` | For every S7 read: the cashier gets 403; the assigned manager gets 200 on the warehouse and master reads and 403 `inventory.business_wide_scope_required` on the business-wide ones; the owner gets 200. `GET /v1/inventory/access` returns exactly the caller's subset. A member of business A with `X-Business-Id` of B gets 403 (RLS). | 4 |
| T-12 | `apps/web/test/od03.test.ts` | A-19: no `tax` identifier in S7 web files or `phase3-api.ts`, and no S7 key matching `/tax|vat|duty|ضريب|vergi|kdv/i`. No Customer Payments: no `customer` token in the S7 namespaces or client. | 2 |
| T-13 | `tests/integration/read-s7-items-units.test.ts` | Items: the base variant is never in `variants`; `search` does not match the base variant's (null) SKU; `ids=` resolves names in ar/en/tr with the `ar` fallback; `holdsStock` becomes true after the first receipt and false again after the stock is adjusted to zero. Units are resolved. | 0 |
| T-14 | `tests/integration/web-s7-client-contract.test.ts` | **The Android audit (A-10).** Every `export const` in `phase3-api.ts` has an audit row, and every `${BFF}/…` template matches an audited path. This is the P1-GOLD-38 mechanism (`06-web-contract.golden.test.ts:436-457`) applied to the new file. Each row is called **directly on the API** with Bearer + `X-Business-Id` + `Accept-Language` and **no cookie**. Every mutation is replayed with the same document id or key, and the replay answers 200 with `replayed: true`, or `changed: false` for the `state` kind. A deliberate refusal per command family carries its domain code in `details`. | 4 |
| T-15 | `apps/web/test/phone-width.test.tsx` | For every `VIEW_REGISTRY` entry × {ar, en, tr} × every fixture: SSR at 360px succeeds; `dir` is `rtl` for ar and `ltr` otherwise; there is no `style` width/min-width/flex-basis above 320px and no `100vw`; there is no design-system table markup; every rendered `<button>`, `<input>`, `<select>` and `<textarea>` carries an inline `min-height` (or `height`) of `2.75rem` or more, which is what the DS sizes emit (`packages/design-system/src/components/buttons.tsx:10-11,69-70`, `fields.tsx:22,91,213,286`); every number is inside `<bdi>`; no `translate()` result equals `'�'`, which would mean a missing key (`apps/web/src/lib/i18n.ts:15-16`). | 3 |
| T-16 | `apps/web/test/rtl-mirror.test.tsx` | The same views in ar and en produce the same structure, with only `dir` and texts differing. No `left`/`right` physical property appears in any rendered `style`. | 3 |
| T-17 | `tests/performance/phase3-s7-read-budgets.test.ts` | Seeded: 5,000 variants × 3 warehouses; 2,000 suppliers; 50,000 purchases; 200,000 AP lines. Budgets (p95 of 20 runs, warm): stock page ≤ 150 ms; supplier-balances page (20) ≤ 250 ms; open-purchases (one supplier with 500 purchases) ≤ 200 ms; return-options ≤ 50 ms. EXPLAIN shows index access on `stock_levels`, `purchases_supplier_idx` and `journal_lines_business_account_idx`, with no sequential scan on `journal_lines`. A failure is the only admission ticket to 0069 (A-02). | 0, 1 |
| T-18 | Manual acceptance evidence (not CI) | The six screens exercised in a real browser at 360×640 and 1280×800 in ar and en, with screenshots attached to the S7 acceptance page. This narrows TD-06 (`TECHNICAL_DEBT.md:15`) but does not close it (TL-2). | 3 |

**Unchanged suites that must stay green:**
- the S3/S4/S5/S6 suites;
- P1-GOLD-33 … 38;
- `accounting-guards`;
- `process-composition`.

---

## 7. Gate, guards and predecessor evolution

### 7.1 `scripts/phase3-s7-gate.ts` (two tenses, the form of `scripts/phase3-s5-gate.ts`)

**Constants:**
- `S6_BOUNDARY = '0068_supplier_settlement_commands.sql'` (S6C A-02).
- `S7_MIGRATIONS: readonly string[] = []`. It becomes `['0069_…']` only under A-02's exception.
- `S7_ACCEPTED: Readonly<Record<string,string>> = {}` holds the migration digests, of which there are none. Because the slice has no migration, the tense is chosen by `S7_ACCEPTED_MARK: string | null = null`. The freeze commit sets it to the acceptance commit's subject tag, `'P3-S7 accepted'`. If 0069 exists, `S7_ACCEPTED` holds its digest as in S5.
- `ACCEPTED = S7_ACCEPTED_MARK !== null`.

**Tenses:**

| Tense | Boundary check |
|---|---|
| Candidate | `frozenThrough === S6_BOUNDARY`; no migration file sorts after it, or exactly `S7_MIGRATIONS` |
| Accepted | `frozenThrough ≥ S6_BOUNDARY` (a floor). If `S7_MIGRATIONS` is empty, there is no file in the range 0069–0069 unless a later slice's gate owns it. Otherwise each file hashes to `S7_ACCEPTED` |

**Structural checks, in both tenses:**
1. **Boundary.** As in the table above. The last S6 file's digest also equals S6's accepted digest, which is read from `scripts/phase3-s6-gate.ts`'s `S6_ACCEPTED` by import, not copied.
2. **No cache.** Run by text before any database:
   - `discoverStoredRelations` (`scripts/guards/sql-schema.ts:257-268`) over every migration after `S6_BOUNDARY` returns `[]`;
   - no `CREATE VIEW`, `CREATE MATERIALIZED VIEW`, `GRANT` or `CREATE FUNCTION` appears after `S6_BOUNDARY`;
   - an admitted 0069 contains only `CREATE INDEX` and comments.
3. **Required objects.** The existence of:
   - the three new controllers and their registration in both process modules;
   - the eleven routes by decorator text;
   - `packages/shared-contracts/src/merchant-reads.ts` exported from `index.ts`;
   - `apps/web/src/lib/phase3-api.ts`;
   - PUT exported by the proxy;
   - the 11 S7 page routes of A-11;
   - `apps/web/vitest.config.mts`;
   - the S7 key namespaces in all three catalogs.
4. **Web static rules.** It runs `scripts/guards/web-responsive.ts` and the `check:localization` jargon pass as library calls, so that the gate fails with their messages.
5. **Suites discovered.** Every file matching `tests/**/read-s7-*.test.ts` and `tests/**/web-s7-*.test.ts`, plus `apps/web/test/**/*.test.{ts,tsx}`. There must be at least the 15 automated suites of §6 (T-01 … T-17 without T-18, counting the two T-09 parts as one).
6. **Runner canary.** `checkRunnerReportsFailure()`, as in `scripts/phase3-s5-gate.ts:444-457`. It also runs a second canary through `apps/web/vitest.config.mts` against a failing fixture, `apps/web/test/fixtures/runner-exit-code/failing.fixture.tsx`, so the web runner is proven able to fail.

**STEPS:**
1. `npm run gate:phase3:s6`, the permanent predecessor. It composes S5 … S1, P2 and Phase 1.
2. `npm run check:localization`, with the S7 jargon pass.
3. `npm run check:guards`, with Rules 19 and 23.
4. `npm run test -w @daftar/shared-contracts`.
5. `npm run test -w @daftar/web`: T-08 … T-10, T-12, T-15, T-16.
6. `npx vitest run <discovered read-s7-* and web-s7-* suites>`.
7. `npx vitest run tests/golden-regression/phase1/06-web-contract.golden.test.ts tests/integration/process-composition.test.ts`.
8. T-17, **in isolation**, last.

**Usage:** `npm run gate:phase3:s7 [-- --list]`. `package.json` gains `"gate:phase3:s7": "tsx scripts/phase3-s7-gate.ts"` next to the S6 line.

**CI.** `.github/workflows/ci.yml` changes as follows:
- The backend job's `gate:phase3:s4` step (`ci.yml:267-268`), as S5 and S6 will have advanced it, becomes `npm run gate:phase3:s7`. The gate composes its predecessors, so the older gate steps are **replaced by the newest one**, not duplicated.
- The web-admin job (`ci.yml:289-308`) gains `npm run test -w @daftar/web` after the contract builds, so a web regression is visible without Postgres.

### 7.2 Guards

**(a) `scripts/check-localization.ts`**
1. **Widen the `t()` scan.**
   - The walk root moves from `apps/web/src/app` (`check-localization.ts:56`) to `apps/web/src`.
   - The key regex becomes `/\bt\(\s*'([a-z][\w.]+)'\s*[,)]/`. The current one, at `:57`, misses keys with `_` and calls with variables. This matters because every `error.*` key contains `_`.
   - Template calls `t(\`nav.${…}\`)`, as in `AppHeader.tsx:72`, are checked by enumerating the `NAV` array's keys.
2. **Jargon pass (new).** For every key in the S7 namespaces (§4.3) and in every locale, the value must not match that locale's whole-word, case-insensitive denylist:
   - **en:** journal, debit, credit, ledger, payable, receivable, accrual, account, COGS, PPV, "weighted average", "carrying", "valuation", "binding", "base variant", "stock sequence", deficit, tenant, idempotency, UUID;
   - **ar:** قيد, مدين, دائن, دفتر اليومية, دفتر الأستاذ, ذمم, حساب, تكلفة البضاعة, المتوسط المرجح, متغير أساسي, تسلسل;
   - **tr:** yevmiye, borç kaydı, alacak kaydı, alacaklı, borçlu, muhasebe kaydı, hesap planı, mahsup, defter-i kebir, "ağırlıklı ortalama", "temel varyant".

   The `accounting.*` namespace is **excluded**: it is the accountant-facing chart, pinned by `accounting-guards.test.ts:399`. The denylist itself is the SIM-06 list (`docs/DAFTAR_SIMPLICITY_STANDARD.md:18`) plus the L:1302 list, translated. It lives in `scripts/guards/merchant-jargon.ts` so that T-09 imports the same list.

**(b) `scripts/static-guards.ts` Rule 19 (G-6).** `READ_SURFACE` (`scripts/guards/read-surface.ts:38`) is widened to match:
- `inventory-reads.ts`;
- `supplier-balance-reads.ts`;
- `purchasing-reads.ts`.

`purchasing-reads.ts` has no OFFSET, no `Number(`/`parseInt`, no `is_active` filter and no FX lookup at `bc08f5f`. A `grep` finds no hit, so it passes today. The rules' `why` texts stay accounting-worded, and each gains the stock and supplier counterpart. One rule is added: **no module-level result cache** (the T-02 regex), applied to the READ_SURFACE files.

**(c) New Rule 23, `scripts/guards/web-responsive.ts`,** over S7 web files. It flags:
- a physical-direction style key (`marginLeft|marginRight|paddingLeft|paddingRight|left:|right:|borderLeft|borderRight|textAlign:\s*'(left|right)'|float`);
- a numeric `width|minWidth|flexBasis` above `20rem`/`320px`;
- `100vw`;
- `import { … Table … } from '@daftar/design-system'`;
- a raw `<button` or `<a … onClick`;
- `size="sm"` or `size: 'sm'` on a design-system `Button` (A-16(4));
- `Number(`/`parseFloat(`/`parseInt(` on a name matching `/qty|quantity|amount|minor|price|cost|total/i`. This extends Rule 6b (`static-guards.ts:116-140`) from money names to quantities.

Each flag carries its DS:113 or A-16 reason. **A negative fixture test is included** in `tests/integration/static-guards-s7.test.ts`.

**(d) G-3** (`scripts/guards/no-authoritative-balance.ts`) is **unchanged**. S7 adds no relation, and T-01 plus the gate's no-cache check are the S7 proof. Widening G-3's name list to `summary|snapshot|projection` is recorded as an option (TL-10), not done.

### 7.3 Predecessor pins that S7 turns red, and their evolution (ENG)

S7 adds no migration, so no S2–S6 catalogue pin turns red. The pins S7 does move are these:

| # | Pin | Why S7 turns it red | Evolution |
|---|---|---|---|
| 1 | Root `npm test` (`package.json:19`) | It does not run the web tests | Append `&& npm run test -w @daftar/web` |
| 2 | `scripts/check-localization.ts:56-58` | The scan root and regex change (§7.2(a)). A Phase 1 page may then surface a previously unscanned unknown key | Fix any genuinely unknown key it finds in the same commit. Do not narrow the regex back |
| 3 | `READ_SURFACE` (`scripts/guards/read-surface.ts:38`) and its tests (`tests/integration/*read-surface*`, if present) | A widened path set | Add the three paths. Keep the accounting paths byte-identical |
| 4 | `.github/workflows/ci.yml` gate step (`:267-268`, as S6 leaves it) | Replaced by `gate:phase3:s7` | As §7.1 |
| 5 | `docs/DAFTAR_LOCALIZATION_GLOSSARY.md` §1 | Six new terms plus "Balance in your favour" | Added through the linguistic gate (GL:3) |
| 6 | `TECHNICAL_DEBT.md:15` (TD-06) | Automated SSR phone-width checks now exist, but a real browser run is still manual | Reword to "no automated **browser** viewport run (SSR 360px structural checks exist since P3-S7)". Keep it open (TL-2) |
| 7 | `PROJECT_STATUS.md` | The S7 row | Standard |
| 8 | `apps/web/src/lib/client.ts:75-77` behaviour | A caller key is now respected | Phase 1 callers never pass one, so it is behaviour-identical for them. P1-GOLD-38 is unchanged |
| 9 | `apps/api/src/modules/catalog/catalog.controller.ts:29-33` | The locale parser moves to `common/locale.ts` | Pure move; the catalog suites stay green |
| 10 | `purchasing-reads.ts:813-838` | The payable SQL moves into `payableSql` | T-05 asserts byte-identical results for both existing call sites. The S4/S5/S6 read suites stay green unchanged |

---

## 8. File ownership (SAFE_CONCURRENCY = 4, SM:45)

SM:45 names three S7 streams: the read API, the web screens and the tests. They are split here into four agents. The web screens are split by domain because they are the largest stream.

| Agent | Owns | Starts after |
|---|---|---|
| **R — Read API** | `packages/shared-contracts/src/merchant-reads.ts` and its export; `apps/api/src/modules/inventory/{inventory-reads.ts,inventory-reads.controller.ts,read-scope.ts}`; `apps/api/src/modules/purchasing/{supplier-balance-reads.ts,supplier-balances.controller.ts}` plus the edits to `suppliers.controller.ts`, `purchases.controller.ts` and `purchasing-reads.ts`; `apps/api/src/modules/payment-methods/payment-method-defaults.controller.ts`; `apps/api/src/common/locale.ts`; both process modules; `tests/helpers/merchant-reads.ts`; T-01, T-03 … T-07, T-11, T-13, T-17 | S6 frozen |
| **F — Web foundation and enforcement** | proxy `route.ts`, `client.ts`, `phase3-api.ts`, `phase3-errors.ts`, `phase3-format.ts`, `AppHeader.tsx`; `apps/web/vitest.config.mts`, `apps/web/package.json`, `apps/web/test/helpers/**` and fixtures; `scripts/check-localization.ts`, `scripts/guards/{merchant-jargon.ts,web-responsive.ts,read-surface.ts}`, `scripts/static-guards.ts`; `scripts/phase3-s7-gate.ts`, root `package.json`, `ci.yml`; the `nav.*`, `common.*` and `error.*` keys; T-02, T-08 … T-10, T-12, T-14 … T-16; docs pins 5–7 | R's DTO file (day 1) |
| **I — Inventory screens** | `apps/web/src/app/[locale]/stock/**`, `apps/web/src/views/{stock,catalog,structure}/**`, the `catalog/[id]` and `structure` page edits, the `stock.*` keys, the `VIEW_REGISTRY` fixtures for those views | F's client and render helper |
| **U — Purchasing and supplier screens** | `apps/web/src/app/[locale]/{purchases,suppliers}/**`, `apps/web/src/views/{purchases,suppliers,common}/**`, the `purchasing.*`, `suppliers.*` and `payments.*` keys, the `VIEW_REGISTRY` fixtures for those views | F's client and render helper |

**Catalog files.** The three `messages/*.json` files are shared text. Each agent appends only its own namespace block, in the fixed order F, I, U, and the coordinator merges. Parity is checked by `check:localization` on every merge.

**Database.** Only R and F's T-14 need Postgres, and they use one `PG_DIR` each (SM:36). T-17 is run by the coordinator alone.

---

## 9. Real blockers and Tech Lead notes

### 9.1 Real blockers

**None.** Each candidate was checked against the six classes:
- **Tax UI.** It is bounded by OD-03, a legal and tax rule that is already decided as "absent" for Phase 3 (A-19). S7 builds nothing that needs it.
- **Account choice (L:1309) against S6's `postingAccountId`.** This is not a contradiction. The system chooses the account from the method type by `system_key` (A-09(e)), and S6's command contract is unchanged. The choice of mechanism is TL-3.
- **Browser test tooling.** It is not a paid provider or credential: Playwright is free. Whether to add it is a scope decision (TL-2). S7's CI proof does not depend on it.
- **Zero migrations.** There is no destructive data decision.

### 9.2 Tech Lead notes (engineering rulings to confirm)

- **TL-1 · Sequencing and S6 names.** S7 needs S6 accepted and frozen. Re-check the following against frozen S6 before S7 R starts:
  - the route paths and permission sets of S6C A-18;
  - the name and body of the extended payable SQL;
  - the `payment_method` error table;
  - `supplier_payments.posting_account_id`;
  - the `systemType` list (`S6C:703`).
- **TL-2 · Phone-width proof without a browser in CI.**
  - **What CI proves:** static layout rules (Rule 23), SSR at 360px in all three locales (T-15/T-16) and a manual screenshot pass (T-18).
  - **What CI does not prove:** actual rendering, text overflow from long Turkish or Arabic strings, or focus order.
  - **Recommendation:** accept this for S7, and schedule a Playwright job (Chromium at 360×640, ar/en/tr, the six screens) as its own CI job in the first UI-heavy later phase. That closes TD-06.
  - **Alternative:** add `@playwright/test` now. That means a new dev dependency plus a browser download in CI (about 150 MB per run, cacheable).
- **TL-3 · How the first payment method's account is chosen.**
  - **Ruled here:** a new read, `GET /v1/payment-method-defaults`, returns which of the five method types are available. The web then resolves the account id from `GET …/accounting/accounts` by `systemKey`, which needs `accounting.view` besides `accounting.chart.manage`.
  - **Alternatives:**
    - (a) the defaults read returns the `postingAccountId` directly. This is simpler for Android, but a GL id reaches a merchant-surface read;
    - (b) S6's `POST /v1/payment-methods` accepts `postingAccountId` omitted and derives it from `systemType`. This is cleanest, but it changes an S6 command after S6 is frozen, so it would be a follow-up migration or service change.
  - **The merchant never sees the account under any of the three options.**
- **TL-4 · Two actions beyond the six screens.**
  - (a) **"Starting stock"** in Adjust Stock, through `POST /v1/inventory/openings`: business-wide + `inventory.adjust`. Without it, a new merchant's initial quantities would have to go through "Found extra", which posts a gain instead of an opening.
  - (b) **"Undo receipt"** on purchase detail, through `POST …/reversal` under S5's four preconditions (S5C A-09). The action is shown only when S5 would accept it; otherwise the button is absent, not disabled.
  - Both are ENG+TL. Cutting either keeps the API but removes the UI.
- **TL-5 · No statements or ageing in S7.** S4C and S5C point these to S7, but P:253-257 does not list them. The supplier detail shows only:
  - the outstanding balance per currency;
  - the balance in the merchant's favour;
  - open purchases;
  - payments, returns and purchases lists.

  Recommendation: statements and ageing go to the reporting phase.
- **TL-6 · No document numbers.** DM `number` stays unbuilt (S4C, S6C A-04). A number would need a migration (a column plus a per-business sequence) and a numbering policy, and possibly a legal numbering rule for purchase documents in some jurisdictions. Screens identify documents by supplier, date, the supplier's own reference and amount.
- **TL-7 · No stock value on screens.** `stock_levels` holds `valuation_base_minor` (`0059:105`), but S7 shows quantities only. Cost visibility has no permission of its own among P3-AL-38's eleven, and a value column would invite "why does value ≠ qty × price". Recommendation: a valuation report in the reporting phase.
- **TL-8 · Blind counting.** While a stocktake is a draft, expected quantities are hidden unless the caller holds `inventory.adjust` (A-08). The alternative is to always show them, which is simpler but invites counting to the number.
- **TL-9 · Navigation on phones.** DS:113 asks for bottom navigation on mobile. S7 adds three items to the existing wrapping header instead. Bottom navigation is a shell change across Phase 1 pages and is left to a UX pass.
- **TL-10 · G-3 name list.** Optionally widen `no-authoritative-balance.ts` relation-name discovery to `summary|snapshot|projection|cache`, with `stock_levels` kept as the named exception at `:205`, so that a later slice cannot add a projection under another name. S7 proves the property by catalogue (T-01) instead.
- **TL-11 · `GET /v1/inventory/access` is a Phase 3 permission read.** A generic `GET /v1/businesses/current/permissions` would serve Phase 4+ too, but it edits the Phase 1 tenancy controller. Recommendation: keep it inventory-scoped now, and generalise it when Phase 4 needs it.
- **TL-12 · The glossary must be edited.** GL requires every term change to pass the linguistic quality gate (GL:3). The Turkish and Arabic renderings in A-15 are proposals for that gate. The denylist in §7.2(a) should be reviewed in the same pass, because "borç" and "حساب" have ordinary meanings. The denylist is therefore scoped to the S7 namespaces and to specific compound forms only.

---

## Annex R. Reconciliation against the frozen P3-S6 (coordinator, 2026-09-27)

The rulings header above takes precedence over the body wherever they differ. The rows below are the evidence behind it.

## 1. Mismatches (draft → the S6 code → correction)

| # | Draft text / section | S6 code in the tree (file:line) | Correction |
|---|---|---|---|
| 1 | Status/Tree: "reset to `bc08f5f`", "frozenThrough = 0064", "S6 is not in the tree"; sources "0000–0066 at bc08f5f"; every "S6C Ann" | HEAD `59ddc5b`: frozenThrough 0066; 0067/0068 are present as the S6 candidate | Re-base all citations to the S6 freeze commit, citing `docs/PHASE_3_S6_CONTRACT.md` plus code. Drop "S6C". R still starts only after the S6 freeze (TL-1) |
| 2 | A-03(2), A-09(a), §4.2, §7.3#10: payable SQL at `purchasing-reads.ts:813-838`; "the payableSql refactor is identical for the **two** existing call sites" | The const is `S5_PAYABLE_SQL` (still named S5 though S6 extended it) with a `%FILTER%` placeholder, at `purchasing-reads.ts:840-885` (doc comment 821-839). It has **three** call sites: `:1288` supplierPayable, `:1330` purchasePayable, `:1432` purchaseSettlement | Cite 840-885. The builder must serve all three call sites, and T-05 proves identical rows for all three. Note that `groupBy: 'supplier_currency'` needs `p.supplier_id` projected in the `ap` CTE, so the text changes and only the results stay identical |
| 3 | A-09(a) `inYourFavour = Σ remaining_txn_minor` | The column is `supplier_credit_notes.remaining_amount_minor` (`0065:263`). The DTO field is `remainingTxnMinor` (`shared-contracts/src/purchasing.ts:391`) | Use `Σ n.remaining_amount_minor` |
| 4 | A-11 `purchases/[purchaseId]` lists "S6's …/settlements" under permission `purchases.view` | `GET /v1/purchases/:purchaseId/settlements` requires **`suppliers.view`** plus the warehouse scope (`supplier-settlements.controller.ts:118-119`, `purchasing-reads.ts:1504-1507`) | Render the settlements section only when `access.permissions ∋ suppliers.view`. Add this row to the T-11 matrix |
| 5 | A-11 `suppliers/[supplierId]`: "(business-wide only)" is attached to payable and credit-notes only | `GET /v1/suppliers/:id/payments` also calls `assertBusinessWide` (`purchasing-reads.ts:1474-1476`) | Mark `…/payments` as business-wide too. Add it to the `business_wide_scope_required` row of §3 |
| 6 | A-11 `purchases/receive`: receive is `purchases.receive`; A-13 "Paid now" toggle | receive-and-pay requires `purchases.receive` **and** `suppliers.pay`, each over the purchase warehouse (`purchases.controller.ts:127-129`; S6 A-18/A-19; `supplier-settlement.ts:108-116`). `payment_date = documentDate`. `purchaseAmountAppliedMinor` may be omitted only when the payment currency equals the purchase currency (`supplier-settlement.ts:99-104`) | Show "Paid now" only with `suppliers.pay`. It has no date field. For a foreign purchase, ask for both amounts |
| 7 | A-11 route refs `purchases.controller.ts:172` and `:165,178,185` | S6 inserted receive-and-pay, so the list is now `:196`, returns `:189`, get `:202`, payable `:209` | Update the lines |
| 8 | A-04/A-05/§3 refs `purchasing-reads.ts:83-97, 99-103, 105-107, 109-113, 855-871, 895-914, 1012-1048` | These moved to `:100-114` reachableWarehouses, `:116-120` assertBusinessWide, `:122-124` requirePermission, `:126-130` cursorOf, `:1257-1272` listSuppliers, `:1295-1314` listPurchases and `:1412-1459` purchaseSettlement. The last is still unrouted; S6 routes `purchaseSettlements` at `:1504` | Update the lines. The claim that `purchaseSettlement` stays unrouted is still true |
| 9 | §3(c) auto-retry list: `purchase.fx_rate_changed`, `supplier_payment.settlement_changed`, `supplier_payment.fx_rate_changed`, `inventory.valuation_changed` | S6 also marks `supplier_credit_allocation.settlement_changed` (`purchasing-errors.ts:143`), `supplier_refund.settlement_changed` (`:156`) and `supplier_refund.fx_rate_changed` (`:157`) as retry: yes (S6 §3) | Add the three codes |
| 10 | §4.3 error namespaces; T-10 "every code in PURCHASING_STATUS, S6's payment_method table" | (a) `supplier_credit_note.not_found` (404, `purchasing-errors.ts:161`) can be reached from credit allocation and refund, but `error.supplier_credit_note.*` is missing. (b) The code holds `*.residue_below_base_unit` codes (`:121,142,155`, R-77/R-78) that the S6 doc's §3 table omits. (c) `PURCHASING_STATUS` (`:55`) and `PAYMENT_METHOD_STATUS` (`payment-method-errors.ts:17`) are **module-private**; only the types and `isPurchasingCode`/`isPaymentMethodCode` are exported | Add `error.supplier_credit_note.*`. T-10 enumerates codes from the code, not the doc. Allow R an additive edit to two S6 files: `export const PURCHASING_CODES` / `PAYMENT_METHOD_CODES = Object.keys(…)` (list them in §8) |
| 11 | §3 table: `VALIDATION` (400); the not-found rows | The code is `VALIDATION_FAILED` (`domain-core/src/errors.ts:62-63`). `GET /v1/supplier-payments/:id` answers a plain `NOT_FOUND` with no domain code (`purchasing-reads.ts:1465`) | Use `VALIDATION_FAILED`. The web needs `error.NOT_FOUND` / `error.VALIDATION_FAILED` keys for the `domainCode ?? code` path |
| 12 | A-12(2) `domainCode`: "`details.accountingCode`, falling back to `details.code`" | No wire payload carries `accountingCode`. `ACCOUNTING_REFUSED` carries `details.code` (`error.filter.ts:37-39`, `accounting/src/errors.ts:137-138`), and S6's `accounting.fx_rate_missing` from `readSettlementFx` arrives this way. `purchasingCode` (`purchasing-errors.ts:333`) and `paymentMethodCode` (`payment-method-errors.ts:60`) match the draft | Order: `inventoryCode`, `purchasingCode`, `paymentMethodCode`, `catalogCode`, then `details.code` iff `code === 'ACCOUNTING_REFUSED'` |
| 13 | §7.2(b) and §7.3#3: widen G-6 `READ_SURFACE` to `purchasing-reads.ts`, which "has no … FX lookup … passes today" | S6 added `readSettlementFx`, which calls `accounting_fx_rate_lookup(` (`purchasing-reads.ts:910-921`) for command-side FX binding. Rule "no current exchange-rate lookup" (`scripts/guards/read-surface.ts`, rule 3) would fail | Do **not** add `purchasing-reads.ts`. Widen G-6 to `inventory-reads.ts` and `supplier-balance-reads.ts` only (the payable builder moves there). Moving `readSettlementFx` out of the file is the alternative, but it edits S6 code and is not recommended |
| 14 | §7.1 structural 1: "S6's accepted digest … read from `phase3-s6-gate.ts`'s `S6_ACCEPTED` by import, not copied" | `S6_ACCEPTED` is a non-exported const (`phase3-s6-gate.ts:55`). The script runs its checks at module top level and calls `process.exit` (file tail), so importing it runs the S6 gate | Check 0067/0068 `sha256` from `MIGRATION_MANIFEST.json` against the files on disk. Step 1 (`gate:phase3:s6`, accepted tense) proves the accepted digests |
| 15 | §7.1 runner canary "as in `phase3-s5-gate.ts:444-457`" | S6 edited the S5 gate: `checkRunnerReportsFailure` is at `phase3-s5-gate.ts:447-462`; the S6 copy is at `phase3-s6-gate.ts:525` | Cite the S6 gate's copy |
| 16 | §7.1 accepted tense: "no file in the range 0069–0069 unless a later slice's gate owns it" | The S6 accepted tense only checks `0067–0068` exactly, as a floor (`phase3-s6-gate.ts:244-268`) | Accepted tense with `S7_MIGRATIONS = []`: check nothing after 0068, because P3-S8 owns 0069+. With an admitted index migration: `0069_…_read_indexes.sql` hashes to `S7_ACCEPTED`, and S8 starts at **0070**. The reservation of 0069 is correct |
| 17 | TL-6 "DM `number` stays unbuilt (S4C, **S6C A-04**)" | Frozen S6 A-04 says "No DM `number`. Display numbering is **an S7 concern**" (`docs/PHASE_3_S6_CONTRACT.md:201`) | TL-6 must answer S6's deferral explicitly: no stored or derived number in S7. Record it as debt, or move it to S9/reporting |
| 18 | A-09(e) `GET /v1/payment-method-defaults`: `accounting.chart.manage` and **business-wide** | S6's method commands are permission-only, with no warehouse and no business-wide requirement (S6 A-03; `inventory-authorization.ts:61-64`) | Make the read permission-only, or say why the read is stricter than the create it feeds. The account-selection mapping is S7's own UX rule: S6 accepts any `system_key` NULL or any of the 5 settlement keys for any type (S6 A-06, TL-6) |
| 19 | A-09(b) open-purchases proposal | A payment holds 1..50 distinct allocations (`purchasing.schemas.ts:367-392`, S6 A-07). R-77 refuses a leftover `O−a` with `conv(O−a)=0`, as `supplier_payment.residue_below_base_unit` (`0067:198`) | The proposal stops after 50 rows and counts the rest in `unallocatedMinor`. It never proposes a partial `a` that leaves a sub-unit residue: round up to `O`, or stop |
| 20 | A-13 and A-18 payment-method pickers | `GET /v1/payment-methods` returns `{items}`, **active and inactive**, with `isActive`. `names` holds all three locales **unresolved** (`payment-method.service.ts:196-208`, `payment-methods.ts:67-78`) | The web filters on `isActive` and applies the locale fallback (requested, then `ar`, then any) in its own view logic. `requiresReference` drives the reference field |
| 21 | TL-4(b): "Undo receipt" shows "only when S5 would accept it" | S6 makes `purchase_reversal.payment_allocated`/`.credit_allocated` reachable. Knowing this needs settlement state, and the S6 route needs `suppliers.view` | Expose `reversible` plus a reason from an S7 read (for example the return-options header), computed with `purchase_settlement_state()` (EXECUTE `daftar_app`, `0066:112`, S6 body `0067:1415`) |
| 22 | A-02 grants and indexes cite "S6C A-17", "S6C §2.2" | Grants to `daftar_app`: `0067:642-644`. Indexes: `supplier_payments_supplier_idx` `0067:359`, `supplier_payment_allocations_purchase_idx` `0067:407`, `supplier_credit_allocations_purchase_idx` `0067:457`. `purchase_ap_outstanding` S6 body: `0067:1385-1409`, EXECUTE unchanged (`0066:110-111`) | Cite migration lines. Add the credit-allocation index. S7 must not replace the function: S6 gaps discovery hashes its `prosrc` (`0067:1820,1850`) |
| 23 | §4.2 `:stocktakeId` uses `canonicalUuidParam` | The S3–S6 path ids all use `strictUuidParam` (`canonical-id.ts:26`), which refuses and never lower-cases | Use `strictUuidParam` |
| 24 | Minor line drift | `inventory-authorization.ts:131-133` → `:210`. `merchant-api.module.ts:57-69` → `:59-74` (now lists `PaymentMethodsController`, `SupplierSettlementsController`). `shared-contracts/src/index.ts:387-388` → `:387-390`. CI gate step `ci.yml:267-268` still runs `gate:phase3:s5`. Web-admin job `:291-310` | Update the lines. The CI step is advanced to s6 by the S6 freeze, then to s7 by S7 |
| 25 | §3/A-06 "`limit` > 50 → 400" | The existing purchasing list reads accept 1..100 (`purchasing.schemas.ts:448-453`). `SupplierListQuerySchema` is `.strict()` (`:457-464`) | Keep 1..100 for the extended `GET /v1/suppliers` and add `search` to the strict schema. The 50 cap applies only to the new S7 routes |
| 26 | §5 "S4/S5/S6 helpers (S6C §5)" | The S6 helper is `tests/helpers/supplier-settlement.ts`. The S6 privilege matrix is `tests/security/settlement-s6-grants.test.ts` | Name them. T-01 reuses the S6 matrix as the "S6 end state" |

The draft's citations of frozen S5 were checked and hold:
- `0065:224` `supplier_returns_purchase_idx`;
- `0065:289` `supplier_credit_notes_supplier_idx`;
- `0065:520-521` the `daftar_app` grants;
- `0066:70-90` the `purchase_ap_outstanding` body;
- `0066:108-113` its EXECUTE grants.

Also correct:
- the `systemType` list: `cash|card|bank_transfer|wallet|cheque|other` (`0067:288`, `payment-methods.ts:21`);
- `postingAccountId`, which is present only for `accounting.view`/`chart.manage` readers;
- `supplier_payments.posting_account_id`, which exists and is **not** exposed in `SupplierPaymentDto`;
- the S6 TL numbers the draft cites (TL-3, TL-7, TL-10, TL-16) and A-13/A-17/A-18.

The web notes were verified against `apps/web`:
- **(a) No PUT in the BFF proxy.** It exports only GET, POST, PATCH and DELETE (`app/api/proxy/[...path]/route.ts:30-33`). S6's `PUT /v1/payment-methods/:id` (`payment-methods.controller.ts:60`) joins the S3/S4 PUTs that would all answer 405. `apps/admin`'s proxy has the same gap (`:23-26`), which is out of S7 scope.
- **(b) `apiFetch` overwrites the idempotency key.** It overwrites any caller key (`lib/client.ts:75-77`), and the 401 refresh retry (`:79-81`) re-enters `apiFetch`, so the retry mints yet another key. A caller-owned key fixes both.
- **(c) Error details are dropped.** `ApiError` holds only `status`/`code` (`client.ts:48-55`), and `apiFetch` reads only `data.error.code` (`:83-86`).
- **(d) Two headers are lost.** `accept-language` is not forwarded (`route.ts:16`), and `cache-control` is dropped (`route.ts:26`).

All four notes stand.

### 2. Endpoints the draft calls "new" that already exist

**None.**
- All eleven S7 routes are absent from `apps/api/src`:
  - `inventory/access`, `inventory/warehouses`, `inventory/items`, `inventory/units`, `inventory/stock`;
  - `inventory/stocktakes` and `inventory/stocktakes/:id`;
  - `supplier-balances`, `suppliers/:id/open-purchases`, `purchases/:id/return-options`, `payment-method-defaults`.
  - The inventory module still has no `@Get`.
- The draft already attributes these routes to S6 and does not re-create them:
  - `GET /v1/purchases/:id/settlements`, `GET /v1/suppliers/:id/payments`, `GET /v1/supplier-payments/:id` (`supplier-settlements.controller.ts:104-122`);
  - `GET /v1/payment-methods` and `GET /v1/payment-methods/:id` (`payment-methods.controller.ts:97-105`);
  - receive-and-pay, supplier-payments, supplier-credit-allocations and supplier-refunds.

Two near-overlaps to state explicitly:
- **Pay Supplier result.** It can show the command's `SupplierPaymentResultDto`, or re-read `GET /v1/supplier-payments/:id`. It needs no new read.
- **`/open-purchases` against the per-purchase payable read.** It is not a duplicate: it is a list with a proposal, while `GET /v1/purchases/:id/payable` covers one purchase. Both must agree (T-06 asserts `outstandingTxnMinor = purchase_ap_outstanding`).
