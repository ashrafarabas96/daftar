# P4-S6 — LEVEL UNIQUENESS: THE CONSTRAINT-BY-CONSTRAINT REPLACEMENT

**Base SHA: `6587460ba3632231e4324c5ce2af92e1589d0705`** (`phase/4-sales-pos-customers-receivables`).
Branch `p4s6/owner`. **Status: SPECIFICATION ONLY** — levels A–E. No `.sql` file, no
migration number, no edit to `infrastructure/database/**`.

Every `file:line` below is a read of the live tree at that SHA. Where this document and
the code disagree, **the code is the fact**.

---

## 0. The constraints, ENUMERATED FROM THE LIVE DDL

Not from a brief, not from `P4-AL-22`, and not from `docs/PHASE_4_S5_PREPARATION.md` §4 —
from `grep -rn "_level_uq" infrastructure/database/`. The result is **five** occurrences, of
which **two are ACCEPTED and three are S4 CANDIDATES** (`frozenThrough` is `0079`):

| # | constraint | relation | definition | created by | accepted? | frozen? |
|---|---|---|---|---|---|---|
| L1 | `payment_allocations_level_uq` | `payment_allocations` | `UNIQUE (business_id, invoice_id, ar_released_before_txn_minor)` | `0081:334` | **no** — S4 candidate | no |
| L2 | `customer_credit_applications_level_uq` | `customer_credit_applications` | `UNIQUE (business_id, credit_id, credit_remaining_before_minor)` | `0081:470` | **no** — S4 candidate | no |
| L3 | `customer_credit_applications_invoice_level_uq` | `customer_credit_applications` | `UNIQUE (business_id, invoice_id, ar_released_before_txn_minor)` | `0081:474` | **no** — S4 candidate | no |
| L4 | `supplier_credit_allocations_level_uq` | `supplier_credit_allocations` | `UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)` | `0067:438` | **YES** | **YES** — frozen Phase 3 |
| L5 | `supplier_refunds_level_uq` | `supplier_refunds` | `UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)` | `0067:491` | **YES** | **YES** — frozen Phase 3 |

**Two things the enumeration settles, the first of them a correction to this document's own
first draft.**

1. **`P4-AL-22` is correct as written, and the earlier claim here that it was stale was my
   error.** `docs/PHASE_4_ARCHITECTURE_LOCK.md:509-511` enumerates the **accepted**
   level-uniqueness constraints — "The **accepted** level-uniqueness constraints are …
   (`0067:438`) and `supplier_refunds_level_uq` (`0067:491`)" — and that is exactly L4 and
   L5, because `frozenThrough` is `0079` and nothing in `0080`–`0086` is accepted. The same
   paragraph anticipates L1 in terms: *"Phase 4 **introduces**
   `payment_remaining_before_minor` on `payment_allocations`; it does not inherit it."*
   **The conflation was between *accepted* and *live*, and it was mine, not the lock's.**

   The table above is still the enumeration S6's replacement work needs, because the work must
   address all five — three by replacing their protection (§2–§4), two by leaving them alone
   (§5). `PATCH-REQ-S6-007` therefore no longer asks for a correction to the lock: it schedules
   the enumeration's update to **the `0081` seal commit**, which is the moment the accepted set
   actually changes, and not one commit earlier.
2. **`supplier_payment_allocations` carries NO level constraint at all.** Its uniqueness is
   `(business_id, payment_id, line_no)` and `(business_id, payment_id, purchase_id)`
   (`0067:386-387`), and over-allocation is bounded by `supplier_payments.allocation_count`
   plus the COMMIT-time `purchase_settlement_verify` (`0067:717`). `P4-AL-22:515-521` says
   so explicitly. **So TD-15's supplier PAYMENT twin is not blocked by any level
   constraint**; only the supplier credit-allocation and supplier-refund halves of TD-15 are
   (§5). That is the opposite of what a reader who expects a symmetric supplier mirror would
   assume, and it changes the shape of TD-15's closure.

**The recorded project fact, in the code's own words, which this document does not restate
as if it were news.** `0081:327-333`, at L1's own declaration:

