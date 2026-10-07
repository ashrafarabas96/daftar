# P4-S5 DDL SPECIFICATION — `credit_notes`, `credit_note_items`, `credit_note_applications`, `refunds`

**Status: SPECIFICATION ONLY, maturity level E. This document is not a migration and
allocates no migration number.** `0000`–`0079` are immutable byte for byte, `0080`–`0086`
are P4-S4 candidates, and there is exactly ONE migration owner in this phase — not S5. The
prefix this specification lands under is **unknown until S4 seals**, and it is deliberately
not guessed anywhere below: every cross-reference is to a routine or constraint by NAME, never
to a future file number.

Base of record: `phase/4-sales-pos-customers-receivables` at **`6587460`**.

Verified absent over the whole tree at that head: `refunds`, `credit_notes`,
`credit_note_items` and `credit_note_applications` exist at **no** prefix `0000`–`0086`. The
only live relations of the family are `supplier_credit_notes` (`0065:255`),
`supplier_refunds` (`0067:460`), `customer_credits` (`0081:371`) and
`customer_credit_applications` (`0081:438`).

---

## 0. The four relations, and why there are four and not three

`docs/PHASE_4_EXECUTION_PLAN.md:187-188` and `:324` both name three — `credit_notes`,
`credit_note_items`, `refunds`. **The fourth is load-bearing and its omission from the plan
is a recorded staleness, not a decision.** `docs/PHASE_4_DECISION_REGISTER.md:280-283` records
`credit_note_applications` as absent and needed by the owed financial test, and
`INVOICE_REDUCER_VOCABULARY` (`scripts/phase4-s1-gate.ts:1237`) names it as a REDUCER.

Without it there is nowhere to put the per-invoice AR reduction, so an S5 that reduced AR by
writing to `credit_notes` directly would have no level chain at all — and the level chain is
the mechanism `P4-AL-22` makes necessary. So:

| relation | what it is | consumes | is consumed by |
|---|---|---|---|
| `credit_notes` | the DOCUMENT and the consumable source: a numbered, dated note with a remaining PAIR | — | `credit_note_applications`, `refunds` |
| `credit_note_items` | its returned lines, with each line's EXACT COGS reversal | — | — |
| `credit_note_applications` | the ONE AR reducer: one row per (note, invoice), at the invoice's AR level | `credit_notes` | — |
| `refunds` | the cash disbursement: consumes `credit_notes` XOR `customer_credits`, touches NO invoice | both sources | — |

---

## 1. `credit_notes`

### 1.1 Columns

```
tenant_id                            UUID NOT NULL
business_id                          UUID NOT NULL
id                                   UUID NOT NULL
branch_id                            UUID NOT NULL
customer_id                          UUID NOT NULL
invoice_id                           UUID NOT NULL        -- the note's ORIGIN invoice (§1.5)
credit_note_number                   TEXT NOT NULL
number_period                        TEXT NOT NULL
number_seq                           BIGINT NOT NULL CHECK (number_seq >= 1)
status                               TEXT NOT NULL CHECK (status IN ('draft','issued','void'))
credit_note_date                     DATE NOT NULL
reference                            TEXT CHECK (reference IS NULL OR (char_length(reference) BETWEEN 1 AND 100 AND reference = btrim(reference)))
currency                             CHAR(3) NOT NULL
total_txn_minor                      BIGINT NOT NULL CHECK (total_txn_minor BETWEEN 1 AND 1000000000000000000)
total_base_minor                     BIGINT NOT NULL CHECK (total_base_minor BETWEEN 1 AND 1000000000000000000)
source_to_base_rate                  NUMERIC(20,10) NOT NULL CHECK (source_to_base_rate > 0 AND source_to_base_rate = trunc(source_to_base_rate, 10))
tax_minor                            BIGINT NOT NULL DEFAULT 0
original_amount_minor                BIGINT NOT NULL CHECK (original_amount_minor BETWEEN 1 AND 1000000000000000000)
original_carrying_base_amount_minor  BIGINT NOT NULL CHECK (original_carrying_base_amount_minor BETWEEN 1 AND 1000000000000000000)
remaining_amount_minor               BIGINT NOT NULL CHECK (remaining_amount_minor BETWEEN 0 AND 1000000000000000000)
remaining_carrying_base_amount_minor BIGINT NOT NULL CHECK (remaining_carrying_base_amount_minor BETWEEN 0 AND 1000000000000000000)
intent_sha256                        TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$')
business_transaction_id              UUID NOT NULL
created_by                           UUID NOT NULL REFERENCES users (id)
created_at                           TIMESTAMPTZ NOT NULL DEFAULT now()
accounting_source_type               TEXT NOT NULL GENERATED ALWAYS AS ('customer_return') STORED
binding_source_id                    UUID NOT NULL
```

### 1.2 Keys, CHECKs and the document number

```
PRIMARY KEY (business_id, id)

-- G-07 (scripts/phase4-s1-gate.ts:1627-1648). A document number needs business_id
-- and a TOTAL UNIQUE including it. There is NO soft delete on this relation, so the
-- UNIQUE is total and not partial.
CONSTRAINT credit_notes_number_uq      UNIQUE (business_id, credit_note_number)
CONSTRAINT credit_notes_number_seq_uq  UNIQUE (business_id, number_period, number_seq)

-- OD-03, mirroring invoices.tax_minor (0075:261) EXACTLY. A single-column CHECK, which
-- is the shape od03Problems (tests/security/phase3-s8-grant-matrix.test.ts:174) demands
-- of every column matching `(^|_)tax(_|$)` in public, with no allowlist.
CONSTRAINT credit_notes_tax_policy_absent_ck CHECK (tax_minor = 0)

-- P4-AL-14: the remaining PAIR, never a consumption total.
CONSTRAINT credit_notes_remaining_ck   CHECK (remaining_amount_minor <= original_amount_minor)
CONSTRAINT credit_notes_carrying_ck    CHECK (remaining_carrying_base_amount_minor <= original_carrying_base_amount_minor)
CONSTRAINT credit_notes_original_ck    CHECK (original_amount_minor = total_txn_minor
                                              AND original_carrying_base_amount_minor = total_base_minor)
CONSTRAINT credit_notes_binding_identity_ck CHECK (binding_source_id = id)
```

