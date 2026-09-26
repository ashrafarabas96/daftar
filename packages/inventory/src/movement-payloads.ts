/**
 * `invpl/1` builders for the seven P3-S3 operation kinds
 * (PHASE_3_S3_CONTRACT A-09, A-10(b)).
 *
 * Each builder takes the exact arguments the service will pass to the entry
 * routine — in fixed point, in routine order — and returns:
 *
 * - `payload`: the canonical stream of EVERY field, whose digest the
 *   `invctl/1` assertion signs and the routine rebuilds from its own
 *   arguments;
 * - `intentSha256`: the digest of the client-intent fields only (the payload
 *   without `expected_value`, `opening_balance_id`, `position_minor` and
 *   `variance_q4`). A header stores it as `intent_sha256`, and the service
 *   compares it with the stored one BEFORE reading any current state (A-10(c)).
 *   Neither digest contains a clock value.
 *
 * The builders refuse what the database could never accept — a line count
 * outside 1..200, a duplicated line, a sign or cost the kind forbids — so an
 * assertion is never minted for a command that cannot succeed. The database
 * refuses all of it again; these checks only move the refusal before the
 * signature.
 */
import { InventoryError, type InventoryErrorCode } from './errors';
import { parseQuantity, parseUnitCost } from './fixed-point';
import {
  buildInventoryPayload,
  CANONICAL_UUID_RE,
  inventoryIntentSha256,
  type InventoryPayload,
  type InventoryPayloadField,
  type InventoryS3OperationCode,
} from './payload';
import { reasonWords } from './reason-digest';

/** A document has 1..200 lines, and a stocktake count request at most 200 (A-24, TL-8). */
export const MAX_DOCUMENT_LINES = 200;
/** A stocktake may hold up to 2000 lines across requests; its finalize binds every one (A-24). */
export const MAX_STOCKTAKE_LINES = 2000;

/** What every builder returns: the signed payload, and the intent digest the header stores. */
export interface MovementPayload {
  readonly payload: InventoryPayload;
  readonly intentSha256: string;
}

function refuse(code: InventoryErrorCode, message: string): never {
  throw new InventoryError(code, message);
}

// ── Fixed-point helpers (A-09) ───────────────────────────────────────────

/** Quantity text to its Q4 integer (`qty × 10^4`); more than four decimals is refused. */
export function toQ4(quantity: string): bigint {
  return parseQuantity(quantity);
}

/** Unit-cost text to its C10 integer (`cost × 10^10`); more than ten decimals, or a negative cost, is refused. */
export function toC10(unitCost: string): bigint {
  return parseUnitCost(unitCost);
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A civil date `YYYY-MM-DD` as the integer `YYYYMMDD`. A date that does not exist is refused. */
export function yyyymmdd(date: string): bigint {
  const m = typeof date === 'string' ? ISO_DATE_RE.exec(date) : null;
  if (m === null) return refuse('inventory.payload_invalid', 'a date must be YYYY-MM-DD');
  const [year, month, day] = [BigInt(m[1] ?? ''), BigInt(m[2] ?? ''), BigInt(m[3] ?? '')];
  const leap = (year % 4n === 0n && year % 100n !== 0n) || year % 400n === 0n;
  const monthDays = month < 1n || month > 12n ? null : month === 2n ? (leap ? 29n : 28n) : [4n, 6n, 9n, 11n].includes(month) ? 30n : 31n;
  if (year < 1n || monthDays === null || day < 1n || day > monthDays) refuse('inventory.payload_invalid', 'a date must be a real calendar date');
  return year * 10000n + month * 100n + day;
}

/** Canonical order of a stocktake's lines: ascending `variant_id`, as PostgreSQL orders `uuid` (A-09). */
export function compareUuid(a: string, b: string): number {
  // Canonical lowercase UUIDs: text order is byte order is `uuid` order.
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── The stream ───────────────────────────────────────────────────────────

/** One field of the stream, and whether it is server-derived (excluded from the intent). */
interface Entry {
  readonly field: InventoryPayloadField;
  readonly derived: boolean;
}

const uuid = (value: string): Entry => ({ field: { kind: 'uuid', value }, derived: false });
const int = (value: bigint): Entry => ({ field: { kind: 'integer', value }, derived: false });
const code = (value: string): Entry => ({ field: { kind: 'code', value }, derived: false });
const nul = (): Entry => ({ field: { kind: 'null' }, derived: false });
const derived = (e: Entry): Entry => ({ field: e.field, derived: true });
const intOrNull = (value: bigint | null): Entry => (value === null ? nul() : int(value));
const reason = (text: string): Entry[] => reasonWords(text).map(int);

function finish(opCode: InventoryS3OperationCode, tenantId: string, businessId: string, entries: readonly Entry[]): MovementPayload {
  return {
    payload: buildInventoryPayload(
      opCode,
      tenantId,
      businessId,
      entries.map((e) => e.field),
    ),
    intentSha256: inventoryIntentSha256(
      opCode,
      tenantId,
      businessId,
      entries.filter((e) => !e.derived).map((e) => e.field),
    ),
  };
}

function assertLineCount(count: number, max: number): void {
  if (count === 0) refuse('inventory.lines_required', 'a document needs at least one line');
  if (count > max) refuse('inventory.payload_invalid', `a document has at most ${max} lines`);
}

function assertUuid(value: string, what: string): void {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) refuse('inventory.payload_invalid', `${what} is not a canonical lowercase uuid`);
}

function assertDistinct(keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) refuse('inventory.duplicate_line', 'a line may not repeat within a document');
}

