import { Inject, Injectable } from '@nestjs/common';
import type {
  AccountListQuery,
  AccountSummary,
  AccountType,
  AccountingReportReader,
  BalancesQuery,
  EntryDetail,
  EntryDetailLine,
  EntryListQuery,
  EntrySummary,
  FxRateSource,
  LedgerQuery,
  RawAccountTotals,
  RawLedgerRow,
  RawTotals,
  ReportBranchScope,
  ReportScope,
  TrialBalanceQuery,
} from '@daftar/accounting';
import { Database } from '../../infra/database';

/**
 * THE SQL BEHIND THE FINANCIAL READS (P2-S7).
 *
 * Four properties hold for every query in this file, and each one is a rule
 * rather than a habit.
 *
 * IT ONLY SELECTS. There is no INSERT, UPDATE, DELETE or TRUNCATE anywhere
 * below, and there could not be: `daftar_app` holds SELECT and nothing else
 * on the journal. Guard G-4 and the P2-S7 read-surface guard both fail CI if
 * one ever appears. A read that mutates is a read nobody can reason about.
 *
 * IT RUNS AS THE CALLER. No SECURITY DEFINER routine, no elevated principal,
 * no bypass (§40). One business is kept out of another's books by row level
 * security, the same mechanism that protects every other merchant read — and
 * every query ALSO constrains `business_id` explicitly. That is not
 * redundancy for its own sake: RLS is the boundary, the predicate is the
 * statement of intent, and a day when one of them is misconfigured is a day
 * the other still holds (§38).
 *
 * IT SUMS IN NUMERIC. `SUM(bigint)` returns NUMERIC in PostgreSQL, and the
 * result is cast to `text` rather than back to `bigint` — a business whose
 * cumulative history exceeds 9.2 × 10^18 minor units is a business whose
 * report must still be right, even though every individual line is capped at
 * 10^18 (§41). The string becomes a `bigint` in the domain module; it never
 * becomes a `number`.
 *
 * IT NEVER LOOKS UP A RATE. Every FX field a report renders comes from the
 * `journal_lines` row that was posted. `accounting_fx_rate_lookup` is not
 * called here and must never be: a rate entered tomorrow changing yesterday's
 * report is the definition of a rewritten history (§30, §52).
 */
@Injectable()
export class DatabaseAccountingReportReader implements AccountingReportReader {
  constructor(@Inject(Database) private readonly db: Database) {}

  async baseCurrency(scope: ReportScope): Promise<string | null> {
    const { rows } = await this.db.scoped<{ base_currency: string }>(this.scope(scope), `SELECT b.base_currency FROM businesses b WHERE b.id = $1`, [
      scope.businessId,
    ]);
    return rows[0]?.base_currency ?? null;
  }

  /**
   * The chart.
   *
   * `includeInactive` defaults TRUE at the domain boundary, and the predicate
   * below is only ever added when a caller explicitly asked for the active
   * subset. `WHERE accounts.is_active` must never reach a HISTORICAL query —
   * §33 — and the only way to be sure of that is for it to live here, on the
   * chart read, and nowhere else in this file.
   */
  async listAccounts(scope: ReportScope, query: AccountListQuery): Promise<readonly AccountSummary[]> {
    const conditions = ['a.business_id = $1'];
    const params: unknown[] = [scope.businessId];
    if (query.includeInactive === false) conditions.push('a.is_active');
    if (present(query.type)) {
      params.push(query.type);
      conditions.push(`a.type = $${params.length}`);
    }
    const { rows } = await this.db.scoped<AccountRow>(
      this.scope(scope),
      `SELECT a.id, a.code, a.name, a.type, a.system_key, a.is_active
         FROM accounts a
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.code`,
      params,
    );
    return rows.map(toAccount);
  }

  /**
   * One account by COMPOSITE identity `(business_id, id)`.
   *
   * An account of another business returns `null` here and becomes
   * `accounting.account_not_found` above — indistinguishable from an id that
   * never existed. A caller must not be able to learn that an id is real by
   * getting a different refusal for it (§32).
   */
  async findAccount(scope: ReportScope, accountId: string): Promise<AccountSummary | null> {
    const { rows } = await this.db.scoped<AccountRow>(
      this.scope(scope),
      `SELECT a.id, a.code, a.name, a.type, a.system_key, a.is_active
         FROM accounts a WHERE a.business_id = $1 AND a.id = $2`,
      [scope.businessId, accountId],
    );
    const row = rows[0];
    return row === undefined ? null : toAccount(row);
  }