**Why `original_*` duplicates `total_*` and is not a second truth.** It is one `CHECK` that
makes them identical, not two independently writable figures. The pair exists under its
consumable-source names so that `supplier_credit_remaining_carrying(original, original_carrying, r)`
and the chain verifier can be called on this relation with the SAME argument names they take
on `customer_credits` — which is what lets ONE verifier serve both sources. The alternative is
a second verifier body per source, and that is the second truth P4-AL-07 refuses.

### 1.3 Foreign keys — the full map

```
credit_notes_tenant_fk    FOREIGN KEY (tenant_id, business_id)              → businesses (tenant_id, id)
credit_notes_branch_fk    FOREIGN KEY (business_id, branch_id)              → branches (business_id, id)                ON DELETE RESTRICT
credit_notes_customer_fk  FOREIGN KEY (business_id, customer_id)            → customers (business_id, id)               ON DELETE RESTRICT
credit_notes_invoice_fk   FOREIGN KEY (business_id, invoice_id, customer_id)→ invoices (business_id, id, customer_id)   ON DELETE RESTRICT
credit_notes_currency_fk  FOREIGN KEY (currency)                            → currencies (code)
credit_notes_binding_fk   FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
                                                                            → accounting_source_bindings (business_id, source_type, source_id)
                                                                              DEFERRABLE INITIALLY DEFERRED
```

The three-column invoice edge is **not** decoration. `0082` added
`invoices_customer_uq UNIQUE (business_id, id, customer_id)` — non-partial, so it validates on
rows that already hold `customer_id IS NULL` — and both S4 reducers were widened onto it
(`0082:187-203`). Every referencing column here is `NOT NULL`, so the edge is checked on every
row, and a non-null triple has no target in a walk-in invoice. **That makes
`credit_note.invoice_walkin` unrepresentable at the row level rather than merely refused by a
routine**, and the same device is what makes `credit_note.customer_mismatch` structural.

### 1.4 The composite bridge to accounting

`accounting_source_type` is `GENERATED ALWAYS AS ('customer_return') STORED`,
`binding_source_id` is `CHECK (binding_source_id = id)`, and the pair carries a composite FK
into `accounting_source_bindings (business_id, source_type, source_id)`, `DEFERRABLE INITIALLY
DEFERRED`. That is the accepted bridge (`supplier_refunds`, `0067:489-511`) and it is why
there is **no polymorphic financial foreign key** anywhere in this specification: the
`*_type` is a generated literal, not a discriminator a writer chooses, and the `*_id` has a
real edge.

### 1.5 `invoice_id` is the ORIGIN, not an AR reduction

A credit note names ONE invoice — the sale it reverses, which is what makes
`credit_note.quantity_exceeds_sold` answerable and what gives the COGS reversal its
provenance. **That is not the AR reduction.** The AR reduction is a
`credit_note_applications` row, at the invoice's AR LEVEL, and a note may reduce AR by less
than its total (or by nothing at all, against an already-paid invoice). The two are different
facts and a reader who conflates them has read `TL-P4-S5-R1` backwards.

### 1.6 Indexes

```
credit_notes_customer_idx ON credit_notes (business_id, customer_id, credit_note_date DESC, id DESC)
credit_notes_invoice_idx  ON credit_notes (business_id, invoice_id)
credit_notes_open_idx     ON credit_notes (business_id, customer_id) WHERE remaining_amount_minor > 0
```

The first is the keyset read of §6's page and carries the full ORDER BY, so the page is an
index scan and not a sort. The third is partial on the only predicate the refund surface
asks — "which of this customer's notes still have something in them" — and a partial index is
chosen rather than a stored flag for the P4-AL-14 reason: a flag can disagree with the pair.

---

## 2. `credit_note_items`

```
tenant_id              UUID NOT NULL
business_id            UUID NOT NULL
id                     UUID NOT NULL
credit_note_id         UUID NOT NULL
line_no                INTEGER NOT NULL CHECK (line_no BETWEEN 1 AND 200)
product_id             UUID NOT NULL
invoice_item_id        UUID NOT NULL
quantity               NUMERIC(20,6) NOT NULL CHECK (quantity > 0 AND quantity = trunc(quantity, 6))
unit_price_minor       BIGINT NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 1000000000000000000)
net_txn_minor          BIGINT NOT NULL CHECK (net_txn_minor BETWEEN 1 AND 1000000000000000000)
base_share_minor       BIGINT NOT NULL CHECK (base_share_minor BETWEEN 0 AND 1000000000000000000)
tax_minor              BIGINT NOT NULL DEFAULT 0
cogs_reversal_base_minor BIGINT NOT NULL CHECK (cogs_reversal_base_minor BETWEEN 1 AND 1000000000000000000)

PRIMARY KEY (business_id, id)
CONSTRAINT credit_note_items_line_uq    UNIQUE (business_id, credit_note_id, line_no)
CONSTRAINT credit_note_items_source_uq  UNIQUE (business_id, credit_note_id, invoice_item_id)
CONSTRAINT credit_note_items_tax_policy_absent_ck CHECK (tax_minor = 0)
credit_note_items_note_fk  FOREIGN KEY (business_id, credit_note_id) → credit_notes (business_id, id) ON DELETE RESTRICT
credit_note_items_item_fk  FOREIGN KEY (business_id, invoice_item_id) → invoice_items (business_id, id) ON DELETE RESTRICT
credit_note_items_product_fk FOREIGN KEY (business_id, product_id) → products (business_id, id) ON DELETE RESTRICT
credit_note_items_note_idx ON credit_note_items (business_id, credit_note_id, line_no)
```

**`base_share_minor` is an exact integer SPLIT of `credit_notes.total_base_minor`, never a
per-row `HALF_EVEN(net_txn × rate)`.** `packages/accounting/src/sale-posting.ts:36-59` records
the worked case: at rate `1.085` two lines of `3500` and `999` convert per-row to `3798 + 1084
= 4882` while the header converts to `4881` — one base minor unit of revenue invented by the
second rounding, on a document whose every input was exact. The split device is
`splitBaseByLargestRemainder`, already accepted, and this relation reuses it.

**`cogs_reversal_base_minor` is `>= 1` and is the SUM OF THE EXACT STORED
`stock_movements.value_delta_base_minor` of this line's return movements.** No trigger and no
`CHECK` can verify that from inside the row, so it is verified by the deferred validator of
§5.5's deferred validator, against the movements themselves. The reason it is not recomputed is
`TL-P4-S0-01` / P4-AL-25: the one official identity is
`GL Inventory (1200) = Σ stock_movements.value_delta_base_minor` and never `Σ(qty × avg)`,
because an average cost is a rounded quotient and because recomputation cannot reproduce the
branch where a movement empties a stock key and takes its stored valuation exactly
(`0060:376-394`).

