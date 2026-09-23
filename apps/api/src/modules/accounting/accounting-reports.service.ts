import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountingError,
  AccountingReports,
  boundPage,
  decodeEntryCursor,
  decodeLedgerCursor,
  type AccountBalanceRow,
  type AccountSummary,
  type AccountType,
  type EntryDetail,
  type EntrySummary,
  type LedgerReport,
  type ReportBranchScope,
  type ReportScope,
  type TrialBalanceRange,
  type TrialBalanceReport,
} from '@daftar/accounting';
import { hasPermission } from '@daftar/domain-core';
import type {
  AccountingAccountBalanceDto,
  AccountingAccountDto,
  AccountingBalanceListDto,
  AccountingEntryDetailDto,
  AccountingEntryListDto,
  AccountingEntrySummaryDto,
  AccountingLedgerDto,
  AccountingTrialBalanceDto,
} from '@daftar/shared-contracts';
import type { MembershipContext } from '../tenancy/tenancy.service';

/**
 * THE AUTHORIZATION BOUNDARY IN FRONT OF THE FINANCIAL READS (P2-S7).
 *
 * Three rules hold for every method here, and none of them has an override.
 *
 * `accounting.view` IS REQUIRED, ALWAYS. It is checked on the route by the
 * guard and again here, because the two answer different callers. And it is
 * checked ON ITS OWN: a member holding `accounting.post` has been given the
 * ability to create some financial facts through a source workflow, which is
 * not the same authority as reading the business's books. Neither key implies
 * the other at any layer (§62).
 *
 * BRANCH SCOPE IS RESOLVED HERE, FROM THE MEMBERSHIP, NEVER FROM THE QUERY.
 * A `branchId` in a query string is a request, not a fact: it is checked
 * against `allowedBranchIds` before it can reach a predicate, and a foreign or
 * unassigned branch is refused rather than silently ignored. An
 * assigned-scope member may not have an unfiltered whole-business financial
 * report at all — that is not a filter they forgot to apply, it is authority
 * they do not hold (§36).
 *
 * NOTHING HERE WRITES. Not a row, not a "last viewed" timestamp, not a cached
 * total. GET means GET (§54): reading an entry triggers no reconciliation, no
 * repair, no lazy migration, no FX lookup and no period mutation.
 */
@Injectable()
export class AccountingReportsService {
  constructor(@Inject('ACCOUNTING_REPORTS') private readonly reports: AccountingReports) {}

  async accounts(m: MembershipContext, query: { type?: string | null; includeInactive?: boolean }): Promise<{ items: AccountingAccountDto[] }> {
    this.authorize(m);
    const items = await this.reports.accounts(this.scope(m), {
      type: (query.type ?? null) as AccountType | null,
      // TRUE unless the caller asked otherwise. `is_active` governs future
      // posting, not history, and a chart that hid deactivated accounts would
      // hide the accounts a merchant's own history is written in (§33).
      includeInactive: query.includeInactive ?? true,
    });
    return { items: items.map(toAccountDto) };
  }

  async entries(
    m: MembershipContext,
    query: { from?: string | null; to?: string | null; sourceType?: string | null; branchId?: string | null; limit?: number; cursor?: string | null },
  ): Promise<AccountingEntryListDto> {
    this.authorize(m);
    assertRange(query.from ?? null, query.to ?? null);
    const branch = this.branchScope(m, query.branchId ?? null, { wholeBusinessAllowed: false });
    const page = await this.reports.entries(this.scope(m), {
      from: query.from ?? null,
      to: query.to ?? null,
      sourceType: query.sourceType ?? null,
      branch,
      limit: boundPage(query.limit ?? 0),
      cursor: present(query.cursor) ? decodeEntryCursor(query.cursor) : null,
    });
    return { items: page.items.map(toEntrySummaryDto), nextCursor: page.nextCursor };
  }

  /**
   * One entry, whole or not at all.
   *
   * For an assigned-scope member the question is not "which lines may I see"
   * but "may I see this entry": a journal rendered without some of its lines
   * does not balance, and a reader who did not notice would be looking at a
   * false document. So an entry with any line outside the allowance, or any
   * line carrying the business-level NULL dimension, is REFUSED — and refused
   * as NOT FOUND, so the refusal itself does not confirm that an entry with
   * that id exists (§36).
   */
  async entry(m: MembershipContext, entryId: string): Promise<AccountingEntryDetailDto> {
    this.authorize(m);
    const scope = this.scope(m);
    const detail = await this.reports.entry(scope, entryId);
    if (detail === null) throw new NotFoundException('No such journal entry in this business');

    if (m.branchScopeMode === 'assigned') {
      const allowed = new Set(m.allowedBranchIds);
      const reachable = detail.lines.every((l) => l.branchId !== null && allowed.has(l.branchId));
      if (!reachable) throw new NotFoundException('No such journal entry in this business');
    }
    return toEntryDetailDto(detail);
  }

