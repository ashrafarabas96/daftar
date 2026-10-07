# P4-S6 CONTRACT PACK — reversals, void, and TD-15

**Base SHA: `6587460ba3632231e4324c5ce2af92e1589d0705`**
(`phase/4-sales-pos-customers-receivables`, migrations `0074`–`0086` on disk).
**Branch: `p4s6/owner`.** Not pushed; no pull request.

**Maturity: levels A–E ONLY.** A = pure domain, B = ports and contracts, C = unit, red
proofs, security and concurrency models, D = surface independent of missing schema,
E = DDL **specification**. Levels F (real DB binding), G (integrated gate) and H (seal) are
**not attempted** and are unavailable until P4-S4 and P4-S5 seal and S6 is promoted.

**`READY_TO_PROMOTE = NO`.** §14 holds the checklist that would make it YES.

Every `file:line` is a read of the tree at the base SHA. Where this document and the code
disagree, **the code is the fact**, and §2 records four places where the code already
contradicts an accepted document.

---

## 1. Scope, and the ruling that fixes its shape

**In scope:** `payment_reversals`, `allocation_reversals`, the `void_invoice` compound
command and the refusal of the direct void path, **TD-15's supplier twin**, and the
replacement of the chain protection that is incompatible with reversal
(`docs/PHASE_4_S6_LEVEL_UNIQUENESS.md`).

**`TL-P4-S6-R1` — the LIFO-only fallback is ACTIVE and Option B is CLOSED**
(`docs/PHASE_4_DECISION_REGISTER.md:751-781`). `OD-P4-04` is **RULED, not pending**. This
pack therefore:

- models **no** signed-negative ordinary reducer anywhere;
- carries **no** comparison of the two options and presents **no** open decision about them;
- does not name Option B as an alternative, a fallback or a future candidate.

The design that follows is the LIFO law, implemented as append-only rows.

**The five laws, as they are implemented here.**

1. **LIFO.** A reversal is allowed only when the original reducer is the **last active
   settlement reducer on every chain it affects**.
2. **Append-only.** The original row is immutable: no `reversed` boolean, no mutation, no
   delete. "Active" is the anti-join against the reversal relations, with **one** body
   (`ReversalChainPort.readActiveChain`, and in SQL the widened verifiers).
3. **Whole payment.** Every included active allocation must be a valid tail under lock, or
   the whole command is refused. `planPaymentReversal` has **no parameter** through which a
   partial reversal could be requested — asserted, as a shape, at
   `packages/inventory/test/customer-reversal.test.ts` ("the planner has NO parameter through
   which a partial reversal could be asked for").
4. **Two chains.** A customer-credit application is on the invoice chain **and** the credit
   chain and must be the tail on **both**, in **one** transaction.
5. **Exact inverse.** The journal reversal is the exact inverse of the original **stored**
   financial effect; historical carrying release is **never recomputed**. S6 writes no
   mirror: it reuses `mirrorReversalLines` (`packages/accounting/src/sources.ts:143`) and
   `accounting_post_reversal` (`0046:449`), whose own header states the property — "it
   supplies no account, no amount, no currency, no rate and no dimension … There is no
   parameter through which it could, which is stronger than validating one away"
   (`0046:435-439`).

**"LIFO" in S6 means LAST ACTIVE SETTLEMENT REDUCER and never inventory costing.** No
valuation method appears in this pack; inventory stays written by the accepted
stock-movement authority and S6 adds no second stock writer. `packages/inventory/src/customer-reversal.ts`
contains no cost, no quantity, no `HALF_EVEN` and no release formula, and that absence is
the law rather than a style choice.

**Money** is integer minor units only; rounding is the existing `HALF_EVEN` contract; no
rounding account is invented and `classifyRoundingResidual`
(`packages/accounting/src/rounding.ts:71`) stays unreachable.

---

## 2. Four places where the live tree already contradicts an accepted document

Stated first, because the measurement is the deliverable.

1. **There are FIVE `*_level_uq` constraints, not two.** `P4-AL-22`
   (`docs/PHASE_4_ARCHITECTURE_LOCK.md:509-511`) names `supplier_credit_allocations_level_uq`
   and `supplier_refunds_level_uq`. `0081` added three more (`:334`, `:470`, `:474`). The
   live enumeration is in `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §0; the lock correction is
   `PATCH-REQ-S6-007`.
2. **`supplier_payment_allocations` carries no level constraint at all** (`0067:386-387`;
   `P4-AL-22:515-521` says so). So the supplier **payment** half of TD-15 is not blocked by a
   level constraint, which is the opposite of what a symmetric reading of TD-15 assumes.
3. **TD-15's supplier twin is blocked by a `prosrc` digest pinned inside FROZEN `0067`, not
   by a constraint.** `purchase_settlement_verify(uuid,uuid)`'s SHA-256 is recorded in
   `supplier_settlement_guard_gaps()`' `c_digest` (`0067:1817`, discovery row 15 at
   `0067:1829`) and is read by the existing Phase 3 suite
   `tests/security/settlement-s6-guard-gaps.test.ts`, which S6 may not edit. Widening that
   verifier for the ACTIVE subset turns an accepted suite red. `PATCH-REQ-S6-005`;
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §5.2.
4. **`P4-AL-20`'s source-type enumeration does not describe this tree, and the discrepancy
   is in S6's own surface.** It names `payment_allocation`, `credit_note`, `refund` and
   `allocation_reversal` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:476-478`); the live registry
   holds `customer_payment_allocation`, `customer_credit_application` and `customer_credit`
   (`0081:2467-2472`) and holds no `allocation_reversal`. `docs/PHASE_4_S5_PREPARATION.md`
   §3.3 records the same finding from the S5 side. **S6 does not register an
   `allocation_reversal` accounting source type** (§7 says why).

