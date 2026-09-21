import { Injectable, Inject } from '@nestjs/common';
import { Database } from '../../infra/database';
import type { Logger } from '../../infra/logger';

export const MAX_ATTEMPTS = 8;
export const BATCH_SIZE = 50;

export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts * 5, 3600);
}

/** Delivery sink — deterministic adapters in tests; real integrations subscribe here. */
export interface OutboxSink {
  deliver(type: string, payload: Record<string, unknown>): Promise<void>;
}

export class LogSink implements OutboxSink {
  constructor(private readonly logger: Logger) {}
  deliver(type: string, payload: Record<string, unknown>): Promise<void> {
    this.logger.info({ outboxType: type, payloadKeys: Object.keys(payload) }, 'outbox event delivered');
    return Promise.resolve();
  }
}

/**
 * Outbox publisher (§66): at-least-once delivery. Rows are claimed FOR UPDATE
 * SKIP LOCKED (multi-instance safe §112), delivered, then marked published in
 * the same transaction. Failures retry with exponential backoff; after
 * MAX_ATTEMPTS the event is dead-lettered (status='dead') — never silently lost.
 * Consumers MUST be idempotent: a duplicate delivery is legal by design.
 */
@Injectable()
export class OutboxPublisher {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject('OUTBOX_SINK') private readonly sink: OutboxSink,
  ) {}

  async publishOnce(): Promise<{ delivered: number; dead: number }> {
    return this.db.withWorkerTransaction( async (c) => {
      const rows = (
        await c.query<{ id: string; type: string; payload: Record<string, unknown>; attempts: number }>(
          `SELECT id, type, payload, attempts FROM outbox_events
           WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [BATCH_SIZE],
        )
      ).rows;

      let delivered = 0;
      let dead = 0;
      for (const row of rows) {
        try {
          await this.sink.deliver(row.type, row.payload);
          await c.query(`UPDATE outbox_events SET status = 'published', published_at = now() WHERE id = $1`, [row.id]);
          delivered += 1;
        } catch {
          const attempts = row.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            await c.query(`UPDATE outbox_events SET status = 'dead', attempts = $2 WHERE id = $1`, [row.id, attempts]);
            dead += 1;
          } else {
            await c.query(
              `UPDATE outbox_events SET attempts = $2, next_attempt_at = now() + ($3 || ' seconds')::interval WHERE id = $1`,
              [row.id, attempts, backoffSeconds(attempts)],
            );
          }
        }
      }
      return { delivered, dead };
    });
  }
}
