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
import type { AccountingControlAssertionClaims } from './control-assertion';
import type { FxRateEntryCommand, FxRateEntryResult, FxRateSnapshot } from './fx-rate';
import type { AccountingPeriodSnapshot, PeriodCloseCommand, PeriodCommandResult, PeriodCreateCommand, PeriodReopenCommand } from './period';
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
  //
  // There is deliberately NO `readBusinessToday` here.
  //
  // It existed, and `reverse` used it to fill in an omitted date. That made
  // the signed fact a function of when the request arrived: the same retry,
  // sent either side of the business's local midnight, signed two different
  // fingerprints and the second was refused as a conflict on a command the
  // merchant had never changed.
  //
  // Every merchant command now states its own date, so no engine method has a
  // reason to ask what day it is. Removing the seam is what makes that
  // checkable rather than merely true today: a future caller cannot quietly
  // reintroduce a clock-dependent command, because there is nothing on this
  // port to call.
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

// ── P2-S5 FX rate registry (directive §26, §33) ───────────────────────────

/**
 * Mints an accounting CONTROL assertion for already-authorized claims.
 *
 * Separate from `AccountingAssertionMinter` on purpose. The two formats are
 * cryptographically domain-separated, and a single `mint()` that took either
 * claim shape would be one edit away from minting the wrong one — which is
 * precisely the substitution §30 requires to be impossible.
 */
export interface AccountingControlAssertionMinter {
  mintControl(claims: AccountingControlAssertionClaims): string;
}

/** One call of `accounting_fx_rate_enter`, inside one transaction. */
export interface EnterFxRateRequest {
  /** The minted control assertion, presented to the database as-is. */
  readonly assertion: string;
  readonly command: FxRateEntryCommand;
}

/**
 * Executes `accounting_fx_rate_enter`.
 *
 * The adapter's only permitted interaction with `accounting_fx_rates` is
 * CALLING this command and reading rows back. It must never issue
 * INSERT/UPDATE/DELETE against the table — and could not if it tried, because
 * `daftar_app` holds no DML on it.
 */
export interface AccountingFxRatePort {
  enterRate(request: EnterFxRateRequest): Promise<FxRateEntryResult>;
  /**
   * The deterministic read (§21-§23). Present on the port because future
   * domains resolve rates through it; it mutates nothing, so there is no
   * write path hiding behind a read method.
   */
  lookupRate(scope: LedgerReadScope, pair: { from: string; to: string }, at: Date): Promise<FxRateSnapshot>;
}

// ── P2-S6 accounting periods (directive §18-§20, §29-§32) ─────────────────

/** One call of a period command, inside one transaction. */
export interface PeriodCommandRequest<C> {
  /** The minted control assertion, presented to the database as-is. */
  readonly assertion: string;
  readonly command: C;
}

/**
 * Executes the three period commands and reads a business's periods.
 *
 * The adapter's only permitted interaction with `accounting_periods` is
 * CALLING these commands and SELECTing rows back. It must never issue
 * INSERT/UPDATE/DELETE against the table — and could not if it tried, because
 * `daftar_app` holds only SELECT on it and nothing at all on the operation
 * registry.
 *
 * There is no `reopenTrusted`, no `forceClose` and no method that takes a
 * period id without a minted assertion, because a seam that could be handed
 * `true` would become a permanent bypass the moment a later slice found it
 * convenient.
 */
export interface AccountingPeriodPort {
  createPeriod(request: PeriodCommandRequest<PeriodCreateCommand>): Promise<PeriodCommandResult>;
  closePeriod(request: PeriodCommandRequest<PeriodCloseCommand>): Promise<PeriodCommandResult>;
  reopenPeriod(request: PeriodCommandRequest<PeriodReopenCommand>): Promise<PeriodCommandResult>;
  /**
   * The merchant read (§32). Runs as the CALLER, so one business is kept out
   * of another's periods by row level security rather than by this method's
   * predicate. It exposes no assertion, no operation id and no audit internal.
   */
  listPeriods(scope: LedgerReadScope): Promise<readonly AccountingPeriodSnapshot[]>;
}

// ── P3-AL-32: posting inside a caller's transaction ───────────────────────

/**
 * Brand of an open posting transaction. Declared, never exported: no code
 * outside this declaration can write an object literal that carries it, so
 * the only values of `AccountingPostingTransaction` are the ones the database
 * boundary hands out.
 */
declare const accountingPostingTransactionBrand: unique symbol;

/**
 * An OPEN database transaction that carries a posting authority — the
 * `app.accounting_assertion` a minted assertion put there.
 *
 * It is an opaque capability, not a connection. It is issued only by the two
 * boundaries that set the accounting assertion: the accepted Phase 2
 * single-operation boundary and the Phase 3 accounting-aware business seam
 * (P3-AL-32 seam 2). The non-posting business seam (seam 1) never issues one,
 * so a callback inside it has nothing to pass to the methods below.
 *
 * Nothing structural converts a raw client, a query handle or the non-posting
 * seam's handle into this type, and the runtime implementation refuses any
 * value it did not issue itself, or one whose transaction has already ended.
 */
export interface AccountingPostingTransaction {
  readonly [accountingPostingTransactionBrand]: 'accounting-posting-transaction';
}

/**
 * A posting request inside an open posting transaction. It carries NO
 * assertion: the assertion is a property of the transaction (P3-AL-32 seam 2
 * takes it when it opens), and the database verifies this payload against the
 * fingerprint signed into it exactly as it does for `postEntry`.
 */
export interface PostEntryInTransactionRequest {
  readonly command: PostingCommand;
}

/**
 * The client-accepting variants of the posting ports (P3-AL-32 item 5).
 *
 * Separate interfaces rather than extra members of the Phase 2 ports, so the
 * accepted ports — and every implementation of them — keep their exact
 * shape. The single-operation methods are implemented in terms of these.
 */
export interface AccountingPostingTransactionPort {
  postEntryInTransaction(tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest): Promise<PostingResult>;
}

export type PostAdjustmentInTransactionRequest = Omit<PostAdjustmentRequest, 'assertion'>;
export type PostReversalInTransactionRequest = Omit<PostReversalRequest, 'assertion'>;
export type PostOpeningBalanceInTransactionRequest = Omit<PostOpeningBalanceRequest, 'assertion'>;

export interface AccountingSourcesTransactionPort {
  postAdjustmentInTransaction(tx: AccountingPostingTransaction, request: PostAdjustmentInTransactionRequest): Promise<PostingResult>;
  postReversalInTransaction(tx: AccountingPostingTransaction, request: PostReversalInTransactionRequest): Promise<PostingResult>;
  postOpeningBalanceInTransaction(tx: AccountingPostingTransaction, request: PostOpeningBalanceInTransactionRequest): Promise<PostingResult>;
}
