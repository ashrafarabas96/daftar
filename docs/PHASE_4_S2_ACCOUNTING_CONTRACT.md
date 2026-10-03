# P4-S2 — The accounting contract of the sale commit primitive

**Owner:** Agent C (accounting). **Slice:** P4-S2. **Cut from:** sealed head `9b3e222`.
**Status:** specification. The DDL in §6 is written for the single migration owner (Agent E) to implement
as `0077`; nothing in this document edits a migration.

Every claim below was verified against the code in this checkout. Where a canonical document and the code
disagree, the code wins and the conflict is recorded in §10.

---

## 1. What this slice owes, and why the two source types are one slice's work

Tech Lead ruling `TL-P4-S1-R1` moved the `invoice` accounting source type, its operation kind, its two
bindings and its deferred completeness validator out of P4-S1 and into P4-S2, on the ground that **an
accounting source type must not exist as a dead registry concept**. The same reasoning binds the `sale`
type. So P4-S2 supplies, for each of the two types, all five of: the registry row, the real writer, the
binding apparatus, the exact expected journal shape, and the deferred completeness validator — plus the
red proof that each can be made to fail.

A confirmed sale posts **exactly two journal entries**:

| entry | accounting source type | source id | grain |
|---|---|---|---|
| the COGS entry | `sale` | `sales.id` | the sale |
| the revenue entry | `invoice` | `invoices.id` | the invoice |

**Two, not one, and the reason is physical.** `accounting_reversals.id = original_entry_id`
(`0046_accounting_sources.sql:182`) permits exactly one whole-entry reversal per entry, for ever
(`P4-AL-47`). A single entry carrying revenue, AR and COGS could only ever be reversed as a whole, so
"reverse the revenue and leave the inventory where it is" — which is what a price correction is — would be
unexpressible for the rest of the project's life. This is the same argument `P4-AL-17` makes for one entry
per allocation.

---

## 2. PREREQUISITE ANSWERED IN WRITING — risk `R-P4-09`: was any `R-INV-*` check written assuming purchase-only movement sources?

`docs/PHASE_4_EXECUTION_PLAN.md:144` and `R-P4-09` require this established **before P4-S2 writes a
movement**. The five checks are defined in `packages/accounting/src/reconciliation.ts:162-245` and
implemented in `apps/api/src/modules/accounting/accounting-reconciliation.reader.ts:500-640`.

**Answer: NO. None of `R-INV-01` … `R-INV-05` is purchase-shaped, and none of the five needs
re-expression for P4-S2.** The evidence, check by check:

| check | definition | implementation | verdict |
|---|---|---|---|
| `R-INV-01` | `reconciliation.ts:164-181` | `reader.ts:509-523` | **Safe.** `Σ stock_movements.value_delta_base_minor` over the whole business against `Σ(debit − credit)` on the account whose `system_key = 'inventory'`. No `source_type` predicate on either side. A sale writes a negative `value_delta` and credits Inventory by the same magnitude, so both sides move together. |
| `R-INV-02` | `reconciliation.ts:182-204` | `reader.ts:535-569` | **Safe.** Cache against ledger per `(warehouse_id, variant_id)`, source-type agnostic. A sale's movements go through the one writer, which updates `stock_levels` in the same statement (`0060:487` comment). |
| `R-INV-03` | `reconciliation.ts:205-210` | `reader.ts:576-586` | **Safe, and load-bearing** — see below. |
| `R-INV-04` | `reconciliation.ts:211-222` | `reader.ts:594-604` | **Safe.** "No entry with an `inventory` line also has a `rounding` line." The COGS entry of §4 has exactly two lines, `cogs` and `inventory`. |
| `R-INV-05` | `reconciliation.ts:223-244` | `reader.ts:614-640` | **Safe as implemented, with one coverage gap that is NOT this check's** — see below. |

I searched the whole reader for a purchase predicate: `grep -n "purchase"` over
`accounting-reconciliation.reader.ts` returns exactly one hit, `:424`, inside a comment. The only
`source_type` predicates in the file are `:472` (`R-ACC-08`, a self-join) and `:622`/`:632` (`R-INV-05`'s
two anti-joins, which compare a movement's own `source_type` to its binding's and name no literal). There
is no purchase-shaped `R-INV-*` check in the tree.

### 2.1 `R-INV-03` is why the COGS amount may not be recomputed

`R-INV-03` refuses a stock level with `on_hand = 0` and `valuation_base_minor <> 0`. A sale is not the
first operation that can empty a stock key — `supplier_return`, `damage`, `transfer_out`, `adjustment` and
`stocktake` already can — so the mechanism already exists and already works: `0060:388-392` gives an
outbound movement that takes the last unit the branch `v_value := -v_level_value`, the key's **stored
valuation, exactly, with no rounding whatever**.

The consequence for this slice is the important part. If the COGS entry's amount were recomputed as
`quantity × average_cost`, it would in general **not** equal the stored valuation on the emptying
movement, because `average_cost` is a rounded derived quotient. The movement would still empty the
valuation (the stock writer is authoritative), but the GL would carry the recomputed figure, and
`R-INV-01` would go red by the difference. So `R-INV-03` and `R-INV-01` together are the reason the one
official formula is `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor` and
`quantity × average_cost` is never the reconciliation truth (`TL-P4-S0-01`, `P4-AL-25`).

### 2.2 One real coverage gap, and it belongs to `TL-P4-S2-K3` rather than to `R-INV-05`

`reader.ts:606-613` records in terms that `R-INV-05` deliberately does **not** re-derive the
source-line → movement half of PM-29: that half "is a catalogue discovery elsewhere
(`inventory_stock_source_guard_gaps()`)".

That discovery does not cover a `sale` source type today. In the **live** guard body — `0067:1438`, the
fifth version, which is the one the database holds — `v_s3`, `v_s4` and `v_s5` are **closed literal
lists** at `0067:1501-1503`:

```
v_s3 := v_type IN ('inventory_adjustment', 'inventory_opening', 'inventory_transfer', 'stocktake');
v_s4 := v_type IN ('negative_inventory_cost_adjustment', 'purchase');
v_s5 := v_type IN ('purchase_reversal', 'supplier_return');
```

For a type in none of them, `0067:1551-1564` leaves the line FK's **target table and target key
unpinned** (the `NOT (v_s3 OR v_s4 OR v_s5) OR …` disjuncts short-circuit), `0067:1574-1575` and
`0067:1593-1594` leave the `prosrc` digests unpinned, and the per-type apparatus — `source_complete`,
`source_freeze`, `header_immutable`, `value_complete` — is required **only** inside `IF v_s3 THEN`
(`:1601`), `IF v_s4 THEN` (`:1645`) and `IF v_s5 THEN` (`:1703`). A `sale` source type therefore satisfies
the accepted guard while carrying none of those four triggers.

**This confirms `TL-P4-S2-K3` against the code, and it is why `P4-AL-29b`'s citation of `0061:307-481`
must not be reasoned from: that body is superseded and the database does not hold it.** The protections
listed in §6.4 are therefore specified as requirements of the **replaced** guard, not as things the
accepted guard will catch. Agent E's `sale` arm must put `sale` on the pinned side of every one of those
disjuncts.

