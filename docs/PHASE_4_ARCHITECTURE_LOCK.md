# DAFTAR — Phase 4 Architecture Lock / قفل معمار المرحلة الرابعة

**Phase 4 — Sales, POS, Customers, Debts, Receivables & Installments**
**Stage: P4-S0 — Architecture Lock. Status: candidate, awaiting Tech Lead review.**

> This document is the architectural contract for Phase 4. It decides; it does not implement.
> P4-S0 created no product code, no endpoint, no POS screen and no migration, and `0074` does not
> exist. Implementation begins only on an explicit Tech Lead PASS on this document.
>
> Every load-bearing claim below is cited as `file:line` against the baseline tree. Where a canonical
> document disagreed with the code, the code won and the disagreement is recorded in §3 rather than
> silently resolved. The Tech Lead corrective seal record is at §25 and an Arabic summary is at §26.

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
| the source type added to the **literal list inside `accounting_reversals_20_domain_source_guard`**, by `CREATE OR REPLACE` in the same migration that registers it | the guard body at `0067:2242-2271`; the pattern at `0061:1520`, `0063:1523`, `0065:1749`, `0067:2242` |
| the source table's `binding_source_id`, its generated `accounting_source_type` constant, the `binding_source_id = id` CHECK and the **deferred** binding FK — this, not the assertion seam, is what makes a missing entry fail the COMMIT | `0067:382`, `0067:388-391` |

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
| D-10 | `DATA_MODEL.md` §14أ `invoice_sequences.current_value BIGINT` | the database contains **zero** PostgreSQL sequences and **zero** counter columns; ordinals are `max+1` under the owning row's lock backed by a UNIQUE (`0060:490-513`, `0059:216`) | **P4-AL-31** |
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
| D-21 | `DAFTAR_DATA_MODEL.md` §10ب/§13/§14 and `DAFTAR_THREAT_MODEL.md` TH-04 describe `customers`, `sales`, `sale_items`, `invoices`, `invoice_sequences`, `payments`, `payment_allocations`, `payment_reversals`, `refunds`, `customer_credits`, `credit_notes` as if they existed | **none of them exists**, and a permanent Phase 3 test asserts they never will, which the first Phase 4 migration therefore breaks (P4-AL-88) | they are design commitments Phase 4 implements, not facts |
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
| revenue recognised | `journal_lines` on **`4000` `sales_revenue`** bound to the `invoice` source (`0040:59`) | — | `invoices.revenue_minor` |
| revenue reversed by a return | `journal_lines` on **`4100` `sales_returns`** bound to the `credit_note` source (`0040:60`) | — | a debit to `4000`, which would net revenue to zero in a perfectly balanced entry |
| COGS | `journal_lines` on `5000` bound to the `sale` source | — | **`sale_items.cogs_minor`**. The COGS input is `stock_movements.value_delta_base_minor` (`0059:142`), written by the stock writer (`0060:445-454`); a per-line cost on `sale_items` would be a second stored integer for the same money with a second writer and no constraint tying them. A per-line cost needed before the movement is written is a transient in the routine, not a column |
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
CI today**. G-3 is therefore not a protection Phase 4 inherits; it is a protection Phase 4 must build.

The fix is **not** a named sales arm. Naming eleven Phase 4 tables in the file whose own header explains
that "a rule keyed on a name protects a name" (`:33-38`, the lesson that cost Phase 3 five missed tables)
would build the same hole one phase later. It is one rule. The AP/AR column vocabulary already exists in the
file — `AP_BALANCE_COLUMN` (`:411`) matches `paid_minor`, `outstanding_minor`, `amount_due_minor` and
`settled_minor` — and it is wired only to `SUPPLIER_TABLE_NAME` (`:408`). It is rewired to apply to **every
relation the accepted Phase 2 prefix did not create**, which is the set the inventory arm already discovers
(the probe shows it returns every Phase 4 table), and the `_seq` exemption (`:281`) stays for inventory
relations only. Red proof: plant `invoices.paid_minor` and require the guard to name it. `remaining_*` stays
permitted for the reason the file documents at `:384-392`, which is what lets P4-AL-14's remaining pair
exist at all.

**Corrected in P4-S1 (`TL-P4-S1-C1`), because this paragraph as first written was wrong in two ways and
unfinished in a third.**

1. **A bare `cost` cannot join the pattern.** `(^|_)costs?($|_)` flags **twelve accepted Phase 3 columns**,
   every one a per-unit *input* frozen on its own source document rather than a derived total:
   `stock_movements.unit_cost_base_minor`, `purchase_lines.unit_cost_base_minor`,
   `stocktake_lines.unit_cost_base_minor`, `inventory_adjustment_lines.unit_cost_base_minor`,
   `inventory_opening_lines.unit_cost_base_minor`,
   `negative_inventory_deficits.provisional_unit_cost_base_minor`, both
   `negative_deficit_coverages.*_unit_cost_base_minor`, `purchases.landed_cost_txn_minor`,
   `purchase_lines.landed_cost_txn_minor`, `supplier_return_lines.unit_cost_base_minor` and
   `purchase_reversal_lines.unit_cost_base_minor`. Adding it would break the standing requirement that no
   currently-passing relation starts failing. What P4-AL-05 actually forbids is a stored **COGS** or a
   stored **cost total**, so the pattern is `(^|_)(cogs|cost_of_goods|costs?_(total|totals|sum|sums)|(total|sum)_costs?)($|_)`
   — which matches nothing in the accepted tree and does refuse `sale_items.cogs_minor`.
2. **The rewiring alone does not catch `credit_notes.refunded_amount_minor`.** The inherited AP vocabulary is
   `outstanding|paid|unpaid|due|owed|payable|settled` and has no `refunded`. `receivable`, `refunded`,
   `collected` and `allocated` are therefore added explicitly, each verified to match zero accepted Phase 3
   columns. `applied`, `consumed`, `remaining`, `total`, `net` and `gross` are deliberately **not** added:
   each has accepted Phase 3 columns behind it.
3. **The gap has a relation dimension as well as a column dimension.** `INVENTORY_FORBIDDEN_TABLE` (`:283`)
   only refuses a `*_summary`/`*_snapshot`/`*_rollup`/`*_cache` name when it also matches `(stock|inventory)_`,
   and `SUPPLIER_FORBIDDEN_TABLE` (`:424`) was only ever applied over the supplier arm — so a Phase 4
   **relation** whose whole purpose is a stored balance or a rollup (`customer_balances`, `sales_summary`,
   `invoice_cache`, `ar_aging_summary`, `receivables_rollup`) passed CI. The forbidden-name pattern becomes
   shared across both arms, with `receivables?` added and the P4-AL-13 source-document exemption kept ahead
   of it.

Also corrected: the rewiring carries the shared vocabulary on **both** arms rather than widening the
supplier arm's watched set, because `tests/integration/phase3-s8-guards.test.ts:108-111` pins the two arms as
a **disjoint partition** of the Phase 3 surface, so widening one arm's set turns an accepted Phase 3 test
red.

Until that guard exists, no Phase 4 migration may be accepted — the ordering matters, because the first Phase 4 migration is exactly where such a column
would be introduced.

**P4-AL-07 — A derived value is read through the product's own function, and that function is the same
one the reconciler and the gate use.**
Phase 3's `purchase_ap_outstanding` (`0072:240-269`) is the precedent: one function, called by the API,
by the reconciliation check and by the performance budget. A second copy of the arithmetic in TypeScript
is a second truth with a slower failure mode, because it disagrees only under the numbers nobody tested.

---

## 5. Entity model

**P4-AL-08 — Eighteen new commercial tables, plus the stock-source bridges and the POS session tables,
every one of them keyed by `(tenant_id, business_id, …)`. `payment_methods` is reused, not created.**
`customers`, `customer_contacts`, `sales`, `sale_items`, `invoices`, `invoice_items`,
`invoice_sequences`, `payments`, `payment_allocations`, `payment_reversals`,
`allocation_reversals`, `credit_notes`, `credit_note_items`, `refunds`, `customer_credits`,
`customer_credit_applications`, `installment_plans`, `installments`. Every one carries `tenant_id` and
`business_id` as real columns, not as a joinable inference, because both RLS layers read them directly
(`0041`, `0057:140-151`) and because the composite FKs below are only expressible when the child row
carries the business itself.

Three things are **not** in that list and must not be counted as if they were. `payment_methods`
already exists — Phase 3 created it at `0067:284` with `PRIMARY KEY (business_id, id)`, a
`posting_account_id` candidate key, RLS and its `payment_method_names` twin (`0067:310`) — so a
`CREATE TABLE payment_methods` in a Phase 4 migration fails outright; Phase 4 reuses it, and a Phase 4
payment binds `(business_id, payment_method_id, posting_account_id)` through the same three-column FK
`supplier_payments` already uses (`0067:352-354`). The **stock-source bridge** tables of P4-AL-29b are
mandatory and are additional. And P4-S3's POS session tables — `pos_till_sessions`, `pos_cart_lines`
(P4-AL-86) — are additional too. The schema lint (G-19) and `resetData()` are built from the union,
discovered from the migrations rather than from this paragraph.

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
- **`MATCH SIMPLE` is not a hole, and the reason is not the one it first looks like.** Where a composite
  FK has a nullable component — the walk-in sale of P4-AL-11 — PostgreSQL's default `MATCH SIMPLE` skips
  that FK entirely when any of its columns is null. That is harmless here, because `business_id` is
  **independently** constrained on every Phase 4 table by the mandatory
  `FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)` over two `NOT NULL`
  columns (the accepted shape is `0067:303`), and when `customer_id IS NULL` there is no customer row for
  the row to be foreign to. The accepted tree already relies on exactly this: `supplier_payments` declares
  a nullable `fx_rate_id` (`0067:339`) with a composite FK (`0067:356`) and **no** consistency trigger. So
  Phase 4 adds no trigger for this. What P4-AL-11 does need a trigger for is a different and real
  invariant, stated there.

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
defect with a friendly name. The null is the honest representation, and P4-AL-09 explains why the null is
not a foreign-key hole.

The invariant the null *does* need enforcing is the accounting one: **a null `customer_id` means no AR
line.** A cash sale to a walk-in customer never touches AR, and nothing about the FK graph says so. The
nullable `customer_id` lives on `sales`, `invoices` and — for a walk-in cash receipt — `payments`, so
that is three `DEFERRABLE INITIALLY DEFERRED` constraint triggers, one per table:
`sales_walkin_no_ar`, `invoices_walkin_no_ar`, `payments_walkin_no_ar`. Each asserts that the journal
entry bound to its row carries no line on the AR account when `customer_id IS NULL`, and each has its own
red proof that posts an AR line under a null customer and requires that table's trigger to raise. The
same requirement is carried in the `invoice` source's deferred completeness validator, because that is
where the entry's expected line set is already computed.

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


**P4-AL-15b — Phase 4 inherits guard rules it must *comply* with, not only guards it must build, and they
fix parts of the DDL vocabulary.**
`isPhase3Relation` means "the accepted Phase 2 prefix did not create it"
(`scripts/guards/no-authoritative-balance.ts:74-76`), so **every Phase 4 table is treated as a Phase 3
relation** by G-2's inventory half (`scripts/guards/no-float-rate.ts:180`) and by G-3's inventory arm — which
my probe confirms: all eight synthetic Phase 4 tables appear in `discoverInventoryTables`. The consequences
are rules, not preferences:

- no floating-point column anywhere in Phase 4;
- `INVENTORY_TYPE_PINS` (`no-float-rate.ts:145-165`) pin any Phase 4 column named `qty_delta`, `on_hand`,
  `*_qty` or `qty_*` to `NUMERIC(18,4)`, `*_cost_base_minor` to `NUMERIC(28,10)`, and
  `value_delta_base_minor` / `valuation_base_minor` to `BIGINT`. **`TL-P4-S1-C5`: as first written this
  decision's own DDL vocabulary opted out of the guard it cites.** The pin matched `qty_delta`, `on_hand`,
  `*_qty` and `qty_*` only, so a bare `quantity NUMERIC(18,2)` on `invoice_items` produced **no finding**
  while `unit_cost_base_minor NUMERIC(20,4)` beside it was correctly caught. The pin is extended in P4-S1 to
  the word forms `quantity`, `*_quantity`, `quantity_*` and `quantities` at the accepted `NUMERIC(18,4)`.
  The column is **not** renamed to dodge the guard: naming around a guard is how the next phase inherits the
  same hole. Measured green half: the accepted tree declares 980 columns, 525 on a watched relation, and not
  one names a quantity in the word form, so the added pattern matches the empty set today;
- `NEVER_STORED` (`no-authoritative-balance.ts:276`) refuses any Phase 4 column matching `reserved` or
  `available`, so a POS "reserved" or "available to sell" column is refused today;
- `INVENTORY_FORBIDDEN_TABLE` (`:283`) refuses a Phase 4 relation named `*_summary`, `*_snapshot`,
  `*_rollup` or `*_cache` if it also matches `(stock|inventory)_`.

So Phase 4's vocabulary is fixed in advance: quantities are `quantity NUMERIC(18,4)`, unit costs are
`unit_cost_base_minor NUMERIC(28,10)`, all money is `BIGINT` minor units, and nothing is named `reserved` or
`available`. `remaining_*` stays permitted for the reason the guard file documents at `:384-392`, which is
what lets P4-AL-14's remaining pair exist at all.

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

**Which mechanism guarantees it matters, because the obvious one does not.**
`AccountingAssertionSequence.assertComplete()` is
`if (this.presented > 0 && this.presented < this.assertions.length) throw`
(`apps/api/src/infra/database.ts:488-495`): presenting **none** is deliberately allowed, for the replay case
the comment at `:425-429` documents. So a transaction that minted three assertions, wrote the `sales` row
and the stock movements and posted **zero** journal entries commits with that seam silent. The seam catches
the *partial*-posting case only. The all-or-nothing guarantee is the source row's own **deferred binding
FK** into `accounting_source_bindings` (the `0067:388-391` shape, with `binding_source_id = id` at
`0067:382`), which fails the COMMIT when a source row has no entry. So every Phase 4 accounting-source
table carries `accounting_source_type` as a `GENERATED ALWAYS AS (…) STORED` constant, `binding_source_id`,
the equality CHECK and the deferred FK, and `gate:phase4:s2`'s structural half asserts all four from
`pg_constraint`. **`TL-P4-S1-C6`: `binding_source_id` has two accepted shapes and this sentence read as
though the `NOT NULL` one were the only one.** `supplier_payment_allocations` has it `NOT NULL` (`0067:384`)
because an allocation always owes an entry; `purchases` has it **nullable** with
`purchases_binding_owed_ck CHECK ((status = 'received') = (binding_source_id IS NOT NULL))`
(`0063:255,258`) because a draft owes none. A relation with a `draft` state — `invoices` — takes the
`purchases` variant, with the status-conditional CHECK carrying the obligation. A `sales` table without them would ship a real split commit under a green seam.

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

**P4-AL-22 — Level-uniqueness is necessary and not sufficient. The sufficient mechanism is a
COMMIT-time chain verifier, and Phase 4 must build both.**
The accepted level-uniqueness constraints are
`supplier_credit_allocations_level_uq UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)`
(`0067:438`) and `supplier_refunds_level_uq` (`0067:491`). Both are over a **credit note**. There is no
Phase 3 precedent over a *payment*: the accepted `supplier_payment_allocations` (`0067:362-405`) carries
no remaining-level column at all — its uniqueness is `(business_id, payment_id, line_no)` and
`(business_id, payment_id, purchase_id)`, and over-allocation is prevented by
`supplier_payments.allocation_count` together with the COMMIT-time value guard
`purchase_settlement_verify` (`0067:717-758`, invoked from constraint triggers at `0067:1287`, `:1293`,
`:1299`). So Phase 4 **introduces** `payment_remaining_before_minor` on `payment_allocations`; it does not
inherit it.

