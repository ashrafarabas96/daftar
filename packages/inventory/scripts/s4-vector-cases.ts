/**
 * The shared P3-S4 vectors, as pure functions (PHASE_3_S4_CONTRACT §4.1).
 *
 * `scripts/generate-s4-vectors.ts` writes:
 *
 * - `vectors/invpl-s4-vectors.json` — the `invpl/1` payload AND intent streams
 *   of the seven P3-S4 kinds, built by `src/supplier-payloads.ts` and
 *   `src/purchase-payloads.ts`, with the exact entry-routine arguments that
 *   rebuild each stream in SQL, plus text-word cases;
 * - `vectors/landed-cost-vectors.json` — A-13 steps 1–8 by
 *   `src/landed-cost.ts` and `src/purchase-shares.ts`;
 * - `vectors/coverage-vectors.json` — A-16 by `src/deficit-coverage.ts`.
 *
 * Every number in the files is COMPUTED by the package; nothing is copied by
 * hand. Where the contract states a number (GOLD-54/55/72, the flush residue,
 * the landed-cost splits), the generator holds the computation to that
 * LITERAL and refuses to write a file in which they disagree, so the JSON
 * records the specification, not whatever the code happens to do.
 *
 * The unit suites rebuild all three files and require them byte-identical;
 * the SQL routines are held to the SAME files (T-05, T-08). Every integer is
 * decimal TEXT, because a value may exceed 2^53.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { planCoverage, type CoveragePlan, type DeficitLayer } from '../src/deficit-coverage';
import { InventoryError } from '../src/errors';
import { formatMinor, formatQuantity, formatUnitCost, parseMinor } from '../src/fixed-point';
import { allocateByValue, lineTotals, validateManual, type LandedCostInput, type PurchaseLineInput } from '../src/landed-cost';
import { toC10, toQ4, type MovementPayload } from '../src/movement-payloads';
import {
  DOMESTIC_RATE_R10,
  purchaseCancelPayload,
  purchaseDraftPayload,
  purchaseReceivePayload,
  type PurchaseDraftPayloadInput,
  type PurchaseReceivePayloadInput,
} from '../src/purchase-payloads';
import { baseShares, unitCostC10 } from '../src/purchase-shares';
import { INVENTORY_PAYLOAD_SCHEMAS, inventoryIntentSchema, type InventoryPayloadFieldSpec, type InventoryS4OperationCode } from '../src/payload';
import { roundHalfEven } from '../src/rounding';
import {
  documentTextWords,
  supplierArchivePayload,
  supplierCreatePayload,
  supplierReactivatePayload,
  supplierUpdatePayload,
  type SupplierText,
} from '../src/supplier-payloads';
import { EMPTY_STOCK_STATE, type StockState } from '../src/valuation';

// ── Shapes ───────────────────────────────────────────────────────────────

export interface S4VectorField {
  readonly name: string;
  readonly type: InventoryPayloadFieldSpec['type'];
  readonly value: string | null;
}

export interface S4StreamVector {
  readonly fields: readonly S4VectorField[];
  readonly canonicalHex: string;
  readonly sha256: string;
}

export interface S4PayloadVector {
  readonly id: string;
  readonly why: string;
  readonly opCode: InventoryS4OperationCode;
  readonly tenantId: string;
  readonly businessId: string;
  /** The entry routine and the exact arguments (as SQL literals' text; arrays as JSON arrays; NULL as null) from which it rebuilds `payload`. */
  readonly routine: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
  readonly payload: S4StreamVector;
  readonly intent: S4StreamVector;
}

export interface TextWordVector {
  readonly id: string;
  readonly why: string;
  readonly text: string;
  readonly utf8Hex: string;
  readonly sha256: string;
  readonly words: readonly string[];
}

export interface InvplS4Vectors {
  readonly spec: string;
  readonly note: string;
  readonly texts: readonly TextWordVector[];
  readonly cases: readonly S4PayloadVector[];
}

// ── Identifiers (fixed test material) ────────────────────────────────────

const T = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const B = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const tb = { tenantId: T, businessId: B };
const SUP = 'a1b2c3d4-0001-4a00-8a00-000000000001';
const PUR = 'a1b2c3d4-0002-4a00-8a00-000000000002';
const W1 = '3d6a4adc-4fc3-11d2-9a0c-0305e82c3303';
const W2 = '4e7b5bed-50d4-41d2-8a0c-0305e82c3304';
const V1 = '16fd2706-8baf-433b-82eb-8c7fada847da';
const V2 = '2a9c1b4e-6f3d-4e8a-b1c7-5d0e9f2a3b4c';
const V3 = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
const L1 = 'b0000000-0000-4000-8000-000000000001';
const L2 = 'b0000000-0000-4000-8000-000000000002';
const L3 = 'b0000000-0000-4000-8000-000000000003';
const LC1 = 'c0000000-0000-4000-8000-000000000001';
const LC2 = 'c0000000-0000-4000-8000-000000000002';
const RATE = 'd0000000-0000-4000-8000-000000000001';
const ADJ = 'e0000000-0000-4000-8000-000000000001';
const D1 = 'f0000000-0000-4000-8000-000000000001';
const D2 = 'f0000000-0000-4000-8000-000000000002';
const D3 = 'f0000000-0000-4000-8000-000000000003';

// ── Common helpers ───────────────────────────────────────────────────────

function jsonable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(jsonable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonable(v)]));
  return value;
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

/** Names and types of every field of a stream, walking header, lines and trailer by the counts actually encoded. */
function expand(opCode: InventoryS4OperationCode, values: readonly (string | null)[]): S4VectorField[] {
  const schema = INVENTORY_PAYLOAD_SCHEMAS[opCode];
  const specs: InventoryPayloadFieldSpec[] = [...schema];
  const repeat = schema.repeat;
  if (repeat !== undefined) {
    const lineCount = Number(values[schema.findIndex((s) => s.name === repeat.countField)]);
    for (let i = 0; i < lineCount; i += 1) specs.push(...repeat.fields);
    const trailer = schema.trailer;
    if (trailer !== undefined) {
      specs.push(trailer.countField);
      const count = Number(values[specs.length - 1]);
      for (let k = 0; k < count; k += 1) {
        specs.push(...trailer.fields);
        if (trailer.perLine !== undefined) for (let i = 0; i < lineCount; i += 1) specs.push(trailer.perLine);
      }
    }
  }
  if (specs.length !== values.length) throw new Error(`${opCode}: the stream does not have the schema's length`);
  return values.map((value, i) => {
    const s = specs[i];
    if (s === undefined) throw new Error('unreachable');
    return { name: s.name, type: s.type, value };
  });
}

