# P4-S7 — CONTRACT PACK: INSTALMENT PLANS, DEBTS, STATEMENTS, AGING

**Slice:** P4-S7 (payment plans / instalments, customer debts, statements, aging, TD-22)
**Base SHA:** `be5f07fff1ae423cf23c6b3bc71f47b066852533` (`be5f07f`, `phase/4-sales-pos-customers-receivables`)
**Branch:** `p4s7/owner`
**Maturity reached:** A–E (pure logic, ports, unit/red proofs, UI/API surface, DDL *specification*)
**READY_TO_PROMOTE: NO** — see §12.

This pack is the slice's falsifiable statement of what it assumes, what it
offers and what it refuses. Every assumption in §2 is written so a diff against
the sealed S4/S5/S6 trees **confirms or refutes it**: it names a file, a
relation, a column or a signature, never "the receivables design".

---

## 0. WHAT THIS SLICE IS, IN ONE PARAGRAPH

An instalment plan is **a schedule written over an existing receivable**. It is
not a second ledger: there is no instalment AR account, no instalment balance
column, no interest, no fee, no penalty, no cron-maintained status, and no
second collection mechanism. `invoice_outstanding(business, invoice)` remains
the ONE settlement figure; the schedule is a **projection** of that one figure
onto dated rows, computed from a **supplied `asOf`**. Writing, rescheduling or
cancelling a plan posts **nothing** to the journal.

---

## 1. FILES THIS SLICE OWNS

| Level | Path |
| --- | --- |
| A | `packages/domain-core/src/installment-schedule.ts` (+ one re-export line in `src/index.ts`) |
| B | `apps/api/src/modules/installments/installments-errors.ts` |
| B | `apps/api/src/modules/installments/installments.schemas.ts` |
| B | `apps/api/src/modules/installments/installments-contracts.ts` |
| B | `apps/api/src/modules/installments/installments-ports.ts` |
| C | `packages/domain-core/test/installment-schedule.test.ts` |
| C | `tests/guards/p4s7-schedule-laws.test.ts` |
| C | `tests/integration/p4s7-asof-and-closure-redproofs.test.ts` |
| C | `tests/performance/installments-s7-harness.ts`, `tests/performance/installments-s7-budgets.test.ts` |
| D | `apps/web/src/views/installments/{types.ts,InstallmentPlanView.tsx,CustomerDebtsView.tsx,registry.ts}` |
| D | `apps/web/src/messages/{ar,en,tr}.json` (+95 keys each), `apps/web/src/lib/client.ts` (one array entry) |
| D | `apps/web/test/installments-views.test.tsx` |
| D | **TD-22 (P4-AL-56)**: `packages/design-system/src/tokens.ts` (the unloaded `'Inter'` removed), `docs/DAFTAR_DESIGN_SYSTEM.md` (§3, §4, §5 corrected to the shipped tokens) |
| E | `docs/PHASE_4_S7_DDL_SPECIFICATION.md` |
| — | `docs/PHASE_4_S7_CONTRACT_PACK.md` (this file), `docs/patch-requests/PATCH-REQ-S7-*.md` |

**Not owned, not touched:** anything under `infrastructure/database/migrations/`
(no `.sql` file is written and **no migration number is allocated** — the real
prefix is unknown until S4/S5/S6 seal), `scripts/phase4-s*-gate.ts`, the
decision register, the architecture lock, the execution plan, other slices'
docs, the accounting package, the inventory primitives, `.github/workflows/**`,
and every existing S4 suite.

---

## 2. PREDECESSOR ASSUMPTIONS (each one falsifiable by a diff)

Each row states what must be TRUE in the sealed tree. "Refuted by" says what a
diff would have to show for the assumption to be wrong, and what then changes.

### 2.1 On S4 (sales / POS / customers / receivables) — the slice I build on

