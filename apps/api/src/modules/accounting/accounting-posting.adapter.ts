import { Inject, Injectable } from '@nestjs/common';
import {
  AccountingError,
  parseDatabaseAccountingError,
  type AccountingPostingPort,
  type AccountingPostingTransaction,
  type AccountingPostingTransactionPort,
  type PostEntryInTransactionRequest,
  type PostEntryRequest,
  type PostingCommand,
  type PostingResult,
} from '@daftar/accounting';
import { Database } from '../../infra/database';

/**
 * The transport adapter (§11, §67).
 *
 * Its entire authority is CALLING `accounting_post_entry`. It issues no
 * INSERT, UPDATE or DELETE against `journal_entries`, `journal_lines` or
 * `accounting_source_bindings` — and could not if it tried, because
 * `daftar_app` holds no DML on any of them. Guard G-4 fails CI if application
 * code ever grows such a statement.
 *
 * The payload is serialized the way the primitive's exact schema requires:
 * money and rates as decimal STRINGS. A JSON number would be a double by the
 * time PostgreSQL saw it, and a BIGINT's low digits or a rate's tenth decimal
 * would be gone with no error anywhere.
 *
 * The `JSON.stringify` below is the JSONB TRANSPORT and nothing else. It is
 * not the financial identity of the command: `acctfp/1` is a byte stream built
 * by `packages/accounting/src/fingerprint.ts`, and the database rebuilds the
 * same stream from the row it is about to write and compares the two. Key
 * order, escaping and whitespace in this payload therefore change nothing.
 */
@Injectable()
export class DatabaseAccountingPostingAdapter implements AccountingPostingPort, AccountingPostingTransactionPort {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * The accepted Phase 2 single-operation method: its own transaction, its
   * own assertion. Implemented in terms of `postEntryInTransaction` (P3-AL-32
   * item 5), so the Phase 2 path and the Phase 3 composition execute the same
   * code; a refusal raised at COMMIT is translated here, where the COMMIT is.
   */
  async postEntry(request: PostEntryRequest): Promise<PostingResult> {
    const { assertion, command } = request;
    return refusedAs(command, () => this.db.withAccountingTransaction(assertion, (tx) => this.postEntryInTransaction(tx, { command })));
  }

  /**
   * Call `accounting_post_entry` inside a transaction that is already open and
   * already carries its accounting assertion — the one a posting boundary
   * issued. Anything else is refused by `Database.postingTransactionSql`
   * before a statement is sent.
   */
  async postEntryInTransaction(tx: AccountingPostingTransaction, request: PostEntryInTransactionRequest): Promise<PostingResult> {
    const sql = this.db.postingTransactionSql(tx);
    const { command } = request;
    const lines = command.lines.map((l) => ({
      account: l.account.kind === 'system' ? { kind: 'system', system_key: l.account.systemKey } : { kind: 'code', code: l.account.code },
      side: l.side,
      base_amount_minor: l.baseAmountMinor.toString(10),
      base_currency: l.baseCurrency.toUpperCase(),
      txn_amount_minor: l.txnAmountMinor.toString(10),
      txn_currency: l.txnCurrency.toUpperCase(),
      fx_rate: canonicalRateText(l.fxRate),
      fx_rate_source: l.fxRateSource,
      fx_rate_at: `${l.fxRateAt.toISOString().slice(0, 19)}Z`,
      branch_id: l.branchId,
      warehouse_id: l.warehouseId,
      memo: l.memo ?? null,
    }));

    return refusedAs(command, async () => {
      const r = await sql.query<{ entry_id: string; created: boolean }>(`SELECT entry_id, created FROM accounting_post_entry($1::date, $2, $3, $4::jsonb)`, [
        command.entryDate,
        command.description ?? null,
        command.requestId ?? null,
        JSON.stringify(lines),
      ]);
      const row = r.rows[0];
      if (!row) throw new Error('accounting_post_entry returned no row');
      return { entryId: row.entry_id, created: row.created };
    });
  }
}

/**
 * A database refusal carries a stable `accounting.*` code; anything else is an
 * infrastructure failure and is left to propagate untouched rather than
 * dressed up as a financial refusal. An error that is already an
 * `AccountingError` carries no such prefix and passes through unchanged.
 */
async function refusedAs(command: PostingCommand, fn: () => Promise<PostingResult>): Promise<PostingResult> {
  try {
    return await fn();
  } catch (e) {
    const code = parseDatabaseAccountingError(e instanceof Error ? e.message : String(e));
    if (code === null) throw e;
    throw new AccountingError(code, 'the posting was refused by the accounting authority', {
      businessId: command.businessId,
      sourceType: command.sourceType,
      sourceId: command.sourceId,
    });
  }
}

/** Exactly ten fraction digits, matching NUMERIC(20,10) and the canonical form. */
function canonicalRateText(rate: string): string {
  const m = /^(\d+)(?:\.(\d{1,10}))?$/.exec(rate.trim());
  if (!m) throw new Error('an fx rate must be a decimal with at most ten fraction digits');
  return `${(m[1] ?? '0').replace(/^0+(?=\d)/, '')}.${(m[2] ?? '').padEnd(10, '0')}`;
}