---

## 3. Predecessor assumptions, each stated so a diff against the SEALED tree can CONFIRM or REFUTE it

Every row is a claim about a tree that has not sealed. The **check** column is the command or
the diff that settles it; a row that cannot be settled by a diff is not an assumption, it is a
hope, and there are none of those below.

### 3.1 About P4-S4 (in acceptance now)

| # | assumption | check against the sealed tree | if REFUTED |
|---|---|---|---|
| S4-1 | `payment_allocations` exists with `ar_released_before_txn_minor`, `invoice_amount_applied_minor`, `invoice_carrying_base_released_minor`, `binding_source_id = id` | `\d payment_allocations`; `git diff 6587460..<seal> -- …/0081_*.sql` shows no column rename | the chain model's field names change; `ActiveReducer` is a rename, the laws are not |
| S4-2 | the three S4 level constraints exist with the exact definitions of `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §0 | `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname LIKE '%\_level\_uq'` | the replacement set in that document changes membership; its §6 order does not |
| S4-3 | `invoice_settlement_verify(uuid,uuid)` chains the reducer `UNION ALL` ordered by `(x, amount)` and requires `x = before` (`0081:739-756`) | diff the function body at the seal | the ACTIVE-subset widening is written against a different body; the predicate is the same |
| S4-4 | `invoice_outstanding(uuid,uuid)` is the reader-of-record and is **replaced by the slice that adds a reducer relation** (`0081`'s own comment at `:1380`) | the comment and the seam `S-P4-03` still say so | S6 must not add a reducer relation at all, which would make the whole slice a different shape |
| S4-5 | `accounting_reversals_20_domain_source_guard()` refuses `customer_payment_allocation`, `customer_credit_application` and `customer_credit` in the **plain** arm, with the `purchase` paired arm beside it (`0081:1405-1417`) | diff the function body | S6's widening has a different starting body; the three types still need a paired arm |
| S4-6 | the declared lock order is advisory key → `invoices` FOR UPDATE in id order → `customer_credits` FOR UPDATE → `customers` FOR SHARE → `payment_methods` FOR SHARE (`0081:1755-1765`) | diff that comment block and the five lock sites | §8's order is rebuilt; it **extends** S4's and never reorders it |
| S4-7 | `GRANT UPDATE (status) ON invoices TO daftar_inventory_internal` exists, and neither S4 routine issues an `UPDATE` on `invoices` (`0081:682`, held by `tests/guards/p4s4-settlement-surface-laws.test.ts`) | `\dp invoices`; that suite still green | the void's status write needs its own grant argument, and the "no UPDATE" law needs restating for a slice that **does** update `status` |
| S4-8 | `customer_credits.remaining_amount_minor` moves only through `customer_credit_consume` (R-90, `0081:1224`), judged by `customer_credit_guard()` (`:1070`) | diff both bodies | the reversal's upward restoration has a different single writer to widen |
| S4-9 | `payments.allocation_count` admits **0** (R-87, `0081:262`) | the `CHECK` at the seal | a payment reversal with zero allocations is unreachable, and §5's zero-allocation case is dead |
| S4-10 | the twelve permissions are closed, and `payments.reverse` and `sales.void` are registered and SENSITIVE (`permissions.ts:84-89`, `:137-145`) | diff `PERMISSIONS` and `SENSITIVE_PERMISSIONS` | S6 has no authority to name and cannot ship a route |
| S4-11 | `DOMAIN_REVERSIBLE_SOURCE_TYPES` is `['purchase']` alone (`packages/accounting/src/post.ts:301`) | diff that constant | `PATCH-REQ-S6-003` is narrower or unnecessary |
| S4-12 | `0086` leaves the four relations' RLS as the seven-policy set of `0081:528-603` | `\d+` the four; `tests/security/p4s4-rls-quals-once-per-query.test.ts` green | §11's RLS specification copies a different shape |

### 3.2 About P4-S5 (running in parallel, owner not me)

| # | assumption | check against the sealed tree | if REFUTED |
|---|---|---|---|
| S5-1 | S5 adds `credit_notes`, `credit_note_items`, `refunds` and `credit_note_applications` (`docs/PHASE_4_S5_PREPARATION.md` §3.1 corrects the plan's omission of the fourth) | `\dt`; the sealed S5 migration | the invoice chain has a different reducer membership, and every widened verifier in this pack gains or loses a branch |
| S5-2 | `credit_note_applications` is an invoice-chain reducer and joins `invoice_settlement_verify`'s `UNION ALL` | diff that function body | S6's ACTIVE-subset widening has a two-branch chain, not three, and the reversal surface loses a reducer kind |
| S5-3 | S5 widens `customer_credit_verify` for the refund (`docs/PHASE_4_S5_PREPARATION.md` §2.3) and **S6's widening composes with S5's** | diff `customer_credit_verify` at the S5 seal | S6's widening is written against `0081`'s body instead, and the composition note in `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §3 is withdrawn |
| S5-4 | `refunds` carries **two nullable sources** (`credit_note` XOR `customer_credit`, `TL-P4-S5-R1`) and **names no invoice** | the sealed DDL | a refund may be an AR reducer, which would put it on the invoice chain and inside S6's reversal surface |
| S5-5 | a refund is **not** an AR reducer: AR falls exactly once, at the credit note (the owed test at `docs/PHASE_4_S5_PREPARATION.md` §8) | that test green at the S5 seal | reversing a refund would have to reverse an AR release, which is a different law from the one in §5 |
| S5-6 | S5 carries its own level protection on every consumable source (`P4-AL-22:528-530` requires both devices) and does **not** drop any existing one | `pg_constraint` at the seal | S6's replacement set in `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §0 is incomplete or already partly done |
| S5-7 | S5 registers `credit_note` and `refund` accounting source types and adds them to the **plain** refusal arm of `accounting_reversals_20_domain_source_guard()`, not to a paired arm | diff the guard at the S5 seal | S6 inherits a guard that already admits a reversal of one of them, and must not add a second paired arm for the same type |
| S5-8 | S5 adds no `reversed`, `voided` or `status` column to any reducer relation | the sealed DDL | the append-only law has a competing mechanism in the tree and `TL-P4-S6-R1`'s shape is contradicted |
| S5-9 | S5's migrations occupy the numbers immediately after S4's candidates, so **S6's prefix is unknown until both seal** | `ls infrastructure/database/migrations/` | nothing in this pack changes: it allocates no number |

