# P4-S3 — Migration design (Agent E, the single migration owner)

> **Status: `0079_phase4_pos_till_sessions_cart.sql` is DELIVERED and is a CANDIDATE.**
> It carries no `MIGRATION_MANIFEST.json` entry and `frozenThrough` still reads
> `0078_phase4_sale_commit.sql`: only a Tech Lead acceptance commit freezes a digest, and freezing one
> early turns `check:migrations` red on the next edit of the same file (`TL-P4-S1-C8`).
> `PHASE4_S3_PREFIX` in `scripts/phase4-prefix.ts` stays **empty** for the same reason.
>
> Every claim below was verified against the code, or measured on a from-zero database built through
> `0079` on an isolated cluster (`PG_PORT=55110 PG_DIR=/tmp/daftar-pg-e`, and
> `DB_FROM_ZERO_PORT=55111` for `check:db-from-zero`). Where a document and the code disagree, the code
> is recorded and the conflict is reported in §10.

---

## 1. What P4-S3's schema must carry, and where the requirement comes from

| obligation | source |
|---|---|
| `pos_till_sessions`, `pos_cart_lines`, **named so a prefix rule can refuse Phase 6's public checkout cart** | plan `docs/PHASE_4_EXECUTION_PLAN.md:321`, `:161-170`; lock `P4-AL-86` (`:1509-1515`) |
| both carrying `tenant_id` + `business_id` as real columns | `P4-AL-08` (`:270-283`, which names these two relations explicitly as *additional*) |
| every edge between two commercial rows a composite FK naming `business_id` | `P4-AL-09` |
| RLS `ENABLE` **and** `FORCE`, with the accepted policy set | `P4-AL-38` as corrected by `TL-P4-S1-C2`; the shapes are `0077`'s `sale_items` and `0063:555-568`'s purchase bridge |
| the general Phase 4 RLS/FORCE **discovery** guard must pass over them | `TL-P4-S1-R2`; `scripts/guards/phase4-rls-force.ts` |
| **one session, one authenticated user** | **`OD-P4-09` RULED, OPTION A** (`:1717-1724`) |
| **discount only — the client may request a discount and nothing else about price** | **`OD-P4-02` RULED, OPTION A** (`:1614-1623`) |
| the cart lives on the server, keyed by the till session; a client-side cart that posts a finished basket is the forged-totals attack with no attacker required | `P4-AL-18` (`:447-458`) |
| integer minor units only; no stored derived truth | `P4-AL-05`, `P4-AL-06`, `P4-AL-15b` |
| `daftar_app` gets **no DML on any Phase 4 table** | `P4-AL-38` (`:834-836`) |
| every Phase 4 definer routine verifies a signed server decision | `P4-AL-39` (`:845-850`) |
| **no accounting object at all** | plan `:321` verbatim |
| a till is bound to a branch | `P4-AL-40` (`:858-864`) — honoured in part; see §9.1 |

---

## 2. How many migrations, and why

**One.** `0079` carries both relations, both lifecycle guards, the four till commands, the registry
rows, the privileges, the end state and the performed proofs.

This departs from the `0077`/`0078` and `0063`/`0064` two-file split, and the reason is not stylistic.
That split exists where the DDL file must commit a registered source type, a bridge and a deferred
binding apparatus **before** a writer exists, so the writer's own privileges and body digests are a
second, separable end state. P4-S3 has none of that: no accounting source type, no stock source type,
no bridge, no deferred binding, no journal shape. What is left is two ordinary relations, two triggers
and four commands, and splitting them would commit **four registered `inventory_operation_kinds` rows
with no writer** for one migration's width — precisely the dead-registry state `TL-P4-S1-R1` and
`TL-P4-S2-K1` refused. An `inventory_operation_kinds` row is a registration of AUTHORITY, so the
registration and its writer belong in the same file.

It is also the brief's constraint: this slice gets exactly `0079` and nothing else.

---

## 3. `pos_till_sessions` — the shift, and `OD-P4-09` as a constraint

### 3.1 The columns, and the ones that are deliberately absent

```
tenant_id, business_id, id            P4-AL-08 + the (business_id, id) primary key every
                                      Phase 4 relation uses
branch_id, warehouse_id               P4-AL-40 (the till is bound to a branch) and the shelf
                                      the basket will consume from
terminal_code                         the physical till, held to the invpl/1 `code` grammar
currency_code                         the denomination of every minor-unit figure beneath it
status                                'open' | 'closed'
opened_by, opened_at                  the ONE authenticated user, and when
closed_at                             null while open
open_intent_sha256, close_intent_sha256   the two idempotency intents
business_transaction_id               the repo-wide correlation id (TL-P4-S1-C13: not a
                                      polymorphic reference; no `business_transactions` relation
                                      exists anywhere in the tree)
```

