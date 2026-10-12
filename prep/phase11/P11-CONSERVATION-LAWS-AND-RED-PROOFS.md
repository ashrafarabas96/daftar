# P11 — CONSERVATION LAWS AND THEIR RED PROOFS

**status** `PREPARED / NOT PROMOTED`. **revised 2026-10-12 (V2 of the Master Continuous Mission, after execution)**: `C-APP-01` is now `PROVEN BY TEST` at `d813de2` and a new law **`C-APP-02`** carries apparel's concurrency estate, which this document previously denied existed — V2 refused *"apparel has no concurrency to prove"* with **"no locks, therefore no concurrency" is not a proof**, and the three races it required found two real defects. Two gate arms are new (`race-estate`, `unlocked-closure-read`). **Everything outside `C-APP-01`/`C-APP-02` remains `SPEC ONLY` or `UNMEASURED`.** **revised again 2026-10-12** on the Master Continuous Mission: §18 confirms every law here and adds one case — **a retried billing attempt returns the same original binding** rather than merely being refused — and it **authorizes and requires executing this plan's DDL, unnumbered, on a scratch cluster**, which is what turns the laws below from `SPEC ONLY` into something a run can red. **revised 2026-10-12** on the per-phase directive: §0a now states **every red proof's mutation target** (PART 6's corrective law — a proof that needs frozen history modified is wrongly designed), `C-REP-03` carries PART 67's one-time full-quantity rule and the two added binding conditions, and two laws are new — `C-REP-04` (no repair money balance, PART 69) and `C-WAR-01` (append-only warranty lifecycle, PART 70). **revised 2026-10-08** under `TL-P11-R1` … `TL-P11-R7`: L-P11-02 now names the snapshot case (§55) and a new law **C-REP-03** carries the double-consumption correction (§60, `TL-P11-R7`). **No verdict in this document mixes two evidence classes in one sentence (§82).** `C-APP-01` and `C-APP-02` are `PROVEN BY TEST` on a scratch cluster, which is **not CI**; every other law here is `SPEC ONLY` or `UNMEASURED`, because its subject does not exist yet. This is the proof *plan*, written before the implementation so the implementation cannot choose its own bar. No timing or performance claim appears anywhere in it.

---

## 0. Why this document exists before the code

Phase 11 adds two surfaces that *could* disagree with the inventory truth — a per-lot quantity and a per-serial custody count. A surface that can drift and is guarded by convention will drift. So each law below is carried by a **deferred COMMIT trigger or a foldable cache**, not by a code review, and each has a **named red proof**: a minimal mutation that must turn exactly that law red, naming exactly that refusal.

Five rules this project paid for, and which this plan obeys:

1. **A suite that cannot compile reports nothing.** A string literal broken across two lines once made 92 proofs unrunnable while the roster still reported `cases=92`; a textual case count cannot detect it, only a parser can. The Phase 11 gate parses every rostered file.
2. **A non-empty list names no law.** `expect(mutated).not.toEqual([])` proves something refused, never *which* thing refused. Every red proof below asserts the **specific refusal string**.
3. **Prove the mutation landed.** A `sed` that matches no line goes green and records a missing law as fine. Every mutation is diff-checked *before* its run is read.
4. **A comment citing a check is evidence of nothing.** Three times in one day a comment named a check that did not exist. No law below is satisfied by a comment.
5. **A green vitest suite is not a typecheck**, and a skipped step is `UNMEASURED`, never green. The gate runs format, lint and typecheck as their own named steps, in the exact form they were run.

Evidence classes are never mixed in one sentence: `PROVEN IN LIVE CODE` / `PROVEN BY TEST` / `PROVEN BY DATABASE CATALOGUE` / `DESIGN ONLY` / `SPEC ONLY` / `UNMEASURED` / `BLOCKED` / `WAITING_FOR_INTEGRATED_SURFACE` / `INTEGRATION_PENDING`.

---

## 0a. Where every mutation lands (PART 6)

The frozen-migration law is now explicit that a red proof **must never mutate a frozen migration, even temporarily**, and that **a proof requiring frozen-history modification is wrongly designed.** This project has already paid for that once: in Phase 5 a mutation harness wrote a planted defect into the real tree and only a landing check caught it, and a second harness left a frozen migration dirty while printing "tree clean" because its clean-check was narrower than its mutations.

