# P9 — MIGRATION PATCH REQUEST

**To:** the Migration Owner (master directive Part 10 — exactly one principal allocates numbers).
**From:** the Phase 9 preparation track.
**Status of the work this requests:** `PREPARED / NOT PROMOTED` (Part 9).

This document **names no migration number and no migration filename**, by rule, and
proposes none. It names the exact relations, columns, constraints, indexes, routines,
triggers, policies and grants to enforce, and the invariant each one exists for. The
Migration Owner is the only principal that may turn it into numbered files, in whatever
order and grouping the train requires.

The DDL half of this request is `docs/phase9/P9-BOOKING-DDL-SPEC.sql`. It is **executable
and executed**: `tests/phase9-prep` applies it to a live PostgreSQL cluster on top of the
sealed Phase 3 head, as the non-superuser deployment principal `daftar_migrator`, in one
transaction, and then races real transactions against it. Nothing below is a prose claim
about SQL that has not run.

---

## 0. What is being asked for, in one line

A universal booking model whose **no-double-booking rule is a physical database
invariant** — an exclusion constraint, not a trigger that looks for a conflict — plus the
availability and command-identity relations around it.

---

## 1. PRECONDITION — a patch to `infrastructure/database/bootstrap.sql`

Phase 9 introduces one new internal authority role, in the shape of the four that already
exist (`daftar_accounting_internal`, `daftar_inventory_internal`, `daftar_catalog_internal`,
`daftar_provisioning_internal`). It is the owner of the slice's two owned routines and the
only principal with write privilege on the booking relations.

Add to `bootstrap.sql`, in the section where the other internal roles are created:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'daftar_booking_internal') THEN
    CREATE ROLE daftar_booking_internal
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO daftar_booking_internal;
GRANT daftar_booking_internal TO daftar_migrator WITH INHERIT FALSE, SET TRUE;
```

* `NOLOGIN` — it is an authority, never a connection.
* `NOBYPASSRLS` — it reads through the policies like everything else.
* `WITH INHERIT FALSE, SET TRUE` — the migrator may `SET ROLE` to it to create and own
  objects, and does **not** silently carry its privileges.

**Until this patch lands, the role is created by the test harness** (`BOOTSTRAP_PATCH` in
`tests/phase9-prep/p9-booking-spec.ts`, character-for-character the statements above). The
DDL spec's §0 refuses to apply if the role is absent, with
`authority.migration_precondition`. It does **not** create the role itself: a migration
that invents a role is a migration that bypasses the deployment's own role model.

The spec also asserts, in §0, that the `btree_gist` extension is present — in the exact
shape the accounting-periods migration already uses — and refuses with
`booking.extension_missing` if it is not. No new extension is requested.

---

## 2. PROMOTION-TIME STATEMENT — the `customers` foreign key

`bookings.customer_id` deliberately carries **no** foreign key in this slice. `customers`
is a Phase 4 relation and Phase 4 is not sealed; a FK here would bind an unpromoted
Phase 9 to a schema still under review. The shape of the appointment is enforced without
it (`bookings_kind_shape_ck` makes `customer_id` present exactly when
`kind = 'appointment'`).

When Phase 4 is sealed, the Migration Owner adds exactly this:

```sql
ALTER TABLE bookings
  ADD CONSTRAINT bookings_customer_fk
  FOREIGN KEY (business_id, customer_id) REFERENCES customers (business_id, id)
  ON DELETE RESTRICT;
