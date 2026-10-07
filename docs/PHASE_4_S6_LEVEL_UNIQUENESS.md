# P4-S6 — LEVEL UNIQUENESS: THE CONSTRAINT-BY-CONSTRAINT REPLACEMENT

**Base SHA: `6587460ba3632231e4324c5ce2af92e1589d0705`** (`phase/4-sales-pos-customers-receivables`).
Branch `p4s6/owner`. **Status: SPECIFICATION ONLY** — levels A–E. No `.sql` file, no
migration number, no edit to `infrastructure/database/**`.

Every `file:line` below is a read of the live tree at that SHA. Where this document and
the code disagree, **the code is the fact**.

---

## 0. The constraints, ENUMERATED FROM THE LIVE DDL

Not from a brief, not from `P4-AL-22`, and not from `docs/PHASE_4_S5_PREPARATION.md` §4 —
from `grep -rn "_level_uq" infrastructure/database/`. The result is **five**, and the
enumeration contradicts two documents that name the subject:

| # | constraint | relation | definition | created by | frozen? |
|---|---|---|---|---|---|
| L1 | `payment_allocations_level_uq` | `payment_allocations` | `UNIQUE (business_id, invoice_id, ar_released_before_txn_minor)` | `0081:334` | **no** — S4 candidate |
| L2 | `customer_credit_applications_level_uq` | `customer_credit_applications` | `UNIQUE (business_id, credit_id, credit_remaining_before_minor)` | `0081:470` | **no** — S4 candidate |
| L3 | `customer_credit_applications_invoice_level_uq` | `customer_credit_applications` | `UNIQUE (business_id, invoice_id, ar_released_before_txn_minor)` | `0081:474` | **no** — S4 candidate |
| L4 | `supplier_credit_allocations_level_uq` | `supplier_credit_allocations` | `UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)` | `0067:438` | **YES** — frozen Phase 3 |
| L5 | `supplier_refunds_level_uq` | `supplier_refunds` | `UNIQUE (business_id, credit_note_id, credit_remaining_before_minor)` | `0067:491` | **YES** — frozen Phase 3 |

**Two corrections the enumeration forces.**

