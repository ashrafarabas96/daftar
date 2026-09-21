import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { credentialAad, type CredentialPayloadEncryptor } from './credential-protector';

/**
 * CredentialDeliveryEnqueuer (Stabilization Part C / Ultimate Closure §33–39):
 * the ONLY credential-delivery responsibility the merchant request path has.
 *
 * Flow law: tx(credential record + encrypted enqueue) → COMMIT → HTTP response.
 *   - NO SMTP in the request path.
 *   - NO worker drain in the request path.
 *   - NO decryption material in the merchant process (the injected encryptor
 *     is encrypt-only; in production it is a KMS-style remote adapter and the
 *     process holds no key material at all).
 *
 * The CredentialDeliveryWorker (separate process) claims, decrypts, sends,
 * retries and dead-letters after commit.
 */
export interface DeliveryEnqueue {
  kind: 'invitation' | 'password_reset';
  email: string;
  secret: string;
  businessId?: string;
  invitationId?: string;
  passwordResetTokenId?: string;
}

@Injectable()
export class CredentialDeliveryEnqueuer {
  constructor(@Inject('CREDENTIAL_ENCRYPTOR') private readonly encryptor: CredentialPayloadEncryptor) {}

  async enqueueTx(c: PoolClient, row: DeliveryEnqueue): Promise<void> {
    // §28: the AAD binds the payload to kind + recipient + parent + delivery id,
    // so the delivery id is generated HERE (not by the DB default).
    const id = randomUUID();
    const parentId = row.invitationId ?? row.passwordResetTokenId;
    if (!parentId) throw new Error('credential delivery requires a parent credential id');
    const payload = await this.encryptor.encrypt(row.secret, credentialAad({ kind: row.kind, email: row.email, parentId, deliveryId: id }));
    await c.query(
      `INSERT INTO credential_deliveries
         (id, kind, business_id, invitation_id, password_reset_token_id, email,
          secret_ciphertext, secret_nonce, key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        row.kind,
        row.businessId ?? null,
        row.invitationId ?? null,
        row.passwordResetTokenId ?? null,
        row.email,
        payload.ciphertext,
        payload.nonce,
        payload.keyVersion,
      ],
    );
  }
}
