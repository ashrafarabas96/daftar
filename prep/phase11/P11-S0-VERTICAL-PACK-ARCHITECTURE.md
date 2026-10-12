# P11-S0 — PHASE 11 VERTICAL-PACK ARCHITECTURE (Apparel · Electronics · Repair · Lot/Expiry)

**status** `PREPARED / NOT PROMOTED`, and as of the 2026-10-12 Master Continuous Mission **moving from design into build**: that directive's §18 says in terms that the preparation is mostly design, that merging design is not enough, and that building starts now along the cheapest independent end-to-end path — **apparel** — by its owners, with traceability and repair review continuing in parallel. Promotion order is unchanged. On its status ladder (`PREPARED → CHALLENGED → READY_TO_PROMOTE → PROMOTION_IN_PROGRESS → ACCEPTED / SEALED`) this phase is at **`PREPARED`**, not yet `CHALLENGED`, because no independent challenger has read it.
**third directive received and applied 2026-10-12** the MASTER CONTINUOUS ENGINEERING MISSION (Phases 4–15, 26 sections). A **consolidated superset** of the per-phase directive, not a resend: about 70% restates it, and for Phase 11 the whole of §18's first five paragraphs is confirmation. What is new is a **mandate to execute** rather than specify — see §1d. **second directive received and applied 2026-10-12** the per-phase directive (PARTs 62–71 are Phase 11's; PARTs 6, 13, 115, 116, 117, 118 are common). It is **additive**: it contradicts nothing ruled on 2026-10-08, confirms Option B and the no-money law, and adds four requirements this draft did not have — PART 67's V1 one-time full-quantity billing rule and two missing binding conditions, PART 68's blocked-subfeature scope, PART 69's canonical repair deposit, and PART 70's append-only warranty lifecycle. See §1c.
**rulings received and applied 2026-10-08** `TL-P11-R1` … `TL-P11-R7`, plus §55, §60, §62 and §63. **ADJ-P11-01 is CLOSED: Option B.** Two real defects in the first draft were returned with the ruling and are corrected here — the serial cost snapshot (§55) and the repair-part double consumption (§60). See §1b.
**authority of this document** preparation only. It allocates no migration number, creates no product code, changes no frozen artefact and claims no gate result.
**base SHA** `93084f8` — branch `phase/4-sales-pos-customers-receivables` (read 2026-10-07; `git fetch` of that branch, head `93084f8 fix(p4s1-gate): a delegator may not also compute`)
**own branch** `claude/phase11-prep-re0epv`, cut from that head. Nothing is pushed to `phase/4-sales-pos-customers-receivables` or to `main`.
**preservation push, under `TL-MASS-PRESERVE-01`:** these six documents are committed at `prep/phase11/` as `188dcb076c16035ab2db9a138b2b2c4dc84bcc2b` and fast-forwarded to `origin/claude/phase11-prep-re0epv`. Non-canonical branch, **no pull request**, no force, no rewrite, no file touched outside `prep/phase11/`. **Preservation, not promotion**, and this branch never merges itself.
**highest migration at base** `0086_phase4_rls_quals_once_per_query.sql`. `frozenThrough = 0079_phase4_pos_till_sessions_cart.sql`, so `0000`–`0079` are immutable and `0080`–`0086` are unfrozen P4-S4 candidates. Phase 11 **allocates no migration number — not allocated, not examined, not exampled, not in a filename and not in a comment** (Master Part 10 — one migration train, one Migration Owner). Every number in this document is a citation to a file that exists on disk. The DDL this phase needs is specified in `P11-MIGRATION-PATCH-REQUEST.md`, numberless. This document also makes **no timing or performance claim**: none was measured, and a number from this container would not be comparable to the authoritative box.
**roadmap scope** Phase 11 — Apparel, Electronics, Repair, Lot/Expiry Packs (Master Part 31).
**predecessors** Phase 4 is not sealed; Phases 5–10 are not started. Phase 11 therefore cannot promote. Everything here is architecture, contracts and a DDL specification.

---

## 0. The one-paragraph answer

Phase 11 is **not a new inventory system**. The core already owns the whole of quantity and value: the stock key is exactly `(business_id, warehouse_id, variant_id)` (`stock_levels` PK, `0059_inventory_stock_ledger.sql:99-111`), the ledger is the append-only `stock_movements` with the five-part movement identity `(business_id, source_type, source_id, source_line_id, movement_kind)` (`0059:129-158`), the costing law is **moving weighted average** computed inside one writer, `inventory_apply_stock_movements(inventory_movement_request[])` (`0060_inventory_stock_primitive.sql:133-148`, `SECURITY DEFINER`, owner `daftar_inventory_internal`, no `EXECUTE` grant to anybody), and `stock_levels` is a derived cache rebuildable exactly from the ledger (`inventory_stock_fold`, `0060:517-574`). Phase 11 adds three things *above* and *beside* that core and nothing *inside* it: a **catalog axis model** so apparel size/color stops being free-form JSON, two **overlays below the variant** — serial/IMEI identity and lot/expiry quantity — each of which must *reconcile to* the numbers the core already produced and may never produce its own, and one **new document**, the repair ticket, which consumes parts through the existing inventory bridge and earns its money through the existing Phase 4 sales invoice. The single hardest fact in the whole phase: **the stock key has no column below the variant**, so neither a serial nor a lot may ever become a stock key, and neither may carry a value. Conservation, not computation.

---

## 1. What the core already gives us, exactly

Read from the live tree at `93084f8`, not from documents.

| thing | where | what it means for Phase 11 |
|---|---|---|
| `product_variants (business_id, id, product_id, attributes JSONB DEFAULT '{}', sku, barcode, price_minor, status, …)`; PK `(business_id, id)` | `0005_catalog.sql:37-53` | the apparel seam. `attributes` is commented in-file as "future size/color matrix (§59) without core change" (`0005:41`). Phase 11 **canonicalizes** it; it does not relocate it. |
| `product_variants.is_base`, `product_variants_base_shape_ck`, `product_variants_one_base_uq` | `0053_inventory_units_and_product_configuration.sql:134-141` | a product always has exactly one base variant whose `attributes` must be `'{}'`. An axis model must not break that: base variants carry no axes. |
| `products.track_inventory`, `unit_code`, `unit_decimals`, `products_tracked_requires_unit_ck` | `0053:113-123` | tracking is a **product-level** switch today. Serial and lot tracking are new product-level switches of the same family and obey the same history lock. |
| `units (unit_code PK, default_decimals SMALLINT 0..4)`, `unit_names (unit_code, locale IN ('ar','en','tr'))` | `0053:66-78` | a serialized item is countable: `unit_decimals = 0` is a **precondition** of serial tracking, not a preference. |
| `stock_levels (business_id, warehouse_id, variant_id) PK`, `on_hand NUMERIC(18,4)`, `valuation_base_minor BIGINT`, `avg_unit_cost_base_minor NUMERIC(28,10)`, `last_stock_seq` | `0059:99-111` | **the stock key.** Nothing below the variant exists here, and Phase 11 does not add a column to it. |
| `stock_movements`, immutable, `stock_movements_identity_uq (business_id, source_type, source_id, source_line_id, movement_kind)` asserted non-deferrable | `0059:129-158`, `0059:579` | every overlay row hangs off `stock_movements (business_id, id)`, which is unique and never updated or deleted (`stock_ledger_append_only()`, `0059:264`). |
| registries, closed and migration-extended: `stock_movement_kinds (movement_kind, qty_sign, requires_reason, registered_by ~ '^P3-S[0-9]+$')`, `stock_source_types`, `inventory_operation_kinds (op_code ~ '^[a-z]+(\.[a-z_]+)+$')`, `inventory_operation_movement_kinds (op_code, movement_kind)` | `0059:49-71`, `0054_inventory_assertion_authority.sql:52-55` | the legal way to add a vertical. "A movement kind grants no authority: authority is the op→kind mapping" (`0059:66-71`). **`registered_by` must widen to accept a `P11-S…` tag** — see the patch request §9. |
| `stock_source_bridge_<type> (business_id, source_id, source_line_id, movement_kind, source_type GENERATED ALWAYS AS ('<type>') STORED)` with RESTRICT FKs both to the domain line and to `stock_source_bindings` | shape at `0061_inventory_movement_sources.sql:732-745`; later examples `0077_phase4_sales_sale_items_sources.sql:1238-1245` | the repair ticket's parts reach the ledger through exactly this shape and no other. |
| `inventory_stock_source_guard_gaps()` (STABLE, INVOKER) | `0059:390` | enumerates registered source types with no guard. A new source type without its bridge **reds the end-state assertion** — this is the existing protection that makes a forked source impossible to land quietly. |
| valuation: inbound at supplied cost, outbound at the key's current average, full depletion flushes the stored valuation exactly, deferred `stock_levels_zero_on_hand_zero_value` at COMMIT | `0060:349-420`, `0060:655`, installed `0060:739-742` | **moving weighted average, exact integer.** There is no lot, no layer, no FIFO and no LIFO anywhere in the inventory package. Phase 11 does not introduce one (P11-AL-07). |
| `product_variants_20_stock_identity_lock()` → `inventory.variant_stock_identity_locked` | `0060:683` | the precedent for P11-AL-16: once a variant has a `stock_levels` row, identity-shaping facts about it stop being editable. |
| RLS shape: `ENABLE` + `FORCE` always in pairs; policies `tenant_membership` (permissive), `business_isolation` restrictive, `inventory_internal_read FOR SELECT TO daftar_inventory_internal USING (true)`; the internal principal admitted on **USING only, never WITH CHECK** | `0059:300-330`, `0086_phase4_rls_quals_once_per_query.sql:346-370` | copied verbatim in the patch request. `0086` additionally wraps each helper in a scalar subselect so it evaluates once per query; new relations are written in the `0086` form from birth. |
| GRANT shape: default deny, `SELECT` only to `daftar_app` on truth tables, column-scoped `UPDATE` to the internal owner, **no** `EXECUTE` grant on internal definers, `EXECUTE` to `daftar_app` on entry routines only | `0059:372-378`, `0079:1199-1202` | unchanged for Phase 11. |
| ownership bracket per migration: `GRANT CREATE ON SCHEMA public TO daftar_inventory_internal` → create → `REVOKE ALL … FROM PUBLIC` → triggers → `ALTER FUNCTION … OWNER TO` → `REVOKE CREATE ON SCHEMA public` → end-state `DO $$ … RAISE EXCEPTION 'inventory.migration_end_state_invalid: …'` | `0060:36-46`, ruling R-P4-S3-04 quoted at `0079:151-157` | the patch request states the bracket explicitly, because S7 proved a spec that omits it cannot be applied by `daftar_migrator` (`P4-S7` H3). |
| assertion authority: `inventory_assertion_consume(TEXT,TEXT) RETURNS inventory_verified_actor` — one assertion authorizes exactly one entry-routine invocation | `0054:344` | every new Phase 11 entry routine consumes an assertion like every existing one. No new authorization mechanism. |
| capability registry: `inventory.serial-tracking`, `inventory.lot-expiry`, `catalog.variant-matrix`, all `implemented: false` | `packages/domain-core/src/capabilities.ts:26-33` | Phase 11 is the phase that flips these to `implemented: true` — **at promotion, not at preparation.** |
| industry profiles: `apparel → ['inventory.advanced','catalog.variant-matrix']`, `electronics → ['inventory.serial-tracking']`, `pharmacy → ['inventory.lot-expiry']`, advisory only, "no `if restaurant / if pharmacy` branching may appear in Core" | `packages/domain-core/src/industry-profiles.ts:27-31`, `:10-11` | the pack selection mechanism already exists and is advisory. Phase 11 adds no business-type enum and no core branch. |
| feature registry rows `('SERIAL_TRACKING','Serial/IMEI tracking (future)')`, `('LOT_EXPIRY','Lot/expiry tracking (future)')` | `0007_entitlements.sql:95-96` | present. **`VARIANT_MATRIX` and `REPAIR_PACK` are absent** — two rows the patch request asks for. |
| `catalog_identifiers (business_id, kind CHECK (kind IN ('sku','barcode')), value_norm, owner_type CHECK (owner_type IN ('product','variant')), owner_id)` PK `(business_id, kind, value_norm)`, maintained by triggers on `products`/`product_variants` | `0037_catalog_identifiers.sql:13-36` | the tempting place to put IMEI. **P11-AL-15 declines it** — see §4.3. |