  /**
   * Per-account debit and credit totals for the trial balance window.
   *
   * A LEFT JOIN from `accounts`, so an account with no movement is a row of
   * zeroes rather than an absent row — which is what lets the domain module
   * answer `includeZeroActivity` without a second query, and what keeps an
   * inactive account with history visible whatever the window.
   */
  async trialBalanceTotals(scope: ReportScope, query: TrialBalanceQuery): Promise<readonly RawAccountTotals[]> {
    const params: unknown[] = [scope.businessId];
    const lineConditions = ['l.business_id = $1'];

    if (query.range.kind === 'asOf') {
      params.push(query.range.asOf);
      lineConditions.push(`e.entry_date <= $${params.length}::date`);
    } else {
      params.push(query.range.from);
      lineConditions.push(`e.entry_date >= $${params.length}::date`);
      params.push(query.range.to);
      lineConditions.push(`e.entry_date <= $${params.length}::date`);
    }

    const branch = branchPredicate(query.branch, 'l', params);
    if (branch !== null) lineConditions.push(branch);

    const { rows } = await this.db.scoped<AccountTotalsRow>(this.scope(scope), accountTotalsSql(lineConditions, ['a.business_id = $1']), params);
    return rows.map(toTotals);
  }

  /** Cumulative totals at or before `asOf`, inclusive (§31). */
  async balanceTotals(scope: ReportScope, query: BalancesQuery): Promise<readonly RawAccountTotals[]> {
    const params: unknown[] = [scope.businessId, query.asOf];
    const lineConditions = ['l.business_id = $1', 'e.entry_date <= $2::date'];
    const branch = branchPredicate(query.branch, 'l', params);
    if (branch !== null) lineConditions.push(branch);

    const accountConditions = ['a.business_id = $1'];
    if (present(query.accountIds) && query.accountIds.length > 0) {
      params.push([...query.accountIds]);
      accountConditions.push(`a.id = ANY($${params.length}::uuid[])`);
    }

    const { rows } = await this.db.scoped<AccountTotalsRow>(this.scope(scope), accountTotalsSql(lineConditions, accountConditions), params);
    return rows.map(toTotals);
  }

  /**
   * The ledger's opening figure.
   *
   * STRICTLY before `from` — `<`, never `<=`. On a page resumed from a
   * cursor it also includes everything in range up to and including the
   * cursor row, expressed as the SAME lexicographic tuple the page's own
   * predicate uses, so the running balance continues instead of restarting.
   */
  async ledgerOpening(scope: ReportScope, query: LedgerQuery): Promise<RawTotals> {
    const params: unknown[] = [scope.businessId, query.accountId, query.from];
    const conditions = ['l.business_id = $1', 'l.account_id = $2'];
    const branch = branchPredicate(query.branch, 'l', params);
    if (branch !== null) conditions.push(branch);

    if (!present(query.cursor)) {
      conditions.push('e.entry_date < $3::date');
    } else {
      params.push(query.cursor.entryDate, query.cursor.entryId, query.cursor.lineNo);
      const d = params.length - 2;
      conditions.push(
        `(e.entry_date < $3::date OR (e.entry_date >= $3::date AND (e.entry_date, l.journal_entry_id, l.line_no) <= ($${d}::date, $${d + 1}::uuid, $${d + 2}::int)))`,
      );
    }

    const { rows } = await this.db.scoped<RawTotalsRow>(
      this.scope(scope),
      `SELECT coalesce(sum(l.debit_minor), 0)::text AS debit, coalesce(sum(l.credit_minor), 0)::text AS credit
         FROM journal_lines l
         JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
        WHERE ${conditions.join(' AND ')}`,
      params,
    );
    const row = rows[0];
    return { debit: row?.debit ?? '0', credit: row?.credit ?? '0' };
  }

