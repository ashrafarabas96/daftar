# DAFTAR — Phase 4 Architecture Lock / قفل معمار المرحلة الرابعة

**Phase 4 — Sales, POS, Customers, Debts, Receivables & Installments**
**Stage: P4-S0 — Architecture Lock. Status: candidate, awaiting Tech Lead review.**

> This document is the architectural contract for Phase 4. It decides; it does not implement.
> P4-S0 created no product code, no endpoint, no POS screen and no migration, and `0074` does not
> exist. Implementation begins only on an explicit Tech Lead PASS on this document.
>
> Every load-bearing claim below is cited as `file:line` against the baseline tree. Where a canonical
> document disagreed with the code, the code won and the disagreement is recorded in §3 rather than
> silently resolved. An Arabic summary is at §26.

---

## 1. Baseline

| item | value |
|---|---|
| `main` | `6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595` |
| CI baseline | `DAFTAR CI` **36637141476** — SUCCESS, six jobs (workspaces, backend, web-admin, android, hygiene, browser), push event, attempt 1 |
| migrations | **74**, `0000`–`0073`, `frozenThrough = 0073_default_warehouse_locale_name.sql`, **no `0074`** |
| Phase 3 | MERGED, CLOSED and VERIFIED ON MAIN (PR #4 merge `042f5d4`, follow-up PR #5 merge `6fc505d`) |
| Phase 4 branch | `phase/4-sales-pos-customers-receivables`, cut from `6fc505d` |
| Phase 4 pull request | **#6, draft**, into `main`. Every Phase 4 change goes through it. |
| prior Phase 4 product code | none — the only occurrences of "Phase 4" in the tree are forward references in comments and two deferred reconciliation rows |

**P4-AL-01 — The baseline is exactly this SHA and nothing else.** Any Phase 4 slice that cannot trace
its history to `6fc505d` is not a Phase 4 slice. `gate:phase2:release` protects the Phase 2 prefix
`0000`–`0052` and `gate:phase3:release` protects the Phase 3 history `0053`–`0073`; both permit later
migrations, and **no Phase 4 gate may ever assert "nothing after 00NN"** — that exact mistake blocked a
Phase 3 seal and `scripts/phase3-prefix.ts:21-28` warns against it in terms.

**P4-AL-02 — P4-S0 is analysis and correction only.** No product code, no endpoint, no POS screen, no
migration, no `0074`. Migrations `0000`–`0073` are immutable byte-for-byte; every correction anywhere in
Phase 4 is a **new** migration.

---

## 2. Dependencies on Phase 2 and Phase 3

Phase 4 posts **through** the accepted engines and adds no writer of its own.

### 2.1 The one ledger writer

```
accounting_post_entry(p_entry_date DATE, p_description TEXT, p_request_id TEXT, p_lines JSONB)
  RETURNS TABLE (entry_id UUID, created BOOLEAN)
```
`infrastructure/database/migrations/0045_accounting_post_entry.sql:490`. `SECURITY DEFINER`, owned by
`daftar_accounting_internal` (NOLOGIN, unreachable), `EXECUTE` to `daftar_app` only (`0045:867`). It
takes **no** actor, tenant, business, source_type or source_id argument by design (`0045:144-151`): all
of them come from the HMAC-signed accounting assertion verified by `accounting_actor()` (`0045:162`).
Its eight-step order is the contract (`0045:27-43`), including "recompute `acctfp/1` from the lines
actually received and refuse a mismatch before any write".

**P4-AL-03 — Phase 4 adds no journal writer and no `trusted` flag.** A Phase 4 posting is never made
through `AccountingEngine.post` (`packages/accounting/src/post.ts:243-303` refuses every native and
domain source by name) and never through a new routine. It is made through `postEntryInTransaction` on
the seam-2 posting capability. Guard G-4 (`scripts/guards/posting-surface.ts`) discovers journal writers
from the schema rather than naming one, so a new writer fails CI.

### 2.2 What a Phase 4 accounting source must provide

| requirement | enforced at |
|---|---|
| a registered `accounting_source_types` row with `lower_bound_policy`/`upper_bound_policy` and a free `sort_order` (1–12 are taken; `sort_order` is UNIQUE) | `0042_accounting_journal.sql:51-62`, `0072:156-158` |
| exactly one owning `accounting_operation_kinds` row (`UNIQUE (source_type)`) | `0046_accounting_sources.sql:86-99` |
| a source-document row in the same transaction, joined to `accounting_source_bindings` by a composite **deferred** FK, with the mirror deferred FK on the journal side | `0042:273-306`, `0067:400-403` |
| a **deferred constraint trigger** re-deriving the exact expected line multiset from the persisted source row | `0063:1706-1713`, `0067:1959-2035` |
| the source type added to `DOMAIN_SOURCE_TYPES` so the generic engine refuses it and `mintDomainPostingAssertion` admits it | `packages/accounting/src/post.ts:208`, `domain-posting.ts:54` |
| one accounting assertion minted **before** the transaction opens, one per posting, in posting order | `apps/api/src/infra/database.ts:409-492` |

### 2.3 Reversal authority

`accounting_post_reversal` (`0046:449`) derives the mirror from the persisted original — debit and
credit swapped, **everything else copied verbatim including rate, rate source and rate instant** — and
writes one `accounting_reversals` row whose `id = original_entry_id` (`0046:182`). Three consequences
bind every Phase 4 correction:

1. **one reversal per entry, forever** (a second is `accounting.reversal_exists`);
2. **a reversal is always whole-entry** — there is no partial-reversal primitive;
3. `accounting_reversals_20_domain_source_guard` (`0067:2242-2271`) refuses a generic reversal of a
   domain source **unless** the paired domain-reversal row exists in the same transaction (the
   `purchase` carve-out at `:2248-2252`).

### 2.4 The two composite seams

```
withBusinessInventoryTransaction(scope, inventoryAssertion, fn)              -- stock only, no posting capability
withBusinessInventoryAccountingTransaction(scope, inventoryAssertion, accountingAssertions, fn)
```
`apps/api/src/infra/database.ts:116`. The seams refuse to open inside another transaction and nothing
opens inside them (`:150-161`) — a second connection inside a business seam would be an independent
commit, which is exactly what the atomic-sale law forbids. The posting capability is a frozen,
prototype-less object in a module-private `WeakMap` (`:168,194-202`), so no look-alike can impersonate
it. `AccountingAssertionSequence` (`:418-492`) hands out the k-th assertion only for a posting whose
`(sourceType, sourceId)` matches its claims, and `assertComplete()` refuses a commit that presented
some but not all of them.

**A sale is a seam-2 operation with N accounting assertions**, N known before the transaction opens.

### 2.5 The stock authority

`inventory_apply_stock_movements` is "the only writer of `stock_movements`, `stock_levels` and
`stock_source_bindings`" (`0060_inventory_stock_primitive.sql:487`), has **no `EXECUTE` grantee**
(`0060:717`), and re-verifies the `invctl/1` assertion through `inventory_assertion_current`, reading
its allowed operation list **from the registry table** (`0060:186`). This single fact decides the
signed-authority question in §11.

### 2.6 Accepted Phase 2/3 invariants Phase 4 may not break

Phase 4 inherits and must not weaken: the closed 21-identity account registry (`0040:45-77`, asserted
`count(*) = 21`); the journal's append-only triggers, which refuse UPDATE and DELETE **for every
identity including the schema owner** (`0042:315`); the per-line FX-arithmetic law — every line's
`base_amount_minor` is the exact `HALF_EVEN` conversion of *that line's* txn amount at *that line's*
rate (`0043:208-245`); the period guards (`0049`, `0058`); the frozen prefix discipline; and the
Phase 3 stock ledger's five-part movement identity with no polymorphic FK (`0059:147`).

---

## 3. Document defects corrected, and the source-of-truth order

**P4-AL-04 — The source-of-truth order for all of Phase 4 is: (1) runtime/product code, (2) accepted
migrations, (3) permanent tests and invariants, (4) accepted CI/release evidence, (5) accepted
architecture locks, (6) canonical current docs, (7) historical text.** Phase 4 is not built on
pseudocode that contradicts the real Phase 2 or Phase 3.

### 3.1 Corrected in P4-S0 (committed on this branch)

| source | was | now |
|---|---|---|
| `docs/DAFTAR_IMPLEMENTATION_ROADMAP.md` | Phase 2 headed "NEXT (not started)"; Phase 3 a final-seal candidate with PR #4 an unmerged draft | Phase 2 and Phase 3 **CLOSED / PASS**; the Status section records the merge commit `042f5d4`, PR #5 merged as `6fc505d`, CI 36637141476 SUCCESS on six jobs, 74 migrations frozen through `0073`, and Phase 4 authorized at P4-S0 |
| `PROJECT_STATUS.md` | the same stale picture, no current `main` | the Phase 3 seal, merge, post-merge failure, PR #5 and the green verification on `main`; current `main`; next allowed step = P4-S0 only; no `0074` |
| `TECHNICAL_DEBT.md` TD-08 | repayment named **five** required checks | names the **six** jobs CI runs; states that branch protection is **not verifiable from this tooling** rather than claiming it is configured; restates the mandatory compensating policy |
| `TECHNICAL_DEBT.md` TD-15, TD-22 | no Phase 4 owner | bound to Phase 4 (§21) |

TD-08 stays **OPEN / EXTERNAL** (`MAIN_PROTECTION_EXTERNAL_BLOCKER`). Until it is set externally the
compensating policy is mandatory and is a Phase 4 rule: **no direct push to `main`, every change through
a pull request, merge only after the required CI, no force push to `main`, no deletion of `main`.**

### 3.2 Contradictions found and ruled on (not yet corrected in the documents they live in)

These are the places where a Phase 4 implementer following a canonical document would build the wrong
thing. Each is ruled here; the document corrections are owed by the slice named in §19.

| # | Document claim | Reality | Ruling |
|---|---|---|---|
| D-01 | `DAFTAR_ACCOUNTING_RULES.md:96-124`, `DAFTAR_MULTI_CURRENCY.md` §5/§7.4 and `DAFTAR_DATA_MODEL.md` §7 specify `rounding_difference_minor` and a `6100 Rounding Adjustment` line on a settlement | the accepted settlement has **no such column** (`0067:362-405`) and its expected line set contains **no rounding line** (`0067:2000-2020`); the residue is `ap_dust_base_minor` on the AP account itself (`0067:1997-2005`). `classifyRoundingResidual` (`packages/accounting/src/rounding.ts:71`) is reachable from no product path | follow the code — **P4-AL-19** |
| D-02 | `DAFTAR_ACCOUNTING_RULES.md:364` INV-ACC-02 mandates `paid + outstanding = invoice.total` as a **Row CHECK**; `DATA_MODEL.md` §5 says the same for a `receivables` row | `purchases` has neither column; outstanding is the function `purchase_ap_outstanding` (`0072:240-269`), and guard G-3 **fails CI** on a column matching `outstanding|paid|unpaid|due|owed|payable|settled` | INV-ACC-02 is restated as a **derived identity verified by reconciliation**; the Row CHECK is withdrawn — **P4-AL-26** |
| D-03 | `DATA_MODEL.md` §17 mandates an `idempotency_key` column with `UNIQUE(business_id, idempotency_key)` on `payments`, `refunds`, `supplier_payments`, `supplier_refunds` | **no commercial table has it.** The only `idempotency_key` in 74 migrations is `onboarding_operations` (`0018:7`). The accepted mechanism is a caller-supplied document UUID plus a stored `intent_sha256` (`0067:339`, `0068:588-611`) | §17 is superseded for domain commands — **P4-AL-30** |
| D-04 | `ACCOUNTING_RULES.md` §5.2/§6's canonical settlement entry is three lines (`Dr Bank / Cr AR / Cr FX Gain`) | the general carrying release `rel(X,a) = HALF_EVEN(B(X+a)/T) − HALF_EVEN(BX/T)` (`0067:683-694`) is **not** `conv(a)`, and `0043:208-245` requires every line's base to be the exact conversion of its own txn amount — so the accepted code emits a **second, base-only line on the same account** for the dust (`0067:1997-2005`). The doc's tidy example passes only because its numbers are tidy | any design copying the three-line shape is refused by the deferred validator on the first non-tidy number — **P4-AL-19** |
| D-05 | `TRANSACTION_MAP.md` §3 and `ACCOUNTING_RULES.md` §4.3 describe **one entry per payment** | the accepted code posts **one entry per allocation**, `source_id = allocation_id` (`0067:362-405`, `0068:480`) | one per allocation — and this is load-bearing, because `accounting_reversals.id = original_entry_id` permits exactly one reversal per entry — **P4-AL-17** |
| D-06 | `STATE_MACHINES.md` §2 permits `open → voided` only "with no active payments", then defines a `void_invoice` compound command for exactly that case | irreconcilable as written | §7's compound command is substantive — **P4-AL-24** |
| D-07 | `TRANSACTION_MAP.md` §1 says a cash sale creates "Invoice (status=paid)"; `SOURCE_OF_TRUTH_MATRIX.md` §1 says invoice status is derived and "لا تُحرَّر يدويًا" | the Phase 3 precedent settles it: `purchases.status` is **lifecycle only** and settlement state is never stored | **P4-AL-24** |
| D-08 | `DATA_MODEL.md` §7 `payment_allocations.reversed BOOLEAN` and `reverse_allocation_journal_entry_id → journal_entries(id)` | a mutable flag on a financial row contradicts "no mutation of historical financial rows"; and the FK is **physically unimplementable** — `journal_entries` PK is `(business_id, id)` (`0042:144`) with no `UNIQUE (id)` | append-only reversal rows, and no domain FK to the journal — **P4-AL-10**, **P4-AL-23** |
| D-09 | `DATA_MODEL.md` §7/§11 `credit_notes.refunded_amount_minor` | the accepted analogue carries only the **remaining pair** (`0065:262-265`); a stored consumed total is a second truth | dropped — **P4-AL-14** (I-25/I-26) |
| D-10 | `DATA_MODEL.md` §14أ `invoice_sequences.current_value BIGINT` | the database contains **zero** PostgreSQL sequences and **zero** counter columns; ordinals are `max+1` under the owning row's lock backed by a UNIQUE (`0060:490-513`, `0059:135,147`) | **P4-AL-31** |
| D-11 | `DATA_MODEL.md` §1 banner "مرحلة تصميم فقط. لا Migrations إنتاجية الآن"; §2 names `business_memberships` / `membership_branch_access`; §18 ERD prints `branches.default_warehouse_id` | 74 frozen migrations; the tables are `memberships` (`0003:45`) and `member_branch_scopes`; §3 of the same document says the warehouse column never existed | stale text; must not be copied into Phase 4 DDL |
| D-12 | `DAFTAR_SECURITY_MODEL.md:20` names permissions `purchase.create` and `reports.view`; `DAFTAR_EXTENSION_READINESS.md:13` says 38 permissions | neither permission exists; the registry holds **46** keys (`packages/domain-core/src/permissions.ts:11-69`) | code wins — **P4-AL-36** |
| D-13 | `PHASE_2_ARCHITECTURE_LOCK.md:647`, `PHASE_2_ACCOUNTING_EXECUTION_PLAN.md:367`, `DAFTAR_SECURITY_MODEL.md:20`, `DAFTAR_GLOSSARY.md:15` all name the permission `sale.create` (singular) | Phase 3 code chose **plural** prefixes for the mirror business-document domains: `purchases.*`, `suppliers.*` (`permissions.ts:62-68`) | plural — **P4-AL-36**, and the four documents are corrected |
| D-14 | `DAFTAR_MULTI_CURRENCY.md` §7.4 names account `1099` "مقاصة عملة" | there is no `1099` in the closed 21-identity registry (`0040:45-66`) | dead text; Phase 4 does not act on it |
| D-15 | `DAFTAR_DESIGN_SYSTEM.md:65` draws the primary button at radius 12–16px and height ≥ 48px; `:58` specifies the whole radius scale one step above what ships | `buttons.tsx:38,10` ship `radius.md` = 8px and `minHeight = TOUCH_TARGET` = 44px; `tokens.ts:76` ships `sm=6, md=8, lg=12, xl=16` | this **is** TD-22(1); repaid narrowly in P4-S7 — **P4-AL-56** |
| D-16 | `tokens.ts:45` names `'Inter'` in the font stack and `DAFTAR_OPEN_DECISIONS.md:14` records OD-06 = Inter | only `@fontsource/tajawal` 400/500/700 is ever loaded (`apps/web/src/app/[locale]/layout.tsx:14-16`) — Inter is named and never loaded | TD-22(2) — **P4-AL-56** |
| D-17 | `DAFTAR_LOCALIZATION.md:27` requires full CLDR pluralization (six Arabic categories) | `apps/web/src/lib/i18n.ts:13-20` has **no plural support at all**; the Phase 3 catalogues use per-category keys | per-category keys in Phase 4; a plural engine is a named follow-up — **P4-AL-51** |
| D-18 | `DAFTAR_LOCALIZATION_GLOSSARY.md:51` gives the canonical Arabic for *statement* as "كشف حساب" | `حساب` is on the Arabic jargon denylist (`scripts/guards/merchant-jargon.ts:46`), which covers `common.` too, so that key would fail `check:localization` | a different Arabic term — **P4-AL-50** |
| D-19 | `DAFTAR_UX_ARCHITECTURE.md:5-8` mandates a 5-item bottom navigation and a web sidebar | the shipped web shell is a collapsing header with proven keyboard and focus behaviour (`tests/browser/flows.ts:57-62,96-109`); there is no bottom bar anywhere | the bottom bar is a mobile pattern; web keeps the header — **P4-AL-53** |
| D-20 | `DAFTAR_DESIGN_SYSTEM.md:35` reserves a `color.whatsapp` token | there is no such token and WhatsApp is Phase 8 | no WhatsApp affordance in Phase 4 |
| D-21 | `DAFTAR_DATA_MODEL.md` §10ب/§13/§14 and `DAFTAR_THREAT_MODEL.md` TH-04 describe `customers`, `sales`, `sale_items`, `invoices`, `invoice_sequences`, `payments`, `payment_allocations`, `payment_reversals`, `refunds`, `customer_credits`, `credit_notes` as if they existed | **none of them exists**, and a permanent test asserts they never will (§4.2) | they are design commitments Phase 4 implements, not facts |
| D-22 | `TECHNICAL_DEBT.md` TD-15 points at "the DM §7 `reverse_payment_allocation` shape" and names one source | DM §7 contains a mutable `reversed` flag, not a command shape; the substantive spec is `ACCOUNTING_RULES.md` §5.2 + §5.4, and the debt's own text names **three** sources (payment, credit allocation, refund) | corrected when TD-15 closes — §21 |

**Nothing in this table was resolved by compromise.** Where two sources disagreed, the higher-ranked
one won outright.

---

## 4. Source-of-truth matrix

**P4-AL-05 — Every Phase 4 quantity has exactly one writer and exactly one reader-of-record.**
The matrix below is the whole of it. A value in the "derived" column may appear in a response, a cache
or a report, and may never be stored in a column that another writer could disagree with.

| quantity | source of truth | derivation | forbidden second truth |
|---|---|---|---|
| a sale's commercial content | `sales` + `sale_items` rows | — | a mirrored copy on `invoices` |
| revenue recognised | `journal_lines` on `4100` bound to the `invoice` source | — | `invoices.revenue_minor` |
| COGS | `journal_lines` on `5000` bound to the `sale` source | — | `sale_items.cogs_minor` as an authority (it is the *input*, see P4-AL-25) |
| on-hand quantity | `stock_levels` written only by `inventory_apply_stock_movements` | — | any sales-side quantity column |
| a customer's AR balance | `journal_lines` on the AR account, scoped to the customer | `customer_ar_outstanding(...)` | `customers.balance_minor` — refused by P4-AL-06 |
| an invoice's paid / outstanding | the invoice total minus the allocations and applied credit notes | `invoice_outstanding(...)` | `invoices.paid_minor`, `invoices.outstanding_minor` |
| a credit note's refundable remainder | the remaining pair on the credit-note row (P4-AL-14) | — | a stored `refunded_amount_minor` |
| a customer credit's remainder | the remaining pair on the credit row | — | a stored consumed total |
| an instalment's due / late status | the schedule row plus a **supplied** as-of date | computed | a stored `status` that a cron must refresh |
| an invoice's settlement state | derived from the above | `invoice_settlement_state(...)` | `invoices.status` beyond lifecycle (P4-AL-24) |
| aging buckets | the AR journal plus a supplied as-of date | computed | a materialised aging table |

**P4-AL-06 — No Phase 4 table carries an authoritative balance, paid, outstanding, due, owed or settled
column, and guard G-3 is extended in P4-S1 so CI proves it.**
This is the one decision in the lock that rests on a defect I reproduced rather than on a reading.
`scripts/guards/no-authoritative-balance.ts` has two discovery arms. Running its own exported functions
over scratch Phase 4 DDL, the supplier arm sees only `purchases`; the inventory arm sees
`customers`, `installments`, `invoices`, `sales`; and `findAuthoritativeInventoryColumns` flags exactly
one column — `customers.balance_minor`. So `invoices.paid_minor`, `invoices.outstanding_minor`,
`customers.amount_due_minor`, `installments.outstanding_minor` and `installments.settled_minor` **all pass
CI today**. G-3 is therefore not a protection Phase 4 inherits; it is a protection Phase 4 must build. The
extension adds a sales arm (`customers`, `sales`, `invoices`, `invoice_items`, `payments`,
`payment_allocations`, `credit_notes`, `refunds`, `customer_credits`, `installment_plans`, `installments`)
discovered from the migrations rather than named, with the same column regex, and its own red proof: plant
`invoices.paid_minor` and require the guard to name it. Until that guard exists, no Phase 4 migration may
be accepted — the ordering matters, because the first Phase 4 migration is exactly where such a column
would be introduced.

**P4-AL-07 — A derived value is read through the product's own function, and that function is the same
one the reconciler and the gate use.**
Phase 3's `purchase_ap_outstanding` (`0072:240-269`) is the precedent: one function, called by the API,
by the reconciliation check and by the performance budget. A second copy of the arithmetic in TypeScript
is a second truth with a slower failure mode, because it disagrees only under the numbers nobody tested.

---

## 5. Entity model

**P4-AL-08 — Nineteen tables, every one of them keyed by `(tenant_id, business_id, …)`.**
`customers`, `customer_contacts`, `sales`, `sale_items`, `invoices`, `invoice_items`,
`invoice_sequences`, `payments`, `payment_methods`, `payment_allocations`, `payment_reversals`,
`allocation_reversals`, `credit_notes`, `credit_note_items`, `refunds`, `customer_credits`,
`customer_credit_applications`, `installment_plans`, `installments`. Every one carries `tenant_id` and
`business_id` as real columns, not as a joinable inference, because both RLS layers read them directly
(`0041`, `0057:140-151`) and because the composite FKs below are only expressible when the child row
carries the business itself.

**P4-AL-09 — Every reference between two commercial rows is a composite foreign key that includes
`business_id`, so cross-business linkage is not representable in the database.**
This is the Phase 3 pattern at `0067:344` + `:394-396`: the parent declares a candidate key that includes
`business_id`, and the child's FK names both columns. Applied to Phase 4 it means
`invoice_items → (business_id, invoice_id)`, `payment_allocations → (business_id, payment_id)` and
`→ (business_id, invoice_id)`, `refunds → (business_id, credit_note_id)`, and so on for every edge.
Three refusals come with it, and each is a refusal of something a canonical document asks for:

- **No polymorphic financial FK.** A `source_type` + `source_id` pair with no FK is how a financial row
  comes to point at nothing. Where Phase 4 needs one-of-N, it uses N nullable typed columns with a
  `CHECK` that exactly one is non-null — the `refunds` shape of P4-AL-15, which is also what makes
  "a refund from a raw payment" unrepresentable rather than merely rejected.
- **No FK from a commercial row to the journal.** `journal_entries`' primary key is `(business_id, id)`
  (`0042:144`) and there is no `UNIQUE (id)`, so `DATA_MODEL.md` §7's
  `reverse_allocation_journal_entry_id → journal_entries(id)` is not implementable; and it should not be,
  because the binding direction is already fixed by `accounting_source_bindings` (P4-AL-20).
- **`MATCH SIMPLE` is not a hole Phase 4 leaves open.** Where a composite FK has a nullable component —
  the walk-in sale of P4-AL-11 — PostgreSQL's default `MATCH SIMPLE` skips the check entirely when any
  column is null, which would let a null `customer_id` carry a foreign `business_id`. Closed by a
  deferred constraint trigger, not by making the column mandatory.

**P4-AL-10 — Financial history is append-only. A reversal is a new row, never a flag on the old one.**
`DATA_MODEL.md` §7's `payment_allocations.reversed BOOLEAN` is refused: a mutable column on a financial
row is the mutation of historical financial data that Phase 2 forbade, and it cannot record *who*
reversed it, *when*, or *under which journal entry*. Phase 4 adds `allocation_reversals` and
`payment_reversals` as rows with their own identity, their own authority and their own journal binding;
"reversed" is a read over their existence. The same rule kills `credit_notes.refunded_amount_minor`
(P4-AL-14) and every `status` column that a later command would rewrite.

**P4-AL-11 — A walk-in sale carries a null `customer_id`, and the null is made safe by a deferred
consistency trigger rather than by a synthetic "walk-in customer" row.**
A synthetic customer is a real row that accumulates a real balance, which is exactly the customer-balance
defect with a friendly name. The null is the honest representation. `payment_allocation_walkin_consistent`
is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger asserting that when `customer_id` is null the
row's `business_id` still matches its parent's, and that no AR line was posted for it — a cash sale to a
walk-in customer never touches AR. Its red proof plants a cross-business `business_id` under a null
`customer_id` and requires the trigger to raise.

**P4-AL-12 — `sales`/`sale_items` and `invoices`/`invoice_items` are two tables and two accounting
sources, not one entity with two names.**
`sales` is the commercial and inventory truth: what left the shelf, at what cost, under source type
`sale`, and its journal entry is the COGS/inventory pair. `invoices` is the revenue and AR truth: what
was billed, at what price, under source type `invoice`, and its journal entry is the revenue/AR/tax set.
Two source types because they are two entries, and two entries because the deferred `*_entry_complete`
validator compares a stored source row against a journal entry as a multiset of line signatures
(`0067:1959-2035`): one row cannot predict both sets. And the COGS entry's Inventory line must be the
stored `value_delta_base_minor` integers so that `R-INV-01` stays an exact integer comparison
(P4-AL-25) — which it cannot be if the same row also has to predict a priced revenue line.

**P4-AL-13 — An installment plan is a schedule over a receivable that already exists. It is never a
second ledger of debt.**
The plan references the invoice; the instalments are dates and amounts; AR is the invoice's AR and is
counted exactly once. `Σ instalments + down payment = invoice total` is enforced by the database, and no
instalment has its own AR line. Collecting an instalment is an ordinary payment allocated to the invoice
— the same command, the same journal, the same reversal path. This is the whole of the installment law,
and the reason it is short is that everything else is already built.

**P4-AL-14 — A credit note and a customer credit each carry a remaining **pair** and nothing else.**
The accepted analogue is `0065:262-265`: the remaining amount in its own currency **and** the remaining
carrying value in base, both reduced together, both reaching exactly zero when the source empties. A
stored consumed total is a second truth; a single remaining figure loses the carrying value and makes a
cross-currency refund cap arithmetically wrong (`100 USD − 90 EUR` is not a number). Partial consumption
leaves both halves proportional; full consumption zeroes both exactly, with the residue flushed at the
last application — the `[[daftar-a-rounded-quotient-is-never-an-input]]` lesson applied to the customer
side.

**P4-AL-15 — `refunds` has exactly one non-null source, and no column that could name a payment.**
Two nullable typed columns — `credit_note_id`, `customer_credit_id` — with a `CHECK` that exactly one is
non-null. There is no `payment_id` column, so refunding a raw payment is not a rejected request; it is an
unwritable row. This is the structural form of GOLD-85, and P4-S5's gate asserts the absence of the
column rather than the presence of a check.


---

## 6. Transaction boundaries

**P4-AL-16 — The atomic sale law: one transaction, or no sale.**
A confirmed sale performs, in one database transaction: the `sales` row and its items; the stock
movements through `inventory_apply_stock_movements`; the `stock_levels` update that routine performs; the
COGS journal entry; the `invoices` row and its items; the invoice number allocation; the revenue/AR/tax
journal entry; and, for a cash sale, the payment, its allocation and the settlement entry. There is no
intermediate state in which stock left the shelf and no invoice exists, or an invoice exists and no
movement was written. A failure anywhere rolls back everything, and the refusal the merchant sees is a
localized sentence, never a partial success.

The boundary is not a convention: `gate:phase4:s2` asserts that the sale path opens exactly one
transaction (P4-AL-57's plan assertion), and G-06 of §17 injects a mid-routine failure and requires the
test to find no partial state. This is the `tests/integration/failure-injection.test.ts` idiom, and it is
the only way "atomic" is a fact rather than an intention.

**P4-AL-17 — One journal entry per allocation, never one per payment.**
`TRANSACTION_MAP.md` §3 and `ACCOUNTING_RULES.md` §4.3 describe one entry per payment. The accepted code
posts one entry per allocation with `source_id = allocation_id` (`0067:362-405`, `0068:480`), and Phase 4
follows it — not for symmetry, but because `accounting_reversals.id = original_entry_id` (§2.3) permits
exactly one whole-entry reversal per entry, forever. A payment allocated over five invoices that posted
one entry could only ever be reversed as a whole; five entries can be reversed one at a time, which is
precisely what "reverse allocation B and leave A untouched" requires. The document's shape would have made
GOLD-66 unimplementable.

**P4-AL-18 — The POS client is never a source of truth. The server recomputes every figure it is sent.**
The client sends product identities, quantities, and a discount *request*. The server resolves prices from
the catalogue, computes line totals, applies the discount under the authority of whoever is logged in,
computes tax (zero, per §13), computes the total, and commits. A total, a unit price, a line total, a tax
amount or a COGS figure arriving from the client is **ignored**, not validated — validation implies the
client's number could be adopted. Where a client-supplied total is present for display reconciliation, a
mismatch with the server's figure is a refusal of the sale with a localized message, and the refusal is
audited with both figures.

The same rule covers the cart: the cart lives on the server, keyed by the till session, and its
recomputation is the P4-B budget. A client-side cart that posts a finished basket is the forged-totals
attack of §12 with no attacker required.

---

## 7. Accounting sources, journal shapes and FX

**P4-AL-19 — Per-line FX arithmetic, and no rounding-adjustment line anywhere in Phase 4.**
`0043:208-245` requires every journal line's base amount to be the exact `HALF_EVEN` conversion of that
line's own transaction amount at that line's own rate. A settlement whose base figures are derived from a
carrying release (P4-AL-21) therefore cannot express its residue as a third line on a rounding account:
the residue belongs to the account that carries it, as a **second, base-only line on that same account**,
exactly as the accepted purchase settlement emits it (`0067:1997-2005`). `ACCOUNTING_RULES.md` §5.2's tidy
three-line example (`Dr Bank / Cr AR / Cr FX Gain`) passes only because its numbers are tidy; the
deferred `*_entry_complete` validator refuses it on the first non-tidy number. There is no
`rounding_difference_minor` column on any Phase 4 table and no `6100` line in any Phase 4 journal shape.
`classifyRoundingResidual` (`packages/accounting/src/rounding.ts:71`) stays unreachable from any product
path and Phase 4 does not reach it.

**P4-AL-20 — Phase 4 registers six new accounting source types, each with both bindings and a deferred
completeness validator.**
`sale`, `invoice`, `payment_allocation`, `credit_note`, `refund`, `allocation_reversal` — registered in
`accounting_source_types`, with their operation kinds in `accounting_operation_kinds`, and with the two
`DEFERRABLE INITIALLY DEFERRED` foreign keys in `accounting_source_bindings` that give "no orphan journal,
no orphan source" in both directions. Each gets a `*_entry_complete` deferred constraint trigger in the
`0067:1959-2035` form: it reads the stored source row, computes the line signatures the row implies, and
compares them to the entry's actual lines as a **sorted multiset**. This is what makes a journal shape an
invariant rather than a test: a line added by any future writer, in any future migration, is refused at
commit time.

The `registered_by` column on the Phase 3 registries is pinned by four `CHECK (registered_by ~
'^P3-S[0-9]+$')` constraints (`0054:54`, `0059:53`, `0059:59`, `0059:69`). The first Phase 4 migration
that registers anything therefore **fails** unless the pattern is widened. It is widened to
`^P[0-9]+-S[0-9]+$` in the first Phase 4 migration, with the existing rows unchanged, and the widening is
itself asserted: a `P4-S1` registration must be accepted and a `garbage` registration must still be
refused. This is a blocker discovered independently by three agents and it is the single most likely cause
of a red first Phase 4 CI run.

**P4-AL-21 — Customer-side settlement uses the carrying-release law, unchanged.**
`rel(X, a) = HALF_EVEN(B·(X+a)/T) − HALF_EVEN(B·X/T)` (`0067:683-694`), where `X` is the amount already
released, `a` the amount being released now, `B` the source's base carrying value and `T` its transaction
total. It is not `conv(a)`, and the difference is the whole point: the releases telescope so that the last
one empties the source exactly, with no residue left behind and none invented. The chain is verified by a
Phase 4 twin of `purchase_settlement_verify` (`0067:717-758`), which checks both that each release's
stored `x` equals the recomputed `before` and that `Σ rel` equals `HALF_EVEN(B·Σ/T)`.

This is where Agent A's counterexample lands, and it is real. With `T = 3`, `B = 10` and two allocations
of 1 each (releases of 3 then 4), reversing the **first** leaves the survivor's stored `x = 1` against a
recomputed `before = 0`, so the chain check raises; and `Σ rel = 4` against `HALF_EVEN(10·1/3) = 3`, so AP
— here AR — is off by one base minor unit on an otherwise correct transaction. Mid-chain reversal is
therefore **not** a mechanism the lock may assume; it is `OD-P4-04` of §22 and it is the one hard blocker
on P4-S6 and on TD-15.

**P4-AL-22 — Level-uniqueness is how a source cannot be double-spent.**
`UNIQUE (business_id, <source>_id, <source>_remaining_before_minor)` (`0067:441`, `:497`) applied to
`payment_allocations` over the payment, to `customer_credit_applications` over the credit, and to
`refunds` over the credit note. Two concurrent consumers reading the same remaining value cannot both
commit, whatever the isolation level, because they would write the same tuple. This is a database
invariant and it holds against a direct SQL attacker, which a `FOR UPDATE` in a routine does not.

Its known cost is recorded honestly: the constraint also caps an operation that legitimately needs several
rows at one remaining level — `[[daftar-a-unique-tuple-is-not-a-source-proof]]`. Phase 4's split
allocation writes one row per invoice at **successive** remaining levels, so the cap is not reached; a
future operation that needs several rows at one level must change the mechanism, not drop the constraint.

**P4-AL-23 — No Phase 4 table holds a foreign key to `journal_entries`, and no journal entry holds a
foreign key to a Phase 4 table outside `accounting_source_bindings`.**
The binding table is the only edge, in both directions, and it already carries the deferred pair. A second
edge is a second truth about which entry belongs to which source, and — as P4-AL-09 notes — the one the
document asks for is not even implementable.

**P4-AL-24 — `invoices.status` is lifecycle only. Settlement state is derived, and voiding is a compound
command.**
`purchases.status` is the precedent: lifecycle (`draft`, `open`, `void`), never settlement. So there is no
`paid` status written by a payment; `invoice_settlement_state(...)` derives `unpaid` / `partial` / `paid`
from the allocations and applied credit notes. `TRANSACTION_MAP.md` §1's "Invoice (status=paid)" is
withdrawn, as `SOURCE_OF_TRUTH_MATRIX.md` §1 already says it should be.

`STATE_MACHINES.md` §2 permits `open → voided` only "with no active payments" and then defines a
`void_invoice` command for exactly the case it forbade. The compound command is the substantive
specification: a direct `UPDATE invoices SET status='void'` is **refused** by a trigger, and voiding a
paid invoice is one transaction that reverses the revenue entry once, reverses the inventory entry,
returns the stock, and issues the refund from the credit-note source only. The final state is: invoice
void, revenue reversed exactly once, AR zero, and cash net movement equal to what the customer actually
gets back.

**P4-AL-25 — The COGS entry's Inventory line is the stored `value_delta_base_minor` integers, summed.**
Not a recomputation from quantity × average cost. The movement rows already hold the exact integer value
delta the stock writer computed; summing them makes `GL(1200) = Σ(qty × avg)` an exact integer identity
that `R-INV-01` can assert, and removes the second rounding that a recomputation would introduce —
`[[daftar-rounding-is-not-additive]]`. Where the sum of per-line COGS differs from the posted total after
`HALF_EVEN`, the difference is distributed across the lines, once, at the line grain, with no
intermediate rounding.

**P4-AL-26 — `paid + outstanding = total` is a derived identity verified by reconciliation, not a row
`CHECK`.**
`ACCOUNTING_RULES.md` §364 INV-ACC-02 mandates it as a row `CHECK`, which requires the two columns
P4-AL-06 forbids — and which guard G-3, once extended, will fail CI over. The identity is real and is
asserted in three places: the deferred completeness validator for the invoice source, the reconciliation
check `R-SAL-02`, and golden G-14 after every step of a sequence of partial payments. What is withdrawn is
the *mechanism*, not the rule. `[[daftar-a-closure-rule-is-not-an-invariant]]` applies in the other
direction here: an identity over derived values is not expressible as a constraint on one row, and
pretending otherwise is how the stored column gets introduced.

---

## 8. Inventory authority

**P4-AL-27 — Phase 4 reuses the `invctl/1` command assertion with new operation kinds, and mints no
fourth signing key.**
`inventory_assertion_consume` (`0054:344-480`) parses only the literal `invctl1` (`0054:500`), and it is a
frozen migration. A `salectl/1` protocol would require either a new consume routine — a second authority
path over the stock writer — or an edit to a frozen migration. Neither is available, and neither is
wanted: `[[daftar-two-protocols-one-secret]]` says two protocols over one secret are separated by disjoint
preimages, and the cheaper, safer separation here is no second protocol at all. New operation kinds are
registry rows (`0060:186` is data-driven), which is precisely the extension point the Phase 3 design left
open.

**P4-AL-28 — The Phase 4 operation-code namespaces are `sale.*`, `customer.*` and `customer_payment.*`.**
`payment.*` is already taken by the payment-method kinds, so a `payment.reverse` code would collide with
an existing namespace. `customer_payment.collect`, `customer_payment.allocate`,
`customer_payment.reverse`, `customer_payment.reverse_allocation`, `sale.commit`, `sale.void`,
`sale.return`, `customer.credit_note`, `customer.refund`, `customer.credit_apply`. Each is a registry row
with its own authority, and the single-use `jti` of `0054:344-480` gives replay protection at the
assertion layer independently of P4-AL-30's document-level idempotency.

**P4-AL-29 — A sale writes stock only through `inventory_apply_stock_movements`, and the routine is not
changed.**
`0060:487` is the only stock writer and the reason `R-INV-01…05` can be trusted. A sale is a new operation
kind consumed by the existing routine, with negative quantities and the average-cost path the routine
already implements. The writer principal stays `daftar_inventory_internal`; Phase 4 grants it nothing new
beyond EXECUTE on its own new wrappers, and the resulting concentration of authority in one NOLOGIN role
is recorded as new technical debt in §21 rather than silently accepted.

Oversell is **not** enabled by this decision, and enabling it would mean changing that routine — the
highest-risk change available in the system. See `OD-P4-05`.


---

## 9. Idempotency and sequencing

**P4-AL-30 — Idempotency is a caller-supplied document UUID plus a stored `intent_sha256`, read before any
other read, under a per-document advisory lock. There is no `idempotency_key` column.**
`DATA_MODEL.md` §17 mandates `idempotency_key` with `UNIQUE(business_id, idempotency_key)` on `payments`,
`refunds` and their supplier twins. No commercial table has such a column; the only one in 74 migrations is
on `onboarding_operations` (`0018:7`). The accepted mechanism is the document's own UUID as its identity
plus `intent_sha256` over the request's meaning (`0067:339`, `0068:588-611`), and it is better for a
specific reason: a bare key proves a request was seen before and says nothing about *which* request it
was, so a replay carrying the same key and different content would be answered "success" —
`[[daftar-idempotency-key-is-not-permission]]`.

Two ordering rules are part of the decision, not decoration:

- **The registry is consulted before current state.** `[[daftar-registry-before-state]]`: a stale request
  replayed after a later transition, whose handler reads state first, performs a second real change. The
  first read of every Phase 4 command is the document row and its `intent_sha256`.
- **The command does not read the clock.** `[[daftar-a-command-must-not-read-the-clock]]`: no Phase 4
  routine contains a `coalesce(p_date, current_date)`. A date a fingerprint covers is supplied by the
  caller and is part of the intent; a routine that resolves it server-side is not idempotent, and closing
  that seam in the DTO, the schema, the service and the engine is not closing it while the trusted database
  command still defaults.

Replay is refused **at the database** by a real `UNIQUE` over real columns, per command, with the duplicate
reversal additionally blocked by a partial unique on `(business_id, provider_source,
provider_reference)` — so a replayed payment-provider webhook is refused physically, not by an application
check.

**P4-AL-31 — Invoice and credit-note numbers are allocated as `max + 1` under the sequence row's lock,
backed by a `UNIQUE`. There is no counter column and no PostgreSQL sequence.**
`DATA_MODEL.md` §14أ specifies `invoice_sequences.current_value BIGINT`. The database contains zero
sequences and zero counter columns; ordinals are allocated as `max + 1` under the owning row's lock with a
`UNIQUE` behind them (`0060:490-513`, `0059:135,147`). Three reasons, and the third is the decisive one:
a stored counter is a derived number and therefore a second truth; a PostgreSQL sequence is
non-transactional and leaves gaps on rollback, which a legal document number may not have; and a counter
column takes **the same lock** as `max + 1`, so it buys no concurrency whatever — it only adds a value that
can disagree with the rows.

Gaplessness follows from in-transaction allocation: a rolled-back sale takes its number with it, because
the number was never committed. `invoice_sequences` exists as a row per `(business_id, document_kind,
period)` to be the lock and to hold the format, not to hold the count.

Per-business isolation is structural: the sequence row's key includes `business_id`, so two businesses of
one tenant have two independent series and no tenant-level mixing is expressible (GOLD-48).

**P4-AL-32 — The sequence row is the last lock a sale takes.**
The sequence row is business-wide: every sale in the business contends on it. Taking it first would put a
business-wide lock in front of the per-product and per-customer locks and serialise the whole till on the
slowest sale. It is therefore step 8 of the sale — after the stock levels, after the customer, after the
journal — so the window in which it is held is the shortest possible. This is a lock-order decision and it
is part of the single declared order of P4-AL-41.

---

## 10. State machines

**P4-AL-33 — Five state machines, each with its transitions enumerated in a table the database enforces.**

| entity | states | transitions | enforced by |
|---|---|---|---|
| `sales` | `draft → confirmed → (returned_partial \| returned_full)`; `confirmed → void` | no path back to `draft`; no direct edit of a `confirmed` row | a transition trigger reading the enumerated table |
| `invoices` | lifecycle `draft → open → void` only | settlement is **derived**, never a state (P4-AL-24) | trigger + the refusal of a direct `status` update |
| `payments` | `pending → completed`; `completed → reversed` | **no** `completed → refunded` (P4-AL-34) | the enumerated table; the absence is asserted |
| `credit_notes` | `issued → (partially_refunded \| fully_refunded)` as **derived** display; the row's own lifecycle is `issued → void` | the remaining pair is the truth, not a state | the pair, plus a derivation function |
| `installment_plans` | `active → (completed \| cancelled)`; an instalment is `scheduled → collected`, with `due`/`late` **derived as of a supplied date** | no cron writes a status | the plan's constraint plus a pure function |

**P4-AL-34 — There is no `completed → refunded` transition on a payment. "Refunded" is a derived display
state.**
A refund does not undo a payment; it is a separate outward movement from a credit note or a customer
credit. Modelling it as a payment state would make the payment's own history mutable and would let a
refund and a reversal — which are genuinely different operations with genuinely different journals
(G-10 versus G-11) — collapse into one path. The absence of the transition is asserted structurally by
`gate:phase4:s6` and by golden G-17, and G-11's red proof is exactly the merge of the two paths: the
cash-unchanged assertion and the cash-reversed assertion cannot both pass on one path, which is the proof
they are two operations.

---

## 11. Authority, permissions, RLS and the physical writer model

**P4-AL-35 — The authority matrix. Every Phase 4 command names its permission, its sensitivity and the
roles that may hold it.**

| command | permission | sensitive | Owner | Manager | Accountant | Cashier |
|---|---|---|---|---|---|---|
| POS read / search | `sales.view` | no | ✔ | ✔ | ✔ | ✔ |
| commit a cash sale | `sales.create` | no | ✔ | ✔ | — | ✔ |
| commit a credit sale | `sales.create` + `receivables.view` | no | ✔ | ✔ | — | by grant only |
| apply a line or cart discount | `sales.discount` | **yes** | ✔ | ✔ | — | by grant only |
| void an invoice | `sales.void` | **yes** | ✔ | by grant | — | — |
| return goods / issue a credit note | `sales.return` | **yes** | ✔ | ✔ | — | by grant only |
| approve a refund | `refunds.approve` | **yes** | ✔ | by grant | — | — |
| collect a payment | `payments.collect` | no | ✔ | ✔ | ✔ | ✔ |
| reverse a payment or an allocation | `payments.reverse` | **yes** | ✔ | by grant | ✔ | — |
| view / manage customers | `customers.view` / `customers.manage` | no / no | ✔ | ✔ | ✔ | view |
| view receivables, debts, statements | `receivables.view` | no | ✔ | ✔ | ✔ | — |
| create or amend an installment plan | `installments.manage` | **yes** | ✔ | by grant | ✔ | — |

"by grant only" means the key is not in the role's default set and must be delegated explicitly, within
the delegator's `beyondGrantAuthority` ceiling. The cashier's default set is deliberately the narrowest
thing a till needs: read, sell for cash, and take money. Everything that moves value outside that flow is
a delegation with an audit record.

**P4-AL-36 — Twelve permission keys, plural-prefixed, added to the closed registry.**
`sales.view`, `sales.create`, `sales.void`, `sales.return`, `sales.discount`, `customers.view`,
`customers.manage`, `payments.collect`, `payments.reverse`, `refunds.approve`, `receivables.view`,
`installments.manage` — taking the registry (`packages/domain-core/src/permissions.ts:11-69`) from 46 keys
to 58. Plural, because Phase 3 chose plural for the mirror business-document domains (`purchases.*`,
`suppliers.*`, `:62-68`), and four canonical documents naming `sale.create` singular
(`PHASE_2_ARCHITECTURE_LOCK.md:647`, `PHASE_2_ACCOUNTING_EXECUTION_PLAN.md:367`,
`DAFTAR_SECURITY_MODEL.md:20`, `DAFTAR_GLOSSARY.md:15`) are corrected rather than followed. The documents
also name `purchase.create` and `reports.view`, neither of which exists, and
`DAFTAR_EXTENSION_READINESS.md:13` says there are 38 permissions when there are 46 — the registry is the
authority (P4-AL-04 rank 1) and the documents are wrong.

**P4-AL-37 — "Sensitive" means value-moving outside the normal operating flow.**
Not "everything except a read". The distinction is load-bearing because the role-default constraints
(`0041:57-65`, `0057:140-151`) forbid granting a sensitive key to a role by default: a definition under
which `sales.create` is sensitive would make the cashier role unconstructible, and a definition under which
nothing is sensitive would let a cashier void a paid invoice. Taking cash for a sale is the normal flow and
is not sensitive; discounting, voiding, returning, refunding, reversing and rescheduling a debt are value
movements outside it and are.

**P4-AL-38 — RLS is layered exactly as Phase 2 and 3 layer it, and `daftar_app` gets no DML on any Phase 4
table.**
`ENABLE ROW LEVEL SECURITY` **and** `FORCE`; one permissive tenant policy; four `RESTRICTIVE` per-command
isolation policies. `daftar_app` holds `SELECT` and `EXECUTE` and nothing else, so every write goes through
a routine whose authority was checked — `[[daftar-wrapper-is-not-an-invariant]]` is closed by the grant, not
by the wrapper. Two consequences the lock states explicitly:

- A policy is written for correctness first and shaped for cost second, and an RLS helper never carries a
  `SET` clause — `[[daftar-a-set-clause-is-a-planner-barrier]]`: PostgreSQL refuses to inline **any**
  function with a `SET` clause, so pinning `search_path` on a per-row helper is a per-row cost. A
  SQL-standard body removes the need for the clause instead of removing the protection.
- A migration that reshapes an existing policy reads `pg_policy` and asserts before and after that the same
  principals are admitted — `[[daftar-the-live-catalogue-is-the-policy]]`.

**P4-AL-39 — `EXECUTE` on a definer routine is new authority, so every Phase 4 definer routine verifies a
signed server decision.**
`[[daftar-execute-is-reachability-not-authority]]`: granting `EXECUTE` to `daftar_app` makes the routine
reachable by anything holding an app connection, so the routine may not trust an application-side check or
a GUC. It verifies the signed accounting assertion, or the `invctl/1` inventory assertion, or both. And a
trigger that authorizes by `current_user` is `SECURITY INVOKER`, never definer —
`[[daftar-a-guard-that-asks-who-must-run-as-the-writer]]`: a definer-rights guard always sees its own
owner and therefore always says yes.

Privileges are set **before** ownership is handed over, and the migration asserts its own model against
the live catalogues — `[[daftar-grant-before-owner]]`: a `GRANT` issued without grant option warns and
commits rather than raising, so an ordering mistake produces a green migration and a missing privilege.

**P4-AL-40 — Branch scope is enforced at the same place tenant scope is, and a till is bound to a branch.**
A POS session carries the branch; a sale, a payment and a cash movement are scoped to it; a user whose
`member_branch_scopes` do not include the branch is refused by the policy, not by the controller. The
branch-scope bypass of §12 is a scenario with a named owner precisely because the temptation is to check it
in the service layer.


---

## 12. Concurrency, lock order, and the abuse scenarios

**P4-AL-41 — One declared lock order for the whole of Phase 4, statically checked, with a permanent
deadlock proof.**

1. `businesses` (the scope row, shared)
2. `customers` — the customer whose balance is affected
3. `invoices` — ascending by `id` where several are touched
4. `payments` / `credit_notes` / `customer_credits` — the consumed source
5. `stock_levels` — ascending by `(warehouse_id, variant_id)`
6. `journal_entries` — through `accounting_post_entry`, which takes its own locks in its own fixed order
7. `installment_plans`
8. `invoice_sequences` — **last** (P4-AL-32)

A static check reads each routine's acquisition sequence and compares it against this list;
`gate:phase4:s8` runs every pair of lock-taking commands in both orders N times and requires zero
deadlocks. `[[daftar-lock-order-not-retry]]`: two connections used in sequence are not contention, so a
deadlock is a lock-order defect and is fixed by changing the order — never by a retry loop, never by
`SET deadlock_timeout`, and never by treating the deadlock as a business outcome the caller should handle.

**P4-AL-42 — A concurrency verdict is produced by injected interleaving, never by timing.**
Both orderings are forced by parking one transaction and detecting the park through `pg_stat_activity`, the
`tests/security/stock-ledger-concurrency.test.ts:6-12` idiom. `[[daftar-a-test-whose-verdict-is-the-machines-speed]]`:
FI-11 passed on a slow host and failed on a fast one and proved nothing either way. No Phase 4 concurrency
test contains a sleep.

**P4-AL-43 — The twelve abuse and race scenarios, each with an owning slice and a named mechanism.**

| # | scenario | mechanism that refuses it | owner |
|---|---|---|---|
| 1 | two sales of the last unit | `FOR UPDATE` on the level row inside the only stock writer, plus the physical non-negative constraint | S2 |
| 2 | concurrent invoice numbering | `max + 1` under the sequence row's lock behind a `UNIQUE` (P4-AL-31) | S1 |
| 3 | concurrent allocation of one payment | level-uniqueness (P4-AL-22) | S4 |
| 4 | concurrent refunds on one credit note | level-uniqueness + the cap check **inside** the source's `FOR UPDATE` | S5 |
| 5 | forged client totals | the server recomputes and ignores client figures (P4-AL-18) | S3 |
| 6 | a replayed sale, payment or webhook | document UUID + `intent_sha256` + the single-use `jti` + the provider-reference partial unique (P4-AL-30) | S2, S4 |
| 7 | cross-tenant read or write | RLS tenant policy + the four restrictive policies, asserted per route (G-02) | S1, every slice |
| 8 | cross-business linkage | composite FKs (P4-AL-09), asserted by direct SQL (G-03) | S1 |
| 9 | branch-scope bypass | the policy, not the controller (P4-AL-40) | S1 |
| 10 | permission escalation through delegation | the closed registry, the role-default constraints, and the `beyondGrantAuthority` ceiling (P4-AL-36, P4-AL-37) | S1 |
| 11 | double revenue reversal on a return then a void | one whole-entry reversal per entry, ever (P4-AL-47); the void's refund is drawn from the credit-note source only | S5, S6 |
| 12 | an allocation left stale by a payment reversal | the reversal and the allocation reversal are one transaction — the substance of TD-15 (§21) and blocked by `OD-P4-04` | S6 |

---

## 13. The tax boundary (OD-03)

**P4-AL-44 — Sales tax is structurally zero in Phase 4, refused at three layers, and the boundary is
designed for sales rather than copied from purchases.**
The Phase 3 pattern is `purchases_tax_policy_absent_ck CHECK (tax_minor = 0)` (`0063:233`) plus the
`purchase.tax_policy_absent` refusal (`0064:745`). Phase 4 takes the pattern and not the policy, because
sales tax differs from purchase tax in ways that are exactly the ways OD-03 is open:

- a purchase's tax is a *recoverability* question about an input; a sale's tax is a *liability* question
  about an output, and the liability lands on a different account and in a different return;
- a sale is the document a jurisdiction's invoice-content law applies to — the legal invoice fields, the
  registration number, the tax breakdown by rate — and no such law is known here;
- inclusive versus exclusive pricing changes the **line total the merchant types**, not just a derived
  figure, so guessing it would silently change what the customer is charged;
- a sale can be to a registered or an unregistered customer, and in some jurisdictions to an exempt one, and
  that distinction has no representation in the data model yet.

So Phase 4 ships: `invoice_items.tax_minor` and `invoices.tax_minor` as real columns with
`CHECK (tax_minor = 0)`; a `sale.tax_policy_absent` refusal from the command when a non-zero tax is
requested, with a localized merchant-safe message; an `2100 Tax Payable` account that exists and never
moves; and a journal shape that already has the tax line's place in it. Enabling non-zero tax is then one
migration that drops one `CHECK` plus a country pack — not a re-modelling.

**P4-AL-45 — No country's tax law is researched, guessed or encoded in P4-S0, and OD-03 is not closed.**
Not the VAT rate, not the inclusive/exclusive rule, not the registration threshold, not an exemption, not
recoverability, not the legal invoice fields. OD-03 remains open and is carried forward unchanged. A
non-zero sales tax may be enabled only by an approved Country Pack backed by official legal and tax
sources, and that approval is the Tech Lead's and the owner's, not an engineering decision.

---

## 14. The correction model

**P4-AL-46 — A commercial mistake is corrected by a new document, never by editing the old one.**
A wrong sale is voided or returned; a wrong payment is reversed; a wrong credit note is voided and
reissued. There is no `UPDATE` path on a confirmed financial row, and the triggers that refuse the direct
paths are part of the slice that introduces the table, not a later hardening step.

**P4-AL-47 — One whole-entry reversal per journal entry, forever, and Phase 4 does not widen it.**
`accounting_reversals.id = original_entry_id` makes it a physical fact (§2.3). Its three consequences shape
Phase 4 rather than constrain it: entries are minted at the grain at which they may need to be reversed
(P4-AL-17); a partial correction is a new entry, not a partial reversal; and a domain-specific reversal
that needs its own source identity uses the `accounting_reversals_20_domain_source_guard` carve-out pattern
(`0067:2242-2271`) rather than a second reversal table.

---

## 15. Audit, outbox and reconciliation

**P4-AL-48 — Every Phase 4 command writes an audit row in the same transaction as its effect.**
Actor, permission exercised, delegation if any, the document's UUID, the `intent_sha256`, the branch, the
till session, and — for a refused command — the refusal code and the figures that caused it. A refusal is
audited as heavily as a success, because the forged-total and over-cap attempts are the ones worth seeing.
The audit is a record, never a source: no reconciliation check reads it.

**P4-AL-49 — The outbox is not a financial source, and reconciliation checks are `R-SAL-01…07` added to
the existing pass.**
A delivery record may not be the thing that proves a payment happened. The reconciliation checks:

| id | identity |
|---|---|
| `R-SAL-01` | AR from the journal = Σ(invoice totals) − Σ(allocations) − Σ(applied credit notes), per customer **and** in total |
| `R-SAL-02` | per invoice, `paid + outstanding = total` in the invoice's own currency (P4-AL-26) |
| `R-SAL-03` | revenue from the journal = Σ(invoice line revenue), and each invoice's revenue posted exactly once |
| `R-SAL-04` | `2200` = Σ(open refund liability); `2210` = Σ(customer-credit remainders) |
| `R-SAL-05` | tax payable = Σ(line tax) = 0 while P4-AL-44 holds — an identity that will still be true when it stops being zero |
| `R-SAL-06` | every installment plan: Σ instalments + down = invoice total; Σ collected ≤ total |
| `R-SAL-07` | no journal entry bound to a Phase 4 source lacks its source row, and no source row lacks its entry — the bindings' own claim, re-asserted over data |

Each runs on a `daftar_reconciler` read-only connection, through the product's own reconciler, as one pass
over its relation rather than per row. `R-INV-01…05` are **not** re-implemented; they are re-run with
sale-driven movements in the ledger, and whether any of them was written assuming purchase-only movement
sources is a real risk recorded in §20.


---

## 16. API boundaries, POS and merchant UX, localization

**P4-AL-50 — No Phase 4 string uses a term on the Arabic jargon denylist, and *statement* is not
"كشف حساب".**
`DAFTAR_LOCALIZATION_GLOSSARY.md:51` gives "كشف حساب" as the canonical Arabic for a customer statement.
`حساب` is on the denylist in `scripts/guards/merchant-jargon.ts:46`, and the guard covers the `common.`
namespace, so that key would fail `check:localization`. Phase 4 uses a merchant term for the screen —
"سجل العميل" / "حركة العميل" for the statement, "المستحقّ" for what is owed — and the glossary entry is
corrected. The glossary is rank 6; the guard is code.

**P4-AL-51 — Plurals are per-category keys, not a CLDR engine.**
`DAFTAR_LOCALIZATION.md:27` requires full CLDR pluralization with the six Arabic categories.
`apps/web/src/lib/i18n.ts:13-20` has no plural support at all, and the Phase 3 catalogues work by naming a
key per category. Phase 4 does the same. A plural engine is a real improvement and a named follow-up; it is
not a Phase 4 deliverable, and implementing it inside a sales slice would put a i18n runtime change in the
same PR as the money.

**P4-AL-52 — The merchant-jargon guard and the browser gate's tax rule are extended to the Phase 4
namespaces in P4-S1, before the first POS screen exists.**
This is the second protection Phase 4 must build rather than inherit, and I verified it directly.
`scripts/guards/merchant-jargon.ts:40-50,60-70,118-130` scopes its web-file arm to paths matching
`(stock|purchases|suppliers)`, so a `pos/` or `customers/` file is simply not examined. And
`tests/browser/invariants.ts:200-216`'s `acctRe` matches a bare `tax` and drives the `tax-control` rule —
which is exactly the OD-03 boundary check — but only on the screens the gate walks. A POS screen merged
today would be unguarded for jargon **and** for the tax boundary, and both guards would stay green while
saying nothing.

So: `S7_NAMESPACE_PREFIXES` and `isS7WebFile` gain the Phase 4 namespaces (`pos`, `sales`, `customers`,
`invoices`, `payments`, `refunds`, `installments`, `debts`), each with a planted-defect red proof, and the
browser gate's step set gains the Phase 4 screens (§17) so `tax-control` actually fires on them. No journal
terminology, no account number, no ledger internal, no implementation key and no raw error code reaches a
merchant screen, and every error is a localized merchant-safe sentence in all three locales.

**P4-AL-53 — The web shell keeps its header. There is no bottom navigation bar.**
`DAFTAR_UX_ARCHITECTURE.md:5-8` mandates a five-item bottom bar and a web sidebar. The shipped shell is a
collapsing header with proven keyboard and focus behaviour (`tests/browser/flows.ts:57-62,96-109`), and
there is no bottom bar anywhere in the repository. A bottom bar is a native mobile pattern; the Android POS
is Phase 7 and will make its own decision. Replacing a shell with proven accessibility behaviour in order to
satisfy a document is a regression dressed as compliance.

**P4-AL-54 — No Phase 4 API response contains a journal entry id, an account code, a journal line, a
routine name, a GUC, a constraint name or a raw SQL error.**
A refusal is a stable machine code plus a localized message; the code is documented for integrators and the
message is what the merchant reads. The reason this is an API decision and not a UX one is that a leaked
account code in a JSON response becomes a screen's content the moment anyone renders the field, and the
jargon guard cannot see through a network boundary.

**P4-AL-55 — POS is web-first in Phase 4. The Android application gains no POS screen.**
The Android app remains what it is; a production Android POS with offline capability is Phase 7 and is on
the out-of-scope list of §20. The `android` CI job must stay green, so Phase 4 touches the Kotlin sources
only if a shared string catalogue forces it.

**P4-AL-56 — TD-22 is bound to P4-S7 and repaid narrowly: the design-system document is corrected to the
shipped tokens, and the Inter reference is removed.**
`DAFTAR_DESIGN_SYSTEM.md:65` draws the primary button at 12–16px radius and ≥ 48px height; `buttons.tsx:38,10`
ship `radius.md` = 8px and `minHeight = TOUCH_TARGET` = 44px, and `tokens.ts:76` ships `sm=6, md=8, lg=12,
xl=16` — the whole scale is one step below what the document draws. `tokens.ts:45` names `'Inter'` in the
font stack and OD-06 records it, while only `@fontsource/tajawal` is ever loaded
(`apps/web/src/app/[locale]/layout.tsx:14-16`). Both halves are repaid by correcting the **document** to the
shipped tokens and by removing the unloaded font name — not by changing every button in the product during a
sales phase. TD-22 is evaluated here and fixed in P4-S7, and P4-S0 changes no component.

---

## 17. Gates, golden tests, browser coverage, performance and the harness

### 17.1 The gate estate

**P4-AL-57 — `gate:phase4:s1` … `gate:phase4:s8` plus `gate:phase4:release`, closing at P4-S9.**
Each slice gate composes its predecessor; `gate:phase4:s1` composes `gate:phase3:corrective` and through it
the entire accepted chain, plus `check:migrations`, `check:guards`, `check:localization`,
`check:deployment-authority` and the two prefix modules. Every gate: runs the runner canary **before**
trusting any result and refuses the matrix if the runner cannot report failure
(`[[daftar-a-green-gate-must-prove-it-can-be-red]]`); runs structural checks before any suite; carries
explicit `SUITES` / `COMMANDS` / `RED_PROOFS` / `BUDGETS` tables in which a `{ pending }` row is a **FAIL**
and never a skip, a listed suite that is missing or carries `.skip`/`.only`/`.todo` fails, and a `p4-*`
suite on disk that no entry lists fails; supports `--list`, `--root` and `--structural-only`; and writes
machine-readable evidence. `gate:phase4:release` composes `gate:phase3:release` and `gate:phase4:s8`
verbatim, adds only the closure's own business, must run from an extracted archive, and fails before running
anything if any `RELEASE_GATE_SKIP_*` is set.

**P4-AL-58 — Predecessor gate steps stay visible in CI even though the successor composes them.**
`ci.yml:257-262` records the reason: when a predecessor breaks, a reviewer should see **which** one failed in
the step list rather than reading the log of a gate that contains all of them.

**P4-AL-59 — Phase 4 adds no CI job and renames none.**
Job names are the required-checks keys and that configuration lives in repository settings, outside the tree
(`ci.yml:6-7`) — no gate can verify it, so nothing touches it. Phase 4's work goes into steps of `backend`
and `browser`; the only new workflows are the dispatched `phase4-s8-evidence.yml` and
`phase4-s9-release.yml`, which are not required checks.

### 17.2 The migration prefix invariant

**P4-AL-60 — Phase 4's migration history is protected as a frozen prefix, never as a bound.**
`scripts/phase4-prefix.ts`, the twin of `scripts/phase3-prefix.ts`: `PHASE4_PREFIX` as a **literal copy** of
the accepted `[name, sha256]` pairs from `0074` onward, with per-slice sub-prefixes preserving provenance,
and `MANIFEST_OFFSET = PHASE2_PREFIX.length + PHASE3_PREFIX.length` imported rather than hard-coded. It
asserts: the accepted files exist and hash to their accepted digests; the files in the prefix range on disk
are exactly the accepted names in order; the manifest entries at the offset are the accepted pairs and no
later entry sorts into the range; and **`frozenThrough >= prefix end` as a floor**. Migrations after the
prefix are permitted and not examined. `[[daftar-a-closure-rule-is-not-an-invariant]]`: **no permanent gate,
and no line of `scripts/phase4-prefix.ts`, may contain a sentence of the form "nothing after N"** — the
P2-S9 mistake that blocked the P3-S1 seal and cost a correcting commit.

**P4-AL-61 — A candidate-tense migration boundary lives only in the gate of the slice currently open, and
is deleted by that slice's acceptance commit.**
While a slice is a candidate its gate asserts `frozenThrough` **exactly** at the previous slice's head, the
files after it exactly the candidate list, and none of them in the manifest. The acceptance commit fills
`S<N>_ACCEPTED`, appends to `PHASE4_PREFIX`, and **removes** the candidate-tense assertions in the same
change.

**P4-AL-62 — Forward evolution is proved by a permanent suite, not by prose.**
`tests/security/phase4-forward-evolution.test.ts` copies the tree, adds a synthetic successor migration
numbered one past the **current** head (never hard-coded `0074`) with a manifest entry and an advanced
`frozenThrough`, and requires **every** accepted permanent gate to still PASS in `--structural-only --root
<scratch>` mode. It also greps every accepted gate for the three forbidden shapes: a `.sql` count compared to
a literal, a last-file-name comparison, and a `frozenThrough ===` equality. Owned by `gate:phase4:s1`,
composed by every later gate, so the property is re-proved on every push for the rest of the project's life.
Its red proof is a fixture gate in the scratch tree that *does* assert "nothing after N" and must make the
suite fail.

### 17.3 The two Phase 3 couplings that must be resolved before any Phase 4 screen

**P4-AL-63 — `gate:phase3:corrective` is pinned to the Phase 3 browser steps before the first Phase 4 step
is added.**
`scripts/phase3-corrective-gate.ts:507-513` runs the full-matrix browser step with **no `--steps`**, so it
runs every step in `flows.ts`. The moment Phase 4 adds a step, a Phase 4 screen defect turns a **Phase 3**
gate red — and `flows.ts` exports no step registry, so the Phase 3 gate cannot currently pin itself.
Resolution: `flows.ts` exports `PHASE3_STEPS` (the 15 current names) and `PHASE4_STEPS`;
`gate:phase3:corrective` runs `--steps=<PHASE3_STEPS>` and asserts the exported list equals those 15 names;
`gate:phase4:s8` and `gate:phase4:release` run the full matrix with every step. No coverage is lost — the
Phase 3 screens are still driven, and now additionally by the Phase 4 gate.

**P4-AL-64 — Phase 4 keeps exactly three locales and three viewports.**
`scripts/phase3-corrective-gate.ts:403-419` asserts **equality** between its `BROWSER_MATRIX` and the
`LOCALES`/`VIEWPORTS` literals in `tests/browser/config.ts`, so adding either turns an accepted Phase 3 gate
red. Phase 4 adds screens and invariants, not locales or viewports. Relaxing that assertion from equality to
superset is `OD-P4-11` and is the Tech Lead's to authorise, because it edits an accepted gate.

**P4-AL-88 — `tests/security/settlement-s6-no-customer-payments.test.ts` is re-expressed as a claim about the
Phase 3 prefix before the first Phase 4 table exists, and it is not deleted.**
This is the third Phase 3 coupling, and it is worse than the other two because it is not avoidable.
The test asserts, against the **live catalogue**, that `payments`, `payment_allocations`, `payment_reversals`,
`refunds`, `customer_credits`, `credit_notes`, `customer_payments` and `customer_refunds` do not exist
(`:41-56`, `to_regclass` must be NULL for each), and that **no relation whatever** matches
`(customer|sale|invoice)` (`:58-65`). It is a permanent Phase 3 suite, so it is composed by
`gate:phase3:corrective` and through it by `gate:phase3:release`. The very first Phase 4 migration that creates
`customers` or `invoices` therefore turns an **accepted Phase 3 gate** red, and every Phase 4 slice gate red
with it through composition.

Neither available shortcut is acceptable. Deleting the suite deletes a real Phase 3 protection — that P3-S6
built a supplier settlement surface and did not quietly build a customer one. Adding an allowlist of the Phase 4
names turns a "these do not exist" assertion into a "these exist and that is fine" assertion, which asserts
nothing.

The resolution is to say what the test always meant. Its invariant is **phase-scoped**: *the Phase 3
migrations created no customer-payment, sale or invoice surface.* That is a claim about migrations `0053–0073`,
not about the database a later phase also populates. So the suite is re-expressed structurally — it reads the
Phase 3 prefix's own files (`scripts/phase3-prefix.ts`, which already holds the accepted names and digests) and
asserts that no relation matching those patterns is created by any of them — and keeps its live-catalogue form
only for the relations the Phase 3 range does create, which is the exact-list half at `:58-65` that is
genuinely about the catalogue Phase 3 built. The re-expressed suite is **strictly as strong**: it still fails if
a Phase 3 migration is edited to add a customer table, and it now says nothing about the future, which is what
`[[daftar-a-closure-rule-is-not-an-invariant]]` requires of it. Its red proof plants a `CREATE TABLE customers`
into a scratch copy of a Phase 3 migration and requires the suite to name that file.

This work belongs to **P4-S1, before the first Phase 4 migration is written**, alongside the `registered_by`
widening. It is the second of the two reasons the first Phase 4 CI run would otherwise be red for reasons that
have nothing to do with Phase 4's design.

### 17.4 Golden tests

**P4-AL-65 — The Phase 4 golden suite is mandatory, line-by-line, additive, and carries the canonical
`GOLD-nn` ids.**
`tests/golden-regression/phase4/*`, twenty goldens G-01…G-20 covering all eighteen required scenarios.
Every entry asserts account code, account identity, side, debit, credit, base amount, base currency,
transaction amount, transaction currency, rate and rate source — never "it balances", because a balanced
entry made of the wrong accounts is exactly the defect GOLD-28 exists to catch and it balances perfectly.
Account codes are **written out** from the chart migration, not read back from the seed. No third id series:
Phase 4 uses canonical `GOLD-nn`, and where a Phase 4 golden covers something the canonical table lacks, the
table gains a new id.

The estate Phase 4 inherits is smaller than the documents claim: `tests/golden-regression/` holds only
`phase1/` (7 files, its own `P1-GOLD-01…40` series) and `phase2/` (2 files); Phase 3 added no golden
directory; and of the canonical `GOLD-01…88` only twelve ids are referenced at all, as **journal-shape
stand-ins** posted with a `manual_adjustment` source identity that the file itself declares is not the
scenario (`tests/golden-regression/phase2/01-engine-shapes.golden.test.ts:17-29`). So
`docs/DAFTAR_GOLDEN_REGRESSION_SUITE.md:3`'s "إلزاميًا … لا يُختصَر" is not true of the estate today.

| # | golden (canonical id) | what it proves | owner |
|---|---|---|---|
| G-01 | last-item race (GOLD-19) | two concurrent sales of the final unit: exactly one commits, the loser gets a stable translated refusal, `on_hand` never negative, no phantom movement, no orphan invoice, no partial journal | S2, S8 |
| G-02 | cross-tenant (GOLD-20) | every Phase 4 route refuses another tenant's token, at the API **and** again at SQL with A's GUCs asking for B's row; enumerated from the route registry so a new route cannot escape | S1, each slice, S8 |
| G-03 | cross-business FK manipulation (GOLD-30) | direct SQL binding `sale(A)` to `customer(B)`, `invoice(B)`, `payment_method(B)`, `warehouse(B)`, `credit_note(B)`, `installment_plan(B)` is refused **by the database** | S1 |
| G-04 | payment currency ≠ invoice currency (GOLD-26) | both sides plus base, `NUMERIC(20,10)` rates, the three snapshots, the residue line; `paid + outstanding = total` in the **invoice's** currency at every step; realized FX on `4900`/`6900` and `6100` unmoved | S4 |
| G-05 | void a paid invoice (GOLD-27, 42, 43) | the direct void path refused; the composite command atomic in the fully-cash-paid and partially-paid-credit cases; revenue reversed once, AR zero, cash net correct | S6 |
| G-06 | return + refund without double reversal (GOLD-28) | the §4.7 partial return with discount and tax, line for line; revenue reversed once; the refund never touches revenue | S5 |
| G-07 | invoice sequence isolation (GOLD-48) | two businesses of one tenant, two independent series, no mixing; credit-note numbering independent too; N concurrent allocations give N distinct numbers, no gap, no duplicate | S1, S8 |
| G-08 | refund caps (GOLD-40, 50) | over-cap refused, exact-cap accepted with `remaining = 0`, a second refused, the original payment untouched; cross-currency cap in the **source's** currency | S5 |
| G-09 | concurrent refund (GOLD-41, 53) | two concurrent refunds on one source: one succeeds, `Σ refunds ≤ cap` however many attempts, including across currencies | S5, S8 |
| G-10 | reverse a payment allocation (GOLD-65, 66, 67, 86) | targeted **by id**; AR restored, revenue untouched, a second reversal refused; split payment reverses one leg only; multi-currency uses the **original** snapshots; **cash does not move** | S6 |
| G-11 | payment reversal (GOLD-87) | a chargeback: the cash original **is** reversed, unlike G-10; unallocated case cancels the credit; idempotent by `provider_reference` at the database | S6 |
| G-12 | a raw payment cannot be a refund source (GOLD-85) | `refunds` has exactly one non-null source and **no column that could name a payment** — unrepresentable, not rejected | S5 |
| G-13 | installment totals (GOLD-09, 10) | `Σ instalments + down = total` exactly, enforced by the database; deterministic civil dates; `due`/`late` correct **as of a supplied date**; no figure from the machine's clock | S7 |
| G-14 | partial payment (GOLD-07) | `paid + outstanding = total` after every step; revenue posted once and never re-posted; the final payment closes to `outstanding = 0` exactly | S4 |
| G-15 | overpayment → customer credit (GOLD-68, 69, 70, 79, 80) | the surplus becomes a credit, not revenue; application onto a later invoice under a lock; refund at **carrying** value; partial consumption leaves both halves proportional, full consumption zeroes both exactly | S4, S5 |
| G-16 | idempotency (GOLD-12, 62 and every Phase 4 key) | every replay refused **at the database** by a real `UNIQUE` over real columns; no second journal, no second movement, no second decrement; plus the GOLD-74 schema lint | S2, S4, S5, S6, S8 |
| G-17 | GL = source model (GOLD-88, `R-SAL-*`) | the identities of §15 computed by the **product's** reconciler; and no `completed → refunded` transition exists | S8 |
| G-18 | inventory = stock ledger (GOLD-33, `R-INV-01…05` with sales) | `GL(1200) = Σ(qty × avg)` exactly after purchase-at-two-costs → sale → return → void → transfer → adjustment; `Σ line COGS = posted COGS` after `HALF_EVEN`; no intermediate rounding | S8, with S2 owning the sale-side movement law |
| G-19 | schema lint (GOLD-74) | every column named in every `UNIQUE`, `CHECK` and `FK` of every Phase 4 table exists; no literal inside a constraint; no polymorphic FK in the financial core | S1, re-run by every later gate |
| G-20 | the shape stand-ins still agree | every journal the Phase 2 stand-ins predicted, produced by Phase 4's **real** commands, matches line for line — and if it does not, the gate must say which was changed | S8 |

**P4-AL-66 — The Phase 2 shape stand-ins are not deleted.**
They are the proof that the engine's expressive claim was true in advance; deleting them would delete
evidence. G-20 asserts the real commands agree with them.

**P4-AL-67 — Every golden and every invariant has a named, resolved RED proof.**
A `RED_PROOFS` row of the form `<test file>::<it( title prefix>`, verified to resolve to a real title, plus
a tamper suite that plants the defect in a scratch root and requires the gate to name it. A golden with no
red proof is a claim, not a test.


### 17.5 Browser coverage

**P4-AL-68 — Every Phase 4 screen is driven in all nine combinations: ar, en, tr × 360, 768, 1280.**
Sixteen new steps added to `flows.ts` and exported as `PHASE4_STEPS`: `pos`, `pos-credit`, `pos-keypad`,
`customers`, `customer`, `statement`, `invoices`, `invoice`, `collect`, `return`, `refund`, `installments`,
`installment-collect`, `debts`, `void`, `p4-states`. 16 × 9 = 144 step-runs per gate run on top of the
existing 135. Four new invariant kinds, each with its own planted defect so it is provably able to fire:
`money` (every amount inside `<bdi>`, the currency's minor-unit decimals exactly, no locale digit
substitution inside a document number), `total-visible` (at 360×640 with the keypad open, the cart total and
the primary action fully inside the viewport), `cap-shown` (the refund screen renders the remaining cap, in
the source's currency, **before** the amount field), `sequence-verbatim` (a document number rendered byte for
byte as the server produced it). The existing plants stay; `REQUIRED_PLANTS` is a subset check
(`phase3-corrective-gate.ts:205,423-427`), so adding kinds is safe.

**P4-AL-69 — POS type-ahead is solved by pacing, never by raising the API's allowance.**
The POS search is the first Phase 4 read that can approach `ROUTE_BUDGET = 270`/min (`config.ts:70`). It gets
its own pacer entry and drives a bounded number of keystrokes. A 429 stays a reported error
(`config.ts:52-57`): raising the limiter to make a test pass would delete the protection the test exists to
exercise.

**P4-AL-70 — The `browser` job's timeout is raised, and the matrix is never reduced per push.**
A timeout is a CI resource bound, not a threshold on a measurement, so raising it is not a relaxation. If one
job cannot hold the matrix, it is split by locale **inside the same `browser` job name** so the
required-checks key is unchanged. Moving the full matrix to a dispatched workflow and running a reduced one
per push is **refused**: the per-push real-browser matrix is the guarantee TD-06 bought, and reducing it would
let a Phase 4 screen regression reach a reviewer green. See `OD-P4-12`.

### 17.6 Performance

**P4-AL-71 — Eight budgets plus a reconciliation total, each anchored to an accepted budget or
calibration-locked, never guessed.**

| id | measure | ceiling | anchor |
|---|---|---|---|
| P4-A | POS search: one 50-row page by name/SKU/barcode prefix, over HTTP | p95 ≤ 150 ms | the accepted P3-S7 stock page, identical shape, volume and principal (`phase3-s7-read-budgets.test.ts:56`) |
| P4-B | server-side cart recomputation, 20 lines with discounts and tax | p95 ≤ 60 ms | Budget B, the small-work endpoint end to end (`accounting-budgets.test.ts:57`) |
| P4-C | sale commit: 10-line cash sale, invoice + lines + 10 movements + the journal | **calibration-locked**, hard cap p95 ≤ 1 000 ms | composed from Budget B + Budget A + the measured per-movement cost; the cap is a **product** statement, see `OD-P4-13` |
| P4-D | customer balance as of a date, the fat-tail customer | p95 ≤ 100 ms | Budget E, "account balance as-of, 100 000-line class" (`accounting-budgets.test.ts:63`) |
| P4-E | statement: one 50-row keyset page over a date range, with opening balance | p95 ≤ 150 ms | Budget D, the general-ledger keyset page (`accounting-budgets.test.ts:61`) |
| P4-F | payment allocation over 5 invoices, in-transaction and over HTTP | ≤ 40 ms / ≤ 100 ms | Budget A for the journal half; the per-invoice constant is calibration-derived (`OD-P4-14`) |
| P4-G | return + refund: a 4-line return, its credit note, its inventory entry and the refund | **calibration-locked**, hard cap p95 ≤ 1 000 ms | composed: Budget A × 3 + 4 movements + the HTTP envelope |
| P4-H | installment schedule read: a 24-instalment plan with derived status as of a date | p95 ≤ 50 ms | the accepted P3-S7 return-options read (`phase3-s7-read-budgets.test.ts:58`) |
| P4-R | one full `R-SAL-*` + `R-INV-*` pass over the ≈1 000 000-line business | total ≤ 300 s | Budget F (`accounting-budgets.test.ts:65-66`) — the same ceiling now holds a strictly harder claim |

**P4-AL-72 — Every budget also carries a host-independent ratio assertion and narrow plan assertions.**
A millisecond encodes this host's speed; a ratio measured in the same run on the same host encodes the
query's shape. So: `p95(page 20) ≤ 1.2 × p95(page 1)` for the keyset reads; `p95(40 lines) ≤ 2.2 × p95(20)`
for the cart; `p95(20 lines) ≤ 2.0 × p95(10)` for the sale; `p95(fat-tail) ≤ 3 × p95(median)` for the
balance; `p95(5 invoices) ≤ 3 × p95(1)` for the allocation. Plan assertions are properties of the query and
never "the planner must choose algorithm X forever": index reach, no sequential scan on the large relations,
no `OFFSET`, a statement count independent of the row count, exactly one transaction for the sale, one
journal entry for a whole allocation, and **no per-row correlated subplan from a policy**. Crucially the two
calibration-locked budgets are RED-capable from the first commit because their ratio assertions are, which is
what keeps `[[daftar-a-green-gate-must-prove-it-can-be-red]]` satisfied before calibration exists.

**P4-AL-73 — `D-SALES`, built by the real commands, at two tiers with the **same** ceilings.**
Acceptance scale: 20 000 customers; 5 000 variants × 3 warehouses (identical to the accepted P3-S7 volume, so
the POS read is comparable to the stock read); 200 000 invoices over 730 days; 400 000 invoice lines with one
40-line invoice; 300 000 payments and 500 000 allocations (allocations exceed payments because partial and
split allocation is the normal case); 30 000 credit notes and 40 000 refunds; 15 000 customer credits, half
partially consumed; 20 000 installment plans × 12–24 instalments; ≈1 000 000 AR/revenue journal lines; a
**fat-tail customer** with 2 000 invoices and 4 000 allocations, because a statement budget measured on an
average customer measures nothing; and an 85/10/5 currency mix so the FX paths are measured rather than
bypassed. Tier 1 runs at `P4_PERF_SCALE = 0.1` with the **same** ceilings — a deliberately weaker claim, never
a reduced dataset to make a number pass. The generator asserts the volume it actually realized before taking
a timing.

**P4-AL-74 — Every measured relation is `ANALYZE`d, `planningStatistics` is recorded, and a null fails the
suite.**
`[[daftar-a-benchmark-measures-what-the-planner-saw]]`: budget C cost 2.9 s on a runner and 122 ms after one
`ANALYZE`, with no query and no migration change. A budget measured without statistics is a number about the
missing statistics.

**P4-AL-75 — Every budget is measured as `daftar_app` with the scope GUCs a request sets, through the
product's own query function, and the RLS cost is recorded per budget.**
The `daftar_app` figure **is** the budget; the owner figure on the same database with the same rows is
recorded only as the RLS cost. `[[daftar-rls-policy-shape-is-a-cost]]`: measure it at acceptance scale, where
the real cost at 100 000 lines turned out to be non-inlinable `SET`-clause helper functions called per row
rather than the policy's join shape. A cost ratio above 3× is FAIL-until-diagnosed; the 3× value has **no
measured anchor in the tree** and is recorded as provisional (`OD-P4-14`). A policy changed for speed requires
the answer-equivalence proof in the `accounting-rls-equivalence.test.ts` form — one database, the product's
query, before and after, compared byte for byte: the optimisation must change the work, never the answer.

**P4-AL-76 — A missed budget is a FAIL until diagnosed; the diagnosis decides, never the number. Budgets run
alone.**
No ceiling is relaxed to obtain a PASS. Every sample is kept in order and the gate fails if a measurement's
sample count is below the declared iterations. Tier 1 runs inside `gate:phase4:s8` as a separate step after
the functional suites, on its own `PG_DIR`, with nothing else on the box; Tier 2 runs in the dispatched
evidence workflow at an exact SHA. A figure produced on a developer machine is labelled local wherever it
appears. `scripts/phase4-budget-ratchet.ts` holds an independent accepted copy of every constant and refuses
any increase — the structural expression of "no threshold relaxed to obtain PASS", and its weakness (one
commit could change both copies) is recorded honestly in §20 rather than claimed away.
`perf:phase2:s8` is narrowed to the Phase 2 files, because it currently runs `tests/performance` whole and
therefore runs three phases' budgets together in violation of the isolation rule.

### 17.7 The harness law

**P4-AL-77 — No Phase 4 test's verdict is an accident of the machine, and no flake is ever answered by a
retry, a threshold, a removed sample, a skip, a disabled test or a relaxed invariant.**
Root cause first, every time. Concretely, per trap:

| trap | Phase 4 suites at risk | the design that avoids it |
|---|---|---|
| wall-clock boundary | instalment `due`/`late`, aging buckets | every date-dependent assertion reads its reference instant from the same source the product used, or from an explicit as-of the test supplies |
| token TTL | the HTTP goldens | tokens minted per file, refreshed only through the product's own path; no TTL extended for tests |
| the transaction clock | the concurrency suites | the parked transaction's own clock, detected through `pg_stat_activity` |
| a cleanup window | prune and expiry assertions | the cutoff is read from the consuming transaction and every count judged at that cutoff — the P3-S3 prune lesson |
| shared state | `resetData()`, committed fixtures | `resetData()` covers every Phase 4 table, derived from the migrations rather than listed; `maxWorkers: 1` and `isolate: true` are not relaxed |
| advisory locks | six new lock-taking commands | the declared order of P4-AL-41, statically checked |
| database lifetime | budgets beside suites | budgets on their own `PG_DIR` (P4-AL-76) |

A substrate-specific failure is a finding to be triaged, never an exclusion. And a green result is only
trusted after the runner canary has proved the runner can report failure.

**P4-AL-78 — The Phase 4 secret-history scan and review index are bounded at the Phase 3 head, and
`PHASE4_BASE` is verified rather than assumed.**
`scripts/phase4-secret-scan.ts` with `PHASE4_BASE` = the merge of the sealed Phase 3 head into `main`,
**verified against `git merge-base`**; the same pinned checksum-verified gitleaks, the same three-condition
`.gitleaksignore` discipline (exact fingerprints, a reason comment, and a proof that the line is a migration
digest), the same `--ignore-gitleaks-allow`, and the same tree mode for the extracted archive.
`[[daftar-clean-history-not-a-weaker-scan]]`: a false positive in candidate history is answered by rewriting
that history, never by an allowlist. `[[daftar-gitleaks-window-slides]]` is why the base is verified and not
guessed: a guessed base makes the scan claim a range it did not cover, which is the exact defect
`phase3-secret-scan.ts:8-15` exists to prevent.

**P4-AL-79 — P4-S9 closes on exact-SHA evidence from an extracted archive.**
`.github/workflows/phase4-s9-release.yml`, dispatched with the expected SHA: assert the checkout is that
commit; run the Phase 4 range secret scan; run `gate:phase4:release`; build `DAFTAR_PHASE_4_RC.zip` with a
**sibling** `.sha256`; extract it into a clean directory and run `gate:phase4:release` again there on a new
cluster; assemble and upload the evidence. `[[daftar-a-check-only-asked-where-it-passes]]`: DAFTAR's release
gate failed three times the first time it ran on a clean runner inside an extracted archive, and none of the
three was a product defect. Phase 4 closes only on a `push` run of `DAFTAR CI` at the seal commit's own SHA
plus that release-evidence run at the same SHA; a `pull_request` run on a merge commit is equivalent-tree
evidence and is labelled as such. "P4-S9 created no migration" appears only in the evidence script, never in
a gate.

**P4-AL-80 — `docs/DAFTAR_RELEASE_GATES.md` and `docs/DAFTAR_TEST_STRATEGY.md` are corrected to describe the
machinery that exists.**
The full gate estate, not only the Phase 1 gate; that the browser gate checks **functional** invariants on the
laid-out DOM and performs **no** pixel comparison, against the strategy doc's promise of visual regression;
the six required CI jobs; that there is **no** Fast-PR / Core-merge / Nightly-full / Release split and every
suite runs on every push; the actual state of the golden estate and the existence of two numbering series;
and the corrected budget script scopes. Correcting a document to match reality is not a weakening of any gate;
leaving it wrong is how a reviewer comes to believe a green tick covers something it does not. Owned by P4-S8.


---

## 18. Slice mapping

**P4-AL-81 — Phase 4 is nine slices, and the boundaries are invariant boundaries.**
A slice boundary exists where a new invariant becomes assertable, which is why the gate estate maps one-to-one
onto it. An agent may refine a boundary for a real technical reason; merging slices for speed is refused.

| slice | scope | the invariant it makes assertable | migrations |
|---|---|---|---|
| **P4-S0** | this architecture lock and the canonical corrections | none — analysis only | none |
| **P4-S1** | customers, sales and invoice documents, per-business numbering, the extended guards | composite-FK impossibility of cross-business linkage; gapless per-business numbering; the extended G-3 and jargon guards; forward evolution | `0074`+ |
| **P4-S2** | the sale commit primitive: `sales`, `sale_items`, the movement path, the COGS entry, the revenue/AR entry | the atomic sale law; the last-item race; idempotency of a sale | yes |
| **P4-S3** | POS web: the server-side cart, search, reads, the till session | the POS trust boundary; the cart is never the client's | yes |
| **P4-S4** | payments, allocation, receivables, overpayment → customer credit | one entry per allocation; level-uniqueness; `paid + outstanding = total`; the surplus is never revenue | yes |
| **P4-S5** | returns, credit notes, refunds | revenue reversed exactly once; the refund cap inside the source's lock; a raw payment is not a refund source | yes |
| **P4-S6** | payment reversal, allocation reversal, void invoice — **and TD-15's customer twin** | reversal and refund are two operations; a reversal leaves no stale allocation; the direct void path is refused | yes |
| **P4-S7** | debts, statements, installment plans and their reads; the narrow TD-22 repayment | `Σ instalments + down = total`; status derived from a supplied date; no second ledger of debt | yes |
| **P4-S8** | hardening, reconciliation, concurrency matrix, performance, the document corrections | `R-SAL-01…07`; the declared lock order; the eight budgets; the golden suite complete | possibly |
| **P4-S9** | release closure | exact-SHA evidence from an extracted archive | **none** |

TD-15 is placed in **P4-S6** because its substance — reversing a payment and its allocations atomically with
AP preserved exactly — is the same transaction as the customer-side allocation reversal, and the same
`OD-P4-04` blocks both. Closing them in one slice means one lock order, one carrying-release chain fix and one
reviewer. Splitting them would mean writing the mechanism twice.

---

## 19. Migrations — planning only

**P4-AL-82 — P4-S0 creates no migration, and `0074` does not exist.**
Verified: 74 manifest entries, `frozenThrough = 0073_default_warehouse_locale_name.sql`, no file after 0073.

**P4-AL-83 — After P4-S0 is accepted, exactly one active agent owns migration creation, allocating serially
from `0074`.**
Not "coordinate before creating one" — one owner, for the whole phase. Parallel agents each inventing `0074`
is a merge conflict in a file whose digest is frozen at acceptance, and the cost of resolving it is a rewritten
prefix rather than a rebase. Every other agent describes the DDL it needs and the owner writes it.

**P4-AL-84 — The first Phase 4 migration carries the two registry widenings and nothing else of substance.**
The `registered_by` pattern (`^P3-S[0-9]+$` → `^P[0-9]+-S[0-9]+$`, four constraints at `0054:54`, `0059:53`,
`0059:59`, `0059:69`) and whatever the extended guards require. Putting them first means the first red CI run
of Phase 4 is about them alone, rather than about them plus a table.

**P4-AL-85 — `0000–0073` stay immutable byte for byte, and `frozenThrough` is a floor that never retreats.**

---

## 20. Out of scope, risks, and what could not be verified

**P4-AL-86 — Out of scope for Phase 4, and a slice that reaches for one of these is refused by its gate's
forward-scope check.**
Ecommerce storefront; public checkout; omnichannel orders; SaaS billing; WhatsApp automation; offline Android
POS; offline synchronisation; AI features; CRM campaigns; loyalty programmes; a public API; booking; and
activation of any country-specific tax without an approved Country Pack (§13). Each Phase 4 slice gate carries
a `FUTURE_SLICE_SURFACES` list and refuses a table, operation kind or route belonging to a later slice or a
later phase.

### 20.1 Risks this lock accepts and names

| # | risk | why it is accepted, and what bounds it |
|---|---|---|
| R-P4-01 | the Phase 4 gate chain's wall time: `gate:phase4:s8` composes ten Phase 3 gates plus eight Phase 4 gates plus the browser matrix plus Tier-1 budgets | the honest levers are caching library builds, keeping the browser matrix in its own job, and dispatching Tier 2 and the rehearsals. A Fast/Nightly split that lets a regression reach a reviewer green is **refused**, which is also why the strategy doc's promise of one is corrected rather than implemented |
| R-P4-02 | the longer composed run will surface latent timing assumptions in **existing** suites, as the P3 prune defect did | the existing suites are audited for the §17.7 traps as part of P4-S1, not discovered at P4-S8 |
| R-P4-03b | a permanent Phase 3 suite asserts, against the live catalogue, that the Phase 4 tables will never exist (`tests/security/settlement-s6-no-customer-payments.test.ts:41-65`) | re-expressed as a claim about the Phase 3 prefix in P4-S1 (P4-AL-88), never deleted and never allowlisted. Found only by reading the suite; no document mentioned it |
| R-P4-03 | `tests/browser/config.ts`, `flows.ts` and `resetData()` are now edited by four phases and asserted against by Phase 3 gates | P4-AL-63's per-phase exported lists are the general mitigation; two cases were found here and a fifth phase will find more |
| R-P4-04 | the budget ratchet is a second copy, not a digest: one commit could change both | the file contains nothing but numbers, so a change is a one-line diff, and the release gate requires a Tech Lead-signed line in the acceptance page for any changed constant. This is weaker than a digest and is stated as such |
| R-P4-05 | calibration-locked ceilings can bless a slow first implementation | the 1 000 ms product cap is the only defence and it needs an owner (`OD-P4-13`) |
| R-P4-06 | the required-checks configuration is outside the tree, so no gate can verify which checks GitHub requires | nothing in this design closes it; it is avoided by touching no job name (P4-AL-59), and it is the same external blocker as TD-08 |
| R-P4-07 | the `browser` job's resources: 31 steps × 9 combinations, each driving a production Next build, a Nest API and an embedded PostgreSQL | P4-AL-70 and `OD-P4-12` |
| R-P4-08 | concentrating the sale's physical authority in `daftar_inventory_internal` | recorded as new technical debt in §21 rather than accepted silently |
| R-P4-09 | whether every Phase 3 `R-INV-*` check stays green once sales write movements | G-18 asserts it; whether any check was written assuming purchase-only movement sources is a genuine Phase 4 risk and is P4-S2's to establish before it writes a movement |

### 20.2 What this lock could not verify

- **V-P4-01** — `PHASE4_BASE` is not determinable from this tree in the form the scan needs; it is filled and
  verified against `git merge-base` at P4-S1, never guessed (P4-AL-78).
- **V-P4-02** — no gate, suite or budget was executed in P4-S0. Every claim about a gate's behaviour is read
  from its source. That is what "analysis only" costs, and it is the correct cost.
- **V-P4-03** — whether a `strategy.matrix` inside the `browser` job preserves the required-checks key is a
  GitHub behaviour plus a repository setting, neither readable from the tree (`OD-P4-12`).
- **V-P4-04** — no Phase 4 table, routine, route or screen exists. Every named object here is a design
  commitment; where a slice names something differently the assertion moves with the name and the assertion
  itself does not change.
- **V-P4-05** — the account codes in §17.4 were read from the golden-suite document and the Phase 2 identity
  registry, not cross-checked line by line against `0040_accounting_chart.sql`. The goldens must write them out
  from the chart migration.
- **V-P4-06** — the ≈1 000 000-line figure for `D-SALES` is derived from the row counts, so the generator
  asserts the realized count rather than trusting the derivation.
- **V-P4-07** — branch protection on `main` remains unverifiable from this tooling (TD-08).

---

## 21. Technical debt ownership

| debt | state after this lock |
|---|---|
| **TD-08** — `main` unprotected | stays **OPEN / EXTERNAL**. Corrected in P4-S0 to name **six** required checks (workspaces, backend, web-admin, android, hygiene, browser), and to say the state is **unverified from this tooling** rather than known to be configured. The compensating policy — every Phase 4 change through a PR, no direct push to `main`, CI green on all six jobs before merge — is mandatory for all of Phase 4 |
| **TD-09 / TD-10** | carried forward with their stated boundaries unchanged; Phase 4 neither widens nor closes them |
| **TD-15** — supplier payment / allocation reversal not atomic | **owned by P4-S6**, alongside its customer twin, and no longer optional: Phase 4 may not close with TD-15 unowned. Blocked by `OD-P4-04`. Its reference in `TECHNICAL_DEBT.md` is corrected when it closes: the substantive spec is `ACCOUNTING_RULES.md` §5.2 + §5.4, not DM §7's mutable flag, and the debt has **three** sources, not one |
| **TD-22** — design-system document versus shipped tokens, and the unloaded Inter reference | **evaluated here, bound to P4-S7**, repaid narrowly by correcting the document and removing the font name (P4-AL-56). Not fixed in P4-S0 |
| **TD-P4-01** *(new)* | the sale's physical authority is concentrated in `daftar_inventory_internal`, which now writes stock for two domains. Recorded, bounded by the signed-assertion requirement, and to be revisited when a third domain needs it |
| **TD-P4-02** *(new)* | ≈70 canonical `GOLD` scenarios have no golden test, and `docs/DAFTAR_GOLDEN_REGRESSION_SUITE.md:3` claims the suite is mandatory and never shortened. Phase 4 implements the twenty in its own scope; the document gains a per-id owning-phase column and `gate:phase4:s8` checks that every id owned by phase ≤ 4 has a file. See `OD-P4-15` |
| **TD-P4-03** *(new)* | two golden id series coexist (`P1-GOLD-nn` and canonical `GOLD-nn`) and a plain grep for `GOLD-19` finds both. No document says so. Recorded; Phase 4 adds no third series |

**P4-AL-87 — No security, accounting or data-integrity defect is moved to technical debt in order to close a
Phase 4 slice.** The three new entries above are a concentration of authority, a documentation gap and a naming
collision. None of them is a defect deferred to make a gate green.


---

## 22. Open decisions

Each of these is a point this lock deliberately did **not** settle, because settling it would mean inventing a
commercial policy, a legal policy or an authority the Tech Lead has not granted. Each carries its options, the
risk of each option, an engineering recommendation, and whether it blocks a slice. Nothing below is implemented
in a slice until it is answered.

**OD-03 — non-zero jurisdiction-specific tax. Carried forward unchanged and not closed.**
Extended in this lock to the **sales** side with its own boundary (P4-AL-44, P4-AL-45). No country's law is
researched and no rate, rule, threshold, exemption, recoverability or legal invoice field is guessed. *Blocks:*
nothing in Phase 4, because Phase 4 ships structural zero.

**OD-P4-01 — the cashier's first financial authority, and what happens to existing cashiers.**
Phase 4 is the first phase in which a `Cashier` role does anything financial. *Options.* (a) The default set of
P4-AL-35 — read, cash sale, collect payment — and everything else by explicit delegation. (b) Add
`sales.discount` to the default, because a till that cannot discount is unusable in a shop that haggles.
(c) Give cashiers nothing by default and require delegation even for a cash sale. *Risks.* (a) means a shop must
delegate discounting to every cashier on day one, which is friction that invites over-delegation. (b) grants a
sensitive, value-moving key by default, which the role-default constraints (`0041:57-65`, `0057:140-151`)
forbid outright — so (b) is not merely unwise, it is unbuildable without changing an accepted constraint.
(c) makes the role pointless. *Recommendation.* (a). *And the backfill is the real question:* existing
`Cashier` memberships predate these keys, so P4-S1 must either grant the new default keys to existing cashiers
or leave them unable to sell. Recommendation: grant the non-sensitive defaults in the migration, audited, and
grant nothing sensitive. *Blocks:* **P4-S1's migration**, not its start.

**OD-P4-02 — price override, or discount only.**
*Options.* (a) Discount only: the catalogue price is the price, and a reduction is a discount with its own
permission and its own audit row. (b) Free price override at the till under `sales.discount`. (c) Override
bounded by a per-business floor percentage. *Risks.* (a) cannot express a negotiated price above catalogue,
which some trades need. (b) makes the catalogue price advisory and makes margin analysis meaningless, and it is
indistinguishable from the forged-total attack when it arrives over HTTP. (c) needs a policy number nobody has
given. *Recommendation.* (a) for Phase 4 — a discount is auditable as a decision, an override is not. *Blocks:*
P4-S3's cart design, so it should be answered before P4-S3 starts.

**OD-P4-03 — a customer credit limit.**
*Options.* (a) No limit in Phase 4: a credit sale is permitted whatever the balance, and the balance is visible.
(b) A per-customer limit that refuses the sale. (c) A limit that warns and permits with a permission.
*Risks.* (a) lets a shop extend unbounded credit unknowingly. (b) refuses a sale at the till, which is the
worst place to discover a policy. (c) needs the authority question answered (who may override, and is it
sensitive). *Recommendation.* (a) for Phase 4, with the balance and the aging shown on the customer picker, and
(c) as a named Phase 5 candidate. *Blocks:* nothing; it adds a column later without re-modelling.

**OD-P4-04 — mid-chain reversal of an allocation. This is the one hard blocker.**
The carrying-release chain (P4-AL-21) telescopes, so reversing any allocation other than the **last** breaks it
in two measurable ways. With `T = 3`, `B = 10` and two allocations of 1 (releases 3 then 4), reversing the first
leaves the survivor's stored `x = 1` against a recomputed `before = 0` — `purchase_settlement_verify`'s chain
check raises — and `Σ rel = 4` against `HALF_EVEN(10·1/3) = 3`, so the receivable is off by one base minor unit
on an otherwise perfectly correct transaction. *Options.* (a) **LIFO only**: an allocation may be reversed only
if it is the last unreversed release on its source; anything else is refused with a localized message telling
the merchant to reverse the later one first. (b) **Appended negative reducer**: the reversal appends a release
of `−a` at the current chain head rather than removing the original, so the chain stays intact and
`Σ rel` stays exact; the original row stays, marked by the existence of its reversal row. (c) Recompute the
whole chain on reversal — rewriting stored financial history, which P4-AL-10 forbids. *Risks.* (a) is
arithmetically safe and is a real usability wall: a shop that allocated wrongly three payments ago must reverse
three. (b) preserves both invariants and is append-only, but the source's release history then contains a
negative entry, which every reader of that history must understand, and it needs a proof that `rel(X, −a)`
telescopes correctly at the head — which is exactly the proof `purchase_settlement_verify` would have to be
extended to check. (c) is refused outright. *Recommendation.* **(b)**, with the telescoping proof for negative
releases written and asserted **before** any reversal code is written, and (a) as the fallback if that proof
does not hold. But this is a financial-mechanism decision with a measurable one-minor-unit consequence, and it
is the Tech Lead's. *Blocks:* **P4-S6 entirely, and TD-15 with it.**

**OD-P4-05 — oversell.**
*Options.* (a) No oversell in Phase 4: a sale of more than `on_hand` of a stock-tracked product is refused.
(b) A per-business flag permitting it. (c) Permit it only for products that are not stock-tracked. *Risks.*
(a) refuses a sale a shop with sloppy stock counts genuinely wants to make. (b) requires changing
`inventory_apply_stock_movements` — the single stock writer and the highest-risk change available in the
system — and would make `on_hand` able to go negative, which several accepted invariants read as impossible.
(c) is not oversell at all: selling a non-tracked product never decrements a level and is already permitted, so
(c) is a clarification rather than an option. *Recommendation.* (a), with (c) stated explicitly in the UX so a
merchant understands why one product refuses and another does not. *Blocks:* P4-S2's movement path, so it
should be answered before P4-S2 starts.

**OD-P4-06 — interest or fees on an installment plan.**
*Options.* (a) None in Phase 4: `Σ instalments + down = invoice total`, exactly, enforced by the database
(P4-AL-13). (b) A flat fee added as an invoice line at plan creation. (c) Interest accrued over the schedule.
*Risks.* (a) is the only option under which the installment law's sum constraint holds as written. (b) is
buildable — it is an invoice line, so revenue and AR are ordinary — but it changes what the total means and
needs a commercial decision about whether the fee is refundable on early settlement. (c) is a different product:
it needs an accrual schedule, a second revenue recognition pattern and, in many jurisdictions, a licence.
*Recommendation.* (a). *Blocks:* nothing; (b) is additive later.

**OD-P4-07 — unrealized FX on a customer statement.**
*Options.* (a) The statement shows amounts in the invoice's own currency and the base carrying value as
recorded, with no revaluation. (b) A revaluation column at today's rate, displayed only. (c) Posted
revaluation entries. *Risks.* (a) understates what a foreign-currency receivable is worth today, which a merchant
may read as an error. (b) puts a number on a financial screen that no journal line supports, and someone will
reconcile against it. (c) is period-end accounting policy Phase 4 has no mandate for. *Recommendation.* (a),
with the rate and date of each line visible so the merchant can see why. *Blocks:* nothing.

**OD-P4-08 — writing off a terminal AR residue.**
A cross-currency AR can end with a residue of a few minor units that no payment will ever clear.
*Options.* (a) No write-off in Phase 4: the residue stays and is visible. (b) A write-off command with its own
permission, its own journal entry (`Dr` a bad-debt or FX account `/ Cr` AR) and its own audit. (c) An automatic
threshold below which a residue is written off on settlement. *Risks.* (a) leaves customers with 3-minor-unit
balances forever, which looks like a bug. (b) is a new financial command with a new account identity, in a phase
that already has enough. (c) is a silent automatic journal entry triggered by a threshold nobody set, which is
the worst of the three. *Recommendation.* (a) for Phase 4 and (b) as a named Phase 5 candidate. *Blocks:*
nothing.

**OD-P4-09 — whether a till session may be shared between cashiers.**
*Options.* (a) One session, one authenticated user; a shift change is a new session. (b) A shared till session
with a per-sale actor. *Risks.* (a) is unambiguous for audit and slightly slower at a shift change. (b) makes
the audit row's actor and the session's owner different people, and a cash-drawer discrepancy then has no
single owner. *Recommendation.* (a). *Blocks:* P4-S3's session model.

**OD-P4-10 — whether the Phase 4 goldens run in `test:golden` as well as inside the slice gates.**
*Options.* (a) Both, accepting that they run twice per CI run. (b) Only in the gates. *Risks.* (a) costs CI
minutes; the Phase 3 release gate already accepted double execution on principle. (b) means a golden regression
is reported by a large composed gate's log rather than by a small, early, clearly-named step — the readability
problem `ci.yml:257-262` was written about. *Recommendation.* (a). *Blocks:* nothing.

**OD-P4-11 — whether `gate:phase3:corrective`'s browser-matrix assertion is relaxed from equality to superset.**
*Options.* (a) Leave it as equality; Phase 4 adds no locale and no viewport (P4-AL-64). (b) Relax to superset,
with the directive floor unchanged. *Risks.* (a) permanently forbids a fourth locale or viewport for as long as
that gate is permanent, which is forever. (b) edits an **accepted Phase 3 gate**; it weakens nothing, but "we
edited an accepted gate" must be explicit and authorised. *Recommendation.* (a) for Phase 4, and raise (b) when
a fourth viewport or locale is actually wanted rather than pre-emptively. *Blocks:* nothing, unless a Phase 4
screen genuinely needs a viewport the current three do not cover.

**OD-P4-12 — the `browser` job's wall-clock budget once Phase 4 roughly doubles the step count.**
*Options.* (a) Raise `timeout-minutes` from 40 to about 90, one job. (b) A `strategy.matrix` over locale
**inside** the `browser` job, keeping the job name unchanged. (c) Move the full matrix to the dispatched
workflow and run a reduced one per push. *Risks.* (a) a 90-minute required job slows every PR. (b) a matrix leg
may produce a separate check context, which could break the required-checks configuration — unverifiable from
the tree. (c) **weakens the per-push claim** and would let a Phase 4 screen regression reach a reviewer green.
*Recommendation.* (a) first, measured; (b) only after confirming in repository settings that the required-checks
key is unaffected; (c) **refused**. *Blocks:* the slice that first makes the job exceed its timeout.

**OD-P4-13 — the absolute cap on the sale-commit and return+refund budgets.**
*Options.* (a) A 1 000 ms hard cap stated as a product requirement — a POS sale slower than a second is a defect
whatever the machine measures. (b) No absolute cap; the calibration-locked p95 × 1.3 is the only ceiling.
(c) A cap derived from the composed anchors alone, with no round number. *Risks.* (a) is a number nobody
measured; its defence is that it is a **product** statement rather than a measurement, which makes it the Tech
Lead's or the owner's to set rather than an engineer's to invent. (b) means a slow implementation locks in its
own slowness at acceptance and the budget can only ever say the product got slower, never that it is too slow.
(c) is the most defensible but is not knowable until the calibration run, so the gate cannot be red on day one.
*Recommendation.* (a) **and** (c) together: the composed-anchor calibration sets the operative ceiling,
tighten-only thereafter, and the 1 000 ms cap sits above it as an independent product floor a calibration result
may not exceed — a calibration landing above 1 000 ms is a **FAIL to be diagnosed**, not a ceiling to be
written. The 1 000 ms value itself needs confirmation. *Blocks:* **P4-S2's and P4-S5's acceptance**, not their
start.

**OD-P4-14 — the per-invoice constant in the allocation budget, and the 3× RLS cost threshold.**
*Options.* (a) Both calibration-derived, then tighten-only. (b) Both fixed now from the nearest anchors.
*Risks.* (a) means the absolute ceilings are not final until P4-S4, though the ratio assertions are red-capable
immediately. (b) picks numbers from a different query family, and the 3× RLS threshold in particular has **no
measured anchor anywhere in the tree** — the Phase 2 RLS work proved an *answer* equivalence and removed a
correlated subplan; it never published a cost ratio. *Recommendation.* (a), with 3× recorded as **provisional**
and confirmed by the first Tier-2 run's measured ratios. *Blocks:* P4-S4's and P4-S8's acceptance evidence, not
any slice's start.

**OD-P4-15 — the ≈70 canonical `GOLD` scenarios that no golden test covers.**
*Options.* (a) Phase 4 implements the twenty in its own scope, and
`docs/DAFTAR_GOLDEN_REGRESSION_SUITE.md` gains a per-id **owning phase** column so "the golden suite is green"
becomes a checkable statement. (b) Phase 4 implements every id it can reach, stubbing the domains that belong to
later phases. (c) Leave the document as it is. *Risks.* (a) edits a canonical document — a correction, not a
weakening. (b) creates goldens over stubs, which prove the stub: exactly the failure mode the Phase 2 file was
careful to declare it was avoiding. (c) leaves "إلزاميًا … لا يُختصَر" untrue and a reviewer misled about what
`npm run test:golden` covers. *Recommendation.* (a), plus a check in `gate:phase4:s8` that every id owned by a
phase ≤ 4 has a golden file referencing it and an id owned by a later phase does not. *Blocks:* nothing, but it
should be answered before P4-S1 so the slice knows which ids it carries.


---

## 23. Independent architecture review

An independent reviewer read this document and `docs/PHASE_4_EXECUTION_PLAN.md` against the current tree,
without relying on the coordinator's summary, hunting a fixed list of nineteen failure classes: double
posting; a duplicate source of truth; a stale customer balance; a cross-business FK hole; double revenue
reversal on return or refund; a payment reversal leaving allocations stale; a split commit between stock and
accounting; races on the last item, on invoice numbering, on allocations and on refunds; installment double
counting; forged client totals; permission escalation; branch-scope bypass; an FX mismatch; an accidental
non-zero tax policy; a migration conflict; and Phase 5/6/7 scope leakage.

Its findings, and where each was closed in this document, are recorded in §23 of
`docs/PHASE_4_EXECUTION_PLAN.md` — see **§9, Independent review** there. Every High and Medium finding
touching data integrity, security or accounting was closed in this lock before the verdict was given.

---

## 24. What P4-S0 did not do

No product code. No endpoint. No POS screen. No migration. `0074` does not exist. No Phase 4 table, routine,
route, component or string was created. No gate, suite or budget was executed. No country's tax law was
researched and OD-03 is not closed. The only files P4-S0 changed are this document,
`docs/PHASE_4_EXECUTION_PLAN.md`, and the four canonical status sources listed in §3.1.

P4-S1 does not begin until the Tech Lead says so.
