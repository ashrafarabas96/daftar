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

## 2. Four measurements of the live tree, two of them corrections to this pack's first draft

Stated first, because the measurement is the deliverable. Items 1 and 3 were drafted as
contradictions between the tree and an accepted document; both were over-stated, and the
corrected readings are below. **A finding I got wrong is a finding about my own work and is
recorded as one, not quietly removed.**

1. **There are FIVE `*_level_uq` constraints in the tree, of which TWO are accepted — which
   is exactly what `P4-AL-22` says.** `P4-AL-22`
   (`docs/PHASE_4_ARCHITECTURE_LOCK.md:509-511`) enumerates the **accepted**
   level-uniqueness constraints: `supplier_credit_allocations_level_uq` (`0067:438`) and
   `supplier_refunds_level_uq` (`0067:491`). `0081` adds three more (`:334`, `:470`, `:474`),
   but `frozenThrough` is `0079`, so `0080`–`0086` are S4 **candidates** and none of them is
   accepted. The same paragraph of the lock anticipates them in terms — *"Phase 4
   **introduces** `payment_remaining_before_minor` on `payment_allocations`; it does not
   inherit it."*

   **The first draft of this pack called the lock's enumeration stale. That was wrong: the
   conflation was between *accepted* and *live*, and it was mine.** The live read of five is
   retained because S6's replacement work must address all five, and it is in
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §0 with an accepted/candidate column.
   `PATCH-REQ-S6-007` is rewritten accordingly: the lock's enumeration becomes stale **at the
   moment `0081` is sealed**, and must be updated **in that seal commit** — not before,
   because updating it earlier would make the lock claim an acceptance that has not happened.
2. **`supplier_payment_allocations` carries no level constraint at all** (`0067:386-387`;
   `P4-AL-22:515-521` says so). So the supplier **payment** half of TD-15 is not blocked by a
   level constraint, which is the opposite of what a symmetric reading of TD-15 assumes.
3. **TD-15's supplier twin crosses a `prosrc` digest pinned inside FROZEN `0067` — and that
   is an open ruling, not a blocker.** `purchase_settlement_verify(uuid,uuid)`'s SHA-256 is
   recorded in `supplier_settlement_guard_gaps()`' `c_digest` (`0067:1817`, discovery row 15
   at `0067:1829`) and is read by the existing Phase 3 suite
   `tests/security/settlement-s6-guard-gaps.test.ts`, which S6 may not edit. Widening that
   verifier for the ACTIVE subset makes the recorded digest read false against the body the
   database then holds, and that suite goes red at that moment.

   **The first draft of this pack framed this as the slice's one blocker. That was an
   over-escalation of mine.** The frozen **file** is not modified in any of the three paths —
   the routine is replaced by **forward DDL**, which is already append-only — and the accepted
   **suite** is not frozen, since byte-immutability binds the **migrations** alone. An
   append-only safe solution therefore exists, and **nothing in the customer half of S6 waits
   on it.** It stays an open ruling of the coordinator's, to be made at **S6 promotion** with
   the independent challenger's signature. `PATCH-REQ-S6-005`;
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §5.2.

   **The sharper hazard in the same change** is the one that is recorded and is not mine to
   rule either: `0067:2790`, `0072:903` and `0077` each assert a **substring** of
   `accounting_reversals_20_domain_source_guard()`'s refusal list, and an assertion on a
   substring of a message is an assertion about the **wording**, not about the **law**. S6's
   widening changes that list's membership, so the S6 migration must probe what those three
   assertions still match.
