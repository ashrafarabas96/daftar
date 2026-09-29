/**
 * The structure view S7 adds — which branches a warehouse serves — and its
 * SSR fixtures (P3-S7 §4.3, §6: T-08, T-15, T-16).
 */
import type { InventoryWarehouseDto } from '@/lib/phase3-api';
import { defineView, type ViewEntry } from '@/lib/phase3-format';
import { WarehouseBranches, type WarehouseBranchesProps } from './WarehouseBranches';

const noop = (): void => undefined;

const DOWNTOWN = 'b1000000-0000-4000-8000-000000000001';
const AIRPORT = 'b1000000-0000-4000-8000-000000000002';
const HARBOUR = 'b1000000-0000-4000-8000-000000000003';

const BRANCHES = [
  { id: DOWNTOWN, name: 'Downtown' },
  { id: AIRPORT, name: 'Airport' },
  { id: HARBOUR, name: 'Harbour' },
];

/** A warehouse as a page may hold it after an association answer, trace included; the view never shows the trace. */
const CENTRAL = {
  warehouseId: 'c1000000-0000-4000-8000-000000000001',
  name: 'Central store',
  status: 'active' as const,
  homeBranchId: DOWNTOWN,
  branchIds: [DOWNTOWN, AIRPORT],
  businessTransactionId: 'b7d3a2c1-8888-4c2b-9a0d-00000000bt08',
};
const WAREHOUSES: InventoryWarehouseDto[] = [
  CENTRAL,
  { warehouseId: 'c1000000-0000-4000-8000-000000000002', name: 'Airport shelf', status: 'active', homeBranchId: AIRPORT, branchIds: [AIRPORT] },
  { warehouseId: 'c1000000-0000-4000-8000-000000000003', name: 'Old depot', status: 'archived', homeBranchId: HARBOUR, branchIds: [HARBOUR] },
];

const view = (over: Partial<WarehouseBranchesProps>): WarehouseBranchesProps => ({
  warehouses: WAREHOUSES,
  branches: BRANCHES,
  busyKey: null,
  errorKey: null,
  onAdd: noop,
  onRemove: noop,
  ...over,
});

export const VIEW_REGISTRY: readonly ViewEntry[] = [
  defineView('WarehouseBranches', WarehouseBranches, {
    'a warehouse serving two branches': view({}),
    'a change in flight': view({ busyKey: `c1000000-0000-4000-8000-000000000002:${DOWNTOWN}` }),
    'refused: needs every branch': view({ errorKey: 'error.inventory.business_wide_scope_required' }),
  }),
];