And the distinction matters more than the citation. A `UNIQUE` over a *declared* remaining level forbids
two rows claiming the same level; it does not cap total consumption, because a direct SQL attacker simply
declares a different level. `Σ consumed ≤ original` is enforced at COMMIT by the chain verifier, in the
`purchase_settlement_verify` form, asserting the chain from zero and the exact telescoping sum. So each
consumable Phase 4 source — the payment, the credit note, the customer credit — carries **both**: the
level `UNIQUE`, which turns the same-level race into a constraint violation, and a deferred
constraint-trigger verifier, which is what actually bounds the total. `gate:phase4:s4` asserts the
verifier against direct SQL **bypassing the routine**, with a red proof that inserts an allocation at a
fabricated remaining level and requires the COMMIT to fail.

Its known cost is recorded honestly: the `UNIQUE` also caps an operation that legitimately needs several
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
Not a recomputation from quantity times average cost. Average cost is a derived rounded quotient, so
re-multiplying it reintroduces the drift the stored delta has already resolved and establishes a second
source of truth beside the ledger — `[[daftar-a-rounded-quotient-is-never-an-input]]`. The movement rows
already hold the exact integer value delta the stock writer computed, so the reconciliation identity is
**`GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`** — an exact integer identity that
`R-INV-01` can assert, which removes the second rounding a recomputation would introduce —
`[[daftar-rounding-is-not-additive]]`. `quantity × average_cost` is never the reconciliation truth
anywhere in Phase 4 (`TL-P4-S0-01`). Where the sum of per-line COGS differs from the posted total after
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

**P4-AL-28 — The Phase 4 operation-code namespaces are `sale.*` and `customer.*`. A first segment
containing an underscore is not representable, so there is no `customer_payment.*`.**
The registry's key is `op_code TEXT PRIMARY KEY CHECK (op_code ~ '^[a-z]+(\.[a-z_]+)+$')`
(`0054:53`), and the **same regex is inside a frozen routine body** at
`0054:229` — `inventory_payload_digest`, not `inventory_assertion_consume`, whose pattern is the
colon-separated assertion preimage (`TL-P4-S1-C10`). The first segment is `[a-z]+` with no underscore, so `customer_payment.collect` is refused
twice: by the `CHECK` on insert and by the routine at call time. Widening the table's `CHECK` would be an
ordinary migration; widening the copy inside the routine would mean replacing the body of the single
inventory authority routine, which is exactly the change P4-AL-27 and P4-AL-29 forbid. So the namespace
changes instead:

`sale.commit`, `sale.void`, `sale.return`, `customer.collect_payment`, `customer.allocate_payment`,
`customer.reverse_payment`, `customer.reverse_allocation`, `customer.credit_note`, `customer.refund`,
`customer.credit_apply`. `payment.*` is already taken by the four payment-method kinds, which is why the
collection codes live under `customer.*` rather than under `payment.*` — but the deciding constraint is
the regex, not the collision. The first Phase 4 migration asserts both halves: a `customer.*` code is
accepted and `customer_payment.x` is refused, so the constraint is documented rather than rediscovered.

Each code is a registry row with its own authority, and the single-use `jti` of `0054:344-480` gives
replay protection at the assertion layer independently of P4-AL-30's document-level idempotency.

**P4-AL-29 — A sale writes stock only through `inventory_apply_stock_movements`, and the routine is not
changed.**
`0060:487` is the only stock writer and the reason `R-INV-01…05` can be trusted. A sale is a new operation
kind consumed by the existing routine, with negative quantities and the average-cost path the routine
already implements. The writer principal stays `daftar_inventory_internal`; Phase 4 grants it nothing new
beyond EXECUTE on its own new wrappers, and the resulting concentration of authority in one NOLOGIN role
is recorded as new technical debt in §21 rather than silently accepted.

Oversell is **not** enabled by this decision, and enabling it would mean changing that routine — the
highest-risk change available in the system. See `OD-P4-05`.

**P4-AL-29b — A stock movement's source is a *second* registry with its own bridge apparatus, and §2.2's
accounting checklist does not cover it.**
`stock_movements.source_type` is a foreign key into `stock_source_types` (`0059:137`), with
`stock_source_bindings` alongside it (`0059:174`). Registering a row there obliges the registering migration
to build the whole apparatus that `inventory_stock_source_guard_gaps()` reports on, enumerated at
`0061:307-481` and built concretely for the purchase source at `0063:400-431,456-459,555-562`:

| the `sale` source must also provide | shape |
|---|---|
| a `stock_source_types` row | `0059:137` |
| `stock_source_bridge_sale`, a plain table | PK exactly `(business_id, source_id, source_line_id, movement_kind)`; a stored generated `source_type` constant |
| a five-column validated `bridge_binding_fk` | into `stock_source_bindings` |
| a three-column validated `bridge_line_fk` | into the exact line table and key — so **`sale_items` must carry `UNIQUE (business_id, sale_id, id)`** for the FK to be expressible |
| RLS **enabled and forced**, plus the five policies | the `0063:456-459,555-562` set |
| a `bridge_immutable` row trigger | on `stock_ledger_append_only()` |
| a deferred `binding_trigger` on its own internal DEFINER function | `0061:321-341` |
| `source_complete`, `source_freeze`, `header_immutable`, `value_complete` | each pinned by table, name, event, column list, `WHEN`, deferral, enabled state, **and the SHA-256 of its `prosrc`** recorded at migration time |
| the migration's own assertion that `inventory_stock_source_guard_gaps()` returns no row | `0061:481` |

That is six-plus objects, an RLS policy set, an append-only trigger and a recorded body digest that §2.2
does not mention because §2.2 is the *accounting* checklist. A slice that builds only what §2.2 lists fails
`0061`'s own guard report on its first run. The `sale_items` candidate key joins P4-AL-09's edge list, and
these objects join the migration plan's S2 row.


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
`DATA_MODEL.md` §14أ specifies `invoice_sequences.current_value BIGINT`. The database contains **zero
PostgreSQL sequences**, and exactly **one** counter column — `stock_levels.last_stock_seq`
(`0059:107`, advanced at `0060:437,454`), which allocates the stock ledger's primary ordinal. That one is
not a precedent for a document number, and the difference is the point: `last_stock_seq` is a per-key
**cache** whose value the exact rebuild `inventory_stock_fold` recomputes from the ledger
(`0060:520-570`), so a wrong counter is detectable and correctable. A document number has no rebuild — the
number *is* the record — so it takes the `max + 1` form of `inventory_next_deficit_seq`
(`0060:490-513`, with its `UNIQUE` at `0059:216`) instead. (`TL-P4-S1-C4`: the citation first given here
was `0059:135,147`, which is `stock_movements.stock_seq` and `stock_movements_key_seq_uq` — the wrong
ordinal. `deficit_seq`'s backing constraint is `negative_inventory_deficits_seq_uq` at `0059:216`. The
decision is unaffected; the citation was wrong.) Three reasons, and the third is the
decisive one:
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
slowest sale. It is therefore taken **after every per-key domain lock** — after the customer, after the
stock levels, after the COGS entry — and immediately before the `invoices` INSERT that needs the number, so
the window in which it is held is the shortest possible.

It is not taken "after the journal", because the journal is entered twice and the invoice row must carry its
number at INSERT: allocating the number after the revenue entry would mean inserting the invoice without it
and updating the row, which P4-AL-46 forbids. So the sale's order is: `sales` -> movements -> `stock_levels`
-> COGS entry -> **`invoice_sequences`** -> `invoices` + items -> revenue/AR entry -> (cash sale) payment,
allocation, settlement entry. That is consistent with P4-AL-41's domain order, and it is the order the static
check compares against.

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

**The Accountant is a custom role, not a built-in one.** `BuiltinRoleKey` is
`'owner' | 'manager' | 'cashier'` (`packages/domain-core/src/permissions.ts:120`) and
`0041:19-20` records the decision in terms: "P2-S1 adds NO built-in accountant role." So the Accountant
column above describes a role a business creates itself, every entry in it is a grant rather than a
default, and Phase 4 creates no built-in role — creating one in a sales phase, and granting it two
sensitive keys by default, is exactly what P4-AL-37 forbids.

**And changing the cashier's or the manager's default set breaks three accepted permanent tests by exact
equality**, which P4-S1 owns and must re-express per phase rather than loosen:
`packages/domain-core/test/domain-core.test.ts:474`
(`expect(BUILTIN_ROLE_PERMISSIONS.cashier).toEqual(['catalog.view'])`), the same assertion at
`tests/integration/inventory-permissions-provisioning.test.ts:142`, and
`domain-core.test.ts:468`, whose manager assertion filters out Phase 3 keys
(`filter((p) => !isPhase3(p))`) — a Phase 4 key is not a Phase 3 key, so it lands inside the filter and
breaks the equality. The re-expression is the one Phase 3 already used for its own keys: filter Phase 4
keys out of the Phase 1 equality and assert the Phase 4 set separately. Both files are named in the
execution plan's file-ownership matrix for this reason.

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
Not "everything except a read". Taking cash for a sale is the normal flow and is not sensitive;
discounting, voiding, returning, refunding, reversing and rescheduling a debt are value movements outside
it and are.

**And no accepted constraint enforces this — Phase 4 must write the enforcement.** `0041:57-65` and
`0057:140-151` are one-shot migration-time `DO`-block assertions over hard-coded key arrays: `0041`'s
checks its five Phase 2 keys, `0057`'s checks its eleven Phase 3 keys, each raising
`permission_backfill_overreach` if a non-owner role holds one. There is no `CHECK`, no trigger and no
exclusion constraint on `role_permissions` — nothing in the database binds a key registered later. So
nothing today would stop a migration granting `sales.void`, `refunds.approve` or `payments.reverse` to the
cashier by default. The first Phase 4 permission migration therefore carries the same assertion over the
twelve Phase 4 keys, with a red proof that plants `cashier -> sales.void` and requires the migration to
raise. This is the **fourth** protection Phase 4 must build rather than inherit, alongside the three in
P4-AL-06, P4-AL-52 and P4-AL-88, and it is listed here because a reader of this decision would otherwise
assume the protection already exists.

**P4-AL-38 — RLS is layered exactly as Phase 2 and 3 layer it, and `daftar_app` gets no DML on any Phase 4
table.**
`ENABLE ROW LEVEL SECURITY` **and** `FORCE`; one permissive tenant policy; four `RESTRICTIVE` per-command
isolation policies; **plus `inventory_internal_read` (`0063:473-474`), and on an accounting-source relation
also `accounting_validator` (`0063:490-491`)** — so the accepted count is **six policies on an ordinary
relation and seven on an accounting-source relation, not five** (`TL-P4-S1-C2`). The first draft of this
decision said five. Omitting `accounting_validator` on `invoices` under `FORCE ROW LEVEL SECURITY` makes the
deferred completeness validator read **zero rows and pass vacuously**, which is the worst failure mode
available here: a green gate over an unchecked invariant.

The tenant policy takes the **direct** form `tenant_id = nullif(app_tenant(), '')::uuid` that `0052:305-330`
adopted after measurement (`0052:280-291` records a six-row table showing every partial correction is worse
than none), not the correlated `(SELECT b.tenant_id FROM businesses b WHERE b.id = …)` that `0063:462-463`
still carries. The correlated subselect is the **second** per-row cost, and it is the one `0052` actually
removed for the read path it measured. `daftar_app` holds `SELECT` and `EXECUTE` and nothing else, so every write goes through
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
6. `installment_plans`
7. `invoice_sequences` — **last of the domain locks** (P4-AL-32)

`accounting_post_entry` takes its own locks, in its own fixed internal order, at each call. It is therefore
**not** a position in this list: a sale calls it twice (the COGS entry, then the revenue entry), so a linear
order that named `journal_entries` once could not describe the sale at all. The order above is the order of
the **domain** rows, and the routine's internal order is safe because it is the same at every call. The
static acquisition-order check reads the domain acquisitions and compares them to this list; the routine's
own order is asserted separately, once, against its body.

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
| 10 | permission escalation through delegation | the closed registry and the `beyondGrantAuthority` ceiling, which are real; **plus the Phase 4 `role_permissions` assertion P4-AL-37 requires S1 to write**, because no accepted constraint covers a Phase 4 key | S1 |
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

**And the guard is a closed literal list that stops at Phase 3, so it is a hole until Phase 4 replaces its
body.** `accounting_reversals_20_domain_source_guard` refuses the generic reversal workflow only for the
seven source types named inside it plus `purchase` (`0067:2249-2251`), and `accounting_post_reversal` is
granted to `daftar_app` (`0046:765`). Until every Phase 4 source type is added to that list, `daftar_app`
can call the generic reversal on an `invoice` entry and get a mirrored revenue reversal with **no paired
credit note, no stock return and no audit of the commercial fact** — and, because there is exactly one
reversal slot per entry, that illegitimate reversal consumes it and the legitimate domain correction is then
refused with `accounting.reversal_exists`, leaving the books un-correctable by any product path. This is
hunt item 5 reached through the generic door. So the widening is a requirement of §2.2, it lands in the same
migration that registers each source type, and `gate:phase4:s1` asserts from `pg_proc.prosrc` that every
registered Phase 4 source type appears in the guard's list, with a red proof that removes one.

---

## 15. Audit, outbox and reconciliation

**P4-AL-48 — Every Phase 4 command writes an audit row in the same transaction as its effect.**
Actor, permission exercised, delegation if any, the document's UUID, the `intent_sha256`, the branch, the
till session, and — for a refused command — the refusal code and the figures that caused it. A refusal is
audited as heavily as a success, because the forged-total and over-cap attempts are the ones worth seeing.
The audit — the relation `audit_events`, not "the log" — is a record, never a source: no reconciliation
check reads it.

**P4-AL-48(a) — The refusal half has a DIFFERENT transaction and a DIFFERENT durability, because the
exception model leaves no other shape. Added in P4-S4 after the contradiction was measured.**
The decision above names one transaction for both outcomes, and for a refusal that is **unsatisfiable**: a
command's refusals are raised before its audit INSERT (33 `RAISE EXCEPTION` at `0081:1874-2128` against the
pair at `0081:2170`/`2174`; 23 and `0081:2420`/`2424` for `customer_apply_credit`), and a `RAISE` aborts the
transaction, so a row written earlier does not survive either. Measured across a 409: audit 8 before and 8
after, outbox 7 and 7 — **a refused customer payment persisted no audit evidence at all**. So:

- **effect-audit — the SAME transaction, MANDATORY.** Unchanged, and the only shape allowed for a success. A
  change whose audit fails is a change that does not happen.
- **refusal-audit — its OWN committed transaction, AFTER the abort.** A refusal describes an **attempt**,
  not an effect, so there is no effect for it to be atomic with. It is written by
  `AuditService.recordRefusal`, which is `OutboxService.emit`'s already-accepted own-transaction shape and
  **no new one**; it needs no migration, because `daftar_app` already holds `INSERT ON audit_events`
  (`0006:79`) under the `audit_scope` policy (`0006:53-55`).
