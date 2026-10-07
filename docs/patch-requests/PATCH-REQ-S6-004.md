# PATCH-REQ-S6-004 — the S6 migration: replace the three customer level constraints and widen the two verifiers

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Blocked on P4-S4 sealing, P4-S5 sealing, and S6 promotion.

## Target file

**The S6 migration under `infrastructure/database/migrations/`. Its number is UNKNOWN and is
not reserved by this request.** `0000`–`0079` are byte-for-byte immutable, `0080`–`0086` are
S4 candidates, and P4-S5 has not placed its own files. There is exactly **one** migration
owner in this phase and it is not the S6 owner, so this is a request and not a draft.

## Required change

Exactly what `docs/PHASE_4_S6_DDL_SPECIFICATION.md` and
`docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` specify, and nothing more:

1. create `payment_reversals` and `allocation_reversals` (DDL spec §1, §2);
2. create the shared **cross-relation** `BEFORE INSERT` active-level guard, installed as a
   trigger on **both** reducer relations, one body;
3. `CREATE OR REPLACE` `invoice_settlement_verify`, `customer_credit_verify`,
   `invoice_outstanding`, `customer_credit_consume`, `customer_credit_guard()` and
   `accounting_reversals_20_domain_source_guard()` (DDL spec §4);
4. create the void surface: `invoices_direct_void_guard()` and the compound command
   (DDL spec §5);
5. RLS, policies, grants and ownership (DDL spec §6);
6. the live-catalogue end-state block (DDL spec §7);
7. **only then** `ALTER TABLE … DROP CONSTRAINT` for `payment_allocations_level_uq`,
   `customer_credit_applications_level_uq` and
   `customer_credit_applications_invoice_level_uq`, in the order
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §6 gives.

## Reason

Under `TL-P4-S6-R1` the LIFO-only fallback is ACTIVE, so a reversal leaves the original row
in place holding its chain level while freeing that level on the **active** chain. A
per-relation `UNIQUE (…, level)` then refuses the next **lawful** reducer. `P4-AL-22:533-537`
already recorded this cost and named the remedy: *"a future operation that needs several rows
at one level must change the mechanism, not drop the constraint."* S6 is that operation.

## Dependency

All of: S4 sealed (so the verifier bodies to replace are final), S5 sealed (so the reducer
`UNION ALL` has its final membership and `customer_credit_verify`'s S5 widening is the body
S6 composes with), S6 promoted, and a number allocated by the migration owner.

## The tests that require it

Per replaced constraint, **in both directions**, which is the part a one-sided proof misses:

- the unlawful direct-SQL insert the dropped constraint would have refused → **must be
  refused** by the replacement;
- the **lawful** post-reversal insert at the freed level → **must be accepted**.

Without the second, a replacement that refused everything would pass the first while being
useless — `[[daftar-a-green-gate-must-prove-it-can-be-red]]` in the other direction. The
level-C models of the same properties are green today at
`packages/inventory/test/customer-reversal-concurrency.test.ts` C-2, C-3 and C-7, including
the non-vacuity case (*"a SINGLE direct insert at the freed level is ACCEPTED, so the
verifier refuses the overlap and not the level"*).

Plus the upgrade-safety test of DDL spec §8.4: with `allocation_reversals` empty every
anti-join is a no-op, so the widened verifiers must be behaviour-identical to the sealed ones
on all existing data — run the S4 and S5 chain suites against the widened bodies and require
**no** change in outcome.

## Expected semantic diff

Two new relations with no rows; one new guard body with two triggers; six replaced routine
bodies, each a `CREATE OR REPLACE` by its owner; three constraints dropped **last**; one
column-level grant on `payments`; three `inventory_operation_kinds` rows. **No existing row
of any relation is updated**, and no accounting source type is registered.
