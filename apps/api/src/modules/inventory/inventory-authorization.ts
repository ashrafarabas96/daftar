import { Inject, Injectable } from '@nestjs/common';
import { AppError, hasPermission, type Permission } from '@daftar/domain-core';
import type { InventoryOperationCode, InventoryPayload } from '@daftar/inventory';
import { Database, type BusinessScope } from '../../infra/database';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { InventoryAssertionMinterService } from './inventory-assertion.minter';

/**
 * What each operation kind demands of the actor before an assertion for it
 * may be minted (P3-AL-55 §E, "Application check before minting").
 *
 * - `warehouses`: the domain permission, plus every affected warehouse
 *   reachable from the actor's branch scope (P3-AL-39). An operation that
 *   affects no warehouse — product configuration — passes the scope half
 *   trivially; a transfer lists both of its warehouses.
 * - `business_wide`: the domain permission, plus `branch_scope_mode = 'all'`
 *   (P3-AL-15 §B). An assigned-scope actor never reaches the minter for such
 *   a kind, whatever warehouses or branches it names.
 *
 * One row per registered kind and no default: a kind registered in
 * `@daftar/inventory` without a row here does not compile.
 */
const OPERATION_AUTHORITY: Readonly<Record<InventoryOperationCode, { readonly permission: Permission; readonly scope: 'warehouses' | 'business_wide' }>> = {
  'inventory.configure_product': { permission: 'inventory.adjust', scope: 'warehouses' },
  'structure.associate_warehouse_branch': { permission: 'warehouse.manage', scope: 'business_wide' },
  'structure.dissociate_warehouse_branch': { permission: 'warehouse.manage', scope: 'business_wide' },
};

/**
 * The proof that one domain command has established its own authority
 * (P3-AL-33): the permission its operation kind requires, and the branch /
 * warehouse scope over every warehouse it affects (P3-AL-39).
 *
 * Only `InventoryAuthorizationService.authorize` issues one, and `mint`
 * accepts nothing else: an object of the same shape built anywhere else is
 * refused, because it is not in the set of proofs this module issued. So "a
 * domain command that has proven its own authority may mint" is a property of
 * the code path, not a flag, an option or a boolean anyone could pass as
 * `true`.
 */
export interface InventoryCommandAuthority {
  /** The seam scope. The actor is the authenticated member; there is no other source for it. */
  readonly scope: BusinessScope;
  readonly opCode: InventoryOperationCode;
  /** Every warehouse whose scope was checked, de-duplicated. */
  readonly warehouseIds: readonly string[];
}

/** The proofs `authorize` issued. Weak, so a proof lives exactly as long as its command. */
const issued = new WeakSet<InventoryCommandAuthority>();

/**
 * The authorization seam every Phase 3 command uses (P3-AL-33, P3-AL-39,
 * P3-AL-55 §I): domain permission, then warehouse scope over EVERY affected
 * warehouse, then — only for a command that passed both — the `invctl/1`
 * assertion over the command's exact payload.
 *
 * Branch scope comes from the `MembershipContext` the guard already resolved
 * (`branchScopeMode`, `allowedBranchIds` — loaded from `member_branch_scopes`)
 * and is not re-derived here. The one thing added is the warehouse half: an
 * assigned-scope actor reaches a warehouse only through `branch_warehouses`,
 * from a branch in their set (P3-AL-15). As in the accepted warehouse list,
 * an archived branch in that set grants nothing.
 *
 * Every check here runs BEFORE any seam is opened. The database then verifies
 * the signed result of this decision, not the membership graph (P3-AL-54 §E).
 */
@Injectable()
export class InventoryAuthorizationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InventoryAssertionMinterService) private readonly minter: InventoryAssertionMinterService,
  ) {}

  /**
   * Establish the authority for one command of kind `opCode` affecting
   * `warehouseIds` (lowercase canonical UUIDs; empty when the command affects
   * none). Refuses with 403 before anything is minted.
   */
  async authorize(m: MembershipContext, opCode: InventoryOperationCode, warehouseIds: readonly string[] = []): Promise<InventoryCommandAuthority> {
    const rule = OPERATION_AUTHORITY[opCode];
    if (!hasPermission(m.roles, rule.permission)) {
      throw AppError.forbidden(`Missing permission: ${rule.permission}`);
    }

    const affected = [...new Set(warehouseIds)];
    if (rule.scope === 'business_wide') {
      if (m.branchScopeMode !== 'all') {
        throw new AppError('FORBIDDEN', 'This command requires business-wide branch scope', 403, { inventoryCode: 'inventory.business_wide_scope_required' });
      }
    } else if (m.branchScopeMode === 'assigned' && affected.length > 0) {
      await this.assertWarehousesInScope(m, affected);
    }

    const authority: InventoryCommandAuthority = Object.freeze({
      scope: Object.freeze({ tenantId: m.tenantId, businessId: m.businessId, actorUserId: m.userId }),
      opCode,
      warehouseIds: Object.freeze(affected),
    });
    issued.add(authority);
    return authority;
  }

  /**
   * Mint the `invctl/1` assertion for an authorized command's exact payload.
   * The operation kind of the payload must be the one that was authorized:
   * an authority established for one kind cannot sign another.
   */
  mint(authority: InventoryCommandAuthority, payload: InventoryPayload): string {
    if (!issued.has(authority)) {
      throw new Error('an inventory assertion is minted only for an authority established by InventoryAuthorizationService');
    }
    if (payload.opCode !== authority.opCode) {
      throw new Error(`an authority established for ${authority.opCode} cannot sign a ${payload.opCode} payload`);
    }
    return this.minter.mint({
      actorUserId: authority.scope.actorUserId,
      tenantId: authority.scope.tenantId,
      businessId: authority.scope.businessId,
      opCode: payload.opCode,
      payloadSha256: payload.sha256,
    });
  }

  /**
   * P3-AL-39 for an assigned-scope actor: every affected warehouse must be
   * associated, through `branch_warehouses`, with at least one ACTIVE branch
   * in the actor's scope. Default deny — no assigned branch reaches nothing.
   * A warehouse of another business is invisible under row level security
   * and is refused exactly like one out of scope, so the answer does not
   * reveal whether it exists.
   */
  private async assertWarehousesInScope(m: MembershipContext, warehouseIds: readonly string[]): Promise<void> {
    const allowedBranchIds = [...m.allowedBranchIds];
    const reachable =
      allowedBranchIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.db.scoped<{ warehouse_id: string }>(
                { tenantId: m.tenantId, businessId: m.businessId },
                `SELECT DISTINCT bw.warehouse_id
                   FROM branch_warehouses bw
                   JOIN branches b ON b.business_id = bw.business_id AND b.id = bw.branch_id AND b.status = 'active'
                  WHERE bw.business_id = $1
                    AND bw.warehouse_id = ANY($2::uuid[])
                    AND bw.branch_id = ANY($3::uuid[])`,
                [m.businessId, warehouseIds, allowedBranchIds],
              )
            ).rows.map((r) => r.warehouse_id),
          );
    if (warehouseIds.some((id) => !reachable.has(id))) {
      throw new AppError('FORBIDDEN', 'A warehouse is outside your branch scope', 403, { inventoryCode: 'inventory.warehouse_out_of_scope' });
    }
  }
}