4. **`P4-AL-20`'s source-type enumeration does not describe this tree, and the discrepancy
   is in S6's own surface.** It names `payment_allocation`, `credit_note`, `refund` and
   `allocation_reversal` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:476-478`); the live registry
   holds `customer_payment_allocation`, `customer_credit_application` and `customer_credit`
   (`0081:2467-2472`) and holds no `allocation_reversal`. `docs/PHASE_4_S5_PREPARATION.md`
   §3.3 records the same finding from the S5 side. **S6 does not register an
   `allocation_reversal` accounting source type** (§7 says why).

### 2A. What the independent challenge found, and what it changed

Signature 2 returned fourteen findings. Nineteen claims of this pack held, including the
exact-inverse law and the single-chain tail sufficiency. **Six findings changed the design or
this pack, and three of them were defects in my own proofs rather than in my prose.** They are
listed here, in the order of their consequence, so a reader of this section knows what the
first draft got wrong without reading the first draft.

| # | finding | severity | what changed |
|---|---|---|---|
| **F1** | the level-uniqueness replacement was **weaker** than what it dropped, on the unlocked path. A `UNIQUE` index is cross-transaction **mutual exclusion**; a `BEFORE INSERT` trigger that reads and a `DEFERRABLE` constraint trigger that fires inside the committing transaction provide none, so two direct inserts at one freed level both commit | CRITICAL | the replacement is now a **widened** key carrying the chain's reversal generation beside the level, never a drop: `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §1A, DDL spec §2A. **And my concurrency model was itself the reason I could not have caught it** — it declared READ COMMITTED and implemented READ UNCOMMITTED with no rollback. The model now stages writes per transaction, discards them on refusal, and models the index as a key-level exclusion; C-7 asserts the F1 state as a finding |
| **F2** | the mandatory AR-reader widening named `invoice_outstanding(uuid,uuid)` at `0081:1334`, which has held **no reducer read since `0083`** and is a thin delegating wrapper. The reducer `UNION ALL` lives in the **array overload** at `0084:593`, which `0084:516` records as the last definition of that name **because seam `S-P4-03` reads the last one** | CRITICAL | the target is corrected in DDL spec §4 and in `PATCH-REQ-S6-004`; the scalar wrapper is specified as **NOT widened**, because widening it would be a second statement of the settlement sum. Implemented as first written, every invoice would have kept subtracting the reversed reducer for ever — the exact harm I called the row mandatory to prevent |
| **F5** | the "blocker" I declared was none: `tests/security/settlement-s6-guard-gaps.test.ts:122-140` hard-codes **no digest**; it computes both sides from live `pg_proc`, and the `22 + 3` count is unchanged by a **replaced** entry. The precedent is `0067:1431-1435` in the same pair of functions, whose comment I had quoted | — | `PATCH-REQ-S6-005` is rewritten as a **task**, and the supplier half of TD-15 is now **specified** rather than deferred. I had applied one standard to dropping a frozen constraint by forward DDL and another to re-recording a frozen digest |
| **F3** | `payment_reversals.original_entry_id NOT NULL` is unsatisfiable: a `payments` row posts **no** journal entry (`0081:2194`), so the column forced two rows claiming one journal reversal. I had mirrored `purchase_reversals`, a **1:1** document; a payment is **1:N** | HIGH | the column is nullable, renamed, and reserved for the surplus credit's entry with a pairing CHECK; the parent carries **no** binding and no generated source type (DDL spec §1.1) |
| **F4** | three operation kinds were registered with **no command routine**, which necessarily reddens `tests/security/phase3-s8-operation-kinds.test.ts` clause 1 — the same cross-phase breakage class I had correctly raised one section earlier | HIGH | the three routines are specified, in the same migration as the registration (DDL spec §5A) |
| **F6** | the void had **no idempotency**: no `invoice_void.idempotency_conflict`, and no relation held its `id` or `intent_sha256` — so the direct-void guard was specified to prove the existence of a row nothing created | HIGH | `invoice_voids` is specified (DDL spec §5.3) and the code is in the closed set. Law 7 was unmet for one of the three commands |

Smaller findings taken in the same round: the `payments` FOR UPDATE is **removed** (§8.1) and
with it a grant on an S4-owned table; `allocation_reversal.already_reversed` is now reachable
for the condition it names (§9), where a unit case had **asserted the defect** in its own
title; the date comparisons validate a canonical `YYYY-MM-DD` first (§9); and the required
wiring registry named six of ten patch requests, which its own test could not notice because
it walked the registry and checked the shape of what it found.

---

### 2B. The SECOND challenge, which found the round-4 repair itself defective

Signature 2 returned again, on round 4's own work: eight findings, one CRITICAL, and the
CRITICAL was in the repair that round 4 had just been commended for. **All eight are accepted.**
Nothing here challenges `TL-P4-S6-R1` or reopens Option B, and the central §1A.3 claim — that
the widened key restores mutual exclusion atomically with no lock taken — was measured on two
real connections and **held**.

| # | finding | severity | what changed |
|---|---|---|---|
| **F-C1** | §2A.1's backfill expression had **no bound on WHEN**, so it counted every reversal at a level `<= L` as of now. A reversed original at level `L` counted the reversal of ITSELF and stored `1` where the law says `0`; step 0c then manufactured the duplicate key that step 0d refuses, so **the migration could not apply to any tree holding a reversal** | CRITICAL | one conjunct — `AND r.created_at < a.created_at` — and **three expressions** instead of one. The two roles are separated: a write-time reconstruction for the backfill, an as-of-now recount for the verifier, with the bridge between them as a falsifiable theorem. DDL spec §2A.1, `PATCH-REQ-S6-011`. And round 4's sentence "it is the same expression the deferred verifier recomputes, so the backfill and the verifier cannot disagree" is **withdrawn**: they disagree, and structurally — the verifier is scoped to active rows and so never evaluates the row the expression gets wrong |
| **F-C2** | the concurrency model could not represent that defect: `verify` skipped every reversed row, and every row's generation was produced by `generationAt` and then checked against `generationAt` — an expression compared with itself | HIGH | the model evaluates the law on **every** row, and the law lives in `src/customer-reversal.ts` with ONE implementation. `customer-reversal-generation.test.ts` compares the specification's SQL against it, with round 4's expression kept as the planted counterpart |
| **F-C3** | round 4 made the provider key the new step 1 in three documents and in the model's own header, and **did not add it to C-6's census** — in the same commit that turned that census into an identity | HIGH | the seventh class is in `RESOURCES` and `DECLARED_ORDER`; 42 ordered arrangements, 20 cycle-capable, 20 contending without cycling. Three cases went red when the class was added. **A census is only as wide as its roster**, and the roster is the one thing no assertion in that file can check for itself |
| **F-C4** | the intent hash was specified **two incompatible ways** — this pack said request-only with no derived figure, the DDL spec said it covered the ordered set of reversed allocation ids — and the second reading made §1A.5's ordering **unsatisfiable**, because the set is read from state. Worse, a redelivery would recompute the set as empty and a correct replay would be answered `idempotency_conflict` | HIGH | resolved in favour of the principle, not the list: the intent is `payment_id`, `reversal_date`, `reason`, `provider_source`, `provider_reference`. Stated ONCE, in DDL spec §1A.3, and referred to from everywhere else. Item 4 of §7.1 below is corrected too: the id is **out** |
| **F-C5** | `LEVEL_UNIQUENESS.md` §4 claimed the cross-relation same-level race is "refused at statement time and at COMMIT". Both halves are false concurrently, by this slice's own F1 reasoning; and the model that row cited could not host the race, because every `World` row was a `payment_allocation` | HIGH | the claim is **withdrawn in place** and the seam declared open, with the condition that would close it and the fact that the routines' chain lock makes it direct-SQL-only. A `Row` now carries its relation, the index key carries it too, and C-7 proves the seam open and then proves the condition |
| **F-C6** | three generation columns were given one expression and the phrase "the mirror of it … with `>=`". The credit column's key is on the **credit**; a generation counted over the row's invoice chain is not a function of that chain, so two truthful writers at one credit remaining level compute different keys and the credit is **double-spent** | MEDIUM | all three expressions are written out (DDL spec §2A.1) and the double-spend is measured in `customer-reversal-generation.test.ts`. The `>=` flip itself was verified correct; the key was the wrong half |
| **F-C7** | the new first lock's justification was refuted by the row below it: two deliveries of one webhook are two reversals of one payment, so `daftar.payment_id` **does** serialise them | MEDIUM | the argument is replaced with the true one — one provider reference against two **different** payments, where the key converts a raw `23505` into a domain refusal decided before any state read — in §8.1, DDL spec §1A.4, `PATCH-REQ-S6-012` and the model's header. The rank is unchanged; its reason is not |
| **F-C8** | `World.insertUnique` checked only committed rows, so two equal keys inside ONE transaction were admitted by the model and refused by PostgreSQL; and `indexKeyLock` was yielded by the caller, so a case that forgot it got no exclusion and no warning | LOW | the duplicate check covers the transaction's own buffer, and the scheduler installs a lock probe so a forgotten `indexKeyLock` is reported as a **model defect** and never as a business outcome. Both have cases |

