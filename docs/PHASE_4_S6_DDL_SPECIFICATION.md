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
surplus_credit_entry_id UUID NULL              -- see 1.1: NULLABLE, and only the surplus credit's entry
allocation_count        INTEGER NOT NULL       -- how many allocations this reversal covered, 0..50
intent_sha256           TEXT NOT NULL
business_transaction_id UUID NOT NULL
created_by              UUID NOT NULL
created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
surplus_credit_id       UUID NULL              -- the payment's surplus credit, when it had one
provider_source         TEXT NULL              -- see 1A: the webhook identity, both or neither
provider_reference      TEXT NULL
```

**No `accounting_source_type` and no `binding_source_id` on this table** — see 1.1.

---

## 1A. `provider_source` and `provider_reference` — the webhook identity, which exists NOWHERE in the tree

**Measured, not assumed.** `grep -rn "provider_reference" infrastructure/database/migrations/`
at the base SHA returns **zero hits across all 87 migrations**. The column exists only in
documents: `docs/PHASE_4_EXECUTION_PLAN.md:199` makes `provider_reference` idempotency **at the
database** an exit condition of `gate:phase4:s6`, `docs/PHASE_4_ARCHITECTURE_LOCK.md:679`
specifies the mechanism, and `:1342` (G-11) makes it the chargeback golden's idempotency.

So it is **not a predecessor assumption.** No sealed tree will contain it, no diff can confirm
it, and no amount of waiting produces it: **S6 creates the column and S6 specifies the
uniqueness**, or the exit condition is unmeetable. The S8 owner's idempotency inventory
already reports the hole, with the missing subject named as *"the `provider_reference` column
(exists nowhere)"*, and it stays a hole until this section is implemented.

The lock's own words, which this section implements and does not reinterpret:

> Replay is refused **at the database** by a real `UNIQUE` over real columns, per command, with
> the duplicate reversal additionally blocked by a **partial unique** on
> `(business_id, provider_source, provider_reference)` — so a replayed payment-provider webhook
> is refused physically, not by an application check.

### 1A.1 Which relation carries it, and why only that one

**`payment_reversals`, and nothing else.** The provider identity belongs to the command a
payment provider originates, and the only such command in this slice is the payment reversal —
G-11's chargeback. `allocation_reversals` is a **child** of that command (and the subject of a
merchant-initiated command of its own, which no provider ever originates), and `invoice_voids`
is a merchant decision. Putting the column on a child would give one webhook delivery several
rows to be idempotent on, which is the F3 defect in another costume.

```
provider_source         TEXT NULL     -- which provider; NULL for a merchant-initiated reversal
provider_reference      TEXT NULL     -- that provider's own id for this event
```

| field | statement |
|---|---|
| **nullable, and both or neither** | a merchant-initiated reversal has no provider and must not be forced to invent one. `payment_reversals_provider_pairing_ck`: `(provider_source IS NULL) = (provider_reference IS NULL)` — so a reference with no source, or a source with no reference, is unrepresentable rather than refused |
| **shape** | `payment_reversals_provider_ck`: each, when present, `char_length BETWEEN 1 AND 100 AND value = btrim(value)`, which is `payments.reference`'s own bound (`0081:258`) — one shape law for provider-supplied text, not two |
| **`provider_source` is not an enum** | there is no provider in this tree yet (`0048:25`, `:77-78`: *"A `provider` value that nothing can write is a promise the schema makes and the code cannot keep"*). A `CHECK (provider_source IN (…))` naming providers that do not exist would be exactly that promise. It is trimmed text, and the closed set arrives with the first integration |

### 1A.2 The partial unique index, and the `NULLS DISTINCT` trap stated plainly

```
CREATE UNIQUE INDEX payment_reversals_provider_uq
    ON payment_reversals (business_id, provider_source, provider_reference)
 WHERE provider_reference IS NOT NULL;
