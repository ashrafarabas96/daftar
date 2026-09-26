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

**Preventive invariant** (P3-AL-01, P3-AL-49 §A). `stock_levels.valuation_base_minor` is cached as an **exact addition of stored movement integers**; the average is derived from it and never reconstructs it. The average may still be the locked costing input that prices a future outbound movement (P3-AL-49 §B) — what is forbidden by name, everywhere, is deriving a key's **current total** valuation as `on_hand × avg`: command, rebuild, report, reconciliation, read model.

**Detection.** P3-AL-43's **second** comparison, `Σ movements = Σ stock_levels.valuation_base_minor` at zero tolerance, which exists specifically to observe this failure rather than assume its absence; plus a static guard over the inventory package and migration SQL forbidding the multiplication.

**Test.** Vectors F and G of P3-AL-49 §D: receive 3 at a total of `10`, issue 1, issue 1, issue the last — stored values `+10, −3, −4, −3`, cache `10 → 7 → 3 → 0`, and a rebuild identical to the live cache at every step. The same test with the forbidden `on_hand × avg` substituted **must fail**, and is kept as the negative control.

**Failure mode without it.** A loss at every step that compounds in one direction: after enough movements the inventory asset and the GL disagree by a visible amount, with no single wrong transaction to point at.

**Recovery.** Alert and refuse; fix the multiplying path; **then** rebuild from movements. Rebuilding first destroys the only evidence of which path was wrong.

---

## PM-27 — Empty stock still carries value

**Preventive invariant** (P3-AL-49 §C). An outbound movement that empties a key does not price at the rounded average: its `value_delta_base_minor` is defined as the exact negation of the remaining cached valuation. The invariant `on_hand = 0 ⇒ valuation_base_minor = 0` is asserted inside the command, under the lock, before COMMIT, for every key the command touched. A zero-quantity key keeps its average as a **cost reference** only.

**Detection.** `SELECT … WHERE on_hand = 0 AND valuation_base_minor <> 0` — a query that must return zero rows, run by reconciliation and asserted by the command itself before `COMMIT`.

**Test.** Vector G of P3-AL-49 §D: a key whose average does not terminate is emptied and its `valuation_base_minor` is exactly `0`; and over the whole receive-then-deplete cycle total outbound equals total inbound to the minor unit (`3 + 4 + 3 = 10`). A variant that prices the last movement at `HALF_EVEN(qty × avg)` instead of the flush is kept as the negative control.

**Failure mode without it.** Phantom asset value (or phantom negative value) on an empty key that no future movement clears, that the balance sheet carries forever, and that makes the zero-tolerance reconciliation permanently red — inviting a tolerance, which is the real damage. Over a full cycle it also means COGS did not equal the cost actually received.

**Recovery.** Investigate, then rebuild the affected keys from movements. **Never** write a plug entry: the flush is the fix, a plug is a second wrong number.

---

## PM-28 — A non-posting command mints a fake assertion or splits the commit

**Preventive invariant** (P3-AL-32, P3-AL-33, renamed in Round 5). Two typed seams. `withBusinessInventoryTransaction` exposes **no** posting capability and requires **no accounting** assertion, so a transfer neither mints one nor needs one — it carries only the **inventory** assertion every inventory mutation needs (P3-AL-55). `withBusinessInventoryAccountingTransaction` is the only way to obtain posting capability. The distinction is a type; `skipAccounting`, `requiresAccounting: false` and `trusted: true` are forbidden by name in any spelling.

**Detection.** The capability case of the seam matrix (no posting port reachable from the non-posting handle, at compile time and at runtime); an assertion-minting counter asserted to be zero across a transfer; and the existing guard set, which discovers journal writers from the schema.

**Test.** The six-case seam matrix of P3-AL-32: transfer through the non-posting seam creates the movement pair, audit and outbox in one commit, mints **no accounting** assertion (and consumes exactly one inventory assertion), and leaves **zero** journal entries — counted before and after, not assumed. A mismatched scope/assertion refuses before any domain row exists.

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

## PM-31 — Every posting rounds correctly and the reconciliation still fails

**Preventive invariant** (P3-AL-49 §A, P3-AL-43). A movement's financial value is an **integer number of base minor units** and the Inventory journal line **is that same integer**, so there is exactly one rounding in the whole system and it happens at the movement. The reconciliation therefore performs **no rounding at any aggregation level** — it compares `BIGINT` sums of stored integers. The withdrawn rule ("sum the business's valuation in `NUMERIC(28,10)`, then convert once") is forbidden by name.

**Detection.** The two zero-tolerance integer comparisons of P3-AL-43 (`Σ movements = GL(1200)` and `Σ movements = Σ cache`); plus a guard that fails the build if any inventory path converts a valuation a second time, and an assertion that **no inventory posting carries a `6100 Rounding Adjustment` line** — a residue on an inventory leg means a second conversion happened.