There is **no cashier count, no float, no drawer total and no expected-cash figure.** Each of those
is a money column on a shift, and every one of them is either a client's number or a derivation from
the sales of the shift — `P4-AL-05` and `P4-AL-06` refuse the second and `P4-AL-18` refuses the first.
A till reconciliation feature is a later slice's, and it will be built against the sales, not against
a stored total here.

`currency_code` is on the SESSION and not on the line. A basket therefore cannot hold two
denominations at once, which is a structural fact rather than a validation, and
`requested_discount_minor` has exactly one meaning without carrying a currency of its own.

### 3.2 `OD-P4-09`, as four physical facts

The ruling is "one till session = one authenticated user; a change of user is a new session". A service
that checks the actor before writing is a **convention**, because `daftar_inventory_internal` — the
trusted generic principal every inventory command runs as — can still write the row. So:

| # | mechanism | what it makes unrepresentable |
|---|---|---|
| (a) | `pos_till_sessions_actor_uq UNIQUE (business_id, id, opened_by)` | nothing by itself — it is the **candidate key** that makes (b) expressible at all (the `0063:392` / `sale_items_bridge_uq` idiom, used for an ACTOR edge instead of a line edge) |
| (b) | `pos_cart_lines_session_actor_fk FOREIGN KEY (business_id, till_session_id, added_by) REFERENCES pos_till_sessions (business_id, id, opened_by)` | **a cart line added by anyone but the session's own user.** There is no parent tuple to point at, so the refusal is the referential integrity of the database. This is the ruling. |
| (b′) | the same edge, `ON UPDATE RESTRICT` | reassigning the session's user while a basket exists |
| (c) | `pos_till_sessions_one_open_per_user_uq UNIQUE (business_id, opened_by) WHERE status = 'open'` | **a second open session for one user.** "A shift change is a new session" becomes a uniqueness fact |
| (d) | `pos_till_session_guard()`'s `opened_by` clause, with its own error code `pos.till_session_actor_immutable` | reassigning the session's user when the basket is still EMPTY — the one window (b′) cannot see, because there is no referencing row to restrict |

Note that (b) also does the `P4-AL-09` job: the edge names `business_id` on both sides, so a
cross-business basket is not representable either. One foreign key, two laws.

And `pos_till_sessions_one_open_per_terminal_uq UNIQUE (business_id, branch_id, terminal_code) WHERE
status = 'open'` closes the other half of the ruling's **own risk sentence** — "a cash-drawer
discrepancy then has no single owner". Two open sessions on one physical till reproduce exactly that:
one drawer, two owners. This is the one thing in `0079` that the ruling implies rather than states, and
it is called out here so a reviewer can refuse it if they read the ruling more narrowly.

A **fifth** expression, at the privilege level: the internal writer's `UPDATE` on `pos_till_sessions`
is column-level on `(status, closed_at, close_intent_sha256, business_transaction_id)` and **nothing
else**, so `opened_by` is not a column anybody may write. `0079-E(6)` asserts that column list exactly.

### 3.3 Why `opened_by` is a single-column reference

`users` is a global relation (`PRIMARY KEY (id)`), so `P4-AL-09`'s composite rule — which is about
edges between two **commercial** rows — does not apply to it, and the accepted precedent is `0077`'s
`sales.created_by`, `confirmed_by` and `voided_by`. `0079-E(13)` states this as a PROPERTY of the
target rather than as two exempt names: an edge whose target's primary key contains `business_id` must
name `business_id`; an edge to a relation whose primary key does not is a global edge. A later edge to
a third global relation is then judged by the same rule instead of needing a new exemption.

---

## 4. `pos_cart_lines` — the server-side cart

### 4.1 The whole relation, and why the absences are the design

```
tenant_id, business_id, till_session_id, id      identity
line_no                                          display order, UNIQUE per session among LIVE lines
product_id, variant_id                           WHAT is being sold
quantity          NUMERIC(18,4)                  HOW MUCH (Q4 — the scale
                                                 inventory_fixed_text(…, 4) canonicalises)
requested_discount_minor  BIGINT                 THE CLIENT'S DISCOUNT REQUEST, integer minor
                                                 units of the SESSION's currency
added_by, added_at                               the actor (OD-P4-09's subject) and when
removed_at        TIMESTAMPTZ NULL               THE TOMBSTONE — NULL is "in the basket"
```

**The basket is APPEND-ONLY, and a removal is a tombstone.** This is not a stylistic preference; it is
what the accepted estate already requires of a relation beyond the accepted prefix. The append-only
clause at `tests/security/inventory-db-authority.test.ts:284-302` states the contract positively: the
internal writer holds **no `DELETE`, no `TRUNCATE`, no table-level `UPDATE`, no `REFERENCES` and no
`TRIGGER`** on any relation the accepted prefix did not create, so a row it writes cannot be removed or
rewritten wholesale and a lifecycle change is confined to columns somebody granted **by name**. An
earlier draft of `0079` granted `DELETE ON pos_cart_lines`; round 1 of the full estate refused it in
three assertions of that file, and §12 records the round. So:

- `removed_at` is granted by name, alongside the quantity and the discount request;
- the line ordinal is a **partial** unique index, `WHERE removed_at IS NULL`, so a tombstone releases
  its ordinal and the till may put a new line 2 where the old line 2 was (`0079-E(4e)` reads the
  predicate and the column list from `pg_get_indexdef`);
- a tombstone is **final** — un-removing would make `removed_at` a two-way flag and the basket a
  mutable document again (`pos.cart_line_removed`);
- `pos_cart_line_guard()` refuses a `DELETE` outright, so the append-only basket survives a later
  migration that grants a `DELETE` by accident. `0079-E(7)` asserts that from the shipped body, and
  asserts the absence of `RETURN OLD` anywhere in either guard, because a `BEFORE DELETE` row trigger
  permits the delete precisely by returning `OLD`.

The whole basket of a closed shift — live lines and tombstones alike — is therefore the record of that
shift, which is strictly more than the earlier draft preserved.

**Absent, on purpose, every one of them asserted absent from the live column list by `0079-E(3)`:**
`unit_price_*`, `gross_*`, `net_*`, `subtotal_*`, `line_total_*`, `total_*`, `amount_*`, `tax_*`,
`*_rate`, `*_percent`, `value_*`. Also absent: any `reserved_*` or `available_*` quantity, because a
cart reserves nothing (`NEVER_STORED` in `scripts/guards/no-authoritative-balance.ts`, and `P4-AL-06`
for the quantity behind it).

The cart's total is **derived at read time** from the catalogue. That is the `P4-B` budget's whole
subject ("server-side cart recomputation, 20 lines with discounts and tax, p95 ≤ 60 ms",
lock `:1333`), and a stored total would make the budget measure a cache instead of the computation it
is supposed to bound. It would also be a second writer's truth: the catalogue price can change between
two reads, and a stored line total would then disagree with the catalogue while both looked
authoritative.

### 4.2 The discount is a REQUEST, and nothing else about price exists

`OD-P4-02` is **OPTION A, discount only**. Three consequences, each physical rather than procedural:

1. **One column, named as a request.** `requested_discount_minor` is the only money column in the
   slice — `0079-E(3)` asserts that the set of `%_minor` columns across both relations is exactly
   `{pos_cart_lines.requested_discount_minor: bigint}`. Nothing in the database derives from it.
2. **No second column for what was GRANTED.** The granted discount is a fact of the SALE
   (`sale_items.discount_txn_minor`, `0077`), written by `sale_commit` under the `sales.discount`
   permission. A `granted_discount_minor` here would be a second record of one decision, and the two
   could disagree.
3. **No cap on the cart, deliberately.** A discount cannot exceed the line's gross — and the gross is
   exactly what the cart does not store, so the cap is not expressible here. It is already enforced
   where the gross lives: `sale_items_discount_ck` (`0077`, `discount_txn_minor <= gross_txn_minor`).
   Capping an uncapped request at the till would require resolving a price in the cart, which is the
   thing `P4-AL-18` reserves for the server at commit time.

There is also **no percentage representation**, because a percentage must be resolved against a price
to mean anything, and `0079-E(3)`'s price vocabulary includes `percent` so one cannot be added without
turning the migration's own end state red.

### 4.3 No tax column at all

