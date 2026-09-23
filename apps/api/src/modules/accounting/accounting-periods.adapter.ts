import { Inject, Injectable } from '@nestjs/common';
import {
  AccountingError,
  parseDatabaseAccountingError,
  type AccountingPeriodPort,
  type AccountingPeriodSnapshot,
  type AccountingPeriodStatus,
  type LedgerReadScope,
  type PeriodCloseCommand,
  type PeriodCommandRequest,
  type PeriodCommandResult,
  type PeriodCreateCommand,
  type PeriodReopenCommand,
} from '@daftar/accounting';
import { Database } from '../../infra/database';

/**
 * The transport adapter for accounting periods (§29-§32).
 *
 * Its entire authority is CALLING the three period commands and SELECTing the
 * periods back. It issues no INSERT, UPDATE or DELETE against
 * `accounting_periods` — and could not if it tried, because `daftar_app`
 * holds only SELECT on that table and nothing at all on the operation
 * registry. Guard G-4's application-code half fails CI if such a statement
 * ever appears here.
 *
 * Every refusal the database raises carries a stable `accounting.*` code.
 * Anything else is an infrastructure failure and is left to propagate
 * untouched rather than dressed up as a financial refusal.
 */
@Injectable()
export class DatabaseAccountingPeriodsAdapter implements AccountingPeriodPort {
  constructor(@Inject(Database) private readonly db: Database) {}

  async createPeriod(request: PeriodCommandRequest<PeriodCreateCommand>): Promise<PeriodCommandResult> {
    const { assertion, command } = request;
    return this.run({ businessId: command.businessId, periodId: command.periodId }, () =>
      // The CONTROL assertion travels in its own GUC. A transaction that set
      // only the posting one cannot reach this command at all.
      this.db.withAccountingControlTransaction(assertion, async (c) => {
        const r = await c.query<{ period_id: string; created: boolean }>(
          `SELECT period_id, created FROM accounting_period_create($1::uuid, $2::date, $3::date, $4)`,
          [command.operationId, command.startDate, command.endDate, command.requestId ?? null],
        );
        const row = r.rows[0];
        if (!row) throw new Error('the period create command returned no row');
        return { periodId: row.period_id, changed: row.created };
      }),
    );
  }

  async closePeriod(request: PeriodCommandRequest<PeriodCloseCommand>): Promise<PeriodCommandResult> {
    const { assertion, command } = request;
    return this.run({ businessId: command.businessId, periodId: command.periodId }, () =>
      this.db.withAccountingControlTransaction(assertion, async (c) => {
        const r = await c.query<{ period_id: string; changed: boolean }>(`SELECT period_id, changed FROM accounting_period_close($1::uuid, $2)`, [
          command.operationId,
          command.requestId ?? null,
        ]);
        const row = r.rows[0];
        if (!row) throw new Error('the period close command returned no row');
        return { periodId: row.period_id, changed: row.changed };
      }),
    );
  }

  async reopenPeriod(request: PeriodCommandRequest<PeriodReopenCommand>): Promise<PeriodCommandResult> {
    const { assertion, command } = request;
    return this.run({ businessId: command.businessId, periodId: command.periodId }, () =>
      this.db.withAccountingControlTransaction(assertion, async (c) => {
        const r = await c.query<{ period_id: string; changed: boolean }>(`SELECT period_id, changed FROM accounting_period_reopen($1::uuid, $2, $3)`, [
          command.operationId,
          // The reason the service already normalized. The database
          // normalizes again and fingerprints the result, so a transport that
          // reshaped it would be caught rather than silently stored.
          command.reason,
          command.requestId ?? null,
        ]);
        const row = r.rows[0];
        if (!row) throw new Error('the period reopen command returned no row');
        return { periodId: row.period_id, changed: row.changed };
      }),
    );
  }

  /**
   * The merchant read (§32), run as the merchant runtime so row level
   * security — not this method's predicate — is what keeps one business out
   * of another's periods.
   *
   * It selects named columns rather than `*`: the table carries the internal
   * actor ids and the free-text reopen reason, and a `SELECT *` would put
   * both on the wire the day somebody added a field.
   */
  async listPeriods(scope: LedgerReadScope): Promise<readonly AccountingPeriodSnapshot[]> {
    try {
      const r = await this.db.withTransaction({ tenantId: scope.tenantId, businessId: scope.businessId }, (c) =>
        c.query<{ id: string; start_date: Date; end_date: Date; status: string; closed_at: Date | null; last_reopened_at: Date | null }>(
          `SELECT id, start_date, end_date, status, closed_at, last_reopened_at
             FROM accounting_periods
            WHERE business_id = $1::uuid
            ORDER BY start_date`,
          [scope.businessId],
        ),
      );
      return r.rows.map((row) => ({
        periodId: row.id,
        startDate: civilDate(row.start_date),
        endDate: civilDate(row.end_date),
        status: row.status as AccountingPeriodStatus,
        closedAt: row.closed_at === null ? null : instant(row.closed_at),
        lastReopenedAt: row.last_reopened_at === null ? null : instant(row.last_reopened_at),
      }));
    } catch (e) {
      const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
      if (code === null) throw e;
      throw new AccountingError(code, 'the accounting authority refused this period read', { businessId: scope.businessId });
    }
  }

  private async run(context: { businessId: string; periodId: string }, fn: () => Promise<PeriodCommandResult>): Promise<PeriodCommandResult> {
    try {
      return await fn();
    } catch (e) {
      const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
      if (code === null) throw e;
      throw new AccountingError(code, 'the command was refused by the accounting authority', context);
    }
  }
}

/**
 * A DATE column as `YYYY-MM-DD`.
 *
 * `node-postgres` parses a DATE into a JavaScript `Date` at LOCAL midnight,
 * so `toISOString()` on a server east of UTC would move a period boundary to
 * the previous day. The civil parts are read directly instead — a period
 * boundary is a civil date and has no time zone at all.
 */
function civilDate(value: Date): string {
  const y = value.getFullYear();
  const m = `${value.getMonth() + 1}`.padStart(2, '0');
  const d = `${value.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** A TIMESTAMPTZ as RFC3339 UTC at second precision. */
function instant(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`;
}