### 2.3 One `R-ACC-*` check this slice would have broken, now pre-empted

Not asked for, but found while reading and worth recording because the identical defect already happened
once. `R-ACC-06` (`reader.ts:426-435`) parameterises its allowed-source-type array with
`[...NATIVE_SOURCE_TYPES, ...DOMAIN_SOURCE_TYPES]` **read from `@daftar/accounting`**. The comment at
`:420-424` records the precedent: P3-S9 data-integrity review finding F-1 — "the domain types were never
added here, so every business with an inventory, purchase or supplier posting answered `discrepancy`".

Had P4-S2 registered `sale` and `invoice` in SQL only, every business with a sale would have answered
`discrepancy` on `R-ACC-06` in exactly the same way. The change in `packages/accounting/src/post.ts` (§5)
closes it before it can happen.

`R-ACC-07` (`reader.ts:514-528` of the same switch) requires a domestic line to carry `fx_rate = 1`,
`fx_rate_source = 'base'` and `txn_amount_minor = base_amount_minor`, and a foreign line to carry
`manual`/`provider` at a positive rate. Both shapes in §3 and §4 satisfy it; the COGS entry is base-to-base
at the `base` sentinel and the foreign invoice entry carries the invoice's own stored snapshot.

---

## 3. The revenue entry — source type `invoice`

Two lines, always. Both carry `txn_amount_minor = invoices.total_txn_minor` in `invoices.currency_code` at
the invoice's own stored FX snapshot, and `base_amount_minor = invoices.total_base_minor`.

That symmetry is not a convenience: `0043_accounting_invariants.sql:208-245` forces every line's
`base_amount_minor` to be the exact `HALF_EVEN` conversion of **that line's** transaction amount at **that
line's** rate. Two lines carrying one transaction amount at one rate therefore carry one base amount, the
entry balances in base with no residue, and `P4-AL-19`'s prohibition on a rounding line is satisfied
structurally rather than by inspection. `classifyRoundingResidual`
(`packages/accounting/src/rounding.ts:71`) stays unreachable from the sale path.

```
cash sale    Dr <settlement account>          Cr sales_revenue   (system key `sales_revenue`, code 4000)
credit sale  Dr accounts_receivable (1100)    Cr sales_revenue   (system key `sales_revenue`, code 4000)
```

**The revenue account is `4000`, not `4100`.** `0040_accounting_chart.sql:59-60` registers
`sales_revenue` at `4000` and `sales_returns` at `4100`. `4100` is the **return** account and is P4-S5's.
The engine names the `system_key` and the chart carries the code as a presentation default (`0040:39-40`),
so the code names the key and asserts the key.

**There is no tax line.** `invoices.tax_minor` and `invoice_items.tax_minor` each carry
`CHECK (tax_minor = 0)` in `0075:262` and `0075:352`, `journal_lines` refuses a zero amount, and `OD-03`
is OPEN. `§13`/`P4-AL-44`: sales tax is structurally zero and any non-zero tax is **REFUSED** under the
stable code `accounting.sales_tax_unsupported`. No jurisdiction's law is researched and `OD-03` is not
settled here.

**There is no discount line either.** The discount is already inside `total_txn_minor` through
`invoices_total_ck` (`0075:295`). A separate `4200` line would post a gross revenue the invoice never
earned.

**Neither line carries a warehouse, and neither carries a customer.** `TL-P4-S1-C16` settles the second
half: `purchase_ap_outstanding` is the precedent and it computes from the **document** tables and never
from the journal, which is why `invoices` needs no customer dimension on `journal_lines`.

### 3.1 Why a cash sale debits the settlement account directly

This is the shape the coordinator marks **recommended-pending the Tech Lead's word**, and it is also the
only shape `0075` permits for the POS case. `0075:660-696` creates `invoices_walkin_no_ar`, a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger owned by `daftar_accounting_internal`, which raises
`invoice.walkin_receivable_forbidden` when an invoice with `customer_id IS NULL` has **any** line on
`accounts_receivable` in the entry bound to its own source identity.

So `Dr AR / Cr revenue` followed by a settlement entry `Dr cash / Cr AR` is **not available** for a
walk-in: the AR line would sit on the invoice entry itself and the COMMIT would fail. A walk-in cash sale
is the POS case, and `P4-C` budgets "a 10-line **cash sale**, invoice + lines + 10 movements + the
journal" inside P4-S2. The invoice entry therefore debits the settlement account directly, for every cash
sale, walk-in or named, so there is one shape and not two.

`sales.settlement_kind` is a stored **input** on the sale header — what the merchant did at the till — and
not a derived truth. It is not a settlement *state*: `invoices.status` stays lifecycle-only (`P4-AL-24`)
and `invoice_settlement_state()` remains the derived reader.

The settlement account is restricted to **exactly five SYSTEM keys** — `cash`, `bank`, `card_clearing`,
`wallet_clearing`, `cheque_clearing`, the ones `accounting_settlement_account_eligibility`
(`0067:1918-1945`) admits for a payment method's posting account. An account named by **CODE is refused
outright**, and the reason is worth recording because the first version of this section got it wrong.

It said a code-named account was also admitted "which the database checks". **It does not.**
`accounting_settlement_account_eligibility` is invoked from exactly four places — the payment-method
guards at `0067:827` and `0067:845`, `supplier_payment_guard` at `0067:924`, `supplier_refund_guard` at
`0067:1160` — and from **nothing on the invoice posting path**; and at `0067:1940-1943` it returns
`eligible` for any active asset account whose `system_key` is NULL, so it would not discriminate a code
even if it ran. What the code arm actually admitted was an own-goal needing no attacker:
`{ kind: 'code', code: '4000' }` derived `Dr code:4000 / Cr sales_revenue`, and `0040:59` seeds
`sales_revenue`'s `default_code` as exactly `4000`, so on a business keeping the default chart that is the
**same account on both sides** — revenue posted as its own settlement, balanced and reconciling. `'5000'`
(`cogs`, `0040:67`) does the same.

Refusing the arm is the safer fix: mapping a code back to a system key would mean resolving the business's
chart inside a pure derivation, and nothing is lost, because a till settles into one of five system
identities. `sales.payment_method_id` / `posting_account_id` still carry the method, with the
`(business_id, payment_method_id, posting_account_id)` three-column FK `supplier_payments` uses at
`0067:352-354`; `payment_methods` already exists (`0067:284`) and is reused, never created. The
**database-side** check that the method's posting account is the one the entry debited stays where §6.3
puts it: the invoice validator compares the line to `sales.posting_account_id` by id.

### 3.2 Worked example — CASH sale, exact amounts

Base currency USD (2 minor units), transaction currency USD, so the rate is the base sentinel.

```
line 1   3 × 12.50   gross 3750   line discount 250   net 3500
line 2   1 ×  9.99   gross  999   line discount   0   net  999

invoices.subtotal_txn_minor = 4749       (3750 + 999)
invoices.discount_txn_minor =  250
invoices.tax_minor          =    0       structurally (OD-03 OPEN)
invoices.total_txn_minor    = 4499       4749 − 250 + 0, and 3500 + 999
invoices.total_base_minor   = 4499       HALF_EVEN(4499 × 1.0000000000)
invoice_items.base_share_minor = 3500, 999        Σ = 4499
```

