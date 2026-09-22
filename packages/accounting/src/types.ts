/**
 * The posting command domain — the shapes a caller may express, stated once
 * and shared by the engine, the transport adapter and the tests.
 *
 * Two rules govern every type here.
 *
 * Money never becomes a JavaScript `number`. Minor units are `bigint` and
 * rates are canonical decimal strings, because a `number` cannot hold an
 * LBP balance or a ten-digit rate exactly and a single implicit coercion
 * would be unrecoverable once it reached the ledger.
 *
 * An account is never named by display name or UUID. A line references an
 * account by its engine identity — a `system_key`, or a business's own chart
 * `code` — and the database re-derives the canonical identity itself from the
 * resolved row (§29). A caller-supplied canonical identity string is never
 * trusted.
 */

/**
 * The money cap (AL-10): no amount, on either side of a line, may exceed
 * 10^18 minor units. It is the same bound `journal_lines` CHECKs, named once
 * here so the application refuses an over-cap amount by name instead of
 * letting an opaque constraint violation come back from PostgreSQL.
 */
export const MAX_MONEY_MINOR = 10n ** 18n;

/** Which side of the ledger a line falls on. Exactly one per line. */
export type PostingSide = 'D' | 'C';

/** How the FX rate on a line was obtained. `base` means the line is domestic. */
export type FxRateSource = 'base' | 'manual' | 'provider';

/**
 * How a line names its account. A system account is addressed by the stable
 * `system_key` so a country pack may renumber codes without breaking the
 * engine; a business's own account is addressed by its chart `code`, which
 * becomes historical identity once the account has posted history (§31).
 */
export type AccountRef = { readonly kind: 'system'; readonly systemKey: string } | { readonly kind: 'code'; readonly code: string };

/** One line of a posting command, before the database resolves its account. */
export interface PostingLineCommand {
  readonly account: AccountRef;
  readonly side: PostingSide;
  /** Minor units of the business's base currency. Always > 0. */
  readonly baseAmountMinor: bigint;
  readonly baseCurrency: string;
  /** Minor units of the transaction currency. Always > 0. */
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  /** Canonical decimal string with exactly 10 fraction digits, e.g. "1.0000000000". */
  readonly fxRate: string;
  readonly fxRateSource: FxRateSource;
  /** Instant of the rate snapshot. Second precision — see §24. */
  readonly fxRateAt: Date;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
  /** Narrative only. Deliberately outside the fingerprint (§28). */
  readonly memo?: string | null;
}

/**
 * A complete posting command.
 *
 * `description`, `memo` and `requestId` are narrative: changing any of them
 * produces the same financial fingerprint, so a retry that reworded a
 * description still returns the existing entry rather than conflicting (§28,
 * §47). Everything else is financial truth and is signed.
 */
export interface PostingCommand {
  readonly tenantId: string;
  readonly businessId: string;
  readonly sourceType: string;
  readonly sourceId: string;
  /** Civil date in the business's timezone, `YYYY-MM-DD`. */
  readonly entryDate: string;
  readonly lines: readonly PostingLineCommand[];
  readonly description?: string | null;
  readonly requestId?: string | null;
}

/**
 * The account identity the fingerprint is computed over, as re-derived from a
 * persisted account row. `system_key` when the account has one, otherwise
 * `code:<code>` (§23).
 */
export interface ResolvedAccountIdentity {
  readonly accountId: string;
  readonly canonicalIdentity: string;
  readonly isActive: boolean;
}

/** The outcome of a post. `created` distinguishes new truth from an idempotent replay. */
export interface PostingResult {
  readonly entryId: string;
  readonly created: boolean;
}

/** The verified authority a posting runs under. Every field comes from the assertion. */
export interface VerifiedActor {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly operationKind: 'post';
  readonly sourceType: string;
  readonly sourceId: string;
  readonly postingFingerprint: string;
}

/**
 * How a member's branch authority was resolved, before minting (§52). The
 * engine never re-derives this from the client; it is an input the API
 * computes from the authenticated membership.
 */
export type BranchScope = { readonly mode: 'all' } | { readonly mode: 'assigned'; readonly allowedBranchIds: readonly string[] };