**Test.** Vectors B and C of P3-AL-49 §D, kept as permanent negative controls: two operations whose exact computed values are `+0.6` each give the GL `2`, while rounding their aggregate gives `1`; two of `+0.4` each give the GL `0`, while rounding their aggregate gives `1`. Measured on PostgreSQL 16, so the numbers in the test are the numbers the database produces. The suite asserts both that the model gives `2 = 2` and `0 = 0`, and that the withdrawn aggregate-rounding query would have disagreed.

**Failure mode without it.** Every command is locally correct, every reviewer reads the document and agrees, and the nightly reconciliation is red with a difference nobody can attribute to a transaction — the exact condition under which someone proposes "a small tolerance", which permanently blinds the check that exists to catch real corruption.

**Recovery.** None is needed for the ledger, which was never wrong: the movements and the journal always agreed. Correct the reconciliation's write-side contract, re-run it, and **never** add a tolerance — a difference that a tolerance would absorb is the same size as the corruption it would hide.

---

## PM-32 — One source line, two movements, and a binding that cannot reference either

**Preventive invariant** (P3-AL-51 §A). `stock_source_bindings` is **movement-grained**: its primary key is the same five-part tuple `stock_movements` declares `UNIQUE`, so both directional FKs are ordinary composite foreign keys against declared unique keys, `DEFERRABLE INITIALLY DEFERRED`. A transfer line gets two bindings, one per leg.

**Detection.** Not a runtime detector — a **schema** property. The migration that creates the tables asserts against `pg_constraint` that both FKs exist, are deferrable, and reference the five-part keys; and the transfer vector (P3-AL-51 §E) exercises the cardinality end to end.

**Test.** One transfer line commits with exactly two bindings and two movements; a third binding for the same line and kind is refused by the primary key; each directional FK is shown to refuse its missing counterpart at `COMMIT`.

**Failure mode without it.** The line-grained draft's reverse FK is **not creatable at all**, because the four-part movement tuple is deliberately not unique. The implementer discovers this in P3-S2 with the schema half-written, and the likely repairs are all bad: drop the reverse FK and keep the promise only in prose, make the transfer one movement and lose the two-warehouse truth, or give the two legs different source line ids and lose the fact that they are one line.

**Recovery.** Not applicable if prevented; the defect is caught before any data exists, which is the point of settling it in P3-S0.

---

## PM-33 — A movement and its binding exist for a source line that never existed

**Preventive invariant** (P3-AL-51 §B). For each registered source type there is a **bridge table carrying a real FK to the domain source line** and a real FK to the generic binding, plus a `DEFERRABLE INITIALLY DEFERRED` constraint trigger installed **on `stock_source_bindings` itself** requiring the bridge row at `COMMIT`. The chain `movement ⇄ binding → bridge → real source line` is closed by ordinary constraints in every link. Every migration that registers a source type asserts, from `pg_trigger` and `pg_constraint`, that no registered type lacks its bridge or its trigger.

**Detection.** An anti-join of bindings against their bridges, and of bridges against their source lines — both must return zero rows. These confirm the constraints were not disabled; the constraints are the prevention.

**Test.** A trusted command is made to write a movement and a binding for a `source_id`/`source_line_id` that does not exist: the transaction **fails at `COMMIT`**. The same test is repeated for each registered source type, since each has its own bridge and trigger.

**Failure mode without it.** A source-side completeness trigger **never fires when there is no source row** — that is the whole defect. A fake pair commits, inventory exists that no document explains, and the architecture's own claim that this is impossible is what stops anyone from looking for it. An `ON DELETE RESTRICT` FK from the generic binding to a polymorphic source line cannot exist, so the first draft's deletion-protection claim was also unkeepable.

**Recovery.** The movement ledger is operational truth, so a missing source is an investigation, never a synthesized document. A genuinely orphaned movement is corrected by an explicit adjustment with its own source identity; movements are never deleted.

---

## PM-34 — P3-S1 proves an atomicity it cannot honestly reach

**Preventive invariant** (P3-AL-32 seam matrix, `PHASE_3_EXECUTION_PLAN.md` P3-S1). P3-S1 owns the **transaction primitive only**, and its nine proofs use existing accepted Phase 2 primitives and **test-owned fixture tables**. The real end-to-end proofs are assigned by name to **P3-S3** (transfer, adjustment, damage, stocktake, opening) and **P3-S4** (purchase receipt). The plan states that P3-S1 creates no production transfer, purchase or stock table.

**Detection.** Slice review, plus the migration manifest: a P3-S1 migration that creates `stock_movements`, `inventory_transfer_lines` or `purchase_items` is visible in the diff and is a slice-scope violation, not a judgement call.

