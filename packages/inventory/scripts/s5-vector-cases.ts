/**
 * The shared P3-S5 vectors, as pure functions (PHASE_3_S5_CONTRACT §4.1).
 *
 * `scripts/generate-s5-vectors.ts` writes:
 *
 * - `vectors/invpl-s5-vectors.json` — the `invpl/1` payload AND intent
 *   streams of `purchase.return` and `purchase.reverse`, built by
 *   `src/supplier-return-payloads.ts` and `src/purchase-reversal-payloads.ts`,
 *   with the exact entry-routine arguments that rebuild each stream in SQL;
 * - `vectors/supplier-return-vectors.json` — A-10 end to end by
 *   `src/supplier-return.ts`: a purchase (its lines, its receipt into the
 *   return warehouse, any stock the key held before), then a sequence of
 *   returns, each starting from what the previous one stored.
 *
 * Every number in the files is COMPUTED by the package; nothing is copied by
 * hand. Where the contract states a number (CUMULATIVE-THIRDS' 33, 34, 33) or
 * a case exists to show a property (a non-zero dust line of each sign, a
 * positive and a negative PPV), the generator holds the computation to that
 * LITERAL and refuses to write a file in which they disagree, so the JSON
 * records the specification, not whatever the code happens to do.
 *
 * The unit suites rebuild both files and require them byte-identical; the
 * SQL routines are held to the SAME files (T-07, T-14). Every integer is
 * decimal TEXT, because a value may exceed 2^53.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { InventoryError } from '../src/errors';
import { formatMinor, formatQuantity, formatUnitCost } from '../src/fixed-point';
import { toC10, toQ4, type MovementPayload } from '../src/movement-payloads';
import { INVENTORY_PAYLOAD_SCHEMAS, inventoryIntentSchema, type InventoryPayloadFieldSpec, type InventoryS5OperationCode } from '../src/payload';
import { purchaseReversePayload, type PurchaseReversePayloadInput } from '../src/purchase-reversal-payloads';
import { baseShares, unitCostC10 } from '../src/purchase-shares';
import { roundHalfEven } from '../src/rounding';
import { planSupplierReturn, type SupplierReturnPlan } from '../src/supplier-return';
import { supplierReturnPayload, type SupplierReturnPayloadInput } from '../src/supplier-return-payloads';
import { EMPTY_STOCK_STATE, simulateMovement, type StockState } from '../src/valuation';

// ── Common helpers ───────────────────────────────────────────────────────

function jsonable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(jsonable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonable(v)]));
  return value;
}

async function renderJson(value: unknown, file: string): Promise<string> {
  const options = (await resolveConfig(join(__dirname, '..', 'vectors', file))) ?? {};
  return format(JSON.stringify(value, null, 2), { ...options, parser: 'json' });
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`vector spec disagreement: ${message}`);
}

/** The code a refusal carries, or 'accepted'. */
function attempt<R>(fn: () => R): { readonly outcome: string; readonly value: R | null } {
  try {
    return { outcome: 'accepted', value: fn() };
  } catch (e) {
    if (e instanceof InventoryError) return { outcome: e.code, value: null };
    throw e;
  }
}

// ── Identifiers (fixed test material) ────────────────────────────────────

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const tb = { tenantId: T, businessId: B };
const PUR = 'a1b2c3d4-0002-4a00-8a00-000000000002';
const RET = 'a1b2c3d4-0005-4a00-8a00-000000000005';
const CN = 'a1b2c3d4-0006-4a00-8a00-000000000006';
const ENTRY = 'a1b2c3d4-0007-4a00-8a00-000000000007';
const W1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const W2 = '4e7b5bed-50d4-41d2-8a0c-0305e82c3304';
const V1 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const V2 = '2a9c1b4e-6f3d-4e8a-b1c7-5d0e9f2a3b4c';
const V3 = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
const L1 = 'b0000000-0000-4000-8000-000000000001';
const L2 = 'b0000000-0000-4000-8000-000000000002';
const L3 = 'b0000000-0000-4000-8000-000000000003';
const RL1 = 'b5000000-0000-4000-8000-000000000001';
const RL2 = 'b5000000-0000-4000-8000-000000000002';

// ── invpl/1 P3-S5 ────────────────────────────────────────────────────────

export interface S5VectorField {
  readonly name: string;
  readonly type: InventoryPayloadFieldSpec['type'];
  readonly value: string | null;
}

export interface S5StreamVector {
  readonly fields: readonly S5VectorField[];
  readonly canonicalHex: string;
  readonly sha256: string;
}

export interface S5PayloadVector {
  readonly id: string;
  readonly why: string;
  readonly opCode: InventoryS5OperationCode;
  readonly tenantId: string;
  readonly businessId: string;
  /** The entry routine and the exact arguments (as SQL literals' text; arrays as JSON arrays; NULL as null) from which it rebuilds `payload`. */
  readonly routine: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
  readonly payload: S5StreamVector;
  readonly intent: S5StreamVector;
}

export interface InvplS5Vectors {
  readonly spec: string;
  readonly note: string;
  readonly cases: readonly S5PayloadVector[];
}

