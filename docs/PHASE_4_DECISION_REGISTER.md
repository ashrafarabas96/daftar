# PHASE 4 — DECISION REGISTER AND OPERATIONS CONTRACT

> **What this document is.** The single place that states the **STATUS** of every Phase 4 decision that has
> ever been carried as open, plus the operations contract for audit and the outbox. It holds status and
> evidence; it does **not** hold ruling text. The ruling text lives in `docs/PHASE_4_ARCHITECTURE_LOCK.md`
> §22 and §25–§27 and in the slice acceptance pages, and this register links to it by line. Where this
> register and a slice report disagree about whether something is open, **this register is canonical**,
> because a slice report is a snapshot of the day it was written and a ruling made afterwards cannot reach
> back into it.
>
> **What this document is not.** It is not a plan, it does not authorize work, and it states no claim it has
> not measured. Every assertion below carries a `file:line`, and the assertions were read out of the code
> rather than out of the prose that describes it.

---

## 1. Status of every decision — the authoritative table

| decision | status | ruling | code evidence |
|---|---|---|---|
| `OD-03` — country tax rules (purchase and, from Phase 4, sales) | **OPEN. The only genuinely open item in Phase 4.** No tax law is researched and no VAT rule inferred. Sales tax is structurally zero; a non-zero tax is refused | lock `:1646` | no tax code exists on the receivables surface at all (`receivables-errors.ts:23-24` states the absence as a law) |
| `OD-P4-01` | **RULED — A** | lock `:1962` | — |
| `OD-P4-02` / `OD-P4-03` — a customer credit limit, and an arbitrary price override | **RULED — A. There is NO customer credit limit in Phase 4 and NO arbitrary price override.** | lock `:1962` | measured: **zero** occurrences of `credit_limit` in `infrastructure/database/migrations/**` and zero of `price_override` as a column; the refusal vocabulary states the absence (`apps/api/src/modules/selling/selling-errors.ts:34-35`) |
| `OD-P4-04` — mid-chain reversal of an allocation | **RULED — OPTION B AUTHORIZED**: append-only negative release at the chain head, telescoping proof first, **LIFO-only as the sole fallback**. Not a blocker for S4; it is P4-S6's | lock `:1962`, `:1695` | — |
| `OD-P4-05` … `OD-P4-15` | **RULED — A** (`OD-P4-12` A measurement-triggered, `OD-P4-13` A + C) | lock `:1962-1967` | — |
| `TL-P4-S1-R2` — the general Phase-4 RLS `ENABLE`/`FORCE` discovery law | **RULED AND DISCHARGED**, by P4-S2. Phase-4 scoped **by intent**; it is not widened into a tree-wide law, which would fail accepted non-commercial relations. **NOT an open item** | lock `:2009`, `:2229-2231` | `scripts/phase4-s4-gate.ts:278-281` asserts `relrowsecurity` and `relforcerowsecurity` per discovered relation |
| `TL-P4-S1-R3` — `document_kind` / `credit_note` | **RULED.** `invoices.document_kind` stays `'invoice'`; **frozen `0075` is never edited**; no fake credit-note row; the widening is a **NEW migration in P4-S5**. **NOT an open decision** | lock `:2010`, `:2232-2234` | `0075:286-288` carries three uniques and no `document_kind` widening; nothing in `0080`/`0081` touches it |
| The cash-settled **named-customer** invoice semantic | **RULED AND BUILT.** Derived `paid = total`, `outstanding = 0`, `settlement_state = 'paid'`, while `invoices.status` stays **lifecycle-only** (`draft`/`open`/`void`) and is **NEVER** written as `'paid'`. **No longer a carried item** | lock `:2260-2266` | `0080:166-171` is the derivation; `0080:182` is the routine's own comment stating `paid = total`, `outstanding = 0`; the API refuses settling such an invoice as `invoice_settlement.cash_not_settleable` (`receivables-errors.ts`) |
| The **twelve-commit history rewrite** | **REFUSED AND CLOSED** (`TL-P4-S2-R6`). No commit is rewritten and no force-push is performed. **It is never reopened and never proposed again** | lock `:2058`, `docs/PHASE_4_S2_ACCEPTANCE.md:50` | — |
| Discount grain | **RULED — PER LINE ONLY** (`TL-P4-S3-R2`). No cart-wide or order-wide discount in Phase 4, and **no hidden proportional distribution** | lock §27 `TL-P4-S3-R2` | `sale_items` carries discount at line granularity |
| One till = one authenticated cashier | **RULED AND BUILT** | lock §27 | `0079:405` `pos_till_sessions_actor_uq UNIQUE (business_id, id, opened_by)` and `0079:427` a partial unique on `(business_id, opened_by) WHERE status = 'open'` — one open till per authenticated user, enforced by the database |
| `P4-AL-48` — the refusal half of the audit contract | **CONTRADICTION FOUND, AND RESOLVED WITHOUT WEAKENING THE LOCK.** See §2 | this register §2 | `apps/api/src/modules/audit/audit.service.ts`, `receivables-errors.ts` |
| `F-3` — does P4-AL-48 need `intent_sha256` / permission / branch in the row's own metadata? | **ANSWERED: it depends on the outcome, and the answer is decided by the jti registry.** See §3 | this register §3 | `0054:88-94`, `0054:450-451`, `0081:2170-2174` |
| `TL-P4-S5-R1` — the gate's reducer vocabulary versus `P4-AL-34` | **RULED. `P4-AL-34` is authoritative; the gate's future prediction was the defect.** A credit/return effect may reduce AR; **a refund must not reduce AR again.** Owner **`P4-S5`**. Machine enforcement **YES**. **It may not be reopened without new contradictory evidence.** The ruling text is §4 | this register §4 | `scripts/phase4-s1-gate.ts` `INVOICE_REDUCER_VOCABULARY` (no `refunds`) and `invoiceReducerProblems` (the `refund-not-a-reducer` check); red proofs `tests/guards/phase4-refund-not-a-reducer-guard.test.ts`, `tests/guards/phase4-deferred-seam-guard.test.ts` |
| Whether `invoices` gains `UNIQUE (business_id, id, customer_id)` (Departure A) | **OPEN — a widening of an accepted relation's key surface, which is a Tech Lead decision** | lock `:2298` | `0081:357`, `0081:493` are the two-column edges actually built |
| An internal/domain writer enforcing its own authority at the **application** layer | **NEW LAW — belongs to a later slice. Card in §5** | this register §5 | `audit.service.ts`, `apps/api/src/infra/database.ts:170`, `:985-992` |
| "delivery" / "log" / "adjustment" as Phase 4 vocabulary | **AMBIGUOUS IN THE LOCK, measured against the tree. Card in §6** | this register §6 | `0020:6`, `0046:131`, `0061:541`, `0061:569`, `0063:357`, lock `:464`, `:1025` |

