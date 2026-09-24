import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  NATIVE_SOURCE_TYPES,
  RECONCILIATION_CHECKS,
  ReconciliationEnumerationError,
  ReconciliationUnavailableError,
  type AccountingReconciliationReader,
  type ReconciliationCheckId,
  type ReconciliationFinding,
  type ReconciliationTarget,
} from '@daftar/accounting';
import { Database } from '../../infra/database';

/**
 * THE SQL BEHIND RECONCILIATION (P2-S8 §20-§22).
 *
 * Every statement in this file is a SELECT, and that is a property of the
 * credential as much as of the text: the pass runs as `daftar_reconciler`,
 * which holds column-level SELECT on six tables and holds no INSERT, UPDATE,
 * DELETE or TRUNCATE anywhere in the database (`0051`). There is no write
 * below, and a future one would be refused by the database before any reviewer
 * saw it. That is what makes "reconciliation never corrects" (§18) an enforced
 * property rather than a promise.
 *
 * THE SCOPE IS REAL. Each check runs inside a transaction scoped to one
 * business with row level security ACTIVE — `withReconcilerBusinessTransaction`,
 * no bypass — and each statement ALSO names `business_id` explicitly. Two
 * independent mechanisms, for the usual reason: the day one is misconfigured
 * is the day the other still holds. The enumeration does not lift the scope
 * either: it is a narrow SECURITY DEFINER routine that returns two identifier
 * columns, not a query tunnel.
 *
 * NOTHING RETURNS MONEY. Every statement below projects identifiers. The
 * comparisons happen inside PostgreSQL and what crosses back is `id` — never
 * a sum, a delta, a rate or a balance. A caller that wanted to log the result
 * could not leak a number it was never given (§22).
 *
 * A CHECK THAT CANNOT RUN SAYS SO. The grants in `0051` are deliberately the
 * exact set the nine checks read and nothing more, so a tenth check, or a
 * deployment whose migration did not reach `0051`, finds a table it may not
 * read. Those raise `ReconciliationUnavailableError` rather than returning an
 * empty finding, because an empty finding is indistinguishable from a clean
 * book and that is the single most dangerous lie a reconciliation pass can
 * tell (§16).
 */
/**
 * How a reconciliation pass reaches the database.
 *
 * It is a port rather than a direct dependency on `Database` for one reason
 * that matters: the §23 planted-discrepancy suite must run these EXACT
 * statements against a throwaway database whose constraints the schema owner
 * has dropped. Without a seam there, the tests would have to re-implement the
 * SQL, and a test that re-implements the thing under test proves only that
 * the test agrees with itself.
 */
export interface ReconciliationConnection {
  /** Run something with no business scope — used to ask what this credential may do. */
  unscoped<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
  /** Run something scoped to one business, with row level security active. */
  scoped<T>(tenantId: string, businessId: string, fn: (c: PoolClient) => Promise<T>): Promise<T>;
}

export const RECONCILIATION_CONNECTION = 'RECONCILIATION_CONNECTION';

/** The `0051` enumerator, named by signature so the privilege question is exact. */
const ENUMERATOR = 'accounting_reconcile_businesses(uuid, uuid, integer)';
/** One page of businesses. The enumerator clamps this to its own maximum. */
const ENUMERATION_PAGE_SIZE = 200;
/** A hard bound on the walk — see `targets()`. */
const MAX_ENUMERATION_PAGES = 10_000;

/**
 * A per-check bound, in milliseconds (§25).
 *
 * A reconciliation pass visits every business in the installation, so one
 * business whose journal has grown pathological must not be able to hold the
 * whole cycle open indefinitely. `statement_timeout` is set TRANSACTION-LOCAL
 * on each check, which means the bound is enforced by PostgreSQL rather than
 * by a caller that might forget to apply it, and it ends with the transaction
 * rather than leaking onto the pooled connection.
 *
 * A check that exceeds it does NOT become a skipped check. It raises, the
 * driver records that business and check as `error`, and a run with any error
 * is not a successful cycle — so the bound can cost a verdict, and can never
 * buy a false clean one.
 */
export const RECONCILIATION_CHECK_TIMEOUT_MS = 120_000;