/** The field values of a canonical stream: every line after the fourth, LF-split, `00` as NULL. */
function streamValues(bytes: Buffer): (string | null)[] {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('a stream must end with LF');
  return text
    .slice(0, -1)
    .split('\n')
    .slice(4)
    .map((l) => (l === '\u0000' ? null : l));
}

/** Names and types of every field of a stream, walking header and lines by the count actually encoded. */
function expand(opCode: InventoryS5OperationCode, values: readonly (string | null)[]): S5VectorField[] {
  const schema = INVENTORY_PAYLOAD_SCHEMAS[opCode];
  const specs: InventoryPayloadFieldSpec[] = [...schema];
  const repeat = schema.repeat;
  if (repeat === undefined || schema.trailer !== undefined) throw new Error(`${opCode}: a P3-S5 schema is a header and one line group`);
  const lineCount = Number(values[schema.findIndex((s) => s.name === repeat.countField)]);
  for (let i = 0; i < lineCount; i += 1) specs.push(...repeat.fields);
  if (specs.length !== values.length) throw new Error(`${opCode}: the stream does not have the schema's length`);
  return values.map((value, i) => {
    const s = specs[i];
    if (s === undefined) throw new Error('unreachable');
    return { name: s.name, type: s.type, value };
  });
}

/** The intent fields of a payload: the header fields the intent schema keeps, then its line fields per line (by position). */
function intentOf(opCode: InventoryS5OperationCode, fields: readonly S5VectorField[]): S5VectorField[] {
  const schema = INVENTORY_PAYLOAD_SCHEMAS[opCode];
  const intent = inventoryIntentSchema(opCode);
  const header = new Set(intent.map((s) => s.name));
  const lineKeep = new Set((intent.repeat?.fields ?? []).map((s) => s.name));
  return fields.filter((f, i) => (i < schema.length ? header.has(f.name) : lineKeep.has(f.name)));
}

type RoutineArgs = Readonly<Record<string, unknown>>;

interface RawPayloadCase {
  readonly id: string;
  readonly why: string;
  readonly opCode: InventoryS5OperationCode;
  readonly routine: string;
  readonly args: RoutineArgs;
  readonly build: () => MovementPayload;
}

function returnArgs(i: SupplierReturnPayloadInput): RoutineArgs {
  return {
    p_return_id: i.returnId,
    p_purchase_id: i.purchaseId,
    p_warehouse_id: i.warehouseId,
    p_document_date: i.documentDate,
    p_reason: i.reason,
    p_credit_note_id: i.creditNoteId,
    p_carrying_txn_minor: formatMinor(i.carryingTxnMinor),
    p_ap_txn_minor: formatMinor(i.apTxnMinor),
    p_ap_base_minor: formatMinor(i.apBaseMinor),
    p_credit_txn_minor: formatMinor(i.creditTxnMinor),
    p_credit_base_minor: formatMinor(i.creditBaseMinor),
    p_inventory_value_base_minor: formatMinor(i.inventoryValueMinor),
    p_ppv_base_minor: formatMinor(i.ppvMinor),
    p_line_ids: i.lines.map((l) => l.returnLineId),
    p_purchase_line_ids: i.lines.map((l) => l.purchaseLineId),
    p_variant_ids: i.lines.map((l) => l.variantId),
    p_qtys: i.lines.map((l) => formatQuantity(l.qtyQ4)),
    p_carrying_txns: i.lines.map((l) => formatMinor(l.carryingTxnMinor)),
    p_values_out: i.lines.map((l) => formatMinor(l.valueOutMinor)),
  };
}

function reverseArgs(i: PurchaseReversePayloadInput): RoutineArgs {
  return {
    p_purchase_id: i.purchaseId,
    p_warehouse_id: i.warehouseId,
    p_reversal_date: i.reversalDate,
    p_reason: i.reason,
    p_original_entry_id: i.originalEntryId,
    p_total_value_base_minor: formatMinor(i.totalValueMinor),
    p_line_ids: i.lines.map((l) => l.lineId),
    p_variant_ids: i.lines.map((l) => l.variantId),
    p_qtys: i.lines.map((l) => formatQuantity(l.qtyQ4)),
    p_values: i.lines.map((l) => formatMinor(l.valueMinor)),
  };
}

/** PPV-POSITIVE's first return, as the service binds it: no reason, no credit, Cr PPV 50. */
const RETURN_DOMESTIC: SupplierReturnPayloadInput = {
  ...tb,
  returnId: RET,
  purchaseId: PUR,
  warehouseId: W1,
  documentDate: '2026-09-25',
  reason: null,
  creditNoteId: null,
  carryingTxnMinor: 600n,
  apTxnMinor: 600n,
  apBaseMinor: 600n,
  creditTxnMinor: 0n,
  creditBaseMinor: 0n,
  inventoryValueMinor: 550n,
  ppvMinor: 50n,
  lines: [{ returnLineId: RL1, purchaseLineId: L1, variantId: V1, qtyQ4: toQ4('5'), carryingTxnMinor: 600n, valueOutMinor: 550n }],
};

/** The same return after the key's average moved (A-07): the same intent, a different payload — the `valuation_changed` retry. */
const RETURN_DOMESTIC_MOVED: SupplierReturnPayloadInput = {
  ...RETURN_DOMESTIC,
  inventoryValueMinor: 650n,
  ppvMinor: -50n,
  lines: [{ returnLineId: RL1, purchaseLineId: L1, variantId: V1, qtyQ4: toQ4('5'), carryingTxnMinor: 600n, valueOutMinor: 650n }],
};