### The four statuses that were being reported as open and are **RULED**

These four are **RULED** and must not be reported as open anywhere, in any document, report or gate message:

1. **the cash-settled named-customer invoice semantic** — derived `paid = total`, `outstanding = 0`,
   `settlement_state = 'paid'`; `invoices.status` is lifecycle-only and is never written `'paid'`;
2. **`document_kind` / `credit_note`** — `TL-P4-S1-R3`, built by a **new** migration in P4-S5; frozen `0075`
   is never edited;
3. **the general Phase-4 RLS `ENABLE`/`FORCE` discovery law** — `TL-P4-S1-R2`, **discharged in P4-S2**;
4. **the twelve-commit history rewrite** — `TL-P4-S2-R6`, **REFUSED AND CLOSED**. Never reopened, never
   proposed.

`docs/PHASE_4_S3_ACCEPTANCE.md:103-111` carried (1) as an open item and (2) under the words "Still open".
Both are corrected there by a dated forward note rather than by a rewrite of a sealed page, because a seal
page records what was true the day it was sealed and editing its body would destroy that record.

---

## 2. `P4-AL-48` — the audit/outbox contract, and the refusal contradiction

### 2.1 What the lock requires

`docs/PHASE_4_ARCHITECTURE_LOCK.md:979-983` — every Phase 4 command writes an audit row in the **same
transaction as its effect**, carrying actor, permission exercised, delegation, document UUID,
`intent_sha256`, branch, till session, and — for a **REFUSED** command — the refusal code and the figures
that caused it. *"A refusal is audited as heavily as a success, because the forged-total and over-cap
attempts are the ones worth seeing."*

### 2.2 What the code did — measured, not inferred