**One assumption I could not settle from the tree at all, and it is recorded as such, not
guessed:** whether S5's refund reversal (if S5 ships one) and S6's allocation reversal share
one `allocation_reversals` relation or two. `docs/PHASE_4_S5_PREPARATION.md` §7 does not
mention a reversal and `docs/PHASE_4_EXECUTION_PLAN.md:194-196` assigns both
`payment_reversals` and `allocation_reversals` to S6, so the tree's answer is "S6's, both" —
but the S5 *owner* may read `TL-P4-S5-R1` differently, and no diff of the base tree can tell
me. It is a coordination question, not an engineering one.

---

## 4. Tables, columns and constraints EXPECTED (not created)

### 4.1 Expected to exist already, unchanged

`payments`, `payment_allocations`, `customer_credits`, `customer_credit_applications`
(`0081:243`, `:296`, `:371`, `:438`); `invoices`, `customers`, `sales` (`0075`, `0077`);
`journal_entries`, `journal_lines`, `accounting_reversals`, `accounting_source_bindings`,
`accounting_source_types`, `accounting_operation_kinds` (`0045`, `0046`);
`inventory_operation_kinds` (`0054`); `audit_events`, `outbox_events`.

### 4.2 Expected to be CREATED by S6's migration

Specified in `docs/PHASE_4_S6_DDL_SPECIFICATION.md`. Two relations and one trigger surface:

- **`payment_reversals`** — one row per reversed payment. `id` is the client-chosen reversal
  id and the idempotency key.
- **`allocation_reversals`** — one row per reversed reducer, naming the reducer and its
  mirror entry. This is the **only** definition of "not active", and the two verifiers
  anti-join against it.