- **the refusal row carries its claims LITERALLY, not by join.** For a success the permission exercised is
  recoverable — `metadata.assertionJti` (`0081:2173`) joins `inventory_assertion_uses`, which stores
  `op_code` (`0054:88-94`) — and that satisfies this decision for the success path unchanged. After a
  refusal the registry INSERT (`0054:450-451`) has rolled back with everything else and there is no document
  row either, so **recoverable-by-join does not exist on that path** and the operation, the intent digest,
  the branch, the till session, the refusal code and the figures are all in the row's own metadata. That is
  the `F-3` answer; `docs/PHASE_4_DECISION_REGISTER.md` §3 carries it with the evidence.
- **durability is HIGH, NOT ABSOLUTE, and no document may claim more.** If the refusal row's own
  transaction also fails, the merchant is still answered with the refusal they earned and the loss is
  reported to the process log. A refusal-audit failure may never become a 500: a merchant told "internal
  error" for a `date_in_future` has been given a worse answer than an un-audited refusal. This is the exact
  limit of what the accepted transaction model permits, and the lock states it rather than being quietly
  downgraded.
- **an error that is not a refusal gets no refusal row.** An infrastructure failure, a seam defect or a bug
  is not a merchant refusal, and auditing one as such is the same lie as answering one as a 409.
- **a refusal emits NO outbox event.** A refusal is not a business event; nothing downstream reacts to one.

The POS and sale-commit paths carry the same structural gap (`0078:1002`, `0079:954`, `0079:1022` are all
last-step audit INSERTs after their own raises) and P4-S4 did not close them: they are another owner's
files, `recordRefusal` is now available to them, and **no gate yet asserts that every Phase 4 command audits
its refusals**. Both are recorded in the register rather than claimed.

**P4-AL-49 — The outbox is not a financial source, and reconciliation checks are `R-SAL-01…07` added to
the existing pass.**
An `outbox_events` row, and the at-least-once **publication** of it, may not be the thing that proves a
payment happened. (This sentence once read "a delivery record", which in a sales phase reads as a goods
delivery note — a document Phase 4 does not model — while the only `deliver*` relation in the tree is
`credential_deliveries` (`0020:6`), which is encrypted credential email. See the vocabulary table at the end
of this section.) The reconciliation checks:

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

### The vocabulary of this section, bound to its referents

Three words in this document reach more than one real subsystem, and one of them has no referent at all.
`P4-AL-48` and `P4-AL-49` are reconciliation-bearing decisions, so a reader who binds the wrong referent
writes a check that passes vacuously — the `TL-P4-S1-C2` failure mode. The binding is therefore stated:

| word | what it means in Phase 4 | what it does NOT mean |
|---|---|---|
| "the audit", "the audit row" | the relation `audit_events` — append-only by trigger (`0004:18-23`), `INSERT` only for `daftar_app` (`0006:79`) | `outbox_events`, which `daftar_app` may also `UPDATE` (`0006:80`) because the publisher marks rows published. The two are **not** one "log" |
| "log" | **nothing.** No relation in the tree matches `*_log`. Name `audit_events` or `outbox_events` | — |
| "delivery" | in `P4-AL-49`, the **publication of an outbox event** (`OutboxService`: "Delivery is at-least-once") | a goods **delivery note** (Phase 4 models none) and `credential_deliveries` / `apps/api/src/modules/delivery/**`, which are encrypted credential email (`0020:6`) |
| "adjustment" | whichever of four relations is named explicitly: `accounting_manual_adjustments` (`0046:131`), `inventory_adjustments` (`0061:541`), `inventory_adjustment_lines` (`0061:569`), `negative_inventory_cost_adjustments` (`0063:357`) | the "rounding-adjustment line" of `P4-AL-19` (`:464`), which is a forbidden journal **line shape** with no relation behind it, no `rounding_difference_minor` column and no `6100` line |

`credential_deliveries` and `apps/api/src/modules/delivery/**` are **not** renamed: `0020` is frozen and the
module is accepted Phase 1 surface. The ambiguity is resolved by naming referents, never by renaming
accepted code. The card is `docs/PHASE_4_DECISION_REGISTER.md` §6.


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
`tests/browser/invariants.ts:207-209`'s `acctRe` matches a bare `tax`, `taxes`, `vat`, `vergi`, `kdv` and the
Arabic stem `ضريب`, and drives the **`jargon`** rule over the whole rendered text — not the narrower
`tax-control` rule at `:210-216`, which is scoped to form controls. Either way it fires only on the screens
the gate walks, so a POS screen merged today is unguarded for jargon and for the tax boundary alike, and both
guards stay green while saying nothing.

That has a consequence P4-AL-44 must answer rather than inherit: because `acctRe` forbids the *word*, a
Phase 4 screen cannot render a tax row at all while the `jargon` rule stands. So **no Phase 4 screen renders
a tax field while sales tax is structurally zero.** The column exists, the journal shape has the line's
place, and the invoice template's tax row is added by the Country Pack that enables non-zero tax — at which
point the words move from `jargon` into `tax-control`, which is an edit to an accepted Phase 3 invariant file
and needs the same authorisation `OD-P4-11` describes. Not rendering a zero tax line is the cheaper half of
the trade and it keeps an accepted guard untouched.

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
`check:deployment-authority` and the two prefix modules. **Amended by `TL-P4-S2-R3` — REQUIRED-CI CHAIN
COMPOSITION:** from `gate:phase4:s2` onward a slice gate discharges the composition requirement **either**
internally **or** by running as an ordered, visible step of the one required `backend` job beside its
predecessor's step, which makes it a **delta** gate — `gate:phase4:s2` need not re-execute `gate:phase4:s1`'s
~50-minute estate inside itself to be composed, because `P4-S1 → P4-S2 → later slice gates` run sequentially
in that job and a red predecessor fails the same required check. The option is legal **only** while the
precondition of `P4-AL-58` holds. It is confined to the slice gates: `gate:phase4:release` is unchanged and
still composes `gate:phase3:release` and `gate:phase4:s8` **verbatim and internally**, because a release gate
must be one command that can run from an extracted archive with no workflow around it. Every gate: runs the runner canary **before**
trusting any result and refuses the matrix if the runner cannot report failure
(`[[daftar-a-green-gate-must-prove-it-can-be-red]]`); runs structural checks before any suite; carries
explicit `SUITES` / `COMMANDS` / `RED_PROOFS` / `BUDGETS` tables in which a `{ pending }` row is a **FAIL**
and never a skip, a listed suite that is missing or carries `.skip`/`.only`/`.todo` fails, and a `p4-*`
suite on disk that no entry lists fails; supports `--list`, `--root` and `--structural-only`; and writes
machine-readable evidence. `gate:phase4:release` composes `gate:phase3:release` and `gate:phase4:s8`
verbatim, adds only the closure's own business, must run from an extracted archive, and fails before running
anything if any `RELEASE_GATE_SKIP_*` is set.

**P4-AL-58 — The slice gates are an ordered, visible chain of steps inside the one required `backend`
job, and that ordering is itself asserted structurally.**
This decision began as a diagnostic preference — `ci.yml` records the original reason, that when a
predecessor breaks a reviewer should see **which** one failed in the step list rather than reading the log of
a gate that contains all of them. Under `TL-P4-S2-R3` it is more than a preference: when a successor is a
delta gate, the **job is the composition**, so the chain's shape is load-bearing and is no longer a
convention anybody has to remember.

The precondition, in full: for every wired Phase 4 slice gate, a step exists in the **required** `backend`
job; the predecessor's step **precedes** the successor's; neither step nor the job carries
`continue-on-error`; neither step nor the job carries an `if:`, and the workflow triggers on an ordinary
`push` and `pull_request`, so no normal push or pull request can skip a step; and the command is exactly the
gate's own npm script (`npm run gate:phase4:s2` for P4-S2). The blocker that produced the ruling was exactly
this precondition failing: the required job ran `gate:phase4:s1` and never ran `gate:phase4:s2`, so every
green reported for the slice was green for a workflow that never ran the slice's gate —
**a green workflow is not evidence for a gate the workflow never ran.**

`tests/guards/required-ci-chain-composition.test.ts` is the permanent check. It **parses**
`.github/workflows/ci.yml` into mappings and sequences and asks each of the seven claims of a key's value at
a position in the document tree, so a reordering, a re-indentation, a move into another job or a
`continue-on-error` landing on the job rather than the step is actually seen — and so is comment text, in the
sense that it cannot satisfy anything: comments are discarded before any claim is asked, because a law that
reads prose is a law about its prose. It carries the red proofs the discipline
requires, each planted on a mutated **copy** of the workflow text: the step removed (with a comment that
still names the command left behind), the two steps reordered, `continue-on-error` added to the step and to
the job, an `if:` added, the command changed or weakened, the step moved into another job, the push trigger
removed, the required job renamed, and the step re-indented out of its sequence — plus the green direction,
that the workflow as it stands passes. It lives in `tests/guards/`, which `gate:phase4:s1` runs as a
directory (`GD-01`), so it executes **before** the step it is about on every required run.

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
`(customer|sale|invoice)` (`:58-65`). And it goes further than the tables: every verb on `/v1/payments`,
`/v1/refunds`, `/v1/customer-credits`, `/v1/credit-notes`, **`/v1/invoices`** and **`/v1/sales`** must return
404 to a business owner (`:81-108`); `accounting_source_types` filtered by
`/payment|refund|sale|invoice|customer|credit/` must equal the S6 list exactly (`:113-115`), as must
`DOMAIN_SOURCE_TYPES` in `packages/accounting/src/post.ts` (`:120`) — which §2.2 *requires* Phase 4 to
extend; and `inventory_operation_kinds` must hold nothing matching `/sale|invoice|customer/` and exactly four
`payment.*` kinds (`:124-133`), which every operation code of P4-AL-28 breaks.

It is a permanent suite, required by name at `scripts/phase3-s6-gate.ts:172`, so it is composed by
`gate:phase3:s6` -> `s7` -> `s8` -> `gate:phase3:corrective` and through that by `gate:phase3:release` **and
by `gate:phase4:s1`**. So the first Phase 4 migration, the first Phase 4 source type, the first Phase 4
operation code and the first Phase 4 route each turn an **accepted Phase 3 gate** red, and every Phase 4 slice
gate red with it through composition.

Neither available shortcut is acceptable. Deleting the suite deletes a real Phase 3 protection — that P3-S6
built a supplier settlement surface and did not quietly build a customer one. Adding an allowlist of the Phase 4
names turns a "these do not exist" assertion into a "these exist and that is fine" assertion, which asserts
nothing.

The resolution is to say what the test always meant. Its invariant is **phase-scoped**: *the Phase 3
settlement work built a supplier surface and did not quietly build a customer one.* That is a claim about
migrations `0053–0073` and about the supplier side, not about the database a later phase also populates. So it
is re-expressed in two halves, each keeping its full force:

- **The absolute-absence assertions become structural.** Instead of asking today's catalogue whether
  `customers` exists, the suite reads the Phase 3 prefix's own accepted files — `scripts/phase3-prefix.ts`
  already holds their names and digests — and asserts that no migration in `0053–0073` creates a relation
  matching those patterns. It still fails if a Phase 3 migration is edited to add a customer table, and it now
  says nothing about the future. Red proof: plant a `CREATE TABLE customers` into a scratch copy of a Phase 3
  migration and require the suite to name that file.
- **The exact-list and route assertions become supplier-scoped.** The `(payment|refund|credit_note|credit_alloc)`
  relation set (`:64-76`), the `accounting_source_types` and `DOMAIN_SOURCE_TYPES` lists (`:113-120`), the
  `inventory_operation_kinds` list (`:124-133`) and the 404 assertions (`:81-108`) each keep every
  `supplier_*` name they carry and drop the absolute equality, so what they assert is *the supplier settlement
  surface is exactly these objects and these routes and nothing more* — the property P3-S6 actually bought.
  Red proof: plant a second supplier-side refund route or source type and require the suite to name it.

`[[daftar-a-closure-rule-is-not-an-invariant]]` is the whole argument: the invariant that outlives the slice is
the shape of what the slice built, never "nothing else will ever exist".

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
| G-18 | inventory = stock ledger (GOLD-33, `R-INV-01…05` with sales) | `GL Inventory (1200) = Σ stock_movements.value_delta_base_minor` exactly after purchase-at-two-costs → sale → return → void → transfer → adjustment; `Σ line COGS = posted COGS` after `HALF_EVEN`; no intermediate rounding | S8, with S2 owning the sale-side movement law |
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
Sixteen new steps added to `flows.ts` and exported as `PHASE4_STEPS`, **every one `p4-` prefixed** so no
name can collide with a Phase 3 step: `p4-pos`, `p4-pos-credit`, `p4-pos-keypad`, `p4-customers`,
`p4-customer`, `p4-statement`, `p4-invoices`, `p4-invoice`, `p4-collect`, `p4-return`, `p4-refund`,
`p4-installments`, `p4-installment-collect`, `p4-debts`, `p4-void`, `p4-states`. The prefix is not cosmetic:
`flows.ts:275` already has `run.step('return', …)` — the supplier return, one of the fifteen Phase 3 steps —
and `tests/browser/gate.ts:97,185` filters `--steps` as a plain name list with step records keyed by name
(`run-context.ts:25`, `gate.ts:194-197`), so a second `return` would be run by `--steps=<PHASE3_STEPS>` and
would reintroduce the exact coupling P4-AL-63 exists to remove, as well as colliding in the evidence
records. P4-AL-63 therefore also asserts the two exported lists are **disjoint**, and `run.step` refuses a
duplicate step name — a two-line assertion with its own red proof. 16 × 9 = 144 step-runs per gate run on top of the
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
| P4-R | one full `R-SAL-*` + `R-INV-*` pass over the ≈1 000 000-line business | **calibration-locked**, hard cap total ≤ 300 s | Budget F's 300 s (`accounting-budgets.test.ts:63-64`) covers the **Phase 2** checks only; Phase 4 adds seven `R-SAL-*` and five `R-INV-*` checks over a second million-row relation, so reusing the number would be neither anchored nor calibrated. The 300 s becomes an independent product cap above a calibrated ceiling, on the P4-C rule (`OD-P4-13`) |

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
`0059:59`, `0059:69`) and whatever the extended guards require. **Corrected in P4-S1 (`TL-P4-S1-C3`): this is
three statements plus one different statement, not one statement repeated four times.** `0072:812-814` already
dropped and re-added `inventory_operation_kinds_registered_by_check` as
`CHECK (registered_by ~ '^P3-S[0-9]+$' OR registered_by = 'P3-C')`, and `0072:817` inserted
`('purchase.write_off_residue', 'P3-C')`. So the live constraint is not `0054:54`'s text, and a widening that
produces a bare `^P[0-9]+-S[0-9]+$` **fails at `ADD CONSTRAINT`** because the existing `P3-C` row violates it.
The fourth statement must be `CHECK (registered_by ~ '^P[0-9]+-S[0-9]+$' OR registered_by = 'P3-C')`. A
migration reads the live catalogue, never the migration that wrote it — `[[daftar-the-live-catalogue-is-the-policy]]`. Putting them first means the first red CI run
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