**The lesson round 4 is charged with, and it is the right charge.** Round 4 added about 150
lines of §2A prose, disclosed honestly that neither upgrade path could prove the backfill — and
shipped an expression that was wrong. The generation law is a **pure function** of a level and a
reversal sequence: it needed no server, no cluster and no migration to be checked, and it was not
checked. **A disclosure that a proof is owed is not a substitute for the cheap proof that was
available.** `packages/inventory/test/customer-reversal-generation.test.ts` is that proof, 29
cases, written in this round and owed in the last one.

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

**The one coordination question in this pack is now SETTLED, from the tree and not by
preference.** It was: whether S5's refund reversal (if S5 ships one) and S6's allocation
reversal share one `allocation_reversals` relation or two. `docs/PHASE_4_S5_PREPARATION.md`
§7 does not mention a reversal, and `docs/PHASE_4_EXECUTION_PLAN.md:194-196` assigns **both**
`payment_reversals` and `allocation_reversals` to S6 while giving S5 only `credit_notes`,
`credit_note_items` and `refunds`.

> **Ruling (coordinator, from the execution plan): S6 owns both `payment_reversals` and
> `allocation_reversals`. S5 owns `credit_notes`, `credit_note_items` and `refunds` and no
> reversal relation.** The S5 owner has been told the same, so this pack treats it as settled
> and specifies **one** `allocation_reversals`, S6's, covering every settlement reducer kind
> including any S5 reducer that lands on the invoice chain (assumption S5-2).

The consequence for S5-7 and S5-8 is unchanged: S5 still registers its own source types and
still adds no `reversed` column, because the reversal **relation** being S6's is what makes
both of those true rather than a second mechanism.

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
| `supplier_credit_allocations_level_uq`, `supplier_refunds_level_uq` | the same, on frozen relations, via FORWARD DDL only | ibid. §5; awaits the promotion-time ruling `PATCH-REQ-S6-005` (supplier half only) |
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
| POST | `/v1/customer-payments/:paymentId/reversal` | `payments.reverse` | **yes** | `reversalId`, `reversalDate`, `reason`, and optionally `providerSource` + `providerReference` (both or neither — the webhook identity, §7.4) |
| POST | `/v1/settlement-reducers/:reducerId/reversal` | `payments.reverse` | **yes** | `reversalId`, `reversalDate`, `reason` |
| POST | `/v1/invoices/:invoiceId/void` | `sales.void` | **yes** | `voidId`, `voidDate`, `reason` |
| GET | `/v1/customer-payments/:paymentId/reversal` | `receivables.view` | no | — |

The provider pair is the one addition to a request since the first draft, and it is **not** a
figure: it is an identity the client does not choose, and the reason the reversal's intent hash
cannot cover the client-chosen `reversalId` (§7.4).

**No request carries an amount.** That is the exact-inverse law and the whole-payment law
expressed as absences: there is no `amountMinor`, no `releasedMinor`, no rate and no
allocation list on any request, so a client cannot ask for a partial reversal or state a
figure the original did not say.

