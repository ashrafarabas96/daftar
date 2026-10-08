# P11 — CONSERVATION LAWS AND THEIR RED PROOFS

**status** `PREPARED / NOT PROMOTED`. **revised 2026-10-08** under `TL-P11-R1` … `TL-P11-R7`: L-P11-02 now names the snapshot case (§55) and a new law **C-REP-03** carries the double-consumption correction (§60, `TL-P11-R7`). **Every verdict in this document is `SPEC ONLY` or `UNMEASURED`, never two classes in one sentence (§82)**: no law here has been executed, because none of its subject exists yet. This is the proof *plan*, written before the implementation so the implementation cannot choose its own bar. No timing or performance claim appears anywhere in it.

---

## 0. Why this document exists before the code

Phase 11 adds two surfaces that *could* disagree with the inventory truth — a per-lot quantity and a per-serial custody count. A surface that can drift and is guarded by convention will drift. So each law below is carried by a **deferred COMMIT trigger or a foldable cache**, not by a code review, and each has a **named red proof**: a minimal mutation that must turn exactly that law red, naming exactly that refusal.

Five rules this project paid for, and which this plan obeys:

1. **A suite that cannot compile reports nothing.** A string literal broken across two lines once made 92 proofs unrunnable while the roster still reported `cases=92`; a textual case count cannot detect it, only a parser can. The Phase 11 gate parses every rostered file.
2. **A non-empty list names no law.** `expect(mutated).not.toEqual([])` proves something refused, never *which* thing refused. Every red proof below asserts the **specific refusal string**.
3. **Prove the mutation landed.** A `sed` that matches no line goes green and records a missing law as fine. Every mutation is diff-checked *before* its run is read.
4. **A comment citing a check is evidence of nothing.** Three times in one day a comment named a check that did not exist. No law below is satisfied by a comment.
5. **A green vitest suite is not a typecheck**, and a skipped step is `UNMEASURED`, never green. The gate runs format, lint and typecheck as their own named steps, in the exact form they were run.

Evidence classes are never mixed in one sentence: `PROVEN IN LIVE CODE` / `PROVEN BY TEST` / `PROVEN BY DATABASE CATALOGUE` / `DESIGN ONLY` / `SPEC ONLY` / `UNMEASURED` / `BLOCKED`.

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
**The law the first draft needed and did not have (§60, `TL-P11-R7`).** Billing a consumed part through a preconsumed sale-line binding produces **zero** additional `stock_movements` rows and **zero** additional COGS postings, and a binding cannot exist without the consumption it names.
**How it is checked.** Four executed cases on a live cluster, each counting rows **before and after** rather than inspecting code: bill a consumed part and require the movement count and the COGS posting count for that variant to be unchanged; attempt a **second** binding for the same consumption and require the primary key to refuse it; attempt a binding whose qty differs from the consumption and require `repair.billing_qty_mismatch`; attempt a binding **before** any consumption exists and require `repair.billing_without_consumption`.
**Red proof R-REP-03.** Put the part on an ordinary sale line instead of a binding — the exact defect of the first draft — and require the movement-count case to red naming **two** movements where one was expected. A test that merely asserts "the invoice was created" passes through this defect without noticing, which is how the draft got as far as it did.
**And the arm that matters most:** the request schema must have **no property** by which a client could supply a binding (conditions 1 and 2 of `P11-AL-21`). The proof is not that a supplied value is refused but that it is **unrepresentable**: add the property to the zod schema in a scratch copy and require a gate arm to name it. A refusal can be forgotten on one path; an absent field cannot.
**This is now the third law a challenger should attack**, alongside C-SER-03 and C-LOT-03 — and unlike those two, its failure mode is free inventory rather than a drifting count.

### C-APP-01 — the variant matrix is closed, canonical and unique
**Statement.** A matrix product's variant `attributes` is exactly its registered axis set, every value is a registered active value, the canonical form is unique per product, and base variants stay `'{}'`.
**How it is checked.** The trigger of the patch request §2.4 (six refusals) plus the expression unique index. The *generator* is tested separately from the *validator*, because a title that claims the generator while the test reads the validator is a false attribution of evidence — a real finding from S5's round 2.
**Red proof R-APP-01.** Six mutations, six named refusals; plus one that attempts the same canonical combination twice and must hit the index, not the trigger.

---

## 2. The gate

`scripts/phase11-s<N>-gate.ts`, npm script `gate:phase11:s<N>`, an **unconditional** step of the required `backend` CI job with no `if:` and no `continue-on-error` — the `scripts/phase4-s4-gate.ts` shape: exported `CHECKS: readonly Check[]` of `{ id, title, run(root): string[], ok, note? }`, predecessor gates composed by **importing their assertions**, never by spawning them.

Arms, each stated as what it would detect:

| arm | reds when |
|---|---|
| `frozen-prefix` | any accepted migration differs by a byte from its accepted digest, or the manifest disagrees; `frozenThrough` is a **floor** |
| `no-money` | L-P11-02: a monetary column or a monetary computation in Phase 11 DDL or source, **including one commented as report-only** |
| `no-client-binding` | a request schema exposes a property by which a client could supply a preconsumed billing binding (`P11-AL-21` conditions 1–2) |
| `expiry-no-override` | `products.expiry_policy`'s CHECK admits more than one value, or an override path exists (`TL-P11-R4`) |
| `roster-parse` | a rostered suite does not **parse** — the only arm that detects a file broken so it cannot compile |
| `roster-bijection` | the roster and the files on disk are not a bijection, or a rostered block is hollowed out |
| `roster-ratchet` | a recorded suite disappeared (membership; the count half is subsumed by it and its whole value is its message) |
| `roster-red-proofs` | a law has no named red proof, or a red proof does not name a specific refusal |
| `roster-execution` | the rostered files, handed to **one** bounded Vitest run, do not pass — verdict read off the spawn **result object**, never through a pipe, because a pipeline's exit status is its last stage's |
| `lock-order` | the stated lock order is not a suffix of the existing one, or a writer takes locks in another order |
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
