# P4-S6 — DDL SPECIFICATION (LEVEL E)

**Base SHA: `6587460ba3632231e4324c5ce2af92e1589d0705`.** Branch `p4s6/owner`.

**This is a SPECIFICATION. There is no `.sql` file on this branch, and no migration number
is named, implied or reserved anywhere in it.** The real prefix is unknown until P4-S4's
`0080`–`0086` candidates and P4-S5's migrations seal; migrations `0000`–`0079` are
byte-for-byte immutable, and there is exactly one migration owner in this phase.

Everything below is written in the shape `0081` and `0065` already use, because a
specification that departs from the accepted shape is a redesign wearing a spec's clothes.

---

## 1. `payment_reversals`

One row per reversed payment. The `purchase_reversals` precedent (`0065:296-330`), mirrored.

```
tenant_id               UUID NOT NULL
business_id             UUID NOT NULL
id                      UUID NOT NULL          -- the client-chosen reversal id
payment_id              UUID NOT NULL
customer_id             UUID NOT NULL          -- denormalised, as 0081:305 denormalises it
reversal_date           DATE NOT NULL
reason                  TEXT NOT NULL
original_entry_id       UUID NOT NULL          -- the payment's own journal-bearing child or its credit
allocation_count        INTEGER NOT NULL       -- how many allocations this reversal covered, 0..50
intent_sha256           TEXT NOT NULL
business_transaction_id UUID NOT NULL
created_by              UUID NOT NULL
created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
accounting_source_type  TEXT NOT NULL GENERATED ALWAYS AS ('reversal') STORED
binding_source_id       UUID NOT NULL
```

### 1.1 CHECKs

| constraint | body | why |
|---|---|---|
| `payment_reversals_reason_ck` | `char_length(reason) BETWEEN 1 AND 200 AND reason = btrim(reason)` | `accounting_post_reversal` refuses an empty reason (`post.ts:430`); a trimmed bound makes whitespace not a reason |
| `payment_reversals_count_ck` | `allocation_count BETWEEN 0 AND 50` | R-87 admits a payment with **zero** allocations (`0081:262`), so the floor is 0 and not 1 |
| `payment_reversals_intent_ck` | `intent_sha256 ~ '^[0-9a-f]{64}$'` | `0081:265` |
| `payment_reversals_binding_identity_ck` | `binding_source_id = original_entry_id` | `0065:315` exactly. The binding names the **entry**, because the accounting fact is a native `reversal` and its source id is the original entry's id (`P4-AL-47`) |
| **no** `reversed`, `status`, `voided` or `is_active` column | — | the append-only law. There is nothing on this table a later writer could flip |
| **no** amount column of any kind | — | the exact-inverse law. An amount here would be a figure recomputed outside `accounting_post_reversal`, and a second statement of the payment's value |

### 1.2 Keys and FKs

| constraint | definition | why |
|---|---|---|
| PRIMARY KEY | `(business_id, id)` | the house shape |
| `payment_reversals_payment_uq` | `UNIQUE (business_id, payment_id)` | **one reversal per payment, for ever.** Not a `reversed` flag: the EXISTENCE of this row is the fact, which is `purchase_reversals`' own device (`0065:53`) and is why a second reversal is *unrepresentable* rather than refused by a check |
| `payment_reversals_entry_uq` | `UNIQUE (business_id, original_entry_id)` | `0065:314`. One reversal per entry, agreeing with `accounting_reversals.id = original_entry_id` |
| `payment_reversals_tenant_fk` | `(tenant_id, business_id) → businesses (tenant_id, id)` | `0081:276` |
| `payment_reversals_payment_fk` | `(business_id, payment_id, customer_id) → payments (business_id, id, customer_id)` | pins both ends to one customer. `payments_identity_uq` (`0081:273`) is `(business_id, id, customer_id, currency_code)` and **contains** this prefix — but a FK needs a key on exactly its columns, so this edge either names the four columns (carrying `currency_code` too) or `payments` gains `UNIQUE (business_id, id, customer_id)`. **The four-column form is chosen**, because adding a key to an S4 table is S4's call, not S6's |
| `payment_reversals_customer_fk` | `(business_id, customer_id) → customers (business_id, id)` ON DELETE RESTRICT | `0081:277` |
| `payment_reversals_binding_fk` | `(business_id, accounting_source_type, binding_source_id) → accounting_source_bindings (business_id, source_type, source_id)` **DEFERRABLE INITIALLY DEFERRED** | `0081:360-363`. "No orphan journal, no orphan source" in both directions |