**Journal entry, source type `invoice`, source id = `invoices.id`, entry_date = `2026-10-01`:**

| line | account | side | base_amount_minor | base ccy | txn_amount_minor | txn ccy | fx_rate | source | fx_rate_at | warehouse | branch |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `cash` (1000) | D | **4499** | USD | **4499** | USD | 1.0000000000 | base | 2026-10-01T00:00:00Z | — | the sale's branch |
| 2 | `sales_revenue` (**4000**) | C | **4499** | USD | **4499** | USD | 1.0000000000 | base | 2026-10-01T00:00:00Z | — | the sale's branch |

**Journal entry, source type `sale`, source id = `sales.id`, entry_date = `2026-10-01`** (the COGS entry,
§4; the movements are `−1200` and `−333`, so `Σ = −1533`):

| line | account | side | base_amount_minor | base ccy | txn_amount_minor | txn ccy | fx_rate | source | warehouse | branch |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `cogs` (5000) | D | **1533** | USD | **1533** | USD | 1.0000000000 | base | the sale's warehouse | the sale's branch |
| 2 | `inventory` (1200) | C | **1533** | USD | **1533** | USD | 1.0000000000 | base | the sale's warehouse | the sale's branch |

### 3.3 Worked example — CREDIT sale, exact amounts, and the rounding made visible

The same basket, sold on account to a named customer, invoiced in EUR while the business keeps books in
USD at `1.0850000000`.

```
invoices.total_txn_minor  = 4499 EUR minor units
invoices.total_base_minor = 4881         HALF_EVEN(4499 × 1.085) = HALF_EVEN(4881.415) = 4881
invoice_items.base_share_minor = 3797, 1084       Σ = 4881   (largest remainder over 3500, 999)
```

**Journal entry, source type `invoice`, source id = `invoices.id`, entry_date = `2026-10-01`:**

| line | account | side | base_amount_minor | base ccy | txn_amount_minor | txn ccy | fx_rate | source | fx_rate_at | warehouse | branch |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `accounts_receivable` (1100) | D | **4881** | USD | **4499** | EUR | 1.0850000000 | manual | the invoice's own `rate_timestamp` | — | the sale's branch |
| 2 | `sales_revenue` (**4000**) | C | **4881** | USD | **4499** | EUR | 1.0850000000 | manual | the invoice's own `rate_timestamp` | — | the sale's branch |

The COGS entry is identical to §3.2's: cost of goods is a base-currency fact and does not know what
currency the customer was billed in.

The historical snapshot is **carried, never recomputed**: the rate, its source and its instant are the
invoice's own stored values. `0043:208-245` verifies the arithmetic and `R-ACC-07` re-verifies it over
data.

---

## 4. The COGS entry — source type `sale`

Two lines, base only, `Dr cogs (5000) / Cr inventory (1200)`, for
`−Σ stock_movements.value_delta_base_minor` over the movements of that sale.

