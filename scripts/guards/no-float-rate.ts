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

/**
 * ── P3-S2: the inventory half (P3-AL-08, P3-AL-49; contract §7.2) ─────────
 *
 * Inventory arithmetic is exact fixed point: a quantity is `NUMERIC(18,4)`, a
 * unit cost or average is `NUMERIC(28,10)`, and a movement's value and a
 * key's valuation are `BIGINT` base minor units — the integers the journal
 * carries. A floating-point column anywhere in inventory storage, or a pinned
 * column declared with any other type, reopens the two-rounding defect
 * P3-AL-49 closed. The watched set is discovered by name, so a table written
 * in a later slice is covered the day it exists.
 *
 * Everything above this line is unchanged: the accounting rule is neither
 * widened nor narrowed by the inventory one.
 */
export const INVENTORY_TABLE_RE = /^(stock_[a-z0-9_]+|negative_[a-z0-9_]+|inventory_[a-z0-9_]+)$/;

const QTY_TYPE = /^NUMERIC\s*\(\s*18\s*,\s*4\s*\)/i;
const COST_TYPE = /^NUMERIC\s*\(\s*28\s*,\s*10\s*\)/i;
const MINOR_TYPE = /^(BIGINT|INT8)\b/i;
/**
 * A `qty_*` name that classifies a quantity rather than storing one —
 * `stock_movement_kinds.qty_sign` ('positive' | 'negative' | 'either' |
 * 'zero', contract §2.2) is TEXT by design. Only the named classifier
 * suffixes are exempt; any other `qty_*` column is a quantity.
 */
const QTY_CLASSIFIER = /_(sign|kind|type|code|status|name)$/;

export interface InventoryTypePin {
  readonly describe: string;
  readonly column: (name: string) => boolean;
  readonly type: RegExp;
  readonly expected: string;
}

/** Which columns carry which exact type. A column matched by no pin is left to the float check alone. */
export const INVENTORY_TYPE_PINS: readonly InventoryTypePin[] = [
  {
    describe: 'a quantity (qty_delta, on_hand, *_qty, qty_*)',
    column: (c) => c === 'qty_delta' || c === 'on_hand' || c.endsWith('_qty') || (c.startsWith('qty_') && !QTY_CLASSIFIER.test(c)),
    type: QTY_TYPE,
    expected: 'NUMERIC(18,4)',
  },
  {
    describe: 'a unit cost or average (*_cost_base_minor)',
    column: (c) => c.endsWith('_cost_base_minor'),
    type: COST_TYPE,
    expected: 'NUMERIC(28,10)',
  },
  {
    describe: 'a stored value (value_delta_base_minor, valuation_base_minor)',
    column: (c) => c === 'value_delta_base_minor' || c === 'valuation_base_minor',
    type: MINOR_TYPE,
    expected: 'BIGINT',
  },
];

export function isInventoryTable(table: string): boolean {
  return INVENTORY_TABLE_RE.test(table.toLowerCase());
}

/**
 * Floating-point columns, and pinned columns of the wrong type, on inventory
 * tables in one SQL text. An empty array is a pass.
 */
export function findInventoryNumericViolations(sql: string): RateColumnFinding[] {
  const findings: RateColumnFinding[] = [];
  for (const decl of findColumnDeclarations(sql)) {
    if (!isInventoryTable(decl.table)) continue;
    if (FLOAT_TYPES.test(decl.rest)) {
      findings.push({
        table: decl.table,
        column: decl.column,
        detail: 'declared as a floating-point type — inventory arithmetic is exact fixed point (P3-AL-08)',
      });
      continue;
    }
    for (const pin of INVENTORY_TYPE_PINS) {
      if (pin.column(decl.column) && !pin.type.test(decl.rest)) {
        findings.push({ table: decl.table, column: decl.column, detail: `is ${pin.describe} and must be ${pin.expected} (P3-AL-08/P3-AL-49)` });
      }
    }
  }
  return findings;
}
