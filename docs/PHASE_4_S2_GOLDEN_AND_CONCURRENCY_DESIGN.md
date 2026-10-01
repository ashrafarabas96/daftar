# P4-S2 — THE GOLDEN AND CONCURRENCY DESIGN

**Slice.** P4-S2, the sale commit primitive.
**Owner of this document.** Agent D (goldens and concurrency).
**Baseline.** `9b3e222`, the sealed P4-S1 head.
**Authority.** `docs/PHASE_4_ARCHITECTURE_LOCK.md` §15, §17.4 and the `P4-AL-*`
decisions cited inline; `docs/PHASE_4_EXECUTION_PLAN.md` P4-S2;
`docs/DAFTAR_GOLDEN_REGRESSION_SUITE.md`.

This document is the record of **how** the hardest claims of P4-S2 are proved,
and of the three places where what the estate already contains made a different
shape necessary than the one the lock describes. It is not a plan: every file it
names exists in this commit.

---

## 0. What is green today and what is red until the primitive lands

| file | state today | why |
|---|---|---|
| `tests/golden-regression/phase4-s2/05-last-item-race.golden.test.ts` | **GREEN**, 11 tests | G-01's no-oversell half is a property of `inventory_apply_stock_movements`, which exists; the sale is required to use it unchanged (P4-AL-29, OD-P4-05) |
| `tests/integration/sale-s2-interleaving.test.ts` | **GREEN**, 8 tests | the mechanism's own proofs, including a planted deadlock |
| `tests/guards/sale-s2-red-proofs.test.ts` | **GREEN** | pure law-tampering, the canary's two directions, the runner's exit status, the red-proof table's resolution |
| `tests/golden-regression/phase4-s2/06-sale-last-item-race.golden.test.ts` | **RED by canary** | `sales`, `sale_items`, the bridge, the two accounting source types, the `sale.*` kinds and the commit routine do not exist |
| `tests/golden-regression/phase4-s2/07-atomic-sale-law.golden.test.ts` | **RED by canary** (one case green: the chart identities) | same |
| `tests/golden-regression/phase4-s2/08-sale-idempotency.golden.test.ts` | **RED by canary** | same |
| `tests/integration/sale-s2-atomic-law.test.ts` | **RED by canary** | same |

A red-until-implementation suite is the intended state, not a defect. Nothing is
`.skip`, `.todo`, `.only` or conditional: a conditional pass is a `.skip` the
gate's SKIP regex cannot see, and a suite that reported green while its subject
did not exist is the vacuity defect this estate keeps rediscovering. Each red
names exactly what is missing, so the day the primitive lands each file either
goes green or states a real defect.

---

## 0. Why this work is not pushed on its own — integration sequencing

`npm run test:integration` runs `tests/integration tests/security tests/guards` and
`npm run test:golden` runs the whole of `tests/golden-regression` (`package.json:20-21`),
and both are steps of the `backend` CI job (`.github/workflows/ci.yml:159-164`). Four of
the suites here refuse, correctly and by canary, until the sale primitive exists:
`06-sale-last-item-race`, `07-atomic-sale-law`, `08-sale-idempotency` and
`tests/integration/sale-s2-atomic-law`. On a head without `0077` and the commit service,
those refusals are CI red.

Nothing is removed, parked, skipped or relocated to make that red go away — a suite moved
out of the test scripts' reach is a suite nobody runs, and the move back is the step that
gets forgotten. The suites stay exactly where they are and the **push** waits instead: this
merge is held locally until the migration owner's `0077` and the sale contract owner's
commit service land, and the whole slice goes up as one head whose CI is green because the
canaries' subject exists. The three suites whose subject exists today — `05-last-item-race`,
`tests/integration/sale-s2-interleaving` and `tests/guards/sale-s2-red-proofs` — are green
already and were verified so before the merge.

## 1. Placement — a constraint that is not the one the brief anticipated

`suiteProblems` in the **sealed** `scripts/phase4-s1-gate.ts` fails:

* any `phase4-*` or `p4-*` `.test.ts` in `tests/integration`, `tests/security`
  or `tests/performance` that no `S1_SUITES` row lists (`:750-753`); **and**