/** Stocktake lines: strictly ascending `variant_id` — sorted and without a repeat. */
function assertVariantOrder(variantIds: readonly string[]): void {
  variantIds.forEach((id, i) => assertUuid(id, `line ${i + 1} variant`));
  assertDistinct(variantIds);
  for (let i = 1; i < variantIds.length; i += 1) {
    if (compareUuid(variantIds[i - 1] ?? '', variantIds[i] ?? '') >= 0)
      refuse('inventory.payload_invalid', 'stocktake lines must be in ascending variant order');
  }
}

function assertPositive(q: bigint, what: string): void {
  if (typeof q !== 'bigint' || q <= 0n) refuse('inventory.payload_invalid', `${what} must be positive`);
}

function assertBigint(v: bigint, what: string): void {
  if (typeof v !== 'bigint') refuse('inventory.payload_invalid', `${what} must be an integer`);
}

// ── inventory.transfer ───────────────────────────────────────────────────

export interface TransferPayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly transferId: string;
  readonly sourceWarehouseId: string;
  readonly destinationWarehouseId: string;
  /** In `line_no` order (1..n, the request order). */
  readonly lines: readonly { readonly variantId: string; readonly qtyQ4: bigint }[];
}

/** `inventory.transfer`: transfer_id, source, destination, line_count, per line variant_id, qty_q4 (> 0). No derived field. */
export function transferPayload(input: TransferPayloadInput): MovementPayload {
  assertLineCount(input.lines.length, MAX_DOCUMENT_LINES);
  if (input.sourceWarehouseId === input.destinationWarehouseId) refuse('inventory.payload_invalid', 'a transfer moves stock between two different warehouses');
  assertDistinct(input.lines.map((l) => l.variantId));
  const entries: Entry[] = [uuid(input.transferId), uuid(input.sourceWarehouseId), uuid(input.destinationWarehouseId), int(BigInt(input.lines.length))];
  input.lines.forEach((l, i) => {
    assertPositive(l.qtyQ4, `line ${i + 1} quantity`);
    entries.push(uuid(l.variantId), int(l.qtyQ4));
  });
  return finish('inventory.transfer', input.tenantId, input.businessId, entries);
}

// ── inventory.adjust / inventory.damage ──────────────────────────────────

export interface AdjustPayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly adjustmentId: string;
  readonly warehouseId: string;
  /** `YYYY-MM-DD`, the request's own date — never a server default. */
  readonly occurredOn: string;
  /** Exactly the string the routine will receive. */
  readonly reason: string;
  readonly lines: readonly {
    readonly variantId: string;
    /** Signed and non-zero. */
    readonly qtyDeltaQ4: bigint;
    /** Required for a gain (qty > 0), NULL for a loss. */
    readonly unitCostC10: bigint | null;
    /** The server's pre-computed movement value (A-07): >= 0 for a gain, <= 0 for a loss. */
    readonly expectedValue: bigint;
  }[];
}

/**
 * `inventory.adjust`: adjustment_id, warehouse_id, occurred_on, reason_w1..w8,
 * line_count, per line variant_id, qty_delta_q4, unit_cost_c10 (non-NULL iff
 * qty > 0), expected_value (derived).
 */
