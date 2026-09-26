/**
 * `invpl/1` builders for the three purchase kinds (PHASE_3_S4_CONTRACT A-09,
 * A-10(b), A-12, A-13).
 *
 * Each builder takes the exact arguments the service passes to the entry
 * routine, in fixed point and in routine order:
 *
 * - quantities are Q4 (qty × 10^4);
 * - a unit price is the C10 of a txn MINOR unit (price × 10^(e+10) for a
 *   currency of e minor units);
 * - money is integer minor units (txn for the draft, base for the shares);
 * - a currency is bound as its lowercase ISO code (`code`), a date as the
 *   integer `YYYYMMDD`, a rate as R10 (rate × 10^10) and a rate instant as
 *   epoch seconds;
 * - free text as its eight SHA-256 words (`documentTextWords`).
 *
 * The builders refuse what the database could never accept — so no assertion
 * is minted for a command that cannot succeed — and the database refuses all
 * of it again. The draft builder runs the whole A-13 arithmetic (steps 1–5):
 * a draft whose discount, landed allocation or total the routine would refuse
 * is refused here, before the signature, with the same code.
 *
 * Intents (A-10(b)): a draft's and a cancel's intent is the whole payload; a
 * receipt's is `purchase_id`, `warehouse_id` and `draft_revision` only.
 */
import { InventoryError } from './errors';
import { lineTotals, MAX_LANDED_COSTS, type LandedCostMode, type PurchaseTotals } from './landed-cost';
import { MAX_DOCUMENT_LINES, yyyymmdd, type MovementPayload } from './movement-payloads';
import { buildInventoryPayload, CANONICAL_UUID_RE, inventoryIntentSha256, type InventoryPayloadField } from './payload';
import { documentTextWords, finishS4 } from './supplier-payloads';

/** R10 of a rate of exactly 1: the domestic snapshot (A-17). */
export const DOMESTIC_RATE_R10 = 10n ** 10n;

const ISO_CURRENCY_RE = /^[A-Z]{3}$/;

function refuse(message: string): never {
  throw new InventoryError('inventory.payload_invalid', message);
}

const uuid = (value: string, what: string): InventoryPayloadField => {
  if (typeof value !== 'string' || !CANONICAL_UUID_RE.test(value)) refuse(`${what} is not a canonical lowercase uuid`);
  return { kind: 'uuid', value };
};
const uuidOrNull = (value: string | null, what: string): InventoryPayloadField => (value === null ? { kind: 'null' } : uuid(value, what));
const int = (value: bigint | number): InventoryPayloadField => ({ kind: 'integer', value });
const intOrNull = (value: bigint | null): InventoryPayloadField => (value === null ? { kind: 'null' } : int(value));
const words = (text: string | null, what: string, max: number): InventoryPayloadField[] =>
  documentTextWords(text, what, { min: 1, max }).map((w) => intOrNull(w));

function assertBigint(v: unknown, what: string): asserts v is bigint {
  if (typeof v !== 'bigint') refuse(`${what} must be an integer`);
}

function revision(value: number, what: string, min: 0 | 1): InventoryPayloadField {
  if (!Number.isSafeInteger(value) || value < min || value > 2147483647) refuse(`${what} must be an integer revision of at least ${min}`);
  return int(value);
}

/** The ISO code the routine takes as `CHAR(3)`, bound as its lowercase `code` (A-09). */
export function currencyCode(currency: string): string {
  if (typeof currency !== 'string' || !ISO_CURRENCY_RE.test(currency)) refuse('a currency is its uppercase three-letter ISO code');
  return currency.toLowerCase();
}

function assertLines(ids: readonly string[], variants: readonly string[]): void {
  if (ids.length === 0) throw new InventoryError('inventory.lines_required', 'a purchase needs at least one line');
  if (ids.length > MAX_DOCUMENT_LINES) refuse(`a purchase has at most ${MAX_DOCUMENT_LINES} lines`);
  if (new Set(ids).size !== ids.length || new Set(variants).size !== variants.length) {
    throw new InventoryError('inventory.duplicate_line', 'a purchase has one line per variant, each with its own id');
  }
}