So the mutation target of every proof below is named here, before any of them is written. Admissible targets are exactly four: a **scratch copy of Phase 11's own DDL or source text**, a **synthetic fixture**, a **temporary generated tree**, a **throwaway non-canonical clone**. `0000`–`0079` stay byte-identical on disk in this working tree; `0080`–`0086` are Phase 4's live candidates and are not mutated either.

| proof | what is mutated | where it lives |
|---|---|---|
| `R-L02` | a column added to Phase 11's own DDL text | scratch copy of the Phase 11 DDL |
| `R-SER-01` … `R-SER-03` | rows, inside a transaction | scratch cluster (data, not files) |
| `R-SER-04` | the `FOR UPDATE` on `stock_serials` — which is in **Phase 11's `CREATE OR REPLACE` body** (patch request §4), not in the frozen definition | scratch copy of the Phase 11 DDL, applied over an **unmodified** frozen prefix |
| `R-LOT-01` … `R-LOT-03` | rows and cache values | scratch cluster |
| `R-LOT-04` | the outbound pricing expression — again **Phase 11's replacement body**, never the frozen original | scratch copy of the Phase 11 DDL, over an unmodified frozen prefix |
| `R-FEFO-01` | `inventory_pick_lots`, a Phase 11 routine | scratch copy of the Phase 11 DDL |
| `R-REP-01` | a source-type registration attempt | scratch cluster |
| `R-REP-02`, `R-REP-03` | Phase 11 TypeScript modules and zod schemas | scratch copy of the Phase 11 source |
| `R-REP-04` | a Phase 11 relation definition | scratch copy of the Phase 11 DDL |
| `R-WAR-01` | the warranty triggers and chain, Phase 11's own | scratch copy of the Phase 11 DDL |
| `R-APP-01` | the canonicalization trigger, Phase 11's own | scratch copy of the Phase 11 DDL |
| `R-APP-02` | the validator's `FOR KEY SHARE`, the axis-in-use guard, the immutability condition — all Phase 11's own | scratch copy of the Phase 11 DDL, over an **unmodified** frozen prefix |

**The two that needed checking were `R-SER-04` and `R-LOT-04`**, because both mutate the behaviour of `inventory_apply_stock_movements`, whose current definition is in a frozen migration. They are admissible — the writer is re-created by Phase 11's own `CREATE OR REPLACE`, and that text is what the mutation edits — but they were admissible by accident until this section said so. The scratch cluster is built in two steps and the order is the proof: apply the frozen prefix **unmodified**, then apply the **mutated** Phase 11 DDL.

**And the harness check, learned the hard way:** the clean-check must be at least as wide as the mutations. Every proof run ends with a digest comparison over the **whole accepted prefix** plus `git status --porcelain` over the **whole tree**, not over the directory the harness happened to touch, and the gate's `frozen-prefix` arm runs **after** the suites rather than before them.

---

## 1. The laws

### L-P11-02 — no Phase 11 relation carries money
**Statement.** No relation created by Phase 11 has a column matching `value_%_minor`, `valuation%`, `unit_cost%` or `avg_%`, and no Phase 11 TypeScript module computes a monetary value from a lot or a serial. **A column labelled "report-only" or "non-authoritative" is not an exception** — `TL-P11-R2` and §55 refused exactly that proposal on serial rows, because non-authoritativeness is a hope about readers, not a property of a column. Acquisition cost is reached by **joining** through the movement the overlay already names.
**How it is checked.** Two independent ways, deliberately: (a) the migration's end-state assertion queries `pg_attribute` for the relations it created — `PROVEN BY DATABASE CATALOGUE`; (b) a gate arm parses the Phase 11 DDL text and the Phase 11 source tree. The text arm strips comments and string literals with the existing `stripCommentsKeepStrings`, **not a new lexer** — and the blanker itself gets a fixture test including a regex literal, because a blanker with no regex-literal handling once inverted quote parity for the rest of a file and made nine laws answer "no subject found" instead of "defect found".
**Red proof R-L02.** Two mutations. (a) Add `value_delta_base_minor BIGINT` to the lot overlay in a scratch copy; (b) add `unit_cost_base_minor NUMERIC(28,10)` to `stock_serials` **with a comment saying it is report-only** — the second is the one the first draft actually proposed, so it is the one the arm must catch, and a comment must not exempt it. In both cases the catalogue arm must raise `inventory.migration_end_state_invalid` naming that column, and the text arm must name the file and the column. Diff-checked first.

