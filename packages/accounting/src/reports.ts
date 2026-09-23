/**
 * THE READ SIDE OF FINANCIAL TRUTH (P2-S7).
 *
 * Every number this module produces is DERIVED, at the moment it is asked
 * for, from `journal_entries` and `journal_lines`. There is no stored
 * balance, no cache, no materialized view and no second source — AL-15 fixes
 * that for Phase 2, and the reason is worth stating once: a balance DAFTAR
 * stores is a number something has to keep right, and the day it drifts the
 * ledger and the stored number disagree with nothing to say which lied. A
 * report that is slow can be measured and indexed. A report that is wrong
 * has already been believed.
 *
 * What lives here and what does not:
 *
 *   — HERE: the normal-balance rule, the presentation arithmetic, the
 *     opening/running/closing walk, the whole-business balance assertion,
 *     the cursor codec and the query shapes. All pure, all `bigint`.
 *   — NOT here: SQL, connections, transports, configuration and clocks. The
 *     aggregation SUMs run in PostgreSQL through `AccountingReportReader`
 *     (NUMERIC, so a cumulative history larger than BIGINT still adds up),
 *     and arrive as exact decimal STRINGS which this module parses to
 *     `bigint`. `Number` appears nowhere in this file for an amount.
 *
 * One more absence is deliberate. `AccountingEngine` — the posting engine in
 * `post.ts` — gains nothing from this slice. Reads are a separate object with
 * a separate port, so the engine's surface stays exactly the four write
 * workflows it was reviewed with, and a read can never become a write by
 * being one method away from one.
 */
import { AccountingError } from './errors';
import type { AccountRef, FxRateSource, PostingSide } from './types';

/** The five account types. The chart's `type` column CHECKs exactly these. */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export const ACCOUNT_TYPES: readonly AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

/**
 * The normal direction of an account type, stated ONCE (§42).
 *
 * Three reports and one controller need this rule. Written out in each of
 * them it would be four copies of an accounting convention, and the day one
 * copy is edited the trial balance and the ledger would disagree about the
 * sign of the same account. So it is a function, it is exported, and the gate
 * fails if a report re-implements it.
 */
export function normalBalanceOf(type: AccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/**
 * The signed presentation amount for an account, in its normal direction.
 *
 * `debit - credit` for a debit-normal account, `credit - debit` for a
 * credit-normal one. The result is EXACT and may legitimately be NEGATIVE: a
 * contra account, an overdrawn bank, a refund-heavy revenue account. Never
 * clamped — a clamp is a report deciding that the merchant's books cannot
 * say what they say.
 */
export function presentationNet(type: AccountType, debitMinor: bigint, creditMinor: bigint): bigint {
  return normalBalanceOf(type) === 'debit' ? debitMinor - creditMinor : creditMinor - debitMinor;
}

/**
 * Parse an exact integer decimal string into `bigint`.
 *
 * PostgreSQL hands `SUM(bigint)` back as NUMERIC, and `node-postgres` gives
 * NUMERIC to JavaScript as a STRING precisely because a double cannot hold
 * it. This is the one place that string becomes a number, and it becomes a
 * `bigint`. A value with a fraction is a bug in the query, not a rounding
 * opportunity, so it raises.
 */
export function exactMinor(value: string, what = 'amount'): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new AccountingError('accounting.report_amount_invalid', `a financial ${what} must be an exact integer of minor units`);
  }
  return BigInt(value);
}

// ── Query shapes ──────────────────────────────────────────────────────────

/** Tenant + business. Both halves, because RLS is keyed on the pair. */
export interface ReportScope {
  readonly tenantId: string;
  readonly businessId: string;
}

/**
 * How far a caller's authority reaches, resolved by the application BEFORE a
 * query is built. The reader never sees a branch id a membership did not
 * approve.
 *
 * `all` — business-wide authority. `branchId` is an optional DIMENSIONAL
 * filter the caller asked for.
 *
 * `assigned` — the member sees only the branches in `branchIds`. A
 * business-wide financial total is not theirs to have, and neither are the
 * business-level (`branch_id IS NULL`) rows an opening balance writes: those
 * ARE the whole-business opening position (§37).
 */