// ── purchase.draft ───────────────────────────────────────────────────────

/** Free-text bounds the package holds a draft to, in characters after trimming. */
export const PURCHASE_TEXT_MAX = Object.freeze({ supplierReference: 200, notes: 1000, landedDescription: 200 });

export interface PurchaseDraftLine {
  /** Client-supplied, kept across replaces (A-04). */
  readonly lineId: string;
  readonly variantId: string;
  readonly qtyQ4: bigint;
  /** The C10 of a txn minor unit. */
  readonly unitPriceC10: bigint;
  readonly discountMinor: bigint;
}

export interface PurchaseDraftLandedCost {
  readonly landedCostId: string;
  readonly mode: LandedCostMode;
  readonly amountMinor: bigint;
  readonly description: string | null;
  /** `manual`: one amount per line in line order; `by_value`: null. */
  readonly allocations: readonly bigint[] | null;
}

export interface PurchaseDraftPayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly purchaseId: string;
  /** 0 creates the draft; r replaces revision r. */
  readonly expectedRevision: number;
  readonly supplierId: string;
  readonly warehouseId: string;
  /** The stored warehouse when a replace moves the draft; NULL on create or when unchanged. */
  readonly previousWarehouseId: string | null;
  /** Uppercase ISO code. */
  readonly currency: string;
  /** `YYYY-MM-DD`. */
  readonly documentDate: string;
  readonly supplierReference: string | null;
  readonly notes: string | null;
  /** Always 0: a non-zero tax is refused before minting (A-12, OD-03). */
  readonly taxMinor: bigint;
  /** In `line_no` order. */
  readonly lines: readonly PurchaseDraftLine[];
  /** In `cost_no` order. */
  readonly landedCosts: readonly PurchaseDraftLandedCost[];
}

/** A draft's payload, and the A-13 amounts the routine will store. */
export interface PurchaseDraftPayload extends MovementPayload {
  readonly totals: PurchaseTotals;
}

/**
 * `purchase.draft`: purchase_id, expected_revision, supplier_id, warehouse_id,
 * previous_warehouse_id, currency, document_date, supplier_reference_w1..w8,
 * notes_w1..w8, tax_minor, line_count, per line (line_id, variant_id, qty_q4,
 * unit_price_c10, discount_minor), landed_count, per landed cost
 * (landed_cost_id, mode, amount_minor, description_w1..w8, then line_count
 * allocations: the manual amounts in line order, or all NULL for by_value).
 */
export function purchaseDraftPayload(input: PurchaseDraftPayloadInput): PurchaseDraftPayload {
  assertLines(
    input.lines.map((l) => l.lineId),
    input.lines.map((l) => l.variantId),
  );
  if (input.landedCosts.length > MAX_LANDED_COSTS) refuse(`a purchase has at most ${MAX_LANDED_COSTS} landed costs`);
  const ids = [...input.lines.map((l) => l.lineId), ...input.landedCosts.map((c) => c.landedCostId)];
  if (new Set(ids).size !== ids.length) throw new InventoryError('inventory.duplicate_line', 'a line or landed cost id may not repeat within a purchase');
  if (input.previousWarehouseId !== null && (input.expectedRevision === 0 || input.previousWarehouseId === input.warehouseId)) {
    refuse('a previous warehouse is named only when a replace moves the draft');
  }
  assertBigint(input.taxMinor, 'tax_minor');
  for (const l of input.lines) {
    assertBigint(l.qtyQ4, 'a line quantity');
    assertBigint(l.unitPriceC10, 'a line unit price');
    assertBigint(l.discountMinor, 'a line discount');
  }
  const totals = lineTotals(
    input.lines,
    input.landedCosts.map((c) => ({ mode: c.mode, amountMinor: c.amountMinor, allocations: c.allocations })),
    input.taxMinor,
  );

  const fields: InventoryPayloadField[] = [
    uuid(input.purchaseId, 'purchase_id'),
    revision(input.expectedRevision, 'expected_revision', 0),
    uuid(input.supplierId, 'supplier_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    uuidOrNull(input.previousWarehouseId, 'previous_warehouse_id'),
    { kind: 'code', value: currencyCode(input.currency) },
    int(yyyymmdd(input.documentDate)),
    ...words(input.supplierReference, 'supplier reference', PURCHASE_TEXT_MAX.supplierReference),
    ...words(input.notes, 'notes', PURCHASE_TEXT_MAX.notes),
    int(input.taxMinor),
    int(input.lines.length),
  ];
  for (const l of input.lines) {
    fields.push(uuid(l.lineId, 'line_id'), uuid(l.variantId, 'variant_id'), int(l.qtyQ4), int(l.unitPriceC10), int(l.discountMinor));
  }
  fields.push(int(input.landedCosts.length));
  input.landedCosts.forEach((c) => {
    fields.push(
      uuid(c.landedCostId, 'landed_cost_id'),
      { kind: 'code', value: c.mode },
      int(c.amountMinor),
      ...words(c.description, 'landed cost description', PURCHASE_TEXT_MAX.landedDescription),
    );
    for (let i = 0; i < input.lines.length; i += 1) fields.push(c.allocations === null ? { kind: 'null' } : int(c.allocations[i] ?? -1n));
  });
  return { ...finishS4('purchase.draft', input.tenantId, input.businessId, fields), totals };
}

// ── purchase.cancel ──────────────────────────────────────────────────────

export interface PurchaseCancelPayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly purchaseId: string;
  /** The draft's stored warehouse: the scope that was checked. */
  readonly warehouseId: string;
  readonly draftRevision: number;
}