- **the void surface** — `invoices_direct_void_guard()` on `invoices`, and the
  `invoice_void` compound command.

### 4.3 Expected to be REPLACED by S6's migration

| subject | why | detail |
|---|---|---|
| `payment_allocations_level_uq`, `customer_credit_applications_level_uq`, `customer_credit_applications_invoice_level_uq` | incompatible with reversal | `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §2–§4 |
| `supplier_credit_allocations_level_uq`, `supplier_refunds_level_uq` | the same, on frozen relations, via FORWARD DDL only | ibid. §5; **blocked** by `PATCH-REQ-S6-005` |
| `invoice_settlement_verify`, `customer_credit_verify`, `invoice_outstanding` | the ACTIVE subset; and `0081:1380` already says the reader is replaced by the slice that adds a reducer relation | `CREATE OR REPLACE` by their owner, bodies diffed against the S4/S5 seal |
| `accounting_reversals_20_domain_source_guard()` | the three customer source types move from the plain refusal arm to a `purchase`-style **paired** arm, admitting a reversal **iff** a paired `allocation_reversals` / `payment_reversals` row exists | `0081:1405-1417` is the body to replace; the mechanism is `0081:1410-1413` applied to three more types |
| `customer_credit_consume`, `customer_credit_guard()` | one more lawful transition: the restoration a reversal makes. Same single writer, not a second one | `0081:1224`, `:1070` |

**Prohibited, and not in the specification anywhere:** a placeholder production table, a fake
migration, a temporary commercial relation, a second financial model, a second AR balance, a
second stock writer, a fake journal source, a `reversed` boolean, a row mutation, a delete,
and a signed-negative ordinary reducer.

---

## 5. APIs (level D — declared, not mounted)

`packages/shared-contracts/src/customer-reversal.ts`. **No route of it is mounted**, and no
controller is added, because a route for an authority this slice's database does not yet
grant is a route that cannot work (`receivables-permissions.ts:17-19`, the same argument S4
made about `payments.reverse`).

| method | path | permission | sensitive | body |
|---|---|---|---|---|
| POST | `/v1/customer-payments/:paymentId/reversal` | `payments.reverse` | **yes** | `reversalId`, `reversalDate`, `reason` |
| POST | `/v1/settlement-reducers/:reducerId/reversal` | `payments.reverse` | **yes** | `reversalId`, `reversalDate`, `reason` |
| POST | `/v1/invoices/:invoiceId/void` | `sales.void` | **yes** | `voidId`, `voidDate`, `reason` |
| GET | `/v1/customer-payments/:paymentId/reversal` | `receivables.view` | no | — |

**No request carries an amount.** That is the exact-inverse law and the whole-payment law
expressed as absences: there is no `amountMinor`, no `releasedMinor`, no rate and no
allocation list on any request, so a client cannot ask for a partial reversal or state a
figure the original did not say.

**The read path is not optional.** The recorded lesson is the POS basket whose only readers
were its own write commands (`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:129-136`):
state whose only reader is its command's return value has **no read path**. So the `GET`
above is part of the surface, behind the same gate and the same projection as the write, with
its own refusal set (absence and authority only — it inherits none of the write's
`*_inconsistent` refusals), and `200 []`/`404` rather than a refusal for an absent reversal.

---

## 6. Permissions

Nothing is invented. The registry is a **closed set of twelve** (`permissions.ts:68-89`,
`P4-AL-36`) and S6 uses two keys that are already in it:

- `payments.reverse` (`permissions.ts:85`) — **SENSITIVE** (`:142`);
- `sales.void` (`permissions.ts:80`) — **SENSITIVE** (`:139`).

Under the `OD-P4-01` **OPTION A** ruling neither may be a **default** of any built-in role,
the cashier and the manager included, and `0076`'s `role_permissions` assertion
(`P4-AL-37`, `0076:43-48`) closes the default set with a planted red proof. **S6 adds no
default, adds no key and edits no role.** A thirteenth key — `reversals.approve`, say —
contradicts `P4-AL-36`; the assertion that notices is in
`packages/inventory/test/customer-reversal.test.ts` ("every permission S6 names is ALREADY
one of the registered twelve, and every one of them is SENSITIVE").

---

## 7. Accounting source types and operation kinds

### 7.1 Operation kinds (the `invctl/1` registry)

Three, each satisfying the **frozen** `^[a-z]+(\.[a-z_]+)+$` (`0054:53`, duplicated inside
`inventory_payload_digest` at `0054:229`), so no first segment carries an underscore
(`P4-AL-28`):

| op code | permission |
|---|---|
| `customer.reverse_payment` | `payments.reverse` |
| `customer.reverse_allocation` | `payments.reverse` |
| `sale.void_invoice` | `sales.void` |

They are declared in `packages/inventory/src/customer-reversal.ts` as
`REVERSAL_OPERATION_CODES` and **deliberately not added** to `INVENTORY_OPERATION_CODES`:
`gate:phase4:s4`'s `command-refusal-audit` check discovers a command path per declared
operation, so registering three with no routine behind them would make the gate report a path
it cannot find. `PATCH-REQ-S6-001`.

### 7.2 Accounting source types — S6 registers NONE, and that is the finding

`P4-AL-20` lists `allocation_reversal` among Phase 4's source types
(`docs/PHASE_4_ARCHITECTURE_LOCK.md:476-477`). **The live mechanism makes it unnecessary and
a second truth if added.** A reversal's journal fact is the **native** `reversal` source
type (`packages/accounting/src/post.ts:191`), written by `accounting_post_reversal`, keyed
`accounting_reversals.id = original_entry_id` so exactly one whole-entry reversal per entry
exists for ever (`P4-AL-47`). The accepted precedent is explicit: `purchase_reversal` "is
registered as a **STOCK** source type only (R-B2a): its accounting fact is a Phase 2
`reversal`" (`0065:17-18`), and `purchase_reversals.accounting_source_type` is
`GENERATED ALWAYS AS ('reversal') STORED` (`0065:310`).

**So S6 follows `0065` and not `P4-AL-20`:** `payment_reversals` and `allocation_reversals`
carry `accounting_source_type GENERATED ALWAYS AS ('reversal') STORED` and
`binding_source_id = original_entry_id`, and **no new accounting source type is registered**.
Registering `allocation_reversal` would create a second source identity for one journal fact,
which `P4-AL-23` and `P4-AL-09` both forbid. `PATCH-REQ-S6-008` carries the `P4-AL-20`
correction.

### 7.3 The reversible-source widening

`DOMAIN_REVERSIBLE_SOURCE_TYPES` is `['purchase']` alone today
(`packages/accounting/src/post.ts:301`), and `0081`'s own comment records why the three
customer types were left out: "None of the three joins `DOMAIN_REVERSIBLE_SOURCE_TYPES`
below. Reversal is P4-S6" (`post.ts:280-282`). S6 adds them. `PATCH-REQ-S6-003`.

---

## 8. Lock order and transaction boundary

### 8.1 The order — an EXTENSION of S4's, never a reordering

S4's declared order (`0081:1755-1765`): advisory document key → `invoices` FOR UPDATE in id
order (the cap lock) → `customer_credits` FOR UPDATE → `customers` FOR SHARE →
`payment_methods` FOR SHARE. Then, inside the accounting writer: `businesses` FOR SHARE, then
the **shared** advisory account locks in account-id order (`0046:565-570`).

S6's:

| step | lock | notes |
|---|---|---|
| 1 | `pg_advisory_xact_lock('daftar.<reversal document>_id', <id>)` | the reversal's own id; the idempotency key |
| 1′ | `pg_advisory_xact_lock('daftar.payment_id', <payment>)` | payment reversal only, **after** step 1, so two advisory classes have a fixed order |
| 2 | `payments` row FOR UPDATE | payment reversal only. A **new** lock class, taken **before** `invoices`; no S4 path takes a `payments` row lock at all, so it cannot close a cycle |
| 3 | every affected `invoices` row FOR UPDATE, **in id order** | **THE CHAIN LOCK** — the same lock, on the same rows, as S4's cap lock |
| 3′ | every affected `customer_credits` row FOR UPDATE, **in id order** | after step 3, which is S4's order |
| 4 | the `customers` row FOR SHARE | |
| 5 | `businesses` FOR SHARE, then shared advisory account locks in account-id order | inside `accounting_post_reversal`; not S6's to change |

**The reducer rows themselves are never locked.** They are immutable and have no `UPDATE`
path, so there is nothing to serialise on them; the chain lock is the invoice or the credit.

**The mirror order is chosen by this slice and not by a query plan.**
`exactInverseSteps` sorts by `originalEntryId`, because `accounting_post_reversal` takes a
shared advisory lock per account and a set of mirrors posted in repository order is a lock
order nobody chose — and a lock order nobody chose is what a deadlock reports
(`[[daftar-lock-order-not-retry]]`, `P4-AL-41`).

### 8.2 The transaction boundary

**ONE transaction** per command, at **READ COMMITTED** (asserted, as `0081:1884-1886`
asserts it). A payment reversal reverses the payment, **every** active allocation and the
surplus credit, and posts every mirror, in that one transaction. A reversal and a refund are
**two operations** and are never merged: the merged-path red proof is owed at level F
(`docs/PHASE_4_EXECUTION_PLAN.md:197-199`).

### 8.3 The race proofs, as models (level C)

`packages/inventory/test/customer-reversal-concurrency.test.ts`, 15 cases, green. No sleeps:
every interleaving is a written-down list of which transaction advances next, and every
contender's arrival in the queue is observed by `expectQueued`, which **fails** when a
transaction never queued — two connections used in sequence are not contention. A deadlock
has its own outcome kind and nothing retries.

| case | what it settles |
|---|---|
| C-1 | reversal vs reversal of the same tail: exactly one commits, the loser is `not_last_reducer`, the original row is still there; and the **mirror** service order gives the mirror outcome, so the result is the protocol and not the schedule |
| C-2 | reversal vs a new allocation, both orders: the allocation lands at the **freed** level while the reversed original still holds it (two rows at level 700), and the active chain is still contiguous |
| C-3 | two allocations after a reversal: both commit at **successive** levels; when only one amount is free, the loser is capped under the lock |
| C-4 | a two-chain reversal: both chain locks in ONE transaction in resource order, and a competing writer on **either** chain queues behind it |
| C-5 | a stale head: refused `settlement_changed`; and over **four** interleavings, **no** stale head commits and **no** deadlock occurs |
| C-6 | deadlock ordering: every relevant lock **pair** in **both** directions under the declared order → **zero** deadlocks; plus a **planted** lock-order defect (one party reversing the pair) that **must** deadlock, so the zero is not vacuous |
| C-7 | a direct-SQL race: neither party locks (`s.queued` is empty — with no lock there is no contention, so the protection cannot be a lock), and the deferred verifier refuses at COMMIT; with a **single** direct insert at the freed level **accepted**, so the verifier refuses the overlap and not the level |

---

## 9. Refusal codes

`REVERSAL_CODES` in `packages/inventory/src/customer-reversal.ts` — nineteen, closed, sorted,
held to its own type union by the compiler. Three namespaces: `payment_reversal.*`,
`allocation_reversal.*`, `invoice_void.*`.

The one a merchant meets most is `*.not_last_reducer` (409), which is the LIFO law and is a
real usability wall by ruling. Its details carry `reverseInThisOrder`, newest-first — the only
order the law admits — so the client can offer the next lawful step. A refusal **never**
carries an amount.

**Owed:** these codes are not yet `InventoryErrorCode` (`PATCH-REQ-S6-002`), have no
`RECEIVABLES_STATUS`-style classification, and have no `error.*` entry in the three locale
catalogues (`PATCH-REQ-S6-009`). Until the catalogues exist each resolves to the **safe
fallback** sentence — the correct failure mode, not the finished one.

---

## 10. Performance budgets

**S6 has no accepted budget row.** `P4-AL-71`'s table
(`docs/PHASE_4_ARCHITECTURE_LOCK.md:1404-1412`) runs `P4-A` … `P4-H` and `P4-R`; none of them
is a reversal or a void. The nearest anchors are `P4-F` (payment allocation over 5 invoices,
≤ 40 ms in-transaction / ≤ 100 ms over HTTP) and `P4-G` (a compound command,
**calibration-locked** with a hard product cap of 1 000 ms).

**So S6's budgets are OWED and are to be CALIBRATED, not guessed** — `OD-P4-13` is RULED
A + C and governs exactly this. The proposal, for the owner to rule on, is two rows:

| proposed | subject | anchor |
|---|---|---|
| `P4-I` | reverse one allocation: the tail check under the lock plus one mirror entry | `P4-F`'s journal half plus one chain read; a **calibrated** ceiling under a product cap |
| `P4-J` | reverse a payment over 5 invoices: five tail checks plus six mirrors | composed, **calibration-locked**, on the `P4-C`/`P4-G` rule |

No number is asserted here. `scripts/phase4-budget-ratchet.ts` and
`tests/guards/p4s4-budget-ratchet-law.test.ts` are the devices a landed row goes through, and
both are outside S6's ownership.

---

## 11. RLS assumptions

Both new relations take the **seven-policy** set `0081:528-603` installs on each of the four
S4 relations, verbatim in shape:

`ENABLE` + **`FORCE`** ROW LEVEL SECURITY; `tenant_membership` (permissive, USING and WITH
CHECK on `tenant_id = app_tenant()`); `business_isolation_read` / `_insert` / `_update` /
`_delete` as **RESTRICTIVE**; `inventory_internal_read` and `accounting_validator` as
`FOR SELECT TO <internal role> USING (true)`.

**`TL-P4-RLS-INT-01` is RULED and is not reopened** (`docs/PHASE_4_DECISION_REGISTER.md:777`).
The internal authorities' cross-tenant read is **INTENTIONAL**; no migration is written to
narrow it, frozen `0052` is not modified, and it is **not** recorded as debt — intentional
architecture is not technical debt. The question that replaces it is whether an **ordinary
runtime credential** can reach cross-tenant data or effect **through** that authority, and
the four-way matrix at `:824-831` may not be collapsed into one statement.

`0086` is the RLS-quals-once-per-query migration and its law
(`tests/security/p4s4-rls-quals-once-per-query.test.ts`) acquires the two new relations as
subjects the day they land. §13 counts that cost.

---

## 12. Security assumptions

1. **Every write goes through a routine whose authority was checked.** `daftar_app` holds
   `SELECT` on the new relations and **no DML at all**, exactly as `0081:613-617` does it
   (`P4-AL-38`). Writes are `SECURITY DEFINER` routines owned by `daftar_inventory_internal`,
   `PUBLIC` EXECUTE revoked, `search_path = pg_catalog, public, pg_temp`.
2. **The row-lock ACL.** A locking clause needs `SELECT` **plus one of**
   UPDATE/DELETE/TRUNCATE (`0081:620-680`). Steps 3, 3′ and 4 of §8 are already covered by
   `0081:617` and `0081:682-683`. **Step 2 is NOT**: no grant in the tree lets
   `daftar_inventory_internal` lock a `payments` row. S6's migration owes
   `GRANT UPDATE (<one column>) ON payments TO daftar_inventory_internal`, with `0081`'s own
   argument — column-level, one column, never table-level, and the permanent assertion that
   the routine issues no `UPDATE` on `payments`
   (`tests/guards/p4s4-settlement-surface-laws.test.ts` is the shape to extend, and it is not
   S6's file: `PATCH-REQ-S6-010`).
3. **The void's `status` write is the one UPDATE S6 does issue**, and it breaks S4's "no
   UPDATE on `invoices`" claim rather than quietly contradicting it. `0081:682` already
   grants `UPDATE (status) ON invoices`, and `invoices_lifecycle_guard()` (`0075:546`) bounds
   `draft → open → void`. So the grant exists, the transition is already lawful, and what S6
   adds is the **precondition** (§"the void surface" of the DDL spec) and the **refusal of the
   direct path**.
4. **Idempotency.** Same identity + same intent hash → exact replay, writing nothing;
   changed intent → `*.idempotency_conflict`. The intent is **request-only** — the reversal
   id, the document id, the date and the reason — so no derived figure is in the digest and a
   rate movement between retries is not a false conflict
   (`[[daftar-registry-before-state]]`, `0081:1912-1918`). **No key may silently accept a
   different economic command**, and because no request carries an amount there is no amount
   a changed intent could smuggle past the hash.
5. **Cross-tenant.** A reversal of another tenant's payment is `*.not_found` and that is all
   the caller learns — `accounting_post_reversal`'s own composite-identity rule
   (`post.ts:456-460`, `0046` §20).
6. **A wrapper is not an invariant.** Every law in §4.3 is a trigger on the relation, never a
   check inside the routine, so a direct-SQL writer meets it (`0081:666-669`).

---

## 13. The estate cost, and the test hooks

### 13.1 Discovery-based laws that acquire the two new relations as subjects

Measured by reading the laws, not by guessing: `tests/security/phase4-forward-evolution.test.ts`
(the four forbidden claim shapes, over every suite discovered from disk);
`tests/security/p4s4-rls-quals-once-per-query.test.ts`; `tests/guards/p4s4-new-relation-coverage.test.ts`;
`tests/security/phase3-s8-grant-matrix.test.ts`' `od03Problems`, which reads **every** column
matching `(^|_)tax(_|$)` on **every** relation in `public` — so S6's relations must carry no
tax-named column at all, or carry one as a structural zero. **They carry none.**

### 13.2 What will NOT go red, and why that is a measurement

`tests/security/settlement-s6-no-customer-payments.test.ts` is **Phase 3** S6 and is already
re-expressed to be scoped to the Phase 3 prefix (`docs/PHASE_4_S5_PREPARATION.md` §0 item 3),
so S6's relations do not make it red. The `settlement-s6-*` family under `tests/` is Phase 3
throughout — **not this slice** — and nothing in this pack edits any of it.

### 13.3 Test hooks S6 needs and does not have

- an active-chain reader the suites can call without reimplementing the anti-join: the SQL
  twin of `ReversalChainPort.readActiveChain`;
- a `plantReversalRow` device beside the existing `plantSettlementRow`
  (`tests/golden-regression/phase4-s4/harness`), for the direct-SQL red proofs of
  `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §6;
