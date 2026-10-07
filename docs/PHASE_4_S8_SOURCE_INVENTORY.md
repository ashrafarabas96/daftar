# PHASE 4 — P4-S8 — THE ACCOUNTING SOURCE, STOCK SOURCE AND OPERATION-KIND INVENTORY

**GENERATED — do not edit by hand.** Regenerate with `npx tsx scripts/phase4-s8/generate-inventories.ts`; `--check` refuses a tree in which this file disagrees with the live one.

| | |
|---|---|
| generated from | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| generator | `scripts/phase4-s8/generate-inventories.ts` |
| discovery | the migration files, the permission registry and the workflow, read at generation time — never a hand-written list |

Discovered from the `INSERT INTO` statements of the migration estate: **17 accounting source types**,
**10 stock source types**, **36 operation kinds**.

`TL-P4-S1-R1` and `TL-P4-S2-K1`: an accounting source type may not exist as a dead registry concept, and an `inventory_operation_kinds` row is a
registration of AUTHORITY — registering one with no writer creates live authority with no command. The **writer** column is therefore measured as
"the name appears somewhere other than its own registration INSERT", and `no` is a finding.

## Accounting source types

| source type | registered by | binds its entry | deferred completeness validator | writer |
|---|---|---|---|---|
| `customer_credit` | 0081_phase4_customer_payments_credits.sql | yes | yes | yes |
| `customer_credit_application` | 0081_phase4_customer_payments_credits.sql | yes | yes | yes |
| `customer_payment_allocation` | 0081_phase4_customer_payments_credits.sql | yes | yes | yes |
| `inventory_adjustment` | 0061_inventory_movement_sources.sql | yes | yes | yes |
| `inventory_opening` | 0061_inventory_movement_sources.sql | yes | yes | yes |
| `invoice` | 0077_phase4_sales_sale_items_sources.sql | yes | yes | yes |
| `manual_adjustment` | 0042_accounting_journal.sql | yes | yes | yes |
| `negative_inventory_cost_adjustment` | 0063_purchases_suppliers_sources.sql | yes | yes | yes |
| `opening_balance` | 0042_accounting_journal.sql | yes | yes | yes |
| `purchase` | 0063_purchases_suppliers_sources.sql | yes | yes | yes |
| `purchase_residue_write_off` | 0072_purchase_sub_unit_residue.sql | yes | yes | yes |
| `reversal` | 0042_accounting_journal.sql | yes | yes | yes |
| `sale` | 0077_phase4_sales_sale_items_sources.sql | yes | yes | yes |
| `supplier_credit_allocation` | 0067_payment_methods_supplier_settlement_sources.sql | yes | yes | yes |
| `supplier_payment` | 0067_payment_methods_supplier_settlement_sources.sql | yes | yes | yes |
| `supplier_refund` | 0067_payment_methods_supplier_settlement_sources.sql | yes | yes | yes |
| `supplier_return` | 0065_supplier_returns_reversals_sources.sql | yes | yes | yes |

## Stock source types

| source type | registered by | writer |
|---|---|---|
| `inventory_adjustment` | 0061_inventory_movement_sources.sql | yes |
| `inventory_opening` | 0061_inventory_movement_sources.sql | yes |
| `inventory_transfer` | 0061_inventory_movement_sources.sql | yes |
| `negative_inventory_cost_adjustment` | 0063_purchases_suppliers_sources.sql | yes |
| `probe_0074` | 0074_phase4_registry_widening.sql | yes |
| `purchase` | 0063_purchases_suppliers_sources.sql | yes |
| `purchase_reversal` | 0065_supplier_returns_reversals_sources.sql | yes |
| `sale` | 0077_phase4_sales_sale_items_sources.sql | yes |
| `stocktake` | 0061_inventory_movement_sources.sql | yes |
| `supplier_return` | 0065_supplier_returns_reversals_sources.sql | yes |

## Operation kinds