**It is NOT named `cogs_minor`.** `DERIVED_COST_COLUMN`
(`scripts/guards/no-authoritative-balance.ts:320`) is `/(^|_)(cogs|cost_of_goods|…)($|_)/`, so
`cogs_minor` is a refused stored-COGS column while `cogs_reversal_base_minor` has `cogs` only
as a non-boundary prefix of `cogs_reversal`. **This must be re-measured against the guard at
promotion**; if the pattern matches it, the column is renamed to
`inventory_value_restored_base_minor` rather than the guard relaxed, and that choice is
recorded here so nobody relaxes the guard instead.

---

## 3. `credit_note_applications` — the ONE AR reducer

```
tenant_id                            UUID NOT NULL
business_id                          UUID NOT NULL
id                                   UUID NOT NULL
credit_note_id                       UUID NOT NULL
invoice_id                           UUID NOT NULL
customer_id                          UUID NOT NULL
line_no                              INTEGER NOT NULL CHECK (line_no BETWEEN 1 AND 50)
application_date                     DATE NOT NULL
credit_currency                      CHAR(3) NOT NULL
invoice_currency                     CHAR(3) NOT NULL
credit_remaining_before_minor        BIGINT NOT NULL CHECK (credit_remaining_before_minor BETWEEN 1 AND 1000000000000000000)
credit_amount_consumed_minor         BIGINT NOT NULL CHECK (credit_amount_consumed_minor BETWEEN 1 AND 1000000000000000000)
credit_carrying_base_released_minor  BIGINT NOT NULL CHECK (credit_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000)
ar_released_before_txn_minor         BIGINT NOT NULL CHECK (ar_released_before_txn_minor BETWEEN 0 AND 1000000000000000000)
invoice_amount_applied_minor         BIGINT NOT NULL CHECK (invoice_amount_applied_minor BETWEEN 1 AND 1000000000000000000)
invoice_carrying_base_released_minor BIGINT NOT NULL CHECK (invoice_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000)
realized_fx_gain_loss_minor          BIGINT NOT NULL CHECK (realized_fx_gain_loss_minor BETWEEN -1000000000000000000 AND 1000000000000000000)
business_transaction_id              UUID NOT NULL
created_by                           UUID NOT NULL REFERENCES users (id)
created_at                           TIMESTAMPTZ NOT NULL DEFAULT now()
accounting_source_type               TEXT NOT NULL GENERATED ALWAYS AS ('customer_credit_note_application') STORED
binding_source_id                    UUID NOT NULL
```

### 3.1 The level devices — BOTH of them, per P4-AL-22

```
CONSTRAINT credit_note_applications_level_uq
  UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)
CONSTRAINT credit_note_applications_invoice_level_uq
  UNIQUE (business_id, invoice_id, ar_released_before_txn_minor)
```

Both columns are `NOT NULL` on this relation, so both constraints are TOTAL and neither is
vacuous. They are the exact twins of `customer_credit_applications_level_uq` (`0081:470`) and
`customer_credit_applications_invoice_level_uq` (`0081:474`), and like them they are documented
as **a FAST PER-RELATION BACKSTOP and not the invariant** (`0081:327-333`). The invariant is
`invoice_settlement_verify` plus the widened source verifier, at COMMIT.

```
CONSTRAINT credit_note_applications_realized_ck
  CHECK (realized_fx_gain_loss_minor = credit_carrying_base_released_minor - invoice_carrying_base_released_minor)
CONSTRAINT credit_note_applications_same_currency_ck
  CHECK (credit_currency <> invoice_currency OR credit_amount_consumed_minor = invoice_amount_applied_minor)
CONSTRAINT credit_note_applications_consumed_ck
  CHECK (credit_amount_consumed_minor <= credit_remaining_before_minor)
CONSTRAINT credit_note_applications_binding_identity_ck CHECK (binding_source_id = id)
```

### 3.2 Foreign keys

```
credit_note_applications_tenant_fk   FOREIGN KEY (tenant_id, business_id)                     → businesses (tenant_id, id)
credit_note_applications_note_fk     FOREIGN KEY (business_id, credit_note_id, customer_id)   → credit_notes (business_id, id, customer_id) ON DELETE RESTRICT
credit_note_applications_invoice_fk  FOREIGN KEY (business_id, invoice_id, customer_id)       → invoices (business_id, id, customer_id)     ON DELETE RESTRICT
credit_note_applications_binding_fk  FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
                                                                                              → accounting_source_bindings (business_id, source_type, source_id) DEFERRABLE INITIALLY DEFERRED
```

The note edge needs `credit_notes` to carry
`UNIQUE (business_id, id, customer_id)` — added in §1.2's companion:

```
CONSTRAINT credit_notes_customer_uq          UNIQUE (business_id, id, customer_id)
CONSTRAINT credit_notes_customer_currency_uq UNIQUE (business_id, id, customer_id, currency)
```

the `invoices_customer_uq` (`0082`) device for the first, and the measured
`customer_credits_customer_uq` shape (`0081:403`, four columns including the currency) for the
second — so a refund's edge onto either source can pin the currency, and the two sources are
treated identically.

### 3.3 **This relation JOINS `FINANCIAL_CORE`, and that is a patch request**

`FINANCIAL_CORE` (`scripts/phase4-s1-gate.ts:504-505`) is the relation set on which a
polymorphic foreign key is refused (G-19 / GOLD-74). Measured at `6587460` it names
`credit_notes`, `credit_note_items`, `customer_credits` and `customer_credit_applications` —
and **not** `credit_note_applications`.

A relation that binds a credit note to an invoice is financial core by every reading of
`P4-AL-29`, and it would otherwise arrive OUTSIDE the pattern that refuses a polymorphic
source there, while `INVOICE_REDUCER_VOCABULARY` already treats it as a reducer. Nothing is
red today because the relation does not exist. **`PATCH-REQ-S5-005` adds the name to
`FINANCIAL_CORE`, in the same change that creates the relation, with its own red proof.**
There is no second option: either the name is added, or the migration states why the financial
core does not include a relation that moves AR, and no such statement is available.

