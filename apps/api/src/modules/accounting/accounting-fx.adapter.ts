import { Inject, Injectable } from '@nestjs/common';
import {
  AccountingError,
  parseDatabaseAccountingError,
  type AccountingFxRatePort,
  type EnterFxRateRequest,
  type FxRateEntryResult,
  type FxRateSnapshot,
  type LedgerReadScope,
} from '@daftar/accounting';
import { Database } from '../../infra/database';

/**
 * The transport adapter for the FX rate registry (§26, §44).
 *
 * Its entire authority is CALLING the two FX routines. It issues no INSERT,
 * UPDATE or DELETE against `accounting_fx_rates` — and could not if it tried,
 * because `daftar_app` holds only SELECT on that table. Guard G-4's
 * application-code half fails CI if such a statement ever appears here.
 *
 * Every refusal the database raises carries a stable `accounting.*` code.
 * Anything else is an infrastructure failure and is left to propagate
 * untouched rather than dressed up as a financial refusal.
 */
@Injectable()
export class DatabaseAccountingFxAdapter implements AccountingFxRatePort {
  constructor(@Inject(Database) private readonly db: Database) {}

  async enterRate(request: EnterFxRateRequest): Promise<FxRateEntryResult> {
    const { assertion, command } = request;
    return this.run({ businessId: command.businessId, rateId: command.rateId }, () =>
      // The CONTROL assertion travels in its own GUC. A transaction that set
      // only the posting one cannot reach this command at all.
      this.db.withAccountingControlTransaction(assertion, async (c) => {
        const r = await c.query<{ rate_id: string; created: boolean }>(
          `SELECT rate_id, created FROM accounting_fx_rate_enter($1, $2, $3, $4::timestamptz, $5)`,
          [
            command.fromCurrency,
            command.toCurrency,
            // A STRING all the way to the database. §15 refuses an
            // out-of-contract precision rather than rounding it, and that
            // decision can only be made before the numeric cast.
            command.rate,
            `${command.effectiveAt.toISOString().slice(0, 19)}Z`,
            command.requestId ?? null,
          ],
        );
        const row = r.rows[0];
        if (!row) throw new Error('the FX rate command returned no row');
        return { rateId: row.rate_id, created: row.created };
      }),
    );
  }

  /**
   * The deterministic read, run as the merchant runtime so row level security
   * — not this method's predicate — is what keeps one business out of
   * another's rates (§21).
   */
  async lookupRate(scope: LedgerReadScope, pair: { from: string; to: string }, at: Date): Promise<FxRateSnapshot> {
    return this.runLookup({ businessId: scope.businessId, currencyPair: `${pair.from}->${pair.to}` }, async () => {
      const r = await this.db.withTransaction({ tenantId: scope.tenantId, businessId: scope.businessId }, (c) =>
        c.query<{ rate_id: string; rate: string; source: string; effective_at: Date }>(
          `SELECT rate_id, rate, source, effective_at FROM accounting_fx_rate_lookup($1::uuid, $2, $3, $4::timestamptz)`,
          [scope.businessId, pair.from, pair.to, `${at.toISOString().slice(0, 19)}Z`],
        ),
      );
      const row = r.rows[0];
      if (!row) throw new Error('the FX rate lookup returned no row');
      return { rateId: row.rate_id, rate: row.rate, source: 'manual' as const, effectiveAt: row.effective_at };
    });
  }

  private async run(context: { businessId: string; rateId: string }, fn: () => Promise<FxRateEntryResult>): Promise<FxRateEntryResult> {
    try {
      return await fn();
    } catch (e) {
      const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
      if (code === null) throw e;
      throw new AccountingError(code, 'the command was refused by the accounting authority', context);
    }
  }

  private async runLookup(context: { businessId: string; currencyPair: string }, fn: () => Promise<FxRateSnapshot>): Promise<FxRateSnapshot> {
    try {
      return await fn();
    } catch (e) {
      const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
      if (code === null) throw e;
      throw new AccountingError(code, 'the accounting authority refused this rate lookup', context);
    }
  }
}
