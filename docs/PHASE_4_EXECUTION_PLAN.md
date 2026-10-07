# DAFTAR — Phase 4 Execution Plan / خطة تنفيذ المرحلة الرابعة

**Phase 4 — Sales, POS, Customers, Debts, Receivables & Installments.**
Companion to `docs/PHASE_4_ARCHITECTURE_LOCK.md`, which holds the decisions. This document holds the order of
work, the ownership, the gates and the exit criteria. Where the two could disagree, the lock wins and this
document is corrected.

Produced in **P4-S0**. P4-S0 created no product code, no endpoint, no POS screen and no migration, and `0074`
does not exist.

---

## 1. Baseline and branch

| item | value |
|---|---|
| `main` | `6fc505d33b7a6f7a49fa04ee3bc60bb1ddf3b595` |
| CI evidence on it | `DAFTAR CI` **36637141476**, SUCCESS, six jobs (workspaces, backend, web-admin, android, hygiene, browser) |
| migrations | 74, `frozenThrough = 0073_default_warehouse_locale_name.sql`, no `0074` |
| Phase 3 | merged, closed and verified on `main` |
| Phase 4 branch | `phase/4-sales-pos-customers-receivables`, created from that exact SHA |
| Phase 4 PR | **#6**, **draft**, into `main` |

Every Phase 4 change goes through PR #6. There is no direct push to `main` and no work on `main`. `main`
remains unprotected (TD-08, external), so that discipline is the compensating control and it is not optional.

---

## 2. Working method

**`MAX_ACTIVE_AGENTS = 6`, including the coordinator.** One coordinator and at most five specialists active at
any moment. The coordinator does not write architecture from an agent's summary: it reads the diffs.

- Parallelism only where ownership is disjoint. Each agent works in its own git worktree; the coordinator alone
  merges results.
- **One agent owns migrations for the whole phase**, allocating serially from `0074` (lock P4-AL-83). Every
  other agent describes the DDL it needs.
- High-risk areas are serialized, not parallelized: the sale commit primitive, the reversal paths, and anything
  touching `inventory_apply_stock_movements` or `accounting_post_entry`.
- A **file-ownership matrix** is agreed before a slice starts (§4). Two agents never hold the same file.
- The coordinator reviews every diff before it is committed, and runs the slice's own gate plus exact-SHA CI
  before reporting.
- Each slice ends with a report in Arabic and a **STOP** at the slice boundary. The next slice starts only on an
  explicit Tech Lead directive.
- One background agent may prepare the next slice as analysis only: no branch, no commit, no file outside its
  report.

---

## 3. Slice sequence

Nine slices. A boundary exists where a new invariant becomes assertable, which is why the gate estate maps
one-to-one onto it (lock P4-AL-81). An agent may refine a boundary for a real technical reason; merging slices
for speed is refused.

### P4-S0 — Architecture Lock *(this slice)*
**Scope.** Analysis, audit, decisions, and correction of the stale canonical status sources.
**Migrations.** None. **Product code.** None.
**Outputs.** Two new documents — `docs/PHASE_4_ARCHITECTURE_LOCK.md` and this plan — plus the three
corrected existing canonical documents (`PROJECT_STATUS.md`, `TECHNICAL_DEBT.md`,
`docs/DAFTAR_IMPLEMENTATION_ROADMAP.md`): five documents, three existing and two new.
**Exit.** Both documents written, every High/Medium review finding closed, documentation and static checks green,
CI green on the branch head, verdict reported. **STOP.**

### P4-S1 — Customers, sales documents, numbering, and the guards Phase 4 must build
**Scope.** `customers`, `customer_contacts`, `invoices`, `invoice_items`, `invoice_sequences`; per-business
document numbering; the customer and invoice read surface; and the protection Phase 4 cannot inherit.

**Four protection classes implemented through seven mandatory pre-migration actions** (`TL-P4-S0-03`, count
corrected from six to seven in P4-S1 by `TL-P4-S1-C7`). The classes are the kinds of protection at stake; the
seven numbered actions below are the work items that implement them, and every one of the seven lands before
any Phase 4 table exists:

- **Class I — schema-registration reach.** The accepted registries must accept a Phase 4 registrant at all
  (action 1).
- **Class II — derived-truth guard.** No authoritative stored balance, paid total or outstanding total on any
  Phase 4 relation (action 2).
- **Class III — merchant language and the OD-03 tax boundary.** Both must reach the Phase 4 namespaces and
  screens (action 3), and the accepted absence assertions that claim the Phase 4 surface will never exist must
  be re-expressed as claims about the Phase 3 prefix rather than about the future (actions 4 and 7).
- **Class IV — permission-default authority.** Nothing in the database or the accepted tests may let a Phase 4
  migration grant a sensitive key by default (actions 5 and 6).

