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
import type {
  AccountingAdjustmentPort,
  AccountingAssertionMinter,
  AccountingLedgerReader,
  AccountingOpeningBalancePort,
  AccountingPostingPort,
  AccountingReversalPort,
} from './ports';
import { computeOpeningBalanceFingerprint, computeReversalFingerprint, deriveOpeningBalanceLines, mirrorReversalLines, type OpeningPosition } from './sources';
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
 * `post` is the primitive every source rides. `adjust`, `reverse` and
 * `openingBalance` are the three Phase-2-native sources of P2-S4, and each of
 * them is a thin derivation in front of that primitive rather than a second
 * way to write the ledger. `trialBalance`, `ledger` and `balance` are still
 * deliberately absent: each belongs to a later slice and exposing an empty
 * one now would invite a caller to depend on a shape that has not been
 * designed (§10).
 *
 * There is no `postTrusted`, no `skipPermission`, no `systemPost` and no
 * `rawWrite` on this class, and there is no flag that would produce one. The
 * authority for every method is a freshly minted assertion over the payload
 * that method derived, and a caller that could bypass that would be a caller
 * the ledger cannot audit.
 */
/**
 * The source types Phase 2 owns natively. Each has a command of its own on
 * `AccountingEngine`, and none of them may be posted through `post`.
 */
export const NATIVE_SOURCE_TYPES = ['manual_adjustment', 'reversal', 'opening_balance'] as const;

export class AccountingEngine {
  constructor(
    private readonly minter: AccountingAssertionMinter,
    private readonly posting: AccountingPostingPort,
    private readonly adjustments: AccountingAdjustmentPort,
    private readonly reversals: AccountingReversalPort,
    private readonly openingBalances: AccountingOpeningBalancePort,
    private readonly reader: AccountingLedgerReader,
  ) {}

