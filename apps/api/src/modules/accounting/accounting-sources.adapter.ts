import { Inject, Injectable } from '@nestjs/common';
import {
  AccountingError,
  parseDatabaseAccountingError,
  type AccountingAdjustmentPort,
  type AccountingOpeningBalancePort,
  type AccountingPostingTransaction,
  type AccountingReversalPort,
  type AccountingSourcesTransactionPort,
  type PostAdjustmentInTransactionRequest,
  type PostAdjustmentRequest,
  type PostOpeningBalanceInTransactionRequest,
  type PostOpeningBalanceRequest,
  type PostReversalInTransactionRequest,
  type PostReversalRequest,
  type PostingResult,
} from '@daftar/accounting';
import { Database } from '../../infra/database';
import { serializeOpeningPositions, serializePostingLines } from './accounting-payload';

/**
 * The transport adapter for the three Phase-2-native sources (§11, §67).
 *
 * Its entire authority is CALLING the source commands. It issues no INSERT,
 * UPDATE or DELETE against `journal_entries`, `journal_lines`,
 * `accounting_source_bindings`, `accounting_reversals`,
 * `accounting_manual_adjustments`, `accounting_opening_balances` or
 * `accounting_opening_balance_lines` — and could not if it tried, because
 * `daftar_app` holds no DML on any of them. Guard G-4 fails CI if application
 * code ever grows such a statement.
 *
 * Every refusal the database raises carries a stable `accounting.*` code.
 * Anything else is an infrastructure failure and is left to propagate
 * untouched rather than dressed up as a financial refusal — a lost connection
 * is not the same event as a rejected posting, and a caller that could not
 * tell them apart would retry the wrong one.
 */
@Injectable()
export class DatabaseAccountingSourcesAdapter
  implements AccountingAdjustmentPort, AccountingReversalPort, AccountingOpeningBalancePort, AccountingSourcesTransactionPort
{
  constructor(@Inject(Database) private readonly db: Database) {}

  // ── the accepted single-operation methods ────────────────────────────────
  //
  // Each opens its own posting transaction with its own assertion and runs
  // the client-accepting variant below inside it (P3-AL-32 item 5): one code
  // path for Phase 2 and for the Phase 3 composition. The outer translation
  // is where a refusal raised at COMMIT — a completeness trigger — surfaces.

  async postAdjustment(request: PostAdjustmentRequest): Promise<PostingResult> {
    const { assertion, ...rest } = request;
    return this.run(adjustmentContext(rest), () => this.db.withAccountingTransaction(assertion, (tx) => this.postAdjustmentInTransaction(tx, rest)));
  }

  async postReversal(request: PostReversalRequest): Promise<PostingResult> {
    const { assertion, ...rest } = request;
    return this.run(reversalContext(rest), () => this.db.withAccountingTransaction(assertion, (tx) => this.postReversalInTransaction(tx, rest)));
  }

  async postOpeningBalance(request: PostOpeningBalanceRequest): Promise<PostingResult> {
    const { assertion, ...rest } = request;
    // ONE transaction. The draft is real — it exists as rows and the source
    // genuinely passes through `draft` — and if the posting fails for any
    // reason the draft goes with it, so no half-stated opening position can
    // ever survive a failure (§33, §44).
    return this.run(openingBalanceContext(rest), () => this.db.withAccountingTransaction(assertion, (tx) => this.postOpeningBalanceInTransaction(tx, rest)));
  }

  // ── the client-accepting variants (P3-AL-32 item 5) ──────────────────────
  //
  // Each runs inside a transaction that is already open and already carries
  // its accounting assertion — one a posting boundary issued. Anything else is
  // refused by `Database.postingTransactionSql` before a statement is sent.

  async postAdjustmentInTransaction(tx: AccountingPostingTransaction, request: PostAdjustmentInTransactionRequest): Promise<PostingResult> {
    const sql = this.db.postingTransactionSql(tx);
    const { command, reason } = request;
    const lines = serializePostingLines(command.lines);
    return this.run(adjustmentContext(request), async () => {
      const r = await sql.query<{ entry_id: string; created: boolean }>(
        `SELECT entry_id, created FROM accounting_post_manual_adjustment($1::date, $2, $3, $4, $5::jsonb)`,
        [command.entryDate, command.description ?? null, reason, command.requestId ?? null, JSON.stringify(lines)],
      );
      return rowOf(r.rows[0]);
    });
  }

  async postReversalInTransaction(tx: AccountingPostingTransaction, request: PostReversalInTransactionRequest): Promise<PostingResult> {
    const sql = this.db.postingTransactionSql(tx);
    // No lines cross this boundary. The database derives the mirror from the
    // persisted original and compares it with the signed fingerprint the
    // engine derived independently (§31).
    return this.run(reversalContext(request), async () => {
      const r = await sql.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_post_reversal($1::uuid, $2::date, $3, $4)`, [
        request.originalEntryId,
        request.entryDate,
        request.reason,
        request.requestId ?? null,
      ]);
      return rowOf(r.rows[0]);
    });
  }

  async postOpeningBalanceInTransaction(tx: AccountingPostingTransaction, request: PostOpeningBalanceInTransactionRequest): Promise<PostingResult> {
    const sql = this.db.postingTransactionSql(tx);
    const positions = serializeOpeningPositions([...request.positions]);
    return this.run(openingBalanceContext(request), async () => {
      await sql.query(`SELECT accounting_open_balance_draft($1::date, $2::jsonb)`, [request.asOfDate, JSON.stringify(positions)]);
      const r = await sql.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_open_balance_post($1::uuid, $2, $3)`, [
        request.openingBalanceId,
        request.description ?? null,
        request.requestId ?? null,
      ]);
      return rowOf(r.rows[0]);
    });
  }

  private async run(context: { businessId: string; sourceType: string; sourceId: string }, fn: () => Promise<PostingResult>): Promise<PostingResult> {
    try {
      return await fn();
    } catch (e) {
      const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
      if (code === null) throw e;
      throw new AccountingError(code, 'the command was refused by the accounting authority', context);
    }
  }
}

function adjustmentContext(request: PostAdjustmentInTransactionRequest): { businessId: string; sourceType: string; sourceId: string } {
  return { businessId: request.command.businessId, sourceType: 'manual_adjustment', sourceId: request.command.sourceId };
}

function reversalContext(request: PostReversalInTransactionRequest): { businessId: string; sourceType: string; sourceId: string } {
  return { businessId: request.businessId, sourceType: 'reversal', sourceId: request.originalEntryId };
}

function openingBalanceContext(request: PostOpeningBalanceInTransactionRequest): { businessId: string; sourceType: string; sourceId: string } {
  return { businessId: request.businessId, sourceType: 'opening_balance', sourceId: request.openingBalanceId };
}

function rowOf(row: { entry_id: string; created: boolean } | undefined): PostingResult {
  if (!row) throw new Error('an accounting source command returned no row');
  return { entryId: row.entry_id, created: row.created };
}
