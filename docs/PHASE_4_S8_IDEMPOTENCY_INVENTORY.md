# PHASE 4 — P4-S8 — THE IDEMPOTENCY KEY INVENTORY

**GENERATED — do not edit by hand.** Regenerate with `npx tsx scripts/phase4-s8/generate-inventories.ts`; `--check` refuses a tree in which this file disagrees with the live one.

| | |
|---|---|
| generated from | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| generator | `scripts/phase4-s8/generate-inventories.ts` |
| discovery | the migration files, the permission registry and the workflow, read at generation time — never a hand-written list |

Every idempotency key in the system. `P4-AL-30`: idempotency is a caller-supplied document UUID plus a stored `intent_sha256`, read before any
other read, under a per-document lock. There is no `idempotency_key` column — except the one on `onboarding_operations` (`0018:7`), which is
Phase 1, is listed here, and is the counter-example the decision was taken against.

`[[daftar-idempotency-key-is-not-permission]]` — a bare key proves a request was SEEN before and says nothing about WHICH request it was, so a
replay carrying the same key and different content would be answered "success". Hence the **intent hash** column.

`[[daftar-registry-before-state]]` — the proof is consulted BEFORE any real change, or a stale request replayed after a later transition performs a
second real change. Hence the **registry before change** column, which is MEASURED from the body (the intent read offset against the first
INSERT/UPDATE/DELETE) rather than asserted.

**THE DISCOVERY RULE**, stated so it can be refuted: a routine is a replay path if and only if its body reads an `*intent_sha256` column into a
variable. That is the mechanism `P4-AL-30` names.

## The 24 keys