**The seven actions, first, before any Phase 4 table exists.**
1. The `registered_by` pattern widened from `^P3-S[0-9]+$` to `^P[0-9]+-S[0-9]+$` on all four constraints
   (`0054:54`, `0059:53`, `0059:59`, `0059:69`) — without it the first Phase 4 registration fails.
2. Guard **G-3 extended** with a sales arm (lock P4-AL-06). Today its own exported discovery functions, run over
   scratch Phase 4 DDL, flag only `customers.balance_minor`: `invoices.paid_minor`,
   `invoices.outstanding_minor`, `customers.amount_due_minor`, `installments.outstanding_minor` and
   `installments.settled_minor` all pass CI. The extension has its own planted-defect red proof.
3. The **merchant-jargon guard and the browser gate's tax rule extended to the Phase 4 namespaces** (lock
   P4-AL-52). `isS7WebFile` is scoped to `(stock|purchases|suppliers)`, so a `pos/` or `customers/` file is
   never examined, and the browser gate's `tax-control` rule — which is the OD-03 boundary check — only fires on
   the screens the gate walks.
4. `tests/security/settlement-s6-no-customer-payments.test.ts` **re-expressed as a claim about the Phase 3
   prefix** (lock P4-AL-88). It asserts against the live catalogue that `payments`, `refunds`, `credit_notes`,
   `customer_credits` and friends do not exist, and that **no relation matches `(customer|sale|invoice)`**
   (`:41-65`). It is a permanent Phase 3 suite composed by `gate:phase3:corrective`, so the first Phase 4
   migration turns an accepted Phase 3 gate red. It is neither deleted nor allowlisted: it is re-expressed
   structurally against the Phase 3 prefix's own files, which keeps it exactly as strong and stops it being a
   claim about the future. **This must land before the first Phase 4 migration.**
5. The **Phase 4 `role_permissions` assertion** (lock P4-AL-37). `0041:57-65` and `0057:140-151` are one-shot
   migration-time `DO`-block assertions over hard-coded Phase 2 and Phase 3 key arrays — not constraints — so
   nothing in the database stops a migration granting `sales.void` or `refunds.approve` to the cashier by
   default. The first Phase 4 permission migration asserts it for the twelve Phase 4 keys, with a red proof
   that plants `cashier -> sales.void`.
6. The three accepted **exact-equality** role tests re-expressed per phase: `domain-core.test.ts:468,474` and
   `inventory-permissions-provisioning.test.ts:142` assert the cashier's and manager's built-in sets with
   `toEqual`, so any Phase 4 default key turns them red. Re-expressed the way Phase 3 did for its own keys,
   never loosened.
7. **The registry-set helpers re-expressed per phase** (`TL-P4-S1-C7`, found in P4-S1 and the largest of the
   forward-evolution breakages). `assertMigrationState()` (`tests/helpers/stock-ledger.ts:661-702`) and
   `assertS4MigrationState()` (`tests/helpers/purchase-deficits.ts:243-282`) assert the **complete** contents
   of `stock_source_types`, `inventory_operation_movement_kinds` and `inventory_operation_kinds` with a single
   `expect(...).toEqual(...)` over hard-coded `S1_/S3_/S4_/S5_/S6_/P3C_` arrays. `assertMigrationState()` is
   called from 13+ sites across four **permanent Phase 3** files (`stock-ledger-concurrency.test.ts:67`,
   `stock-ledger-same-owner.test.ts:77,483`, `stock-ledger-authority.test.ts:74,1115`,
   `stock-ledger-structure.test.ts:267,269,549,569,578,588,1013`, `stock-ledger.ts:1034`);
   `assertS4MigrationState()` from `purchase-deficits.ts:363`. **Registering one Phase 4 operation kind or
   stock source type turns all of them red.** Re-expressed per phase, exactly as the three role `toEqual`
   sets are, and never loosened: each must still fail on a row the phase does not own and on a missing
   expected row. Two consequences: the first Phase 4 migration carries **no registry row at all**, and the
   widened `registered_by` CHECK is unaffected because these helpers read rows rather than constraint text
   (`0072`'s own `pg_get_constraintdef` pin lives inside `0072`'s one-shot `DO` block).
**Also.** `tests/security/phase4-forward-evolution.test.ts`; `scripts/phase4-prefix.ts`;
`flows.ts` exporting `PHASE3_STEPS`/`PHASE4_STEPS` and `gate:phase3:corrective` pinned to the Phase 3 steps
(lock P4-AL-63); the cashier default-permission backfill as ruled under `OD-P4-01` (OPTION A: non-sensitive defaults only,
audited backfill); the `VIEW_REGISTRY`
entries for the Phase 4 views.
**Migrations.** `0074` onward, by the single migration owner.
**Gate.** `gate:phase4:s1` — composes `gate:phase3:corrective` and the permanent core; migration boundary,
two-tense; forward evolution; the extended guards with their red proofs; composite-FK presence and validity;
the enumerated cross-tenant suite over every Phase 4 route; the schema lint (G-19); numbering isolation (G-07,
structural half).
**Exit.** Goldens G-02 (enumeration), G-03, G-07 (structure), G-19 green with named red proofs; gate green;
exact-SHA CI green on six jobs; no authoritative balance column anywhere; the `OD-P4-01` ruling implemented.
**Blocked by.** Nothing. `OD-P4-01` is RULED (OPTION A) and `OD-P4-15` is RULED (OPTION A), so the slice knows
which `GOLD` ids it carries and which default keys the cashier gets.