**The one edge worth naming: "cart".** The roadmap gives Phase 6 "cart and checkout"
(`docs/DAFTAR_IMPLEMENTATION_ROADMAP.md:37-39`). A POS till basket and a public checkout cart are different
things, but a name-based `FUTURE_SLICE_SURFACES` list has no rule by which a `cart` table is Phase 4 here and
Phase 6 there. So Phase 4's are named `pos_till_sessions` and `pos_cart_lines`, the Phase 4 basket is defined
as server-side state keyed by an authenticated till session with **no public route**, and
`FUTURE_SLICE_SURFACES` carries the `pos_` prefix rule rather than a bare `cart` name. The refusal then
survives Phase 6 arriving.

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

Each of these was a point this lock deliberately did **not** settle, because settling it would have meant
inventing a commercial policy, a legal policy or an authority the Tech Lead had not granted. Each carries its
options, the risk of each option, the engineering recommendation, and whether it blocks a slice.

**STATUS AFTER THE P4-S0 FINAL CORRECTIVE SEAL DIRECTIVE (2026-09-30).** The Tech Lead has ruled on every
decision below. Each ruling is recorded under its decision as a **`TECH LEAD RULING`** and is binding on every
slice and every agent. **`OD-03` is the only decision that remains open**; `OD-P4-01` … `OD-P4-15` are all
**CLOSED** and are implemented as ruled, not re-opened, re-argued or re-designed.

**OD-03 — non-zero jurisdiction-specific tax. Carried forward unchanged and not closed.**
Extended in this lock to the **sales** side with its own boundary (P4-AL-44, P4-AL-45). No country's law is
researched and no rate, rule, threshold, exemption, recoverability or legal invoice field is guessed. *Blocks:*
nothing in Phase 4, because Phase 4 ships structural zero.

**TECH LEAD RULING (2026-09-30) — STAYS OPEN.** This is the one decision that remains open after this
seal. Phase 4 supports **structural zero sales tax only**. Any non-zero tax is **REFUSED** until an approved
**Country Pack** built on official legal and tax sources exists. No VAT rate, exemption, threshold,
inclusive/exclusive rule, legal invoice field or registration rule may be guessed, and no country's law is to
be researched now.

**OD-P4-01 — the cashier's first financial authority, and what happens to existing cashiers.**
Phase 4 is the first phase in which a `Cashier` role does anything financial. *Options.* (a) The default set of
P4-AL-35 — read, cash sale, collect payment — and everything else by explicit delegation. (b) Add
`sales.discount` to the default, because a till that cannot discount is unusable in a shop that haggles.
(c) Give cashiers nothing by default and require delegation even for a cash sale. *Risks.* (a) means a shop must
delegate discounting to every cashier on day one, which is friction that invites over-delegation. (b) grants a
sensitive, value-moving key by default. It is **buildable**: the Phase 2 and Phase 3 "no sensitive leak"
checks are one-shot migration-time assertions over their own key arrays (`0041:57-65`, `0057:140-151`), not
constraints, so nothing in the database refuses it today. It is refused by the Phase 4 assertion P4-AL-37
requires P4-S1 to write — a decision this lock is making, not a fact it inherited.
(c) makes the role pointless. *Recommendation.* (a). *And the backfill is the real question:* existing
`Cashier` memberships predate these keys, so P4-S1 must either grant the new default keys to existing cashiers
or leave them unable to sell. Recommendation: grant the non-sensitive defaults in the migration, audited, and
grant nothing sensitive. *Blocks:* **P4-S1's migration**, not its start.

**TECH LEAD RULING (2026-09-30) — OPTION A.** The cashier receives **only non-sensitive operational
permissions by default**, and existing cashiers receive an **audited backfill of those same non-sensitive
defaults**. Forbidden as a default, for the cashier and for any built-in role: `sales.discount`, `sales.void`,
`refunds.approve`, `payments.reverse`, `installments.manage`, and any other sensitive permission. The default
set is closed by the Phase 4 `role_permissions` assertion (P4-AL-37), with a planted-defect red proof.

**OD-P4-02 — price override, or discount only.**
*Options.* (a) Discount only: the catalogue price is the price, and a reduction is a discount with its own
permission and its own audit row. (b) Free price override at the till under `sales.discount`. (c) Override
bounded by a per-business floor percentage. *Risks.* (a) cannot express a negotiated price above catalogue,
which some trades need. (b) makes the catalogue price advisory and makes margin analysis meaningless, and it is
indistinguishable from the forged-total attack when it arrives over HTTP. (c) needs a policy number nobody has
given. *Recommendation.* (a) for Phase 4 — a discount is auditable as a decision, an override is not. *Blocks:*
P4-S3's cart design, so it should be answered before P4-S3 starts.

**TECH LEAD RULING (2026-09-30) — OPTION A.** **Discount only.** No arbitrary price override in Phase 4.

**OD-P4-03 — a customer credit limit.**
*Options.* (a) No limit in Phase 4: a credit sale is permitted whatever the balance, and the balance is visible.
(b) A per-customer limit that refuses the sale. (c) A limit that warns and permits with a permission.
*Risks.* (a) lets a shop extend unbounded credit unknowingly. (b) refuses a sale at the till, which is the
worst place to discover a policy. (c) needs the authority question answered (who may override, and is it
sensitive). *Recommendation.* (a) for Phase 4, with the balance and the aging shown on the customer picker, and
(c) as a named Phase 5 candidate. *Blocks:* nothing; it adds a column later without re-modelling.

**TECH LEAD RULING (2026-09-30) — OPTION A.** **No customer credit limit in Phase 4.** The balance and its
aging are shown clearly; there is no hidden limit and no silent refusal driven by one.

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

**TECH LEAD RULING (2026-09-30) — OPTION B AUTHORIZED.** Mid-chain allocation reversal is implemented as an
**append-only negative release / reducer at the current chain head**. Deleting or modifying a historical
release is **forbidden**. Before any reversal product code is written, the telescoping identity must be proved:
`rel(X, a) = R(X + a) − R(X)` and `rel(S, −a) = R(S − a) − R(S)`. The tests must prove: reversal of the first,
a middle and the last allocation; `HALF_EVEN` ties; cross-currency; multiple allocations; refusal of a
duplicate reversal; concurrent reversal attempts; the exact carrying value; no one-minor-unit residue; and that
history stayed append-only. **If the proof fails, the only permitted fallback is OPTION A / LIFO-only.**
Forbidden: rewriting history, recomputing old releases, inventing a third mechanism. This unblocks P4-S6 and
TD-15.

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

**TECH LEAD RULING (2026-09-30) — OPTION A.** **No oversell for stock-tracked products.** A requested
quantity greater than `on_hand` is refused atomically. Non-stock-tracked products stay sellable with no
decrement. The stock writer is **not** changed to permit negatives.

**OD-P4-06 — interest or fees on an installment plan.**
*Options.* (a) None in Phase 4: `Σ instalments + down = invoice total`, exactly, enforced by the database
(P4-AL-13). (b) A flat fee added as an invoice line at plan creation. (c) Interest accrued over the schedule.
*Risks.* (a) is the only option under which the installment law's sum constraint holds as written. (b) is
buildable — it is an invoice line, so revenue and AR are ordinary — but it changes what the total means and
needs a commercial decision about whether the fee is refundable on early settlement. (c) is a different product:
it needs an accrual schedule, a second revenue recognition pattern and, in many jurisdictions, a licence.
*Recommendation.* (a). *Blocks:* nothing; (b) is additive later.

**TECH LEAD RULING (2026-09-30) — OPTION A.** **No interest and no installment fees in Phase 4.**
`Σ installments + down payment = invoice total`, exactly.

**OD-P4-07 — unrealized FX on a customer statement.**
*Options.* (a) The statement shows amounts in the invoice's own currency and the base carrying value as
recorded, with no revaluation. (b) A revaluation column at today's rate, displayed only. (c) Posted
revaluation entries. *Risks.* (a) understates what a foreign-currency receivable is worth today, which a merchant
may read as an error. (b) puts a number on a financial screen that no journal line supports, and someone will
reconcile against it. (c) is period-end accounting policy Phase 4 has no mandate for. *Recommendation.* (a),
with the rate and date of each line visible so the merchant can see why. *Blocks:* nothing.

**TECH LEAD RULING (2026-09-30) — OPTION A.** **No unrealized FX revaluation.** The statement shows the
original currency alongside the historical carrying and base figures.

**OD-P4-08 — writing off a terminal AR residue.**
A cross-currency AR can end with a residue of a few minor units that no payment will ever clear.
*Options.* (a) No write-off in Phase 4: the residue stays and is visible. (b) A write-off command with its own
permission, its own journal entry (`Dr` a bad-debt or FX account `/ Cr` AR) and its own audit. (c) An automatic
threshold below which a residue is written off on settlement. *Risks.* (a) leaves customers with 3-minor-unit
balances forever, which looks like a bug. (b) is a new financial command with a new account identity, in a phase
that already has enough. (c) is a silent automatic journal entry triggered by a threshold nobody set, which is
the worst of the three. *Recommendation.* (a) for Phase 4 and (b) as a named Phase 5 candidate. *Blocks:*
nothing.

**TECH LEAD RULING (2026-09-30) — OPTION A.** **No AR residue write-off in Phase 4**, neither automatic nor
manual, and **no silent threshold**. The residue stays and is visible.

**OD-P4-09 — whether a till session may be shared between cashiers.**
*Options.* (a) One session, one authenticated user; a shift change is a new session. (b) A shared till session
with a per-sale actor. *Risks.* (a) is unambiguous for audit and slightly slower at a shift change. (b) makes
the audit row's actor and the session's owner different people, and a cash-drawer discrepancy then has no
single owner. *Recommendation.* (a). *Blocks:* P4-S3's session model.

**TECH LEAD RULING (2026-09-30) — OPTION A.** **One till session = one authenticated user.** A change of user
is a new session.

**OD-P4-10 — whether the Phase 4 goldens run in `test:golden` as well as inside the slice gates.**
*Options.* (a) Both, accepting that they run twice per CI run. (b) Only in the gates. *Risks.* (a) costs CI
minutes; the Phase 3 release gate already accepted double execution on principle. (b) means a golden regression
is reported by a large composed gate's log rather than by a small, early, clearly-named step — the readability
problem `ci.yml:257-262` was written about. *Recommendation.* (a). *Blocks:* nothing.

**TECH LEAD RULING (2026-09-30) — OPTION A.** The Phase 4 goldens run in **both** `test:golden` and the
relevant Phase 4 gate; duplicate execution is accepted.

**OD-P4-11 — whether `gate:phase3:corrective`'s browser-matrix assertion is relaxed from equality to superset.**
*Options.* (a) Leave it as equality; Phase 4 adds no locale and no viewport (P4-AL-64). (b) Relax to superset,
with the directive floor unchanged. *Risks.* (a) permanently forbids a fourth locale or viewport for as long as
that gate is permanent, which is forever. (b) edits an **accepted Phase 3 gate**; it weakens nothing, but "we
edited an accepted gate" must be explicit and authorised. *Recommendation.* (a) for Phase 4, and raise (b) when
a fourth viewport or locale is actually wanted rather than pre-emptively. *Blocks:* nothing, unless a Phase 4
screen genuinely needs a viewport the current three do not cover.

**TECH LEAD RULING (2026-09-30) — OPTION A.** The accepted Phase 3 browser equality is **not modified**. The
same `ar`/`en`/`tr` and the same phone/tablet/desktop viewports stand.

**OD-P4-12 — the `browser` job's wall-clock budget once Phase 4 roughly doubles the step count.**
*Options.* (a) Raise `timeout-minutes` from 40 to about 90, one job. (b) A `strategy.matrix` over locale
**inside** the `browser` job, keeping the job name unchanged. (c) Move the full matrix to the dispatched
workflow and run a reduced one per push. *Risks.* (a) a 90-minute required job slows every PR. (b) a matrix leg
may produce a separate check context, which could break the required-checks configuration — unverifiable from
the tree. (c) **weakens the per-push claim** and would let a Phase 4 screen regression reach a reviewer green.
*Recommendation.* (a) first, measured; (b) only after confirming in repository settings that the required-checks
key is unaffected; (c) **refused**. *Blocks:* the slice that first makes the job exceed its timeout.

**TECH LEAD RULING (2026-09-30) — OPTION A, MEASUREMENT TRIGGERED.** The browser timeout is **not** raised
pre-emptively. If real measurement proves 40 minutes insufficient, the **same full required browser job** is
raised to about 90 minutes. Forbidden: a reduced per-push matrix, and moving any coverage out of required CI.
**OPTION C is refused.**

**OD-P4-13 — the absolute cap on the sale-commit and return+refund budgets.**
*Options.* (a) A 1 000 ms hard cap stated as a product requirement — a POS sale slower than a second is a defect
whatever the machine measures. (b) No absolute cap; the calibration-locked p95 × 1.3 is the only ceiling.
(c) A cap derived from the composed anchors alone, with no round number. The same question applies to
**P4-R**, whose 300 s came from Budget F for the Phase 2 checks alone and now has to cover twelve more checks
over a second million-row relation. *Risks.* (a) is a number nobody
measured; its defence is that it is a **product** statement rather than a measurement, which makes it the Tech
Lead's or the owner's to set rather than an engineer's to invent. (b) means a slow implementation locks in its
own slowness at acceptance and the budget can only ever say the product got slower, never that it is too slow.
(c) is the most defensible but is not knowable until the calibration run, so the gate cannot be red on day one.
*Recommendation.* (a) **and** (c) together: the composed-anchor calibration sets the operative ceiling,
tighten-only thereafter, and the 1 000 ms cap sits above it as an independent product floor a calibration result
may not exceed — a calibration landing above 1 000 ms is a **FAIL to be diagnosed**, not a ceiling to be
written. The 1 000 ms value itself needs confirmation. *Blocks:* **P4-S2's and P4-S5's acceptance**, not their
start.

**TECH LEAD RULING (2026-09-30) — A + C.** For sale commit and for return+refund there is a **hard product
ceiling of `p95 ≤ 1000 ms`**, together with a tighter calibration-derived ceiling; the effective ceiling is
`min(1000 ms, accepted calibrated ceiling)`, and it may only ever be **tightened**. The Phase 4 reconciliation
hard upper bound is **≤ 300 seconds** and is never raised automatically.

**OD-P4-14 — the per-invoice constant in the allocation budget, and the 3× RLS cost threshold.**
*Options.* (a) Both calibration-derived, then tighten-only. (b) Both fixed now from the nearest anchors.
*Risks.* (a) means the absolute ceilings are not final until P4-S4, though the ratio assertions are red-capable
immediately. (b) picks numbers from a different query family, and the 3× RLS threshold in particular has **no
measured anchor anywhere in the tree** — the Phase 2 RLS work proved an *answer* equivalence and removed a
correlated subplan; it never published a cost ratio. *Recommendation.* (a), with 3× recorded as **provisional**
and confirmed by the first Tier-2 run's measured ratios. *Blocks:* P4-S4's and P4-S8's acceptance evidence, not
any slice's start.

**TECH LEAD RULING (2026-09-30) — OPTION A.** The allocation scaling constant and the RLS cost thresholds are
**calibration-derived and tighten-only**. The `3×` figure stays **provisional** until a real Tier-2
measurement replaces it.

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


**TECH LEAD RULING (2026-09-30) — OPTION A.** Phase 4 implements the canonical goldens **owned by a phase
≤ 4 and in scope**, and adds the per-id **owning phase** metadata. **No stubs** are created for ids owned by a
later phase.

---

## 23. Independent architecture review