| `P3-AL-46 — Lot / serial / expiry · DEFERRED BY SCOPE — Phase 11`: "the stock key is `(business_id, warehouse_id, variant_id)` and movement identity is the five-part tuple of P3-AL-09. **A future lot dimension extends the key and the tuple**; it does not require `stock_movements` to change shape or the weighted-average engine to be re-derived." | `docs/PHASE_3_ARCHITECTURE_LOCK.md:83`, `:1280-1288`; restated `docs/DAFTAR_INVENTORY_RULES.md:161` | an **accepted** architecture lock that predicts a different model from §4.2/§4.3. This is the one real contradiction of the phase; it is adjudicated in §1a, not silently overridden. |
| entitlement feature registry is an **FK target** — arbitrary keys are refused at the DB; `SERIAL_TRACKING`, `LOT_EXPIRY`, `RESTAURANT_PACK` seeded, **`VARIANT_MATRIX` and a repair key absent** | `0007_entitlements.sql:94-96`; `docs/PHASE_1_ENTITLEMENT_REVIEW.md:6` | Phase 11 needs an append-only feature-registry migration for the two missing keys |
| the capability vocabulary (`inventory.lot-expiry`, `packages/domain-core/src/capabilities.ts:26-33`) and the entitlement vocabulary (`LOT_EXPIRY`, `0007:94-96`) are **two separate namespaces with nothing mapping between them** | both files | Phase 11 must add that mapping once, in `domain-core`, or every pack screen will gate on the wrong one. See task `P11-CAP-002`. |
| `scripts/static-guards.ts:224` `no-hardcoded-plan-branching` refuses hard-coded plan-name branching outside the admin console | that line | a pack gates on a **feature key read from the entitlement** — never on `planKey === 'pro'` and never on `industry_profile_key` (which is advisory, `industry-profiles.ts:10-11`) |
| `FeatureLockedState` and `PlanLimitState` already exist as design-system surfaces | `packages/design-system/src/components/feedback.tsx:96`, `:107`; used at `apps/web/src/app/[locale]/structure/page.tsx:86,89` | a locked pack has a ready-made screen; Phase 11 invents no new "upgrade" UI |

What does **not** exist anywhere in the tree (SQL, TypeScript or docs) at `93084f8`: `lot`, `lots`, `batch`, `lot_id`, `expiry_date`, `shelf_life`, `serial_number`, `imei`, `size_code`, `color_code`, `repair_ticket`. Every `expires_at` hit is auth/session/assertion TTL; every `serial` hit is the word "serial" in "serial order" prose. So Phase 11 starts from zero structure and two reserved capability keys.

---

## 1a. ADJ-P11-01 — **RULED, Option B** (`TL-P11-R1`, 2026-10-08)

> **The ruling, verbatim:** "Choose: **OPTION B**. Lot/serial extend traceability identity. They do NOT extend authoritative costing key. Costing key remains `business + warehouse + variant`. **This explicitly narrows the future-looking Phase3 wording.** Do not edit frozen Phase3 files. Record the ruling."

So: the costing key is unchanged, lot and serial are **traceability** dimensions, and `P3-AL-46`'s forward-looking sentence is narrowed by this later explicit ruling rather than contradicted by a preparation document — the frozen Phase 3 files are not touched, and this page is the record. `TL-P11-R2` settles the consequence in the same breath: **no per-serial actual-cost authority, no lot-layer/FIFO costing, the variant moving weighted average remains the authority, FEFO/FIFO is picking only, and lot choice must not change COGS.**

The analysis below is kept as the record of why the question was worth asking, not as an open question.

**The accepted Phase 3 architecture lock predicted a different lot model from the one §2 proposes, and the difference is financial.**

`docs/PHASE_3_ARCHITECTURE_LOCK.md:1280-1288` (P3-AL-46, ACCEPTED) says, of this very phase:

> "What makes the future possible without a core rewrite is already decided: the stock key is `(business_id, warehouse_id, variant_id)` and movement identity is the five-part tuple of P3-AL-09. **A future lot dimension extends the key and the tuple**; it does not require `stock_movements` to change shape or the weighted-average engine to be re-derived. That is the whole preparation, and it is deliberately nothing more."