/** `purchase.cancel`: purchase_id, warehouse_id, draft_revision. */
export function purchaseCancelPayload(input: PurchaseCancelPayloadInput): MovementPayload {
  return finishS4('purchase.cancel', input.tenantId, input.businessId, [
    uuid(input.purchaseId, 'purchase_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    revision(input.draftRevision, 'draft_revision', 1),
  ]);
}

// ── purchase.receive ─────────────────────────────────────────────────────

/** The FX snapshot a receipt binds (A-17). */
export interface ReceiptRate {
  /** The registry row; NULL iff domestic. */
  readonly rateId: string | null;
  /** rate × 10^10; exactly 10^10 when domestic. */
  readonly rateR10: bigint;
  readonly source: 'base' | 'manual';
  /** Epoch seconds of `rate_timestamp`. */
  readonly rateAtEpochSeconds: bigint;
}

export interface PurchaseReceiveLine {
  readonly lineId: string;
  readonly variantId: string;
  readonly qtyQ4: bigint;
  /** `s_i` (A-13 step 7). */
  readonly baseShareMinor: bigint;
  /** `Σ qty_covered` of the line (A-16), 0..qty. */
  readonly coveredQ4: bigint;
  /** Signed `Σ` of the line's stored coverage values; 0 when nothing is covered. */
  readonly catchUpMinor: bigint;
}

export interface PurchaseReceivePayloadInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly purchaseId: string;
  readonly warehouseId: string;
  readonly draftRevision: number;
  readonly supplierId: string;
  readonly supplierRevision: number;
  readonly documentDate: string;
  readonly currency: string;
  readonly rate: ReceiptRate;
  readonly totalTxnMinor: bigint;
  readonly totalBaseMinor: bigint;
  /** Service-minted; NULL iff nothing is covered. */
  readonly coverageAdjustmentId: string | null;
  /** In `line_no` order: every line of the draft. */
  readonly lines: readonly PurchaseReceiveLine[];
}

export interface PurchaseReceiveIntentInput {
  readonly tenantId: string;
  readonly businessId: string;
  readonly purchaseId: string;
  readonly warehouseId: string;
  readonly draftRevision: number;
}