export type ReportBranchScope =
  | { readonly mode: 'all'; readonly branchId?: string | null }
  | { readonly mode: 'assigned'; readonly branchIds: readonly string[] };

/** True when the result covers the whole business rather than one dimension. */
export function isWholeBusinessScope(scope: ReportBranchScope): boolean {
  return scope.mode === 'all' && (scope.branchId === undefined || scope.branchId === null);
}

/**
 * Trial balance period selection (§22).
 *
 * The two modes are MUTUALLY EXCLUSIVE and there is no default. `asOf` is
 * cumulative from the beginning of the books to an inclusive date; `from`/`to`
 * is the movement inside an inclusive range. A request that named both would
 * have to be resolved by a convention, and a convention is the report
 * choosing which question the merchant asked.
 */
export type TrialBalanceRange = { readonly kind: 'asOf'; readonly asOf: string } | { readonly kind: 'range'; readonly from: string; readonly to: string };

export interface TrialBalanceQuery {
  readonly range: TrialBalanceRange;
  readonly branch: ReportBranchScope;
  /** Include accounts with no movement in the selected window. Default false. */
  readonly includeZeroActivity?: boolean;
}

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly isActive: boolean;
  readonly totalDebitMinor: bigint;
  readonly totalCreditMinor: bigint;
  /** Signed, in the account's normal direction. May be negative. */
  readonly netMinor: bigint;
  readonly baseCurrency: string;
}

export interface TrialBalanceReport {
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebitMinor: bigint;
  readonly totalCreditMinor: bigint;
  readonly baseCurrency: string;
  /**
   * Whether the result balances.
   *
   * For a WHOLE-BUSINESS report this is always `true`, because a `false` one
   * never returns at all — it raises `accounting.report_unbalanced` (§23). For
   * a branch-DIMENSIONAL view it is genuine information: an entry may carry
   * different branches on different lines, so a dimensional slice of a
   * perfectly sound ledger need not balance, and saying so is the honest
   * answer. Manufacturing balance by discarding mixed entries would be the
   * dishonest one (§24).
   */
  readonly isBalanced: boolean;
  /** `whole_business` is a legal trial balance. `branch_dimension` is a view. */
  readonly kind: 'whole_business' | 'branch_dimension';
}

/** One account, as the chart read returns it. No balance: a balance needs an as-of. */
export interface AccountSummary {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly systemKey: string | null;
  readonly isActive: boolean;
}

export interface AccountListQuery {
  readonly type?: AccountType | null;
  /**
   * Include accounts whose `is_active` is false. DEFAULT TRUE, and that is
   * not a convenience: `is_active` governs FUTURE POSTING ELIGIBILITY, never
   * history (§33). A chart read that hid them would be a chart that forgets
   * the accounts a merchant's own history is written in.
   */
  readonly includeInactive?: boolean;
}

/** One entry, as the list returns it. No invented total: amounts live on lines. */
export interface EntrySummary {
  readonly entryId: string;
  readonly entryDate: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly lineCount: number;
}

export interface EntryListQuery {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly sourceType?: string | null;
  readonly branch: ReportBranchScope;
  readonly limit: number;
  readonly cursor?: EntryCursor | null;
}

/** One line of an entry detail, as the journal froze it. */
export interface EntryDetailLine {
  readonly lineNo: number;
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly account: AccountRef;
  readonly side: PostingSide;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly baseAmountMinor: bigint;
  readonly baseCurrency: string;
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  /** The rate AS POSTED. Never looked up again (§30, §52). */
  readonly fxRate: string;
  readonly fxRateSource: FxRateSource;
  readonly fxRateAt: Date;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
  readonly memo: string | null;
}