/** Two lines from another warehouse, a reason, AP first with the excess to a credit note (A-11), a negative PPV. */
const RETURN_CREDIT: SupplierReturnPayloadInput = {
  ...tb,
  returnId: RET,
  purchaseId: PUR,
  warehouseId: W2,
  documentDate: '2026-09-26',
  reason: 'تالف عند الاستلام — مرتجع جزئي 📦',
  creditNoteId: CN,
  carryingTxnMinor: 4000n,
  apTxnMinor: 2500n,
  apBaseMinor: 9181n,
  creditTxnMinor: 1500n,
  creditBaseMinor: 5509n,
  inventoryValueMinor: 14700n,
  ppvMinor: -10n,
  lines: [
    { returnLineId: RL1, purchaseLineId: L1, variantId: V1, qtyQ4: toQ4('3.5'), carryingTxnMinor: 3500n, valueOutMinor: 12854n },
    { returnLineId: RL2, purchaseLineId: L3, variantId: V3, qtyQ4: toQ4('0.0001'), carryingTxnMinor: 500n, valueOutMinor: 1846n },
  ],
};

const REVERSE_ONE: PurchaseReversePayloadInput = {
  ...tb,
  purchaseId: PUR,
  warehouseId: W1,
  reversalDate: '2026-09-27',
  reason: 'Received against the wrong supplier',
  originalEntryId: ENTRY,
  totalValueMinor: 12500n,
  lines: [{ lineId: L1, variantId: V1, qtyQ4: toQ4('10'), valueMinor: 12500n }],
};

const REVERSE_THREE: PurchaseReversePayloadInput = {
  ...tb,
  purchaseId: PUR,
  warehouseId: W2,
  reversalDate: '2026-09-28',
  reason: 'إلغاء الاستلام — خطأ في الكمية',
  originalEntryId: ENTRY,
  totalValueMinor: 24786n,
  lines: [
    { lineId: L1, variantId: V1, qtyQ4: toQ4('3'), valueMinor: 4708n },
    { lineId: L2, variantId: V2, qtyQ4: toQ4('2.5'), valueMinor: 20078n },
    { lineId: L3, variantId: V3, qtyQ4: toQ4('1'), valueMinor: 0n },
  ],
};

const rawPayloadCases: readonly RawPayloadCase[] = [
  {
    id: 'S5-RET-01',
    why: 'one line, no reason (eight NULL words), no credit note (NULL): AP only, Cr PPV 50',
    opCode: 'purchase.return',
    routine: 'purchase_return',
    args: returnArgs(RETURN_DOMESTIC),
    build: () => supplierReturnPayload(RETURN_DOMESTIC),
  },
  {
    id: 'S5-RET-02',
    why: 'S5-RET-01 after the return key average moved: every amount re-bound, the SAME intent digest (A-07 valuation_changed retry)',
    opCode: 'purchase.return',
    routine: 'purchase_return',
    args: returnArgs(RETURN_DOMESTIC_MOVED),
    build: () => supplierReturnPayload(RETURN_DOMESTIC_MOVED),
  },
  {
    id: 'S5-RET-03',
    why: 'two lines from another warehouse, an Arabic reason with an emoji, AP first and the excess to a bound credit note id, a negative PPV, a Q4 of 0.0001',
    opCode: 'purchase.return',
    routine: 'purchase_return',
    args: returnArgs(RETURN_CREDIT),
    build: () => supplierReturnPayload(RETURN_CREDIT),
  },
  {
    id: 'S5-REV-01',
    why: 'a one-line domestic reversal: the line value is the purchase movement value and equals the total',
    opCode: 'purchase.reverse',
    routine: 'purchase_reverse',
    args: reverseArgs(REVERSE_ONE),
    build: () => purchaseReversePayload(REVERSE_ONE),
  },
  {
    id: 'S5-REV-02',
    why: 'a three-line reversal of the PA-USD-ILS-01 shares (4708, 20078, 0): a zero-value line is bound, an Arabic reason',
    opCode: 'purchase.reverse',
    routine: 'purchase_reverse',
    args: reverseArgs(REVERSE_THREE),
    build: () => purchaseReversePayload(REVERSE_THREE),
  },
];

function buildPayloadCase(c: RawPayloadCase): S5PayloadVector {
  const built = c.build();
  check(built.payload.opCode === c.opCode, `${c.id} built the wrong operation`);
  const payloadFields = expand(c.opCode, streamValues(built.payload.bytes));
  const intentFields = intentOf(c.opCode, payloadFields);
  const intentBytes = Buffer.from(['invpl/1', c.opCode, T, B, ...intentFields.map((f) => f.value ?? '\u0000')].map((l) => `${l}\n`).join(''), 'utf8');
  const intentSha = createHash('sha256').update(intentBytes).digest('hex');
  check(intentSha === built.intentSha256, `${c.id}: the builder's intent digest disagrees with the spec`);
  return {
    id: c.id,
    why: c.why,
    opCode: c.opCode,
    tenantId: T,
    businessId: B,
    routine: { name: c.routine, args: jsonable(c.args) as RoutineArgs },
    payload: { fields: payloadFields, canonicalHex: built.payload.bytes.toString('hex'), sha256: built.payload.sha256 },
    intent: { fields: intentFields, canonicalHex: intentBytes.toString('hex'), sha256: intentSha },
  };
}