**Test.** P3-S1's proof 8 — a failure injected after an **accepted Phase 2 posting** rolls back both the posting and a companion fixture mutation — demonstrates the seam's real property with no Phase 3 entity in existence. That test is the evidence that the re-scope lost nothing.

**Failure mode without it.** One of three, all bad: future slices implemented early inside S1 so the slice boundary stops meaning anything; production tables created by a slice that does not own them and will not be reviewed for them; or tests written against stand-ins that pass while proving nothing about the path that will actually run. The third is the worst, because it produces a green gate.

**Recovery.** Not applicable if prevented. If it is discovered after the fact, the entities move to their owning slice and the tests are rewritten there — a green suite from stand-ins is deleted rather than kept "for coverage".

---

## PM-35 — Manager silently becomes a stock and purchasing authority

**Preventive invariant** (P3-AL-38). One contract, in the lock: Owner all eleven; **Manager exactly `inventory.view`, `purchases.view`, `suppliers.view`**; Cashier none; existing custom roles untouched. The execution plan states the same thing, and the earlier "seeded to the owner system role only" / "no non-owner role gained one" wording is withdrawn by name.

**Detection.** Five migration assertions, run in the migration's own transaction: owner completeness; manager set equality **restricted to the Phase 3 keys** (`manager ∩ PHASE_3_KEYS` exactly the three ordinary ones); **no non-owner role of any kind holds any of the eight sensitive keys**, expressed over the sensitivity column rather than a copied list; every pre-existing custom role's permission set byte-identical before and after; and — added in Round 3 — **manager preservation**, the Manager's seventeen accepted Phase 1 keys byte-identical before and after, which is the assertion that catches an implementation that replaces the whole set with three rows instead of appending three. All five are re-run against a business provisioned **after** the migration (PM-38).

**Test.** After the migration, a manager can read stock, purchases and suppliers and is refused `inventory.adjust`, `inventory.transfer`, `inventory.stocktake`, `purchases.manage`, `purchases.receive`, `purchases.return`, `suppliers.manage` and `suppliers.pay` — each refusal asserted individually, not as a group.

**Failure mode without it.** Two documents disagreed, so the implementer picked. Picking the plan's wording would have left managers unable to see inventory at all, which is visible immediately and gets fixed. Picking a relaxed reading of it — "managers should obviously be able to work" — could have granted a sensitive key to every manager in every business in production, in a migration, silently. The dangerous branch is the one that looks helpful.

**Recovery.** Revoke the wrongly granted permission from the role and audit what was done with it, since an authority grant is not undone by removing it. The audit trail carries every stock and purchase command with its actor, which is why the revocation can be scoped rather than guessed.

---

## PM-36 — A warehouse created after P3-S1 is unreachable, or reachable by the wrong people

**What goes wrong.** The migration backfills `branch_warehouses` from `warehouses.branch_id` and everything looks correct on day one. Tomorrow a merchant adds a branch, or a new business is onboarded, and the warehouse created by that flow has no association row. Every assigned-scope actor is refused on it, including the person who just created it. The merchant sees a warehouse in one list and "outside your assigned scope" in the next, with no way to act on either.

**Preventive invariant** (P3-AL-15 §A). Every `warehouses` row must have its home association `(business_id, branch_id, id)` in `branch_warehouses` while it exists, whatever its status. Four schema objects hold it: a non-deferred `AFTER INSERT` maintainer that writes the home row for **every** writer; a deferred constraint trigger `warehouses_require_home_branch` that refuses the commit if the row is missing anyway; `branch_warehouses_keep_home`, which refuses removal of a home row while its warehouse exists; and a `BEFORE UPDATE` refusal of any change to `warehouses.branch_id`.

**Why it cannot be a service rule.** There are **three** warehouse writers and the third — `provision_create_business` at `0033_provisioner_atomic_authority.sql:160–164` — is a `SECURITY DEFINER` routine inside a **frozen** migration that runs during onboarding, before any Phase 3 service code is on the call path. Every business ever created runs it. A rule that lives in `StructureService` would therefore be violated by the first warehouse of every new business, and the violation would look like a permissions bug, not like a missing row.

**Detection.** P3-S1's warehouse matrix rows A–D and K: the pre-migration warehouse ends with exactly its home association; `createBranch()`, `createWarehouse()` and the provisioning flow each commit the association atomically; and row **D** removes the maintainer inside the test transaction to prove the completeness trigger actually refuses the commit — without D, objects 1 and 2 are indistinguishable from object 1 alone.

**Failure mode without it.** Silent and delayed. Nothing fails at migration time; the first symptom arrives days later, in one business, as an authorization complaint. The natural "fix" under pressure is to widen the authority rule — to fall back to `warehouses.branch_id` when no association exists — which reintroduces the single-branch model the association table was created to replace, and does it in the authorization path.

