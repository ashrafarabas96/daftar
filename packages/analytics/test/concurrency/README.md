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
PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit
datcollate=en_US.utf8 datctype=en_US.utf8 encoding=UTF8
```

Both lines are printed at the top of every run — the first from
`select version()`, the second read back from `pg_database` for the connected
database. Neither is copied from anywhere else.

**This is the settled deploy line.** An earlier revision of this proof ran on
PostgreSQL **18.4** — whatever the repository's `embedded-postgres` ships — and
labelled itself, correctly at the time, as evidence about the mechanism's shape
and *not* about any production target, because the version was then an open
owner decision. **That decision is now settled: the PostgreSQL 16 family with
`en_US.utf8`.** So the proof no longer runs on a version nobody chose:

- it looks for a 16.x `bin` directory (`P13_PG_BINDIR`, else the well-known
  locations) and runs that distribution's own `initdb`/`pg_ctl`, creating the
  cluster with `--locale` from `P13_PG_LOCALE` (default `en_US.utf8`) and
  `UTF8`;
- it reads the collation and encoding back out of the catalogue and prints
  them, so a reader never has to trust this file;
- if no 16.x binaries exist it falls back to `embedded-postgres` and prints
  **`OFF-TARGET`**, stating in the banner that the run is not evidence for the
  target.

**No performance or timing claim is made anywhere.** This container is not a
measurement box. The proof never asserts a duration and never sleeps.

## How to run it, and why it is not in the unit suite

```
export PATH=<node 24 bin>:$PATH
cd /home/user/daftar
node packages/analytics/test/concurrency/remainder-conservation.pgtest.mts
echo "RC=$?"
```

Observed: `10/10 cases passed`, `RC=0` — three consecutive runs on
PostgreSQL 16.15. The outcomes were identical in each **except one, which is
itself a finding**: the deadlock victim in case 5b differed between runs on the
same cluster and the same version (see qualification 4 below).

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
| 7a | two connections reverse the **same** return document (a FULL reversal) | restored exactly **once** | loser observed waiting (`wait_event = transactionid`), then refused **`23505`**, `constraint = point_movements_identity_uq`; ledger `60 → 100`, grant back at `100 of 100` |
| 7b | a restoration one point beyond what the grant granted | refused | **`P0001`** (`loyalty.grant_over_restored`) — the conservation law holds in **both** directions |
| 8a | a sale draws the whole grant, then **fails**; a second connection waits behind it | the second sale spent the same points successfully | the waiter observed parked (`wait_event = advisory`), then read `remaining = 100` after the rollback and drew at **the same level** the failed sale had drawn at: `accepted` |
| 8b | what the failed sale left behind | nothing | ledger `100 → 0` (one consumption, not two), remainder `0`, **exactly 1** surviving draw row |
| 9 | the lock loser's re-bind retry, with a competing sale committing **after** each bind | **terminated on attempt 4** | 3 forced retries, each refused **`23505`** on `point_draws_level_uq` at binds of `100`, `80`, `60`; then spent at a bind of `40`. Identical in all three runs |
| 10 | an expiry sweep takes a grant's whole remainder; a sale waits behind it | the sweep won, the sale was **refused** | sale observed parked (`wait_event = advisory`), re-read `remaining = 0` after the sweep committed, and its spend was refused **`P0001`**; ledger `100 → 0` — the points were taken **once** |

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
   is non-blocking is wrong on both versions measured (18.4 and 16.15). The difference the lock makes is *which*
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
4. **The deadlock victim is the server's choice, and this is now MEASURED,
   not merely argued.** An earlier revision of this file reasoned that nothing
   in PostgreSQL promises which side loses, having observed the oldest-first
   transaction aborted in both runs on 18.4. On 16.15 the victim **flipped
   between two consecutive runs of the identical script against the identical
   cluster** — `B` in run 2, `A` in run 3. So any retry policy that assumes a
   side, or any test that asserts one, is wrong; the proof asserts only that
   **exactly one** victim exists and reports whichever SQLSTATE it observed.
5. **Case 1 needed no race window.** Two inserts conflict on no lock, so the
   naive `sum()` rule is not "usually right and occasionally wrong under
   load" — it is unconditionally bypassable by any two overlapping
   transactions. There is nothing to tune.

## What remains UNMEASURED

This proof covers the mechanism's **shape** on a scratch schema, now on the
settled deploy line. It does **not** cover:

- **The real schema.** Nothing here ran against the Phase 13 migration DDL, the
  real routines, RLS, or the real tenant/business scoping — by design: no
  migration was read. Whether the real relations carry the trigger, the level
  key and the identity key in these shapes is **not** established by this file.
- **The official sale authority.** The whole point of the atomicity law is that
  consumption rides inside the sale's own transaction. Case 8 models that with
  a hand-written transaction, because the authority that would own the seam
  does not exist on `main` at all — `selling`, `receivables` and `pos` are
  present only on the Phase 4 branch. Until that surface integrates, the seam
  itself stays `WAITING_FOR_INTEGRATED_SURFACE`, and case 8 is evidence about
  transaction semantics, not about the real command.
- **The PARTIAL return.** Deliberately. The loyalty design's §5.7.4 marks it
  `WAITING_FOR_EXPLICIT_POLICY` and states that no test case is written for
  it; none is written here either. Case 7 covers the **full** reversal, which
  is the only arm v1 specifies.
- **Isolation levels other than READ COMMITTED.** No REPEATABLE READ, no
  SERIALIZABLE, so no `40001` was ever observed or sought.
- **More than two connections.** Case 9 runs a bounded competitor one
  transaction at a time; there are no three-way races, no deadlock cycles
  longer than two, and no contention fan-out. Case 9 therefore bounds the
  **number of attempts against a bounded competitor** — it is not a progress
  guarantee against an adversarial writer that never yields.
- **Whether the expiry sweep SHOULD win.** Case 10 measures that the sweep and
  a spend cannot both take the same points. Which of them ought to win when a
  sweep fires mid-sale is a **loyalty-configuration policy question** for its
  owner, and this proof does not answer it.
- **`lock_timeout` / `statement_timeout` / `deadlock_timeout` settings**,
  connection pooling, pgbouncer and transaction-mode pooling (which would break
  `pg_advisory_xact_lock` semantics).
- **Any timing, throughput or latency figure.**

## Exit codes, for the handoff

Every number quoted above comes from a run whose exit code was recorded. The
three gates and this proof, measured together on Node **v24.12.0** (the CI
line) against this working tree:

| Command | Result | Exit code |
|---|---|---|
| `node packages/analytics/test/concurrency/remainder-conservation.pgtest.mts` | `10/10 cases passed` | **0** (three consecutive runs) |
| `../../node_modules/.bin/vitest run` (in `packages/analytics`) | 7 files, 193 tests passed | **0** |
| `../../node_modules/.bin/tsc -p tsconfig.json --noEmit` | no diagnostics | **0** |
| `./node_modules/.bin/eslint packages/analytics` (from the repo root) | no findings | **0** |
| `./node_modules/.bin/eslint .` (from the repo root) | 4220 errors, **0 of them in `packages/analytics`** | **1** |

That last row needs its honest reading. The repository-wide `eslint .` is red
at 4220 errors, and **every one of them is outside this package** — measured by
grouping the JSON formatter's output by path, not estimated. The root command
was red before Phase 13 existed and is red for reasons Phase 13 did not create
and is not asked to fix. What Phase 13 is answerable for is its own
contribution, which is **zero**.