export function buildInvplS5Vectors(): InvplS5Vectors {
  const cases = rawPayloadCases.map(buildPayloadCase);
  const get = (id: string): S5PayloadVector | undefined => cases.find((c) => c.id === id);
  check(get('S5-RET-01')?.intent.sha256 === get('S5-RET-02')?.intent.sha256, 'a return intent carries no amount');
  check(get('S5-RET-01')?.payload.sha256 !== get('S5-RET-02')?.payload.sha256, 'a return payload binds every amount');
  const reverseIntent = get('S5-REV-01')?.intent.fields.map((f) => f.name) ?? [];
  check(
    JSON.stringify(reverseIntent) ===
      JSON.stringify(['purchase_id', 'warehouse_id', 'reversal_date', ...Array.from({ length: 8 }, (_, i) => `reason_w${i + 1}`)]),
    'a reversal intent is the purchase, its warehouse, the date and the reason',
  );
  return {
    spec: 'invpl/1 for the two P3-S5 operation kinds (PHASE_3_S5_CONTRACT A-17)',
    note:
      'Generated by packages/inventory/scripts/generate-s5-vectors.ts and verified by packages/inventory/test/supplier-return-payloads.test.ts ' +
      'and test/purchase-reversal-payloads.test.ts. payload is the stream the invctl/1 assertion signs; intent is the stream whose digest ' +
      'the document stores (a return: return_id, purchase_id, warehouse_id, document_date, reason_w1..w8, line_count and per line ' +
      'return_line_id, purchase_line_id, qty_q4; a reversal: purchase_id, warehouse_id, reversal_date, reason_w1..w8). Field values are ' +
      'canonical invpl/1 text or JSON null for SQL NULL: _q4 = qty x 10^4; *_txn in purchase-currency minor units, every other amount in ' +
      'base minor units, ppv signed; dates YYYYMMDD; reason_w1..w8 the SHA-256 of the trimmed reason as eight uint32 big-endian words ' +
      '(eight NULLs for no reason). routine.args are the entry routine arguments that rebuild the same payload.',
    cases,
  };
}

export function renderInvplS5Vectors(): Promise<string> {
  return renderJson(buildInvplS5Vectors(), 'invpl-s5-vectors.json');
}

// ── Supplier-return arithmetic (A-10) ────────────────────────────────────

export interface StockStateVector {
  readonly onHand: string;
  readonly valuation: string;
  readonly avg: string | null;
}

export interface EntryLineVector {
  readonly systemKey: string;
  readonly side: 'D' | 'C';
  readonly currency: string;
  readonly txnAmountMinor: string;
  readonly baseAmountMinor: string;
  /** NUMERIC(20,10) text: the purchase snapshot for a purchase-currency line, 1 for a base line. */
  readonly rate: string;
  /** purchase: the purchase warehouse's home branch, no warehouse; return: the return warehouse and its home branch. */
  readonly dimension: 'purchase' | 'return';
}

export interface ReturnVector {
  /** derived: T − Σ ap_txn of the earlier returns (the S5 body of purchase_ap_outstanding); fixture: the settlement fixture's value (§5). */
  readonly outstanding: { readonly source: 'derived' | 'fixture'; readonly txnMinor: string };
  readonly lines: readonly { readonly lineNo: number; readonly qty: string }[];
  readonly outcome: string;
  readonly expect: {
    readonly lines: readonly {
      readonly lineNo: number;
      readonly returnedBefore: string;
      readonly carryingTxnMinor: string;
      readonly valueOutMinor: string;
      readonly unitCostBaseMinor: string;
      readonly stockAfter: StockStateVector;
    }[];
    readonly carryingTxnMinor: string;
    readonly apTxnMinor: string;
    readonly apBaseMinor: string;
    readonly apConvertedMinor: string;
    readonly apDustBaseMinor: string;
    readonly creditTxnMinor: string;
    readonly creditBaseMinor: string;
    readonly inventoryValueMinor: string;
    readonly ppvMinor: string;
    readonly creditNote: boolean;
    readonly entry: readonly EntryLineVector[];
  } | null;
}

export interface SupplierReturnCaseVector {
  readonly id: string;
  readonly why: string;
  readonly purchase: {
    readonly txnCurrency: string;
    readonly txnMinorUnits: number;
    readonly baseCurrency: string;
    readonly baseMinorUnits: number;
    /** NUMERIC(20,10) text. */
    readonly rate: string;
    readonly totalTxnMinor: string;
    /** The 0043 conversion of T. */
    readonly totalBaseMinor: string;
    readonly lines: readonly {
      readonly lineNo: number;
      readonly qty: string;
      readonly netTxnMinor: string;
      readonly landedTxnMinor: string;
      /** t_i = net + landed (TL-11). */
      readonly lineTotalTxnMinor: string;
      /** s_i = LR(B; t_i). */
      readonly baseShareMinor: string;
      readonly unitCostBaseMinor: string;
      /** Stock the return key held before the receipt (an S3 opening at this unit cost), or null. */
      readonly openingBefore: { readonly qty: string; readonly unitCost: string } | null;
      readonly stockAfterReceipt: StockStateVector;
    }[];
  };
  readonly returns: readonly ReturnVector[];
  /** Σ over the accepted returns. */
  readonly totals: { readonly apTxnMinor: string; readonly apBaseMinor: string; readonly creditTxnMinor: string; readonly creditBaseMinor: string };
  /** Only for CUMULATIVE-THIRDS: the rejected naive HALF_EVEN(t x q / qty) with a last-return flush, per return. */
  readonly naiveProportionalPlusFlush?: readonly string[];
}