async function renderJson(value: unknown, file: string): Promise<string> {
  const options = (await resolveConfig(join(__dirname, '..', 'vectors', file))) ?? {};
  return format(JSON.stringify(value, null, 2), { ...options, parser: 'json' });
}

/** The code a refusal carries, or 'accepted'. */
function outcome(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof InventoryError) return e.code;
    throw e;
  }
  return 'accepted';
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`vector spec disagreement: ${message}`);
}

/** Epoch seconds of an ISO instant with second precision. */
const epoch = (iso: string): bigint => BigInt(Date.parse(iso) / 1000);

// ── invpl/1 P3-S4 ────────────────────────────────────────────────────────

const ARABIC_NAME = 'شركة التوريدات الحديثة — فرع ٢';

const FULL_SUPPLIER: SupplierText = {
  name: ARABIC_NAME,
  phone: '+970 59 123 4567',
  email: 'orders@supplier.example',
  taxIdentifier: 'PS-562123456',
  notes: 'Delivers Sundays and Wednesdays 📦',
};

type RoutineArgs = Readonly<Record<string, unknown>>;

interface RawCase {
  readonly id: string;
  readonly why: string;
  readonly opCode: InventoryS4OperationCode;
  readonly routine: string;
  readonly args: RoutineArgs;
  readonly build: () => MovementPayload;
}

const supplierArgs = (t: SupplierText): RoutineArgs => ({
  p_name: t.name,
  p_phone: t.phone,
  p_email: t.email,
  p_tax_identifier: t.taxIdentifier,
  p_notes: t.notes,
});

function draftArgs(i: PurchaseDraftPayloadInput): RoutineArgs {
  return {
    p_purchase_id: i.purchaseId,
    p_expected_revision: i.expectedRevision,
    p_supplier_id: i.supplierId,
    p_warehouse_id: i.warehouseId,
    p_previous_warehouse_id: i.previousWarehouseId,
    p_currency_code: i.currency,
    p_document_date: i.documentDate,
    p_supplier_reference: i.supplierReference,
    p_notes: i.notes,
    p_tax_minor: formatMinor(i.taxMinor),
    p_line_ids: i.lines.map((l) => l.lineId),
    p_variant_ids: i.lines.map((l) => l.variantId),
    p_qtys: i.lines.map((l) => formatQuantity(l.qtyQ4)),
    p_unit_prices: i.lines.map((l) => formatUnitCost(l.unitPriceC10)),
    p_discounts: i.lines.map((l) => formatMinor(l.discountMinor)),
    p_lc_ids: i.landedCosts.map((c) => c.landedCostId),
    p_lc_modes: i.landedCosts.map((c) => c.mode),
    p_lc_amounts: i.landedCosts.map((c) => formatMinor(c.amountMinor)),
    p_lc_descriptions: i.landedCosts.map((c) => c.description),
    p_lc_allocations: i.landedCosts.flatMap((c) => i.lines.map((_, k) => (c.allocations === null ? null : formatMinor(c.allocations[k] ?? -1n)))),
  };
}

function receiveArgs(i: PurchaseReceivePayloadInput, rateAtIso: string): RoutineArgs {
  return {
    p_purchase_id: i.purchaseId,
    p_warehouse_id: i.warehouseId,
    p_draft_revision: i.draftRevision,
    p_supplier_id: i.supplierId,
    p_supplier_revision: i.supplierRevision,
    p_document_date: i.documentDate,
    p_currency_code: i.currency,
    p_rate_id: i.rate.rateId,
    p_rate: formatUnitCost(i.rate.rateR10),
    p_rate_source: i.rate.source,
    p_rate_at: rateAtIso,
    p_total_txn_minor: formatMinor(i.totalTxnMinor),
    p_total_base_minor: formatMinor(i.totalBaseMinor),
    p_coverage_adjustment_id: i.coverageAdjustmentId,
    p_line_ids: i.lines.map((l) => l.lineId),
    p_variant_ids: i.lines.map((l) => l.variantId),
    p_qtys: i.lines.map((l) => formatQuantity(l.qtyQ4)),
    p_base_shares: i.lines.map((l) => formatMinor(l.baseShareMinor)),
    p_covered_qtys: i.lines.map((l) => formatQuantity(l.coveredQ4)),
    p_catch_ups: i.lines.map((l) => formatMinor(l.catchUpMinor)),
  };
}

const DRAFT_CREATE: PurchaseDraftPayloadInput = {
  ...tb,
  purchaseId: PUR,
  expectedRevision: 0,
  supplierId: SUP,
  warehouseId: W1,
  previousWarehouseId: null,
  currency: 'ILS',
  documentDate: '2026-09-20',
  supplierReference: null,
  notes: null,
  taxMinor: 0n,
  lines: [{ lineId: L1, variantId: V1, qtyQ4: toQ4('10'), unitPriceC10: toC10('1250'), discountMinor: 0n }],
  landedCosts: [],
};

const DRAFT_REPLACE: PurchaseDraftPayloadInput = {
  ...tb,
  purchaseId: PUR,
  expectedRevision: 1,
  supplierId: SUP,
  warehouseId: W2,
  previousWarehouseId: W1,
  currency: 'USD',
  documentDate: '2026-09-21',
  supplierReference: 'INV-2026-0042',
  notes: 'فاتورة مورد — دفعة أولى',
  taxMinor: 0n,
  lines: [
    { lineId: L1, variantId: V1, qtyQ4: toQ4('3'), unitPriceC10: toC10('333.3333'), discountMinor: 0n },
    { lineId: L2, variantId: V2, qtyQ4: toQ4('2.5'), unitPriceC10: toC10('1999'), discountMinor: 500n },
    { lineId: L3, variantId: V3, qtyQ4: toQ4('1'), unitPriceC10: toC10('1000'), discountMinor: 1000n },
  ],
  landedCosts: [
    { landedCostId: LC1, mode: 'by_value', amountMinor: 1001n, description: null, allocations: null },
    { landedCostId: LC2, mode: 'manual', amountMinor: 250n, description: 'Freight from Haifa', allocations: [100n, 150n, 0n] },
  ],
};

