/**
 * Fixed-point representation of inventory quantities, unit costs and values
 * (P3-AL-08, P3-AL-49; PHASE_3_S2_CONTRACT §4).
 *
 * Every authoritative number is a `bigint` of an exact decimal unit:
 *
 *   quantity   Q4    integer count of 10^-4 units   (`NUMERIC(18,4)`)
 *   unit cost  C10   integer count of 10^-10 minor  (`NUMERIC(28,10)`)
 *   value      minor integer base minor units       (`BIGINT`)
 *
 * A JavaScript `number` never holds any of them, and nothing here goes
 * through binary floating point: text is parsed digit-exactly into a
 * `bigint`, and formatted back digit-exactly. The formats are the text
 * PostgreSQL gives for the same columns (`NUMERIC(18,4)::text` always has 4
 * fraction digits, `NUMERIC(28,10)::text` always 10, `BIGINT::text` none), so
 * a TypeScript value and a stored value compare as strings.
 *
 * Refusals carry a stable code and never the offending number.
 */
import { InventoryError, type InventoryErrorCode } from './errors';

export const QTY_SCALE = 4;
export const COST_SCALE = 10;
/**
 * Exclusive bound on |qty| and |on_hand| in Q4: |qty| < 10^10 units — A-26 as
 * amended after the security review (M-3), mirroring R3's `c_qty_limit`
 * (`0060_inventory_stock_primitive.sql`). Refused as
 * `inventory.quantity_out_of_range` by the valuation step, as R3 refuses it.
 */
export const QTY_LIMIT_Q4 = 10n ** 14n;
/**
 * Exclusive bound on quantity TEXT in Q4: the `NUMERIC(18,4)` column domain,
 * |q| < 10^14 units. Parsing is the column's concern, the range is R3's: text
 * inside the column domain but at or above `QTY_LIMIT_Q4` parses, and the
 * valuation step then refuses it exactly where R3 does.
 */
const QTY_DOMAIN_Q4 = 10n ** 18n;
/** Inclusive bound on |value| and |valuation| in minor units: <= 10^18 (A-26). */
export const VALUE_LIMIT_MINOR = 10n ** 18n;
/** Exclusive bound on a unit cost in C10: cost < 10^18 (A-26). */
export const COST_LIMIT_C10 = 10n ** 28n;

/** An exact decimal: `units × 10^-scale`. `scale` is a digit count, never a magnitude. */
export interface ExactDecimal {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL_RE = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const INTEGER_RE = /^-?(0|[1-9][0-9]*)$/;

function refuse(code: InventoryErrorCode, message: string): never {
  throw new InventoryError(code, message);
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Splits decimal text into sign, integer digits and fraction digits, or null when it is not decimal text. */
function splitDecimal(text: string): { negative: boolean; whole: string; fraction: string } | null {
  if (typeof text !== 'string') return null;
  const m = DECIMAL_RE.exec(text);
  if (m === null) return null;
  return { negative: m[1] === '-', whole: m[2] ?? '0', fraction: m[3] ?? '' };
}

/** Parses `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$` exactly; anything else is `inventory.arithmetic_invalid`. */
export function parseDecimal(text: string): ExactDecimal {
  const parts = splitDecimal(text);
  if (parts === null) refuse('inventory.arithmetic_invalid', 'not an exact decimal literal');
  const magnitude = BigInt(`${parts.whole}${parts.fraction}`);
  return { units: parts.negative ? -magnitude : magnitude, scale: parts.fraction.length };
}

/**
 * Rescales decimal text to a fixed number of fraction digits, or null when
 * the text is not decimal text or carries more fraction digits than `scale`.
 * Trailing zeros are digits like any other: `1.00000` has five.
 */
function rescaleDecimal(text: string, scale: number): bigint | null {
  const parts = splitDecimal(text);
  if (parts === null || parts.fraction.length > scale) return null;
  const magnitude = BigInt(`${parts.whole}${parts.fraction.padEnd(scale, '0')}`);
  return parts.negative ? -magnitude : magnitude;
}

/** Quantity text to Q4: at most 4 fraction digits and |q| < 10^14 units (the `NUMERIC(18,4)` domain), else `inventory.quantity_invalid`. */
export function parseQuantity(text: string): bigint {
  const q4 = rescaleDecimal(text, QTY_SCALE);
  if (q4 === null || absBig(q4) >= QTY_DOMAIN_Q4) refuse('inventory.quantity_invalid', 'quantity is not a four-decimal value within range');
  return q4;
}

/** Unit-cost text to C10: >= 0, at most 10 fraction digits and < 10^18, else `inventory.cost_invalid`. */
export function parseUnitCost(text: string): bigint {
  const c10 = rescaleDecimal(text, COST_SCALE);
  if (c10 === null || c10 < 0n || c10 >= COST_LIMIT_C10) refuse('inventory.cost_invalid', 'unit cost is not a non-negative ten-decimal value within range');
  return c10;
}

/** Integer minor-unit text: `^-?(0|[1-9][0-9]*)$` and |v| <= 10^18, else `inventory.value_out_of_range`. */
export function parseMinor(text: string): bigint {
  if (typeof text !== 'string' || !INTEGER_RE.test(text)) refuse('inventory.value_out_of_range', 'value is not an integer within range');
  const v = BigInt(text);
  if (absBig(v) > VALUE_LIMIT_MINOR) refuse('inventory.value_out_of_range', 'value is not an integer within range');
  return v;
}

function formatFixed(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = absBig(units)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
}

/** Q4 to text with exactly 4 fraction digits, e.g. `-3.0000` — the text of `NUMERIC(18,4)`. */
export function formatQuantity(q4: bigint): string {
  return formatFixed(q4, QTY_SCALE);
}

/** C10 to text with exactly 10 fraction digits — the text of `NUMERIC(28,10)`. Also used for averages, which may be signed. */
export function formatUnitCost(c10: bigint): string {
  return formatFixed(c10, COST_SCALE);
}

/** Minor units to integer text — the text of `BIGINT`. */
export function formatMinor(v: bigint): string {
  return v.toString();
}