  async post(command: PostingCommand, context: AuthorizedPostingContext): Promise<PostingResult> {
    // `post` is the entry point for a source this slice does not own: a sale,
    // an invoice, a payment, whatever a later phase brings. The three sources
    // Phase 2 owns each have their own method on this class, because each
    // carries something the generic path has no way to supply -- a mandatory
    // reason, an original entry to mirror, a persisted draft. Reaching them
    // through here would produce a journal entry with none of it.
    //
    // The database refuses that too, and does so unconditionally: the
    // completeness triggers in 0046 and 0047 fail the COMMIT when a native
    // source's entry has no detail row, whichever process wrote it. This
    // check does not replace that one and could not -- TypeScript is not a
    // constraint -- it just turns a COMMIT-time trigger failure into a typed
    // refusal naming the method the caller wanted, at the moment they called
    // the wrong one.
    if ((NATIVE_SOURCE_TYPES as readonly string[]).includes(command.sourceType)) {
      throw new AccountingError(
        'accounting.assertion_wrong_source',
        `${command.sourceType} entries are posted through their own command, not the generic posting entry point`,
        {
          businessId: command.businessId,
          sourceType: command.sourceType,
          sourceId: command.sourceId,
        },
      );
    }
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

  /**
   * A merchant-authored correction (§10, §40).
   *
   * Financially this is an ordinary posting: the merchant states the lines
   * and every rule that governs new truth governs them. The only things this
   * method adds are the mandatory reason and the source identity, and the
   * only thing it refuses that `post` would not is a missing reason — a
   * correction nobody explained is a correction nobody can review.
   */
  async adjust(command: PostingCommand, reason: string, context: AuthorizedPostingContext): Promise<PostingResult> {
    if (command.sourceType !== 'manual_adjustment') {
      throw new AccountingError('accounting.assertion_wrong_source', 'an adjustment is posted under the manual_adjustment source type', {
        businessId: command.businessId,
        sourceType: command.sourceType,
      });
    }
    if (reason.trim().length === 0) {
      throw new AccountingError('accounting.adjustment_reason_required', 'a manual adjustment must state a reason', {
        businessId: command.businessId,
        sourceId: command.sourceId,
      });
    }
    validatePostingCommand(command);
    validateBranchScope(command, context.branchScope);

    const postingFingerprint = computeCommandFingerprint(command);
    const assertion = this.minter.mint({
      actorUserId: context.actorUserId,
      tenantId: command.tenantId,
      businessId: command.businessId,
      operationKind: 'post',
      sourceType: 'manual_adjustment',
      sourceId: command.sourceId,
      postingFingerprint,
    });

    return this.adjustments.postAdjustment({ assertion, command, reason: reason.trim() });
  }

  /**
   * The undo of an earlier entry (§12-§21).
   *
   * The caller states WHICH entry, WHEN and WHY, and nothing else. This
   * method reads the persisted original, derives its mirror, checks the
   * member's branch authority against the lines the mirror actually has, and
   * signs the digest of that derivation. The database derives its own mirror
   * from its own rows and refuses any difference, so the two derivations must
   * agree for a reversal to exist at all.
   *
   * The source identity is the ORIGINAL ENTRY's id. A second reversal of one
   * entry is therefore not refused by a check here — it is impossible.
   */
  async reverse(
    input: {
      readonly tenantId: string;
      readonly businessId: string;
      readonly originalEntryId: string;
      /** REQUIRED. The caller's stated civil date; never derived here. */
      readonly entryDate: string;
      readonly reason: string;
      readonly requestId?: string | null;
    },
    context: AuthorizedPostingContext,
  ): Promise<PostingResult> {
    if (input.reason.trim().length === 0) {
      throw new AccountingError('accounting.reversal_reason_required', 'a reversal must state a reason', {
        businessId: input.businessId,
        originalEntryId: input.originalEntryId,
      });
    }

    const scope = { tenantId: input.tenantId, businessId: input.businessId };
    // The date arrives concrete and is used as given. There is no clock read
    // on this path -- not this process's, not the database's -- and the port
    // no longer offers one, so a reversal command CANNOT depend on when it
    // was sent. That is a structural property, not a convention: the seam a
    // future caller would reach for does not exist.
    const entryDate = input.entryDate;

    const original = await this.reader.readEntry(scope, input.originalEntryId);
    // Composite identity: an entry of another business is simply not found,
    // which is also the only thing the caller learns (§20).
    if (original === null || original.tenantId !== input.tenantId) {
      throw new AccountingError('accounting.entry_not_found', 'no journal entry of this business has that id', {
        businessId: input.businessId,
        originalEntryId: input.originalEntryId,
      });
    }
    if (entryDate < original.entryDate) {
      throw new AccountingError('accounting.entry_date_before_original', 'a reversal may not precede the entry it reverses', {
        businessId: input.businessId,
        originalEntryId: input.originalEntryId,
      });
    }

    const mirrored = mirrorReversalLines(original);
    // The branch authority is checked against the mirror's OWN lines, so a
    // member holding only some branches cannot reverse a business-level entry
    // whose lines carry no branch at all (§18).
    validateBranchScope(
      {
        tenantId: input.tenantId,
        businessId: input.businessId,
        sourceType: 'reversal',
        sourceId: input.originalEntryId,
        entryDate,
        lines: mirrored,
      },
      context.branchScope,
    );

    const postingFingerprint = computeReversalFingerprint(original, entryDate, mirrored);
    const assertion = this.minter.mint({
      actorUserId: context.actorUserId,
      tenantId: input.tenantId,
      businessId: input.businessId,
      // A different authority from a posting, because a different routine
      // writes it under different rules (§19).
      operationKind: 'reverse',
      sourceType: 'reversal',
      sourceId: input.originalEntryId,
      postingFingerprint,
    });

    return this.reversals.postReversal({
      assertion,
      businessId: input.businessId,
      originalEntryId: input.originalEntryId,
      entryDate,
      reason: input.reason.trim(),
      requestId: input.requestId ?? null,
    });
  }

  /**
   * The opening position (§22-§34).
   *
   * The merchant states positions; the engine derives the equity plug and
   * therefore the journal. The base currency is READ from the business, never
   * taken from the request, so a caller cannot denominate an opening balance
   * in a currency the ledger does not use.
   */
  async openingBalance(
    input: {
      readonly tenantId: string;
      readonly businessId: string;
      readonly openingBalanceId: string;
      readonly asOfDate: string;
      readonly positions: readonly OpeningPosition[];
      readonly description?: string | null;
      readonly requestId?: string | null;
    },
    context: AuthorizedPostingContext,
  ): Promise<PostingResult> {
    // §31: an opening balance is stated at business level, with no branch
    // dimension on any line. A member who holds only some branches therefore
    // cannot state one — and this is the reason, written once, rather than a
    // silent consequence of a branch check further down.
    if (context.branchScope.mode !== 'all') {
      throw new AccountingError('accounting.branch_scope_violation', 'an opening balance is stated at business level and needs business-wide authority', {
        businessId: input.businessId,
        sourceId: input.openingBalanceId,
      });
    }

    const baseCurrency = await this.reader.readBusinessBaseCurrency({ tenantId: input.tenantId, businessId: input.businessId });
    if (baseCurrency === null) {
      throw new AccountingError('accounting.forbidden', 'the business does not exist', { businessId: input.businessId });
    }

    const lines = deriveOpeningBalanceLines(input.positions, baseCurrency, input.asOfDate);
    const command: PostingCommand = {
      tenantId: input.tenantId,
      businessId: input.businessId,
      sourceType: 'opening_balance',
      sourceId: input.openingBalanceId,
      entryDate: input.asOfDate,
      lines,
    };
    validatePostingCommand(command);

    const postingFingerprint = computeOpeningBalanceFingerprint(
      { tenantId: input.tenantId, businessId: input.businessId, openingBalanceId: input.openingBalanceId, asOfDate: input.asOfDate },
      lines,
    );
    const assertion = this.minter.mint({
      actorUserId: context.actorUserId,
      tenantId: input.tenantId,
      businessId: input.businessId,
      operationKind: 'post',
      sourceType: 'opening_balance',
      sourceId: input.openingBalanceId,
      postingFingerprint,
    });

    return this.openingBalances.postOpeningBalance({
      assertion,
      businessId: input.businessId,
      openingBalanceId: input.openingBalanceId,
      asOfDate: input.asOfDate,
      positions: input.positions,
      description: input.description ?? null,
      requestId: input.requestId ?? null,
    });
  }
}