### P4-S2 — The sale commit primitive — ACCEPTED AND FROZEN (2026-10-02)
**Status.** Accepted and frozen at candidate `712eafee9c15daadaeff773a69c73cf5e535c01c`, exact-SHA
`DAFTAR CI` 36950325428 (push), six jobs SUCCESS at attempt 1 with P4-S1 then P4-S2 both passing visibly in
the required `backend` job. Migrations `0077`–`0078` frozen, 79 in total,
`frozenThrough = 0078_phase4_sale_commit.sql`. The acceptance followed the Tech Lead's narrow corrective
pass (`TL-P4-S2-R1` … `TL-P4-S2-R6`); the freeze page is `docs/PHASE_4_S2_ACCEPTANCE.md`.
**Scope.** `sales`, `sale_items`; the `sale.*` operation kinds on the existing `invctl/1` assertion; the stock
movement path through `inventory_apply_stock_movements` unchanged; the COGS journal entry from the stored
integer deltas; the revenue/AR/tax entry; the whole of the atomic sale law.
**Before it writes a movement**, P4-S2 establishes whether any Phase 3 `R-INV-*` check was written assuming
purchase-only movement sources (risk R-P4-09 in the lock).
**Gate.** `gate:phase4:s2` — a **delta** gate composed with s1 through the required CI chain
(`TL-P4-S2-R3`), wired as the visible `Phase 4 slice gate — P4-S2` step immediately after the P4-S1 step of
the `backend` job; one transaction asserted, not assumed; the two source types with both bindings and their
deferred completeness validators; the last-item race under forced interleaving; idempotency by document
UUID + `intent_sha256`; failure injection proving no partial state.
**Exit.** G-01, G-16 (sale key), G-18's sale-side half green; the `R-INV-*` question answered in writing;
calibration run for P4-C recorded; gate and exact-SHA CI green.
**Blocked by.** Nothing. `OD-P4-05` is RULED (OPTION A — no oversell, atomic refusal, the stock writer
unchanged) and `OD-P4-13` is RULED (A + C — `min(1000 ms, calibrated)`, tighten-only).