> R-88 LEVEL UNIQUENESS. Two allocations computed from the same chain position cannot both
> exist. It is a **FAST PER-RELATION BACKSTOP and not the invariant**: a UNIQUE index cannot
> see across `payment_allocations` and `customer_credit_applications`, which can each occupy
> the same level, so the cross-relation guarantee rests on `invoice_settlement_verify`.

And `P4-AL-22:522-525`: "A `UNIQUE` over a *declared* remaining level forbids two rows
claiming the same level; **it does not cap total consumption, because a direct SQL attacker
simply declares a different level.**"

**Level uniqueness is therefore never treated below as the whole protection it replaces.**
Each replacement is specified as a *triple* — a cross-relation insert guard, the widened
deferred verifier, and the unchanged canonical source lock — because the thing being
replaced was already only one third of a protection, and a one-for-one swap would quietly
drop the other two thirds.

---

## 1. WHY all five are incompatible with reversal — the one mechanism, stated once

Under `TL-P4-S6-R1` the LIFO-only fallback is ACTIVE. So:

- the original reducer row is **immutable** and is **never deleted**;
- the reversal is a **separate append-only row** in `allocation_reversals`;
- there is **no `reversed` boolean on the original**, so "active" is not a column — it is
  the anti-join `reducer NOT IN (SELECT reducer_id FROM allocation_reversals …)`.

Put those three together and the incompatibility is arithmetic, not stylistic:

> After the tail at level `X` is reversed, level `X` is **free again on the ACTIVE chain**,
> and the next lawful reducer is computed at exactly `X`. But the original row at `X` is
> **still in the relation**. A per-relation `UNIQUE (…, X)` sees two rows at `X` and refuses
> the **second, lawful** one.

That is not a hypothetical. It is the cost `P4-AL-22:533-537` already recorded, naming the
remedy:

> Its known cost is recorded honestly: the `UNIQUE` also caps an operation that legitimately
> needs several rows at one remaining level … **a future operation that needs several rows at
> one level must change the mechanism, not drop the constraint.**

S6 is that operation. Accordingly **nothing below is a naked drop.** Each constraint is
removed only in the same migration that creates its replacement, and only after that
migration has asserted the replacement's existence **from the live catalogue** (§6).

The model of the freed level is executable and green:
`packages/inventory/test/customer-reversal-concurrency.test.ts` C-2 appends a new allocation
at the freed level `700` while the reversed original still sits at `700`, and asserts both
that two rows share the level and that the ACTIVE chain is still contiguous —
`expect(w.committedRowsOf(CHAIN).filter((r) => r.level === 700n).length).toBe(2)`.

**Read §1A before §2.** The mechanism above is correct and unchanged, but the REPLACEMENT the
first draft specified for it was not, and §1A is that correction.

---
---

## 1A. CORRECTION, AND IT IS THE MOST IMPORTANT SECTION OF THIS DOCUMENT

**The replacement this document specified in its first draft was WEAKER than the constraint it
drops, on the exact path the constraint exists for.** The finding is the independent
challenger's (F1), it is verified, it is accepted in full, and it is recorded here rather than
silently repaired because the mistake is instructive and because the first draft is already in
other agents' hands.

### 1A.1 What a `UNIQUE` index actually provides

Not a predicate. A **concurrency primitive**, and three properties at once:

| property | what it means at the index |
|---|---|
| **mutual exclusion** | the second inserter at an equal key BLOCKS on the first's uncommitted index entry until that transaction commits or aborts |
| **atomicity** | the check and the claim are the same act; there is no window between them |
| **no lock anyone takes** | it holds on the path where no routine ran, no advisory key was taken and no row was locked — the direct-SQL path |

The first draft's replacement was: a `BEFORE INSERT` trigger that **reads**, plus a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger that fires **inside the committing
transaction**, plus the canonical source lock. Under real READ COMMITTED:

> Neither device sees the other transaction's uncommitted row. Two direct `INSERT`s at the
> same freed level therefore pass the `BEFORE INSERT` read, pass their own deferred verifier
> at COMMIT, and **both commit** — two ACTIVE rows at one level, consumption past capacity,
> and no later transaction obliged to run the verifier again. The canonical source lock
> arbitrates nothing, because neither party took it.

