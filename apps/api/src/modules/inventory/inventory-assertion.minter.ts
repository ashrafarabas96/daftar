import { Inject, Injectable } from '@nestjs/common';
import {
  INVENTORY_ASSERTION_TTL_SECONDS,
  mintInventoryAssertion,
  parseInventoryAssertionKey,
  secretsAreIdentical,
  type InventoryAssertionClaims,
  type InventoryAssertionKey,
} from '@daftar/inventory';
import type { AppConfig } from '../../config';

/**
 * What a domain command that has proved its own authority states when it asks
 * for an `invctl/1` assertion (P3-AL-55 §I): the actor, the tenant and
 * business, the operation kind and the digest of the exact payload it will
 * pass to the routine. The `jti` is not the caller's to choose — it is
 * random, one per minted assertion — so it is not part of this type.
 */
export type InventoryMintClaims = Omit<InventoryAssertionClaims, 'jti'>;

/**
 * The only holder of the inventory signing key in this process (P3-AL-55 §C).
 *
 * A process that was not configured with a key simply cannot mint, and
 * therefore cannot drive any inventory routine: the failure is a missing
 * capability, not a check somebody can skip. The platform, worker and
 * reconciler runtimes are refused the key by config validation and do not
 * compose this service at all.
 *
 * It takes typed claims and never a permission string. The operation kind IS
 * the server-side decision; a caller reaches `mint` only after the domain
 * permission, the branch/warehouse scope and the payload validation passed —
 * an assigned-scope actor asking for an association assertion is refused
 * before this service is called (P3-AL-15 §B, matrix row L).
 *
 * The byte-separation check is repeated here, in constant time, at the point
 * where the key is actually loaded: config validation runs only in
 * production, and a staging deployment that shared one secret between two
 * domains would otherwise look fine until the day one of them leaked
 * (the pattern of `accounting-assertion.minter.ts`).
 */
@Injectable()
export class InventoryAssertionMinterService {
  private readonly key: InventoryAssertionKey | null;

  constructor(@Inject('APP_CONFIG') config: AppConfig) {
    this.key = config.INVENTORY_ASSERTION_KEY
      ? parseInventoryAssertionKey({ kid: config.INVENTORY_ASSERTION_KID ?? 'v1', keyBase64: config.INVENTORY_ASSERTION_KEY })
      : null;
    if (!this.key) return;
    if (config.PROVISIONING_ASSERTION_KEY && secretsAreIdentical(this.key.secret, Buffer.from(config.PROVISIONING_ASSERTION_KEY, 'base64'))) {
      throw new Error('INVENTORY_ASSERTION_KEY must not be the same secret as PROVISIONING_ASSERTION_KEY (separate domains, rotated independently)');
    }
    if (config.ACCOUNTING_ASSERTION_KEY && secretsAreIdentical(this.key.secret, Buffer.from(config.ACCOUNTING_ASSERTION_KEY, 'base64'))) {
      throw new Error('INVENTORY_ASSERTION_KEY must not be the same secret as ACCOUNTING_ASSERTION_KEY (separate domains, rotated independently)');
    }
  }

  /** True when this process is configured to mint at all. */
  get configured(): boolean {
    return this.key !== null;
  }

  /**
   * Mint one `invctl/1` assertion for an already-authorized command, living
   * exactly `INVENTORY_ASSERTION_TTL_SECONDS` (60). The database refuses any
   * assertion whose expiry is more than 65 seconds ahead of its own clock.
   */
  mint(claims: InventoryMintClaims): string {
    if (!this.key) {
      throw new Error('INVENTORY_ASSERTION_KEY is not configured — an inventory command requires a server-minted inventory assertion');
    }
    return mintInventoryAssertion(
      {
        actorUserId: claims.actorUserId,
        tenantId: claims.tenantId,
        businessId: claims.businessId,
        opCode: claims.opCode,
        payloadSha256: claims.payloadSha256,
      },
      this.key,
      new Date(),
      INVENTORY_ASSERTION_TTL_SECONDS,
    );
  }
}