### 1.3 Indexes

```
payment_reversals_customer_idx ON (business_id, customer_id, reversal_date, id)
payment_reversals_trace_idx    ON (business_id, business_transaction_id)
```

The first is the `0081:291` shape (the read path of §5 of the contract pack); the second
exists because a reversal and its mirrors share one `business_transaction_id` and the audit
read follows it. **No index on `payment_id`**: `payment_reversals_payment_uq` already
provides one.

---

## 2. `allocation_reversals`

One row per reversed reducer. **This relation is the only definition of "not active".**

```
tenant_id               UUID NOT NULL
business_id             UUID NOT NULL
id                      UUID NOT NULL
reducer_id              UUID NOT NULL
reducer_kind            TEXT NOT NULL          -- 'payment_allocation' | 'credit_application'
payment_reversal_id     UUID                   -- NULL for a standalone single-reducer reversal
invoice_id              UUID NOT NULL          -- the AR chain this freed
credit_id               UUID                   -- the credit chain this freed; NOT NULL iff reducer_kind = 'credit_application'
freed_ar_level_minor    BIGINT NOT NULL        -- COPIED from the reducer's ar_released_before_txn_minor
freed_credit_level_minor BIGINT                -- COPIED from credit_remaining_before_minor; NULL iff credit_id IS NULL
reversal_date           DATE NOT NULL
reason                  TEXT NOT NULL
original_entry_id       UUID NOT NULL
intent_sha256           TEXT NOT NULL
business_transaction_id UUID NOT NULL
created_by              UUID NOT NULL
created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
accounting_source_type  TEXT NOT NULL GENERATED ALWAYS AS ('reversal') STORED
binding_source_id       UUID NOT NULL
```

**`freed_*_level_minor` are COPIES, never recomputations.** They exist so the chain verifier
and the read path can see the freed level without joining back through two relations, and
`allocation_reversals_level_matches_ck` (§2.1) holds each one equal to the original's own
column — asserted by a trigger, because a `CHECK` cannot read another table. They are **not**
a second statement of the level: the original row remains the authority and the trigger is
what makes the copy provably redundant.

### 2.1 CHECKs and the two-table assertions

| constraint | body | why |
|---|---|---|
| `allocation_reversals_kind_ck` | `reducer_kind IN ('payment_allocation', 'credit_application')` | a closed set, in the vocabulary `ActiveReducer.kind` uses |
| `allocation_reversals_credit_pairing_ck` | `(credit_id IS NULL) = (reducer_kind = 'payment_allocation') AND (freed_credit_level_minor IS NULL) = (credit_id IS NULL)` | **the two-chain law as a structural fact.** A `credit_application` reversal with no `credit_id` is unrepresentable, so the second chain cannot be forgotten |
| `allocation_reversals_ar_level_ck` | `freed_ar_level_minor BETWEEN 0 AND 1000000000000000000` | `0081:313` |
| `allocation_reversals_credit_level_ck` | `freed_credit_level_minor IS NULL OR freed_credit_level_minor BETWEEN 1 AND 1000000000000000000` | the credit level's floor is 1 (`0081:450`) |
| `allocation_reversals_reason_ck` | as §1.1 | |
| `allocation_reversals_binding_identity_ck` | `binding_source_id = original_entry_id` | |
| **trigger** `allocation_reversals_level_matches` | BEFORE INSERT: the reducer row exists in the relation `reducer_kind` names, in **this** business, and its stored level(s) equal `freed_*_level_minor`; and `invoice_id` / `credit_id` are the reducer's own | a `CHECK` cannot read another table. Refusal `allocation_reversal.chain_inconsistent` |
| **trigger** `allocation_reversals_tail_at_insert` | DEFERRED CONSTRAINT TRIGGER: at COMMIT, the reducer is **not** in the ACTIVE set of any chain it names | the LIFO law's backstop under direct SQL. A wrapper is not an invariant (`0081:666-669`) |

### 2.2 Keys and FKs