export interface SupplierReturnVectors {
  readonly version: string;
  readonly note: string;
  readonly cases: readonly SupplierReturnCaseVector[];
}

/** The 0043 law in the generator only: the package leaves the conversion to @daftar/accounting (§4.1). */
function convert(txnMinor: bigint, rate: string, et: number, eb: number): bigint {
  const up = 10n ** BigInt(Math.max(0, eb - et));
  const down = 10n ** BigInt(Math.max(0, et - eb));
  return roundHalfEven(txnMinor * toC10(rate) * up, 10n ** 10n * down);
}

const stateVector = (s: StockState): StockStateVector => ({
  onHand: formatQuantity(s.onHand),
  valuation: formatMinor(s.valuation),
  avg: s.avg === null ? null : formatUnitCost(s.avg),
});

interface RawLine {
  readonly qty: string;
  readonly net: bigint;
  readonly landed: bigint;
  readonly opening: { readonly qty: string; readonly unitCost: string } | null;
}

interface RawReturn {
  /** null: derived; a value: the settlement fixture's outstanding. */
  readonly fixtureOutstanding: bigint | null;
  readonly lines: readonly { readonly lineNo: number; readonly qty: string }[];
}

interface RawSupplierReturnCase {
  readonly id: string;
  readonly why: string;
  readonly txn: readonly [string, number];
  readonly base: readonly [string, number];
  readonly rate: string;
  readonly lines: readonly RawLine[];
  readonly returns: readonly RawReturn[];
  /** LITERAL, per return: the outcome, then (when accepted) carrying, ap_txn, ap_base, dust, credit_txn, credit_base, I, ppv. */
  readonly literal: readonly string[];
}

const ILS: readonly [string, number] = ['ILS', 2];
const JOD: readonly [string, number] = ['JOD', 3];
const USD: readonly [string, number] = ['USD', 2];
const one = (lineNo: number, qty: string): RawReturn => ({ fixtureOutstanding: null, lines: [{ lineNo, qty }] });

