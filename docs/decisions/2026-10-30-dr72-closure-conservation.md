# DR-72 (amended) — conservation of the carrying value at invoice closure

**Decision: the remainder method is withdrawn.** It was decided, and then
withdrawn on measurement, because the premise it rested on was wrong: the state
it was meant to make impossible is already impossible, and the change would have
had to be made in a routine shared with payables.

## How the premise failed

A review reported that `txn = 0` with `base <> 0` was reachable, having built it
by handing the release routine **overlapping positions** — every leg claiming
`X = 0` — which produced `Σa = T` in all 33,014 configurations and `Σrel <> B`
in 10,458 of them.

That measured the **input space of a function**, not the **state space of the
system**. Overlapping positions are not something the database will store. The
sweep was never constrained to what the schema accepts, so its result described
arguments no lawful write can produce. The permanent rule that follows from this
is recorded in §3.

## The three layers that enforce conservation, and where each one is

| # | Layer | Where | What it does |
|---|---|---|---|
| 1 | The release formula is a **telescoping difference**, not a rounded share | `supplier_ap_release`, `0067_payment_methods_supplier_settlement_sources.sql:683` | `HALF_EVEN(B·(X+a),T) − HALF_EVEN(B·X,T)`. Over a chain whose positions are the running sums, the intermediate terms cancel and the total is `HALF_EVEN(B·Σa,T)` — which at `Σa = T` is **exactly `B`**. Conservation is a property of the formula, not of rounding luck |
| 2 | **Level uniqueness**, per relation | `payment_allocations_level_uq`, `0081_phase4_customer_payments_credits.sql:334`, and `customer_credit_applications_invoice_level_uq`, `0081:474` — both `UNIQUE (business_id, invoice_id, ar_released_before_txn_minor)`; the existence of the first is itself asserted at `0081:2666` | Two reducers of the same invoice cannot both claim the same chain position. This is a **fast per-relation backstop and not the invariant** — the schema says so at `0081:327-333`: a UNIQUE index cannot see across the two relations, and they can each occupy the same level |
| 3 | The **cross-relation chain verifier** | `invoice_settlement_verify`, `0081:691`; `PERFORM`ed at `0081:1060` from `payment_allocation_value_complete` and at `0081:1212` from `customer_credit_application_value_complete`; wired as the constraint triggers `payment_allocations_value_complete` (`0081:1282`) and `customer_credit_applications_value_complete` (`0081:1291`) | Builds the chain as a `UNION ALL` over **both** reducer relations, computes each row's `before` as the running sum of the amounts ordered before it, and raises `invoice_settlement.settlement_inconsistent` on any of **three** arms: the per-row recurrence `h.x <> h.before`, a row whose `rel` is not `supplier_ap_release` of its own position, and `Σrel <> inventory_half_even(B·Σa, T, 0)` — the last being, at `Σa = T`, the conservation identity itself, checked at every `Σa` and not only at closure. **The arms are not interchangeable and the evidence distinguishes them: see §2.1** |

Measured live at head `0086`: both triggers are `deferrable=true initdeferred=true`,
so the verifier runs **at COMMIT**. Two consequences follow and both matter:

- a planted violation inside a transaction that is rolled back **never reaches
  it**, so an attempt that is not committed, or that does not force the check
  with `SET CONSTRAINTS ALL IMMEDIATE`, proves nothing. A reviewer fell into
  exactly that trap earlier and reported a false finding from it;
- no trigger calls the verifier directly — zero, against a positive control of
  185 triggers on this database — which is why it has to be found through the
  two value-complete functions rather than by looking for its name in a trigger
  list.

## Why the remainder method was the wrong instrument even if the state were real

`supplier_ap_release` is declared in `0067`, which is **below `frozenThrough`**,
and it is referenced by six migrations — including supplier settlement
(`0068`, `0072`) — and by thirteen live routine bodies. The decision spoke only
of the allocation that closes a customer invoice. Implementing a remainder
method in the shared routine would have changed **payables** arithmetic as well,
silently. If such a change is ever needed it belongs in a receivables-only
routine in a candidate migration, leaving `0067` untouched.

And the decision's second clause — a guard inside the routine raising when
`Σa = T` and `Σrel <> B` — **already exists** and is stronger than what was
asked for: layer 3 checks the identity at every `Σa`, and it is a constraint
trigger, so a routine cannot pass around it.

## §2 — the evidence, executed

