import { Injectable, Inject } from '@nestjs/common';
import { AppError, beyondGrantAuthority, isPermission, type Permission } from '@daftar/domain-core';
import type { BranchDto, MemberDto, RoleDto, WarehouseDto } from '@daftar/shared-contracts';
import { Database, type BusinessScope } from '../../infra/database';
import { AuditService, newId } from '../audit/audit.service';
import { EntitlementService } from '../entitlements/entitlements.service';
import { associateWarehouseBranchPayload, dissociateWarehouseBranchPayload } from '@daftar/inventory';
import type { BusinessTransactionId } from '../inventory/business-transaction';
import { InventoryAuthorizationService } from '../inventory/inventory-authorization';
import { inventoryRefusal, rethrowInventoryRefusal } from '../inventory/inventory-errors';
import type { MembershipContext } from './tenancy.service';

/** The outcome of a warehouse–branch association command (P3-AL-15 §B). */
export interface WarehouseBranchAssociationResult {
  readonly warehouseId: string;
  readonly branchId: string;
  /** Whether the association exists after the command. */
  readonly associated: boolean;
  /** False when the command found the association already in the requested state (idempotent success). */
  readonly changed: boolean;
  /** The trace id of this operation (P3-AL-35). Observability only. */
  readonly businessTransactionId: BusinessTransactionId;
}

