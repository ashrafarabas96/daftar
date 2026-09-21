import { randomUUID } from 'node:crypto';
import { Injectable, Inject } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Database } from '../../infra/database';
import { getContext } from '../../infra/request-context';

export function newId(): string {
  return randomUUID();
}

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string;
  actorUserId?: string;
  tenantId?: string;
  businessId?: string;
  metadata?: Record<string, unknown>; // safe only: never tokens/passwords/private URLs
}

/**
 * Audit (§65): append-only by DB trigger; captures actor/tenant/business/
 * action/entity/entity-id/request-correlation/time. Always written INSIDE the
 * business transaction so the record and its audit commit or roll back together.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async recordTx(client: PoolClient, entry: AuditEntry): Promise<void> {
    const ctx = getContext();
    await client.query(
      `INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.tenantId ?? ctx?.tenantId ?? null,
        entry.businessId ?? ctx?.businessId ?? null,
        entry.actorUserId ?? ctx?.userId ?? null,
        entry.action,
        entry.entity,
        entry.entityId ?? null,
        ctx?.requestId ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }
}

export interface OutboxEvent {
  type: string;
  payload: Record<string, unknown>;
  tenantId?: string;
  businessId?: string;
}

/**
 * Transactional outbox (§66): the event row is written in the SAME transaction
 * as the business change — atomic by construction. Delivery is at-least-once;
 * consumers must be idempotent (publisher marks published only after sink ack).
 */
@Injectable()
export class OutboxService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async emitTx(client: PoolClient, event: OutboxEvent): Promise<void> {
    await client.query(`INSERT INTO outbox_events (tenant_id, business_id, type, payload) VALUES ($1, $2, $3, $4)`, [
      event.tenantId ?? null,
      event.businessId ?? null,
      event.type,
      JSON.stringify(event.payload),
    ]);
  }

  /**
   * Standalone emit (Stabilization §17): opens its OWN business-scoped
   * app-role transaction. Used by post-commit reconciliation flows (e.g.
   * media orphan cleanup) that must never borrow platform authority.
   */
  async emit(scope: { tenantId: string; businessId: string }, event: OutboxEvent): Promise<void> {
    await this.db.withTransaction(scope, (c) => this.emitTx(c, event));
  }
}
