/**
 * The posting engine — the one public mutation surface of this slice (§10).
 *
 * The order of operations is the security property, not an implementation
 * detail. The engine validates the payload's shape, checks the caller's branch
 * authority, computes the canonical fingerprint of the ACTUAL command, and
 * only then mints an assertion over that fingerprint. Because the fingerprint
 * is signed and the database recomputes it from the payload it actually
 * receives, there is no window in which a caller can present a signed
 * fingerprint alongside different lines (§27).
 *
 * The engine deliberately does NOT decide authority. It never reads
 * `app.tenant_id`, never accepts an `actorUserId` from a DTO, and never offers
 * a "trusted" path. The actor and scope arrive already proven from the
 * authenticated membership; this module binds them to a payload (§52, §54).
 */
import { AccountingError } from './errors';
import { computeFingerprint, type CanonicalLineInput } from './fingerprint';
import { isExactConversion } from './fx';
import type { AccountingAssertionMinter, AccountingPostingPort } from './ports';
import { MAX_MONEY_MINOR, type AccountRef, type BranchScope, type PostingCommand, type PostingLineCommand, type PostingResult } from './types';

/**
 * The canonical identity of the account a line names.
 *
 * Derived from the reference itself, never from a UUID or a display name
 * (§23). The database independently re-derives the same identity from the
 * account row it resolves, so a caller who names an account that does not
 * exist, belongs to another business, or has a different system key produces a
 * fingerprint the database will not reproduce — and the post is refused before
 * any write.
 */
export function canonicalAccountIdentity(ref: AccountRef): string {
  if (ref.kind === 'system') {
    if (!/^[a-z0-9_]{1,64}$/.test(ref.systemKey)) {
      throw new AccountingError('accounting.payload_invalid', 'system account key is malformed');
    }
    return ref.systemKey;
  }
  if (ref.code.length === 0 || ref.code.length > 64) {
    throw new AccountingError('accounting.payload_invalid', 'account code is malformed');
  }
  return `code:${ref.code}`;
}

/** The financial fields of a line, in the shape the canonicalizer consumes. */
function toCanonicalLine(line: PostingLineCommand): CanonicalLineInput {
  return {
    accountIdentity: canonicalAccountIdentity(line.account),
    side: line.side,
    baseAmountMinor: line.baseAmountMinor,
    baseCurrency: line.baseCurrency,
    txnAmountMinor: line.txnAmountMinor,
    txnCurrency: line.txnCurrency,
    fxRate: line.fxRate,
    fxRateSource: line.fxRateSource,
    fxRateAt: line.fxRateAt,
    branchId: line.branchId,
    warehouseId: line.warehouseId,
  };
}

/**
 * The canonical fingerprint of a command. Pure: the same command always
 * produces the same digest, in this process and in PostgreSQL.
 */
export function computeCommandFingerprint(command: PostingCommand): string {
  return computeFingerprint(
    {
      tenantId: command.tenantId,
      businessId: command.businessId,
      sourceType: command.sourceType,
      sourceId: command.sourceId,
      entryDate: command.entryDate,
    },
    command.lines.map(toCanonicalLine),
  );
}

/**
 * Structural validation of the command, before any authority is spent.
 *
 * These are the invariants the database also enforces. Checking them here
 * turns a deferred COMMIT-time trigger failure into a typed error naming the
 * offending line, without ever weakening the database's own refusal: `0043`
 * remains authoritative and is what actually protects the ledger (§61).
 */