  async trialBalance(
    m: MembershipContext,
    query: { asOf?: string | null; from?: string | null; to?: string | null; branchId?: string | null; includeZeroActivity?: boolean },
  ): Promise<AccountingTrialBalanceDto> {
    this.authorize(m);
    const range = resolveTrialBalanceRange(query);
    const branch = this.branchScope(m, query.branchId ?? null, { wholeBusinessAllowed: true });
    const report = await this.reports.trialBalance(this.scope(m), {
      range,
      branch,
      ...(query.includeZeroActivity === undefined ? {} : { includeZeroActivity: query.includeZeroActivity }),
    });
    return toTrialBalanceDto(report);
  }

  async ledger(
    m: MembershipContext,
    query: { accountId: string; from: string; to: string; branchId?: string | null; limit?: number; cursor?: string | null },
  ): Promise<AccountingLedgerDto> {
    this.authorize(m);
    assertRange(query.from, query.to);
    const branch = this.branchScope(m, query.branchId ?? null, { wholeBusinessAllowed: true });
    try {
      const report = await this.reports.ledger(this.scope(m), {
        accountId: query.accountId,
        from: query.from,
        to: query.to,
        branch,
        limit: boundPage(query.limit ?? 0),
        cursor: present(query.cursor) ? decodeLedgerCursor(query.cursor) : null,
      });
      return toLedgerDto(report);
    } catch (e) {
      // An account of another business and an account that never existed must
      // be INDISTINGUISHABLE at the transport (§32). The domain says "not
      // found"; here that becomes a 404 rather than the 400 an unclassified
      // accounting code would otherwise land on, so a caller cannot learn that
      // an id is real by watching which refusal comes back.
      if (e instanceof AccountingError && e.code === 'accounting.account_not_found') {
        throw new NotFoundException('No such account in this business');
      }
      throw e;
    }
  }

  async balances(
    m: MembershipContext,
    query: { asOf: string; accountIds?: readonly string[] | null; branchId?: string | null; includeZeroActivity?: boolean },
  ): Promise<AccountingBalanceListDto> {
    this.authorize(m);
    const branch = this.branchScope(m, query.branchId ?? null, { wholeBusinessAllowed: true });
    const rows = await this.reports.balances(this.scope(m), {
      asOf: query.asOf,
      accountIds: query.accountIds ?? null,
      branch,
      ...(query.includeZeroActivity === undefined ? {} : { includeZeroActivity: query.includeZeroActivity }),
    });
    const first = rows[0];
    return {
      asOf: query.asOf,
      // Every row carries the same base currency; the list repeats it once at
      // the top so a client rendering a header does not have to look inside.
      baseCurrency: first?.currency ?? '',
      items: rows.map(toBalanceDto),
    };
  }

  private scope(m: MembershipContext): ReportScope {
    return { tenantId: m.tenantId, businessId: m.businessId };
  }

  private authorize(m: MembershipContext): void {
    if (!hasPermission(m.roles, 'accounting.view')) {
      throw new ForbiddenException('accounting.view is required to read the accounting books');
    }
  }

  /**
   * Turn a membership plus a requested branch into an authority the reader
   * can be trusted with.
   *
   * `wholeBusinessAllowed` is false for the entry LIST, which is the one
   * place the distinction bites: an assigned-scope member reading the entry
   * list without naming a branch still gets a list, because the entry
   * visibility predicate already restricts it to entries wholly inside their
   * allowance. For an AGGREGATE there is no such safety net, so an
   * unfiltered whole-business total is refused outright.
   */
  private branchScope(m: MembershipContext, requested: string | null, opts: { wholeBusinessAllowed: boolean }): ReportBranchScope {
    if (m.branchScopeMode === 'assigned') {
      if (requested === null) {
        if (opts.wholeBusinessAllowed) {
          throw new ForbiddenException('a business-wide financial report requires business-wide authority; name a branch you are assigned to');
        }
        return { mode: 'assigned', branchIds: [...m.allowedBranchIds] };
      }
      if (!m.allowedBranchIds.includes(requested)) {
        throw new ForbiddenException('Branch is outside your assigned scope');
      }
      return { mode: 'assigned', branchIds: [requested] };
    }
    return requested === null ? { mode: 'all' } : { mode: 'all', branchId: requested };
  }
}

/**
 * `asOf` XOR `from`/`to`, and one of them is required (§22, §53).
 *
 * A request naming both is REFUSED rather than resolved by precedence. The
 * two modes answer different questions — a cumulative position versus the
 * movement inside a window — and a server that picked one for an ambiguous
 * request would be answering a question the merchant did not ask.
 */
function resolveTrialBalanceRange(query: { asOf?: string | null; from?: string | null; to?: string | null }): TrialBalanceRange {
  const hasAsOf = present(query.asOf);
  const hasRange = present(query.from) || present(query.to);
  if (hasAsOf && hasRange) {
    throw new AccountingError('accounting.report_range_ambiguous', 'a trial balance is either as of a date or over a range, never both');
  }
  if (hasAsOf && present(query.asOf)) return { kind: 'asOf', asOf: query.asOf };
  if (present(query.from) && present(query.to)) {
    assertRange(query.from, query.to);
    return { kind: 'range', from: query.from, to: query.to };
  }
  throw new AccountingError('accounting.report_range_invalid', 'a trial balance needs either asOf, or both from and to');
}