/**
 * The production connection: the reconciler pool, read-only by grant (§30).
 *
 * Deliberately NOT the worker pool. `daftar_worker` carries the outbox relay,
 * credential delivery, the credential key ring and the SMTP authority, and
 * DAFTAR's answer to "which credential reconciles the books" is that delivery
 * authority is not financial authority. The worker is left exactly as it was,
 * and `0051` asserts that it was (§15).
 */
@Injectable()
export class ReconcilerConnection implements ReconciliationConnection {
  constructor(@Inject(Database) private readonly db: Database) {}
  unscoped<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withReconcilerTransaction(fn);
  }
  scoped<T>(tenantId: string, businessId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withReconcilerBusinessTransaction(tenantId, businessId, fn);
  }
}

@Injectable()
export class DatabaseAccountingReconciliationReader implements AccountingReconciliationReader {
  private readable: Set<string> | null = null;

  constructor(
    @Inject(RECONCILIATION_CONNECTION) private readonly connection: ReconciliationConnection,
    private readonly timeoutMs: number = RECONCILIATION_CHECK_TIMEOUT_MS,
  ) {}

  /**
   * Which tables this credential may read, asked once per process.
   *
   * The question is asked of the live catalogue rather than of the migration
   * text, because it is the same question PostgreSQL will ask when the
   * statement runs: it reflects the grants in force on this deployment.
   *
   * It is asked COLUMN-wise on purpose. `0051` grants the reconciler named
   * columns, not whole tables, and `has_table_privilege` answers FALSE for a
   * column-level grant — a reader that asked it would declare every check
   * unavailable on a correctly migrated database. `has_any_column_privilege`
   * answers the question the grants actually express. It is the weaker
   * question, so the checks below still name their columns explicitly and a
   * column this file reads without a grant fails at the statement, which is
   * reported as an error rather than as a clean result.
   */
  private async readableTables(client: PoolClient): Promise<Set<string>> {
    if (this.readable) return this.readable;
    const names = [...new Set(RECONCILIATION_CHECKS.flatMap((c) => c.requires))];
    const { rows } = await client.query<{ name: string; allowed: boolean }>(
      `SELECT t.name, has_any_column_privilege(current_user, t.name, 'SELECT') AS allowed
         FROM unnest($1::text[]) AS t(name)`,
      [names],
    );
    this.readable = new Set(rows.filter((r) => r.allowed).map((r) => r.name));
    return this.readable;
  }

