/**
 * Guard G-2 (Architecture Lock, slice P2-S2; extended in P2-S5).
 *
 * Refuses a floating-point financial rate in authoritative accounting
 * storage. `REAL`, `FLOAT` and `DOUBLE PRECISION` cannot represent most
 * decimal rates exactly, so two systems converting the same amount at the
 * "same" rate can disagree by a minor unit — and in a ledger that difference
 * becomes historical truth. AL-09 fixes the type at `NUMERIC(20,10)`:
 * PostgreSQL's NUMERIC is exact, and ten decimal places is what pairs like
 * USD/LBP and three-decimal JOD actually need.
 *
 * WHY THE EXISTING MONEY RULE DOES NOT COVER THIS. `static-guards.ts` rule 6
 * keys off the column names `amount|price|total|balance`, so a column called
 * `fx_rate` passes it untouched. This guard is the rate-shaped half.
 *
 * WHY IT IS SCOPED. A `conversion_rate` on a marketing funnel or a tax
 * percentage on a product is not accounting authority, and a repository-wide
 * ban on float rates would be a guard nobody could live with. The watch list
 * below is accounting storage only: the journal, the chart, and every
 * `accounting_*` table. P2-S5 adds the FX rate tables it introduces.
 */
import { findColumnDeclarations } from './sql-schema';

/**
 * Tables whose rate columns are financial authority. `accounting_*` is
 * matched by prefix as well, so a future accounting table is watched the day
 * it is created rather than the day someone remembers to list it.
 */
export const RATE_AUTHORITY_TABLES = ['journal_lines', 'journal_entries', 'accounts'] as const;
export const RATE_AUTHORITY_TABLE_PREFIX = 'accounting_';

/** Types that cannot represent a decimal rate exactly. */
const FLOAT_TYPES = /^(REAL|FLOAT4|FLOAT8|FLOAT\s*(\(\s*\d+\s*\))?|DOUBLE\s+PRECISION)\b/i;
/** NUMERIC/DECIMAL, with its optional precision and scale. */
const NUMERIC_TYPE = /^(?:NUMERIC|DECIMAL)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?/i;

/** AL-09's mandated scale. A rate stored with fewer decimals is a rounded rate. */
export const REQUIRED_RATE_SCALE = 10;

export function isRateAuthorityTable(table: string): boolean {
  const name = table.toLowerCase();
  return (RATE_AUTHORITY_TABLES as readonly string[]).includes(name) || name.startsWith(RATE_AUTHORITY_TABLE_PREFIX);
}

/**
 * A column is a financial RATE when one of its underscore-separated tokens is
 * exactly `rate`. That catches `fx_rate`, `exchange_rate`,
 * `payment_to_base_rate` and `fx_rate_source`, and deliberately does not
 * catch `aggregate`, `rating` or `generated`.
 */
export function isRateColumn(column: string): boolean {
  return column.toLowerCase().split('_').includes('rate');
}

export interface RateColumnFinding {
  readonly table: string;
  readonly column: string;
  readonly detail: string;
}

/**
 * Find float (or under-scaled) financial rate columns in one SQL text.
 * An empty array is a pass.
 */
export function findFloatRateColumns(sql: string): RateColumnFinding[] {
  const findings: RateColumnFinding[] = [];
  for (const decl of findColumnDeclarations(sql)) {
    if (!isRateAuthorityTable(decl.table) || !isRateColumn(decl.column)) continue;

    if (FLOAT_TYPES.test(decl.rest)) {
      findings.push({
        table: decl.table,
        column: decl.column,
        detail: `declared as a floating-point type — an accounting rate must be NUMERIC(20,${REQUIRED_RATE_SCALE}) (AL-09/G-2)`,
      });
      continue;
    }

    const numeric = NUMERIC_TYPE.exec(decl.rest);
    if (numeric) {
      const scale = numeric[2] === undefined ? null : Number(numeric[2]);
      if (scale === null) {
        findings.push({
          table: decl.table,
          column: decl.column,
          detail: `declared as NUMERIC without an explicit scale — AL-09 fixes an accounting rate at NUMERIC(20,${REQUIRED_RATE_SCALE})`,
        });
      } else if (scale < REQUIRED_RATE_SCALE) {
        findings.push({
          table: decl.table,
          column: decl.column,
          detail: `declared with scale ${scale} — AL-09 requires at least ${REQUIRED_RATE_SCALE} decimal places for an accounting rate`,
        });
      }
    }
    // Any other type (TEXT for a rate SOURCE, TIMESTAMPTZ for a rate TIME) is
    // not a stored rate and is none of this guard's business.
  }
  return findings;
}