Both lines carry the sale's **warehouse and branch**. The precedent is
`accounting_negative_inventory_cost_adjustment_entry_complete` (`0063:1640-1643`), the only accepted
Inventory/COGS pair in the tree, which requires `warehouse_id IS NOT DISTINCT FROM v_wh` on **every** line
of the entry, its COGS line included. The purchase entry's counter-account carries a null warehouse
(`0063:1584-1585`), but its counter-account is Accounts Payable — a supplier fact with no warehouse — and
COGS is not. One warehouse per sale (the till's) is what makes the dimension single-valued, which is why
`sales.warehouse_id` is `NOT NULL` in §6.1.

Both lines are base-to-base at rate `1.0000000000`, source `base`, at the entry date's **midnight UTC** —
the deterministic instant `deriveOpeningBalanceLines` already uses
(`packages/accounting/src/sources.ts`), so the database's independent re-derivation reproduces the digest.
No clock is read anywhere in the path (`[[daftar-a-command-must-not-read-the-clock]]`).

### 4.1 The amount is the sum of stored integers, and nothing else

`inventory_apply_stock_movements` **computes** an outbound movement's value and **refuses a caller that
supplies one** — `0060:376-379` raises `inventory.movement_shape_invalid` for an outbound request
carrying either `unit_cost_base_minor` or `value_delta_base_minor`. Its two branches are:

```
0060:388-392    abs(qty) = level_qty   →  v_value := -v_level_value          (the exact stored valuation, NO rounding)
                otherwise              →  v_value := -inventory_half_even(abs(qty) * v_level_avg, 1, 0)
```

So the COGS figure is the sum of those stored integers, negated. **It is never
`quantity × average_cost`**: that is a second rounding at a second grain, it cannot reproduce the
emptying branch at all, and `average_cost` is itself a derived rounded quotient —
`[[daftar-a-rounded-quotient-is-never-an-input]]`. §2.1 shows what breaks if it is.

### 4.2 A sale that moved no stock is refused; a sale of ZERO-VALUED stock posts one entry

These are two different things, and the first version of this section ran them together and refused both.
Refusing the second made a legitimate sale **uncommittable**, which is worse than the wrong journal it was
trying to avoid.

**A sale that moved no stock at all** is refused: a commit with no movements is a caller defect.

**A sale that released no stock VALUE is legitimate and reachable.** `0060:388-390` sets
`v_value := -v_level_value` on the movement that empties a stock key, and that is `0` when the key's stored
valuation is `0` — a free sample taken into stock at no cost, a write-down that emptied a key's value while
units remained, an opening position stated at zero. Such a sale has no cost of goods, and
`journal_lines_money_cap_ck` (`0042:225`) requires `base_amount_minor > 0`, so a zero line is not
expressible.

So `deriveSaleCogsEntryLines` returns **`null`**, `SaleCommitPostings.cogs` is `null`, and
`mintSaleCommitAssertions` mints **one** assertion. The accounting is sound with one entry — revenue and
its settlement — and `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor` still holds, at `0`
on both sides.

**Minting a second assertion for an entry that will never be posted is the one thing that must not
happen.** `AccountingAssertionSequence.assertComplete()` refuses a commit that presented some but not all
of its assertions, so a fabricated COGS assertion would make the sale fail at COMMIT with the seam's own
error — a correct sale refused by a bookkeeping artefact.

**Where this is enforced is NOT here.** A pure function returning `null` is a shape, not a guarantee:
nothing in it stops a future writer bridging a non-zero movement value and posting no `sale` entry. That is
the migration owner's deferred trigger on `sales` — a non-zero bridged movement total with no `sale`
accounting binding fails the COMMIT — and this arm is written to agree with it, not to replace it
(`[[daftar-wrapper-is-not-an-invariant]]`). The seam side is the sale contract owner's conditional-assertion
arm.

---

## 5. Rounding is not additive — the count, and which one is deleted

The requirement is to **count** the roundings in the sale path and **delete the second**, rather than try
to reconcile two layers that obey "the same contract" at two aggregation grains
(`[[daftar-rounding-is-not-additive]]`).

### 5.1 The revenue side — two candidates, one deleted

| # | rounding | grain | verdict |
|---|---|---|---|
| 1 | `invoices.total_base_minor = HALF_EVEN(total_txn_minor × rate)` | header | **KEPT.** `0043:208-245` forces it on both journal lines; it is not optional. |
| 2 | `invoice_items.base_share_minor = HALF_EVEN(net_txn_minor × rate)` per row | row | **DELETED.** Replaced by an exact integer **split** of #1 by largest remainder. |

`0075` creates both columns (`0075:263`, `0075:351`) and **ties neither to the other** — I grepped: the
only occurrences of `base_share_minor` and `total_base_minor` in `0075` are `:263`, `:351`, `:566` (the
lifecycle guard's immutability list) and `:730` (`invoice_outstanding`'s read). So the relationship is
genuinely open and this slice fixes it, in the invoice's deferred completeness validator (§6.3) and in
the `value_complete` trigger (§6.4): **`Σ invoice_items.base_share_minor = invoices.total_base_minor`,
exactly.**

**The drift is one base minor unit on a sale whose every input was exact.** With `rate = 1.0850000000`
and the §3.3 basket:

```
the one rounding      HALF_EVEN(4499 × 1.085)  = HALF_EVEN(4881.415) = 4881
the deleted second    HALF_EVEN(3500 × 1.085)  = HALF_EVEN(3797.5)   = 3798   (an exact tie → the even integer)
                      HALF_EVEN( 999 × 1.085)  = HALF_EVEN(1083.915) = 1084
                                                               Σ     = 4882   ← one unit of revenue that does not exist
```

And the drift is not a tolerance, it is **unpostable**: `0043:208-245` forces the entry's two lines to
carry `4881`, so a per-row revenue posting summing to `4882` could not balance against them at all. The
case is recorded as data in `SALE_BASE_SPLIT_DRIFT_VECTOR`
(`packages/accounting/src/sale-posting.ts`) and asserted both ways, so the deletion cannot be undone
silently.

The split is the same algorithm the purchase receipt uses (`packages/inventory/src/allocation.ts:40`,
driven by `packages/inventory/src/purchase-shares.ts:22`, whose header states the law in terms: "the
purchase total T is converted to base ONCE … then split … so `Σ s_i = B` exactly: the AP line and the
Inventory line carry the same B and **no rounding or variance line (6100, 6200) is ever needed**"). The
sale's split must be that algorithm because `G-18`/`GOLD-33` compares a purchase and a sale in one ledger.
It is restated in `@daftar/accounting` rather than imported — that package depends on `@daftar/domain-core`
only, and a money package importing an inventory valuation package would be an edge in the wrong
direction.

**The two implementations are compared in `tests/guards/sale-s2-base-split-agreement.test.ts`**, the only
place both packages are visible: it imports `splitBaseByLargestRemainder` and the inventory
`largestRemainder`, runs both over `SALE_BASE_SPLIT_AGREEMENT_VECTORS` and over a swept range, and
**proves the vectors discriminate before trusting them** — flipping the tie rule to the higher index
changes the answer on three of the six, so the set can see the one thing two correct largest-remainder
implementations can disagree about. An earlier version of this sentence pointed at an accounting-package
test that claimed the cross-package agreement and never imported the inventory side, so a duplication
justified by a pin had a pin with one side missing; that test now claims only its own side and says so.

### 5.2 The COGS side — one rounding, already performed, at the row

There is **no rounding in the accounting layer at all**, which is the point. The one rounding is the stock
writer's own `inventory_half_even(|qty| × avg)` at `0060:392`, at the **row**, inside the only stock
writer, already stored as an exact integer — and on the emptying branch there is not even one. The COGS
entry sums those integers. Any header-grain recomputation would be the second rounding and §2.1 shows it
going red on `R-INV-01`.

This is the sense in which the law is **round once, at the row**: the row-grain integers are authoritative
and every layer above them is exact integer arithmetic over those integers — no second conversion on the
COGS side, and on the revenue side a header conversion whose row-grain shares are an exact split of it
rather than a second conversion.

---

## 6. The DDL the migration owner must write — specification for `0077`

Agent E owns `infrastructure/database/migrations/**`. Nothing below is written by me.

Ordering notes that have cost this project time: the accounting registry rows come **first**, because the
source tables' binding FKs and the journal's source FK need them (`0072:152-154` is the precedent);
privileges are granted **before** ownership is handed over (`[[daftar-grant-before-owner]]`, `P4-AL-39` —
a `GRANT` without grant option warns and commits, so an ordering mistake produces a green migration and a
missing privilege); and `0077` carries **no** `MIGRATION_MANIFEST.json` entry (`TL-P4-S1-C8`).

### 6.1 The accounting registries

```sql
-- sort_order 1–12 are taken (0042:66-68 = 1..3, 0061:1657-1658 = 4..5,
-- 0063:1724-1725 = 6..7, 0065:1908 = 8, 0067:2281-2283 = 9..11, 0072:156-158 = 12).
INSERT INTO accounting_source_types (source_type, lower_bound_policy, upper_bound_policy, description, sort_order) VALUES
  ('sale',    'none', 'not_after_today',
   'The cost of a confirmed sale: Dr Cost of Goods Sold / Cr Inventory, for the sum of the sale stock movement values (P4-AL-25).', 13),
  ('invoice', 'none', 'not_after_today',
   'A posted sales invoice: Dr the settlement account for a cash sale or Accounts Receivable for a credit sale / Cr Sales Revenue (P4-AL-20).', 14);

-- Exactly one owning kind per type (UNIQUE (source_type), 0046:86-99).
INSERT INTO accounting_operation_kinds (operation_kind, source_type, description) VALUES
  ('post', 'sale',    'Sale cost of goods; derived by the sale commit command.'),
  ('post', 'invoice', 'Sales invoice revenue; derived by the sale commit command.');
```

`description` is `CHECK (char_length(description) BETWEEN 1 AND 200)` (`0042:55`) — both strings above are
within it. `upper_bound_policy` has `'not_after_today'` as its only admitted value (`0042:54`).
`registered_by` is not a column of these two tables.

### 6.2 The generic reversal guard, replaced by its owner — and how `S-P4-02` is **satisfied**

`accounting_reversals_20_domain_source_guard` is a **closed literal list** that stops at Phase 3. **The
live body is `0072:634-666`, the SIXTH version — not `0067:2242-2271`, which an earlier draft of this
section cited.** The function has been `CREATE OR REPLACE`d five times (`0061:1527`, `0063:1530`,
`0065:1756`, `0067:2249`, `0072:642`), and the correction matters because the replacement is specified as
"the previous body byte for byte except the `IN` list": based on `0067` it would have silently **dropped
`purchase_residue_write_off`**, which `0072` added, re-opening the generic reversal door for the Phase 3
corrective source type while appearing to close two. Rebase the replacement on `0072`'s body. `0077` does
not exist at this head, so nothing was built on the wrong citation. `accounting_post_reversal` is granted to `daftar_app` (`0046:765`). Until both Phase 4 types
are in that list, `daftar_app` can call the generic reversal on an `invoice` entry and get a mirrored
revenue reversal with **no paired credit note, no stock return and no audit of the commercial fact** —
and, because there is exactly one reversal slot per entry, that illegitimate reversal **consumes it** and
the legitimate correction is then refused with `accounting.reversal_exists`, leaving the books
un-correctable by any product path (`P4-AL-47`).

So `0077` replaces the body **by its owner**, `0072:632`'s bracket exactly — `SET LOCAL ROLE
daftar_accounting_internal;` … `RESET ROLE;` and `REVOKE CREATE ON SCHEMA public FROM
daftar_accounting_internal;` — keeping **`0072`'s** body byte for byte except the always-refused `IN` list,
which gains both names:

```sql
            AND (je.source_type IN ('inventory_adjustment', 'inventory_opening',
                                    'negative_inventory_cost_adjustment', 'supplier_return',
                                    'supplier_payment', 'supplier_credit_allocation', 'supplier_refund',
                                    'purchase_residue_write_off',
                                    'sale', 'invoice')          -- P4-S2
                 OR (je.source_type = 'purchase' AND NOT EXISTS (… purchase_reversals …)))
```

Neither Phase 4 type gets a `purchase`-style carve-out. A sale is corrected by a **return or a void** — a
new auditable document — never by mirroring its entry (`P4-AL-24`, `P4-AL-46`), and `DOMAIN_REVERSIBLE_SOURCE_TYPES`
stays `['purchase']`.

**How `S-P4-02` is satisfied rather than silenced.** The seam is declared at
`scripts/phase4-s1-gate.ts:1129-1142` (sealed; I did not touch it). It reads:

```ts
if (!/INSERT\s+INTO\s+accounting_source_types\b[\s\S]{0,400}?'invoice'/i.test(sql)) return [];
return /accounting_reversals?[\s\S]{0,4000}?'invoice'/i.test(sql) ? [] : [ "seam S-P4-02: …" ];
```

The first test goes **true** the moment §6.1 lands: the seam stops being dormant and starts demanding an
answer. The second test is then satisfied by §6.2, because the `CREATE OR REPLACE FUNCTION
accounting_reversals_20_domain_source_guard` statement contains the substring `accounting_reversals` and
`'invoice'` appears inside its `IN` list well within 4000 characters.

**That is satisfaction, not silencing, and the distinction is checkable three ways.** First, the seam is
not edited, disabled, or given an exemption — the gate file is sealed and untouched, which `git diff
--stat` shows. Second, the condition the seam expresses is the condition the migration actually makes
true: `daftar_app` can no longer reverse an `invoice` entry through the generic door, which is the harm
`P4-AL-47` names, and the `sale` type is added in the same statement although the seam's regex only names
`invoice`, because the seam watches a hole and the hole has two names. Third, `P4-AL-47` requires the gate
to assert **from `pg_proc.prosrc`** that every registered Phase 4 source type appears in the guard's list,
with a red proof that removes one — a live-catalogue assertion that a text-matching seam cannot be fooled
into reporting. That assertion is `gate:phase4:s2`'s and is specified in §8.

### 6.3 The two deferred completeness validators

Both in the `0067:1959-2035` form: `SECURITY DEFINER`, owned by `daftar_accounting_internal`, pinned
`search_path = pg_catalog, public, pg_temp`, `REVOKE ALL … FROM PUBLIC`, driven by a
`CREATE CONSTRAINT TRIGGER … AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.source_type = '<type>')`. Each reads the stored source row, computes the line signatures that
row implies, and compares them to the entry's actual lines as a **sorted multiset** — which is what makes
a journal shape an invariant rather than a test: a line added by any future writer, in any future
migration, is refused at commit time.

**`accounting_invoice_entry_complete()`** — `WHEN (NEW.source_type = 'invoice')`:

1. `SELECT … FROM invoices WHERE business_id = NEW.business_id AND binding_source_id = NEW.source_id AND status IN ('open','void')`; `NOT FOUND` → `accounting.inventory_detail_missing`.
2. `NEW.entry_date = invoices.issue_date`.
3. The expected multiset is exactly two signatures, both at `txn = total_txn_minor`, `txn_currency = currency_code`, the invoice's `source_to_base_rate` / `rate_source` / `rate_timestamp`, `warehouse = '-'`, `branch = invoices.branch_id`, and `base = total_base_minor`:
   - credit (`sales.settlement_kind = 'credit'`): `('accounts_receivable','D')` and `('sales_revenue','C')`;
   - cash: `('posting','D')` — compared by `l.account_id = sales.posting_account_id`, the `0067:2020` idiom — and `('sales_revenue','C')`.
4. **`Σ invoice_items.base_share_minor = invoices.total_base_minor`** and **`Σ invoice_items.net_txn_minor = invoices.total_txn_minor`** — §5.1's deleted second rounding, enforced.
5. `invoices.tax_minor = 0` and every `invoice_items.tax_minor = 0` → else `accounting.sales_tax_unsupported` (§13, `OD-03`).
6. **The non-vacuity canary.** Before comparing, the function asserts it can see its subjects: the `invoices` row was found, at least one `invoice_items` row was read, and the entry has at least two `journal_lines` rows. Zero rows is a **failure**, never a pass. `invoices` already carries the seventh policy, `accounting_validator ON invoices FOR SELECT TO daftar_accounting_internal USING (true)` (`0075:457-458`), added for exactly this reason (`TL-P4-S1-C2`); **`invoice_items`, `sales` and `sale_items` need the same policy or this validator reads zero rows under `FORCE ROW LEVEL SECURITY` and passes vacuously** — the accepted trap, and the worst failure mode available in this slice.

**`accounting_sale_entry_complete()`** — `WHEN (NEW.source_type = 'sale')`:

1. `SELECT … FROM sales WHERE business_id = NEW.business_id AND binding_source_id = NEW.source_id AND status = 'confirmed'`; `NOT FOUND` → `accounting.inventory_detail_missing`.
2. `NEW.entry_date = sales.sold_on`.
3. `v_cogs := -(SELECT sum(m.value_delta_base_minor) FROM stock_source_bridge_sale b JOIN stock_movements m ON m.business_id = b.business_id AND m.source_type = b.source_type AND m.source_id = b.source_id AND m.source_line_id = b.source_line_id AND m.movement_kind = b.movement_kind WHERE b.business_id = NEW.business_id AND b.source_id = sales.id)` — the `0063:935-939` join idiom. **No quantity and no average cost appear in this function.**
4. The expected multiset is exactly `('cogs','D',v_cogs)` and `('inventory','C',v_cogs)`, both base-to-base at rate 1 / source `base` / the entry date's midnight UTC, both with `warehouse = sales.warehouse_id` and `branch = sales.branch_id`.
5. `v_cogs > 0`.
6. **The non-vacuity canary**: the `sales` row was found, at least one bridge row joined a movement, and the entry has at least two lines. `sum(...)` over no rows is `NULL`, and a `NULL` comparison is not a pass — it raises.

### 6.4 The stock source apparatus (`P4-AL-29b`, as corrected by `TL-P4-S2-K3`)

```sql
INSERT INTO stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by)
  VALUES ('sale', 'negative', false, 'P4-S2');