**Recovery.** Insert the missing home rows from `warehouses.branch_id` (the backfill statement, re-run — it is idempotent), then install the four objects. No stock truth is damaged, because authority governs who may act, not what was recorded.

---

## PM-37 — A product's unit changes after it has history, and every past quantity means something else

**What goes wrong.** A product is sold by `piece` for a year, accumulating thousands of movements. Someone edits it to `kg`, or widens `unit_decimals` from `0` to `3`. Not one row is modified. `on_hand` is unchanged. Every report still balances. And every historical `qty_delta` now describes a different physical fact, because `stock_movements` stores the number and takes its meaning from the product's current canonical unit (P3-AL-11 deliberately does not snapshot the unit).

**Preventive invariant** (P3-AL-05 §D). From the first stock movement of any variant of the product onward, `products.unit_code` and `products.unit_decimals` are immutable forever. Current stock reaching zero does not unlock them. Disabling tracking does not unlock them. Re-enabling reuses the historical unit and offers no choice. `products.unit`, the free-text label, stays changeable because inventory never reads it.

**Mechanism and its slice.** A `BEFORE UPDATE ON products` trigger refusing the change when any movement exists for any variant, raising `inventory.unit_identity_locked`. **P3-S1** creates the columns, the configuration command and the command-level refusal; **P3-S2** installs the physical trigger, because a trigger body cannot reference `stock_movements` before that table exists. The window between them is empty rather than merely short — with no movements table, no product has history — and it closes before P3-S3, the first slice authorized to produce a real movement.

**Detection.** The eight-row unit matrix in P3-AL-05 §D. Rows 3 and 4 attempt the change through the command **and** as raw SQL; row 5 is the zero-stock case, which is the one a reasonable person would allow; rows 6 and 8 cover re-enablement and a later registry default change.

**Failure mode without it.** Unrecoverable in principle. Once a year of movements is ambiguous, no one can tell which rows were written under which unit, because nothing recorded it. Valuation, reorder points, stocktake variances and every historical report become unfalsifiable at once, and the corruption is invisible until someone counts a shelf.

**Recovery.** There is none by computation. The unit must be restored from whatever external record exists, and every quantity written after the change re-examined by hand. This is why the guard is physical and installed before the first real producer, rather than left to the configuration screen.

---

## PM-38 — The hidden base variant becomes visible, or two populations of businesses diverge

Two execution-level failures with one shape: a Phase 3 change that is correct in the lock and wrong in the system that already exists.

**A — the base variant appears in the catalog.** `CatalogService.getProduct()` returns every non-archived row of `product_variants` and knows nothing about `is_base` (`apps/api/src/modules/catalog/catalog.service.ts:148`). Adding the column without changing that read would turn every simple product into a one-variant product the moment its merchant enables inventory — a visible regression in the oldest screen in the app, caused by a feature they did not ask for. **Preventive invariant** (P3-AL-52): every merchant-facing variant read excludes `is_base = true`, a `CHECK` keeps a base variant's `sku`, `barcode`, `price_minor` and `attributes` empty so it cannot become merchant-like even if a read is forgotten, and a trigger admits writes to it only as `daftar_inventory_internal`. **Detection:** eight proofs in P3-AL-52, including the accepted golden catalog fixtures, which must render identically after enablement.

**B — new businesses get different authority from old ones.** The migration backfills roles; onboarding seeds from `BUILTIN_ROLE_PERMISSIONS` (`packages/domain-core/src/permissions.ts:96–118`) through `provision_create_business`. Evolving only one of the two produces two populations that diverge from the day P3-S1 ships and never converge, and the difference is invisible until a manager in a young business cannot see inventory that a manager in an old one can. **Preventive invariant** (P3-AL-53): the registry and the migration change in the same commit, and acceptance **provisions a real business after the migration** and reads the persisted rows — asserting the constant against itself proves nothing about the frozen routine that actually writes them. **Detection:** the five P3-AL-38 assertions re-run against the new business, plus a direct comparison of the two populations' Phase 3 permission sets per system role key.

**Failure mode without either.** Both are quiet. A leaked variant is reported as a UI bug and worked around; a permission divergence is reported as "it works for my colleague". Neither is ever traced back to the migration that caused it.

**Recovery.** A: exclude the row from the reads and re-issue; nothing is corrupted, because the base variant was correct all along, only visible. B: run the backfill against the businesses created in the gap — idempotent, and the audit trail shows exactly which businesses were provisioned between the two deployments.

---

## PM-39 — An ordinary catalog `UPDATE` changes a product's canonical unit without `inventory.adjust`