const supplierReturnCases: readonly RawSupplierReturnCase[] = [
  {
    id: 'CUMULATIVE-THIRDS',
    why: 't = 100, qty = 3, three returns of 1: cumulative 33, 34, 33 (sum 100); the naive proportional-plus-flush form gives 33, 33, 34; a fourth return crosses qty',
    txn: ILS,
    base: ILS,
    rate: '1',
    lines: [{ qty: '3', net: 100n, landed: 0n, opening: null }],
    returns: [one(1, '1'), one(1, '1'), one(1, '1'), one(1, '1')],
    literal: ['accepted:33:33:33:0:0:0:33:0', 'accepted:34:34:34:0:0:0:34:0', 'accepted:33:33:33:0:0:0:33:0', 'supplier_return.quantity_exceeds_purchased'],
  },
  {
    id: 'FULL-RETURN-EXACT',
    why: 'two lines returned whole in one return: carrying = t_i, AP released = T and B exactly, the keys flush to zero, no PPV line',
    txn: ILS,
    base: ILS,
    rate: '1',
    lines: [
      { qty: '7', net: 2999n, landed: 0n, opening: null },
      { qty: '0.3', net: 1n, landed: 0n, opening: null },
    ],
    returns: [
      {
        fixtureOutstanding: null,
        lines: [
          { lineNo: 1, qty: '7' },
          { lineNo: 2, qty: '0.3' },
        ],
      },
    ],
    literal: ['accepted:3000:3000:3000:0:0:0:3000:0'],
  },
  {
    id: 'LANDED-INCLUDED',
    why: 'net 1000 + landed 101 over 4 (TL-11): one returned carries HALF_EVEN(1101 / 4) = 275; the key (4 opened at 2.50 + the receipt) averages 262.625 -> 263; Cr PPV 12',
    txn: ILS,
    base: ILS,
    rate: '1',
    lines: [{ qty: '4', net: 1000n, landed: 101n, opening: { qty: '4', unitCost: '250' } }],
    returns: [one(1, '1')],
    literal: ['accepted:275:275:275:0:0:0:263:12'],
  },
  {
    id: 'FOREIGN-DUST',
    why: 'JOD (3 dp) at 5.1 into ILS (2 dp): T = 1001 fils, B = 511; three returns of 1 release 171, 169, 171 (sum B) while convert gives 170 each: dust +1, -1, +1; PPV +1, -1, 0',
    txn: JOD,
    base: ILS,
    rate: '5.1',
    lines: [{ qty: '3', net: 1001n, landed: 0n, opening: null }],
    returns: [one(1, '1'), one(1, '1'), one(1, '1')],
    literal: ['accepted:334:334:171:1:0:0:170:1', 'accepted:333:333:169:-1:0:0:170:-1', 'accepted:334:334:171:1:0:0:171:0'],
  },
  {
    id: 'AP-FIRST-EXCESS',
    why: 'USD at 3.6725, the fixture says O = 2500 < C = 4000: AP takes 2500 (the whole remaining B share, 9181), 1500 goes to a credit note at 5509 base',
    txn: USD,
    base: ILS,
    rate: '3.6725',
    lines: [{ qty: '10', net: 10000n, landed: 0n, opening: null }],
    returns: [{ fixtureOutstanding: 2500n, lines: [{ lineNo: 1, qty: '4' }] }],
    literal: ['accepted:4000:2500:9181:0:1500:5509:14690:0'],
  },
  {
    id: 'AP-EXHAUSTED',
    why: 'the fixture says O = 0: no AP line, the whole carrying value is a supplier credit (Dr 1150), ap_base = 0',
    txn: ILS,
    base: ILS,
    rate: '1',
    lines: [{ qty: '5', net: 5000n, landed: 0n, opening: null }],
    returns: [{ fixtureOutstanding: 0n, lines: [{ lineNo: 1, qty: '2' }] }],
    literal: ['accepted:2000:0:0:0:2000:2000:2000:0'],
  },
  {
    id: 'PPV-POSITIVE',
    why: 'the key held 10 at 1.00 before a receipt of 10 at 1.20 (average 1.10): returning 5 gives back 600 of carrying for 550 of stock, Cr PPV 50',
    txn: ILS,
    base: ILS,
    rate: '1',
    lines: [{ qty: '10', net: 1200n, landed: 0n, opening: { qty: '10', unitCost: '100' } }],
    returns: [one(1, '5')],
    literal: ['accepted:600:600:600:0:0:0:550:50'],
  },
  {
    id: 'PPV-NEGATIVE',
    why: 'the key held 10 at 1.40 before a receipt of 10 at 1.20 (average 1.30): returning 5 gives back 600 of carrying for 650 of stock, Dr PPV 50',
    txn: ILS,
    base: ILS,
    rate: '1',
    lines: [{ qty: '10', net: 1200n, landed: 0n, opening: { qty: '10', unitCost: '140' } }],
    returns: [one(1, '5')],
    literal: ['accepted:600:600:600:0:0:0:650:-50'],
  },
  {
    id: 'VALUE-ZERO',
    why: 'a line discounted to a zero total carries nothing, and its key (share 0) is valued at 0: C = 0 and I = 0 is refused (TL-12); the other line then returns',
    txn: ILS,
    base: ILS,
    rate: '1',
    lines: [
      { qty: '1', net: 1000n, landed: 0n, opening: null },
      { qty: '2', net: 0n, landed: 0n, opening: null },
    ],
    returns: [one(2, '1'), one(1, '1')],
    literal: ['supplier_return.value_zero', 'accepted:1000:1000:1000:0:0:0:1000:0'],
  },
  {
    id: 'BELOW-BASE-UNIT',
    why: 'JOD at 4.9: T = 10 fils, B = 5; returning 1 of 10 carries 1 fil, which converts to 0.49 -> 0 agorot: refused (TL-3); then returning 2 carries 2 fils = 0.98 -> 1',
    txn: JOD,
    base: ILS,
    rate: '4.9',
    lines: [{ qty: '10', net: 10n, landed: 0n, opening: null }],
    returns: [one(1, '1'), one(1, '2')],
    literal: ['supplier_return.amount_below_base_unit', 'accepted:2:2:1:0:0:0:1:0'],
  },
];

const RATE_ONE = formatUnitCost(10n ** 10n);

function entryVector(plan: SupplierReturnPlan, txnCurrency: string, baseCurrency: string, rate: string): EntryLineVector[] {
  return plan.entryLines.map((l) => ({
    systemKey: l.systemKey,
    side: l.side,
    currency: l.currency === 'purchase' ? txnCurrency : baseCurrency,
    txnAmountMinor: formatMinor(l.txnAmountMinor),
    baseAmountMinor: formatMinor(l.baseAmountMinor),
    rate: l.currency === 'purchase' ? rate : RATE_ONE,
    dimension: l.dimension,
  }));
}