An independent reviewer read this document and `docs/PHASE_4_EXECUTION_PLAN.md` against the current tree,
without relying on the coordinator's summary, hunting a fixed list of nineteen failure classes: double
posting; a duplicate source of truth; a stale customer balance; a cross-business FK hole; double revenue
reversal on return or refund; a payment reversal leaving allocations stale; a split commit between stock and
accounting; races on the last item, on invoice numbering, on allocations and on refunds; installment double
counting; forged client totals; permission escalation; branch-scope bypass; an FX mismatch; an accidental
non-zero tax policy; a migration conflict; and Phase 5/6/7 scope leakage.

It returned twenty findings, RT-01 … RT-20, and eleven contradictions. Every one is tabulated in
**§9, Independent review**, of `docs/PHASE_4_EXECUTION_PLAN.md`, with the decision that closed it. Every
finding it raised — Critical, High, Medium and Low alike — was closed in this document before the verdict was
given, and five of them changed a decision rather than a sentence:

- **RT-01 (Critical)** — §4 pinned revenue to `4100`, which is **Sales Returns**; revenue is `4000`
  (`0040:59-60`). Following the matrix would have netted revenue to zero against returns in a perfectly
  balanced entry: the exact defect GOLD-28 exists to catch. Corrected, with a separate row for the returns
  account.
- **RT-02 (Critical)** — the permanent Phase 3 suite of P4-AL-88 asserts far more than the table half this
  document originally named: the routes, both source-type registries and the inventory operation kinds too.
  P4-AL-88 now carries all of it.
- **RT-03 (High)** — `accounting_reversals_20_domain_source_guard` is a closed literal list ending at Phase 3
  while `accounting_post_reversal` is granted to `daftar_app`, so the generic reversal path was open on a
  Phase 4 entry and would have consumed its one reversal slot. Now a §2.2 requirement with a gate assertion.
- **RT-04 (High)** — `customer_payment.*` is **unbuildable**: the op-code regex forbids an underscore in the
  first segment, and the same regex lives in a frozen routine body. The namespace is now `customer.*`.
- **RT-05 (High)** — the "role-default constraints" this document relied on are one-shot migration-time
  assertions over hard-coded key arrays, not constraints. Nothing binds a Phase 4 key. That enforcement is
  now the fourth protection Phase 4 must build, and `OD-P4-01`'s false "unbuildable" premise is corrected.

The review also found the one internal contradiction that mattered: the sale's step order took the invoice
sequence between two journal acquisitions while the declared lock order called it the last lock *after* the
journal. Resolved in P4-AL-32 and P4-AL-41 by declaring the **domain** order and treating
`accounting_post_entry`'s internal locks as its own, because the sale enters the journal twice.

---

## 24. What P4-S0 did not do

No product code. No endpoint. No POS screen. No migration. `0074` does not exist. No Phase 4 table, routine,
route, component or string was created. No gate, suite or budget was executed. No country's tax law was
researched and OD-03 is not closed. P4-S0 touched **five documents in total: three existing and two new** (`TL-P4-S0-02`).
The three existing canonical documents it corrected are `PROJECT_STATUS.md`, `TECHNICAL_DEBT.md` and
`docs/DAFTAR_IMPLEMENTATION_ROADMAP.md` (§3.1 covers their stale claims in four rows — four rows over three
documents, not four documents). The two new documents it created are this document,
`docs/PHASE_4_ARCHITECTURE_LOCK.md`, and `docs/PHASE_4_EXECUTION_PLAN.md`. No other file was changed.

P4-S1 does not begin until the Tech Lead says so.

---

## 25. The Tech Lead corrective seal (2026-09-30)

The Tech Lead reviewed this lock and returned the verdict **`P4-S0 — NARROW CORRECTIVE PASS`**: the
architecture is **not rejected**, Phase 4 is **not** redesigned, and P4-S0 is **not** widened. Three named
corrections were required, and each is closed here.

### TL-P4-S0-01 — inventory reconciliation formula regression
**High — Data Integrity / Architecture Contract. CLOSED.**
This lock still stated the inventory reconciliation identity as `GL(1200) = Σ(qty × avg)` in two places
(`P4-AL-25` and the `G-18` row of §17.4), which contradicts both this lock's own reasoning and the accepted
Phase 3 law (`P3-AL-43`, `P3-AL-49` §B, `INV-INV-06`). Average cost is a **derived rounded quotient**;
re-multiplying it reintroduces the rounding drift the stored integer delta has already resolved, and it
establishes a second source of truth beside the ledger. The single official formula, everywhere in Phase 4, is:

> **`GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`**

`quantity × average_cost` is **never** the reconciliation truth. Both occurrences were replaced, and all Phase 4
documents were searched for `qty × avg`, `qty*avg`, `qty×avg`, `quantity × average` and equivalent paraphrases;
no other occurrence exists.

### TL-P4-S0-02 — canonical document count
**Low / Documentation. CLOSED.**
§24 and the plan's P4-S0 outputs said "four canonical documents". The truth is **five documents: three existing
and two new**. Existing and corrected: `PROJECT_STATUS.md`, `TECHNICAL_DEBT.md`,
`docs/DAFTAR_IMPLEMENTATION_ROADMAP.md`. New: `docs/PHASE_4_ARCHITECTURE_LOCK.md`,
`docs/PHASE_4_EXECUTION_PLAN.md`. §3.1 covers the three existing documents' stale claims in **four rows** — four
rows over three documents, which is what produced the miscount.

### TL-P4-S0-03 — protection count / taxonomy
**Low / Documentation. CLOSED.**
The plan's P4-S1 heading read "the three protections" over a list of **six** numbered pre-migration actions.
The taxonomy is now stated explicitly: **four protection classes implemented through the mandatory
pre-migration actions that implement them**, each action mapped to its class. No heading states a count that
its own list contradicts. The count was **six** when this correction was made and became **seven** in P4-S1
when `TL-P4-S1-C7` found a further forward-evolution breakage; the execution plan carries the current count
and is the single place it is stated, so the two documents cannot drift again.

### Tech Lead rulings
Every open decision except `OD-03` is now **CLOSED** by a recorded **`TECH LEAD RULING`** in §22:
`OD-P4-01` A · `OD-P4-02` A · `OD-P4-03` A · `OD-P4-04` **B authorized** (append-only negative release at the
chain head, telescoping proof first, LIFO-only as the sole fallback) · `OD-P4-05` A · `OD-P4-06` A ·
`OD-P4-07` A · `OD-P4-08` A · `OD-P4-09` A · `OD-P4-10` A · `OD-P4-11` A · `OD-P4-12` A (measurement
triggered) · `OD-P4-13` A + C · `OD-P4-14` A · `OD-P4-15` A. `OD-03` stays open: Phase 4 ships **structural
zero sales tax only**, and any non-zero tax is refused until an approved Country Pack built on official legal
sources exists.

### P4-S1 coordinator corrections to this lock (2026-09-30)

P4-S1's first parallel wave read the SQL rather than this document and returned corrections to it. Each was
re-verified against the code before it was applied, and each is applied **in place** at the decision it
corrects, so this document never states a claim its own later section contradicts. Nothing below is a
redesign of Phase 4 or a widening of a slice.