**What goes wrong.** P3-S1 adds `unit_code` and `unit_decimals` to `products`. `daftar_app` already holds table-level `UPDATE` on `products` (`0006_rls.sql:77–78`), and a table-level privilege covers columns added later. A catalog edit, a scripted fix, or a stolen application credential runs `UPDATE products SET unit_code = 'kg'` on a tracked product with no history. No permission is checked, because the only check lives in the inventory command the statement never went through.

**Preventive invariant** (P3-AL-54 §F). `products_10_inventory_config_authority`, a `BEFORE INSERT OR UPDATE` trigger with **invoker** rights, refuses any change to `track_inventory`, `unit_code` or `unit_decimals` unless `current_user = 'daftar_inventory_internal'`. The only way to be that principal is to call `inventory_configure_product`, whose only `EXECUTE` grantee is `daftar_app` — and, since Round 5, whose first act is to consume an `invctl/1` assertion that the merchant API mints only after `inventory.adjust` passes, bound to this exact payload (P3-AL-55; the direct-call attack is PM-44). Once history exists, `products_20_unit_history_lock` (P3-S2) refuses it for every writer, the routine included.

**Detection.** The live grant matrix (P3-AL-54 §H), read from the catalogues; the migration's own `pg_trigger` assertion that both guards exist by name on `products`; and the static check that `products_10_inventory_config_authority` has `prosecdef = false`.

**Test.** Raw SQL as `daftar_app`: `UPDATE products SET unit_code = …` and `SET unit_decimals = …` each refused with `inventory.configuration_authority_required`; the same statement setting price, category, SKU, barcode or `products.unit` succeeds; `inventory_configure_product` called by a member without `inventory.adjust` is refused by the application before the routine runs. The test is shown to fail when the trigger is dropped.

**Failure mode without it.** Before history exists the damage is a unit chosen by the wrong person; after P3-S2 the history lock still holds, so the window is exactly the products with no movement yet. But the same hole is PM-40's, and the two together mean inventory configuration is only as protected as the least careful caller of a catalog `UPDATE`.

**Recovery.** Restore the three columns from the product's last inventory-configuration audit event (the routine's caller writes one; a raw `UPDATE` writes none, which is itself the finding) before any movement is recorded; if a movement exists, PM-37's recovery applies.

---

## PM-40 — An ordinary catalog `UPDATE` turns inventory tracking on, with no base variant and no unit decision

**What goes wrong.** The same table-level `UPDATE`, aimed at `track_inventory`. `UPDATE products SET track_inventory = true, unit_code = 'piece', unit_decimals = 0` satisfies the P3-AL-04 `CHECK`, because the `CHECK` proves a unit **exists**, not that anyone was **authorized** to choose it. No base variant is created, so a simple product is tracked with no stock identity; the first stock command then either invents the base variant in the wrong place or refuses a product the screen says is tracked.

**Preventive invariant** (P3-AL-54 §E–§F). Tracking is enabled by one named routine, `inventory_configure_product`, owned by `daftar_inventory_internal`, which also creates the base variant idempotently, and which runs only after consuming an `inventory.configure_product` assertion (P3-AL-55, PM-44). The authority guard refuses `track_inventory` changes by anyone else, on `INSERT` as well as `UPDATE`, so a new product cannot be *born* tracked by raw DML either. The `CHECK` stays exactly as written; it is not asked to prove authorization.

**Detection.** Same guard, same catalogue assertions as PM-39; plus a data invariant queried by P3-S1's acceptance and kept in the rebuild checks: every product with `track_inventory = true` and no merchant variant has exactly one `is_base = true` variant.

**Test.** Raw `INSERT … track_inventory = true` and raw `UPDATE … SET track_inventory = true` as `daftar_app`, each refused with `inventory.configuration_authority_required`; enablement through the command after `inventory.adjust` produces exactly one base variant, and a second enablement produces no second one.

**Failure mode without it.** A tracked product with no stock identity, created by a path that recorded no inventory decision. Nothing fails until the first stock movement, which is the worst place to discover that the configuration step never ran.

**Recovery.** Set `track_inventory` back to false through the routine for the affected products (none can have movements, since no stock identity existed), then enable them properly.

---

## PM-41 — Onboarding creates the first warehouse, but the maintainer has no authority to write its association

**What goes wrong.** The home-association maintainer (P3-AL-15 §A) is written as an ordinary invoker-rights trigger. The two Structure paths run as `daftar_app`, so someone grants `daftar_app` `INSERT` on `branch_warehouses` and they pass. The third writer, frozen `provision_create_business`, is owned by and runs as **`daftar_platform`** (`0033_provisioner_atomic_authority.sql:308`). Its first `INSERT INTO warehouses` fires the maintainer as the platform, which has no privilege on `branch_warehouses`; onboarding fails for **every new business**. The obvious hot-fix is `GRANT INSERT ON branch_warehouses TO daftar_platform` — handing the platform principal write authority over inventory authorization, permanently, to fix one trigger.