**Law 4 was unmet.** The replacement protection was not stronger or equivalent; it was
strictly weaker, and exactly on the unlocked path.

### 1A.2 Why my own proof could not have caught it, which is the worse half

`packages/inventory/test/customer-reversal-concurrency.test.ts` declared **"READ COMMITTED
visibility. A read sees only COMMITTED state"** in its header while `World.rows` and
`World.reversed` were a shared `Map` and `Set`, written in an `act` step and visible to every
transaction immediately — **READ UNCOMMITTED**, whatever the comment said. And `finish()`
cleared the locks without touching the rows, so a **refused** transaction's inserted row
stayed in the world for ever. Both defects were load-bearing for C-7, the only model of the
direct-SQL half, and C-7's green verdict ("the deferred verifier refuses the second") was
produced by the two of them together. Its assertion was `codes.length >= 1`, which cannot
tell *the second was refused* from *both were refused* from *neither was*.

Three lessons, recorded as rules this slice now follows:

1. **A model that NAMES an isolation level must implement it.** Uncommitted writes staged per
   transaction, discarded on refusal, published on commit.
2. **A single-transaction red proof can never see a two-transaction race.** Every refusal
   device must be modelled with a second transaction that cannot see the first.
3. **When a constraint is replaced, state what it provided as a concurrency primitive** —
   mutual exclusion, visibility, atomicity — and not as a predicate a `SELECT` can compute.

The model now implements buffers, rollback and the index as a key-level exclusion; the F1
state is asserted as a **finding** in C-7's first case, and the two mechanisms are proved
load-bearing by mutation (see §1A.5).

### 1A.3 THE REPAIR — a WIDER key, not a dropped one

The level is kept in the key and a second column is added beside it: the chain's **reversal
generation**.

```
 payment_allocations_level_generation_uq
   UNIQUE (business_id, invoice_id, ar_released_before_txn_minor, chain_generation)
```

`chain_generation` is a stored column on the reducer row, and its law is:

> **gen(X) = the number of reversal rows on this chain whose freed level is ≤ X**, as of the
> moment the row is written.

Three facts make that the right column, and each is executable in the model:

- **A lawful successor no longer collides.** The reversed original at level 700 carries
  generation 0; the lawful successor at the freed 700 carries generation 1. Different keys,
  and the index never sees the activeness anti-join — which is precisely why the level-alone
  key could not be kept.
- **Two concurrent lawful writers at one level still collide.** The generation is derived from
  the **append-only reversal rows alone**, so two truthful writers at one level compute the
  **same** key. The index excludes one of them atomically, with no lock taken — the primitive
  is restored, not approximated.
