# PATCH-REQ-S6-011 — three `chain_generation` columns and three wider unique keys on TWO S4-OWNED relations

**From:** P4-S6 owner, branch `p4s6/owner`, base `6587460ba3632231e4324c5ce2af92e1589d0705`.
**Status:** OPEN. Raised at the coordinator's direction so the **CONTRACT_DIFF at promotion
classifies this explicitly** rather than discovering it: it is the one place S6's DDL reaches
outside S6's own tables.
**Shape:** a NEW APPEND-ONLY MIGRATION. **Never an edit** to `0081` or to any other file.

## Target relations — both owned by P4-S4

| relation | change |
|---|---|
| `payment_allocations` | `+ chain_generation BIGINT NOT NULL DEFAULT 0`; `+ payment_allocations_level_generation_uq`; `− payment_allocations_level_uq` (last) |
| `customer_credit_applications` | `+ chain_generation`, `+ credit_chain_generation`; `+ customer_credit_applications_invoice_level_generation_uq`, `+ customer_credit_applications_level_generation_uq`; `− customer_credit_applications_level_uq`, `− customer_credit_applications_invoice_level_uq` (last) |

**The timing fact that makes this a migration and not an edit.** P4-S4 is in its acceptance
transition now, so by S6's promotion `0080`–`0086` will be **byte-immutable**. There is no
version of this change that edits `0081`, and none is proposed. It is forward DDL in S6's own
migration, whose number is allocated by the single migration owner at promotion and **is not
named anywhere in S6's documents, not even as an example**.

## Why S6 needs it — the one-paragraph version

Under `TL-P4-S6-R1` a reversal leaves the original reducer row in place holding its chain level
while freeing that level on the ACTIVE chain, so a `UNIQUE (…, level)` refuses the next
**lawful** reducer. The first draft of `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` proposed replacing
that constraint with a `BEFORE INSERT` trigger that reads plus a deferred constraint trigger.
**That was weaker than what it dropped** (§1A of that document): under READ COMMITTED neither
device sees the other transaction's uncommitted row, so two direct inserts at one freed level
both commit. A `UNIQUE` index is cross-transaction **mutual exclusion**, which no trigger that
reads can provide. The generation column restores it: the key stays unique over the level, a
lawful successor at a freed level carries a different generation from its reversed original,
and two truthful concurrent writers at one level still compute **one** key.

## Required change, in order (and the order is the request)

`docs/PHASE_4_S6_DDL_SPECIFICATION.md` §2A.1 carries the table; in brief:

0a. create `allocation_reversals` (and `payment_reversals`), empty — the backfill expression
    names them and cannot run before they exist;
0b. `ADD COLUMN … NOT NULL DEFAULT 0` — metadata-only on PostgreSQL 11+, no table rewrite;
0c. **run the THREE backfill EXPRESSIONS** — one per column — and **assert the stored value
    equals the expression for every row of each relation**. `DEFAULT 0` is a device for new rows
    and **is not the backfill**; a default taken as the backfill is silently wrong for any chain
    that already carries a reversal;
0d. `CREATE UNIQUE INDEX` the three wider keys — over backfilled values, and **before any
    drop**, so the relations are never without a unique key over the level;
1–4. the guard, the widened verifier, the catalogue reads;
5.  **only then** `DROP CONSTRAINT` the three narrow keys.

## CORRECTION TO THIS REQUEST'S FIRST VERSION — the expression it named could not apply

**CHALLENGE FINDING F-C1, CRITICAL, ACCEPTED IN FULL.** The expression this request carried in
round 4 counted every reversal at a level `<= L` **as of now**, with no bound on WHEN. A reversed
original at level `L` therefore counted the reversal of ITSELF — `L <= L` — and stored `1` where
the law says `0`. Step 0c manufactured a duplicate `(…, 700, 1)` and **step 0d of this same
request then refused to index it**: the migration could not apply to any tree holding a reversal.
It fails safe (step 5 never runs, the narrow key survives, no data is lost) and it is still a
migration that aborts.

The repair is one conjunct — `AND r.created_at < a.created_at` — and **three expressions rather
than one**: `docs/PHASE_4_S6_DDL_SPECIFICATION.md` §2A.1 now prints all three, because the credit
column's expression is keyed on the **credit** and not on the invoice, and round 4's phrase "the
mirror of it … with `>=`" hid a double-spend (F-C6). Both relations already carry
`created_at TIMESTAMPTZ NOT NULL DEFAULT now()` — `0081:321` and `0081:465` — and the comparison
is strict so that a tie fails CLOSED: it gives a successor the generation of its reversed
original, which the new unique index refuses.

The level-C proof that was available all along and was not written now exists:
`packages/inventory/test/customer-reversal-generation.test.ts`, 29 cases, with round 4's
expression retained as the planted counterpart it must disagree with.

## What the CONTRACT_DIFF should classify, stated plainly

- **two S4-owned relations gain columns.** `tests/guards/p4s4-new-relation-coverage.test.ts`
  and `tests/guards/p4s4-settlement-surface-laws.test.ts` both read columns, so S4's own laws
  acquire a subject they did not have at acceptance;
- **three S4-authored constraints are dropped**, each replaced by a wider one created first;
- **no S4 row's value changes.** The default is the value for every existing row, not a
  replacement of one;
- **no S4 routine body changes by this request.** The verifier widenings are
  `PATCH-REQ-S6-004`'s.

## The honest weakness in the upgrade proof, disclosed rather than discovered

§2A.2: on **both** paths — `check:db-from-zero` and the real upgrade — every correct answer to
each backfill expression is also `0`, because the reversal relations are created empty in the
same migration. The fresh-install assertion iterates over **nothing**. So **neither path can
distinguish the expression from the constant**, which is precisely the condition under which a
wrong backfill ships unnoticed. The proof is owed at level F: seed a chain, reverse its tail
through the command, re-run the expression, require `1` at or below the freed level — with the
**planted counterpart** that a constant-`0` backfill fails that assertion. The migration also
carries a cheaper floor (`count(*) FROM allocation_reversals = 0` asserted beside the all-zero
column) so that the first person to reuse this shape on a tree that *does* hold reversals fails
a reading instead of inheriting a vacuity.

## Dependency

S4 sealed, S5 sealed, S6 promoted, a number allocated. Same as `PATCH-REQ-S6-004`, of which
this is the part that touches another slice's tables and therefore wants its own classification.

## The tests that require it

The two-connection index proof of `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §6 — two concurrent
unlocked inserts at one freed level, the second required to BLOCK and then raise `23505` — and
the level-F backfill proof above. The level-C models are green today at
`packages/inventory/test/customer-reversal-concurrency.test.ts` C-7, including the case that
asserts the **unrepaired** design lets both inserts commit.

## Expected semantic diff

Three columns on two relations, three unique indexes created, three constraints dropped last,
three backfill `UPDATE`s that touch zero rows on every path that exists today, and the
assertions that say so.