- **No Phase 4 module calls `AuditService` at all.** `recordTx`'s only callers are
  `catalog/media.service.ts`, `catalog/catalog.service.ts`, `admin/admin.service.ts`,
  `tenancy/structure.service.ts`, `tenancy/tenancy.service.ts`, `tenancy/invitations.service.ts` and
  `auth/auth.service.ts`. Every Phase 4 audit row is written by the SQL routine itself.
- **The routine's audit INSERT is its last step, after every refusal.** In
  `0081_phase4_customer_payments_credits.sql` there are **33** `RAISE EXCEPTION` between lines 1874 and 2128
  and the `INSERT INTO audit_events` / `INSERT INTO outbox_events` are at **2170** and **2174**; for
  `customer_apply_credit` there are **23** raises and the pair is at **2420** / **2424**.
- A `RAISE` aborts the transaction, so a row written *before* the raise would not survive either.
  **A refused customer payment therefore persisted NO audit evidence whatsoever.** Measured across a 409
  refusal: audit 8 before and 8 after; outbox 7 before and 7 after.

So `P4-AL-48`'s refusal clause was **unsatisfiable inside the transaction the lock names**. That is a real
contradiction between the Architecture Lock and the accepted exception/transaction semantics, and it is
recorded here as one.

### 2.3 The resolution — a pattern that already existed, built; not a downgrade of the lock

The contradiction is **resolved rather than declared a blocker**, because a safe, already-accepted pattern
exists in the same file and requires no change to transaction or error semantics:

`OutboxService.emit(scope, event)` (`apps/api/src/modules/audit/audit.service.ts`) opens its **own**
business-scoped `daftar_app` transaction through `this.db.withTransaction`, for post-commit flows that must
never borrow platform authority. `AuditService.recordRefusal(scope, entry)` is **that shape and no new
one**: it is called from the command's catch, **after** the business transaction has already rolled back,
and it writes the refusal row in a second committed transaction.

**Why this does not violate the atomicity invariant.** A refusal record describes an **ATTEMPT**, not an
effect. There is no effect for it to be atomic with, so there is nothing for it to be atomic *against*. The
invariant's purpose — that a change whose audit fails is a change that does not happen — is untouched.

**And the invariant's wording is corrected honestly in the same change, not left to be read as false.**
`AuditService`'s header used to say the audit is *"always written INSIDE the business transaction so the
record and its audit commit or roll back together"* — one contract stated over two different durability
guarantees. It now distinguishes them explicitly:

- **EFFECT-AUDIT — `recordTx`, same transaction, MANDATORY.** Unchanged. The only shape allowed for a
  success.
- **REFUSAL-AUDIT — `recordRefusal`, its own transaction, after the abort.** High durability, **not
  absolute**, and the document says so: if the refusal row's own transaction also fails, the merchant is
  still answered with the refusal they earned and the audit loss is reported to the process log. A
  refusal-audit failure may never become a 500, because a merchant told "internal error" for a
  `date_in_future` has been given a **worse** answer than an un-audited refusal.

That last paragraph is the honest limit of what this transaction model permits. **No document may claim
more**, and the Architecture Lock is not silently downgraded: `P4-AL-48`'s refusal clause now has an
implementation, and the clause's durability is stated exactly.

### 2.4 What was built

| file | what |
|---|---|
| `apps/api/src/modules/audit/audit.service.ts` | `AuditRefusalEntry` and `AuditService.recordRefusal(scope, entry)`; the invariant re-worded into effect-audit versus refusal-audit; a `Logger` so a lost refusal row is reported rather than swallowed silently |
| `apps/api/src/modules/receivables/receivables-errors.ts` | `ReceivablesAttempt` (what a command knows about itself by the time it is refused), `refusedCode(error)` (the stable code, or **null** when the error is not a refusal at all) and `auditThenRethrowReceivablesRefusal(...)` — classify, audit, then re-throw through the unchanged `rethrowReceivablesRefusal` |
| `apps/api/src/modules/receivables/customer-payment.service.ts` | the attempt is built **before** `run`, so a refusal raised on its first line still has a document id, an operation and the request's figures; `run` fills the intent digest and the branch as it learns them |
| `apps/api/src/modules/receivables/customer-credit-application.service.ts` | the same, for `customer.apply_credit` |

**No migration, no new role, no new grant.** `daftar_app` already holds `INSERT ON audit_events`
(`0006:79`) and the `audit_scope` policy's `WITH CHECK` admits a row of its own business (`0006:53-55`).

