/**
 * Minting the accounting assertion for a DOMAIN posting (P3-AL-33, L:1022-1030;
 * PHASE_3_S3_CONTRACT A-06).
 *
 * A financial domain command — an inventory adjustment, damage, stocktake
 * finalization or opening — writes its source document and the journal entry
 * its success implies in ONE transaction (seam 2, P3-AL-32). That seam takes
 * the accounting assertion when it opens, so the assertion must be minted
 * over the exact posting BEFORE the transaction starts. `AccountingEngine.post`
 * cannot do it: it posts in its own transaction and refuses domain sources
 * (TL-10). This function only mints; the posting itself still goes through
 * the one generic primitive, `accounting_post_entry`, via
 * `AccountingPostingTransactionPort.postEntryInTransaction`. No new journal
 * writer exists.
 *
 * What it checks, in order:
 *
 * 1. The source is domain-owned (`DOMAIN_SOURCE_TYPES`). A Phase-2-native
 *    source (`NATIVE_SOURCE_TYPES`) has its own command and detail row, and
 *    anything else has no domain command behind it at all; both are refused
 *    with `accounting.assertion_wrong_source`.
 * 2. `validatePostingCommand` — the structural invariants the database also
 *    enforces.
 * 3. `computeCommandFingerprint` — `acctfp/1` over the actual lines.
 *
 * It deliberately does NOT run `validateBranchScope`. Merchant accounting
 * branch scope governs merchant-authored entries; this entry is derived by
 * the domain command, whose authority is the warehouse scope of P3-AL-39,
 * already checked and bound into the signed inventory assertion (L:1024).
 *
 * There is no flag, no boolean and no "trusted" parameter (L:1030). The
 * physical guarantees remain the database's: guard G-4, and the deferred
 * completeness triggers that refuse an entry of a domain source without its
 * source document, whoever minted the assertion.
 */
import { AccountingError } from './errors';
import type { AccountingAssertionMinter } from './ports';
import { computeCommandFingerprint, DOMAIN_SOURCE_TYPES, NATIVE_SOURCE_TYPES, validatePostingCommand } from './post';
import type { PostingCommand } from './types';

export type DomainSourceType = (typeof DOMAIN_SOURCE_TYPES)[number];

/** True for a source type a domain command owns. */
export function isDomainSourceType(sourceType: string): sourceType is DomainSourceType {
  return (DOMAIN_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

/**
 * Mint the `post` assertion for a domain command's derived posting. `actorUserId`
 * is the authenticated member the domain authority was established for.
 */
export function mintDomainPostingAssertion(minter: AccountingAssertionMinter, command: PostingCommand, actorUserId: string): string {
  const context = { businessId: command.businessId, sourceType: command.sourceType, sourceId: command.sourceId };
  if ((NATIVE_SOURCE_TYPES as readonly string[]).includes(command.sourceType)) {
    throw new AccountingError('accounting.assertion_wrong_source', `${command.sourceType} entries are posted through their own command`, context);
  }
  if (!isDomainSourceType(command.sourceType)) {
    throw new AccountingError('accounting.assertion_wrong_source', `${command.sourceType} is not a domain-owned source type`, context);
  }
  validatePostingCommand(command);
  const postingFingerprint = computeCommandFingerprint(command);
  return minter.mint({
    actorUserId,
    tenantId: command.tenantId,
    businessId: command.businessId,
    operationKind: 'post',
    sourceType: command.sourceType,
    sourceId: command.sourceId,
    postingFingerprint,
  });
}