  /**
   * The businesses to check — or a refusal to guess.
   *
   * `businesses` is tenant-scoped by row level security, and since `0032` the
   * ONLY principal row level security exempts is `daftar_platform`:
   * `app_bypass()` is `current_user = 'daftar_platform'`, so the GUC a caller
   * could once set reads nothing. `daftar_reconciler` is not that principal
   * and must never become it (§4), so it cannot reach the list by reading the
   * table: an unscoped `SELECT ... FROM businesses` here returns zero rows,
   * which is indistinguishable from an installation with no businesses.
   *
   * So the list comes from `accounting_reconcile_businesses` (`0051`) — a
   * SECURITY DEFINER routine owned by the NOLOGIN `daftar_accounting_internal`
   * principal that returns `tenant_id` and `business_id` and nothing else. Not
   * a name, not a slug, not an owner, not an email (§10). It takes no filter
   * and no expression, so it is a list, not a query tunnel.
   *
   * KEYSET, NOT OFFSET (§24). The routine takes the last `(tenant_id,
   * business_id)` seen and returns the next page after it, ordered by that
   * same pair. An OFFSET walk re-reads and re-sorts everything before the
   * page, which turns an installation with many businesses into a quadratic
   * scan, and — worse for this use — silently skips a row when the set shifts
   * between pages. A reconciliation pass that skips a business reports a clean
   * system it never looked at.
   *
   * A CREDENTIAL THAT CANNOT ENUMERATE SAYS SO. When the routine is not
   * executable — a deployment that has not reached `0051`, or a process wired
   * to some other credential — this raises instead of returning the empty
   * list. That is the difference between "we checked and found nothing" and
   * "we never looked", and a reconciliation pass that cannot tell them apart
   * is worse than no pass at all (§16, §17).
   */
  async targets(): Promise<readonly ReconciliationTarget[]> {
    return this.connection.unscoped(async (c): Promise<readonly ReconciliationTarget[]> => {
      const { rows: probe } = await c.query<{ ok: boolean; principal: string }>(
        `SELECT has_function_privilege(current_user, $1, 'EXECUTE') AS ok, current_user AS principal`,
        [ENUMERATOR],
      );
      const row = probe[0];
      if (!row?.ok) {
        throw new ReconciliationEnumerationError(
          `${row?.principal ?? 'this principal'} may not execute ${ENUMERATOR}, so it cannot list the businesses to reconcile`,
        );
      }
      const targets: ReconciliationTarget[] = [];
      let afterTenant: string | null = null;
      let afterBusiness: string | null = null;
      // A bound on the walk as well as on the page. The enumerator caps its own
      // page size, so a set that kept growing under us would loop forever
      // otherwise, and a reconciliation pass that never ends is a pass that
      // never reports.
      for (let page = 0; page < MAX_ENUMERATION_PAGES; page += 1) {
        const params: (string | number | null)[] = [afterTenant, afterBusiness, ENUMERATION_PAGE_SIZE];
        const result = await c.query<{ tenant_id: string; business_id: string }>(
          `SELECT tenant_id, business_id FROM accounting_reconcile_businesses($1::uuid, $2::uuid, $3::int)`,
          params,
        );
        const rows = result.rows;
        for (const r of rows) targets.push({ tenantId: r.tenant_id, businessId: r.business_id });
        if (rows.length < ENUMERATION_PAGE_SIZE) return targets;
        const last = rows[rows.length - 1];
        if (!last) return targets;
        afterTenant = last.tenant_id;
        afterBusiness = last.business_id;
      }
      throw new ReconciliationEnumerationError(`business enumeration did not terminate within ${MAX_ENUMERATION_PAGES} pages of ${ENUMERATION_PAGE_SIZE}`);
    });
  }