`0077` carries `tax_minor BIGINT CHECK (tax_minor = 0)` on both money-bearing relations because a
sale's total arithmetic names a tax term. A cart line carries no total, so it needs no term — and the
strongest expression of `OD-03` BEING OPEN is a relation on which a tax is **not writable**.
`0079-E(3)` asserts the absence from the live column list. The grant-matrix suite's OD-03 arm
(`tests/security/phase3-s8-grant-matrix.test.ts:533`, "every tax column anywhere in public is either
one of the three or a structural zero") is satisfied vacuously and correctly: there is no tax column
to judge.

---

## 5. Row security and privileges

### 5.1 Six policies on each, and the accounting principal shut out from both sides

Both relations are ordinary relations, so each carries the accepted **six**: one permissive
`tenant_membership`, four `RESTRICTIVE` per-command isolation policies, and `inventory_internal_read`.
Neither carries the seventh `accounting_validator`, because neither is an accounting-source relation —
P4-S3 creates no accounting object.

The tenant policy takes the **direct** `tenant_id = nullif(app_tenant(), '')::uuid` form `0052:305-330`
adopted after measurement, never `0063:555-557`'s correlated `businesses` subselect. That is available
here precisely because both relations carry `tenant_id` as a real column — the same reasoning `0077`
recorded for `stock_source_bridge_sale`.

`business_isolation_read` admits `current_user = 'daftar_inventory_internal'` and **not** the
accounting principal. The reads were re-derived from the bodies rather than assumed:
`pos_cart_line_guard()` reads `pos_till_sessions`, and the four commands read both relations, all as
`daftar_inventory_internal`. An assumed read is how a vacuous pass gets in (`TL-P4-S1-C2`).

`0079-E(2)` asserts all four halves — the six names, the direct tenant form, the inventory principal
admitted, the accounting principal **not** admitted — plus that `daftar_accounting_internal` holds no
privilege of any kind on either relation. `0079-E(5)` closes it from the other side: it owns none of
the POS routines and may execute none of them. A slice that creates no accounting object must not
leave an accounting principal a seam, and a policy without a grant or a grant without a policy each
look harmless alone.

### 5.2 The privileges, and the fifth expression of `OD-P4-09`

| principal | `pos_till_sessions` | `pos_cart_lines` |
|---|---|---|
| `daftar_app` | `SELECT` | `SELECT` |
| `daftar_inventory_internal` | `SELECT`, `INSERT`, `UPDATE (status, closed_at, close_intent_sha256, business_transaction_id)` | `SELECT`, `INSERT`, `UPDATE (quantity, requested_discount_minor, removed_at)` |
| every other runtime principal, PUBLIC | — | — |
| `daftar_accounting_internal` | — | — |

Four things in that table are decisions:

- **No DML for `daftar_app`,** which is `P4-AL-38` in terms. Every write goes through a command whose
  authority was checked, and the closure is the GRANT, not the wrapper.
- **`UPDATE` is column-level, never table-level** (the `0063:597` / `0077` shape). A table-level
  `UPDATE` would let the trusted generic primitive write a column the lifecycle guard happens not to
  name. `0079-E(6)` asserts both column lists exactly and asserts there is no table-level `UPDATE`
  behind them.
- **No `DELETE` and no `TRUNCATE` on EITHER relation, for anyone.** A shift is history the moment it
  opens, and a basket is the append-only record of that shift (§4.1, `R-P4-S3-08`). `0079-E(6)`
  asserts that over both relations, so the migration refuses the deployment round 1 refused.
- **Removing a line is the `removed_at` column grant,** and the guard binds every write — the removal
  included — to an OPEN session, so a closed shift's basket is frozen evidence rather than editable
  history.

`infrastructure/database/phase3-runtime-grant-model.json` is extended to match, in the three places
the grant-matrix suite reads: `select.daftar_app.tables`, `execute.daftar_app`, and
`internalWriterTablePrivilegesBeyondPhase3Scope.daftar_inventory_internal` with a
`whyThePosRelationsTakeThose` note. That suite compares the model against the live catalogues **in both
directions over the whole discovered surface**, so a grant the database holds and the model does not is
an unreviewed privilege and is red — which is the change a reviewer must see.

---

## 6. The four commands, and their payload grammars

`daftar_app` holds no DML, so the cart needs writers. Each is a `SECURITY DEFINER` with
`search_path = pg_catalog, public, pg_temp`, owned by `daftar_inventory_internal`, `EXECUTE` to
`daftar_app` and to nobody else, and each **first** consumes an `invctl/1` assertion of its own
registered kind over its own arguments (`P4-AL-39`). The business, the tenant **and the actor** come
from that verified assertion and never from an argument — which is what makes `OD-P4-09`'s actor a
signed fact rather than a client's word. `0079-E(8)` asserts the first-executable-statement property
per command from `prosrc` (the `0078-E(11)` claim), that no command takes an actor as a named argument,
and that none builds SQL at run time.

The minter (`packages/inventory/src/payload.ts`) is held byte-identical to `inventory_payload_digest`
by the shared vectors, so the grammar of each command is written out here field by field. A command
whose grammar is not written down is a command nobody can mint for.

| command | op code | `invpl/1` fields, in order |
|---|---|---|
| `pos_till_session_open(uuid, uuid, uuid, text, text)` | `pos.session_open` | `uuid` session id · `uuid` branch · `uuid` warehouse · `code` terminal · `code` **lower-cased** currency |
| `pos_till_session_close(uuid)` | `pos.session_close` | `uuid` session id |
| `pos_cart_set_line(uuid, uuid, integer, uuid, uuid, numeric, bigint)` | `pos.cart_set_line` | `uuid` session · `uuid` line id · `integer` line_no · `uuid` product · `uuid` variant · `integer` `inventory_fixed_text(quantity, 4)` · `integer` requested discount minor |
| `pos_cart_remove_line(uuid, uuid)` | `pos.cart_remove_line` | `uuid` session · `uuid` line id |

Two notes on the grammar. The currency is hashed **lower-cased** because the `code` grammar is
`^[a-z][a-z0-9_]{0,31}$` (`0054:206`) and an ISO code is upper-case; the column stores
`upper(p_currency_code)` and the routine refuses an argument that is not already upper-case, so there
is exactly one spelling in the database and exactly one in the preimage. And `terminal_code` is held to
the `code` grammar **by a named CHECK on the column** as well as by the payload: a till name outside
that grammar is a name no minter can canonicalise, so an assertion covering it cannot exist, and the
column's CHECK makes the state unreachable from the other direction too. `0079-P(c)` performs that
refusal.

### 6.1 Behaviours worth recording

- **`pos.session_open`** locks `hashtext('daftar.pos_till_session_id')` (the `supplier_create`
  idiom), replays on an equal `open_intent_sha256`, and refuses a replay presented by a **different
  user** with `pos.till_session_not_yours` — a second user holding the first user's intent is not a
  replay, it is a takeover. The two partial unique indexes are translated into
  `pos.till_session_already_open` and `pos.terminal_already_open`, so the till gets a stable business
  refusal while the DECISION stays the index's.
- **`pos.session_close`** refuses a session that is not the actor's own, and **does not delete the
  basket**: a closed session and its lines are the frozen record of the shift.
- **`pos.cart_set_line`** is an upsert by line id. A line id already naming different identities is
  `pos.cart_line_conflict`; otherwise the quantity and the discount request are revised. On INSERT,
  `added_by` is the assertion's actor and nothing else, so
  `pos_cart_lines_session_actor_fk` — not the body — refuses a line on another user's session; the
  body only translates `23503` into `pos.till_session_not_yours`.
- **`pos.cart_remove_line`** writes `removed_at = now()` — never a `DELETE` — and carries `added_by`
  in its predicate, because the actor edge cannot refuse a *revision* of a row that already satisfies
  it. `AND removed_at IS NULL` is what makes the second tap return `0` rather than write a second
  tombstone with a later instant, so a repeated removal is `0` and not an error.

### 6.2 The registry rows

`inventory_operation_kinds` gains exactly four rows, each `registered_by = 'P4-S3'`, **after** every
guard and every command exists. There is **no** `inventory_operation_movement_kinds` row, no
`stock_movement_kinds` row and no `stock_source_types` row: a till session and a basket move no stock.
An operation kind with no movement kind is the accepted shape — `supplier.create` (`0064:1500`) and
`inventory.stocktake_open` (`0062:1517`) are exactly that. `0079-E(9)` asserts the four as an equality
over the `P4-S3`-registered subset (never a count over the whole registry, `P4-AL-88`) and asserts the
three absences.

---

## 7. The one concurrency decision, measured

`pos_cart_line_guard()` reads its session row **`FOR NO KEY UPDATE`** and not with a bare `SELECT`.
That is the protection, not a decoration:

- the foreign key takes `FOR KEY SHARE` on the session row;
- closing a session is a **non-key** `UPDATE`, which takes `FOR NO KEY UPDATE`;
- `FOR KEY SHARE` and `FOR NO KEY UPDATE` **do not conflict**.

So with a bare `SELECT` — or with the foreign key alone — a line could be added to a session that a
concurrent transaction is closing, and the basket of a finished shift would grow after the fact.
`FOR NO KEY UPDATE` conflicts with the close's own lock, so one of the two waits and the loser sees the
committed truth. `0079-E(7)` asserts the clause is in the live body, because a guard that reads without
locking looks identical to one that locks.

---

## 8. How the deployment is proved, and what is OWED

### 8.1 What `0079` proves about itself

`0079-E(1)…(13)`, every claim a catalogue read and none of them a restatement of a statement in the
file (`R-P4-S3-01`). The two lessons the brief names are both load-bearing here: a `GRANT` issued
without grant option **warns and commits**, so the only way to know a privilege is held is
`aclexplode()`/`has_table_privilege()`; and a migration asserting its own end state must read
`pg_policy`, `pg_proc`, `pg_index`, `pg_trigger` and `pg_constraint` rather than trusting what it just
wrote.

| block | claim |
|---|---|
| E(1) | both relations are plain tables with `relrowsecurity` **and** `relforcerowsecurity`, and both carry `tenant_id` + `business_id` NOT NULL |
| E(2) | exactly the six ordinary policies by NAME on each; the direct tenant form; the inventory principal admitted in the restrictive read and the accounting principal not; `daftar_accounting_internal` holds no privilege |
| E(3) | no derived-truth column, **no price-vocabulary column**, no float/money column, and the slice's `%_minor` set is exactly the one discount request |
| E(4a–e) | `OD-P4-09`: the candidate key; the composite actor FK, both column lists in order, validated, RESTRICT on delete **and** update; the THREE partial unique indexes with their predicates read from `pg_get_indexdef` — one open shift per user, one per terminal, and one LIVE line per ordinal; and the live guard body refusing a change of `opened_by` |
| E(5) | **no accounting object**, six ways: no POS accounting source type, no POS accounting operation kind, no accounting column, no FK into the accounting estate, no POS routine on `journal_entries`, and no command body naming the ledger or the stock ledger |
| E(6) | the privileges from the catalogue: `daftar_app` reads; no runtime principal holds DML or any column privilege; the internal writer's writable column lists exactly; no table-level `UPDATE`; nobody but the owner may `DELETE` or `TRUNCATE` **either** relation |
| E(7) | both guards are pinned DEFINERs owned by the inventory principal with no grantee; both triggers installed as enabled `BEFORE INSERT OR UPDATE OR DELETE` row triggers (`tgtype = 31`); the cart guard's `FOR NO KEY UPDATE`; both guards RAISE on `DELETE` and neither returns `OLD` anywhere |
| E(8) | the four commands: pinned, default-free DEFINERs; `EXECUTE` held by `daftar_app` **alone**; the assertion consume as the first executable statement; no actor argument; no run-time SQL |
| E(9) | exactly the four POS operation kinds for `P4-S3`, and no stock registration |
| E(10) | `inventory_apply_stock_movements` is still one routine, still the inventory principal's, still refusing an oversell; `inventory_stock_source_guard_gaps()` still reports no gap |
| E(11) | both relations are EMPTY — a migration is not a writer |
| E(12) | `CREATE ON SCHEMA public` handed back; `daftar_sales_internal` does not exist |
| E(13) | every edge to a business-scoped relation names `business_id` (`P4-AL-09`), stated as a property of the target |

`0079-P(a)…(c)` PERFORM three refusals inside sub-transactions and roll them back, and each handler
reports a **defective probe** if a different refusal fires: a session inserted already closed
(`pos.till_session_lifecycle_invalid`), a cart line with no open session
(`pos.till_session_not_open`), and a till name outside the `invpl/1` `code` grammar
(`pos_till_sessions_terminal_code_ck`).

### 8.2 The probe that was written, run, and REMOVED — and why

The obvious fourth probe was behavioural RLS: insert a FOREIGN tenant's session and require `42501`.
It was written and run. It FAILED as a defective probe, reporting
`23503 … violates foreign key constraint "pos_till_sessions_opened_by_fkey"`.

The cause is not the probe's construction. **`scripts/db-from-zero.ts:67` migrates as `postgres`, a
SUPERUSER, and a superuser bypasses row security altogether** — so the foreign-tenant row sailed past
every policy and was stopped by the `users` edge instead. A deployment migrates as the non-superuser
`daftar_migrator`, where `FORCE ROW LEVEL SECURITY` does apply to the owner and the probe would have
passed. A proof whose verdict depends on who is migrating is not a proof, and
`tests/integration/migration-portability.test.ts` exists precisely because this file must behave
identically for both principals.

So `ENABLE` + `FORCE` stays a **catalogue** claim here (`0079-E(1)`) — which is also all `0077`
claimed — and the behavioural refusal is **owed by the slice's security suite**, which runs as
`daftar_app` and can therefore mean it. This also corrects, for the record, `0077`'s note that "the
`WITH CHECK` of the two insert policies is evaluated FIRST": it is evaluated before the row's CHECK
constraints, but it is evaluated **not at all** when the migrating principal is a superuser.

### 8.3 The refusals `0079` cannot perform, and who owes them

A migration must not create a business, a branch, a warehouse and two users to prove something —
`0077` states the same limit for the same reason — and every refusal below needs exactly that fixture.
The probes `0079` does perform are the ones reachable with invented identifiers, which is precisely the
set whose refusal fires **before** the foreign keys: a `BEFORE ROW` trigger, and a CHECK under a
satisfied tenant context.

Owed, named, and the slice's test estate's (`tests/security/pos-s3-*.test.ts`,
`tests/integration/pos-s3-*.test.ts`, goldens in `tests/golden-regression/phase4-s3/`):

1. **`OD-P4-09`, performed.** A second cashier's assertion adding a line to the first cashier's
   session is refused by `pos_cart_lines_session_actor_fk`, and refused **as the raw INSERT too**, by
   `daftar_inventory_internal` directly — which is the only way to show it is a constraint and not a
   wrapper's check.
2. A second **open** session for one user → `pos.till_session_already_open`.
3. A second **open** session on one terminal → `pos.terminal_already_open`.
4. An `UPDATE` of `opened_by` → `pos.till_session_actor_immutable`, on a session with an **empty**
   basket (the case the foreign key cannot see) and on one with lines (where the FK refuses first).
5. A write to a **closed** shift's basket → `pos.till_session_not_open`, for INSERT and UPDATE; a
   `DELETE` is refused earlier still, by `pos.cart_line_immutable` and by the absent privilege.
6. **RLS, behaviourally**, as `daftar_app`: a cross-tenant and a cross-business read and write on both
   relations, with the policies never weakened for the test.
7. **The forged-total refusal**, which is the slice's trust-boundary gate step: the cart commands take
   no price, total or tax argument at all, so the proof is that the forged fields are **rejected at
   the HTTP boundary** and that no column exists for them to land in — sending them and requiring the
   refusal, as the brief requires.
8. The concurrency proof of §7: a line added while the session is being closed.

### 8.4 Commands run, and their real exit codes

Read from a file and never through a pipe (a pipeline's status is the last command's):

| command | exit |
|---|---|
| `DB_FROM_ZERO_PORT=55114 PG_PORT=55114 PG_DIR=/tmp/daftar-pg-rp-base tsx scripts/db-from-zero.ts` | **0** — `80 migrations, roles 12, no-op rerun, manifest + history verified, tamper rejected`; `rerunApplied: 0`, `candidateMigrations: ["0079_phase4_pos_till_sessions_cart.sql"]`, `manifestFrozenThrough: 0078_phase4_sale_commit.sql` |
| `tsx scripts/check-migration-manifest.ts` | **0** — `79 frozen migrations verified (frozen through 0078_phase4_sale_commit.sql)` |
| `tsx scripts/static-guards.ts` | **0** — `STATIC GUARDS: PASS (23 rules)` |
| `prettier --check .` | **0** |
| `eslint . --max-warnings 0` | **0** |
| `npm run typecheck` | **0** |
| the behavioural smoke proof (scratch, not committed) | **0** — `SMOKE: PASS (27 checks)` |

The migration applies to a fresh database and re-applies as a no-op, which is the `0000 → latest`
twice the brief requires. The full-estate rounds are recorded in §12.

---

## 9. Tech Lead review points

### 9.1 `P4-AL-40`'s branch-scope policy cannot be honoured by this migration

`P4-AL-40` asks that a user whose `member_branch_scopes` do not include the till's branch be refused
**by the policy** and not by the controller. `0079` does not do that, and does not pretend to.

The reason is measured: there is no `app_user()` RLS helper in the tree. `0006:5-11` and `0052:236-248`
define exactly `app_tenant()`, `app_business()` and `app_bypass()`, and no accepted relation enforces
branch scope in a policy today. A branch-scope policy therefore needs a new session setting and a new
estate-wide RLS mechanism, which is not one migration's decision to take — and inventing a
`current_setting('app.user_id')` here would create a second, unaudited identity channel beside the
`invctl/1` assertion.

What `0079` does enforce is narrower and real: the session's branch is composite-FK-bound to its
business, and the ACTOR is the assertion's — a cryptographically asserted user, never a client claim.
**Recommendation:** raise the `app_user()` helper as its own decision, with its own red proof, in the
slice that first needs branch scope enforced below the business level; do not add it as a side effect
of the POS cart.

### 9.2 The terminal uniqueness rule is implied, not stated

`pos_till_sessions_one_open_per_terminal_uq` (§3.2) comes from `OD-P4-09`'s risk sentence about the
cash drawer's owner, not from its ruling text. It is the one rule in `0079` that a reviewer could read
out. If it is refused, dropping the index changes nothing else in the file except `0079-E(4d)`.

### 9.3 The concentration in `daftar_inventory_internal` deepens

`TL-P4-S1-C17` refused a fifth principal and `0077-E` asserts `daftar_sales_internal` does not exist,
so the four POS commands are owned by `daftar_inventory_internal` — the principal that already owns
`sale_commit` and the stock writer. The lock records this concentration as risk `R-P4-08`. P4-S3 makes
it larger: a till session and a basket are not inventory, and they are now inside the inventory
authority. Recorded rather than introduced silently; no action proposed for this slice.

### 9.4 The cart commands are in the DDL migration

§2's reasoning. If the Tech Lead prefers the `0077`/`0078` split, the commands and the four registry
rows move to an `0080` — but then `0079` must either register nothing (and the commands' op codes
arrive a migration later) or commit four registered authorities with no writer, which is what
`TL-P4-S2-K1` refused. Flagged so the choice is visible.

---

## 10. Conflicts found between the documents and the code (the code wins)

1. **`accounting_source_types` has no `registered_by` column.** Its shape is `source_type`, the two
   bound policies, a description and a `sort_order`. A per-slice attribution of an accounting source
   type — which the inventory registries do support — is not expressible, so `0079-E(5)`'s first half
   is stated over the POS **vocabulary** instead (`^(pos|till|cart)`), which is `P4-AL-88`-safe. Found
   by running the migration, not by reading.
2. **A migration cannot use a temporary table to snapshot a registry before writing.**
   `bootstrap.sql:353` revokes `TEMPORARY` on the database from PUBLIC and never grants it back, which
   `0045:925` already records. So the "capture then compare" form `0077`'s `R-P4-S2-07` describes is
   not available to a `DO` block, and the absence claims of `0079-E(5)` are stated as universally
   quantified vocabulary facts instead.
3. **`0077`'s note that RLS `WITH CHECK` is "evaluated FIRST" is true only for a non-superuser
   migrator.** §8.2. Recorded here because the next reader of that comment will otherwise write the
   same probe.
4. **`PHASE4_S3_PREFIX` already exists** in `scripts/phase4-prefix.ts`, empty. It stays empty: filling
   it is an acceptance commit's act, not a candidate's.

---

## 11. The full-estate rounds

`docs/PHASE_4_ARCHITECTURE_LOCK.md` `TL-P4-S1-C18` is explicit that a single full-estate run does not
bound this defect — each run reveals only the FIRST failing assertion per test body — so the estate is
re-run after every round of correction until a round finds nothing. The rounds, the failing files and
what accounts for each are recorded in §12 as they are measured.

---

## 12. Round-by-round record

See the hand-back report for the authoritative command list and exit codes. This section records what
each failing file was and what accounted for it, so a later reader does not have to re-derive the
attribution.

### Round 1 — `vitest run tests/integration tests/security tests/guards`, exit **1**

`287` files, `4981` assertions, `2286 s`. **One** failing file, **three** failing assertions, and all
three are one fact:

| file | assertion | what accounted for it |
|---|---|---|
| `tests/security/inventory-db-authority.test.ts` | `the internal principal holds exactly these table privileges on the accepted prefix's relations, and SELECT and nothing else beyond them` — `expected [ [ 'pos_cart_lines', …(1) ] ] to deeply equal []` | **A real defect in `0079`, not a stale assertion.** The clause at `:284-291` states positively that beyond the accepted prefix the internal writer holds no `DELETE`, no `TRUNCATE`, no table-level `UPDATE`, no `REFERENCES` and no `TRIGGER`. The first draft granted `DELETE ON pos_cart_lines`. |
| | `RED: a non-append write to the internal principal beyond the accepted prefix is named (clause 1)` — `green before the plant: expected [ Array(1) ] to deeply equal []` | The same grant. This case plants a `DELETE` of its own and requires the tree to be green first; `0079`'s grant made the pre-condition false, so the suite's own red proof could no longer run. |
| | `RED: a write handed to a RUNTIME principal on a relation this principal writes is named (clause 2)` — `expected [ …(2) ] to deeply equal [ 'daftar_app INSERT invoice_items' ]` | The same grant, seen from the other side: `pos_cart_lines` joined the writable-beyond set, so the planted leak was named twice. |

The resolution is `R-P4-S3-08` and §4.1: the grant is withdrawn, the basket becomes append-only, a
removal is the `removed_at` tombstone granted by name, and the ordinal becomes a partial unique index
so the till may still reuse it. No accepted assertion was edited, no privilege was relaxed and no RLS
was weakened; the rule is a security property and the convenience that broke it was not.

Three red proofs were planted on the correction and each was refused **by name** (`db-from-zero`
against a fresh cluster, exit `1` each time, and the tree restored to its digest afterwards):

| plant | refused by |
|---|---|
| `GRANT DELETE ON pos_cart_lines TO daftar_inventory_internal` restored | `pos.authority_leak: 0079-E(6): somebody may DELETE or TRUNCATE pos_cart_lines, …` |
| `WHERE removed_at IS NULL` dropped from `pos_cart_lines_line_uq` | `pos.migration_end_state_invalid: 0079-E(4e): pos_cart_lines_line_uq is not the partial unique index …` |
| `pos_cart_line_guard()`'s `DELETE` branch changed from `RAISE` to `RETURN OLD` | `pos.migration_end_state_invalid: 0079-E(7): the live pos_cart_line_guard() body does not RAISE on DELETE, or returns OLD somewhere …` |

The third plant is worth recording as a lesson about the check and not only about the body. The first
version of that `0079-E(7)` check asked whether the body contained `TG_OP = 'DELETE'` **and** the two
refusal messages. A body whose `DELETE` branch was `RETURN OLD` satisfied all three — the messages were
still in the `UPDATE` branch — so the check passed while the delete was permitted: an assertion that
was a convention. The shipped check requires the branch to be followed by `RAISE EXCEPTION` and
requires `RETURN OLD` to appear nowhere in either guard, which is the property that actually decides a
`BEFORE DELETE` row trigger.