```

**Why partial, and not a plain `UNIQUE` over the three columns.** PostgreSQL's default is
`NULLS DISTINCT`: every NULL is distinct from every other NULL, so a plain
`UNIQUE (business_id, provider_source, provider_reference)` **admits unlimited rows** whose
reference is NULL. Every merchant-initiated reversal is such a row. The constraint would be
**green and vacuous for exactly the majority case** — present in the catalogue, enforcing
nothing most of the time — which is the `[[daftar-a-unique-tuple-is-not-a-source-proof]]`
failure in its purest form: a key that exists and excludes nothing.

The partial predicate makes the index's domain exactly the rows the law is about. It is not a
weakening: a NULL reference is not an identity, so there is nothing for it to exclude, and the
merchant path's uniqueness is carried by `payment_reversals_payment_uq` — one reversal per
payment, for ever — which is **stronger** than any provider key could be.

**`NULLS NOT DISTINCT` is NOT proposed**, and the reason is a fact about this tree rather than
a preference: nothing in it ever writes that clause. The sole mention is a comment at
`0005:74`, where a surrogate PK is used as the substitute. A partial index is the device this
repository already reaches for, and it is also the device the Architecture Lock names.

### 1A.3 Law 7, clause by clause, over TWO identities

A payment reversal now has two identities, and that is the whole difficulty: the **client-chosen
`id`**, and the **provider's reference**, which the client does not choose and which a webhook
redelivery repeats while generating a *fresh* `id`.

| law 7 clause | the id path | the provider path |
|---|---|---|
| **same identity** | `(business_id, id)` — the primary key | `(business_id, provider_source, provider_reference)` — the partial unique |
| **same intent hash** | `intent_sha256` equal → replay | the same `intent_sha256`, equal → replay |
| **exact replay** | return the stored rows: the reversal, its `allocation_reversals` children, and its journal reversal ids. No new row, no new entry, no second audit event | **the same stored rows**, found by the provider key and not by the id — because the redelivery's `id` is new and would otherwise insert |
| **CONFLICT on a changed intent** | `payment_reversal.idempotency_conflict` | `payment_reversal.idempotency_conflict`, on the **same** code: one state, one code (§9 of the contract pack) |

**Therefore the intent hash does NOT cover the client-chosen reversal id**, and this is a
declared **departure** from `customer_collect_payment`, whose intent is "the request-only
intent (**id**, customer, method, date, …)" (`0081`'s own comment). Stated rather than slipped
in:

> A webhook redelivery is the same economic command with a different client id. If the id were
> inside the hash, the redelivery's hash would differ from the stored one, the comparison would
> report `idempotency_conflict`, and **a correct replay would be refused as a changed intent**
> — turning law 7 upside down for the one path it exists to protect.

The hash covers: `payment_id`, `reversal_date`, `reason`, `provider_source`,
`provider_reference`, and the ordered set of reversed allocation ids. The `id` remains the
primary-key identity and is matched by the key lookup, not by the hash — so "same id, changed
intent" still conflicts, and "different id, same economic command" is made **unrepresentable**
by `payment_reversals_payment_uq` rather than detected. **No key silently accepts a different
economic command:** change the payment, the date, the reason or the allocation set under one
provider reference and the stored hash differs, which is the conflict.

### 1A.4 The lock order the provider key needs, and the race that forces it

Two concurrent deliveries of one webhook carry **different** `id`s, so the advisory
`daftar.payment_reversal_id` key of step 1 does not serialise them — each takes its own key and
neither waits. Both then read "no such reversal", both insert, and the partial unique arbitrates
with `23505` for one of them. A `23505` is a refusal, and law 7 requires an **exact replay**, so
that outcome is wrong by one step.

The fix is an advisory key on the identity that is actually shared, taken **first**:

| step | lock | notes |
|---|---|---|
| **1** | `pg_advisory_xact_lock('daftar.payment_provider_reference', hashtext(provider_source || '\|' || provider_reference))` | **payment reversal with a provider reference only.** Before everything, because it is the identity under which the whole replay decision is made. A collision on `hashtext` costs serialisation and never correctness |
| 1a | `pg_advisory_xact_lock('daftar.payment_reversal_id', id)` | the client-chosen id, as before |
| 1b | `pg_advisory_xact_lock('daftar.payment_id', payment)` | as before |
| 3 … | the chain locks and the rest, unchanged | contract pack §8.1 |

With step 1 held, the second delivery waits, then reads the committed row, compares the hash
and **replays**. The `23505` becomes unreachable on the lawful path and survives only as the
physical floor for a direct-SQL writer that took no lock — which is exactly the division of
labour §2A sets out for the level key, and the same lesson: **the index is the floor, the lock
is the protocol, and neither substitutes for the other.**

**This is a level-F case and is named as one** (contract pack §14 item 7): it needs two
connections, because a single-transaction test cannot see it. The level-C model of it is the
one the concurrency suite already provides in shape — `World.insertUnique` plus
`indexKeyLock` — and extending it to the provider key is work for the round that has the
column.

### 1A.5 The replay LOOKUP, which the hash's composition makes load-bearing

Removing the client-chosen `id` from the intent hash answers one question and opens another:
**a redelivery no longer matches by id either, so what does it match by?** §46 separates the
two — the id is **identity**, the hash is **intent** — and that separation is only honest if
the lookup is specified. It is:

```
1.  advisory daftar.payment_provider_reference        (when a provider reference is present)
1a. advisory daftar.payment_reversal_id               (the client-chosen id)
2.  THE PRIOR-ROW LOOKUP, in this order, and BEFORE ANY READ OF CURRENT STATE:
      a. by the provider key, when present:
           SELECT … FROM payment_reversals
            WHERE business_id = $b AND provider_source = $s AND provider_reference = $r
      b. by the payment, always:
           SELECT … FROM payment_reversals WHERE business_id = $b AND payment_id = $p
                                                  -- payment_reversals_payment_uq
3.  a row from EITHER lookup → compare intent_sha256:
      equal     → EXACT REPLAY: return that row, its allocation_reversals children and their
                  journal reversal ids. No insert, no new entry, no second audit event
      different → payment_reversal.idempotency_conflict