export function adjustPayload(input: AdjustPayloadInput): MovementPayload {
  assertLineCount(input.lines.length, MAX_DOCUMENT_LINES);
  assertDistinct(input.lines.map((l) => l.variantId));
  const entries: Entry[] = [
    uuid(input.adjustmentId),
    uuid(input.warehouseId),
    int(yyyymmdd(input.occurredOn)),
    ...reason(input.reason),
    int(BigInt(input.lines.length)),
  ];
  input.lines.forEach((l, i) => {
    const what = `line ${i + 1}`;
    assertBigint(l.qtyDeltaQ4, `${what} quantity`);
    assertBigint(l.expectedValue, `${what} expected value`);
    if (l.qtyDeltaQ4 === 0n) refuse('inventory.payload_invalid', `${what} quantity must not be zero`);
    if (l.qtyDeltaQ4 > 0n) {
      if (l.unitCostC10 === null) refuse('inventory.unit_cost_required', `${what} is a gain and needs a unit cost`);
      if (l.unitCostC10 < 0n) refuse('inventory.payload_invalid', `${what} unit cost must not be negative`);
      if (l.expectedValue < 0n) refuse('inventory.payload_invalid', `${what} is a gain and cannot carry a negative value`);
    } else {
      if (l.unitCostC10 !== null) refuse('inventory.payload_invalid', `${what} is a loss and is valued at the average, not at a stated cost`);
      if (l.expectedValue > 0n) refuse('inventory.payload_invalid', `${what} is a loss and cannot carry a positive value`);
    }
    entries.push(uuid(l.variantId), int(l.qtyDeltaQ4), intOrNull(l.unitCostC10), derived(int(l.expectedValue)));
  });
  return finish('inventory.adjust', input.tenantId, input.businessId, entries);
}

export interface DamagePayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly adjustmentId: string;
  readonly warehouseId: string;
  readonly occurredOn: string;
  readonly reason: string;
  readonly lines: readonly {
    readonly variantId: string;
    /** The positive magnitude written off. */
    readonly qtyQ4: bigint;
    /** The server's pre-computed movement value: <= 0. */
    readonly expectedValue: bigint;
  }[];
}

/** `inventory.damage`: adjustment_id, warehouse_id, occurred_on, reason_w1..w8, line_count, per line variant_id, qty_q4 (> 0), expected_value (<= 0, derived). */
export function damagePayload(input: DamagePayloadInput): MovementPayload {
  assertLineCount(input.lines.length, MAX_DOCUMENT_LINES);
  assertDistinct(input.lines.map((l) => l.variantId));
  const entries: Entry[] = [
    uuid(input.adjustmentId),
    uuid(input.warehouseId),
    int(yyyymmdd(input.occurredOn)),
    ...reason(input.reason),
    int(BigInt(input.lines.length)),
  ];
  input.lines.forEach((l, i) => {
    assertPositive(l.qtyQ4, `line ${i + 1} quantity`);
    assertBigint(l.expectedValue, `line ${i + 1} expected value`);
    if (l.expectedValue > 0n) refuse('inventory.payload_invalid', `line ${i + 1} is a write-off and cannot carry a positive value`);
    entries.push(uuid(l.variantId), int(l.qtyQ4), derived(int(l.expectedValue)));
  });
  return finish('inventory.damage', input.tenantId, input.businessId, entries);
}

// ── Stocktake ────────────────────────────────────────────────────────────

export interface StocktakeOpenPayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly stocktakeId: string;
  readonly warehouseId: string;
}

/** `inventory.stocktake_open`: stocktake_id, warehouse_id. */
export function stocktakeOpenPayload(input: StocktakeOpenPayloadInput): MovementPayload {
  return finish('inventory.stocktake_open', input.tenantId, input.businessId, [uuid(input.stocktakeId), uuid(input.warehouseId)]);
}

export interface StocktakeCountPayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly stocktakeId: string;
  readonly warehouseId: string;
  /** In ascending `variant_id` order (`compareUuid`); at most 200 per request. */
  readonly lines: readonly { readonly variantId: string; readonly countedQ4: bigint }[];
}

/** `inventory.stocktake_count`: stocktake_id, warehouse_id, line_count, per line (variant order) variant_id, counted_q4 (>= 0). */
export function stocktakeCountPayload(input: StocktakeCountPayloadInput): MovementPayload {
  assertLineCount(input.lines.length, MAX_DOCUMENT_LINES);
  assertVariantOrder(input.lines.map((l) => l.variantId));
  const entries: Entry[] = [uuid(input.stocktakeId), uuid(input.warehouseId), int(BigInt(input.lines.length))];
  input.lines.forEach((l, i) => {
    assertBigint(l.countedQ4, `line ${i + 1} counted quantity`);
    if (l.countedQ4 < 0n) refuse('inventory.payload_invalid', `line ${i + 1} counted quantity must not be negative`);
    entries.push(uuid(l.variantId), int(l.countedQ4));
  });
  return finish('inventory.stocktake_count', input.tenantId, input.businessId, entries);
}

export type StocktakeOutcome = 'finalized' | 'cancelled';

export interface StocktakeFinalizeLine {
  readonly variantId: string;
  /** The stored `variance_qty` of the line, in Q4 (derived: it is the capture's, not the client's). */
  readonly varianceQ4: bigint;
  /** An explicit cost, only for a positive variance on a key with no average (A-11). */
  readonly unitCostC10: bigint | null;
  /** The server's pre-computed movement value; 0 for a zero variance. */
  readonly expectedValue: bigint;
}