**Preventive invariant** (P3-AL-54 §I). The maintainer, the completeness proof and the keep-one trigger are `SECURITY DEFINER`, owned by `daftar_inventory_internal`, which alone holds `INSERT, DELETE` on `branch_warehouses`. RLS admits the maintainer by exactly the predicate that admitted the warehouse row it derives from — `app_business()` for Structure, `app_bypass()` during onboarding — with no new policy. Neither `daftar_platform` nor `daftar_provisioner` receives any privilege on the table, and the live grant matrix asserts that.

**Detection.** Warehouse matrix row B/C through writer 3 (a business provisioned after the migration has its `'Main warehouse'` home association); row L (the maintainer forced to fail inside `provision_create_business` rolls back the whole onboarding); and the §H assertion that `daftar_platform` and `daftar_provisioner` have zero privileges on `branch_warehouses`.

**Test.** Provision a business through the accepted flow on a database built by the non-superuser migrator (PM-43) — not only on the superuser CI build, where a missing grant never shows — and read the persisted association; then repeat with the maintainer replaced by one that raises, and assert that no tenant, business, branch or warehouse row survives.

**Failure mode without it.** Either onboarding breaks for every new customer on the day P3-S1 ships, or it is repaired by a grant that quietly makes the platform an inventory authority. The second is worse, because it works.

**Recovery.** Replace the maintainer with the definer-rights shape and revoke any grant added to the platform or the provisioner; businesses that failed onboarding were rolled back atomically and can simply retry.

---

## PM-42 — A runtime role becomes a member of `daftar_inventory_internal`

**What goes wrong.** A migration that must replace a function the internal role already owns fails as the non-superuser migrator — `CREATE OR REPLACE` is an ownership check and ignores `SET` (the RB-P2-01 finding for `0038`, `bootstrap.sql:218–230`). The quick fix is `GRANT daftar_inventory_internal TO daftar_app`, or flipping the migrator's membership to `INHERIT TRUE`. The first makes every application connection able to `SET ROLE` into the principal the column guards trust, and the guards then admit raw DML from the application; the second gives the deployment credential passive inventory authority.

**Preventive invariant** (P3-AL-54 §C, §J). The role's only member is `daftar_migrator`, `INHERIT FALSE, SET TRUE`, granted in `bootstrap.sql`. A later replacement runs inside `SET LOCAL ROLE daftar_inventory_internal … RESET ROLE` (`0040:411–466`), never by changing the membership. The role is `NOLOGIN` with no password, so no credential for it can exist.

**Detection.** Every Phase 3 migration re-asserts from `pg_auth_members` that the role's member set is exactly `{daftar_migrator}` with `inherit_option = false` (prefix `inventory.authority_leak`), and refuses to commit otherwise; the P3-S1 live membership test asserts, transitively (`pg_has_role(r, 'daftar_inventory_internal', 'MEMBER')` for every runtime role), that runtime membership is **zero**; `scripts/phase2-deployment-authority.ts` checks the migrator's membership shape.

**Test.** For each of `daftar_app`, `daftar_platform`, `daftar_worker`, `daftar_provisioner`, `daftar_identity`, `daftar_resolver`, `daftar_reconciler`: `pg_has_role(…, 'MEMBER')` and `pg_has_role(…, 'USAGE')` are false, and `SET ROLE daftar_inventory_internal` as that role fails. A negative control grants the membership in the test transaction and shows the assertion turn red.

**Failure mode without it.** Every physical guard in P3-AL-54 reduces to a convention: a guard that trusts `current_user = 'daftar_inventory_internal'` is exactly as strong as the set of principals able to become it.

**Recovery.** Revoke the membership, rotate the application credential if it could have been used, and review the audit trail and the three configuration columns for changes not preceded by an inventory configuration audit event.

---

## PM-43 — An inventory `SECURITY DEFINER` routine can be hijacked, or is owned by a role that can log in

**What goes wrong.** A Phase 3 routine is written `SECURITY DEFINER` without `SET search_path`, or with a path that omits `pg_temp`. PostgreSQL then searches `pg_temp` **first**, so any caller able to create a temporary object can shadow an unqualified name the routine uses and run their own code as the owner — the exact attack `tests/security/search-path-shadowing.test.ts` reproduced against the journal before P2-S3. Or the routine's owner is left as `daftar_migrator` (a `LOGIN` role) because the ownership transfer failed as a non-superuser and someone removed it to get green, so compromising a deployment credential now compromises every inventory routine too.