```

The target must be the composite `(business_id, id)` key, for the same reason every other
FK in this slice is composite: a single-column target lets a row point at a customer of
another business.

**That target is VERIFIED, not assumed.** `customers` is created with
`PRIMARY KEY (business_id, id)` in a migration that is already inside the frozen boundary,
and the shape above is the shape the project's own `payments_customer_fk` already uses
against it. This was read off that frozen file rather than off a Phase 4 working tree, so
the statement does not depend on anything still moving — what remains pending is the seal,
not the key. (This request names no migration number or filename anywhere, including here;
the prep report records which frozen file was read.)

---

## 3. RELATIONS — exact names, in dependency order

| # | relation | what it is | primary key |
|---|---|---|---|
| 1 | `booking_services` | what the merchant schedules; owns the buffers | `(business_id, id)` |
| 2 | `booking_resources` | the thing that can be double-booked | `(business_id, id)` |
| 3 | `booking_service_resources` | which resource may perform which service | `(business_id, service_id, resource_id)` |
| 4 | `booking_resource_schedules` | recurring weekly availability | `(business_id, id)` |
| 5 | `booking_resource_exceptions` | dated availability overrides | `(business_id, id)` |
| 6 | `bookings` | appointments **and** resource blocks, one table | `(business_id, id)` |
| 7 | `booking_operations` | durable command identity (idempotency) | per spec §7 |

Every one of the seven carries `tenant_id` and `business_id` and the composite ownership
FK `(tenant_id, business_id) REFERENCES businesses (tenant_id, id)` (Part 13).

### 3.1 `booking_services`

Columns: `tenant_id`, `business_id`, `id`, `code`, `display_name`,
`default_duration_minutes`, `lead_buffer_minutes`, `trail_buffer_minutes`, `status`,
`created_by_user_id`, `created_at`.

* `UNIQUE (business_id, code)`; `code` lowercase-slug-shaped and trimmed.
* `default_duration_minutes BETWEEN 1 AND 1440`; both buffers `BETWEEN 0 AND 1440`.
* `status IN ('active','archived')`.
* **No price, tax or amount column.** Part 11: a booking that bills posts through the
  canonical sales authority. A price here would be a second financial truth. The spec's
  end-state block fails the deployment if a money-shaped column ever appears in any of the
  seven (check (j)).

### 3.2 `booking_resources`

Columns: `tenant_id`, `business_id`, `branch_id`, `id`, `kind`, `display_name`, `status`,
`created_by_user_id`, `created_at`.

* `kind IN ('staff','room','equipment')`.
* composite branch FK `(business_id, branch_id) REFERENCES branches (business_id, id)`.
* **Capacity is one, and there is no `capacity` column.** See §8 (OPEN).

### 3.3 `booking_service_resources`

Columns: `tenant_id`, `business_id`, `service_id`, `resource_id`, `created_at`. Composite
FKs to `booking_services` and `booking_resources`, both `ON DELETE RESTRICT`. Its primary
key exists to be an **FK target**, which is what makes eligibility declarative rather than
a trigger (R-P9-06).

### 3.4 `booking_resource_schedules` / `booking_resource_exceptions`

`booking_resource_schedules`: `weekday SMALLINT CHECK (weekday BETWEEN 1 AND 7)` — ISO-8601,
so it matches `EXTRACT(ISODOW FROM …)` with no translation table — `opens_at`, `closes_at`
(`opens_at < closes_at`), `effective_from`, `effective_to`, both finite.

`booking_resource_exceptions`: `on_date` (finite), `effect IN ('closed','open')`,
`opens_at`, `closes_at`, `reason`, with the shape stated as an **equivalence** —
`(effect = 'open') = (opens_at IS NOT NULL AND closes_at IS NOT NULL)` — so neither an
open override without a window nor a closed day carrying one can exist even for the
duration of one statement. `UNIQUE (business_id, resource_id, on_date)`.

These two describe what is **offered**. They are not the overlap invariant and are not in
its path. A closure that must physically hold time against bookings is a
`kind = 'resource_block'` row in `bookings` (R-P9-05).

### 3.5 `bookings` — the relation this request exists for

Columns: `tenant_id`, `business_id`, `branch_id`, `id`, `kind`, `resource_id`,
`service_id`, `customer_id`, `starts_at`, `ends_at`, `lead_buffer_minutes`,
`trail_buffer_minutes`, `blocking_window`, `state`, `rescheduled_to_id`,
`rescheduled_from_id`, `settled_at`, `settled_by_user_id`, `settle_reason`,
`intent_sha256`, `created_by_user_id`, `created_at`.

**THE INVARIANT — enforce exactly this:**

```sql
CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (business_id WITH =, resource_id WITH =, blocking_window WITH &&)
  WHERE (state IN ('booked', 'completed', 'no_show'))
