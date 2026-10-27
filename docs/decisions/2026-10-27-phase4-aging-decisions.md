# Phase 4 receivables-aging decisions — 2026-10-27

Owner decisions DR-27, DR-28, DR-29 and DR-30, and the Phase 4 **seal scope**
decision (option "ج").

This file is the TRACKED record (DR-24). `.local-context/` holds working notes
and does not travel with a clone of this repository; these decisions govern code
that computes money a merchant invoices a customer for, so the record lives
beside the code. **Every comment in the tree that cites one of these decisions
cites this file.**

> `docs/decisions/` also exists on the `main`-line branch
> `ci/ci-runner-01-self-hosted`, holding
> `docs/decisions/2026-10-27-ci-self-hosted-runner.md` — a DIFFERENT filename
> (measured with `git ls-tree -r --name-only ci/ci-runner-01-self-hosted -- docs/decisions`).
> The two branches therefore add files to the same directory and the directory
> merges without conflict.

---

## DR-27 — a customer credit balance is not auto-allocated

**Decides.** A credit balance arising from an overpayment stays in **its own
document's aging band**, placed by that document's date, as a **visible negative
value** — the way a standard accounting aging report presents it. The overall net
remains exactly what DR-23 requires. Any application of that credit against
other invoices happens **only by an explicit act of the merchant**, is recorded
as an **allocation entry**, and belongs to a `PAY-ALLOC` card **after the seal**.
A test must pin that bucketing does not move where the credit appears.

**Does not decide.** How the merchant-initiated allocation is modelled — its
command, its permission, its journal shape. That is `PAY-ALLOC`'s subject. It
also does not decide whether a customer whose receivables net to exactly zero is
PRESENT in a list at all: that is **S-16**, still open, because
`customer_ar_outstanding` ends in `HAVING sum(...) <> 0` and returns no row for
such a customer while `customer_ar_aging` carries no such `HAVING` and shows two
offsetting bands. The totals agree; the presence does not.

**Closes S-18 consequentially.** DR-27's words "a visible negative value, the way
a standard accounting aging report presents it" are the answer to S-18: the
negative value inside the band is sufficient, and a band whose total is negative
is an acceptable presentation. No separate display line is required.

---

## DR-28 — `days_past_due` is measured from `coalesce(due_date, issue_date)`

**Decides.** In **every interface and every reader**,

```
days_past_due = as_of − coalesce(due_date, issue_date)
```

consistent with DR-13 and DR-21. **`NULL` is forbidden for an invoice that is
due.** A **separate** field `has_explicit_due_date` carries the display fact so
the merchant can still be shown "no stated due date" — it is `due_date IS NOT
NULL` and nothing else, so an age of zero or a negative age is never mistaken
for a missing term.

**Why it exists, measured.** `apps/api/src/modules/selling/customer-reads.ts`
read `CASE WHEN o.due_date IS NULL THEN NULL ELSE ($3::date - o.due_date) END AS
days_past_due`, so a termless invoice showed a dash on the open-invoices page
while `customer_ar_aging` — which has banded on `coalesce(o.due_date,
o.issue_date)` since DR-13 — already placed it in the over-90 band. **The page
hid the age the report asserted, and the merchant acts on the page.**

**The substitution is signed.** `invoices.issue_date` is `DATE NOT NULL`
(`0075`) and `invoices_due_date_ck` enforces
`due_date IS NULL OR due_date >= issue_date` (`0075:317`). So falling back to
the issue date can only report an invoice as the same age or **older**, never
younger. For a receivable that is the safe direction: the error, if any, is
toward noticing a debt rather than toward losing one. The same two facts make
`NULL` **unreachable** rather than merely unlikely — neither arm of the
`coalesce` can be null, so the subtraction has no null operand.

**Needs no migration.** The expression is inline SQL in the reader, and both
`due_date` and `issue_date` already come off `customer_open_invoices_page`'s
`RETURNS TABLE`, so no column is added and no join is re-introduced: the single
visit R-104/R-106 bought is intact. `frozenThrough` stays `0079`.

**Contract change a client can observe.** `CustomerOpenInvoiceDto.daysPastDue`
narrows from `number | null` to `number`, and `hasExplicitDueDate: boolean` is
added. A client that rendered `null` as "—" must now render the dash from
`hasExplicitDueDate` instead; a client that only displayed the number is
unaffected except that termless invoices now show one.

**Does not decide.** Anything about the aging routine itself (DR-29 owns it),
nor `invoice_count` (also DR-29), nor the wording a client shows for
`hasExplicitDueDate` — only that the fact is available separately.

---

## DR-29 — per-bucket invoice counts are not additive

**Decides.** The invoice count of a bucket is **not summable across buckets**,
because one invoice may appear in more than one bucket (an invoice with a
part-scheduled balance legitimately contributes to two bands). The contract must
**say so explicitly**. A **separate distinct total count** is added, computed
**independently**, with a test proving it is **not necessarily equal** to the sum
of the buckets. **Any interface that adds the counts up is forbidden.**

**Does not decide.** Whether a client should display per-bucket counts at all,
or only the distinct total.

---

## DR-30 — the governing principle for an unanchored amount

**Decides.** **No debt leaves the aging report except by payment.** An amount is
aged from `coalesce(due_date, issue_date)`; a **scheduled instalment** is aged
from **its own due date**. The reading consistent with that principle is adopted
(the one implemented in `dr23_8`), and the messages of `dr23_8` and `dr23_9` are
corrected **inside the S-17 card itself**, with a **fresh double review on the
resulting SHA**.

**Does not decide.** S-17's underlying accounting question is answered only in
the direction of this principle: a credit balance with no stated term is
anchored at `coalesce(due_date, issue_date)` like every other unanchored amount.
DR-30 does not reopen whether a credit balance is "due" in the ordinary sense;
it settles which band it lands in.

---

## Seal scope — option "ج"

**Decides.** Phase 4 is sealed at **S1–S4**. **S5–S9 are declared deferred** —
not absent by oversight, not silently in scope. The **orphaned S7 artefacts
present in the tree** (the four `phase4-s7-installment-*` integration suites and
the S7 specification) are **declared orphaned** and are **not read as coverage
of slice 7**: they are registered so that something executes them, and their
registration asserts nothing about slice 7 being built.

**Does not decide.** That Phase 4 is accepted. The seal still requires a full
green CI run, the composed Phase 4 gate, and live database evidence for DR-13,
DR-14, DR-21, DR-22, DR-23 and the C-1 guard. It also does not decide when
S5–S9 are built, nor DR-01, DR-02 or DR-03 (migrations `0080`–`0086` remain
candidates and `frozenThrough` remains `0079`).

---

## Still open, and deliberately not decided here

| Item | Question | Why it is not settled by the above |
|---|---|---|
| **S-16** | Does a customer whose receivables net to zero appear in the receivables list? | A presence question, not a totals question. No conservation law catches it: the sums agree either way. |
| **S-20 / PAY-ALLOC** | The mechanics of a merchant-initiated credit allocation. | DR-27 defers it past the seal by name. |
| **DR-13-MIG** | A database migrated only as far as `0083` still carries the pre-DR-13 aging guard in live code (`0075:809`, `0083:394`); `0084` is what repairs it. | Migrations are frozen as candidates by DR-03, so the condition is recorded rather than patched. |