* **any `.test.ts` at all under `tests/golden-regression/phase4/` that no
  `S1_SUITES` row lists** (`:755-758`, `GOLDEN_DIR` at `:165`).

The second clause is the one that matters here and it was not in the brief. A
new golden placed in `tests/golden-regression/phase4/` — which is where §17.4
says the Phase 4 goldens live — turns the **sealed** `gate:phase4:s1` red,
because the only way to satisfy it is a new `S1_SUITES` row in a sealed file
that this agent may not edit and a gate that is not reopened.

So the P4-S2 goldens are placed in **`tests/golden-regression/phase4-s2/`**:

* still inside `tests/golden-regression/**`;
* still run by `npm run test:golden`, which runs the whole tree
  (`package.json:21`), satisfying the `OD-P4-10` OPTION A ruling;
* outside `GOLDEN_DIR`, so the sealed gate is untouched;
* `scripts/phase1-gate.ts:53` counts `tests/golden-regression` as a **floor**
  (`requireDir(..., 4, ...)`), so a new subdirectory cannot break it.

The integration suites are named `sale-s2-*`, following the
`inventory-s3-*` / `purchase-s4-*` convention, for the first clause.

**Checked, not assumed.** `tests/guards/sale-s2-red-proofs.test.ts` calls
`suiteProblems(REPO)` from the sealed gate and asserts it returns `[]`. With
every file of this commit present it does. That assertion is what keeps the
placement true after the next file is added.

**For the Tech Lead.** If the goldens are wanted inside
`tests/golden-regression/phase4/` as §17.4 describes, `S1_SUITES` needs rows for
them and the sealed gate has to be reopened. That is a decision, not an edit,
and it is not made here. `gate:phase4:s2` should list the four files above
whichever directory they end in.

---

## 2. How the last-item interleaving is forced, and why it cannot depend on timing

`[[daftar-a-test-whose-verdict-is-the-machines-speed]]`. FI-11 passed on a slow
host and failed on a fast one and proved nothing either way. P4-AL-42 requires
the ordering to be injected.

**The gate point.** `inventory_apply_stock_movements` locks, for every distinct
stock key, in ascending `(warehouse_id, variant_id)` order whatever the payload
order: `INSERT … ON CONFLICT DO NOTHING` then `SELECT … FOR UPDATE`
(`0060:291-306`). The no-oversell refusal
(`inventory.insufficient_stock`, `0060:382-384`) is raised **after** that lock,
against the value re-read from the locked row. That row lock is therefore the one
place where the final unit is decided, and it is where the park goes.

**The mechanism** (`tests/golden-regression/phase4-s2/harness.ts`):

1. `parkStockKey` opens a **second connection**, `BEGIN`s, and takes
   `SELECT 1 FROM stock_levels … FOR UPDATE` on the key. If the row is not
   there it **throws**: a park that holds nothing forces nothing, and the
   suite must not proceed as though it had.
2. Attempt 1 is launched and *not* awaited. `waitUntilQueued` polls
   `pg_blocking_pids` until a backend is **observed** parked behind the park's
   pid.
3. Only then is attempt 2 launched, and the same observation is made for it.
   The queue now holds attempt 1 ahead of attempt 2 **because the suite put
   them there one at a time**.
4. The park is released in a `finally`. PostgreSQL grants the row lock in queue
   order, so the service order is the order this file chose.

**`blockedBehind` is a fixed point, and that is load-bearing.** With one holder
and two waiters on one row, PostgreSQL reports the second waiter as blocked by
the **first waiter**, not by the parker. A single-step "blocked directly by the
parker" test therefore sees one waiter where there are two, releases the park
with half the race enqueued, and reports a green race that never happened. The
harness iterates the blocker graph to a fixed point, and
`tests/integration/sale-s2-interleaving.test.ts` proves both facts: the fixed
point finds two, and the single-step form finds fewer.

**No sleep decides anything.** There is no `sleep` in any of these files. The two
bounded polls are *observations*, and either outcome other than "observed
parked" is a thrown **failure**:

* the attempt **settled** without ever parking → it did not contend, so its
  result is not a race result;
* the bound **expired** → a statement that was supposed to block never blocked,
  which is the missing serialization itself.

A faster or slower host changes how many times the poll runs and changes no
verdict. Both refusals are proved able to fire (`RP-S2-UNFORCED`, `RP-S2-BOUND`).

---

## 3. A deadlock is a lock-order defect, never a business outcome

`[[daftar-lock-order-not-retry]]`, P4-AL-41. Two connections used in sequence are
not contention.

* The race shape — one holder, two waiters, one lock — **cannot** deadlock. If
  one appears anyway, `expectNoDeadlock` fails the case with the lock-order
  sentence and names the SQLSTATE. Nothing retries, nothing touches
  `deadlock_timeout`, and no caller may read `40P01` as a business outcome.
  `classify()` gives `40P01` its own outcome kind so it cannot be mistaken for
  one. A static assertion over the harness's own source (comments and string
  literals stripped) keeps `deadlock_timeout` and the word *retry* out of the
  mechanism.
* **The lock-order probe is deterministic, and does not need a deadlock.** A
  deadlock is the *symptom* of a payload-ordered writer and needs luck to
  reproduce; the acquisition order is the *defect* and is observable every time.
  So: park **both** keys, launch two commands whose payload orders are the
  reverse of one another, observe both into the queue, and then ask which held
  key anything is waiting for. Key-sorted acquisition ⇒ **nothing** is waiting
  on the higher key. Payload-order acquisition ⇒ the descending command is
  waiting on the higher key, and the count is non-zero. That is the whole
  verdict, with no retry, no N rounds and no reliance on a collision.
  `gate:phase4:s8`'s "every pair in both orders N times" remains S8's.
* The verdict is proved able to fire: `sale-s2-interleaving` plants a real
  `40P01` by taking two rows in opposite order on two connections — with the
  interleaving forced, not hoped for — and asserts that `expectNoDeadlock`
  throws and says `LOCK-ORDER DEFECT`.

---

## 4. The atomic sale law (§15), by failure injection at every seam

**The seven forbidden committed states** are in
`tests/golden-regression/phase4-s2/atomic-sale-law.ts` as `LAWS`, a **pure
function of the projected committed state**:

| id | forbids |
|---|---|
| `L0` | a verdict reached over a database that contains no sale |
| `L1` | a sale with no stock movement |
| `L2` | a stock movement with no invoice |
| `L3` | an invoice with no accounting binding |
| `L4` | a COGS entry with no commercial source |
| `L5` | a revenue entry without an invoice |
| `L6` | an inventory decrement without COGS |
| `L7` | a partial sale: a sale or invoice without its lines, an entry without its binding |

They are a pure function and not a list of `SELECT`s **because a law has to be
able to say no**. A law written as a query a suite asserts returns no row can
only be proved able to say no by planting a violation in a real database, which
needs a writer nobody has and a migration this agent may not write. A law over a
projection is proved by handing it a projection that violates it —
`tests/guards/sale-s2-red-proofs.test.ts` does that for **all seven**, in
milliseconds, forever, and additionally asserts that no law is on the books
without a planted defect. `readSaleWorld` builds the projection with one query
per relation and computes nothing in SQL, so no law is expressed twice.

`L0` is the canary **inside** the law: a world with no sale satisfies six
universally-quantified sentences and tells a reviewer nothing, so it is itself a
violation.

**Injection at every seam** (`tests/integration/sale-s2-atomic-law.test.ts`),
extending the `expectNothingSurvives` idiom of
`tests/integration/inventory-s3-atomicity.test.ts:93-103`:

* **(a) inside the transaction, at each relation the path writes.** A
  `BEFORE INSERT OR UPDATE` trigger that raises is installed on one relation
  (named `zz_p4s2_inject` so it is the last BEFORE trigger alphabetically and
  the failure lands as late in the write as a trigger can), the sale is
  confirmed, and the census must show that **nothing** survived. Dropped in a
  `finally`. This injector needs no cooperation from the service and reaches
  seams no spy outside the transaction can reach, including the ones inside the
  SQL routine. The seams: `sales`, `sale_items`, `stock_movements`,
  `stock_source_bridge_sale`, `journal_entries`, `journal_lines`,
  `accounting_source_bindings`, `invoices`, `invoice_items`, `stock_levels`,
  `invoice_sequences`.