**An error that is not a refusal gets no refusal row.** `refusedCode` returns `null` for an infrastructure
failure, a seam defect or a bug, and nothing is written — auditing a crash as a merchant refusal is the same
lie as answering one as a 409.

**The action is `<operation>.refused`** — `customer.collect_payment.refused` beside the success's
`customer.payment_collected` — so a refusal is findable next to the success it was an attempt at and can
never be mistaken for one. `metadata.outcome` is the literal string `'refused'`.

### 2.5 What is still owed on this item

- The **POS** and **sale commit** command paths have the same structural gap and are **not** fixed here:
  they are not this agent's files. The gap is identical in shape (`0078:1002`, `0079:954`, `0079:1022` are
  all last-step audit INSERTs after their own raises) and `recordRefusal` is now available to them.
- There is **no gate** asserting that every Phase 4 command audits its refusals. Writing one would be a new
  structural law over the command surface; it belongs to the slice that owns the gate scripts, and it is
  recorded here rather than built.

---

## 3. `F-3` — answered, and the jti registry is what decides it

**The question.** Does `P4-AL-48` require `intent_sha256`, the permission exercised and the branch to be
present in the audit row's **own metadata**, or does **recoverable-by-join** satisfy it?

**The deciding input, read from the code.** `inventory_assertion_uses` stores the operation kind:

```
CREATE TABLE inventory_assertion_uses (
  jti          UUID PRIMARY KEY,
  xact         XID8 NOT NULL,
  op_code      TEXT NOT NULL REFERENCES inventory_operation_kinds (op_code),
  ...                                            -- 0054:88-94
```

**The answer is therefore split by outcome, and the split is forced rather than chosen.**

- **For a SUCCESS, recoverable-by-join SATISFIES it.** The success row carries `assertionJti`
  (`0081:2173`), which joins `inventory_assertion_uses.jti` and yields `op_code` — the permission
  exercised. `intent_sha256` is on the document row (`payments.intent_sha256`, written as `v_intent`), and
  the branch is on the invoice the allocation settles. All three are recoverable, so the lock's clause is
  met and the current success metadata (ids, never an amount) stays as it is. **No change is owed to the
  success path.**
- **For a REFUSAL, recoverable-by-join is NOT AVAILABLE AT ALL, so the row's own metadata is MANDATORY.**
  The consume's registry INSERT is `INSERT INTO inventory_assertion_uses (jti, xact, op_code, business_id)`
  at `0054:450-451` — **inside the aborted transaction**. It rolls back with everything else. So after a
  refusal there is no registry row to join to, and no document row either. Every claim `P4-AL-48` makes
  about a refusal must be carried literally.

`recordRefusal` therefore carries, in the row's own metadata: `operation` (the permission exercised),
`refusalCode`, `intentSha256`, `branchId`, `tillSessionId`, and `figures`. `entityId` is the document UUID
and `actor_user_id` is the actor.

**Two honesty notes on the figures.** Minor units are carried as **decimal strings**, never numbers — a
`bigint` amount that becomes a float on the way into JSON is not the figure that caused the refusal. And
`P4-AL-54` governs the audit row as much as the response: no account code, no journal line, no routine
name, no constraint name. **`tillSessionId` is `null` on the receivables path**, and that is the truth
rather than a gap: receivables is not a POS path, and inventing a till for it would make the dimension a
guess.

---

## 4. `TL-P4-S5-R1` — RULED. A refund does not reduce invoice AR again

**Status: RULED. Owner: `P4-S5`. Machine enforcement: YES. It may not be reopened without new
contradictory evidence.**

### 4.1 What the contradiction was

- `scripts/phase4-s1-gate.ts` declared a constant, since removed by this ruling, as *"The relations that settle an invoice: a
  payment allocation, an applied credit note, a customer credit application, **a refund** or a reversal of
  any of those"*, and its regex included `refunds`. Seam `S-P4-03` uses that set to discover the relations
  whose existence requires `invoice_outstanding` to READ them — so the accepted gate carried a FUTURE
  OBLIGATION to subtract refunds from the invoice receivable.
- `docs/PHASE_4_ARCHITECTURE_LOCK.md:738` (`P4-AL-34`) states: *"A refund does not undo a payment; it is a
  separate outward movement from a credit note or a customer credit."*

These cannot both be true.

### 4.2 The ruling