### C-SER-01 — serial custody equals on-hand
**Statement.** For every serial-tracked `(business_id, warehouse_id, variant_id)`: `count(stock_serials WHERE custody_state='in_stock' AND warehouse_id = w) = stock_levels.on_hand`, and `on_hand` is an integer.
**How it is checked.** Deferred constraint trigger at COMMIT, refusing `inventory.serial_custody_conservation_violated`; plus an executed reconciliation over a built fixture world.
**Red proof R-SER-01.** Delete one `stock_serial_events` row inside the transaction (as the internal owner, in a scratch cluster) and require that exact refusal at COMMIT. A variant: make `on_hand` fractional for a serial-tracked variant and require `inventory.serial_quantity_not_countable`.
**The trap.** The guard must derive its subject from the **movement's own `qty_delta`**, never from a visibility-dependent `count(*)` that would read `0` both when nothing exists and when RLS hides everything. A `SECURITY DEFINER` reads as its owner through one policy, so "absent" and "invisible" are one answer.

### C-SER-02 — the custody chain is append-only and alternating
**Statement.** `event_seq` is gap-free and monotonic from 1; directions alternate starting at `in`; `custody_state` and `warehouse_id` equal the chain's last event; a serial is `in_stock` in at most one warehouse.
**How it is checked.** Append-only trigger (UPDATE and DELETE refused) plus a deferred chain trigger. The one-warehouse part is structural: `CHECK ((custody_state='in_stock') = (warehouse_id IS NOT NULL))` with a single `warehouse_id` column, so two warehouses are unrepresentable rather than merely forbidden.
**Red proof R-SER-02.** Four mutations, four distinct refusals named: a gap in `event_seq`; two consecutive `out` events; a `custody_state` that disagrees with the last event; an attempted `UPDATE` of an existing event.

### C-SER-03 — every movement line of a serial-tracked variant carries exactly `abs(qty_delta)` events
**Statement.** As stated; direction matches the movement's sign; a non-tracked variant carries none.
**How it is checked.** Deferred constraint trigger, four refusals (`serial_assignment_missing`, `_count_mismatch`, `_direction_invalid`, `_forbidden`).
**Red proof R-SER-03.** For each of the four, one mutation naming that refusal. **And one more, which is the proof that matters:** a path that writes a movement for a serial-tracked variant with **zero** events must be shown to red. If any path can satisfy this trigger with zero events, the overlay drifts from on-hand silently and for ever — so the red proof enumerates the writer's own branches rather than one happy path, and the gate reds if a new writer branch appears without a case.
**This is the first law a challenger should attack.**

### C-SER-04 — a serial cannot be sold twice
**Statement.** Two concurrent commands consuming the same serial: exactly one commits; the other is refused `inventory.serial_not_available`.
**How it is checked.** Real PostgreSQL, two connections, a transaction barrier, the serial row locked `FOR UPDATE` inside the writer. **Never `sleep()`, never a JS object simulation.** The lock order is stated and tested: existing stock targets first (`inventory_lock_stock_targets`), then lots by `lot_id` ascending, then serials by `stock_serials.id` ascending — a suffix on the global order, never an interleave, and the deadlock test runs both orders.
**Red proof R-SER-04.** Remove the `FOR UPDATE`; both transactions must then commit and the test must fail naming the double sale. (Removing a lock is the mutation; the proof is that the *absence* of the lock is detected, not that the lock exists in the text.)

### C-LOT-01 — lot deltas sum to the movement delta
**Statement.** `Σ stock_lot_movements.qty_delta = stock_movements.qty_delta` for every movement of a lot-tracked variant; signs agree; a non-tracked variant carries no overlay rows.
**How it is checked.** Deferred constraint trigger, four refusals; it must survive `SET CONSTRAINTS ALL IMMEDIATE` (the Phase 3 R-94 finding: a guard that fails open under `IMMEDIATE` is not a guard).
**Red proof R-LOT-01.** Four mutations naming four refusals, plus one that runs the whole thing under `SET CONSTRAINTS ALL IMMEDIATE` and requires the same refusals.