function assertRange(from: string | null, to: string | null): void {
  if (present(from) && present(to) && from > to) {
    throw new AccountingError('accounting.report_range_invalid', 'a date range ends on or after it starts');
  }
}

const instant = (value: Date): string => `${value.toISOString().slice(0, 19)}Z`;

const toAccountDto = (a: AccountSummary): AccountingAccountDto => ({
  accountId: a.accountId,
  code: a.code,
  name: a.name,
  type: a.type,
  systemKey: a.systemKey,
  isActive: a.isActive,
});

const toEntrySummaryDto = (e: EntrySummary): AccountingEntrySummaryDto => ({
  entryId: e.entryId,
  entryDate: e.entryDate,
  sourceType: e.sourceType,
  sourceId: e.sourceId,
  description: e.description,
  createdAt: instant(e.createdAt),
  lineCount: e.lineCount,
});

/**
 * Entry detail, with nothing in it a caller has no business seeing.
 *
 * `posting_fingerprint` is absent, and so is every other piece of assertion
 * material: no HMAC, no jti, no signing kid, no canonical byte stream (§35).
 * Those exist so the database can refuse a forged command; publishing them
 * would hand a caller the shape of the thing they would need to forge.
 */
const toEntryDetailDto = (d: EntryDetail): AccountingEntryDetailDto => ({
  entryId: d.entryId,
  entryDate: d.entryDate,
  sourceType: d.sourceType,
  sourceId: d.sourceId,
  description: d.description,
  actorKind: d.actorKind,
  actorUserId: d.actorUserId,
  actorSystemKey: d.actorSystemKey,
  createdAt: instant(d.createdAt),
  lines: d.lines.map((l) => ({
    lineNo: l.lineNo,
    accountId: l.accountId,
    code: l.code,
    name: l.name,
    type: l.type,
    side: l.side,
    debitMinor: l.debitMinor.toString(),
    creditMinor: l.creditMinor.toString(),
    baseAmountMinor: l.baseAmountMinor.toString(),
    baseCurrency: l.baseCurrency,
    txnAmountMinor: l.txnAmountMinor.toString(),
    txnCurrency: l.txnCurrency,
    fxRate: l.fxRate,
    fxRateSource: l.fxRateSource,
    fxRateAt: instant(l.fxRateAt),
    branchId: l.branchId,
    warehouseId: l.warehouseId,
    memo: l.memo,
  })),
});

const toTrialBalanceDto = (r: TrialBalanceReport): AccountingTrialBalanceDto => ({
  kind: r.kind,
  isBalanced: r.isBalanced,
  totalDebitMinor: r.totalDebitMinor.toString(),
  totalCreditMinor: r.totalCreditMinor.toString(),
  baseCurrency: r.baseCurrency,
  items: r.rows.map((row) => ({
    accountId: row.accountId,
    code: row.code,
    name: row.name,
    type: row.type,
    isActive: row.isActive,
    totalDebitMinor: row.totalDebitMinor.toString(),
    totalCreditMinor: row.totalCreditMinor.toString(),
    netMinor: row.netMinor.toString(),
    baseCurrency: row.baseCurrency,
  })),
});

const toLedgerDto = (r: LedgerReport): AccountingLedgerDto => ({
  account: toAccountDto(r.account),
  from: r.from,
  to: r.to,
  baseCurrency: r.baseCurrency,
  openingMinor: r.openingMinor.toString(),
  closingMinor: r.closingMinor.toString(),
  nextCursor: r.nextCursor,
  items: r.rows.map((row) => ({
    entryId: row.entryId,
    entryDate: row.entryDate,
    lineNo: row.lineNo,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    description: row.description,
    debitMinor: row.debitMinor.toString(),
    creditMinor: row.creditMinor.toString(),
    baseAmountMinor: row.baseAmountMinor.toString(),
    baseCurrency: row.baseCurrency,
    txnAmountMinor: row.txnAmountMinor.toString(),
    txnCurrency: row.txnCurrency,
    fxRate: row.fxRate,
    fxRateSource: row.fxRateSource,
    fxRateAt: instant(row.fxRateAt),
    branchId: row.branchId,
    warehouseId: row.warehouseId,
    memo: row.memo,
    runningMinor: row.runningMinor.toString(),
  })),
});

const toBalanceDto = (b: AccountBalanceRow): AccountingAccountBalanceDto => ({
  accountId: b.accountId,
  code: b.code,
  name: b.name,
  type: b.type,
  isActive: b.isActive,
  balanceMinor: b.balanceMinor.toString(),
  currency: b.currency,
  asOf: b.asOf,
});

/**
 * Present, as a type predicate.
 *
 * The lint rule requires `===`/`!==`, so `x != null` is not available and
 * writing `x !== null && x !== undefined` at every optional query field would
 * bury the logic in ceremony. One predicate says it once and narrows the type
 * on both branches.
 */
function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
