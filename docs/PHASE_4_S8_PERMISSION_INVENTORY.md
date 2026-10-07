# PHASE 4 — P4-S8 — THE PERMISSION INVENTORY

**GENERATED — do not edit by hand.** Regenerate with `npx tsx scripts/phase4-s8/generate-inventories.ts`; `--check` refuses a tree in which this file disagrees with the live one.

| | |
|---|---|
| generated from | `6587460ba3632231e4324c5ce2af92e1589d0705` |
| generator | `scripts/phase4-s8/generate-inventories.ts` |
| discovery | the migration files, the permission registry and the workflow, read at generation time — never a hand-written list |

The closed registry, discovered from `packages/domain-core/src/permissions.ts`: **58 keys**, of which
**30 are sensitive** and **12 are Phase 4's** (`P4-AL-36`).

`P4-AL-37`: "sensitive" means value-moving OUTSIDE the normal operating flow — not "everything except a read". `OD-P4-01` OPTION A: no SENSITIVE
Phase 4 key may be a DEFAULT of any built-in role, the cashier and the manager included.

The **migration assertion** column is the one-shot migration-time `DO`-block assertion that raises `permission_backfill_overreach`
(`0041:57-65`, `0057:140-151`, and the Phase 4 one `P4-AL-37` requires). There is no `CHECK`, no trigger and no exclusion constraint on
`role_permissions`, so that assertion is the ONLY thing in the database that binds a key — which is why its absence is a finding.

## Every key