INSERT INTO stock_source_types (source_type, registered_by) VALUES ('sale', 'P4-S2');
INSERT INTO inventory_operation_kinds (op_code, registered_by) VALUES ('sale.commit', 'P4-S2');
INSERT INTO inventory_operation_movement_kinds (op_code, movement_kind, registered_by)
  VALUES ('sale.commit', 'sale', 'P4-S2');
```

`0074:115-131` widened all four `registered_by` patterns to `^P[0-9]+-S[0-9]+$` (the
`inventory_operation_kinds` one keeping `OR registered_by = 'P3-C'`), so `'P4-S2'` is accepted. `sale.commit`
satisfies `op_code ~ '^[a-z]+(\.[a-z_]+)+$'` (`0054:53`), whose first segment admits no underscore —
which is `P4-AL-28`'s whole reason for `sale.*` and `customer.*`.

**`TL-P4-S2-K1`: `0077` registers `sale.commit` ALONE.** `sale.void` is P4-S6's and `sale.return` is
P4-S5's. A registered operation kind **is** a registration of authority — `0060:186` reads the allowed
operation list from the registry table at call time — so registering them here would create live authority
with no writer: `TL-P4-S1-R1`'s reasoning, applied to an operation kind instead of a source type.

The bridge and its apparatus, per `P4-AL-29b` but specified against the **live** guard body (`0067:1438`),
because §2.2 proved the accepted guard requires none of it for a type outside `v_s3`/`v_s4`/`v_s5`:

| object | shape |
|---|---|
| `stock_source_bridge_sale` | plain table, `PRIMARY KEY` **exactly** `(business_id, source_id, source_line_id, movement_kind)`; `source_type TEXT NOT NULL GENERATED ALWAYS AS ('sale') STORED` |
| `bridge_binding_fk` | five columns `(business_id, source_type, source_id, source_line_id, movement_kind)` → `stock_source_bindings` same five, `ON DELETE RESTRICT`, **validated** |
| `bridge_line_fk` | three columns `(business_id, source_id, source_line_id)` → `sale_items (business_id, sale_id, id)`, `ON DELETE RESTRICT`, validated — so **`sale_items` must carry `UNIQUE (business_id, sale_id, id)`** for the FK to be expressible |
| RLS | `ENABLE` **and** `FORCE`, plus the `0063:456-459,555-562` five-policy set |
| `stock_bridge_immutable_sale` | `BEFORE DELETE OR UPDATE … FOR EACH ROW` on `stock_ledger_append_only()` (`tgtype = 27`) |
| `stock_binding_requires_sale` | deferred constraint trigger on `stock_source_bindings`, `AFTER INSERT … FOR EACH ROW WHEN (new.source_type = 'sale')`, on its own `SECURITY DEFINER` function owned by `daftar_inventory_internal` with the pinned path |
| `source_complete`, `source_freeze`, `header_immutable`, `value_complete` | each pinned by table, name, event, column list, `WHEN`, deferral, enabled state **and the SHA-256 of its `prosrc`**, recorded at migration time |
| the replaced guard | `inventory_stock_source_guard_gaps()` replaced so `sale` is on the **pinned** side of every `NOT (v_s3 OR v_s4 OR v_s5) OR …` disjunct at `0067:1551-1564`, `:1574-1575`, `:1593-1594`, and so the four-trigger set is required for it |
| the migration's own assertion | `inventory_stock_source_guard_gaps()` returns no row, after the replacement |

`value_complete` on `sales` is the sale's twin of `0063:933-946`:
`Σ stock_movements.value_delta_base_minor = -sales.cogs_base_minor` and
`Σ sale_items` shares consistent with it — the integer identity that makes `R-INV-01` and `G-18` exact.

### 6.5 `sales` and `sale_items` — the accounting-relevant columns

The full table is Agent B's and Agent E's; these are the columns the accounting contract requires.

`sales`: `tenant_id`, `business_id` (both **real columns**, `P4-AL-08`), `id`, `branch_id`,
`warehouse_id NOT NULL` (one warehouse per sale — §4), `customer_id` (nullable, walk-in),
`settlement_kind TEXT NOT NULL CHECK (settlement_kind IN ('cash','credit'))` — a stored **input**,
`payment_method_id` and `posting_account_id` with the three-column FK
`(business_id, payment_method_id, posting_account_id)` → `payment_methods` (`0067:352-354`), both
`NULL` iff `settlement_kind = 'credit'`, `CHECK ((settlement_kind = 'cash') = (posting_account_id IS NOT NULL))`,
`CHECK (settlement_kind = 'credit' → customer_id IS NOT NULL)`, `sold_on DATE NOT NULL`,
`status TEXT NOT NULL CHECK (status IN ('draft','confirmed','void'))` (**lifecycle only**, `P4-AL-24`),
`cogs_base_minor BIGINT`, `commit_intent_sha256`, `business_transaction_id`,
`accounting_source_type TEXT NOT NULL GENERATED ALWAYS AS ('sale') STORED`, `binding_source_id UUID`,
`CONSTRAINT sales_binding_identity_ck CHECK (binding_source_id IS NULL OR binding_source_id = id)`,
`CONSTRAINT sales_binding_owed_ck CHECK ((status IN ('confirmed','void')) = (binding_source_id IS NOT NULL))`
— the nullable `purchases` variant with the status-conditional CHECK, because `sales` has a `draft` state
(`TL-P4-S1-C6`) — and `sales_binding_fk FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
REFERENCES accounting_source_bindings (business_id, source_type, source_id) DEFERRABLE INITIALLY DEFERRED`.

**That deferred FK, and not the assertion seam, is what makes the atomic sale law a fact** (§6 of the
lock): `AccountingAssertionSequence.assertComplete()` is
`if (this.presented > 0 && this.presented < this.assertions.length) throw`
(`apps/api/src/infra/database.ts:488-495`), so presenting **none** is deliberately allowed and a
transaction that minted two assertions, wrote the `sales` row and the movements and posted **zero** entries
would commit with that seam silent. The source row's own deferred binding FK fails the COMMIT instead.

`sales_walkin_no_ar`: the `sales`-side twin of `invoices_walkin_no_ar`, deferred, owned by
`daftar_accounting_internal`, refusing an `accounts_receivable` line bound to a sale with
`settlement_kind = 'cash'` — so the cash arm is refused at the database and not only at the type.

**`S-P4-01` also comes due with this migration**: `invoices.sale_id` is `NOT NULL` with no FK, and
`scripts/phase4-s1-gate.ts:1120-1127` goes red the moment a Phase 4 migration creates `sales` without the
composite FK to it. `0077` adds
`FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id)` — which is Agent E's to write and
is named here so it is not lost.

`sale_items`: `tenant_id`, `business_id`, `sale_id`, `id`, `line_no`, `product_id`, `variant_id`,
`quantity NUMERIC(18,4)`, the price columns, **`UNIQUE (business_id, sale_id, id)`** for §6.4's line FK,
and **no** `cogs_*` column on the line: the per-line cost is the movement's stored
`value_delta_base_minor` and a stored copy would be the second source of truth `P4-AL-05` forbids.

### 6.6 RLS

Seven policies on each of `sales` and `sale_items`, because both are read by an accounting validator:
one permissive `tenant_membership` in the **direct** `tenant_id = nullif(app_tenant(), '')::uuid` form
`0052:305-330` measured, four `RESTRICTIVE` per-command isolation policies, `inventory_internal_read`, and
`accounting_validator ON … FOR SELECT TO daftar_accounting_internal USING (true)` (`P4-AL-38` as corrected
by `TL-P4-S1-C2`). `invoice_items` needs `accounting_validator` **added** — `0075:460-473` gives it six
policies and not seven, and §6.3 step 4 reads it. That is a change to a frozen migration's effect, so it
is a new policy in `0077`, never an edit to `0075`.

`daftar_app` gets `SELECT` and `EXECUTE` and **no DML** on any Phase 4 table (`P4-AL-38`).

Both tables carry `tenant_id` and `business_id` as real columns with the composite
`FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)`, so a cross-tenant or
cross-business claim is not expressible.

### 6.7 The carried item, SETTLED: `stock_source_bridge_sale` carries `tenant_id`

The lock carried this to P4-S2 unresolved. `P4-AL-08` requires every Phase 4 relation to carry `tenant_id`
and `business_id` as real columns; the Phase 3 precedent `stock_source_bridge_purchase` (`0063:400-406`)
carries **no** `tenant_id`, which is why its `tenant_membership` policy uses the correlated `businesses`
subselect (`0063:556-557`).

**Resolution: `tenant_id NOT NULL`, with the composite FK. The precedent loses.**

```sql
tenant_id   UUID NOT NULL,
business_id UUID NOT NULL,
CONSTRAINT stock_source_bridge_sale_tenant_fk
  FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id),