- a reversal path in `tests/golden-regression/phase4-s4/settlement-path.ts`.

All three are `tests/**` and belong to S4's suites, so they are **patch requests**
(`PATCH-REQ-S6-010`) and not edits.

### 13.4 Integration seams

| seam | statement |
|---|---|
| S-P4-03 | `invoice_outstanding` is replaced by the slice that adds a reducer relation (`0081:1380`). S6 adds the **activeness** of existing reducers rather than a relation, and it still must replace the reader: an outstanding computed over reversed rows is a wrong receivable |
| S-P4-02 | `accounting_reversals_20_domain_source_guard()` is widened by the owner of each registration, in the same file (`0081:1392-1403`). S6 is the first slice to move a Phase 4 type into the **paired** arm |
| the accounting writer | `accounting_post_reversal` is **reused**, never replaced. S6 writes no journal line |
| the stock writer | untouched. A void returns stock through the **accepted** stock-movement authority; S6 adds no movement kind and no second writer |

---

## 14. `READY_TO_PROMOTE = NO` — the checklist that would make it YES

**Gates (not S6's to open):**

1. **P4-S4 sealed**, and every §3.1 row confirmed by a diff against the sealed tree.
2. **P4-S5 sealed**, and every §3.2 row confirmed — in particular S5-2, S5-3 and S5-5, each
   of which changes the shape of a verifier S6 replaces.
3. **S6 promoted** by an explicit directive, and the migration prefix allocated by the one
   migration owner.
4. **`PATCH-REQ-S6-005` ruled** — the frozen `prosrc` digest. Until it is, **no supplier-side
   reversal may be written**, and TD-15 cannot close.

**Then, in order:**

5. Patch requests `-001`, `-002`, `-003`, `-006`, `-009`, `-010` applied.
6. The S6 migration written by the migration owner to
   `docs/PHASE_4_S6_DDL_SPECIFICATION.md`, with
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §6's removal order and **a red proof per replaced
   constraint, in both directions** (the unlawful insert refused, the lawful post-reversal
   insert accepted).
7. Level F: the models of §8.3 re-expressed against a real cluster, every outcome the same,
   plus the real-database cases a model cannot reach — the deferred verifier firing at COMMIT,
   `40P01` from a planted lock-order defect, and the `provider_reference` idempotency at the
   database (`docs/PHASE_4_EXECUTION_PLAN.md:198`).
8. The owed goldens: reversal and refund proven to be **two** operations by the merged-path
   red proof; a second reversal refused; the multi-currency reversal using the **original**
   snapshots; **no stale allocation after a payment reversal**.
9. The routes mounted in **both** Nest compositions, with the cross-tenant golden's
   ALLOW/DENY pairs at the API **and again at SQL**, and `200 []`-style content isolation for
   the read.
10. `P4-I` and `P4-J` calibrated and ratcheted.
11. `gate:phase4:s6` composing `s5`; `gate:phase4:s4 --structural-only` still PASS.
12. TD-15 closed **with its `TECHNICAL_DEBT.md` reference corrected**: the substantive spec is
    `ACCOUNTING_RULES.md` §5.2 + §5.4, **not** DM §7's mutable `reversed` flag, and the debt
    has **three** sources, not one (`docs/PHASE_4_ARCHITECTURE_LOCK.md:172`, `:1630`).
13. G-05, G-10 and G-11 green.

**What is missing right now, in one sentence:** everything from level F onward, because the
schema S6 binds to does not exist yet and the two documents that would tell me its final shape
are still in acceptance — and, independently of that, the supplier half of TD-15 is blocked by
a digest pinned inside a frozen migration, which is a ruling and not a task.

---

## 15. Prohibited assumptions — things this pack must NOT be read as having settled

- that `OD-P4-04` is open, or that Option B is available in any form. It is **RULED** and
  **CLOSED**.
- that a migration number is known, implied or reservable. **None is named anywhere in this
  pack or in any file on this branch.**
- that level uniqueness alone is the protection being replaced. It is one third of one, and
  `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §0 quotes the two recorded lessons.
- that "LIFO" has anything to do with inventory costing.
- that a reversal may recompute a historical carrying release, or recompute **anything** from
  the original. It mirrors; it does not compute.
- that the supplier twin is specified past level E. It is **blocked**.
- that `OD-03` moved. Sales tax is **structurally zero** and no country's law is researched,
  guessed or encoded here; no relation in this pack carries a tax-named column.
- that the TypeScript module is wired. It exports from `@daftar/inventory` and
  `@daftar/shared-contracts` and **nothing imports it**: no controller, no service, no
  operation registry and no route.
- that any existing suite was edited. **None was.** Every cross-boundary need is a patch
  request in `docs/patch-requests/`.