| key | phase | sensitive | built-in defaults | migration assertion | required by |
|---|---|---|---|---|---|
 | `business.view` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `business.manage` | Phase 1 | **yes** | owner | — | — | 
 | `branch.view` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `branch.manage` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `warehouse.view` | Phase 1 | no | manager, owner | — | 2 file(s) | 
 | `warehouse.manage` | Phase 1 | no | manager, owner | — | 2 file(s) | 
 | `member.view` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `member.invite` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `member.manage` | Phase 1 | **yes** | owner | — | 1 file(s) | 
 | `member.suspend` | Phase 1 | **yes** | owner | — | 1 file(s) | 
 | `member.branch_scope.manage` | Phase 1 | **yes** | owner | — | 2 file(s) | 
 | `role.view` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `role.create` | Phase 1 | **yes** | owner | — | 1 file(s) | 
 | `role.update` | Phase 1 | **yes** | owner | — | 1 file(s) | 
 | `role.delete` | Phase 1 | **yes** | owner | — | 1 file(s) | 
 | `role.assign` | Phase 1 | **yes** | manager, owner | — | 1 file(s) | 
 | `catalog.view` | Phase 1 | no | cashier, manager, owner | — | 1 file(s) | 
 | `catalog.create` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `catalog.update` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `catalog.archive` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `category.manage` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `media.manage` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `settings.view` | Phase 1 | no | manager, owner | — | — | 
 | `settings.manage` | Phase 1 | no | owner | — | 1 file(s) | 
 | `billing.view` | Phase 1 | no | owner | — | — | 
 | `billing.manage` | Phase 1 | **yes** | owner | — | 1 file(s) | 
 | `subscription.view` | Phase 1 | no | manager, owner | — | 1 file(s) | 
 | `subscription.manage` | Phase 1 | **yes** | owner | — | — | 
 | `accounting.view` | Phase 2 | no | owner | 0041_accounting_permissions.sql | 5 file(s) | 
 | `accounting.post` | Phase 2 | **yes** | owner | 0041_accounting_permissions.sql | 3 file(s) | 
 | `accounting.reverse` | Phase 2 | **yes** | owner | 0041_accounting_permissions.sql | 2 file(s) | 
 | `accounting.chart.manage` | Phase 2 | **yes** | owner | 0041_accounting_permissions.sql | 4 file(s) | 
 | `accounting.fx.manage` | Phase 2 | **yes** | owner | 0041_accounting_permissions.sql | 2 file(s) | 
 | `accounting.period.manage` | Phase 2 | **yes** | owner | 0041_accounting_permissions.sql | 2 file(s) | 
 | `accounting.period.reopen` | Phase 2 | **yes** | owner | 0041_accounting_permissions.sql | 2 file(s) | 
 | `inventory.view` | Phase 3 | no | manager, owner | 0057_inventory_permissions.sql | 3 file(s) | 
 | `inventory.adjust` | Phase 3 | **yes** | owner | 0057_inventory_permissions.sql | 5 file(s) | 
 | `inventory.transfer` | Phase 3 | **yes** | owner | 0057_inventory_permissions.sql | 4 file(s) | 
 | `inventory.stocktake` | Phase 3 | **yes** | owner | 0057_inventory_permissions.sql | 3 file(s) | 
 | `purchases.view` | Phase 3 | no | manager, owner | 0057_inventory_permissions.sql | 4 file(s) | 
 | `purchases.manage` | Phase 3 | **yes** | owner | 0057_inventory_permissions.sql | 3 file(s) | 
 | `purchases.receive` | Phase 3 | **yes** | owner | 0057_inventory_permissions.sql | 3 file(s) | 
 | `purchases.return` | Phase 3 | **yes** | owner | 0057_inventory_permissions.sql | 2 file(s) | 
 | `suppliers.view` | Phase 3 | no | manager, owner | 0057_inventory_permissions.sql | 6 file(s) | 
 | `suppliers.manage` | Phase 3 | **yes** | owner | 0057_inventory_permissions.sql | 2 file(s) | 
 | `suppliers.pay` | Phase 3 | **yes** | owner | 0057_inventory_permissions.sql | 6 file(s) | 
 | `sales.view` | Phase 4 | no | cashier, owner | 0076_phase4_permission_defaults_backfill.sql | 8 file(s) | 
 | `sales.create` | Phase 4 | no | cashier, owner | 0076_phase4_permission_defaults_backfill.sql | 7 file(s) | 
 | `sales.void` | Phase 4 | **yes** | owner | 0076_phase4_permission_defaults_backfill.sql | — | 
 | `sales.return` | Phase 4 | **yes** | owner | 0076_phase4_permission_defaults_backfill.sql | — | 
 | `sales.discount` | Phase 4 | **yes** | owner | 0076_phase4_permission_defaults_backfill.sql | 4 file(s) | 
 | `customers.view` | Phase 4 | no | cashier, owner | 0076_phase4_permission_defaults_backfill.sql | 2 file(s) | 
 | `customers.manage` | Phase 4 | no | owner | 0076_phase4_permission_defaults_backfill.sql | 2 file(s) | 
 | `payments.collect` | Phase 4 | no | cashier, owner | 0076_phase4_permission_defaults_backfill.sql | 4 file(s) | 
 | `payments.reverse` | Phase 4 | **yes** | owner | 0076_phase4_permission_defaults_backfill.sql | — | 
 | `refunds.approve` | Phase 4 | **yes** | owner | 0076_phase4_permission_defaults_backfill.sql | — | 
 | `receivables.view` | Phase 4 | no | owner | 0076_phase4_permission_defaults_backfill.sql | 8 file(s) | 
 | `installments.manage` | Phase 4 | **yes** | owner | 0076_phase4_permission_defaults_backfill.sql | — | 

## Findings — 0

_None._ No sensitive Phase 4 key is a built-in default, and every Phase 4 key is bound by a migration-time assertion.

## Recorded, NOT a finding — inherited sensitive defaults (1)

`OD-P4-01` OPTION A is a ruling about PHASE 4 sensitive keys and is not retroactive over Phase 1 and Phase 2 classifications. These keys are
sensitive AND are built-in defaults of a non-owner role; they are accepted surface, reporting them as a Phase 4 finding would be an over-claim
against a sealed decision, and omitting them entirely would make this inventory look like it had not looked.

| key | phase | default of |
|---|---|---|
| `role.assign` | Phase 1 | manager |
