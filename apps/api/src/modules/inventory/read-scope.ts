import { AppError, hasPermission, type Permission } from '@daftar/domain-core';
import type { Database } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { inventoryRefusal } from './inventory-errors';

/**
 * The scope rules every Phase 3 READ applies (PHASE_3_S7_CONTRACT A-04; the
 * P3-AL-15/39 reach the commands enforce, and the S4 TL-4 precedent):
 *
 * - `warehouse`: rows of warehouses the member does not reach are absent; a
 *   read that names such a warehouse is `inventory.warehouse_out_of_scope`;
 * - `business-wide`: the read requires `branch_scope_mode = 'all'`, else
 *   `inventory.business_wide_scope_required`;
 * - `master`: membership and the permission only.
 *
 * Every read re-checks its permission here, whatever the route guard did.
 */

/**
 * The warehouses an assigned-scope member reaches (P3-AL-15/39: through
 * `branch_warehouses`, from an ACTIVE branch in their set), or null for a
 * business-wide member. The same rule the command authority applies.
 */
export async function reachableWarehouses(db: Database, m: MembershipContext): Promise<ReadonlySet<string> | null> {
  if (m.branchScopeMode === 'all') return null;
  const branches = [...m.allowedBranchIds];
  if (branches.length === 0) return new Set();
  const found = await db.scoped<{ warehouse_id: string }>(
    { tenantId: m.tenantId, businessId: m.businessId },
    `SELECT DISTINCT bw.warehouse_id
       FROM branch_warehouses bw
       JOIN branches b ON b.business_id = bw.business_id AND b.id = bw.branch_id AND b.status = 'active'
      WHERE bw.business_id = $1 AND bw.branch_id = ANY($2::uuid[])`,
    [m.businessId, branches],
  );
  return new Set(found.rows.map((r) => r.warehouse_id));
}

/** The business-wide scope rule: an assigned-scope member is refused before any read. */
export function assertBusinessWide(m: MembershipContext): void {
  if (m.branchScopeMode !== 'all') {
    throw new AppError('FORBIDDEN', 'This read requires business-wide branch scope', 403, { inventoryCode: 'inventory.business_wide_scope_required' });
  }
}

/** The member holds at least one of `permissions`, else a plain `FORBIDDEN` (no domain code). */
export function requireAnyPermission(m: MembershipContext, permissions: readonly Permission[]): void {
  if (!permissions.some((p) => hasPermission(m.roles, p))) throw AppError.forbidden(`Missing permission: ${permissions.join(' | ')}`);
}

/** A read that names a warehouse the member does not reach is refused, never answered empty. */
export function assertWarehouseReachable(reachable: ReadonlySet<string> | null, warehouseId: string): void {
  if (reachable !== null && !reachable.has(warehouseId)) throw inventoryRefusal('inventory.warehouse_out_of_scope');
}

/** `%`, `_` and `\` escaped for an `ILIKE … ESCAPE '\'` substring pattern. */
export function likeEscaped(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A stored NUMERIC quantity as text with at least `decimals` fraction digits:
 * trailing zeros beyond `decimals` are dropped, a significant digit never is,
 * and zero carries no sign.
 */
export function quantityText(stored: string, decimals: number): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(stored);
  if (m === null) throw new Error('a stored quantity is not a decimal');
  const whole = m[2] ?? '0';
  const fraction = (m[3] ?? '').replace(/0+$/, '').padEnd(decimals, '0');
  const isZero = /^0+$/.test(whole) && /^0*$/.test(fraction);
  return `${isZero ? '' : (m[1] ?? '')}${whole}${fraction.length > 0 ? `.${fraction}` : ''}`;
}
