import { randomUUID } from 'node:crypto';
import { Injectable, Inject, Logger } from '@nestjs/common';
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
 * One refused command, as the audit row records it.
 *
 * It is NOT an `AuditEntry` with a code bolted on: a refusal has no document
 * row to be recovered by join, so every claim P4-AL-48 makes about it has to
 * be carried in the row's own metadata. That is the whole reason this is a
 * separate type (see `recordRefusal` and the F-3 answer in
 * `docs/PHASE_4_DECISION_REGISTER.md`).
 */
export interface AuditRefusalEntry {
  /**
   * The `invctl/1` operation the command exercised — `customer.collect_payment`,
   * `customer.apply_credit`. This is the PERMISSION EXERCISED, carried
   * literally, because the join that recovers it for a success
   * (`inventory_assertion_uses.op_code`, `0054:88-94`, keyed by the `jti` the
   * success row stores) has no row at all after an abort: the consume's
   * INSERT (`0054:450-451`) rolled back with everything else.
   */
  operation: string;
  /** The stable refusal code the merchant was answered with. */
  refusalCode: string;
  entity: string;
  /** The document's UUID — the caller-supplied id of the command that was refused. */
  entityId?: string;
  /**
   * The request-only intent digest this command proved itself by, when the
   * refusal happened after it was computed. Carried literally for the same
   * reason as `operation`: for a refusal there is no `payments` row to read
   * `intent_sha256` off.
   */
  intentSha256?: string;
  /** The branch dimension, when one was bound before the refusal. */
  branchId?: string | null;
  /** The till session, when the refused command ran on a POS path. */
  tillSessionId?: string | null;
  /**
   * THE FIGURES THAT CAUSED IT. Minor units as decimal strings, never a
   * number: a `bigint` amount that becomes a float on the way into JSON is
   * not the figure that caused the refusal. No account code, no journal line,
   * no routine name, no constraint name — P4-AL-54 governs what a refusal may
   * carry, and that applies to the audit row as much as to the response.
   */
  figures?: Readonly<Record<string, string | boolean | null>>;
  actorUserId?: string;
}