* **(b) at the posting port.** The sale posts twice (the COGS entry, then the
  revenue entry), so `DatabaseAccountingPostingAdapter.postEntryInTransaction`
  is failed on the **first** call and, separately, on the **second** — two
  distinct seams that bracket the invoice. This is the existing idiom and needs
  no new product seam.

**The seam set is discovered, and the hand-written list is only a floor.** An
uninjected sale is run first and every relation whose count moved is a seam, so
a relation the commit path writes that nobody listed is injected the day it is
written. The relations P4-AL-16 names by hand are asserted as a **floor** of
that set, never as an equality (`[[daftar-a-closure-rule-is-not-an-invariant]]`,
P4-AL-88) — a later slice adding a relation to the sale path must not turn this
red for being a later slice. A separate case reports any discovered seam no case
injects at, so the floor and the set cannot drift apart silently.

**One `it` per seam and one `it` per law.** A failing assertion aborts its test
body and hides every assertion after it; P4-S1 measured 27 → 30 → 32 across
three rounds for exactly that reason. Each law and each seam is its own case, so
one broken law hides none of the others.

---

## 5. The reconciliation formula

The official identity, asserted after every scenario:

```
GL Inventory (1200) == Σ stock_movements.value_delta_base_minor
```

Integer minor units on both sides. P4-AL-25 and `TL-P4-S0-01`:
`quantity × average_cost` is **never** the reconciliation truth, because the
average is a rounded quotient and re-multiplying it reintroduces the drift the
stored integer delta has already resolved
(`[[daftar-a-rounded-quotient-is-never-an-input]]`,
`[[daftar-rounding-is-not-additive]]`).

**`docs/DAFTAR_GOLDEN_REGRESSION_SUITE.md:41` still states GOLD-33 as
`GL(1200) = Σ(qty×avg_cost)`** — the forbidden reconstruction. The lock
supersedes it. That document is not this agent's file; the correction is
reported rather than made.

`expectInventoryReconciled` also asserts the identity has a **subject**: a
business with no movement satisfies `0 == 0` and proves nothing, so the movement
count must be positive. Golden 05 keeps a standing position in a third product
for the same reason — without it the business ends at `0 == 0` after a +1/−1
pair, and the assertion would have been true and empty. Golden 07 goes further
and buys at **two different costs** (7 at 3.00, 3 at 4.33) so that the official
identity and the forbidden reconstruction **disagree numerically**, then asserts
that they disagree: a suite that silently swapped one formula for the other
cannot stay green.

Account codes are **written out** from `0040_accounting_chart.sql`
(`inventory`→`1200`, `sales_revenue`→`4000`, `cogs`→`5000`, `0040:53,59,63`) and
checked against the account the business holds under each engine identity —
V-P4-05's finding, and the reason P4-AL-65 refuses "it balances" as an
assertion: a balanced entry made of the wrong accounts balances perfectly.

---

## 6. Idempotency (G-16)

P4-AL-30: a caller-supplied document UUID plus a stored `intent_sha256`, read
before any write. D-03: no commercial table in this estate carries an
`idempotency_key`, and `DATA_MODEL.md` §17 is superseded for domain commands —
so golden 08 asserts the accepted mechanism and additionally asserts that
`sales.idempotency_key` is **absent**, because two idempotency mechanisms on one
table are two truths about whether a command already ran.

Both halves are needed. The **structural** half reads `pg_constraint` and
`pg_attribute` — a `UNIQUE` or primary key covering `(business_id, id)` whose
columns resolve, and a `*_intent_sha256` column with a shape `CHECK` — because a
service-layer "we looked first" is not idempotency: two concurrent replays both
look, both see nothing, and both write. The **behavioural** half sends the same
document twice and requires one sale, one movement, one decrement, one invoice
and no second entry; and sends the same id with a **different** intent and
requires a refusal.