**The read path is not optional.** The recorded lesson is the POS basket whose only readers
were its own write commands (`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts:129-136`):
state whose only reader is its command's return value has **no read path**. So the `GET`
above is part of the surface, behind the same gate as the write, with its own refusal set
(absence and authority only — it inherits none of the write's `*_inconsistent` refusals).

**Its answer is 404, and the `200 []` of the first draft was incoherent** (challenger F12).
`payment_reversals_payment_uq` makes a payment's reversal **at most one row**, and
`CustomerPaymentReversalResultDto` is a single object, so there is no collection for an empty
array to be the empty case of. A `200 []` would have been a response of a shape the contract
does not declare. The rule, stated so it cannot be read as a policy about empty collections:
**a one-or-none read of a single object answers `200 <object>` or `404`; the `200 []`
content-isolation device belongs to the LIST reads** (`01-cross-tenant.golden.test.ts:565`,
where an empty array is how a cross-business id is hidden rather than refused). Here the
cross-business id and the absent reversal both answer `404`, which is the same hiding by a
different shape (`G-02`).

**"The same projection as the write" needed a body, and now has one.** The first draft said
the read shares the write's projection and specified neither a port nor a mapping, which is
a claim with nothing behind it. The read is specified as: `ReversalDocumentPort.reversalOf
(paymentId) → PaymentReversalPlan | null`, mapped to the DTO by the **same** function the
write's response uses — one mapping body, named in the contract module, so a field that
appears on the write and not on the read is a type error rather than a discovered
inconsistency.

---

## 6. Permissions

Nothing is invented. The registry is a **closed set of twelve** (`permissions.ts:68-89`,
`P4-AL-36`) and S6 uses **THREE** keys that are already in it:

- `payments.reverse` (`permissions.ts:85`) — **SENSITIVE** (`:142`), the write;
- `sales.void` (`permissions.ts:80`) — **SENSITIVE** (`:139`), the write;
- `receivables.view` (`permissions.ts:87`) — a **read** key, not sensitive, required by the
  reversal read route of §5 (`receivables-permissions.ts:14`).

**The third was missing from this section, and the test that covers the section could not have
noticed** (challenger F13): it iterates `REVERSAL_OPERATION_AUTHORITY`, which maps the three
**write** operation codes to their keys and has no row for a read route — so the read key was
required by §5, used by no mapping and counted by nothing. The covering case in
`packages/inventory/test/customer-reversal-concurrency.test.ts`' sibling unit suite now asserts
the read key too, and asserts that it is **NOT** in `SENSITIVE_PERMISSIONS`, because a read
route that demanded a sensitive key would be a quietly different authority model.

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

**The same argument applies at the DATABASE, and the first draft of this pack made it in one
place and not the other** (challenger F4). `operationKindLaw`
(`tests/security/phase3-s8-operation-kinds.test.ts:103`) is unscoped, and its clause 1
requires **exactly one** consuming routine per registered `inventory_operation_kinds` row,
owned by `daftar_inventory_internal` with `EXECUTE` exactly `{daftar_app}`. So the three rows
and the three command routines **land in one migration or neither lands** —
`docs/PHASE_4_S6_DDL_SPECIFICATION.md` §5A names the routines. Registering the kinds alone
would have reddened an accepted suite S6 may not edit, which is the breakage class this pack
raises against `purchase_settlement_verify` one section later and had missed here.

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

### 7.4 `provider_reference` — a column S6 must CREATE, not an assumption it can record

**Measured:** `provider_reference` appears in **zero of the 87 migrations** at the base SHA. It
exists only in documents — `docs/PHASE_4_EXECUTION_PLAN.md:199`, which makes
"`provider_reference` idempotency **at the database**" an **exit condition of
`gate:phase4:s6`**, and `docs/PHASE_4_ARCHITECTURE_LOCK.md:679` and `:1342` (G-11), which
specify the mechanism and the golden.

**So it is not a predecessor assumption, and recording it as one would have been an error of
the same kind as F2.** No sealed tree will contain it and no diff can confirm it: S6 creates
the column and specifies the uniqueness, or its own gate's exit condition is unmeetable. The
S8 owner's idempotency inventory already reports the hole with the subject named as *"the
`provider_reference` column (exists nowhere)"*.

The specification is `docs/PHASE_4_S6_DDL_SPECIFICATION.md` §1A. In brief:

- **`payment_reversals` carries it, and nothing else does** — a provider originates the payment
  reversal (G-11's chargeback) and nothing else in this slice. On a child it would give one
  delivery several rows to be idempotent on, which is F3's defect in another costume.
- **`provider_source` + `provider_reference`, both nullable, both or neither** under a pairing
  CHECK. `provider_source` is trimmed text and **not** an enum: there is no provider in this
  tree (`0048:25`, `:77-78`), and naming providers that do not exist is a promise the schema
  cannot keep.
- **A PARTIAL unique index**, `WHERE provider_reference IS NOT NULL`. A plain
  `UNIQUE (business_id, provider_source, provider_reference)` would be **green and vacuous for
  every merchant-initiated reversal**, because `NULLS DISTINCT` is the default and every such
  row has a NULL reference. `NULLS NOT DISTINCT` is not proposed: nothing in this tree writes
  it (the sole mention is a comment at `0005:74`).
- **Law 7 over TWO identities.** A redelivered webhook is the same economic command with a
  **fresh** client-chosen `reversalId`. The intent hash therefore does **not** cover
  `reversalId` — a **declared departure** from `customer_collect_payment`, whose intent
  includes the id — because with the id inside the hash a correct replay would be reported as a
  changed intent. "Different id, same economic command" is made **unrepresentable** by
  `payment_reversals_payment_uq` rather than detected. **Nor does it cover the reversed
  allocation set** (F-C4): that is derived, is on no request, cannot differ for one payment under
  law 3, and including it would make the before-state ordering unsatisfiable.
- **A new FIRST lock**, `pg_advisory_xact_lock('daftar.payment_provider_reference', …)`. **Its
  reason is corrected by F-C7**: it is NOT that the key below fails to serialise two deliveries
  of one webhook — `daftar.payment_id` does serialise them, because two deliveries of one webhook
  are two reversals of one payment. What it buys is one provider reference against two
  **different** payments, where the payment keys differ and the partial unique would otherwise
  answer a raw `23505` instead of a domain refusal decided before any state read. §8.1 and DDL
  spec §1A.4 carry it.

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
| **1** | `pg_advisory_xact_lock('daftar.payment_provider_reference', hashtext(provider_source \|\| '\|' \|\| provider_reference))` | **payment reversal with a provider reference only** (§7.4). FIRST because it is the **outermost shared identity** and because the replay lookup consults it first, so a later rank would read under a key not yet held. **The reason given in round 4 is WITHDRAWN (F-C7):** it said two deliveries of one webhook carry different client ids so "the key below does not serialise them" — step 1b is `daftar.payment_id`, and two deliveries of one webhook are two reversals of ONE payment, so step 1b DOES serialise them and the second replays. What this key genuinely buys is one provider reference against two **different** payments, where it converts a raw `23505` into a domain refusal decided before any state is read. For deadlock freedom any TOTAL order would serve, and a total order is the requirement. A `hashtext` collision costs serialisation, never correctness |
| 1a | `pg_advisory_xact_lock('daftar.<reversal document>_id', <id>)` | the reversal's own id; the client-chosen idempotency key |
| 1b | `pg_advisory_xact_lock('daftar.payment_id', <payment>)` | payment reversal only, **after** steps 1 and 1a, so the three advisory classes have a fixed order. With step 2 removed, this key and `payment_reversals_payment_uq` are the whole of the per-payment serialisation |
| ~~2~~ | ~~`payments` row FOR UPDATE~~ | **REMOVED** (challenger F11). It serialised nothing that step 1b and `payment_reversals_payment_uq` do not already: the advisory `daftar.payment_id` key makes two reversals of one payment serial, and the unique key makes the second **unrepresentable**. It bought that nothing with a `GRANT UPDATE (<placeholder>)` on an **S4-owned** table — a grant argument for a lock nobody needed. The lock class, and with it one of the three new entries the deadlock sweep would have to cover, is gone |
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

`packages/inventory/test/customer-reversal-concurrency.test.ts`, 33 cases, green, beside
`customer-reversal-generation.test.ts`'s 29. No sleeps: every interleaving is a written-down
list of which transaction advances next, and every contender's arrival in the queue is observed
by `expectQueued`, which **fails** when a transaction never queued — two connections used in
sequence are not contention. A deadlock has its own outcome kind and nothing retries.

**What the SECOND challenge changed in the model itself**, since three of its eight findings were
about this file rather than about the design:

- the generation law is evaluated on **every** row, reversed ones included, and comes from ONE
  implementation in `src/customer-reversal.ts` rather than a private copy the verifier then
  compared with itself (F-C2);
- C-6's census covers **seven** resource classes: 42 ordered arrangements, 20 cycle-capable, 20
  contending without cycling. The provider key had been declared in three documents and left out
  of the roster (F-C3);
- a `Row` carries its **relation**, and the index key carries it too, because an index lives in
  one relation. C-7 now hosts the cross-relation same-level race the model previously could not
  express — and proves it **open** (F-C5);
- the index refuses two equal keys inside **one** transaction, and a case that forgets to take
  the index-key lock is reported as a **model defect** rather than passing silently (F-C8).

**The model implements the isolation it names, and that is new.** Each transaction's writes
are staged in its own buffer, published at commit and **discarded on refusal**; a read sees
committed state plus its own buffer; and the deferred verifier runs **inside** the committing
transaction, over what that transaction can see. The earlier revision declared READ COMMITTED
and implemented READ UNCOMMITTED with no rollback, which is why it could not see F1 (§2A).
Both mechanisms are proved load-bearing by mutation: making rollback publish instead of
discard fails cases, and making every buffer visible to everyone fails cases — including the
F1 finding itself.

| case | what it settles |
|---|---|
| C-1 | reversal vs reversal of the same tail: exactly one commits, the loser is `not_last_reducer`, the original row is still there; and the **mirror** service order gives the mirror outcome, so the result is the protocol and not the schedule |
| C-2 | reversal vs a new allocation, both orders: the allocation lands at the **freed** level while the reversed original still holds it (two rows at level 700), and the active chain is still contiguous |
| C-3 | two allocations after a reversal: both commit at **successive** levels; when only one amount is free, the loser is capped under the lock |
| C-4 | a two-chain reversal: both chain locks in ONE transaction in resource order, the reducer that is the tail on **both** chains accepted, and **three planted cases** — tail on the invoice but not the credit, tail on the credit but not the invoice, and one chain presented alone (refused by arity). Its act step was previously `() => void 0` with the credit chain never seeded, so it proved the lock order and nothing about the two-chain law (F9) |
| C-5 | a stale head: refused `settlement_changed`; with the reversal removed the same transaction commits; a **planted** variant with the recompute-under-the-lock step deleted **commits over a stale read**, which is the harm the step prevents (F10); and over **four** interleavings, no stale head commits, no deadlock occurs, and at least one interleaving is proved genuinely stale |
| C-6 | deadlock ordering over **six** resource classes — including the two advisory document keys S6 **introduces**, which the earlier sweep omitted (F7): 30 arrangements, 15 pairs, 1 share/share pair excluded **by name**. Every contending pair is **proved** to have contended; with both parties in declared order, **zero** deadlocks; and the real both-directions claim — the two parties taking a pair in **opposite** orders — gives exactly one `40P01` victim for each of the 12 cycle-capable arrangements and **zero** for the 16 that contend but cannot cycle. The earlier case normalised both parties to the declared order before running, so "both directions" exercised six arrangements twice; and it conflated contention with cycle-capability, which are not the same predicate |
| C-7 | the direct-SQL race, and **the F1 finding** (§2A): without a unique key, two direct inserts at one freed level **both commit** and the committed chain is left broken, with `verifyCommitted` throwing on it; the **level-alone** key refuses a **lawful** successor (`23505`), which is the incompatibility with no competitor present; under the **generation** key the second writer **queues on the index key** and is refused `23505`, through the contention barrier; the same key **admits** the lawful successor; a writer that **fabricates** the generation is refused by its own COMMIT; and a fabricated level the index does not cover is refused by the verifier alone |

---

## 9. Refusal codes

`REVERSAL_CODES` in `packages/inventory/src/customer-reversal.ts` — closed, sorted, held to
its own type union by the compiler. **No count is written here**: a number in prose drifts
from the array, and the array is the subject. Three were added after review:
`invoice_void.idempotency_conflict` (F6 — the void had no idempotency and no relation held its
identity), and `payment_reversal.date_invalid` / `allocation_reversal.date_invalid` /
`invoice_void.date_invalid` (the date comparison was `<` over **unvalidated** strings, so
`'2026-2-28'` — the 28th of February — passed an ordering law against an original of the 1st
of March, because by character order it is the greater). And one became reachable for the
condition it names: `allocation_reversal.already_reversed` (F7). Three namespaces: `payment_reversal.*`,
`allocation_reversal.*`, `invoice_void.*`.

The one a merchant meets most is `*.not_last_reducer` (409), which is the LIFO law and is a
real usability wall by ruling. Its details carry `reverseInThisOrder`, newest-first — the only
order the law admits — so the client can offer the next lawful step. A refusal **never**
carries an amount.

**And an exact replay is no longer answered by that code.** `allocation_reversal.already_reversed`
was unreachable for the condition it names: a replay presents a reducer that is no longer in
the active set, the tail check failed, and the answer was `not_last_reducer` — whose
`reverseInThisOrder` advice named, as the "later" reducer to reverse first, the one already
reversed. A client following the advice went in a circle. The payment command answered the
same state `payment_reversal.already_reversed` all along, so two commands answered one state
two ways, which a closed code set must not do. The membership test is the same anti-join the
chain is already built from, so no new fact was needed to fix it; the unit case that covered
it previously **asserted the defect**, with a title that said "already reversed" above an
assertion pinning `not_last_reducer`.

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
(`tests/security/p4s4-rls-quals-once-per-query.test.ts`) acquires the three new relations as
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
   changed intent → `*.idempotency_conflict`. The intent is **request-only** — the document id,
   the date, the reason and, for a payment reversal, the provider pair — so no derived figure is
   in the digest and a rate movement between retries is not a false conflict. **Corrected by
   F-C4:** the **client-chosen reversal id is NOT in the digest** (Ruling 4), and neither is the
   reversed allocation set, which is derived, is not on any request, and cannot differ for one
   payment under law 3. The one statement of the digest is DDL spec §1A.3; this bullet refers to
   it and does not restate its fields
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

### 13.1 Discovery-based laws that acquire the THREE new relations as subjects

Measured by reading the laws, not by guessing: `tests/security/phase4-forward-evolution.test.ts`
(the four forbidden claim shapes, over every suite discovered from disk);
`tests/security/p4s4-rls-quals-once-per-query.test.ts`; `tests/guards/p4s4-new-relation-coverage.test.ts`;
`tests/security/phase3-s8-grant-matrix.test.ts`' `od03Problems`, which reads **every** column
matching `(^|_)tax(_|$)` on **every** relation in `public` — so S6's relations must carry no
tax-named column at all, or carry one as a structural zero. **They carry none.**

**Three relations, not two:** `payment_reversals`, `allocation_reversals` and `invoice_voids`
(§2A, F6). And two **existing, S4-owned** relations gain a column — `chain_generation` on
`payment_allocations` and on `customer_credit_applications`, plus `credit_chain_generation` on
the latter (F1) — which puts those relations' own coverage laws in scope too:
`tests/guards/p4s4-new-relation-coverage.test.ts` and
`tests/guards/p4s4-settlement-surface-laws.test.ts` both read columns, and a slice that adds a
column to another slice's table owes that slice's laws an answer. **This is the one place S6's
DDL reaches outside its own tables**, and §14 item 4b flags it for the coordinator rather than
assuming it.

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
4. ~~**`PATCH-REQ-S6-005` ruled**~~ — **WITHDRAWN as a gate.** There is nothing to rule: the
   consumer suite computes both sides of the digest claim from live `pg_proc` and hard-codes
   none, and the tree has performed the same forward re-recording once already
   (`0067:1431-1435`). `-005` is a task inside the S6 migration, and the supplier half of
   TD-15 is specified. What remains open from that request is the **substring** hazard: three
   accepted migrations assert a substring of a refusal list, which is an assertion about the
   wording and not about the law, and the durable fix is larger than S6.
4a. **`invoice_voids` is IN SCOPE — RULED.** Law 7 forces it: a void that is a second
   statement of an existing truth is the defect. Its absence from
   `docs/PHASE_4_EXECUTION_PLAN.md`'s S6 list is a defect in that document, which the
   coordinator is correcting with a dated note, as S5's scope was corrected to four relations.
   **S6 does not edit that file.**
4c. **`provider_source` / `provider_reference` on `payment_reversals` only — RULED, as
   specified** (§7.4, DDL spec §1A), including the partial unique index and the same
   treatment for `payment_reversals_surplus_entry_uq`: a nullable key is sound only when NULL
   means *no identity to protect*, and the predicate must say so rather than leaning on
   `NULLS DISTINCT`.
4d. **The intent hash does NOT cover the client-chosen `reversalId` — RULED, with a condition
   that is now met.** The condition was to state and PROVE the replay LOOKUP, because removing
   the id from the hash means a redelivery no longer matches by id either. DDL spec §1A.5
   specifies it: the provider key first when present, `payment_reversals_payment_uq` always,
   the stored hash compared, the original row returned — and **all of it before any read of
   current state** (`[[daftar-registry-before-state]]`), so a stale redelivery arriving after
   a later transition replays instead of performing a second real change or answering a false
   `settlement_changed`. The departure from `customer_collect_payment` is recorded there with
   that mechanism named, not merely as a difference.
4b. **The `(level, generation)` widening — RULED ALLOWED, as a NEW APPEND-ONLY MIGRATION and
   never an edit.** `0080`–`0086` will be byte-immutable by S6's promotion, so the change is
   `ALTER TABLE … ADD COLUMN` plus the three wider unique indexes plus the removal of the
   narrower ones, in S6's own migration, numbered by the single migration owner at promotion.
   Raised as `PATCH-REQ-S6-011` so the CONTRACT_DIFF classifies it explicitly, and the backfill
   is specified as an **EXPRESSION** over the append-only reversal rows — see item 14a below
   for the part of that proof no migration path can make.
4e. **The new advisory rank at the head of `P4-AL-41` raised as `PATCH-REQ-S6-012`**, not
   edited. That request carries a finding of its own: **`P4-AL-41` ranks no advisory document
   key at all**, although S4 already takes two (`0081:1893`, `0081:2269`), and the static
   acquisition-order check reads **domain** acquisitions only — so it would pass a routine that
   took S6's three advisory keys in any order. Harmless until now because no accepted routine
   takes more than one; S6's payment reversal takes three in one transaction. The S4 exit sweep
   wants this before it runs.

**Then, in order:**

5. Patch requests `-001`, `-002`, `-003`, `-006`, `-009`, `-010`, `-011`, `-012` applied.

   **`-013` is NOT in that list, and that is a ruling.** It is new in round 6 and corrects a
   defect in this slice's own reasoning: OD-03 is **CLOSED** (the wire contract said "OPEN" and
   has been fixed), tax is a structural zero, and a non-zero tax must **REFUSE**. The shapes
   carry no tax field, which settles the COMPILE-time question and settles nothing at runtime —
   a JSON body carrying one meets a non-strict validator and is silently stripped, which is the
   **accept-then-ignore** the closure forbids, reached THROUGH the absence rather than through
   any line of code. **A refusal is a validator's act, not a type's silence**, now a project
   law.

   **Ruled PROSPECTIVE and NOT a live defect** (coordinator, 2026-10-07, re-verified by grep
   against `54a851c`): no customer-reversal or credit-note route exists, there is no
   `apps/api/src/modules/returns/`, `packages/shared-contracts/src/customer-reversal.ts` exists
   only in the S6 worktree, and all twelve `*.schemas.ts` under `apps/api/src` show
   `.strict()` occurrences ≥ `.object(` occurrences. **No reachable path today**, so it is
   `BLOCKED` on the slice that first ships the route and **counts against this candidate not at
   all.** It is also **not an OD-03 question** — enforcement of a closed policy is the
   coordinator's to rule, and it is ruled.

   **S6's tax position is SPECIFIED AND NOT ENFORCED**, and is counted as a proof nowhere — not
   as "specified and therefore safe", which is the error the request exists to name.
6. The S6 migration written by the migration owner to
   `docs/PHASE_4_S6_DDL_SPECIFICATION.md`, with
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §6's removal order and **a red proof per replaced
   constraint, in both directions** (the unlawful insert refused, the lawful post-reversal
   insert accepted).
7. Level F: the models of §8.3 re-expressed against a real cluster, every outcome the same,
   plus the real-database cases a model cannot reach — the deferred verifier firing at COMMIT,
   `40P01` from a planted lock-order defect, and the `provider_reference` idempotency at the
   database (`docs/PHASE_4_EXECUTION_PLAN.md:198`). **And, named separately because it is the
   one level-F case the whole level-uniqueness argument now rests on: TWO CONNECTIONS, two
   unlocked inserts at the same freed level, the second required to BLOCK on the first's index
   entry and then raise `23505`.** A single-transaction red proof cannot see a two-transaction
   race, which is how the first draft's replacement passed review (§2A, F1).

   **ROUND 6: the two-connection case is WRITTEN and has NOT BEEN RUN.** `L-F2a` of
   `tests/integration/p4s6-level-f-spec-executed.test.ts` is exactly the case this item names,
   and the blocking half is an ASSERTION and not an elapsed time: `expectBlockedOnLock` polls
   `pg_stat_activity` for the second writer to appear with `wait_event_type = 'Lock'` and
   **fails the case if it never does**, so a writer that did not queue cannot pass
   (`[[daftar-a-test-whose-verdict-is-the-machines-speed]]`). `L-F2b` is its non-vacuous
   counterpart (a successor beside its reversed original must NOT block), `L-F2c` records the
   index's stated limit (a fabricated generation escapes the index and is caught by the
   verifier, which is level E), `L-F3a`/`L-F3b` carry F-C6's credit double-spend, and `L-F4`
   measures the cross-relation seam F-C5 withdrew the false claim about. **Status: BLOCKED on a
   runner window.** Until it runs, §8.3's models remain the only concurrency evidence and are
   labelled as models, which is what they are.