### 3.4 Indexes

```
credit_note_applications_note_idx    ON credit_note_applications (business_id, credit_note_id)
credit_note_applications_invoice_idx ON credit_note_applications (business_id, invoice_id)
```

The invoice index is what makes the widened `invoice_outstanding` a fixed-cost read per
invoice rather than a scan, and the S4 fixed-cost law (`0084`) is the standard it will be held
to.

---

## 4. `refunds` — two nullable sources, one of them

```
tenant_id                            UUID NOT NULL
business_id                          UUID NOT NULL
id                                   UUID NOT NULL
branch_id                            UUID NOT NULL
customer_id                          UUID NOT NULL
credit_note_id                       UUID                     -- nullable
customer_credit_id                   UUID                     -- nullable
payment_method_id                    UUID NOT NULL
posting_account_id                   UUID NOT NULL
refund_date                          DATE NOT NULL
reference                            TEXT CHECK (reference IS NULL OR (char_length(reference) BETWEEN 1 AND 100 AND reference = btrim(reference)))
source_currency                      CHAR(3) NOT NULL
source_amount_consumed_minor         BIGINT NOT NULL CHECK (source_amount_consumed_minor BETWEEN 1 AND 1000000000000000000)
source_to_base_rate                  NUMERIC(20,10) NOT NULL CHECK (source_to_base_rate > 0 AND source_to_base_rate = trunc(source_to_base_rate, 10))
source_remaining_before_minor        BIGINT NOT NULL CHECK (source_remaining_before_minor BETWEEN 1 AND 1000000000000000000)
source_carrying_base_released_minor  BIGINT NOT NULL CHECK (source_carrying_base_released_minor BETWEEN 0 AND 1000000000000000000)
source_dust_base_minor               BIGINT NOT NULL CHECK (source_dust_base_minor BETWEEN -1000000000000000000 AND 1000000000000000000)
disbursement_currency                CHAR(3) NOT NULL
disbursement_amount_minor            BIGINT NOT NULL CHECK (disbursement_amount_minor BETWEEN 1 AND 1000000000000000000)
disbursement_to_base_rate            NUMERIC(20,10) NOT NULL CHECK (disbursement_to_base_rate > 0 AND disbursement_to_base_rate = trunc(disbursement_to_base_rate, 10))
disbursement_base_amount_minor       BIGINT NOT NULL CHECK (disbursement_base_amount_minor BETWEEN 1 AND 1000000000000000000)
rate_source                          TEXT NOT NULL CHECK (rate_source IN ('base','manual'))
rate_timestamp                       TIMESTAMPTZ NOT NULL CHECK (rate_timestamp = date_trunc('second', rate_timestamp))
fx_rate_id                           UUID
realized_fx_gain_loss_minor          BIGINT NOT NULL CHECK (realized_fx_gain_loss_minor BETWEEN -1000000000000000000 AND 1000000000000000000)
intent_sha256                        TEXT NOT NULL CHECK (intent_sha256 ~ '^[0-9a-f]{64}$')
business_transaction_id              UUID NOT NULL
created_by                           UUID NOT NULL REFERENCES users (id)
created_at                           TIMESTAMPTZ NOT NULL DEFAULT now()
accounting_source_type               TEXT NOT NULL GENERATED ALWAYS AS ('customer_refund') STORED
binding_source_id                    UUID NOT NULL
```

### 4.1 The columns that are deliberately ABSENT

| absent column | the law that refuses it |
|---|---|
| `invoice_id`, any `invoice_*` | `TL-P4-S5-R1`. A refund names no invoice; a column that could would be the second AR reduction expressed as a key |
| `payment_id` | `TL-P4-S5-R1` ("it carries no `payment_id`") and the plan's "no column that could name a payment". A payment already released the invoice's carrying base |
| `refunded_amount_minor` or any running total | the cap is derived from the exact stored rows. Independently refused as an authoritative-balance column by G-3's `AP_BALANCE_COLUMN` (`scripts/guards/no-authoritative-balance.ts:314`) |
| `source_type` / `refund_kind` | GOLD-74. A discriminator beside two `*_id` columns is the polymorphic shape refused on the financial core. The kind is DERIVED from which id is non-null |
| `ar_released_before_txn_minor` | there is no invoice level to be at |
| any `tax_*` | a refund moves no revenue, so it has no tax element. `od03Problems` has no allowlist: a tax-named column must be a structural zero, so the lawful choice is to carry none |
| `status` | nothing about a refund is a lifecycle. It happened |

### 4.2 The XOR, and the level devices that must NOT be copied

```
CONSTRAINT refunds_one_source_ck CHECK (num_nonnulls(credit_note_id, customer_credit_id) = 1)
```

**The level `UNIQUE` is NOT ONE CONSTRAINT.** `supplier_refunds_level_uq` (`0067:491`) is
`UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)` over a
`credit_note_id UUID NOT NULL` (`0067:465`) — one mandatory source. Here both sources are
nullable, and in PostgreSQL a `UNIQUE` is `NULLS DISTINCT` by default; nothing in this tree
ever writes `NULLS NOT DISTINCT` (the sole mention is a comment at `0005:74`). So a copied
single constraint would be **green and vacuous for exactly the half of the refunds drawn on the
other source** — every customer-credit refund holds NULL in the key and no two of them ever
collide. That is the false green `[[daftar-a-green-gate-must-prove-it-can-be-red]]` exists for,
and `tests/guards/p4s5-refund-cap-concurrency-models.test.ts` models it directly.

The specified shape is **two PARTIAL unique indexes, one per source**, each non-vacuous over
its own half:

```
CREATE UNIQUE INDEX refunds_note_level_uq
  ON refunds (business_id, credit_note_id, source_remaining_before_minor)
  WHERE credit_note_id IS NOT NULL;

CREATE UNIQUE INDEX refunds_credit_level_uq
  ON refunds (business_id, customer_credit_id, source_remaining_before_minor)
  WHERE customer_credit_id IS NOT NULL;
```

**And the per-source coverage is asserted with a RED PROOF PER SOURCE, not once for the
table.** Two red proofs: a second credit-note refund at an existing note level must be
refused, and a second customer-credit refund at an existing credit level must be refused. One
proof over one source would leave the other half exactly as vacuous as the copied constraint,
and the gate would be green.