- **A writer that fabricates the generation to dodge the key is refused at COMMIT.** The
  deferred verifier recomputes `gen(X)` from the reversals it can see and refuses any ACTIVE
  row whose declared generation disagrees: `invoice_settlement.settlement_generation_invalid`.
  This is the same residual `P4-AL-22:522-525` already records for the level ("a direct SQL
  attacker simply declares a different level") — it is not a new hole, and it is now covered
  rather than inherited.

**So the replacement is a QUADRUPLE, and §2, §3 and §4 are each amended by this section:**

1. the **wider UNIQUE** — the mutual exclusion, restored on the unlocked path;
2. the **statement-time insert guard** — the cross-relation read a per-relation index cannot
   make, which remains necessary and was never sufficient;
3. the **deferred chain verifier**, now also carrying the generation law;
4. the **canonical source lock**, unchanged, which is what makes two *lawful* writers agree on
   the level and the generation in the first place.

### 1A.4 And it is no longer a drop at all

The removal order of §6 changes shape with it, for the better: the wider index is **created
first**, and the narrower one dropped only after the catalogue confirms the wider exists. At
no instant is the relation without a unique key over the level, so there is no window — not
even one statement long — in which the mutual exclusion is absent. A `DROP CONSTRAINT`
followed by a `CREATE` would have had exactly that window, and the first draft's order did.

### 1A.5 The evidence, measured

- `C-7`'s first case asserts **both direct inserts commit** and that
  `verifyCommitted` then **throws** on the committed chain: the finding, as a test.
- `C-7`'s second case asserts the **level-alone** key refuses a **lawful** successor
  (`23505`), which is the incompatibility with no competitor present.
- `C-7`'s third case asserts that under the generation key the second writer **queues on the
  index key** and is refused `23505`, routed through the file's `raceProvingContention`
  barrier, so the queue is proved non-vacuous by a run with the first writer deleted.
- `C-7`'s fourth case asserts the same index **admits** the lawful successor, so it refuses
  the duplicate and not the level.
- `C-7`'s fifth case asserts the generation liar is refused by **its own** verifier.
- **Mutation evidence that the two new mechanisms are load-bearing:** making `rollback`
  publish instead of discard fails 2 cases; making a transaction see every other
  transaction's buffer (READ UNCOMMITTED) fails 2 cases, including the F1 finding itself.


## 2. L1 — `payment_allocations_level_uq`

| field | statement |
|---|---|
| **current purpose** | Make two payment allocations computed from the same AR chain position of one invoice a database refusal rather than a discovered inconsistency. It turns the same-level race into a unique violation (`0081:327-333`; the golden names it at `tests/golden-regression/phase4-s4/09-settlement-last-amount-race.golden.test.ts:40-47`). |
| **why incompatible** | §1. The reversed original keeps level `X`; the next lawful allocation is computed at `X`; the constraint refuses it. There is no column that could distinguish them, because the original is immutable. |
| **replacement protection** | **(a0) — §1A, THE DEVICE THE FIRST DRAFT LACKED —** `payment_allocations_level_generation_uq UNIQUE (business_id, invoice_id, ar_released_before_txn_minor, chain_generation)`: the level UNIQUE **widened**, never dropped without a successor, so the index keeps providing MUTUAL EXCLUSION on the unlocked path. **(a)** `payment_allocation_active_level_guard()`, a `BEFORE INSERT` trigger that refuses an insert whose `(invoice_id, ar_released_before_txn_minor)` is already occupied by an **ACTIVE** row **in either reducer relation** — refusal `invoice_settlement.active_level_occupied`. **(b)** `invoice_settlement_verify` widened to chain over the **ACTIVE** subset **and** to assert the generation law, refusing `invoice_settlement.settlement_generation_invalid`. **(c)** the canonical source lock, unchanged. |
| **why the replacement is STRONGER, not merely different** | **Read §1A first: without (a0) it was WEAKER, and that was a verified defect of this document's first draft.** With (a0) the claim holds and is now about the right property. The index's mutual exclusion is preserved: two truthful concurrent writers at one level compute one key and one of them is excluded atomically with no lock. On top of that the guard is **cross-relation** where the constraint was per-relation — `0081:330-332` records the exact gap it leaves, "a UNIQUE index cannot see across `payment_allocations` and `customer_credit_applications`, which can each occupy the same level" — so the replacement closes that known hole in the same change that opens the reversal case. And it is strictly narrower in what it refuses: the level-alone key refused the lawful post-reversal insert, the widened key admits it. |
| **canonical source lock** | `invoices` row `FOR UPDATE`, taken in id order — step 2a of the declared S4 lock order (`0081:1761`, `:1987`) and step 3 of S6's (contract pack §8). It is the cap lock, and the chain is read **only** after it is held. A reversal takes the same lock on the same row, so a reversal and an allocation on one invoice serialise. |
| **deferred verifier** | `invoice_settlement_verify(uuid,uuid)` (`0081:691`), replaced by its owner with the reducer `UNION ALL` (`:739-748`) anti-joined against `allocation_reversals`, and one new branch per reversal relation — the extension `0081:736-738` anticipates in its own words. The verifier already catches a same-level duplicate: two active rows at one level make `h.x <> h.before` for one of them (`:751`), so it refuses the overlap the constraint refused **and** the gap the constraint never saw. It fires from `CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on each reducer relation (`0081:1279-1291`), so it is reached with no routine in the path. |
| **direct-SQL enforcement** | (a0) is the index itself; (a) and (b) are triggers on the relation, not checks inside `customer_collect_payment`. A `psql` session holding `INSERT` reaches all three: (a0) when the index entry is taken, (a) at statement time, (b) at COMMIT. **The earlier claim in this row was false and is replaced:** it said two direct inserts at one freed level would see "at least one refused at COMMIT by the deferred verifier", and C-7 now asserts the opposite — without (a0) they **both commit**, because a deferred constraint trigger fires inside its own transaction and cannot see the other's uncommitted row. With (a0) the second inserter **queues on the index key** and is refused `23505`, which C-7's third case asserts through the file's contention barrier; a liar that fabricates the generation is refused `invoice_settlement.settlement_generation_invalid` by its own COMMIT; and a fabricated level the index does not cover is refused `invoice_settlement.settlement_inconsistent` by the verifier alone. The non-vacuity proofs sit beside each: a **single** lawful insert at the freed level is ACCEPTED under the same index and the same verifier. |
| **race proof** | C-1, C-2, C-3 of the concurrency models, each interleaving written down and each contender's arrival in the queue observed by `expectQueued` before the next step. C-3: two allocations racing for one freed level both commit, at **successive** levels `700` then `800`, because each computes its level after taking the chain lock; and when only `300` is free, the loser is refused `customer_payment.amount_exceeds_outstanding` rather than over-allocating. |

---

## 3. L2 — `customer_credit_applications_level_uq` (the CREDIT chain)

| field | statement |
|---|---|
| **current purpose** | The credit-side level uniqueness, `0067:435` exactly (`0081:469`): two applications computed from the same `credit_remaining_before_minor` of one credit cannot both exist. |
| **why incompatible** | The same mechanism on the descending chain. `credit_remaining_before_minor` descends from `customer_credits.original_amount_minor`; reversing the last consumer frees that remaining level, and the next lawful application is computed at exactly it, while the reversed original still holds it. |
| **a second reason, specific to this constraint** | The credit's remaining pair is the ONE mutable thing in `0081` and moves only through `customer_credit_consume` (R-90, `0081:1224`). A reversal must move it **back up** — which is a *restoration of a stored fact of the source document*, not a recomputation of financial history, and `customer_credit_guard()` (`0081:1070`) refuses any decrement it does not recognise. So this constraint's replacement is paired with the widening of that guard and of `customer_credit_consume` to admit the one upward move a reversal makes. That widening is in `docs/PHASE_4_S6_DDL_SPECIFICATION.md` §4 and is **not** a second writer: it is the same single writer, given one more lawful transition. |
| **replacement protection** | **(a0)** `customer_credit_applications_level_generation_uq UNIQUE (business_id, credit_id, credit_remaining_before_minor, credit_chain_generation)` — §1A's wider key on the DESCENDING chain, where the generation counts the reversals on that credit whose freed remaining level is **≥** the row's own (the descending mirror of `gen(X)`, converted by the same `level = original − remainingBefore` identity this slice uses everywhere so there is one predicate and not two). **(a)** `credit_application_active_level_guard()`, `BEFORE INSERT`, refusing an insert whose `(credit_id, credit_remaining_before_minor)` is occupied by an ACTIVE row — `customer_credit.active_level_occupied`. **(b)** `customer_credit_verify` (`0081:879`) widened to the ACTIVE subset, asserting `Σ consumed over ACTIVE = original − remaining`, the descending chain's contiguity **and** the generation law. **(c)** the canonical source lock, unchanged. |
| **canonical source lock** | `customer_credits` row `FOR UPDATE` — step 2a′ of the S4 order (`0081:1762`, `:2321`), step 3′ of S6's. Taken **after** the invoice lock, which is the accepted order and is not reordered. |
| **deferred verifier** | `customer_credit_verify(uuid,uuid)`, which `docs/PHASE_4_S5_PREPARATION.md` §2.3 already records S5 as widening. **S6's widening composes with S5's and does not replace it**: S5 adds the refund as a consumer, S6 adds the anti-join against the reversal relations. Two slices replacing one body is the serial-schema rule's whole point, and S6's version is written against the body S5 **seals**, not against `0081`'s. Confirming that is a diffable predecessor assumption (contract pack §3). |
| **direct-SQL enforcement** | As L1: both devices are triggers on `customer_credit_applications`. Additionally `customer_credit_guard()` is a `BEFORE UPDATE` trigger on `customer_credits` (`0081:1070`) and is, per S5's measurement, the routine that **refuses first** — before `customer_credit_consume` or `customer_credit_verify` is reached. A direct `UPDATE` restoring a remaining amount outside the reversal path is refused there. |
| **race proof** | C-4 of the concurrency models: both chain locks taken in ONE transaction in resource order (asserted sorted), and a competing single-chain writer on **either** chain queues behind it — run for both chains in a loop, so neither is the only one proved. |

---

## 4. L3 — `customer_credit_applications_invoice_level_uq` (the INVOICE chain)

| field | statement |
|---|---|
| **current purpose** | R-88 on the invoice side (`0081:471-473`), with the same declared standing: "a fast per-relation backstop whose cross-relation half is `invoice_settlement_verify`'s". |
| **why incompatible** | Identical to L1, on the same chain and the same column, in the other relation. |
| **replacement protection** | **(a0)** the invoice-side wider key on this relation too: `customer_credit_applications_invoice_level_generation_uq UNIQUE (business_id, invoice_id, ar_released_before_txn_minor, chain_generation)`, which is L1's key on L1's chain in the other relation — and, like L1's, a WIDENING and not a drop (§1A). Note what it still cannot do: a key is per-relation, so two rows at one invoice level **one in each relation** remain the index's blind spot, which is why (a) below is cross-relation and is necessary rather than ornamental. **Then the SAME guard as L1, not a second one.** `(invoice_id, ar_released_before_txn_minor)` is one key on one chain, and the guard that enforces it must see both relations — which is precisely the cross-relation gap `0081:330` records. So L1 and L3 are replaced by **one** `AFTER INSERT`-ordering-independent `BEFORE INSERT` body, installed as a trigger on **both** relations. One body, two triggers: a second body would be a second statement of one law and the two would drift. |
| **why this is the pair's real improvement** | Before the replacement, two rows at one invoice level — one in each relation — are refused by **neither** constraint and caught only at COMMIT. After it, they are refused at statement time **and** at COMMIT. The replacement therefore removes a known hole while removing the constraints. |
| **canonical source lock** | `invoices` row `FOR UPDATE` — the same lock as L1. A credit application and a payment allocation on one invoice already serialise on it today (`0081:2299` and `:1987` lock the same row), and a reversal joins that queue. |
| **deferred verifier** | `invoice_settlement_verify`, the same widened body as L1. |
| **direct-SQL enforcement** | The shared guard is installed on `customer_credit_applications` too, so a direct insert into either relation meets it. The migration asserts the trigger exists on **both** relations from `pg_trigger`, and asserts both point at the **same** `tgfoid` — the one-body claim made catalogue-checkable rather than stated. |
| **race proof** | C-1 … C-4. The two-relation case is the one the old constraints could not express, and the model's chain is a UNION over both relation kinds (`ActiveReducer.kind`), so a credit application and a payment allocation compete on one chain in the same scheduler. |

---

## 5. L4 and L5 — the two FROZEN supplier constraints, and the open ruling behind them

`supplier_credit_allocations_level_uq` (`0067:438`) and `supplier_refunds_level_uq`
(`0067:491`) are both `UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)`
over a **supplier credit note**. Both are created by **frozen** `0067`.

**They are incompatible with reversal for the same reason as L2** — a reversed last consumer
frees a remaining level that the original row still holds — and they matter to S6 because
**TD-15's debt text names three sources, not one**: "a supplier payment, credit allocation or
refund" (`TECHNICAL_DEBT.md:24`; the lock records the same correction at
`docs/PHASE_4_ARCHITECTURE_LOCK.md:172` — "the debt's own text names **three** sources").

### 5.1 Frozen does not mean unreplaceable, and this document does not pretend it does

A frozen migration is never **edited**; a forward migration may `ALTER TABLE … DROP
CONSTRAINT`. That is the accepted mechanism of the Phase 3 corrective pass — `0070`, `0072`
and `0073` each correct a frozen artefact by forward DDL while the frozen **file** stays
byte-identical. So L4 and L5 are replaced by forward DDL in the S6 migration, with the same
triple, over `supplier_credit_notes` as the canonical source lock and
`supplier_credit_note_verify(uuid,uuid)` (`0067`, registered in `supplier_settlement_guard_gaps`
at ordinal 16) as the deferred verifier.

### 5.2 The real obstacle to TD-15's supplier twin is not the constraint — and it is an open ruling, not a blocker

**`purchase_settlement_verify(uuid,uuid)`'s `prosrc` SHA-256 is PINNED INSIDE FROZEN `0067`.**

`supplier_settlement_guard_gaps()` (`0067:1795`) carries `c_digest`, a JSONB of the SHA-256
of each S6-era guard, helper and arithmetic function's `prosrc` "recorded at migration time
(0067)". `purchase_settlement_verify(uuid,uuid)` is row 15 of its discovery table
(`0067:1829`) and its digest is `4fcbb793…` (`0067:1817`). The function is a **reporting**
set-returning function, and its consumer is `tests/security/settlement-s6-guard-gaps.test.ts`
— an **existing Phase 3 suite**, which S6 may not edit.

So:

> **Widening `purchase_settlement_verify` to chain over an ACTIVE subset changes the `prosrc`
> the database then holds, so a digest recorded inside a frozen migration stops matching, and
> the accepted Phase 3 security suite that re-asserts it goes RED at that moment.**

This is the same class of cross-phase surface `0081:55-67` (R-85) discloses for Departure B
and resolves the same way: it is **DISCLOSED, not worked around**. It is recorded as
`PATCH-REQ-S6-005`.

**This document's first draft called it a blocker. That was an over-escalation of mine, and
the correction is recorded rather than quietly made.** Two facts narrow it:

- **The frozen file is not modified in any of the three paths.** The routine is replaced by
  **forward DDL**, which is already append-only. `0067` keeps its bytes, and its recorded
  digest remains a true statement about what `0067` installed.
- **The accepted *suite* is not frozen.** Byte-immutability binds the **migrations** alone; a
  suite restating a digest claim is ordinary accepted test code.

So an **append-only safe solution exists**, and the question is only which one. The three ways
through, all append-only with respect to the migrations: (i) re-record the digest **forward**
in the S6 migration with the probe ritual `0067` itself uses, (ii) re-express the Phase 3
suite to scope its digest claim to the Phase 3 prefix — the device
`docs/PHASE_4_S5_PREPARATION.md` §0 item 3 records being applied to
`settlement-s6-no-customer-payments.test.ts`, or (iii) add the active-subset branch in a
**new** verifier composed beside the pinned one, which risks a second statement of the chain
law and should be refused for that reason. It stays an **open ruling of the coordinator's**,
to be made at **S6 promotion** with the independent challenger's signature.

**The sharper hazard in the same change**, and the one worth more attention than the digest:
`0067:2790`, `0072:903` and `0077` each assert a **substring** of
`accounting_reversals_20_domain_source_guard()`'s always-refused source-type list. **An
assertion on a substring of a message is an assertion about the wording, not about the law.**
S6's widening changes that list's membership, so the S6 migration must probe what those three
assertions still match and either keep the plain arm's remaining order byte-identical or carry
the same ruling.

**Consequence for S6's scope, stated plainly.** Nothing in the **customer** half of this slice
waits on any of the above. The supplier **payment** half of TD-15 is unblocked by any
constraint (§0 item 2: `supplier_payment_allocations` has none), but every supplier half needs
`purchase_settlement_verify` widened for the ACTIVE subset and so meets this ruling. **No
supplier-side reversal is specified past level E in this pack**, and
`docs/PHASE_4_S6_CONTRACT_PACK.md` §14 item 4 carries the ruling as a promotion-time item
rather than as a blocker on this slice's work.

### 5.3 What is NOT proposed for L4 and L5

- Not a `NULLS NOT DISTINCT` rewrite. This tree never writes it; the sole mention is a
  comment at `0005:74` (`docs/PHASE_4_S5_PREPARATION.md` §4.2).
- Not an edit to `0067`, `0068` or any file numbered `0000`–`0079`.
- Not a replacement landed before the ruling of §5.2. A constraint is removed only once a
  stronger or equivalent protection exists, and the widened verifier that would be that
  protection cannot be installed until the ruling picks how its digest claim is carried
  forward.

---

## 6. The removal order, which is the part a migration gets wrong

For each of L1, L2, L3 (and, after the §5.2 ruling, L4 and L5), **in one migration, in this
order**:

0. **FIRST, the WIDER UNIQUE** (§1A): add the `chain_generation` column, backfill it (every
   existing row's generation is `0`, because no reversal exists yet — which is a fact of the
   tree and not an assumption, since `allocation_reversals` is created by this same
   migration), and `CREATE UNIQUE INDEX` / `ADD CONSTRAINT … UNIQUE` on
   `(…, level, chain_generation)`. **This step comes before everything else so that at no
   instant is the relation without a unique key over the level.** The first draft's order
   dropped the narrow key and created its replacement afterwards, which left a window — one
   statement long, and enough — with no mutual exclusion at all.
1. `CREATE OR REPLACE` the shared `BEFORE INSERT` active-level guard body.
2. `CREATE TRIGGER` it on every reducer relation of the chain.
3. `CREATE OR REPLACE` the deferred verifier over the ACTIVE subset, carrying the generation
   law.
4. **Assert from the LIVE CATALOGUE** — `pg_trigger`, `pg_proc`, not this file's own
   statements — that (1)–(3) exist, are enabled (`tgenabled = 'O'`), are plain
   (`tgqual IS NULL`), that the constraint triggers are `DEFERRABLE INITIALLY DEFERRED`, and
   that the two triggers of the shared guard point at **one** `tgfoid`. The `0081:2490`
   end-state device: "a migration that asserts what it just wrote asserts nothing; every
   claim is a catalogue read."
4a. Assert from `pg_constraint`/`pg_index` that the WIDER key of step 0 exists, is unique, and
   carries the generation column — the same catalogue-read rule as step 4.
5. **Only then** `ALTER TABLE … DROP CONSTRAINT` the narrow level-alone key.
6. Assert from `pg_constraint` that the dropped names are gone **and** that step 4's subjects
   are still there — so a migration cannot drop the constraint and lose the replacement in one
   transaction that half-succeeded.

**A red proof per constraint, not one for the set, and each with TWO transactions.** For each
replaced constraint: one test plants a direct-SQL insert that the dropped constraint would
have refused and requires the replacement to refuse it; one test plants the **lawful**
post-reversal insert at the freed level and requires it to be **accepted**; and — the one
§1A adds, and the one a single-transaction test can never make — one test runs **two
concurrent unlocked inserts at the same freed level on two connections**, with the second
required to BLOCK on the first and then raise `23505`. A single-transaction red proof cannot
see a two-transaction race, which is how the first draft's replacement passed. Without the second, a replacement that
refused everything would pass the first while being useless — and a green that cannot be red
is the defect `[[daftar-a-green-gate-must-prove-it-can-be-red]]` names.

---

## 7. What this document does not do

- It does not drop, alter or create anything: it is a specification, and §6 is an order of
  operations for a migration S6 does not own and whose number is unknown.
- It does not reopen `OD-P4-04`. There is no signed-negative reducer anywhere in it, and
  Option B is not modelled, compared or named as an alternative (`TL-P4-S6-R1`).
- It does not treat level uniqueness as sufficient. Every replacement is a **quadruple** since
  §1A — the wider key, the cross-relation insert guard, the deferred verifier and the canonical
  source lock — and §0 quotes the two recorded lessons that say why the index alone was never
  the protection. It also no longer treats the index as *insufficient in the wrong direction*:
  what the index provided was MUTUAL EXCLUSION, which no trigger can replace, and the first
  draft of this document dropped it without a successor.
- It reinterprets no inventory costing. "LIFO" throughout means the **last active settlement
  reducer**; no valuation method, FIFO or otherwise, appears in it, and no stock writer is
  named.