```

and, inseparably from it:

```sql
CONSTRAINT bookings_blocking_window_ck CHECK (
  blocking_window = tstzrange(
    starts_at - make_interval(mins => lead_buffer_minutes),
    ends_at   + make_interval(mins => trail_buffer_minutes),
    '[)')
)
```

Four properties of that pair, each of which a negative control in
`tests/phase9-prep/p9-booking-negative-controls.test.ts` removes and measures the damage of:

1. **It excludes on `blocking_window`, not on `starts_at..ends_at`.** Excluding on the
   customer-facing window puts the buffers *outside* the invariant and an overlapping
   buffer commits (CONTROL 5).
2. **It is PARTIAL on the three occupying states.** Without the predicate a cancelled
   booking holds its hour for ever (CONTROL 4).
3. **The CHECK pins `blocking_window` to its inputs.** Without it a caller forges a
   one-second window and books on top of a full hour (CONTROL 3); with it the forgery is
   `23514`.
4. **It is a constraint, not a trigger.** A `SELECT`-then-`INSERT` trigger with the same
   logic commits a double booking the moment one writer forgets the serialization lock
   (CONTROL 2); the constraint does not ask whether anyone remembered anything (CONTROL 1).

`blocking_window` is a **stored** `TSTZRANGE`, not a generated column. This is measured,
not stylistic: `timestamptz - interval` is `STABLE`, so PostgreSQL refuses it in a
generation expression with `42P17 invalid_object_definition`. A `BEFORE` trigger that
recomputes the column instead is also rejected here, because it would make the CHECK a
guard that can never fire — a dead guard (R-P9-03).

Other constraints on `bookings`, each named in the spec: `bookings_kind_shape_ck` (two
equivalences: a service and a customer exactly when `kind = 'appointment'`),
`bookings_order_ck` (`starts_at < ends_at` — `<`, not `<=`, because an empty range
overlaps nothing and a zero-length row could be stacked without limit),
`bookings_finite_ck` (no `±infinity` — an infinite booking would swallow a resource's
whole future while remaining a legal row), `bookings_duration_ck` (whole minutes, at most
1440), `bookings_buffers_ck`, `bookings_reschedule_shape_ck`,
`bookings_reschedule_self_ck`, the two `DEFERRABLE INITIALLY DEFERRED` self-FKs
`bookings_reschedule_to_fk` / `bookings_reschedule_from_fk`, `bookings_settled_shape_ck`,
`bookings_settle_reason_ck`, `bookings_cancel_reason_ck`, the composite FKs
`bookings_tenant_business_fk`, `bookings_branch_fk`, `bookings_resource_fk`, and the
eligibility FK `bookings_eligible_resource_fk` (MATCH SIMPLE: with `service_id` NULL the
row is a resource block and the check does not apply).

Indexes: `bookings_resource_start_idx ON bookings (business_id, resource_id, starts_at)`
and `bookings_customer_start_idx ON bookings (business_id, customer_id, starts_at) WHERE
customer_id IS NOT NULL`. The exclusion constraint's own GiST index answers "what occupies
this resource around this instant", which is both the availability read and the conflict
check, so neither needs an index of its own.

### 3.6 `booking_operations`

Durable command identity, append-only. Not a merchant surface: no runtime login role may
read it (end-state check (f)).

---

## 4. ROUTINES AND TRIGGERS — exact names

| routine | kind | trigger | refusal |
|---|---|---|---|
| `booking_resource_lock_key(UUID, UUID)` | `sql IMMUTABLE STRICT`, owned by `daftar_booking_internal`, pinned path | — | — |
| `booking_lock_resources(UUID, UUID[])` | `plpgsql VOLATILE`, owned, pinned path | — | `booking.lock_set_invalid` |
| `booking_resolve_local(TEXT, TIMESTAMP, INTERVAL)` | `plpgsql STABLE`, owned, pinned path | — | `booking.local_time_nonexistent`, `booking.local_time_ambiguous`, `booking.local_time_offset_mismatch`, `booking.timezone_unknown`, `booking.local_time_unresolvable`, `booking.local_time_not_finite`, `booking.local_time_out_of_supported_range` |
| `booking_replay_result(UUID, UUID, TEXT, TEXT)` | `plpgsql STABLE`, SECURITY INVOKER, owned, pinned path | — | `booking.replay_lookup_invalid`, `booking.replay_scope_mismatch`, `booking.operation_conflict`, `booking.operation_intent_conflict` |
| `bookings_no_delete()` | raise-only, not a definer | `bookings_no_deletion` BEFORE DELETE | `booking.not_deletable` |
| `bookings_transition()` | raise-only, not a definer | `bookings_transition_only` BEFORE UPDATE | `booking.immutable`, `booking.immutable_settlement`, `booking.settlement_without_close`, `booking.settlement_after_close`, `booking.state_terminal`, `booking.state_not_reopenable` (unreachable as shipped — limitation 18) |
| `bookings_born_booked()` | raise-only, not a definer | `bookings_born_booked_only` BEFORE INSERT | `booking.not_born_closed` |
| `bookings_chain_symmetric()` | `SECURITY DEFINER`, owned by `daftar_booking_internal`, pinned path | `bookings_chain_agrees` — CONSTRAINT trigger, `DEFERRABLE INITIALLY DEFERRED`, AFTER INSERT OR UPDATE, `WHEN` either reschedule link is non-NULL | `booking.chain_asymmetric`, `booking.chain_unreadable`, `booking.chain_is_a_ring`, `booking.chain_unterminated`, `booking.chain_too_long` |
| `bookings_buffers_match_service()` | `SECURITY DEFINER`, owned by `daftar_booking_internal`, pinned path | `bookings_buffers_are_the_service_s` — CONSTRAINT trigger, `DEFERRABLE INITIALLY DEFERRED`, `WHEN (kind = 'appointment')` | `booking.service_unreadable`, `booking.buffers_not_the_service_s` |
| `booking_operations_immutable()` | raise-only, not a definer | `booking_operations_no_mutation` | per spec §7 |

Every definer carries `SET search_path = pg_catalog, public, pg_temp` in the project's
exact spelling, asserted from `pg_proc.proconfig`. Every routine is
`REVOKE ALL … FROM PUBLIC`, and the end-state block refuses the deployment if any runtime
login role can execute the buffer guard or the lock-key routine.

`bookings_transition()` freezes, after INSERT: `tenant_id`, `business_id`, `branch_id`,
`id`, `kind`, `resource_id`, `service_id`, `customer_id`, `starts_at`, `ends_at`, both
buffers, `blocking_window`, `rescheduled_from_id`, `intent_sha256`, `created_by_user_id`,
`created_at`. Only `state` and its settlement metadata ever change, they are written once
(R-P9-15), and `bookings_born_booked()` refuses a row born in any state but `'booked'` or
born carrying a settlement record or a forward link (R-P9-16) — so the settlement metadata
has exactly one writer, the statement that closes the booking. A reschedule is a new row
plus a transition on the old one, in one transaction (R-P9-08); the successor's backlink
`rescheduled_from_id` is written at INSERT and is the one closure-adjacent column an INSERT
may set. That one-transaction sentence is now ENFORCED and not merely stated:
`bookings_chain_symmetric()` asserts at COMMIT that the forward link and the backlink name
each other (R-P9-17), so a half-written chain is refused. The deployment must therefore keep
`bookings_chain_agrees` `DEFERRABLE INITIALLY DEFERRED` — the end-state block refuses the
migration otherwise, because evaluated per statement this check would refuse every lawful
reschedule. The same routine carries R-P9-18: following the forward links from a written row
must END on a row that is not `'rescheduled'` (`booking.chain_is_a_ring`), because a pairwise
check cannot see a ring and an executed attack committed a 2-ring and a 3-ring whose every
pairwise check held. Its walk terminates on its own visited set, so `booking.chain_too_long`
is defence in depth at 4096 and not a policy limit on how often a booking may be moved.

### 4.1 R-P9-11 — the per-resource serialization key, and why it is requested

`booking_resource_lock_key(business, resource)` returns one `BIGINT` per
`(business, resource)` pair. The command layer's obligation is to take
`pg_advisory_xact_lock(booking_resource_lock_key(business, resource))` as the **first act**
of any transaction that will occupy that resource.

This was found by execution, not by reading. Two bookers racing on the same slot *without*
the lock each insert their own entry into the exclusion index, then each find the other's
and wait: the pair deadlocks, and PostgreSQL resolves it with `40P01 deadlock_detected`
after `deadlock_timeout`. **The data stays correct — exactly one booking exists either
way** — but the refusal a customer would see is a deadlock rather than "that time is
taken". With the lock taken first, the second transaction queues behind the first and is
refused with `23P01`, which is a refusal a UI can translate.

The lock is per `(business, resource)`, not global: chair A never waits on chair B, and a
booking in one business never waits on another business at all.

CONTROL 6 constructs the mutual wait deterministically (each transaction plants a row the
other will conflict with, then crosses), measures `40P01`, and then shows the locked form
giving one commit, one `23P01`, and one observed wait.

### 4.2 R-P9-12 — the multi-resource lock set, in one global order

`booking_lock_resources(business, resources[])` takes every advisory lock a
transaction will need, over the whole set at once, **sorted ascending by key and
deduplicated**, before anything is mutated. It returns the keys in acquisition
order so a proof can assert the order itself rather than trust a comment.

R-P9-11 serializes one resource and is not enough for a reschedule that *moves* a
booking: that touches two, and two transactions crossing — A→B against B→A — each
hold what the other wants next. Per-resource locking deadlocks there for the same
reason the bare index did, one level up. A total order over the whole set means
any two transactions acquire their shared locks in the same relative order, so no
cycle can form.

The sort is over the **keys**, not the uuids, because the key is what the lock
manager orders on. Where two distinct resources hash to one key, the dedupe
collapses them into a single lock: that broadens the exclusion and can never
narrow it, so a collision costs concurrency and never correctness.

An empty set, a set containing NULL, or a missing business is refused with
`booking.lock_set_invalid` rather than silently locking nothing — a caller that
computed no resources has a bug, and returning quietly would let it mutate
unserialized.

Three things were measured here and are worth the Migration Owner's attention:

1. **A true swap of two occupied slots cannot be expressed as two independent
   reschedules at all.** Both sides are refused with `23P01`, because each wants
   an hour the other has not released and neither can see the other's uncommitted
   release. That is a correct refusal and the final state is the one that was
   already true. A swap must be **one transaction** that performs both transitions
   before either insert; that shape is proven to commit.
2. **Under per-resource locking the same crossing deadlocks with `40P01`** — the
   negative control, with the cycle constructed rather than hoped for.
3. **Two cross-resource reschedules that do not contend both commit** under the
   same single lock set, which is what shows it serializes without refusing work
   that was always legal.

### 4.3 R-P9-13 — a local time is resolved or refused, never guessed

`booking_resolve_local(zone, local, offset DEFAULT NULL)` resolves a wall-clock
time in an IANA zone to the instant a booking is stored at. Storage stays
canonical instants; this is the step before storage.

It counts. For a candidate instant to be the answer, mapping it back into the zone
must give exactly the wall clock asked for, and the number of instants that do is
the whole decision:

| occurrences | meaning | behaviour |
|---|---|---|
| 0 | a spring-forward skipped this hour | **REFUSE** `booking.local_time_nonexistent` |
| 1 | unambiguous | resolve (a stated offset is still checked) |
| >1 | a fall-back repeated this hour | **REFUSE** `booking.local_time_ambiguous` unless the caller states which offset it means |

**This exists because PostgreSQL's own `AT TIME ZONE` answers both broken cases
silently, and that is measured, not assumed.** On PostgreSQL 18.4,
`America/New_York 2026-03-08 02:30` — an hour that does not exist — comes back as
an instant whose local time is `03:30`, an hour the caller never asked for; and
`2026-11-01 01:30`, which happens twice, comes back as one of the two with nothing
to say that it chose. A booking accepted from either answer has silently been
moved or double-sold. Both are negative controls in the time suite.

The scan steps by **one minute** over ±180 minutes, not by thirty, because
`Australia/Lord_Howe` shifts by thirty and a law proven only on hour-shifting
zones would have a hole in it. All three branches are proven on both shift sizes.

`STABLE`, not `IMMUTABLE`: the answer depends on the tz database, which is data and
gets updated. The suite asserts the volatility *and* that PostgreSQL itself refuses
to build an index over the routine — so it can never be folded into an index or a
generated column that would outlive the next tz update. This is R-P9-03's lesson in
a second place.

**LIMITATION, stated rather than discovered:** the ±180-minute bound means a zone
whose offset moved by more than three hours in one transition would resolve as
"does not exist" rather than being found. Every transition in the IANA database is
far inside that bound, and refusing is the safe side of it.

**Still owed to the command slice, not to this request:** containment — is this
booking inside the resource's working hours, on that resource's own civil day? The
resolver settles the harder half, that the resolution is never a guess; the
comparison against `booking_resource_schedules` is a validation and belongs with
the commands.

---

## 5. ROW SECURITY — all seven relations

`ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` on every one of the seven,
with the project's established policy set, per relation:

* `tenant_membership` — permissive, the tenant boundary;
* `business_isolation_read` / `_insert` / `_update` / `_delete` — **RESTRICTIVE**, one per
  command, the business boundary (`booking_operations` carries read and insert only);
* `booking_internal_read` — the internal authority's read path.

All of them compare through the existing helpers (`app_tenant()`, `app_business()`,
`app_bypass()`), uuid-wise, in the project's `nullif(app_*(), '')::uuid` shape.

---

## 6. GRANTS

```
daftar_app                 SELECT on the six merchant-facing relations
                           (NOT booking_operations)