PRIMARY KEY (business_id, source_id, source_line_id, movement_kind)   -- tenant_id NOT in the key
```

`tenant_id` is **absent from the primary key** — the live guard pins that key exactly — and **absent from
the three-column line FK** `(business_id, source_id, source_line_id)`, which the guard also pins exactly.
It is a carried, FK-bound column, not part of either identity.

**The evidence is decisive and it is a landed law in this slice's own gate, which is why the precedent
argument fails.** `scripts/guards/phase4-rls-force.ts:326-330` reports, name-independently, a Phase 4
relation carrying exactly ONE of `tenant_id`/`business_id` as a `P4-AL-08` violation:

> `${name} carries ${business_id} and not ${tenant_id}: a P4-AL-08 violation — every Phase 4 relation
> carries both as real columns`

A bridge without `tenant_id` would be **RED in `gate:phase4:s2`**. An earlier version of this section
resolved the other way, on the ground that the column is one the only writer does not write and the pinned
key may not include. That reasoning was wrong in its premise, not just its conclusion:
`stock_source_bridge_purchase` is a **Phase 3** relation and the Phase 4 guard does not judge it, so it was
never a precedent *for a Phase 4 relation* at all — it is simply outside the rule's scope. A precedent from
a phase whose law is different is not a precedent; and a landed guard in the slice's own gate outranks an
argument from convenience either way.

---

## 7. Posting authority

**No direct financial write outside the accounting authority.** Phase 4 adds no journal writer and no
`trusted` flag (`P4-AL-03`): every posting goes through `accounting_post_entry` (`0045:490`) on the seam-2
posting capability, and guard G-4 (`scripts/guards/posting-surface.ts`) discovers journal writers from the
schema rather than naming one.

`EXECUTE` on a definer routine is **new authority, not mere reachability**
(`[[daftar-execute-is-reachability-not-authority]]`, `P4-AL-39`). So:

- every new `0077` DEFINER routine verifies a **signed server decision** — the HMAC-signed accounting
  assertion, or the `invctl/1` inventory assertion, or both — and **never** an app-side check and
  **never** a GUC;
- **a trigger that authorizes by `current_user` is `SECURITY INVOKER`**, never DEFINER, because a
  definer-rights guard always sees its own owner and therefore always says yes
  (`[[daftar-a-guard-that-asks-who-must-run-as-the-writer]]`);
- `T-05`'s owner / pinned-path / not-applier-owned clauses (c1, c2, c7) bind **DEFINER** routines only, so
  an INVOKER read function may be applier-owned — `TL-P4-S1-C16`, with `purchase_ap_outstanding` as the
  accepted precedent, and the four `0075` readers as the Phase 4 ones;
- `TL-P4-S1-C17` stands: no new `daftar_sales_internal` principal in this slice. The stock-side guards are
  owned by `daftar_inventory_internal` and the accounting-side guards — `accounting_invoice_entry_complete`,
  `accounting_sale_entry_complete`, `sales_walkin_no_ar` — by `daftar_accounting_internal`, which is also
  the correct reading on the merits: the guard that refuses an AR posting for a cash sale is the accounting
  authority's.

The application-side boundary is `apps/api/src/modules/accounting/sale-posting.service.ts`, the only place
in the process where a sale's posting authority is minted. It applies `P4-AL-35`'s matrix at the mint:
`sales.create` for a cash sale, `sales.create` **+ `receivables.view`** for a credit sale — a till that may
sell for cash but may not see what customers owe has no business creating debt — plus the branch-scope
refusal of `P4-AL-40`. There is no `mintTrusted`, no `skipPermission`, no actor parameter, and no amount
parameter: every figure comes from resolved server-side facts (`P4-AL-18`).

### 7.1 The COGS fingerprint is a prediction, and that is safe

The seam takes its assertions **before** the transaction opens, but an outbound movement's value is
computed **inside** it, by the stock writer, under the stock key's lock (§4.1). So the COGS figure the
caller signs is a prediction read from `stock_levels` before the lock, and a concurrent movement on the
same key can make it stale.

This is the shape the reversal mirror already has, and `packages/accounting/src/sources.ts`'s module header
states the principle: "the database derives the same values from the same persisted rows, and the two
derivations are compared through the signed fingerprint before anything is written. **A bug in either one
is a refusal, never a wrong entry.**" Three mechanisms make a disagreement loud, in order:

1. `accounting_post_entry` recomputes `acctfp/1` from the lines it actually received and refuses a mismatch
   **before any write** (`0045:27-43`, step order);
2. `accounting_sale_entry_complete` re-derives the expected COGS line from the **persisted**
   `stock_movements` and fails the COMMIT on any difference (§6.3);
3. the sale's own deferred binding FK fails the COMMIT if the entry never happened at all (§6.5).

A stale prediction therefore costs a **refused sale** the till retries — the atomic refusal `OD-P4-05` is
ruled for, and the same refusal `G-01`'s last-item race expects — and can never cost a misstated COGS.

---

## 8. What `gate:phase4:s2` must assert (for the gate's owner)

Not mine to write; listed so nothing in this contract is a claim without a check.

1. **From `pg_proc.prosrc`**, every registered Phase 4 accounting source type appears in
   `accounting_reversals_20_domain_source_guard`'s literal list, with a red proof that removes one
   (`P4-AL-47`). This is the live-catalogue assertion that `S-P4-02`'s text match cannot substitute for.
2. The structural half of `P4-AL-16` from `pg_constraint`: for each of `sales` and `invoices`, the generated
   `accounting_source_type` constant, `binding_source_id`, the identity CHECK and the **deferred** binding
   FK — all four.
3. Both deferred completeness validators exist, are `DEFERRABLE INITIALLY DEFERRED`, are owned by
   `daftar_accounting_internal`, and each has a red proof that plants an extra line, a missing line, a
   wrong amount and a wrong date and requires the COMMIT to fail on each.
4. **Each validator's non-vacuity canary has its own red proof**: drop the `accounting_validator` policy
   from `invoice_items` (or from `sales`) in a scratch database and require the validator to **FAIL**, not
   pass. A green validator over an unchecked invariant is the worst failure mode available here
   (`TL-P4-S1-C2`).
5. `inventory_stock_source_guard_gaps()` returns no row, and a planted removal of one `sale` bridge object
   makes it return one — proving the replaced guard actually pins the `sale` arm (§2.2).
6. `Σ invoice_items.base_share_minor = invoices.total_base_minor` enforced at COMMIT, with a red proof that
   plants the per-row `HALF_EVEN` figures of §5.1 and requires the refusal.
7. The sale path opens **exactly one** transaction (`P4-AL-57`), and `G-06`'s failure injection finds no
   partial state.
8. `R-INV-01` … `R-INV-05` green with sale-driven movements in the ledger (`G-18`'s sale-side half), and
   `R-ACC-06` green — which §2.3 shows depends on the `DOMAIN_SOURCE_TYPES` change.

---

## 9. One finding that is not mine to fix: an assertion-requiring seam forces a fake assertion

`AccountingAssertions` is `string | readonly [string, ...string[]]`
(`apps/api/src/infra/database.ts:415`), a **non-empty** type, and
`withBusinessInventoryAccountingTransaction` refuses to open without one —
`AccountingAssertionSequence.plan` raises `seam.accounting_assertion_missing` on an empty list
(`:443-446`).

**Not every atomic operation implies a posting.** A `draft` sale and a `draft` invoice post nothing:
`invoices_binding_owed_ck` (`0075:301`) makes a draft owe no binding, and §6.5's `sales_binding_owed_ck`
does the same for a draft sale. Such a command needs the **inventory** seam's atomicity without any
posting capability. Today it has two options and both are defects: mint a **fake** assertion it will never
present — which spends real signed authority to satisfy a type, and relies on
`assertComplete()`'s "presenting none is allowed" branch to stay permissive for ever — or **split its
commit** into a non-seam transaction, which is exactly the independent commit the atomic sale law forbids.

**The capability belongs in the type, not in a sentinel value.** The seam's accounting authority should be
a discriminated union whose "no posting" arm carries no assertion at all and yields no posting capability:

```ts
export type SeamAccountingAuthority =
  | { readonly kind: 'postings'; readonly assertions: readonly [string, ...string[]] }
  | { readonly kind: 'no_posting' };