### C-LOT-02 — per-lot on-hand never negative
**Statement.** A consumption exceeding a lot's on-hand is refused `inventory.lot_insufficient_stock` under that lot level row's lock, with no partial write.
**Red proof R-LOT-02.** Over-consume one lot while another lot of the same variant holds plenty: the refusal must be the per-lot one, **not** the variant-level `inventory.insufficient_stock` — a distinction that a test asserting merely "it threw" would miss entirely.

### C-LOT-03 — per-lot on-hand sums to the key's on-hand
**Statement.** `Σ stock_lot_levels.on_hand = stock_levels.on_hand` for every lot-tracked key, and the per-lot cache equals its fold from `stock_lot_movements`.
**How it is checked.** Deferred trigger plus `inventory_lot_verify` (locks `FOR SHARE`, compares cache to fold) run over a built world, exactly as `inventory_stock_verify` does for the core cache.
**Red proof R-LOT-03.** Two mutations: perturb the per-lot cache directly as the internal owner (the sum trigger must red); and drop one overlay row (the fold comparison must red naming the lot). **This is the second law a challenger should attack** — a per-lot cache that can disagree with `stock_levels` is a second quantity truth wearing a cache's clothes.

### C-LOT-04 — the lot overlay is value-neutral (the law that makes the whole shape safe)
**Statement.** Consuming the same quantity of the same variant from lot A and from lot B produces the **identical** `value_delta_base_minor`, and the key's `valuation_base_minor` and `avg_unit_cost_base_minor` follow the pre-Phase-11 arithmetic exactly.
**How it is checked.** Executed on a live cluster: build one variant with two lots received at *different* unit costs, consume from each in two separate worlds, and compare the written values **against the values the pre-Phase-11 writer produces for the same movements** — an independent oracle, not the new code compared to itself.
**Red proof R-LOT-04.** Make the writer price the outbound from the lot's own receipt cost instead of the key's average; the comparison must red, naming both values. If this proof cannot be made to red, the overlay is not value-neutral and `ADJ-P11-01` has been answered by accident.

### C-FEFO-01 — the picker is a function, and refuses rather than guessing
**Statement.** `inventory_pick_lots(key, qty, as_of, policy)` is deterministic, reads no machine clock, orders by `(expiry_date NULLS LAST, received_seq, lot_id)` for FEFO and `(received_seq, lot_id)` for FIFO, and refuses `inventory.lot_selection_insufficient` with no partial pick.
**How it is checked.** Determinism is proved by repeated calls across differing plans (and with the rows physically reordered), not by reading the `ORDER BY`. Clock-freedom is proved by calling with two different `as_of` values and requiring two different answers, plus a parser arm that reds on `now()`, `current_date` or `clock_timestamp()` inside the routine body.
**Red proof R-FEFO-01.** Three: remove the `lot_id` tiebreak (two lots sharing an expiry and a `received_seq` must then be shown non-deterministic); replace `as_of` with `current_date` (the two-`as_of` case must red); return a partial pick (the refusal case must red). **Watch the tiebreak proof:** two rows that *happen* to come back in the same order prove nothing, so the fixture forces a physical reorder.

### C-REP-01 — a customer's device is never stock
**Statement.** No `stock_source_types` row names a repair intake; no `stock_movements` row exists for an intake; no Phase 11 relation holds a value for a customer-owned device.
**How it is checked.** Absence, proved three ways because absence is the easiest thing to "prove" vacuously: the migration end-state assertion over `stock_source_types`; a gate arm over the Phase 11 DDL text; and an executed attempt — register an intake source type in a scratch cluster and require the end-state assertion to raise.
**Red proof R-REP-01.** The executed attempt *is* the red proof, and it is the only form that counts here: an arm that merely greps for a string it wrote itself proves nothing.

### C-REP-02 — a repair part is consumed once, through the inventory authority
**Statement.** Consuming parts for a ticket writes exactly one `stock_movements` row per part line under the five-part identity, through `inventory_apply_stock_movements` and no other path, and its COGS posts through the existing accounting bridge with no Phase 11 journal logic.
**How it is checked.** Replay the same command twice: the second is idempotent (`replayed: true`) and writes no second movement — the existing `stock_movements_identity_uq` is what makes this structural. A source-tree arm asserts **zero** Phase 11 writes to `stock_movements`, `stock_levels`, `journal_entries` or any accounting relation.
**Red proof R-REP-02.** Add a direct `INSERT INTO stock_movements` to a Phase 11 module in a scratch copy; the arm must name that file and line.