const DRAFT_JOD: PurchaseDraftPayloadInput = {
  ...tb,
  purchaseId: PUR,
  expectedRevision: 2,
  supplierId: SUP,
  warehouseId: W2,
  previousWarehouseId: null,
  currency: 'JOD',
  documentDate: '2026-09-22',
  supplierReference: null,
  notes: null,
  taxMinor: 0n,
  lines: [
    { lineId: L1, variantId: V1, qtyQ4: toQ4('1.5'), unitPriceC10: toC10('12345.5'), discountMinor: 3n },
    { lineId: L2, variantId: V2, qtyQ4: toQ4('0.0001'), unitPriceC10: toC10('0.0000000001'), discountMinor: 0n },
  ],
  landedCosts: [{ landedCostId: LC1, mode: 'by_value', amountMinor: 7n, description: 'Customs broker handling', allocations: null }],
};

const RECEIVE_DOMESTIC: PurchaseReceivePayloadInput = {
  ...tb,
  purchaseId: PUR,
  warehouseId: W1,
  draftRevision: 1,
  supplierId: SUP,
  supplierRevision: 3,
  documentDate: '2026-09-20',
  currency: 'ILS',
  rate: { rateId: null, rateR10: DOMESTIC_RATE_R10, source: 'base', rateAtEpochSeconds: epoch('2026-09-20T00:00:00Z') },
  totalTxnMinor: 12500n,
  totalBaseMinor: 12500n,
  coverageAdjustmentId: null,
  lines: [{ lineId: L1, variantId: V1, qtyQ4: toQ4('10'), baseShareMinor: 12500n, coveredQ4: 0n, catchUpMinor: 0n }],
};

const RECEIVE_FOREIGN_COVERED: PurchaseReceivePayloadInput = {
  ...tb,
  purchaseId: PUR,
  warehouseId: W2,
  draftRevision: 2,
  supplierId: SUP,
  supplierRevision: 1,
  documentDate: '2026-09-21',
  currency: 'USD',
  rate: { rateId: RATE, rateR10: toC10('3.6725'), source: 'manual', rateAtEpochSeconds: epoch('2026-09-21T06:00:00Z') },
  totalTxnMinor: 6831n,
  totalBaseMinor: 25087n,
  coverageAdjustmentId: ADJ,
  lines: [
    { lineId: L1, variantId: V1, qtyQ4: toQ4('3'), baseShareMinor: 15015n, coveredQ4: toQ4('3'), catchUpMinor: -15n },
    { lineId: L2, variantId: V2, qtyQ4: toQ4('2.5'), baseShareMinor: 10072n, coveredQ4: 0n, catchUpMinor: 0n },
  ],
};

const RECEIVE_ZERO_CATCHUP: PurchaseReceivePayloadInput = {
  ...RECEIVE_DOMESTIC,
  coverageAdjustmentId: ADJ,
  lines: [{ lineId: L1, variantId: V1, qtyQ4: toQ4('10'), baseShareMinor: 12500n, coveredQ4: toQ4('4'), catchUpMinor: 0n }],
};

const rawCases: readonly RawCase[] = [
  {
    id: 'S4-SUP-CRT-01',
    why: 'every supplier field present: Arabic, an em dash, Arabic-Indic digits and a four-byte emoji are hashed as their exact UTF-8',
    opCode: 'supplier.create',
    routine: 'supplier_create',
    args: { p_supplier_id: SUP, ...supplierArgs(FULL_SUPPLIER) },
    build: () => supplierCreatePayload({ ...tb, supplierId: SUP, ...FULL_SUPPLIER }),
  },
  {
    id: 'S4-SUP-CRT-02',
    why: 'the name only: phone, email, tax identifier and notes are NULL, eight NULL words each',
    opCode: 'supplier.create',
    routine: 'supplier_create',
    args: { p_supplier_id: SUP, ...supplierArgs({ name: 'Acme', phone: null, email: null, taxIdentifier: null, notes: null }) },
    build: () => supplierCreatePayload({ ...tb, supplierId: SUP, name: 'Acme', phone: null, email: null, taxIdentifier: null, notes: null }),
  },
  {
    id: 'S4-SUP-UPD-01',
    why: 'an update at revision 1: the phone and the notes cleared (NULL), the rest restated',
    opCode: 'supplier.update',
    routine: 'supplier_update',
    args: { p_supplier_id: SUP, p_expected_revision: 1, ...supplierArgs({ ...FULL_SUPPLIER, phone: null, notes: null }) },
    build: () => supplierUpdatePayload({ ...tb, supplierId: SUP, expectedRevision: 1, ...FULL_SUPPLIER, phone: null, notes: null }),
  },
  {
    id: 'S4-SUP-UPD-02',
    why: 'an update at revision 7: only the email and the tax identifier NULL',
    opCode: 'supplier.update',
    routine: 'supplier_update',
    args: { p_supplier_id: SUP, p_expected_revision: 7, ...supplierArgs({ ...FULL_SUPPLIER, email: null, taxIdentifier: null }) },
    build: () => supplierUpdatePayload({ ...tb, supplierId: SUP, expectedRevision: 7, ...FULL_SUPPLIER, email: null, taxIdentifier: null }),
  },
  {
    id: 'S4-SUP-ARC-01',
    why: 'archive at revision 2',
    opCode: 'supplier.archive',
    routine: 'supplier_archive',
    args: { p_supplier_id: SUP, p_expected_revision: 2 },
    build: () => supplierArchivePayload({ ...tb, supplierId: SUP, expectedRevision: 2 }),
  },
  {
    id: 'S4-SUP-REA-01',
    why: 'reactivate at revision 2: the same fields as S4-SUP-ARC-01, a different digest by the op code line alone',
    opCode: 'supplier.reactivate',
    routine: 'supplier_reactivate',
    args: { p_supplier_id: SUP, p_expected_revision: 2 },
    build: () => supplierReactivatePayload({ ...tb, supplierId: SUP, expectedRevision: 2 }),
  },
  {
    id: 'S4-PDR-01',
    why: 'create (expected revision 0), domestic, one line, no landed cost: previous warehouse, reference and notes NULL',
    opCode: 'purchase.draft',
    routine: 'purchase_save_draft',
    args: draftArgs(DRAFT_CREATE),
    build: () => purchaseDraftPayload(DRAFT_CREATE),
  },
  {
    id: 'S4-PDR-02',
    why: 'a replace that moves the draft (previous warehouse bound), three lines with discounts, a by_value landed cost with a NULL description (NULL allocations) and a manual one',
    opCode: 'purchase.draft',
    routine: 'purchase_save_draft',
    args: draftArgs(DRAFT_REPLACE),
    build: () => purchaseDraftPayload(DRAFT_REPLACE),
  },
  {
    id: 'S4-PDR-03',
    why: 'JOD (3 minor units): a fractional quantity, a sub-minor unit price and a described by_value landed cost',
    opCode: 'purchase.draft',
    routine: 'purchase_save_draft',
    args: draftArgs(DRAFT_JOD),
    build: () => purchaseDraftPayload(DRAFT_JOD),
  },
  {
    id: 'S4-PCN-01',
    why: 'cancel a draft at revision 3',
    opCode: 'purchase.cancel',
    routine: 'purchase_cancel',
    args: { p_purchase_id: PUR, p_warehouse_id: W1, p_draft_revision: 3 },
    build: () => purchaseCancelPayload({ ...tb, purchaseId: PUR, warehouseId: W1, draftRevision: 3 }),
  },
  {
    id: 'S4-PRC-01',
    why: 'a domestic receipt covering nothing: rate id and coverage header id NULL, rate 1 at the document date midnight UTC',
    opCode: 'purchase.receive',
    routine: 'purchase_receive',
    args: receiveArgs(RECEIVE_DOMESTIC, '2026-09-20T00:00:00Z'),
    build: () => purchaseReceivePayload(RECEIVE_DOMESTIC),
  },
  {
    id: 'S4-PRC-02',
    why: 'a foreign receipt with a registry rate and a coverage header: one line covered with a negative catch-up, one not',
    opCode: 'purchase.receive',
    routine: 'purchase_receive',
    args: receiveArgs(RECEIVE_FOREIGN_COVERED, '2026-09-21T06:00:00Z'),
    build: () => purchaseReceivePayload(RECEIVE_FOREIGN_COVERED),
  },
  {
    id: 'S4-PRC-03',
    why: 'a covered receipt whose catch-up is zero (TL-5): the header id is bound, the catch-up is 0; the SAME intent digest as S4-PRC-01',
    opCode: 'purchase.receive',
    routine: 'purchase_receive',
    args: receiveArgs(RECEIVE_ZERO_CATCHUP, '2026-09-20T00:00:00Z'),
    build: () => purchaseReceivePayload(RECEIVE_ZERO_CATCHUP),
  },
];