function buildSupplierReturnCase(c: RawSupplierReturnCase): SupplierReturnCaseVector {
  const [txnCurrency, et] = c.txn;
  const [baseCurrency, eb] = c.base;
  const rate = formatUnitCost(toC10(c.rate));
  const totals = c.lines.map((l) => l.net + l.landed);
  const totalTxn = totals.reduce((a, b) => a + b, 0n);
  const totalBase = convert(totalTxn, c.rate, et, eb);
  const shares = baseShares(totalBase, totals);

  // The return key of each line: an opening at a cost (S3), then the receipt (S4).
  const states = c.lines.map((l, i) => {
    let s: StockState = EMPTY_STOCK_STATE;
    if (l.opening !== null)
      s = simulateMovement(s, { kind: 'inventory_opening', qtyQ4: toQ4(l.opening.qty), costC10: toC10(l.opening.unitCost), value: null }).next;
    const qty = toQ4(l.qty);
    const share = shares[i] ?? 0n;
    return simulateMovement(s, { kind: 'purchase', qtyQ4: qty, costC10: unitCostC10(share, qty), value: share }).next;
  });
  const purchaseLines = c.lines.map((l, i) => ({
    lineNo: i + 1,
    qty: formatQuantity(toQ4(l.qty)),
    netTxnMinor: formatMinor(l.net),
    landedTxnMinor: formatMinor(l.landed),
    lineTotalTxnMinor: formatMinor(totals[i] ?? 0n),
    baseShareMinor: formatMinor(shares[i] ?? 0n),
    unitCostBaseMinor: formatUnitCost(unitCostC10(shares[i] ?? 0n, toQ4(l.qty))),
    openingBefore: l.opening === null ? null : { qty: formatQuantity(toQ4(l.opening.qty)), unitCost: formatUnitCost(toC10(l.opening.unitCost)) },
    stockAfterReceipt: stateVector(states[i] ?? EMPTY_STOCK_STATE),
  }));

  const returned = c.lines.map(() => 0n);
  let apTxnSum = 0n;
  let apBaseSum = 0n;
  let creditTxnSum = 0n;
  let creditBaseSum = 0n;
  const returns = c.returns.map((r, n): ReturnVector => {
    const outstanding = r.fixtureOutstanding ?? totalTxn - apTxnSum;
    const idx = r.lines.map((l) => l.lineNo - 1);
    const { outcome, value: plan } = attempt(() =>
      planSupplierReturn({
        totalTxnMinor: totalTxn,
        totalBaseMinor: totalBase,
        outstandingTxnMinor: outstanding,
        convert: (x) => convert(x, c.rate, et, eb),
        lines: r.lines.map((l, k) => {
          const i = idx[k] ?? -1;
          const line = c.lines[i];
          if (line === undefined) throw new Error(`${c.id}: no line ${l.lineNo}`);
          return {
            lineTotalTxnMinor: totals[i] ?? 0n,
            purchasedQ4: toQ4(line.qty),
            returnedBeforeQ4: returned[i] ?? 0n,
            returnQ4: toQ4(l.qty),
            stock: states[i] ?? EMPTY_STOCK_STATE,
          };
        }),
      }),
    );
    const got =
      plan === null
        ? outcome
        : [
            outcome,
            plan.carryingTxnMinor,
            plan.apTxnMinor,
            plan.apBaseMinor,
            plan.apDustBaseMinor,
            plan.creditTxnMinor,
            plan.creditBaseMinor,
            plan.inventoryValueMinor,
            plan.ppvMinor,
          ].join(':');
    check(got === c.literal[n], `${c.id} return ${n + 1}: the package computes ${got}`);
    const before = idx.map((i) => returned[i] ?? 0n);
    if (plan !== null) {
      // What this return stored is the next one's starting point.
      plan.lines.forEach((l, k) => {
        const i = idx[k] ?? -1;
        states[i] = l.stockAfter;
        returned[i] = (returned[i] ?? 0n) + toQ4(r.lines[k]?.qty ?? '0');
      });
      apTxnSum += plan.apTxnMinor;
      apBaseSum += plan.apBaseMinor;
      creditTxnSum += plan.creditTxnMinor;
      creditBaseSum += plan.creditBaseMinor;
    }
    return {
      outstanding: { source: r.fixtureOutstanding === null ? 'derived' : 'fixture', txnMinor: formatMinor(outstanding) },
      lines: r.lines.map((l) => ({ lineNo: l.lineNo, qty: formatQuantity(toQ4(l.qty)) })),
      outcome,
      expect:
        plan === null
          ? null
          : {
              lines: plan.lines.map((l, k) => ({
                lineNo: r.lines[k]?.lineNo ?? 0,
                returnedBefore: formatQuantity(before[k] ?? 0n),
                carryingTxnMinor: formatMinor(l.carryingTxnMinor),
                valueOutMinor: formatMinor(l.valueOutMinor),
                unitCostBaseMinor: formatUnitCost(l.unitCostSnapshotC10),
                stockAfter: stateVector(l.stockAfter),
              })),
              carryingTxnMinor: formatMinor(plan.carryingTxnMinor),
              apTxnMinor: formatMinor(plan.apTxnMinor),
              apBaseMinor: formatMinor(plan.apBaseMinor),
              apConvertedMinor: formatMinor(plan.apConvertedMinor),
              apDustBaseMinor: formatMinor(plan.apDustBaseMinor),
              creditTxnMinor: formatMinor(plan.creditTxnMinor),
              creditBaseMinor: formatMinor(plan.creditBaseMinor),
              inventoryValueMinor: formatMinor(plan.inventoryValueMinor),
              ppvMinor: formatMinor(plan.ppvMinor),
              creditNote: plan.creditNote,
              entry: entryVector(plan, txnCurrency, baseCurrency, rate),
            },
    };
  });

  const vector: SupplierReturnCaseVector = {
    id: c.id,
    why: c.why,
    purchase: {
      txnCurrency,
      txnMinorUnits: et,
      baseCurrency,
      baseMinorUnits: eb,
      rate,
      totalTxnMinor: formatMinor(totalTxn),
      totalBaseMinor: formatMinor(totalBase),
      lines: purchaseLines,
    },
    returns,
    totals: {
      apTxnMinor: formatMinor(apTxnSum),
      apBaseMinor: formatMinor(apBaseSum),
      creditTxnMinor: formatMinor(creditTxnSum),
      creditBaseMinor: formatMinor(creditBaseSum),
    },
  };
  if (c.id !== 'CUMULATIVE-THIRDS') return vector;
  // The rejected form (A-10(a)): HALF_EVEN(t x q / qty) per return, the last one flushed to t.
  const t = totals[0] ?? 0n;
  const qty = toQ4(c.lines[0]?.qty ?? '0');
  const q = toQ4('1');
  const naive = [roundHalfEven(t * q, qty), roundHalfEven(t * q, qty)];
  naive.push(t - (naive[0] ?? 0n) - (naive[1] ?? 0n));
  return { ...vector, naiveProportionalPlusFlush: naive.map(formatMinor) };
}

