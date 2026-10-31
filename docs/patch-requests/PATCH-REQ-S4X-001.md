# PATCH-REQ-S4X-001 — P4-AL-41's declared lock order ranks `customers` before `invoices`, and no command in the tree does

- **Raised by:** `p4s4c/exit-criteria` (P4-S4 exit-criteria stream)
- **Target file:** `docs/PHASE_4_ARCHITECTURE_LOCK.md`, `P4-AL-41`, the numbered list at lines 869–885
- **Status:** OPEN — documentary correction, owner's edit

---

## Required change

Swap ranks 2 and 3 of the declared order, so that `invoices` precedes `customers`:

```
1. businesses      (the scope row, shared)
2. invoices        — ascending by `id` where several are touched
3. customers       — the customer whose balance is affected
4. payments / credit_notes / customer_credits (the consumed source)
5. stock_levels    — ascending by (warehouse_id, variant_id)
6. installment_plans
7. invoice_sequences — last of the domain locks (P4-AL-32)
```

Two further corrections belong with it:

- **`customer_apply_credit` takes the consumed source BEFORE `customers`.** After the swap
  its order reads `invoices` (2) → `customer_credits` (4) → `customers` (3), which still
  inverts 3/4. Either the list must rank the consumed source above `customers`, or
  `P4-AL-41` must state that `customers` is acquired last among the three — the latter is
  what BOTH settlement routines actually do, so the honest list is
  `invoices` → consumed source → `customers`.
- **`sale_commit` row-locks neither `businesses` nor `customers`,** so the list should say
  which of its entries are row locks. `0078:649-667` is explicit that both are READ
  UNLOCKED on purpose — a locking clause requires `UPDATE` on the relation, and granting
  the inventory writer `UPDATE` on `businesses` is a larger authority than the lock is
  worth — and the customer takes a **shared advisory** lock on `daftar.customer_id`
  (`0078:674`) instead. An advisory lock conflicts only with other advisory locks on the
  same key, so it is not a position in a row-lock order at all.

## Reason

The lock declares ONE order for the whole of Phase 4 and says a static check compares each
routine's acquisition sequence against it. The live routines disagree with the list on the
`customers`/`invoices` pair, and the **routines are right**.

Deadlock freedom requires a single consistent order across every lock-taking command, not
a particular order. The discriminating question is therefore empirical, and the sweep (the
full table is in this stream's report) answers it: **no Phase 4 lock-taking command
acquires a `customers` row lock before an `invoices` row lock.** Both settlement routines
take `invoices FOR UPDATE` first; `sale_commit` row-locks neither. There is therefore no
cycle to break, and no deadlock pair exists for the declared order to prevent.

Three further facts close the alternative (changing the migration):

1. **There is no exclusive row-lock holder on either table to deadlock against.** The tree
   contains no `UPDATE customers` and no `UPDATE invoices` DML anywhere — invoice status
   transitions are refused by the `0075:585` trigger and the outstanding figure is derived
   (`P4-AL-06`). Every row lock on these two tables is one of the settlement routines' own,
   plus the `FOR KEY SHARE` the FKs take, and `FOR SHARE` does not conflict with
   `FOR KEY SHARE`.
2. **`FOR SHARE` is not dismissed.** A shared lock taken after an exclusive lock on a
   higher-ranked resource does invert the order and can deadlock — but only against a
   transaction taking them in the declared order, and there is none. The inversion is real
   and harmless *because the declared order has no adherents*, which is precisely why the
   document and not the code is the defect.
3. **The routines' order is the better one on its merits.** `invoices FOR UPDATE` is the
   CAP LOCK: the outstanding is re-read under it and a stale figure is `settlement_changed`.
   It must also cover the whole invoice set in ascending `id` order for a multi-invoice
   allocation to be safe. Taking a weaker `customers FOR SHARE` first would widen the
   window in which the invoice set can change while protecting only a status read.

Changing the migration would mean rewriting both settlement routines to acquire `customers`
first — new risk, no cycle removed, and the cap lock weakened.

## The test that requires it

No test requires the swap, and that is itself the finding: **the static check P4-AL-41
promises does not exist** (see `PATCH-REQ-S4X-003`). Nothing in the tree reads a routine's
acquisition sequence and compares it against this list, which is why a standing inversion
between the lock and both settlement routines survived to acceptance.

Once `PATCH-REQ-S4X-003`'s check exists, it is what requires this change: over the live
tree it reports `customer_collect_payment` and `customer_apply_credit` as inverted against
the list as written, and reports nothing once the list is corrected.

## Expected semantic diff

The declared order stops describing an order no command takes and starts describing the one
every command takes. No routine body changes; no migration is written. The claim
"one declared lock order for the whole of Phase 4" becomes true of the tree for the first
time, and the `gate:phase4:s8` pair-runner (`P4-AL-41`'s dynamic half) gains a list that
agrees with the bodies it will be run against.

**No law is weakened.** The requirement is still exactly one total order obeyed by every
lock-taking command; only the order's text changes, to the one the code already obeys.