**Neither is the invoice-side level `UNIQUE` copied.**
`customer_credit_applications_invoice_level_uq` (`0081:474`) is
`(business_id, invoice_id, ar_released_before_txn_minor)`; a refund names no invoice, so there
is no invoice level to be unique in, and a column added to carry one would be the forbidden
second AR reduction.

**Neither constraint is the bound.** P4-AL-22, in its own words: "a `UNIQUE` over a declared
remaining level forbids two rows claiming the same level; it does not cap total consumption,
because a direct SQL attacker simply declares a different level." The sufficient mechanism is
the COMMIT-time chain verifier of §5.3, and `gate:phase4:s4` already asserts that class against
direct SQL at a fabricated level; S5 owes the same against its own relations.

### 4.3 The remaining CHECKs

```
CONSTRAINT refunds_consumed_ck CHECK (source_amount_consumed_minor <= source_remaining_before_minor)
CONSTRAINT refunds_realized_ck CHECK (realized_fx_gain_loss_minor = source_carrying_base_released_minor - disbursement_base_amount_minor)
CONSTRAINT refunds_dust_ck     CHECK (source_dust_base_minor = source_carrying_base_released_minor
                                       - round_half_even_minor(source_amount_consumed_minor, source_to_base_rate))   -- see §4.6
CONSTRAINT refunds_same_currency_ck
  CHECK (disbursement_currency <> source_currency OR disbursement_amount_minor = source_amount_consumed_minor)
CONSTRAINT refunds_rate_ck CHECK ((rate_source = 'base') = (fx_rate_id IS NULL AND disbursement_to_base_rate = 1))
CONSTRAINT refunds_binding_identity_ck CHECK (binding_source_id = id)
```

`refunds_consumed_ck` is the row-level half of the cap. **It is not the cap.** It refuses a row
that consumes more than the level it declares; the cap is the check that the level IS the
source's locked remaining, and only `FOR UPDATE` plus the chain verifier can establish that.

### 4.4 Foreign keys

```
refunds_tenant_fk    FOREIGN KEY (tenant_id, business_id)                        → businesses (tenant_id, id)
refunds_branch_fk    FOREIGN KEY (business_id, branch_id)                        → branches (business_id, id)                           ON DELETE RESTRICT
refunds_customer_fk  FOREIGN KEY (business_id, customer_id)                      → customers (business_id, id)                          ON DELETE RESTRICT
refunds_note_fk      FOREIGN KEY (business_id, credit_note_id, customer_id, source_currency)
                                                                                 → credit_notes (business_id, id, customer_id, currency)      ON DELETE RESTRICT  -- credit_notes_customer_currency_uq
refunds_credit_fk    FOREIGN KEY (business_id, customer_credit_id, customer_id, source_currency)
                                                                                 → customer_credits (business_id, id, customer_id, currency_code) ON DELETE RESTRICT
refunds_method_fk    FOREIGN KEY (business_id, payment_method_id, posting_account_id)
                                                                                 → payment_methods (business_id, id, posting_account_id) ON DELETE RESTRICT
refunds_disb_currency_fk FOREIGN KEY (disbursement_currency)                     → currencies (code)
refunds_source_currency_fk FOREIGN KEY (source_currency)                         → currencies (code)
refunds_fx_rate_fk   FOREIGN KEY (business_id, fx_rate_id)                       → accounting_fx_rates (business_id, id)                ON DELETE RESTRICT
refunds_binding_fk   FOREIGN KEY (business_id, accounting_source_type, binding_source_id)
                                                                                 → accounting_source_bindings (business_id, source_type, source_id) DEFERRABLE INITIALLY DEFERRED
```

**Both source edges are three-column and both include `customer_id`.** That is what makes
`customer_refund.customer_mismatch` structural: a refund cannot draw on another customer's note
or credit, because the triple has no target. Each edge's source column is nullable, so by SQL's
MATCH SIMPLE rule the edge is simply not checked when that source is NULL — which is exactly
the behaviour wanted, and it is the reason the XOR `CHECK` is necessary beside them rather than
implied by them.

**The `customer_credits` edge is FOUR columns and that is measured, not stylistic.**
`customer_credits_customer_uq` is `UNIQUE (business_id, id, customer_id, currency_code)`
(`0081:403`) — four columns, carrying the currency. So the refund's edge must name
`source_currency` as its fourth, and that is strictly better than a three-column one: it makes
a refund that states the wrong source currency structurally impossible rather than merely
refused by a routine, and it removes the need for any new constraint on `customer_credits`.
`credit_notes` is S5's own relation and carries the matching
`credit_notes_customer_uq UNIQUE (business_id, id, customer_id)` from §3.2; whether the note
edge should carry the currency too is answered the same way — it should, and the spec's
`credit_notes_customer_uq` is widened to
`UNIQUE (business_id, id, customer_id, currency)` with `refunds_note_fk` naming
`source_currency` as its fourth column, so the two sources are treated identically.

**`refunds` carries NO foreign key to `journal_entries`, to `payment_allocations` or to any
invoice relation.** The only accounting edge is the composite bridge.

### 4.5 Indexes

```
refunds_note_idx     ON refunds (business_id, credit_note_id)     WHERE credit_note_id IS NOT NULL
refunds_credit_idx   ON refunds (business_id, customer_credit_id) WHERE customer_credit_id IS NOT NULL
refunds_customer_idx ON refunds (business_id, customer_id, refund_date DESC, id DESC)
refunds_method_idx   ON refunds (business_id, payment_method_id)
```

The first two are what the widened chain verifier reads to find a source's refund consumers,
and they are partial for the same reason the unique indexes are: half the rows hold NULL and
have no business in the other source's index.

### 4.6 One arithmetic helper this specification needs, and does not invent

`refunds_dust_ck` as written calls `round_half_even_minor(amount, rate)`, which **does not
exist under that name in this tree.** The live `IMMUTABLE` scalar primitives are
`supplier_convert_base` (`0067:671`), `supplier_ap_release` (`0067:683`) and
`supplier_credit_remaining_carrying` (`0067:696`). The lawful spelling of the constraint is
therefore in terms of `supplier_convert_base`, and if the exponent arguments it takes make it
unusable inside a row `CHECK`, **the dust identity moves to the deferred validator of §5.5 and
the `CHECK` is dropped — it is not replaced by a new rounding function.** Which of the two it
is must be measured against the sealed signatures, and it is recorded here as an open point of
this specification rather than guessed.

---

## 4A. What this specification does NOT create: any reversal relation