---

## 7. Non-vacuity, canaries, and what is never asserted

**The canary.** `saleSubject()` reads what exists from the catalogue — the
relations, the commit routine, the `sale` stock source type, the `sale` and
`invoice` accounting source types, the `sale.*` operation kinds — and
`requireSubject()` **throws**, naming what is missing. It does not skip, warn or
return a flag a caller could ignore. `requireColumns()` is the same canary at
column grain, because a law written against a column that is not there raises
`42703` from inside a helper and reads as an infrastructure error rather than as
"this claim has no subject". Both directions are proved: the canary throws when
the subject is absent and does **not** throw when it is present — a canary that
could only throw would be a permanent red.

**The exit status.** A gate that reads a verdict out of an exit status must first
prove that status can say no; this project's runner once exited 0 over four
failing tests. `sale-s2-red-proofs` spawns a real runner over a deliberately
failing test under a **minimal** config (no `globalSetup`, no `setupFiles`, so
the proof is about the runner and not about the estate's harness) and requires a
non-zero exit **and** `1 failed` in the output — then requires exit 0 over a
passing test, because a status that is always non-zero is as useless as one that
is always zero. *A related trap met while writing this: piping the runner into
`grep`/`tail` replaces its exit status with the pipeline's. A gate must not read
a verdict through a pipe.*

**The census is discovered, never listed.** The accepted H-7 counter
(`tests/helpers/inventory-commands.ts:756`) names its tables as literals, so a
relation a later slice adds is outside it and a row that survives a rolled-back
command there is invisible to every atomicity suite built on it. `census()` reads
every ordinary public table carrying `business_id` out of `pg_class`, plus every
table carrying `jti`, so `sales` and `sale_items` are inside it the day they are
created with no edit anywhere. Proved: the discovered census reaches `purchases`,
which the hand-maintained counter does not name.

**No `toEqual` over a set a later phase populates** — `P4-AL-88`,
`[[daftar-a-closure-rule-is-not-an-invariant]]`. Every law here is of the form
"for every X that exists, Y". The relation inventory is **derived** from the
Phase 4 migration range (`phase4Sql` + `readTables`), the seam set is derived
from an uninjected sale, and the hand-written P4-AL-16 list is a **floor**
compared with `filter`, never an equality. S4's payments, S5's credit notes and
S6's reversals arriving makes none of these sentences false.

**One run never bounds the breakage.** A failing assertion aborts its test body
and hides every assertion after it. This document states no breakage count. When
the primitive lands, any count taken from these suites is a **floor**, with the
method beside it, and must be re-taken until a round finds nothing new.

---

## 8. Open items for other owners

1. **`docs/DAFTAR_GOLDEN_REGRESSION_SUITE.md:41`** states GOLD-33 as
   `GL(1200) = Σ(qty×avg_cost)`, the reconstruction P4-AL-25 and `TL-P4-S0-01`
   forbid. The document should be corrected to
   `GL(1200) = Σ stock_movements.value_delta_base_minor`.
2. **`S1_SUITES` / `gate:phase4:s2`.** See §1. The four P4-S2 suites and the
   guard suite need rows in the S2 gate; if the Tech Lead wants the goldens
   inside `tests/golden-regression/phase4/`, the sealed S1 gate must be reopened.
3. **The sale command's body.** `tests/golden-regression/phase4-s2/sale-path.ts`
   is the **only** place any suite names a field of the sale request, and
   `SALE_BODY_SHAPE` records the assumption in one string. When the real DTO
   lands, that one file changes and no assertion in any suite moves. The selling
   module owner should check it against the DTO rather than letting the suites
   be rewritten line by line — a rewrite is where a law quietly becomes a
   weaker law.
4. **`tests/helpers/` was not edited.** Everything shared lives under
   `tests/golden-regression/phase4-s2/` and is imported from there by the
   integration and guard suites, following the precedent of
   `tests/guards/phase4-composite-seam-guard.test.ts:30`.