**Preventive invariant** (P3-AL-54 §D). Every function owned by `daftar_inventory_internal` is `SECURITY DEFINER` with `SET search_path = pg_catalog, public, pg_temp`; `EXECUTE` is revoked from `PUBLIC` and granted only per §H; the owner is `NOLOGIN`; no runtime role holds `TEMPORARY` or `CREATE` on `public`; no dynamic SQL is built from caller input. The two column guards are the only intended `SECURITY INVOKER` exceptions and are named.

**Detection.** A **catalogue-discovered** check — every `pg_proc` row owned by the internal role, not a hand-written list — added to the shadowing test and to the permanent static guards: `prosecdef = true`, `proconfig` contains a `search_path` ending in `pg_temp`, no `PUBLIC` `EXECUTE`, owner `rolcanlogin = false`. A second check asserts that every Phase 3 routine the lock names has that owner, so a routine left owned by the migrator is caught by name.

**Test.** The shadowing attack re-run against each inventory routine as `daftar_app` with `TEMPORARY` granted in the test transaction, proving the routine resolves the real object; a negative control removes `pg_temp` from one routine's path and shows the check turn red.

**Failure mode without it.** A single forgotten `SET` clause turns a narrow routine into a general-purpose privilege escalation for any caller who can create a temporary table, and it is invisible in review because the routine's body is correct.

**Recovery.** `ALTER FUNCTION … SET search_path = pg_catalog, public, pg_temp` and `ALTER FUNCTION … OWNER TO daftar_inventory_internal` in a new migration (under `SET LOCAL ROLE` per PM-42), then review writes made through the routine since it shipped.

---

## PM-44 — Direct `EXECUTE` bypasses the application permission check

**What goes wrong.** The attacker holds the `daftar_app` database credential — leaked from a configuration file, a backup, a CI log or a compromised sidecar — but not the merchant-api process. They know a victim tenant, business and product UUID, and an owner's user UUID, from any support screenshot. They open a session, `set_config('app.tenant_id', …)`, `set_config('app.business_id', …)` and `set_config('app.actor_user_id', <owner>)`, and call `inventory_configure_product(<product>, true, 'kg', 3)` directly. The routine runs as `daftar_inventory_internal`, so the column guard admits it, and `inventory.adjust` — checked only in the application — was never asked. **Second variant:** the same session calls `structure_associate_warehouse_branch(<central warehouse>, <their own branch>)`, skipping `warehouse.manage` and the all-scope rule, and widens the warehouse authority of an assigned-scope account they also control. This is not an application bug: the stolen credential is explicitly in scope, and the application is never involved.

**Preventive invariant** (P3-AL-55). `EXECUTE` is reachability, not authority. Each routine's first statement consumes an `invctl/1` assertion from `app.inventory_assertion`: HMAC-SHA-256 under a key in `inventory_assertion_keys`, which no runtime role can read; operation kind equal to the routine's own; payload digest recomputed from the routine's **own arguments** (`invpl/1`); business owned by the tenant; `app.tenant_id` / `app.business_id` equal to the signed claims; `jti` not yet consumed. Actor, tenant and business come from the verified record, never from a GUC. No assertion, no mutation.

**Detection.** The P3-S1 acceptance matrix rows B–K run as `daftar_app` over a raw connection with no application in the path; the catalogue assertion that no runtime role holds any privilege on `inventory_assertion_keys`; and a static guard that every function owned by `daftar_inventory_internal` which writes a guarded column, a base variant, `branch_warehouses` or (from P3-S2) a stock table calls `inventory_assertion_consume` or `inventory_assertion_current` as its first statement — writers discovered from the catalogue, not named.

**Test.** Both variants above, verbatim: raw connection as `daftar_app`, victim GUCs set, owner UUID as actor, no assertion → `inventory.assertion_missing`; a forged, expired, wrong-kind, wrong-payload or replayed assertion → its own refusal code; the product row, the variant table and `branch_warehouses` byte-identical before and after. **Negative control:** a test build whose routine skips `inventory_assertion_consume` lets both attacks succeed, and the test turns red — proving the test models the attack rather than the happy path.

**Failure mode without it.** A credential that could never touch inventory configuration or warehouse authority gains both through three `GRANT EXECUTE` lines, and every column guard of Round 4 reduces to "whoever can call the routine". The audit trail would name the owner the attacker chose.

**Recovery.** Rotate the `daftar_app` credential; compare the configuration columns and `branch_warehouses` against the routine-written audit rows — a change with no such row did not come through a verified command; revert unauthorized configuration on products without history (PM-39) and remove unauthorized associations through the authorized command.

---

## PM-45 — One signed assertion is stretched: another payload, another operation, another transaction

**What goes wrong.** An attacker who can observe traffic between the API and the database, or a defect that logs `app.inventory_assertion`, captures a valid assertion. They present it again: for a different product, for `unit_decimals = 4` instead of `0`, for warehouse A with branch C instead of B, to the dissociate routine instead of the associate one, or in a second transaction thirty seconds later.