/** The receipt's intent digest (A-10(b)): purchase_id, warehouse_id, draft_revision — computable before any state is read. */
export function purchaseReceiveIntentSha256(input: PurchaseReceiveIntentInput): string {
  return inventoryIntentSha256('purchase.receive', input.tenantId, input.businessId, [
    uuid(input.purchaseId, 'purchase_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    revision(input.draftRevision, 'draft_revision', 1),
  ]);
}

/**
 * `purchase.receive`: purchase_id, warehouse_id, draft_revision, supplier_id,
 * supplier_revision, document_date, currency, rate_id, rate_r10, rate_source,
 * rate_at, total_txn_minor, total_base_minor, coverage_adjustment_id,
 * line_count, per line (line_id, variant_id, qty_q4, base_share_minor,
 * covered_q4, catch_up_minor).
 */
export function purchaseReceivePayload(input: PurchaseReceivePayloadInput): MovementPayload {
  assertLines(
    input.lines.map((l) => l.lineId),
    input.lines.map((l) => l.variantId),
  );
  const r = input.rate;
  assertBigint(r.rateR10, 'rate_r10');
  assertBigint(r.rateAtEpochSeconds, 'rate_at');
  if (r.source !== 'base' && r.source !== 'manual') refuse('a rate source is base or manual');
  if ((r.source === 'base') !== (r.rateId === null)) refuse('a domestic snapshot has no registry row, and a foreign one has one');
  if (r.source === 'base' ? r.rateR10 !== DOMESTIC_RATE_R10 : r.rateR10 <= 0n) refuse('a rate must be positive, and exactly 1 when domestic');
  assertBigint(input.totalTxnMinor, 'total_txn_minor');
  assertBigint(input.totalBaseMinor, 'total_base_minor');
  if (input.totalTxnMinor <= 0n || input.totalBaseMinor <= 0n) throw new InventoryError('purchase.total_zero', 'a purchase total must be positive');
  let shares = 0n;
  let covered = 0n;
  for (const [i, l] of input.lines.entries()) {
    const what = `line ${i + 1}`;
    for (const [v, name] of [
      [l.qtyQ4, 'quantity'],
      [l.baseShareMinor, 'base share'],
      [l.coveredQ4, 'covered quantity'],
      [l.catchUpMinor, 'catch-up value'],
    ] as const) {
      assertBigint(v, `${what} ${name}`);
    }
    if (l.qtyQ4 <= 0n) refuse(`${what} quantity must be positive`);
    if (l.baseShareMinor < 0n) refuse(`${what} base share must not be negative`);
    if (l.coveredQ4 < 0n || l.coveredQ4 > l.qtyQ4) refuse(`${what} covers between zero and its quantity`);
    if (l.coveredQ4 === 0n && l.catchUpMinor !== 0n) refuse(`${what} covers nothing and carries no catch-up`);
    shares += l.baseShareMinor;
    covered += l.coveredQ4;
  }
  if (shares !== input.totalBaseMinor) refuse('the base shares must add up to the base total exactly');
  if ((covered === 0n) !== (input.coverageAdjustmentId === null)) refuse('a coverage header id is bound iff the receipt covers a deficit');

  const fields: InventoryPayloadField[] = [
    uuid(input.purchaseId, 'purchase_id'),
    uuid(input.warehouseId, 'warehouse_id'),
    revision(input.draftRevision, 'draft_revision', 1),
    uuid(input.supplierId, 'supplier_id'),
    revision(input.supplierRevision, 'supplier_revision', 1),
    int(yyyymmdd(input.documentDate)),
    { kind: 'code', value: currencyCode(input.currency) },
    uuidOrNull(r.rateId, 'rate_id'),
    int(r.rateR10),
    { kind: 'code', value: r.source },
    int(r.rateAtEpochSeconds),
    int(input.totalTxnMinor),
    int(input.totalBaseMinor),
    uuidOrNull(input.coverageAdjustmentId, 'coverage_adjustment_id'),
    int(input.lines.length),
  ];
  for (const l of input.lines) {
    fields.push(uuid(l.lineId, 'line_id'), uuid(l.variantId, 'variant_id'), int(l.qtyQ4), int(l.baseShareMinor), int(l.coveredQ4), int(l.catchUpMinor));
  }
  const payload = buildInventoryPayload('purchase.receive', input.tenantId, input.businessId, fields);
  return { payload, intentSha256: purchaseReceiveIntentSha256(input) };
}