  async check(target: ReconciliationTarget, checkId: ReconciliationCheckId): Promise<ReconciliationFinding> {
    return this.connection.scoped(target.tenantId, target.businessId, async (c) => {
      const definition = RECONCILIATION_CHECKS.find((d) => d.id === checkId);
      if (!definition) throw new Error(`unknown reconciliation check ${checkId}`);
      // §25. Transaction-local, so it binds this check and nothing after it.
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(this.timeoutMs))}`);
      const readable = await this.readableTables(c);
      const missing = definition.requires.filter((t) => !readable.has(t));
      if (missing.length > 0) throw new ReconciliationUnavailableError(checkId, missing);
      return runReconciliationCheck(c, target.businessId, checkId);
    });
  }
}

/**
 * Run one offending-object query and return its count and a sample.
 *
 * The count is the TRUE total and the ids are the first few, because the two
 * answer different questions: "how bad is it" must not be bounded by "how
 * much evidence fits in an alert". They are derived from one CTE in one
 * statement so they can never describe two different moments.
 */
async function countAndSample(c: PoolClient, offending: string, params: unknown[]): Promise<ReconciliationFinding> {
  const { rows } = await c.query<{ total: string; ids: string[] | null }>(
    `WITH offending AS (${offending})
       SELECT (SELECT count(*) FROM offending)::text AS total,
              (SELECT array_agg(s.id ORDER BY s.id) FROM (SELECT id FROM offending ORDER BY id LIMIT 20) s) AS ids`,
    params,
  );
  const row = rows[0];
  return { offendingCount: Number(row?.total ?? '0'), offendingIds: row?.ids ?? [] };
}

/**
 * The nine statements, as one function.
 *
 * It is exported because the planted-discrepancy tests (§23) must run these
 * EXACT statements against a throwaway database where the constraints have
 * been dropped by the schema owner. A test that re-implemented the SQL would
 * prove that the test's SQL detects corruption, which is not the claim.
 */
export function runReconciliationCheck(c: PoolClient, businessId: string, checkId: ReconciliationCheckId): Promise<ReconciliationFinding> {
  switch (checkId) {
    // ── R-ACC-01 ────────────────────────────────────────────────────────
    // An entry is balanced when its base debit total equals its base credit
    // total. Two degenerate shapes are counted as unbalanced rather than
    // quietly passing: an entry with NO lines sums 0 against 0, and a
    // single-line entry cannot be double entry at all. The LEFT JOIN is
    // what makes the empty entry visible to the GROUP BY.
    case 'R-ACC-01':
      return countAndSample(
        c,
        `SELECT e.id
             FROM journal_entries e
             LEFT JOIN journal_lines l ON l.business_id = e.business_id AND l.journal_entry_id = e.id
            WHERE e.business_id = $1
            GROUP BY e.id
           HAVING count(l.id) < 2
               OR coalesce(sum(CASE WHEN l.debit_minor  > 0 THEN l.base_amount_minor ELSE 0 END), 0)
               <> coalesce(sum(CASE WHEN l.credit_minor > 0 THEN l.base_amount_minor ELSE 0 END), 0)`,
        [businessId],
      );

    // ── R-ACC-02 ────────────────────────────────────────────────────────
    // The whole business, not entry by entry. R-ACC-01 can pass on every
    // entry while the ledger as a whole is wrong if a line was added or
    // removed outside an entry, so this sums the lines directly and the
    // offending object is the business itself.
    case 'R-ACC-02':
      return countAndSample(
        c,
        `SELECT l.business_id AS id
             FROM journal_lines l
            WHERE l.business_id = $1
            GROUP BY l.business_id
           HAVING sum(CASE WHEN l.debit_minor  > 0 THEN l.base_amount_minor ELSE 0 END)
               <> sum(CASE WHEN l.credit_minor > 0 THEN l.base_amount_minor ELSE 0 END)`,
        [businessId],
      );

    // ── R-ACC-03 ────────────────────────────────────────────────────────
    // The accounting identity, derived from the chart rather than assumed:
    // assets + expenses (debit-natured) must equal liabilities + equity +
    // revenue (credit-natured). It is NOT a restatement of R-ACC-02 — a
    // ledger that balances line for line still fails this one if a line
    // was posted to an account of the wrong type.
    case 'R-ACC-03':
      return countAndSample(
        c,
        `SELECT l.business_id AS id
             FROM journal_lines l
             JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
            WHERE l.business_id = $1
            GROUP BY l.business_id
           HAVING sum(CASE WHEN a.type IN ('asset', 'expense')
                           THEN (CASE WHEN l.debit_minor  > 0 THEN l.base_amount_minor ELSE -l.base_amount_minor END)
                           ELSE 0 END)
               <> sum(CASE WHEN a.type IN ('liability', 'equity', 'revenue')
                           THEN (CASE WHEN l.credit_minor > 0 THEN l.base_amount_minor ELSE -l.base_amount_minor END)
                           ELSE 0 END)`,
        [businessId],
      );

    // ── R-ACC-04 ────────────────────────────────────────────────────────
    // Structural belonging. A line must name an entry that exists, an
    // account that exists, and both must agree with the line about which
    // tenant owns them. Composite foreign keys make all of this impossible
    // through ordinary SQL, which is exactly why it is worth checking: if
    // it ever fires, something reached past the constraints.
    case 'R-ACC-04':
      return countAndSample(
        c,
        `SELECT l.id
             FROM journal_lines l
             LEFT JOIN journal_entries e ON e.business_id = l.business_id AND e.id = l.journal_entry_id
             LEFT JOIN accounts a        ON a.business_id = l.business_id AND a.id = l.account_id
            WHERE l.business_id = $1
              AND (e.id IS NULL OR a.id IS NULL OR e.tenant_id <> l.tenant_id OR a.tenant_id <> l.tenant_id)`,
        [businessId],
      );

    // ── R-ACC-05 ────────────────────────────────────────────────────────
    // Posting into closed books, stated about the POSTING and not about
    // the date. An entry DATED inside a period that is closed today is the
    // normal case — that is what closing a period means — so a check that
    // flagged it would flag every honest business. What is never legal is
    // an entry that was CREATED after the books covering its date were
    // closed, and that is the predicate below.
    //
    // Its limit is stated rather than hidden. `accounting_periods` keeps
    // only the LATEST close, so an entry written during an earlier closed
    // window that was later reopened and closed again is indistinguishable
    // here from a legitimate one. The full history lives in the append-only
    // `accounting_period_operations` registry, which no runtime credential
    // may read. The consequence is one-directional and safe: this check can
    // miss such a case, and can never invent one.
    case 'R-ACC-05':
      return countAndSample(
        c,
        `SELECT e.id
             FROM journal_entries e
             JOIN accounting_periods p
               ON p.business_id = e.business_id
              AND e.entry_date BETWEEN p.start_date AND p.end_date
            WHERE e.business_id = $1
              AND p.status = 'closed'
              AND p.closed_at IS NOT NULL
              AND e.created_at > p.closed_at`,
        [businessId],
      );

    // ── R-ACC-06 ────────────────────────────────────────────────────────
    // Every posted source type must be one the system knows.
    //
    // The database guarantees its own half independently: `source_type` is
    // a foreign key into `accounting_source_types`, so a posted type that
    // is not registered cannot exist. No runtime credential may read that
    // registry, so what this check proves is the OTHER half, and the one
    // that can actually drift — that the journal holds no source type the
    // running application no longer recognises. A type deleted from the
    // code while history still carries it is found here.
    case 'R-ACC-06':
      return countAndSample(
        c,
        `SELECT e.id
             FROM journal_entries e
            WHERE e.business_id = $1
              AND e.source_type <> ALL ($2::text[])`,
        [businessId, [...NATIVE_SOURCE_TYPES]],
      );

    // ── R-ACC-07 ────────────────────────────────────────────────────────
    // The FX snapshot a line was posted with must be complete and internally
    // consistent: a domestic line carries the explicit 'base' sentinel at
    // rate 1 with equal amounts, a foreign line names a real rate source at
    // a positive rate, and every line's base currency is still the
    // business's base currency. No rate is looked up — a rate entered today
    // must never change what yesterday's line says about itself.
    case 'R-ACC-07':
      return countAndSample(
        c,
        `SELECT l.id
             FROM journal_lines l
             JOIN businesses b ON b.id = l.business_id
            WHERE l.business_id = $1
              AND (
                l.base_currency <> b.base_currency
                OR (l.txn_currency = l.base_currency
                    AND (l.fx_rate <> 1 OR l.fx_rate_source <> 'base' OR l.txn_amount_minor <> l.base_amount_minor))
                OR (l.txn_currency <> l.base_currency
                    AND (l.fx_rate_source NOT IN ('manual', 'provider') OR l.fx_rate <= 0))
              )`,
        [businessId],
      );

    // ── R-ACC-08 ────────────────────────────────────────────────────────
    // The binding is bidirectional, so it is checked in both directions:
    // an entry whose source identity registers no binding, or registers one
    // that names a different entry; and a binding that names an entry which
    // does not exist. Either direction alone would miss half the ways the
    // registry and the journal can disagree.
    case 'R-ACC-08':
      return countAndSample(
        c,
        `SELECT e.id
             FROM journal_entries e
             LEFT JOIN accounting_source_bindings b
               ON b.business_id = e.business_id AND b.source_type = e.source_type AND b.source_id = e.source_id
            WHERE e.business_id = $1
              AND (b.journal_entry_id IS NULL OR b.journal_entry_id <> e.id)
            UNION
           SELECT b.journal_entry_id AS id
             FROM accounting_source_bindings b
             LEFT JOIN journal_entries e ON e.business_id = b.business_id AND e.id = b.journal_entry_id
            WHERE b.business_id = $1
              AND e.id IS NULL`,
        [businessId],
      );

    // ── R-ACC-09 ────────────────────────────────────────────────────────
    // The P2-S3 invariant, both ways. A business with journal history must
    // have `financial_started_at` set, and a business with none must not:
    // the flag locks the base currency, so setting it early would freeze a
    // currency the merchant never used, and setting it late would leave a
    // posted history whose currency could still be changed underneath it.
    case 'R-ACC-09':
      return countAndSample(
        c,
        `SELECT b.id
             FROM businesses b
            WHERE b.id = $1
              AND (EXISTS (SELECT 1 FROM journal_entries e WHERE e.business_id = b.id)) <> (b.financial_started_at IS NOT NULL)`,
        [businessId],
      );
  }
}