| constraint | definition | why |
|---|---|---|
| PRIMARY KEY | `(business_id, id)` | |
| `allocation_reversals_reducer_uq` | `UNIQUE (business_id, reducer_id)` | **one reversal per reducer, for ever.** The existence-is-the-fact device again, and what makes "a second reversal is refused" structural |
| `allocation_reversals_entry_uq` | `UNIQUE (business_id, original_entry_id)` | |
| `allocation_reversals_tenant_fk` | `(tenant_id, business_id) → businesses` | |
| `allocation_reversals_header_fk` | `(business_id, payment_reversal_id) → payment_reversals (business_id, id)` ON DELETE RESTRICT | nullable: a standalone reducer reversal has no header. `NULLS DISTINCT` is harmless here because the column is a **parent** reference and not part of a uniqueness claim — the trap `docs/PHASE_4_S5_PREPARATION.md` §4.2 records applies to a nullable column **inside a UNIQUE**, and none of this relation's uniques carries one |
| `allocation_reversals_invoice_fk` | `(business_id, invoice_id) → invoices (business_id, id)` ON DELETE RESTRICT | `0081:354-356`, Departure A's edge, with the customer pin carried by the verifier for the same reason |
| `allocation_reversals_credit_fk` | `(business_id, credit_id) → customer_credits (business_id, id)` ON DELETE RESTRICT | |
| `allocation_reversals_binding_fk` | as §1.2, **DEFERRABLE INITIALLY DEFERRED** | |
| **NO** FK to `payment_allocations` or `customer_credit_applications` | — | one `reducer_id` column must reference **either** relation by `reducer_kind`, which no single FK can express. The `allocation_reversals_level_matches` trigger is the edge, and it is **stronger** than a FK because it also pins the level and the chain ids. The honest cost: a `reducer_id` of the wrong kind is refused by a trigger rather than by the catalogue, and the trigger's red proof plants exactly that |

### 2.3 Indexes

```
allocation_reversals_invoice_idx ON (business_id, invoice_id)            -- the AR anti-join
allocation_reversals_credit_idx  ON (business_id, credit_id) WHERE credit_id IS NOT NULL
allocation_reversals_header_idx  ON (business_id, payment_reversal_id) WHERE payment_reversal_id IS NOT NULL
```

The first two are the **anti-join** indexes and are the reason the widened verifiers do not
regress: `invoice_settlement_verify` already reads
`payment_allocations_invoice_idx` / `customer_credit_applications_invoice_idx`
(`0081:366`, `:501`) and the anti-join adds one index scan on the same key shape. The two
partial indexes carry only the rows that have the column, which is the `0081:434` shape.

---

## 3. The level-uniqueness replacement

Fully specified in **`docs/PHASE_4_S6_LEVEL_UNIQUENESS.md`** — the constraint-by-constraint
table, the triple that replaces each, the removal **order**, and the two-directional red proof
per constraint. It is not restated here, because a law stated twice drifts.

In outline: a shared `BEFORE INSERT` **cross-relation** active-level guard installed on both
reducer relations (one body, two triggers, asserted to share one `tgfoid`); the two deferred
verifiers widened to the **ACTIVE** subset; the canonical source lock unchanged; and the
constraints dropped **last**, after a live-catalogue assertion that all three exist.

---

## 4. Replaced routines (`CREATE OR REPLACE`, by the owner)

