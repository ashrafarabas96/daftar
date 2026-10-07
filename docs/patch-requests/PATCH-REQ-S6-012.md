# PATCH-REQ-S6-012 — `P4-AL-41` ranks NO advisory document key, and S6 is the first command to take three in one transaction

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Raised at the coordinator's direction, and **urgent relative to the others**:
an agent is sweeping lock order against `P4-AL-41` for S4's exit and needs to know a new rank
at the head is coming.
**S6 does not edit `docs/PHASE_4_ARCHITECTURE_LOCK.md`** (§10). This is the request.

## Target file

`docs/PHASE_4_ARCHITECTURE_LOCK.md:869-885` — `P4-AL-41`, the one declared lock order for the
whole of Phase 4.

## The measured fact, and it is larger than the change S6 needs

`P4-AL-41`'s list is seven **domain row** locks:

```
1. businesses   2. customers   3. invoices   4. payments / credit_notes / customer_credits
5. stock_levels   6. installment_plans   7. invoice_sequences
```

**No advisory document key appears in it — and P4-S4 already takes two:**

| advisory class | taken by | `file:line` |
|---|---|---|
| `daftar.payment_id` | `customer_collect_payment` | `0081:1893` |
| `daftar.customer_credit_application_id` | `customer_apply_credit` | `0081:2269` |

`grep -o "daftar\.[a-z_]*"` over `0080`–`0086` returns exactly those two. So **the accepted
lock order declares no relative rank for the advisory keys it already relies on**, and the
paragraph's own account of what the static check compares — "the static acquisition-order check
reads the domain acquisitions and compares them to this list" — says why that has been
harmless: **the check reads domain acquisitions, and an advisory key is not one.** I could find
no checker in `scripts/` or `tests/` that reads an advisory acquisition against this list at
all.

**It has been harmless because no accepted routine takes more than one.** Two classes with no
declared order cannot deadlock against each other while every transaction holds at most one.

**S6's payment reversal takes three in one transaction**, which is the first time an advisory
ordering is load-bearing:

```
1.  daftar.payment_provider_reference   (when the request carries a webhook identity)
1a. daftar.payment_reversal_id          (the client-chosen reversal id)
1b. daftar.payment_id                   (the original payment — the class 0081:1893 takes)
then the domain locks of P4-AL-41, unchanged and NOT reordered
```

## Why the provider key is ranked first — WITH THE ARGUMENT CORRECTED

> **CHALLENGE FINDING F-C7, ACCEPTED. The argument this request made in round 4 was refuted by
> the row below it in this request's own table.** The request stands; the premise does not, and a
> new lock class at the head of the order, a new rank asked of the Architecture Lock and a
> `hashtext` collision surface should not be bought with a refuted one.

**The withdrawn argument.** It read: two deliveries of one webhook carry the same provider
reference and different client ids, so `daftar.payment_reversal_id` does not serialise them —
both insert and one takes a `23505` where law 7 requires an exact replay. But **step `1b` of the
block below is `daftar.payment_id`**, and two deliveries of one webhook are two reversals of ONE
PAYMENT. Step `1b` serialises them: the second waits, finds the committed row by the payment
lookup, compares the hash and replays. **The stated race cannot occur under the order this
request itself declares.**

**What the key genuinely buys.** One provider reference presented against **two different
payments** — a provider error, an event pointed at the wrong payment, a malicious resend. There
the payment keys differ, `1b` serialises nothing, both parties find no row, and the partial
unique index answers one of them a raw `23505`. Under this key the second waits, finds the row by
the provider lookup, compares the hash, finds it different, and answers
`payment_reversal.idempotency_conflict`. The outcome is a conflict either way — it IS a different
economic command — and what changes is that the conflict becomes a **domain refusal decided
before any state is read** instead of a constraint violation surfacing from storage, which §9 of
the contract pack ("one state, one code") requires.

**And why FIRST.** Because it is the outermost identity — the one a redelivery shares when
nothing else does — and because the replay lookup consults it first, so a later rank would mean
reading under a key not yet held (`[[daftar-registry-before-state]]`). For deadlock freedom any
**total** order would serve, and a total order is the requirement; the block below is a choice
among correct orders, not the only correct one.

