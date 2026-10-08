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
| `bookings_no_delete()` | raise-only, not a definer | `bookings_no_deletion` BEFORE DELETE | `booking.not_deletable` |
| `bookings_transition()` | raise-only, not a definer | `bookings_transition_only` BEFORE UPDATE | `booking.immutable`, `booking.state_terminal`, `booking.state_not_reopenable` |
| `bookings_buffers_match_service()` | `SECURITY DEFINER`, owned by `daftar_booking_internal`, pinned path | `bookings_buffers_are_the_service_s` — CONSTRAINT trigger, `DEFERRABLE INITIALLY DEFERRED`, `WHEN (kind = 'appointment')` | `booking.service_unreadable`, `booking.buffers_not_the_service_s` |
| `booking_operations_immutable()` | raise-only, not a definer | `booking_operations_no_mutation` | per spec §7 |

Every definer carries `SET search_path = pg_catalog, public, pg_temp` in the project's
exact spelling, asserted from `pg_proc.proconfig`. Every routine is
`REVOKE ALL … FROM PUBLIC`, and the end-state block refuses the deployment if any runtime
login role can execute the buffer guard or the lock-key routine.

`bookings_transition()` freezes, after INSERT: `tenant_id`, `business_id`, `branch_id`,
`id`, `kind`, `resource_id`, `service_id`, `customer_id`, `starts_at`, `ends_at`, both
buffers, `blocking_window`, `rescheduled_from_id`, `intent_sha256`, `created_by_user_id`,
`created_at`. Only `state` and its settlement metadata ever change. A reschedule is a new
row plus a transition on the old one, in one transaction (R-P9-08).

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
owned, pinned and callable by no runtime role; (h) the buffer guard is genuinely
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
5. **Reversal.** Every object this request creates is new. There is no data migration, no
   backfill and no change to any existing relation, so the reverse is a drop of the seven
   relations, their five routines and the one role — but the project's migrations are
   forward-only and frozen once applied, and this request does not ask for a down
   migration.

---

## 9. EVIDENCE

33 cases over three suites, all green, on a live PostgreSQL cluster, applied as
`daftar_migrator`:

* `tests/phase9-prep/p9-booking-schema.test.ts` — 15 cases: the seven relations, the
  frozen history untouched, exactly two exclusion constraints cluster-wide, re-application
  refused atomically, the invariant's shape from `pg_constraint`, row security enabled and
  forced, the whole grant model, the definer's ownership and pinned path, the deferred
  constraint trigger's flags, and no money-shaped column.
* `tests/phase9-prep/p9-booking-concurrency.test.ts` — 11 proofs with **real concurrent
  transactions** (Part 39): overlap refused `23P01`, eight racers giving one commit and
  seven refusals, a rolled-back winner freeing the slot, adjacency committing
  concurrently, buffers inside the invariant under race, per-resource independence, a
  resource block against an appointment, cancellation releasing, reschedule in one
  transaction, two businesses of one tenant on the same clock hour, and timezone
  independence across five zones including a 30- and a 45-minute offset.
* `tests/phase9-prep/p9-booking-negative-controls.test.ts` — 7 cases (Part 40): six
  controls that each remove exactly one invariant, record
  `pg_get_constraintdef` first, show the attack committing, restore, assert the restored
  definition is **character-identical**, and re-run the attack expecting the refusal — plus
  a closing case that the invariant survived every control character for character.

Waits are observed through `pg_blocking_pids`, never slept for. No timing or performance
number from the preparation container appears anywhere in this request.

These suites are **not in required CI**: adding a workflow step is owner-only (TD-08), and
the work is `PREPARED / NOT PROMOTED`. They are run with
`npx vitest run tests/phase9-prep`.