export interface StocktakeFinalizePayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly stocktakeId: string;
  readonly warehouseId: string;
  readonly outcome: StocktakeOutcome;
  /** Required when finalized; NULL when cancelled. */
  readonly occurredOn: string | null;
  /** Every line of the stocktake, in ascending `variant_id` order, when finalized; none when cancelled. */
  readonly lines: readonly StocktakeFinalizeLine[];
}

/**
 * `inventory.stocktake_finalize`: stocktake_id, warehouse_id, outcome,
 * occurred_on (NULL iff cancelled), line_count (0 iff cancelled), per line
 * (variant order, every line) variant_id, variance_q4 (derived),
 * unit_cost_c10, expected_value (derived). Cancel is the `cancelled` outcome
 * of this kind (A-11, TL-3): an assertion minted for one outcome cannot
 * perform the other.
 */
export function stocktakeFinalizePayload(input: StocktakeFinalizePayloadInput): MovementPayload {
  if (input.outcome === 'cancelled') {
    if (input.occurredOn !== null || input.lines.length !== 0) refuse('inventory.payload_invalid', 'a cancelled stocktake carries no date and no line');
  } else if (input.outcome === 'finalized') {
    if (input.occurredOn === null) refuse('inventory.payload_invalid', 'a finalized stocktake needs its date');
    assertLineCount(input.lines.length, MAX_STOCKTAKE_LINES);
    assertVariantOrder(input.lines.map((l) => l.variantId));
  } else {
    refuse('inventory.payload_invalid', 'a stocktake outcome is finalized or cancelled');
  }
  const entries: Entry[] = [
    uuid(input.stocktakeId),
    uuid(input.warehouseId),
    code(input.outcome),
    input.occurredOn === null ? nul() : int(yyyymmdd(input.occurredOn)),
    int(BigInt(input.lines.length)),
  ];
  input.lines.forEach((l, i) => {
    const what = `line ${i + 1}`;
    assertBigint(l.varianceQ4, `${what} variance`);
    assertBigint(l.expectedValue, `${what} expected value`);
    if (l.unitCostC10 !== null && (l.varianceQ4 <= 0n || l.unitCostC10 < 0n)) {
      refuse('inventory.payload_invalid', `${what} may carry a non-negative cost only for a positive variance`);
    }
    if (l.varianceQ4 === 0n ? l.expectedValue !== 0n : l.varianceQ4 > 0n ? l.expectedValue < 0n : l.expectedValue > 0n) {
      refuse('inventory.payload_invalid', `${what} value does not have the sign of its variance`);
    }
    entries.push(uuid(l.variantId), derived(int(l.varianceQ4)), intOrNull(l.unitCostC10), derived(int(l.expectedValue)));
  });
  return finish('inventory.stocktake_finalize', input.tenantId, input.businessId, entries);
}

// ── inventory.opening ────────────────────────────────────────────────────

export interface OpeningPayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly openingId: string;
  readonly occurredOn: string;
  /** Case B: the posted opening balance holding Inventory, and its net position. Both NULL is Case A (A-13). */
  readonly openingBalanceId: string | null;
  readonly positionMinor: bigint | null;
  /** In `line_no` order; `(warehouse, variant)` unique. */
  readonly lines: readonly { readonly warehouseId: string; readonly variantId: string; readonly qtyQ4: bigint; readonly unitCostC10: bigint }[];
}

/**
 * `inventory.opening`: opening_id, occurred_on, opening_balance_id (derived),
 * position_minor (derived), line_count, per line warehouse_id, variant_id,
 * qty_q4 (> 0), unit_cost_c10 (>= 0).
 */
export function openingPayload(input: OpeningPayloadInput): MovementPayload {
  assertLineCount(input.lines.length, MAX_DOCUMENT_LINES);
  if ((input.openingBalanceId === null) !== (input.positionMinor === null)) {
    refuse('inventory.payload_invalid', 'an opening position is an opening balance id and its amount, or neither');
  }
  assertDistinct(input.lines.map((l) => `${l.warehouseId}|${l.variantId}`));
  const entries: Entry[] = [
    uuid(input.openingId),
    int(yyyymmdd(input.occurredOn)),
    derived(input.openingBalanceId === null ? nul() : uuid(input.openingBalanceId)),
    derived(intOrNull(input.positionMinor)),
    int(BigInt(input.lines.length)),
  ];
  input.lines.forEach((l, i) => {
    assertPositive(l.qtyQ4, `line ${i + 1} quantity`);
    assertBigint(l.unitCostC10, `line ${i + 1} unit cost`);
    if (l.unitCostC10 < 0n) refuse('inventory.payload_invalid', `line ${i + 1} unit cost must not be negative`);
    entries.push(uuid(l.warehouseId), uuid(l.variantId), int(l.qtyQ4), int(l.unitCostC10));
  });
  return finish('inventory.opening', input.tenantId, input.businessId, entries);
}