4.  no row     → only now read the payment, the invoices, the chains, and proceed
```

**Both lookups, and not one.** They answer different questions and neither covers the other:

| | what it catches | what it misses alone |
|---|---|---|
| **by the provider key** | a redelivery with a **fresh** client id; and the same provider reference presented against a **different payment**, which is a different economic command under one key and must conflict rather than insert | a merchant-initiated reversal, which has no provider reference at all |
| **by the payment** (`payment_reversals_payment_uq`) | every second reversal of one payment, whatever its origin — the id-path replay, and the merchant path | a provider reference reused across payments: the payments differ, so this lookup finds nothing and the insert would reach the partial unique as a `23505` |

So the provider key is consulted **first** when present, the payment key **always**, and a hit
on either compares the hash. The partial unique index remains the **physical floor** underneath
both — for a direct-SQL writer that consulted no routine — exactly as §2A divides the labour
for the level key: **the index is the floor, the lock is the protocol, and neither substitutes
for the other.**

**The lookup precedes every read of current state, and that ordering is the law, not a
preference** (`[[daftar-registry-before-state]]`; the device `0081:1912-1918` already applies
to `customer_collect_payment`). The failure it prevents is specific: a **stale redelivery**
arriving after a later transition on the same chain — a new allocation, a void, another
reversal. If the command read state first it would find a chain that no longer matches the
stored reversal and could answer `settlement_changed` — **a false conflict on a correct
replay** — or, worse, proceed and perform a second real change. With the lookup first, the
stored intent hash is compared against the request alone, nothing about the present is read,
and the answer is the original row. **A replay is a question about the past, so it must be
answered before the present is consulted.**

**The departure from `customer_collect_payment`, recorded with its mechanism and not only as a
difference:** that command's intent is "the request-only intent (**id**, customer, method,
date, …)" and its lookup is **by the id under the advisory key**, which is sound because a
client that replays chooses the same id. S6's payment reversal cannot borrow that, because the
party that replays is a payment provider which never saw the id. The departure is therefore:
**the id leaves the hash, and the lookup moves from the id to the provider key and the payment
key** — one change with two halves, and specifying only the first half would have left the
command unable to find what it must replay. The hash covers `payment_id`, `reversal_date`,
`reason`, `provider_source`, `provider_reference` and the ordered set of reversed allocation
ids; the id remains the primary key and is still matched by the key lookup, so "same id,
changed intent" conflicts, and "different id, same economic command" stays **unrepresentable**
under `payment_reversals_payment_uq` rather than merely detected.

**Owed at level F, and named so it is not mistaken for proved:** a redelivery with a fresh id
returning the stored rows; the same provider reference against a different payment conflicting;
a stale redelivery after a later transition replaying rather than refusing `settlement_changed`;
and the **planted counterpart** for the ordering itself — a variant that reads state before the
lookup must FAIL that last case, or the ordering claim is vacuous.
### 1A.6 What this section does not claim

- It does not create a provider integration, a webhook endpoint, an HTTP client or a
  credential. There is no provider in this tree (`0048:25`), and a column is not a provider.
- It does not put `provider_reference` on `allocation_reversals` or `invoice_voids` (§1A.1).
- It does not name a migration number, and the column arrives in the S6 migration like
  everything else here (`PATCH-REQ-S6-004`).
### 1.1 CHECKs

| constraint | body | why |
|---|---|---|
| `payment_reversals_reason_ck` | `char_length(reason) BETWEEN 1 AND 200 AND reason = btrim(reason)` | `accounting_post_reversal` refuses an empty reason (`post.ts:430`); a trimmed bound makes whitespace not a reason |
| `payment_reversals_count_ck` | `allocation_count BETWEEN 0 AND 50` | R-87 admits a payment with **zero** allocations (`0081:262`), so the floor is 0 and not 1 |
| `payment_reversals_intent_ck` | `intent_sha256 ~ '^[0-9a-f]{64}$'` | `0081:265` |
| `payment_reversals_surplus_pairing_ck` | `(surplus_credit_entry_id IS NULL) = (surplus_credit_id IS NULL)` | **CHALLENGE FINDING F3, accepted and fixed here.** The column was `original_entry_id UUID NOT NULL` with `binding_source_id = original_entry_id` and `UNIQUE (business_id, original_entry_id)`, mirroring `purchase_reversals` (`0065:295-322`). That mirror does not transfer: `purchase_reversals` is **1:1** with a document that posts its own entry and whose `id = purchase_id`, whereas a `payments` row posts **NO journal entry at all** — it carries no `accounting_source_type` (`0081:2194`; only the three reducer relations carry one, `0081:322`, `:400`, `:466`). A fully-allocated payment's only entries are its allocation entries, and each of those is already an `allocation_reversals.original_entry_id` in the same command, so `NOT NULL` here forced **two rows claiming one journal reversal** — the second source identity `P4-AL-23`/`P4-AL-09` forbid. The column is therefore nullable and reserved for the ONE entry the payment level genuinely owns: the `customer_credit` entry of a surplus credit (`0081`'s R-93, posted by the caller "when there is one"). Where there is no surplus credit, the payment reversal binds no entry and its children carry every binding |
| **no `binding_source_id`, no `accounting_source_type`, and no binding FK on this table** | — | the consequence of the row above, and the sharper half of F3. A payment reversal is not an accounting source: it is the **parent of a set** of entry reversals. Its journal facts live on `allocation_reversals`, one per allocation, each binding its own entry; the one exception is the surplus credit's entry, which no allocation owns and which this row names in `surplus_credit_entry_id` without binding — the binding for it is the `allocation_reversals`-shaped row the command writes for that entry. A `GENERATED ALWAYS AS ('reversal')` column here would have registered the parent as a second identity for the same journal fact |
| **no** `reversed`, `status`, `voided` or `is_active` column | — | the append-only law. There is nothing on this table a later writer could flip |
| `payment_reversals_provider_pairing_ck` | `(provider_source IS NULL) = (provider_reference IS NULL)` | §1A. A reference with no source is unrepresentable, not refused |
| `payment_reversals_provider_ck` | each, when present, `char_length BETWEEN 1 AND 100 AND value = btrim(value)` | `payments.reference`'s own bound (`0081:258`): one shape law for provider-supplied text |
| **no** amount column of any kind | — | the exact-inverse law. An amount here would be a figure recomputed outside `accounting_post_reversal`, and a second statement of the payment's value |

### 1.2 Keys and FKs

| constraint | definition | why |
|---|---|---|
| PRIMARY KEY | `(business_id, id)` | the house shape |
| `payment_reversals_payment_uq` | `UNIQUE (business_id, payment_id)` | **one reversal per payment, for ever.** Not a `reversed` flag: the EXISTENCE of this row is the fact, which is `purchase_reversals`' own device (`0065:53`) and is why a second reversal is *unrepresentable* rather than refused by a check |
| `payment_reversals_surplus_entry_uq` | `CREATE UNIQUE INDEX … (business_id, surplus_credit_entry_id) WHERE surplus_credit_entry_id IS NOT NULL` — **PARTIAL, for the same reason as §1A.2** | `0065:314`'s law kept where it still applies: one reversal per entry. F3's replacement for `UNIQUE (business_id, original_entry_id)`, which under `NOT NULL` would have forced the parent to claim a child's entry. **Partial and not a plain UNIQUE over the nullable column**, even though `NULLS DISTINCT` would give the same outcome here: the test for a nullable key is whether NULL means *"no identity to protect"* or *"an identity not stated"*, and a reader cannot tell which a plain UNIQUE intends. Here it is the former — a reversal with no surplus credit has no entry at this level, and `payment_reversals_payment_uq` already makes it unique — so the predicate SAYS so, and one device is used twice in this file instead of two |
| `payment_reversals_binding_fk` — **removed** | — | there is no binding on the parent to constrain (1.1). The binding FKs live on `allocation_reversals` |
| `payment_reversals_tenant_fk` | `(tenant_id, business_id) → businesses (tenant_id, id)` | `0081:276` |
| `payment_reversals_payment_fk` | `(business_id, payment_id, customer_id) → payments (business_id, id, customer_id)` | pins both ends to one customer. `payments_identity_uq` (`0081:273`) is `(business_id, id, customer_id, currency_code)` and **contains** this prefix — but a FK needs a key on exactly its columns, so this edge either names the four columns (carrying `currency_code` too) or `payments` gains `UNIQUE (business_id, id, customer_id)`. **The four-column form is chosen**, because adding a key to an S4 table is S4's call, not S6's |
| `payment_reversals_provider_uq` | `CREATE UNIQUE INDEX … (business_id, provider_source, provider_reference) WHERE provider_reference IS NOT NULL` | §1A.2. **PARTIAL**, because `NULLS DISTINCT` is the default and a plain UNIQUE over these three columns would admit unlimited NULL-reference rows — green and vacuous for every merchant-initiated reversal |
| `payment_reversals_customer_fk` | `(business_id, customer_id) → customers (business_id, id)` ON DELETE RESTRICT | `0081:277` |
| `payment_reversals_credit_fk` | `(business_id, surplus_credit_id) → customer_credits (business_id, id)` | pins the surplus credit this reversal restores; NULL when there was none |

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

## 2A. The `chain_generation` columns (CHALLENGE FINDING F1)

`docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §1A is the argument; this is the DDL it implies, and it
is **the one structural change this specification gained after review**.

