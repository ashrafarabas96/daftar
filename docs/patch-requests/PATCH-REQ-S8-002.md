# PATCH-REQ-S8-002 — the lock-order inversion in the customer settlement commands

| | |
|---|---|
| raised by | P4-S8 (adversarial) |
| base SHA | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| target | `customer_collect_payment` (re-defined in `0085`), `customer_apply_credit` |
| owner | **P4-S4** (settlement) / the migration owner and the architecture-lock owner |
| severity | a real deadlock risk between two concurrent commands |
| detector | `scripts/phase4-s8/lock-order.ts` → `acquisitionOrderProblems` |
| check | `scripts/phase4-s8/index.ts` → `lock-order-static` (currently **FAIL**) |
| red proof | `tests/guards/p4s8-red-proofs.test.ts::the lock-order checker names a REAL planted routine that inverts the declared order` |

## The finding

Walked out of the routine bodies, with `PERFORM helper(...)` calls inlined at
the call offset, the settlement commands acquire `customers` **after**
`invoices`. `P4-AL-41`'s declared domain order and `0081:626-642`'s own step
comments put the customer **before** the documents (step 2b after 2a there, but
the declared *domain* rank has customers ahead of invoices). One of the two is
wrong, and which one is a decision S8 does not own.

Two readings, both of which S8 refuses to choose between:

1. The routines are right and `P4-AL-41`'s rank table is wrong, in which case
   the lock file needs the correction and the rank table needs to match the
   shipped order.
2. The rank table is right and the routines invert it, in which case this is a
   deadlock between a settlement and any command that takes the customer first,
   and it is P4-S4's to fix.

## What is NOT the remedy

- **Not `deadlock_timeout`.** A timeout turns a deadlock into a slow deadlock.
- **Not a retry loop.** `[[daftar-lock-order-not-retry]]`: a retry makes the
  deadlock intermittent, which makes it un-diagnosable.
- **Not treating a deadlock as a business outcome.** `forbiddenRemedyProblems`
  refuses all three by name.

## Required change

Either (1) `docs/PHASE_4_ARCHITECTURE_LOCK.md` `P4-AL-41`'s rank table is
corrected and `lock-order.ts`'s `LOCK_RANK` updated to match, or (2) a P4-S4
candidate migration re-defines the two routines to take the customer first.
`invoice_sequences` stays **last** either way (`P4-AL-32`).

## Dependency

The decision is the architecture-lock owner's. S8 cannot pick the reading,
because picking it would make the checker agree with whichever answer the
checker's author preferred — which is not a check.

## Expected semantic diff

| | before | after |
|---|---|---|
| `acquisitionOrderProblems('customer_collect_payment', …)` | names the inversion | `[]` |
| `lock-order-static` | FAIL | PASS |
| the deadlock matrix's `customer_collect_payment` pairs | a real inversion to find | the declared order in both directions |

## How to reproduce the finding

```
npx tsx scripts/phase4-s8/run.ts        # lock-order-static
```