  /**
   * One ledger page, keyset — never OFFSET (§27, §28).
   *
   * The ORDER BY and the cursor predicate are the SAME tuple, written as a
   * row comparison so PostgreSQL evaluates it lexicographically exactly as it
   * sorts. That is what makes a page boundary inside a single busy date safe:
   * the third element, `line_no`, is what distinguishes two lines of one entry
   * that a naive `(date, id)` cursor would either repeat or skip.
   */
  async ledgerPage(scope: ReportScope, query: LedgerQuery): Promise<readonly RawLedgerRow[]> {
    const params: unknown[] = [scope.businessId, query.accountId, query.from, query.to];
    const conditions = ['l.business_id = $1', 'l.account_id = $2', 'e.entry_date >= $3::date', 'e.entry_date <= $4::date'];
    const branch = branchPredicate(query.branch, 'l', params);
    if (branch !== null) conditions.push(branch);

    if (present(query.cursor)) {
      params.push(query.cursor.entryDate, query.cursor.entryId, query.cursor.lineNo);
      const d = params.length - 2;
      conditions.push(`(e.entry_date, l.journal_entry_id, l.line_no) > ($${d}::date, $${d + 1}::uuid, $${d + 2}::int)`);
    }

    params.push(query.limit);
    const { rows } = await this.db.scoped<LedgerRowRecord>(
      this.scope(scope),
      `SELECT l.journal_entry_id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, l.line_no,
              e.source_type, e.source_id, e.description,
              l.debit_minor::text AS debit, l.credit_minor::text AS credit,
              l.base_amount_minor::text AS base_amount_minor, l.base_currency,
              l.txn_amount_minor::text AS txn_amount_minor, l.txn_currency,
              l.fx_rate::text AS fx_rate, l.fx_rate_source, l.fx_rate_at,
              l.branch_id, l.warehouse_id, l.memo
         FROM journal_lines l
         JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.entry_date, l.journal_entry_id, l.line_no
        LIMIT $${params.length}`,
      params,
    );
    return rows.map(toLedgerRow);
  }