const textCases: readonly { id: string; why: string; text: string }[] = [
  { id: 'TW-01', why: 'ASCII', text: 'Acme' },
  { id: 'TW-02', why: 'Arabic with an em dash and Arabic-Indic digits', text: ARABIC_NAME },
  { id: 'TW-03', why: 'a four-byte emoji', text: 'Delivers Sundays and Wednesdays 📦' },
];

function buildCase(c: RawCase): S4PayloadVector {
  const built = c.build();
  check(built.payload.opCode === c.opCode, `${c.id} built the wrong operation`);
  const payloadFields = expand(c.opCode, streamValues(built.payload.bytes));
  const intentSchema = inventoryIntentSchema(c.opCode);
  const keep = new Set(
    [...intentSchema, ...(intentSchema.repeat?.fields ?? []), ...(intentSchema.trailer ? [intentSchema.trailer.countField] : [])].map((s) => s.name),
  );
  if (intentSchema.trailer?.perLine) keep.add(intentSchema.trailer.perLine.name);
  for (const f of intentSchema.trailer?.fields ?? []) keep.add(f.name);
  const intentFields = payloadFields.filter((f) => keep.has(f.name));
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

function buildText(c: { id: string; why: string; text: string }): TextWordVector {
  const bytes = Buffer.from(c.text, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const words = documentTextWords(c.text, c.id, { min: 1, max: 1000 }).map((w) => (w === null ? '' : w.toString(10)));
  const fromHex = Array.from({ length: 8 }, (_, i) => BigInt(`0x${sha256.slice(i * 8, i * 8 + 8)}`).toString(10));
  check(words.join(',') === fromHex.join(','), `text vector ${c.id}: words disagree with the digest`);
  return { id: c.id, why: c.why, text: c.text, utf8Hex: bytes.toString('hex'), sha256, words };
}

export function buildInvplS4Vectors(): InvplS4Vectors {
  const cases = rawCases.map(buildCase);
  const sha = (id: string): string => cases.find((c) => c.id === id)?.intent.sha256 ?? '';
  check(sha('S4-PRC-01') === sha('S4-PRC-03'), 'a receipt intent is purchase, warehouse and revision only');
  return {
    spec: 'invpl/1 for the seven P3-S4 operation kinds (PHASE_3_S4_CONTRACT A-09, A-10(b))',
    note:
      'Generated by packages/inventory/scripts/generate-s4-vectors.ts and verified by packages/inventory/test/purchase-payloads.test.ts ' +
      'and test/supplier-payloads.test.ts. payload is the stream the invctl/1 assertion signs; intent is the stream whose digest a ' +
      'document stores (every field for suppliers, drafts and cancels; purchase_id, warehouse_id and draft_revision for a receipt). ' +
      'Field values are canonical invpl/1 text or JSON null for SQL NULL: _q4 = qty x 10^4; unit_price_c10 = unit price in txn MINOR ' +
      'units x 10^10; *_minor integers; currency the lowercase ISO code; document_date YYYYMMDD; rate_r10 = rate x 10^10; rate_at epoch ' +
      'seconds; <text>_w1..w8 the SHA-256 of the trimmed text as eight uint32 big-endian words (eight NULLs for NULL). routine.args are ' +
      'the entry routine arguments that rebuild the same payload (p_lc_allocations row-major, landed_count x line_count, NULL rows for ' +
      'by_value).',
    texts: textCases.map(buildText),
    cases,
  };
}

export function renderInvplS4Vectors(): Promise<string> {
  return renderJson(buildInvplS4Vectors(), 'invpl-s4-vectors.json');
}

// ── Landed cost and shares (A-13) ────────────────────────────────────────

export interface SplitVector {
  readonly id: string;
  readonly why: string;
  readonly kind: 'by_value' | 'manual';
  readonly amountMinor: string;
  /** by_value: the line nets (weights); manual: the supplied allocations. */
  readonly inputs: readonly string[];
  /** The allocation in line order, or null when refused. */
  readonly allocations: readonly string[] | null;
  readonly outcome: string;
}

export interface PurchaseArithmeticVector {
  readonly id: string;
  readonly why: string;
  readonly txnCurrency: string;
  readonly txnMinorUnits: number;
  readonly baseCurrency: string;
  readonly baseMinorUnits: number;
  /** NUMERIC(20,10) text. */
  readonly rate: string;
  readonly lines: readonly { readonly qty: string; readonly unitPriceTxnMinor: string; readonly discountMinor: string }[];
  readonly landedCosts: readonly { readonly mode: 'by_value' | 'manual'; readonly amountMinor: string; readonly allocations: readonly string[] | null }[];
  readonly expect: {
    readonly lines: readonly {
      readonly grossMinor: string;
      readonly netMinor: string;
      readonly landedMinor: string;
      readonly totalMinor: string;
      readonly baseShareMinor: string;
      readonly unitCostBaseMinor: string;
    }[];
    readonly allocations: readonly (readonly string[])[];
    readonly subtotalMinor: string;
    readonly landedMinor: string;
    readonly totalTxnMinor: string;
    /** A-13 step 6, the 0043 law: HALF_EVEN(T x rate x 10^max(0, eb-et) / 10^max(0, et-eb)). */
    readonly totalBaseMinor: string;
  };
}

export interface RefusedPurchaseVector {
  readonly id: string;
  readonly why: string;
  readonly lines: PurchaseArithmeticVector['lines'];
  readonly landedCosts: PurchaseArithmeticVector['landedCosts'];
  readonly outcome: string;
}

export interface LandedCostVectors {
  readonly version: string;
  readonly note: string;
  readonly splits: readonly SplitVector[];
  readonly purchases: readonly PurchaseArithmeticVector[];
  readonly refusals: readonly RefusedPurchaseVector[];
}

interface RawSplit extends Omit<SplitVector, 'allocations'> {
  /** LITERAL: the allocation, or null when refused. */
  readonly expect: readonly string[] | null;
}

/** LITERAL split expectations; the generator refuses to write a disagreement. */
const splitCases: readonly RawSplit[] = [
  {
    id: 'LC-BYVALUE-TIE',
    why: 'three equal nets: the residue goes to the lowest line_no (line_no tie-break)',
    kind: 'by_value',
    amountMinor: '100',
    inputs: ['500', '500', '500'],
    outcome: 'accepted',
    expect: ['34', '33', '33'],
  },
  {
    id: 'LC-BYVALUE-UNEVEN',
    why: 'uneven nets 333/333/334 over 10: floors 3,3,3 and the residue to the largest remainder (line 3)',
    kind: 'by_value',
    amountMinor: '10',
    inputs: ['333', '333', '334'],
    outcome: 'accepted',
    expect: ['3', '3', '4'],
  },
  {
    id: 'LC-BYVALUE-ZERO-NET',
    why: 'a line with a zero net takes nothing',
    kind: 'by_value',
    amountMinor: '7',
    inputs: ['0', '3', '4'],
    outcome: 'accepted',
    expect: ['0', '3', '4'],
  },
  {
    id: 'LC-BYVALUE-DENOMINATOR-ZERO',
    why: 'every net zero: no equal split, refused',
    kind: 'by_value',
    amountMinor: '100',
    inputs: ['0', '0'],
    outcome: 'purchase.landed_cost_denominator_zero',
    expect: null,
  },
  {
    id: 'LC-MANUAL-EXACT',
    why: 'manual allocations adding up exactly',
    kind: 'manual',
    amountMinor: '250',
    inputs: ['100', '150', '0'],
    outcome: 'accepted',
    expect: ['100', '150', '0'],
  },
  {
    id: 'LC-MANUAL-PLUS-1',
    why: 'manual allocations one minor unit over the amount',
    kind: 'manual',
    amountMinor: '250',
    inputs: ['100', '151', '0'],
    outcome: 'purchase.landed_cost_allocation_mismatch',
    expect: null,
  },
  {
    id: 'LC-MANUAL-MINUS-1',
    why: 'manual allocations one minor unit under the amount',
    kind: 'manual',
    amountMinor: '250',
    inputs: ['100', '149', '0'],
    outcome: 'purchase.landed_cost_allocation_mismatch',
    expect: null,
  },
];

function buildSplit(c: RawSplit): SplitVector {
  const inputs = c.inputs.map(parseMinor);
  const amount = parseMinor(c.amountMinor);
  const run = (): bigint[] => (c.kind === 'by_value' ? allocateByValue(amount, inputs) : validateManual(amount, inputs, inputs.length));
  const got = outcome(run);
  check(got === c.outcome, `split ${c.id}: the package answers ${got}`);
  const allocations = got === 'accepted' ? run().map(formatMinor) : null;
  check(JSON.stringify(allocations) === JSON.stringify(c.expect), `split ${c.id}: the package allocates ${JSON.stringify(allocations)}`);
  return { id: c.id, why: c.why, kind: c.kind, amountMinor: c.amountMinor, inputs: c.inputs, allocations, outcome: c.outcome };
}

/** A-13 step 6 in the generator only: the package leaves the conversion to @daftar/accounting (A-19). */
function convert(totalMinor: bigint, rate: string, et: number, eb: number): bigint {
  const r10 = toC10(rate);
  const up = 10n ** BigInt(Math.max(0, eb - et));
  const down = 10n ** BigInt(Math.max(0, et - eb));
  return roundHalfEven(totalMinor * r10 * up, 10n ** 10n * down);
}

interface RawPurchase {
  readonly id: string;
  readonly why: string;
  readonly txn: [string, number];
  readonly base: [string, number];
  readonly rate: string;
  readonly lines: PurchaseArithmeticVector['lines'];
  readonly landedCosts: PurchaseArithmeticVector['landedCosts'];
  /** LITERAL: [T, B, shares...]. */
  readonly literal: readonly string[];
}

const purchaseCases: readonly RawPurchase[] = [
  {
    id: 'PA-DOMESTIC-01',
    why: 'domestic: 10 x 12.50 = 125.00; B = T; one share',
    txn: ['ILS', 2],
    base: ['ILS', 2],
    rate: '1',
    lines: [{ qty: '10.0000', unitPriceTxnMinor: '1250.0000000000', discountMinor: '0' }],
    landedCosts: [],
    literal: ['12500', '12500', '12500'],
  },
  {
    id: 'PA-USD-ILS-01',
    why: 'three lines (gross 999.9999 -> 1000 and 4997.5 -> 4998 by HALF_EVEN; a line discounted to a zero net), a by_value landed cost of 1001 over nets 1000/4498/0 (182/819/0) and a manual one; T = 6749 cents at 3.6725 = 24785.6525 -> 24786, split by t_i',
    txn: ['USD', 2],
    base: ['ILS', 2],
    rate: '3.6725',
    lines: [
      { qty: '3.0000', unitPriceTxnMinor: '333.3333000000', discountMinor: '0' },
      { qty: '2.5000', unitPriceTxnMinor: '1999.0000000000', discountMinor: '500' },
      { qty: '1.0000', unitPriceTxnMinor: '1000.0000000000', discountMinor: '1000' },
    ],
    landedCosts: [
      { mode: 'by_value', amountMinor: '1001', allocations: null },
      { mode: 'manual', amountMinor: '250', allocations: ['100', '150', '0'] },
    ],
    literal: ['6749', '24786', '4708', '20078', '0'],
  },
  {
    id: 'PA-JOD-ILS-01',
    why: 'a 3-decimal purchase currency into a 2-decimal base: gross 18518.25 -> 18518, landed 7 split 6/1, T = 20522 fils, B = HALF_EVEN(20522 x 5.1 / 10) = 10466',
    txn: ['JOD', 3],
    base: ['ILS', 2],
    rate: '5.1',
    lines: [
      { qty: '1.5000', unitPriceTxnMinor: '12345.5000000000', discountMinor: '3' },
      { qty: '2.0000', unitPriceTxnMinor: '1000.0000000000', discountMinor: '0' },
    ],
    landedCosts: [{ mode: 'by_value', amountMinor: '7', allocations: null }],
    literal: ['20522', '10466', '9446', '1020'],
  },
];

const refusedPurchases: readonly RefusedPurchaseVector[] = [
  {
    id: 'PA-DISCOUNT-ABOVE-GROSS',
    why: 'a discount one minor unit above the line gross',
    lines: [{ qty: '1.0000', unitPriceTxnMinor: '100.0000000000', discountMinor: '101' }],
    landedCosts: [],
    outcome: 'purchase.discount_invalid',
  },
  {
    id: 'PA-TOTAL-ZERO',
    why: 'a free line and no landed cost: T = 0 (TL-8)',
    lines: [{ qty: '5.0000', unitPriceTxnMinor: '0.0000000000', discountMinor: '0' }],
    landedCosts: [],
    outcome: 'purchase.total_zero',
  },
  {
    id: 'PA-DENOMINATOR-ZERO',
    why: 'a by_value landed cost over lines whose nets are all zero',
    lines: [{ qty: '1.0000', unitPriceTxnMinor: '100.0000000000', discountMinor: '100' }],
    landedCosts: [{ mode: 'by_value', amountMinor: '50', allocations: null }],
    outcome: 'purchase.landed_cost_denominator_zero',
  },
];

const toLineInputs = (lines: PurchaseArithmeticVector['lines']): PurchaseLineInput[] =>
  lines.map((l) => ({ qtyQ4: toQ4(l.qty), unitPriceC10: toC10(l.unitPriceTxnMinor), discountMinor: parseMinor(l.discountMinor) }));
const toLandedInputs = (costs: PurchaseArithmeticVector['landedCosts']): LandedCostInput[] =>
  costs.map((c) => ({ mode: c.mode, amountMinor: parseMinor(c.amountMinor), allocations: c.allocations === null ? null : c.allocations.map(parseMinor) }));

function buildPurchase(c: RawPurchase): PurchaseArithmeticVector {
  const totals = lineTotals(toLineInputs(c.lines), toLandedInputs(c.landedCosts));
  const base = convert(totals.totalMinor, c.rate, c.txn[1], c.base[1]);
  const shares = baseShares(
    base,
    totals.lines.map((l) => l.totalMinor),
  );
  check(
    [totals.totalMinor, base, ...shares].map(formatMinor).join(',') === c.literal.join(','),
    `purchase ${c.id}: the package computes ${[totals.totalMinor, base, ...shares].join(',')}`,
  );
  return {
    id: c.id,
    why: c.why,
    txnCurrency: c.txn[0],
    txnMinorUnits: c.txn[1],
    baseCurrency: c.base[0],
    baseMinorUnits: c.base[1],
    rate: formatUnitCost(toC10(c.rate)),
    lines: c.lines,
    landedCosts: c.landedCosts,
    expect: {
      lines: totals.lines.map((l, i) => {
        const share = shares[i] ?? 0n;
        const qty = toQ4(c.lines[i]?.qty ?? '0');
        return {
          grossMinor: formatMinor(l.grossMinor),
          netMinor: formatMinor(l.netMinor),
          landedMinor: formatMinor(l.landedMinor),
          totalMinor: formatMinor(l.totalMinor),
          baseShareMinor: formatMinor(share),
          unitCostBaseMinor: formatUnitCost(unitCostC10(share, qty)),
        };
      }),
      allocations: totals.allocations.map((row) => row.map(formatMinor)),
      subtotalMinor: formatMinor(totals.subtotalMinor),
      landedMinor: formatMinor(totals.landedMinor),
      totalTxnMinor: formatMinor(totals.totalMinor),
      totalBaseMinor: formatMinor(base),
    },
  };
}

function buildRefusedPurchase(c: RefusedPurchaseVector): RefusedPurchaseVector {
  const got = outcome(() => lineTotals(toLineInputs(c.lines), toLandedInputs(c.landedCosts)));
  check(got === c.outcome, `refused purchase ${c.id}: the package answers ${got}`);
  return c;
}

export function buildLandedCostVectors(): LandedCostVectors {
  return {
    version: 'invlanded/1',
    note:
      'Generated by packages/inventory/scripts/generate-s4-vectors.ts and verified by packages/inventory/test/landed-cost.test.ts and ' +
      'test/purchase-shares.test.ts (PHASE_3_S4_CONTRACT A-13). splits: allocateByValue(amount, nets) = inventory_largest_remainder over ' +
      'the nets (tie to the lower line_no), and validateManual. purchases: gross = HALF_EVEN(qty x unit price in txn minor units), ' +
      'net = gross - discount, landed allocations per cost, t_i = net + landed, T = sum t_i (tax 0), B = the 0043 conversion of T, ' +
      'base shares = LR(B; t_i), unit cost = HALF_EVEN(share / qty, 10). Every expected value was computed by the package and held to ' +
      'a literal in the generator.',
    splits: splitCases.map(buildSplit),
    purchases: purchaseCases.map(buildPurchase),
    refusals: refusedPurchases.map(buildRefusedPurchase),
  };
}

export function renderLandedCostVectors(): Promise<string> {
  return renderJson(buildLandedCostVectors(), 'landed-cost-vectors.json');
}

// ── Coverage (A-16) ──────────────────────────────────────────────────────

export interface CoverageStateVector {
  readonly onHand: string;
  readonly valuation: string;
  readonly avg: string | null;
}

export interface CoverageLayerVector {
  readonly deficitId: string;
  readonly deficitSeq: string;
  readonly uncovered: string;
  readonly provisional: string;
}

export interface CoverageReceiptVector {
  readonly adjustmentId: string;
  readonly lines: readonly { readonly lineId: string; readonly variantId: string; readonly qty: string; readonly baseShareMinor: string }[];
  readonly expect: {
    readonly lines: readonly {
      readonly lineId: string;
      readonly actual: string;
      readonly covered: string;
      readonly catchUpMinor: string;
      readonly coverages: readonly {
        readonly deficitId: string;
        readonly qtyCovered: string;
        readonly provisional: string;
        readonly actual: string;
        readonly formulaMinor: string;
        readonly valueMinor: string;
        readonly flush: boolean;
        readonly movement: boolean;
        readonly uncoveredAfter: string;
        readonly statusAfter: string;
      }[];
      readonly stateAfter: CoverageStateVector;
    }[];
    readonly covered: string;
    /** N: the catch-up entry posts iff non-zero. */
    readonly totalValueBaseMinor: string;
    readonly header: boolean;
    readonly catchUpEntry: boolean;
  };
}

export interface CoverageCaseVector {
  readonly id: string;
  readonly why: string;
  /** The key states and open layers, as the owner seeds them (L:470), per variant. */
  readonly seed: readonly { readonly variantId: string; readonly state: CoverageStateVector; readonly layers: readonly CoverageLayerVector[] }[];
  /** One or more receipts in order; each starts from the stored result of the previous one. */
  readonly receipts: readonly CoverageReceiptVector[];
}

export interface CoverageVectors {
  readonly version: string;
  readonly note: string;
  readonly cases: readonly CoverageCaseVector[];
}

interface SeedKey {
  readonly variantId: string;
  readonly onHand: string;
  readonly valuation: string;
  readonly layers: readonly { readonly deficitId: string; readonly uncovered: string; readonly provisional: string }[];
}

interface RawCoverage {
  readonly id: string;
  readonly why: string;
  readonly seed: readonly SeedKey[];
  readonly receipts: readonly {
    readonly lines: readonly { readonly lineId: string; readonly variantId: string; readonly qty: string; readonly share: string }[];
    /** LITERAL: the stored coverage values in movement order, then N. */
    readonly values: readonly string[];
    readonly n: string;
  }[];
}

const coverageCases: readonly RawCoverage[] = [
  {
    id: 'GOLD54',
    why: 'GOLD-54 (valuation-vectors AL08-CATCHUP-GOLD54): 5 short at 100, a receipt of 10 at 120 covers 5: -100',
    seed: [{ variantId: V1, onHand: '-5.0000', valuation: '-500', layers: [{ deficitId: D1, uncovered: '5.0000', provisional: '100.0000000000' }] }],
    receipts: [{ lines: [{ lineId: L1, variantId: V1, qty: '10.0000', share: '1200' }], values: ['-100'], n: '-100' }],
  },
  {
    id: 'GOLD55',
    why: 'GOLD-55 (AL08-CATCHUP-GOLD55): 5 short at a provisional 0, a receipt of 10 at 120 covers 5: -600',
    seed: [{ variantId: V1, onHand: '-5.0000', valuation: '0', layers: [{ deficitId: D1, uncovered: '5.0000', provisional: '0.0000000000' }] }],
    receipts: [{ lines: [{ lineId: L1, variantId: V1, qty: '10.0000', share: '1200' }], values: ['-600'], n: '-600' }],
  },
  {
    id: 'GOLD72',
    why: 'GOLD-72 (AL08-CATCHUP-GOLD72): 10 short at 100; 4 at 120 (-80), then 6 at 130 closes the layer exactly — the flush equals the formula, -180',
    seed: [{ variantId: V1, onHand: '-10.0000', valuation: '-1000', layers: [{ deficitId: D1, uncovered: '10.0000', provisional: '100.0000000000' }] }],
    receipts: [
      { lines: [{ lineId: L1, variantId: V1, qty: '4.0000', share: '480' }], values: ['-80'], n: '-80' },
      { lines: [{ lineId: L1, variantId: V1, qty: '6.0000', share: '780' }], values: ['-180'], n: '-180' },
    ],
  },
  {
    id: 'THREE-LAYERS',
    why: 'one line over three layers (2 @ 100, 3 @ 110, 1 @ 90) at 120: three coverages, three movements, one entry of their sum',
    seed: [
      {
        variantId: V1,
        onHand: '-6.0000',
        valuation: '-620',
        layers: [
          { deficitId: D1, uncovered: '2.0000', provisional: '100.0000000000' },
          { deficitId: D2, uncovered: '3.0000', provisional: '110.0000000000' },
          { deficitId: D3, uncovered: '1.0000', provisional: '90.0000000000' },
        ],
      },
    ],
    receipts: [{ lines: [{ lineId: L1, variantId: V1, qty: '8.0000', share: '960' }], values: ['-40', '-30', '-30'], n: '-100' }],
  },
  {
    id: 'ZERO-CATCHUP',
    why: 'actual = provisional (TL-5): the coverage row is written, its value is 0, no movement, N = 0 and no entry',
    seed: [{ variantId: V1, onHand: '-3.0000', valuation: '-360', layers: [{ deficitId: D1, uncovered: '3.0000', provisional: '120.0000000000' }] }],
    receipts: [{ lines: [{ lineId: L1, variantId: V1, qty: '5.0000', share: '600' }], values: ['0'], n: '0' }],
  },
  {
    id: 'FLUSH-RESIDUE',
    why: 'the A-16(e) worked case: layers 1 @ 10.5 and 1 @ 10.5 stored at 10 each; a receipt of 2 for 30 closes both: formula -4, -4, the flush makes the last -6 so the valuation is 0',
    seed: [
      {
        variantId: V1,
        onHand: '-2.0000',
        valuation: '-20',
        layers: [
          { deficitId: D1, uncovered: '1.0000', provisional: '10.5000000000' },
          { deficitId: D2, uncovered: '1.0000', provisional: '10.5000000000' },
        ],
      },
    ],
    receipts: [{ lines: [{ lineId: L1, variantId: V1, qty: '2.0000', share: '30' }], values: ['-4', '-6'], n: '-10' }],
  },
  {
    id: 'MIXED-N0',
    why: 'two lines whose catch-ups have opposite signs and net to N = 0: the header and its coverages are written, no entry is posted',
    seed: [
      { variantId: V1, onHand: '-2.0000', valuation: '-200', layers: [{ deficitId: D1, uncovered: '2.0000', provisional: '100.0000000000' }] },
      { variantId: V2, onHand: '-2.0000', valuation: '-240', layers: [{ deficitId: D2, uncovered: '2.0000', provisional: '120.0000000000' }] },
    ],
    receipts: [
      {
        lines: [
          { lineId: L1, variantId: V1, qty: '3.0000', share: '330' },
          { lineId: L2, variantId: V2, qty: '3.0000', share: '330' },
        ],
        values: ['-20', '20'],
        n: '0',
      },
    ],
  },
];

const stateVector = (s: StockState): CoverageStateVector => ({
  onHand: formatQuantity(s.onHand),
  valuation: formatMinor(s.valuation),
  avg: s.avg === null ? null : formatUnitCost(s.avg),
});

function seedState(k: SeedKey): StockState {
  // The seeded key as the owner writes it: on-hand, valuation and the average they derive.
  const onHand = toQ4(k.onHand);
  const valuation = parseMinor(k.valuation);
  const avg = onHand === 0n ? null : roundHalfEven(valuation * 10n ** 14n, onHand);
  return { ...EMPTY_STOCK_STATE, onHand, valuation, avg, lastStockSeq: 1n };
}

function buildCoverage(c: RawCoverage): CoverageCaseVector {
  const states = new Map<string, StockState>(c.seed.map((k) => [k.variantId, seedState(k)]));
  let layers: DeficitLayer[] = c.seed.flatMap((k) =>
    k.layers.map((l, i) => ({
      deficitId: l.deficitId,
      variantId: k.variantId,
      deficitSeq: BigInt(i + 1),
      uncoveredQ4: toQ4(l.uncovered),
      provisionalC10: toC10(l.provisional),
    })),
  );
  const seed = c.seed.map((k) => ({
    variantId: k.variantId,
    state: stateVector(states.get(k.variantId) ?? EMPTY_STOCK_STATE),
    layers: layers
      .filter((l) => l.variantId === k.variantId)
      .map((l) => ({
        deficitId: l.deficitId,
        deficitSeq: l.deficitSeq.toString(10),
        uncovered: formatQuantity(l.uncoveredQ4),
        provisional: formatUnitCost(l.provisionalC10),
      })),
  }));
  const receipts = c.receipts.map((r, n): CoverageReceiptVector => {
    const plan: CoveragePlan = planCoverage(
      layers,
      states,
      r.lines.map((l) => ({ lineId: l.lineId, variantId: l.variantId, qtyQ4: toQ4(l.qty), baseShareMinor: parseMinor(l.share) })),
    );
    const values = plan.lines.flatMap((l) => l.coverages.map((x) => formatMinor(x.valueMinor)));
    check(values.join(',') === r.values.join(','), `coverage ${c.id} receipt ${n + 1}: the package computes ${values.join(',')}`);
    check(formatMinor(plan.totalValueMinor) === r.n, `coverage ${c.id} receipt ${n + 1}: N is ${plan.totalValueMinor}`);
    // The stored result of this receipt is the next one's starting point.
    for (const l of plan.lines) states.set(l.variantId, l.stateAfter);
    const after = new Map(plan.lines.flatMap((l) => l.coverages.map((x) => [x.deficitId, x.uncoveredAfterQ4] as const)));
    layers = layers.map((l) => ({ ...l, uncoveredQ4: after.get(l.deficitId) ?? l.uncoveredQ4 })).filter((l) => l.uncoveredQ4 > 0n);
    return {
      adjustmentId: ADJ,
      lines: r.lines.map((l) => ({ lineId: l.lineId, variantId: l.variantId, qty: l.qty, baseShareMinor: l.share })),
      expect: {
        lines: plan.lines.map((l) => ({
          lineId: l.lineId,
          actual: formatUnitCost(l.actualC10),
          covered: formatQuantity(l.coveredQ4),
          catchUpMinor: formatMinor(l.catchUpMinor),
          coverages: l.coverages.map((x) => ({
            deficitId: x.deficitId,
            qtyCovered: formatQuantity(x.qtyCoveredQ4),
            provisional: formatUnitCost(x.provisionalC10),
            actual: formatUnitCost(x.actualC10),
            formulaMinor: formatMinor(x.formulaMinor),
            valueMinor: formatMinor(x.valueMinor),
            flush: x.flush,
            movement: x.movement,
            uncoveredAfter: formatQuantity(x.uncoveredAfterQ4),
            statusAfter: x.statusAfter,
          })),
          stateAfter: stateVector(l.stateAfter),
        })),
        covered: formatQuantity(plan.coveredQ4),
        totalValueBaseMinor: formatMinor(plan.totalValueMinor),
        header: plan.coveredQ4 > 0n,
        catchUpEntry: plan.totalValueMinor !== 0n,
      },
    };
  });
  return { id: c.id, why: c.why, seed, receipts };
}

export function buildCoverageVectors(): CoverageVectors {
  const cases = coverageCases.map(buildCoverage);
  // The contract's own statements about these cases, held here as well.
  const gold72 = cases.find((c) => c.id === 'GOLD72');
  check(gold72?.receipts[1]?.expect.lines[0]?.stateAfter.valuation === '0', 'GOLD-72 ends at zero stock with zero value');
  check(gold72?.receipts[1]?.expect.lines[0]?.coverages[0]?.flush === true, "GOLD-72's second receipt is the flush-eligible one");
  const flush = cases.find((c) => c.id === 'FLUSH-RESIDUE')?.receipts[0]?.expect.lines[0]?.coverages.map((x) => x.formulaMinor);
  check(JSON.stringify(flush) === JSON.stringify(['-4', '-4']), 'the flush-residue formula is -4, -4');
  const zero = cases.find((c) => c.id === 'ZERO-CATCHUP')?.receipts[0]?.expect;
  check(
    zero?.header === true && zero.catchUpEntry === false && zero.lines[0]?.coverages[0]?.movement === false,
    'a zero catch-up writes a row, no movement, no entry',
  );
  return {
    version: 'invcover/1',
    note:
      'Generated by packages/inventory/scripts/generate-s4-vectors.ts and verified by packages/inventory/test/deficit-coverage.test.ts ' +
      '(PHASE_3_S4_CONTRACT A-16). seed: the key state and open layers the owner seeds (L:470), deficitSeq in FIFO order. Per receipt ' +
      'line: the purchase movement (qty at baseShareMinor) first, then its coverages FIFO: value = -HALF_EVEN(qtyCovered x (actual - ' +
      'provisional), 0) (formulaMinor), except the last coverage of a line that closes every open layer exactly, whose value is -valuation ' +
      'of the key before it (flush). movement is false for a zero value (TL-5). N = the sum of the stored values; the header is written ' +
      'iff anything is covered, the catch-up entry iff N <> 0. A later receipt of a case starts from the state the previous one stored.',
    cases,
  };
}

export function renderCoverageVectors(): Promise<string> {
  return renderJson(buildCoverageVectors(), 'coverage-vectors.json');
}