```

A command that posts nothing then says so, and a command that posts cannot be written without an
assertion. `withBusinessInventoryTransaction` already exists for stock-only work (`:116`), so the gap is
narrow — a transaction that is stock-plus-non-posting-document work — but the draft sale is exactly that
case.

`apps/api/src/infra/database.ts` is **not** an accounting module and is therefore not mine to edit. I am
reporting it with the exact change rather than making it. Note that both arms of
`assertComplete()` keep their meaning under the union, and the "presenting none" branch could then be
**tightened** to a refusal, because the only legitimate caller of it — a replay inside the routine
(`:425-429`) — is still a `postings` caller and the non-posting case no longer needs the branch.

### 9.1 One line of DI wiring, also not mine

`SalePostingService` needs one entry in the API's provider list —
`apps/api/src/app/runtime.ts`, beside `AccountingPostingService` at `:214`, with its import beside `:31` —
or nothing can inject it. That file is shared app composition rather than an accounting module, and it is
the kind of file that produces a merge conflict for every agent at once, so it is reported rather than
edited. Agent B's sale commit service then injects `SalePostingService` and **never mints an assertion
itself**: that is the whole point of §7.

---

## 10. Conflicts between the documents and the code, reported rather than followed

1. **`R-SAL-01` is wrong for a cash sale.** `P4-AL-49` states it as "AR from the journal = Σ(invoice
   totals) − Σ(allocations) − Σ(applied credit notes)". Under §3.1's shape — which the frozen
   `invoices_walkin_no_ar` requires — a cash sale's invoice total **never touches AR**, so the identity is
   false for every business that sells for cash. It must be `Σ(credit-invoice totals)`, scoped by the
   settlement input, not `Σ(invoice totals)`. P4-S8 owns `R-SAL-01`; this is flagged now so it is not
   discovered as a reconciliation discrepancy over real data.
2. **`P4-AL-16` describes a cash sale as posting "the payment, its allocation and the settlement entry".**
   `payments` and `payment_allocations` are P4-S4's relations and do not exist in P4-S2, and
   `invoices_walkin_no_ar` makes the two-entry `Dr AR / Cr revenue` + `Dr cash / Cr AR` shape unpostable
   for a walk-in anyway. The code wins: a cash sale is one invoice entry debiting the settlement account.
   This is the shape the coordinator marks recommended-pending the Tech Lead's word.
3. **`P4-AL-29b` cites a superseded guard body.** It cites `0061:307-481`; the live body is `0067:1438`,
   the fifth version, and it is materially weaker for a type outside `v_s3`/`v_s4`/`v_s5` (§2.2).
   `TL-P4-S2-K3` is confirmed against the code.
4. **`0075` creates `total_base_minor` and `base_share_minor` and relates them nowhere.** Verified by
   grep: `0075:263`, `:351`, `:566`, `:730` are the only occurrences. The relationship is this slice's to
   fix (§5.1, §6.3).
5. **`invoice_items` has six RLS policies, not seven**, although §6.3's validator reads it. `0075:460-473`.
   A new policy in `0077` (§6.6), never an edit to `0075`.
6. **Two stale deferral reasons in `DEFERRED_RECONCILIATION_DOMAINS`** named conditions that had already
   stopped being true (`customers do not exist yet`, after `0075` created them). Corrected in place in
   `packages/accounting/src/reconciliation.ts`; a deferral whose stated reason has become false is a green
   nobody re-reads.
7. **Five defects in this contract's own first version**, found by an independent red team and verified in
   the code before being fixed. They are recorded rather than quietly corrected, because four of the five
   are the same mistake in different clothes — *a claim about a protection that was not where the claim
   said it was*:
   - the settlement account's `code` arm fell through unchecked, justified by a database check that is not
     invoked on this path (§3.1);
   - the cross-package base-split agreement was asserted against one side only (§5.1);
   - `packages/accounting/src/post.ts` stated as a present database fact that the reversal guard names
     `sale` and `invoice`; it names neither, in any of its six versions, and `0077` does not exist;
   - §6.2 cited `0067` as the live guard body when the live one is `0072` — a replacement built on that
     citation would have silently dropped `purchase_residue_write_off` from the refused list;
   - §6.7 resolved the bridge tenancy from a Phase 3 precedent that the Phase 4 guard does not judge.

   The fifth, the zero-cost COGS arm (§4.2), is a different kind: a refusal that was correct about the
   journal and wrong about the sale.