/**
 * Audit (§65): append-only by DB trigger; captures actor/tenant/business/
 * action/entity/entity-id/request-correlation/time.
 *
 * ## The atomicity invariant, stated honestly (P4-AL-48)
 *
 * There are TWO kinds of audit row and they have DIFFERENT durability
 * contracts. The distinction is not a convenience: it is forced by the
 * exception/transaction model, and stating one contract for both was a false
 * claim this comment used to make.
 *
 * - **EFFECT-AUDIT — `recordTx`, the same transaction, MANDATORY.** A row that
 *   records something that HAPPENED is always written INSIDE the business
 *   transaction, so the record and its audit commit or roll back together. A
 *   change whose audit fails is a change that does not happen. This is the
 *   invariant, unchanged, and it is the only shape allowed for a success.
 * - **REFUSAL-AUDIT — `recordRefusal`, its OWN transaction, AFTER the abort.**
 *   A refusal is not an effect; it is an ATTEMPT. Writing it inside the
 *   transaction it describes is not merely weaker, it is IMPOSSIBLE: a
 *   `RAISE EXCEPTION` aborts the transaction, so a row written before the
 *   `RAISE` does not survive either, and the 33 raises of
 *   `customer_collect_payment` all precede its audit INSERT
 *   (`0081:1874-2128` against `0081:2170`). Measured: audit 8 before and 8
 *   after a 409, outbox 7 and 7. So the refusal row is written in a SECOND,
 *   own-scope transaction once the first has already rolled back.
 *
 * Writing a record of an attempt in its own committed transaction does not
 * violate the atomicity invariant's SPIRIT, because there is no effect for it
 * to be atomic with. The already-accepted shape for an own-transaction write
 * from a service is `OutboxService.emit` below, and `recordRefusal` is that
 * shape and no new one.
 *
 * **What this does NOT give, and no document may claim it does.** The refusal
 * row is written on a BEST-EFFORT basis: if its own transaction also fails,
 * the merchant is still answered with the refusal they earned, and the audit
 * loss is reported to the process log. A refusal-audit failure may never be
 * turned into a 500, because a merchant told "internal error" for a
 * `date_in_future` has been given a worse answer than an un-audited refusal.
 * Durability of a refusal record is therefore HIGH, not ABSOLUTE, and that is
 * exactly as strong as this transaction model permits.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(Database) private readonly db: Database) {}

  async recordTx(client: PoolClient, entry: AuditEntry): Promise<void> {
    const ctx = getContext();
    const businessId = entry.businessId ?? ctx?.businessId ?? null;
    let tenantId = entry.tenantId ?? ctx?.tenantId ?? null;
    // §47: a business-scoped record ALWAYS carries its owning tenant (DB CHECK +
    // composite FK). Platform-context writers (admin console) name a business
    // without a tenant context — resolve it here, inside the same transaction.
    if (businessId && !tenantId) {
      const { rows } = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM businesses WHERE id = $1', [businessId]);
      tenantId = rows[0]?.tenant_id ?? null;
      if (!tenantId) throw new Error(`audit record names business ${businessId} which has no resolvable tenant`);
    }
    await client.query(
      `INSERT INTO audit_events (tenant_id, business_id, actor_user_id, action, entity, entity_id, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenantId,
        businessId,
        entry.actorUserId ?? ctx?.userId ?? null,
        entry.action,
        entry.entity,
        entry.entityId ?? null,
        ctx?.requestId ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }

  /**
   * Record a REFUSED command in its own committed transaction (P4-AL-48).
   *
   * Called from a command's catch, AFTER its business transaction has already
   * rolled back — so `scope` opens a second, business-scoped `daftar_app`
   * transaction, exactly as `OutboxService.emit` does. `daftar_app` holds
   * `INSERT ON audit_events` (`0006:79`) and the `audit_scope` policy's
   * `WITH CHECK` admits a row of its own business (`0006:53-55`), so this
   * needs no migration, no new role and no new grant.
   *
   * The action is `<operation>.refused`, which keeps a refusal findable beside
   * the success it was an attempt at (`customer.payment_collected` versus
   * `customer.collect_payment.refused`) without ever being mistaken for one.
   *
   * It NEVER throws. The caller is in the middle of answering a refusal and
   * must keep answering it; an audit write that fails is logged and dropped.
   */
  async recordRefusal(scope: { tenantId: string; businessId: string }, entry: AuditRefusalEntry): Promise<void> {
    try {
      await this.db.withTransaction(scope, (c) =>
        this.recordTx(c, {
          action: `${entry.operation}.refused`,
          entity: entry.entity,
          entityId: entry.entityId,
          actorUserId: entry.actorUserId,
          tenantId: scope.tenantId,
          businessId: scope.businessId,
          metadata: {
            outcome: 'refused',
            refusalCode: entry.refusalCode,
            operation: entry.operation,
            intentSha256: entry.intentSha256 ?? null,
            branchId: entry.branchId ?? null,
            tillSessionId: entry.tillSessionId ?? null,
            figures: entry.figures ?? {},
          },
        }),
      );
    } catch (e) {
      // The refusal the merchant is owed outranks its own audit row. Report
      // the loss where an operator sees it; never re-throw into the refusal.
      this.logger.error(`refusal audit lost for ${entry.operation} (${entry.refusalCode}): ${e instanceof Error ? e.message : String(e)}`);
    }
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
    let tenantId = event.tenantId ?? null;
    if (event.businessId && !tenantId) {
      const { rows } = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM businesses WHERE id = $1', [event.businessId]);
      tenantId = rows[0]?.tenant_id ?? null;
      if (!tenantId) throw new Error(`outbox event names business ${event.businessId} which has no resolvable tenant`);
    }
    await client.query(`INSERT INTO outbox_events (tenant_id, business_id, type, payload) VALUES ($1, $2, $3, $4)`, [
      tenantId,
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