```
ALTER TABLE payment_allocations
  ADD COLUMN chain_generation BIGINT NOT NULL DEFAULT 0
    CHECK (chain_generation >= 0 AND chain_generation <= 1000000000);
ALTER TABLE customer_credit_applications
  ADD COLUMN chain_generation        BIGINT NOT NULL DEFAULT 0 CHECK (…),   -- the INVOICE chain
  ADD COLUMN credit_chain_generation BIGINT NOT NULL DEFAULT 0 CHECK (…);   -- the CREDIT chain
```

| field | statement |
|---|---|
| **what it holds** | the number of reversal rows on that chain whose freed level is at or below (for a descending credit chain: at or above) this row's own, **as of the moment this row was written**. Derived from the append-only reversal relations and from nothing else, so every party that sees the same reversals computes the same number |
| **why it exists** | it is the second column of the replacement UNIQUE key, which is what preserves the index's MUTUAL EXCLUSION on the unlocked path while letting a lawful successor sit at a freed level beside its immutable reversed original |
| **backfill** | **an EXPRESSION, never the constant `0` — see §2A.1.** Every existing row evaluates to `0` today, because no reversal relation exists before this migration creates one; but a `DEFAULT 0` taken as the backfill is silently wrong for any chain that already carries a reversal, and §2A.2 states why neither upgrade path can tell the two apart |
| **who writes it** | the existing settlement commands, under the canonical source lock, computed from the same chain read they already make. **No new writer**, and no second source of the level |
| **integrity** | the deferred verifier recomputes it for every ACTIVE row and refuses a disagreement — `invoice_settlement.settlement_generation_invalid`. It is therefore not a trusted client-supplied field, which is the whole difference between this and a `reversed` boolean |
| **what it is NOT** | not a status, not a flag, not mutable. It is written once with the row and never updated; activeness remains the anti-join and nothing here brings it back as a column |

