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
import { canonicalDate } from './fingerprint';
import type { AccountingAssertionMinter } from './ports';
import { computeCommandFingerprint, DOMAIN_REVERSIBLE_SOURCE_TYPES, DOMAIN_SOURCE_TYPES, NATIVE_SOURCE_TYPES, validatePostingCommand } from './post';
import { computeReversalFingerprint, mirrorReversalLines, type PostedEntrySnapshot } from './sources';
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

export type DomainReversibleSourceType = (typeof DOMAIN_REVERSIBLE_SOURCE_TYPES)[number];

/** True for a domain source whose entry a domain command may reverse (R-B2a). */
export function isDomainReversibleSourceType(sourceType: string): sourceType is DomainReversibleSourceType {
  return (DOMAIN_REVERSIBLE_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

/**
 * Mint the `reverse` assertion for a domain command's Phase 2 reversal of a
 * domain entry (PHASE_3_S5_CONTRACT A-06, R-B2a): `purchase.reverse` reverses
 * the purchase's journal entry through `accounting_post_reversal`, on seam 2's
 * handle, in the transaction that wrote the inverse stock movements.
 *
 * `original` is the persisted entry as `AccountingLedgerReader.readEntry` read
 * it in the command's business scope; `entryDate` is the command's bound
 * `reversal_date`, never a clock. What it checks, in order:
 *
 * 1. The original is an entry of a domain-reversible source
 *    (`DOMAIN_REVERSIBLE_SOURCE_TYPES`), else `accounting.assertion_wrong_source`.
 * 2. `entryDate` is a real civil date not before the original's, else
 *    `accounting.entry_date_before_original` (the database checks it again,
 *    with the period and "not in the future").
 * 3. The mirror (`mirrorReversalLines`) and `computeReversalFingerprint` —
 *    exactly the derivation `AccountingEngine.reverse` signs and the database
 *    recomputes from its own rows.
 *
 * Like `mintDomainPostingAssertion`, it does NOT run `validateBranchScope`:
 * the domain authority is the warehouse scope bound in the inventory
 * assertion (L:1024). There is no flag and no trusted parameter; the database
 * admits the reversal of a purchase entry only when the paired
 * `purchase_reversals` row exists in the same transaction (A-15(b)).
 */
export function mintDomainReversalAssertion(minter: AccountingAssertionMinter, original: PostedEntrySnapshot, entryDate: string, actorUserId: string): string {
  const context = { businessId: original.businessId, sourceType: original.sourceType, originalEntryId: original.entryId };
  if (!isDomainReversibleSourceType(original.sourceType)) {
    throw new AccountingError('accounting.assertion_wrong_source', `${original.sourceType} entries are not reversed by a domain command`, context);
  }
  const date = canonicalDate(entryDate);
  if (date < canonicalDate(original.entryDate)) {
    throw new AccountingError('accounting.entry_date_before_original', 'a reversal may not precede the entry it reverses', context);
  }
  const mirrored = mirrorReversalLines(original);
  const postingFingerprint = computeReversalFingerprint(original, date, mirrored);
  return minter.mint({
    actorUserId,
    tenantId: original.tenantId,
    businessId: original.businessId,
    operationKind: 'reverse',
    sourceType: 'reversal',
    sourceId: original.entryId,
    postingFingerprint,
  });
}