| id | decision | correction |
|---|---|---|
| `TL-P4-S1-C1` | `P4-AL-06` | A bare `cost` in the pattern would flag twelve accepted Phase 3 per-unit input columns, so the pattern is `cogs` and a cost **total**. `refunded`, `receivable`, `collected` and `allocated` are added explicitly, because the inherited AP vocabulary has no `refunded` and the decision's own stated outcome was therefore untrue. The gap has a **relation** dimension as well as a column one. The rewiring carries the vocabulary on both arms, because `phase3-s8-guards.test.ts:108-111` pins them as a disjoint partition. |
| `TL-P4-S1-C2` | `P4-AL-38` | The accepted policy count is **six** on an ordinary relation and **seven** on an accounting-source relation, not five. Omitting `accounting_validator` on `invoices` under `FORCE ROW LEVEL SECURITY` makes the deferred completeness validator read zero rows and **pass vacuously**. The tenant policy takes the direct `nullif(app_tenant(), '')::uuid` form `0052` measured, not the correlated subselect. |
| `TL-P4-S1-C3` | `P4-AL-84` | The `registered_by` widening is three statements **plus one different statement**: `0072:812-814` already re-added the `inventory_operation_kinds` CHECK with `OR registered_by = 'P3-C'` and `0072:817` inserted such a row, so a bare widened pattern fails at `ADD CONSTRAINT`. |
| `TL-P4-S1-C4` | `P4-AL-31`, `D-10` | Citation corrected from `0059:135,147` (the wrong ordinal, `stock_movements.stock_seq`) to `0059:216`. |
| `TL-P4-S1-C5` | `P4-AL-15b` | The decision's own DDL vocabulary opted out of the guard it cites: a bare `quantity NUMERIC(18,2)` produced no finding. The pin is extended to the word forms; the column is **not** renamed to dodge the guard. |
| `TL-P4-S1-C6` | `P4-AL-16` | `binding_source_id` has two accepted shapes. A relation with a `draft` state takes the nullable `purchases` variant with the status-conditional CHECK, not the `NOT NULL` allocation variant. |
| `TL-P4-S1-C7` | execution plan, P4-S1 | A **seventh** mandatory pre-migration action: `assertMigrationState()` and `assertS4MigrationState()` assert the complete registry contents with one `toEqual` and are called from 13+ sites across four permanent Phase 3 files, so one Phase 4 registry row turns all of them red. Consequence: the first Phase 4 migration carries no registry row at all. |
| `TL-P4-S1-C10` | `P4-AL-28` | The decision is sound and its citation is wrong. The second copy of the op-code pattern `^[a-z]+(\.[a-z_]+)+$` at `0054:229` is inside **`inventory_payload_digest`** (`CREATE OR REPLACE FUNCTION` at `0054:214`), not inside `inventory_assertion_consume`, which carries the different colon-separated assertion preimage `^[a-z]+(:[a-z_]+)+$`. Exactly one live routine body carries the op-code pattern, confirmed from `pg_proc`. So the reason the NAMESPACE moved instead of the regex stands — the copy is in a frozen body `P4-AL-27`/`P4-AL-29` forbid replacing — but any change reasoning from the named routine would have changed the wrong one. `0074` asserts both halves of the namespace by performing them, and `tests/guards/phase4-registry-widening-guard.test.ts` §C discovers the carrier from the catalogue rather than trusting either citation. |
| `TL-P4-S1-C8` | §19 | The first Phase 4 migration adds **no** `MIGRATION_MANIFEST.json` entry. `scripts/check-migration-manifest.ts:51-58` allows a file newer than the frozen set and fails only on a file at or below `frozenThrough` that is missing, so the entry is added at acceptance by whoever moves `frozenThrough`. Freezing a digest early turns `check:migrations` red on the next edit of the same file. |
| `TL-P4-S1-C11` | `P4-AL-06`, G-3 | `invoices.due_date` — the payment term a merchant AGREES, an input to the aging computation — was a G-3 finding, because the "not a quantity" exemption in `scripts/guards/no-authoritative-balance.ts` carried `_at` and not `_date`. The correction is one suffix: `_date` joins both exemption lists, so a due DATE behaves exactly as the accepted `due_status` already does, while `(^|_)due($|_)` on any numeric column is untouched. A date cannot hold money or a quantity and so cannot drift from a sum, which is this rule's whole subject. The column is **not** renamed to dodge the guard. **And a first attempt went further and was wrong, which is recorded because the reasoning is the lesson:** it consulted a new `DERIVED_SETTLEMENT_INSTANT` pattern BEFORE the exemption, on the ground that `_at` being blanket-exempt hid `settled_at` and that closing it made the guard strictly stronger. `tests/integration/accounting-guards.test.ts:272` refutes it — `paid_at` is in the list of columns this rule must ALLOW, beside `paid_by`, and deliberately so, because on a payment document `paid_at` is a fact of that document and not a derivation. Whether a settlement instant is derived depends on WHICH RELATION carries it, and a tree-wide column vocabulary is relation-blind, so the pattern would have refused the fact in order to refuse the derivation. It is therefore exported and consulted **only** by the relation-scoped surface that can express the distinction: `0075-E` over the five Phase 4 relations, and GOLD-74's derived-truth check.
| `TL-P4-S1-C12` | `P4-AL-05`, `P4-AL-07`, `P4-AL-09`, `P4-AL-47` | **Declared deferred seams.** Three holes P4-S1 cannot close, because closing each one requires a relation only a later slice creates. A promise is not a protection, so each is declared in `scripts/phase4-s1-gate.ts` with a condition **discovered from the migration tree** rather than a slice number, and turns the gate red the moment what made it safe stops being true: `S-P4-01` (`invoices.sale_id` carries no FK — red when a Phase 4 migration creates `sales` without the composite FK to it), `S-P4-02` (the `invoice` accounting source type is unregistered — red when a migration registers it without adding it to the generic reversal guard's list), `S-P4-03` (`invoice_outstanding` subtracts nothing — red when a migration creates any relation of the settlement vocabulary the routine does not read). `tests/guards/phase4-deferred-seam-guard.test.ts` proves each of the three can be made red by planting into a temporary migrations directory. |
| `TL-P4-S1-C13` | GOLD-74 | `business_transaction_id` is an `*_id` column on several accepted relations, bound by no foreign key, and **no `business_transactions` relation exists anywhere in the tree**. It is a repo-wide correlation id, not a polymorphic reference. The lint therefore discovers correlation ids structurally (`*_id`, present on two or more ordinary relations outside the set under test, FK-bound nowhere) instead of carrying `business_transaction_id` as a named exemption; the only named seam in the allowlist is `invoices.sale_id`, which `S-P4-01` already watches. |
| `TL-P4-S1-C14` | `OD-P4-01` ruling, `P4-AL-37` | The ruling settles the **cashier** arm and the **existence** of an audited backfill, not the owner's. `0076` grants the owner **all twelve** Phase 4 keys, on the accepted precedent of `0041` and `0057`, which each granted the owner the phase's complete key set including its sensitive ones: the owner is the delegator of record, and a sensitive key withheld from the owner cannot be delegated by anyone. The manager receives the **six ordinary** keys and the cashier the four of `P4-AL-35`'s tick set that are in the Phase 4 namespace (`sales.view`, `sales.create`, `customers.view`, `payments.collect`). `phase4.permission_backfill_overreach` is asserted **before** the completeness assertions, so an over-grant is named rather than absorbed. |
| `TL-P4-S1-C15` | `P4-AL-35` vs `P4-AL-37` | `P4-AL-35`'s matrix gives the manager a default tick on `sales.discount` and `sales.return`; `P4-AL-37` forbids any sensitive key as a default. The two are irreconcilable and `P4-AL-37` wins, because it is the rule the slice's own assertion enforces and a sensitive default is the harm the other reading only risks. The manager's default set is the six ordinary keys; both sensitive keys are delegation-only, within `beyondGrantAuthority`. Recorded in `packages/domain-core/src/permissions.ts` at the arm itself so no later reader re-derives the matrix. |
| `TL-P4-S1-C16` | T-05 (Phase 3 definer law) | The four Phase 4 read functions are **`SECURITY INVOKER` and owned by the applier**, which reads as a violation of T-05 until its clauses are scoped: c1 (pinned `search_path`), c2 (internal `NOLOGIN` owner) and c7 (not applier-owned) are conditions on **definer** routines, and an invoker routine is judged only by c3–c6. The accepted `purchase_ap_outstanding` is the precedent in both respects, and it is decisive in a second way: it computes from the **document** tables and never from the journal, which is why `invoices` needs no customer dimension on `journal_lines`. All four functions are `STABLE`, pin their path anyway, and hold exactly `daftar_app:EXECUTE, daftar_inventory_internal:EXECUTE` with `PUBLIC` revoked. |
| `TL-P4-S1-C17` | T-05, `GUARD_OWNERS` | A new `daftar_sales_internal` owner for Phase 4's guard routines is **refused in this slice**, although a NOLOGIN role would satisfy the spirit of c2. The definer law's internal set is four principals (`tests/helpers/phase3-surface.ts:52-56`) and a fifth is **new authority**, needing its own bootstrap entry and its own reviewed commit, not a widened list inside a test. `0075` therefore owns its six stock-side guards with `daftar_inventory_internal` and `invoices_walkin_no_ar` with `daftar_accounting_internal`, which is also the correct reading on the merits: the guard that refuses an AR posting for a walk-in sale is the accounting authority's. |
| `TL-P4-S1-C18` | P4-AL-88, the estate | **The scale of the forward-evolution breakage — and the fact that it was measured THREE TIMES before it stopped growing.** `0075` and `0076` turn red, on a from-zero database, **at least 32 assertions across 22 permanent files**, and every single one is the same defect shape: an exact-equality inventory over a set a later phase populates. The count is written as a floor and not a total on purpose. The first full-estate run put it at 27 in 17 files; re-expressing those uncovered 3 more, because a failing assertion masks the ones after it in the same test body; and a third run, after the re-expressions had landed, uncovered 2 more still (the `migration-upgrade` P3-S5 and P3-S6 rows, whose `protectedRows()` equality was hidden behind the applied-migrations equality that failed first). **A single full-estate run does not bound this defect: each one only reveals the first failing assertion per test body, so re-run the whole estate after every round of re-expression until a round finds nothing.** The lock's §17.3 named two couplings and the execution plan's seventh pre-migration action named one more; the true count is an order of magnitude larger, and it was only found by running the FULL `tests/security` and `tests/integration` on a pristine cluster and accounting for every failing file, not by reading the ones that were predicted. Two of the twenty-seven were written by **P4-S0 itself** (`tests/guards/phase4-derived-truth-guard.test.ts`'s `expect(discoverSalesTables(schema())).toEqual([])`, and `tests/security/phase4-route-surface.test.ts`'s `not.toBe(404)`, which passed only while no Phase 4 relation existed for a handler to miss in). **Budget a full-estate run for every slice that creates its phase's first relation, and read the whole failure list.** |

| `TL-P4-S1-C19` | `P4-AL-88`, `R-P4-12` | **A size is not a set, and the difference is a reach-back that passes silently.** The disjointness half of the re-expressed Phase 3 upgrade matrices judges a successor's permission writes by `backfillAuditViolations`, whose first form took role id → **the number of keys** the role holds. A successor that REMOVES one inherited key and ADDS another leaves that number unchanged: nothing read as lost, nothing read as grown, no audit row required, and a permission swapped on a Phase 3 role passed with the clause green. It now takes role id → **the keys**, and judges by set difference, so any key that disappears is named and red whatever arrived in its place — and red even when the swap is audited, because an audited backfill is permission to ADD, never permission to take away. `0076`'s own assertions 5 and 6 already forbid the swap at the migration; the law about a successor may not be weaker than the migration it is written to police. Proved both ways in `tests/guards/phase3-scope-drift.test.ts`, whose swap case asserts first that the swap really is size-preserving. |
| `TL-P4-S1-C20` | `P4-AL-88`, the grant matrix | **`probeStatementsMissingFrom` is REMOVED, not kept with a reservation.** It supplied, on a scratch database, the relations the runtime grant model records but this checkout's migrations had not built — a no-op in any tree carrying `0075`, and its only reason to exist was a split worktree in which one agent held the migration. That situation ended when `0075` entered the tree, and what remains is only the risk: in a tree whose migrations FAILED to build a relation the model records, the fixture creates it and `deviations()` then reports no MISSING entry for it, which is the single failure a two-directional comparison exists to catch, and "all missing" is exactly what a broken deployment looks like (`[[daftar-a-superuser-skips-the-questions-a-deployer-is-asked]]`). Both call sites in `tests/security/phase3-s8-grant-matrix.test.ts` now state the requirement POSITIVELY — this checkout's migrations built every relation the model records — and refuse a tree that does not, rather than repairing it. 28 tests pass with the fixture gone. |

### The Tech Lead's P4-S1 final seal (2026-10-01)

P4-S1 was reviewed at candidate head `9a41089724e585f90fa3d2eee9b08c27254318ae` and **TECHNICALLY ACCEPTED /
AUTHORIZED TO SEAL**. The seal was one commit, documentation and freeze metadata only: `0074`, `0075` and
`0076` were not touched, and no product, API, permission, RLS or performance behaviour changed. Three rulings
came with it, and each is binding on the slices that follow.

| id | ruling |
|---|---|
| `TL-P4-S1-R1` | **INVOICE SOURCE OWNERSHIP MOVED TO THE POSTING SLICE.** `docs/PHASE_4_EXECUTION_PLAN.md` still recorded the `invoice` accounting source type, its source bindings and its deferred completeness validator as P4-S1's. They are **P4-S2's**. An accounting source type must not exist as a dead registry concept without a real writer, its binding, its journal shape, its deferred completeness validator and its red proof, all in the same slice. `0075` is **not** changed to add them; the correction is to the plan, which now assigns them to S2, and the seam stays watched by `S-P4-02` in the meantime. P4-S1 shipped no registry row at all, which is why this ruling costs no migration. |
| `TL-P4-S1-R2` | **A GENERAL PHASE 4 RLS/FORCE DISCOVERY GUARD IS REQUIRED, AND IT IS P4-S2'S FIRST MANDATORY PROTECTION.** It must discover the relation surface from the migration tree or the live catalogue and **never** from a handwritten list, and prove for every discovered relation that `pg_class.relrowsecurity` and `pg_class.relforcerowsecurity` are both true. It must carry three planted red proofs: a relation with RLS disabled, a relation with FORCE disabled, and a newly created Phase 4 relation the discovery omits. It is part of `gate:phase4:s2`, it weakens no Phase 3 guard, and **`0077` may not be created until it is integrated and red-proven**. It is **not** retrofitted into `0075`, and `0075` is not modified. |
| `TL-P4-S1-R3` | **DOCUMENT_KIND NARROWING ACCEPTED.** `invoices.document_kind` stays restricted to `'invoice'`. `0075` is **not** widened and **no fake credit-note row** is created in `invoices`. P4-S5 owns the future widening, which it performs without rewriting an accepted row. The open card is closed by this ruling in the narrow direction. |

**What the seal commit did, and why that was the whole of it (P4-AL-61).** Sealing a slice is the tense
transition this lock designed in advance, so it had a fixed shape: fill `S1_ACCEPTED` in
`scripts/phase4-s1-gate.ts` with the three digests **computed from the files**, append the same
`[name, sha256]` pairs to `PHASE4_S1_PREFIX` in `scripts/phase4-prefix.ts` and record
`PHASE4_SLICE_HEADS['P4-S1']`, move the manifest's `frozenThrough` to `0076` with the three entries appended,
and **delete the fenced candidate-tense block** — the candidate half of `boundaryProblems`, the whole of
`candidateSurfaceProblems` with its `CHECKS` entry, and `sellingRoutes`, which existed only to serve it.
`closureRuleProblems` refuses a tree in which any fence marker survived, so the deletion could not be left
half done. Two things were learned in the doing, and both are recorded because they are about the mechanism
rather than about this slice:

- **A rule that counts a marker must not count its own diagnostic.** `closureRuleProblems` counted every
  occurrence of the string `CANDIDATE-TENSE (P4-AL-61)` in the gate — including the one inside its own error
  message — so in the accepted tense it reported a surviving fence for ever, from text that is the refusal
  itself. It now counts the **fence comment lines**, which is what the rule was always about.
- **The fence law has two tenses and both are now asserted.** `tests/security/phase4-forward-evolution.test.ts`
  asserted only the open tense (the fence is a pair, and unfencing it is red), which has no subject once a
  slice is accepted. It now reads the tense from the tree and carries a red proof on each arm: the open arm
  unfences the block and watches the rule refuse it; the accepted arm **plants** a fence comment in a gate
  that should carry none and watches the same rule refuse that. The dormant arm becomes live the moment the
  next slice opens its own gate. This is the `P4-AL-88` shape applied to the gate's own hygiene: scope the
  claim to the tense it is true of, and assert the other tense separately and positively.

`0000`–`0076` are now immutable: no edit, no rename, no reorder, no deletion, no whitespace or comment edit,
no digest rewrite. Every correction from here is a NEW migration beginning at `0077`, and only under an
explicit Tech Lead directive.

### P4-S2 coordinator corrections to this lock (2026-10-01)

| id | decision | correction |
|---|---|---|
| `TL-P4-S2-K1` | execution plan, S2 row; `P4-AL-28`; `TL-P4-S1-R1` | **`0077` registers `sale.commit` ALONE, not `sale.*`.** The plan's S2 row and `P4-AL-28` name `sale.commit`, `sale.void` and `sale.return` together, but `sale.void` is P4-S6's command and `sale.return` is P4-S5's, and an `inventory_operation_kinds` row is a registration of **authority**: once it exists, `inventory_assertion_consume` will accept an assertion carrying it. That is a live authority with no writer, which is exactly what `TL-P4-S1-R1` refused for the `invoice` source type. The later kinds are registered by the slices that supply their writers. This NARROWS a plan row; it widens nothing. |
| `TL-P4-S2-K2` | execution plan, S2 row; `TL-P4-S1-C2` | **Six policies on the sale bridge, not five.** The plan said five; the accepted `stock_source_bridge_purchase` carries six, read from `0063:555-568`: `tenant_membership`, the four `RESTRICTIVE` per-command isolation policies, and `inventory_internal_read`. `TL-P4-S1-C2` had already corrected the ordinary/accounting-source counts to six and seven; the S2 row was not updated with it. The bridge is not an accounting-source relation, so it takes no `accounting_validator`. |
| `TL-P4-S2-K3` | `P4-AL-29b`; `0067:1548-1564` | **`inventory_stock_source_guard_gaps()` must be REPLACED by `0077`, and the hole it leaves is reachable, not theoretical.** The live body is `0067:1438`, the fifth version (`0059` → `0061` → `0063` → `0065` → `0067`); `P4-AL-29b` cites `0061:307-481`, a superseded body the database does not hold, so a reader reasoning from the citation gets a materially wrong answer. In the live body, for a source type that is none of S3/S4/S5 the line FK's **target table and key are unpinned** — its own comment says "for any other type to some third table (the S2 template)" — and no `prosrc` digest is recorded and none of `source_complete` / `source_freeze` / `header_immutable` / `value_complete` is required. Measured on a from-zero database: a `stock_source_bridge_sale` whose line FK pointed at `invoice_items` instead of `sale_items` was reported as **no gap at all**. So `P4-AL-29b`'s obligations are documentation and not enforcement until the guard carries a `sale` arm, and without the replacement the sale would be the least-protected source in the registry (`[[daftar-every-journal-writer-equally-protected]]`). Replacement is the accepted mechanism and not a frozen-file edit: `0063`, `0065` and `0067` each replaced it. |
| `TL-P4-S2-K4` | `P4-AL-20` | Recorded only, no action: `P4-AL-20` still states the widening as a bare `^P[0-9]+-S[0-9]+$`, while the live `inventory_operation_kinds` CHECK carries `OR registered_by = 'P3-C'`, as `TL-P4-S1-C3` already corrected. Noted so the next reader of `P4-AL-20` is not misled. |

### Tech Lead rulings during P4-S2 (2026-10-01)

| id | ruling |
|---|---|
| `TL-P4-S2-R3` | **REQUIRED-CI CHAIN COMPOSITION.** A BLOCKER first: the required `backend` job ran `gate:phase4:s1` and **not** `gate:phase4:s2`, so every green reported for the slice was green for a workflow that never ran the slice's gate — *a green workflow is not evidence for a gate the workflow never ran.* The step is added, visibly and unconditionally, immediately after the P4-S1 step with the same database environment. With it, the cheaper equivalent of internal composition is **authorized** for the slice gates: `P4-S1 → P4-S2 → later slice gates` run sequentially and visibly inside the SAME required job, so a successor **delta** gate need not re-execute a ~50-minute predecessor internally. The authorization is conditional on a **permanent structural check** proving all seven of — the P4-S1 step exists; the P4-S2 step exists; both are inside the required `backend` job; S1 precedes S2; neither uses `continue-on-error`; neither is conditional in a way that can skip a normal push or pull request; and the S2 command is exactly `npm run gate:phase4:s2` — by **parsing** the workflow rather than grepping it, with a red proof for every way of breaking it. `P4-AL-57` and `P4-AL-58` are amended in place; `gate:phase4:release` is **not** weakened and still composes everything verbatim. |

| `TL-P4-S2-R2` | **A gate that checks test filenames but never executes the tests is not a gate.** `gate:phase4:s2` registered its roster and verified only that the files and the red-proof titles existed; only `rls-force-runtime` executed anything, so a real S2 test could fail while the gate printed PASS. The gate must EXECUTE every suite it claims, preferably in one bounded Vitest invocation, and FAIL on a missing file, a `.skip`/`.todo`/`.only`, a failing test, an empty discovery, a termination by signal or an unreadable tally; it may never catch a test failure and continue with PASS. It must report the claimed suites, the resolved files, the exit status and the tests passed and failed, and carry a red proof that breaking one S2 assertion — roster and proof title intact — turns it red. |
| `TL-P4-S2-R4` | **A sale endpoint that requires manual SQL setup is not a complete product path.** Nothing in `0000`–`0078` created an `invoice_sequences` row, and `0078-E(5)` asserted the routine never writes one, so a newly onboarded business could not number its first invoice. The default internal format is `INV-{YYYY}-{SEQ:06}` — a DAFTAR identifier, **not** a fiscal or tax compliance claim, and `OD-03` stays OPEN. The row is created safely on first use from the document date, and only THEN is that exact row locked before `max(number_seq) + 1`; an existing `number_format` is NEVER overwritten. No counter column and no PostgreSQL sequence. On this tree the literal `{SEQ:06}` is unstorable, because the frozen `invoice_sequences_format_ck` admits no leading zero in the width; the Tech Lead was asked and chose `{SEQ:6}`, which `lpad` renders as the ruling's own `INV-2026-000001` (2026-10-02). |
| `TL-P4-S2-R5` | **An internal invariant failure is not an authorization denial.** `apps/api/src/common/error.filter.ts` rendered every `P0001` as an opaque 403. Known `sale.*`/`invoice.*`/`customer.*` codes are parsed canonically and rendered through `sellingRefusal(...)` with their registered semantics preserved; recognized internal `selling.*` invariants are **500 INTERNAL_ERROR**, logged with the `requestId` and the code and exposing no SQL, no raw PostgreSQL message, no amounts, no journal ids, no assertion body and no stack; an UNKNOWN historical `P0001` keeps the existing fallback until separately audited, so no accepted Phase 1–3 HTTP contract moves. `42501` stays 403. |
| `TL-P4-S2-R1` | The correction of the SEALED `scripts/phase4-s1-gate.ts` is **authorized** as strictly stronger corrective hardening, not weakening: `S-P4-01` grepped the whole Phase 4 DDL and never asked which relation carried the foreign key, and `0077` writes two matching edges, so dropping `invoices_sale_fk` passed silently. It now reads the `invoices` child relation. The planted red proof is retained. That sealed gate is not otherwise modified without a new finding. |
| `TL-P4-S2-R6` | **The history rewrite is REFUSED.** The twelve historical commits are not rewritten and no force-push is performed to correct author or co-author attribution: it would invalidate every descendant SHA and with it the whole chain of CI evidence, acceptance SHAs, audit references, review comments and seal references. Attribution is non-product and non-integrity-critical; if it still matters after Phase 4 it is answered by an append-only provenance note or a verified mailmap. **No history rewrite during active Phase 4. The question is CLOSED and is not reopened.** |

### P4-S2 — ACCEPTED AND FROZEN (2026-10-02)

Accepted candidate `712eafee9c15daadaeff773a69c73cf5e535c01c`; exact-SHA `DAFTAR CI` **36950325428** (push),
six jobs SUCCESS at attempt 1, with step 33 `Phase 4 slice gate — P4-S1` and step 34
`Phase 4 slice gate — P4-S2` both SUCCESS in that order inside the required `backend` job. Migrations
`0077`–`0078` frozen at their accepted digests, **79** frozen in total,
`frozenThrough = 0078_phase4_sale_commit.sql`, `0000`–`0078` immutable, next migration `0079`. The
candidate-tense fence (P4-AL-61) is deleted from `scripts/phase4-s2-gate.ts` and passes to the gate of
whichever slice opens next. Freeze page: `docs/PHASE_4_S2_ACCEPTANCE.md`. **§20 of the same directive starts
P4-S3 with no further permission message; P4-S4 must not begin.**

### Carried forward from P4-S1 (named so it is not lost)

- ~~**No law asserts RLS `ENABLE`/`FORCE` over the DISCOVERED relation surface.**~~ **DISCHARGED IN P4-S2
  (`TL-P4-S1-R2`), AND THIS NOTE'S OWN PRESCRIPTION WAS WRONG ON THIS TREE.** The gap was real: every
  assertion in the estate was over a named table list or was a two-build catalogue comparison, so a later
  relation that forgot to enable or force RLS would have been caught by nothing. `0075-E` asserts both on its
  own five relations from `pg_class`, so P4-S1 itself was covered. The law now exists —
  `scripts/guards/phase4-rls-force.ts`, proved in `tests/guards/phase4-rls-force-guard.test.ts` and run by
  `gate:phase4:s2` — and it is **scoped to Phase 4**, not to `phase3Tables()`.

  **The `phase3Tables()`, unscoped form this note prescribed is RED ON ARRIVAL, and its red is false.**
  Measured from `pg_class` on a database built from `0000`–`0076` (2026-10-01, P4-S2): of the **109**
  relations the accepted inherited prefix creates, **30 carry no `FORCE`** and **29 carry no `ENABLE`** —
  platform, global reference and registry relations with no tenant dimension at all (`currencies`,
  `country_registry`, `plans`, `features`, `limit_definitions`, the four assertion-key/use pairs, the
  operation-kind and movement-kind registries, `units`, `unit_names`, `stock_movement_kinds`,
  `stock_source_types`, `reserved_store_slugs`, `platform_settings`, `tenants`, `support_sessions` and the
  rest). `onboarding_operations` is the single inherited relation that **`ENABLE`s and never `FORCE`s**
  (`0018_onboarding_operations.sql:16`; no `FORCE` for it anywhere in `0000`–`0076`). And `phase3Tables()`
  is defined as "at the head and not at `0052`" (`tests/helpers/phase3-surface.ts:190-196`), so it is not a
  Phase 3 set at all: it has **54** members on this tree, **9** of which carry neither flag — the eight
  `0053`–`0059` registry relations (`units`, `unit_names`, `inventory_assertion_keys`,
  `inventory_assertion_uses`, `inventory_operation_kinds`, `inventory_operation_movement_kinds`,
  `stock_movement_kinds`, `stock_source_types`) plus **`schema_migrations`, the applier's own bookkeeping
  relation**, which that helper does not subtract. A first text-regex estimate of this figure said eight and
  was wrong; the nine is the `pg_class` measurement. A protection that must be born failing is not a protection, and an
  allowlist to make it pass is what §17.3 refuses.

  **The correct scope is exact rather than narrower**, because `P4-AL-08` makes it so: every Phase 4
  relation carries `tenant_id` and `business_id`, so the Phase 4 surface is precisely the set on which
  `ENABLE` + `FORCE` is unconditionally owed. The law therefore partitions its discovered surface
  structurally — both dimensions ⇒ `ENABLE` + `FORCE` owed; exactly one ⇒ a `P4-AL-08` violation reported as
  one, with `ENABLE` + `FORCE` still owed; neither ⇒ a declared Phase 4 global registry, **red until this
  lock records a decision for it** — so a future Phase 4 global registry raises a decision instead of a
  false red or a silent hole. The partition is 5 / 0 / 0 today. The surface is the union of the migration
  tree (`phase4MigrationsOnDisk`, bounded by the derived `PHASE4_FIRST_NUMBER`) and the live `pg_class`,
  minus the applier's own relations **discovered from `apps/api/src/infra/migrate.ts`'s text** rather than
  excluded by name; each half is the other's completeness proof, and a member of one that the other lacks is
  reported, never dropped.
- ~~**`probeStatementsMissingFrom`.**~~ **DISCHARGED IN THIS SLICE** — removed, with both call sites
  restated as positive requirements. See `TL-P4-S1-C20`.

### Still unresolved, carried to the slice that needs it

- **`stock_source_bridge_sale`'s tenant carriage (P4-S2).** `P4-AL-08` requires every Phase 4 relation to
  carry `tenant_id` and `business_id` as real columns; the accepted precedent
  `stock_source_bridge_purchase` (`0063:400-406`) carries **no** `tenant_id` and no
  `(tenant_id, business_id)` FK, which is why its `tenant_membership` policy uses the correlated
  `businesses` subselect (`0063:556-557`). `inventory_stock_source_guard_gaps()` pins the bridge primary key
  "exactly", so the precedent is the safer reading. The two instructions conflict and this lock does not
  resolve it; it is P4-S2's to resolve, with evidence, before the sale bridge is written.
- **`invoice_sequences.period` granularity — SETTLED (`TL-P4-S1-C9`, Tech Lead decision 2026-09-30).**
  `P4-AL-31` fixed the row's purpose but not the period, which is in the first Phase 4 migration's
  **primary key** and therefore had to be settled before `0074` rather than after. **The ruling is
  `YEARLY`:** the ordinal restarts at 1 for each calendar year of the issue date, per business and per
  document kind, so the key is `(business_id, document_kind, period)` with `period` the four-digit year.
  Gaplessness holds **within** a period — the `max+1` under the sequence row's lock is taken over the
  invoices of that key — and the year is part of the rendered document number, so two invoices in different
  years never collide. `number_format` carries the year and a zero-padded ordinal placeholder; its grammar
  is P4-S1's to fix and to assert structurally, since it is a rendering rule rather than an identity, and
  the format column is `NOT NULL` with a CHECK requiring the ordinal placeholder.
- **Branch scope on the invoice list.** `P4-AL-40` assigns branch scope to the policy rather than the
  controller and `P4-AL-43` scenario 9 assigns the bypass test to P4-S1, but this lock never says whether an
  assigned-scope member **sees** another branch's invoices in a list or is refused. Pending a ruling, P4-S1
  implements the **narrower** reading — an assigned-scope member sees only the invoices of a branch in their
  scope — because a visibility rule that turns out to be too tight is a complaint and one that turns out to
  be too loose is a leak. The three money reads require business-wide scope, following the accepted
  `GET /v1/suppliers/:id/payable` precedent.

---

## 26. ملخص بالعربية

> **تحديث (2026-10-01).** ما يلي وصفٌ تاريخيٌّ للشريحة P4-S0 وقت كتابته. وقد قُبِلت P4-S0 وأُقفل المعمار في
> 2026-09-30، ثم سُلِّمت الشريحة P4-S1 وقُبِلت وجُمِّدت في 2026-10-01: الهجرات `0074`–`0076` مجمّدة، فصار
> `0000`–`0076` غير قابلٍ للتغيير، والهجرة التالية هي `0077` (انظر `docs/PHASE_4_S1_ACCEPTANCE.md` والقسم 25).
> وبحكم `TL-P4-S2-R3` صار **تركيب البوّابات في الـCI المطلوب**: بوّابة الشريحة P4-S1 ثم P4-S2 ثم ما يليهما
> خطواتٌ ظاهرةٌ مرتّبةٌ داخل الوظيفة المطلوبة `backend` نفسها، فلا تحتاج البوّابة اللاحقة إلى إعادة تنفيذ
> سابقتها داخليًا. وهذا مشروط بتحقّقٍ بنيويٍّ دائم يقرأ ملف الـworkflow **تحليلًا** لا بحثًا نصيًّا
> (`tests/guards/required-ci-chain-composition.test.ts`). وبوّابة الإصدار `gate:phase4:release` لم تُضعَّف:
> ما تزال تُركّب كل شيء داخليًا.

P4-S0 هي مرحلة تحليل وقرار فقط. لم تُكتب أي شيفرة منتج، ولا endpoint، ولا شاشة POS، ولا migration، و`0074`
غير موجود وقتها، و`0000–0073` لم تُمسّ.

ما أُنتج: هذا المستند، وفيه القرارات المرقّمة `P4-AL-01` إلى `P4-AL-88`، وخطة التنفيذ
`docs/PHASE_4_EXECUTION_PLAN.md` بتسع مراحل فرعية. وقبلهما صُحّحت المستندات الرسمية الثلاثة التي كانت
تقول إن المرحلة الثانية «لم تبدأ» وإن المرحلة الثالثة «مرشّحة» لا مغلقة.

اثنتان وعشرون مخالفة بين المستندات والشيفرة حُسمت لصالح الشيفرة، بلا حلول وسط. وأربع حمايات يفترض أي
منفّذ أنها موروثة تبيّن أنها لا تغطّي المرحلة الرابعة إطلاقًا، وصارت أول عمل في `P4-S1`: الحارس `G-3`
(يمسك `customers.balance_minor` وحده ويترك `invoices.paid_minor` يمرّ)، وحارس مصطلحات التاجر وقاعدة
الضريبة في بوّابة المتصفّح (محصورة في `stock|purchases|suppliers`)، واختبار أمني دائم من المرحلة الثالثة
يؤكّد أن جداول المرحلة الرابعة لن توجد أبدًا، ومنع منح صلاحية حسّاسة لدور بشكل افتراضي — وهو ليس قيدًا في
قاعدة البيانات كما كنّا نظنّ، بل تحقّق يُنفَّذ مرّة واحدة.

مراجعة معمارية مستقلّة قرأت المستندين والشيفرة بنفسها وأعادت عشرين ملاحظة، أُغلقت كلها في هذا المستند قبل
الحكم. خمس منها غيّرت قرارًا، وأخطرها أن حساب الإيراد الذي كان مكتوبًا هنا (`4100`) هو في الواقع حساب
مردودات البيع، والإيراد هو `4000`.

وبقيت ستّة عشر قرارًا مفتوحًا تحتاج قرارك، وأهمّها `OD-P4-04`: عكس تخصيص في منتصف السلسلة يكسر حساب
التحرير بوحدة صغرى واحدة، وهو يوقف `P4-S6` وتقنيًا TD-15 معه. و`OD-03` (ضريبة البيع) باقٍ مفتوحًا كما هو،
ولم يُبحث قانون أي دولة.

### ختم المراجعة التصحيحية (2026-09-30)

ردّ الـTech Lead بحكم **«مرور تصحيحي ضيق»**: المعمارية **غير مرفوضة**، ولا إعادة تصميم للمرحلة الرابعة،
ولا توسيع لـP4-S0. وأُغلقت التصحيحات الثلاثة المطلوبة:

1. **TL-P4-S0-01 (عالٍ — سلامة البيانات).** كان المستند ما يزال يكتب معادلة المصالحة كـ`Σ(qty × avg)` في
   موضعين (`P4-AL-25` ووصف `G-18`). والصيغة الرسمية الوحيدة هي
   **`GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`**، لأن متوسط التكلفة خارج قسمة
   مقرّبة، فضربه مرّة أخرى يُعيد الانحراف ويخلق مصدر حقيقة ثانيًا. أُصلح الموضعان، ولم يبقَ أي تكرار في
   وثائق المرحلة الرابعة.
2. **TL-P4-S0-02 (منخفض / توثيق).** العدد الصحيح: **خمس وثائق — ثلاث قائمة مُصحّحة واثنتان جديدتان**.
3. **TL-P4-S0-03 (منخفض / توثيق).** التصنيف الصحيح: **أربع فئات حماية تُنفّذ عبر ستّ إجراءات إلزاميّة
   قبل أوّل migration**.

وأُغلق **خمسة عشر قرارًا** بأحكام مسجّلة في §22 (`TECH LEAD RULING`)، ولم يبقَ مفتوحًا إلا `OD-03`
(ضريبة البيع: صفر بنيوي فقط، وأي ضريبة غير صفرية مرفوضة حتى وجود Country Pack معتمد على مصادر قانونية
رسمية). وأهمّها `OD-P4-04`: **الخيار B مُعتمد** — مخفّف سالب يُلحق في رأس السلسلة، ولا تُمسّ الـreleases
التاريخيّة أبدًا، والبرهان التلسكوبي يُكتب قبل أي شيفرة، والبديل الوحيد عند فشل البرهان هو LIFO فقط.
وبذلك ارتفع الحاجز عن `P4-S6` وعن TD-15.

وفي 2026-10-02 **قُبِلت الشريحة P4-S2 وجُمِّدت**. أعاد المالك على مرشّحها الأوّل `111554d` حكم «تغييرات
مطلوبة» في مسارٍ تصحيحيٍّ ضيّق لأربعة عيوبٍ حقيقية: بوّابة الشريحة كانت تتحقّق من أسماء ملفّات الاختبار ولا
تُنفّذها — «بوّابةٌ تفحص الأسماء ولا تُشغّل الاختبارات ليست بوّابة» — وCI المطلوب لم يكن يُشغّل تلك البوّابة
أصلاً، ولم يكن في `0000`–`0078` ما يُنشئ صفّ ترقيم الفواتير فكان عملٌ جديد يُرفَض عند أوّل بيعة، وكلّ
`P0001` كان يُصيَّر 403 فيُقرأ انتهاكُ ثابتةٍ داخلية كأنّه منعُ تخويل. أُغلقت الأربعة، و**رفض المالك إعادة
كتابة تاريخ الـ commits** لأنّها تُبطل كلّ سلسلة أدلّة CI وكلّ SHA مقبول — والسؤال مُغلق. والصيغة الافتراضية
للترقيم `INV-{YYYY}-{SEQ:6}` تُخرج `INV-2026-000001`، وهي **معرّفٌ داخليّ لا ادّعاءَ امتثالٍ ضريبيّ**،
و`OD-03` ما زال مفتوحًا. المرشّح المقبول `712eafe` وتشغيل CI رقم 36950325428 ناجح في الوظائف الستّ،
والهجرتان `0077`–`0078` مجمّدتان، ومجموع الهجرات 79، والحدّ المجمّد `0078`، والهجرة التالية `0079`،
و`0000`–`0078` غير قابلٍ للتغيير. وتبدأ الشريحة **P4-S3** بموجب البند §20 بلا إذنٍ إضافي، **ولا تبدأ P4-S4**.

---

## 27. The Tech Lead's P4-S3 final corrective directive (2026-10-03)

P4-S3 was reviewed at candidate head `0d055e5bdc9866d5fac837c94f3431784a1bb6e6`, with exact-SHA CI
`37108856227` (event `push`, attempt 1) green on all six jobs and PR CI `37108859071` green on the same
source SHA. The verdict was **`P4-S3 — CHANGES REQUIRED`**, as a **FINAL NARROW CORRECTIVE PASS**: the
P4-S3 architecture is **not rejected** and POS is **not** redesigned. The till session, the server-side
cart, POS search, the POS reads, the browser surface, the localization, the barcode correction and the
candidate migration `0079` all remain the accepted basis. Five rulings close before `0079` freezes.

| id | ruling |
|---|---|
| `TL-P4-S3-R1` | **POS CHECKOUT MUST BE ATOMIC WITH CART CONSUMPTION.** The shipped UI flow committed a sale and then removed cart rows one at a time, so a committed sale followed by a partial cart-clear failure left stale cart rows after financial and inventory truth had already committed — a stale basket, an accidental second sale, and a partial cleanup that describes no business event. One POS checkout performs, in ONE database transaction: lock the till session; establish same tenant, same business, correct branch, correct warehouse, authenticated session owner and session OPEN; read the exact active cart set; bind its exact identities and quantities; derive price, discount and tax from server truth; execute the **existing accepted sale primitive**; execute the stock, COGS, invoice and accounting effects already owned by P4-S2; consume exactly the cart rows represented by THIS sale; and commit all of it together. If any step fails, **nothing commits**. Never: sale committed with cart not consumed; cart consumed with sale not committed; partial cart consumption; invoice without sale; stock movement without sale; accounting posting without commercial source. `POST /v1/sales` stays the **generic** sale surface and is given no implicit knowledge of any POS basket; the orchestration is a POS-specific route. The route name is not the law; the transaction semantics are. **No second sale writer**: no duplicate `sale_commit`, no alternative financial writer, no POS-only sale implementation, no copied sale arithmetic, no second COGS path, no second invoice writer, no second journal writer. Only the seam may be refactored so the accepted sale logic runs inside a caller-owned transaction. If atomicity proves impossible without modifying frozen `0077`/`0078`, the work **STOPS** and reports the exact reason; the frozen files are not modified. The checkout binds the exact cart state it sells (**the server decides product, variant, quantity, price, discount authority, tax, subtotal, total and currency — never the browser**), and a concurrent cart change either lands deterministically before the bind or produces a stable refusal; it never silently sells one cart and clears another. Replay is safe through the project's caller-supplied identity plus stored intent fingerprint, and **a replay may never issue a blanket delete against the current basket**: the consumed row identity is tied to the original accepted snapshot, so lines added after a successful checkout survive it. Sixteen named permanent tests are required, with deterministic interleaving and **no sleeps**. |
| `TL-P4-S3-R2` | **DISCOUNT GRAIN = PER-LINE.** The open discount-grain card is closed. Phase 4 discount is **per line only** and the existing implementation is accepted; no cart-wide or order-wide discount is introduced in Phase 4. `sale_items` already owns discount at line granularity, per-line discount has one exact source, and a cart-wide discount would require allocation across lines — which creates further HALF_EVEN and residue decisions, a new derived truth and another concurrency surface, for no Phase 4 requirement. A future phase may introduce order-level promotions explicitly. For Phase 4: the discount request belongs to a line; the server revalidates `sales.discount`; zero removes the line discount; the cart total is the sum of the recomputed lines; and there is **no hidden proportional distribution**. |
| `TL-P4-S3-R3` | **CLOSED OWNED CART READ ACCEPTED.** Allowing the authenticated **owner** of a closed till to read its frozen cart evidence is accepted. It is read-only with no mutation, available only to the authenticated session owner under accepted scope, and another user's closed session stays unreadable. An empty cart is a real `200 { lines: [] }` **only after authorization succeeds** — an access refusal must never masquerade as an empty cart. |
| `TL-P4-S3-R4` | **DEPLOYMENT PLAN-EVIDENCE ENVIRONMENT.** The P4-S3 barcode defect exposed a systemic evidence problem: the local embedded test server is PostgreSQL 18 at a commonly `C` collation, while the required CI and deployment target is the PostgreSQL 16 family at a deployment-style `en_US.utf8` collation. **A plan-shape claim made on a different server major or collation is not automatically a claim about deployment**, and this is hardened BEFORE S4 performance work begins. Every plan-shape assertion across Phases 2, 3 and 4 is **discovered from the tree**, never from a remembered list, into a machine-readable inventory. Every authoritative plan-evidence run records `server_version_num`, `datcollate`, `datctype`, the locale provider where relevant, the exact query, the dataset tier and the ANALYZE state; the target spelling is **measured from CI's own PostgreSQL service** and not hard-coded from memory. Local PG18/`C` runs stay valid for correctness, SQL validity, security, RLS answer equivalence, functional invariants and concurrency, but **may not be labelled authoritative deployment plan evidence** without proven parity. The problem may **not** be solved by deleting, lowering or genericising plan assertions, by skipping required CI, or by accepting whichever plan local PostgreSQL happens to choose. Required CI must carry the authoritative side, and a structural test must prove that wiring. The retrospective audit classifies every discovered assertion as SAME/PASS, DIFFERENT BUT EQUIVALENT, PERFORMANCE REGRESSION, INVALID HISTORICAL CLAIM, NEEDS PRODUCT INDEX or NEEDS TEST CORRECTION; frozen historical migrations are never modified, and a missing accepted product index is repaired **only by a new migration**. A High data-integrity, security or accounting finding **STOPS the S3 seal**. |
| `TL-P4-S3-R5` | **PROCESS COMPOSITION GUARD — BIDIRECTIONAL.** `process-composition.test.ts` proved one direction only and could permit a controller belonging to no application composition. The law is now bidirectional: every controller or module declared in the authoritative process composition appears where expected; every production controller is reachable through at least one intended production module or process; no controller exists only as a file; **no test fixture or import statement may satisfy the check**; a planted unattached controller is RED; and a planted wrong-process controller is RED. Module reflection is **not** to be replaced by regex-only source matching. |

### Two statuses corrected, which were carried as open and were already ruled

The P4-S3 report listed two items as open decisions. Both were already decided, and the canonical status is:

- **RLS / FORCE — `TL-P4-S1-R2` is DISCHARGED**, by P4-S2. The general discovery guard is **Phase-4 scoped,
  and that scope is intentional**. A tree-wide RLS law is **not** reopened: it would incorrectly fail
  accepted non-commercial relations. This is not an open item and is not carried as one again.
- **`credit_note` / `document_kind` — RULED / OWNED BY P4-S5**, by `TL-P4-S1-R3`. `0075` stays `'invoice'`
  only and stays frozen; P4-S5 owns the widening; the widening happens in a **new** migration; and no fake
  credit-note row is created in `invoices` before S5. This is not an open decision.

### What remains open

`OD-03` only. Sales tax remains **structurally zero** and a non-zero sales tax remains refused. Tax law is
not researched and VAT rules are not inferred; Country Pack work is not part of this run.

### The boundary this directive sets

The directive authorizes the S3 corrective work, the S3 seal if **every** acceptance condition passes, the
full P4-S4 implementation, exact-SHA S4 CI and an independent S4 review. It does **not** authorize freezing
S4 migrations: `frozenThrough` is not moved to the S4 head and the S4 accepted prefix is not populated. P4-S4
ends at **`P4-S4 — READY FOR TECH LEAD REVIEW`**, and **P4-S5 product work does not begin** — the boundary is
deliberate, because P4-S5's refunds and returns consume the financial truth S4 creates, and that truth is
reviewed before anything is built on it.

### The S3 seal, performed

`P4-S3` is **ACCEPTED AND FROZEN** at the accepted candidate head
`f3bf439dff5d12c4d1f3bd4c682d37feca0d8a4a`, whose exact-SHA push CI `37143557554` returned six jobs SUCCESS
at attempt 1 with the P4-S1 → P4-S2 → P4-S3 chain visibly executed in that order. `0079` froze at
`1dd406985f6800244e0a0d8a14248595330f6995d3e867e483eda6b9affa173f`, recomputed from the accepted file rather
than inherited from the candidate round, because `0079` itself changed in the corrective pass. **80
migrations frozen, `0000`–`0079` immutable, the next migration is `0080`.** The freeze page is
`docs/PHASE_4_S3_ACCEPTANCE.md`.

One defect found during this pass is carried into P4-S4 **as a named item rather than as technical debt**: a
cash-settled invoice to a named customer reports an outstanding receivable the ledger never carried, because
the invoice is written `open` and `invoice_outstanding` keys on status alone while the posting debits cash.
P4-S4 is the slice that owns what "outstanding" means, its fix is a new migration rather than an edit to
anything frozen here, and nothing merges before it lands.

**DISCHARGED in P4-S4 (status note, 2026-10-05).** It landed as the new migration `0080`: a cash-settled
invoice reports derived `paid = total`, `outstanding = 0` and `settlement_state = 'paid'` (`0080:166-171`,
and the routine's own comment at `0080:182`), while `invoices.status` stays lifecycle-only
(`draft`/`open`/`void`) and is **never** written `'paid'`. Nothing frozen was edited. **This is no longer a
carried item and must not be reported as an open decision** (§29).

## 28. P4-S4 execution — the two departures from the implementation map

The P4-S4 implementation map ordered two things the accepted, frozen tree cannot carry. Both are
recorded here as departures rather than silently taken, and each names what enforces the law in the
shape that was built instead.

### Departure A — the edge from a settling row to its invoice is TWO columns, not three

**Ordered** (map §8.4 and §8.5): a three-column `FOREIGN KEY (business_id, invoice_id, customer_id)
REFERENCES invoices (business_id, id, customer_id)` on each reducer, so that a row naming another
customer's invoice is unrepresentable, with no trigger and no application rule behind it.

**Built**: `FOREIGN KEY (business_id, invoice_id) REFERENCES invoices (business_id, id) ON DELETE
RESTRICT`, on `payment_allocations` (`0081:357`) and on `customer_credit_applications`
(`0081:493`).

**Why**: the three-column edge requires `UNIQUE (business_id, id, customer_id)` on `invoices` as its
referenced key. `0075` is frozen and carries no such constraint — its uniques are
`invoices_number_uq`, `invoices_document_number_uq` and `invoices_sale_uq` (`0075:286-288`) — so the
ordered form is unbuildable without editing a frozen migration, which nothing in this slice may do.
Adding the key in a new migration is possible and is NOT taken here: it is a widening of an accepted
relation's key surface, which is a Tech Lead decision and not an implementation choice.

**What carries the law instead**: `customer_id` stays `NOT NULL` on both reducers, so a row cannot
omit a customer; the claim no composite edge makes — that it is the INVOICE's customer — is proved by
`invoice_settlement_verify` as a DEFERRED constraint trigger at COMMIT, which refuses
`invoice_settlement.customer_mismatch` over both reducers in one predicate, and
`invoice_settlement.walkin_not_settleable` for an invoice with no customer at all.
`invoices_walkin_no_ar()` (`0075:661-684`) remains the third, deferred backstop. The gap against the
ordered form is therefore one of GRAIN, not of coverage: the refusal arrives at COMMIT rather than at
INSERT.

**Open item**: whether `invoices` gains `UNIQUE (business_id, id, customer_id)` in a later migration,
which would let a future slice narrow both edges to the ordered three-column form. Until then the
permanent proofs of the pin live at the verifier's grain, and a proof at the row grain would be a
proof about a constraint that does not exist.

### Departure B — a payment method's posting account stays mutable while customer payments reference it

**The gap**: `payment_method_guard()` is a Phase 3 routine whose body digest is pinned by
`supplier_settlement_guard_gaps()` (`0067:1801`, `0068:1331`). Extending it to notice CUSTOMER
payments would change a pinned body, which this slice may not do. So a payment method's
`posting_account_id` can still be changed while `payments` rows reference that method.

**Why it is bounded**: every `payments` row pins its OWN `posting_account_id`, and its journal entry
is posted against the pinned value, so no existing row and no posted entry is ever rewritten by such
a change. The whole of the gap is that a FUTURE payment on the same method could post to a different
account than past ones did, which is a reporting-continuity question and not a correctness one.

**What is required of the slice**: one permanent test DOCUMENTING the current behaviour — it asserts
what the database does today, and it explicitly does not assert that the behaviour is correct, so the
day a later slice closes the gap the test is the thing that goes red and says so.

### OD-03 is untouched

Nothing in P4-S4 researches, infers or encodes a tax rule. Sales tax remains structurally zero, no
relation of this slice carries a tax element, and `OD-03` stays the single open decision it was.

---

## 29. The decision register, and four statuses that must never be reported as open again

**The register is `docs/PHASE_4_DECISION_REGISTER.md`.** It is the single place that states the **STATUS**
of every Phase 4 decision that has ever been carried as open; the **ruling text** stays here, in §22 and
§25–§28. Where the register and a slice report disagree about whether something is open, the register is
canonical, because a slice report is a snapshot of the day it was written and a ruling made afterwards
cannot reach back into it.

### The four

These are **RULED**. Reporting any of them as open, in any document, report, gate message or hand-off, is a
defect:

1. **The cash-settled named-customer invoice semantic.** Derived `paid = total`, `outstanding = 0`,
   `settlement_state = 'paid'`, while `invoices.status` stays **lifecycle-only** (`draft`/`open`/`void`) and
   is **NEVER** written as `'paid'`. Built in `0080` (`0080:166-171`, and the routine's own comment at
   `0080:182`). It was carried into P4-S4 as a named item by §27; **that item is discharged** and is not an
   open decision.
2. **`document_kind` / `credit_note`** — `TL-P4-S1-R3` (`:2010`, restated `:2232-2234`). Built by a **NEW**
   migration in P4-S5; frozen `0075` is never edited; no fake credit-note row.
3. **The general Phase-4 RLS `ENABLE`/`FORCE` discovery law** — `TL-P4-S1-R2` (`:2009`), **discharged in
   P4-S2**. Phase-4 scoped by intent, and not widened into a tree-wide law.
4. **The twelve-commit history rewrite** — `TL-P4-S2-R6` (`:2058`). **REFUSED AND CLOSED.** It is never
   reopened and never proposed again.

Also ruled, and not open: **discount grain is per line** (`TL-P4-S3-R2`); **there is no customer credit
limit in Phase 4** and **no arbitrary price override** (`OD-P4-02` / `OD-P4-03` A — measured: zero
occurrences of `credit_limit` in the migration tree); **one till = one authenticated cashier** (`0079:405`,
`0079:427`); **`OD-P4-04` is Option B with LIFO-only as the sole fallback** (`:1962`).

### What remains open

`OD-03` only, as the single genuinely open decision. Beside it the register carries **two contradictions
awaiting the Tech Lead, which are not open *decisions* but recorded conflicts**: `SETTLEMENT_VOCABULARY`
(`scripts/phase4-s1-gate.ts:1140-1146`) counting `refunds` as settling an invoice against `P4-AL-34`
(`:736`), and whether `invoices` gains `UNIQUE (business_id, id, customer_id)` (Departure A, `§28`). Neither
was resolved unilaterally, and no gate script was touched.
