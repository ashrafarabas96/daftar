# PATCH-REQ-S7-001 — the aging GRAIN: an invoice has one due date, a plan has `n`

**Raised by:** P4-S7 owner
**Base SHA:** `be5f07f`
**Kind:** DECISION (not an edit S7 may make)
**Blocking:** no for levels A–E; **yes** for level F if the answer is "change the routine"

---

## TARGET FILE

`docs/PHASE_4_DECISION_REGISTER.md` — a new open decision, to be ruled by its
owner. If the ruling is OPTION C below, the target becomes
`infrastructure/database/migrations/` (`customer_ar_aging`), which only the one
migration owner may write.

---

## THE REQUIRED CHANGE

Rule which of three grains the customer aging has, once instalment plans exist,
and record it. S7 implements whichever is ruled and edits nothing until then.

---

## THE REASON

`customer_ar_aging(p_business_id, p_customer_id, p_as_of, p_bucket_days)`
(`0084:699`) is the aging of record. Measured at base SHA, it:

- takes `asOf` **from the caller** and reads no clock — so law 3 is already
  closed there and S7 needs no change for that reason;
- buckets each OPEN INVOICE by **the invoice's own `due_date`**, with a strict
  `>` on `(p_as_of - o.due_date) > t.threshold`.

An instalment plan does not change what is owed, but it changes **when it falls
due**: one invoice with four instalments has four due dates, and three of them
may be in the future while the invoice's own `due_date` is months past. So the
same money can be read two ways:

- by the aging of record: one invoice, one bucket, chosen by the invoice's `due_date`;
- by the schedule: four amounts in up to four buckets, chosen by each instalment's `due_date`.

**Both are defensible and they are not equal.** A merchant shown both would be
shown two different answers to "how overdue is this customer", which is exactly
the second-balance shape this phase forbids.

## WHAT S7 DID IN THE MEANTIME, AND WHY IT IS SAFE

`scheduleAging(projection, bucketDays)`
(`packages/domain-core/src/installment-schedule.ts`) is scoped to **ONE PLAN**.
It takes no business, no customer and no connection; it is a pure `GROUP BY`
over integers the projection already produced from the one settlement figure.
It is therefore **not summable into a competing customer balance**: there is no
call that returns "this customer's aging by instalment grain", and the DTO
(`InstallmentPlanAgingDto`) carries `agingOfRecord: 'customer_ar_aging'` to
name which reader is authoritative. The UI shows it on the plan screen only.

That keeps the slice shippable without pre-empting the ruling. It does not
answer the question.

## THE THREE OPTIONS

- **OPTION A — the invoice grain stays authoritative.** `customer_ar_aging` is
  unchanged forever; the plan-scoped aging stays plan-scoped and is labelled as
  a schedule view, never a customer total. *Cost:* a merchant with plans sees a
  customer aging that calls a whole invoice 90-days-late when three quarters of
  it is not yet due.
- **OPTION B — the plan screen shows no aging at all.** `scheduleAging` is
  deleted and only the one reader of record is ever shown. *Cost:* the plan
  screen loses the one view that answers "which of these instalments are late",
  which is the merchant's actual question.
- **OPTION C — `customer_ar_aging` becomes plan-aware:** an invoice with an
  active plan is bucketed by its unsettled instalments' due dates instead of by
  its own. *Cost:* a change to a sealed S4 financial routine, a rewrite of its
  budget, and an aging answer that moves for existing data. **Only the one
  migration owner may make it, and only after S4 seals.**

## DEPENDENCY

S4 must seal first (the routine is S4's). The ruling does not depend on S5 or S6.

## THE TEST THAT REQUIRES IT

`packages/domain-core/test/installment-schedule.test.ts` — the
`>`/`>=` boundary proof already shows that a one-step change of the bucket
predicate moves money between buckets while every total stays equal, i.e. that
the grain is a real choice and not a presentation detail. A level-F integration
test must then assert the RULED grain against the real routine, and today there
is no ruling to assert.

## EXPECTED SEMANTIC DIFF

- **OPTION A:** none in the tree; one recorded decision, plus a sentence in
  `docs/PHASE_4_S7_CONTRACT_PACK.md §2.1 A4-3` turning the assumption into a ruling.
- **OPTION B:** `scheduleAging`, `InstallmentPlanAgingDto`,
  `InstallmentPlanAgingQuerySchema`, `DebtAgingView` and the `debts.aging.*`
  keys in three locales are removed; 4 of 73 domain tests and 2 of 14 view
  fixtures go with them. No financial answer changes.
- **OPTION C:** `customer_ar_aging` returns different `bucket_no` values for any
  customer holding a planned invoice; `txn_minor` per bucket changes while the
  sum over buckets is unchanged; `invoice_count` per bucket may exceed the open
  invoice count, because one invoice can now land in several buckets — which is
  itself a contract change its callers must be re-read for.
