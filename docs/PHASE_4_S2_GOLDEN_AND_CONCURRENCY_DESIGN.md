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
| `tests/golden-regression/phase4-s2/06-sale-last-item-race.golden.test.ts` | **RED by canary** | after `0077`, the canary names ONE missing subject: `the sale commit routine sale_commit`, which is `0078`'s. It named eight before `0077` |
| `tests/golden-regression/phase4-s2/07-atomic-sale-law.golden.test.ts` | **RED by canary** (one case green: the chart identities) | same |
| `tests/golden-regression/phase4-s2/08-sale-idempotency.golden.test.ts` | **RED by canary** | same |
| `tests/integration/sale-s2-atomic-law.test.ts` | **RED by canary** | same |

Measured on the merge of `0077` (integration head `1b5a606`), on a pristine
cluster: 39 passed over the three green files, 47 failed over the four
canary-red ones, and **every one of those 47 failures is a `requireSubject`
throw naming the single missing name `the sale commit routine sale_commit`** —
no failure of any other kind. `tests/golden-regression/phase4/01-cross-tenant.golden.test.ts`
is 18 passed / 4 failed on the same canary. That is the predicted move from
"eight missing" to "one missing"; the green pass is planned for after `0078`.

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

## 7b. The three corrections of the first review round

Recorded because each is a defect class this document claims to refuse, found
in this document's own estate.

**(i) `crossTenantProblems` — the sealed-gate clause §1 did not cover.** §1
found the `GOLDEN_DIR` clause of `suiteProblems`. There is a THIRD way to
redden the sealed gate: `crossTenantProblems`
(`scripts/phase4-s1-gate.ts:1313-1329`) derives G-02's subject from the
controllers (`discoverPhase4Routes`) and requires the text of every golden
listed with `area === 'golden'` to name every route it finds. P4-S2's
`SalesController` mounted `POST /v1/sales` and `GET /v1/sales/:saleId`, and the
gate went red — **the mechanism of G-02 working exactly as designed**: the
route nobody remembered to add is by construction the one route with no
cross-tenant case.

The two routes are therefore added to the **existing listed** golden,
`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts`, and not to a
new file, which the `GOLDEN_DIR` clause would reject. `POST /v1/sales` is the
first **writing** route on the Phase 4 surface, and neither of that suite's two
generic loops can state its claim: a collection loop would have issued the POST
as a GET and an item loop would have asked for a sale id no business holds, and
both 404s would have read as isolation. So the surface is now partitioned —
generic read routes, and the sale routes in their own section with their own
ALLOW/DENY pairs, refusing through `requireSubject` until `0077` supplies a
committable sale. Its fixture is built lazily **inside** that section, so the
suite's existing 300-second `beforeAll` and the eight read routes keep their
current verdict.

While there: that suite asserted `expect(PHASE4_ROUTES).toHaveLength(8)` beside
the equality against `discoverPhase4Routes`. The literal is a second copy of
the line above it and a closure rule on the surface — it must be hand-edited
for every authorized route a later slice mounts, and that edit is the moment
somebody edits the list instead of adding the route's pair
(`[[daftar-a-closure-rule-is-not-an-invariant]]`). What it was really guarding
is non-vacuity, which is now what it says; the exact surface stays the business
of the equality. A new assertion also requires the two partitions to cover the
surface exactly once, so a route can be in neither loop only by being declared
a sale route.

**(ii) a canary that could not fail, inside the placement test.** The
placement check read

```ts
const mine = files.filter((f) => /^sale-s2-/.test(f));
expect(mine.filter((f) => /^(p4|phase4)-/.test(f)), …).toEqual([]);
```

