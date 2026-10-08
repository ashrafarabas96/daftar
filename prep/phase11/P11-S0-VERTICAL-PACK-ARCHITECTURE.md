# P11-S0 — PHASE 11 VERTICAL-PACK ARCHITECTURE (Apparel · Electronics · Repair · Lot/Expiry)

**status** `PREPARED / NOT PROMOTED` — `DESIGN / SPEC ONLY` (Tech Lead §52 of the 2026-10-08 audited directive)
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
A **new additive Phase 11 contract extension** — added by Phase 11, **not** by Phase 10, and **not registered dead in Phase 10** — created only once a real repair writer exists. A sale line may be marked as billing stock that was already consumed elsewhere, under all eight conditions together:

| # | condition | why it is load-bearing |
|---|---|---|
| 1 | **server-derived** | the binding is computed from the repair record, never accepted as a field |
| 2 | **the client cannot choose it** | otherwise any client could bill a tracked item with no stock effect — a free-inventory hole |
| 3 | names the **exact repair part source** | so the binding is to one identified consumption, not to a quantity that looks similar |
| 4 | **exact qty** | a binding for less or more than was consumed is refused, not reconciled |
| 5 | **same business** | the tenant and business pair is pinned structurally, like every other relation |
| 6 | **one billing binding** | a consumption may be billed once; the second attempt is refused, enforced by a uniqueness constraint rather than by a check in code |
| 7 | **a prior canonical stock movement exists** | a binding with no movement behind it is refused — the fail-open case, and the one a test must plant |
| 8 | **zero second movement, zero second COGS**; revenue/AR/cash still through the sales authority | the whole point of the extension |

Condition 7 is the one to attack first: a binding that can be created *before* the consumption exists re-opens §60 by another door.

### P11-AL-12 — warranty is a record, not an accounting estimate
*Ruled: `TL-P11-R5` — record `source` (business or vendor), `starts_on` and `ends_on` explicitly; **no warranty inferred from a product category**; no accounting provision or accrual in Phase 11.*
`warranties (business_id, id, sale_id, sale_line_id, serial_id NULL, starts_on, ends_on, source IN ('business','vendor'), terms_translations JSONB)`, plus `warranty_claims` linking a claim to a repair ticket. Phase 11 gives warranty **no financial effect**: no warranty provision, no accrual, no liability. A warranty-covered repair is a repair whose parts still post COGS and whose invoice total may be zero-rated by a business decision at the sale, through the ordinary Phase 4 path. A warranty provision is a future accounting phase decision, not this one.

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
| C-APP-01 | `product_variants.attributes` of a matrix product is a closed canonical map over the business's registered axes, unique per product; base variants stay `'{}'` | catalog invariant |

Two of these are the ones a challenger should attack first, because they are the ones that would corrupt data rather than merely annoy a user: **C-SER-03** (if the deferred trigger is satisfiable by zero events on some path, the overlay silently drifts from on-hand for ever) and **C-LOT-03** (a per-lot cache that can disagree with `stock_levels` is a second quantity truth wearing a cache's clothes).

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
| `P11-S0-REPORT-AR.md` | the Arabic report for the Tech Lead |

---

## 8. Honest limits of this document

- It is written from a **read** of the tree at `93084f8`. No DDL here has been applied to a cluster, no suite has been run, no gate exists yet. Every verdict in this phase is therefore `SPEC ONLY` or `UNMEASURED`, never combined with another class (§82 classes: `PROVEN IN LIVE CODE` / `PROVEN BY TEST` / `PROVEN BY DATABASE CATALOGUE` / `DESIGN ONLY` / `SPEC ONLY` / `UNMEASURED` / `BLOCKED` / `WAITING_FOR_INTEGRATED_SURFACE`), and this document says so rather than implying design equals proof. The S7 lesson is the standing one: **a spec is design until a parser has had an opinion, and still design until the principal that will apply it has had one.**
- `0080`–`0086` are unfrozen. Any citation into them describes a candidate, not frozen law, and the patch request re-reads the live effective definition at allocation time instead of pinning a number.
- `PROJECT_STATUS.md` at this head still describes the S4 candidates as `0080`–`0082`, while the tree carries `0080`–`0086`. That is documentation drift, recorded here and not silently corrected: the live code is the fact (Master Part 1), and the canonical status page belongs to the coordinator, not to this preparation.