export interface EntryDetail {
  readonly entryId: string;
  readonly entryDate: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly description: string | null;
  readonly actorKind: 'user' | 'system';
  readonly actorUserId: string | null;
  readonly actorSystemKey: string | null;
  readonly createdAt: Date;
  readonly lines: readonly EntryDetailLine[];
}

/** One ledger row: a posted line, with the balance after it. */
export interface LedgerRow {
  readonly entryId: string;
  readonly entryDate: string;
  readonly lineNo: number;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly description: string | null;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly baseAmountMinor: bigint;
  readonly baseCurrency: string;
  readonly txnAmountMinor: bigint;
  readonly txnCurrency: string;
  readonly fxRate: string;
  readonly fxRateSource: FxRateSource;
  readonly fxRateAt: Date;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
  readonly memo: string | null;
  /** Signed, in the account's normal direction, after this row. */
  readonly runningMinor: bigint;
}

export interface LedgerQuery {
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
  readonly branch: ReportBranchScope;
  readonly limit: number;
  readonly cursor?: LedgerCursor | null;
}

export interface LedgerReport {
  readonly account: AccountSummary;
  readonly from: string;
  readonly to: string;
  readonly baseCurrency: string;
  /** Everything posted STRICTLY BEFORE `from`, signed in the normal direction. */
  readonly openingMinor: bigint;
  readonly rows: readonly LedgerRow[];
  /** The running balance after the last row of THIS page. */
  readonly closingMinor: bigint;
  readonly nextCursor: string | null;
}

export interface AccountBalanceRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly isActive: boolean;
  readonly balanceMinor: bigint;
  readonly currency: string;
  readonly asOf: string;
}

export interface BalancesQuery {
  /** Inclusive: every line with `entry_date <= asOf` (§31). */
  readonly asOf: string;
  readonly accountIds?: readonly string[] | null;
  readonly branch: ReportBranchScope;
  readonly includeZeroActivity?: boolean;
}

// ── Cursors (§28, §50) ────────────────────────────────────────────────────
//
// A keyset cursor, never OFFSET. OFFSET counts rows the database has to walk
// again on every page, and — worse for a ledger — it is defined against a
// result set that concurrent posting changes underneath it, so a row can
// repeat on one page and vanish from the next.
//
// The cursor therefore carries the COMPLETE ordering tuple, so the next-page
// predicate is lexicographically identical to the ORDER BY. A partial cursor
// (a date alone) cannot resume inside a date that holds more rows than one
// page, which is exactly the case a month-end produces.

export const LEDGER_CURSOR_VERSION = 'glc/1';
export const ENTRY_CURSOR_VERSION = 'gec/1';

export interface LedgerCursor {
  readonly entryDate: string;
  readonly entryId: string;
  readonly lineNo: number;
}

export interface EntryCursor {
  readonly entryDate: string;
  readonly entryId: string;
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A cursor is opaque to the client and strictly parsed by the server. */
export function encodeLedgerCursor(c: LedgerCursor): string {
  return `${LEDGER_CURSOR_VERSION}.${Buffer.from(`${c.entryDate}|${c.entryId}|${c.lineNo}`, 'utf8').toString('base64url')}`;
}

export function decodeLedgerCursor(raw: string): LedgerCursor {
  const parts = splitCursor(raw, LEDGER_CURSOR_VERSION);
  if (parts.length !== 3) throw cursorRefusal();
  const [entryDate = '', entryId = '', lineNoText = ''] = parts;
  if (!CIVIL_DATE.test(entryDate) || !UUID.test(entryId) || !/^[1-9]\d{0,8}$/.test(lineNoText)) throw cursorRefusal();
  return { entryDate, entryId, lineNo: Number(lineNoText) };
}

export function encodeEntryCursor(c: EntryCursor): string {
  return `${ENTRY_CURSOR_VERSION}.${Buffer.from(`${c.entryDate}|${c.entryId}`, 'utf8').toString('base64url')}`;
}

export function decodeEntryCursor(raw: string): EntryCursor {
  const parts = splitCursor(raw, ENTRY_CURSOR_VERSION);
  if (parts.length !== 2) throw cursorRefusal();
  const [entryDate = '', entryId = ''] = parts;
  if (!CIVIL_DATE.test(entryDate) || !UUID.test(entryId)) throw cursorRefusal();
  return { entryDate, entryId };
}

/**
 * Bounded, versioned, strict.
 *
 * The length bound comes first: a megabyte of base64 is not a cursor, and
 * decoding it to find out would be the caller choosing how much work the
 * server does. The version prefix comes next, so a cursor from a future
 * shape is refused rather than misread as this one.
 */
function splitCursor(raw: string, version: string): string[] {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) throw cursorRefusal();
  const prefix = `${version}.`;
  if (!raw.startsWith(prefix)) throw cursorRefusal();
  const payload = raw.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw cursorRefusal();
  let decoded: string;
  try {
    decoded = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    throw cursorRefusal();
  }
  if (decoded.length > 256) throw cursorRefusal();
  return decoded.split('|');
}

