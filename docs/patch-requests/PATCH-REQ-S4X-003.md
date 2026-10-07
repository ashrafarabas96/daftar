# PATCH-REQ-S4X-003 — P4-AL-41's static acquisition-order check does not exist, and the order must rank advisory keys inside ONE list

- **Raised by:** `p4s4c/exit-criteria` (P4-S4 exit-criteria stream)
- **Target files:** `docs/PHASE_4_ARCHITECTURE_LOCK.md` (`P4-AL-41`) — the ranking; and either
  `scripts/phase4-s4-gate.ts` or a new gate arm — wiring the checker into a gate
- **Status:** OPEN. The checker itself is WRITTEN and GREEN — see "What this stream already
  built" — so what is owed here is the lock's ranking text and one gate wiring line.

---

## 1. The check `P4-AL-41` promises does not exist

`P4-AL-41` states: "A static check reads each routine's acquisition sequence and compares it
against this list." Measured over the whole tree at `61677af`:

| what is there | what it actually does |
|---|---|
| `packages/domain-core/src/sale.ts:180` `SALE_COMMIT_LOCK_ORDER`, under the heading "The declared lock order (P4-AL-41)" | A frozen four-entry array with **zero consumers** — the only occurrence of the name in the tree is its own declaration. Data no check reads. It is also **inaccurate**: it names `businesses` and `customers` as acquisitions and `sale_commit` row-locks neither (`0078:649-667`). |
| `scripts/phase4-s4-gate.ts:692` `rowLockOnlyWriteProblems` | The only machine check that reads the two settlement bodies for anything lock-related, and its law is a **write** law (`UPDATE invoices` / `UPDATE customers`). Its own doc comment treats `FOR UPDATE` only as a token that must not be *mistaken* for a write. It never tokenises an acquisition, so a fortiori never reads `FOR SHARE` as one. |
| `gate:phase4:s8`, the dynamic pair-runner `P4-AL-41` also promises | No script. `scripts/phase4-s8-gate.ts` is named only as a future file by `tests/security/phase4-forward-evolution.test.ts:698`; `package.json` registers gates s1–s4. |