### 2A.1 The backfill — an EXPRESSION, never a constant, and the ordering it forces

`DEFAULT 0` is a device for **new** rows. It is not the backfill, and treating it as one is the
failure mode of this change: a default of `0` is silently wrong for any chain that already
carries a reversal, and nothing in the catalogue would say so.

**The backfill is the generation law itself, evaluated over the append-only reversal rows and
nothing else:**

```
UPDATE payment_allocations a
   SET chain_generation = (
         SELECT pg_catalog.count(*)
           FROM public.allocation_reversals r
           JOIN public.payment_allocations o
             ON o.business_id = r.business_id AND o.id = r.reducer_id
          WHERE r.business_id = a.business_id
            AND r.invoice_id  = a.invoice_id
            AND o.ar_released_before_txn_minor <= a.ar_released_before_txn_minor);
```

— and the mirror of it for `customer_credit_applications`' two chains, the credit one with
`>=` over `credit_remaining_before_minor`, because that chain descends. **One expression per
chain, and it is the same expression the deferred verifier recomputes**, so the backfill and
the verifier cannot disagree: if they could, the migration would install data its own verifier
rejects.

**The ordering this forces, which corrects §6's step 0 as first written.** "Create the wider key
before dropping the narrower one" was right and too coarse — the expression is not evaluable
until the reversal relations exist, and the index must be built over backfilled values:

| # | step | why this position and no other |
|---|---|---|
| 0a | `CREATE TABLE allocation_reversals` (and `payment_reversals`), empty | the backfill expression names `allocation_reversals`; it cannot run before the relation exists |
| 0b | `ALTER TABLE … ADD COLUMN chain_generation BIGINT NOT NULL DEFAULT 0` | metadata-only on PostgreSQL 11+; no table rewrite |
| 0c | **run the backfill `UPDATE`**, then **assert** that the stored value equals the expression for **every** row | the assertion is what makes the constant and the expression distinguishable at all |
| 0d | `CREATE UNIQUE INDEX … (…, level, chain_generation)` | built over backfilled values; and still **before** any drop, so the relation is never without a unique key over the level |
| 1–4 | the guard, the widened verifier, the catalogue reads | unchanged |
| 5 | `DROP CONSTRAINT` the narrow level-alone keys | last, as before |

### 2A.2 The two upgrade paths, and the admission that NEITHER proves the expression

`§51`'s requirement, stated for both paths and then stated honestly:

| path | what happens | what it proves |
|---|---|---|
| **fresh install** (`check:db-from-zero`) | every relation is created empty in this same migration, so the `UPDATE` touches **0 rows** and the assertion of 0c iterates over nothing | **nothing.** An assertion over an empty set passes for the same reason an empty road has no collisions. It must be declared vacuous here and not counted as evidence |
| **real upgrade** (the accepted tree at S6's promotion) | every existing `payment_allocations` and `customer_credit_applications` row is visited, and the expression returns `0` for each — because `allocation_reversals` was created empty moments earlier and no reversal can predate the relation that records them | that the migration **applies** to real data without raising. It does **not** prove the expression, because every correct answer is also `0`: the constant and the law are indistinguishable on this data |

> **So the migration cannot prove its own backfill, on either path, and saying so is part of the
> specification.** Both paths agree with `DEFAULT 0` by construction, which is exactly the
> condition under which a wrong expression ships unnoticed.

**What does prove it** is a test that makes the non-zero case exist, and it is owed at level F:
seed a chain, reverse its tail through the command so a real `allocation_reversals` row exists,
then **re-run the backfill expression** over that chain and require it to return `1` for a row
at or below the freed level and `0` for a row below it — with the planted counterpart that a
backfill of the constant `0` **fails** that same assertion. Without the counterpart the test
would pass against the defect it exists to catch. It is listed in the contract pack §14 beside
the two-connection index proof, because both are claims a single-transaction, empty-table
migration cannot make.

**A second, cheaper floor the migration itself can carry:** assert that the column's
`pg_attrdef` default is `0` **and** that `count(*) FILTER (WHERE chain_generation <> 0) = 0`
**and** that `count(*) FROM allocation_reversals = 0`, as three readings of one claim — so a
future migration that adds a reducer relation to a tree that *does* hold reversals, and reuses
this shape, fails the third reading instead of inheriting the second. That is the only
mechanism that makes the vacuity of today's path visible to the person who first makes it
non-vacuous.

The replacement keys, created **before** anything is dropped (that document's §6 step 0):

```
payment_allocations_level_generation_uq
  UNIQUE (business_id, invoice_id, ar_released_before_txn_minor, chain_generation)
customer_credit_applications_invoice_level_generation_uq
  UNIQUE (business_id, invoice_id, ar_released_before_txn_minor, chain_generation)
customer_credit_applications_level_generation_uq
  UNIQUE (business_id, credit_id, credit_remaining_before_minor, credit_chain_generation)
```

---

## 3. The level-uniqueness replacement

Fully specified in **`docs/PHASE_4_S6_LEVEL_UNIQUENESS.md`** — the constraint-by-constraint
table, the QUADRUPLE that replaces each (§2A added the wider unique key, which the first draft lacked), the removal **order**, and the two-directional red proof
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
| **`invoice_outstanding(uuid, uuid[])` (`0084:593`) — THE ARRAY OVERLOAD, and the correction of a wrong target** | the two reducer branches of its `UNION ALL` (`0084:620-634`) each anti-joined against the reversal relations. **Mandatory**: an outstanding computed over reversed rows is a wrong receivable on the reader-of-record. **This row previously named `invoice_outstanding(uuid,uuid)` at `0081:1334`, and that was WRONG** (challenger F2, verified): that function is replaced three more times after `0081` — `0080:143`, `0083:242`, `0084:526` — and since `0083` it is a thin delegating wrapper with **no arithmetic at all**. The reducer `UNION ALL` lives only in the array overload, which `0084:516` records as the last `CREATE … FUNCTION invoice_outstanding` in the whole Phase 4 DDL **because seam `S-P4-03` reads the last definition of that name**. Widening the scalar wrapper would have changed nothing and every invoice would have kept subtracting the reversed reducer for ever | none — it is a reader |
| `invoice_outstanding(uuid,uuid)` (`0084:526`) | **NOT WIDENED, and that is the specification.** It holds no arithmetic: it projects four columns off a one-element array call. Adding an anti-join here would be a second statement of the settlement sum, which `P4-AL-07` and law 7 both forbid | — |
| `customer_credit_consume(uuid,bigint,bigint)` (`0081:1224`) + `customer_credit_guard()` (`:1070`) | one more lawful transition: the **restoration** a reversal makes. Same single writer (R-90), given one more legal move — never a second writer | `customer_credit.restore_invalid` |
| `accounting_reversals_20_domain_source_guard()` (`0081:1405`) | `customer_payment_allocation`, `customer_credit_application` and `customer_credit` move from the plain refusal list to a `purchase`-style **paired** arm: admitted **iff** a paired `allocation_reversals` / `payment_reversals` row exists for the entry. The mechanism is `0081:1410-1413` applied to three more types | none — the existing `accounting.reversal_source_domain_owned` now has three narrower arms |
| `purchase_settlement_verify(uuid,uuid)` (`0067:717`) | the ACTIVE subset, for TD-15. Awaits a promotion-time ruling, and is not a blocker on the customer half: its `prosrc` SHA-256 is recorded inside **frozen** `0067` (`:1817`) and read by an existing Phase 3 suite. `PATCH-REQ-S6-005`; `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §5.2 | — |

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

### 5.3 `invoice_voids` — the void's own row, and WHY the spec needed a third relation (CHALLENGE FINDING F6)

```
tenant_id               UUID NOT NULL
business_id             UUID NOT NULL
id                      UUID NOT NULL          -- the client-chosen void id
invoice_id              UUID NOT NULL
void_date               DATE NOT NULL
reason                  TEXT NOT NULL
revenue_entry_id        UUID NOT NULL          -- the entry the void reverses, exactly once
intent_sha256           TEXT NOT NULL
business_transaction_id UUID NOT NULL
created_by              UUID NOT NULL
created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
```

| constraint | definition | why |
|---|---|---|
| PRIMARY KEY | `(business_id, id)` | the house shape |
| `invoice_voids_invoice_uq` | `UNIQUE (business_id, invoice_id)` | one void per invoice, for ever; the existence of the row is the fact |
| `invoice_voids_entry_uq` | `UNIQUE (business_id, revenue_entry_id)` | `P4-AL-47`: one whole-entry reversal per entry |
| `invoice_voids_intent_ck` | `intent_sha256 ~ '^[0-9a-f]{64}$'` | `0081:265` |
| `invoice_voids_reason_ck` | `char_length(reason) BETWEEN 1 AND 200 AND reason = btrim(reason)` | as the other two |

**The finding, accepted in full.** The void had **no idempotency**: there was no
`invoice_void.idempotency_conflict` code where both other domains carried one, and **no
relation anywhere held a void's `id` or `intent_sha256`** — so `invoices_direct_void_guard()`
(§5.1) was specified to prove the existence, in this transaction, of a row no table in this
specification created, and resending one `voidId` with a different `reason` or `voidDate` had
no refusal path at all. Law 7 (idempotency: same identity, same intent hash, exact replay,
CONFLICT on a changed intent) was unmet for one of the three commands.

This relation is what §5.1's guard proves the existence of, and what the replay compares
against. The code is now in the closed set
(`invoice_void.idempotency_conflict`, `packages/inventory/src/customer-reversal.ts`), beside
`invoice_void.date_invalid`, which the same review produced (the date comparison was
lexicographic over unvalidated strings, so a non-canonical date earlier than the original
passed the ordering law — a validated canonical `YYYY-MM-DD` is now required first).

**Scope note:** `docs/PHASE_4_EXECUTION_PLAN.md:194-196` names `payment_reversals` and
`allocation_reversals` for S6 and does not name this one. It is specified here because `S6`
owns `void_invoice` and because a command with no identity row cannot satisfy law 7; it is
flagged for the coordinator rather than assumed, and the contract pack's §14 carries it.

---

## 5A. The three command routines (CHALLENGE FINDING F4)

**The finding, accepted.** The first draft registered three `invctl/1` operation kinds and
specified **no command routine at all**. `operationKindLaw`
(`tests/security/phase3-s8-operation-kinds.test.ts:103`) is deliberately unscoped and its
clause 1 requires **exactly one** consuming routine per registered kind, owned by
`daftar_inventory_internal` with `EXECUTE` exactly `{daftar_app}`. So registering the kinds
without the routines **necessarily reddens an accepted suite S6 may not edit** — the same
cross-phase breakage class I correctly raised for `purchase_settlement_verify` and missed
here, one section away.

| routine | kind it consumes | owner / EXECUTE |
|---|---|---|
| `customer_reverse_payment(…)` | `customer.reverse_payment` | `daftar_inventory_internal` / `{daftar_app}` |
| `customer_reverse_allocation(…)` | `customer.reverse_allocation` | ditto |
| `sale_void_invoice(…)` | `sale.void_invoice` | ditto |

Each one, to satisfy the law's other clauses: consumes its kind **exactly once**, with the
kind as a **literal** first argument; passes the **same literal** to
`inventory_claimed_payload_digest` (clause 3); names in `inventory_assertion_current` only
registered kinds (clause 4); and is the only consumer of its kind in the catalogue (clause 1).
**The registration and the routines land in ONE migration**, because a migration that
registers a kind and leaves it unconsumed is red between the two.

---

## 6. RLS, grants and ownership

`ENABLE` + **`FORCE`** ROW LEVEL SECURITY on both relations, and the **seven-policy** set of
`0081:528-603` verbatim in shape: `tenant_membership` (permissive, both halves);
`business_isolation_read` / `_insert` / `_update` / `_delete` as **RESTRICTIVE**;
`inventory_internal_read` and `accounting_validator` as `FOR SELECT TO <role> USING (true)`.
`TL-P4-RLS-INT-01` is RULED: the last two are **intentional** and are not narrowed.

```
REVOKE ALL ON payment_reversals, allocation_reversals, invoice_voids FROM PUBLIC;
GRANT SELECT                 ON all three TO daftar_app;                 -- NO DML (P4-AL-38)
GRANT SELECT, INSERT         ON all three TO daftar_inventory_internal;  -- append-only: no UPDATE, no DELETE
GRANT SELECT                 ON all three TO daftar_accounting_internal; -- a validator that cannot read passes vacuously
```

**No `GRANT UPDATE` on `payments`.** An earlier draft asked for a one-column `UPDATE` grant on
that S4-owned table, purely to satisfy the locking-clause ACL of a `payments` row
`FOR UPDATE` — and that lock has been **removed** (contract pack §8.1, challenger F11): it
serialised nothing that the advisory `daftar.payment_id` key and
`payment_reversals_payment_uq` do not already. The grant went with it. **A privilege asked for
to support a lock that is not needed is a privilege asked for nothing**, and on a table this
slice does not own.

**`daftar_inventory_internal` is granted no `UPDATE` and no `DELETE` on either reversal
relation.** The append-only law is not a convention here — the writer **cannot** mutate a
reversal row, and the privilege list is the proof.

The mechanism that made the withdrawn grant necessary is still worth recording, because the
same question returns for every row lock: PostgreSQL requires `SELECT` **plus one of**
UPDATE/DELETE/TRUNCATE for `FOR UPDATE`, and `SELECT` alone raises before any body logic runs
(`0081:620-631`). So **a lock implies a privilege**, and the cheapest way to avoid asking for
a privilege on another slice's table is not to need the lock. The `invoices` `FOR UPDATE` of
step 3 does need one, and it already exists — `GRANT UPDATE (status) ON invoices TO
daftar_inventory_internal` (`0081:682`), which is also the grant the void's own status write
uses (assumption S4-7).

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

1. `pg_class.relrowsecurity` and **`relforcerowsecurity`** true for all **three** relations
   (`payment_reversals`, `allocation_reversals`, `invoice_voids`).
2. `pg_policy`: exactly the seven policy names per relation, each with the expected
   `polpermissive` and `polcmd` — the `c_source` array device of `0081:2497`.
3. `pg_constraint`: every constraint of §1.1–§1.2, §2.1–§2.2 and §5.3 present with the
   expected `pg_get_constraintdef`; **the three WIDER `*_level_generation_uq` names PRESENT
   and unique over the generation column** (§2A); and **only then** the three replaced
   `*_level_uq` names ABSENT. Both halves in one read, in that order: asserting the absence
   without asserting the presence is how a migration loses the protection it meant to
   replace.
3b. `pg_index`: `payment_reversals_provider_uq` present, unique, **and PARTIAL** — its
   `indpred` is not null. A read that checked only `indisunique` would pass on the plain
   index whose vacuity §1A.2 is about, so the predicate is part of the assertion.
3a. `pg_attribute` + `pg_constraint`: `chain_generation` on `payment_allocations` and
   `customer_credit_applications`, and `credit_chain_generation` on the latter, each
   `NOT NULL` with its range CHECK; and **no column named `reversed`, `voided`, `is_active`
   or `status` on either reducer relation or on any of the three new ones** — the append-only
   law as a catalogue read rather than a convention.
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
   (`P4-AL-20`) — **and, in the same read, exactly one consuming routine per kind**, owned by
   `daftar_inventory_internal` with `EXECUTE` exactly `{daftar_app}` (§5A). A registered kind
   with no consumer reddens `tests/security/phase3-s8-operation-kinds.test.ts` clause 1, so
   the migration's own end state must refuse that state rather than leave an accepted suite
   to discover it.
9a. `pg_proc`: `supplier_settlement_guard_gaps()`'s recorded digest for
   `purchase_settlement_verify(uuid,uuid)` equals
   `encode(sha256(convert_to(prosrc,'UTF8')),'hex')` of the body **installed by this
   migration**, and the recorded-digest COUNT is unchanged — a replacement, never an
   addition (`PATCH-REQ-S6-005`).
10. **No tax-named column** on either relation: `od03Problems`
    (`tests/security/phase3-s8-grant-matrix.test.ts:174`) reads every column matching
    `(^|_)tax(_|$)` on every relation in `public`, and "nothing is permitted by being named,
    only by being structurally zero". Neither relation carries one.

---

## 8. Upgrade expectations

1. **Forward-only.** No `DROP TABLE`, no column drop on an existing relation, no data
   rewrite. The three constraint drops of §3 are the only removals, each paired with its
   replacement **in the same migration** and **created before it**, in the order
   `docs/PHASE_4_S6_LEVEL_UNIQUENESS.md` §6 gives — step 0 first, step 5 last.
2. **Three columns are ADDED to two existing relations** (§2A), each
   `NOT NULL DEFAULT 0`. On PostgreSQL 11+ that default is stored in the catalogue and the
   table is not rewritten, so the add is metadata-only. **The backfill is an EXPRESSION and
   not that default** (§2A.1): it evaluates to `0` for every existing row today, because no
   reversal relation exists before this migration creates one, but the migration **runs the
   expression and asserts the stored value equals it** rather than trusting the constant.
   §2A.2 states the uncomfortable half: on both the fresh-install and the real-upgrade path
   every correct answer is also `0`, so neither path can distinguish the law from the
   constant, and the proof is owed at level F with a planted counterpart.
2a. **No other existing row changes.** Not one row of `payment_allocations`,
   `customer_credit_applications` or `customer_credits` is updated by this migration beyond
   the metadata-only default above; the three new relations are seeded empty. The append-only
   law holds across the upgrade itself, and the end-state block asserts a row count of 0 on
   all three.
2b. **The wider unique key cannot fail on existing data**, and that is checkable before it is
   created: every existing row has generation `0`, so the new key `(…, level, 0)` is
   order-isomorphic to the old key `(…, level)`, which the old constraint already enforced.
   A `CREATE UNIQUE INDEX` that could raise on live data would be an upgrade that fails in
   production and passes on an empty database.
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