*(Verified by my own read of `docs/PHASE_3_ARCHITECTURE_LOCK.md:1284-1286` at `93084f8`; the bold is mine, the words are the lock's.)*

§2 of this document proposes the opposite shape — lot and serial as **overlays below an unchanged key**. Under the source-of-truth order (Master Part 1) an accepted Architecture Lock outranks a preparation document, so this is not a decision Phase 11 may take for itself. It is put to the Tech Lead as **ADJ-P11-01**, with both readings priced out. Nothing in this phase proceeds past design until it is ruled.

### Option A — extend the key, as P3-AL-46 reads literally
Stock key becomes `(business_id, warehouse_id, variant_id, lot_id)`; the movement tuple gains the lot.

- **It changes the costing law, necessarily and silently.** The moving weighted average is computed **per stock key** (`0060_inventory_stock_primitive.sql:349-420`: outbound is priced at *the key's* current average, and a full depletion flushes *the key's* stored valuation). Put the lot in the key and each lot gets its own average — which *is* lot-layer costing. Consuming lot A instead of lot B then produces a different `value_delta_base_minor`, so COGS, inventory valuation and gross margin all change meaning. P3-AL-46 states the engine "does not need to be re-derived", and that is true of its *code*; it is not true of its *semantics*. For serial tracking the same move gives on-hand ∈ {0,1} per key — i.e. **per-serial actual cost**, the heaviest version of OD-P11-01, arrived at as a side effect rather than as a decision.
- **It needs a sentinel lot for every untracked variant.** A PK column cannot be NULL, so every one of the existing `stock_levels` and `stock_movements` rows — and every untracked variant for ever after — needs a synthetic "no lot" value, or the uniqueness has to move to an expression index over `COALESCE(...)`. Either way the *untracked* majority of the product catalogue pays for a feature it does not use.
- **It rebuilds the primary key of a frozen relation.** `stock_levels` is `0059`, inside `0000`–`0079`, immutable. The frozen file is never edited — but a later migration dropping and recreating its PK, and widening `stock_movements_key_seq_uq` and `stock_movements_identity_uq`, is a heavy rewrite of the exact structures the Phase 3 gate pins. It also forces a change to `inventory_apply_stock_movements`' request type and return shape, the single writer every caller already binds to, which is precisely the `CREATE OR REPLACE` return-shape hazard P4-S7 was rejected over.
- It is **not reversible**: valuation history recorded under per-lot costing cannot be re-derived as variant-average history.

### Option B — overlays below an unchanged key (what §2 proposes)
`stock_levels` and `stock_movements` keep their shape; lot and serial hang off `stock_movements (business_id, id)` and must *reconcile to* the quantities the core already wrote (laws C-LOT-01…03, C-SER-01…04).

- Costing stays exactly as `0060` computes it: lot A and lot B of one variant cost the same, which law **C-LOT-04** then *proves* by execution rather than asserting.
- Nothing frozen is restructured, the single writer keeps its identity, and no sentinel is needed because an untracked variant simply has no overlay rows.
- FEFO still works: it is a **picking** function (P11-AL-08), and picking needs per-lot quantity, not per-lot cost.
- It does **not foreclose Option A.** Adding the lot to the key later remains possible; un-deciding per-lot costing after it has posted does not.
- Its cost is honest: a second quantity surface that *could* drift, which is why it is carried by deferred COMMIT triggers and a foldable cache rather than by convention — and why the two laws a challenger should attack first are C-SER-03 and C-LOT-03 (§3).

### Recommendation (as submitted; now superseded by the ruling above)
**Option B for Phase 11, and a Tech Lead ruling that reads P3-AL-46's "extends the key" as satisfied by an overlay that extends the *dimensionality of stock identity* while leaving the *costing key* alone** — or an explicit ruling for Option A together with an explicit ruling on OD-P11-01 and OD-P11-02, because Option A decides them whether or not anyone writes them down. The thing this document will not do is pick Option A quietly and let the costing change arrive as an implementation detail. — *Ruled: Option B, with `TL-P11-R2` deciding the costing question explicitly, exactly as this section asked.*

---

## 1b. The two defects returned with the ruling, and what they cost

Both were real. Neither was caught by my own reading, and both are the same class of mistake: a *value* or an *effect* duplicated by a path that looked like reuse.

### §55 — the serial cost snapshot violated this phase's own no-money law
The first draft's recommendation on OD-P11-01 was: say no to per-serial costing, but let the serial row carry the `unit_cost_base_minor` **snapshot** of its inbound movement "for reporting only, explicitly non-authoritative". That is a **copied monetary column on a Phase 11 relation**, and law L-P11-02 — written three documents earlier, by me — forbids exactly that. "Non-authoritative" is not a property a column has; it is a hope about how readers will behave, and the first report that needs a margin will treat it as the number.
**Corrected.** No monetary column on any serial, lot or repair relation. Reporting that needs an acquisition cost **joins back to the canonical inventory and accounting history** through the movement the serial's custody chain already names. The join is the feature; the copy was the defect.

### §60 — the repair flow would have decremented inventory twice
The first draft said a repair is billed by issuing a Phase 4 sales invoice "whose lines are the consumed parts plus a labour line", *after* the parts had already been consumed through the repair inventory source. A tracked part on an ordinary sale line moves stock — that is what a sale line *is*. So the same physical part would have been decremented twice and its COGS posted twice. It reads as reuse of the sales authority; it is a second stock effect.
**Corrected** per `TL-P11-R7`: physical consumption happens **once**, under the repair part consumption authority. Billing then references that consumption without moving stock again, through a **new additive Phase 11 contract extension** — the preconsumed sale-line binding of `P11-AL-21` — and revenue, AR and cash still go through the sales authority exactly as before. Zero second movement, zero second COGS.

**What both have in common, worth stating because it will recur in Phases 12–15:** a vertical pack's instinct is to reach for an existing authority and pass it something that *looks* like its normal input. A sale line and a cost column are both "just reuse" right up to the point where the effect lands twice. The structural answer in both cases is the same — do not copy the value, and do not re-enter the authority; **bind to the record that already exists.**

---

## 1c. The 2026-10-12 per-phase directive, and what it changed here

Read from the directive itself (PARTs 62–71 verbatim), not from a summary of it. **PARTs 62–66 confirm what is already built here** and change nothing: `PREPARED / NOT PROMOTED` and `DESIGN/SPEC ONLY` (62); no `unit_cost` snapshot, no valuation amount, no average cost and no financial carrying column inside any Phase 11 lot/serial relation, reports deriving from canonical history instead (63 — already law `L-P11-02`, already red-proved by `R-L02`); serial uniqueness per business + kind + normalized value, countable-integer on-hand, deferred-constraint/fold/cache conservation proof, the validator's subject derived from the authoritative movement identity, and **never `count(*) == 0` as proof of absence under RLS** (64 — already `P11-AL-15`, `C-SER-01`, and the explicit prohibition in `P11-AL-14`); expired-lot consumption refused with no generic override and no silent substitution (65 — already `P11-AL-09`/`TL-P11-R4`); repair labour a service product depending on sealed Phase 10 `SERVICE`, no new money line type, no inventory effect (66 — already `P11-AL-11`).

**Four things are new, and three of them are defects in this draft rather than additions to it.**

**PART 67 — the binding was under-specified in two ways.** `P11-AL-21` listed eight conditions; the directive names ten, and the two this draft was missing are the **exact repair ticket** and the **same customer/custody context where applicable**. Both matter for the same reason: a binding pinned only to a consumption row could bill a part consumed on one customer's device against another customer's invoice, and nothing in the eight conditions would have refused it. The directive also fixes a **V1 simplification** this draft left open: **one repair consumption item is billed at most once for its full consumed quantity**, and partial split billing of one consumption row is **not supported in v1** — it would require its own allocation ledger, i.e. a second allocation authority next to the Phase 4 one. Condition 4 ("exact qty") already refused a *different* quantity, so the shape was compatible; what was missing was the statement that the full quantity is the only admissible one, and the reason, which is that partial billing is an authority question and not a convenience.

**PART 68 — the blocked-subfeature scope was not stated.** This draft already required the Accounting Owner to rule the posting map before `repair_part_consumption` goes live (§62, `P11-AL-11`). The directive adds what happens if the accounting model is **not yet settled**: **only this subfeature is blocked, not the rest of Phase 11 preparation.** That is a scoping rule this draft did not have, and without it an unsettled posting map would have read as a phase-wide `BLOCKED`. It also names the five things the ruling must establish, one of which — **`moving-average valuation source`** — this draft had as "the valuation comes from the canonical moving average" and which is now an explicit item of the owner's ruling rather than an assumption of ours. New decision `P11-AL-24`.

**PART 69 — the repair deposit had no decision of its own.** `P11-AL-11` said in one clause that "an intake deposit is a Phase 4 customer payment or customer credit". The directive makes it a requirement with four named prohibitions — not a fake sale, not a fake paid invoice, not a repair-owned money balance, and specifically **no repair-specific deposit ledger, no allocation to a nonexistent invoice, no double AR reduction** — under the **sealed Phase 4 unapplied customer payment / customer credit liability authority**. A clause in another decision is not enough protection for a trap of this class: the easiest way to build a repair deposit is a `repair_deposits` table, and that table *is* a second money truth. New decision `P11-AL-22`, with its own law and red proof.

**PART 70 — warranty history could have been deleted.** `P11-AL-12` recorded `source`, `starts_on`, `ends_on` explicitly and refused any accounting provision, which the directive confirms. What it did **not** state is the lifecycle: warranty issuance must **anchor to a committed sale, a sale line and the serial/item where applicable**, and a return or reversal **must not delete warranty history** — the transition is **append-only** (`cancelled` / `ended` / `voided-by-return`) under an explicit domain rule, with no mutation hiding historical issuance. As drafted, `warranties` was a plain row a return path could have `DELETE`d, which would erase the fact that a warranty was ever issued. New decision `P11-AL-23`, with law `C-WAR-01`.

**PART 6 — and one compliance check on this draft's own proofs.** The frozen-migration law now says in terms that a red proof must **never** mutate a frozen migration even temporarily, and that **a proof requiring frozen-history modification is wrongly designed**. Two of this draft's proofs mutate "the writer" (`R-SER-04` removes a `FOR UPDATE`; `R-LOT-04` makes the outbound price from the lot's own receipt cost). The writer `inventory_apply_stock_movements` is defined in a frozen migration — so the question is real, and the answer is that both mutations target the **Phase 11 replacement body specified in the patch request**, which is Phase 11's own text, in a scratch copy. That was true but unstated, and unstated is not good enough for a law of this class: `P11-AL-25` now states the mutation target of every red proof, and the conservation document carries a per-proof table of targets.

**PART 13 — the handoff manifest.** Now a required gate for every Phase 5–15 preparation. `P11-HANDOFF-MANIFEST.md` is new, and its absence would have been `HANDOFF INCOMPLETE`.

---

## 1d. The Master Continuous Mission (2026-10-12), and why it changes the *mode* rather than the design

Read from §18 of the directive itself. **Five of its six paragraphs confirm what is already specified here** and are worth stating as confirmation rather than silence: Option B with the valuation key unextended and no money column on any lot/serial relation; FEFO/FIFO as selection policy only; serial uniqueness per `business + serial kind + normalized serial`; **a serial-enabled movement requires events equal to `abs(qty)` exactly, in whole-unit quantities** (`C-SER-03`, already the first law a challenger is pointed at); the lot fold equalling canonical stock and being rebuildable and verifiable against official history (`C-LOT-03`); **no count of zero rows that RLS hid used as proof of absence** (`P11-AL-14`); FEFO on the **passed `asOf`**, never the device clock; expired quantity refused with no override in v1; **an insufficient pick refuses the whole operation** — no partial pick, no silent substitute; no new cost valuation; the customer's device not inventory and labour `SERVICE`; parts consumed physically once with no second movement and no second COGS from the later invoice; the PRECONSUMED binding requiring **the full quantity of one identified consumption source, once, within the same business, with one billing binding and no partial links**; the deposit as a canonical Phase 4 unapplied payment or customer credit with no repair deposit ledger, no allocation to a nonexistent ticket or invoice and no double AR effect; warranty with explicit source and dates, a **composite non-null link to the sale, its own sale line and the serial where applicable**, facts appended only, no invented accounting provision and **no deletion of its history after a return**; custody liability for the owner and legal counsel with the neutral state recorded and no legal verdict issued; and the Accounting Authority settling `repair_part_consumption`'s posting, valuation and reversal map before it is enabled — **blocking the capability that depends on it, not apparel, not the spec review, not all of Phase 11.**

**Three things are new.**

**It is a mandate to build, and the cheapest path is apparel.** §18 opens: the preparation is mostly design, so do not stop at merging — **start building incrementally along the DAG, and pick the cheapest independent end-to-end path, such as the permitted apparel**, by its owners, while traceability and repair review continue in parallel. §1 of the same directive is explicit that the mission is "code, wiring, UI, tests, reviews, evidence, delivery" and that execution must not be replaced by new documents about execution. This document does not get to be the deliverable any more. The order is the one this preparation already recommended for its own reasons — apparel touches no ledger, needs no overlay, and is therefore the cheapest complete proof of the pack mechanism end to end — which is now `P11-AL-26`.

**The DDL is to be executed, unnumbered, on a scratch proof.** §18's last paragraph: *execute unnumbered DDL for a scratch proof, then the Owner's allocation at promotion* — and then, in order: RLS, cross-business traversal, composite FKs, serial reuse, expiry, selection policy, atomic consumption, the PRECONSUMED, replay and reversal proofs, then API, UI, permissions, capabilities, feature mapping, localization, browser and the gate. **And: do not drop any required part of the scope because it is currently design only.** This resolves what was until now an honest limit of this preparation — that nothing had been applied to a cluster, so every verdict was `SPEC ONLY`. The permission is narrow and its narrowness is the point: **unnumbered**, on a **scratch** cluster, with the Owner's allocation still the only route to a numbered file.

**One detail of the binding is sharper than what was written here.** §18: *a retry returns the same original, and the ticket, customer and custody context are preserved, without bypassing NULLs or the contract.* The ticket/customer/custody context and the NULL-bypass prohibition are already `P11-AL-21` conditions 3a and 3b as corrected on PART 67. **"A retry returns the same original" is new as a stated requirement** and is a different property from "a second binding is refused": a retried billing attempt must be **idempotent — returning the existing binding** — not merely rejected. A client that retries after a timeout must not see a failure for work that succeeded. `C-REP-03` now carries that case, and it is the fifth executed case rather than a sixth refusal.

**And the cross-phase laws that bind this phase's execution**, each applied below rather than merely noted: the **hard-link hazard** (never write inside a hard-linked sandbox; unlink or copy first and prove the original's bytes **and inode** unchanged — the hazard this project already found latent in a Phase 4 security test); the **frozen boundary moves forward only** (if `frozenThrough` legitimately advances past `0079`, protect the newer boundary and never roll back to the older one, which makes the gate's `frozen-prefix` arm a **floor**, as it was already written); the **status ladder**; the **ownership table**, under which this phase sends patch requests rather than edits; the **currency matrix** (ILS, JOD, LBP, SYP, TRY, USD, EUR); the **defect budget per seal** (P0 = 0, P1 = 0, and **P2 = 0 for money, stock, security, tenant, data integrity and the core path** — only minor cosmetic defects are deferrable, which for the packs means an overlay drift is never a deferrable finding); the **DAG task schema** (requirement ids, deliverable, predecessor contracts, write paths, owner, reviewer, acceptance, evidence, resources, blocker class, status, with code / DB / API / UI / security / concurrency / browser / performance / release completion kept **separate** rather than collapsed into one "done"); and the **visual identity and UX law** of §23, which is `P11-AL-27` because the packs add real merchant surfaces and that law is now part of execution rather than a later polish.

---

## 2. Architecture decisions (P11-AL)

These are proposals for the Tech Lead. None is ratified.

### P11-AL-01 — status and non-interference
Phase 11 is `PREPARED / NOT PROMOTED` until Phase 4 is sealed and the roadmap reaches it. It owns no file inside the Phase 4 integration tree, runs no migration, and touches no frozen artefact. Preparation output lives in `/mnt/project-files/phase11/` and on `claude/phase11-prep-re0epv`.

### P11-AL-02 — one inventory truth, restated as a prohibition
*Ratified by `TL-P11-R1` (§1a).*
The stock key stays `(business_id, warehouse_id, variant_id)`. `inventory_apply_stock_movements` stays the only writer of `stock_movements`, `stock_levels` and `stock_source_bindings`. **No Phase 11 relation may carry a quantity that is not derived from a `stock_movements` row, and no Phase 11 relation may carry a value at all.** Mechanically: every Phase 11 quantity column exists only on a row whose PK includes a `stock_movements.id`, and the phase gate greps the Phase 11 DDL for `value_.*_minor`, `valuation`, `unit_cost` and reds on a hit (law L-P11-02, `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md`).

### P11-AL-03 — packs are capability-gated, never branched
A pack is: rows in the registries + its own relations + its own entry routines + its own screens, all behind a capability key. Core code gains no `if apparel`, no business-type switch, no `industry_profile_key` read in a financial path. `industry-profiles.ts` stays advisory (`:10-11`). A capability that is off makes its navigation invisible and its endpoints refuse — refusal, not a 404, so a client cannot distinguish "absent" from "forbidden" by guessing (see §6.4).

### P11-AL-04 — Apparel: axes are catalog structure, one variant per combination
Size/color becomes a **business-scoped axis registry** (`product_attribute_axes`, `product_attribute_values`, both carrying `translations JSONB` exactly like `products.translations`, `0005:14-35`), and `product_variants.attributes` becomes a **canonical, closed map** `{axis_code: value_code}` validated against that registry by a trigger, with a uniqueness index per `(business_id, product_id, canonical attributes)`. Each combination is a variant, so **each combination is its own stock key** — which is what the core already wants, and why apparel needs no overlay at all. Base variants keep `attributes = '{}'` (`product_variants_base_shape_ck`, `0053:137-139`); a matrix product's base variant is not sellable stock.
*Why not a `size`/`color` column pair:* apparel is not the only matrix (lens diameter × coating, sleeve × fit × wash). Two columns would be a fork within a year, and `attributes` was reserved for this in `0005` on purpose.

### P11-AL-05 — Serial/IMEI is a traceability overlay, never a stock key
*Ratified by `TL-P11-R1`.*
A serial is one physical unit *inside* a variant's on-hand. Model:
- `stock_serials` — the registry of individual units: `(business_id, id, variant_id, kind, value_norm, custody_state, warehouse_id NULL, last_event_seq)`, with `UNIQUE (business_id, kind, value_norm)` (P11-AL-15) and `UNIQUE (business_id, id, variant_id)` so overlay rows can carry a composite FK.
- `stock_serial_events` — append-only custody chain, one row per `(serial, stock_movements.id)`: `(business_id, serial_id, event_seq, stock_movement_id, direction IN ('in','out'), warehouse_id)`, PK `(business_id, serial_id, event_seq)`, `UNIQUE (business_id, stock_movement_id, serial_id)`.
- The quantity is still the movement's `qty_delta`. The overlay's job is to **equal** it: law **C-SER-03**, every movement line of a serial-tracked variant carries exactly `abs(qty_delta)` serial events of the matching direction, enforced by a **deferred** constraint trigger at COMMIT (the `stock_levels_zero_on_hand_zero_value` precedent, `0060:655`).
- Serialized ⇒ `products.unit_decimals = 0` and every `qty_delta` is an integer. A serial-tracked variant with a fractional movement is refused (`inventory.serial_quantity_not_countable`).
*Rejected alternative — variant-per-serial:* it makes each phone a catalog row and each phone its own moving average. The catalog explodes, `catalog_identifiers` becomes a serial registry by accident, and every report that groups by variant breaks. Rejected.

### P11-AL-06 — Lot/batch/expiry is a quantity overlay below the variant, with zero value
*Ratified by `TL-P11-R1`.*
- `stock_lots` — `(business_id, id, variant_id, lot_code_norm, expiry_date DATE NULL, produced_on DATE NULL, received_seq BIGINT, status)`, `UNIQUE (business_id, variant_id, lot_code_norm)`, `UNIQUE (business_id, id, variant_id)`.
- `stock_lot_movements` — `(business_id, stock_movement_id, lot_id, qty_delta NUMERIC(18,4))`, PK `(business_id, stock_movement_id, lot_id)`. **No value column. Ever.**
- `stock_lot_levels` — derived per-lot cache `(business_id, warehouse_id, variant_id, lot_id)` with `on_hand` and `last_movement_seq`, written only by the same writer in the same statement as the movement, and rebuildable exactly from `stock_lot_movements` by a `inventory_lot_fold` twin of `inventory_stock_fold` (`0060:517-574`).
- Laws: **C-LOT-01** `Σ lot qty_delta = stock_movements.qty_delta` per movement; **C-LOT-02** per-lot on-hand never negative, refused under the lot level row's lock; **C-LOT-03** `Σ lot on-hand = stock_levels.on_hand` for every lot-tracked key.
*Why a per-lot cache at all:* FEFO has to pick, and picking needs a current per-lot quantity under a lock. The cache is derived and provably foldable, like `stock_levels`; it is not a second truth, and it carries no money.

### P11-AL-07 — costing is untouched; FEFO is a picking policy, not a costing policy
*Ruled: `TL-P11-R2` — no per-serial actual-cost authority, no lot-layer/FIFO costing, the variant moving weighted average remains the authority, FEFO/FIFO is **picking only**, and lot choice must not change COGS. OD-P11-01 and OD-P11-02 are closed NO.*
Moving weighted average at the variant key stays the only costing law. **There is no lot-layer costing and no per-serial cost in Phase 11.** Consuming lot A or lot B of the same variant produces the *same* `value_delta_base_minor`, because the outbound price is the key's average (`0060:383`). This is the single most load-bearing sentence of the phase: it is what makes the overlays provably value-neutral, and it is why `stock_lot_movements` has no value column. Per-serial actual cost and FIFO lot costing are **refused** by `TL-P11-R2`, and no monetary snapshot of either may be stored (§55): a report that needs an acquisition cost joins back to the canonical inventory and accounting history.

### P11-AL-08 — FEFO/FIFO is deterministic and refuses rather than guesses
`inventory_pick_lots(business, warehouse, variant, qty, as_of DATE, policy)` → the chosen `(lot_id, qty)` list, `STABLE`, taking `as_of` **supplied by the caller, never `now()`** (the P4-S7 `asOf` ruling, Master Part 22). Order: `FEFO = (expiry_date NULLS LAST, received_seq, lot_id)`; `FIFO = (received_seq, lot_id)`. The tiebreak on `lot_id` exists so the answer is a function, not a plan artefact. If the non-expired, non-blocked quantity is short, it **refuses** `inventory.lot_selection_insufficient` with no partial pick and no silent substitution. The picker proposes; the writer still refuses on its own `inventory.insufficient_stock` under the level lock (`0060:383`), so the picker can never over-promise.

### P11-AL-09 — expiry is a refusal, and Phase 11 ships no override
*Ruled: `TL-P11-R4`.* An outbound movement that would consume a lot expired as of the supplied `as_of` is **refused** — `inventory.lot_expired` — and **Phase 11 adds no generic override**: not a flag, and not the audited permission the first draft recommended. If a future country or regulated pack establishes that an override is lawful and wanted, that pack may add a dedicated permission, its audit and an explicit policy. Until then the answer is refuse.
Expired stock leaves inventory only through the existing `damage` / `adjustment` kinds with a reason — i.e. through Phase 3's authority, at the variant average, with a journal. No write-off is invented here. And the behaviour ruled out explicitly: **no silent substitution of a fresher lot**, because that hides expired inventory rather than reporting it.

### P11-AL-10 — a customer's device is not inventory
A repair intake records a device the business does **not own**. It therefore never produces a `stock_movements` row, never appears in `stock_levels`, and has no value in any Phase 11 relation. Custody is `repair_devices` + an append-only `repair_device_custody_events` chain (`received` / `in_workshop` / `awaiting_parts` / `ready` / `handed_back` / **`uncollected`**), keyed to the customer. *Ruled (§63): the terminal state is the neutral operational `uncollected`, **not** `abandoned`* — abandonment is a legal conclusion, and the system records custody facts without deciding ownership or liability. A pack that ships the word `abandoned` has quietly taken a legal position in a column name. The protection is structural: **no `repair_intake` source type is ever registered**, and the Phase 11 gate reds if one appears (law **C-REP-01**, with a red proof that registering it turns the gate red). This is the trap this slice is most likely to fall into and the cheapest one to make impossible.

### P11-AL-11 — a repair part is consumed **once**, and billing binds to that consumption
*Rewritten on §60 and `TL-P11-R7`. The first draft's version would have decremented stock twice — see §1b.*

- **Physical consumption, once.** Parts leave stock under the **repair part consumption authority**: source type `repair_part`, movement kind `repair_part_consumption` (`qty_sign = 'negative'`), its `stock_source_bridge_repair_part` in the existing bridge shape, and the op→kind row that actually grants authority. One physical movement, under the five-part identity, through `inventory_apply_stock_movements` and no other path.
- **Billing moves no stock.** The invoice does **not** carry the part as an ordinary sale line, because a tracked part on a sale line *is* a stock effect. It carries a **preconsumed sale-line binding** (`P11-AL-21`) that references the repair consumption that already happened. Zero second movement, zero second COGS.
- **Money still belongs to the sales authority.** Revenue, AR and cash go through the Phase 4 sales invoice command exactly as before. There is no repair receivable, no repair payment, no repair credit note and no repair balance; an intake deposit is a Phase 4 customer payment or customer credit.
- **Labour is a service product** (`TL-P11-R6`) — no new financial line type, no inventory effect. **It depends on a sealed Phase 10 `SERVICE` stock-effect capability**, which is a hard dependency Phase 11 does not own and must not pre-empt: until that capability seals, repair labour is `BLOCKED`, not designed around.
- **Before `repair_part_consumption` goes live** (§62) the **Accounting Owner** must verify the debit account, the inventory credit, that the valuation comes from the canonical moving average, the correction/reversal path, and that no duplicate COGS arises at invoice time. **Repairs author no journal logic.** If the current inventory posting map cannot represent repair consumption safely, this becomes an **Accounting-owner Contract Diff**, not a Phase 11 workaround.

### P11-AL-21 — the preconsumed sale-line binding (`TL-P11-R7`)
*Extended 2026-10-12 on PART 67: two conditions were missing and the v1 billing granularity was not stated.*
A **new additive Phase 11 contract extension** — added by Phase 11, **not** by Phase 10, and **not registered dead in Phase 10** — created only once a real repair writer exists. A sale line may be marked as billing stock that was already consumed elsewhere, under all **ten** conditions together:

| # | condition | why it is load-bearing |
|---|---|---|
| 1 | **server-derived** | the binding is computed from the repair record, never accepted as a field |
| 2 | **the client cannot choose it** | otherwise any client could bill a tracked item with no stock effect — a free-inventory hole |
| 3 | names the **exact repair part source** — the exact consumed part entry, and its **exact product/variant** | so the binding is to one identified consumption, not to a quantity that looks similar |
| 3a | names the **exact repair ticket** (PART 67) | a binding pinned only to a consumption row carries no evidence of *which job* it belongs to; the ticket is what a reversal, a warranty claim and an audit all read |
| 3b | **the same customer / custody context, where applicable** (PART 67) | without it, a part consumed on one customer's device could be billed on another customer's invoice and every other condition would still hold. This is the condition whose absence is invisible in a single-customer test fixture |
| 4 | **exact qty** | a binding for less or more than was consumed is refused, not reconciled |
| 5 | **same business** | the tenant and business pair is pinned structurally, like every other relation |
| 6 | **one billing binding, for the full consumed quantity** | a consumption may be billed **once, for its whole quantity**; the second attempt is refused by a uniqueness constraint rather than by a check in code. See the v1 rule below |
| 7 | **a prior canonical stock movement exists** | a binding with no movement behind it is refused — the fail-open case, and the one a test must plant |
| 8 | **zero second movement, zero second COGS**; revenue/AR/cash still through the sales authority | the whole point of the extension |

Condition 7 is the one to attack first: a binding that can be created *before* the consumption exists re-opens §60 by another door. Condition 3b is the one most likely to pass review unnoticed, because a fixture with one customer in it cannot fail that way.

**V1 simplification (PART 67), binding:** **one repair consumption item is billed at most once, for its full consumed quantity.** Partial split billing of a single consumption row is **not supported in v1**. The reason is not effort: splitting one consumption across several bindings needs a ledger that records how much of it each binding claims and refuses the sum exceeding the whole — which is **an allocation authority**, and the project already has exactly one of those, in Phase 4 for payments and credits. A second one next to it is a second truth about how much of something has been applied. So the structure is deliberately unable to express a partial claim: `repair_part_billing_bindings` is keyed `(business_id, repair_part_id)` — **one row per consumption, no quantity-claimed column** — and `billed_qty` must equal the consumption's `qty` exactly (`repair.billing_qty_mismatch`). A business that genuinely needs to bill half a consumption consumes half, which is a real inventory fact, rather than claiming half of one, which is an accounting fiction. If partial billing is ever wanted, it is a **future phase with an allocation ledger of its own**, not a column added here.

### P11-AL-12 — warranty is a record, not an accounting estimate
*Ruled: `TL-P11-R5` — record `source` (business or vendor), `starts_on` and `ends_on` explicitly; **no warranty inferred from a product category**; no accounting provision or accrual in Phase 11.*
`warranties (business_id, id, sale_id, sale_line_id, serial_id NULL, starts_on, ends_on, source IN ('business','vendor'), terms_translations JSONB)`, plus `warranty_claims` linking a claim to a repair ticket. Phase 11 gives warranty **no financial effect**: no warranty provision, no accrual, no liability. A warranty-covered repair is a repair whose parts still post COGS and whose invoice total may be zero-rated by a business decision at the sale, through the ordinary Phase 4 path. A warranty provision is a future accounting phase decision, not this one. **The lifecycle is `P11-AL-23`** — as drafted above, `warranties` was a plain row that a return path could delete, which PART 70 forbids.

### P11-AL-13 — migration discipline
No number. `P11-MIGRATION-PATCH-REQUEST.md` is the deliverable; the Migration Owner reads the live prefix, allocates serially and creates the files when Phase 11 is actually authorized (Master Part 10). Phase 11's DDL cannot be written against `0086` as a predecessor, because `0080`–`0086` are unfrozen candidates and may still change: the patch request states its predecessor as "the live effective definition at allocation time", and every function it needs to re-create is listed with the reason, the way P4-S7 learned to (reading the live definition, not a stale number).

### P11-AL-14 — security shape is copied, not reinvented
Every new relation: `REVOKE ALL … FROM PUBLIC`, then `ENABLE` **and** `FORCE ROW LEVEL SECURITY` in the same pair, then `tenant_membership` permissive with both clauses, `business_isolation` restrictive with the internal principal on **USING only**, and `inventory_internal_read FOR SELECT TO daftar_inventory_internal USING (true)` where an internal validator must read it — all in the `0086` scalar-subselect form. `tenant_id` is denormalized onto every row with `FOREIGN KEY (tenant_id, business_id) REFERENCES businesses (tenant_id, id)`, PKs stay `(business_id, …)`, every cross-table FK is composite. Grants: `SELECT` to `daftar_app`, column-scoped `UPDATE` to `daftar_inventory_internal` on the derived caches only, no `DELETE`, no `TRUNCATE`, no `EXECUTE` on internal definers.
**The P4-S7 lesson is binding here:** a relation with RLS enabled and forced and **zero policies** does not fail closed usefully — it makes an internal validator refuse *everything* rather than only the incomplete cases (`daftar-a-guard-that-cannot-read-its-subject-refuses-everything`). Every relation an internal routine reads gets its `*_internal_read` policy **in the same migration that enables RLS on it**, and the end-state assertion checks policy presence per relation, not just the `ENABLE`/`FORCE` pair.
**And the round-6 C1 lesson:** a `SECURITY DEFINER` absence guard that counts rows cannot distinguish "none exist" from "I can see none" (`daftar-under-rls-absent-and-invisible-are-one-answer`). No Phase 11 guard is written as `IF count(*) = 0 THEN allow`. Where an overlay guard must prove absence, it proves it from the *authoritative* side — the movement's own `qty_delta`, which it reads in the same statement that wrote it — never from a visibility-dependent count.

### P11-AL-15 — serial uniqueness lives in `stock_serials`, not in `catalog_identifiers`
*Ruled: `TL-P11-R3` — unique per business + serial kind + normalized value; the same IMEI may not exist under two variants of one business. OD-P11-03 is closed.*
`catalog_identifiers` (`0037:13-36`) is keyed `(business_id, kind, value_norm)` with `owner_type IN ('product','variant')` and is maintained by triggers **on `products` and `product_variants`**. An IMEI's owner is a stock serial, whose lifecycle is movements, not catalog edits. Putting serials there would either widen `owner_type` and leave those triggers responsible for a relation they do not watch, or add a third trigger writing another domain's table. Instead: `UNIQUE (business_id, kind, value_norm)` on `stock_serials` itself, with the same normalization function the catalog uses so the two vocabularies cannot drift. **OD-P11-03** asks the owner to confirm business-wide (not variant-scoped) serial uniqueness; business-wide is recommended, because a real IMEI is unique in the world and a duplicate is a data-entry error worth refusing.

### P11-AL-16 — a tracking mode is immutable once stock exists
`track_serial` and `track_lot` are product-level switches in the `products.track_inventory` family (`0053:113-123`). Turning either on or off for a variant that already has a `stock_levels` row is refused — `inventory.serial_tracking_history_locked` / `inventory.lot_tracking_history_locked` — on the `product_variants_20_stock_identity_lock()` precedent (`0060:683`). Reason: flipping it retroactively makes the conservation laws unsatisfiable for history that was recorded without overlay rows, and the only honest alternatives are a backfill nobody can verify or a permanently broken invariant. The migration path for a business that wants tracking on existing stock is the ordinary one: a stocktake.

### P11-AL-17 — offline capture is input, never authority
Serial and lot capture on the Android app is a *client-supplied field*. The server re-validates it (existence, custody state, expiry, uniqueness) and may refuse. A queued offline repair intake or sale carries its serials and lots in the payload; on replay the server may refuse the whole command, and the device shows the refusal. **The device never resolves a serial conflict.** This is Master Part 27 applied to Phase 11 and is a contract Phase 7 must honour, not something Phase 11 implements.

### P11-AL-18 — AI boundary
Phase 12 may read serial, lot and repair state with the user's own authority, and may draft a repair ticket or a pick list. It never commits a movement, never assigns a serial and never overrides an expiry refusal (Master Part 32).

### P11-AL-19 — proof standard
Every law in §3 gets a named red proof that is shown red by a *minimal* mutation, and the mutation is diff-checked before the run is read (the S5 rule: a `sed` that matched no line once went green and nearly recorded a missing law as fine — `daftar-a-red-proof-must-name-the-refusal-it-expects`). Conservation under concurrency is proved on a **real PostgreSQL cluster with multiple connections and transaction barriers**, never with `sleep()` (Master Part 39). The gate script is `scripts/phase11-s<N>-gate.ts` / `gate:phase11:s<N>`, and the phase gate **executes** the suites it names — a gate that only parses text must print that limitation on PASS, as S5's does.

### P11-AL-20 — localization and UX bar
Every new surface is ar/en/tr with correct RTL and LTR, phone/tablet/desktop, no placeholder, no dead button (Master Part 74). Business-authored names — axis names, axis values, lot labels, warranty terms — are **data**, so they carry `translations JSONB` like `products.translations` (`0005:14-35`) rather than translation-file keys. Product-independent chrome (column headers, refusal messages, repair statuses) are translation-file keys in all three locales.

### P11-AL-22 — a repair deposit is canonical Phase 4 money, and Phase 11 owns no money balance
*New, on PART 69. The first draft carried this as one clause inside `P11-AL-11`; it needs its own decision because the obvious implementation is a table and that table is a second money truth.*

A customer deposit taken **before** the final repair invoice exists is **not** a sale, **not** a paid invoice, and **not** a repair-owned money balance. It is received, recorded and later applied through the **sealed Phase 4 unapplied customer payment / customer credit liability authority**, exactly as that contract defines it, and applied to the repair sale later through the **canonical payment/credit allocation** path.

Four prohibitions, each naming the shortcut it closes:

| forbidden | what it would otherwise be built as | why it is wrong |
|---|---|---|
| **no repair-specific deposit ledger** | `repair_deposits (business_id, ticket_id, amount_minor, …)` | a second place where customer money is owed. Two balances for one liability drift the moment one of them is written without the other, and nothing in the schema would say which is right |
| **no fake sale / no fake paid invoice** | issue a zero-line invoice at intake and mark it paid | revenue recognized before anything was sold, and an invoice that no sale line explains |
| **no allocation to a nonexistent invoice** | allocate the deposit to the repair "ticket" | the allocation target must be a committed invoice; a ticket is not a receivable |
| **no double AR reduction** | reduce AR at intake *and* again when the deposit is applied | the same money reduces the same receivable twice |

Phase 11 therefore specifies **no deposit relation at all**. The repair ticket may *display* the customer's unapplied payment / credit balance, read from the Phase 4 authority — a read, never a store. Until Phase 4's payment and credit contract is sealed, the deposit flow is `WAITING_FOR_INTEGRATED_SURFACE`: the design is settled, the surface it binds to is not. Law `C-REP-04`.

### P11-AL-23 — warranty issuance is anchored, and its lifecycle is append-only
*New, on PART 70. Confirms `TL-P11-R5` and adds what it did not cover.*

**Anchored.** A warranty row may exist only against a **committed sale**, a **sale line** of that sale, and the **serial/item where applicable** — composite FKs, not nullable hints, so an unanchored warranty is unrepresentable rather than merely discouraged. `(business_id, sale_id, sale_line_id)` must resolve to a real line of a **committed** sale; a draft sale issues no warranty.

**Append-only.** A return or reversal **must not delete warranty history.** `warranties` rows are never `DELETE`d and never `UPDATE`d in their issuance facts (`sale_id`, `sale_line_id`, `serial_id`, `starts_on`, `ends_on`, `source`); the state change is recorded as a **new row in an append-only `warranty_lifecycle_events` chain** whose transitions are an explicit closed set — `issued` → `cancelled` | `ended` | `voided-by-return` — with the current state derived from the chain's last event, exactly as `repair_device_custody_events` carries custody (`C-SER-02`'s shape, reused rather than reinvented). An UPDATE or DELETE of an issuance fact is refused by trigger; the terminal transitions are terminal.

**Why it matters, concretely:** a device sold with a warranty and later returned leaves a trace that a warranty *was* issued and then voided by that return. A design that deletes the row cannot answer "was this unit ever under warranty?" — and that is the question a warranty claim six months later asks. The directive's phrase is exact: **no mutation hiding historical issuance.** Still no accounting provision, no accrual, no liability (`TL-P11-R5` unchanged). Law `C-WAR-01`.

### P11-AL-24 — an unsettled accounting model blocks one subfeature, not the phase
*New, on PART 68; it scopes what §62 already required.*

Before `repair_part_consumption` is registered, the **Accounting Owner** must rule and prove its posting map, and must establish all five of: the **inventory credit**; the **correct expense / COGS / WIP debit according to the accepted accounting model**; the **moving-average valuation source**; the **correction / reversal path**; and that **no duplicate COGS arises at invoice time**. **Phase 11 does not guess the debit** — not even as a default to be corrected later, because a posting map that ships wrong is corrected by a journal, not by a migration. **The repair module never authors journal lines itself**; it reaches the existing accounting bridge or it does nothing.

The scoping rule, which this draft lacked: **if the accounting model is not yet settled, only this subfeature is blocked — not the rest of Phase 11 preparation.** Apparel, lot/expiry, serial tracking, custody, warranty and the billing binding's *structure* all proceed and may seal. What waits is the registration of the consumption movement kind and anything that posts through it. The honest label for that one item is `BLOCKED`, and for the phase it is unchanged. If the current inventory posting map cannot represent repair consumption safely, the output is an **Accounting-owner Contract Diff**, never a Phase 11 workaround.

### P11-AL-25 — every red proof's mutation target is named, and it is never frozen history
*New, on PART 6's corrective law after the Phase 5 mutation-harness incident.*

A red proof mutates exactly one of: **a scratch copy of Phase 11's own DDL or source text**, **a synthetic fixture**, **a temporary generated tree**, or **a throwaway non-canonical clone**. `0000`–`0079` stay **byte-identical on disk in this working tree**, and `0080`–`0086` — unfrozen S4 candidates owned by Phase 4 — are not mutated either, because they are another thread's live work. **A proof that requires modifying frozen history to prove itself is wrongly designed, and the response is to redesign the proof, not to make an exception for it.**

The two proofs where this is a live question are `R-SER-04` and `R-LOT-04`, both of which mutate the behaviour of `inventory_apply_stock_movements` — a routine whose current definition lives in a frozen migration. Their target is the **`CREATE OR REPLACE` body specified in `P11-MIGRATION-PATCH-REQUEST.md` §4**, which is Phase 11's own text: the scratch cluster is built by applying the frozen prefix **unmodified** and then Phase 11's DDL **mutated**. The frozen file is read, never written. `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md` §0 carries the per-proof table, and the gate's `frozen-prefix` arm is what detects a violation after the fact — digest comparison over the accepted prefix, run **after** the proof suites, so a harness whose clean-check is narrower than its mutations (the Phase 5 contamination) cannot print "clean".

### P11-AL-26 — build order: apparel first, end to end, and the scratch proof before anything else
*New, on §18 and §1 of the Master Continuous Mission. It replaces this preparation's posture, not its design.*

**Apparel is built first, completely, before lot and serial.** The reason is the one this document already gave for recommending it: a matrix product's every size/colour combination is an ordinary `product_variants` row, therefore an ordinary stock key, therefore apparel **touches no ledger, needs no overlay and adds no conservation law to the inventory truth**. It is the cheapest complete proof that the pack mechanism works end to end — migration, RLS, entry routine, capability gate, API, three locales, browser, gate arm — and a mechanism proved there is proved for lot, serial and repair, which are strictly harder. Building the hard one first would prove the mechanism later and at more risk. Traceability and repair work continue in **review** in parallel (`P11-REP-014`), which is what §18 asks for.

**The scratch proof comes before the TypeScript, not after it.** The order is §18's own: unnumbered DDL applied on a scratch cluster first; then RLS, cross-business traversal, composite FKs, serial reuse, expiry, selection policy, atomic consumption, and the PRECONSUMED, replay and reversal proofs; then API, UI, permissions, capabilities, feature mapping, localization, browser and the gate. The reason this order is right is a measured one from a nearby slice: eight of twelve defects were found by applying DDL to a live cluster **as the real roles**, and two of them were exactly the shapes this phase's DDL invites — a constraint trigger created above its function, and RLS forced with no policy so the internal validator refuses everything instead of only the incomplete cases.

**The hard rules on that scratch cluster**, each the residue of an incident:
- **Unnumbered.** The DDL file carries no number and no number-shaped name. Only the Migration Owner allocates, at promotion.
- **Never the frozen tree.** The frozen prefix is applied **unmodified**; only Phase 11's own text is ever edited, and only in a scratch copy (`P11-AL-25`).
- **Never inside a hard-linked sandbox.** Unlink or copy first, then prove the original's **bytes and inode** are unchanged — the hazard found latent in a Phase 4 security test, where a sandbox helper that bypassed the unlink would have truncated a real migration.
- **As the real principals.** `daftar_migrator` for the migration, the application role and the internal roles for the runtime proofs — never superuser-only, because a superuser bypasses RLS and therefore proves nothing about it.
- **`frozenThrough` is a floor.** If the boundary has legitimately advanced, protect the newer one; never roll back to an older boundary to make something apply.
- **Evidence is per exact SHA**, and a measurement from this container is never a performance claim or release evidence.

**What this does not change:** the status stays `PREPARED / NOT PROMOTED`, nothing is promoted, no migration number exists, and the phase still promotes eleventh. A scratch cluster is a proof, not a promotion.

### P11-AL-27 — the pack surfaces obey the visual identity and UX-state law from the first screen
*New, on §23 of the Master Continuous Mission. It is part of execution, not a later polish pass.*

Every surface the packs add — the apparel matrix builder, the variant grid, lot and expiry pages, serial lookup and the repair workbench — is built to the same law as the rest of the product, from the first commit rather than retrofitted:

- **Identity.** `#2563EB`, `#60A5FA`, `#111827`, `#F3F4F6`, white surfaces; Tajawal; 4pt spacing; RTL for Arabic and LTR for English and Turkish. **No `#9CA3AF` small text on white without an AA contrast proof** — which matters here specifically, because a variant grid and an expiry table are exactly where secondary grey labels get used for density.
- **Every UI state is required, not optional:** loading, skeleton, empty, error, success, permission, locked feature, plan limit, offline, conflict, pending sync. For the packs the ones that are usually forgotten are **locked feature** (a pack the business has no capability for), **plan limit**, and **conflict** — and conflict is a real state here, not a theoretical one: a refused serial or an expired lot arriving from an offline queue *is* a conflict the merchant must see resolved on the server's terms (`P11-AL-17`).
- **Financial success is shown only after the server commits.** A repair invoice or a consumption is never shown as done on an optimistic client write.
- **Countries PS/JO/LB/SY/TR; currency is immutable after the first transaction; no SAR from mockups.** The currency matrix is ILS, JOD, LBP, SYP, TRY, USD, EUR. The packs introduce no currency of their own and no price field, so their only duty is to render money through the existing formatter and never to parse or carry it.
- **UI language is independent of country and store language**, and the staff-console i18n exception does **not** extend to merchant or customer surfaces — so the pack screens are complete in ar/en/tr with no placeholder and no dead button.

**The defect budget applies to all of it:** P0 = 0, P1 = 0, and **P2 = 0 for money, stock, security, tenant, data integrity and the core path.** For this phase that means an overlay that can drift from `stock_levels` is never a deferrable finding, whatever its apparent rarity. Only minor cosmetic issues defer.

---

**V3 of the Master Continuous Mission (2026-10-12) records this phase's races as exercised and rewords the demand as preserve-and-verify.** It changes nothing in the decisions below. Three things in it touch this preparation: PostgreSQL is **settled as the PG16 family with `en_US.utf8`**, which is the family the Pack A proof ran on; **exit codes are required in every handoff**, now printed in the evidence log; and **§7 states an install contract — `0000–0039` as administrator, `0040+` as migrator — that this repository's own `check:deployment-authority` contradicts.** That last one is recorded as a fact correction with citations in `P11-LIVE-DDL-PROOF.md` §6 and raised to the Migration Owner rather than settled here, because a directive disagreeing with the tree is a question, and the house law is that the live code is the fact.

### P11-AL-28 — "no locks, therefore no concurrency" is not a proof
*New, on V2 of the Master Continuous Mission, which refused this preparation's own sentence. It is the only decision in this document that exists because execution contradicted it.*

This preparation wrote, of apparel: *"it has no concurrency case to prove; it adds no deferred conservation trigger and no lock order."* The reasoning was that concurrency risk comes from locks and deferred triggers, and apparel has neither. **V2 refused the inference.** Running the three races it required found two real defects that every single-transaction test passed over (`P11-LIVE-DDL-PROOF.md`, defects 7 and 8).

The law, stated so it binds the overlay packs too:

- **Every invariant that spans two rows or two tables owes a race**, whether or not the design takes a lock. The absence of a lock is what makes a race possible, not what makes it impossible.
- **A row that is read but not locked is not protected.** A closure check implemented as a bare `SELECT` is a race; the registry read takes `FOR KEY SHARE` so the two transactions serialize.
- **A guard whose condition is the absence of a row cannot be fixed by locking.** There is nothing to lock, and only `SERIALIZABLE` gives a predicate lock. The fix is to remove the class of failure — unconditional immutability, owned entirely by the phase's own table — rather than to borrow a lock from another authority. **The cheaper fix was a lock on a row that does not exist; the correct fix was to make the question unaskable.**
- **A race is interleaved by sentinel, never by `sleep()`**: a sleep proves that one ordering happened once. And **a race harness whose setup can fail quietly produces green that means nothing** — two of these three races were silently invalidated once, by a setup helper that ignored return codes while `inventory.stock_level_not_deletable` refused its cleanup. It exits non-zero on any failed setup statement now.

Two gate arms carry it: `race-estate` and `unlocked-closure-read`.

---

## 3. The laws this phase lives or dies by

Stated here, specified with their red proofs in `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md`.

| id | law | kind |
|---|---|---|
| L-P11-02 | no Phase 11 relation carries a monetary value column | structural (DDL grep + end-state assertion) |
| C-SER-01 | for every serial-tracked `(business, warehouse, variant)`: `count(serials in custody at that warehouse) = stock_levels.on_hand`, and `on_hand` is an integer | conservation, SQL-checkable |
| C-SER-02 | a serial's event chain is append-only and strictly alternating `in`/`out`; a serial is in at most one warehouse at a time | chain invariant |
| C-SER-03 | every movement line of a serial-tracked variant carries exactly `abs(qty_delta)` serial events of the matching direction | deferred COMMIT trigger |
| C-SER-04 | a serial cannot be sold twice; the second outbound is refused under the serial's own lock | concurrency |
| C-LOT-01 | `Σ stock_lot_movements.qty_delta = stock_movements.qty_delta` per movement of a lot-tracked variant | deferred COMMIT trigger |
| C-LOT-02 | per-lot on-hand never negative, refused under the lot level row's lock | concurrency |
| C-LOT-03 | `Σ per-lot on_hand = stock_levels.on_hand` for every lot-tracked key | conservation |
| C-LOT-04 | the lot overlay is value-neutral: the same consumption valued through lot A and lot B yields the identical `value_delta_base_minor` | equivalence, executed |
| C-FEFO-01 | `inventory_pick_lots` is a function of `(key, qty, as_of, policy)` only — deterministic, machine-clock-free, and refuses rather than partially picking | determinism |
| C-REP-01 | no `stock_movements` row ever has a repair-intake source; the customer's device is not stock | structural (registry absence + red proof) |
| C-REP-02 | a repair part consumption appears exactly once in the ledger, under the five-part identity, and its COGS posts through the existing accounting bridge | integration |
| C-REP-03 | billing a consumed repair part produces zero additional `stock_movements` rows and zero additional COGS postings; one consumption is billed at most once, for its full quantity | integration, counted before/after |
| C-REP-04 | no Phase 11 relation holds a customer money balance; a repair deposit exists only as canonical Phase 4 unapplied payment / customer credit | structural (absence) |
| C-WAR-01 | a warranty is anchored to a committed sale, sale line and serial/item where applicable, and its issuance facts are never deleted or updated — the lifecycle is an append-only chain | append-only chain invariant |
| C-APP-01 | `product_variants.attributes` of a matrix product is a closed canonical map over the business's registered axes, unique per product; base variants stay `'{}'` | catalog invariant |

Three of these are the ones a challenger should attack first, because they are the ones that would corrupt data rather than merely annoy a user: **C-SER-03** (if the deferred trigger is satisfiable by zero events on some path, the overlay silently drifts from on-hand for ever) **C-LOT-03** (a per-lot cache that can disagree with `stock_levels` is a second quantity truth wearing a cache's clothes) and **C-REP-03** (whose failure mode is free inventory, and which is the law that exists only because the first draft got it wrong).

---

## 4. The three overlays, concretely

### 4.1 Apparel (`catalog.variant-matrix`)
New relations: `product_attribute_axes (business_id, axis_code, translations, sort_order, status)`, `product_attribute_values (business_id, axis_code, value_code, translations, sort_order, status)`, and a canonicalization trigger on `product_variants` plus `product_variants_matrix_uq`. New entry routine `catalog_generate_variant_matrix(product, axes[], values[][])` creating the cross product in one transaction, refusing a combination that already exists and refusing more than a bounded number of variants per call. No inventory change at all: each combination is already a stock key. This is the cheapest of the four packs and the right one to build first, because it proves the pack mechanism end-to-end (registry → capability → entry routine → screens → ar/en/tr) without touching the ledger.

### 4.2 Lot / expiry (`inventory.lot-expiry`)
Relations `stock_lots`, `stock_lot_movements`, `stock_lot_levels`; routines `inventory_lot_fold`, `inventory_lot_verify`, `inventory_pick_lots`; the per-lot write happens **inside the same statement** as `inventory_apply_stock_movements`, which means that writer gains a lot-aware input. That is the one place Phase 11 asks to change a core routine, and it is a real risk: `inventory_apply_stock_movements` is the single writer and its request type `inventory_movement_request` (`0060:62-73`) is the contract everything calls. The patch request therefore specifies the change as **an added nullable array member plus a new overload**, never a `CREATE OR REPLACE` that changes the return shape (the P4-S7 ruling: no invalid `CREATE OR REPLACE` return-shape change), and names the lot assignment as part of the *request*, so no second writer appears.

### 4.3 Serial / IMEI (`inventory.serial-tracking`)
Relations `stock_serials`, `stock_serial_events`; the same in-statement rule; `inventory_serial_assert_available(business, serial_id, warehouse)` as a `STABLE` read used by the sale/repair paths **before** the write, with the real enforcement at the write under the serial's row lock (a precondition at a call site is not a property of the function — `daftar-a-precondition-at-a-call-site-is-not-a-property-of-the-function`; so the guard is duplicated deliberately and the write-side one is authoritative).

### 4.4 Repair (`repairs` — a capability key that does not exist yet)
`repairs` is named in the comment at `capabilities.ts:6` but is **not** in `DEFINITIONS`. Adding it is a Phase 11 patch to `packages/domain-core/src/capabilities.ts` plus a `REPAIR_PACK` feature row. Relations: `repair_tickets`, `repair_devices`, `repair_device_custody_events`, `repair_diagnoses`, `repair_parts` (the document line that the bridge binds), `repair_status_events`, `warranties`, `warranty_claims`. Entry routines: intake, diagnose, consume parts, change status, hand back. Billing: a Phase 4 sales invoice, created by the existing command.

---

## 5. What Phase 11 explicitly does NOT do

- No lot or serial **costing**, and **no monetary column of any kind** on a lot, serial or repair relation — not even a non-authoritative snapshot (`TL-P11-R2`, §55). No FIFO/LIFO valuation layer.
- **No expiry override.** Refuse is the whole Phase 11 behaviour (`TL-P11-R4`); an override belongs to a future country or regulated pack with its own permission, audit and policy.
- **No second stock effect for a billed repair part** (`TL-P11-R7`), and no repair-authored journal logic (§62).
- No legal conclusion in a column name: the terminal custody state is `uncollected`, never `abandoned` (§63).
- No tax. OD-03 stands: sales tax is a structural zero in Phase 4 and a non-zero tax is refused, never normalized. Phase 11 adds no tax field and no country rule.
- No warranty provision, accrual or liability.
- No repair receivable, repair payment, repair credit or repair balance.
- No second stock reservation ledger (the Phase 6 prohibition applies here too).
- No change to `stock_levels`' key or columns, and no change to the costing arithmetic in `0060`.
- No migration number, and no DDL applied anywhere.

---

## 6. Interfaces the pack needs from other phases

| from | what Phase 11 needs | status |
|---|---|---|
| Phase 4 | the sales invoice command, customer payments/credits, and the `sale` source type (`0077:1238-1239`) as the billing path for repairs | **not sealed.** Phase 11 binds to it only when it seals; until then `WAITING_FOR_INTEGRATED_SURFACE`, never PASS (Master Part 23's vocabulary). |
| Phase 1 | the entitlement/capability foundation and the permission registry | exists; Phase 11 adds permission keys and a plan/feature row, no second entitlement truth |
| Phase 5 | plan gating of the packs (which plan includes `REPAIR_PACK`) | not started; Phase 11 specifies the feature rows and lets Phase 5 price them |
| Phase 7 | offline capture of serial/lot and replay refusal semantics (P11-AL-17) | not started; the contract is stated here so Phase 7 can honour it |
| Phase 13 | expiry and ageing reports, serial history reports — read-only derivatives | not started |

---

## 6a. The surfaces a new pack must touch (read off the P4-S4 precedent)

A domain module in this repo is not a directory; it is a fixed list of edits across owned files. `apps/api/src/modules/receivables/receivables.module.ts` keeps that list explicitly as `P4_S4_REQUIRED_WIRING` — frozen rows of `{ file, edit, why }`, cited by number from three suites. Phase 11 copies the mechanism and keeps its own `P11_REQUIRED_WIRING`. The list, per pack:

| surface | file | what Phase 11 owes it |
|---|---|---|
| capability registry | `packages/domain-core/src/capabilities.ts:26-33` | `implemented: true` for `catalog.variant-matrix`, `inventory.serial-tracking`, `inventory.lot-expiry` **at promotion**, plus a new `repairs` definition (named in the header comment at `:6` but absent from `DEFINITIONS`) |
| capability ↔ entitlement mapping | `packages/domain-core/` (new) | the two vocabularies are unmapped today (`inventory.lot-expiry` vs `LOT_EXPIRY`). One frozen mapping, in `domain-core`, tested exhaustively both ways. Task `P11-CAP-002`. |
| industry profiles | `packages/domain-core/src/industry-profiles.ts:27-31` | a `repair` profile key; `apparel`/`electronics`/`pharmacy` already map correctly. Advisory only — never read in a financial path (`:10-11`). |
| entitlement feature registry | a new append-only migration | `VARIANT_MATRIX` and a repair feature key; `SERIAL_TRACKING` and `LOT_EXPIRY` already seeded (`0007:94-96`). The registry is an FK target, so an unregistered key is refused at the DB. |
| permission registry | `packages/domain-core/src/permissions.ts` | new keys as `<plural-domain-noun>.<verb>` matching `^[a-z]+(\.[a-z_]+)+$` (pinned in `0054:53`), **plus** `SENSITIVE_PERMISSIONS` (`:96`), `isPermission()` (`:150`), `BUILTIN_ROLE_PERMISSIONS` (`:156`, append only, never reorder, no sensitive key as a built-in default), the `PERMISSIONS` re-export in `shared-contracts`, **and** a defaults-backfill migration on the `0076_phase4_permission_defaults_backfill.sql` precedent — five declarations and one migration per permission, not one. |
| operation codes | `apps/api/src/modules/inventory/inventory-authorization.ts` | a row in `OPERATION_AUTHORITY` per op code; the record has no default, so an unmapped code fails to compile — the protection to keep, not route around. |
| API module | `apps/api/src/modules/<pack>/` | the flat file set: `<pack>.controller.ts` (`@Controller('/v1')`, full resource path per method), `<pack>.module.ts` exporting a **provider factory** (`<pack>Providers(): Provider[]`) not a Nest `@Module`, `<pack>.schemas.ts` (zod, every object `.strict()`), `<pack>-contracts.ts`, `<pack>-errors.ts`, `<pack>-refusal-audit.ts`, `<pack>-permissions.ts` (narrowed decorator + frozen route-authority table), `<pack>-reads.ts`, one `<aggregate>-<verb>.service.ts` per command |
| process composition | `apps/api/src/app/app.module.ts` **and** `apps/api/src/app/merchant-api.module.ts` | providers spread into **both**; `tests/integration/process-composition.test.ts` holds the two lists to each other, and a controller in only one composition is an untestable route |
| one transaction | `apps/api/src/infra/database.ts:919` | commands run through `withBusinessInventoryAccountingTransaction(scope, inventoryAssertions, accountingAssertions, fn)`; assertions are minted **before** the seam opens; nesting is refused (`seam.nested_transaction`, `:861-865`); unused assertions red the COMMIT |
| audit | `apps/api/src/modules/audit/` | success audit and outbox are written **by the SQL routine** in the same transaction (the Phase 4 convention); refusals go through the single `auditThenRethrowRefusal` composer, which the gate's `command-refusal-audit` check discovers and requires |
| contracts | `packages/shared-contracts/src/<pack>.ts` + one `export * from './<pack>'` in `src/index.ts` | `…Dto` types as plain interfaces (never zod), money as **decimal strings of minor units** in `…Minor` / `…BaseMinor` fields, lists as `{ items }`, commands returning `replayed: boolean`. The contract test's value is that it stops **compiling** the day a money field becomes a JSON number. |
| refusal → HTTP | `<pack>-errors.ts` + `apps/web/src/lib/client.ts:180` | a closed `<PACK>_STATUS` map of `code → 400|404|409|422|500` (`satisfies Readonly<Record<...>>`), the dotted domain code travelling in `details.<pack>Code`, the new field name added to `DOMAIN_CODE_FIELDS` (enforced by `apps/web/test/domain-code-fields.test.ts`), and internal invariants mapped to **500, never a merchant outcome** |
| web screens | `apps/web/src/app/[locale]/<area>/page.tsx` + `<area>-page-kit.ts` + `apps/web/src/views/<area>/{View.tsx,model.ts,parts.tsx,registry.tsx}` | the three-part split; the view **registry is mandatory** and the new area must be added to `PAGE_AREAS` in `apps/web/test/helpers/registries.ts:14`, or `unregisteredPageAreas()` reds. Nav row in `AppHeader.tsx:12-30` with its `requires` permission. Locked pack renders `FeatureLockedState` / `PlanLimitState`. |
| styling | `packages/design-system` | tokens only, **logical CSS properties only** — a physical side (`marginLeft`, `text-align: left`) is refused by `apps/web/test/rtl-mirror.test.tsx` via `layout-rules.ts` |
| localization | `apps/web/src/messages/{ar,en,tr}.json` | identical key sets in all three (915 keys today), `namespace.camelCase` keys, `error.<code>` for every new refusal code, no JSX text literal outside `t()`, no merchant-facing accounting jargon — all enforced by `npm run check:localization` (`scripts/check-localization.ts`) and `apps/web/test/jargon.test.ts`. Business-authored names (axis values, lot labels, warranty terms) are `translations JSONB` **data**, not keys. |
| android | `apps/android/app/src/main/java/app/daftar/ui/<feature>/` + a `composable(...)` row in `DaftarNavHost` + 3× `strings.xml` | serial/lot capture is input only (P11-AL-17). There is **no** local persistence layer today (no Room/SQLite/DataStore) and `scripts/static-guards.ts:76` `android-no-db` forbids one — so no offline pack state before Phase 7. |
| gate | `scripts/phase11-s<N>-gate.ts` + `gate:phase11:s<N>` + an unconditional step in the required `backend` CI job | the `scripts/phase4-s4-gate.ts` shape: exported `CHECKS: readonly Check[]` of `{ id, title, run(root): string[], ok, note? }`, predecessor gates composed by **importing their assertions** rather than spawning them, and the verdict of any spawned run read off the **result object**, never through a pipe |

---

## 7. Deliverables of this preparation

| file | content |
|---|---|
| `P11-S0-VERTICAL-PACK-ARCHITECTURE.md` | this document — the decisions |
| `P11-MIGRATION-PATCH-REQUEST.md` | the complete DDL specification with **no number**: tables, columns, constraints, indexes, triggers, functions, RLS, grants, ownership bracket, end-state assertion, fresh-install and upgrade concerns |
| `P11-CONSERVATION-LAWS-AND-RED-PROOFS.md` | every law of §3 with its executable check and its named red proof |
| `P11-TASK-DAG.md` | the task DAG (`P11-…` ids) with dependencies, file ownership and the parallelism map |
| `P11-OPEN-DECISIONS.md` | the owner decisions (OD-P11-01 … OD-P11-07) with a recommendation each |
| `P11-HANDOFF-MANIFEST.md` | **required gate (PART 13)** — phase, exact prep SHA, branch, status, every artifact with its location and whether it is committed, SHA256 for the off-Git copies, evidence files, the migration patch request, shared-file patch requests, open decisions, Challenger and Coordinator state, unresolved blockers |
| `P11-S0-REPORT-AR.md` | the Arabic report for the Tech Lead |

---

## 7a. Pre-mortem (PART 115)

Asked before promotion, not after. Ten questions, each answered with the structure that answers it — a prose assurance is not an answer.

| how could this… | the honest answer today |
|---|---|
| **duplicate money?** | The only place it could is repair billing, and it is exactly where the first draft did (§60). Now: one physical consumption, one binding per consumption keyed by PK, `qty` equal to the consumption's, the bound sale line proved to carry no movement, and revenue/AR/cash untouched in the sales authority. The deposit adds no second money truth because Phase 11 creates no money relation at all (`C-REP-04`). **Residual:** the Accounting Owner's posting map is unruled, so duplicate COGS at invoice time is `UNMEASURED`, not closed — which is why `P11-REP-008` blocks that subfeature. |
| **lose money?** | A warranty row deleted on a return would lose the *record*, not the money, and `C-WAR-01` makes it append-only. Valuation cannot drift because the overlay carries no value and `C-LOT-04` compares against the pre-Phase-11 oracle rather than against itself. |
| **leak tenant data?** | Every new relation gets `ENABLE`+`FORCE`, `tenant_membership` with both clauses, restrictive `business_isolation`, a denormalized `tenant_id` with the composite FK, and its `*_internal_read` policy **in the same migration** that enables RLS — the P4-S7 lesson, where a relation with RLS and zero policies made its validator refuse everything. T4 proves it from a non-superuser session. **The guard shape is the risk:** no Phase 11 guard is written as `IF count(*) = 0 THEN allow`, because under RLS absent and invisible are one answer. |
| **duplicate stock?** | `stock_movements_identity_uq` under the five-part identity makes replay structural, and Phase 11 writes no movement itself — one writer, no second path, proved by a source arm asserting zero Phase 11 writes to `stock_movements`. The billing binding is the case where a second effect was *designed in* once; `C-REP-03` counts rows before and after rather than reading code. |
| **deadlock?** | Phase 9 found this by execution, not reading (`40P01`). The lock order here is a **suffix** of the existing one — stock targets, then lots by `lot_id` ascending, then serials by id ascending — never an interleave, and the deadlock test runs **both** orders. |
| **replay twice?** | The server mints no identity Phase 11 owns; the five-part identity is the inventory authority's. Offline capture is input only (`P11-AL-17`), and Phase 7 found the live `ApiClient` mints its key at **send** time — a defect that belongs to Phase 7's promotion, recorded here so Phase 11 does not assume otherwise. |
| **fail upgrade?** | The patch request names no number and re-reads the live effective definition at allocation time, so it cannot be built against a stale predecessor. T2 applies it **as `daftar_migrator`**, and the §12 lesson from Phase 4 is honoured: a fresh install and a real upgrade from the frozen head are proved **before** anything else is signed, because proving the migration applies is what makes a candidate a candidate. |
| **create second truth?** | The question this whole phase is organized around. Three places it could: the costing key (answered by Option B — overlays carry no value), the per-lot quantity cache (`C-LOT-03` folds it against `stock_levels`), and money (`C-REP-04` — no deposit ledger, no repair balance). A fourth was almost created and is now forbidden: a partial-billing allocation ledger (PART 67's v1 rule). |
| **silently drop rows?** | The aging-bucket off-by-one in Phase 4's `aging()` is the house precedent: a silent `continue` on an impossible value. Every Phase 11 fold and chain **fails loudly** — gap-free `event_seq` checked rather than assumed, an unknown transition refused rather than ignored, and no `continue` on an unexpected row anywhere. |
| **create cross-container false evidence?** | This container is not the authoritative box. No timing or performance number appears in any Phase 11 document, and none was measured; the budget *lane* is owed from the Performance Owner on the exclusive box. A finding from here about another thread's tree is a **lead**, never a verdict (`TL-P4-COORD-R39`), and every claim in these six documents is labelled with one evidence class and never two. |

Promotion waits for closure of these, not for their enumeration. **Eight of them were closed by running the thing rather than by writing about it, and two of those eight — the races — only because V2 refused the sentence that said they did not exist.**

---

## 8. Honest limits of this document

- It was written from a **read** of the tree at `93084f8`, and that is no longer the whole story: **Pack A (apparel) has since been applied, unnumbered, to a scratch cluster at `d813de2`**, with 21 serial cases and 3 real-concurrency races green over the frozen prefix applied **as `daftar_migrator`** (`P11-LIVE-DDL-PROOF.md`, raw log `prep/phase11/harness/RUN-EVIDENCE-AUTHORITATIVE-d813de2.txt`). So `C-APP-01` and `C-APP-02` are `PROVEN BY TEST` and the live RLS shape on `stock_levels` is `PROVEN BY DATABASE CATALOGUE`. **That is not CI**, no npm suite ran (this container is Node 22.22.0 against `engines.node >=24 <25`), no gate exists yet, and lot, serial and repair remain untouched by any run. Every verdict outside those is therefore still `SPEC ONLY` or `UNMEASURED`, never combined with another class (§82 classes: `PROVEN IN LIVE CODE` / `PROVEN BY TEST` / `PROVEN BY DATABASE CATALOGUE` / `DESIGN ONLY` / `SPEC ONLY` / `UNMEASURED` / `BLOCKED` / `WAITING_FOR_INTEGRATED_SURFACE`), and this document says so rather than implying design equals proof. The S7 lesson is the standing one: **a spec is design until a parser has had an opinion, and still design until the principal that will apply it has had one.**
- `0080`–`0086` are unfrozen. Any citation into them describes a candidate, not frozen law, and the patch request re-reads the live effective definition at allocation time instead of pinning a number.
- `PROJECT_STATUS.md` at this head still describes the S4 candidates as `0080`–`0082`, while the tree carries `0080`–`0086`. That is documentation drift, recorded here and not silently corrected: the live code is the fact (Master Part 1), and the canonical status page belongs to the coordinator, not to this preparation.