**S5 ships NO reversal relation.** `payment_reversals` and `allocation_reversals` belong to
P4-S6, with `void_invoice` and TD-15's supplier twin, and `docs/PHASE_4_EXECUTION_PLAN.md`'s
`### P4-S6` section assigns them there. Neither name appears anywhere in this specification as a
relation to create.

Nor does the refund path depend on one existing. A refund **lawfully discharges a liability that
was correctly recorded**; a reversal unwinds an entry that should not have been made. They are
different operations on different facts, and `refunds` has no edge, column or routine that
references a reversal. The contract pack records this as predecessor assumption **A-21** —
"S5 needs nothing from S6" — stated so a diff against S6's sealed tree can refute it if the
reading turns out to be wrong.

Measured, and consistent with that reading: there is **no `allocation_reversal` row in
`accounting_source_types` anywhere in the live tree** (§5.2.0's enumeration), while
`FINANCIAL_CORE` (`scripts/phase4-s1-gate.ts:504-505`) already names `payment_reversals` and
`allocation_reversals` as relations. So the names are reserved by a law and unregistered by the
registry — exactly the state of a slice that has not been built yet, and not S5's to change.

---

## 5. Routines — what S5 asks for, and what it may not do

### 5.1 It edits nothing frozen

`0081` is an S4 CANDIDATE today and becomes frozen on acceptance. **A `CREATE OR REPLACE` of a
routine shipped by a frozen migration is done in a NEW migration, never by editing the frozen
file.** Every item below is a `CREATE OR REPLACE` in the S5 migration, written by the one
migration owner.

### 5.2 Source types — measured before anything is minted

See `docs/patch-requests/PATCH-REQ-S5-002.md` §5.2.0 for the full enumeration. In short, read at
`6587460`: the live registry holds **seventeen** types and **none is a credit note, a customer
return or a customer refund**, so binding to an existing identity is not available and minting is
forced. The three S5 types are **`customer_return`** (named after the EVENT, following
`supplier_credit_notes`' binding to `supplier_return` at `0065:199`, where no
`supplier_credit_note` type was ever minted), `customer_credit_note_application` and
`customer_refund`, at `sort_order` 18, 19 and 20. No reversal type is minted.

### 5.3 The four replacements S5 owes

| routine | `file:line` | the change, and nothing more |
|---|---|---|
| `customer_credit_guard()` | `0081:1070` | widen the backing set of the UPDATE branch from `customer_credit_applications` alone to the UNION `{customer_credit_applications, refunds}`, keeping `count(*) = 1` OVER THE UNION — not `>= 1`, and not one count per relation. Two backing rows for one decrement is the double consumption this guard exists to refuse. Everything else unchanged: DELETE impossible (`:1074-1076`), INSERT only from the command's own transaction and born whole (`:1077-1088`), column-for-column immutable except the remaining PAIR, the pair moving only DOWN and only to the exact `supplier_credit_remaining_carrying` value |
| `customer_credit_consume(UUID,BIGINT,BIGINT)` | `0081:1224` | add `customer.refund` to the asserted operation array at `:1230`, and widen the backing-row existence at `:1232-1235` to the same union. Preserve: internal-owned `SECURITY DEFINER`, `REVOKE ALL … FROM PUBLIC` (`:1263`), owner `daftar_inventory_internal` (`:1306`), pinned `search_path` (`:1225`), the assertion re-read as the FIRST statement with arguments that call nothing, the optimistic `UPDATE … WHERE remaining_amount_minor = p_remaining_before` with `GET DIAGNOSTICS` and the `v_rows <> 1` refusal (`:1239-1250`), and the new carrying computed by `supplier_credit_remaining_carrying` from the ORIGINAL pair |
| `customer_credit_verify(UUID,UUID)` | `0081:879` | ONE `UNION ALL` branch inside the `consumers` CTE (`:893-897`), mapping the refund's three columns onto `rb`/`amount`/`rel`. `0081:877-878` says so in its own words: "with S4's one consumer relation; S5's refund adds one UNION ALL branch". Nothing else changes: the `rb DESC, amount` ordering with the `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING` window (`:900`), every element of the chain law (`:903-918`), still `SECURITY DEFINER`, still internal-owned, still `REVOKE ALL … FROM PUBLIC` |
| `accounting_reversals_20_domain_source_guard()` | `0081:1405` | add the three S5 source types to the `source_type IN (…)` list at `0081:1412`. `P4-AL-47` and seam `S-P4-02` (`scripts/phase4-s1-gate.ts:1483-1495`) require a registration and this list to move TOGETHER; until it does, `daftar_app` can reverse an S5 entry through the generic path. Note the surrounding `SET LOCAL ROLE daftar_accounting_internal` / `RESET ROLE` (`0081:1403`, `:1437`) — the replacement runs in the same authority |

### 5.4 `invoice_outstanding` — BOTH overloads, and the trap

Creating `credit_note_applications` or `credit_notes` turns seam `S-P4-03`
(`scripts/phase4-s1-gate.ts:1497`) **RED** until `invoice_outstanding` reads the new relation
BY NAME: both are in `INVOICE_REDUCER_VOCABULARY` (`:1237`). `0081:1326-1333` records that the
subtraction is a `UNION ALL` over a SET of reducer relations precisely so that "P4-S5 appends
one branch rather than rewriting it", and that `invoice_settlement_state`,
`customer_ar_outstanding` and `customer_ar_aging` need **no change at all** because they
compose over this one.

**The trap, measured: `phase4RoutineBody` (`scripts/phase4-s1-gate.ts:1181-1197`) returns the
LAST definition matching the NAME, ignoring the signature.** `invoice_outstanding` has two
overloads and four definitions across `0081`/`0083`/`0084`, so the body the law actually reads
is the `UUID[]` set-based overload at `0084:593`. Two consequences, in both directions:

- the seam stays RED if S5 teaches only the scalar overload (`0084:526`). **The array overload
  must read the new reducers too**, and both overloads must stay equivalent — the S4 set-based
  equivalence suite is the standard;
- the refund law (`TL-P4-S5-R1`, `invoiceReducerProblems`, `:1304`) inspects only that one
  overload. A refund subtraction planted into the scalar overload alone would be **MISSED**.
  **S5's own acceptance must state this**, and closing the hole — reading EVERY definition
  rather than the last — is a change to a permanent module and therefore a Tech Lead item, not
  a silent edit. Another agent is fixing exactly that right now, so this specification is
  written on the assumption that every definition will be read, and is correct either way:
  teaching both overloads satisfies both the current and the fixed reader.

### 5.5 The new routines, and who may execute them

Three commands, each an internal-owned `SECURITY DEFINER` with a pinned `search_path` and
`REVOKE ALL … FROM PUBLIC`, following `0081`'s shape exactly:

```
customer_issue_credit_note(...)  owner daftar_inventory_internal
customer_void_credit_note(...)   owner daftar_inventory_internal
customer_refund_pay(...)         owner daftar_inventory_internal
```

Plus **one deferred completeness validator PER REGISTERED SOURCE TYPE — three, not two** —
because `TL-P4-S1-R1` says "an accounting source type with no writer, no binding, no expected
journal shape and no deferred completeness validator is a dead concept", and S5 registers
three types (§5.2): `customer_return`, `customer_credit_note_application` and
`customer_refund`:

```
accounting_customer_return_entry_complete(...)
accounting_customer_credit_note_application_entry_complete(...)
accounting_customer_refund_entry_complete(...)
```

Each compares `array_agg(... ORDER BY ...)` on both sides, so it pins a SORTED MULTISET and is
order-insensitive, the `0081:1594` shape.

**The `customer_return` validator's expected shape — the note's OWN entry:**

```
Dr sales_returns (4100)                 the note's total, at the note's ONE conversion
   Cr customer_refund_liability (2200)  the same total, the same base
```

and, separately, the COGS reversal at its own grain:

```
Dr inventory (1200)   Σ stock_movements.value_delta_base_minor, exactly
   Cr cogs (5000)
```

**This validator asserts the ABSENCE of a line on `accounts_receivable` (1100), by name**, for
the same reason the refund validator does. Issuing a credit note raises a liability for the
whole total and reduces no receivable; whether any of it is then set against an invoice is a
`credit_note_applications` row and nothing else. Two places that could reduce AR would be two
answers to "by how much", and — because the note's snapshot and the invoice's differ — two
DIFFERENT answers: 3 633 at a note issued at 1.0901 against 3 617 at an invoice born at
1.0853, on the same 3 333 applied. The 16 is realized FX, not revenue, and only the invoice's
own stored pair can say so.

**The `customer_credit_note_application` validator's expected shape — the ONE AR reducer:**

```
Dr customer_refund_liability (2200)   c, at conv_Rn(c)
   ± the note dust, on the SAME liability account, never on 6100
   Cr accounts_receivable (1100)      a, at conv_R(a) — the INVOICE's snapshot
   ± the AR dust, on `accounts_receivable` itself, never on 6100
   ± realized FX = cr_rel − rel — Cr 4900 on a gain, Dr 6900 on a loss
```

This is `accounting_customer_credit_application_entry_complete`'s shape (`0081:1594`) with
`customer_credit_liability` (2210) read as `customer_refund_liability` (2200), which is the
structural statement of the application plan's delegation: one AR algorithm, one account
substituted. The validator must therefore pin `credit_carrying_base_released_minor` and
`invoice_carrying_base_released_minor` as the two carrying operands and `realized_fx_gain_loss_minor`
as their difference — the same three columns `credit_note_applications_realized_ck` (§3.1)
constrains inside the row, asserted here against the ENTRY so a row that satisfies its own
CHECK but posts something else cannot commit.

**The refund validator's expected shape, stated so the validator cannot be written loosely:**

```
Dr customer_refund_liability (2200)   | source kind = credit_note
Dr customer_credit_liability (2210)   | source kind = customer_credit
   ± the source dust, on the SAME liability account, never on 6100
   Cr <posting account>
   ± realized FX — Cr 4900 on a gain, Dr 6900 on a loss
```

and **the validator asserts the ABSENCE of a line on `accounts_receivable` (1100), by name.**
That is `TL-P4-S5-R1` enforced in the ledger and not only in the application, and it is the
assertion that makes the whole slice's claim checkable from the database alone.

### 5.6 Triggers

```
credit_notes_guard            BEFORE INSERT OR UPDATE OR DELETE ON credit_notes
credit_note_items_guard       BEFORE INSERT OR UPDATE OR DELETE ON credit_note_items
credit_note_applications_guard BEFORE INSERT OR UPDATE OR DELETE ON credit_note_applications
refunds_guard                 BEFORE INSERT OR UPDATE OR DELETE ON refunds
credit_notes_verify           CONSTRAINT TRIGGER AFTER INSERT OR UPDATE ON credit_notes DEFERRABLE INITIALLY DEFERRED
refunds_verify                CONSTRAINT TRIGGER AFTER INSERT ON refunds DEFERRABLE INITIALLY DEFERRED
```

The `*_guard` family is `customer_credit_guard`'s shape: DELETE impossible, INSERT only from
the command's own transaction (`business_transaction_id = inventory_business_transaction_id()`)
and born whole, UPDATE impossible except — on `credit_notes` alone — the remaining PAIR moving
down by one backed consumption. **`refunds` admits NO UPDATE at all**: a refund that happened
is a fact, and a correction is a new document (P4-AL-46).

The two `CONSTRAINT TRIGGER`s call the verifiers at COMMIT. They are added to the Phase 4
position-scoped set, not the Phase 3 one:
`tests/security/phase3-s8-set-constraints-sweep.test.ts:32-48` scopes its catalogue equality
BY POSITION to triggers on relations the inherited prefix created, explicitly so a later
phase's deferred guard cannot turn it red — so nothing there is owed.

---

## 6. RLS, grants and the read path

### 6.1 RLS — all four relations, both halves

Every relation gets, without exception:

```
ALTER TABLE <rel> ENABLE  ROW LEVEL SECURITY;
ALTER TABLE <rel> FORCE   ROW LEVEL SECURITY;
```

`ENABLE` and `FORCE` are **each** required and discovered independently
(`scripts/guards/phase4-rls-force.ts:364`, `:386`, `:417`), and a relation declared on disk but
absent from the catalogue — or in the catalogue and not declared — is reported by name
(`:457-465`). Every relation carries `tenant_id` and `business_id`, which the same discovery
requires.

Policies follow the `0063` R-35 layering that `0067:520-540` and `0081` both use:

- a PERMISSIVE tenant policy through the `businesses` subquery;
- a RESTRICTIVE business isolation, **one policy per command**, where only the `FOR SELECT`
  one admits the internal principals;
- permissive `FOR SELECT` admissions for the principals whose guards read these rows —
  `daftar_inventory_internal` and `daftar_accounting_internal`.

`0086` moved Phase 4 to quals-evaluated-once-per-query; the new policies are written in that
shape and `tests/security/p4s4-rls-quals-once-per-query.test.ts` is the standard.

`TL-P4-RLS-INT-01` (`docs/PHASE_4_DECISION_REGISTER.md:777`): the cross-tenant read of the two
internal roles is **INTENTIONAL**, no migration narrows it, frozen `0052` is not modified, and
nothing is recorded as tenant-narrowing debt. S5's definers inherit this. The question that
replaces it is whether an ORDINARY RUNTIME CREDENTIAL can reach cross-tenant data or effect
THROUGH that authority, and the four-way matrix at `:824-831` may never be collapsed into one
statement.

### 6.2 Grants — `daftar_app` holds `SELECT` and nothing else

```
REVOKE ALL ON <rel> FROM PUBLIC;
GRANT SELECT ON <rel> TO daftar_app;
```

The `0081:615` shape. `forbiddenPrivileges`
(`tests/security/phase3-s8-grant-matrix.test.ts:85`, asserted `:361`) is UNSCOPED and judges
Phase 4's tables: `DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE` must not be reachable
by a runtime principal or by PUBLIC. `deviations()` (`:228`) requires every live ACL grant to be
a REVIEWED one, so each grant above goes into the reviewed matrix in the same change, and
`beyondPhase3Tables()` enters these four automatically.

### 6.3 The read path — one function, one projection

```
customer_credit_notes_page(p_business_id UUID, p_customer_id UUID, p_cursor ..., p_limit INT)
customer_refunds_page(p_business_id UUID, p_customer_id UUID, p_cursor ..., p_limit INT)
```

Keyset, `(date DESC, id DESC)`, the `customer_open_invoices_page` (`0084:795`) shape, and a
derived figure read through a FUNCTION in a `FROM` is the CORRECT read path (P4-AL-07,
`tests/guards/phase4-read-surface-guard.test.ts:162`). An empty page is `200 []` and never a
refusal.

**The reader is the same gate and the same projection as the write** — not a second permission
list, not a second row shape. Its refusal set is NOT the write's: it refuses on absence and on
authority and inherits no `*_inconsistent`, `*_immutable` or `registry_incomplete`.

---

## 7. Expected catalogue shape, as an end-state block

The migration ends with a `DO $$` block that reads the catalogue and refuses a mismatch — the
`0081:2661-2673` device, which asserts its three level constraints exist from the live
catalogue rather than trusting that the `CREATE TABLE` ran. S5's block asserts:

1. the four relations exist, each with `relrowsecurity` AND `relforcerowsecurity` true;
2. every `tax_minor` column on the two relations that have one is `bigint`, `NOT NULL`, and
   carries a single-column `CHECK (<col> = 0)` — the `od03Problems` shape, read from
   `pg_constraint`;
3. all four level devices exist by name: `credit_note_applications_level_uq`,
   `credit_note_applications_invoice_level_uq`, `refunds_note_level_uq`,
   `refunds_credit_level_uq` — and the last two are PARTIAL, with their predicates read from
   `pg_index.indpred` so a non-partial (and therefore vacuous) replacement is refused;
4. `refunds_one_source_ck` exists and `num_nonnulls` appears in its `consrc`;
5. no column on any of the four matches `AP_BALANCE_COLUMN` or `DERIVED_COST_COLUMN`;
6. the three S5 source types are registered in `accounting_source_types`, each with a
   `lower_bound_policy` and each named by
   `accounting_reversals_20_domain_source_guard`'s replaced body;
7. `daftar_app` holds exactly `SELECT` on all four and PUBLIC holds nothing;
8. the three operation kinds are registered in `inventory_operation_kinds`.

---

## 8. Upgrade expectations

- **Forward only.** No `DROP`, no `ALTER … RENAME`, no column type change on any existing
  relation. The four relations are new; `credit_notes` gains
  `credit_notes_customer_uq` in its own creating statement, not by a later `ALTER`.
- **No backfill.** There is no existing data to migrate: all four relations are new and empty.
  No `UPDATE` over an existing Phase 4 relation appears in the migration.
- **The four `CREATE OR REPLACE`s of §5.3 are the only writes to existing objects**, and each
  replaces a routine's body without changing its signature — so no dependent view, trigger or
  grant is invalidated, and `REVOKE ALL … FROM PUBLIC` is re-issued after each replace because
  `CREATE OR REPLACE` resets a function's ACL to the default.
- **`frozenThrough` only advances.** `scripts/phase4-s1-gate.ts:1754-1759` refuses any
  `frozenThrough` equality as a shape; the floor never retreats.
- **`db-from-zero` must pass** (`npm run check:db-from-zero`): the migration is replayable from
  an empty cluster, and the end-state block of §7 is what proves it did what it claimed.
- **The gate that judges this migration on landing is S4's.**
  `newRelationCoverageProblems` (`scripts/phase4-s4-gate.ts:910`, `:244`) reads
  `candidateMigrations`, which after S4 seals names S5's file. So S5's first migration is
  judged by S4's gate, and nothing in it may be shaped to a standard S4's gate does not hold.

---

## 9. What this specification does NOT decide

- **the migration prefix.** Unknown until S4 seals. Never `0087` or any other guess;
- **`OD-03`.** OPEN, and the owner's alone. No rate, no jurisdiction, no exemption, no
  threshold, no legal invoice field, no non-zero tax path. Only the structural zero;
- **the source-type SPELLING, finally.** `customer_return`,
  `customer_credit_note_application` and `customer_refund` follow the LIVE registry's
  convention (`0081:2468-2472`, pinned as RULED at `scripts/phase4-s4-gate.ts:577`) rather
  than `P4-AL-20`'s stale bare `credit_note` / `refund`. **Whichever spelling the Tech Lead
  rules, the lock's enumeration is not the authority** — and `P4-AL-20` says six where the
  live registry already holds five of a different shape plus one it never enumerated;
- **the dust `CHECK` of §4.6**, which depends on a signature that must be measured against the
  sealed tree;
- **whether `cogs_reversal_base_minor` survives `DERIVED_COST_COLUMN`** (§2), which must be
  re-measured at promotion.
