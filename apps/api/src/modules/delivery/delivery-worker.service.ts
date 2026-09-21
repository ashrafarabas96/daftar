import { hostname } from 'node:os';
import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../infra/database';
import type { CredentialDelivery } from '../auth/tokens';
import { CredentialPayloadProtector, credentialAad } from './credential-protector';
import { classifyDeliveryError } from './delivery-error';

/**
 * Credential delivery outbox worker (Final Closure §18–20, Gate A §3–19).
 *
 * Invitations and password resets share ONE reliable pipeline:
 *   Enqueue lives in CredentialDeliveryEnqueuer (merchant request path).
 *   This worker ONLY runs in the worker process: claim → decrypt → send →
 *   retry → dead-letter. The merchant process never instantiates it.
 *   drain()      — worker-role LEASED claim (FOR UPDATE SKIP LOCKED +
 *                  locked_by/lease_until), deliver via the configured
 *                  adapter, finalize with retry + exponential backoff; after
 *                  MAX_ATTEMPTS the row is dead-lettered. A crashed worker's
 *                  'processing' rows become reclaimable once lease_until
 *                  passes (at-least-once: a send may repeat after a crash —
 *                  the message is idempotent by design; exactly-once is
 *                  never claimed).
 *   retention    — the ciphertext payload is WIPED on terminal states
 *                  (sent/dead). Status, attempts, timestamps and safe errors
 *                  are all that remain.
 *
 * States: pending → processing → sent | failed(retryable) → dead.
 * Parent rows (business_invitations / password_reset_tokens) mirror the state
 * via the worker's column-scoped grants.
 */
export const DELIVERY_MAX_ATTEMPTS = 5;
/** Claim lease: a worker crash leaves rows reclaimable after this window. */
export const DELIVERY_LEASE_MS = 2 * 60 * 1000;

@Injectable()
export class CredentialDeliveryWorker {
  private readonly workerId = `${hostname()}:${process.pid}`;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject('CREDENTIAL_DELIVERY') private readonly delivery: CredentialDelivery,
    @Inject(CredentialPayloadProtector) private readonly protector: CredentialPayloadProtector,
  ) {}

  /** Post-commit trigger: drain due deliveries best-effort. Never throws —
   *  delivery failures are persisted, not propagated to the API caller.
   *  §XXIV ZERO SILENT ERRORS: failures are structured-logged (sanitized),
   *  counted, and carry the worker id for correlation. */
  static drainFailures = 0;

  async drainSafely(limit = 25): Promise<void> {
    await this.drain(limit).catch((e: unknown) => {
      CredentialDeliveryWorker.drainFailures += 1;
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'credential delivery drain failed',
          worker: this.workerId,
          errorCode: classifyDeliveryError(e),
          drainFailuresTotal: CredentialDeliveryWorker.drainFailures,
        }),
      );
    });
  }

  /**
   * §XX: startup/readiness key-ring coverage — every key_version referenced by
   * a non-terminal delivery MUST exist in the configured ring. If not, the
   * worker must not report ready (we fail BEFORE jobs start failing).
   */
  async assertKeyRingCoverage(): Promise<void> {
    const { rows } = await this.db.withWorkerTransaction((c) =>
      c.query<{ key_version: string }>(
        `SELECT DISTINCT key_version FROM credential_deliveries
         WHERE secret_ciphertext IS NOT NULL AND key_version IS NOT NULL`,
      ),
    );
    const covered = new Set(this.protector.coveredVersions());
    const missing = rows.map((r) => r.key_version).filter((v) => !covered.has(v));
    if (missing.length > 0) {
      throw new Error(`credential key ring does not cover in-use version(s): ${missing.join(', ')} — refusing to start (§XX)`);
    }
  }

  async drain(limit = 25): Promise<{ sent: number; failed: number; dead: number }> {
    const claimed = await this.db.withWorkerTransaction(
      async (c) =>
        (
          await c.query<{
            id: string;
            kind: 'invitation' | 'password_reset';
            email: string;
            secret_ciphertext: string | null;
            secret_nonce: string | null;
            key_version: string | null;
            invitation_id: string | null;
            password_reset_token_id: string | null;
            attempts: number;
          }>(
            `UPDATE credential_deliveries
         SET status = 'processing', locked_at = now(), locked_by = $2,
             lease_until = now() + ($3 || ' milliseconds')::interval, updated_at = now()
         WHERE id IN (
           SELECT id FROM credential_deliveries
           WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now())
              OR (status = 'processing' AND lease_until < now()) -- crashed-worker reclaim
           ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         RETURNING id, kind, email::text AS email, secret_ciphertext, secret_nonce, key_version,
                   invitation_id, password_reset_token_id, attempts`,
            [limit, this.workerId, String(DELIVERY_LEASE_MS)],
          )
        ).rows,
    );

    let sent = 0;
    let failed = 0;
    let dead = 0;
    for (const job of claimed) {
      let err: string | null = null;
      try {
        if (!job.secret_ciphertext || !job.secret_nonce || !job.key_version) {
          throw new Error('credential payload unavailable (wiped or unmigrated) — reissue required');
        }
        const parentId = job.invitation_id ?? job.password_reset_token_id;
        if (!parentId) throw new Error('credential delivery row missing parent id');
        const secret = this.protector.decrypt(
          { ciphertext: job.secret_ciphertext, nonce: job.secret_nonce, keyVersion: job.key_version },
          credentialAad({ kind: job.kind, email: job.email, parentId, deliveryId: job.id }),
        );
        if (job.kind === 'invitation') await this.delivery.sendInvitation(job.email, secret);
        else await this.delivery.sendPasswordReset(job.email, secret);
      } catch (e) {
        // §XXIII: NEVER persist raw provider errors — stable safe codes only.
        err = classifyDeliveryError(e);
      }
      const attempts = job.attempts + 1;
      const status = err === null ? 'sent' : attempts >= DELIVERY_MAX_ATTEMPTS ? 'dead' : 'failed';
      const terminal = status === 'sent' || status === 'dead';
      await this.db.withWorkerTransaction(async (c) => {
        await c.query(
          `UPDATE credential_deliveries
           SET status = $2, attempts = $3, last_error = $4,
               next_attempt_at = CASE WHEN $2 = 'failed' THEN now() + (interval '1 minute' * power(2, $3::int)) ELSE next_attempt_at END,
               lease_until = NULL, locked_by = NULL,
               -- §11 retention: the decryptable payload is wiped on terminal states.
               secret_ciphertext = CASE WHEN $5 THEN NULL ELSE secret_ciphertext END,
               secret_nonce = CASE WHEN $5 THEN NULL ELSE secret_nonce END,
               updated_at = now()
           WHERE id = $1`,
          [job.id, status, attempts, err, terminal],
        );
        if (job.invitation_id) {
          await c.query(
            `UPDATE business_invitations
             SET delivery_status = $2, delivery_attempts = $3, last_delivery_error = $4
             WHERE id = $1`,
            [job.invitation_id, status, attempts, err],
          );
        }
        if (job.password_reset_token_id) {
          await c.query(
            `UPDATE password_reset_tokens
             SET delivery_status = $2, delivery_attempts = $3, last_delivery_error = $4
             WHERE id = $1`,
            [job.password_reset_token_id, status, attempts, err],
          );
        }
      });
      if (status === 'sent') sent += 1;
      else if (status === 'dead') dead += 1;
      else failed += 1;
    }
    return { sent, failed, dead };
  }
}
