import type { PostingLineCommand } from '@daftar/accounting';

/**
 * The JSONB transport shape the database primitives require (§36, §68).
 *
 * Money and rates travel as decimal STRINGS. A JSON number would be a double
 * by the time PostgreSQL saw it, and a BIGINT's low digits or a rate's tenth
 * decimal would be gone with no error anywhere — the single most dangerous
 * kind of silence a ledger can have.
 *
 * This is TRANSPORT and nothing else. It is not the financial identity of a
 * command: `acctfp/1` is a byte stream built by the accounting package, and
 * the database rebuilds the same stream from the rows it is about to write.
 * Key order, escaping and whitespace here therefore change nothing.
 */
export function serializePostingLines(lines: readonly PostingLineCommand[]): unknown[] {
  return lines.map((l) => ({
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
}

/**
 * The position shape `accounting_open_balance_draft` requires. Deliberately
 * NOT the journal line shape: an opening position has no branch and no
 * warehouse (§31), so there is no field here for one.
 */
export function serializeOpeningPositions(
  positions: readonly {
    readonly account: { readonly kind: 'system'; readonly systemKey: string } | { readonly kind: 'code'; readonly code: string };
    readonly side: 'D' | 'C';
    readonly baseAmountMinor: bigint;
    readonly baseCurrency: string;
    readonly txnAmountMinor: bigint;
    readonly txnCurrency: string;
    readonly fxRate: string;
    readonly fxRateSource: 'base' | 'manual';
    readonly fxRateAt: Date;
    readonly memo?: string | null;
  }[],
): unknown[] {
  return positions.map((p) => ({
    account: p.account.kind === 'system' ? { kind: 'system', system_key: p.account.systemKey } : { kind: 'code', code: p.account.code },
    side: p.side,
    base_amount_minor: p.baseAmountMinor.toString(10),
    base_currency: p.baseCurrency.toUpperCase(),
    txn_amount_minor: p.txnAmountMinor.toString(10),
    txn_currency: p.txnCurrency.toUpperCase(),
    fx_rate: canonicalRateText(p.fxRate),
    fx_rate_source: p.fxRateSource,
    fx_rate_at: `${p.fxRateAt.toISOString().slice(0, 19)}Z`,
    memo: p.memo ?? null,
  }));
}

/** Exactly ten fraction digits, matching NUMERIC(20,10) and the canonical form. */
export function canonicalRateText(rate: string): string {
  const m = /^(\d+)(?:\.(\d{1,10}))?$/.exec(rate.trim());
  if (!m) throw new Error('an fx rate must be a decimal with at most ten fraction digits');
  return `${(m[1] ?? '0').replace(/^0+(?=\d)/, '')}.${(m[2] ?? '').padEnd(10, '0')}`;
}
