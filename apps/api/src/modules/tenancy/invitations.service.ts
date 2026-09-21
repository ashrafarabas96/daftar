import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AppError, beyondGrantAuthority, type Permission } from '@daftar/domain-core';
import type { InvitationDto } from '@daftar/shared-contracts';
import { Database } from '../../infra/database';
import { AuditService, newId } from '../audit/audit.service';
import { EntitlementService } from '../entitlements/entitlements.service';
import { hashPassword } from '../auth/tokens';
import { CredentialDeliveryEnqueuer } from '../delivery/credential-enqueuer.service';
import { mapProvisionError } from './provision-errors';
import type { MembershipContext } from './tenancy.service';

/** Invite token TTL is enforced in SQL (72 hours). */
function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Business invitations (Wave 5): invite / resend / cancel / accept with
 * expiry, duplicate-invite protection, existing-user and new-user joins.
 * Invite tokens are stored HASHED; the raw token is delivered via the
 * CredentialDelivery seam (log adapter in dev — announces itself).
 */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EntitlementService) private readonly entitlements: EntitlementService,
    @Inject(CredentialDeliveryEnqueuer) private readonly enqueuer: CredentialDeliveryEnqueuer,
  ) {}

  /**
   * Expired-sweep (WAVE 4): pending rows past expires_at are transitioned to
   * 'expired' BEFORE any invite/list/resend logic — a stale pending row must
   * never block the partial unique index or hold a quota reservation.
   */
  private async sweepExpired(c: import('pg').PoolClient, businessId: string): Promise<void> {
    await c.query(
      `UPDATE business_invitations SET status = 'expired', responded_at = now()
       WHERE business_id = $1 AND status = 'pending' AND expires_at <= now()`,
      [businessId],
    );
  }

  async list(m: MembershipContext): Promise<InvitationDto[]> {
    // Sweep expired rows first so listings never show stale 'pending' rows.
    await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, (c) => this.sweepExpired(c, m.businessId));
    const rows = (
      await this.db.scoped<{
        id: string;
        email: string;
        role_key: string;
        status: InvitationDto['status'];
        expires_at: Date;
        created_at: Date;
        delivery_status: InvitationDto['deliveryStatus'];
        delivery_attempts: number;
      }>(
        { tenantId: m.tenantId, businessId: m.businessId },
        `SELECT i.id, i.email::text AS email, r.key AS role_key, i.status, i.expires_at, i.created_at,
                i.delivery_status, i.delivery_attempts
         FROM business_invitations i
         JOIN business_roles r ON r.business_id = i.business_id AND r.id = i.role_id
         WHERE i.business_id = $1 ORDER BY i.created_at DESC`,
        [m.businessId],
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      roleKey: r.role_key,
      status: r.status,
      expiresAt: r.expires_at.toISOString(),
      createdAt: r.created_at.toISOString(),
      deliveryStatus: r.delivery_status,
      deliveryAttempts: r.delivery_attempts,
    }));
  }

  /** Invite. Duplicate pending invite for same email → 409 (partial unique index is the final arbiter). */
  async invite(m: MembershipContext, email: string, roleKey: string): Promise<InvitationDto> {
    if (roleKey === 'owner') throw AppError.forbidden('Owner role is system-managed');
    const token = randomBytes(32).toString('base64url');
    const id = newId();
    const created: { value: { expiresAt: string; createdAt: string } | null } = { value: null };
    // §16–17 (Final Closure): email → userId runs on the IDENTITY boundary
    // (daftar_identity owns the users table); the membership check then runs
    // on the business app boundary. Platform credentials are never used for
    // convenience lookups.
    const invitee = (await this.db.withIdentityTransaction((c) => c.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))).rows[0];
    if (invitee) {
      const existingMember = (
        await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, (c) =>
          c.query(
            `SELECT 1 FROM memberships mm
           WHERE mm.business_id = $1 AND mm.user_id = $2 AND mm.status IN ('active','invited')`,
            [m.businessId, invitee.id],
          ),
        )
      ).rowCount;
      if (existingMember) throw AppError.conflict('ALREADY_MEMBER', 'User is already a member');
    }
    try {
      await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
        await this.sweepExpired(c, m.businessId);
        const role = (
          await c.query<{ id: string; is_system: boolean }>('SELECT id, is_system FROM business_roles WHERE business_id = $1 AND key = $2', [
            m.businessId,
            roleKey,
          ])
        ).rows[0];
        if (!role) throw AppError.validation({ roleKey: ['unknown_role'] });
        if (role.is_system) throw AppError.forbidden('System roles are not assignable via invitation');
        // Delegation ceiling (§27–30): the invited role's effective permissions
        // must not exceed the inviter's own grant authority (owner exempt).
        const granted = (
          await c.query<{ permission: string }>('SELECT permission FROM role_permissions WHERE business_id = $1 AND role_id = $2', [m.businessId, role.id])
        ).rows.map((r) => r.permission as Permission);
        const beyond = beyondGrantAuthority(m.roles, granted);
        if (beyond.length > 0) throw AppError.forbidden(`Delegation ceiling exceeded: ${beyond.join(', ')}`);
        // Duplicate pending invite for the same email → 409 BEFORE quota logic
        // (a duplicate must not consume/report a quota slot).
        const dupe = (
          await c.query(
            `SELECT 1 FROM business_invitations
             WHERE business_id = $1 AND email = $2 AND status = 'pending' AND expires_at > now()`,
            [m.businessId, email],
          )
        ).rowCount;
        if (dupe) throw AppError.conflict('INVITATION_EXISTS', 'A pending invitation already exists for this email');
        // Pending invites count against MAX_USERS — quota checked inside the same tx.
        await this.entitlements.assertCanConsume(c, m.businessId, 'MAX_USERS');
        const inserted = (
          await c.query<{ expires_at: Date; created_at: Date }>(
            `INSERT INTO business_invitations (id, business_id, email, role_id, token_hash, invited_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, now() + interval '72 hours')
             RETURNING expires_at, created_at`,
            [id, m.businessId, email, role.id, hashInviteToken(token), m.userId],
          )
        ).rows[0];
        if (!inserted) throw new Error('invitation insert returned no row');
        created.value = { expiresAt: inserted.expires_at.toISOString(), createdAt: inserted.created_at.toISOString() };
        await this.audit.recordTx(c, {
          action: 'structure.invitation_created',
          entity: 'invitation',
          entityId: id,
          tenantId: m.tenantId,
          businessId: m.businessId,
          metadata: { email, roleKey },
        });
        // Outbox enqueue IN the same transaction — a committed invitation is
        // never left without a pending delivery (§18).
        await this.enqueuer.enqueueTx(c, { kind: 'invitation', invitationId: id, businessId: m.businessId, email, secret: token });
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw AppError.conflict('INVITATION_EXISTS', 'A pending invitation already exists for this email');
      }
      throw e;
    }
    if (!created.value) throw new Error('invitation was not created');
    return {
      id,
      email,
      roleKey,
      status: 'pending',
      expiresAt: created.value.expiresAt,
      createdAt: created.value.createdAt,
      deliveryStatus: 'pending',
      deliveryAttempts: 0,
    };
  }

  async cancel(m: MembershipContext, invitationId: string): Promise<void> {
    await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
      const res = await c.query(
        `UPDATE business_invitations SET status = 'cancelled', responded_at = now()
         WHERE id = $1 AND business_id = $2 AND status = 'pending'`,
        [invitationId, m.businessId],
      );
      if (!res.rowCount) throw AppError.notFound('Pending invitation not found');
      await this.audit.recordTx(c, {
        action: 'structure.invitation_cancelled',
        entity: 'invitation',
        entityId: invitationId,
        tenantId: m.tenantId,
        businessId: m.businessId,
      });
    });
  }

  /**
   * Resend: rotate token, extend expiry — single pending invite preserved.
   * POLICY (WAVE 4, documented): an EXPIRED invitation is never silently
   * extended — resend rejects it with INVITATION_EXPIRED; create a fresh
   * invitation instead. The expired-sweep runs first so time-expired pending
   * rows are transitioned before this decision.
   */
  async resend(m: MembershipContext, invitationId: string): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.db.withTransaction({ tenantId: m.tenantId, businessId: m.businessId }, async (c) => {
      await this.sweepExpired(c, m.businessId);
      const current = (
        await c.query<{ status: string }>('SELECT status FROM business_invitations WHERE id = $1 AND business_id = $2', [invitationId, m.businessId])
      ).rows[0];
      if (!current) throw AppError.notFound('Invitation not found');
      if (current.status === 'expired') {
        throw AppError.conflict('INVITATION_EXPIRED', 'Invitation expired — create a new invitation');
      }
      const res = await c.query<{ email: string }>(
        `UPDATE business_invitations
         SET token_hash = $3, expires_at = now() + interval '72 hours'
         WHERE id = $1 AND business_id = $2 AND status = 'pending'
         RETURNING email::text AS email`,
        [invitationId, m.businessId, hashInviteToken(token)],
      );
      const row = res.rows[0];
      if (!row) throw AppError.notFound('Pending invitation not found');
      await this.audit.recordTx(c, {
        action: 'structure.invitation_resent',
        entity: 'invitation',
        entityId: invitationId,
        tenantId: m.tenantId,
        businessId: m.businessId,
      });
      // Resend re-enqueues with the ROTATED token (old token dead).
      await this.enqueuer.enqueueTx(c, { kind: 'invitation', invitationId, businessId: m.businessId, email: row.email, secret: token });
    });
  }

  /**
   * Accept an invitation. Existing user: supply only the token while
   * authenticated. New user: token + password + display name registers and
   * joins in one transaction.
   */
  async accept(token: string, user: { userId: string } | { email: string; password: string; displayName: string }): Promise<{ businessId: string }> {
    // Phase 1 (lock-free): resolve + expiry check. Expiry is a committed state
    // transition of its own — it must NOT roll back with an aborted accept tx.
    // §13 (Stabilization): invitation acceptance is PROVISIONER authority.
    // No actor yet (new-user registration path): peek/expire only touch the
    // token's own row and take no actor-dependent decision.
    const peek = await this.db.withProvisionerTransaction(null, null, async (c) => {
      const row = (
        await c.query<{ id: string; email: string; expires_at: Date }>('SELECT id, email, expires_at FROM provision_peek_invitation($1)', [
          hashInviteToken(token),
        ])
      ).rows[0];
      if (row && row.expires_at.getTime() < Date.now()) {
        await c.query('SELECT provision_expire_invitation($1)', [row.id]);
        return 'expired' as const;
      }
      return row ? row : ('missing' as const);
    });
    if (peek === 'missing') throw AppError.notFound('Invitation not found');
    if (peek === 'expired') throw AppError.conflict('INVITATION_EXPIRED', 'Invitation has expired');

    // Phase 1.5 (IDENTITY boundary, §16–17): resolve or provision the user via
    // daftar_identity. The platform accept transaction never touches users.
    let userId: string;
    if ('userId' in user) {
      userId = user.userId;
      const u = (
        await this.db.withIdentityTransaction((c) =>
          c.query<{ email: string }>('SELECT email::text AS email FROM users WHERE id = $1 AND status = $2', [userId, 'active']),
        )
      ).rows[0];
      if (!u) throw AppError.unauthenticated('User no longer active');
      if (u.email.toLowerCase() !== peek.email.toLowerCase()) {
        throw AppError.forbidden('Invitation is addressed to a different email');
      }
    } else {
      if (user.email.toLowerCase() !== peek.email.toLowerCase()) {
        throw AppError.validation({ email: ['must_match_invitation'] });
      }
      const hash = await hashPassword(user.password);
      userId = newId();
      try {
        await this.db.withIdentityTransaction((c) =>
          c.query('INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)', [userId, user.email, hash, user.displayName]),
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw AppError.conflict('EMAIL_TAKEN', 'Email already registered');
        throw e;
      }
    }

    // Phase 2: atomic accept — ONE narrow SECURITY DEFINER command performs
    // the cross-scope transition (lock → reservation conversion → quota →
    // tenant member → membership state machine → role → audit). The RLS
    // bypass exists only inside that function (§15–21).
    try {
      const accepted = await this.db.withProvisionerTransaction(
        userId,
        'accept_invitation',
        async (c) =>
          (
            await c.query<{ invitation_id: string; business_id: string; tenant_id: string }>(
              'SELECT o_invitation_id AS invitation_id, o_business_id AS business_id, o_tenant_id AS tenant_id FROM provision_accept_invitation($1)',
              [hashInviteToken(token)],
            )
          ).rows[0],
      );
      if (!accepted) throw AppError.notFound('Invitation not found');
      return { businessId: accepted.business_id };
    } catch (e) {
      mapProvisionError(e);
    }
  }
}
