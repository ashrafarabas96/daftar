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

So the conservation arm — `Σrel <> HALF_EVEN(B·Σa, T)` — has teeth that have
been shown only **synthetically**, on hand-made arguments such as `B = 333,
T = 1000`. The suite says so itself, in a case of its own: *the cumulative
identity has teeth only where `B ≠ T`, and on this head `B = T` — stated,
measured, and not faked*. That case is recorded on the slice roster for exactly
that reason: losing it would break no measurement, it would quietly remove the
disclosure. And it is not an oversight: the project already reasoned about this
and wrote the reasoning down. `tests/golden-regression/phase4-s4/10-settlement-cross-currency.golden.test.ts`
has a section headed *one thing this head cannot reach, stated and not faked*,
which says that the AR dust is non-zero only when the invoice is in a currency
other than the base, that on this head no invoice can be, and that it therefore
**measures the pin and reports it as the disclosure** — naming the dead FX
branch it strands — and proves the dust law synthetically as a red proof rather
than faking a fixture. It states plainly that it **does not assert the gap is
correct**. That is the right way to carry a limit, and it is why the arm is
inference rather than measurement today.

### §2.2 — one measured fact that narrows that premise, and one measurement nobody has taken

The golden's premise rests on the catalogue pin at `catalog.service.ts:247-252`,
which is a **creation-time** pin. Two things measured here sit beside it:

- an **update** pins a product's price currency to **its own prior value**, not
  to the current base (`catalog.service.ts:321`); and
- **`changeBaseCurrency` does not consult products at all** — read in full at
  `tenancy.service.ts:443`, its only lock is `financial_started_at` and its only
  write is `UPDATE businesses SET base_currency`. Zero queries against
  `products` or `price_currency`.

The lock is real and does arm: `0045_accounting_post_entry.sql:817` sets
`financial_started_at = now()` on the first posted entry, and `:365-370` keeps
it from being unset. So the window is *before any posting*, not *never*. Inside
that window a product priced in `X`, a base changed to `Y`, and a first credit
sale are each ordinary operations.

**NOT_MEASURED, and therefore not asserted:** whether such a sale can actually
be committed, or whether the SQL commit path refuses a non-base currency before
an invoice row exists. `rate_source` is decided in the command function, not in
the service, and this decision did not measure it. Until it is measured, the
premise is **unproven in both directions** — the golden's sentence is not shown
false, and it is no longer supported by the pin it cites.

**The open question, for the owner, not for this document:** accept the seal
with the conservation arm resting on the formula being telescoping — which is
proved independently, and over 252,800 cases with zero counterexamples — or
open a card that (a) measures whether the commit path admits a non-base
currency, and if it does, (b) seeds a `B <> T` invoice so the third layer is
measured live and the golden's disclosure case becomes its live assertion, as
that file says it should the day a non-base price currency is admitted.

## §3 — permanent rule

**A sweep over a function's input space must first be constrained to what the
database actually accepts. Otherwise its result may not be raised as a
decision.** A function will compute an answer for arguments no row can hold;
reporting that answer as a reachable state turns the schema's own guarantees
into something nobody checked. The constraint comes first, then the sweep.