export function validatePostingCommand(command: PostingCommand): void {
  const fail = (message: string, lineNo?: number): never => {
    throw new AccountingError('accounting.payload_invalid', message, {
      businessId: command.businessId,
      sourceType: command.sourceType,
      sourceId: command.sourceId,
      ...(lineNo === undefined ? {} : { lineNo }),
    });
  };

  if (command.lines.length < 2) fail('a journal entry needs at least two lines');

  let debits = 0n;
  let credits = 0n;
  command.lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (line.side !== 'D' && line.side !== 'C') fail('line side must be D or C', lineNo);
    if (line.baseAmountMinor <= 0n) fail('line base amount must be positive', lineNo);
    if (line.txnAmountMinor <= 0n) fail('line transaction amount must be positive', lineNo);
    if (line.baseAmountMinor > MAX_MONEY_MINOR) fail('line base amount exceeds the money cap', lineNo);
    if (line.txnAmountMinor > MAX_MONEY_MINOR) fail('line transaction amount exceeds the money cap', lineNo);

    // The FX snapshot shape `0042` requires, restated so a bad line is named
    // here rather than surfacing as an opaque CHECK violation.
    const domestic = line.txnCurrency.toUpperCase() === line.baseCurrency.toUpperCase();
    if (domestic) {
      if (line.fxRateSource !== 'base') fail('a domestic line must carry the base rate source', lineNo);
      if (line.txnAmountMinor !== line.baseAmountMinor) fail('a domestic line must have equal transaction and base amounts', lineNo);
    } else if (line.fxRateSource !== 'manual' && line.fxRateSource !== 'provider') {
      fail('a foreign line must name a real rate source', lineNo);
    }

    if (!isExactConversion(line)) fail('line base amount is not the exact conversion of its transaction amount', lineNo);

    if (line.side === 'D') debits += line.baseAmountMinor;
    else credits += line.baseAmountMinor;
  });

  if (debits !== credits) fail('the entry does not balance');
}

/**
 * Branch authority (§52).
 *
 * Under `assigned` scope every line must name a branch the member actually
 * holds: a NULL branch would silently widen an assigned member to
 * business-level accounting, and a foreign branch would post into a branch
 * they were never given. Because the branch ids are part of the canonical
 * line, the decision made here is bound into the signed fingerprint and cannot
 * be changed afterwards.
 */
export function validateBranchScope(command: PostingCommand, scope: BranchScope): void {
  if (scope.mode === 'all') return;
  const allowed = new Set(scope.allowedBranchIds.map((b) => b.toLowerCase()));
  command.lines.forEach((line, i) => {
    const lineNo = i + 1;
    const context = { businessId: command.businessId, sourceType: command.sourceType, sourceId: command.sourceId, lineNo };
    if (line.branchId === null) {
      throw new AccountingError('accounting.branch_scope_violation', 'a branch-scoped member must post every line to an assigned branch', context);
    }
    if (!allowed.has(line.branchId.toLowerCase())) {
      throw new AccountingError('accounting.branch_scope_violation', 'a branch-scoped member may not post to a branch they do not hold', context);
    }
  });
}

/** What the API must have established before a post may be attempted. */
export interface AuthorizedPostingContext {
  /** The authenticated member, from MembershipContext — never from a DTO (§54). */
  readonly actorUserId: string;
  /** The member's resolved branch authority. */
  readonly branchScope: BranchScope;
}

/**
 * The posting engine.
 *
 * `post` is the entire public mutation surface of this slice. `reverse`,
 * `openingBalance`, `trialBalance`, `ledger` and `balance` are deliberately
 * absent: each belongs to a later slice and exposing an empty one now would
 * invite a caller to depend on a shape that has not been designed (§10).
 */
export class AccountingEngine {
  constructor(
    private readonly minter: AccountingAssertionMinter,
    private readonly posting: AccountingPostingPort,
  ) {}

  async post(command: PostingCommand, context: AuthorizedPostingContext): Promise<PostingResult> {
    validatePostingCommand(command);
    validateBranchScope(command, context.branchScope);

    const postingFingerprint = computeCommandFingerprint(command);

    const assertion = this.minter.mint({
      actorUserId: context.actorUserId,
      tenantId: command.tenantId,
      businessId: command.businessId,
      operationKind: 'post',
      sourceType: command.sourceType,
      sourceId: command.sourceId,
      postingFingerprint,
    });

    // The command travels with the assertion. The database recomputes the
    // fingerprint from THIS payload and refuses if it differs from the signed
    // one, so the two can never describe different financial facts.
    return this.posting.postEntry({ assertion, command });
  }
}
