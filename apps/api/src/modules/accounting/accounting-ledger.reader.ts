import { Inject, Injectable } from '@nestjs/common';
import type { AccountingLedgerReader, LedgerReadScope, PostedEntrySnapshot, PostedLineSnapshot } from '@daftar/accounting';
import { Database } from '../../infra/database';

interface EntryRow {
  id: string;
  tenant_id: string;
  business_id: string;
  source_type: string;
  entry_date: string;
}

interface LineRow {
  line_no: number;
  system_key: string | null;
  code: string;
  debit_minor: string;
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

/**
 * The read side of the ledger (§12, §29).
 *
 * A reversal is derived from the entry it reverses, so something has to read
 * that entry. This does, as `daftar_app`, under the ordinary tenant/business
 * row level security — the same isolation every other merchant read runs
 * under, not a privileged one. It holds no write path of any kind: `daftar_app`
 * has SELECT on the journal and nothing else, so even a bug here could not
 * become a write.
 *
 * Money arrives as decimal STRINGS from PostgreSQL (`bigint` and `numeric`
 * are never parsed to a JavaScript number by the driver) and is converted to
 * `bigint` here. That is the one place this class has to be careful, and it is
 * careful in the only direction that is safe.
 */
@Injectable()
export class DatabaseAccountingLedgerReader implements AccountingLedgerReader {
  constructor(@Inject(Database) private readonly db: Database) {}

  async readEntry(scope: LedgerReadScope, entryId: string): Promise<PostedEntrySnapshot | null> {
    return this.db.withTransaction({ tenantId: scope.tenantId, businessId: scope.businessId }, async (c) => {
      // Composite identity: (business_id, id). An entry of another business is
      // not found rather than forbidden, so the answer leaks nothing about
      // whether it exists elsewhere (§20).
      const entry = await c.query<EntryRow>(
        `SELECT je.id, je.tenant_id, je.business_id, je.source_type, to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date
           FROM journal_entries je
          WHERE je.business_id = $1 AND je.id = $2`,
        [scope.businessId, entryId],
      );
      const head = entry.rows[0];
      if (!head) return null;

      const lines = await c.query<LineRow>(
        `SELECT l.line_no, a.system_key, a.code, l.debit_minor::text AS debit_minor,
                l.base_amount_minor::text AS base_amount_minor, l.base_currency,
                l.txn_amount_minor::text AS txn_amount_minor, l.txn_currency,
                l.fx_rate::text AS fx_rate, l.fx_rate_source, l.fx_rate_at,
                l.branch_id, l.warehouse_id, l.memo
           FROM journal_lines l
           JOIN accounts a ON a.business_id = l.business_id AND a.id = l.account_id
          WHERE l.business_id = $1 AND l.journal_entry_id = $2
          ORDER BY l.line_no`,
        [scope.businessId, entryId],
      );

      const snapshot: PostedLineSnapshot[] = lines.rows.map((r) => ({
        lineNo: r.line_no,
        // The engine identity of an account is its system key when it has one,
        // and its chart code otherwise — never its UUID and never its display
        // name (§23, AL-07).
        account: r.system_key !== null ? { kind: 'system', systemKey: r.system_key } : { kind: 'code', code: r.code },
        side: BigInt(r.debit_minor) > 0n ? 'D' : 'C',
        baseAmountMinor: BigInt(r.base_amount_minor),
        baseCurrency: r.base_currency,
        txnAmountMinor: BigInt(r.txn_amount_minor),
        txnCurrency: r.txn_currency,
        fxRate: r.fx_rate,
        fxRateSource: r.fx_rate_source,
        fxRateAt: r.fx_rate_at,
        branchId: r.branch_id,
        warehouseId: r.warehouse_id,
        memo: r.memo,
      }));

      return {
        entryId: head.id,
        tenantId: head.tenant_id,
        businessId: head.business_id,
        sourceType: head.source_type,
        entryDate: head.entry_date,
        lines: snapshot,
      };
    });
  }

  async readBusinessBaseCurrency(scope: LedgerReadScope): Promise<string | null> {
    const { rows } = await this.db.scoped<{ base_currency: string }>(
      { tenantId: scope.tenantId, businessId: scope.businessId },
      `SELECT b.base_currency FROM businesses b WHERE b.id = $1`,
      [scope.businessId],
    );
    return rows[0]?.base_currency ?? null;
  }
}