| # | Assumption | Measured at base SHA | Refuted by | If refuted |
| --- | --- | --- | --- | --- |
| A4-1 | `invoice_outstanding(UUID, UUID)` returns one row with `total_txn_minor`, `outstanding_txn_minor` and their base-currency twins, and is the ONE settlement sum | `0084` | the signature, the column names or the arity changing | `installments-ports.ts` `InstallmentSettlementPort` and `CANDIDATE_READ`'s `CROSS JOIN LATERAL` change; the projection does not |
| A4-2 | `invoices_customer_uq UNIQUE (business_id, id, customer_id)` exists, so a three-column composite FK from a plan to its invoice is drawable | `0082` | the constraint being dropped or re-columned | §E.1's `installment_plans_invoice_fk` loses its target; the plan would have to carry the customer unconstrained, which this pack refuses — raise as a blocking patch request |
| A4-3 | `customer_ar_aging(p_business_id, p_customer_id, p_as_of DATE, p_bucket_days INTEGER[])` takes `asOf` from the caller, reads no clock, and buckets each OPEN INVOICE by the invoice's own `due_date` with a strict `>` on `(p_as_of - due_date) > threshold` | `0084:699` | the routine resolving `CURRENT_DATE` itself, or bucketing by anything other than the invoice's `due_date` | a clock inside it REOPENS the law-3 seam and becomes a blocking patch request; a grain change retires `PATCH-REQ-S7-001` |
| A4-4 | `customer_ar_outstanding` and `customer_open_invoices_page(..., p_after_issue_date DATE, p_after_id UUID, p_limit INTEGER)` are the readers of record for a customer's open invoices, keyset-paged | `0084:678`, `0084:~760` | either being removed, or gaining an `OFFSET` | the debts read is rebuilt on whatever replaces them; it will not grow a competing reader |
| A4-5 | `invoices` carries `business_id, id, customer_id, issue_date, due_date, currency_code, status` and a CASH-settled invoice raises no receivable | `0080`, `0082` | `customer_id` becoming non-nullable (walk-in), or cash settlement raising AR | `installment_plan.invoice_walkin` / `invoice_cash_settled` lose their reason to exist |
| A4-6 | A customer payment allocates through ONE path, and its refusals are `customer_payment.*` in `apps/api/src/modules/receivables/receivables-errors.ts` | base tree | a second allocation entry point appearing | law 4 is broken upstream, not here; this pack adds no collection code either way |
| A4-7 | `customer_payment.registry_incomplete` exists as the loud unpromoted-seam code | `receivables-errors.ts` | its removal | `installment_plan.registry_incomplete` loses its precedent but not its purpose |
| A4-8 | The frozen operation-code regex is `^[a-z]+(\.[a-z_]+)+$` (`0054:53`, duplicated at `0054:229` in `inventory_payload_digest`) | `0054` | the regex being relaxed | `installments.plan` / `.reschedule` / `.cancel` could become `installment_plan.*`; they will NOT be renamed if it is merely relaxed |
| A4-9 | `installments.manage` exists (`packages/domain-core/src/permissions.ts:88`) and is SENSITIVE (`:144`) | base tree | the key being renamed or de-sensitised | the controller's guard changes; no new permission is introduced by this slice |

### 2.2 On S5 (refunds / credit notes) — **no contract pack existed at base SHA**

Only `docs/PHASE_4_S5_PREPARATION.md` exists. Therefore:

| # | Assumption | Refuted by | If refuted |
| --- | --- | --- | --- |
| A5-1 | A refund or credit application REDUCES `invoice_outstanding` and introduces **no** second outstanding figure | a refund that leaves `invoice_outstanding` unchanged while owing less | the projection would over-state every remaining instalment; `projectSchedule`'s P2 assertion fires. BLOCKING |
| A5-2 | A credit application against an invoice is observable as a dated statement entry for the customer | no such row being readable | `STATEMENT_ENTRY_KINDS`'s `'credit_application'` becomes a dead kind and is removed |
| A5-3 | A refund never makes `invoice_outstanding` exceed the invoice total | an over-refund reading above total | `installment_plan.settled_exceeds_total` (500, internal) would become reachable as a MERCHANT outcome, which is a defect in this pack's classification, not in the refund |
| A5-4 | S5 adds no column to `invoices` that this pack's plan FK depends on | a re-columned `invoices_customer_uq` | see A4-2 |

### 2.3 On S6 (reversals / void) — **no contract pack existed at base SHA**

