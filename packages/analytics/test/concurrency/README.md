# P13-PROOF-CONCURRENCY — two real connections, one real PostgreSQL

`remainder-conservation.pgtest.mts` is the first **measured** concurrency
evidence for the Phase 13 point-spend conservation mechanism. Everything else
Phase 13 has produced is pure unit tests (193 of them, in `../`), and the owner
directive behind this file says so plainly: *"test atomic spend/earn/return/
reversal with two connections; 193 pure tests do not prove it."* A fold held in
memory cannot double-spend, so it cannot show that the mechanism is needed, and
it cannot show which half of the mechanism does the work.

This file measures the mechanism's **SHAPE**, against a real cluster, with two
real connections. It is not a migration, not a unit test, and not a benchmark.

## The version this was measured on — read this before quoting any result

```
PostgreSQL 18.4 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit
```

That string is printed at the top of every run from `select version()`; it is
not copied from anywhere else, and it is whatever `embedded-postgres` ships in
this container.

- Phase 5 measured the comparable behaviour on **16.15**.
- The production PostgreSQL line (**16 vs 18**) is an **OPEN OWNER DECISION**.
  The owner has not chosen 18.
- Therefore: **a result in this file is evidence about 18.4 and nothing else.**
  It is **not** evidence for a 16.x target, and it names no production line.
  Anyone citing a SQLSTATE below for a 16.x deployment is citing the wrong
  measurement and must re-run it there.
- **No performance or timing claim is made anywhere.** This container is not a
  measurement box. The proof never asserts a duration and never sleeps.

## How to run it, and why it is not in the unit suite

```
export PATH=<node 24 bin>:$PATH
cd /home/user/daftar
node packages/analytics/test/concurrency/remainder-conservation.pgtest.mts
echo "RC=$?"
```

Observed: `6/6 cases passed`, `RC=0` — three consecutive runs, identical
outcomes in each.

The package's vitest config includes only `test/**/*.test.ts`. This file is
`.mts`, under `test/concurrency/`, **specifically so that it cannot match that
pattern**: it needs a cluster, and the unit suite must stay cluster-free. The
unit suite is unaffected and still reports **7 files / 193 tests, rc=0**.

It starts its own throwaway cluster (`/tmp/daftar-pg-p13`, port 55777, both
overridable via `P13_PG_DIR` / `P13_PG_PORT`), creates a scratch schema inside
it, and **stops the server and deletes the data directory in a `finally`, on
success and on failure alike**.

### What it does NOT touch

`infrastructure/database/migrations/**` is byte-frozen. **No migration file was
read, copied, applied, or opened** in producing this proof. The DDL in the
script is **scratch and unnumbered**, lives only in the throwaway cluster, and
carries no migration number and no `.sql` file anywhere. It models only what
the mechanism needs:

- `point_movements` — the append-only per-customer ledger, ordered by
  `point_seq` (the total order `src/loyalty/points.ts` §4.3 reads lots in:
  `(expires_on, point_seq)`, never a timestamp);
- `point_grant_remainders` — one row per earn, carrying what is **left** of it,
  with non-negativity maintained by **the relation's own trigger**;
