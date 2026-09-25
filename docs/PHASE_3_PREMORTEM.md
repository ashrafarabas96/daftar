# DAFTAR — Phase 3 Premortem / التحليل الاستباقي للمرحلة الثالثة

> **Method.** Assume Phase 3 shipped and something went wrong in a real merchant's books. Work backwards to the mechanism. For every scenario: the **preventive invariant** (what physically cannot happen), **detection** (how we find out if prevention was defeated), the **test** that proves the invariant exists, the **failure mode** if it is absent, and the **recovery rule**.
>
> **Rule that governs this page.** "We will monitor it" is never the sole control for data corruption. Every scenario below has a preventive invariant, not only a detector. Where a control is genuinely detective — because the thing it watches is a cross-ledger agreement rather than a single row — that is stated plainly and the prevention that makes agreement achievable is named.
>
> Companion to `docs/PHASE_3_ARCHITECTURE_LOCK.md`. Each scenario cites the decision that closes it.

---

## PM-01 — The stock cache diverges from the movement ledger

**Preventive invariant** (P3-AL-01, P3-AL-42). `stock_levels` is written **only** by the same trusted command that appends the movement, in the same statement, under the stock key's row lock. No runtime role holds DML on either table. There is no endpoint, admin command or script that sets a cache value to a supplied number.

**Detection.** The rebuild's verification mode compares `Σ qty_delta` and `Σ value_delta_base_minor` ordered by `stock_seq` against the cache, per key, as a scheduled reconciliation.

**Test.** A key with hundreds of movements, including value-only ones and a period at zero, rebuilds to the cache exactly. Separately: every principal is refused DML on both tables in the live grant matrix.

**Failure mode without it.** Availability and valuation drift silently; the merchant sells stock they do not have and the GL stops matching inventory.

**Recovery.** Alert and refuse. Investigate which command wrote outside the lock. Rebuild from movements **after** the defect is fixed — never before, or the rebuild hides the evidence.

---

## PM-02 — Two simultaneous receipts corrupt the average cost

**Preventive invariant** (P3-AL-06). Every command ensures the row with `ON CONFLICT DO NOTHING` and then takes `SELECT … FOR UPDATE` unconditionally. All arithmetic happens inside that lock. There is no `ON CONFLICT DO UPDATE` carrying a computed value, which would compute outside it.

**Detection.** Reconciliation PM-16; and a gapless `stock_seq` per key, whose violation is itself the evidence of a write outside the lock.

**Test.** Two real connections receive into the same new key concurrently: one `stock_levels` row, two movements with sequences 1 and 2, and an average equal to the serial result.

**Failure mode without it.** Lost update: the second receipt overwrites the first's average and the inventory value is permanently wrong for every later sale.

**Recovery.** Rebuild the affected key from movements once the race is closed; the movements are correct even when the cache is not, which is the whole point of the cache being a cache.

---

## PM-03 — Opposite-direction transfers deadlock

**Preventive invariant** (P3-AL-07). One canonical lock order, `(warehouse_id, variant_id)` ascending as `uuid`, applied by every command after parsing and before any lock. Payload order is never lock order.

**Detection.** A deadlock is a defect, so the signal is the PostgreSQL error itself; it is never retried into a business outcome.

**Test.** Two real connections run `A → B` and `B → A` on the same variant concurrently; both complete, neither deadlocks.

**Failure mode without it.** Random `deadlock detected` under load, which a tired implementer "fixes" with a retry loop — turning a lock-order defect into a policy.

**Recovery.** Fix the ordering. Never add a retry.

---

## PM-04 — The same source retries and creates duplicate movements

**Preventive invariant** (P3-AL-09). `UNIQUE (business_id, source_type, source_id, source_line_id, movement_kind)`. A retry cannot insert a second movement for one source line; the database refuses it.

**Detection.** The unique violation is caught by the command and turned into the idempotent "already done" reply, never into a new fact.

**Test.** Receiving the same purchase twice produces one set of movements and one journal entry; the second call reports the existing result.

**Failure mode without it.** Doubled stock and doubled inventory value from a network retry the merchant never saw.