1. **`P4-AL-22` (`docs/PHASE_4_ARCHITECTURE_LOCK.md:509-511`) names only L4 and L5** —
   "The accepted level-uniqueness constraints are … (`0067:438`) and `supplier_refunds_level_uq`
   (`0067:491`)". It was written before `0081` existed and is correct for its moment; the
   live count is five, and this table is the current enumeration. The lock is not edited
   here (it is not S6's file); `PATCH-REQ-S6-007` carries the correction.
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
`expect(w.rows.get(CHAIN)!.filter((r) => r.level === 700n).length).toBe(2)`.

---

## 2. L1 — `payment_allocations_level_uq`

| field | statement |
|---|---|
| **current purpose** | Make two payment allocations computed from the same AR chain position of one invoice a database refusal rather than a discovered inconsistency. It turns the same-level race into a unique violation (`0081:327-333`; the golden names it at `tests/golden-regression/phase4-s4/09-settlement-last-amount-race.golden.test.ts:40-47`). |
| **why incompatible** | §1. The reversed original keeps level `X`; the next lawful allocation is computed at `X`; the constraint refuses it. There is no column that could distinguish them, because the original is immutable. |
| **replacement protection** | **(a)** `payment_allocation_active_level_guard()`, a `BEFORE INSERT` trigger that refuses an insert whose `(invoice_id, ar_released_before_txn_minor)` is already occupied by an **ACTIVE** row **in either reducer relation** — refusal `invoice_settlement.active_level_occupied`. **(b)** `invoice_settlement_verify` widened to chain over the **ACTIVE** subset. **(c)** the canonical source lock, unchanged. |
| **why the replacement is STRONGER, not merely different** | The constraint was **per-relation**; the guard is **cross-relation**. `0081:330-332` records the exact gap it leaves — "a UNIQUE index cannot see across `payment_allocations` and `customer_credit_applications`, which can each occupy the same level". The replacement closes that gap in the same change that opens the reversal case. It is also strictly narrower in what it refuses: the constraint refused a lawful post-reversal insert, the guard does not. |
| **canonical source lock** | `invoices` row `FOR UPDATE`, taken in id order — step 2a of the declared S4 lock order (`0081:1761`, `:1987`) and step 3 of S6's (contract pack §8). It is the cap lock, and the chain is read **only** after it is held. A reversal takes the same lock on the same row, so a reversal and an allocation on one invoice serialise. |
| **deferred verifier** | `invoice_settlement_verify(uuid,uuid)` (`0081:691`), replaced by its owner with the reducer `UNION ALL` (`:739-748`) anti-joined against `allocation_reversals`, and one new branch per reversal relation — the extension `0081:736-738` anticipates in its own words. The verifier already catches a same-level duplicate: two active rows at one level make `h.x <> h.before` for one of them (`:751`), so it refuses the overlap the constraint refused **and** the gap the constraint never saw. It fires from `CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on each reducer relation (`0081:1279-1291`), so it is reached with no routine in the path. |
| **direct-SQL enforcement** | Both (a) and (b) are triggers on the relation, not checks inside `customer_collect_payment`. A `psql` session holding `INSERT` reaches both: (a) at statement time, (b) at COMMIT. Modelled at C-7: two direct inserts at one freed level, no lock taken by either (`expect(s.queued).toEqual([])` — with no lock there is no contention, so the protection *cannot* be a lock), and at least one is refused `invoice_settlement.settlement_inconsistent` at COMMIT. Its non-vacuity proof sits beside it: a **single** direct insert at the freed level is ACCEPTED, so the verifier refuses the overlap and not the level. |
| **race proof** | C-1, C-2, C-3 of the concurrency models, each interleaving written down and each contender's arrival in the queue observed by `expectQueued` before the next step. C-3: two allocations racing for one freed level both commit, at **successive** levels `700` then `800`, because each computes its level after taking the chain lock; and when only `300` is free, the loser is refused `customer_payment.amount_exceeds_outstanding` rather than over-allocating. |

---

## 3. L2 — `customer_credit_applications_level_uq` (the CREDIT chain)

| field | statement |
|---|---|
| **current purpose** | The credit-side level uniqueness, `0067:435` exactly (`0081:469`): two applications computed from the same `credit_remaining_before_minor` of one credit cannot both exist. |
| **why incompatible** | The same mechanism on the descending chain. `credit_remaining_before_minor` descends from `customer_credits.original_amount_minor`; reversing the last consumer frees that remaining level, and the next lawful application is computed at exactly it, while the reversed original still holds it. |
| **a second reason, specific to this constraint** | The credit's remaining pair is the ONE mutable thing in `0081` and moves only through `customer_credit_consume` (R-90, `0081:1224`). A reversal must move it **back up** — which is a *restoration of a stored fact of the source document*, not a recomputation of financial history, and `customer_credit_guard()` (`0081:1070`) refuses any decrement it does not recognise. So this constraint's replacement is paired with the widening of that guard and of `customer_credit_consume` to admit the one upward move a reversal makes. That widening is in `docs/PHASE_4_S6_DDL_SPECIFICATION.md` §4 and is **not** a second writer: it is the same single writer, given one more lawful transition. |
| **replacement protection** | **(a)** `credit_application_active_level_guard()`, `BEFORE INSERT`, refusing an insert whose `(credit_id, credit_remaining_before_minor)` is occupied by an ACTIVE row — `customer_credit.active_level_occupied`. **(b)** `customer_credit_verify` (`0081:879`) widened to the ACTIVE subset, asserting `Σ consumed over ACTIVE = original − remaining` and the descending chain's contiguity. **(c)** the canonical source lock, unchanged. |
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
| **replacement protection** | **The SAME guard as L1, not a second one.** `(invoice_id, ar_released_before_txn_minor)` is one key on one chain, and the guard that enforces it must see both relations — which is precisely the cross-relation gap `0081:330` records. So L1 and L3 are replaced by **one** `AFTER INSERT`-ordering-independent `BEFORE INSERT` body, installed as a trigger on **both** relations. One body, two triggers: a second body would be a second statement of one law and the two would drift. |
| **why this is the pair's real improvement** | Before the replacement, two rows at one invoice level — one in each relation — are refused by **neither** constraint and caught only at COMMIT. After it, they are refused at statement time **and** at COMMIT. The replacement therefore removes a known hole while removing the constraints. |
| **canonical source lock** | `invoices` row `FOR UPDATE` — the same lock as L1. A credit application and a payment allocation on one invoice already serialise on it today (`0081:2299` and `:1987` lock the same row), and a reversal joins that queue. |
| **deferred verifier** | `invoice_settlement_verify`, the same widened body as L1. |
| **direct-SQL enforcement** | The shared guard is installed on `customer_credit_applications` too, so a direct insert into either relation meets it. The migration asserts the trigger exists on **both** relations from `pg_trigger`, and asserts both point at the **same** `tgfoid` — the one-body claim made catalogue-checkable rather than stated. |
| **race proof** | C-1 … C-4. The two-relation case is the one the old constraints could not express, and the model's chain is a UNION over both relation kinds (`ActiveReducer.kind`), so a credit application and a payment allocation compete on one chain in the same scheduler. |

---

## 5. L4 and L5 — the two FROZEN supplier constraints, and the honest blocker

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

### 5.2 The real blocker, measured, and it is NOT the constraint

**`purchase_settlement_verify(uuid,uuid)`'s `prosrc` SHA-256 is PINNED INSIDE FROZEN `0067`.**

`supplier_settlement_guard_gaps()` (`0067:1795`) carries `c_digest`, a JSONB of the SHA-256
of each S6-era guard, helper and arithmetic function's `prosrc` "recorded at migration time
(0067)". `purchase_settlement_verify(uuid,uuid)` is row 15 of its discovery table
(`0067:1829`) and its digest is `4fcbb793…` (`0067:1817`). The function is a **reporting**
set-returning function, and its consumer is `tests/security/settlement-s6-guard-gaps.test.ts`
— an **existing Phase 3 suite**, which S6 may not edit.

So:

> **Widening `purchase_settlement_verify` to chain over an ACTIVE subset changes its `prosrc`,
> which makes a digest pinned inside a frozen migration read false, which turns an accepted
> Phase 3 security suite RED.**

This is the same class of cross-phase surface `0081:55-67` (R-85) discloses for Departure B
and resolves the same way: it is **DISCLOSED, not worked around**. It is recorded as
`PATCH-REQ-S6-005` and it needs a Tech Lead ruling, because the only three ways through it
are each a decision above this slice: (i) re-record the digest in the S6 migration with the
probe ritual, (ii) re-express the Phase 3 suite to scope its digest claim to the Phase 3
prefix — the device `docs/PHASE_4_S5_PREPARATION.md` §0 item 3 records being applied to
`settlement-s6-no-customer-payments.test.ts`, or (iii) add the active-subset branch in a
**new** verifier composed beside the pinned one, which risks a second statement of the chain
law and is the option this document likes least.

**Consequence for S6's scope, stated plainly.** The supplier **payment** half of TD-15 is
unblocked (§0 correction 2: `supplier_payment_allocations` has no level constraint, and
`purchase_settlement_verify`'s widening is still needed for the ACTIVE subset — so even that
half meets this blocker). **No supplier-side reversal is specified past level E in this pack,
and `READY_TO_PROMOTE = NO` carries this as its first missing item.**

### 5.3 What is NOT proposed for L4 and L5

- Not a `NULLS NOT DISTINCT` rewrite. This tree never writes it; the sole mention is a
  comment at `0005:74` (`docs/PHASE_4_S5_PREPARATION.md` §4.2).
- Not an edit to `0067`, `0068` or any file numbered `0000`–`0079`.
- Not a replacement landed before the ruling of §5.2. A constraint is removed only once a
  stronger or equivalent protection exists, and a protection whose verifier cannot be
  widened does not yet exist.

---

## 6. The removal order, which is the part a migration gets wrong

For each of L1, L2, L3 (and, after the §5.2 ruling, L4 and L5), **in one migration, in this
order**:

1. `CREATE OR REPLACE` the shared `BEFORE INSERT` active-level guard body.
2. `CREATE TRIGGER` it on every reducer relation of the chain.
3. `CREATE OR REPLACE` the deferred verifier over the ACTIVE subset.
4. **Assert from the LIVE CATALOGUE** — `pg_trigger`, `pg_proc`, not this file's own
   statements — that (1)–(3) exist, are enabled (`tgenabled = 'O'`), are plain
   (`tgqual IS NULL`), that the constraint triggers are `DEFERRABLE INITIALLY DEFERRED`, and
   that the two triggers of the shared guard point at **one** `tgfoid`. The `0081:2490`
   end-state device: "a migration that asserts what it just wrote asserts nothing; every
   claim is a catalogue read."
5. **Only then** `ALTER TABLE … DROP CONSTRAINT`.
6. Assert from `pg_constraint` that the dropped names are gone **and** that step 4's subjects
   are still there — so a migration cannot drop the constraint and lose the replacement in one
   transaction that half-succeeded.

**A red proof per constraint, not one for the set.** For each replaced constraint, one test
plants a direct-SQL insert that the dropped constraint would have refused and requires the
replacement to refuse it; and one test plants the **lawful** post-reversal insert at the
freed level and requires it to be **accepted**. Without the second, a replacement that
refused everything would pass the first while being useless — and a green that cannot be red
is the defect `[[daftar-a-green-gate-must-prove-it-can-be-red]]` names.

---

## 7. What this document does not do

- It does not drop, alter or create anything: it is a specification, and §6 is an order of
  operations for a migration S6 does not own and whose number is unknown.
- It does not reopen `OD-P4-04`. There is no signed-negative reducer anywhere in it, and
  Option B is not modelled, compared or named as an alternative (`TL-P4-S6-R1`).
- It does not treat level uniqueness as sufficient. Every replacement is a triple, and §0
  quotes the two recorded lessons that say why.
- It reinterprets no inventory costing. "LIFO" throughout means the **last active settlement
  reducer**; no valuation method, FIFO or otherwise, appears in it, and no stock writer is
  named.
