# PATCH-REQ-S5-003 — widen the three customer-credit routines, and both `invoice_outstanding` overloads

| field | value |
|---|---|
| requested by | P4-S5 owner |
| base of record | `phase/4-sales-pos-customers-receivables` @ `6587460` |
| target | the S5 migration (prefix UNKNOWN until S4 seals), written by the ONE migration owner. **No frozen file is edited** |
| owner of target | the single migration owner |
| depends on | S4 sealing (`0081`, `0083`, `0084` are S4 candidates today) AND `PATCH-REQ-S5-001` (the `customer.refund` op code) |
| blocks | every runtime behaviour of S5. Without it a lawful refund is REFUSED three times and `S-P4-03` stays RED |

## Required change — five `CREATE OR REPLACE`s, each in a NEW migration

### (a) `customer_credit_guard()` — `0081:1070` — refuses FIRST

The `BEFORE INSERT OR UPDATE OR DELETE` trigger function on `customer_credits` (trigger at
`0081:1285-1287`). Its UPDATE branch survives only through the shape at `0081:1090-1117`, whose
last condition is that a backing row already exists:

```
1107:     SELECT count(*) INTO v_n
1108:     FROM customer_credit_applications a
1109:      WHERE a.business_id = OLD.business_id AND a.credit_id = OLD.id
1110:        AND a.credit_remaining_before_minor = OLD.remaining_amount_minor
1111:        AND a.credit_amount_consumed_minor = OLD.remaining_amount_minor - NEW.remaining_amount_minor
1114:     IF v_n = 1 THEN RETURN NEW; END IF;
1118:   RAISE EXCEPTION 'customer_credit.immutable: …'
```

A refund drawn on a customer credit writes **no `customer_credit_applications` row** — by
`TL-P4-S5-R1` it names no invoice and is not an invoice reducer — so `v_n = 0` and `:1118`
refuses, at statement time, before either other routine is reached.

**The change:** widen the backing set from one relation to the UNION
`{customer_credit_applications, refunds}`, keeping **`count(*) = 1` OVER THE UNION** — not
`>= 1`, and not one count per relation. Two backing rows for one decrement is the double
consumption this guard exists to refuse.

**Preserve, unchanged:** DELETE impossible (`:1074-1076`); INSERT only from the command's own
transaction and born whole (`:1077-1088`); UPDATE column-for-column immutable except the
remaining PAIR; the pair moving only DOWN and only to the exact
`supplier_credit_remaining_carrying` value of the new remaining; owner line `0081:1303`.

### (b) `customer_credit_consume(UUID, BIGINT, BIGINT)` — `0081:1224` — refuses TWICE

```
1230:   v_actor := inventory_assertion_current(ARRAY['customer.apply_credit']);
1231:   IF … OR NOT EXISTS (SELECT 1 FROM customer_credit_applications a …) THEN
1236:     RAISE EXCEPTION 'inventory.source_type_not_authorized: …'
```

Two independent refusals: the **operation assertion** at `:1230` admits only
`customer.apply_credit`, so a `customer.refund`-asserted transaction is refused there; and the
**backing-row existence** at `:1232-1235` is again over `customer_credit_applications` alone.

**The change:** add `customer.refund` to the asserted array, and widen the existence check to
the same union as (a).

**Preserve, unchanged:** it is the R-90 ONE writer of the remaining pair — internal-owned
`SECURITY DEFINER`, `REVOKE ALL … FROM PUBLIC` (`0081:1263`), owner `daftar_inventory_internal`
(`0081:1306`), pinned `search_path` (`:1225`); its FIRST statement is the assertion re-read
whose arguments call nothing (`:1230`); the optimistic
`UPDATE … WHERE c.remaining_amount_minor = p_remaining_before` with `GET DIAGNOSTICS` and the
`v_rows <> 1` refusal (`:1239-1250`); and the new remaining carrying computed by
`supplier_credit_remaining_carrying` from the ORIGINAL pair, never from an already-rounded
value. **It must not relax the single-row or single-level conditions.**

### (c) `customer_credit_verify(UUID, UUID)` — `0081:879` — refuses at COMMIT

Its `consumers` CTE reads ONE relation (`0081:893-897`) and refuses when the chain does not
reconcile to the stored pair (`:912-918`). A refund that consumed credit leaves
`remaining = original − Σ(applications) − refund` while `v_sum` counts applications only, so
`:913` is false and `:918` raises.

**`0081:877-878` already says so in its own comment:** *"with S4's one consumer relation; S5's
refund adds one UNION ALL branch."*

**The change:** exactly that — ONE `UNION ALL` branch inside `consumers`, mapping the refund's
three columns onto `rb` / `amount` / `rel`, **and nothing else**.