**Preventive invariant** (P3-AL-55 §D–§H). Every claim and the payload digest are under the MAC. The digest covers `op_code`, tenant, business and every argument in a fixed order with a fixed encoding, so any change to any argument changes the digest (`inventory.assertion_payload_mismatch`); associate and dissociate never share a digest because `op_code` is in the stream. Each routine accepts exactly one `op_code` (`inventory.assertion_wrong_operation`). Consumption is strict: one assertion, one entry-routine call; a second presentation in any transaction is `inventory.assertion_replayed`. Life is 60 seconds, and the database refuses an expiry more than 65 seconds ahead.

**Detection.** The P3-S1 matrix rows D–I and K; the `invpl/1` shared vectors, asserted byte-for-byte in TypeScript and SQL, including NULL fields and associate/dissociate over identical ids.

**Test.** For each field of each P3-S1 kind, a genuine assertion presented with that one field altered → refused. A genuine association assertion presented to the configuration routine and to the dissociation routine → refused. A committed use followed by a second transaction → refused; a second call in the **same** transaction → refused; a rolled-back first use followed by a retry of the identical payload within the TTL → accepted, and the test says why that is a retry, not a replay.

**Failure mode without it.** A signature over the actor alone — the shape of the provisioning assertion before it bound its kind — would authorize "this actor may do something", and the attacker chooses what.

**Recovery.** Retire the `kid` (terminal), install a new one, redeploy the merchant API; find the logging defect that exposed the carrier. Assertions minted under the retired key stop verifying immediately.

---

## PM-46 — The inventory key domain collapses into another one

**What goes wrong.** To save a deployment variable, an operator sets `INVENTORY_ASSERTION_KEY` to the same secret as `ACCOUNTING_ASSERTION_KEY`, perhaps re-encoded so the strings differ. Or a later migration grants `SELECT` on `inventory_assertion_keys` to `daftar_platform` "so the admin screen can show which keys are active". Or the platform process is given the signing key so a support tool can reconfigure products. Each turns a compromise of one authority into a compromise of another: a leaked accounting key would mint inventory commands, a stolen platform credential would read the inventory secret.

**Preventive invariant** (P3-AL-55 §C–§D). Three secrets, three tables, three preimage languages. Production config fails closed when the **decoded bytes** of the inventory key equal the provisioning or accounting key's, and the minter repeats the comparison in constant time wherever the key is loaded. `INVENTORY_ASSERTION_KEY` is forbidden in the platform, worker and reconciler modes. No runtime role holds any privilege on `inventory_assertion_keys`; the platform can only `EXECUTE` install and retire, which never return key material. The `invctl/1` preimage begins with bytes no other protocol's preimage can begin with, so even an accidentally shared key could not turn an accounting or provisioning signature into an inventory one.

**Detection.** Config tests over every mode, including two different base64 spellings of one secret; the live grant matrix over `inventory_assertion_keys` for all seven runtime roles; a cross-protocol test presenting a genuine `acctctl/1` and a genuine posting assertion, re-signed under the inventory key where the test controls it, to an inventory routine.

**Test.** `config.ts` refuses production start with equal decoded secrets for each pair; each runtime role's `SELECT` on `inventory_assertion_keys` fails with `42501`; `daftar_platform` installs and retires a key and cannot read it back by any path; cross-protocol substitution is refused with `inventory.assertion_malformed` or `inventory.assertion_invalid_signature`.

**Failure mode without it.** Blast-radius separation exists only in the variable names, and the first leak of any one key is a leak of all of them.

**Recovery.** Generate three fresh, distinct secrets; install each under a new `kid`; redeploy; retire the old `kid`s; review the routine-written audit rows of the exposure window.

---

## Cross-cutting — what would make this premortem worthless

1. **A test that only ever passes.** Every invariant above is proved by a test that is shown to FAIL when the invariant is removed. A green suite that never modelled the attack proves nothing about the attack.
2. **A gate that cannot say no.** Phase 2 found a runner that could exit 0 over failing tests. Phase 3 inherits the fix and the canary that proves the exit status can still carry a refusal.
3. **A check only ever asked where it passes.** Phase 2's release gate failed three times the first time it ran on a clean runner and inside an extracted archive, and none of the three was a product defect. Every Phase 3 gate is run from a fresh clone before it is believed.
4. **A tolerance.** Any non-zero tolerance in PM-16, PM-26, PM-27 or PM-31 would be the place real divergence hides. Those failures are exactly the size a tolerance would be written to absorb, which is why the model removes the second rounding instead of widening the comparison.
5. **A retry where a lock order belongs.** See PM-03.
