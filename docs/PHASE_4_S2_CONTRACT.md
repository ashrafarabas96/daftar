# PHASE 4 — S2: THE ATOMIC SALE COMMIT PRIMITIVE (contract)

Owner of this document: the sale/inventory contract owner of P4-S2.
It covers the application and domain side of the slice: the DTOs, the schema,
the payload, the service, the reads, the routes, the exact DDL the single
migration owner must write, and the failure-injection plan that proves the
atomic sale law. It writes no SQL file.

Conventions: `0063:400` means line 400 of
`infrastructure/database/migrations/0063_*.sql`. `P4-AL-NN` are decisions of
`docs/PHASE_4_ARCHITECTURE_LOCK.md`; `TL-P4-S2-KN` are Tech Lead rulings
relayed into this slice. Where the lock and the code disagree, the code wins
and the disagreement is recorded in §E.

---

## A. THE CONTRACT

### A-01 One command, one transaction, one route

`POST /v1/sales` performs, in ONE database transaction: the `sales` row and its
items; the stock movements through `inventory_apply_stock_movements`, which is
NOT changed; the `stock_levels` update that routine performs; the
`stock_source_bridge_sale` rows; the COGS journal entry; the `invoices` row and
its items; the invoice number allocation; and the revenue/AR entry.

There is no `POST /v1/sales/:id/confirm`, no `POST /v1/invoices`, no
`POST /v1/sales/:id/post` and no draft-then-commit pair, because each of those
IS one of the seven states P4-AL-16 forbids, offered over HTTP.

There is no void and no return route (`TL-P4-S2-K1`): a registered operation
kind is a registration of authority, `0077` registers `sale.commit` ALONE, and
`sale.void` / `sale.return` belong to the slices that supply their writers.

Files: `apps/api/src/modules/selling/sales.controller.ts`,
`apps/api/src/modules/selling/selling-permissions.ts`.

### A-02 What the client may state, and nothing else

`SaleCommitDto` (`packages/shared-contracts/src/sales.ts`):

```
saleId, settlementMode: 'credit'|'cash', customerId|null, warehouseId,
documentDate, dueDate|null, taxMinor: '0', notes|null,
lines[{ lineId, productId, variantId|null, quantity, discountMinor }]
```

Absent by design, because "validation implies the client's number could be
adopted" (P4-AL-18): any unit price, line total, subtotal, total, tax amount,
COGS figure, unit cost, currency, FX rate, branch id or stock figure. The
schema is `.strict()`, so one of them is an unknown-key refusal before any
service runs. `SALE_FORBIDDEN_REQUEST_FIELDS`
(`packages/domain-core/src/sale.ts`) is the enumerated list.

The line's identity is `productId` plus, ONLY for a product that has merchant
variants, `variantId` — the accepted P3 convention
(`shared-contracts/src/purchasing.ts:19-22`). The hidden base variant never
leaves the server (P3-AL-52), so a simple product's line states
`variantId: null` and the server resolves the stock key through
`resolveVariants`. This is why the RESOLVED variant is outside the signed
intent: the intent must be computable from the request alone, before the
catalogue is read.

Every money value is an integer count of minor units carried as a STRING; a
JSON number is an IEEE double and cannot hold an LBP total exactly. Quantities
are decimal strings.

### A-03 Idempotency: the proof before the state

The mechanism is P4-AL-30's: a caller-supplied document UUID plus a stored
`intent_sha256`. There is no `idempotency_key` column, no `idempotencyKey`
field and no `Idempotency-Key` header, because "a bare key proves a request was
seen before and says nothing about WHICH request it was"
(`[[daftar-idempotency-key-is-not-permission]]`).

The order is load-bearing. `SaleCommitService.plan` computes
`saleCommitIntentSha256(request)` FIRST, then reads the stored header
(`readSaleHeader`), and only then — before the customer, the catalogue, the
rate or a single stock level is read — decides:

- same digest ⇒ the stored sale is returned, having changed nothing;
- different digest ⇒ `sale.idempotency_conflict` (409).

`[[daftar-registry-before-state]]`: a stale request replayed after a later
transition, whose handler reads state first, performs a second real change.

The application pre-read is a fast path only. `sale_commit` takes the
per-document advisory lock and REPEATS the proof under it (C-09), so two
concurrent identical commits serialize in the routine, not in the service.

### A-04 The command reads no clock

`[[daftar-a-command-must-not-read-the-clock]]`. `documentDate` and `dueDate`
are REQUIRED fields with no default in the DTO, the schema, the service, the
payload builder or the trusted database command. `dueDate` is `nullable` and
not `optional`, so "no credit term" is stated rather than inferred from an
absent field.

There is exactly ONE clock read on the whole path — `SaleCommitService`'s
`readBusiness`, which asks whether `documentDate` is after today in the
business's timezone — and it is a REFUSAL, never an adoption: no value derived
from `now()` is stored, signed or fingerprinted. The FX instant is computed in
SQL from the DATE alone (`((date + 1) AT TIME ZONE tz) - interval '1 second'`),
with no `now()`, so the routine derives the same instant and the two agree by
construction. The accepted `PurchaseReceiptService` reads exactly this and for
exactly this reason.

C-09 forbids the routine a `DEFAULT` on either date argument and any
`coalesce(p_*, current_date)`.

### A-05 The `invctl/1` payload and the intent subset

`packages/inventory/src/payload.ts` registers `sale.commit` (the registry is
closed; `packages/inventory/test/payload.test.ts` enumerates it absolutely).

Header: `sale_id, settlement_mode(code), customer_id(uuid,null),
warehouse_id, branch_id, invoice_id, document_date, due_date(null),
currency(code), rate_id(uuid,null), rate_r10, rate_source(code), rate_at,
subtotal_txn_minor, discount_txn_minor, tax_minor, total_txn_minor,
total_base_minor, notes_w1..w8, line_count`.

