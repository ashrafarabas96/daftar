# Phase 4 receivables-aging decisions — 2026-10-27

Owner decisions DR-27, DR-28, DR-29, DR-30, DR-31, DR-32 and DR-33, and the
Phase 4 **seal scope** decision (option "ج").

DR-27 to DR-31 are implemented in the Phase 4 lineage; **DR-32 is implemented
inside Integrations Core after the seal** and **DR-33 in its own card before
it** — both are recorded here on the day they were decided, because a decision
that governs money and lives only in working notes does not travel with a clone
(DR-24).

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
PRESENT in a list at all: that is **S-16**, since decided by **DR-33** below and
left standing here as the question DR-27 raised but did not answer, because
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

**Raised S-21, and it is answered below.** DR-28's rule is stated for "an
invoice that is DUE", and applying it to a credit-bearing row produced a
positive overdue age where there had been `null`. **DR-31** settles that: a
credit is not overdue debt.

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

## DR-31 — a credit is not overdue debt

**Decides.** Every document on the open-document list carries
**`age_days = as_of − the document's own date`**. **`days_past_due` is for DEBIT
documents only**: a credit note — **and any credit balance**, such as an
overpaid invoice (DR-23) — reports **`days_past_due = 0`** together with
**`is_credit = true`**, and an interface renders such a row as
**"رصيد دائن منذ X يومًا" / "a credit balance for X days"**, never as "متأخر" /
"overdue". The type stays **`number` with no `NULL`**, consistent with DR-28,
and **no total changes**: this decision changes what a date column reports, not
what the customer owes.

It answers **S-21**, which DR-28 raised and could not settle: after DR-28 a
credit-bearing row began reporting a positive overdue age where it had reported
`null`.

**DR-28 and DR-31 do not collide.** DR-28 governs "an invoice that is DUE" and
forbids `NULL` for it; a credit is not due *from* the customer, so DR-31 speaks
about a different population rather than carving an exception. Operationally a
debit row's `days_past_due` is produced by DR-28's expression unchanged, in the
`ELSE` arm of the new `CASE`, and every case DR-28 pinned is re-asserted as a
regression guard.

**Two implementation facts the decision depends on, and they are measured, not
assumed.**

1. **"The document's own date" is `issue_date`, NOT DR-28's
   `coalesce(due_date, issue_date)`.** DR-28's anchor answers "how late is this
   debt", and lateness is measured against a term. `age_days` answers "how old
   is this document", so it reads the date the document bears: a payment term is
   not part of a document's age, and a credit note has no meaningful term.
   Three consequences — `issue_date` is `DATE NOT NULL`, so the subtraction is
   total and **nothing is substituted, so no direction of error has to be
   signed**; the figure is what "a credit balance for X days" means; and the two
   fields stay **independent**, because an age anchored on the due date would
   equal `days_past_due` for every debit invoice with a term and invite a client
   to derive one from the other.
2. **`is_credit` is driven by the document's own KIND or the SIGN of its money,
   never by the age.** The trap is explicit: a debit invoice due exactly on the
   as-of date has `days_past_due = 0` and **is not a credit**. The kind arm is
   enumerated **positively** (`document_kind = 'credit_note'`), not as "anything
   that is not an invoice", because sweeping an unknown future *debit* kind in as
   credit would force its overdue age to zero and stop a real debt reading as
   overdue — a debt leaving the report by omission, the one failure
   DR-13/DR-21/DR-30 forbid. The opposite mistake shows a credit labelled
   overdue: visibly wrong, hiding nothing.

**A stated limit.** `invoices_document_kind_ck` (`0075`) today CHECKs
`document_kind = 'invoice'`, so **a `credit_note` row is not representable on
the published schema**: the kind arm is forward-looking and becomes live when
P4-S5 adds the kind. The arm that is live today is the **sign** arm — a credit
balance on an otherwise debit document, which reaches the page because
`customer_open_invoices_page` filters `outstanding_txn_minor <> 0`, not `> 0`.
The rule is written now because the read surface already types the column as
`'invoice' | 'credit_note'` and a client already branches on it.

**Client-visible change.** `CustomerOpenInvoiceDto` gains `ageDays: number` and
`isCredit: boolean`. A credit-bearing row's `daysPastDue` changes from a
positive figure (post-DR-28) to `0`. No amount field changes.

**Does not decide.** Anything at bucket level: the aging reader answers in
bands and reports no per-document age, so DR-31 has no second site. Nor the
exact wording a client shows, only that the fact is available separately. Nor
`invoice_count` (DR-29) nor the appearance rule (DR-33). Nor whether a credit
note should carry a `due_date` at all when P4-S5 introduces the kind.

---

## DR-32 — `units_per_day` is mandatory, and no limit means no send

**Decides.** Option (b) for **S-14**: **`units_per_day` is mandatory alongside
any other limit, per provider and per merchant.** The **absence of any limit is
a refusal** — fail-closed, `quota_limits_missing` → **409** — and a
platform-level row does not satisfy a merchant's. A **burst test** is required:
consume the **day's** quota, then a further request **is refused by the agreed
code, even though the month's quota remains**.

**Where it is implemented.** **Inside Integrations Core, after the Phase 4
seal.** It is recorded here now, and in the Integrations Core specification,
precisely so that the decision does not live only in working notes (DR-24).
Nothing in this branch implements it.