### C-REP-03 — billing a repair part moves no stock and posts no second COGS
**The law the first draft needed and did not have (§60, `TL-P11-R7`); extended 2026-10-12 on PART 67.** Billing a consumed part through a preconsumed sale-line binding produces **zero** additional `stock_movements` rows and **zero** additional COGS postings; a binding cannot exist without the consumption it names; and **one consumption is billed at most once, for its full consumed quantity** — partial split billing of one consumption row is unrepresentable in v1, not merely refused.
**How it is checked.** Four executed cases on a live cluster, each counting rows **before and after** rather than inspecting code: bill a consumed part and require the movement count and the COGS posting count for that variant to be unchanged; attempt a **second** binding for the same consumption and require the primary key to refuse it; attempt a binding whose qty differs from the consumption and require `repair.billing_qty_mismatch`; attempt a binding **before** any consumption exists and require `repair.billing_without_consumption`.
**A fifth case, added on the Master Continuous Mission's §18:** a **retry** of the same billing attempt must **return the same original binding**, idempotently — not a refusal. This is a different property from condition 6, and the difference is the one that bites in production: a client that retries after a timeout must not be told its work failed when it succeeded. The case counts rows before and after the retry (unchanged), asserts the returned binding id is **the same row**, and asserts no second movement and no second COGS — and the red proof is the implementation that satisfies condition 6 by raising on the primary key without catching it, which is exactly how a correct uniqueness constraint produces an incorrect client contract.
**Three more cases, added on PART 67**, each for a condition the first eight did not carry: a binding whose ticket is **not** the ticket the consumption belongs to must be refused (`repair.billing_ticket_mismatch`) — and the fixture needs **two tickets**, because one ticket cannot fail this way; a binding whose **customer / custody context** differs from the consumption's must be refused (`repair.billing_custody_context_mismatch`), with a fixture carrying **two customers**, which is the case a single-customer fixture is structurally blind to; and a **partial** claim — `billed_qty` less than the consumption's `qty` — must be refused by the same `repair.billing_qty_mismatch`, with the structural half proved separately: the relation has **no quantity-claimed column** and is keyed one row per consumption, so a partial claim has nowhere to live. The structural half is the one that matters, because a refusal can be forgotten on a path while an absent column cannot.
**Red proof R-REP-03.** Put the part on an ordinary sale line instead of a binding — the exact defect of the first draft — and require the movement-count case to red naming **two** movements where one was expected. A test that merely asserts "the invoice was created" passes through this defect without noticing, which is how the draft got as far as it did.
**And the arm that matters most:** the request schema must have **no property** by which a client could supply a binding (conditions 1 and 2 of `P11-AL-21`). The proof is not that a supplied value is refused but that it is **unrepresentable**: add the property to the zod schema in a scratch copy and require a gate arm to name it. A refusal can be forgotten on one path; an absent field cannot.
**This is now the third law a challenger should attack**, alongside C-SER-03 and C-LOT-03 — and unlike those two, its failure mode is free inventory rather than a drifting count.

### C-REP-04 — no Phase 11 relation holds a customer money balance
**New, on PART 69.** A repair deposit is **canonical Phase 4 money** — an unapplied customer payment or a customer credit liability under the sealed Phase 4 contract — applied later to the repair sale through the canonical payment/credit allocation. Phase 11 creates **no deposit relation**, no repair receivable, no repair payment and no repair balance.
**How it is checked.** Absence again, and absence is checked structurally because it is the easiest thing to claim falsely: (a) the migration end-state assertion enumerates every relation Phase 11 created and requires that **none** carries a column matching `%amount%minor`, `%balance%`, `%deposit%`, `%paid%` or `%due%` — the same `pg_attribute` query that carries `L-P11-02`, widened; (b) a gate arm over the Phase 11 DDL text and source tree reds on a relation or module name containing `deposit`, `prepayment`, `advance` or `balance`; (c) a source arm asserting **zero** Phase 11 writes to any Phase 4 money relation (`payments`, `customer_credits`, `invoices`, `invoice_allocations`) — the repair module reads the customer's unapplied balance and writes none of it.
**Red proof R-REP-04.** Three mutations. (a) Add `repair_deposits (business_id, ticket_id, amount_minor, …)` to the Phase 11 DDL in a scratch copy: both the catalogue arm and the text arm must red, naming that relation and that column. (b) Add a Phase 11 module that inserts a `payments` row directly: the source arm must name the file and line. (c) Allocate a deposit to a **repair ticket id** rather than a committed invoice: the Phase 4 allocation path must refuse it, and the proof must show the refusal comes from **Phase 4's own authority**, not from a check Phase 11 added — because a Phase 11 check here would itself be the second authority the law forbids.
**The honest limit, stated rather than hidden:** Phase 4's payment and credit contract is not sealed, so (c) is `WAITING_FOR_INTEGRATED_SURFACE`. The design is settled; the surface it binds to is not, and this document does not call an unexecuted case proved.