So the answer to "is it absent, reading the wrong definition, or not reading `FOR SHARE`?" is
**absent** — and the other two are consequences, not alternatives. (The wrong-definition
hazard is nonetheless *live* in the gate's only body reader; that is `PATCH-REQ-S4X-004`.)

This is how a standing inversion between the lock and **both** settlement routines survived
to acceptance.

## 2. The advisory gap, measured over the right window

`P4-AL-41`'s seven ranks name no advisory key. Over the **full Phase 4 migration range** —
the `phase4`-named files `0074`–`0086` — there are **eight advisory call sites across six
classes**, not two:

| class | taken by | at | mode |
|---|---|---|---|
| `daftar.stock_target` | `sale_lock_commit_targets` | `0078:309` | shared |
| `daftar.sale_id` | `sale_commit` | `0078:554` | exclusive |
| `daftar.customer_id` | `sale_commit` | `0078:674` | shared |
| `daftar.pos_till_session_actor` | `pos_till_session_open` | `0079:919` | exclusive |
| `daftar.pos_till_terminal` | `pos_till_session_open` | `0079:921` | exclusive |
| `daftar.pos_till_session_id` | `pos_till_session_open` | `0079:923` | exclusive |
| `daftar.payment_id` | `customer_collect_payment` | `0081:1893`, `0085:487` | exclusive |
| `daftar.customer_credit_application_id` | `customer_apply_credit` | `0081:2269` | exclusive |

A `grep` restricted to `008*.sql` finds the last two only, because it excludes `0077`–`0079`
— S2's and S3's Phase 4 migrations. **Two premises fail over the full window:**

- **"No accepted routine takes more than one, so there is no pair to order" is false.**
  `pos_till_session_open` (`0079:919-923`, S3's **accepted** migration) takes **three**
  advisory keys consecutively in one transaction. The ordered set the advisory gap is about
  is already shipped; it is not waiting on S6.
- **A block bolted on the front cannot describe Phase 4.** `sale_commit` **interleaves** the
  two kinds: `daftar.sale_id` (`0078:554`) → `sales FOR UPDATE` (`0078:586`) →
  `daftar.customer_id` **shared** (`0078:674`) → `invoice_sequences FOR NO KEY UPDATE`
  (`0078:959`). An advisory key arrives *after* a domain row lock. A head block would declare
  `daftar.customer_id` to be acquired before `sales`, which is false of the routine.

For **S4's own two commands** a head block *is* exact: both take their single per-document
advisory key strictly before every domain lock, with no interleaving. This is asserted, as a
measurement, by `tests/guards/p4s4-lock-order-law.test.ts`.

## Required change

**(a) Rank advisory classes inside ONE list, not in a block at the head.** The interleaving
above forces this. `daftar.customer_id` is not an afterthought in `sale_commit`: it IS that
routine's customer lock, taken as a shared advisory key precisely because a row lock on
`customers` was a privilege decision (`0078:664-667`). It therefore belongs at the customer
position of the single order, which is where it already sits. A workable single list, with
every rank justified by a routine that takes it:

```
1. the per-DOCUMENT advisory key — one per command, first:
     daftar.sale_id (sale_commit) | daftar.payment_id (customer_collect_payment)
     | daftar.customer_credit_application_id (customer_apply_credit)
2. businesses                     (READ, never row-locked — 0078:649-662)
3. sales                          FOR UPDATE, sale_commit's own document row
4. invoices                       FOR UPDATE, ascending by id — THE CAP LOCK
5. payments / credit_notes / customer_credits   the consumed source
6. the customer position:  customers FOR SHARE  |  daftar.customer_id (shared advisory)
7. payment_methods                FOR SHARE
8. daftar.stock_target, then stock_levels ascending by (warehouse_id, variant_id)
9. installment_plans
10. invoice_sequences             last of the domain locks (P4-AL-32)
```

Ranks 4 before 6 and 5 before 6 are `PATCH-REQ-S4X-001`; rank 7 is new (see **(c)**).

**(b) Rank only what is shipped, and state the extension rule.** S4's two classes are ranked
by this stream (`S4_ADVISORY_BLOCK` in the law suite). S2's three and S3's three are
**discovered and attributed, not ranked here** — a rank for a key this slice does not take is
a permanent module bounding the future (`P4-AL-60`,
`[[daftar-a-closure-rule-is-not-an-invariant]]`). The rule, stated on the constant: *a slice
that ships a routine taking an advisory key adds that class in the same change as the
migration that takes it, at the position its own routine takes it.* `pos_till_session_open`'s
three are therefore **S3's ranks to add**, and S6's arrive with S6's migration — which is
also why `PATCH-REQ-S6-012`'s "block 0 covering all of them" should be declined in that
shape.

**(c) Rank `payment_methods`.** Not in any brief, found by the sweep:
`customer_collect_payment` takes `payment_methods FOR SHARE` (`0085:618`) and `P4-AL-41`
ranks it **nowhere**. An unranked resource may be taken in either order and still pass — the
same class of gap as the advisory keys.

**(d) Wire the checker into a gate.** `scripts/guards/phase4-lock-order.ts` is written and
green but is executed only by its own law suite. One gate arm should call
`lockOrderProblems` over every Phase 4 routine against the declared list, so a future
inversion is a red gate and not a red test nobody runs. `scripts/phase4-s4-gate.ts` is the
coordinator's file, hence this request rather than an edit.

## Reason

A check that cannot see this inversion cannot see the next one. `P4-AL-41` is the only law in
Phase 4 whose stated enforcement mechanism was simply not built, and the cost is already
visible: the lock and both settlement routines have disagreed since `0081` landed, across
`0085`'s re-definition, through acceptance, with every gate green.

## The test that requires it

`tests/guards/p4s4-lock-order-law.test.ts` — **13 cases, all green**, written by this stream.
It requires each piece of the change:

- **(a)** `but sale_commit INTERLEAVES the two kinds, so a head block cannot describe Phase 4
  as a whole` — asserts `advisoryInterleaves(sale_commit) === true`.
- **(b)** `planted red: a routine taking the two S4 advisory keys in the WRONG order is
  refused` — the coordinator's explicit ask. The subject is the **real**
  `customer_apply_credit` body with exactly one acquisition added so the two ranked classes
  are taken in descending rank; the unplanted body is asserted silent **first**. The checker
  names both classes, both ranks and the inversion.
  Also `planted red: an advisory key no rank governs is reported, not ignored`, and
  `planted red: a Phase 4 routine already takes THREE advisory keys in one transaction`.
- **(c)** `planted red: payment_methods is acquired FOR SHARE and P4-AL-41 ranks it NOWHERE`,
  with the control that ranking it silences the finding.
- the `P4-AL-41`-today arm: `planted red: against the order P4-AL-41 declares TODAY, both
  routines are refused for taking customers after invoices` — the machine evidence for
  `PATCH-REQ-S4X-001`, over a **real** subject (the lock's live text and the live routines).

## What this stream already built, and in which files

Both are **new files no other agent owns**, so no owned file was edited:

- `scripts/guards/phase4-lock-order.ts` — the reader. Extracts advisory keys and row locks in
  one body-ordered sequence with modes and line numbers; blanks comments **and** literals
  length-preservingly (so `0081:626-642`'s prose and `0085:987`'s self-capture assertion are
  not read as acquisitions); resolves a locking clause's relation from the nearest `FROM`
  **within the same statement**; takes the **LAST** definition of a routine; judges
  `FOR SHARE` exactly as `FOR UPDATE`; reports an unranked resource rather than ignoring it.
- `tests/guards/p4s4-lock-order-law.test.ts` — the law and its red proofs.

Known scope limit, stated rather than hidden: the reader models **explicit** locking clauses
and advisory calls. It does not model the implicit exclusive row lock a bare
`UPDATE <table>` takes — which is why `customer_credit_consume` (`0081:1239`, the one
`UPDATE customer_credits` in the Phase 4 range) reports no acquisitions. That is harmless
today because the credit row is already held `FOR UPDATE` by its caller, but a later slice
whose DML reaches a table it has not locked would be invisible to the reader. Extending it to
DML-implicit locks is the obvious next increment.

## Expected semantic diff

`P4-AL-41` gains a single order that ranks every resource Phase 4 actually acquires — advisory
classes among the domain rows rather than in a block — plus `payment_methods`, plus the rule
by which a later slice adds its own classes. The static check it has always claimed begins to
exist and to be run. An inversion of either kind becomes a red gate.

**No law is weakened.** The requirement is still exactly one total order obeyed by every
lock-taking command; what changes is that the order now covers every resource, and that the
promised check now reads it.