const cursorRefusal = (): AccountingError => new AccountingError('accounting.report_cursor_invalid', 'the pagination cursor is not one this server issued');

// ── The read port ─────────────────────────────────────────────────────────

/**
 * The SELECT surface the reports run on.
 *
 * Read-only by construction: there is no method here that could write, so no
 * future edit can quietly turn a report into a second writer. Every
 * implementation runs as the CALLER under row level security — a report has
 * no reason to be elevated (§40), and an elevated read is one refactor away
 * from reading another business's books.
 */
export interface AccountingReportReader {
  /** The business's base currency, or null when the business does not exist. */
  baseCurrency(scope: ReportScope): Promise<string | null>;
  listAccounts(scope: ReportScope, query: AccountListQuery): Promise<readonly AccountSummary[]>;
  findAccount(scope: ReportScope, accountId: string): Promise<AccountSummary | null>;
  /** Per-account debit and credit totals for the window, as exact decimal strings. */
  trialBalanceTotals(scope: ReportScope, query: TrialBalanceQuery): Promise<readonly RawAccountTotals[]>;
  /** Totals at or before `asOf`, for the named accounts or for all of them. */
  balanceTotals(scope: ReportScope, query: BalancesQuery): Promise<readonly RawAccountTotals[]>;
  /** Everything STRICTLY BEFORE `from`, for one account. */
  ledgerOpening(scope: ReportScope, query: LedgerQuery): Promise<RawTotals>;
  /** One page, ordered (entry_date, journal_entry_id, line_no), `limit + 1` rows. */
  ledgerPage(scope: ReportScope, query: LedgerQuery): Promise<readonly RawLedgerRow[]>;
  listEntries(scope: ReportScope, query: EntryListQuery): Promise<readonly EntrySummary[]>;
  readEntryDetail(scope: ReportScope, entryId: string): Promise<EntryDetail | null>;
  /** Every distinct branch dimension an entry's lines carry, `null` included. */
  entryBranchDimensions(scope: ReportScope, entryId: string): Promise<readonly (string | null)[]>;
}

/** Aggregates as PostgreSQL returns them: exact decimal strings, never numbers. */
export interface RawTotals {
  readonly debit: string;
  readonly credit: string;
}

export interface RawAccountTotals extends RawTotals {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly isActive: boolean;
}

export interface RawLedgerRow {
  readonly entryId: string;
  readonly entryDate: string;
  readonly lineNo: number;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly description: string | null;
  readonly debit: string;
  readonly credit: string;
  readonly baseAmountMinor: string;
  readonly baseCurrency: string;
  readonly txnAmountMinor: string;
  readonly txnCurrency: string;
  readonly fxRate: string;
  readonly fxRateSource: FxRateSource;
  readonly fxRateAt: Date;
  readonly branchId: string | null;
  readonly warehouseId: string | null;
  readonly memo: string | null;
}

// ── The reports ───────────────────────────────────────────────────────────