| routine | the change | refusals added |
|---|---|---|
| `invoice_settlement_verify(uuid,uuid)` (`0081:691`) | the reducer `UNION ALL` (`:739-748`) anti-joined against `allocation_reversals`; one branch per S5 reducer relation | none new — the existing `invoice_settlement.settlement_inconsistent` now refuses the ACTIVE chain |
| `customer_credit_verify(uuid,uuid)` (`0081:879`) | the consumer set anti-joined; `Σ consumed over ACTIVE = original − remaining` | `customer_credit.remaining_inconsistent` |
| `invoice_outstanding(uuid,uuid)` (`0081:1334`) | the two reducer reads anti-joined. **Mandatory**: an outstanding computed over reversed rows is a wrong receivable, and `0081:1380` already states this reader is replaced by the slice that changes the reducer set | none — it is a reader |
| `customer_credit_consume(uuid,bigint,bigint)` (`0081:1224`) + `customer_credit_guard()` (`:1070`) | one more lawful transition: the **restoration** a reversal makes. Same single writer (R-90), given one more legal move — never a second writer | `customer_credit.restore_invalid` |
| `accounting_reversals_20_domain_source_guard()` (`0081:1405`) | `customer_payment_allocation`, `customer_credit_application` and `customer_credit` move from the plain refusal list to a `purchase`-style **paired** arm: admitted **iff** a paired `allocation_reversals` / `payment_reversals` row exists for the entry. The mechanism is `0081:1410-1413` applied to three more types | none — the existing `accounting.reversal_source_domain_owned` now has three narrower arms |
| `purchase_settlement_verify(uuid,uuid)` (`0067:717`) | the ACTIVE subset, for TD-15. **BLOCKED**: its `prosrc` SHA-256 is pinned inside **frozen** `0067` (`:1817`) and read by an existing Phase 3 suite. `PATCH-REQ-S6-005`; `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §5.2 | — |

**Append, never insert, into any pinned list.** `0067:2790`, `0072:903` and `0077` each
assert a **SUBSTRING** of the domain-source-guard's refusal list, so a reordering makes a
frozen migration's own end-state claim read false (`0081:1395-1399`). The three types are
**moved out of** the list and into a paired arm, which changes the list's membership — so the
S6 migration must probe what those substring assertions still match and either keep the plain
arm's remaining order byte-identical or carry the same ruling as `PATCH-REQ-S6-005`. **This is
a measured hazard, not a hypothesis**, and it is the second item of that patch request.

---

## 5. The void surface

### 5.1 The refusal of the direct path

```
invoices_direct_void_guard()   BEFORE UPDATE OF status ON invoices
```

Refuses `NEW.status = 'void'` unless the transaction is the `void_invoice` command — proved
by the existence, in this transaction, of the command's own row, not by a session GUC: a GUC
a client can set is not an authority. Refusal `invoice_void.direct_update_refused`.

`invoices_lifecycle_guard()` (`0075:546`, trigger `0075:637`) already bounds
`draft → open → void` and is **not replaced**: it answers "is this transition in the state
machine", and this guard answers "did the compound command make it". Two questions, two
bodies, and the second is the one `P4-AL-24` asks for — "a direct
`UPDATE invoices SET status='void'` is **refused** by a trigger".

### 5.2 The compound command

One transaction: the AR chain carries **no active reducer** (the precondition —
`voidPrecondition` in `packages/inventory/src/customer-reversal.ts`, refusal
`invoice_void.reducers_not_reversed` naming the reversals newest-first), the revenue entry is
reversed **exactly once**, the inventory entry is reversed, the stock is returned **through
the accepted stock-movement authority**, the refund is issued **from the credit-note source
only**, and `invoices.status` becomes `void`.

**The void does not acquire a power to unwind a chain out of order.** It acquires a
precondition, and the way to meet it is this slice's other two commands. That is how
`STATE_MACHINES.md` §2's "with no active payments" and `P4-AL-24`'s `void_invoice` are
reconciled without widening either.

**The final state, asserted and not described:** invoice void, revenue reversed exactly once,
**AR zero**, and cash net movement equal to what the customer actually gets back
(`P4-AL-24:553-556`).

---

## 6. RLS, grants and ownership

`ENABLE` + **`FORCE`** ROW LEVEL SECURITY on both relations, and the **seven-policy** set of
`0081:528-603` verbatim in shape: `tenant_membership` (permissive, both halves);
`business_isolation_read` / `_insert` / `_update` / `_delete` as **RESTRICTIVE**;
`inventory_internal_read` and `accounting_validator` as `FOR SELECT TO <role> USING (true)`.
`TL-P4-RLS-INT-01` is RULED: the last two are **intentional** and are not narrowed.

```
REVOKE ALL ON payment_reversals, allocation_reversals FROM PUBLIC;
GRANT SELECT                 ON both TO daftar_app;                   -- NO DML (P4-AL-38)
GRANT SELECT, INSERT         ON both TO daftar_inventory_internal;    -- append-only: no UPDATE, no DELETE
GRANT SELECT                 ON both TO daftar_accounting_internal;   -- a validator that cannot read passes vacuously
GRANT UPDATE (<one column>)  ON payments TO daftar_inventory_internal;-- the row-lock ACL for §8 step 2 of the contract pack
```

**`daftar_inventory_internal` is granted no `UPDATE` and no `DELETE` on either reversal
relation.** The append-only law is not a convention here — the writer **cannot** mutate a
reversal row, and the privilege list is the proof.

The `GRANT UPDATE (<one column>) ON payments` exists **solely** for the locking-clause ACL:
PostgreSQL requires `SELECT` **plus one of** UPDATE/DELETE/TRUNCATE for `FOR UPDATE`, and
`SELECT` alone raises before any body logic runs (`0081:620-631`). It is **column-level and
one column**, never table-level, and the permanent assertion that the routines issue no
`UPDATE` on `payments` is owed as `PATCH-REQ-S6-010`.

Every function: `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp` (every
relation schema-qualified, `pg_temp` **last** — `0070`'s law, asserted by
`check:deployment-authority` 10b.5/10b.6), `PUBLIC` EXECUTE revoked, `EXECUTE` to
`daftar_app` only for the commands, and owned by `daftar_inventory_internal` (the inventory
bracket) or `daftar_accounting_internal` (the accounting bracket), created in the
`0067:658-664` / `0081:685-690` order.

---

## 7. Expected catalogue shape — what the migration's end-state block must READ

Read from the **live catalogues**, never from the migration's own statements: "a migration
that asserts what it just wrote asserts nothing" (`0081:2490`). The `0081:2490-2680` block
is the shape to follow, over these subjects:

1. `pg_class.relrowsecurity` and **`relforcerowsecurity`** true for both relations.
2. `pg_policy`: exactly the seven policy names per relation, each with the expected
   `polpermissive` and `polcmd` — the `c_source` array device of `0081:2497`.
3. `pg_constraint`: every constraint of §1.1–§1.2 and §2.1–§2.2 present with the expected
   `pg_get_constraintdef`; and **the three replaced `*_level_uq` names ABSENT**.
4. `pg_trigger`: every trigger of §2.1, §3 and §5.1 present, `tgenabled = 'O'`, plain
   (`tgqual IS NULL AND cardinality(tgattr) = 0` where it should be), and the constraint
   triggers `tgconstraint <> 0 AND tgdeferrable AND tginitdeferred`.
5. The **one-body claim**, catalogue-checked: the shared active-level guard's two triggers
   have the **same** `tgfoid`.
6. `pg_proc`: every replaced routine's `prosecdef`, `proconfig` (naming `pg_temp` last) and
   owner; `pg_proc.proname IN (…)` for the new ones.
7. `has_table_privilege` / `has_column_privilege` for every grant of §6, **and the absence**
   of `UPDATE` and `DELETE` for `daftar_inventory_internal` on both reversal relations.
8. `accounting_source_types`: **no** `allocation_reversal` row, and the native `reversal` row
   unchanged — §7.2 of the contract pack is why.
9. `inventory_operation_kinds`: the three new `op_code` rows with
   `registered_by = 'P4-S6'`, admitted by the `^P[0-9]+-S[0-9]+$` pattern `0074` widened
   (`P4-AL-20`).
10. **No tax-named column** on either relation: `od03Problems`
    (`tests/security/phase3-s8-grant-matrix.test.ts:174`) reads every column matching
    `(^|_)tax(_|$)` on every relation in `public`, and "nothing is permitted by being named,
    only by being structurally zero". Neither relation carries one.

---

## 8. Upgrade expectations

1. **Forward-only.** No `DROP TABLE`, no column drop on an existing relation, no data
   rewrite. The three constraint drops of §3 are the only removals, each paired with its
   replacement **in the same migration**, in the order
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §6 gives.
2. **Zero existing rows change.** Not one row of `payment_allocations`,
   `customer_credit_applications` or `customer_credits` is updated by this migration; the
   relations are seeded empty. The append-only law holds across the upgrade itself, and the
   end-state block asserts a row count of 0 on both new relations.
3. **Idempotent re-application** in the `0074`-probe style where a statement is not naturally
   idempotent.
4. **The verifier replacements are behaviour-preserving on a tree with no reversal rows.**
   With `allocation_reversals` empty, every anti-join is a no-op and the ACTIVE subset is the
   full set — so the widened verifiers are **byte-for-byte equivalent in behaviour** to the
   sealed ones on all existing data. That is the upgrade's safety argument, and it is
   testable: run the S4 and S5 chain suites against the widened bodies and require **no**
   change in outcome. This is the one migration-level test S6 owes that does not need a
   reversal to exist.
5. **`check:migrations` / `verify:history`.** The manifest and the history verifier take the
   new file once it has a number. Nothing on this branch touches either, because there is no
   file and no number.
6. **`db-from-zero`.** The migration must apply to a database built from zero, and the
   end-state block must pass there — which is how `0081` is held
   (`npm run check:db-from-zero`).