| routine | migration | identity relation | identity arg | intent hash | identity guard | exact replay returns | changed intent conflicts on | registry before change | locks before intent | backing UNIQUEs |
|---|---|---|---|---|---|---|---|---|---|---|
 | `customer_apply_credit` | 0081_phase4_customer_payments_credits.sql | `customer_credit_applications` | `p_application_id` | `intent_sha256` | advisory | the stored rows of a (shape not resolvable from the body text) | `customer_credit_application.idempotency_conflict` | yes | **NO** | `customer_credit_applications_level_uq`, `customer_credit_applications_invoice_level_uq` | 
 | `customer_collect_payment` | 0085_phase4_allocation_recompute_set_based.sql | `payments` | `p_payment_id` | `intent_sha256` | advisory | the stored rows of h (shape not resolvable from the body text) | `customer_payment.idempotency_conflict` | yes | **NO** | `payments_identity_uq` | 
 | `inventory_adjust_stock` | 0062_inventory_movement_commands.sql | `inventory_adjustments` | `p_adjustment_id` | `intent_sha256` | advisory | the stored rows of a (shape not resolvable from the body text) | `inventory.idempotency_conflict` | yes | n/a | — | 
 | `inventory_record_damage` | 0062_inventory_movement_commands.sql | `inventory_adjustments` | `p_adjustment_id` | `intent_sha256` | advisory | the stored rows of a (shape not resolvable from the body text) | `inventory.idempotency_conflict` | yes | n/a | — | 
 | `inventory_record_opening` | 0062_inventory_movement_commands.sql | `inventory_openings` | `p_opening_id` | `intent_sha256` | advisory | the stored rows of o (shape not resolvable from the body text) | `inventory.idempotency_conflict` | yes | n/a | — | 
 | `inventory_stocktake_finalize` | 0062_inventory_movement_commands.sql | `stocktakes` | `p_stocktake_id` | `finalize_intent_sha256` | row | the stored rows of s (shape not resolvable from the body text) | `inventory.stocktake_state_invalid` | yes | n/a | — | 
 | `inventory_stocktake_open` | 0062_inventory_movement_commands.sql | `stocktakes` | `p_stocktake_id` | `intent_sha256` | advisory | the stored rows of s (shape not resolvable from the body text) | `inventory.idempotency_conflict` | yes | n/a | — | 
 | `inventory_transfer_stock` | 0062_inventory_movement_commands.sql | `inventory_transfers` | `p_transfer_id` | `intent_sha256` | physical | the stored rows of t (shape not resolvable from the body text) | `inventory.idempotency_conflict` | yes | **NO** | — | 
 | `payment_method_create` | 0068_supplier_settlement_commands.sql | `payment_methods` | `p_payment_method_id` | `create_intent_sha256` | advisory | the stored rows of m (shape not resolvable from the body text) | `payment_method.idempotency_conflict` | yes | n/a | `payment_methods_account_uq` | 
 | `pos_till_session_close` | 0079_phase4_pos_till_sessions_cart.sql | `pos_till_sessions` | `p_session_id` | `close_intent_sha256` | row | the stored rows of s (shape not resolvable from the body text) | `pos.session_idempotency_conflict` | yes | n/a | `pos_till_sessions_actor_uq` | 
 | `pos_till_session_open` | 0079_phase4_pos_till_sessions_cart.sql | `pos_till_sessions` | `p_session_id` | `open_intent_sha256` | advisory | the stored rows of s (shape not resolvable from the body text) | `pos.session_idempotency_conflict` | yes | n/a | `pos_till_sessions_actor_uq` | 
 | `purchase_cancel` | 0064_purchase_commands.sql | `purchases` | `p_purchase_id` | `cancel_intent_sha256` | advisory | the stored rows of p (shape not resolvable from the body text) | `purchase.state_invalid` | yes | n/a | `purchases_warehouse_uq`, `purchases_supplier_uq` | 
 | `purchase_return` | 0066_supplier_return_reversal_commands.sql | `supplier_returns` | `p_return_id` | `intent_sha256` | advisory | the stored rows of r (shape not resolvable from the body text) | `supplier_return.idempotency_conflict` | yes | **NO** | `supplier_returns_purchase_uq`, `supplier_returns_credit_note_uq` | 
 | `purchase_reverse` | 0066_supplier_return_reversal_commands.sql | `purchase_reversals` | `p_purchase_id` | `intent_sha256` | advisory | the stored rows of r (shape not resolvable from the body text) | `purchase_reversal.already_reversed` | yes | yes | `purchase_reversals_original_entry_uq` | 
 | `purchase_write_off_residue` | 0072_purchase_sub_unit_residue.sql | `purchase_residue_write_offs` | `p_purchase_id` | `intent_sha256` | advisory | the stored rows of w (shape not resolvable from the body text) | `purchase_residue.already_written_off` | yes | yes | `purchase_residue_write_offs_purchase_uq` | 
 | `sale_commit` | 0078_phase4_sale_commit.sql | `sales` | `p_sale_id` | `commit_intent_sha256` | advisory | the stored rows of s (shape not resolvable from the body text) | `sale.idempotency_conflict` | yes | **NO** | — | 
 | `supplier_allocate_credit` | 0068_supplier_settlement_commands.sql | `supplier_credit_allocations` | `p_allocation_id` | `intent_sha256` | advisory | the stored rows of c (shape not resolvable from the body text) | `supplier_credit_allocation.idempotency_conflict` | yes | **NO** | `supplier_credit_allocations_level_uq` | 
 | `supplier_archive` | 0064_purchase_commands.sql | `suppliers` | `p_supplier_id` | `last_intent_sha256` | advisory | the stored rows of s (shape not resolvable from the body text) | `supplier.revision_changed` | yes | n/a | — | 
 | `supplier_create` | 0064_purchase_commands.sql | `suppliers` | `p_supplier_id` | `create_intent_sha256` | advisory | the stored rows of s (shape not resolvable from the body text) | `supplier.idempotency_conflict` | yes | n/a | — | 
 | `supplier_pay` | 0068_supplier_settlement_commands.sql | `supplier_payments` | `p_payment_id` | `intent_sha256` | advisory | the stored rows of s (shape not resolvable from the body text) | `supplier_payment.idempotency_conflict` | yes | **NO** | `supplier_payments_identity_uq` | 
 | `supplier_reactivate` | 0064_purchase_commands.sql | `suppliers` | `p_supplier_id` | `last_intent_sha256` | advisory | the stored rows of s (shape not resolvable from the body text) | `supplier.revision_changed` | yes | n/a | — | 
 | `supplier_receive_refund` | 0068_supplier_settlement_commands.sql | `supplier_refunds` | `p_refund_id` | `intent_sha256` | advisory | the stored rows of f (shape not resolvable from the body text) | `supplier_refund.idempotency_conflict` | yes | **NO** | `supplier_refunds_level_uq` | 
 | `supplier_update` | 0064_purchase_commands.sql | `suppliers` | `p_supplier_id` | `last_intent_sha256` | advisory | the stored rows of s (shape not resolvable from the body text) | `supplier.revision_changed` | yes | n/a | — | 
 | `(none — the key is the row's own PRIMARY KEY on onboarding_operations)` | 0018_onboarding_operations.sql | `onboarding_operations` | `p_key` | `payload_hash` | physical | the recorded result tenant/business of the first call | **none found** | n/a | n/a | `PRIMARY KEY (user_id, idempotency_key)` | 

### The three accepted identity guards

All three serialise two concurrent replays of one document, and the inventory records WHICH each routine uses rather than reporting the two that
are not the advisory lock as defects:

| guard | mechanism | example |
|---|---|---|
| `advisory` | the per-document `pg_advisory_xact_lock` `P4-AL-30` names | `customer_collect_payment` under `daftar.payment_id` |
| `row` | `SELECT … FOR UPDATE` on the identity row itself | `pos_till_session_close` (`0079:1003`) |
| `physical` | `INSERT … ON CONFLICT DO NOTHING`, `GET DIAGNOSTICS`, re-read and compare — the UNIQUE itself is the lock | `inventory_transfer_stock` (`0062:325-339`) |

## Findings — 0

_None._ Every discovered replay path carries an intent digest, an identity guard, a registry-before-change ordering and a conflict refusal.

## What is NOT yet in this inventory, and why

| key | owed by | why it is absent |
|---|---|---|
| the credit-note / return replay path | `P4-S5` | no `credit_notes` relation exists, so no routine reads a `credit_notes.intent_sha256` |
| the refund replay path | `P4-S5` | no `refunds` relation exists |
| the reversal `provider_reference` partial unique | `P4-S6` | **no column in the whole tree matches `provider_reference`.** `P4-AL-30` requires a replayed payment-provider webhook to be refused PHYSICALLY by a partial unique on `(business_id, provider_source, provider_reference)`. The S8 check for it reports `WAITING_FOR_INTEGRATED_SURFACE`, never PASS |
| the installment-plan replay path | `P4-S7` | no `installment_plans` relation exists |