Per line: `line_id, product_id, merchant_variant_id(uuid,null), variant_id,
qty_q4, discount_minor, unit_price_c10, net_txn_minor, base_share_minor`.

`INVENTORY_OPERATION_INTENT_FIELDS['sale.commit']` selects
`sale_id, settlement_mode, customer_id, warehouse_id, document_date, due_date,
tax_minor, notes_w1..w8, line_count` and per line
`line_id, product_id, merchant_variant_id, qty_q4, discount_minor`.

The tests that make this a law rather than a comment
(`packages/inventory/test/sale-payloads.test.ts`, 32 tests): the intent digest
equals the hand-built `canonicalInventoryIntent` stream; the SAME request with
a different resolved price, rate, branch, invoice id or **resolved stock
variant** has the SAME intent digest while the payload digests differ; any
client-stated change — including line ORDER — changes it; tenant and business
are in it; no clock; no cost, value, COGS or average appears by name in either
stream; no `number_seq` or `document_number` appears in either.

### A-06 The server's arithmetic

One currency per sale: each line's catalogue price is in the product's own
`price_currency`, and a basket mixing two currencies has no single total to
invoice. It is REFUSED (`sale.currency_unknown`) rather than converted, because
converting would invent a cross-rate nobody stated.

`products.base_price_minor` is already an integer count of MINOR units
(`0005:21`), overridden by `product_variants.price_minor` when the named
variant carries one (`0005:44`: NULL inherits). So:

- `gross = HALF_EVEN(qtyQ4 x priceMinor / 10^4)`, taken ONCE from the exact
  fixed-point operands, with no intermediate rounding
  (`[[daftar-rounding-is-not-additive]]`);
- `net = gross - discount`; `subtotal = Σ gross`; `total = subtotal - Σ discount + 0`;
- ONE conversion `totalBaseMinor = convertToBaseMinor(totalTxnMinor)`, and the
  per-line base shares are an EXACT integer partition of it (`0043`'s per-line
  law) — never eight separate conversions and never a rounding account.

`halfEvenDiv` in `sale-commit.service.ts` is exact HALF_EVEN by integer
division and remainder, sign-symmetric, with no float: the same arithmetic as
`inventory_half_even` (`0060:85-111`), because a second rounding rule would
disagree only on the numbers nobody tested.

Refused rather than silently adjusted: `total <= 0` ⇒ `sale.total_zero`
(`invoices.total_txn_minor` is `CHECK (BETWEEN 1 AND 10^18)`, `0075:260`, so a
sale discounted to nothing is refused here rather than at the invoice insert,
where the only possible outcome is a rolled-back transaction);
`discount > gross` ⇒ `sale.discount_invalid`.

### A-07 Tax

OD-03 is OPEN. `taxMinor` is a REQUIRED, signed input whose only admitted
value is `"0"` (`z.literal`), refused again by the payload builder
(`sale.tax_policy_absent`), again by `assertSalesTaxStructurallyZero`
(`accounting.sales_tax_unsupported`) and again by
`invoices_tax_policy_absent_ck CHECK (tax_minor = 0)`. It is a signed input
rather than a default so that the day an approved Country Pack enables non-zero
tax the fingerprint position already exists.

No rate, no exemption, no threshold, no registration number, no
inclusive/exclusive rule and no jurisdiction's law appears anywhere in this
slice. This document settles nothing about OD-03.

### A-08 The COGS figure, and why the sale is a prediction compared under signature

COGS truth is `journal_lines` on `5000` bound to the `sale` source, and its
input is `stock_movements.value_delta_base_minor` (P4-AL-25). `sales` carries
no `cogs_*` column and `sale_items` carries no `cogs_minor`: the lock's §4
matrix names that column the forbidden second truth, and the extended G-3
pattern refuses one by name.

The tension: the seam requires its accounting assertions BEFORE the transaction
opens, but an outbound movement's value is computed INSIDE it, by the stock
writer, under the stock key's `FOR UPDATE`.