8. The owed goldens: reversal and refund proven to be **two** operations by the merged-path
   red proof; a second reversal refused; the multi-currency reversal using the **original**
   snapshots; **no stale allocation after a payment reversal**.
9. The routes mounted in **both** Nest compositions, with the cross-tenant golden's
   ALLOW/DENY pairs at the API **and again at SQL**, and `200 []`-style content isolation for
   the read.
8a. **The BACKFILL EXPRESSION proved with a non-zero case, and this is owed because neither
   migration path can make it** (DDL spec §2A.2): on `check:db-from-zero` the backfill touches
   zero rows, and on the real upgrade every correct answer is also `0`, because the reversal
   relations are created empty in the same migration. So **both paths agree with `DEFAULT 0`
   by construction**, which is exactly the condition under which a wrong expression ships. The
   proof: seed a chain, reverse its tail through the command, re-run the **three** expressions,
   require `1` for a row written after the reversal at or below the freed level and `0` for the
   reversed original — **with TWO planted counterparts, both of which must FAIL that assertion:
   a constant-`0` backfill, and round 4's `<=`-without-`created_at` expression** (F-C1), which
   stores `1` on the reversed original and makes the index uncreatable. Without the counterparts
   the test passes against the defects it exists to catch. The LAW itself is already proved at
   level C — `packages/inventory/test/customer-reversal-generation.test.ts`, 29 cases, with
   every row's generation written out by hand — and what remains owed is only that PostgreSQL
   evaluates these `UPDATE`s that way over real rows.

   **ROUND 6: the suite is WRITTEN and has NOT BEEN RUN.**
   `tests/integration/p4s6-level-f-spec-executed.test.ts` carries it as cases `L-F1a`–`L-F1d`,
   with both planted counterparts this item demands: `L-F1b` is round 4's expression and
   `L-F1c` is the constant `0`, and each is required to FAIL the assertion `L-F1a` passes. The
   suite does not transcribe the SQL — it **extracts the statements from DDL spec §2A.1 and
   executes that text**, and `extractOne` reddens on a zero or multiple match, so the subject
   of the case is the specification itself and a document edited away from what is proved here
   cannot stay green. What is still outside the proof, stated rather than hidden, is that the
   eventual migration file transcribes these same statements — the migration owner's checkable
   obligation at promotion. **Status: BLOCKED on a runner window; no figure from it is claimed
   anywhere.**