**Recovery.** None needed — the duplicate never commits. If one somehow exists, it is corrected by an explicit domain correction with its own source identity, never by deleting a movement.

---

## PM-05 — An existing simple Product has no Variant

**Preventive invariant** (P3-AL-03, P3-AL-04). Inventory addresses `variant_id` only. Enabling tracking creates exactly one base variant, `UNIQUE (business_id, product_id) WHERE is_base`. Existing products are untracked until the merchant acts.

**Detection.** The tracked-product CHECK; and a migration-day assertion that no product became tracked and no stock row exists.

**Test.** Enabling tracking on a product with no variants creates one base variant with NULL sku/barcode; calling it twice is idempotent; a product with variants gets no base variant.

**Failure mode without it.** A null `variant_id` in the stock ledger, or a second identity model for "simple products" that every later query must branch on.

**Recovery.** Not applicable if prevented. A base variant is never deleted once it has movements (P3-AL-41).

---

## PM-06 — Unit precision allows half a "piece"

**Preventive invariant** (P3-AL-05). `unit_decimals ∈ 0..4`, frozen on the product; the trusted command refuses any quantity that is not exactly representable at that precision — `abs(qty) ≠ trunc(abs(qty), unit_decimals)` → `inventory.quantity_precision_invalid`. The refusal is in the database (the trusted command, under the stock key's lock), not in a form validator. It cannot be a row `CHECK`, because the permitted precision lives on the product row, and a `CHECK` may not read another table — stated rather than papered over.

**Detection.** Any movement whose quantity is not exactly representable at its product's frozen `unit_decimals` — a query that must return zero rows. The query uses `trunc`, never `scale`.

**Test.** All ten bound vectors of P3-AL-05, through every command (receive, adjust, transfer, stocktake, supplier return): `unit_decimals = 0` accepts `1`, `1.0000` and `-3.0000`, refuses `0.5` and `1.0001`; `unit_decimals = 2` accepts `1.23` and `1.2300`, refuses `1.234` and `0.0001`; `unit_decimals = 4` accepts `1.2345`.

**Failure mode without it.** Half a phone in stock, and an average cost divided by a quantity that cannot exist.

**Recovery.** Correct by an explicit adjustment with a reason; never by editing a movement.

---

## PM-07 — A stocktake runs while receipts occur

**Preventive invariant** (P3-AL-16). Snapshot-delta: `expected_qty_at_capture` and `captured_at_stock_seq` are recorded at capture; the variance is applied **once** at finalization against current state. No transaction is held open while a human counts, and no warehouse is frozen.

**Detection.** Finalization is idempotent by the stocktake line's movement identity (PM-04), so a double finalize cannot double-apply.

**Test.** Capture, then receive and transfer on the same key, then finalize: the resulting on-hand equals the counted quantity plus the intervening movements, exactly.

**Failure mode without it.** Either a warehouse frozen for hours, or a count that silently erases every movement made during the count.

**Recovery.** A finalized stocktake is immutable; a wrong count is corrected by a new adjustment with a reason.

---

## PM-08 — Landed cost rounds differently across lines

**Preventive invariant** (P3-AL-22, P3-AL-08). Largest-remainder distribution with the `line_no ASC` tie-break; Σ allocations = the total, exactly, by construction. `manual` mode requires exact equality and refuses anything else. `by_value` with a zero denominator refuses rather than falling back.

**Detection.** A purchase whose Σ line allocations differs from its landed-cost total — a query that must return zero rows.

**Test.** A landed cost that does not divide evenly across three lines distributes deterministically and sums exactly; reordering the input array does not change any line's allocation.

**Failure mode without it.** Inventory value that disagrees with the purchase total by a few minor units on every foreign purchase, accumulating into a permanent GL mismatch.

**Recovery.** Reverse the purchase (P3-AL-20) if it is still reversible; otherwise correct through supplier return or an audited adjustment.

---

## PM-09 — A duplicate variant line makes the average order-dependent

**Preventive invariant** (P3-AL-21). `UNIQUE (business_id, purchase_id, variant_id)`. Two supplier lines for one variant must be combined before posting; the ambiguity cannot be created.

**Detection.** The unique constraint is the detector; nothing reaches the average.

**Test.** A purchase with two lines for the same variant is refused at insert.

**Failure mode without it.** The same purchase produces two different average costs depending on UI line order — a difference no report could explain.

**Recovery.** Not applicable if prevented.

---

## PM-10 — The purchase commits but the accounting fails

**Preventive invariant** (P3-AL-32). One unit of work: source document, lines, movements, cache, deficit coverage, posting, binding, audit and outbox commit together or roll back together. No nested independent commit, no saga, no compensating transaction.

**Detection.** Failure injection at each step (P3-S8) and the source-completeness guard at COMMIT.

**Test.** An injected failure at the posting step leaves no purchase, no movement, no cache change, no audit row and no outbox row.

**Failure mode without it.** Stock on the shelf that the books do not know about, and an AP balance that never appears.

**Recovery.** None needed — nothing committed. This is the scenario the whole seam exists for.

---

## PM-11 — The accounting commits but the stock fails

**Preventive invariant.** The mirror of PM-10, same invariant, same transaction. The order of operations inside the transaction does not matter to atomicity; what matters is that there is exactly one `COMMIT`.

**Detection.** The accounting source binding cannot exist without its Phase 3 source detail row — the COMMIT-time completeness guard of P3-AL-34, which is AL-01's contract applied to every new source type.

**Test.** An injected failure at the movement step leaves no journal entry and no binding.

**Failure mode without it.** A journal entry for a receipt that never happened — a financial fact with no operational fact behind it, which is the harder direction to detect after the event.

**Recovery.** None needed if prevented. A journal entry is never deleted; a wrong one is reversed.

---

## PM-12 — A supplier payment over-allocates AP

**Preventive invariant** (P3-AL-28). The purchase row and the payment row are both locked `FOR UPDATE` in canonical order, and `Σ allocations ≤ amount` is checked under that lock, on both sides.

**Detection.** A purchase whose Σ active allocations exceeds its total, or a payment whose Σ allocations exceeds its amount — queries that must return zero rows.

**Test.** Two concurrent allocations against one purchase with room for one: exactly one succeeds.

**Failure mode without it.** A supplier shown as overpaid, a negative outstanding balance, and a statement nobody can reconcile.

**Recovery.** Reverse the offending allocation through the atomic reversal path; the money is still where it was, so the correction is a new fact, not an edit.

---

## PM-13 — A supplier return exceeds the original quantity

**Preventive invariant** (P3-AL-29). Cumulative returned quantity per purchase line is checked against the purchased quantity under the purchase line's lock.

**Detection.** A purchase line whose Σ returned quantity exceeds its purchased quantity — zero rows.

**Test.** Sequential partial returns up to the limit succeed; the one that crosses it is refused; two concurrent returns that would jointly cross it leave exactly one.

**Failure mode without it.** AP debited for goods that were never bought, and PPV absorbing the difference as though it were a price variance.

**Recovery.** Reverse the excess return; investigate whether the goods exist.

---

## PM-14 — A supplier return exceeds the warehouse's stock

**Preventive invariant** (P3-AL-12, P3-AL-29). No Phase 3 command may drive a key negative. The return refuses with `inventory.insufficient_stock` under the stock key's lock.

**Detection.** Any `stock_levels.on_hand < 0` — a query that must return zero rows in Phase 3, since Phase 3 registers no negative producer at all.

**Test.** A return of more than the source warehouse holds is refused; the same return from a warehouse that does hold the stock succeeds.

**Failure mode without it.** Negative stock with no sales workflow behind it, and a provisional cost invented to value it.

**Recovery.** Transfer stock in, then return; or correct the purchase.

---

## PM-15 — A supplier credit is consumed twice concurrently

**Preventive invariant** (P3-AL-31). `remaining_amount_minor` and `remaining_carrying_base_amount_minor` live on one row, locked once `FOR UPDATE`; every consumer takes that lock before reading. The final consumption releases the entire carrying-base residue.

**Detection.** A credit note whose Σ allocations + Σ refunds exceeds its original amount, or whose released carrying base does not sum to the original — zero rows.

**Test.** Two concurrent consumers of one credit: exactly one succeeds, or both succeed for disjoint amounts summing to at most the remaining.

**Failure mode without it.** A credit spent twice, and rounding dust stranded on a credit that reports as fully consumed.

**Recovery.** Reverse the second consumption; the two-value rule prevents the dust.

---

## PM-16 — GL Inventory diverges from inventory valuation

**Preventive invariant** (P3-AL-32, P3-AL-08, P3-AL-43). Every valuation change and its journal entry are produced by the same command in the same transaction from the same numbers, converted to minor units once by the one HALF_EVEN contract. Divergence therefore has no legitimate source.

**Detection — and this one is genuinely detective.** Reconciliation compares `Σ value_delta_base_minor` over the movements against the `Inventory(1200)` balance, per business, with **zero tolerance**. A tolerance would be where real divergence hides.

**Test.** A long mixed sequence — receipts, transfers, adjustments, stocktake, supplier return, landed cost, foreign currency — reconciles exactly. Removing the seam's single-transaction property makes it fail.

**Failure mode without it.** The merchant's balance sheet and stock report tell two different stories and nobody can say which is right.

**Recovery.** **Alert and fail. No correcting entry, ever.** Investigate, find the operation that diverged, and correct it through an explicit domain operation with its own source identity.

---

## PM-17 — A future-dated journal entry bypasses the domain command

**Preventive invariant** (P3-AL-36). A `BEFORE INSERT` trigger on `journal_entries` resolving the business's timezone refuses a future `entry_date` with `accounting.entry_date_in_future`, beneath every command including raw SQL by the schema owner. The command-level checks remain.

**Detection.** The raw-SQL matrix asserts both halves — the commands refuse it and now the schema does too.

**Test.** A direct `INSERT` as the schema owner with tomorrow's date is refused; an entry dated "tomorrow UTC" but "today" in the business's timezone is accepted; the reverse is refused.

**Failure mode without it.** A period closes over entries that had not happened yet, and every report of that period is wrong.

**Recovery.** Reverse the entry. It cannot be deleted.

---

## PM-18 — A branch-scoped user moves stock in an unauthorized warehouse

**Preventive invariant** (P3-AL-15, P3-AL-39). Both checks, always: the domain permission **and** the warehouse scope, over the **set** of affected warehouses. Default deny; `warehouses.is_default` is never authority.

**Detection.** Audit events carry the actor and every affected warehouse; an authorization failure is a refusal, not a log line.

**Test.** An `assigned` actor is refused a transfer whose destination is outside their branches even when the source is inside; an actor with no branch association reaches no warehouse at all.

**Failure mode without it.** One branch quietly moving another branch's stock, with the loss appearing as shrinkage months later.

**Recovery.** Reverse the movement through an audited adjustment; review the association table.

---

## PM-19 — A historical supplier, product or warehouse is deleted

**Preventive invariant** (P3-AL-40, P3-AL-41). `ON DELETE RESTRICT` from every child document, commands that offer no delete, and archival refused while stock is non-zero. Supplier identity is snapshotted onto every received purchase.

**Detection.** A document referencing a missing parent — a query that must return zero rows.

**Test.** Deleting a supplier with a purchase is refused; archiving a warehouse with stock is refused; renaming a supplier does not change any existing purchase's snapshot.

**Failure mode without it.** Reports that cannot name who was bought from, and a purchase document that has lost the entity it was with.

**Recovery.** Not applicable if prevented; deactivate instead of deleting.

---

## PM-20 — A negative deficit is covered twice

**Preventive invariant** (P3-AL-06, P3-AL-13). A receipt must hold the stock key's `stock_levels` row before it may read a deficit layer, so concurrent receipts are serialized before FIFO is consulted; `FOR UPDATE` on the layers is the second line of defence.

**Detection.** A deficit whose Σ `qty_covered` exceeds its `original_deficit_qty`, or `uncovered_qty < 0` — both refused by CHECK and both queried as zero rows.

**Test.** Two concurrent receipts against one open deficit cover disjoint quantities summing to at most the deficit; GOLD-72's numbers reproduce.

**Failure mode without it.** COGS corrected twice for one oversell, and `GL ≠ valuation` permanently.

**Recovery.** Alert; reverse the duplicate catch-up entry; rebuild the key.

---

## PM-21 — Deficit FIFO depends on timestamps

**Preventive invariant** (P3-AL-02, P3-AL-13). FIFO orders by `(deficit_seq, id)`, allocated under the stock-key lock. `created_at` is `now()`, which is transaction-start time and can tie by construction; no invariant depends on it.

**Detection.** A static check that no ordering query over movements or deficits uses `created_at`.

**Test.** Two deficits created in one transaction — therefore sharing `created_at` exactly — are covered in `deficit_seq` order, deterministically, across repeated runs.

**Failure mode without it.** Non-deterministic catch-up amounts: the same history replays to different COGS.

**Recovery.** Rebuild after fixing the ordering; the coverage rows record which layer was covered at which cost, so the history is reconstructable.

---

## PM-22 — An immediate-cash purchase creates a second accounting model

**Preventive invariant** (P3-AL-24). Every received purchase posts `Dr Inventory / Cr AP`. "Paid immediately" is a purchase **plus** a supplier payment **plus** an allocation, which may share one transaction. There is no cash path in the code to take.

**Detection.** A `purchase` journal entry whose credit side is not `accounts_payable` — a query that must return zero rows.

**Test.** A cash purchase and a credit purchase produce identical purchase entries; the cash one additionally produces a payment and an allocation.

**Failure mode without it.** Supplier statements computed from a union of two models, and "what do I owe?" answerable only by knowing which path each purchase took.

**Recovery.** Not applicable if prevented. A purchase posted the wrong way is reversed, not edited.

---

## PM-23 — Tax rules are invented without a Country Pack

**Preventive invariant** (P3-AL-23). Purchase tax is zero unless an approved tax policy exists; a non-zero purchase tax is **refused** with `purchase.tax_policy_absent`. No code chooses between recoverable input tax and capitalized non-recoverable tax, because that choice is tax law.

**Detection.** A purchase with non-zero tax and no country policy — a query that must return zero rows.

**Test.** A purchase with non-zero tax is refused; the same purchase with zero tax succeeds.

**Failure mode without it.** A silently chosen treatment that is wrong in one country and undetectable until an audit.

**Recovery.** OD-03 must be resolved by official per-country sources before any non-zero tax is accepted.

---

## PM-24 — Phase 3 grants `ACCOUNTING_ASSERTION_KEY` to another process

**Preventive invariant** (P3-AL-37). The key stays exclusive to `merchant-api`. No second signer, no second process, no redesign of the accepted verifier. The minter is a port the engine never touches, and the worker and platform runtimes do not construct it.

**Detection.** The existing per-process runtime isolation tests, which assert which configuration each process loads, extended to assert that no Phase 3 module pulls the minter into the worker or platform composition.

**Test.** Booting the worker and the platform processes with a Phase 3 module loaded still fails if they attempt to construct the minter; neither process's owned configuration contains the key.

**Failure mode without it.** A second process able to mint accounting authority, which is a trust-boundary change made by an import statement.

**Recovery.** Rotate the `kid`, which retires every assertion minted with the exposed key; then remove the second signer. TD-10 must be reopened for architectural review **before** any such change, never after.

---

## PM-25 — A whole-unit quantity is refused because the column pads it

**Preventive invariant** (P3-AL-05). The precision law tests the **value**, not the storage scale: `abs(qty) = trunc(abs(qty), unit_decimals)`. `scale(qty)` is withdrawn by name and may not reappear in any command, guard, report or test. The reason is measured, not argued: in a `NUMERIC(18,4)` column PostgreSQL stores `1`, `1.0`, `1.00` and `1.0000` identically and reports `scale = 4` for all of them, so a `scale`-based rule refuses **every** quantity on a `unit_decimals = 0` product and refuses **nothing** on a `unit_decimals = 4` one.

**Detection.** A static guard rejecting `scale(` applied to a quantity anywhere in the inventory SQL and package; plus the bound-vector suite, which fails loudly the moment the wrong test is reintroduced.

**Test.** `unit_decimals = 0` accepts `1`, `1.0000` and `-3.0000` and refuses `0.5` and `1.0001`; the same suite asserts a `unit_decimals = 4` product still refuses a five-decimal quantity, which the withdrawn rule never could.

**Failure mode without it.** Every piece-unit product is unusable — no receipt, no sale, no stocktake — and the defect looks like a validation bug rather than an arithmetic one, so it is "fixed" by loosening the check until fractions get through.

**Recovery.** No data recovery is needed for a refusal: nothing was written. Correct the rule, re-run the bound vectors, and check no caller worked around it by rounding the quantity before submission — that workaround **is** the corruption.

---

## PM-26 — The rounded average drifts the cache away from the movement ledger

**Preventive invariant** (P3-AL-01, P3-AL-49 §A). `stock_levels.valuation_base_minor` is cached as an **exact addition of stored movement values**; the average is derived from it and is never an input to a write. Deriving a key's valuation as `on_hand × avg` is forbidden by name, everywhere — command, rebuild, report, reconciliation, read model.

**Detection.** P3-AL-43's **second** comparison, `Σ movements = Σ stock_levels.valuation_base_minor` at zero tolerance, which exists specifically to observe this failure rather than assume its absence; plus a static guard over the inventory package and migration SQL forbidding the multiplication.

**Test.** Vector A of P3-AL-49 §E: `on_hand = 3`, `valuation = 1.0000000000`, average `0.3333333333`; remove one unit, then rebuild — live cache and rebuild identical to the tenth decimal. The same test with the forbidden formula substituted **must fail**, and is kept as the negative control.

**Failure mode without it.** `10^-10` per operation, compounding, in the same direction: after a few hundred thousand movements the inventory asset and the GL disagree by a visible amount, with no single wrong transaction to point at.

**Recovery.** Alert and refuse; fix the multiplying path; **then** rebuild from movements. Rebuilding first destroys the only evidence of which path was wrong.

---

## PM-27 — Empty stock still carries value

**Preventive invariant** (P3-AL-49 §C). An outbound movement that empties a key does not price at the rounded average: its `value_delta_base_minor` is defined as the exact negation of the remaining cached valuation. The invariant `on_hand = 0 ⇒ valuation_base_minor = 0` is asserted inside the command, under the lock, before COMMIT, for every key the command touched. A zero-quantity key keeps its average as a **cost reference** only.

**Detection.** `SELECT … WHERE on_hand = 0 AND valuation_base_minor <> 0` — a query that must return zero rows, run by reconciliation and asserted by the command itself.

**Test.** Vector B of P3-AL-49 §E: remaining `on_hand = 2`, `valuation = 0.6666666667`, remove all 2 → `valuation = 0.0000000000` exactly, and specifically **not** `±0.0000000001`. Measured: `2 × HALF_EVEN(0.6666666667/2, 10) = 0.6666666668`, so the naive path leaves `−0.0000000001` and this test catches it.

**Failure mode without it.** Phantom asset value (or phantom negative value) on an empty key that no future movement clears, that the balance sheet carries forever, and that makes the zero-tolerance reconciliation permanently red — inviting a tolerance, which is the real damage.

**Recovery.** Investigate, then rebuild the affected keys from movements. **Never** write a plug entry: the flush is the fix, a plug is a second wrong number.

---

## PM-28 — A non-posting command mints a fake assertion or splits the commit

**Preventive invariant** (P3-AL-32, P3-AL-33). Two typed seams. `withBusinessTransaction` exposes **no** posting capability and requires **no** assertion, so a transfer neither mints one nor needs one. `withBusinessAccountingTransaction` is the only way to obtain posting capability. The distinction is a type; `skipAccounting`, `requiresAccounting: false` and `trusted: true` are forbidden by name in any spelling.

**Detection.** The capability case of the seam matrix (no posting port reachable from the non-posting handle, at compile time and at runtime); an assertion-minting counter asserted to be zero across a transfer; and the existing guard set, which discovers journal writers from the schema.

**Test.** The six-case seam matrix of P3-AL-32: transfer through the non-posting seam creates the movement pair, audit and outbox in one commit, mints nothing, and leaves **zero** journal entries — counted before and after, not assumed. A mismatched scope/assertion refuses before any domain row exists.

**Failure mode without it.** Either an accounting assertion minted for a posting that never happens — authority created to satisfy a function signature, which is how a bypass is born — or a second transaction for the stock half, so a crash between them leaves stock moved with no financial record. Two competent engineers would have chosen differently, and both would have believed they followed the lock.

**Recovery.** For a split commit: the movements are truth, so reconcile and post the missing entry as an explicit correction with its own source identity. For a fake assertion: rotate the `kid` if one was minted outside a real posting, and treat it as a trust-boundary incident (TD-10).

---

## PM-29 — A stock movement exists with no real source

**Preventive invariant** (P3-AL-50, P3-AL-51). `source_type` is an FK into the closed `stock_source_types` registry, so an unauthorized identity string cannot be written at all. `stock_source_bindings` carries deferred FKs in **both** directions, validated at COMMIT, so a movement cannot exist without its source detail and a source detail cannot exist without its movement. Each source-owning slice adds a deferred completeness trigger for its own finalized lines, plus deletion protection and post-finalization immutability.

**Detection.** An anti-join of movements against bindings and of finalized source lines against movements — both must return zero rows — run as part of reconciliation. The COMMIT-time constraints are the prevention; these queries confirm the prevention was not disabled.

**Test.** A movement written without its binding does not survive COMMIT; a binding without its movement does not survive COMMIT; a finalized purchase line with its movement deleted is refused; updating a finalized line's quantity, cost, variant or warehouse is refused; an unregistered `source_type` is refused by the FK.

**Failure mode without it.** Inventory that no document explains, or a received purchase line whose stock never moved — both invisible until someone counts the shelf, and neither repairable without deciding which half to believe.

**Recovery.** The movement ledger is operational truth, so a missing source is an investigation, never a synthesized document. A genuinely orphaned movement is corrected by an explicit adjustment with its own source identity; movements are never deleted.

---

## PM-30 — One purchase line covers several deficit layers and coverages are silently dropped

**Preventive invariant** (P3-AL-13). Coverage identity is header/detail: one `negative_inventory_cost_adjustments` header per receipt operation, one immutable coverage detail per layer, and every coverage movement carries `source_id = header`, `source_line_id = coverage detail`. Each coverage therefore has a distinct P3-AL-09 identity tuple, so none can collide with another and none can be refused as a duplicate.

**Detection.** A count comparison inside the command: coverage details written **=** coverage movements written, asserted before COMMIT; and, across the business, an anti-join of coverage details against their movements returning zero rows.

**Test.** One purchase line covering **three** deficit layers writes three coverage details and three distinct movements, all accepted; the single catch-up journal entry's amount equals the sum of the three **stored** movement values; replaying the receipt writes nothing further. The same test run against the single-identity model **must fail**, and is kept as the negative control.

**Failure mode without it.** The unique tuple admits the first coverage and refuses the rest — so either the receipt fails for a reason no merchant can act on, or, worse, the refusal is caught and swallowed and the catch-up posts for one layer while two remain silently uncorrected, leaving COGS understated forever.

**Recovery.** The deficit layers and coverages are themselves the evidence of what was owed. Recompute the uncovered catch-up from the layers, post it as an explicit correction with its own source identity, and never edit the original entry.

---

## Cross-cutting — what would make this premortem worthless

1. **A test that only ever passes.** Every invariant above is proved by a test that is shown to FAIL when the invariant is removed. A green suite that never modelled the attack proves nothing about the attack.
2. **A gate that cannot say no.** Phase 2 found a runner that could exit 0 over failing tests. Phase 3 inherits the fix and the canary that proves the exit status can still carry a refusal.
3. **A check only ever asked where it passes.** Phase 2's release gate failed three times the first time it ran on a clean runner and inside an extracted archive, and none of the three was a product defect. Every Phase 3 gate is run from a fresh clone before it is believed.
4. **A tolerance.** Any non-zero tolerance in PM-16, PM-26 or PM-27 would be the place real divergence hides. The `10^-10` failures are exactly the size a tolerance would be written to absorb.
5. **A retry where a lock order belongs.** See PM-03.