**Does not decide.** The numeric limits themselves — a default value in
production would burn the platform's money silently, so there is none. Nor the
provider set, nor the shape of the usage counter.

---

## DR-33 — one appearance rule for both receivables readers

**Decides.** Option (أ) for **S-16**, with the boundary stated exactly:

- A customer appears **in BOTH readers** for **every currency in which they hold
  any open document at all**, debit **or** credit — **even when the net is
  zero**, carrying **`net_zero = true`**.
- **No row for a currency in which there is no open document at all.** Presence
  follows the existence of an open document, not the sign or size of a balance.
- `customer_ar_outstanding` and `customer_ar_aging` are **unified on the same
  appearance rule** — today they differ, which is the defect: the outstanding
  reader ends with `HAVING sum(...) <> 0` and the aging reader has no such
  clause, so a customer whose balances offset is present in one and absent from
  the other.
- **A test proves the customer/currency sets of the two readers match.**
- An interface **may** later offer a "hide net zero" filter, **which must default
  to off**.

**Why it needs a decision at all.** No conservation law catches it: the sums
agree either way. Only presence differs, and presence is what a merchant reads.

**Does not decide.** Any figure. It is a presence rule, and every total stays
what DR-23 and DR-30 make it. It also does not decide the filter's wording or
placement, only its default.

**Where it is implemented.** Within the Phase 4 lineage, before the seal, in its
own card — test first, double review. Nothing in this branch implements it.

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
| ~~**S-16**~~ | ~~Does a customer whose receivables net to zero appear in the receivables list?~~ | **Decided by DR-33 above** (yes, in both readers, with `net_zero = true`). The implementation is a separate card; the question is closed. |
| **S-20 / PAY-ALLOC** | The mechanics of a merchant-initiated credit allocation. | DR-27 defers it past the seal by name. |
| **DR-13-MIG** | A database migrated only as far as `0083` still carries the pre-DR-13 aging guard in live code (`0075:809`, `0083:394`); `0084` is what repairs it. | Migrations are frozen as candidates by DR-03, so the condition is recorded rather than patched. |

## DR-35, DR-36, DR-37 — what the new fields oblige, and who owes it

### DR-35 — the credit's age is the document's age, and the wording must say so

`age_days` is `as_of − issue_date`, the age of the **document**. For a credit that arose from an
**overpayment**, that is deliberately **not** the age of the credit itself: the credit came into being
on the date of the overpayment, which this reader does not carry. Deriving the credit's own age needs
a payment-date path that Phase 4's scope freeze forbids adding, so it is a tracked card for after the
seal.

Because the number means the document's age and not the credit's, the wording is part of the
decision, not a presentation detail:

- **Required**, in Arabic, English and Turkish: **"a credit balance on an invoice X days old"**
  (`رصيد دائن على فاتورة عمرها X يومًا`).
- **Forbidden**: **"a credit balance for X days"** (`رصيد دائن منذ X يومًا`), in any language. It
  states the credit's age, which this field does not measure, and for an overpaid invoice it
  **overstates** it.

**Binding condition on any future pull request.** Measured on this head: `daysPastDue`, `ageDays` and
`isCredit` are consumed by **no** interface — zero matches across `apps/web`, `apps/admin` and
`apps/android`, and no locale string mentions "overdue" — so no merchant sees a wrong label today, and
this obligation is **not** a seal blocker. It is instead owed by whichever pull request first renders
any of those three fields. **That pull request must:**

1. apply the DR-35 wording in **all three languages**, and not the forbidden form;
2. add a **display test** asserting the rendered string in each of the three languages; and
3. pass a **`daftar-finance` review**, because the label is an accounting statement about a
   merchant's money, not copy.

A pull request that renders these fields without all three is incomplete by this decision.

### DR-36 — `is_credit` is a per-document flag, and a bucket's value is net

`is_credit` lives on the **document** only. It is deliberately **not** put on a bucket, because a
bucket may contain both debit and credit documents, which would leave a bucket-level flag undefined.

**Contract statement, explicitly:** a bucket **may combine debit and credit documents, and its value
is the net of them.** The sign is carried by the amount itself — a bucket whose total is negative is
valid output (DR-27), and the bands still total the authoritative outstanding exactly (DR-23).

### DR-37 — extending `document_kind` is gated

A `credit_note` row is **not representable today**: `invoices_document_kind_ck` (`0075:250`) restricts
`document_kind` to `'invoice'`. The credit arm that is live today is therefore the **sign** arm (an
overpayment, DR-23), not the kind arm, which is forward-looking and comes alive with P4-S5. So this is
a tracked card for after the seal, and **not** a blocker.

**Its condition:** any future widening of `document_kind` must pass a **`daftar-finance` review** and
must carry a test proving that **a new debit kind does not have its overdue figure zeroed**. This is
why the kind arm is written as a **positive enumeration** (`= 'credit_note'`) rather than
`<> 'invoice'`: the negative form would sweep an unknown future debit kind in as a credit and zero its
age, which is a debt leaving the report by omission — exactly what DR-13, DR-21 and DR-30 forbid. The
opposite error merely labels a credit as overdue, which is visible and hides nothing.
