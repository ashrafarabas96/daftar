import { Inject, Injectable } from '@nestjs/common';
import {
  hmacKeysEquivalent,
  mintAccountingAssertion,
  mintAccountingControlAssertion,
  parseAccountingAssertionKey,
  type AccountingAssertionClaims,
  type AccountingAssertionKey,
  type AccountingAssertionMinter,
  type AccountingControlAssertionClaims,
  type AccountingControlAssertionMinter,
} from '@daftar/accounting';
import type { AppConfig } from '../../config';

/**
 * The only holder of the accounting signing key in this process (§19).
 *
 * A process that was not configured with a key simply cannot mint, and
 * therefore cannot post: the failure is a missing capability, not a check
 * somebody can skip. The platform and worker runtimes are refused the key by
 * config validation, so this service exists there with nothing to sign with.
 *
 * The provisioning-secret comparison is repeated here, at the point where the
 * key is actually loaded, because config validation only runs in production
 * and a staging deployment that shared one secret would otherwise look fine
 * until the day one of them leaked. It compares the EFFECTIVE HMAC-SHA-256
 * key (P3-S8 A-19, TD-12): `K` and `K‖0x00` are one key although their bytes
 * differ, so a byte comparison would admit exactly the pair it exists to
 * refuse.
 */
@Injectable()
export class AccountingAssertionMinterService implements AccountingAssertionMinter, AccountingControlAssertionMinter {
  private readonly key: AccountingAssertionKey | null;

  constructor(@Inject('APP_CONFIG') config: AppConfig) {
    this.key = parseAccountingAssertionKey(config);
    if (this.key && config.PROVISIONING_ASSERTION_KEY) {
      const provisioning = Buffer.from(config.PROVISIONING_ASSERTION_KEY, 'base64');
      if (hmacKeysEquivalent(this.key.secret, provisioning)) {
        throw new Error('ACCOUNTING_ASSERTION_KEY must not be the same secret as PROVISIONING_ASSERTION_KEY (separate domains, rotated independently)');
      }
    }
  }

  /** True when this process is configured to mint at all. */
  get configured(): boolean {
    return this.key !== null;
  }

  mint(claims: AccountingAssertionClaims): string {
    if (!this.key) {
      throw new Error('ACCOUNTING_ASSERTION_KEY is not configured — posting requires a server-minted accounting assertion');
    }
    return mintAccountingAssertion(this.key, claims);
  }

  /**
   * The CONTROL format, on the same key material (§29).
   *
   * A separate method rather than an argument to `mint`, because the two
   * formats are cryptographically domain-separated and a single entry point
   * taking either claim shape would be one edit away from minting the wrong
   * one — exactly the substitution §30 requires to be impossible.
   */
  mintControl(claims: AccountingControlAssertionClaims): string {
    if (!this.key) {
      throw new Error('ACCOUNTING_ASSERTION_KEY is not configured — an accounting control command requires a server-minted assertion');
    }
    return mintAccountingControlAssertion(this.key, claims);
  }
}