## Required change — the exact rank, and the checker's expected new list

**Option A, recommended: give the advisory keys their own ranked block at the head, and say
that the domain list follows it.** `P4-AL-41` becomes:

```
0.  the advisory DOCUMENT keys, in this order, all exclusive pg_advisory_xact_lock:
      0a. daftar.payment_provider_reference        (P4-S6)
      0b. daftar.payment_reversal_id               (P4-S6)
      0c. daftar.customer_credit_application_id    (P4-S4, 0081:2269)
      0d. daftar.payment_id                        (P4-S4, 0081:1893)
1.  businesses        2. customers        3. invoices
4.  payments / credit_notes / customer_credits      5. stock_levels
6.  installment_plans 7. invoice_sequences — last of the domain locks (P4-AL-32)
```

The relative order **within** block 0 is a free choice for the two S4 classes (no routine takes
both) and a forced one for the three S6 classes: the shared identity first, then the document,
then the subject. `0c` before `0d` is chosen only so the list is total; any total order would
serve, and a total order is the point.

**The static check's expected new behaviour:** it must read **advisory acquisitions as well as
domain ones** — `pg_advisory_xact_lock(hashtext('daftar.<class>'), …)` with a **literal** class
string, which is how both accepted call sites are written — and compare the concatenated
sequence against block 0 followed by the domain list. Today it reads domain acquisitions only,
so **it would pass a routine that took the three S6 keys in any order at all**, which is the
gap this request is really about.

**Option B, recorded for completeness and not recommended:** declare advisory keys outside
`P4-AL-41` entirely, as `accounting_post_entry`'s internal locks already are, and give them
their own law. It is coherent — the paragraph's precedent for "not a position in this list"
exists — but it leaves S6's three keys governed by a law that does not exist yet, and it splits
one question across two documents.

## What is NOT requested

- No change to the **domain** order. S6 extends it and never reorders it; `invoices` before
  `customer_credits`, and `invoice_sequences` last, are untouched.
- No change to `P4-AL-42` (interleaving, never timing) or to
  `[[daftar-lock-order-not-retry]]`. S6 adds no retry and no `deadlock_timeout`.
- No new domain row lock. The `payments` `FOR UPDATE` an earlier S6 draft proposed has been
  **removed**: it serialised nothing that `1b` and `payment_reversals_payment_uq` do not
  already, and it would have needed a `GRANT UPDATE` on an S4-owned table to buy that nothing.

## Dependency

None on S4 or S5 sealing — this is a document change plus a checker widening, and the
**checker widening is worth doing before S4's exit sweep**, because it is the difference
between that sweep covering the advisory keys and skipping them.

## The tests that require it

`packages/inventory/test/customer-reversal-concurrency.test.ts` C-6, which now sweeps **seven**
resource classes — five exclusive, including all THREE advisory keys, and two shared: 42 ordered
arrangements, 20 contending pairs, every contending arrangement proved to have contended, zero
deadlocks when both parties use the declared order, and — the real both-directions claim —
exactly one `40P01` victim for each of the 20 cycle-capable arrangements and zero for the 20 that
contend without cycling. The counts are asserted as an **identity** over the enumeration rather
than as literals, so the sweep cannot silently cover less than it claims.

**A FINDING ABOUT THAT SWEEP, recorded rather than quietly fixed (F-C3).** In round 4 it covered
**six** classes and the provider key was not among them — declared as the new step 1 in three
documents and in that file's own header, raised in this request as one of three keys taken in one
transaction, and left out of the census, in the same commit that made the census an identity. An
identity cannot drift and it did not; what it cannot do is notice a class that was never
enumerated. **A census is only as wide as its roster**, and the roster is the one thing in that
file no assertion can check for itself. Three of C-6's cases went red the moment the class was
added, which is the machinery working.

That is the model; the database-level sweep is `gate:phase4:s8`'s, and it needs block 0 to exist
to have anything to compare against.

## Expected semantic diff

One list in one paragraph of the Architecture Lock, plus the static acquisition-order check
reading advisory acquisitions. No migration, no routine body, no relation.