Resolution (C's, adopted): the COGS figure the assertion is signed over is a
PREDICTION, read from `stock_levels` before the lock
(`readSaleStockLevels`) and computed by the stock writer's OWN rule
(`predictMovements`), including the exact-emptying rule — a movement taking the
LAST unit of a key carries exactly `-valuation_base_minor`, never
`-HALF_EVEN(qty x average)`, because an average unit cost is a derived rounded
quotient and re-multiplying it leaves a residue the stored valuation does not
have (`[[daftar-a-rounded-quotient-is-never-an-input]]`). That is exactly the
drift `R-INV-03` exists to catch.

A concurrent movement on the same key makes the prediction stale. FOUR
mechanisms make the disagreement loud rather than silent, in this order:

1. `SaleCommitService.execute` compares the routine's own returned sum against
   the signed figure and refuses `sale.state_changed` before any posting is
   attempted — a named refusal the till can act on;
2. `accounting_post_entry` recomputes `acctfp/1` from the lines it actually
   received and refuses a mismatch before any write;
3. the deferred `accounting_sale_entry_complete` trigger re-derives the
   expected COGS line from the PERSISTED `stock_movements` and fails the COMMIT
   on any difference;
4. the sale's own deferred binding obligation (C-07) fails the COMMIT if the
   entry never happened at all.

A stale prediction therefore costs a REFUSED sale the till retries — there is
no server retry, `[[daftar-lock-order-not-retry]]` — and can never cost a
misstated cost.

**Open gap, reported not hidden.** `deriveSaleCogsEntryLines` refuses a
zero-total COGS entry, correctly, because `journal_lines` refuses a zero amount
and "an entry asserting that goods worth nothing left the shelf is not a fact".
But a sale of zero-average-cost stock is legitimate and posts only the REVENUE
entry — one of two assertions — which `AccountingAssertionSequence.assertComplete()`
refuses (`presented 1 < 2`). So such a sale is currently UNCOMMITTABLE. It is
refused with the stable code `sale.zero_cost_stock` (422) rather than posted
wrongly. Closing it needs a `cogs: null` arm in
`packages/accounting/src/sale-posting.ts` (the accounting owner's file) and a
one-assertion sale, and it is an accounting-integrity gap, so it is not
Technical Debt.

### A-09 The seam, and the declared accounting authority

Atomicity is STRUCTURAL, not procedural. `withBusinessInventoryAccountingTransaction`
refuses to open inside another transaction and nothing opens inside it
(`database.ts:150-161`), so there is no second connection to commit
independently.

`AccountingAssertionSequence.assertComplete()` is
`if (presented > 0 && presented < length) throw`, so it catches only the
PARTIAL-posting case: presenting NONE is deliberately allowed. The
all-or-nothing guarantee is therefore NOT the assertion seam. It is the source
rows' own DEFERRED binding FKs: `invoices_binding_fk` (`0075:318`, already
shipped) with its status-conditional `invoices_binding_owed_ck`, and the
`sales` twin `0077` adds (C-01, C-07).

This slice adds `SeamAccountingAuthority` to `apps/api/src/infra/database.ts`:

```ts
type SeamAccountingAuthority =
  | { kind: 'postings'; assertions: AccountingAssertions }
  | { kind: 'no_posting' };
```

`AccountingAssertions` is a non-empty type and `plan` refuses an empty list
(`seam.accounting_assertion_missing`), so a command that needs the seam's
ATOMICITY but posts NOTHING had only two ways out: mint a signed assertion it
never presents, or split its commit. The first is a fake authority nothing
declares; the second is what the atomic sale law forbids. A draft sale and a
draft invoice are exactly this case — `invoices_binding_owed_ck` (`0075:301`)
makes a draft owe no binding. Under `no_posting` the GUC starts and stays
empty and presenting ANY posting is refused
(`seam.accounting_assertion_not_authorized`), so "posts nothing" is enforced
rather than described. The change is additive: a bare string and a tuple remain
exactly today's seam, and no existing caller changes.

**The permissive "presented none" branch is deliberately NOT tightened, and
that is a Tech Lead decision rather than this slice's.**
`tests/integration/purchase-s4-seam.test.ts:207` asserts it as a LAW —
"presenting none commits (the replay case, A-08)" — with two assertions minted
and none presented. A replay is discovered INSIDE the transaction, after the
seam was opened by a caller that could not know it would be one, so tightening
needs a way for the callback itself to declare the replay. That changes an
accepted P3 contract and an accepted P3 suite, both outside this slice.
Reported, not done, and not worked around with an undeclared fake assertion.

### A-10 Authority

`sale.commit` is registered in the closed `OPERATION_AUTHORITY` table
(`apps/api/src/modules/inventory/inventory-authorization.ts`) as
`{ permission: 'sales.create', scope: 'warehouses' }`. That file is outside
`modules/selling/**`; the edit was COMPELLED by the exhaustive
`Readonly<Record<InventoryOperationCode, …>>` type and is reported as such.

P4-AL-35's matrix, applied in full:

| what | keys |
| --- | --- |
| any sale | `sales.create` (ordinary — the cashier's own key) |
| a credit sale | + `receivables.view` |
| any non-zero line discount | + `sales.discount` (SENSITIVE) |

The last two are not route decorators, because both depend on the BODY and a
decorator cannot see it. They are checked in `plan`, after the idempotency
proof and before any state read, and again at the mint by
`SalePostingService.authorizeSaleCommit` — which is the authorizing act,
because `EXECUTE` on `accounting_post_entry` is reachability and not authority
(`[[daftar-execute-is-reachability-not-authority]]`).

**A discount asked without `sales.discount` is REFUSED
(`sale.discount_not_permitted`, 403), never silently zeroed**, because a
silently-zeroed discount charges the customer more than the cashier told them.

The branch is never a request field: the server resolves it from the
warehouse's immutable home branch, and a member without scope over it is
stopped by the RLS policy rather than by a predicate the controller writes
(P4-AL-40).

### A-11 What the commit answers, and what it refuses to answer

`SaleDto` carries the sale, its lines, a reference to the invoice, the posted
COGS and `replayed`. Two figures are DERIVED at read time rather than stored,
each because storing it would create a second truth:

- the COGS is the sum of the debits on the `cogs` system account of the entry
  bound to this sale, read back from the ledger (P4-AL-25) — not a number the
  service remembered;
- nothing about settlement. No paid total, no outstanding total and no
  settlement state (P4-AL-06, P4-AL-26): the invoice surface derives those
  through `invoice_outstanding(...)` and `invoice_settlement_state(...)`, and a
  freshly committed invoice's settlement is a question for that surface rather
  than an answer this read caches.

No response carries a journal entry id, an account code, a journal line, a
routine name, a GUC, a constraint name or the database's text after the colon
(P4-AL-54).

`HttpCode(200)` and not 201: a replay returns the SAME body, and answering 201
to a call that created nothing would tell the client it had just made a second
sale.

### A-12 Refusal vocabulary

`apps/api/src/modules/selling/selling-errors.ts` classifies every `sale.*` code
by an explicit table, never by the shape of a name. Three absences are
deliberate:

- there is no `sale.partially_committed`, no `sale.stock_pending` and no
  `sale.posting_deferred`: a code for a state the atomic law forbids is a hint
  that the state exists;
- there is no `sale.oversell_*` and no `sale.stock_override_*` (OD-P4-05, NO
  OVERSELL). The no-oversell refusal ALREADY exists as
  `inventory.insufficient_stock`, raised by the ONE stock writer under the
  level row's own `FOR UPDATE`, and the sale forwards it rather than inventing
  a second code for the same fact;
- the tax vocabulary is `sale.tax_policy_absent` and nothing else: no rate, no
  exemption and no registration refusal, because none of those concepts exists
  while sales tax is structurally zero.

Every code needs `error.<code>` in `apps/web/src/messages/{ar,en,tr}.json`
before a merchant screen renders it; those catalogues belong to the
localization owner of this slice.

---

## B. THE BRIDGE-TENANCY RULING

### B-01 `stock_source_bridge_sale` MUST carry `tenant_id`

The conflict the lock left open: `P4-AL-08` requires every Phase 4 relation to
carry `tenant_id` and `business_id` as real columns; the accepted precedent
`stock_source_bridge_purchase` (`0063:398-425`) carries **no** `tenant_id` and
no `(tenant_id, business_id)` FK, which is why its `tenant_membership` policy
uses the correlated `businesses` subselect (`0063:555-557`); and
`inventory_stock_source_guard_gaps()` pins the bridge primary key "exactly".

**Verdict: `P4-AL-08` wins.** `stock_source_bridge_sale` carries
`tenant_id UUID NOT NULL` with
`CONSTRAINT stock_source_bridge_sale_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)`,
and `tenant_id` is **absent from the primary key** (exactly
`(business_id, source_id, source_line_id, movement_kind)`) and **absent from
the line FK** (exactly `(business_id, source_id, source_line_id)`).

Consequence: the `tenant_membership` policy takes the DIRECT
`tenant_id = nullif(app_tenant(), '')::uuid` form of `0052`/`0075`, not
`0063`'s correlated subselect — which existed only because the column did not.

Four independent lines of evidence.

**(a) Measured, not reasoned.** `tests/integration/sale-s2-bridge-tenancy.test.ts`
(8 tests, green) builds a `probe` bridge apparatus FOUR ways in one
`BEGIN … ROLLBACK` transaction and asks the LIVE
`inventory_stock_source_guard_gaps()`:

| shape | bridge gaps |
| --- | --- |
| no `tenant_id` (the `0063` shape) | `[]` |
| `tenant_id` + composite FK, PK unchanged | `[]` |
| `tenant_id` inside the PK | `['bridge_pk']` |
| `tenant_id` inside the line FK | `['bridge_line_fk']` |

The whole gap sets of the first two are identical. The probe committed
nothing, and the live guard is clean on the sealed head.

**(b) What the guard actually pins.** The live body is `0067:1438`
(`TL-P4-S2-K3`; `P4-AL-29b`'s citation of `0061:307-481` points at the first of
five versions, a body the database no longer holds). It pins the PK's column
LIST (`bridge_pk`, 1529) and the two FK column lists (`bridge_binding_fk` 1547,
`bridge_line_fk` 1564) for EVERY source type; only the line FK's TARGET
(`confrelid`/`confkey`) is relaxed for a type outside S3/S4/S5. It says nothing
whatever about the relation's column SET.

**(c) The rest of the stock estate already carries it.** `stock_movements`,
`stock_levels` and — decisively — `stock_source_bindings`, the relation the
bridge's own FK points at AND at the same grain, all carry
`tenant_id UUID NOT NULL` with the composite FK (`0059:99-114` and siblings).
The bridges are the only stock relations that do not, so the omission is an
omission and not a decision. The bridge writer can copy the tenant from the
binding it bridges at NO extra read: `purchase_bridge_receipt` (`0064:317`)
already selects from `stock_source_bindings`.

**(d) What the migration owner's preliminary answer did not check.** Agent A's
`scripts/guards/phase4-rls-force.ts`, merged at `9579a84` and now part of
`gate:phase4:s2`, partitions Phase 4 relations structurally (`:325`, `:329`):
both dimensions ⇒ ENABLE+FORCE owed; **exactly one ⇒ reported as a `P4-AL-08`
violation**; neither ⇒ red until the lock records a decision. Discovery is
name-independent (the migration tree ∪ live `pg_class`, minus applier
relations). A sale bridge built to the `0063` shape would therefore be **RED in
this slice's own gate**. The question is not "may it carry `tenant_id`" but
"it must".

---

## C. THE EXACT DDL THE MIGRATION OWNER MUST WRITE

This is a SPECIFICATION, not a file. `0077` is the single migration owner's.

### C-01 `sales`

Columns: `tenant_id UUID NOT NULL`, `business_id UUID NOT NULL`,
`id UUID NOT NULL`, `branch_id UUID NOT NULL`, `warehouse_id UUID NOT NULL`,
`customer_id UUID NULL`, `settlement_mode TEXT NOT NULL CHECK (settlement_mode IN ('credit','cash'))`,
`status TEXT NOT NULL CHECK (status IN ('draft','confirmed','void','returned_partial','returned_full'))`,
`document_date DATE NOT NULL` (NO `DEFAULT`), `currency_code TEXT NOT NULL`,
`subtotal_txn_minor BIGINT NOT NULL`, `discount_txn_minor BIGINT NOT NULL`,
`tax_minor BIGINT NOT NULL`, `total_txn_minor BIGINT NOT NULL`,
`total_base_minor BIGINT NOT NULL`, `fx_rate_id UUID NULL`,
`source_to_base_rate NUMERIC(20,10) NOT NULL`,
`rate_source TEXT NOT NULL CHECK (rate_source IN ('base','manual','provider'))`,
`rate_timestamp TIMESTAMPTZ NOT NULL`,
`customer_name_snapshot TEXT NULL`, `notes TEXT NULL`,
`commit_intent_sha256 CHAR(64) NOT NULL CHECK (commit_intent_sha256 ~ '^[0-9a-f]{64}$')`,
`accounting_source_type TEXT NOT NULL GENERATED ALWAYS AS ('sale') STORED`,
`binding_source_id UUID NULL`, `created_by UUID NOT NULL`,
`created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.

**No `cogs_minor`, no `cogs_base_minor`, no `paid_minor`, no
`outstanding_minor`, no `available_stock` and no `idempotency_key`** — each is
a forbidden second truth or a key that is not a proof.

`PRIMARY KEY (business_id, id)`.
`CONSTRAINT sales_tenant_fk FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)`,
plus composite FKs to `branches`, `warehouses`, `customers`, `currencies`,
`accounting_fx_rates`.
`CONSTRAINT sales_total_ck CHECK (total_txn_minor = subtotal_txn_minor - discount_txn_minor + tax_minor)`,
`sales_discount_ck CHECK (discount_txn_minor BETWEEN 0 AND subtotal_txn_minor)`,
`sales_total_range_ck CHECK (total_txn_minor BETWEEN 1 AND 1000000000000000000)`,
`sales_tax_policy_absent_ck CHECK (tax_minor = 0)` (P4-AL-44),
`sales_credit_customer_ck CHECK (settlement_mode = 'cash' OR customer_id IS NOT NULL)`,
`sales_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id)`,
`sales_binding_owed_ck CHECK ((status <> 'draft') = (binding_source_id IS NOT NULL))`
— the `purchases_binding_owed_ck` shape (`0063:255,258`), nullable plus
status-conditional, NOT the `NOT NULL` shape, because a draft sale owes no
binding.
`CONSTRAINT sales_binding_fk FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
REFERENCES accounting_source_bindings (business_id, source_type, source_id)
DEFERRABLE INITIALLY DEFERRED` — the `0067:388-391` shape. **This deferred FK
is the atomic sale law's mechanism**, not a check any service performs.

RLS: `ENABLE` **and** `FORCE`, with the SEVEN policies of a `0075`
accounting-source relation: `tenant_membership` in the DIRECT form
`USING (app_bypass() OR tenant_id = nullif(app_tenant(), '')::uuid)`, four
RESTRICTIVE `business_isolation_{read,insert,update,delete}`,
`inventory_internal_read`, and `accounting_validator`.

Immutability: a `BEFORE UPDATE` guard refusing every column but `status` and
`binding_source_id`, and refusing a `status` transition outside
`SALE_TRANSITIONS` (`packages/domain-core/src/sale.ts`). P4-AL-46: a confirmed
sale is corrected by a new document, never edited. `0077` registers
`sale.commit` ALONE, so no routine in this slice performs any transition out of
`confirmed`.

### C-02 `sale_items`

`tenant_id`, `business_id`, `sale_id`, `id` (the CLIENT's line id),
`line_no INTEGER NOT NULL CHECK (line_no > 0)`, `product_id UUID NOT NULL`,
`variant_id UUID NULL` (the MERCHANT variant; null for a simple product, the
`invoice_items` convention at `0075:342-343`),
`stock_variant_id UUID NOT NULL` (the resolved stock key),
`name_snapshot TEXT NOT NULL CHECK (char_length(name_snapshot) BETWEEN 1 AND 200)`,
`quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0)`,
`unit_price_txn_minor BIGINT NOT NULL`, `gross_txn_minor BIGINT NOT NULL`,
`discount_txn_minor BIGINT NOT NULL`, `net_txn_minor BIGINT NOT NULL`,
`tax_minor BIGINT NOT NULL CHECK (tax_minor = 0)`,
`base_share_minor BIGINT NOT NULL`.

**No `cogs_minor` and no `unit_cost_minor`**: the lock's §4 matrix names
`sale_items.cogs_minor` the forbidden second truth for COGS.

`PRIMARY KEY (business_id, id)` plus
`CONSTRAINT sale_items_sale_line_uq UNIQUE (business_id, sale_id, id)` — the
3-column target the bridge's line FK needs.
`sale_items_net_ck CHECK (net_txn_minor = gross_txn_minor - discount_txn_minor + tax_minor)`,
`sale_items_discount_ck CHECK (discount_txn_minor BETWEEN 0 AND gross_txn_minor)`,
`UNIQUE (business_id, sale_id, line_no)`,
`UNIQUE (business_id, sale_id, stock_variant_id)` (the five-part movement
identity at `0059:147` refuses a second movement on one source line, so a
duplicated variant inside one sale could only roll back).
Composite FKs to `sales`, `products`, `product_variants`, plus
`sales_tenant_fk`'s twin. RLS ENABLE + FORCE, the SIX ordinary policies
(`tenant_membership` direct form + four RESTRICTIVE + `inventory_internal_read`).

### C-03 The movement kind

`INSERT INTO stock_movement_kinds (kind, qty_sign, …) VALUES ('sale', 'negative', …)`.
`0059` seeds ten kinds and **none of them is `sale`**. `qty_sign = 'negative'`:
a sale takes stock OUT, and the client never states the sign — a client that
could state it could state an inbound movement under a sale's authority.

### C-04 The operation kind

One row in `inventory_operation_kinds` for `sale.commit`, with the payload
field types and order of A-05 exactly, so
`inventory_payload_digest(...)` and `packages/inventory`'s builder agree
byte-for-byte. `sale.commit` and **nothing else** (`TL-P4-S2-K1`): a registered
kind is a registration of authority.

### C-05 `stock_source_bridge_sale`

```
tenant_id      UUID NOT NULL
business_id    UUID NOT NULL
source_id      UUID NOT NULL
source_line_id UUID NOT NULL
movement_kind  TEXT NOT NULL
source_type    TEXT NOT NULL GENERATED ALWAYS AS ('sale') STORED
PRIMARY KEY (business_id, source_id, source_line_id, movement_kind)   -- exactly, see B-01
CONSTRAINT stock_source_bridge_sale_tenant_fk
  FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)