  /**
   * The entry list, keyset on `(entry_date, id)`.
   *
   * The branch predicate here is stronger than a filter. For an
   * assigned-scope member an entry qualifies only when EVERY line's branch is
   * inside their allowance AND no line carries a business-level NULL branch,
   * expressed as a NOT EXISTS over the disqualifying lines. A filter that
   * merely matched SOME line would hand back a shortened entry containing
   * another branch's money (§36, §37).
   */
  async listEntries(scope: ReportScope, query: EntryListQuery): Promise<readonly EntrySummary[]> {
    const params: unknown[] = [scope.businessId];
    const conditions = ['e.business_id = $1'];

    if (present(query.from)) {
      params.push(query.from);
      conditions.push(`e.entry_date >= $${params.length}::date`);
    }
    if (present(query.to)) {
      params.push(query.to);
      conditions.push(`e.entry_date <= $${params.length}::date`);
    }
    if (present(query.sourceType)) {
      params.push(query.sourceType);
      conditions.push(`e.source_type = $${params.length}`);
    }
    const visibility = entryVisibilityPredicate(query.branch, params);
    if (visibility !== null) conditions.push(visibility);

    if (present(query.cursor)) {
      params.push(query.cursor.entryDate, query.cursor.entryId);
      const d = params.length - 1;
      conditions.push(`(e.entry_date, e.id) > ($${d}::date, $${d + 1}::uuid)`);
    }

    params.push(query.limit);
    const { rows } = await this.db.scoped<EntryRowRecord>(
      this.scope(scope),
      `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.source_type, e.source_id,
              e.description, e.created_at,
              (SELECT count(*) FROM journal_lines l WHERE l.business_id = e.business_id AND l.journal_entry_id = e.id)::int AS line_count
         FROM journal_entries e
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.entry_date, e.id
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      entryId: r.id,
      entryDate: r.entry_date,
      sourceType: r.source_type,
      sourceId: r.source_id,
      description: r.description,
      createdAt: r.created_at,
      lineCount: r.line_count,
    }));
  }

  /**
   * One entry, whole.
   *
   * Every line, always — a partially rendered journal is a journal that does
   * not balance, and showing one would be worse than refusing. Whether this
   * caller may see the entry AT ALL is decided above, from
   * `entryBranchDimensions`, before this is called.
   */
  async readEntryDetail(scope: ReportScope, entryId: string): Promise<EntryDetail | null> {
    return this.db.withTransaction(this.scope(scope), async (c) => {
      const head = (
        await c.query<EntryHeadRecord>(
          `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.source_type, e.source_id, e.description,
                  e.actor_kind, e.actor_user_id, e.actor_system_key, e.created_at
             FROM journal_entries e
            WHERE e.business_id = $1 AND e.id = $2`,
          [scope.businessId, entryId],
        )
      ).rows[0];
      if (head === undefined) return null;

      const lines = (
        await c.query<DetailLineRecord>(
          `SELECT l.line_no, a.id AS account_id, a.code, a.name, a.type, a.system_key,
                  l.debit_minor::text AS debit, l.credit_minor::text AS credit,
                  l.base_amount_minor::text AS base_amount_minor, l.base_currency,
                  l.txn_amount_minor::text AS txn_amount_minor, l.txn_currency,
                  l.fx_rate::text AS fx_rate, l.fx_rate_source, l.fx_rate_at,
                  l.branch_id, l.warehouse_id, l.memo
             FROM journal_lines l
             JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
            WHERE l.business_id = $1 AND l.journal_entry_id = $2
            ORDER BY l.line_no`,
          [scope.businessId, entryId],
        )
      ).rows;

      return {
        entryId: head.id,
        entryDate: head.entry_date,
        sourceType: head.source_type,
        sourceId: head.source_id,
        description: head.description,
        actorKind: head.actor_kind === 'system' ? 'system' : 'user',
        actorUserId: head.actor_user_id,
        actorSystemKey: head.actor_system_key,
        createdAt: head.created_at,
        lines: lines.map(toDetailLine),
      };
    });
  }

  /** Every distinct branch dimension the entry's lines carry, `null` included. */
  async entryBranchDimensions(scope: ReportScope, entryId: string): Promise<readonly (string | null)[]> {
    const { rows } = await this.db.scoped<{ branch_id: string | null }>(
      this.scope(scope),
      `SELECT DISTINCT l.branch_id FROM journal_lines l WHERE l.business_id = $1 AND l.journal_entry_id = $2`,
      [scope.businessId, entryId],
    );
    return rows.map((r) => r.branch_id);
  }

  private scope(scope: ReportScope): { tenantId: string; businessId: string } {
    return { tenantId: scope.tenantId, businessId: scope.businessId };
  }
}

/**
 * The per-account aggregate, written once for both windows that need it.
 *
 * A LEFT JOIN from `accounts` to a GROUPED derived table rather than to the
 * lines directly. Both shapes give the same totals, but this one says what it
 * means: the totals are computed over the selected lines, and every account of
 * the chart appears whether or not it has any — which is what keeps an
 * inactive account with history in the report and lets the domain module
 * answer `includeZeroActivity` without a second query.
 *
 * `sum(bigint)` is NUMERIC in PostgreSQL and is cast to `text`, never back to
 * `bigint`: cumulative history may exceed what a BIGINT holds even though
 * every individual line is capped well below it (§41).
 */
function accountTotalsSql(lineConditions: readonly string[], accountConditions: readonly string[]): string {
  return `SELECT a.id, a.code, a.name, a.type, a.is_active,
                 coalesce(t.debit, 0)::text  AS debit,
                 coalesce(t.credit, 0)::text AS credit
            FROM accounts a
            LEFT JOIN (
                   SELECT l.account_id, sum(l.debit_minor) AS debit, sum(l.credit_minor) AS credit
                     FROM journal_lines l
                     JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
                    WHERE ${lineConditions.join(' AND ')}
                    GROUP BY l.account_id
                 ) t ON t.account_id = a.id
           WHERE ${accountConditions.join(' AND ')}
           ORDER BY a.code`;
}

/**
 * The branch predicate for an AGGREGATE, as a parameterized fragment.
 *
 * `all` with no branch asked for: no predicate, the whole business.
 * `all` with a branch: that dimension only — the caller's own choice, and
 *   their authority already covers every branch.
 * `assigned`: the allowed branches and NOTHING ELSE. `branch_id IS NULL` is
 *   deliberately excluded rather than included: a NULL dimension is
 *   business-level financial truth — an opening balance is written that way —
 *   and a member who may see one branch has not thereby been given the
 *   business's opening position (§37). `= ANY(...)` is already false for
 *   NULL, and the comment is here because that is easy to "fix" by accident.
 *
 * Nothing in this function interpolates a caller value: every branch id
 * becomes a bound parameter, and the ids themselves were validated against
 * the membership before the query was built.
 */
function branchPredicate(scope: ReportBranchScope, alias: string, params: unknown[]): string | null {
  if (scope.mode === 'all') {
    if (!present(scope.branchId)) return null;
    params.push(scope.branchId);
    return `${alias}.branch_id = $${params.length}::uuid`;
  }
  params.push([...scope.branchIds]);
  return `${alias}.branch_id = ANY($${params.length}::uuid[])`;
}

/**
 * The branch predicate for an ENTRY, which is a different question.
 *
 * An aggregate may take the lines it is allowed to see. An entry may not be
 * shown at all unless the caller is allowed to see ALL of it, so this is a
 * NOT EXISTS over the lines that would disqualify it: any line outside the
 * allowance, and any line with no branch at all.
 */
function entryVisibilityPredicate(scope: ReportBranchScope, params: unknown[]): string | null {
  if (scope.mode === 'all') {
    if (!present(scope.branchId)) return null;
    params.push(scope.branchId);
    return `EXISTS (SELECT 1 FROM journal_lines l WHERE l.business_id = e.business_id AND l.journal_entry_id = e.id AND l.branch_id = $${params.length}::uuid)`;
  }
  params.push([...scope.branchIds]);
  return `NOT EXISTS (SELECT 1 FROM journal_lines l
            WHERE l.business_id = e.business_id AND l.journal_entry_id = e.id
              AND (l.branch_id IS NULL OR NOT (l.branch_id = ANY($${params.length}::uuid[]))))`;
}

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  system_key: string | null;
  is_active: boolean;
}

interface RawTotalsRow {
  debit: string;
  credit: string;
}

interface AccountTotalsRow extends AccountRow, RawTotalsRow {}

interface LedgerRowRecord {
  journal_entry_id: string;
  entry_date: string;
  line_no: number;
  source_type: string;
  source_id: string;
  description: string | null;
  debit: string;
  credit: string;
  base_amount_minor: string;
  base_currency: string;
  txn_amount_minor: string;
  txn_currency: string;
  fx_rate: string;
  fx_rate_source: string;
  fx_rate_at: Date;
  branch_id: string | null;
  warehouse_id: string | null;
  memo: string | null;
}

interface EntryRowRecord {
  id: string;
  entry_date: string;
  source_type: string;
  source_id: string;
  description: string | null;
  created_at: Date;
  line_count: number;
}

interface EntryHeadRecord {
  id: string;
  entry_date: string;
  source_type: string;
  source_id: string;
  description: string | null;
  actor_kind: string;
  actor_user_id: string | null;
  actor_system_key: string | null;
  created_at: Date;
}

interface DetailLineRecord extends LedgerRowRecord {
  account_id: string;
  code: string;
  name: string;
  type: string;
  system_key: string | null;
}

const toAccount = (r: AccountRow): AccountSummary => ({
  accountId: r.id,
  code: r.code,
  name: r.name,
  type: r.type as AccountType,
  systemKey: r.system_key,
  isActive: r.is_active,
});

const toTotals = (r: AccountTotalsRow): RawAccountTotals => ({
  accountId: r.id,
  code: r.code,
  name: r.name,
  type: r.type as AccountType,
  isActive: r.is_active,
  debit: r.debit,
  credit: r.credit,
});

const toLedgerRow = (r: LedgerRowRecord): RawLedgerRow => ({
  entryId: r.journal_entry_id,
  entryDate: r.entry_date,
  lineNo: r.line_no,
  sourceType: r.source_type,
  sourceId: r.source_id,
  description: r.description,
  debit: r.debit,
  credit: r.credit,
  baseAmountMinor: r.base_amount_minor,
  baseCurrency: r.base_currency,
  txnAmountMinor: r.txn_amount_minor,
  txnCurrency: r.txn_currency,
  fxRate: r.fx_rate,
  fxRateSource: r.fx_rate_source as FxRateSource,
  fxRateAt: r.fx_rate_at,
  branchId: r.branch_id,
  warehouseId: r.warehouse_id,
  memo: r.memo,
});

const toDetailLine = (r: DetailLineRecord): EntryDetailLine => ({
  lineNo: r.line_no,
  accountId: r.account_id,
  code: r.code,
  name: r.name,
  type: r.type as AccountType,
  // Engine identity, exactly as the posting side names it: the stable system
  // key when there is one, the business's own chart code otherwise. Never the
  // UUID and never the display name (AL-07).
  account: r.system_key !== null ? { kind: 'system', systemKey: r.system_key } : { kind: 'code', code: r.code },
  side: BigInt(r.debit) > 0n ? 'D' : 'C',
  debitMinor: BigInt(r.debit),
  creditMinor: BigInt(r.credit),
  baseAmountMinor: BigInt(r.base_amount_minor),
  baseCurrency: r.base_currency,
  txnAmountMinor: BigInt(r.txn_amount_minor),
  txnCurrency: r.txn_currency,
  fxRate: r.fx_rate,
  fxRateSource: r.fx_rate_source as FxRateSource,
  fxRateAt: r.fx_rate_at,
  branchId: r.branch_id,
  warehouseId: r.warehouse_id,
  memo: r.memo,
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