### P4-S3 — POS, web
**Scope.** The server-side till basket (`pos_till_sessions`, `pos_cart_lines` — named so
`FUTURE_SLICE_SURFACES` can refuse Phase 6's public checkout cart by prefix), POS search and reads, the POS
screens in ar/en/tr at three viewports. The client sends identities, quantities and a discount request, and nothing else is believed.
**Gate.** `gate:phase4:s3` — composes s2; the trust boundary asserted by sending forged totals and requiring
refusal; the cart's statement count constant in the line count; the POS browser steps' red proof planted in all
nine combinations; POS type-ahead paced, never the limiter raised.
**Exit.** The POS steps green in all nine combinations with the four new invariant kinds each proven able to
fire; P4-A and P4-B budgets measured; gate and CI green.
**Blocked by.** Nothing. `OD-P4-02` is RULED (OPTION A — discount only) and `OD-P4-09` is RULED (OPTION A —
one session, one authenticated user).

### P4-S4 — Payments, allocation, receivables, overpayment → customer credit
**Scope.** `payments`, `payment_allocations`, `customer_credits`,
`customer_credit_applications` — **`payment_methods` already exists** (`0067:284`) and is reused, not
created, with the same `(business_id, payment_method_id, posting_account_id)` three-column FK
`supplier_payments` uses (`0067:352-354`); one journal entry per allocation; the carrying-release chain and its verifier;
level-uniqueness; the surplus becoming a credit and never revenue.
**Gate.** `gate:phase4:s4` — composes s3; the release chain verified; level-uniqueness asserted against direct
SQL; `paid + outstanding = total` after every step; the credit's two halves proportional on partial consumption
and exactly zero on full.
**Exit.** G-04, G-14, G-15, G-16 (payment and allocation keys) green; P4-D and P4-F measured; gate and CI green.
**Blocked by.** Nothing. `OD-P4-03` is RULED (OPTION A — no credit limit) and `OD-P4-14` is RULED (OPTION A —
calibration-derived, tighten-only, `3×` provisional).

### P4-S5 — Returns, credit notes, refunds
**Scope.** `credit_notes`, `credit_note_items`, `credit_note_applications`, `refunds`; revenue reversed
exactly once; the cap check inside the source's `FOR UPDATE`; `refunds` with exactly one non-null source and
no column that could name a payment.

> **Corrected 2026-10-07.** This line named three relations and omitted
> `credit_note_applications`, which is load-bearing rather than incidental: §13 of
> `docs/PHASE_4_DECISION_REGISTER.md` already records it as owed and absent, and
> `INVOICE_REDUCER_VOCABULARY` (`scripts/phase4-s1-gate.ts:1237-1238`) already names it a reducer, so the
> law that a refund is not an invoice-outstanding reducer is standing over a relation this scope did not
> ask anyone to build. Without it an S5 reduces AR by writing `credit_notes` directly — no per-invoice
> application row and no level chain — which is a second AR truth reached by omission rather than by
> decision. The relation count is four.
**Gate.** `gate:phase4:s5` — composes s4; the structural absence of a payment column asserted; the cap under
concurrency; cross-currency caps in the source's own currency.
**Exit.** G-06, G-08, G-09, G-12 green; P4-G calibrated; gate and CI green.
**Blocked by.** Nothing. `OD-P4-13` is RULED (A + C) and governs its acceptance.

### P4-S6 — Reversals, void, and TD-15
**Scope.** `payment_reversals`, `allocation_reversals`; the `void_invoice` compound command and the refusal of
the direct path; and **TD-15's supplier twin closed in the same transaction shape**, with AP preserved exactly.
**Gate.** `gate:phase4:s6` — composes s5; reversal and refund proven to be two operations by the merged-path
red proof; a second reversal refused; the multi-currency reversal using the original snapshots; no stale
allocation after a payment reversal; `provider_reference` idempotency at the database.
**Exit.** G-05, G-10, G-11 green; TD-15 closed with its `TECHNICAL_DEBT.md` reference corrected; gate and CI
green.
**Blocked by.** Nothing. `OD-P4-04` is RULED: **OPTION B AUTHORIZED** — an append-only negative release /
reducer at the current chain head, history never rewritten. The telescoping identity
`rel(X, a) = R(X + a) − R(X)` and `rel(S, −a) = R(S − a) − R(S)` must be proved **before** any reversal product
code is written, with the ten required test cases; if the proof fails, the only permitted fallback is
OPTION A / LIFO-only.

### P4-S7 — Debts, statements, installments, and the narrow TD-22 repayment
**Scope.** `installment_plans`, `installments`; the statement, the debts and aging reads; the schedule as a
view over an existing receivable with no second ledger; and TD-22 repaid by correcting the design-system
document to the shipped tokens and removing the unloaded Inter reference.
**Gate.** `gate:phase4:s7` — composes s6; `Σ instalments + down = total` enforced by the database; every
status derived from a **supplied** as-of date with no reference to the machine's clock; the statement's keyset
paging with no `OFFSET`.
**Exit.** G-13 green; P4-E and P4-H measured; TD-22 closed; gate and CI green.

### P4-S8 — Hardening, reconciliation, concurrency, performance, document corrections
**Scope.** `R-SAL-01…07` added to the existing reconciliation pass; the declared lock order statically checked
and the deadlock matrix run in both directions; the eight budgets at both tiers; the golden suite asserted
**complete**; and the corrections to `docs/DAFTAR_RELEASE_GATES.md`, `docs/DAFTAR_TEST_STRATEGY.md` and
`docs/DAFTAR_GOLDEN_REGRESSION_SUITE.md` (lock P4-AL-80, `OD-P4-15`).
**Gate.** `gate:phase4:s8` — composes s7; the full browser matrix, every step, plus the planted-defect red
proof; Tier-1 budgets alone on their own `PG_DIR` after the functional suites; the budget ratchet; the complete
idempotency key inventory; `perf:phase2:s8` narrowed to the Phase 2 files.
**Exit.** G-17, G-18, G-20 green; every reconciliation check green with a planted-discrepancy red proof;
zero deadlocks over the full pair matrix; every budget met with `planningStatistics` non-null and the RLS cost
recorded; the three documents corrected.

### P4-S9 — Release closure
**Scope.** Evidence only. No migration, no product code.
`gate:phase4:release` from an extracted archive on a fresh cluster; the Phase 4 range secret scan with a
`PHASE4_BASE` verified against `git merge-base`; `DAFTAR_PHASE_4_RC.zip` with a sibling `.sha256`; a `push` run
of `DAFTAR CI` at the seal commit's own SHA and a release-evidence run at the same SHA.
**Exit.** All of the above green at one SHA, and the evidence uploaded. Then **STOP** and wait for the Tech
Lead's closure directive. A green gate grants no authority to merge.

---

## 4. File-ownership matrix

Agreed per slice before work starts. Two agents never hold the same file. The shapes below are the rule; the
per-slice matrix instantiates them.

| area | owner | notes |
|---|---|---|
| `infrastructure/database/migrations/*` and `MIGRATION_MANIFEST.json` | **the single migration owner**, for the whole phase | others describe the DDL they need; nobody else touches the directory |
| `scripts/phase4-prefix.ts`, `scripts/phase4-*-gate.ts`, `scripts/phase4-budget-ratchet.ts` | the gate owner | one owner per slice gate; the prefix module has one owner for the phase |
| `scripts/guards/*` | the guard owner | G-3's sales arm and the jargon guard's namespaces are one change by one agent |
| `packages/domain-core/src/permissions.ts` | the authority owner | the registry is closed and adding to it is one change |
| `packages/domain-core/test/domain-core.test.ts`, `tests/integration/inventory-permissions-provisioning.test.ts` | the authority owner | three accepted `toEqual` assertions on the built-in role sets; a Phase 4 default key turns them red, and they are re-expressed per phase, never loosened |
| `tests/security/settlement-s6-no-customer-payments.test.ts` | the authority owner, in P4-S1 | a **Phase 3** security suite composed into `gate:phase4:s1`; the first Phase 4 migration, source type, operation code and route each break it (lock P4-AL-88) |
| `packages/accounting/*` | the accounting owner | serialized; never edited in parallel with a migration that changes a journal shape |
| `apps/api/src/**` per bounded context | one agent per context | the composite seams in `infra/database.ts` are the accounting owner's |
| `apps/web/src/app/[locale]/(pos|customers|invoices|payments|refunds|installments|debts)/**` | one agent per screen group | shared components are the design owner's |
| `tests/browser/flows.ts`, `config.ts`, `invariants.ts` | the browser owner | asserted against by a Phase 3 gate; a second editor here is how C-9 and C-10 happen again |
| `tests/helpers/test-app.ts` (`resetData()`) | the harness owner | every new Phase 4 table must appear, derived from the migrations |
| `tests/golden-regression/phase4/*` | the golden owner per slice | canonical `GOLD-nn` ids only |
| `tests/performance/phase4-*`, `phase4-dataset.ts` | the performance owner | one owner for the phase, so the dataset stays one dataset |
| `docs/*` | the coordinator, except the three corrections owned by P4-S8 | the lock and this plan are the coordinator's alone |

---

## 5. Gate estate

`gate:phase4:s1` … `gate:phase4:s8`, then `gate:phase4:release` closing at P4-S9. Each composes its
predecessor; `gate:phase4:s1` composes `gate:phase3:corrective` and through it the whole accepted chain, plus
`check:migrations`, `check:guards`, `check:localization`, `check:deployment-authority` and the prefix modules.

**`TL-P4-S2-R3` — REQUIRED-CI CHAIN COMPOSITION.** From `gate:phase4:s2` onward a slice gate may discharge
that composition **through the required job instead of internally**: `P4-S1 → P4-S2 → later slice gates` run
sequentially and visibly as steps of the one required `backend` job, so a successor is a **delta** gate and
does not re-execute its ~50-minute predecessor inside itself. The chain is the composition, so its shape is
load-bearing and is asserted by `tests/guards/required-ci-chain-composition.test.ts`, which **parses**
`.github/workflows/ci.yml` (lock `P4-AL-57`, `P4-AL-58`). `gate:phase4:release` is **not** covered: it still
composes `gate:phase3:release` and `gate:phase4:s8` verbatim and internally, because it must run as one
command from an extracted archive with no workflow around it.

Every gate, without exception:

- runs the **runner canary first** and refuses the matrix if the runner cannot report failure;
- runs structural checks before any suite;
- carries explicit `SUITES` / `COMMANDS` / `RED_PROOFS` / `BUDGETS` tables in which a `{ pending }` row is a
  **FAIL**, never a skip; a listed suite that is missing or carries `.skip`/`.only`/`.todo` fails; and a `p4-*`
  suite on disk that no entry lists fails;
- supports `--list`, `--root` and `--structural-only`, so it can print its plan and be pointed at a copy for
  its own red proofs;
- writes machine-readable evidence on `--evidence=<file>`;
- fails before running anything if any `RELEASE_GATE_SKIP_*` is set (the release gate).

**CI wiring.** No new job and no renamed job: job names are the required-checks keys and that configuration
lives in repository settings, outside the tree. Phase 4's work goes into steps of `backend` and `browser`,
**one visible step per Phase 4 slice gate, in slice order**, so a reviewer sees **which** predecessor failed
— and, under `TL-P4-S2-R3`, so that the ordered steps of the required `backend` job *are* the composition.
Each slice-gate step therefore runs unconditionally: no `continue-on-error`, no `if:`, no
`workflow_dispatch`-only path, and the exact npm script as its command. A slice gate that is written and not
wired is the blocker that ruling was issued over, so **wiring the step is part of completing the slice**. The
only new workflows are the dispatched `phase4-s8-evidence.yml` and `phase4-s9-release.yml`, which are not
among the six repository CI jobs. Whether any job is configured as a required check is **not verifiable from
this tooling** (TD-08 — OPEN / EXTERNAL / UNVERIFIED), so nothing here asserts that it is.

**The three Phase 3 couplings, resolved in P4-S1 before the first Phase 4 table or browser step exists.**
A permanent Phase 3 suite asserts against the live catalogue that no relation matching `(customer|sale|invoice)`
exists, so the first Phase 4 migration turns an accepted Phase 3 gate red; it is re-expressed as a claim about
the Phase 3 prefix rather than deleted or allowlisted (lock P4-AL-88).
**The two Phase 3 couplings, resolved in P4-S1 before the first Phase 4 browser step exists.**
`gate:phase3:corrective` runs the browser matrix with no `--steps`, so it would run Phase 4's steps and go red
over a Phase 4 screen; and it asserts **equality** between its matrix and `tests/browser/config.ts`, so adding a
locale or viewport would turn an accepted Phase 3 gate red. Resolved by exporting per-phase step lists and
pinning the Phase 3 gate to its own fifteen, and by Phase 4 keeping exactly three locales and three viewports.

---

## 6. Migration plan — planning only

No migration is created in P4-S0 and `0074` does not exist. The plan below is the allocation order; the single
migration owner writes them.

| slice | migration content (planned) |
|---|---|
| S1 | **DELIVERED AND FROZEN** as `0074`–`0076`. The four `registered_by` pattern widenings; `customers`, `customer_contacts`; `invoices`, `invoice_items`, `invoice_sequences` with their composite candidate keys and FKs; RLS enable + force + **six** policies on an ordinary relation and **seven** on `invoices` (`TL-P4-S1-C2`); the Phase 4 permission defaults backfill. The `invoice` ACCOUNTING SOURCE TYPE, its operation kinds, its source bindings and its deferred completeness validator are **NOT S1's** — Tech Lead ruling `TL-P4-S1-R1` moved them to **S2**, the slice that supplies the real writer and the journal shape, because an accounting source type may not exist as a dead registry concept. S1 added **no registry row at all** (`TL-P4-S1-C7`, `TL-P4-S1-C8`), and the seam is watched meanwhile by `S-P4-02`. |
| S2 | `sales`, `sale_items` (with `UNIQUE (business_id, sale_id, id)` for the bridge's line FK); the `sale.commit` operation kind **alone** (`TL-P4-S2-K1`: `sale.void` is P4-S6's command and `sale.return` is P4-S5's, and an `inventory_operation_kinds` row is a registration of AUTHORITY, so registering them here would create live authority with no writer — the same reasoning `TL-P4-S1-R1` applied to the `invoice` source type); **the `invoice` accounting source type with its operation kinds, both bindings and its deferred completeness validator, moved here by `TL-P4-S1-R1`**; the `sale` accounting source type with both bindings and its validator; **the `stock_source_types` row and the whole `stock_source_bridge_sale` apparatus** — bridge table, generated constant, binding FK, line FK, RLS enable+force plus **six** policies (`TL-P4-S1-C2`; the accepted `stock_source_bridge_purchase` carries `tenant_membership`, four RESTRICTIVE per-command isolation policies and `inventory_internal_read` at `0063:555-568`, not five — the bridge is not an accounting-source relation, so no `accounting_validator`), append-only trigger, deferred binding trigger, recorded `prosrc` digests, and the migration's own assertion that `inventory_stock_source_guard_gaps()` returns no row (P4-AL-29b); the sale commit routine; `sales_walkin_no_ar` |
| S3 | `pos_till_sessions` and `pos_cart_lines`; no accounting object |
| S4 | `payments`, `payment_allocations`, `customer_credits`, `customer_credit_applications` (**not** `payment_methods`, which `0067:284` already created); the level-uniqueness constraints **and** the deferred chain verifier; the carrying-release routine; the `payment_allocation` source type |
| S5 | `credit_notes`, `credit_note_items`, `refunds` with the one-non-null-source `CHECK`; the `credit_note` and `refund` source types |
| S6 | `payment_reversals`, `allocation_reversals`; the `allocation_reversal` source type; the void-path refusal trigger; the shape `OD-P4-04` decides |
| S7 | `installment_plans`, `installments` with the sum constraint |
| S8 | possibly none; any index a measured budget proves necessary, with its plan assertion |
| S9 | **none** |

`0000–0073` stay immutable byte for byte. `frozenThrough` is a floor and never retreats. No permanent gate
contains a sentence of the form "nothing after N".

---

## 7. Golden tests, browser coverage and budgets

Twenty goldens **G-01…G-20** in `tests/golden-regression/phase4/*`, carrying the canonical `GOLD-nn` ids, each
with a named and resolved RED proof, owned by the slice that owns the invariant and asserted complete by
`gate:phase4:s8`. The full table, with what each proves and how it can fail, is §17.4 of the lock.

Sixteen new browser steps × ar, en, tr × 360, 768, 1280 — 144 step-runs per gate run on top of the existing
135 — plus four new invariant kinds each with its own planted defect. Locales and viewports unchanged.

Eight budgets plus a reconciliation total, five anchored to an accepted budget and two calibration-locked with a
product cap, every one carrying a host-independent ratio assertion and narrow plan assertions, measured against
`D-SALES` at two tiers with the **same** ceilings, as `daftar_app`, with every relation `ANALYZE`d. The table and
the derivations are §17.6 of the lock.

---

## 8. Exit criteria for the phase

Phase 4 is complete when **all** of the following hold at one commit:

1. `gate:phase4:release` PASS from an extracted archive on a fresh cluster.
2. A `push` run of `DAFTAR CI` green on **all six** jobs at that exact SHA, plus a release-evidence run at the
   same SHA. A run on a different SHA is not evidence for this one.
3. All twenty goldens green, every one with a resolved red proof, and the suite asserted complete.
4. `R-SAL-01…07` and `R-INV-01…05` green, each with a planted-discrepancy red proof.
5. Every budget met at both tiers with `planningStatistics` non-null, every sample recorded, the RLS cost
   recorded per budget, and the ratchet refusing every increase.
6. Zero deadlocks over the full pair matrix in both orders.
7. The browser matrix green in all nine combinations over every step, with every plant proven able to fire.
8. TD-15 closed. TD-22 closed. TD-08 still open and external, with the compensating policy honoured throughout.
9. No authoritative balance column anywhere, proved by the extended G-3.
10. Sales tax structurally zero, refused at three layers, OD-03 still open.
11. No accumulated defects at any slice boundary: no security, accounting or data-integrity bug was moved to
    technical debt to close a slice.

**And then STOP.** A green gate grants no authority. Merging PR #6 and starting Phase 5 each require an explicit
Tech Lead directive.

---

## 9. Independent review

An independent reviewer read the Architecture Lock and this plan against the current tree, reading the code
itself rather than the coordinator's summary, and hunting the nineteen named failure classes. It returned
twenty findings and eleven contradictions. **All twenty were closed in the lock before the verdict was
given**, and every claim below was re-verified by the coordinator against the cited code rather than accepted
on the reviewer's word.

| id | severity | category | finding | closed by |
|---|---|---|---|---|
| RT-01 | Critical | accounting | the source-of-truth matrix pinned revenue to `4100`, which is **Sales Returns**; revenue is `4000` (`0040:59-60`). A perfectly balanced entry would have netted revenue to zero — the GOLD-28 defect | lock §4, corrected, with a separate returns row; goldens read every code from `0040` |
| RT-02 | Critical | process | `tests/security/settlement-s6-no-customer-payments.test.ts` asserts, against the live catalogue, that the Phase 4 tables, routes, source types and operation kinds will never exist (`:41-133`); it is required by name at `phase3-s6-gate.ts:172` and composed into `gate:phase4:s1` | lock P4-AL-88, widened to all four halves, with the two-part re-expression and its red proofs; owner named in §4 above |
| RT-03 | High | security | `accounting_reversals_20_domain_source_guard` is a closed literal list ending at Phase 3 (`0067:2249-2251`) while `accounting_post_reversal` is granted to `daftar_app` (`0046:765`), so the generic path could reverse an `invoice` entry and consume its one reversal slot | a §2.2 requirement, plus a `pg_proc.prosrc` assertion in `gate:phase4:s1` with a red proof |
| RT-04 | High | process | `customer_payment.*` is unbuildable: `op_code ~ '^[a-z]+(\.[a-z_]+)+$'` (`0054:53`) forbids an underscore in the first segment, and the same regex is in the frozen `inventory_assertion_consume` body (`0054:229`) | lock P4-AL-28 renamed the namespace to `customer.*`, and S1 asserts both halves |
| RT-05 | High | security | the "role-default constraints" are one-shot migration-time `DO`-block assertions over hard-coded key arrays (`0041:57-65`, `0057:140-151`); nothing binds a Phase 4 key | lock P4-AL-37 makes the Phase 4 assertion the fourth protection S1 builds; `OD-P4-01`'s "unbuildable" premise corrected |
| RT-06 | High | security | the authority matrix had an **Accountant** column over a three-role system (`permissions.ts:120`, `0041:19-20`), and the cashier/manager default changes break three accepted `toEqual` tests | lock P4-AL-35 states the Accountant is a custom role and names the three tests; plan §4 and P4-S1 own them |
| RT-07 | High | accounting | level-uniqueness has no Phase 3 precedent over a *payment* (the two real `level_uq`s are `0067:438,491`, over a credit note), and a UNIQUE over a declared level does not cap total consumption | lock P4-AL-22 rewritten: the `UNIQUE` is necessary, the COMMIT-time chain verifier is sufficient, and S4 asserts the verifier against direct SQL |
| RT-08 | High | data-integrity | §2.2 omitted the entire **stock** source apparatus that `inventory_stock_source_guard_gaps()` demands (`0061:307-481`, precedent `0063:400-431`) | new lock P4-AL-29b with the full object table; added to plan §6's S2 row and to the `sale_items` candidate key |
| RT-09 | Medium/High | data-integrity | §4 sanctioned `sale_items.cogs_minor` as an "input" while P4-AL-25's input is `stock_movements.value_delta_base_minor` — two stored integers for one figure, unguarded | lock §4 now forbids the column; `cogs|cost` join the extended G-3 pattern |
| RT-10 | Medium/High | documentation | "zero counter columns" is false: `stock_levels.last_stock_seq` (`0059:107`, `0060:437,454`) | lock P4-AL-31's premise replaced with the truth and the cache-versus-record distinction; the conclusion stands |
| RT-11 | Medium | data-integrity | `invariants.ts:207-209`'s `acctRe` drives the **`jargon`** rule, not `tax-control`, and forbids the word `tax` on any walked screen — so P4-AL-44's zero-tax field is un-displayable | lock P4-AL-52 corrected and P4-AL-44 decided: no Phase 4 screen renders a tax field while tax is structurally zero; the Country Pack adds the row |
| RT-12 | Medium | process | the proposed step `return` collides with `flows.ts:275`, reintroducing the coupling P4-AL-63 removes | every Phase 4 step is `p4-` prefixed; P4-AL-63 asserts the lists disjoint and `run.step` refuses a duplicate |
| RT-13 | Medium | documentation | inherited G-2/G-3 rules treat every Phase 4 table as a Phase 3 relation and fix the DDL vocabulary; the lock listed only the guards it must build | new lock P4-AL-15b names the inherited rules and pins the vocabulary |
| RT-14 | Medium | documentation | P4-AL-09's MATCH SIMPLE hazard cannot occur (`business_id` is independently constrained; precedent `0067:339,356`) and the named trigger was on a table with no `customer_id` | both rewritten: the FK reasoning corrected, and three `*_walkin_no_ar` triggers for the invariant that is real |
| RT-15 | Medium | process | P4-AL-06 demanded discovery and then supplied an eleven-table list, in the file whose header explains why lists rot (`:33-38`) | replaced with one rule: the AP/AR vocabulary applies to every relation the Phase 2 prefix did not create |
| RT-16 | Low/Medium | documentation | `§26`, `§4.2` and the plan's `§23` all dangled, and the lock claimed a review had closed every finding while this section was an empty placeholder | §25 Arabic summary added, references fixed, and this table is the record |
| RT-17 | Low/Medium | scope | `payment_methods` already exists (`0067:284`) and the "nineteen tables" count was wrong three ways | lock P4-AL-08 restated; removed from plan §6's S4 row; the bridges and POS tables counted |
| RT-18 | Low/Medium | scope | Phase 6 owns "cart and checkout" by name and `FUTURE_SLICE_SURFACES` is name-based | Phase 4's are `pos_till_sessions` / `pos_cart_lines`, with a `pos_` prefix rule |
| RT-19 | Low | data-integrity | `assertComplete()` allows the **zero**-posting case (`database.ts:488-495`), so the seam the atomic-sale law credited does not give all-or-nothing | lock P4-AL-16 now credits the source row's deferred binding FK, with four structural assertions in `gate:phase4:s2` |
| RT-20 | Low | process | P4-R reused Budget F's 300 s for strictly more work | made calibration-locked with 300 s as a product cap, under `OD-P4-13` |

**The one internal contradiction that changed a decision.** The sale's step order took the invoice sequence
between the two journal acquisitions while the declared lock order called `invoice_sequences` the last lock
*after* `journal_entries`. Resolved by declaring the **domain** lock order and treating
`accounting_post_entry`'s locks as its own internal order, because a sale enters the journal twice and no
linear list naming it once could describe the sale at all.

**What the review could not do.** It executed no gate, suite, budget or migration — one scratch probe of the
guard's own exported functions aside — so RT-02's and RT-06's failure predictions are structural reads of
literal `toEqual` and `toBeNull` assertions rather than observed red runs. It read no Phase 4 product code,
because none exists.

---

## 10. What this slice did not do

No product code, no endpoint, no POS screen, no migration. `0074` does not exist. No gate, suite or budget was
executed. No country's tax law was researched and OD-03 is not closed. P4-S1 does not begin until the Tech Lead
says so.