**`P4-AL-34` is authoritative. The gate's future prediction is the defect.**

The financial identity, which is the load-bearing part of this ruling: an invoice becomes a receivable, and
accepted **reducers** — payment allocation, customer-credit application, credit-note effect where
applicable — reduce that invoice receivable. A later refund does **not** reduce it a second time; it
consumes the liability or right represented by a credit note's or a customer credit's remaining value and
creates the matching **outward cash movement**. **Credit/return effect may reduce AR. Refund must not
reduce AR again.**

The reason is about the journals and not about the words: `P4-AL-34`'s own argument is that a refund (G-10)
and a reversal (G-11) have genuinely different journals, and its red proof is that *"the cash-unchanged
assertion and the cash-reversed assertion cannot both pass on one path"*. A vocabulary that puts `refunds`
on the invoice-reduction chain is exactly the collapse that proof exists to prevent.

### 4.3 What was built, and where

A narrow correction to the already-accepted P4-S1 gate was authorized and made. No other P4-S1 rule was
changed, no threshold or count was relaxed, and the predecessor gates stay green.

1. **`refunds` is removed** from the set `S-P4-03` uses to discover relations whose existence
   `invoice_outstanding` must reflect.
2. **The concept is restated, not just de-tokenised.** The constant is now
   `INVOICE_REDUCER_VOCABULARY`, documented as *the Phase-4 relations whose financial existence can change
   the derived invoice receivable/outstanding, with a cash refund intentionally excluded because it settles
   a credit-note/customer-credit liability and must not reduce invoice AR again*. No sentence anywhere in
   the gate, its guards or this register now says that a refund settles an invoice.
3. **A permanent negative proof**, `invoiceReducerProblems` — the gate check `refund-not-a-reducer`. It
   reads the **executable SQL body** of every routine the Phase 4 DDL defines whose name the receivable
   reader vocabulary matches (today `invoice_outstanding`, `invoice_settlement_state`,
   `customer_ar_outstanding`, `customer_ar_aging`, all **discovered**), and refuses any refund relation
   named in one. Prose is not the subject: every body arrives through `phase4Sql`, which applies the gate's
   `stripSql` first, and the check **asserts** that precondition rather than assuming it, so a comment
   mentioning `refunds` can neither satisfy nor fail the law.
4. **Red proofs, all four directions the ruling required**, in
   `tests/guards/phase4-refund-not-a-reducer-guard.test.ts` (`RP-REFUND-AR`) and
   `tests/guards/phase4-deferred-seam-guard.test.ts` (`RP-SEAM`). Every plant is a COPY of the migrations
   directory; nothing is written into `infrastructure/database/migrations/**`.
   - **A — a future real reducer.** A synthetic `invoice_write_offs` lands with reducer semantics and the
     reader does not account for it: `S-P4-03` goes RED and names it.
   - **B — a refund.** `refunds` lands as P4-S5 will design it (paid out of a credit, naming no invoice):
     `S-P4-03` stays silent, and the same tree with a real future reducer added does speak, so the silence
     is about the refund and not about a plant the seam never saw.
   - **C — a fake refund read.** A direct `refunds` subtraction planted into `invoice_outstanding` goes
     RED; so does a renamed refund relation, a dead `LEFT JOIN … ON FALSE` reference, and a refund read in
     a receivable reader other than `invoice_outstanding`. The same text with the read **commented out** is
     green, and the same defect with the read commented out is **not** accepted as a fix.
   - **D — the stripper.** The S-P4-03 red proof builds its stripper **from the discovered reducer set**
     (commit `479110f`); that approach is **accepted and may not be reverted**. It is now also asserted
     from outside the proof that relies on it: every TRUE reducer the tree creates is verified to have lost
     its read in the planted copy, while the relations themselves still exist, so the seam keeps its
     subject.

### 4.4 What is OWED BY THE P4-S5 IMPLEMENTATION, and the measured reason

**Owed: the live financial double-reduction test.** Open a credit invoice; make the accepted
return/credit-note effect; verify AR falls **exactly once**; refund the resulting liability; verify the
invoice outstanding does **not** fall again; verify that cash and the liability **do** move.

**It is not built, and it is not stubbed.** The measured reason is that three relations it needs do not
exist at any prefix in `infrastructure/database/migrations/**`:

| relation | measured state |
|---|---|
| `refunds` | **absent** — no `CREATE TABLE refunds` in any migration `0000`–`0082` |
| `credit_notes` | **absent** — no `CREATE TABLE credit_notes` in any migration `0000`–`0082` |
| `credit_note_applications` | **absent** — no `CREATE TABLE credit_note_applications` in any migration `0000`–`0082` |

(`customer_credits` and `customer_credit_applications` **do** exist, in `0081`; the credit-note half of the
identity does not.) A test written against relations the test itself created would prove the fixture and
not the system, so it is recorded here as owed rather than written. Items 1–4 of §4.3 are textual and
planted-copy laws and are built **now**, by the same technique the existing deferred-seam red proofs use.

### 4.5 Explicitly refused ways to make the gate green

Adding a comment to `invoice_outstanding`; adding a dead SQL reference; renaming `refunds` to escape the
vocabulary; making `invoice_outstanding` read refunds; special-casing a test to green. Each of the first
three is planted against in §4.3 item 4 (direction C) and refused.

---

## 5. CARD — the internal / domain-writer self-enforcement law

**Status: a NEW LAW. The honest answer is that it belongs to a later slice, and that is said plainly rather
than built here under cover of an existing decision.**

### 5.1 The law

An internal writer enforces **its own** authority rather than trusting its caller. A routine or service that
runs with more authority than its caller must establish that authority **itself**, as the first thing it
does, because a writer that trusts a handed-in capability is a writer anybody holding that capability can
drive.

### 5.2 Where it IS self-enforcing today — the SQL layer

The SQL half of this law is fully self-enforcing and should not be touched:

- the static half is `scripts/guards/inventory-writer-authority.ts` ("Rule 22"), run from
  `scripts/static-guards.ts:654-658`. It derives the watched table set from the tree
  (`truthTables()`, `inventory-writer-authority.ts:108-137`: every table a post-prefix migration grants
  `INSERT`/`UPDATE`/`DELETE` to `daftar_inventory_internal`) rather than from a handwritten list, and
  requires the **first statement after `BEGIN`** to be exactly one `inventory_assertion_consume(` /
  `inventory_assertion_current(` call whose arguments call only pure functions;
- it already covers the P4-S4 relations, because `0081:616-617` grants the inventory principal
  `INSERT`/`UPDATE` on `payments`, `payment_allocations`, `customer_credits` and
  `customer_credit_applications`, so they enter the truth set the day their grant is written;
- the exemplar is `customer_credit_consume` (`0081:1224-1252`): its first statement is
  `inventory_assertion_current(ARRAY['customer.apply_credit'])`, and it then refuses unless the application
  row it is decrementing for was stored **by this transaction**;
- the live half is the PM-44 catalogue sweep, and `tests/integration/phase3-s8-guards.test.ts:419-500`
  carries the planted red proofs.

### 5.3 What is UNENFORCED today — the application layer, with file:line

The **TypeScript** internal writers are not self-enforcing, and the estate already contains the pattern that
would make them so, which is what makes this a real gap rather than a style preference.

**The pattern that exists.** `apps/api/src/infra/database.ts:170` keeps
`const postingTransactions = new WeakMap<object, TransactionSql>()`, populated only by a transaction
boundary (`:201`), and `issuedPostingSql` (`:985-992`) refuses any transaction object that was not issued by
one:

```
throw new TransactionSeamError('seam.not_a_posting_transaction',
  'the accounting posting port accepts only a transaction opened by a posting boundary');
```

That is a writer enforcing its own authority: the caller cannot hand it an arbitrary client.

**Where the pattern is absent.**

- `AuditService.recordTx(client, entry)` and `OutboxService.emitTx(client, event)`
  (`apps/api/src/modules/audit/audit.service.ts`) accept **any** `PoolClient` and write with whatever
  authority that client happens to carry. Neither establishes that the client came from an estate
  transaction boundary, and neither can tell a business-scoped `daftar_app` client from a bypass client.
- `OutboxService.emit(scope, event)` trusts the `scope` its caller hands it, with no check that the caller
  was entitled to that `(tenantId, businessId)`. `AuditService.recordRefusal` added in §2.4 is the same
  shape and inherits the same gap — stated here rather than hidden, because it is the newest instance of
  exactly the law this card is about.