**Settled.** The condition is met, and it is met by execution rather than by
reading: `tests/integration/p4s4-invoice-settlement-chain-cross-relation.test.ts`
(merged as #39). It lives under `tests/integration/`, so required CI runs it
through `test:integration` in the `backend` job against the `postgres:16`
service — the same place every other money law in this tree is executed.

It carries the two cases the decision named, and five more. Each of the five
closes a way the pair could have been believed for the wrong reason:

- **the subject exists** — the relations, their chain columns, the commands, the
  verifiers and the routes are asserted *before* anything is planted, so a
  refusal cannot be a missing subject answering in the law's place;
- **the trap** — the same violation planted and **not** forced raises nothing at
  all, and the invoice reads fully settled. Both triggers are
  `deferrable initdeferred`, so an attempt that is neither committed nor forced
  with `SET CONSTRAINTS` proves nothing. A reviewer reported a false finding
  from exactly this, which is why the case is in the suite and not in a comment;
- **attribution** — the byte-identical plant at the **lawful** chain position is
  **accepted** through the **same** forced trigger, so one integer is the whole
  difference between refusal and acceptance;
- **the refusal is not confused with its neighbours** — the file names what must
  *not* be mistaken for this law: a `FOREIGN KEY`, and the per-row trigger at
  `0081:1049-1057` which raises `customer_payment.settlement_inconsistent`.
  A test that accepted any error would have passed against all three;
- **the negative control proves its own application** — the shipped
  definition's digest is read before the replacement and after the restore, so
  "accepted" cannot be the shipped law accepting the write.

### §2.1 — which arm bit, and which one is still unexercised

This is the limit of the evidence and it is stated rather than left to be found.

The executed refusal is caught by the **chain-position** arm, `h.x <> h.before`
— the file says so in its own words: *what can see this is the per-row
recurrence*. In that write the conservation identity was **satisfied**; it is
the position that was impossible.

So the conservation arm — `Σrel <> HALF_EVEN(B·Σa, T)` — was, when this
document was first written, shown only on synthetic arguments. **DR-73 §2 ruled
that insufficient and required it exercised live, with the `B ≠ T` invoice
seeded directly in the test. That is now done, and what it found is worth more
than a pass.**

### §2.1 — the arm fires, and it is redundant; both are measured

A schema-lawful `B ≠ T` invoice is seeded directly — an FX rate, a sale and an
invoice carrying the `invoices_rate_shape_ck` triple, with `B` computed by the
shipped conversion routine rather than typed in. On it, a chain whose positions
**partition `T` exactly**, with the credit application's released base off by
**one minor unit**, is refused through the forced trigger with
`invoice_settlement.settlement_inconsistent`. The chain breaks are `[]` and
`Σa = T` is measured, so neither the recurrence nor the over-total term can be
the cause.

Attribution is not by reading. The per-row terms are **knocked out of the live
body's own text**, and the conservation term then refuses that one minor unit
**alone** while still **accepting** the lawful chain — so it is not a blanket
refuser.

**And the disclosure, which is the real finding: the arm cannot fire alone.**
`supplier_ap_release` is exactly `R(X+a) − R(X)`, so per-row-correct releases
telescope to the identity's value — measured on the seeded invoice's own figures
— and the mirror knockout shows the **per-row** term refuses the same write.
Given the recurrence, the conservation term is **redundant**. The suite says so
in a case of its own rather than letting one shared `RAISE` imply that two
independent things were proved.

That is also why the arm had never fired against a row: not an oversight, but
the consequence of a formula under which a chain that satisfies the recurrence
satisfies the identity too.

### §2.2 — what the merchant-facing path still owes

`B ≠ T` is seeded because **no command on this head can create such an
invoice**, and the suite pins that sentence. The cross-currency golden had
already reported the same limit, measuring the catalogue pin as its disclosure
and refusing to fake a fixture.

Measured here, and it narrows that golden's premise: the pin it cites is a
**creation-time** pin; an **update** pins a product's price currency to its own
prior value, not to the current base; and the routine that changes the base
currency **does not consult products at all** — its only lock is the flag
marking financial activity, its only write the base currency, with zero queries
against products. The lock is real and arms on the first posted entry, so the
window is *before any posting*, not *never*.

Whether a sale in that window can actually be **committed** is **NOT_MEASURED**,
and by DR-73 §2 it is a **follow-up card after the seal**: drive the whole
command path — change the base currency through the API, then sell — and
measure whether an invoice row with `rate_source ≠ 'base'` comes into
existence. Until then the golden's sentence is not shown false, and it is no
longer supported by the pin it cites.

## §3 — permanent rule

**A sweep over a function's input space must first be constrained to what the
database actually accepts. Otherwise its result may not be raised as a
decision.** A function will compute an answer for arguments no row can hold;
reporting that answer as a reachable state turns the schema's own guarantees
into something nobody checked. The constraint comes first, then the sweep.
