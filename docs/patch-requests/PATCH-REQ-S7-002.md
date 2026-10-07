# PATCH-REQ-S7-002 — the statement's ENTRY KINDS cannot be closed until S5 and S6 seal

**Raised by:** P4-S7 owner
**Base SHA:** `be5f07f`
**Kind:** DECISION + a later edit to S7's own files
**Blocking:** level F only

---

## TARGET FILE

`docs/PHASE_4_DECISION_REGISTER.md` (the ruling). The consequent edits land in
S7's own `apps/api/src/modules/installments/installments.schemas.ts`
(`STATEMENT_ENTRY_KINDS`), `installments-contracts.ts` (`StatementEntryDto`),
the `E.6` routine in `docs/PHASE_4_S7_DDL_SPECIFICATION.md`, and the
`installments.statement.kind.*` keys in `apps/web/src/messages/{ar,en,tr}.json`.

---

## THE REQUIRED CHANGE

Declare the CLOSED SET of things that may appear as a dated line on a customer
statement, once refunds/credit notes (S5) and reversals/void (S6) exist.

---

## THE REASON

S7 ships `STATEMENT_ENTRY_KINDS = ['invoice', 'payment', 'credit_application',
'installment_due']`. Three of those four are claims about other slices:

- `'payment'` assumes S4's one allocation path is the only way money arrives;
- `'credit_application'` assumes S5 makes a credit application observable as a
  dated row for a customer (contract-pack A5-2) — and **no S5 contract pack
  existed at base SHA**, only `docs/PHASE_4_S5_PREPARATION.md`;
- a REVERSAL has no kind at all, because S6's shape is unknown
  (contract-pack A6-1…A6-4). If a reversal is a new dated row rather than a
  status change on an existing one, the statement is **missing a line**, and a
  statement that omits a line is the worst failure this read can have.

`'installment_due'` is the one kind S7 owns outright, and it is deliberately
**not money that moved**: it is a date and an amount from this slice's own
rows, marked as such on the DTO so no client can sum it into a balance.

A closed enum guessed now is a contract clients build against. An open enum is
worse: a statement that silently drops an unknown kind shows a merchant a
history with a hole in it.

## THE SECOND HALF: THERE IS DELIBERATELY NO RUNNING BALANCE

`StatementEntryDto` carries **no `runningBalanceMinor`**, and
`customer_statement_entries` returns none. A running balance computed over a
window is a second AR total that disagrees with `customer_ar_outstanding` the
moment a row is backdated into the window — and backdating is exactly what a
reversal or a credit note does. The merchant's "what is still owed" comes from
the one reader of record. **This is not an open question and is recorded here
only so the ruling does not reopen it.**

## DEPENDENCY

S5 and S6 must both seal. S4 alone is not enough.

## THE TEST THAT REQUIRES IT

`tests/guards/p4s7-schedule-laws.test.ts §3` runs the estate's own
`findReadSurfaceViolations` over `CANDIDATE_READ`, whose statement query reads
`customer_statement_entries(...)`. The suite proves the PAGE is a keyset page
with no `OFFSET`; it cannot prove the page is COMPLETE, because completeness is
a claim about which kinds exist. A level-F test must assert that every row S5
and S6 can create appears on the statement exactly once, and that test cannot
be written against an unruled set.

## EXPECTED SEMANTIC DIFF

- if S5 and S6 add no new dated customer row: no diff at all, and one recorded
  ruling turning four guesses into four facts;
- if S6's reversal is a new row: `STATEMENT_ENTRY_KINDS` gains one member, the
  `E.6` routine gains one `UNION ALL` branch, each locale gains one key, and
  **every statement page for a customer with a reversal gains a line** — i.e. a
  page that was already shipped would have been wrong;
- if S5's credit application is not observable per customer:
  `'credit_application'` is REMOVED rather than left as a kind that never
  occurs. A dead enum member is a contract nobody can satisfy.