- `point_draws` — one row per draw, with
  `UNIQUE (business_id, grant_id, remaining_before)`, modelled on the live
  level-uniqueness pattern that
  `apps/api/src/modules/purchasing/purchasing-errors.ts:504` maps
  (`supplier_credit_allocations_level_uq` — *"one consumer per remaining level
  of a note"*).

### How it waits — deterministic barriers only

There is **no `sleep()` and no timing assumption** in the proof. The house
standard is that a proof waiting on a clock is not a proof. The two connections
are coordinated three ways, all taken from `tests/helpers/stock-ledger.ts`:

- **await ordering** — a statement that has returned has happened, so issuing
  the second connection's statement after awaiting the first's *is* the
  interleaving, not a race to be hoped for;
- **`waitUntilBlocked(pid)`** — poll `pg_stat_activity` until that backend is
  observed with `wait_event_type = 'Lock'`, then report the `wait_event` the
  server named. The assertion is on observed server state; the poll interval is
  only how often we look;
- **`pg_advisory_xact_lock(hashtext('daftar.loyalty_customer_id'),
  hashtext(<customer>::text))`** as an explicit gate, where the mechanism
  itself uses one.

Both connections run under **READ COMMITTED**, read back from
`SHOW transaction_isolation` rather than assumed.

## The cases, and the SQLSTATEs actually observed

Every SQLSTATE below is what the server returned in a run, not what the design
predicts.

| # | Case | Outcome | Observed |
|---|------|---------|----------|
| 1 | **RED PROOF** — conservation as a rule over `sum()` inside the inserting statement | **the double-spend happened** | both inserts `accepted`, both commits `accepted`, committed total **-100** |
| 2 | the per-grant remainder row refuses the second spend | exactly one succeeded | loser refused **`P0001`** (`loyalty.grant_overdrawn … left with -100 points`); it was first observed waiting with `wait_event = transactionid`; remainder committed at `0` |
| 3 | level uniqueness, **no lock taken by either connection** | exactly one succeeded | loser refused **`23505`**, `constraint = point_draws_level_uq`; loser observed waiting with `wait_event = transactionid` |
| 4a | with the advisory lock, the loser's draw fits | **waited, then PROCEEDED** | `wait_event = advisory`; re-read fresh `remaining_before = 60`; both 40s committed, 20 left |
| 4b | with the advisory lock, the loser's draw no longer fits | **waited, then REFUSED on fresh state** | `wait_event = advisory`, then **`P0001`** (`… left with -20 points`) |
| 4c | no lock, bound against state that has already moved | **REFUSED IMMEDIATELY** | **`23505`** on `point_draws_level_uq`, backend never observed parked |
| 5a | both transactions draw the same two grants in the same `(expires_on, point_seq)` order | both completed | loser observed waiting (`wait_event = transactionid`), then accepted and committed |
| 5b | opposing orders | **deadlock** | **`40P01`** (`deadlock detected`), exactly one victim, the other accepted |
| 6a | an uncommitted earn concurrent with a sale | the sale committed | sale's draw/decrement/consume/commit all `accepted`; the sale's backend observed parked on a lock at **no** step |
| 6b | the earn then fails and rolls back | isolated | **`23505`**, `constraint = point_grant_remainders_pkey`; ledger `100 → 30` as the sale left it; 0 rows left behind |

Case 1 **asserts the defect**: it fails loudly if the double-spend does *not*
happen, so it cannot quietly become decoration. That is what makes it evidence
that the mechanism is needed rather than a restatement of it.

## What the measurements CONTRADICT or qualify in the mechanism's design

These are the most valuable lines in this file. Each is an observation, not an
expectation.

1. **"No lock taken at all" is true of the application, not of the server.**
   Case 3's design claim is that level uniqueness collides *without any lock*.
   It does — neither connection takes `FOR UPDATE`, a row lock, or an advisory
   lock. But the loser was nevertheless **observed parked** with
   `wait_event = transactionid`: a unique index makes the second inserter wait
   on the first inserter's transaction id until that transaction ends, and only
   then refuses it. So **level uniqueness removes the need to remember a lock;
   it does not remove the wait.** Any design text claiming the constraint path
   is non-blocking is wrong on 18.4. The difference the lock makes is *which*
   wait and *what the loser can do next* (cases 4a/4b/4c), not whether a wait
   exists.
2. **The remainder trigger's refusal is `P0001`, not a constraint-shaped
   SQLSTATE.** A plpgsql `RAISE` carries no constraint name, so a caller cannot
   map it the way `purchasing-errors.ts` maps `…_level_uq` by constraint name —
   `P0001` is indistinguishable from every other domain refusal unless the
   message text is parsed, which the repository's error mapper deliberately
   does not do. The level key, by contrast, returned `23505` **with
   `constraint = point_draws_level_uq`**, which is mappable. This is a
   measured argument for level uniqueness being the *stronger* guard in a
   second sense the task did not ask about: not only does it hold without a
   lock, it also refuses in a form the API layer can already translate.
3. **Row-lock and index waits both reported `wait_event = transactionid`**, not
   `tuple`. Any monitoring or test helper that keys on a specific `wait_event`
   name (rather than `wait_event_type = 'Lock'`, as the house helper does)
   would be matching the wrong string here.
4. **The deadlock victim is the server's choice.** In case 5b the aborted
   transaction was, in both recorded runs, the oldest-first one — but nothing
   in PostgreSQL promises that, and the proof therefore asserts only that
   **exactly one** victim exists and reports its SQLSTATE. A retry policy must
   not assume which side loses.
5. **Case 1 needed no race window.** Two inserts conflict on no lock, so the
   naive `sum()` rule is not "usually right and occasionally wrong under
   load" — it is unconditionally bypassable by any two overlapping
   transactions. There is nothing to tune.

## What remains UNMEASURED

This proof covers the mechanism's **shape** on a scratch schema. It does not
cover:

- **`return` and `reversal`**, which the owner directive names alongside spend
  and earn. Only **spend** and **earn** are exercised here; the scratch ledger
  admits `earn/consume/adjust/expire` only, and no return or reversal path was
  run against two connections. The remainder relation's over-restore guard
  (`remaining_points > granted_points`) exists in the scratch trigger but was
  **never raced**.
- **The real schema.** Nothing here ran against the Phase 13 migration DDL, the
  real routines, RLS, or the real tenant/business scoping — by design: no
  migration was read. Whether the real relations carry the trigger and the
  level key in these shapes is **not** established by this file.
- **Isolation levels other than READ COMMITTED.** No REPEATABLE READ, no
  SERIALIZABLE, so no `40001` was ever observed or sought.
- **More than two connections.** No three-way races, no deadlock cycles longer
  than two, no contention fan-out.
- **Retry behaviour.** The proof observes refusals; it never retries one, so
  nothing here shows a retry loop terminates or that a re-bound draw is
  eventually accepted under sustained contention.
- **`lock_timeout` / `statement_timeout` / `deadlock_timeout` settings**,
  connection pooling, pgbouncer and transaction-mode pooling (which would break
  `pg_advisory_xact_lock` semantics).
- **The expiry sweep** running concurrently with a spend.
- **Any timing, throughput or latency figure**, and **any behaviour on
  PostgreSQL 16.x**, which is the version the production line may actually be.