8b. **The replay lookup proved, including its ORDERING** (DDL spec §1A.5): a redelivery with a
   fresh id returning the stored rows; the same provider reference against a different payment
   conflicting; a stale redelivery after a later transition replaying rather than refusing
   `settlement_changed`; and the **planted counterpart for the ordering** — a variant that
   reads state before the lookup must FAIL that last case, or the
   `[[daftar-registry-before-state]]` claim is vacuous.
9a. **The `provider_reference` idempotency proved AT THE DATABASE** (§7.4,
   `docs/PHASE_4_S6_DDL_SPECIFICATION.md` §1A) — the gate's own exit condition
   (`docs/PHASE_4_EXECUTION_PLAN.md:199`), which needs: the partial index present **and
   partial**; a redelivery with a fresh `reversalId` **replaying** rather than inserting; a
   changed economic command under one provider reference answering
   `payment_reversal.idempotency_conflict`; a merchant-initiated reversal with NULLs
   unaffected; and **two connections** delivering one webhook concurrently, with the second
   replaying rather than receiving `23505`.
8c. **The cross-relation same-level seam measured and recorded as OPEN** (F-C5,
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §4): two connections, one row per relation at one
   invoice level, both committing, with the resulting state shown to exceed the invoice's
   capacity — and the companion that the ROUTINES' chain lock closes it, so the seam is
   direct-SQL-only. The claim that the replacement closed this is **withdrawn**; what is owed is
   the measurement of the seam that remains, not a repair S6 can make.
8d. **The credit-chain generation proved to be keyed on the CREDIT** (F-C6): two applications of
   one credit at one remaining level against two different invoices, required to compute ONE key
   — with the planted invoice-keyed variant that lets both commit and spends the credit twice.
10. `P4-I` and `P4-J` calibrated and ratcheted.
11. `gate:phase4:s6` composing `s5`; `gate:phase4:s4 --structural-only` still PASS.
12. TD-15 closed **with its `TECHNICAL_DEBT.md` reference corrected**: the substantive spec is
    `ACCOUNTING_RULES.md` §5.2 + §5.4, **not** DM §7's mutable `reversed` flag, and the debt
    has **three** sources, not one (`docs/PHASE_4_ARCHITECTURE_LOCK.md:172`, `:1630`).
13. G-05, G-10 and G-11 green.

**What is missing right now, in one sentence:** everything from level F onward, because the
schema S6 binds to does not exist yet and the two documents that would tell me its final shape
are still in acceptance — and, independently of that, the supplier half of TD-15 waits on a
ruling about a digest pinned inside a frozen migration, which is a decision at promotion and
not a task, and not a blocker on the customer half.

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