/** Business structure: branches, warehouses, members, roles. */
@Injectable()
export class StructureService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EntitlementService) private readonly entitlements: EntitlementService,
    @Inject(InventoryAuthorizationService) private readonly inventoryAuthorization: InventoryAuthorizationService,
  ) {}

  private scope(m: MembershipContext): { tenantId: string; businessId: string } {
    return { tenantId: m.tenantId, businessId: m.businessId };
  }

  /** Branch scope (§32–37): 'assigned' members see only their allowed branches. */
  private branchScopeFilter(m: MembershipContext, column: string, paramIndex: number): { clause: string; params: string[][] } {
    if (m.branchScopeMode === 'assigned') {
      return { clause: ` AND ${column} = ANY($${paramIndex})`, params: [[...m.allowedBranchIds]] };
    }
    return { clause: '', params: [] };
  }

  async listBranches(m: MembershipContext): Promise<BranchDto[]> {
    const f = this.branchScopeFilter(m, 'id', 2);
    const rows = (
      await this.db.scoped<{ id: string; name: string; is_default: boolean }>(
        this.scope(m),
        `SELECT id, name, is_default FROM branches WHERE business_id = $1 AND status = 'active'${f.clause} ORDER BY created_at`,
        [m.businessId, ...f.params],
      )
    ).rows;
    return rows.map((r) => ({ id: r.id, name: r.name, isDefault: r.is_default }));
  }

  async createBranch(m: MembershipContext, name: string): Promise<BranchDto> {
    // Branch creation is business-wide: a branch-scoped member cannot mint a
    // new branch (that would implicitly expand their own scope surface).
    if (m.branchScopeMode === 'assigned') {
      throw AppError.forbidden('Branch creation requires business-wide scope');
    }
    const id = newId();
    await this.db.withTransaction(this.scope(m), async (c) => {
      // §23: capability AND limit both govern. MULTI_BRANCH=false → exactly one
      // branch, even if a misconfigured limit would allow more.
      await this.entitlements.assertFeature(c, m.businessId, 'MULTI_BRANCH');
      await this.entitlements.assertCanConsume(c, m.businessId, 'MAX_BRANCHES');
      await c.query('INSERT INTO branches (business_id, id, name) VALUES ($1, $2, $3)', [m.businessId, id, name]);
      // §68: every branch has a default warehouse from birth.
      await c.query('INSERT INTO warehouses (business_id, id, branch_id, name, is_default) VALUES ($1, $2, $3, $4, true)', [
        m.businessId,
        newId(),
        id,
        `${name} — default warehouse`,
      ]);
      await this.audit.recordTx(c, { action: 'structure.branch_created', entity: 'branch', entityId: id });
    });
    return { id, name, isDefault: false };
  }

  async listWarehouses(m: MembershipContext): Promise<WarehouseDto[]> {
    const f = this.branchScopeFilter(m, 'branch_id', 2);
    const rows = (
      await this.db.scoped<{ id: string; branch_id: string; name: string; is_default: boolean }>(
        this.scope(m),
        `SELECT w.id, w.branch_id, w.name, w.is_default
         FROM warehouses w
         JOIN branches b ON b.business_id = w.business_id AND b.id = w.branch_id AND b.status = 'active'
         WHERE w.business_id = $1 AND w.status = 'active'${f.clause.replace('branch_id', 'w.branch_id')} ORDER BY w.created_at`,
        [m.businessId, ...f.params],
      )
    ).rows;
    return rows.map((r) => ({ id: r.id, branchId: r.branch_id, name: r.name, isDefault: r.is_default }));
  }

  async createWarehouse(m: MembershipContext, name: string, branchId: string): Promise<WarehouseDto> {
    // Branch scope enforcement (§34–35): an assigned-scope member can never
    // create a warehouse in a branch outside their allowance.
    if (m.branchScopeMode === 'assigned' && !m.allowedBranchIds.includes(branchId)) {
      throw AppError.forbidden('Branch is outside your assigned scope');
    }
    const id = newId();
    try {
      await this.db.withTransaction(this.scope(m), async (c) => {
        const branch = (await c.query<{ status: string }>('SELECT status FROM branches WHERE business_id = $1 AND id = $2', [m.businessId, branchId])).rows[0];
        if (branch && branch.status !== 'active') {
          throw AppError.validation({ branchId: ['branch_archived'] });
        }
        // Composite FK enforces same-business branch; we still fail clean.
        await c.query('INSERT INTO warehouses (business_id, id, branch_id, name) VALUES ($1, $2, $3, $4)', [m.businessId, id, branchId, name]);
        await this.audit.recordTx(c, { action: 'structure.warehouse_created', entity: 'warehouse', entityId: id });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23503') {
        throw AppError.validation({ branchId: ['branch_not_in_business'] });
      }
      throw e;
    }
    return { id, branchId, name, isDefault: false };
  }

  /**
   * Associate a warehouse with an additional branch (P3-AL-15 §B, P3-AL-54 §E).
   *
   * Requires `warehouse.manage` AND business-wide branch scope. The scope
   * condition is not redundant: an assigned-scope manager who could associate
   * any warehouse with their own branch would be granting themselves reach
   * over stock they were never scoped to. Both are checked by the
   * authorization seam BEFORE the minter is reached, so such an actor cannot
   * even obtain an assertion.
   *
   * Both targets must be in this business (row level security makes another
   * business's ids invisible, so they fail as `structure.*_not_found`) and
   * neither may be archived. Then the `structure.associate_warehouse_branch` assertion is
   * minted over exactly `(warehouse_id, branch_id)` and the routine — the only
   * writer of `branch_warehouses` — re-checks every structural rule, is
   * idempotent, and writes the audit row with the asserted actor. This
   * service writes no row of its own.
   */
  async addWarehouseBranch(
    m: MembershipContext,
    warehouseId: string,
    branchId: string,
    businessTransactionId: BusinessTransactionId,
  ): Promise<WarehouseBranchAssociationResult> {
    const authority = await this.inventoryAuthorization.authorize(m, 'structure.associate_warehouse_branch', businessTransactionId);
    const targets = await this.associationTargets(m, warehouseId, branchId);
    // The routine's own codes, so a refusal reads the same whichever layer
    // made it (P3-AL-15 §B).
    if (targets.warehouseStatus !== 'active') throw inventoryRefusal('structure.warehouse_archived');
    if (targets.branchStatus !== 'active') throw inventoryRefusal('structure.branch_archived');

    const assertion = this.inventoryAuthorization.mint(
      authority,
      associateWarehouseBranchPayload({ tenantId: m.tenantId, businessId: m.businessId, warehouseId, branchId }),
    );
    const changed = await this.runAssociationRoutine(authority.scope, assertion, 'structure_associate_warehouse_branch', warehouseId, branchId);
    return { warehouseId, branchId, associated: true, changed, businessTransactionId };
  }

  /**
   * Remove a NON-home association (P3-AL-15 §B). Same authority as adding.
   *
   * The home association — `warehouses.branch_id` restated in the
   * authorization relation — is refused here, and refused again by the
   * routine and by the deferred `branch_warehouses_keep_home` trigger: a rule
   * only this wrapper enforced would be a convention, not an invariant.
   * Removing an association that does not exist is an idempotent success.
   */
  async removeWarehouseBranch(
    m: MembershipContext,
    warehouseId: string,
    branchId: string,
    businessTransactionId: BusinessTransactionId,
  ): Promise<WarehouseBranchAssociationResult> {
    const authority = await this.inventoryAuthorization.authorize(m, 'structure.dissociate_warehouse_branch', businessTransactionId);
    const targets = await this.associationTargets(m, warehouseId, branchId);
    if (targets.homeBranchId === branchId) {
      throw inventoryRefusal('inventory.home_branch_association_required');
    }

    const assertion = this.inventoryAuthorization.mint(
      authority,
      dissociateWarehouseBranchPayload({ tenantId: m.tenantId, businessId: m.businessId, warehouseId, branchId }),
    );
    const changed = await this.runAssociationRoutine(authority.scope, assertion, 'structure_dissociate_warehouse_branch', warehouseId, branchId);
    return { warehouseId, branchId, associated: false, changed, businessTransactionId };
  }

  /** Both association targets, resolved inside this business; either missing is 404. */
  private async associationTargets(
    m: MembershipContext,
    warehouseId: string,
    branchId: string,
  ): Promise<{ warehouseStatus: string; homeBranchId: string; branchStatus: string }> {
    const row = (
      await this.db.scoped<{ warehouse_status: string | null; home_branch_id: string | null; branch_status: string | null }>(
        this.scope(m),
        `SELECT (SELECT status FROM warehouses WHERE business_id = $1 AND id = $2) AS warehouse_status,
                (SELECT branch_id FROM warehouses WHERE business_id = $1 AND id = $2) AS home_branch_id,
                (SELECT status FROM branches WHERE business_id = $1 AND id = $3) AS branch_status`,
        [m.businessId, warehouseId, branchId],
      )
    ).rows[0];
    if (!row?.warehouse_status || !row.home_branch_id) throw inventoryRefusal('structure.warehouse_not_found');
    if (!row.branch_status) throw inventoryRefusal('structure.branch_not_found');
    return { warehouseStatus: row.warehouse_status, homeBranchId: row.home_branch_id, branchStatus: row.branch_status };
  }

  /**
   * Call one association routine inside the non-posting business seam. The
   * routine answers whether it changed anything: false is the idempotent
   * no-op, for which it writes no audit row.
   */
  private async runAssociationRoutine(
    scope: BusinessScope,
    assertion: string,
    routine: 'structure_associate_warehouse_branch' | 'structure_dissociate_warehouse_branch',
    warehouseId: string,
    branchId: string,
  ): Promise<boolean> {
    let changed: boolean | undefined;
    try {
      changed = await this.db.withBusinessInventoryTransaction(scope, assertion, async (tx) => {
        const r = await tx.query<{ changed: boolean }>(`SELECT ${routine}($1::uuid, $2::uuid) AS changed`, [warehouseId, branchId]);
        return r.rows[0]?.changed;
      });
    } catch (e) {
      return rethrowInventoryRefusal(e);
    }
    if (typeof changed !== 'boolean') throw new Error(`${routine} returned no verdict`);
    return changed;
  }

  /**
   * Branch scope management (§36): set a member's scope mode and the exact
   * allowed branch set. Covers assign-branch and remove-branch-assignment —
   * the new list IS the resulting assignment. Audited. Requires
   * 'member.branch_scope.manage' (fine-grained, §37) at the controller.
   */
  async setBranchScope(m: MembershipContext, targetUserId: string, mode: 'all' | 'assigned', branchIds: string[]): Promise<void> {
    if (mode === 'assigned' && branchIds.length === 0) {
      // Explicitly allowed by the matrix ("none assigned") — the member keeps
      // membership but sees zero branches.
    }
    await this.db.withTransaction(this.scope(m), async (c) => {
      const target = await this.lockMembership(c, m.businessId, targetUserId);
      if (!target || target.status === 'removed') throw AppError.notFound('Member not found');
      if (mode === 'assigned' && branchIds.length > 0) {
        const valid = (
          await c.query<{ id: string }>(`SELECT id FROM branches WHERE business_id = $1 AND id = ANY($2) AND status = 'active'`, [m.businessId, branchIds])
        ).rows;
        if (valid.length !== new Set(branchIds).size) {
          throw AppError.validation({ branchIds: ['unknown_or_archived_branch'] });
        }
      }
      await c.query('UPDATE memberships SET branch_scope_mode = $3, updated_at = now() WHERE business_id = $1 AND user_id = $2', [
        m.businessId,
        targetUserId,
        mode,
      ]);
      await c.query('DELETE FROM member_branch_scopes WHERE business_id = $1 AND user_id = $2', [m.businessId, targetUserId]);
      if (mode === 'assigned') {
        for (const branchId of new Set(branchIds)) {
          await c.query('INSERT INTO member_branch_scopes (business_id, user_id, branch_id) VALUES ($1, $2, $3)', [m.businessId, targetUserId, branchId]);
        }
      }
      await this.audit.recordTx(c, {
        action: 'structure.member_branch_scope_changed',
        entity: 'membership',
        entityId: targetUserId,
        tenantId: m.tenantId,
        businessId: m.businessId,
        metadata: { mode, branchIds: mode === 'assigned' ? [...new Set(branchIds)] : [] },
      });
    });
  }

  async listMembers(m: MembershipContext): Promise<MemberDto[]> {
    // §16 (Stabilization): the BUSINESS DB fetches the authorized user IDs
    // (app role, RLS business scope); the IDENTITY boundary then batch-
    // resolves email/displayName for exactly those IDs — no platform
    // super-join.
    const rows = (
      await this.db.scoped<{
        user_id: string;
        status: string;
        joined_at: Date | null;
        role_key: string | null;
        branch_scope_mode: string;
      }>(
        { tenantId: m.tenantId, businessId: m.businessId },
        `SELECT m.user_id, m.status, m.joined_at, r.key AS role_key, m.branch_scope_mode
         FROM memberships m
         LEFT JOIN membership_roles mr ON mr.business_id = m.business_id AND mr.user_id = m.user_id
         LEFT JOIN business_roles r ON r.business_id = mr.business_id AND r.id = mr.role_id
         WHERE m.business_id = $1 AND m.status <> 'removed'
         ORDER BY m.created_at`,
        [m.businessId],
      )
    ).rows;
    const scopeRows = (
      await this.db.scoped<{ user_id: string; branch_id: string }>(
        { tenantId: m.tenantId, businessId: m.businessId },
        'SELECT user_id, branch_id FROM member_branch_scopes WHERE business_id = $1',
        [m.businessId],
      )
    ).rows;
    const scopesByUser = new Map<string, string[]>();
    for (const s of scopeRows) {
      const arr = scopesByUser.get(s.user_id) ?? [];
      arr.push(s.branch_id);
      scopesByUser.set(s.user_id, arr);
    }
    // Identity batch resolution for the authorized IDs ONLY.
    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const identities = new Map<string, { email: string | null; display_name: string }>();
    if (userIds.length > 0) {
      const idRows = (
        await this.db.withIdentityTransaction((c) =>
          c.query<{ id: string; email: string | null; display_name: string }>(
            'SELECT id, email::text AS email, display_name FROM users WHERE id = ANY($1::uuid[])',
            [userIds],
          ),
        )
      ).rows;
      for (const u of idRows) identities.set(u.id, { email: u.email, display_name: u.display_name });
    }
    const byUser = new Map<string, MemberDto>();
    for (const r of rows) {
      const mode = r.branch_scope_mode === 'assigned' ? ('assigned' as const) : ('all' as const);
      const identity = identities.get(r.user_id);
      const e = byUser.get(r.user_id) ?? {
        userId: r.user_id,
        email: identity?.email ?? null,
        displayName: identity?.display_name ?? '',
        roleKeys: [] as string[],
        status: r.status as MemberDto['status'],
        joinedAt: r.joined_at?.toISOString() ?? null,
        branchScopeMode: mode,
        allowedBranchIds: mode === 'assigned' ? (scopesByUser.get(r.user_id) ?? []) : [],
      };
      if (r.role_key && !e.roleKeys.includes(r.role_key)) e.roleKeys.push(r.role_key);
      byUser.set(r.user_id, e);
    }
    return [...byUser.values()];
  }

  /**
   * Direct add of an EXISTING user (invitations are the primary path — see
   * InvitationsService). §9: identity lookup (email → trusted user id) runs on
   * the IDENTITY boundary; the membership mutation itself runs as the APP role
   * in a business-scoped transaction — defense in depth preserved.
   */
  /** Single member DTO (same projection as listMembers). */
  async getMember(m: MembershipContext, userId: string): Promise<MemberDto> {
    const member = (await this.listMembers(m)).find((x) => x.userId === userId);
    if (!member) throw AppError.notFound('Member not found');
    return member;
  }

  async addMember(m: MembershipContext, email: string, roleKey: string): Promise<MemberDto> {
    if (roleKey === 'owner') throw AppError.forbidden('Owner role is system-managed');
    const user = (
      await this.db.withIdentityTransaction((c) => c.query<{ id: string }>('SELECT id FROM users WHERE email = $1 AND status = $2', [email, 'active']))
    ).rows[0];
    if (!user) throw AppError.notFound('User not found');
    await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
      const role = await this.roleByKey(c, m.businessId, roleKey);
      await this.assertRoleWithinCeiling(c, m, role.id as string);
      // WAVE 1 — explicit membership state machine. addMember is NOT a bypass:
      // ACTIVE → conflict; SUSPENDED → must use the reactivate command;
      // REMOVED → re-add allowed, but the old role set NEVER comes back.
      const existing = await this.lockMembership(c, m.businessId, user.id);
      if (existing) {
        if (existing.status === 'active' || existing.status === 'invited') {
          throw AppError.conflict('ALREADY_MEMBER', 'User is already a member');
        }
        if (existing.status === 'suspended') {
          throw AppError.conflict('MEMBER_SUSPENDED', 'Member is suspended — use the reactivate command');
        }
        // status === 'removed': fresh authorization relationship. Defense in
        // depth: purge any residual authority rows before re-adding.
        await c.query('DELETE FROM membership_roles WHERE business_id = $1 AND user_id = $2', [m.businessId, user.id]);
        await c.query('DELETE FROM member_branch_scopes WHERE business_id = $1 AND user_id = $2', [m.businessId, user.id]);
      }
      // WAVE 4 — no double reservation: if a PENDING invitation exists for
      // this email, the direct add converts the reservation — the invitation
      // is cancelled in the same transaction (audited), never leaving an
      // active member + pending reservation at the same time.
      const cancelled = await c.query(
        `UPDATE business_invitations SET status = 'cancelled', responded_at = now()
         WHERE business_id = $1 AND email = $2 AND status = 'pending' AND expires_at > now()
         RETURNING id`,
        [m.businessId, email],
      );
      await this.entitlements.assertCanConsume(c, m.businessId, 'MAX_USERS');
      // WAVE 3 invariant: business membership requires tenant membership.
      // A user new to this tenant joins it as tenant_member in the same tx
      // (tenant_owner can NEVER be granted here — DB trigger-enforced).
      await c.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, role_key) VALUES ($1, $2, 'tenant_member')
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [m.tenantId, user.id],
      );
      await c.query(
        `INSERT INTO memberships (tenant_id, business_id, user_id, status, joined_at, branch_scope_mode) VALUES ($1, $2, $3, 'active', now(), 'all')
         ON CONFLICT (business_id, user_id) DO UPDATE SET status = 'active', disabled_at = NULL, branch_scope_mode = 'all', joined_at = coalesce(memberships.joined_at, now()), updated_at = now()`,
        [m.tenantId, m.businessId, user.id],
      );
      await c.query(`INSERT INTO membership_roles (business_id, user_id, role_id, assigned_by) VALUES ($1, $2, $3, $4)`, [
        m.businessId,
        user.id,
        role.id,
        m.userId,
      ]);
      await this.audit.recordTx(c, {
        action: 'structure.member_added',
        entity: 'membership',
        entityId: user.id,
        tenantId: m.tenantId,
        businessId: m.businessId,
        metadata: {
          roleKey,
          cancelledPendingInvitationIds: cancelled.rows.map((r) => (r as { id: string }).id),
        },
      });
    });
    return this.getMember(m, user.id);
  }

  async listRoles(m: MembershipContext): Promise<RoleDto[]> {
    const rows = (
      await this.db.scoped<{ id: string; key: string; name: string; is_system: boolean; permission: string | null }>(
        this.scope(m),
        `SELECT r.id, r.key, r.name, r.is_system, p.permission
         FROM business_roles r
         LEFT JOIN role_permissions p ON p.business_id = r.business_id AND p.role_id = r.id
         WHERE r.business_id = $1 ORDER BY r.created_at`,
        [m.businessId],
      )
    ).rows;
    const byId = new Map<string, RoleDto>();
    for (const r of rows) {
      const e = byId.get(r.id) ?? { id: r.id, key: r.key, name: r.name, isSystem: r.is_system, permissions: [] as string[] };
      if (r.permission) e.permissions.push(r.permission);
      byId.set(r.id, e);
    }
    return [...byId.values()];
  }

  /**
   * Custom role creation. System role identity is NEVER client-settable (§26, §94).
   * Delegation ceiling (§27–29): a non-owner creator may only compose a role
   * from permissions they personally hold — a manager with role.create cannot
   * mint a role containing billing.manage / member.manage / business.manage.
   */
  async createRole(m: MembershipContext, input: { key: string; name: string; permissions: string[] }): Promise<RoleDto> {
    if (input.key === 'owner') throw AppError.forbidden('Owner role is system-managed');
    for (const p of input.permissions) {
      if (!isPermission(p)) throw AppError.validation({ permissions: [`unknown_permission:${p}`] });
    }
    this.assertDelegationCeiling(m, input.permissions as Permission[]);
    const id = newId();
    await this.db.withTransaction(this.scope(m), async (c) => {
      // §21–22: custom roles require the CUSTOM_ROLES capability — the API
      // enforces it even if a UI hides the button (§24).
      await this.entitlements.assertFeature(c, m.businessId, 'CUSTOM_ROLES');
      await c.query('INSERT INTO business_roles (business_id, id, key, name, is_system) VALUES ($1, $2, $3, $4, false)', [
        m.businessId,
        id,
        input.key,
        input.name,
      ]);
      for (const p of input.permissions as Permission[]) {
        await c.query('INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, $3)', [m.businessId, id, p]);
      }
      await this.audit.recordTx(c, { action: 'structure.role_created', entity: 'role', entityId: id });
    });
    return { id, key: input.key, name: input.name, isSystem: false, permissions: input.permissions };
  }

  /**
   * Role update (§69–72): name and/or permission set. System roles are
   * immutable — enforced here AND by the business_roles_system_guard DB
   * trigger (raw SQL cannot bypass). Delegation ceiling applies to the NEW
   * permission set: a non-owner editor cannot widen a role beyond their own
   * authority, even into a role they could previously edit.
   */
  async updateRole(m: MembershipContext, roleId: string, input: { name?: string; permissions?: string[] }): Promise<RoleDto> {
    if (input.permissions) {
      for (const p of input.permissions) {
        if (!isPermission(p)) throw AppError.validation({ permissions: [`unknown_permission:${p}`] });
      }
      this.assertDelegationCeiling(m, input.permissions as Permission[]);
    }
    return this.db.withTransaction(this.scope(m), async (c) => {
      const role = (
        await c.query<{ id: string; key: string; name: string; is_system: boolean }>(
          'SELECT id, key, name, is_system FROM business_roles WHERE business_id = $1 AND id = $2 FOR UPDATE',
          [m.businessId, roleId],
        )
      ).rows[0];
      if (!role) throw AppError.notFound('Role not found');
      if (role.is_system) throw AppError.forbidden('System roles are immutable');
      const name = input.name ?? role.name;
      await c.query('UPDATE business_roles SET name = $3 WHERE business_id = $1 AND id = $2', [m.businessId, roleId, name]);
      let permissions: string[];
      if (input.permissions) {
        await c.query('DELETE FROM role_permissions WHERE business_id = $1 AND role_id = $2', [m.businessId, roleId]);
        for (const p of input.permissions) {
          await c.query('INSERT INTO role_permissions (business_id, role_id, permission) VALUES ($1, $2, $3)', [m.businessId, roleId, p]);
        }
        permissions = input.permissions;
      } else {
        permissions = (
          await c.query<{ permission: string }>('SELECT permission FROM role_permissions WHERE business_id = $1 AND role_id = $2', [m.businessId, roleId])
        ).rows.map((r) => r.permission);
      }
      await this.audit.recordTx(c, {
        action: 'structure.role_updated',
        entity: 'role',
        entityId: roleId,
        metadata: { key: role.key, name, permissions },
      });
      return { id: role.id, key: role.key, name, isSystem: false, permissions };
    });
  }

  /**
   * Role delete (§73): a role still assigned to members cannot vanish
   * silently. Without a replacement → 409 ROLE_IN_USE. With
   * replacementRoleKey, all assignees are atomically reassigned first; the
   * replacement must exist, must not be the system owner role, and must be
   * within the actor's delegation ceiling. System roles can never be deleted.
   */
  async deleteRole(m: MembershipContext, roleId: string, replacementRoleKey?: string): Promise<void> {
    await this.db.withTransaction(this.scope(m), async (c) => {
      const role = (
        await c.query<{ id: string; key: string; is_system: boolean }>(
          'SELECT id, key, is_system FROM business_roles WHERE business_id = $1 AND id = $2 FOR UPDATE',
          [m.businessId, roleId],
        )
      ).rows[0];
      if (!role) throw AppError.notFound('Role not found');
      if (role.is_system) throw AppError.forbidden('System roles cannot be deleted');
      const assigned =
        (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM membership_roles WHERE business_id = $1 AND role_id = $2', [m.businessId, roleId]))
          .rows[0]?.n ?? 0;
      if (assigned > 0) {
        if (!replacementRoleKey) {
          throw AppError.conflict('ROLE_IN_USE', `Role is still assigned to ${assigned} member(s)`);
        }
        const replacement = await this.roleByKey(c, m.businessId, replacementRoleKey);
        if (replacement.id === roleId) throw AppError.validation({ replacementRoleKey: ['same_as_deleted'] });
        if (replacement.is_system && replacement.key === 'owner') {
          throw AppError.forbidden('Owner role is system-managed');
        }
        await this.assertRoleWithinCeiling(c, m, replacement.id as string);
        // Members who already hold the replacement keep it; the rest are moved.
        await c.query(
          `DELETE FROM membership_roles mr
           WHERE mr.business_id = $1 AND mr.role_id = $2
             AND EXISTS (SELECT 1 FROM membership_roles x
                         WHERE x.business_id = mr.business_id AND x.user_id = mr.user_id AND x.role_id = $3)`,
          [m.businessId, roleId, replacement.id],
        );
        await c.query('UPDATE membership_roles SET role_id = $3, assigned_by = $4 WHERE business_id = $1 AND role_id = $2', [
          m.businessId,
          roleId,
          replacement.id,
          m.userId,
        ]);
      }
      await c.query('DELETE FROM role_permissions WHERE business_id = $1 AND role_id = $2', [m.businessId, roleId]);
      await c.query('DELETE FROM business_roles WHERE business_id = $1 AND id = $2', [m.businessId, roleId]);
      await this.audit.recordTx(c, {
        action: 'structure.role_deleted',
        entity: 'role',
        entityId: roleId,
        metadata: { key: role.key, assignedCount: assigned, replacementRoleKey: replacementRoleKey ?? null },
      });
    });
  }

  /**
   * Last-owner protection (§28): removing/demoting/suspending a member must
   * never leave zero owners. Owner memberships are locked with
   * SELECT ... FOR UPDATE inside the same transaction — concurrent removals of
   * the last two owners resolve to exactly one success and one 409.
   * Removed members are NEVER deleted — status='removed' preserves history.
   */
  async removeMember(m: MembershipContext, targetUserId: string): Promise<void> {
    await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
      const target = await this.lockMembership(c, m.businessId, targetUserId);
      if (!target || target.status !== 'active') throw AppError.notFound('Member not found');
      if (await this.isOwnerMember(c, m.businessId, targetUserId)) {
        const ownerCount = await this.lockOwnerCount(c, m.businessId);
        if (ownerCount <= 1) throw AppError.conflict('LAST_OWNER_REMOVAL', 'A business must keep at least one owner');
      }
      // WAVE 1 — no privilege resurrection: capture current authority for the
      // audit record, then END it. Historical membership identity stays
      // (status='removed'), but current effective roles are deleted — a later
      // re-add starts with a completely fresh role set.
      const removedRoles = (
        await c.query<{ key: string }>(
          `SELECT r.key FROM membership_roles mr JOIN business_roles r
             ON r.business_id = mr.business_id AND r.id = mr.role_id
           WHERE mr.business_id = $1 AND mr.user_id = $2`,
          [m.businessId, targetUserId],
        )
      ).rows.map((r) => r.key);
      await c.query('DELETE FROM membership_roles WHERE business_id = $1 AND user_id = $2', [m.businessId, targetUserId]);
      await c.query('DELETE FROM member_branch_scopes WHERE business_id = $1 AND user_id = $2', [m.businessId, targetUserId]);
      await c.query(
        `UPDATE memberships SET status = 'removed', disabled_at = now(), branch_scope_mode = 'all', updated_at = now()
         WHERE business_id = $1 AND user_id = $2`,
        [m.businessId, targetUserId],
      );
      await this.audit.recordTx(c, {
        action: 'structure.member_removed',
        entity: 'membership',
        entityId: targetUserId,
        tenantId: m.tenantId,
        businessId: m.businessId,
        metadata: { removedRoleKeys: removedRoles },
      });
    });
  }

  /** Suspend: access is lost immediately (resolveMembership requires status='active'); history preserved. */
  async suspendMember(m: MembershipContext, targetUserId: string): Promise<void> {
    await this.setMemberSuspended(m, targetUserId, true);
  }

  async reactivateMember(m: MembershipContext, targetUserId: string): Promise<void> {
    await this.setMemberSuspended(m, targetUserId, false);
  }

  private async setMemberSuspended(m: MembershipContext, targetUserId: string, suspended: boolean): Promise<void> {
    await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
      const target = await this.lockMembership(c, m.businessId, targetUserId);
      if (!target) throw AppError.notFound('Member not found');
      if (suspended) {
        if (target.status !== 'active') throw AppError.validation({ status: ['not_active'] });
        if (await this.isOwnerMember(c, m.businessId, targetUserId)) {
          const ownerCount = await this.lockOwnerCount(c, m.businessId);
          if (ownerCount <= 1) throw AppError.conflict('LAST_OWNER_REMOVAL', 'A business must keep at least one owner');
        }
        await c.query(
          `UPDATE memberships SET status = 'suspended', disabled_at = now(), updated_at = now()
           WHERE business_id = $1 AND user_id = $2`,
          [m.businessId, targetUserId],
        );
      } else {
        if (target.status !== 'suspended') throw AppError.validation({ status: ['not_suspended'] });
        await this.entitlements.assertCanConsume(c, m.businessId, 'MAX_USERS');
        await c.query(
          `UPDATE memberships SET status = 'active', disabled_at = NULL, updated_at = now()
           WHERE business_id = $1 AND user_id = $2`,
          [m.businessId, targetUserId],
        );
      }
      await this.audit.recordTx(c, {
        action: suspended ? 'structure.member_suspended' : 'structure.member_reactivated',
        entity: 'membership',
        entityId: targetUserId,
        tenantId: m.tenantId,
        businessId: m.businessId,
      });
    });
  }

  /**
   * Replace a member's role set (union semantics — a user may hold several
   * roles; effective permissions = union of grants).
   */
  async setMemberRoles(m: MembershipContext, targetUserId: string, roleKeys: string[]): Promise<void> {
    if (roleKeys.length === 0) throw AppError.validation({ roleKeys: ['at_least_one_role'] });
    await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
      const target = await this.lockMembership(c, m.businessId, targetUserId);
      if (!target || target.status !== 'active') throw AppError.notFound('Member not found');
      const roles = [];
      for (const key of roleKeys) roles.push(await this.roleByKey(c, m.businessId, key));

      const hadOwner = await this.isOwnerMember(c, m.businessId, targetUserId);
      const keepsOwner = roles.some((r) => r.is_system && r.key === 'owner');
      if (hadOwner && !keepsOwner) {
        const ownerCount = await this.lockOwnerCount(c, m.businessId);
        if (ownerCount <= 1) throw AppError.conflict('LAST_OWNER_REMOVAL', 'A business must keep at least one owner');
      }
      // Granting owner is forbidden: owner identity is system-managed (onboarding/transfer only).
      if (!hadOwner && keepsOwner) throw AppError.forbidden('Owner role is system-managed');

      // Delegation ceiling (§30): the union of the assigned roles' effective
      // permissions must not exceed the actor's own grant authority.
      const roleIds = roles.map((r) => r.id as string);
      const grantedRows = (
        await c.query<{ permission: string }>('SELECT DISTINCT permission FROM role_permissions WHERE business_id = $1 AND role_id = ANY($2)', [
          m.businessId,
          roleIds,
        ])
      ).rows;
      this.assertDelegationCeiling(
        m,
        grantedRows.map((r) => r.permission as Permission),
      );

      await c.query('DELETE FROM membership_roles WHERE business_id = $1 AND user_id = $2', [m.businessId, targetUserId]);
      for (const r of roles) {
        await c.query('INSERT INTO membership_roles (business_id, user_id, role_id, assigned_by) VALUES ($1, $2, $3, $4)', [
          m.businessId,
          targetUserId,
          r.id,
          m.userId,
        ]);
      }
      await this.audit.recordTx(c, {
        action: 'structure.member_roles_changed',
        entity: 'membership',
        entityId: targetUserId,
        tenantId: m.tenantId,
        businessId: m.businessId,
        metadata: { roleKeys },
      });
    });
  }

  /**
   * Delegation ceiling (§27–30): non-owner actors may only delegate permissions
   * they personally hold. Owner identity (trusted, system role) is exempt.
   */
  private assertDelegationCeiling(m: MembershipContext, permissions: readonly Permission[]): void {
    const beyond = beyondGrantAuthority(m.roles, permissions);
    if (beyond.length > 0) {
      throw AppError.forbidden(`Delegation ceiling exceeded: ${beyond.join(', ')}`);
    }
  }

  /** Ceiling check for role assignment: the role's effective permissions must be ⊆ the actor's authority. */
  private async assertRoleWithinCeiling(c: import('pg').PoolClient, m: MembershipContext, roleId: string): Promise<void> {
    const rows = (
      await c.query<{ permission: string }>('SELECT permission FROM role_permissions WHERE business_id = $1 AND role_id = $2', [m.businessId, roleId])
    ).rows;
    this.assertDelegationCeiling(
      m,
      rows.map((r) => r.permission as Permission),
    );
  }

  /**
   * Membership authority lock — DEADLOCK-FREE ORDER (Concurrency Review §66,
   * "last owner"): every membership mutation first takes ONE business-level
   * advisory lock, then the target row (FOR UPDATE), then (when ownership is
   * involved) all owner rows via lockOwnerCount. Without the business-level
   * lock, two concurrent removals of the last two owners each locked their
   * own row and then waited for the other's (40P01 deadlock → HTTP 500).
   * With it, the second command waits and then sees the committed state
   * (one 200, one 409 LAST_OWNER_REMOVAL) — the invariant is proven by
   * tests/security/isolation.test.ts and the owner-authority suite.
   */
  private async lockMembership(c: import('pg').PoolClient, businessId: string, userId: string) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 91))', [businessId]);
    return (await c.query<{ status: string }>('SELECT status FROM memberships WHERE business_id = $1 AND user_id = $2 FOR UPDATE', [businessId, userId]))
      .rows[0];
  }

  private async isOwnerMember(c: import('pg').PoolClient, businessId: string, userId: string): Promise<boolean> {
    return !!(
      await c.query(
        `SELECT 1 FROM membership_roles mr
         JOIN business_roles r ON r.business_id = mr.business_id AND r.id = mr.role_id
         WHERE mr.business_id = $1 AND mr.user_id = $2 AND r.is_system AND r.key = 'owner' LIMIT 1`,
        [businessId, userId],
      )
    ).rows[0];
  }

  private async roleByKey(c: import('pg').PoolClient, businessId: string, key: string) {
    const role = (
      await c.query<{ id: string; is_system: boolean; key: string }>('SELECT id, is_system, key FROM business_roles WHERE business_id = $1 AND key = $2', [
        businessId,
        key,
      ])
    ).rows[0];
    if (!role) throw AppError.validation({ roleKey: ['unknown_role'] });
    return role;
  }

  /** Lock all owner memberships (FOR UPDATE) and count them — serializes concurrent owner removals. */
  private async lockOwnerCount(c: import('pg').PoolClient, businessId: string): Promise<number> {
    const rows = (
      await c.query<{ user_id: string }>(
        `SELECT m.user_id FROM memberships m
         JOIN membership_roles mr ON mr.business_id = m.business_id AND mr.user_id = m.user_id
         JOIN business_roles r ON r.business_id = mr.business_id AND r.id = mr.role_id
         WHERE m.business_id = $1 AND m.status = 'active' AND r.is_system AND r.key = 'owner'
         FOR UPDATE OF m`,
        [businessId],
      )
    ).rows;
    return rows.length;
  }
}