CONSTRAINT stock_source_bridge_sale_line_fk
  FOREIGN KEY (business_id, source_id, source_line_id)
  REFERENCES sale_items (business_id, sale_id, id) ON DELETE RESTRICT
CONSTRAINT stock_source_bridge_sale_binding_fk
  FOREIGN KEY (business_id, source_type, source_id, source_line_id, movement_kind)
  REFERENCES stock_source_bindings (business_id, source_type, source_id, source_line_id, movement_kind)
  ON DELETE RESTRICT
```

Plus the immutability trigger (`bridge_immutable`) the guard requires, RLS
ENABLE + FORCE and **SIX** policies, not five (`TL-P4-S2-K2`; measured from
`pg_policy` on the accepted purchase bridge, `0063:555-568`):
`business_isolation_{delete,insert,read,update}`, `inventory_internal_read`,
`tenant_membership` — in the DIRECT `tenant_id` form, per B-01.

`inventory_stock_source_guard_gaps()` must be replaced by `CREATE OR REPLACE`
with a `sale` arm (`TL-P4-S2-K3`), because in the live body a source type
outside S3/S4/S5 has its line FK target UNPINNED and is required to carry NONE
of the four protections.

### C-06 The two accounting source types

`accounting_source_types.sort_order` is UNIQUE and 1–12 are taken
(`opening_balance` 1 … `purchase_residue_write_off` 12), so `sale` = 13 and
`invoice` = 14. The `invoice` registration and its deferred completeness
validator moved here from P4-S1 by `TL-P4-S1-R1`.

`accounting_reversals_20_domain_source_guard` (`0067:2243-2272`) is a closed
literal `IN` list plus the `purchase` pairing carve-out; it must gain `sale`
and `invoice` by `CREATE OR REPLACE` in the SAME migration that registers them,
or a registered source type is a source type no reversal can name.

Two deferred completeness validators, in the accepted
`accounting_supplier_payment_entry_complete` form (`0067:1959-2035`): read the
stored source row, build `v_expected` as a `concat_ws('|', …)` text array,
build `v_actual` the same way from `journal_lines` + `accounts`, sort both,
compare as a multiset; attach as
`CREATE CONSTRAINT TRIGGER journal_entries_<type>_complete AFTER INSERT ON journal_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.source_type = '<type>')`.

- `accounting_sale_entry_complete`: exactly `Dr cogs(5000)` / `Cr inventory(1200)`,
  both at the sale's branch AND warehouse, both in base currency at rate 1,
  for the amount `-Σ stock_movements.value_delta_base_minor` of the movements
  bound to this sale — re-derived from the PERSISTED movements, which is
  mechanism 3 of A-08;
- `accounting_invoice_entry_complete`: exactly two lines,
  `Cr sales_revenue(4000)` against `Dr accounts_receivable(1100)` for a credit
  sale or `Dr cash(1000)` for a cash sale, both carrying the invoice's own
  `total_txn_minor` / `total_base_minor` at the invoice's own FX snapshot, at
  the invoice's branch and with NO warehouse. **4000, not 4100** — `4100` is
  `sales_returns` and belongs to P4-S5. No tax line (the tax is zero and
  `journal_lines` refuses a zero amount) and no discount line (the discount is
  already inside `total_txn_minor` through `invoices_total_ck`, and a separate
  gross-revenue line would post revenue this invoice never earned).

`DOMAIN_SOURCE_TYPES` (`packages/accounting/src/post.ts:208`) must gain
`'sale'` and `'invoice'` — the accounting owner's file, not this slice's.

### C-07 `sales_cogs_owed`: why the COGS obligation is a trigger and not a CHECK

A sale's COGS obligation is conditional on a value NO row holds: `sales` may
carry no `cogs_*` column (A-08), but a sale of zero-average-cost stock posts no
COGS entry, because a journal amount must be positive. So
`binding_source_id IS NOT NULL` cannot express "owes a COGS entry".

The obligation is carried by a DEFERRED constraint trigger
`sales_cogs_owed`, in the accepted `inventory_source_value_complete()` form:
at COMMIT, re-derive `Σ stock_movements.value_delta_base_minor` for the
movements bound to this sale and require a `sale`-sourced entry to exist iff
that sum is non-zero. It is a trigger rather than a row `CHECK` because a
`CHECK` cannot read another table, and storing the sum on `sales` to make it
checkable is precisely the forbidden second truth.

### C-08 `invoices_sale_fk` — an unclosed hole in the sealed `0075`

**`invoices.sale_id` carries NO foreign key.** Verified against live
`pg_constraint`: `invoices` holds `invoices_binding_fk`, `invoices_branch_fk`,
`invoices_created_by_fkey`, `invoices_currency_fk`, `invoices_customer_fk`,
`invoices_fx_rate_fk`, `invoices_tenant_fk`, `invoices_voided_by_fkey` — and no
sale FK, although `sale_id UUID NOT NULL` has existed since `0075`. That is an
unclosed `P4-AL-09` hole: an invoice can name a sale that does not exist.

`0077` must add
`CONSTRAINT invoices_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id)`.

`invoices_sale_uq UNIQUE (business_id, sale_id, document_kind)` already exists,
so one sale has at most one invoice of each kind.

### C-09 `sale_commit` — the trusted command's signature

```
sale_commit(
  p_sale_id UUID, p_invoice_id UUID, p_settlement_mode TEXT,
  p_customer_id UUID, p_warehouse_id UUID, p_branch_id UUID,
  p_document_date DATE, p_due_date DATE, p_currency CHAR(3),
  p_rate_id UUID, p_rate NUMERIC, p_rate_source TEXT, p_rate_at TIMESTAMPTZ,
  p_subtotal_txn_minor BIGINT, p_discount_txn_minor BIGINT,
  p_total_txn_minor BIGINT, p_total_base_minor BIGINT, p_notes TEXT,
  p_line_ids UUID[], p_product_ids UUID[], p_merchant_variant_ids UUID[],
  p_stock_variant_ids UUID[], p_name_snapshots TEXT[], p_quantities NUMERIC[],
  p_unit_prices BIGINT[], p_gross BIGINT[], p_discounts BIGINT[],
  p_nets BIGINT[], p_base_shares BIGINT[]
) RETURNS TABLE (replayed BOOLEAN, cogs_base_minor BIGINT)
```

29 positional arguments — 18 scalars then 11 parallel arrays — exactly as the
service sends them (`SALE_COMMIT_SQL` in `sale-commit.service.ts`).

**There is deliberately no `p_tax_minor`.** The routine writes `tax_minor = 0`
on the header and on every item itself. An argument for a value whose only
admissible value is zero is an argument someone can pass non-zero, and the day
an approved Country Pack enables tax the argument is added together with the
rule that validates it — not left waiting with a `CHECK` behind it.

**Two things it must NOT have**: a `DEFAULT` on any argument, and any
`coalesce(p_*, current_date)` or other clock read. A financial command whose
fingerprint covers a server-resolved date is not idempotent, in the DTO, the
schema, the service, the engine OR the trusted database command.

Its order of operations:

1. re-verify `invctl/1` for `sale.commit` through
   `inventory_assertion_current`, reading its allowed op list from the registry
   table (the `0060:186` mechanism);
2. `pg_advisory_xact_lock(hashtext('daftar.sale_id'), hashtext(p_sale_id::text))`
   — the per-document lock, FIRST;
3. re-derive the intent digest with
   `inventory_payload_digest('sale.commit', …)` over the INTENT subset and
   compare it with the stored `sales.commit_intent_sha256`. Same ⇒
   `RETURN (true, <the stored sale's COGS>)`, having written nothing.
   Different ⇒ `RAISE 'sale.idempotency_conflict'`. **This read comes before
   any other** (`[[daftar-registry-before-state]]`);
4. re-verify the payload digest against the assertion, so the figures the
   routine stores are the figures the authority was minted over;
5. take the domain locks in `SALE_COMMIT_LOCK_ORDER`
   (`businesses`, `customers`, `stock_levels`, `invoice_sequences`) — ONE
   order, never a retry (`[[daftar-lock-order-not-retry]]`);
6. re-compute every amount from the catalogue and refuse `sale.state_changed`
   on any disagreement with its arguments. **Client totals are never
   authoritative and neither are the service's**: the routine is the last
   recompute;
7. INSERT `sales` as `confirmed` with `binding_source_id = id`, then
   `sale_items`;
8. call `inventory_apply_stock_movements` with one
   `inventory_movement_request` per line, `movement_kind = 'sale'`,
   `qty_delta = -quantity`, `source_type = 'sale'`,
   `unit_cost_base_minor = NULL` and `value_delta_base_minor = NULL` — the
   writer computes the value under the stock key's own `FOR UPDATE`, and that
   is also where `inventory.insufficient_stock` is raised. **The writer is NOT
   changed** (OD-P4-05);
9. INSERT the `stock_source_bridge_sale` rows, copying `tenant_id` from the
   `stock_source_bindings` rows it bridges (no extra read — the
   `purchase_bridge_receipt` pattern at `0064:317`);
10. allocate the invoice number as `max + 1` while holding the sequence row —
    LAST of the domain locks (P4-AL-32) — and INSERT `invoices` directly as
    `'open'` (`invoices_lifecycle_guard` is BEFORE UPDATE only, so an INSERT as
    `open` is permitted) with `binding_source_id = id`, then `invoice_items`;
11. `RETURN (false, Σ value_delta_base_minor)` from the movements it just
    wrote — the figure A-08's mechanism 1 compares.

SECURITY DEFINER, owned by the inventory internal role, with a pinned
`search_path` and `EXECUTE` to `daftar_app` only. It writes NO journal line
itself: `accounting_post_entry` remains the ONE ledger writer.

---

## D. THE SETTLEMENT MODE

### D-01 A cash sale, with no payment document (RECOMMENDED-PENDING)

`payments` and `payment_allocations` are P4-S4's relations and `P4-AL-86`
forbids creating a later slice's relation here, so a cash sale cannot write a
payment document in this slice. The design, marked RECOMMENDED-PENDING the Tech
Lead's word and implemented as such in the code:

- `settlement_mode` is a stored **INPUT** on the sale header — a fact the
  merchant states, not a derived truth — and it is part of the signed intent,
  because the cashier knows which one happened;
- a `credit` sale balances its revenue against `accounts_receivable (1100)`;
- a `cash` sale balances it with a direct debit on the `cash` system account
  (1000) and writes **no payment document**;
- it is NOT a settlement STATE. `invoices.status` stays lifecycle-only
  (P4-AL-24) and whether an invoice is paid is derived through
  `invoice_settlement_state(...)`, never read from this field.

The cash shape is forced rather than chosen: `invoices_walkin_no_ar`
(`0075:660-696`) is a DEFERRABLE INITIALLY DEFERRED constraint trigger that
reads the posted entry's lines and refuses an AR line behind a null
`customer_id`, so `Dr AR` plus a separate settlement entry is UNPOSTABLE for a
walk-in. A walk-in (`customer_id IS NULL`) is therefore admissible only for a
`cash` sale, and a due date requires a `credit` sale with a named customer —
the `invoices_walkin_terms_ck` mirror (`0075:316`), refused in the schema, the
payload builder and the row CHECK.

---

## E. FAILURE INJECTION, THE `R-INV-*` ANSWER, AND THE CONFLICTS

### E-01 The failure-injection plan

The house pattern is `tests/integration/inventory-s3-atomicity.test.ts`:
`expectNothingSurvives(inject, call, what)` asserts `delta(before, after)`
equals `{}` AND `consumedSince(uses, after) === 0`, and `expectAllTogether`
asserts every artifact plus the "same xact" join proving ONE commit.

The seven states P4-AL-16 forbids, and the injection point that proves each one
cannot survive:

| forbidden state | injection |
| --- | --- |
| a sale with no stock movement | fail `inventory_apply_stock_movements` inside the routine (a level row locked by a concurrent session, or a variant whose stock key does not exist) |
| a stock movement with no invoice | fail the invoice number allocation: hold the `invoice_sequences` row in another session |
| an invoice with no accounting binding | fail the FIRST `postEntryInTransaction` — `failPosting()`'s `vi.spyOn(posting, 'postEntryInTransaction').mockRejectedValueOnce(...)` |
| a COGS entry with no commercial source | present the COGS assertion and then throw before the revenue posting — the partial-posting case `assertComplete()` catches (`seam.accounting_assertion_unused`) |
| a revenue entry with no invoice | post the revenue entry against an invoice id the routine never wrote: refused by `invoices_binding_fk` at COMMIT |
| an inventory decrement with no COGS | post ONLY the revenue entry: refused by `sales_cogs_owed` (C-07) at COMMIT, and by `assertComplete()` before it |
| a partial sale after a failure | `failBeforeCommit()` — wrap `db.withBusinessInventoryAccountingTransaction` so the callback throws AFTER `fn(tx)` returned |

Four more this slice owes:

- **the stale COGS prediction** (A-08): move the stock key's valuation between
  `readSaleStockLevels` and the routine; the sale must be REFUSED
  `sale.state_changed` with nothing surviving — never committed with the
  signed figure;
- **the replay** (A-03): the same request twice must leave exactly one sale,
  one invoice, two entries and one `inventory_assertion_uses` row, and the
  second call must consume no authority;
- **the stale replay** (A-03): the same `saleId` with a different intent must
  be refused `sale.idempotency_conflict` BEFORE the customer, the catalogue,
  the rate or any stock level is read — asserted by spying on the reads, not
  by trusting the comment;
- **the last item** (OD-P4-05): two concurrent commits of the final unit —
  exactly one commits, the loser is refused `inventory.insufficient_stock`
  under the level row's `FOR UPDATE`, and no retry happens anywhere.

Every one of these is a REFUSAL test. None of them may be answered by a retry,
a relaxed threshold, a `.skip`, a `.todo` or a `.only`.

### E-02 R-P4-09: the `R-INV-*` reconciliation checks need no change

Verified by reading every `R-INV` check, every reader SQL, every helper and
every gate script: **none of them filters by, or assumes, a movement source
type.** Registering a `sale` movement kind therefore breaks no `R-INV` check by
construction. The only couplings are arithmetic:

- `R-INV-01` (`GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`)
  needs the COGS entry's Inventory line to equal the EXACT sum of this sale's
  stored `value_delta_base_minor` integers — which is P4-AL-25, and which A-08's
  four mechanisms enforce;
- `R-INV-03` (an emptied key carries zero valuation) needs the exact-emptying
  rule, which the writer already has
  (`IF abs(v_qty) = v_level_qty THEN v_value := -v_level_value`) and which
  `predictMovements` mirrors rather than re-deriving;
- `R-INV-04` needs NO `6100` rounding line in either entry (P4-AL-19) — and
  there is none, because both lines of each entry carry the same transaction
  amount at the same rate, so the entry balances with no residue and
  `classifyRoundingResidual` stays unreachable.

### E-03 OD-P4-05: NO OVERSELL needs no change to the stock writer

`inventory_apply_stock_movements` ALREADY contains, in the outbound branch and
under the stock key's `FOR UPDATE`:

```sql
IF abs(v_qty) > v_level_qty THEN
  RAISE EXCEPTION 'inventory.insufficient_stock: the warehouse does not hold enough of this variant'
    USING ERRCODE = 'P0001';
END IF;
```

So the no-oversell law is already physical, and the same lock is the last-item
race mechanism. **The writer is expected to remain unchanged and this slice
does not change it.** No business flag is added, no `sale.oversell_*` code
exists, and a non-stock-tracked product never decrements a level and is simply
sellable — the `(c)` clarification of the ruling, not an option.

### E-04 Where the lock and the code disagree — the code wins

1. **`P4-AL-43` scenario 1 cites "the physical non-negative constraint". There
   is none.** No `on_hand >= 0` CHECK exists anywhere in `0000`–`0076`. The
   real mechanism is the routine's `inventory.insufficient_stock` under the key
   lock (E-03). Related: NOTHING anywhere ever inserts into
   `negative_inventory_deficits`, so that whole apparatus is unreachable on
   this tree.
2. **`P4-AL-29b` cites `0061:307-481` for `inventory_stock_source_guard_gaps()`.**
   The live body is `0067:1438`, the fifth version; the cited body is the first
   and the database no longer holds it (`TL-P4-S2-K3`).
3. **The execution plan's S2 row said "five policies" on the bridge.** The
   accepted purchase bridge has SIX, measured from `pg_policy` (`TL-P4-S2-K2`).
4. **`invoices.sale_id` carries no foreign key** in the sealed `0075` (C-08).
5. **The environment is PostgreSQL 18.4**, not 16 as the slice brief stated.
