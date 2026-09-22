/**
 * The ports the posting engine needs to execute a post.
 *
 * §11 draws the line: this package owns the posting contract, the money and FX
 * arithmetic, the canonical fingerprint and the typed errors. It owns no
 * transport, no Nest wiring, no configuration and no environment. Everything
 * it cannot do itself is expressed here as an interface that `apps/api`
 * implements — which is what keeps the engine framework-agnostic and lets a
 * future domain slice reuse it without importing a web framework.
 *
 * Note what is NOT a port. There is no "authorization port" and no
 * `skipAuthorization` switch: authority arrives as a minted assertion or the
 * post does not happen (§53). A seam that could be handed `true` would become
 * a permanent bypass the moment a later slice found it convenient.
 */
import type { AccountingAssertionClaims } from './assertion';
import type { OpeningPosition, PostedEntrySnapshot } from './sources';
import type { PostingCommand, PostingResult } from './types';

/**
 * Mints an accounting assertion for already-authorized claims.
 *
 * The implementation holds the signing key. It is deliberately a port rather
 * than a direct dependency so the engine never touches key material and the
 * platform and worker processes, which must not hold the key at all (§19),
 * cannot accidentally acquire minting ability by importing this package.
 */
export interface AccountingAssertionMinter {
  mint(claims: AccountingAssertionClaims): string;
}

/** One call of the database posting primitive, inside one transaction. */
export interface PostEntryRequest {
  /** The minted assertion, presented to the database as-is. */
  readonly assertion: string;
  /** The ACTUAL payload. The database recomputes its fingerprint from this (§27). */
  readonly command: PostingCommand;
}

/**
 * Executes `accounting_post_entry`.
 *
 * The adapter's only permitted journal interaction is CALLING this primitive.
 * It must never issue INSERT/UPDATE/DELETE against `journal_entries`,
 * `journal_lines` or `accounting_source_bindings` — guard G-4 fails CI if it
 * ever does (§67).
 */
export interface AccountingPostingPort {
  postEntry(request: PostEntryRequest): Promise<PostingResult>;
}

/** Injectable clock, so date-boundary behaviour is testable without waiting. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

// ── P2-S4 source workflows (directive §10-§34) ────────────────────────────

/**
 * Reads the ledger's own persisted truth.
 *
 * A reversal is derived from the entry it reverses and an opening balance is
 * denominated in the business's base currency; both are facts the engine must
 * READ before it can derive anything, and neither may come from the caller.
 * The port is read-only by construction: there is no method here that could
 * write, so no future edit can quietly turn the reader into a second writer.
 */
export interface AccountingLedgerReader {
  /** A posted entry and every line of it, by COMPOSITE identity. */
  readEntry(scope: LedgerReadScope, entryId: string): Promise<PostedEntrySnapshot | null>;
  /** The business's base currency, or null when the business does not exist. */
  readBusinessBaseCurrency(scope: LedgerReadScope): Promise<string | null>;
  /**
   * Today's civil date in the BUSINESS's own timezone, `YYYY-MM-DD`.
   *
   * Resolved by the database, which is also the authority that enforces the
   * date rules, so there is exactly one answer to "what day is it here" and
   * no second timezone implementation to drift from it. A caller that omits a
   * date gets this one written into the command explicitly, because the
   * fingerprint has to cover a concrete date and "whatever the server thinks
   * later" is not one.
   */
  readBusinessToday(scope: LedgerReadScope): Promise<string | null>;
}

/**
 * The isolation scope a ledger read runs under. Both halves are required: the
 * ledger's row level security is keyed on the pair, and a read that carried
 * only a business id would be a read whose isolation depended on whatever the
 * connection happened to have set last.
 */
export interface LedgerReadScope {
  readonly tenantId: string;
  readonly businessId: string;
}

/** One call of `accounting_post_manual_adjustment`, inside one transaction. */
export interface PostAdjustmentRequest {
  readonly assertion: string;
  readonly command: PostingCommand;
  readonly reason: string;
}

export interface AccountingAdjustmentPort {
  postAdjustment(request: PostAdjustmentRequest): Promise<PostingResult>;
}

/**
 * One call of `accounting_post_reversal`, inside one transaction.
 *
 * Note what this request does NOT carry: no account, no amount, no currency,
 * no rate, no dimension and no line. The mirror is derived from persistence on
 * both sides of the boundary and compared through the signed fingerprint;
 * there is no parameter through which a caller could state a different one.
 */
export interface PostReversalRequest {
  readonly assertion: string;
  readonly businessId: string;
  readonly originalEntryId: string;
  readonly entryDate: string;
  readonly reason: string;
  readonly requestId?: string | null;
}

export interface AccountingReversalPort {
  postReversal(request: PostReversalRequest): Promise<PostingResult>;
}

/**
 * One opening-balance workflow: open the draft with its positions and post
 * it, in ONE database transaction. The draft is real — it exists as rows, it
 * passes through `draft` on its way to `posted`, and a failure anywhere
 * leaves nothing behind — but it is not a separate HTTP round trip, because
 * §35 fixes the merchant surface at three endpoints.
 */
export interface PostOpeningBalanceRequest {
  readonly assertion: string;
  readonly businessId: string;
  readonly openingBalanceId: string;
  readonly asOfDate: string;
  readonly positions: readonly OpeningPosition[];
  readonly description?: string | null;
  readonly requestId?: string | null;
}

export interface AccountingOpeningBalancePort {
  postOpeningBalance(request: PostOpeningBalanceRequest): Promise<PostingResult>;
}