`mine` is already filtered to names beginning `sale-s2-`, so no member can
match the inner regex and the assertion could only ever say yes — the
`RP-S2-VACUITY` class, in the test whose stated job is the placement
constraint. The law is now stated over the **whole** directory listing ("every
`phase4-*`/`p4-*` suite in these three directories is listed by `S1_SUITES`"),
with the number of files it judged asserted non-zero so a regex that stopped
matching cannot read as a clean estate. The rule is also extracted as
`sealedGateWouldReject(path)`, a function of a path, which is the only way to
prove it **refuses**: putting the offending file on disk IS the defect, so the
predicate is asked about files that are not there. `RP-S2-PLACEMENT-PREDICATE`
plants the two names this estate was tempted to use, plus an unlisted golden
under `tests/golden-regression/phase4/`, and requires each to be rejected and
the four real paths to be accepted.

**(iii) a red proof that a header comment could satisfy.** "Every declared red
proof resolves to a real `it(` title" resolved each row with a bare
`source.includes(title)`, which any prose in the file satisfies. All 20 rows
named real titles, so nothing was false — but the check could not have said
otherwise. `itTitles()` now extracts the first argument of every `it(`, in both
the string-literal and the template-literal forms, and `resolves()` matches a
literal title by prefix and a **generated** title by pattern (so
`a failure at the sales seam leaves nothing` still resolves against
``it(`a failure at the ${relation} seam leaves nothing`)``). `RP-S2-RESOLVER`
proves it: a prefix only the prose carries does **not** resolve, and a
concrete instance of a generated title does.

**(iv) the commit routine's name has one owner.** `harness.ts` guessed among
four candidate names. A guess is the wrong shape even when one candidate is
right: the canary's job is to say "the subject is absent", and a guessing
canary says that both when the routine is missing and when it was renamed
outside the list — so a rename would have left every P4-S2 suite permanently
red for a reason that is not a defect, and the fix would have been to widen the
guess rather than to follow the name. The harness now re-exports
`SALE_COMMIT_ROUTINE` from `sale-path.ts`, which the slice that owns the route
keeps correct, and golden 01 asserts the discovered routine IS that constant.

---

## 7c. The three items of the second review round, after `0077`

### (a) The `invoices_sale_fk` parent — open item 4 below, closed

`0077:353` added
`invoices_sale_fk FOREIGN KEY (business_id, sale_id) REFERENCES sales (business_id, id)`,
exactly as §8.4 predicted, so `seedPhase4` in
`tests/golden-regression/phase4/01-cross-tenant.golden.test.ts` — which passed a
fresh `randomUUID()` as `sale_id` with nothing behind it — stopped inserting and
took all 22 tests of the suite with it. Measured, not assumed: with the orphan
`sale_id` put back, the run reports `22 skipped` and
`insert or update on table "invoices" violates foreign key constraint
"invoices_sale_fk"`; with the parent in place, 18 pass and the only four
failures are the sale section's canary.

The parent is written as a **draft** sale, which is the only sale shape a
fixture may write by hand:

* `sale_header_guard()` admits a draft that carries no `binding_source_id`, and
  refuses any status but `draft`/`confirmed` on insert;
* `sales_cogs_owed()` returns early for a draft, so it does not demand a
  bridged stock movement;
* `sales_walkin_no_ar()` returns early while `binding_source_id IS NULL`;
* no `sale_items` row is written, so the deferred `stock_source_complete_sale`
  has no subject to refuse.

A **confirmed** sale is the commit primitive's to write and nobody else's.
Hand-seeding one here would plant precisely the half-built commercial fact that
§4's law set exists to forbid, and it would do it inside the fixture of another
suite — the quietest possible place to put one.

The parent's id is local to `seedPhase4` and is deliberately **not** published
as `shop.saleId`: that field names a *committed* sale and only `sellable()`,
which goes through `confirmSale`, may set it.

### (b) The `P4-AL-88` equality in the Phase 2 engine-shapes golden

`tests/golden-regression/phase2/01-engine-shapes.golden.test.ts` asserted
`accounting_source_types` by exact equality against the **live** catalogue. That
made an accepted Phase 2 golden a claim about every phase that follows Phase 3:
`0077:1594-1596` registers `sale` and `invoice`, and the suite went red for a
reason that has nothing to do with the posting engine it judges. This is the
defect the estate keeps rediscovering, and it is
`[[daftar-a-closure-rule-is-not-an-invariant]]`.

It is **narrowed, not loosened**, in the two-step frozen-prefix form the
migration owner used for the signed-authority matrix
(`tests/security/phase3-s8-signed-authority-matrix.test.ts`):

1. the registry is read at the **accepted Phase 3 head** — a scratch database
   built `upTo: PHASE4_INHERITED_PREFIX_END`, read from
   `scripts/phase4-prefix.ts` (`0073_default_warehouse_locale_name.sql`) and
   never from a list of names, frozen byte for byte by P4-AL-85 so no later
   phase can enter it — and the original twelve-name equality stands there
   **word for word**, including its comments;
2. the later phases' types are claimed **separately and positively**: no type of
   the accepted head is counted as a later phase's, and no type that stood at
   the head was removed or renamed later;
3. and the close: **the two scopes together are the whole registry**, so a type
   belonging to neither cannot hide between them.

`accounting_source_types` carries **no `registered_by` column**, so the
`registered_by ~ '^P3-'` idiom used elsewhere is not available here; the frozen
prefix is the only scope that can carry the claim.

Three planted defects, each run and each red, because a golden that cannot be
made red proves nothing:

| planted | assertion that fired |
| --- | --- |
| `purchase_residue_write_off` struck from the expected list | `expected [ … (11) ] to deeply equal [ … (10) ]` — the head-scoped equality really reads the registry at `0073` and still claims all twelve |
| a type appended to the head reading that is not live | `no type that stood at the accepted Phase 3 head was removed or renamed later` |
| `sale` filtered out of `beyondHead` | `the two scopes together are the whole registry` |

The scratch build costs ~2s, measured, which is why it is affordable in a
golden that `npm run test:golden` runs over the whole tree.

### (b2) Three more `0077` breaks the same run found, in goldens 02, 03 and 04

A single run of `tests/golden-regression` is how these were found, and the
first round reported **7 of 17 files red**. Treating that as a floor and
re-running was the right discipline: the second round is **4 of 17**, and
every remaining failure is the `sale_commit` canary.

**Goldens 02 and 03 — the same FK, two more fixtures.** Both write `invoices`
rows directly and both passed a fresh `randomUUID()` as `sale_id`. In golden 02
that turned every cross-business probe into a pass for the WRONG REASON: the
DENY was refused by `invoices_sale_fk` rather than by
`invoices_customer_fk`/`invoices_branch_fk`, which is precisely the failure mode
an ALLOW/DENY pair exists to rule out, and the ALLOW stopped being a real
insert. In golden 03 a numbering suite's inserts died on a foreign key, and the
`23505` duplicate-ordinal case reported `23503` instead — measured, not
inferred.

Both now mint a real parent, and a **fresh one per invoice**, because
`invoices_sale_uq UNIQUE (business_id, sale_id, document_kind)` (`0075:288`)
admits one invoice of a kind per sale: a shared parent would have turned the
ALLOW into a `23505` and the probe into a vacuous pass. Golden 02's parent
carries the fixture's customer and settles on credit; golden 03's is a
**walk-in** — no `customer_id`, therefore no `customer_name_snapshot`
(`sales_customer_snapshot_ck`) and cash settlement
(`sales_credit_customer_ck`) — which matches the invoices that suite writes,
none of which names a customer either. Both needed a `warehouses` row, since
`sales.warehouse_id` is NOT NULL and composite-bound.

**Golden 04 — the seam is closed, so the exemption is removed.** LAW 2 reported
`invoices: the live catalogue carries the unreviewed constraint "f
invoices_sale_fk"`. That is the lint doing its job: the constraint is reviewed
here and recorded in `EXPECTED_CONSTRAINTS`.

LAW 5 is the more interesting half, and it did **not** go red — which is the
problem. `SEAM_ALLOWLIST` held `invoices.sale_id`, and
`polymorphicReferenceProblems` skips an allowlisted column **before** it looks
at whether the column is bound. So the stale exemption would have sheltered a
later migration that dropped `invoices_sale_fk`, and LAW 5 would have reported
nothing at all. The file's own header said closing the seam means removing the
entry, so the list is now **empty** and LAW 5 asserts the closure
**positively**: `invoices.sale_id` is bound by exactly one foreign key, it is
`invoices_sale_fk`, `convalidated` is true, and `pg_get_constraintdef` renders
the composite edge `FOREIGN KEY (business_id, sale_id) REFERENCES sales
(business_id, id)`. "The allowlist is empty" can therefore never be satisfied
by the seam quietly reopening.

Red proofs, each run:

| planted | assertion that fired |
| --- | --- |
| the orphan `sale_id` put back in golden 01's `seedPhase4` | `22 skipped` and `violates foreign key constraint "invoices_sale_fk"` |
| nothing — the pre-fix state of goldens 02 and 03 | 6 and 3 failures, including `expected '23503' to be '23505'` |
| nothing — the pre-fix state of golden 04 LAW 2 | `the live catalogue carries the unreviewed constraint "f invoices_sale_fk"` |
| `'invoices.sale_id'` put back in `SEAM_ALLOWLIST` | `expected [ 'invoices.sale_id' ] to deeply equal []` |

Measured after the fixes, whole golden tree, pristine cluster: **13 of 17 files
green, 138 passed, 35 failed, and every one of the 35 is a `requireSubject`
throw naming `the sale commit routine sale_commit`** — no failure of any other
kind. 27/27 green over `sale-s2-red-proofs` and `sale-s2-interleaving` in the
same round, which keeps `suiteProblems(REPO) == []`.

### (c) The `S2_SUITES` roster

See §9.

---

## 7d. `sales_cogs_owed` — the matched pair, and a contradiction it uncovered

`tests/integration/sale-s2-cogs-owed.test.ts`. Two halves.

### The live-catalogue half, provable today — and RED

The law has two arms and they are a matched pair: a committed sale whose
bridged movements carry a **non-zero** total value and no `sale` binding must
fail at COMMIT; a **zero**-valued one must commit, with one entry and no
binding. The zero arm is not decoration — three deliberate weakenings in this
slice rest on it and on nothing else:

1. `sales_binding_owed_ck` is deliberately weaker than C-01's strict
   `(status <> 'draft') = (binding_source_id IS NOT NULL)`;
2. the seam's `conditional` authority arm exists so a declared assertion's
   entry may legitimately not exist;
3. `sales_cogs_owed()` itself carries a `v_cost = 0` branch.

**All three are justified by a state nothing can reach.**
`stock_source_complete_sale()` and `stock_source_complete_sale_header()` each
require every line of a non-draft sale to carry exactly one bridged `sale`
movement with **`value_delta_base_minor < 0`**, strictly. A zero-valued sale
movement — which `0060:388-390` produces exactly, by valuing an emptying
outbound at the stored valuation — does not match, the guards' `v_ok` count
falls short, and the sale is refused
`inventory.source_movement_set_incomplete`. `inventory_sale_cost_base_minor`
negates a sum of strictly-negative numbers, so `v_cost = 0` is unreachable by
construction.

The two readings cannot both be right, and which is wrong is the migration
owner's call:

* **(a) the zero-cost sale is real** — the stock-side predicates are `<= 0`,
  and the law goes quiet; or
* **(b) the zero-cost sale is refused on purpose** — then the zero branch is
  dead, the seam's `conditional` arm has no case, and `sales_binding_owed_ck`
  should return to C-01's **strict iff**, which is a *stronger* law than the
  one in the tree.

The law is `zeroCostArmProblems`, a pure function of the three function
bodies read from `pg_get_functiondef` (the live catalogue is the policy; a
function a later migration replaces is the one that runs, and the file that
first created it is not). It is **red on this head, naming both guards**.

Non-vacuity is explicit and throws: each definition must be non-empty, the
`v_cost = 0` premise must really be in the tree (without it the law has no
premise and must stay quiet — otherwise it would force resolution (a) by
construction), and each stock-side guard must really compare the movement's
value with zero.

Four planted red proofs, each run and each red: `<` on the line guard; `<` on
the header guard alone (one arm is not enough); a guard that constrains the
value with nothing (reported, not passed); and the no-premise world (quiet,
whatever the predicates are). Recorded as `RP-S2-COGS-LINE`,
`RP-S2-COGS-HEADER`, `RP-S2-COGS-UNCONSTRAINED` and `RP-S2-COGS-PREMISE`.

### The behavioural half — canary-red until `0078`

The matched pair driven through the real command: the ZERO arm brings stock in
at a unit cost of 0 and asserts the sale **commits**, carries a cost of exactly
`'0'`, holds **no** `sale` binding, has **no** journal entry sourced on the sale
while the invoice's revenue entry **is** posted, and still satisfies
`GL Inventory (1200) = Σ stock_movements.value_delta_base_minor`. The NON-ZERO
arm asserts a priced sale's cost is neither `'0'` nor `NULL`, that
`binding_source_id` is the sale's own id (`sales_binding_identity_ck`), and that
the id names a real `accounting_source_bindings` row rather than a dangling one.
A third test reads the trigger from `pg_trigger` and asserts it is `DEFERRABLE`
and `INITIALLY DEFERRED` — not decoration: a non-deferred trigger would judge
the sale before the entry it is owed could exist and would refuse every sale.

**Why this half is not a fixture.** The only sanctioned producer of a committed
sale is `sale_commit`. `stock_movements` is append-only and reachable only
through `inventory_apply_stock_movements`, itself reachable only from a
registered entry routine, and a confirmed sale additionally owes
`stock_source_complete_sale`, `stock_source_complete_sale_header`,
`sales_binding_fk`, `sales_walkin_no_ar` and `stock_binding_requires_sale`.
Hand-building it would mean reimplementing `sale_commit` in a test, and a law
proved against a reimplementation is a law about the reimplementation. So the
pair is canary-gated on `sale_commit` and goes green the day `0078` lands —
**except that the ZERO arm cannot go green at all until the contradiction above
is resolved**, which is what makes the two halves one finding rather than two.

---

## 7e. The round after `0078`: the measured green pass, and six corrections

All numbers below are measured on a cluster built from scratch, with both
`PG_PORT=5444` and `PG_DIR` set and `PG_DIR` deleted first. `PG_PORT` alone
collides on the default shared data directory, and a stale `PG_DIR` after an
amended migration reports "Migration tampered after apply (checksum mismatch)",
which is an old copy of the database and not a defect.

### The one defect that masks everything else

**Every priced sale in the estate is refused `403 FORBIDDEN / Access denied`,
and the cause is `selling.sale_cogs_owed`.** `error.filter.ts:112-115` maps any
`P0001` to an opaque 403, so the database's named refusal never reaches the
client. The suites see 403 and say "the sale was refused"; the log says
`selling.sale_cogs_owed`.

The discriminator is the COST, and it is exact: `sale-s2-cogs-owed`'s ZERO ARM
(stock in at a unit cost of 0) **commits and passes**, while its NON-ZERO ARM
(unit cost 5) is refused. A zero-cost sale sets no binding, so the deferred
trigger's INSERT-event `NEW.binding_source_id` is NULL and its cost is 0 and it
returns early; a priced sale has its binding set by a later UPDATE in the same
transaction, and the INSERT event's `NEW` still carries NULL — the defect the
migration owner is amending. Nothing was worked around.

Measured, shipped state (`387f4e5`), over
`tests/golden-regression/phase4-s2`, `tests/golden-regression/phase4`,
`sale-s2-interleaving`, `sale-s2-atomic-law`, `sale-s2-cogs-owed` and
`sale-s2-red-proofs`: **123 passed, 16 failed, 17 skipped**. Every one of the 16
traces to that 403; the 17 skipped are `sale-s2-atomic-law`, whose `beforeAll`
needs one accepted sale to discover the seam set. The only other named refusal
in the whole log is `inventory.insufficient_stock`, twice — which is golden 06's
losing attempt being refused correctly.

With `sales_cogs_owed` dropped from the cluster by hand, which simulates the
amendment and is **not** the shipped state: **155 passed, 1 failed**, and the
one failure is `sale-s2-cogs-owed`'s own check that the trigger is installed and
`INITIALLY DEFERRED` — that is the check doing its job. That is the green pass,
and it is the number to expect once the amendment lands.

### E-01 — `invoice_sequences`, now a held row lock rather than a trigger

My own §E-01 note was the fix. P4-AL-31 forbids a stored counter, so
`sale_commit` takes the series row `FOR UPDATE`, reads `max(number_seq) + 1`
and never UPDATEs it; a `BEFORE UPDATE` trigger there never fires, the
injection observed nothing, the sale succeeded, and the case asserted a refusal
it then failed to get. `invoice_sequences` therefore left `TRIGGER_SEAMS`
(a new, derived list) while staying in the discovered set, and it has a case of
its own: the series row is parked on a connection of its own via the harness's
new `parkRow`, the sale is launched once and **observed into the lock queue
through `pg_blocking_pids`** before anything is asserted, and
`waitUntilQueued` throws if the sale ever settles without parking. **No sleep
anywhere.** While it is held the case asserts the census delta is `{}` — a sale
stopped at that seam has committed nothing, whatever it has already written —
and re-checks `blockedBehind` afterwards to prove the census was taken mid-sale.
Released, the sale serialises and commits.

Two planted red proofs, each run and each red:

| planted | what fired |
| --- | --- |
| the park's predicate changed to an absent `document_kind` | `the invoice series row of this business — a park on an absent row holds no lock and forces no interleaving` |
| the park released before the sale is launched | `attempt 1 finished without ever waiting on the parked lock, so this was not a race` |

`parkRow` is the generalisation of `parkStockKey`, which now delegates to it
with a `what` that keeps its message byte-identical, so the stock park's
existing red proof still covers both.

### `stock_source_bindings` now has an injection case

It was a discovered written seam with no case — the generic source binding the
ledger carries for every source document and the parent
`stock_source_bridge_sale` hangs from. Adding it to `P4_AL_16_FLOOR` gives it a
generated raising-trigger case. Planted red proof, run: with the name removed
from the floor, `every discovered seam was covered` reports
`the sale writes stock_source_bindings, and no case above injects a failure
there`.

### L4 was WRONG, not merely strict

L4 required every COGS entry to carry `source_type = 'sale'`. Measured on the
`0078` head it reported two violations over **lawful** state: this suite's own
inbound fixture lots post `inventory_adjustment` COGS entries, and an inventory
adjustment is a commercial source. §15 forbids "a COGS entry but no commercial
source" and says nothing about the source being a sale. A law that is red over
state the estate is required to allow is not strict, it is wrong — and the
tempting repair was to scope the query, which is how a law quietly becomes a
weaker law.

Re-expressed at §15's own grain and no looser: a COGS entry with no source
identity is a violation; one with no `accounting_source_bindings` row binding it
to the source it names is a violation; and one naming a `sale` that does not
exist is a violation. A second planted world covers the new clause — a COGS
entry whose binding row is missing — beside the existing one.

### The "two formulas disagree" premise was unachievable

Golden 07 asserted the official identity and the forbidden reconstruction
DISAGREE over its fixture. Measured: `official=20 forbidden=20`. The premise is
not unlucky, it is impossible. The writer stores
`valuation = T − round(q·avg)` (`0060:388-393` values an outbound at
`half_even(|q|·avg)`), so the reconstruction is `round(T − q·avg)`, and for
integer `T` and HALF_EVEN, `round(T − x) = T − round(x)` for every `x` — the
exact halves included, because the two ties break in opposite directions when
the integer parts differ by an integer. The formulas are algebraically equal at
one key whatever the lots are, and summing over keys cannot separate them
because each key is individually equal. The only remaining gap is
`avg_unit_cost_base_minor` being a rounded quotient at `NUMERIC(28,10)`
(`0059:106`), which needs an `on_hand` above 5e9 to move one minor unit.

A premise that cannot hold gets "fixed" by nudging the fixture until it passes,
so the law is now stated where it lives: the numeric half asserts the official
identity over a non-zero position, and the structural half reads
`glInventoryBaseMinor` and `ledgerValueBaseMinor` from disk, **strips comments
and keeps string literals**, and asserts the ledger side names
`value_delta_base_minor` and that neither side names
`avg_unit_cost_base_minor`, `average_cost`, `on_hand` or `stock_levels`.
Comments must go because the prose above each function names the forbidden
formula in order to forbid it; strings must stay because the SQL is a template
literal — the same trap as the harness's own `deadlock_timeout` check, which
first failed on its own message.

### Two more of my own bugs the live sale path exposed

1. **`ok.body.id` was `undefined`.** The sale DTO names the document `saleId`
   (`sale-reads.ts:302` maps `row.id` to `saleId`). An assertion comparing
   `undefined` with the id would have been satisfied by any read returning
   nothing under a different field name.
2. **`array_agg(a.attname)` came back as a STRING.** node-postgres has no
   parser for `name[]` and hands back the raw array literal, so
   `cols.includes('business_id')` was a substring test that happened to agree
   and `cols.join` threw — which is how golden 08's real assertion came to be
   hidden behind a `TypeError` in its own failure message. Cast to `text[]`.

### `daftar_app` cannot read `stock_source_bridge_sale`, and the probe now says so

Golden 01's SQL section looped the three sale relations under `daftar_app` and
got `permission denied for table stock_source_bridge_sale` — `0077:484-485`
grants the bridge to `daftar_inventory_internal` only. The loop treated that as
a suite error rather than as the answer. The surface is now **partitioned by
what the catalogue grants**, discovered with `has_table_privilege` and never
listed: a relation `daftar_app` may read is proved by its ROW SECURITY, and one
it may not is proved by the PRIVILEGE BEING ABSENT — the stronger of the two,
because an ungranted relation needs no policy to be unreachable. The partition
is asserted to cover the three relations exactly once, and the readable side is
asserted non-empty, so neither half can become vacuous.

### Item 3 of the brief: the six shared-harness cases

`02-cross-business-fk.golden.test.ts` and `phase4-composite-seam-guard.test.ts`
are **green**, measured twice: alone (26/26) and inside a run of the whole guard
estate plus both Phase 4 golden directories. The shared harness defect was
fixed by the head commit itself — `387f4e5`, "the deficit fixture's TRUNCATE is
a discovered FK closure, not a list". Nothing was scoped, relaxed or wrapped in
`arrayContaining`; there was nothing left to fix.

---

## 7f. After the `0077` amendment: the green pass, measured — and two reports the measurement contradicts

Merged head `4b7995c`. Pristine cluster each round, `PG_PORT=5444` and
`PG_DIR=/tmp/daftar-pg-d-golden-5444` both set and `PG_DIR` deleted first. No
file in the tree was edited while a run was reading it.

### The green pass

| round | what was run | result |
| --- | --- | --- |
| A | the eight P4-S2 suites plus both Phase 4 golden directories (12 files) | **156 / 156** |
| B | fresh cluster: the WHOLE golden tree plus the WHOLE guard estate plus the three `sale-s2-*` integration suites (32 files) | **376 / 376** |
| C | fresh cluster: `stock-ledger-concurrency`, `inventory-s3-atomicity` and the P4-S2 suites together (9 files) | **105 / 105** |
| D | round A again, with §7f's new law in place | **157 / 157** |

Three rounds found nothing new, which is the bar: a count from one run is a
FLOOR because a failing assertion aborts its body. The `selling.sale_cogs_owed`
403 that masked sixteen failures last round is gone — the amendment re-reads
`sales` by `(business_id, id)` instead of trusting a deferred trigger's `NEW` —
and the 155/1 figure I previously had to obtain by dropping the trigger by hand
is now 156/156 against the shipped tree.

### Report 1: the `invoice_sequences` trigger case — NOT PRESENT

There is no trigger-based `invoice_sequences` case in the file and has not been
since `ff66910`. A verbose run lists seventeen cases and the only
`invoice_sequences` one is
`a sale held at the invoice_sequences seam has committed NOTHING, and
serialises once the row is released`, which passes. `TRIGGER_SEAMS` is
`[...P4_AL_16_FLOOR, 'stock_levels']` and the generated loop iterates that, not
`UPDATE_SEAMS`.

The reported symptom is reproducible, and reproducing it identifies the tree it
came from: adding `'invoice_sequences'` back to `TRIGGER_SEAMS` produces
**exactly** the reported text —
`the invoice_sequences seam: the injected failure surfaces as a refusal rather
than a success: expected false to be true`. That is the pre-`ff66910` shape.

### Report 2: `stock_source_bindings` with no case — NOT PRESENT

`a failure at the stock_source_bindings seam leaves nothing` runs and passes,
and `every discovered seam was covered by a case above` passes. The relation is
in `P4_AL_16_FLOOR`, and `covered` is built from that same list, so adding it to
the floor put it in both the generated cases and the covered set. Removing it
again reproduces the reported text:
`the sale writes stock_source_bindings, and no case above injects a failure
there`.

### What DID change: the premise of E-01 is now a law

Twice reported, twice the same answer — a row trigger cannot observe a row lock.
So the premise stops being a comment. A new case states it in both directions
and refuses the regression at the LIST level, with the reason, instead of as an
obscure `expected false to be true` inside a generated case:

* `invoice_sequences` **is** in `UPDATE_SEAMS` and **is not** in
  `TRIGGER_SEAMS`;
* `sale_commit`'s body, read from the live catalogue through **`lexBody`** — the
  repo's own recogniser, which strips `--` and block comments and replaces every
  single-quoted literal with a placeholder — mentions `invoice_sequences`, does
  **not** `UPDATE` it (P4-AL-31: the ordinal is not a stored counter), and does
  take a row lock (`FOR NO KEY UPDATE`), so two sales on one series still
  serialise;
* and the recognisers are PLANTED, because `.toBe(false)` over a regex that
  matches nothing is the quietest vacuous pass there is: the `UPDATE` pattern is
  proved to see a real write, and proved NOT to see one written in a `RAISE`
  message or in a comment — which is the whole reason the body is lexed rather
  than grepped.

Red proof, run: with `'invoice_sequences'` planted back into `TRIGGER_SEAMS`,
**two** cases fail — the new law naming the reason, and the generated case that
cannot fire. The law is the one that says why.

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
4. **CLOSED by §7c(a).** *(Was: a latent break in golden 01's own fixture, for
   the migration owner.)*
   `seedPhase4` inserts an `invoices` row whose `sale_id` is a fresh
   `randomUUID()` with no `sales` row behind it — it could not be otherwise,
   because the suite predates `sales`. If `0077` adds a composite foreign key
   from `invoices (business_id, sale_id)` to `sales`, that fixture stops
   inserting and golden 01 goes red in its `beforeAll`. It is not fixable from
   the test side before the table exists; the migration owner should say
   whether the FK lands, and if it does the fixture needs a `sales` parent row
   inserted first.
5. **`tests/helpers/` was not edited.** Everything shared lives under
   `tests/golden-regression/phase4-s2/` and is imported from there by the
   integration and guard suites, following the precedent of
   `tests/guards/phase4-composite-seam-guard.test.ts:30`.

---

## 9. The `S2_SUITES` roster for `scripts/phase4-s2-gate.ts` — ACCEPTED

The gate file is not mine to edit. This is the roster as its owner accepted it,
with the `it(` title each row's verdict should be named by. Every path exists on
this branch, every one is run by the commands in §0, and all eight are **green**
on the merged head (§7f: 156/156 over these eight plus both Phase 4 golden
directories, 157/157 with §7f's own law in, over three rounds that found nothing
new).

| row | suite | the claim it carries | the `it(` title the gate names as its red proof |
| --- | --- | --- | --- |
| `S2-G05` | `tests/golden-regression/phase4-s2/05-last-item-race.golden.test.ts` | the last-item race on the stock writer the sale must use; no oversell; the deterministic lock-order probe | `the lock order is the KEY order and not the payload order — the deterministic lock-order probe` |
| `S2-G06` | `tests/golden-regression/phase4-s2/06-sale-last-item-race.golden.test.ts` | the same race through `POST /v1/sales`: one commit, one stable business refusal, no orphan of any kind | `exactly one attempt is refused, and the refusal is a stable business refusal naming the stock` |
| `S2-G07` | `tests/golden-regression/phase4-s2/07-atomic-sale-law.golden.test.ts` | §15 as eight laws over committed state, the official reconciliation identity, and the structural ban on the forbidden reconstruction | `the identity is never reconstructed from quantity × average cost` |
| `S2-G08` | `tests/golden-regression/phase4-s2/08-sale-idempotency.golden.test.ts` | the replay contract, structural and behavioural (P4-AL-30: the stored intent is read before any write) | `the same document id with a DIFFERENT intent is refused, and writes nothing` |
| `S2-I01` | `tests/integration/sale-s2-interleaving.test.ts` | that the forcing MECHANISM works: the `blockedBehind` fixed point, every throw of `waitUntilQueued`, a planted real `40P01` classified and refused, no retry anywhere | `a real deadlock is classified as a deadlock, and expectNoDeadlock fails on it` |
| `S2-I02` | `tests/integration/sale-s2-atomic-law.test.ts` | failure injection at every discovered seam — `stock_source_bindings` included — plus the E-01 held-lock case and its premise | `invoice_sequences is LOCKED and never written, so it belongs to the held-lock case and not to the trigger set` |
| `S2-C01` | `tests/integration/sale-s2-cogs-owed.test.ts` | C-07's matched pair: the live-catalogue agreement law and the behavioural ZERO / NON-ZERO arms | `PLANTED: a strictly-negative predicate on the LINE guard is reported` |
| `S2-R01` | `tests/guards/sale-s2-red-proofs.test.ts` | that every law on the books has a planted defect, the canary fails in both directions, the runner's exit status can say no, and `suiteProblems(REPO) == []` | `the runner’s exit status can say no` |

Three notes for whoever wires them.

1. **Do not read the verdict through a pipe.** Piping `vitest` or `tsc` into
   `grep` or `tail` replaces the exit status with the pipeline's. This was
   observed twice during this work, and the estate has already shipped a runner
   that exited 0 over four failing tests. `rlsSuiteProblems` in the gate today
   does it correctly, with `spawnSync` and `stdio: 'pipe'`.
2. **`S2-I02` names the PREMISE, not the held-lock case.** Planting the
   regression — `invoice_sequences` back in `TRIGGER_SEAMS` — fails the premise
   law *and* the generated case that cannot fire, and the premise is the one
   that says why. The held-lock case
   (`a sale held at the invoice_sequences seam has committed NOTHING, and
   serialises once the row is released`) carries the behaviour and has its own
   two planted proofs (§7e); it is not the row's named verdict.
3. **`tests/guards/` by directory** would also pick up
   `sale-s2-base-split-agreement.test.ts`, which is another owner's; the row
   above names the one file instead, so each owner's guard is listed by its
   owner.