| # | Assumption | Refuted by | If refuted |
| --- | --- | --- | --- |
| A6-1 | Voiding or reversing an invoice does **not** delete it; it moves it to a terminal status while the row survives | a hard `DELETE` of `invoices` | `installment_plans_invoice_fk ON DELETE RESTRICT` would block a void. The FK is deliberately RESTRICT so this surfaces as a refusal and never as a silently orphaned schedule. Would become a joint decision |
| A6-2 | A reversal drives `invoice_outstanding` to `0` rather than negative | a negative outstanding | `projectSchedule` refuses with `settled_exceeds_total`; the plan screen cannot render. BLOCKING |
| A6-3 | A voided invoice's plan is expected to be **cancelled, not deleted**, and a cancelled plan keeps its rows | S6 requiring plan deletion | `installment_plans_invoice_uq UNIQUE (business_id, invoice_id, lifecycle)` already allows exactly one active plan plus history; deletion would need a new ruling |
| A6-4 | S6 introduces no second reversal of a *payment allocation* that bypasses the one allocation path | a direct allocation write | law 4 and law 7 break upstream |

### 2.4 Assumptions this pack explicitly DOES NOT make

- that any migration number is available, reserved or predictable;
- that an `installment_*` relation exists at base SHA (none does);
- that a sales-tax rate exists or can be inferred (OD-03: structural zero, the owner's alone);
- that `customer_ar_aging` can or should be changed by this slice;
- that a cron, a trigger or a job maintains any financial status;
- that an interest, fee, penalty or late charge is in scope (none is ruled).

---

## 3. RELATIONS, COLUMNS AND CONSTRAINTS EXPECTED

Normative text is in `docs/PHASE_4_S7_DDL_SPECIFICATION.md`. The summary:

**New (this slice's own):** `installment_plans`, `installments`, and the read
routine `customer_statement_entries(business, customer, from, to)`.

**Read, never written:** `invoices`, `customers`, `currencies`, `businesses`,
`invoice_outstanding`, `customer_ar_outstanding`, `customer_ar_aging`,
`customer_open_invoices_page`, and S4's customer-payment / credit-application
relations as the statement's source rows.

**Columns that must NOT exist**, and are refused by
`scripts/guards/no-authoritative-balance.ts` (`:258`, `:272-274`, `:314`,
`:436`, `:700-720`) by name: `installments.outstanding_minor`,
`installments.settled_minor`, `installments.status`, `installments.settled_at`,
`installment_plans.balance_minor`, `installment_plans.status`. Every one of
these is derived from the one settlement figure and the supplied `asOf`.

---

## 4. API SURFACE

**No route is mounted at level D.** `tests/security/phase4-route-surface.test.ts`
derives BOTH halves of "declared = mounted" from the `*.controller.ts` files
that exist, so declaring a route that cannot answer is how that suite goes red.
The surface below is the CONTRACT the controller will implement at level F, and
it is already fully typed and validated in `installments.schemas.ts` and
`installments-contracts.ts`.

| Method | Path | Permission | Request schema | Response |
| --- | --- | --- | --- | --- |
| POST | `/installment-plans` | `installments.manage` | `CreateInstallmentPlanSchema` | `InstallmentPlanDto` |
| POST | `/installment-plans/:planId/reschedule` | `installments.manage` | `RescheduleInstallmentPlanSchema` | `InstallmentPlanDto` |
| POST | `/installment-plans/:planId/cancel` | `installments.manage` | `CancelInstallmentPlanSchema` | `InstallmentPlanDto` |
| GET | `/installment-plans/:planId` | `customers.read` | `InstallmentPlanQuerySchema` (`asOf` required) | `InstallmentPlanDto` |
| GET | `/installment-plans/:planId/installments` | `customers.read` | `InstallmentPageQuerySchema` (`asOf`, `after`, `limit` 1..50) | `InstallmentPageDto` |
| GET | `/installment-plans/:planId/aging` | `customers.read` | `InstallmentPlanAgingQuerySchema` (`asOf`, `bucketDays`) | `InstallmentPlanAgingDto` |
| GET | `/customers/:customerId/statement` | `customers.read` | `CustomerStatementQuerySchema` (`asOf`, `from`, `to`, `after`, `limit`) | `CustomerStatementDto` |
| GET | `/customers/:customerId/debts` | `customers.read` | `CustomerDebtsQuerySchema` (`asOf`, `after`, `limit`) | `CustomerDebtsDto` |

Every schema is `.strict()`: an unknown query or body key is a 400 and never
ignored. Every money field crosses the wire as a **decimal string of integer
minor units** — never a JSON number, because 10^18 does not survive one.
`asOf` is a required supplied civil date (`YYYY-MM-DD`) on every read that
returns a derived status. **There is no `runningBalanceMinor` on any DTO.**

---

## 5. PERMISSIONS

`installments.manage` — already present and already SENSITIVE
(`permissions.ts:88`, `:144`). Under the `OD-P4-01` OPTION A ruling it is a
default of **no built-in role**. Reads use `customers.read`. **This slice adds
no permission key.**

---

## 6. ACCOUNTING SOURCE TYPES AND OPERATION KINDS

**Accounting source types: NONE.** Creating, rescheduling or cancelling a plan
posts no journal entry, because the receivable was already raised by the
invoice and a schedule raises nothing. A source type here would be the second
financial model this slice exists to not create. The only accounting that ever
happens is the ORDINARY customer payment, with S4's existing source type.

**Operation kinds (`invctl/1`, constrained by `^[a-z]+(\.[a-z_]+)+$`):**
`installments.plan`, `installments.reschedule`, `installments.cancel`.
The first segment holds no underscore, so `installment_plan.create` is
**unrepresentable** — which is why the refusal prefix and the operation code
deliberately differ (the accepted OQ-6 split).

---

## 7. REFUSAL CODES (26)

The table is normative in `installments-errors.ts`; a code not in it is not an
instalment refusal. `InstallmentArithmeticCode` (11 codes from level A) is
enforced at COMPILE TIME to be a subset, via
`Record<Exclude<InstallmentArithmeticCode, InstallmentsCode>, never>`.

| Code | HTTP |
| --- | --- |
| `installment_plan.idempotency_conflict` | 409 |
| `installment_plan.schedule_sum_mismatch` | 422 |
| `installment_plan.installment_count_invalid` | 400 |
| `installment_plan.amount_invalid` | 400 |
| `installment_plan.down_payment_invalid` | 400 |
| `installment_plan.total_invalid` | 422 |
| `installment_plan.due_dates_invalid` | 400 |
| `installment_plan.due_date_before_start` | 422 |
| `installment_plan.sequence_invalid` | 400 |
| `installment_plan.start_before_invoice` | 422 |
| `installment_plan.date_in_future` | 422 |
| `installment_plan.invoice_state_invalid` | 409 |
| `installment_plan.invoice_walkin` | 409 |
| `installment_plan.invoice_cash_settled` | 409 |
| `installment_plan.customer_mismatch` | 409 |
| `installment_plan.customer_inactive` | 409 |
| `installment_plan.already_planned` | 409 |
| `installment_plan.not_found` | 404 |
| `installment_plan.state_invalid` | 409 |
| `installment_plan.settled_installment_immutable` | 409 |
| `installment_plan.settlement_changed` | 409 |
| `installment.not_found` | 404 |
| `installment.cursor_invalid` | 400 |
| `installment_plan.arithmetic_invalid` | 500 (internal invariant) |
| `installment_plan.settled_exceeds_total` | 500 (internal invariant) |
| `installment_plan.registry_incomplete` | 500 (unpromoted seam) |

The code travels as `details.installmentsCode`, registered in
`apps/web/src/lib/client.ts:191`. A field the API attaches and that list omits
makes the whole code family a dead string — the measured P4-S2 defect that
`apps/web/test/domain-code-fields.test.ts` derives the list against.

**Absent on purpose:** no interest/fee/penalty code, no tax code, no
collection code (collection refuses with `customer_payment.*`), no refund or
reversal code, no balance code.

---

## 8. LOCK ORDER AND TRANSACTION BOUNDARY

**Lock order (declared in `installments-ports.ts`):**
`advisory(business_id, plan id) → invoices → installment_plans → installments`.

One transaction per command, and the whole command inside it:

1. advisory lock on the plan identity (so two writers of the same plan serialise before touching a row);
2. read the invoice and its customer `FOR SHARE`, refuse on state;
3. read `invoice_outstanding` ONCE and carry that value through the command — a second read inside the same command is a second truth;
4. write/rewrite `installment_plans` + `installments`;
5. set constraints immediate so the DEFERRED closure trigger fires **inside** the transaction;
6. commit.

**Optimistic concurrency:** the command carries the outstanding figure it was
planned against; if it moved, the command refuses with
`installment_plan.settlement_changed` (409) rather than writing a schedule that
no longer closes.

**Idempotency:** `planId` is caller-supplied; the intent hash covers the
business, the invoice, the total, the down payment, the count, the placement,
every due date and the **supplied `asOf`** — nothing server-resolved. Exact
replay returns the first answer; a changed intent under the same key is
`installment_plan.idempotency_conflict`. A fingerprint over a server-resolved
date is not idempotent, which is why no such date exists in the command.

---

## 9. PERFORMANCE BUDGETS

Harness: `tests/performance/installments-s7-harness.ts`;
suite: `tests/performance/installments-s7-budgets.test.ts`.

| Id | Measurement | p95 budget |
| --- | --- | --- |
| P4-S7-A | one plan with its schedule page, projected at a supplied `asOf` | 50 ms |
| P4-S7-B | a customer's debts page (keyset, limit 20) | 100 ms |
| P4-S7-C | a customer's statement page (keyset, limit 20) | 100 ms |
| P4-S7-D | one plan's schedule aging at a supplied `asOf` | 50 ms |

`ITERATIONS = 200`; `p95` is `quantileIndex(n, 0.95) = min(n-1, floor(0.95n))`
(= index 190 of 200), and nothing is trimmed. Keyset drift across pages must
stay under `KEYSET_DRIFT_MAX_RATIO = 1.5` — a page that gets slower the deeper
you walk is an `OFFSET` wearing a cursor's name.

**Three outcomes, not two.** The harness reports `pass`, `fail` or
`resource_contention`, and it **asserts nothing** unless it was declared the
exclusive user of the box. «A benchmark measures what the planner saw»: the
harness records what it `ANALYZE`d, read back from `pg_stat_user_tables`, and
at what scale, because one accepted budget cost 2.9 s on a runner and 122 ms
after a single `ANALYZE` with no query and no migration change. Observed
banner on this shared container:

```
P4-S7 performance harness · resource_contention (not_declared_exclusive)
  · load1m 3.31 on 4 cpu · PostgreSQL 180004 · collate C · scale 1
```

**These budgets are therefore UNMEASURED.** The coordinator runs the harness
under an exclusive box; a number taken while four other agents run is neither
a pass nor a fail.

---

## 10. RLS, SECURITY AND TEST HOOKS

**RLS assumptions.** `installment_plans` and `installments` are
business-scoped parents (`installment_plans` is already in
`BUSINESS_SCOPED_PARENTS`, `scripts/phase4-s1-gate.ts:490-520`). Both get
`ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, a policy keyed on
the session's business, and `REVOKE ALL FROM PUBLIC` with an explicit
`GRANT` to `daftar_app` only. **A cross-business id answers "not found", never
"forbidden"** (G-02): the id's existence is itself the leak.

**Security assumptions.** No `SECURITY DEFINER` routine of this slice resolves
a date, a business or an actor itself; all three are parameters. The statement
routine is `STABLE` and `SET search_path = pg_catalog, public, pg_temp`. The
write path is not a definer routine at all. A validation-layer refusal is
evidence about the pipe, not about the command: the red proofs in §11 plant
REAL routines to show the seam is closed at the trusted layer.

**Test hooks.** `AsOfPort.asOf(supplied)` is the single seam a test substitutes
a date through, and it takes the supplied date as its argument — there is no
hook that *provides* a date, because a hook that can provide one is a clock
with a nicer name.

---

## 11. RED PROOFS, AND WHAT EACH ONE PLANTS

| Suite | Plants | Shows |
| --- | --- | --- |
| `packages/domain-core/test/installment-schedule.test.ts` (73) | a second rounding grain (`[500,250,250]` vs `[334,333,333]`, both summing to 1000); a clock-read status; a second balance that drifts; a `>=` aging boundary | each disagrees with the one canonical answer, so a second one cannot be added quietly |
| `tests/guards/p4s7-schedule-laws.test.ts` (31) | a polymorphic `source_type`/`source_id` pair; a single-component `plan_id` FK; an authoritative `outstanding_minor`; a `settled_at`; an `OFFSET` page — into `mkdtemp` hard copies as `zz-p4s7-candidate-spec.sql` (**no number allocated**, the checkout never written) | the ESTATE's own detectors (`compositeFkProblems`, `findAuthoritativeSalesColumns`, `DERIVED_SETTLEMENT_INSTANT`, `findReadSurfaceViolations`) refuse each one |
| `tests/integration/p4s7-asof-and-closure-redproofs.test.ts` (17) | four REAL routines (one correct, three with the seam open) for law 3; REAL tables plus a REAL `DEFERRABLE INITIALLY DEFERRED` constraint trigger for the closure law; a REAL role for the EXECUTE model — all in rolled-back transactions | semantic evaluation, not lexical: the open-seam routines return a different answer for the same arguments on a different day. `afterAll` asserts no `p4s7_probe_%` class, proc or role survives |
| `tests/performance/installments-s7-budgets.test.ts` (24) | 9 vs 10 slow samples at `n = 30`; an un-`ANALYZE`d relation | the p95 index is 190/200 and 28/30, so a "tail" claim that ignores 19 slow samples is false; and a budget met without statistics is a number about the statistics |
| `apps/web/test/installments-views.test.tsx` (56) | a `marginLeft`, a merchant-jargon term, a charge word | the view laws are non-vacuous; `stripProse` is asserted both ways so a law about code cannot be satisfied or failed by its own documentation |

**One measured refutation, recorded rather than hidden:** PostgreSQL 18
**accepts** an `IMMUTABLE` function body that reads `CURRENT_DATE`. The
volatility marker is a promise the server trusts, not a check it performs — so
the law-3 seam cannot be closed by a marker and is closed by the parameter.

---

## 12. READY_TO_PROMOTE = **NO**

What is missing, in the order it must happen:

- [ ] **S4 seals.** This slice's every read goes through `invoice_outstanding`, `customer_ar_aging` and `customer_open_invoices_page`.
- [ ] **S5 seals**, and A5-1…A5-4 are confirmed against the sealed tree.
- [ ] **S6 seals**, and A6-1…A6-4 are confirmed — A6-1 and A6-2 are the two that can break the projection.
- [ ] **This slice is promoted** by the coordinator, and only then does a migration owner allocate a real prefix for the DDL specification.
- [ ] `PATCH-REQ-S7-001` (the aging GRAIN: an invoice has one due date, a plan has `n`) is ruled.
- [ ] `PATCH-REQ-S7-002` (the statement's entry kinds, closable only once S5 and S6 seal) is ruled.
- [ ] `PATCH-REQ-S7-003` (`scripts/phase4-s7-gate.ts` — the slice has no acceptance gate and I may not write one) is applied.
- [ ] `PATCH-REQ-S7-004` (TD-22's row in `TECHNICAL_DEBT.md` — the repayment is on this branch, the ledger cell is the coordinator's) is applied.
- [ ] Level F: the DDL is written by the ONE migration owner; `installments-reads.ts` and a controller land; `installment_plan.registry_incomplete` stops being the answer to every command.
- [ ] Level G: the integrated gate, with the performance harness run under an **exclusive box**. Until then the §9 budgets are `resource_contention` and no number is claimed.
- [ ] Level H: seal.

**Nothing in this pack may be promoted piecemeal.** Level E is a
specification; a `.sql` file written from it before the predecessors seal would
allocate a number that is not this slice's to allocate.

---

## 13. TD-22, AS THE DEBT REGISTER ACTUALLY STATES IT

`TECHNICAL_DEBT.md:31` is the authoritative row, and it is **not an
installments item**. Quoted:

> "Two Visual North Star shortfalls from the Phase 3 corrective browser review
> that belong to the design system, not to a screen: (1) the design-system
> button's radius and height are below the tokens in the design document;
> (2) the published Tajawal subsets (`@fontsource/tajawal` arabic and latin,
> U+0000–00FF plus U+0131) do not cover the Turkish letters ğ, ş and İ, so the
> browser draws those in a fallback face; OD-06 names Inter as the companion"

Classification: "A design-system decision, not a defect: every Phase 3 screen
passes the browser gate in ar/en/tr with no overflow and a readable fallback".
Symptom: "Buttons slightly smaller than the design document draws them, while
every target stays at or above the `TOUCH_TARGET` token the browser gate
enforces; mixed faces inside a Turkish word". Bound in P4-S0 (2026-09-30) to
the Phase 4 UX slice. Status at base SHA: `open (decision)`.

`docs/PHASE_4_ARCHITECTURE_LOCK.md:165-166` maps it to D-15 and D-16, and
**P4-AL-56** (`:1138-1146`) binds it to P4-S7 and rules the repayment NARROW:
correct the **document** to the shipped tokens, and remove the unloaded font
name — "not by changing every button in the product during a sales phase".

**Repaid here, on this branch, exactly that narrowly.** See
`PATCH-REQ-S7-004` for what changed, the browser-gate lines that were checked
not to regress, and why the one cell in the debt register is left to the
coordinator rather than edited from a branch while four other owners edit the
same file.
