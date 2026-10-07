# PATCH-REQ-S5-005 — add `credit_note_applications` to `FINANCIAL_CORE`

| field | value |
|---|---|
| requested by | P4-S5 owner |
| base of record | `phase/4-sales-pos-customers-receivables` @ `6587460` |
| target file | `scripts/phase4-s1-gate.ts`, lines 504-505 |
| owner of target | `scripts/phase4-s*-gate.ts` is a shared permanent module |
| depends on | nothing. It must land in the SAME change that creates the relation |
| blocks | nothing today — the relation does not exist, so nothing is red. It blocks the integrity of the S5 migration |

## Required change

One token. `FINANCIAL_CORE` at `scripts/phase4-s1-gate.ts:504-505` is

```ts
export const FINANCIAL_CORE =
  /^(sales|sale_items|invoices|invoice_items|payments|payment_allocations|payment_reversals|allocation_reversals|refunds|credit_notes|credit_note_items|customer_credits|customer_credit_applications|installment_plans|installments)$/;
```

Add `credit_note_applications` to the alternation.

## Reason

`FINANCIAL_CORE` is the relation set on which a polymorphic foreign key is refused (G-19 /
GOLD-74), and the check that applies it is `schemaLintProblems`' polymorphic-reference arm
(`:1565-1577`): inside the set, a `*_id` beside a `*_type`/`*_kind` with no foreign key is
refused.

Measured over this tree at `6587460` the set names `refunds`, `credit_notes`,
`credit_note_items`, `customer_credits` and `customer_credit_applications` — and **not**
`credit_note_applications`. No such relation exists at any prefix `0000`–`0086`, so nothing is
red now and this is NOT an omission to fix in S4.

It is a trap for the slice that creates the relation. A relation that binds a credit note to an
invoice is financial core by every reading of `P4-AL-29` — it is the ONE place AR falls in this
slice — and it would arrive **outside** the pattern that refuses a polymorphic source there,
while `INVOICE_REDUCER_VOCABULARY` (`:1237`) already treats it as a reducer. The asymmetry is
the whole defect: the estate would call the relation a reducer for one law's purposes and not
financial core for another's.

**There are exactly two lawful outcomes:** the name is added in the same change that creates
the relation, or the migration states why the financial core does not include a relation that
moves AR. No such statement is available, so the name is added.

## The test that requires it

The red proof this patch owes, which must be written with it: a `credit_note_applications`
declaration carrying a `source_id` beside a `source_type` with no foreign key must be REFUSED by
`schemaLintProblems`, and the proof must show it was ADMITTED before the name was added. A
one-token widening with no red proof is a widening nobody can tell happened.

`tests/guards/p4s5-refund-plan-red-proofs.test.ts` does not and cannot cover this: the subject
is a gate module's constant, and the level-C suites do not drive the gate.

## Expected semantic diff

- `FINANCIAL_CORE.test('credit_note_applications')` goes from `false` to `true`;
- `schemaLintProblems` gains one relation's worth of subjects for its polymorphic arm;
- no existing relation changes classification, so every current green stays green. The
  `scripts/phase4-s1-gate.ts` run before and after must differ in nothing but the new
  relation's coverage.