**Preserve, unchanged:** the `rb DESC, amount` ordering with the
`ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING` window (`:900`); `rb = original − Σ earlier`;
`amount <= rb`; each `rel` equal to the difference of two `supplier_credit_remaining_carrying`
calls (`:903-908`); `Σ amount <= original`; the stored remaining `= original − Σ amount`; the
stored carrying `= g(stored remaining)` and never `g` of a previous rounded step; and
`Σ rel = original_carrying − remaining_carrying`. Still `SECURITY DEFINER`, still internal-owned
(`0081:1298`), still `REVOKE ALL … FROM PUBLIC` (`0081:1255`).

### (d) and (e) `invoice_outstanding` — **BOTH** overloads, `0084:526` and `0084:593`

Creating `credit_notes` or `credit_note_applications` turns seam `S-P4-03`
(`scripts/phase4-s1-gate.ts:1497`) **RED** until `invoice_outstanding` reads the new relation
BY NAME: both are in `INVOICE_REDUCER_VOCABULARY` (`:1237`). `0081:1326-1333` records that the
subtraction is a `UNION ALL` over a SET of reducer relations precisely so that *"P4-S5 appends
one branch rather than rewriting it"*, and that `invoice_settlement_state`,
`customer_ar_outstanding` and `customer_ar_aging` need **no change at all** because they
compose over this one.

**The trap, measured and load-bearing.** `phase4RoutineBody`
(`scripts/phase4-s1-gate.ts:1181-1197`) resolves a routine by NAME and returns the **LAST**
definition, ignoring the signature. `invoice_outstanding` has two overloads and four
definitions across `0081`/`0083`/`0084`, so the body the law reads is the `UUID[]` set-based
overload at `0084:593`. Therefore:

- **the array overload must read the new reducers**, or `S-P4-03` stays RED however well the
  scalar one is taught;
- **the scalar overload must read them too**, or the two overloads disagree and the S4
  set-based equivalence suite goes red;
- and the refund law (`invoiceReducerProblems`, `:1304`) inspects only that one overload, so a
  refund subtraction planted into the scalar overload alone would be **MISSED**. That hole is
  recorded in `PATCH-REQ-S5-007` and is not this patch's to close.

## Reason

Without (a)–(c) a lawful refund on a customer credit is refused three times, in three different
places, by three routines that are all correct about S4's world. Without (d)–(e) the slice
cannot land green at all.

## Dependency

`0081`, `0083` and `0084` are S4 CANDIDATES at `6587460`. They become frozen on acceptance, and
a `CREATE OR REPLACE` of a routine a frozen migration shipped is done in a NEW migration, never
by editing the frozen file. **So this patch cannot be written before S4 seals, and S5 owns no
migration number — the single migration owner writes it.**

## The tests that require it

- `tests/guards/p4s5-refund-cap-concurrency-models.test.ts`, race 2's red proof, shows the
  consequence of (c) directly: it drops the refund from the consumer set — *exactly* what
  `customer_credit_verify` does today — and the verifier then refuses a correct, lawful state;
- `tests/guards/p4s5-refund-plan-red-proofs.test.ts`, §12, drives the TypeScript twin
  (`verifySourceConsumptionChain`) over the UNION and shows it refusing an overlap and a
  disagreeing remaining;
- the owed financial test (`docs/PHASE_4_DECISION_REGISTER.md:267-285`), at level G: open a
  credit invoice, make the credit-note effect, verify AR falls exactly once, refund the
  resulting liability, verify the invoice outstanding does NOT fall again, verify cash and the
  liability DO move. Every write through the product's own commands — no row inserted by hand;
- the red proof (a) owes: a direct `UPDATE customer_credits SET remaining_amount_minor = …`
  with TWO backing rows must be refused, proving the widened count is `= 1` over the union and
  not `>= 1`.

## Expected semantic diff

- `customer_credit_guard` admits one further shape of lawful decrement and no more: the one
  backed by exactly one refund row at the matching level and amount;
- `customer_credit_consume` admits one further asserted operation and no more;
- `customer_credit_verify`'s `consumers` gains one branch; for a credit with no refunds its
  result is byte-identical to today's, which is the regression claim the patch must prove;
- `invoice_outstanding` subtracts applied credit notes; for an invoice with none its result is
  unchanged, and both overloads remain equivalent.

## What this patch must NOT do

- it must not relax the single-row or single-level conditions anywhere;
- it must not make `invoice_outstanding` read `refunds`. That is the explicitly refused way of
  making the gate green (`docs/PHASE_4_DECISION_REGISTER.md:287-293`), along with adding a
  comment, adding a dead SQL reference, renaming `refunds` to escape the vocabulary, and
  special-casing a test;
- it must not edit `0081`, `0083` or `0084`.