- `audit_events` and `outbox_events` are **explicitly excluded** from Rule 22's truth set
  (`TRUTH_TABLE_EXCLUSIONS`, `inventory-writer-authority.ts:86`), on the stated ground that their writers
  are governed by the key-domain contract instead. So neither half of the estate's writer-authority
  machinery watches them: not Rule 22, and not a TypeScript seam check.

The practical consequence today is bounded — RLS still constrains what a `daftar_app` client can write, so
this is not a live cross-tenant hole — but the **law** is unenforced, and the next writer composed into a
process with a bypass client in scope would not be stopped by anything.

### 5.4 Options

| option | what it does | cost | risk of doing it now |
|---|---|---|---|
| **A — do nothing, record the gap** | the law stays a convention at the application layer | none | the next writer is unprotected; the gap outlives the memory of it |
| **B — brand the clients** | extend the `postingTransactions` WeakMap idea to every transaction boundary, and make `recordTx` / `emitTx` / `recordRefusal` refuse an unbranded client with a `seam.*` error | touches `infra/database.ts` (not this agent's file) and every existing `recordTx` caller across `catalog`, `admin`, `tenancy`, `auth`, `media` | **high for S4** — it is a cross-cutting change to accepted Phase 1–3 code, in a slice that owns receivables |
| **C — a static guard** | a Rule-22 analogue over TypeScript: every method taking a `PoolClient` and writing a table must have been reached from a boundary | a new guard plus its planted red proofs; needs the gate scripts, which are another owner's | medium — it is new law and new gate surface at once |
| **D — B, narrowed to the audit/outbox writers only** | brand only the audit and outbox paths | smaller, but leaves the law partial and the asymmetry undocumented | low cost, low value |

### 5.5 Recommendation

**Option A now, Option B in the slice that owns `apps/api/src/infra/database.ts`, with Option C as its red
proof.** The reasoning: this is a **new law**, not the discharge of an existing decision, and P4-S4's
mandate is receivables. Option B's correct blast radius is every `recordTx` caller in Phase 1–3 accepted
code, which no receivables slice should be rewriting; doing it here would be a cross-cutting refactor
smuggled in behind a settlement feature. Recording it with file:line, as above, is what makes it survivable
until the slice that owns the seam can take it. **It is explicitly not claimed as enforced anywhere.**

---

## 6. CARD — the ambiguous `delivery` / `log` / `adjustment` vocabulary

**Status: a documentation defect in the lock, measured against the tree. It is cheap to fix and it is fixed
in the lock in the same change as this card, except for the one part that needs a ruling.**

### 6.1 The ambiguity, precisely, from the code

**`delivery` — three unrelated senses, and the sense the lock uses has NO referent in the tree.**

- `P4-AL-49` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:987`) says *"A delivery record may not be the thing that
  proves a payment happened."* Read plainly, in a sales phase, that is a **goods delivery note** — a
  document Phase 4 does not model at all.
- The only `deliver*` relation in the whole tree is `credential_deliveries`
  (`0020_credential_delivery_outbox.sql:6`), which is **encrypted credential email**, and
  `apps/api/src/modules/delivery/**` (`smtp-delivery.ts`, `delivery-worker.service.ts`,
  `credential-enqueuer.service.ts`) is that same SMTP path.
- `OutboxService`'s own header uses a third sense: *"Delivery is at-least-once; consumers must be
  idempotent"* — the **publication of an outbox event**.

In context `P4-AL-49` means the third sense: an outbox event's publication is not evidence of a financial
fact. The sentence does not say so, and the one word reaches two real subsystems that have nothing to do
with payments.

**`log` — the word has no referent at all, and one label covers two different contracts.**

- Measured: **zero** relations in the tree match `CREATE TABLE *_log*`. There is no log table.
- `P4-AL-48`'s *"The audit is a record, never a source"* means `audit_events`; `P4-AL-49`'s subject is
  `outbox_events`.
- `inventory-writer-authority.ts:86` calls **both of them together** "the side-effect logs" — but their
  contracts differ materially: `audit_events` is append-only by trigger (`0004:18-23`) and `daftar_app`
  holds `INSERT` only (`0006:79`), while `outbox_events` is `SELECT, INSERT, UPDATE` to `daftar_app`
  (`0006:80`) because the publisher marks rows published. Treating them as one kind of thing is how an
  "append-only log" claim comes to be made about a table that is updated in normal operation.

**`adjustment` — four existing relations plus a fifth sense that is a forbidden journal shape.**

- `accounting_manual_adjustments` (`0046:131`) — a journal source identity;
- `inventory_adjustments` (`0061:541`) and `inventory_adjustment_lines` (`0061:569`) — the stock command;
- `negative_inventory_cost_adjustments` (`0063:357`) — the coverage header;
- and `P4-AL-19` (`:464`) *"no rounding-adjustment line anywhere in Phase 4"* refers to **none** of them: it
  is a journal **line shape** that is forbidden, with no relation behind it, and the lock states in the same
  decision that there is no `rounding_difference_minor` column and no `6100` line.

A reader who meets "adjustment" in a Phase 4 document cannot tell which of five things is meant, and one of
the five does not exist by design.

### 6.2 Why it matters rather than being pedantry

`P4-AL-49` is a **reconciliation** law. Its whole content is which artefacts may and may not be read as
financial evidence, and `R-SAL-01…07` are written against it. A reconciliation check written by a reader
who took "delivery record" to mean a goods delivery note would assert nothing, and would pass vacuously —
the same failure mode `TL-P4-S1-C2` found on `invoices` under `FORCE ROW LEVEL SECURITY`. The cost of the
ambiguity is a check that looks present and guards nothing.

### 6.3 Options

| option | what it does |
|---|---|
| **A — name the referent at every use** | each occurrence of the three words in `docs/PHASE_4_*.md` names its relation or its routine; "log" is replaced by `audit_events` or `outbox_events` |
| **B — a glossary section in the lock** | one table binding each word to its referents, and the uses stay as they are |
| **C — both** | A for the load-bearing decisions, B as the reference |
| **D — rename in code** | rename `credential_deliveries` or the `delivery` module — **refused**: it is accepted, frozen Phase 1 surface |

### 6.4 Recommendation, and what is done here

**Option C, with A applied only to `P4-AL-48` and `P4-AL-49`** — the two decisions whose misreading produces
a vacuous reconciliation check. The three words are **not** renamed in code (Option D is refused outright:
`credential_deliveries` is frozen Phase 1 surface and `0020` is immutable).

Applied in this change: `P4-AL-48` and `P4-AL-49` now name their relations, and the lock carries a Phase 4
vocabulary table. **Not** applied, and left for the Tech Lead: the Arabic term for the customer statement
screen, where `P4-AL-50` (`:1068-1070`) offers **two** alternatives — "سجل العميل" / "حركة العميل" — with a
slash and never says which. A localization catalogue cannot be written from a slash, the choice is a
merchant-language judgement rather than an implementation one, and `check:localization` will hold whichever
is chosen.

---

## 7. The operations contract, as it now stands

| artefact | written when | atomic with the effect? | may a reconciliation check read it? |
|---|---|---|---|
| `audit_events`, success (`recordTx`, and the routines' own INSERT at `0081:2170`/`2420`) | at the end of the business transaction | **YES — mandatory.** The audit and the effect commit or roll back together | **NO.** `P4-AL-48`: *"The audit is a record, never a source: no reconciliation check reads it"* |
| `audit_events`, refusal (`recordRefusal`) | in its **own** transaction, after the business transaction has aborted | **NO — and there is no effect for it to be atomic with.** Durability high, not absolute; a failure is logged and the merchant still gets their refusal | **NO**, for the same reason |
| `outbox_events` (`emitTx`) | in the business transaction | **YES** | **NO.** `P4-AL-49`: the outbox is not a financial source |
| `outbox_events` (`emit`) | in its own business-scoped transaction | **NO**, by design — post-commit flows | **NO** |

**No refusal emits an outbox event.** A refusal is not a business event and nothing downstream should react
to one; only the audit row records it.

---

## 8. What this register does not do

- It resolves **nothing** about `OD-03`. No tax law was researched and no VAT rule inferred.
- It does not touch `infrastructure/database/migrations/**`. `0000`–`0079` are frozen byte-for-byte and
  `0080`/`0081` are another owner's.
- It does not touch `.github/workflows/ci.yml` or `tests/performance/**`. It no longer claims to touch no
  gate script: `TL-P4-S5-R1` (§4) is a Tech-Lead-authorized narrow correction to `scripts/phase4-s1-gate.ts`
  and was made, and the earlier wording of this bullet — written while §4 was still an unresolved
  contradiction — is superseded by it. No other P4-S1 rule was changed.
- It claims no gate and no test it did not run.