/** The largest page any read will serve, whatever a caller asks for (§53). */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * The financial read surface.
 *
 * Deliberately a class of its OWN rather than methods on `AccountingEngine`:
 * the engine is the write side and its surface is asserted exactly, so a read
 * added there would be a read sitting one character away from a posting
 * method. Nothing here mutates, and nothing here can.
 */
export class AccountingReports {
  constructor(private readonly reader: AccountingReportReader) {}

  async accounts(scope: ReportScope, query: AccountListQuery = {}): Promise<readonly AccountSummary[]> {
    return this.reader.listAccounts(scope, { ...query, includeInactive: query.includeInactive ?? true });
  }

  async entries(scope: ReportScope, query: EntryListQuery): Promise<{ items: readonly EntrySummary[]; nextCursor: string | null }> {
    const limit = boundPage(query.limit);
    const page = await this.reader.listEntries(scope, { ...query, limit: limit + 1 });
    const items = page.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = page.length > limit && last !== undefined ? encodeEntryCursor({ entryDate: last.entryDate, entryId: last.entryId }) : null;
    return { items, nextCursor };
  }

  async entry(scope: ReportScope, entryId: string): Promise<EntryDetail | null> {
    return this.reader.readEntryDetail(scope, entryId);
  }

  /**
   * The trial balance (§22, §23, §24).
   *
   * The whole-business assertion is the part that matters. `SUM(debit)` must
   * equal `SUM(credit)` EXACTLY — no tolerance, no float, no rounding — and
   * when it does not, this refuses rather than returning numbers. An
   * unbalanced whole-business trial balance is an incident: every entry was
   * validated at COMMIT by a deferred constraint trigger, so if the totals
   * disagree something has happened that the ledger's own invariants say
   * cannot. Showing plausible numbers at that moment is the single worst
   * thing a financial report can do.
   *
   * The refusal carries NO amounts — not the debit total, not the credit
   * total, not the difference. An error reaches logs and generic handlers
   * where redaction can no longer be applied (§56).
   */
  async trialBalance(scope: ReportScope, query: TrialBalanceQuery): Promise<TrialBalanceReport> {
    const baseCurrency = await this.requireBaseCurrency(scope);
    const raw = await this.reader.trialBalanceTotals(scope, query);

    let totalDebit = 0n;
    let totalCredit = 0n;
    const rows: TrialBalanceRow[] = [];
    for (const r of raw) {
      const debit = exactMinor(r.debit, 'debit total');
      const credit = exactMinor(r.credit, 'credit total');
      totalDebit += debit;
      totalCredit += credit;
      if (debit === 0n && credit === 0n && query.includeZeroActivity !== true) continue;
      rows.push({
        accountId: r.accountId,
        code: r.code,
        name: r.name,
        type: r.type,
        isActive: r.isActive,
        totalDebitMinor: debit,
        totalCreditMinor: credit,
        netMinor: presentationNet(r.type, debit, credit),
        baseCurrency,
      });
    }

    const whole = isWholeBusinessScope(query.branch);
    const isBalanced = totalDebit === totalCredit;
    if (whole && !isBalanced) {
      throw new AccountingError('accounting.report_unbalanced', 'the business-wide trial balance does not balance and will not be rendered', {
        businessId: scope.businessId,
      });
    }

    return {
      rows,
      totalDebitMinor: totalDebit,
      totalCreditMinor: totalCredit,
      baseCurrency,
      isBalanced,
      kind: whole ? 'whole_business' : 'branch_dimension',
    };
  }

