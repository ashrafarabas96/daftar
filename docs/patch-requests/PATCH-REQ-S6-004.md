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

0. **FIRST**, add the `chain_generation` / `credit_chain_generation` columns and create the
   WIDER unique keys over `(…, level, generation)` (DDL spec §2A,
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §1A and §6 step 0). **This step must precede every
   other**, so the relations are never without a unique key over the level;
1. create `payment_reversals`, `allocation_reversals` and `invoice_voids` (DDL spec §1, §2,
   §5.3), **including `provider_source` and `provider_reference` on `payment_reversals` and the
   PARTIAL unique index over them** (DDL spec §1A). That column pair appears in **zero of the
   87 migrations** at the base SHA, and `docs/PHASE_4_EXECUTION_PLAN.md:199` makes its
   database-level idempotency an **exit condition of `gate:phase4:s6`** — so it is S6's to
   create and not a predecessor's to supply;
2. create the shared **cross-relation** `BEFORE INSERT` active-level guard, installed as a
   trigger on **both** reducer relations, one body;
3. `CREATE OR REPLACE` `invoice_settlement_verify`, `customer_credit_verify`,
   **`invoice_outstanding(uuid, uuid[])` — the ARRAY OVERLOAD at `0084:593`, which is where
   the reducer `UNION ALL` lives; NOT the scalar `invoice_outstanding(uuid,uuid)`, which has
   held no reducer read since `0083` and is a thin delegating wrapper (this request named the
   wrong target in its first draft — challenger F2, verified)** —
   `customer_credit_consume`, `customer_credit_guard()` and
   `accounting_reversals_20_domain_source_guard()` (DDL spec §4);
3a. create the three command routines `customer_reverse_payment`,
   `customer_reverse_allocation` and `sale_void_invoice`, **in the same migration that
   registers their three `invctl/1` operation kinds** (DDL spec §5A): a registered kind with
   no consuming routine reddens `tests/security/phase3-s8-operation-kinds.test.ts`
   (challenger F4);
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
the non-vacuity cases. **One of those tests must use TWO CONNECTIONS**, and that is the
correction this request's first draft most needed: two concurrent unlocked inserts at the same
freed level, the second required to BLOCK on the first's index entry and then raise `23505`.
A single-transaction red proof cannot see a two-transaction race, which is how a replacement
without the wider unique key passed review (challenger F1,
`docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §1A).

Plus the upgrade-safety test of DDL spec §8.4: with `allocation_reversals` empty every
anti-join is a no-op, so the widened verifiers must be behaviour-identical to the sealed ones
on all existing data — run the S4 and S5 chain suites against the widened bodies and require
**no** change in outcome.

## Expected semantic diff

Three new relations with no rows (one of them carrying the webhook identity pair and its
PARTIAL unique index); three new columns on two existing relations plus three wider unique
keys created **first**; one new guard body with two triggers; three new command
routines with their three registered kinds; six replaced routine bodies, each a
`CREATE OR REPLACE` by its owner; three narrow level constraints dropped **last**; one
column-level grant on `payments`; three `inventory_operation_kinds` rows. **No existing row
of any relation is updated**, and no accounting source type is registered.