### C-WAR-01 — a warranty is anchored, and its history is append-only
**New, on PART 70.** A warranty row exists only against a **committed sale**, one of **its own sale lines**, and the **serial/item where applicable**. Its issuance facts (`sale_id`, `sale_line_id`, `serial_id`, `starts_on`, `ends_on`, `source`) are never updated and the row is never deleted; a cancellation, an expiry or a return records a **new event** in an append-only chain whose transitions are a closed set — `issued` → `cancelled` | `ended` | `voided-by-return` — and the current state is derived from the chain's last event.
**How it is checked.** The anchoring is structural, not validated: composite `FOREIGN KEY (business_id, sale_id, sale_line_id)` to the sale line, so an unanchored warranty is unrepresentable, plus a trigger requiring the sale's status to be committed at issuance. Append-only is a BEFORE UPDATE/DELETE trigger refusing both (`warranty.history_immutable`), the `0060` identity-lock precedent reused. The chain is the `repair_device_custody_events` shape: gap-free `event_seq` from 1, a closed transition set, terminal states terminal, current state equal to the last event — a deferred COMMIT trigger, and the derived `current_state` column proved against its fold exactly as the stock caches are.
**Red proof R-WAR-01.** Six mutations, six named refusals. (a) Issue a warranty against a **draft** sale → refused. (b) Issue one whose `sale_line_id` belongs to a **different** sale → refused by the composite FK, and the proof must show it is the **FK** that refuses, not a trigger, because an FK cannot be bypassed by a new writer. (c) `UPDATE` an issuance fact → `warranty.history_immutable`. (d) `DELETE` the row on a return path — **the exact defect of the first draft** → the same refusal, and the proof asserts that after the return the row is **still there** with a `voided-by-return` event appended, because "the return succeeded" is what a test would otherwise check while the history quietly vanished. (e) A transition out of a terminal state → refused. (f) Perturb `current_state` directly as the internal owner → the fold comparison reds naming the warranty.
**This is the law whose failure is silent.** A deleted warranty row breaks nothing today; it breaks the claim six months from now, when the only question that matters is whether this unit was ever under warranty, and nothing in the database can answer it any more.

### C-APP-01 — the variant matrix is closed, canonical and unique
**Statement.** A matrix product's variant `attributes` is exactly its registered axis set, every value is a registered active value, the canonical form is unique per product, base variants stay `'{}'`, **a combination never changes once written**, and **an axis named by existing variants cannot be removed**.
**How it is checked.** The trigger of the patch request §2.4 (five refusals, the two withdrawn ones recorded there) plus the expression unique index plus the new `BEFORE DELETE` guard on `product_matrix_axes`. The *generator* is tested separately from the *validator*, because a title that claims the generator while the test reads the validator is a false attribution of evidence — a real finding from S5's round 2.
**Red proof R-APP-01.** Each refusal gets its own mutation and its own named refusal; plus one that attempts the same canonical combination twice and must hit the index, not the trigger; plus one that proves **jsonb's own key-order normalization** rather than a sort in the canonicalizer, because the first version of this proof asserted a mechanism the function did not supply.
**Status.** `PROVEN BY TEST` on a scratch cluster at `d813de2` — 21 serial cases, 0 failed. See `P11-LIVE-DDL-PROOF.md`.

### C-APP-02 — the matrix invariants hold under concurrency, not only per transaction
**Statement.** Closure and uniqueness hold **after two concurrent transactions commit**, not merely inside each one.
**Why this law exists at all.** It did not, until V2 of the Master Continuous Mission refused the sentence this preparation carried: *"apparel has no concurrency to prove; it adds no deferred conservation trigger and no lock order."* V2's answer is the law: **"no locks, therefore no concurrency" is not a proof.** Running the races found two real holes that every single-transaction test passed over.
**How it is checked.** Three races, two live backends, interleaved by sentinel, **no `sleep()`** — `prep/phase11/harness/races.py`:

| race | the interleaving | what it must show |
|---|---|---|
| A | two sessions insert the same combination | the loser **blocks** on the speculative insert and is then refused on `product_variants_matrix_uq`; exactly one row survives |
| B | one session deletes an axis while another inserts a variant naming it | they **serialize** (the validator reads the registry row `FOR KEY SHARE`), and **zero** variants name an unregistered axis after both commit |
| B2 | the same two statements in the **reverse arrival order** | the deleter **blocks** on the inserter's key-share lock and is refused `catalog.matrix_axis_in_use`; the committed state keeps both the axis and its variant. **Both arrival orders are required**, because the guard is a refusal guard and not a lock-order device: `TL-P4-COORD-R62` measured that a `BEFORE ROW DELETE` trigger cannot lock ahead of the row being deleted (`GetTupleForTrigger` locks `OLD` before the body runs), so the ordering must come from the **insert** side and the reverse order is the only one that exercises the guard's body |
| C | one session changes `attributes` while another inserts the variant's **first** stock row | no changed-combination-with-stock row can exist |

**Red proof R-APP-02.** Remove the `FOR KEY SHARE` from the validator's registry read and race B must produce the broken closure; remove the axis-in-use guard and **race B2** must produce a variant naming a deleted axis (B2 is the arrival order that exercises the guard at all); make immutability conditional on existing stock again and race C must produce the forbidden state. Mutation target: **scratch copy of the Phase 11 DDL**, never frozen history.
**Status.** `PROVEN BY TEST` on a scratch cluster at `e27acaf` — **4 races, 0 findings**, after the fixes (two in the DDL, and one in the harness: race B2's first run named an unregistered axis value, so its T1 never took the lock and the race reported a finding that was its own). Nothing is claimed beyond these three interleavings at `read committed`; deadlock and `SERIALIZABLE` are `UNMEASURED`.
**What race C taught, kept because the next overlay pack will face it.** A cross-table guard whose condition is the **absence** of a row cannot be made safe by locking: there is no row to lock, and only `SERIALIZABLE` gives a predicate lock. It was closed by **removing the class of failure** — unconditional immutability, owned entirely by Pack A — rather than by asking the inventory authority for a lock. The cheaper fix was a lock on a row that does not exist; the correct fix was to make the question unaskable.

---

## 2. The gate

`scripts/phase11-s<N>-gate.ts`, npm script `gate:phase11:s<N>`, an **unconditional** step of the required `backend` CI job with no `if:` and no `continue-on-error` — the `scripts/phase4-s4-gate.ts` shape: exported `CHECKS: readonly Check[]` of `{ id, title, run(root): string[], ok, note? }`, predecessor gates composed by **importing their assertions**, never by spawning them.

Arms, each stated as what it would detect:

| arm | reds when |
|---|---|
| `frozen-prefix` | any accepted migration differs by a byte from its accepted digest, or the manifest disagrees; `frozenThrough` is a **floor** |
| `no-money` | L-P11-02: a monetary column or a monetary computation in Phase 11 DDL or source, **including one commented as report-only** |
| `no-money-balance` | C-REP-04: a Phase 11 relation or module names a deposit, prepayment, advance or customer balance, or a Phase 11 module writes a Phase 4 money relation |
| `warranty-append-only` | C-WAR-01: a `warranties` UPDATE/DELETE path exists, an issuance fact is nullable where the anchor must be composite, or the lifecycle transition set is open |
| `one-billing-binding` | C-REP-03: `repair_part_billing_bindings` carries a quantity-claimed column or a key admitting two rows per consumption — i.e. v1 partial billing became representable |
| `mutation-scope` | §0a: a proof harness's mutation path resolves inside `infrastructure/database/migrations/` rather than a scratch copy, or a run ends without the whole-tree clean-check |
| `no-client-binding` | a request schema exposes a property by which a client could supply a preconsumed billing binding (`P11-AL-21` conditions 1–2) |
| `expiry-no-override` | `products.expiry_policy`'s CHECK admits more than one value, or an override path exists (`TL-P11-R4`) |
| `roster-parse` | a rostered suite does not **parse** — the only arm that detects a file broken so it cannot compile |
| `roster-bijection` | the roster and the files on disk are not a bijection, or a rostered block is hollowed out |
| `roster-ratchet` | a recorded suite disappeared (membership; the count half is subsumed by it and its whole value is its message) |
| `roster-red-proofs` | a law has no named red proof, or a red proof does not name a specific refusal |
| `roster-execution` | the rostered files, handed to **one** bounded Vitest run, do not pass — verdict read off the spawn **result object**, never through a pipe, because a pipeline's exit status is its last stage's |
| `lock-order` | the stated lock order is not a suffix of the existing one, or a writer takes locks in another order |
| `race-estate` | C-APP-02: a Phase 11 invariant that spans two rows or two tables has no race in `races.py`, **a race that can run in two arrival orders runs only one of them**, a race uses `sleep()` instead of a sentinel, or any arm of a race can fail without a non-zero exit — the last one being how three races were invalidated, twice |
| `unlocked-closure-read` | a Phase 11 validator reads a registry row it depends on with a bare `SELECT` rather than `FOR KEY SHARE` / `FOR SHARE`, i.e. defect 7 is reintroduced |
| `no-trigger-lock-order` | a Phase 11 document, comment or test name claims that a `BEFORE DELETE` trigger establishes a lock order (`TL-P4-COORD-R62`: the executor locks `OLD` before the trigger body runs, so it cannot), or a DELETE-path lock order is promised anywhere but as a **caller** obligation |
| `rls-coverage` | a new relation lacks `ENABLE`+`FORCE`, or lacks any of its required policies, or `tenant_membership` lost its `WITH CHECK`, or a policy assembles a role name by concatenation |
| `grants` | `PUBLIC` holds a privilege, an internal definer carries an `EXECUTE` grant, or an entry routine is missing one |
| `command-refusal-audit` | a discovered Phase 11 command path does not reach the single `auditThenRethrowRefusal` composer |
| `localization` | the three message catalogues differ in key set, a refusal code has no `error.<code>` entry, or a JSX text literal sits outside `t()` |
| `required-ci` | the workflow does not run this gate unconditionally in the required `backend` job, after its predecessor |
| `closure-and-tense` | the gate names a migration past the last accepted one, or a candidate-tense block is unfenced |

**Printed limitations on PASS**, because a gate that hides what it does not check is worse than one that checks less: whether any suite was executed by *this* gate or only parsed; that a structural arm cannot see a flipped assertion inside a rostered suite (a green gate over a genuinely failing suite is possible and was demonstrated in S5 — `GATE rc=0 4/4 ok` while `RUNNER rc=1 1 failed`); and that the gate is not, until the Migration Owner and CI Owner add it, a required CI step.

---

## 3. Test estate owed before promotion

| tier | content |
|---|---|
| T0 | `format`, `lint`, `typecheck` as **separate named steps**, each reported in the exact form it was run, over the whole workspace set — not a narrower `tsc -p` reported under a broad name |
| T1 | package unit tests for the pure parts: canonicalization, picker ordering, chain arithmetic |
| T2 | integration on a live cluster: the DDL applied **as `daftar_migrator`**, every refusal of the patch request reached, every conservation trigger red-proved |
| T3 | concurrency: C-SER-04, C-LOT-02, and the deadlock test in both lock orders, real connections and barriers |
| T4 | security: tenant and business isolation on every new relation from a non-superuser session; the Phase 3/4 RLS equivalence suites extended; direct-SQL attempts refused |
| T5 | golden regression: a lot-tracked purchase→sale world and a serialized sale→return→repair world, with **values compared against the pre-Phase-11 oracle** (C-LOT-04) |
| T6 | web: SSR suites every new view inherits — no internal ids in markup, RTL mirror with no physical sides, phone width, merchant-jargon; ar/en/tr complete |
| T7 | browser: the permanent real-browser gate in all three locales |

Performance: the packs add read paths (per-lot pages, serial lookup, expiry reports) that need budgets. **No budget number is proposed here and none is measured here** — the authoritative box is exclusive and is not this container, and a figure from here would not be comparable. The owed item is a budget *lane*, set by the Performance Owner on that box, in the deterministic-correctness / performance-evidence split the Master directive's Part 18 already requires.