| op code | registered by | writer |
|---|---|---|
| `customer_payment.collect` | 0074_phase4_registry_widening.sql | yes |
| `customer.apply_credit` | 0081_phase4_customer_payments_credits.sql | yes |
| `customer.collect_payment` | 0074_phase4_registry_widening.sql | yes |
| `inventory.adjust` | 0062_inventory_movement_commands.sql | yes |
| `inventory.configure_product` | 0054_inventory_assertion_authority.sql | yes |
| `inventory.damage` | 0062_inventory_movement_commands.sql | yes |
| `inventory.opening` | 0062_inventory_movement_commands.sql | yes |
| `inventory.stocktake_count` | 0062_inventory_movement_commands.sql | yes |
| `inventory.stocktake_finalize` | 0062_inventory_movement_commands.sql | yes |
| `inventory.stocktake_open` | 0062_inventory_movement_commands.sql | yes |
| `inventory.transfer` | 0062_inventory_movement_commands.sql | yes |
| `payment.activate_method` | 0068_supplier_settlement_commands.sql | yes |
| `payment.create_method` | 0068_supplier_settlement_commands.sql | yes |
| `payment.deactivate_method` | 0068_supplier_settlement_commands.sql | yes |
| `payment.update_method` | 0068_supplier_settlement_commands.sql | yes |
| `pos.cart_remove_line` | 0079_phase4_pos_till_sessions_cart.sql | yes |
| `pos.cart_set_line` | 0079_phase4_pos_till_sessions_cart.sql | yes |
| `pos.session_close` | 0079_phase4_pos_till_sessions_cart.sql | yes |
| `pos.session_open` | 0079_phase4_pos_till_sessions_cart.sql | yes |
| `purchase.cancel` | 0064_purchase_commands.sql | yes |
| `purchase.draft` | 0064_purchase_commands.sql | yes |
| `purchase.receive` | 0064_purchase_commands.sql | yes |
| `purchase.return` | 0066_supplier_return_reversal_commands.sql | yes |
| `purchase.reverse` | 0066_supplier_return_reversal_commands.sql | yes |
| `purchase.write_off_residue` | 0072_purchase_sub_unit_residue.sql | yes |
| `sale.commit` | 0077_phase4_sales_sale_items_sources.sql | yes |
| `sale.probe` | 0074_phase4_registry_widening.sql | yes |
| `structure.associate_warehouse_branch` | 0054_inventory_assertion_authority.sql | yes |
| `structure.dissociate_warehouse_branch` | 0054_inventory_assertion_authority.sql | yes |
| `supplier.allocate_credit` | 0068_supplier_settlement_commands.sql | yes |
| `supplier.archive` | 0064_purchase_commands.sql | yes |
| `supplier.create` | 0064_purchase_commands.sql | yes |
| `supplier.pay` | 0068_supplier_settlement_commands.sql | yes |
| `supplier.reactivate` | 0064_purchase_commands.sql | yes |
| `supplier.receive_refund` | 0068_supplier_settlement_commands.sql | yes |
| `supplier.update` | 0064_purchase_commands.sql | yes |

## Findings — 0

_None._ Every registry row has a writer, and every accounting source type binds its entry.

## The two rows deliberately exempt

`probe_0074` (a `stock_source_types` row) and `sale.probe` (an `inventory_operation_kinds` row) exist in `0074`'s own `DO` block only to PROVE the widened `registered_by` CHECK accepts a Phase 4 registrant, and are rolled back inside it. They are named here so the writer finding is not reported for them, rather than being filtered silently.

## What is NOT yet registered, and why

| source type | owed by | why |
|---|---|---|
| `credit_note` | `P4-S5` | the relation does not exist; registering the type first would be the dead registry concept `TL-P4-S1-R1` refused |
| `refund` | `P4-S5` | the same |
| `allocation_reversal` | `P4-S6` | the same |
| `sale.void` (operation kind) | `P4-S6` | `TL-P4-S2-K1`: registering it in S2 would have created live authority with no writer |
| `sale.return` (operation kind) | `P4-S5` | the same |