export function buildSupplierReturnVectors(): SupplierReturnVectors {
  const cases = supplierReturnCases.map(buildSupplierReturnCase);
  const get = (id: string): SupplierReturnCaseVector | undefined => cases.find((c) => c.id === id);
  // The contract's own statements about these cases, held here as well.
  const thirds = get('CUMULATIVE-THIRDS');
  const cumulative = thirds?.returns.slice(0, 3).map((r) => r.expect?.carryingTxnMinor);
  check(JSON.stringify(cumulative) === JSON.stringify(['33', '34', '33']), 'CUMULATIVE-THIRDS is 33, 34, 33');
  check(JSON.stringify(thirds?.naiveProportionalPlusFlush) !== JSON.stringify(cumulative), 'the naive form differs from the cumulative one');
  for (const id of ['CUMULATIVE-THIRDS', 'FULL-RETURN-EXACT', 'FOREIGN-DUST']) {
    const c = get(id);
    check(c?.totals.apTxnMinor === c?.purchase.totalTxnMinor && c?.totals.apBaseMinor === c?.purchase.totalBaseMinor, `${id} releases T and B exactly`);
  }
  const dust = get('FOREIGN-DUST')?.returns.map((r) => r.expect?.entry.find((e) => e.systemKey === 'accounts_payable' && e.currency === 'ILS')?.side);
  check(JSON.stringify(dust) === JSON.stringify(['D', 'C', 'D']), 'FOREIGN-DUST posts a dust line of each sign');
  const exhausted = get('AP-EXHAUSTED')?.returns[0]?.expect?.entry.map((e) => e.systemKey);
  check(JSON.stringify(exhausted) === JSON.stringify(['supplier_receivable', 'inventory']), 'AP-EXHAUSTED posts no AP line');
  const ppvSide = (id: string): string | undefined => get(id)?.returns[0]?.expect?.entry.find((e) => e.systemKey === 'purchase_price_variance')?.side;
  check(ppvSide('PPV-POSITIVE') === 'C' && ppvSide('PPV-NEGATIVE') === 'D', 'a positive PPV credits 6200, a negative one debits it');
  check(get('AP-FIRST-EXCESS')?.returns[0]?.expect?.creditNote === true, 'AP-FIRST-EXCESS issues a credit note');
  return {
    version: 'invsupret/1',
    note:
      'Generated by packages/inventory/scripts/generate-s5-vectors.ts and verified by packages/inventory/test/supplier-return.test.ts ' +
      '(PHASE_3_S5_CONTRACT A-10). purchase: t_i = net + landed, T = sum t_i, B = the 0043 conversion of T at rate (HALF_EVEN(T x rate x ' +
      '10^max(0, eb-et) / 10^max(0, et-eb))), s_i = LR(B; t_i); the return key of each line holds openingBefore (an opening at that unit ' +
      'cost) then the receipt (qty_i at s_i), and the goods leave that key. Per return, in order, each starting from what the previous ' +
      'accepted one stored: carrying_i = HALF_EVEN(t_i x (Q_i + q_i), qty_i) - HALF_EVEN(t_i x Q_i, qty_i); C = sum; O = outstanding ' +
      '(derived: T - sum of earlier ap_txn; fixture: the settlement fixture); ap_txn = min(C, O), credit_txn = C - ap_txn; ap_base = ' +
      'HALF_EVEN(B x (T - O + ap_txn), T) - HALF_EVEN(B x (T - O), T); apConverted = convert(ap_txn), dust = ap_base - apConverted, ' +
      'credit_base = convert(credit_txn); value_out_i = the outbound value at the key average (the flush at depletion); I = sum; ppv = ' +
      'ap_base + credit_base - I. Refusals in order: supplier_return.quantity_exceeds_purchased, supplier_return.amount_below_base_unit ' +
      '(a positive txn amount converting to 0), inventory.insufficient_stock, supplier_return.value_zero (C = 0 and I = 0). entry: the ' +
      'A-10(g) lines in order, each only when non-zero.',
    cases,
  };
}

export function renderSupplierReturnVectors(): Promise<string> {
  return renderJson(buildSupplierReturnVectors(), 'supplier-return-vectors.json');
}