daftar_booking_internal    SELECT, INSERT, UPDATE on booking_services,
                           booking_resources, booking_resource_schedules,
                           booking_resource_exceptions, bookings;
                           SELECT, INSERT on booking_service_resources
                           and booking_operations
PUBLIC                     nothing, on every relation and every routine
```

No runtime login role holds `INSERT`, `UPDATE` or `DELETE` on any of the seven. **Not even
the internal principal holds `DELETE` on anything**, or `UPDATE` on the operation
registry: append-only is a property of the GRANT as well as of the trigger (end-state
check (e)).

Ownership is taken in the project's bracket idiom: `GRANT CREATE ON SCHEMA public TO
daftar_booking_internal` at the top, the two `ALTER FUNCTION … OWNER TO` transfers after
the functions exist and after their own `REVOKE`/`COMMENT` have been issued, then `REVOKE
CREATE ON SCHEMA public FROM daftar_booking_internal`. The end-state block fails the
deployment if that authority survives (check (i), `booking.authority_leak`).

### 4.5 R-P9-14 — the replay is answered from the record

**Name:** `booking_replay_result(UUID, UUID, TEXT, TEXT)`, returning
`OUT o_replay BOOLEAN, OUT o_booking_id UUID, OUT o_recorded_at TIMESTAMPTZ`.
**Volatility:** `STABLE`. **Security:** INVOKER — never DEFINER. **Path:** pinned to
`pg_catalog, public, pg_temp`. **Owner:** the internal booking authority. **ACL:** empty;
no runtime role, and not `PUBLIC`.

**What it does.** Reads `booking_operations` by `(business_id, operation_id)` and returns
the booking the FIRST attempt produced. An unused key is reported as a first attempt, not
as an error. A key whose recorded `op_code` or `intent_sha256` disagrees with the request
being replayed is refused: `booking.operation_conflict`,
`booking.operation_intent_conflict`.

**Why it is requested rather than left to the command layer.** The registry's primary key
establishes only that no second booking exists. The caller holding the refusal has no
booking id, and the SQLSTATE it receives depends on which constraint its statements reached
first — measured as `23P01` when the whole request is re-sent and `23505` when only the
registry row is left to refuse it. A command layer that turned either into "already exists"
would be inventing a result it never read.

**The business is checked inside the routine, and this is the part that matters.** Every
`business_isolation_read` policy in this slice exempts the internal authority by name, so
that its definer bodies can read across the businesses of one tenant — and that principal
is the only one with execute here. The routine therefore compares the business asked about
against the caller's own scope and refuses a mismatch, or an unscoped caller, with
`booking.replay_scope_mismatch`. Without that check the lookup answers a sibling business's
operation id with that sibling's booking id; this is not a hypothesis, it is what the
executed attack returned before the check existed.

---

### 4.4 PART 53 — audit and idempotency

The identity of a booking command is the caller's `operation_id`, the primary key
of `booking_operations` together with `business_id`. It is **supplied by the
caller and derived from no clock and no sequence**, because a clock-derived
identity would make a retry a different operation.

Measured: two concurrent transactions carrying the **same** `operation_id`, each
inserting a booking and its registry row in one transaction, produce exactly one
booking and one registry row. The loser is refused by the registry's own primary
key (`23505`) or by the invariant (`23P01`); neither is a second booking. The
registry is append-only in the trigger as well as the grant, and an attempt to
rewrite or remove a recorded operation is refused with
`booking.operation_registry_immutable`.

Cancellation and reschedule do not delete history: a cancelled booking is a state
transition on a retained row, and a reschedule retains its predecessor pointing at
its successor. The reschedule proofs assert that no predecessor is ever left
released with no successor.

The command layer's own obligation, not this request's: answering a replay **from
the recorded row** rather than returning the duplicate-key error to the caller.

---

## 7. END-STATE BLOCK

The spec closes with a `DO` block (P9-E) reading `pg_catalog` — never
`information_schema` — that refuses to commit unless: (a) the invariant exists, is an
exclusion constraint, is partial, and excludes on `blocking_window`; (b) the pinning CHECK
exists; (c) row security is enabled **and** forced on all seven; (d) no runtime login role
holds write privilege and PUBLIC holds nothing; (e) the internal principal holds no
`DELETE` and no registry `UPDATE`; (f) `daftar_app` can read the calendar and no other
runtime role can read anything, and nobody reads the registry; (g) the one definer is a
definer with the pinned path, owned by the internal principal, callable by nobody, and the
three raise-only guards are not definers; (g2) the lock-key routine is `IMMUTABLE STRICT`,
owned, pinned and callable by no runtime role; (g3) the multi-resource lock set is
`VOLATILE` and the local-time resolver is `STABLE`, both owned, pinned and callable
by no runtime role; (h) the buffer guard is genuinely
`tgdeferrable AND tginitdeferred`; (i) the ownership authority did not survive; (j) no
money-shaped column reached the schema.

---

## 8. OPEN — what this request knowingly does not cover

1. **Resource capacity greater than one.** An exclusion constraint expresses "no two
   overlapping rows", not "at most N overlapping rows", and there is no declarative way to
   say the second. A room for six is six resources, or a documented follow-up. It is
   deliberately **not** a `capacity INTEGER` column, because the physical invariant cannot
   see one and a column no constraint enforces is worse than no column.
2. **Schedule containment** — does this booking fall inside the resource's working hours,
   on that resource's own civil day? The input exists (`businesses.timezone`, an IANA name
   validated at the database boundary), so this is a deferral, not a gap: containment is a
   **validation**, not a concurrency invariant. Two concurrent bookings both outside
   working hours are two independently wrong rows; two concurrent bookings on the same hour
   are one corrupted resource, and that is what this request makes impossible.
3. **The command layer.** No `booking_create`, `booking_cancel` or `booking_reschedule`
   routine is requested. Those need a booking authority assertion and its key, which is
   its own slice. §6's grants already put every runtime role in the position that layer
   requires, so the command slice adds routines and changes no grant.
4. **The `customers` FK** — §2 above, at promotion.
5. **Retention, and every erasure path.** This request asks for a schema in which nothing
   is deletable: no `DELETE` grant on any relation, a raise-only delete trigger behind that
   missing grant, cancellation as a state rather than a removal, and an append-only
   operation registry. That is what makes a replay answerable later, and it is also the
   reason a retention period and a right-to-erasure path cannot be written here: they
   trade a customer's erasure right against an append-only history, which is an owner
   ruling and not a schema decision. The default this request ships is **retain
   indefinitely, erase nothing**.
6. **Reversal.** Every object this request creates is new. There is no data migration, no
   backfill and no change to any existing relation, so the reverse is a drop of the seven
   relations, their six routines and the one role — but the project's migrations are
   forward-only and frozen once applied, and this request does not ask for a down
   migration.

---

## 9. EVIDENCE

**97 cases over seven suites, all green with EXIT CODE 0, on the approved target — a live
PostgreSQL 16.15 cluster at `en_US.utf8` under Node v24.21.0** (and again on 18.4 at `C` as a comparison), with the
spec applied in one transaction as the non-superuser deployment principal
`daftar_migrator` on top of the sealed Phase 3 head.

Classified in the only evidence classes the directive allows (PART 15). Nothing below
is mixed, and nothing is claimed in a stronger class than it was measured in.

| suite | cases | class |
|---|---|---|
| `p9-booking-schema.test.ts` | 16 | PROVEN BY DATABASE CATALOGUE |
| `p9-booking-concurrency.test.ts` | 11 | PROVEN BY TEST (real concurrency) |
| `p9-booking-negative-controls.test.ts` | 7 | PROVEN BY TEST (red proofs) |
| `p9-booking-multi-resource.test.ts` | 10 | PROVEN BY TEST (real concurrency) |
| `p9-booking-time.test.ts` | 21 | PROVEN BY TEST |
| `p9-booking-runtime-attack.test.ts` | 10 | PROVEN BY EXECUTED ATTACK (no superuser) |
| any retention period, or an erasure path | — | **UNMEASURED** — owner-only; nothing deletable today |
| the command layer | — | **SPEC ONLY** — not written |
| schedule containment | — | **SPEC ONLY** — deferred to the command slice |
| required CI for these suites | — | **UNMEASURED** — owner-only (TD-08) |
| browser, UX, localization | — | **UNMEASURED** — no surface exists |

* **Schema** — the seven relations; the frozen history with no object dropped or
  replaced; exactly two exclusion constraints in the whole cluster; re-application
  refused atomically; the invariant's shape read from `pg_constraint`; row security
  enabled **and** forced; the whole grant model; the definer's ownership and pinned
  path; the deferred constraint trigger's flags; no money-shaped column.
* **Concurrency** — overlap refused `23P01`; eight racers giving one commit and seven
  refusals; a rolled-back winner freeing the slot; adjacency committing concurrently;
  buffers inside the invariant under race; per-resource independence; a resource block
  against an appointment; cancellation releasing; reschedule in one transaction; two
  businesses of one tenant on the same clock hour; timezone independence across five
  zones including a 30- and a 45-minute offset.
* **Negative controls** — six controls that each remove exactly one invariant, record
  `pg_get_constraintdef` first, show the attack committing, restore, assert the
  restored definition is **character-identical**, and re-run the attack expecting the
  refusal; plus a closing case that the invariant survived every control character for
  character.
* **Multi-resource (PART 50) and idempotency (PART 53)** — the lock set's order asserted
  from the routine's own return value; its three refusals asserted by name; the A→B
  against B→A crossing both ways; the single-transaction swap that commits; the
  per-resource deadlock control; two concurrent retries of one operation id; the
  registry's append-only refusals.
* **The replay (PART 53, R-P9-14)** — the lookup reports an unused key as a first
  attempt; both retry routes measured (`23P01` for the re-sent request, `23505` where
  only the registry can refuse); the replay returning the FIRST attempt's booking id,
  that id asserted to name a booking standing on the resource and instant asked for, the
  retry's own id asserted not to be a booking, and the same answer returned twice down to
  the recorded instant; a reused key over a different op code or intent digest refused by
  name; the scope check refusing a sibling business and an unscoped caller.
* **Executed attack, no superuser** — every INSERT on all seven relations and
  UPDATE/DELETE against a booking that really exists, as each of the six runtime roles,
  refused `42501` with the row asserted to survive; the merchant's own calendar read
  allowed, so the refusals are a boundary and not a blanket denial; row security biting
  on a sibling business whose row is asserted to exist; the registry unreadable by every
  runtime role; the four routines unexecutable by every runtime role; and the internal
  authority itself refused a cross-business write by POLICY while the same row in its own
  business is accepted.
* **Time (PART 51)** — the two negative controls measuring that `AT TIME ZONE` answers
  silently; nonexistent and ambiguous refused on both shift sizes; either occurrence
  reachable by stated offset; a wrong offset refused rather than rounded; an offset
  checked even when unambiguous; cross-midnight explicit; an unknown zone refused by
  name; the resolver's `STABLE` volatility asserted and PostgreSQL's own refusal to
  index it; and the soundness sweep over 14 000+ inputs across ten transition days in two
  zones, with an independent round-trip oracle, together with the control that shows
  `AT TIME ZONE` failing that same sweep. The scan's width is ±1440 minutes, measured
  over every zone the measuring server knows (499 on the approved PostgreSQL 16 target,
  598 on the PG 18.4 comparison container) across the supported range in both directions,
  at one-day granularity so no pair of opposite transitions can cancel, and the supported
  range `1970-01-01`–`2100-01-01` is enforced by its own refusal. A copy of the earlier
  ±180 scan is built in the scratch database to prove what it did wrong: it resolved
  Antarctica/Vostok's 420-minute repeat silently instead of refusing it.

Waits are observed through `pg_blocking_pids` against a separate observer connection,
never slept for, and every barrier is explicit (PART 18). No timing or performance
number from the preparation container appears anywhere in this request.

These suites are **not in required CI**: adding a workflow step is owner-only (TD-08),
and the work is `PREPARED / NOT PROMOTED`. They are run with
`npx vitest run tests/phase9-prep`.