  /**
   * The general ledger for one account over an inclusive range (§26-§29).
   *
   * The boundary is the thing to get right and the thing to keep tested: the
   * OPENING balance is everything posted STRICTLY BEFORE `from` — `<`, never
   * `<=` — and the rows are `from <= entry_date <= to`. Off by one there and
   * the first day of every range is counted twice, once in the opening figure
   * and once as a row.
   *
   * The running balance is computed here, in `bigint`, and persisted nowhere.
   */
  async ledger(scope: ReportScope, query: LedgerQuery): Promise<LedgerReport> {
    if (query.from > query.to) {
      throw new AccountingError('accounting.report_range_invalid', 'a ledger range ends on or after it starts');
    }
    const baseCurrency = await this.requireBaseCurrency(scope);
    const account = await this.reader.findAccount(scope, query.accountId);
    if (account === null) {
      // Another business's account is NOT FOUND, exactly as one that never
      // existed is. A distinguishable answer would confirm its existence to
      // a caller who may not know the business exists (§32).
      throw new AccountingError('accounting.account_not_found', 'no such account in this business', { businessId: scope.businessId });
    }

    const limit = boundPage(query.limit);
    const opening = await this.reader.ledgerOpening(scope, query);
    const page = await this.reader.ledgerPage(scope, { ...query, limit: limit + 1 });

    // A page resumed from a cursor continues a walk, so its opening figure is
    // the balance at the cursor: everything before `from` plus everything in
    // range up to and including the cursor row. `ledgerOpening` is given the
    // cursor and answers accordingly, so this arithmetic stays one line.
    let running = presentationNet(account.type, exactMinor(opening.debit, 'opening debit'), exactMinor(opening.credit, 'opening credit'));
    const openingMinor = running;

    const visible = page.slice(0, limit);
    const rows: LedgerRow[] = visible.map((r) => {
      const debit = exactMinor(r.debit, 'debit');
      const credit = exactMinor(r.credit, 'credit');
      running += presentationNet(account.type, debit, credit);
      return {
        entryId: r.entryId,
        entryDate: r.entryDate,
        lineNo: r.lineNo,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        description: r.description,
        debitMinor: debit,
        creditMinor: credit,
        baseAmountMinor: exactMinor(r.baseAmountMinor, 'base amount'),
        baseCurrency: r.baseCurrency,
        txnAmountMinor: exactMinor(r.txnAmountMinor, 'transaction amount'),
        txnCurrency: r.txnCurrency,
        fxRate: r.fxRate,
        fxRateSource: r.fxRateSource,
        fxRateAt: r.fxRateAt,
        branchId: r.branchId,
        warehouseId: r.warehouseId,
        memo: r.memo,
        runningMinor: running,
      };
    });

    const last = rows[rows.length - 1];
    const nextCursor =
      page.length > limit && last !== undefined ? encodeLedgerCursor({ entryDate: last.entryDate, entryId: last.entryId, lineNo: last.lineNo }) : null;

    return { account, from: query.from, to: query.to, baseCurrency, openingMinor, rows, closingMinor: running, nextCursor };
  }

  /**
   * Account balances as of an inclusive date (§31).
   *
   * Every row carries its `asOf`. A balance without the instant it is true at
   * is a number a reader will eventually quote in a different context, and
   * the omission is what makes that possible.
   */
  async balances(scope: ReportScope, query: BalancesQuery): Promise<readonly AccountBalanceRow[]> {
    const baseCurrency = await this.requireBaseCurrency(scope);
    const raw = await this.reader.balanceTotals(scope, query);
    const out: AccountBalanceRow[] = [];
    for (const r of raw) {
      const debit = exactMinor(r.debit, 'debit total');
      const credit = exactMinor(r.credit, 'credit total');
      if (debit === 0n && credit === 0n && query.includeZeroActivity !== true) continue;
      out.push({
        accountId: r.accountId,
        code: r.code,
        name: r.name,
        type: r.type,
        isActive: r.isActive,
        balanceMinor: presentationNet(r.type, debit, credit),
        currency: baseCurrency,
        asOf: query.asOf,
      });
    }
    return out;
  }

  private async requireBaseCurrency(scope: ReportScope): Promise<string> {
    const currency = await this.reader.baseCurrency(scope);
    if (currency === null) {
      throw new AccountingError('accounting.report_scope_invalid', 'the business does not exist or is not visible to this caller', {
        businessId: scope.businessId,
      });
    }
    return currency;
  }
}

/** A page size is bounded by the SERVER, never by what a caller asked for. */
export function boundPage(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}
